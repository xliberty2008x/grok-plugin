/** Issue #56 worker-mutation write-recovery domain. */
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
import {
  assertContextCompatible,
  assertContextManifestIntegrity,
  captureContextManifest
} from "./task-context-manifest.mjs";
import { bindContextMetadataCompleteness } from "./task-context-metadata.mjs";
import { appendLifecycleEvent } from "./task-lifecycle.mjs";
import {
  assertExecutionBinding,
  assertProvisioningJournal,
  createExecutionBinding,
  createProvisioningJournal,
  transitionProvisioningJournal
} from "./worker-execution-binding.mjs";
import {
  SHA256_HEX,
  assertMutationOwnership,
  hasExactKeys,
  stableDigest
} from "./worker-mutation-primitives.mjs";
import {
  assertActualWriteProvisionerCleanup,
  assertProvisioningGuardAbsent,
  assertWriteProvisioningMutationBoundary,
  assertWriteProvisioningMutationInput,
  buildWriteProvisioningCleanupProof,
  managedWorktreeVerification,
  sameWorktreeVerificationIdentity
} from "./worker-mutation-write-admission.mjs";
import {
  EXACT_NONCE_HEX,
  WRITE_HOST_ADOPTION_ORIGIN,
  WRITE_PREACTIVATION_CLEANUP_RESOLUTION,
  WRITE_PROVISIONING_NO_CHILD_RESOLUTIONS,
  WRITE_PROVISIONING_SCHEMA_VERSION,
  WRITE_READY_LAUNCH_OUTCOME,
  assertCanonicalTimestamp,
  assertWorktreeHostAdoption,
  sameWriteProvisioningProcessIdentity,
  worktreeHostAdoptionWithoutDigest,
  writeProvisioningStateError
} from "./worker-mutation-write-contract.mjs";
import {
  assertWriteExecutionJob
} from "./worker-mutation-write-runtime-contract.mjs";

const {
  captureCompleteContextManifest
} = bindContextMetadataCompleteness({
  captureContextManifest,
  assertContextManifestIntegrity
});

export function retainWriteProvisioningCleanupPending({
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
  cleanupProof,
  cleanupPendingAt = null,
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
  const requestedCleanupPendingAt = cleanupPendingAt;
  if (requestedCleanupPendingAt !== null) {
    assertCanonicalTimestamp(requestedCleanupPendingAt, "cleanupPendingAt");
  }

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
    const retainedAt = requestedCleanupPendingAt
      ?? (verified.journal.state === "cleanup_pending"
        ? verified.journal.cleanupPendingAt
        : now());
    assertCanonicalTimestamp(retainedAt, "cleanupPendingAt");

    if (!sameWriteProvisioningProcessIdentity(processIdentity, intent.processIdentity)) {
      writeProvisioningStateError(
        "Cleanup-pending retention changed the durable controller identity.",
        "E_PROCESS_IDENTITY"
      );
    }
    const durableCleanup = buildWriteProvisioningCleanupProof(cleanupProof, intent);
    if (Date.parse(retainedAt) < Date.parse(durableCleanup.observedAt)
      || Date.parse(retainedAt) < Date.parse(intent.registeredAt)) {
      writeProvisioningStateError(
        "Cleanup-pending retention cannot predate controller registration or cleanup proof."
      );
    }
    if (runtime.receipt) {
      for (const timestamp of [
        runtime.receipt.receivedAt,
        runtime.receipt.hostVerification.verifiedAt
      ]) {
        if (Date.parse(retainedAt) < Date.parse(timestamp)) {
          writeProvisioningStateError(
            "Cleanup-pending retention cannot predate known official worktree evidence."
          );
        }
      }
    }
    assertActualWriteProvisionerCleanup(verified.binding, intent);

    if (verified.journal.state === "cleanup_pending") {
      if (verified.journal.previousJournalDigest !== expectedJournalDigest
        || intent.status !== "registered"
        || intent.updatedAt !== verified.journal.cleanupPendingAt
        || (requestedCleanupPendingAt !== null
          && verified.journal.cleanupPendingAt !== requestedCleanupPendingAt)
        || runtime.cleanupProof?.proofDigest !== durableCleanup.proofDigest) {
        writeProvisioningStateError(
          "Cleanup-pending replay changed retained provisioning evidence."
        );
      }
      return Object.freeze({
        retained: false,
        replayed: true,
        job: current
      });
    }

    if (verified.journal.state !== "provisioning"
      || verified.journal.journalDigest !== expectedJournalDigest
      || intent.status !== "registered"
      || runtime.cleanupProof !== null
      || runtime.runtime.executionContextManifest !== null) {
      writeProvisioningStateError(
        "Only one registered provisioner can enter cleanup-pending retention."
      );
    }

    const journal = transitionProvisioningJournal(
      verified.binding,
      verified.journal,
      {
        state: "cleanup_pending",
        expectedCurrentJournalDigest: expectedJournalDigest,
        actorAttemptId: attemptId,
        actorFence: fence,
        actorHolderId: holderId,
        cleanupPendingAt: retainedAt
      }
    );
    const nextIntent = {
      ...intent,
      updatedAt: retainedAt
    };
    const nextRuntime = {
      ...runtime.runtime,
      intent: nextIntent,
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
        || latestVerified.provisioningRuntime.cleanupProof !== null) {
        writeProvisioningStateError(
          "Write provisioning state changed before cleanup-pending retention."
        );
      }
      assertActualWriteProvisionerCleanup(latestVerified.binding, intent);
      const next = {
        ...latest,
        status: "queued",
        phase: "worktree-cleanup-pending",
        summary: "Write worktree effect requires cleanup reconciliation",
        progress: "Provisioning controller cleanup verified; worktree effect remains unresolved.",
        updatedAt: retainedAt,
        heartbeatAt: retainedAt,
        provisioning: journal,
        provisioningRuntime: nextRuntime,
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
          "blocked",
          "Official worktree effect retained for host-owned reconciliation.",
          {
            providerSpawnIntentId,
            officialReceiptKnown: nextRuntime.officialReceipt !== null
          }
        )
      };
      assertWriteExecutionJob(next, env);
      return next;
    });
    return Object.freeze({
      retained: true,
      replayed: false,
      job
    });
  }, env);
}

