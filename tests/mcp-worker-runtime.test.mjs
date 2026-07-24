import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  createMcpBrokerRuntime,
  handleMcpRequest
} from "../plugins/grok/mcp/broker.mjs";
import { ROOT_READ_PROVIDER_CAPABILITY } from "../plugins/grok/scripts/lib/provider-capability.mjs";
import {
  assertDispatchContract,
  authorizeWorkerProviderRotation,
  claimWorkerDispatch,
  prepareDispatchProcessSpawn,
  providerLaunchState,
  recordUnsettledProviderProcess,
  settleProviderStartedWorkerFinalization,
  settlePreProviderWorkerFinalization,
  spawnReadOnlyWorker,
  transitionWorkerDispatch
} from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import {
  launchCommittedWorker,
  trustedWorkerEnvironment
} from "../plugins/grok/scripts/lib/worker-runtime.mjs";
import {
  reconcileBrokerWorkers,
  recoverLostProviderStartedWorker
} from "../plugins/grok/scripts/lib/worker-recovery.mjs";
import { processGroupGone, processStartToken } from "../plugins/grok/scripts/lib/process-control.mjs";
import {
  loadProviderGuard,
  registerProviderGuard,
  unregisterProviderGuard
} from "../plugins/grok/scripts/lib/recursion-guard.mjs";
import { materializeRole } from "../plugins/grok/scripts/lib/worker-roles.mjs";
import { buildTaskEnvelope } from "../plugins/grok/scripts/lib/task-contract.mjs";
import {
  cancelFile,
  tryReadJob,
  updateJob
} from "../plugins/grok/scripts/lib/state.mjs";
import { workspaceState } from "../plugins/grok/scripts/lib/workspace.mjs";

import { installFakeGrok, readFakeLog } from "./fake-grok.mjs";
import { git, initRepo, tempDir, waitFor } from "./helpers.mjs";

const THREAD_ID = "019f666a-6469-7cc1-9a8d-8c1adf61e103";
const TURN_ID = "019f666e-4084-7902-8447-249f72043a37";
let requestId = 0;
const TEST_PROVIDER_RECEIPT = Object.freeze({
  capabilityDigest: "c".repeat(64),
  capabilities: [ROOT_READ_PROVIDER_CAPABILITY]
});
const TEST_BROKER_RUNTIME = createMcpBrokerRuntime({
  providerCapabilityReceipt: TEST_PROVIDER_RECEIPT
});

function taskReport(summary = "Fake broker task completed", extra = {}) {
  return `GROK_WORKER_REPORT: ${JSON.stringify({
    outcome: "complete",
    summary,
    changedFiles: [],
    checksClaimed: [],
    acceptanceResults: ["AC-01", "AC-02"].map((id) => ({ id, status: "met" })),
    risks: [],
    questions: [],
    ...extra
  })}`;
}

function metadata(root) {
  return {
    threadId: THREAD_ID,
    plugin_id: "grok@grok-companion",
    "x-codex-turn-metadata": {
      thread_id: THREAD_ID,
      turn_id: TURN_ID,
      plugin_id: "grok@grok-companion"
    },
    "codex/sandbox-state-meta": {
      permissionProfile: { type: "read-only" },
      sandboxCwd: pathToFileURL(root).href,
      useLegacyLandlock: false
    }
  };
}

function fixture(config = {}) {
  const root = initRepo();
  const fake = installFakeGrok(tempDir("fake-grok-mcp-runtime-"), {
    taskText: taskReport(),
    ...config
  });
  const pluginData = tempDir("grok-mcp-runtime-data-");
  const env = {
    ...process.env,
    HOME: path.dirname(pluginData),
    PLUGIN_DATA: pluginData,
    GROK_BIN: fake.binary,
    GROK_AUTH_PATH: fake.authPath,
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_HOST_SESSION_ID: THREAD_ID,
    CODEX_THREAD_ID: THREAD_ID
  };
  delete env.GROK_COMPANION_PLUGIN_DATA;
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.GROK_COMPANION_CHILD;
  delete env.GROK_COMPANION_JOB_MARKER;
  delete env.GROK_AGENT;
  delete env.GROK_LEADER_SOCKET;
  return { root, fake, pluginData, env };
}

async function rawTool(root, name, args, options) {
  const reply = await handleMcpRequest({
    jsonrpc: "2.0",
    id: ++requestId,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      _meta: metadata(root)
    }
  }, {
    ...options,
    runtime: options?.runtime || TEST_BROKER_RUNTIME,
    readProviderCapabilityReceipt: options?.readProviderCapabilityReceipt
      || (() => TEST_PROVIDER_RECEIPT)
  });
  return reply.result;
}

async function callTool(root, name, args, options) {
  const result = await rawTool(root, name, args, options);
  assert.equal(result?.isError, undefined, JSON.stringify(result));
  assert.equal(result?.structuredContent?.ok, true, JSON.stringify(result));
  return result.structuredContent;
}

async function waitForTerminal(root, workerId, options, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let cursor = null;
  while (Date.now() < deadline) {
    const page = await callTool(root, "worker_wait", {
      id: workerId,
      ...(cursor ? { cursor } : {}),
      timeoutMs: Math.min(1000, Math.max(0, deadline - Date.now()))
    }, options);
    cursor = page.stream.nextCursor;
    if (page.stream.terminal) return page.stream;
  }
  throw new Error(`Timed out waiting for worker ${workerId}.`);
}

function identities(job) {
  return [job?.controllerProcess, job?.workerProcess, job?.providerProcess].filter(Boolean);
}

async function assertAllProcessesGone(job) {
  await waitFor(
    () => identities(job).every((identity) => processGroupGone(identity)),
    { timeoutMs: 10_000, intervalMs: 50 }
  );
}

function emergencyStop(job) {
  for (const identity of identities(job)) {
    try {
      if (!processGroupGone(identity)
        && processStartToken(identity.pid) === identity.startToken) {
        process.kill(process.platform === "win32" ? identity.pid : -identity.processGroupId, "SIGKILL");
      }
    } catch {}
  }
}

function deleteAllContextBindingFields(job) {
  const tampered = structuredClone(job);
  for (const field of [
    "contextBindingMode",
    "contextPacket",
    "runtimeRolePolicy",
    "contextReceipt"
  ]) {
    delete tampered.request[field];
  }
  return tampered;
}

function assertProviderPreparationCountZero(job, fake) {
  assert.equal(job.request?.spawn?.providerSpawnIntent, undefined);
  assert.equal(job.providerProcess == null, true);
  const providerLog = readFakeLog(fake.logFile);
  assert.equal(
    providerLog.filter((entry) => entry.event === "argv" && entry.args?.[0] === "agent").length,
    0
  );
  assert.equal(providerLog.filter((entry) => entry.event === "prompt").length, 0);
}

function installProviderStartedFixture({
  root,
  workerId,
  claim,
  controllerProcess,
  workerProcess,
  providerProcess,
  env
}) {
  const controllerIntent = prepareDispatchProcessSpawn({
    root,
    workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    processKind: "controller",
    nonce: claim.nonce,
    env
  }).intent;
  transitionWorkerDispatch({
    root,
    workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    state: "controller-started",
    controllerProcess,
    spawnIntentId: controllerIntent.intentId,
    env
  });
  const workerIntent = prepareDispatchProcessSpawn({
    root,
    workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    processKind: "worker",
    nonce: claim.nonce,
    env
  }).intent;
  transitionWorkerDispatch({
    root,
    workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    state: "worker-started",
    workerProcess,
    spawnIntentId: workerIntent.intentId,
    env
  });
  transitionWorkerDispatch({
    root,
    workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    state: "provider-started",
    providerProcess,
    env
  });
  return updateJob(root, workerId, (job) => ({
    ...job,
    status: "running",
    phase: "responding",
    workerAuthorization: null,
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        consumedLaunchContractDigest: job.workerAuthorization.launchContractDigest,
        launchContractConsumedAt: new Date().toISOString()
      }
    }
  }), env);
}

function spawnIdleProcess(t) {
  const child = spawnProcess(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    detached: true,
    stdio: "ignore"
  });
  t.after(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  });
  return child;
}

async function boundProcessIdentity(child, workerId, claim, extra = {}) {
  return {
    pid: child.pid,
    startToken: await waitFor(() => processStartToken(child.pid)),
    processGroupId: child.pid,
    nonce: claim.nonce,
    commandMarker: workerId,
    dispatchAttemptId: claim.attemptId,
    dispatchFence: claim.fence,
    ...extra
  };
}

async function activeProviderRecoveryFixture(t, label) {
  const { root, env } = fixture();
  const principal = { hostKind: "codex", threadId: THREAD_ID };
  const admitted = spawnReadOnlyWorker({
    root,
    principal,
    envelope: buildTaskEnvelope({ userRequest: `Recover ${label}`, mode: "read" }),
    idempotencyKey: `provider-recovery-${label}`,
    env
  });
  const workerId = admitted.handle.id;
  const claim = claimWorkerDispatch({ root, principal, workerId, env });
  const controllerChild = spawnIdleProcess(t);
  const workerChild = spawnIdleProcess(t);
  const providerChild = spawnIdleProcess(t);
  const controllerProcess = await boundProcessIdentity(controllerChild, workerId, claim);
  const workerProcess = await boundProcessIdentity(workerChild, workerId, claim);
  const providerProcess = await boundProcessIdentity(providerChild, workerId, claim, {
    nonce: undefined,
    providerGeneration: 1
  });
  installProviderStartedFixture({
    root,
    workerId,
    claim,
    controllerProcess,
    workerProcess,
    providerProcess,
    env
  });
  for (const child of [controllerChild, workerChild]) process.kill(-child.pid, "SIGKILL");
  await waitFor(
    () => [controllerProcess, workerProcess].every((identity) => processGroupGone(identity)),
    { timeoutMs: 5_000, intervalMs: 25 }
  );
  return {
    root,
    env,
    principal,
    workerId,
    claim,
    controllerProcess,
    workerProcess,
    providerProcess,
    providerChild
  };
}

