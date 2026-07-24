/**
 * P2.4 attempt-bound mailbox sidecar and body-free ordered communication chain.
 *
 * Sidecar states: preparing -> open -> closing -> closed
 * Message states: accepted(body) -> claimed(body) -> inflight(body-free, exact numeric RPC id)
 *                 -> delivered | delivery_unknown; accepted/claimed may become rejected.
 * Public projection maps claimed/inflight to pending. delivery_unknown is never retried.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CompanionError } from "./errors.mjs";
import {
  ensurePrivateStateDirectory,
  now,
  readPrivateJsonFile,
  writePrivateJsonFile
} from "./state.mjs";

export const MAILBOX_ATTEMPT_SCHEMA_VERSION = 1;
export const MAILBOX_MESSAGE_SCHEMA_VERSION = 1;
export const COMMUNICATION_CHAIN_SCHEMA_VERSION = 1;
export const MAX_MAILBOX_MESSAGE_LENGTH = 16000;
export const MAX_MAILBOX_ACCEPTED_MESSAGES = 32;
export const MAX_MAILBOX_ACCEPTED_BYTES = 256 * 1024;
export const MAILBOX_CAPABILITY = "ordered-turn-boundary-mailbox-v1";

export const MAILBOX_ATTEMPT_STATES = Object.freeze([
  "preparing",
  "open",
  "closing",
  "closed"
]);

export const MAILBOX_MESSAGE_STATES = Object.freeze([
  "accepted",
  "claimed",
  "inflight",
  "delivered",
  "delivery_unknown",
  "rejected"
]);

export const PUBLIC_MAILBOX_STATES = Object.freeze([
  "accepted",
  "pending",
  "delivered",
  "delivery_unknown",
  "rejected"
]);

const SHA256_HEX = /^[a-f0-9]{64}$/;
const ATTEMPT_ID = /^[a-f0-9]{32}$/;
const MESSAGE_ID = /^msg-[a-f0-9]{24}$/;
const ACTIVE_MESSAGE_STATES = new Set(["accepted", "claimed", "inflight"]);
const TERMINAL_MESSAGE_STATES = new Set(["delivered", "delivery_unknown", "rejected"]);
const BODY_RETAINING_STATES = new Set(["accepted", "claimed"]);

const ATTEMPT_KEYS = new Set([
  "schemaVersion",
  "state",
  "workerId",
  "dispatchAttemptId",
  "dispatchFence",
  "workerProcessDigest",
  "providerProcessDigest",
  "providerGeneration",
  "providerSessionDigest",
  "providerCapabilityDigest",
  "pumpOwnerDigest",
  "contextReceiptDigest",
  "rolePolicyDigest",
  "nextSequence",
  "acceptedCount",
  "acceptedBytes",
  "communicationChainDigest",
  "primaryTurnEvidence",
  "lastCompletedSequence",
  "lastCompletedTurnDigest",
  "finalReportSequence",
  "finalReportDigest",
  "deliveryUnknownSequence",
  "activeSequence",
  "openedAt",
  "closedAt",
  "closeReason",
  "attemptDigest"
]);

const MESSAGE_KEYS_BASE = new Set([
  "schemaVersion",
  "messageId",
  "workerId",
  "dispatchAttemptId",
  "dispatchFence",
  "sequence",
  "state",
  "acceptedAt",
  "outcomeAt",
  "idempotencyKeyDigest",
  "contentDigest",
  "contentBytes",
  "ownerThreadId",
  "requestDigest",
  "reason",
  "rpcRequestId",
  "composedPromptDigest",
  "turnDigest",
  "turnEvidence",
  "messageDigest"
]);
const TURN_EVIDENCE_KEYS = new Set([
  "schemaVersion",
  "kind",
  "previousDigest",
  "contextReceiptDigest",
  "rolePolicyDigest",
  "dispatchAttemptId",
  "dispatchFence",
  "workerProcessDigest",
  "providerGeneration",
  "providerProcessDigest",
  "providerSessionDigest",
  "providerCapabilityDigest",
  "sequence",
  "contentDigest",
  "composedPromptDigest",
  "outcome",
  "messageId",
  "rpcRequestId",
  "turnDigest"
]);

function stateError(message) {
  throw new CompanionError("E_STATE", message);
}

function usageError(message) {
  throw new CompanionError("E_USAGE", message);
}

function deliveryError(message) {
  throw new CompanionError("E_DELIVERY", message);
}

function assertPumpOwner(attempt, pumpOwnerDigest) {
  if (!SHA256_HEX.test(pumpOwnerDigest || "")
    || attempt?.pumpOwnerDigest !== pumpOwnerDigest) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Mailbox pump ownership changed.");
  }
}

export function canonicalize(value, stack = new Set()) {
  if (value === null || typeof value !== "object") return value;
  if (stack.has(value)) stateError("Mailbox state must not contain cyclic data.");
  stack.add(value);
  let normalized;
  if (Array.isArray(value)) {
    normalized = value.map((entry) => canonicalize(entry, stack));
  } else {
    normalized = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) normalized[key] = canonicalize(value[key], stack);
    }
  }
  stack.delete(value);
  return normalized;
}

export function stableDigest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function contentDigestOf(message) {
  return crypto.createHash("sha256").update(String(message), "utf8").digest("hex");
}

export function utf8ByteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

function exactKeys(value, keys) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key))
  );
}

function validIsoTimestamp(value) {
  if (typeof value !== "string" || !value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validTurnEvidence(entry) {
  return Boolean(
    exactKeys(entry, TURN_EVIDENCE_KEYS)
    && entry.schemaVersion === COMMUNICATION_CHAIN_SCHEMA_VERSION
    && entry.kind === "mailbox-chain-turn"
    && SHA256_HEX.test(entry.turnDigest || "")
    && communicationChainEntry(entry).turnDigest === entry.turnDigest
  );
}

function assertSafeWorkerId(workerId) {
  if (typeof workerId !== "string"
    || !/^(?:review|adversarial-review|task|stop-review)-[a-f0-9]{16,64}$/.test(workerId)) {
    usageError("workerId is invalid.");
  }
  return workerId;
}

function mailboxRoot(root, env = process.env) {
  return ensurePrivateStateDirectory(root, "mailbox", env);
}

function attemptDir(root, workerId, attemptId, env = process.env) {
  assertSafeWorkerId(workerId);
  if (!ATTEMPT_ID.test(attemptId)) stateError("Mailbox attempt identity is malformed.");
  return ensurePrivateStateDirectory(
    root,
    ["mailbox", "attempts", `${workerId}-${attemptId}`],
    env
  );
}

function attemptPath(root, workerId, attemptId, env = process.env) {
  return path.join(attemptDir(root, workerId, attemptId, env), "attempt.json");
}

function messagePath(root, workerId, attemptId, messageId, env = process.env) {
  if (!MESSAGE_ID.test(messageId)) stateError("Mailbox message identity is malformed.");
  return path.join(attemptDir(root, workerId, attemptId, env), `${messageId}.json`);
}

function indexPath(root, env = process.env) {
  return path.join(mailboxRoot(root, env), "open-index.json");
}

function attemptDigestBody(record) {
  const { attemptDigest: _attemptDigest, ...body } = record;
  return body;
}

function messageDigestBody(record) {
  const { messageDigest: _messageDigest, _privateBody: _body, ...body } = record;
  return body;
}

export function publicMailboxState(state) {
  if (state === "claimed" || state === "inflight") return "pending";
  return state;
}

export function publicMessageReceipt(record) {
  if (!record) return null;
  return Object.freeze({
    messageId: record.messageId,
    workerId: record.workerId,
    state: publicMailboxState(record.state),
    sequence: record.sequence,
    acceptedAt: record.acceptedAt,
    outcomeAt: record.outcomeAt || null,
    reason: record.reason || null
  });
}

function assertAttemptShape(record) {
  if (!exactKeys(record, ATTEMPT_KEYS)
    || record.schemaVersion !== MAILBOX_ATTEMPT_SCHEMA_VERSION
    || !MAILBOX_ATTEMPT_STATES.includes(record.state)
    || typeof record.workerId !== "string"
    || !ATTEMPT_ID.test(record.dispatchAttemptId || "")
    || !Number.isSafeInteger(record.dispatchFence)
    || record.dispatchFence < 1
    || !SHA256_HEX.test(record.workerProcessDigest || "")
    || !SHA256_HEX.test(record.providerProcessDigest || "")
    || record.providerGeneration !== 1
    || !SHA256_HEX.test(record.providerSessionDigest || "")
    || !(record.providerCapabilityDigest === null || SHA256_HEX.test(record.providerCapabilityDigest || ""))
    || !SHA256_HEX.test(record.pumpOwnerDigest || "")
    || !SHA256_HEX.test(record.contextReceiptDigest || "")
    || !SHA256_HEX.test(record.rolePolicyDigest || "")
    || !Number.isSafeInteger(record.nextSequence)
    || record.nextSequence < 1
    || !Number.isSafeInteger(record.acceptedCount)
    || record.acceptedCount < 0
    || record.acceptedCount > MAX_MAILBOX_ACCEPTED_MESSAGES
    || !Number.isSafeInteger(record.acceptedBytes)
    || record.acceptedBytes < 0
    || record.acceptedBytes > MAX_MAILBOX_ACCEPTED_BYTES
    || !SHA256_HEX.test(record.communicationChainDigest || "")
    || !(record.primaryTurnEvidence === null || validTurnEvidence(record.primaryTurnEvidence))
    || !(record.lastCompletedSequence === null || (
      Number.isSafeInteger(record.lastCompletedSequence) && record.lastCompletedSequence >= 0
    ))
    || !(record.lastCompletedTurnDigest === null || SHA256_HEX.test(record.lastCompletedTurnDigest || ""))
    || ((record.lastCompletedSequence === null) !== (record.lastCompletedTurnDigest === null))
    || !(record.finalReportSequence === null || (
      Number.isSafeInteger(record.finalReportSequence) && record.finalReportSequence >= 0
    ))
    || !(record.finalReportDigest === null || SHA256_HEX.test(record.finalReportDigest || ""))
    || ((record.finalReportSequence === null) !== (record.finalReportDigest === null))
    || !(record.deliveryUnknownSequence === null || (
      Number.isSafeInteger(record.deliveryUnknownSequence) && record.deliveryUnknownSequence >= 1
    ))
    || !(record.activeSequence === null || (
      Number.isSafeInteger(record.activeSequence) && record.activeSequence >= 1
    ))
    || !validIsoTimestamp(record.openedAt)
    || !(record.closedAt === null || validIsoTimestamp(record.closedAt))
    || !(record.closeReason === null || typeof record.closeReason === "string")
    || !SHA256_HEX.test(record.attemptDigest || "")
    || record.attemptDigest !== stableDigest(attemptDigestBody(record))) {
    stateError("Mailbox attempt state is malformed or tampered.");
  }
  if (record.finalReportSequence !== null
    && record.finalReportSequence !== record.lastCompletedSequence) {
    stateError("Mailbox final report is not bound to the last completed turn.");
  }
  const genesis = genesisCommunicationChainDigest(record);
  if (record.primaryTurnEvidence === null) {
    if (record.lastCompletedSequence !== null
      || record.communicationChainDigest !== genesis
      || record.finalReportSequence !== null) {
      stateError("Mailbox aggregate state exists without primary turn evidence.");
    }
  } else {
    const primary = verifyChainExtension({
      ...record,
      communicationChainDigest: genesis
    }, record.primaryTurnEvidence);
    if (primary.sequence !== 0
      || primary.outcome !== "delivered"
      || primary.messageId !== null
      || primary.rpcRequestId !== null
      || record.lastCompletedSequence === null
      || (record.lastCompletedSequence === 0 && (
        record.communicationChainDigest !== primary.turnDigest
        || record.lastCompletedTurnDigest !== primary.turnDigest
      ))) {
      stateError("Mailbox primary turn evidence is inconsistent.");
    }
  }
  if ((record.state === "preparing" || record.state === "open")
    && (record.closedAt !== null || record.closeReason !== null)) {
    stateError("Open mailbox state contains closure evidence.");
  }
  if ((record.state === "closing" || record.state === "closed")
    && (typeof record.closeReason !== "string" || !record.closeReason)) {
    stateError("Closing mailbox state requires a close reason.");
  }
  if (record.state === "closed" && record.closedAt === null) {
    stateError("Closed mailbox state requires a closed timestamp.");
  }
  if (record.state !== "closed" && record.closedAt !== null) {
    stateError("Non-closed mailbox state contains a closed timestamp.");
  }
  if (record.state !== "closed" && record.finalReportSequence !== null) {
    stateError("Final report selection requires a closed mailbox.");
  }
  if (record.activeSequence !== null && record.activeSequence >= record.nextSequence) {
    stateError("Mailbox active sequence is outside the accepted sequence range.");
  }
  return record;
}

function assertMessageShape(record, { allowBody = false } = {}) {
  const keys = new Set(MESSAGE_KEYS_BASE);
  if (allowBody && Object.hasOwn(record || {}, "_privateBody")) keys.add("_privateBody");
  if (!exactKeys(record, keys)
    || record.schemaVersion !== MAILBOX_MESSAGE_SCHEMA_VERSION
    || !MESSAGE_ID.test(record.messageId || "")
    || typeof record.workerId !== "string"
    || !ATTEMPT_ID.test(record.dispatchAttemptId || "")
    || !Number.isSafeInteger(record.dispatchFence)
    || record.dispatchFence < 1
    || !Number.isSafeInteger(record.sequence)
    || record.sequence < 0
    || (record.sequence === 0 && record.state !== "rejected")
    || !MAILBOX_MESSAGE_STATES.includes(record.state)
    || !validIsoTimestamp(record.acceptedAt)
    || !(record.outcomeAt === null || validIsoTimestamp(record.outcomeAt))
    || !SHA256_HEX.test(record.idempotencyKeyDigest || "")
    || !SHA256_HEX.test(record.contentDigest || "")
    || !Number.isSafeInteger(record.contentBytes)
    || record.contentBytes < 0
    || record.contentBytes > MAX_MAILBOX_ACCEPTED_BYTES
    || typeof record.ownerThreadId !== "string"
    || !record.ownerThreadId
    || !SHA256_HEX.test(record.requestDigest || "")
    || !(record.reason === null || typeof record.reason === "string")
    || !(record.rpcRequestId === null || (
      Number.isSafeInteger(record.rpcRequestId) && record.rpcRequestId >= 1
    ))
    || !(record.composedPromptDigest === null || SHA256_HEX.test(record.composedPromptDigest || ""))
    || !(record.turnDigest === null || SHA256_HEX.test(record.turnDigest || ""))
    || !(record.turnEvidence === null || validTurnEvidence(record.turnEvidence))
    || !SHA256_HEX.test(record.messageDigest || "")
    || record.messageDigest !== stableDigest(messageDigestBody(record))) {
    stateError("Mailbox message state is malformed or tampered.");
  }
  if (BODY_RETAINING_STATES.has(record.state)) {
    if (typeof record._privateBody !== "string" || !record._privateBody) {
      stateError("Mailbox message body is missing for a body-retaining state.");
    }
    if (contentDigestOf(record._privateBody) !== record.contentDigest) {
      stateError("Mailbox message body digest mismatch.");
    }
  } else if (Object.hasOwn(record, "_privateBody")) {
    stateError("Mailbox terminal or inflight message must not retain a body.");
  }
  if (record.state === "inflight" && !Number.isSafeInteger(record.rpcRequestId)) {
    stateError("Inflight mailbox message requires an exact numeric RPC id.");
  }
  if (record.state === "delivered" || record.state === "delivery_unknown") {
    if (!record.turnEvidence || record.turnDigest !== record.turnEvidence.turnDigest) {
      stateError("Terminal mailbox delivery state requires complete turn evidence.");
    }
  } else if (record.turnEvidence !== null || record.turnDigest !== null) {
    stateError("Non-delivery mailbox state must not retain turn evidence.");
  }
  return record;
}

export function readAttemptMailbox(root, workerId, attemptId, env = process.env) {
  const file = attemptPath(root, workerId, attemptId, env);
  const record = readPrivateJsonFile(file, {
    missing: null,
    maxBytes: 64 * 1024,
    label: "mailbox attempt"
  });
  if (!record) return null;
  return assertAttemptShape(record);
}

export function readMailboxMessage(root, workerId, attemptId, messageId, env = process.env) {
  const file = messagePath(root, workerId, attemptId, messageId, env);
  const record = readPrivateJsonFile(file, {
    missing: null,
    maxBytes: 512 * 1024,
    label: "mailbox message"
  });
  if (!record) return null;
  return assertMessageShape(record, { allowBody: true });
}

function writeAttempt(root, record, env = process.env) {
  const body = {
    ...record,
    attemptDigest: undefined
  };
  delete body.attemptDigest;
  const sealed = {
    ...body,
    attemptDigest: stableDigest(body)
  };
  assertAttemptShape(sealed);
  writePrivateJsonFile(attemptPath(root, sealed.workerId, sealed.dispatchAttemptId, env), sealed);
  return sealed;
}

function writeMessage(root, record, env = process.env) {
  const body = { ...record };
  delete body.messageDigest;
  const sealed = {
    ...body,
    messageDigest: stableDigest(messageDigestBody(body))
  };
  assertMessageShape(sealed, { allowBody: true });
  writePrivateJsonFile(
    messagePath(root, sealed.workerId, sealed.dispatchAttemptId, sealed.messageId, env),
    sealed
  );
  return sealed;
}

function listMessageFiles(root, workerId, attemptId, env = process.env) {
  const dir = attemptDir(root, workerId, attemptId, env);
  return fs.readdirSync(dir)
    .filter((name) => name.startsWith("msg-") && name.endsWith(".json"))
    .sort();
}

export function listAttemptMessages(root, workerId, attemptId, env = process.env) {
  return listMessageFiles(root, workerId, attemptId, env)
    .map((name) => readMailboxMessage(root, workerId, attemptId, name.slice(0, -5), env))
    .sort((left, right) => left.sequence - right.sequence);
}

export function findWorkerMessage(root, workerId, {
  messageId,
  idempotencyKeyDigest
} = {}, env = process.env) {
  assertSafeWorkerId(workerId);
  if (!MESSAGE_ID.test(messageId || "") || !SHA256_HEX.test(idempotencyKeyDigest || "")) {
    stateError("Mailbox replay identity is malformed.");
  }
  const attemptsRoot = path.join(mailboxRoot(root, env), "attempts");
  if (!fs.existsSync(attemptsRoot)) return null;
  for (const dirName of fs.readdirSync(attemptsRoot).sort()) {
    if (!dirName.startsWith(`${workerId}-`)) continue;
    const attemptId = dirName.slice(workerId.length + 1);
    if (!ATTEMPT_ID.test(attemptId)) continue;
    const direct = readMailboxMessage(root, workerId, attemptId, messageId, env);
    if (direct) return direct;
    const byKey = findByIdempotency(
      root,
      workerId,
      attemptId,
      idempotencyKeyDigest,
      env
    );
    if (byKey) return byKey;
  }
  return null;
}

function readOpenIndex(root, env = process.env) {
  const index = readPrivateJsonFile(indexPath(root, env), {
    missing: { schemaVersion: 1, entries: {} },
    maxBytes: 256 * 1024,
    label: "mailbox open index"
  });
  if (!exactKeys(index, new Set(["schemaVersion", "entries"]))
    || index.schemaVersion !== 1
    || !index.entries
    || typeof index.entries !== "object"
    || Array.isArray(index.entries)) {
    stateError("Mailbox open index is malformed.");
  }
  for (const [workerId, entry] of Object.entries(index.entries)) {
    assertSafeWorkerId(workerId);
    if (!exactKeys(entry, new Set([
      "dispatchAttemptId",
      "dispatchFence",
      "providerGeneration"
    ]))
      || !ATTEMPT_ID.test(entry.dispatchAttemptId || "")
      || !Number.isSafeInteger(entry.dispatchFence)
      || entry.dispatchFence < 1
      || entry.providerGeneration !== 1) {
      stateError("Mailbox open index entry is malformed.");
    }
  }
  return index;
}

function writeOpenIndex(root, index, env = process.env) {
  writePrivateJsonFile(indexPath(root, env), {
    schemaVersion: 1,
    entries: index.entries || {}
  });
}

export function genesisCommunicationChainDigest({
  contextReceiptDigest,
  rolePolicyDigest,
  dispatchAttemptId,
  dispatchFence,
  workerProcessDigest,
  providerGeneration,
  providerProcessDigest,
  providerSessionDigest,
  providerCapabilityDigest
}) {
  return stableDigest({
    schemaVersion: COMMUNICATION_CHAIN_SCHEMA_VERSION,
    kind: "mailbox-chain-genesis",
    contextReceiptDigest,
    rolePolicyDigest,
    dispatchAttemptId,
    dispatchFence,
    workerProcessDigest,
    providerGeneration,
    providerProcessDigest,
    providerSessionDigest,
    providerCapabilityDigest
  });
}

export function communicationChainEntry({
  previousDigest,
  contextReceiptDigest,
  rolePolicyDigest,
  dispatchAttemptId,
  dispatchFence,
  workerProcessDigest,
  providerGeneration,
  providerProcessDigest,
  providerSessionDigest,
  providerCapabilityDigest,
  sequence,
  contentDigest,
  composedPromptDigest,
  outcome,
  messageId = null,
  rpcRequestId = null
}) {
  const body = {
    schemaVersion: COMMUNICATION_CHAIN_SCHEMA_VERSION,
    kind: "mailbox-chain-turn",
    previousDigest,
    contextReceiptDigest,
    rolePolicyDigest,
    dispatchAttemptId,
    dispatchFence,
    workerProcessDigest,
    providerGeneration,
    providerProcessDigest,
    providerSessionDigest,
    providerCapabilityDigest,
    sequence,
    contentDigest,
    composedPromptDigest,
    outcome,
    messageId,
    rpcRequestId
  };
  return Object.freeze({
    ...body,
    turnDigest: stableDigest(body)
  });
}

export function verifyChainExtension(attempt, entry) {
  if (!attempt || !entry) stateError("Communication chain entry is incomplete.");
  if (entry.previousDigest !== attempt.communicationChainDigest) {
    stateError("Communication chain previous digest mismatch.");
  }
  if (entry.contextReceiptDigest !== attempt.contextReceiptDigest
    || entry.rolePolicyDigest !== attempt.rolePolicyDigest
    || entry.dispatchAttemptId !== attempt.dispatchAttemptId
    || entry.dispatchFence !== attempt.dispatchFence
    || entry.workerProcessDigest !== attempt.workerProcessDigest
    || entry.providerGeneration !== attempt.providerGeneration
    || entry.providerProcessDigest !== attempt.providerProcessDigest
    || entry.providerSessionDigest !== attempt.providerSessionDigest
    || entry.providerCapabilityDigest !== attempt.providerCapabilityDigest) {
    stateError("Communication chain binding drifted.");
  }
  const expected = communicationChainEntry(entry);
  if (entry.turnDigest !== expected.turnDigest) {
    stateError("Communication chain turn digest mismatch.");
  }
  return expected;
}

/**
 * Create or resume the attempt-bound mailbox sidecar in preparing, then open.
 * Must be called under a workspace transaction by the caller.
 */
