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

import { CompanionError, asErrorPayload } from "./errors.mjs";
import {
  assertExecutableAttestation,
  sameExecutableAttestation
} from "./executable-identity.mjs";
import {
  assertProviderLaunchBinding,
  providerLaunchBindingDigest as digestProviderLaunchBinding
} from "./provider-executable-pin.mjs";
import { cleanupTaskRuntimeArtifacts } from "./provider-controller-environments.mjs";
import { sameHostSession } from "./host.mjs";
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
import {
  assertContextCompatible,
  assertContextManifestIntegrity,
  captureContextManifest
} from "./task-context-manifest.mjs";
import {
  assertTaskEnvelope,
  bindTaskEnvelopeContext,
  buildTaskEnvelope,
  scrubStoredJob
} from "./task-envelope.mjs";
import { boundPathEvidence } from "./task-contract-primitives.mjs";
import { CONTEXT_MANIFEST_VERSION, CONTEXT_METADATA_POLICIES } from "./task-context-policy.mjs";
import { buildRuntimeEvidence, observeChangedPaths } from "./task-runtime-evidence.mjs";
import { composeProviderPrompt } from "./task-provider-prompt.mjs";
import { appendLifecycleEvent } from "./task-lifecycle.mjs";
import { evaluateScope } from "./task-scope.mjs";
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
import { assertBrokerMutationAuthority } from "./worker-authority.mjs";
import {
  assertAdmissionGrantEligible,
  assertHostActionRequestStillBound,
  assertHostActionRecord
} from "./worker-host-actions.mjs";
import {
  assertProviderGuardForJob,
  loadProviderGuard,
  unregisterProviderGuardInWorkspaceTransaction
} from "./recursion-guard.mjs";
import { resolveControlWorkspace, workspaceState } from "./workspace.mjs";
import {
  assertExactWriteVerticalScope,
  assertParentUnchanged,
  assertManagedWorkerWorktree,
  assertRegisteredWorkerWorktreeIdentity,
  assertTrackedWriteVerticalTarget,
  classifyWorkerWorktreeEffect,
  captureParentFingerprint,
  expectedWorkerWorktreeRoot,
  persistWriteWorkerArtifact
} from "./worker-worktree.mjs";
import {
  assertExecutionBinding,
  assertProvisioningJournal,
  createExecutionBinding,
  createProvisioningJournal,
  transitionProvisioningJournal
} from "./worker-execution-binding.mjs";
import {
  captureTerminalEvidence,
  normalizeTerminalProcessSignalError,
  preferProvenTerminalSafetyPending,
  selectTaskTerminalError,
  terminalTaskProgress
} from "./task-terminal-evidence.mjs";
import { knownManagedWriteSafetyTerminalObservation } from "./worker-terminal-safety.mjs";
import {
  bindContextMetadataCompleteness,
  contextIncompleteError,
  observeContextMetadataCompleteness
} from "./task-context-metadata.mjs";
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
  SPAWN_OWNERSHIP_MODE,
  FOLLOWUP_SPAWN_OWNERSHIP_MODE,
  SPAWN_SUCCESS_DEFINITION,
  completeOwnedProcessIdentity,
  currentOwnedProcessIdentity,
  sameDispatchProcessWitness,
  sameDispatchProcessIdentity,
  SHA256_HEX,
  digestKey,
  stableDigest,
  isPlainRecord,
  hasExactKeys,
  runSuccessfulRuntimeCleanup,
  spawnRequestOwner,
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
  BOUND_PROVIDER_SPAWN_INTENT_SCHEMA_VERSION,
  normalizeProviderLaunchBindingInput,
  providerSpawnIntentBindingFields,
  assertProviderSpawnIntentContract,
  assertProviderRotationIntentContract,
  recoveryCleanupSource,
  assertRecoveryCleanupFenceContract,
  exactLegacyPendingAuthorization,
  exactLegacyTaskSecurityProfile,
  providerLaunchState,
  terminalJob,
  assertDispatchContract,
  assertNoRecoveryCleanupFence,
  assertTransitionNotCleanupClaimed,
  recoveryCleanupFenceMatches
} from "./worker-mutation-dispatch-contract.mjs";
import {
  OFFICIAL_WORKTREE_RECEIPT_INPUT_KEYS,
  WRITE_PROVISIONING_CLEANUP_INPUT_KEYS,
  WRITE_PROVISIONING_PURPOSE,
  WRITE_PROVISIONING_SCHEMA_VERSION,
  WRITE_PROVISIONING_NO_CHILD_RESOLUTIONS,
  WRITE_PREACTIVATION_CLEANUP_RESOLUTION,
  WRITE_READY_LAUNCH_OUTCOME,
  WRITE_HOST_ADOPTION_ORIGIN,
  MAX_WRITE_PROVISIONING_ATTEMPTS,
  EXACT_NONCE_HEX,
  OPAQUE_HEX,
  writeAdmissionOwnerDigest,
  writeAdmissionRequestDigest,
  writeProvisioningStateError,
  assertCanonicalTimestamp,
  assertTimestampNotBefore,
  assertWriteProvisioningProcessIdentity,
  sameWriteProvisioningProcessIdentity,
  writeProvisioningIntentDigestBody,
  assertWriteProvisioningIntent,
  writeProvisioningProviderBindingFields,
  writeProvisioningActivationDigest,
  worktreeVerificationWithoutDigest,
  assertWorktreeHostVerification,
  officialWorktreeReceiptWithoutDigest,
  assertOfficialWorktreeReceipt,
  worktreeHostAdoptionWithoutDigest,
  assertWorktreeHostAdoption,
  writeCleanupProofWithoutDigest,
  assertWriteProvisioningCleanupProof,
  assertWorktreeAbsenceProof,
  writeProvisioningAttemptArchiveWithoutDigest,
  assertWriteProvisioningAttemptArchive
} from "./worker-mutation-write-contract.mjs";
import {
  assertWriteProvisioningRuntime,
  assertWriteExecutionJob
} from "./worker-mutation-write-runtime-contract.mjs";
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
  SPAWN_IDEMPOTENCY_SCHEMA_VERSION,
  WRITE_SPAWN_IDEMPOTENCY_SCHEMA_VERSION,
  assertIdempotencyKey,
  assertSpawnIdempotencyJobBinding,
  captureSpawnResponse,
  getSpawnIdempotencyRecord,
  idempotencyConflict,
  nextSpawnResponseSequence,
  normalizeSpawnIdempotencyRecord,
  readIdempotency,
  spawnIdempotencyStateError,
  writeIdempotency
} from "./worker-mutation-idempotency.mjs";
import { requestDigest } from "./worker-mutation-request-contract.mjs";
import {
  assertDurableSpawnRequestBinding,
  assertWorkerProviderLaunchPreparation,
  captureManagedWritePostBindingContext,
  hasManagedWriteAuthority,
  hasManagedWritePostBinding,
  storedSpawnReplayRequestDigest
} from "./worker-mutation-spawn-authority.mjs";
import { spawnReadOnlyWorker } from "./worker-mutation-spawn.mjs";
import {
  admitWriteWorkerPlan,
  assertActualWriteProvisionerCleanup,
  assertOfficialWorktreeReceiptInput,
  assertProvisioningGuardAbsent,
  assertWriteProvisioningMutationBoundary,
  assertWriteProvisioningMutationInput,
  authorizeReadyWriteWorkerDispatch,
  buildWriteProvisioningCleanupProof,
  exactAbsentWorktreeEffect,
  managedWorktreeVerification,
  sameWorktreeAbsenceIdentity,
  sameWorktreeVerificationIdentity
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

function cleanupSignalSecondaryDiagnostic(error) {
  const diagnostic = error?.code === "E_PROCESS_IDENTITY"
    && isPlainRecord(error.details?.secondaryDiagnostic)
    ? error.details.secondaryDiagnostic
    : null;
  if (!diagnostic) return null;
  const rawCode = String(diagnostic.code || "");
  if (rawCode.toUpperCase() === "ESRCH") return null;
  return Object.freeze({
    code: /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode)
      ? rawCode.slice(0, 64)
      : "UNKNOWN",
    message: String(
      diagnostic.message || "Process signalling failed."
    ).slice(0, 256)
  });
}

