import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  cancellationNonce,
  claimWorkerDispatch,
  prepareDispatchProcessSpawn,
  recordDispatchProcessNoChild,
  transitionWorkerDispatch,
  spawnReadOnlyWorker
} from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import {
  captureSpawnIdentity,
  ensureChildExit
} from "../plugins/grok/scripts/lib/grok-provider.mjs";
import {
  launchCommittedWorker,
  trustedWorkerEnvironment
} from "../plugins/grok/scripts/lib/worker-runtime.mjs";
import { reconcileBrokerWorkers } from "../plugins/grok/scripts/lib/worker-recovery.mjs";
import {
  processGroupGone,
  processStartToken
} from "../plugins/grok/scripts/lib/process-control.mjs";
import {
  loadProviderGuard,
  registerProviderGuard,
  unregisterProviderGuard
} from "../plugins/grok/scripts/lib/recursion-guard.mjs";
import {
  requestCancel,
  terminal,
  tryReadJob
} from "../plugins/grok/scripts/lib/state.mjs";
import { buildTaskEnvelope } from "../plugins/grok/scripts/lib/task-contract.mjs";
import { workspaceState } from "../plugins/grok/scripts/lib/workspace.mjs";

import { initRepo, tempDir, waitFor } from "./helpers.mjs";

const THREAD_ID = "019f6a2f-8e34-7db1-a101-b9ca29e5fe01";
const COMPANION = fileURLToPath(new URL(
  "../plugins/grok/scripts/grok-companion.mjs",
  import.meta.url
));
const MUTATION_MODULE = new URL(
  "../plugins/grok/scripts/lib/worker-mutation.mjs",
  import.meta.url
).href;
const PROCESS_CONTROL_MODULE = new URL(
  "../plugins/grok/scripts/lib/process-control.mjs",
  import.meta.url
).href;
const RUNTIME_MODULE = new URL(
  "../plugins/grok/scripts/lib/worker-runtime.mjs",
  import.meta.url
).href;

function fixture(idempotencyKey) {
  const root = initRepo();
  const pluginData = tempDir("worker-startup-crash-data-");
  const env = {
    ...process.env,
    HOME: path.dirname(pluginData),
    GROK_COMPANION_PLUGIN_DATA: pluginData,
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_HOST_SESSION_ID: THREAD_ID,
    CODEX_THREAD_ID: THREAD_ID
  };
  for (const key of [
    "GROK_COMPANION_CHILD",
    "GROK_COMPANION_JOB_MARKER",
    "GROK_AGENT",
    "GROK_LEADER_SOCKET"
  ]) delete env[key];
  const principal = { hostKind: "codex", threadId: THREAD_ID };
  const admitted = spawnReadOnlyWorker({
    root,
    principal,
    envelope: buildTaskEnvelope({
      userRequest: "Prove detached startup crash safety",
      mode: "read"
    }),
    idempotencyKey,
    env
  });
  return { root, pluginData, env, principal, workerId: admitted.handle.id };
}

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o700 });
}

function groupSignal(pid, signal) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function killGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { groupSignal(pid, "SIGKILL"); } catch {}
}

async function waitForGroupGone(identity) {
  await waitFor(() => processGroupGone(identity), { timeoutMs: 10_000, intervalMs: 25 });
}

function readyProcessIdentity(file) {
  try {
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    const startToken = processStartToken(pid);
    return startToken ? { pid, startToken } : null;
  } catch {
    return null;
  }
}

function replayCreatesNoProcess({ root, workerId, principal, env }) {
  let spawnCalls = 0;
  const replay = launchCommittedWorker({
    root,
    workerId,
    principal,
    env,
    spawnProcess: () => {
      spawnCalls += 1;
      throw new Error("replay must not spawn");
    }
  });
  assert.equal(replay.claimed, false);
  assert.equal(spawnCalls, 0);
}

