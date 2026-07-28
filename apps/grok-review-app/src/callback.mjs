/**
 * Authenticated internal runner callback.
 *
 * HMAC(timestamp + nonce + raw body) authenticates transport. Terminal
 * callbacks additionally require an independently signed Ed25519 sanitized
 * receipt whose identities are rebound to D1 before the atomic state change.
 */

import {
  ABORT_STATUS,
  CALLBACK_EVENT,
  CALLBACK_TIMESTAMP_SKEW_SECONDS,
  REQUEST_STATUS,
  TERMINAL_RECEIPT_STATUS,
  TRIGGER_KIND
} from "./constants.mjs";
import {
  isValidSharedSecret,
  sha256Hex,
  verifyCallbackSignature256
} from "./crypto-util.mjs";
import {
  admitCallbackNonce,
  authorizeReviewRequestWithOutbox,
  casAbortRequest,
  casClaimExecutor,
  casCommitTerminalWithReceipt,
  casMarkStarted,
  getReceiptById,
  getReceiptByRequestId,
  getRequestById
} from "./db.mjs";
import {
  errorResponse,
  isAllowedJsonContentType,
  logSafe,
  ok,
  readCallbackBody
} from "./http.mjs";
import { canonicalDecimalId } from "./ids.mjs";
import {
  validateSanitizedReceipt,
  verifyReceiptEnvelope
} from "./receipt-contract.mjs";

const MAX_NONCE_LEN = 128;

function hasOnlyAllowedKeys(body, allowed) {
  const keys = Object.keys(body);
  return keys.length === allowed.length && allowed.every((key) => keys.includes(key));
}

function isIsoTimestamp(value) {
  return (
    typeof value === "string"
    && value.length <= 64
    && !Number.isNaN(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value
  );
}

/**
 * Sanitized claim identity already stored in D1; the runner still re-fetches
 * authoritative GitHub state before collecting or posting.
 * @param {object} row
 * @param {string} result
 */
export function buildClaimResponse(row, result) {
  return {
    result,
    request_id: String(row.request_id),
    receipt_id: row.receipt_id,
    installation_id: String(row.installation_id),
    repository_id: String(row.repository_id),
    pull_number: String(row.pull_number),
    trigger_kind: row.trigger_kind,
    trigger_id: String(row.trigger_id),
    actor_id: String(row.actor_id),
    expected_head_sha: row.expected_head_sha ?? null,
    policy_version: row.policy_version ?? null,
    workflow_run_id: row.workflow_run_id != null ? String(row.workflow_run_id) : null
  };
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, value: object } | { ok: false, reason: string }}
 */
