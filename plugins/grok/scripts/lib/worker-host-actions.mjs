/**
 * P2.2 durable host-action role admission.
 *
 * A provider may ask for one read-only role for a future child/follow-up. The
 * broker binds that request to the exact completed provider generation. An
 * exact task owner may later grant or deny it through a broker-branded
 * principal. Neither operation changes the current worker.
 */
import crypto from "node:crypto";
import path from "node:path";

import { CompanionError } from "./errors.mjs";
import {
  ensurePrivateStateDirectory,
  now,
  readPrivateJsonFile,
  withWorkspaceStateTransaction,
  writePrivateJsonFile
} from "./state.mjs";
import { assertBrokerMutationAuthority } from "./worker-authority.mjs";
import { profileFor } from "./profiles.mjs";
import {
  assertContextPacket,
  assertContextReceipt
} from "./worker-context.mjs";
import {
  assertRoleDigest,
  assertRuntimeRolePolicy,
  buildRuntimeRolePolicy,
  materializeRole
} from "./worker-roles.mjs";
import {
  assertDispatchV2Structure,
  isDispatchV2,
  isSupportedWorkerDispatch
} from "./worker-launch-contract.mjs";

export const HOST_ACTION_SCHEMA_VERSION = 1;
export const HOST_ACTION_REQUEST_SCHEMA_VERSION = 1;
export const HOST_ACTION_DECISION_SCHEMA_VERSION = 1;
export const HOST_ACTION_GRANT_SCHEMA_VERSION = 1;
export const HOST_ACTION_KIND_ROLE_ADMISSION = "role_admission";
export const HOST_ACTION_APPLICATION = "future-admission-only";
export const ROLE_ADMISSION_REQUESTED_ROLE_IDS = Object.freeze([
  "reviewer",
  "security",
  "test"
]);

const SHA256_HEX = /^[a-f0-9]{64}$/;
const REQUEST_ID = /^har-[a-f0-9]{24}$/;
const DECISION_ID = /^had-[a-f0-9]{24}$/;
const GRANT_ID = /^hag-[a-f0-9]{24}$/;
const ALLOWED_ROLE_IDS = new Set(ROLE_ADMISSION_REQUESTED_ROLE_IDS);
const SYNTACTIC_ROLE_IDS = new Set([
  ...ROLE_ADMISSION_REQUESTED_ROLE_IDS,
  "implementer"
]);
const PROVIDER_REQUEST_KEYS = new Set([
  "schemaVersion",
  "kind",
  "requestedRoleId"
]);
const SOURCE_BINDING_KEYS = new Set([
  "workerId",
  "attemptId",
  "dispatchFence",
  "providerGeneration",
  "workerProcessDigest",
  "providerProcessDigest",
  "providerSessionDigest"
]);
const PARENT_BINDING_KEYS = new Set([
  "lineageWorkerId",
  "resumeJobId",
  "currentRoleId",
  "currentRoleDigest",
  "runtimeRolePolicyDigest",
  "providerProfileDigest",
  "contextManifestId",
  "contextManifestDigest",
  "contextReceiptDigest",
  "providerPromptDigest"
]);
const REQUEST_KEYS = new Set([
  "schemaVersion",
  "requestId",
  "kind",
  "requestedRoleId",
  "requestedAt",
  "sourceBinding",
  "parentBinding",
  "requestDigest"
]);
const DECISION_KEYS = new Set([
  "schemaVersion",
  "decisionId",
  "decision",
  "decidedAt",
  "ownerThreadId",
  "ownerPluginId",
  "requestId",
  "requestDigest",
  "idempotencyKeyDigest",
  "application",
  "applied",
  "decisionDigest"
]);
const GRANT_KEYS = new Set([
  "schemaVersion",
  "grantId",
  "requestedRoleId",
  "sourceWorkerId",
  "sourceRequestId",
  "sourceRequestDigest",
  "sourceDecisionId",
  "sourceDecisionDigest",
  "parentBinding",
  "targetRole",
  "targetRuntimeRolePolicy",
  "grantedAt",
  "application",
  "applied",
  "consumable",
  "grantDigest"
]);
const RECORD_KEYS = new Set([
  "schemaVersion",
  "request",
  "decision",
  "grant"
]);
const IDEMPOTENCY_KEYS = new Set([
  "schemaVersion",
  "workerId",
  "ownerThreadId",
  "ownerPluginId",
  "requestId",
  "requestDigest",
  "decision",
  "decisionDigest",
  "idempotencyKeyDigest",
  "committedAt",
  "recordDigest"
]);
const PUBLIC_REQUEST_KEYS = new Set([
  "schemaVersion",
  "kind",
  "requestId",
  "requestedRoleId",
  "requestedAt",
  "status",
  "decision",
  "application",
  "applied"
]);
const PUBLIC_DECISION_KEYS = new Set([
  "decision",
  "decidedAt",
  "application",
  "applied"
]);
const ELIGIBILITY_KEYS = new Set([
  "sourceWorkerId",
  "sourceRequestId",
  "sourceRequestDigest",
  "sourceDecisionId",
  "sourceDecisionDigest",
  "grantId",
  "grantDigest",
  "lineageWorkerId",
  "resumeJobId",
  "parentRole",
  "parentRuntimeRolePolicy",
  "parentProfile",
  "parentContextManifest",
  "parentContextReceipt",
  "providerPromptDigest",
  "targetProfile"
]);

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  return isPlainRecord(value)
    && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key));
}