function stageTaskRuntimeArtifacts({ root, workerId, env }) {
  const grokHome = path.join(workspaceState(root, env), "task-homes", workerId, ".grok");
  const authFile = path.join(grokHome, "auth.json");
  const profileFile = path.join(grokHome, "agent-profiles", "staged-profile.md");
  fs.mkdirSync(path.dirname(profileFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(authFile, "staged-auth\n", { mode: 0o600 });
  fs.writeFileSync(profileFile, "staged-profile\n", { mode: 0o600 });
  return { authFile, profileFile };
}

function assertTaskRuntimeArtifactsRemoved({ authFile, profileFile }) {
  assert.equal(fs.existsSync(authFile), false, "staged task credential was not removed");
  assert.equal(fs.existsSync(profileFile), false, "staged task profile was not removed");
}

test("broker SIGKILL after controller spawn leaves an ambiguous intent until the controller self-registers", { skip: process.platform === "win32" }, async (t) => {
  const state = fixture("controller-startup-crash-window-0001");
  const directory = tempDir("controller-startup-crash-");
  const controllerReady = path.join(directory, "controller-ready");
  const parentReady = path.join(directory, "parent-ready");
  const wrapper = path.join(directory, "stopped-controller.sh");
  const parentScript = path.join(directory, "broker-parent.mjs");
  let controllerPid = null;
  let parent = null;
  t.after(() => {
    killGroup(controllerPid);
    if (parent?.pid) {
      try { process.kill(parent.pid, "SIGKILL"); } catch {}
    }
  });

  writeExecutable(wrapper, [
    "#!/bin/sh",
    `printf '%s' \"$$\" > ${JSON.stringify(controllerReady)}`,
    "kill -STOP \"$$\"",
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(COMPANION)} \"$@\"`
  ].join("\n"));
  fs.writeFileSync(parentScript, [
    `import fs from ${JSON.stringify("node:fs")};`,
    `import { launchCommittedWorker } from ${JSON.stringify(RUNTIME_MODULE)};`,
    `const root = ${JSON.stringify(state.root)};`,
    `const workerId = ${JSON.stringify(state.workerId)};`,
    `const principal = ${JSON.stringify(state.principal)};`,
    `const env = ${JSON.stringify(state.env)};`,
    "launchCommittedWorker({",
    "  root, workerId, principal, env,",
    `  executable: ${JSON.stringify("/bin/sh")},`,
    `  companionScript: ${JSON.stringify(wrapper)},`,
    "  startToken(pid) {",
    `    fs.writeFileSync(${JSON.stringify(parentReady)}, String(pid));`,
    "    for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);",
    "  }",
    "});"
  ].join("\n"), { mode: 0o600 });

  parent = spawn(process.execPath, [parentScript], {
    cwd: state.root,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let parentError = "";
  parent.stderr.on("data", (chunk) => { parentError += chunk; });
  const controllerIdentity = await waitFor(() => {
    const observed = readyProcessIdentity(controllerReady);
    const parentObserved = readyProcessIdentity(parentReady);
    return observed && parentObserved?.pid === observed.pid ? observed : null;
  },
    { timeoutMs: 10_000, intervalMs: 25 }
  );
  controllerPid = controllerIdentity.pid;
  const controllerToken = controllerIdentity.startToken;
  assert.ok(controllerToken);

  let job = tryReadJob(state.root, state.workerId, state.env);
  assert.equal(job.request.spawn.dispatch.state, "claimed");
  assert.equal(job.request.spawn.controllerSpawnIntent.status, "pending");
  assert.equal(job.controllerProcess, undefined);

  process.kill(parent.pid, "SIGKILL");
  await once(parent, "close");
  assert.equal(parentError, "");
  const recovery = await reconcileBrokerWorkers({
    root: state.root,
    principal: state.principal,
    dispatchStartupGraceMs: 0,
    env: state.env
  });
  assert.ok(recovery.results.some((entry) => (
    entry.workerId === state.workerId
    && entry.action === "none"
    && entry.reason === "controller-startup-intent-ambiguous"
  )));
  job = tryReadJob(state.root, state.workerId, state.env);
  assert.equal(terminal(job), false);
  assert.equal(job.controllerProcess, undefined);
  assert.equal(processGroupGone({
    pid: controllerPid,
    startToken: controllerToken,
    processGroupId: controllerPid
  }), false, "recovery must not signal an identity-free pending controller intent");

  requestCancel(state.root, state.workerId, cancellationNonce(job), state.env);
  groupSignal(controllerPid, "SIGCONT");
  await waitFor(() => {
    const current = tryReadJob(state.root, state.workerId, state.env);
    return current.request?.spawn?.dispatch?.state === "controller-started"
      && current.request?.spawn?.controllerSpawnIntent?.status === "registered";
  }, { timeoutMs: 10_000, intervalMs: 25 });
  job = tryReadJob(state.root, state.workerId, state.env);
  assert.equal(job.controllerProcess.pid, controllerPid);
  assert.equal(job.controllerProcess.startToken, controllerToken);
  assert.equal(job.controllerProcess.processGroupId, controllerPid);
  assert.equal(job.controllerProcess.dispatchAttemptId, job.request.spawn.dispatch.attemptId);
  replayCreatesNoProcess(state);

  await waitForGroupGone(job.controllerProcess);
  await reconcileBrokerWorkers({
    root: state.root,
    principal: state.principal,
    dispatchStartupGraceMs: 0,
    env: state.env
  });
  job = tryReadJob(state.root, state.workerId, state.env);
  assert.equal(job.status, "cancelled");
  assert.equal(job.request.spawn.dispatch.state, "failed");
  assert.equal(job.result.taskRuntimeCleaned, true);
});

test("a definitive controller spawn failure records no-child before terminal settlement", () => {
  const state = fixture("controller-startup-no-child-0001");
  const artifacts = stageTaskRuntimeArtifacts(state);
  const launched = launchCommittedWorker({
    root: state.root,
    workerId: state.workerId,
    principal: state.principal,
    env: state.env,
    spawnProcess: () => {
      const error = new Error("fixture spawn refused before process creation");
      error.code = "ENOENT";
      throw error;
    }
  });
  assert.equal(launched.providerLaunchState, "failed");
  const job = tryReadJob(state.root, state.workerId, state.env);
  assert.equal(job.status, "failed");
  assert.equal(job.request.spawn.controllerSpawnIntent.status, "no-child");
  assert.equal(job.request.spawn.controllerSpawnIntent.resolution, "spawn-not-created");
  assert.equal(job.controllerProcess, undefined);
  assert.equal(job.request.spawn.providerLaunchOutcome, "not-launched");
  assert.equal(job.result.taskRuntimeCleaned, true);
  assert.equal(job.workerAuthorization, null);
  assert.equal(job.request.spawn.dispatch.lease, null);
  assertTaskRuntimeArtifactsRemoved(artifacts);
});

test("claimed controller no-child recovery removes staged runtime artifacts and clears its lease", async () => {
  const state = fixture("controller-claimed-no-child-recovery-0001");
  const artifacts = stageTaskRuntimeArtifacts(state);
  const claim = claimWorkerDispatch({
    root: state.root,
    principal: state.principal,
    workerId: state.workerId,
    env: state.env
  });
  const controllerIntent = prepareDispatchProcessSpawn({
    root: state.root,
    workerId: state.workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    processKind: "controller",
    nonce: claim.nonce,
    env: state.env
  });
  recordDispatchProcessNoChild({
    root: state.root,
    workerId: state.workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    processKind: "controller",
    intentId: controllerIntent.intent.intentId,
    resolution: "spawn-not-created",
    env: state.env
  });
  const before = tryReadJob(state.root, state.workerId, state.env);
  assert.equal(before.request.spawn.dispatch.state, "claimed");
  assert.equal(before.request.spawn.controllerSpawnIntent.status, "no-child");
  assert.equal(before.request.spawn.dispatch.lease.fence, claim.fence);

  const recovery = await reconcileBrokerWorkers({
    root: state.root,
    principal: state.principal,
    dispatchStartupGraceMs: 0,
    env: state.env
  });
  assert.ok(recovery.results.some((entry) => (
    entry.workerId === state.workerId
    && entry.action === "marked-lost"
    && entry.reason === "claimed-attempt-lost"
  )));
  const recovered = tryReadJob(state.root, state.workerId, state.env);
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.request.spawn.dispatch.state, "failed");
  assert.equal(recovered.request.spawn.dispatch.lease, null);
  assert.equal(recovered.workerAuthorization, null);
  assert.equal(recovered.result.taskRuntimeCleaned, true);
  assertTaskRuntimeArtifactsRemoved(artifacts);
});

test("claimed no-child recovery retains runtime artifacts while a provider guard is live", {
  skip: process.platform === "win32"
}, async (t) => {
  const state = fixture("controller-claimed-no-child-live-guard-0001");
  const artifacts = stageTaskRuntimeArtifacts(state);
  const claim = claimWorkerDispatch({
    root: state.root,
    principal: state.principal,
    workerId: state.workerId,
    env: state.env
  });
  const controllerIntent = prepareDispatchProcessSpawn({
    root: state.root,
    workerId: state.workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    processKind: "controller",
    nonce: claim.nonce,
    env: state.env
  });
  recordDispatchProcessNoChild({
    root: state.root,
    workerId: state.workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    processKind: "controller",
    intentId: controllerIntent.intent.intentId,
    resolution: "spawn-not-created",
    env: state.env
  });

  const provider = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000);", state.workerId, "agent", "stdio"],
    { detached: true, stdio: "ignore" }
  );
  let providerIdentity = null;
  t.after(() => {
    try { unregisterProviderGuard(state.root, state.workerId); } catch {}
    killGroup(provider.pid);
  });
  providerIdentity = {
    pid: provider.pid,
    startToken: await waitFor(() => processStartToken(provider.pid)),
    processGroupId: provider.pid
  };
  registerProviderGuard(state.root, state.workerId, providerIdentity, THREAD_ID);

  const recovery = await reconcileBrokerWorkers({
    root: state.root,
    principal: state.principal,
    dispatchStartupGraceMs: 0,
    env: state.env
  });
  assert.ok(recovery.results.some((entry) => (
    entry.workerId === state.workerId
    && entry.action === "cleanup-blocked"
    && entry.reason === "runtime-cleanup-incomplete"
  )));
  const blocked = tryReadJob(state.root, state.workerId, state.env);
  assert.equal(blocked.status, "queued");
  assert.equal(blocked.phase, "cleanup-blocked");
  assert.equal(blocked.result.taskRuntimeCleaned, false);
  assert.equal(fs.existsSync(artifacts.authFile), true);
  assert.equal(fs.existsSync(artifacts.profileFile), true);
  assert.equal(processGroupGone(providerIdentity), false);
  assert.ok(loadProviderGuard(state.root, state.workerId));
});

