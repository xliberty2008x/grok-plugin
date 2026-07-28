/**
 * Private Grok Review GitHub App — shared constants.
 * Control-plane only; no target-repo content or review payloads.
 */

export const MAX_WEBHOOK_BYTES = 1 * 1024 * 1024; // 1 MiB
// A sanitized receipt may contain 32 bounded instruction paths (up to 4 KiB
// each) plus signatures and runtime metadata. Repository content remains
// forbidden by the strict receipt schema.
export const MAX_CALLBACK_BYTES = 512 * 1024; // 512 KiB incl. JSON escaping overhead
export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_API_VERSION = "2026-03-10";
export const FETCH_TIMEOUT_MS = 10_000;

/** Public webhook path (exact). */
export const WEBHOOK_PATH = "/github/webhooks";

/** Internal runner callback path (exact). */
export const CALLBACK_PATH = "/internal/callback";

/** Exact manual command body (trimmed). */
export const MANUAL_REVIEW_COMMAND = "@grok-review review";

/** App-owned check requested_action identifier. */
export const CHECK_RERUN_IDENTIFIER = "grok_review_rerun";

/** Prefix for host-owned check external_id. */
export const EXTERNAL_ID_PREFIX = "grv1";

/** Automatic request identity policy version (binds into request_key). */
export const POLICY_VERSION = "1";

/** Callback timestamp skew allowance (seconds). */
export const CALLBACK_TIMESTAMP_SKEW_SECONDS = 300;

/** Max length for a canonical decimal GitHub ID string. */
export const MAX_DECIMAL_ID_LENGTH = 32;

/** Full SHA-1 / SHA-256 hex lengths accepted for expected head. */
export const HEAD_SHA_HEX_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export const TRIGGER_KIND = Object.freeze({
  AUTOMATIC: "automatic",
  MANUAL_COMMENT: "manual_comment",
  CHECK_RERUN: "check_rerun"
});

export const REQUEST_STATUS = Object.freeze({
  PENDING_DISPATCH: "pending_dispatch",
  DISPATCHED: "dispatched",
  FAILED_DISPATCH: "failed_dispatch",
  CLAIMED: "claimed",
  STARTED: "started",
  SUPERSEDED: "superseded",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled"
});

/** Statuses that a newer live-authorized request may supersede. */
export const SUPERSEDABLE_STATUSES = Object.freeze([
  REQUEST_STATUS.PENDING_DISPATCH,
  REQUEST_STATUS.DISPATCHED,
  REQUEST_STATUS.FAILED_DISPATCH,
  REQUEST_STATUS.CLAIMED,
  REQUEST_STATUS.STARTED
]);

/** Statuses that may (re)attempt workflow dispatch. */
export const RETRYABLE_DISPATCH_STATUSES = Object.freeze([
  REQUEST_STATUS.PENDING_DISPATCH,
  REQUEST_STATUS.FAILED_DISPATCH
]);

/** Terminal request statuses (no further transitions). */
export const TERMINAL_STATUSES = Object.freeze([
  REQUEST_STATUS.SUPERSEDED,
  REQUEST_STATUS.COMPLETED,
  REQUEST_STATUS.FAILED,
  REQUEST_STATUS.CANCELLED
]);

export const CALLBACK_EVENT = Object.freeze({
  CLAIM: "claim",
  AUTHORIZED: "authorized",
  STARTED: "started",
  ABORT: "abort",
  TERMINAL: "terminal"
});

export const TERMINAL_RECEIPT_STATUS = Object.freeze({
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled"
});

export const ABORT_STATUS = Object.freeze({
  FAILED: "failed",
  CANCELLED: "cancelled"
});

export const OUTBOX_JOB_TYPE = Object.freeze({
  DISPATCH: "dispatch",
  CANCEL: "cancel"
});

export const OUTBOX_JOB_STATUS = Object.freeze({
  PENDING: "pending",
  LEASED: "leased",
  COMPLETED: "completed"
});

export const OUTBOX_BATCH_SIZE = 16;
export const OUTBOX_MAX_BATCHES = 4;
export const OUTBOX_LEASE_MS = 60_000;
export const OUTBOX_BACKOFF_BASE_MS = 1_000;
export const OUTBOX_BACKOFF_MAX_MS = 15 * 60_000;
export const WATCHDOG_STALE_MS = 15 * 60_000;
export const WATCHDOG_BATCH_SIZE = 16;

/**
 * Event → allowed action names.
 */
export const ALLOWED_EVENT_ACTIONS = Object.freeze({
  pull_request: Object.freeze([
    "opened",
    "reopened",
    "ready_for_review",
    "synchronize"
  ]),
  issue_comment: Object.freeze(["created"]),
  check_run: Object.freeze(["requested_action"]),
  installation: Object.freeze([
    "created",
    "deleted",
    "suspend",
    "unsuspend",
    "new_permissions_accepted"
  ]),
  installation_repositories: Object.freeze(["added", "removed"])
});

export const ALLOWED_EVENT_NAMES = Object.freeze(
  Object.keys(ALLOWED_EVENT_ACTIONS)
);

/** Exact Content-Type values accepted for webhook/callback JSON bodies. */
export const ALLOWED_JSON_CONTENT_TYPES = Object.freeze([
  "application/json",
  "application/json; charset=utf-8",
  "application/json;charset=utf-8"
]);
