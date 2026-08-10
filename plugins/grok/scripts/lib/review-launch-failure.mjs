import { now, terminal, updateJob } from "./state.mjs";
import { scrubStoredJob } from "./task-envelope.mjs";
import { appendLifecycleEvent } from "./task-lifecycle.mjs";
import { redactText } from "./redact.mjs";

/**
 * Terminalize a failed review/research-style launch only when the detached
 * worker never bound. If provisional auth already recorded a worker or
 * provider identity, leave the job for recoverActiveJobs.
 */
export function terminalizeCleanLaunchFailure({
  root,
  jobId,
  jobClass,
  diagnostic,
  cleanup = null
}) {
  updateJob(root, jobId, (current) => {
    if (terminal(current) || current.workerProcess?.pid || current.providerProcess?.pid) {
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
    return current;
  });
}