function reconcileTerminalCleanupSignal(
  terminalIntent,
  cleanupError,
  { completedAt = now(), priorErrors = [] } = {}
) {
  const signalErrors = [
    terminalIntent?.error,
    ...(Array.isArray(priorErrors) ? priorErrors : []),
    cleanupError
  ]
    .map((error) => normalizeTerminalProcessSignalError(error))
    // E_PROCESS_IDENTITY is also the fail-closed code for several ownership
    // and runtime-cleanup blockers. Only a bounded secondary diagnostic proves
    // this record came from an actual non-ESRCH signal failure and may therefore
    // outrank the provider's prior terminal outcome.
    .filter((error) => (
      error?.code === "E_PROCESS_IDENTITY"
      && cleanupSignalSecondaryDiagnostic(error) !== null
    ));
  const signalError = signalErrors[0];
  if (!signalError) return terminalIntent;
  const secondaryDiagnostic =
    cleanupSignalSecondaryDiagnostic(signalError);
  if (["E_CONTEXT_DRIFT", "E_CONTEXT_INCOMPLETE", "E_SCOPE_VIOLATION"].includes(
    terminalIntent?.error?.code
  )) {
    const priorDetails = isPlainRecord(terminalIntent.error.details)
      ? terminalIntent.error.details
      : {};
    return Object.freeze({
      ...terminalIntent,
      error: Object.freeze({
        ...terminalIntent.error,
        details: Object.freeze({
          ...priorDetails,
          ...(secondaryDiagnostic ? { secondaryDiagnostic } : {})
        })
      })
    });
  }
  const message = "Verified owned process signalling could not be completed.";
  return Object.freeze({
    status: "failed",
    phase: "failed",
    completedAt,
    error: Object.freeze({
      code: "E_PROCESS_IDENTITY",
      message,
      ...(secondaryDiagnostic
        ? { details: Object.freeze({ secondaryDiagnostic }) }
        : {})
    }),
    summary: message
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
      const observed = reconcileCleanupSafeTerminalObservation(
        latest,
        explicitIntent || {
          status: "failed",
          phase: "lost",
          completedAt,
          error: {
            code: "E_WORKER_LOST",
            message: "Worker dispatch process exited before provider startup; the prompt was not replayed."
          },
          summary: "Lost"
        },
        { cleanupError: latest.error }
      );
      const effectiveIntent = observed.pending;
      const message = effectiveIntent?.error?.message
        || "Worker dispatch process exited before provider startup; the prompt was not replayed.";
      const status = effectiveIntent.status;
      const phase = effectiveIntent.phase;
      return scrubStoredJob({
        ...observed.job,
        status,
        phase,
        summary: effectiveIntent?.summary || (status === "cancelled" ? "Cancelled" : "Lost"),
        progress: terminalTaskProgress(status, effectiveIntent.error),
        completedAt: effectiveIntent.completedAt || completedAt,
        heartbeatAt: completedAt,
        error: effectiveIntent.error || { code: "E_WORKER_LOST", message },
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
          ...(observed.job.result || {}),
          stopReason: status === "cancelled" ? "cancelled" : "reconciler-lost",
          taskRuntimeCleaned: completedCleanup.ok,
          ...(completedCleanup.ok
            ? { privacyWarning: undefined }
            : { privacyWarning: completedCleanup.warning || "Runtime cleanup remained incomplete after dispatch loss." }),
          runtimeEvidence: {
            ...(observed.job.result?.runtimeEvidence || {}),
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
        const observed = reconcileCleanupSafeTerminalObservation(
          next,
          intendedTerminal,
          { cleanupError: latest.error }
        );
        const pending = observed.pending;
        const terminalized = {
          ...observed.job,
          status: pending.status,
          phase: pending.phase,
          completedAt: pending.completedAt,
          error: pending.error || null,
          summary: pending.summary || pending.error?.message || null,
          progress: terminalTaskProgress(pending.status, pending.error),
          lifecycleEvents: appendLifecycleEvent(
            latest.lifecycleEvents || [],
            pending.status === "completed" ? "checkpoint" : "blocked",
            pending.error?.message
              || pending.summary
              || "Task runtime cleanup completed before provider startup.",
            { replayedPrompt: false }
          )
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
export function persistCompletedWriteArtifact(job, pending, env) {
  if (job?.write !== true || pending?.status !== "completed" || pending?.error != null) return null;
  assertDispatchContract(job);
  assertExactWriteVerticalScope(job.request?.envelope?.scope);
  const binding = job.executionBinding;
  if (!binding
    || binding.bindingDigest !== job.request?.spawn?.executionBindingDigest
    || binding.expectedExecutionRoot !== job.request?.spawn?.executionRoot
    || binding.controlWorkspaceId !== job.controlWorkspaceId) {
    throw new CompanionError(
      "E_INTEGRATION",
      "Completed write worker lost its exact execution binding before artifact capture."
    );
  }
  assertParentUnchanged(
    binding.parentFingerprint,
    binding.controlRoot
  );
  const persisted = persistWriteWorkerArtifact({
    workerId: job.id,
    controlWorkspaceId: binding.controlWorkspaceId,
    controlRoot: binding.controlRoot,
    executionRoot: binding.expectedExecutionRoot,
    baseCommit: binding.baseCommit,
    env
  });
  const record = persisted.record;
  return Object.freeze({
    schemaVersion: record.schemaVersion,
    path: record.path,
    baseCommit: record.baseCommit,
    manifestDigest: record.manifestDigest,
    securityDigest: record.securityDigest,
    patchDigest: record.patchDigest,
    contentDigest: record.contentDigest,
    contentBytes: record.contentBytes,
    createdAt: record.createdAt
  });
}

export function settleWriteArtifactAfterRuntimeCleanup({
  job,
  pending,
  runtimeCleanup,
  env = process.env,
  persistArtifact = persistCompletedWriteArtifact
} = {}) {
  runSuccessfulRuntimeCleanup(runtimeCleanup, job);
  try {
    return Object.freeze({
      pending,
      artifact: persistArtifact(job, pending, env),
      rejected: false
    });
  } catch {
    const completedAt = now();
    return Object.freeze({
      pending: Object.freeze({
        status: "failed",
        phase: "artifact-rejected",
        completedAt,
        error: Object.freeze({
          code: "E_INTEGRATION",
          message: "Worker output failed bounded write-artifact validation."
        }),
        summary: "Worker output failed bounded write-artifact validation."
      }),
      artifact: null,
      rejected: true
    });
  }
}

function unavailableManagedWriteTerminalObservation(job) {
  let preContext = null;
  try {
    preContext = assertContextManifestIntegrity(
      job.request?.contextManifest
    );
  } catch {
    // A missing or malformed stored pre-context is itself part of the
    // unavailable final observation. Do not fabricate a replacement.
  }
  const completedAt = now();
  const message =
    "Final managed-write context could not be observed after runtime cleanup.";
  return Object.freeze({
    pending: Object.freeze({
      status: "failed",
      phase: "context-rejected",
      completedAt,
      error: Object.freeze({
        code: "E_CONTEXT_DRIFT",
        message,
        details: Object.freeze({
          reasons: Object.freeze(["[final-context-unavailable]"])
        })
      }),
      summary: message
    }),
    job: {
      ...job,
      completionContextManifest: null,
      result: {
        ...(job.result || {}),
        runtimeEvidence: buildRuntimeEvidence({
          preContext,
          postContext: null,
          changedPaths: [],
          commandOutcomes: job.commandOutcomes || [],
          scopeViolations: [],
          executionStatus: "failed"
        }),
        hostVerification: "not_run"
      }
    }
  });
}

/**
 * Publish one authoritative post-cleanup workspace observation for every task
 * that does not yet have provider-started managed-write output authority.
 * Exact runtime cleanup is a caller precondition; this helper only reconciles
 * the fresh workspace boundary with the durable terminal intent.
 */
function reconcileCleanupSafeTerminalObservation(
  job,
  pending,
  { cleanupError = null } = {}
) {
  const intendedStatus = pending?.status || null;
  const executionStatus = intendedStatus === "completed"
    ? "completed"
    : intendedStatus === "cancelled"
      ? "cancelled"
      : "failed";
  const executionRoot = job?.request?.spawn?.executionRoot
    || job?.workspaceRoot;
  let managedAuthorityUnavailable = false;
  const dispatch = job?.request?.spawn?.dispatch;
  const explicitManagedAuthority = [
    job?.executionBinding,
    job?.provisioning,
    job?.provisioningRuntime,
    job?.request?.admissionContextManifest,
    job?.request?.spawn?.executionBindingDigest
  ].some((value) => value !== undefined && value !== null);
  if (job?.write === true
    && (isDispatchV2(dispatch) || explicitManagedAuthority)) {
    try {
      hasManagedWriteAuthority(job);
    } catch {
      // Partial managed-write authority is not a legacy unmanaged write. It
      // cannot be trusted as a final observation boundary even before provider
      // startup, so force the same bounded unavailable-context terminal.
      managedAuthorityUnavailable = true;
    }
  }
  const evidence = captureTerminalEvidence(
    executionRoot,
    job,
    executionStatus,
    managedAuthorityUnavailable
      ? {
          captureFailureKind: "evidenceAssembly",
          captureContext() {
            throw new CompanionError(
              "E_CONTEXT_DRIFT",
              "Managed-write terminal authority is incomplete."
            );
          }
        }
      : {}
  );
  const selectedTerminalError = selectTaskTerminalError(
    evidence,
    pending?.error || null,
    cleanupError
  );
  // Error.message is non-enumerable on Error/CompanionError instances. Every
  // terminal error must cross the durable JSON boundary as an ordinary record.
  const selectedError = selectedTerminalError
    ? Object.freeze(asErrorPayload(selectedTerminalError))
    : null;
  const safetyFailure = [
    "E_CONTEXT_DRIFT",
    "E_CONTEXT_INCOMPLETE",
    "E_SCOPE_VIOLATION"
  ].includes(selectedError?.code);
  const selectedStatus = selectedError
    ? (selectedError.code === "E_CANCELLED" ? "cancelled" : "failed")
    : intendedStatus;
  const statusChanged = selectedStatus !== intendedStatus;
  const errorChanged = Boolean(
    selectedError
    && (
      selectedError.code !== pending?.error?.code
      || selectedError.message !== pending?.error?.message
    )
  );
  const outcomeChanged = statusChanged || errorChanged;
  const reconciledPending = selectedError
    ? Object.freeze({
        status: selectedStatus,
        phase: ["E_CONTEXT_DRIFT", "E_CONTEXT_INCOMPLETE"].includes(selectedError.code)
          ? "context-rejected"
          : selectedError.code === "E_SCOPE_VIOLATION"
            ? "scope-rejected"
            : outcomeChanged
              ? selectedStatus
              : pending?.phase || selectedStatus,
        completedAt: safetyFailure
          ? now()
          : pending?.completedAt || now(),
        error: selectedError,
        summary: safetyFailure || outcomeChanged
          ? selectedError.message
          : pending?.summary || selectedError.message
      })
    : pending;
  const effectiveStatus = reconciledPending?.status || "failed";
  const effectiveError = reconciledPending?.error || null;
  evidence.runtimeEvidence.executionStatus = effectiveStatus === "completed"
    ? "completed"
    : effectiveStatus === "cancelled"
      ? "cancelled"
      : "failed";
  const result = {
    ...(job.result || {}),
    runtimeEvidence: {
      ...(job.result?.runtimeEvidence || {}),
      ...evidence.runtimeEvidence
    },
    hostVerification: "not_run"
  };
  // Every caller reaches this helper only after exact runtime cleanup. A
  // warning from an earlier failed cleanup attempt is therefore stale.
  delete result.privacyWarning;
  if (effectiveStatus !== "cancelled" && result.stopReason === "cancelled") {
    delete result.stopReason;
  }
  return Object.freeze({
    pending: reconciledPending,
    job: {
      ...job,
      progress: terminalTaskProgress(effectiveStatus, effectiveError),
      completionContextManifest: evidence.postContext,
      result
    }
  });
}

function reconcileProviderStartedWriteCompletion(job, pending, env) {
  let managedWritePostBinding;
  try {
    managedWritePostBinding = hasManagedWritePostBinding(job);
  } catch {
    // Runtime cleanup already succeeded before every caller reaches this
    // function. A malformed partial managed-write authority must therefore
    // become one terminal fail-closed observation, not abort the transaction
    // and strand a cleaned task as active.
    return unavailableManagedWriteTerminalObservation(job);
  }
  if (job?.write !== true || !managedWritePostBinding) {
    return reconcileCleanupSafeTerminalObservation(job, pending);
  }
  let observed;
  try {
    if (pending) {
      const providerCompletionContext = assertContextManifestIntegrity(
        job.completionContextManifest
      );
      const providerRuntimeContext = job.result?.runtimeEvidence?.postContext;
      if (!providerRuntimeContext
        || providerRuntimeContext.manifestId !== providerCompletionContext.manifestId
        || providerRuntimeContext.digest !== providerCompletionContext.digest) {
        throw new CompanionError(
          "E_STATE",
          "Provider completion evidence is not bound to its stored ContextManifest."
        );
      }
    }

    // Capture again under the workspace transaction immediately before artifact
    // and terminal publication. A worker that disappeared before publishing an
    // intent still receives the same final safety observation. Provider evidence
    // is informative, never the terminal authority for the live filesystem
    // boundary.
    observed = captureManagedWritePostBindingContext(job, env);
  } catch (error) {
    const safetyObservation =
      knownManagedWriteSafetyTerminalObservation(job, error);
    if (safetyObservation) {
      return Object.freeze({
        ...safetyObservation,
        pending: preferProvenTerminalSafetyPending(
          safetyObservation.pending,
          pending
        )
      });
    }
    return unavailableManagedWriteTerminalObservation(job);
  }
  const contextDrift = observed.coreReasons.length > 0
    || observed.metadataMarkers.length > 0;
  const concreteScopeViolations = observed.scopeViolations.filter(
    (item) => item !== "[GIT_METADATA_INCOMPLETE]"
  );
  const scopeDrift = concreteScopeViolations.length > 0;
  const contextIncomplete = observed.incompleteComponents.length > 0;
  const rejected = contextDrift || scopeDrift || contextIncomplete;
  const contextReasons = [...new Set([
    ...(observed.controlContextMarkers || []),
    ...observed.metadataMarkers
  ])].slice(0, 8);
  const observedPending = rejected
    ? Object.freeze({
        status: "failed",
        phase: contextDrift
          ? "context-rejected"
          : scopeDrift
            ? "scope-rejected"
            : "context-rejected",
        completedAt: now(),
        error: Object.freeze({
          code: contextDrift
            ? "E_CONTEXT_DRIFT"
            : scopeDrift
              ? "E_SCOPE_VIOLATION"
              : "E_CONTEXT_INCOMPLETE",
          message: contextDrift
            ? "Worker output failed final execution-context reconciliation."
            : scopeDrift
              ? "Worker output changed paths outside the delegated scope."
              : "Worker execution context could not be observed completely.",
          ...(contextDrift && contextReasons.length
            ? {
                details: Object.freeze({
                  reasons: Object.freeze(contextReasons)
                })
              }
            : contextIncomplete && !scopeDrift
              ? {
                  details: Object.freeze({
                    contextPhase: "terminal",
                    metadataComponents: Object.freeze(
                      [...observed.incompleteComponents]
                    )
                  })
                }
              : {})
        }),
        summary: contextDrift
          ? "Worker output failed final execution-context reconciliation."
          : scopeDrift
            ? "Worker output changed paths outside the delegated scope."
            : "Worker execution context could not be observed completely."
      })
    : pending;
  const reconciledPending = preferProvenTerminalSafetyPending(
    observedPending,
    pending
  );
  const runtimeEvidence = buildRuntimeEvidence({
    preContext: observed.requestContextManifest,
    postContext: observed.currentContextManifest,
    changedPaths: observed.observedChangedPaths,
    diffSummary: observed.observedChangedPaths.length
      ? observed.observedChangedPaths.join("\n")
      : "No workspace changes observed.",
    commandOutcomes: job.commandOutcomes || [],
    scopeViolations: concreteScopeViolations,
    executionStatus: rejected
      ? "failed"
      : pending?.status === "cancelled"
        ? "cancelled"
        : pending?.status === "failed"
          ? "failed"
          : pending?.status === "completed"
            ? "completed"
            : "failed"
  });
  return Object.freeze({
    pending: reconciledPending,
    job: {
      ...job,
      completionContextManifest: observed.currentContextManifest,
      result: {
        ...(job.result || {}),
        runtimeEvidence,
        hostVerification: "not_run"
      }
    }
  });
}

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
      const intended = pendingIntent(latest);
      const completedCleanup = runSuccessfulRuntimeCleanup(
        runtimeCleanup,
        latest
      );
      const reconciled = reconcileProviderStartedWriteCompletion(
        latest,
        intended,
        env
      );
      const signalReconciled = reconcileTerminalCleanupSignal(
        reconciled.pending,
        latest.error,
        {
          completedAt: now(),
          priorErrors: [intended.error]
        }
      );
      const artifactSettlement = settleWriteArtifactAfterRuntimeCleanup({
        job: reconciled.job,
        pending: signalReconciled,
        runtimeCleanup: completedCleanup,
        env
      });
      const pending = artifactSettlement.pending;
      const writeArtifact = artifactSettlement.artifact;
      const settledAt = now();
      const result = {
        ...(reconciled.job.result || {}),
        ...(writeArtifact ? { writeArtifact } : {}),
        hostVerification: latest.result?.hostVerification || "not_run",
        taskRuntimeCleaned: true,
        ...(pending.status === "cancelled" && !latest.result?.stopReason
          ? { stopReason: "cancelled" }
          : {})
      };
      if (artifactSettlement.rejected) {
        delete result.writeArtifact;
        result.stopReason = "write-artifact-rejected";
      }
      if (result.runtimeEvidence) {
        result.runtimeEvidence = {
          ...result.runtimeEvidence,
          executionStatus: pending.status === "completed"
            ? "completed"
            : pending.status === "cancelled"
              ? "cancelled"
              : "failed"
        };
      }
      delete result.privacyWarning;
      const terminalized = {
        ...reconciled.job,
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
          artifactSettlement.rejected
            ? "Task runtime cleanup completed; write artifact validation failed closed."
            : "Task runtime cleanup completed; durable terminal intent published.",
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
      const observed = reconcileCleanupSafeTerminalObservation(
        latest,
        latest.pendingTerminal,
        { cleanupError: latest.error }
      );
      const pending = observed.pending;
      const result = {
        ...(observed.job.result || {}),
        taskRuntimeCleaned: true,
        hostVerification: "not_run",
        ...(reconciler ? {
          runtimeEvidence: {
            ...(observed.job.result?.runtimeEvidence || {}),
            reconciler: {
              privilege: "host-trusted-reconciler",
              replayedPrompt: false,
              at: settledAt
            }
          }
        } : {})
      };
      if (result.runtimeEvidence) {
        result.runtimeEvidence = {
          ...result.runtimeEvidence,
          executionStatus: pending.status === "completed"
            ? "completed"
            : pending.status === "cancelled"
              ? "cancelled"
              : "failed"
        };
      }
      delete result.privacyWarning;
      const terminalized = {
        ...observed.job,
        status: pending.status,
        phase: pending.phase,
        completedAt: pending.completedAt || settledAt,
        error: pending.error || null,
        summary: pending.summary || pending.error?.message || latest.summary,
        progress: terminalTaskProgress(pending.status, pending.error),
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
      const latestDispatch = latest.request.spawn.dispatch;
      const intended = pendingIntent(latest);
      const completedCleanup = runSuccessfulRuntimeCleanup(
        runtimeCleanup,
        latest
      );
      const reconciled = reconcileProviderStartedWriteCompletion(
        latest,
        intended,
        env
      );
      const recoveredPending = reconcileTerminalCleanupSignal(
        reconciled.pending,
        latest.error,
        { priorErrors: [intended?.error] }
      );
      const artifactSettlement = settleWriteArtifactAfterRuntimeCleanup({
        job: reconciled.job,
        pending: recoveredPending,
        runtimeCleanup: completedCleanup,
        env
      });
      const effective = artifactSettlement.pending;
      const writeArtifact = artifactSettlement.artifact;
      const settledAt = now();
      const message = artifactSettlement.rejected
        ? "Task runtime cleanup completed; write artifact validation failed closed."
        : effective
          ? "Task runtime cleanup completed; the durable terminal result was published."
        : "Worker process exited before publishing a terminal result; the prompt was not replayed.";
      const status = effective?.status || "failed";
      const result = {
        ...(reconciled.job.result || {}),
        ...(writeArtifact ? { writeArtifact } : {}),
        hostVerification: latest.result?.hostVerification || "not_run",
        taskRuntimeCleaned: true,
        ...(effective
          ? (status === "cancelled" && !reconciled.job.result?.stopReason
              ? { stopReason: "cancelled" }
              : {})
          : { stopReason: "worker-runtime-lost" }),
        ...(reconciler ? {
          runtimeEvidence: {
            ...(reconciled.job.result?.runtimeEvidence || {}),
            reconciler: {
              privilege: "host-trusted-reconciler",
              replayedPrompt: false,
              at: settledAt
            }
          }
        } : {})
      };
      if (artifactSettlement.rejected) {
        delete result.writeArtifact;
        result.stopReason = "write-artifact-rejected";
      }
      if (result.runtimeEvidence) {
        result.runtimeEvidence = {
          ...result.runtimeEvidence,
          executionStatus: status === "completed"
            ? "completed"
            : status === "cancelled"
              ? "cancelled"
              : "failed"
        };
      }
      delete result.privacyWarning;
      const terminalized = {
        ...reconciled.job,
        status,
        phase: effective?.phase || "lost",
        summary: effective ? effective.summary : "Lost",
        progress: message,
        completedAt: effective?.completedAt || settledAt,
        heartbeatAt: settledAt,
        error: effective ? effective.error : { code: "E_WORKER_LOST", message },
        workerAuthorization: null,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            cleanupFence: null,
            dispatch: {
              ...latestDispatch,
              nextProviderGeneration: null,
              ...(!effective ? { runtimeLostAt: settledAt } : {}),
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












/**
 * Commit one broker-owned, fenced worktree-provisioning intent. This grants
 * only permission to create the detached bootstrap process; it creates no
 * worktree, provider session, worker dispatch, prompt, or resume authority.
 */
export function prepareWriteProvisionerIntent({
  root,
  principal,
  workerId,
  executionBindingDigest,
  expectedJournalDigest,
  attemptId,
  fence,
  holderId,
  executableIdentity,
  env = process.env
} = {}) {
  assertWriteProvisioningMutationInput({
    root,
    principal,
    workerId,
    executionBindingDigest,
    expectedJournalDigest,
    attemptId,
    fence,
    holderId
  });
  assertExecutableAttestation(executableIdentity);

  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    assertMutationOwnership(current, principal);
    const verified = assertWriteExecutionJob(current, env);
    const providerBindingFields = writeProvisioningProviderBindingFields(
      current,
      verified.binding,
      executableIdentity
    );
    assertWriteProvisioningMutationBoundary(verified, {
      executionBindingDigest,
      attemptId,
      fence,
      holderId
    });
    if (verified.journal.state !== "planned"
      || expectedJournalDigest !== verified.journal.journalDigest
      || fence !== verified.journal.fence + 1) {
      writeProvisioningStateError("Write provisioning plan changed before intent preparation.");
    }

    if (verified.provisioningRuntime) {
      const existing = verified.provisioningRuntime.intent;
      if (existing.status !== "pending"
        || existing.processIdentity !== null
        || existing.expectedPlannedJournalDigest !== expectedJournalDigest
        || !sameExecutableAttestation(
          existing.executableIdentity,
          executableIdentity
        )) {
        writeProvisioningStateError("Write provisioning intent was already consumed.");
      }
      return Object.freeze({
        prepared: false,
        reason: "already-pending",
        replayed: true,
        intent: existing,
        job: current
      });
    }
    assertProvisioningGuardAbsent(verified.binding.controlRoot, workerId);

    const preparedAt = now();
    const providerSpawnIntentId = crypto.randomBytes(16).toString("hex");
    const intent = {
      schemaVersion: WRITE_PROVISIONING_SCHEMA_VERSION,
      purpose: WRITE_PROVISIONING_PURPOSE,
      workerId,
      intentId: providerSpawnIntentId,
      providerSpawnIntentId,
      operationId: crypto.randomUUID(),
      executionBindingDigest,
      expectedPlannedJournalDigest: expectedJournalDigest,
      provisioningAttemptId: attemptId,
      provisioningFence: fence,
      holderId,
      executableIdentity,
      ...providerBindingFields,
      status: "pending",
      processIdentity: null,
      preparedAt,
      activatedAt: null,
      registeredAt: null,
      settledAt: null,
      noChildAt: null,
      resolution: null,
      updatedAt: preparedAt,
      intentDigest: null
    };
    intent.intentDigest = stableDigest(writeProvisioningIntentDigestBody(intent));
    assertWriteProvisioningIntent(intent, verified.binding);
    const provisioningRuntime = {
      schemaVersion: WRITE_PROVISIONING_SCHEMA_VERSION,
      intent,
      activatedJournalDigest: null,
      activationDigest: null,
      officialReceipt: null,
      hostAdoption: null,
      priorAttempts: [],
      executionContextManifest: null,
      executionContextManifestRecordDigest: null,
      cleanupProof: null
    };
    const job = transaction.updateJob(workerId, (latest) => {
      assertMutationOwnership(latest, principal);
      const latestVerified = assertWriteExecutionJob(latest, env);
      if (latestVerified.journal.state !== "planned"
        || latestVerified.journal.journalDigest !== expectedJournalDigest
        || latestVerified.provisioningRuntime !== null) {
        writeProvisioningStateError("Write provisioning state changed before intent publication.");
      }
      assertProvisioningGuardAbsent(latestVerified.binding.controlRoot, workerId);
      const next = {
        ...latest,
        phase: "provisioning-intent-prepared",
        summary: "Write worktree provisioner authorized",
        progress: "Fenced bootstrap intent committed; no child or dispatch authority exists.",
        heartbeatAt: preparedAt,
        provisioningRuntime,
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "checkpoint",
          "Fenced write-worktree bootstrap intent committed.",
          {
            provisioningFence: fence,
            providerSpawnIntentId
          }
        )
      };
      assertWriteExecutionJob(next, env);
      return next;
    });
    return Object.freeze({
      prepared: true,
      reason: "prepared",
      replayed: false,
      intent: job.provisioningRuntime.intent,
      job
    });
  }, env);
}

/**
 * Archive one controller-clean unknown-effect attempt and publish a fresh
 * inactive provisioning intent only after repeated filesystem plus raw-Git
 * absence proof. The immutable official operation identity is preserved.
 */
export function prepareWriteProvisioningReissue({
  root,
  principal,
  workerId,
  executionBindingDigest,
  expectedJournalDigest,
  attemptId,
  fence,
  holderId,
  executableIdentity,
  env = process.env
} = {}) {
  assertWriteProvisioningMutationInput({
    root,
    principal,
    workerId,
    executionBindingDigest,
    expectedJournalDigest,
    attemptId,
    fence,
    holderId
  });
  assertExecutableAttestation(executableIdentity);

  return withWorkspaceStateTransaction(root, function prepareProvisioningReissueTransaction(transaction) {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    assertMutationOwnership(current, principal);
    const verified = assertWriteExecutionJob(current, env);
    const providerBindingFields = writeProvisioningProviderBindingFields(
      current,
      verified.binding,
      executableIdentity
    );
    if (verified.binding.bindingDigest !== executionBindingDigest) {
      writeProvisioningStateError(
        "Provisioning reissue execution binding changed before planning."
      );
    }
    if (verified.journal.state === "reissue_planned") {
      const existing = verified.provisioningRuntime.intent;
      const executableMatches = sameExecutableAttestation(
        existing.executableIdentity,
        executableIdentity
      );
      const exactReplay = (
        verified.journal.journalDigest === expectedJournalDigest
        && existing.provisioningAttemptId === attemptId
        && existing.provisioningFence === fence
        && existing.holderId === holderId
        && executableMatches
      );
      if (exactReplay) {
        return Object.freeze({
          prepared: false,
          reason: "already-reissue-planned",
          replayed: true,
          intent: existing,
          job: current
        });
      }
      const runtime = verified.provisioningRuntime.runtime;
      if (verified.journal.journalDigest !== expectedJournalDigest
        || existing.status !== "pending"
        || existing.processIdentity !== null
        || existing.provisioningAttemptId !== attemptId
        || existing.provisioningFence !== fence
        || (existing.holderId === holderId && executableMatches)
        || (existing.holderId !== holderId
          && runtime.priorAttempts.some((archive) => (
            archive.attemptEvidence.intent.holderId === holderId
          )))
        || executableIdentity.releaseIdentityDigest
          !== existing.executableIdentity.releaseIdentityDigest) {
        writeProvisioningStateError(
          "Durable reissue plan cannot be atomically reauthorized for this caller."
        );
      }
      assertProvisioningGuardAbsent(verified.binding.controlRoot, workerId);
      const reauthorizedAt = now();
      const journal = transitionProvisioningJournal(
        verified.binding,
        verified.journal,
        {
          state: "reissue_planned",
          expectedCurrentJournalDigest: expectedJournalDigest
        }
      );
      const usedSpawnIntentIds = new Set([
        existing.providerSpawnIntentId,
        ...runtime.priorAttempts.map(
          (archive) => archive.attemptEvidence.intent.providerSpawnIntentId
        )
      ]);
      let providerSpawnIntentId;
      do {
        providerSpawnIntentId = crypto.randomBytes(16).toString("hex");
      } while (usedSpawnIntentIds.has(providerSpawnIntentId));
      const intent = {
        schemaVersion: WRITE_PROVISIONING_SCHEMA_VERSION,
        purpose: WRITE_PROVISIONING_PURPOSE,
        workerId,
        intentId: providerSpawnIntentId,
        providerSpawnIntentId,
        operationId: existing.operationId,
        executionBindingDigest,
        expectedPlannedJournalDigest: journal.journalDigest,
        provisioningAttemptId: attemptId,
        provisioningFence: fence,
        holderId,
        executableIdentity,
        ...providerBindingFields,
        status: "pending",
        processIdentity: null,
        preparedAt: journal.reissuePlannedAt,
        activatedAt: null,
        registeredAt: null,
        settledAt: null,
        noChildAt: null,
        resolution: null,
        updatedAt: reauthorizedAt,
        intentDigest: null
      };
      intent.intentDigest = stableDigest(
        writeProvisioningIntentDigestBody(intent)
      );
      assertWriteProvisioningIntent(intent, verified.binding);
      const provisioningRuntime = {
        ...runtime,
        intent,
        activatedJournalDigest: null,
        activationDigest: null,
        officialReceipt: null,
        hostAdoption: null,
        executionContextManifest: null,
        executionContextManifestRecordDigest: null,
        cleanupProof: null
      };
      const job = transaction.updateJob(workerId, (latest) => {
        assertMutationOwnership(latest, principal);
        const latestVerified = assertWriteExecutionJob(latest, env);
        if (latestVerified.journal.state !== "reissue_planned"
          || latestVerified.journal.journalDigest !== expectedJournalDigest
          || latestVerified.provisioningRuntime.intent.intentDigest
            !== existing.intentDigest) {
          writeProvisioningStateError(
            "Durable reissue plan changed before atomic reauthorization."
          );
        }
        assertProvisioningGuardAbsent(
          latestVerified.binding.controlRoot,
          workerId
        );
        const next = {
          ...latest,
          phase: "provisioning-reissue-planned",
          summary: "Write worktree reissue controller reauthorized",
          progress:
            "Inactive durable reissue plan atomically rebound to one fresh controller claimant.",
          updatedAt: reauthorizedAt,
          heartbeatAt: reauthorizedAt,
          provisioning: journal,
          provisioningRuntime,
          lifecycleEvents: appendLifecycleEvent(
            latest.lifecycleEvents || [],
            "checkpoint",
            "Inactive worktree reissue intent atomically reauthorized.",
            {
              operationId: existing.operationId,
              provisioningFence: fence,
              priorProviderSpawnIntentId: existing.providerSpawnIntentId,
              providerSpawnIntentId,
              priorAttemptArchiveDigest:
                journal.priorAttemptArchiveDigest
            }
          )
        };
        assertWriteExecutionJob(next, env);
        return next;
      });
      return Object.freeze({
        prepared: true,
        reason: "reissue-reauthorized",
        replayed: false,
        intent: job.provisioningRuntime.intent,
        archive: job.provisioningRuntime.priorAttempts.at(-1),
        job
      });
    }

    const runtime = verified.provisioningRuntime;
    const priorIntent = runtime?.intent;
    const priorAttempts = runtime?.priorAttempts || [];
    if (verified.journal.state !== "cleanup_pending"
      || verified.journal.journalDigest !== expectedJournalDigest
      || !priorIntent
      || priorIntent.status !== "registered"
      || runtime.receipt !== null
      || runtime.hostAdoption !== null
      || runtime.runtime.executionContextManifest !== null
      || !runtime.cleanupProof
      || priorAttempts.length >= MAX_WRITE_PROVISIONING_ATTEMPTS - 1
      || attemptId === priorIntent.provisioningAttemptId
      || fence !== priorIntent.provisioningFence + 1
      || holderId === priorIntent.holderId
      || executableIdentity.releaseIdentityDigest
        !== priorIntent.executableIdentity.releaseIdentityDigest) {
      writeProvisioningStateError(
        "Cleanup-pending attempt is not eligible for one bounded official reissue."
      );
    }
    assertActualWriteProvisionerCleanup(
      verified.binding,
      priorIntent
    );
    const absenceProof = exactAbsentWorktreeEffect(verified.binding, env);
    const reissuePlannedAt = new Date(Math.max(
      Date.now(),
      Date.parse(verified.journal.cleanupPendingAt),
      Date.parse(absenceProof.observedAt)
    )).toISOString();
    const providerSpawnIntentId = crypto.randomBytes(16).toString("hex");
    const previousArchiveDigest =
      priorAttempts.at(-1)?.archiveDigest ?? null;
    const attemptEvidence = {
      intent: runtime.runtime.intent,
      activatedJournalDigest: runtime.runtime.activatedJournalDigest,
      activationDigest: runtime.runtime.activationDigest,
      officialReceipt: null,
      hostAdoption: null,
      executionContextManifest: null,
      executionContextManifestRecordDigest: null,
      cleanupProof: runtime.runtime.cleanupProof
    };
    const archive = {
      schemaVersion: WRITE_PROVISIONING_SCHEMA_VERSION,
      ordinal: priorAttempts.length + 1,
      previousArchiveDigest,
      operationId: priorIntent.operationId,
      sourceCleanupPendingJournal: verified.journal,
      attemptEvidence,
      absenceProof,
      archivedAt: reissuePlannedAt,
      archiveDigest: null
    };
    archive.archiveDigest = stableDigest(
      writeProvisioningAttemptArchiveWithoutDigest(archive)
    );
    assertWriteProvisioningAttemptArchive(
      archive,
      verified.binding,
      archive.ordinal,
      previousArchiveDigest
    );
    const nextPriorAttempts = [...priorAttempts, archive];
    const journal = transitionProvisioningJournal(
      verified.binding,
      verified.journal,
      {
        state: "reissue_planned",
        expectedCurrentJournalDigest: expectedJournalDigest,
        attemptId,
        fence,
        reissuePlannedAt,
        priorAttemptArchiveDigest: archive.archiveDigest
      }
    );
    const intent = {
      schemaVersion: WRITE_PROVISIONING_SCHEMA_VERSION,
      purpose: WRITE_PROVISIONING_PURPOSE,
      workerId,
      intentId: providerSpawnIntentId,
      providerSpawnIntentId,
      operationId: priorIntent.operationId,
      executionBindingDigest,
      expectedPlannedJournalDigest: journal.journalDigest,
      provisioningAttemptId: attemptId,
      provisioningFence: fence,
      holderId,
      executableIdentity,
      ...providerBindingFields,
      status: "pending",
      processIdentity: null,
      preparedAt: reissuePlannedAt,
      activatedAt: null,
      registeredAt: null,
      settledAt: null,
      noChildAt: null,
      resolution: null,
      updatedAt: reissuePlannedAt,
      intentDigest: null
    };
    intent.intentDigest = stableDigest(writeProvisioningIntentDigestBody(intent));
    assertWriteProvisioningIntent(intent, verified.binding);
    const provisioningRuntime = {
      schemaVersion: WRITE_PROVISIONING_SCHEMA_VERSION,
      intent,
      activatedJournalDigest: null,
      activationDigest: null,
      officialReceipt: null,
      hostAdoption: null,
      priorAttempts: nextPriorAttempts,
      executionContextManifest: null,
      executionContextManifestRecordDigest: null,
      cleanupProof: null
    };

    const job = transaction.updateJob(workerId, (latest) => {
      assertMutationOwnership(latest, principal);
      const latestVerified = assertWriteExecutionJob(latest, env);
      if (latestVerified.journal.state !== "cleanup_pending"
        || latestVerified.journal.journalDigest !== expectedJournalDigest
        || latestVerified.provisioningRuntime?.intent.providerSpawnIntentId
          !== priorIntent.providerSpawnIntentId
        || latestVerified.provisioningRuntime.cleanupProof?.proofDigest
          !== runtime.cleanupProof.proofDigest
        || latestVerified.provisioningRuntime.receipt !== null
        || latestVerified.provisioningRuntime.hostAdoption !== null) {
        writeProvisioningStateError(
          "Write provisioning state changed before reissue planning."
        );
      }
      assertActualWriteProvisionerCleanup(
        latestVerified.binding,
        latestVerified.provisioningRuntime.intent
      );
      const commitAbsenceProof = exactAbsentWorktreeEffect(
        latestVerified.binding,
        env
      );
      if (!sameWorktreeAbsenceIdentity(absenceProof, commitAbsenceProof)) {
        writeProvisioningStateError(
          "Worktree absence identity changed before reissue publication.",
          "E_WORKTREE"
        );
      }
      const next = {
        ...latest,
        status: "queued",
        phase: "provisioning-reissue-planned",
        summary: "Write worktree reissue safely planned",
        progress:
          "Prior unknown effect archived after exact absence proof; fresh controller intent committed.",
        updatedAt: reissuePlannedAt,
        heartbeatAt: reissuePlannedAt,
        provisioning: journal,
        provisioningRuntime,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            providerLaunchPending: false,
            providerLaunchInFlight: false,
            providerLaunchOutcome: "not-ready"
          }
        },
        startedAt: null,
        completedAt: null,
        result: null,
        error: null,
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "checkpoint",
          "Unknown worktree effect proven absent and reissue intent committed.",
          {
            operationId: priorIntent.operationId,
            provisioningFence: fence,
            providerSpawnIntentId,
            priorAttemptArchiveDigest: archive.archiveDigest,
            absenceProofDigest: absenceProof.proofDigest
          }
        )
      };
      assertWriteExecutionJob(next, env);
      return next;
    });
    return Object.freeze({
      prepared: true,
      reason: "reissue-prepared",
      replayed: false,
      intent: job.provisioningRuntime.intent,
      archive: job.provisioningRuntime.priorAttempts.at(-1),
      job
    });
  }, env);
}

/**
 * Persist the exact detached bootstrap identity and atomically advance the
 * journal to provisioning before the private bootstrap specification may be
 * published or any promotion acknowledgement accepted.
 */
export function activateWriteProvisioningAttempt({
  root,
  principal,
  workerId,
  executionBindingDigest,
  expectedJournalDigest,
  attemptId,
  fence,
  holderId,
  providerSpawnIntentId,
  processIdentity,
  leaseExpiresAt,
  provisioningAt = null,
  env = process.env
} = {}) {
  assertWriteProvisioningMutationInput({
    root,
    principal,
    workerId,
    executionBindingDigest,
    expectedJournalDigest,
    attemptId,
    fence,
    holderId,
    providerSpawnIntentId
  }, { requireProviderSpawnIntentId: true });
  assertWriteProvisioningProcessIdentity(processIdentity);
  const requestedProvisioningAt = provisioningAt;
  const activatedAt = provisioningAt ?? now();
  assertCanonicalTimestamp(activatedAt, "provisioningAt");
  assertCanonicalTimestamp(leaseExpiresAt, "leaseExpiresAt");

  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    assertMutationOwnership(current, principal);
    const verified = assertWriteExecutionJob(current, env);
    assertWriteProvisioningMutationBoundary(verified, {
      executionBindingDigest,
      attemptId,
      fence,
      holderId,
      providerSpawnIntentId
    }, { requireIntent: true });
    const intent = verified.provisioningRuntime.intent;

    if (verified.journal.state === "provisioning") {
      if (intent.expectedPlannedJournalDigest !== expectedJournalDigest
        || !["pending", "registered"].includes(intent.status)
        || !sameWriteProvisioningProcessIdentity(intent.processIdentity, processIdentity)
        || (requestedProvisioningAt !== null
          && intent.activatedAt !== requestedProvisioningAt)
        || verified.journal.leaseExpiresAt !== leaseExpiresAt) {
        writeProvisioningStateError(
          "Write provisioner activation replay does not match the durable process boundary.",
          "E_PROCESS_IDENTITY"
        );
      }
      if (!currentOwnedProcessIdentity(processIdentity)
        || processGroupGone(processIdentity)) {
        writeProvisioningStateError(
          "Activated write provisioner is no longer the live detached process.",
          "E_PROCESS_IDENTITY"
        );
      }
      return Object.freeze({
        activated: false,
        replayed: true,
        intent,
        job: current
      });
    }
    if (!["planned", "reissue_planned"].includes(verified.journal.state)
      || verified.journal.journalDigest !== expectedJournalDigest
      || intent.expectedPlannedJournalDigest !== expectedJournalDigest
      || intent.status !== "pending"
      || intent.processIdentity !== null
      || intent.activatedAt !== null) {
      writeProvisioningStateError("Write provisioner intent is no longer activatable.");
    }
    assertProvisioningGuardAbsent(verified.binding.controlRoot, workerId);
    if (!currentOwnedProcessIdentity(processIdentity)
      || processGroupGone(processIdentity)) {
      writeProvisioningStateError(
        "Detached worktree bootstrap identity is not currently owned and alive.",
        "E_PROCESS_IDENTITY"
      );
    }

    const journal = transitionProvisioningJournal(
      verified.binding,
      verified.journal,
      verified.journal.state === "planned"
        ? {
            state: "provisioning",
            expectedCurrentJournalDigest: expectedJournalDigest,
            attemptId,
            fence,
            provisioner: {
              pid: processIdentity.pid,
              startToken: processIdentity.startToken,
              holderId
            },
            leaseExpiresAt,
            provisioningAt: activatedAt
          }
        : {
            state: "provisioning",
            expectedCurrentJournalDigest: expectedJournalDigest,
            actorAttemptId: attemptId,
            actorFence: fence,
            provisioner: {
              pid: processIdentity.pid,
              startToken: processIdentity.startToken,
              holderId
            },
            leaseExpiresAt,
            provisioningAt: activatedAt
          }
    );
    const nextIntent = {
      ...intent,
      processIdentity: { ...processIdentity },
      activatedAt,
      updatedAt: activatedAt
    };
    const provisioningRuntime = {
      ...verified.provisioningRuntime.runtime,
      intent: nextIntent,
      activatedJournalDigest: journal.journalDigest,
      activationDigest: null
    };
    provisioningRuntime.activationDigest = writeProvisioningActivationDigest(
      provisioningRuntime
    );
    const job = transaction.updateJob(workerId, (latest) => {
      assertMutationOwnership(latest, principal);
      const latestVerified = assertWriteExecutionJob(latest, env);
      if (!["planned", "reissue_planned"].includes(latestVerified.journal.state)
        || latestVerified.journal.journalDigest !== expectedJournalDigest
        || latestVerified.provisioningRuntime?.intent.providerSpawnIntentId
          !== providerSpawnIntentId
        || latestVerified.provisioningRuntime.intent.processIdentity !== null) {
        writeProvisioningStateError("Write provisioner state changed before activation.");
      }
      assertProvisioningGuardAbsent(latestVerified.binding.controlRoot, workerId);
      const next = {
        ...latest,
        phase: "worktree-provisioning",
        summary: "Write worktree provisioning active",
        progress: "Detached bootstrap identity durably fenced; provider dispatch remains disabled.",
        heartbeatAt: activatedAt,
        provisioning: journal,
        provisioningRuntime,
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "activity.started",
          "Bound worktree provisioning bootstrap activated.",
          {
            provisioningFence: fence,
            providerSpawnIntentId
          }
        )
      };
      assertWriteExecutionJob(next, env);
      return next;
    });
    return Object.freeze({
      activated: true,
      replayed: false,
      intent: job.provisioningRuntime.intent,
      job
    });
  }, env);
}

/**
 * Bind the normalized official create result to an independent host-side
 * registered-worktree verification. The full receipt remains private state.
 */
export function recordOfficialWorktreeReceipt({
  root,
  principal,
  workerId,
  executionBindingDigest,
  expectedJournalDigest,
  attemptId,
  fence,
  holderId,
  providerSpawnIntentId,
  officialReceipt,
  executableIdentity,
  receivedAt = null,
  env = process.env
} = {}) {
  assertWriteProvisioningMutationInput({
    root,
    principal,
    workerId,
    executionBindingDigest,
    expectedJournalDigest,
    attemptId,
    fence,
    holderId,
    providerSpawnIntentId
  }, { requireProviderSpawnIntentId: true });
  if (receivedAt !== null) assertCanonicalTimestamp(receivedAt, "receivedAt");

  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    assertMutationOwnership(current, principal);
    const verified = assertWriteExecutionJob(current, env);
    assertWriteProvisioningMutationBoundary(verified, {
      executionBindingDigest,
      attemptId,
      fence,
      holderId,
      providerSpawnIntentId
    }, { requireIntent: true });
    if (verified.journal.state !== "provisioning"
      || verified.journal.journalDigest !== expectedJournalDigest
      || verified.provisioningRuntime.intent.status !== "registered") {
      writeProvisioningStateError(
        "Official worktree receipt requires the registered fenced provisioner."
      );
    }
    const intent = verified.provisioningRuntime.intent;
    assertOfficialWorktreeReceiptInput(officialReceipt, verified.binding, intent);
    if (!sameExecutableAttestation(
      executableIdentity,
      intent.executableIdentity
    )) {
      writeProvisioningStateError(
        "Official worktree receipt executable identity changed after intent.",
        "E_PROCESS_IDENTITY"
      );
    }
    const existing = verified.provisioningRuntime.receipt;
    const observedAt = receivedAt ?? existing?.receivedAt ?? now();
    assertCanonicalTimestamp(observedAt, "receivedAt");
    if (!existing
      && (
        Date.now() > Date.parse(verified.journal.leaseExpiresAt)
        || Date.parse(observedAt)
          > Date.parse(verified.journal.leaseExpiresAt)
      )) {
      writeProvisioningStateError(
        "Official worktree receipt arrived after the provisioning lease expired."
      );
    }
    const verification = managedWorktreeVerification(verified.binding, env);
    if (Date.parse(verification.verifiedAt) < Date.parse(observedAt)) {
      writeProvisioningStateError("Official receipt time is later than host verification.");
    }

    const durableReceipt = {
      schemaVersion: WRITE_PROVISIONING_SCHEMA_VERSION,
      operationId: intent.operationId,
      officialStatus: officialReceipt.status,
      officialSessionId: officialReceipt.sessionId,
      worktreePath: officialReceipt.worktreePath,
      sourceGitRoot: officialReceipt.sourceGitRoot,
      commit: officialReceipt.commit,
      executableIdentity,
      receivedAt: observedAt,
      hostVerification: verification,
      receiptDigest: null
    };
    durableReceipt.receiptDigest = stableDigest(
      officialWorktreeReceiptWithoutDigest(durableReceipt)
    );
    assertOfficialWorktreeReceipt(durableReceipt, verified.binding, intent);

    if (existing) {
      if (existing.operationId !== durableReceipt.operationId
        || existing.officialStatus !== durableReceipt.officialStatus
        || existing.officialSessionId !== durableReceipt.officialSessionId
        || existing.worktreePath !== durableReceipt.worktreePath
        || existing.sourceGitRoot !== durableReceipt.sourceGitRoot
        || existing.commit !== durableReceipt.commit
        || !sameExecutableAttestation(
          existing.executableIdentity,
          durableReceipt.executableIdentity
        )
        || existing.receivedAt !== durableReceipt.receivedAt
        || !sameWorktreeVerificationIdentity(
          existing.hostVerification,
          durableReceipt.hostVerification
        )) {
        writeProvisioningStateError("Official worktree receipt replay changed durable evidence.");
      }
      return Object.freeze({
        recorded: false,
        replayed: true,
        receipt: existing,
        job: current
      });
    }

    const job = transaction.updateJob(workerId, (latest) => {
      assertMutationOwnership(latest, principal);
      const latestVerified = assertWriteExecutionJob(latest, env);
      if (latestVerified.journal.state !== "provisioning"
        || latestVerified.journal.journalDigest !== expectedJournalDigest
        || latestVerified.provisioningRuntime?.intent.providerSpawnIntentId
          !== providerSpawnIntentId
        || latestVerified.provisioningRuntime.intent.status !== "registered"
        || latestVerified.provisioningRuntime.receipt !== null) {
        writeProvisioningStateError("Write provisioning state changed before receipt publication.");
      }
      const next = {
        ...latest,
        progress: "Official worktree receipt independently verified; cleanup proof is still required.",
        heartbeatAt: observedAt,
        provisioningRuntime: {
          ...latest.provisioningRuntime,
          officialReceipt: durableReceipt
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "checkpoint",
          "Official worktree creation receipt independently verified.",
          {
            operationId: intent.operationId,
            receiptDigest: durableReceipt.receiptDigest
          }
        )
      };
      assertWriteExecutionJob(next, env);
      return next;
    });
    return Object.freeze({
      recorded: true,
      replayed: false,
      receipt: job.provisioningRuntime.officialReceipt,
      job
    });
  }, env);
}

