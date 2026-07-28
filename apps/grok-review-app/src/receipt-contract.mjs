/**
 * Sanitized, signed review receipt contract shared by the Actions runner and
 * the Cloudflare control plane. Receipt objects intentionally contain only
 * identities, digests, counts, versions, and outcome metadata.
 */

import { sha256Hex } from "./crypto-util.mjs";
import {
  canonicalHeadSha,
  isCanonicalDecimalId
} from "./ids.mjs";

export const RECEIPT_SCHEMA_VERSION = "grok-review-receipt/v1";
export const RECEIPT_SIGNATURE_ALGORITHM = "Ed25519";
export const RECEIPT_MARKER_PREFIX = "grok-review-receipt:v1:";

const SHA256_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+:/@-]{0,127}$/;
// "--" is excluded so the opaque ID is safe inside a host-owned HTML comment.
const RECEIPT_ID_RE = /^(?!.*--)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BASE64URL_SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/;
const MAX_INSTRUCTIONS = 32;
const MAX_INSTRUCTION_BYTES = 32 * 1024;
const MAX_TOTAL_INSTRUCTION_BYTES = 128 * 1024;
const MAX_DIFF_BYTES = 8 * 1024 * 1024;
const MAX_CHANGED_FILES = 3_000;
const MAX_FINDINGS = 200;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

const RECEIPT_FIELDS = Object.freeze([
  "schema_version",
  "receipt_id",
  "request",
  "trigger",
  "source",
  "instructions",
  "prompt",
  "output_schema",
  "runtime",
  "model",
  "execution",
  "posting",
  "created_at"
]);

const FORBIDDEN_FIELD_NAMES = new Set([
  "code",
  "content",
  "diff_text",
  "patch",
  "prompt_content",
  "prompt_text",
  "model_output",
  "output",
  "review_body",
  "body",
  "comment",
  "comments",
  "finding",
  "findings",
  "instruction_content",
  "instruction_text",
  "repository_content",
  "token",
  "private_key",
  "credential",
  "secret"
]);

function receiptError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactObject(value, fields) {
  return (
    isPlainObject(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field))
  );
}