function canonicalize(value, ancestors = new Set()) {
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) {
    throw new CompanionError("E_STATE", "Host-action state contains cyclic data.");
  }
  ancestors.add(value);
  let normalized;
  if (Array.isArray(value)) {
    normalized = value.map((item) => canonicalize(item, ancestors));
  } else {
    normalized = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) normalized[key] = canonicalize(value[key], ancestors);
    }
  }
  ancestors.delete(value);
  return normalized;
}

function stableDigest(value) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function securityProfileDigest(profile) {
  return stableDigest({
    id: profile?.id,
    contractVersion: profile?.contractVersion,
    transport: profile?.transport,
    agent: profile?.agent,
    sandbox: profile?.sandbox,
    permissionMode: profile?.permissionMode,
    webSearch: profile?.webSearch,
    subagents: profile?.subagents,
    isolatedLeader: profile?.isolatedLeader,
    agentProfileDigest: profile?.agentProfileDigest,
    allowedTools: profile?.allowedTools,
    deniedTools: profile?.deniedTools,
    providerToolIds: profile?.providerToolIds,
    deniedProviderToolIds: profile?.deniedProviderToolIds
  });
}

function validIsoTimestamp(value) {
  if (typeof value !== "string" || !value) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString() === value;
}

function stateError(message) {
  throw new CompanionError("E_STATE", message);
}

function schemaError(message) {
  throw new CompanionError("E_SCHEMA", message);
}

function usageError(message) {
  throw new CompanionError("E_USAGE", message);
}

function idempotencyConflict(message) {
  throw new CompanionError("E_IDEMPOTENCY_CONFLICT", message);
}

function assertIdempotencyKey(value) {
  if (typeof value !== "string"
    || value.length < 8
    || value.length > 256
    || /[\r\n\0]/.test(value)) {
    usageError("idempotencyKey must be a control-free string of length 8–256.");
  }
  return value;
}

/**
 * Validate the optional, body-free provider report field. Implementer is a
 * syntactically recognized request so the controller can reject it with the
 * capability-specific E_CAPABILITY error instead of report-format repair.
 */
export function validateProviderHostActionRequest(value, { present = true } = {}) {
  if (!present) return Object.freeze({ ok: true, value: undefined, issues: [] });
  if (value === null) return Object.freeze({ ok: true, value: null, issues: [] });
  const issues = [];
  if (!hasExactKeys(value, PROVIDER_REQUEST_KEYS)) {
    issues.push("Structured worker report hostActionRequest must use exactly schemaVersion, kind, and requestedRoleId.");
  } else {
    if (value.schemaVersion !== HOST_ACTION_REQUEST_SCHEMA_VERSION) {
      issues.push("Structured worker report hostActionRequest schemaVersion must be 1.");
    }
    if (value.kind !== HOST_ACTION_KIND_ROLE_ADMISSION) {
      issues.push("Structured worker report hostActionRequest kind must be role_admission.");
    }
    if (!SYNTACTIC_ROLE_IDS.has(value.requestedRoleId)) {
      issues.push("Structured worker report hostActionRequest requestedRoleId must be reviewer, security, test, or implementer.");
    }
  }
  if (issues.length) return Object.freeze({ ok: false, value: null, issues });
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      schemaVersion: HOST_ACTION_REQUEST_SCHEMA_VERSION,
      kind: HOST_ACTION_KIND_ROLE_ADMISSION,
      requestedRoleId: value.requestedRoleId
    }),
    issues: []
  });
}

function assertExactProcessWitness(identity, {
  workerId,
  attemptId,
  fence,
  providerGeneration = null,
  worker = false
}) {
  const processGroupValid = process.platform === "win32"
    ? identity?.processGroupId === null
    : identity?.processGroupId === identity?.pid;
  if (!isPlainRecord(identity)
    || !Number.isInteger(identity.pid)
    || identity.pid <= 0
    || typeof identity.startToken !== "string"
    || !identity.startToken
    || identity.startToken.length > 256
    || identity.startToken === "[REDACTED]"
    || !processGroupValid
    || identity.commandMarker !== workerId
    || identity.dispatchAttemptId !== attemptId
    || identity.dispatchFence !== fence
    || (worker && (typeof identity.nonce !== "string" || !identity.nonce))
    || (!worker && identity.providerGeneration !== providerGeneration)) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Host-action request is not bound to the exact active process generation."
    );
  }
  return identity;
}

function providerSessionDigest(sessionId) {
  if (typeof sessionId !== "string"
    || !sessionId
    || sessionId.length > 256
    || /[\r\n\0]/.test(sessionId)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Provider session identity is unavailable or malformed.");
  }
  return stableDigest({ providerSessionId: sessionId });
}

function normalizeSourceBinding(binding) {
  if (!hasExactKeys(binding, SOURCE_BINDING_KEYS)
    || typeof binding.workerId !== "string"
    || !binding.workerId
    || typeof binding.attemptId !== "string"
    || !/^[a-f0-9]{32}$/.test(binding.attemptId)
    || !Number.isSafeInteger(binding.dispatchFence)
    || binding.dispatchFence < 1
    || !Number.isSafeInteger(binding.providerGeneration)
    || binding.providerGeneration < 1
    || !SHA256_HEX.test(binding.workerProcessDigest || "")
    || !SHA256_HEX.test(binding.providerProcessDigest || "")
    || !SHA256_HEX.test(binding.providerSessionDigest || "")) {
    stateError("Host-action source binding is malformed.");
  }
  return Object.freeze({ ...binding });
}

