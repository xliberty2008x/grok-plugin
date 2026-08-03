/** Issue #56 worker-mutation write-runtime-contract domain. */
import path from "node:path";
import { CompanionError, asErrorPayload } from "./errors.mjs";
import {
  assertProviderLaunchBinding,
  providerLaunchBindingDigest as digestProviderLaunchBinding
} from "./provider-executable-pin.mjs";
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
import {
  assertRuntimeRolePolicy,
  buildRuntimeRolePolicy,
  materializeRole,
  assertRoleDigest
} from "./worker-roles.mjs";
import { profileFor, sameSecurityProfile } from "./profiles.mjs";
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
  SHA256_HEX,
  SPAWN_OWNERSHIP_MODE,
  SPAWN_SUCCESS_DEFINITION,
  hasExactKeys,
  stableDigest
} from "./worker-mutation-primitives.mjs";
import {
  BOUND_PRE_READY_WRITE_SPAWN_KEYS,
  LEGACY_WRITE_PROVISIONING_RUNTIME_KEY_SETS,
  PRE_READY_WRITE_REQUEST_KEYS,
  PRE_READY_WRITE_SPAWN_KEYS,
  WRITE_EXECUTION_JOB_KEYS,
  WRITE_PREACTIVATION_CLEANUP_RESOLUTION,
  WRITE_PROVISIONING_RUNTIME_KEYS,
  WRITE_PROVISIONING_SCHEMA_VERSION,
  WRITE_READY_LAUNCH_OUTCOME,
  assertCanonicalTimestamp,
  assertOfficialWorktreeReceipt,
  assertWorktreeHostAdoption,
  assertWriteProvisioningAttemptHistory,
  assertWriteProvisioningCleanupProof,
  assertWriteProvisioningIntent,
  canonicalTimestamp,
  writeAdmissionOwnerDigest,
  writeAdmissionRequestDigest,
  writeProvisioningActivationDigest,
  writeProvisioningStateError
} from "./worker-mutation-write-contract.mjs";

export function assertFreshWriteProvisioningContinuation(
  intent,
  priorAttempts,
  journal
) {
  if (priorAttempts.length === 0) return;
  const archivedIntents = priorAttempts.map(
    (archive) => archive.attemptEvidence.intent
  );
  const latestArchivedIntent = archivedIntents.at(-1);
  if (intent.operationId !== latestArchivedIntent.operationId
    || intent.executableIdentity.releaseIdentityDigest
      !== latestArchivedIntent.executableIdentity.releaseIdentityDigest
    || intent.provisioningFence !== latestArchivedIntent.provisioningFence + 1
    || intent.preparedAt !== journal.reissuePlannedAt
    || archivedIntents.some((archivedIntent) => (
      intent.provisioningAttemptId === archivedIntent.provisioningAttemptId
      || intent.holderId === archivedIntent.holderId
      || intent.providerSpawnIntentId === archivedIntent.providerSpawnIntentId
    ))) {
    writeProvisioningStateError(
      "Current provisioning intent is not the fresh continuation of its archived attempts."
    );
  }
}

