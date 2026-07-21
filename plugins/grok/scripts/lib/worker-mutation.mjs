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
import { sameHostSession } from "./host.mjs";
import {
  generateId,
  isCancelRequested,
  now,
  readPrivateJsonFile,
  requestCancel,
  tryReadJob,
  writePrivateJsonFile,
  ensurePrivateStateDirectory,
  withWorkspaceStateTransaction
} from "./state.mjs";
import { appendLifecycleEvent } from "./task-contract.mjs";
import { projectWorkerHandle, projectWorkerSnapshot } from "./worker-protocol.mjs";
import { materializeRole, assertRoleDigest } from "./worker-roles.mjs";
import { resolveControlWorkspace } from "./workspace.mjs";

export const SPAWN_OWNERSHIP_MODE = "exact-thread-or-host-attested-parent";
export const SPAWN_SUCCESS_DEFINITION = "durable-job-commit";
export const CANCEL_METRIC_TIMESTAMPS = Object.freeze([
  "requestAcceptedAt",
  "processGroupGoneAt",
  "terminalRecordCommittedAt"
]);

// Cancellation recovery is stored next to the job so a crash between the job
// update and adjacent idempotency-file publication remains recoverable. Keep
// the history bounded without pruning: once full, a new key fails closed while
// every already-admitted key remains replayable.
const MAX_CANCELLATION_RECOVERY_RECORDS = 32;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const CANCELLATION_RECEIPT_STATUSES = new Set([
  "accepted",
  "already_cancelled",
  "already_terminal"
]);

function digestKey(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function canonicalize(value, stack = new Set()) {
  if (value === null || typeof value !== "object") return value;
  if (stack.has(value)) {
    throw new CompanionError("E_USAGE", "Mutation request must not contain cyclic data.");
  }
  stack.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => canonicalize(item, stack));
  } else {
    result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = canonicalize(value[key], stack);
    }
  }
  stack.delete(value);
  return result;
}

function stableDigest(value) {
  return digestKey(JSON.stringify(canonicalize(value)));
}

function isPlainRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

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
  if (typeof receipt.requestAcceptedAt !== "string") {
    cancellationStateError("Cancellation recovery receipt timestamp is malformed.");
  }
  for (const field of ["processGroupGoneAt", "terminalRecordCommittedAt"]) {
    if (receipt[field] !== null && typeof receipt[field] !== "string") {
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

function idempotencyConflict(message) {
  throw new CompanionError("E_IDEMPOTENCY_CONFLICT", message);
}

function assertIdempotencyKey(key) {
  if (typeof key !== "string" || key.length < 8 || key.length > 256) {
    throw new CompanionError("E_USAGE", "idempotencyKey must be a string of length 8–256.");
  }
  if (/[\r\n\0]/.test(key)) {
    throw new CompanionError("E_USAGE", "idempotencyKey must not contain control characters.");
  }
  return key;
}

function idempotencyPath(root, kind, keyDigest, env = process.env) {
  // Same control-workspace state store as jobs (shared across linked worktrees).
  const dir = ensurePrivateStateDirectory(root, ["idempotency", kind], env);
  return path.join(dir, `${keyDigest}.json`);
}

function readIdempotency(root, kind, key, env = process.env) {
  const file = idempotencyPath(root, kind, digestKey(key), env);
  return readPrivateJsonFile(file, {
    missing: null,
    label: `idempotency record for ${kind}`
  });
}

function writeIdempotency(root, kind, key, record, env = process.env) {
  const file = idempotencyPath(root, kind, digestKey(key), env);
  return writePrivateJsonFile(file, record);
}

/**
 * Resolve ownership for mutation tools.
 * Exact thread match is always accepted. Host-attested parent/subagent is
 * accepted only when principal.attestedParentThreadId matches job.host.sessionId
 * and principal.attestedByHost === true (never inferred from tool args).
 */
export function assertMutationOwnership(job, principal) {
  if (!job || !principal) {
    throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
  }
  const host = { kind: "codex", sessionId: principal.threadId };
  if (sameHostSession(job, host)) return "exact-thread";
  if (
    principal.attestedByHost === true
    && typeof principal.attestedParentThreadId === "string"
    && job.host?.kind === "codex"
    && job.host?.sessionId === principal.attestedParentThreadId
  ) {
    return "host-attested-parent";
  }
  throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
}

function ownershipHost(principal) {
  return Object.freeze({ kind: "codex", sessionId: principal.threadId });
}

export function cancellationNonce(job) {
  if (typeof job?.workerProcess?.nonce === "string") return job.workerProcess.nonce;
  if (typeof job?.workerAuthorization === "string") return job.workerAuthorization;
  if (typeof job?.workerAuthorization?.nonce === "string") return job.workerAuthorization.nonce;
  return null;
}

/**
 * Commit a durable read-only worker job. Provider launch is intentionally not performed.
 * write:true is rejected until Phase 3 enables broker write spawn after identity redesign.
 */
export function spawnReadOnlyWorker({
  root,
  principal,
  envelope,
  contextManifest = null,
  idempotencyKey,
  roleId = "explorer",
  write = false,
  env = process.env,
  allowWriteSpawn = false,
  providerLaunch = null
} = {}) {
  assertIdempotencyKey(idempotencyKey);
  if (!principal?.threadId) {
    throw new CompanionError("E_AUTH_REQUIRED", "Trusted Codex task identity is unavailable.");
  }
  if (write && !allowWriteSpawn) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Broker write spawn is disabled until Phase 3 control-workspace identity and worktrees are enabled."
    );
  }
  if (!envelope || typeof envelope !== "object") {
    throw new CompanionError("E_USAGE", "TaskEnvelope is required for spawn.");
  }
  if (typeof providerLaunch === "function" && providerLaunch.constructor?.name === "AsyncFunction") {
    throw new CompanionError(
      "E_CAPABILITY",
      "Provider launch adapters must be synchronous and return an explicit launch outcome."
    );
  }
  if (envelope.mode === "write" && !allowWriteSpawn) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Broker write spawn is disabled until Phase 3 control-workspace identity and worktrees are enabled."
    );
  }

  const role = materializeRole(roleId);
  if (Boolean(role.write) !== Boolean(write)) {
    throw new CompanionError(
      "E_ROLE",
      write
        ? `Role ${roleId} cannot perform write work.`
        : `Write-capable role ${roleId} cannot be attached to a read-only worker.`
    );
  }
  if ((envelope.mode === "write") !== Boolean(write)) {
    throw new CompanionError("E_ROLE", "TaskEnvelope mode must match the worker write capability.");
  }
  assertRoleDigest(role);
  let controlWorkspaceId = null;
  try {
    controlWorkspaceId = resolveControlWorkspace(root, env).controlWorkspaceId;
  } catch {
    controlWorkspaceId = null;
  }

  const keyDigest = digestKey(idempotencyKey);
  const spawnDigest = requestDigest({ principal, envelope, contextManifest, roleId, write });
  const admitted = withWorkspaceStateTransaction(root, (transaction) => {
    const existing = readIdempotency(root, "spawn", idempotencyKey, env);
    if (existing) {
      if (existing.ownerThreadId !== principal.threadId || existing.requestDigest !== spawnDigest) {
        idempotencyConflict("idempotencyKey was reused with a different spawn owner or request.");
      }
      const committed = transaction.tryReadJob(existing.workerId);
      if (!committed) {
        throw new CompanionError("E_STATE", "Spawn idempotency record refers to a missing durable job.");
      }
      assertMutationOwnership(committed, principal);
      return { committed, replayed: true };
    }

    // Recover a commit whose adjacent idempotency publication was interrupted.
    const orphan = transaction.listJobs().find((candidate) => (
      candidate.request?.spawn?.idempotencyKeyDigest === keyDigest
    ));
    if (orphan) {
      if (
        orphan.request?.spawn?.ownerThreadId !== principal.threadId
        || orphan.request?.spawn?.requestDigest !== spawnDigest
      ) {
        idempotencyConflict("idempotencyKey was reused with a different spawn owner or request.");
      }
      assertMutationOwnership(orphan, principal);
      const handle = projectWorkerHandle(orphan);
      writeIdempotency(root, "spawn", idempotencyKey, {
        workerId: orphan.id,
        ownerThreadId: principal.threadId,
        requestDigest: spawnDigest,
        handle,
        committedAt: orphan.createdAt || now()
      }, env);
      return { committed: orphan, replayed: true };
    }

    const id = generateId("task");
    const createdAt = now();
    const job = {
      schemaVersion: 3,
      id,
      kind: "task",
      jobClass: "task",
      write: Boolean(write),
      status: "queued",
      phase: "accepted",
      summary: "Spawn committed",
      progress: "Durable job record committed; provider not started by broker spawn.",
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      completedAt: null,
      heartbeatAt: createdAt,
      host: ownershipHost(principal),
      profile: {
        id: role.id,
        contractVersion: role.schemaVersion,
        agentProfileDigest: role.digest
      },
      role: {
        id: role.id,
        digest: role.digest,
        write: role.write
      },
      model: null,
      effort: null,
      controlWorkspaceId,
      request: {
        envelope,
        contextManifest,
        publicObjective: envelope.objective || null,
        roleId: role.id,
        spawn: {
          idempotencyKeyDigest: keyDigest,
          ownerThreadId: principal.threadId,
          requestDigest: spawnDigest,
          successDefinition: SPAWN_SUCCESS_DEFINITION,
          ownershipMode: SPAWN_OWNERSHIP_MODE,
          providerLaunchPending: true
        }
      },
      lifecycleEvents: appendLifecycleEvent(
        [],
        "task.accepted",
        "Durable spawn commit accepted by worker broker.",
        {
          spawnSuccessDefinition: SPAWN_SUCCESS_DEFINITION,
          write: Boolean(write)
        }
      ),
      result: null,
      error: null,
      workerAuthorization: {
        nonce: crypto.randomBytes(16).toString("hex")
      }
    };

    const committed = transaction.admitJob(job);
    const handle = projectWorkerHandle(committed);
    writeIdempotency(root, "spawn", idempotencyKey, {
      workerId: committed.id,
      ownerThreadId: principal.threadId,
      requestDigest: spawnDigest,
      handle,
      committedAt: createdAt
    }, env);
    return { committed, replayed: false };
  }, env);

  // Optional provider launch hook (tests inject; production may attach later).
  // Never auto-replays: only called once on first commit path. Claiming the
  // launch under the workspace transaction prevents cancel from mistaking an
  // in-flight launch for a broker-only queued job. The hook MUST call
  // cancelRequested immediately before process creation and explicitly return
  // { providerLaunched: true } only after a provider really started.
  let providerLaunched = false;
  if (!admitted.replayed && typeof providerLaunch === "function") {
    const claimed = withWorkspaceStateTransaction(root, (transaction) => {
      const current = transaction.tryReadJob(admitted.committed.id);
      const nonce = cancellationNonce(current);
      if (!current
        || (current.status !== "queued" && current.status !== "running")
        || isCancelRequested(root, admitted.committed.id, nonce, env)) {
        return null;
      }
      return transaction.updateJob(current.id, (latest) => ({
        ...latest,
        phase: latest.phase === "accepted" ? "provider-launching" : latest.phase,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request?.spawn,
            providerLaunchPending: false,
            providerLaunchInFlight: true,
            providerLaunchAttemptedAt: now()
          }
        }
      }));
    }, env);

    if (claimed) {
      const nonce = cancellationNonce(claimed);
      const cancelRequested = () => isCancelRequested(root, claimed.id, nonce, env);
      let launchOutcome = "unknown";
      let launchOutcomeSettled = false;
      let launchContractError = null;
      try {
        const result = providerLaunch({ job: claimed, root, principal, cancelRequested });
        if (result && typeof result.then === "function") {
          Promise.resolve(result).catch(() => {});
          launchContractError = new CompanionError(
            "E_CAPABILITY",
            "Provider launch adapters must not return a promise or thenable."
          );
        } else if (result === true || result?.providerLaunched === true) {
          providerLaunched = true;
          launchOutcome = "launched";
          launchOutcomeSettled = true;
        } else if (result === false || result?.providerLaunched === false) {
          launchOutcome = "not-launched";
          launchOutcomeSettled = true;
        } else {
          launchContractError = new CompanionError(
            "E_CAPABILITY",
            "Provider launch adapters must return an explicit providerLaunched boolean."
          );
        }
      } finally {
        const launchObservationEndedAt = now();
        withWorkspaceStateTransaction(root, (transaction) => {
          const current = transaction.tryReadJob(claimed.id);
          if (!current) return null;
          return transaction.updateJob(current.id, (latest) => {
            const next = {
              ...latest,
              request: {
                ...latest.request,
                spawn: {
                  ...latest.request?.spawn,
                  providerLaunchPending: false,
                  // Unknown/throwing/thenable adapters may still launch after
                  // returning control. Keep cancellation fail-closed until an
                  // external reconciler proves the process state.
                  providerLaunchInFlight: !launchOutcomeSettled,
                  providerLaunchOutcome: launchOutcome,
                  providerLaunchCompletedAt: launchOutcomeSettled ? launchObservationEndedAt : null,
                  providerLaunchObservationEndedAt: launchObservationEndedAt
                }
              }
            };
            const cancellation = latest.result?.cancellation;
            const cancelledBeforeLaunch = launchOutcomeSettled
              && launchOutcome === "not-launched"
              && cancellation
              && isCancelRequested(root, latest.id, nonce, env);
            if (!cancelledBeforeLaunch) return next;
            const terminalRecordCommittedAt = cancellation.terminalRecordCommittedAt
              || launchObservationEndedAt;
            return {
              ...next,
              status: "cancelled",
              phase: "cancelled",
              summary: "Cancelled",
              progress: "Cancellation was confirmed before provider launch.",
              completedAt: terminalRecordCommittedAt,
              result: {
                ...(latest.result || {}),
                hostVerification: latest.result?.hostVerification || "not_run",
                stopReason: "cancelled",
                // Explicit not-launched is proof that this job owns no provider
                // runtime. Preserve the cancellation receipt byte-for-byte;
                // terminal job state is recorded separately from that receipt.
                taskRuntimeCleaned: true
              }
            };
          });
        }, env);
      }
      if (launchContractError) throw launchContractError;
    }
  }

  const finalCommitted = tryReadJob(root, admitted.committed.id, env) || admitted.committed;
  return {
    handle: projectWorkerHandle(finalCommitted),
    replayed: admitted.replayed,
    spawnSuccessDefinition: SPAWN_SUCCESS_DEFINITION,
    providerLaunched
  };
}

