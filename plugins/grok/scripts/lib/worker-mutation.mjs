/**
 * Phase 1C: idempotent spawn (read-only) and cancel with durable receipts.
 *
 * Ownership freeze (exact-thread):
 * - Ownership is exact Codex threadId equality via job.host.sessionId.
 * - Parent/subagent delegation is only accepted when host-attested metadata is
 *   present on the principal (`parentThreadId` + matching `attestedByHost`).
 * - Caller arguments never establish ancestry.
 *
 * Spawn success = durable job commit (provider launch is a separate step).
 * Cancel metric timestamps are recorded separately (request / process / terminal).
 */
import crypto from "node:crypto";
import path from "node:path";

import { CompanionError } from "./errors.mjs";
import { cleanupTaskRuntimeArtifacts } from "./grok-provider.mjs";
import { sameHostSession } from "./host.mjs";
import {
  generateId,
  isCancelRequested,
  now,
  readPrivateJsonFile,
  requestCancel,
  writePrivateJsonFile,
  ensurePrivateStateDirectory,
  withWorkspaceStateTransaction
} from "./state.mjs";
import {
  appendLifecycleEvent,
  assertContextCompatible,
  assertTaskEnvelope,
  bindTaskEnvelopeContext,
  captureContextManifest,
  composeProviderPrompt,
  scrubStoredJob
} from "./task-contract.mjs";
import {
  CONTEXT_BINDING_MODE,
  assertContextPacket,
  assertContextReceipt,
  buildContextPacket,
  buildContextReceipt,
  resolveJobProviderPrompt,
  verifyJobEffectivePrompt
} from "./worker-context.mjs";
import { projectWorkerHandle, projectWorkerSnapshot } from "./worker-protocol.mjs";
import {
  assertRuntimeRolePolicy,
  buildRuntimeRolePolicy,
  materializeRole,
  assertRoleDigest
} from "./worker-roles.mjs";
import { profileFor, sameSecurityProfile } from "./profiles.mjs";
import { processGroupGone, processStartToken } from "./process-control.mjs";
import {
  assertProviderGuardForJob,
  loadProviderGuard,
  unregisterProviderGuardInWorkspaceTransaction
} from "./recursion-guard.mjs";
import { resolveControlWorkspace, workspaceState } from "./workspace.mjs";
import {
  DEFAULT_DISPATCH_LEASE_MS,
  WORKER_DISPATCH_OUTBOX_SCHEMA_VERSION,
  assertDispatchFence,
  assertDispatchV2,
  assertDispatchV2Structure,
  assertWorkerAuthorization,
  bindWorkerAuthorizationAttempt,
  createDispatchOutbox,
  createWorkerAuthorization,
  dispatchLeaseExpired,
  isDispatchV2,
  isSupportedWorkerDispatch,
  launchContractDigest
} from "./worker-launch-contract.mjs";

export const SPAWN_OWNERSHIP_MODE = "exact-thread-or-host-attested-parent";
export const SPAWN_SUCCESS_DEFINITION = "durable-job-commit";
export const WORKER_DISPATCH_SCHEMA_VERSION = WORKER_DISPATCH_OUTBOX_SCHEMA_VERSION;
export const WORKER_SPAWN_INTENT_SCHEMA_VERSION = 1;
export const RECOVERY_CLEANUP_FENCE_SCHEMA_VERSION = 1;
export const PROVIDER_ROTATION_INTENT_SCHEMA_VERSION = 1;
export const PROVIDER_SPAWN_INTENT_SCHEMA_VERSION = 1;
export const CANCEL_METRIC_TIMESTAMPS = Object.freeze([
  "requestAcceptedAt",
  "processGroupGoneAt",
  "terminalRecordCommittedAt"
]);

function completeOwnedProcessIdentity(identity) {
  return Boolean(
    identity
    && Number.isInteger(identity.pid)
    && identity.pid > 0
    && typeof identity.startToken === "string"
    && identity.startToken.length > 0
    && identity.startToken.length <= 256
    && identity.startToken !== "[REDACTED]"
    && Object.hasOwn(identity, "processGroupId")
    && (process.platform === "win32"
      ? identity.processGroupId === null
      : identity.processGroupId === identity.pid)
  );
}

function currentOwnedProcessIdentity(identity) {
  return completeOwnedProcessIdentity(identity)
    && processStartToken(identity.pid) === identity.startToken;
}

function sameDispatchProcessWitness(left, right, { nonce = false, allowUnsettled = false } = {}) {
  const validWitness = (identity) => Boolean(
    identity
    && Number.isInteger(identity.pid)
    && identity.pid > 0
    && ((allowUnsettled && identity.startToken === null)
      || (typeof identity.startToken === "string"
        && identity.startToken.length > 0
        && identity.startToken.length <= 256
        && identity.startToken !== "[REDACTED]"))
    && Object.hasOwn(identity, "processGroupId")
    && (process.platform === "win32"
      ? identity.processGroupId === null
      : identity.processGroupId === identity.pid)
  );
  return validWitness(left)
    && validWitness(right)
    && left.pid === right.pid
    && left.startToken === right.startToken
    && left.processGroupId === right.processGroupId
    && left.commandMarker === right.commandMarker
    && left.dispatchAttemptId === right.dispatchAttemptId
    && left.dispatchFence === right.dispatchFence
    && left.providerGeneration === right.providerGeneration
    && (!nonce || left.nonce === right.nonce);
}

function sameDispatchProcessIdentity(left, right, { nonce = false } = {}) {
  return sameDispatchProcessWitness(left, right, { nonce, allowUnsettled: false });
}

function assertBoundDispatchProcess(job, dispatch, identity, processKind, {
  allowMissing = false,
  allowUnsettled = false,
  providerGeneration = null
} = {}) {
  if (identity == null) {
    if (allowMissing) return null;
    throw new CompanionError("E_PROCESS_IDENTITY", `Worker dispatch ${processKind} identity is missing.`);
  }
  const startTokenValid = allowUnsettled && identity.startToken === null
    ? true
    : typeof identity.startToken === "string"
      && identity.startToken.length > 0
      && identity.startToken.length <= 256
      && identity.startToken !== "[REDACTED]";
  const bound = isPlainRecord(identity)
    && Number.isInteger(identity.pid)
    && identity.pid > 0
    && startTokenValid
    && Object.hasOwn(identity, "processGroupId")
    && (process.platform === "win32"
      ? identity.processGroupId === null
      : identity.processGroupId === identity.pid)
    && identity.commandMarker === job.id
    && identity.dispatchAttemptId === dispatch.attemptId
    && identity.dispatchFence === dispatch.fence
    && (processKind === "provider"
      ? Number.isSafeInteger(identity.providerGeneration)
        && identity.providerGeneration === providerGeneration
      : typeof identity.nonce === "string" && identity.nonce.length > 0);
  if (!bound) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      `Worker dispatch ${processKind} identity is not bound to the active attempt and fence.`
    );
  }
  return identity;
}

function assertBoundSpawnIntent(job, dispatch, field, processKind, { allowMissing = false } = {}) {
  const intent = job?.request?.spawn?.[field];
  if (intent == null) {
    if (allowMissing) return null;
    throw new CompanionError("E_PROCESS_IDENTITY", `Worker dispatch ${processKind} spawn intent is missing.`);
  }
  const bound = isPlainRecord(intent)
    && intent.schemaVersion === WORKER_SPAWN_INTENT_SCHEMA_VERSION
    && intent.processKind === processKind
    && /^[0-9a-f]{32}$/.test(intent.intentId || "")
    && intent.attemptId === dispatch.attemptId
    && intent.fence === dispatch.fence
    && ["pending", "registered", "no-child"].includes(intent.status);
  if (!bound) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      `Worker dispatch ${processKind} spawn intent is not bound to the active attempt and fence.`
    );
  }
  return intent;
}

const RECOVERY_CLEANUP_FENCE_KEYS = new Set([
  "schemaVersion",
  "fenceId",
  "authority",
  "source",
  "mode",
  "processKind",
  "dispatchState",
  "attemptId",
  "dispatchFence",
  "processIdentity",
  "claimedAt"
]);
const PROVIDER_ROTATION_INTENT_KEYS = new Set([
  "schemaVersion",
  "intentId",
  "attemptId",
  "dispatchFence",
  "baseProviderGeneration",
  "targetProviderGeneration",
  "status",
  "preparedAt",
  "updatedAt",
  "registeredAt",
  "noChildAt",
  "resolution"
]);
const PROVIDER_SPAWN_INTENT_KEYS = new Set([
  "schemaVersion",
  "intentId",
  "attemptId",
  "dispatchFence",
  "providerGeneration",
  "status",
  "preparedAt",
  "updatedAt",
  "registeredAt",
  "noChildAt",
  "resolution"
]);

function assertProviderSpawnIntentContract(job, dispatch, { allowMissing = true } = {}) {
  const intent = job?.request?.spawn?.providerSpawnIntent;
  if (intent == null) {
    if (allowMissing) return null;
    throw new CompanionError("E_PROCESS_IDENTITY", "Provider spawn intent is missing.");
  }
  const exact = isPlainRecord(intent)
    && Object.keys(intent).length === PROVIDER_SPAWN_INTENT_KEYS.size
    && Object.keys(intent).every((key) => PROVIDER_SPAWN_INTENT_KEYS.has(key))
    && intent.schemaVersion === PROVIDER_SPAWN_INTENT_SCHEMA_VERSION
    && /^[0-9a-f]{32}$/.test(intent.intentId || "")
    && intent.attemptId === dispatch.attemptId
    && intent.dispatchFence === dispatch.fence
    && Number.isSafeInteger(intent.providerGeneration)
    && intent.providerGeneration >= 1
    && intent.providerGeneration <= 2
    && ["pending", "registered", "no-child"].includes(intent.status)
    && validIsoTimestamp(intent.preparedAt)
    && validIsoTimestamp(intent.updatedAt)
    && (intent.registeredAt === null || validIsoTimestamp(intent.registeredAt))
    && (intent.noChildAt === null || validIsoTimestamp(intent.noChildAt))
    && (intent.resolution === null
      || ["spawn-not-created", "cleanup-proven", "authorization-revoked"].includes(intent.resolution));
  if (!exact) {
    throw new CompanionError("E_STATE", "Provider spawn intent is malformed or not dispatch-bound.");
  }
  const active = intent.status === "pending"
    ? intent.registeredAt === null && intent.noChildAt === null && intent.resolution === null
    : intent.status === "registered"
      ? validIsoTimestamp(intent.registeredAt) && intent.noChildAt === null && intent.resolution === null
      : false;
  const noChild = intent.status === "no-child"
    && (intent.registeredAt === null || validIsoTimestamp(intent.registeredAt))
    && validIsoTimestamp(intent.noChildAt)
    && intent.resolution !== null;
  if (!active && !noChild) {
    throw new CompanionError("E_STATE", "Provider spawn intent status fields are inconsistent.");
  }
  const initial = intent.providerGeneration === 1
    && dispatch.providerGeneration === (dispatch.state === "provider-started" ? 1 : 0)
    && dispatch.nextProviderGeneration == null;
  const rotation = intent.providerGeneration === 2
    && (
      (dispatch.providerGeneration === 1 && dispatch.nextProviderGeneration === 2)
      || (dispatch.nextProviderGeneration == null
        && ((intent.status === "registered" && dispatch.providerGeneration === 2)
          || (intent.status === "no-child" && dispatch.providerGeneration === 1)))
    );
  if (!initial && !rotation) {
    throw new CompanionError("E_STATE", "Provider spawn intent disagrees with the durable generation.");
  }
  return intent;
}

function assertProviderRotationIntentContract(job, dispatch) {
  const intent = job?.request?.spawn?.providerRotationIntent;
  if (intent == null) return null;
  const exact = isPlainRecord(intent)
    && Object.keys(intent).length === PROVIDER_ROTATION_INTENT_KEYS.size
    && Object.keys(intent).every((key) => PROVIDER_ROTATION_INTENT_KEYS.has(key))
    && intent.schemaVersion === PROVIDER_ROTATION_INTENT_SCHEMA_VERSION
    && /^[0-9a-f]{32}$/.test(intent.intentId || "")
    && intent.attemptId === dispatch.attemptId
    && intent.dispatchFence === dispatch.fence
    && intent.baseProviderGeneration === 1
    && intent.targetProviderGeneration === 2
    && ["pending", "registered", "no-child"].includes(intent.status)
    && validIsoTimestamp(intent.preparedAt)
    && validIsoTimestamp(intent.updatedAt)
    && (intent.registeredAt === null || validIsoTimestamp(intent.registeredAt))
    && (intent.noChildAt === null || validIsoTimestamp(intent.noChildAt))
    && (intent.resolution === null
      || ["spawn-not-created", "cleanup-proven", "authorization-revoked"].includes(intent.resolution));
  if (!exact) {
    throw new CompanionError("E_STATE", "Provider rotation intent is malformed or not attempt-bound.");
  }
  const pending = intent.status === "pending"
    && dispatch.state === "provider-started"
    && dispatch.providerGeneration === intent.baseProviderGeneration
    && dispatch.nextProviderGeneration === intent.targetProviderGeneration
    && intent.registeredAt === null
    && intent.noChildAt === null
    && intent.resolution === null;
  const registered = intent.status === "registered"
    && ["provider-started", "failed"].includes(dispatch.state)
    && dispatch.providerGeneration === intent.targetProviderGeneration
    && dispatch.nextProviderGeneration === null
    && validIsoTimestamp(intent.registeredAt)
    && intent.noChildAt === null
    && intent.resolution === null;
  const noChild = intent.status === "no-child"
    && dispatch.providerGeneration === intent.baseProviderGeneration
    && dispatch.nextProviderGeneration === null
    && (intent.registeredAt === null || validIsoTimestamp(intent.registeredAt))
    && validIsoTimestamp(intent.noChildAt)
    && ["spawn-not-created", "cleanup-proven", "authorization-revoked"].includes(intent.resolution);
  if (!pending && !registered && !noChild) {
    throw new CompanionError("E_STATE", "Provider rotation intent disagrees with the durable provider generation.");
  }
  return intent;
}

function recoveryCleanupSource(job, source) {
  if (source === "controller-cleanup") {
    return {
      processKind: "controller",
      identity: job?.request?.spawn?.controllerCleanupProcess || null,
      nonce: true
    };
  }
  if (source === "unsettled-worker") {
    return {
      processKind: "worker",
      identity: job?.request?.spawn?.unsettledWorkerProcess || null,
      nonce: true
    };
  }
  if (source === "provider-generation") {
    return {
      processKind: "provider",
      identity: job?.providerProcess || null,
      nonce: false
    };
  }
  return null;
}

function assertRecoveryCleanupFenceContract(job, dispatch) {
  const cleanupFence = job?.request?.spawn?.cleanupFence;
  if (cleanupFence == null) return null;
  const source = recoveryCleanupSource(job, cleanupFence.source);
  const exact = isPlainRecord(cleanupFence)
    && Object.keys(cleanupFence).length === RECOVERY_CLEANUP_FENCE_KEYS.size
    && Object.keys(cleanupFence).every((key) => RECOVERY_CLEANUP_FENCE_KEYS.has(key))
    && cleanupFence.schemaVersion === RECOVERY_CLEANUP_FENCE_SCHEMA_VERSION
    && /^[0-9a-f]{32}$/.test(cleanupFence.fenceId || "")
    && cleanupFence.authority === "host-trusted-reconciler"
    && source
    && cleanupFence.processKind === source.processKind
    && cleanupFence.dispatchState === dispatch.state
    && cleanupFence.attemptId === dispatch.attemptId
    && cleanupFence.dispatchFence === dispatch.fence
    && validIsoTimestamp(cleanupFence.claimedAt)
    && ["signal", "observe-only"].includes(cleanupFence.mode)
    && cleanupFence.mode === (cleanupFence.processIdentity?.startToken === null
      ? "observe-only"
      : "signal")
    && sameDispatchProcessWitness(source.identity, cleanupFence.processIdentity, {
      nonce: source.nonce,
      allowUnsettled: true
    })
    && (cleanupFence.source !== "provider-generation" || dispatch.nextProviderGeneration == null);
  if (!exact) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Recovery cleanup fence is malformed or no longer matches the durable process generation."
    );
  }
  return cleanupFence;
}

function assertDispatchLifecycleContract(job, dispatch) {
  const state = dispatch.state;
  assertRecoveryCleanupFenceContract(job, dispatch);
  const providerRotationIntent = assertProviderRotationIntentContract(job, dispatch);
  const providerSpawnIntent = assertProviderSpawnIntentContract(job, dispatch);
  const controllerRequired = ["controller-started", "worker-started", "provider-started"].includes(state);
  const workerRequired = ["worker-started", "provider-started"].includes(state);
  const providerRequired = state === "provider-started";
  const controller = assertBoundDispatchProcess(job, dispatch, job.controllerProcess, "controller", {
    allowMissing: !controllerRequired
  });
  const worker = assertBoundDispatchProcess(job, dispatch, job.workerProcess, "worker", {
    allowMissing: !workerRequired
  });
  if (["pending", "claimed"].includes(state) && (controller || worker || job.providerProcess != null)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Pre-controller dispatch retains an impossible process witness.");
  }
  if (state === "controller-started" && (worker || job.providerProcess != null)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Controller-started dispatch retains a premature process witness.");
  }

  const unsettledProvider = Boolean(dispatch.providerLaunchUnsettledAt)
    && ["worker-started", "failed"].includes(state);
  const expectedProviderGeneration = state === "worker-started"
    ? dispatch.providerGeneration + 1
    : dispatch.providerGeneration;
  const provider = assertBoundDispatchProcess(job, dispatch, job.providerProcess, "provider", {
    allowMissing: !providerRequired && !unsettledProvider,
    allowUnsettled: unsettledProvider,
    providerGeneration: expectedProviderGeneration
  });

  const controllerIntent = assertBoundSpawnIntent(
    job,
    dispatch,
    "controllerSpawnIntent",
    "controller",
    { allowMissing: ["pending", "claimed", "failed"].includes(state) }
  );
  const workerIntent = assertBoundSpawnIntent(
    job,
    dispatch,
    "workerSpawnIntent",
    "worker",
    { allowMissing: ["pending", "claimed", "controller-started", "failed"].includes(state) }
  );
  if (state === "pending" && (controllerIntent || workerIntent)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Pending dispatch cannot retain a process spawn intent.");
  }
  if (state === "claimed"
    && (controllerIntent?.status === "registered" || workerIntent != null)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Claimed dispatch retains an impossible registered process intent.");
  }
  if (state === "controller-started" && workerIntent?.status === "registered") {
    throw new CompanionError("E_PROCESS_IDENTITY", "Controller-started dispatch retains a registered worker without its process.");
  }
  if (controllerRequired && controllerIntent?.status !== "registered") {
    throw new CompanionError("E_PROCESS_IDENTITY", "Controller process is not paired with a registered spawn intent.");
  }
  if (workerRequired && workerIntent?.status !== "registered") {
    throw new CompanionError("E_PROCESS_IDENTITY", "Worker process is not paired with a registered spawn intent.");
  }
  if (state === "provider-started"
    && providerSpawnIntent?.providerGeneration === dispatch.providerGeneration
    && providerSpawnIntent.status !== "registered") {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Durable provider identity is not paired with its registered spawn intent."
    );
  }
  if (providerRotationIntent) {
    const matchingStatus = providerRotationIntent.status === "pending"
      ? ["pending", "registered"].includes(providerSpawnIntent?.status)
      : providerSpawnIntent?.status === providerRotationIntent.status;
    const matchingSettlement = providerRotationIntent.status === "pending"
      || (
        providerSpawnIntent?.registeredAt === providerRotationIntent.registeredAt
        && providerSpawnIntent?.noChildAt === providerRotationIntent.noChildAt
        && providerSpawnIntent?.resolution === providerRotationIntent.resolution
      );
    if (!providerSpawnIntent
      || providerSpawnIntent.intentId !== providerRotationIntent.intentId
      || providerSpawnIntent.providerGeneration !== providerRotationIntent.targetProviderGeneration
      || !matchingStatus
      || !matchingSettlement) {
      throw new CompanionError(
        "E_STATE",
        "Provider rotation and spawn intents do not describe one exact launch boundary."
      );
    }
  }

  const unsettledWorker = job?.request?.spawn?.unsettledWorkerProcess;
  if (unsettledWorker != null) {
    if (state !== "controller-started" || !dispatch.workerLaunchUnsettledAt || job.workerProcess != null) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Unsettled worker witness is inconsistent with dispatch state.");
    }
    if (!workerIntent || workerIntent.status === "registered") {
      throw new CompanionError("E_PROCESS_IDENTITY", "Unsettled worker witness is missing its unresolved spawn intent.");
    }
    assertBoundDispatchProcess(job, dispatch, unsettledWorker, "worker", { allowUnsettled: true });
    if (unsettledWorker.nonce !== (controller?.nonce || job?.workerAuthorization?.nonce)) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Unsettled worker witness does not share the active launch nonce.");
    }
  }
  const controllerCleanup = job?.request?.spawn?.controllerCleanupProcess;
  if (controllerCleanup != null) {
    if (!["claimed", "controller-started", "failed"].includes(state)
      || job?.request?.spawn?.controllerCleanupPending !== true
      || !controllerIntent) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Controller cleanup witness is inconsistent with dispatch state.");
    }
    assertBoundDispatchProcess(job, dispatch, controllerCleanup, "controller", { allowUnsettled: true });
    if (controllerCleanup.nonce !== (controller?.nonce || job?.workerAuthorization?.nonce)) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Controller cleanup witness does not share the active launch nonce.");
    }
  }

  if (controller && worker && controller.nonce !== worker.nonce) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Controller and worker witnesses do not share one launch nonce.");
  }
  if (worker && !controller) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Worker process witness is missing its controller lineage.");
  }
  if (provider && (!controller || !worker)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Provider process witness is missing its controller/worker lineage.");
  }
  const authorizationNonce = job?.workerAuthorization?.nonce;
  if (authorizationNonce
    && ((controller && controller.nonce !== authorizationNonce)
      || (worker && worker.nonce !== authorizationNonce))) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Process witness nonce does not match launch authorization.");
  }
  return job;
}

