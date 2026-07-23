import crypto from "node:crypto";
import path from "node:path";

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 16_384;
const MAX_ARRAY_ITEMS = 8_192;
const MAX_OBJECT_KEYS = 8_192;
const MAX_KEY_BYTES = 1_024;
const MAX_STRING_BYTES = 256 * 1024;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const WORKER_ID = /^(?:review|adversarial-review|task|stop-review)-[a-f0-9]{16,64}$/;
const CANCELLATION_RECEIPT_ID = /^cancel-[a-f0-9]{24}$/;
const TASK_ENVELOPE_ID = /^env-[a-f0-9]{24}$/;
const CONTEXT_MANIFEST_ID = /^ctx-[a-f0-9]{24}$/;
const HOST_TASK_BINDING = /^host-task-[a-f0-9]{32}$/;
const CONTROL_WORKSPACE_ID = /^cws-[a-f0-9]{32}$/;
const RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/;
const PROVIDER_VERSION = /^\d+\.\d+\.\d+$/;

const ERROR_MESSAGES = Object.freeze({
  E_LIVE_SETUP: "Installed Grok setup evidence is invalid.",
  E_LIVE_CAPABILITY: "Installed provider capability evidence is invalid.",
  E_LIVE_INITIALIZE: "Installed Worker MCP initialization evidence is invalid.",
  E_LIVE_TOOLS: "Installed Worker MCP tool inventory evidence is invalid.",
  E_LIVE_TOOL_RESULT: "Installed Worker MCP tool result evidence is invalid.",
  E_LIVE_COMPLETION: "Installed Worker MCP completion evidence is invalid.",
  E_LIVE_CANCELLATION: "Installed Worker MCP cancellation evidence is invalid.",
  E_LIVE_PRIVATE_STATE: "Installed Worker MCP private-state evidence is invalid."
});

export const INSTALLED_WORKER_TOOL_NAMES = Object.freeze([
  "worker_list_owned",
  "worker_get",
  "worker_events_after",
  "worker_wait",
  "worker_result",
  "worker_spawn",
  "worker_cancel"
]);

export const INSTALLED_WORKER_SCENARIO_IDS = Object.freeze([
  "authenticated-completion",
  "mcp-restart-reconnect-cancellation"
]);

const SETUP_KEYS = new Set(["ready", "grok", "config", "disclosure", "nextSteps"]);
const SETUP_RUNTIME_KEYS = new Set([
  "binary",
  "version",
  "authenticated",
  "headlessReview",
  "acpIsolation",
  "protocolVersion",
  "loadSession",
  "authMethods",
  "models"
]);
const HEADLESS_REVIEW_KEYS = new Set([
  "flags",
  "isolated",
  "externalHooks",
  "externalSkills",
  "externalPlugins",
  "externalMcpServers"
]);
const ACP_ISOLATION_KEYS = new Set([
  "flags",
  "isolated",
  "sandbox",
  "permissionMode",
  "injectDefaultTools",
  "agentProfileDigest",
  "unattendedPrivilegeExpansion"
]);
const CAPABILITY_RECEIPT_KEYS = new Set([
  "schemaVersion",
  "receiptType",
  "pluginVersion",
  "mcpCapabilityContractVersion",
  "platform",
  "architecture",
  "providerVersion",
  "providerFileIdentity",
  "acpProtocolVersion",
  "loadSession",
  "setupProfileDigest",
  "rootReadProfileDigest",
  "capabilities",
  "issuedAt",
  "expiresAt",
  "capabilityDigest",
  "receiptDigest"
]);
const PROVIDER_IDENTITY_KEYS = new Set([
  "device",
  "inode",
  "size",
  "mtimeMs",
  "contentDigest"
]);
const CAPABILITY_EXPECTATION_KEYS = new Set([
  "setup",
  "pluginVersion",
  "mcpCapabilityContractVersion",
  "platform",
  "architecture",
  "providerFileIdentity",
  "rootReadProfileDigest",
  "observedAt"
]);
const INITIALIZE_KEYS = new Set([
  "protocolVersion",
  "capabilities",
  "serverInfo",
  "instructions",
  "_meta"
]);
const INITIALIZE_META_KEYS = new Set([
  "grok/capability-matrix",
  "grok/capabilityDigest",
  "grok/hostVerification",
  "grok/supportedProtocolVersions",
  "grok/externalWorkerLabel"
]);
const INITIALIZE_EXPECTATION_KEYS = new Set([
  "serverVersion",
  "capabilityDigest",
  "experimentalCapabilities",
  "capabilityMatrix"
]);
const TOOL_KEYS = new Set(["name", "title", "description", "inputSchema", "annotations"]);
const TOOL_ANNOTATION_KEYS = new Set([
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint"
]);
const TOOL_RESULT_EXPECTATION_KEYS = new Set([
  "outcome",
  "expectedErrorCode",
  "expectedPayloadKeys",
  "expectedStructuredContent"
]);
const SPAWN_PAYLOAD_KEYS = new Set([
  "ok",
  "worker",
  "replayed",
  "spawnSuccessDefinition",
  "providerLaunchState",
  "providerLaunched"
]);
const CANCEL_PAYLOAD_KEYS = new Set(["ok", "receipt", "replayed"]);
const CANCELLATION_RECEIPT_KEYS = new Set([
  "receiptId",
  "workerId",
  "status",
  "requestAcceptedAt",
  "processGroupGoneAt",
  "terminalRecordCommittedAt",
  "idempotencyKeyDigest",
  "cancellationRequestSequence"
]);
const COMPLETION_BUNDLE_KEYS = new Set(["spawn", "terminalResult"]);
const CANCELLATION_BUNDLE_KEYS = new Set([
  "spawn",
  "spawnReplay",
  "cancel",
  "cancelReplay",
  "terminalResult"
]);
const PRIVATE_OBSERVATION_KEYS = new Set([
  "scenarioId",
  "observedWorkerIds",
  "observedTaskEnvelopeIds",
  "observedContextManifestIds",
  "observedProviderGenerations",
  "observedProviderWorkerIds",
  "observedCancellationReceiptIds",
  "spawnInvocationCount",
  "spawnReplayCount",
  "providerLaunchCount",
  "providerTerminalCount",
  "workerTerminalCount",
  "resultReadCount",
  "reconnectCount",
  "cancelInvocationCount",
  "cancelReplayCount",
  "uniqueCancelRequestCount",
  "cancellationEventCount",
  "duplicateLaunchCount",
  "workerHostVerification",
  "processGroupGone",
  "taskRuntimeCleaned",
  "providerGuardAbsent",
  "runnerTemporaryArtifactsRemoved",
  "qualificationSessionDeleted"
]);

