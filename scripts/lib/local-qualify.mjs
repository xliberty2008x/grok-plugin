import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  assertReceiptMatchesIdentity,
  buildQualificationReceipt,
  collectInstallIdentity,
  qualificationReceiptPath,
  writeQualificationReceiptAtomic
} from "./qualification-receipt.mjs";

export const DEFAULT_QUALIFY_TIMEOUT_MS = 45 * 60_000;
export const QUALIFY_KILL_GRACE_MS = 1_000;
export const QUALIFY_LOG_TAIL_CHARS = 64 * 1024;

function fail(message, details = "") {
  const suffix = details.trim() ? `\n${details.trim()}` : "";
  throw new Error(`${message}${suffix}`);
}

function delay(ms) {
  let timer = null;
  const promise = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return {
    promise,
    clear() {
      if (timer == null) return;
      clearTimeout(timer);
      timer = null;
    }
  };
}

export function qualificationLockPath(root) {
  return path.join(root, ".qualification", "qualify.lock");
}

function killProcessTree(pid, signal, killer) {
  if (!Number.isInteger(pid) || pid < 1) return;
  const send = killer ?? process.kill.bind(process);
  try {
    send(-pid, signal);
  } catch {
    try {
      send(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

function processIsAlive(pid, killer) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  const send = killer ?? process.kill.bind(process);
  try {
    send(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readLockPids(lockPath) {
  try {
    return fs.readFileSync(lockPath, "utf8")
      .split(/\s+/u)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

function writeLockPids(lockPath, pids) {
  const text = pids
    .filter((value) => Number.isInteger(value) && value > 0)
    .map((value) => `${value}\n`)
    .join("");
  fs.writeFileSync(lockPath, text, { mode: 0o600 });
}

function appendCapture(buffer, text) {
  const next = buffer + text;
  return next.length > QUALIFY_LOG_TAIL_CHARS
    ? next.slice(-QUALIFY_LOG_TAIL_CHARS)
    : next;
}

export function acquireQualifyLock(root, options = {}) {
  const lockPath = qualificationLockPath(root);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const openExclusive = () => {
    const fd = fs.openSync(lockPath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${process.pid}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return lockPath;
  };
  try {
    return openExclusive();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const live = readLockPids(lockPath)
      .filter((owner) => processIsAlive(owner, options.kill));
    if (live.length > 0) {
      fail(`Qualification already running (pid ${live.join(", ")}).`);
    }
    const stalePath = `${lockPath}.${process.pid}.stale`;
    try {
      fs.renameSync(lockPath, stalePath);
    } catch (renameError) {
      if (renameError.code === "ENOENT") {
        fail("Qualification already running.");
      }
      throw renameError;
    }
    fs.rmSync(stalePath, { force: true });
    try {
      return openExclusive();
    } catch (retryError) {
      if (retryError.code === "EEXIST") {
        fail("Qualification already running.");
      }
      throw retryError;
    }
  }
}

export function releaseQualifyLock(lockPath) {
  if (typeof lockPath !== "string" || lockPath.length < 1) return;
  try {
    if (!readLockPids(lockPath).includes(process.pid)) return;
  } catch {
    return;
  }
  fs.rmSync(lockPath, { force: true });
}

function identityDrifted(before, after) {
  return (
    after.sourceDigest !== before.sourceDigest
    || after.packageDigest !== before.packageDigest
    || after.marketplaceDigest !== before.marketplaceDigest
    || after.version !== before.version
    || after.fileCount !== before.fileCount
  );
}

/**
 * Stream a qualification command and write a receipt bound to the exact source
 * inventory. Does not install into Codex.
 */
export async function runLocalQualify(options = {}) {
  const root = options.root;
  if (typeof root !== "string" || root.length < 1) {
    throw new Error("qualify requires a repository root.");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUALIFY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("qualify timeout must be a positive integer.");
  }
  const npmBin = options.npmBin ?? (process.platform === "win32" ? "npm.cmd" : "npm");
  const checkArgs = options.checkArgs ?? ["run", "check"];
  const spawnImpl = options.spawn ?? spawn;
  const write = options.write ?? ((text) => process.stdout.write(text));
  const now = options.now ?? (() => new Date());
  const host = options.process ?? process;
  const killer = options.kill ?? process.kill.bind(process);
  const graceMs = options.killGraceMs ?? QUALIFY_KILL_GRACE_MS;

  const lockPath = acquireQualifyLock(options.lockRoot ?? root, { kill: killer });
  let child = null;
  let timeout = null;
  let grace = null;
  let interrupted = false;
  const forward = (signal) => {
    interrupted = true;
    write(`phase: forwarding ${signal}\n`);
    if (child?.pid) killProcessTree(child.pid, signal, killer);
  };
  const onSigint = () => forward("SIGINT");
  const onSigterm = () => forward("SIGTERM");
  host.on("SIGINT", onSigint);
  host.on("SIGTERM", onSigterm);
  try {
    const collectIdentity = options.collectIdentity ?? collectInstallIdentity;
    const identity = collectIdentity(root);
    write(`Qualifying ${identity.version} (${identity.fileCount} plugin files)...\n`);
    write(`phase: repository-check\n`);

    child = spawnImpl(npmBin, checkArgs, {
      cwd: root,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32"
    });
    if (!Number.isInteger(child.pid) || child.pid < 1) {
      fail("Could not start npm run check.");
    }
    const closed = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (status, signal) => {
        resolve({ status, signal });
      });
    });
    writeLockPids(lockPath, [process.pid, child.pid]);

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout = appendCapture(stdout, text);
      write(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      stderr = appendCapture(stderr, text);
      write(text);
    });

    let timedOut = false;
    timeout = delay(timeoutMs);
    let exit = await Promise.race([closed, timeout.promise.then(() => null)]);
    if (exit == null) {
      timedOut = true;
      write(`phase: repository-check timeout after ${timeoutMs}ms; stopping children\n`);
      killProcessTree(child.pid, "SIGTERM", killer);
      grace = delay(graceMs);
      exit = await Promise.race([closed, grace.promise.then(() => null)]);
      if (exit == null) {
        killProcessTree(child.pid, "SIGKILL", killer);
        exit = await closed;
      }
    }

    if (timedOut) {
      fail(
        "Qualification timed out during phase repository-check.",
        "Timed-out children were signaled. Retry only after this command exits."
      );
    }
    if (interrupted) {
      fail("Qualification interrupted; no receipt written.");
    }
    if (exit.status !== 0) {
      fail(
        `npm run check exited with status ${exit.status}.`,
        [stdout, stderr].filter(Boolean).join("\n")
      );
    }

    const current = collectIdentity(root);
    if (identityDrifted(identity, current)) {
      fail(
        "Source plugin, package metadata, or marketplace digest changed while qualification was running; no receipt written."
      );
    }
    if (interrupted) {
      fail("Qualification interrupted; no receipt written.");
    }
    const receipt = buildQualificationReceipt(current, {
      createdAt: now().toISOString(),
      checkCommand: "npm run check"
    });
    assertReceiptMatchesIdentity(receipt, current);
    const receiptPath = options.receiptPath ?? qualificationReceiptPath(root);
    writeQualificationReceiptAtomic(receiptPath, receipt);
    write(`Qualification receipt written: ${receiptPath}\n`);
    write(`  version: ${receipt.version}\n`);
    write(`  digest:  ${receipt.source_digest}\n`);
    return { receipt, receiptPath, identity: current };
  } finally {
    timeout?.clear();
    grace?.clear();
    host.off("SIGINT", onSigint);
    host.off("SIGTERM", onSigterm);
    releaseQualifyLock(lockPath);
  }
}