/**
 * Promote only a verified worktree to ready. P3-P3 deliberately grants no
 * provider dispatch, authorization, provider session, prompt, or resume
 * authority; P3-P4 must add those materials in a separate atomic transition.
 */
export function promoteWriteWorkerReady({
  root,
  principal,
  workerId,
  executionBindingDigest,
  expectedJournalDigest,
  attemptId,
  fence,
  holderId,
  providerSpawnIntentId,
  executionContextManifest,
  cleanupProof,
  readyAt = null,
  env = process.env
} = {}) {
  assertWriteProvisioningMutationInput({
    root,
    principal,
    workerId,
    executionBindingDigest,
    expectedJournalDigest,
    attemptId,
    fence,
    holderId,
    providerSpawnIntentId
  }, { requireProviderSpawnIntentId: true });
  const requestedReadyAt = readyAt;
  if (requestedReadyAt !== null) assertCanonicalTimestamp(requestedReadyAt, "readyAt");

  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    assertMutationOwnership(current, principal);
    const verified = assertWriteExecutionJob(current, env);
    assertWriteProvisioningMutationBoundary(verified, {
      executionBindingDigest,
      attemptId,
      fence,
      holderId,
      providerSpawnIntentId
    }, { requireIntent: true });
    const runtime = verified.provisioningRuntime;
    const intent = runtime.intent;
    // Admit the caller-provided execution capture after integrity + DEFAULT
    // linked semantic recheck. Persist that stored object (not a fresh rebind).
    const currentManifest = assertContextCompatible(
      verified.binding.expectedExecutionRoot,
      executionContextManifest,
      { mode: "execute" }
    );
    if (currentManifest.schemaVersion !== CONTEXT_MANIFEST_VERSION
      || currentManifest.workspaceRoot !== verified.binding.expectedExecutionRoot
      || currentManifest.git?.head !== verified.binding.baseCommit) {
      writeProvisioningStateError(
        "Execution ContextManifest is not chronology-authenticated and exact for the verified worktree.",
        "E_CONTEXT_DRIFT"
      );
    }
    const durableCleanup = buildWriteProvisioningCleanupProof(cleanupProof, intent);
    assertActualWriteProvisionerCleanup(verified.binding, intent);
    const currentVerification = managedWorktreeVerification(verified.binding, env);
    if (!runtime.receipt
      || !sameWorktreeVerificationIdentity(
        runtime.receipt.hostVerification,
        currentVerification
      )) {
      writeProvisioningStateError(
        "Verified worktree identity changed after the official receipt.",
        "E_WORKTREE"
      );
    }
    const promotedAt = requestedReadyAt
      ?? (verified.journal.state === "ready" ? intent.settledAt : now());
    assertCanonicalTimestamp(promotedAt, "readyAt");
    const contextEvidenceAt = verified.journal.state === "ready"
      ? runtime.runtime.executionContextManifest?.capturedAt
      : executionContextManifest?.capturedAt;
    for (const [timestamp, label] of [
      [runtime.receipt.receivedAt, "official receipt"],
      [runtime.receipt.hostVerification.verifiedAt, "host verification"],
      [durableCleanup.observedAt, "cleanup proof"],
      [contextEvidenceAt, "execution ContextManifest"]
    ]) {
      assertCanonicalTimestamp(timestamp, `${label} time`);
      if (Date.parse(promotedAt) < Date.parse(timestamp)) {
        writeProvisioningStateError(`Ready promotion cannot predate its ${label}.`);
      }
    }

    if (verified.journal.state === "ready") {
      const storedExecutionContext = assertContextManifestIntegrity(
        runtime.runtime.executionContextManifest
      );
      if (verified.journal.previousJournalDigest !== expectedJournalDigest
        || intent.status !== "settled"
        || (requestedReadyAt !== null && intent.settledAt !== requestedReadyAt)
        || storedExecutionContext.schemaVersion !== CONTEXT_MANIFEST_VERSION
        || storedExecutionContext.manifestId
          !== verified.journal.executionContextManifestId
        || storedExecutionContext.digest
          !== verified.journal.executionContextManifestDigest
        || runtime.cleanupProof.proofDigest !== durableCleanup.proofDigest) {
        writeProvisioningStateError("Ready write-worker replay changed promotion evidence.");
      }
      return Object.freeze({
        promoted: false,
        replayed: true,
        job: current
      });
    }
    if (verified.journal.state !== "provisioning"
      || verified.journal.journalDigest !== expectedJournalDigest
      || intent.status !== "registered"
      || !runtime.receipt) {
      writeProvisioningStateError(
        "Write worker cannot become ready without its exact registered provisioner and receipt."
      );
    }
    if (Date.now() > Date.parse(verified.journal.leaseExpiresAt)
      || Date.parse(promotedAt)
        > Date.parse(verified.journal.leaseExpiresAt)) {
      writeProvisioningStateError(
        "Write worker cannot become ready after its provisioning lease expired."
      );
    }

    const journal = transitionProvisioningJournal(
      verified.binding,
      verified.journal,
      {
        state: "ready",
        expectedCurrentJournalDigest: expectedJournalDigest,
        actorAttemptId: attemptId,
        actorFence: fence,
        actorHolderId: holderId,
        readyAt: promotedAt,
        executionContextManifestId: currentManifest.manifestId,
        executionContextManifestDigest: currentManifest.digest
      }
    );
    const nextIntent = {
      ...intent,
      status: "settled",
      settledAt: promotedAt,
      updatedAt: promotedAt
    };
    const nextRuntime = {
      ...runtime.runtime,
      intent: nextIntent,
      executionContextManifest: executionContextManifest,
      executionContextManifestRecordDigest: stableDigest(executionContextManifest),
      cleanupProof: durableCleanup
    };
    const job = transaction.updateJob(workerId, (latest) => {
      assertMutationOwnership(latest, principal);
      const latestVerified = assertWriteExecutionJob(latest, env);
      if (latestVerified.journal.state !== "provisioning"
        || latestVerified.journal.journalDigest !== expectedJournalDigest
        || latestVerified.provisioningRuntime?.intent.providerSpawnIntentId
          !== providerSpawnIntentId
        || latestVerified.provisioningRuntime.intent.status !== "registered"
        || latestVerified.provisioningRuntime.receipt?.receiptDigest
          !== runtime.receipt.receiptDigest) {
        writeProvisioningStateError("Write provisioning state changed before ready promotion.");
      }
      assertActualWriteProvisionerCleanup(latestVerified.binding, intent);
      const next = {
        ...latest,
        phase: "worktree-ready",
        summary: "Verified write worktree ready",
        progress: "Worktree verified and provisioner cleaned; provider dispatch is not yet authorized.",
        heartbeatAt: promotedAt,
        provisioning: journal,
        provisioningRuntime: nextRuntime,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            providerLaunchOutcome: WRITE_READY_LAUNCH_OUTCOME
          }
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "activity.completed",
          "Verified worktree promoted without provider dispatch authority.",
          {
            operationId: intent.operationId,
            receiptDigest: runtime.receipt.receiptDigest,
            cleanupProofDigest: durableCleanup.proofDigest
          }
        )
      };
      assertWriteExecutionJob(next, env);
      return next;
    });
    return Object.freeze({
      promoted: true,
      replayed: false,
      job
    });
  }, env);
}