export function replayAdoptedWriteProvisioningEffect({
  verified,
  runtime,
  expectedJournalDigest,
  requestedReadyAt,
  env,
  current
}) {
  if (verified.journal.previousJournalDigest !== expectedJournalDigest
    || runtime.receipt !== null
    || !runtime.hostAdoption
    || (requestedReadyAt !== null && runtime.intent.settledAt !== requestedReadyAt)) {
    writeProvisioningStateError(
      "Ready host-adoption replay changed durable recovery evidence."
    );
  }
  const currentVerification = managedWorktreeVerification(verified.binding, env);
  if (!sameWorktreeVerificationIdentity(
    runtime.hostAdoption.hostVerification,
    currentVerification
  )) {
    writeProvisioningStateError(
      "Host-adopted worktree identity changed before replay.",
      "E_WORKTREE"
    );
  }
  // Replay: semantic DEFAULT linked recheck against immutable stored capture.
  const currentManifest = assertContextCompatible(
    verified.binding.expectedExecutionRoot,
    runtime.runtime.executionContextManifest,
    { mode: "execute" }
  );
  if (currentManifest.manifestId
      !== runtime.runtime.executionContextManifest.manifestId
    || currentManifest.digest !== runtime.runtime.executionContextManifest.digest
    || currentManifest.manifestId !== verified.journal.executionContextManifestId
    || currentManifest.digest !== verified.journal.executionContextManifestDigest) {
    writeProvisioningStateError(
      "Host-adopted execution context changed before replay.",
      "E_CONTEXT_DRIFT"
    );
  }
  return Object.freeze({
    adopted: false,
    replayed: true,
    adoption: runtime.hostAdoption,
    job: current
  });
}