export function openAttemptMailbox(root, binding, env = process.env) {
  const {
    workerId,
    dispatchAttemptId,
    dispatchFence,
    workerProcessDigest,
    providerProcessDigest,
    providerGeneration,
    providerSessionDigest,
    providerCapabilityDigest = null,
    contextReceiptDigest,
    rolePolicyDigest
  } = binding || {};
  assertSafeWorkerId(workerId);
  if (!ATTEMPT_ID.test(dispatchAttemptId || "")
    || !Number.isSafeInteger(dispatchFence)
    || dispatchFence < 1
    || !SHA256_HEX.test(workerProcessDigest || "")
    || !SHA256_HEX.test(providerProcessDigest || "")
    || providerGeneration !== 1
    || !SHA256_HEX.test(providerSessionDigest || "")
    || !(providerCapabilityDigest === null || SHA256_HEX.test(providerCapabilityDigest || ""))
    || !SHA256_HEX.test(contextReceiptDigest || "")
    || !SHA256_HEX.test(rolePolicyDigest || "")) {
    stateError("Mailbox open binding is incomplete or malformed.");
  }

  const existing = readAttemptMailbox(root, workerId, dispatchAttemptId, env);
  if (existing) {
    if (existing.state === "closed") {
      deliveryError("Mailbox is closed for this provider attempt.");
    }
    if (existing.workerProcessDigest !== workerProcessDigest
      || existing.providerProcessDigest !== providerProcessDigest
      || existing.providerGeneration !== providerGeneration
      || existing.providerSessionDigest !== providerSessionDigest
      || existing.providerCapabilityDigest !== providerCapabilityDigest
      || existing.contextReceiptDigest !== contextReceiptDigest
      || existing.rolePolicyDigest !== rolePolicyDigest
      || existing.dispatchFence !== dispatchFence) {
      stateError("Mailbox attempt binding conflict.");
    }
    if (existing.state === "open") {
      publishOpenIndex(root, existing, env);
      return existing;
    }
    if (existing.state === "preparing") {
      const opened = writeAttempt(root, {
        ...existing,
        state: "open",
        openedAt: existing.openedAt || now()
      }, env);
      publishOpenIndex(root, opened, env);
      return opened;
    }
    deliveryError(`Mailbox cannot reopen from state ${existing.state}.`);
  }

  const openedAt = now();
  const pumpOwnerDigest = stableDigest({
    workerId,
    dispatchAttemptId,
    dispatchFence,
    workerProcessDigest,
    providerProcessDigest,
    providerGeneration,
    providerSessionDigest
  });
  const chain = genesisCommunicationChainDigest({
    contextReceiptDigest,
    rolePolicyDigest,
    dispatchAttemptId,
    dispatchFence,
    workerProcessDigest,
    providerGeneration,
    providerProcessDigest,
    providerSessionDigest,
    providerCapabilityDigest
  });
  const preparing = writeAttempt(root, {
    schemaVersion: MAILBOX_ATTEMPT_SCHEMA_VERSION,
    state: "preparing",
    workerId,
    dispatchAttemptId,
    dispatchFence,
    workerProcessDigest,
    providerProcessDigest,
    providerGeneration,
    providerSessionDigest,
    providerCapabilityDigest,
    pumpOwnerDigest,
    contextReceiptDigest,
    rolePolicyDigest,
    nextSequence: 1,
    acceptedCount: 0,
    acceptedBytes: 0,
    communicationChainDigest: chain,
    primaryTurnEvidence: null,
    lastCompletedSequence: null,
    lastCompletedTurnDigest: null,
    finalReportSequence: null,
    finalReportDigest: null,
    deliveryUnknownSequence: null,
    activeSequence: null,
    openedAt,
    closedAt: null,
    closeReason: null
  }, env);
  const opened = writeAttempt(root, {
    ...preparing,
    state: "open"
  }, env);
  publishOpenIndex(root, opened, env);
  return opened;
}

