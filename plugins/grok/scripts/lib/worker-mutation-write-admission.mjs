/** Issue #56 worker-mutation write-admission domain. */
import crypto from "node:crypto";
import path from "node:path";
import { CompanionError, asErrorPayload } from "./errors.mjs";
import {
  assertProviderLaunchBinding,
  providerLaunchBindingDigest as digestProviderLaunchBinding
} from "./provider-executable-pin.mjs";
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
import {
  CONTEXT_MANIFEST_VERSION,
  CONTEXT_METADATA_POLICIES
} from "./task-context-policy.mjs";
import { composeProviderPrompt } from "./task-provider-prompt.mjs";
import { appendLifecycleEvent } from "./task-lifecycle.mjs";
import {
  CONTEXT_BINDING_MODE,
  assertContextPacket,
  assertContextReceipt,
  buildContextPacket,
  buildContextReceipt,
  resolveJobProviderPrompt,
  verifyJobEffectivePrompt
} from "./worker-context.mjs";
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
  assertDispatchContract,
  normalizeProviderLaunchBindingInput,
  providerLaunchState
} from "./worker-mutation-dispatch-contract.mjs";
import {
  WRITE_SPAWN_IDEMPOTENCY_SCHEMA_VERSION,
  assertIdempotencyKey,
  assertSpawnIdempotencyJobBinding,
  captureSpawnResponse,
  idempotencyConflict,
  nextSpawnResponseSequence,
  normalizeSpawnIdempotencyRecord,
  readIdempotency,
  spawnIdempotencyStateError,
  writeIdempotency
} from "./worker-mutation-idempotency.mjs";
import {
  SHA256_HEX,
  SPAWN_OWNERSHIP_MODE,
  SPAWN_SUCCESS_DEFINITION,
  assertMutationOwnership,
  cancellationNonce,
  digestKey,
  hasExactKeys,
  ownershipHost,
  spawnRequestOwner,
  stableDigest
} from "./worker-mutation-primitives.mjs";
import {
  requestDigest
} from "./worker-mutation-request-contract.mjs";
import {
  assertDurableSpawnRequestBinding
} from "./worker-mutation-spawn-authority.mjs";
import {
  EXACT_NONCE_HEX,
  OFFICIAL_WORKTREE_RECEIPT_INPUT_KEYS,
  OPAQUE_HEX,
  WRITE_PROVISIONING_CLEANUP_INPUT_KEYS,
  WRITE_PROVISIONING_SCHEMA_VERSION,
  WRITE_READY_LAUNCH_OUTCOME,
  assertCanonicalTimestamp,
  assertTimestampNotBefore,
  assertWorktreeAbsenceProof,
  assertWorktreeHostVerification,
  assertWriteProvisioningCleanupProof,
  assertWriteProvisioningProcessIdentity,
  sameWriteProvisioningProcessIdentity,
  worktreeVerificationWithoutDigest,
  writeAdmissionOwnerDigest,
  writeAdmissionRequestDigest,
  writeCleanupProofWithoutDigest,
  writeProvisioningStateError
} from "./worker-mutation-write-contract.mjs";
import {
  assertWriteExecutionJob,
  assertWriteProvisioningRuntime
} from "./worker-mutation-write-runtime-contract.mjs";

export function prepareReadyWriteDispatchAuthorization({
  root,
  principal,
  workerId,
  writeLifecycleCapabilityDigest,
  validateWriteLifecycleCapability
}) {
  if (!root || !principal?.threadId || !workerId) {
    throw new CompanionError(
      "E_USAGE",
      "Ready write dispatch requires root, trusted principal, and worker identity."
    );
  }
  if (!SHA256_HEX.test(writeLifecycleCapabilityDigest || "")) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Ready write dispatch requires its exact composite capability digest."
    );
  }
  assertBrokerMutationAuthority(principal, { root });
  return () => {
    if (typeof validateWriteLifecycleCapability !== "function") {
      return writeLifecycleCapabilityDigest;
    }
    try {
      const observed = validateWriteLifecycleCapability();
      return typeof observed === "string" ? observed : null;
    } catch {
      return null;
    }
  };
}