export function adoptWriteProvisioningEffect({ root, principal, workerId, executionBindingDigest, expectedJournalDigest, providerSpawnIntentId, cleanupProofDigest, readyAt = null, env = process.env } = {}) {
  if (!root || !principal?.threadId || !workerId) {
    throw new CompanionError(
      principal?.threadId ? "E_USAGE" : "E_AUTH_REQUIRED",
      principal?.threadId
        ? "Write provisioning adoption requires a worker identity."
        : "Trusted Codex task identity is unavailable."
    );
  }
  if (!SHA256_HEX.test(executionBindingDigest || "")
    || !SHA256_HEX.test(expectedJournalDigest || "")
    || !EXACT_NONCE_HEX.test(providerSpawnIntentId || "")
    || !SHA256_HEX.test(cleanupProofDigest || "")) {
    throw new CompanionError(
      "E_USAGE",
      "Write provisioning adoption requires exact binding, journal, intent, and cleanup identities."
    );
  }
  const requestedReadyAt = readyAt;
  if (requestedReadyAt !== null) {
    assertCanonicalTimestamp(requestedReadyAt, "readyAt");
  }

  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    assertMutationOwnership(current, principal);
    const verified = assertWriteExecutionJob(current, env);
    const runtime = verified.provisioningRuntime;
    const intent = runtime?.intent;
    if (verified.binding.bindingDigest !== executionBindingDigest
      || intent?.providerSpawnIntentId !== providerSpawnIntentId
      || runtime?.cleanupProof?.proofDigest !== cleanupProofDigest) {
      writeProvisioningStateError(
        "Host adoption does not own the exact retained provisioning evidence.",
        "E_PROCESS_IDENTITY"
      );
    }
    assertActualWriteProvisionerCleanup(verified.binding, intent);

    if (verified.journal.state === "ready") {
      return replayAdoptedWriteProvisioningEffect({
        verified,
        runtime,
        expectedJournalDigest,
        requestedReadyAt,
        env,
        current
      });
    }

    if (verified.journal.state !== "cleanup_pending"
      || verified.journal.journalDigest !== expectedJournalDigest
      || intent.status !== "registered"
      || runtime.receipt !== null
      || runtime.hostAdoption !== null
      || runtime.runtime.executionContextManifest !== null) {
      writeProvisioningStateError(
        "Only one unknown official effect can be host-adopted from cleanup-pending."
      );
    }

    const verification = managedWorktreeVerification(verified.binding, env);
    const executionContextManifest = captureCompleteContextManifest(
      verified.binding.expectedExecutionRoot,
      { contextPhase: "execute" }
    );
    const currentManifest = assertContextCompatible(
      verified.binding.expectedExecutionRoot,
      executionContextManifest,
      { mode: "execute", contextPhase: "execute" }
    );
    if (currentManifest.workspaceRoot !== verified.binding.expectedExecutionRoot
      || currentManifest.git?.head !== verified.binding.baseCommit) {
      writeProvisioningStateError(
        "Host-adopted ContextManifest is not exact for the verified worktree.",
        "E_CONTEXT_DRIFT"
      );
    }

    const observedAt = new Date(Math.max(
      Date.now(),
      Date.parse(verified.journal.cleanupPendingAt),
      Date.parse(runtime.cleanupProof.observedAt),
      Date.parse(verification.verifiedAt)
    )).toISOString();
    const adoption = {
      schemaVersion: WRITE_PROVISIONING_SCHEMA_VERSION,
      origin: WRITE_HOST_ADOPTION_ORIGIN,
      operationId: intent.operationId,
      providerSpawnIntentId: intent.providerSpawnIntentId,
      provisioningIntentDigest: intent.intentDigest,
      requestedExecutableIdentityDigest: intent.executableIdentity.identityDigest,
      requestedReleaseIdentityDigest:
        intent.executableIdentity.releaseIdentityDigest,
      cleanupPendingAt: verified.journal.cleanupPendingAt,
      cleanupPendingJournalDigest: verified.journal.journalDigest,
      cleanupProofDigest: runtime.cleanupProof.proofDigest,
      hostVerification: verification,
      observedAt,
      adoptionDigest: null
    };
    adoption.adoptionDigest = stableDigest(
      worktreeHostAdoptionWithoutDigest(adoption)
    );
    assertWorktreeHostAdoption(
      adoption,
      verified.binding,
      intent,
      runtime.cleanupProof,
      verified.journal.journalDigest
    );

    const adoptedAt = requestedReadyAt ?? new Date(Math.max(
      Date.now(),
      Date.parse(observedAt),
      Date.parse(executionContextManifest.capturedAt)
    )).toISOString();
    assertCanonicalTimestamp(adoptedAt, "readyAt");
    for (const [timestamp, label] of [
      [observedAt, "host-adoption observation"],
      [executionContextManifest.capturedAt, "execution ContextManifest"]
    ]) {
      if (Date.parse(adoptedAt) < Date.parse(timestamp)) {
        writeProvisioningStateError(`Host adoption cannot predate its ${label}.`);
      }
    }

    const journal = transitionProvisioningJournal(
      verified.binding,
      verified.journal,
      {
        state: "ready",
        expectedCurrentJournalDigest: expectedJournalDigest,
        readyAt: adoptedAt,
        executionContextManifestId: currentManifest.manifestId,
        executionContextManifestDigest: currentManifest.digest
      }
    );
    const nextIntent = {
      ...intent,
      status: "settled",
      settledAt: adoptedAt,
      updatedAt: adoptedAt
    };
    const nextRuntime = {
      ...runtime.runtime,
      intent: nextIntent,
      hostAdoption: adoption,
      executionContextManifest,
      executionContextManifestRecordDigest:
        stableDigest(executionContextManifest)
    };
    const job = transaction.updateJob(workerId, (latest) => {
      assertMutationOwnership(latest, principal);
      const latestVerified = assertWriteExecutionJob(latest, env);
      if (latestVerified.journal.state !== "cleanup_pending"
        || latestVerified.journal.journalDigest !== expectedJournalDigest
        || latestVerified.provisioningRuntime?.intent.providerSpawnIntentId
          !== providerSpawnIntentId
        || latestVerified.provisioningRuntime.cleanupProof?.proofDigest
          !== cleanupProofDigest
        || latestVerified.provisioningRuntime.receipt !== null
        || latestVerified.provisioningRuntime.hostAdoption !== null) {
        writeProvisioningStateError(
          "Write provisioning state changed before host adoption."
        );
      }
      assertActualWriteProvisionerCleanup(latestVerified.binding, intent);
      const commitVerification = managedWorktreeVerification(
        latestVerified.binding,
        env
      );
      if (!sameWorktreeVerificationIdentity(
        verification,
        commitVerification
      )) {
        writeProvisioningStateError(
          "Host-adoption worktree identity changed before publication.",
          "E_WORKTREE"
        );
      }
      const commitManifest = assertContextCompatible(
        latestVerified.binding.expectedExecutionRoot,
        executionContextManifest,
        { mode: "execute" }
      );
      if (commitManifest.manifestId !== currentManifest.manifestId
        || commitManifest.digest !== currentManifest.digest
        || commitManifest.workspaceRoot !== latestVerified.binding.expectedExecutionRoot
        || commitManifest.git?.head !== latestVerified.binding.baseCommit) {
        writeProvisioningStateError(
          "Host-adoption context changed before publication.",
          "E_CONTEXT_DRIFT"
        );
      }
      const next = {
        ...latest,
        status: "queued",
        phase: "worktree-ready",
        summary: "Host-verified write worktree ready",
        progress:
          "Unknown official response reconciled by exact host adoption; provider dispatch is not yet authorized.",
        updatedAt: adoptedAt,
        heartbeatAt: adoptedAt,
        provisioning: journal,
        provisioningRuntime: nextRuntime,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            providerLaunchPending: false,
            providerLaunchInFlight: false,
            providerLaunchOutcome: WRITE_READY_LAUNCH_OUTCOME
          }
        },
        startedAt: null,
        completedAt: null,
        result: null,
        error: null,
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "activity.completed",
          "Unknown official worktree effect adopted from exact host evidence.",
          {
            operationId: intent.operationId,
            hostAdoptionDigest: adoption.adoptionDigest,
            cleanupProofDigest: runtime.cleanupProof.proofDigest
          }
        )
      };
      assertWriteExecutionJob(next, env);
      return next;
    });
    return Object.freeze({
      adopted: true,
      replayed: false,
      adoption: job.provisioningRuntime.hostAdoption,
      job
    });
  }, env);
}

