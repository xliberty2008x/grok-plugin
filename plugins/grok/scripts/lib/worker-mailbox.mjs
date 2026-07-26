/**
 * P2.4 ordered turn-boundary ACP mailbox: durable accept + provider-owned pump.
 *
 * Production settlement is exclusively the worker/provider pump:
 * accepted(body) -> claimed(body) -> inflight(body-free, numeric RPC id)
 * -> delivered | delivery_unknown. delivery_unknown is never retried.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CompanionError } from "./errors.mjs";
import {
  isCancelledPromptStopReason,
  isSuccessfulPromptStopReason,
  normalizeOutputSchema,
  structuredPromptResult,
  validatePromptResponse
} from "./acp-client.mjs";
import {
  isCancelRequested,
  terminal,
  withWorkspaceStateTransaction
} from "./state.mjs";
import { appendLifecycleEvent } from "./task-contract.mjs";
import { workspaceState } from "./workspace.mjs";
import { isDispatchV2 } from "./worker-launch-contract.mjs";
import {
  assertMutationOwnership,
  cancellationNonce,
  spawnGrantedFollowupWorker
} from "./worker-mutation.mjs";
import {
  MAILBOX_MESSAGE_SCHEMA_VERSION,
  MAX_MAILBOX_MESSAGE_LENGTH,
  acceptAttemptMessage,
  assertNoRetainedBodies,
  claimNextAcceptedMessage,
  communicationChainEntry,
  contentDigestOf,
  findWorkerMessage,
  listAttemptMessages,
  mailboxHasRetainedBodies,
  markMessageInflight,
  openAttemptMailbox,
  publicMessageReceipt,
  readAttemptMailbox,
  readMailboxMessage,
  recordPrimaryTurn,
  recoverAttemptConsistency,
  resolveOpenMailbox,
  settleMessageDelivered,
  settleMessageRejected,
  settleMessageUnknown,
  settleInterruptedAttempt,
  stableDigest,
  tryCloseAttemptMailbox,
  utf8ByteLength
} from "./worker-mailbox-state.mjs";

export const MAILBOX_SCHEMA_VERSION = MAILBOX_MESSAGE_SCHEMA_VERSION;
export { MAX_MAILBOX_MESSAGE_LENGTH };
export const DELIVERY_STATES = Object.freeze([
  "accepted",
  "pending",
  "delivered",
  "delivery_unknown",
  "rejected"
]);

export {
  MAX_MAILBOX_ACCEPTED_MESSAGES,
  MAX_MAILBOX_ACCEPTED_BYTES,
  MAILBOX_CAPABILITY,
  openAttemptMailbox,
  resolveOpenMailbox,
  readAttemptMailbox,
  listAttemptMessages,
  tryCloseAttemptMailbox,
  recordPrimaryTurn,
  recoverAttemptConsistency,
  mailboxHasRetainedBodies,
  assertNoRetainedBodies,
  settleMessageUnknown,
  settleInterruptedAttempt,
  settleMessageRejected,
  selectFinalReportSequence,
  communicationChainEntry,
  stableDigest,
  contentDigestOf,
  utf8ByteLength,
  publicMessageReceipt as publicReceipt
} from "./worker-mailbox-state.mjs";

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

function requestStableDigest(value) {
  return digest(JSON.stringify(canonicalize(value)));
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

function assertLiveMailboxAuthority(job, attempt) {
  if (!attempt || attempt.state !== "open" || terminal(job)) {
    throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
  }
  const dispatch = job.request?.spawn?.dispatch;
  const exact = (
    attempt.workerId === job.id
    && isDispatchV2(dispatch)
    && dispatch.state === "provider-started"
    && dispatch.attemptId === attempt.dispatchAttemptId
    && dispatch.fence === attempt.dispatchFence
    && dispatch.providerGeneration === 1
    && job.workerProcess
    && stableDigest(job.workerProcess) === attempt.workerProcessDigest
    && job.providerProcess
    && stableDigest(job.providerProcess) === attempt.providerProcessDigest
    && job.providerProcess.providerGeneration === 1
    && typeof job.grokSessionId === "string"
    && job.grokSessionId.length > 0
    && stableDigest({ providerSessionId: job.grokSessionId })
      === attempt.providerSessionDigest
    && (job.request?.spawn?.providerCapabilityDigest ?? null)
      === attempt.providerCapabilityDigest
    && job.request?.contextReceipt
    && stableDigest(job.request?.contextReceipt) === attempt.contextReceiptDigest
    && job.request?.runtimeRolePolicy?.digest === attempt.rolePolicyDigest
  );
  if (!exact) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Mailbox authority changed from the exact primary provider attempt."
    );
  }
  return attempt;
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
          sequence: record.sequence,
          ...(record.turnDigest ? { turnDigest: record.turnDigest } : {})
        }
      )
    };
  });
}

/**
 * ACP acknowledgement/dedup feasibility result (spike record).
 * PromptResponse proves a completed turn boundary, not exactly-once execution.
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
    // Turn-boundary acknowledgement is not exactly-once execution.
    exactlyOnceClaimable: false,
    note: acknowledgement
      ? "ACP PromptResponse proves a completed turn boundary only; crash after response before durable outcome remains delivery_unknown."
      : "Durable acceptance plus explicit ambiguity only; delivery_unknown is never auto-retried."
  });
}

/**
 * Accept a message for an open attempt-bound mailbox. Delivery is settled only
 * by the provider-owned pump — never by a caller-defined deliver hook.
 */
