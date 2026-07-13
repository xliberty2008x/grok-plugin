import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CompanionError } from "./errors.mjs";
import { processIsZombie, processStartToken } from "./process-control.mjs";
import { workspaceState, assertSafeJobId } from "./workspace.mjs";

const ACTIVE = new Set(["queued", "running"]);
const LOCK_OWNER_START_TOKEN = processStartToken(process.pid);
export const terminal = (job) => !ACTIVE.has(job?.status);
export const now = () => new Date().toISOString();

function ensure(root) {
  const base = workspaceState(root);
  for (const dir of [base, path.join(base, "jobs"), path.join(base, "locks")]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return base;
}

function atomicJson(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
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

export function config(root) {
  const file = path.join(ensure(root), "config.json");
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code === "ENOENT") return { schemaVersion: 1, stopReviewGate: false, disclosureAccepted: false }; throw new CompanionError("E_STATE", "Could not read plugin configuration."); }
}

export function setConfig(root, patch) { return withLock(root, "config", () => { const next = { ...config(root), ...patch, schemaVersion: 1 }; atomicJson(path.join(ensure(root), "config.json"), next); return next; }); }

export function generateId(kind) { return `${kind}-${crypto.randomBytes(12).toString("hex")}`; }

export function jobFile(root, id) { return path.join(ensure(root), "jobs", `${assertSafeJobId(id)}.json`); }
export function cancelFile(root, id) { return path.join(ensure(root), "jobs", `${assertSafeJobId(id)}.cancel`); }
export function logFile(root, id) { return path.join(ensure(root), "jobs", `${assertSafeJobId(id)}.log`); }

export function readJob(root, id) {
  const file = jobFile(root, id);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { if (e.code === "ENOENT") throw new CompanionError("E_JOB_NOT_FOUND", `Job ${id} was not found in this repository.`); throw new CompanionError("E_STATE", `Could not read job ${id}.`); }
}

export function writeJob(root, job) { return withLock(root, job.id, () => { job.updatedAt = now(); atomicJson(jobFile(root, job.id), job); return job; }); }

export function updateJob(root, id, mutator) { assertSafeJobId(id); return withLock(root, id, () => { const job = readJob(root, id); const next = mutator({ ...job }) || job; next.updatedAt = now(); atomicJson(jobFile(root, id), next); return next; }); }

export function listJobs(root) {
  const dir = path.join(ensure(root), "jobs");
  return fs.readdirSync(dir).filter((x) => x.endsWith(".json")).flatMap((name) => { try { return [JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))]; } catch { return []; } }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function retain(root, limit = 50) {
  const jobs = listJobs(root), terminalJobs = jobs.filter((job) => terminal(job) && !(job.jobClass === "review" && job.result?.providerSessionDeleted === false)), removable = terminalJobs.slice(Math.max(0, limit - jobs.filter((x) => !terminal(x)).length));
  for (const job of removable) for (const file of [jobFile(root, job.id), logFile(root, job.id), cancelFile(root, job.id)]) try { fs.unlinkSync(file); } catch (e) { if (e.code !== "ENOENT") throw e; }
}

export function selectJob(root, { id, claudeSessionId, active, finished, allSessions = false } = {}) {
  if (id) return readJob(root, id);
  const match = listJobs(root).filter((job) => (allSessions || !claudeSessionId || job.claudeSessionId === claudeSessionId) && (!active || ACTIVE.has(job.status)) && (!finished || terminal(job)));
  if (!match.length) throw new CompanionError("E_JOB_NOT_FOUND", "No matching Grok job was found in this Claude session.");
  return match[0];
}

export function requestCancel(root, id, nonce) {
  if (typeof nonce !== "string" || nonce.length < 1 || nonce.length > 256 || /[\r\n]/.test(nonce)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Refusing to create a cancellation marker without the active worker nonce.");
  }
  fs.writeFileSync(cancelFile(root, id), `${nonce}\n`, { mode: 0o600 });
}

export function isCancelRequested(root, id, expectedNonce) {
  if (typeof expectedNonce !== "string" || expectedNonce.length < 1 || expectedNonce.length > 256 || /[\r\n]/.test(expectedNonce)) return false;
  let actual;
  try { actual = fs.readFileSync(cancelFile(root, id), "utf8").trim(); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  const left = Buffer.from(actual);
  const right = Buffer.from(expectedNonce);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function removeJob(root, id) {
  for (const file of [jobFile(root, id), logFile(root, id), cancelFile(root, id)]) {
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
