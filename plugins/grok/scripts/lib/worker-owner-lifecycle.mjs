/**
 * Owner-authorized P3-P5 integration and cleanup lifecycle.
 *
 * The provider response is never the qualification authority. Each externally
 * visible effect is preceded by a durable fenced intent and followed by an
 * independent host observation. Public receipts contain only public worker
 * identity, immutable Git/content identities, timestamps, and digests.
 */
import crypto from "node:crypto";
import path from "node:path";

import { CompanionError } from "./errors.mjs";
import { assertBrokerMutationAuthority } from "./worker-authority.mjs";
import { processGroupGone } from "./process-control.mjs";
import { loadProviderGuard } from "./recursion-guard.mjs";
import {
  acquireWorkspaceProcessLease,
  ensurePrivateStateDirectory,
  jobFileIfPresent,
  readJob,
  readPrivateJsonFile,
  withWorkspaceStateTransaction,
  writePrivateJsonFile
} from "./state.mjs";
import { resolveControlWorkspace } from "./workspace.mjs";
import {
  EXACT_WRITE_VERTICAL_SCOPE,
  classifyWorkerWorktreeEffect,
  expectedWorkerWorktreeParent,
  expectedWorkerWorktreeRoot,
  inspectWriteVerticalIntegration,
  prepareIntegration,
  readWriteWorkerArtifact,
  removeEmptyWorkerWorktreeParent,
  verifyWriteVerticalIntegration,
  workerWorktreeSlug
} from "./worker-worktree.mjs";

const OWNER_LIFECYCLE_SCHEMA_VERSION = 1;
const OWNER_LIFECYCLE_REGISTRY_SCHEMA_VERSION = 1;
const MAX_LIFECYCLE_RECORDS = 128;
const MAX_EFFECT_RESULT_BYTES = 64 * 1024;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const EXACT_COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const INTEGRATION_STATES = new Set(["planned", "applying", "verified", "blocked"]);
const CLEANUP_STATES = new Set(["planned", "closing", "removing", "absent", "blocked"]);
const WORKTREE_INTEGRATION_PURPOSE = "worktree-integration";
const WORKTREE_CLEANUP_PURPOSE = "worktree-cleanup";

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalize(value[key])])
  );
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function digest(value) {
  return crypto.createHash("sha256").update(
    Buffer.isBuffer(value) ? value : stableStringify(value)
  ).digest("hex");
}

function now() {
  return new Date().toISOString();
}

function exactKeys(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length
    && actual.every((field, index) => field === expected[index]);
}

function withoutDigest(value, field) {
  const { [field]: _digest, ...body } = value;
  return body;
}

function stateError(message = "Worker owner-lifecycle state is malformed or unsafe.") {
  return new CompanionError("E_STATE", message);
}

function integrationError(message, classification = null) {
  return new CompanionError(
    "E_INTEGRATION",
    message,
    classification ? { classification } : undefined
  );
}

function cleanupError(message, classification = null) {
  return new CompanionError(
    "E_WORKTREE",
    message,
    classification ? { classification } : undefined
  );
}

function notFound() {
  return new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
}

function assertIdempotencyKey(value) {
  if (typeof value !== "string"
    || value.length < 8
    || value.length > 512
    || value !== value.trim()
    || /[\0\r\n]/.test(value)) {
    throw new CompanionError("E_USAGE", "A bounded idempotencyKey is required.");
  }
  return digest(value);
}

function ownerProjection(principal) {
  return Object.freeze({
    hostKind: principal.hostKind,
    threadId: principal.threadId,
    pluginId: principal.pluginId || null
  });
}

/**
 * Resolve the exact owner before validating or looking up idempotency state.
 * Foreign and nonexistent worker identities remain observationally identical.
 */
function readExactlyOwnedJob(root, principal, workerId, env) {
  let job;
  try {
    job = readJob(root, workerId, env);
  } catch {
    throw notFound();
  }
  try {
    assertBrokerMutationAuthority(principal, {
      root,
      exactThreadId: job.host?.sessionId ?? null
    });
  } catch {
    throw notFound();
  }
  if (job.host?.kind !== principal.hostKind
    || job.host?.sessionId !== principal.threadId) {
    throw notFound();
  }
  return job;
}

function registryFile(root, env) {
  return `${ensurePrivateStateDirectory(
    root,
    ["owner-lifecycle"],
    env
  )}/registry.json`;
}

function emptyRegistry() {
  const body = {
    schemaVersion: OWNER_LIFECYCLE_REGISTRY_SCHEMA_VERSION,
    records: {},
    keys: {}
  };
  return Object.freeze({ ...body, registryDigest: digest(body) });
}

function assertPublicIntegrationReceipt(receipt, record) {
  const fields = new Set([
    "schemaVersion",
    "operation",
    "workerId",
    "status",
    "baseCommit",
    "manifestDigest",
    "artifactDigest",
    "patchDigest",
    "contentDigest",
    "parentFingerprintDigest",
    "integratedFingerprintDigest",
    "hostVerificationDigest",
    "officialReceiptDigest",
    "verifiedAt",
    "receiptDigest"
  ]);
  if (!exactKeys(receipt, fields)
    || receipt.schemaVersion !== OWNER_LIFECYCLE_SCHEMA_VERSION
    || receipt.operation !== "integrate"
    || receipt.workerId !== record.workerId
    || receipt.status !== "verified"
    || !EXACT_COMMIT.test(receipt.baseCommit || "")
    || [
      "manifestDigest",
      "artifactDigest",
      "patchDigest",
      "contentDigest",
      "parentFingerprintDigest",
      "integratedFingerprintDigest",
      "hostVerificationDigest",
      "officialReceiptDigest",
      "receiptDigest"
    ].some((field) => !SHA256_HEX.test(receipt[field] || ""))
    || receipt.receiptDigest !== digest(withoutDigest(receipt, "receiptDigest"))) {
    throw stateError("Stored write-integration receipt is malformed.");
  }
  return receipt;
}

function assertPublicCleanupReceipt(receipt, record) {
  const fields = new Set([
    "schemaVersion",
    "operation",
    "workerId",
    "status",
    "integrationReceiptDigest",
    "closeReceiptDigest",
    "sessionDeletionDigest",
    "officialRemoveReceiptDigest",
    "absenceProofDigest",
    "cleanedAt",
    "receiptDigest"
  ]);
  if (!exactKeys(receipt, fields)
    || receipt.schemaVersion !== OWNER_LIFECYCLE_SCHEMA_VERSION
    || receipt.operation !== "cleanup"
    || receipt.workerId !== record.workerId
    || receipt.status !== "absent"
    || [
      "integrationReceiptDigest",
      "closeReceiptDigest",
      "sessionDeletionDigest",
      "officialRemoveReceiptDigest",
      "absenceProofDigest",
      "receiptDigest"
    ].some((field) => !SHA256_HEX.test(receipt[field] || ""))
    || receipt.receiptDigest !== digest(withoutDigest(receipt, "receiptDigest"))) {
    throw stateError("Stored write-cleanup receipt is malformed.");
  }
  return receipt;
}