export function sendWorkerMessage({
  root,
  principal,
  workerId,
  message,
  idempotencyKey,
  env = process.env
} = {}) {
  assertIdempotencyKey(idempotencyKey);
  if (!principal?.threadId) {
    throw new CompanionError("E_AUTH_REQUIRED", "Trusted Codex task identity is unavailable.");
  }
  assertMessage(message);
  if (Object.hasOwn(arguments[0] || {}, "deliver")) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Caller-defined mailbox delivery adapters are unsupported; only the provider pump settles delivery."
    );
  }

  const contentDigest = contentDigestOf(message);
  const keyDigest = digest(idempotencyKey);
  const mutationDigest = requestStableDigest({
    ownerThreadId: principal.threadId,
    workerId,
    message
  });
  // The public correlation handle must reveal neither idempotency-key equality
  // nor message-content equality. Exact replay identity remains private.
  const messageId = `msg-${crypto.randomBytes(12).toString("hex")}`;

  return withWorkspaceStateTransaction(root, (transaction) => {
    const job = transaction.tryReadJob(workerId);
    if (!job) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    assertMutationOwnership(job, principal);

    const prior = findWorkerMessage(root, workerId, {
      messageId,
      idempotencyKeyDigest: keyDigest
    }, env);
    if (prior) {
      if (prior.ownerThreadId !== principal.threadId
        || prior.workerId !== workerId
        || prior.requestDigest !== mutationDigest
        || prior.contentDigest !== contentDigest
        || prior.idempotencyKeyDigest !== keyDigest) {
        throw new CompanionError(
          "E_IDEMPOTENCY_CONFLICT",
          "idempotencyKey was reused with a different mailbox owner or request."
        );
      }
    }

    const cancelled = isCancelRequested(
      root,
      workerId,
      cancellationNonce(job),
      env
    );
    if (cancelled) {
      const openAttempt = resolveOpenMailbox(root, workerId, env);
      if (openAttempt) {
        settleInterruptedAttempt(root, workerId, openAttempt.dispatchAttemptId, {
          reason: "provider-cancelled"
        }, env);
        for (const record of listAttemptMessages(
          root,
          workerId,
          openAttempt.dispatchAttemptId,
          env
        )) {
          appendMailboxOutcome(transaction, workerId, record);
        }
      }
      if (!prior) {
        throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
      }
      const settledPrior = findWorkerMessage(root, workerId, {
        messageId: prior.messageId,
        idempotencyKeyDigest: keyDigest
      }, env);
      return {
        receipt: publicMessageReceipt(settledPrior || prior),
        replayed: true
      };
    }

    if (prior) {
      if (!terminal(job)) appendMailboxOutcome(transaction, workerId, prior);
      return {
        receipt: publicMessageReceipt(prior),
        replayed: true
      };
    }

    assertLiveMailboxAuthority(job, resolveOpenMailbox(root, workerId, env));
    const accepted = acceptAttemptMessage(root, {
      workerId,
      ownerThreadId: principal.threadId,
      message,
      idempotencyKey,
      requestDigest: mutationDigest,
      contentDigest,
      idempotencyKeyDigest: keyDigest,
      messageId
    }, env);

    appendMailboxOutcome(transaction, workerId, accepted.record);
    return {
      receipt: publicMessageReceipt(accepted.record),
      replayed: accepted.replayed === true
    };
  }, env);
}

