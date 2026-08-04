/**
 * Adversarial-review specialization: wraps the shared structural validateReview
 * with a zero-findings semantic completion gate. Ordinary review keeps the
 * generic validator; only job.kind === "adversarial-review" selects this path.
 */

import { CompanionError } from "./errors.mjs";
import { validateReview } from "./grok-provider.mjs";

/** Required prefix for empty-findings adversarial pass summaries. */
export const ADVERSARIAL_NO_FINDINGS_PREFIX = "No material findings:";

/** Exact bounded grammar for an empty-findings completed assessment. */
const CHALLENGED_MARKER = "Challenged:";
const ASSESSMENT_MARKER = "Assessment:";
const SHIP_DECISION = "Decision: ship.";

/**
 * Same-session repair text for adversarial semantic (and structural) failures.
 * Kept short; does not echo provider payload or repository content.
 */
export const ADVERSARIAL_REVIEW_REPAIR_PROMPT = [
  "Your previous response was not a completed adversarial review.",
  "Return only one JSON object with exactly summary and findings.",
  "Omit verdict; the runtime derives pass from zero findings and needs_changes from one or more findings.",
  "For empty findings, summary MUST use exactly: `No material findings: Challenged: <what was challenged>. Assessment: <why it holds or residual non-blocking risk>. Decision: ship.`",
  "Both marked segments must be substantive completed assessment text with at least five distinct letter-bearing words and bounded repetition, not placeholders, plans, or progress notes.",
  "Do not return plan or progress-only text such as I will, I'll, I need to, I am reviewing, I have begun, I plan to, The next step, Still reviewing, Currently reviewing, Inspecting, Reviewing, Searching, or Locating.",
  "Preserve substantive findings and use repository-relative paths."
].join(" ");

/** Bounded future/incomplete forms observed in issue #4 and close variants. */
const REVIEW_ACTION = String.raw`(?:review|inspect|search|locate|check|analy[sz]e|assess|critique|challenge|investigate|report)`;
const REVIEW_ACTIVITY = String.raw`(?:reviewing|inspecting|searching|locating|checking|analy[sz]ing|assessing|critiquing|challenging|investigating|reporting)`;
const OPTIONAL_MODIFIERS = String.raw`(?:\s+\p{L}+){0,2}`;
const FIRST_PERSON_PENDING = new RegExp(
  String.raw`\b(?:(?:I|we)\s+(?:will|need\s+to|plan\s+to|intend\s+to|should|must|have\s+to|want\s+to)${OPTIONAL_MODIFIERS}\s+${REVIEW_ACTION}|(?:I\s+am|we\s+are)${OPTIONAL_MODIFIERS}\s+(?:going\s+to\s+${REVIEW_ACTION}|${REVIEW_ACTIVITY})|(?:I|we)[’']ll${OPTIONAL_MODIFIERS}\s+${REVIEW_ACTION}|(?:I[’']m|we[’']re)${OPTIONAL_MODIFIERS}\s+(?:going\s+to\s+${REVIEW_ACTION}|${REVIEW_ACTIVITY})|(?:I|we)(?:\s+have|[’']ve)${OPTIONAL_MODIFIERS}\s+(?:begun|started)(?:\s+to)?\s+(?:${REVIEW_ACTION}|${REVIEW_ACTIVITY}))\b`,
  "iu"
);
const BARE_PENDING_ACTION = new RegExp(String.raw`^(?:Need\s+to|Should|Must|Going\s+to|About\s+to)\s+${REVIEW_ACTION}\b`, "iu");
const ACTIVE_PROGRESS = new RegExp(
  String.raw`\b(?:(?:still|currently)\s+${REVIEW_ACTIVITY}|continuing\s+(?:to\s+)?${REVIEW_ACTION})\b`,
  "iu"
);
const NEXT_STEP_PENDING = /^The\s+next\s+step\s+(?:is|will\s+be|is\s+to)\b/iu;
const INCOMPLETE_STATE = /\b(?:(?:review|assessment|analysis)\s+(?:(?:is|remains)\s+(?:still\s+)?(?:ongoing|underway|unfinished|incomplete|in\s+progress|not\s+(?:yet\s+)?(?:finished|complete))|has\s+not\s+(?:finished|completed))|(?:this|it)\s+(?:is|remains)\s+(?:only\s+)?(?:a\s+)?preliminary\s+(?:review|assessment|analysis))\b/iu;
const GERUND_REVIEW_LEADING = /^(?:Inspecting|Reviewing|Searching|Locating|Checking|Analy[sz]ing|Assessing|Critiquing)\b/iu;
const COMPLETED_RESULT_CUE = /\b(?:found|revealed|confirmed|showed|demonstrated|established|identified|exposed|surfaced|proved)\b/iu;
const RESERVED_MARKER = /\b(?:Challenged|Assessment|Decision)\s*:/iu;
const PLACEHOLDER_SEGMENT = /^(?:<[^>\r\n]{1,200}>|(?:pending|todo|tbd|unknown|placeholder)(?:\s+(?:pending|todo|tbd|unknown|placeholder|\d+))*)$/iu;