export function authorizeReadyWriteWorkerDispatch({ root, principal, workerId, writeLifecycleCapabilityDigest, validateWriteLifecycleCapability = null, env = process.env } = {}) {
  const currentCapability = prepareReadyWriteDispatchAuthorization({ root, principal, workerId, writeLifecycleCapabilityDigest, validateWriteLifecycleCapability });
  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) {
      throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    }
    assertMutationOwnership(current, principal);

    const replay = current.request?.spawn?.dispatch;
    if (isDispatchV2(replay)) {
      assertDispatchContract(current);
      assertDurableSpawnRequestBinding(current, env);
      if (current.write !== true
        || current.executionBinding?.bindingDigest
          !== current.request.spawn.executionBindingDigest
        || current.executionBinding?.providerCapabilityDigest
          !== writeLifecycleCapabilityDigest
        || current.request.spawn.providerCapabilityDigest
          !== writeLifecycleCapabilityDigest
        || currentCapability() !== writeLifecycleCapabilityDigest) {
        throw new CompanionError(
          "E_CAPABILITY",
          "Replayed write dispatch no longer matches its exact capability or execution binding."
        );
      }
      return Object.freeze({
        authorized: false,
        replayed: true,
        job: current
      });
    }

    const verified = assertWriteExecutionJob(current, env);
    if (verified.journal.state !== "ready"
      || current.status !== "queued"
      || currentCapability() !== writeLifecycleCapabilityDigest
      || current.request.spawn.writeLifecycleCapabilityDigest
        !== writeLifecycleCapabilityDigest
      || verified.binding.providerCapabilityDigest
        !== writeLifecycleCapabilityDigest) {
      throw new CompanionError(
        "E_CAPABILITY",
        "Write dispatch requires one currently capable verified-ready worktree."
      );
    }
    assertExactWriteVerticalScope(verified.envelope.scope);
    assertTrackedWriteVerticalTarget(verified.binding.controlRoot);
    assertParentUnchanged(
      verified.binding.parentFingerprint,
      verified.binding.controlRoot
    );
    if (transaction.isCancelRequested(
      workerId,
      verified.binding.cancellationNonce
    )) {
      throw new CompanionError(
        "E_CANCELLED",
        "Write worker was cancelled before dispatch authorization."
      );
    }
    assertManagedWorkerWorktree({
      controlRoot: verified.binding.controlRoot,
      executionRoot: verified.binding.expectedExecutionRoot,
      baseCommit: verified.binding.baseCommit,
      workerId,
      env
    });
    // Stored ready execution manifest is immutable authority; DEFAULT linked
    // policy tolerates unrelated shared-ref churn without rebinding IDs.
    const executionContextManifest = assertContextCompatible(
      verified.binding.expectedExecutionRoot,
      verified.provisioningRuntime.runtime.executionContextManifest,
      { mode: "execute" }
    );
    if (executionContextManifest.git?.head !== verified.binding.baseCommit
      || executionContextManifest.workspaceRoot
        !== verified.binding.expectedExecutionRoot
      || executionContextManifest.manifestId
        !== verified.journal.executionContextManifestId
      || executionContextManifest.digest
        !== verified.journal.executionContextManifestDigest
      || executionContextManifest.manifestId
        !== verified.provisioningRuntime.runtime.executionContextManifest.manifestId
      || executionContextManifest.digest
        !== verified.provisioningRuntime.runtime.executionContextManifest.digest) {
      throw new CompanionError(
        "E_CONTEXT_DRIFT",
        "Verified write execution context changed before dispatch authorization."
      );
    }
    const dispatchEnvelope = bindTaskEnvelopeContext(
      verified.envelope,
      executionContextManifest.manifestId
    );

    const contextPacket = buildContextPacket({
      mode: "explicit-envelope",
      envelope: dispatchEnvelope,
      facts: dispatchEnvelope.context.facts,
      constraints: dispatchEnvelope.context.constraints
    });
    assertContextPacket(contextPacket, { envelope: dispatchEnvelope });
    const runtimeRolePolicy = buildRuntimeRolePolicy({
      role: verified.role,
      profile: verified.profile
    });
    assertRuntimeRolePolicy(runtimeRolePolicy, {
      role: verified.role,
      profile: verified.profile
    });
    const providerPrompt = composeProviderPrompt(dispatchEnvelope, {
      root: verified.binding.expectedExecutionRoot,
      contextManifest: executionContextManifest,
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
      controlWorkspaceId: current.controlWorkspaceId,
      executionRoot: verified.binding.expectedExecutionRoot,
      envelope: dispatchEnvelope,
      contextManifest: executionContextManifest,
      roleId: verified.role.id,
      write: true,
      contextBinding: {
        mode: CONTEXT_BINDING_MODE,
        digest: contextBindingDigest
      },
      ...(verified.binding.providerLaunchBindingDigest
        ? {
            providerLaunchBindingDigest:
              verified.binding.providerLaunchBindingDigest
          }
        : {})
    });
    const authorizedAt = now();
    const contextReceipt = buildContextReceipt({
      contextPacket,
      rolePolicy: runtimeRolePolicy,
      contextManifest: executionContextManifest,
      lineageWorkerId: workerId,
      effectivePromptDigest: providerPromptDigest
    });

    const updated = transaction.updateJob(workerId, (latest) => {
      assertMutationOwnership(latest, principal);
      if (isDispatchV2(latest.request?.spawn?.dispatch)) {
        assertDispatchContract(latest);
        assertDurableSpawnRequestBinding(latest, env);
        return latest;
      }
      const latestVerified = assertWriteExecutionJob(latest, env);
      if (latestVerified.journal.journalDigest
          !== verified.journal.journalDigest
        || latestVerified.binding.bindingDigest
          !== verified.binding.bindingDigest
        || currentCapability() !== writeLifecycleCapabilityDigest
        || transaction.isCancelRequested(
          workerId,
          latestVerified.binding.cancellationNonce
        )) {
        throw new CompanionError(
          "E_STATE",
          "Write ready state, capability, or cancellation boundary changed before dispatch commit."
        );
      }
      assertParentUnchanged(
        latestVerified.binding.parentFingerprint,
        latestVerified.binding.controlRoot
      );
      assertManagedWorkerWorktree({
        controlRoot: latestVerified.binding.controlRoot,
        executionRoot: latestVerified.binding.expectedExecutionRoot,
        baseCommit: latestVerified.binding.baseCommit,
        workerId,
        env
      });
      assertContextCompatible(
        latestVerified.binding.expectedExecutionRoot,
        executionContextManifest,
        { mode: "execute" }
      );
      const next = {
        ...latest,
        phase: "accepted",
        summary: "Verified write worker dispatch committed",
        progress: "Durable launch authorization committed; provider not yet started.",
        heartbeatAt: authorizedAt,
        request: {
          ...latest.request,
          contextBindingMode: CONTEXT_BINDING_MODE,
          contextPacket,
          runtimeRolePolicy,
          contextReceipt,
          envelope: dispatchEnvelope,
          contextManifest: executionContextManifest,
          providerPromptDigest,
          spawn: {
            ...latest.request.spawn,
            executionRoot: latestVerified.binding.expectedExecutionRoot,
            executionBindingDigest: latestVerified.binding.bindingDigest,
            requestDigest: spawnDigest,
            contextBindingDigest,
            providerCapabilityDigest: writeLifecycleCapabilityDigest,
            providerLaunchPending: true,
            providerLaunchInFlight: false,
            providerLaunchOutcome: "pending",
            dispatch: createDispatchOutbox({ createdAt: authorizedAt })
          }
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "activity.completed",
          "Verified worktree atomically authorized for provider dispatch.",
          {
            mode: "write",
            write: true
          }
        ),
        workerAuthorization: null
      };
      next.workerAuthorization = createWorkerAuthorization({
        job: next,
        principal: {
          ...principal,
          hostKind: principal.hostKind || "codex"
        },
        issuedAt: authorizedAt
      });
      assertDispatchContract(next);
      assertDurableSpawnRequestBinding(next, env);
      return next;
    });
    assertDispatchContract(updated);
    assertDurableSpawnRequestBinding(updated, env);
    return Object.freeze({
      authorized: true,
      replayed: false,
      job: updated
    });
  }, env);
}

