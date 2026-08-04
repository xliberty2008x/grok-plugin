/**
 * Worker Protocol v1 — provider-neutral public handle/snapshot projections and
 * durable lifecycle-event cursors.
 *
 * This module is intentionally free of MCP transport, mailbox/send/followup,
 * worktrees, UI, recursive subagents, and mid-turn steering. It projects only
 * public job evidence so the CLI and future broker adapters share one contract
 * without changing provider execution.
 */

import crypto from "node:crypto";

import { CompanionError } from "./errors.mjs";
import { redact, sanitizeDisplayText } from "./redact.mjs";
import {
  CONTEXT_BINDING_MODE,
  assertContextPacket,
  assertContextReceipt,
  assertContextReceiptShape
} from "./worker-context.mjs";
import { assertRuntimeRolePolicy } from "./worker-roles.mjs";
import { projectAwaitingHostAction } from "./worker-host-actions.mjs";
import {
  LIFECYCLE_EVENT_TYPES,
  MAX_LIFECYCLE_EVENTS,
  normalizeLifecycleEventSequences
} from "./task-lifecycle.mjs";
import {
  appendContextIncompleteMessage,
  projectContextIncompleteDetails,
  projectMetadataCompletenessObservation,
  projectSharedRefIdentitySummary,
  projectSharedRefObservation,
  projectTaskRelevantMetadataObservation
} from "./worker-context-projection.mjs";

/** Public protocol version for handle, snapshot, and cursor projections. */
export const WORKER_PROTOCOL_VERSION = 1;
export const WORKER_HANDLE_SCHEMA_VERSION = 1;
export const WORKER_SNAPSHOT_SCHEMA_VERSION = 1;
export const WORKER_EVENT_CURSOR_SCHEMA_VERSION = 1;
export const WORKER_EVENT_SCHEMA_VERSION = 1;
export const WORKER_RESULT_SCHEMA_VERSION = 1;
export const WORKER_ERROR_SCHEMA_VERSION = 1;
export const WORKER_CONTEXT_INCOMPLETE_ERROR_SCHEMA_VERSION = 2;

/** Every persisted runtime error that may cross the public worker boundary. */
export const PUBLIC_WORKER_ERROR_CODES = Object.freeze([
  "E_AUTH_REQUIRED",
  "E_CANCELLED",
  "E_CAPABILITY",
  "E_CONTEXT_DRIFT",
  "E_CONTEXT_INCOMPLETE",
  "E_DELIVERY",
  "E_GIT_REQUIRED",
  "E_GROK_NOT_FOUND",
  "E_GROK_SOURCE",
  "E_GROK_VERSION",
  "E_IDEMPOTENCY_CONFLICT",
  "E_IMPORT_RESULT",
  "E_IMPORT_SOURCE",
  "E_INTEGRATION",
  "E_JOB_ACTIVE",
  "E_JOB_NOT_FOUND",
  "E_NO_RESUME_CANDIDATE",
  "E_OUTPUT_LIMIT",
  "E_POLICY",
  "E_PROCESS_IDENTITY",
  "E_PROTOCOL",
  "E_PROVIDER_EXIT",
  "E_RECURSION",
  "E_REVIEW_MUTATED_WORKSPACE",
  "E_REVIEW_TOO_LARGE",
  "E_ROLE",
  "E_SCHEMA",
  "E_SCOPE_VIOLATION",
  "E_SECURITY_PROFILE",
  "E_STATE",
  "E_TIMEOUT",
  "E_USAGE",
  "E_WORKER_LOST",
  "E_WORKTREE",
  "E_BROKER",
  "E_WORKFLOW_INCOMPLETE",
  "E_RESEARCH_PAUSED"
]);

/** Re-export retention bound so adapters share one constant with append paths. */
export { MAX_LIFECYCLE_EVENTS };

const ACTIVE_WORKER_STATUSES = new Set(["queued", "running"]);
const PUBLIC_WORKER_STATUSES = new Set(["queued", "running", "completed", "failed", "cancelled", "unknown"]);
const PUBLIC_LIFECYCLE_EVENT_TYPES = new Set(LIFECYCLE_EVENT_TYPES);
const PUBLIC_WORKER_ERROR_CODE_SET = new Set(PUBLIC_WORKER_ERROR_CODES);
const FOREGROUND_PUBLIC_ERROR_CODE_SET = new Set([
  "E_STORAGE_READONLY",
  "E_INPUT_READ",
  "E_INPUT_TIMEOUT",
  "E_CONTEXT_INCOMPLETE"
]);
const SHA256_HEX_DIGEST = /^[a-f0-9]{64}$/;
const WORKER_ID_PATTERN = /^(?:review|adversarial-review|task|stop-review|deep-research)-[a-f0-9]{16,64}$/;
const MAX_PUBLIC_TEXT_BYTES = 2000;
const MAX_PUBLIC_PLAN_ITEMS = 128;
const MAX_PUBLIC_LIST_ITEMS = 64;
const MAX_PUBLIC_PATH_ITEMS = 200;
const MAX_PUBLIC_REVIEW_FINDINGS = 200;
const MAX_PUBLIC_TREE_DEPTH = 8;
const MAX_PUBLIC_TREE_PROPERTIES = 64;
const MAX_PUBLIC_TREE_ITEMS = 200;
const MAX_PUBLIC_DIAGNOSTIC_TEXT_BYTES = 512 * 1024;
const MAX_PRIVATE_PROCESS_DIAGNOSTIC_CODE_LENGTH = 64;
const MAX_PRIVATE_PROCESS_DIAGNOSTIC_MESSAGE_LENGTH = 256;
const PROCESS_IDENTITY_PUBLIC_MESSAGE = "Process ownership verification failed.";
const SAFETY_PRIMARY_ERROR_CODES = new Set([
  "E_CONTEXT_DRIFT",
  "E_CONTEXT_INCOMPLETE",
  "E_SCOPE_VIOLATION"
]);
const PROCESS_OS_ERROR_CODES = new Set([
  "E2BIG",
  "EACCES",
  "EADDRINUSE",
  "EADDRNOTAVAIL",
  "EAFNOSUPPORT",
  "EAGAIN",
  "EALREADY",
  "EBADF",
  "EBADMSG",
  "EBUSY",
  "ECANCELED",
  "ECHILD",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EDEADLK",
  "EDESTADDRREQ",
  "EDOM",
  "EDQUOT",
  "EEXIST",
  "EFAULT",
  "EFBIG",
  "EHOSTUNREACH",
  "EIDRM",
  "EILSEQ",
  "EINPROGRESS",
  "EINTR",
  "EINVAL",
  "EIO",
  "EISCONN",
  "EISDIR",
  "ELOOP",
  "EMFILE",
  "EMLINK",
  "EMSGSIZE",
  "EMULTIHOP",
  "ENAMETOOLONG",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENFILE",
  "ENOBUFS",
  "ENODATA",
  "ENODEV",
  "ENOENT",
  "ENOEXEC",
  "ENOLCK",
  "ENOLINK",
  "ENOMEM",
  "ENOMSG",
  "ENOPROTOOPT",
  "ENOSPC",
  "ENOSR",
  "ENOSTR",
  "ENOSYS",
  "ENOTCONN",
  "ENOTDIR",
  "ENOTEMPTY",
  "ENOTRECOVERABLE",
  "ENOTSOCK",
  "ENOTSUP",
  "ENOTTY",
  "ENXIO",
  "EOPNOTSUPP",
  "EOVERFLOW",
  "EOWNERDEAD",
  "EPERM",
  "EPIPE",
  "EPROTO",
  "EPROTONOSUPPORT",
  "EPROTOTYPE",
  "ERANGE",
  "EROFS",
  "ESHUTDOWN",
  "ESOCKTNOSUPPORT",
  "ESPIPE",
  "ETIME",
  "ETIMEDOUT",
  "ETXTBSY",
  "EWOULDBLOCK",
  "EXDEV"
]);
const PUBLIC_PROCESS_SIGNAL_NAMES = new Set([
  "SIGABRT",
  "SIGALRM",
  "SIGBREAK",
  "SIGBUS",
  "SIGCHLD",
  "SIGCONT",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINT",
  "SIGIO",
  "SIGIOT",
  "SIGKILL",
  "SIGPIPE",
  "SIGPOLL",
  "SIGPROF",
  "SIGPWR",
  "SIGQUIT",
  "SIGSEGV",
  "SIGSTOP",
  "SIGSYS",
  "SIGTERM",
  "SIGTRAP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGURG",
  "SIGUSR1",
  "SIGUSR2",
  "SIGVTALRM",
  "SIGWINCH",
  "SIGXCPU",
  "SIGXFSZ"
]);
const PUBLIC_LIFECYCLE_DETAIL_TEXT_FIELDS = Object.freeze({
  envelopeId: Object.freeze({ kind: "text", maxBytes: 256 }),
  resumeJobId: Object.freeze({ kind: "text", maxBytes: 256 }),
  spawnSuccessDefinition: Object.freeze({ kind: "text", maxBytes: 1000 }),
  requestAcceptedAt: Object.freeze({ kind: "timestamp" }),
  reconciler: Object.freeze({ kind: "text", maxBytes: 128 }),
  messageId: Object.freeze({ kind: "text", maxBytes: 256 }),
  contentDigest: Object.freeze({ kind: "text", maxBytes: 256 }),
  parentWorkerId: Object.freeze({ kind: "text", maxBytes: 256 }),
  version: Object.freeze({ kind: "text", maxBytes: 128 }),
  name: Object.freeze({ kind: "text", maxBytes: 300 }),
  status: Object.freeze({ kind: "text", maxBytes: 80 }),
  plan: Object.freeze({ kind: "text-list", maxItems: 20, maxBytes: 500 }),
  questions: Object.freeze({
    kind: "text-list",
    maxItems: MAX_PUBLIC_LIST_ITEMS,
    maxBytes: MAX_PUBLIC_TEXT_BYTES
  }),
  validationIssues: Object.freeze({
    kind: "text-list",
    maxItems: MAX_PUBLIC_PATH_ITEMS,
    maxBytes: MAX_PUBLIC_TEXT_BYTES
  }),
  observedChangedPaths: Object.freeze({
    kind: "path-list",
    maxItems: MAX_PUBLIC_PATH_ITEMS
  })
});
const PRIVATE_PROJECTION_FIELDS = new Set([
  "host",
  "sessionId",
  "grokSessionId",
  "claudeSessionId",
  "workerProcess",
  "providerProcess",
  "controllerProcess",
  "workerAuthorization",
  "pid",
  "processGroupId",
  "startToken",
  "nonce",
  "commandMarker",
  "workspaceRoot",
  "prompt",
  "userRequest",
  "rawProviderMessage",
  "rawProviderMessages",
  "hostAction",
  "followup",
  "resumeSessionId",
  "grantId",
  "grantDigest",
  "messageDigest"
]);

