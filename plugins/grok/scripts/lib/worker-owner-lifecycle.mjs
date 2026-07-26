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
  assertParentUnchanged,
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
const CLEANUP_DISPOSITIONS = new Set(["integrated", "discarded"]);
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
  const integratedFields = new Set([
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
  const discardedFields = new Set([
    ...integratedFields,
    "disposition",
    "terminalStatus",
    "terminalEvidenceDigest",
    "parentFingerprintDigest"
  ]);
  const cleanup = record.cleanup;
  const disposition = cleanup?.disposition ?? "integrated";
  const exactReceiptFields = disposition === "discarded"
    ? discardedFields
    : integratedFields;
  if (!exactKeys(receipt, exactReceiptFields)
    || receipt.schemaVersion !== OWNER_LIFECYCLE_SCHEMA_VERSION
    || receipt.operation !== "cleanup"
    || receipt.workerId !== record.workerId
    || receipt.status !== "absent"
    || (disposition === "integrated"
      ? !SHA256_HEX.test(receipt.integrationReceiptDigest || "")
      : receipt.integrationReceiptDigest !== null)
    || [
      "closeReceiptDigest",
      "sessionDeletionDigest",
      "officialRemoveReceiptDigest",
      "absenceProofDigest",
      "receiptDigest"
    ].some((field) => !SHA256_HEX.test(receipt[field] || ""))
    || receipt.integrationReceiptDigest !== cleanup?.integrationReceiptDigest
    || receipt.closeReceiptDigest !== cleanup?.closeReceiptDigest
    || receipt.sessionDeletionDigest !== cleanup?.sessionDeletionDigest
    || receipt.officialRemoveReceiptDigest !== cleanup?.removeReceiptDigest
    || receipt.absenceProofDigest !== cleanup?.absenceProof?.proofDigest
    || (disposition === "discarded"
      && (receipt.disposition !== "discarded"
        || receipt.terminalStatus !== "cancelled"
        || receipt.terminalStatus !== cleanup?.terminalStatus
        || receipt.terminalEvidenceDigest !== cleanup?.terminalEvidenceDigest
        || receipt.parentFingerprintDigest !== cleanup?.parentFingerprintDigest
        || receipt.parentFingerprintDigest
          !== record.baseBinding.parentFingerprintDigest
        || !SHA256_HEX.test(receipt.terminalEvidenceDigest || "")
        || !SHA256_HEX.test(receipt.parentFingerprintDigest || "")))
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
  if (record.artifactBinding !== null
    && (!exactKeys(record.artifactBinding, new Set([
      "artifactDigest",
      "manifestDigest",
      "securityDigest",
      "patchDigest",
      "contentDigest",
      "recordDigest"
    ]))
      || Object.values(record.artifactBinding)
        .some((value) => !SHA256_HEX.test(value || "")))) {
    throw stateError("Stored write artifact binding is malformed.");
  }
  const integration = record.integration;
  if ((record.artifactBinding === null) !== (integration === null)) {
    throw stateError("Artifact and integration lifecycle bindings disagree.");
  }
  if (integration !== null) {
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
  }

  const cleanup = record.cleanup;
  if (cleanup !== null) {
    const legacyFields = new Set([
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
    ]);
    const boundFields = new Set([
      ...legacyFields,
      "disposition",
      "terminalStatus",
      "terminalEvidenceDigest",
      "parentFingerprintDigest"
    ]);
    const hasTerminalBinding = Object.hasOwn(cleanup, "disposition");
    const disposition = hasTerminalBinding
      ? cleanup.disposition
      : "integrated";
    if (!exactKeys(cleanup, hasTerminalBinding ? boundFields : legacyFields)
      || cleanup.operation !== "cleanup"
      || !CLEANUP_STATES.has(cleanup.state)
      || !CLEANUP_DISPOSITIONS.has(disposition)
      || (disposition === "integrated"
        ? !SHA256_HEX.test(cleanup.integrationReceiptDigest || "")
        : cleanup.integrationReceiptDigest !== null)
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
    if (hasTerminalBinding
      && (!["completed", "cancelled"].includes(cleanup.terminalStatus)
        || !SHA256_HEX.test(cleanup.terminalEvidenceDigest || "")
        || !SHA256_HEX.test(cleanup.parentFingerprintDigest || "")
        || cleanup.parentFingerprintDigest
          !== record.baseBinding.parentFingerprintDigest)) {
      throw stateError("Stored write-cleanup terminal binding is malformed.");
    }
    if (disposition === "discarded") {
      if (!hasTerminalBinding
        || cleanup.terminalStatus !== "cancelled"
        || record.artifactBinding !== null
        || integration !== null) {
        throw stateError("Discard cleanup is not bound to one cancelled non-integrated worker.");
      }
    } else if (record.artifactBinding === null
      || integration === null
      || (hasTerminalBinding && cleanup.terminalStatus !== "completed")) {
      throw stateError("Integrated cleanup lacks its completed artifact and integration lifecycle.");
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
  } else if (integration === null) {
    throw stateError("Owner lifecycle record has no integration or cleanup operation.");
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

function terminalCleanupEvidenceDigest(job) {
  const dispatch = job.request?.spawn?.dispatch;
  return digest({
    schemaVersion: job.schemaVersion,
    workerId: job.id,
    terminalStatus: job.status,
    write: job.write,
    executionBindingDigest: job.executionBinding?.bindingDigest ?? null,
    controlWorkspaceId: job.controlWorkspaceId ?? null,
    provisioningState: job.provisioning?.state ?? null,
    worktreeOperationId:
      job.provisioningRuntime?.intent?.operationId ?? null,
    providerLaunchOutcome:
      job.request?.spawn?.providerLaunchOutcome ?? null,
    dispatch: dispatch
      ? {
          schemaVersion: dispatch.schemaVersion,
          state: dispatch.state,
          providerGeneration: dispatch.providerGeneration
        }
      : null,
    providerHomeId: job.request?.providerHomeId ?? null,
    providerSessionDigest: typeof job.grokSessionId === "string"
      ? digest(job.grokSessionId)
      : null,
    stopReason: job.result?.stopReason ?? null,
    taskRuntimeCleaned: job.result?.taskRuntimeCleaned ?? null,
    hostVerification: job.result?.hostVerification ?? null,
    writeArtifactDigest: job.result?.writeArtifact
      ? digest(job.result.writeArtifact)
      : null,
    processIdentityDigests: {
      controller: job.controllerProcess ? digest(job.controllerProcess) : null,
      worker: job.workerProcess ? digest(job.workerProcess) : null,
      provider: job.providerProcess ? digest(job.providerProcess) : null
    }
  });
}

function assertRuntimeGoneAndGuardAbsent(job, binding, workerId, env) {
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
}

function assertNoDurableWriteArtifact(controlRoot, workerId, env) {
  try {
    readWriteWorkerArtifact({
      controlRoot,
      workerId,
      env
    });
  } catch (error) {
    if (error?.code === "E_JOB_ACTIVE") return;
    throw cleanupError(
      "Cancelled write worker has a durable or ambiguous write artifact.",
      "artifact-present"
    );
  }
  throw cleanupError(
    "Cancelled write worker has a durable write artifact.",
    "artifact-present"
  );
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
  assertRuntimeGoneAndGuardAbsent(job, binding, workerId, env);
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
    worktreeOperationId,
    terminalEvidenceDigest: terminalCleanupEvidenceDigest(job)
  });
}

function cancelledWriteCleanupContext({
  root,
  principal,
  workerId,
  env,
  requireRegisteredWorktree
}) {
  const job = readExactlyOwnedJob(root, principal, workerId, env);
  const binding = job.executionBinding;
  const dispatch = job.request?.spawn?.dispatch;
  const worktreeOperationId =
    job.provisioningRuntime?.intent?.operationId;
  const control = resolveControlWorkspace(root, env);
  if (job.schemaVersion !== 3
    || job.kind !== "task"
    || job.jobClass !== "task"
    || job.write !== true
    || job.status !== "cancelled"
    || job.result?.stopReason !== "cancelled"
    || job.result?.taskRuntimeCleaned !== true
    || job.result?.hostVerification !== "not_run"
    || Object.hasOwn(job.result || {}, "writeArtifact")
    || !binding
    || !SHA256_HEX.test(binding.bindingDigest || "")
    || job.request?.spawn?.executionBindingDigest !== binding.bindingDigest
    || binding.workerId !== workerId
    || binding.controlWorkspaceId !== job.controlWorkspaceId
    || binding.controlWorkspaceId !== control.controlWorkspaceId
    || binding.controlRoot !== control.controlRoot
    || !EXACT_COMMIT.test(binding.baseCommit || "")
    || !EXACT_COMMIT.test(binding.baseTree || "")
    || !binding.parentFingerprint
    || !SHA256_HEX.test(binding.parentFingerprintDigest || "")
    || binding.expectedExecutionRoot !== expectedWorkerWorktreeRoot(
      control.controlRoot,
      workerId,
      env
    )
    || job.provisioning?.state !== "ready"
    || typeof worktreeOperationId !== "string"
    || worktreeOperationId.length < 1
    || worktreeOperationId.length > 256
    || /[\0\r\n]/.test(worktreeOperationId)
    || !job.provisioningRuntime?.intent?.executableIdentity
    || ![1, 2].includes(dispatch?.schemaVersion)
    || dispatch.state !== "provider-started"
    || !Number.isSafeInteger(dispatch.providerGeneration)
    || dispatch.providerGeneration < 1
    || job.request?.spawn?.providerLaunchOutcome !== "launched"
    || job.request?.providerHomeId !== workerId
    || !CANONICAL_UUID.test(job.grokSessionId || "")) {
    throw cleanupError(
      "Worker is not one exact terminal-cancelled write cleanup candidate.",
      "ineligible-terminal"
    );
  }
  assertRuntimeGoneAndGuardAbsent(job, binding, workerId, env);
  assertNoDurableWriteArtifact(binding.controlRoot, workerId, env);
  try {
    assertParentUnchanged(binding.parentFingerprint, binding.controlRoot);
  } catch {
    throw cleanupError(
      "Cancelled write cleanup requires its exact unchanged parent.",
      "parent-drift"
    );
  }
  const worktree = classifyWorkerWorktreeEffect({
    controlRoot: binding.controlRoot,
    executionRoot: binding.expectedExecutionRoot,
    baseCommit: binding.baseCommit,
    workerId,
    env
  });
  if (requireRegisteredWorktree
    && !["dirty", "exact-clean-registered"].includes(worktree.classification)) {
    throw cleanupError(
      "Cancelled write cleanup requires its exact registered managed worktree.",
      worktree.classification
    );
  }
  return Object.freeze({
    job,
    binding,
    control,
    worktree,
    worktreeOperationId,
    terminalEvidenceDigest: terminalCleanupEvidenceDigest(job)
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

function cleanupRequestDigest(
  record,
  principal,
  keyDigest,
  integrationReceiptDigest,
  terminalBinding = null
) {
  const request = {
    operation: "cleanup",
    workerId: record.workerId,
    owner: ownerProjection(principal),
    executionBindingDigest: record.executionBindingDigest,
    integrationReceiptDigest,
    idempotencyKeyDigest: keyDigest
  };
  if (terminalBinding) {
    Object.assign(request, {
      disposition: terminalBinding.disposition,
      terminalStatus: terminalBinding.terminalStatus,
      terminalEvidenceDigest: terminalBinding.terminalEvidenceDigest,
      parentFingerprintDigest: terminalBinding.parentFingerprintDigest
    });
  }
  return digest(request);
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

function initialDiscardLifecycleRecord(context, principal, cleanup) {
  const binding = context.binding;
  const owner = ownerProjection(principal);
  return {
    schemaVersion: OWNER_LIFECYCLE_SCHEMA_VERSION,
    workerId: context.job.id,
    controlWorkspaceId: context.job.controlWorkspaceId,
    owner,
    ownerDigest: digest(owner),
    executionBindingDigest: binding.bindingDigest,
    artifactBinding: null,
    baseBinding: {
      baseCommit: binding.baseCommit,
      baseTree: binding.baseTree,
      parentFingerprintDigest: binding.parentFingerprintDigest
    },
    parentFingerprint: binding.parentFingerprint,
    providerSessionId: context.job.grokSessionId,
    worktreeOperationId: context.worktreeOperationId,
    integration: null,
    cleanup,
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

function assertDiscardRecordContext(record, context, principal) {
  const owner = ownerProjection(principal);
  if (record.workerId !== context.job.id
    || record.controlWorkspaceId !== context.job.controlWorkspaceId
    || record.ownerDigest !== digest(owner)
    || stableStringify(record.owner) !== stableStringify(owner)
    || record.executionBindingDigest !== context.binding.bindingDigest
    || record.artifactBinding !== null
    || record.integration !== null
    || record.baseBinding.baseCommit !== context.binding.baseCommit
    || record.baseBinding.baseTree !== context.binding.baseTree
    || record.baseBinding.parentFingerprintDigest
      !== context.binding.parentFingerprintDigest
    || stableStringify(record.parentFingerprint)
      !== stableStringify(context.binding.parentFingerprint)
    || record.providerSessionId !== context.job.grokSessionId
    || record.worktreeOperationId !== context.worktreeOperationId
    || record.cleanup?.disposition !== "discarded"
    || record.cleanup?.terminalStatus !== "cancelled"
    || record.cleanup?.terminalEvidenceDigest
      !== context.terminalEvidenceDigest
    || record.cleanup?.parentFingerprintDigest
      !== context.binding.parentFingerprintDigest) {
    throw stateError("Discard cleanup identity changed after durable planning.");
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
    cleanupDisposition:
      operation === "cleanup" ? lifecycle.disposition ?? "integrated" : null,
    terminalStatus:
      operation === "cleanup" ? lifecycle.terminalStatus ?? null : null,
    terminalEvidenceDigest:
      operation === "cleanup" ? lifecycle.terminalEvidenceDigest ?? null : null,
    parentFingerprintDigest:
      operation === "cleanup"
        ? lifecycle.parentFingerprintDigest
          ?? record.baseBinding.parentFingerprintDigest
        : null,
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

function cleanupTerminalBinding(cleanup) {
  if (!cleanup || !Object.hasOwn(cleanup, "disposition")) return null;
  return Object.freeze({
    disposition: cleanup.disposition,
    terminalStatus: cleanup.terminalStatus,
    terminalEvidenceDigest: cleanup.terminalEvidenceDigest,
    parentFingerprintDigest: cleanup.parentFingerprintDigest
  });
}

function cleanupEffectDigest(record, value, label) {
  const terminalBinding = cleanupTerminalBinding(record.cleanup);
  return terminalBinding
    ? boundedEffectDigest({
        terminalBinding,
        effectReceipt: value
      }, label)
    : boundedEffectDigest(value, label);
}

function cleanupEvidenceDigest(record, value) {
  const terminalBinding = cleanupTerminalBinding(record.cleanup);
  return terminalBinding
    ? digest({ terminalBinding, evidence: value })
    : digest(value);
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
    if (cleanup.disposition === "discarded") {
      Object.assign(unsignedReceipt, {
        disposition: "discarded",
        terminalStatus: cleanup.terminalStatus,
        terminalEvidenceDigest: cleanup.terminalEvidenceDigest,
        parentFingerprintDigest: cleanup.parentFingerprintDigest
      });
    }
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
    let disposition;
    let terminalBinding;
    let discardedContext = null;
    if (owned.status === "completed") {
      disposition = "integrated";
      if (!record
        || record.integration?.state !== "verified"
        || record.integration.receipt?.receiptDigest !== integrationReceiptDigest
        || !SHA256_HEX.test(integrationReceiptDigest || "")) {
        throw integrationError(
          "Write cleanup requires the exact durable integration receipt."
        );
      }
      if (owned.write !== true
        || owned.kind !== "task"
        || owned.jobClass !== "task"
        || owned.result?.taskRuntimeCleaned !== true
        || owned.result?.hostVerification !== "not_run"
        || owned.grokSessionId !== record.providerSessionId) {
        throw cleanupError("Write cleanup lost its terminal runtime/session binding.");
      }
      terminalBinding = cleanupTerminalBinding(record.cleanup) || {
        disposition,
        terminalStatus: "completed",
        terminalEvidenceDigest: terminalCleanupEvidenceDigest(owned),
        parentFingerprintDigest: record.baseBinding.parentFingerprintDigest
      };
    } else if (owned.status === "cancelled") {
      disposition = "discarded";
      if (integrationReceiptDigest !== undefined
        && integrationReceiptDigest !== null) {
        throw integrationError(
          "Cancelled write cleanup forbids an integration receipt."
        );
      }
      discardedContext = cancelledWriteCleanupContext({
        root,
        principal,
        workerId,
        env,
        requireRegisteredWorktree: record === null
      });
      if (record) {
        if (record.integration !== null
          || record.artifactBinding !== null
          || record.cleanup?.disposition !== "discarded") {
          throw integrationError(
            "Cancelled write cleanup forbids any owner integration lifecycle."
          );
        }
        assertDiscardRecordContext(
          record,
          discardedContext,
          principal
        );
      }
      terminalBinding = record
        ? cleanupTerminalBinding(record.cleanup)
        : {
            disposition,
            terminalStatus: "cancelled",
            terminalEvidenceDigest:
              discardedContext.terminalEvidenceDigest,
            parentFingerprintDigest:
              discardedContext.binding.parentFingerprintDigest
          };
      integrationReceiptDigest = null;
    } else {
      throw cleanupError(
        "Write worker is not ready for terminal cleanup.",
        "ineligible-terminal"
      );
    }
    const requestDigest = cleanupRequestDigest(
      record || {
        workerId,
        executionBindingDigest:
          discardedContext.binding.bindingDigest
      },
      principal,
      keyDigest,
      integrationReceiptDigest,
      record?.cleanup && !Object.hasOwn(record.cleanup, "disposition")
        ? null
        : terminalBinding
    );
    const replay = cleanupReplay(record, keyDigest, requestDigest);
    if (replay) return replay;

    if (disposition === "discarded" && record === null) {
      const createdAt = now();
      const cleanup = {
        operation: "cleanup",
        state: "planned",
        integrationReceiptDigest: null,
        disposition: "discarded",
        terminalStatus: "cancelled",
        terminalEvidenceDigest: terminalBinding.terminalEvidenceDigest,
        parentFingerprintDigest: terminalBinding.parentFingerprintDigest,
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
      };
      withRegistry(root, env, (registry) => {
        assertGlobalKey(registry, keyDigest, "cleanup", workerId, requestDigest);
        if (registry.records[workerId]) {
          throw stateError("Worker discard lifecycle was concurrently created.");
        }
        if (Object.keys(registry.records).length >= MAX_LIFECYCLE_RECORDS) {
          throw stateError("Worker owner-lifecycle registry reached its bounded capacity.");
        }
        return replaceRecord(
          registry,
          initialDiscardLifecycleRecord(
            discardedContext,
            principal,
            cleanup
          ),
          {
            keyDigest,
            operation: "cleanup",
            requestDigest
          }
        );
      });
      record = readCurrentRecord(root, workerId, env);
    } else if (record.cleanup === null) {
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
            disposition: "integrated",
            terminalStatus: "completed",
            terminalEvidenceDigest: terminalBinding.terminalEvidenceDigest,
            parentFingerprintDigest: terminalBinding.parentFingerprintDigest,
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

    if (record.cleanup.disposition === "discarded"
      && record.cleanup.closeAttempts === 0
      && !record.cleanup.closeReceiptDigest) {
      const observed = classifyWorkerWorktreeEffect({
        controlRoot: root,
        executionRoot: expectedWorkerWorktreeRoot(root, workerId, env),
        baseCommit: record.baseBinding.baseCommit,
        workerId,
        env
      });
      if (!["dirty", "exact-clean-registered"].includes(observed.classification)) {
        throw cleanupError(
          "Cancelled write cleanup requires its exact registered managed worktree before effects.",
          observed.classification
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
        const closeReceiptDigest = cleanupEffectDigest(
          record,
          close,
          "Official session close"
        );
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
        const sessionDeletionDigest = cleanupEvidenceDigest(record, {
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
      const sessionDeletionDigest = cleanupEvidenceDigest(record, {
        deletionReceiptDigest: deletionResult
          ? cleanupEffectDigest(
              record,
              deletionResult,
              "Provider-session delete"
            )
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
        const removeReceiptDigest = cleanupEvidenceDigest(record, {
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
        ? cleanupEffectDigest(
            record,
            removeResult,
            "Official worktree removal"
          )
        : cleanupEvidenceDigest(record, {
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