export function assertWriteProvisioningMutationInput({
  root,
  principal,
  workerId,
  executionBindingDigest,
  expectedJournalDigest,
  attemptId,
  fence,
  holderId,
  providerSpawnIntentId = undefined
}, {
  requireProviderSpawnIntentId = false
} = {}) {
  if (!root || !principal?.threadId || !workerId) {
    throw new CompanionError(
      principal?.threadId ? "E_USAGE" : "E_AUTH_REQUIRED",
      principal?.threadId
        ? "Write provisioning mutation requires a worker identity."
        : "Trusted Codex task identity is unavailable."
    );
  }
  if (!SHA256_HEX.test(executionBindingDigest || "")
    || !SHA256_HEX.test(expectedJournalDigest || "")
    || !EXACT_NONCE_HEX.test(attemptId || "")
    || !Number.isSafeInteger(fence)
    || fence < 1
    || !OPAQUE_HEX.test(holderId || "")
    || (requireProviderSpawnIntentId
      && !EXACT_NONCE_HEX.test(providerSpawnIntentId || ""))) {
    throw new CompanionError(
      "E_USAGE",
      "Write provisioning mutation requires exact binding, journal, attempt, fence, and holder identities."
    );
  }
}

export function assertWriteProvisioningMutationBoundary(verified, {
  executionBindingDigest,
  attemptId,
  fence,
  holderId,
  providerSpawnIntentId = undefined
}, {
  requireIntent = false
} = {}) {
  const { binding, provisioningRuntime } = verified;
  if (binding.bindingDigest !== executionBindingDigest) {
    writeProvisioningStateError("Write provisioning execution binding changed before mutation.");
  }
  if (provisioningRuntime) {
    const intent = provisioningRuntime.intent;
    if (intent.provisioningAttemptId !== attemptId
      || intent.provisioningFence !== fence
      || intent.holderId !== holderId
      || (providerSpawnIntentId !== undefined
        && intent.providerSpawnIntentId !== providerSpawnIntentId)) {
      writeProvisioningStateError(
        "Write provisioning actor does not own the durable fenced intent.",
        "E_PROCESS_IDENTITY"
      );
    }
  } else if (requireIntent) {
    writeProvisioningStateError("Write provisioning intent is missing.");
  }
}

export function assertProvisioningGuardAbsent(root, workerId) {
  let guard;
  try {
    guard = loadProviderGuard(root, workerId);
  } catch {
    writeProvisioningStateError(
      "Worktree provisioner guard aliases are malformed or conflicting.",
      "E_PROCESS_IDENTITY"
    );
  }
  if (guard !== null) {
    writeProvisioningStateError(
      "Worktree provisioner guard remains present or ambiguous.",
      "E_PROCESS_IDENTITY"
    );
  }
}

