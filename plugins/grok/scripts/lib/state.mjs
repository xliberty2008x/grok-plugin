import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CompanionError } from "./errors.mjs";
import { processIsZombie, processStartToken } from "./process-control.mjs";
import { workspaceState, assertSafeJobId } from "./workspace.mjs";
import { sameHostSession } from "./host.mjs";

const ACTIVE = new Set(["queued", "running"]);
const LOCK_OWNER_START_TOKEN = processStartToken(process.pid);
export const terminal = (job) => !ACTIVE.has(job?.status);
export const now = () => new Date().toISOString();

function ensure(root) {
  const base = workspaceState(root);
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

function withLock(root, name, action) {
  const base = ensure(root), lock = path.join(base, "locks", `${name}.lock`), deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      try {
        fs.writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, startToken: LOCK_OWNER_START_TOKEN })}\n`, { mode: 0o600, flag: "wx" });
      } catch (error) {
        fs.rmSync(lock, { recursive: true, force: true });
        throw error;
      }
      break;
    }
    catch (error) {
      if (error.code !== "EEXIST") throw new CompanionError("E_STATE", `Could not acquire state lock ${name}.`);
      let lockStat;
      try { lockStat = fs.lstatSync(lock); }
      catch (statError) {
        if (statError.code === "ENOENT") continue;
        throw new CompanionError("E_STATE", `Could not inspect state lock ${name}.`);
      }
      if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
        throw new CompanionError("E_STATE", `Refusing unsafe state lock ${name}.`);
      }
      let reclaim = false;
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"));
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) reclaim = true;
        else if (owner.startToken && process.platform !== "win32") reclaim = processStartToken(owner.pid) !== owner.startToken || processIsZombie(owner.pid);
        else {
          try { process.kill(owner.pid, 0); }
          catch (signalError) { reclaim = signalError.code === "ESRCH"; }
        }
      } catch {
        try { reclaim = Date.now() - fs.statSync(lock).mtimeMs > 250; } catch { reclaim = true; }
      }
      if (reclaim) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
      if (Date.now() >= deadline) throw new CompanionError("E_STATE", `Timed out acquiring state lock ${name}.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return action(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

/** Serialize host-side verification reconciliation with workspace job admission. */
export function withWorkspaceAdmission(root, action) {
  return withLock(root, "workspace-admission", action);
}

export function config(root) {
  const file = path.join(ensure(root), "config.json");
  try { return JSON.parse(readPrivateFile(file)); } catch (e) { if (e.code === "ENOENT") return { schemaVersion: 1, stopReviewGate: false, disclosureAccepted: false }; if (e instanceof CompanionError) throw e; throw new CompanionError("E_STATE", "Could not read plugin configuration."); }
}

export function setConfig(root, patch) { return withLock(root, "config", () => { const next = { ...config(root), ...patch, schemaVersion: 1 }; atomicJson(path.join(ensure(root), "config.json"), next); return next; }); }

export function generateId(kind) { return `${kind}-${crypto.randomBytes(12).toString("hex")}`; }

export function jobFile(root, id) { return path.join(ensure(root), "jobs", `${assertSafeJobId(id)}.json`); }
export function cancelFile(root, id) { return path.join(ensure(root), "jobs", `${assertSafeJobId(id)}.cancel`); }
export function logFile(root, id) { return path.join(ensure(root), "jobs", `${assertSafeJobId(id)}.log`); }

export function readJob(root, id) {
  const file = jobFile(root, id);
  try { return JSON.parse(readPrivateFile(file)); }
  catch (e) { if (e.code === "ENOENT") throw new CompanionError("E_JOB_NOT_FOUND", `Job ${id} was not found in this repository.`); throw new CompanionError("E_STATE", `Could not read job ${id}.`); }
}

export function writeJob(root, job) { return withLock(root, job.id, () => { job.updatedAt = now(); atomicJson(jobFile(root, job.id), job); return job; }); }

/**
 * Atomically admit a new job while enforcing one workspace writer at a time.
 * Independent read-only lineages may overlap, but continuations sharing one
 * providerHomeId may not: they share transient auth/profile paths and one Grok
 * session store. A writer requires an otherwise idle workspace.
 */
export function admitJob(root, job) {
  return withLock(root, "workspace-admission", () => {
    const requestedLineage = job.jobClass === "task" ? job.request?.providerHomeId || null : null;
    const conflict = listJobs(root).find((candidate) => {
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
      if (job.write || candidate.write) return true;
      return Boolean(requestedLineage && candidateLineage === requestedLineage);
    });
    if (conflict) {
      const conflictingLineage = requestedLineage && conflict.request?.providerHomeId === requestedLineage;
      throw new CompanionError(
        "E_JOB_ACTIVE",
        conflictingLineage
          ? `Provider lineage ${requestedLineage} already has active job ${conflict.id}; wait or cancel it before continuing that Grok session.`
          : `Workspace job ${conflict.id} is still ${conflict.status}; wait or cancel it before starting ${job.write ? "a write job" : "read-only work"}.`,
        {
          conflictingJobId: conflict.id,
          conflictingStatus: conflict.status,
          conflictingWrite: Boolean(conflict.write),
          conflictingProviderHomeId: conflictingLineage ? requestedLineage : null
        }
      );
    }
    job.updatedAt = now();
    atomicJson(jobFile(root, job.id), job);
    return job;
  });
}

export function updateJob(root, id, mutator) { assertSafeJobId(id); return withLock(root, id, () => { const job = readJob(root, id); const next = mutator({ ...job }) || job; next.updatedAt = now(); atomicJson(jobFile(root, id), next); return next; }); }

export function listJobs(root) {
  const dir = path.join(ensure(root), "jobs");
  return fs.readdirSync(dir).filter((x) => x.endsWith(".json")).flatMap((name) => { try { return [JSON.parse(readPrivateFile(path.join(dir, name)))]; } catch { return []; } }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function retain(root, limit = 50) {
  // Keep review jobs whose isolated homes were not cleaned, except explicit empty-target skips
  // (no provider session or home was ever created for those).
  const needsPrivacyRetention = (job) => (
    job.jobClass === "review"
      ? job.result?.providerSessionDeleted === false && job.result?.skipReason !== "empty-target"
      : job.jobClass === "task" && job.result?.taskRuntimeCleaned === false
  );
  const jobs = listJobs(root), terminalJobs = jobs.filter((job) => terminal(job) && !needsPrivacyRetention(job)), removable = terminalJobs.slice(Math.max(0, limit - jobs.filter((x) => !terminal(x)).length));
  for (const job of removable) for (const file of [jobFile(root, job.id), logFile(root, job.id), cancelFile(root, job.id)]) try { fs.unlinkSync(file); } catch (e) { if (e.code !== "ENOENT") throw e; }
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

export function requestCancel(root, id, nonce) {
  if (typeof nonce !== "string" || nonce.length < 1 || nonce.length > 256 || /[\r\n]/.test(nonce)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Refusing to create a cancellation marker without the active worker nonce.");
  }
  const file = cancelFile(root, id);
  // Publish only a fully written marker. Creating/truncating the destination
  // first lets another process observe an empty nonce between open and write,
  // which can lose a launch-window cancellation on slower runtimes.
  atomicPrivateFile(file, `${nonce}\n`);
}

export function isCancelRequested(root, id, expectedNonce) {
  if (typeof expectedNonce !== "string" || expectedNonce.length < 1 || expectedNonce.length > 256 || /[\r\n]/.test(expectedNonce)) return false;
  let actual;
  try { actual = readPrivateFile(cancelFile(root, id), { maxBytes: 1024 }).trim(); }
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