function publishOpenIndex(root, attempt, env = process.env) {
  const index = readOpenIndex(root, env);
  const entries = { ...(index.entries || {}) };
  if (attempt.state === "open") {
    entries[attempt.workerId] = {
      dispatchAttemptId: attempt.dispatchAttemptId,
      dispatchFence: attempt.dispatchFence,
      providerGeneration: attempt.providerGeneration
    };
  } else {
    delete entries[attempt.workerId];
  }
  writeOpenIndex(root, { schemaVersion: 1, entries }, env);
}

export function resolveOpenMailbox(root, workerId, env = process.env) {
  assertSafeWorkerId(workerId);
  const index = readOpenIndex(root, env);
  const entry = index?.entries?.[workerId];
  if (!entry?.dispatchAttemptId) {
    const attemptsRoot = path.join(mailboxRoot(root, env), "attempts");
    if (!fs.existsSync(attemptsRoot)) return null;
    const candidates = fs.readdirSync(attemptsRoot)
      .filter((name) => name.startsWith(`${workerId}-`))
      .map((name) => name.slice(workerId.length + 1))
      .filter((attemptId) => ATTEMPT_ID.test(attemptId))
      .map((attemptId) => readAttemptMailbox(root, workerId, attemptId, env))
      .filter((attempt) => attempt?.state === "open");
    if (candidates.length > 1) {
      stateError("Worker has more than one open mailbox attempt.");
    }
    return candidates[0] || null;
  }
  const attempt = readAttemptMailbox(root, workerId, entry.dispatchAttemptId, env);
  if (!attempt || attempt.state !== "open") return null;
  if (attempt.dispatchFence !== entry.dispatchFence
    || attempt.providerGeneration !== entry.providerGeneration) {
    stateError("Mailbox open index binding drifted.");
  }
  return attempt;
}

