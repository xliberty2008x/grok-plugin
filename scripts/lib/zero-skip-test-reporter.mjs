import path from "node:path";
import process from "node:process";

import {
  redactText,
  sanitizeDisplayText
} from "../../plugins/grok/scripts/lib/redact.mjs";

export const ZERO_SKIP_REPORTER_ID = "zero-skip-v2";
export const ZERO_SKIP_MAX_VIOLATIONS = 8;
export const ZERO_SKIP_MAX_SUMMARY_BYTES = 16 * 1024;

export const ZERO_SKIP_SUMMARY_FIELDS = Object.freeze([
  "passed",
  "failed",
  "cancelled",
  "skipped",
  "todo"
]);

export const ZERO_SKIP_VIOLATION_FIELDS = Object.freeze([
  "outcome",
  "file",
  "name",
  "testNumber",
  "nesting",
  "line",
  "column",
  "errorName",
  "errorCode",
  "operator"
]);

const ZERO_SKIP_OUTCOMES = Object.freeze([
  "failed",
  "cancelled",
  "skipped",
  "todo"
]);
const CANCELLED_FAILURE_TYPES = new Set([
  "cancelledByParent",
  "testAborted",
  "testTimeoutFailure"
]);
const MAX_FILE_LENGTH = 256;
const MAX_NAME_LENGTH = 160;
const MAX_NAME_SCAN_LENGTH = 2_048;
const MAX_SECRET_ENV_VALUES = 64;
const MAX_SECRET_ENV_LENGTH = 4_096;
const SAFE_FILE_PATTERN = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
const SAFE_TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u;
const SECRET_ENV_KEY_PATTERN = /(?:^|_)(?:authorization|api_key|access_key|access_token|refresh_token|tokens?|password|passwd|pwd|secret|credential|cookie)(?:_|$)/iu;
const OPAQUE_TOKEN_PATTERN = /[A-Za-z0-9_.~+/=-]{24,}/u;
const ABSOLUTE_PATH_PATTERN = /(?:^|[^A-Za-z0-9/\\])(?:file:\/\/\S+|\/\/[^\s/\\]+|\/[^\s/\\]|[A-Za-z]:[\\/]|\\\\[^\s/\\]+)|[^A-Za-z0-9\s/\\]\/(?=$|[)\]}>.,;!?])/iu;
const UNSAFE_FORMAT_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const UNSAFE_FORMAT_REPLACE_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function safeRead(value, key) {
  if (!isRecord(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function boundedInteger(value, minimum) {
  return Number.isSafeInteger(value) && value >= minimum ? value : null;
}

function nullableInteger(value, minimum) {
  return value === null || boundedInteger(value, minimum) !== null;
}

function safeSum(values) {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || total > Number.MAX_SAFE_INTEGER - value) {
      return null;
    }
    total += value;
  }
  return total;
}

function markSecretKnowledge(secrets, complete) {
  Object.defineProperty(secrets, "complete", {
    configurable: false,
    enumerable: false,
    value: complete === true,
    writable: false
  });
  return secrets;
}

/**
 * Normalize an explicit or collected secret list without invoking accessors.
 *
 * Plain arrays supplied by trusted callers are complete unless malformed.
 * Collections produced below carry an explicit non-enumerable completeness
 * marker so fail-closed discovery state survives normal array use.
 */
export function normalizeZeroSkipKnownSecrets(input = []) {
  try {
    if (!Array.isArray(input)) return markSecretKnowledge([], false);
  } catch {
    return markSecretKnowledge([], false);
  }

  let complete = true;
  try {
    const completeness = Object.getOwnPropertyDescriptor(input, "complete");
    if (completeness) {
      if (!Object.hasOwn(completeness, "value") || completeness.value !== true) {
        complete = false;
      }
    }
  } catch {
    return markSecretKnowledge([], false);
  }

  let length;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, "length");
    length = descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : null;
  } catch {
    return markSecretKnowledge([], false);
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    return markSecretKnowledge([], false);
  }
  if (length > MAX_SECRET_ENV_VALUES) complete = false;

  const secrets = [];
  const inspected = Math.min(length, MAX_SECRET_ENV_VALUES);
  for (let index = 0; index < inspected; index += 1) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    } catch {
      complete = false;
      continue;
    }
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      complete = false;
      continue;
    }
    const value = descriptor.value;
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_SECRET_ENV_LENGTH) {
      complete = false;
      continue;
    }
    secrets.push(value);
  }
  return markSecretKnowledge(secrets, complete);
}