// Cancellation recovery is stored next to the job so a crash between the job
// update and adjacent idempotency-file publication remains recoverable. Keep
// the history bounded without pruning: once full, a new key fails closed while
// every already-admitted key remains replayable.
const MAX_CANCELLATION_RECOVERY_RECORDS = 32;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const CONTROL_WORKSPACE_ID = /^cws-[0-9a-f]{32}$/;
const LEGACY_SPAWN_IDEMPOTENCY_SCHEMA_VERSION = 3;
const SPAWN_IDEMPOTENCY_SCHEMA_VERSION = 4;
const SPAWN_RESPONSE_WITNESS_SCHEMA_VERSION = 1;
const SPAWN_RESPONSE_WITNESS_PROJECTION = "worker-handle-v1-untrusted-host";
const SPAWN_RESPONSE_WITNESS_ID = /^spawnw-[0-9a-f]{24}$/;
const LEGACY_SPAWN_IDEMPOTENCY_KEYS = new Set([
  "schemaVersion",
  "workerId",
  "owner",
  "controlWorkspaceId",
  "executionRoot",
  "requestDigest",
  "launchContractDigest",
  "idempotencyKeyDigest",
  "committedAt"
]);
const SPAWN_IDEMPOTENCY_KEYS = new Set([
  ...LEGACY_SPAWN_IDEMPOTENCY_KEYS,
  "responseWitness"
]);
const SPAWN_IDEMPOTENCY_OWNER_KEYS = new Set(["hostKind", "sessionId"]);
const SPAWN_RESPONSE_WITNESS_KEYS = new Set([
  "schemaVersion",
  "witnessId",
  "projection",
  "responseSequence",
  "workerId",
  "requestDigest",
  "idempotencyKeyDigest",
  "replayed",
  "handleDigest",
  "eventCursorSequence",
  "recordedAt"
]);
const CANCELLATION_RECEIPT_STATUSES = new Set([
  "accepted",
  "already_cancelled",
  "already_terminal"
]);

function digestKey(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function canonicalize(value, stack = new Set()) {
  if (value === null || typeof value !== "object") return value;
  if (stack.has(value)) {
    throw new CompanionError("E_USAGE", "Mutation request must not contain cyclic data.");
  }
  stack.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => canonicalize(item, stack));
  } else {
    result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = canonicalize(value[key], stack);
    }
  }
  stack.delete(value);
  return result;
}

function stableDigest(value) {
  return digestKey(JSON.stringify(canonicalize(value)));
}

function isPlainRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function runSuccessfulRuntimeCleanup(runtimeCleanup, job) {
  const cleanup = typeof runtimeCleanup === "function"
    ? runtimeCleanup(job)
    : runtimeCleanup;
  if (!isPlainRecord(cleanup) || typeof cleanup.ok !== "boolean") {
    throw new CompanionError("E_STATE", "Runtime cleanup did not return a durable cleanup outcome.");
  }
  if (!cleanup.ok) {
    throw new CompanionError(
      "E_RUNTIME_CLEANUP",
      "Runtime cleanup remained incomplete; terminal publication is blocked.",
      { warning: cleanup.warning || "Runtime cleanup remained incomplete." }
    );
  }
  return cleanup;
}

function cancellationStateError(message) {
  throw new CompanionError("E_STATE", message);
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) cancellationStateError(`${label} contains an unsupported field.`);
  }
}

function normalizeCancellationReceipt(receipt, { workerId, keyDigest }) {
  if (!isPlainRecord(receipt)) cancellationStateError("Cancellation recovery receipt is malformed.");
  assertExactKeys(receipt, new Set([
    "receiptId",
    "workerId",
    "status",
    "requestAcceptedAt",
    "processGroupGoneAt",
    "terminalRecordCommittedAt",
    "idempotencyKeyDigest",
    "cancellationRequestSequence"
  ]), "Cancellation recovery receipt");
  if (typeof receipt.receiptId !== "string" || receipt.receiptId.length > 256) {
    cancellationStateError("Cancellation recovery receipt identity is malformed.");
  }
  if (receipt.workerId !== workerId || receipt.idempotencyKeyDigest !== keyDigest) {
    cancellationStateError("Cancellation recovery receipt binding is malformed.");
  }
  if (!CANCELLATION_RECEIPT_STATUSES.has(receipt.status)) {
    cancellationStateError("Cancellation recovery receipt status is malformed.");
  }
  if (typeof receipt.requestAcceptedAt !== "string") {
    cancellationStateError("Cancellation recovery receipt timestamp is malformed.");
  }
  for (const field of ["processGroupGoneAt", "terminalRecordCommittedAt"]) {
    if (receipt[field] !== null && typeof receipt[field] !== "string") {
      cancellationStateError("Cancellation recovery receipt timestamp is malformed.");
    }
  }
  if (
    receipt.cancellationRequestSequence !== null
    && (!Number.isSafeInteger(receipt.cancellationRequestSequence)
      || receipt.cancellationRequestSequence < 0)
  ) {
    cancellationStateError("Cancellation recovery receipt sequence is malformed.");
  }
  return Object.freeze({
    receiptId: receipt.receiptId,
    workerId,
    status: receipt.status,
    requestAcceptedAt: receipt.requestAcceptedAt,
    processGroupGoneAt: receipt.processGroupGoneAt,
    terminalRecordCommittedAt: receipt.terminalRecordCommittedAt,
    idempotencyKeyDigest: keyDigest,
    cancellationRequestSequence: receipt.cancellationRequestSequence
  });
}

function normalizeCancellationRecoveryRecord(record, { jobId, keyDigest }) {
  if (!isPlainRecord(record)) cancellationStateError("Cancellation recovery record is malformed.");
  assertExactKeys(record, new Set([
    "schemaVersion",
    "workerId",
    "ownerThreadId",
    "requestDigest",
    "idempotencyKeyDigest",
    "receipt",
    "committedAt"
  ]), "Cancellation recovery record");
  if (
    record.schemaVersion !== 1
    || record.workerId !== jobId
    || typeof record.ownerThreadId !== "string"
    || !SHA256_HEX.test(record.requestDigest || "")
    || record.idempotencyKeyDigest !== keyDigest
    || typeof record.committedAt !== "string"
  ) {
    cancellationStateError("Cancellation recovery record binding is malformed.");
  }
  const expectedRequestDigest = stableDigest({
    ownerThreadId: record.ownerThreadId,
    workerId: jobId
  });
  const expectedReceiptId = `cancel-${digestKey(`${record.ownerThreadId}:${jobId}:${keyDigest}`).slice(0, 24)}`;
  if (record.requestDigest !== expectedRequestDigest) {
    cancellationStateError("Cancellation recovery request digest is malformed.");
  }
  const receipt = normalizeCancellationReceipt(record.receipt, { workerId: jobId, keyDigest });
  if (receipt.receiptId !== expectedReceiptId || record.committedAt !== receipt.requestAcceptedAt) {
    cancellationStateError("Cancellation recovery receipt identity is malformed.");
  }
  return Object.freeze({
    schemaVersion: 1,
    workerId: jobId,
    ownerThreadId: record.ownerThreadId,
    requestDigest: record.requestDigest,
    idempotencyKeyDigest: keyDigest,
    receipt,
    committedAt: record.committedAt
  });
}

function cancellationHistory(job) {
  const history = job?.result?.cancellationReceiptsByKey;
  if (history === undefined) return {};
  if (!isPlainRecord(history)) cancellationStateError("Cancellation recovery history is malformed.");
  const keys = Object.keys(history);
  if (keys.length > MAX_CANCELLATION_RECOVERY_RECORDS || keys.some((key) => !SHA256_HEX.test(key))) {
    cancellationStateError("Cancellation recovery history exceeds its durable bound or is malformed.");
  }
  return history;
}

function legacyCancellationRecoveryRecord(job, keyDigest) {
  const cancellation = job?.result?.cancellation;
  if (!isPlainRecord(cancellation) || cancellation.idempotencyKeyDigest !== keyDigest) return null;
  const record = {
    schemaVersion: 1,
    workerId: job.id,
    ownerThreadId: cancellation.ownerThreadId,
    requestDigest: cancellation.requestDigest,
    idempotencyKeyDigest: keyDigest,
    receipt: {
      receiptId: cancellation.receiptId,
      workerId: job.id,
      status: cancellation.status,
      requestAcceptedAt: cancellation.requestAcceptedAt,
      processGroupGoneAt: cancellation.processGroupGoneAt ?? null,
      terminalRecordCommittedAt: cancellation.terminalRecordCommittedAt ?? null,
      idempotencyKeyDigest: keyDigest,
      cancellationRequestSequence: cancellation.cancellationRequestSequence ?? null
    },
    committedAt: cancellation.requestAcceptedAt
  };
  return normalizeCancellationRecoveryRecord(record, { jobId: job.id, keyDigest });
}

function cancellationRecoveryRecordForKey(job, keyDigest) {
  const history = cancellationHistory(job);
  const durable = Object.hasOwn(history, keyDigest)
    ? normalizeCancellationRecoveryRecord(history[keyDigest], { jobId: job.id, keyDigest })
    : null;
  const legacy = legacyCancellationRecoveryRecord(job, keyDigest);
  if (durable && legacy && (
    durable.ownerThreadId !== legacy.ownerThreadId
    || durable.requestDigest !== legacy.requestDigest
  )) {
    cancellationStateError("Cancellation recovery records disagree on request ownership.");
  }
  return durable || legacy;
}

function appendCancellationRecoveryRecord(job, record) {
  const current = cancellationHistory(job);
  const next = {};
  for (const [keyDigest, candidate] of Object.entries(current)) {
    next[keyDigest] = normalizeCancellationRecoveryRecord(candidate, {
      jobId: job.id,
      keyDigest
    });
  }

  // Preserve the pre-history single-record layout when it contains the exact
  // binding fields introduced by the crash-recovery contract. Ambiguous older
  // records fail closed instead of being silently overwritten.
  const legacy = job?.result?.cancellation;
  if (isPlainRecord(legacy)) {
    if (!SHA256_HEX.test(legacy.idempotencyKeyDigest || "")) {
      cancellationStateError("Legacy cancellation recovery identity cannot be preserved safely.");
    }
    const legacyRecord = legacyCancellationRecoveryRecord(job, legacy.idempotencyKeyDigest);
    if (!Object.hasOwn(next, legacy.idempotencyKeyDigest)) {
      if (Object.keys(next).length >= MAX_CANCELLATION_RECOVERY_RECORDS) {
        cancellationStateError("Cancellation recovery history limit reached; existing receipts were preserved.");
      }
      next[legacy.idempotencyKeyDigest] = legacyRecord;
    }
  }

  if (Object.hasOwn(next, record.idempotencyKeyDigest)) {
    cancellationStateError("Cancellation recovery key was already committed.");
  }
  if (Object.keys(next).length >= MAX_CANCELLATION_RECOVERY_RECORDS) {
    cancellationStateError("Cancellation recovery history limit reached; existing receipts were preserved.");
  }
  next[record.idempotencyKeyDigest] = normalizeCancellationRecoveryRecord(record, {
    jobId: job.id,
    keyDigest: record.idempotencyKeyDigest
  });
  return next;
}

function idempotencyConflict(message) {
  throw new CompanionError("E_IDEMPOTENCY_CONFLICT", message);
}

function assertIdempotencyKey(key) {
  if (typeof key !== "string" || key.length < 8 || key.length > 256) {
    throw new CompanionError("E_USAGE", "idempotencyKey must be a string of length 8–256.");
  }
  if (/[\r\n\0]/.test(key)) {
    throw new CompanionError("E_USAGE", "idempotencyKey must not contain control characters.");
  }
  return key;
}

function idempotencyPath(root, kind, keyDigest, env = process.env) {
  // Same control-workspace state store as jobs (shared across linked worktrees).
  const dir = ensurePrivateStateDirectory(root, ["idempotency", kind], env);
  return path.join(dir, `${keyDigest}.json`);
}

function readIdempotency(root, kind, key, env = process.env) {
  const file = idempotencyPath(root, kind, digestKey(key), env);
  return readPrivateJsonFile(file, {
    missing: null,
    label: `idempotency record for ${kind}`
  });
}

function writeIdempotency(root, kind, key, record, env = process.env) {
  const file = idempotencyPath(root, kind, digestKey(key), env);
  return writePrivateJsonFile(file, record);
}

function spawnIdempotencyStateError(message) {
  throw new CompanionError("E_STATE", message);
}

function spawnResponseWitnessBody(witness) {
  return {
    schemaVersion: witness.schemaVersion,
    projection: witness.projection,
    responseSequence: witness.responseSequence,
    workerId: witness.workerId,
    requestDigest: witness.requestDigest,
    idempotencyKeyDigest: witness.idempotencyKeyDigest,
    replayed: witness.replayed,
    handleDigest: witness.handleDigest,
    eventCursorSequence: witness.eventCursorSequence,
    recordedAt: witness.recordedAt
  };
}

function normalizeSpawnResponseWitness(witness, { record, keyDigest }) {
  if (!isPlainRecord(witness)
    || Object.keys(witness).length !== SPAWN_RESPONSE_WITNESS_KEYS.size
    || Object.keys(witness).some((key) => !SPAWN_RESPONSE_WITNESS_KEYS.has(key))) {
    spawnIdempotencyStateError("Spawn response witness is malformed.");
  }
  if (witness.schemaVersion !== SPAWN_RESPONSE_WITNESS_SCHEMA_VERSION
    || !SPAWN_RESPONSE_WITNESS_ID.test(witness.witnessId || "")
    || witness.projection !== SPAWN_RESPONSE_WITNESS_PROJECTION
    || !Number.isSafeInteger(witness.responseSequence)
    || witness.responseSequence < 1
    || witness.workerId !== record.workerId
    || witness.requestDigest !== record.requestDigest
    || witness.idempotencyKeyDigest !== record.idempotencyKeyDigest
    || witness.idempotencyKeyDigest !== keyDigest
    || typeof witness.replayed !== "boolean"
    || !SHA256_HEX.test(witness.handleDigest || "")
    || !Number.isSafeInteger(witness.eventCursorSequence)
    || witness.eventCursorSequence < 0
    || !validIsoTimestamp(witness.recordedAt)
    || Date.parse(witness.recordedAt) < Date.parse(record.committedAt)
    || (witness.responseSequence > 1 && witness.replayed !== true)) {
    spawnIdempotencyStateError("Spawn response witness binding is malformed.");
  }
  const expectedWitnessId = `spawnw-${stableDigest(spawnResponseWitnessBody(witness)).slice(0, 24)}`;
  if (witness.witnessId !== expectedWitnessId) {
    spawnIdempotencyStateError("Spawn response witness identity is malformed.");
  }
  return Object.freeze({
    witnessId: witness.witnessId,
    ...spawnResponseWitnessBody(witness)
  });
}

function normalizeSpawnIdempotencyRecord(record, { keyDigest }) {
  if (!isPlainRecord(record)) {
    spawnIdempotencyStateError("Spawn idempotency record is malformed.");
  }
  const expectedKeys = record.schemaVersion === LEGACY_SPAWN_IDEMPOTENCY_SCHEMA_VERSION
    ? LEGACY_SPAWN_IDEMPOTENCY_KEYS
    : record.schemaVersion === SPAWN_IDEMPOTENCY_SCHEMA_VERSION
      ? SPAWN_IDEMPOTENCY_KEYS
      : null;
  if (!expectedKeys
    || Object.keys(record).length !== expectedKeys.size
    || Object.keys(record).some((key) => !expectedKeys.has(key))) {
    spawnIdempotencyStateError("Spawn idempotency record is malformed.");
  }
  if (!isPlainRecord(record.owner)
    || Object.keys(record.owner).length !== SPAWN_IDEMPOTENCY_OWNER_KEYS.size
    || Object.keys(record.owner).some((key) => !SPAWN_IDEMPOTENCY_OWNER_KEYS.has(key))) {
    spawnIdempotencyStateError("Spawn idempotency owner binding is malformed.");
  }
  if (typeof record.workerId !== "string"
    || !record.workerId
    || record.workerId.length > 256
    || typeof record.owner.hostKind !== "string"
    || !record.owner.hostKind
    || record.owner.hostKind.length > 64
    || typeof record.owner.sessionId !== "string"
    || !record.owner.sessionId
    || record.owner.sessionId.length > 256
    || !CONTROL_WORKSPACE_ID.test(record.controlWorkspaceId || "")
    || typeof record.executionRoot !== "string"
    || !path.isAbsolute(record.executionRoot)
    || path.normalize(record.executionRoot) !== record.executionRoot
    || record.executionRoot.length > 4096
    || !SHA256_HEX.test(record.requestDigest || "")
    || !SHA256_HEX.test(record.launchContractDigest || "")
    || record.idempotencyKeyDigest !== keyDigest
    || !validIsoTimestamp(record.committedAt)) {
    spawnIdempotencyStateError("Spawn idempotency binding is malformed.");
  }
  if (record.schemaVersion === SPAWN_IDEMPOTENCY_SCHEMA_VERSION) {
    return Object.freeze({
      ...record,
      owner: Object.freeze({ ...record.owner }),
      responseWitness: normalizeSpawnResponseWitness(record.responseWitness, {
        record,
        keyDigest
      })
    });
  }
  return Object.freeze({
    ...record,
    owner: Object.freeze({ ...record.owner })
  });
}

function spawnRequestOwner(principal) {
  return {
    hostKind: principal?.hostKind || "codex",
    sessionId: principal?.threadId || null
  };
}

function buildSpawnResponseWitness({
  job,
  keyDigest,
  replayed,
  responseSequence,
  recordedAt = now()
}) {
  const handle = projectWorkerHandle(job, { trustHostAuthority: false });
  const eventCursorSequence = handle?.eventCursor?.sequence;
  if (!Number.isSafeInteger(eventCursorSequence) || eventCursorSequence < 0) {
    spawnIdempotencyStateError("Spawn response handle cursor is malformed.");
  }
  const body = {
    schemaVersion: SPAWN_RESPONSE_WITNESS_SCHEMA_VERSION,
    projection: SPAWN_RESPONSE_WITNESS_PROJECTION,
    responseSequence,
    workerId: job.id,
    requestDigest: job.request?.spawn?.requestDigest,
    idempotencyKeyDigest: keyDigest,
    replayed,
    handleDigest: stableDigest(handle),
    eventCursorSequence,
    recordedAt
  };
  return {
    handle,
    responseWitness: {
      schemaVersion: body.schemaVersion,
      witnessId: `spawnw-${stableDigest(body).slice(0, 24)}`,
      projection: body.projection,
      responseSequence: body.responseSequence,
      workerId: body.workerId,
      requestDigest: body.requestDigest,
      idempotencyKeyDigest: body.idempotencyKeyDigest,
      replayed: body.replayed,
      handleDigest: body.handleDigest,
      eventCursorSequence: body.eventCursorSequence,
      recordedAt: body.recordedAt
    }
  };
}

function buildSpawnIdempotencyRecord({ job, keyDigest, responseWitness }) {
  return {
    schemaVersion: SPAWN_IDEMPOTENCY_SCHEMA_VERSION,
    workerId: job.id,
    owner: {
      hostKind: job.host.kind,
      sessionId: job.host.sessionId
    },
    controlWorkspaceId: job.controlWorkspaceId,
    executionRoot: job.request.spawn.executionRoot,
    requestDigest: job.request.spawn.requestDigest,
    launchContractDigest: launchContractDigest(job),
    idempotencyKeyDigest: keyDigest,
    committedAt: job.createdAt,
    responseWitness
  };
}

function assertSpawnIdempotencyJobBinding(record, job, { keyDigest, responseHandle = null }) {
  if (!job
    || record.workerId !== job.id
    || record.owner.hostKind !== job.host?.kind
    || record.owner.sessionId !== job.host?.sessionId
    || record.controlWorkspaceId !== job.controlWorkspaceId
    || record.executionRoot !== job.request?.spawn?.executionRoot
    || record.requestDigest !== job.request?.spawn?.requestDigest
    || record.launchContractDigest !== launchContractDigest(job)
    || record.idempotencyKeyDigest !== job.request?.spawn?.idempotencyKeyDigest
    || record.idempotencyKeyDigest !== keyDigest
    || record.committedAt !== job.createdAt) {
    spawnIdempotencyStateError("Spawn idempotency record disagrees with its durable job.");
  }
  if (record.schemaVersion === SPAWN_IDEMPOTENCY_SCHEMA_VERSION) {
    const witness = normalizeSpawnResponseWitness(record.responseWitness, { record, keyDigest });
    const currentHandle = projectWorkerHandle(job, { trustHostAuthority: false });
    const currentCursorSequence = currentHandle?.eventCursor?.sequence;
    if (!Number.isSafeInteger(currentCursorSequence)
      || currentCursorSequence < witness.eventCursorSequence) {
      spawnIdempotencyStateError("Spawn response witness cursor disagrees with its durable job.");
    }
    if (responseHandle !== null
      && (stableDigest(responseHandle) !== witness.handleDigest
        || responseHandle?.id !== job.id
        || responseHandle?.eventCursor?.sequence !== witness.eventCursorSequence
        || stableDigest(currentHandle) !== witness.handleDigest)) {
      spawnIdempotencyStateError("Spawn response witness digest disagrees with its captured handle.");
    }
  }
  return job;
}