function isBoundedString(value, max, min = 1) {
  return (
    typeof value === "string"
    && value.length >= min
    && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isIsoTimestamp(value) {
  if (!isBoundedString(value, 64)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isSafeCount(value, max) {
  return Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function isCommitSha(value) {
  return canonicalHeadSha(value) === value;
}

function isVersion(value) {
  return typeof value === "string" && VERSION_RE.test(value);
}

function isDigest(value) {
  return typeof value === "string" && SHA256_RE.test(value);
}

function isReceiptPath(value) {
  if (!isBoundedString(value, 4096)) return false;
  if (new TextEncoder().encode(value).byteLength > 4096) return false;
  if (value.startsWith("/") || value.includes("\\") || value.endsWith("/")) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function containsForbiddenField(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenField);
  if (!isPlainObject(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_FIELD_NAMES.has(key.toLowerCase())) return true;
    if (containsForbiddenField(child)) return true;
  }
  return false;
}

function validateRequest(value) {
  return (
    exactObject(value, [
      "request_id",
      "workflow_run_id",
      "check_id",
      "installation_id",
      "repository_id",
      "pull_number"
    ])
    && isCanonicalDecimalId(value.request_id)
    && isCanonicalDecimalId(value.workflow_run_id)
    && isCanonicalDecimalId(value.check_id)
    && isCanonicalDecimalId(value.installation_id)
    && isCanonicalDecimalId(value.repository_id)
    && isCanonicalDecimalId(value.pull_number)
  );
}

function validateTrigger(value) {
  return (
    exactObject(value, ["kind", "id", "actor_id"])
    && ["automatic", "manual_comment", "check_rerun"].includes(value.kind)
    && isCanonicalDecimalId(value.id)
    && isCanonicalDecimalId(value.actor_id)
  );
}

function validateSource(value) {
  if (!exactObject(value, ["base_sha", "head_sha", "merge_base_sha", "diff"])) {
    return false;
  }
  if (
    !isCommitSha(value.base_sha)
    || !isCommitSha(value.head_sha)
    || !isCommitSha(value.merge_base_sha)
  ) {
    return false;
  }
  return (
    exactObject(value.diff, ["sha256", "bytes", "files"])
    && isDigest(value.diff.sha256)
    && isSafeCount(value.diff.bytes, MAX_DIFF_BYTES)
    && isSafeCount(value.diff.files, MAX_CHANGED_FILES)
  );
}

function validateInstructions(value) {
  if (!Array.isArray(value) || value.length > MAX_INSTRUCTIONS) return false;
  const paths = new Set();
  let total = 0;
  for (const instruction of value) {
    if (
      !exactObject(instruction, ["path", "blob_sha", "sha256", "bytes"])
      || !isReceiptPath(instruction.path)
      || !isCommitSha(instruction.blob_sha)
      || !isDigest(instruction.sha256)
      || !isSafeCount(instruction.bytes, MAX_INSTRUCTION_BYTES)
      || paths.has(instruction.path)
    ) {
      return false;
    }
    paths.add(instruction.path);
    total += instruction.bytes;
    if (total > MAX_TOTAL_INSTRUCTION_BYTES) return false;
  }
  return true;
}

function validateVersionDigest(value) {
  return (
    exactObject(value, ["version", "sha256"])
    && isVersion(value.version)
    && isDigest(value.sha256)
  );
}

function validateRuntime(value) {
  return (
    exactObject(value, [
      "plugin_commit",
      "bundle_sha256",
      "node_version",
      "grok_cli_version",
      "grok_cli_sha256",
      "grok_package_integrity_sha256",
      "grok_package_git_commit"
    ])
    && isCommitSha(value.plugin_commit)
    && isDigest(value.bundle_sha256)
    && isVersion(value.node_version)
    && isVersion(value.grok_cli_version)
    && isDigest(value.grok_cli_sha256)
    && isDigest(value.grok_package_integrity_sha256)
    && isCommitSha(value.grok_package_git_commit)
  );
}

function validateModel(value) {
  return (
    exactObject(value, ["provider", "name", "version", "effort"])
    && isVersion(value.provider)
    && isVersion(value.name)
    && isVersion(value.version)
    && isVersion(value.effort)
  );
}

function validateExecution(value) {
  return (
    exactObject(value, [
      "provider_launched",
      "structured_output_valid",
      "duration_ms",
      "finding_count"
    ])
    && typeof value.provider_launched === "boolean"
    && typeof value.structured_output_valid === "boolean"
    && isSafeCount(value.duration_ms, MAX_DURATION_MS)
    && isSafeCount(value.finding_count, MAX_FINDINGS)
  );
}

function validatePosting(value) {
  return exactObject(value, ["event"]) && value.event === "COMMENT";
}

/**
 * Validate and return a detached, JSON-safe sanitized receipt.
 * @param {unknown} value
 * @returns {{ ok: true, receipt: object } | { ok: false, reason: string }}
 */
export function validateSanitizedReceipt(value) {
  if (!exactObject(value, RECEIPT_FIELDS)) {
    return { ok: false, reason: "invalid_receipt_shape" };
  }
  if (containsForbiddenField(value)) {
    return { ok: false, reason: "forbidden_receipt_content" };
  }
  if (value.schema_version !== RECEIPT_SCHEMA_VERSION) {
    return { ok: false, reason: "invalid_receipt_schema" };
  }
  if (typeof value.receipt_id !== "string" || !RECEIPT_ID_RE.test(value.receipt_id)) {
    return { ok: false, reason: "invalid_receipt_id" };
  }
  if (!validateRequest(value.request)) {
    return { ok: false, reason: "invalid_receipt_request" };
  }
  if (!validateTrigger(value.trigger)) {
    return { ok: false, reason: "invalid_receipt_trigger" };
  }
  if (!validateSource(value.source)) {
    return { ok: false, reason: "invalid_receipt_source" };
  }
  if (!validateInstructions(value.instructions)) {
    return { ok: false, reason: "invalid_receipt_instructions" };
  }
  if (!validateVersionDigest(value.prompt)) {
    return { ok: false, reason: "invalid_receipt_prompt" };
  }
  if (!validateVersionDigest(value.output_schema)) {
    return { ok: false, reason: "invalid_receipt_output_schema" };
  }
  if (!validateRuntime(value.runtime)) {
    return { ok: false, reason: "invalid_receipt_runtime" };
  }
  if (!validateModel(value.model)) {
    return { ok: false, reason: "invalid_receipt_model" };
  }
  if (!validateExecution(value.execution)) {
    return { ok: false, reason: "invalid_receipt_execution" };
  }
  if (!validatePosting(value.posting)) {
    return { ok: false, reason: "invalid_receipt_posting" };
  }
  if (!isIsoTimestamp(value.created_at)) {
    return { ok: false, reason: "invalid_receipt_created_at" };
  }

  try {
    return { ok: true, receipt: JSON.parse(canonicalJson(value)) };
  } catch {
    return { ok: false, reason: "invalid_receipt_json" };
  }
}

function canonicalValue(value, seen) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw receiptError("invalid_canonical_number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw receiptError("cyclic_canonical_value");
    seen.add(value);
    const result = `[${value.map((item) => canonicalValue(item, seen)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  if (!isPlainObject(value)) throw receiptError("invalid_canonical_value");
  if (seen.has(value)) throw receiptError("cyclic_canonical_value");
  seen.add(value);
  const keys = Object.keys(value).sort();
  const result = `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key], seen)}`)
    .join(",")}}`;
  seen.delete(value);
  return result;
}

/**
 * Recursively key-sorted canonical JSON. Arrays retain their semantic order.
 * @param {unknown} value
 */
export function canonicalJson(value) {
  return canonicalValue(value, new Set());
}

/**
 * @param {object} receipt
 */
export async function computeReceiptDigest(receipt) {
  return sha256Hex(new TextEncoder().encode(canonicalJson(receipt)));
}

function pemToDer(pem, label) {
  if (typeof pem !== "string" || pem.length > 32 * 1024) {
    throw receiptError("invalid_receipt_key");
  }
  const normalized = pem.replace(/\r\n/g, "\n").trim();
  const match = new RegExp(
    `^-----BEGIN ${label}-----\\n([A-Za-z0-9+/=\\n]+)\\n-----END ${label}-----$`
  ).exec(normalized);
  if (!match) throw receiptError("invalid_receipt_key");
  const base64 = match[1].replace(/\n/g, "");
  let bytes;
  try {
    if (typeof Buffer !== "undefined") {
      bytes = new Uint8Array(Buffer.from(base64, "base64"));
    } else {
      const binary = atob(base64);
      bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    }
  } catch {
    throw receiptError("invalid_receipt_key");
  }
  if (bytes.byteLength === 0) throw receiptError("invalid_receipt_key");
  return bytes;
}

function base64UrlToBytes(value) {
  if (typeof value !== "string" || !BASE64URL_SIGNATURE_RE.test(value)) return null;
  try {
    if (typeof Buffer !== "undefined") {
      const bytes = new Uint8Array(Buffer.from(value, "base64url"));
      if (bytes.byteLength !== 64 || Buffer.from(bytes).toString("base64url") !== value) {
        return null;
      }
      return bytes;
    }
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "==";
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytes.byteLength === 64 ? bytes : null;
  } catch {
    return null;
  }
}

function bytesToStandardBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Derive the receipt key id from the exact Ed25519 SPKI DER bytes.
 * @param {string} publicKeyPem
 */
export async function receiptKeyId(publicKeyPem) {
  const der = pemToDer(publicKeyPem, "PUBLIC KEY");
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      der,
      { name: RECEIPT_SIGNATURE_ALGORITHM },
      false,
      ["verify"]
    );
    if (key.algorithm?.name !== RECEIPT_SIGNATURE_ALGORITHM) {
      throw receiptError("invalid_receipt_key_type");
    }
  } catch (error) {
    if (error?.code) throw error;
    throw receiptError("invalid_receipt_key_type");
  }
  return sha256Hex(der);
}

