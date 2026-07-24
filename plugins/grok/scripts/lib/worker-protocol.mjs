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
} from "./task-contract.mjs";

/** Public protocol version for handle, snapshot, and cursor projections. */
export const WORKER_PROTOCOL_VERSION = 1;
export const WORKER_HANDLE_SCHEMA_VERSION = 1;
export const WORKER_SNAPSHOT_SCHEMA_VERSION = 1;
export const WORKER_EVENT_CURSOR_SCHEMA_VERSION = 1;
export const WORKER_EVENT_SCHEMA_VERSION = 1;
export const WORKER_RESULT_SCHEMA_VERSION = 1;
export const WORKER_ERROR_SCHEMA_VERSION = 1;

/** Every persisted runtime error that may cross the public worker boundary. */
export const PUBLIC_WORKER_ERROR_CODES = Object.freeze([
  "E_AUTH_REQUIRED",
  "E_CANCELLED",
  "E_CAPABILITY",
  "E_CONTEXT_DRIFT",
  "E_DELIVERY",
  "E_GIT_REQUIRED",
  "E_GROK_NOT_FOUND",
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
  "E_BROKER"
]);

/** Re-export retention bound so adapters share one constant with append paths. */
export { MAX_LIFECYCLE_EVENTS };

const ACTIVE_WORKER_STATUSES = new Set(["queued", "running"]);
const PUBLIC_WORKER_STATUSES = new Set(["queued", "running", "completed", "failed", "cancelled", "unknown"]);
const PUBLIC_LIFECYCLE_EVENT_TYPES = new Set(LIFECYCLE_EVENT_TYPES);
const PUBLIC_WORKER_ERROR_CODE_SET = new Set(PUBLIC_WORKER_ERROR_CODES);
const WORKER_ID_PATTERN = /^(?:review|adversarial-review|task|stop-review)-[a-f0-9]{16,64}$/;
const MAX_PUBLIC_TEXT_BYTES = 2000;
const MAX_PUBLIC_PLAN_ITEMS = 128;
const MAX_PUBLIC_LIST_ITEMS = 64;
const MAX_PUBLIC_PATH_ITEMS = 200;
const MAX_PUBLIC_REVIEW_FINDINGS = 200;
const MAX_PUBLIC_TREE_DEPTH = 8;
const MAX_PUBLIC_TREE_PROPERTIES = 64;
const MAX_PUBLIC_TREE_ITEMS = 200;
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
  "hostAction"
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

function nullableText(value, max = MAX_PUBLIC_TEXT_BYTES) {
  return typeof value === "string" ? boundedText(value, { max }) : null;
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

function projectPublicPlan(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => boundedText(item))
    .filter(Boolean)
    .slice(0, MAX_PUBLIC_PLAN_ITEMS);
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

function projectNestedError(value) {
  if (!isPlainObject(value)) return null;
  const code = PUBLIC_WORKER_ERROR_CODE_SET.has(value.code) ? value.code : "E_BROKER";
  return {
    code,
    message: boundedText(value.message, { fallback: "Worker failed." }) || "Worker failed."
  };
}

function projectPublicErrorDetails(code, value) {
  if (!isPlainObject(value)) return null;
  const projected = {};
  const warningCodes = new Set([
    "E_AUTH_REQUIRED",
    "E_CAPABILITY",
    "E_IMPORT_RESULT",
    "E_IMPORT_SOURCE",
    "E_PROVIDER_EXIT",
    "E_STATE"
  ]);
  if (warningCodes.has(code)) {
    if (typeof value.warning === "string") projected.warning = boundedText(value.warning);
    if (typeof value.privacyWarning === "string") {
      projected.privacyWarning = boundedText(value.privacyWarning);
    }
  }
  if (code === "E_CAPABILITY") {
    if (Array.isArray(value.available)) projected.available = publicStringList(value.available);
    if (Array.isArray(value.missing)) projected.missing = publicStringList(value.missing);
  } else if (code === "E_PROVIDER_EXIT") {
    if (Number.isSafeInteger(value.code)) projected.code = value.code;
    if (typeof value.signal === "string") projected.signal = boundedText(value.signal, { max: 64 });
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
  return Object.keys(projected).length ? projected : null;
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
  return {
    manifestId: nullableText(value.manifestId, 256),
    digest: nullableText(value.digest, 256),
    head: nullableText(value.head, 256),
    branch: nullableText(value.branch, 256),
    dirtyDigest: nullableText(value.dirtyDigest, 256),
    ignoredDigest: nullableText(value.ignoredDigest, 256),
    trackedTreeIdentity: nullableText(value.trackedTreeIdentity, 256),
    metadataIdentity: nullableText(value.metadataIdentity, 256)
  };
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
      at: nullableText(value.reconciler.at, 64)
    }
    : null;
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
    recordedAt: nullableText(value.recordedAt, 64),
    observedChangedPaths: publicPathList(value.observedChangedPaths)
  };
}

