import { asErrorPayload } from "./errors.mjs";
import { redact, redactText, sanitizeDisplayText } from "./redact.mjs";
import { appendLifecycleEvent } from "./task-lifecycle.mjs";
import { updateJob, terminal, now } from "./state.mjs";
import { scrubStoredJob } from "./task-envelope.mjs";
import { processStartToken } from "./process-control.mjs";

const MAX_MESSAGE_CHARS = 1024;
const AUTH_NEXT =
  "Check job status for this review ID; do not expect automatic replay — re-run the review command if needed.";
const GENERIC_NEXT =
  "Inspect this job's status/result, then re-run the review if the failure persists.";
const MID_RUN_NEXT =
  "Inspect job status/result; do not expect automatic replay (prompts are not re-run).";
const ORPHAN_NEXT =
  "Inspect this job's status/result, then re-run the review if the failure persists.";

function clipMessage(text) {
  const cleaned = sanitizeDisplayText(redactText(String(text || "")));
  if (cleaned.length <= MAX_MESSAGE_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_MESSAGE_CHARS - 1)}…`;
}

function withNextAction(cause, nextAction) {
  const base = clipMessage(cause).replace(/\s+/g, " ").trim();
  const next = clipMessage(nextAction).replace(/\s+/g, " ").trim();
  if (!base) return next;
  if (base.includes(next)) return base;
  const joined = `${base}${/[.!?]$/.test(base) ? "" : "."} ${next}`;
  return clipMessage(joined);
}

export function buildReviewPreProviderError(error) {
  const rawCode = typeof error?.code === "string" && error.code.startsWith("E_")
    ? error.code
    : "E_PROVIDER_EXIT";
  const rawMessage = typeof error?.message === "string" && error.message.trim()
    ? error.message
    : "Review worker failed before provider start";
  let cause = rawMessage;
  if (
    rawCode === "E_RECURSION"
    || /unauthenticated|stale.*worker|worker invocation refused/i.test(rawMessage)
  ) {
    cause = "Worker could not authenticate before execution";
  }
  const message = withNextAction(cause, AUTH_NEXT);
  const payload = redact(asErrorPayload({ code: rawCode, message }));
  return {
    code: payload.code || rawCode,
    message: clipMessage(payload.message || message)
  };
}

export function reviewLostWorkerError(jobLike = {}, { unbound = false } = {}) {
  if (unbound) {
    return {
      code: "E_WORKER_LOST",
      message: withNextAction(
        "Review launch never bound a worker process; the prompt was not replayed",
        ORPHAN_NEXT
      )
    };
  }
  const preProvider = jobLike.startedAt == null && !jobLike.providerProcess;
  if (preProvider) {
    return {
      code: "E_WORKER_LOST",
      message: withNextAction(
        "The background worker disappeared before provider start; the prompt was not replayed",
        GENERIC_NEXT
      )
    };
  }
  return {
    code: "E_WORKER_LOST",
    message: withNextAction(
      "The background worker disappeared; the prompt was not replayed",
      MID_RUN_NEXT
    )
  };
}

function samePending(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * True when the caller still holds an exact, live launch authorization for this
 * review job. Unauthenticated or wrong-nonce callers must not mutate state.
 */
export function reviewLaunchAuthorizationMatches(job, authorization) {
  if (!job || job.jobClass !== "review" || !authorization) return false;
  const nonce = typeof authorization.nonce === "string" ? authorization.nonce : "";
  if (!nonce) return false;
  if (job.workerAuthorization === nonce && !job.workerProcess?.pid) return true;
  const identity = job.workerProcess;
  const pid = Number(authorization.pid);
  const startToken = typeof authorization.startToken === "string"
    ? authorization.startToken
    : "";
  const commandMarker = authorization.commandMarker;
  if (!identity?.pid || !Number.isInteger(pid) || pid <= 0) return false;
  return identity.nonce === nonce
    && identity.pid === pid
    && identity.startToken === startToken
    && identity.startToken
    && identity.commandMarker === commandMarker
    && (
      process.platform === "win32"
        ? identity.processGroupId === null
        : identity.processGroupId === pid
    );
}

/**
 * Persist scrubbed pre-provider failure intent only for an exact still-current
 * review launch authorization/identity. Unauthenticated callers no-op.
 */
export function recordReviewPreProviderFailure({
  root,
  jobId,
  error,
  authorization = null,
  env = process.env
}) {
  if (!authorization) return null;
  const intendedError = buildReviewPreProviderError(error);
  const intendedTerminal = {
    status: "failed",
    phase: "failed",
    completedAt: now(),
    error: intendedError,
    summary: intendedError.message
  };
  let recorded = null;
  updateJob(root, jobId, (current) => {
    if (terminal(current) || current.jobClass !== "review") {
      recorded = null;
      return current;
    }
    if (!reviewLaunchAuthorizationMatches(current, authorization)) {
      recorded = null;
      return current;
    }
    if (current.pendingTerminal && !samePending(current.pendingTerminal, intendedTerminal)) {
      recorded = {
        error: current.pendingTerminal.error,
        pendingTerminal: current.pendingTerminal
      };
      return current;
    }
    const next = scrubStoredJob({
      ...current,
      pendingTerminal: intendedTerminal,
      summary: intendedError.message,
      progress: "Review worker failed before provider start; cleanup pending",
      lifecycleEvents: appendLifecycleEvent(
        current.lifecycleEvents || [],
        "blocked",
        intendedError.message
      )
    });
    next.pendingTerminal = intendedTerminal;
    next.summary = intendedError.message;
    recorded = { error: intendedError, pendingTerminal: intendedTerminal };
    return next;
  }, env);
  return recorded;
}

/**
 * Provisional review admission during identity-publish lag: only when no PID is
 * recorded and workerAuthorization still matches. Atomically consumes the
 * authorization while binding the full self identity (pid, startToken, pgid).
 */
export function tryBindProvisionalReviewWorker({
  root,
  jobId,
  nonce,
  env = process.env
}) {
  if (typeof nonce !== "string" || !nonce) return false;
  const pid = process.pid;
  const startToken = processStartToken(pid);
  if (!startToken) return false;
  const processGroupId = process.platform === "win32" ? null : pid;
  let bound = false;
  updateJob(root, jobId, (current) => {
    if (terminal(current) || current.jobClass !== "review") return current;
    if (current.workerAuthorization !== nonce) return current;
    if (current.workerProcess?.pid) return current;
    current.workerAuthorization = null;
    current.workerProcess = {
      pid,
      startToken,
      processGroupId,
      nonce,
      commandMarker: jobId
    };
    current.summary = "Worker started";
    bound = true;
    return current;
  }, env);
  return bound;
}

export function selfReviewWorkerAuthorization(jobId, nonce) {
  const pid = process.pid;
  return {
    nonce,
    pid,
    startToken: processStartToken(pid),
    commandMarker: jobId
  };
}