export function assertWriteProvisioningRuntime(runtime, binding, journal) {
  const legacyWithoutHostAdoption = (
    !Object.hasOwn(runtime || {}, "hostAdoption")
    && LEGACY_WRITE_PROVISIONING_RUNTIME_KEY_SETS.some(
      (keys) => hasExactKeys(runtime, keys)
    )
  );
  const legacyWithoutPriorAttempts = (
    !Object.hasOwn(runtime || {}, "priorAttempts")
    && LEGACY_WRITE_PROVISIONING_RUNTIME_KEY_SETS.some(
      (keys) => hasExactKeys(runtime, keys)
    )
  );
  if ((!hasExactKeys(runtime, WRITE_PROVISIONING_RUNTIME_KEYS)
      && !LEGACY_WRITE_PROVISIONING_RUNTIME_KEY_SETS.some(
        (keys) => hasExactKeys(runtime, keys)
      ))
    || runtime.schemaVersion !== WRITE_PROVISIONING_SCHEMA_VERSION) {
    writeProvisioningStateError("Write provisioning runtime has an unsupported shape.");
  }
  const intent = assertWriteProvisioningIntent(runtime.intent, binding);
  const priorAttempts = assertWriteProvisioningAttemptHistory(
    legacyWithoutPriorAttempts ? [] : runtime.priorAttempts,
    binding,
    journal
  );
  assertFreshWriteProvisioningContinuation(intent, priorAttempts, journal);
  const active = intent.processIdentity !== null;
  if (active) {
    if (!SHA256_HEX.test(runtime.activatedJournalDigest || "")
      || !SHA256_HEX.test(runtime.activationDigest || "")
      || runtime.activationDigest !== writeProvisioningActivationDigest(runtime)) {
      writeProvisioningStateError("Write provisioning activation evidence is malformed.");
    }
  } else if (runtime.activatedJournalDigest !== null || runtime.activationDigest !== null) {
    writeProvisioningStateError("Write provisioning runtime exposes activation evidence without a process.");
  }

  const cleanupProof = runtime.cleanupProof === null
    ? null
    : assertWriteProvisioningCleanupProof(runtime.cleanupProof, intent);
  const receipt = runtime.officialReceipt === null
    ? null
    : assertOfficialWorktreeReceipt(runtime.officialReceipt, binding, intent);
  const hostAdoption = legacyWithoutHostAdoption || runtime.hostAdoption === null
    ? null
    : assertWorktreeHostAdoption(
        runtime.hostAdoption,
        binding,
        intent,
        cleanupProof,
        journal.state === "ready" ? journal.previousJournalDigest : null
      );
  if (runtime.executionContextManifest === null) {
    if (runtime.executionContextManifestRecordDigest !== null) {
      writeProvisioningStateError("Execution ContextManifest digest exists without its record.");
    }
  } else {
    try {
      assertContextManifestIntegrity(runtime.executionContextManifest);
    } catch {
      writeProvisioningStateError(
        "Execution ContextManifest private record failed integrity validation.",
        "E_CONTEXT_DRIFT"
      );
    }
    if (!SHA256_HEX.test(runtime.executionContextManifestRecordDigest || "")
      || runtime.executionContextManifestRecordDigest
        !== stableDigest(runtime.executionContextManifest)) {
      writeProvisioningStateError("Execution ContextManifest private record digest is inconsistent.");
    }
  }

  if (journal.state === "planned") {
    if (intent.status !== "pending"
      || active
      || intent.expectedPlannedJournalDigest !== journal.journalDigest
      || receipt !== null
      || hostAdoption !== null
      || runtime.executionContextManifest !== null
      || cleanupProof !== null) {
      writeProvisioningStateError("Planned write provisioning runtime contains premature authority.");
    }
  } else if (journal.state === "reissue_planned") {
    const priorIntent = priorAttempts.at(-1)?.attemptEvidence?.intent || null;
    if (intent.status !== "pending"
      || active
      || priorAttempts.length < 1
      || intent.expectedPlannedJournalDigest !== journal.journalDigest
      || intent.provisioningAttemptId !== journal.attemptId
      || intent.provisioningFence !== journal.fence
      || intent.operationId !== priorIntent?.operationId
      || intent.providerSpawnIntentId === priorIntent?.providerSpawnIntentId
      || intent.holderId === priorIntent?.holderId
      || intent.executableIdentity.releaseIdentityDigest
        !== priorIntent?.executableIdentity?.releaseIdentityDigest
      || intent.preparedAt !== journal.reissuePlannedAt
      || receipt !== null
      || hostAdoption !== null
      || runtime.executionContextManifest !== null
      || cleanupProof !== null) {
      writeProvisioningStateError(
        "Reissue-planned runtime is not bound to one fresh inactive attempt."
      );
    }
  } else if (journal.state === "provisioning") {
    if (!["pending", "registered"].includes(intent.status)
      || !active
      || intent.expectedPlannedJournalDigest !== journal.previousJournalDigest
      || intent.provisioningAttemptId !== journal.attemptId
      || intent.provisioningFence !== journal.fence
      || intent.holderId !== journal.provisioner?.holderId
      || intent.processIdentity.pid !== journal.provisioner?.pid
      || intent.processIdentity.startToken !== journal.provisioner?.startToken
      || runtime.activatedJournalDigest !== journal.journalDigest
      || hostAdoption !== null
      || runtime.executionContextManifest !== null
      || cleanupProof !== null) {
      writeProvisioningStateError("Active write provisioning runtime is not journal-bound.");
    }
  } else if (journal.state === "ready") {
    if (intent.status !== "settled"
      || !active
      || (receipt === null) === (hostAdoption === null)
      || !runtime.executionContextManifest
      || !cleanupProof
      || intent.provisioningAttemptId !== journal.attemptId
      || intent.provisioningFence !== journal.fence
      || intent.settledAt !== journal.readyAt
      || journal.executionContextManifestId !== runtime.executionContextManifest.manifestId
      || journal.executionContextManifestDigest !== runtime.executionContextManifest.digest) {
      writeProvisioningStateError("Ready write provisioning runtime is incomplete.");
    }
    if (runtime.executionContextManifest.schemaVersion
      !== CONTEXT_MANIFEST_VERSION) {
      writeProvisioningStateError(
        "Ready write provisioning requires chronology-authenticated ContextManifest evidence.",
        "E_CONTEXT_DRIFT"
      );
    }
    for (const [timestamp, label] of [
      ...(receipt
        ? [
            [receipt.receivedAt, "official receipt"],
            [receipt.hostVerification.verifiedAt, "official receipt host verification"]
          ]
        : [
            [hostAdoption.cleanupPendingAt, "host-adoption ambiguity retention"],
            [hostAdoption.hostVerification.verifiedAt, "host-adoption verification"],
            [hostAdoption.observedAt, "host-adoption observation"]
          ]),
      [cleanupProof.observedAt, "cleanup proof"],
      [runtime.executionContextManifest.capturedAt, "execution ContextManifest"]
    ]) {
      assertCanonicalTimestamp(timestamp, `${label} time`);
      if (Date.parse(intent.settledAt) < Date.parse(timestamp)) {
        writeProvisioningStateError(`Ready promotion predates its ${label}.`);
      }
    }
  } else if (journal.state === "cleanup_pending") {
    const cleanupProvisioner = journal.cleanupProvisioner;
    if (intent.status !== "registered"
      || !active
      || intent.provisioningAttemptId !== journal.attemptId
      || intent.provisioningFence !== journal.fence
      || intent.holderId !== cleanupProvisioner?.holderId
      || intent.processIdentity.pid !== cleanupProvisioner?.pid
      || intent.processIdentity.startToken !== cleanupProvisioner?.startToken
      || runtime.activatedJournalDigest !== journal.previousJournalDigest
      || intent.updatedAt !== journal.cleanupPendingAt
      || hostAdoption !== null
      || runtime.executionContextManifest !== null
      || !cleanupProof) {
      writeProvisioningStateError(
        "Cleanup-pending write provisioning runtime is not bound to its exact controller cleanup."
      );
    }
    for (const [timestamp, label] of [
      [intent.registeredAt, "registered intent"],
      [cleanupProof.observedAt, "cleanup proof"],
      ...(receipt
        ? [
            [receipt.receivedAt, "official receipt"],
            [receipt.hostVerification.verifiedAt, "host verification"]
          ]
        : [])
    ]) {
      assertCanonicalTimestamp(timestamp, `${label} time`);
      if (Date.parse(journal.cleanupPendingAt) < Date.parse(timestamp)) {
        writeProvisioningStateError(`Cleanup-pending retention predates its ${label}.`);
      }
    }
  } else if (journal.state === "failed") {
    const preactivationCleanup = (
      intent.resolution === WRITE_PREACTIVATION_CLEANUP_RESOLUTION
    );
    if (intent.status !== "no-child"
      || intent.noChildAt !== journal.failedAt
      || hostAdoption !== null
      || runtime.executionContextManifest !== null
      || (active
        ? cleanupProof === null
        : preactivationCleanup
          ? cleanupProof === null
          : cleanupProof !== null)
      || (preactivationCleanup && (
        active
        || intent.activatedAt !== null
        || runtime.activatedJournalDigest !== null
        || runtime.activationDigest !== null
      ))
      || (active
        ? (
            intent.provisioningAttemptId !== journal.attemptId
            || intent.provisioningFence !== journal.fence
          )
        : intent.expectedPlannedJournalDigest !== journal.previousJournalDigest)) {
      writeProvisioningStateError("Failed write provisioning runtime lacks exact no-child evidence.");
    }
    if (cleanupProof && Date.parse(intent.noChildAt) < Date.parse(cleanupProof.observedAt)) {
      writeProvisioningStateError("Provisioning failure predates its cleanup proof.");
    }
  } else {
    writeProvisioningStateError("Write provisioning journal state is unsupported by this source slice.");
  }
  return Object.freeze({
    runtime,
    intent,
    receipt,
    hostAdoption,
    cleanupProof,
    priorAttempts
  });
}

