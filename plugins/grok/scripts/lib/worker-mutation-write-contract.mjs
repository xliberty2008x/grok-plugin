/** Issue #56 worker-mutation write-contract domain. */
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
import { processGroupGone, processStartToken } from "./process-control.mjs";
import {
  assertExecutionBinding,
  assertProvisioningJournal,
  createExecutionBinding,
  createProvisioningJournal,
  transitionProvisioningJournal
} from "./worker-execution-binding.mjs";
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
  completeOwnedProcessIdentity,
  digestKey,
  hasExactKeys,
  stableDigest
} from "./worker-mutation-primitives.mjs";

export const PRE_READY_WRITE_REQUEST_KEYS = new Set([
  "admissionContextManifest",
  "envelope",
  "providerHomeId",
  "publicObjective",
  "roleId",
  "spawn"
]);

export const PRE_READY_WRITE_SPAWN_KEYS = new Set([
  "idempotencyKeyDigest",
  "ownerThreadId",
  "admissionRequestDigest",
  "successDefinition",
  "ownershipMode",
  "writeLifecycleCapabilityDigest",
  "providerLaunchPending",
  "providerLaunchInFlight",
  "providerLaunchOutcome"
]);

export const BOUND_PRE_READY_WRITE_SPAWN_KEYS = new Set([
  ...PRE_READY_WRITE_SPAWN_KEYS,
  "providerLaunchBinding",
  "providerLaunchBindingDigest"
]);

export const WRITE_EXECUTION_JOB_KEYS = new Set([
  "schemaVersion",
  "id",
  "kind",
  "jobClass",
  "write",
  "status",
  "phase",
  "summary",
  "progress",
  "createdAt",
  "updatedAt",
  "startedAt",
  "completedAt",
  "heartbeatAt",
  "host",
  "profile",
  "role",
  "model",
  "effort",
  "controlWorkspaceId",
  "executionBinding",
  "provisioning",
  "request",
  "lifecycleEvents",
  "result",
  "error"
]);

export const WRITE_PROVISIONING_RUNTIME_KEYS = new Set([
  "schemaVersion",
  "intent",
  "activatedJournalDigest",
  "activationDigest",
  "officialReceipt",
  "hostAdoption",
  "priorAttempts",
  "executionContextManifest",
  "executionContextManifestRecordDigest",
  "cleanupProof"
]);

export const LEGACY_WRITE_PROVISIONING_RUNTIME_KEY_SETS = Object.freeze([
  new Set([...WRITE_PROVISIONING_RUNTIME_KEYS].filter((key) => key !== "priorAttempts")),
  new Set([...WRITE_PROVISIONING_RUNTIME_KEYS].filter((key) => key !== "hostAdoption")),
  new Set([...WRITE_PROVISIONING_RUNTIME_KEYS].filter((key) => (
    key !== "hostAdoption" && key !== "priorAttempts"
  )))
]);

export const WRITE_PROVISIONING_INTENT_KEYS = new Set([
  "schemaVersion",
  "purpose",
  "workerId",
  "intentId",
  "providerSpawnIntentId",
  "operationId",
  "executionBindingDigest",
  "expectedPlannedJournalDigest",
  "provisioningAttemptId",
  "provisioningFence",
  "holderId",
  "executableIdentity",
  "status",
  "processIdentity",
  "preparedAt",
  "activatedAt",
  "registeredAt",
  "settledAt",
  "noChildAt",
  "resolution",
  "updatedAt",
  "intentDigest"
]);

export const BOUND_WRITE_PROVISIONING_INTENT_KEYS = new Set([
  ...WRITE_PROVISIONING_INTENT_KEYS,
  "providerLaunchBinding",
  "providerLaunchBindingDigest"
]);

export const WRITE_PROVISIONING_PROCESS_KEYS = new Set([
  "pid",
  "startToken",
  "processGroupId"
]);

export const OFFICIAL_WORKTREE_RECEIPT_INPUT_KEYS = new Set([
  "status",
  "sessionId",
  "worktreePath",
  "sourceGitRoot",
  "commit"
]);

