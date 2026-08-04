import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CompanionError } from "./errors.mjs";
import { redactText } from "./redact.mjs";

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

// One canonical provider-compatible schema. The public verdict is derived after validation.
export const REVIEW_SCHEMA = Object.freeze(JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"), "utf8")
));
/** Default same-session repair prompt for generic structured reviews. */
export const DEFAULT_REVIEW_REPAIR_PROMPT = "Your previous response was not valid review JSON. Return only one JSON object with exactly summary and findings. Omit verdict; the runtime derives pass from zero findings and needs_changes from one or more findings. Preserve substantive findings and use repository-relative paths.";
/** App-only suggestion replacement ceiling (UTF-8 bytes). */
export const MAX_SUGGESTION_REPLACEMENT_BYTES = 16 * 1024;
/** Aggregate validated App review JSON ceiling (UTF-8 bytes). */
export const MAX_APP_REVIEW_OUTPUT_BYTES = 512 * 1024;

export function outputSchemaDigest(outputSchema) {
  if (outputSchema == null) return null;
  if (!outputSchema
    || typeof outputSchema !== "object"
    || Array.isArray(outputSchema)) {
    throw new CompanionError("E_PROTOCOL", "Provider output schema must be a JSON object.");
  }
  let serialized;
  try {
    serialized = JSON.stringify(outputSchema);
  } catch {
    throw new CompanionError("E_PROTOCOL", "Provider output schema is not serializable JSON.");
  }
  if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) {
    throw new CompanionError("E_PROTOCOL", "Provider output schema exceeds 65536 bytes.");
  }
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

/**
 * Resolve an explicit trusted headless output schema.
 * Must be a plain JSON object, serializable, and within the 64 KiB bound.
 * Returns the generic REVIEW_SCHEMA when the caller omits the option.
 * @param {object|null|undefined} outputSchema
 * @returns {object}
 */
export function resolveTrustedOutputSchema(outputSchema) {
  if (outputSchema === undefined || outputSchema === null) return REVIEW_SCHEMA;
  outputSchemaDigest(outputSchema);
  return outputSchema;
}


export function extractJson(text) {
  const trimmed = String(text).trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) try { return JSON.parse(fenced[1]); } catch {}
  const start = trimmed.indexOf("{"), end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
  return null;
}


function reviewPathOk(file) {
  if (file === undefined || file === null) return true;
  if (typeof file !== "string" || !file.trim() || file.length > 1024) return false;
  const normalized = file.replace(/\\/g, "/");
  return !path.posix.isAbsolute(normalized)
    && !/^[A-Za-z]:\//.test(normalized)
    && !normalized.split("/").includes("..");
}

/**
 * Validate provider review payload and deterministically derive the verdict.
 * Zero findings always passes; nonzero findings always needs_changes.
 * Model-supplied verdict is rejected; the public verdict exists only after validation.
 */
export function validateReview(value) {
  const rootKeys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
  const allowedKeys = new Set(["summary", "findings"]);
  const findingsOk = Array.isArray(value?.findings) && value.findings.length <= 200 && value.findings.every((f) => f
    && typeof f === "object"
    && !Array.isArray(f)
    && Object.keys(f).every((key) => ["severity", "title", "body", "file", "line"].includes(key))
    && ["critical", "high", "medium", "low", "info"].includes(f.severity)
    && typeof f.title === "string" && f.title.trim() && f.title.length <= 240
    && typeof f.body === "string" && f.body.trim() && f.body.length <= 6000
    && reviewPathOk(f.file)
    && (f.line === undefined || f.line === null || (Number.isInteger(f.line) && f.line >= 1)));
  const ok = Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && rootKeys.every((key) => allowedKeys.has(key))
    && typeof value.summary === "string"
    && value.summary.trim()
    && value.summary.length <= 2000
    && findingsOk
  );
  if (!ok) {
    const details = {
      rootKeys: rootKeys.filter((key) => allowedKeys.has(key)).slice(0, 24),
      hasUnknownRootKeys: rootKeys.some((key) => !allowedKeys.has(key)),
      summaryType: typeof value?.summary,
      findingsCount: Array.isArray(value?.findings) ? value.findings.length : null,
      findingsShapeOk: findingsOk,
      hint: "Return only summary and findings. Omit verdict; the runtime derives it. Paths must be repository-relative and strings must stay within schema limits."
    };
    try {
      details.payloadDigest = crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
    } catch {
      details.payloadDigest = null;
    }
    throw new CompanionError("E_SCHEMA", "Grok review output did not match the required schema.", details);
  }
  const findings = value.findings.map((f) => ({
    severity: f.severity,
    title: redactText(f.title.trim()),
    body: redactText(f.body.trim()),
    ...(f.file === undefined ? {} : { file: f.file === null ? null : redactText(f.file.trim().replace(/\\/g, "/")) }),
    ...(f.line === undefined ? {} : { line: f.line })
  }));
  return {
    verdict: findings.length === 0 ? "pass" : "needs_changes",
    summary: redactText(value.summary.trim()),
    findings
  };
}