function captureSpawnResponse({
  job,
  keyDigest,
  replayed,
  responseSequence,
  recordedAt = now()
}) {
  if (!Number.isSafeInteger(responseSequence) || responseSequence < 1) {
    spawnIdempotencyStateError("Spawn response sequence is malformed.");
  }
  const { handle, responseWitness } = buildSpawnResponseWitness({
    job,
    keyDigest,
    replayed,
    responseSequence,
    recordedAt
  });
  const record = normalizeSpawnIdempotencyRecord(
    buildSpawnIdempotencyRecord({ job, keyDigest, responseWitness }),
    { keyDigest }
  );
  assertSpawnIdempotencyJobBinding(record, job, { keyDigest, responseHandle: handle });
  return Object.freeze({ handle, record });
}

/**
 * Resolve ownership for mutation tools.
 * Exact thread match is always accepted. Host-attested parent/subagent is
 * accepted only when principal.attestedParentThreadId matches job.host.sessionId
 * and principal.attestedByHost === true (never inferred from tool args).
 */
export function assertMutationOwnership(job, principal) {
  if (!job || !principal) {
    throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
  }
  const host = { kind: principal.hostKind || "codex", sessionId: principal.threadId };
  if (sameHostSession(job, host)) return "exact-thread";
  if (
    principal.attestedByHost === true
    && typeof principal.attestedParentThreadId === "string"
    && job.host?.kind === "codex"
    && job.host?.sessionId === principal.attestedParentThreadId
  ) {
    return "host-attested-parent";
  }
  throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
}

function ownershipHost(principal) {
  return Object.freeze({ kind: principal.hostKind || "codex", sessionId: principal.threadId });
}

export function cancellationNonce(job) {
  if (typeof job?.workerProcess?.nonce === "string") return job.workerProcess.nonce;
  if (typeof job?.workerAuthorization === "string") return job.workerAuthorization;
  if (typeof job?.workerAuthorization?.nonce === "string") return job.workerAuthorization.nonce;
  return null;
}

function validIsoTimestamp(value) {
  if (typeof value !== "string" || !value) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function exactLegacyPendingAuthorization(job, principal) {
  const authorization = job?.workerAuthorization;
  const dispatch = job?.request?.spawn?.dispatch;
  const authorizationKeys = new Set([
    "schemaVersion",
    "nonce",
    "ownerThreadId",
    "purpose",
    "issuedAt"
  ]);
  const dispatchKeys = new Set([
    "schemaVersion",
    "state",
    "attemptId",
    "providerGeneration",
    "nextProviderGeneration",
    "claimedAt",
    "createdAt",
    "updatedAt"
  ]);
  return Boolean(
    job?.host?.kind === "codex"
    && job?.status === "queued"
    && job?.phase === "accepted"
    && principal?.hostKind === "codex"
    && authorization
    && typeof authorization === "object"
    && !Array.isArray(authorization)
    && Object.keys(authorization).length === authorizationKeys.size
    && Object.keys(authorization).every((key) => authorizationKeys.has(key))
    && authorization.schemaVersion === 1
    && /^[0-9a-f]{32}$/.test(authorization.nonce || "")
    && authorization.ownerThreadId === job?.host?.sessionId
    && authorization.ownerThreadId === principal?.threadId
    && authorization.purpose === "launch-worker"
    && validIsoTimestamp(authorization.issuedAt)
    && authorization.issuedAt === job?.createdAt
    && dispatch
    && typeof dispatch === "object"
    && !Array.isArray(dispatch)
    && Object.keys(dispatch).length === dispatchKeys.size
    && Object.keys(dispatch).every((key) => dispatchKeys.has(key))
    && dispatch.schemaVersion === 1
    && dispatch.state === "pending"
    && dispatch.attemptId === null
    && dispatch.providerGeneration === 0
    && dispatch.nextProviderGeneration === null
    && dispatch.claimedAt === null
    && validIsoTimestamp(dispatch.createdAt)
    && validIsoTimestamp(dispatch.updatedAt)
    && dispatch.createdAt === job.createdAt
    && dispatch.updatedAt === dispatch.createdAt
  );
}

function legacyPendingMigrationEligible(root, job, principal, env = process.env) {
  const spawn = job?.request?.spawn;
  if (!exactLegacyPendingAuthorization(job, principal)
    || Object.hasOwn(spawn || {}, "controllerSpawnIntent")
    || Object.hasOwn(spawn || {}, "workerSpawnIntent")
    || Object.hasOwn(spawn || {}, "unsettledWorkerProcess")
    || Object.hasOwn(spawn || {}, "controllerCleanupProcess")
    || spawn?.controllerCleanupPending === true
    || Object.hasOwn(job || {}, "controllerProcess")
    || Object.hasOwn(job || {}, "workerProcess")
    || Object.hasOwn(job || {}, "providerProcess")
    || Object.hasOwn(job || {}, "pendingTerminal")) return false;
  try {
    assertDispatchContract(job);
    const callerControl = resolveControlWorkspace(root, env);
    const executionRoot = spawn?.executionRoot;
    if (typeof executionRoot !== "string"
      || !path.isAbsolute(executionRoot)
      || path.normalize(executionRoot) !== executionRoot) return false;
    const storedControl = resolveControlWorkspace(executionRoot, env);
    if (storedControl.executionRoot !== executionRoot
      || storedControl.controlWorkspaceId !== job.controlWorkspaceId
      || callerControl.controlWorkspaceId !== job.controlWorkspaceId
      || spawn.ownerThreadId !== job.host?.sessionId
      || !SHA256_HEX.test(spawn.idempotencyKeyDigest || "")) return false;
    const acceptedContext = assertContextCompatible(
      executionRoot,
      job.request?.contextManifest,
      { mode: "execute" }
    );
    if (job.request?.envelope?.contextManifestId != null
      && job.request.envelope.contextManifestId !== acceptedContext.manifestId) return false;
    const recomputedRequestDigest = requestDigest({
      principal: {
        hostKind: job.host?.kind,
        threadId: job.host?.sessionId
      },
      controlWorkspaceId: job.controlWorkspaceId,
      executionRoot,
      envelope: job.request?.envelope,
      contextManifest: acceptedContext,
      roleId: job.request?.roleId,
      write: job.write
    });
    if (spawn.requestDigest !== recomputedRequestDigest) return false;
    const recomputedProviderPromptDigest = digestKey(composeProviderPrompt(job.request.envelope, {
      root: executionRoot,
      contextManifest: acceptedContext
    }));
    if (job.request?.providerPromptDigest !== recomputedProviderPromptDigest) return false;
    return loadProviderGuard(executionRoot, job.id, env) === null;
  } catch {
    return false;
  }
}

/**
 * Public launch observation. A provider is "started" only after its durable
 * process identity has been committed to the job. A claimed controller or
 * worker process is still pending from the caller's point of view.
 */
export function providerLaunchState(job) {
  const dispatch = job?.request?.spawn?.dispatch;
  const completeProviderIdentity = (
    completeOwnedProcessIdentity(job?.providerProcess)
    && (!isSupportedWorkerDispatch(dispatch) || (
      dispatch.state === "provider-started"
      && dispatch.attemptId
      && Number.isSafeInteger(dispatch.providerGeneration)
      && dispatch.providerGeneration > 0
      && job.providerProcess.providerGeneration === dispatch.providerGeneration
      && job.providerProcess.commandMarker === job.id
      && job.providerProcess.dispatchAttemptId === dispatch.attemptId
      && (!isDispatchV2(dispatch) || job.providerProcess.dispatchFence === dispatch.fence)
    ))
  );
  if (completeProviderIdentity) {
    return "started";
  }
  if (job?.request?.spawn?.dispatch?.state === "failed" || terminalWithoutProvider(job)) {
    return "failed";
  }
  return "pending";
}

function terminalJob(job) {
  return ["completed", "failed", "cancelled"].includes(job?.status);
}

function terminalWithoutProvider(job) {
  return terminalJob(job)
    && !Number.isInteger(job?.providerProcess?.pid);
}

export function assertDispatchContract(job) {
  const role = assertRoleDigest(job?.role);
  if (role.id !== job?.request?.roleId
    || Boolean(role.write) !== Boolean(job?.write)
    || !sameSecurityProfile(job?.profile, profileFor("task", Boolean(job?.write)))) {
    throw new CompanionError("E_ROLE", "Worker role or provider profile does not match the durable dispatch contract.");
  }
  const dispatch = job?.request?.spawn?.dispatch;
  if (isDispatchV2(dispatch)) {
    const executionRoot = job?.request?.spawn?.executionRoot;
    if (typeof executionRoot !== "string"
      || !path.isAbsolute(executionRoot)
      || path.normalize(executionRoot) !== executionRoot
      || executionRoot.length > 4096) {
      throw new CompanionError("E_STATE", "Worker dispatch-v2 is missing its canonical execution root.");
    }
    const authorization = job?.workerAuthorization
      ? assertWorkerAuthorization(job, { allowLegacy: false })
      : null;
    const spawn = job?.request?.spawn || {};
    const digestPresent = Object.hasOwn(spawn, "consumedLaunchContractDigest");
    const consumedAtPresent = Object.hasOwn(spawn, "launchContractConsumedAt");
    const consumedDigest = spawn.consumedLaunchContractDigest;
    const consumedAt = spawn.launchContractConsumedAt;
    if (authorization && (digestPresent || consumedAtPresent)) {
      throw new CompanionError(
        "E_AUTH_REQUIRED",
        "Worker launch authorization cannot remain active after durable consumption."
      );
    }
    const consumption = {};
    if (digestPresent) consumption.digest = consumedDigest;
    if (consumedAtPresent) consumption.consumedAt = consumedAt;
    assertDispatchV2(dispatch, {
      authorization,
      consumption
    });
    if (!authorization && (digestPresent || consumedAtPresent)) {
      const prompt = job?.request?.prompt;
      const promptMatches = typeof prompt !== "string"
        || crypto.createHash("sha256").update(prompt).digest("hex") === job?.request?.providerPromptDigest;
      if (consumedDigest !== launchContractDigest(job) || !promptMatches) {
        throw new CompanionError(
          "E_AUTH_REQUIRED",
          "Consumed worker launch authorization no longer matches its durable contract."
        );
      }
    }
    assertDispatchLifecycleContract(job, dispatch);
  }
  return role;
}

export function assertNoRecoveryCleanupFence(job, operation = "advance worker dispatch") {
  if (job?.request?.spawn?.cleanupFence != null) {
    throw new CompanionError(
      "E_STATE",
      `Cannot ${operation} while host recovery owns an exact cleanup fence.`
    );
  }
  return job;
}

function assertTransitionNotCleanupClaimed(job, state) {
  assertNoRecoveryCleanupFence(job, `transition worker dispatch to ${state}`);
  const spawn = job?.request?.spawn || {};
  if (["controller-started", "worker-started", "provider-started", "failed"].includes(state)
    && (spawn.controllerCleanupPending === true || spawn.controllerCleanupProcess != null)) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Controller cleanup authority was already published before process registration."
    );
  }
  if (["worker-started", "provider-started", "failed"].includes(state)
    && (spawn.unsettledWorkerProcess != null
      || spawn.dispatch?.workerLaunchUnsettledAt != null)) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Worker cleanup authority was already published before process registration."
    );
  }
  if (["provider-started", "failed"].includes(state)
    && (spawn.dispatch?.providerLaunchUnsettledAt != null
      || (job.providerProcess != null && job.providerProcess.startToken === null))) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Provider cleanup authority was already published before provider registration."
    );
  }
  if (state === "failed"
    && (spawn.providerRotationIntent?.status === "pending"
      || spawn.dispatch?.nextProviderGeneration != null)) {
    throw new CompanionError(
      "E_STATE",
      "Pending provider rotation must be durably resolved before dispatch failure."
    );
  }
  return job;
}

function recoveryCleanupFenceMatches(job, fenceId, allowedSources) {
  const cleanupFence = job?.request?.spawn?.cleanupFence;
  if (cleanupFence == null) return fenceId == null;
  return typeof fenceId === "string"
    && cleanupFence.fenceId === fenceId
    && allowedSources.includes(cleanupFence.source);
}

export function acquireRecoveryCleanupFence({
  root,
  workerId,
  attemptId,
  fence = null,
  source,
  expectedDispatchState,
  expectedProcessIdentity,
  env = process.env
} = {}) {
  if (!root
    || !workerId
    || !attemptId
    || !["controller-cleanup", "unsettled-worker", "provider-generation"].includes(source)
    || typeof expectedDispatchState !== "string"
    || !expectedProcessIdentity) {
    throw new CompanionError("E_USAGE", "Recovery cleanup requires an exact durable process expectation.");
  }
  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    if (terminalJob(current)) {
      throw new CompanionError("E_STATE", "Terminal worker cannot acquire recovery cleanup authority.");
    }
    assertDispatchContract(current);
    const dispatch = current.request?.spawn?.dispatch;
    const durableSource = recoveryCleanupSource(current, source);
    if (!isDispatchV2(dispatch)
      || dispatch.attemptId !== attemptId
      || dispatch.state !== expectedDispatchState
      || dispatch.fence !== fence
      || !durableSource?.identity
      || !sameDispatchProcessWitness(durableSource.identity, expectedProcessIdentity, {
        nonce: durableSource.nonce,
        allowUnsettled: true
      })
      || (source === "provider-generation" && dispatch.nextProviderGeneration != null)) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Recovery cleanup expectation no longer matches the durable dispatch."
      );
    }
    const existing = current.request?.spawn?.cleanupFence;
    if (existing) {
      assertRecoveryCleanupFenceContract(current, dispatch);
      if (existing.source !== source
        || !sameDispatchProcessWitness(existing.processIdentity, expectedProcessIdentity, {
          nonce: durableSource.nonce,
          allowUnsettled: true
        })) {
        throw new CompanionError("E_PROCESS_IDENTITY", "A conflicting recovery cleanup fence already exists.");
      }
      return Object.freeze({ workerId, ...existing });
    }
    const claimedAt = now();
    const cleanupFence = Object.freeze({
      schemaVersion: RECOVERY_CLEANUP_FENCE_SCHEMA_VERSION,
      fenceId: crypto.randomBytes(16).toString("hex"),
      authority: "host-trusted-reconciler",
      source,
      mode: durableSource.identity.startToken === null ? "observe-only" : "signal",
      processKind: durableSource.processKind,
      dispatchState: dispatch.state,
      attemptId,
      dispatchFence: dispatch.fence,
      processIdentity: { ...durableSource.identity },
      claimedAt
    });
    transaction.updateJob(workerId, (latest) => {
      if (terminalJob(latest)) {
        throw new CompanionError("E_STATE", "Worker terminalized before cleanup fencing.");
      }
      assertDispatchContract(latest);
      const latestDispatch = latest.request?.spawn?.dispatch;
      const latestSource = recoveryCleanupSource(latest, source);
      if (latest.request?.spawn?.cleanupFence != null
        || latestDispatch?.attemptId !== attemptId
        || latestDispatch.state !== expectedDispatchState
        || latestDispatch.fence !== fence
        || !latestSource?.identity
        || !sameDispatchProcessWitness(latestSource.identity, expectedProcessIdentity, {
          nonce: latestSource.nonce,
          allowUnsettled: true
        })
        || (source === "provider-generation" && latestDispatch.nextProviderGeneration != null)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Recovery cleanup authority changed before fencing.");
      }
      const next = {
        ...latest,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            cleanupFence
          }
        }
      };
      assertDispatchContract(next);
      return next;
    });
    return Object.freeze({ workerId, ...cleanupFence });
  }, env);
}

export function verifyRecoveryCleanupFence({
  root,
  workerId,
  fenceId,
  expectedProcessIdentity = null,
  env = process.env
} = {}) {
  if (!root || !workerId || !/^[0-9a-f]{32}$/.test(fenceId || "")) {
    throw new CompanionError("E_USAGE", "Recovery cleanup verification requires an exact fence identity.");
  }
  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current || terminalJob(current)) {
      throw new CompanionError("E_STATE", "Recovery cleanup fence is no longer active.");
    }
    assertDispatchContract(current);
    const cleanupFence = assertRecoveryCleanupFenceContract(
      current,
      current.request?.spawn?.dispatch
    );
    const source = recoveryCleanupSource(current, cleanupFence?.source);
    if (!cleanupFence
      || cleanupFence.fenceId !== fenceId
      || (expectedProcessIdentity
        && !sameDispatchProcessWitness(cleanupFence.processIdentity, expectedProcessIdentity, {
          nonce: source?.nonce,
          allowUnsettled: true
        }))) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Recovery cleanup fence changed before process signaling.");
    }
    return Object.freeze({ workerId, ...cleanupFence });
  }, env);
}

function spawnIntentField(processKind) {
  if (processKind === "controller") return "controllerSpawnIntent";
  if (processKind === "worker") return "workerSpawnIntent";
  if (processKind === "provider") return "providerSpawnIntent";
  throw new CompanionError("E_USAGE", "Dispatch process kind must be controller, worker, or provider.");
}

function expectedSpawnPredecessor(processKind) {
  return processKind === "controller" ? "claimed" : "controller-started";
}

function sameSpawnIntent(intent, {
  processKind,
  attemptId,
  intentId = null,
  fence = null,
  providerGeneration = null
} = {}) {
  if (processKind === "provider") {
    return Boolean(
      intent?.schemaVersion === PROVIDER_SPAWN_INTENT_SCHEMA_VERSION
      && intent.attemptId === attemptId
      && intent.dispatchFence === fence
      && intent.providerGeneration === providerGeneration
      && (!intentId || intent.intentId === intentId)
    );
  }
  return Boolean(
    intent?.schemaVersion === WORKER_SPAWN_INTENT_SCHEMA_VERSION
    && intent.processKind === processKind
    && intent.attemptId === attemptId
    && (!intentId || intent.intentId === intentId)
    && (fence === null ? intent.fence == null : intent.fence === fence)
  );
}

/**
 * Durably cross a detached-process launch boundary before calling spawn(2).
 * A pending intent is deliberately ambiguous: after a hard parent crash the
 * host must neither replay the spawn nor publish terminal state until the
 * child self-registers or a trusted parent records that no child was created.
 */
export function prepareDispatchProcessSpawn({
  root,
  workerId,
  attemptId,
  processKind,
  nonce,
  fence = null,
  env = process.env
} = {}) {
  if (!new Set(["controller", "worker"]).has(processKind)) {
    throw new CompanionError("E_USAGE", "Detached process spawn intent requires controller or worker kind.");
  }
  const field = spawnIntentField(processKind);
  if (!root || !workerId || !attemptId || !nonce) {
    throw new CompanionError("E_USAGE", "Dispatch spawn intent requires an exact attempt and nonce.");
  }
  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    if (terminalJob(current)) {
      return Object.freeze({ prepared: false, reason: "terminal", intent: current.request?.spawn?.[field] || null, job: current });
    }
    assertDispatchContract(current);
    assertNoRecoveryCleanupFence(current, "prepare a process spawn");
    const dispatch = current.request?.spawn?.dispatch;
    if (!isSupportedWorkerDispatch(dispatch)
      || dispatch.attemptId !== attemptId
      || dispatch.state !== expectedSpawnPredecessor(processKind)
      || cancellationNonce(current) !== nonce) {
      throw new CompanionError("E_STATE", "Dispatch changed before its spawn intent could be prepared.");
    }
    assertDispatchFence(dispatch, fence);
    if (processKind === "controller" && current.controllerProcess?.pid) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Controller identity already exists before spawn intent preparation.");
    }
    if (processKind === "worker" && current.workerProcess?.pid) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Worker identity already exists before spawn intent preparation.");
    }
    const existing = current.request?.spawn?.[field];
    if (existing) {
      if (!sameSpawnIntent(existing, { processKind, attemptId, fence: isDispatchV2(dispatch) ? fence : null })) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Durable spawn intent changed for this dispatch attempt.");
      }
      return Object.freeze({
        prepared: false,
        reason: existing.status === "pending" ? "already-pending" : existing.status,
        intent: existing,
        job: current
      });
    }

    const preparedAt = now();
    const intent = Object.freeze({
      schemaVersion: WORKER_SPAWN_INTENT_SCHEMA_VERSION,
      processKind,
      intentId: crypto.randomBytes(16).toString("hex"),
      attemptId,
      ...(isDispatchV2(dispatch) ? { fence } : {}),
      status: "pending",
      preparedAt,
      updatedAt: preparedAt,
      registeredAt: null,
      noChildAt: null
    });
    const job = transaction.updateJob(workerId, (latest) => {
      const latestDispatch = latest.request?.spawn?.dispatch;
      if (terminalJob(latest)
        || latestDispatch?.attemptId !== attemptId
        || latestDispatch.state !== expectedSpawnPredecessor(processKind)
        || cancellationNonce(latest) !== nonce
        || latest.request?.spawn?.[field]) {
        throw new CompanionError("E_STATE", "Dispatch changed before spawn intent publication.");
      }
      assertDispatchFence(latestDispatch, fence);
      assertNoRecoveryCleanupFence(latest, "publish a process spawn intent");
      return {
        ...latest,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            [field]: intent,
            dispatch: { ...latestDispatch, updatedAt: preparedAt }
          }
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "checkpoint",
          `${processKind === "controller" ? "Controller" : "Worker"} spawn intent committed before process creation.`,
          { dispatchAttemptId: attemptId, processKind, replayedPrompt: false }
        )
      };
    });
    return Object.freeze({ prepared: true, reason: "prepared", intent, job });
  }, env);
}