/**
 * Strictly parse the Worker public-key rotation map.
 * @param {unknown} raw
 * @returns {Promise<Map<string, { pem: string, key: CryptoKey }>>}
 */
export async function parseReceiptPublicKeys(raw) {
  let value = raw;
  if (typeof raw === "string") {
    if (raw.length === 0 || raw.length > 128 * 1024) {
      throw receiptError("invalid_receipt_public_keys");
    }
    try {
      value = JSON.parse(raw);
    } catch {
      throw receiptError("invalid_receipt_public_keys");
    }
  }
  if (!isPlainObject(value)) throw receiptError("invalid_receipt_public_keys");
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 16) {
    throw receiptError("invalid_receipt_public_keys");
  }
  const result = new Map();
  for (const [kid, pem] of entries) {
    if (!SHA256_RE.test(kid) || typeof pem !== "string") {
      throw receiptError("invalid_receipt_public_keys");
    }
    const actualKid = await receiptKeyId(pem);
    if (actualKid !== kid) throw receiptError("receipt_key_id_mismatch");
    const der = pemToDer(pem, "PUBLIC KEY");
    let key;
    try {
      key = await crypto.subtle.importKey(
        "spki",
        der,
        { name: RECEIPT_SIGNATURE_ALGORITHM },
        false,
        ["verify"]
      );
    } catch {
      throw receiptError("invalid_receipt_key_type");
    }
    result.set(kid, { pem, key });
  }
  return result;
}