export const OFFICIAL_WORKTREE_RECEIPT_KEYS = new Set([
  "schemaVersion",
  "operationId",
  "officialStatus",
  "officialSessionId",
  "worktreePath",
  "sourceGitRoot",
  "commit",
  "executableIdentity",
  "receivedAt",
  "hostVerification",
  "receiptDigest"
]);

export const WORKTREE_HOST_ADOPTION_KEYS = new Set([
  "schemaVersion",
  "origin",
  "operationId",
  "providerSpawnIntentId",
  "provisioningIntentDigest",
  "requestedExecutableIdentityDigest",
  "requestedReleaseIdentityDigest",
  "cleanupPendingAt",
  "cleanupPendingJournalDigest",
  "cleanupProofDigest",
  "hostVerification",
  "observedAt",
  "adoptionDigest"
]);

export const WORKTREE_HOST_VERIFICATION_KEYS = new Set([
  "schemaVersion",
  "controlWorkspaceId",
  "controlRootDigest",
  "gitCommonDirDigest",
  "expectedExecutionRootDigest",
  "baseCommit",
  "baseTree",
  "parentFingerprintDigest",
  "registeredWorktreeDigest",
  "worktreeFingerprintDigest",
  "worktreeIndexDigest",
  "worktreeIndexSecurityDigest",
  "worktreeDigest",
  "worktreeEntryCount",
  "verifiedAt",
  "verificationDigest"
]);

export const WORKTREE_ABSENCE_PROOF_KEYS = new Set([
  "schemaVersion",
  "classification",
  "workerId",
  "controlWorkspaceId",
  "controlRootDigest",
  "gitCommonDirDigest",
  "expectedExecutionRootDigest",
  "expectedWorkerParentDigest",
  "baseCommitDigest",
  "filesystemPathState",
  "workerParentState",
  "managedRootIdentityDigest",
  "workerParentIdentityDigest",
  "rawInventoryDigest",
  "adminInventoryDigest",
  "exactRegistrationCount",
  "managedParentRegistrationCount",
  "adminBacklinkMatchCount",
  "observedAt",
  "proofDigest"
]);

export const WRITE_PROVISIONING_ATTEMPT_ARCHIVE_KEYS = new Set([
  "schemaVersion",
  "ordinal",
  "previousArchiveDigest",
  "operationId",
  "sourceCleanupPendingJournal",
  "attemptEvidence",
  "absenceProof",
  "archivedAt",
  "archiveDigest"
]);

export const WRITE_PROVISIONING_ATTEMPT_EVIDENCE_KEYS = new Set([
  "intent",
  "activatedJournalDigest",
  "activationDigest",
  "officialReceipt",
  "hostAdoption",
  "executionContextManifest",
  "executionContextManifestRecordDigest",
  "cleanupProof"
]);

export const WRITE_PROVISIONING_CLEANUP_INPUT_KEYS = new Set([
  "processIdentity",
  "processGroupGone",
  "providerGuardAbsent",
  "observedAt"
]);

export const WRITE_PROVISIONING_CLEANUP_KEYS = new Set([
  "schemaVersion",
  "providerSpawnIntentId",
  "processIdentity",
  "processGroupGone",
  "providerGuardAbsent",
  "observedAt",
  "proofDigest"
]);

export const WRITE_PROVISIONING_PURPOSE = "worktree-provisioning";

export const WRITE_PROVISIONING_SCHEMA_VERSION = 1;

export const WRITE_PROVISIONING_INTENT_STATUSES = new Set([
  "pending",
  "registered",
  "settled",
  "no-child"
]);

export const WRITE_PROVISIONING_NO_CHILD_RESOLUTIONS = new Set([
  "spawn-not-created",
  "cleanup-proven",
  "preactivation-cleanup-proven",
  "authorization-revoked"
]);

export const WRITE_PREACTIVATION_CLEANUP_RESOLUTION = "preactivation-cleanup-proven";

export const WRITE_READY_LAUNCH_OUTCOME = "worktree-ready-no-dispatch";

export const WRITE_HOST_ADOPTION_ORIGIN =
  "unknown-official-response-host-adoption";

export const MAX_WRITE_PROVISIONING_ATTEMPTS = 3;