function omitPrivateProjectionFields(value, ancestors = new WeakSet()) {
  if (!value || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[CIRCULAR]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => omitPrivateProjectionFields(item, ancestors));
    }
    const projected = {};
    for (const [key, item] of Object.entries(value)) {
      if (PRIVATE_PROJECTION_FIELDS.has(key)) continue;
      projected[key] = omitPrivateProjectionFields(item, ancestors);
    }
    return projected;
  } finally {
    ancestors.delete(value);
  }
}

function sanitizePublicProjection(value) {
  const redacted = redact(omitPrivateProjectionFields(value));
  const visit = (item, depth = 0, ancestors = new WeakSet()) => {
    if (typeof item === "string") return sanitizePublicText(item);
    if (!item || typeof item !== "object") return item;
    if (depth >= MAX_PUBLIC_TREE_DEPTH) return null;
    if (ancestors.has(item)) return null;
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        return item
          .slice(0, MAX_PUBLIC_TREE_ITEMS)
          .map((entry) => visit(entry, depth + 1, ancestors));
      }
      const projected = {};
      for (const [key, entry] of Object.entries(item).slice(0, MAX_PUBLIC_TREE_PROPERTIES)) {
        projected[key] = visit(entry, depth + 1, ancestors);
      }
      return projected;
    } finally {
      ancestors.delete(item);
    }
  };
  return visit(redacted);
}

