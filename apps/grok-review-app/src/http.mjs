/**
 * Neutral HTTP helpers. Never log bodies, comments, or receipt contents.
 */

import {
  ALLOWED_JSON_CONTENT_TYPES,
  MAX_CALLBACK_BYTES,
  MAX_WEBHOOK_BYTES
} from "./constants.mjs";

/**
 * @param {number} status
 * @param {Record<string, unknown>} body
 * @param {Record<string, string>} [headers]
 * @returns {Response}
 */
export function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers
    }
  });
}

/**
 * @param {Record<string, unknown>} [extra]
 */
export function ok(extra = {}) {
  return jsonResponse(200, { ok: true, ...extra });
}

/**
 * @param {number} status
 * @param {string} code
 */
export function errorResponse(status, code) {
  return jsonResponse(status, { ok: false, error: code });
}

/**
 * Exact JSON content-type allowlist (case-insensitive type/subtype + charset).
 * @param {string|null} header
 * @returns {boolean}
 */
export function isAllowedJsonContentType(header) {
  if (typeof header !== "string") return false;
  const normalized = header.trim().toLowerCase().replace(/\s+/g, "");
  // Rebuild comparable forms.
  const candidates = ALLOWED_JSON_CONTENT_TYPES.map((c) => c.replace(/\s+/g, ""));
  return candidates.includes(normalized);
}

/**
 * Read a request body with a hard byte ceiling.
 * @param {Request} request
 * @param {number} maxBytes
 * @returns {Promise<{ ok: true, bytes: Uint8Array } | { ok: false, reason: string }>}
 */
export async function readBodyWithLimit(request, maxBytes) {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(contentLength)) {
      return { ok: false, reason: "invalid_content_length" };
    }
    // Compare as BigInt-safe decimal strings for large values, but max is small.
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      return { ok: false, reason: "invalid_content_length" };
    }
    if (declared > maxBytes) {
      return { ok: false, reason: "payload_too_large" };
    }
  }

  const reader = request.body?.getReader?.();
  if (!reader) {
    return { ok: true, bytes: new Uint8Array(0) };
  }

  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      return { ok: false, reason: "payload_too_large" };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/**
 * @param {Request} request
 */
export function readWebhookBody(request) {
  return readBodyWithLimit(request, MAX_WEBHOOK_BYTES);
}

/**
 * @param {Request} request
 */
export function readCallbackBody(request) {
  return readBodyWithLimit(request, MAX_CALLBACK_BYTES);
}

/**
 * @param {string} level
 * @param {string} message
 * @param {Record<string, string|number|boolean|null|undefined>} [fields]
 */
export function logSafe(level, message, fields = {}) {
  const line = JSON.stringify({ level, message, ...fields });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}