/**
 * Accept one message under the caller's workspace transaction. Linearizable
 * with tryCloseAttemptMailbox under the same lock.
 */
export function acceptAttemptMessage(root, {
  workerId,
  ownerThreadId,
  message,
  idempotencyKey,
  requestDigest,
  contentDigest,
  idempotencyKeyDigest,
  messageId
}, env = process.env) {
  let attempt = resolveOpenMailbox(root, workerId, env);
  if (!attempt) {
    // Observationally equivalent: foreign, missing, closed, or never opened.
    throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
  }
  attempt = recoverAttemptConsistency(root, workerId, attempt.dispatchAttemptId, env);
  if (attempt.state !== "open") {
    throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
  }
  const prior = readMailboxMessage(root, workerId, attempt.dispatchAttemptId, messageId, env)
    || findByIdempotency(root, workerId, attempt.dispatchAttemptId, idempotencyKeyDigest, env);
  if (prior) {
    if (prior.ownerThreadId !== ownerThreadId
      || prior.workerId !== workerId
      || prior.requestDigest !== requestDigest
      || prior.contentDigest !== contentDigest
      || prior.idempotencyKeyDigest !== idempotencyKeyDigest) {
      throw new CompanionError(
        "E_IDEMPOTENCY_CONFLICT",
        "idempotencyKey was reused with a different mailbox owner or request."
      );
    }
    return { attempt, record: prior, replayed: true };
  }

  if (attempt.deliveryUnknownSequence != null) {
    return rejectMessage(root, {
      workerId,
      attempt,
      ownerThreadId,
      messageId,
      requestDigest,
      contentDigest,
      idempotencyKeyDigest,
      reason: "blocked-by-prior-unknown"
    }, env);
  }

  if (attempt.state !== "open") {
    throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
  }

  const bytes = utf8ByteLength(message);
  if (attempt.acceptedCount + 1 > MAX_MAILBOX_ACCEPTED_MESSAGES) {
    return rejectMessage(root, {
      workerId,
      attempt,
      ownerThreadId,
      messageId,
      requestDigest,
      contentDigest,
      idempotencyKeyDigest,
      reason: "accepted-message-limit"
    }, env);
  }
  if (attempt.acceptedBytes + bytes > MAX_MAILBOX_ACCEPTED_BYTES) {
    return rejectMessage(root, {
      workerId,
      attempt,
      ownerThreadId,
      messageId,
      requestDigest,
      contentDigest,
      idempotencyKeyDigest,
      reason: "accepted-bytes-limit"
    }, env);
  }

  const sequence = attempt.nextSequence;
  const acceptedAt = now();
  const record = writeMessage(root, {
    schemaVersion: MAILBOX_MESSAGE_SCHEMA_VERSION,
    messageId,
    workerId,
    dispatchAttemptId: attempt.dispatchAttemptId,
    dispatchFence: attempt.dispatchFence,
    sequence,
    state: "accepted",
    acceptedAt,
    outcomeAt: null,
    idempotencyKeyDigest,
    contentDigest,
    contentBytes: bytes,
    ownerThreadId,
    requestDigest,
    reason: null,
    rpcRequestId: null,
    composedPromptDigest: null,
    turnDigest: null,
    turnEvidence: null,
    _privateBody: message
  }, env);
  const nextAttempt = writeAttempt(root, {
    ...attempt,
    nextSequence: sequence + 1,
    acceptedCount: attempt.acceptedCount + 1,
    acceptedBytes: attempt.acceptedBytes + bytes
  }, env);
  return { attempt: nextAttempt, record, replayed: false };
}