const SCENARIO_COUNTS = Object.freeze({
  "authenticated-completion": Object.freeze({
    spawnInvocationCount: 1,
    spawnReplayCount: 0,
    providerLaunchCount: 1,
    providerTerminalCount: 1,
    workerTerminalCount: 1,
    resultReadCount: 1,
    reconnectCount: 0,
    cancelInvocationCount: 0,
    cancelReplayCount: 0,
    uniqueCancelRequestCount: 0,
    cancellationEventCount: 0,
    duplicateLaunchCount: 0
  }),
  "mcp-restart-reconnect-cancellation": Object.freeze({
    spawnInvocationCount: 2,
    spawnReplayCount: 1,
    providerLaunchCount: 1,
    providerTerminalCount: 1,
    workerTerminalCount: 1,
    resultReadCount: 1,
    reconnectCount: 1,
    cancelInvocationCount: 2,
    cancelReplayCount: 1,
    uniqueCancelRequestCount: 1,
    cancellationEventCount: 1,
    duplicateLaunchCount: 0
  })
});

const COUNT_FIELDS = Object.freeze(Object.keys(SCENARIO_COUNTS["authenticated-completion"]));
const IMMUTABLE_WORKER_FIELDS = Object.freeze([
  "id",
  "kind",
  "jobClass",
  "write",
  "lineageWorkerId",
  "taskEnvelopeId",
  "taskEnvelopeDigest",
  "contextManifestId",
  "contextDigest",
  "workspaceSnapshotDigest",
  "hostTaskBinding",
  "controlWorkspaceId",
  "roleId",
  "externalWorkerLabel"
]);
const NULLABLE_STABLE_WORKER_FIELDS = Object.freeze(["parentWorkerId"]);
const ACTIVE_REPLAY_PHASES = new Set([
  "starting",
  "creating-session",
  "prompting",
  "planning",
  "executing",
  "responding",
  "finalizing"
]);

export class InstalledWorkerMcpContractError extends Error {
  constructor(code) {
    const normalizedCode = Object.hasOwn(ERROR_MESSAGES, code)
      ? code
      : "E_LIVE_PRIVATE_STATE";
    super(ERROR_MESSAGES[normalizedCode]);
    this.name = "InstalledWorkerMcpContractError";
    this.code = normalizedCode;
    this.stack = `${this.name}: ${this.message}`;
  }
}

function fail(code) {
  throw new InstalledWorkerMcpContractError(code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function boundedString(value, maximumBytes = MAX_STRING_BYTES) {
  return (
    typeof value === "string"
    && !value.includes("\0")
    && value.length <= maximumBytes
    && byteLength(value) <= maximumBytes
  );
}

function visitJson(value, state, code, depth) {
  if (depth > MAX_JSON_DEPTH || state.nodes >= MAX_JSON_NODES) fail(code);
  state.nodes += 1;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail(code);
    return value;
  }
  if (typeof value === "string") {
    if (!boundedString(value)) fail(code);
    state.scalarBytes += byteLength(value);
    if (state.scalarBytes > MAX_JSON_BYTES) fail(code);
    return value;
  }
  if (typeof value !== "object") fail(code);
  if (state.seen.has(value)) fail(code);
  state.seen.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype || value.length > MAX_ARRAY_ITEMS) fail(code);
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== value.length + 1
        || keys.at(-1) !== "length"
        || keys.some((key, index) => index < value.length && key !== String(index))
      ) {
        fail(code);
      }
      const clone = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail(code);
        clone.push(visitJson(descriptor.value, state, code, depth + 1));
      }
      return clone;
    }
    if (prototype !== Object.prototype && prototype !== null) fail(code);
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_OBJECT_KEYS || keys.some((key) => typeof key !== "string")) fail(code);
    const clone = Object.create(null);
    for (const key of keys) {
      if (!boundedString(key, MAX_KEY_BYTES)) fail(code);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail(code);
      clone[key] = visitJson(descriptor.value, state, code, depth + 1);
    }
    return clone;
  } finally {
    state.seen.delete(value);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function boundedJson(value, code) {
  try {
    const clone = visitJson(value, {
      nodes: 0,
      scalarBytes: 0,
      seen: new Set()
    }, code, 0);
    const serialized = JSON.stringify(clone);
    if (typeof serialized !== "string" || byteLength(serialized) > MAX_JSON_BYTES) fail(code);
    return deepFreeze(clone);
  } catch (error) {
    if (error instanceof InstalledWorkerMcpContractError) throw error;
    fail(code);
  }
}

function exactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function sameJson(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((entry, index) => sameJson(entry, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index] && sameJson(left[key], right[key])
    ))
  );
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  const normalized = {};
  for (const key of Object.keys(value).sort()) normalized[key] = canonicalize(value[key]);
  return normalized;
}