/** Record a safe launch-boundary outcome with no live child to recover. */
export function recordDispatchProcessNoChild({
  root,
  workerId,
  attemptId,
  processKind,
  intentId,
  fence = null,
  resolution = "spawn-not-created",
  env = process.env
} = {}) {
  if (!new Set(["controller", "worker"]).has(processKind)) {
    throw new CompanionError("E_USAGE", "Detached process no-child outcome requires controller or worker kind.");
  }
  const field = spawnIntentField(processKind);
  if (!root
    || !workerId
    || !attemptId
    || !intentId
    || !["spawn-not-created", "cleanup-proven"].includes(resolution)) {
    throw new CompanionError("E_USAGE", "No-child publication requires an exact durable spawn intent.");
  }
  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    if (terminalJob(current)) return current;
    assertDispatchContract(current);
    assertNoRecoveryCleanupFence(current, "publish a no-child outcome");
    const dispatch = current.request?.spawn?.dispatch;
    const intent = current.request?.spawn?.[field];
    const processExists = processKind === "controller"
      ? current.controllerProcess?.pid
      : current.workerProcess?.pid;
    if (dispatch?.attemptId !== attemptId
      || dispatch.state !== expectedSpawnPredecessor(processKind)
      || !sameSpawnIntent(intent, {
        processKind,
        attemptId,
        intentId,
        fence: isDispatchV2(dispatch) ? fence : null
      })
      || processExists) {
      throw new CompanionError("E_PROCESS_IDENTITY", "No-child outcome no longer matches the active spawn boundary.");
    }
    assertDispatchFence(dispatch, fence);
    if (isDispatchV2(dispatch) && intent.fence !== fence) {
      throw new CompanionError("E_PROCESS_IDENTITY", "No-child outcome does not match the active dispatch fence.");
    }
    if (intent.status === "no-child") return current;
    if (intent.status !== "pending") {
      throw new CompanionError("E_PROCESS_IDENTITY", "A registered child cannot be replaced with a no-child outcome.");
    }
    const noChildAt = now();
    return transaction.updateJob(workerId, (latest) => {
      const latestIntent = latest.request?.spawn?.[field];
      const latestDispatch = latest.request?.spawn?.dispatch;
      const latestProcessExists = processKind === "controller"
        ? latest.controllerProcess?.pid
        : latest.workerProcess?.pid;
      if (terminalJob(latest)
        || latestDispatch?.attemptId !== attemptId
        || latestDispatch.state !== expectedSpawnPredecessor(processKind)
        || !sameSpawnIntent(latestIntent, {
          processKind,
          attemptId,
          intentId,
          fence: isDispatchV2(latestDispatch) ? fence : null
        })
        || latestIntent.status !== "pending"
        || latestProcessExists) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Spawn boundary changed before no-child publication.");
      }
      assertDispatchFence(latestDispatch, fence);
      assertNoRecoveryCleanupFence(latest, "publish a no-child outcome");
      if (isDispatchV2(latestDispatch) && latestIntent.fence !== fence) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Spawn boundary fence changed before no-child publication.");
      }
      return {
        ...latest,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            [field]: {
              ...latestIntent,
              status: "no-child",
              resolution,
              noChildAt,
              updatedAt: noChildAt
            },
            providerLaunchOutcome: "not-launched",
            dispatch: { ...latestDispatch, updatedAt: noChildAt }
          }
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "checkpoint",
          resolution === "cleanup-proven"
            ? `${processKind === "controller" ? "Controller" : "Worker"} child cleanup was exactly proven.`
            : `${processKind === "controller" ? "Controller" : "Worker"} spawn definitively created no child.`,
          { dispatchAttemptId: attemptId, processKind, resolution, replayedPrompt: false }
        )
      };
    });
  }, env);
}

function providerSpawnBoundaryMatches(dispatch, attemptId, fence, providerGeneration) {
  if (!isDispatchV2(dispatch)
    || dispatch.attemptId !== attemptId
    || dispatch.fence !== fence) return false;
  if (dispatch.state === "worker-started") {
    return providerGeneration === dispatch.providerGeneration + 1
      && dispatch.nextProviderGeneration == null;
  }
  return dispatch.state === "provider-started"
    && dispatch.nextProviderGeneration === providerGeneration
    && providerGeneration === dispatch.providerGeneration + 1;
}

/** Commit the exact provider launch authority before creating the bootstrap. */
export function prepareWorkerProviderSpawn({
  root,
  workerId,
  attemptId,
  fence,
  providerGeneration,
  env = process.env
} = {}) {
  if (!root
    || !workerId
    || !/^[0-9a-f]{32}$/.test(attemptId || "")
    || !Number.isSafeInteger(fence)
    || fence < 1
    || !Number.isSafeInteger(providerGeneration)
    || providerGeneration < 1) {
    throw new CompanionError("E_USAGE", "Provider spawn preparation requires an exact dispatch generation.");
  }
  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    if (terminalJob(current)) {
      return Object.freeze({ prepared: false, reason: "terminal", intent: null, job: current });
    }
    assertDispatchContract(current);
    assertNoRecoveryCleanupFence(current, "prepare a provider spawn");
    const dispatch = current.request?.spawn?.dispatch;
    if (!providerSpawnBoundaryMatches(dispatch, attemptId, fence, providerGeneration)) {
      throw new CompanionError("E_STATE", "Dispatch changed before provider spawn preparation.");
    }
    let guard;
    try { guard = loadProviderGuard(root, workerId); }
    catch {
      throw new CompanionError("E_PROCESS_IDENTITY", "Provider guard aliases are malformed or conflicting.");
    }
    if (guard) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Provider ownership metadata already exists before spawn preparation.");
    }
    const existing = assertProviderSpawnIntentContract(current, dispatch);
    if (existing) {
      if (existing.providerGeneration !== providerGeneration
        || existing.status !== "pending") {
        throw new CompanionError("E_PROCESS_IDENTITY", "Provider spawn authorization was already consumed.");
      }
      return Object.freeze({ prepared: false, reason: "already-pending", intent: existing, job: current });
    }
    const preparedAt = now();
    const intent = Object.freeze({
      schemaVersion: PROVIDER_SPAWN_INTENT_SCHEMA_VERSION,
      intentId: crypto.randomBytes(16).toString("hex"),
      attemptId,
      dispatchFence: fence,
      providerGeneration,
      status: "pending",
      preparedAt,
      updatedAt: preparedAt,
      registeredAt: null,
      noChildAt: null,
      resolution: null
    });
    const job = transaction.updateJob(workerId, (latest) => {
      const latestDispatch = latest.request?.spawn?.dispatch;
      if (terminalJob(latest)
        || latest.request?.spawn?.providerSpawnIntent != null
        || !providerSpawnBoundaryMatches(latestDispatch, attemptId, fence, providerGeneration)) {
        throw new CompanionError("E_STATE", "Provider spawn boundary changed before intent publication.");
      }
      assertDispatchContract(latest);
      assertNoRecoveryCleanupFence(latest, "publish a provider spawn intent");
      const next = {
        ...latest,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            providerSpawnIntent: intent,
            providerLaunchPending: false,
            providerLaunchInFlight: true,
            providerLaunchOutcome: "pending",
            providerLaunchAttemptedAt: preparedAt,
            providerLaunchCompletedAt: null,
            dispatch: { ...latestDispatch, updatedAt: preparedAt }
          }
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "checkpoint",
          "Provider spawn intent committed before bootstrap creation.",
          { providerGeneration, replayedPrompt: false }
        )
      };
      assertDispatchContract(next);
      return next;
    });
    return Object.freeze({ prepared: true, reason: "prepared", intent, job });
  }, env);
}

/**
 * Revoke or settle an exact provider spawn boundary. A live/registered guard
 * always wins; only an absent guard or an exact dead guard permits no-child.
 */
export function recordWorkerProviderSpawnNoChild({
  root,
  workerId,
  attemptId,
  fence,
  providerGeneration,
  intentId,
  resolution = "spawn-not-created",
  env = process.env
} = {}) {
  if (!root
    || !workerId
    || !/^[0-9a-f]{32}$/.test(attemptId || "")
    || !Number.isSafeInteger(fence)
    || !Number.isSafeInteger(providerGeneration)
    || !/^[0-9a-f]{32}$/.test(intentId || "")
    || !["spawn-not-created", "cleanup-proven", "authorization-revoked"].includes(resolution)) {
    throw new CompanionError("E_USAGE", "Provider no-child publication requires an exact spawn intent.");
  }
  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    const dispatch = current.request?.spawn?.dispatch;
    const intent = assertProviderSpawnIntentContract(current, dispatch, { allowMissing: false });
    if (intent.intentId !== intentId
      || intent.attemptId !== attemptId
      || intent.dispatchFence !== fence
      || intent.providerGeneration !== providerGeneration) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Provider no-child proof does not match the durable spawn intent.");
    }
    if (intent.status === "no-child") return current;
    if (terminalJob(current)) {
      throw new CompanionError("E_STATE", "Provider spawn authorization is already terminal.");
    }
    assertDispatchContract(current);
    assertNoRecoveryCleanupFence(current, "settle a provider spawn without a child");
    if (!providerSpawnBoundaryMatches(dispatch, attemptId, fence, providerGeneration)) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Provider spawn boundary changed before no-child settlement.");
    }
    let guard;
    try { guard = loadProviderGuard(root, workerId); }
    catch {
      throw new CompanionError("E_PROCESS_IDENTITY", "Provider guard aliases are malformed or conflicting.");
    }
    if (guard) {
      const authenticated = assertProviderGuardForJob(root, current, guard, {
        expectedGeneration: providerGeneration
      });
      if (authenticated.providerSpawnIntentId !== intentId
        || !["pending", "registered"].includes(intent.status)
        || !processGroupGone(authenticated.providerProcess)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "A live or ambiguous provider guard wins the no-child race.");
      }
      unregisterProviderGuardInWorkspaceTransaction(root, workerId, authenticated);
    } else if (intent.status === "registered") {
      throw new CompanionError("E_PROCESS_IDENTITY", "Registered provider ownership disappeared without exact cleanup proof.");
    }
    if (resolution === "authorization-revoked" && intent.status !== "pending") {
      throw new CompanionError("E_PROCESS_IDENTITY", "Only an unregistered provider authorization can be revoked.");
    }
    const noChildAt = now();
    return transaction.updateJob(workerId, (latest) => {
      const latestDispatch = latest.request?.spawn?.dispatch;
      const latestIntent = assertProviderSpawnIntentContract(latest, latestDispatch, { allowMissing: false });
      if (latestIntent.intentId !== intentId
        || latestIntent.status !== intent.status
        || !providerSpawnBoundaryMatches(latestDispatch, attemptId, fence, providerGeneration)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Provider spawn boundary changed before no-child publication.");
      }
      let latestGuard;
      try { latestGuard = loadProviderGuard(root, workerId); }
      catch {
        throw new CompanionError("E_PROCESS_IDENTITY", "Provider guard aliases changed during no-child settlement.");
      }
      if (latestGuard) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Provider guard appeared before no-child publication.");
      }
      const providerSpawnIntent = {
        ...latestIntent,
        status: "no-child",
        updatedAt: noChildAt,
        noChildAt,
        resolution
      };
      const rotation = latest.request?.spawn?.providerRotationIntent;
      const next = {
        ...latest,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            providerSpawnIntent,
            ...(rotation ? {
              providerRotationIntent: {
                ...rotation,
                status: "no-child",
                registeredAt: providerSpawnIntent.registeredAt,
                updatedAt: noChildAt,
                noChildAt,
                resolution
              }
            } : {}),
            providerLaunchPending: false,
            providerLaunchInFlight: false,
            providerLaunchOutcome: "not-launched",
            providerLaunchCompletedAt: noChildAt,
            dispatch: {
              ...latestDispatch,
              ...(providerGeneration === 2 ? { nextProviderGeneration: null } : {}),
              updatedAt: noChildAt
            }
          }
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "checkpoint",
          "Provider spawn authorization was settled without a child.",
          { providerGeneration, resolution, replayedPrompt: false }
        )
      };
      assertDispatchContract(next);
      return next;
    });
  }, env);
}

/**
 * Atomically claim one committed broker dispatch. The durable attempt identity
 * is authoritative: once claimed, neither idempotent spawn replay nor recovery
 * may create another controller for the same prompt.
 */
export function claimWorkerDispatch({
  root,
  principal,
  workerId,
  holderId = null,
  leaseMs = DEFAULT_DISPATCH_LEASE_MS,
  clock = () => Date.now(),
  env = process.env
} = {}) {
  if (!principal?.threadId) {
    throw new CompanionError("E_AUTH_REQUIRED", "Trusted Codex task identity is unavailable.");
  }
  if (!workerId) throw new CompanionError("E_USAGE", "workerId is required.");
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) {
    throw new CompanionError("E_USAGE", "Worker dispatch lease duration is invalid.");
  }
  const leaseHolderId = holderId || `codex:${principal.threadId}:${crypto.randomBytes(8).toString("hex")}`;
  if (typeof leaseHolderId !== "string" || !leaseHolderId || leaseHolderId.length > 256) {
    throw new CompanionError("E_USAGE", "Worker dispatch lease holder is invalid.");
  }

  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    assertMutationOwnership(current, principal);
    const dispatch = current.request?.spawn?.dispatch;
    if (!isSupportedWorkerDispatch(dispatch)) {
      return Object.freeze({ claimed: false, reason: "not-dispatchable", job: current });
    }
    const legacyPending = dispatch.schemaVersion === 1
      && legacyPendingMigrationEligible(root, current, principal, env);
    const pending = dispatch.state === "pending" && !dispatch.attemptId;
    const reclaimable = isDispatchV2(dispatch)
      && dispatch.state === "claimed"
      && dispatch.attemptId
      && dispatchLeaseExpired(dispatch, clock())
      && !current.request?.spawn?.controllerSpawnIntent
      && !current.controllerProcess?.pid
      && !current.workerProcess?.pid
      && !current.providerProcess?.pid;
    if ((!pending && !reclaimable) || (dispatch.schemaVersion === 1 && !legacyPending)) {
      return Object.freeze({ claimed: false, reason: "already-claimed", job: current });
    }
    assertDispatchContract(current);
    const nonce = cancellationNonce(current);
    if (
      !["queued", "running"].includes(current.status)
      || isCancelRequested(root, current.id, nonce, env)
    ) {
      return Object.freeze({ claimed: false, reason: "inactive", job: current });
    }

    const claimedAtMs = clock();
    if (!Number.isFinite(claimedAtMs)) {
      throw new CompanionError("E_STATE", "Worker dispatch clock is invalid.");
    }
    const claimedAt = new Date(claimedAtMs).toISOString();
    const attemptId = crypto.randomBytes(16).toString("hex");
    const fence = (isDispatchV2(dispatch) && Number.isSafeInteger(dispatch.fence) ? dispatch.fence : 0) + 1;
    const lease = Object.freeze({
      leaseId: crypto.randomBytes(16).toString("hex"),
      holderId: leaseHolderId,
      fence,
      claimedAt,
      expiresAt: new Date(claimedAtMs + leaseMs).toISOString()
    });
    const claimedJob = transaction.updateJob(current.id, (latest) => {
      const latestDispatch = latest.request?.spawn?.dispatch;
      const latestLegacyPending = latestDispatch?.schemaVersion === 1
        && legacyPendingMigrationEligible(root, latest, principal, env);
      const latestPending = latestDispatch?.state === "pending" && !latestDispatch.attemptId;
      const latestReclaimable = isDispatchV2(latestDispatch)
        && latestDispatch.state === "claimed"
        && latestDispatch.attemptId === dispatch.attemptId
        && dispatchLeaseExpired(latestDispatch, claimedAtMs)
        && !latest.request?.spawn?.controllerSpawnIntent
        && !latest.controllerProcess?.pid
        && !latest.workerProcess?.pid
        && !latest.providerProcess?.pid;
      if (terminalJob(latest)
        || ((!latestPending && !latestReclaimable)
          || (latestDispatch?.schemaVersion === 1 && !latestLegacyPending))) {
        throw new CompanionError("E_STATE", "Worker dispatch changed before its durable claim could be published.");
      }
      assertDispatchContract(latest);
      const upgradedDispatch = latestLegacyPending
        ? createDispatchOutbox({ createdAt: latestDispatch.createdAt || latest.createdAt || claimedAt })
        : latestDispatch;
      const trustedControlWorkspace = resolveControlWorkspace(root, env);
      if (latestLegacyPending
        && trustedControlWorkspace.controlWorkspaceId !== latest.controlWorkspaceId) {
        throw new CompanionError(
          "E_STATE",
          "Legacy worker dispatch control-workspace identity changed before migration."
        );
      }
      const boundExecutionRoot = latest.request?.spawn?.executionRoot;
      const authorizationJob = latestLegacyPending
        ? {
            ...latest,
            request: {
              ...latest.request,
              spawn: {
                ...latest.request?.spawn,
                executionRoot: boundExecutionRoot
              }
            }
          }
        : latest;
      const authorization = latestLegacyPending
        ? createWorkerAuthorization({
          job: authorizationJob,
          principal: { ...principal, hostKind: principal.hostKind || "codex" },
          nonce: cancellationNonce(latest),
          issuedAt: latest.workerAuthorization.issuedAt || latest.createdAt || claimedAt
        })
        : assertWorkerAuthorization(latest, { allowLegacy: false });
      return {
        ...authorizationJob,
        phase: latest.phase === "accepted" ? "provider-launching" : latest.phase,
        summary: "Worker dispatch claimed",
        progress: "Starting isolated Grok worker controller",
        workerAuthorization: bindWorkerAuthorizationAttempt(authorization, { attemptId, fence }),
        request: {
          ...authorizationJob.request,
          spawn: {
            ...authorizationJob.request?.spawn,
            providerLaunchPending: true,
            providerLaunchInFlight: false,
            dispatch: {
              ...upgradedDispatch,
              schemaVersion: WORKER_DISPATCH_SCHEMA_VERSION,
              state: "claimed",
              attemptId,
              fence,
              lease,
              claimedAt,
              updatedAt: claimedAt
            }
          }
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "checkpoint",
          "Worker dispatch claimed",
          { dispatchSchemaVersion: WORKER_DISPATCH_SCHEMA_VERSION, dispatchFence: fence }
        )
      };
    });
    return Object.freeze({
      claimed: true,
      reason: "claimed",
      attemptId,
      fence,
      lease,
      nonce: cancellationNonce(claimedJob),
      job: claimedJob
    });
  }, env);
}

/**
 * Trusted internal transition for a previously claimed dispatch. Attempt
 * binding prevents a stale launcher or worker from settling a newer record.
 */
