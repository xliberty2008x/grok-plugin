import crypto from "node:crypto";
import path from "node:path";

import { CompanionError } from "./errors.mjs";
import { sanitizeDisplayText } from "./redact.mjs";

export const EXECUTION_BINDING_SCHEMA_VERSION = 1;
export const EXECUTION_PROVISIONING_SCHEMA_VERSION = 1;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const WORKER_ID = /^(?:review|adversarial-review|task|stop-review)-[a-f0-9]{16,64}$/;
const CONTROL_WORKSPACE_ID = /^cws-[a-f0-9]{32}$/;
const CONTEXT_MANIFEST_ID = /^ctx-[a-f0-9]{24}$/;
const BINDING_ID = /^exec-[a-f0-9]{24}$/;
const OPAQUE_ID = /^[a-f0-9]{32,64}$/;
const EXACT_NONCE_ID = /^[a-f0-9]{32}$/;
const ERROR_CODE = /^E_[A-Z0-9_]{1,62}[A-Z0-9]$/;
const MAX_SCOPE_ITEMS = 64;
const MAX_SCOPE_ITEM_CHARS = 2_048;
const MAX_PROCESS_TOKEN_CHARS = 256;
const MAX_ERROR_MESSAGE_CHARS = 1_024;
const MAX_PROVISIONING_LEASE_MS = 300_000;

const BINDING_INPUT_KEYS = new Set([
  "workerId",
  "controlWorkspaceId",
  "controlRoot",
  "gitCommonDir",
  "baseCommit",
  "baseTree",
  "parentFingerprint",
  "expectedExecutionRoot",
  "scope",
  "envelopeDigest",
  "roleDigest",
  "profileDigest",
  "runtimeRolePolicyDigest",
  "admissionContextManifestId",
  "admissionContextManifestDigest",
  "providerCapabilityDigest",
  "ownerDigest",
  "cancellationNonce",
  "createdAt"
]);

const BINDING_KEYS = new Set([
  "schemaVersion",
  "workerId",
  "controlWorkspaceId",
  "controlRoot",
  "controlRootDigest",
  "gitCommonDir",
  "gitCommonDirDigest",
  "baseCommit",
  "baseTree",
  "parentFingerprint",
  "parentFingerprintDigest",
  "expectedExecutionRoot",
  "expectedExecutionRootDigest",
  "scope",
  "scopeDigest",
  "envelopeDigest",
  "roleDigest",
  "profileDigest",
  "runtimeRolePolicyDigest",
  "admissionContextManifestId",
  "admissionContextManifestDigest",
  "providerCapabilityDigest",
  "ownerDigest",
  "cancellationNonceDigest",
  "createdAt",
  "bindingId",
  "bindingDigest"
]);

const PARENT_FINGERPRINT_KEYS = new Set([
  "fingerprintVersion",
  "head",
  "tree",
  "clean",
  "statusDigest",
  "indexDigest",
  "indexSecurityDigest",
  "worktreeDigest",
  "worktreeEntryCount",
  "status",
  "fingerprintDigest"
]);

const PARENT_FINGERPRINT_CORE_KEYS = [
  "fingerprintVersion",
  "head",
  "tree",
  "clean",
  "statusDigest",
  "indexDigest",
  "indexSecurityDigest",
  "worktreeDigest",
  "worktreeEntryCount",
  "status"
];

const SCOPE_KEYS = new Set(["include", "exclude"]);

const JOURNAL_KEYS = new Set([
  "schemaVersion",
  "bindingDigest",
  "state",
  "journalRevision",
  "previousJournalDigest",
  "cancellationNonce",
  "attemptId",
  "fence",
  "provisioner",
  "cleanupProvisioner",
  "leaseExpiresAt",
  "plannedAt",
  "provisioningAt",
  "readyAt",
  "cleanupPendingAt",
  "cleanedAt",
  "failedAt",
  "executionContextManifestId",
  "executionContextManifestDigest",
  "error",
  "journalDigest"
]);

const PROVISIONER_KEYS = new Set(["pid", "startToken", "holderId"]);
const ERROR_KEYS = new Set(["code", "message"]);
const JOURNAL_STATES = new Set([
  "planned",
  "provisioning",
  "ready",
  "cleanup_pending",
  "cleaned",
  "failed"
]);

const LEGAL_TRANSITIONS = new Set([
  "planned:provisioning",
  "planned:cleanup_pending",
  "planned:failed",
  "provisioning:ready",
  "provisioning:cleanup_pending",
  "ready:cleanup_pending",
  "cleanup_pending:cleaned",
  "cleanup_pending:failed"
]);