function rejectMessage(root, {
  workerId,
  attempt,
  ownerThreadId,
  messageId,
  requestDigest,
  contentDigest,
  idempotencyKeyDigest,
  reason
}, env = process.env) {
  const acceptedAt = now();
  const record = writeMessage(root, {
    schemaVersion: MAILBOX_MESSAGE_SCHEMA_VERSION,
    messageId,
    workerId,
    dispatchAttemptId: attempt.dispatchAttemptId,
    dispatchFence: attempt.dispatchFence,
    // This request was not accepted into the ordered attempt and therefore
    // consumes neither an accepted sequence nor either cumulative limit.
    sequence: 0,
    state: "rejected",
    acceptedAt,
    outcomeAt: acceptedAt,
    idempotencyKeyDigest,
    contentDigest,
    contentBytes: 0,
    ownerThreadId,
    requestDigest,
    reason,
    rpcRequestId: null,
    composedPromptDigest: null,
    turnDigest: null,
    turnEvidence: null
  }, env);
  return { attempt, record, replayed: false };
}

function findByIdempotency(root, workerId, attemptId, keyDigest, env = process.env) {
  for (const record of listAttemptMessages(root, workerId, attemptId, env)) {
    if (record.idempotencyKeyDigest === keyDigest) return record;
  }
  return null;
}

/**
 * Deterministically finish any interrupted multi-record transition while the
 * caller holds the workspace transaction. Message records are written before
 * their aggregate attempt fields, so their sealed, body-free evidence is the
 * recovery input and no provider request is ever replayed.
 */