function normalizeParentBinding(binding) {
  if (!hasExactKeys(binding, PARENT_BINDING_KEYS)
    || typeof binding.lineageWorkerId !== "string"
    || !binding.lineageWorkerId
    || (binding.resumeJobId !== null && typeof binding.resumeJobId !== "string")
    || typeof binding.currentRoleId !== "string"
    || !SHA256_HEX.test(binding.currentRoleDigest || "")
    || !SHA256_HEX.test(binding.runtimeRolePolicyDigest || "")
    || !SHA256_HEX.test(binding.providerProfileDigest || "")
    || typeof binding.contextManifestId !== "string"
    || !binding.contextManifestId
    || !SHA256_HEX.test(binding.contextManifestDigest || "")
    || !SHA256_HEX.test(binding.contextReceiptDigest || "")
    || !SHA256_HEX.test(binding.providerPromptDigest || "")) {
    stateError("Host-action parent binding is malformed.");
  }
  return Object.freeze({ ...binding });
}

function assertDispatchSource(job, {
  attemptId,
  dispatchFence,
  providerGeneration,
  providerSessionId
}) {
  const dispatch = job?.request?.spawn?.dispatch;
  assertDispatchV2Structure(dispatch);
  if (!isSupportedWorkerDispatch(dispatch)
    || !isDispatchV2(dispatch)
    || dispatch.state !== "provider-started"
    || dispatch.attemptId !== attemptId
    || dispatch.fence !== dispatchFence
    || dispatch.providerGeneration !== providerGeneration
    || !SHA256_HEX.test(job?.request?.spawn?.consumedLaunchContractDigest || "")
    || !validIsoTimestamp(job?.request?.spawn?.launchContractConsumedAt)) {
    throw new CompanionError(
      "E_RECURSION",
      "Host-action request is not bound to the exact provider-started dispatch."
    );
  }
  const workerProcess = assertExactProcessWitness(job.workerProcess, {
    workerId: job.id,
    attemptId,
    fence: dispatchFence,
    worker: true
  });
  const providerProcess = assertExactProcessWitness(job.providerProcess, {
    workerId: job.id,
    attemptId,
    fence: dispatchFence,
    providerGeneration
  });
  if (job.grokSessionId != null && job.grokSessionId !== providerSessionId) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Provider session identity changed before host-action persistence.");
  }
  return Object.freeze({
    workerId: job.id,
    attemptId,
    dispatchFence,
    providerGeneration,
    workerProcessDigest: stableDigest(workerProcess),
    providerProcessDigest: stableDigest(providerProcess),
    providerSessionDigest: providerSessionDigest(providerSessionId)
  });
}

function buildParentBinding(job) {
  const role = assertRoleDigest(job?.role);
  if (role.id !== job?.request?.roleId || Boolean(job.write) !== role.write) {
    throw new CompanionError("E_ROLE", "Current worker role identity drifted.");
  }
  const policy = job?.request?.runtimeRolePolicy;
  assertRuntimeRolePolicy(policy, { role, profile: job?.profile });
  const request = job?.request;
  const manifest = request?.contextManifest;
  if (!isPlainRecord(manifest)
    || typeof manifest.manifestId !== "string"
    || !manifest.manifestId
    || !SHA256_HEX.test(manifest.digest || "")) {
    throw new CompanionError("E_CONTEXT_DRIFT", "Host-action request requires an exact context manifest.");
  }
  const lineageWorkerId = request?.providerHomeId;
  if (typeof lineageWorkerId !== "string" || !lineageWorkerId) {
    throw new CompanionError("E_CONTEXT_DRIFT", "Host-action request requires exact root lineage.");
  }
  assertContextPacket(request.contextPacket, { envelope: request.envelope });
  assertContextReceipt(request.contextReceipt, {
    contextPacket: request.contextPacket,
    rolePolicy: policy,
    contextManifest: manifest,
    lineageWorkerId,
    effectivePromptDigest: request.providerPromptDigest
  });
  if (!SHA256_HEX.test(request.providerPromptDigest || "")) {
    throw new CompanionError("E_AUTH_REQUIRED", "Host-action request requires the exact provider prompt digest.");
  }
  const resumeJobId = request.resumeJobId ?? null;
  if (resumeJobId !== null && (typeof resumeJobId !== "string" || !resumeJobId)) {
    throw new CompanionError("E_CONTEXT_DRIFT", "Host-action request resume identity is malformed.");
  }
  return Object.freeze({
    lineageWorkerId,
    resumeJobId,
    currentRoleId: role.id,
    currentRoleDigest: role.digest,
    runtimeRolePolicyDigest: policy.digest,
    providerProfileDigest: securityProfileDigest(job.profile),
    contextManifestId: manifest.manifestId,
    contextManifestDigest: manifest.digest,
    contextReceiptDigest: stableDigest(request.contextReceipt),
    providerPromptDigest: request.providerPromptDigest
  });
}