function stableDigest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function canonicalIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validRuntimeId(value) {
  return boundedString(value, 128) && RUNTIME_ID.test(value);
}

function validProviderIdentity(identity) {
  return (
    exactKeys(identity, PROVIDER_IDENTITY_KEYS)
    && boundedString(identity.device, 128)
    && identity.device.length > 0
    && boundedString(identity.inode, 128)
    && identity.inode.length > 0
    && Number.isSafeInteger(identity.size)
    && identity.size >= 1
    && identity.size <= 128 * 1024 * 1024
    && Number.isSafeInteger(identity.mtimeMs)
    && identity.mtimeMs >= 0
    && SHA256_HEX.test(identity.contentDigest || "")
  );
}

function assertNoHostVerificationPromotion(value, code) {
  if (!value || typeof value !== "object") return;
  if (
    isRecord(value)
    && Object.hasOwn(value, "hostVerification")
    && value.hostVerification !== "not_run"
  ) {
    fail(code);
  }
  for (const entry of Object.values(value)) assertNoHostVerificationPromotion(entry, code);
}

function validTextArray(value, expected) {
  return (
    Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index])
  );
}

function validAbsoluteBinary(value) {
  return (
    boundedString(value, 4 * 1024)
    && value.length > 0
    && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value))
  );
}

function validSetupRuntime(runtime) {
  if (
    !exactKeys(runtime, SETUP_RUNTIME_KEYS)
    || !validAbsoluteBinary(runtime.binary)
    || !boundedString(runtime.version, 64)
    || !PROVIDER_VERSION.test(runtime.version)
    || runtime.authenticated !== true
    || runtime.protocolVersion !== 1
    || runtime.loadSession !== true
    || !exactKeys(runtime.headlessReview, HEADLESS_REVIEW_KEYS)
    || !validTextArray(runtime.headlessReview.flags, [
      "--prompt-file",
      "--json-schema",
      "--tools",
      "--disallowed-tools",
      "--sandbox"
    ])
    || runtime.headlessReview.isolated !== true
    || runtime.headlessReview.externalHooks !== 0
    || runtime.headlessReview.externalSkills !== 0
    || runtime.headlessReview.externalPlugins !== 0
    || runtime.headlessReview.externalMcpServers !== 0
    || !exactKeys(runtime.acpIsolation, ACP_ISOLATION_KEYS)
    || !validTextArray(runtime.acpIsolation.flags, [
      "--agent-profile",
      "--no-leader",
      "--leader-socket"
    ])
    || runtime.acpIsolation.isolated !== true
    || runtime.acpIsolation.sandbox !== "read-only"
    || runtime.acpIsolation.permissionMode !== "dontAsk"
    || runtime.acpIsolation.injectDefaultTools !== false
    || !SHA256_HEX.test(runtime.acpIsolation.agentProfileDigest || "")
    || runtime.acpIsolation.unattendedPrivilegeExpansion !== false
    || !Array.isArray(runtime.authMethods)
    || runtime.authMethods.length > 64
    || !runtime.authMethods.every((method) => (
      exactKeys(method, new Set(["id", "name"]))
      && boundedString(method.id, 256)
      && boundedString(method.name, 256)
    ))
    || !Array.isArray(runtime.models)
    || runtime.models.length > 256
    || !runtime.models.every((model) => (
      exactKeys(model, new Set(["id", "efforts"]))
      && boundedString(model.id, 256)
      && Array.isArray(model.efforts)
      && model.efforts.length <= 64
      && model.efforts.every((effort) => boundedString(effort, 128))
    ))
  ) {
    return false;
  }
  return true;
}

/**
 * Validate the exact JSON emitted by an installed `setup --json` success.
 * An exit status alone is deliberately insufficient.
 */
export function validateInstalledSetup(value) {
  const setup = boundedJson(value, "E_LIVE_SETUP");
  if (
    !exactKeys(setup, SETUP_KEYS)
    || setup.ready !== true
    || !validSetupRuntime(setup.grok)
    || !isRecord(setup.config)
    || !boundedString(setup.disclosure, 64 * 1024)
    || setup.disclosure.length === 0
    || !Array.isArray(setup.nextSteps)
    || setup.nextSteps.length < 1
    || setup.nextSteps.length > 16
    || !setup.nextSteps.every((step) => boundedString(step, 4 * 1024) && step.length > 0)
  ) {
    fail("E_LIVE_SETUP");
  }
  return setup;
}

