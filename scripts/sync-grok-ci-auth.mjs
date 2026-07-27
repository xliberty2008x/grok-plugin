#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_AUTH_BYTES = 2 * 1024 * 1024;
const DEFAULT_MINIMUM_VALIDITY_MS = 45 * 60 * 1000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_TIMEOUT_MS = 45_000;
const DEFAULT_STALE_LOCK_MS = 2 * 60 * 1000;
// A valid lock owner can spend at most 45s waiting and 30s uploading. The
// two-minute stale floor exceeds that budget. A live PID is retained until the
// hard TTL so a sleeping owner is not fenced, while PID reuse cannot wedge the
// lock forever.
const DEFAULT_HARD_STALE_LOCK_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_SYNC_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_STATE_MTIME_SKEW_MS = 1000;
const SECRET_NAME = "GROK_AUTH_JSON";
const REPO_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const LOCK_FILE_PATTERN =
  /^(?:choosing-([0-9a-f]{32})|ticket-([0-9]{16})-([0-9a-f]{32}))\.json$/;
const WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

class SyncError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SyncError";
    this.code = code;
  }
}

function usage() {
  return [
    "Usage: node scripts/sync-grok-ci-auth.mjs",
    "  --repo OWNER/REPO --gh-bin /absolute/path/to/gh --state-dir /private/state/dir",
    "  [--auth-path /path/to/auth.json] [--force]"
  ].join("\n");
}

function expandHome(value, home = os.homedir()) {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

export function parseSyncArgs(argv, { home = os.homedir() } = {}) {
  const args = {
    authPath: path.join(home, ".grok", "auth.json"),
    force: false
  };
  const takeValue = (index) => {
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new SyncError("E_ARGS", "A required flag value is missing.");
    }
    return argv[index + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") args.repo = takeValue(i++);
    else if (arg === "--gh-bin") args.ghBin = takeValue(i++);
    else if (arg === "--state-dir") args.stateDir = takeValue(i++);
    else if (arg === "--auth-path") args.authPath = takeValue(i++);
    else if (arg === "--force") args.force = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new SyncError("E_ARGS", "An unsupported flag was provided.");
  }
  if (args.help) return args;
  if (!args.repo || !REPO_PATTERN.test(args.repo)) {
    throw new SyncError("E_ARGS", "--repo must be an exact OWNER/REPO value.");
  }
  if (!args.ghBin || !path.isAbsolute(args.ghBin)) {
    throw new SyncError("E_ARGS", "--gh-bin must be an absolute path.");
  }
  if (!args.stateDir || !path.isAbsolute(args.stateDir)) {
    throw new SyncError("E_ARGS", "--state-dir must be an absolute path.");
  }
  args.authPath = path.resolve(expandHome(args.authPath, home));
  try {
    args.ghBin = fs.realpathSync(path.resolve(args.ghBin));
  } catch {
    throw new SyncError("E_EXECUTABLE", "GitHub CLI could not be resolved.");
  }
  args.stateDir = path.resolve(args.stateDir);
  return args;
}

function currentUid() {
  if (typeof process.getuid !== "function") {
    throw new SyncError("E_PLATFORM", "File ownership checks are unavailable.");
  }
  return process.getuid();
}

function assertOwned(stat, label, { allowRoot = false } = {}) {
  const uid = currentUid();
  if (stat.uid !== uid && !(allowRoot && stat.uid === 0)) {
    throw new SyncError("E_PERMISSIONS", `${label} has an invalid owner.`);
  }
}

function assertPrivateMode(stat, label) {
  if ((stat.mode & 0o077) !== 0) {
    throw new SyncError("E_PERMISSIONS", `${label} must not grant group or other access.`);
  }
}

function assertSameIdentity(left, right, label) {
  if (left.dev !== right.dev || left.ino !== right.ino) {
    throw new SyncError("E_RACE", `${label} changed during verification.`);
  }
}

function noFollowFlags(baseFlags) {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
    throw new SyncError("E_PLATFORM", "No-follow file opens are unavailable.");
  }
  return baseFlags | fs.constants.O_NOFOLLOW;
}