export function recoverAttemptConsistency(
  root,
  workerId,
  attemptId,
  env = process.env,
  { skipTerminalRepair = false } = {}
) {
  let attempt = readAttemptMailbox(root, workerId, attemptId, env);
  if (!attempt) return null;
  const originalAttemptDigest = attempt.attemptDigest;
  let messages = listAttemptMessages(root, workerId, attemptId, env);
  for (const record of messages) {
    if (record.workerId !== workerId
      || record.dispatchAttemptId !== attemptId
      || record.dispatchFence !== attempt.dispatchFence) {
      stateError("Mailbox message binding drifted from its attempt.");
    }
  }

  const accepted = messages
    .filter((record) => record.sequence > 0)
    .sort((left, right) => left.sequence - right.sequence);
  if (accepted.length > MAX_MAILBOX_ACCEPTED_MESSAGES
    || accepted.reduce((total, record) => total + record.contentBytes, 0)
      > MAX_MAILBOX_ACCEPTED_BYTES) {
    stateError("Mailbox cumulative acceptance limits were exceeded.");
  }
  for (let index = 0; index < accepted.length; index += 1) {
    if (accepted[index].sequence !== index + 1 || accepted[index].contentBytes < 1) {
      stateError("Mailbox accepted sequences are not contiguous.");
    }
  }
  const acceptedBytes = accepted.reduce((total, record) => total + record.contentBytes, 0);
  const durablePrefixBytes = accepted
    .slice(0, attempt.acceptedCount)
    .reduce((total, record) => total + record.contentBytes, 0);
  if (attempt.acceptedCount > accepted.length
    || attempt.acceptedBytes !== durablePrefixBytes
    || attempt.nextSequence !== attempt.acceptedCount + 1) {
    stateError("Mailbox aggregate acceptance counters lead or disagree with durable messages.");
  }

  const active = accepted.filter((record) => (
    record.state === "claimed" || record.state === "inflight"
  ));
  if (active.length > 1) stateError("Mailbox has more than one active pump sequence.");
  if (attempt.activeSequence !== null
    && !accepted.some((record) => record.sequence === attempt.activeSequence)) {
    stateError("Mailbox active aggregate points to a missing message.");
  }

  const deliveryTurns = accepted.filter((record) => (
    record.state === "delivered" || record.state === "delivery_unknown"
  ));
  const unknownTurns = deliveryTurns.filter((record) => record.state === "delivery_unknown");
  if (unknownTurns.length > 1) stateError("Mailbox has more than one ambiguous delivery turn.");
  if (unknownTurns.length
    && deliveryTurns.some((record) => record.sequence > unknownTurns[0].sequence)) {
    stateError("Mailbox contains a completed turn after delivery became unknown.");
  }

  const chainBySequence = new Map();
  let derivedChainDigest = genesisCommunicationChainDigest(attempt);
  let derivedLastSequence = null;
  let derivedLastTurnDigest = null;
  if (attempt.primaryTurnEvidence) {
    const primary = verifyChainExtension({
      ...attempt,
      communicationChainDigest: derivedChainDigest
    }, attempt.primaryTurnEvidence);
    if (primary.sequence !== 0
      || primary.outcome !== "delivered"
      || primary.messageId !== null
      || primary.rpcRequestId !== null) {
      stateError("Mailbox primary turn evidence is inconsistent.");
    }
    derivedChainDigest = primary.turnDigest;
    derivedLastSequence = 0;
    derivedLastTurnDigest = primary.turnDigest;
    chainBySequence.set(0, primary.turnDigest);
  } else if (deliveryTurns.length > 0) {
    stateError("Mailbox delivery exists before the primary turn was durably recorded.");
  }
  for (const record of deliveryTurns) {
    const evidence = verifyChainExtension({
      ...attempt,
      communicationChainDigest: derivedChainDigest
    }, record.turnEvidence);
    if (derivedLastSequence === null
      || evidence.sequence <= derivedLastSequence
      || evidence.sequence !== record.sequence
      || evidence.messageId !== record.messageId
      || evidence.turnDigest !== record.turnDigest
      || evidence.contentDigest !== record.contentDigest
      || evidence.composedPromptDigest !== record.composedPromptDigest
      || evidence.rpcRequestId !== record.rpcRequestId
      || evidence.outcome !== (
        record.state === "delivered" ? "delivered" : "delivery_unknown"
      )) {
      stateError("Mailbox terminal message evidence is inconsistent.");
    }
    derivedChainDigest = evidence.turnDigest;
    derivedLastSequence = record.sequence;
    derivedLastTurnDigest = evidence.turnDigest;
    chainBySequence.set(record.sequence, record.turnDigest);
  }
  if (attempt.lastCompletedSequence !== null) {
    const aggregateDigest = chainBySequence.get(attempt.lastCompletedSequence);
    if (!aggregateDigest
      || aggregateDigest !== attempt.lastCompletedTurnDigest
      || aggregateDigest !== attempt.communicationChainDigest) {
      stateError("Mailbox aggregate chain is not a valid prefix of durable turn evidence.");
    }
  } else if (derivedLastSequence !== null) {
    stateError("Mailbox primary evidence exists without an aggregate primary turn.");
  }
  if (attempt.lastCompletedSequence !== derivedLastSequence) {
    if (attempt.lastCompletedSequence === null
      || derivedLastSequence === null
      || attempt.lastCompletedSequence > derivedLastSequence) {
      stateError("Mailbox aggregate chain leads durable turn evidence.");
    }
    attempt = {
      ...attempt,
      communicationChainDigest: derivedChainDigest,
      lastCompletedSequence: derivedLastSequence,
      lastCompletedTurnDigest: derivedLastTurnDigest
    };
  }

  const unknown = unknownTurns[0] || null;
  if (unknown && !skipTerminalRepair) {
    for (const record of accepted) {
      if (record.sequence <= unknown.sequence
        || (record.state !== "accepted" && record.state !== "claimed")) continue;
      const { _privateBody: _removed, ...withoutBody } = record;
      writeMessage(root, {
        ...withoutBody,
        state: "rejected",
        outcomeAt: record.outcomeAt || now(),
        reason: "blocked-by-prior-unknown"
      }, env);
    }
    attempt = {
      ...attempt,
      state: attempt.state === "closed" ? "closed" : "closing",
      deliveryUnknownSequence: unknown.sequence,
      activeSequence: null,
      closeReason: attempt.closeReason || unknown.reason || "delivery-unknown"
    };
    messages = listAttemptMessages(root, workerId, attemptId, env);
  }

  if (attempt.state === "closed") {
    for (const record of messages) {
      if (!Object.hasOwn(record, "_privateBody")) continue;
      const { _privateBody: _removed, ...withoutBody } = record;
      writeMessage(root, {
        ...withoutBody,
        state: TERMINAL_MESSAGE_STATES.has(record.state) ? record.state : "rejected",
        outcomeAt: record.outcomeAt || now(),
        reason: record.reason || "body-scrubbed-on-close"
      }, env);
    }
  }

  const acceptedCount = accepted.length;
  const activeSequence = unknown
    ? null
    : (active[0]?.sequence ?? null);
  const repaired = {
    ...attempt,
    nextSequence: acceptedCount + 1,
    acceptedCount,
    acceptedBytes,
    activeSequence
  };
  const changed = stableDigest(attemptDigestBody(repaired)) !== originalAttemptDigest;
  return changed ? writeAttempt(root, repaired, env) : attempt;
}

export function claimNextAcceptedMessage(
  root,
  workerId,
  attemptId,
  pumpOwnerDigest,
  env = process.env
) {
  const attempt = recoverAttemptConsistency(root, workerId, attemptId, env);
  if (!attempt || attempt.state !== "open") return { attempt, record: null };
  assertPumpOwner(attempt, pumpOwnerDigest);
  if (attempt.deliveryUnknownSequence != null) return { attempt, record: null };
  if (attempt.activeSequence != null) {
    stateError("Mailbox already has an active pump sequence.");
  }

  const candidates = listAttemptMessages(root, workerId, attemptId, env)
    .filter((record) => record.state === "accepted")
    .sort((left, right) => left.sequence - right.sequence);
  const next = candidates[0] || null;
  if (!next) return { attempt, record: null };

  const claimed = writeMessage(root, {
    ...next,
    state: "claimed"
  }, env);
  const claimedAttempt = writeAttempt(root, {
    ...attempt,
    activeSequence: claimed.sequence
  }, env);
  return { attempt: claimedAttempt, record: claimed };
}

/**
 * Transition claimed -> inflight, erasing the body before any RPC bytes leave.
 */
export function markMessageInflight(root, {
  workerId,
  attemptId,
  messageId,
  rpcRequestId,
  composedPromptDigest,
  pumpOwnerDigest
}, env = process.env) {
  const attempt = recoverAttemptConsistency(root, workerId, attemptId, env);
  if (!attempt || attempt.state !== "open") {
    deliveryError("Mailbox is not open for inflight transition.");
  }
  assertPumpOwner(attempt, pumpOwnerDigest);
  const current = readMailboxMessage(root, workerId, attemptId, messageId, env);
  if (!current || current.state !== "claimed") {
    deliveryError("Only claimed mailbox messages may become inflight.");
  }
  if (attempt.activeSequence !== current.sequence) {
    stateError("Mailbox active sequence changed before inflight transition.");
  }
  if (!Number.isSafeInteger(rpcRequestId) || rpcRequestId < 1) {
    deliveryError("Inflight requires an exact numeric RPC request id.");
  }
  if (!SHA256_HEX.test(composedPromptDigest || "")) {
    deliveryError("Inflight requires a composed prompt digest.");
  }
  const { _privateBody: _removed, ...withoutBody } = current;
  return writeMessage(root, {
    ...withoutBody,
    state: "inflight",
    rpcRequestId,
    composedPromptDigest,
    reason: null
  }, env);
}

