import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assertDispatchContract,
  claimWorkerDispatch,
  prepareDispatchProcessSpawn,
  prepareWorkerProviderSpawn,
  spawnReadOnlyWorker,
  transitionWorkerDispatch
} from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import { reconcileBrokerWorkers } from "../plugins/grok/scripts/lib/worker-recovery.mjs";
import { processGroupGone, processStartToken } from "../plugins/grok/scripts/lib/process-control.mjs";
import {
  loadProviderGuard,
  registerProviderGuard,
  unregisterProviderGuard
} from "../plugins/grok/scripts/lib/recursion-guard.mjs";
import { tryReadJob, updateJob } from "../plugins/grok/scripts/lib/state.mjs";
import { buildTaskEnvelope } from "../plugins/grok/scripts/lib/task-contract.mjs";
import {
  providerChildEnvironment,
  readProviderBootstrapSpec,
  runProviderBootstrap
} from "../plugins/grok/scripts/lib/provider-bootstrap.mjs";
import {
  cleanupBoundBootstrapStart,
  createProviderBootstrapLaunch,
  publishProviderBootstrapSpec,
  promoteProviderBootstrap
} from "../plugins/grok/scripts/lib/grok-provider.mjs";

import { initRepo, tempDir, waitFor } from "./helpers.mjs";

const THREAD_ID = "019f76cf-150d-7ec6-892e-4e68fa7a71a3";
const BOOTSTRAP = fileURLToPath(new URL(
  "../plugins/grok/scripts/lib/provider-bootstrap.mjs",
  import.meta.url
));
let sequence = 0;

function ownerEnvironment(pluginData) {
  return {
    ...process.env,
    HOME: path.dirname(pluginData),
    GROK_COMPANION_PLUGIN_DATA: pluginData,
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_HOST_SESSION_ID: THREAD_ID,
    CODEX_THREAD_ID: THREAD_ID
  };
}

function spawnIdle(t) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    detached: true,
    stdio: "ignore"
  });
  t.after(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  });
  return child;
}

async function identityFor(child, fixture, { nonce = true, providerGeneration = null } = {}) {
  const identity = {
    pid: child.pid,
    startToken: await waitFor(() => processStartToken(child.pid)),
    processGroupId: child.pid,
    commandMarker: fixture.workerId,
    dispatchAttemptId: fixture.claim.attemptId,
    dispatchFence: fixture.claim.fence
  };
  if (nonce) identity.nonce = fixture.claim.nonce;
  if (providerGeneration != null) identity.providerGeneration = providerGeneration;
  return identity;
}

async function providerIdentityFor(child) {
  return {
    pid: child.pid,
    startToken: await waitFor(() => processStartToken(child.pid)),
    processGroupId: child.pid
  };
}

function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
}

async function killAndWait(child, identity) {
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  await waitFor(() => processGroupGone(identity));
}

async function workerStartedFixture(t, label) {
  sequence += 1;
  const root = initRepo();
  const pluginData = tempDir(`provider-bootstrap-${label}-data-`);
  const env = ownerEnvironment(pluginData);
  const principal = { hostKind: "codex", threadId: THREAD_ID };
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
  });
  const admitted = spawnReadOnlyWorker({
    root,
    principal,
    envelope: buildTaskEnvelope({
      userRequest: `Exercise provider bootstrap crash window ${label}`,
      mode: "read"
    }),
    idempotencyKey: `provider-bootstrap-${label}-${sequence}`,
    env
  });
  const workerId = admitted.handle.id;
  const claim = claimWorkerDispatch({ root, principal, workerId, env });
  const fixture = { root, pluginData, env, principal, workerId, claim };

  const controller = spawnIdle(t);
  const controllerProcess = await identityFor(controller, fixture);
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

  const worker = spawnIdle(t);
  const workerProcess = await identityFor(worker, fixture);
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
  updateJob(root, workerId, (job) => ({
    ...job,
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
  await killAndWait(worker, workerProcess);
  await killAndWait(controller, controllerProcess);
  return { ...fixture, controllerProcess, workerProcess };
}

function bootstrapLaunch(fixture, intent, providerArgs, { binary = process.execPath } = {}) {
  const binding = bootstrapBinding(fixture, intent);
  return createProviderBootstrapLaunch({
    root: binding.executionRoot,
    marker: fixture.workerId,
    owner: THREAD_ID,
    binding,
    binary,
    args: providerArgs
  });
}

function bootstrapBinding(fixture, intent) {
  const job = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  return {
    controlWorkspaceId: job.controlWorkspaceId,
    executionRoot: job.request.spawn.executionRoot,
    dispatchAttemptId: fixture.claim.attemptId,
    dispatchFence: fixture.claim.fence,
    providerGeneration: 1,
    providerSpawnIntentId: intent.intentId
  };
}

function readiness(child) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    child.stdio[3].on("data", (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try { resolve(JSON.parse(buffer.slice(0, newline))); }
      catch (error) { reject(error); }
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`bootstrap exited ${code ?? signal}`)));
  });
}