function requestDigest({ principal, envelope, contextManifest, roleId, write }) {
  return stableDigest({
    ownerThreadId: principal?.threadId || null,
    envelope,
    contextManifest,
    roleId,
    write: Boolean(write)
  });
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
  env = process.env,
  signalProcess = null
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
  return withWorkspaceStateTransaction(root, (transaction) => {
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
    let processGroupGoneAt = null;
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

      const brokerOnlyQueued = Boolean(
        current.status === "queued"
        && (
          current.request?.spawn?.providerLaunchPending === true
          || current.request?.spawn?.providerLaunchOutcome === "not-launched"
        )
        && current.request?.spawn?.providerLaunchInFlight !== true
        && !current.workerProcess?.pid
        && !current.providerProcess?.pid
      );
      // Fail closed for every active state, including the commit-before-launch
      // window. The provider launch hook observes this same nonce-bound marker.
      requestCancel(root, workerId, cancellationNonce(current), env);
      let processGroupGone = false;
      if (!brokerOnlyQueued) {
        if (typeof signalProcess === "function") {
          const signalOutcome = signalProcess(current);
          processGroupGone = signalOutcome === true || signalOutcome?.processGroupGone === true;
          if (processGroupGone) processGroupGoneAt = now();
        }
      }

      const mayCommitTerminal = brokerOnlyQueued || processGroupGone;
      if (mayCommitTerminal) terminalRecordCommittedAt = now();

      if (mayCommitTerminal) {
        const settledRequest = brokerOnlyQueued
          ? {
            ...current.request,
            spawn: {
              ...current.request?.spawn,
              providerLaunchPending: false,
              providerLaunchInFlight: false,
              providerLaunchOutcome: "not-launched",
              providerLaunchCompletedAt: terminalRecordCommittedAt
            }
          }
          : current.request;
        return {
          ...current,
          status: "cancelled",
          phase: "cancelled",
          summary: "Cancelled",
          progress: "Cancellation request accepted and terminal state confirmed.",
          completedAt: terminalRecordCommittedAt,
          request: settledRequest,
          lifecycleEvents: nextEvents,
          result: persistCancellation(current, {
            stopReason: "cancelled",
            ...(brokerOnlyQueued ? { taskRuntimeCleaned: true } : {})
          })
        };
      }

      return {
        ...current,
        phase: "cancellation-requested",
        summary: "Cancellation requested",
        progress: "Cancellation accepted; waiting for confirmed process-group exit.",
        lifecycleEvents: nextEvents,
        result: persistCancellation(current)
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
  return {
    receiptId: receipt.receiptId,
    workerId: receipt.workerId,
    status: receipt.status,
    requestAcceptedAt: receipt.requestAcceptedAt,
    processGroupGoneAt: receipt.processGroupGoneAt || null,
    terminalRecordCommittedAt: receipt.terminalRecordCommittedAt || null,
    idempotencyKeyDigest: receipt.idempotencyKeyDigest || null,
    cancellationRequestSequence: receipt.cancellationRequestSequence ?? null
  };
}

export function getSpawnIdempotencyRecord(root, key, env = process.env) {
  return readIdempotency(root, "spawn", key, env);
}