export function settleMessageDelivered(root, {
  workerId,
  attemptId,
  messageId,
  turnEntry,
  pumpOwnerDigest
}, env = process.env) {
  const attempt = recoverAttemptConsistency(root, workerId, attemptId, env);
  if (!attempt) stateError("Mailbox attempt missing during delivered settlement.");
  assertPumpOwner(attempt, pumpOwnerDigest);
  const current = readMailboxMessage(root, workerId, attemptId, messageId, env);
  if (!current || current.state !== "inflight") {
    deliveryError("Only inflight messages may become delivered.");
  }
  if (attempt.activeSequence !== current.sequence) {
    stateError("Mailbox active sequence changed before delivered settlement.");
  }
  const verified = verifyChainExtension(attempt, turnEntry);
  if (verified.sequence !== current.sequence
    || verified.contentDigest !== current.contentDigest
    || verified.composedPromptDigest !== current.composedPromptDigest
    || verified.outcome !== "delivered"
    || verified.rpcRequestId !== current.rpcRequestId
    || verified.messageId !== current.messageId) {
    stateError("Delivered turn evidence does not match inflight message.");
  }
  const outcomeAt = now();
  const { _privateBody: _removed, ...withoutBody } = current;
  const record = writeMessage(root, {
    ...withoutBody,
    state: "delivered",
    outcomeAt,
    turnDigest: verified.turnDigest,
    turnEvidence: verified,
    reason: null
  }, env);
  const nextAttempt = writeAttempt(root, {
    ...attempt,
    communicationChainDigest: verified.turnDigest,
    lastCompletedSequence: current.sequence,
    lastCompletedTurnDigest: verified.turnDigest,
    activeSequence: null
  }, env);
  return { attempt: nextAttempt, record, turn: verified };
}

export function settleMessageUnknown(root, {
  workerId,
  attemptId,
  messageId,
  reason = "delivery-unknown",
  pumpOwnerDigest = null,
  recovery = false
}, env = process.env) {
  const attempt = recoverAttemptConsistency(root, workerId, attemptId, env, {
    skipTerminalRepair: true
  });
  if (!attempt) stateError("Mailbox attempt missing during unknown settlement.");
  if (!recovery) assertPumpOwner(attempt, pumpOwnerDigest);
  const current = readMailboxMessage(root, workerId, attemptId, messageId, env);
  if (!current || current.state !== "inflight") {
    deliveryError("Only an inflight message may become delivery_unknown.");
  }
  if (attempt.activeSequence !== current.sequence) {
    stateError("Mailbox active sequence changed before unknown settlement.");
  }
  const outcomeAt = now();
  const turnEntry = communicationChainEntry({
    previousDigest: attempt.communicationChainDigest,
    contextReceiptDigest: attempt.contextReceiptDigest,
    rolePolicyDigest: attempt.rolePolicyDigest,
    dispatchAttemptId: attempt.dispatchAttemptId,
    dispatchFence: attempt.dispatchFence,
    workerProcessDigest: attempt.workerProcessDigest,
    providerGeneration: attempt.providerGeneration,
    providerProcessDigest: attempt.providerProcessDigest,
    providerSessionDigest: attempt.providerSessionDigest,
    providerCapabilityDigest: attempt.providerCapabilityDigest,
    sequence: current.sequence,
    contentDigest: current.contentDigest,
    composedPromptDigest: current.composedPromptDigest || stableDigest({ omitted: true }),
    outcome: "delivery_unknown",
    messageId: current.messageId,
    rpcRequestId: current.rpcRequestId
  });
  const { _privateBody: _removed, ...withoutBody } = current;
  const record = writeMessage(root, {
    ...withoutBody,
    state: "delivery_unknown",
    outcomeAt,
    reason,
    turnDigest: turnEntry.turnDigest,
    turnEvidence: turnEntry,
    composedPromptDigest: withoutBody.composedPromptDigest || turnEntry.composedPromptDigest,
    rpcRequestId: withoutBody.rpcRequestId
  }, env);
  // Close pump authority: reject later unattempted messages and erase bodies.
  eraseActiveBodies(root, workerId, attemptId, messageId, env);
  rejectUnattemptedAccepted(root, workerId, attemptId, current.sequence, env);
  const nextAttempt = writeAttempt(root, {
    ...attempt,
    state: attempt.state === "closed" ? "closed" : "closing",
    communicationChainDigest: turnEntry.turnDigest,
    lastCompletedSequence: current.sequence,
    lastCompletedTurnDigest: turnEntry.turnDigest,
    deliveryUnknownSequence: current.sequence,
    activeSequence: null,
    closeReason: reason
  }, env);
  return { attempt: nextAttempt, record, turn: turnEntry };
}

function eraseActiveBodies(root, workerId, attemptId, exceptMessageId, env = process.env) {
  for (const record of listAttemptMessages(root, workerId, attemptId, env)) {
    if (record.messageId === exceptMessageId) continue;
    if (!BODY_RETAINING_STATES.has(record.state)) continue;
    const { _privateBody: _removed, ...withoutBody } = record;
    writeMessage(root, {
      ...withoutBody,
      state: record.state === "accepted" || record.state === "claimed"
        ? "rejected"
        : record.state,
      outcomeAt: record.outcomeAt || now(),
      reason: record.reason || "blocked-by-prior-unknown"
    }, env);
  }
}

function rejectUnattemptedAccepted(root, workerId, attemptId, afterSequence, env = process.env) {
  for (const record of listAttemptMessages(root, workerId, attemptId, env)) {
    if (record.sequence <= afterSequence) continue;
    if (record.state !== "accepted" && record.state !== "claimed") continue;
    const { _privateBody: _removed, ...withoutBody } = record;
    writeMessage(root, {
      ...withoutBody,
      state: "rejected",
      outcomeAt: now(),
      reason: "blocked-by-prior-unknown"
    }, env);
  }
}

export function settleMessageRejected(root, {
  workerId,
  attemptId,
  messageId,
  reason
}, env = process.env) {
  const current = readMailboxMessage(root, workerId, attemptId, messageId, env);
  if (!current || (current.state !== "accepted" && current.state !== "claimed")) {
    deliveryError("Only accepted/claimed messages may be rejected.");
  }
  const { _privateBody: _removed, ...withoutBody } = current;
  const rejected = writeMessage(root, {
    ...withoutBody,
    state: "rejected",
    outcomeAt: now(),
    reason: reason || "rejected"
  }, env);
  const attempt = readAttemptMailbox(root, workerId, attemptId, env);
  if (attempt?.activeSequence === current.sequence) {
    writeAttempt(root, { ...attempt, activeSequence: null }, env);
  }
  return rejected;
}

/**
 * Final empty-scan to closed. Linearizable with accept under the same workspace
 * transaction. Returns closed attempt or null when work remains.
 */