test("bootstrap-only state authority is stripped and Windows rejects before spawn", async () => {
  const childEnv = providerChildEnvironment({
    HOME: "/isolated/provider-home",
    GROK_COMPANION_JOB_MARKER: "task-aabbccddeeff0011",
    GROK_COMPANION_BOOTSTRAP_PLUGIN_DATA: "/private/control-state",
    GROK_COMPANION_BOOTSTRAP_SECRET: "must-not-cross"
  });
  assert.equal(childEnv.HOME, "/isolated/provider-home");
  assert.equal(childEnv.GROK_COMPANION_JOB_MARKER, "task-aabbccddeeff0011");
  assert.equal(childEnv.GROK_COMPANION_BOOTSTRAP_PLUGIN_DATA, undefined);
  assert.equal(childEnv.GROK_COMPANION_BOOTSTRAP_SECRET, undefined);

  let spawnCalls = 0;
  await assert.rejects(
    runProviderBootstrap({
      platform: "win32",
      argv: [],
      spawnProvider: () => { spawnCalls += 1; }
    }),
    (error) => error?.code === "E_CAPABILITY"
  );
  assert.equal(spawnCalls, 0);
});

test("bootstrap argv contains only opaque dispatch coordinates while the private spec is exact", async () => {
  const root = "/private/workspace/root-that-must-not-enter-argv";
  const owner = "019f76cf-150d-7ec6-892e-4e68fa7a71a3";
  const marker = "task-aabbccddeeff0011";
  const intentId = "a".repeat(32);
  const launch = createProviderBootstrapLaunch({
    root,
    marker,
    owner,
    binding: {
      controlWorkspaceId: `cws-${"b".repeat(32)}`,
      executionRoot: root,
      dispatchAttemptId: "c".repeat(32),
      dispatchFence: 1,
      providerGeneration: 3,
      providerSpawnIntentId: intentId
    },
    binary: "/private/provider/binary-that-must-not-enter-argv",
    args: ["agent", "stdio", "--private-argument"]
  });
  assert.deepEqual(launch.argv, [
    BOOTSTRAP,
    "--job-marker", marker,
    "--provider-generation", "3",
    "--spawn-intent-id", intentId
  ]);
  const renderedArgv = launch.argv.join(" ");
  assert.equal(renderedArgv.includes(root), false);
  assert.equal(renderedArgv.includes(owner), false);
  assert.equal(renderedArgv.includes("binary-that-must-not-enter-argv"), false);
  assert.equal(renderedArgv.includes("private-argument"), false);
  assert.equal(renderedArgv.includes("--spec"), false);

  const expected = { marker, generation: 3, intentId };
  const parsed = await readProviderBootstrapSpec(Readable.from([launch.specPayload]), expected);
  assert.equal(parsed.root, root);
  assert.equal(parsed.owner, owner);
  assert.deepEqual(parsed.args, ["agent", "stdio", "--private-argument"]);
  assert.throws(
    () => createProviderBootstrapLaunch({
      root,
      marker,
      owner,
      binding: parsed.binding,
      binary: parsed.binary,
      args: ["x".repeat(64 * 1024)]
    }),
    (error) => error?.code === "E_USAGE"
  );
});