/**
 * delivery_unknown must never be automatically retried.
 */
export function retryDelivery(root, messageId, env = process.env) {
  if (typeof messageId !== "string" || !/^msg-[a-f0-9]{24}$/.test(messageId)) {
    throw new CompanionError("E_JOB_NOT_FOUND", "Message was not found.");
  }
  try {
    const stateRoot = workspaceState(root, env);
    const attemptsRoot = path.join(stateRoot, "mailbox", "attempts");
    if (!fs.existsSync(attemptsRoot)) {
      throw new CompanionError("E_JOB_NOT_FOUND", "Message was not found.");
    }
    for (const dirName of fs.readdirSync(attemptsRoot)) {
      const file = path.join(attemptsRoot, dirName, `${messageId}.json`);
      if (!fs.existsSync(file)) continue;
      const attemptId = dirName.slice(-32);
      const workerId = dirName.slice(0, -(32 + 1));
      if (!/^[a-f0-9]{32}$/.test(attemptId)) continue;
      const record = readMailboxMessage(root, workerId, attemptId, messageId, env);
      if (!record) continue;
      if (record.state === "delivery_unknown") {
        throw new CompanionError(
          "E_DELIVERY",
          "delivery_unknown messages must not be automatically retried."
        );
      }
      if (record.state === "delivered" || record.state === "rejected") {
        throw new CompanionError("E_DELIVERY", `Message already terminal as ${record.state}.`);
      }
      return publicMessageReceipt(record);
    }
  } catch (error) {
    if (error instanceof CompanionError) throw error;
  }
  throw new CompanionError("E_JOB_NOT_FOUND", "Message was not found.");
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
  const open = resolveOpenMailbox(root, workerId, env);
  if (open) {
    return listAttemptMessages(root, workerId, open.dispatchAttemptId, env)
      .map((record) => publicMessageReceipt(record));
  }
  const stateRoot = workspaceState(root, env);
  const attemptsRoot = path.join(stateRoot, "mailbox", "attempts");
  if (!fs.existsSync(attemptsRoot)) return [];
  const receipts = [];
  for (const dirName of fs.readdirSync(attemptsRoot)) {
    if (!dirName.startsWith(`${workerId}-`)) continue;
    const attemptId = dirName.slice(workerId.length + 1);
    for (const record of listAttemptMessages(root, workerId, attemptId, env)) {
      receipts.push(publicMessageReceipt(record));
    }
  }
  return receipts;
}

/**
 * Open the attempt-bound mailbox for the primary provider generation after
 * session establishment. Report-repair generations must not call this.
 */
export function openWorkerMailboxForProvider({
  root,
  workerId,
  dispatchAttemptId,
  dispatchFence,
  workerProcessDigest,
  providerProcessDigest,
  providerGeneration,
  providerSessionDigest,
  providerCapabilityDigest = null,
  contextReceiptDigest,
  rolePolicyDigest,
  env = process.env
}) {
  return withWorkspaceStateTransaction(root, () => openAttemptMailbox(root, {
    workerId,
    dispatchAttemptId,
    dispatchFence,
    workerProcessDigest,
    providerProcessDigest,
    providerGeneration,
    providerSessionDigest,
    providerCapabilityDigest,
    contextReceiptDigest,
    rolePolicyDigest
  }, env), env);
}

/**
 * Drain accepted messages sequentially through one ACP client/session.
 * Never holds a filesystem lock while awaiting ACP.
 */
