import { now, terminal, updateJob, readJob } from "./state.mjs";
import { scrubStoredJob } from "./task-envelope.mjs";
import { appendLifecycleEvent } from "./task-lifecycle.mjs";
import { redactText } from "./redact.mjs";

function isBoundWorkerOrProvider(job) {
  return Boolean(job?.workerProcess?.pid || job?.providerProcess?.pid);
}

/**
 * Terminalize a failed review/research-style launch only when the detached
 * worker never bound. Authorization is revoked under the job lock before any
 * home cleanup so a provisional worker cannot bind and lose its credentials.
 * If a worker or provider identity is already recorded, leave the job for
 * recoverActiveJobs.
 *
 * @param {object} options
 * @param {string} options.root
 * @param {string} options.jobId
 * @param {string} [options.diagnostic]
 * @param {(() => {ok: boolean, warning?: string}|null)|null} [options.cleanupReviewHome]
 *        Called only after a locked unbound decision revokes launch auth.
 * @param {((job: object) => void)|null} [options.onAfterUnboundDecision]
 *        Test hook after auth revoke, before home cleanup.
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {{ terminalized: boolean, cleanup: {ok: boolean, warning?: string}|null }}
 */
export function terminalizeCleanLaunchFailure({
  root,
  jobId,
  diagnostic,
  cleanupReviewHome = null,
  onAfterUnboundDecision = null,
  env = process.env
}) {
  // Phase 1: under lock, recheck identity and revoke launch capability before
  // any filesystem cleanup. Provisional bind requires current authorization.
  let unboundForCleanup = false;
  updateJob(root, jobId, (current) => {
    if (terminal(current) || isBoundWorkerOrProvider(current)) {
      unboundForCleanup = false;
      return current;
    }
    current.workerAuthorization = null;
    unboundForCleanup = true;
    return current;
  }, env);

  if (!unboundForCleanup) {
    return { terminalized: false, cleanup: null };
  }

  const afterRevoke = readJob(root, jobId, env);
  if (typeof onAfterUnboundDecision === "function") {
    onAfterUnboundDecision(afterRevoke);
  }

  // Phase 2: auth is revoked and no PID was present under the lock. Cleanup is
  // safe against authorized provisional bind. Re-read before terminalize.
  const cleanup = typeof cleanupReviewHome === "function"
    ? cleanupReviewHome()
    : null;

  // Phase 3: publish terminal failure only if still unbound.
  let terminalized = false;
  updateJob(root, jobId, (current) => {
    if (terminal(current) || isBoundWorkerOrProvider(current)) {
      terminalized = false;
      return current;
    }
    Object.assign(current, scrubStoredJob(current));
    current.workerAuthorization = null;
    current.status = "failed";
    current.phase = "failed";
    current.completedAt = now();
    current.error = {
      code: "E_WORKER_LOST",
      message: redactText(diagnostic)
        || "Could not launch the isolated Grok worker."
    };
    current.summary = current.error.message;
    current.result = {
      ...(current.result || {}),
      hostVerification: "not_run"
    };
    current.lifecycleEvents = appendLifecycleEvent(
      current.lifecycleEvents,
      "blocked",
      current.error.message
    );
    if (cleanup) {
      current.result = {
        ...(current.result || {}),
        providerSessionDeleted: cleanup.ok
      };
      if (cleanup.warning) {
        current.result.privacyWarning = cleanup.warning;
      }
    }
    terminalized = true;
    return current;
  }, env);

  return { terminalized, cleanup };
}
