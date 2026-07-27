const INPUT_KEYS = new Set([
  "workerStatus",
  "mailboxState"
]);
const ACTIVE_WORKER_STATUSES = new Set([
  "queued",
  "running"
]);
const TERMINAL_WORKER_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled"
]);
const PRE_OPEN_MAILBOX_STATES = new Set([
  null,
  "preparing"
]);

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function decideInstalledWorkerMcpMailboxPoll(value) {
  if (
    !isPlainRecord(value)
    || Object.keys(value).length !== INPUT_KEYS.size
    || Object.keys(value).some((key) => !INPUT_KEYS.has(key))
    || typeof value.workerStatus !== "string"
    || (
      !ACTIVE_WORKER_STATUSES.has(value.workerStatus)
      && !TERMINAL_WORKER_STATUSES.has(value.workerStatus)
    )
    || (
      value.mailboxState !== "open"
      && !PRE_OPEN_MAILBOX_STATES.has(value.mailboxState)
    )
  ) {
    throw new TypeError("Installed Worker MCP mailbox polling input is malformed.");
  }
  if (TERMINAL_WORKER_STATUSES.has(value.workerStatus)) {
    return "terminal-before-open";
  }
  if (PRE_OPEN_MAILBOX_STATES.has(value.mailboxState)) return "wait";
  if (value.workerStatus === "running" && value.mailboxState === "open") {
    return "observe-live-provider";
  }
  throw new TypeError("Installed Worker MCP mailbox lifecycle is inconsistent.");
}
