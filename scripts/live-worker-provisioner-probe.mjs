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

import { buildTaskEnvelope } from "../plugins/grok/scripts/lib/task-envelope.mjs";
import { admitWriteWorkerPlan } from "../plugins/grok/scripts/lib/worker-mutation-write-admission.mjs";
import { assertWriteExecutionJob } from "../plugins/grok/scripts/lib/worker-mutation-write-runtime-contract.mjs";
import { processGroupGone } from "../plugins/grok/scripts/lib/process-control.mjs";
import { loadProviderGuard } from "../plugins/grok/scripts/lib/recursion-guard.mjs";
import { provisionWriteWorkerWorktree } from "../plugins/grok/scripts/lib/worker-provisioner.mjs";
import { readJob } from "../plugins/grok/scripts/lib/state.mjs";
import {
  assertManagedWorkerWorktree,
  classifyWorkerWorktreeEffect
} from "../plugins/grok/scripts/lib/worker-worktree.mjs";
import { workspaceState } from "../plugins/grok/scripts/lib/workspace.mjs";

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

function worktreeInventoryRecords(inventory) {
  if (typeof inventory !== "string" || !inventory) return [];
  return inventory
    .split(/\n\n+/)
    .filter(Boolean)
    .map((record) => record.split("\n").filter(Boolean));
}

function assertExactWorktreeInventoryAddition({
  before,
  after,
  executionRoot,
  baseCommit
}) {
  const beforeRecords = worktreeInventoryRecords(before);
  const afterRecords = worktreeInventoryRecords(after);
  const target = afterRecords.filter((fields) => (
    fields.includes(`worktree ${executionRoot}`)
  ));
  const exactTarget = new Set([
    `worktree ${executionRoot}`,
    `HEAD ${baseCommit}`,
    "detached"
  ]);
  if (beforeRecords.some((fields) => fields.includes(`worktree ${executionRoot}`))
    || target.length !== 1
    || target[0].length !== exactTarget.size
    || target[0].some((field) => !exactTarget.has(field))) {
    throw new Error(
      "Official create did not add one exact detached worker registration."
    );
  }
  const normalize = (records) => records
    .map((fields) => fields.join("\n"))
    .sort();
  const remaining = afterRecords.filter((fields) => fields !== target[0]);
  if (JSON.stringify(normalize(remaining))
    !== JSON.stringify(normalize(beforeRecords))) {
    throw new Error(
      "Official create changed worktree registrations outside its exact worker addition."
    );
  }
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

function controllerClaimHomes(root, workerId) {
  const parent = path.join(workspaceState(root), "task-homes");
  try {
    return fs.readdirSync(parent)
      .filter((name) => (
        name === `${workerId}-provision`
        || name.startsWith(`${workerId}-provision-`)
      ))
      .map((name) => path.join(parent, name));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function assertControllerClaimHasNoCredential(home) {
  const grokHome = path.join(home, ".grok");
  const entries = fs.readdirSync(grokHome);
  if (entries.some((entry) => (
    entry === "auth.json" || entry.startsWith("auth.json.")
  ))) {
    throw new Error(
      "A pre-activation controller crash retained credential material."
    );
  }
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

function executableFile(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

function assertGrokDiscoveryUnavailable() {
  const configured = process.env.GROK_BIN;
  const configuredAuth = process.env.GROK_AUTH_PATH;
  const inlineAuth = process.env.GROK_AUTH_JSON;
  const homeCandidate = path.join(
    os.homedir(),
    ".grok",
    "bin",
    process.platform === "win32" ? "grok.exe" : "grok"
  );
  const homeAuthCandidate = path.join(os.homedir(), ".grok", "auth.json");
  const pathCandidates = String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(
      directory,
      process.platform === "win32" ? "grok.exe" : "grok"
    ));
  if (typeof configured !== "string"
    || !configured
    || executableFile(configured)
    || executableFile(homeCandidate)
    || pathCandidates.some(executableFile)
    || (typeof configuredAuth === "string" && configuredAuth)
    || (typeof inlineAuth === "string" && inlineAuth)
    || fs.existsSync(homeAuthCandidate)) {
    throw new Error(
      "Response-loss adoption subprocess still exposes Grok discovery or credentials."
    );
  }
  return Object.freeze({
    configuredCandidateAbsent: true,
    homeCandidateAbsent: true,
    pathCandidatesAbsent: true,
    configuredAuthAbsent: true,
    inlineAuthAbsent: true,
    homeAuthAbsent: true
  });
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
  const discovery = assertGrokDiscoveryUnavailable();
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
    discovery,
    result
  }));
}

async function runResponseLossAdoption() {
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
  const discovery = assertGrokDiscoveryUnavailable();
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
    discovery,
    result
  }));
}

async function runAbsenceReissue() {
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
    leaseMs: 240_000,
    timeoutMs: 120_000
  });
  console.log(JSON.stringify({
    schemaVersion: 1,
    outcome: "passed",
    processId: process.pid,
    result
  }));
}

