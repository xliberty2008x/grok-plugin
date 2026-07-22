import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { CompanionError } from "./errors.mjs";
import { identityMatches, processGroupAlive } from "./process-control.mjs";
import { withWorkspaceStateTransaction } from "./state.mjs";
import {
  gitCommonDir,
  listedWorktreeRoots,
  resolveControlWorkspace
} from "./workspace.mjs";

const ROOT = path.join(os.tmpdir(), `grok-companion-guards-${typeof process.getuid === "function" ? process.getuid() : "user"}`);

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
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
  return isPlainRecord(value) && Object.keys(value).every((key) => allowed.has(key));
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
  if (!exactKeys(binding, legacyKeys) && !exactKeys(binding, intentBoundKeys)) {
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
    || !markerName(marker)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Provider guard is not bound to its execution root and dispatch.");
  }
  return Object.freeze({
    ...binding,
    executionRoot,
    providerSpawnIntentId: binding.providerSpawnIntentId || null
  });
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
  const record = {
    schemaVersion: intentBound ? 3 : 2,
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
  const providerSpawnIntent = job?.request?.spawn?.providerSpawnIntent;
  const valid = (schema2 || schema3)
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
    && (!schema3 || (
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
    if (authenticated?.schemaVersion !== 3
      || authenticated.providerSpawnIntentId !== normalized.providerSpawnIntentId
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
