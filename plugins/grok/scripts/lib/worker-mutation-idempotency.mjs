/** Issue #56 worker-mutation idempotency domain. */
import path from "node:path";
import { CompanionError, asErrorPayload } from "./errors.mjs";
import {
  generateId,
  isCancelRequested,
  now,
  readPrivateJsonFile,
  tryReadJob,
  writePrivateJsonFile,
  ensurePrivateStateDirectory,
  withWorkspaceStateTransaction
} from "./state.mjs";
import { projectWorkerHandle, projectWorkerSnapshot } from "./worker-protocol.mjs";
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
  launchContractDigest,
  providerLaunchBindingForJob
} from "./worker-launch-contract.mjs";
import {
  SHA256_HEX,
  digestKey,
  isPlainRecord,
  stableDigest,
  validIsoTimestamp
} from "./worker-mutation-primitives.mjs";
import {
  requestDigest
} from "./worker-mutation-request-contract.mjs";

export const CONTROL_WORKSPACE_ID = /^cws-[0-9a-f]{32}$/;

export const LEGACY_SPAWN_IDEMPOTENCY_SCHEMA_VERSION = 3;

export const SPAWN_IDEMPOTENCY_SCHEMA_VERSION = 4;

export const WRITE_SPAWN_IDEMPOTENCY_SCHEMA_VERSION = 5;

export const SPAWN_RESPONSE_WITNESS_SCHEMA_VERSION = 1;

export const SPAWN_RESPONSE_WITNESS_PROJECTION = "worker-handle-v1-untrusted-host";

export const SPAWN_RESPONSE_WITNESS_ID = /^spawnw-[0-9a-f]{24}$/;