export function assertPrivateDirectory(directory, label = "Directory") {
  let before;
  try {
    before = fs.lstatSync(directory);
  } catch {
    throw new SyncError("E_STATE", `${label} is unavailable.`);
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new SyncError("E_PERMISSIONS", `${label} must be a real directory.`);
  }
  assertOwned(before, label);
  assertPrivateMode(before, label);
  let fd;
  try {
    fd = fs.openSync(
      directory,
      noFollowFlags(fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0))
    );
    const opened = fs.fstatSync(fd);
    assertSameIdentity(before, opened, label);
    assertOwned(opened, label);
    assertPrivateMode(opened, label);
  } catch (error) {
    if (error instanceof SyncError) throw error;
    throw new SyncError("E_PERMISSIONS", `${label} could not be verified.`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function tightenPrivateDirectory(directory, label = "Directory") {
  let before;
  let fd;
  try {
    before = fs.lstatSync(directory);
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new SyncError("E_PERMISSIONS", `${label} must be a real directory.`);
    }
    assertOwned(before, label);
    fd = fs.openSync(
      directory,
      noFollowFlags(fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0))
    );
    const opened = fs.fstatSync(fd);
    assertSameIdentity(before, opened, label);
    assertOwned(opened, label);
    fs.fchmodSync(fd, 0o700);
    const secured = fs.fstatSync(fd);
    assertSameIdentity(opened, secured, label);
    assertPrivateMode(secured, label);
  } catch (error) {
    if (error instanceof SyncError) throw error;
    throw new SyncError("E_PERMISSIONS", `${label} could not be secured.`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function readPrivateAuthFile(authPath) {
  const parent = path.dirname(authPath);
  assertPrivateDirectory(parent, "Authentication directory");
  const parentBefore = fs.lstatSync(parent);
  let fd;
  try {
    fd = fs.openSync(authPath, noFollowFlags(fs.constants.O_RDONLY));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size <= 0 || opened.size > MAX_AUTH_BYTES) {
      throw new SyncError("E_AUTH", "Authentication file has an invalid size or type.");
    }
    assertOwned(opened, "Authentication file");
    assertPrivateMode(opened, "Authentication file");
    const raw = fs.readFileSync(fd);
    const afterRead = fs.fstatSync(fd);
    assertSameIdentity(opened, afterRead, "Authentication file");
    if (
      opened.size !== afterRead.size
      || opened.mtimeMs !== afterRead.mtimeMs
      || opened.ctimeMs !== afterRead.ctimeMs
    ) {
      throw new SyncError("E_RACE", "Authentication file changed during reading.");
    }
    const current = fs.lstatSync(authPath);
    assertSameIdentity(opened, current, "Authentication file");
    const parentAfter = fs.lstatSync(parent);
    assertSameIdentity(parentBefore, parentAfter, "Authentication directory");
    return raw;
  } catch (error) {
    if (error instanceof SyncError) throw error;
    throw new SyncError("E_AUTH", "Authentication file could not be read safely.");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function validateAuthPayload(
  raw,
  {
    now = Date.now(),
    minimumValidityMs = DEFAULT_MINIMUM_VALIDITY_MS
  } = {}
) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
  } catch {
    throw new SyncError("E_AUTH", "Authentication file is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyncError("E_AUTH", "Authentication file has an invalid structure.");
  }
  const usable = Object.values(parsed).some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    if (typeof entry.key !== "string" || entry.key.trim().length < 16) return false;
    if (
      typeof entry.refresh_token !== "string"
      || entry.refresh_token.trim().length === 0
    ) {
      return false;
    }
    if (typeof entry.expires_at !== "string") return false;
    const expiresAt = Date.parse(entry.expires_at);
    return Number.isFinite(expiresAt) && expiresAt - now >= minimumValidityMs;
  });
  if (!usable) {
    throw new SyncError(
      "E_AUTH",
      "Authentication file contains no sufficiently fresh refreshable session."
    );
  }
}

export function assertVerifiedExecutable(executable, label) {
  if (!path.isAbsolute(executable)) {
    throw new SyncError("E_EXECUTABLE", `${label} path must be absolute.`);
  }
  let fd;
  try {
    fd = fs.openSync(executable, noFollowFlags(fs.constants.O_RDONLY));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0) {
      throw new SyncError("E_EXECUTABLE", `${label} is not a trusted executable.`);
    }
    assertOwned(stat, label, { allowRoot: true });
    const current = fs.lstatSync(executable);
    assertSameIdentity(stat, current, label);
  } catch (error) {
    if (error instanceof SyncError) throw error;
    throw new SyncError("E_EXECUTABLE", `${label} could not be verified.`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function safeReadSmallOwnedFile(file, maximumBytes = 4096) {
  let fd;
  try {
    fd = fs.openSync(file, noFollowFlags(fs.constants.O_RDONLY));
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile()
      || stat.size <= 0
      || stat.size > maximumBytes
      || stat.uid !== currentUid()
      || (stat.mode & 0o077) !== 0
    ) {
      return null;
    }
    const contents = fs.readFileSync(fd, "utf8");
    const after = fs.fstatSync(fd);
    assertSameIdentity(stat, after, "State file");
    return { contents, stat };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function atomicWritePrivate(file, contents) {
  const directory = path.dirname(file);
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  let fd;
  try {
    fd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600
    );
    fs.writeFileSync(fd, contents, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
    let dirFd;
    try {
      dirFd = fs.openSync(
        directory,
        fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0)
      );
      fs.fsyncSync(dirFd);
    } finally {
      if (dirFd !== undefined) fs.closeSync(dirFd);
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function candidateNonce(file) {
  const match = path.basename(file).match(LOCK_FILE_PATTERN);
  return match?.[1] || match?.[3] || null;
}

function readCandidate(file) {
  const safe = safeReadSmallOwnedFile(file);
  if (!safe) return null;
  try {
    const payload = JSON.parse(safe.contents);
    const nonce = candidateNonce(file);
    if (
      !nonce
      || payload?.nonce !== nonce
      || !Number.isSafeInteger(payload?.pid)
      || payload.pid <= 0
      || payload.uid !== currentUid()
      || !Number.isFinite(payload.startedAt)
    ) {
      return { valid: false, stat: safe.stat, nonce };
    }
    const ticketMatch = path.basename(file).match(LOCK_FILE_PATTERN)?.[2];
    const ticket = ticketMatch == null ? null : Number(ticketMatch);
    if (
      (payload.phase === "choosing" && ticket !== null)
      || (payload.phase === "ticket" && (!Number.isSafeInteger(ticket) || ticket < 1))
    ) {
      return { valid: false, stat: safe.stat, nonce };
    }
    return { valid: true, stat: safe.stat, nonce, ticket, payload };
  } catch {
    return { valid: false, stat: safe.stat, nonce: candidateNonce(file) };
  }
}

function removeExactCandidate(file, expectedNonce) {
  if (!expectedNonce || candidateNonce(file) !== expectedNonce) return false;
  const candidate = readCandidate(file);
  if (candidate?.nonce !== expectedNonce) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function removeStaleCandidates(
  lockDirectory,
  {
    now = Date.now(),
    staleAfterMs = DEFAULT_STALE_LOCK_MS,
    hardStaleAfterMs = DEFAULT_HARD_STALE_LOCK_MS
  } = {}
) {
  const removed = [];
  for (const name of fs.readdirSync(lockDirectory)) {
    if (!LOCK_FILE_PATTERN.test(name)) continue;
    const file = path.join(lockDirectory, name);
    const candidate = readCandidate(file);
    if (!candidate) continue;
    const age = now - Math.max(
      candidate.stat.mtimeMs,
      candidate.valid ? candidate.payload.startedAt : 0
    );
    const live = candidate.valid && pidIsLive(candidate.payload.pid);
    const reclaim = age >= hardStaleAfterMs
      || (age >= staleAfterMs && !live);
    if (reclaim && removeExactCandidate(file, candidate.nonce)) {
      removed.push(name);
    }
  }
  return removed;
}

function pidIsLive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function listCandidates(lockDirectory, staleAfterMs, hardStaleAfterMs) {
  removeStaleCandidates(lockDirectory, { staleAfterMs, hardStaleAfterMs });
  return fs.readdirSync(lockDirectory)
    .filter((name) => LOCK_FILE_PATTERN.test(name))
    .map((name) => {
      const file = path.join(lockDirectory, name);
      return { file, name, candidate: readCandidate(file) };
    });
}

function waitBriefly() {
  Atomics.wait(WAIT_ARRAY, 0, 0, 50);
}

function ensureLockDirectory(stateDir) {
  const lockDirectory = path.join(stateDir, "lock-candidates");
  try {
    fs.mkdirSync(lockDirectory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw new SyncError("E_LOCK", "Lock directory could not be created.");
    }
  }
  tightenPrivateDirectory(lockDirectory, "Lock directory");
  return lockDirectory;
}

export function acquireUploadLock(
  stateDir,
  {
    timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    staleAfterMs = DEFAULT_STALE_LOCK_MS,
    hardStaleAfterMs = DEFAULT_HARD_STALE_LOCK_MS
  } = {}
) {
  const lockDirectory = ensureLockDirectory(stateDir);
  const nonce = crypto.randomBytes(16).toString("hex");
  const choosingPath = path.join(lockDirectory, `choosing-${nonce}.json`);
  const owner = {
    nonce,
    pid: process.pid,
    uid: currentUid(),
    startedAt: Date.now(),
    phase: "choosing"
  };
  atomicWritePrivate(choosingPath, `${JSON.stringify(owner)}\n`);
  let ownedPath = choosingPath;
  const deadline = Date.now() + timeoutMs;
  try {
    const initial = listCandidates(
      lockDirectory,
      staleAfterMs,
      hardStaleAfterMs
    );
    const maximumTicket = initial.reduce(
      (maximum, item) => Math.max(maximum, item.candidate?.ticket || 0),
      0
    );
    const ticket = maximumTicket + 1;
    if (!Number.isSafeInteger(ticket) || ticket > 9_999_999_999_999_999) {
      throw new SyncError("E_LOCK", "Lock ticket space is exhausted.");
    }
    const ticketText = String(ticket).padStart(16, "0");
    const ticketPath = path.join(
      lockDirectory,
      `ticket-${ticketText}-${nonce}.json`
    );
    owner.phase = "ticket";
    owner.ticket = ticket;
    atomicWritePrivate(choosingPath, `${JSON.stringify(owner)}\n`);
    fs.renameSync(choosingPath, ticketPath);
    ownedPath = ticketPath;

    while (true) {
      if (Date.now() >= deadline) {
        throw new SyncError("E_LOCK_TIMEOUT", "Timed out waiting for the upload lock.");
      }
      const candidates = listCandidates(
        lockDirectory,
        staleAfterMs,
        hardStaleAfterMs
      );
      let blocked = false;
      for (const item of candidates) {
        if (item.name === path.basename(ticketPath)) continue;
        if (!item.candidate?.valid) {
          blocked = true;
          break;
        }
        if (item.candidate.ticket === null) {
          blocked = true;
          break;
        }
        if (
          item.candidate.ticket < ticket
          || (
            item.candidate.ticket === ticket
            && item.candidate.nonce.localeCompare(nonce) < 0
          )
        ) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        let released = false;
        return {
          nonce,
          ticket,
          release() {
            if (released) return;
            released = true;
            removeExactCandidate(ticketPath, nonce);
          }
        };
      }
      waitBriefly();
    }
  } catch (error) {
    removeExactCandidate(ownedPath, nonce);
    if (error instanceof SyncError) throw error;
    throw new SyncError("E_LOCK", "Upload lock acquisition failed.");
  }
}

export function digestStatePath(stateDir, repo) {
  const repoDigest = crypto.createHash("sha256").update(repo).digest("hex").slice(0, 16);
  return path.join(stateDir, `auth-${repoDigest}.sha256`);
}

export function readDigestMetadata(file) {
  try {
    const safe = safeReadSmallOwnedFile(file, 128);
    if (!safe) return null;
    const value = safe.contents.trim();
    return DIGEST_PATTERN.test(value)
      ? { digest: value, mtimeMs: safe.stat.mtimeMs }
      : null;
  } catch {
    return null;
  }
}

function minimalGhEnvironment(source = process.env) {
  const allowlist = [
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY"
  ];
  const forbidden =
    /(?:^|_)(?:token|secret|credential|password|passwd|pwd|authorization|cookie|api_key|access_key)(?:_|$)/i;
  const env = {};
  for (const key of allowlist) {
    if (!forbidden.test(key) && typeof source[key] === "string") env[key] = source[key];
  }
  return env;
}

export function uploadGitHubSecret(
  {
    ghBin,
    repo,
    raw,
    timeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS,
    sourceEnv = process.env
  }
) {
  const result = spawnSync(
    ghBin,
    [
      "secret",
      "set",
      SECRET_NAME,
      "--app",
      "actions",
      "--repo",
      `github.com/${repo}`
    ],
    {
      input: raw,
      env: minimalGhEnvironment(sourceEnv),
      encoding: "buffer",
      shell: false,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    }
  );
  if (result.error?.code === "ETIMEDOUT" || result.signal) {
    throw new SyncError("E_UPLOAD_TIMEOUT", "GitHub secret upload timed out.");
  }
  if (result.error || result.status !== 0) {
    throw new SyncError("E_UPLOAD", "GitHub secret upload failed.");
  }
}

export function synchronizeAuth(
  args,
  {
    now = null,
    minimumValidityMs = DEFAULT_MINIMUM_VALIDITY_MS,
    uploadTimeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS,
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    staleLockMs = DEFAULT_STALE_LOCK_MS,
    hardStaleLockMs = DEFAULT_HARD_STALE_LOCK_MS,
    maxSyncAgeMs = DEFAULT_MAX_SYNC_AGE_MS,
    sourceEnv = process.env
  } = {}
) {
  assertPrivateDirectory(args.stateDir, "State directory");
  assertVerifiedExecutable(args.ghBin, "GitHub CLI");
  const lock = acquireUploadLock(args.stateDir, {
    timeoutMs: lockTimeoutMs,
    staleAfterMs: staleLockMs,
    hardStaleAfterMs: hardStaleLockMs
  });
  try {
    const evaluationNow = now ?? Date.now();
    const raw = readPrivateAuthFile(args.authPath);
    validateAuthPayload(raw, { now: evaluationNow, minimumValidityMs });
    const digest = crypto.createHash("sha256").update(raw).digest("hex");
    const stateFile = digestStatePath(args.stateDir, args.repo);
    const stored = readDigestMetadata(stateFile);
    if (
      !args.force
      && stored?.digest === digest
      && stored.mtimeMs <= evaluationNow + MAX_STATE_MTIME_SKEW_MS
      && Math.max(0, evaluationNow - stored.mtimeMs) < maxSyncAgeMs
    ) {
      return { status: "unchanged" };
    }
    uploadGitHubSecret({
      ghBin: args.ghBin,
      repo: args.repo,
      raw,
      timeoutMs: uploadTimeoutMs,
      sourceEnv
    });
    atomicWritePrivate(stateFile, `${digest}\n`);
    return { status: "uploaded" };
  } finally {
    lock.release();
  }
}

function main() {
  try {
    const args = parseSyncArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const result = synchronizeAuth(args);
    if (result.status === "unchanged") {
      process.stdout.write("sync-grok-ci-auth: GitHub Actions secret is already current.\n");
    } else {
      process.stdout.write("sync-grok-ci-auth: GitHub Actions secret synchronized.\n");
    }
  } catch (error) {
    const code = error instanceof SyncError ? error.code : "E_INTERNAL";
    const message = error instanceof SyncError
      ? error.message
      : "Unexpected synchronization failure.";
    process.stderr.write(`sync-grok-ci-auth: ${code}: ${message}\n`);
    process.exitCode = 1;
  }
}

let invokedPath = "";
try {
  invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
} catch {
  invokedPath = "";
}
if (invokedPath === fs.realpathSync(fileURLToPath(import.meta.url))) main();