/**
 * Validate and cross-bind the installed provider capability receipt.
 * The caller must independently supply current installed identity and time.
 */
export function validateProviderCapabilityAgreement(value, valueExpectations) {
  const receipt = boundedJson(value, "E_LIVE_CAPABILITY");
  const expectations = boundedJson(valueExpectations, "E_LIVE_CAPABILITY");
  if (!exactKeys(expectations, CAPABILITY_EXPECTATION_KEYS)) fail("E_LIVE_CAPABILITY");
  const setup = validateInstalledSetup(expectations.setup);
  const observedAt = expectations.observedAt;
  if (
    !exactKeys(receipt, CAPABILITY_RECEIPT_KEYS)
    || receipt.schemaVersion !== 1
    || receipt.receiptType !== "grok-provider-capability"
    || !validRuntimeId(receipt.pluginVersion)
    || !validRuntimeId(receipt.mcpCapabilityContractVersion)
    || !validRuntimeId(receipt.platform)
    || !validRuntimeId(receipt.architecture)
    || !boundedString(receipt.providerVersion, 64)
    || !PROVIDER_VERSION.test(receipt.providerVersion)
    || !validProviderIdentity(receipt.providerFileIdentity)
    || receipt.acpProtocolVersion !== 1
    || receipt.loadSession !== true
    || !SHA256_HEX.test(receipt.setupProfileDigest || "")
    || !SHA256_HEX.test(receipt.rootReadProfileDigest || "")
    || !validTextArray(receipt.capabilities, ["root-read-spawn-v1"])
    || !canonicalIsoTimestamp(receipt.issuedAt)
    || !canonicalIsoTimestamp(receipt.expiresAt)
    || !SHA256_HEX.test(receipt.capabilityDigest || "")
    || !SHA256_HEX.test(receipt.receiptDigest || "")
    || !validRuntimeId(expectations.pluginVersion)
    || !validRuntimeId(expectations.mcpCapabilityContractVersion)
    || !validRuntimeId(expectations.platform)
    || !validRuntimeId(expectations.architecture)
    || !validProviderIdentity(expectations.providerFileIdentity)
    || !SHA256_HEX.test(expectations.rootReadProfileDigest || "")
    || !Number.isSafeInteger(observedAt)
    || observedAt < 0
  ) {
    fail("E_LIVE_CAPABILITY");
  }
  const issuedAt = Date.parse(receipt.issuedAt);
  const expiresAt = Date.parse(receipt.expiresAt);
  const stable = {
    schemaVersion: receipt.schemaVersion,
    receiptType: receipt.receiptType,
    pluginVersion: receipt.pluginVersion,
    mcpCapabilityContractVersion: receipt.mcpCapabilityContractVersion,
    platform: receipt.platform,
    architecture: receipt.architecture,
    providerVersion: receipt.providerVersion,
    providerFileIdentity: receipt.providerFileIdentity,
    acpProtocolVersion: receipt.acpProtocolVersion,
    loadSession: receipt.loadSession,
    setupProfileDigest: receipt.setupProfileDigest,
    rootReadProfileDigest: receipt.rootReadProfileDigest,
    capabilities: receipt.capabilities
  };
  const receiptBody = { ...stable,
    issuedAt: receipt.issuedAt,
    expiresAt: receipt.expiresAt,
    capabilityDigest: receipt.capabilityDigest
  };
  if (
    expiresAt <= issuedAt
    || expiresAt - issuedAt > 24 * 60 * 60 * 1000
    || observedAt < issuedAt
    || observedAt >= expiresAt
    || receipt.pluginVersion !== expectations.pluginVersion
    || receipt.mcpCapabilityContractVersion !== expectations.mcpCapabilityContractVersion
    || receipt.platform !== expectations.platform
    || receipt.architecture !== expectations.architecture
    || receipt.providerVersion !== setup.grok.version
    || receipt.acpProtocolVersion !== setup.grok.protocolVersion
    || receipt.loadSession !== setup.grok.loadSession
    || receipt.setupProfileDigest !== setup.grok.acpIsolation.agentProfileDigest
    || receipt.rootReadProfileDigest !== expectations.rootReadProfileDigest
    || !sameJson(receipt.providerFileIdentity, expectations.providerFileIdentity)
    || receipt.capabilityDigest !== stableDigest(stable)
    || receipt.receiptDigest !== stableDigest(receiptBody)
  ) {
    fail("E_LIVE_CAPABILITY");
  }
  return receipt;
}

/**
 * Validate the installed broker's MCP initialize result. This function is
 * suitable for use inside the bounded client's server validator by returning
 * `true` after it succeeds.
 */