export function collectZeroSkipKnownSecrets(environment = process.env) {
  let descriptors;
  try {
    if (!isRecord(environment)) return markSecretKnowledge([], false);
    descriptors = Object.getOwnPropertyDescriptors(environment);
  } catch {
    return markSecretKnowledge([], false);
  }
  const secrets = [];
  let complete = true;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!SECRET_ENV_KEY_PATTERN.test(key)) continue;
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      complete = false;
      continue;
    }
    const value = descriptor.value;
    if (typeof value !== "string") {
      complete = false;
      continue;
    }
    if (value.length === 0) continue;
    if (value.length > MAX_SECRET_ENV_LENGTH) {
      complete = false;
      continue;
    }
    if (secrets.length < MAX_SECRET_ENV_VALUES) secrets.push(value);
    else complete = false;
  }
  return markSecretKnowledge(secrets, complete);
}

/** Return a canonical repo-relative path or null without exposing private paths. */
export function sanitizeZeroSkipFile(value, root = process.cwd(), knownSecrets = []) {
  const secretKnowledge = normalizeZeroSkipKnownSecrets(knownSecrets);
  if (!secretKnowledge.complete) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) return null;
  if (UNSAFE_FORMAT_PATTERN.test(value) || value.startsWith("file:")) return null;

  // A Windows absolute path must not be reinterpreted as a relative POSIX name.
  if (!path.isAbsolute(value) && path.win32.isAbsolute(value)) return null;

  let relative;
  try {
    const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
    relative = path.relative(path.resolve(root), absolute);
  } catch {
    return null;
  }
  if (
    !relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    return null;
  }

  const canonical = relative.split(path.sep).join("/");
  if (canonical.length > MAX_FILE_LENGTH || !SAFE_FILE_PATTERN.test(canonical)) return null;
  if (canonical.split("/").some((segment) => segment === "." || segment === "..")) return null;
  if (redactText(canonical, secretKnowledge) !== canonical) return null;
  return canonical;
}

/** Return a bounded display name, or redact the whole value when it looks sensitive. */
export function sanitizeZeroSkipName(value, {
  root = process.cwd(),
  knownSecrets = []
} = {}) {
  const secretKnowledge = normalizeZeroSkipKnownSecrets(knownSecrets);
  if (!secretKnowledge.complete) return "[redacted]";
  if (typeof value !== "string" || value.length === 0) return null;

  let candidate = value.slice(0, MAX_NAME_SCAN_LENGTH);
  try {
    candidate = candidate.normalize("NFKC");
  } catch {
    return null;
  }

  const rootSecret = typeof root === "string" && root.length >= 8 ? [root] : [];
  candidate = sanitizeDisplayText(candidate, [...rootSecret, ...secretKnowledge])
    .replace(UNSAFE_FORMAT_REPLACE_PATTERN, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!candidate) return null;

  // Run redaction again after control removal so an escape sequence cannot split
  // a secret-shaped token and make it visible only after sanitization.
  if (
    candidate.includes("[REDACTED]")
    || redactText(candidate, [...rootSecret, ...secretKnowledge]) !== candidate
    || ABSOLUTE_PATH_PATTERN.test(candidate)
    || OPAQUE_TOKEN_PATTERN.test(candidate)
  ) {
    return "[redacted]";
  }

  const points = Array.from(candidate);
  if (points.length > MAX_NAME_LENGTH) {
    return `${points.slice(0, MAX_NAME_LENGTH - 1).join("")}…`;
  }
  return candidate;
}

function sanitizeZeroSkipToken(value, knownSecrets = []) {
  const secretKnowledge = normalizeZeroSkipKnownSecrets(knownSecrets);
  if (!secretKnowledge.complete) return null;
  if (typeof value !== "string" || !SAFE_TOKEN_PATTERN.test(value)) return null;
  if (redactText(value, secretKnowledge) !== value || OPAQUE_TOKEN_PATTERN.test(value)) return null;
  return value;
}

function buildViolation(event, outcome, {
  root,
  knownSecrets
}) {
  const data = safeRead(event, "data");
  const details = safeRead(data, "details");
  const error = safeRead(details, "error");
  return {
    outcome,
    file: sanitizeZeroSkipFile(safeRead(data, "file"), root, knownSecrets),
    name: sanitizeZeroSkipName(safeRead(data, "name"), { root, knownSecrets }),
    testNumber: boundedInteger(safeRead(data, "testNumber"), 0),
    nesting: boundedInteger(safeRead(data, "nesting"), 0),
    line: boundedInteger(safeRead(data, "line"), 1),
    column: boundedInteger(safeRead(data, "column"), 1),
    errorName: sanitizeZeroSkipToken(safeRead(error, "name"), knownSecrets),
    errorCode: sanitizeZeroSkipToken(safeRead(error, "code"), knownSecrets),
    operator: sanitizeZeroSkipToken(safeRead(error, "operator"), knownSecrets)
  };
}