function assertControllerIntent(intent, {
  purpose,
  effect,
  executionBindingDigest
}) {
  if (intent === null) return null;
  if (!exactKeys(intent, new Set([
    "schemaVersion",
    "purpose",
    "effect",
    "intentId",
    "providerSpawnIntentId",
    "status",
    "controlWorkspaceId",
    "executionBindingDigest",
    "effectBindingDigest",
    "controllerAttemptId",
    "controllerFence",
    "holderId",
    "executableIdentity",
    "processIdentity",
    "preparedAt",
    "activatedAt",
    "settledAt",
    "outcome",
    "receiptsDigest",
    "cleanupProofDigest",
    "intentDigest"
  ]))
    || intent.schemaVersion !== 1
    || intent.purpose !== purpose
    || intent.effect !== effect
    || !/^[0-9a-f]{32}$/.test(intent.intentId || "")
    || intent.providerSpawnIntentId !== intent.intentId
    || !["pending", "active", "settled"].includes(intent.status)
    || intent.executionBindingDigest !== executionBindingDigest
    || !SHA256_HEX.test(intent.effectBindingDigest || "")
    || !/^[0-9a-f]{32}$/.test(intent.controllerAttemptId || "")
    || !Number.isSafeInteger(intent.controllerFence)
    || intent.controllerFence < 1
    || !/^[0-9a-f]{32,64}$/.test(intent.holderId || "")
    || !intent.executableIdentity
    || (intent.processIdentity !== null
      && (!Number.isSafeInteger(intent.processIdentity?.pid)
        || intent.processIdentity.pid < 1))
    || (intent.receiptsDigest !== null
      && !SHA256_HEX.test(intent.receiptsDigest || ""))
    || (intent.cleanupProofDigest !== null
      && !SHA256_HEX.test(intent.cleanupProofDigest || ""))
    || intent.intentDigest !== digest(withoutDigest(intent, "intentDigest"))) {
    throw stateError("Worker owner-controller intent is malformed.");
  }
  if (intent.status === "pending"
    && (intent.processIdentity !== null
      || intent.activatedAt !== null
      || intent.settledAt !== null
      || intent.outcome !== null)) {
    throw stateError("Pending owner-controller intent contains active or terminal evidence.");
  }
  if (intent.status === "active"
    && (!intent.processIdentity
      || !intent.activatedAt
      || intent.settledAt !== null
      || intent.outcome !== null)) {
    throw stateError("Active owner-controller intent lacks exact process evidence.");
  }
  if (intent.status === "settled"
    && (!intent.settledAt
      || typeof intent.outcome !== "string"
      || !intent.receiptsDigest
      || !intent.cleanupProofDigest)) {
    throw stateError("Settled owner-controller intent lacks teardown evidence.");
  }
  return intent;
}

function assertLifecycleRecord(record) {
  const fields = new Set([
    "schemaVersion",
    "workerId",
    "controlWorkspaceId",
    "owner",
    "ownerDigest",
    "executionBindingDigest",
    "artifactBinding",
    "baseBinding",
    "parentFingerprint",
    "providerSessionId",
    "worktreeOperationId",
    "integration",
    "cleanup",
    "recordDigest"
  ]);
  if (!exactKeys(record, fields)
    || record.schemaVersion !== OWNER_LIFECYCLE_SCHEMA_VERSION
    || !/^task-[a-f0-9]{16,64}$/.test(record.workerId || "")
    || typeof record.controlWorkspaceId !== "string"
    || !exactKeys(record.owner, new Set(["hostKind", "threadId", "pluginId"]))
    || record.ownerDigest !== digest(record.owner)
    || !SHA256_HEX.test(record.executionBindingDigest || "")
    || !exactKeys(record.artifactBinding, new Set([
      "artifactDigest",
      "manifestDigest",
      "securityDigest",
      "patchDigest",
      "contentDigest",
      "recordDigest"
    ]))
    || Object.values(record.artifactBinding).some((value) => !SHA256_HEX.test(value || ""))
    || !exactKeys(record.baseBinding, new Set([
      "baseCommit",
      "baseTree",
      "parentFingerprintDigest"
    ]))
    || !EXACT_COMMIT.test(record.baseBinding.baseCommit || "")
    || !EXACT_COMMIT.test(record.baseBinding.baseTree || "")
    || !SHA256_HEX.test(record.baseBinding.parentFingerprintDigest || "")
    || typeof record.providerSessionId !== "string"
    || record.providerSessionId.length < 1
    || record.providerSessionId.length > 256
    || /[\0\r\n]/.test(record.providerSessionId)
    || typeof record.worktreeOperationId !== "string"
    || record.worktreeOperationId.length < 1
    || record.worktreeOperationId.length > 256
    || /[\0\r\n]/.test(record.worktreeOperationId)
    || record.recordDigest !== digest(withoutDigest(record, "recordDigest"))) {
    throw stateError();
  }
  const integration = record.integration;
  if (!exactKeys(integration, new Set([
    "operation",
    "state",
    "idempotencyKeyDigest",
    "requestDigest",
    "fence",
    "leaseTokenDigest",
    "attempts",
    "createdAt",
    "updatedAt",
    "officialReceiptDigest",
    "hostVerification",
    "controllerIntent",
    "receipt",
    "error"
  ]))
    || integration.operation !== "integrate"
    || !INTEGRATION_STATES.has(integration.state)
    || !SHA256_HEX.test(integration.idempotencyKeyDigest || "")
    || !SHA256_HEX.test(integration.requestDigest || "")
    || !Number.isSafeInteger(integration.fence)
    || integration.fence < 1
    || !SHA256_HEX.test(integration.leaseTokenDigest || "")
    || !Number.isSafeInteger(integration.attempts)
    || integration.attempts < 0
    || integration.attempts > 2
    || (integration.officialReceiptDigest !== null
      && !SHA256_HEX.test(integration.officialReceiptDigest || ""))) {
    throw stateError("Stored write-integration lifecycle is malformed.");
  }
  if (integration.state === "verified") {
    if (!integration.hostVerification || !integration.receipt || integration.error !== null) {
      throw stateError("Verified write integration lacks immutable evidence.");
    }
    assertPublicIntegrationReceipt(integration.receipt, record);
  } else if (integration.receipt !== null) {
    throw stateError("Non-verified write integration contains a public receipt.");
  }
  if (integration.state === "blocked" && !integration.error) {
    throw stateError("Blocked write integration lacks durable failure evidence.");
  }
  assertControllerIntent(integration.controllerIntent, {
    purpose: WORKTREE_INTEGRATION_PURPOSE,
    effect: "apply",
    executionBindingDigest: record.executionBindingDigest
  });

  const cleanup = record.cleanup;
  if (cleanup !== null) {
    if (!exactKeys(cleanup, new Set([
      "operation",
      "state",
      "integrationReceiptDigest",
      "idempotencyKeyDigest",
      "requestDigest",
      "fence",
      "leaseTokenDigest",
      "closeAttempts",
      "closeReceiptDigest",
      "sessionDeleteAttempts",
      "sessionDeletionDigest",
      "removeAttempts",
      "removeReceiptDigest",
      "closeControllerIntent",
      "removeControllerIntent",
      "absenceProof",
      "createdAt",
      "updatedAt",
      "receipt",
      "error"
    ]))
      || cleanup.operation !== "cleanup"
      || !CLEANUP_STATES.has(cleanup.state)
      || !SHA256_HEX.test(cleanup.integrationReceiptDigest || "")
      || !SHA256_HEX.test(cleanup.idempotencyKeyDigest || "")
      || !SHA256_HEX.test(cleanup.requestDigest || "")
      || !Number.isSafeInteger(cleanup.fence)
      || cleanup.fence < 1
      || !SHA256_HEX.test(cleanup.leaseTokenDigest || "")
      || !Number.isSafeInteger(cleanup.closeAttempts)
      || cleanup.closeAttempts < 0
      || cleanup.closeAttempts > 2
      || !Number.isSafeInteger(cleanup.sessionDeleteAttempts)
      || cleanup.sessionDeleteAttempts < 0
      || cleanup.sessionDeleteAttempts > 2
      || !Number.isSafeInteger(cleanup.removeAttempts)
      || cleanup.removeAttempts < 0
      || cleanup.removeAttempts > 2
      || [
        cleanup.closeReceiptDigest,
        cleanup.sessionDeletionDigest,
        cleanup.removeReceiptDigest
      ].some((value) => value !== null && !SHA256_HEX.test(value || ""))) {
      throw stateError("Stored write-cleanup lifecycle is malformed.");
    }
    if (cleanup.state === "absent") {
      if (!cleanup.absenceProof || !cleanup.receipt || cleanup.error !== null) {
        throw stateError("Completed write cleanup lacks immutable absence evidence.");
      }
      assertPublicCleanupReceipt(cleanup.receipt, record);
    } else if (cleanup.receipt !== null) {
      throw stateError("Non-terminal write cleanup contains a public receipt.");
    }
    if (cleanup.state === "blocked" && !cleanup.error) {
      throw stateError("Blocked write cleanup lacks durable failure evidence.");
    }
    assertControllerIntent(cleanup.closeControllerIntent, {
      purpose: WORKTREE_CLEANUP_PURPOSE,
      effect: "close",
      executionBindingDigest: record.executionBindingDigest
    });
    assertControllerIntent(cleanup.removeControllerIntent, {
      purpose: WORKTREE_CLEANUP_PURPOSE,
      effect: "remove",
      executionBindingDigest: record.executionBindingDigest
    });
  }
  return record;
}

