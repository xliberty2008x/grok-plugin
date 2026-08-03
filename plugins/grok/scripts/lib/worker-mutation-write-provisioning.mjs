/** Issue #56 worker-mutation write-provisioning domain. */
import crypto from "node:crypto";
import { CompanionError, asErrorPayload } from "./errors.mjs";
import {
  assertExecutableAttestation,
  sameExecutableAttestation
} from "./executable-identity.mjs";
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
  CONTEXT_MANIFEST_VERSION,
  CONTEXT_METADATA_POLICIES
} from "./task-context-policy.mjs";
import { appendLifecycleEvent } from "./task-lifecycle.mjs";
import { processGroupGone, processStartToken } from "./process-control.mjs";
import {
  assertExecutionBinding,
  assertProvisioningJournal,
  createExecutionBinding,
  createProvisioningJournal,
  transitionProvisioningJournal
} from "./worker-execution-binding.mjs";
import {
  assertMutationOwnership,
  currentOwnedProcessIdentity,
  stableDigest
} from "./worker-mutation-primitives.mjs";
import {
  assertActualWriteProvisionerCleanup,
  assertOfficialWorktreeReceiptInput,
  assertProvisioningGuardAbsent,
  assertWriteProvisioningMutationBoundary,
  assertWriteProvisioningMutationInput,
  buildWriteProvisioningCleanupProof,
  exactAbsentWorktreeEffect,
  managedWorktreeVerification,
  sameWorktreeAbsenceIdentity,
  sameWorktreeVerificationIdentity
} from "./worker-mutation-write-admission.mjs";
import {
  MAX_WRITE_PROVISIONING_ATTEMPTS,
  WRITE_PROVISIONING_PURPOSE,
  WRITE_PROVISIONING_SCHEMA_VERSION,
  WRITE_READY_LAUNCH_OUTCOME,
  assertCanonicalTimestamp,
  assertOfficialWorktreeReceipt,
  assertWriteProvisioningAttemptArchive,
  assertWriteProvisioningIntent,
  assertWriteProvisioningProcessIdentity,
  officialWorktreeReceiptWithoutDigest,
  sameWriteProvisioningProcessIdentity,
  writeProvisioningActivationDigest,
  writeProvisioningAttemptArchiveWithoutDigest,
  writeProvisioningIntentDigestBody,
  writeProvisioningProviderBindingFields,
  writeProvisioningStateError
} from "./worker-mutation-write-contract.mjs";
import {
  assertWriteExecutionJob
} from "./worker-mutation-write-runtime-contract.mjs";

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

export function reauthorizeWriteProvisioningReissue(transaction, current, verified, providerBindingFields, options) {
  const { workerId, executionBindingDigest, expectedJournalDigest, attemptId, fence, holderId, executableIdentity, principal, env } = options;
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
    assertProvisioningGuardAbsent(latestVerified.binding.controlRoot, workerId);
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
          priorAttemptArchiveDigest: journal.priorAttemptArchiveDigest
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
    if (verified.binding.bindingDigest !== executionBindingDigest) {
      writeProvisioningStateError(
        "Provisioning reissue execution binding changed before planning."
      );
    }
    if (verified.journal.state === "reissue_planned") {
      return reauthorizeWriteProvisioningReissue(
        transaction,
        current,
        verified,
        providerBindingFields,
        { workerId, executionBindingDigest, expectedJournalDigest, attemptId, fence, holderId, executableIdentity, principal, env }
      );
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