export function transitionWorkerDispatch({
  root,
  workerId,
  attemptId,
  fence = null,
  state,
  controllerProcess = undefined,
  workerProcess = undefined,
  providerProcess = undefined,
  spawnIntentId = undefined,
  error = null,
  runtimeCleanup = null,
  env = process.env
} = {}) {
  const allowed = new Set(["controller-started", "worker-started", "provider-started", "failed"]);
  if (!workerId || !attemptId || !allowed.has(state)) {
    throw new CompanionError("E_USAGE", "Invalid worker dispatch transition.");
  }
  if (state === "failed" && (!isPlainRecord(runtimeCleanup) || runtimeCleanup.ok !== true)) {
    throw new CompanionError(
      "E_RUNTIME_CLEANUP",
      "A failed dispatch transition requires verified controller and task-runtime cleanup."
    );
  }
  const requiredPredecessor = new Map([
    ["controller-started", "claimed"],
    ["worker-started", "controller-started"],
    ["provider-started", "worker-started"]
  ]);
  const validIdentity = (identity) => Boolean(
    currentOwnedProcessIdentity(identity)
    && identity.commandMarker === workerId
    && identity.dispatchAttemptId === attemptId
    && (fence === null || identity.dispatchFence === fence)
  );
  const identityForState = state === "controller-started"
    ? controllerProcess
    : state === "worker-started"
      ? workerProcess
      : state === "provider-started"
        ? providerProcess
        : null;
  const processKindForState = state === "controller-started"
    ? "controller"
    : state === "worker-started"
      ? "worker"
      : state === "provider-started"
        ? "provider"
        : null;
  const intentFieldForState = processKindForState ? spawnIntentField(processKindForState) : null;
  const dispatchAdvancedPast = (dispatchState) => (
    (state === "controller-started" && ["worker-started", "provider-started"].includes(dispatchState))
    || (state === "worker-started" && dispatchState === "provider-started")
  );
  if (state !== "failed" && !validIdentity(identityForState)) {
    throw new CompanionError("E_PROCESS_IDENTITY", `Worker dispatch ${state} requires a complete attempt-bound process identity.`);
  }
  if (state === "provider-started"
    && (!Number.isSafeInteger(providerProcess?.providerGeneration) || providerProcess.providerGeneration < 1)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Worker provider identity requires a positive invocation generation.");
  }

  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    const dispatch = current.request?.spawn?.dispatch;
    if (!isSupportedWorkerDispatch(dispatch) || dispatch.attemptId !== attemptId) {
      throw new CompanionError("E_STATE", "Worker dispatch attempt does not match the durable claim.");
    }
    assertDispatchFence(dispatch, fence);
    if (state === "failed" && isDispatchV2(dispatch)) assertDispatchV2Structure(dispatch);
    else assertDispatchContract(current);
    assertTransitionNotCleanupClaimed(current, state);
    const currentSpawnIntent = intentFieldForState ? current.request?.spawn?.[intentFieldForState] : null;
    if (isDispatchV2(dispatch)
      && intentFieldForState
      && processKindForState !== "provider"
      && !currentSpawnIntent) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Dispatch-v2 process registration requires its durable spawn intent.");
    }
    if (currentSpawnIntent && (
      !spawnIntentId
      || !sameSpawnIntent(currentSpawnIntent, {
        processKind: processKindForState,
        attemptId,
        intentId: spawnIntentId,
        fence: isDispatchV2(dispatch) ? fence : null,
        providerGeneration: state === "provider-started" ? providerProcess?.providerGeneration : null
      })
      || !["pending", "registered"].includes(currentSpawnIntent.status)
    )) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Worker dispatch process identity does not match its durable spawn intent.");
    }
    if (!currentSpawnIntent && spawnIntentId !== undefined) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Worker dispatch spawn intent is missing.");
    }
    if (dispatchAdvancedPast(dispatch.state)) {
      const storedIdentity = state === "controller-started"
        ? current.controllerProcess
        : current.workerProcess;
      assertDispatchContract(current);
      if (!sameDispatchProcessIdentity(storedIdentity, identityForState, { nonce: true })
        || (currentSpawnIntent && currentSpawnIntent.status !== "registered")) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Advanced worker dispatch does not retain the exact registered process identity.");
      }
      return current;
    }
    const currentProviderGeneration = Number.isSafeInteger(dispatch.providerGeneration)
      ? dispatch.providerGeneration
      : 0;
    const repeatedIdentity = dispatch.state === state && state !== "failed"
      ? (state === "controller-started"
          ? current.controllerProcess
          : state === "worker-started"
            ? current.workerProcess
            : current.providerProcess)
      : null;
    const providerRotation = state === "provider-started"
      && dispatch.state === "provider-started"
      && !terminalJob(current)
      && current.request?.spawn?.providerRotationIntent?.status === "pending"
      && current.request.spawn.providerRotationIntent.targetProviderGeneration === dispatch.nextProviderGeneration
      && dispatch.nextProviderGeneration === currentProviderGeneration + 1
      && providerProcess.providerGeneration === dispatch.nextProviderGeneration;
    if (dispatch.state === state && !providerRotation) {
      if (state === "failed") return current;
      assertDispatchContract(current);
      if (!sameDispatchProcessIdentity(repeatedIdentity, identityForState, {
        nonce: state !== "provider-started"
      })) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Repeated worker dispatch transition changed its process identity.");
      }
      return current;
    }
    if (dispatch.state === "failed" || (dispatch.state === "provider-started" && !providerRotation) || terminalJob(current)) return current;
    if (state !== "failed") assertDispatchContract(current);
    if (state === "controller-started" && controllerProcess?.nonce !== cancellationNonce(current)) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Worker controller nonce does not match the durable launch authorization.");
    }
    if (state === "worker-started" && workerProcess?.nonce !== cancellationNonce(current)) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Worker process nonce does not match the durable launch authorization.");
    }
    if (state === "failed") {
      if (!["claimed", "controller-started", "worker-started"].includes(dispatch.state)) {
        throw new CompanionError("E_STATE", "Worker dispatch cannot fail from its current state.");
      }
    } else if (!providerRotation && dispatch.state !== requiredPredecessor.get(state)) {
      throw new CompanionError("E_STATE", `Worker dispatch ${state} requires ${requiredPredecessor.get(state)}.`);
    }
    if (state === "provider-started"
      && !providerRotation
      && providerProcess.providerGeneration !== currentProviderGeneration + 1) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Initial provider generation does not follow the durable dispatch generation.");
    }
    const transitionedAt = now();
    return transaction.updateJob(workerId, (latest) => {
      const latestDispatch = latest.request?.spawn?.dispatch;
      if (terminalJob(latest)) return latest;
      if (!isSupportedWorkerDispatch(latestDispatch) || latestDispatch.attemptId !== attemptId) {
        throw new CompanionError("E_STATE", "Worker dispatch attempt changed before transition publication.");
      }
      assertDispatchFence(latestDispatch, fence);
      if (state === "failed" && isDispatchV2(latestDispatch)) assertDispatchV2Structure(latestDispatch);
      else assertDispatchContract(latest);
      assertTransitionNotCleanupClaimed(latest, state);
      const latestSpawnIntent = intentFieldForState ? latest.request?.spawn?.[intentFieldForState] : null;
      if (isDispatchV2(latestDispatch)
        && intentFieldForState
        && processKindForState !== "provider"
        && !latestSpawnIntent) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Dispatch-v2 spawn intent disappeared before process registration.");
      }
      if (latestSpawnIntent && (
        !spawnIntentId
        || !sameSpawnIntent(latestSpawnIntent, {
          processKind: processKindForState,
          attemptId,
          intentId: spawnIntentId,
          fence: isDispatchV2(latestDispatch) ? fence : null,
          providerGeneration: state === "provider-started" ? providerProcess?.providerGeneration : null
        })
        || !["pending", "registered"].includes(latestSpawnIntent.status)
      )) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Worker dispatch spawn intent changed before process registration.");
      }
      if (!latestSpawnIntent && spawnIntentId !== undefined) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Worker dispatch spawn intent disappeared before process registration.");
      }
      if (dispatchAdvancedPast(latestDispatch.state)) {
        const storedIdentity = state === "controller-started"
          ? latest.controllerProcess
          : latest.workerProcess;
        assertDispatchContract(latest);
        if (!sameDispatchProcessIdentity(storedIdentity, identityForState, { nonce: true })
          || (latestSpawnIntent && latestSpawnIntent.status !== "registered")) {
          throw new CompanionError("E_PROCESS_IDENTITY", "Advanced worker dispatch changed its registered process identity.");
        }
        return latest;
      }
      const latestProviderGeneration = Number.isSafeInteger(latestDispatch.providerGeneration)
        ? latestDispatch.providerGeneration
        : 0;
      const latestRepeatedIdentity = latestDispatch.state === state && state !== "failed"
        ? (state === "controller-started"
            ? latest.controllerProcess
            : state === "worker-started"
              ? latest.workerProcess
              : latest.providerProcess)
        : null;
      const latestProviderRotation = state === "provider-started"
        && latestDispatch.state === "provider-started"
        && !terminalJob(latest)
        && latest.request?.spawn?.providerRotationIntent?.status === "pending"
        && latest.request.spawn.providerRotationIntent.targetProviderGeneration === latestDispatch.nextProviderGeneration
        && latestDispatch.nextProviderGeneration === latestProviderGeneration + 1
        && providerProcess.providerGeneration === latestDispatch.nextProviderGeneration;
      if (latestDispatch.state === state && !latestProviderRotation) {
        if (state === "failed") return latest;
        assertDispatchContract(latest);
        if (!sameDispatchProcessIdentity(latestRepeatedIdentity, identityForState, {
          nonce: state !== "provider-started"
        })) {
          throw new CompanionError("E_PROCESS_IDENTITY", "Repeated worker dispatch transition changed before publication.");
        }
        return latest;
      }
      if (latestDispatch.state === "failed" || (latestDispatch.state === "provider-started" && !latestProviderRotation)) return latest;
      if (state !== "failed") assertDispatchContract(latest);
      if (state === "controller-started" && controllerProcess?.nonce !== cancellationNonce(latest)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Worker controller nonce changed before transition publication.");
      }
      if (state === "worker-started" && workerProcess?.nonce !== cancellationNonce(latest)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Worker process nonce changed before transition publication.");
      }
      if (state === "failed") {
        if (!["claimed", "controller-started", "worker-started"].includes(latestDispatch.state)) {
          throw new CompanionError("E_STATE", "Worker dispatch cannot fail from its current state.");
        }
      } else if (!latestProviderRotation && latestDispatch.state !== requiredPredecessor.get(state)) {
        throw new CompanionError("E_STATE", `Worker dispatch ${state} requires ${requiredPredecessor.get(state)}.`);
      }
      if (state === "provider-started"
        && !latestProviderRotation
        && providerProcess.providerGeneration !== latestProviderGeneration + 1) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Provider generation changed before transition publication.");
      }
      const next = {
        ...latest,
        ...(state === "failed"
          ? { workerAuthorization: null }
          : {}),
        ...(controllerProcess !== undefined ? { controllerProcess } : {}),
        ...(workerProcess !== undefined ? { workerProcess } : {}),
        ...(providerProcess !== undefined ? { providerProcess } : {}),
        request: {
          ...latest.request,
          spawn: {
            ...latest.request?.spawn,
            ...(latestSpawnIntent ? {
              [intentFieldForState]: {
                ...latestSpawnIntent,
                status: "registered",
                registeredAt: latestSpawnIntent.registeredAt || transitionedAt,
                updatedAt: transitionedAt
              }
            } : {}),
            ...(latestProviderRotation ? {
              providerRotationIntent: {
                ...latest.request.spawn.providerRotationIntent,
                status: "registered",
                registeredAt: latestSpawnIntent?.registeredAt || transitionedAt,
                updatedAt: transitionedAt
              }
            } : {}),
            providerLaunchPending: ["provider-started", "failed"].includes(state)
              ? false
              : latest.request?.spawn?.providerLaunchPending,
            providerLaunchInFlight: ["provider-started", "failed"].includes(state)
              ? false
              : latest.request?.spawn?.providerLaunchInFlight,
            providerLaunchOutcome: state === "provider-started"
              ? "launched"
              : state === "failed"
                ? "not-launched"
                : latest.request?.spawn?.providerLaunchOutcome || "pending",
            providerLaunchCompletedAt: ["provider-started", "failed"].includes(state)
              ? transitionedAt
              : latest.request?.spawn?.providerLaunchCompletedAt || null,
            dispatch: {
              ...latestDispatch,
              state,
              ...(isDispatchV2(latestDispatch) && ["controller-started", "worker-started", "provider-started", "failed"].includes(state)
                ? { lease: null }
                : {}),
              updatedAt: transitionedAt,
              ...(state === "provider-started" ? {
                providerGeneration: providerProcess.providerGeneration,
                nextProviderGeneration: null
              } : {}),
              ...(state === "controller-started" ? { controllerStartedAt: transitionedAt } : {}),
              ...(state === "worker-started" ? { workerStartedAt: transitionedAt } : {}),
              ...(state === "failed" ? { failedAt: transitionedAt } : {}),
              ...(state === "provider-started" ? {
                providerStartedAt: latestDispatch.providerStartedAt || transitionedAt,
                ...(latestProviderRotation ? {
                  providerRotatedAt: transitionedAt,
                  providerRotationCount: (latestDispatch.providerRotationCount || 0) + 1
                } : {})
              } : {})
            }
          }
        }
      };
      if (state !== "failed") {
        assertDispatchContract(next);
        return next;
      }
      const cancelled = error?.code === "E_CANCELLED";
      return scrubStoredJob({
        ...next,
        status: cancelled ? "cancelled" : "failed",
        phase: cancelled ? "cancelled" : "failed",
        completedAt: latest.completedAt || transitionedAt,
        summary: cancelled ? "Cancelled" : "Worker launch failed",
        progress: cancelled ? "Cancellation was confirmed before provider startup." : "Worker launch failed before provider startup",
        error: latest.error || error || {
          code: "E_WORKER_LOST",
          message: "Could not launch the isolated Grok worker."
        },
        workerAuthorization: null,
        result: {
          ...(latest.result || {}),
          hostVerification: latest.result?.hostVerification || "not_run",
          taskRuntimeCleaned: runtimeCleanup.ok,
          ...(cancelled ? { stopReason: "cancelled" } : {})
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "blocked",
          error?.message || "Worker launch failed before provider startup"
        )
      });
    });
  }, env);
}

/**
 * Persist a provider group whose PID/PGID is known but whose birth token could
 * not be established. This is cleanup evidence, never launch success: the
 * broker must retain runtime artifacts and may only observe the group becoming
 * empty. It must never signal this incomplete identity.
 */
export function recordUnsettledProviderProcess({
  root,
  workerId,
  attemptId,
  providerProcess,
  env = process.env
} = {}) {
  const validUnsettledIdentity = Boolean(
    providerProcess
    && Number.isInteger(providerProcess.pid)
    && providerProcess.pid > 0
    && providerProcess.startToken === null
    && (process.platform === "win32"
      ? providerProcess.processGroupId === null
      : providerProcess.processGroupId === providerProcess.pid)
    && providerProcess.commandMarker === workerId
    && providerProcess.dispatchAttemptId === attemptId
    && (providerProcess.dispatchFence === undefined
      || (Number.isSafeInteger(providerProcess.dispatchFence) && providerProcess.dispatchFence > 0))
    && Number.isSafeInteger(providerProcess.providerGeneration)
    && providerProcess.providerGeneration > 0
  );
  if (!root || !workerId || !attemptId || !validUnsettledIdentity) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Unsettled provider cleanup requires an exact attempt-bound PID/PGID witness.");
  }
  const sameUnsettledIdentity = (left, right) => Boolean(
    left?.pid === right.pid
    && left.startToken === null
    && left.processGroupId === right.processGroupId
    && left.commandMarker === right.commandMarker
    && left.dispatchAttemptId === right.dispatchAttemptId
    && left.dispatchFence === right.dispatchFence
    && left.providerGeneration === right.providerGeneration
  );

  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    if (terminalJob(current)) return current;
    const dispatch = current.request?.spawn?.dispatch;
    const initialLaunch = isSupportedWorkerDispatch(dispatch)
      && dispatch.attemptId === attemptId
      && dispatch.state === "worker-started"
      && !current.providerProcess?.pid
      && providerProcess.providerGeneration === (Number.isSafeInteger(dispatch.providerGeneration)
        ? dispatch.providerGeneration + 1
        : 1);
    const pendingRotation = isSupportedWorkerDispatch(dispatch)
      && dispatch.attemptId === attemptId
      && dispatch.state === "provider-started"
      && Number.isSafeInteger(dispatch.providerGeneration)
      && dispatch.providerGeneration > 0
      && dispatch.nextProviderGeneration === dispatch.providerGeneration + 1
      && providerProcess.providerGeneration === dispatch.nextProviderGeneration
      && completeOwnedProcessIdentity(current.providerProcess)
      && current.providerProcess.commandMarker === workerId
      && current.providerProcess.dispatchAttemptId === attemptId
      && current.providerProcess.providerGeneration === dispatch.providerGeneration;
    const repeatedRotationWitness = isSupportedWorkerDispatch(dispatch)
      && dispatch.attemptId === attemptId
      && dispatch.state === "failed"
      && current.phase === "cleanup-blocked"
      && sameUnsettledIdentity(current.providerProcess, providerProcess)
      && dispatch.providerGeneration === providerProcess.providerGeneration
      && dispatch.nextProviderGeneration === null;
    if (repeatedRotationWitness) return current;
    if (!initialLaunch && !pendingRotation) {
      throw new CompanionError("E_STATE", "Unsettled provider identity no longer matches the active dispatch.");
    }
    assertDispatchContract(current);
    assertNoRecoveryCleanupFence(current, "record an unsettled provider");
    assertDispatchFence(dispatch, isDispatchV2(dispatch) ? providerProcess.dispatchFence : null);
    if (initialLaunch && current.providerProcess?.pid) {
      if (sameUnsettledIdentity(current.providerProcess, providerProcess)) return current;
      throw new CompanionError("E_PROCESS_IDENTITY", "Provider cleanup identity changed before durable settlement.");
    }
    const recordedAt = now();
    return transaction.updateJob(workerId, (latest) => {
      const latestDispatch = latest.request?.spawn?.dispatch;
      const latestInitialLaunch = isSupportedWorkerDispatch(latestDispatch)
        && latestDispatch.attemptId === attemptId
        && latestDispatch.state === "worker-started"
        && !latest.providerProcess?.pid
        && providerProcess.providerGeneration === (Number.isSafeInteger(latestDispatch.providerGeneration)
          ? latestDispatch.providerGeneration + 1
          : 1);
      const latestPendingRotation = isSupportedWorkerDispatch(latestDispatch)
        && latestDispatch.attemptId === attemptId
        && latestDispatch.state === "provider-started"
        && Number.isSafeInteger(latestDispatch.providerGeneration)
        && latestDispatch.providerGeneration > 0
        && latestDispatch.nextProviderGeneration === latestDispatch.providerGeneration + 1
        && providerProcess.providerGeneration === latestDispatch.nextProviderGeneration
        && completeOwnedProcessIdentity(latest.providerProcess)
        && latest.providerProcess.commandMarker === workerId
        && latest.providerProcess.dispatchAttemptId === attemptId
        && latest.providerProcess.providerGeneration === latestDispatch.providerGeneration;
      const latestRepeatedRotationWitness = isSupportedWorkerDispatch(latestDispatch)
        && latestDispatch.attemptId === attemptId
        && latestDispatch.state === "failed"
        && latest.phase === "cleanup-blocked"
        && sameUnsettledIdentity(latest.providerProcess, providerProcess)
        && latestDispatch.providerGeneration === providerProcess.providerGeneration
        && latestDispatch.nextProviderGeneration === null;
      if (latestRepeatedRotationWitness) return latest;
      if (terminalJob(latest) || (!latestInitialLaunch && !latestPendingRotation)) {
        throw new CompanionError("E_STATE", "Provider dispatch changed before unsettled cleanup evidence was published.");
      }
      assertDispatchContract(latest);
      assertNoRecoveryCleanupFence(latest, "record an unsettled provider");
      assertDispatchFence(latestDispatch, isDispatchV2(latestDispatch) ? providerProcess.dispatchFence : null);
      if (latestInitialLaunch && latest.providerProcess?.pid) {
        if (sameUnsettledIdentity(latest.providerProcess, providerProcess)) return latest;
        throw new CompanionError("E_PROCESS_IDENTITY", "Provider cleanup identity changed before publication.");
      }
      const next = {
        ...latest,
        providerProcess,
        phase: latestPendingRotation ? "cleanup-blocked" : "launch-unsettled",
        progress: latestPendingRotation
          ? "Replacement provider shutdown is unverified; terminal publication is blocked"
          : "Provider shutdown is unverified; runtime cleanup is blocked",
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            ...(latestPendingRotation && latest.request.spawn.providerRotationIntent?.status === "pending"
              ? {
                  providerRotationIntent: {
                    ...latest.request.spawn.providerRotationIntent,
                    status: "registered",
                    registeredAt: recordedAt,
                    updatedAt: recordedAt
                  },
                  ...(latest.request.spawn.providerSpawnIntent?.intentId
                    === latest.request.spawn.providerRotationIntent.intentId
                    ? {
                        providerSpawnIntent: {
                          ...latest.request.spawn.providerSpawnIntent,
                          status: "registered",
                          registeredAt: recordedAt,
                          updatedAt: recordedAt
                        }
                      }
                    : {})
                }
              : {}),
            providerLaunchPending: false,
            providerLaunchInFlight: false,
            providerLaunchOutcome: "unknown",
            dispatch: {
              ...latestDispatch,
              ...(latestPendingRotation ? {
                state: "failed",
                providerGeneration: providerProcess.providerGeneration,
                nextProviderGeneration: null,
                failedAt: recordedAt,
                providerRotationUnsettledAt: recordedAt
              } : {}),
              providerLaunchUnsettledAt: recordedAt,
              updatedAt: recordedAt
            }
          }
        },
        result: {
          ...(latest.result || {}),
          hostVerification: latest.result?.hostVerification || "not_run",
          taskRuntimeCleaned: false,
          privacyWarning: "Task runtime artifacts were retained because provider shutdown could not be verified."
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "blocked",
          latestPendingRotation
            ? "Replacement provider shutdown is unverified; terminal publication and prompt replay are forbidden."
            : "Provider shutdown is unverified; prompt replay is forbidden.",
          { replayedPrompt: false, providerGeneration: providerProcess.providerGeneration }
        )
      };
      if (!latestPendingRotation) return next;
      const message = "Replacement provider startup failed before an exact birth identity could be recorded.";
      return {
        ...next,
        status: "running",
        completedAt: null,
        pendingTerminal: {
          status: "failed",
          phase: "failed",
          completedAt: recordedAt,
          error: { code: "E_PROCESS_IDENTITY", message },
          summary: message
        },
        error: { code: "E_PROCESS_IDENTITY", message },
        summary: message,
        workerAuthorization: null
      };
    });
  }, env);
}

