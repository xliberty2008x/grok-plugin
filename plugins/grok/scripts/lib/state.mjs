import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CompanionError } from "./errors.mjs";
import { processIsZombie, processStartToken } from "./process-control.mjs";
import {
  workspaceState,
  assertSafeJobId,
  resolveWorkspaceStateDir,
  resolveAdmissionLockName
} from "./workspace.mjs";
import { pluginDataRoot, sameHostSession } from "./host.mjs";

const JOB_ID_PATTERN = /^(review|adversarial-review|task|stop-review)-[a-f0-9]{16,64}$/;
const JOB_STATUSES = new Set(["queued", "running", "completed", "failed", "cancelled"]);
const JOB_CLASS_BY_KIND = new Map([
  ["task", "task"],
  ["review", "review"],
  ["adversarial-review", "review"],
  ["stop-review", "review"]
]);
const JOB_CLASSES = new Set(JOB_CLASS_BY_KIND.values());
const ACTIVE = new Set(["queued", "running"]);
const LOCK_OWNER_START_TOKEN = processStartToken(process.pid);
const LOCK_CONSTRUCTION_GRACE_MS = 30_000;
const LOCK_TRANSITION_FILE = "transition.json";
const BROKER_RECOVERY_LIMITS = Object.freeze({
  maxStateEntries: 128,
  maxJobEntries: 4_096,
  maxCandidates: 512,
  maxJobBytes: 8 * 1024 * 1024,
  maxTotalJobBytes: 32 * 1024 * 1024
});
export const terminal = (job) => !ACTIVE.has(job?.status);
export const now = () => new Date().toISOString();

function authoritativeJobStateError() {
  return new CompanionError("E_STATE", "Authoritative job state is malformed or unsafe.");
}

function validateAuthoritativeJobCore(record, { expectedId = null } = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw authoritativeJobStateError();
  }
  const idMatch = typeof record.id === "string" ? JOB_ID_PATTERN.exec(record.id) : null;
  const expectedJobClass = JOB_CLASS_BY_KIND.get(record.kind);
  if (![1, 2, 3].includes(record.schemaVersion)
    || !idMatch
    || (expectedId !== null && record.id !== expectedId)
    || expectedJobClass === undefined
    || idMatch[1] !== record.kind
    || typeof record.status !== "string"
    || !JOB_STATUSES.has(record.status)
    || typeof record.createdAt !== "string"
    || record.createdAt.length < 1
    || typeof record.updatedAt !== "string"
    || record.updatedAt.length < 1) {
    throw authoritativeJobStateError();
  }
  if (record.jobClass !== undefined
    && (!JOB_CLASSES.has(record.jobClass) || record.jobClass !== expectedJobClass)) {
    throw authoritativeJobStateError();
  }
  if (record.write !== undefined && typeof record.write !== "boolean") {
    throw authoritativeJobStateError();
  }
  if (record.schemaVersion >= 3
    && (typeof record.jobClass !== "string" || typeof record.write !== "boolean")) {
    throw authoritativeJobStateError();
  }
  // Schema-v1/v2 records may predate the stored discriminator. Consumers must
  // nevertheless see one authoritative class derived from the validated kind;
  // otherwise cleanup and lineage fences can be bypassed by a legacy omission.
  return record.jobClass === expectedJobClass
    ? record
    : { ...record, jobClass: expectedJobClass };
}

function activeJobRequiresExclusiveAdmission(job) {
  if (job.write === true) return true;
  if (job.write === false) return false;
  // Schema-v1/v2 records may predate the write discriminator. An active
  // legacy job is therefore conservatively treated as a workspace writer.
  return ACTIVE.has(job.status);
}