export async function drainWorkerMailbox({
  root,
  workerId,
  attemptId,
  client,
  sessionId,
  composePrompt,
  collectTurnText,
  outputSchema = null,
  timeoutMs = 30 * 60 * 1000,
  env = process.env,
  onTurn = null,
  validateAuthority = null,
  cancelRequested = () => false
} = {}) {
  if (!client || typeof client.reserveRequestId !== "function"
    || typeof client.dispatchReserved !== "function") {
    throw new CompanionError("E_CAPABILITY", "Mailbox pump requires a reserve-then-dispatch ACP client.");
  }
  if (typeof composePrompt !== "function") {
    throw new CompanionError("E_USAGE", "Mailbox pump requires composePrompt.");
  }
  const normalizedOutputSchema = outputSchema == null
    ? null
    : normalizeOutputSchema(outputSchema);

  const turns = [];
  let deliveryUnknown = false;
  const initialAttempt = readAttemptMailbox(root, workerId, attemptId, env);
  if (!initialAttempt) {
    throw new CompanionError("E_JOB_NOT_FOUND", "Worker mailbox attempt was not found.");
  }
  const pumpOwnerDigest = initialAttempt.pumpOwnerDigest;
  const inTransaction = (callback) => withWorkspaceStateTransaction(root, (transaction) => {
    if (typeof validateAuthority === "function") validateAuthority(transaction);
    return callback(transaction);
  }, env);
  const cancellationRequested = () => {
    try {
      return cancelRequested() === true;
    } catch (error) {
      throw error instanceof CompanionError
        ? error
        : new CompanionError("E_STATE", "Could not read durable cancellation state.");
    }
  };
  const settleCancellation = (transaction) => {
    const settledAttempt = settleInterruptedAttempt(root, workerId, attemptId, {
      reason: "provider-cancelled"
    }, env);
    for (const settledRecord of listAttemptMessages(root, workerId, attemptId, env)) {
      appendMailboxOutcome(transaction, workerId, settledRecord);
    }
    return settledAttempt;
  };

  for (;;) {
    const claimed = inTransaction((transaction) => {
      const current = readAttemptMailbox(root, workerId, attemptId, env);
      if (!current || current.state !== "open") {
        return { done: true, attempt: current, record: null };
      }
      if (cancellationRequested()) {
        return {
          done: true,
          cancelled: true,
          attempt: settleCancellation(transaction),
          record: null
        };
      }
      if (current.deliveryUnknownSequence != null) {
        return { done: true, attempt: current, record: null, unknown: true };
      }
      const next = claimNextAcceptedMessage(
        root,
        workerId,
        attemptId,
        pumpOwnerDigest,
        env
      );
      if (!next.record) {
        const closed = tryCloseAttemptMailbox(root, workerId, attemptId, {
          reason: "empty-drain",
          pumpOwnerDigest
        }, env);
        return {
          done: true,
          attempt: closed || next.attempt,
          record: null,
          closed: Boolean(closed)
        };
      }
      return { done: false, attempt: next.attempt, record: next.record };
    });

    if (claimed.done) {
      if (claimed.cancelled) {
        throw new CompanionError(
          "E_CANCELLED",
          "Grok job was cancelled before the next mailbox turn."
        );
      }
      return {
        attempt: claimed.attempt,
        turns,
        finalReportSequence: claimed.attempt?.finalReportSequence ?? null,
        deliveryUnknown: claimed.unknown === true || deliveryUnknown,
        closed: claimed.attempt?.state === "closed"
      };
    }

    const record = claimed.record;
    const body = record._privateBody;
    if (typeof body !== "string" || !body) {
      throw new CompanionError("E_STATE", "Claimed mailbox message body is unavailable.");
    }

    let composed;
    try {
      composed = composePrompt({ message: body, sequence: record.sequence, record });
    } catch (error) {
      inTransaction((transaction) => {
        const rejected = settleMessageRejected(root, {
          workerId,
          attemptId,
          messageId: record.messageId,
          reason: "compose-failed"
        }, env);
        appendMailboxOutcome(transaction, workerId, rejected);
        return rejected;
      });
      continue;
    }

    const promptText = typeof composed === "string" ? composed : composed?.prompt;
    const composedPromptDigest = typeof composed === "object" && composed?.digest
      ? composed.digest
      : contentDigestOf(promptText);
    if (typeof promptText !== "string" || !promptText) {
      inTransaction((transaction) => {
        const rejected = settleMessageRejected(root, {
          workerId,
          attemptId,
          messageId: record.messageId,
          reason: "compose-empty"
        }, env);
        appendMailboxOutcome(transaction, workerId, rejected);
        return rejected;
      });
      continue;
    }

    let rpcRequestId;
    try {
      rpcRequestId = client.reserveRequestId();
      const transition = inTransaction((transaction) => {
        if (cancellationRequested()) {
          return {
            cancelled: true,
            attempt: settleCancellation(transaction)
          };
        }
        return {
          cancelled: false,
          record: markMessageInflight(root, {
            workerId,
            attemptId,
            messageId: record.messageId,
            rpcRequestId,
            composedPromptDigest,
            pumpOwnerDigest
          }, env)
        };
      });
      if (transition.cancelled) {
        throw new CompanionError(
          "E_CANCELLED",
          "Grok job was cancelled before mailbox dispatch."
        );
      }
    } catch (error) {
      if (error?.code === "E_CANCELLED") throw error;
      const latest = readMailboxMessage(root, workerId, attemptId, record.messageId, env);
      if (latest?.state === "inflight") {
        const settled = inTransaction((transaction) => {
          const unknown = settleMessageUnknown(root, {
            workerId,
            attemptId,
            messageId: record.messageId,
            reason: "inflight-persist-ambiguous",
            pumpOwnerDigest
          }, env);
          appendMailboxOutcome(transaction, workerId, unknown.record);
          return unknown;
        });
        const closed = inTransaction(() => tryCloseAttemptMailbox(
          root,
          workerId,
          attemptId,
          { reason: "delivery-unknown", pumpOwnerDigest },
          env
        ));
        return {
          attempt: closed || settled.attempt,
          turns: [...turns, settled.turn],
          finalReportSequence: null,
          deliveryUnknown: true,
          closed: (closed || settled.attempt)?.state === "closed",
          error
        };
      }
      inTransaction((transaction) => {
        const rejected = settleMessageRejected(root, {
          workerId,
          attemptId,
          messageId: record.messageId,
          reason: "inflight-persist-failed"
        }, env);
        appendMailboxOutcome(transaction, workerId, rejected);
        return rejected;
      });
      continue;
    }

    let promptResult;
    let promptError = null;
    let promptStructuredOutput;
    let promptStructuredOutputError;
    const textCollector = typeof collectTurnText === "function"
      ? collectTurnText()
      : { text: () => "" };
    try {
      promptResult = await client.dispatchReserved(
        rpcRequestId,
        "session/prompt",
        {
          sessionId,
          prompt: [{ type: "text", text: promptText }],
          ...(normalizedOutputSchema
            ? { _meta: { outputSchema: normalizedOutputSchema } }
            : {})
        },
        timeoutMs,
        {
          validateResult: validatePromptResponse
        }
      );
      const structured = structuredPromptResult(
        promptResult,
        normalizedOutputSchema !== null
      );
      if (Object.hasOwn(structured, "structuredOutput")) {
        promptStructuredOutput = structured.structuredOutput;
      }
      if (Object.hasOwn(structured, "structuredOutputError")) {
        promptStructuredOutputError = structured.structuredOutputError;
      }
    } catch (error) {
      promptError = error;
    }
    if (!promptError && (client.transportError || client.closed === true)) {
      promptError = client.transportError
        || new CompanionError("E_PROTOCOL", "ACP transport closed before durable mailbox settlement.");
    }

    if (promptError
      || !promptResult
      || !isSuccessfulPromptStopReason(promptResult.stopReason)) {
      const reason = promptError?.code === "E_TIMEOUT"
        ? "prompt-timeout"
        : promptError?.code === "E_PROVIDER_EXIT"
          ? "provider-closed"
          : isCancelledPromptStopReason(promptResult?.stopReason)
            ? "prompt-cancelled"
            : promptResult?.stopReason === "refusal" || promptResult?.stopReason === "Refusal"
              ? "prompt-refused"
            : "prompt-error-or-malformed";
      const settled = inTransaction((transaction) => {
        const unknown = settleMessageUnknown(root, {
          workerId,
          attemptId,
          messageId: record.messageId,
          reason,
          pumpOwnerDigest
        }, env);
        appendMailboxOutcome(transaction, workerId, unknown.record);
        return unknown;
      });
      deliveryUnknown = true;
      turns.push(settled.turn);
      if (typeof onTurn === "function") {
        try {
          onTurn({ outcome: "delivery_unknown", record: settled.record, turn: settled.turn });
        } catch { /* non-fatal */ }
      }
      const closed = inTransaction(() => tryCloseAttemptMailbox(
        root,
        workerId,
        attemptId,
        { reason: "delivery-unknown", pumpOwnerDigest },
        env
      ));
      return {
        attempt: closed || settled.attempt,
        turns,
        finalReportSequence: (closed || settled.attempt)?.finalReportSequence ?? null,
        deliveryUnknown: true,
        closed: (closed || settled.attempt)?.state === "closed",
        error: promptError
      };
    }

    const attemptSnapshot = readAttemptMailbox(root, workerId, attemptId, env);
    const turnEntry = communicationChainEntry({
      previousDigest: attemptSnapshot.communicationChainDigest,
      contextReceiptDigest: attemptSnapshot.contextReceiptDigest,
      rolePolicyDigest: attemptSnapshot.rolePolicyDigest,
      dispatchAttemptId: attemptSnapshot.dispatchAttemptId,
      dispatchFence: attemptSnapshot.dispatchFence,
      workerProcessDigest: attemptSnapshot.workerProcessDigest,
      providerGeneration: attemptSnapshot.providerGeneration,
      providerProcessDigest: attemptSnapshot.providerProcessDigest,
      providerSessionDigest: attemptSnapshot.providerSessionDigest,
      providerCapabilityDigest: attemptSnapshot.providerCapabilityDigest,
      sequence: record.sequence,
      contentDigest: record.contentDigest,
      composedPromptDigest,
      outcome: "delivered",
      messageId: record.messageId,
      rpcRequestId
    });

    const turnText = typeof textCollector.text === "function" ? textCollector.text() : "";
    let settled;
    try {
      settled = inTransaction((transaction) => {
        const delivered = settleMessageDelivered(root, {
          workerId,
          attemptId,
          messageId: record.messageId,
          turnEntry,
          pumpOwnerDigest
        }, env);
        appendMailboxOutcome(transaction, workerId, delivered.record);
        return delivered;
      });
    } catch (error) {
      const durableRecord = readMailboxMessage(
        root,
        workerId,
        attemptId,
        record.messageId,
        env
      );
      const durableAttempt = readAttemptMailbox(root, workerId, attemptId, env);
      if (durableRecord?.state === "delivered"
        && durableRecord.turnDigest === turnEntry.turnDigest
        && durableAttempt?.communicationChainDigest === turnEntry.turnDigest
        && durableAttempt.lastCompletedSequence === record.sequence) {
        settled = {
          attempt: durableAttempt,
          record: durableRecord,
          turn: turnEntry
        };
      } else if (durableRecord?.state !== "inflight") {
        throw error;
      }
      if (settled) {
        turns.push({
          ...settled.turn,
          text: turnText,
          stopReason: promptResult.stopReason,
          ...(promptStructuredOutput !== undefined
            ? { structuredOutput: promptStructuredOutput }
            : {}),
          ...(promptStructuredOutputError !== undefined
            ? { structuredOutputError: promptStructuredOutputError }
            : {})
        });
        continue;
      }
      const unknown = inTransaction((transaction) => {
        const settledUnknown = settleMessageUnknown(root, {
          workerId,
          attemptId,
          messageId: record.messageId,
          reason: "delivered-persist-failed",
          pumpOwnerDigest
        }, env);
        appendMailboxOutcome(transaction, workerId, settledUnknown.record);
        return settledUnknown;
      });
      deliveryUnknown = true;
      turns.push(unknown.turn);
      const closed = inTransaction(() => tryCloseAttemptMailbox(
        root,
        workerId,
        attemptId,
        { reason: "delivery-unknown", pumpOwnerDigest },
        env
      ));
      return {
        attempt: closed || unknown.attempt,
        turns,
        finalReportSequence: (closed || unknown.attempt)?.finalReportSequence ?? null,
        deliveryUnknown: true,
        closed: (closed || unknown.attempt)?.state === "closed",
        error
      };
    }

    turns.push({
      ...settled.turn,
      text: turnText,
      stopReason: promptResult.stopReason,
      ...(promptStructuredOutput !== undefined
        ? { structuredOutput: promptStructuredOutput }
        : {}),
      ...(promptStructuredOutputError !== undefined
        ? { structuredOutputError: promptStructuredOutputError }
        : {})
    });
    if (typeof onTurn === "function") {
      try {
        onTurn({
          outcome: "delivered",
          record: settled.record,
          turn: settled.turn,
          text: turnText,
          stopReason: promptResult.stopReason
        });
      } catch { /* non-fatal */ }
    }
  }
}

/**
 * Compose a bounded follow-up prompt for one mailbox turn.
 */
export function composeMailboxTurnPrompt(message, {
  sequence,
  workerId = null
} = {}) {
  const header = [
    "MAILBOX_TURN_BOUNDARY",
    `sequence=${sequence}`,
    workerId ? `worker=${workerId}` : null,
    "Continue from the previous completed turn using only this message body."
  ].filter(Boolean).join("\n");
  const prompt = `${header}\n\n${message}`;
  return {
    prompt,
    digest: contentDigestOf(prompt)
  };
}