export function managedWorktreeVerification(binding, env, verifiedAt = now()) {
  assertCanonicalTimestamp(verifiedAt, "hostVerification.verifiedAt");
  assertParentUnchanged(binding.parentFingerprint, binding.controlRoot);
  const registered = assertManagedWorkerWorktree({
    controlRoot: binding.controlRoot,
    executionRoot: binding.expectedExecutionRoot,
    baseCommit: binding.baseCommit,
    workerId: binding.workerId,
    env
  });
  const fingerprint = captureParentFingerprint(binding.expectedExecutionRoot);
  if (!fingerprint.clean
    || fingerprint.head !== binding.baseCommit
    || fingerprint.tree !== binding.baseTree) {
    writeProvisioningStateError(
      "Managed worktree is not clean at the exact bound base.",
      "E_WORKTREE"
    );
  }
  const verification = {
    schemaVersion: WRITE_PROVISIONING_SCHEMA_VERSION,
    controlWorkspaceId: binding.controlWorkspaceId,
    controlRootDigest: binding.controlRootDigest,
    gitCommonDirDigest: binding.gitCommonDirDigest,
    expectedExecutionRootDigest: binding.expectedExecutionRootDigest,
    baseCommit: binding.baseCommit,
    baseTree: binding.baseTree,
    parentFingerprintDigest: binding.parentFingerprintDigest,
    registeredWorktreeDigest: stableDigest(registered),
    worktreeFingerprintDigest: fingerprint.fingerprintDigest,
    worktreeIndexDigest: fingerprint.indexDigest,
    worktreeIndexSecurityDigest: fingerprint.indexSecurityDigest,
    worktreeDigest: fingerprint.worktreeDigest,
    worktreeEntryCount: fingerprint.worktreeEntryCount,
    verifiedAt,
    verificationDigest: null
  };
  verification.verificationDigest = stableDigest(
    worktreeVerificationWithoutDigest(verification)
  );
  assertWorktreeHostVerification(verification, binding);
  return Object.freeze(verification);
}

export function sameWorktreeVerificationIdentity(left, right) {
  const identity = (value) => ({
    schemaVersion: value.schemaVersion,
    controlWorkspaceId: value.controlWorkspaceId,
    controlRootDigest: value.controlRootDigest,
    gitCommonDirDigest: value.gitCommonDirDigest,
    expectedExecutionRootDigest: value.expectedExecutionRootDigest,
    baseCommit: value.baseCommit,
    baseTree: value.baseTree,
    parentFingerprintDigest: value.parentFingerprintDigest,
    registeredWorktreeDigest: value.registeredWorktreeDigest,
    worktreeFingerprintDigest: value.worktreeFingerprintDigest,
    worktreeIndexDigest: value.worktreeIndexDigest,
    worktreeIndexSecurityDigest: value.worktreeIndexSecurityDigest,
    worktreeDigest: value.worktreeDigest,
    worktreeEntryCount: value.worktreeEntryCount
  });
  return stableDigest(identity(left)) === stableDigest(identity(right));
}

export function assertOfficialWorktreeReceiptInput(officialReceipt, binding, intent) {
  const mismatchedFields = [
    ...(!hasExactKeys(officialReceipt, OFFICIAL_WORKTREE_RECEIPT_INPUT_KEYS)
      ? ["shape"]
      : []),
    ...(!["created", "exists"].includes(officialReceipt?.status)
      ? ["status"]
      : []),
    ...(officialReceipt?.sessionId !== intent.operationId
      ? ["sessionId"]
      : []),
    ...(officialReceipt?.worktreePath !== binding.expectedExecutionRoot
      ? ["worktreePath"]
      : []),
    ...(officialReceipt?.sourceGitRoot !== binding.controlRoot
      ? ["sourceGitRoot"]
      : []),
    ...(officialReceipt?.commit !== binding.baseCommit
      ? ["commit"]
      : [])
  ];
  if (mismatchedFields.length) {
    throw new CompanionError(
      "E_WORKTREE",
      "Official worktree response does not match the durable operation and execution binding.",
      { mismatchedFields }
    );
  }
  return officialReceipt;
}

export function buildWriteProvisioningCleanupProof(cleanupProof, intent, {
  processIdentity = intent.processIdentity,
  preactivation = false
} = {}) {
  if (preactivation && (
    intent.processIdentity !== null
    || intent.activatedAt !== null
    || !sameWriteProvisioningProcessIdentity(
      cleanupProof?.processIdentity,
      processIdentity
    )
  )) {
    writeProvisioningStateError(
      "Preactivation cleanup proof is not bound to one transient process.",
      "E_PROCESS_IDENTITY"
    );
  }
  if (!hasExactKeys(cleanupProof, WRITE_PROVISIONING_CLEANUP_INPUT_KEYS)
    || cleanupProof.processGroupGone !== true
    || cleanupProof.providerGuardAbsent !== true
    || !sameWriteProvisioningProcessIdentity(
      cleanupProof.processIdentity,
      processIdentity
    )) {
    writeProvisioningStateError(
      "Write provisioner cleanup input is incomplete or not process-bound.",
      "E_PROCESS_IDENTITY"
    );
  }
  assertTimestampNotBefore(
    cleanupProof.observedAt,
    preactivation ? intent.preparedAt : intent.activatedAt,
    "cleanupProof.observedAt"
  );
  const durable = {
    schemaVersion: WRITE_PROVISIONING_SCHEMA_VERSION,
    providerSpawnIntentId: intent.providerSpawnIntentId,
    processIdentity: { ...processIdentity },
    processGroupGone: true,
    providerGuardAbsent: true,
    observedAt: cleanupProof.observedAt,
    proofDigest: null
  };
  durable.proofDigest = stableDigest(writeCleanupProofWithoutDigest(durable));
  assertWriteProvisioningCleanupProof(durable, intent, { preactivation });
  return Object.freeze(durable);
}