function sanitizePublicText(value) {
  let text = sanitizeDisplayText(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "")
    .replace(/[\u0080-\u009F]/g, "");
  text = text
    .replace(/file:\/\/[^\s"'`;,\)\]}]*/gi, "[PRIVATE_PATH]")
    .replace(/~\/[^\s"'`;,\)\]}]*/g, "[PRIVATE_PATH]")
    .replace(/\\\\[^\\\s"'`;,\)\]}]+\\[^\s"'`;,\)\]}]*/g, "[PRIVATE_PATH]");
  text = text.replace(
    /(^|[^A-Za-z0-9])[A-Za-z]:[\\/][^\s"'`;,\)\]}]*/g,
    (_match, prefix) => `${prefix}[PRIVATE_PATH]`
  );
  text = text.replace(
    /(^|[^:])\/\/[^/\s"'`;,\)\]}]+\/[^\s"'`;,\)\]}]*/g,
    (_match, prefix) => `${prefix}[PRIVATE_PATH]`
  );
  text = text.replace(
    /(^|[^A-Za-z0-9._~\/-])\/(?!\/)[^\s"'`;,\)\]}]+/g,
    (_match, prefix) => `${prefix}[PRIVATE_PATH]`
  );
  return text.replace(
    /(^|[^A-Za-z0-9._~-])\\(?!\\)[^\s"'`;,\)\]}]+/g,
    (_match, prefix) => `${prefix}[PRIVATE_PATH]`
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function truncateUtf8(value, maximumBytes) {
  const characters = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) break;
    characters.push(character);
    bytes += characterBytes;
  }
  return characters.join("");
}

export function projectWorkerPublicText(
  value,
  { fallback = "", maxBytes = MAX_PUBLIC_TEXT_BYTES } = {}
) {
  const sanitizedFallback = sanitizePublicText(fallback);
  const sanitized = typeof value === "string"
    ? sanitizePublicText(value)
    : sanitizedFallback;
  return truncateUtf8(String(sanitized || sanitizedFallback), maxBytes);
}

function boundedText(value, { fallback = "", max = MAX_PUBLIC_TEXT_BYTES } = {}) {
  return projectWorkerPublicText(value, { fallback, maxBytes: max });
}

function rawProcessOsErrorCode(value) {
  const code = String(value || "");
  return PROCESS_OS_ERROR_CODES.has(code) ? code : null;
}

function rawProcessOsErrorCodesInText(value) {
  if (typeof value !== "string") return [];
  return [...value.normalize("NFKC").matchAll(/\bE[A-Z0-9_]{2,63}\b/g)]
    .map((match) => rawProcessOsErrorCode(match[0]))
    .filter(Boolean);
}

function boundedAuthoritativeProcessDiagnostic(value) {
  if (!isPlainObject(value)) return null;
  const code = typeof value.code === "string" ? value.code : "";
  const message = typeof value.message === "string" ? value.message : "";
  if (
    !/^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    || code.length > MAX_PRIVATE_PROCESS_DIAGNOSTIC_CODE_LENGTH
    || !message.trim()
    || message.length > MAX_PRIVATE_PROCESS_DIAGNOSTIC_MESSAGE_LENGTH
  ) {
    return null;
  }
  return value;
}

function acceptsAuthoritativeProcessDiagnostic(error) {
  return isPlainObject(error)
    && (
      error.code === "E_PROCESS_IDENTITY"
      || SAFETY_PRIMARY_ERROR_CODES.has(error.code)
    );
}

function isClearlyDocumentaryProcessText(value) {
  if (typeof value !== "string") return false;
  const text = value.normalize("NFKC");
  const documentary = /^\s*(?:(?:historical|history|example|illustration)\b|fixture(?=\s*(?::|-|\b(?:example|note|documentation|record)\b)))/i.test(text);
  const operationalFixture = /^\s*fixture\s+(?:cleanup|teardown|shutdown|failed|failure|error)\b/i.test(text);
  const explicitlyCurrent = /\b(?:currently|current\s+(?:cleanup|retry|failure|error)|still|now|waiting\s+for|remains?\s+blocked)\b/i.test(text);
  return documentary && !operationalFixture && !explicitlyCurrent;
}

function classifyProcessCleanupDiagnostic(value) {
  if (typeof value !== "string") {
    return Object.freeze({
      sensitive: false,
      documentary: false,
      hasStrongProcessIdentity: false,
      hasWeakProcessIdentity: false,
      processDiagnostic: false,
      rawCodes: []
    });
  }
  const text = value.normalize("NFKC");
  const documentary = isClearlyDocumentaryProcessText(text);
  const rawCodes = rawProcessOsErrorCodesInText(text);
  const hasStrongProcessIdentity =
    scrubStrongProcessIdentityText(text) !== text;
  const hasWeakProcessIdentity =
    scrubWeakProcessIdentityText(text) !== text;
  const operationalContext = (
    /\b(?:cleanup|clean-up|teardown|shutdown|recover(?:y|ed|ing)?|reconcil(?:e|ed|er|ing|iation)|final[\s_-]+(?:observation|context|evidence|state|cleanup)|terminal(?:[\s_-]+(?:context|state|cleanup|record|error|failure))?|runtime[\s_-]+cleanup|provider[\s_-]+cleanup|process[\s_-]+(?:ownership|identity|group|termination|exit|shutdown|cleanup))\b/i.test(text)
    || /\bkill\s+--\s+[+-]?\d+\b/i.test(text)
    || /\b(?:kill|signal(?:led|ling|ed|ing)?|terminat(?:e|ed|ing))(?:[\s_-]+to)?[\s_-]+(?:process|group)\b/i.test(text)
    || /\bsent\s+SIG[A-Z0-9]+\s+to\b/i.test(text)
    || /\bwaiting\s+for\s+(?:process|group)\b/i.test(text)
    || /\b(?:provider|worker|controller|child|leader)\s+process\s*[#:=]?\s*[+-]?\d+\b/i.test(text)
    || (
      rawCodes.length > 0
      && /\b(?:kill|signal(?:led|ling|ed|ing)?|terminat(?:e|ed|ing|ion)|target)\b/i.test(text)
    )
  );
  const processDiagnostic = hasStrongProcessIdentity
    || (
      operationalContext
      && (hasWeakProcessIdentity || rawCodes.length > 0)
    );
  return Object.freeze({
    sensitive: !documentary && processDiagnostic,
    documentary,
    hasStrongProcessIdentity,
    hasWeakProcessIdentity,
    operationalContext,
    processDiagnostic,
    rawCodes
  });
}

function rawProcessSignalDiagnostic(error) {
  if (!isPlainObject(error)) return null;
  const secondary = isPlainObject(error.details?.secondaryDiagnostic)
    ? error.details.secondaryDiagnostic
    : null;
  if (acceptsAuthoritativeProcessDiagnostic(error)) {
    const authoritative = boundedAuthoritativeProcessDiagnostic(secondary);
    if (authoritative) return authoritative;
    if (error.code === "E_PROCESS_IDENTITY") return null;
  }
  const rawCode = rawProcessOsErrorCode(error.code);
  if (rawCode && classifyProcessCleanupDiagnostic(error.message).processDiagnostic) {
    return error;
  }
  if (secondary) {
    const secondaryCode = rawProcessOsErrorCode(secondary.code);
    if (secondaryCode) return secondary;
  }
  for (const warning of [
    error.details?.warning,
    error.details?.privacyWarning
  ]) {
    const classification = classifyProcessCleanupDiagnostic(warning);
    if (classification.processDiagnostic && classification.rawCodes.length > 0) {
      return {
        code: classification.rawCodes[0] || null,
        message: String(warning)
      };
    }
  }
  if (["E_BROKER", "E_PROVIDER_EXIT", "E_STATE"].includes(error.code)
    && classifyProcessCleanupDiagnostic(error.message).processDiagnostic) {
    const wrappedCode = rawProcessOsErrorCodesInText(error.message)[0] || null;
    if (!wrappedCode) return null;
    return { code: wrappedCode, message: String(error.message) };
  }
  return null;
}

function rawProcessSignalDiagnostics(error) {
  const acceptsAuthoritativeCodes =
    acceptsAuthoritativeProcessDiagnostic(error);
  const diagnostics = [
    rawProcessSignalDiagnostic(error),
    ...(Array.isArray(error?.details?.sanitizationDiagnostics)
      ? error.details.sanitizationDiagnostics
      : [])
  ].filter((diagnostic) => (
    isPlainObject(diagnostic)
    && (
      rawProcessOsErrorCode(diagnostic.code)
      || (
        acceptsAuthoritativeCodes
        && boundedAuthoritativeProcessDiagnostic(diagnostic)
      )
    )
    && typeof diagnostic.message === "string"
    && diagnostic.message.trim()
  ));
  const seen = new Set();
  return diagnostics.filter((diagnostic) => {
    const identity = `${diagnostic.code}\u0000${diagnostic.message}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function hasActualProcessIdentityUncertainty(error) {
  return isPlainObject(error)
    && (
      error.code === "E_PROCESS_IDENTITY"
      || Boolean(rawProcessSignalDiagnostic(error))
    );
}

function establishesProcessIdentityUncertainty(error) {
  return isPlainObject(error)
    && (
      hasActualProcessIdentityUncertainty(error)
      || SAFETY_PRIMARY_ERROR_CODES.has(error.code)
    );
}

function scrubStrongProcessIdentityText(value) {
  return String(value)
    .replace(
      /\b((?:pid(?:_t)?|pgid|process[\s_-]*(?:group(?:[\s_-]*(?:ids?|identifiers?))?|ids?|identifiers?)|signal[\s_-]*target|(?:child|leader|provider|worker|controller)[\s_-]*(?:pid(?:_t)?|process[\s_-]*(?:ids?|identifiers?)))\s*["']?\s*(?::|=|#|\bis\b)?\s*["']?\s*[\[(]?\s*)[+-]?\d+\b(\s*[\])]?["']?)/giu,
      "$1[REDACTED]$2"
    );
}

function scrubWeakProcessIdentityText(value) {
  return String(value)
    .replace(
      /\b((?:target|group(?:[\s_-]+(?:ids?|identifiers?))?)\s*["']?\s*(?::|=|#|\bis\b)?\s*["']?\s*[\[(]?\s*)[+-]?\d+\b(\s*[\])]?["']?)/giu,
      "$1[REDACTED]$2"
    )
    .replace(
      /\b((?:kill|signal(?:led|ling|ed|ing)?|terminat(?:e|ed|ing))\s+--\s+)[+-]?\d+\b/giu,
      "$1[REDACTED]"
    )
    .replace(
      /\b((?:kill|signal(?:led|ling|ed|ing)?|terminat(?:e|ed|ing))(?:[\s_-]+to)?[\s_-]+(?:process|group)(?:\s+(?:with\s+)?(?:id|number))?(?:\s*(?::|=|#|\bis\b)\s*|\s+)["']?)[+-]?\d+\b(\s*["']?)/giu,
      "$1[REDACTED]$2"
    )
    .replace(
      /\b((?:kill|signal(?:led|ling|ed|ing)?|terminat(?:e|ed|ing))\s*(?:\(\s*|(?::|=|#|\bis\b)?\s+)["']?)[+-]?\d+\b(\s*["']?)/giu,
      "$1[REDACTED]$2"
    )
    .replace(
      /\b((?:waiting\s+for)\s+(?:process|group)(?:\s+(?:with\s+)?(?:id|number))?(?:\s*(?::|=|#|\bis\b)\s*|\s+)["']?)[+-]?\d+\b(\s*["']?)/giu,
      "$1[REDACTED]$2"
    )
    .replace(
      /\b((?:sent\s+SIG[A-Z0-9]+\s+to)\s+(?:(?:process|group)(?:\s+(?:with\s+)?(?:id|number))?\s*(?:(?::|=|#|\bis\b)\s*)?)?["']?)[+-]?\d+\b(\s*["']?)/giu,
      "$1[REDACTED]$2"
    )
    .replace(
      /\b((?:provider|worker|controller|child|leader)\s+process(?:\s+(?:with\s+)?(?:id|number))?(?:\s*(?::|=|#|\bis\b)\s*|\s+)["']?)[+-]?\d+\b(\s*["']?)/giu,
      "$1[REDACTED]$2"
    );
}

function scrubPublicProcessIdentityText(value, { includeWeak = true } = {}) {
  const strong = scrubStrongProcessIdentityText(value);
  return includeWeak ? scrubWeakProcessIdentityText(strong) : strong;
}

function scrubRawProcessOsErrorCodes(value) {
  return String(value).replace(
    /\bE[A-Z0-9_]{2,63}\b/g,
    (code) => rawProcessOsErrorCode(code)
      ? PROCESS_IDENTITY_PUBLIC_MESSAGE
      : code
  );
}

function scrubProcessDiagnosticText(value, error, { selfDetect = false } = {}) {
  let text = String(value);
  const diagnostics = rawProcessSignalDiagnostics(error);
  for (const diagnostic of diagnostics) {
    const rawMessage = diagnostic.message.trim();
    text = text.replace(
      new RegExp(rawMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"),
      PROCESS_IDENTITY_PUBLIC_MESSAGE
    );
    const rawCode = String(diagnostic.code || "");
    if (!rawProcessOsErrorCode(rawCode)) {
      text = text.replace(
        new RegExp(`\\b${rawCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gu"),
        PROCESS_IDENTITY_PUBLIC_MESSAGE
      );
    }
  }
  const activeUncertainty = establishesProcessIdentityUncertainty(error);
  if (activeUncertainty) {
    text = text
      .replace(
        /\bE_ASYNC_SIGNAL\b\s*:\s*Process signalling callback did not complete synchronously\./giu,
        PROCESS_IDENTITY_PUBLIC_MESSAGE
      )
      .replace(
        /Process signalling callback did not complete synchronously\./giu,
        PROCESS_IDENTITY_PUBLIC_MESSAGE
      )
      .replace(
        /\bE_ASYNC_SIGNAL\b/gu,
        PROCESS_IDENTITY_PUBLIC_MESSAGE
      );
  }
  if (!selfDetect && !activeUncertainty) return text;
  const hasAuthoritativeDiagnostic = diagnostics.length > 0;
  return text
    .split(/((?:\r?\n)+|[.!?;](?:["')\]]*)[ \t]+|[ \t]+(?:—|–|\|)[ \t]+)/u)
    .map((segment) => {
      const classification = classifyProcessCleanupDiagnostic(segment);
      // A documentary prefix is not evidence that process-looking content is
      // harmless. Preserve such a sibling only when an authoritative raw
      // secondary diagnostic identified a different exact segment first.
      const preserveDocumentary = classification.documentary
        && hasAuthoritativeDiagnostic;
      const sensitive = classification.processDiagnostic
        || (
          activeUncertainty
          && classification.hasWeakProcessIdentity
        );
      if (!sensitive || preserveDocumentary) return segment;
      const withoutCodes = scrubRawProcessOsErrorCodes(segment);
      return scrubPublicProcessIdentityText(withoutCodes, {
        includeWeak: activeUncertainty || classification.operationalContext
      });
    })
    .join("");
}

function scrubProcessDiagnosticsInPublicTree(
  value,
  error,
  { selfDetect = false } = {}
) {
  if (!selfDetect && !establishesProcessIdentityUncertainty(error)) return value;
  if (typeof value === "string") {
    return scrubProcessDiagnosticText(value, error, { selfDetect });
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubProcessDiagnosticsInPublicTree(
      item,
      error,
      { selfDetect }
    ));
  }
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      scrubProcessDiagnosticsInPublicTree(item, error, { selfDetect })
    ])
  );
}

function sanitizeCompleteWorkerProjection(value, error) {
  return sanitizePublicProjection(scrubProcessDiagnosticsInPublicTree(
    value,
    error,
    { selfDetect: true }
  ));
}

function projectWorkerStatusText(
  value,
  error,
  {
    trustHostAuthority = true,
    selfDetect = false,
    max = MAX_PUBLIC_TEXT_BYTES
  } = {}
) {
  if (typeof value !== "string") return null;
  const text = scrubProcessDiagnosticText(value, error, { selfDetect });
  return authorityBoundText(text, { trustHostAuthority, max });
}

function projectProcessDiagnosticWarning(value, error) {
  if (typeof value !== "string") return null;
  const classification = classifyProcessCleanupDiagnostic(value);
  const warningError = rawProcessSignalDiagnostic(error)
    ? error
    : classification.processDiagnostic && classification.rawCodes.length > 0
      ? { code: classification.rawCodes[0], message: value }
      : error;
  return boundedText(scrubProcessDiagnosticText(value, warningError, {
    selfDetect: true
  }));
}

function workerSanitizationError(job) {
  const pending = isPlainObject(job?.pendingTerminal?.error)
    ? job.pendingTerminal.error
    : null;
  const current = isPlainObject(job?.error) ? job.error : null;
  const reportRepair = isPlainObject(job?.result?.reportRepair?.error)
    ? job.result.reportRepair.error
    : null;
  const privacyWarning = typeof job?.result?.privacyWarning === "string"
    ? job.result.privacyWarning
    : null;
  const warningClassification = classifyProcessCleanupDiagnostic(privacyWarning);
  const warningError = warningClassification.processDiagnostic
    ? {
        code: "E_PROCESS_IDENTITY",
        message: PROCESS_IDENTITY_PUBLIC_MESSAGE,
        ...(warningClassification.rawCodes[0]
          ? {
              details: {
                secondaryDiagnostic: {
                  code: warningClassification.rawCodes[0],
                  message: privacyWarning
                }
              }
            }
          : {})
      }
    : null;
  const errors = [pending, current, reportRepair].filter(Boolean);
  const identityErrors = [...errors, warningError]
    .filter((error) => hasActualProcessIdentityUncertainty(error));
  if (identityErrors.length) {
    const selected = identityErrors.find(
      (error) => rawProcessSignalDiagnostics(error).length > 0
    ) || identityErrors[0];
    const diagnostics = identityErrors
      .flatMap((error) => rawProcessSignalDiagnostics(error));
    if (diagnostics.length > rawProcessSignalDiagnostics(selected).length) {
      return {
        ...selected,
        details: {
          ...(isPlainObject(selected.details) ? selected.details : {}),
          sanitizationDiagnostics: diagnostics
        }
      };
    }
    return selected;
  }
  return warningError
    || errors.find((error) => SAFETY_PRIMARY_ERROR_CODES.has(error?.code))
    || pending
    || current
    || reportRepair;
}

/**
 * Bound and sanitize intentional human-facing text that is not part of the
 * structured Worker Protocol schema (for example full research markdown or a
 * provider session label). Operational process diagnostics are self-detected
 * even when the job has no stored error.
 */
export function projectWorkerDiagnosticText(
  value,
  {
    job = null,
    error = null,
    maxBytes = MAX_PUBLIC_TEXT_BYTES
  } = {}
) {
  if (typeof value !== "string") return "";
  const boundedMaximum = Number.isSafeInteger(maxBytes) && maxBytes >= 0
    ? Math.min(maxBytes, MAX_PUBLIC_DIAGNOSTIC_TEXT_BYTES)
    : MAX_PUBLIC_TEXT_BYTES;
  const sanitizationError = job && typeof job === "object"
    ? workerSanitizationError(job)
    : error;
  const scrubbed = scrubProcessDiagnosticText(value, sanitizationError, {
    selfDetect: true
  });
  return projectWorkerPublicText(scrubbed, { maxBytes: boundedMaximum });
}

function nullableText(value, max = MAX_PUBLIC_TEXT_BYTES) {
  return typeof value === "string" ? boundedText(value, { max }) : null;
}

function nullableIsoDateTime(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 64) {
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = ""] = match;
  const expected = [
    Number(year),
    Number(month),
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(fraction.padEnd(3, "0") || 0)
  ];
  const parsed = new Date(0);
  parsed.setUTCFullYear(expected[0], expected[1] - 1, expected[2]);
  parsed.setUTCHours(expected[3], expected[4], expected[5], expected[6]);
  const actual = [
    parsed.getUTCFullYear(),
    parsed.getUTCMonth() + 1,
    parsed.getUTCDate(),
    parsed.getUTCHours(),
    parsed.getUTCMinutes(),
    parsed.getUTCSeconds(),
    parsed.getUTCMilliseconds()
  ];
  if (actual.some((part, index) => part !== expected[index])) return null;
  return value;
}

function containsHostVerificationClaim(value) {
  if (typeof value !== "string") return false;
  const tokens = value
    .normalize("NFKC")
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) || [];
  const hasHost = tokens.includes("host");
  const hasVerification = tokens.some((token) => (
    /^verif(?:y|ies|ied|ying|ication|ications|ier|iers)$/u.test(token)
  ));
  return hasHost && hasVerification;
}

function authorityBoundText(value, { trustHostAuthority = true, max = MAX_PUBLIC_TEXT_BYTES } = {}) {
  const projected = nullableText(value, max);
  if (!trustHostAuthority && containsHostVerificationClaim(projected)) return null;
  return projected;
}

function nullableInteger(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function canonicalWorkerId(value) {
  if (typeof value !== "string" || !WORKER_ID_PATTERN.test(value)) {
    throw new CompanionError("E_SCHEMA", "Worker identity does not match the public protocol.");
  }
  return value;
}

function publicWorkerStatus(value) {
  return PUBLIC_WORKER_STATUSES.has(value) ? value : "unknown";
}

function projectPublicPlan(value, {
  error = null,
  trustHostAuthority = true,
  selfDetect = false,
  maxItems = MAX_PUBLIC_PLAN_ITEMS,
  maxBytes = MAX_PUBLIC_TEXT_BYTES
} = {}) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => projectWorkerStatusText(item, error, {
      trustHostAuthority,
      selfDetect,
      max: maxBytes
    }))
    .filter(Boolean)
    .slice(0, maxItems);
}

function publicStringList(value, { maxItems = MAX_PUBLIC_LIST_ITEMS, maxBytes = MAX_PUBLIC_TEXT_BYTES } = {}) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => boundedText(item, { max: maxBytes }))
    .filter(Boolean)
    .slice(0, maxItems);
}

function repositoryRelativePath(value) {
  if (typeof value !== "string") return null;
  const raw = sanitizePublicText(value).trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  if (
    !raw
    || raw.includes("[PRIVATE_PATH]")
    || Buffer.byteLength(raw, "utf8") > 1024
  ) return null;
  if (/^\[[A-Z0-9_]{1,80}\]$/.test(raw)) return raw;
  // A URI is never a repository-relative path. In particular, `file:` can
  // otherwise conceal an absolute local path from the leading-slash check and
  // URL-shaped values can be misinterpreted as executable scope by consumers.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)
    || raw.startsWith("/")
    || /^[A-Za-z]:/.test(raw)
    || raw.split("/").includes("..")) return null;
  return raw;
}

function publicPathList(value, maxItems = MAX_PUBLIC_PATH_ITEMS) {
  if (!Array.isArray(value)) return [];
  const paths = value.map((item) => repositoryRelativePath(item)).filter(Boolean);
  return [...new Set(paths)].slice(0, maxItems);
}

function publicByteCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function projectTextEvidence(value) {
  if (!isPlainObject(value)) return null;
  return {
    bytes: publicByteCount(value.bytes),
    digest: nullableText(value.digest, 256)
  };
}

function projectResearchReport(value) {
  if (!isPlainObject(value)) return null;
  const pathMatch = typeof value.path === "string"
    ? /(?:^|\/)workflows\/([^/]+)\/scratch\/report\.md$/.exec(value.path)
    : null;
  return {
    schemaVersion: 1,
    valid: Boolean(value.valid),
    path: pathMatch ? `workflows/${pathMatch[1]}/scratch/report.md` : null,
    bytes: publicByteCount(value.bytes),
    sha256: nullableText(value.sha256, 256),
    sourceCount: publicByteCount(value.sourceCount),
    coverageNotes: publicStringList(value.coverageNotes, { maxItems: 16, maxBytes: 500 }),
    status: ["verified", "partial"].includes(value.status || value.assessment)
      ? (value.status || value.assessment)
      : "partial",
    hostVerification: "not_run",
    textPreview: nullableText(value.textPreview, 500)
  };
}

function projectWorkflow(value) {
  if (!isPlainObject(value)) return null;
  const phases = Array.isArray(value.phases)
    ? value.phases.slice(0, 64).map((phase) => {
        if (typeof phase === "string") return boundedText(phase, { max: 240 });
        if (!isPlainObject(phase)) return null;
        return sanitizePublicProjection({
          id: nullableText(phase.id, 128),
          name: nullableText(phase.name, 240),
          status: nullableText(phase.status, 80),
          summary: nullableText(phase.summary, 1000)
        });
      }).filter(Boolean)
    : [];
  return {
    runId: nullableText(value.runId, 256),
    revision: nullableInteger(value.revision),
    status: nullableText(value.status, 80),
    phases,
    currentPhase: nullableText(value.currentPhase, 240),
    elapsedMs: nullableInteger(value.elapsedMs),
    agentsUsed: nullableInteger(value.agentsUsed),
    agentBudget: nullableInteger(value.agentBudget),
    usageIncomplete: Boolean(value.usageIncomplete),
    activeAgents: nullableInteger(value.activeAgents),
    agentLaunches: nullableInteger(value.agentLaunches),
    pauseMessage: nullableText(value.pauseMessage, 1000)
  };
}

function projectReview(value) {
  if (!isPlainObject(value) || typeof value.summary !== "string") return null;
  const findings = (Array.isArray(value.findings) ? value.findings : [])
    .filter(isPlainObject)
    .slice(0, MAX_PUBLIC_REVIEW_FINDINGS)
    .map((finding) => {
      const file = repositoryRelativePath(finding.file);
      return {
        severity: ["critical", "high", "medium", "low", "info"].includes(finding.severity)
          ? finding.severity
          : "info",
        title: boundedText(finding.title, { fallback: "Untitled finding", max: 240 }) || "Untitled finding",
        body: boundedText(finding.body, { fallback: "No public details.", max: 6000 }) || "No public details.",
        ...(file ? { file } : {}),
        ...(Number.isSafeInteger(finding.line) && finding.line >= 1 ? { line: finding.line } : {})
      };
    });
  return {
    verdict: ["pass", "needs_changes"].includes(value.verdict)
      ? value.verdict
      : findings.length ? "needs_changes" : "pass",
    summary: boundedText(value.summary, { fallback: "Review completed." }) || "Review completed.",
    findings
  };
}

function projectAcceptanceResults(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isPlainObject)
    .slice(0, MAX_PUBLIC_LIST_ITEMS)
    .map((entry, index) => ({
      id: boundedText(entry.id, { fallback: `AC-${String(index + 1).padStart(2, "0")}`, max: 80 }),
      status: ["met", "unmet", "unknown"].includes(entry.status) ? entry.status : "unknown",
      ...(typeof entry.note === "string" ? { note: boundedText(entry.note) } : {})
    }));
}

function projectWorkerReport(value) {
  if (!isPlainObject(value)) return null;
  return {
    schemaVersion: nullableInteger(value.schemaVersion),
    structured: Boolean(value.structured),
    valid: Boolean(value.valid),
    outcome: ["complete", "partial", "blocked"].includes(value.outcome) ? value.outcome : "partial",
    summary: boundedText(value.summary, { fallback: "Worker report unavailable." }) || "Worker report unavailable.",
    changedFiles: publicPathList(value.changedFiles),
    checksClaimed: publicStringList(value.checksClaimed),
    acceptanceResults: projectAcceptanceResults(value.acceptanceResults),
    risks: publicStringList(value.risks),
    questions: publicStringList(value.questions),
    validationIssues: publicStringList(value.validationIssues, { maxItems: MAX_PUBLIC_PATH_ITEMS })
  };
}

/**
 * Project only content-addressed one-file artifact metadata. Absolute roots,
 * provider/session identity, and stored payload bytes remain private.
 */
export function projectWriteArtifactMetadata(value) {
  const createdAt = isPlainObject(value)
    ? nullableIsoDateTime(value.createdAt)
    : null;
  if (!isPlainObject(value)
    || value.schemaVersion !== 1
    || value.path !== "target.txt"
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.baseCommit || "")
    || ![value.manifestDigest, value.securityDigest, value.patchDigest, value.contentDigest]
      .every((digest) => /^[a-f0-9]{64}$/.test(digest || ""))
    || !Number.isSafeInteger(value.contentBytes)
    || value.contentBytes < 1
    || createdAt === null) {
    return null;
  }
  return Object.freeze({
    schemaVersion: 1,
    path: "target.txt",
    baseCommit: value.baseCommit,
    manifestDigest: value.manifestDigest,
    securityDigest: value.securityDigest,
    patchDigest: value.patchDigest,
    contentDigest: value.contentDigest,
    contentBytes: value.contentBytes,
    createdAt
  });
}

function projectPublicErrorCore(value) {
  if (!isPlainObject(value)) return null;
  const durableCode = PUBLIC_WORKER_ERROR_CODE_SET.has(value.code)
    ? value.code
    : "E_BROKER";
  const diagnostic = rawProcessSignalDiagnostic(value);
  const directClassification = classifyProcessCleanupDiagnostic(value.message);
  const directSignalFailure = Boolean(
    value.code === "E_PROCESS_IDENTITY"
    || (
      diagnostic
      && (
        rawProcessOsErrorCode(value.code)
        || (
          ["E_BROKER", "E_PROVIDER_EXIT", "E_STATE"].includes(value.code)
          && directClassification.sensitive
          && directClassification.rawCodes.length > 0
        )
      )
    )
  );
  const code = directSignalFailure ? "E_PROCESS_IDENTITY" : durableCode;
  const processUncertainty = establishesProcessIdentityUncertainty(value);
  const message = code === "E_PROCESS_IDENTITY"
    ? PROCESS_IDENTITY_PUBLIC_MESSAGE
    : processUncertainty
      ? scrubProcessDiagnosticText(value.message, value)
      : value.message;
  return {
    code,
    message: code === "E_PROCESS_IDENTITY"
      ? PROCESS_IDENTITY_PUBLIC_MESSAGE
      : boundedText(message, { fallback: "Worker failed." }) || "Worker failed."
  };
}

function projectNestedError(value) {
  return projectPublicErrorCore(value);
}

function projectPublicErrorDetails(code, value, { error = null } = {}) {
  if (!isPlainObject(value)) return code === "E_CONTEXT_INCOMPLETE"
    ? projectContextIncompleteDetails(value)
    : null;
  const projected = {};
  const warningCodes = new Set([
    "E_AUTH_REQUIRED",
    "E_CANCELLED",
    "E_CAPABILITY",
    "E_IMPORT_RESULT",
    "E_IMPORT_SOURCE",
    "E_OUTPUT_LIMIT",
    "E_PROCESS_IDENTITY",
    "E_PROVIDER_EXIT",
    "E_STATE",
    "E_TIMEOUT"
  ]);
  if (warningCodes.has(code)) {
    if (typeof value.warning === "string") {
      projected.warning = projectProcessDiagnosticWarning(value.warning, error);
    }
    if (typeof value.privacyWarning === "string") {
      projected.privacyWarning = projectProcessDiagnosticWarning(value.privacyWarning, error);
    }
  }
  if (code === "E_CAPABILITY") {
    if (Array.isArray(value.available)) projected.available = publicStringList(value.available);
    if (Array.isArray(value.missing)) projected.missing = publicStringList(value.missing);
  } else if (code === "E_PROCESS_IDENTITY") {
    if (typeof value.workerId === "string"
      && WORKER_ID_PATTERN.test(value.workerId)) {
      projected.workerId = value.workerId;
    }
  } else if (code === "E_PROVIDER_EXIT") {
    if (Number.isSafeInteger(value.code)) projected.code = value.code;
    if (PUBLIC_PROCESS_SIGNAL_NAMES.has(value.signal)) {
      projected.signal = value.signal;
    }
  } else if (code === "E_SCHEMA") {
    if (typeof value.hint === "string") projected.hint = boundedText(value.hint);
    if (Array.isArray(value.rootKeys)) projected.rootKeys = publicStringList(value.rootKeys, { maxItems: 24, maxBytes: 128 });
    if (typeof value.hasUnknownRootKeys === "boolean") projected.hasUnknownRootKeys = value.hasUnknownRootKeys;
    if (typeof value.summaryType === "string") projected.summaryType = boundedText(value.summaryType, { max: 64 });
    if (Number.isSafeInteger(value.findingsCount) && value.findingsCount >= 0) {
      projected.findingsCount = value.findingsCount;
    }
    if (typeof value.findingsShapeOk === "boolean") projected.findingsShapeOk = value.findingsShapeOk;
    if (typeof value.payloadDigest === "string") projected.payloadDigest = boundedText(value.payloadDigest, { max: 256 });
  } else if (code === "E_SCOPE_VIOLATION") {
    const paths = publicPathList(value.paths);
    if (paths.length) projected.paths = paths;
  } else if (code === "E_REVIEW_MUTATED_WORKSPACE") {
    const changed = publicPathList(value.changed);
    if (changed.length) projected.changed = changed;
  } else if (code === "E_CONTEXT_DRIFT") {
    if (Array.isArray(value.reasons)) projected.reasons = publicStringList(value.reasons);
    if (Array.isArray(value.missingMarkers)) projected.missingMarkers = publicPathList(value.missingMarkers, MAX_PUBLIC_LIST_ITEMS);
    if (Array.isArray(value.missingPaths)) projected.missingPaths = publicPathList(value.missingPaths, MAX_PUBLIC_LIST_ITEMS);
    if (Array.isArray(value.unsafePaths)) projected.unsafePaths = publicPathList(value.unsafePaths, MAX_PUBLIC_LIST_ITEMS);
    if (["complete", "task_scoped", "unknown"].includes(value.workspaceState)) {
      projected.workspaceState = value.workspaceState;
    }
  } else if (code === "E_CONTEXT_INCOMPLETE") {
    Object.assign(projected, projectContextIncompleteDetails(value));
  } else if (code === "E_JOB_ACTIVE") {
    if (typeof value.conflictingJobId === "string" && WORKER_ID_PATTERN.test(value.conflictingJobId)) {
      projected.conflictingJobId = value.conflictingJobId;
    }
    if (typeof value.conflictingProviderHomeId === "string"
      && WORKER_ID_PATTERN.test(value.conflictingProviderHomeId)) {
      projected.conflictingProviderHomeId = value.conflictingProviderHomeId;
    }
  } else if (code === "E_OUTPUT_LIMIT" && Number.isSafeInteger(value.limitBytes) && value.limitBytes >= 0) {
    projected.limitBytes = value.limitBytes;
  }
  if (!Object.keys(projected).length) return null;
  return scrubProcessDiagnosticsInPublicTree(projected, error, {
    selfDetect: true
  });
}

function projectReportRepair(value) {
  if (!isPlainObject(value)) return null;
  const initialResponse = projectTextEvidence(value.initialResponse);
  const error = projectNestedError(value.error);
  return {
    attempted: Boolean(value.attempted),
    valid: Boolean(value.valid),
    ...(initialResponse ? { initialResponse } : {}),
    validationIssues: publicStringList(value.validationIssues, { maxItems: MAX_PUBLIC_PATH_ITEMS }),
    ...(error ? { error } : {})
  };
}

function projectProviderClaims(value) {
  if (!isPlainObject(value)) return null;
  return {
    success: Boolean(value.success),
    outcome: ["complete", "partial", "blocked"].includes(value.outcome) ? value.outcome : "partial",
    summary: nullableText(value.summary),
    changedFiles: publicPathList(value.changedFiles),
    checksClaimed: publicStringList(value.checksClaimed),
    observedFileAgreement: Boolean(value.observedFileAgreement)
  };
}

function projectContextIdentity(value) {
  if (!isPlainObject(value)) return null;
  const projected = {
    manifestId: nullableText(value.manifestId, 256),
    digest: nullableText(value.digest, 256),
    head: nullableText(value.head, 256),
    branch: nullableText(value.branch, 256),
    dirtyDigest: nullableText(value.dirtyDigest, 256),
    ignoredDigest: nullableText(value.ignoredDigest, 256),
    trackedTreeIdentity: nullableText(value.trackedTreeIdentity, 256),
    metadataIdentity: nullableText(value.metadataIdentity, 256)
  };
  // Validate the raw value only; never trim/lowercase/sanitize into a digest.
  if (typeof value.taskRelevantMetadataIdentity === "string"
    && SHA256_HEX_DIGEST.test(value.taskRelevantMetadataIdentity)) {
    projected.taskRelevantMetadataIdentity = value.taskRelevantMetadataIdentity;
  }
  const sharedRefIdentity = projectSharedRefIdentitySummary(value.sharedRefIdentity);
  const metadataObservation = projectTaskRelevantMetadataObservation(
    value.taskRelevantMetadataObservation
  );
  if (sharedRefIdentity
    && metadataObservation
    && sharedRefIdentity.complete !== metadataObservation.complete) {
    return projected;
  }
  if (sharedRefIdentity) projected.sharedRefIdentity = sharedRefIdentity;
  if (metadataObservation) projected.taskRelevantMetadataObservation = metadataObservation;
  return projected;
}

function projectCommandOutcomes(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isPlainObject)
    .slice(0, 40)
    .map((entry) => ({
      command: boundedText(entry.command, { fallback: "command", max: 200 }) || "command",
      status: boundedText(entry.status, { fallback: "unknown", max: 64 }) || "unknown",
      exitCode: Number.isSafeInteger(entry.exitCode) ? entry.exitCode : null
    }));
}

function projectRuntimeEvidence(value, { trustHostAuthority = true } = {}) {
  if (!isPlainObject(value)) return null;
  if (!trustHostAuthority) return null;
  const reconciler = isPlainObject(value.reconciler)
    ? {
      privilege: nullableText(value.reconciler.privilege, 128),
      replayedPrompt: Boolean(value.reconciler.replayedPrompt),
      at: nullableIsoDateTime(value.reconciler.at)
    }
    : null;
  const sharedRefObservation = projectSharedRefObservation(value.sharedRefObservation);
  const metadataCompleteness = projectMetadataCompletenessObservation(
    value.metadataCompletenessObservation
  );
  return {
    schemaVersion: nullableInteger(value.schemaVersion),
    preContext: projectContextIdentity(value.preContext),
    postContext: projectContextIdentity(value.postContext),
    observedChangedPaths: publicPathList(value.observedChangedPaths),
    diffSummary: nullableText(value.diffSummary, 4000),
    commandOutcomes: projectCommandOutcomes(value.commandOutcomes),
    scopeViolations: publicPathList(value.scopeViolations),
    executionStatus: nullableText(value.executionStatus, 64),
    hostVerification: trustHostAuthority
      && ["not_run", "passed", "failed", "skipped"].includes(value.hostVerification)
      ? value.hostVerification
      : "not_run",
    ...(sharedRefObservation ? { sharedRefObservation } : {}),
    ...(metadataCompleteness ? {
      metadataCompletenessObservation: metadataCompleteness
    } : {}),
    ...(reconciler ? { reconciler } : {})
  };
}

function projectVerification(value, { trustHostAuthority = true } = {}) {
  if (!isPlainObject(value)) return null;
  if (!trustHostAuthority) return null;
  return {
    outcome: ["passed", "failed", "skipped", "not_run"].includes(value.outcome)
      ? value.outcome
      : "not_run",
    authority: value.authority === "host_asserted" ? "host_asserted" : "unknown",
    recordedAt: nullableIsoDateTime(value.recordedAt),
    observedChangedPaths: publicPathList(value.observedChangedPaths)
  };
}

function projectLifecycleDetail(value, {
  trustHostAuthority = true,
  error = null
} = {}) {
  if (!isPlainObject(value)) return null;
  const projected = {};
  for (const [key, field] of Object.entries(PUBLIC_LIFECYCLE_DETAIL_TEXT_FIELDS)) {
    // Mailbox lifecycle events expose only an opaque message handle and state.
    // Content and idempotency equality remain private durability evidence.
    if (key === "contentDigest" && typeof value.messageId === "string") continue;
    if (field.kind === "timestamp") {
      const timestamp = nullableIsoDateTime(value[key]);
      if (timestamp !== null) projected[key] = timestamp;
    } else if (field.kind === "text" && typeof value[key] === "string") {
      projected[key] = projectWorkerStatusText(value[key], error, {
        trustHostAuthority,
        selfDetect: true,
        max: field.maxBytes
      });
    } else if (field.kind === "text-list" && Array.isArray(value[key])) {
      projected[key] = projectPublicPlan(value[key], {
        error,
        trustHostAuthority,
        selfDetect: true,
        maxItems: field.maxItems,
        maxBytes: field.maxBytes
      });
    } else if (field.kind === "path-list" && Array.isArray(value[key])) {
      projected[key] = publicPathList(
        value[key].map((item) => (
          typeof item === "string"
            ? scrubProcessDiagnosticText(item, error, { selfDetect: true })
            : item
        )),
        field.maxItems
      );
    }
  }
  if (["read", "write"].includes(value.mode)) projected.mode = value.mode;
  if (["accepted", "pending", "delivered", "delivery_unknown", "rejected"].includes(value.state)) {
    projected.state = value.state;
  }
  if (["tool", "plan", "message"].includes(value.eventType)) projected.eventType = value.eventType;
  if (["pass", "needs_changes"].includes(value.verdict)) projected.verdict = value.verdict;
  if (["complete", "partial", "blocked"].includes(value.outcome)) projected.outcome = value.outcome;
  if (trustHostAuthority
    && ["not_run", "passed", "failed", "skipped"].includes(value.hostVerification)) {
    projected.hostVerification = value.hostVerification;
  }
  if (trustHostAuthority && value.authority === "host_asserted") projected.authority = value.authority;
  for (const key of ["write", "replayedPrompt", "structured"]) {
    if (typeof value[key] === "boolean") projected[key] = value[key];
  }
  for (const key of ["exitCode", "findings", "commands"]) {
    if (Number.isSafeInteger(value[key]) && (key === "exitCode" || value[key] >= 0)) {
      projected[key] = value[key];
    }
  }
  return Object.keys(projected).length ? projected : null;
}

function projectTaskContext(value, {
  trustHostAuthority = true,
  hideBodies = false
} = {}) {
  const context = isPlainObject(value) ? value : {};
  return {
    facts: hideBodies ? [] : publicStringList(context.facts),
    constraints: hideBodies ? [] : publicStringList(context.constraints),
    expectedProjectMarkers: publicPathList(context.expectedProjectMarkers, 32),
    requiredPaths: publicPathList(context.requiredPaths, MAX_PUBLIC_LIST_ITEMS),
    workspaceState: ["complete", "task_scoped", "unknown"].includes(context.workspaceState)
      ? context.workspaceState
      : "unknown",
    upstreamFreshness: trustHostAuthority && context.upstreamFreshness === "verified"
      ? "verified"
      : "not_checked"
  };
}

function projectAcceptanceCriteria(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isPlainObject)
    .slice(0, MAX_PUBLIC_LIST_ITEMS)
    .map((entry, index) => ({
      id: boundedText(entry.id, { fallback: `AC-${String(index + 1).padStart(2, "0")}`, max: 80 }),
      text: boundedText(entry.text, { fallback: `Criterion ${index + 1}` })
    }));
}

function projectTaskContract(envelope, publicObjective, {
  trustHostAuthority = true,
  hideContextBodies = false
} = {}) {
  if (!isPlainObject(envelope)) return null;
  return {
    schemaVersion: nullableInteger(envelope.schemaVersion),
    envelopeId: nullableText(envelope.envelopeId, 256),
    digest: nullableText(envelope.digest, 256),
    // `envelope.objective` can be the literal positional prompt. Only the
    // independently stored public objective may cross this boundary.
    objective: nullableText(publicObjective),
    mode: envelope.mode === "write" ? "write" : "read",
    scope: {
      // Scope entries are repository-relative paths or globs, not free-form
      // narrative. Drop absolute/traversing paths instead of publishing a
      // redacted placeholder that a consumer could mistake for executable scope.
      include: publicPathList(envelope.scope?.include, MAX_PUBLIC_LIST_ITEMS),
      exclude: publicPathList(envelope.scope?.exclude, MAX_PUBLIC_LIST_ITEMS)
    },
    nonGoals: publicStringList(envelope.nonGoals),
    acceptanceCriteria: projectAcceptanceCriteria(envelope.acceptanceCriteria),
    requiredVerification: publicStringList(envelope.requiredVerification),
    expectedReturnFormat: nullableText(envelope.expectedReturnFormat),
    context: projectTaskContext(envelope.context, {
      trustHostAuthority,
      hideBodies: hideContextBodies
    }),
    contextManifestId: nullableText(envelope.contextManifestId, 256)
  };
}

function projectMaterialization(value, { trustHostAuthority = true } = {}) {
  const materialization = isPlainObject(value) ? value : {};
  return {
    state: ["local_complete", "partial", "unknown"].includes(materialization.state)
      ? materialization.state
      : "unknown",
    reasons: publicStringList(materialization.reasons),
    submodules: publicStringList(materialization.submodules, { maxItems: 100 }),
    upstreamFreshness: trustHostAuthority && materialization.upstreamFreshness === "verified"
      ? "verified"
      : "not_checked"
  };
}

function projectContextManifest(value, { trustHostAuthority = true } = {}) {
  if (!isPlainObject(value)) return null;
  const git = isPlainObject(value.git) ? value.git : value;
  const projected = {
    schemaVersion: nullableInteger(value.schemaVersion),
    manifestId: nullableText(value.manifestId, 256),
    digest: nullableText(value.digest, 256),
    capturedAt: nullableIsoDateTime(value.capturedAt),
    branch: nullableText(git.branch, 256),
    head: nullableText(git.head, 256),
    dirtyDigest: nullableText(git.dirtyDigest, 256),
    dirtyEntryCount: publicByteCount(git.dirtyEntryCount),
    ignoredDigest: nullableText(git.ignoredDigest, 256),
    ignoredEntryCount: publicByteCount(git.ignoredEntryCount),
    trackedTreeIdentity: nullableText(git.trackedTreeIdentity, 256),
    metadataIdentity: nullableText(git.metadataIdentity, 256),
    insideWorktree: Boolean(git.insideWorktree),
    linkedWorktree: Boolean(git.linkedWorktree),
    sparse: Boolean(git.sparse),
    shallow: Boolean(git.shallow),
    upstreamRef: nullableText(git.upstreamRef, 256),
    upstreamCommit: nullableText(git.upstreamCommit, 256),
    upstreamFreshness: trustHostAuthority && git.upstreamFreshness === "verified" ? "verified" : "not_checked",
    projectMarkers: publicPathList(value.projectMarkers, 32),
    materialization: projectMaterialization(value.materialization, { trustHostAuthority })
  };
  // Validate the raw value only; never trim/lowercase/sanitize into a digest.
  if (trustHostAuthority
    && typeof git.taskRelevantMetadataIdentity === "string"
    && SHA256_HEX_DIGEST.test(git.taskRelevantMetadataIdentity)) {
    projected.taskRelevantMetadataIdentity = git.taskRelevantMetadataIdentity;
  }
  const sharedRefIdentity = trustHostAuthority
    ? projectSharedRefIdentitySummary(git.sharedRefIdentity)
    : null;
  if (sharedRefIdentity) projected.sharedRefIdentity = sharedRefIdentity;
  return projected;
}

/**
 * True when the worker/job is no longer admit-active.
 * Mirrors job-store terminal semantics without importing state.mjs.
 */
export function isWorkerTerminal(job) {
  return !ACTIVE_WORKER_STATUSES.has(job?.status);
}

/**
 * Project a single lifecycle event for public consumption.
 * Copies only operational fields; never invents private host/provider identity.
 */
export function projectLifecycleEvent(event, {
  trustHostAuthority = true,
  error = null
} = {}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }
  const projected = {
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    eventSchemaVersion: WORKER_EVENT_SCHEMA_VERSION,
    type: PUBLIC_LIFECYCLE_EVENT_TYPES.has(event.type) ? event.type : "checkpoint",
    at: nullableIsoDateTime(event.at),
    summary: projectWorkerStatusText(event.summary, error, {
      trustHostAuthority,
      selfDetect: true
    }),
    sequence: Number.isSafeInteger(event.sequence) && event.sequence >= 1 ? event.sequence : null
  };
  const detail = projectLifecycleDetail(event.detail, {
    trustHostAuthority,
    error
  });
  if (detail) projected.detail = detail;
  return sanitizePublicProjection(projected);
}