export function validateInstalledInitialize(value, valueExpectations) {
  const result = boundedJson(value, "E_LIVE_INITIALIZE");
  const expectations = boundedJson(valueExpectations, "E_LIVE_INITIALIZE");
  if (
    !exactKeys(expectations, INITIALIZE_EXPECTATION_KEYS)
    || !validRuntimeId(expectations.serverVersion)
    || !SHA256_HEX.test(expectations.capabilityDigest || "")
    || !isRecord(expectations.experimentalCapabilities)
    || !isRecord(expectations.capabilityMatrix)
    || !exactKeys(result, INITIALIZE_KEYS)
    || result.protocolVersion !== "2025-11-25"
    || !exactKeys(result.capabilities, new Set(["tools", "experimental"]))
    || !exactKeys(result.capabilities.tools, new Set(["listChanged"]))
    || result.capabilities.tools.listChanged !== false
    || !isRecord(result.capabilities.experimental)
    || !sameJson(
      result.capabilities.experimental,
      expectations.experimentalCapabilities
    )
    || !exactKeys(result.serverInfo, new Set(["name", "version"]))
    || result.serverInfo.name !== "grok-worker-broker"
    || result.serverInfo.version !== expectations.serverVersion
    || !boundedString(result.instructions, 8 * 1024)
    || result.instructions.length === 0
    || !exactKeys(result._meta, INITIALIZE_META_KEYS)
    || !isRecord(result._meta["grok/capability-matrix"])
    || !sameJson(
      result._meta["grok/capability-matrix"],
      expectations.capabilityMatrix
    )
    || result._meta["grok/capabilityDigest"] !== expectations.capabilityDigest
    || result._meta["grok/hostVerification"] !== "suppressed"
    || !validTextArray(result._meta["grok/supportedProtocolVersions"], [
      "2025-11-25",
      "2025-06-18",
      "2024-11-05"
    ])
    || result._meta["grok/externalWorkerLabel"] !== "external-grok-worker"
  ) {
    fail("E_LIVE_INITIALIZE");
  }
  return true;
}

function validTool(tool, expectedName) {
  return (
    exactKeys(tool, TOOL_KEYS)
    && tool.name === expectedName
    && boundedString(tool.title, 1_024)
    && tool.title.length > 0
    && boundedString(tool.description, 8 * 1024)
    && tool.description.length > 0
    && isRecord(tool.inputSchema)
    && tool.inputSchema.type === "object"
    && tool.inputSchema.additionalProperties === false
    && exactKeys(tool.annotations, TOOL_ANNOTATION_KEYS)
    && typeof tool.annotations.readOnlyHint === "boolean"
    && typeof tool.annotations.destructiveHint === "boolean"
    && tool.annotations.idempotentHint === true
    && tool.annotations.openWorldHint === false
  );
}

/**
 * Require both the fixed seven-tool order and exact structural equality with
 * the WORKER_TOOLS projection loaded from the same installed artifact.
 */
export function validateInstalledToolInventory(value, valueExpectedTools) {
  const result = boundedJson(value, "E_LIVE_TOOLS");
  const expectedTools = boundedJson(valueExpectedTools, "E_LIVE_TOOLS");
  if (
    !exactKeys(result, new Set(["tools"]))
    || !Array.isArray(result.tools)
    || !Array.isArray(expectedTools)
    || result.tools.length !== INSTALLED_WORKER_TOOL_NAMES.length
    || expectedTools.length !== INSTALLED_WORKER_TOOL_NAMES.length
    || !result.tools.every((tool, index) => validTool(tool, INSTALLED_WORKER_TOOL_NAMES[index]))
    || !expectedTools.every((tool, index) => validTool(tool, INSTALLED_WORKER_TOOL_NAMES[index]))
    || !sameJson(result.tools, expectedTools)
  ) {
    fail("E_LIVE_TOOLS");
  }
  const spawn = result.tools[5];
  if (
    Object.hasOwn(spawn.inputSchema.properties || {}, "write")
    || result.tools.some((tool) => ["worker_send", "worker_followup"].includes(tool.name))
  ) {
    fail("E_LIVE_TOOLS");
  }
  return result.tools;
}

/**
 * Validate one MCP tools/call result, including the exact text mirror and the
 * fixed success/error envelope. The caller supplies exact success payload keys
 * or the expected public error code.
 */