export function assertActualWriteProvisionerCleanup(
  binding,
  intent,
  processIdentity = intent.processIdentity
) {
  assertWriteProvisioningProcessIdentity(processIdentity);
  if (!processGroupGone(processIdentity)) {
    writeProvisioningStateError(
      "Worktree provisioner process group is still active.",
      "E_PROCESS_IDENTITY"
    );
  }
  assertProvisioningGuardAbsent(binding.controlRoot, binding.workerId);
}

export function sameWorktreeAbsenceIdentity(left, right) {
  const identity = (proof) => {
    const {
      observedAt: _observedAt,
      proofDigest: _proofDigest,
      ...body
    } = proof;
    return body;
  };
  return stableDigest(identity(left)) === stableDigest(identity(right));
}

export function exactAbsentWorktreeEffect(binding, env) {
  assertParentUnchanged(binding.parentFingerprint, binding.controlRoot);
  const effect = classifyWorkerWorktreeEffect({
    controlRoot: binding.controlRoot,
    executionRoot: binding.expectedExecutionRoot,
    baseCommit: binding.baseCommit,
    workerId: binding.workerId,
    env
  });
  if (effect.classification !== "absent" || !effect.evidence) {
    throw new CompanionError(
      "E_WORKTREE",
      "Unknown worktree effect is not independently absent and cannot be reissued.",
      { classification: effect.classification }
    );
  }
  return assertWorktreeAbsenceProof(effect.evidence, binding);
}

export function assertWriteAdmissionReplayMatches(binding, expected) {
  try {
    return assertExecutionBinding(binding, expected);
  } catch (error) {
    if (error instanceof CompanionError && error.code === "E_STATE") {
      idempotencyConflict("idempotencyKey was reused with a different write-spawn request.");
    }
    throw error;
  }
}

export function assertWriteAdmissionReplayCandidate(job, expected, env = process.env) {
  const expectedBinding = {
    controlRoot: expected.controlRoot,
    gitCommonDir: expected.gitCommonDir,
    scope: expected.scope,
    envelopeDigest: expected.envelopeDigest,
    roleDigest: expected.roleDigest,
    profileDigest: expected.profileDigest,
    runtimeRolePolicyDigest: expected.runtimeRolePolicyDigest,
    admissionContextManifestId: expected.admissionContextManifestId,
    admissionContextManifestDigest: expected.admissionContextManifestDigest,
    providerCapabilityDigest: expected.providerCapabilityDigest,
    providerLaunchBindingDigest: expected.providerLaunchBindingDigest,
    ownerDigest: expected.ownerDigest
  };

  if (isDispatchV2(job?.request?.spawn?.dispatch)) {
    if (job?.write !== true
      || !SHA256_HEX.test(job?.request?.spawn?.admissionRequestDigest || "")
      || !SHA256_HEX.test(job?.request?.spawn?.idempotencyKeyDigest || "")
      || !SHA256_HEX.test(job?.request?.spawn?.writeLifecycleCapabilityDigest || "")
      || job?.request?.spawn?.ownerThreadId !== job?.host?.sessionId) {
      throw new CompanionError("E_STATE", "Write worker execution binding is malformed.");
    }
    // Immutable authority is checked first; the live boundary below remains
    // exact before provider-started and becomes scope-aware only for the exact
    // active/terminal provider generation.
    assertDispatchContract(job);
    const spawn = job.request.spawn;
    const binding = assertWriteAdmissionReplayMatches(job.executionBinding, {
      workerId: job.id,
      controlWorkspaceId: job.controlWorkspaceId,
      ...expectedBinding
    });
    const journal = assertProvisioningJournal(binding, job.provisioning);
    if (journal.state !== "ready" || !job.provisioningRuntime) {
      throw new CompanionError(
        "E_STATE",
        "Dispatched write worker lacks its exact verified-ready provisioning chain."
      );
    }
    const provisioningRuntime = assertWriteProvisioningRuntime(
      job.provisioningRuntime,
      binding,
      journal
    );
    const requestContextManifest = assertContextManifestIntegrity(
      job.request?.contextManifest
    );
    const runtimeContextManifest = assertContextManifestIntegrity(
      provisioningRuntime.runtime.executionContextManifest
    );
    if (spawn.executionBindingDigest !== binding.bindingDigest
      || spawn.executionRoot !== binding.expectedExecutionRoot
      || spawn.writeLifecycleCapabilityDigest !== binding.providerCapabilityDigest
      || spawn.providerCapabilityDigest !== binding.providerCapabilityDigest
      || (binding.providerLaunchBindingDigest !== null
        && (spawn.providerLaunchBindingDigest
            !== binding.providerLaunchBindingDigest
          || digestProviderLaunchBinding(spawn.providerLaunchBinding)
            !== binding.providerLaunchBindingDigest))
      || binding.controlWorkspaceId !== job.controlWorkspaceId
      || binding.workerId !== job.id
      || runtimeContextManifest.manifestId
        !== requestContextManifest.manifestId
      || runtimeContextManifest.digest
        !== requestContextManifest.digest
      || stableDigest(runtimeContextManifest)
        !== stableDigest(requestContextManifest)
      || runtimeContextManifest.manifestId
        !== journal.executionContextManifestId
      || runtimeContextManifest.digest
        !== journal.executionContextManifestDigest) {
      throw new CompanionError(
        "E_STATE",
        "Dispatched write worker identity or provisioning chain disagrees with its immutable execution binding."
      );
    }
    const expectedAdmissionDigest = writeAdmissionRequestDigest({
      binding,
      idempotencyKeyDigest: spawn.idempotencyKeyDigest
    });
    if (spawn.admissionRequestDigest !== expectedAdmissionDigest) {
      throw new CompanionError("E_STATE", "Write worker admission digest is inconsistent.");
    }
    assertDurableSpawnRequestBinding(job, env);
    return Object.freeze({
      binding,
      dispatched: true,
      journal,
      provisioningRuntime
    });
  }

  const verified = assertWriteExecutionJob(job, env);
  assertWriteAdmissionReplayMatches(verified.binding, expectedBinding);
  return Object.freeze({
    binding: verified.binding,
    dispatched: false,
    journal: verified.journal
  });
}

