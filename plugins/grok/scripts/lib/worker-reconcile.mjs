/**
 * Privileged reconciler — separately trusted from model-callable broker requests.
 * May clean verified owned processes or mark jobs lost.
 * MUST NEVER replay prompts or re-dispatch provider work.
 */
import { CompanionError } from "./errors.mjs";
import { sameHostSession } from "./host.mjs";
import { listJobs, now, terminal, updateJob } from "./state.mjs";
import { appendLifecycleEvent, scrubStoredJob } from "./task-contract.mjs";
import { isSupportedWorkerDispatch } from "./worker-launch-contract.mjs";

export const RECONCILER_PRIVILEGE = "host-trusted-reconciler";
export const WORKER_DISPATCH_STARTUP_GRACE_MS = 5_000;

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
 * @param {(job: object) => boolean} [options.processAlive] legacy non-dispatch jobs only
 * @param {(job: object) => {ok: boolean, warning?: string}} [options.cleanupProcess] legacy non-dispatch jobs only
 */
export function reconcileOwnedWorkers({
  root,
  principal,
  trusted = false,
  processAlive = () => false,
  cleanupProcess = null,
  clock = () => Date.now(),
  dispatchStartupGraceMs = WORKER_DISPATCH_STARTUP_GRACE_MS,
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
  if (!Number.isFinite(dispatchStartupGraceMs) || dispatchStartupGraceMs < 0) {
    throw new CompanionError("E_USAGE", "Worker dispatch startup grace must be a non-negative duration.");
  }

  const host = { kind: "codex", sessionId: principal.threadId };
  const jobs = listJobs(root, env).filter((job) => sameHostSession(job, host));
  const results = [];

  for (const job of jobs) {
    if (terminal(job)) {
      results.push({ workerId: job.id, action: "none", reason: "terminal" });
      continue;
    }

    const dispatch = job.request?.spawn?.dispatch;
    if (isSupportedWorkerDispatch(dispatch)) {
      // An unclaimed durable commit is intentionally recoverable by an
      // authority-bound launch drain (spawn response or worker_wait).
      // Reconciliation never claims it because generic cleanup must not start
      // provider work or replay a prompt.
      if (dispatch.state === "pending" && !dispatch.attemptId) {
        results.push({
          workerId: job.id,
          action: "none",
          reason: "dispatch-pending-recoverable",
          replayedPrompt: false
        });
        continue;
      }

      // Worker Dispatch v1 has an exact, attempt-bound recovery state machine
      // in worker-recovery.mjs. This legacy reconciler must not make liveness
      // decisions through caller-supplied callbacks, perform best-effort
      // cleanup, or publish terminal state for those jobs. The authoritative
      // broker recovery path owns every non-pending dispatch state.
      results.push({
        workerId: job.id,
        action: "none",
        reason: "authoritative-broker-recovery-required",
        replayedPrompt: false
      });
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
    updateJob(root, job.id, (current) => {
      if (terminal(current)) {
        decision = { action: "none", reason: "terminal" };
        return scrubStoredJob(current);
      }
      // Fail closed if a legacy snapshot was upgraded or replaced before the
      // job lock was acquired. Dispatch recovery must remain solely owned by
      // the exact-identity broker state machine even across this race window.
      if (isSupportedWorkerDispatch(current.request?.spawn?.dispatch)) {
        decision = { action: "none", reason: "authoritative-broker-recovery-required" };
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
      const existingIntent = current.pendingTerminal;
      if (existingIntent != null && (
        typeof existingIntent !== "object"
        || Array.isArray(existingIntent)
        || !["completed", "failed", "cancelled"].includes(existingIntent.status)
        || typeof existingIntent.phase !== "string"
        || !existingIntent.phase
        || typeof existingIntent.completedAt !== "string"
        || !existingIntent.completedAt
        || (existingIntent.error !== null && (
          typeof existingIntent.error !== "object"
          || Array.isArray(existingIntent.error)
        ))
        || (existingIntent.summary !== null && typeof existingIntent.summary !== "string")
      )) {
        throw new CompanionError("E_STATE", "Pending legacy terminal intent is malformed.");
      }
      const observedAt = now();
      const intendedTerminal = existingIntent || {
        status: "failed",
        phase: "lost",
        completedAt: observedAt,
        error: {
          code: "E_PROVIDER_EXIT",
          message: "Worker process was not found during reconciliation."
        },
        summary: "Lost"
      };

      let cleanupProven = false;
      try {
        const cleanup = typeof cleanupProcess === "function"
          ? cleanupProcess(current)
          : null;
        cleanupProven = Boolean(
          cleanup
          && typeof cleanup === "object"
          && !Array.isArray(cleanup)
          && cleanup.ok === true
        );
      } catch {
        cleanupProven = false;
      }

      if (!cleanupProven) {
        decision = { action: "cleanup-blocked", reason: "cleanup-unverified" };
        const blockedResult = {
          ...(current.result || {}),
          hostVerification: current.result?.hostVerification || "not_run",
          ...(current.jobClass === "task" ? { taskRuntimeCleaned: false } : {}),
          privacyWarning: "Legacy worker cleanup could not be verified."
        };
        const blocked = {
          ...current,
          status: "running",
          phase: "cleanup-blocked",
          completedAt: null,
          pendingTerminal: intendedTerminal,
          summary: "Worker cleanup is incomplete.",
          progress: "Process was not found; exact cleanup proof is still pending.",
          error: {
            code: "E_RUNTIME_CLEANUP",
            message: "Worker cleanup could not be verified."
          },
          result: blockedResult,
          lifecycleEvents: appendLifecycleEvent(
            current.lifecycleEvents || [],
            "blocked",
            "Reconciler retained terminal intent because cleanup is unverified.",
            { reconciler: RECONCILER_PRIVILEGE, replayedPrompt: false }
          )
        };
        return scrubStoredJob(blocked);
      }

      decision = { action: "marked-lost", reason: "process-not-alive" };
      const terminalResult = {
        ...(current.result || {}),
        hostVerification: current.result?.hostVerification || "not_run",
        ...(!existingIntent ? { stopReason: "reconciler-lost" } : {}),
        ...(current.jobClass === "task" ? { taskRuntimeCleaned: true } : {}),
        runtimeEvidence: {
          ...(current.result?.runtimeEvidence || {}),
          reconciler: {
            privilege: RECONCILER_PRIVILEGE,
            replayedPrompt: false,
            at: observedAt
          }
        }
      };
      delete terminalResult.privacyWarning;
      const terminalized = {
        ...current,
        status: intendedTerminal.status,
        phase: intendedTerminal.phase,
        summary: intendedTerminal.summary || intendedTerminal.error?.message || "Lost",
        progress: "Process not found; cleanup verified and terminal intent published.",
        completedAt: intendedTerminal.completedAt,
        lifecycleEvents: appendLifecycleEvent(
          current.lifecycleEvents || [],
          "checkpoint",
          "Reconciler verified cleanup and published terminal intent without prompt replay.",
          { reconciler: RECONCILER_PRIVILEGE, replayedPrompt: false }
        ),
        error: intendedTerminal.error || null,
        result: terminalResult
      };
      delete terminalized.pendingTerminal;
      return scrubStoredJob(terminalized);
    }, env);
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
