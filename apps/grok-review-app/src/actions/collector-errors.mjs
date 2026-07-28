/**
 * Stable fail-closed error surface for the exact-head collector.
 * Receipts and public errors must never embed instruction/diff content.
 */

export const CollectorErrorCode = Object.freeze({
  E_COLLECTOR_GIT_EXECUTABLE: "E_COLLECTOR_GIT_EXECUTABLE",
  E_COLLECTOR_REMOTE: "E_COLLECTOR_REMOTE",
  E_COLLECTOR_IDENTITY: "E_COLLECTOR_IDENTITY",
  E_COLLECTOR_REF: "E_COLLECTOR_REF",
  E_COLLECTOR_MERGE_BASE: "E_COLLECTOR_MERGE_BASE",
  E_COLLECTOR_FETCH: "E_COLLECTOR_FETCH",
  E_COLLECTOR_GIT: "E_COLLECTOR_GIT",
  E_COLLECTOR_PATH: "E_COLLECTOR_PATH",
  E_COLLECTOR_DIFF: "E_COLLECTOR_DIFF",
  E_COLLECTOR_LIMIT_FILES: "E_COLLECTOR_LIMIT_FILES",
  E_COLLECTOR_LIMIT_PATCH: "E_COLLECTOR_LIMIT_PATCH",
  E_COLLECTOR_INSTRUCTION: "E_COLLECTOR_INSTRUCTION",
  E_COLLECTOR_INSTRUCTION_LIMIT: "E_COLLECTOR_INSTRUCTION_LIMIT",
  E_COLLECTOR_SEAL: "E_COLLECTOR_SEAL",
  E_COLLECTOR_DISPOSAL: "E_COLLECTOR_DISPOSAL",
  E_COLLECTOR_CONFIG: "E_COLLECTOR_CONFIG",
  E_COLLECTOR_OVERFLOW: "E_COLLECTOR_OVERFLOW",
  E_COLLECTOR_STATE: "E_COLLECTOR_STATE"
});

/** Hard limits for hostile-repository-safe collection. */
export const CollectorLimits = Object.freeze({
  MAX_CHANGED_FILES: 3000,
  MAX_PATCH_BYTES: 8 * 1024 * 1024,
  MAX_INSTRUCTION_FILES: 32,
  MAX_INSTRUCTION_FILE_BYTES: 32 * 1024,
  MAX_INSTRUCTION_TOTAL_BYTES: 128 * 1024,
  MAX_PATH_BYTES: 4096,
  MAX_OWNER_LENGTH: 39,
  MAX_REPOSITORY_LENGTH: 100,
  MAX_STDERR_BYTES: 64 * 1024,
  MAX_STDOUT_DEFAULT_BYTES: 16 * 1024 * 1024,
  GIT_TIMEOUT_MS: 120_000,
  MAX_BLOB_HYDRATE_BYTES: 8 * 1024 * 1024
});

/** Canonical packet / prompt schema identity (deterministic). */
export const ReviewPacketVersions = Object.freeze({
  PACKET_SCHEMA_VERSION: 1,
  PROMPT_VERSION: "grok-review-app-prompt-v1",
  COLLECTOR_VERSION: "exact-head-v1"
});

const SAFE_RECEIPT_DETAIL_KEYS = Object.freeze([
  "code",
  "kind",
  "pathCount",
  "byteCount",
  "limit",
  "status",
  "mode",
  "objectType",
  "blobOid",
  "pathBytes",
  "sha",
  "baseTipSha",
  "mergeBaseSha",
  "headSha",
  "expectedSha",
  "actualSha",
  "refName",
  "owner",
  "repository",
  "pullNumber",
  "fileCount",
  "instructionCount",
  "totalBytes"
]);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainDetailValue(value) {
  if (value == null) return true;
  const t = typeof value;
  if (t === "string") return value.length <= 256 && !value.includes("\0");
  if (t === "number") return Number.isFinite(value);
  if (t === "boolean") return true;
  return false;
}

/**
 * Sanitize details so errors never leak instruction/diff body content.
 * @param {unknown} details
 * @returns {Record<string, string|number|boolean|null>|undefined}
 */
export function sanitizeCollectorDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  /** @type {Record<string, string|number|boolean|null>} */
  const out = {};
  for (const key of SAFE_RECEIPT_DETAIL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(details, key)) continue;
    const value = /** @type {Record<string, unknown>} */ (details)[key];
    if (!isPlainDetailValue(value)) continue;
    out[key] = /** @type {string|number|boolean|null} */ (value);
  }
  return Object.keys(out).length ? out : undefined;
}

export class CollectorError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "CollectorError";
    this.code = code;
    this.details = sanitizeCollectorDetails(details);
    Error.captureStackTrace?.(this, CollectorError);
  }

  /**
   * Body-free public projection for receipts/logs.
   * @returns {{ ok: false, code: string, details?: Record<string, string|number|boolean|null> }}
   */
  toPublicJSON() {
    const body = { ok: false, code: this.code };
    if (this.details) body.details = this.details;
    return body;
  }
}

/**
 * @param {unknown} error
 * @returns {error is CollectorError}
 */
export function isCollectorError(error) {
  return Boolean(error && typeof error === "object" && error instanceof CollectorError);
}

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {never}
 */
export function failCollector(code, message, details) {
  throw new CollectorError(code, message, details);
}