/** Persist a worker child PID/PGID witness when no birth token was obtainable. */
export function recordUnsettledWorkerProcess({
  root,
  workerId,
  attemptId,
  workerProcess,
  env = process.env
} = {}) {
  const validWitness = Boolean(
    workerProcess
    && Number.isInteger(workerProcess.pid)
    && workerProcess.pid > 0
    && (workerProcess.startToken === null || currentOwnedProcessIdentity(workerProcess))
    && (process.platform === "win32"
      ? workerProcess.processGroupId === null
      : workerProcess.processGroupId === workerProcess.pid)
    && workerProcess.commandMarker === workerId
    && workerProcess.dispatchAttemptId === attemptId
    && typeof workerProcess.nonce === "string"
    && workerProcess.nonce.length > 0
    && (workerProcess.dispatchFence === undefined
      || (Number.isSafeInteger(workerProcess.dispatchFence) && workerProcess.dispatchFence > 0))
  );
  if (!root || !workerId || !attemptId || !validWitness) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Unsettled worker cleanup requires an exact attempt-bound PID/PGID witness.");
  }
  const sameWitness = (left, right) => Boolean(
    left?.pid === right.pid
    && left.startToken === right.startToken
    && left.processGroupId === right.processGroupId
    && left.commandMarker === right.commandMarker
    && left.dispatchAttemptId === right.dispatchAttemptId
    && left.dispatchFence === right.dispatchFence
    && left.nonce === right.nonce
  );
  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    if (terminalJob(current)) return current;
    const dispatch = current.request?.spawn?.dispatch;
    if (!isSupportedWorkerDispatch(dispatch)
      || dispatch.attemptId !== attemptId
      || dispatch.state !== "controller-started"
      || current.workerProcess?.pid) {
      throw new CompanionError("E_STATE", "Unsettled worker identity no longer matches controller startup.");
    }
    assertDispatchContract(current);
    assertNoRecoveryCleanupFence(current, "record an unsettled worker");
    assertDispatchFence(dispatch, isDispatchV2(dispatch) ? workerProcess.dispatchFence : null);
    if (workerProcess.nonce !== cancellationNonce(current)) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Unsettled worker witness nonce changed before settlement.");
    }
    const existing = current.request?.spawn?.unsettledWorkerProcess;
    if (existing) {
      if (sameWitness(existing, workerProcess)) return current;
      throw new CompanionError("E_PROCESS_IDENTITY", "Worker cleanup witness changed before durable settlement.");
    }
    const recordedAt = now();
    return transaction.updateJob(workerId, (latest) => {
      const latestDispatch = latest.request?.spawn?.dispatch;
      if (terminalJob(latest)
        || latestDispatch?.attemptId !== attemptId
        || latestDispatch.state !== "controller-started"
        || latest.workerProcess?.pid) {
        throw new CompanionError("E_STATE", "Worker startup changed before cleanup witness publication.");
      }
      assertDispatchContract(latest);
      assertNoRecoveryCleanupFence(latest, "record an unsettled worker");
      assertDispatchFence(latestDispatch, isDispatchV2(latestDispatch) ? workerProcess.dispatchFence : null);
      if (workerProcess.nonce !== cancellationNonce(latest)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Unsettled worker witness nonce changed before publication.");
      }
      const latestWitness = latest.request?.spawn?.unsettledWorkerProcess;
      if (latestWitness) {
        if (sameWitness(latestWitness, workerProcess)) return latest;
        throw new CompanionError("E_PROCESS_IDENTITY", "Worker cleanup witness changed before publication.");
      }
      return {
        ...latest,
        phase: "cleanup-blocked",
        progress: "Worker child shutdown is unverified; terminal publication is blocked",
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            unsettledWorkerProcess: workerProcess,
            providerLaunchPending: false,
            providerLaunchInFlight: false,
            providerLaunchOutcome: "unknown",
            dispatch: {
              ...latestDispatch,
              workerLaunchUnsettledAt: recordedAt,
              updatedAt: recordedAt
            }
          }
        },
        result: {
          ...(latest.result || {}),
          hostVerification: latest.result?.hostVerification || "not_run",
          taskRuntimeCleaned: false,
          privacyWarning: "Task runtime artifacts were retained because worker child shutdown could not be verified."
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "blocked",
          "Worker child shutdown is unverified; prompt replay is forbidden.",
          { replayedPrompt: false }
        )
      };
    });
  }, env);
}

/**
 * Authorize the single report-format repair provider invocation. The worker
 * and dispatch attempt remain fixed; only the provider process may rotate,
 * and only after the prior detached process group is verified gone.
 */
export function authorizeWorkerProviderRotation({
  root,
  workerId,
  attemptId,
  workerProcess,
  env = process.env
} = {}) {
  if (!workerId || !attemptId || !workerProcess) {
    throw new CompanionError("E_USAGE", "Provider rotation requires an attempt-bound worker identity.");
  }
  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    const dispatch = current.request?.spawn?.dispatch;
    if (terminalJob(current)
      || !isSupportedWorkerDispatch(dispatch)
      || !isDispatchV2(dispatch)
      || dispatch.attemptId !== attemptId
      || dispatch.state !== "provider-started") {
      throw new CompanionError("E_STATE", "Provider rotation requires one active provider-started dispatch.");
    }
    assertDispatchContract(current);
    assertNoRecoveryCleanupFence(current, "authorize provider rotation");
    if (!sameDispatchProcessIdentity(current.workerProcess, workerProcess, { nonce: true })) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Provider rotation worker identity does not match the durable dispatch.");
    }
    const generation = Number.isSafeInteger(dispatch.providerGeneration)
      ? dispatch.providerGeneration
      : 0;
    if (generation !== 1 || !completeOwnedProcessIdentity(current.providerProcess)
      || current.providerProcess.commandMarker !== workerId
      || current.providerProcess.dispatchAttemptId !== attemptId
      || current.providerProcess.providerGeneration !== generation) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Provider rotation requires the complete first provider identity.");
    }
    if (!processGroupGone(current.providerProcess)) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Provider rotation refused while the prior provider group is still active.");
    }
    let existingGuard;
    try { existingGuard = loadProviderGuard(root, workerId); }
    catch {
      throw new CompanionError("E_PROCESS_IDENTITY", "Provider guard aliases are malformed or conflicting.");
    }
    if (existingGuard) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Provider rotation requires the prior generation guard to be absent."
      );
    }
    const nextGeneration = generation + 1;
    const existingIntent = assertProviderRotationIntentContract(current, dispatch);
    if (existingIntent?.status === "pending"
      && dispatch.nextProviderGeneration === nextGeneration) {
      return Object.freeze({
        providerGeneration: nextGeneration,
        intentId: existingIntent.intentId,
        replayed: true
      });
    }
    if (existingIntent) {
      throw new CompanionError("E_STATE", "The single provider report-repair attempt was already consumed.");
    }
    if (dispatch.nextProviderGeneration !== null && dispatch.nextProviderGeneration !== undefined) {
      throw new CompanionError("E_STATE", "A legacy provider rotation is ambiguous without a durable spawn intent.");
    }
    const authorizedAt = now();
    const rotationIntent = Object.freeze({
      schemaVersion: PROVIDER_ROTATION_INTENT_SCHEMA_VERSION,
      intentId: crypto.randomBytes(16).toString("hex"),
      attemptId,
      dispatchFence: dispatch.fence,
      baseProviderGeneration: generation,
      targetProviderGeneration: nextGeneration,
      status: "pending",
      preparedAt: authorizedAt,
      updatedAt: authorizedAt,
      registeredAt: null,
      noChildAt: null,
      resolution: null
    });
    const providerSpawnIntent = Object.freeze({
      schemaVersion: PROVIDER_SPAWN_INTENT_SCHEMA_VERSION,
      intentId: rotationIntent.intentId,
      attemptId,
      dispatchFence: dispatch.fence,
      providerGeneration: nextGeneration,
      status: "pending",
      preparedAt: authorizedAt,
      updatedAt: authorizedAt,
      registeredAt: null,
      noChildAt: null,
      resolution: null
    });
    transaction.updateJob(workerId, (latest) => {
      const latestDispatch = latest.request?.spawn?.dispatch;
      if (terminalJob(latest)
        || latestDispatch?.attemptId !== attemptId
        || latestDispatch.state !== "provider-started"
        || latestDispatch.providerGeneration !== generation
        || latest.request?.spawn?.providerRotationIntent != null
        || latest.request?.spawn?.providerSpawnIntent?.providerGeneration === nextGeneration
        || (latestDispatch.nextProviderGeneration !== null
          && latestDispatch.nextProviderGeneration !== undefined)) {
        throw new CompanionError("E_STATE", "Provider rotation state changed before authorization publication.");
      }
      assertDispatchContract(latest);
      assertNoRecoveryCleanupFence(latest, "authorize provider rotation");
      if (!sameDispatchProcessIdentity(latest.workerProcess, workerProcess, { nonce: true })
        || !sameDispatchProcessIdentity(latest.providerProcess, current.providerProcess)
        || !processGroupGone(latest.providerProcess)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Provider rotation identity changed before authorization publication.");
      }
      let latestGuard;
      try { latestGuard = loadProviderGuard(root, workerId); }
      catch {
        throw new CompanionError("E_PROCESS_IDENTITY", "Provider guard aliases changed before rotation authorization.");
      }
      if (latestGuard) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Provider guard appeared before rotation authorization.");
      }
      const next = {
        ...latest,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request?.spawn,
            providerRotationIntent: rotationIntent,
            providerSpawnIntent,
            providerLaunchPending: false,
            providerLaunchInFlight: true,
            providerLaunchOutcome: "pending",
            providerLaunchAttemptedAt: authorizedAt,
            providerLaunchCompletedAt: null,
            dispatch: {
              ...latestDispatch,
              nextProviderGeneration: nextGeneration,
              providerRotationAuthorizedAt: authorizedAt,
              updatedAt: authorizedAt
            }
          }
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "checkpoint",
          "Authorized one same-session provider report repair.",
          { providerGeneration: nextGeneration }
        )
      };
      assertDispatchContract(next);
      return next;
    });
    return Object.freeze({
      providerGeneration: nextGeneration,
      intentId: rotationIntent.intentId,
      replayed: false
    });
  }, env);
}

/** Resolve an authorized report-repair launch only after definitive no-child proof. */
export function recordWorkerProviderRotationNoChild({
  root,
  workerId,
  attemptId,
  fence,
  intentId,
  resolution = "spawn-not-created",
  env = process.env
} = {}) {
  return recordWorkerProviderSpawnNoChild({
    root,
    workerId,
    attemptId,
    fence,
    providerGeneration: 2,
    intentId,
    resolution,
    env
  });
}

/**
 * Atomically settle a dispatch that lost its exact controller/worker process
 * before durable provider startup. Recovery never invents or replays work.
 */
export function settleUnstartedDispatchLoss({
  root,
  workerId,
  attemptId,
  dispatchState,
  controllerProcess = null,
  controllerCleanupProcess = null,
  workerProcess = null,
  unsettledWorkerProcess = null,
  unsettledProviderProcess = null,
  cleanupFenceId = null,
  terminalIntent = null,
  runtimeCleanup,
  env = process.env
} = {}) {
  const explicitIntent = terminalIntent == null ? null : terminalIntent;
  if (!workerId
    || !attemptId
    || !["claimed", "controller-started", "worker-started"].includes(dispatchState)
    || (explicitIntent && (
      !["failed", "cancelled"].includes(explicitIntent.status)
      || typeof explicitIntent.phase !== "string"
      || !explicitIntent.error?.code
      || !explicitIntent.error?.message
    ))
    || (typeof runtimeCleanup !== "function" && typeof runtimeCleanup?.ok !== "boolean")) {
    throw new CompanionError("E_USAGE", "Dispatch loss settlement requires an exact attempt and cleanup outcome.");
  }
  const identityGone = (stored, expected) => Boolean(
    expected
    && sameDispatchProcessIdentity(stored, expected, { nonce: true })
    && processGroupGone(expected)
  );
  const stateMatches = (job) => {
    const dispatch = job.request?.spawn?.dispatch;
    if (!isSupportedWorkerDispatch(dispatch)
      || dispatch.attemptId !== attemptId
      || dispatch.state !== dispatchState
      || !recoveryCleanupFenceMatches(job, cleanupFenceId, [
        "controller-cleanup",
        "unsettled-worker",
        "provider-generation"
      ])) return false;
    const storedProvider = job.providerProcess?.pid ? job.providerProcess : null;
    if (storedProvider) {
      if (!unsettledProviderProcess
        || !sameDispatchProcessWitness(storedProvider, unsettledProviderProcess, {
          allowUnsettled: true
        })
        || !processGroupGone(unsettledProviderProcess)) return false;
    } else if (unsettledProviderProcess) return false;
    const storedControllerCleanup = job.request?.spawn?.controllerCleanupProcess || null;
    if (storedControllerCleanup) {
      if (!controllerCleanupProcess
        || !sameDispatchProcessWitness(storedControllerCleanup, controllerCleanupProcess, {
          nonce: true,
          allowUnsettled: true
        })
        || !processGroupGone(controllerCleanupProcess)) return false;
    } else if (controllerCleanupProcess) return false;
    if (dispatchState === "claimed") {
      const intent = job.request?.spawn?.controllerSpawnIntent;
      const spawnBoundaryProven = !intent
        || intent.status === "no-child"
        || Boolean(storedControllerCleanup);
      return !job.controllerProcess?.pid && !job.workerProcess?.pid && spawnBoundaryProven;
    }
    if (!identityGone(job.controllerProcess, controllerProcess)) return false;
    if (dispatchState === "controller-started") {
      const intent = job.request?.spawn?.workerSpawnIntent;
      const witness = job.request?.spawn?.unsettledWorkerProcess || null;
      const witnessMatches = witness
        ? Boolean(
            unsettledWorkerProcess
            && sameDispatchProcessWitness(witness, unsettledWorkerProcess, {
              nonce: true,
              allowUnsettled: true
            })
            && processGroupGone(unsettledWorkerProcess)
          )
        : !unsettledWorkerProcess;
      const spawnBoundaryProven = !intent
        || intent.status === "no-child"
        || Boolean(witness && witnessMatches);
      return !job.workerProcess?.pid && witnessMatches && spawnBoundaryProven;
    }
    return identityGone(job.workerProcess, workerProcess);
  };

  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    if (terminalJob(current)) return current;
    assertDispatchContract(current);
    if (!stateMatches(current)) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Dispatch loss no longer matches the exact durable process state.");
    }
    return transaction.updateJob(workerId, (latest) => {
      if (terminalJob(latest)) return latest;
      assertDispatchContract(latest);
      if (!stateMatches(latest)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Dispatch identity changed before loss settlement publication.");
      }
      // Runtime artifact deletion and terminal publication share the workspace
      // admission lock and this exact job lock. A stale reconciler therefore
      // cannot delete a newly admitted continuation's credential/profile after
      // another reconciler has already settled this dispatch.
      const completedCleanup = runSuccessfulRuntimeCleanup(runtimeCleanup, latest);
      const completedAt = now();
      const latestDispatch = latest.request.spawn.dispatch;
      const message = explicitIntent?.error?.message
        || "Worker dispatch process exited before provider startup; the prompt was not replayed.";
      const status = explicitIntent?.status || "failed";
      const phase = explicitIntent?.phase || "lost";
      return scrubStoredJob({
        ...latest,
        status,
        phase,
        summary: explicitIntent?.summary || (status === "cancelled" ? "Cancelled" : "Lost"),
        progress: message,
        completedAt,
        heartbeatAt: completedAt,
        error: explicitIntent?.error || { code: "E_WORKER_LOST", message },
        workerAuthorization: null,
        pendingTerminal: undefined,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            cleanupFence: null,
            unsettledWorkerProcess: null,
            controllerCleanupPending: false,
            controllerCleanupProcess: null,
            providerLaunchPending: false,
            providerLaunchInFlight: false,
            providerLaunchOutcome: "not-launched",
            providerLaunchCompletedAt: completedAt,
            dispatch: {
              ...latestDispatch,
              state: "failed",
              ...(isDispatchV2(latestDispatch) ? { lease: null } : {}),
              ...(Number.isSafeInteger(latest.providerProcess?.providerGeneration)
                ? {
                    providerGeneration: latest.providerProcess.providerGeneration,
                    nextProviderGeneration: null
                  }
                : {}),
              failedAt: completedAt,
              runtimeLostAt: completedAt,
              updatedAt: completedAt
            }
          }
        },
        result: {
          ...(latest.result || {}),
          hostVerification: latest.result?.hostVerification || "not_run",
          stopReason: status === "cancelled" ? "cancelled" : "reconciler-lost",
          taskRuntimeCleaned: completedCleanup.ok,
          ...(completedCleanup.ok
            ? { privacyWarning: undefined }
            : { privacyWarning: completedCleanup.warning || "Runtime cleanup remained incomplete after dispatch loss." }),
          runtimeEvidence: {
            ...(latest.result?.runtimeEvidence || {}),
            reconciler: {
              privilege: "host-trusted-reconciler",
              replayedPrompt: false,
              at: completedAt
            }
          }
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "blocked",
          message,
          { replayedPrompt: false }
        )
      });
    });
  }, env);
}

/**
 * Atomically publish a broker worker's pre-provider terminal intent together
 * with the result of physical runtime cleanup. The worker is still alive while
 * calling this function, so authority is the exact attempt-bound worker
 * identity rather than a liveness inference.
 */
export function settlePreProviderWorkerFinalization({
  root,
  workerId,
  attemptId,
  workerProcess,
  intendedTerminal,
  runtimeCleanup,
  env = process.env
} = {}) {
  const intendedStatus = intendedTerminal?.status;
  if (!root
    || !workerId
    || !attemptId
    || !workerProcess
    || !currentOwnedProcessIdentity(workerProcess)
    || !["failed", "cancelled"].includes(intendedStatus)
    || typeof intendedTerminal?.phase !== "string"
    || typeof intendedTerminal?.completedAt !== "string"
    || typeof runtimeCleanup?.ok !== "boolean") {
    throw new CompanionError("E_USAGE", "Pre-provider finalization requires exact terminal intent and cleanup evidence.");
  }
  const stateMatches = (job) => {
    const dispatch = job.request?.spawn?.dispatch;
    return isSupportedWorkerDispatch(dispatch)
      && dispatch.attemptId === attemptId
      && dispatch.state === "worker-started"
      && sameDispatchProcessIdentity(job.workerProcess, workerProcess, { nonce: true });
  };

  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    if (terminalJob(current)) return current;
    assertDispatchContract(current);
    assertNoRecoveryCleanupFence(current, "finalize a live pre-provider worker");
    if (!stateMatches(current)) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Pre-provider finalization no longer matches the exact worker attempt.");
    }
    if (runtimeCleanup.ok && current.providerProcess?.pid && !processGroupGone(current.providerProcess)) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Runtime cleanup cannot succeed while an unsettled provider group remains live.");
    }
    const settledAt = now();
    return transaction.updateJob(workerId, (latest) => {
      if (terminalJob(latest)) return latest;
      assertDispatchContract(latest);
      assertNoRecoveryCleanupFence(latest, "finalize a live pre-provider worker");
      if (!stateMatches(latest)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Worker identity changed before finalization publication.");
      }
      if (runtimeCleanup.ok && latest.providerProcess?.pid && !processGroupGone(latest.providerProcess)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Provider cleanup changed before finalization publication.");
      }
      const latestDispatch = latest.request.spawn.dispatch;
      const providerGone = !latest.providerProcess?.pid || processGroupGone(latest.providerProcess);
      const result = {
        ...(latest.result || {}),
        hostVerification: latest.result?.hostVerification || "not_run",
        taskRuntimeCleaned: runtimeCleanup.ok
      };
      if (runtimeCleanup.ok) delete result.privacyWarning;
      else {
        result.privacyWarning = runtimeCleanup.warning
          || "Task runtime artifacts were retained because cleanup could not be verified.";
      }
      const next = {
        ...latest,
        workerAuthorization: null,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            providerLaunchPending: false,
            providerLaunchInFlight: false,
            providerLaunchOutcome: providerGone ? "not-launched" : "unknown",
            providerLaunchCompletedAt: providerGone ? settledAt : null,
            dispatch: {
              ...latestDispatch,
              state: "failed",
              ...(Number.isSafeInteger(latest.providerProcess?.providerGeneration)
                ? { providerGeneration: latest.providerProcess.providerGeneration }
                : {}),
              nextProviderGeneration: null,
              failedAt: settledAt,
              updatedAt: settledAt
            }
          }
        },
        result,
        heartbeatAt: settledAt,
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "blocked",
          intendedTerminal.error?.message || intendedTerminal.summary || "Worker stopped before provider startup",
          { replayedPrompt: false }
        )
      };
      if (runtimeCleanup.ok) {
        const terminalized = {
          ...next,
          status: intendedStatus,
          phase: intendedTerminal.phase,
          completedAt: intendedTerminal.completedAt,
          error: intendedTerminal.error || null,
          summary: intendedTerminal.summary || intendedTerminal.error?.message || null,
          progress: intendedStatus === "cancelled"
            ? "Cancellation completed before provider startup"
            : "Worker failed before provider startup"
        };
        delete terminalized.pendingTerminal;
        return scrubStoredJob(terminalized);
      }
      return {
        ...next,
        status: "running",
        phase: "cleanup-blocked",
        completedAt: null,
        pendingTerminal: {
          status: intendedStatus,
          phase: intendedTerminal.phase,
          completedAt: intendedTerminal.completedAt,
          error: intendedTerminal.error || null,
          summary: intendedTerminal.summary || intendedTerminal.error?.message || null
        },
        error: {
          code: "E_STATE",
          message: "Task finished, but transient runtime cleanup is incomplete.",
          details: { privacyWarning: result.privacyWarning }
        },
        summary: "Task finished, but transient runtime cleanup is incomplete.",
        progress: "Task finished; runtime cleanup is still pending"
      };
    });
  }, env);
}

/**
 * Publish a provider-started worker's already-durable terminal intent. Runtime
 * cleanup executes while the workspace admission lock and exact job lock are
 * held, so terminal publication and lineage re-admission cannot split around
 * credential/profile deletion.
 */