/**
 * Whether a suggestion object has the exact App structural shape
 * `{ startLine, endLine, replacement }` with correct types.
 * Safety (bounds, safe integers range order) is checked separately so unsafe
 * but structured suggestions can degrade to ordinary findings.
 * @param {unknown} value
 * @returns {boolean}
 */
function isAppSuggestionStructure(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 3) return false;
  if (!keys.includes("startLine") || !keys.includes("endLine") || !keys.includes("replacement")) {
    return false;
  }
  return typeof value.startLine === "number"
    && typeof value.endLine === "number"
    && typeof value.replacement === "string";
}

/**
 * Safe suggestion: exact structure, safe positive integers, ordered range,
 * and replacement within the 16 KiB UTF-8 ceiling. Never mutates replacement.
 * @param {unknown} value
 * @returns {value is { startLine: number, endLine: number, replacement: string }}
 */
function isSafeAppSuggestion(value) {
  if (!isAppSuggestionStructure(value)) return false;
  if (!Number.isSafeInteger(value.startLine) || !Number.isSafeInteger(value.endLine)) return false;
  if (value.startLine < 1 || value.endLine < value.startLine) return false;
  if (Buffer.byteLength(value.replacement, "utf8") > MAX_SUGGESTION_REPLACEMENT_BYTES) return false;
  if (redactText(value.replacement) !== value.replacement) return false;
  return true;
}

/**
 * App-only review validator: summary/findings plus optional exact suggestion.
 * Structurally valid but unsafe suggestions degrade to ordinary findings
 * without mutating or truncating replacement text. Aggregate output is bounded.
 * Suggestions never enter Worker Protocol v1 (this path is App-direct only).
 * @param {unknown} value
 * @returns {{ verdict: "pass"|"needs_changes", summary: string, findings: object[] }}
 */
export function validateAppReview(value) {
  const rootKeys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
  const allowedKeys = new Set(["summary", "findings"]);
  const findingKeys = new Set(["severity", "title", "body", "file", "line", "suggestion"]);

  const findingsOk = Array.isArray(value?.findings) && value.findings.length <= 200 && value.findings.every((f) => {
    if (!f || typeof f !== "object" || Array.isArray(f)) return false;
    if (!Object.keys(f).every((key) => findingKeys.has(key))) return false;
    if (!["critical", "high", "medium", "low", "info"].includes(f.severity)) return false;
    if (typeof f.title !== "string" || !f.title.trim() || f.title.length > 240) return false;
    if (typeof f.body !== "string" || !f.body.trim() || f.body.length > 6000) return false;
    if (!reviewPathOk(f.file)) return false;
    if (!(f.line === undefined || f.line === null || (Number.isInteger(f.line) && f.line >= 1))) return false;
    if (f.suggestion === undefined) return true;
    // Malformed structure fails validation; unsafe-but-structured degrades later.
    return isAppSuggestionStructure(f.suggestion);
  });

  const ok = Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && rootKeys.every((key) => allowedKeys.has(key))
    && typeof value.summary === "string"
    && value.summary.trim()
    && value.summary.length <= 2000
    && findingsOk
  );
  if (!ok) {
    const details = {
      rootKeys: rootKeys.filter((key) => allowedKeys.has(key)).slice(0, 24),
      hasUnknownRootKeys: rootKeys.some((key) => !allowedKeys.has(key)),
      summaryType: typeof value?.summary,
      findingsCount: Array.isArray(value?.findings) ? value.findings.length : null,
      findingsShapeOk: findingsOk,
      hint: "Return only summary and findings. Optional suggestion must be exactly {startLine,endLine,replacement}. Omit verdict."
    };
    try {
      details.payloadDigest = crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
    } catch {
      details.payloadDigest = null;
    }
    throw new CompanionError("E_SCHEMA", "Grok App review output did not match the required schema.", details);
  }

  const findings = value.findings.map((f) => {
    const finding = {
      severity: f.severity,
      title: redactText(f.title.trim()),
      body: redactText(f.body.trim()),
      ...(f.file === undefined ? {} : { file: f.file === null ? null : redactText(f.file.trim().replace(/\\/g, "/")) }),
      ...(f.line === undefined ? {} : { line: f.line })
    };
    if (f.suggestion !== undefined && isSafeAppSuggestion(f.suggestion)) {
      // Preserve replacement bytes exactly (no redact/truncate). Title/body already redacted.
      finding.suggestion = {
        startLine: f.suggestion.startLine,
        endLine: f.suggestion.endLine,
        replacement: f.suggestion.replacement
      };
    }
    // Unsafe structured suggestion: degrade to ordinary finding (omit suggestion).
    return finding;
  });

  const review = {
    verdict: findings.length === 0 ? "pass" : "needs_changes",
    summary: redactText(value.summary.trim()),
    findings
  };

  let serialized;
  try {
    serialized = JSON.stringify(review);
  } catch {
    throw new CompanionError("E_SCHEMA", "Grok App review output is not JSON-serializable.");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_APP_REVIEW_OUTPUT_BYTES) {
    throw new CompanionError(
      "E_SCHEMA",
      `Grok App review output exceeds ${MAX_APP_REVIEW_OUTPUT_BYTES} bytes.`,
      { bytes: Buffer.byteLength(serialized, "utf8") }
    );
  }
  return review;
}