function projectLifecycleDetail(value, { trustHostAuthority = true } = {}) {
  if (!isPlainObject(value)) return null;
  const projected = {};
  const textFields = {
    envelopeId: 256,
    resumeJobId: 256,
    spawnSuccessDefinition: 1000,
    requestAcceptedAt: 64,
    reconciler: 128,
    messageId: 256,
    contentDigest: 256,
    parentWorkerId: 256,
    version: 128,
    name: 300,
    status: 80
  };
  for (const [key, max] of Object.entries(textFields)) {
    if (typeof value[key] === "string") projected[key] = boundedText(value[key], { max });
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
  if (Array.isArray(value.plan)) {
    projected.plan = publicStringList(value.plan, { maxItems: 20, maxBytes: 500 });
  }
  if (Array.isArray(value.questions)) projected.questions = publicStringList(value.questions);
  if (Array.isArray(value.validationIssues)) {
    projected.validationIssues = publicStringList(value.validationIssues, { maxItems: MAX_PUBLIC_PATH_ITEMS });
  }
  if (Array.isArray(value.observedChangedPaths)) {
    projected.observedChangedPaths = publicPathList(value.observedChangedPaths);
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
  return {
    schemaVersion: nullableInteger(value.schemaVersion),
    manifestId: nullableText(value.manifestId, 256),
    digest: nullableText(value.digest, 256),
    capturedAt: nullableText(value.capturedAt, 64),
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
export function projectLifecycleEvent(event, { trustHostAuthority = true } = {}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }
  const projected = {
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    eventSchemaVersion: WORKER_EVENT_SCHEMA_VERSION,
    type: PUBLIC_LIFECYCLE_EVENT_TYPES.has(event.type) ? event.type : "checkpoint",
    at: nullableText(event.at, 64),
    summary: authorityBoundText(event.summary, { trustHostAuthority }),
    sequence: Number.isSafeInteger(event.sequence) && event.sequence >= 1 ? event.sequence : null
  };
  const detail = projectLifecycleDetail(event.detail, { trustHostAuthority });
  if (detail) projected.detail = detail;
  return sanitizePublicProjection(projected);
}

/**
 * Normalize and project a lifecycle event list for public snapshots.
 * Legacy unsequenced arrays receive deterministic sequences without mutating input.
 */
export function projectLifecycleEvents(events, { trustHostAuthority = true } = {}) {
  return normalizeLifecycleEventSequences(Array.isArray(events) ? events : [])
    .slice(-MAX_LIFECYCLE_EVENTS)
    .map((event) => projectLifecycleEvent(event, { trustHostAuthority }))
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
      trustHostAuthority: options.trustHostAuthority !== false
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
  const projected = projectLifecycleEventsAfterCursor(job.lifecycleEvents, sequence, {
    terminal: isWorkerTerminal(job),
    trustHostAuthority
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
  return sanitizePublicProjection({
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    handleSchemaVersion: WORKER_HANDLE_SCHEMA_VERSION,
    id: canonicalWorkerId(job.id),
    kind: nullableText(job.kind, 128),
    jobClass: nullableText(job.jobClass, 128),
    write: Boolean(job.write),
    status: publicWorkerStatus(job.status),
    phase: nullableText(job.phase, 128),
    summary: authorityBoundText(job.summary, { trustHostAuthority }),
    progress: authorityBoundText(job.progress, { trustHostAuthority }),
    createdAt: nullableText(job.createdAt, 64),
    startedAt: nullableText(job.startedAt, 64),
    updatedAt: nullableText(job.updatedAt, 64),
    completedAt: nullableText(job.completedAt, 64),
    heartbeatAt: nullableText(job.heartbeatAt, 64),
    profileId: nullableText(job.profile?.id, 256),
    model: nullableText(job.model, 256),
    effort: nullableText(job.effort, 128),
    ...projectWorkerIdentityMetadata(job),
    controlWorkspaceId: nullableText(job.controlWorkspaceId, 256),
    roleId: nullableText(job.role?.id || job.profile?.id, 256),
    externalWorkerLabel: "external-grok-worker",
    terminal: isWorkerTerminal(job)
  });
}

/**
 * Build the public result object shared by CLI status/result JSON and future brokers.
 * Never includes raw provider text, prompts, or private process fields.
 */
function projectPublicResult(job, { detail = true, trustHostAuthority = true } = {}) {
  if (!detail || !job.result) return null;
  const hostVerification = trustHostAuthority
    && ["not_run", "passed", "failed", "skipped"].includes(job.result.hostVerification)
    ? job.result.hostVerification
    : "not_run";
  const cancellation = isPlainObject(job.result.cancellation)
    ? {
      requestAcceptedAt: nullableText(job.result.cancellation.requestAcceptedAt, 64),
      processGroupGoneAt: nullableText(job.result.cancellation.processGroupGoneAt, 64),
      terminalRecordCommittedAt: nullableText(job.result.cancellation.terminalRecordCommittedAt, 64),
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
  return sanitizePublicProjection({
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    resultSchemaVersion: WORKER_RESULT_SCHEMA_VERSION,
    ...(review ? { review } : {}),
    ...(workerReport ? { workerReport } : {}),
    ...(reportRepair ? { reportRepair } : {}),
    ...(providerClaims ? { providerClaims } : {}),
    ...(runtimeEvidence ? { runtimeEvidence } : {}),
    ...(verification ? { verification } : {}),
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
      ? { privacyWarning: boundedText(job.result.privacyWarning) }
      : {})
  });
}

function projectPublicError(error) {
  if (!error || typeof error !== "object") return null;
  const code = PUBLIC_WORKER_ERROR_CODE_SET.has(error.code) ? error.code : "E_BROKER";
  const message = code === "E_PROCESS_IDENTITY"
    ? "Process ownership verification failed."
    : boundedText(error.message, { fallback: "Worker failed." }) || "Worker failed.";
  const details = projectPublicErrorDetails(code, error.details);
  return sanitizePublicProjection({
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    errorSchemaVersion: WORKER_ERROR_SCHEMA_VERSION,
    code,
    message,
    ...(details ? { details } : {})
  });
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
  if (request.contextBindingMode !== CONTEXT_BINDING_MODE
    || !request.contextPacket
    || !request.runtimeRolePolicy
    || !request.contextReceipt
    || request.providerHomeId !== job.id) {
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
    lineageWorkerId: request.providerHomeId,
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
  return sanitizePublicProjection({
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    snapshotSchemaVersion: WORKER_SNAPSHOT_SCHEMA_VERSION,
    schemaVersion: nullableInteger(job.schemaVersion),
    id: canonicalWorkerId(job.id),
    kind: nullableText(job.kind, 128),
    jobClass: nullableText(job.jobClass, 128),
    write: Boolean(job.write),
    status: publicWorkerStatus(job.status),
    phase: nullableText(job.phase, 128),
    summary: authorityBoundText(job.summary, { trustHostAuthority }),
    progress: authorityBoundText(job.progress, { trustHostAuthority }),
    createdAt: nullableText(job.createdAt, 64),
    startedAt: nullableText(job.startedAt, 64),
    updatedAt: nullableText(job.updatedAt, 64),
    completedAt: nullableText(job.completedAt, 64),
    heartbeatAt: nullableText(job.heartbeatAt, 64),
    profileId: nullableText(job.profile?.id, 256),
    model: nullableText(job.model, 256),
    effort: nullableText(job.effort, 128),
    ...projectWorkerIdentityMetadata(job),
    latestPlan: detail ? projectPublicPlan(job.latestPlan) : [],
    lifecycleEvents: detail ? projectLifecycleEvents(job.lifecycleEvents, { trustHostAuthority }) : [],
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
    result: projectPublicResult(job, { detail, trustHostAuthority }),
    error: projectPublicError(job.error),
    controlWorkspaceId: nullableText(job.controlWorkspaceId, 256),
    roleId: nullableText(job.role?.id || job.profile?.id, 256),
    externalWorkerLabel: "external-grok-worker",
    awaitingHostAction: projectAwaitingHostAction(job),
    terminal: isWorkerTerminal(job)
  });
}

function assertPublicContextReceiptBinding(receipt, snapshot) {
  const mismatches = [
    receipt.lineageWorkerId !== snapshot.id,
    snapshot.lineageWorkerId !== snapshot.id,
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
    assertPublicContextReceiptBinding(snapshot.contextReceipt, normalized);
    normalized.contextReceipt = structuredClone(snapshot.contextReceipt);
    if (normalized.taskContract?.context) {
      normalized.taskContract.context.facts = [];
      normalized.taskContract.context.constraints = [];
    }
  }
  return sanitizePublicProjection(normalized);
}