function requestDigestBody(request) {
  return {
    schemaVersion: request.schemaVersion,
    kind: request.kind,
    requestedRoleId: request.requestedRoleId,
    requestedAt: request.requestedAt,
    sourceBinding: request.sourceBinding,
    parentBinding: request.parentBinding
  };
}

function normalizeRequest(request) {
  if (!hasExactKeys(request, REQUEST_KEYS)
    || request.schemaVersion !== HOST_ACTION_REQUEST_SCHEMA_VERSION
    || !REQUEST_ID.test(request.requestId || "")
    || request.kind !== HOST_ACTION_KIND_ROLE_ADMISSION
    || !ALLOWED_ROLE_IDS.has(request.requestedRoleId)
    || !validIsoTimestamp(request.requestedAt)
    || !SHA256_HEX.test(request.requestDigest || "")) {
    stateError("Host-action request is malformed.");
  }
  const sourceBinding = normalizeSourceBinding(request.sourceBinding);
  const parentBinding = normalizeParentBinding(request.parentBinding);
  const expectedDigest = stableDigest(requestDigestBody({
    ...request,
    sourceBinding,
    parentBinding
  }));
  if (request.requestDigest !== expectedDigest
    || request.requestId !== `har-${expectedDigest.slice(0, 24)}`) {
    stateError("Host-action request identity or digest is invalid.");
  }
  return Object.freeze({
    ...request,
    sourceBinding,
    parentBinding
  });
}

function decisionDigestBody(decision) {
  return {
    schemaVersion: decision.schemaVersion,
    decision: decision.decision,
    decidedAt: decision.decidedAt,
    ownerThreadId: decision.ownerThreadId,
    ownerPluginId: decision.ownerPluginId,
    requestId: decision.requestId,
    requestDigest: decision.requestDigest,
    idempotencyKeyDigest: decision.idempotencyKeyDigest,
    application: decision.application,
    applied: decision.applied
  };
}

function normalizeDecision(decision) {
  if (decision === null) return null;
  if (!hasExactKeys(decision, DECISION_KEYS)
    || decision.schemaVersion !== HOST_ACTION_DECISION_SCHEMA_VERSION
    || !DECISION_ID.test(decision.decisionId || "")
    || !["grant", "deny"].includes(decision.decision)
    || !validIsoTimestamp(decision.decidedAt)
    || typeof decision.ownerThreadId !== "string"
    || !decision.ownerThreadId
    || typeof decision.ownerPluginId !== "string"
    || !decision.ownerPluginId
    || !REQUEST_ID.test(decision.requestId || "")
    || !SHA256_HEX.test(decision.requestDigest || "")
    || !SHA256_HEX.test(decision.idempotencyKeyDigest || "")
    || decision.application !== HOST_ACTION_APPLICATION
    || decision.applied !== false
    || !SHA256_HEX.test(decision.decisionDigest || "")) {
    stateError("Host-action decision is malformed.");
  }
  const expectedDigest = stableDigest(decisionDigestBody(decision));
  if (decision.decisionDigest !== expectedDigest
    || decision.decisionId !== `had-${expectedDigest.slice(0, 24)}`) {
    stateError("Host-action decision identity or digest is invalid.");
  }
  return Object.freeze({ ...decision });
}

function grantDigestBody(grant) {
  return {
    schemaVersion: grant.schemaVersion,
    requestedRoleId: grant.requestedRoleId,
    sourceWorkerId: grant.sourceWorkerId,
    sourceRequestId: grant.sourceRequestId,
    sourceRequestDigest: grant.sourceRequestDigest,
    sourceDecisionId: grant.sourceDecisionId,
    sourceDecisionDigest: grant.sourceDecisionDigest,
    parentBinding: grant.parentBinding,
    targetRole: grant.targetRole,
    targetRuntimeRolePolicy: grant.targetRuntimeRolePolicy,
    grantedAt: grant.grantedAt,
    application: grant.application,
    applied: grant.applied,
    consumable: grant.consumable
  };
}

function normalizeGrant(grant) {
  if (grant === null) return null;
  if (!hasExactKeys(grant, GRANT_KEYS)
    || grant.schemaVersion !== HOST_ACTION_GRANT_SCHEMA_VERSION
    || !GRANT_ID.test(grant.grantId || "")
    || !ALLOWED_ROLE_IDS.has(grant.requestedRoleId)
    || typeof grant.sourceWorkerId !== "string"
    || !grant.sourceWorkerId
    || !REQUEST_ID.test(grant.sourceRequestId || "")
    || !SHA256_HEX.test(grant.sourceRequestDigest || "")
    || !DECISION_ID.test(grant.sourceDecisionId || "")
    || !SHA256_HEX.test(grant.sourceDecisionDigest || "")
    || !validIsoTimestamp(grant.grantedAt)
    || grant.application !== HOST_ACTION_APPLICATION
    || grant.applied !== false
    || grant.consumable !== true
    || !SHA256_HEX.test(grant.grantDigest || "")) {
    stateError("Host-action grant is malformed.");
  }
  const parentBinding = normalizeParentBinding(grant.parentBinding);
  const targetRole = assertRoleDigest(grant.targetRole);
  if (targetRole.id !== grant.requestedRoleId || targetRole.write) {
    stateError("Host-action grant target role is invalid.");
  }
  const targetRuntimeRolePolicy = assertRuntimeRolePolicy(
    grant.targetRuntimeRolePolicy,
    { role: targetRole }
  );
  const normalized = {
    ...grant,
    parentBinding,
    targetRole,
    targetRuntimeRolePolicy
  };
  const expectedDigest = stableDigest(grantDigestBody(normalized));
  if (grant.grantDigest !== expectedDigest
    || grant.grantId !== `hag-${expectedDigest.slice(0, 24)}`) {
    stateError("Host-action grant identity or digest is invalid.");
  }
  return Object.freeze(normalized);
}