async function runCrashAfterControllerEnvironment() {
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
  const marker = requiredReplayEnvironment(
    "GROK_COMPANION_REISSUE_CRASH_MARKER",
    { absolutePath: true }
  );
  await provisionWriteWorkerWorktree({
    root,
    principal: {
      hostKind: "codex",
      threadId: sessionId
    },
    workerId,
    leaseMs: 240_000,
    timeoutMs: 120_000,
    testHooks: {
      afterControllerEnvironmentConstructedBeforeIntent(observation) {
        const fd = fs.openSync(marker, "wx", 0o600);
        try {
          fs.writeFileSync(fd, `${JSON.stringify({
            schemaVersion: 1,
            processId: process.pid,
            ...observation
          })}\n`);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        process.kill(process.pid, "SIGKILL");
      }
    }
  });
  throw new Error(
    "Controller-environment crash subprocess returned instead of terminating."
  );
}

async function runCrashAfterReissuePlan() {
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
  const marker = requiredReplayEnvironment(
    "GROK_COMPANION_REISSUE_CRASH_MARKER",
    { absolutePath: true }
  );
  let environmentObservation = null;
  await provisionWriteWorkerWorktree({
    root,
    principal: {
      hostKind: "codex",
      threadId: sessionId
    },
    workerId,
    leaseMs: 240_000,
    timeoutMs: 120_000,
    testHooks: {
      afterControllerEnvironmentConstructedBeforeIntent(observation) {
        environmentObservation = observation;
      },
      afterReissueIntentCommittedBeforeBootstrapSpawn(observation) {
        if (observation?.reason !== "reissue-prepared") {
          throw new Error(
            "Crash seam did not observe the first durable reissue plan."
          );
        }
        const fd = fs.openSync(marker, "wx", 0o600);
        try {
          fs.writeFileSync(fd, `${JSON.stringify({
            schemaVersion: 1,
            processId: process.pid,
            home: environmentObservation?.home ?? null,
            ...observation
          })}\n`);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        process.kill(process.pid, "SIGKILL");
      }
    }
  });
  throw new Error(
    "Reissue-plan crash subprocess returned instead of terminating."
  );
}

async function runFreshProbe({
  responseLoss = false,
  absenceReissue = false
} = {}) {
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
  if (absenceReissue) {
    let preCreateObservation = null;
    let injectedFailure = null;
    try {
      await provisionWriteWorkerWorktree({
        root,
        principal,
        workerId,
        leaseMs: configuredLeaseMs,
        timeoutMs: 120_000,
        testHooks: {
          beforeOfficialCreate(observation) {
            if (observation?.reissue !== false
              || observation.executionRoot
                !== planned.binding.expectedExecutionRoot
              || observation.bindingDigest !== planned.binding.bindingDigest) {
              throw new Error(
                "Pre-create fault seam did not observe the exact first attempt."
              );
            }
            preCreateObservation = observation;
            const fault = new Error(
              "Injected live no-effect ambiguity before official create."
            );
            fault.code = "E_LIVE_NO_EFFECT";
            throw fault;
          }
        }
      });
      throw new Error(
        "Absence-reissue scenario unexpectedly returned its first result."
      );
    } catch (error) {
      injectedFailure = error;
    }
    if (!preCreateObservation
      || injectedFailure?.code !== "E_LIVE_NO_EFFECT") {
      const failure = new Error(
        `Real official controller did not reach the no-effect seam: ${
          injectedFailure?.code || "untyped"
        }: ${injectedFailure?.message || "unknown failure"}`
      );
      failure.details = injectedFailure?.details || null;
      throw failure;
    }

    const retainedJob = readJob(root, workerId);
    const retained = assertWriteExecutionJob(retainedJob);
    const retainedIntent = retained.provisioningRuntime.intent;
    const absentEffect = classifyWorkerWorktreeEffect({
      controlRoot: retained.binding.controlRoot,
      executionRoot: retained.binding.expectedExecutionRoot,
      baseCommit: retained.binding.baseCommit,
      workerId
    });
    if (retained.journal.state !== "cleanup_pending"
      || retainedJob.phase !== "worktree-cleanup-pending"
      || preCreateObservation.operationId !== retainedIntent.operationId
      || retained.provisioningRuntime.receipt !== null
      || retained.provisioningRuntime.hostAdoption !== null
      || !retained.provisioningRuntime.cleanupProof
      || absentEffect.classification !== "absent"
      || !absentEffect.evidence
      || !processGroupGone(retainedIntent.processIdentity)
      || loadProviderGuard(root, workerId) !== null
      || controllerClaimHomes(root, workerId).length !== 0) {
      throw new Error(
        "Pre-create ambiguity did not retain exact absent cleanup-pending evidence."
      );
    }

    const retainedJobDigest = recordDigest(retainedJob);
    const worktreeInventoryBeforeReissue = run(
      "git",
      ["worktree", "list", "--porcelain"],
      root
    );
    const reissueHome = fs.mkdtempSync(
      path.join(fixtureBase, "grok-worker-reissue-home-")
    );
    const reissueBin = fs.mkdtempSync(
      path.join(fixtureBase, "grok-worker-reissue-bin-")
    );
    const ambientGit = run(
      "which",
      ["git"],
      implementationSource.implementationRoot
    );
    const exactGit = fs.realpathSync(ambientGit);
    fs.symlinkSync(exactGit, path.join(reissueBin, "git"));
    const gitInstallationBin = path.dirname(ambientGit);
    if (executableFile(path.join(gitInstallationBin, "grok"))) {
      throw new Error(
        "Trusted Git installation bin unexpectedly exposes Grok discovery."
      );
    }
    const safePath = [
      gitInstallationBin,
      reissueBin,
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin"
    ].join(path.delimiter);
    const exactGrok = process.env.GROK_BIN;
    if (!exactGrok || !path.isAbsolute(exactGrok) || !executableFile(exactGrok)) {
      throw new Error(
        "Absence-reissue live gate requires an explicit executable GROK_BIN."
      );
    }
    const authPath = process.env.GROK_AUTH_PATH
      || path.join(os.homedir(), ".grok", "auth.json");
    if (!path.isAbsolute(authPath) || !fs.existsSync(authPath)) {
      throw new Error(
        "Absence-reissue live gate requires one explicit existing Grok auth file."
      );
    }
    const childBaseEnv = {
      ...process.env,
      HOME: reissueHome,
      PATH: safePath,
      GROK_BIN: exactGrok,
      GROK_AUTH_PATH: authPath,
      GROK_COMPANION_PLUGIN_DATA: pluginData,
      GROK_COMPANION_HOST: "codex",
      GROK_COMPANION_HOST_SESSION_ID: sessionId,
      CODEX_THREAD_ID: sessionId,
      GROK_COMPANION_READY_REPLAY_ROOT: root,
      GROK_COMPANION_READY_REPLAY_WORKER_ID: workerId,
      GROK_COMPANION_READY_REPLAY_SESSION_ID: sessionId
    };
    for (const credentialName of [
      "XAI_API_KEY",
      "GROK_API_KEY",
      "GROK_API_TOKEN",
      "GROK_AUTH_JSON"
    ]) {
      delete childBaseEnv[credentialName];
    }
    const preIntentCrashMarker = path.join(
      fixtureBase,
      `reissue-environment-crash-${workerId}-${
        crypto.randomBytes(8).toString("hex")
      }.json`
    );
    const preIntentCrashRun = spawnSync(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        "--absence-reissue-crash-after-environment"
      ],
      {
        cwd: implementationSource.implementationRoot,
        env: {
          ...childBaseEnv,
          GROK_COMPANION_REISSUE_CRASH_MARKER: preIntentCrashMarker
        },
        encoding: "utf8",
        shell: false,
        timeout: 60_000,
        maxBuffer: 1024 * 1024
      }
    );
    if (preIntentCrashRun.signal !== "SIGKILL"
      || preIntentCrashRun.status !== null
      || preIntentCrashRun.error
      || !fs.existsSync(preIntentCrashMarker)) {
      throw new Error(
        "Fresh reissue controller did not terminate at the pre-intent environment crash seam."
      );
    }
    const preIntentCrashObservation = JSON.parse(
      fs.readFileSync(preIntentCrashMarker, "utf8")
    );
    fs.unlinkSync(preIntentCrashMarker);
    const jobAfterPreIntentCrash = readJob(root, workerId);
    const homesAfterPreIntentCrash = controllerClaimHomes(root, workerId);
    const inventoryAfterPreIntentCrash = run(
      "git",
      ["worktree", "list", "--porcelain"],
      root
    );
    if (preIntentCrashObservation.schemaVersion !== 1
      || preIntentCrashObservation.processId === process.pid
      || preIntentCrashObservation.workerId !== workerId
      || !homesAfterPreIntentCrash.includes(preIntentCrashObservation.home)
      || homesAfterPreIntentCrash.length !== 1
      || recordDigest(jobAfterPreIntentCrash) !== retainedJobDigest
      || inventoryAfterPreIntentCrash !== worktreeInventoryBeforeReissue
      || loadProviderGuard(root, workerId) !== null) {
      throw new Error(
        "Killed pre-intent controller changed durable state or lost its exact claim root."
      );
    }
    assertControllerClaimHasNoCredential(preIntentCrashObservation.home);

    const crashMarker = path.join(
      fixtureBase,
      `reissue-plan-crash-${workerId}-${crypto.randomBytes(8).toString("hex")}.json`
    );
    const crashRun = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "--absence-reissue-crash-after-plan"],
      {
        cwd: implementationSource.implementationRoot,
        env: {
          ...childBaseEnv,
          GROK_COMPANION_REISSUE_CRASH_MARKER: crashMarker
        },
        encoding: "utf8",
        shell: false,
        timeout: 60_000,
        maxBuffer: 1024 * 1024
      }
    );
    if (crashRun.signal !== "SIGKILL"
      || crashRun.status !== null
      || crashRun.error
      || !fs.existsSync(crashMarker)) {
      throw new Error(
        "Fresh reissue planner did not terminate at the durable pre-spawn crash seam."
      );
    }
    const crashObservation = JSON.parse(
      fs.readFileSync(crashMarker, "utf8")
    );
    fs.unlinkSync(crashMarker);
    const crashPlannedJob = readJob(root, workerId);
    const crashPlanned = assertWriteExecutionJob(crashPlannedJob);
    const crashIntent = crashPlanned.provisioningRuntime.intent;
    const inventoryAfterPlannerCrash = run(
      "git",
      ["worktree", "list", "--porcelain"],
      root
    );
    const homesAfterPlannerCrash = controllerClaimHomes(root, workerId);
    if (crashObservation.schemaVersion !== 1
      || crashObservation.processId === process.pid
      || crashObservation.reason !== "reissue-prepared"
      || typeof crashObservation.home !== "string"
      || !homesAfterPlannerCrash.includes(crashObservation.home)
      || homesAfterPlannerCrash.length !== 1
      || crashObservation.operationId !== retainedIntent.operationId
      || crashObservation.journalDigest
        !== crashPlanned.journal.journalDigest
      || crashObservation.providerSpawnIntentId
        !== crashIntent.providerSpawnIntentId
      || crashPlanned.journal.state !== "reissue_planned"
      || crashPlanned.provisioningRuntime.priorAttempts.length !== 1
      || crashIntent.status !== "pending"
      || crashIntent.processIdentity !== null
      || crashIntent.operationId !== retainedIntent.operationId
      || crashIntent.provisioningFence
        !== retainedIntent.provisioningFence + 1
      || loadProviderGuard(root, workerId) !== null
      || fs.existsSync(crashPlanned.binding.expectedExecutionRoot)
      || inventoryAfterPlannerCrash !== worktreeInventoryBeforeReissue) {
      throw new Error(
        "Killed reissue planner did not leave one exact inactive durable plan."
      );
    }
    assertControllerClaimHasNoCredential(crashObservation.home);
    const reissueRun = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "--absence-reissue-run"],
      {
        cwd: implementationSource.implementationRoot,
        env: childBaseEnv,
        encoding: "utf8",
        shell: false,
        timeout: 180_000,
        maxBuffer: 1024 * 1024
      }
    );
    if (reissueRun.status !== 0 || reissueRun.error) {
      const failure = new Error(
        "Fresh-process official reissue did not complete."
      );
      failure.details = { stderrPresent: Boolean(reissueRun.stderr) };
      throw failure;
    }
    let reissueEnvelope;
    try {
      reissueEnvelope = JSON.parse(String(reissueRun.stdout || ""));
    } catch {
      throw new Error("Fresh-process official reissue did not return bounded JSON.");
    }
    const result = reissueEnvelope?.result;
    const readyJob = readJob(root, workerId);
    const ready = assertWriteExecutionJob(readyJob);
    const currentIntent = ready.provisioningRuntime.intent;
    const archive = ready.provisioningRuntime.priorAttempts?.at(-1);
    assertManagedWorkerWorktree({
      controlRoot: ready.binding.controlRoot,
      executionRoot: ready.binding.expectedExecutionRoot,
      baseCommit: ready.binding.baseCommit,
      workerId
    });
    if (reissueEnvelope?.schemaVersion !== 1
      || reissueEnvelope.outcome !== "passed"
      || reissueEnvelope.processId === process.pid
      || result?.officialStatus !== "created"
      || result.operationId !== retainedIntent.operationId
      || result.bindingDigest !== retained.binding.bindingDigest
      || result.priorAttemptArchiveDigest !== archive?.archiveDigest
      || result.absenceProofDigest !== archive?.absenceProof?.proofDigest
      || result.provisioningAttemptCount !== 2
      || result.providerLaunched !== true
      || result.workerDispatched !== false
      || ready.journal.state !== "ready"
      || ready.provisioningRuntime.priorAttempts.length !== 1
      || archive.sourceCleanupPendingJournal.journalDigest
        !== retained.journal.journalDigest
      || archive.attemptEvidence.intent.intentDigest !== retainedIntent.intentDigest
      || archive.attemptEvidence.cleanupProof.proofDigest
        !== retained.provisioningRuntime.cleanupProof.proofDigest
      || archive.absenceProof.classification !== "absent"
      || archive.absenceProof.exactRegistrationCount !== 0
      || archive.absenceProof.managedParentRegistrationCount !== 0
      || archive.absenceProof.adminBacklinkMatchCount !== 0
      || currentIntent.operationId !== retainedIntent.operationId
      || currentIntent.provisioningAttemptId
        === retainedIntent.provisioningAttemptId
      || currentIntent.provisioningFence !== retainedIntent.provisioningFence + 1
      || currentIntent.holderId === retainedIntent.holderId
      || currentIntent.providerSpawnIntentId
        === retainedIntent.providerSpawnIntentId
      || currentIntent.provisioningAttemptId
        !== crashIntent.provisioningAttemptId
      || currentIntent.provisioningFence
        !== crashIntent.provisioningFence
      || currentIntent.holderId === crashIntent.holderId
      || currentIntent.providerSpawnIntentId
        === crashIntent.providerSpawnIntentId
      || currentIntent.executableIdentity.identityDigest
        === crashIntent.executableIdentity.identityDigest
      || currentIntent.executableIdentity.releaseIdentityDigest
        !== crashIntent.executableIdentity.releaseIdentityDigest
      || (
        currentIntent.processIdentity.pid === retainedIntent.processIdentity.pid
        && currentIntent.processIdentity.startToken
          === retainedIntent.processIdentity.startToken
        && currentIntent.processIdentity.processGroupId
          === retainedIntent.processIdentity.processGroupId
      )
      || currentIntent.executableIdentity.identityDigest
        === retainedIntent.executableIdentity.identityDigest
      || currentIntent.executableIdentity.releaseIdentityDigest
        !== retainedIntent.executableIdentity.releaseIdentityDigest
      || retainedJobDigest === recordDigest(readyJob)
      || !processGroupGone(currentIntent.processIdentity)
      || loadProviderGuard(root, workerId) !== null
      || controllerClaimHomes(root, workerId).length !== 0) {
      throw new Error(
        "Fresh-process reissue changed operation identity or lacked exact fenced evidence."
      );
    }

    const readyJobDigest = recordDigest(readyJob);
    const worktreeInventoryAfterReissue = run(
      "git",
      ["worktree", "list", "--porcelain"],
      root
    );
    assertExactWorktreeInventoryAddition({
      before: worktreeInventoryBeforeReissue,
      after: worktreeInventoryAfterReissue,
      executionRoot: ready.binding.expectedExecutionRoot,
      baseCommit: ready.binding.baseCommit
    });
    const replayHome = fs.mkdtempSync(
      path.join(fixtureBase, "grok-worker-reissue-replay-home-")
    );
    const replayEnv = {
      ...childBaseEnv,
      HOME: replayHome,
      GROK_BIN: path.join(replayHome, "intentionally-absent-grok")
    };
    for (const credentialName of [
      "XAI_API_KEY",
      "GROK_API_KEY",
      "GROK_API_TOKEN",
      "GROK_AUTH_PATH",
      "GROK_AUTH_JSON"
    ]) {
      delete replayEnv[credentialName];
    }
    const replayRun = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "--ready-replay"],
      {
        cwd: implementationSource.implementationRoot,
        env: replayEnv,
        encoding: "utf8",
        shell: false,
        timeout: 30_000,
        maxBuffer: 1024 * 1024
      }
    );
    if (replayRun.status !== 0 || replayRun.error) {
      throw new Error(
        "Absence-reissue ready replay did not complete without provider discovery."
      );
    }
    let replayEnvelope;
    try {
      replayEnvelope = JSON.parse(String(replayRun.stdout || ""));
    } catch {
      throw new Error("Absence-reissue replay did not return bounded JSON.");
    }
    const replay = replayEnvelope?.result;
    const worktreeInventoryAfterReplay = run(
      "git",
      ["worktree", "list", "--porcelain"],
      root
    );
    if (replayEnvelope?.schemaVersion !== 1
      || replayEnvelope.outcome !== "passed"
      || !replayEnvelope.discovery
      || Object.values(replayEnvelope.discovery).some((value) => value !== true)
      || replay?.operationId !== result.operationId
      || replay.priorAttemptArchiveDigest !== result.priorAttemptArchiveDigest
      || replay.absenceProofDigest !== result.absenceProofDigest
      || replay.provisioningAttemptCount !== 2
      || replay.receiptDigest !== result.receiptDigest
      || replay.journalDigest !== result.journalDigest
      || replay.ready !== true
      || replay.replayed !== true
      || replay.providerLaunched !== false
      || replay.workerDispatched !== false
      || recordDigest(readJob(root, workerId)) !== readyJobDigest
      || worktreeInventoryAfterReplay !== worktreeInventoryAfterReissue) {
      throw new Error(
        "Absence-reissue replay changed durable evidence or relaunched a provider."
      );
    }
    if (sha256File(path.join(root, "target.txt")) !== controlTargetDigest
      || sha256File(siblingCanary) !== siblingCanaryDigest
      || fs.existsSync(hookMarker)) {
      throw new Error(
        "Absence-reissue changed a control/sibling canary or executed a repository hook."
      );
    }
    const finalImplementationSource = sourceIdentity();
    if (recordDigest(finalImplementationSource)
      !== recordDigest(implementationSource)) {
      throw new Error(
        "Implementation source identity changed during the live absence-reissue gate."
      );
    }
    const archiveEvidence = {
      ordinal: archive.ordinal,
      archiveDigest: archive.archiveDigest,
      previousArchiveDigest: archive.previousArchiveDigest,
      sourceCleanupPendingJournalDigest:
        archive.sourceCleanupPendingJournal.journalDigest,
      priorIntentDigest: archive.attemptEvidence.intent.intentDigest,
      cleanupProofDigest:
        archive.attemptEvidence.cleanupProof.proofDigest,
      absenceProofDigest: archive.absenceProof.proofDigest,
      archivedAt: archive.archivedAt
    };
    console.log(JSON.stringify({
      schemaVersion: 1,
      outcome: "passed",
      scenario: "official-no-effect-absence-proven-reissue",
      implementationSource,
      leaseMs: configuredLeaseMs,
      root,
      pluginData,
      sessionId,
      workerId,
      executionRoot: ready.binding.expectedExecutionRoot,
      baseCommit: ready.binding.baseCommit,
      boundaryEvidence: {
        firstOfficialControllerStarted: true,
        firstAcpCreateNotInvoked: true,
        firstControllerCleanupProven: true,
        firstControllerHomeRemoved: true,
        freshReissueProcessUsed: true,
        preIntentControllerProcessKilled: true,
        preIntentDurableJobUnchanged: true,
        preIntentCredentialNeverPublished: true,
        staleProcessLeaseReclaimed: true,
        staleNonSecretClaimRootRemoved: true,
        durableReissuePlanSurvivedHostProcessDeath: true,
        inactiveReissuePlanAtomicallyReauthorized: true,
        freshControllerIdentityVerified: true,
        freshExecutableInstanceVerified: true,
        rawGitAndFilesystemAbsenceProven: true,
        sameOperationIdentityPreserved: true,
        freshFenceAndSpawnIntentUsed: true,
        secondRealOfficialCreateReturned: true,
        secondOfficialStatusCreated: true,
        secondControllerCleanupProven: true,
        readyReplayProviderUnavailable: true,
        durableJobUnchangedOnReplay: true,
        worktreeInventoryUnchangedOnReplay: true,
        exactWorktreeInventoryAdditionVerified: true,
        implementationSourceStableThroughRun: true,
        controlTargetUnchanged: true,
        siblingCanaryUnchanged: true,
        repositoryHookSuppressed: true
      },
      firstAttempt: {
        code: injectedFailure.code,
        operationId: retainedIntent.operationId,
        providerSpawnIntentId: retainedIntent.providerSpawnIntentId,
        provisioningAttemptId: retainedIntent.provisioningAttemptId,
        provisioningFence: retainedIntent.provisioningFence,
        cleanupPendingJournalDigest: retained.journal.journalDigest,
        cleanupProofDigest:
          retained.provisioningRuntime.cleanupProof.proofDigest,
        initialAbsenceProofDigest: absentEffect.evidence.proofDigest,
        worktreeInventoryDigest: crypto
          .createHash("sha256")
          .update(worktreeInventoryBeforeReissue)
          .digest("hex")
      },
      restartEvidence: {
        preIntentCrashedProcessId:
          preIntentCrashObservation.processId,
        preIntentClaimHomeDigest: crypto
          .createHash("sha256")
          .update(preIntentCrashObservation.home)
          .digest("hex"),
        crashedPlannerProcessId: crashObservation.processId,
        durablePlanJournalDigest: crashPlanned.journal.journalDigest,
        durablePlanIntentDigest: crashIntent.intentDigest,
        reauthorizedIntentDigest: currentIntent.intentDigest,
        provisioningAttemptId: currentIntent.provisioningAttemptId,
        provisioningFence: currentIntent.provisioningFence,
        priorAttemptArchiveDigest:
          crashPlanned.journal.priorAttemptArchiveDigest
      },
      archiveEvidence,
      result,
      replay
    }));
    return;
  }
  if (responseLoss) {
    let createObservation = null;
    let injectedFailure = null;
    try {
      await provisionWriteWorkerWorktree({
        root,
        principal,
        workerId,
        leaseMs: configuredLeaseMs,
        timeoutMs: 120_000,
        testHooks: {
          afterOfficialCreateBeforeReceipt(observation) {
            if (observation?.created?.status !== "created"
              || observation.executionRoot
                !== planned.binding.expectedExecutionRoot
              || observation.bindingDigest !== planned.binding.bindingDigest) {
              throw new Error(
                "Post-create fault seam did not observe the exact fresh operation."
              );
            }
            createObservation = observation;
            const fault = new Error(
              "Injected live response loss after official create and before receipt."
            );
            fault.code = "E_LIVE_RESPONSE_LOSS";
            throw fault;
          }
        }
      });
      throw new Error(
        "Response-loss scenario unexpectedly returned a provisioner result."
      );
    } catch (error) {
      injectedFailure = error;
    }
    if (!createObservation
      || injectedFailure?.code !== "E_LIVE_RESPONSE_LOSS") {
      const failure = new Error(
        `Real official create did not reach the exact response-loss seam: ${
          injectedFailure?.code || "untyped"
        }: ${injectedFailure?.message || "unknown failure"}`
      );
      failure.details = injectedFailure?.details || null;
      throw failure;
    }

    const retainedJob = readJob(root, workerId);
    const retained = assertWriteExecutionJob(retainedJob);
    const retainedIntent = retained.provisioningRuntime.intent;
    assertManagedWorkerWorktree({
      controlRoot: retained.binding.controlRoot,
      executionRoot: retained.binding.expectedExecutionRoot,
      baseCommit: retained.binding.baseCommit,
      workerId
    });
    if (retained.journal.state !== "cleanup_pending"
      || retainedJob.phase !== "worktree-cleanup-pending"
      || createObservation.operationId !== retainedIntent.operationId
      || retained.provisioningRuntime.receipt !== null
      || retained.provisioningRuntime.hostAdoption !== null
      || !retained.provisioningRuntime.cleanupProof
      || !processGroupGone(retainedIntent.processIdentity)
      || loadProviderGuard(root, workerId) !== null
      || controllerClaimHomes(root, workerId).length !== 0) {
      throw new Error(
        "Response loss did not retain an exact, controller-clean cleanup-pending state."
      );
    }

    const retainedJobDigest = recordDigest(retainedJob);
    const worktreeInventoryBeforeAdoption = run(
      "git",
      ["worktree", "list", "--porcelain"],
      root
    );
    const adoptionHome = fs.mkdtempSync(
      path.join(fixtureBase, "grok-worker-response-loss-home-")
    );
    const adoptionBin = fs.mkdtempSync(
      path.join(fixtureBase, "grok-worker-response-loss-bin-")
    );
    const ambientGit = run("which", ["git"], implementationSource.implementationRoot);
    const exactGit = fs.realpathSync(ambientGit);
    fs.symlinkSync(exactGit, path.join(adoptionBin, "git"));
    const safePath = [
      adoptionBin,
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin"
    ].join(path.delimiter);
    const safeGit = spawnSync("git", ["--version"], {
      env: { ...process.env, HOME: adoptionHome, PATH: safePath },
      encoding: "utf8",
      shell: false,
      timeout: 10_000
    });
    if (safeGit.status !== 0 || safeGit.error) {
      throw new Error(
        "Provider-impossible adoption environment lost its Git capability."
      );
    }
    const adoptionEnv = {
      ...process.env,
      HOME: adoptionHome,
      PATH: safePath,
      GROK_BIN: path.join(adoptionHome, "intentionally-absent-grok"),
      GROK_COMPANION_PLUGIN_DATA: pluginData,
      GROK_COMPANION_HOST: "codex",
      GROK_COMPANION_HOST_SESSION_ID: sessionId,
      CODEX_THREAD_ID: sessionId,
      GROK_COMPANION_READY_REPLAY_ROOT: root,
      GROK_COMPANION_READY_REPLAY_WORKER_ID: workerId,
      GROK_COMPANION_READY_REPLAY_SESSION_ID: sessionId
    };
    for (const credentialName of [
      "XAI_API_KEY",
      "GROK_API_KEY",
      "GROK_API_TOKEN",
      "GROK_AUTH_PATH",
      "GROK_AUTH_JSON"
    ]) {
      delete adoptionEnv[credentialName];
    }
    const runAdoption = () => spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "--response-loss-adopt"],
      {
        cwd: implementationSource.implementationRoot,
        env: adoptionEnv,
        encoding: "utf8",
        shell: false,
        timeout: 30_000,
        maxBuffer: 1024 * 1024
      }
    );
    const parseAdoption = (runResult, label) => {
      if (runResult.status !== 0 || runResult.error) {
        throw new Error(`${label} did not complete without provider discovery.`);
      }
      let envelope;
      try {
        envelope = JSON.parse(String(runResult.stdout || ""));
      } catch {
        throw new Error(`${label} did not return bounded JSON.`);
      }
      if (envelope?.schemaVersion !== 1
        || envelope.outcome !== "passed"
        || envelope.discovery?.configuredCandidateAbsent !== true
        || envelope.discovery?.homeCandidateAbsent !== true
        || envelope.discovery?.pathCandidatesAbsent !== true
        || envelope.discovery?.configuredAuthAbsent !== true
        || envelope.discovery?.inlineAuthAbsent !== true
        || envelope.discovery?.homeAuthAbsent !== true) {
        throw new Error(`${label} did not prove provider discovery unavailable.`);
      }
      return envelope.result;
    };

    const adoption = parseAdoption(runAdoption(), "Response-loss adoption");
    const adoptedJob = readJob(root, workerId);
    const adopted = assertWriteExecutionJob(adoptedJob);
    const adoptedJobDigest = recordDigest(adoptedJob);
    const worktreeInventoryAfterAdoption = run(
      "git",
      ["worktree", "list", "--porcelain"],
      root
    );
    if (adoption.workerId !== workerId
      || adoption.operationId !== retainedIntent.operationId
      || adoption.bindingDigest !== retained.binding.bindingDigest
      || adoption.officialStatus !== null
      || adoption.receiptDigest !== null
      || !/^[0-9a-f]{64}$/.test(adoption.hostAdoptionDigest || "")
      || adoption.recovery !== "host-adopted-unknown-official-response"
      || adoption.ready !== true
      || adoption.replayed !== false
      || adoption.providerLaunched !== false
      || adoption.workerDispatched !== false
      || adopted.journal.state !== "ready"
      || adopted.journal.previousJournalDigest !== retained.journal.journalDigest
      || adopted.provisioningRuntime.receipt !== null
      || adopted.provisioningRuntime.hostAdoption?.adoptionDigest
        !== adoption.hostAdoptionDigest
      || retainedJobDigest === adoptedJobDigest
      || worktreeInventoryAfterAdoption !== worktreeInventoryBeforeAdoption) {
      throw new Error(
        "Fresh-process host adoption changed effect identity or claimed official/provider authority."
      );
    }

    const replay = parseAdoption(runAdoption(), "Host-adoption ready replay");
    const replayedJobDigest = recordDigest(readJob(root, workerId));
    const worktreeInventoryAfterReplay = run(
      "git",
      ["worktree", "list", "--porcelain"],
      root
    );
    if (replay.workerId !== adoption.workerId
      || replay.operationId !== adoption.operationId
      || replay.bindingDigest !== adoption.bindingDigest
      || replay.hostAdoptionDigest !== adoption.hostAdoptionDigest
      || replay.cleanupProofDigest !== adoption.cleanupProofDigest
      || replay.journalDigest !== adoption.journalDigest
      || replay.officialStatus !== null
      || replay.receiptDigest !== null
      || replay.ready !== true
      || replay.replayed !== true
      || replay.providerLaunched !== false
      || replay.workerDispatched !== false
      || replayedJobDigest !== adoptedJobDigest
      || worktreeInventoryAfterReplay !== worktreeInventoryAfterAdoption) {
      throw new Error(
        "Host-adoption replay changed durable evidence, worktree state, or provider authority."
      );
    }
    if (sha256File(path.join(root, "target.txt")) !== controlTargetDigest
      || sha256File(siblingCanary) !== siblingCanaryDigest
      || fs.existsSync(hookMarker)) {
      throw new Error(
        "Response-loss provisioning changed a control/sibling canary or executed a repository hook."
      );
    }
    console.log(JSON.stringify({
      schemaVersion: 1,
      outcome: "passed",
      scenario: "official-create-response-loss-host-adoption",
      implementationSource,
      leaseMs: configuredLeaseMs,
      root,
      pluginData,
      sessionId,
      workerId,
      executionRoot: adopted.binding.expectedExecutionRoot,
      baseCommit: adopted.binding.baseCommit,
      boundaryEvidence: {
        realOfficialCreateReturned: true,
        durableOfficialReceiptAbsent: true,
        exactControllerCleanupProven: true,
        controllerHomeRemoved: true,
        freshProcessAdoptionUsed: true,
        providerDiscoveryUnavailable: true,
        providerCredentialsAbsent: true,
        providerRelaunchAvoided: true,
        worktreeInventoryUnchangedOnAdoption: true,
        durableJobUnchangedOnReplay: true,
        worktreeInventoryUnchangedOnReplay: true,
        controlTargetUnchanged: true,
        siblingCanaryUnchanged: true,
        repositoryHookSuppressed: true
      },
      responseLoss: {
        code: injectedFailure.code,
        operationId: createObservation.operationId,
        officialStatus: createObservation.created.status,
        providerSpawnIntentId: retainedIntent.providerSpawnIntentId,
        registeredControllerExecutableIdentity:
          retainedIntent.executableIdentity,
        cleanupPendingJournalDigest: retained.journal.journalDigest,
        cleanupProofDigest:
          retained.provisioningRuntime.cleanupProof.proofDigest
      },
      adoption,
      replay
    }));
    return;
  }
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
    details: error?.details && typeof error.details === "object"
      ? {
          keys: Object.keys(error.details)
            .filter((key) => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key))
            .slice(0, 16)
        }
      : null
  }));
  process.exitCode = 1;
}
}