export function prepareWriteWorkerAdmission({ root, principal, envelope, contextManifest, idempotencyKey, roleId, env, allowWriteSpawn, writeLifecycleCapabilityDigest, providerLaunchBinding, providerLaunchBindingDigest }) {
  assertIdempotencyKey(idempotencyKey);
  if (!allowWriteSpawn) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Internal broker write admission is disabled until official provisioning is enabled."
    );
  }
  if (!principal?.threadId) {
    throw new CompanionError("E_AUTH_REQUIRED", "Trusted Codex task identity is unavailable.");
  }
  const validatedEnvelope = assertTaskEnvelope(envelope);
  if (validatedEnvelope.mode !== "write") {
    throw new CompanionError("E_ROLE", "Write worker admission requires a write TaskEnvelope.");
  }
  const role = materializeRole(roleId);
  if (role.id !== "implementer" || role.write !== true) {
    throw new CompanionError(
      "E_ROLE",
      "Write worker admission requires the immutable implementer role."
    );
  }
  assertRoleDigest(role);
  if (!SHA256_HEX.test(writeLifecycleCapabilityDigest || "")) {
    throw new CompanionError(
      "E_CAPABILITY",
      "A distinct composite write-lifecycle capability binding is required for admission."
    );
  }
  const admittedProviderBinding = normalizeProviderLaunchBindingInput(
    providerLaunchBinding,
    providerLaunchBindingDigest
  );
  const profile = profileFor("task", true);
  const runtimeRolePolicy = buildRuntimeRolePolicy({ role, profile });
  assertRuntimeRolePolicy(runtimeRolePolicy, { role, profile });

  const control = resolveControlWorkspace(root, env);
  if (control.executionRoot !== control.controlRoot) {
    throw new CompanionError(
      "E_WORKTREE",
      "Write worker admission must originate from the canonical control checkout."
    );
  }
  // Fail closed on unsafe index flags/structures before ContextManifest
  // identity (which now observes those flags) can preempt with E_CONTEXT_DRIFT.
  captureParentFingerprint(control.controlRoot);
  // Caller-provided admission captures are integrity-checked once up front.
  // Fresh capture for new admissions stays deferred until the no-replay path so
  // same-key replay can rebind exclusively to the job's stored admission IDs.
  const callerAdmissionManifest = contextManifest == null
    ? null
    : assertContextManifestIntegrity(contextManifest);
  const requestOwner = spawnRequestOwner(principal);
  const ownerDigest = writeAdmissionOwnerDigest({
    kind: requestOwner.hostKind,
    sessionId: requestOwner.sessionId
  });
  const keyDigest = digestKey(idempotencyKey);
  const writeReplayExpected = (admissionContextManifest, admissionEnvelope) => Object.freeze({
    controlRoot: control.controlRoot,
    gitCommonDir: control.gitCommonDir,
    scope: admissionEnvelope.scope,
    envelopeDigest: admissionEnvelope.digest,
    roleDigest: role.digest,
    profileDigest: stableDigest(profile),
    runtimeRolePolicyDigest: runtimeRolePolicy.digest,
    admissionContextManifestId: admissionContextManifest.manifestId,
    admissionContextManifestDigest: admissionContextManifest.digest,
    providerCapabilityDigest: writeLifecycleCapabilityDigest,
    providerLaunchBindingDigest: admittedProviderBinding
      ? providerLaunchBindingDigest
      : null,
    ownerDigest
  });
  const rebindWriteAdmissionEnvelope = (storedAdmission) => {
    // Integrity + supervisory primary-control recheck against immutable stored
    // admission; never rebuild replayExpected from a fresh control capture.
    assertContextCompatible(
      control.controlRoot,
      storedAdmission,
      {
        mode: "execute",
        metadataPolicy: CONTEXT_METADATA_POLICIES.SUPERVISORY_LINKED_WRITE
      }
    );
    const admissionEnvelope = bindTaskEnvelopeContext(
      validatedEnvelope,
      storedAdmission.manifestId
    );
    return {
      storedAdmission,
      admissionEnvelope,
      replayExpected: writeReplayExpected(storedAdmission, admissionEnvelope)
    };
  };
  return {
    validatedEnvelope,
    role,
    admittedProviderBinding,
    profile,
    runtimeRolePolicy,
    control,
    callerAdmissionManifest,
    requestOwner,
    ownerDigest,
    keyDigest,
    rebindWriteAdmissionEnvelope
  };
}