function assertRegistry(registry) {
  if (!exactKeys(registry, new Set([
    "schemaVersion",
    "records",
    "keys",
    "registryDigest"
  ]))
    || registry.schemaVersion !== OWNER_LIFECYCLE_REGISTRY_SCHEMA_VERSION
    || !registry.records
    || Array.isArray(registry.records)
    || !registry.keys
    || Array.isArray(registry.keys)
    || Object.keys(registry.records).length > MAX_LIFECYCLE_RECORDS
    || Object.keys(registry.keys).length > MAX_LIFECYCLE_RECORDS * 2
    || registry.registryDigest !== digest(withoutDigest(registry, "registryDigest"))) {
    throw stateError("Worker owner-lifecycle registry is malformed.");
  }
  for (const [workerId, record] of Object.entries(registry.records)) {
    assertLifecycleRecord(record);
    if (workerId !== record.workerId) throw stateError();
  }
  for (const [keyDigest, binding] of Object.entries(registry.keys)) {
    if (!SHA256_HEX.test(keyDigest)
      || !exactKeys(binding, new Set(["operation", "workerId", "requestDigest"]))
      || !["integrate", "cleanup"].includes(binding.operation)
      || !SHA256_HEX.test(binding.requestDigest || "")
      || registry.records[binding.workerId]?.[binding.operation === "integrate"
        ? "integration"
        : "cleanup"]?.idempotencyKeyDigest !== keyDigest) {
      throw stateError("Worker owner-lifecycle idempotency registry is malformed.");
    }
  }
  return registry;
}

function readRegistry(root, env) {
  const loaded = readPrivateJsonFile(registryFile(root, env), {
    missing: null,
    maxBytes: 2 * 1024 * 1024,
    label: "worker owner-lifecycle registry"
  });
  return loaded === null ? emptyRegistry() : assertRegistry(loaded);
}

function publishRegistry(root, registry, env) {
  const body = {
    schemaVersion: OWNER_LIFECYCLE_REGISTRY_SCHEMA_VERSION,
    records: registry.records,
    keys: registry.keys
  };
  const published = { ...body, registryDigest: digest(body) };
  assertRegistry(published);
  writePrivateJsonFile(registryFile(root, env), published);
  return published;
}

function withRegistry(root, env, mutate) {
  return withWorkspaceStateTransaction(root, () => {
    const registry = readRegistry(root, env);
    const next = mutate(registry);
    return publishRegistry(root, next, env);
  }, env);
}

function replaceRecord(registry, record, keyBinding = null) {
  const unsigned = withoutDigest(record, "recordDigest");
  const durable = { ...unsigned, recordDigest: digest(unsigned) };
  assertLifecycleRecord(durable);
  return {
    ...registry,
    records: {
      ...registry.records,
      [durable.workerId]: durable
    },
    keys: keyBinding
      ? {
          ...registry.keys,
          [keyBinding.keyDigest]: {
            operation: keyBinding.operation,
            workerId: durable.workerId,
            requestDigest: keyBinding.requestDigest
          }
        }
      : registry.keys
  };
}

function boundedEffectDigest(value, label) {
  let serialized;
  try {
    serialized = stableStringify(value);
  } catch {
    throw stateError(`${label} returned an unserializable receipt.`);
  }
  if (typeof serialized !== "string"
    || Buffer.byteLength(serialized, "utf8") > MAX_EFFECT_RESULT_BYTES) {
    throw stateError(`${label} returned an oversized receipt.`);
  }
  return digest(serialized);
}

function terminalWriteContext({
  root,
  principal,
  workerId,
  manifestDigest,
  env
}) {
  const job = readExactlyOwnedJob(root, principal, workerId, env);
  const binding = job.executionBinding;
  const metadata = job.result?.writeArtifact;
  const dispatch = job.request?.spawn?.dispatch;
  const worktreeOperationId = job.provisioningRuntime?.intent?.operationId;
  const control = resolveControlWorkspace(root, env);
  if (job.schemaVersion !== 3
    || job.kind !== "task"
    || job.jobClass !== "task"
    || job.write !== true
    || job.status !== "completed"
    || job.result?.taskRuntimeCleaned !== true
    || job.result?.hostVerification !== "not_run"
    || !metadata
    || metadata.manifestDigest !== manifestDigest
    || !SHA256_HEX.test(manifestDigest || "")
    || !binding
    || !SHA256_HEX.test(binding.bindingDigest || "")
    || job.request?.spawn?.executionBindingDigest !== binding.bindingDigest
    || binding.workerId !== workerId
    || binding.controlWorkspaceId !== job.controlWorkspaceId
    || binding.controlWorkspaceId !== control.controlWorkspaceId
    || binding.controlRoot !== control.controlRoot
    || binding.baseCommit !== metadata.baseCommit
    || binding.expectedExecutionRoot !== expectedWorkerWorktreeRoot(
      control.controlRoot,
      workerId,
      env
    )
    || job.provisioning?.state !== "ready"
    || ![1, 2].includes(dispatch?.schemaVersion)
    || dispatch.state !== "provider-started"
    || !Number.isSafeInteger(dispatch.providerGeneration)
    || dispatch.providerGeneration < 1
    || job.request?.spawn?.providerLaunchOutcome !== "launched"
    || typeof job.grokSessionId !== "string"
    || job.grokSessionId.length < 1
    || job.grokSessionId.length > 256
    || /[\0\r\n]/.test(job.grokSessionId)
    || typeof worktreeOperationId !== "string"
    || worktreeOperationId.length < 1
    || worktreeOperationId.length > 256
    || /[\0\r\n]/.test(worktreeOperationId)) {
    throw integrationError(
      "Worker is not one terminal, runtime-cleaned, provider-launched write vertical."
    );
  }
  for (const identity of [
    job.controllerProcess,
    job.workerProcess,
    job.providerProcess
  ]) {
    if (!processGroupGone(identity)) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Write-worker runtime process cleanup is not independently proven."
      );
    }
  }
  if (loadProviderGuard(binding.controlRoot, workerId, env) !== null) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Write-worker provider guard remains after terminal runtime cleanup."
    );
  }
  const artifact = readWriteWorkerArtifact({
    controlRoot: binding.controlRoot,
    workerId,
    expectedManifestDigest: manifestDigest,
    env
  });
  const record = artifact.record;
  for (const [left, right] of [
    [metadata.path, record.path],
    [metadata.baseCommit, record.baseCommit],
    [metadata.manifestDigest, record.manifestDigest],
    [metadata.securityDigest, record.securityDigest],
    [metadata.patchDigest, record.patchDigest],
    [metadata.contentDigest, record.contentDigest],
    [metadata.contentBytes, record.contentBytes]
  ]) {
    if (left !== right) {
      throw integrationError(
        "Terminal write-worker result disagrees with its immutable artifact."
      );
    }
  }
  return Object.freeze({
    job,
    binding,
    artifact,
    control,
    worktreeOperationId
  });
}

function integrationRequestDigest(context, principal, keyDigest) {
  return digest({
    operation: "integrate",
    workerId: context.job.id,
    owner: ownerProjection(principal),
    executionBindingDigest: context.binding.bindingDigest,
    artifactDigest: context.artifact.record.artifactDigest,
    manifestDigest: context.artifact.record.manifestDigest,
    baseCommit: context.binding.baseCommit,
    parentFingerprintDigest: context.binding.parentFingerprintDigest,
    idempotencyKeyDigest: keyDigest
  });
}

function cleanupRequestDigest(record, principal, keyDigest, integrationReceiptDigest) {
  return digest({
    operation: "cleanup",
    workerId: record.workerId,
    owner: ownerProjection(principal),
    executionBindingDigest: record.executionBindingDigest,
    integrationReceiptDigest,
    idempotencyKeyDigest: keyDigest
  });
}