const recoveryCorruptions = [
  {
    label: "unknown-dispatch-field",
    code: "E_STATE",
    mutate(job) { job.request.spawn.dispatch.unexpected = true; }
  },
  {
    label: "stale-provider-fence",
    code: "E_PROCESS_IDENTITY",
    mutate(job) { job.providerProcess.dispatchFence += 1; }
  },
  {
    label: "stale-provider-marker",
    code: "E_PROCESS_IDENTITY",
    mutate(job) { job.providerProcess.commandMarker = "task-foreign"; }
  },
  {
    label: "stale-provider-attempt",
    code: "E_PROCESS_IDENTITY",
    mutate(job) { job.providerProcess.dispatchAttemptId = "f".repeat(32); }
  },
  {
    label: "stale-provider-generation",
    code: "E_PROCESS_IDENTITY",
    mutate(job) { job.providerProcess.providerGeneration += 1; }
  }
];

for (const corruption of recoveryCorruptions) {
  test(`recovery rejects ${corruption.label} before signalling or mutating`, {
    skip: process.platform === "win32"
  }, async (t) => {
    const state = await activeProviderRecoveryFixture(t, corruption.label);
    updateJob(state.root, state.workerId, (job) => {
      const next = structuredClone(job);
      corruption.mutate(next);
      return next;
    }, state.env);
    const before = JSON.stringify(tryReadJob(state.root, state.workerId, state.env));

    await assert.rejects(
      () => reconcileBrokerWorkers({
        root: state.root,
        principal: state.principal,
        dispatchStartupGraceMs: 0,
        env: state.env
      }),
      (error) => error?.code === corruption.code
    );

    assert.equal(JSON.stringify(tryReadJob(state.root, state.workerId, state.env)), before);
    assert.equal(processGroupGone(state.providerProcess), false);
  });
}