export function replayWriteProvisionerNoChild({ verified, intent, runtime, processIdentity, cleanupProof, resolution, requestedFailedAt, error, expectedJournalDigest, workerId, current }) {
  const activeFailure = intent.processIdentity !== null;
  const preactivationFailure = (
    intent.resolution === WRITE_PREACTIVATION_CLEANUP_RESOLUTION
  );
  let replayCleanup = null;
  if (activeFailure) {
    if (!sameWriteProvisioningProcessIdentity(processIdentity, intent.processIdentity)
      || cleanupProof === null) {
      writeProvisioningStateError(
        "No-child replay changed the durable process identity.",
        "E_PROCESS_IDENTITY"
      );
    }
    replayCleanup = buildWriteProvisioningCleanupProof(cleanupProof, intent);
    assertActualWriteProvisionerCleanup(verified.binding, intent);
  } else if (preactivationFailure) {
    if (processIdentity === null || cleanupProof === null) {
      writeProvisioningStateError(
        "Preactivation no-child replay omitted its transient process evidence.",
        "E_PROCESS_IDENTITY"
      );
    }
    replayCleanup = buildWriteProvisioningCleanupProof(cleanupProof, intent, {
      processIdentity,
      preactivation: true
    });
    assertActualWriteProvisionerCleanup(
      verified.binding,
      intent,
      processIdentity
    );
  } else if (processIdentity !== null || cleanupProof !== null) {
    writeProvisioningStateError(
      "Prepared no-child replay introduced process evidence.",
      "E_PROCESS_IDENTITY"
    );
  } else {
    assertProvisioningGuardAbsent(verified.binding.controlRoot, workerId);
  }
  if (intent.status !== "no-child"
    || intent.resolution !== resolution
    || (requestedFailedAt !== null && intent.noChildAt !== requestedFailedAt)
    || verified.journal.error.code !== error.code
    || verified.journal.error.message !== error.message
    || (activeFailure
      ? (
          runtime.runtime.activatedJournalDigest !== expectedJournalDigest
          || runtime.cleanupProof.proofDigest !== replayCleanup.proofDigest
        )
      : preactivationFailure
        ? (
            verified.journal.previousJournalDigest !== expectedJournalDigest
            || runtime.cleanupProof.proofDigest !== replayCleanup.proofDigest
          )
        : verified.journal.previousJournalDigest !== expectedJournalDigest)) {
    writeProvisioningStateError("No-child replay changed terminal provisioning evidence.");
  }
  return Object.freeze({ settled: false, replayed: true, job: current });
}

