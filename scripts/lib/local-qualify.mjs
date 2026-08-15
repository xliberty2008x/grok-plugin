import { spawn } from "node:child_process";
import process from "node:process";

import {
  assertReceiptMatchesIdentity,
  buildQualificationReceipt,
  collectInstallIdentity,
  qualificationReceiptPath,
  writeQualificationReceiptAtomic
} from "./qualification-receipt.mjs";

export const DEFAULT_QUALIFY_TIMEOUT_MS = 45 * 60_000;

function fail(message, details = "") {
  const suffix = details.trim() ? `\n${details.trim()}` : "";
  throw new Error(`${message}${suffix}`);
}

function killProcessTree(pid, signal) {
  if (!Number.isInteger(pid) || pid < 1) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
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

  const identity = collectInstallIdentity(root);
  write(`Qualifying ${identity.version} (${identity.fileCount} plugin files)...\n`);
  write(`phase: repository-check\n`);

  const child = spawnImpl(npmBin, checkArgs, {
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

  let timedOut = false;
  let timer;
  const exit = await new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      write(`phase: repository-check timeout after ${timeoutMs}ms; stopping children\n`);
      killProcessTree(child.pid, "SIGTERM");
      setTimeout(() => killProcessTree(child.pid, "SIGKILL"), 1_000).unref?.();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal });
    });
  });

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

  const current = collectInstallIdentity(root);
  if (current.sourceDigest !== identity.sourceDigest) {
    fail("Source plugin changed while qualification was running; no receipt written.");
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
}