function classifyEvent(event) {
  const type = safeRead(event, "type");
  if (type !== "test:pass" && type !== "test:fail") return null;

  const data = safeRead(event, "data");
  const details = safeRead(data, "details");
  if (safeRead(details, "type") === "suite") return null;
  const skip = safeRead(data, "skip");
  const todo = safeRead(data, "todo");
  if (skip !== undefined && skip !== null && skip !== false) return "skipped";
  if (todo !== undefined && todo !== null && todo !== false) return "todo";
  if (type === "test:pass") return "passed";

  const error = safeRead(details, "error");
  const failureType = safeRead(error, "failureType");
  return CANCELLED_FAILURE_TYPES.has(failureType) ? "cancelled" : "failed";
}

/**
 * Strictly validate a parsed zero-skip-v2 summary.
 *
 * The runner rejects rather than repairs non-canonical child output.
 */
export function validateZeroSkipSummary(summary, {
  root = process.cwd(),
  environment = process.env,
  knownSecrets = collectZeroSkipKnownSecrets(environment)
} = {}) {
  const topLevelFields = [
    "reporter",
    ...ZERO_SKIP_SUMMARY_FIELDS,
    "violations",
    "omittedViolations"
  ];
  if (!exactKeys(summary, topLevelFields) || summary.reporter !== ZERO_SKIP_REPORTER_ID) {
    return false;
  }
  if (ZERO_SKIP_SUMMARY_FIELDS.some((field) => boundedInteger(summary[field], 0) === null)) {
    return false;
  }
  if (boundedInteger(summary.omittedViolations, 0) === null) return false;
  if (!Array.isArray(summary.violations) || summary.violations.length > ZERO_SKIP_MAX_VIOLATIONS) {
    return false;
  }

  const total = safeSum(ZERO_SKIP_SUMMARY_FIELDS.map((field) => summary[field]));
  const nonpass = safeSum(ZERO_SKIP_OUTCOMES.map((field) => summary[field]));
  if (total === null || nonpass === null) return false;
  const expectedStoredViolations = Math.min(nonpass, ZERO_SKIP_MAX_VIOLATIONS);
  if (summary.violations.length !== expectedStoredViolations) return false;
  if (summary.omittedViolations !== nonpass - expectedStoredViolations) return false;

  const storedByOutcome = Object.fromEntries(ZERO_SKIP_OUTCOMES.map((outcome) => [outcome, 0]));
  for (const violation of summary.violations) {
    if (!exactKeys(violation, ZERO_SKIP_VIOLATION_FIELDS)) return false;
    if (!ZERO_SKIP_OUTCOMES.includes(violation.outcome)) return false;
    if (
      sanitizeZeroSkipFile(violation.file, root, knownSecrets) !== violation.file
    ) {
      return false;
    }
    if (
      sanitizeZeroSkipName(violation.name, { root, knownSecrets }) !== violation.name
    ) {
      return false;
    }
    if (!nullableInteger(violation.testNumber, 0) || !nullableInteger(violation.nesting, 0)) {
      return false;
    }
    if (!nullableInteger(violation.line, 1) || !nullableInteger(violation.column, 1)) {
      return false;
    }
    if (
      (violation.errorName !== null
        && sanitizeZeroSkipToken(violation.errorName, knownSecrets) !== violation.errorName)
      || (violation.errorCode !== null
        && sanitizeZeroSkipToken(violation.errorCode, knownSecrets) !== violation.errorCode)
      || (violation.operator !== null
        && sanitizeZeroSkipToken(violation.operator, knownSecrets) !== violation.operator)
    ) {
      return false;
    }
    storedByOutcome[violation.outcome] += 1;
  }
  return ZERO_SKIP_OUTCOMES.every((outcome) => storedByOutcome[outcome] <= summary[outcome]);
}

/**
 * Minimal node:test reporter for mandatory proof gates.
 *
 * It emits exactly one bounded JSON line and deliberately ignores every raw
 * diagnostic, stdout/stderr, error message, stack, cause, actual, and expected
 * value carried by the test stream.
 */
export default async function* zeroSkipTestReporter(source, {
  root = process.cwd(),
  environment = process.env
} = {}) {
  const summary = {
    reporter: ZERO_SKIP_REPORTER_ID,
    passed: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    violations: [],
    omittedViolations: 0
  };
  const knownSecrets = collectZeroSkipKnownSecrets(environment);

  for await (const event of source) {
    const outcome = classifyEvent(event);
    if (outcome === null) continue;
    if (summary[outcome] >= Number.MAX_SAFE_INTEGER) {
      throw new Error("zero-skip counter overflow");
    }
    summary[outcome] += 1;
    if (outcome === "passed") continue;

    if (summary.violations.length < ZERO_SKIP_MAX_VIOLATIONS) {
      summary.violations.push(buildViolation(event, outcome, { root, knownSecrets }));
    } else {
      summary.omittedViolations += 1;
    }
  }

  yield `${JSON.stringify(summary)}\n`;
  if (summary.failed > 0
    || summary.cancelled > 0
    || summary.skipped > 0
    || summary.todo > 0) {
    process.exitCode = 1;
  }
}