const TRANSITION_EDGE_KEYS = new Map([
  ["planned:provisioning", new Set([
    "state",
    "expectedCurrentJournalDigest",
    "attemptId",
    "fence",
    "provisioner",
    "leaseExpiresAt",
    "provisioningAt"
  ])],
  ["planned:cleanup_pending", new Set([
    "state",
    "expectedCurrentJournalDigest",
    "cleanupPendingAt"
  ])],
  ["planned:failed", new Set([
    "state",
    "expectedCurrentJournalDigest",
    "failedAt",
    "error"
  ])],
  ["provisioning:ready", new Set([
    "state",
    "expectedCurrentJournalDigest",
    "actorAttemptId",
    "actorFence",
    "actorHolderId",
    "readyAt",
    "executionContextManifestId",
    "executionContextManifestDigest"
  ])],
  ["provisioning:cleanup_pending", new Set([
    "state",
    "expectedCurrentJournalDigest",
    "actorAttemptId",
    "actorFence",
    "actorHolderId",
    "cleanupPendingAt"
  ])],
  ["ready:cleanup_pending", new Set([
    "state",
    "expectedCurrentJournalDigest",
    "cleanupPendingAt"
  ])],
  ["cleanup_pending:cleaned", new Set([
    "state",
    "expectedCurrentJournalDigest",
    "cleanedAt"
  ])],
  ["cleanup_pending:failed", new Set([
    "state",
    "expectedCurrentJournalDigest",
    "failedAt",
    "error"
  ])]
]);

const RECLAIM_KEYS = new Set([
  "expectedCurrentJournalDigest",
  "priorAttemptId",
  "priorFence",
  "priorHolderId",
  "attemptId",
  "fence",
  "provisioner",
  "provisioningAt",
  "leaseExpiresAt",
  "reclaimEvidence"
]);
const PROCESS_DEAD_EVIDENCE_KEYS = new Set([
  "kind",
  "pid",
  "startToken",
  "observedAt"
]);
const LEASE_EXPIRED_EVIDENCE_KEYS = new Set(["kind", "observedAt"]);

function stateError(message) {
  throw new CompanionError("E_STATE", message);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  return isPlainRecord(value)
    && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key));
}

