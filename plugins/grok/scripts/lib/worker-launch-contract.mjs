import crypto from "node:crypto";

import { CompanionError } from "./errors.mjs";

export const WORKER_AUTHORIZATION_SCHEMA_VERSION = 2;
export const WORKER_DISPATCH_OUTBOX_SCHEMA_VERSION = 2;
export const LEGACY_WORKER_DISPATCH_SCHEMA_VERSION = 1;
export const DEFAULT_DISPATCH_LEASE_MS = 5_000;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ID_HEX = /^[0-9a-f]{32}$/;
const DISPATCH_STATES = new Set([
  "pending",
  "claimed",
  "controller-started",
  "worker-started",
  "provider-started",
  "failed"
]);
const DISPATCH_KEYS = new Set([
  "schemaVersion",
  "state",
  "attemptId",
  "fence",
  "lease",
  "providerGeneration",
  "nextProviderGeneration",
  "claimedAt",
  "createdAt",
  "updatedAt",
  "controllerStartedAt",
  "workerStartedAt",
  "providerStartedAt",
  "providerRotatedAt",
  "providerRotationCount",
  "providerRotationAuthorizedAt",
  "providerLaunchUnsettledAt",
  "providerRotationUnsettledAt",
  "workerLaunchUnsettledAt",
  "failedAt",
  "runtimeLostAt"
]);
const LEASE_KEYS = new Set([
  "leaseId",
  "holderId",
  "fence",
  "claimedAt",
  "expiresAt"
]);

function canonicalize(value, stack = new Set()) {
  if (value === null || typeof value !== "object") return value;
  if (stack.has(value)) {
    throw new CompanionError("E_STATE", "Worker launch contract contains cyclic data.");
  }
  stack.add(value);
  let normalized;
  if (Array.isArray(value)) {
    normalized = value.map((entry) => canonicalize(entry, stack));
  } else {
    normalized = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) normalized[key] = canonicalize(value[key], stack);
    }
  }
  stack.delete(value);
  return normalized;
}