test("private bootstrap spec channel rejects missing, truncated, extra, malformed, and oversized input", async () => {
  const expected = {
    marker: "task-aabbccddeeff0011",
    generation: 1,
    intentId: "d".repeat(32)
  };
  const spec = {
    schemaVersion: 1,
    root: "/private/exact-bootstrap-root",
    marker: expected.marker,
    owner: THREAD_ID,
    binding: {
      controlWorkspaceId: `cws-${"e".repeat(32)}`,
      executionRoot: "/private/exact-bootstrap-root",
      dispatchAttemptId: "f".repeat(32),
      dispatchFence: 1,
      providerGeneration: expected.generation,
      providerSpawnIntentId: expected.intentId
    },
    binary: "/private/exact-provider-binary",
    args: ["agent", "stdio"]
  };
  const payload = `${JSON.stringify(spec)}\n`;
  await assert.rejects(
    () => readProviderBootstrapSpec(null, expected),
    (error) => error?.code === "E_PROTOCOL" && /unavailable/.test(error.message)
  );
  for (const invalid of [
    payload.slice(0, -1),
    `${payload}extra`,
    "{malformed}\n",
    `${JSON.stringify({ ...spec, unexpected: true })}\n`,
    `${JSON.stringify({ ...spec, args: ["x".repeat(8 * 1024 + 1)] })}\n`
  ]) {
    await assert.rejects(
      () => readProviderBootstrapSpec(Readable.from([invalid]), expected),
      (error) => ["E_PROTOCOL", "E_USAGE"].includes(error?.code)
    );
  }
  await assert.rejects(
    () => readProviderBootstrapSpec(Readable.from([Buffer.alloc(64 * 1024 + 1, 0x61)]), expected),
    (error) => error?.code === "E_PROTOCOL" && /exceeded/.test(error.message)
  );
});

test("bootstrap process and parent publisher fail closed when the inherited spec pipe is missing or closed", {
  skip: process.platform === "win32"
}, async (t) => {
  const marker = "task-aabbccddeeff0011";
  const intentId = "a".repeat(32);
  const missing = spawn(process.execPath, [
    BOOTSTRAP,
    "--job-marker", marker,
    "--provider-generation", "1",
    "--spawn-intent-id", intentId
  ], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "pipe", "ignore", "ignore", "ignore"]
  });
  t.after(() => { try { process.kill(-missing.pid, "SIGKILL"); } catch {} });
  let unexpectedReadiness = "";
  missing.stdio[3].on("data", (chunk) => { unexpectedReadiness += String(chunk); });
  const missingExit = await waitForClose(missing);
  assert.equal(missingExit.code, 1);
  assert.equal(unexpectedReadiness, "");

  await assert.rejects(
    () => publishProviderBootstrapSpec({ stdio: [] }, "{}\n"),
    (error) => error?.code === "E_PROTOCOL"
  );

  const closeSource = [
    "const fs = require('node:fs');",
    "fs.closeSync(6);",
    "fs.writeSync(3, 'spec-closed\\n');",
    "setInterval(() => {}, 1000);"
  ].join(" ");
  const closed = spawn(process.execPath, ["-e", closeSource], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "pipe", "ignore", "ignore", "pipe"]
  });
  t.after(() => { try { process.kill(-closed.pid, "SIGKILL"); } catch {} });
  await new Promise((resolve, reject) => {
    closed.stdio[3].once("data", resolve);
    closed.once("error", reject);
    closed.once("exit", () => reject(new Error("closed-spec fixture exited before synchronization")));
  });
  await assert.rejects(
    () => publishProviderBootstrapSpec(closed, "{}\n", { timeoutMs: 1_000 }),
    (error) => error?.code === "E_PROVIDER_EXIT"
  );
  const closedExit = waitForClose(closed);
  process.kill(-closed.pid, "SIGKILL");
  await closedExit;
});

