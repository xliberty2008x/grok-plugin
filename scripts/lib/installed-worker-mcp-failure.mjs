const FAILURE_KEYS = new Set([
  "originalCode",
  "originalStage",
  "cleanupProven"
]);

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Select the one bounded runner failure after emergency cleanup.
 * Cleanup failure overrides the original error because no lifecycle result is
 * trustworthy while owned processes or temporary state may remain.
 */
export function selectInstalledWorkerMcpFailure(value, allowedStages) {
  if (
    !isPlainRecord(value)
    || Object.keys(value).length !== FAILURE_KEYS.size
    || Object.keys(value).some((key) => !FAILURE_KEYS.has(key))
    || typeof value.originalCode !== "string"
    || !/^E_[A-Z_]+$/.test(value.originalCode)
    || typeof value.originalStage !== "string"
    || !(allowedStages instanceof Set)
    || !allowedStages.has(value.originalStage)
    || typeof value.cleanupProven !== "boolean"
  ) {
    throw new TypeError("Installed Worker MCP failure selection input is malformed.");
  }
  return Object.freeze(value.cleanupProven
    ? {
        code: value.originalCode,
        stage: value.originalStage
      }
    : {
        code: "E_CLEANUP",
        stage: "emergency-cleanup"
      });
}