test("cancellation after worker birth cleanup publishes cleanup-proven no-child and becomes recoverable", {
  skip: process.platform === "win32"
}, async (t) => {
  const state = fixture("worker-cancel-after-birth-cleanup-0001");
  const artifacts = stageTaskRuntimeArtifacts(state);
  const claim = claimWorkerDispatch({
    root: state.root,
    principal: state.principal,
    workerId: state.workerId,
    env: state.env
  });
  const controllerIntent = prepareDispatchProcessSpawn({
    root: state.root,
    workerId: state.workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    processKind: "controller",
    nonce: claim.nonce,
    env: state.env
  });
  const controller = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore"
  });
  const controllerIdentity = {
    ...(await captureSpawnIdentity(controller)),
    nonce: claim.nonce,
    commandMarker: state.workerId,
    dispatchAttemptId: claim.attemptId,
    dispatchFence: claim.fence
  };
  t.after(() => {
    killGroup(controller.pid);
  });
  transitionWorkerDispatch({
    root: state.root,
    workerId: state.workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    state: "controller-started",
    controllerProcess: controllerIdentity,
    spawnIntentId: controllerIntent.intent.intentId,
    env: state.env
  });
  const workerIntent = prepareDispatchProcessSpawn({
    root: state.root,
    workerId: state.workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    processKind: "worker",
    nonce: claim.nonce,
    env: state.env
  });
  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore"
  });
  const workerIdentity = await captureSpawnIdentity(worker);
  t.after(() => killGroup(worker.pid));

  requestCancel(state.root, state.workerId, claim.nonce, state.env);
  await ensureChildExit(worker, workerIdentity);
  recordDispatchProcessNoChild({
    root: state.root,
    workerId: state.workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    processKind: "worker",
    intentId: workerIntent.intent.intentId,
    resolution: "cleanup-proven",
    env: state.env
  });
  let current = tryReadJob(state.root, state.workerId, state.env);
  assert.equal(current.request.spawn.workerSpawnIntent.status, "no-child");
  assert.equal(current.request.spawn.workerSpawnIntent.resolution, "cleanup-proven");
  assert.equal(current.workerProcess, undefined);

  await ensureChildExit(controller, controllerIdentity);
  const recovery = await reconcileBrokerWorkers({
    root: state.root,
    principal: state.principal,
    dispatchStartupGraceMs: 0,
    env: state.env
  });
  assert.equal(recovery.results[0].action, "marked-lost");
  current = tryReadJob(state.root, state.workerId, state.env);
  assert.equal(current.status, "cancelled");
  assert.equal(current.request.spawn.dispatch.state, "failed");
  assert.equal(current.request.spawn.dispatch.lease, null);
  assert.equal(current.workerAuthorization, null);
  assert.equal(current.result.taskRuntimeCleaned, true);
  assertTaskRuntimeArtifactsRemoved(artifacts);
});

