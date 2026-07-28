/**
 * Cryptographic helpers using Web Crypto (Workers + Node 18+).
 * Constant-time comparison for secrets and HMAC digests.
 */

const textEncoder = new TextEncoder();
const SHARED_SECRET_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

export const SHARED_SECRET_MIN_BYTES = 32;
export const SHARED_SECRET_MAX_BYTES = 4096;

/**
 * @param {string} value
 * @returns {Uint8Array}
 */
export function encodeUtf8(value) {
  return textEncoder.encode(value);
}

/**
 * Validate HMAC secrets by encoded bytes rather than JavaScript code units.
 * Control characters are rejected so deployment tooling cannot silently
 * normalize a multiline or NUL-containing secret.
 */
export function isValidSharedSecret(value) {
  if (typeof value !== "string" || SHARED_SECRET_CONTROL_RE.test(value)) {
    return false;
  }
  const bytes = encodeUtf8(value).byteLength;
  return bytes >= SHARED_SECRET_MIN_BYTES && bytes <= SHARED_SECRET_MAX_BYTES;
}

/**
 * Constant-time equality for two ArrayBuffer views.
 * @param {ArrayBufferView|ArrayBuffer} a
 * @param {ArrayBufferView|ArrayBuffer} b
 * @returns {boolean}
 */
export function timingSafeEqualBytes(a, b) {
  const av = a instanceof ArrayBuffer
    ? new Uint8Array(a)
    : new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const bv = b instanceof ArrayBuffer
    ? new Uint8Array(b)
    : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  const len = Math.max(av.length, bv.length);
  let diff = av.length ^ bv.length;
  for (let i = 0; i < len; i += 1) {
    const x = i < av.length ? av[i] : 0;
    const y = i < bv.length ? bv[i] : 0;
    diff |= x ^ y;
  }
  return diff === 0;
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
export function timingSafeEqualString(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  return timingSafeEqualBytes(encodeUtf8(left), encodeUtf8(right));
}

/**
 * @param {ArrayBufferView|ArrayBuffer} bytes
 * @returns {string} lowercase hex
 */
export function bytesToHex(bytes) {
  const view = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let out = "";
  for (let i = 0; i < view.length; i += 1) {
    out += view[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * @param {string} hex
 * @returns {Uint8Array|null}
 */
export function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * @param {BufferSource} data
 * @returns {Promise<string>} sha256 hex digest
 */
export async function sha256Hex(data) {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(digest);
}

/**
 * @param {BufferSource} rawBody
 * @param {string} secret
 * @returns {Promise<Uint8Array>}
 */
export async function hmacSha256(rawBody, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encodeUtf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, rawBody);
  return new Uint8Array(mac);
}

/**
 * Verify signature header of the form sha256=<hex> against raw body.
 * @param {BufferSource} rawBody
 * @param {string|null|undefined} signatureHeader
 * @param {string} secret
 * @returns {Promise<boolean>}
 */
export async function verifySha256SignatureHeader(rawBody, signatureHeader, secret) {
  if (typeof signatureHeader !== "string" || typeof secret !== "string" || secret.length === 0) {
    return false;
  }
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(signatureHeader.trim());
  if (!match) {
    const mac = await hmacSha256(rawBody, secret);
    timingSafeEqualBytes(mac, mac);
    return false;
  }
  const provided = hexToBytes(match[1]);
  if (!provided) {
    return false;
  }
  const expected = await hmacSha256(rawBody, secret);
  return timingSafeEqualBytes(expected, provided);
}

/**
 * GitHub X-Hub-Signature-256 verification.
 * @param {BufferSource} rawBody
 * @param {string|null|undefined} signatureHeader
 * @param {string} secret
 */
export async function verifyGitHubSignature256(rawBody, signatureHeader, secret) {
  return verifySha256SignatureHeader(rawBody, signatureHeader, secret);
}

/**
 * Build the exact callback MAC message:
 *   timestamp + "\\n" + nonce + "\\n" + rawBodyBytes
 *
 * @param {string} timestamp
 * @param {string} nonce
 * @param {BufferSource} rawBody
 * @returns {Uint8Array}
 */
export function buildCallbackMacMessage(timestamp, nonce, rawBody) {
  const prefix = encodeUtf8(`${timestamp}\n${nonce}\n`);
  const body = rawBody instanceof ArrayBuffer
    ? new Uint8Array(rawBody)
    : new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
  const out = new Uint8Array(prefix.byteLength + body.byteLength);
  out.set(prefix, 0);
  out.set(body, prefix.byteLength);
  return out;
}

/**
 * Runner callback X-Grok-Signature over timestamp+nonce+raw body.
 * @param {BufferSource} rawBody
 * @param {string} timestamp
 * @param {string} nonce
 * @param {string|null|undefined} signatureHeader
 * @param {string} secret
 */
export async function verifyCallbackSignature256(
  rawBody,
  timestamp,
  nonce,
  signatureHeader,
  secret
) {
  if (typeof timestamp !== "string" || typeof nonce !== "string") {
    return false;
  }
  const message = buildCallbackMacMessage(timestamp, nonce, rawBody);
  return verifySha256SignatureHeader(message, signatureHeader, secret);
}

/**
 * Sign callback MAC for tests/tooling.
 * @param {BufferSource} rawBody
 * @param {string} timestamp
 * @param {string} nonce
 * @param {string} secret
 * @returns {Promise<string>} sha256=<hex>
 */
export async function signCallbackMessage(rawBody, timestamp, nonce, secret) {
  const message = buildCallbackMacMessage(timestamp, nonce, rawBody);
  const mac = await hmacSha256(message, secret);
  return `sha256=${bytesToHex(mac)}`;
}