export const EXACT_NONCE_HEX = /^[a-f0-9]{32}$/;

export const OPAQUE_HEX = /^[a-f0-9]{32,64}$/;

export function writeAdmissionOwnerDigest(host) {
  return stableDigest({
    hostKind: host?.kind || null,
    sessionId: host?.sessionId || null
  });
}

export function writeAdmissionRequestDigest({
  binding,
  idempotencyKeyDigest
}) {
  return stableDigest({
    schemaVersion: 1,
    executionBindingDigest: binding.bindingDigest,
    idempotencyKeyDigest
  });
}

export function writeProvisioningStateError(message, code = "E_STATE") {
  throw new CompanionError(code, message);
}

export function canonicalTimestamp(value) {
  if (typeof value !== "string" || !value) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

export function assertCanonicalTimestamp(value, label) {
  if (!canonicalTimestamp(value)) {
    writeProvisioningStateError(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

export function assertTimestampNotBefore(value, minimum, label) {
  assertCanonicalTimestamp(value, label);
  assertCanonicalTimestamp(minimum, `${label} lower bound`);
  if (Date.parse(value) < Date.parse(minimum)) {
    writeProvisioningStateError(`${label} is not monotonic.`);
  }
  return value;
}

export function assertBoundedOperationId(value) {
  if (typeof value !== "string"
    || value.length < 1
    || value.length > 128
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    writeProvisioningStateError("Official worktree operation identity is malformed.");
  }
  return value;
}

export function assertWriteProvisioningProcessIdentity(identity, {
  nullable = false
} = {}) {
  if (nullable && identity === null) return null;
  if (!hasExactKeys(identity, WRITE_PROVISIONING_PROCESS_KEYS)
    || !completeOwnedProcessIdentity(identity)
    || !Number.isSafeInteger(identity.pid)
    || identity.pid > 2_147_483_647
    || identity.startToken.trim() !== identity.startToken
    || identity.startToken.includes("\0")) {
    writeProvisioningStateError(
      "Write provisioning bootstrap identity is incomplete or not detached.",
      "E_PROCESS_IDENTITY"
    );
  }
  return identity;
}

export function sameWriteProvisioningProcessIdentity(left, right) {
  try {
    assertWriteProvisioningProcessIdentity(left);
    assertWriteProvisioningProcessIdentity(right);
  } catch {
    return false;
  }
  return left.pid === right.pid
    && left.startToken === right.startToken
    && left.processGroupId === right.processGroupId;
}

export function writeProvisioningIntentDigestBody(intent) {
  return {
    schemaVersion: intent.schemaVersion,
    purpose: intent.purpose,
    workerId: intent.workerId,
    intentId: intent.intentId,
    providerSpawnIntentId: intent.providerSpawnIntentId,
    operationId: intent.operationId,
    executionBindingDigest: intent.executionBindingDigest,
    expectedPlannedJournalDigest: intent.expectedPlannedJournalDigest,
    provisioningAttemptId: intent.provisioningAttemptId,
    provisioningFence: intent.provisioningFence,
    holderId: intent.holderId,
    executableIdentity: intent.executableIdentity,
    ...(Object.hasOwn(intent, "providerLaunchBinding")
      ? {
          providerLaunchBinding: intent.providerLaunchBinding,
          providerLaunchBindingDigest: intent.providerLaunchBindingDigest
        }
      : {}),
    preparedAt: intent.preparedAt
  };
}

export function assertWriteProvisioningIntent(intent, binding) {
  const boundProvider = binding.providerLaunchBindingDigest !== null;
  const expectedKeys = boundProvider
    ? BOUND_WRITE_PROVISIONING_INTENT_KEYS
    : WRITE_PROVISIONING_INTENT_KEYS;
  if (!hasExactKeys(intent, expectedKeys)
    || intent.schemaVersion !== WRITE_PROVISIONING_SCHEMA_VERSION
    || intent.purpose !== WRITE_PROVISIONING_PURPOSE
    || intent.workerId !== binding.workerId
    || !EXACT_NONCE_HEX.test(intent.intentId || "")
    || intent.providerSpawnIntentId !== intent.intentId
    || !EXACT_NONCE_HEX.test(intent.providerSpawnIntentId || "")
    || intent.executionBindingDigest !== binding.bindingDigest
    || !SHA256_HEX.test(intent.expectedPlannedJournalDigest || "")
    || !EXACT_NONCE_HEX.test(intent.provisioningAttemptId || "")
    || !Number.isSafeInteger(intent.provisioningFence)
    || intent.provisioningFence < 1
    || !OPAQUE_HEX.test(intent.holderId || "")
    || (boundProvider && (
      intent.providerLaunchBindingDigest
        !== binding.providerLaunchBindingDigest
      || digestProviderLaunchBinding(intent.providerLaunchBinding)
        !== binding.providerLaunchBindingDigest
      || intent.providerLaunchBinding.executableIdentityDigest
        !== intent.executableIdentity?.identityDigest
    ))
    || !WRITE_PROVISIONING_INTENT_STATUSES.has(intent.status)
    || intent.intentDigest !== stableDigest(writeProvisioningIntentDigestBody(intent))) {
    writeProvisioningStateError("Write provisioning intent is malformed or not binding-bound.");
  }
  try {
    assertExecutableAttestation(intent.executableIdentity);
  } catch {
    writeProvisioningStateError(
      "Write provisioning intent has malformed executable identity.",
      "E_PROCESS_IDENTITY"
    );
  }
  assertBoundedOperationId(intent.operationId);
  assertTimestampNotBefore(intent.preparedAt, binding.createdAt, "intent.preparedAt");
  assertCanonicalTimestamp(intent.updatedAt, "intent.updatedAt");
  if (Date.parse(intent.updatedAt) < Date.parse(intent.preparedAt)) {
    writeProvisioningStateError("Write provisioning intent update time is not monotonic.");
  }

  const processIdentity = assertWriteProvisioningProcessIdentity(
    intent.processIdentity,
    { nullable: true }
  );
  const activatedAt = intent.activatedAt === null
    ? null
    : assertTimestampNotBefore(intent.activatedAt, intent.preparedAt, "intent.activatedAt");
  const registeredAt = intent.registeredAt === null
    ? null
    : assertTimestampNotBefore(
        intent.registeredAt,
        activatedAt || intent.preparedAt,
        "intent.registeredAt"
      );
  const settledAt = intent.settledAt === null
    ? null
    : assertTimestampNotBefore(
        intent.settledAt,
        registeredAt || activatedAt || intent.preparedAt,
        "intent.settledAt"
      );
  const noChildAt = intent.noChildAt === null
    ? null
    : assertTimestampNotBefore(
        intent.noChildAt,
        activatedAt || intent.preparedAt,
        "intent.noChildAt"
      );

  if (intent.status === "pending") {
    if (registeredAt !== null || settledAt !== null || noChildAt !== null
      || intent.resolution !== null
      || ((processIdentity === null) !== (activatedAt === null))) {
      writeProvisioningStateError("Pending write provisioning intent has inconsistent runtime evidence.");
    }
  } else if (intent.status === "registered") {
    if (!processIdentity || activatedAt === null || registeredAt === null
      || settledAt !== null || noChildAt !== null || intent.resolution !== null) {
      writeProvisioningStateError("Registered write provisioning intent is incomplete.");
    }
  } else if (intent.status === "settled") {
    if (!processIdentity || activatedAt === null || registeredAt === null
      || settledAt === null || noChildAt !== null || intent.resolution !== null) {
      writeProvisioningStateError("Settled write provisioning intent is incomplete.");
    }
  } else if (
    settledAt !== null
    || noChildAt === null
    || !WRITE_PROVISIONING_NO_CHILD_RESOLUTIONS.has(intent.resolution)
    || ((processIdentity === null) !== (activatedAt === null))
  ) {
    writeProvisioningStateError("No-child write provisioning intent is incomplete.");
  }
  return intent;
}

export function writeProvisioningProviderBindingFields(job, binding, executableIdentity) {
  const providerBinding = providerLaunchBindingForJob(job, { required: false });
  if (!providerBinding) {
    if (binding.providerLaunchBindingDigest !== null) {
      writeProvisioningStateError(
        "Write execution binding lost its provider executable binding.",
        "E_PROCESS_IDENTITY"
      );
    }
    return {};
  }
  const digest = digestProviderLaunchBinding(providerBinding);
  if (binding.providerLaunchBindingDigest !== digest
    || providerBinding.executableIdentityDigest
      !== executableIdentity?.identityDigest) {
    writeProvisioningStateError(
      "Write provisioner executable does not match the admitted provider pin.",
      "E_PROCESS_IDENTITY"
    );
  }
  return {
    providerLaunchBinding: providerBinding,
    providerLaunchBindingDigest: digest
  };
}

export function writeProvisioningActivationDigest(runtime) {
  return stableDigest({
    schemaVersion: WRITE_PROVISIONING_SCHEMA_VERSION,
    intentDigest: runtime.intent.intentDigest,
    providerSpawnIntentId: runtime.intent.providerSpawnIntentId,
    processIdentity: runtime.intent.processIdentity,
    executableIdentityDigest: runtime.intent.executableIdentity.identityDigest,
    activatedAt: runtime.intent.activatedAt,
    activatedJournalDigest: runtime.activatedJournalDigest
  });
}

export function worktreeVerificationWithoutDigest(verification) {
  const { verificationDigest: _verificationDigest, ...body } = verification;
  return body;
}

export function assertWorktreeHostVerification(verification, binding) {
  if (!hasExactKeys(verification, WORKTREE_HOST_VERIFICATION_KEYS)
    || verification.schemaVersion !== WRITE_PROVISIONING_SCHEMA_VERSION
    || verification.controlWorkspaceId !== binding.controlWorkspaceId
    || verification.controlRootDigest !== binding.controlRootDigest
    || verification.gitCommonDirDigest !== binding.gitCommonDirDigest
    || verification.expectedExecutionRootDigest !== binding.expectedExecutionRootDigest
    || verification.baseCommit !== binding.baseCommit
    || verification.baseTree !== binding.baseTree
    || verification.parentFingerprintDigest !== binding.parentFingerprintDigest
    || !SHA256_HEX.test(verification.registeredWorktreeDigest || "")
    || !SHA256_HEX.test(verification.worktreeFingerprintDigest || "")
    || !SHA256_HEX.test(verification.worktreeIndexDigest || "")
    || !SHA256_HEX.test(verification.worktreeIndexSecurityDigest || "")
    || !SHA256_HEX.test(verification.worktreeDigest || "")
    || !Number.isSafeInteger(verification.worktreeEntryCount)
    || verification.worktreeEntryCount < 0
    || verification.verificationDigest
      !== stableDigest(worktreeVerificationWithoutDigest(verification))) {
    writeProvisioningStateError("Independent worktree verification evidence is malformed.");
  }
  assertCanonicalTimestamp(verification.verifiedAt, "hostVerification.verifiedAt");
  return verification;
}

export function officialWorktreeReceiptWithoutDigest(receipt) {
  const { receiptDigest: _receiptDigest, ...body } = receipt;
  return body;
}

export function assertOfficialWorktreeReceipt(receipt, binding, intent) {
  if (!hasExactKeys(receipt, OFFICIAL_WORKTREE_RECEIPT_KEYS)
    || receipt.schemaVersion !== WRITE_PROVISIONING_SCHEMA_VERSION
    || receipt.operationId !== intent.operationId
    || !["created", "exists"].includes(receipt.officialStatus)
    || receipt.officialSessionId !== intent.operationId
    || receipt.worktreePath !== binding.expectedExecutionRoot
    || receipt.sourceGitRoot !== binding.controlRoot
    || receipt.commit !== binding.baseCommit
    || !sameExecutableAttestation(
      receipt.executableIdentity,
      intent.executableIdentity
    )
    || receipt.receiptDigest !== stableDigest(officialWorktreeReceiptWithoutDigest(receipt))) {
    writeProvisioningStateError("Official worktree receipt is malformed or not binding-bound.");
  }
  assertTimestampNotBefore(
    receipt.receivedAt,
    intent.registeredAt || intent.activatedAt || intent.preparedAt,
    "receipt.receivedAt"
  );
  const verification = assertWorktreeHostVerification(receipt.hostVerification, binding);
  if (Date.parse(verification.verifiedAt) < Date.parse(receipt.receivedAt)) {
    writeProvisioningStateError("Independent worktree verification predates the official receipt.");
  }
  return receipt;
}

export function worktreeHostAdoptionWithoutDigest(adoption) {
  const { adoptionDigest: _adoptionDigest, ...body } = adoption;
  return body;
}

export function assertWorktreeHostAdoption(
  adoption,
  binding,
  intent,
  cleanupProof,
  expectedCleanupPendingJournalDigest = null
) {
  if (!cleanupProof
    || !SHA256_HEX.test(cleanupProof.proofDigest || "")) {
    writeProvisioningStateError(
      "Host-adoption evidence requires exact controller-cleanup proof."
    );
  }
  if (!hasExactKeys(adoption, WORKTREE_HOST_ADOPTION_KEYS)
    || adoption.schemaVersion !== WRITE_PROVISIONING_SCHEMA_VERSION
    || adoption.origin !== WRITE_HOST_ADOPTION_ORIGIN
    || adoption.operationId !== intent.operationId
    || adoption.providerSpawnIntentId !== intent.providerSpawnIntentId
    || adoption.provisioningIntentDigest !== intent.intentDigest
    || adoption.requestedExecutableIdentityDigest
      !== intent.executableIdentity.identityDigest
    || adoption.requestedReleaseIdentityDigest
      !== intent.executableIdentity.releaseIdentityDigest
    || !SHA256_HEX.test(adoption.cleanupPendingJournalDigest || "")
    || (expectedCleanupPendingJournalDigest !== null
      && adoption.cleanupPendingJournalDigest
        !== expectedCleanupPendingJournalDigest)
    || adoption.cleanupProofDigest !== cleanupProof?.proofDigest
    || adoption.adoptionDigest
      !== stableDigest(worktreeHostAdoptionWithoutDigest(adoption))) {
    writeProvisioningStateError(
      "Host-adoption evidence is malformed or not bound to the unknown official effect."
    );
  }
  assertCanonicalTimestamp(adoption.cleanupPendingAt, "hostAdoption.cleanupPendingAt");
  assertCanonicalTimestamp(adoption.observedAt, "hostAdoption.observedAt");
  if (Date.parse(adoption.cleanupPendingAt)
      < Date.parse(cleanupProof.observedAt)
    || Date.parse(adoption.observedAt)
      < Date.parse(adoption.cleanupPendingAt)) {
    writeProvisioningStateError(
      "Host-adoption evidence predates controller cleanup or ambiguity retention."
    );
  }
  assertWorktreeHostVerification(adoption.hostVerification, binding);
  if (Date.parse(adoption.hostVerification.verifiedAt)
      < Date.parse(adoption.cleanupPendingAt)
    || Date.parse(adoption.hostVerification.verifiedAt)
      > Date.parse(adoption.observedAt)) {
    writeProvisioningStateError(
      "Host-adoption verification is outside its retained observation window."
    );
  }
  return adoption;
}

export function writeCleanupProofWithoutDigest(proof) {
  const { proofDigest: _proofDigest, ...body } = proof;
  return body;
}

export function assertWriteProvisioningCleanupProof(proof, intent, {
  preactivation = (
    intent?.status === "no-child"
    && intent?.resolution === WRITE_PREACTIVATION_CLEANUP_RESOLUTION
  )
} = {}) {
  const preactivationShape = preactivation
    && intent.processIdentity === null
    && intent.activatedAt === null;
  if (!hasExactKeys(proof, WRITE_PROVISIONING_CLEANUP_KEYS)
    || proof.schemaVersion !== WRITE_PROVISIONING_SCHEMA_VERSION
    || proof.providerSpawnIntentId !== intent.providerSpawnIntentId
    || proof.processGroupGone !== true
    || proof.providerGuardAbsent !== true
    || !(preactivationShape
      ? (() => {
          try {
            assertWriteProvisioningProcessIdentity(proof.processIdentity);
            return true;
          } catch {
            return false;
          }
        })()
      : sameWriteProvisioningProcessIdentity(
          proof.processIdentity,
          intent.processIdentity
        ))
    || proof.proofDigest !== stableDigest(writeCleanupProofWithoutDigest(proof))) {
    writeProvisioningStateError(
      "Write provisioning cleanup proof is malformed or not process-bound.",
      "E_PROCESS_IDENTITY"
    );
  }
  assertTimestampNotBefore(
    proof.observedAt,
    preactivationShape ? intent.preparedAt : intent.activatedAt,
    "cleanupProof.observedAt"
  );
  return proof;
}

export function worktreeAbsenceProofWithoutDigest(proof) {
  const { proofDigest: _proofDigest, ...body } = proof;
  return body;
}

export function assertWorktreeAbsenceProof(proof, binding) {
  const workerParentStateValid = (
    proof?.workerParentState === "private-empty"
      && SHA256_HEX.test(proof?.workerParentIdentityDigest || "")
  ) || (
    proof?.workerParentState === "absent"
      && proof?.workerParentIdentityDigest === null
  );
  if (!hasExactKeys(proof, WORKTREE_ABSENCE_PROOF_KEYS)
    || proof.schemaVersion !== WRITE_PROVISIONING_SCHEMA_VERSION
    || proof.classification !== "absent"
    || proof.workerId !== binding.workerId
    || proof.controlWorkspaceId !== binding.controlWorkspaceId
    || proof.controlRootDigest !== binding.controlRootDigest
    || proof.gitCommonDirDigest !== binding.gitCommonDirDigest
    || proof.expectedExecutionRootDigest !== binding.expectedExecutionRootDigest
    || proof.expectedWorkerParentDigest
      !== digestKey(path.dirname(binding.expectedExecutionRoot))
    || proof.baseCommitDigest !== digestKey(binding.baseCommit)
    || proof.filesystemPathState !== "absent"
    || !workerParentStateValid
    || !SHA256_HEX.test(proof.managedRootIdentityDigest || "")
    || !SHA256_HEX.test(proof.rawInventoryDigest || "")
    || !SHA256_HEX.test(proof.adminInventoryDigest || "")
    || proof.exactRegistrationCount !== 0
    || proof.managedParentRegistrationCount !== 0
    || proof.adminBacklinkMatchCount !== 0
    || proof.proofDigest
      !== stableDigest(worktreeAbsenceProofWithoutDigest(proof))) {
    writeProvisioningStateError(
      "Worktree absence proof is malformed or not binding-bound.",
      "E_WORKTREE"
    );
  }
  assertCanonicalTimestamp(proof.observedAt, "absenceProof.observedAt");
  return proof;
}

export function writeProvisioningAttemptArchiveWithoutDigest(archive) {
  const { archiveDigest: _archiveDigest, ...body } = archive;
  return body;
}

export function assertWriteProvisioningAttemptArchive(
  archive,
  binding,
  expectedOrdinal,
  expectedPreviousArchiveDigest
) {
  if (!hasExactKeys(archive, WRITE_PROVISIONING_ATTEMPT_ARCHIVE_KEYS)
    || archive.schemaVersion !== WRITE_PROVISIONING_SCHEMA_VERSION
    || archive.ordinal !== expectedOrdinal
    || archive.previousArchiveDigest !== expectedPreviousArchiveDigest
    || archive.archiveDigest
      !== stableDigest(writeProvisioningAttemptArchiveWithoutDigest(archive))
    || archive.operationId !== archive.attemptEvidence?.intent?.operationId
    || !hasExactKeys(
      archive.attemptEvidence,
      WRITE_PROVISIONING_ATTEMPT_EVIDENCE_KEYS
    )) {
    writeProvisioningStateError("Provisioning attempt archive is malformed.");
  }
  const sourceJournal = assertProvisioningJournal(
    binding,
    archive.sourceCleanupPendingJournal
  );
  const evidence = archive.attemptEvidence;
  const intent = assertWriteProvisioningIntent(evidence.intent, binding);
  const cleanupProof = assertWriteProvisioningCleanupProof(
    evidence.cleanupProof,
    intent
  );
  const absenceProof = assertWorktreeAbsenceProof(
    archive.absenceProof,
    binding
  );
  if (sourceJournal.state !== "cleanup_pending"
    || (sourceJournal.priorAttemptArchiveDigest ?? null)
      !== expectedPreviousArchiveDigest
    || sourceJournal.attemptId !== intent.provisioningAttemptId
    || sourceJournal.fence !== intent.provisioningFence
    || sourceJournal.cleanupProvisioner?.holderId !== intent.holderId
    || sourceJournal.cleanupProvisioner?.pid !== intent.processIdentity?.pid
    || sourceJournal.cleanupProvisioner?.startToken
      !== intent.processIdentity?.startToken
    || sourceJournal.previousJournalDigest !== evidence.activatedJournalDigest
    || intent.status !== "registered"
    || intent.updatedAt !== sourceJournal.cleanupPendingAt
    || evidence.activationDigest !== writeProvisioningActivationDigest({
      intent,
      activatedJournalDigest: evidence.activatedJournalDigest
    })
    || evidence.officialReceipt !== null
    || evidence.hostAdoption !== null
    || evidence.executionContextManifest !== null
    || evidence.executionContextManifestRecordDigest !== null
    || cleanupProof.proofDigest !== evidence.cleanupProof.proofDigest
    || Date.parse(absenceProof.observedAt)
      < Date.parse(sourceJournal.cleanupPendingAt)) {
    writeProvisioningStateError(
      "Provisioning attempt archive does not preserve one exact unknown-effect attempt."
    );
  }
  assertTimestampNotBefore(
    archive.archivedAt,
    absenceProof.observedAt,
    "attemptArchive.archivedAt"
  );
  return archive;
}

export function assertWriteProvisioningAttemptHistory(history, binding, journal) {
  if (!Array.isArray(history)
    || history.length > MAX_WRITE_PROVISIONING_ATTEMPTS - 1) {
    writeProvisioningStateError("Provisioning attempt history is malformed or exhausted.");
  }
  let previousArchiveDigest = null;
  let operationId = null;
  let releaseIdentityDigest = null;
  let previousFence = 0;
  const attemptIds = new Set();
  const holderIds = new Set();
  const spawnIntentIds = new Set();
  for (let index = 0; index < history.length; index += 1) {
    const archive = assertWriteProvisioningAttemptArchive(
      history[index],
      binding,
      index + 1,
      previousArchiveDigest
    );
    const sourceJournal = archive.sourceCleanupPendingJournal;
    const archivedIntent = archive.attemptEvidence.intent;
    operationId ??= archivedIntent.operationId;
    releaseIdentityDigest ??=
      archivedIntent.executableIdentity.releaseIdentityDigest;
    if (archivedIntent.operationId !== operationId
      || archive.operationId !== operationId
      || archivedIntent.executableIdentity.releaseIdentityDigest
        !== releaseIdentityDigest
      || archivedIntent.provisioningFence !== previousFence + 1
      || sourceJournal.fence !== archivedIntent.provisioningFence
      || (index > 0
        && sourceJournal.reissuePlannedAt
          !== history[index - 1].archivedAt)
      || attemptIds.has(archivedIntent.provisioningAttemptId)
      || holderIds.has(archivedIntent.holderId)
      || spawnIntentIds.has(archivedIntent.providerSpawnIntentId)) {
      writeProvisioningStateError(
        "Provisioning attempt archive chain forks immutable identity or reuses a fence actor."
      );
    }
    attemptIds.add(archivedIntent.provisioningAttemptId);
    holderIds.add(archivedIntent.holderId);
    spawnIntentIds.add(archivedIntent.providerSpawnIntentId);
    previousFence = archivedIntent.provisioningFence;
    previousArchiveDigest = archive.archiveDigest;
  }
  if (previousArchiveDigest !== (journal.priorAttemptArchiveDigest ?? null)
    || (history.length === 0) !== (journal.reissuePlannedAt == null)
    || (history.length > 0
      && history.at(-1).archivedAt !== journal.reissuePlannedAt)) {
    writeProvisioningStateError(
      "Provisioning attempt history is not journal-bound."
    );
  }
  return history;
}