/**
 * Normalize and project a lifecycle event list for public snapshots.
 * Legacy unsequenced arrays receive deterministic sequences without mutating input.
 */
export function projectLifecycleEvents(events, {
  trustHostAuthority = true,
  error = null
} = {}) {
  return normalizeLifecycleEventSequences(Array.isArray(events) ? events : [])
    .slice(-MAX_LIFECYCLE_EVENTS)
    .map((event) => projectLifecycleEvent(event, { trustHostAuthority, error }))
    .filter(Boolean);
}

/**
 * Cursor-based lifecycle projection.
 *
 * @param {unknown} events stored lifecycle array (sequenced or legacy)
 * @param {number} cursor nonnegative integer; returns events with sequence > cursor
 * @param {{ terminal?: boolean, trustHostAuthority?: boolean }} [options]
 * @returns {{
 *   workerProtocolVersion: number,
 *   eventCursorSchemaVersion: number,
 *   events: object[],
 *   nextCursor: number,
 *   firstAvailableCursor: number,
 *   firstAvailableSequence: number | null,
 *   latestAvailableSequence: number,
 *   gap: boolean,
 *   terminal: boolean
 * }}
 */
export function projectLifecycleEventsAfterCursor(events, cursor = 0, options = {}) {
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new CompanionError(
      "E_USAGE",
      "Lifecycle event cursor must be a nonnegative integer."
    );
  }
  const normalized = normalizeLifecycleEventSequences(Array.isArray(events) ? events : [])
    .slice(-MAX_LIFECYCLE_EVENTS);
  const firstAvailableSequence = normalized.length ? normalized[0].sequence : null;
  const latestAvailableSequence = normalized.length ? normalized.at(-1).sequence : 0;
  // Reject an unusable future cursor. If it were accepted, later events would
  // remain invisible until their sequence surpassed the bad value.
  if (cursor > latestAvailableSequence) {
    throw new CompanionError(
      "E_USAGE",
      "Lifecycle event cursor exceeds the latest available sequence.",
      { cursor, latestAvailableSequence }
    );
  }
  // Usable replay cursor for the oldest retained event: events after this cursor
  // begin at firstAvailableSequence. Empty buffers expose cursor 0.
  const firstAvailableCursor = firstAvailableSequence == null
    ? 0
    : Math.max(0, firstAvailableSequence - 1);
  // Retention gap: client asked for events after `cursor`, but at least one
  // intermediate sequence was dropped before the first retained entry.
  const gap = firstAvailableSequence != null && firstAvailableSequence > cursor + 1;
  const selected = normalized
    .filter((event) => event.sequence > cursor)
    .map((event) => projectLifecycleEvent(event, {
      trustHostAuthority: options.trustHostAuthority !== false,
      error: options.error || null
    }))
    .filter(Boolean);
  // When already current (no new events), nextCursor stays at the supplied cursor.
  const nextCursor = selected.length
    ? selected[selected.length - 1].sequence
    : cursor;
  return {
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    eventCursorSchemaVersion: WORKER_EVENT_CURSOR_SCHEMA_VERSION,
    events: selected,
    nextCursor,
    firstAvailableCursor,
    firstAvailableSequence,
    latestAvailableSequence,
    gap,
    terminal: Boolean(options.terminal)
  };
}