test("provider-started recovery rejects a forged caller witness before signalling", {
  skip: process.platform === "win32"
}, async (t) => {
  const state = await activeProviderRecoveryFixture(t, "forged-caller-witness");
  const before = JSON.stringify(tryReadJob(state.root, state.workerId, state.env));
  const forgedWorker = {
    ...state.workerProcess,
    pid: 1_980_001,
    processGroupId: 1_980_001,
    startToken: "forged-dead-worker"
  };
  assert.equal(processGroupGone(forgedWorker), true);

  await assert.rejects(
    () => recoverLostProviderStartedWorker({
      root: state.root,
      workerId: state.workerId,
      attemptId: state.claim.attemptId,
      workerProcess: forgedWorker,
      env: state.env
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );

  assert.equal(JSON.stringify(tryReadJob(state.root, state.workerId, state.env)), before);
  assert.equal(processGroupGone(state.providerProcess), false);
});

test("a conflicting live provider guard blocks cleanup and preserves runtime artifacts", {
  skip: process.platform === "win32"
}, async (t) => {
  const state = await activeProviderRecoveryFixture(t, "conflicting-live-guard");
  process.kill(-state.providerChild.pid, "SIGKILL");
  await waitFor(() => processGroupGone(state.providerProcess), { timeoutMs: 5_000, intervalMs: 25 });

  const replacement = spawnProcess(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
    state.workerId,
    "agent",
    "--leader-socket",
    path.join(state.root, `leader-${state.workerId}.sock`),
    "stdio"
  ], { detached: true, stdio: "ignore" });
  t.after(() => {
    try { process.kill(-replacement.pid, "SIGKILL"); } catch {}
    try { unregisterProviderGuard(state.root, state.workerId); } catch {}
  });
  const replacementIdentity = {
    pid: replacement.pid,
    startToken: await waitFor(() => processStartToken(replacement.pid)),
    processGroupId: replacement.pid
  };
  registerProviderGuard(state.root, state.workerId, replacementIdentity, THREAD_ID);

  const grokHome = path.join(
    workspaceState(state.root, state.env),
    "task-homes",
    state.workerId,
    ".grok"
  );
  const credential = path.join(grokHome, "auth.json");
  const profile = path.join(grokHome, "agent-profiles", "active", "profile.json");
  fs.mkdirSync(path.dirname(profile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(credential, "{}\n", { mode: 0o600 });
  fs.writeFileSync(profile, "{}\n", { mode: 0o600 });
  const before = JSON.stringify(tryReadJob(state.root, state.workerId, state.env));

  await assert.rejects(
    () => reconcileBrokerWorkers({
      root: state.root,
      principal: state.principal,
      dispatchStartupGraceMs: 0,
      env: state.env
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );

  assert.equal(JSON.stringify(tryReadJob(state.root, state.workerId, state.env)), before);
  assert.equal(processGroupGone(replacementIdentity), false);
  assert.equal(fs.existsSync(credential), true);
  assert.equal(fs.existsSync(profile), true);
  assert.ok(loadProviderGuard(state.root, state.workerId));
});

test("bound provider guard registration rejects a provider from another linked worktree", {
  skip: process.platform === "win32"
}, async (t) => {
  const { root, env } = fixture();
  const principal = { hostKind: "codex", threadId: THREAD_ID };
  const admitted = spawnReadOnlyWorker({
    root,
    principal,
    envelope: buildTaskEnvelope({ userRequest: "Reject a wrong-worktree provider", mode: "read" }),
    idempotencyKey: "provider-guard-wrong-worktree-0001",
    env
  });
  const workerId = admitted.handle.id;
  const claim = claimWorkerDispatch({ root, principal, workerId, env });
  const controllerChild = spawnIdleProcess(t);
  const workerChild = spawnIdleProcess(t);
  const controllerProcess = await boundProcessIdentity(controllerChild, workerId, claim);
  const workerProcess = await boundProcessIdentity(workerChild, workerId, claim);
  const controllerIntent = prepareDispatchProcessSpawn({
    root,
    workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    processKind: "controller",
    nonce: claim.nonce,
    env
  }).intent;
  transitionWorkerDispatch({
    root,
    workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    state: "controller-started",
    controllerProcess,
    spawnIntentId: controllerIntent.intentId,
    env
  });
  const workerIntent = prepareDispatchProcessSpawn({
    root,
    workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    processKind: "worker",
    nonce: claim.nonce,
    env
  }).intent;
  transitionWorkerDispatch({
    root,
    workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    state: "worker-started",
    workerProcess,
    spawnIntentId: workerIntent.intentId,
    env
  });

  const linked = path.join(path.dirname(root), `${path.basename(root)}-wrong-provider-root`);
  git(root, "worktree", "add", "--detach", linked, "HEAD");
  const linkedRoot = fs.realpathSync(linked);
  t.after(() => {
    try { git(root, "worktree", "remove", "--force", linkedRoot); } catch {}
  });
  const provider = spawnProcess(process.execPath, [
    "-e",
    "setInterval(() => {}, 1000);",
    workerId,
    "agent",
    "stdio"
  ], { cwd: linkedRoot, detached: true, stdio: "ignore" });
  t.after(() => {
    try { process.kill(-provider.pid, "SIGKILL"); } catch {}
  });
  const providerIdentity = {
    pid: provider.pid,
    startToken: await waitFor(() => processStartToken(provider.pid)),
    processGroupId: provider.pid
  };
  const job = tryReadJob(root, workerId, env);

  assert.throws(
    () => registerProviderGuard(
      linkedRoot,
      workerId,
      providerIdentity,
      THREAD_ID,
      "provider",
      {
        controlWorkspaceId: job.controlWorkspaceId,
        executionRoot: job.request.spawn.executionRoot,
        dispatchAttemptId: claim.attemptId,
        dispatchFence: claim.fence,
        providerGeneration: 1
      },
      env
    ),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  assert.equal(loadProviderGuard(root, workerId), null);
  assert.equal(processGroupGone(providerIdentity), false);
});

test("MCP spawn runs one fake provider, replays idempotently, waits, returns a private-safe result, and leaks no process", { skip: process.platform === "win32" }, async (t) => {
  const poison = installFakeGrok(tempDir("fake-grok-mcp-poison-"), {
    taskText: taskReport("POISON_PROVIDER_MUST_NOT_RUN")
  });
  const poisonData = tempDir("grok-mcp-poison-data-");
  const previous = {
    bin: process.env.GROK_BIN,
    auth: process.env.GROK_AUTH_PATH,
    data: process.env.GROK_COMPANION_PLUGIN_DATA
  };
  process.env.GROK_BIN = poison.binary;
  process.env.GROK_AUTH_PATH = poison.authPath;
  process.env.GROK_COMPANION_PLUGIN_DATA = poisonData;
  t.after(() => {
    for (const [key, value] of [
      ["GROK_BIN", previous.bin],
      ["GROK_AUTH_PATH", previous.auth],
      ["GROK_COMPANION_PLUGIN_DATA", previous.data]
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const { root, fake, pluginData, env } = fixture();
  const options = { env };
  let workerId = null;
  const privateCanary = "PRIVATE_RUNTIME_REQUEST_CANARY_592e";
  t.after(() => workerId && emergencyStop(tryReadJob(root, workerId, env)));

  const first = await callTool(root, "worker_spawn", {
    idempotencyKey: "mcp-runtime-happy-0001",
    userRequest: `Inspect the fixture and report success. ${privateCanary}`
  }, options);
  workerId = first.worker.id;
  assert.equal(first.providerLaunchState, "pending");
  assert.equal(first.providerLaunched, false);
  assert.equal(Object.hasOwn(first.worker, "contextReceipt"), false);

  const replay = await callTool(root, "worker_spawn", {
    idempotencyKey: "mcp-runtime-happy-0001",
    userRequest: `Inspect the fixture and report success. ${privateCanary}`
  }, options);
  assert.equal(replay.replayed, true);
  assert.equal(replay.worker.id, workerId);
  assert.equal(Object.hasOwn(replay.worker, "contextReceipt"), false);
  assert.ok(["pending", "started"].includes(replay.providerLaunchState));

  await waitForTerminal(root, workerId, options);
  const result = await callTool(root, "worker_result", { id: workerId }, options);
  assert.equal(result.worker.status, "completed");
  assert.equal(result.worker.terminal, true);
  assert.equal(result.worker.result.workerReport.outcome, "complete");
  assert.equal(result.worker.result.hostVerification, "not_run");
  assert.ok(result.worker.contextReceipt);
  assert.deepEqual(result.worker.taskContract.context.facts, []);
  assert.deepEqual(result.worker.taskContract.context.constraints, []);

  const terminalReplay = await callTool(root, "worker_spawn", {
    idempotencyKey: "mcp-runtime-happy-0001",
    userRequest: `Inspect the fixture and report success. ${privateCanary}`
  }, options);
  assert.equal(terminalReplay.replayed, true);
  assert.equal(terminalReplay.worker.id, workerId);
  assert.equal(Object.hasOwn(terminalReplay.worker, "contextReceipt"), false);

  const prompts = readFakeLog(fake.logFile).filter((entry) => entry.event === "prompt");
  assert.equal(prompts.length, 1);
  assert.equal(readFakeLog(poison.logFile).filter((entry) => entry.event === "prompt").length, 0);

  const privateJob = tryReadJob(root, workerId, env);
  const dispatch = privateJob.request.spawn.dispatch;
  assert.equal(dispatch.state, "provider-started");
  assert.equal(dispatch.providerGeneration, 1);
  assert.notEqual(privateJob.providerProcess.startToken, "[REDACTED]");
  assert.ok(privateJob.providerProcess.startToken);
  assert.ok(dispatch.controllerStartedAt);
  assert.ok(dispatch.workerStartedAt);
  assert.ok(dispatch.providerStartedAt);
  for (const identity of identities(privateJob)) {
    assert.equal(identity.commandMarker, workerId);
    assert.equal(identity.dispatchAttemptId, dispatch.attemptId);
    if (process.platform !== "win32") assert.equal(identity.processGroupId, identity.pid);
  }
  assert.equal(privateJob.result.taskRuntimeCleaned, true);
  assert.equal(providerLaunchState(privateJob), "started");

  const serialized = JSON.stringify([first, replay, result, terminalReplay]);
  for (const secret of [
    root,
    pluginData,
    fake.authPath,
    privateJob.workerProcess.nonce,
    privateCanary
  ]) {
    assert.equal(serialized.includes(secret), false, `public MCP payload leaked ${secret}`);
  }
  await assertAllProcessesGone(privateJob);
});

test("provider final report persists one body-free future-admission request at the exact provider boundary", { skip: process.platform === "win32" }, async (t) => {
  const { root, env } = fixture({
    taskText: taskReport("Request review admission", {
      hostActionRequest: {
        schemaVersion: 1,
        kind: "role_admission",
        requestedRoleId: "reviewer"
      }
    })
  });
  const options = { env };
  let workerId = null;
  t.after(() => workerId && emergencyStop(tryReadJob(root, workerId, env)));
  const spawned = await callTool(root, "worker_spawn", {
    idempotencyKey: "mcp-runtime-host-action-0001",
    userRequest: "Inspect and request an independent reviewer."
  }, options);
  workerId = spawned.worker.id;
  await waitForTerminal(root, workerId, options);
  const result = await callTool(root, "worker_result", { id: workerId }, options);
  assert.equal(result.worker.status, "completed");
  assert.deepEqual(result.worker.awaitingHostAction, {
    schemaVersion: 1,
    kind: "role_admission",
    requestId: result.worker.awaitingHostAction.requestId,
    requestedRoleId: "reviewer",
    requestedAt: result.worker.awaitingHostAction.requestedAt,
    status: "awaiting",
    decision: null,
    application: "future-admission-only",
    applied: false
  });
  const privateJob = tryReadJob(root, workerId, env);
  assert.equal(privateJob.hostAction.request.requestedRoleId, "reviewer");
  assert.equal(privateJob.hostAction.decision, null);
  assert.equal(privateJob.hostAction.grant, null);
  const publicText = JSON.stringify(result.worker.awaitingHostAction);
  for (const privateValue of [
    privateJob.host.sessionId,
    privateJob.grokSessionId,
    privateJob.workerProcess.nonce,
    privateJob.hostAction.request.requestDigest,
    privateJob.hostAction.request.sourceBinding.workerProcessDigest,
    privateJob.hostAction.request.sourceBinding.providerProcessDigest
  ]) {
    assert.equal(publicText.includes(privateValue), false);
  }
  await assertAllProcessesGone(privateJob);
});

test("implementer host-action request fails E_CAPABILITY and leaves no durable grant request", { skip: process.platform === "win32" }, async (t) => {
  const { root, env } = fixture({
    taskText: taskReport("Request write admission", {
      hostActionRequest: {
        schemaVersion: 1,
        kind: "role_admission",
        requestedRoleId: "implementer"
      }
    })
  });
  const options = { env };
  let workerId = null;
  t.after(() => workerId && emergencyStop(tryReadJob(root, workerId, env)));
  const spawned = await callTool(root, "worker_spawn", {
    idempotencyKey: "mcp-runtime-host-action-write-0001",
    userRequest: "Inspect and request implementation authority."
  }, options);
  workerId = spawned.worker.id;
  await waitForTerminal(root, workerId, options);
  const result = await callTool(root, "worker_result", { id: workerId }, options);
  assert.equal(result.worker.status, "failed");
  assert.equal(result.worker.error.code, "E_CAPABILITY");
  assert.equal(result.worker.awaitingHostAction, null);
  const privateJob = tryReadJob(root, workerId, env);
  assert.equal(privateJob.hostAction, undefined);
  await assertAllProcessesGone(privateJob);
});

test("deleting every context-binding field before worker execution cannot downgrade to legacy or prepare a provider", { skip: process.platform === "win32" }, async (t) => {
  const { root, fake, env } = fixture();
  const shimRoot = tempDir("grok-mcp-context-preexecute-");
  const shim = path.join(shimRoot, "delayed-exec.sh");
  const release = path.join(shimRoot, "release");
  fs.writeFileSync(
    shim,
    `#!/bin/sh\nwhile [ ! -f ${JSON.stringify(release)} ]; do sleep 0.05; done\nexec ${JSON.stringify(process.execPath)} \"$@\"\n`,
    { mode: 0o755 }
  );
  const options = {
    env,
    serviceOptions: {
      launchWorker: (args) => launchCommittedWorker({ ...args, executable: shim })
    }
  };
  let workerId = null;
  t.after(() => workerId && emergencyStop(tryReadJob(root, workerId, env)));

  const spawned = await callTool(root, "worker_spawn", {
    idempotencyKey: "mcp-runtime-context-preexecute-tamper-0001",
    userRequest: "Never prepare a provider after pre-execute context tamper"
  }, options);
  workerId = spawned.worker.id;
  const admitted = tryReadJob(root, workerId, env);
  assert.equal(admitted.request.contextBindingMode, "context-receipt-v1");
  assert.ok(admitted.request.spawn.contextBindingDigest);
  assert.equal(admitted.request.spawn.providerSpawnIntent, undefined);

  updateJob(root, workerId, (job) => deleteAllContextBindingFields(job), env);
  const tampered = tryReadJob(root, workerId, env);
  assert.ok(tampered.request.spawn.contextBindingDigest);
  for (const field of [
    "contextBindingMode",
    "contextPacket",
    "runtimeRolePolicy",
    "contextReceipt"
  ]) {
    assert.equal(Object.hasOwn(tampered.request, field), false);
  }

  fs.writeFileSync(release, "continue\n", "utf8");
  await waitFor(
    () => {
      const latest = tryReadJob(root, workerId, env);
      return latest?.controllerProcess && processGroupGone(latest.controllerProcess);
    },
    { timeoutMs: 10_000, intervalMs: 50 }
  );
  const settled = tryReadJob(root, workerId, env);
  assert.equal(settled.workerProcess, undefined);
  assertProviderPreparationCountZero(settled, fake);
});

test("deleting every context-binding field after launch authorization consumption cannot prepare a provider", { skip: process.platform === "win32" }, async (t) => {
  const { root, fake, env } = fixture({ inspectDelayMs: 1_500 });
  const options = { env };
  let workerId = null;
  t.after(() => workerId && emergencyStop(tryReadJob(root, workerId, env)));

  const spawned = await callTool(root, "worker_spawn", {
    idempotencyKey: "mcp-runtime-context-post-auth-tamper-0001",
    userRequest: "Never prepare a provider after post-authorization context tamper"
  }, options);
  workerId = spawned.worker.id;
  await waitFor(
    () => {
      const latest = tryReadJob(root, workerId, env);
      const inspectStarted = readFakeLog(fake.logFile)
        .some((entry) => entry.event === "inspect-environment");
      return inspectStarted
        && /^[0-9a-f]{64}$/.test(latest?.request?.spawn?.consumedLaunchContractDigest || "")
        && Boolean(latest?.request?.spawn?.launchContractConsumedAt)
        && latest?.workerAuthorization === null;
    },
    { timeoutMs: 10_000, intervalMs: 25 }
  );
  const consumed = tryReadJob(root, workerId, env);
  assert.equal(consumed.request.spawn.providerSpawnIntent, undefined);
  assert.equal(consumed.request.contextBindingMode, "context-receipt-v1");

  updateJob(root, workerId, (job) => deleteAllContextBindingFields(job), env);
  const tampered = tryReadJob(root, workerId, env);
  assert.ok(tampered.request.spawn.contextBindingDigest);
  for (const field of [
    "contextBindingMode",
    "contextPacket",
    "runtimeRolePolicy",
    "contextReceipt"
  ]) {
    assert.equal(Object.hasOwn(tampered.request, field), false);
  }

  await waitFor(
    () => {
      const latest = tryReadJob(root, workerId, env);
      return latest?.workerProcess
        && processGroupGone(latest.workerProcess)
        && latest?.controllerProcess
        && processGroupGone(latest.controllerProcess);
    },
    { timeoutMs: 15_000, intervalMs: 50 }
  );
  const settled = tryReadJob(root, workerId, env);
  assert.equal(settled.request.spawn.dispatch.state, "worker-started");
  assert.ok(["E_STATE", "E_AUTH_REQUIRED"].includes(settled.error?.code));
  assertProviderPreparationCountZero(settled, fake);
  await assertAllProcessesGone(settled);
});

test("MCP cancellation in the commit-to-launch window starts no worker or provider", { skip: process.platform === "win32" }, async (t) => {
  const { root, fake, env } = fixture();
  const shimRoot = tempDir("grok-mcp-delayed-controller-");
  const shim = path.join(shimRoot, "delayed-exec.sh");
  const release = path.join(shimRoot, "release");
  fs.writeFileSync(
    shim,
    `#!/bin/sh\nwhile [ ! -f ${JSON.stringify(release)} ]; do sleep 0.05; done\nexec ${JSON.stringify(process.execPath)} \"$@\"\n`,
    { mode: 0o755 }
  );
  const options = {
    env,
    serviceOptions: {
      launchWorker: (args) => launchCommittedWorker({ ...args, executable: shim })
    }
  };
  let workerId = null;
  t.after(() => workerId && emergencyStop(tryReadJob(root, workerId, env)));

  const spawned = await callTool(root, "worker_spawn", {
    idempotencyKey: "mcp-runtime-cancel-window-0001",
    userRequest: "This provider must never start"
  }, options);
  workerId = spawned.worker.id;
  const cancelled = await callTool(root, "worker_cancel", {
    id: workerId,
    idempotencyKey: "mcp-runtime-cancel-window-receipt-0001"
  }, options);
  assert.equal(cancelled.receipt.status, "accepted");
  fs.writeFileSync(release, "continue\n", "utf8");

  await waitForTerminal(root, workerId, options);
  const privateJob = tryReadJob(root, workerId, env);
  assert.equal(privateJob.status, "cancelled");
  assert.equal(privateJob.error.code, "E_CANCELLED");
  assert.equal(privateJob.request.spawn.dispatch.state, "failed");
  assert.equal(privateJob.workerProcess, undefined);
  assert.equal(privateJob.providerProcess, undefined);
  assert.equal(readFakeLog(fake.logFile).filter((entry) => entry.event === "prompt").length, 0);
  await assertAllProcessesGone(privateJob);
});

test("MCP cancellation before dispatch claim starts no controller, worker, or provider", { skip: process.platform === "win32" }, async () => {
  const { root, fake, env } = fixture();
  const options = {
    env,
    serviceOptions: {
      launchWorker: () => ({ providerLaunchState: "pending", providerLaunched: false })
    }
  };
  const spawned = await callTool(root, "worker_spawn", {
    idempotencyKey: "mcp-runtime-preclaim-cancel-0001",
    userRequest: "Cancel this durable admission before dispatch claim"
  }, options);
  const cancelled = await callTool(root, "worker_cancel", {
    id: spawned.worker.id,
    idempotencyKey: "mcp-runtime-preclaim-cancel-receipt-0001"
  }, options);
  assert.equal(cancelled.receipt.status, "accepted");

  let spawnCalls = 0;
  const launch = launchCommittedWorker({
    root,
    workerId: spawned.worker.id,
    principal: { hostKind: "codex", threadId: THREAD_ID },
    env,
    spawnProcess: () => {
      spawnCalls += 1;
      throw new Error("controller must not be spawned after terminal cancellation");
    }
  });
  assert.equal(launch.claimed, false);
  assert.equal(launch.providerLaunchState, "failed");
  assert.equal(spawnCalls, 0);
  const privateJob = tryReadJob(root, spawned.worker.id, env);
  assert.equal(privateJob.status, "cancelled");
  assert.equal(privateJob.request.spawn.dispatch.state, "failed");
  assert.equal(privateJob.controllerProcess, undefined);
  assert.equal(privateJob.workerProcess, undefined);
  assert.equal(privateJob.providerProcess, undefined);
  assert.equal(readFakeLog(fake.logFile).filter((entry) => entry.event === "prompt").length, 0);
});

test("MCP wait reconciles an exact controller-started crash without replaying the provider prompt", { skip: process.platform === "win32" }, async (t) => {
  const { root, fake, env } = fixture();
  const shimRoot = tempDir("grok-mcp-crashed-controller-");
  const shim = path.join(shimRoot, "blocked-exec.sh");
  const release = path.join(shimRoot, "release");
  fs.writeFileSync(
    shim,
    `#!/bin/sh\nwhile [ ! -f ${JSON.stringify(release)} ]; do sleep 0.05; done\nexec ${JSON.stringify(process.execPath)} \"$@\"\n`,
    { mode: 0o755 }
  );
  const options = {
    env,
    serviceOptions: {
      launchWorker: (args) => launchCommittedWorker({ ...args, executable: shim })
    },
    reconcileWorkers: (args) => reconcileBrokerWorkers({
      ...args,
      dispatchStartupGraceMs: 0
    })
  };
  let workerId = null;
  t.after(() => workerId && emergencyStop(tryReadJob(root, workerId, env)));

  const spawned = await callTool(root, "worker_spawn", {
    idempotencyKey: "mcp-runtime-controller-loss-0001",
    userRequest: "This prompt must not be replayed after controller loss"
  }, options);
  workerId = spawned.worker.id;
  const before = await callTool(root, "worker_events_after", { id: workerId }, options);
  const active = tryReadJob(root, workerId, env);
  assert.equal(active.request.spawn.dispatch.state, "controller-started");
  process.kill(-active.controllerProcess.processGroupId, "SIGKILL");
  await waitFor(() => processGroupGone(active.controllerProcess), { timeoutMs: 5000, intervalMs: 50 });

  const waited = await callTool(root, "worker_wait", {
    id: workerId,
    cursor: before.stream.nextCursor,
    timeoutMs: 10_000
  }, options);
  assert.equal(waited.stream.terminal, true);
  const lost = tryReadJob(root, workerId, env);
  assert.equal(lost.status, "failed");
  assert.equal(lost.phase, "lost");
  assert.equal(lost.error.code, "E_WORKER_LOST");
  assert.equal(lost.request.spawn.dispatch.state, "failed");
  assert.equal(lost.workerProcess, undefined);
  assert.equal(lost.providerProcess, undefined);
  assert.equal(lost.result.taskRuntimeCleaned, true);
  assert.equal(lost.result.runtimeEvidence.reconciler.replayedPrompt, false);
  assert.equal(readFakeLog(fake.logFile).filter((entry) => entry.event === "prompt").length, 0);

  const replay = await callTool(root, "worker_spawn", {
    idempotencyKey: "mcp-runtime-controller-loss-0001",
    userRequest: "This prompt must not be replayed after controller loss"
  }, options);
  assert.equal(replay.replayed, true);
  assert.equal(replay.worker.id, workerId);
  assert.equal(replay.worker.status, "failed");
  assert.equal(readFakeLog(fake.logFile).filter((entry) => entry.event === "prompt").length, 0);
  await assertAllProcessesGone(lost);
});

test("MCP wait recovers controller-then-worker loss and cleans the active provider", { skip: process.platform === "win32" }, async (t) => {
  const { root, fake, env } = fixture({ cancelMode: "wait" });
  const normalOptions = { env };
  const recoveryOptions = {
    env,
    reconcileWorkers: (args) => reconcileBrokerWorkers({
      ...args,
      dispatchStartupGraceMs: 0
    })
  };
  let workerId = null;
  t.after(() => workerId && emergencyStop(tryReadJob(root, workerId, env)));

  const spawned = await callTool(root, "worker_spawn", {
    idempotencyKey: "mcp-runtime-supervisor-loss-0001",
    userRequest: "Wait while the supervisor-loss recovery test runs"
  }, normalOptions);
  workerId = spawned.worker.id;
  await waitFor(
    () => readFakeLog(fake.logFile).some((entry) => entry.event === "prompt"),
    { timeoutMs: 10_000, intervalMs: 50 }
  );
  const active = tryReadJob(root, workerId, env);
  assert.equal(active.request.spawn.dispatch.state, "provider-started");
  process.kill(-active.controllerProcess.processGroupId, "SIGKILL");
  await waitFor(() => processGroupGone(active.controllerProcess), { timeoutMs: 5000, intervalMs: 50 });
  const afterControllerLoss = tryReadJob(root, workerId, env);
  assert.equal(afterControllerLoss.status, "running");
  assert.equal(processGroupGone(afterControllerLoss.workerProcess), false);
  assert.equal(processGroupGone(afterControllerLoss.providerProcess), false);

  process.kill(-afterControllerLoss.workerProcess.processGroupId, "SIGKILL");
  await waitFor(() => processGroupGone(afterControllerLoss.workerProcess), { timeoutMs: 5000, intervalMs: 50 });
  const before = await callTool(root, "worker_events_after", { id: workerId }, recoveryOptions);
  const waited = await callTool(root, "worker_wait", {
    id: workerId,
    cursor: before.stream.nextCursor,
    timeoutMs: 10_000
  }, recoveryOptions);
  assert.equal(waited.stream.terminal, true);

  const lost = tryReadJob(root, workerId, env);
  assert.equal(lost.status, "failed");
  assert.equal(lost.phase, "lost");
  assert.equal(lost.error.code, "E_WORKER_LOST");
  assert.equal(lost.result.taskRuntimeCleaned, true);
  assert.equal(lost.result.runtimeEvidence.reconciler.replayedPrompt, false);
  assert.equal(readFakeLog(fake.logFile).filter((entry) => entry.event === "prompt").length, 1);
  await assertAllProcessesGone(lost);
});

test("MCP launch fails durably and terminates the controller when its birth token cannot be captured", { skip: process.platform === "win32" }, async (t) => {
  const { root, fake, env } = fixture();
  let idleChild = null;
  let idleIdentity = null;
  const options = {
    env,
    serviceOptions: {
      launchWorker: (args) => launchCommittedWorker({
        ...args,
        spawnProcess: () => {
          idleChild = spawnProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            detached: true,
            stdio: "ignore"
          });
          idleIdentity = {
            pid: idleChild.pid,
            processGroupId: process.platform === "win32" ? null : idleChild.pid,
            startToken: processStartToken(idleChild.pid) || "unavailable"
          };
          return idleChild;
        },
        startToken: () => null
      })
    }
  };
  t.after(() => emergencyStop({ controllerProcess: idleIdentity }));

  const spawned = await callTool(root, "worker_spawn", {
    idempotencyKey: "mcp-runtime-null-token-0001",
    userRequest: "Fail before controller identity publication"
  }, options);
  assert.equal(spawned.providerLaunchState, "failed");
  assert.equal(spawned.providerLaunched, false);
  assert.equal(spawned.worker.status, "queued");
  assert.equal(spawned.worker.phase, "accepted");
  assert.equal(spawned.worker.eventCursor.sequence, 1);
  const privateJob = tryReadJob(root, spawned.worker.id, env);
  assert.equal(privateJob.status, "failed");
  assert.equal(privateJob.phase, "failed");
  assert.equal(privateJob.error.code, "E_PROCESS_IDENTITY");
  assert.equal(privateJob.request.spawn.dispatch.state, "failed");
  assert.equal(privateJob.controllerProcess, undefined);
  assert.equal(readFakeLog(fake.logFile).filter((entry) => entry.event === "prompt").length, 0);
  await waitFor(() => processGroupGone(idleIdentity), { timeoutMs: 5000, intervalMs: 50 });
});

test("attempt transitions reject stale identity, nonce, role, and ordering drift", () => {
  const root = initRepo();
  const pluginData = tempDir("grok-dispatch-contract-data-");
  const env = {
    HOME: path.dirname(pluginData),
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_PLUGIN_DATA: pluginData
  };
  const principal = { hostKind: "codex", threadId: THREAD_ID };
  const admitted = spawnReadOnlyWorker({
    root,
    principal,
    envelope: buildTaskEnvelope({ userRequest: "Dispatch contract", mode: "read" }),
    idempotencyKey: "dispatch-contract-0001",
    env
  });
  const claim = claimWorkerDispatch({ root, principal, workerId: admitted.handle.id, env });
  const liveToken = processStartToken(process.pid);
  const identity = (_label, extra = {}) => ({
    pid: process.pid,
    startToken: liveToken,
    processGroupId: process.platform === "win32" ? null : process.pid,
    nonce: claim.nonce,
    commandMarker: admitted.handle.id,
    dispatchAttemptId: claim.attemptId,
    dispatchFence: claim.fence,
    ...extra
  });
  const controllerIntent = prepareDispatchProcessSpawn({
    root,
    workerId: admitted.handle.id,
    attemptId: claim.attemptId,
    fence: claim.fence,
    processKind: "controller",
    nonce: claim.nonce,
    env
  }).intent;

  assert.throws(
    () => transitionWorkerDispatch({
      root,
      workerId: admitted.handle.id,
      attemptId: "f".repeat(32),
      fence: claim.fence,
      state: "controller-started",
      controllerProcess: { ...identity(101), dispatchAttemptId: "f".repeat(32) },
      env
    }),
    (error) => error?.code === "E_STATE"
  );
  assert.throws(
    () => transitionWorkerDispatch({
      root,
      workerId: admitted.handle.id,
      attemptId: claim.attemptId,
      fence: claim.fence,
      state: "controller-started",
      controllerProcess: { ...identity(101), processGroupId: undefined },
      env
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  assert.throws(
    () => transitionWorkerDispatch({
      root,
      workerId: admitted.handle.id,
      attemptId: claim.attemptId,
      fence: claim.fence,
      state: "controller-started",
      controllerProcess: identity(101, { nonce: "wrong-nonce" }),
      env
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );

  transitionWorkerDispatch({
    root,
    workerId: admitted.handle.id,
    attemptId: claim.attemptId,
    fence: claim.fence,
    state: "controller-started",
    controllerProcess: identity(101),
    spawnIntentId: controllerIntent.intentId,
    env
  });
  assert.throws(
    () => transitionWorkerDispatch({
      root,
      workerId: admitted.handle.id,
      attemptId: claim.attemptId,
      fence: claim.fence,
      state: "controller-started",
      controllerProcess: identity(102, { startToken: `${liveToken}-changed` }),
      spawnIntentId: controllerIntent.intentId,
      env
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  assert.throws(
    () => transitionWorkerDispatch({
      root,
      workerId: admitted.handle.id,
      attemptId: claim.attemptId,
      fence: claim.fence,
      state: "provider-started",
      providerProcess: identity(103, { providerGeneration: 1 }),
      env
    }),
    (error) => error?.code === "E_STATE"
  );
  const workerIntent = prepareDispatchProcessSpawn({
    root,
    workerId: admitted.handle.id,
    attemptId: claim.attemptId,
    fence: claim.fence,
    processKind: "worker",
    nonce: claim.nonce,
    env
  }).intent;
  transitionWorkerDispatch({
    root,
    workerId: admitted.handle.id,
    attemptId: claim.attemptId,
    fence: claim.fence,
    state: "worker-started",
    workerProcess: identity(102),
    spawnIntentId: workerIntent.intentId,
    env
  });
  assert.throws(
    () => transitionWorkerDispatch({
      root,
      workerId: admitted.handle.id,
      attemptId: claim.attemptId,
      fence: claim.fence,
      state: "provider-started",
      providerProcess: identity(103, {
        startToken: "[REDACTED]",
        providerGeneration: 1
      }),
      env
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  const started = transitionWorkerDispatch({
    root,
    workerId: admitted.handle.id,
    attemptId: claim.attemptId,
    fence: claim.fence,
    state: "provider-started",
    providerProcess: identity(103, { providerGeneration: 1 }),
    env
  });
  assert.equal(providerLaunchState(started), "started");

  const second = spawnReadOnlyWorker({
    root,
    principal,
    envelope: buildTaskEnvelope({ userRequest: "Role drift", mode: "read" }),
    idempotencyKey: "dispatch-contract-role-0001",
    env
  });
  const secondClaim = claimWorkerDispatch({ root, principal, workerId: second.handle.id, env });
  const secondIntent = prepareDispatchProcessSpawn({
    root,
    workerId: second.handle.id,
    attemptId: secondClaim.attemptId,
    fence: secondClaim.fence,
    processKind: "controller",
    nonce: secondClaim.nonce,
    env
  }).intent;
  updateJob(root, second.handle.id, (job) => {
    const role = materializeRole("reviewer");
    return { ...job, role: { ...role, tools: [...role.tools] } };
  }, env);
  assert.throws(
    () => transitionWorkerDispatch({
      root,
      workerId: second.handle.id,
      attemptId: secondClaim.attemptId,
      fence: secondClaim.fence,
      state: "controller-started",
      controllerProcess: {
        pid: process.pid,
        startToken: liveToken,
        processGroupId: process.platform === "win32" ? null : process.pid,
        nonce: secondClaim.nonce,
        commandMarker: second.handle.id,
        dispatchAttemptId: secondClaim.attemptId,
        dispatchFence: secondClaim.fence
      },
      spawnIntentId: secondIntent.intentId,
      env
    }),
    (error) => error?.code === "E_ROLE"
  );
});

test("broker report repair rotates provider identity once after the previous group is gone", { skip: process.platform === "win32" }, async (t) => {
  const { root, fake, env } = fixture({
    taskTexts: ["invalid first worker response", taskReport("Repaired worker report")]
  });
  const options = { env };
  let workerId = null;
  t.after(() => workerId && emergencyStop(tryReadJob(root, workerId, env)));

  const spawned = await callTool(root, "worker_spawn", {
    idempotencyKey: "mcp-runtime-report-repair-0001",
    userRequest: "Return a valid structured worker report"
  }, options);
  workerId = spawned.worker.id;
  await waitForTerminal(root, workerId, options);
  const result = await callTool(root, "worker_result", { id: workerId }, options);
  assert.equal(result.worker.status, "completed");
  assert.equal(result.worker.result.workerReport.summary, "Repaired worker report");
  assert.equal(readFakeLog(fake.logFile).filter((entry) => entry.event === "prompt").length, 2);

  const privateJob = tryReadJob(root, workerId, env);
  const dispatch = privateJob.request.spawn.dispatch;
  assert.equal(dispatch.providerGeneration, 2);
  assert.equal(dispatch.nextProviderGeneration, null);
  assert.equal(dispatch.providerRotationCount, 1);
  assert.ok(dispatch.providerRotatedAt);
  assert.equal(privateJob.providerProcess.providerGeneration, 2);
  await assertAllProcessesGone(privateJob);
});

test("report-repair provider failure after generation 2 registration preserves the provider error", { skip: process.platform === "win32" }, async (t) => {
  const { root, fake, env } = fixture({
    taskTexts: ["invalid first worker response", "unused replacement response"],
    promptErrors: [null, "repair-provider-error"]
  });
  const options = { env };
  let workerId = null;
  t.after(() => workerId && emergencyStop(tryReadJob(root, workerId, env)));

  const spawned = await callTool(root, "worker_spawn", {
    idempotencyKey: "mcp-runtime-report-repair-provider-error-0001",
    userRequest: "Preserve the registered replacement provider failure"
  }, options);
  workerId = spawned.worker.id;
  await waitForTerminal(root, workerId, options);

  const failed = tryReadJob(root, workerId, env);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "E_PROTOCOL");
  assert.match(failed.error.message, /repair-provider-error/);
  assert.equal(failed.result.reportRepair.error.code, "E_PROTOCOL");
  assert.match(failed.result.reportRepair.error.message, /repair-provider-error/);
  assert.equal(readFakeLog(fake.logFile).filter((entry) => entry.event === "prompt").length, 2);
  assert.equal(failed.request.spawn.dispatch.providerGeneration, 2);
  assert.equal(failed.request.spawn.dispatch.nextProviderGeneration, null);
  assert.equal(failed.request.spawn.providerRotationIntent.status, "registered");
  assert.equal(failed.providerProcess.providerGeneration, 2);
  await assertAllProcessesGone(failed);
});

test("active cancellation after generation 2 registration preserves E_CANCELLED", { skip: process.platform === "win32" }, async (t) => {
  const { root, fake, env } = fixture({
    taskTexts: ["invalid first worker response", taskReport("Repair must be cancelled")],
    delayMs: 2_000
  });
  const options = { env };
  let workerId = null;
  t.after(() => workerId && emergencyStop(tryReadJob(root, workerId, env)));

  const spawned = await callTool(root, "worker_spawn", {
    idempotencyKey: "mcp-runtime-report-repair-cancel-0001",
    userRequest: "Cancel only after the replacement provider is registered"
  }, options);
  workerId = spawned.worker.id;
  await waitFor(
    () => readFakeLog(fake.logFile).filter((entry) => entry.event === "prompt").length === 2,
    { timeoutMs: 15_000, intervalMs: 25 }
  );
  const registered = tryReadJob(root, workerId, env);
  assert.equal(registered.request.spawn.dispatch.providerGeneration, 2);
  assert.equal(registered.request.spawn.dispatch.nextProviderGeneration, null);
  assert.equal(registered.request.spawn.providerRotationIntent.status, "registered");
  assert.equal(registered.providerProcess.providerGeneration, 2);

  const cancelled = await callTool(root, "worker_cancel", {
    id: workerId,
    idempotencyKey: "mcp-runtime-report-repair-cancel-receipt-0001"
  }, options);
  assert.equal(cancelled.receipt.status, "accepted");
  await waitForTerminal(root, workerId, options);

  const terminal = tryReadJob(root, workerId, env);
  assert.equal(terminal.status, "cancelled");
  assert.equal(terminal.error.code, "E_CANCELLED");
  assert.equal(terminal.request.spawn.dispatch.providerGeneration, 2);
  assert.equal(terminal.request.spawn.providerRotationIntent.status, "registered");
  assert.equal(terminal.result.taskRuntimeCleaned, true);
  await assertAllProcessesGone(terminal);
});

test("pending provider rotation is durably promoted before guard cleanup and loss settlement", { skip: process.platform === "win32" }, async (t) => {
  const { root, env } = fixture();
  const principal = { hostKind: "codex", threadId: THREAD_ID };
  const admitted = spawnReadOnlyWorker({
    root,
    principal,
    envelope: buildTaskEnvelope({ userRequest: "Recover a replacement provider without replay", mode: "read" }),
    idempotencyKey: "rotation-recovery-promotion-0001",
    env
  });
  const workerId = admitted.handle.id;
  const claim = claimWorkerDispatch({ root, principal, workerId, env });
  const controllerChild = spawnIdleProcess(t);
  const workerChild = spawnIdleProcess(t);
  const oldProviderChild = spawnIdleProcess(t);
  const controllerProcess = await boundProcessIdentity(controllerChild, workerId, claim);
  const workerProcess = await boundProcessIdentity(workerChild, workerId, claim);
  const oldProvider = await boundProcessIdentity(oldProviderChild, workerId, claim, {
    nonce: undefined,
    providerGeneration: 1
  });
  installProviderStartedFixture({
    root,
    workerId,
    claim,
    controllerProcess,
    workerProcess,
    providerProcess: oldProvider,
    env
  });
  process.kill(-oldProviderChild.pid, "SIGKILL");
  await waitFor(() => processGroupGone(oldProvider), { timeoutMs: 5_000, intervalMs: 25 });
  assert.equal(authorizeWorkerProviderRotation({
    root,
    workerId,
    attemptId: claim.attemptId,
    workerProcess,
    env
  }).providerGeneration, 2);
  for (const child of [controllerChild, workerChild]) {
    process.kill(-child.pid, "SIGKILL");
  }
  await waitFor(
    () => [controllerProcess, workerProcess, oldProvider].every((identity) => processGroupGone(identity)),
    { timeoutMs: 5_000, intervalMs: 25 }
  );

  const replacement = spawnProcess(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);",
    "agent",
    "--leader-socket",
    path.join(root, `leader-${workerId}.sock`),
    "stdio"
  ], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => {
    try { process.kill(-replacement.pid, "SIGKILL"); } catch {}
  });
  await new Promise((resolve, reject) => {
    replacement.once("error", reject);
    replacement.stdout.once("data", resolve);
  });
  const replacementIdentity = {
    pid: replacement.pid,
    startToken: await waitFor(() => processStartToken(replacement.pid)),
    processGroupId: replacement.pid
  };
  const rotationJob = tryReadJob(root, workerId, env);
  registerProviderGuard(
    root,
    workerId,
    replacementIdentity,
    THREAD_ID,
    "provider",
    {
      controlWorkspaceId: rotationJob.controlWorkspaceId,
      executionRoot: rotationJob.request.spawn.executionRoot,
      dispatchAttemptId: claim.attemptId,
      dispatchFence: claim.fence,
      providerGeneration: 2,
      providerSpawnIntentId: rotationJob.request.spawn.providerSpawnIntent.intentId
    },
    env
  );

  const recovery = await reconcileBrokerWorkers({
    root,
    principal,
    dispatchStartupGraceMs: 0,
    env
  });
  assert.equal(recovery.results[0].action, "marked-lost");
  const settled = tryReadJob(root, workerId, env);
  assert.equal(settled.status, "failed");
  assert.equal(settled.phase, "lost");
  assert.equal(settled.request.spawn.dispatch.providerGeneration, 2);
  assert.equal(settled.request.spawn.dispatch.nextProviderGeneration, null);
  assert.equal(settled.providerProcess.providerGeneration, 2);
  assert.equal(settled.providerProcess.pid, replacement.pid);
  assert.equal(settled.result.taskRuntimeCleaned, true);
  assert.equal(settled.result.privacyWarning, undefined);
  assert.equal(loadProviderGuard(root, workerId), null);
  await waitFor(() => processGroupGone(settled.providerProcess), { timeoutMs: 5_000, intervalMs: 25 });

  const replay = await reconcileBrokerWorkers({ root, principal, dispatchStartupGraceMs: 0, env });
  assert.equal(replay.results[0].reason, "terminal");
});

test("unsettled replacement provider supersedes stale generation and blocks cleanup until its group is observed gone", { skip: process.platform === "win32" }, async (t) => {
  const { root, env } = fixture();
  const principal = { hostKind: "codex", threadId: THREAD_ID };
  const admitted = spawnReadOnlyWorker({
    root,
    principal,
    envelope: buildTaskEnvelope({ userRequest: "Recover an unsettled report repair without stale cleanup", mode: "read" }),
    idempotencyKey: "rotation-unsettled-replacement-0001",
    env
  });
  const workerId = admitted.handle.id;
  const claim = claimWorkerDispatch({ root, principal, workerId, env });
  const controllerChild = spawnIdleProcess(t);
  const workerChild = spawnIdleProcess(t);
  const staleProviderChild = spawnIdleProcess(t);
  const controllerProcess = await boundProcessIdentity(controllerChild, workerId, claim);
  const workerProcess = await boundProcessIdentity(workerChild, workerId, claim);
  const staleProvider = await boundProcessIdentity(staleProviderChild, workerId, claim, {
    nonce: undefined,
    providerGeneration: 1
  });
  installProviderStartedFixture({
    root,
    workerId,
    claim,
    controllerProcess,
    workerProcess,
    providerProcess: staleProvider,
    env
  });
  process.kill(-staleProviderChild.pid, "SIGKILL");
  await waitFor(() => processGroupGone(staleProvider), { timeoutMs: 5_000, intervalMs: 25 });
  assert.equal(authorizeWorkerProviderRotation({
    root,
    workerId,
    attemptId: claim.attemptId,
    workerProcess,
    env
  }).providerGeneration, 2);
  for (const child of [controllerChild, workerChild]) {
    process.kill(-child.pid, "SIGKILL");
  }
  await waitFor(
    () => [controllerProcess, workerProcess, staleProvider].every((identity) => processGroupGone(identity)),
    { timeoutMs: 5_000, intervalMs: 25 }
  );

  const replacement = spawnProcess(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
  ], { detached: true, stdio: "ignore" });
  t.after(() => {
    try { process.kill(-replacement.pid, "SIGKILL"); } catch {}
  });
  await waitFor(() => processStartToken(replacement.pid), { timeoutMs: 5_000, intervalMs: 25 });
  const unsettledReplacement = {
    pid: replacement.pid,
    startToken: null,
    processGroupId: replacement.pid,
    commandMarker: workerId,
    dispatchAttemptId: claim.attemptId,
    dispatchFence: claim.fence,
    providerGeneration: 2
  };
  const stateRoot = workspaceState(root, env);
  const taskHome = path.join(stateRoot, "task-homes", workerId, ".grok");
  const credential = path.join(taskHome, "auth.json");
  fs.mkdirSync(taskHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(credential, "{}\n", { mode: 0o600 });

  const blocked = recordUnsettledProviderProcess({
    root,
    workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    providerProcess: unsettledReplacement,
    env
  });
  assert.equal(blocked.status, "running");
  assert.equal(blocked.phase, "cleanup-blocked");
  assert.equal(blocked.request.spawn.dispatch.state, "failed");
  assert.equal(blocked.request.spawn.dispatch.providerGeneration, 2);
  assert.equal(blocked.request.spawn.dispatch.nextProviderGeneration, null);
  assert.equal(blocked.providerProcess.pid, replacement.pid);
  assert.equal(blocked.providerProcess.startToken, null);
  assert.notEqual(blocked.providerProcess.pid, staleProvider.pid);
  assert.equal(blocked.pendingTerminal.status, "failed");
  assert.equal(blocked.result.taskRuntimeCleaned, false);
  assert.equal(fs.existsSync(credential), true);

  const liveRecovery = await reconcileBrokerWorkers({
    root,
    principal,
    dispatchStartupGraceMs: 0,
    env
  });
  assert.equal(liveRecovery.results[0].action, "cleanup-blocked");
  assert.equal(liveRecovery.results[0].reason, "unsettled-provider-alive");
  const stillBlocked = tryReadJob(root, workerId, env);
  assert.equal(stillBlocked.status, "running");
  assert.equal(stillBlocked.providerProcess.pid, replacement.pid);
  assert.equal(fs.existsSync(credential), true);

  process.kill(-replacement.pid, "SIGKILL");
  await waitFor(() => processGroupGone(unsettledReplacement), { timeoutMs: 5_000, intervalMs: 25 });
  const recovered = await reconcileBrokerWorkers({
    root,
    principal,
    dispatchStartupGraceMs: 0,
    env
  });
  assert.equal(recovered.results[0].action, "terminalized");
  assert.equal(recovered.results[0].reason, "cleanup-completed");
  const terminal = tryReadJob(root, workerId, env);
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.phase, "failed");
  assert.equal(terminal.providerProcess.pid, replacement.pid);
  assert.equal(terminal.providerProcess.providerGeneration, 2);
  assert.equal(terminal.result.taskRuntimeCleaned, true);
  assert.equal(terminal.result.privacyWarning, undefined);
  assert.equal(fs.existsSync(credential), false);
});

test("settled initial provider loss retains a self-valid generation-bound terminal witness", {
  skip: process.platform === "win32"
}, async (t) => {
  const { root, env } = fixture();
  const principal = { hostKind: "codex", threadId: THREAD_ID };
  const admitted = spawnReadOnlyWorker({
    root,
    principal,
    envelope: buildTaskEnvelope({ userRequest: "Settle an initial provider identity failure", mode: "read" }),
    idempotencyKey: "initial-provider-unsettled-generation-0001",
    env
  });
  const workerId = admitted.handle.id;
  const claim = claimWorkerDispatch({ root, principal, workerId, env });
  const controllerChild = spawnIdleProcess(t);
  const workerChild = spawnIdleProcess(t);
  const controllerProcess = await boundProcessIdentity(controllerChild, workerId, claim);
  const workerProcess = await boundProcessIdentity(workerChild, workerId, claim);
  const controllerIntent = prepareDispatchProcessSpawn({
    root,
    workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    processKind: "controller",
    nonce: claim.nonce,
    env
  }).intent;
  transitionWorkerDispatch({
    root,
    workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    state: "controller-started",
    controllerProcess,
    spawnIntentId: controllerIntent.intentId,
    env
  });
  const workerIntent = prepareDispatchProcessSpawn({
    root,
    workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    processKind: "worker",
    nonce: claim.nonce,
    env
  }).intent;
  transitionWorkerDispatch({
    root,
    workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    state: "worker-started",
    workerProcess,
    spawnIntentId: workerIntent.intentId,
    env
  });

  const unsettledProvider = {
    pid: 1_990_001,
    startToken: null,
    processGroupId: 1_990_001,
    commandMarker: workerId,
    dispatchAttemptId: claim.attemptId,
    dispatchFence: claim.fence,
    providerGeneration: 1
  };
  assert.equal(processGroupGone(unsettledProvider), true);
  const blocked = recordUnsettledProviderProcess({
    root,
    workerId,
    attemptId: claim.attemptId,
    providerProcess: unsettledProvider,
    env
  });
  assert.equal(blocked.request.spawn.dispatch.state, "worker-started");
  assert.doesNotThrow(() => assertDispatchContract(blocked));

  for (const child of [controllerChild, workerChild]) process.kill(-child.pid, "SIGKILL");
  await waitFor(
    () => [controllerProcess, workerProcess].every((identity) => processGroupGone(identity)),
    { timeoutMs: 5_000, intervalMs: 25 }
  );
  const recovery = await reconcileBrokerWorkers({
    root,
    principal,
    dispatchStartupGraceMs: 0,
    env
  });
  assert.equal(recovery.results[0].action, "marked-lost");
  const terminal = tryReadJob(root, workerId, env);
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.request.spawn.dispatch.state, "failed");
  assert.equal(terminal.request.spawn.dispatch.providerGeneration, 1);
  assert.equal(terminal.providerProcess.providerGeneration, 1);
  assert.equal(terminal.result.taskRuntimeCleaned, true);
  assert.doesNotThrow(() => assertDispatchContract(terminal));
});

test("provider finalization publishes one stable terminal snapshot with cleanup checkpoint", { skip: process.platform === "win32" }, async (t) => {
  const { root, env } = fixture();
  const principal = { hostKind: "codex", threadId: THREAD_ID };
  const admitted = spawnReadOnlyWorker({
    root,
    principal,
    envelope: buildTaskEnvelope({ userRequest: "Publish one stable terminal result", mode: "read" }),
    idempotencyKey: "provider-terminal-snapshot-stable-0001",
    env
  });
  const workerId = admitted.handle.id;
  const claim = claimWorkerDispatch({ root, principal, workerId, env });
  const controllerChild = spawnIdleProcess(t);
  const workerChild = spawnIdleProcess(t);
  const providerChild = spawnIdleProcess(t);
  const controllerProcess = await boundProcessIdentity(controllerChild, workerId, claim);
  const workerProcess = await boundProcessIdentity(workerChild, workerId, claim);
  const providerProcess = await boundProcessIdentity(providerChild, workerId, claim, {
    providerGeneration: 1
  });
  installProviderStartedFixture({
    root,
    workerId,
    claim,
    controllerProcess,
    workerProcess,
    providerProcess,
    env
  });
  const completedAt = new Date().toISOString();
  updateJob(root, workerId, (job) => ({
    ...job,
    phase: "finalizing",
    pendingTerminal: {
      status: "completed",
      phase: "done",
      completedAt,
      error: null,
      summary: "Stable terminal result"
    },
    result: {
      ...(job.result || {}),
      hostVerification: "not_run",
      taskRuntimeCleaned: false
    }
  }), env);

  process.kill(-providerChild.pid, "SIGKILL");
  await waitFor(() => processGroupGone(providerProcess), {
    timeoutMs: 5_000,
    intervalMs: 25
  });
  let cleanupCalls = 0;
  const settled = settleProviderStartedWorkerFinalization({
    root,
    workerId,
    attemptId: claim.attemptId,
    workerProcess,
    providerProcess,
    runtimeCleanup: () => {
      cleanupCalls += 1;
      return { ok: true };
    },
    env
  });
  assert.equal(cleanupCalls, 1);
  assert.equal(settled.status, "completed");
  assert.equal(settled.phase, "done");
  assert.equal(settled.completedAt, completedAt);
  assert.equal(settled.result.taskRuntimeCleaned, true);
  assert.equal(settled.pendingTerminal, undefined);
  assert.deepEqual(settled.lifecycleEvents.at(-1), {
    type: "checkpoint",
    at: settled.lifecycleEvents.at(-1).at,
    summary: "Task runtime cleanup completed; durable terminal intent published.",
    sequence: settled.lifecycleEvents.at(-1).sequence,
    detail: { replayedPrompt: false }
  });

  const options = { env };
  const firstResult = await callTool(root, "worker_result", { id: workerId }, options);
  const secondResult = await callTool(root, "worker_result", { id: workerId }, options);
  assert.deepEqual(secondResult, firstResult);
  assert.equal(firstResult.worker.status, "completed");
  assert.equal(firstResult.worker.result.taskRuntimeCleaned, true);
  assert.equal(
    firstResult.worker.lifecycleEvents.at(-1).summary,
    "Task runtime cleanup completed; durable terminal intent published."
  );

  const beforeReconcile = tryReadJob(root, workerId, env);
  await reconcileBrokerWorkers({
    root,
    principal,
    dispatchStartupGraceMs: 0,
    env
  });
  const afterReconcile = tryReadJob(root, workerId, env);
  assert.deepEqual(afterReconcile, beforeReconcile);
  assert.deepEqual(
    await callTool(root, "worker_result", { id: workerId }, options),
    firstResult
  );
});

test("pre-provider cleanup failure remains nonterminal until recovery proves every group gone", { skip: process.platform === "win32" }, async (t) => {
  const { root, env } = fixture();
  const principal = { hostKind: "codex", threadId: THREAD_ID };
  const admitted = spawnReadOnlyWorker({
    root,
    principal,
    envelope: buildTaskEnvelope({ userRequest: "Fail cleanup before provider startup", mode: "read" }),
    idempotencyKey: "pre-provider-cleanup-atomic-0001",
    env
  });
  const workerId = admitted.handle.id;
  const claim = claimWorkerDispatch({ root, principal, workerId, env });
  const controller = spawnProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore"
  });
  const worker = spawnProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore"
  });
  t.after(() => {
    for (const child of [controller, worker]) {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
  });
  const processIdentity = async (child) => ({
    pid: child.pid,
    startToken: await waitFor(() => processStartToken(child.pid)),
    processGroupId: child.pid,
    nonce: claim.nonce,
    commandMarker: workerId,
    dispatchAttemptId: claim.attemptId,
    dispatchFence: claim.fence
  });
  const controllerProcess = await processIdentity(controller);
  const workerProcess = await processIdentity(worker);
  const controllerIntent = prepareDispatchProcessSpawn({
    root,
    workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    processKind: "controller",
    nonce: claim.nonce,
    env
  }).intent;
  transitionWorkerDispatch({
    root,
    workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    state: "controller-started",
    controllerProcess,
    spawnIntentId: controllerIntent.intentId,
    env
  });
  const workerIntent = prepareDispatchProcessSpawn({
    root,
    workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    processKind: "worker",
    nonce: claim.nonce,
    env
  }).intent;
  transitionWorkerDispatch({
    root,
    workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    state: "worker-started",
    workerProcess,
    spawnIntentId: workerIntent.intentId,
    env
  });

  const blocked = settlePreProviderWorkerFinalization({
    root,
    workerId,
    attemptId: claim.attemptId,
    workerProcess,
    intendedTerminal: {
      status: "failed",
      phase: "failed",
      completedAt: new Date().toISOString(),
      error: { code: "E_PROVIDER_EXIT", message: "Provider failed before startup." },
      summary: "Provider failed before startup."
    },
    runtimeCleanup: { ok: false, warning: "Injected credential cleanup fault." },
    env
  });
  assert.equal(blocked.status, "running");
  assert.equal(blocked.phase, "cleanup-blocked");
  assert.equal(blocked.completedAt, null);
  assert.equal(blocked.request.spawn.dispatch.state, "failed");
  assert.equal(blocked.result.taskRuntimeCleaned, false);
  assert.equal(blocked.result.privacyWarning, "Injected credential cleanup fault.");
  assert.equal(blocked.pendingTerminal.status, "failed");

  process.kill(-worker.pid, "SIGKILL");
  process.kill(-controller.pid, "SIGKILL");
  await waitFor(
    () => processGroupGone(workerProcess) && processGroupGone(controllerProcess),
    { timeoutMs: 5_000, intervalMs: 25 }
  );
  const recovery = await reconcileBrokerWorkers({
    root,
    principal,
    dispatchStartupGraceMs: 0,
    env
  });
  assert.equal(recovery.results[0].action, "terminalized");
  const terminal = tryReadJob(root, workerId, env);
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.error.code, "E_PROVIDER_EXIT");
  assert.equal(terminal.result.taskRuntimeCleaned, true);
  assert.equal(terminal.result.privacyWarning, undefined);
  assert.equal(terminal.pendingTerminal, undefined);
});

for (const cleanupOk of [true, false]) {
  test(`pre-provider finalization settles an initially unsettled provider generation (${cleanupOk ? "cleanup complete" : "cleanup blocked"})`, {
    skip: process.platform === "win32"
  }, async (t) => {
    const { root, env } = fixture();
    const principal = { hostKind: "codex", threadId: THREAD_ID };
    const admitted = spawnReadOnlyWorker({
      root,
      principal,
      envelope: buildTaskEnvelope({ userRequest: `Finalize unsettled provider ${cleanupOk}`, mode: "read" }),
      idempotencyKey: `pre-provider-unsettled-generation-${cleanupOk}`,
      env
    });
    const workerId = admitted.handle.id;
    const claim = claimWorkerDispatch({ root, principal, workerId, env });
    const controllerChild = spawnIdleProcess(t);
    const workerChild = spawnIdleProcess(t);
    const controllerProcess = await boundProcessIdentity(controllerChild, workerId, claim);
    const workerProcess = await boundProcessIdentity(workerChild, workerId, claim);
    const controllerIntent = prepareDispatchProcessSpawn({
      root,
      workerId,
      attemptId: claim.attemptId,
      fence: claim.fence,
      processKind: "controller",
      nonce: claim.nonce,
      env
    }).intent;
    transitionWorkerDispatch({
      root,
      workerId,
      attemptId: claim.attemptId,
      fence: claim.fence,
      state: "controller-started",
      controllerProcess,
      spawnIntentId: controllerIntent.intentId,
      env
    });
    const workerIntent = prepareDispatchProcessSpawn({
      root,
      workerId,
      attemptId: claim.attemptId,
      fence: claim.fence,
      processKind: "worker",
      nonce: claim.nonce,
      env
    }).intent;
    transitionWorkerDispatch({
      root,
      workerId,
      attemptId: claim.attemptId,
      fence: claim.fence,
      state: "worker-started",
      workerProcess,
      spawnIntentId: workerIntent.intentId,
      env
    });
    const unsettledProvider = {
      pid: cleanupOk ? 1_991_101 : 1_991_102,
      startToken: null,
      processGroupId: cleanupOk ? 1_991_101 : 1_991_102,
      commandMarker: workerId,
      dispatchAttemptId: claim.attemptId,
      dispatchFence: claim.fence,
      providerGeneration: 1
    };
    assert.equal(processGroupGone(unsettledProvider), true);
    recordUnsettledProviderProcess({
      root,
      workerId,
      attemptId: claim.attemptId,
      providerProcess: unsettledProvider,
      env
    });

    const settled = settlePreProviderWorkerFinalization({
      root,
      workerId,
      attemptId: claim.attemptId,
      workerProcess,
      intendedTerminal: {
        status: "failed",
        phase: "failed",
        completedAt: new Date().toISOString(),
        error: { code: "E_PROVIDER_EXIT", message: "Provider failed before registration." },
        summary: "Provider failed before registration."
      },
      runtimeCleanup: cleanupOk
        ? { ok: true }
        : { ok: false, warning: "Injected cleanup block after unsettled provider." },
      env
    });
    assert.equal(settled.request.spawn.dispatch.state, "failed");
    assert.equal(settled.request.spawn.dispatch.providerGeneration, 1);
    assert.equal(settled.request.spawn.dispatch.nextProviderGeneration, null);
    assert.equal(settled.providerProcess.providerGeneration, 1);
    assert.equal(settled.status, cleanupOk ? "failed" : "running");
    assert.equal(settled.phase, cleanupOk ? "failed" : "cleanup-blocked");
    assert.doesNotThrow(() => assertDispatchContract(settled));
  });
}

test("MCP cancellation of an active provider reaches terminal state and leaves no owned process", { skip: process.platform === "win32" }, async (t) => {
  const { root, fake, env } = fixture({ cancelMode: "wait" });
  const options = { env };
  let workerId = null;
  t.after(() => workerId && emergencyStop(tryReadJob(root, workerId, env)));

  const spawned = await callTool(root, "worker_spawn", {
    idempotencyKey: "mcp-runtime-active-cancel-0001",
    userRequest: "Wait until the broker cancels this active provider"
  }, options);
  workerId = spawned.worker.id;
  await waitFor(
    () => readFakeLog(fake.logFile).some((entry) => entry.event === "prompt"),
    { timeoutMs: 10_000, intervalMs: 50 }
  );
  const active = tryReadJob(root, workerId, env);
  assert.equal(active.request.spawn.dispatch.state, "provider-started");

  const cancelled = await callTool(root, "worker_cancel", {
    id: workerId,
    idempotencyKey: "mcp-runtime-active-cancel-receipt-0001"
  }, options);
  assert.equal(cancelled.receipt.status, "accepted");
  await waitForTerminal(root, workerId, options);

  const terminal = tryReadJob(root, workerId, env);
  assert.equal(terminal.status, "cancelled");
  assert.equal(terminal.error.code, "E_CANCELLED");
  assert.equal(terminal.result.taskRuntimeCleaned, true);
  const log = readFakeLog(fake.logFile);
  assert.equal(log.filter((entry) => entry.event === "prompt").length, 1);
  assert.equal(log.filter((entry) => entry.event === "cancel").length, 1);
  const marker = cancelFile(root, workerId, env);
  const markerStat = fs.lstatSync(marker);
  assert.equal(markerStat.isFile(), true);
  assert.equal(markerStat.isSymbolicLink(), false);
  assert.equal(markerStat.mode & 0o777, 0o600);
  assert.equal(
    fs.readFileSync(marker, "utf8"),
    `${terminal.workerProcess.nonce}\n`
  );
  assert.deepEqual(
    fs.readdirSync(path.dirname(marker))
      .filter((name) => name.startsWith(`${workerId}.cancel.`)),
    []
  );
  await assertAllProcessesGone(terminal);
});

test("controller watchdog settles a provider-started worker crash and cleans every owned process", { skip: process.platform === "win32" }, async (t) => {
  const { root, fake, env } = fixture({ cancelMode: "wait" });
  const recoveryFailures = [];
  const options = {
    env,
    async reconcileWorkers(args) {
      try { return await reconcileBrokerWorkers(args); }
      catch (error) {
        recoveryFailures.push({ code: error?.code || null, message: error?.message || String(error) });
        throw error;
      }
    }
  };
  let workerId = null;
  t.after(() => workerId && emergencyStop(tryReadJob(root, workerId, env)));

  const spawned = await callTool(root, "worker_spawn", {
    idempotencyKey: "mcp-runtime-worker-crash-0001",
    userRequest: "Wait until the crash watchdog test terminates this worker"
  }, options);
  workerId = spawned.worker.id;
  await waitFor(
    () => readFakeLog(fake.logFile).some((entry) => entry.event === "prompt"),
    { timeoutMs: 10_000, intervalMs: 50 }
  );
  const active = tryReadJob(root, workerId, env);
  assert.equal(active.request.spawn.dispatch.state, "provider-started");
  process.kill(
    process.platform === "win32" ? active.workerProcess.pid : -active.workerProcess.processGroupId,
    "SIGKILL"
  );

  try { await waitForTerminal(root, workerId, options); }
  catch (error) {
    error.message = `${error.message}\nRecovery failures: ${JSON.stringify(recoveryFailures)}`;
    throw error;
  }
  const lost = tryReadJob(root, workerId, env);
  assert.equal(lost.status, "failed");
  assert.equal(lost.phase, "lost");
  assert.equal(lost.error.code, "E_WORKER_LOST");
  assert.equal(lost.request.spawn.dispatch.state, "provider-started");
  assert.ok(lost.request.spawn.dispatch.runtimeLostAt);
  assert.equal(lost.result.hostVerification, "not_run");
  assert.equal(lost.result.taskRuntimeCleaned, true);
  await assertAllProcessesGone(lost);
});

test("trusted worker environment uses service state and rejects ambient identity", () => {
  const serviceData = tempDir("grok-service-data-");
  const child = trustedWorkerEnvironment({
    principal: { hostKind: "codex", threadId: THREAD_ID },
    nonce: "1".repeat(32),
    attemptId: "2".repeat(32),
    env: {
      PATH: "/service/bin",
      HOME: "/service/home",
      PLUGIN_DATA: serviceData,
      GROK_BIN: "/service/grok",
      GROK_AUTH_PATH: "/service/auth.json",
      PRIVATE_AMBIENT_SENTINEL: "must-not-cross"
    }
  });
  assert.equal(child.GROK_COMPANION_PLUGIN_DATA, serviceData);
  assert.equal(child.GROK_BIN, "/service/grok");
  assert.equal(child.GROK_COMPANION_HOST_SESSION_ID, THREAD_ID);
  assert.equal(child.CODEX_THREAD_ID, THREAD_ID);
  assert.equal(child.PRIVATE_AMBIENT_SENTINEL, undefined);
});
