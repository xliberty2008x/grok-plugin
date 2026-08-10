import { CompanionError } from "./errors.mjs";
import { processStartToken } from "./process-control.mjs";
import { terminal } from "./state.mjs";
import {
  recordReviewPreProviderFailure,
  selfReviewWorkerAuthorization,
  tryBindProvisionalReviewWorker
} from "./review-preprovider-failure.mjs";

/**
 * Legacy non-broker review `--worker` path: authorize (strict or provisional),
 * then execute. Unauthenticated callers never write durable job state.
 */
export async function runLegacyReviewWorker({
  root,
  id,
  nonce,
  readJob,
  execute
}) {
  let authorized = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const record = readJob(root, id);
    if (terminal(record)) return;
    if (record.jobClass !== "review") {
      throw new CompanionError("E_USAGE", "Legacy review worker requires a review job.");
    }
    const identity = record.workerProcess;
    const startToken = processStartToken(process.pid);
    if (
      nonce
      && identity?.nonce === nonce
      && identity?.pid === process.pid
      && identity?.startToken === startToken
      && identity?.startToken
      && (process.platform === "win32"
        ? identity?.processGroupId === null
        : identity?.processGroupId === process.pid)
      && identity?.commandMarker === id
    ) {
      authorized = true;
      break;
    }
    if (
      nonce
      && !identity?.pid
      && record.workerAuthorization === nonce
      && tryBindProvisionalReviewWorker({ root, jobId: id, nonce })
    ) {
      authorized = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!authorized) {
    throw new CompanionError(
      "E_RECURSION",
      "Unauthenticated Grok Companion worker invocation refused."
    );
  }
  try {
    await execute(root, id, { dispatchAttemptId: null, dispatchFence: null });
  } catch (error) {
    try {
      const record = readJob(root, id);
      // Persist only while no provider process has been recorded. Do not use
      // worker startedAt — execute sets that before provider launch.
      if (
        record.jobClass === "review"
        && !terminal(record)
        && !record.providerProcess
      ) {
        recordReviewPreProviderFailure({
          root,
          jobId: id,
          error,
          authorization: selfReviewWorkerAuthorization(id, nonce)
        });
      }
    } catch { /* best-effort */ }
    throw error;
  }
}
