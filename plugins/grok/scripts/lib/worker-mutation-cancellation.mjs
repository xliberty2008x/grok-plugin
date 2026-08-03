/** Issue #56 worker-mutation cancellation domain. */
import path from "node:path";
import { CompanionError, asErrorPayload } from "./errors.mjs";
import { cleanupTaskRuntimeArtifacts } from "./provider-controller-environments.mjs";
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
  assertTaskEnvelope,
  bindTaskEnvelopeContext,
  buildTaskEnvelope,
  scrubStoredJob
} from "./task-envelope.mjs";
import { appendLifecycleEvent } from "./task-lifecycle.mjs";
import {
  assertProviderGuardForJob,
  loadProviderGuard,
  unregisterProviderGuardInWorkspaceTransaction
} from "./recursion-guard.mjs";
import { resolveControlWorkspace, workspaceState } from "./workspace.mjs";
import {
  captureTerminalEvidence,
  normalizeTerminalProcessSignalError,
  selectTaskTerminalError,
  terminalTaskProgress
} from "./task-terminal-evidence.mjs";
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
  assertDispatchContract
} from "./worker-mutation-dispatch-contract.mjs";
import {
  assertIdempotencyKey,
  idempotencyConflict,
  readIdempotency,
  writeIdempotency
} from "./worker-mutation-idempotency.mjs";
import {
  SHA256_HEX,
  assertMutationOwnership,
  cancellationNonce,
  digestKey,
  isPlainRecord,
  stableDigest,
  validIsoTimestamp
} from "./worker-mutation-primitives.mjs";
import {
  requestDigest
} from "./worker-mutation-request-contract.mjs";
import {
  reconcileCleanupSafeTerminalObservation
} from "./worker-mutation-terminal.mjs";

export const CANCEL_METRIC_TIMESTAMPS = Object.freeze([
  "requestAcceptedAt",
  "processGroupGoneAt",
  "terminalRecordCommittedAt"
]);

export const MAX_CANCELLATION_RECOVERY_RECORDS = 32;

export const CANCELLATION_RECEIPT_STATUSES = new Set([
  "accepted",
  "already_cancelled",
  "already_terminal"
]);

export function cancellationStateError(message) {
  throw new CompanionError("E_STATE", message);
}

export function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) cancellationStateError(`${label} contains an unsupported field.`);
  }
}