function initialLifecycleRecord(context, principal, integration) {
  const binding = context.binding;
  const artifact = context.artifact.record;
  const owner = ownerProjection(principal);
  return {
    schemaVersion: OWNER_LIFECYCLE_SCHEMA_VERSION,
    workerId: context.job.id,
    controlWorkspaceId: context.job.controlWorkspaceId,
    owner,
    ownerDigest: digest(owner),
    executionBindingDigest: binding.bindingDigest,
    artifactBinding: {
      artifactDigest: artifact.artifactDigest,
      manifestDigest: artifact.manifestDigest,
      securityDigest: artifact.securityDigest,
      patchDigest: artifact.patchDigest,
      contentDigest: artifact.contentDigest,
      recordDigest: artifact.recordDigest
    },
    baseBinding: {
      baseCommit: binding.baseCommit,
      baseTree: binding.baseTree,
      parentFingerprintDigest: binding.parentFingerprintDigest
    },
    parentFingerprint: binding.parentFingerprint,
    providerSessionId: context.job.grokSessionId,
    worktreeOperationId: context.worktreeOperationId,
    integration,
    cleanup: null,
    recordDigest: null
  };
}

function assertRecordContext(record, context, principal) {
  const owner = ownerProjection(principal);
  if (record.workerId !== context.job.id
    || record.controlWorkspaceId !== context.job.controlWorkspaceId
    || record.ownerDigest !== digest(owner)
    || stableStringify(record.owner) !== stableStringify(owner)
    || record.executionBindingDigest !== context.binding.bindingDigest
    || record.artifactBinding.artifactDigest !== context.artifact.record.artifactDigest
    || record.artifactBinding.manifestDigest !== context.artifact.record.manifestDigest
    || record.artifactBinding.recordDigest !== context.artifact.record.recordDigest
    || record.baseBinding.baseCommit !== context.binding.baseCommit
    || record.baseBinding.parentFingerprintDigest
      !== context.binding.parentFingerprintDigest
    || record.providerSessionId !== context.job.grokSessionId
    || record.worktreeOperationId !== context.worktreeOperationId) {
    throw stateError("Worker owner-lifecycle identity changed after durable planning.");
  }
  return record;
}

function blockIntegration(root, workerId, env, classification, message) {
  withRegistry(root, env, (registry) => {
    const record = registry.records[workerId];
    if (!record) throw stateError();
    const updatedAt = now();
    return replaceRecord(registry, {
      ...record,
      integration: {
        ...record.integration,
        state: "blocked",
        updatedAt,
        error: {
          code: "E_INTEGRATION",
          classification,
          message
        }
      }
    });
  });
}

function blockCleanup(root, workerId, env, classification, message) {
  withRegistry(root, env, (registry) => {
    const record = registry.records[workerId];
    if (!record?.cleanup) throw stateError();
    return replaceRecord(registry, {
      ...record,
      cleanup: {
        ...record.cleanup,
        state: "blocked",
        updatedAt: now(),
        error: {
          code: "E_WORKTREE",
          classification,
          message
        }
      }
    });
  });
}

function readCurrentRecord(root, workerId, env) {
  const record = readRegistry(root, env).records[workerId];
  return record ? assertLifecycleRecord(record) : null;
}

function controllerStateLocation(record, operation, effect) {
  if (operation === "integration" && effect === "apply") {
    return {
      current: record.integration.controllerIntent,
      update(intent) {
        return {
          ...record,
          integration: {
            ...record.integration,
            controllerIntent: intent,
            updatedAt: now()
          }
        };
      }
    };
  }
  if (operation === "cleanup" && ["close", "remove"].includes(effect)) {
    const field = effect === "close"
      ? "closeControllerIntent"
      : "removeControllerIntent";
    return {
      current: record.cleanup?.[field] ?? null,
      update(intent) {
        if (!record.cleanup) throw stateError();
        return {
          ...record,
          cleanup: {
            ...record.cleanup,
            [field]: intent,
            updatedAt: now()
          }
        };
      }
    };
  }
  throw stateError("Unknown owner-controller lifecycle location.");
}

function updateControllerState(
  root,
  workerId,
  env,
  operation,
  effect,
  mutate
) {
  let output;
  withRegistry(root, env, (registry) => {
    const record = registry.records[workerId];
    if (!record) throw stateError();
    const location = controllerStateLocation(record, operation, effect);
    const nextIntent = mutate(location.current, record);
    const next = location.update(nextIntent);
    output = nextIntent;
    return replaceRecord(registry, next);
  });
  return output;
}