export function validateInstalledToolResult(value, valueExpectations) {
  const result = boundedJson(value, "E_LIVE_TOOL_RESULT");
  const expectations = boundedJson(valueExpectations, "E_LIVE_TOOL_RESULT");
  if (!exactKeys(expectations, new Set(Object.keys(expectations)))
    || Object.keys(expectations).some((key) => !TOOL_RESULT_EXPECTATION_KEYS.has(key))) {
    fail("E_LIVE_TOOL_RESULT");
  }
  const outcome = expectations.outcome;
  const isError = outcome === "error";
  if (
    !["ok", "error"].includes(outcome)
    || !exactKeys(result, isError
      ? new Set(["content", "structuredContent", "isError"])
      : new Set(["content", "structuredContent"]))
    || !Array.isArray(result.content)
    || result.content.length !== 1
    || !exactKeys(result.content[0], new Set(["type", "text"]))
    || result.content[0].type !== "text"
    || !boundedString(result.content[0].text, MAX_JSON_BYTES)
    || !isRecord(result.structuredContent)
    || result.content[0].text !== JSON.stringify(result.structuredContent)
  ) {
    fail("E_LIVE_TOOL_RESULT");
  }
  let parsed;
  try {
    parsed = boundedJson(JSON.parse(result.content[0].text), "E_LIVE_TOOL_RESULT");
  } catch {
    fail("E_LIVE_TOOL_RESULT");
  }
  if (!sameJson(parsed, result.structuredContent)) fail("E_LIVE_TOOL_RESULT");
  if (isError) {
    if (
      result.isError !== true
      || !exactKeys(result.structuredContent, new Set(["ok", "error"]))
      || result.structuredContent.ok !== false
      || !exactKeys(result.structuredContent.error, new Set(["code", "message"]))
      || !boundedString(result.structuredContent.error.code, 128)
      || !/^E_[A-Z0-9_]+$/.test(result.structuredContent.error.code)
      || !boundedString(result.structuredContent.error.message, 8 * 1024)
      || result.structuredContent.error.message.length === 0
      || !boundedString(expectations.expectedErrorCode, 128)
      || result.structuredContent.error.code !== expectations.expectedErrorCode
      || Object.hasOwn(expectations, "expectedPayloadKeys")
    ) {
      fail("E_LIVE_TOOL_RESULT");
    }
  } else {
    const payloadKeys = expectations.expectedPayloadKeys;
    if (
      Object.hasOwn(expectations, "expectedErrorCode")
      || !Array.isArray(payloadKeys)
      || payloadKeys.length < 1
      || payloadKeys.length > 16
      || new Set(payloadKeys).size !== payloadKeys.length
      || payloadKeys.some((key) => (
        !boundedString(key, 128)
        || key === "ok"
        || key === "error"
      ))
      || !exactKeys(result.structuredContent, new Set(["ok", ...payloadKeys]))
      || result.structuredContent.ok !== true
    ) {
      fail("E_LIVE_TOOL_RESULT");
    }
  }
  if (
    Object.hasOwn(expectations, "expectedStructuredContent")
    && !sameJson(result.structuredContent, expectations.expectedStructuredContent)
  ) {
    fail("E_LIVE_TOOL_RESULT");
  }
  assertNoHostVerificationPromotion(result.structuredContent, "E_LIVE_TOOL_RESULT");
  return result.structuredContent;
}

function validSpawnPayload(value, { replayed, state, launched }, code) {
  const worker = value?.worker;
  const validLifecycle = replayed
    ? (
        worker?.status === "running"
        && ACTIVE_REPLAY_PHASES.has(worker?.phase)
        && worker?.terminal === false
        && canonicalIsoTimestamp(worker?.startedAt)
        && worker?.completedAt === null
      )
    : (
        worker?.terminal === false
        && worker?.completedAt === null
        && (
          (
            worker?.status === "queued"
            && ["accepted", "provider-launching"].includes(worker?.phase)
            && worker?.startedAt === null
          )
          || (
            worker?.status === "running"
            && ACTIVE_REPLAY_PHASES.has(worker?.phase)
            && canonicalIsoTimestamp(worker?.startedAt)
          )
        )
      );
  if (
    !exactKeys(value, SPAWN_PAYLOAD_KEYS)
    || value.ok !== true
    || value.replayed !== replayed
    || value.spawnSuccessDefinition !== "durable-job-commit"
    || value.providerLaunchState !== state
    || value.providerLaunched !== launched
    || !isRecord(value.worker)
    || !WORKER_ID.test(value.worker.id || "")
    || value.worker.externalWorkerLabel !== "external-grok-worker"
    || !validLifecycle
  ) {
    fail(code);
  }
}

function validImmutableWorkerIdentity(worker) {
  if (!isRecord(worker)) return false;
  for (const field of IMMUTABLE_WORKER_FIELDS) {
    if (!Object.hasOwn(worker, field) || worker[field] == null) return false;
  }
  for (const field of NULLABLE_STABLE_WORKER_FIELDS) {
    if (!Object.hasOwn(worker, field)) return false;
  }
  return (
    WORKER_ID.test(worker.id)
    && worker.kind === "task"
    && worker.jobClass === "task"
    && worker.write === false
    && WORKER_ID.test(worker.lineageWorkerId)
    && worker.lineageWorkerId === worker.id
    && TASK_ENVELOPE_ID.test(worker.taskEnvelopeId)
    && SHA256_HEX.test(worker.taskEnvelopeDigest)
    && CONTEXT_MANIFEST_ID.test(worker.contextManifestId)
    && SHA256_HEX.test(worker.contextDigest)
    && SHA256_HEX.test(worker.workspaceSnapshotDigest)
    && worker.workspaceSnapshotDigest === worker.contextDigest
    && HOST_TASK_BINDING.test(worker.hostTaskBinding)
    && CONTROL_WORKSPACE_ID.test(worker.controlWorkspaceId)
    && worker.roleId === "explorer"
    && worker.externalWorkerLabel === "external-grok-worker"
    && worker.parentWorkerId === null
  );
}

function assertImmutableWorkerIdentity(workers, code) {
  if (!Array.isArray(workers) || workers.length < 2) fail(code);
  const first = workers[0];
  if (!validImmutableWorkerIdentity(first)) fail(code);
  for (const worker of workers.slice(1)) {
    if (!validImmutableWorkerIdentity(worker)) fail(code);
    for (const field of IMMUTABLE_WORKER_FIELDS) {
      if (!sameJson(first[field], worker[field])) fail(code);
    }
    for (const field of NULLABLE_STABLE_WORKER_FIELDS) {
      if (!sameJson(first[field], worker[field])) fail(code);
    }
  }
}

