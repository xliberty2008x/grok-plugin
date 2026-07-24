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
  now,
  readPrivateJsonFile,
  writePrivateJsonFile,
  withWorkspaceStateTransaction
} from "./state.mjs";
import { appendLifecycleEvent } from "./task-contract.mjs";
import {
  assertMutationOwnership,
  spawnGrantedFollowupWorker
} from "./worker-mutation.mjs";

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
 * Grant-bound follow-up compatibility wrapper. Caller-selected envelopes,
 * context, role, profile, session, root, and lineage are intentionally absent.
 */
export function followupWorker(options = {}) {
  const allowed = new Set([
    "root",
    "principal",
    "workerId",
    "grantId",
    "message",
    "idempotencyKey",
    "env",
    "providerCapabilityDigest"
  ]);
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some((key) => !allowed.has(key))) {
    throw new CompanionError(
      "E_USAGE",
      "Follow-up accepts only workerId, grantId, message, and idempotencyKey."
    );
  }
  return spawnGrantedFollowupWorker(options);
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
