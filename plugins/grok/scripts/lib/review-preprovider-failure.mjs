import { asErrorPayload } from "./errors.mjs";
import { redact, redactText, sanitizeDisplayText } from "./redact.mjs";
import { appendLifecycleEvent } from "./task-lifecycle.mjs";
import { updateJob, terminal, now } from "./state.mjs";
import { scrubStoredJob } from "./task-contract.mjs";

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
 * Persist scrubbed pre-provider failure intent as pendingTerminal without
 * terminalizing the job. Recovery later promotes the intent once safe.
 * Never embeds request.prompt into pendingTerminal.
 */
export function recordReviewPreProviderFailure({ root, jobId, error, env = process.env }) {
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
    if (terminal(current) || (current.jobClass && current.jobClass !== "review")) {
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
    // Ensure pending survives scrub if scrub strips unknown fields incorrectly.
    next.pendingTerminal = intendedTerminal;
    next.summary = intendedError.message;
    recorded = { error: intendedError, pendingTerminal: intendedTerminal };
    return next;
  }, env);
  return recorded;
}