export function parseCallbackPayload(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "invalid_json" };
  }
  const body = /** @type {Record<string, unknown>} */ (raw);

  if (body.event === CALLBACK_EVENT.CLAIM) {
    if (!hasOnlyAllowedKeys(body, ["event", "request_id", "workflow_run_id"])) {
      return { ok: false, reason: "unexpected_field" };
    }
    const requestId = canonicalDecimalId(body.request_id);
    const workflowRunId = canonicalDecimalId(body.workflow_run_id);
    if (!requestId || !workflowRunId) return { ok: false, reason: "invalid_ids" };
    return {
      ok: true,
      value: { event: CALLBACK_EVENT.CLAIM, requestId, workflowRunId }
    };
  }

  if (body.event === CALLBACK_EVENT.AUTHORIZED) {
    if (!hasOnlyAllowedKeys(body, ["event", "request_id", "workflow_run_id"])) {
      return { ok: false, reason: "unexpected_field" };
    }
    const requestId = canonicalDecimalId(body.request_id);
    const workflowRunId = canonicalDecimalId(body.workflow_run_id);
    if (!requestId || !workflowRunId) return { ok: false, reason: "invalid_ids" };
    return {
      ok: true,
      value: { event: CALLBACK_EVENT.AUTHORIZED, requestId, workflowRunId }
    };
  }

  if (body.event === CALLBACK_EVENT.STARTED) {
    if (!hasOnlyAllowedKeys(body, [
      "event",
      "request_id",
      "workflow_run_id",
      "check_id",
      "started_at"
    ])) {
      return { ok: false, reason: "unexpected_field" };
    }
    const requestId = canonicalDecimalId(body.request_id);
    const workflowRunId = canonicalDecimalId(body.workflow_run_id);
    const checkId = canonicalDecimalId(body.check_id);
    if (!requestId || !workflowRunId || !checkId) {
      return { ok: false, reason: "invalid_ids" };
    }
    if (!isIsoTimestamp(body.started_at)) {
      return { ok: false, reason: "invalid_started_at" };
    }
    return {
      ok: true,
      value: {
        event: CALLBACK_EVENT.STARTED,
        requestId,
        workflowRunId,
        checkId,
        startedAt: body.started_at
      }
    };
  }

  if (body.event === CALLBACK_EVENT.ABORT) {
    if (!hasOnlyAllowedKeys(body, [
      "event",
      "request_id",
      "workflow_run_id",
      "status",
      "check_id"
    ])) {
      return { ok: false, reason: "unexpected_field" };
    }
    const requestId = canonicalDecimalId(body.request_id);
    const workflowRunId = canonicalDecimalId(body.workflow_run_id);
    const checkId = body.check_id === null
      ? null
      : canonicalDecimalId(body.check_id);
    if (!requestId || !workflowRunId || (body.check_id !== null && !checkId)) {
      return { ok: false, reason: "invalid_ids" };
    }
    if (
      typeof body.status !== "string"
      || !Object.values(ABORT_STATUS).includes(body.status)
    ) {
      return { ok: false, reason: "invalid_status" };
    }
    return {
      ok: true,
      value: {
        event: CALLBACK_EVENT.ABORT,
        requestId,
        workflowRunId,
        checkId,
        status: body.status
      }
    };
  }

  if (body.event === CALLBACK_EVENT.TERMINAL) {
    if (!hasOnlyAllowedKeys(body, [
      "event",
      "request_id",
      "workflow_run_id",
      "status",
      "check_id",
      "receipt",
      "envelope"
    ])) {
      return { ok: false, reason: "unexpected_field" };
    }
    const requestId = canonicalDecimalId(body.request_id);
    const workflowRunId = canonicalDecimalId(body.workflow_run_id);
    const checkId = canonicalDecimalId(body.check_id);
    if (!requestId || !workflowRunId || !checkId) {
      return { ok: false, reason: "invalid_ids" };
    }
    if (
      typeof body.status !== "string"
      || !Object.values(TERMINAL_RECEIPT_STATUS).includes(body.status)
    ) {
      return { ok: false, reason: "invalid_status" };
    }
    const receiptValidation = validateSanitizedReceipt(body.receipt);
    if (!receiptValidation.ok) {
      return { ok: false, reason: receiptValidation.reason };
    }
    if (!body.envelope || typeof body.envelope !== "object" || Array.isArray(body.envelope)) {
      return { ok: false, reason: "invalid_receipt_envelope" };
    }
    return {
      ok: true,
      value: {
        event: CALLBACK_EVENT.TERMINAL,
        requestId,
        workflowRunId,
        checkId,
        status: body.status,
        receipt: receiptValidation.receipt,
        envelope: body.envelope
      }
    };
  }

  return { ok: false, reason: "invalid_event" };
}

function requestStatusForTerminal(receiptStatus) {
  if (receiptStatus === TERMINAL_RECEIPT_STATUS.COMPLETED) return REQUEST_STATUS.COMPLETED;
  if (receiptStatus === TERMINAL_RECEIPT_STATUS.CANCELLED) return REQUEST_STATUS.CANCELLED;
  return REQUEST_STATUS.FAILED;
}

function requestStatusForAbort(status) {
  return status === ABORT_STATUS.CANCELLED
    ? REQUEST_STATUS.CANCELLED
    : REQUEST_STATUS.FAILED;
}

/**
 * @param {Request} request
 * @param {number} [nowMs]
 */
export function readCallbackAuthHeaders(request, nowMs = Date.now()) {
  const signature = request.headers.get("x-grok-signature");
  const timestampHeader = request.headers.get("x-grok-timestamp");
  const nonce = request.headers.get("x-grok-nonce");

  if (typeof signature !== "string" || signature.length === 0) {
    return { ok: false, reason: "unauthorized" };
  }
  if (typeof timestampHeader !== "string" || !/^[1-9][0-9]{9,11}$/.test(timestampHeader)) {
    return { ok: false, reason: "invalid_timestamp" };
  }
  if (
    typeof nonce !== "string"
    || nonce.length === 0
    || nonce.length > MAX_NONCE_LEN
    || !/^[A-Za-z0-9._:-]+$/.test(nonce)
  ) {
    return { ok: false, reason: "invalid_nonce" };
  }
  const tsSec = Number(timestampHeader);
  if (!Number.isSafeInteger(tsSec)) return { ok: false, reason: "invalid_timestamp" };
  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - tsSec) > CALLBACK_TIMESTAMP_SKEW_SECONDS) {
    return { ok: false, reason: "timestamp_skew" };
  }
  return { ok: true, signature, timestamp: timestampHeader, nonce };
}

