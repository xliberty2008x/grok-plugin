/**
 * Canonical GitHub identity helpers.
 * External IDs remain nonzero decimal strings end-to-end — never Number()-coerced.
 */

import { HEAD_SHA_HEX_RE, MAX_DECIMAL_ID_LENGTH, POLICY_VERSION, TRIGGER_KIND } from "./constants.mjs";

/**
 * Nonzero decimal digit string (no leading zeros, no plus sign, no whitespace).
 * @param {unknown} value
 * @returns {value is string}
 */
export function isCanonicalDecimalId(value) {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= MAX_DECIMAL_ID_LENGTH
    && /^[1-9][0-9]*$/.test(value)
  );
}

/**
 * Extract a canonical decimal ID from a GitHub JSON value.
 * Accepts only string or number forms that already preserve the exact decimal.
 * Numbers above Number.MAX_SAFE_INTEGER are rejected (must arrive as strings via safe parse).
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function canonicalDecimalId(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    // Reject if trim would normalize; require exact match.
    if (trimmed !== value) return null;
    return isCanonicalDecimalId(value) ? value : null;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) {
      return null;
    }
    // Exact round-trip: no silent truncation.
    const asString = String(value);
    if (!isCanonicalDecimalId(asString) || Number(asString) !== value) {
      return null;
    }
    return asString;
  }
  return null;
}

/**
 * Parse webhook/callback JSON while preserving integer literals as decimal strings.
 * Prevents JSON.parse from corrupting IDs above 2^53-1.
 *
 * @param {string} text
 * @returns {unknown}
 */
export function parseJsonPreservingIntegerIds(text) {
  if (typeof text !== "string") {
    throw new SyntaxError("invalid json source");
  }
  let out = "";
  let i = 0;
  let inString = false;
  let escape = false;

  while (i < text.length) {
    const ch = text[i];

    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === "\"") {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === "\"") {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    // Possible number start (value context).
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let j = i;
      if (text[j] === "-") j += 1;
      const digitStart = j;
      while (j < text.length && text[j] >= "0" && text[j] <= "9") j += 1;
      if (j === digitStart) {
        out += ch;
        i += 1;
        continue;
      }
      const next = text[j];
      const isFloatOrExp = next === "." || next === "e" || next === "E";
      if (isFloatOrExp) {
        // Copy the full JSON number as-is (not used as IDs).
        let k = j;
        if (text[k] === ".") {
          k += 1;
          while (k < text.length && text[k] >= "0" && text[k] <= "9") k += 1;
        }
        if (text[k] === "e" || text[k] === "E") {
          k += 1;
          if (text[k] === "+" || text[k] === "-") k += 1;
          while (k < text.length && text[k] >= "0" && text[k] <= "9") k += 1;
        }
        out += text.slice(i, k);
        i = k;
        continue;
      }

      // Pure integer → JSON string so IDs survive intact.
      const literal = text.slice(i, j);
      out += `"${literal}"`;
      i = j;
      continue;
    }

    out += ch;
    i += 1;
  }

  return JSON.parse(out);
}

/**
 * @param {unknown} value
 * @returns {string|null} lowercase hex head SHA
 */
export function canonicalHeadSha(value) {
  if (typeof value !== "string") return null;
  if (!/^[0-9a-fA-F]+$/.test(value)) return null;
  const sha = value.toLowerCase();
  if (!HEAD_SHA_HEX_RE.test(sha)) return null;
  return sha;
}

export function createOpaqueReceiptId(randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)) {
  if (typeof randomUUID !== "function") throw new Error("receipt_id_rng_unavailable");
  const uuid = randomUUID();
  if (
    typeof uuid !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)
  ) {
    throw new Error("invalid_receipt_id_rng");
  }
  return `grr_${uuid.replaceAll("-", "").toLowerCase()}`;
}

/**
 * Automatic request key binds the exact signed webhook occurrence. Distinct
 * lifecycle actions or deliveries on the same head intentionally create new
 * requests; a replay of the same delivery resolves to the same key.
 * @param {{ installationId: string, repositoryId: string, pullNumber: string, action: string, deliveryId: string, headSha: string, policyVersion?: string }} p
 */
export function buildAutomaticRequestKey(p) {
  const policy = p.policyVersion ?? POLICY_VERSION;
  return [
    "auto",
    p.installationId,
    p.repositoryId,
    p.pullNumber,
    p.action,
    p.deliveryId,
    p.headSha,
    policy
  ].join(":");
}

/**
 * Manual comment request key binds the source comment ID.
 * @param {{ installationId: string, repositoryId: string, commentId: string }} p
 */
export function buildManualCommentRequestKey(p) {
  return ["manual_comment", p.installationId, p.repositoryId, p.commentId].join(":");
}

/**
 * Check-rerun request key binds the source check and the signed click delivery.
 * Every distinct click creates a request; delivery replay remains idempotent.
 * @param {{ installationId: string, repositoryId: string, checkRunId: string, deliveryId: string }} p
 */
export function buildCheckRerunRequestKey(p) {
  return [
    "check_rerun",
    p.installationId,
    p.repositoryId,
    p.checkRunId,
    p.deliveryId
  ].join(":");
}

/**
 * @param {string} triggerKind
 * @param {object} ids
 */
export function buildRequestKey(triggerKind, ids) {
  if (triggerKind === TRIGGER_KIND.AUTOMATIC) {
    return buildAutomaticRequestKey(ids);
  }
  if (triggerKind === TRIGGER_KIND.MANUAL_COMMENT) {
    return buildManualCommentRequestKey(ids);
  }
  if (triggerKind === TRIGGER_KIND.CHECK_RERUN) {
    return buildCheckRerunRequestKey(ids);
  }
  throw new Error("unknown_trigger_kind");
}
