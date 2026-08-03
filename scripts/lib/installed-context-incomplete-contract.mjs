const PUBLIC_ERROR_REQUIRED_KEYS = new Set([
  "workerProtocolVersion",
  "errorSchemaVersion",
  "code",
  "message"
]);
const PUBLIC_ERROR_ALLOWED_KEYS = new Set([...PUBLIC_ERROR_REQUIRED_KEYS, "details"]);
const CONTEXT_INCOMPLETE_ERROR_DETAIL_KEYS = new Set([
  "contextPhase",
  "metadataComponents"
]);
const CONTEXT_INCOMPLETE_TERMINAL_PROJECTION_KEYS = new Set([
  "status",
  "phase",
  "terminal",
  "error"
]);
const CONTEXT_INCOMPLETE_PHASES = new Set([
  "admission",
  "execute",
  "resume",
  "terminal"
]);
const CONTEXT_INCOMPLETE_COMPONENTS = new Set([
  "nonRef",
  "operational",
  "hooks",
  "config",
  "indexFlags",
  "refs",
  "upstream",
  "gitMetadata",
  "contextCapture"
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  return isPlainObject(value)
    && Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}

function allowedKeys(value, required, allowed) {
  return isPlainObject(value)
    && [...required].every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

export function validInstalledPublicError(value, status, { validPublicText }) {
  if (status === "completed") return value === null;
  if (!allowedKeys(value, PUBLIC_ERROR_REQUIRED_KEYS, PUBLIC_ERROR_ALLOWED_KEYS)
    || value.workerProtocolVersion !== 1
    || !validPublicText(value.message)
    || value.message.length === 0) return false;
  if (status === "cancelled") {
    return value.code === "E_CANCELLED"
      && value.errorSchemaVersion === 1
      && !Object.hasOwn(value, "details");
  }
  if (status !== "failed"
    || value.code !== "E_CONTEXT_INCOMPLETE"
    || value.errorSchemaVersion !== 2
    || !exactKeys(value.details, CONTEXT_INCOMPLETE_ERROR_DETAIL_KEYS)
    || !CONTEXT_INCOMPLETE_PHASES.has(value.details.contextPhase)
    || !Array.isArray(value.details.metadataComponents)
    || value.details.metadataComponents.length < 1
    || value.details.metadataComponents.length > CONTEXT_INCOMPLETE_COMPONENTS.size
    || new Set(value.details.metadataComponents).size
      !== value.details.metadataComponents.length) return false;
  return value.details.metadataComponents.every((component) => (
    CONTEXT_INCOMPLETE_COMPONENTS.has(component)
  ));
}

export function validateContextIncompleteTerminalProjection(value, {
  boundedJson,
  assertNoPrivateProjectionData,
  fail,
  validPublicText
}) {
  const code = "E_LIVE_PRIVATE_STATE";
  const projection = boundedJson(value, code);
  assertNoPrivateProjectionData(projection, code);
  if (!exactKeys(projection, CONTEXT_INCOMPLETE_TERMINAL_PROJECTION_KEYS)
    || projection.status !== "failed"
    || projection.phase !== "context-rejected"
    || projection.terminal !== true
    || !validInstalledPublicError(projection.error, "failed", { validPublicText })) {
    fail(code);
  }
  return projection;
}
