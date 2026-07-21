/**
 * Phase 2 mailbox: durable send + lineage-preserving follow-up.
 *
 * Delivery states: accepted → pending → delivered | delivery_unknown | rejected
 * delivery_unknown is NEVER automatically retried.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CompanionError } from "./errors.mjs";
import {
  ensurePrivateStateDirectory,
  generateId,
  now,
  readPrivateJsonFile,
  writePrivateJsonFile,
  withWorkspaceStateTransaction
} from "./state.mjs";
import { appendLifecycleEvent } from "./task-contract.mjs";
import { projectWorkerHandle } from "./worker-protocol.mjs";
import { assertMutationOwnership } from "./worker-mutation.mjs";
import { resolveControlWorkspace } from "./workspace.mjs";

export const MAILBOX_SCHEMA_VERSION = 1;
export const MAX_MAILBOX_MESSAGE_LENGTH = 16000;
export const DELIVERY_STATES = Object.freeze([
  "accepted",
  "pending",
  "delivered",
  "delivery_unknown",
  "rejected"
]);

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function canonicalize(value, stack = new Set()) {
  if (value === null || typeof value !== "object") return value;
  if (stack.has(value)) {
    throw new CompanionError("E_USAGE", "Mailbox request must not contain cyclic data.");
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
  return digest(JSON.stringify(canonicalize(value)));
}

function idempotencyConflict(message) {
  throw new CompanionError("E_IDEMPOTENCY_CONFLICT", message);
}

function assertIdempotencyKey(key) {
  if (typeof key !== "string" || key.length < 8 || key.length > 256) {
    throw new CompanionError("E_USAGE", "idempotencyKey must be a string of length 8–256.");
  }
  return key;
}

function assertMessage(message) {
  if (typeof message !== "string" || !message.trim()) {
    throw new CompanionError("E_USAGE", "message must be a non-empty string.");
  }
  if (message.length > MAX_MAILBOX_MESSAGE_LENGTH) {
    throw new CompanionError(
      "E_USAGE",
      `message must not exceed ${MAX_MAILBOX_MESSAGE_LENGTH} characters.`
    );
  }
  return message;
}

function mailboxDir(root, env = process.env) {
  return ensurePrivateStateDirectory(root, "mailbox", env);
}

function messagePath(root, messageId, env = process.env) {
  return path.join(mailboxDir(root, env), `${messageId}.json`);
}

function writeMessage(root, record, env = process.env) {
  const file = messagePath(root, record.messageId, env);
  return writePrivateJsonFile(file, record);
}

function writePrivateJson(file, record) {
  return writePrivateJsonFile(file, record);
}

function readPrivateJson(file, label) {
  return readPrivateJsonFile(file, { missing: null, label });
}

function readMessage(root, messageId, env = process.env) {
  return readPrivateJsonFile(messagePath(root, messageId, env), {
    missing: null,
    label: "mailbox message"
  });
}

function findByIdempotency(root, keyDigest, env = process.env) {
  const dir = mailboxDir(root, env);
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith("msg-") || !name.endsWith(".json")) continue;
    const record = readPrivateJsonFile(path.join(dir, name), {
      missing: null,
      label: "mailbox idempotency record"
    });
    if (record?.idempotencyKeyDigest === keyDigest) {
      return record;
    }
  }
  return null;
}

function publicReceipt(record) {
  return Object.freeze({
    messageId: record.messageId,
    workerId: record.workerId,
    state: record.state,
    acceptedAt: record.acceptedAt,
    outcomeAt: record.outcomeAt || null,
    idempotencyKeyDigest: record.idempotencyKeyDigest,
    contentDigest: record.contentDigest,
    reason: record.reason || null
  });
}

function appendMailboxOutcome(transaction, workerId, record) {
  if (!transaction.tryReadJob(workerId)) return;
  transaction.updateJob(workerId, (current) => {
    const events = Array.isArray(current.lifecycleEvents) ? current.lifecycleEvents : [];
    const alreadyRecorded = events.some((event) => (
      event.type === "checkpoint"
      && event.detail?.messageId === record.messageId
      && event.detail?.state === record.state
    ));
    if (alreadyRecorded) return current;
    return {
      ...current,
      lifecycleEvents: appendLifecycleEvent(
        events,
        "checkpoint",
        `Mailbox message ${record.state}.`,
        {
          messageId: record.messageId,
          state: record.state,
          contentDigest: record.contentDigest
        }
      )
    };
  });
}

/**
 * ACP acknowledgement/dedup feasibility result (spike record).
 * Without proven provider ack/dedup, exactly-once is not claimed.
 */