export function normalizeCancellationReceipt(receipt, { workerId, keyDigest }) {
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

export function normalizeCancellationRecoveryRecord(record, { jobId, keyDigest }) {
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

export function cancellationHistory(job) {
  const history = job?.result?.cancellationReceiptsByKey;
  if (history === undefined) return {};
  if (!isPlainRecord(history)) cancellationStateError("Cancellation recovery history is malformed.");
  const keys = Object.keys(history);
  if (keys.length > MAX_CANCELLATION_RECOVERY_RECORDS || keys.some((key) => !SHA256_HEX.test(key))) {
    cancellationStateError("Cancellation recovery history exceeds its durable bound or is malformed.");
  }
  return history;
}

export function legacyCancellationRecoveryRecord(job, keyDigest) {
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

export function cancellationRecoveryRecordForKey(job, keyDigest) {
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

export function appendCancellationRecoveryRecord(job, record) {
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

export function cancelRequestDigest({ principal, workerId }) {
  return stableDigest({
    ownerThreadId: principal?.threadId || null,
    workerId
  });
}

export function recoveryRecordFromIdempotency(existing, keyDigest) {
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

export function findCancellationRecovery(transaction, keyDigest) {
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

export function prepareCancellationMutation({ principal, workerId, idempotencyKey }) {
  assertIdempotencyKey(idempotencyKey);
  if (!principal?.threadId) {
    throw new CompanionError("E_AUTH_REQUIRED", "Trusted Codex task identity is unavailable.");
  }
  if (!workerId) {
    throw new CompanionError("E_USAGE", "workerId is required.");
  }
  return {
    keyDigest: digestKey(idempotencyKey),
    mutationDigest: cancelRequestDigest({ principal, workerId })
  };
}

export function createCancellationMutationState({ principal, workerId, keyDigest, mutationDigest }) {
  const requestAcceptedAt = now();
  return {
    principal,
    workerId,
    keyDigest,
    mutationDigest,
    requestAcceptedAt,
    receiptId: `cancel-${digestKey(`${principal.threadId}:${workerId}:${keyDigest}`).slice(0, 24)}`,
    cancellationRequestSequence: null,
    status: "accepted",
    processGroupGoneAt: null,
    terminalRecordCommittedAt: null,
    wasActive: false
  };
}

export function cancellationRecord(state) {
  return {
    receiptId: state.receiptId,
    status: state.status,
    requestAcceptedAt: state.requestAcceptedAt,
    processGroupGoneAt: state.processGroupGoneAt,
    terminalRecordCommittedAt: state.terminalRecordCommittedAt,
    idempotencyKeyDigest: state.keyDigest,
    ownerThreadId: state.principal.threadId,
    requestDigest: state.mutationDigest,
    cancellationRequestSequence: state.cancellationRequestSequence
  };
}

export function cancellationReceipt(state) {
  return Object.freeze({
    receiptId: state.receiptId,
    workerId: state.workerId,
    status: state.status,
    requestAcceptedAt: state.requestAcceptedAt,
    processGroupGoneAt: state.processGroupGoneAt,
    terminalRecordCommittedAt: state.terminalRecordCommittedAt,
    idempotencyKeyDigest: state.keyDigest,
    cancellationRequestSequence: state.cancellationRequestSequence
  });
}

export function cancellationRecoveryRecord(state) {
  return {
    schemaVersion: 1,
    workerId: state.workerId,
    ownerThreadId: state.principal.threadId,
    requestDigest: state.mutationDigest,
    idempotencyKeyDigest: state.keyDigest,
    receipt: cancellationReceipt(state),
    committedAt: state.requestAcceptedAt
  };
}

export function persistCancellation(current, state, extra = {}) {
  return {
    ...(current.result || {}),
    hostVerification: current.result?.hostVerification || "not_run",
    ...extra,
    cancellation: cancellationRecord(state),
    cancellationReceiptsByKey: appendCancellationRecoveryRecord(
      current,
      cancellationRecoveryRecord(state)
    )
  };
}

export function publishCancellationMutation({ updated, state, root, idempotencyKey, env }) {
  if (state.wasActive) {
    const count = (updated.lifecycleEvents || [])
      .filter((event) => event.type === "cancellation.requested").length;
    if (count !== 1) {
      throw new CompanionError(
        "E_STATE",
        `Expected exactly one cancellation-request event, found ${count}.`
      );
    }
  }
  const receipt = cancellationReceipt(state);
  writeIdempotency(root, "cancel", idempotencyKey, {
    workerId: state.workerId,
    ownerThreadId: state.principal.threadId,
    requestDigest: state.mutationDigest,
    receipt,
    committedAt: state.requestAcceptedAt
  }, env);
  return { receipt, replayed: false };
}

export function cancelWorker({ root, principal, workerId, idempotencyKey, env = process.env } = {}) {
  const { keyDigest, mutationDigest } = prepareCancellationMutation({ principal, workerId, idempotencyKey });
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

    const cancellation = createCancellationMutationState({ principal, workerId, keyDigest, mutationDigest });

    const updated = transaction.updateJob(workerId, (current) => {
      assertMutationOwnership(current, principal);
      if (current.status !== "queued" && current.status !== "running") {
        cancellation.status = "already_terminal";
        cancellation.terminalRecordCommittedAt = current.completedAt || cancellation.requestAcceptedAt;
        return {
          ...current,
          // Persist immutable per-key recovery next to the terminal job. If the
          // adjacent idempotency-file publication is interrupted, later keys
          // cannot overwrite this receipt's recovery identity.
          result: persistCancellation(current, cancellation)
        };
      }
      cancellation.wasActive = true;

      const events = Array.isArray(current.lifecycleEvents) ? current.lifecycleEvents : [];
      const existingEvent = events.find((event) => event.type === "cancellation.requested");
      let nextEvents = events;
      if (existingEvent) {
        cancellation.status = "already_cancelled";
        cancellation.cancellationRequestSequence = existingEvent.sequence ?? null;
      } else {
        nextEvents = appendLifecycleEvent(
          events,
          "cancellation.requested",
          "Cancellation request accepted by worker broker.",
          { requestAcceptedAt: cancellation.requestAcceptedAt }
        );
        cancellation.cancellationRequestSequence = nextEvents.at(-1)?.sequence ?? null;
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
      if (mayCommitTerminal) cancellation.terminalRecordCommittedAt = now();

      if (mayCommitTerminal) {
        const settledRequest = {
            ...current.request,
            spawn: {
              ...current.request?.spawn,
              providerLaunchPending: false,
              providerLaunchInFlight: false,
              providerLaunchOutcome: "not-launched",
              providerLaunchCompletedAt: cancellation.terminalRecordCommittedAt,
              dispatch: {
                ...dispatch,
                state: "failed",
                // Dispatch-v2 requires a fenced attempt identity for every
                // non-pending state. Cancellation owns this synthetic fence
                // only to atomically revoke the never-consumed launch grant.
                attemptId: digestKey(`${cancellation.receiptId}:cancel-dispatch`).slice(0, 32),
                fence: 1,
                lease: null,
                nextProviderGeneration: null,
                claimedAt: cancellation.terminalRecordCommittedAt,
                failedAt: cancellation.terminalRecordCommittedAt,
                updatedAt: cancellation.terminalRecordCommittedAt
              }
            }
          };
        const observed = reconcileCleanupSafeTerminalObservation(
          {
            ...current,
            request: settledRequest,
            workerAuthorization: null,
            lifecycleEvents: nextEvents,
            result: persistCancellation(current, cancellation, {
              taskRuntimeCleaned: true
            })
          },
          {
            status: "cancelled",
            phase: "cancelled",
            completedAt: cancellation.terminalRecordCommittedAt,
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
          completedAt: pending.completedAt || cancellation.terminalRecordCommittedAt,
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
        result: persistCancellation(current, cancellation, brokerOnlyCleanup?.warning || providerGuardWarning || dispatchContractWarning
          ? {
              taskRuntimeCleaned: false,
              privacyWarning: brokerOnlyCleanup?.warning || providerGuardWarning || dispatchContractWarning
            }
          : {})
      };
    });

    return publishCancellationMutation({ updated, state: cancellation, root, idempotencyKey, env });
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