export const LEGACY_SPAWN_IDEMPOTENCY_KEYS = new Set([
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

export const SPAWN_IDEMPOTENCY_KEYS = new Set([
  ...LEGACY_SPAWN_IDEMPOTENCY_KEYS,
  "responseWitness"
]);

export const WRITE_SPAWN_IDEMPOTENCY_KEYS = new Set([
  "schemaVersion",
  "workerId",
  "owner",
  "controlWorkspaceId",
  "expectedExecutionRoot",
  "admissionRequestDigest",
  "executionBindingDigest",
  "idempotencyKeyDigest",
  "committedAt",
  "responseWitness"
]);

export const SPAWN_IDEMPOTENCY_OWNER_KEYS = new Set(["hostKind", "sessionId"]);

export const SPAWN_RESPONSE_WITNESS_KEYS = new Set([
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

export function idempotencyConflict(message) {
  throw new CompanionError("E_IDEMPOTENCY_CONFLICT", message);
}

export function assertIdempotencyKey(key) {
  if (typeof key !== "string" || key.length < 8 || key.length > 256) {
    throw new CompanionError("E_USAGE", "idempotencyKey must be a string of length 8–256.");
  }
  if (/[\r\n\0]/.test(key)) {
    throw new CompanionError("E_USAGE", "idempotencyKey must not contain control characters.");
  }
  return key;
}

export function idempotencyPath(root, kind, keyDigest, env = process.env) {
  // Same control-workspace state store as jobs (shared across linked worktrees).
  const dir = ensurePrivateStateDirectory(root, ["idempotency", kind], env);
  return path.join(dir, `${keyDigest}.json`);
}

export function readIdempotency(root, kind, key, env = process.env) {
  const file = idempotencyPath(root, kind, digestKey(key), env);
  return readPrivateJsonFile(file, {
    missing: null,
    label: `idempotency record for ${kind}`
  });
}

export function writeIdempotency(root, kind, key, record, env = process.env) {
  const file = idempotencyPath(root, kind, digestKey(key), env);
  return writePrivateJsonFile(file, record);
}

export function spawnIdempotencyStateError(message) {
  throw new CompanionError("E_STATE", message);
}

export function spawnResponseWitnessBody(witness) {
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

export function recordSpawnRequestDigest(record) {
  return record?.schemaVersion === WRITE_SPAWN_IDEMPOTENCY_SCHEMA_VERSION
    ? record.admissionRequestDigest
    : record?.requestDigest;
}

export function jobSpawnRequestDigest(job) {
  return job?.write === true && job?.executionBinding
    ? job.request?.spawn?.admissionRequestDigest
    : job?.request?.spawn?.requestDigest;
}

export function normalizeSpawnResponseWitness(witness, { record, keyDigest }) {
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
    || witness.requestDigest !== recordSpawnRequestDigest(record)
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

export function normalizeSpawnIdempotencyRecord(record, { keyDigest }) {
  if (!isPlainRecord(record)) {
    spawnIdempotencyStateError("Spawn idempotency record is malformed.");
  }
  const expectedKeys = record.schemaVersion === LEGACY_SPAWN_IDEMPOTENCY_SCHEMA_VERSION
    ? LEGACY_SPAWN_IDEMPOTENCY_KEYS
    : record.schemaVersion === SPAWN_IDEMPOTENCY_SCHEMA_VERSION
      ? SPAWN_IDEMPOTENCY_KEYS
      : record.schemaVersion === WRITE_SPAWN_IDEMPOTENCY_SCHEMA_VERSION
        ? WRITE_SPAWN_IDEMPOTENCY_KEYS
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
    || record.idempotencyKeyDigest !== keyDigest
    || !validIsoTimestamp(record.committedAt)) {
    spawnIdempotencyStateError("Spawn idempotency binding is malformed.");
  }
  if (record.schemaVersion === WRITE_SPAWN_IDEMPOTENCY_SCHEMA_VERSION) {
    if (typeof record.expectedExecutionRoot !== "string"
      || !path.isAbsolute(record.expectedExecutionRoot)
      || path.normalize(record.expectedExecutionRoot) !== record.expectedExecutionRoot
      || record.expectedExecutionRoot.length > 4096
      || !SHA256_HEX.test(record.admissionRequestDigest || "")
      || !SHA256_HEX.test(record.executionBindingDigest || "")) {
      spawnIdempotencyStateError("Write-spawn idempotency binding is malformed.");
    }
    return Object.freeze({
      ...record,
      owner: Object.freeze({ ...record.owner }),
      responseWitness: normalizeSpawnResponseWitness(record.responseWitness, {
        record,
        keyDigest
      })
    });
  }
  if (typeof record.executionRoot !== "string"
    || !path.isAbsolute(record.executionRoot)
    || path.normalize(record.executionRoot) !== record.executionRoot
    || record.executionRoot.length > 4096
    || !SHA256_HEX.test(record.requestDigest || "")
    || !SHA256_HEX.test(record.launchContractDigest || "")) {
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

export function buildSpawnResponseWitness({
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
    requestDigest: jobSpawnRequestDigest(job),
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

export function buildSpawnIdempotencyRecord({ job, keyDigest, responseWitness }) {
  if (job?.write === true && job?.executionBinding) {
    return {
      schemaVersion: WRITE_SPAWN_IDEMPOTENCY_SCHEMA_VERSION,
      workerId: job.id,
      owner: {
        hostKind: job.host.kind,
        sessionId: job.host.sessionId
      },
      controlWorkspaceId: job.controlWorkspaceId,
      expectedExecutionRoot: job.executionBinding.expectedExecutionRoot,
      admissionRequestDigest: job.request.spawn.admissionRequestDigest,
      executionBindingDigest: job.executionBinding.bindingDigest,
      idempotencyKeyDigest: keyDigest,
      committedAt: job.createdAt,
      responseWitness
    };
  }
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

export function assertSpawnIdempotencyJobBinding(record, job, { keyDigest, responseHandle = null }) {
  const writeBindingMismatch = record?.schemaVersion === WRITE_SPAWN_IDEMPOTENCY_SCHEMA_VERSION
    ? (
      job?.write !== true
      || record.expectedExecutionRoot !== job?.executionBinding?.expectedExecutionRoot
      || record.admissionRequestDigest !== job?.request?.spawn?.admissionRequestDigest
      || record.executionBindingDigest !== job?.executionBinding?.bindingDigest
    )
    : (
      record.executionRoot !== job?.request?.spawn?.executionRoot
      || record.requestDigest !== job?.request?.spawn?.requestDigest
      || record.launchContractDigest !== launchContractDigest(job)
    );
  if (!job
    || record.workerId !== job.id
    || record.owner.hostKind !== job.host?.kind
    || record.owner.sessionId !== job.host?.sessionId
    || record.controlWorkspaceId !== job.controlWorkspaceId
    || writeBindingMismatch
    || record.idempotencyKeyDigest !== job.request?.spawn?.idempotencyKeyDigest
    || record.idempotencyKeyDigest !== keyDigest
    || record.committedAt !== job.createdAt) {
    spawnIdempotencyStateError("Spawn idempotency record disagrees with its durable job.");
  }
  if (
    record.schemaVersion === SPAWN_IDEMPOTENCY_SCHEMA_VERSION
    || record.schemaVersion === WRITE_SPAWN_IDEMPOTENCY_SCHEMA_VERSION
  ) {
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

export function captureSpawnResponse({
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

export function nextSpawnResponseSequence(record, recordedAt = now()) {
  const witnessed = record?.schemaVersion === SPAWN_IDEMPOTENCY_SCHEMA_VERSION
    || record?.schemaVersion === WRITE_SPAWN_IDEMPOTENCY_SCHEMA_VERSION;
  if (!witnessed) {
    return Object.freeze({ responseSequence: 1, recordedAt });
  }
  if (record.responseWitness.responseSequence === Number.MAX_SAFE_INTEGER) {
    spawnIdempotencyStateError("Spawn response sequence cannot be incremented safely.");
  }
  if (Date.parse(recordedAt) < Date.parse(record.responseWitness.recordedAt)) {
    spawnIdempotencyStateError("Spawn response witness time moved backwards.");
  }
  return Object.freeze({
    responseSequence: record.responseWitness.responseSequence + 1,
    recordedAt
  });
}

export function getSpawnIdempotencyRecord(root, key, env = process.env) {
  return readIdempotency(root, "spawn", key, env);
}
