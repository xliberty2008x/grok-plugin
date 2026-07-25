#!/usr/bin/env node

/**
 * Disposable live probe for the production promotion-gated provisioner.
 *
 * The probe intentionally retains its repository and broker data on success
 * because P3-P3 has no durable ready -> cleanup transition yet. The printed
 * paths are the cleanup handoff for the later official-remove gate.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildTaskEnvelope } from "../plugins/grok/scripts/lib/task-contract.mjs";
import {
  admitWriteWorkerPlan,
  assertWriteExecutionJob
} from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import { provisionWriteWorkerWorktree } from "../plugins/grok/scripts/lib/worker-provisioner.mjs";
import { readJob } from "../plugins/grok/scripts/lib/state.mjs";

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function privateFixtureBase() {
  const configured = process.env.GROK_COMPANION_LIVE_FIXTURE_ROOT;
  const base = path.resolve(
    configured || path.join(os.homedir(), ".grok-companion-live-fixtures")
  );
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const resolved = fs.realpathSync(base);
  const stat = fs.lstatSync(resolved);
  const broadTemporaryRoots = [
    os.tmpdir(),
    "/tmp",
    "/private/tmp"
  ].map((value) => {
    try { return fs.realpathSync(value); }
    catch { return path.resolve(value); }
  });
  if (resolved !== base
    || !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o077) !== 0
    || broadTemporaryRoots.some((temporary) => (
      resolved === temporary || resolved.startsWith(`${temporary}${path.sep}`)
    ))) {
    throw new Error(
      "Live provisioner fixtures require one private non-temporary root."
    );
  }
  return resolved;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    timeout: 30_000
  });
  if (result.status !== 0 || result.error) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${
        result.error?.message || result.stderr || result.stdout
      }`
    );
  }
  return String(result.stdout || "").trim();
}

function sourceIdentity() {
  const implementationRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
  );
  const commit = run("git", ["rev-parse", "HEAD"], implementationRoot);
  const tree = run("git", ["rev-parse", "HEAD^{tree}"], implementationRoot);
  const status = run(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    implementationRoot
  );
  const inventory = run("git", ["ls-files", "-s", "-z"], implementationRoot);
  const clean = status.length === 0;
  if (!clean
    && process.env.GROK_COMPANION_ALLOW_DIRTY_LIVE_SOURCE !== "1") {
    throw new Error(
      "Live provisioner evidence requires one exact clean source commit."
    );
  }
  return Object.freeze({
    implementationRoot,
    commit,
    tree,
    clean,
    inventoryDigest: crypto
      .createHash("sha256")
      .update(inventory)
      .digest("hex"),
    statusDigest: crypto
      .createHash("sha256")
      .update(status)
      .digest("hex")
  });
}

function disposableRepository(base) {
  const root = fs.mkdtempSync(
    path.join(base, "grok-worker-provisioner-live-source-")
  );
  run("git", ["init", "-q"], root);
  run("git", ["config", "user.email", "worker-probe@example.invalid"], root);
  run("git", ["config", "user.name", "Worker Provisioner Probe"], root);
  fs.writeFileSync(path.join(root, "target.txt"), "before\n", { mode: 0o644 });
  fs.writeFileSync(path.join(root, ".gitignore"), ".DS_Store\n", { mode: 0o644 });
  run("git", ["add", ".gitignore", "target.txt"], root);
  run("git", ["commit", "-qm", "probe base"], root);
  const hook = path.join(root, ".git", "hooks", "post-checkout");
  fs.writeFileSync(
    hook,
    [
      "#!/bin/sh",
      "checkout_root=\"$(git rev-parse --show-toplevel)\" || exit 1",
      "printf 'hook-executed\\n' > \"$(dirname \"$checkout_root\")/post-checkout-ran.txt\"",
      ""
    ].join("\n"),
    { mode: 0o700 }
  );
  fs.chmodSync(hook, 0o700);
  return root;
}

function recordDigest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function requiredReplayEnvironment(name, {
  absolutePath = false,
  pattern = null
} = {}) {
  const value = process.env[name];
  if (typeof value !== "string"
    || !value
    || (absolutePath && (
      !path.isAbsolute(value)
      || path.normalize(value) !== value
    ))
    || (pattern && !pattern.test(value))) {
    throw new Error(`Ready replay environment ${name} is malformed.`);
  }
  return value;
}

async function runReadyReplay() {
  const root = requiredReplayEnvironment(
    "GROK_COMPANION_READY_REPLAY_ROOT",
    { absolutePath: true }
  );
  const workerId = requiredReplayEnvironment(
    "GROK_COMPANION_READY_REPLAY_WORKER_ID",
    { pattern: /^task-[a-zA-Z0-9._-]{1,120}$/ }
  );
  const sessionId = requiredReplayEnvironment(
    "GROK_COMPANION_READY_REPLAY_SESSION_ID",
    { pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/ }
  );
  const result = await provisionWriteWorkerWorktree({
    root,
    principal: {
      hostKind: "codex",
      threadId: sessionId
    },
    workerId,
    leaseMs: 1,
    timeoutMs: 1
  });
  console.log(JSON.stringify({
    schemaVersion: 1,
    outcome: "passed",
    result
  }));
}

async function runFreshProbe() {
const implementationSource = sourceIdentity();
const configuredLeaseMs = process.env.GROK_COMPANION_LIVE_LEASE_MS
  ? Number(process.env.GROK_COMPANION_LIVE_LEASE_MS)
  : 240_000;
if (!Number.isSafeInteger(configuredLeaseMs)
  || configuredLeaseMs < 1
  || configuredLeaseMs > 300_000) {
  throw new Error(
    "GROK_COMPANION_LIVE_LEASE_MS must be an integer from 1 through 300000."
  );
}
const fixtureBase = privateFixtureBase();
const siblingRoot = fs.mkdtempSync(
  path.join(fixtureBase, "grok-worker-provisioner-live-sibling-")
);
const siblingCanary = path.join(siblingRoot, "canary.txt");
fs.writeFileSync(siblingCanary, "sibling-before\n", { mode: 0o600 });
const siblingCanaryDigest = sha256File(siblingCanary);
const root = disposableRepository(fixtureBase);
const controlTargetDigest = sha256File(path.join(root, "target.txt"));
const pluginData = fs.mkdtempSync(
  path.join(fixtureBase, "grok-worker-provisioner-live-data-")
);
const sessionId = crypto.randomUUID();
process.env.GROK_COMPANION_HOST = "codex";
process.env.GROK_COMPANION_HOST_SESSION_ID = sessionId;
process.env.CODEX_THREAD_ID = sessionId;
process.env.GROK_COMPANION_PLUGIN_DATA = pluginData;

const principal = {
  hostKind: "codex",
  threadId: sessionId,
  turnId: crypto.randomUUID(),
  source: "codex-mcp-stdio",
  pluginId: "grok@grok-companion",
  root,
  mutationCapable: true
};
let workerId = null;
let hookMarker = null;

try {
  const admitted = admitWriteWorkerPlan({
    root,
    principal,
    envelope: buildTaskEnvelope({
      userRequest: "Provision the official worktree only; do not run a model turn.",
      objective: "Prove the promotion-gated official worktree provisioner.",
      mode: "write",
      scope: { include: ["target.txt"], exclude: [] }
    }),
    idempotencyKey: `live-provision-${crypto.randomUUID()}`,
    roleId: "implementer",
    allowWriteSpawn: true,
    writeLifecycleCapabilityDigest: crypto
      .createHash("sha256")
      .update("live-official-worktree-provisioner-v1")
      .digest("hex")
  });
  workerId = admitted.handle.id;
  const planned = assertWriteExecutionJob(readJob(root, workerId));
  hookMarker = path.join(
    path.dirname(planned.binding.expectedExecutionRoot),
    "post-checkout-ran.txt"
  );
  const result = await provisionWriteWorkerWorktree({
    root,
    principal,
    workerId,
    leaseMs: configuredLeaseMs,
    timeoutMs: 120_000
  });
  const verified = assertWriteExecutionJob(readJob(root, workerId));
  const jobDigestBeforeReplay = recordDigest(readJob(root, workerId));
  const worktreeInventoryBeforeReplay = run(
    "git",
    ["worktree", "list", "--porcelain"],
    root
  );
  const replayRun = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), "--ready-replay"],
    {
      cwd: implementationSource.implementationRoot,
      env: {
        ...process.env,
        GROK_BIN: path.join(pluginData, "intentionally-absent-grok"),
        GROK_COMPANION_PLUGIN_DATA: pluginData,
        GROK_COMPANION_HOST: "codex",
        GROK_COMPANION_HOST_SESSION_ID: sessionId,
        CODEX_THREAD_ID: sessionId,
        GROK_COMPANION_READY_REPLAY_ROOT: root,
        GROK_COMPANION_READY_REPLAY_WORKER_ID: workerId,
        GROK_COMPANION_READY_REPLAY_SESSION_ID: sessionId
      },
      encoding: "utf8",
      shell: false,
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    }
  );
  if (replayRun.status !== 0 || replayRun.error) {
    throw new Error(
      "Ready replay subprocess did not complete without provider discovery."
    );
  }
  let replayEnvelope;
  try {
    replayEnvelope = JSON.parse(String(replayRun.stdout || ""));
  } catch {
    throw new Error("Ready replay subprocess did not return bounded JSON.");
  }
  const replay = replayEnvelope?.result;
  const jobDigestAfterReplay = recordDigest(readJob(root, workerId));
  const worktreeInventoryAfterReplay = run(
    "git",
    ["worktree", "list", "--porcelain"],
    root
  );
  if (replayEnvelope?.schemaVersion !== 1
    || replayEnvelope.outcome !== "passed"
    || replay?.workerId !== result.workerId
    || replay.operationId !== result.operationId
    || replay.bindingDigest !== result.bindingDigest
    || replay.receiptDigest !== result.receiptDigest
    || replay.cleanupProofDigest !== result.cleanupProofDigest
    || replay.journalDigest !== result.journalDigest
    || replay.ready !== true
    || replay.replayed !== true
    || replay.providerLaunched !== false
    || replay.workerDispatched !== false
    || result.replayed !== false
    || result.providerLaunched !== true
    || jobDigestAfterReplay !== jobDigestBeforeReplay
    || worktreeInventoryAfterReplay !== worktreeInventoryBeforeReplay) {
    throw new Error(
      "Ready replay changed durable evidence, worktree state, or provider authority."
    );
  }
  if (sha256File(path.join(root, "target.txt")) !== controlTargetDigest
    || sha256File(siblingCanary) !== siblingCanaryDigest
    || fs.existsSync(hookMarker)) {
    throw new Error(
      "Controller provisioning changed a control/sibling canary or executed a repository hook."
    );
  }
  console.log(JSON.stringify({
    schemaVersion: 1,
    outcome: "passed",
    implementationSource,
    leaseMs: configuredLeaseMs,
    root,
    pluginData,
    sessionId,
    workerId,
    executionRoot: verified.binding.expectedExecutionRoot,
    baseCommit: verified.binding.baseCommit,
    boundaryEvidence: {
      controlTargetUnchanged: true,
      siblingCanaryUnchanged: true,
      repositoryHookSuppressed: true,
      restartProcessUsed: true,
      intentionallyAbsentGrokBinIgnored: true,
      durableJobUnchangedOnReplay: true,
      worktreeInventoryUnchangedOnReplay: true
    },
    result,
    replay
  }));
} catch (error) {
  console.error(JSON.stringify({
    schemaVersion: 1,
    outcome: "failed",
    implementationSource,
    leaseMs: configuredLeaseMs,
    root,
    pluginData,
    sessionId,
    workerId,
    code: error?.code || null,
    message: error?.message || String(error),
    details: error?.details || null
  }));
  process.exitCode = 1;
}
}

if (process.argv.length === 3 && process.argv[2] === "--ready-replay") {
  await runReadyReplay();
} else if (process.argv.length === 2) {
  await runFreshProbe();
} else {
  throw new Error("Usage: live-worker-provisioner-probe.mjs [--ready-replay]");
}