export function assertHostActionRecord(record) {
  if (record === null || record === undefined) return null;
  if (!hasExactKeys(record, RECORD_KEYS)
    || record.schemaVersion !== HOST_ACTION_SCHEMA_VERSION) {
    stateError("Host-action record is malformed.");
  }
  const request = normalizeRequest(record.request);
  const decision = normalizeDecision(record.decision);
  const grant = normalizeGrant(record.grant);
  if (!decision && grant) stateError("Host-action grant has no decision.");
  if (decision) {
    if (decision.requestId !== request.requestId
      || decision.requestDigest !== request.requestDigest) {
      stateError("Host-action decision does not match its request.");
    }
    if (decision.decision === "deny" && grant) {
      stateError("A denied host action must not retain a grant.");
    }
    if (decision.decision === "grant") {
      if (!grant
        || grant.sourceWorkerId !== request.sourceBinding.workerId
        || grant.sourceRequestId !== request.requestId
        || grant.sourceRequestDigest !== request.requestDigest
        || grant.sourceDecisionId !== decision.decisionId
        || grant.sourceDecisionDigest !== decision.decisionDigest
        || grant.requestedRoleId !== request.requestedRoleId
        || grant.grantedAt !== decision.decidedAt
        || stableDigest(grant.parentBinding) !== stableDigest(request.parentBinding)) {
        stateError("Host-action grant does not match its request and decision.");
      }
    }
  }
  return Object.freeze({
    schemaVersion: HOST_ACTION_SCHEMA_VERSION,
    request,
    decision,
    grant
  });
}

function assertRequestStillBound(job, request, { providerSessionId = job?.grokSessionId } = {}) {
  if (job?.id !== request.sourceBinding.workerId) {
    throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
  }
  const source = assertDispatchSource(job, {
    attemptId: request.sourceBinding.attemptId,
    dispatchFence: request.sourceBinding.dispatchFence,
    providerGeneration: request.sourceBinding.providerGeneration,
    providerSessionId
  });
  if (stableDigest(source) !== stableDigest(request.sourceBinding)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Host-action process or session binding drifted.");
  }
  const parent = buildParentBinding(job);
  if (stableDigest(parent) !== stableDigest(request.parentBinding)) {
    throw new CompanionError("E_CONTEXT_DRIFT", "Host-action parent role, profile, context, or lineage drifted.");
  }
  return request;
}

/**
 * Mint one broker-owned request at the trusted final-provider boundary.
 */
export function mintHostActionRequest(job, {
  providerRequest,
  dispatchAttemptId,
  dispatchFence,
  providerGeneration,
  providerSessionId
} = {}) {
  const validated = validateProviderHostActionRequest(providerRequest, { present: true });
  if (!validated.ok || !validated.value) {
    schemaError(validated.issues[0] || "Host-action request is missing or malformed.");
  }
  if (validated.value.requestedRoleId === "implementer") {
    throw new CompanionError(
      "E_CAPABILITY",
      "Implementer admission is disabled until Phase 3 isolated execution is available."
    );
  }
  if (!ALLOWED_ROLE_IDS.has(validated.value.requestedRoleId)) {
    throw new CompanionError("E_CAPABILITY", "Requested worker role is not grantable.");
  }
  if (job?.hostAction != null) stateError("Worker already has a host-action request.");
  const sourceBinding = assertDispatchSource(job, {
    attemptId: dispatchAttemptId,
    dispatchFence,
    providerGeneration,
    providerSessionId
  });
  const parentBinding = buildParentBinding(job);
  const requestedAt = now();
  const body = {
    schemaVersion: HOST_ACTION_REQUEST_SCHEMA_VERSION,
    kind: HOST_ACTION_KIND_ROLE_ADMISSION,
    requestedRoleId: validated.value.requestedRoleId,
    requestedAt,
    sourceBinding,
    parentBinding
  };
  const requestDigest = stableDigest(body);
  return normalizeRequest({
    ...body,
    requestId: `har-${requestDigest.slice(0, 24)}`,
    requestDigest
  });
}

export function attachHostActionRequestToJob(job, options = {}) {
  const request = mintHostActionRequest(job, options);
  return {
    ...job,
    hostAction: assertHostActionRecord({
      schemaVersion: HOST_ACTION_SCHEMA_VERSION,
      request,
      decision: null,
      grant: null
    })
  };
}

function mintDecision({ principal, request, decision, keyDigest }) {
  const body = {
    schemaVersion: HOST_ACTION_DECISION_SCHEMA_VERSION,
    decision,
    decidedAt: now(),
    ownerThreadId: principal.threadId,
    ownerPluginId: principal.pluginId,
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    idempotencyKeyDigest: keyDigest,
    application: HOST_ACTION_APPLICATION,
    applied: false
  };
  const decisionDigest = stableDigest(body);
  return normalizeDecision({
    ...body,
    decisionId: `had-${decisionDigest.slice(0, 24)}`,
    decisionDigest
  });
}