export function settleProviderStartedWorkerFinalization({
  root,
  workerId,
  attemptId,
  workerProcess,
  providerProcess,
  runtimeCleanup,
  env = process.env
} = {}) {
  if (!root
    || !workerId
    || !attemptId
    || !workerProcess
    || !providerProcess
    || !currentOwnedProcessIdentity(workerProcess)
    || (typeof runtimeCleanup !== "function" && runtimeCleanup?.ok !== true)) {
    throw new CompanionError(
      "E_USAGE",
      "Provider-started finalization requires the live exact worker, gone provider, and cleanup authority."
    );
  }
  const pendingIntent = (job) => {
    const pending = job?.pendingTerminal;
    if (!isPlainRecord(pending)
      || !["completed", "failed", "cancelled"].includes(pending.status)
      || typeof pending.phase !== "string"
      || !pending.phase
      || typeof pending.completedAt !== "string"
      || !pending.completedAt
      || (pending.summary !== null && typeof pending.summary !== "string")
      || (pending.error !== null && !isPlainRecord(pending.error))) {
      throw new CompanionError("E_STATE", "Pending worker terminal intent is missing or malformed.");
    }
    return pending;
  };
  const stateMatches = (job) => {
    const dispatch = job.request?.spawn?.dispatch;
    return isSupportedWorkerDispatch(dispatch)
      && dispatch.attemptId === attemptId
      && dispatch.state === "provider-started"
      && dispatch.nextProviderGeneration == null
      && sameDispatchProcessIdentity(job.workerProcess, workerProcess, { nonce: true })
      && currentOwnedProcessIdentity(workerProcess)
      && sameDispatchProcessIdentity(job.providerProcess, providerProcess)
      && processGroupGone(providerProcess)
      && Boolean(pendingIntent(job));
  };

  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    if (terminalJob(current)) return current;
    assertDispatchContract(current);
    assertNoRecoveryCleanupFence(current, "finalize a live provider-started worker");
    if (!stateMatches(current)) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Provider-started finalization no longer matches the exact active generation."
      );
    }
    return transaction.updateJob(workerId, (latest) => {
      if (terminalJob(latest)) return latest;
      assertDispatchContract(latest);
      assertNoRecoveryCleanupFence(latest, "finalize a live provider-started worker");
      if (!stateMatches(latest)) {
        throw new CompanionError(
          "E_PROCESS_IDENTITY",
          "Provider generation changed before cleanup and terminal publication."
        );
      }
      runSuccessfulRuntimeCleanup(runtimeCleanup, latest);
      const settledAt = now();
      const pending = pendingIntent(latest);
      const result = {
        ...(latest.result || {}),
        hostVerification: latest.result?.hostVerification || "not_run",
        taskRuntimeCleaned: true,
        ...(pending.status === "cancelled" && !latest.result?.stopReason
          ? { stopReason: "cancelled" }
          : {})
      };
      delete result.privacyWarning;
      const terminalized = {
        ...latest,
        status: pending.status,
        phase: pending.phase,
        completedAt: pending.completedAt,
        heartbeatAt: settledAt,
        error: pending.error || null,
        summary: pending.summary || pending.error?.message || latest.summary,
        progress: pending.status === "completed"
          ? "Task runtime cleanup completed"
          : pending.status === "cancelled"
            ? "Cancellation completed"
            : "Worker finalization completed",
        workerAuthorization: null,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            providerLaunchPending: false,
            providerLaunchInFlight: false,
            providerLaunchOutcome: "launched",
            providerLaunchCompletedAt: settledAt,
            dispatch: {
              ...latest.request.spawn.dispatch,
              nextProviderGeneration: null,
              updatedAt: settledAt
            }
          }
        },
        result,
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          pending.status === "completed" ? "checkpoint" : "blocked",
          "Task runtime cleanup completed; durable terminal intent published.",
          { replayedPrompt: false }
        )
      };
      delete terminalized.pendingTerminal;
      return scrubStoredJob(terminalized);
    });
  }, env);
}

/** Restore a cleanup-blocked pre-provider result after every owned group is gone. */
export function settleFailedDispatchCleanup({
  root,
  workerId,
  attemptId,
  controllerProcess,
  workerProcess,
  providerProcess = null,
  cleanupFenceId = null,
  runtimeCleanup,
  reconciler = false,
  env = process.env
} = {}) {
  if (!root
    || !workerId
    || !attemptId
    || !controllerProcess
    || !workerProcess
    || (typeof runtimeCleanup !== "function" && runtimeCleanup?.ok !== true)) {
    throw new CompanionError("E_USAGE", "Failed dispatch cleanup settlement requires exact gone process identities.");
  }
  const stateMatches = (job) => {
    const dispatch = job.request?.spawn?.dispatch;
    return isSupportedWorkerDispatch(dispatch)
      && dispatch.attemptId === attemptId
      && dispatch.state === "failed"
      && recoveryCleanupFenceMatches(job, cleanupFenceId, ["provider-generation"])
      && job.phase === "cleanup-blocked"
      && job.pendingTerminal
      && sameDispatchProcessIdentity(job.controllerProcess, controllerProcess, { nonce: true })
      && sameDispatchProcessIdentity(job.workerProcess, workerProcess, { nonce: true })
      && processGroupGone(controllerProcess)
      && processGroupGone(workerProcess)
      && ((!job.providerProcess?.pid && !providerProcess)
        || (sameDispatchProcessWitness(job.providerProcess, providerProcess, {
          allowUnsettled: true
        })
          && processGroupGone(providerProcess)));
  };
  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    if (terminalJob(current)) return current;
    assertDispatchContract(current);
    if (!stateMatches(current)) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Cleanup settlement no longer matches the exact failed dispatch.");
    }
    return transaction.updateJob(workerId, (latest) => {
      if (terminalJob(latest)) return latest;
      assertDispatchContract(latest);
      if (!stateMatches(latest)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Cleanup identity changed before terminal publication.");
      }
      runSuccessfulRuntimeCleanup(runtimeCleanup, latest);
      const settledAt = now();
      const pending = latest.pendingTerminal;
      const result = {
        ...(latest.result || {}),
        taskRuntimeCleaned: true,
        hostVerification: latest.result?.hostVerification || "not_run",
        ...(reconciler ? {
          runtimeEvidence: {
            ...(latest.result?.runtimeEvidence || {}),
            reconciler: {
              privilege: "host-trusted-reconciler",
              replayedPrompt: false,
              at: settledAt
            }
          }
        } : {})
      };
      delete result.privacyWarning;
      const terminalized = {
        ...latest,
        status: pending.status,
        phase: pending.phase,
        completedAt: pending.completedAt || settledAt,
        error: pending.error || null,
        summary: pending.summary || pending.error?.message || latest.summary,
        progress: pending.status === "cancelled" ? "Cancellation completed" : "Worker finalization completed",
        result,
        heartbeatAt: settledAt,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            cleanupFence: null
          }
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "checkpoint",
          "Task runtime cleanup completed; terminal result published.",
          { replayedPrompt: false }
        )
      };
      delete terminalized.pendingTerminal;
      return scrubStoredJob(terminalized);
    });
  }, env);
}

/** Settle a provider-started dispatch whose exact worker process exited. */
export function settleStartedWorkerLoss({
  root,
  workerId,
  attemptId,
  workerProcess,
  controllerProcess = null,
  providerProcess,
  cleanupFenceId = null,
  reconciler = false,
  runtimeCleanup,
  env = process.env
} = {}) {
  if (!workerId
    || !attemptId
    || !workerProcess
    || !providerProcess
    || (typeof runtimeCleanup !== "function" && runtimeCleanup?.ok !== true)) {
    throw new CompanionError(
      "E_USAGE",
      "Worker loss settlement requires exact gone worker/provider identities and successful runtime cleanup."
    );
  }
  const pendingIntent = (job) => {
    const pending = job?.pendingTerminal;
    if (pending == null) return null;
    if (!isPlainRecord(pending)
      || !["completed", "failed", "cancelled"].includes(pending.status)
      || typeof pending.phase !== "string"
      || !pending.phase
      || typeof pending.completedAt !== "string"
      || !pending.completedAt
      || (pending.summary !== null && typeof pending.summary !== "string")
      || (pending.error !== null && !isPlainRecord(pending.error))) {
      throw new CompanionError("E_STATE", "Pending worker terminal intent is malformed.");
    }
    return pending;
  };
  const stateMatches = (job) => {
    const dispatch = job.request?.spawn?.dispatch;
    const pending = pendingIntent(job);
    return isSupportedWorkerDispatch(dispatch)
      && dispatch.attemptId === attemptId
      && dispatch.state === "provider-started"
      && recoveryCleanupFenceMatches(job, cleanupFenceId, ["provider-generation"])
      && sameDispatchProcessIdentity(job.workerProcess, workerProcess, { nonce: true })
      && processGroupGone(workerProcess)
      && sameDispatchProcessIdentity(job.providerProcess, providerProcess)
      && processGroupGone(providerProcess)
      && (!controllerProcess || (
        sameDispatchProcessIdentity(job.controllerProcess, controllerProcess, { nonce: true })
        && processGroupGone(controllerProcess)
      ))
      // A cleanup-blocked terminal intent is published only by host recovery
      // after the controller has also exited. The live controller may settle a
      // genuine lost-worker record, but it cannot publish its own teardown as
      // already complete.
      && (!pending || Boolean(controllerProcess));
  };
  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    if (terminalJob(current)) return current;
    const dispatch = current.request?.spawn?.dispatch;
    if (!isSupportedWorkerDispatch(dispatch)
      || dispatch.attemptId !== attemptId
      || dispatch.state !== "provider-started") {
      throw new CompanionError("E_STATE", "Started worker loss does not match the durable dispatch.");
    }
    assertDispatchContract(current);
    if (!stateMatches(current)) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Refusing to settle worker runtime cleanup without exact gone controller/worker/provider identities."
      );
    }
    return transaction.updateJob(workerId, (latest) => {
      if (terminalJob(latest)) return latest;
      if (!stateMatches(latest)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Worker identity changed before loss settlement publication.");
      }
      assertDispatchContract(latest);
      runSuccessfulRuntimeCleanup(runtimeCleanup, latest);
      const settledAt = now();
      const latestDispatch = latest.request.spawn.dispatch;
      const intended = pendingIntent(latest);
      const message = intended
        ? "Task runtime cleanup completed; the durable terminal result was published."
        : "Worker process exited before publishing a terminal result; the prompt was not replayed.";
      const status = intended?.status || "failed";
      const result = {
        ...(latest.result || {}),
        hostVerification: latest.result?.hostVerification || "not_run",
        taskRuntimeCleaned: true,
        ...(intended
          ? (status === "cancelled" && !latest.result?.stopReason ? { stopReason: "cancelled" } : {})
          : { stopReason: "worker-runtime-lost" }),
        ...(reconciler ? {
          runtimeEvidence: {
            ...(latest.result?.runtimeEvidence || {}),
            reconciler: {
              privilege: "host-trusted-reconciler",
              replayedPrompt: false,
              at: settledAt
            }
          }
        } : {})
      };
      delete result.privacyWarning;
      const terminalized = {
        ...latest,
        status,
        phase: intended?.phase || "lost",
        summary: intended ? intended.summary : "Lost",
        progress: message,
        completedAt: intended?.completedAt || settledAt,
        heartbeatAt: settledAt,
        error: intended ? intended.error : { code: "E_WORKER_LOST", message },
        workerAuthorization: null,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            cleanupFence: null,
            dispatch: {
              ...latestDispatch,
              nextProviderGeneration: null,
              ...(!intended ? { runtimeLostAt: settledAt } : {}),
              updatedAt: settledAt
            }
          }
        },
        result,
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          status === "completed" ? "checkpoint" : "blocked",
          message,
          { replayedPrompt: false }
        )
      };
      delete terminalized.pendingTerminal;
      return scrubStoredJob(terminalized);
    });
  }, env);
}

/**
 * Commit a durable read-only worker job. Provider launch is intentionally not performed.
 * write:true is rejected until Phase 3 enables broker write spawn after identity redesign.
 */
export function spawnReadOnlyWorker({
  root,
  principal,
  envelope,
  contextManifest = null,
  idempotencyKey,
  roleId = "explorer",
  write = false,
  env = process.env,
  allowWriteSpawn = false,
  providerCapabilityDigest = null,
  providerLaunch = undefined
} = {}) {
  assertIdempotencyKey(idempotencyKey);
  if (!principal?.threadId) {
    throw new CompanionError("E_AUTH_REQUIRED", "Trusted Codex task identity is unavailable.");
  }
  if (write && !allowWriteSpawn) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Broker write spawn is disabled until Phase 3 control-workspace identity and worktrees are enabled."
    );
  }
  if (!envelope || typeof envelope !== "object") {
    throw new CompanionError("E_USAGE", "TaskEnvelope is required for spawn.");
  }
  if (providerLaunch !== undefined && providerLaunch !== null) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Provider launch adapters must use the attempt-bound WorkerService dispatcher."
    );
  }
  if (providerCapabilityDigest !== null && !SHA256_HEX.test(providerCapabilityDigest)) {
    throw new CompanionError("E_CAPABILITY", "Provider capability binding is missing or malformed.");
  }
  const validatedEnvelope = assertTaskEnvelope(envelope);
  if (validatedEnvelope.mode === "write" && !allowWriteSpawn) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Broker write spawn is disabled until Phase 3 control-workspace identity and worktrees are enabled."
    );
  }

  const role = materializeRole(roleId);
  if (!write && role.id !== "explorer") {
    throw new CompanionError(
      "E_ROLE",
      "Read-only broker admission supports only the immutable explorer runtime role."
    );
  }
  if (Boolean(role.write) !== Boolean(write)) {
    throw new CompanionError(
      "E_ROLE",
      write
        ? `Role ${roleId} cannot perform write work.`
        : `Write-capable role ${roleId} cannot be attached to a read-only worker.`
    );
  }
  if ((validatedEnvelope.mode === "write") !== Boolean(write)) {
    throw new CompanionError("E_ROLE", "TaskEnvelope mode must match the worker write capability.");
  }
  assertRoleDigest(role);
  const controlWorkspace = resolveControlWorkspace(root, env);
  const { controlWorkspaceId, executionRoot } = controlWorkspace;
  const acceptedContextManifest = contextManifest
    ? assertContextCompatible(executionRoot, contextManifest, { mode: "execute" })
    : captureContextManifest(executionRoot);
  if (validatedEnvelope.contextManifestId != null
    && validatedEnvelope.contextManifestId !== acceptedContextManifest.manifestId) {
    throw new CompanionError(
      "E_CONTEXT_DRIFT",
      "TaskEnvelope context identity does not match the trusted execution workspace."
    );
  }
  const boundEnvelope = bindTaskEnvelopeContext(
    validatedEnvelope,
    acceptedContextManifest.manifestId
  );
  const profile = profileFor("task", Boolean(write));
  const contextPacket = buildContextPacket({
    mode: "explicit-envelope",
    envelope: boundEnvelope,
    facts: boundEnvelope.context.facts,
    constraints: boundEnvelope.context.constraints
  });
  assertContextPacket(contextPacket, { envelope: boundEnvelope });
  const runtimeRolePolicy = buildRuntimeRolePolicy({ role, profile });
  assertRuntimeRolePolicy(runtimeRolePolicy, { role, profile });
  const providerPrompt = composeProviderPrompt(boundEnvelope, {
    root: executionRoot,
    contextManifest: acceptedContextManifest,
    contextPacket,
    runtimeRolePolicy
  });
  const providerPromptDigest = crypto
    .createHash("sha256")
    .update(providerPrompt)
    .digest("hex");
  const contextBindingDigest = stableDigest({
    mode: CONTEXT_BINDING_MODE,
    packetDigest: contextPacket.digest,
    runtimeRolePolicyDigest: runtimeRolePolicy.digest,
    providerPromptDigest
  });

  const keyDigest = digestKey(idempotencyKey);
  const requestOwner = spawnRequestOwner(principal);
  const spawnDigest = requestDigest({
    principal,
    controlWorkspaceId,
    executionRoot,
    envelope: boundEnvelope,
    contextManifest: acceptedContextManifest,
    roleId,
    write,
    contextBinding: {
      mode: CONTEXT_BINDING_MODE,
      digest: contextBindingDigest
    }
  });
  const admitted = withWorkspaceStateTransaction(root, (transaction) => {
    const digestOwners = transaction.listJobs().filter((candidate) => (
      candidate.request?.spawn?.idempotencyKeyDigest === keyDigest
    ));
    const existing = readIdempotency(root, "spawn", idempotencyKey, env);
    if (existing) {
      const record = normalizeSpawnIdempotencyRecord(existing, { keyDigest });
      if (record.owner.hostKind !== requestOwner.hostKind
        || record.owner.sessionId !== requestOwner.sessionId
        || record.controlWorkspaceId !== controlWorkspaceId
        || record.executionRoot !== executionRoot
        || record.requestDigest !== spawnDigest) {
        idempotencyConflict("idempotencyKey was reused with a different spawn owner or request.");
      }
      const committed = transaction.tryReadJob(record.workerId);
      if (!committed) {
        throw new CompanionError("E_STATE", "Spawn idempotency record refers to a missing durable job.");
      }
      if (digestOwners.length !== 1 || digestOwners[0].id !== record.workerId) {
        spawnIdempotencyStateError("Spawn idempotency digest ownership is ambiguous.");
      }
      assertSpawnIdempotencyJobBinding(record, committed, { keyDigest });
      assertDispatchContract(committed);
      assertDurableSpawnRequestBinding(committed, env);
      assertMutationOwnership(committed, principal);
      if (providerCapabilityDigest !== null
        && committed.request?.spawn?.providerCapabilityDigest !== providerCapabilityDigest) {
        throw new CompanionError("E_CONTEXT_DRIFT", "Provider capability changed since durable worker admission.");
      }
      if (record.schemaVersion === SPAWN_IDEMPOTENCY_SCHEMA_VERSION
        && record.responseWitness.responseSequence === Number.MAX_SAFE_INTEGER) {
        spawnIdempotencyStateError("Spawn response sequence cannot be incremented safely.");
      }
      const responseSequence = record.schemaVersion === SPAWN_IDEMPOTENCY_SCHEMA_VERSION
        ? record.responseWitness.responseSequence + 1
        : 1;
      const recordedAt = now();
      if (record.schemaVersion === SPAWN_IDEMPOTENCY_SCHEMA_VERSION
        && Date.parse(recordedAt) < Date.parse(record.responseWitness.recordedAt)) {
        spawnIdempotencyStateError("Spawn response witness time moved backwards.");
      }
      const captured = captureSpawnResponse({
        job: committed,
        keyDigest,
        replayed: true,
        responseSequence,
        recordedAt
      });
      writeIdempotency(root, "spawn", idempotencyKey, captured.record, env);
      return { committed, handle: captured.handle, replayed: true };
    }

    // Recover a commit whose adjacent idempotency publication was interrupted.
    if (digestOwners.length > 1) {
      spawnIdempotencyStateError("Spawn idempotency digest ownership is ambiguous.");
    }
    const orphan = digestOwners[0] || null;
    if (orphan) {
      if (
        orphan.host?.kind !== requestOwner.hostKind
        || orphan.host?.sessionId !== requestOwner.sessionId
        || orphan.controlWorkspaceId !== controlWorkspaceId
        || orphan.request?.spawn?.executionRoot !== executionRoot
        || orphan.request?.spawn?.ownerThreadId !== principal.threadId
        || orphan.request?.spawn?.requestDigest !== spawnDigest
      ) {
        idempotencyConflict("idempotencyKey was reused with a different spawn owner or request.");
      }
      assertDispatchContract(orphan);
      assertDurableSpawnRequestBinding(orphan, env);
      assertMutationOwnership(orphan, principal);
      if (providerCapabilityDigest !== null
        && orphan.request?.spawn?.providerCapabilityDigest !== providerCapabilityDigest) {
        throw new CompanionError("E_CONTEXT_DRIFT", "Provider capability changed since durable worker admission.");
      }
      const captured = captureSpawnResponse({
        job: orphan,
        keyDigest,
        replayed: true,
        responseSequence: 1
      });
      writeIdempotency(root, "spawn", idempotencyKey, captured.record, env);
      return { committed: orphan, handle: captured.handle, replayed: true };
    }

    const id = generateId("task");
    const createdAt = now();
    const contextReceipt = buildContextReceipt({
      contextPacket,
      rolePolicy: runtimeRolePolicy,
      contextManifest: acceptedContextManifest,
      lineageWorkerId: id,
      effectivePromptDigest: providerPromptDigest
    });
    const job = {
      schemaVersion: 3,
      id,
      kind: "task",
      jobClass: "task",
      write: Boolean(write),
      status: "queued",
      phase: "accepted",
      summary: "Spawn committed",
      progress: "Durable job record committed; provider not started by broker spawn.",
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      completedAt: null,
      heartbeatAt: createdAt,
      host: ownershipHost(principal),
      profile,
      role: {
        ...role,
        tools: [...role.tools]
      },
      model: null,
      effort: null,
      controlWorkspaceId,
      request: {
        contextBindingMode: CONTEXT_BINDING_MODE,
        contextPacket,
        runtimeRolePolicy,
        contextReceipt,
        envelope: boundEnvelope,
        contextManifest: acceptedContextManifest,
        providerPromptDigest,
        providerHomeId: id,
        publicObjective: boundEnvelope.objective !== boundEnvelope.userRequest
          ? boundEnvelope.objective
          : null,
        roleId: role.id,
        spawn: {
          executionRoot,
          idempotencyKeyDigest: keyDigest,
          ownerThreadId: principal.threadId,
          requestDigest: spawnDigest,
          contextBindingDigest,
          successDefinition: SPAWN_SUCCESS_DEFINITION,
          ownershipMode: SPAWN_OWNERSHIP_MODE,
          ...(providerCapabilityDigest !== null ? { providerCapabilityDigest } : {}),
          providerLaunchPending: true,
          providerLaunchInFlight: false,
          providerLaunchOutcome: "pending",
          dispatch: createDispatchOutbox({ createdAt })
        }
      },
      lifecycleEvents: appendLifecycleEvent(
        [],
        "task.accepted",
        "Durable spawn commit accepted by worker broker.",
        {
          spawnSuccessDefinition: SPAWN_SUCCESS_DEFINITION,
          write: Boolean(write)
        }
      ),
      result: null,
      error: null,
      workerAuthorization: null
    };

    job.workerAuthorization = createWorkerAuthorization({
      job,
      principal: { ...principal, hostKind: principal.hostKind || "codex" },
      issuedAt: createdAt
    });

    const committed = transaction.admitJob(job);
    const captured = captureSpawnResponse({
      job: committed,
      keyDigest,
      replayed: false,
      responseSequence: 1
    });
    writeIdempotency(root, "spawn", idempotencyKey, captured.record, env);
    return { committed, handle: captured.handle, replayed: false };
  }, env);

  // Return the exact handle captured and witnessed inside the transaction. A
  // later reread would observe moving active state (dispatch claim, provider
  // launch) and replace this durable response boundary with a TOCTOU race.
  return {
    handle: admitted.handle,
    replayed: admitted.replayed,
    spawnSuccessDefinition: SPAWN_SUCCESS_DEFINITION,
    providerLaunched: false
  };
}

