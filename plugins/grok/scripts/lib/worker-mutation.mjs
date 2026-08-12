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

import { providerLaunchBindingDigest as digestProviderLaunchBinding } from "./provider-executable-pin.mjs";
import { cleanupTaskRuntimeArtifacts } from "./provider-controller-environments.mjs";

import {
  generateId,
  isCancelRequested,
  now,
  tryReadJob,
  withWorkspaceStateTransaction
} from "./state.mjs";
import {
  assertContextCompatible,
  assertContextManifestIntegrity,
  captureContextManifest
} from "./task-context-manifest.mjs";
import { bindContextMetadataCompleteness } from "./task-context-metadata.mjs";
import {
  bindTaskEnvelopeContext,
  buildTaskEnvelope,
  scrubStoredJob
} from "./task-envelope.mjs";

import { composeProviderPrompt } from "./task-provider-prompt.mjs";
import { appendLifecycleEvent } from "./task-lifecycle.mjs";

import {
  CONTEXT_BINDING_MODE,
  assertContextPacket,
  buildContextPacket,
  buildContextReceipt
} from "./worker-context.mjs";
import { projectWorkerHandle } from "./worker-protocol.mjs";
import {
  assertRuntimeRolePolicy,
  assertRoleDigest
} from "./worker-roles.mjs";
import { profileFor } from "./profiles.mjs";
import { processGroupGone } from "./process-control.mjs";
import { assertBrokerMutationAuthority } from "./worker-authority.mjs";

import { loadProviderGuard } from "./recursion-guard.mjs";
import {
  resolveControlWorkspace,
  workspaceState
} from "./workspace.mjs";

import { terminalTaskProgress } from "./task-terminal-evidence.mjs";
import {
  DEFAULT_DISPATCH_LEASE_MS,
  assertDispatchFence,
  assertDispatchV2Structure,
  assertWorkerAuthorization,
  bindWorkerAuthorizationAttempt,
  createDispatchOutbox,
  createWorkerAuthorization,
  dispatchLeaseExpired,
  isDispatchV2,
  isSupportedWorkerDispatch,
  providerLaunchBindingForJob
} from "./worker-launch-contract.mjs";

import {
  SPAWN_OWNERSHIP_MODE,
  FOLLOWUP_SPAWN_OWNERSHIP_MODE,
  SPAWN_SUCCESS_DEFINITION,
  completeOwnedProcessIdentity,
  currentOwnedProcessIdentity,
  sameDispatchProcessIdentity,
  SHA256_HEX,
  digestKey,
  stableDigest,
  isPlainRecord,
  assertMutationOwnership,
  ownershipHost,
  cancellationNonce,
  validIsoTimestamp
} from "./worker-mutation-primitives.mjs";
import {
  WORKER_DISPATCH_SCHEMA_VERSION,
  WORKER_SPAWN_INTENT_SCHEMA_VERSION,
  RECOVERY_CLEANUP_FENCE_SCHEMA_VERSION,
  PROVIDER_ROTATION_INTENT_SCHEMA_VERSION,
  PROVIDER_SPAWN_INTENT_SCHEMA_VERSION,
  normalizeProviderLaunchBindingInput,
  providerSpawnIntentBindingFields,
  assertProviderRotationIntentContract,
  exactLegacyPendingAuthorization,
  exactLegacyTaskSecurityProfile,
  providerLaunchState,
  terminalJob,
  assertDispatchContract,
  assertNoRecoveryCleanupFence,
  assertTransitionNotCleanupClaimed
} from "./worker-mutation-dispatch-contract.mjs";