function sameControllerBinding(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function controllerIntentBody({
  binding,
  effect,
  intentId,
  executableIdentity,
  status,
  processIdentity = null,
  preparedAt,
  activatedAt = null,
  settledAt = null,
  outcome = null,
  receiptsDigest = null,
  cleanupProofDigest = null
}) {
  return {
    schemaVersion: 1,
    purpose: binding.purpose,
    effect,
    intentId,
    providerSpawnIntentId: intentId,
    status,
    controlWorkspaceId: binding.controlWorkspaceId,
    executionBindingDigest: binding.executionBindingDigest,
    effectBindingDigest: binding.effectBindingDigest,
    controllerAttemptId: binding.controllerAttemptId,
    controllerFence: binding.controllerFence,
    holderId: binding.holderId,
    executableIdentity,
    processIdentity,
    preparedAt,
    activatedAt,
    settledAt,
    outcome,
    receiptsDigest,
    cleanupProofDigest
  };
}

function controllerCallbacks({
  root,
  workerId,
  env,
  operation,
  effect,
  binding
}) {
  return Object.freeze({
    async prepare(candidate) {
      if (candidate?.purpose !== binding.purpose
        || candidate.effect !== effect
        || !sameControllerBinding(candidate.binding, binding)
        || !candidate.executableIdentity) {
        throw stateError("Owner-controller prepare request changed its durable effect binding.");
      }
      const intentId = crypto.randomBytes(16).toString("hex");
      const preparedAt = now();
      const intent = updateControllerState(
        root,
        workerId,
        env,
        operation,
        effect,
        (current) => {
          if (current && current.status !== "settled") {
            throw stateError("An unsettled owner-controller intent already owns this effect.");
          }
          const body = controllerIntentBody({
            binding,
            effect,
            intentId,
            executableIdentity: candidate.executableIdentity,
            status: "pending",
            preparedAt
          });
          return {
            ...body,
            intentDigest: digest(body)
          };
        }
      );
      return Object.freeze({
        prepared: true,
        replayed: false,
        intent
      });
    },

    async activate(candidate) {
      if (candidate?.purpose !== binding.purpose
        || candidate.effect !== effect
        || !sameControllerBinding(
          withoutDigest(candidate.binding, "providerSpawnIntentId"),
          binding
        )
        || !candidate.processIdentity) {
        throw stateError("Owner-controller activation changed its durable effect binding.");
      }
      const activatedAt = now();
      const intent = updateControllerState(
        root,
        workerId,
        env,
        operation,
        effect,
        (current) => {
          if (!current
            || current.status !== "pending"
            || current.intentId !== candidate.providerSpawnIntentId
            || stableStringify(current.executableIdentity)
              !== stableStringify(candidate.executableIdentity)) {
            throw stateError("Owner-controller activation no longer owns its prepared intent.");
          }
          const body = controllerIntentBody({
            binding,
            effect,
            intentId: current.intentId,
            executableIdentity: current.executableIdentity,
            status: "active",
            processIdentity: Object.freeze({ ...candidate.processIdentity }),
            preparedAt: current.preparedAt,
            activatedAt
          });
          return {
            ...body,
            intentDigest: digest(body)
          };
        }
      );
      return Object.freeze({
        activated: true,
        replayed: false,
        intent
      });
    },

    async settle(candidate) {
      if (candidate?.purpose !== binding.purpose
        || candidate.effect !== effect
        || !sameControllerBinding(
          withoutDigest(candidate.binding, "providerSpawnIntentId"),
          binding
        )
        || !["completed", "effect-failed", "cancelled", "startup-failed"]
          .includes(candidate.outcome)
        || !Array.isArray(candidate.receipts)
        || !candidate.cleanupProof) {
        throw stateError("Owner-controller settlement changed its durable effect boundary.");
      }
      const settledAt = now();
      const receiptsDigest = boundedEffectDigest(
        candidate.receipts,
        "Owner-controller receipts"
      );
      const cleanupProofDigest = boundedEffectDigest(
        candidate.cleanupProof,
        "Owner-controller cleanup proof"
      );
      const intent = updateControllerState(
        root,
        workerId,
        env,
        operation,
        effect,
        (current) => {
          const settlementProcessIdentity = current?.status === "active"
            ? current.processIdentity
            : candidate.processIdentity;
          if (!current
            || !["pending", "active"].includes(current.status)
            || current.intentId !== candidate.intentId
            || current.intentId !== candidate.providerSpawnIntentId
            || stableStringify(current.executableIdentity)
              !== stableStringify(candidate.executableIdentity)
            || (current.status === "active"
              && stableStringify(current.processIdentity)
                !== stableStringify(candidate.processIdentity))) {
            throw stateError("Owner-controller settlement lost its exact prepared process identity.");
          }
          const body = controllerIntentBody({
            binding,
            effect,
            intentId: current.intentId,
            executableIdentity: current.executableIdentity,
            status: "settled",
            processIdentity: settlementProcessIdentity,
            preparedAt: current.preparedAt,
            activatedAt: current.activatedAt,
            settledAt,
            outcome: candidate.outcome,
            receiptsDigest,
            cleanupProofDigest
          });
          return {
            ...body,
            intentDigest: digest(body)
          };
        }
      );
      return Object.freeze({
        settled: true,
        replayed: false,
        intentId: intent.intentId
      });
    }
  });
}

function ownerControllerInput({
  root,
  workerId,
  env,
  record,
  job,
  operation,
  effect
}) {
  const jobPath = jobFileIfPresent(root, workerId, env);
  if (!jobPath) {
    throw stateError("Owner-controller cannot resolve the exact private job state.");
  }
  const controllerAttemptId = crypto.randomBytes(16).toString("hex");
  const lifecycle = operation === "integration"
    ? record.integration
    : record.cleanup;
  if (!lifecycle) throw stateError();
  if (operation === "cleanup"
    && (job.request?.providerHomeId !== workerId
      || !/^[a-zA-Z0-9._-]{1,80}$/.test(job.request.providerHomeId))) {
    throw stateError("Cleanup controller provider-session home binding is invalid.");
  }
  const effectBindingDigest = digest({
    operation,
    effect,
    workerId,
    executionBindingDigest: record.executionBindingDigest,
    artifactBinding: record.artifactBinding,
    baseBinding: record.baseBinding,
    integrationReceiptDigest:
      operation === "cleanup" ? lifecycle.integrationReceiptDigest : null,
    providerSessionDigest: digest(record.providerSessionId),
    ...(operation === "cleanup"
      ? { providerHomeDigest: digest(job.request?.providerHomeId) }
      : {}),
    worktreeOperationDigest: digest(record.worktreeOperationId),
    controllerAttemptId,
    controllerFence: lifecycle.fence
  });
  const common = {
    purpose: operation === "integration"
      ? WORKTREE_INTEGRATION_PURPOSE
      : WORKTREE_CLEANUP_PURPOSE,
    controlWorkspaceId: record.controlWorkspaceId,
    controlRoot: job.executionBinding.controlRoot,
    executionRoot: job.executionBinding.expectedExecutionRoot,
    executionBindingDigest: record.executionBindingDigest,
    effectBindingDigest,
    controllerAttemptId,
    controllerFence: lifecycle.fence,
    holderId: lifecycle.leaseTokenDigest
  };
  const binding = Object.freeze(operation === "integration"
    ? {
        ...common,
        targetPath: path.join(job.executionBinding.controlRoot, "target.txt"),
        operationId: record.worktreeOperationId
      }
    : {
        ...common,
        managedWorktreeParent: expectedWorkerWorktreeParent(
          root,
          workerId,
          env
        ),
        sessionId: record.providerSessionId,
        providerHomeId: job.request?.providerHomeId
      });
  const homeMarker = `owner-${effect}-${
    digest(`${workerId}:${controllerAttemptId}`).slice(0, 40)
  }`;
  return Object.freeze({
    stateDir: path.dirname(path.dirname(jobPath)),
    controlRoot: binding.controlRoot,
    executionRoot: binding.executionRoot,
    homeMarker,
    profile: job.profile || null,
    binding,
    gitCommonDir: job.executionBinding.gitCommonDir,
    baseCommit: record.baseBinding.baseCommit,
    callbacks: controllerCallbacks({
      root,
      workerId,
      env,
      operation,
      effect,
      binding
    })
  });
}

function integrationReplay(record, keyDigest, requestDigest) {
  const integration = record?.integration;
  if (!integration) return null;
  if (integration.idempotencyKeyDigest !== keyDigest
    || integration.requestDigest !== requestDigest) {
    throw new CompanionError(
      "E_IDEMPOTENCY_CONFLICT",
      "idempotencyKey was reused with a different write-integration request."
    );
  }
  if (integration.state === "verified") {
    return Object.freeze({ receipt: integration.receipt, replayed: true });
  }
  if (integration.state === "blocked") {
    throw integrationError(
      "Write integration is durably blocked by a non-adoptable host observation.",
      integration.error?.classification || "blocked"
    );
  }
  return null;
}

function cleanupReplay(record, keyDigest, requestDigest) {
  const cleanup = record?.cleanup;
  if (!cleanup) return null;
  if (cleanup.idempotencyKeyDigest !== keyDigest
    || cleanup.requestDigest !== requestDigest) {
    throw new CompanionError(
      "E_IDEMPOTENCY_CONFLICT",
      "idempotencyKey was reused with a different write-cleanup request."
    );
  }
  if (cleanup.state === "absent") {
    return Object.freeze({ receipt: cleanup.receipt, replayed: true });
  }
  if (cleanup.state === "blocked") {
    throw cleanupError(
      "Write cleanup is durably blocked by ambiguous or foreign state.",
      cleanup.error?.classification || "blocked"
    );
  }
  return null;
}

function assertGlobalKey(registry, keyDigest, operation, workerId, requestDigest) {
  const existing = registry.keys[keyDigest];
  if (!existing) return;
  if (existing.operation !== operation
    || existing.workerId !== workerId
    || existing.requestDigest !== requestDigest) {
    throw new CompanionError(
      "E_IDEMPOTENCY_CONFLICT",
      "idempotencyKey was reused with a different owner-lifecycle request."
    );
  }
}

function advanceIntegrationAttempt(root, workerId, env, leaseTokenDigest) {
  let next;
  withRegistry(root, env, (registry) => {
    const record = registry.records[workerId];
    const integration = record?.integration;
    if (!integration || !["planned", "applying"].includes(integration.state)) {
      throw stateError("Write integration can no longer start an official apply attempt.");
    }
    if (integration.attempts >= 2) {
      throw integrationError(
        "Write integration exhausted its bounded official apply attempts.",
        "unchanged"
      );
    }
    next = {
      ...record,
      integration: {
        ...integration,
        state: "applying",
        fence: integration.fence + 1,
        leaseTokenDigest,
        attempts: integration.attempts + 1,
        updatedAt: now(),
        error: null
      }
    };
    return replaceRecord(registry, next);
  });
  return next;
}

function publishVerifiedIntegration({
  root,
  workerId,
  env,
  officialReceiptDigest,
  hostVerification
}) {
  let receipt;
  withRegistry(root, env, (registry) => {
    const record = registry.records[workerId];
    if (!record || !["planned", "applying"].includes(record.integration.state)) {
      throw stateError("Write integration state changed before host verification publication.");
    }
    const verifiedAt = now();
    const unsignedReceipt = {
      schemaVersion: OWNER_LIFECYCLE_SCHEMA_VERSION,
      operation: "integrate",
      workerId,
      status: "verified",
      baseCommit: record.baseBinding.baseCommit,
      manifestDigest: record.artifactBinding.manifestDigest,
      artifactDigest: record.artifactBinding.artifactDigest,
      patchDigest: record.artifactBinding.patchDigest,
      contentDigest: record.artifactBinding.contentDigest,
      parentFingerprintDigest: record.baseBinding.parentFingerprintDigest,
      integratedFingerprintDigest: hostVerification.integratedFingerprintDigest,
      hostVerificationDigest: hostVerification.evidenceDigest,
      officialReceiptDigest,
      verifiedAt
    };
    receipt = Object.freeze({
      ...unsignedReceipt,
      receiptDigest: digest(unsignedReceipt)
    });
    const next = {
      ...record,
      integration: {
        ...record.integration,
        state: "verified",
        officialReceiptDigest,
        hostVerification,
        receipt,
        error: null,
        updatedAt: verifiedAt
      }
    };
    return replaceRecord(registry, next);
  });
  return receipt;
}

/**
 * Apply and independently verify one completed target.txt write artifact.
 */
export async function integrateWriteWorker({
  root,
  principal,
  workerId,
  manifestDigest,
  idempotencyKey,
  env = process.env,
  runIntegrationEffect
} = {}) {
  // Owner resolution intentionally precedes idempotency validation/lookup.
  readExactlyOwnedJob(root, principal, workerId, env);
  const keyDigest = assertIdempotencyKey(idempotencyKey);
  if (typeof runIntegrationEffect !== "function") {
    throw new CompanionError("E_CAPABILITY", "Official write-integration effect is unavailable.");
  }
  const lease = acquireWorkspaceProcessLease(
    root,
    `owner-integrate-${workerWorktreeSlug(workerId)}`,
    env
  );
  const leaseTokenDigest = digest(lease.token);
  try {
    let context = terminalWriteContext({
      root,
      principal,
      workerId,
      manifestDigest,
      env
    });
    const requestDigest = integrationRequestDigest(context, principal, keyDigest);
    let record = readCurrentRecord(root, workerId, env);
    if (record) {
      assertRecordContext(record, context, principal);
      const replay = integrationReplay(record, keyDigest, requestDigest);
      if (replay) return replay;
    } else {
      const observed = inspectWriteVerticalIntegration({
        controlRoot: context.binding.controlRoot,
        artifact: context.artifact,
        parentFingerprint: context.binding.parentFingerprint,
        expectedWorkerId: workerId
      });
      if (observed.classification !== "unchanged") {
        throw integrationError(
          "A new write integration requires its exact unchanged parent.",
          observed.classification
        );
      }
      prepareIntegration({
        controlRoot: context.binding.controlRoot,
        executionRoot: context.binding.expectedExecutionRoot,
        manifest: context.artifact.manifest,
        parentFingerprint: context.binding.parentFingerprint,
        expectedWorkerId: workerId,
        expectedScope: EXACT_WRITE_VERTICAL_SCOPE,
        expectedLineage: null,
        env
      });
      const createdAt = now();
      const integration = {
        operation: "integrate",
        state: "planned",
        idempotencyKeyDigest: keyDigest,
        requestDigest,
        fence: 1,
        leaseTokenDigest,
        attempts: 0,
        createdAt,
        updatedAt: createdAt,
        officialReceiptDigest: null,
        hostVerification: null,
        controllerIntent: null,
        receipt: null,
        error: null
      };
      withRegistry(root, env, (registry) => {
        assertGlobalKey(registry, keyDigest, "integrate", workerId, requestDigest);
        if (registry.records[workerId]) {
          throw stateError("Worker integration lifecycle was concurrently created.");
        }
        if (Object.keys(registry.records).length >= MAX_LIFECYCLE_RECORDS) {
          throw stateError("Worker owner-lifecycle registry reached its bounded capacity.");
        }
        return replaceRecord(
          registry,
          initialLifecycleRecord(context, principal, integration),
          {
            keyDigest,
            operation: "integrate",
            requestDigest
          }
        );
      });
      record = readCurrentRecord(root, workerId, env);
    }

    const alreadyApplied = inspectWriteVerticalIntegration({
      controlRoot: context.binding.controlRoot,
      artifact: context.artifact,
      parentFingerprint: record.parentFingerprint,
      expectedWorkerId: workerId
    });
    if (alreadyApplied.classification === "exact-effect") {
      const receipt = publishVerifiedIntegration({
        root,
        workerId,
        env,
        officialReceiptDigest: record.integration.officialReceiptDigest
          || digest({
            adopted: true,
            workerId,
            requestDigest
          }),
        hostVerification: alreadyApplied.evidence
      });
      return Object.freeze({ receipt, replayed: false });
    }
    if (alreadyApplied.classification !== "unchanged") {
      blockIntegration(
        root,
        workerId,
        env,
        alreadyApplied.classification,
        "Parent checkout contains a non-adoptable integration effect."
      );
      throw integrationError(
        "Parent checkout contains a non-adoptable integration effect.",
        alreadyApplied.classification
      );
    }

    let officialReceiptDigest = null;
    for (;;) {
      record = advanceIntegrationAttempt(
        root,
        workerId,
        env,
        leaseTokenDigest
      );
      try {
        const effect = await runIntegrationEffect(ownerControllerInput({
          root,
          workerId,
          env,
          record,
          job: context.job,
          operation: "integration",
          effect: "apply"
        }));
        officialReceiptDigest = boundedEffectDigest(
          effect,
          "Official write integration"
        );
      } catch {
        const observed = inspectWriteVerticalIntegration({
          controlRoot: context.binding.controlRoot,
          artifact: context.artifact,
          parentFingerprint: record.parentFingerprint,
          expectedWorkerId: workerId
        });
        if (observed.classification === "exact-effect") {
          officialReceiptDigest = digest({
            responseLost: true,
            workerId,
            requestDigest,
            attempt: record.integration.attempts
          });
          const receipt = publishVerifiedIntegration({
            root,
            workerId,
            env,
            officialReceiptDigest,
            hostVerification: observed.evidence
          });
          return Object.freeze({ receipt, replayed: false });
        }
        if (observed.classification === "unchanged"
          && record.integration.attempts < 2) {
          prepareIntegration({
            controlRoot: context.binding.controlRoot,
            executionRoot: context.binding.expectedExecutionRoot,
            manifest: context.artifact.manifest,
            parentFingerprint: context.binding.parentFingerprint,
            expectedWorkerId: workerId,
            expectedScope: EXACT_WRITE_VERTICAL_SCOPE,
            expectedLineage: null,
            env
          });
          continue;
        }
        blockIntegration(
          root,
          workerId,
          env,
          observed.classification,
          "Official apply response was lost without an adoptable exact effect."
        );
        throw integrationError(
          "Official apply response was lost without an adoptable exact effect.",
          observed.classification
        );
      }

      const hostVerification = inspectWriteVerticalIntegration({
        controlRoot: context.binding.controlRoot,
        artifact: context.artifact,
        parentFingerprint: record.parentFingerprint,
        expectedWorkerId: workerId
      });
      if (hostVerification.classification !== "exact-effect") {
        blockIntegration(
          root,
          workerId,
          env,
          hostVerification.classification,
          "Official apply returned without producing the exact bounded host effect."
        );
        throw integrationError(
          "Official apply returned without producing the exact bounded host effect.",
          hostVerification.classification
        );
      }
      const verified = verifyWriteVerticalIntegration({
        controlRoot: context.binding.controlRoot,
        artifact: context.artifact,
        parentFingerprint: record.parentFingerprint,
        expectedWorkerId: workerId
      });
      const receipt = publishVerifiedIntegration({
        root,
        workerId,
        env,
        officialReceiptDigest,
        hostVerification: verified
      });
      return Object.freeze({ receipt, replayed: false });
    }
  } finally {
    lease.release();
  }
}

function sessionObservationPresent(value) {
  if (!exactKeys(value, new Set(["present"]))
    || typeof value.present !== "boolean") {
    throw stateError("Provider-session inspection returned malformed evidence.");
  }
  return value.present;
}

async function observeSessionAbsentTwice(inspectProviderSession, providerSessionId) {
  const first = await inspectProviderSession(Object.freeze({ providerSessionId }));
  const second = await inspectProviderSession(Object.freeze({ providerSessionId }));
  if (sessionObservationPresent(first) || sessionObservationPresent(second)) {
    return null;
  }
  return Object.freeze({
    schemaVersion: 1,
    firstObservationDigest: boundedEffectDigest(first, "Provider-session inspection"),
    secondObservationDigest: boundedEffectDigest(second, "Provider-session inspection"),
    absent: true
  });
}

function advanceCleanup(root, workerId, env, updater) {
  let next;
  withRegistry(root, env, (registry) => {
    const record = registry.records[workerId];
    if (!record?.cleanup) throw stateError();
    next = {
      ...record,
      cleanup: updater(record.cleanup)
    };
    return replaceRecord(registry, next);
  });
  return next;
}

function publishAbsentCleanup(root, workerId, env, absenceProof) {
  let receipt;
  withRegistry(root, env, (registry) => {
    const record = registry.records[workerId];
    const cleanup = record?.cleanup;
    if (!cleanup
      || cleanup.state !== "removing"
      || !cleanup.closeReceiptDigest
      || !cleanup.sessionDeletionDigest
      || !cleanup.removeReceiptDigest
      || absenceProof?.classification !== "absent"
      || absenceProof.workerParentState !== "absent"
      || !SHA256_HEX.test(absenceProof.proofDigest || "")) {
      throw stateError("Write cleanup lacks exact close, session, remove, or absence evidence.");
    }
    const cleanedAt = now();
    const unsignedReceipt = {
      schemaVersion: OWNER_LIFECYCLE_SCHEMA_VERSION,
      operation: "cleanup",
      workerId,
      status: "absent",
      integrationReceiptDigest: cleanup.integrationReceiptDigest,
      closeReceiptDigest: cleanup.closeReceiptDigest,
      sessionDeletionDigest: cleanup.sessionDeletionDigest,
      officialRemoveReceiptDigest: cleanup.removeReceiptDigest,
      absenceProofDigest: absenceProof.proofDigest,
      cleanedAt
    };
    receipt = Object.freeze({
      ...unsignedReceipt,
      receiptDigest: digest(unsignedReceipt)
    });
    return replaceRecord(registry, {
      ...record,
      cleanup: {
        ...cleanup,
        state: "absent",
        absenceProof,
        receipt,
        error: null,
        updatedAt: cleanedAt
      }
    });
  });
  return receipt;
}

/**
 * Close the exact provider session, delete only that session's credential
 * record, invoke official worktree removal, and independently prove absence.
 */
export async function cleanupWriteWorker({
  root,
  principal,
  workerId,
  integrationReceiptDigest,
  idempotencyKey,
  env = process.env,
  runCloseEffect,
  deleteProviderSession,
  inspectProviderSession,
  runRemoveEffect
} = {}) {
  // Owner resolution intentionally precedes idempotency validation/lookup.
  const owned = readExactlyOwnedJob(root, principal, workerId, env);
  const keyDigest = assertIdempotencyKey(idempotencyKey);
  for (const [callback, label] of [
    [runCloseEffect, "official session close"],
    [deleteProviderSession, "provider-session delete"],
    [inspectProviderSession, "provider-session inspection"],
    [runRemoveEffect, "official worktree remove"]
  ]) {
    if (typeof callback !== "function") {
      throw new CompanionError("E_CAPABILITY", `${label} capability is unavailable.`);
    }
  }
  const lease = acquireWorkspaceProcessLease(
    root,
    `owner-cleanup-${workerWorktreeSlug(workerId)}`,
    env
  );
  const leaseTokenDigest = digest(lease.token);
  try {
    let record = readCurrentRecord(root, workerId, env);
    if (!record
      || record.integration.state !== "verified"
      || record.integration.receipt?.receiptDigest !== integrationReceiptDigest
      || !SHA256_HEX.test(integrationReceiptDigest || "")) {
      throw integrationError(
        "Write cleanup requires the exact durable integration receipt."
      );
    }
    if (owned.result?.taskRuntimeCleaned !== true
      || owned.grokSessionId !== record.providerSessionId) {
      throw cleanupError("Write cleanup lost its terminal runtime/session binding.");
    }
    const requestDigest = cleanupRequestDigest(
      record,
      principal,
      keyDigest,
      integrationReceiptDigest
    );
    const replay = cleanupReplay(record, keyDigest, requestDigest);
    if (replay) return replay;

    if (record.cleanup === null) {
      const createdAt = now();
      withRegistry(root, env, (registry) => {
        assertGlobalKey(registry, keyDigest, "cleanup", workerId, requestDigest);
        const current = registry.records[workerId];
        if (!current || current.cleanup !== null) {
          throw stateError("Worker cleanup lifecycle was concurrently created.");
        }
        const next = {
          ...current,
          cleanup: {
            operation: "cleanup",
            state: "planned",
            integrationReceiptDigest,
            idempotencyKeyDigest: keyDigest,
            requestDigest,
            fence: 1,
            leaseTokenDigest,
            closeAttempts: 0,
            closeReceiptDigest: null,
            sessionDeleteAttempts: 0,
            sessionDeletionDigest: null,
            removeAttempts: 0,
            removeReceiptDigest: null,
            closeControllerIntent: null,
            removeControllerIntent: null,
            absenceProof: null,
            createdAt,
            updatedAt: createdAt,
            receipt: null,
            error: null
          }
        };
        return replaceRecord(registry, next, {
          keyDigest,
          operation: "cleanup",
          requestDigest
        });
      });
      record = readCurrentRecord(root, workerId, env);
    } else {
      if (record.cleanup.idempotencyKeyDigest !== keyDigest
        || record.cleanup.requestDigest !== requestDigest) {
        throw new CompanionError(
          "E_IDEMPOTENCY_CONFLICT",
          "idempotencyKey was reused with a different write-cleanup request."
        );
      }
    }

    // Phase 1: exact official session close. A response-loss retry is bounded
    // to one reissue of the same derived provider session.
    while (!record.cleanup.closeReceiptDigest) {
      if (record.cleanup.closeAttempts >= 2) {
        blockCleanup(root, workerId, env, "session-close-unknown", "Official session close exhausted bounded retries.");
        throw cleanupError(
          "Official session close exhausted bounded retries.",
          "session-close-unknown"
        );
      }
      record = advanceCleanup(root, workerId, env, (cleanup) => ({
        ...cleanup,
        state: "closing",
        fence: cleanup.fence + 1,
        leaseTokenDigest,
        closeAttempts: cleanup.closeAttempts + 1,
        updatedAt: now(),
        error: null
      }));
      try {
        const close = await runCloseEffect(ownerControllerInput({
          root,
          workerId,
          env,
          record,
          job: owned,
          operation: "cleanup",
          effect: "close"
        }));
        const closeReceiptDigest = boundedEffectDigest(close, "Official session close");
        record = advanceCleanup(root, workerId, env, (cleanup) => ({
          ...cleanup,
          closeReceiptDigest,
          updatedAt: now()
        }));
      } catch (error) {
        if (record.cleanup.closeAttempts < 2) continue;
        const loadFailed =
          error?.details?.ownerControllerStage === "load";
        const classification = loadFailed
          ? "session-load-failed"
          : "session-close-response-lost";
        const message = loadFailed
          ? "Official session load failed from the bound provider home."
          : "Official session close response was lost without durable adoption evidence.";
        blockCleanup(
          root,
          workerId,
          env,
          classification,
          message
        );
        throw cleanupError(
          message,
          classification
        );
      }
    }

    // Phase 2: credential-only exact session deletion. Response loss is
    // adoptable only after two consecutive absence observations.
    while (!record.cleanup.sessionDeletionDigest) {
      let absence = await observeSessionAbsentTwice(
        inspectProviderSession,
        record.providerSessionId
      );
      if (absence) {
        const sessionDeletionDigest = digest({
          ...absence,
          adopted: record.cleanup.sessionDeleteAttempts > 0
        });
        record = advanceCleanup(root, workerId, env, (cleanup) => ({
          ...cleanup,
          sessionDeletionDigest,
          updatedAt: now()
        }));
        break;
      }
      if (record.cleanup.sessionDeleteAttempts >= 2) {
        blockCleanup(root, workerId, env, "session-present", "Provider session remained after bounded exact deletion.");
        throw cleanupError(
          "Provider session remained after bounded exact deletion.",
          "session-present"
        );
      }
      record = advanceCleanup(root, workerId, env, (cleanup) => ({
        ...cleanup,
        sessionDeleteAttempts: cleanup.sessionDeleteAttempts + 1,
        fence: cleanup.fence + 1,
        leaseTokenDigest,
        updatedAt: now()
      }));
      let deletionResult = null;
      try {
        deletionResult = await deleteProviderSession(Object.freeze({
          providerSessionId: record.providerSessionId
        }));
        if (!exactKeys(deletionResult, new Set(["deleted"]))
          || typeof deletionResult.deleted !== "boolean") {
          throw stateError("Provider-session delete returned malformed evidence.");
        }
      } catch {
        absence = await observeSessionAbsentTwice(
          inspectProviderSession,
          record.providerSessionId
        );
        if (!absence && record.cleanup.sessionDeleteAttempts < 2) continue;
        if (!absence) {
          blockCleanup(
            root,
            workerId,
            env,
            "session-delete-response-lost",
            "Provider-session deletion response was lost and the exact session remains."
          );
          throw cleanupError(
            "Provider-session deletion response was lost and the exact session remains.",
            "session-delete-response-lost"
          );
        }
      }
      absence ||= await observeSessionAbsentTwice(
        inspectProviderSession,
        record.providerSessionId
      );
      if (!absence) {
        if (record.cleanup.sessionDeleteAttempts < 2) continue;
        blockCleanup(root, workerId, env, "session-present", "Provider session remained after exact deletion.");
        throw cleanupError(
          "Provider session remained after exact deletion.",
          "session-present"
        );
      }
      const sessionDeletionDigest = digest({
        deletionReceiptDigest: deletionResult
          ? boundedEffectDigest(deletionResult, "Provider-session delete")
          : null,
        ...absence
      });
      record = advanceCleanup(root, workerId, env, (cleanup) => ({
        ...cleanup,
        sessionDeletionDigest,
        updatedAt: now()
      }));
    }

    // Phase 3: official worktree removal. Only independent exact absence can
    // adopt a response-loss window.
    while (!record.cleanup.removeReceiptDigest) {
      let observed = classifyWorkerWorktreeEffect({
        controlRoot: root,
        executionRoot: expectedWorkerWorktreeRoot(root, workerId, env),
        baseCommit: record.baseBinding.baseCommit,
        workerId,
        env
      });
      if (observed.classification === "absent") {
        const removeReceiptDigest = digest({
          adopted: true,
          proofDigest: observed.evidence.proofDigest,
          requestDigest
        });
        record = advanceCleanup(root, workerId, env, (cleanup) => ({
          ...cleanup,
          state: "removing",
          removeReceiptDigest,
          updatedAt: now()
        }));
        break;
      }
      if (!["dirty", "exact-clean-registered"].includes(observed.classification)) {
        blockCleanup(root, workerId, env, observed.classification, "Managed worker worktree is foreign or ambiguous before official removal.");
        throw cleanupError(
          "Managed worker worktree is foreign or ambiguous before official removal.",
          observed.classification
        );
      }
      if (record.cleanup.removeAttempts >= 2) {
        blockCleanup(root, workerId, env, observed.classification, "Official worktree removal exhausted bounded retries.");
        throw cleanupError(
          "Official worktree removal exhausted bounded retries.",
          observed.classification
        );
      }
      record = advanceCleanup(root, workerId, env, (cleanup) => ({
        ...cleanup,
        state: "removing",
        fence: cleanup.fence + 1,
        leaseTokenDigest,
        removeAttempts: cleanup.removeAttempts + 1,
        updatedAt: now(),
        error: null
      }));
      let removeResult = null;
      try {
        removeResult = await runRemoveEffect(ownerControllerInput({
          root,
          workerId,
          env,
          record,
          job: owned,
          operation: "cleanup",
          effect: "remove"
        }));
      } catch {
        observed = classifyWorkerWorktreeEffect({
          controlRoot: root,
          executionRoot: expectedWorkerWorktreeRoot(root, workerId, env),
          baseCommit: record.baseBinding.baseCommit,
          workerId,
          env
        });
        if (observed.classification !== "absent") {
          if (["dirty", "exact-clean-registered"].includes(observed.classification)
            && record.cleanup.removeAttempts < 2) {
            continue;
          }
          blockCleanup(
            root,
            workerId,
            env,
            observed.classification,
            "Official worktree removal response was lost without exact absence."
          );
          throw cleanupError(
            "Official worktree removal response was lost without exact absence.",
            observed.classification
          );
        }
      }
      observed = classifyWorkerWorktreeEffect({
        controlRoot: root,
        executionRoot: expectedWorkerWorktreeRoot(root, workerId, env),
        baseCommit: record.baseBinding.baseCommit,
        workerId,
        env
      });
      if (observed.classification !== "absent") {
        blockCleanup(
          root,
          workerId,
          env,
          observed.classification,
          "Official worktree removal returned without exact independent absence."
        );
        throw cleanupError(
          "Official worktree removal returned without exact independent absence.",
          observed.classification
        );
      }
      const removeReceiptDigest = removeResult
        ? boundedEffectDigest(removeResult, "Official worktree removal")
        : digest({
            responseLost: true,
            proofDigest: observed.evidence.proofDigest,
            requestDigest
          });
      record = advanceCleanup(root, workerId, env, (cleanup) => ({
        ...cleanup,
        removeReceiptDigest,
        updatedAt: now()
      }));
    }

    // Official Git removal may leave the deterministic empty broker wrapper.
    // Removing this exact private empty directory is not a local Git removal.
    let absence = classifyWorkerWorktreeEffect({
      controlRoot: root,
      executionRoot: expectedWorkerWorktreeRoot(root, workerId, env),
      baseCommit: record.baseBinding.baseCommit,
      workerId,
      env
    });
    if (absence.classification !== "absent") {
      blockCleanup(root, workerId, env, absence.classification, "Worktree absence changed before final qualification.");
      throw cleanupError(
        "Worktree absence changed before final qualification.",
        absence.classification
      );
    }
    if (absence.evidence.workerParentState === "private-empty") {
      removeEmptyWorkerWorktreeParent({ controlRoot: root, workerId, env });
    }
    absence = classifyWorkerWorktreeEffect({
      controlRoot: root,
      executionRoot: expectedWorkerWorktreeRoot(root, workerId, env),
      baseCommit: record.baseBinding.baseCommit,
      workerId,
      env
    });
    if (absence.classification !== "absent"
      || absence.evidence.workerParentState !== "absent") {
      blockCleanup(root, workerId, env, absence.classification, "Managed worker parent or Git administration state remains after cleanup.");
      throw cleanupError(
        "Managed worker parent or Git administration state remains after cleanup.",
        absence.classification
      );
    }
    for (const identity of [
      owned.controllerProcess,
      owned.workerProcess,
      owned.providerProcess
    ]) {
      if (!processGroupGone(identity)) {
        blockCleanup(root, workerId, env, "process-present", "A worker runtime process remains after cleanup.");
        throw cleanupError(
          "A worker runtime process remains after cleanup.",
          "process-present"
        );
      }
    }
    if (loadProviderGuard(root, workerId, env) !== null) {
      blockCleanup(root, workerId, env, "guard-present", "A worker provider guard remains after cleanup.");
      throw cleanupError(
        "A worker provider guard remains after cleanup.",
        "guard-present"
      );
    }
    const finalSessionAbsence = await observeSessionAbsentTwice(
      inspectProviderSession,
      record.providerSessionId
    );
    if (!finalSessionAbsence) {
      blockCleanup(root, workerId, env, "session-present", "Provider session reappeared before cleanup publication.");
      throw cleanupError(
        "Provider session reappeared before cleanup publication.",
        "session-present"
      );
    }
    const receipt = publishAbsentCleanup(
      root,
      workerId,
      env,
      absence.evidence
    );
    return Object.freeze({ receipt, replayed: false });
  } finally {
    lease.release();
  }
}