if (process.argv.length === 3 && process.argv[2] === "--ready-replay") {
  await runReadyReplay();
} else if (
  process.argv.length === 3
  && process.argv[2] === "--response-loss-adopt"
) {
  await runResponseLossAdoption();
} else if (
  process.argv.length === 3
  && process.argv[2] === "--response-loss"
) {
  await runFreshProbe({ responseLoss: true });
} else if (
  process.argv.length === 3
  && process.argv[2] === "--absence-reissue-run"
) {
  await runAbsenceReissue();
} else if (
  process.argv.length === 3
  && process.argv[2] === "--absence-reissue-crash-after-environment"
) {
  await runCrashAfterControllerEnvironment();
} else if (
  process.argv.length === 3
  && process.argv[2] === "--absence-reissue-crash-after-plan"
) {
  await runCrashAfterReissuePlan();
} else if (
  process.argv.length === 3
  && process.argv[2] === "--absence-reissue"
) {
  await runFreshProbe({ absenceReissue: true });
} else if (process.argv.length === 2) {
  await runFreshProbe();
} else {
  throw new Error(
    "Usage: live-worker-provisioner-probe.mjs [--ready-replay|--response-loss|--response-loss-adopt|--absence-reissue|--absence-reissue-run|--absence-reissue-crash-after-environment|--absence-reissue-crash-after-plan]"
  );
}