function validTerminalResult(value, status, code) {
  const expectedPhase = status === "completed" ? "done" : "cancelled";
  if (
    !exactKeys(value, new Set(["ok", "worker"]))
    || value.ok !== true
    || !isRecord(value.worker)
    || !WORKER_ID.test(value.worker.id || "")
    || value.worker.status !== status
    || value.worker.phase !== expectedPhase
    || value.worker.terminal !== true
    || !canonicalIsoTimestamp(value.worker.startedAt)
    || !canonicalIsoTimestamp(value.worker.completedAt)
    || Date.parse(value.worker.completedAt) < Date.parse(value.worker.startedAt)
    || !isRecord(value.worker.result)
    || value.worker.result.hostVerification !== "not_run"
    || value.worker.result.taskRuntimeCleaned !== true
  ) {
    fail(code);
  }
  assertNoHostVerificationPromotion(value.worker, code);
}

/**
 * Validate the public half of the authenticated-completion scenario.
 */
export function validateInstalledCompletionScenario(value) {
  const evidence = boundedJson(value, "E_LIVE_COMPLETION");
  if (!exactKeys(evidence, COMPLETION_BUNDLE_KEYS)) fail("E_LIVE_COMPLETION");
  validSpawnPayload(evidence.spawn, {
    replayed: false,
    state: "pending",
    launched: false
  }, "E_LIVE_COMPLETION");
  validTerminalResult(evidence.terminalResult, "completed", "E_LIVE_COMPLETION");
  assertImmutableWorkerIdentity([
    evidence.spawn.worker,
    evidence.terminalResult.worker
  ], "E_LIVE_COMPLETION");
  return evidence;
}

function validCancellationPayload(value, replayed) {
  if (
    !exactKeys(value, CANCEL_PAYLOAD_KEYS)
    || value.ok !== true
    || value.replayed !== replayed
    || !exactKeys(value.receipt, CANCELLATION_RECEIPT_KEYS)
    || !CANCELLATION_RECEIPT_ID.test(value.receipt.receiptId || "")
    || !WORKER_ID.test(value.receipt.workerId || "")
    || value.receipt.status !== "accepted"
    || !canonicalIsoTimestamp(value.receipt.requestAcceptedAt)
    || value.receipt.processGroupGoneAt !== null
    || value.receipt.terminalRecordCommittedAt !== null
    || !SHA256_HEX.test(value.receipt.idempotencyKeyDigest || "")
    || !Number.isSafeInteger(value.receipt.cancellationRequestSequence)
    || value.receipt.cancellationRequestSequence < 0
  ) {
    fail("E_LIVE_CANCELLATION");
  }
}

/**
 * Validate public replay/cancellation semantics after one MCP server restart.
 * The immutable admission receipt must not acquire later cleanup timestamps.
 */
export function validateInstalledCancellationReplayScenario(value) {
  const evidence = boundedJson(value, "E_LIVE_CANCELLATION");
  if (!exactKeys(evidence, CANCELLATION_BUNDLE_KEYS)) fail("E_LIVE_CANCELLATION");
  validSpawnPayload(evidence.spawn, {
    replayed: false,
    state: "pending",
    launched: false
  }, "E_LIVE_CANCELLATION");
  validSpawnPayload(evidence.spawnReplay, {
    replayed: true,
    state: "started",
    launched: true
  }, "E_LIVE_CANCELLATION");
  validCancellationPayload(evidence.cancel, false);
  validCancellationPayload(evidence.cancelReplay, true);
  validTerminalResult(evidence.terminalResult, "cancelled", "E_LIVE_CANCELLATION");
  if (
    !sameJson(evidence.cancel.receipt, evidence.cancelReplay.receipt)
    || evidence.cancel.receipt.workerId !== evidence.spawn.worker.id
    || evidence.terminalResult.worker.result.stopReason !== "cancelled"
    || !isRecord(evidence.terminalResult.worker.result.cancellation)
    || evidence.terminalResult.worker.result.cancellation.receiptId
      !== evidence.cancel.receipt.receiptId
    || evidence.terminalResult.worker.result.cancellation.requestAcceptedAt
      !== evidence.cancel.receipt.requestAcceptedAt
    || evidence.terminalResult.worker.result.cancellation.processGroupGoneAt !== null
    || evidence.terminalResult.worker.result.cancellation.terminalRecordCommittedAt !== null
    || !Array.isArray(evidence.terminalResult.worker.lifecycleEvents)
  ) {
    fail("E_LIVE_CANCELLATION");
  }
  const cancellationEvents = evidence.terminalResult.worker.lifecycleEvents
    .filter((event) => event?.type === "cancellation.requested");
  if (
    cancellationEvents.length !== 1
    || cancellationEvents[0].sequence
      !== evidence.cancel.receipt.cancellationRequestSequence
  ) {
    fail("E_LIVE_CANCELLATION");
  }
  assertImmutableWorkerIdentity([
    evidence.spawn.worker,
    evidence.spawnReplay.worker,
    evidence.terminalResult.worker
  ], "E_LIVE_CANCELLATION");
  return evidence;
}