/**
 * Select an ACP session/request_permission option using exact protocol semantics.
 * Write profiles may only accept allow-once; read-only profiles only reject/deny.
 * Labels/names are never trusted. allow-always / allow-session are never selected.
 * Conflicting kind/optionId pairs (e.g. kind allow_once with optionId allow-always)
 * are rejected on both exact and legacy branches.
 */
export function selectAcpPermissionOption(options, { write = false } = {}) {
  const list = Array.isArray(options) ? options.filter((option) => option && typeof option === "object") : [];
  const kindOf = (option) => String(option.kind || "");
  const idOf = (option) => String(option.optionId || "");
  const isAllowAlwaysOrSession = (option) => {
    const kind = kindOf(option);
    const id = idOf(option);
    return kind === "allow_always" || kind === "allow-always" || kind === "allow_session" || kind === "allow-session"
      || id === "allow_always" || id === "allow-always" || id === "allow_session" || id === "allow-session";
  };
  const isAnyAllow = (option) => {
    if (isAllowAlwaysOrSession(option)) return true;
    const kind = kindOf(option);
    const id = idOf(option);
    return kind === "allow_once" || kind === "allow-once"
      || id === "allow-once" || id === "allow_once";
  };
  const isAllowOnce = (option) => {
    // Non-empty optionId required (protocol answers with optionId; UUID ids + kind allow_once ok).
    // Reject when either field signals allow-always/session; accept allow-once hyphen/underscore forms.
    if (!idOf(option) || isAllowAlwaysOrSession(option)) return false;
    const kind = kindOf(option);
    const id = idOf(option);
    return kind === "allow_once" || kind === "allow-once"
      || id === "allow-once" || id === "allow_once";
  };
  const isRejectOrDeny = (option) => {
    if (!idOf(option) || isAnyAllow(option)) return false;
    const kind = kindOf(option);
    const id = idOf(option);
    // Exact reject/deny forms.
    if (kind === "reject_once" || kind === "reject_always" || kind === "deny"
      || id === "reject-once" || id === "reject-always" || id === "deny") return true;
    // Legacy hyphen/underscore variants.
    return kind === "reject-once" || kind === "reject-always" || kind === "deny_once" || kind === "deny-once"
      || id === "reject_once" || id === "reject_always" || id === "deny_once" || id === "deny-once";
  };

  if (write) {
    // Write may select only a nonpersistent allow-once option; reject any allow-always/session
    // signal in either kind or optionId on both exact and legacy matches.
    return list.find((option) => isAllowOnce(option)) || null;
  }

  // Read-only: never return an allow option even when kind says reject/deny.
  return list.find((option) => isRejectOrDeny(option)) || null;
}