test("controller SIGKILL after worker spawn leaves an ambiguous intent until the worker self-registers", { skip: process.platform === "win32" }, async (t) => {
  const state = fixture("worker-startup-crash-window-0001");
  const directory = tempDir("worker-startup-crash-");
  const workerReady = path.join(directory, "worker-ready");
  const workerWrapper = path.join(directory, "stopped-worker.sh");
  const controllerScript = path.join(directory, "controller-fixture.mjs");
  let controllerPid = null;
  let workerPid = null;
  t.after(() => {
    killGroup(controllerPid);
    killGroup(workerPid);
  });

  const claim = claimWorkerDispatch({
    root: state.root,
    principal: state.principal,
    workerId: state.workerId,
    env: state.env
  });
  assert.equal(claim.claimed, true);
  const controllerIntent = prepareDispatchProcessSpawn({
    root: state.root,
    workerId: state.workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    processKind: "controller",
    nonce: claim.nonce,
    env: state.env
  });
  assert.equal(controllerIntent.prepared, true);

  writeExecutable(workerWrapper, [
    "#!/bin/sh",
    `printf '%s' \"$$\" > ${JSON.stringify(workerReady)}`,
    "kill -STOP \"$$\"",
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(COMPANION)} \"$@\"`
  ].join("\n"));
  fs.writeFileSync(controllerScript, [
    `import { spawn } from ${JSON.stringify("node:child_process")};`,
    `import process from ${JSON.stringify("node:process")};`,
    `import { prepareDispatchProcessSpawn, transitionWorkerDispatch } from ${JSON.stringify(MUTATION_MODULE)};`,
    `import { processStartToken } from ${JSON.stringify(PROCESS_CONTROL_MODULE)};`,
    "const [id, attemptId, rawFence, intentId, root, workerWrapper] = process.argv.slice(2);",
    "const fence = Number(rawFence);",
    "const nonce = process.env.GROK_COMPANION_WORKER_NONCE;",
    "transitionWorkerDispatch({",
    "  root, workerId: id, attemptId, fence, state: 'controller-started',",
    "  controllerProcess: {",
    "    pid: process.pid, startToken: processStartToken(process.pid), nonce,",
    "    processGroupId: process.pid, commandMarker: id, dispatchAttemptId: attemptId, dispatchFence: fence",
    "  },",
    "  spawnIntentId: intentId",
    "});",
    "const prepared = prepareDispatchProcessSpawn({",
    "  root, workerId: id, attemptId, fence, processKind: 'worker', nonce",
    "});",
    "if (!prepared.prepared) throw new Error('worker intent was not freshly prepared');",
    "spawn('/bin/sh', [",
    "  workerWrapper, '--worker', id, '--attempt', attemptId, '--fence', String(fence),",
    "  '--worker-intent', prepared.intent.intentId, '--cwd', root",
    "], { cwd: root, detached: true, shell: false, stdio: 'ignore', env: process.env });",
    "setInterval(() => {}, 1000);"
  ].join("\n"), { mode: 0o600 });

  const controller = spawn(process.execPath, [
    controllerScript,
    state.workerId,
    claim.attemptId,
    String(claim.fence),
    controllerIntent.intent.intentId,
    state.root,
    workerWrapper
  ], {
    cwd: state.root,
    detached: true,
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
    env: trustedWorkerEnvironment({
      principal: state.principal,
      nonce: claim.nonce,
      attemptId: claim.attemptId,
      fence: claim.fence,
      env: state.env
    })
  });
  controllerPid = controller.pid;
  let controllerError = "";
  controller.stderr.on("data", (chunk) => { controllerError += chunk; });
  const workerIdentity = await waitFor(
    () => readyProcessIdentity(workerReady),
    { timeoutMs: 10_000, intervalMs: 25 }
  );
  workerPid = workerIdentity.pid;
  const workerToken = workerIdentity.startToken;
  assert.ok(workerToken);

  let job = tryReadJob(state.root, state.workerId, state.env);
  assert.equal(job.request.spawn.dispatch.state, "controller-started");
  assert.equal(job.request.spawn.workerSpawnIntent.status, "pending");
  assert.equal(job.workerProcess, undefined);
  const controllerIdentity = job.controllerProcess;
  assert.equal(controllerIdentity.pid, controllerPid);

  killGroup(controllerPid);
  await waitForGroupGone(controllerIdentity);
  assert.equal(controllerError, "");
  const recovery = await reconcileBrokerWorkers({
    root: state.root,
    principal: state.principal,
    dispatchStartupGraceMs: 0,
    env: state.env
  });
  assert.ok(recovery.results.some((entry) => (
    entry.workerId === state.workerId
    && entry.action === "none"
    && entry.reason === "worker-startup-intent-ambiguous"
  )));
  job = tryReadJob(state.root, state.workerId, state.env);
  assert.equal(terminal(job), false);
  assert.equal(job.workerProcess, undefined);
  assert.equal(processGroupGone({
    pid: workerPid,
    startToken: workerToken,
    processGroupId: workerPid
  }), false, "recovery must not signal an identity-free pending worker intent");

  requestCancel(state.root, state.workerId, cancellationNonce(job), state.env);
  groupSignal(workerPid, "SIGCONT");
  await waitFor(() => {
    const current = tryReadJob(state.root, state.workerId, state.env);
    return current.workerProcess?.pid === workerPid
      && current.request?.spawn?.workerSpawnIntent?.status === "registered";
  }, { timeoutMs: 10_000, intervalMs: 25 });
  job = tryReadJob(state.root, state.workerId, state.env);
  assert.equal(job.workerProcess.pid, workerPid);
  assert.equal(job.workerProcess.startToken, workerToken);
  assert.equal(job.workerProcess.processGroupId, workerPid);
  assert.equal(job.workerProcess.dispatchAttemptId, claim.attemptId);
  replayCreatesNoProcess(state);

  await waitForGroupGone(job.workerProcess);
  await waitFor(() => terminal(tryReadJob(state.root, state.workerId, state.env)), {
    timeoutMs: 10_000,
    intervalMs: 25
  });
  job = tryReadJob(state.root, state.workerId, state.env);
  assert.equal(job.status, "cancelled");
  assert.equal(job.request.spawn.dispatch.state, "failed");
  assert.equal(job.providerProcess == null, true);
  assert.equal(job.result.taskRuntimeCleaned, true);
});
