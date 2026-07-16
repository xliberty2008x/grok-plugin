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
import { sameHostSession } from "./host.mjs";
import {
  admitJob,
  generateId,
  now,
  tryReadJob,
  updateJob
} from "./state.mjs";
import { appendLifecycleEvent } from "./task-contract.mjs";
import { projectWorkerHandle } from "./worker-protocol.mjs";
import { assertMutationOwnership } from "./worker-mutation.mjs";
import { workspaceState } from "./workspace.mjs";

export const MAILBOX_SCHEMA_VERSION = 1;
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

function assertIdempotencyKey(key) {
  if (typeof key !== "string" || key.length < 8 || key.length > 256) {
    throw new CompanionError("E_USAGE", "idempotencyKey must be a string of length 8–256.");
  }
  return key;
}

function mailboxDir(root, env = process.env) {
  const base = workspaceState(root, env);
  const dir = path.join(base, "mailbox");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function messagePath(root, messageId, env = process.env) {
  return path.join(mailboxDir(root, env), `${messageId}.json`);
}

function writeMessage(root, record, env = process.env) {
  const file = messagePath(root, record.messageId, env);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return record;
}

function readMessage(root, messageId, env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(messagePath(root, messageId, env), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new CompanionError("E_STATE", "Could not read mailbox message.");
  }
}

function findByIdempotency(root, workerId, keyDigest, env = process.env) {
  const dir = mailboxDir(root, env);
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (record.workerId === workerId && record.idempotencyKeyDigest === keyDigest) {
        return record;
      }
    } catch {
      /* skip */
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
  if (typeof message !== "string" || !message.trim()) {
    throw new CompanionError("E_USAGE", "message must be a non-empty string.");
  }
  // Privacy: reject obvious secret patterns in exported receipts (body stored privately).
  const contentDigest = digest(message);
  const keyDigest = digest(idempotencyKey);

  const prior = findByIdempotency(root, workerId, keyDigest, env);
  if (prior) {
    return { receipt: publicReceipt(prior), replayed: true };
  }

  const job = tryReadJob(root, workerId, env);
  if (!job) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
  assertMutationOwnership(job, principal);

  if (job.status !== "queued" && job.status !== "running") {
    const messageId = `msg-${digest(`${workerId}:${keyDigest}`).slice(0, 24)}`;
    const rejected = writeMessage(root, {
      schemaVersion: MAILBOX_SCHEMA_VERSION,
      messageId,
      workerId,
      state: "rejected",
      acceptedAt: now(),
      outcomeAt: now(),
      idempotencyKeyDigest: keyDigest,
      contentDigest,
      reason: "worker-not-active",
      senderAuthority: { threadId: principal.threadId, source: principal.source || null }
    }, env);
    return { receipt: publicReceipt(rejected), replayed: false };
  }

  const messageId = `msg-${digest(`${workerId}:${keyDigest}`).slice(0, 24)}`;
  const acceptedAt = now();
  let record = writeMessage(root, {
    schemaVersion: MAILBOX_SCHEMA_VERSION,
    messageId,
    workerId,
    state: "accepted",
    acceptedAt,
    outcomeAt: null,
    idempotencyKeyDigest: keyDigest,
    contentDigest,
    reason: null,
    senderAuthority: { threadId: principal.threadId, source: principal.source || null },
    // Private body retained for delivery attempts only — never exported on receipts.
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
      } else {
        // Crash ambiguity or unknown outcome
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
    // No delivery adapter: durable acceptance without claiming delivery.
    record = writeMessage(root, {
      ...record,
      state: "delivery_unknown",
      outcomeAt: now(),
      reason: "no-delivery-adapter",
      _privateBody: undefined
    }, env);
  }

  updateJob(root, workerId, (current) => ({
    ...current,
    lifecycleEvents: appendLifecycleEvent(
      current.lifecycleEvents || [],
      "checkpoint",
      `Mailbox message ${record.state}.`,
      { messageId, state: record.state, contentDigest }
    )
  }), env);

  return { receipt: publicReceipt(record), replayed: false };
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
  if (typeof message !== "string" || !message.trim()) {
    throw new CompanionError("E_USAGE", "message must be a non-empty string.");
  }

  const parent = tryReadJob(root, workerId, env);
  if (!parent) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
  assertMutationOwnership(parent, principal);

  if (parent.status === "queued" || parent.status === "running") {
    throw new CompanionError(
      "E_JOB_ACTIVE",
      "followup requires a terminal or idle worker; use send for active workers."
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

  const keyDigest = digest(idempotencyKey);
  const idemFile = path.join(mailboxDir(root, env), `followup-${keyDigest}.json`);
  if (fs.existsSync(idemFile)) {
    const prior = JSON.parse(fs.readFileSync(idemFile, "utf8"));
    const job = tryReadJob(root, prior.workerId, env);
    return {
      handle: job ? projectWorkerHandle(job) : { id: prior.workerId },
      replayed: true
    };
  }

  const id = generateId("task");
  const createdAt = now();
  const child = {
    schemaVersion: 3,
    id,
    kind: "task",
    jobClass: "task",
    write: Boolean(parent.write),
    status: "queued",
    phase: "accepted",
    summary: "Follow-up committed",
    progress: "Lineage-preserving follow-up spawn committed.",
    createdAt,
    updatedAt: createdAt,
    host: { kind: "codex", sessionId: principal.threadId },
    profile: parent.profile || null,
    role: parent.role || null,
    request: {
      envelope: envelope || {
        schemaVersion: 1,
        userRequest: message,
        objective: message,
        mode: parent.write ? "write" : "read",
        digest: digest(message)
      },
      contextManifest: contextManifest || parent.request?.contextManifest || null,
      resumeJobId: parent.id,
      providerHomeId: parent.request?.providerHomeId || parent.id,
      publicObjective: message,
      followup: {
        parentWorkerId: parent.id,
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

  // admitJob already holds the workspace-admission lock.
  const committed = admitJob(root, child, env);
  fs.writeFileSync(idemFile, `${JSON.stringify({ workerId: committed.id, parentId: parent.id })}\n`, {
    mode: 0o600
  });
  return { handle: projectWorkerHandle(committed), replayed: false };
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