test("promotion handshake fails closed when the bootstrap closes its control pipes", {
  skip: process.platform === "win32"
}, async (t) => {
  const source = [
    "const fs = require('node:fs');",
    "fs.closeSync(4);",
    "fs.closeSync(5);",
    "fs.writeSync(3, 'ready\\n');",
    "setInterval(() => {}, 1000);"
  ].join(" ");
  const child = spawn(process.execPath, ["-e", source], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe", "pipe"]
  });
  t.after(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  });
  await new Promise((resolve, reject) => {
    child.stdio[3].once("data", resolve);
    child.once("error", reject);
    child.once("exit", () => reject(new Error("control-race fixture exited before readiness")));
  });
  await assert.rejects(
    () => promoteProviderBootstrap(child, {
      marker: "task-aabbccddeeff0011",
      providerGeneration: 1,
      providerSpawnIntentId: "a".repeat(32)
    }, { timeoutMs: 1_000 }),
    (error) => ["E_PROVIDER_EXIT", "E_PROCESS_IDENTITY"].includes(error?.code)
  );
  const closed = waitForClose(child);
  process.kill(-child.pid, "SIGKILL");
  await closed;
});

test("recovery revokes a committed provider intent before a late bootstrap can register", {
  skip: process.platform === "win32"
}, async (t) => {
  const fixture = await workerStartedFixture(t, "late-registration");
  const prepared = prepareWorkerProviderSpawn({
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    fence: fixture.claim.fence,
    providerGeneration: 1,
    env: fixture.env
  });
  const recovery = await reconcileBrokerWorkers({
    root: fixture.root,
    principal: fixture.principal,
    dispatchStartupGraceMs: 0,
    env: fixture.env
  });
  assert.equal(recovery.results[0].action, "marked-lost");
  const settled = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  assert.equal(settled.request.spawn.providerSpawnIntent.status, "no-child");
  assert.equal(settled.request.spawn.providerSpawnIntent.resolution, "authorization-revoked");
  assert.equal(settled.result.runtimeEvidence.reconciler.replayedPrompt, false);
  assert.equal(loadProviderGuard(fixture.root, fixture.workerId), null);

  const binding = {
    controlWorkspaceId: settled.controlWorkspaceId,
    executionRoot: settled.request.spawn.executionRoot,
    dispatchAttemptId: fixture.claim.attemptId,
    dispatchFence: fixture.claim.fence,
    providerGeneration: 1,
    providerSpawnIntentId: prepared.intent.intentId
  };
  assert.throws(
    () => registerProviderGuard(
      fixture.root,
      fixture.workerId,
      { pid: 9_700_001, startToken: "late-bootstrap", processGroupId: 9_700_001 },
      THREAD_ID,
      "provider",
      binding,
      fixture.env
    ),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  assert.equal(loadProviderGuard(fixture.root, fixture.workerId), null);
});

test("failed bootstrap cleanup preserves an exact concurrent guard winner", {
  skip: process.platform === "win32"
}, async (t) => {
  const fixture = await workerStartedFixture(t, "cleanup-winner");
  const prepared = prepareWorkerProviderSpawn({
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    fence: fixture.claim.fence,
    providerGeneration: 1,
    env: fixture.env
  });
  const binding = bootstrapBinding(fixture, prepared.intent);
  const winner = spawnIdle(t);
  const winnerIdentity = await providerIdentityFor(winner);
  const winnerGuard = registerProviderGuard(
    fixture.root,
    fixture.workerId,
    winnerIdentity,
    THREAD_ID,
    "provider",
    binding,
    fixture.env
  );
  const loser = spawnIdle(t);
  const loserIdentity = await providerIdentityFor(loser);
  let profileCleaned = false;
  await assert.rejects(
    () => cleanupBoundBootstrapStart({
      child: loser,
      identity: loserIdentity,
      root: fixture.root,
      marker: fixture.workerId,
      stagedProfile: { cleanup: () => { profileCleaned = true; } },
      guardBinding: binding,
      env: fixture.env
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  assert.equal(await waitFor(() => processGroupGone(loserIdentity)), true);
  assert.deepEqual(loadProviderGuard(fixture.root, fixture.workerId), winnerGuard);
  assert.equal(processGroupGone(winnerIdentity), false);
  assert.equal(profileCleaned, false, "ambiguous ownership must retain the staged profile");

  unregisterProviderGuard(fixture.root, fixture.workerId, winnerGuard, fixture.env);
  await killAndWait(winner, winnerIdentity);
});

test("post-guard version failure kills the whole owned group and retains exact recovery evidence", {
  skip: process.platform === "win32"
}, async (t) => {
  const fixture = await workerStartedFixture(t, "version-descendant");
  const prepared = prepareWorkerProviderSpawn({
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    fence: fixture.claim.fence,
    providerGeneration: 1,
    env: fixture.env
  });
  const binaryDirectory = tempDir("provider-version-descendant-");
  const binary = path.join(binaryDirectory, "grok-version-fixture.mjs");
  const resistantSource = [
    "process.on('SIGTERM', () => {});",
    "process.stdout.write('ready\\n');",
    "setInterval(() => {}, 1000);"
  ].join(" ");
  fs.writeFileSync(binary, [
    `#!${process.execPath}`,
    "import process from 'node:process';",
    "import { spawn } from 'node:child_process';",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(resistantSource)}], { detached: false, stdio: ['ignore', 'pipe', 'ignore'] });`,
    "child.stdout.once('data', () => { child.stdout.destroy(); child.unref(); process.exit(23); });"
  ].join("\n"), { mode: 0o700 });
  t.after(() => fs.rmSync(binaryDirectory, { recursive: true, force: true }));

  const launch = bootstrapLaunch(fixture, prepared.intent, [], { binary });
  const child = spawn(
    process.execPath,
    launch.argv,
    {
      cwd: fixture.root,
      env: {
        ...fixture.env,
        GROK_COMPANION_JOB_MARKER: fixture.workerId,
        GROK_COMPANION_BOOTSTRAP_PLUGIN_DATA: fixture.pluginData
      },
      detached: true,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"]
    }
  );
  t.after(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  });
  await publishProviderBootstrapSpec(child, launch.specPayload);
  await waitForClose(child);
  const guard = loadProviderGuard(fixture.root, fixture.workerId);
  assert.equal(guard?.schemaVersion, 3);
  assert.equal(guard?.providerSpawnIntentId, prepared.intent.intentId);
  assert.equal(await waitFor(() => processGroupGone(guard.providerProcess)), true);
  unregisterProviderGuard(fixture.root, fixture.workerId, guard, fixture.env);
});

test("an actual bootstrap guard wins recovery, is promoted exactly, and receives no ACP before promotion", {
  skip: process.platform === "win32"
}, async (t) => {
  const fixture = await workerStartedFixture(t, "guard-wins");
  const prepared = prepareWorkerProviderSpawn({
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    fence: fixture.claim.fence,
    providerGeneration: 1,
    env: fixture.env
  });
  const stdinEvidence = path.join(tempDir("provider-bootstrap-stdin-"), "stdin.log");
  t.after(() => fs.rmSync(path.dirname(stdinEvidence), { recursive: true, force: true }));
  const providerSource = [
    "const fs = require('node:fs');",
    `process.stdin.on('data', chunk => fs.appendFileSync(${JSON.stringify(stdinEvidence)}, chunk));`,
    "setInterval(() => {}, 1000);"
  ].join(" ");
  const launch = bootstrapLaunch(fixture, prepared.intent, [
    "-e", providerSource, fixture.workerId, "agent", "stdio"
  ]);
  const child = spawn(
    process.execPath,
    launch.argv,
    {
      cwd: fixture.root,
      env: {
        ...fixture.env,
        GROK_COMPANION_JOB_MARKER: fixture.workerId,
        GROK_COMPANION_BOOTSTRAP_PLUGIN_DATA: fixture.pluginData
      },
      detached: true,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"]
    }
  );
  t.after(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  });
  await publishProviderBootstrapSpec(child, launch.specPayload);
  const ready = await readiness(child);
  assert.equal(ready.type, "provider-ready");
  const guard = loadProviderGuard(fixture.root, fixture.workerId);
  assert.equal(guard.schemaVersion, 3);
  assert.equal(guard.providerSpawnIntentId, prepared.intent.intentId);
  assert.equal(guard.providerProcess.pid, child.pid);
  assert.equal(fs.existsSync(stdinEvidence), false, "bootstrap forwarded bytes before dispatch promotion");

  const recovery = await reconcileBrokerWorkers({
    root: fixture.root,
    principal: fixture.principal,
    dispatchStartupGraceMs: 0,
    env: fixture.env
  });
  assert.equal(recovery.results[0].action, "marked-lost");
  assert.equal(recovery.replayedPrompt, false);
  const settled = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  assert.equal(settled.request.spawn.dispatch.providerGeneration, 1);
  assert.equal(settled.request.spawn.providerSpawnIntent.status, "registered");
  assert.equal(settled.providerProcess.pid, child.pid);
  assert.equal(settled.result.runtimeEvidence.reconciler.replayedPrompt, false);
  await waitFor(() => processGroupGone(guard.providerProcess));
  assert.equal(loadProviderGuard(fixture.root, fixture.workerId), null);
  assert.equal(fs.existsSync(stdinEvidence), false, "recovery sent ACP bytes while cleaning the unpromoted bootstrap");
  assertDispatchContract(settled);
});

test("bootstrap shutdown escalates a TERM-resistant Grok child and acknowledges promotion before ACP", {
  skip: process.platform === "win32"
}, async (t) => {
  const fixture = await workerStartedFixture(t, "term-resistant");
  const prepared = prepareWorkerProviderSpawn({
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    fence: fixture.claim.fence,
    providerGeneration: 1,
    env: fixture.env
  });
  const binding = bootstrapBinding(fixture, prepared.intent);
  const providerSource = [
    "process.on('SIGTERM', () => {});",
    "process.stdout.write('term-handler-ready\\n');",
    "process.stdin.resume();",
    "setInterval(() => {}, 1000);"
  ].join(" ");
  const launch = bootstrapLaunch(fixture, prepared.intent, [
    "-e", providerSource, fixture.workerId, "agent", "stdio"
  ]);
  const child = spawn(
    process.execPath,
    launch.argv,
    {
      cwd: fixture.root,
      env: {
        ...fixture.env,
        GROK_COMPANION_JOB_MARKER: fixture.workerId,
        GROK_COMPANION_BOOTSTRAP_PLUGIN_DATA: fixture.pluginData
      },
      detached: true,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"]
    }
  );
  t.after(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  });
  await publishProviderBootstrapSpec(child, launch.specPayload);
  const providerHandlerReady = new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("error", reject);
    child.once("exit", () => reject(new Error("bootstrap exited before provider signal handler was ready")));
  });
  const ready = await readiness(child);
  assert.equal(ready.type, "provider-ready");
  await providerHandlerReady;
  const acknowledgement = await promoteProviderBootstrap(child, {
    marker: fixture.workerId,
    providerGeneration: binding.providerGeneration,
    providerSpawnIntentId: binding.providerSpawnIntentId
  });
  assert.equal(acknowledgement.type, "provider-promoted");

  const closed = waitForClose(child);
  child.stdin.end();
  await closed;
  const guard = loadProviderGuard(fixture.root, fixture.workerId);
  assert.equal(await waitFor(() => processGroupGone({
    pid: child.pid,
    startToken: null,
    processGroupId: child.pid
  })), true);
  assert.equal(guard?.schemaVersion, 3);
  assert.equal(guard?.providerSpawnIntentId, prepared.intent.intentId);
  unregisterProviderGuard(fixture.root, fixture.workerId, guard, fixture.env);
});
