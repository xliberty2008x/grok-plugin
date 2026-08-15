export const PUBLIC_JOB_SUMMARY_LIMIT = 160;
export const PUBLIC_JOB_SUMMARY_ELLIPSIS = "\u2026";

const IDENTIFIER_CHAR = /[A-Za-z0-9_./\\:@+-]/u;
const ESCAPE_TAILS = new Set(["n", "t", "r", "b", "f", "v", "0", "u", "x", "\"", "'", "\\"]);
const SENTENCE_PUNCTUATION = new Set([".", ";", "!", "?"]);

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function lastCompleteScalarIndex(text, exclusiveEnd) {
  if (exclusiveEnd <= 0) return 0;
  if (exclusiveEnd >= text.length) return text.length;
  return isHighSurrogate(text.charCodeAt(exclusiveEnd - 1))
    ? exclusiveEnd - 1
    : exclusiveEnd;
}

function endsOnOddBackslash(text, exclusiveEnd) {
  let count = 0;
  for (let index = exclusiveEnd - 1; index >= 0 && text[index] === "\\"; index -= 1) {
    count += 1;
  }
  return count % 2 === 1;
}

function isEscapeCut(text, exclusiveEnd) {
  if (!endsOnOddBackslash(text, exclusiveEnd)) return false;
  return exclusiveEnd < text.length && ESCAPE_TAILS.has(text[exclusiveEnd]);
}

function insideIdentifier(text, exclusiveEnd) {
  return exclusiveEnd > 0
    && exclusiveEnd < text.length
    && IDENTIFIER_CHAR.test(text[exclusiveEnd - 1])
    && IDENTIFIER_CHAR.test(text[exclusiveEnd]);
}

function isSentenceBoundary(text, exclusiveEnd) {
  if (exclusiveEnd <= 0) return false;
  if (!SENTENCE_PUNCTUATION.has(text[exclusiveEnd - 1])) return false;
  return exclusiveEnd === text.length || /\s/u.test(text[exclusiveEnd]);
}

function trimRightWhitespace(text, exclusiveEnd) {
  let index = exclusiveEnd;
  while (index > 0 && /\s/u.test(text[index - 1])) index -= 1;
  return index;
}

function retreatFromUnsafeCut(text, exclusiveEnd) {
  let index = lastCompleteScalarIndex(text, exclusiveEnd);
  while (index > 0 && isEscapeCut(text, index)) {
    index = lastCompleteScalarIndex(text, index - 1);
  }
  if (insideIdentifier(text, index)) {
    while (index > 0 && IDENTIFIER_CHAR.test(text[index - 1])) index -= 1;
    index = trimRightWhitespace(text, index);
  }
  return lastCompleteScalarIndex(text, index);
}

function lastSentenceBoundary(text, exclusiveEnd) {
  for (let index = exclusiveEnd; index >= 1; index -= 1) {
    if (isSentenceBoundary(text, index) && !isEscapeCut(text, index)) {
      return lastCompleteScalarIndex(text, index);
    }
  }
  return 0;
}

function choosePublicSummaryCut(text, budget) {
  const safeBudget = retreatFromUnsafeCut(text, Math.min(budget, text.length));
  const sentence = lastSentenceBoundary(text, safeBudget);
  if (sentence > 0) return sentence;
  return safeBudget > 0 ? safeBudget : lastCompleteScalarIndex(text, Math.min(budget, text.length));
}

/**
 * Bound a public job summary without cutting a path, identifier, escape, or
 * Unicode scalar. The durable worker-report summary stays intact elsewhere.
 */
export function projectPublicJobSummary(text, { limit = PUBLIC_JOB_SUMMARY_LIMIT } = {}) {
  const source = typeof text === "string" ? text : "";
  if (source.length <= limit) {
    return { summary: source, truncated: false };
  }
  const budget = Math.max(0, limit - PUBLIC_JOB_SUMMARY_ELLIPSIS.length);
  const cut = choosePublicSummaryCut(source, budget);
  return {
    summary: `${source.slice(0, cut)}${PUBLIC_JOB_SUMMARY_ELLIPSIS}`,
    truncated: true
  };
}
