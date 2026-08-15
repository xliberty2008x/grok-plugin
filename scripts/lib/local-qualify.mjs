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

function fail(message, details = "") {
  const suffix = details.trim() ? `\n${details.trim()}` : "";
  throw new Error(`${message}${suffix}`);
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
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
  } catch {
    return false;
  }
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
    let owner = 0;
    try {
      owner = Number(fs.readFileSync(lockPath, "utf8").trim());
    } catch {
      owner = 0;
    }
    if (processIsAlive(owner, options.kill)) {
      fail(`Qualification already running (pid ${owner}).`);
    }
    fs.rmSync(lockPath, { force: true });
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
  if (typeof lockPath === "string" && lockPath.length > 0) {
    fs.rmSync(lockPath, { force: true });
  }
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
  const forward = (signal) => {
    write(`phase: forwarding ${signal}\n`);
    if (child?.pid) killProcessTree(child.pid, signal, killer);
  };
  host.on("SIGINT", forward);
  host.on("SIGTERM", forward);
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

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      write(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      write(text);
    });

    const closed = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (status, signal) => {
        resolve({ status, signal });
      });
    });

    let timedOut = false;
    const timeoutWait = sleep(timeoutMs).then(() => {
      timedOut = true;
    });
    let exit = await Promise.race([closed, timeoutWait.then(() => null)]);
    if (exit == null) {
      write(`phase: repository-check timeout after ${timeoutMs}ms; stopping children\n`);
      killProcessTree(child.pid, "SIGTERM", killer);
      exit = await Promise.race([closed, sleep(graceMs).then(() => null)]);
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
    host.off("SIGINT", forward);
    host.off("SIGTERM", forward);
    releaseQualifyLock(lockPath);
  }
}