function sameNonemptyValues(values, pattern = null) {
  return (
    Array.isArray(values)
    && values.length > 0
    && values.length <= 8
    && values.every((value) => (
      boundedString(value, 256)
      && value.length > 0
      && (pattern === null || pattern.test(value))
      && value === values[0]
    ))
  );
}

/**
 * Validate the pure observation summary derived from private installed state.
 * It has no filesystem, process, provider, or receipt-publication authority.
 */
export function validateInstalledPrivateObservation(value) {
  const observation = boundedJson(value, "E_LIVE_PRIVATE_STATE");
  if (
    !exactKeys(observation, PRIVATE_OBSERVATION_KEYS)
    || !INSTALLED_WORKER_SCENARIO_IDS.includes(observation.scenarioId)
  ) {
    fail("E_LIVE_PRIVATE_STATE");
  }
  const expected = SCENARIO_COUNTS[observation.scenarioId];
  for (const field of COUNT_FIELDS) {
    if (
      !Number.isSafeInteger(observation[field])
      || observation[field] !== expected[field]
    ) {
      fail("E_LIVE_PRIVATE_STATE");
    }
  }
  const minimumObservations = observation.scenarioId === "authenticated-completion" ? 2 : 3;
  if (
    !sameNonemptyValues(observation.observedWorkerIds, WORKER_ID)
    || observation.observedWorkerIds.length < minimumObservations
    || !sameNonemptyValues(observation.observedTaskEnvelopeIds, TASK_ENVELOPE_ID)
    || observation.observedTaskEnvelopeIds.length !== observation.observedWorkerIds.length
    || !sameNonemptyValues(observation.observedContextManifestIds, CONTEXT_MANIFEST_ID)
    || observation.observedContextManifestIds.length !== observation.observedWorkerIds.length
    || !Array.isArray(observation.observedProviderGenerations)
    || observation.observedProviderGenerations.length < 1
    || observation.observedProviderGenerations.length > 8
    || !observation.observedProviderGenerations.every((generation) => generation === 1)
    || !sameNonemptyValues(observation.observedProviderWorkerIds, WORKER_ID)
    || observation.observedProviderWorkerIds.length
      !== observation.observedProviderGenerations.length
    || observation.workerHostVerification !== "not_run"
    || observation.processGroupGone !== true
    || observation.taskRuntimeCleaned !== true
    || observation.providerGuardAbsent !== true
    || observation.runnerTemporaryArtifactsRemoved !== true
    || observation.qualificationSessionDeleted !== true
  ) {
    fail("E_LIVE_PRIVATE_STATE");
  }
  if (observation.scenarioId === "authenticated-completion") {
    if (observation.observedCancellationReceiptIds.length !== 0) {
      fail("E_LIVE_PRIVATE_STATE");
    }
  } else if (
    !sameNonemptyValues(observation.observedCancellationReceiptIds, CANCELLATION_RECEIPT_ID)
    || observation.observedCancellationReceiptIds.length !== 2
    || observation.observedProviderGenerations.length < 2
  ) {
    fail("E_LIVE_PRIVATE_STATE");
  }
  return observation;
}

/**
 * Required final pure cross-check for one fixed installed scenario. Individual
 * public/private validators establish their local shapes; this call binds the
 * private observations to the exact public worker lineage and replay receipt.
 * It validates evidence only and has no live-receipt construction authority.
 */
export function validateInstalledScenarioEvidence(
  valuePublicEvidence,
  valuePrivateObservation
) {
  const observation = validateInstalledPrivateObservation(valuePrivateObservation);
  const publicEvidence = observation.scenarioId === "authenticated-completion"
    ? validateInstalledCompletionScenario(valuePublicEvidence)
    : validateInstalledCancellationReplayScenario(valuePublicEvidence);
  const publicWorkers = observation.scenarioId === "authenticated-completion"
    ? [publicEvidence.spawn.worker, publicEvidence.terminalResult.worker]
    : [
        publicEvidence.spawn.worker,
        publicEvidence.spawnReplay.worker,
        publicEvidence.terminalResult.worker
      ];
  const identity = publicWorkers[0];
  const sameWorker = observation.observedWorkerIds.every((id) => id === identity.id)
    && observation.observedProviderWorkerIds.every((id) => id === identity.id);
  const sameEnvelope = observation.observedTaskEnvelopeIds
    .every((id) => id === identity.taskEnvelopeId);
  const sameContext = observation.observedContextManifestIds
    .every((id) => id === identity.contextManifestId);
  const oneBoundProviderGeneration = (
    observation.providerLaunchCount === 1
    && new Set(observation.observedProviderGenerations).size === 1
    && observation.observedProviderGenerations[0] === 1
    && observation.observedProviderWorkerIds.length
      === observation.observedProviderGenerations.length
  );
  let sameCancellationReceipt = (
    observation.observedCancellationReceiptIds.length === 0
  );
  if (observation.scenarioId === "mcp-restart-reconnect-cancellation") {
    sameCancellationReceipt = observation.observedCancellationReceiptIds
      .every((id) => id === publicEvidence.cancel.receipt.receiptId);
  }
  if (
    !sameWorker
    || !sameEnvelope
    || !sameContext
    || !oneBoundProviderGeneration
    || !sameCancellationReceipt
  ) {
    fail("E_LIVE_PRIVATE_STATE");
  }
  return true;
}
