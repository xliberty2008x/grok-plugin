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

export function providerLaunchUnsettled(job) {
  const spawn = job?.request?.spawn;
  return Boolean(spawn && (
    spawn.providerLaunchPending === true
    || spawn.providerLaunchInFlight === true
    || spawn.providerLaunchOutcome === "unknown"
  ));
}

/**
 * Whether process/runtime cleanup must wait for a durable provider-launch
 * settlement. Authorization is published before process identity, so an
 * authorization-only record is still launch-capable unless the launcher has
 * durably committed the explicit `not-launched` outcome.
 */
export function providerLaunchCleanupBlocked(job) {
  if (providerLaunchUnsettled(job)) return true;
  const hasAuthorization = job?.workerAuthorization !== null
    && job?.workerAuthorization !== undefined;
  const hasRecordedProcess = Boolean(
    job?.workerProcess?.pid || job?.providerProcess?.pid
  );
  return hasAuthorization
    && !hasRecordedProcess
    && job?.request?.spawn?.providerLaunchOutcome !== "not-launched";
}

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

    // This privileged reconciler has an explicit processAlive observer. Once
    // the launch flags are durably settled it may verify a launched process (or
    // its loss) even if the job identity publication was incomplete. Raw
    // cleanup paths without that observer must use providerLaunchCleanupBlocked.
    if (providerLaunchUnsettled(job)) {
      results.push({ workerId: job.id, action: "none", reason: "provider-launch-unsettled" });
      continue;
    }

    let decision = { action: "none", reason: "process-alive" };
    let lostSnapshot = null;
    updateJob(root, job.id, (current) => {
      if (terminal(current)) {
        decision = { action: "none", reason: "terminal" };
        return current;
      }
      // Re-evaluate the durable launch state under the job lock. A provider may
      // have entered its commit-to-launch window after the outer list snapshot;
      // absence of a process before that window settles is not proof of loss.
      if (providerLaunchUnsettled(current)) {
        decision = { action: "none", reason: "provider-launch-unsettled" };
        return current;
      }
      if (processAlive(current)) {
        decision = { action: "none", reason: "process-alive" };
        return current;
      }
      decision = { action: "marked-lost", reason: "process-not-alive" };
      lostSnapshot = current;
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
    if (decision.action === "marked-lost" && typeof cleanupProcess === "function") {
      try {
        cleanupProcess(lostSnapshot);
      } catch {
        /* cleanup is best-effort */
      }
    }
    results.push({
      workerId: job.id,
      action: decision.action,
      reason: decision.reason,
      replayedPrompt: false
    });
  }

  return Object.freeze({
    privilege: RECONCILER_PRIVILEGE,
    replayedPrompt: false,
    results
  });
}