function mintGrant({ job, request, decision }) {
  const targetRole = materializeRole(request.requestedRoleId);
  if (targetRole.write) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Write-role grants are disabled until Phase 3 isolated execution is available."
    );
  }
  const targetProfile = profileFor("task", false);
  const targetRuntimeRolePolicy = buildRuntimeRolePolicy({
    role: targetRole,
    profile: targetProfile
  });
  const body = {
    schemaVersion: HOST_ACTION_GRANT_SCHEMA_VERSION,
    requestedRoleId: request.requestedRoleId,
    sourceWorkerId: job.id,
    sourceRequestId: request.requestId,
    sourceRequestDigest: request.requestDigest,
    sourceDecisionId: decision.decisionId,
    sourceDecisionDigest: decision.decisionDigest,
    parentBinding: request.parentBinding,
    targetRole,
    targetRuntimeRolePolicy,
    grantedAt: decision.decidedAt,
    application: HOST_ACTION_APPLICATION,
    applied: false,
    consumable: true
  };
  const grantDigest = stableDigest(body);
  return normalizeGrant({
    ...body,
    grantId: `hag-${grantDigest.slice(0, 24)}`,
    grantDigest
  });
}

function publicDecision(record, replayed) {
  const { request, decision, grant } = record;
  return Object.freeze({
    schemaVersion: HOST_ACTION_DECISION_SCHEMA_VERSION,
    workerId: request.sourceBinding.workerId,
    requestId: request.requestId,
    requestedRoleId: request.requestedRoleId,
    decision: decision.decision,
    decidedAt: decision.decidedAt,
    application: HOST_ACTION_APPLICATION,
    applied: false,
    grant: grant
      ? Object.freeze({
        grantId: grant.grantId,
        requestedRoleId: grant.requestedRoleId,
        targetRoleDigest: grant.targetRole.digest,
        targetRuntimeRolePolicyDigest: grant.targetRuntimeRolePolicy.digest,
        application: HOST_ACTION_APPLICATION,
        applied: false,
        consumable: true
      })
      : null,
    replayed: Boolean(replayed)
  });
}

function idempotencyPath(root, keyDigest, env) {
  return path.join(
    ensurePrivateStateDirectory(root, ["idempotency", "host-action"], env),
    `${keyDigest}.json`
  );
}

function idempotencyBody(record) {
  return {
    schemaVersion: record.schemaVersion,
    workerId: record.workerId,
    ownerThreadId: record.ownerThreadId,
    ownerPluginId: record.ownerPluginId,
    requestId: record.requestId,
    requestDigest: record.requestDigest,
    decision: record.decision,
    decisionDigest: record.decisionDigest,
    idempotencyKeyDigest: record.idempotencyKeyDigest,
    committedAt: record.committedAt
  };
}

function normalizeIdempotencyRecord(record, keyDigest) {
  if (!hasExactKeys(record, IDEMPOTENCY_KEYS)
    || record.schemaVersion !== 1
    || typeof record.workerId !== "string"
    || typeof record.ownerThreadId !== "string"
    || typeof record.ownerPluginId !== "string"
    || !REQUEST_ID.test(record.requestId || "")
    || !SHA256_HEX.test(record.requestDigest || "")
    || !["grant", "deny"].includes(record.decision)
    || !SHA256_HEX.test(record.decisionDigest || "")
    || record.idempotencyKeyDigest !== keyDigest
    || !validIsoTimestamp(record.committedAt)
    || !SHA256_HEX.test(record.recordDigest || "")) {
    stateError("Host-action idempotency record is malformed.");
  }
  if (record.recordDigest !== stableDigest(idempotencyBody(record))) {
    stateError("Host-action idempotency record digest is invalid.");
  }
  return Object.freeze({ ...record });
}

function readIdempotency(root, keyDigest, env) {
  const value = readPrivateJsonFile(idempotencyPath(root, keyDigest, env), {
    missing: null,
    label: "host-action idempotency record"
  });
  return value === null ? null : normalizeIdempotencyRecord(value, keyDigest);
}

function writeIdempotency(root, record, env) {
  return writePrivateJsonFile(
    idempotencyPath(root, record.idempotencyKeyDigest, env),
    record
  );
}

function buildIdempotencyRecord({ job, principal, request, decision }) {
  const body = {
    schemaVersion: 1,
    workerId: job.id,
    ownerThreadId: principal.threadId,
    ownerPluginId: principal.pluginId,
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    decision: decision.decision,
    decisionDigest: decision.decisionDigest,
    idempotencyKeyDigest: decision.idempotencyKeyDigest,
    committedAt: decision.decidedAt
  };
  return normalizeIdempotencyRecord({
    ...body,
    recordDigest: stableDigest(body)
  }, decision.idempotencyKeyDigest);
}

function assertOwner(job, principal, root) {
  if (job?.host?.kind !== "codex" || typeof job.host.sessionId !== "string") {
    throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
  }
  return assertBrokerMutationAuthority(principal, {
    root,
    exactThreadId: job.host.sessionId
  });
}

function authorityDigest(job) {
  return stableDigest({
    host: job.host,
    role: job.role,
    write: job.write,
    profile: job.profile,
    request: job.request,
    workerProcess: job.workerProcess,
    providerProcess: job.providerProcess,
    grokSessionId: job.grokSessionId,
    controlWorkspaceId: job.controlWorkspaceId
  });
}