export function replayWriteWorkerAdmission({ transaction, existing, digestOwners, keyDigest, requestOwner, control, rebindWriteAdmissionEnvelope, env, principal, idempotencyKey }) {
  const record = normalizeSpawnIdempotencyRecord(existing, { keyDigest });
  if (record.schemaVersion !== WRITE_SPAWN_IDEMPOTENCY_SCHEMA_VERSION
    || record.owner.hostKind !== requestOwner.hostKind
    || record.owner.sessionId !== requestOwner.sessionId
    || record.controlWorkspaceId !== control.controlWorkspaceId) {
    idempotencyConflict("idempotencyKey was reused with a different write-spawn owner.");
  }
  const committed = transaction.tryReadJob(record.workerId);
  if (!committed || digestOwners.length !== 1 || digestOwners[0].id !== record.workerId) {
    spawnIdempotencyStateError("Write-spawn idempotency ownership is missing or ambiguous.");
  }
  const storedAdmission = assertContextManifestIntegrity(
    committed.request?.admissionContextManifest
  );
  const { replayExpected } = rebindWriteAdmissionEnvelope(storedAdmission);
  assertWriteAdmissionReplayCandidate(committed, replayExpected, env);
  if (record.admissionRequestDigest !== committed.request.spawn.admissionRequestDigest) {
    spawnIdempotencyStateError("Write-spawn idempotency record disagrees with its durable job.");
  }
  assertSpawnIdempotencyJobBinding(record, committed, { keyDigest });
  assertMutationOwnership(committed, principal);
  const { responseSequence, recordedAt } = nextSpawnResponseSequence(record);
  const captured = captureSpawnResponse({
    job: committed,
    keyDigest,
    replayed: true,
    responseSequence,
    recordedAt
  });
  writeIdempotency(
    control.controlRoot,
    "spawn",
    idempotencyKey,
    captured.record,
    env
  );
  return Object.freeze({ committed, handle: captured.handle, replayed: true });
}