export function recordWriteProvisionerNoChild({
  root,
  principal,
  workerId,
  executionBindingDigest,
  expectedJournalDigest,
  attemptId,
  fence,
  holderId,
  providerSpawnIntentId,
  resolution = "spawn-not-created",
  processIdentity = null,
  cleanupProof = null,
  error = {
    code: "E_PROVIDER_EXIT",
    message: "Worktree provisioner did not produce a usable child."
  },
  failedAt = null,
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
  if (!WRITE_PROVISIONING_NO_CHILD_RESOLUTIONS.has(resolution)
    || !hasExactKeys(error, new Set(["code", "message"]))) {
    throw new CompanionError(
      "E_USAGE",
      "Write provisioner no-child settlement requires an exact resolution and bounded error."
    );
  }
  const requestedFailedAt = failedAt;
  const settledAt = failedAt ?? now();
  assertCanonicalTimestamp(settledAt, "failedAt");

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

    if (verified.journal.state === "failed") {
      return replayWriteProvisionerNoChild({ verified, intent, runtime, processIdentity, cleanupProof, resolution, requestedFailedAt, error, expectedJournalDigest, workerId, current });
    }

    let journal;
    let durableCleanup = null;
    if (["planned", "reissue_planned"].includes(verified.journal.state)) {
      const preactivationCleanup = (
        resolution === WRITE_PREACTIVATION_CLEANUP_RESOLUTION
      );
      if (verified.journal.journalDigest !== expectedJournalDigest
        || intent.status !== "pending"
        || intent.processIdentity !== null) {
        writeProvisioningStateError(
          "Prepared write provisioner no-child settlement is not exact.",
          "E_PROCESS_IDENTITY"
        );
      }
      if (preactivationCleanup) {
        if (processIdentity === null || cleanupProof === null) {
          writeProvisioningStateError(
            "Preactivation no-child settlement requires transient process cleanup evidence.",
            "E_PROCESS_IDENTITY"
          );
        }
        durableCleanup = buildWriteProvisioningCleanupProof(cleanupProof, intent, {
          processIdentity,
          preactivation: true
        });
        if (Date.parse(settledAt) < Date.parse(durableCleanup.observedAt)) {
          writeProvisioningStateError("Provisioning failure cannot predate cleanup proof.");
        }
        assertActualWriteProvisionerCleanup(
          verified.binding,
          intent,
          processIdentity
        );
      } else {
        if (processIdentity !== null
          || cleanupProof !== null
          || !["spawn-not-created", "authorization-revoked"].includes(resolution)) {
          writeProvisioningStateError(
            "Prepared write provisioner no-child settlement is not exact.",
            "E_PROCESS_IDENTITY"
          );
        }
        if (Date.parse(settledAt) < Date.parse(intent.preparedAt)) {
          writeProvisioningStateError("Provisioning failure cannot predate intent preparation.");
        }
        assertProvisioningGuardAbsent(verified.binding.controlRoot, workerId);
      }
      journal = transitionProvisioningJournal(
        verified.binding,
        verified.journal,
        {
          state: "failed",
          expectedCurrentJournalDigest: expectedJournalDigest,
          failedAt: settledAt,
          error
        }
      );
    } else if (verified.journal.state === "provisioning") {
      if (verified.journal.journalDigest !== expectedJournalDigest
        || resolution !== "cleanup-proven"
        || !sameWriteProvisioningProcessIdentity(processIdentity, intent.processIdentity)) {
        writeProvisioningStateError(
          "Activated write provisioner failure lacks its exact process boundary.",
          "E_PROCESS_IDENTITY"
        );
      }
      durableCleanup = buildWriteProvisioningCleanupProof(cleanupProof, intent);
      if (Date.parse(settledAt) < Date.parse(durableCleanup.observedAt)) {
        writeProvisioningStateError("Provisioning failure cannot predate cleanup proof.");
      }
      assertActualWriteProvisionerCleanup(verified.binding, intent);
      const cleanupPending = transitionProvisioningJournal(
        verified.binding,
        verified.journal,
        {
          state: "cleanup_pending",
          expectedCurrentJournalDigest: expectedJournalDigest,
          actorAttemptId: attemptId,
          actorFence: fence,
          actorHolderId: holderId,
          cleanupPendingAt: settledAt
        }
      );
      journal = transitionProvisioningJournal(
        verified.binding,
        cleanupPending,
        {
          state: "failed",
          expectedCurrentJournalDigest: cleanupPending.journalDigest,
          failedAt: settledAt,
          error
        }
      );
    } else {
      writeProvisioningStateError("Write provisioner no-child settlement is no longer legal.");
    }

    const nextIntent = {
      ...intent,
      status: "no-child",
      noChildAt: settledAt,
      resolution,
      updatedAt: settledAt
    };
    const nextRuntime = {
      ...runtime.runtime,
      intent: nextIntent,
      cleanupProof: durableCleanup
    };
    const job = transaction.updateJob(workerId, (latest) => {
      assertMutationOwnership(latest, principal);
      const latestVerified = assertWriteExecutionJob(latest, env);
      if (latestVerified.journal.journalDigest !== verified.journal.journalDigest
        || latestVerified.provisioningRuntime?.intent.providerSpawnIntentId
          !== providerSpawnIntentId) {
        writeProvisioningStateError("Write provisioning state changed before no-child publication.");
      }
      if (latestVerified.journal.state === "provisioning") {
        assertActualWriteProvisionerCleanup(latestVerified.binding, intent);
      } else if (resolution === WRITE_PREACTIVATION_CLEANUP_RESOLUTION) {
        assertActualWriteProvisionerCleanup(
          latestVerified.binding,
          intent,
          processIdentity
        );
      } else {
        assertProvisioningGuardAbsent(latestVerified.binding.controlRoot, workerId);
      }
      const next = {
        ...latest,
        status: "failed",
        phase: "provisioning-failed",
        summary: "Write worktree provisioning failed",
        progress: "Provisioning intent settled without dispatch or provider authority.",
        completedAt: settledAt,
        heartbeatAt: settledAt,
        provisioning: journal,
        provisioningRuntime: nextRuntime,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            providerLaunchOutcome: "not-launched"
          }
        },
        result: null,
        error: { ...error },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "blocked",
          "Write-worktree provisioning ended without a usable child.",
          {
            resolution,
            providerSpawnIntentId
          }
        )
      };
      assertWriteExecutionJob(next, env);
      return next;
    });
    return Object.freeze({
      settled: true,
      replayed: false,
      job
    });
  }, env);
}