function opaqueHostTaskBinding(job) {
  const kind = typeof job?.host?.kind === "string" ? job.host.kind : null;
  const sessionId = typeof job?.host?.sessionId === "string" ? job.host.sessionId : null;
  if (!kind || !sessionId) return null;
  // Stable correlation metadata for one host task. This public digest is never
  // an authorization capability; private host/session checks remain authoritative.
  const digest = crypto.createHash("sha256")
    .update([kind, sessionId].join("\0"))
    .digest("hex");
  return `host-task-${digest.slice(0, 32)}`;
}

function workerEventCursor(workerId, sequence) {
  return {
    schemaVersion: WORKER_EVENT_CURSOR_SCHEMA_VERSION,
    workerId: canonicalWorkerId(workerId),
    sequence
  };
}

function parseWorkerEventCursor(job, cursor) {
  if (cursor == null) return 0;
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
    throw new CompanionError("E_USAGE", "Worker event cursor must be a structured cursor token.");
  }
  if (cursor.schemaVersion !== WORKER_EVENT_CURSOR_SCHEMA_VERSION
    || cursor.workerId !== job?.id
    || !Number.isSafeInteger(cursor.sequence)
    || cursor.sequence < 0) {
    throw new CompanionError(
      "E_USAGE",
      "Worker event cursor does not belong to this worker stream."
    );
  }
  return cursor.sequence;
}