function ensure(root, env = process.env) {
  const base = workspaceState(root, env);
  for (const dir of [base, path.join(base, "jobs"), path.join(base, "locks")]) {
    try { fs.mkdirSync(dir, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new CompanionError("E_STATE", `Refusing unsafe plugin state directory ${dir}.`);
    }
    if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  }
  return base;
}

function readPrivateFile(file, { maxBytes = 8 * 1024 * 1024 } = {}) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes) throw new CompanionError("E_STATE", `Refusing unsafe or oversized plugin state file ${file}.`);
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function atomicPrivateFile(file, contents) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(descriptor, contents);
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(tmp, file);
    if (process.platform !== "win32") {
      let directoryDescriptor;
      try {
        directoryDescriptor = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
        fs.fsyncSync(directoryDescriptor);
      } finally {
        if (directoryDescriptor != null) fs.closeSync(directoryDescriptor);
      }
    }
  } catch (error) {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function atomicJson(file, value) {
  atomicPrivateFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Create a private, non-symlinked directory below the workspace state root. */
export function ensurePrivateStateDirectory(root, segments = [], env = process.env) {
  const parts = Array.isArray(segments) ? segments : [segments];
  let current = ensure(root, env);
  for (const segment of parts) {
    if (typeof segment !== "string" || !/^[A-Za-z0-9._-]+$/.test(segment) || segment === "." || segment === "..") {
      throw new CompanionError("E_USAGE", "Unsafe private state directory segment.");
    }
    current = path.join(current, segment);
    try { fs.mkdirSync(current, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new CompanionError("E_STATE", `Refusing unsafe plugin state directory ${current}.`);
    }
    if ((stat.mode & 0o077) !== 0) fs.chmodSync(current, 0o700);
  }
  return current;
}

/** Read a bounded private JSON file without following a final-component symlink. */
export function readPrivateJsonFile(file, {
  missing = null,
  maxBytes = 8 * 1024 * 1024,
  label = "private state record"
} = {}) {
  try {
    return JSON.parse(readPrivateFile(file, { maxBytes }));
  } catch (error) {
    if (error?.code === "ENOENT") return missing;
    if (error instanceof CompanionError) throw error;
    throw new CompanionError("E_STATE", `Could not read ${label}.`);
  }
}

/** Atomically publish and fsync a mode-0600 JSON file. */
export function writePrivateJsonFile(file, value) {
  atomicJson(file, value);
  return value;
}

function lockDirectoryIdentity(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function sameLockDirectory(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function lockGenerationFingerprint(identity, ownerToken = "ownerless") {
  return crypto
    .createHash("sha256")
    .update(`${identity.dev}:${identity.ino}:${ownerToken ?? "ownerless"}`)
    .digest("hex")
    .slice(0, 24);
}

function inspectLock(lock) {
  let stat;
  try {
    stat = fs.lstatSync(lock);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CompanionError("E_STATE", `Refusing unsafe state lock ${path.basename(lock, ".lock")}.`);
  }
  const identity = lockDirectoryIdentity(stat);
  let owner = null;
  let ownerFingerprint = null;
  let ownerMissing = false;
  try {
    const ownerContents = readPrivateFile(path.join(lock, "owner.json"), { maxBytes: 4096 });
    owner = JSON.parse(ownerContents);
    ownerFingerprint = crypto.createHash("sha256").update(ownerContents).digest("hex");
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    ownerMissing = error?.code === "ENOENT";
    if (!ownerMissing && !(error instanceof SyntaxError)) throw error;
  }
  // A process can die after fsyncing the exclusive owner temp file but before
  // link(2) publishes owner.json. When exactly one complete provisional owner
  // is bound to this lock generation, use its PID/start token for liveness so
  // a proven-dead constructor is recoverable without weakening the grace for
  // genuinely ownerless or ambiguous construction windows.
  if (ownerMissing) {
    let provisionalNames = [];
    try {
      provisionalNames = fs.readdirSync(lock).filter((name) => (
        /^owner\.json\.\d+\.[a-f0-9]{12}\.tmp$/.test(name)
      ));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (provisionalNames.length === 1) {
      const provisionalName = provisionalNames[0];
      const pid = Number(provisionalName.match(/^owner\.json\.(\d+)\./)?.[1]);
      try {
        const ownerContents = readPrivateFile(path.join(lock, provisionalName), { maxBytes: 4096 });
        const provisional = JSON.parse(ownerContents);
        if (provisional?.schemaVersion === 2 && provisional.pid === pid) {
          owner = provisional;
          ownerFingerprint = crypto.createHash("sha256").update(ownerContents).digest("hex");
        }
      } catch (error) {
        if (error instanceof CompanionError) throw error;
        if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
    }
  }
  return {
    identity,
    mtimeMs: stat.mtimeMs,
    owner,
    ownerFingerprint,
    ownerToken: typeof owner?.token === "string" && /^[a-f0-9]{32}$/.test(owner.token) ? owner.token : null,
    ownerDirectory: owner?.directory
      && typeof owner.directory.dev === "string"
      && typeof owner.directory.ino === "string"
      ? owner.directory
      : null
  };
}

function ownerClaimsLockGeneration(snapshot) {
  if (!snapshot?.owner || typeof snapshot.owner !== "object") return false;
  if (snapshot.owner.schemaVersion === 2) {
    return Boolean(snapshot.ownerToken && sameLockDirectory(snapshot.ownerDirectory, snapshot.identity));
  }
  // Version-1 locks predate token/directory binding. Keep them recoverable while
  // never treating an unbound v2 owner as authoritative.
  return Number.isInteger(snapshot.owner.pid) && snapshot.owner.pid > 0;
}

function lockOwnerIsDead(owner) {
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return null;
  if (owner.startToken && process.platform !== "win32") {
    const observedStartToken = processStartToken(owner.pid);
    if (observedStartToken) {
      return observedStartToken !== owner.startToken || processIsZombie(owner.pid);
    }
    // An unavailable `ps` result is not evidence of death. Fall through to the
    // permission-aware signal probe instead of reclaiming a potentially live lock.
  }
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    if (error.code === "EPERM") return false;
    return null;
  }
}

function lockGenerationIsReclaimable(snapshot) {
  const ownerDead = ownerClaimsLockGeneration(snapshot) ? lockOwnerIsDead(snapshot.owner) : null;
  if (ownerDead !== null) return ownerDead;
  return Date.now() - snapshot.mtimeMs >= LOCK_CONSTRUCTION_GRACE_MS;
}

function exclusivePrivateJson(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let descriptor;
  let published = false;
  try {
    descriptor = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    // link(2) is an atomic no-replace publication: observers either see no
    // owner/transition or the complete, fsynced record, never a partial write.
    fs.linkSync(tmp, file);
    published = true;
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
    try { fs.unlinkSync(tmp); } catch {}
  }
  if (published && process.platform !== "win32") {
    let directoryDescriptor;
    try {
      directoryDescriptor = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
      fs.fsyncSync(directoryDescriptor);
    } finally {
      if (directoryDescriptor != null) fs.closeSync(directoryDescriptor);
    }
  }
}

function inspectTransitionFile(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 4096) {
      throw new CompanionError("E_STATE", "Refusing unsafe state-lock transition record.");
    }
    const transition = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    if (transition?.schemaVersion !== 1
      || !["reclaim", "release"].includes(transition.kind)
      || typeof transition.token !== "string"
      || !/^[a-f0-9]{32}$/.test(transition.token)
      || !Number.isInteger(transition.pid)
      || transition.pid <= 0
      || typeof transition.target?.dev !== "string"
      || typeof transition.target?.ino !== "string") {
      throw new CompanionError("E_STATE", "Refusing malformed state-lock transition record.");
    }
    return {
      ...transition,
      identity: lockDirectoryIdentity(stat),
      mtimeMs: stat.mtimeMs
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof CompanionError) throw error;
    throw new CompanionError("E_STATE", "Could not inspect state-lock transition record.");
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function sameTransition(left, right) {
  return Boolean(left
    && right
    && left.token === right.token
    && left.kind === right.kind
    && sameLockDirectory(left.target, right.target)
    && sameLockDirectory(left.identity, right.identity));
}

function transitionIsReclaimable(transition) {
  const ownerDead = lockOwnerIsDead(transition);
  if (ownerDead !== null) return ownerDead;
  return Date.now() - transition.mtimeMs >= LOCK_CONSTRUCTION_GRACE_MS;
}

/**
 * Remove a transition whose owning process is gone. The hard-link witness pins
 * the exact transition inode while it is unlinked, so a delayed clearer cannot
 * remove a newly published transition with the same pathname.
 */
function clearAbandonedTransition(lock, expected) {
  if (!expected || !transitionIsReclaimable(expected)) return false;
  const transitionFile = path.join(lock, LOCK_TRANSITION_FILE);
  const witness = path.join(lock, `.transition-stale-${expected.token}`);
  try {
    fs.linkSync(transitionFile, witness);
  } catch (error) {
    if (["EEXIST", "ENOENT"].includes(error.code)) return false;
    throw error;
  }
  try {
    const pinned = inspectTransitionFile(witness);
    const current = inspectTransitionFile(transitionFile);
    if (!sameTransition(pinned, expected)
      || !sameTransition(current, expected)
      || !transitionIsReclaimable(pinned)) return false;
    fs.unlinkSync(transitionFile);
    return true;
  } finally {
    try { fs.unlinkSync(witness); } catch {}
  }
}

function sameOwnerGeneration(snapshot, expectedToken, { allowMissingOwner = false } = {}) {
  if (!snapshot) return false;
  if (snapshot.ownerToken === expectedToken && sameLockDirectory(snapshot.ownerDirectory, snapshot.identity)) return true;
  return allowMissingOwner && snapshot.owner == null;
}

function removeOwnedTransition(lock, generation, transitionToken) {
  const transitionFile = path.join(lock, LOCK_TRANSITION_FILE);
  try {
    const transition = inspectTransitionFile(transitionFile);
    if (!transition
      || transition.token !== transitionToken
      || !sameLockDirectory(transition.target, generation.identity)) return;
    fs.unlinkSync(transitionFile);
  } catch (error) {
    if (error?.code !== "ENOENT") return;
  }
}

function ownsLockTransition(lock, generation, transition) {
  const current = inspectLock(lock);
  const claimed = inspectTransitionFile(path.join(lock, LOCK_TRANSITION_FILE));
  return Boolean(current
    && sameLockDirectory(current.identity, generation.identity)
    && claimed
    && claimed.token === transition.token
    && claimed.kind === transition.kind
    && sameLockDirectory(claimed.target, generation.identity)
    && (!transition.identity || sameLockDirectory(claimed.identity, transition.identity)));
}

function claimLockTransition(lock, generation, kind) {
  const token = crypto.randomBytes(16).toString("hex");
  const transition = {
    schemaVersion: 1,
    kind,
    token,
    pid: process.pid,
    startToken: LOCK_OWNER_START_TOKEN,
    target: generation.identity
  };
  const transitionFile = path.join(lock, LOCK_TRANSITION_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = inspectLock(lock);
    if (!current || !sameLockDirectory(current.identity, generation.identity)) return null;
    try {
      exclusivePrivateJson(transitionFile, transition);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      if (error.code !== "EEXIST") throw error;
      const existing = inspectTransitionFile(transitionFile);
      if (attempt === 0 && existing && clearAbandonedTransition(lock, existing)) continue;
      return null;
    }
    const claimed = inspectTransitionFile(transitionFile);
    if (claimed && ownsLockTransition(lock, generation, claimed)) return claimed;
    removeOwnedTransition(lock, generation, transition.token);
    return null;
  }
  return null;
}

/**
 * Freeze and detach one stale generation. The owner token/inode fingerprint is
 * useful for auditability; the transition token makes the witness collision-free
 * even when a filesystem later reuses an inode.
 */
function reclaimLockGeneration(lock, generation) {
  const transition = claimLockTransition(lock, generation, "reclaim");
  if (!transition) return false;
  let renamed = false;
  try {
    const current = inspectLock(lock);
    if (!current
      || !sameLockDirectory(current.identity, generation.identity)
      || current.ownerFingerprint !== generation.ownerFingerprint
      // Creating transition.json updates the directory mtime. Re-evaluate the
      // frozen pre-claim snapshot after proving its owner record did not change.
      || !lockGenerationIsReclaimable(generation)
      || !ownsLockTransition(lock, generation, transition)) return false;

    const fingerprint = lockGenerationFingerprint(generation.identity, generation.ownerToken);
    const retired = `${lock}.stale-${fingerprint}-${transition.token}`;
    fs.renameSync(lock, retired);
    renamed = true;
    const frozen = inspectLock(retired);
    const frozenTransition = inspectTransitionFile(path.join(retired, LOCK_TRANSITION_FILE));
    if (!frozen
      || !sameLockDirectory(frozen.identity, generation.identity)
      || frozen.ownerFingerprint !== generation.ownerFingerprint
      || !sameTransition(frozenTransition, transition)) {
      throw new CompanionError("E_STATE", "Lost stale state-lock generation while freezing it.");
    }
    return true;
  } catch (error) {
    if (["EEXIST", "ENOTEMPTY", "ENOENT"].includes(error.code)) return false;
    throw error;
  } finally {
    if (!renamed) removeOwnedTransition(lock, generation, transition.token);
  }
}

function releaseLockGeneration(lock, generation, { allowMissingOwner = false } = {}) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const current = inspectLock(lock);
    if (!current || !sameLockDirectory(current.identity, generation.identity)) return;
    if (!sameOwnerGeneration(current, generation.ownerToken, { allowMissingOwner })) return;

    const transition = claimLockTransition(lock, generation, "release");
    if (!transition) {
      if (Date.now() >= deadline) {
        throw new CompanionError("E_STATE", "Timed out releasing an owned state lock.");
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      continue;
    }

    const claimed = inspectLock(lock);
    if (!claimed
      || !sameLockDirectory(claimed.identity, generation.identity)
      || !sameOwnerGeneration(claimed, generation.ownerToken, { allowMissingOwner })
      || !ownsLockTransition(lock, generation, transition)) {
      removeOwnedTransition(lock, generation, transition.token);
      return;
    }

    const retired = `${lock}.release-${lockGenerationFingerprint(generation.identity, generation.ownerToken)}-${transition.token}`;
    try {
      fs.renameSync(lock, retired);
      const released = inspectLock(retired);
      const releasedTransition = inspectTransitionFile(path.join(retired, LOCK_TRANSITION_FILE));
      if (!released
        || !sameLockDirectory(released.identity, generation.identity)
        || !sameOwnerGeneration(released, generation.ownerToken, { allowMissingOwner })
        || !sameTransition(releasedTransition, transition)) {
        throw new CompanionError("E_STATE", "Lost owned state-lock generation while releasing it.");
      }
      fs.rmSync(retired, { recursive: true, force: true });
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "ENOENT"].includes(error.code)) throw error;
      removeOwnedTransition(lock, generation, transition.token);
    }
    return;
  }
}

function withLock(root, name, action, env = process.env) {
  const base = ensure(root, env), lock = path.join(base, "locks", `${name}.lock`), deadline = Date.now() + 5000;
  let generation = null;
  for (;;) {
    try {
      const ownerToken = crypto.randomBytes(16).toString("hex");
      fs.mkdirSync(lock, { mode: 0o700 });
      const stat = fs.lstatSync(lock);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CompanionError("E_STATE", `Refusing unsafe state lock ${name}.`);
      generation = { identity: lockDirectoryIdentity(stat), ownerToken };
      try {
        exclusivePrivateJson(path.join(lock, "owner.json"), {
          schemaVersion: 2,
          token: ownerToken,
          pid: process.pid,
          startToken: LOCK_OWNER_START_TOKEN,
          directory: generation.identity
        });
        const published = inspectLock(lock);
        if (!published
          || !sameLockDirectory(published.identity, generation.identity)
          || published.ownerToken !== ownerToken
          || !sameLockDirectory(published.ownerDirectory, generation.identity)
          || fs.existsSync(path.join(lock, LOCK_TRANSITION_FILE))) {
          throw new CompanionError("E_STATE", `Lost state lock ${name} while publishing its owner.`);
        }
      } catch (error) {
        releaseLockGeneration(lock, generation, { allowMissingOwner: true });
        throw error;
      }
      break;
    }
    catch (error) {
      if (error.code !== "EEXIST") throw new CompanionError("E_STATE", `Could not acquire state lock ${name}.`);
      try {
        const existing = inspectLock(lock);
        if (!existing) continue;
        if (lockGenerationIsReclaimable(existing) && reclaimLockGeneration(lock, existing)) continue;
      } catch (inspectError) {
        if (inspectError?.code === "ENOENT") continue;
        if (inspectError instanceof CompanionError) throw inspectError;
        throw new CompanionError("E_STATE", `Could not inspect state lock ${name}.`);
      }
      if (Date.now() >= deadline) throw new CompanionError("E_STATE", `Timed out acquiring state lock ${name}.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return action(); } finally { releaseLockGeneration(lock, generation); }
}

/** Serialize host-side verification reconciliation with workspace job admission.
 * Lock name is control-workspace scoped so linked worktrees share one admission gate.
 */
export function withWorkspaceAdmission(root, action, env = process.env) {
  return withLock(root, resolveAdmissionLockName(root, env), action, env);
}

/**
 * Run a synchronous workspace-scoped state transaction.
 *
 * The transaction owns the same control-workspace admission lock used by job
 * admission. Callers may therefore combine admission with adjacent durable
 * metadata (for example an idempotency record) without a check-then-act race.
 * Job updates still take their per-job lock, preserving the established lock
 * order (workspace admission -> job) used by reconciliation paths.
 */
export function withWorkspaceStateTransaction(root, action, env = process.env) {
  if (typeof action !== "function") {
    throw new CompanionError("E_USAGE", "Workspace state transaction requires an action.");
  }
  return withLock(root, resolveAdmissionLockName(root, env), () => action(Object.freeze({
    admitJob(job) {
      return admitJobUnlocked(root, job, env);
    },
    readJob(id) {
      return readJob(root, id, env);
    },
    tryReadJob(id) {
      return tryReadJobStrict(root, id, env);
    },
    listJobs() {
      return listJobs(root, env);
    },
    updateJob(id, mutator) {
      return updateJob(root, id, mutator, env);
    }
  })), env);
}

export function config(root, env = process.env) {
  const file = path.join(ensure(root, env), "config.json");
  try { return JSON.parse(readPrivateFile(file)); } catch (e) { if (e.code === "ENOENT") return { schemaVersion: 1, stopReviewGate: false, disclosureAccepted: false }; if (e instanceof CompanionError) throw e; throw new CompanionError("E_STATE", "Could not read plugin configuration."); }
}

export function setConfig(root, patch, env = process.env) {
  return withLock(root, "config", () => {
    const next = { ...config(root, env), ...patch, schemaVersion: 1 };
    atomicJson(path.join(ensure(root, env), "config.json"), next);
    return next;
  }, env);
}

export function generateId(kind) { return `${kind}-${crypto.randomBytes(12).toString("hex")}`; }

export function jobFile(root, id, env = process.env) { return path.join(ensure(root, env), "jobs", `${assertSafeJobId(id)}.json`); }
export function cancelFile(root, id, env = process.env) { return path.join(ensure(root, env), "jobs", `${assertSafeJobId(id)}.cancel`); }
export function logFile(root, id, env = process.env) { return path.join(ensure(root, env), "jobs", `${assertSafeJobId(id)}.log`); }

/**
 * Side-effect-free job path resolution. Does not create state directories.
 * Returns null when the workspace state root is absent or the id is unsafe.
 */
export function jobFileIfPresent(root, id, env = process.env) {
  if (!JOB_ID_PATTERN.test(String(id ?? ""))) return null;
  const base = resolveWorkspaceStateDir(root, env);
  if (!base) return null;
  const jobs = path.join(base, "jobs");
  try {
    const stat = fs.lstatSync(jobs);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(jobs) !== jobs) return null;
  } catch {
    return null;
  }
  return path.join(jobs, `${id}.json`);
}

function jobIdFromJsonFileName(name) {
  if (typeof name !== "string" || !name.endsWith(".json")) return null;
  const id = name.slice(0, -5);
  return JOB_ID_PATTERN.test(id) ? id : null;
}

function readAuthoritativeJobFile(file, expectedId) {
  try {
    const record = JSON.parse(readPrivateFile(file));
    return validateAuthoritativeJobCore(record, { expectedId });
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    throw authoritativeJobStateError();
  }
}

function tryReadJobStrict(root, id, env = process.env) {
  try {
    const file = jobFile(root, id, env);
    return readAuthoritativeJobFile(file, id);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof CompanionError && error.code === "E_USAGE") throw error;
    throw authoritativeJobStateError();
  }
}

/**
 * Read a job record without ensure(), recovery, or directory creation.
 * Missing/unreadable/unsafe ids all return null so callers can unify not-found.
 */
export function tryReadJob(root, id, env = process.env) {
  const file = jobFileIfPresent(root, id, env);
  if (!file) return null;
  try {
    return readAuthoritativeJobFile(file, id);
  } catch {
    return null;
  }
}

/**
 * List job records without ensure(), recovery, or directory creation.
 * Absent state directories yield an empty list rather than creating storage.
 */
export function listJobsReadonly(root, env = process.env) {
  const base = resolveWorkspaceStateDir(root, env);
  if (!base) return [];
  const dir = path.join(base, "jobs");
  let names;
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== dir) return [];
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    return [];
  }
  return names
    .filter((name) => jobIdFromJsonFileName(name) !== null)
    .flatMap((name) => {
      try {
        return [readAuthoritativeJobFile(path.join(dir, name), jobIdFromJsonFileName(name))];
      } catch {
        return [];
      }
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function exactRecoveryLimit(value, key) {
  const hardMaximum = BROKER_RECOVERY_LIMITS[key];
  if (value == null) return hardMaximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > hardMaximum) {
    throw new CompanionError("E_USAGE", `Invalid broker recovery scan limit ${key}.`);
  }
  return value;
}

function privateRecoveryDirectory(directory) {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory()
      || stat.isSymbolicLink()
      || (stat.mode & 0o077) !== 0
      || fs.realpathSync(directory) !== directory
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return null;
    return stat;
  } catch {
    return null;
  }
}

function boundedDirectoryEntries(directory, budget, label) {
  const handle = fs.opendirSync(directory);
  const entries = [];
  try {
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      if (entries.length >= budget) {
        throw new CompanionError("E_STATE", `Broker recovery ${label} exceeded its bounded scan budget.`);
      }
      entries.push(entry);
    }
  } finally {
    handle.closeSync();
  }
  return entries;
}

function readBrokerRecoveryJobBytes(file, maxJobBytes) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()
      || before.nlink !== 1
      || before.size < 1
      || before.size > maxJobBytes
      || (before.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && before.uid !== process.getuid())) {
      throw authoritativeJobStateError();
    }
    const pathStat = fs.lstatSync(file);
    if (pathStat.isSymbolicLink()
      || !pathStat.isFile()
      || pathStat.dev !== before.dev
      || pathStat.ino !== before.ino
      || fs.realpathSync(file) !== file) {
      throw authoritativeJobStateError();
    }
    const contents = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < contents.length) {
      const count = fs.readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (offset !== contents.length
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs) {
      throw authoritativeJobStateError();
    }
    return {
      contents,
      size: contents.length
    };
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    throw authoritativeJobStateError();
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

/**
 * Bounded, read-only discovery for autonomous broker startup recovery.
 *
 * Only the fixed plugin-data/state/<control>/jobs depth is inspected. Unsafe
 * entries are ignored; exceeding any global budget rejects the entire scan so
 * directory ordering can never decide which queued job receives authority.
 */
export function listBrokerRecoveryCandidates({
  env = process.env,
  limits = null
} = {}) {
  const configured = {
    maxStateEntries: exactRecoveryLimit(limits?.maxStateEntries, "maxStateEntries"),
    maxJobEntries: exactRecoveryLimit(limits?.maxJobEntries, "maxJobEntries"),
    maxCandidates: exactRecoveryLimit(limits?.maxCandidates, "maxCandidates"),
    maxJobBytes: exactRecoveryLimit(limits?.maxJobBytes, "maxJobBytes"),
    maxTotalJobBytes: exactRecoveryLimit(limits?.maxTotalJobBytes, "maxTotalJobBytes")
  };
  let configuredDataRoot;
  let dataRoot;
  try {
    configuredDataRoot = path.resolve(pluginDataRoot(env));
    const configuredStat = fs.lstatSync(configuredDataRoot);
    if (!configuredStat.isDirectory()
      || configuredStat.isSymbolicLink()
      || (configuredStat.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && configuredStat.uid !== process.getuid())) return [];
    dataRoot = fs.realpathSync(configuredDataRoot);
  } catch {
    return [];
  }
  if (!privateRecoveryDirectory(dataRoot)) return [];
  const stateParent = path.join(dataRoot, "state");
  if (!privateRecoveryDirectory(stateParent)) return [];
  const stateEntries = boundedDirectoryEntries(
    stateParent,
    configured.maxStateEntries,
    "state directory"
  );
  const candidates = [];
  let jobEntryCount = 0;
  let totalJobBytes = 0;
  for (const stateEntry of stateEntries) {
    if (!/^control-[a-f0-9]{16}$/.test(stateEntry.name) || !stateEntry.isDirectory()) continue;
    const stateDirectory = path.join(stateParent, stateEntry.name);
    if (!privateRecoveryDirectory(stateDirectory)) continue;
    const jobsDirectory = path.join(stateDirectory, "jobs");
    if (!privateRecoveryDirectory(jobsDirectory)) continue;
    const remainingEntries = configured.maxJobEntries - jobEntryCount;
    if (remainingEntries < 1) {
      throw new CompanionError("E_STATE", "Broker recovery job directories exceeded their bounded scan budget.");
    }
    const entries = boundedDirectoryEntries(jobsDirectory, remainingEntries, "job directory");
    jobEntryCount += entries.length;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const expectedId = jobIdFromJsonFileName(entry.name);
      if (!expectedId || !expectedId.startsWith("task-")) continue;
      const file = path.join(jobsDirectory, entry.name);
      let loaded;
      try {
        loaded = readBrokerRecoveryJobBytes(file, configured.maxJobBytes);
      } catch {
        continue;
      }
      totalJobBytes += loaded.size;
      if (totalJobBytes > configured.maxTotalJobBytes) {
        throw new CompanionError("E_STATE", "Broker recovery job data exceeded its bounded byte budget.");
      }
      let job;
      try {
        job = validateAuthoritativeJobCore(
          JSON.parse(loaded.contents.toString("utf8")),
          { expectedId }
        );
      } catch {
        continue;
      }
      if (candidates.length >= configured.maxCandidates) {
        throw new CompanionError("E_STATE", "Broker recovery candidates exceeded their bounded result budget.");
      }
      candidates.push(Object.freeze({
        stateSegment: stateEntry.name,
        stateDirectory,
        jobsDirectory,
        file,
        job
      }));
    }
  }
  return Object.freeze(candidates.sort((left, right) => (
    left.stateSegment.localeCompare(right.stateSegment)
    || String(left.job.createdAt).localeCompare(String(right.job.createdAt))
    || left.job.id.localeCompare(right.job.id)
  )));
}

export function readJob(root, id, env = process.env) {
  const record = tryReadJobStrict(root, id, env);
  if (!record) throw new CompanionError("E_JOB_NOT_FOUND", `Job ${id} was not found in this repository.`);
  return record;
}

export function writeJob(root, job, env = process.env) {
  job = validateAuthoritativeJobCore(job, { expectedId: job?.id ?? null });
  return withLock(root, job.id, () => {
    job.updatedAt = now();
    job = validateAuthoritativeJobCore(job, { expectedId: job.id });
    atomicJson(jobFile(root, job.id, env), job);
    return job;
  }, env);
}

/**
 * Atomically admit a new job while enforcing one workspace writer at a time.
 * Independent read-only lineages may overlap, but continuations sharing one
 * providerHomeId may not: they share transient auth/profile paths and one Grok
 * session store. A writer requires an otherwise idle workspace.
 */
export function admitJob(root, job, env = process.env) {
  // Control-workspace admission lock — shared by all linked worktrees of one repo.
  return withWorkspaceStateTransaction(root, (transaction) => transaction.admitJob(job), env);
}

/** Admission primitive for callers already holding workspace admission. */
function admitJobUnlocked(root, job, env = process.env) {
  job = validateAuthoritativeJobCore(job, { expectedId: job?.id ?? null });
  const requestedLineage = job.jobClass === "task" ? job.request?.providerHomeId || null : null;
  const requestedExclusive = activeJobRequiresExclusiveAdmission(job);
  const conflict = listJobs(root, env).find((candidate) => {
    const candidateLineage = candidate.jobClass === "task" ? candidate.request?.providerHomeId || null : null;
    if (terminal(candidate)) {
      // A terminal task can still own transient credentials/profile files. Do
      // not admit a continuation that would share and race that cleanup.
      return Boolean(
        requestedLineage
        && candidateLineage === requestedLineage
        && candidate.result?.taskRuntimeCleaned !== true
      );
    }
    if (requestedExclusive || activeJobRequiresExclusiveAdmission(candidate)) return true;
    return Boolean(requestedLineage && candidateLineage === requestedLineage);
  });
  if (conflict) {
    const conflictingLineage = requestedLineage && conflict.request?.providerHomeId === requestedLineage;
    throw new CompanionError(
      "E_JOB_ACTIVE",
      conflictingLineage
        ? `Provider lineage ${requestedLineage} already has active job ${conflict.id}; wait or cancel it before continuing that Grok session.`
        : `Workspace job ${conflict.id} is still ${conflict.status}; wait or cancel it before starting ${requestedExclusive ? "a write job" : "read-only work"}.`,
      {
        conflictingJobId: conflict.id,
        conflictingStatus: conflict.status,
        conflictingWrite: activeJobRequiresExclusiveAdmission(conflict),
        conflictingProviderHomeId: conflictingLineage ? requestedLineage : null
      }
    );
  }
  job.updatedAt = now();
  job = validateAuthoritativeJobCore(job, { expectedId: job.id });
  atomicJson(jobFile(root, job.id, env), job);
  return job;
}

export function updateJob(root, id, mutator, env = process.env) {
  assertSafeJobId(id);
  return withLock(root, id, () => {
    const job = readJob(root, id, env);
    let next = mutator({ ...job }) || job;
    next = validateAuthoritativeJobCore(next, { expectedId: id });
    next.updatedAt = now();
    next = validateAuthoritativeJobCore(next, { expectedId: id });
    atomicJson(jobFile(root, id, env), next);
    return next;
  }, env);
}

export function listJobs(root, env = process.env) {
  let dir;
  let names;
  try {
    dir = path.join(ensure(root, env), "jobs");
    names = fs.readdirSync(dir);
  } catch {
    throw authoritativeJobStateError();
  }
  const jobs = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const expectedId = jobIdFromJsonFileName(name);
    if (!expectedId) throw authoritativeJobStateError();
    try {
      jobs.push(readAuthoritativeJobFile(path.join(dir, name), expectedId));
    } catch {
      throw authoritativeJobStateError();
    }
  }
  return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function retain(root, limit = 50, env = process.env) {
  return withWorkspaceStateTransaction(root, (transaction) => {
    // Keep review jobs whose isolated homes were not cleaned, except explicit empty-target skips
    // (no provider session or home was ever created for those).
    const needsPrivacyRetention = (job) => (
      job.jobClass === "review"
        ? job.result?.providerSessionDeleted === false && job.result?.skipReason !== "empty-target"
        : job.jobClass === "task" && job.result?.taskRuntimeCleaned === false
    );
    const jobs = transaction.listJobs();
    const activeJobs = jobs.filter((job) => !terminal(job));
    const privacyRetained = jobs.filter((job) => terminal(job) && needsPrivacyRetention(job));
    const ordinaryTerminal = jobs.filter((job) => terminal(job) && !needsPrivacyRetention(job));
    const retained = new Set([
      ...activeJobs.map((job) => job.id),
      ...privacyRetained.map((job) => job.id),
      ...ordinaryTerminal
        .slice(0, Math.max(0, limit - activeJobs.length))
        .map((job) => job.id)
    ]);
    const jobsById = new Map(jobs.map((job) => [job.id, job]));
    const pending = [...retained];
    while (pending.length > 0) {
      const retainedJob = jobsById.get(pending.pop());
      const parentId = retainedJob?.request?.resumeJobId;
      if (typeof parentId !== "string" || retained.has(parentId) || !jobsById.has(parentId)) {
        continue;
      }
      retained.add(parentId);
      pending.push(parentId);
    }
    const removable = ordinaryTerminal.filter((job) => !retained.has(job.id));
    for (const job of removable) {
      for (const file of [jobFile(root, job.id, env), logFile(root, job.id, env), cancelFile(root, job.id, env)]) {
        try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    }
  }, env);
}

export function selectJob(root, { id, host, claudeSessionId, active, finished, allSessions = false } = {}) {
  if (id) return readJob(root, id);
  const selectedHost = host || (claudeSessionId ? { kind: "claude-code", sessionId: claudeSessionId } : null);
  if (!allSessions && !selectedHost?.sessionId) {
    throw new CompanionError("E_JOB_NOT_FOUND", "Current host session identity is unavailable; provide an explicit job ID instead of using implicit selection.");
  }
  const match = listJobs(root).filter((job) => (allSessions || sameHostSession(job, selectedHost)) && (!active || ACTIVE.has(job.status)) && (!finished || terminal(job)));
  if (!match.length) throw new CompanionError("E_JOB_NOT_FOUND", "No matching Grok job was found in this host session.");
  return match[0];
}

export function requestCancel(root, id, nonce, env = process.env) {
  if (typeof nonce !== "string" || nonce.length < 1 || nonce.length > 256 || /[\r\n]/.test(nonce)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Refusing to create a cancellation marker without the active worker nonce.");
  }
  const file = cancelFile(root, id, env);
  // Publish only a fully written marker. Creating/truncating the destination
  // first lets another process observe an empty nonce between open and write,
  // which can lose a launch-window cancellation on slower runtimes.
  atomicPrivateFile(file, `${nonce}\n`);
}

export function isCancelRequested(root, id, expectedNonce, env = process.env) {
  if (typeof expectedNonce !== "string" || expectedNonce.length < 1 || expectedNonce.length > 256 || /[\r\n]/.test(expectedNonce)) return false;
  let actual;
  try { actual = readPrivateFile(cancelFile(root, id, env), { maxBytes: 1024 }).trim(); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  const left = Buffer.from(actual);
  const right = Buffer.from(expectedNonce);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function appendJobLog(root, id, line, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const file = logFile(root, id);
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new CompanionError("E_STATE", `Refusing unsafe job log ${file}.`);
    if (stat.size >= maxBytes) return false;
    fs.writeFileSync(descriptor, line);
    fs.fchmodSync(descriptor, 0o600);
    return true;
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

export function removeJob(root, id) {
  for (const file of [jobFile(root, id), logFile(root, id), cancelFile(root, id)]) {
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
