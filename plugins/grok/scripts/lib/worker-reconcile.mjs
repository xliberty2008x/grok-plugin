/**
 * Privileged reconciler — separately trusted from model-callable broker requests.
 * May clean verified owned processes or mark jobs lost.
 * MUST NEVER replay prompts or re-dispatch provider work.
 */
import { CompanionError } from "./errors.mjs";
import { sameHostSession } from "./host.mjs";
import { listJobs, now, terminal, updateJob } from "./state.mjs";
import { appendLifecycleEvent } from "./task-contract.mjs";

export const RECONCILER_PRIVILEGE = "host-trusted-reconciler";

/**
 * @param {object} options
 * @param {string} options.root
 * @param {object} options.principal trusted host principal
 * @param {boolean} options.trusted must be true; model tools cannot set this
 * @param {(job: object) => boolean} [options.processAlive]
 * @param {(job: object) => void} [options.cleanupProcess] kill verified owned process only
 */
export function reconcileOwnedWorkers({
  root,
  principal,
  trusted = false,
  processAlive = () => false,
  cleanupProcess = null,
  // Explicitly rejected — present only so callers/tests can prove non-replay.
  replayPrompt = null,
  env = process.env
} = {}) {
  if (trusted !== true) {
    throw new CompanionError(
      "E_AUTH_REQUIRED",
      "Reconciliation requires a separately trusted host principal."
    );
  }
  if (typeof replayPrompt === "function") {
    throw new CompanionError(
      "E_POLICY",
      "Reconciler must never replay prompts."
    );
  }
  if (!principal?.threadId) {
    throw new CompanionError("E_AUTH_REQUIRED", "Trusted task identity is unavailable.");
  }

  const host = { kind: "codex", sessionId: principal.threadId };
  const jobs = listJobs(root, env).filter((job) => sameHostSession(job, host));
  const results = [];

  for (const job of jobs) {
    if (terminal(job)) {
      results.push({ workerId: job.id, action: "none", reason: "terminal" });
      continue;
    }

    const alive = processAlive(job);
    if (alive) {
      results.push({ workerId: job.id, action: "none", reason: "process-alive" });
      continue;
    }

    // Process not alive: mark lost; never relaunch.
    if (typeof cleanupProcess === "function") {
      try {
        cleanupProcess(job);
      } catch {
        /* cleanup is best-effort */
      }
    }

    updateJob(root, job.id, (current) => {
      if (terminal(current)) return current;
      const events = appendLifecycleEvent(
        current.lifecycleEvents || [],
        "checkpoint",
        "Reconciler marked worker lost without prompt replay.",
        { reconciler: RECONCILER_PRIVILEGE, replayedPrompt: false }
      );
      return {
        ...current,
        status: "failed",
        phase: "lost",
        summary: "Lost",
        progress: "Process not found; marked lost by trusted reconciler.",
        completedAt: now(),
        lifecycleEvents: events,
        error: {
          code: "E_PROVIDER_EXIT",
          message: "Worker process was not found during reconciliation."
        },
        result: {
          ...(current.result || {}),
          hostVerification: current.result?.hostVerification || "not_run",
          stopReason: "reconciler-lost",
          runtimeEvidence: {
            ...(current.result?.runtimeEvidence || {}),
            reconciler: {
              privilege: RECONCILER_PRIVILEGE,
              replayedPrompt: false,
              at: now()
            }
          }
        }
      };
    }, env);
    results.push({
      workerId: job.id,
      action: "marked-lost",
      reason: "process-not-alive",
      replayedPrompt: false
    });
  }

  return Object.freeze({
    privilege: RECONCILER_PRIVILEGE,
    replayedPrompt: false,
    results
  });
}