function projectWorkerIdentityMetadata(job) {
  const envelope = job.request?.envelope || null;
  const manifest = job.request?.contextManifest || null;
  const lifecycleEvents = normalizeLifecycleEventSequences(
    Array.isArray(job.lifecycleEvents) ? job.lifecycleEvents : []
  );
  return {
    parentWorkerId: nullableText(job.request?.resumeJobId, 256),
    lineageWorkerId: nullableText(job.request?.providerHomeId || job.id, 256),
    eventCursor: workerEventCursor(
      job.id,
      lifecycleEvents.length ? lifecycleEvents.at(-1).sequence : 0
    ),
    taskEnvelopeId: nullableText(envelope?.envelopeId, 256),
    taskEnvelopeDigest: nullableText(envelope?.digest, 256),
    contextManifestId: nullableText(manifest?.manifestId || envelope?.contextManifestId, 256),
    contextDigest: nullableText(manifest?.digest, 256),
    workspaceSnapshotDigest: nullableText(manifest?.digest, 256),
    hostTaskBinding: opaqueHostTaskBinding(job),
    securityProfile: {
      id: nullableText(job.profile?.id, 256),
      contractVersion: nullableInteger(job.profile?.contractVersion),
      agentProfileDigest: nullableText(job.profile?.agentProfileDigest, 256)
    }
  };
}

