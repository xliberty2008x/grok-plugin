/**
 * Authenticated runner -> Worker callback client.
 *
 * The MAC covers timestamp + nonce + the exact JSON bytes. Responses are
 * bounded and redirects are rejected so a callback secret is never forwarded
 * to another origin.
 */

import { randomBytes } from "node:crypto";

import { CALLBACK_PATH, MAX_CALLBACK_BYTES } from "../constants.mjs";
import { signCallbackMessage } from "../crypto-util.mjs";

const DEFAULT_TIMEOUT_MS = 10_000;

function callbackError(code, status = null) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function exactHttpsOrigin(value) {
  if (typeof value !== "string" || value.length > 2048) {
    throw callbackError("invalid_callback_origin");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw callbackError("invalid_callback_origin");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || url.origin !== value.replace(/\/$/, "")
  ) {
    throw callbackError("invalid_callback_origin");
  }
  return url.origin;
}

function boundedSecret(value) {
  return (
    typeof value === "string"
    && value.length >= 32
    && value.length <= 4096
    && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

async function readBoundedJson(response) {
  const declared = response.headers.get("content-length");
  if (declared && /^(0|[1-9][0-9]*)$/.test(declared)) {
    if (BigInt(declared) > BigInt(MAX_CALLBACK_BYTES)) {
      throw callbackError("callback_response_too_large", response.status);
    }
  }
  const reader = response.body?.getReader?.();
  const chunks = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_CALLBACK_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Bounded failure is already authoritative.
        }
        throw callbackError("callback_response_too_large", response.status);
      }
      chunks.push(value);
    }
  } else {
    const fallback = new Uint8Array(await response.arrayBuffer());
    if (fallback.byteLength > MAX_CALLBACK_BYTES) {
      throw callbackError("callback_response_too_large", response.status);
    }
    chunks.push(fallback);
    total = fallback.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body;
  try {
    body = bytes.byteLength
      ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
      : null;
  } catch {
    throw callbackError("callback_invalid_json", response.status);
  }
  if (!response.ok) {
    const publicCode = (
      body
      && typeof body === "object"
      && !Array.isArray(body)
      && typeof body.error === "string"
      && /^[a-z0-9_:-]{1,128}$/.test(body.error)
    )
      ? body.error
      : `callback_http_${response.status}`;
    throw callbackError(publicCode, response.status);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw callbackError("callback_invalid_response", response.status);
  }
  return body;
}

/**
 * @param {{
 *   origin: string,
 *   secret: string,
 *   fetchImpl?: typeof fetch,
 *   nowMs?: () => number,
 *   nonce?: () => string,
 *   timeoutMs?: number,
 *   maxAttempts?: number
 * }} options
 */
export function createCallbackClient(options) {
  const origin = exactHttpsOrigin(options?.origin);
  if (!boundedSecret(options?.secret)) {
    throw callbackError("invalid_callback_secret");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const nowMs = options.nowMs ?? Date.now;
  const makeNonce = options.nonce
    ?? (() => `run-${randomBytes(16).toString("hex")}`);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? 3;
  if (
    typeof fetchImpl !== "function"
    || typeof nowMs !== "function"
    || typeof makeNonce !== "function"
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > 60_000
    || !Number.isSafeInteger(maxAttempts)
    || maxAttempts < 1
    || maxAttempts > 3
  ) {
    throw callbackError("invalid_callback_client_options");
  }

  const post = async (payload) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw callbackError("invalid_callback_payload");
    }
    let raw;
    try {
      raw = JSON.stringify(payload);
    } catch {
      throw callbackError("invalid_callback_payload");
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_CALLBACK_BYTES) {
      throw callbackError("callback_payload_too_large");
    }
    const bytes = new TextEncoder().encode(raw);
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const timestamp = String(Math.floor(nowMs() / 1000));
      const nonce = makeNonce();
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(nonce)) {
        throw callbackError("invalid_callback_nonce");
      }
      const signature = await signCallbackMessage(
        bytes,
        timestamp,
        nonce,
        options.secret
      );
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${origin}${CALLBACK_PATH}`, {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "x-grok-signature": signature,
            "x-grok-timestamp": timestamp,
            "x-grok-nonce": nonce
          },
          body: raw
        });
        if (response.status >= 300 && response.status < 400) {
          throw callbackError("callback_redirect_rejected", response.status);
        }
        // Keep the same abort timer active while consuming the response body.
        return await readBoundedJson(response);
      } catch (error) {
        lastError = controller.signal.aborted
          ? callbackError("callback_timeout")
          : error?.code
            ? error
            : callbackError("callback_network_error");
        const transient = (
          lastError.code === "callback_timeout"
          || lastError.code === "callback_network_error"
          || (
            Number.isInteger(lastError.status)
            && lastError.status >= 500
            && lastError.status <= 599
          )
        );
        if (!transient || attempt === maxAttempts) throw lastError;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? callbackError("callback_network_error");
  };

  return Object.freeze({
    post,
    claim({ requestId, workflowRunId }) {
      return post({
        event: "claim",
        request_id: requestId,
        workflow_run_id: workflowRunId
      });
    },
    authorized({ requestId, workflowRunId }) {
      return post({
        event: "authorized",
        request_id: requestId,
        workflow_run_id: workflowRunId
      });
    },
    started({ requestId, workflowRunId, checkId, startedAt }) {
      return post({
        event: "started",
        request_id: requestId,
        workflow_run_id: workflowRunId,
        check_id: checkId,
        started_at: startedAt
      });
    },
    abort({ requestId, workflowRunId, status, checkId }) {
      return post({
        event: "abort",
        request_id: requestId,
        workflow_run_id: workflowRunId,
        status,
        check_id: checkId ?? null
      });
    },
    terminal({
      requestId,
      workflowRunId,
      status,
      checkId,
      receipt,
      envelope
    }) {
      return post({
        event: "terminal",
        request_id: requestId,
        workflow_run_id: workflowRunId,
        status,
        check_id: checkId ?? null,
        receipt,
        envelope
      });
    }
  });
}