/** Minimum content in each explicit completed-assessment segment. */
const MIN_ASSESSMENT_SEGMENT = 24;

/**
 * Bounded semantic failure without echoing provider payload or repository text.
 * @param {string} reason machine-stable reason code
 * @returns {never}
 */
function rejectIncompleteRationale(reason) {
  throw new CompanionError(
    "E_SCHEMA",
    "Adversarial review output did not complete the ship/no-ship rationale contract.",
    {
      reason,
      hint: "For empty findings, use `No material findings: Challenged: <completed challenge>. Assessment: <completed rationale>. Decision: ship.` Plan or progress-only text is not a completed review.",
      findingsCount: 0
    }
  );
}

/**
 * Parse the exact completed no-findings grammar without broad regex backtracking.
 * @param {string} summary canonical redacted summary
 * @returns {{ challenged: string, assessment: string } | null}
 */
function parseCompletedRationale(summary) {
  const start = `${ADVERSARIAL_NO_FINDINGS_PREFIX} ${CHALLENGED_MARKER} `;
  const assessmentToken = `. ${ASSESSMENT_MARKER} `;
  const decisionToken = `. ${SHIP_DECISION}`;
  if (!summary.startsWith(start) || !summary.endsWith(decisionToken)) return null;
  const middle = summary.slice(start.length, -decisionToken.length);
  const split = middle.indexOf(assessmentToken);
  if (split < 0 || split !== middle.lastIndexOf(assessmentToken)) return null;
  const challenged = middle.slice(0, split).trim();
  const assessment = middle.slice(split + assessmentToken.length).trim();
  if (RESERVED_MARKER.test(challenged) || RESERVED_MARKER.test(assessment)) return null;
  return { challenged, assessment };
}

function segmentIsSubstantive(text) {
  if (text.length < MIN_ASSESSMENT_SEGMENT || PLACEHOLDER_SEGMENT.test(text)) return false;
  const words = (text.match(/\p{L}+(?:[’'-]\p{L}+)*/gu) || [])
    .filter((word) => (word.match(/\p{L}/gu) || []).length >= 2);
  const unique = new Set(words.map((word) => word.normalize("NFKC").toLowerCase()));
  const hasLongWord = words.some((word) => (word.match(/\p{L}/gu) || []).length >= 4);
  return hasLongWord && words.length >= 5 && unique.size >= 5 && unique.size / words.length > 0.5;
}

function isPlanOrProgress(text) {
  if (FIRST_PERSON_PENDING.test(text)
    || BARE_PENDING_ACTION.test(text)
    || ACTIVE_PROGRESS.test(text)
    || NEXT_STEP_PENDING.test(text)
    || INCOMPLETE_STATE.test(text)) return true;
  return GERUND_REVIEW_LEADING.test(text) && !COMPLETED_RESULT_CUE.test(text);
}

/**
 * Adversarial-only validator: structural validateReview first, then require a
 * completed zero-findings rationale. Findings-bearing payloads keep the
 * canonical needs_changes path without the no-findings prefix.
 *
 * @param {unknown} value provider structured output
 * @returns {{ verdict: "pass"|"needs_changes", summary: string, findings: object[] }}
 */
export function validateAdversarialReview(value) {
  const validated = validateReview(value);
  if (validated.findings.length > 0) return validated;

  const summary = validated.summary;
  if (!summary.startsWith(ADVERSARIAL_NO_FINDINGS_PREFIX)) {
    // Also classify bare plan/progress summaries observed in the issue.
    const trimmed = summary.trim();
    if (isPlanOrProgress(trimmed)) {
      rejectIncompleteRationale("plan-progress-only");
    }
    rejectIncompleteRationale("missing-no-findings-prefix");
  }

  const suffix = summary.slice(ADVERSARIAL_NO_FINDINGS_PREFIX.length).trim();
  const segments = parseCompletedRationale(summary);
  if (!segments) {
    if (isPlanOrProgress(suffix)) rejectIncompleteRationale("plan-progress-suffix");
    rejectIncompleteRationale("missing-completed-assessment-format");
  }
  if (isPlanOrProgress(segments.challenged)
    || isPlanOrProgress(segments.assessment)) {
    rejectIncompleteRationale("plan-progress-segment");
  }
  if (!segmentIsSubstantive(segments.challenged)) {
    rejectIncompleteRationale("insubstantive-challenged-segment");
  }
  if (!segmentIsSubstantive(segments.assessment)) {
    rejectIncompleteRationale("insubstantive-assessment-segment");
  }
  return validated;
}

/**
 * Select runStructuredReview options. Ordinary review receives `common`
 * unchanged (generic validator, repair prompt, one-call success path).
 * Adversarial review adds the semantic validator and specialized repair text.
 *
 * @param {string} kind job kind
 * @param {object} common shared provider options
 * @returns {object}
 */
export function structuredReviewOptionsFor(kind, common) {
  if (kind !== "adversarial-review") return common;
  return {
    ...common,
    validator: validateAdversarialReview,
    repairPrompt: ADVERSARIAL_REVIEW_REPAIR_PROMPT
  };
}