/**
 * Exact-owner, idempotent grant/deny. Decisions only produce future admission.
 */
export function decideHostActionRoleAdmission({
  root,
  principal,
  workerId,
  requestId,
  requestDigest,
  decision,
  idempotencyKey,
  env = process.env
} = {}) {
  assertIdempotencyKey(idempotencyKey);
  if (typeof workerId !== "string" || !workerId) usageError("workerId is required.");
  if (!REQUEST_ID.test(requestId || "")) usageError("requestId is malformed.");
  if (!SHA256_HEX.test(requestDigest || "")) usageError("requestDigest is malformed.");
  if (!["grant", "deny"].includes(decision)) usageError("decision must be grant or deny.");
  const keyDigest = stableDigest({ idempotencyKey });

  return withWorkspaceStateTransaction(root, (transaction) => {
    // Resolve the job and exact owner before observing any idempotency record.
    const initial = transaction.tryReadJob(workerId);
    if (!initial) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    assertOwner(initial, principal, root);
    const originalAuthority = authorityDigest(initial);
    const record = assertHostActionRecord(initial.hostAction);
    if (!record
      || record.request.requestId !== requestId
      || record.request.requestDigest !== requestDigest
      || record.request.sourceBinding.workerId !== workerId) {
      throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    }
    assertRequestStillBound(initial, record.request);

    const sidecar = readIdempotency(root, keyDigest, env);
    if (sidecar) {
      if (sidecar.workerId !== workerId
        || sidecar.ownerThreadId !== principal.threadId
        || sidecar.ownerPluginId !== principal.pluginId
        || sidecar.requestId !== requestId
        || sidecar.requestDigest !== requestDigest
        || sidecar.decision !== decision) {
        idempotencyConflict("idempotencyKey was reused for a different host-action decision.");
      }
      if (!record.decision
        || record.decision.decisionDigest !== sidecar.decisionDigest
        || record.decision.idempotencyKeyDigest !== keyDigest) {
        stateError("Host-action idempotency state disagrees with the durable decision.");
      }
      return publicDecision(record, true);
    }

    if (record.decision) {
      if (record.decision.decision !== decision
        || record.decision.ownerThreadId !== principal.threadId
        || record.decision.ownerPluginId !== principal.pluginId
        || record.decision.idempotencyKeyDigest !== keyDigest) {
        idempotencyConflict("Host-action request already has a different durable decision.");
      }
      writeIdempotency(root, buildIdempotencyRecord({
        job: initial,
        principal,
        request: record.request,
        decision: record.decision
      }), env);
      return publicDecision(record, true);
    }

    const durableDecision = mintDecision({
      principal,
      request: record.request,
      decision,
      keyDigest
    });
    const grant = decision === "grant"
      ? mintGrant({ job: initial, request: record.request, decision: durableDecision })
      : null;
    const updated = transaction.updateJob(workerId, (current) => {
      assertOwner(current, principal, root);
      const currentRecord = assertHostActionRecord(current.hostAction);
      if (!currentRecord
        || currentRecord.request.requestId !== requestId
        || currentRecord.request.requestDigest !== requestDigest
        || currentRecord.decision !== null) {
        stateError("Host-action request changed during decision.");
      }
      assertRequestStillBound(current, currentRecord.request);
      return {
        ...current,
        hostAction: assertHostActionRecord({
          schemaVersion: HOST_ACTION_SCHEMA_VERSION,
          request: currentRecord.request,
          decision: durableDecision,
          grant
        })
      };
    });
    if (authorityDigest(updated) !== originalAuthority) {
      stateError("Host-action decision mutated current worker authority.");
    }
    const updatedRecord = assertHostActionRecord(updated.hostAction);
    writeIdempotency(root, buildIdempotencyRecord({
      job: updated,
      principal,
      request: updatedRecord.request,
      decision: updatedRecord.decision
    }), env);
    return publicDecision(updatedRecord, false);
  }, env);
}

function publicDecisionProjection(decision) {
  if (!decision) return null;
  return Object.freeze({
    decision: decision.decision,
    decidedAt: decision.decidedAt,
    application: HOST_ACTION_APPLICATION,
    applied: false
  });
}

function normalizePublicAwaitingHostAction(value) {
  if (value === null || value === undefined) return null;
  if (!hasExactKeys(value, PUBLIC_REQUEST_KEYS)
    || value.schemaVersion !== HOST_ACTION_SCHEMA_VERSION
    || value.kind !== HOST_ACTION_KIND_ROLE_ADMISSION
    || !REQUEST_ID.test(value.requestId || "")
    || !ALLOWED_ROLE_IDS.has(value.requestedRoleId)
    || !validIsoTimestamp(value.requestedAt)
    || !["awaiting", "granted", "denied"].includes(value.status)
    || value.application !== HOST_ACTION_APPLICATION
    || value.applied !== false) {
    throw new CompanionError("E_SCHEMA", "Public awaitingHostAction is malformed.");
  }
  let decision = null;
  if (value.decision !== null) {
    if (!hasExactKeys(value.decision, PUBLIC_DECISION_KEYS)
      || !["grant", "deny"].includes(value.decision.decision)
      || !validIsoTimestamp(value.decision.decidedAt)
      || value.decision.application !== HOST_ACTION_APPLICATION
      || value.decision.applied !== false) {
      throw new CompanionError("E_SCHEMA", "Public awaitingHostAction decision is malformed.");
    }
    decision = publicDecisionProjection(value.decision);
  }
  const expectedStatus = decision
    ? (decision.decision === "grant" ? "granted" : "denied")
    : "awaiting";
  if (value.status !== expectedStatus) {
    throw new CompanionError("E_SCHEMA", "Public awaitingHostAction status disagrees with its decision.");
  }
  return Object.freeze({
    schemaVersion: HOST_ACTION_SCHEMA_VERSION,
    kind: HOST_ACTION_KIND_ROLE_ADMISSION,
    requestId: value.requestId,
    requestedRoleId: value.requestedRoleId,
    requestedAt: value.requestedAt,
    status: value.status,
    decision,
    application: HOST_ACTION_APPLICATION,
    applied: false
  });
}

