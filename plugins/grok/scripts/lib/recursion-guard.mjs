import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { CompanionError } from "./errors.mjs";
import { assertExecutableAttestation } from "./executable-identity.mjs";
import { identityMatches, processGroupAlive } from "./process-control.mjs";
import { withWorkspaceStateTransaction } from "./state.mjs";
import {
  assertExecutionBinding,
  assertProvisioningJournal
} from "./worker-execution-binding.mjs";
import {
  gitCommonDir,
  listedWorktreeRoots,
  resolveControlWorkspace
} from "./workspace.mjs";

const ROOT = path.join(os.tmpdir(), `grok-companion-guards-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const EXACT_NONCE_ID = /^[0-9a-f]{32}$/;
const OPAQUE_ID = /^[0-9a-f]{32,64}$/;
const WORKTREE_PROVISIONING_PURPOSE = "worktree-provisioning";
export const WORKTREE_INTEGRATION_PURPOSE = "worktree-integration";
export const WORKTREE_CLEANUP_PURPOSE = "worktree-cleanup";
const WORKER_OWNER_CONTROLLER_PURPOSES = new Set([
  WORKTREE_INTEGRATION_PURPOSE,
  WORKTREE_CLEANUP_PURPOSE
]);
const WORKER_OWNER_CONTROLLER_COMMON_BINDING_KEYS = new Set([
  "purpose",
  "controlWorkspaceId",
  "controlRoot",
  "executionRoot",
  "executionBindingDigest",
  "effectBindingDigest",
  "controllerAttemptId",
  "controllerFence",
  "holderId",
  "providerSpawnIntentId"
]);
const WORKTREE_INTEGRATION_BINDING_KEYS = new Set([
  ...WORKER_OWNER_CONTROLLER_COMMON_BINDING_KEYS,
  "targetPath",
  "operationId"
]);
const WORKTREE_CLEANUP_BINDING_KEYS = new Set([
  ...WORKER_OWNER_CONTROLLER_COMMON_BINDING_KEYS,
  "managedWorktreeParent",
  "sessionId"
]);
const WORKTREE_PROVISIONING_RUNTIME_KEYS = new Set([
  "schemaVersion",
  "intent",
  "activatedJournalDigest",
  "activationDigest",
  "officialReceipt",
  "hostAdoption",
  "priorAttempts",
  "executionContextManifest",
  "executionContextManifestRecordDigest",
  "cleanupProof"
]);
const LEGACY_WORKTREE_PROVISIONING_RUNTIME_KEY_SETS = Object.freeze([
  new Set([...WORKTREE_PROVISIONING_RUNTIME_KEYS].filter(
    (key) => key !== "hostAdoption"
  )),
  new Set([...WORKTREE_PROVISIONING_RUNTIME_KEYS].filter(
    (key) => key !== "priorAttempts"
  )),
  new Set([...WORKTREE_PROVISIONING_RUNTIME_KEYS].filter(
    (key) => key !== "hostAdoption" && key !== "priorAttempts"
  ))
]);
const WORKTREE_PROVISIONING_INTENT_KEYS = new Set([
  "schemaVersion",
  "purpose",
  "workerId",
  "intentId",
  "providerSpawnIntentId",
  "operationId",
  "executionBindingDigest",
  "expectedPlannedJournalDigest",
  "provisioningAttemptId",
  "provisioningFence",
  "holderId",
  "executableIdentity",
  "status",
  "processIdentity",
  "preparedAt",
  "activatedAt",
  "registeredAt",
  "settledAt",
  "noChildAt",
  "resolution",
  "updatedAt",
  "intentDigest"
]);
const WORKTREE_PROVISIONING_PROCESS_KEYS = new Set([
  "pid",
  "startToken",
  "processGroupId"
]);
const WORKTREE_PROVISIONING_ARCHIVE_KEYS = new Set([
  "schemaVersion",
  "ordinal",
  "previousArchiveDigest",
  "operationId",
  "sourceCleanupPendingJournal",
  "attemptEvidence",
  "absenceProof",
  "archivedAt",
  "archiveDigest"
]);
const WORKTREE_PROVISIONING_ARCHIVE_EVIDENCE_KEYS = new Set([
  "intent",
  "activatedJournalDigest",
  "activationDigest",
  "officialReceipt",
  "hostAdoption",
  "executionContextManifest",
  "executionContextManifestRecordDigest",
  "cleanupProof"
]);
const WORKTREE_PROVISIONING_CLEANUP_PROOF_KEYS = new Set([
  "schemaVersion",
  "providerSpawnIntentId",
  "processIdentity",
  "processGroupGone",
  "providerGuardAbsent",
  "observedAt",
  "proofDigest"
]);
const WORKTREE_ABSENCE_PROOF_KEYS = new Set([
  "schemaVersion",
  "classification",
  "workerId",
  "controlWorkspaceId",
  "controlRootDigest",
  "gitCommonDirDigest",
  "expectedExecutionRootDigest",
  "expectedWorkerParentDigest",
  "baseCommitDigest",
  "filesystemPathState",
  "workerParentState",
  "managedRootIdentityDigest",
  "workerParentIdentityDigest",
  "rawInventoryDigest",
  "adminInventoryDigest",
  "exactRegistrationCount",
  "managedParentRegistrationCount",
  "adminBacklinkMatchCount",
  "observedAt",
  "proofDigest"
]);
const PRE_READY_WRITE_REQUEST_KEYS = new Set([
  "admissionContextManifest",
  "envelope",
  "providerHomeId",
  "publicObjective",
  "roleId",
  "spawn"
]);
const PRE_READY_WRITE_SPAWN_KEYS = new Set([
  "idempotencyKeyDigest",
  "ownerThreadId",
  "admissionRequestDigest",
  "successDefinition",
  "ownershipMode",
  "writeLifecycleCapabilityDigest",
  "providerLaunchPending",
  "providerLaunchInFlight",
  "providerLaunchOutcome"
]);
const WORKTREE_PROVISIONING_JOB_KEYS = new Set([
  "schemaVersion",
  "id",
  "kind",
  "jobClass",
  "write",
  "status",
  "phase",
  "summary",
  "progress",
  "createdAt",
  "updatedAt",
  "startedAt",
  "completedAt",
  "heartbeatAt",
  "host",
  "profile",
  "role",
  "model",
  "effort",
  "controlWorkspaceId",
  "executionBinding",
  "provisioning",
  "provisioningRuntime",
  "request",
  "lifecycleEvents",
  "result",
  "error"
]);

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function canonicalize(value, stack = new Set()) {
  if (value === null || typeof value !== "object") return value;
  if (stack.has(value)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Provisioning guard evidence must not be cyclic.");
  }
  stack.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => canonicalize(item, stack));
  } else {
    result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = canonicalize(value[key], stack);
    }
  }
  stack.delete(value);
  return result;
}

function stableDigest(value) {
  return digest(JSON.stringify(canonicalize(value)));
}

function markerName(marker) {
  return String(marker).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
}

function workspaceDirectory(workspaceRoot) {
  let scope;
  try { scope = gitCommonDir(workspaceRoot); }
  catch { scope = fs.realpathSync(workspaceRoot); }
  return path.join(ROOT, digest(scope));
}

function legacyWorkspaceDirectory(workspaceRoot) {
  return path.join(ROOT, digest(fs.realpathSync(workspaceRoot)));
}

function workspaceDirectories(workspaceRoot) {
  let worktrees = [];
  try { worktrees = listedWorktreeRoots(workspaceRoot); } catch {}
  return [...new Set([
    workspaceDirectory(workspaceRoot),
    legacyWorkspaceDirectory(workspaceRoot),
    ...worktrees.map((root) => legacyWorkspaceDirectory(root))
  ])];
}

function guardFiles(workspaceRoot, marker) {
  const name = `${markerName(marker)}.json`;
  return workspaceDirectories(workspaceRoot).map((directory) => path.join(directory, name));
}

function guardFile(workspaceRoot, marker) {
  return guardFiles(workspaceRoot, marker)[0];
}

function ownerDigest(owner) {
  return typeof owner === "string" && owner ? digest(owner) : null;
}

function isPlainRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value, allowed) {
  return isPlainRecord(value)
    && Object.keys(value).length === allowed.size
    && Object.keys(value).every((key) => allowed.has(key));
}

export function sameGuardProcessIdentity(left, right) {
  return Boolean(
    left?.pid
    && right?.pid
    && left.pid === right.pid
    && left.startToken === right.startToken
    && left.processGroupId === right.processGroupId
  );
}

function completeProviderProcess(identity) {
  return exactKeys(identity, new Set(["pid", "startToken", "processGroupId"]))
    && Number.isInteger(identity.pid)
    && identity.pid > 0
    && typeof identity.startToken === "string"
    && identity.startToken.length > 0
    && identity.startToken.length <= 256
    && (process.platform === "win32"
      ? identity.processGroupId === null
      : identity.processGroupId === identity.pid);
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || !value) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function completeWorktreeProvisioningProcess(identity) {
  return completeProviderProcess(identity)
    && exactKeys(identity, WORKTREE_PROVISIONING_PROCESS_KEYS)
    && Number.isSafeInteger(identity.pid)
    && identity.pid <= 2_147_483_647
    && identity.startToken.trim() === identity.startToken
    && !identity.startToken.includes("\0")
    && identity.startToken !== "[REDACTED]";
}

function sameWorktreeProvisioningProcess(left, right) {
  return completeWorktreeProvisioningProcess(left)
    && completeWorktreeProvisioningProcess(right)
    && left.pid === right.pid
    && left.startToken === right.startToken
    && left.processGroupId === right.processGroupId;
}

function normalizeProviderGuardBinding(workspaceRoot, marker, binding, env) {
  const legacyKeys = new Set([
    "controlWorkspaceId",
    "executionRoot",
    "dispatchAttemptId",
    "dispatchFence",
    "providerGeneration"
  ]);
  const intentBoundKeys = new Set([
    ...legacyKeys,
    "providerSpawnIntentId"
  ]);
  const writeIntentBoundKeys = new Set([
    ...intentBoundKeys,
    "executionBindingDigest"
  ]);
  const readLegacy = exactKeys(binding, legacyKeys);
  const readIntentBound = exactKeys(binding, intentBoundKeys);
  const writeIntentBound = exactKeys(binding, writeIntentBoundKeys);
  if (!readLegacy && !readIntentBound && !writeIntentBound) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Provider guard binding is malformed.");
  }
  const control = resolveControlWorkspace(workspaceRoot, env);
  let executionRoot;
  try { executionRoot = fs.realpathSync(binding.executionRoot); }
  catch { throw new CompanionError("E_PROCESS_IDENTITY", "Provider guard execution root is unavailable."); }
  if (control.executionRoot !== executionRoot
    || binding.executionRoot !== executionRoot
    || binding.controlWorkspaceId !== control.controlWorkspaceId
    || !/^[0-9a-f]{32}$/.test(binding.dispatchAttemptId || "")
    || !Number.isSafeInteger(binding.dispatchFence)
    || binding.dispatchFence < 1
    || !Number.isSafeInteger(binding.providerGeneration)
    || binding.providerGeneration < 1
    || (Object.hasOwn(binding, "providerSpawnIntentId")
      && !/^[0-9a-f]{32}$/.test(binding.providerSpawnIntentId || ""))
    || (writeIntentBound && !SHA256_HEX.test(binding.executionBindingDigest || ""))
    || !markerName(marker)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Provider guard is not bound to its execution root and dispatch.");
  }
  return Object.freeze({
    ...binding,
    executionRoot,
    providerSpawnIntentId: binding.providerSpawnIntentId || null,
    ...(writeIntentBound
      ? { executionBindingDigest: binding.executionBindingDigest }
      : {})
  });
}

function normalizeWorktreeProvisioningGuardBinding(workspaceRoot, marker, binding, env) {
  const keys = new Set([
    "purpose",
    "controlWorkspaceId",
    "controlRoot",
    "expectedExecutionRoot",
    "executionBindingDigest",
    "provisioningAttemptId",
    "provisioningFence",
    "holderId",
    "providerSpawnIntentId"
  ]);
  if (!exactKeys(binding, keys)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Worktree provisioning guard binding is malformed.");
  }
  let callerRoot;
  let control;
  try {
    callerRoot = fs.realpathSync(workspaceRoot);
    control = resolveControlWorkspace(callerRoot, env);
  } catch {
    throw new CompanionError("E_PROCESS_IDENTITY", "Worktree provisioning control root is unavailable.");
  }
  if (binding.purpose !== WORKTREE_PROVISIONING_PURPOSE
    || binding.controlWorkspaceId !== control.controlWorkspaceId
    || binding.controlRoot !== callerRoot
    || binding.controlRoot !== control.controlRoot
    || typeof binding.expectedExecutionRoot !== "string"
    || !path.isAbsolute(binding.expectedExecutionRoot)
    || path.normalize(binding.expectedExecutionRoot) !== binding.expectedExecutionRoot
    || binding.expectedExecutionRoot.length > 4_096
    || binding.expectedExecutionRoot === binding.controlRoot
    || !SHA256_HEX.test(binding.executionBindingDigest || "")
    || !EXACT_NONCE_ID.test(binding.provisioningAttemptId || "")
    || !Number.isSafeInteger(binding.provisioningFence)
    || binding.provisioningFence < 1
    || !OPAQUE_ID.test(binding.holderId || "")
    || !EXACT_NONCE_ID.test(binding.providerSpawnIntentId || "")
    || !markerName(marker)) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Worktree provisioning guard is not exactly bound to its control workspace and fenced attempt."
    );
  }
  return Object.freeze({ ...binding });
}

function boundedOpaqueText(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && value.trim() === value
    && !value.includes("\0");
}

/**
 * Validate the exact, purpose-specific owner-controller binding without
 * consulting mutable repository state. The bootstrap uses this before it can
 * register a guard or launch Grok.
 */
export function assertWorkerOwnerControllerBinding(binding) {
  const purpose = binding?.purpose;
  const keys = purpose === WORKTREE_INTEGRATION_PURPOSE
    ? WORKTREE_INTEGRATION_BINDING_KEYS
    : purpose === WORKTREE_CLEANUP_PURPOSE
      ? WORKTREE_CLEANUP_BINDING_KEYS
      : null;
  const absolute = (value) => typeof value === "string"
    && path.isAbsolute(value)
    && path.normalize(value) === value
    && value.length <= 4_096;
  if (!keys
    || !exactKeys(binding, keys)
    || !WORKER_OWNER_CONTROLLER_PURPOSES.has(purpose)
    || !/^cws-[0-9a-f]{32}$/.test(binding.controlWorkspaceId || "")
    || !absolute(binding.controlRoot)
    || !absolute(binding.executionRoot)
    || binding.controlRoot === binding.executionRoot
    || !SHA256_HEX.test(binding.executionBindingDigest || "")
    || !SHA256_HEX.test(binding.effectBindingDigest || "")
    || !EXACT_NONCE_ID.test(binding.controllerAttemptId || "")
    || !Number.isSafeInteger(binding.controllerFence)
    || binding.controllerFence < 1
    || !OPAQUE_ID.test(binding.holderId || "")
    || !EXACT_NONCE_ID.test(binding.providerSpawnIntentId || "")
    || (purpose === WORKTREE_INTEGRATION_PURPOSE && (
      !absolute(binding.targetPath)
      || binding.targetPath !== path.join(binding.controlRoot, "target.txt")
      || !boundedOpaqueText(binding.operationId)
    ))
    || (purpose === WORKTREE_CLEANUP_PURPOSE && (
      !absolute(binding.managedWorktreeParent)
      || binding.managedWorktreeParent !== path.dirname(binding.executionRoot)
      || !boundedOpaqueText(binding.sessionId)
    ))) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Worker owner-controller binding is malformed or exceeds its bounded authority."
    );
  }
  return binding;
}

function normalizeWorkerOwnerControllerGuardBinding(
  workspaceRoot,
  marker,
  binding,
  env
) {
  assertWorkerOwnerControllerBinding(binding);
  let callerRoot;
  let executionRoot;
  let control;
  let executionControl;
  try {
    callerRoot = fs.realpathSync(workspaceRoot);
    executionRoot = fs.realpathSync(binding.executionRoot);
    control = resolveControlWorkspace(callerRoot, env);
    executionControl = resolveControlWorkspace(executionRoot, env);
  } catch {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Worker owner-controller repository roots are unavailable."
    );
  }
  let exactEffectTarget;
  try {
    exactEffectTarget = binding.purpose === WORKTREE_INTEGRATION_PURPOSE
      ? fs.realpathSync(binding.targetPath)
      : fs.realpathSync(binding.managedWorktreeParent);
  } catch {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Worker owner-controller effect target is unavailable."
    );
  }
  const expectedEffectTarget = binding.purpose === WORKTREE_INTEGRATION_PURPOSE
    ? binding.targetPath
    : binding.managedWorktreeParent;
  if (!markerName(marker)
    || binding.controlRoot !== callerRoot
    || binding.controlRoot !== control.controlRoot
    || binding.executionRoot !== executionRoot
    || executionControl.controlWorkspaceId !== control.controlWorkspaceId
    || executionControl.controlRoot !== control.controlRoot
    || binding.controlWorkspaceId !== control.controlWorkspaceId
    || exactEffectTarget !== expectedEffectTarget) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Worker owner-controller binding is not attached to the exact managed worktree and control workspace."
    );
  }
  if (binding.purpose === WORKTREE_INTEGRATION_PURPOSE) {
    const target = fs.lstatSync(binding.targetPath);
    if (!target.isFile() || target.isSymbolicLink()) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Worker integration target is not an exact regular file."
      );
    }
  } else {
    const parent = fs.lstatSync(binding.managedWorktreeParent);
    if (!parent.isDirectory()
      || parent.isSymbolicLink()
      || (parent.mode & 0o077) !== 0) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Worker cleanup parent is aliased, shared, or not private."
      );
    }
  }
  return Object.freeze({ ...binding });
}

function worktreeProvisioningIntentDigestBody(intent) {
  return {
    schemaVersion: intent.schemaVersion,
    purpose: intent.purpose,
    workerId: intent.workerId,
    intentId: intent.intentId,
    providerSpawnIntentId: intent.providerSpawnIntentId,
    operationId: intent.operationId,
    executionBindingDigest: intent.executionBindingDigest,
    expectedPlannedJournalDigest: intent.expectedPlannedJournalDigest,
    provisioningAttemptId: intent.provisioningAttemptId,
    provisioningFence: intent.provisioningFence,
    holderId: intent.holderId,
    executableIdentity: intent.executableIdentity,
    preparedAt: intent.preparedAt
  };
}

function validExecutableAttestation(value) {
  try {
    assertExecutableAttestation(value);
    return true;
  } catch {
    return false;
  }
}

function worktreeProvisioningActivationDigest(runtime) {
  return stableDigest({
    schemaVersion: 1,
    intentDigest: runtime.intent.intentDigest,
    providerSpawnIntentId: runtime.intent.providerSpawnIntentId,
    processIdentity: runtime.intent.processIdentity,
    executableIdentityDigest: runtime.intent.executableIdentity.identityDigest,
    activatedAt: runtime.intent.activatedAt,
    activatedJournalDigest: runtime.activatedJournalDigest
  });
}

function withoutDigest(value, field) {
  const body = { ...value };
  delete body[field];
  return body;
}

function validWorktreeProvisioningPriorAttempts(
  runtime,
  journal,
  binding,
  currentIntent
) {
  const journalArchiveDigest = journal.priorAttemptArchiveDigest ?? null;
  const journalReissuePlannedAt = journal.reissuePlannedAt ?? null;
  if (!Object.hasOwn(runtime, "priorAttempts")) {
    return journalArchiveDigest === null && journalReissuePlannedAt === null;
  }
  const history = runtime.priorAttempts;
  if (!Array.isArray(history) || history.length > 2) return false;
  if (history.length === 0) {
    return journalArchiveDigest === null && journalReissuePlannedAt === null;
  }

  let previousArchiveDigest = null;
  let previousArchivedAt = null;
  let operationId = null;
  let releaseIdentityDigest = null;
  let previousFence = 0;
  const attemptIds = new Set();
  const holderIds = new Set();
  const spawnIntentIds = new Set();
  try {
    for (let index = 0; index < history.length; index += 1) {
      const archive = history[index];
      if (!exactKeys(archive, WORKTREE_PROVISIONING_ARCHIVE_KEYS)
        || archive.schemaVersion !== 1
        || archive.ordinal !== index + 1
        || archive.previousArchiveDigest !== previousArchiveDigest
        || !SHA256_HEX.test(archive.archiveDigest || "")
        || archive.archiveDigest
          !== stableDigest(withoutDigest(archive, "archiveDigest"))
        || !canonicalTimestamp(archive.archivedAt)
        || !exactKeys(
          archive.attemptEvidence,
          WORKTREE_PROVISIONING_ARCHIVE_EVIDENCE_KEYS
        )) {
        return false;
      }
      const sourceJournal = assertProvisioningJournal(
        binding,
        archive.sourceCleanupPendingJournal
      );
      const archivedIntent = archive.attemptEvidence.intent;
      const cleanupProof = archive.attemptEvidence.cleanupProof;
      const absenceProof = archive.absenceProof;
      operationId ??= archivedIntent?.operationId;
      releaseIdentityDigest ??=
        archivedIntent?.executableIdentity?.releaseIdentityDigest;
      if (!exactKeys(archivedIntent, WORKTREE_PROVISIONING_INTENT_KEYS)
        || archivedIntent.schemaVersion !== 1
        || archivedIntent.purpose !== WORKTREE_PROVISIONING_PURPOSE
        || archivedIntent.workerId !== binding.workerId
        || !EXACT_NONCE_ID.test(archivedIntent.intentId || "")
        || archivedIntent.providerSpawnIntentId
          !== archivedIntent.intentId
        || !EXACT_NONCE_ID.test(
          archivedIntent.providerSpawnIntentId || ""
        )
        || archivedIntent.executionBindingDigest !== binding.bindingDigest
        || !SHA256_HEX.test(
          archivedIntent.expectedPlannedJournalDigest || ""
        )
        || !EXACT_NONCE_ID.test(
          archivedIntent.provisioningAttemptId || ""
        )
        || !Number.isSafeInteger(archivedIntent.provisioningFence)
        || archivedIntent.provisioningFence < 1
        || !OPAQUE_ID.test(archivedIntent.holderId || "")
        || archivedIntent.intentDigest
          !== stableDigest(worktreeProvisioningIntentDigestBody(archivedIntent))
        || !validExecutableAttestation(archivedIntent.executableIdentity)
        || archivedIntent.operationId !== operationId
        || archive.operationId !== operationId
        || archivedIntent.executableIdentity.releaseIdentityDigest
          !== releaseIdentityDigest
        || archivedIntent.provisioningFence !== previousFence + 1
        || sourceJournal.state !== "cleanup_pending"
        || (sourceJournal.priorAttemptArchiveDigest ?? null)
          !== previousArchiveDigest
        || sourceJournal.fence !== archivedIntent.provisioningFence
        || sourceJournal.attemptId !== archivedIntent.provisioningAttemptId
        || (index > 0
          && sourceJournal.reissuePlannedAt !== previousArchivedAt)
        || archivedIntent.status !== "registered"
        || !canonicalTimestamp(archivedIntent.preparedAt)
        || !canonicalTimestamp(archivedIntent.activatedAt)
        || !canonicalTimestamp(archivedIntent.registeredAt)
        || archivedIntent.settledAt !== null
        || archivedIntent.noChildAt !== null
        || archivedIntent.resolution !== null
        || !canonicalTimestamp(archivedIntent.updatedAt)
        || Date.parse(archivedIntent.preparedAt)
          < Date.parse(binding.createdAt)
        || Date.parse(archivedIntent.activatedAt)
          < Date.parse(archivedIntent.preparedAt)
        || Date.parse(archivedIntent.registeredAt)
          < Date.parse(archivedIntent.activatedAt)
        || Date.parse(archivedIntent.updatedAt)
          < Date.parse(archivedIntent.registeredAt)
        || archivedIntent.updatedAt !== sourceJournal.cleanupPendingAt
        || !completeWorktreeProvisioningProcess(
          archivedIntent.processIdentity
        )
        || sourceJournal.cleanupProvisioner?.pid
          !== archivedIntent.processIdentity.pid
        || sourceJournal.cleanupProvisioner?.startToken
          !== archivedIntent.processIdentity.startToken
        || sourceJournal.cleanupProvisioner?.holderId
          !== archivedIntent.holderId
        || sourceJournal.previousJournalDigest
          !== archive.attemptEvidence.activatedJournalDigest
        || !SHA256_HEX.test(
          archive.attemptEvidence.activatedJournalDigest || ""
        )
        || archive.attemptEvidence.activationDigest
          !== worktreeProvisioningActivationDigest({
            intent: archivedIntent,
            activatedJournalDigest:
              archive.attemptEvidence.activatedJournalDigest
          })
        || archive.attemptEvidence.officialReceipt !== null
        || archive.attemptEvidence.hostAdoption !== null
        || archive.attemptEvidence.executionContextManifest !== null
        || archive.attemptEvidence.executionContextManifestRecordDigest
          !== null
        || !exactKeys(
          cleanupProof,
          WORKTREE_PROVISIONING_CLEANUP_PROOF_KEYS
        )
        || cleanupProof.schemaVersion !== 1
        || cleanupProof.providerSpawnIntentId
          !== archivedIntent.providerSpawnIntentId
        || !sameWorktreeProvisioningProcess(
          cleanupProof.processIdentity,
          archivedIntent.processIdentity
        )
        || cleanupProof.processGroupGone !== true
        || cleanupProof.providerGuardAbsent !== true
        || !canonicalTimestamp(cleanupProof.observedAt)
        || Date.parse(cleanupProof.observedAt)
          < Date.parse(archivedIntent.activatedAt)
        || Date.parse(cleanupProof.observedAt)
          > Date.parse(sourceJournal.cleanupPendingAt)
        || cleanupProof.proofDigest
          !== stableDigest(withoutDigest(cleanupProof, "proofDigest"))
        || !exactKeys(absenceProof, WORKTREE_ABSENCE_PROOF_KEYS)
        || absenceProof.schemaVersion !== 1
        || absenceProof.classification !== "absent"
        || absenceProof.workerId !== binding.workerId
        || absenceProof.controlWorkspaceId !== binding.controlWorkspaceId
        || absenceProof.controlRootDigest !== binding.controlRootDigest
        || absenceProof.gitCommonDirDigest !== binding.gitCommonDirDigest
        || absenceProof.expectedExecutionRootDigest
          !== binding.expectedExecutionRootDigest
        || absenceProof.expectedWorkerParentDigest
          !== digest(path.dirname(binding.expectedExecutionRoot))
        || absenceProof.baseCommitDigest !== digest(binding.baseCommit)
        || absenceProof.filesystemPathState !== "absent"
        || !((
          absenceProof.workerParentState === "private-empty"
            && SHA256_HEX.test(
              absenceProof.workerParentIdentityDigest || ""
            )
        ) || (
          absenceProof.workerParentState === "absent"
            && absenceProof.workerParentIdentityDigest === null
        ))
        || !SHA256_HEX.test(
          absenceProof.managedRootIdentityDigest || ""
        )
        || !SHA256_HEX.test(absenceProof.rawInventoryDigest || "")
        || !SHA256_HEX.test(absenceProof.adminInventoryDigest || "")
        || absenceProof.exactRegistrationCount !== 0
        || absenceProof.managedParentRegistrationCount !== 0
        || absenceProof.adminBacklinkMatchCount !== 0
        || !canonicalTimestamp(absenceProof.observedAt)
        || Date.parse(absenceProof.observedAt)
          < Date.parse(sourceJournal.cleanupPendingAt)
        || absenceProof.proofDigest
          !== stableDigest(withoutDigest(absenceProof, "proofDigest"))
        || Date.parse(archive.archivedAt)
          < Date.parse(absenceProof.observedAt)
        || attemptIds.has(archivedIntent.provisioningAttemptId)
        || holderIds.has(archivedIntent.holderId)
        || spawnIntentIds.has(archivedIntent.providerSpawnIntentId)) {
        return false;
      }
      attemptIds.add(archivedIntent.provisioningAttemptId);
      holderIds.add(archivedIntent.holderId);
      spawnIntentIds.add(archivedIntent.providerSpawnIntentId);
      previousFence = archivedIntent.provisioningFence;
      previousArchiveDigest = archive.archiveDigest;
      previousArchivedAt = archive.archivedAt;
    }
  } catch {
    return false;
  }

  return previousArchiveDigest === journalArchiveDigest
    && previousArchivedAt === journalReissuePlannedAt
    && currentIntent.operationId === operationId
    && currentIntent.executableIdentity.releaseIdentityDigest
      === releaseIdentityDigest
    && currentIntent.provisioningFence === previousFence + 1
    && currentIntent.preparedAt === journalReissuePlannedAt
    && !attemptIds.has(currentIntent.provisioningAttemptId)
    && !holderIds.has(currentIntent.holderId)
    && !spawnIntentIds.has(currentIntent.providerSpawnIntentId);
}

function assertCanonicalWorktreeProvisioningState(
  job,
  guard,
  allowedStatuses = ["pending", "registered"]
) {
  const binding = assertExecutionBinding(job?.executionBinding, {
    workerId: job?.id,
    controlWorkspaceId: guard.controlWorkspaceId,
    controlRoot: guard.controlRoot,
    expectedExecutionRoot: guard.expectedExecutionRoot,
    bindingDigest: guard.executionBindingDigest
  });
  const journal = assertProvisioningJournal(binding, job?.provisioning);
  const runtime = job?.provisioningRuntime;
  const intent = runtime?.intent;
  const processIdentity = intent?.processIdentity;
  const operationIdValid = typeof intent?.operationId === "string"
    && intent.operationId.length > 0
    && intent.operationId.length <= 128
    && intent.operationId.trim() === intent.operationId
    && !/[\u0000-\u001f\u007f]/u.test(intent.operationId);
  const timestampsValid = canonicalTimestamp(intent?.preparedAt)
    && canonicalTimestamp(intent?.activatedAt)
    && canonicalTimestamp(intent?.updatedAt)
    && Date.parse(intent.preparedAt) >= Date.parse(binding.createdAt)
    && Date.parse(intent.activatedAt) >= Date.parse(intent.preparedAt)
    && Date.parse(intent.updatedAt) >= Date.parse(intent.activatedAt)
    && (
      intent.status === "pending"
        ? intent.registeredAt === null
        : canonicalTimestamp(intent.registeredAt)
          && Date.parse(intent.registeredAt) >= Date.parse(intent.activatedAt)
          && Date.parse(intent.updatedAt) >= Date.parse(intent.registeredAt)
    );
  const canonical = exactKeys(job, WORKTREE_PROVISIONING_JOB_KEYS)
    && job.schemaVersion === 3
    && job.kind === "task"
    && job.jobClass === "task"
    && job.write === true
    && job.status === "queued"
    && job.phase === "worktree-provisioning"
    && job.controlWorkspaceId === guard.controlWorkspaceId
    && job.startedAt === null
    && job.completedAt === null
    && job.result === null
    && job.error === null
    && exactKeys(job.request, PRE_READY_WRITE_REQUEST_KEYS)
    && job.request.providerHomeId === job.id
    && job.request.roleId === "implementer"
    && exactKeys(job.request.spawn, PRE_READY_WRITE_SPAWN_KEYS)
    && job.request.spawn.ownerThreadId === job.host?.sessionId
    && job.request.spawn.providerLaunchPending === false
    && job.request.spawn.providerLaunchInFlight === false
    && job.request.spawn.providerLaunchOutcome === "not-ready"
    && !Object.hasOwn(job.request.spawn, "dispatch")
    && !Object.hasOwn(job, "workerAuthorization")
    && !Object.hasOwn(job, "controllerProcess")
    && !Object.hasOwn(job, "workerProcess")
    && !Object.hasOwn(job, "providerProcess")
    && !Object.hasOwn(job, "grokSessionId")
    && journal.state === "provisioning"
    && journal.bindingDigest === binding.bindingDigest
    && journal.attemptId === guard.provisioningAttemptId
    && journal.fence === guard.provisioningFence
    && journal.provisioner?.pid === guard.providerProcess.pid
    && journal.provisioner?.startToken === guard.providerProcess.startToken
    && journal.provisioner?.holderId === guard.holderId
    && (
      exactKeys(runtime, WORKTREE_PROVISIONING_RUNTIME_KEYS)
      || LEGACY_WORKTREE_PROVISIONING_RUNTIME_KEY_SETS.some(
        (keys) => exactKeys(runtime, keys)
      )
    )
    && runtime.schemaVersion === 1
    && exactKeys(intent, WORKTREE_PROVISIONING_INTENT_KEYS)
    && intent.schemaVersion === 1
    && intent.purpose === WORKTREE_PROVISIONING_PURPOSE
    && intent.workerId === job.id
    && intent.intentId === guard.providerSpawnIntentId
    && intent.providerSpawnIntentId === intent.intentId
    && intent.executionBindingDigest === binding.bindingDigest
    && intent.expectedPlannedJournalDigest === journal.previousJournalDigest
    && intent.provisioningAttemptId === journal.attemptId
    && intent.provisioningFence === journal.fence
    && intent.holderId === journal.provisioner.holderId
    && validExecutableAttestation(intent.executableIdentity)
    && allowedStatuses.includes(intent.status)
    && intent.settledAt === null
    && intent.noChildAt === null
    && intent.resolution === null
    && operationIdValid
    && timestampsValid
    && completeWorktreeProvisioningProcess(processIdentity)
    && sameWorktreeProvisioningProcess(processIdentity, guard.providerProcess)
    && intent.intentDigest === stableDigest(worktreeProvisioningIntentDigestBody(intent))
    && runtime.activatedJournalDigest === journal.journalDigest
    && runtime.activationDigest === worktreeProvisioningActivationDigest(runtime)
    && runtime.officialReceipt === null
    && (!Object.hasOwn(runtime, "hostAdoption")
      || runtime.hostAdoption === null)
    && validWorktreeProvisioningPriorAttempts(
      runtime,
      journal,
      binding,
      intent
    )
    && runtime.executionContextManifest === null
    && runtime.executionContextManifestRecordDigest === null
    && runtime.cleanupProof === null;
  if (!canonical) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Worktree provisioning durable state is not canonical or exposes premature authority."
    );
  }
  return Object.freeze({ binding, journal, runtime, intent });
}

function provisioningRuntimeIntent(job) {
  try {
    return assertCanonicalWorktreeProvisioningState(
      job,
      {
        controlWorkspaceId: job?.controlWorkspaceId,
        controlRoot: job?.executionBinding?.controlRoot,
        expectedExecutionRoot: job?.executionBinding?.expectedExecutionRoot,
        executionBindingDigest: job?.executionBinding?.bindingDigest,
        provisioningAttemptId: job?.provisioning?.attemptId,
        provisioningFence: job?.provisioning?.fence,
        holderId: job?.provisioning?.provisioner?.holderId,
        providerSpawnIntentId: job?.provisioningRuntime?.intent?.providerSpawnIntentId,
        providerProcess: job?.provisioningRuntime?.intent?.processIdentity
      }
    ).intent;
  } catch {
    return null;
  }
}

function worktreeProvisioningIntentMatches(job, binding, allowedStatuses = ["pending", "registered"]) {
  try {
    assertCanonicalWorktreeProvisioningState(job, binding, allowedStatuses);
    return true;
  } catch {
    return false;
  }
}

function registeredProvisioningRuntime(latest, binding, registeredAt) {
  const verified = assertCanonicalWorktreeProvisioningState(
    latest,
    binding,
    ["pending"]
  );
  const next = {
    ...latest,
    provisioningRuntime: {
      ...verified.runtime,
      intent: {
        ...verified.intent,
        status: "registered",
        registeredAt,
        updatedAt: registeredAt
      }
    }
  };
  assertCanonicalWorktreeProvisioningState(next, binding, ["registered"]);
  return next;
}

function atomicJson(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}

export function registerProviderGuard(
  workspaceRoot,
  marker,
  providerProcess,
  owner = null,
  identityKind = "provider",
  binding = null,
  env = process.env
) {
  if (!providerProcess?.pid || !providerProcess?.startToken) return;
  const kind = identityKind === "import" ? "import" : "provider";
  if (!binding) {
    const record = {
      schemaVersion: 1,
      marker: markerName(marker),
      owner: ownerDigest(owner),
      identityKind: kind,
      providerProcess,
      createdAt: new Date().toISOString()
    };
    // Guard publication and stale/exact cleanup share the control-workspace
    // admission lock. This also serializes legacy (unbound) setup/import
    // guards with hasForeignActiveProvider's stale-record cleanup.
    return withWorkspaceStateTransaction(workspaceRoot, () => {
      atomicJson(guardFile(workspaceRoot, marker), record);
      return record;
    }, env);
  }
  if (kind !== "provider" || !completeProviderProcess(providerProcess)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Bound provider guard requires a complete provider identity.");
  }
  const normalized = normalizeProviderGuardBinding(workspaceRoot, marker, binding, env);
  const intentBound = Boolean(normalized.providerSpawnIntentId);
  const writeIntentBound = Object.hasOwn(normalized, "executionBindingDigest");
  const record = {
    schemaVersion: writeIntentBound ? 4 : intentBound ? 3 : 2,
    marker: markerName(marker),
    owner: ownerDigest(owner),
    identityKind: "provider",
    ...(intentBound ? { launcherKind: "node-bootstrap-v1" } : {}),
    providerProcess,
    controlWorkspaceId: normalized.controlWorkspaceId,
    executionRoot: normalized.executionRoot,
    dispatchAttemptId: normalized.dispatchAttemptId,
    dispatchFence: normalized.dispatchFence,
    providerGeneration: normalized.providerGeneration,
    ...(intentBound ? { providerSpawnIntentId: normalized.providerSpawnIntentId } : {}),
    ...(writeIntentBound
      ? { executionBindingDigest: normalized.executionBindingDigest }
      : {}),
    createdAt: new Date().toISOString()
  };
  // Bound provider publication participates in the same workspace lock as
  // recovery cleanup. This closes the guard-appears-during-credential-deletion
  // window without transferring process authority to the guard alone.
  return withWorkspaceStateTransaction(workspaceRoot, (transaction) => {
    const job = transaction.tryReadJob(String(marker));
    const dispatch = job?.request?.spawn?.dispatch;
    const providerSpawnIntent = job?.request?.spawn?.providerSpawnIntent;
    const expectedGeneration = dispatch?.state === "worker-started"
      ? (dispatch.providerGeneration || 0) + 1
      : Number.isSafeInteger(dispatch?.nextProviderGeneration)
        ? dispatch.nextProviderGeneration
        : dispatch?.providerGeneration;
    const rotationIntent = job?.request?.spawn?.providerRotationIntent;
    const jobExecutionBinding = isPlainRecord(job?.executionBinding)
      ? job.executionBinding
      : {};
    const jobSpawn = isPlainRecord(job?.request?.spawn)
      ? job.request.spawn
      : {};
    const hasJobBindingDigest = Object.hasOwn(jobExecutionBinding, "bindingDigest");
    const hasSpawnBindingDigest = Object.hasOwn(jobSpawn, "executionBindingDigest");
    const executionBindingMatches = job?.write === true
      ? (
        intentBound
        && writeIntentBound
        && hasJobBindingDigest
        && hasSpawnBindingDigest
        && SHA256_HEX.test(jobExecutionBinding.bindingDigest || "")
        && jobExecutionBinding.bindingDigest === jobSpawn.executionBindingDigest
        && jobExecutionBinding.bindingDigest === normalized.executionBindingDigest
      )
      : (
        !writeIntentBound
        && !hasJobBindingDigest
        && !hasSpawnBindingDigest
      );
    const rotationIntentMatches = dispatch?.state !== "provider-started" || Boolean(
      rotationIntent?.schemaVersion === 1
      && ["pending", "registered"].includes(rotationIntent.status)
      && rotationIntent.attemptId === dispatch.attemptId
      && rotationIntent.dispatchFence === dispatch.fence
      && rotationIntent.targetProviderGeneration === normalized.providerGeneration
      && rotationIntent.targetProviderGeneration === (
        Number.isSafeInteger(dispatch.nextProviderGeneration)
          ? dispatch.nextProviderGeneration
          : dispatch.providerGeneration
      )
    );
    if (!job
      || job.controlWorkspaceId !== normalized.controlWorkspaceId
      || job.request?.spawn?.executionRoot !== normalized.executionRoot
      || !executionBindingMatches
      || job.request?.spawn?.cleanupFence != null
      || dispatch?.attemptId !== normalized.dispatchAttemptId
      || dispatch?.fence !== normalized.dispatchFence
      || expectedGeneration !== normalized.providerGeneration
      || (intentBound && (
        providerSpawnIntent?.schemaVersion !== 1
        || providerSpawnIntent.intentId !== normalized.providerSpawnIntentId
        || providerSpawnIntent.attemptId !== normalized.dispatchAttemptId
        || providerSpawnIntent.dispatchFence !== normalized.dispatchFence
        || providerSpawnIntent.providerGeneration !== normalized.providerGeneration
        || !["pending", "registered"].includes(providerSpawnIntent.status)
      ))
      || (!intentBound && providerSpawnIntent != null)
      || !rotationIntentMatches
      || ownerDigest(job.host?.sessionId) !== record.owner) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Provider guard no longer matches the durable worker dispatch.");
    }
    let existing;
    try { existing = loadProviderGuard(workspaceRoot, marker); }
    catch {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Existing provider guard aliases are malformed or conflicting."
      );
    }
    if (existing) {
      let authenticated;
      try {
        authenticated = assertProviderGuardForJob(workspaceRoot, job, existing, {
          expectedGeneration: normalized.providerGeneration
        });
      } catch {
        throw new CompanionError(
          "E_PROCESS_IDENTITY",
          "Existing provider guard does not match the durable worker dispatch."
        );
      }
      if (!sameGuardProcessIdentity(authenticated.providerProcess, providerProcess)) {
        throw new CompanionError(
          "E_PROCESS_IDENTITY",
          "A different provider identity already owns this dispatch generation."
        );
      }
      if (intentBound && providerSpawnIntent.status === "pending") {
        const registeredAt = new Date().toISOString();
        transaction.updateJob(String(marker), (latest) => ({
          ...latest,
          request: {
            ...latest.request,
            spawn: {
              ...latest.request.spawn,
              providerSpawnIntent: {
                ...latest.request.spawn.providerSpawnIntent,
                status: "registered",
                registeredAt,
                updatedAt: registeredAt
              }
            }
          }
        }));
      }
      // Exact re-registration is idempotent. Preserve the originally published
      // record (including its creation timestamp) rather than replacing it.
      return authenticated;
    }
    atomicJson(guardFile(workspaceRoot, marker), record);
    try {
      if (!intentBound) return record;
      const registeredAt = new Date().toISOString();
      transaction.updateJob(String(marker), (latest) => {
        const latestIntent = latest.request?.spawn?.providerSpawnIntent;
        if (latest.request?.spawn?.cleanupFence != null
          || latestIntent?.intentId !== normalized.providerSpawnIntentId
          || latestIntent.status !== "pending") {
          throw new CompanionError(
            "E_PROCESS_IDENTITY",
            "Provider spawn authorization changed during guard publication."
          );
        }
        return {
          ...latest,
          request: {
            ...latest.request,
            spawn: {
              ...latest.request.spawn,
              providerSpawnIntent: {
                ...latestIntent,
                status: "registered",
                registeredAt,
                updatedAt: registeredAt
              }
            }
          }
        };
      });
    } catch (error) {
      try { unregisterProviderGuardInWorkspaceTransaction(workspaceRoot, marker, record); }
      catch { /* Preserve the primary authorization failure. */ }
      throw error;
    }
    return record;
  }, env);
}

/**
 * Publish the distinct provider-bootstrap guard used while a write worker is
 * still provisioning its execution worktree. This path is authorized by the
 * fenced provisioning journal and its dedicated durable intent, never by a
 * synthetic worker dispatch.
 */
export function registerWorktreeProvisioningGuard(
  workspaceRoot,
  marker,
  providerProcess,
  owner,
  binding,
  env = process.env
) {
  if (!completeProviderProcess(providerProcess)
    || typeof owner !== "string"
    || !owner
    || owner.length > 256) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Worktree provisioning guard requires a complete provider identity."
    );
  }
  const normalized = normalizeWorktreeProvisioningGuardBinding(
    workspaceRoot,
    marker,
    binding,
    env
  );
  const record = {
    schemaVersion: 5,
    marker: markerName(marker),
    owner: ownerDigest(owner),
    identityKind: "provider",
    launcherKind: "node-bootstrap-v1",
    purpose: WORKTREE_PROVISIONING_PURPOSE,
    providerProcess,
    controlWorkspaceId: normalized.controlWorkspaceId,
    controlRoot: normalized.controlRoot,
    expectedExecutionRoot: normalized.expectedExecutionRoot,
    executionBindingDigest: normalized.executionBindingDigest,
    provisioningAttemptId: normalized.provisioningAttemptId,
    provisioningFence: normalized.provisioningFence,
    holderId: normalized.holderId,
    providerSpawnIntentId: normalized.providerSpawnIntentId,
    createdAt: new Date().toISOString()
  };
  return withWorkspaceStateTransaction(workspaceRoot, (transaction) => {
    const job = transaction.tryReadJob(String(marker));
    if (!job) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    try {
      assertWorktreeProvisioningGuardForJob(workspaceRoot, job, record, {
        expectedBinding: normalized,
        env
      });
    } catch {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Worktree provisioning guard no longer matches its durable fenced authorization."
      );
    }

    let existing;
    try { existing = loadProviderGuard(workspaceRoot, marker); }
    catch {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Existing provider guard aliases are malformed or conflicting."
      );
    }
    if (existing) {
      let authenticated;
      try {
        authenticated = assertWorktreeProvisioningGuardForJob(
          workspaceRoot,
          job,
          existing,
          { expectedBinding: normalized, env }
        );
      } catch {
        throw new CompanionError(
          "E_PROCESS_IDENTITY",
          "Existing worktree provisioning guard does not match the durable authorization."
        );
      }
      if (!sameGuardProcessIdentity(authenticated.providerProcess, providerProcess)) {
        throw new CompanionError(
          "E_PROCESS_IDENTITY",
          "A different provider identity already owns this provisioning attempt."
        );
      }
      if (provisioningRuntimeIntent(job)?.status === "pending") {
        const registeredAt = new Date().toISOString();
        transaction.updateJob(
          String(marker),
          (latest) => registeredProvisioningRuntime(latest, record, registeredAt)
        );
      }
      return authenticated;
    }

    atomicJson(guardFile(workspaceRoot, marker), record);
    try {
      const registeredAt = new Date().toISOString();
      transaction.updateJob(
        String(marker),
        (latest) => registeredProvisioningRuntime(latest, record, registeredAt)
      );
    } catch (error) {
      try { unregisterProviderGuardInWorkspaceTransaction(workspaceRoot, marker, record); }
      catch { /* Preserve the primary authorization failure. */ }
      throw error;
    }
    return record;
  }, env);
}

const WORKER_OWNER_CONTROLLER_GUARD_KEYS = new Set([
  "schemaVersion",
  "marker",
  "owner",
  "identityKind",
  "launcherKind",
  "purpose",
  "providerProcess",
  "binding",
  "createdAt"
]);

function assertWorkerOwnerControllerGuardRecord(
  workspaceRoot,
  marker,
  record,
  expectedBinding,
  env
) {
  const normalized = normalizeWorkerOwnerControllerGuardBinding(
    workspaceRoot,
    marker,
    expectedBinding,
    env
  );
  const valid = exactKeys(record, WORKER_OWNER_CONTROLLER_GUARD_KEYS)
    && record.schemaVersion === 6
    && record.marker === markerName(marker)
    && typeof record.owner === "string"
    && SHA256_HEX.test(record.owner)
    && record.identityKind === "provider"
    && record.launcherKind === "node-owner-controller-v1"
    && record.purpose === normalized.purpose
    && completeProviderProcess(record.providerProcess)
    && exactKeys(
      record.binding,
      normalized.purpose === WORKTREE_INTEGRATION_PURPOSE
        ? WORKTREE_INTEGRATION_BINDING_KEYS
        : WORKTREE_CLEANUP_BINDING_KEYS
    )
    && JSON.stringify(record.binding) === JSON.stringify(normalized)
    && canonicalTimestamp(record.createdAt);
  if (!valid) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Worker owner-controller guard does not match its exact durable activation."
    );
  }
  return record;
}

/**
 * Publish the schema-6 guard for one already-durably-activated, no-model
 * integration or cleanup controller. Unlike provisioning, this authority is
 * never inferred from the worker dispatch/create journal.
 */
export function registerWorkerOwnerControllerGuard(
  workspaceRoot,
  marker,
  providerProcess,
  owner,
  binding,
  env = process.env
) {
  if (!completeProviderProcess(providerProcess)
    || typeof owner !== "string"
    || !owner
    || owner.length > 256) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Worker owner-controller guard requires a complete provider identity."
    );
  }
  const normalized = normalizeWorkerOwnerControllerGuardBinding(
    workspaceRoot,
    marker,
    binding,
    env
  );
  const record = {
    schemaVersion: 6,
    marker: markerName(marker),
    owner: ownerDigest(owner),
    identityKind: "provider",
    launcherKind: "node-owner-controller-v1",
    purpose: normalized.purpose,
    providerProcess,
    binding: normalized,
    createdAt: new Date().toISOString()
  };
  return withWorkspaceStateTransaction(workspaceRoot, () => {
    let existing;
    try { existing = loadProviderGuard(workspaceRoot, marker); }
    catch {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Existing owner-controller guard aliases are malformed or conflicting."
      );
    }
    if (existing) {
      const authenticated = assertWorkerOwnerControllerGuardRecord(
        workspaceRoot,
        marker,
        existing,
        normalized,
        env
      );
      if (authenticated.owner !== record.owner
        || !sameGuardProcessIdentity(
          authenticated.providerProcess,
          providerProcess
        )) {
        throw new CompanionError(
          "E_PROCESS_IDENTITY",
          "A different process or owner already holds this owner-controller activation."
        );
      }
      return authenticated;
    }
    atomicJson(guardFile(workspaceRoot, marker), record);
    return record;
  }, env);
}

function guardChangedBeforeDelete() {
  return new CompanionError(
    "E_PROCESS_IDENTITY",
    "Provider guard changed before compare-and-delete cleanup."
  );
}

/**
 * Compare and remove a provider guard while the caller already owns the
 * control-workspace state transaction. All aliases are preflighted before any
 * unlink, so a conflicting legacy/worktree record cannot cause partial
 * cleanup. Recovery callbacks execute under this lock and must use this
 * explicitly named helper rather than recursively acquiring it.
 */
export function unregisterProviderGuardInWorkspaceTransaction(
  workspaceRoot,
  marker,
  expectedRecord = null
) {
  const existing = [];
  const expected = expectedRecord == null ? null : JSON.stringify(expectedRecord);
  for (const file of guardFiles(workspaceRoot, marker)) {
    try {
      const contents = fs.readFileSync(file, "utf8");
      if (expected !== null) {
        let current;
        try { current = JSON.parse(contents); }
        catch { throw guardChangedBeforeDelete(); }
        if (JSON.stringify(current) !== expected) throw guardChangedBeforeDelete();
      }
      existing.push(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  for (const file of existing) {
    try { fs.unlinkSync(file); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return existing.length > 0;
}

export function unregisterProviderGuard(
  workspaceRoot,
  marker,
  expectedRecord = null,
  env = process.env
) {
  return withWorkspaceStateTransaction(
    workspaceRoot,
    () => unregisterProviderGuardInWorkspaceTransaction(workspaceRoot, marker, expectedRecord),
    env
  );
}

function loadConsistentProviderGuardFiles(files) {
  const records = [];
  for (const file of files) {
    try {
      records.push(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (records.length === 0) return null;
  const canonical = JSON.stringify(records[0]);
  if (records.some((record) => JSON.stringify(record) !== canonical)) {
    throw new Error("Conflicting provider ownership metadata exists for one control workspace.");
  }
  return records[0];
}

export function loadProviderGuard(workspaceRoot, marker) {
  return loadConsistentProviderGuardFiles(guardFiles(workspaceRoot, marker));
}

export function assertProviderGuardForJob(workspaceRoot, job, record, {
  expectedGeneration = null
} = {}) {
  if (record == null) return null;
  const legacyGuardKeys = new Set([
    "schemaVersion",
    "marker",
    "owner",
    "identityKind",
    "providerProcess",
    "controlWorkspaceId",
    "executionRoot",
    "dispatchAttemptId",
    "dispatchFence",
    "providerGeneration",
    "createdAt"
  ]);
  const guardKeys = new Set([
    ...legacyGuardKeys,
    "launcherKind",
    "providerSpawnIntentId"
  ]);
  const writeGuardKeys = new Set([
    ...guardKeys,
    "executionBindingDigest"
  ]);
  const dispatch = job?.request?.spawn?.dispatch;
  let executionControl;
  let callerControl;
  try {
    executionControl = resolveControlWorkspace(record?.executionRoot);
    callerControl = resolveControlWorkspace(workspaceRoot);
  } catch {
    throw new CompanionError("E_PROCESS_IDENTITY", "Provider guard execution workspace is unavailable.");
  }
  const schema2 = record?.schemaVersion === 2 && exactKeys(record, legacyGuardKeys);
  const schema3 = record?.schemaVersion === 3 && exactKeys(record, guardKeys);
  const schema4 = record?.schemaVersion === 4 && exactKeys(record, writeGuardKeys);
  const providerSpawnIntent = job?.request?.spawn?.providerSpawnIntent;
  const intentBoundSchema = schema3 || schema4;
  const jobExecutionBinding = isPlainRecord(job?.executionBinding)
    ? job.executionBinding
    : {};
  const jobSpawn = isPlainRecord(job?.request?.spawn)
    ? job.request.spawn
    : {};
  const hasJobBindingDigest = Object.hasOwn(jobExecutionBinding, "bindingDigest");
  const hasSpawnBindingDigest = Object.hasOwn(jobSpawn, "executionBindingDigest");
  const schemaMatchesWriteMode = job?.write === true
    ? (
      schema4
      && hasJobBindingDigest
      && hasSpawnBindingDigest
      && SHA256_HEX.test(record.executionBindingDigest || "")
      && jobExecutionBinding.bindingDigest === jobSpawn.executionBindingDigest
      && jobExecutionBinding.bindingDigest === record.executionBindingDigest
    )
    : (
      (schema2 || schema3)
      && !hasJobBindingDigest
      && !hasSpawnBindingDigest
    );
  const valid = schemaMatchesWriteMode
    && record.marker === markerName(job?.id)
    && record.owner === ownerDigest(job?.host?.sessionId)
    && record.identityKind === "provider"
    && completeProviderProcess(record.providerProcess)
    && record.controlWorkspaceId === job?.controlWorkspaceId
    && record.executionRoot === job?.request?.spawn?.executionRoot
    && executionControl.executionRoot === record.executionRoot
    && executionControl.controlWorkspaceId === record.controlWorkspaceId
    && callerControl.controlWorkspaceId === record.controlWorkspaceId
    && record.dispatchAttemptId === dispatch?.attemptId
    && record.dispatchFence === dispatch?.fence
    && Number.isSafeInteger(record.providerGeneration)
    && record.providerGeneration > 0
    && (expectedGeneration == null || record.providerGeneration === expectedGeneration)
    && (!intentBoundSchema || (
      record.launcherKind === "node-bootstrap-v1"
      && /^[0-9a-f]{32}$/.test(record.providerSpawnIntentId || "")
      && providerSpawnIntent?.schemaVersion === 1
      && providerSpawnIntent.intentId === record.providerSpawnIntentId
      && providerSpawnIntent.attemptId === record.dispatchAttemptId
      && providerSpawnIntent.dispatchFence === record.dispatchFence
      && providerSpawnIntent.providerGeneration === record.providerGeneration
      && ["pending", "registered"].includes(providerSpawnIntent.status)
    ))
    && (!schema2 || providerSpawnIntent == null)
    && typeof record.createdAt === "string"
    && Number.isFinite(Date.parse(record.createdAt));
  if (!valid) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Provider guard is not bound to the durable worker dispatch.");
  }
  return record;
}

/**
 * Authenticate the schema-5 guard used only for the pre-dispatch worktree
 * provisioning phase. The expected execution root need not exist yet, so its
 * authority comes from the immutable execution binding plus the active fenced
 * provisioning journal.
 */
export function assertWorktreeProvisioningGuardForJob(
  workspaceRoot,
  job,
  record,
  {
    expectedBinding = null,
    env = process.env
  } = {}
) {
  if (record == null) return null;
  const guardKeys = new Set([
    "schemaVersion",
    "marker",
    "owner",
    "identityKind",
    "launcherKind",
    "purpose",
    "providerProcess",
    "controlWorkspaceId",
    "controlRoot",
    "expectedExecutionRoot",
    "executionBindingDigest",
    "provisioningAttemptId",
    "provisioningFence",
    "holderId",
    "providerSpawnIntentId",
    "createdAt"
  ]);
  let callerControl;
  let guardedControl;
  try {
    callerControl = resolveControlWorkspace(workspaceRoot, env);
    guardedControl = resolveControlWorkspace(record?.controlRoot, env);
  } catch {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Worktree provisioning guard control workspace is unavailable."
    );
  }
  const executionBinding = isPlainRecord(job?.executionBinding)
    ? job.executionBinding
    : {};
  const provisioning = isPlainRecord(job?.provisioning)
    ? job.provisioning
    : {};
  const provisioner = isPlainRecord(provisioning.provisioner)
    ? provisioning.provisioner
    : {};
  const expectedMatches = expectedBinding == null || (
    record.purpose === expectedBinding.purpose
    && record.controlWorkspaceId === expectedBinding.controlWorkspaceId
    && record.controlRoot === expectedBinding.controlRoot
    && record.expectedExecutionRoot === expectedBinding.expectedExecutionRoot
    && record.executionBindingDigest === expectedBinding.executionBindingDigest
    && record.provisioningAttemptId === expectedBinding.provisioningAttemptId
    && record.provisioningFence === expectedBinding.provisioningFence
    && record.holderId === expectedBinding.holderId
    && record.providerSpawnIntentId === expectedBinding.providerSpawnIntentId
  );
  const valid = record.schemaVersion === 5
    && exactKeys(record, guardKeys)
    && record.marker === markerName(job?.id)
    && record.owner === ownerDigest(job?.host?.sessionId)
    && record.identityKind === "provider"
    && record.launcherKind === "node-bootstrap-v1"
    && record.purpose === WORKTREE_PROVISIONING_PURPOSE
    && completeProviderProcess(record.providerProcess)
    && job?.write === true
    && job.status === "queued"
    && job.controlWorkspaceId === record.controlWorkspaceId
    && executionBinding.workerId === job?.id
    && executionBinding.controlWorkspaceId === record.controlWorkspaceId
    && executionBinding.controlRoot === record.controlRoot
    && executionBinding.expectedExecutionRoot === record.expectedExecutionRoot
    && executionBinding.bindingDigest === record.executionBindingDigest
    && SHA256_HEX.test(record.executionBindingDigest || "")
    && provisioning.state === "provisioning"
    && provisioning.bindingDigest === record.executionBindingDigest
    && provisioning.attemptId === record.provisioningAttemptId
    && provisioning.fence === record.provisioningFence
    && provisioner.pid === record.providerProcess.pid
    && provisioner.startToken === record.providerProcess.startToken
    && provisioner.holderId === record.holderId
    && worktreeProvisioningIntentMatches(job, record)
    && callerControl.controlWorkspaceId === record.controlWorkspaceId
    && callerControl.controlRoot === record.controlRoot
    && guardedControl.controlWorkspaceId === record.controlWorkspaceId
    && guardedControl.controlRoot === record.controlRoot
    && guardedControl.executionRoot === record.controlRoot
    && typeof record.expectedExecutionRoot === "string"
    && path.isAbsolute(record.expectedExecutionRoot)
    && path.normalize(record.expectedExecutionRoot) === record.expectedExecutionRoot
    && record.expectedExecutionRoot !== record.controlRoot
    && EXACT_NONCE_ID.test(record.provisioningAttemptId || "")
    && Number.isSafeInteger(record.provisioningFence)
    && record.provisioningFence > 0
    && OPAQUE_ID.test(record.holderId || "")
    && EXACT_NONCE_ID.test(record.providerSpawnIntentId || "")
    && expectedMatches
    && typeof record.createdAt === "string"
    && Number.isFinite(Date.parse(record.createdAt));
  if (!valid) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Worktree provisioning guard is not bound to the durable fenced provisioning attempt."
    );
  }
  return record;
}

/** Authenticate the exact worktree-provisioning bootstrap before ACP exists. */
export function authenticateWorktreeProvisioningBootstrapGuard(
  workspaceRoot,
  marker,
  providerProcess,
  binding,
  env = process.env
) {
  const normalized = normalizeWorktreeProvisioningGuardBinding(
    workspaceRoot,
    marker,
    binding,
    env
  );
  return withWorkspaceStateTransaction(workspaceRoot, (transaction) => {
    const job = transaction.tryReadJob(String(marker));
    if (!job) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    const guard = loadProviderGuard(workspaceRoot, marker);
    const authenticated = assertWorktreeProvisioningGuardForJob(
      workspaceRoot,
      job,
      guard,
      { expectedBinding: normalized, env }
    );
    if (!sameGuardProcessIdentity(authenticated?.providerProcess, providerProcess)) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Worktree provisioning bootstrap guard does not match the exact spawned process and intent."
      );
    }
    return authenticated;
  }, env);
}

/** Authenticate the exact schema-6 owner-controller bootstrap and binding. */
export function authenticateWorkerOwnerControllerBootstrapGuard(
  workspaceRoot,
  marker,
  providerProcess,
  binding,
  env = process.env
) {
  const normalized = normalizeWorkerOwnerControllerGuardBinding(
    workspaceRoot,
    marker,
    binding,
    env
  );
  return withWorkspaceStateTransaction(workspaceRoot, () => {
    const guard = loadProviderGuard(workspaceRoot, marker);
    const authenticated = assertWorkerOwnerControllerGuardRecord(
      workspaceRoot,
      marker,
      guard,
      normalized,
      env
    );
    if (!sameGuardProcessIdentity(
      authenticated?.providerProcess,
      providerProcess
    )) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Worker owner-controller guard does not match the exact activated process."
      );
    }
    return authenticated;
  }, env);
}

/** Authenticate the exact bootstrap guard and durable intent under one lock. */
export function authenticateProviderBootstrapGuard(
  workspaceRoot,
  marker,
  providerProcess,
  binding,
  env = process.env
) {
  const normalized = normalizeProviderGuardBinding(workspaceRoot, marker, binding, env);
  return withWorkspaceStateTransaction(workspaceRoot, (transaction) => {
    const job = transaction.tryReadJob(String(marker));
    if (!job) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    const guard = loadProviderGuard(workspaceRoot, marker);
    const authenticated = assertProviderGuardForJob(workspaceRoot, job, guard, {
      expectedGeneration: normalized.providerGeneration
    });
    const expectedSchemaVersion = job.write === true ? 4 : 3;
    if (authenticated?.schemaVersion !== expectedSchemaVersion
      || authenticated.providerSpawnIntentId !== normalized.providerSpawnIntentId
      || authenticated.executionBindingDigest !== normalized.executionBindingDigest
      || !sameGuardProcessIdentity(authenticated.providerProcess, providerProcess)) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Provider bootstrap guard does not match the exact spawned process and intent."
      );
    }
    return authenticated;
  }, env);
}

// Prefer the job-recorded provider identity. During the guard-created /
// providerProcess-missing window, fall back to the authenticated guard record
// while preserving import vs provider identityKind for ownership checks.
export function resolveProviderCleanupTarget(workspaceRoot, job) {
  const guard = loadProviderGuard(workspaceRoot, job.id);
  const dispatch = job?.request?.spawn?.dispatch;
  if (dispatch?.schemaVersion === 2 && guard) {
    const expectedGeneration = Number.isSafeInteger(dispatch.nextProviderGeneration)
      ? dispatch.nextProviderGeneration
      : job.providerProcess?.providerGeneration
        || (dispatch.state === "worker-started" ? (dispatch.providerGeneration || 0) + 1 : null);
    const bound = assertProviderGuardForJob(workspaceRoot, job, guard, { expectedGeneration });
    if (job.providerProcess?.pid
      && !Number.isSafeInteger(dispatch.nextProviderGeneration)
      && !sameGuardProcessIdentity(bound.providerProcess, job.providerProcess)) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Provider guard conflicts with the durable provider generation."
      );
    }
    if (Number.isSafeInteger(dispatch.nextProviderGeneration)
      && !sameGuardProcessIdentity(bound.providerProcess, job.providerProcess)) {
      return { identity: bound.providerProcess, kind: "provider" };
    }
  }
  if (job.providerProcess?.pid) return { identity: job.providerProcess, kind: "provider" };
  if (!guard?.providerProcess?.pid) return { identity: null, kind: "provider" };
  return {
    identity: guard.providerProcess,
    kind: guard.identityKind === "import" ? "import" : "provider"
  };
}

export function hasForeignActiveProvider(
  workspaceRoot,
  owner = null,
  env = process.env
) {
  // The observation and any stale-record deletion are one workspace-locked
  // operation. A provider registration can therefore happen before or after
  // this scan, but cannot replace the record between its liveness check and
  // compare-and-delete cleanup.
  return withWorkspaceStateTransaction(workspaceRoot, () => {
    const files = [];
    for (const directory of workspaceDirectories(workspaceRoot)) {
      try {
        for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith(".json"))) {
          files.push(path.join(directory, name));
        }
      } catch (error) {
        if (error.code !== "ENOENT") return true;
      }
    }
    const filesByMarker = new Map();
    for (const file of new Set(files)) {
      const marker = path.basename(file, ".json");
      const aliases = filesByMarker.get(marker) || [];
      aliases.push(file);
      filesByMarker.set(marker, aliases);
    }
    const expectedOwner = ownerDigest(owner);
    let conflict = false;
    for (const [marker, aliases] of filesByMarker) {
      let record;
      try {
        record = loadConsistentProviderGuardFiles(aliases);
      } catch {
        // Every canonical/legacy/worktree alias for one marker must agree
        // before either ownership admission or stale cleanup is considered.
        // Preserve all records on malformed/conflicting input.
        conflict = true;
        continue;
      }
      if (!record) continue;
      const sameOwner = Boolean(expectedOwner) && record.owner === expectedOwner;
      const kind = record.identityKind === "import" ? "import" : "provider";
      if (!identityMatches(record.providerProcess, record.marker, kind)) {
        if (record.providerProcess?.processGroupId && process.platform !== "win32" && processGroupAlive(record.providerProcess.processGroupId)) {
          conflict = true;
          continue;
        }
        const age = Date.now() - Date.parse(record.createdAt);
        if (sameOwner || Number.isFinite(age) && age > 2 * 60 * 60 * 1000) {
          try {
            unregisterProviderGuardInWorkspaceTransaction(workspaceRoot, marker, record);
          } catch {
            // A conflicting alias or out-of-contract writer makes ownership
            // ambiguous. Fail closed and preserve the replacement record.
            conflict = true;
          }
        } else conflict = true;
        continue;
      }
      if (!sameOwner) conflict = true;
    }
    return conflict;
  }, env);
}