export function workerLaunchDigest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function textDigest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isPlainRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validIsoTimestamp(value) {
  if (typeof value !== "string" || !value) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function stableRequestBinding(job) {
  const request = isPlainRecord(job?.request) ? job.request : {};
  const sourceEnvelope = isPlainRecord(request.envelope) ? request.envelope : {};
  let durableUserRequestDigest = null;
  if (typeof sourceEnvelope.userRequest === "string") {
    durableUserRequestDigest = textDigest(sourceEnvelope.userRequest);
  } else if (sourceEnvelope.userRequest === null
    && SHA256_HEX.test(sourceEnvelope.userRequestDigest || "")) {
    durableUserRequestDigest = sourceEnvelope.userRequestDigest;
  }
  const defaultObjective = Boolean(
    durableUserRequestDigest
    && (
      sourceEnvelope.objective === sourceEnvelope.userRequest
      || sourceEnvelope.objective === durableUserRequestDigest
    )
  );
  const stable = {};
  for (const [key, value] of Object.entries(request)) {
    if (key !== "spawn" && key !== "prompt" && key !== "promptDigest" && value !== undefined) {
      if (key === "envelope" && isPlainRecord(value)) {
        const envelope = {};
        for (const [envelopeKey, envelopeValue] of Object.entries(value)) {
          if (envelopeKey !== "userRequest" && envelopeKey !== "userRequestDigest" && envelopeValue !== undefined) {
            envelope[envelopeKey] = envelopeKey === "objective" && defaultObjective
              ? durableUserRequestDigest
              : envelopeValue;
          }
        }
        let userRequestDigest;
        if (typeof value.userRequest === "string") {
          userRequestDigest = textDigest(value.userRequest);
          if (Object.hasOwn(value, "userRequestDigest")
            && value.userRequestDigest !== userRequestDigest) {
            throw new CompanionError(
              "E_AUTH_REQUIRED",
              "Worker launch request text does not match its durable privacy digest."
            );
          }
        } else if (value.userRequest === null
          && SHA256_HEX.test(value.userRequestDigest || "")) {
          userRequestDigest = value.userRequestDigest;
        } else {
          throw new CompanionError(
            "E_AUTH_REQUIRED",
            "Worker launch request requires literal text or its valid durable privacy digest."
          );
        }
        envelope.userRequestDigest = userRequestDigest;
        stable[key] = envelope;
      } else if (key === "publicObjective"
        && defaultObjective
        && (value === sourceEnvelope.userRequest || value === durableUserRequestDigest || value === null)) {
        // The public default objective is another projection of the raw task
        // text. Canonicalize both the live and cleanup-scrubbed forms to null
        // so privacy cleanup cannot change the launch authorization digest.
        stable[key] = null;
      } else {
        stable[key] = value;
      }
    }
  }
  const spawn = isPlainRecord(request.spawn) ? request.spawn : {};
  stable.spawnContract = {
    idempotencyKeyDigest: spawn.idempotencyKeyDigest || null,
    ownerThreadId: spawn.ownerThreadId || null,
    requestDigest: spawn.requestDigest || null,
    successDefinition: spawn.successDefinition || null,
    ownershipMode: spawn.ownershipMode || null,
    executionRoot: spawn.executionRoot || null,
    ...(Object.hasOwn(spawn, "providerCapabilityDigest")
      ? { providerCapabilityDigest: spawn.providerCapabilityDigest }
      : {})
  };
  return stable;
}

function stableProfileBinding(profile) {
  if (!isPlainRecord(profile)) return null;
  const stable = {};
  for (const [key, value] of Object.entries(profile)) {
    if (key !== "grokVersion" && value !== undefined) stable[key] = value;
  }
  return stable;
}

function launchBinding(job) {
  return {
    schemaVersion: 2,
    workerId: job?.id,
    kind: job?.kind,
    jobClass: job?.jobClass,
    write: Boolean(job?.write),
    host: job?.host || null,
    controlWorkspaceId: job?.controlWorkspaceId || null,
    profile: stableProfileBinding(job?.profile),
    role: job?.role || null,
    model: job?.model || null,
    effort: job?.effort || null,
    request: stableRequestBinding(job)
  };
}

export function launchContractDigest(job) {
  return workerLaunchDigest(launchBinding(job));
}

export function createWorkerAuthorization({
  job,
  principal,
  nonce = crypto.randomBytes(16).toString("hex"),
  issuedAt = new Date().toISOString()
} = {}) {
  if (!job?.id
    || principal?.hostKind !== job.host?.kind
    || principal?.threadId !== job.host?.sessionId
    || !ID_HEX.test(nonce)) {
    throw new CompanionError("E_AUTH_REQUIRED", "Worker launch authorization could not be bound to its trusted owner.");
  }
  const requestDigest = job.request?.spawn?.requestDigest;
  if (!SHA256_HEX.test(requestDigest || "")
    || !SHA256_HEX.test(job.request?.providerPromptDigest || "")) {
    throw new CompanionError("E_STATE", "Worker launch authorization requires durable request and provider-prompt digests.");
  }
  return Object.freeze({
    schemaVersion: WORKER_AUTHORIZATION_SCHEMA_VERSION,
    authorizationId: crypto.randomBytes(16).toString("hex"),
    purpose: "launch-worker",
    workerId: job.id,
    owner: Object.freeze({
      hostKind: principal.hostKind,
      sessionId: principal.threadId,
      pluginId: principal.pluginId || null
    }),
    controlWorkspaceId: job.controlWorkspaceId || null,
    requestDigest,
    launchContractDigest: launchContractDigest(job),
    nonce,
    issuedAt,
    dispatchAttemptId: null,
    dispatchFence: null
  });
}

export function assertWorkerAuthorization(job, { allowLegacy = true } = {}) {
  const authorization = job?.workerAuthorization;
  if (allowLegacy && authorization?.schemaVersion === 1) return authorization;
  if (!authorization || authorization.schemaVersion !== WORKER_AUTHORIZATION_SCHEMA_VERSION) {
    throw new CompanionError("E_AUTH_REQUIRED", "Worker launch authorization is missing or unsupported.");
  }
  const authorizationKeys = new Set([
    "schemaVersion",
    "authorizationId",
    "purpose",
    "workerId",
    "owner",
    "controlWorkspaceId",
    "requestDigest",
    "launchContractDigest",
    "nonce",
    "issuedAt",
    "dispatchAttemptId",
    "dispatchFence"
  ]);
  const ownerKeys = new Set(["hostKind", "sessionId", "pluginId"]);
  const exact = Object.keys(authorization).every((key) => authorizationKeys.has(key))
    && Object.keys(authorization.owner || {}).every((key) => ownerKeys.has(key))
    && authorization.purpose === "launch-worker"
    && ID_HEX.test(authorization.authorizationId || "")
    && ID_HEX.test(authorization.nonce || "")
    && authorization.workerId === job.id
    && authorization.owner?.hostKind === job.host?.kind
    && authorization.owner?.sessionId === job.host?.sessionId
    && (authorization.owner.pluginId === null
      || (typeof authorization.owner.pluginId === "string" && authorization.owner.pluginId.length <= 256))
    && authorization.controlWorkspaceId === (job.controlWorkspaceId || null)
    && authorization.requestDigest === job.request?.spawn?.requestDigest
    && SHA256_HEX.test(authorization.requestDigest || "")
    && SHA256_HEX.test(job.request?.providerPromptDigest || "")
    && (typeof job.request?.prompt !== "string"
      || textDigest(job.request.prompt) === job.request.providerPromptDigest)
    && authorization.launchContractDigest === launchContractDigest(job)
    && validIsoTimestamp(authorization.issuedAt)
    && (authorization.dispatchAttemptId === null || ID_HEX.test(authorization.dispatchAttemptId || ""))
    && (authorization.dispatchFence === null
      || (Number.isSafeInteger(authorization.dispatchFence) && authorization.dispatchFence > 0));
  if (!exact) {
    throw new CompanionError("E_AUTH_REQUIRED", "Worker launch authorization no longer matches its durable contract.");
  }
  return authorization;
}

export function bindWorkerAuthorizationAttempt(authorization, { attemptId, fence } = {}) {
  if (authorization?.schemaVersion !== WORKER_AUTHORIZATION_SCHEMA_VERSION
    || !ID_HEX.test(attemptId || "")
    || !Number.isSafeInteger(fence)
    || fence < 1) {
    throw new CompanionError("E_STATE", "Worker launch attempt cannot be bound to this authorization.");
  }
  return Object.freeze({
    ...authorization,
    dispatchAttemptId: attemptId,
    dispatchFence: fence
  });
}

export function isSupportedWorkerDispatch(dispatch) {
  return dispatch?.schemaVersion === LEGACY_WORKER_DISPATCH_SCHEMA_VERSION
    || dispatch?.schemaVersion === WORKER_DISPATCH_OUTBOX_SCHEMA_VERSION;
}

export function isDispatchV2(dispatch) {
  return dispatch?.schemaVersion === WORKER_DISPATCH_OUTBOX_SCHEMA_VERSION;
}

export function assertDispatchV2Structure(dispatch) {
  const timestamps = [
    "createdAt",
    "updatedAt",
    "claimedAt",
    "controllerStartedAt",
    "workerStartedAt",
    "providerStartedAt",
    "providerRotatedAt",
    "providerRotationAuthorizedAt",
    "providerLaunchUnsettledAt",
    "providerRotationUnsettledAt",
    "workerLaunchUnsettledAt",
    "failedAt",
    "runtimeLostAt"
  ];
  const exact = isPlainRecord(dispatch)
    && dispatch.schemaVersion === WORKER_DISPATCH_OUTBOX_SCHEMA_VERSION
    && Object.keys(dispatch).every((key) => DISPATCH_KEYS.has(key))
    && DISPATCH_STATES.has(dispatch.state)
    && Number.isSafeInteger(dispatch.fence)
    && dispatch.fence >= 0
    && Number.isSafeInteger(dispatch.providerGeneration)
    && dispatch.providerGeneration >= 0
    && (dispatch.nextProviderGeneration === null
      || (Number.isSafeInteger(dispatch.nextProviderGeneration)
        && dispatch.nextProviderGeneration === dispatch.providerGeneration + 1))
    && validIsoTimestamp(dispatch.createdAt)
    && validIsoTimestamp(dispatch.updatedAt)
    && timestamps.every((key) => (
      dispatch[key] === null
      || dispatch[key] === undefined
      || validIsoTimestamp(dispatch[key])
    ))
    && (dispatch.providerRotationCount === undefined
      || (Number.isSafeInteger(dispatch.providerRotationCount) && dispatch.providerRotationCount >= 1));
  if (!exact) {
    throw new CompanionError("E_STATE", "Worker dispatch-v2 state is malformed or unsupported.");
  }

  const pending = dispatch.state === "pending";
  const claimed = dispatch.state === "claimed";
  const attemptValid = pending
    ? dispatch.attemptId === null && dispatch.fence === 0 && dispatch.claimedAt === null
    : ID_HEX.test(dispatch.attemptId || "")
      && dispatch.fence >= 1
      && validIsoTimestamp(dispatch.claimedAt);
  if (!attemptValid) {
    throw new CompanionError("E_STATE", "Worker dispatch-v2 attempt identity is inconsistent with its state.");
  }

  if (claimed) {
    const lease = dispatch.lease;
    const claimedAtMs = Date.parse(dispatch.claimedAt);
    const expiresAtMs = Date.parse(lease?.expiresAt || "");
    const leaseValid = isPlainRecord(lease)
      && Object.keys(lease).length === LEASE_KEYS.size
      && Object.keys(lease).every((key) => LEASE_KEYS.has(key))
      && ID_HEX.test(lease.leaseId || "")
      && typeof lease.holderId === "string"
      && lease.holderId.length > 0
      && lease.holderId.length <= 256
      && lease.fence === dispatch.fence
      && lease.claimedAt === dispatch.claimedAt
      && validIsoTimestamp(lease.claimedAt)
      && validIsoTimestamp(lease.expiresAt)
      && expiresAtMs > claimedAtMs;
    if (!leaseValid) {
      throw new CompanionError("E_STATE", "Worker dispatch-v2 lease is malformed or not bound to its fence.");
    }
  } else if (dispatch.lease !== null) {
    throw new CompanionError("E_STATE", "Worker dispatch-v2 retains a lease outside the claimed state.");
  }

  if (pending && (dispatch.providerGeneration !== 0 || dispatch.nextProviderGeneration !== null)) {
    throw new CompanionError("E_STATE", "Pending worker dispatch-v2 has impossible provider generation state.");
  }
  if (dispatch.state === "provider-started" && dispatch.providerGeneration < 1) {
    throw new CompanionError("E_STATE", "Provider-started dispatch-v2 requires a positive provider generation.");
  }
  if (dispatch.state === "controller-started" && !validIsoTimestamp(dispatch.controllerStartedAt)) {
    throw new CompanionError("E_STATE", "Controller-started dispatch-v2 is missing its durable timestamp.");
  }
  if (dispatch.state === "worker-started"
    && (!validIsoTimestamp(dispatch.controllerStartedAt) || !validIsoTimestamp(dispatch.workerStartedAt))) {
    throw new CompanionError("E_STATE", "Worker-started dispatch-v2 is missing its durable transition timestamps.");
  }
  if (dispatch.state === "provider-started"
    && (!validIsoTimestamp(dispatch.controllerStartedAt)
      || !validIsoTimestamp(dispatch.workerStartedAt)
      || !validIsoTimestamp(dispatch.providerStartedAt))) {
    throw new CompanionError("E_STATE", "Provider-started dispatch-v2 is missing its durable transition timestamps.");
  }
  if (dispatch.state === "failed" && !validIsoTimestamp(dispatch.failedAt)) {
    throw new CompanionError("E_STATE", "Failed dispatch-v2 is missing its durable failure timestamp.");
  }

  return dispatch;
}

export function assertDispatchV2(dispatch, { authorization = null, consumption = null } = {}) {
  assertDispatchV2Structure(dispatch);
  const pending = dispatch.state === "pending";

  if (authorization) {
    const expectedAttempt = pending ? null : dispatch.attemptId;
    const expectedFence = pending ? null : dispatch.fence;
    if (authorization.dispatchAttemptId !== expectedAttempt
      || authorization.dispatchFence !== expectedFence) {
      throw new CompanionError("E_AUTH_REQUIRED", "Worker launch authorization is not bound to the active dispatch fence.");
    }
  } else {
    const digestPresent = Object.hasOwn(consumption || {}, "digest");
    const consumedAtPresent = Object.hasOwn(consumption || {}, "consumedAt");
    const completeConsumption = digestPresent
      && consumedAtPresent
      && SHA256_HEX.test(consumption?.digest || "")
      && validIsoTimestamp(consumption?.consumedAt);
    const partialOrMalformedConsumption = digestPresent !== consumedAtPresent
      || ((digestPresent || consumedAtPresent) && !completeConsumption);
    if (partialOrMalformedConsumption
      || (["pending", "claimed", "controller-started"].includes(dispatch.state))
      || (dispatch.state !== "failed" && !completeConsumption)) {
      throw new CompanionError("E_AUTH_REQUIRED", "Active dispatch-v2 is missing launch authorization or a durable consumption record.");
    }
  }
  return dispatch;
}

export function createDispatchOutbox({ createdAt = new Date().toISOString() } = {}) {
  return Object.freeze({
    schemaVersion: WORKER_DISPATCH_OUTBOX_SCHEMA_VERSION,
    state: "pending",
    attemptId: null,
    fence: 0,
    lease: null,
    providerGeneration: 0,
    nextProviderGeneration: null,
    claimedAt: null,
    createdAt,
    updatedAt: createdAt
  });
}

export function dispatchLeaseExpired(dispatch, at = Date.now()) {
  if (!isDispatchV2(dispatch) || dispatch.state !== "claimed") return false;
  assertDispatchV2(dispatch, { authorization: {
    dispatchAttemptId: dispatch.attemptId,
    dispatchFence: dispatch.fence
  } });
  const expiresAt = Date.parse(dispatch.lease?.expiresAt || "");
  return Number.isFinite(expiresAt) && expiresAt <= at;
}

export function assertDispatchFence(dispatch, fence) {
  if (isDispatchV2(dispatch)
    && (!Number.isSafeInteger(fence) || fence < 1 || dispatch.fence !== fence)) {
    throw new CompanionError("E_STATE", "Worker dispatch fence does not match the active lease.");
  }
  return dispatch;
}
