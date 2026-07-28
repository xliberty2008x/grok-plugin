/**
 * Map companion / App review JSON + RIGHT-side diff targets to a GitHub
 * create-review body (always event COMMENT).
 *
 * @typedef {{ severity: string, title: string, body: string, file?: string|null, line?: number|null, suggestion?: { startLine: number, endLine: number, replacement: string }|null }} Finding
 * @typedef {{ skip: true, reason: string } | { skip: false, payload: object }} BuildResult
 * @typedef {{ hasLine: (filePath: string, line: number) => boolean, hasRange: (filePath: string, startLine: number, endLine: number) => boolean }} RightSideLookup
 */

import { redactText } from "../../../plugins/grok/scripts/lib/redact.mjs";

export const MAX_REVIEW_BODY_BYTES = 60 * 1024;
export const MAX_INLINE_BODY_BYTES = 60 * 1024;
export const MAX_INLINE_COMMENTS = 50;
export const MAX_PAYLOAD_JSON_BYTES = 512 * 1024;
export const MAX_SUGGESTION_REPLACEMENT_BYTES = 16 * 1024;
export const GROK_REVIEW_RECEIPT_NAMESPACE = "grok-review-receipt";

/**
 * Choose a Markdown fence longer than any backtick run in `text` (min 3).
 * @param {string} text
 * @returns {string}
 */