/**
 * Retain an activated provisioner in cleanup-pending after its exact
 * controller process and guard are gone, without claiming whether the
 * official worktree effect occurred. A verified receipt is preserved when
 * available; null remains an explicit unknown-effect state.
 */

/**
 * Adopt one exact, clean worktree whose official create response was lost
 * after the broker had durably retained the unknown effect. This records
 * host-observed evidence, never fabricates an official Grok receipt, and
 * grants no provider-dispatch authority.
 */

/**
 * Settle an exact provisioning intent when no usable child survives. A
 * prepared/no-process intent may fail directly; an activated intent requires
 * exact cleanup proof and a verified absent guard before terminal publication.
 */


/**
 * Validate one durable write job for exact spawn-admission replay.
 *
 * Pre-dispatch/provisioning jobs keep assertWriteExecutionJob. Once a
 * dispatch-v2 outbox exists (including terminal provider outcomes), the
 * immutable executionBinding and dispatch contract are fail-closed without
 * recomputing dirty execution-worktree acceptance context.
 */

/**
 * Persist only a write-worker plan. This is an internal Phase 3 admission
 * boundary: it creates no worktree and grants no dispatch or provider
 * authority. A later fenced provisioner must promote the journal to ready.
 */

/**
 * Commit a durable read-only worker job. Provider launch is intentionally not performed.
 * write:true routes only to the internal admission-only Phase 3 plan.
 */