import { assertWriteExecutionJob } from "./worker-mutation-write-runtime-contract.mjs";
import {
  acquireRecoveryCleanupFence,
  prepareDispatchProcessSpawn,
  prepareWorkerProviderSpawn,
  recordDispatchProcessNoChild,
  recordWorkerProviderSpawnNoChild,
  sameSpawnIntent,
  spawnIntentField,
  verifyRecoveryCleanupFence
} from "./worker-mutation-dispatch-admission.mjs";
import {
  FOLLOWUP_ADMISSION_KIND,
  FOLLOWUP_ADMISSION_WITNESS_SCHEMA_VERSION,
  assertFollowupAdmissionBinding,
  buildFollowupAdmissionWitness,
  followupIdempotencyRecord,
  followupRequestBody,
  followupStateError,
  normalizeFollowupIdempotencyRecord,
  resolveParentAdmission
} from "./worker-mutation-followup-contract.mjs";
import {
  assertIdempotencyKey,
  getSpawnIdempotencyRecord,
  idempotencyConflict,
  readIdempotency,
  writeIdempotency
} from "./worker-mutation-idempotency.mjs";
import { requestDigest } from "./worker-mutation-request-contract.mjs";
import {
  assertDurableSpawnRequestBinding,
  assertWorkerProviderLaunchPreparation
} from "./worker-mutation-spawn-authority.mjs";
import { spawnReadOnlyWorker } from "./worker-mutation-spawn.mjs";
import { reconcileCleanupSafeTerminalObservation } from "./worker-mutation-terminal.mjs";
import {
  admitWriteWorkerPlan,
  authorizeReadyWriteWorkerDispatch
} from "./worker-mutation-write-admission.mjs";
import {
  adoptWriteProvisioningEffect,
  recordWriteProvisionerNoChild,
  retainWriteProvisioningCleanupPending
} from "./worker-mutation-write-recovery.mjs";


const {
  assertContextMetadataComplete,
  captureCompleteContextManifest
} = bindContextMetadataCompleteness({
  captureContextManifest,
  assertContextManifestIntegrity
});

function resolveAdmissionContext(root, manifest, metadataPolicy = null) {
  const options = {
    mode: "execute",
    contextPhase: "admission",
    ...(metadataPolicy ? { metadataPolicy } : {})
  };
  const accepted = manifest
    ? assertContextCompatible(root, manifest, options)
    : captureCompleteContextManifest(root, { contextPhase: "admission" });
  return assertContextMetadataComplete(accepted, { contextPhase: "admission" });
}

export {
  SPAWN_OWNERSHIP_MODE,
  FOLLOWUP_SPAWN_OWNERSHIP_MODE,
  SPAWN_SUCCESS_DEFINITION,
  assertMutationOwnership,
  cancellationNonce,
  WORKER_DISPATCH_SCHEMA_VERSION,
  WORKER_SPAWN_INTENT_SCHEMA_VERSION,
  RECOVERY_CLEANUP_FENCE_SCHEMA_VERSION,
  PROVIDER_ROTATION_INTENT_SCHEMA_VERSION,
  PROVIDER_SPAWN_INTENT_SCHEMA_VERSION,
  providerLaunchState,
  assertDispatchContract,
  assertNoRecoveryCleanupFence,
  assertWriteExecutionJob,
  acquireRecoveryCleanupFence,
  prepareDispatchProcessSpawn,
  prepareWorkerProviderSpawn,
  recordDispatchProcessNoChild,
  recordWorkerProviderSpawnNoChild,
  verifyRecoveryCleanupFence,
  FOLLOWUP_ADMISSION_KIND,
  FOLLOWUP_ADMISSION_WITNESS_SCHEMA_VERSION,
  assertFollowupAdmissionBinding,
  getSpawnIdempotencyRecord,
  assertDurableSpawnRequestBinding,
  assertWorkerProviderLaunchPreparation,
  admitWriteWorkerPlan,
  authorizeReadyWriteWorkerDispatch,
  adoptWriteProvisioningEffect,
  recordWriteProvisionerNoChild,
  retainWriteProvisioningCleanupPending,
  spawnReadOnlyWorker
};
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

export {
  persistCompletedWriteArtifact,
  settleFailedDispatchCleanup,
  settlePreProviderWorkerFinalization,
  settleProviderStartedWorkerFinalization,
  settleStartedWorkerLoss,
  settleUnstartedDispatchLoss,
  settleWriteArtifactAfterRuntimeCleanup
} from "./worker-mutation-terminal.mjs";
export {
  activateWriteProvisioningAttempt,
  prepareWriteProvisionerIntent,
  prepareWriteProvisioningReissue,
  promoteWriteWorkerReady,
  recordOfficialWorktreeReceipt
} from "./worker-mutation-write-provisioning.mjs";