export function acpDeliveryCapability({
  acknowledgement = false,
  dedupKey = false,
  safeBoundaryInjection = false
} = {}) {
  return Object.freeze({
    schemaVersion: 1,
    acknowledgement: Boolean(acknowledgement),
    dedupKey: Boolean(dedupKey),
    safeBoundaryInjection: Boolean(safeBoundaryInjection),
    exactlyOnceClaimable: Boolean(acknowledgement && dedupKey),
    note: acknowledgement && dedupKey
      ? "Exactly-once delivery may be claimed when both ack and dedup are proven."
      : "Durable acceptance plus explicit ambiguity only; delivery_unknown is never auto-retried."
  });
}

/**
 * Accept a message for an active worker. Delivery is separate and may end as delivery_unknown.
 */
export function sendWorkerMessage({
  root,
  principal,
  workerId,
  message,
  idempotencyKey,
  deliver = null,
  env = process.env
} = {}) {
  assertIdempotencyKey(idempotencyKey);
  if (!principal?.threadId) {
    throw new CompanionError("E_AUTH_REQUIRED", "Trusted Codex task identity is unavailable.");
  }
  assertMessage(message);
  if (typeof deliver === "function" && deliver.constructor?.name === "AsyncFunction") {
    throw new CompanionError(
      "E_CAPABILITY",
      "Asynchronous mailbox delivery adapters are unsupported by the synchronous broker API."
    );
  }
  // Privacy: reject obvious secret patterns in exported receipts (body stored privately).
  const contentDigest = digest(message);
  const keyDigest = digest(idempotencyKey);
  const mutationDigest = stableDigest({
    ownerThreadId: principal.threadId,
    workerId,
    message
  });
  // The public message id is workspace-key scoped, so a key cannot reserve two
  // different workers in separate processes.
  const messageId = `msg-${keyDigest.slice(0, 24)}`;

  return withWorkspaceStateTransaction(root, (transaction) => {
    const prior = readMessage(root, messageId, env) || findByIdempotency(root, keyDigest, env);
    if (prior) {
      if (
        prior.ownerThreadId !== principal.threadId
        || prior.workerId !== workerId
        || prior.requestDigest !== mutationDigest
        || prior.contentDigest !== contentDigest
      ) {
        idempotencyConflict("idempotencyKey was reused with a different mailbox owner or request.");
      }

      let replay = prior;
      if (prior.state === "accepted" || prior.state === "pending") {
        // A previous lock owner disappeared after durable reservation. Never
        // invoke delivery again because the provider outcome is unknowable.
        replay = writeMessage(root, {
          ...prior,
          state: "delivery_unknown",
          outcomeAt: now(),
          reason: "interrupted-delivery",
          _privateBody: undefined
        }, env);
      }
      // The mailbox record is the durable delivery authority. A crash may occur
      // after its terminal write but before the adjacent lifecycle append. Every
      // replay repairs that derived, deduplicated event without re-delivering.
      appendMailboxOutcome(transaction, workerId, replay);
      return { receipt: publicReceipt(replay), replayed: true };
    }

    const job = transaction.tryReadJob(workerId);
    if (!job) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    assertMutationOwnership(job, principal);

    const acceptedAt = now();
    const baseRecord = {
      schemaVersion: MAILBOX_SCHEMA_VERSION,
      messageId,
      workerId,
      ownerThreadId: principal.threadId,
      requestDigest: mutationDigest,
      state: "accepted",
      acceptedAt,
      outcomeAt: null,
      idempotencyKeyDigest: keyDigest,
      contentDigest,
      reason: null,
      senderAuthority: { threadId: principal.threadId, source: principal.source || null }
    };

    if (job.status !== "queued" && job.status !== "running") {
      const rejected = writeMessage(root, {
        ...baseRecord,
        state: "rejected",
        outcomeAt: now(),
        reason: "worker-not-active"
      }, env);
      appendMailboxOutcome(transaction, workerId, rejected);
      return { receipt: publicReceipt(rejected), replayed: false };
    }

    let record = writeMessage(root, {
      ...baseRecord,
      // Private body retained for the single delivery attempt only — never
      // exported on receipts.
      _privateBody: message
    }, env);
    record = writeMessage(root, { ...record, state: "pending" }, env);

    if (typeof deliver === "function") {
      try {
        const outcome = deliver({ message, job, messageId });
        if (outcome === "delivered") {
          record = writeMessage(root, {
            ...record,
            state: "delivered",
            outcomeAt: now(),
            _privateBody: undefined
          }, env);
        } else if (outcome === "rejected") {
          record = writeMessage(root, {
            ...record,
            state: "rejected",
            outcomeAt: now(),
            reason: "provider-rejected",
            _privateBody: undefined
          }, env);
        } else if (outcome && typeof outcome.then === "function") {
          // A non-async function can still return a thenable. The attempt has
          // already crossed the provider boundary, so record explicit
          // ambiguity, consume rejection, and never retry it automatically.
          Promise.resolve(outcome).catch(() => {});
          record = writeMessage(root, {
            ...record,
            state: "delivery_unknown",
            outcomeAt: now(),
            reason: "async-delivery-unsupported",
            _privateBody: undefined
          }, env);
        } else {
          record = writeMessage(root, {
            ...record,
            state: "delivery_unknown",
            outcomeAt: now(),
            reason: "provider-delivery-ambiguous",
            _privateBody: undefined
          }, env);
        }
      } catch {
        record = writeMessage(root, {
          ...record,
          state: "delivery_unknown",
          outcomeAt: now(),
          reason: "delivery-threw",
          _privateBody: undefined
        }, env);
      }
    } else {
      record = writeMessage(root, {
        ...record,
        state: "delivery_unknown",
        outcomeAt: now(),
        reason: "no-delivery-adapter",
        _privateBody: undefined
      }, env);
    }

    appendMailboxOutcome(transaction, workerId, record);
    return { receipt: publicReceipt(record), replayed: false };
  }, env);
}