export function suggestionFence(text) {
  const runs = String(text ?? "").match(/`+/g) || [];
  let longest = 0;
  for (const run of runs) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * True when a string contains characters the publication sanitizer would strip
 * or rewrite (controls, bidi, HTML tags, mentions, reserved receipt namespace).
 * Used to decide whether a suggestion replacement can be published unchanged.
 * @param {string} text
 * @returns {boolean}
 */
function publicationWouldAlter(text) {
  const value = String(text ?? "");
  if (redactText(value) !== value) return true;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) return true;
  if (/[\u202A-\u202E\u2066-\u2069]/.test(value)) return true;
  if (/<\/?[a-zA-Z][^>]*>/.test(value)) return true;
  if (/(^|[^A-Za-z0-9_])@[A-Za-z0-9][A-Za-z0-9-]{0,38}\b/.test(value)) return true;
  if (value.toLowerCase().includes(GROK_REVIEW_RECEIPT_NAMESPACE)) return true;
  return false;
}

/**
 * Neutralize model prose for publication. Does not touch suggestion replacements
 * (those are either published verbatim or the suggestion is omitted entirely).
 * @param {string} text
 * @returns {string}
 */
export function sanitizePublicationProse(text) {
  let value = String(text ?? "");
  // ANSI CSI / OSC sequences
  value = value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "");
  // Controls except tab/newline/carriage-return
  value = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  // Bidirectional overrides / isolates
  value = value.replace(/[\u202A-\u202E\u2066-\u2069]/g, "");
  // Strip HTML tags that could spoof receipt / UI chrome
  value = value.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  // Break @mentions so GitHub does not notify users
  value = value.replace(
    /(^|[^A-Za-z0-9_])@([A-Za-z0-9][A-Za-z0-9-]{0,38})\b/g,
    "$1@\u200B$2"
  );
  // Neutralize reserved receipt namespace text in model prose
  value = value.replace(/grok-review-receipt/gi, "grok-review\u200B-receipt");
  return value;
}

/**
 * @param {unknown} value
 * @returns {value is { startLine: number, endLine: number, replacement: string }}
 */
function isExactSuggestionShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 3) return false;
  if (!keys.includes("startLine") || !keys.includes("endLine") || !keys.includes("replacement")) {
    return false;
  }
  const startLine = /** @type {{ startLine: unknown }} */ (value).startLine;
  const endLine = /** @type {{ endLine: unknown }} */ (value).endLine;
  const replacement = /** @type {{ replacement: unknown }} */ (value).replacement;
  return Number.isSafeInteger(startLine)
    && Number.isSafeInteger(endLine)
    && startLine >= 1
    && endLine >= startLine
    && typeof replacement === "string";
}

/**
 * @param {{ startLine: number, endLine: number, replacement: string }} suggestion
 * @returns {boolean}
 */
function suggestionIsPublicationSafe(suggestion) {
  if (Buffer.byteLength(suggestion.replacement, "utf8") > MAX_SUGGESTION_REPLACEMENT_BYTES) {
    return false;
  }
  // Never alter replacement text: if sanitization would change it, drop suggestion.
  if (publicationWouldAlter(suggestion.replacement)) return false;
  return true;
}

/**
 * Build a RIGHT-side lookup from either a structured map or legacy Set.
 * @param {{ rightSideMap?: RightSideLookup|null, rightSideLines?: Set<string>|null }} args
 * @returns {RightSideLookup}
 */
function resolveRightSideLookup({ rightSideMap = null, rightSideLines = null }) {
  if (rightSideMap && typeof rightSideMap.hasLine === "function" && typeof rightSideMap.hasRange === "function") {
    return rightSideMap;
  }
  const set = rightSideLines instanceof Set ? rightSideLines : new Set();
  return {
    hasLine(filePath, line) {
      if (!filePath || !Number.isSafeInteger(line) || line < 1) return false;
      return set.has(`${filePath}:${line}`);
    },
    hasRange(filePath, startLine, endLine) {
      if (!filePath || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)) return false;
      if (startLine < 1 || endLine < startLine) return false;
      // Legacy Set cannot prove same-hunk multi-line ranges.
      if (startLine !== endLine) return false;
      return set.has(`${filePath}:${startLine}`);
    }
  };
}

/**
 * Map companion public job JSON + right-side diff targets to a GitHub create-review body.
 * Always uses event COMMENT. Zero findings still post a summary review.
 * Only empty-target may remain a skip.
 *
 * @param {{
 *   job: object,
 *   headSha: string,
 *   rightSideLines?: Set<string>,
 *   rightSideMap?: RightSideLookup,
 *   hostReceiptMarker?: string|null
 * }} args
 * @returns {BuildResult}
 */
export function buildPrReviewPayload({
  job,
  headSha,
  rightSideLines = null,
  rightSideMap = null,
  hostReceiptMarker = null
}) {
  if (!headSha || typeof headSha !== "string") {
    throw new Error("headSha is required");
  }
  const result = job?.result || null;
  if (result?.skipped && result?.skipReason === "empty-target") {
    return { skip: true, reason: "empty-target" };
  }
  const review = result?.review;
  if (!review || typeof review !== "object") {
    throw new Error("Job JSON missing result.review (review may have failed before completion)");
  }
  const findings = Array.isArray(review.findings) ? review.findings : [];
  const lookup = resolveRightSideLookup({ rightSideMap, rightSideLines });

  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const inline = [];
  const promoted = [];

  for (const f of findings) {
    const severity = String(f.severity || "info");
    if (Object.hasOwn(counts, severity)) counts[severity] += 1;
    else counts.info += 1;

    const file = f.file == null || f.file === "" ? null : String(f.file);
    const line = f.line == null ? null : Number(f.line);
    const baseBody = formatFindingComment(f);

    const suggestionCandidate = isExactSuggestionShape(f.suggestion) ? f.suggestion : null;
    const canSuggest = Boolean(
      suggestionCandidate
      && file
      && suggestionIsPublicationSafe(suggestionCandidate)
      && lookup.hasRange(file, suggestionCandidate.startLine, suggestionCandidate.endLine)
    );

    if (canSuggest) {
      const startLine = suggestionCandidate.startLine;
      const endLine = suggestionCandidate.endLine;
      const replacement = suggestionCandidate.replacement;
      const fence = suggestionFence(replacement);
      // Preserve replacement bytes exactly. join("\n") would insert an extra
      // blank line when the replacement already ends with a newline; only add
      // a line break before the closing fence when one is not already present.
      const suggestionFenceBlock = replacement.endsWith("\n")
        ? `${fence}suggestion\n${replacement}${fence}`
        : `${fence}suggestion\n${replacement}\n${fence}`;
      const suggestionBlock = `${baseBody}\n\n${suggestionFenceBlock}`;
      const comment = {
        path: file,
        side: "RIGHT",
        line: endLine,
        body: suggestionBlock
      };
      if (startLine !== endLine) {
        comment.start_line = startLine;
        comment.start_side = "RIGHT";
      }
      inline.push(comment);
      continue;
    }

    // Ordinary finding: map single RIGHT line when possible; otherwise promote.
    // Invalid / unmappable / unsafe suggestions degrade here without mutating replacement.
    const keyLine = file && line && Number.isFinite(line) && Number.isSafeInteger(line) ? line : null;
    if (file && keyLine && lookup.hasLine(file, keyLine)) {
      inline.push({
        path: file,
        line: keyLine,
        side: "RIGHT",
        body: baseBody
      });
    } else {
      promoted.push({
        severity,
        file,
        line: keyLine,
        title: f.title,
        body: f.body,
        hadSuggestion: Boolean(f.suggestion)
      });
    }
  }

  if (inline.length > MAX_INLINE_COMMENTS) {
    throw new Error(
      `Review has ${inline.length} inline comments; maximum is ${MAX_INLINE_COMMENTS} (no silent drop)`
    );
  }

  for (const comment of inline) {
    const bytes = Buffer.byteLength(String(comment.body || ""), "utf8");
    if (bytes > MAX_INLINE_BODY_BYTES) {
      throw new Error(
        `Inline comment body is ${bytes} bytes; maximum is ${MAX_INLINE_BODY_BYTES} (no silent truncation)`
      );
    }
  }

  const summaryText = sanitizePublicationProse(String(review.summary || "").trim() || "(no summary)");
  const bodyParts = [
    "## Grok review",
    "",
    summaryText,
    "",
    "## Issue counts by severity",
    "",
    `- critical: ${counts.critical}`,
    `- high: ${counts.high}`,
    `- medium: ${counts.medium}`,
    `- low: ${counts.low}`,
    `- info: ${counts.info}`,
    ""
  ];

  if (promoted.length) {
    bodyParts.push("## Issues outside the diff", "");
    for (const p of promoted) {
      const loc =
        p.file && p.line
          ? `${p.file}:${p.line}`
          : p.file
            ? p.file
            : "(no location)";
      const title = sanitizePublicationProse(String(p.title || ""));
      const body = sanitizePublicationProse(String(p.body || ""));
      bodyParts.push(`- **[${p.severity}]** ${sanitizePublicationProse(loc)} — ${title}`);
      bodyParts.push(`  ${body}`);
      bodyParts.push("");
    }
  }

  bodyParts.push(
    "---",
    "",
    "_Automated Superpowers-style Grok Companion review (informational; does not block merge)._"
  );

  // Host-owned marker only — never derived from model output.
  if (hostReceiptMarker != null && hostReceiptMarker !== "") {
    if (typeof hostReceiptMarker !== "string") {
      throw new Error("hostReceiptMarker must be a string when provided");
    }
    bodyParts.push("", hostReceiptMarker);
  }

  const body = bodyParts.join("\n");
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > MAX_REVIEW_BODY_BYTES) {
    throw new Error(
      `Review body is ${bodyBytes} bytes; maximum is ${MAX_REVIEW_BODY_BYTES} (no silent truncation)`
    );
  }

  const payload = {
    commit_id: headSha,
    event: "COMMENT",
    body,
    comments: inline
  };

  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch (error) {
    throw new Error(`Review payload is not JSON-serializable: ${error?.message || error}`);
  }
  const jsonBytes = Buffer.byteLength(serialized, "utf8");
  if (jsonBytes > MAX_PAYLOAD_JSON_BYTES) {
    throw new Error(
      `Review payload JSON is ${jsonBytes} bytes; maximum is ${MAX_PAYLOAD_JSON_BYTES} (no silent truncation)`
    );
  }

  return {
    skip: false,
    payload
  };
}

function formatFindingComment(f) {
  const title = sanitizePublicationProse(String(f.title || "Finding").trim());
  const body = sanitizePublicationProse(String(f.body || "").trim());
  const severity = String(f.severity || "info");
  return `**[${severity}] ${title}**\n\n${body}`;
}
