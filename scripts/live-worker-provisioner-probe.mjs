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
import { processGroupGone } from "../plugins/grok/scripts/lib/process-control.mjs";
import { loadProviderGuard } from "../plugins/grok/scripts/lib/recursion-guard.mjs";
import { provisionWriteWorkerWorktree } from "../plugins/grok/scripts/lib/worker-provisioner.mjs";
import { readJob } from "../plugins/grok/scripts/lib/state.mjs";
import { assertManagedWorkerWorktree } from "../plugins/grok/scripts/lib/worker-worktree.mjs";
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

async function runFreshProbe({ responseLoss = false } = {}) {
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
    const controllerHome = path.join(
      workspaceState(root),
      "task-homes",
      `${workerId}-provision`
    );
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
      || fs.existsSync(controllerHome)) {
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
} else if (process.argv.length === 2) {
  await runFreshProbe();
} else {
  throw new Error(
    "Usage: live-worker-provisioner-probe.mjs [--ready-replay|--response-loss|--response-loss-adopt]"
  );
}