/**
 * Verify a strict envelope against the configured rotation map.
 * @param {unknown} receipt
 * @param {unknown} envelope
 * @param {string|object} publicKeysJson
 */
export async function verifyReceiptEnvelope(receipt, envelope, publicKeysJson) {
  const validation = validateSanitizedReceipt(receipt);
  if (!validation.ok) return { ok: false, reason: validation.reason };
  if (
    !exactObject(envelope, ["alg", "kid", "receipt_sha256", "signature"])
    || envelope.alg !== RECEIPT_SIGNATURE_ALGORITHM
    || typeof envelope.kid !== "string"
    || !SHA256_RE.test(envelope.kid)
    || !isDigest(envelope.receipt_sha256)
  ) {
    return { ok: false, reason: "invalid_receipt_envelope" };
  }
  const signature = base64UrlToBytes(envelope.signature);
  if (!signature) return { ok: false, reason: "invalid_receipt_signature" };

  let keys;
  try {
    keys = await parseReceiptPublicKeys(publicKeysJson);
  } catch (error) {
    return { ok: false, reason: error?.code || "invalid_receipt_public_keys" };
  }
  const selected = keys.get(envelope.kid);
  if (!selected) return { ok: false, reason: "unknown_receipt_key" };

  const canonical = canonicalJson(validation.receipt);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await sha256Hex(bytes);
  if (digest !== envelope.receipt_sha256) {
    return { ok: false, reason: "receipt_digest_mismatch" };
  }
  let verified = false;
  try {
    verified = await crypto.subtle.verify(
      { name: RECEIPT_SIGNATURE_ALGORITHM },
      selected.key,
      signature,
      bytes
    );
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, reason: "receipt_signature_invalid" };
  return {
    ok: true,
    receipt: validation.receipt,
    canonical,
    envelope: {
      alg: envelope.alg,
      kid: envelope.kid,
      receipt_sha256: envelope.receipt_sha256,
      signature: envelope.signature
    }
  };
}

/**
 * Host-owned marker used for bounded review reconciliation. Model output is
 * escaped before this marker is appended by the runner.
 * @param {{ receipt_id: string }|object} receipt
 * @param {{ alg: string, kid: string, receipt_sha256: string, signature: string }} envelope
 */
export function buildReceiptMarker(receipt, envelope) {
  if (
    !receipt
    || typeof receipt.receipt_id !== "string"
    || !RECEIPT_ID_RE.test(receipt.receipt_id)
    || !exactObject(envelope, ["alg", "kid", "receipt_sha256", "signature"])
    || envelope.alg !== RECEIPT_SIGNATURE_ALGORITHM
    || !isDigest(envelope.kid)
    || !isDigest(envelope.receipt_sha256)
    || !base64UrlToBytes(envelope.signature)
  ) {
    throw receiptError("invalid_receipt_marker");
  }
  return [
    "<!-- ",
    RECEIPT_MARKER_PREFIX,
    receipt.receipt_id,
    ":",
    envelope.receipt_sha256,
    ":",
    envelope.alg,
    ":",
    envelope.kid,
    ":",
    bytesToStandardBase64(base64UrlToBytes(envelope.signature)),
    " -->"
  ].join("");
}