function stableStringify(value, ancestors = new Set()) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (ancestors.has(value)) stateError("Execution binding data must not be cyclic.");
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    result = `[${value.map((item) => stableStringify(item, ancestors)).join(",")}]`;
  } else {
    const keys = Object.keys(value).sort();
    result = `{${keys.map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key], ancestors)}`
    )).join(",")}}`;
  }
  ancestors.delete(value);
  return result;
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : stableStringify(value))
    .digest("hex");
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function unicodeScalarLength(value) {
  return Array.from(value).length;
}

function hasOnlyValidUnicodeScalars(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

function validIsoTimestamp(value) {
  if (typeof value !== "string" || !value) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function timestampMs(value, label) {
  if (!validIsoTimestamp(value)) stateError(`${label} must be a canonical ISO timestamp.`);
  return Date.parse(value);
}

function nullableTimestampMs(value, label) {
  return value === null ? null : timestampMs(value, label);
}

function assertCanonicalAbsolutePath(value, label) {
  if (
    typeof value !== "string"
    || !value
    || value.includes("\0")
    || !hasOnlyValidUnicodeScalars(value)
    || !path.isAbsolute(value)
    || path.normalize(value) !== value
    || path.resolve(value) !== value
  ) {
    stateError(`${label} must be a canonical absolute path.`);
  }
  return value;
}

function assertDigest(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (!SHA256_HEX.test(value || "")) stateError(`${label} must be a lower-case SHA-256 digest.`);
  return value;
}

function assertCanonicalScope(scope) {
  if (!hasExactKeys(scope, SCOPE_KEYS)) {
    stateError("Execution binding scope must use the exact TaskEnvelope scope shape.");
  }
  for (const field of ["include", "exclude"]) {
    if (!Array.isArray(scope[field]) || scope[field].length > MAX_SCOPE_ITEMS) {
      stateError("Execution binding scope exceeds the TaskEnvelope item bound.");
    }
    for (const item of scope[field]) {
      if (
        typeof item !== "string"
        || item.length === 0
        || item.trim() !== item
        || item.includes("\0")
        || !hasOnlyValidUnicodeScalars(item)
        || unicodeScalarLength(item) > MAX_SCOPE_ITEM_CHARS
        || sanitizeDisplayText(item) !== item
      ) {
        stateError("Execution binding scope is not a canonical TaskEnvelope scope.");
      }
    }
  }
  return scope;
}

function parentFingerprintCore(parentFingerprint) {
  return Object.fromEntries(
    PARENT_FINGERPRINT_CORE_KEYS.map((key) => [key, parentFingerprint[key]])
  );
}

function assertParentFingerprint(parentFingerprint, { baseCommit, baseTree } = {}) {
  if (!hasExactKeys(parentFingerprint, PARENT_FINGERPRINT_KEYS)) {
    stateError("Execution binding parent fingerprint has an unsupported shape.");
  }
  if (
    parentFingerprint.fingerprintVersion !== 1
    || !OBJECT_ID.test(parentFingerprint.head || "")
    || !OBJECT_ID.test(parentFingerprint.tree || "")
    || parentFingerprint.head.length !== parentFingerprint.tree.length
    || parentFingerprint.clean !== true
    || parentFingerprint.status !== ""
    || parentFingerprint.statusDigest !== sha256(parentFingerprint.status)
    || !SHA256_HEX.test(parentFingerprint.indexDigest || "")
    || !SHA256_HEX.test(parentFingerprint.indexSecurityDigest || "")
    || !SHA256_HEX.test(parentFingerprint.worktreeDigest || "")
    || !Number.isSafeInteger(parentFingerprint.worktreeEntryCount)
    || parentFingerprint.worktreeEntryCount < 0
    || parentFingerprint.fingerprintDigest !== sha256(parentFingerprintCore(parentFingerprint))
  ) {
    stateError("Execution binding requires a complete trusted clean-parent fingerprint.");
  }
  if (
    (baseCommit != null && parentFingerprint.head !== baseCommit)
    || (baseTree != null && parentFingerprint.tree !== baseTree)
  ) {
    stateError("Execution binding base identity does not match its parent fingerprint.");
  }
  return parentFingerprint;
}

function bindingBody(binding) {
  const body = {};
  for (const key of BINDING_KEYS) {
    if (!["schemaVersion", "bindingId", "bindingDigest"].includes(key)) {
      body[key] = binding[key];
    }
  }
  return body;
}

function bindingWithoutDigest(binding) {
  const unsigned = {};
  for (const key of BINDING_KEYS) {
    if (key !== "bindingDigest") unsigned[key] = binding[key];
  }
  return unsigned;
}

function expectedBindingId(binding) {
  return `exec-${sha256(bindingBody(binding)).slice(0, 24)}`;
}

function assertExpectedBinding(binding, expected) {
  if (expected === undefined) return;
  if (!isPlainRecord(expected) || Object.keys(expected).some((key) => !BINDING_KEYS.has(key))) {
    stateError("Execution binding expected identity contains an unsupported field.");
  }
  for (const [key, value] of Object.entries(expected)) {
    if (stableStringify(binding[key]) !== stableStringify(value)) {
      stateError("Execution binding does not match its expected identity.");
    }
  }
}

export function assertExecutionBinding(binding, expected = undefined) {
  if (!hasExactKeys(binding, BINDING_KEYS)) {
    stateError("Execution binding has an unsupported shape.");
  }
  if (
    binding.schemaVersion !== EXECUTION_BINDING_SCHEMA_VERSION
    || !WORKER_ID.test(binding.workerId || "")
    || !CONTROL_WORKSPACE_ID.test(binding.controlWorkspaceId || "")
    || !OBJECT_ID.test(binding.baseCommit || "")
    || !OBJECT_ID.test(binding.baseTree || "")
    || binding.baseCommit.length !== binding.baseTree.length
    || !CONTEXT_MANIFEST_ID.test(binding.admissionContextManifestId || "")
    || !BINDING_ID.test(binding.bindingId || "")
  ) {
    stateError("Execution binding contains an invalid version or immutable identity.");
  }

  assertCanonicalAbsolutePath(binding.controlRoot, "controlRoot");
  assertCanonicalAbsolutePath(binding.gitCommonDir, "gitCommonDir");
  assertCanonicalAbsolutePath(binding.expectedExecutionRoot, "expectedExecutionRoot");
  if (
    binding.controlRoot === binding.expectedExecutionRoot
    || binding.gitCommonDir === binding.expectedExecutionRoot
  ) {
    stateError("Execution binding roots must preserve control/execution isolation.");
  }

  assertDigest(binding.controlRootDigest, "controlRootDigest");
  assertDigest(binding.gitCommonDirDigest, "gitCommonDirDigest");
  assertDigest(binding.parentFingerprintDigest, "parentFingerprintDigest");
  assertDigest(binding.expectedExecutionRootDigest, "expectedExecutionRootDigest");
  assertDigest(binding.scopeDigest, "scopeDigest");
  assertDigest(binding.envelopeDigest, "envelopeDigest");
  assertDigest(binding.roleDigest, "roleDigest");
  assertDigest(binding.profileDigest, "profileDigest");
  assertDigest(binding.runtimeRolePolicyDigest, "runtimeRolePolicyDigest");
  assertDigest(binding.admissionContextManifestDigest, "admissionContextManifestDigest");
  assertDigest(binding.providerCapabilityDigest, "providerCapabilityDigest", { nullable: true });
  assertDigest(binding.ownerDigest, "ownerDigest");
  assertDigest(binding.cancellationNonceDigest, "cancellationNonceDigest");
  assertDigest(binding.bindingDigest, "bindingDigest");
  timestampMs(binding.createdAt, "createdAt");

  assertCanonicalScope(binding.scope);
  assertParentFingerprint(binding.parentFingerprint, {
    baseCommit: binding.baseCommit,
    baseTree: binding.baseTree
  });

  if (
    binding.controlRootDigest !== sha256(binding.controlRoot)
    || binding.gitCommonDirDigest !== sha256(binding.gitCommonDir)
    || binding.parentFingerprintDigest !== sha256(binding.parentFingerprint)
    || binding.expectedExecutionRootDigest !== sha256(binding.expectedExecutionRoot)
    || binding.scopeDigest !== sha256(binding.scope)
    || binding.bindingId !== expectedBindingId(binding)
    || binding.bindingDigest !== sha256(bindingWithoutDigest(binding))
  ) {
    stateError("Execution binding digest evidence is inconsistent.");
  }

  assertExpectedBinding(binding, expected);
  return binding;
}

export function createExecutionBinding(input = {}) {
  if (!hasExactKeys(input, BINDING_INPUT_KEYS)) {
    stateError("Execution binding input has an unsupported shape.");
  }
  assertCanonicalAbsolutePath(input.controlRoot, "controlRoot");
  assertCanonicalAbsolutePath(input.gitCommonDir, "gitCommonDir");
  assertCanonicalAbsolutePath(input.expectedExecutionRoot, "expectedExecutionRoot");
  assertCanonicalScope(input.scope);
  assertExactNonceId(input.cancellationNonce, "cancellationNonce");
  assertParentFingerprint(input.parentFingerprint, {
    baseCommit: input.baseCommit,
    baseTree: input.baseTree
  });

  const binding = {
    schemaVersion: EXECUTION_BINDING_SCHEMA_VERSION,
    workerId: input.workerId,
    controlWorkspaceId: input.controlWorkspaceId,
    controlRoot: input.controlRoot,
    controlRootDigest: sha256(input.controlRoot),
    gitCommonDir: input.gitCommonDir,
    gitCommonDirDigest: sha256(input.gitCommonDir),
    baseCommit: input.baseCommit,
    baseTree: input.baseTree,
    parentFingerprint: { ...input.parentFingerprint },
    parentFingerprintDigest: sha256(input.parentFingerprint),
    expectedExecutionRoot: input.expectedExecutionRoot,
    expectedExecutionRootDigest: sha256(input.expectedExecutionRoot),
    scope: {
      include: [...input.scope.include],
      exclude: [...input.scope.exclude]
    },
    scopeDigest: sha256(input.scope),
    envelopeDigest: input.envelopeDigest,
    roleDigest: input.roleDigest,
    profileDigest: input.profileDigest,
    runtimeRolePolicyDigest: input.runtimeRolePolicyDigest,
    admissionContextManifestId: input.admissionContextManifestId,
    admissionContextManifestDigest: input.admissionContextManifestDigest,
    providerCapabilityDigest: input.providerCapabilityDigest,
    ownerDigest: input.ownerDigest,
    cancellationNonceDigest: sha256(input.cancellationNonce),
    createdAt: input.createdAt,
    bindingId: null,
    bindingDigest: null
  };
  binding.bindingId = expectedBindingId(binding);
  binding.bindingDigest = sha256(bindingWithoutDigest(binding));
  assertExecutionBinding(binding);
  return deepFreeze(binding);
}

function journalWithoutDigest(journal) {
  const unsigned = {};
  for (const key of JOURNAL_KEYS) {
    if (key !== "journalDigest") unsigned[key] = journal[key];
  }
  return unsigned;
}

function assertOpaqueId(value, label) {
  if (!OPAQUE_ID.test(value || "")) stateError(`${label} must be an opaque lower-case hexadecimal identity.`);
}

function assertExactNonceId(value, label) {
  if (!EXACT_NONCE_ID.test(value || "")) {
    stateError(`${label} must be an exact 32-character lower-case hexadecimal identity.`);
  }
}

function assertProvisioner(value) {
  if (!hasExactKeys(value, PROVISIONER_KEYS)
    || !Number.isSafeInteger(value.pid)
    || value.pid < 1
    || value.pid > 2_147_483_647
    || typeof value.startToken !== "string"
    || !value.startToken
    || value.startToken.trim() !== value.startToken
    || value.startToken === "[REDACTED]"
    || value.startToken.includes("\0")
    || !hasOnlyValidUnicodeScalars(value.startToken)
    || unicodeScalarLength(value.startToken) > MAX_PROCESS_TOKEN_CHARS
    || !OPAQUE_ID.test(value.holderId || "")) {
    stateError("Provisioning journal provisioner identity is malformed.");
  }
  return value;
}

function assertBoundedError(value) {
  if (!hasExactKeys(value, ERROR_KEYS)
    || !ERROR_CODE.test(value.code || "")
    || typeof value.message !== "string"
    || !value.message
    || value.message.trim() !== value.message
    || value.message.includes("\0")
    || !hasOnlyValidUnicodeScalars(value.message)
    || unicodeScalarLength(value.message) > MAX_ERROR_MESSAGE_CHARS
    || sanitizeDisplayText(value.message) !== value.message) {
    stateError("Provisioning journal error is malformed or exceeds its private bound.");
  }
  return value;
}

function reachedProvisioning(journal) {
  return journal.provisioningAt !== null;
}

function assertJournalStateShape(journal) {
  if (
    !Number.isSafeInteger(journal.journalRevision)
    || journal.journalRevision < 0
    || (
      journal.journalRevision === 0
        ? journal.previousJournalDigest !== null || journal.state !== "planned"
        : !SHA256_HEX.test(journal.previousJournalDigest || "") || journal.state === "planned"
    )
  ) {
    stateError("Provisioning journal revision chain is malformed.");
  }

  const hasAttempt = journal.attemptId !== null;
  if (
    (hasAttempt && (!EXACT_NONCE_ID.test(journal.attemptId) || journal.fence < 1))
    || (!hasAttempt && journal.fence !== 0)
    || !Number.isSafeInteger(journal.fence)
    || journal.fence < 0
  ) {
    stateError("Provisioning journal attempt identity is inconsistent.");
  }

  const active = journal.state === "provisioning";
  if (active) {
    assertProvisioner(journal.provisioner);
    if (!hasAttempt || journal.provisioningAt === null || journal.leaseExpiresAt === null) {
      stateError("Active provisioning journal is missing its fenced lease identity.");
    }
  } else if (journal.provisioner !== null || journal.leaseExpiresAt !== null) {
    stateError("Provisioning journal retains a provisioner lease outside provisioning.");
  }

  const cleanupProvisionerRequired = (
    ["cleanup_pending", "cleaned", "failed"].includes(journal.state)
    && journal.cleanupPendingAt !== null
    && hasAttempt
    && journal.readyAt === null
  );
  if (cleanupProvisionerRequired) {
    assertProvisioner(journal.cleanupProvisioner);
  } else if (journal.cleanupProvisioner !== null) {
    stateError("Provisioning journal retains cleanup process identity outside active cleanup.");
  }

  const executionContextRequired = journal.readyAt !== null;
  if (executionContextRequired) {
    if (
      !["ready", "cleanup_pending", "cleaned", "failed"].includes(journal.state)
      ||
      !CONTEXT_MANIFEST_ID.test(journal.executionContextManifestId || "")
      || !SHA256_HEX.test(journal.executionContextManifestDigest || "")
    ) {
      stateError("Ready provisioning journal lacks an execution ContextManifest identity.");
    }
  } else if (
    journal.executionContextManifestId !== null
    || journal.executionContextManifestDigest !== null
  ) {
    stateError("Provisioning journal exposes execution context before ready.");
  }

  if (journal.state === "failed") {
    assertBoundedError(journal.error);
  } else if (journal.error !== null) {
    stateError("Provisioning journal retains an error outside failed state.");
  }

  const timestampRules = {
    planned: {
      provisioningAt: false, readyAt: false, cleanupPendingAt: false, cleanedAt: false, failedAt: false
    },
    provisioning: {
      provisioningAt: true, readyAt: false, cleanupPendingAt: false, cleanedAt: false, failedAt: false
    },
    ready: {
      provisioningAt: true, readyAt: true, cleanupPendingAt: false, cleanedAt: false, failedAt: false
    },
    cleanup_pending: {
      provisioningAt: hasAttempt, cleanupPendingAt: true, cleanedAt: false, failedAt: false
    },
    cleaned: {
      provisioningAt: hasAttempt, cleanupPendingAt: true, cleanedAt: true, failedAt: false
    }
  };
  if (journal.state === "failed") {
    if (
      (journal.provisioningAt !== null) !== hasAttempt
      || (hasAttempt && journal.cleanupPendingAt === null)
      || journal.cleanedAt !== null
      || journal.failedAt === null
    ) {
      stateError("Provisioning journal timestamps are inconsistent with its state.");
    }
  } else {
    const rules = timestampRules[journal.state];
    for (const [field, required] of Object.entries(rules)) {
      if (required !== (journal[field] !== null)) {
        stateError("Provisioning journal timestamps are inconsistent with its state.");
      }
    }
  }
}

function assertJournalTimeline(binding, journal) {
  const bindingAt = timestampMs(binding.createdAt, "binding.createdAt");
  const plannedAt = timestampMs(journal.plannedAt, "plannedAt");
  if (plannedAt < bindingAt) stateError("Provisioning journal predates its execution binding.");

  const provisioningAt = nullableTimestampMs(journal.provisioningAt, "provisioningAt");
  const readyAt = nullableTimestampMs(journal.readyAt, "readyAt");
  const cleanupPendingAt = nullableTimestampMs(journal.cleanupPendingAt, "cleanupPendingAt");
  const cleanedAt = nullableTimestampMs(journal.cleanedAt, "cleanedAt");
  const failedAt = nullableTimestampMs(journal.failedAt, "failedAt");
  const leaseExpiresAt = nullableTimestampMs(journal.leaseExpiresAt, "leaseExpiresAt");

  if (provisioningAt !== null && provisioningAt < plannedAt) {
    stateError("Provisioning journal provisioning timestamp is not monotonic.");
  }
  if (readyAt !== null && (provisioningAt === null || readyAt < provisioningAt)) {
    stateError("Provisioning journal ready timestamp is not monotonic.");
  }
  const latestBeforeCleanup = readyAt ?? provisioningAt ?? plannedAt;
  if (cleanupPendingAt !== null && cleanupPendingAt < latestBeforeCleanup) {
    stateError("Provisioning journal cleanup timestamp is not monotonic.");
  }
  if (cleanedAt !== null && (cleanupPendingAt === null || cleanedAt < cleanupPendingAt)) {
    stateError("Provisioning journal cleaned timestamp is not monotonic.");
  }
  const latestBeforeFailure = cleanupPendingAt ?? readyAt ?? provisioningAt ?? plannedAt;
  if (failedAt !== null && failedAt < latestBeforeFailure) {
    stateError("Provisioning journal failure timestamp is not monotonic.");
  }
  if (
    leaseExpiresAt !== null
    && (
      provisioningAt === null
      || leaseExpiresAt <= provisioningAt
      || leaseExpiresAt - provisioningAt > MAX_PROVISIONING_LEASE_MS
    )
  ) {
    stateError("Provisioning journal lease must expire after provisioning begins.");
  }
}

export function assertProvisioningJournal(binding, journal) {
  const trustedBinding = assertExecutionBinding(binding);
  if (!hasExactKeys(journal, JOURNAL_KEYS)
    || journal.schemaVersion !== EXECUTION_PROVISIONING_SCHEMA_VERSION
    || journal.bindingDigest !== trustedBinding.bindingDigest
    || !JOURNAL_STATES.has(journal.state)
    || !SHA256_HEX.test(journal.journalDigest || "")) {
    stateError("Provisioning journal has an unsupported shape or binding.");
  }
  assertExactNonceId(journal.cancellationNonce, "cancellationNonce");
  if (sha256(journal.cancellationNonce) !== trustedBinding.cancellationNonceDigest) {
    stateError("Provisioning journal cancellation nonce does not match its execution binding.");
  }
  assertJournalStateShape(journal);
  assertJournalTimeline(trustedBinding, journal);
  if (journal.journalDigest !== sha256(journalWithoutDigest(journal))) {
    stateError("Provisioning journal digest evidence is inconsistent.");
  }
  return journal;
}

export function createProvisioningJournal({
  binding,
  cancellationNonce,
  createdAt
} = {}) {
  const trustedBinding = assertExecutionBinding(binding);
  assertExactNonceId(cancellationNonce, "cancellationNonce");
  timestampMs(createdAt, "createdAt");
  const journal = {
    schemaVersion: EXECUTION_PROVISIONING_SCHEMA_VERSION,
    bindingDigest: trustedBinding.bindingDigest,
    state: "planned",
    journalRevision: 0,
    previousJournalDigest: null,
    cancellationNonce,
    attemptId: null,
    fence: 0,
    provisioner: null,
    cleanupProvisioner: null,
    leaseExpiresAt: null,
    plannedAt: createdAt,
    provisioningAt: null,
    readyAt: null,
    cleanupPendingAt: null,
    cleanedAt: null,
    failedAt: null,
    executionContextManifestId: null,
    executionContextManifestDigest: null,
    error: null,
    journalDigest: null
  };
  journal.journalDigest = sha256(journalWithoutDigest(journal));
  assertProvisioningJournal(trustedBinding, journal);
  return deepFreeze(journal);
}

function nextJournalRevision(current) {
  if (current.journalRevision >= Number.MAX_SAFE_INTEGER) {
    stateError("Provisioning journal revision is exhausted.");
  }
  return current.journalRevision + 1;
}

function assertProvisioningActor(current, request) {
  if (
    request.actorAttemptId !== current.attemptId
    || request.actorFence !== current.fence
    || request.actorHolderId !== current.provisioner.holderId
  ) {
    stateError("Provisioning transition actor does not own the current fenced attempt.");
  }
}

function assertTransitionRequest(current, request) {
  if (
    !isPlainRecord(request)
    || !Object.hasOwn(request, "state")
    || !JOURNAL_STATES.has(request.state)
  ) {
    stateError("Provisioning journal transition request is malformed.");
  }
  if (request.state === current.state) {
    if (!hasExactKeys(request, new Set(["state"]))) {
      stateError("A same-state provisioning transition must be exactly idempotent.");
    }
    return null;
  }

  const edge = `${current.state}:${request.state}`;
  const edgeKeys = TRANSITION_EDGE_KEYS.get(edge);
  if (!LEGAL_TRANSITIONS.has(edge) || !edgeKeys || !hasExactKeys(request, edgeKeys)) {
    stateError("Provisioning journal transition is illegal or non-monotonic.");
  }
  assertDigest(request.expectedCurrentJournalDigest, "expectedCurrentJournalDigest");
  if (request.expectedCurrentJournalDigest !== current.journalDigest) {
    stateError("Provisioning journal transition does not match the current durable revision.");
  }
  if (current.state === "provisioning") assertProvisioningActor(current, request);
  return edge;
}

export function transitionProvisioningJournal(binding, journal, request) {
  const trustedBinding = assertExecutionBinding(binding);
  const current = assertProvisioningJournal(trustedBinding, journal);
  const edge = assertTransitionRequest(current, request);
  if (edge === null) return current;

  const next = {
    ...current,
    state: request.state,
    journalRevision: nextJournalRevision(current),
    previousJournalDigest: current.journalDigest,
    journalDigest: null
  };

  if (edge === "planned:provisioning") {
    next.attemptId = request.attemptId;
    next.fence = request.fence;
    next.provisioner = { ...request.provisioner };
    next.leaseExpiresAt = request.leaseExpiresAt;
    next.provisioningAt = request.provisioningAt;
  } else if (edge.endsWith(":cleanup_pending")) {
    next.cleanupPendingAt = request.cleanupPendingAt;
    if (current.state === "provisioning") {
      next.cleanupProvisioner = { ...current.provisioner };
      next.provisioner = null;
      next.leaseExpiresAt = null;
    }
  } else if (edge.endsWith(":failed")) {
    next.failedAt = request.failedAt;
    next.error = { ...request.error };
  } else if (edge === "provisioning:ready") {
    next.provisioner = null;
    next.leaseExpiresAt = null;
    next.readyAt = request.readyAt;
    next.executionContextManifestId = request.executionContextManifestId;
    next.executionContextManifestDigest = request.executionContextManifestDigest;
  } else if (edge === "cleanup_pending:cleaned") {
    next.cleanedAt = request.cleanedAt;
  }

  if (
    edge === "planned:provisioning"
    && (
      !EXACT_NONCE_ID.test(next.attemptId || "")
      || next.fence !== current.fence + 1
    )
  ) {
    stateError("Provisioning transition requires a new fenced attempt identity.");
  }

  next.journalDigest = sha256(journalWithoutDigest(next));
  assertProvisioningJournal(trustedBinding, next);
  return deepFreeze(next);
}

function assertReclaimEvidence(current, evidence) {
  if (!isPlainRecord(evidence)) {
    stateError("Provisioning reclaim evidence is malformed.");
  }
  let observedAt;
  if (evidence.kind === "process-dead") {
    if (!hasExactKeys(evidence, PROCESS_DEAD_EVIDENCE_KEYS)
      || evidence.pid !== current.provisioner.pid
      || evidence.startToken !== current.provisioner.startToken) {
      stateError("Process-death evidence does not match the current provisioner.");
    }
    observedAt = timestampMs(evidence.observedAt, "reclaimEvidence.observedAt");
  } else if (evidence.kind === "lease-expired") {
    if (!hasExactKeys(evidence, LEASE_EXPIRED_EVIDENCE_KEYS)) {
      stateError("Lease-expiry evidence is malformed.");
    }
    observedAt = timestampMs(evidence.observedAt, "reclaimEvidence.observedAt");
    if (observedAt < timestampMs(current.leaseExpiresAt, "leaseExpiresAt")) {
      stateError("Lease-expiry evidence predates the current lease expiry.");
    }
  } else {
    stateError("Provisioning reclaim evidence uses an unsupported kind.");
  }
  if (observedAt < timestampMs(current.provisioningAt, "provisioningAt")) {
    stateError("Provisioning reclaim evidence predates the current attempt.");
  }
  return observedAt;
}

export function reclaimProvisioningJournal(binding, journal, reclaim = {}) {
  const trustedBinding = assertExecutionBinding(binding);
  const current = assertProvisioningJournal(trustedBinding, journal);
  if (current.state !== "provisioning") {
    stateError("Only an active provisioning journal may be reclaimed.");
  }
  if (!hasExactKeys(reclaim, RECLAIM_KEYS)) {
    stateError("Provisioning reclaim has an unsupported shape.");
  }
  assertDigest(reclaim.expectedCurrentJournalDigest, "expectedCurrentJournalDigest");
  assertExactNonceId(reclaim.priorAttemptId, "priorAttemptId");
  assertOpaqueId(reclaim.priorHolderId, "priorHolderId");
  if (
    reclaim.expectedCurrentJournalDigest !== current.journalDigest
    || reclaim.priorAttemptId !== current.attemptId
    || reclaim.priorFence !== current.fence
    || reclaim.priorHolderId !== current.provisioner.holderId
  ) {
    stateError("Provisioning reclaim does not match the current fenced attempt.");
  }
  assertProvisioner(reclaim.provisioner);
  assertExactNonceId(reclaim.attemptId, "attemptId");
  const observedAt = assertReclaimEvidence(current, reclaim.reclaimEvidence);
  const priorProvisioningAt = timestampMs(current.provisioningAt, "provisioningAt");
  const nextProvisioningAt = timestampMs(reclaim.provisioningAt, "provisioningAt");
  const nextLeaseExpiresAt = timestampMs(reclaim.leaseExpiresAt, "leaseExpiresAt");
  if (
    reclaim.attemptId === current.attemptId
    || reclaim.fence !== current.fence + 1
    || !Number.isSafeInteger(reclaim.fence)
    || nextProvisioningAt < priorProvisioningAt
    || nextProvisioningAt < observedAt
    || nextLeaseExpiresAt <= nextProvisioningAt
    || nextLeaseExpiresAt - nextProvisioningAt > MAX_PROVISIONING_LEASE_MS
    || reclaim.provisioner.holderId === current.provisioner.holderId
  ) {
    stateError("Provisioning reclaim requires a fresh dead-owner fence and provisioner.");
  }
  const next = {
    ...current,
    attemptId: reclaim.attemptId,
    fence: reclaim.fence,
    provisioner: { ...reclaim.provisioner },
    provisioningAt: reclaim.provisioningAt,
    leaseExpiresAt: reclaim.leaseExpiresAt,
    journalRevision: nextJournalRevision(current),
    previousJournalDigest: current.journalDigest,
    journalDigest: null
  };
  next.journalDigest = sha256(journalWithoutDigest(next));
  assertProvisioningJournal(trustedBinding, next);
  return deepFreeze(next);
}

export function createPublicExecutionProjection(binding, journal) {
  const trustedBinding = assertExecutionBinding(binding);
  const trustedJournal = assertProvisioningJournal(trustedBinding, journal);
  return deepFreeze({
    bindingDigest: trustedBinding.bindingDigest,
    cancellationNonceDigest: trustedBinding.cancellationNonceDigest,
    journalState: trustedJournal.state,
    journalRevision: trustedJournal.journalRevision,
    journalDigest: trustedJournal.journalDigest,
    previousJournalDigest: trustedJournal.previousJournalDigest,
    executionContextManifestDigest: trustedJournal.executionContextManifestDigest
  });
}
