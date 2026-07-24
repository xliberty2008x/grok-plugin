const FAILURE_KEYS = new Set([
  "originalCode",
  "originalStage",
  "cleanupOutcome"
]);
const DIAGNOSTIC_KEYS = new Set([
  "cleanupOutcome",
  "originalCode",
  "originalStage"
]);
const RENDER_KEYS = new Set([
  "code",
  "stage",
  "diagnostic"
]);
const CLEANUP_OUTCOMES = new Set([
  "proven",
  "proof-returned-false",
  "cleanup-threw",
  "invalid-cleanup-result"
]);

export const INSTALLED_WORKER_MCP_ERROR_MESSAGES = Object.freeze({
  E_ARGUMENT: "Unsupported runner argument.",
  E_GATE: "All installed Worker MCP live gates must equal 1.",
  E_PLATFORM: "Installed Worker MCP qualification requires a supported POSIX host.",
  E_SOURCE: "The qualification source boundary is not clean and stable.",
  E_INSTALL: "The private Codex plugin installation could not be verified.",
  E_SETUP: "The installed provider setup could not be verified.",
  E_CAPABILITY: "The installed provider capability could not be verified.",
  E_MCP: "The installed Worker MCP protocol could not be verified.",
  E_SCENARIO: "The installed Worker MCP scenario did not satisfy its contract.",
  E_PRIVATE_STATE: "Installed private worker state did not satisfy its contract.",
  E_SESSION: "The exact qualification provider session could not be verified.",
  E_CLEANUP: "Exact qualification cleanup could not be proven.",
  E_RECEIPT: "The provisional live receipt could not be validated or published.",
  E_INTERRUPTED: "Installed Worker MCP qualification was interrupted."
});
const ERROR_CODES = new Set(Object.keys(INSTALLED_WORKER_MCP_ERROR_MESSAGES));

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validCode(value) {
  return typeof value === "string"
    && /^E_[A-Z_]+$/.test(value)
    && ERROR_CODES.has(value);
}

function validateDiagnostic(diagnostic, allowedStages) {
  return isPlainRecord(diagnostic)
    && Object.keys(diagnostic).length === DIAGNOSTIC_KEYS.size
    && Object.keys(diagnostic).every((key) => DIAGNOSTIC_KEYS.has(key))
    && typeof diagnostic.cleanupOutcome === "string"
    && diagnostic.cleanupOutcome !== "proven"
    && CLEANUP_OUTCOMES.has(diagnostic.cleanupOutcome)
    && validCode(diagnostic.originalCode)
    && typeof diagnostic.originalStage === "string"
    && allowedStages instanceof Set
    && allowedStages.has(diagnostic.originalStage);
}

export function classifyInstalledWorkerMcpCleanupOutcome(value) {
  if (value === true) return "proven";
  if (value === false) return "proof-returned-false";
  return "invalid-cleanup-result";
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
    || !validCode(value.originalCode)
    || typeof value.originalStage !== "string"
    || !(allowedStages instanceof Set)
    || !allowedStages.has(value.originalStage)
    || typeof value.cleanupOutcome !== "string"
    || !CLEANUP_OUTCOMES.has(value.cleanupOutcome)
  ) {
    throw new TypeError("Installed Worker MCP failure selection input is malformed.");
  }
  return Object.freeze(value.cleanupOutcome === "proven"
    ? {
        code: value.originalCode,
        stage: value.originalStage,
        diagnostic: null
      }
    : {
        code: "E_CLEANUP",
        stage: "emergency-cleanup",
        diagnostic: Object.freeze({
          cleanupOutcome: value.cleanupOutcome,
          originalCode: value.originalCode,
          originalStage: value.originalStage
        })
      });
}

export function formatInstalledWorkerMcpDiagnostic(
  diagnostic,
  allowedStages
) {
  if (!validateDiagnostic(diagnostic, allowedStages)) {
    throw new TypeError("Installed Worker MCP diagnostic input is malformed.");
  }
  return `Installed Worker MCP E2E diagnostic ${JSON.stringify({
    cleanupOutcome: diagnostic.cleanupOutcome,
    originalCode: diagnostic.originalCode,
    originalStage: diagnostic.originalStage
  })}\n`;
}

export function formatInstalledWorkerMcpFailure(value, allowedStages) {
  if (
    !isPlainRecord(value)
    || Object.keys(value).length !== RENDER_KEYS.size
    || Object.keys(value).some((key) => !RENDER_KEYS.has(key))
    || !validCode(value.code)
    || typeof value.stage !== "string"
    || !(allowedStages instanceof Set)
    || !allowedStages.has(value.stage)
    || (
      value.diagnostic !== null
      && (
        value.code !== "E_CLEANUP"
        || value.stage !== "emergency-cleanup"
        || !validateDiagnostic(value.diagnostic, allowedStages)
      )
    )
    || (
      value.stage === "emergency-cleanup"
      && value.diagnostic === null
    )
  ) {
    throw new TypeError("Installed Worker MCP failure render input is malformed.");
  }
  const stage = value.stage === "startup" ? "" : `; stage=${value.stage}`;
  const diagnostic = value.diagnostic === null
    ? ""
    : formatInstalledWorkerMcpDiagnostic(value.diagnostic, allowedStages);
  return `Installed Worker MCP E2E failed [${value.code}${stage}]: ${INSTALLED_WORKER_MCP_ERROR_MESSAGES[value.code]}\n${diagnostic}`;
}