/**
 * delivery_unknown must never be automatically retried.
 */
export function retryDelivery(root, messageId, env = process.env) {
  const record = readMessage(root, messageId, env);
  if (!record) throw new CompanionError("E_JOB_NOT_FOUND", "Message was not found.");
  if (record.state === "delivery_unknown") {
    throw new CompanionError(
      "E_DELIVERY",
      "delivery_unknown messages must not be automatically retried."
    );
  }
  if (record.state === "delivered" || record.state === "rejected") {
    throw new CompanionError("E_DELIVERY", `Message already terminal as ${record.state}.`);
  }
  return publicReceipt(record);
}

/**
 * Lineage-preserving follow-up for terminal/idle workers.
 */
export function followupWorker({
  root,
  principal,
  workerId,
  message,
  idempotencyKey,
  envelope = null,
  contextManifest = null,
  env = process.env
} = {}) {
  assertIdempotencyKey(idempotencyKey);
  if (!principal?.threadId) {
    throw new CompanionError("E_AUTH_REQUIRED", "Trusted Codex task identity is unavailable.");
  }
  assertMessage(message);
  const keyDigest = digest(idempotencyKey);
  const mutationDigest = stableDigest({
    ownerThreadId: principal.threadId,
    parentWorkerId: workerId,
    message,
    envelope,
    contextManifest
  });
  const idemFile = path.join(mailboxDir(root, env), `followup-${keyDigest}.json`);

  return withWorkspaceStateTransaction(root, (transaction) => {
    const prior = readPrivateJson(idemFile, "follow-up idempotency record");
    if (prior) {
      if (
        prior.ownerThreadId !== principal.threadId
        || prior.parentId !== workerId
        || prior.requestDigest !== mutationDigest
      ) {
        idempotencyConflict("idempotencyKey was reused with a different follow-up owner or request.");
      }
      const committed = transaction.tryReadJob(prior.workerId);
      if (!committed) {
        throw new CompanionError("E_STATE", "Follow-up idempotency record refers to a missing durable job.");
      }
      assertMutationOwnership(committed, principal);
      return { handle: projectWorkerHandle(committed), replayed: true };
    }

    // Recover a child commit whose adjacent idempotency publication was interrupted.
    const orphan = transaction.listJobs().find((candidate) => (
      candidate.request?.followup?.idempotencyKeyDigest === keyDigest
    ));
    if (orphan) {
      if (
        orphan.request?.followup?.ownerThreadId !== principal.threadId
        || orphan.request?.followup?.parentWorkerId !== workerId
        || orphan.request?.followup?.requestDigest !== mutationDigest
      ) {
        idempotencyConflict("idempotencyKey was reused with a different follow-up owner or request.");
      }
      assertMutationOwnership(orphan, principal);
      writePrivateJson(idemFile, {
        workerId: orphan.id,
        parentId: workerId,
        ownerThreadId: principal.threadId,
        requestDigest: mutationDigest,
        committedAt: orphan.createdAt || now()
      });
      return { handle: projectWorkerHandle(orphan), replayed: true };
    }

    const parent = transaction.tryReadJob(workerId);
    if (!parent) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    assertMutationOwnership(parent, principal);

    if (parent.status === "queued" || parent.status === "running") {
      throw new CompanionError(
        "E_JOB_ACTIVE",
        "followup requires a terminal or idle worker; use send for active workers."
      );
    }
    if (parent.write || envelope?.mode === "write") {
      throw new CompanionError(
        "E_CAPABILITY",
        "Write-worker follow-up requires the isolated write-spawn control path."
      );
    }

    // Context/profile drift rejection.
    const parentProfile = parent.profile?.agentProfileDigest || parent.role?.digest || null;
    if (envelope?.profileDigest && parentProfile && envelope.profileDigest !== parentProfile) {
      throw new CompanionError("E_CONTEXT_DRIFT", "Follow-up profile digest does not match parent.");
    }
    const parentContext = parent.request?.contextManifest?.digest || null;
    if (contextManifest?.digest && parentContext && contextManifest.digest !== parentContext) {
      // Allow explicit new context only when envelope declares supersession.
      if (envelope?.contextSupersession !== true) {
        throw new CompanionError("E_CONTEXT_DRIFT", "Follow-up context digest drifted from parent.");
      }
    }

    let controlWorkspaceId = parent.controlWorkspaceId || null;
    if (!controlWorkspaceId) {
      try { controlWorkspaceId = resolveControlWorkspace(root, env).controlWorkspaceId; }
      catch { controlWorkspaceId = null; }
    }

    const id = generateId("task");
    const createdAt = now();
    const child = {
      schemaVersion: 3,
      id,
      kind: "task",
      jobClass: "task",
      write: false,
      status: "queued",
      phase: "accepted",
      summary: "Follow-up committed",
      progress: "Lineage-preserving follow-up spawn committed.",
      createdAt,
      updatedAt: createdAt,
      host: { kind: "codex", sessionId: principal.threadId },
      controlWorkspaceId,
      profile: parent.profile || null,
      role: parent.role || null,
      request: {
        envelope: envelope || {
          schemaVersion: 1,
          userRequest: message,
          objective: message,
          mode: "read",
          digest: digest(message)
        },
        contextManifest: contextManifest || parent.request?.contextManifest || null,
        resumeJobId: parent.id,
        providerHomeId: parent.request?.providerHomeId || parent.id,
        publicObjective: message,
        // Follow-up admission is also a commit-before-launch boundary. The
        // shared reconciler/recovery/cancellation logic must not mistake the
        // absence of a process here for a lost worker.
        spawn: {
          providerLaunchPending: true
        },
        followup: {
          parentWorkerId: parent.id,
          ownerThreadId: principal.threadId,
          requestDigest: mutationDigest,
          idempotencyKeyDigest: keyDigest
        }
      },
      lifecycleEvents: appendLifecycleEvent(
        [],
        "task.accepted",
        "Follow-up worker committed with parent lineage.",
        { parentWorkerId: parent.id }
      ),
      result: null,
      error: null,
      workerAuthorization: { nonce: crypto.randomBytes(16).toString("hex") }
    };

    const committed = transaction.admitJob(child);
    writePrivateJson(idemFile, {
      workerId: committed.id,
      parentId: parent.id,
      ownerThreadId: principal.threadId,
      requestDigest: mutationDigest,
      committedAt: createdAt
    });
    return { handle: projectWorkerHandle(committed), replayed: false };
  }, env);
}

export function listMailboxMessages(root, workerId, env = process.env) {
  const dir = mailboxDir(root, env);
  return fs.readdirSync(dir)
    .filter((name) => name.startsWith("msg-") && name.endsWith(".json"))
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      } catch {
        return null;
      }
    })
    .filter((record) => record && record.workerId === workerId)
    .map((record) => publicReceipt(record));
}

export { readMessage, publicReceipt };