/**
 * Cursor projection bound to a job record (includes terminal state).
 * Public broker callers use structured tokens so an in-range cursor from another
 * worker cannot silently skip this worker's events.
 */
export function projectWorkerLifecycleCursor(
  job,
  cursor = null,
  { trustHostAuthority = true } = {}
) {
  if (!job || typeof job !== "object") {
    throw new CompanionError("E_STATE", "Worker cursor projection requires a job record.");
  }
  const sequence = parseWorkerEventCursor(job, cursor);
  const sanitizationError = workerSanitizationError(job);
  const projected = projectLifecycleEventsAfterCursor(job.lifecycleEvents, sequence, {
    terminal: isWorkerTerminal(job),
    trustHostAuthority,
    error: sanitizationError
  });
  return {
    ...projected,
    workerId: canonicalWorkerId(job.id),
    nextCursor: workerEventCursor(job.id, projected.nextCursor),
    firstAvailableCursor: workerEventCursor(job.id, projected.firstAvailableCursor),
    latestAvailableCursor: workerEventCursor(job.id, projected.latestAvailableSequence)
  };
}

/**
 * Lightweight public worker handle — identity and liveness without detail payload.
 * Omits prompts, raw host identity, provider session IDs, process identity, and credentials.
 */
export function projectWorkerHandle(job, { trustHostAuthority = true } = {}) {
  if (!job || typeof job !== "object") {
    throw new CompanionError("E_STATE", "Worker handle projection requires a job record.");
  }
  const sanitizationError = workerSanitizationError(job);
  return sanitizeCompleteWorkerProjection({
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    handleSchemaVersion: WORKER_HANDLE_SCHEMA_VERSION,
    id: canonicalWorkerId(job.id),
    kind: nullableText(job.kind, 128),
    jobClass: nullableText(job.jobClass, 128),
    write: Boolean(job.write),
    status: publicWorkerStatus(job.status),
    phase: nullableText(job.phase, 128),
    summary: projectWorkerStatusText(job.summary, sanitizationError, {
      trustHostAuthority
    }),
    progress: projectWorkerStatusText(job.progress, sanitizationError, {
      trustHostAuthority
    }),
    createdAt: nullableIsoDateTime(job.createdAt),
    startedAt: nullableIsoDateTime(job.startedAt),
    updatedAt: nullableIsoDateTime(job.updatedAt),
    completedAt: nullableIsoDateTime(job.completedAt),
    heartbeatAt: nullableIsoDateTime(job.heartbeatAt),
    profileId: nullableText(job.profile?.id, 256),
    model: nullableText(job.model, 256),
    effort: nullableText(job.effort, 128),
    ...projectWorkerIdentityMetadata(job),
    controlWorkspaceId: nullableText(job.controlWorkspaceId, 256),
    roleId: nullableText(job.role?.id || job.profile?.id, 256),
    externalWorkerLabel: "external-grok-worker",
    terminal: isWorkerTerminal(job)
  }, sanitizationError);
}

/**
 * Build the public result object shared by CLI status/result JSON and future brokers.
 * Never includes raw provider text, prompts, or private process fields.
 */
function projectPublicResult(job, {
  detail = true,
  trustHostAuthority = true,
  error = null
} = {}) {
  if (!detail || !job.result) return null;
  const hostVerification = trustHostAuthority
    && ["not_run", "passed", "failed", "skipped"].includes(job.result.hostVerification)
    ? job.result.hostVerification
    : "not_run";
  const cancellation = isPlainObject(job.result.cancellation)
    ? {
      requestAcceptedAt: nullableIsoDateTime(job.result.cancellation.requestAcceptedAt),
      processGroupGoneAt: nullableIsoDateTime(job.result.cancellation.processGroupGoneAt),
      terminalRecordCommittedAt: nullableIsoDateTime(job.result.cancellation.terminalRecordCommittedAt),
      receiptId: nullableText(job.result.cancellation.receiptId, 256)
    }
    : null;
  const review = projectReview(job.result.review);
  const workerReport = projectWorkerReport(job.result.workerReport);
  const reportRepair = projectReportRepair(job.result.reportRepair);
  const providerClaims = projectProviderClaims(job.result.providerClaims);
  const runtimeEvidence = projectRuntimeEvidence(job.result.runtimeEvidence, { trustHostAuthority });
  const verification = projectVerification(job.result.verification, { trustHostAuthority });
  const interim = projectTextEvidence(job.result.interim);
  const researchReport = projectResearchReport(job.result.researchReport);
  const workflow = projectWorkflow(job.result.workflow || job.workflow);
  return sanitizeCompleteWorkerProjection({
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    resultSchemaVersion: WORKER_RESULT_SCHEMA_VERSION,
    ...(review ? { review } : {}),
    ...(workerReport ? { workerReport } : {}),
    ...(reportRepair ? { reportRepair } : {}),
    ...(providerClaims ? { providerClaims } : {}),
    ...(runtimeEvidence ? { runtimeEvidence } : {}),
    ...(verification ? { verification } : {}),
    ...(researchReport ? { researchReport } : {}),
    ...(workflow ? { workflow } : {}),
    ...(typeof job.result.textDigest === "string" ? {
      textBytes: Number.isSafeInteger(job.result.textBytes) && job.result.textBytes >= 0
        ? job.result.textBytes
        : 0,
      textDigest: boundedText(job.result.textDigest, { max: 256 }),
      textTruncated: Boolean(job.result.textTruncated)
    } : {}),
    ...(interim ? { interim } : {}),
    hostVerification,
    ...(typeof job.result.stopReason === "string" ? { stopReason: boundedText(job.result.stopReason) } : {}),
    ...(cancellation ? { cancellation } : {}),
    ...(job.result.skipped ? { skipped: true, skipReason: nullableText(job.result.skipReason) } : {}),
    ...(typeof job.result.providerSessionDeleted === "boolean"
      ? { providerSessionDeleted: job.result.providerSessionDeleted }
      : {}),
    ...(typeof job.result.taskRuntimeCleaned === "boolean"
      ? { taskRuntimeCleaned: job.result.taskRuntimeCleaned }
      : {}),
    ...(typeof job.result.privacyWarning === "string"
      ? { privacyWarning: projectProcessDiagnosticWarning(job.result.privacyWarning, error) }
      : {})
  }, error);
}

function projectPublicError(error) {
  if (!isPlainObject(error)) return null;
  const { code, message } = projectPublicErrorCore(error);
  const details = projectPublicErrorDetails(code, error.details, { error });
  return sanitizeCompleteWorkerProjection({
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    errorSchemaVersion: code === "E_CONTEXT_INCOMPLETE"
      ? WORKER_CONTEXT_INCOMPLETE_ERROR_SCHEMA_VERSION
      : WORKER_ERROR_SCHEMA_VERSION,
    code,
    message,
    ...(details ? { details } : {})
  }, error);
}