export function tryCloseAttemptMailbox(root, workerId, attemptId, {
  reason = "empty-drain",
  pumpOwnerDigest = null,
  recovery = false
} = {}, env = process.env) {
  const attempt = recoverAttemptConsistency(root, workerId, attemptId, env);
  if (!attempt) return null;
  if (!recovery) assertPumpOwner(attempt, pumpOwnerDigest);
  if (attempt.state === "closed") return attempt;
  if (attempt.state !== "open"
    && attempt.state !== "closing"
    && !(recovery && attempt.state === "preparing")) {
    deliveryError(`Mailbox cannot close from state ${attempt.state}.`);
  }
  const active = listAttemptMessages(root, workerId, attemptId, env)
    .filter((record) => ACTIVE_MESSAGE_STATES.has(record.state));
  if (active.length > 0 && attempt.deliveryUnknownSequence == null) {
    return null;
  }
  // After unknown, active should already be cleared; fail closed if not.
  if (active.length > 0) {
    stateError("Mailbox retained active messages after an unknown turn.");
  }
  const closing = attempt.state === "closing"
    ? attempt
    : writeAttempt(root, {
        ...attempt,
        state: "closing",
        closeReason: attempt.closeReason || reason
      }, env);
  const closed = writeAttempt(root, {
    ...closing,
    state: "closed",
    closedAt: now(),
    closeReason: attempt.closeReason || reason
  }, env);
  publishOpenIndex(root, closed, env);
  // Final body scrub for any residual private fields.
  for (const record of listAttemptMessages(root, workerId, attemptId, env)) {
    if (!Object.hasOwn(record, "_privateBody")) continue;
    const { _privateBody: _removed, ...withoutBody } = record;
    writeMessage(root, {
      ...withoutBody,
      state: TERMINAL_MESSAGE_STATES.has(withoutBody.state) ? withoutBody.state : "rejected",
      outcomeAt: withoutBody.outcomeAt || now(),
      reason: withoutBody.reason || "body-scrubbed-on-close"
    }, env);
  }
  return closed;
}

export function recordPrimaryTurn(root, workerId, attemptId, {
  contentDigest,
  composedPromptDigest,
  pumpOwnerDigest
}, env = process.env) {
  const attempt = recoverAttemptConsistency(root, workerId, attemptId, env);
  if (!attempt || attempt.state !== "open") {
    stateError("Primary turn requires an open mailbox.");
  }
  if (!SHA256_HEX.test(contentDigest || "") || !SHA256_HEX.test(composedPromptDigest || "")) {
    stateError("Primary turn evidence digests are malformed.");
  }
  assertPumpOwner(attempt, pumpOwnerDigest);
  if (attempt.lastCompletedSequence !== null
    || attempt.lastCompletedTurnDigest !== null
    || attempt.primaryTurnEvidence !== null
    || attempt.activeSequence !== null) {
    stateError("Primary turn can be recorded exactly once before mailbox pumping.");
  }
  const turn = communicationChainEntry({
    previousDigest: attempt.communicationChainDigest,
    contextReceiptDigest: attempt.contextReceiptDigest,
    rolePolicyDigest: attempt.rolePolicyDigest,
    dispatchAttemptId: attempt.dispatchAttemptId,
    dispatchFence: attempt.dispatchFence,
    workerProcessDigest: attempt.workerProcessDigest,
    providerGeneration: attempt.providerGeneration,
    providerProcessDigest: attempt.providerProcessDigest,
    providerSessionDigest: attempt.providerSessionDigest,
    providerCapabilityDigest: attempt.providerCapabilityDigest,
    sequence: 0,
    contentDigest,
    composedPromptDigest,
    outcome: "delivered",
    messageId: null,
    rpcRequestId: null
  });
  const next = writeAttempt(root, {
    ...attempt,
    communicationChainDigest: turn.turnDigest,
    primaryTurnEvidence: turn,
    lastCompletedSequence: 0,
    lastCompletedTurnDigest: turn.turnDigest
  }, env);
  return { attempt: next, turn };
}

/**
 * Bind report selection after the mailbox is closed. The caller owns provider
 * authority checks, including the narrowly authenticated generation-2
 * format-repair path; this state helper never reopens mailbox acceptance.
 */
export function selectFinalReportSequence(root, workerId, attemptId, {
  sequence,
  valid,
  reportDigest = null
}, env = process.env) {
  const attempt = readAttemptMailbox(root, workerId, attemptId, env);
  if (!attempt || attempt.state !== "closed") {
    stateError("Final report selection requires a closed mailbox.");
  }
  if (!Number.isSafeInteger(sequence)
    || sequence < 0
    || sequence !== attempt.lastCompletedSequence) {
    stateError("Final report selection must target the last completed mailbox turn.");
  }
  if (valid === true && !SHA256_HEX.test(reportDigest || "")) {
    stateError("Valid final report selection requires its exact text digest.");
  }
  if (valid !== true && reportDigest !== null) {
    stateError("Invalid final report selection must not retain a report digest.");
  }
  if (attempt.finalReportSequence !== null) {
    if (valid === true
      && attempt.finalReportSequence === sequence
      && attempt.finalReportDigest === reportDigest) {
      return attempt;
    }
    stateError("Final report selection is already bound.");
  }
  return writeAttempt(root, {
    ...attempt,
    finalReportSequence: valid === true ? sequence : null,
    finalReportDigest: valid === true ? reportDigest : null
  }, env);
}

export function assertNoRetainedBodies(root, workerId, attemptId, env = process.env) {
  for (const record of listAttemptMessages(root, workerId, attemptId, env)) {
    if (Object.hasOwn(record, "_privateBody")) {
      stateError("Mailbox retained a private message body.");
    }
  }
  return true;
}

/**
 * Fail-closed settlement used after provider/controller loss. Inflight means
 * the request may have crossed the provider boundary and is never retried;
 * accepted/claimed requests provably did not cross it and are rejected.
 */
export function settleInterruptedAttempt(root, workerId, attemptId, {
  reason = "provider-interrupted"
} = {}, env = process.env) {
  let attempt = recoverAttemptConsistency(root, workerId, attemptId, env);
  if (!attempt || attempt.state === "closed") return attempt;
  const messages = listAttemptMessages(root, workerId, attemptId, env);
  const inflight = messages.find((record) => record.state === "inflight") || null;
  if (inflight) {
    attempt = settleMessageUnknown(root, {
      workerId,
      attemptId,
      messageId: inflight.messageId,
      reason,
      recovery: true
    }, env).attempt;
  } else {
    for (const record of messages) {
      if (record.state !== "accepted" && record.state !== "claimed") continue;
      settleMessageRejected(root, {
        workerId,
        attemptId,
        messageId: record.messageId,
        reason
      }, env);
    }
  }
  return tryCloseAttemptMailbox(root, workerId, attemptId, {
    reason,
    recovery: true
  }, env)
    || readAttemptMailbox(root, workerId, attemptId, env);
}

export function mailboxHasRetainedBodies(root, workerId, attemptId, env = process.env) {
  return listAttemptMessages(root, workerId, attemptId, env)
    .some((record) => Object.hasOwn(record, "_privateBody"));
}

export {
  attemptPath,
  messagePath,
  ACTIVE_MESSAGE_STATES,
  TERMINAL_MESSAGE_STATES
};