export const CANCEL_METRIC_TIMESTAMPS = Object.freeze([
  "requestAcceptedAt",
  "processGroupGoneAt",
  "terminalRecordCommittedAt"
]);

const MAX_CANCELLATION_RECOVERY_RECORDS = 32;
const CANCELLATION_RECEIPT_STATUSES = new Set([
  "accepted",
  "already_cancelled",
  "already_terminal"
]);

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
  if (!validIsoTimestamp(receipt.requestAcceptedAt)) {
    cancellationStateError("Cancellation recovery receipt timestamp is malformed.");
  }
  for (const field of ["processGroupGoneAt", "terminalRecordCommittedAt"]) {
    if (receipt[field] !== null && !validIsoTimestamp(receipt[field])) {
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

function legacyPendingMigrationEligible(root, job, principal, env = process.env) {
  const spawn = job?.request?.spawn;
  const postV1RequestFields = [
    "contextBindingMode",
    "contextPacket",
    "runtimeRolePolicy",
    "contextReceipt",
    "providerHomeId"
  ];
  if (!exactLegacyPendingAuthorization(job, principal)
    || postV1RequestFields.some((field) => (
      Object.hasOwn(job?.request || {}, field)
    ))
    || Object.hasOwn(spawn || {}, "contextBindingDigest")
    || Object.hasOwn(spawn || {}, "controllerSpawnIntent")
    || Object.hasOwn(spawn || {}, "workerSpawnIntent")
    || Object.hasOwn(spawn || {}, "unsettledWorkerProcess")
    || Object.hasOwn(spawn || {}, "controllerCleanupProcess")
    || spawn?.controllerCleanupPending === true
    || Object.hasOwn(job || {}, "controllerProcess")
    || Object.hasOwn(job || {}, "workerProcess")
    || Object.hasOwn(job || {}, "providerProcess")
    || Object.hasOwn(job || {}, "pendingTerminal")
    || !exactLegacyTaskSecurityProfile(job?.profile, job?.write)) return false;
  try {
    assertDispatchContract({
      ...job,
      profile: profileFor("task", Boolean(job?.write))
    });
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
    assertDispatchContract(legacyPending
      ? {
          ...current,
          profile: profileFor("task", Boolean(current.write))
        }
      : current);
    if (current.request?.followup !== undefined) {
      assertDurableSpawnRequestBinding(current, env);
    }
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
      const dispatchContractJob = latestLegacyPending
        ? {
            ...latest,
            profile: profileFor("task", Boolean(latest.write))
          }
        : latest;
      assertDispatchContract(dispatchContractJob);
      if (latest.request?.followup !== undefined) {
        assertDurableSpawnRequestBinding(latest, env);
      }
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
            ...dispatchContractJob,
            request: {
              ...dispatchContractJob.request,
              spawn: {
                ...dispatchContractJob.request?.spawn,
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

  return withWorkspaceStateTransaction(root, function transitionDispatchTransaction(transaction) {
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
      const priorError = error || {
        code: "E_WORKER_LOST",
        message: "Could not launch the isolated Grok worker."
      };
      const observed = reconcileCleanupSafeTerminalObservation(
        next,
        {
          status: cancelled ? "cancelled" : "failed",
          phase: cancelled ? "cancelled" : "failed",
          completedAt: latest.completedAt || transitionedAt,
          error: priorError,
          summary: cancelled ? "Cancelled" : "Worker launch failed"
        },
        {
          cleanupError: latest.error || null
        }
      );
      const pending = observed.pending;
      return scrubStoredJob({
        ...observed.job,
        status: pending.status,
        phase: pending.phase,
        completedAt: pending.completedAt,
        summary: pending.summary,
        progress: terminalTaskProgress(pending.status, pending.error),
        error: pending.error || null,
        workerAuthorization: null,
        result: {
          ...(observed.job.result || {}),
          taskRuntimeCleaned: runtimeCleanup.ok,
          ...(pending.status === "cancelled" ? { stopReason: "cancelled" } : {})
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "blocked",
          pending.error?.message || "Worker launch failed before provider startup"
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
      ...providerSpawnIntentBindingFields(current),
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

/**
 * Commit one grant-bound, read-only continuation through the normal dispatch-v2
 * outbox. The child witness is the authoritative one-time grant reservation;
 * the adjacent idempotency file is derived and repaired after child commit.
 */
export function spawnGrantedFollowupWorker({
  root,
  principal,
  workerId,
  grantId,
  message,
  idempotencyKey,
  env = process.env,
  providerCapabilityDigest = null,
  providerLaunchBinding = null,
  providerLaunchBindingDigest = null
} = {}) {
  assertIdempotencyKey(idempotencyKey);
  if (typeof workerId !== "string" || !workerId) {
    throw new CompanionError("E_USAGE", "workerId is required for follow-up.");
  }
  if (!/^hag-[a-f0-9]{24}$/.test(grantId || "")) {
    throw new CompanionError("E_USAGE", "grantId is required and malformed.");
  }
  if (typeof message !== "string" || !message.trim() || message.length > 16000) {
    throw new CompanionError("E_USAGE", "message must be a non-empty string of at most 16000 characters.");
  }
  if (providerCapabilityDigest !== null && !SHA256_HEX.test(providerCapabilityDigest)) {
    throw new CompanionError("E_CAPABILITY", "Provider capability binding is missing or malformed.");
  }
  const requestedProviderBinding = normalizeProviderLaunchBindingInput(
    providerLaunchBinding,
    providerLaunchBindingDigest
  );
  const keyDigest = digestKey(idempotencyKey);
  const messageDigest = digestKey(message);
  const ownerThreadDigest = digestKey(principal?.threadId || "");
  // Authenticate the broker brand and workspace before reading whether any
  // requested parent exists. Exact owner equality is checked after the read.
  assertBrokerMutationAuthority(principal, { root });

  const admitted = withWorkspaceStateTransaction(root, (transaction) => {
    const parent = transaction.tryReadJob(workerId);
    if (!parent) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    const parentProviderBinding = providerLaunchBindingForJob(parent, {
      required: false
    });
    const effectiveProviderBinding = parentProviderBinding || requestedProviderBinding;
    const effectiveProviderBindingDigest = effectiveProviderBinding
      ? digestProviderLaunchBinding(effectiveProviderBinding)
      : null;
    if (requestedProviderBinding
      && parentProviderBinding
      && effectiveProviderBindingDigest !== providerLaunchBindingDigest) {
      throw new CompanionError(
        "E_CONTEXT_DRIFT",
        "Provider executable pin changed since the parent worker admission."
      );
    }
    const jobs = transaction.listJobs();
    const grantOwners = jobs.filter((candidate) => candidate.request?.followup?.grantId === grantId);
    const keyOwners = jobs.filter((candidate) => (
      candidate.request?.followup?.idempotencyKeyDigest === keyDigest
    ));
    if (grantOwners.length > 1 || keyOwners.length > 1) {
      followupStateError("Follow-up admission ownership is ambiguous across durable jobs.");
    }
    if (grantOwners[0] && keyOwners[0] && grantOwners[0].id !== keyOwners[0].id) {
      idempotencyConflict("Role-admission grant and idempotencyKey belong to different follow-up jobs.");
    }
    const existingChild = grantOwners[0] || keyOwners[0] || null;
    const admission = resolveParentAdmission(parent, {
      root,
      principal,
      grantId,
      child: existingChild,
      verifyCurrentContext: true
    });
    const requestBody = followupRequestBody({
      parentWorkerId: parent.id,
      lineageWorkerId: admission.lineageWorkerId,
      grant: admission.grant,
      finalContextManifest: admission.finalContextManifest,
      messageDigest,
      ownerThreadDigest,
      idempotencyKeyDigest: keyDigest
    });
    const followupRequestDigest = stableDigest(requestBody);
    if (existingChild) {
      const witness = assertFollowupAdmissionBinding(existingChild, {
        root,
        env,
        verifyCurrentContext: true
      });
      if (witness.grantId !== grantId
        || witness.idempotencyKeyDigest !== keyDigest
        || witness.followupRequestDigest !== followupRequestDigest
        || witness.ownerThreadDigest !== ownerThreadDigest) {
        idempotencyConflict("Role-admission grant or idempotencyKey was already used for a different follow-up.");
      }
      assertBrokerMutationAuthority(principal, {
        root,
        exactThreadId: existingChild.host?.sessionId
      });
      assertDispatchContract(existingChild);
      assertDurableSpawnRequestBinding(existingChild, env);
      if (providerCapabilityDigest !== null
        && existingChild.request?.spawn?.providerCapabilityDigest !== providerCapabilityDigest) {
        throw new CompanionError(
          "E_CONTEXT_DRIFT",
          "Provider capability changed since durable follow-up admission."
        );
      }
      if (effectiveProviderBinding
        && existingChild.request?.spawn?.providerLaunchBindingDigest
          !== effectiveProviderBindingDigest) {
        throw new CompanionError(
          "E_CONTEXT_DRIFT",
          "Provider executable pin changed since durable follow-up admission."
        );
      }
      return { committed: existingChild, replayed: true };
    }

    const sidecar = readIdempotency(root, "followup", idempotencyKey, env);
    if (sidecar) {
      normalizeFollowupIdempotencyRecord(sidecar, { keyDigest });
      followupStateError("Follow-up idempotency record exists without its authoritative child job.");
    }

    const controlWorkspace = resolveControlWorkspace(root, env);
    const { controlWorkspaceId, executionRoot } = controlWorkspace;
    if (parent.controlWorkspaceId !== controlWorkspaceId
      || parent.request?.spawn?.executionRoot !== executionRoot) {
      throw new CompanionError("E_CONTEXT_DRIFT", "Follow-up parent belongs to a different control workspace.");
    }
    const envelope = bindTaskEnvelopeContext(
      buildTaskEnvelope({
        userRequest: message,
        objective: message,
        mode: "read",
        contextManifestId: admission.finalContextManifest.manifestId
      }),
      admission.finalContextManifest.manifestId
    );
    const role = assertRoleDigest(admission.grant.targetRole);
    const profile = admission.targetProfile;
    const runtimeRolePolicy = assertRuntimeRolePolicy(
      admission.grant.targetRuntimeRolePolicy,
      { role, profile }
    );
    const contextPacket = buildContextPacket({
      mode: "explicit-envelope",
      envelope,
      facts: envelope.context.facts,
      constraints: envelope.context.constraints
    });
    assertContextPacket(contextPacket, { envelope });
    const providerPrompt = composeProviderPrompt(envelope, {
      root: executionRoot,
      contextManifest: admission.finalContextManifest,
      contextPacket,
      runtimeRolePolicy
    });
    const providerPromptDigest = digestKey(providerPrompt);
    const contextBindingDigest = stableDigest({
      mode: CONTEXT_BINDING_MODE,
      packetDigest: contextPacket.digest,
      runtimeRolePolicyDigest: runtimeRolePolicy.digest,
      providerPromptDigest
    });
    const spawnDigest = requestDigest({
      principal,
      controlWorkspaceId,
      executionRoot,
      envelope,
      contextManifest: admission.finalContextManifest,
      roleId: role.id,
      write: false,
      contextBinding: {
        mode: CONTEXT_BINDING_MODE,
        digest: contextBindingDigest
      },
      ...(effectiveProviderBindingDigest
        ? { providerLaunchBindingDigest: effectiveProviderBindingDigest }
        : {})
    });
    const id = generateId("task");
    const createdAt = now();
    const contextReceipt = buildContextReceipt({
      contextPacket,
      rolePolicy: runtimeRolePolicy,
      contextManifest: admission.finalContextManifest,
      lineageWorkerId: id,
      effectivePromptDigest: providerPromptDigest
    });
    const followup = buildFollowupAdmissionWitness({
      childWorkerId: id,
      parent,
      admission,
      messageDigest,
      ownerThreadDigest,
      idempotencyKeyDigest: keyDigest,
      followupRequestDigest
    });
    const job = {
      schemaVersion: 3,
      id,
      kind: "task",
      jobClass: "task",
      write: false,
      status: "queued",
      phase: "accepted",
      summary: "Follow-up committed",
      progress: "Grant-bound continuation committed to the durable launch outbox.",
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
        envelope,
        contextManifest: admission.finalContextManifest,
        providerPromptDigest,
        providerHomeId: admission.lineageWorkerId,
        resumeJobId: parent.id,
        resumeSessionId: admission.resumeSessionId,
        publicObjective: null,
        roleId: role.id,
        followup,
        spawn: {
          executionRoot,
          idempotencyKeyDigest: keyDigest,
          ownerThreadId: principal.threadId,
          requestDigest: spawnDigest,
          contextBindingDigest,
          successDefinition: SPAWN_SUCCESS_DEFINITION,
          ownershipMode: FOLLOWUP_SPAWN_OWNERSHIP_MODE,
          ...(providerCapabilityDigest !== null ? { providerCapabilityDigest } : {}),
          ...(effectiveProviderBinding
            ? {
                providerLaunchBinding: effectiveProviderBinding,
                providerLaunchBindingDigest: effectiveProviderBindingDigest
              }
            : {}),
          providerLaunchPending: true,
          providerLaunchInFlight: false,
          providerLaunchOutcome: "pending",
          dispatch: createDispatchOutbox({ createdAt })
        }
      },
      lifecycleEvents: appendLifecycleEvent(
        [],
        "task.accepted",
        "Durable grant-bound follow-up accepted by worker broker.",
        { parentWorkerId: parent.id }
      ),
      result: null,
      error: null,
      workerAuthorization: null
    };
    job.workerAuthorization = createWorkerAuthorization({
      job,
      principal,
      issuedAt: createdAt
    });
    const committed = transaction.admitJob(job);
    assertFollowupAdmissionBinding(committed, {
      root,
      env,
      verifyCurrentContext: true
    });
    return { committed, replayed: false };
  }, env);

  // The child commit is authoritative and precedes this derived publication.
  // A crash here is repaired by the child scan on the same-key replay.
  writeIdempotency(
    root,
    "followup",
    idempotencyKey,
    followupIdempotencyRecord(admitted.committed),
    env
  );
  return {
    handle: projectWorkerHandle(admitted.committed, { trustHostAuthority: false }),
    replayed: admitted.replayed,
    spawnSuccessDefinition: SPAWN_SUCCESS_DEFINITION,
    providerLaunched: false
  };
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
  return withWorkspaceStateTransaction(root, function cancelWorkerTransaction(transaction) {
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
      transaction.requestCancel(workerId, cancellationNonce(current));
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
        const observed = reconcileCleanupSafeTerminalObservation(
          {
            ...current,
            request: settledRequest,
            workerAuthorization: null,
            lifecycleEvents: nextEvents,
            result: persistCancellation(current, {
              taskRuntimeCleaned: true
            })
          },
          {
            status: "cancelled",
            phase: "cancelled",
            completedAt: terminalRecordCommittedAt,
            error: null,
            summary: "Cancelled"
          }
        );
        const pending = observed.pending;
        const terminal = scrubStoredJob({
          ...observed.job,
          status: pending.status,
          phase: pending.phase,
          summary: pending.summary || pending.error?.message || "Cancelled",
          progress: terminalTaskProgress(pending.status, pending.error),
          completedAt: pending.completedAt || terminalRecordCommittedAt,
          error: pending.error || null,
          workerAuthorization: null,
          lifecycleEvents: nextEvents,
          result: {
            ...(observed.job.result || {}),
            ...(pending.status === "cancelled"
              ? { stopReason: "cancelled" }
              : {})
          }
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
  const projectedTimestamp = (value) => (
    validIsoTimestamp(value) ? value : null
  );
  return {
    receiptId: receipt.receiptId,
    workerId: receipt.workerId,
    status: receipt.status,
    requestAcceptedAt: projectedTimestamp(receipt.requestAcceptedAt),
    processGroupGoneAt: projectedTimestamp(receipt.processGroupGoneAt),
    terminalRecordCommittedAt: projectedTimestamp(
      receipt.terminalRecordCommittedAt
    ),
    idempotencyKeyDigest: receipt.idempotencyKeyDigest || null,
    cancellationRequestSequence: receipt.cancellationRequestSequence ?? null
  };
}