export function assertWriteExecutionJob(job, env = process.env) {
  if (job?.write !== true
    || !["queued", "failed"].includes(job?.status)
    || !SHA256_HEX.test(job?.request?.spawn?.admissionRequestDigest || "")
    || !SHA256_HEX.test(job?.request?.spawn?.idempotencyKeyDigest || "")
    || !SHA256_HEX.test(job?.request?.spawn?.writeLifecycleCapabilityDigest || "")
    || job?.request?.spawn?.ownerThreadId !== job?.host?.sessionId) {
    throw new CompanionError("E_STATE", "Write worker execution binding is malformed.");
  }

  const envelope = assertTaskEnvelope(job.request?.envelope);
  const role = assertRoleDigest(job.role);
  const profile = profileFor("task", true);
  if (envelope.mode !== "write"
    || role.id !== "implementer"
    || role.write !== true
    || job.request?.roleId !== role.id
    || !sameSecurityProfile(job.profile, profile)) {
    throw new CompanionError(
      "E_STATE",
      "Write worker role, envelope, or provider profile is not admission-bound."
    );
  }
  const runtimeRolePolicy = buildRuntimeRolePolicy({ role, profile });
  assertRuntimeRolePolicy(runtimeRolePolicy, { role, profile });
  const ownerDigest = writeAdmissionOwnerDigest(job.host);
  const binding = assertExecutionBinding(job.executionBinding, {
    workerId: job.id,
    controlWorkspaceId: job.controlWorkspaceId,
    scope: envelope.scope,
    envelopeDigest: envelope.digest,
    roleDigest: role.digest,
    profileDigest: stableDigest(profile),
    runtimeRolePolicyDigest: runtimeRolePolicy.digest,
    providerCapabilityDigest: job.request.spawn.writeLifecycleCapabilityDigest,
    ownerDigest
  });
  // taskRelevantMetadataIdentity (issue #34) observes assume-unchanged /
  // skip-worktree, so assertContextCompatible would surface E_CONTEXT_DRIFT.
  // Prefer the established parent-fingerprint safety gate first: its
  // captureParentFingerprint path fail-closes unsafe index structures/flags
  // with E_SCOPE_VIOLATION and a privacy-safe message. Ordinary parent
  // content/metadata drift remains E_INTEGRATION; remaining context mismatch
  // stays E_CONTEXT_DRIFT.
  assertParentUnchanged(binding.parentFingerprint, binding.controlRoot);
  // Managed write: integrity-check immutable stored admission, then compare the
  // live primary control root under SUPERVISORY_LINKED_WRITE so only complete
  // attributable unrelated shared-ref churn is tolerated. Retain stored IDs.
  const admissionContextManifest = assertContextCompatible(
    binding.controlRoot,
    job.request?.admissionContextManifest,
    {
      mode: "execute",
      metadataPolicy: CONTEXT_METADATA_POLICIES.SUPERVISORY_LINKED_WRITE
    }
  );
  assertExecutionBinding(binding, {
    admissionContextManifestId: admissionContextManifest.manifestId,
    admissionContextManifestDigest: admissionContextManifest.digest
  });
  const journal = assertProvisioningJournal(binding, job.provisioning);
  const expectedAdmissionDigest = writeAdmissionRequestDigest({
    binding,
    idempotencyKeyDigest: job.request.spawn.idempotencyKeyDigest
  });
  if (job.request.spawn.admissionRequestDigest !== expectedAdmissionDigest) {
    throw new CompanionError("E_STATE", "Write worker admission digest is inconsistent.");
  }

  const control = resolveControlWorkspace(binding.controlRoot, env);
  if (control.executionRoot !== control.controlRoot
    || control.controlWorkspaceId !== binding.controlWorkspaceId
    || control.controlRoot !== binding.controlRoot
    || control.gitCommonDir !== binding.gitCommonDir
    || expectedWorkerWorktreeRoot(binding.controlRoot, job.id, env)
      !== binding.expectedExecutionRoot) {
    throw new CompanionError(
      "E_STATE",
      "Write execution binding no longer matches its exact control workspace."
    );
  }
  const spawn = job.request.spawn;
  const requestKeys = Object.keys(job.request);
  const spawnKeys = Object.keys(spawn);
  const expectedSpawnKeys = binding.providerLaunchBindingDigest === null
    ? PRE_READY_WRITE_SPAWN_KEYS
    : BOUND_PRE_READY_WRITE_SPAWN_KEYS;
  const hasRuntime = Object.hasOwn(job, "provisioningRuntime");
  const expectedJobKeys = hasRuntime
    ? new Set([...WRITE_EXECUTION_JOB_KEYS, "provisioningRuntime"])
    : WRITE_EXECUTION_JOB_KEYS;
  const forbiddenJobFields = [
    "workerAuthorization",
    "controllerProcess",
    "workerProcess",
    "providerProcess",
    "grokSessionId"
  ];
  const expectedPublicObjective = envelope.objective !== envelope.userRequest
    ? envelope.objective
    : null;
  if (!hasExactKeys(job, expectedJobKeys)
    || requestKeys.length !== PRE_READY_WRITE_REQUEST_KEYS.size
    || requestKeys.some((field) => !PRE_READY_WRITE_REQUEST_KEYS.has(field))
    || spawnKeys.length !== expectedSpawnKeys.size
    || spawnKeys.some((field) => !expectedSpawnKeys.has(field))
    || job.request.providerHomeId !== job.id
    || job.request.publicObjective !== expectedPublicObjective
    || spawn.successDefinition !== SPAWN_SUCCESS_DEFINITION
    || spawn.ownershipMode !== SPAWN_OWNERSHIP_MODE
    || spawn.providerLaunchPending !== false
    || spawn.providerLaunchInFlight !== false
    || forbiddenJobFields.some((field) => Object.hasOwn(job, field))) {
    throw new CompanionError(
      "E_STATE",
      "Write worker contains launch or provider authority or an unsupported top-level field."
    );
  }
  if (binding.providerLaunchBindingDigest !== null
    && (spawn.providerLaunchBindingDigest !== binding.providerLaunchBindingDigest
      || digestProviderLaunchBinding(spawn.providerLaunchBinding)
        !== binding.providerLaunchBindingDigest)) {
    throw new CompanionError(
      "E_STATE",
      "Write worker provider executable binding disagrees with its execution binding."
    );
  }

  const runtimeEvidence = hasRuntime
    ? assertWriteProvisioningRuntime(job.provisioningRuntime, binding, journal)
    : null;
  const expectedLaunchOutcome = journal.state === "ready"
    ? WRITE_READY_LAUNCH_OUTCOME
    : journal.state === "failed"
      ? "not-launched"
      : "not-ready";
  if (spawn.providerLaunchOutcome !== expectedLaunchOutcome) {
    writeProvisioningStateError(
      "Write worker contains launch or provider authority inconsistent with its provisioning state."
    );
  }
  if (journal.state === "planned") {
    if (job.status !== "queued"
      || !["provisioning-planned", "provisioning-intent-prepared"].includes(job.phase)
      || spawn.providerLaunchOutcome !== "not-ready"
      || job.startedAt !== null
      || job.completedAt !== null
      || job.result !== null
      || job.error !== null
      || (job.phase === "provisioning-intent-prepared") !== Boolean(runtimeEvidence)) {
      writeProvisioningStateError("Planned write worker has an inconsistent exact state.");
    }
  } else if (journal.state === "reissue_planned") {
    if (job.status !== "queued"
      || job.phase !== "provisioning-reissue-planned"
      || spawn.providerLaunchOutcome !== "not-ready"
      || !runtimeEvidence
      || job.startedAt !== null
      || job.completedAt !== null
      || job.result !== null
      || job.error !== null) {
      writeProvisioningStateError(
        "Reissue-planned write worker has an inconsistent exact state."
      );
    }
  } else if (journal.state === "provisioning") {
    if (job.status !== "queued"
      || job.phase !== "worktree-provisioning"
      || spawn.providerLaunchOutcome !== "not-ready"
      || !runtimeEvidence
      || job.startedAt !== null
      || job.completedAt !== null
      || job.result !== null
      || job.error !== null) {
      writeProvisioningStateError("Provisioning write worker has an inconsistent exact state.");
    }
  } else if (journal.state === "ready") {
    if (job.status !== "queued"
      || job.phase !== "worktree-ready"
      || spawn.providerLaunchOutcome !== WRITE_READY_LAUNCH_OUTCOME
      || !runtimeEvidence
      || job.startedAt !== null
      || job.completedAt !== null
      || job.result !== null
      || job.error !== null) {
      writeProvisioningStateError("Ready write worker has an inconsistent exact state.");
    }
    // Linked execution root: DEFAULT tolerant-linked policy. Bind to the
    // integrity-checked stored execution manifest (not a fresh capture).
    const executionContextManifest = assertContextCompatible(
      binding.expectedExecutionRoot,
      runtimeEvidence.runtime.executionContextManifest,
      { mode: "execute" }
    );
    if (executionContextManifest.git?.head !== binding.baseCommit
      || executionContextManifest.workspaceRoot !== binding.expectedExecutionRoot
      || executionContextManifest.manifestId
        !== runtimeEvidence.runtime.executionContextManifest.manifestId
      || executionContextManifest.digest
        !== runtimeEvidence.runtime.executionContextManifest.digest) {
      writeProvisioningStateError(
        "Ready write worker execution ContextManifest is not bound to the exact base worktree."
      );
    }
  } else if (journal.state === "cleanup_pending") {
    if (job.status !== "queued"
      || job.phase !== "worktree-cleanup-pending"
      || spawn.providerLaunchOutcome !== "not-ready"
      || !runtimeEvidence
      || job.startedAt !== null
      || job.completedAt !== null
      || job.result !== null
      || job.error !== null) {
      writeProvisioningStateError(
        "Cleanup-pending write worker has an inconsistent exact state."
      );
    }
  } else if (journal.state === "failed") {
    if (job.status !== "failed"
      || job.phase !== "provisioning-failed"
      || spawn.providerLaunchOutcome !== "not-launched"
      || !runtimeEvidence
      || job.startedAt !== null
      || !canonicalTimestamp(job.completedAt)
      || job.result !== null
      || !hasExactKeys(job.error, new Set(["code", "message"]))
      || job.error.code !== journal.error?.code
      || job.error.message !== journal.error?.message) {
      writeProvisioningStateError("Failed write provisioner has inconsistent terminal evidence.");
    }
  } else {
    writeProvisioningStateError(
      "Write execution assertion accepts only planned, reissue-planned, provisioning, ready, cleanup-pending, or exact failed provisioning states."
    );
  }
  return Object.freeze({
    binding,
    journal,
    envelope,
    role,
    profile,
    runtimeRolePolicy,
    admissionContextManifest,
    provisioningRuntime: runtimeEvidence
  });
}