export function admitWriteWorkerPlan({ root, principal, envelope, contextManifest = null, idempotencyKey, roleId = "implementer", env = process.env, allowWriteSpawn = false, writeLifecycleCapabilityDigest = null, providerLaunchBinding = null, providerLaunchBindingDigest = null } = {}) {
  const prepared = prepareWriteWorkerAdmission({ root, principal, envelope, contextManifest, idempotencyKey, roleId, env, allowWriteSpawn, writeLifecycleCapabilityDigest, providerLaunchBinding, providerLaunchBindingDigest });
  const { validatedEnvelope, role, admittedProviderBinding, profile, runtimeRolePolicy, control, callerAdmissionManifest, requestOwner, ownerDigest, keyDigest, rebindWriteAdmissionEnvelope } = prepared;
  const admitted = withWorkspaceStateTransaction(control.controlRoot, (transaction) => {
    const digestOwners = transaction.listJobs().filter((candidate) => (
      candidate.request?.spawn?.idempotencyKeyDigest === keyDigest
    ));
    const existing = readIdempotency(
      control.controlRoot,
      "spawn",
      idempotencyKey,
      env
    );
    if (existing) {
      return replayWriteWorkerAdmission({ transaction, existing, digestOwners, keyDigest, requestOwner, control, rebindWriteAdmissionEnvelope, env, principal, idempotencyKey });
    }

    if (digestOwners.length > 1) {
      spawnIdempotencyStateError("Write-spawn idempotency ownership is ambiguous.");
    }
    const orphan = digestOwners[0] || null;
    if (orphan) {
      if (orphan.write !== true
        || orphan.host?.kind !== requestOwner.hostKind
        || orphan.host?.sessionId !== requestOwner.sessionId
        || orphan.controlWorkspaceId !== control.controlWorkspaceId) {
        idempotencyConflict("idempotencyKey was reused with a different write-spawn request.");
      }
      const storedAdmission = assertContextManifestIntegrity(
        orphan.request?.admissionContextManifest
      );
      const { replayExpected } = rebindWriteAdmissionEnvelope(storedAdmission);
      assertWriteAdmissionReplayCandidate(orphan, replayExpected, env);
      assertMutationOwnership(orphan, principal);
      const captured = captureSpawnResponse({
        job: orphan,
        keyDigest,
        replayed: true,
        responseSequence: 1
      });
      writeIdempotency(
        control.controlRoot,
        "spawn",
        idempotencyKey,
        captured.record,
        env
      );
      return Object.freeze({
        committed: orphan,
        handle: captured.handle,
        replayed: true
      });
    }

    // New managed write: integrity-check caller capture (or take one now) and
    // supervisory-compare current control; persist that original stored object.
    const admissionContextManifest = callerAdmissionManifest
      ? assertContextCompatible(
        control.controlRoot,
        callerAdmissionManifest,
        {
          mode: "execute",
          metadataPolicy: CONTEXT_METADATA_POLICIES.SUPERVISORY_LINKED_WRITE
        }
      )
      : captureContextManifest(control.controlRoot);
    if (validatedEnvelope.contextManifestId != null
      && validatedEnvelope.contextManifestId !== admissionContextManifest.manifestId) {
      throw new CompanionError(
        "E_CONTEXT_DRIFT",
        "TaskEnvelope context identity does not match the trusted control checkout."
      );
    }
    const admissionEnvelope = bindTaskEnvelopeContext(
      validatedEnvelope,
      admissionContextManifest.manifestId
    );
    const parentFingerprint = captureParentFingerprint(control.controlRoot);
    if (!parentFingerprint.clean) {
      throw new CompanionError(
        "E_WORKTREE",
        "Write worker admission requires a completely clean control checkout."
      );
    }
    assertContextCompatible(
      control.controlRoot,
      admissionContextManifest,
      {
        mode: "execute",
        metadataPolicy: CONTEXT_METADATA_POLICIES.SUPERVISORY_LINKED_WRITE
      }
    );
    const id = generateId("task");
    const createdAt = now();
    const cancellationNonce = crypto.randomBytes(16).toString("hex");
    const expectedExecutionRoot = expectedWorkerWorktreeRoot(
      control.controlRoot,
      id,
      env
    );
    const binding = createExecutionBinding({
      workerId: id,
      controlWorkspaceId: control.controlWorkspaceId,
      controlRoot: control.controlRoot,
      gitCommonDir: control.gitCommonDir,
      baseCommit: parentFingerprint.head,
      baseTree: parentFingerprint.tree,
      parentFingerprint,
      expectedExecutionRoot,
      scope: admissionEnvelope.scope,
      envelopeDigest: admissionEnvelope.digest,
      roleDigest: role.digest,
      profileDigest: stableDigest(profile),
      runtimeRolePolicyDigest: runtimeRolePolicy.digest,
      admissionContextManifestId: admissionContextManifest.manifestId,
      admissionContextManifestDigest: admissionContextManifest.digest,
      providerCapabilityDigest: writeLifecycleCapabilityDigest,
      providerLaunchBindingDigest: admittedProviderBinding
        ? providerLaunchBindingDigest
        : null,
      ownerDigest,
      cancellationNonce,
      createdAt
    });
    const admissionRequestDigest = writeAdmissionRequestDigest({
      binding,
      idempotencyKeyDigest: keyDigest
    });
    const provisioning = createProvisioningJournal({
      binding,
      cancellationNonce,
      createdAt
    });
    assertParentUnchanged(parentFingerprint, control.controlRoot);
    const job = {
      schemaVersion: 3,
      id,
      kind: "task",
      jobClass: "task",
      write: true,
      status: "queued",
      phase: "provisioning-planned",
      summary: "Write worker provisioning planned",
      progress: "Durable execution binding committed; no provider dispatch authority exists.",
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
      controlWorkspaceId: control.controlWorkspaceId,
      executionBinding: binding,
      provisioning,
      request: {
        admissionContextManifest,
        envelope: admissionEnvelope,
        providerHomeId: id,
        publicObjective: admissionEnvelope.objective !== admissionEnvelope.userRequest
          ? admissionEnvelope.objective
          : null,
        roleId: role.id,
        spawn: {
          idempotencyKeyDigest: keyDigest,
          ownerThreadId: principal.threadId,
          admissionRequestDigest,
          successDefinition: SPAWN_SUCCESS_DEFINITION,
          ownershipMode: SPAWN_OWNERSHIP_MODE,
          writeLifecycleCapabilityDigest,
          ...(admittedProviderBinding
            ? {
                providerLaunchBinding: admittedProviderBinding,
                providerLaunchBindingDigest
              }
            : {}),
          providerLaunchPending: false,
          providerLaunchInFlight: false,
          providerLaunchOutcome: "not-ready"
        }
      },
      lifecycleEvents: appendLifecycleEvent(
        [],
        "task.accepted",
        "Durable write execution binding committed without launch authority.",
        {
          state: "provisioning-planned",
          write: true
        }
      ),
      result: null,
      error: null
    };
    const committed = transaction.admitJob(job);
    assertWriteExecutionJob(committed, env);
    const captured = captureSpawnResponse({
      job: committed,
      keyDigest,
      replayed: false,
      responseSequence: 1
    });
    writeIdempotency(
      control.controlRoot,
      "spawn",
      idempotencyKey,
      captured.record,
      env
    );
    return Object.freeze({
      committed,
      handle: captured.handle,
      replayed: false
    });
  }, env);

  return Object.freeze({
    handle: admitted.handle,
    replayed: admitted.replayed,
    spawnSuccessDefinition: SPAWN_SUCCESS_DEFINITION,
    providerLaunchState: admitted.committed.provisioning.state === "ready"
      ? WRITE_READY_LAUNCH_OUTCOME
      : admitted.committed.provisioning.state === "failed"
        ? "not-launched"
        : "not-ready",
    providerLaunched: false
  });
}