/**
 * Project a foreground CLI failure through the same public error boundary used
 * by worker snapshots, without exposing protocol-envelope metadata in the
 * legacy top-level `{ ok, error }` response shape.
 */
export function projectWorkerError(error) {
  if (isPlainObject(error) && FOREGROUND_PUBLIC_ERROR_CODE_SET.has(error.code)) {
    const messageText = typeof error.message === "string" ? error.message : "";
    const message = appendContextIncompleteMessage(
      scrubProcessDiagnosticText(messageText, error, { selfDetect: true }),
      error
    );
    return sanitizePublicProjection({
      code: error.code,
      message: boundedText(message, {
        fallback: "Worker failed."
      }) || "Worker failed."
    });
  }
  const projected = projectPublicError(error);
  if (!projected) return null;
  const {
    workerProtocolVersion: _workerProtocolVersion,
    errorSchemaVersion: _errorSchemaVersion,
    ...payload
  } = projected;
  return payload;
}

function projectContextReceipt(job) {
  const request = job?.request || {};
  const fields = [
    request.contextBindingMode,
    request.contextPacket,
    request.runtimeRolePolicy,
    request.contextReceipt
  ];
  if (fields.every((value) => value === undefined)) return null;
  const continuation = request.followup
    && request.followup.childWorkerId === job.id
    && request.followup.parentWorkerId === request.resumeJobId
    && request.followup.lineageWorkerId === request.providerHomeId
    && request.providerHomeId !== job.id;
  if (request.contextBindingMode !== CONTEXT_BINDING_MODE
    || !request.contextPacket
    || !request.runtimeRolePolicy
    || !request.contextReceipt
    || (!continuation && request.providerHomeId !== job.id)) {
    throw new CompanionError("E_STATE", "Worker context binding is partial or downgraded.");
  }
  assertContextPacket(request.contextPacket, { envelope: request.envelope });
  assertRuntimeRolePolicy(request.runtimeRolePolicy, {
    role: job.role,
    profile: job.profile
  });
  assertContextReceipt(request.contextReceipt, {
    contextPacket: request.contextPacket,
    rolePolicy: request.runtimeRolePolicy,
    contextManifest: request.contextManifest,
    lineageWorkerId: continuation ? job.id : request.providerHomeId,
    effectivePromptDigest: request.providerPromptDigest
  });
  return structuredClone(request.contextReceipt);
}

/**
 * Full public worker snapshot — the single contract for CLI public JSON and brokers.
 * Compatible with the historical publicJob shape; adds explicit protocol versioning
 * and projects lifecycle events with durable sequences.
 *
 * Excludes: prompt text, host identity, provider session IDs, process identities,
 * credentials, hidden context, and raw provider messages.
 */
export function projectWorkerSnapshot(job, { detail = true, trustHostAuthority = true } = {}) {
  if (!job || typeof job !== "object") {
    throw new CompanionError("E_STATE", "Worker snapshot projection requires a job record.");
  }
  const envelope = job.request?.envelope || null;
  const manifest = job.request?.contextManifest || null;
  const contextReceipt = detail ? projectContextReceipt(job) : null;
  const sanitizationError = workerSanitizationError(job);
  return sanitizeCompleteWorkerProjection({
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    snapshotSchemaVersion: WORKER_SNAPSHOT_SCHEMA_VERSION,
    schemaVersion: nullableInteger(job.schemaVersion),
    id: canonicalWorkerId(job.id),
    kind: nullableText(job.kind, 128),
    jobClass: nullableText(job.jobClass, 128),
    write: Boolean(job.write),
    status: publicWorkerStatus(job.status),
    phase: nullableText(job.phase, 128),
    summary: projectWorkerStatusText(job.summary, sanitizationError, {
      trustHostAuthority
    }),
    progress: projectWorkerStatusText(job.progress, sanitizationError, {
      trustHostAuthority
    }),
    createdAt: nullableIsoDateTime(job.createdAt),
    startedAt: nullableIsoDateTime(job.startedAt),
    updatedAt: nullableIsoDateTime(job.updatedAt),
    completedAt: nullableIsoDateTime(job.completedAt),
    heartbeatAt: nullableIsoDateTime(job.heartbeatAt),
    profileId: nullableText(job.profile?.id, 256),
    model: nullableText(job.model, 256),
    effort: nullableText(job.effort, 128),
    ...projectWorkerIdentityMetadata(job),
    latestPlan: detail
      ? projectPublicPlan(job.latestPlan, { error: sanitizationError })
      : [],
    lifecycleEvents: detail
      ? projectLifecycleEvents(job.lifecycleEvents, {
          trustHostAuthority,
          error: sanitizationError
        })
      : [],
    taskContract: detail
      ? projectTaskContract(envelope, job.request?.publicObjective, {
        trustHostAuthority,
        hideContextBodies: contextReceipt !== null
      })
      : null,
    contextBindingMode: contextReceipt === null ? null : CONTEXT_BINDING_MODE,
    contextReceipt,
    context: detail ? projectContextManifest(manifest, { trustHostAuthority }) : null,
    resumeJobId: nullableText(job.request?.resumeJobId, 256),
    result: projectPublicResult(job, {
      detail,
      trustHostAuthority,
      error: sanitizationError
    }),
    error: projectPublicError(job.error),
    controlWorkspaceId: nullableText(job.controlWorkspaceId, 256),
    roleId: nullableText(job.role?.id || job.profile?.id, 256),
    externalWorkerLabel: "external-grok-worker",
    awaitingHostAction: projectAwaitingHostAction(job),
    terminal: isWorkerTerminal(job)
  }, sanitizationError);
}

function assertPublicContextReceiptBinding(receipt, snapshot) {
  const rootWorker = snapshot.parentWorkerId === null;
  const mismatches = [
    receipt.lineageWorkerId !== snapshot.id,
    rootWorker
      ? snapshot.lineageWorkerId !== snapshot.id
      : snapshot.lineageWorkerId === snapshot.id,
    snapshot.write !== (receipt.logicalRoleId === "implementer"),
    receipt.logicalRoleId !== snapshot.roleId,
    receipt.providerProfileId !== snapshot.profileId,
    receipt.providerProfileId !== snapshot.securityProfile?.id,
    receipt.providerProfileVersion !== snapshot.securityProfile?.contractVersion,
    receipt.agentProfileDigest !== snapshot.securityProfile?.agentProfileDigest,
    receipt.provenance?.envelopeId !== snapshot.taskEnvelopeId,
    receipt.provenance?.envelopeDigest !== snapshot.taskEnvelopeDigest,
    receipt.contextManifestId !== snapshot.contextManifestId,
    receipt.contextManifestDigest !== snapshot.contextDigest,
    snapshot.taskContract?.contextManifestId !== receipt.contextManifestId
  ];
  if (mismatches.some(Boolean)) {
    throw new CompanionError(
      "E_SCHEMA",
      "Context receipt contradicts the public worker, role, profile, envelope, or manifest identity."
    );
  }
}

/**
 * Re-project an untrusted, purportedly-public snapshot through the same
 * allowlist/redaction boundary as a private job. Version flags are descriptive,
 * never proof that a caller already validated or sanitized the object.
 */
export function normalizeWorkerSnapshot(snapshot, { detail = true } = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new CompanionError("E_SCHEMA", "Public worker snapshot must be an object.");
  }
  if (!Object.hasOwn(snapshot, "contextBindingMode")
    || ![null, CONTEXT_BINDING_MODE].includes(snapshot.contextBindingMode)) {
    throw new CompanionError(
      "E_SCHEMA",
      "Public worker snapshot is missing its exact context-binding discriminator."
    );
  }
  const hasContextReceipt = snapshot.contextReceipt !== null
    && snapshot.contextReceipt !== undefined;
  if (detail && (
    (snapshot.contextBindingMode === CONTEXT_BINDING_MODE) !== hasContextReceipt
  )) {
    throw new CompanionError(
      "E_SCHEMA",
      "Public worker snapshot context receipt was removed, added, or downgraded."
    );
  }
  const context = isPlainObject(snapshot.context) ? snapshot.context : null;
  const taskContract = isPlainObject(snapshot.taskContract) ? snapshot.taskContract : null;
  const normalized = projectWorkerSnapshot({
    schemaVersion: snapshot.schemaVersion,
    id: snapshot.id,
    kind: snapshot.kind,
    jobClass: snapshot.jobClass,
    write: snapshot.write,
    status: snapshot.status,
    phase: snapshot.phase,
    summary: snapshot.summary,
    progress: snapshot.progress,
    createdAt: snapshot.createdAt,
    startedAt: snapshot.startedAt,
    updatedAt: snapshot.updatedAt,
    completedAt: snapshot.completedAt,
    heartbeatAt: snapshot.heartbeatAt,
    profile: isPlainObject(snapshot.securityProfile)
      ? {
        id: snapshot.securityProfile.id,
        contractVersion: snapshot.securityProfile.contractVersion,
        agentProfileDigest: snapshot.securityProfile.agentProfileDigest
      }
      : null,
    model: snapshot.model,
    effort: snapshot.effort,
    latestPlan: snapshot.latestPlan,
    lifecycleEvents: snapshot.lifecycleEvents,
    request: {
      resumeJobId: snapshot.resumeJobId || snapshot.parentWorkerId,
      providerHomeId: snapshot.lineageWorkerId,
      publicObjective: taskContract?.objective,
      envelope: taskContract,
      contextManifest: context
    },
    result: snapshot.result,
    error: snapshot.error,
    controlWorkspaceId: snapshot.controlWorkspaceId,
    role: { id: snapshot.roleId },
    awaitingHostAction: snapshot.awaitingHostAction
  }, { detail, trustHostAuthority: false });
  if (typeof snapshot.hostTaskBinding === "string"
    && /^host-task-[a-f0-9]{32}$/.test(snapshot.hostTaskBinding)) {
    normalized.hostTaskBinding = snapshot.hostTaskBinding;
  }
  normalized.contextBindingMode = detail ? snapshot.contextBindingMode : null;
  if (detail && hasContextReceipt) {
    assertContextReceiptShape(snapshot.contextReceipt);
    const projectedContextReceipt = sanitizeCompleteWorkerProjection(
      structuredClone(snapshot.contextReceipt),
      workerSanitizationError(snapshot)
    );
    assertPublicContextReceiptBinding(projectedContextReceipt, normalized);
    normalized.contextReceipt = projectedContextReceipt;
    if (normalized.taskContract?.context) {
      normalized.taskContract.context.facts = [];
      normalized.taskContract.context.constraints = [];
    }
  }
  return sanitizeCompleteWorkerProjection(
    normalized,
    workerSanitizationError(normalized)
  );
}