function receiptBoundToRequest(receipt, requestRow, callback) {
  const request = receipt.request;
  const trigger = receipt.trigger;
  if (
    request.request_id !== callback.requestId
    || receipt.receipt_id !== requestRow.receipt_id
    || request.workflow_run_id !== callback.workflowRunId
    || request.check_id !== callback.checkId
    || request.installation_id !== String(requestRow.installation_id)
    || request.repository_id !== String(requestRow.repository_id)
    || request.pull_number !== String(requestRow.pull_number)
    || trigger.kind !== requestRow.trigger_kind
    || trigger.id !== String(requestRow.trigger_id)
    || trigger.actor_id !== String(requestRow.actor_id)
  ) {
    return false;
  }
  if (
    requestRow.trigger_kind === TRIGGER_KIND.AUTOMATIC
    && receipt.source.head_sha !== requestRow.expected_head_sha
  ) {
    return false;
  }
  if (
    callback.status === TERMINAL_RECEIPT_STATUS.COMPLETED
    && (
      receipt.execution.provider_launched !== true
      || receipt.execution.structured_output_valid !== true
    )
  ) {
    return false;
  }
  return true;
}

/**
 * @param {Request} request
 * @param {object} env
 * @param {{ nowMs?: number }} [options]
 */
export async function handleCallback(request, env, options = {}) {
  if (request.method !== "POST") return errorResponse(405, "method_not_allowed");
  if (!isAllowedJsonContentType(request.headers.get("content-type"))) {
    return errorResponse(415, "unsupported_media_type");
  }
  const secret = env.RUNNER_CALLBACK_SECRET;
  if (!isValidSharedSecret(secret)) {
    logSafe("error", "callback_secret_invalid", {});
    return errorResponse(500, "misconfigured");
  }
  const auth = readCallbackAuthHeaders(request, options.nowMs ?? Date.now());
  if (!auth.ok) {
    return errorResponse(auth.reason === "unauthorized" ? 401 : 400, auth.reason);
  }
  const bodyResult = await readCallbackBody(request);
  if (!bodyResult.ok) {
    return errorResponse(
      bodyResult.reason === "payload_too_large" ? 413 : 400,
      bodyResult.reason === "payload_too_large" ? "payload_too_large" : "invalid_body"
    );
  }
  const rawBody = bodyResult.bytes;
  if (!await verifyCallbackSignature256(
    rawBody,
    auth.timestamp,
    auth.nonce,
    auth.signature,
    secret
  )) {
    logSafe("error", "callback_signature_invalid", {});
    return errorResponse(401, "unauthorized");
  }

  const payloadDigest = await sha256Hex(rawBody);
  const receivedAt = new Date().toISOString();
  const nonceAdmission = await admitCallbackNonce(env.DB, {
    nonce: auth.nonce,
    payloadDigest,
    receivedAt
  });
  if (nonceAdmission === "mismatch") return errorResponse(409, "nonce_digest_mismatch");
  if (nonceAdmission === "replay") return ok({ result: "replay", replay: true });

  let raw;
  try {
    // Callback IDs are required to be decimal strings. Standard parsing keeps
    // safe receipt counts as numbers, preserving the signed canonical form.
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch {
    return errorResponse(400, "invalid_json");
  }
  const parsed = parseCallbackPayload(raw);
  if (!parsed.ok) return errorResponse(400, parsed.reason);
  const data = parsed.value;
  const requestRow = await getRequestById(env.DB, data.requestId);
  if (!requestRow) return errorResponse(404, "request_not_found");
  if (
    requestRow.workflow_run_id == null
    || String(requestRow.workflow_run_id) !== data.workflowRunId
  ) {
    return errorResponse(409, "workflow_binding_mismatch");
  }
  const now = new Date().toISOString();

  if (data.event === CALLBACK_EVENT.CLAIM) {
    const changed = await casClaimExecutor(env.DB, data.requestId, data.workflowRunId, now);
    if (!changed) {
      const current = await getRequestById(env.DB, data.requestId);
      if (
        current
        && String(current.workflow_run_id) === data.workflowRunId
        && [
          REQUEST_STATUS.CLAIMED,
          REQUEST_STATUS.STARTED,
          REQUEST_STATUS.COMPLETED,
          REQUEST_STATUS.FAILED,
          REQUEST_STATUS.CANCELLED
        ].includes(current.status)
      ) {
        return ok(buildClaimResponse(current, "already_claimed"));
      }
      return errorResponse(409, "invalid_state_transition");
    }
    const claimed = await getRequestById(env.DB, data.requestId);
    logSafe("info", "callback_claim", { request_id: data.requestId });
    return ok(buildClaimResponse(claimed, "claimed"));
  }

  if (data.event === CALLBACK_EVENT.AUTHORIZED) {
    const outcome = await authorizeReviewRequestWithOutbox(
      env.DB,
      data.requestId,
      data.workflowRunId,
      now
    );
    const current = await getRequestById(env.DB, data.requestId);
    if (outcome.authorized) {
      logSafe("info", "callback_authorized", { request_id: data.requestId });
      return ok(buildClaimResponse(current, "authorized"));
    }
    if (
      current
      && current.authorized_at != null
      && String(current.workflow_run_id) === data.workflowRunId
      && Object.values(TRIGGER_KIND).includes(current.trigger_kind)
      && [REQUEST_STATUS.CLAIMED, REQUEST_STATUS.STARTED].includes(current.status)
    ) {
      return ok(buildClaimResponse(current, "already_authorized"));
    }
    return errorResponse(409, "invalid_state_transition");
  }

  if (data.event === CALLBACK_EVENT.STARTED) {
    const changed = await casMarkStarted(
      env.DB,
      data.requestId,
      data.workflowRunId,
      data.checkId,
      now
    );
    if (!changed) {
      const current = await getRequestById(env.DB, data.requestId);
      if (
        current
        && current.status === REQUEST_STATUS.STARTED
        && String(current.workflow_run_id) === data.workflowRunId
        && String(current.check_run_id) === data.checkId
      ) {
        return ok({ result: "already_started", request_id: data.requestId });
      }
      return errorResponse(409, "invalid_state_transition");
    }
    logSafe("info", "callback_started", { request_id: data.requestId });
    return ok({ result: "started", request_id: data.requestId });
  }

  if (data.event === CALLBACK_EVENT.ABORT) {
    const status = requestStatusForAbort(data.status);
    const changed = await casAbortRequest(env.DB, data.requestId, {
      status,
      workflowRunId: data.workflowRunId,
      checkRunId: data.checkId,
      updatedAt: now
    });
    if (changed) {
      logSafe("info", "callback_abort", {
        request_id: data.requestId,
        status: data.status
      });
      return ok({ result: "aborted", request_id: data.requestId });
    }
    const current = await getRequestById(env.DB, data.requestId);
    const receipt = await getReceiptByRequestId(env.DB, data.requestId);
    const checkMatches = data.checkId === null
      ? current?.check_run_id == null
      : String(current?.check_run_id) === data.checkId;
    if (
      !receipt
      && current
      && current.status === status
      && String(current.workflow_run_id) === data.workflowRunId
      && checkMatches
    ) {
      return ok({ result: "already_aborted", request_id: data.requestId });
    }
    return errorResponse(409, "invalid_state_transition");
  }

  if (
    typeof env.RECEIPT_PUBLIC_KEYS_JSON !== "string"
    || env.RECEIPT_PUBLIC_KEYS_JSON.length === 0
  ) {
    return errorResponse(500, "receipt_keys_misconfigured");
  }
  const verified = await verifyReceiptEnvelope(
    data.receipt,
    data.envelope,
    env.RECEIPT_PUBLIC_KEYS_JSON
  );
  if (!verified.ok) return errorResponse(400, verified.reason);
  if (!receiptBoundToRequest(verified.receipt, requestRow, data)) {
    return errorResponse(409, "receipt_binding_mismatch");
  }

  const receiptId = verified.receipt.receipt_id;
  const byRequest = await getReceiptByRequestId(env.DB, data.requestId);
  if (byRequest) {
    if (byRequest.payload_digest === payloadDigest) {
      return ok({ result: "replay", receipt_id: byRequest.receipt_id });
    }
    return errorResponse(409, "receipt_digest_mismatch");
  }
  const byReceiptId = await getReceiptById(env.DB, receiptId);
  if (byReceiptId) {
    if (byReceiptId.payload_digest === payloadDigest) {
      return ok({ result: "replay", receipt_id: receiptId });
    }
    return errorResponse(409, "receipt_digest_mismatch");
  }

  const outcome = await casCommitTerminalWithReceipt(
    env.DB,
    data.requestId,
    {
      status: requestStatusForTerminal(data.status),
      workflowRunId: data.workflowRunId,
      checkRunId: data.checkId,
      updatedAt: now
    },
    {
      receiptId,
      workflowRunId: data.workflowRunId,
      event: CALLBACK_EVENT.TERMINAL,
      status: data.status,
      checkId: data.checkId,
      receiptJson: verified.canonical,
      algorithm: verified.envelope.alg,
      keyId: verified.envelope.kid,
      signature: verified.envelope.signature,
      receiptDigest: verified.envelope.receipt_sha256,
      findingCount: verified.receipt.execution.finding_count,
      payloadDigest,
      createdAt: now
    }
  );
  if (outcome === "committed") {
    logSafe("info", "callback_terminal", {
      request_id: data.requestId,
      receipt_id: receiptId,
      status: data.status
    });
    return ok({ result: "accepted", receipt_id: receiptId });
  }
  const raced = await getReceiptByRequestId(env.DB, data.requestId);
  if (raced && raced.payload_digest === payloadDigest) {
    return ok({ result: "replay", receipt_id: raced.receipt_id });
  }
  if (raced) return errorResponse(409, "receipt_digest_mismatch");
  return errorResponse(409, "invalid_state_transition");
}