export function projectAwaitingHostAction(job) {
  if (!isPlainRecord(job)) return null;
  if (job.hostAction == null && job.awaitingHostAction != null) {
    return normalizePublicAwaitingHostAction(job.awaitingHostAction);
  }
  const record = assertHostActionRecord(job.hostAction);
  if (!record) return null;
  if (record.request.sourceBinding.workerId !== job.id) {
    stateError("Host-action request belongs to a different worker.");
  }
  return normalizePublicAwaitingHostAction({
    schemaVersion: HOST_ACTION_SCHEMA_VERSION,
    kind: HOST_ACTION_KIND_ROLE_ADMISSION,
    requestId: record.request.requestId,
    requestedRoleId: record.request.requestedRoleId,
    requestedAt: record.request.requestedAt,
    status: record.decision
      ? (record.decision.decision === "grant" ? "granted" : "denied")
      : "awaiting",
    decision: publicDecisionProjection(record.decision),
    application: HOST_ACTION_APPLICATION,
    applied: false
  });
}

/**
 * Future P2.3 consumption must supply every exact parent and target binding.
 */
export function assertAdmissionGrantEligible(grant, bindings) {
  if (!hasExactKeys(bindings, ELIGIBILITY_KEYS)) {
    throw new CompanionError("E_CAPABILITY", "Complete host-action admission bindings are required.");
  }
  const durable = normalizeGrant(grant);
  if (bindings.sourceWorkerId !== durable.sourceWorkerId
    || bindings.sourceRequestId !== durable.sourceRequestId
    || bindings.sourceRequestDigest !== durable.sourceRequestDigest
    || bindings.sourceDecisionId !== durable.sourceDecisionId
    || bindings.sourceDecisionDigest !== durable.sourceDecisionDigest
    || bindings.grantId !== durable.grantId
    || bindings.grantDigest !== durable.grantDigest) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Host-action admission grant does not belong to the expected source decision."
    );
  }
  const parentRole = assertRoleDigest(bindings.parentRole);
  assertRuntimeRolePolicy(bindings.parentRuntimeRolePolicy, {
    role: parentRole,
    profile: bindings.parentProfile
  });
  assertRuntimeRolePolicy(durable.targetRuntimeRolePolicy, {
    role: durable.targetRole,
    profile: bindings.targetProfile
  });
  const observedParent = {
    lineageWorkerId: bindings.lineageWorkerId,
    resumeJobId: bindings.resumeJobId,
    currentRoleId: parentRole.id,
    currentRoleDigest: parentRole.digest,
    runtimeRolePolicyDigest: bindings.parentRuntimeRolePolicy.digest,
    providerProfileDigest: securityProfileDigest(bindings.parentProfile),
    contextManifestId: bindings.parentContextManifest?.manifestId,
    contextManifestDigest: bindings.parentContextManifest?.digest,
    contextReceiptDigest: stableDigest(bindings.parentContextReceipt),
    providerPromptDigest: bindings.providerPromptDigest
  };
  normalizeParentBinding(observedParent);
  if (stableDigest(observedParent) !== stableDigest(durable.parentBinding)) {
    throw new CompanionError("E_CONTEXT_DRIFT", "Host-action admission grant bindings drifted.");
  }
  return durable;
}

export function readHostActionRequestBinding(job) {
  const record = assertHostActionRecord(job?.hostAction);
  if (!record) return null;
  if (record.request.sourceBinding.workerId !== job?.id) {
    stateError("Host-action request belongs to a different worker.");
  }
  return Object.freeze({
    requestId: record.request.requestId,
    requestDigest: record.request.requestDigest,
    requestedRoleId: record.request.requestedRoleId,
    status: record.decision
      ? (record.decision.decision === "grant" ? "granted" : "denied")
      : "awaiting",
    decision: publicDecisionProjection(record.decision),
    grant: record.grant
      ? Object.freeze({
        grantId: record.grant.grantId,
        grantDigest: record.grant.grantDigest,
        requestedRoleId: record.grant.requestedRoleId,
        targetRoleDigest: record.grant.targetRole.digest,
        targetRuntimeRolePolicyDigest: record.grant.targetRuntimeRolePolicy.digest,
        application: HOST_ACTION_APPLICATION,
        applied: false,
        consumable: true
      })
      : null,
    application: HOST_ACTION_APPLICATION,
    applied: false
  });
}