function stableEnvelopeDigestBinding(envelope) {
  if (!isPlainRecord(envelope)) {
    throw new CompanionError("E_STATE", "Worker spawn envelope is malformed.");
  }
  let userRequestDigest;
  if (typeof envelope.userRequest === "string") {
    userRequestDigest = digestKey(envelope.userRequest);
    if (Object.hasOwn(envelope, "userRequestDigest")
      && envelope.userRequestDigest !== userRequestDigest) {
      throw new CompanionError(
        "E_AUTH_REQUIRED",
        "Worker spawn request text does not match its durable privacy digest."
      );
    }
  } else if (envelope.userRequest === null && SHA256_HEX.test(envelope.userRequestDigest || "")) {
    userRequestDigest = envelope.userRequestDigest;
  } else {
    throw new CompanionError(
      "E_AUTH_REQUIRED",
      "Worker spawn request requires literal text or its valid durable privacy digest."
    );
  }
  const stable = {};
  for (const [key, value] of Object.entries(envelope)) {
    if (key === "userRequest" || key === "userRequestDigest" || value === undefined) continue;
    stable[key] = key === "objective"
      && (value === envelope.userRequest || value === userRequestDigest)
      ? userRequestDigest
      : value;
  }
  stable.userRequestDigest = userRequestDigest;
  return stable;
}

function requestDigest({
  principal,
  controlWorkspaceId,
  executionRoot,
  envelope,
  contextManifest,
  roleId,
  write,
  contextBinding = undefined
}) {
  return stableDigest({
    owner: spawnRequestOwner(principal),
    controlWorkspaceId,
    executionRoot,
    envelope: stableEnvelopeDigestBinding(envelope),
    contextManifestDigest: contextManifest?.digest || null,
    roleId,
    write: Boolean(write),
    ...(contextBinding === undefined ? {} : { contextBinding })
  });
}

export function assertDurableSpawnRequestBinding(job, env = process.env) {
  const spawn = job?.request?.spawn;
  const executionRoot = spawn?.executionRoot;
  if (typeof executionRoot !== "string"
    || !path.isAbsolute(executionRoot)
    || path.normalize(executionRoot) !== executionRoot
    || !SHA256_HEX.test(spawn?.idempotencyKeyDigest || "")
    || (Object.hasOwn(spawn || {}, "providerCapabilityDigest")
      && !SHA256_HEX.test(spawn.providerCapabilityDigest || ""))
    || (Object.hasOwn(spawn || {}, "contextBindingDigest")
      && !SHA256_HEX.test(spawn.contextBindingDigest || ""))
    || spawn?.ownerThreadId !== job?.host?.sessionId) {
    spawnIdempotencyStateError("Durable worker spawn provenance is malformed.");
  }
  let control;
  let acceptedContext;
  try {
    control = resolveControlWorkspace(executionRoot, env);
    if (control.executionRoot !== executionRoot
      || control.controlWorkspaceId !== job.controlWorkspaceId) {
      spawnIdempotencyStateError("Durable worker spawn execution root no longer matches its control workspace.");
    }
    acceptedContext = assertContextCompatible(
      executionRoot,
      job.request?.contextManifest,
      { mode: "execute" }
    );
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    spawnIdempotencyStateError("Durable worker spawn context could not be verified.");
  }
  if (job.request?.envelope?.contextManifestId != null
    && job.request.envelope.contextManifestId !== acceptedContext?.manifestId) {
    spawnIdempotencyStateError("Durable worker spawn envelope no longer matches its context identity.");
  }
  const bindingValues = [
    job.request?.contextBindingMode,
    job.request?.contextPacket,
    job.request?.runtimeRolePolicy,
    job.request?.contextReceipt,
    spawn?.contextBindingDigest
  ];
  const hasAnyContextBinding = bindingValues.some((value) => value !== undefined);
  const hasCompleteContextBinding = job.request?.contextBindingMode === CONTEXT_BINDING_MODE
    && job.request?.contextPacket
    && job.request?.runtimeRolePolicy
    && job.request?.contextReceipt
    && SHA256_HEX.test(spawn?.contextBindingDigest || "");
  if (hasAnyContextBinding && !hasCompleteContextBinding) {
    spawnIdempotencyStateError("Durable worker context binding is partial or downgraded.");
  }
  let contextBinding;
  if (hasCompleteContextBinding) {
    if (job.request?.providerHomeId !== job.id
      || typeof job.request?.roleId !== "string"
      || job.role?.id !== job.request.roleId
      || (!job.write && job.request.roleId !== "explorer")) {
      spawnIdempotencyStateError("Durable worker context lineage or logical role is malformed.");
    }
    const expectedRole = materializeRole(job.request.roleId);
    const expectedProfile = profileFor("task", Boolean(job.write));
    try {
      assertRoleDigest(job.role);
      if (!sameSecurityProfile(job.profile, expectedProfile)) {
        throw new CompanionError("E_ROLE", "Durable provider profile drifted.");
      }
      assertContextPacket(job.request.contextPacket, {
        envelope: job.request.envelope
      });
      assertRuntimeRolePolicy(job.request.runtimeRolePolicy, {
        role: expectedRole,
        profile: expectedProfile
      });
      assertContextReceipt(job.request.contextReceipt, {
        contextPacket: job.request.contextPacket,
        rolePolicy: job.request.runtimeRolePolicy,
        contextManifest: acceptedContext,
        lineageWorkerId: job.id,
        effectivePromptDigest: job.request?.providerPromptDigest
      });
    } catch {
      spawnIdempotencyStateError("Durable worker context packet, role policy, or receipt drifted.");
    }
    const expectedContextBindingDigest = stableDigest({
      mode: CONTEXT_BINDING_MODE,
      packetDigest: job.request.contextPacket.digest,
      runtimeRolePolicyDigest: job.request.runtimeRolePolicy.digest,
      providerPromptDigest: job.request.providerPromptDigest
    });
    if (spawn.contextBindingDigest !== expectedContextBindingDigest) {
      spawnIdempotencyStateError("Durable worker context binding digest drifted.");
    }
    contextBinding = {
      mode: CONTEXT_BINDING_MODE,
      digest: expectedContextBindingDigest
    };
  }
  const recomputedRequestDigest = requestDigest({
    principal: {
      hostKind: job.host?.kind,
      threadId: job.host?.sessionId
    },
    controlWorkspaceId: job.controlWorkspaceId,
    executionRoot,
    envelope: job.request?.envelope,
    contextManifest: acceptedContext,
    roleId: job.request?.roleId,
    write: job.write,
    ...(contextBinding ? { contextBinding } : {})
  });
  if (spawn.requestDigest !== recomputedRequestDigest) {
    spawnIdempotencyStateError("Durable worker spawn request no longer matches its admitted binding.");
  }
  if (!SHA256_HEX.test(job.request?.providerPromptDigest || "")) {
    spawnIdempotencyStateError("Durable worker provider-prompt digest is malformed.");
  }
  if (typeof job.request?.envelope?.userRequest === "string") {
    let recomputedPromptDigest;
    try {
      recomputedPromptDigest = hasCompleteContextBinding
        ? verifyJobEffectivePrompt(job, {
          root: executionRoot,
          contextManifest: acceptedContext,
          composeLegacyProviderPrompt: composeProviderPrompt
        }).digest
        : digestKey(composeProviderPrompt(job.request.envelope, {
          root: executionRoot,
          contextManifest: acceptedContext
        }));
    } catch {
      spawnIdempotencyStateError("Durable worker provider prompt reconstruction failed.");
    }
    if (recomputedPromptDigest !== job.request.providerPromptDigest) {
      spawnIdempotencyStateError("Durable worker provider prompt no longer matches its admitted binding.");
    }
  }
  return job;
}

function cancelRequestDigest({ principal, workerId }) {
  return stableDigest({
    ownerThreadId: principal?.threadId || null,
    workerId
  });
}

function recoveryRecordFromIdempotency(existing, keyDigest) {
  return normalizeCancellationRecoveryRecord({
    schemaVersion: 1,
    workerId: existing.workerId,
    ownerThreadId: existing.ownerThreadId,
    requestDigest: existing.requestDigest,
    idempotencyKeyDigest: keyDigest,
    receipt: existing.receipt,
    committedAt: existing.committedAt
  }, { jobId: existing.workerId, keyDigest });
}

function findCancellationRecovery(transaction, keyDigest) {
  const matches = [];
  for (const job of transaction.listJobs()) {
    const record = cancellationRecoveryRecordForKey(job, keyDigest);
    if (record) matches.push({ job, record });
  }
  if (matches.length > 1) {
    cancellationStateError("Cancellation recovery identity is ambiguous across durable jobs.");
  }
  return matches[0] || null;
}

/**
 * Idempotent cancel: immutable receipt, exactly one cancellation-request lifecycle event.
 */
export function cancelWorker({
  root,
  principal,
  workerId,
  idempotencyKey,
  env = process.env
} = {}) {
  assertIdempotencyKey(idempotencyKey);
  if (!principal?.threadId) {
    throw new CompanionError("E_AUTH_REQUIRED", "Trusted Codex task identity is unavailable.");
  }
  if (!workerId) {
    throw new CompanionError("E_USAGE", "workerId is required.");
  }

  const keyDigest = digestKey(idempotencyKey);
  const mutationDigest = cancelRequestDigest({ principal, workerId });
  return withWorkspaceStateTransaction(root, (transaction) => {
    const existing = readIdempotency(root, "cancel", idempotencyKey, env);
    if (existing) {
      if (
        existing.ownerThreadId !== principal.threadId
        || existing.requestDigest !== mutationDigest
        || existing.workerId !== workerId
      ) {
        idempotencyConflict("idempotencyKey was reused with a different cancellation owner or request.");
      }
      const recovered = recoveryRecordFromIdempotency(existing, keyDigest);
      return { receipt: recovered.receipt, replayed: true };
    }

    // Recovery records are searched workspace-wide so reuse of a key against a
    // different worker still conflicts after loss of the adjacent idempotency
    // file. The error intentionally discloses no worker or owner identity.
    const durableRecovery = findCancellationRecovery(transaction, keyDigest);
    if (durableRecovery) {
      const { job, record } = durableRecovery;
      if (
        record.ownerThreadId !== principal.threadId
        || record.requestDigest !== mutationDigest
        || record.workerId !== workerId
      ) {
        idempotencyConflict("idempotencyKey was reused with a different cancellation owner or request.");
      }
      assertMutationOwnership(job, principal);
      writeIdempotency(root, "cancel", idempotencyKey, {
        workerId,
        ownerThreadId: record.ownerThreadId,
        requestDigest: record.requestDigest,
        receipt: record.receipt,
        committedAt: record.committedAt
      }, env);
      return { receipt: record.receipt, replayed: true };
    }

    const initial = transaction.tryReadJob(workerId);
    if (!initial) {
      // Foreign and nonexistent are observationally equivalent.
      throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    }
    assertMutationOwnership(initial, principal);

    const requestAcceptedAt = now();
    const receiptId = `cancel-${digestKey(`${principal.threadId}:${workerId}:${keyDigest}`).slice(0, 24)}`;
    let cancellationRequestSequence = null;
    let status = "accepted";
    const processGroupGoneAt = null;
    let terminalRecordCommittedAt = null;
    let wasActive = false;

    const cancellationRecord = () => ({
      receiptId,
      status,
      requestAcceptedAt,
      processGroupGoneAt,
      terminalRecordCommittedAt,
      idempotencyKeyDigest: keyDigest,
      ownerThreadId: principal.threadId,
      requestDigest: mutationDigest,
      cancellationRequestSequence
    });

    const cancellationReceipt = () => Object.freeze({
      receiptId,
      workerId,
      status,
      requestAcceptedAt,
      processGroupGoneAt,
      terminalRecordCommittedAt,
      idempotencyKeyDigest: keyDigest,
      cancellationRequestSequence
    });

    const cancellationRecoveryRecord = () => ({
      schemaVersion: 1,
      workerId,
      ownerThreadId: principal.threadId,
      requestDigest: mutationDigest,
      idempotencyKeyDigest: keyDigest,
      receipt: cancellationReceipt(),
      committedAt: requestAcceptedAt
    });

    const persistCancellation = (current, extra = {}) => ({
      ...(current.result || {}),
      hostVerification: current.result?.hostVerification || "not_run",
      ...extra,
      cancellation: cancellationRecord(),
      cancellationReceiptsByKey: appendCancellationRecoveryRecord(
        current,
        cancellationRecoveryRecord()
      )
    });

    const updated = transaction.updateJob(workerId, (current) => {
      assertMutationOwnership(current, principal);
      if (current.status !== "queued" && current.status !== "running") {
        status = "already_terminal";
        terminalRecordCommittedAt = current.completedAt || requestAcceptedAt;
        return {
          ...current,
          // Persist immutable per-key recovery next to the terminal job. If the
          // adjacent idempotency-file publication is interrupted, later keys
          // cannot overwrite this receipt's recovery identity.
          result: persistCancellation(current)
        };
      }
      wasActive = true;

      const events = Array.isArray(current.lifecycleEvents) ? current.lifecycleEvents : [];
      const existingEvent = events.find((event) => event.type === "cancellation.requested");
      let nextEvents = events;
      if (existingEvent) {
        status = "already_cancelled";
        cancellationRequestSequence = existingEvent.sequence ?? null;
      } else {
        nextEvents = appendLifecycleEvent(
          events,
          "cancellation.requested",
          "Cancellation request accepted by worker broker.",
          { requestAcceptedAt }
        );
        cancellationRequestSequence = nextEvents.at(-1)?.sequence ?? null;
      }

      const spawn = current.request?.spawn || {};
      const dispatch = spawn.dispatch;
      let dispatchContractValid = false;
      let dispatchContractWarning = null;
      try {
        assertDispatchContract(current);
        dispatchContractValid = true;
      } catch {
        dispatchContractWarning = "Queued worker dispatch metadata is malformed or no longer launch-safe.";
      }
      const providerLaunchSafelyAbsent = Boolean(
        (
          spawn.providerLaunchPending === true
          && spawn.providerLaunchInFlight === false
          && (spawn.providerLaunchOutcome === null || spawn.providerLaunchOutcome === "pending")
        )
        || (
          spawn.providerLaunchPending === false
          && spawn.providerLaunchInFlight === false
          && spawn.providerLaunchOutcome === "not-launched"
        )
      );
      const brokerOnlyQueuedCandidate = Boolean(
        dispatchContractValid
        && providerLaunchSafelyAbsent
        && current.status === "queued"
        && isDispatchV2(dispatch)
        && dispatch.state === "pending"
        && dispatch.attemptId === null
        && dispatch.fence === 0
        && dispatch.lease === null
        && dispatch.providerGeneration === 0
        && dispatch.nextProviderGeneration === null
        && spawn.controllerSpawnIntent == null
        && spawn.workerSpawnIntent == null
        && spawn.unsettledWorkerProcess == null
        && spawn.controllerCleanupProcess == null
        && spawn.controllerCleanupPending !== true
        && current.controllerProcess == null
        && current.workerProcess == null
        && current.providerProcess == null
        && current.pendingTerminal == null
      );
      let providerGuardAbsent = false;
      let providerGuardWarning = null;
      if (brokerOnlyQueuedCandidate) {
        try {
          providerGuardAbsent = loadProviderGuard(root, current.id, env) === null;
          if (!providerGuardAbsent) {
            providerGuardWarning = "Provider ownership metadata exists for this queued worker.";
          }
        } catch {
          providerGuardWarning = "Provider ownership metadata is malformed or unreadable.";
        }
      }
      const brokerOnlyQueued = brokerOnlyQueuedCandidate && providerGuardAbsent;
      // Fail closed for every active state, including the commit-before-launch
      // window. The provider launch hook observes this same nonce-bound marker.
      requestCancel(root, workerId, cancellationNonce(current), env);
      // A broker-only queued job has no process to stop, but stale credentials
      // or profiles may still exist after a prior interrupted cleanup. Verify
      // their removal inside this workspace/job transaction before claiming a
      // cleanup-safe terminal state. Active cancellation remains nonterminal
      // until the controller, worker, or trusted recovery path publishes the
      // same proof. Caller callbacks are never cancellation authority.
      const brokerOnlyCleanup = brokerOnlyQueued
        ? cleanupTaskRuntimeArtifacts(
            workspaceState(root, env),
            current.request?.providerHomeId || current.id,
            []
          )
        : null;
      const mayCommitTerminal = brokerOnlyQueued && brokerOnlyCleanup?.ok === true;
      if (mayCommitTerminal) terminalRecordCommittedAt = now();

      if (mayCommitTerminal) {
        const settledRequest = {
            ...current.request,
            spawn: {
              ...current.request?.spawn,
              providerLaunchPending: false,
              providerLaunchInFlight: false,
              providerLaunchOutcome: "not-launched",
              providerLaunchCompletedAt: terminalRecordCommittedAt,
              dispatch: {
                ...dispatch,
                state: "failed",
                // Dispatch-v2 requires a fenced attempt identity for every
                // non-pending state. Cancellation owns this synthetic fence
                // only to atomically revoke the never-consumed launch grant.
                attemptId: digestKey(`${receiptId}:cancel-dispatch`).slice(0, 32),
                fence: 1,
                lease: null,
                nextProviderGeneration: null,
                claimedAt: terminalRecordCommittedAt,
                failedAt: terminalRecordCommittedAt,
                updatedAt: terminalRecordCommittedAt
              }
            }
          };
        const terminal = scrubStoredJob({
          ...current,
          status: "cancelled",
          phase: "cancelled",
          summary: "Cancelled",
          progress: "Cancellation request accepted and terminal state confirmed.",
          completedAt: terminalRecordCommittedAt,
          request: settledRequest,
          workerAuthorization: null,
          lifecycleEvents: nextEvents,
          result: persistCancellation(current, {
            stopReason: "cancelled",
            taskRuntimeCleaned: true
          })
        });
        assertDispatchContract(terminal);
        return terminal;
      }

      return {
        ...current,
        phase: "cancellation-requested",
        summary: "Cancellation requested",
        progress: brokerOnlyCleanup?.warning
          ? "Cancellation accepted; runtime artifact cleanup remains incomplete."
          : providerGuardWarning || dispatchContractWarning
            ? "Cancellation accepted; provider cleanup identity remains ambiguous."
          : "Cancellation accepted; waiting for cleanup-safe runtime finalization.",
        lifecycleEvents: nextEvents,
        result: persistCancellation(current, brokerOnlyCleanup?.warning || providerGuardWarning || dispatchContractWarning
          ? {
              taskRuntimeCleaned: false,
              privacyWarning: brokerOnlyCleanup?.warning || providerGuardWarning || dispatchContractWarning
            }
          : {})
      };
    });

    if (wasActive) {
      const count = (updated.lifecycleEvents || [])
        .filter((event) => event.type === "cancellation.requested").length;
      if (count !== 1) {
        throw new CompanionError(
          "E_STATE",
          `Expected exactly one cancellation-request event, found ${count}.`
        );
      }
    }

    const receipt = cancellationReceipt();
    writeIdempotency(root, "cancel", idempotencyKey, {
      workerId,
      ownerThreadId: principal.threadId,
      requestDigest: mutationDigest,
      receipt,
      committedAt: requestAcceptedAt
    }, env);

    return { receipt, replayed: false };
  }, env);
}

export function projectCancellationReceipt(receipt) {
  if (!receipt) return null;
  return {
    receiptId: receipt.receiptId,
    workerId: receipt.workerId,
    status: receipt.status,
    requestAcceptedAt: receipt.requestAcceptedAt,
    processGroupGoneAt: receipt.processGroupGoneAt || null,
    terminalRecordCommittedAt: receipt.terminalRecordCommittedAt || null,
    idempotencyKeyDigest: receipt.idempotencyKeyDigest || null,
    cancellationRequestSequence: receipt.cancellationRequestSequence ?? null
  };
}

export function getSpawnIdempotencyRecord(root, key, env = process.env) {
  return readIdempotency(root, "spawn", key, env);
}
