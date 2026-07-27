import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  acquireRecoveryCleanupFence,
  assertDispatchContract,
  claimWorkerDispatch,
  prepareDispatchProcessSpawn,
  recordUnsettledProviderProcess,
  recordUnsettledWorkerProcess,
  settleUnstartedDispatchLoss,
  spawnReadOnlyWorker,
  transitionWorkerDispatch,
  verifyRecoveryCleanupFence
} from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import { reconcileBrokerWorkers } from "../plugins/grok/scripts/lib/worker-recovery.mjs";
import {
  processGroupGone,
  processStartToken
} from "../plugins/grok/scripts/lib/process-control.mjs";
import { terminal, tryReadJob, updateJob } from "../plugins/grok/scripts/lib/state.mjs";
import { buildTaskEnvelope } from "../plugins/grok/scripts/lib/task-contract.mjs";

import { initRepo, tempDir, waitFor } from "./helpers.mjs";

const THREAD_ID = "019f6b7e-6649-7541-9fd2-a1cd2ad2b802";

function fixture(label) {
  const root = initRepo();
  const pluginData = tempDir("worker-recovery-fence-data-");
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
      userRequest: `Prove recovery cleanup fencing for ${label}`,
      mode: "read"
    }),
    idempotencyKey: `recovery-fence-${label}`,
    env
  });
  return { root, env, principal, workerId: admitted.handle.id };
}

function spawnIdleProcess(t, { signalFile = null, args = [] } = {}) {
  const source = signalFile
    ? [
        "const fs = require('node:fs');",
        `process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(signalFile)}, 'SIGTERM\\n'));`,
        "setInterval(() => {}, 1000);"
      ].join(" ")
    : "setInterval(() => {}, 1000);";
  const child = spawn(process.execPath, ["-e", source, ...args], {
    detached: true,
    stdio: "ignore"
  });
  t.after(() => {
    try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); }
    catch {}
  });
  return child;
}

async function boundIdentity(child, state, claim, extra = {}) {
  const identity = {
    pid: child.pid,
    startToken: await waitFor(() => processStartToken(child.pid), {
      timeoutMs: 5_000,
      intervalMs: 20
    }),
    processGroupId: process.platform === "win32" ? null : child.pid,
    nonce: claim.nonce,
    commandMarker: state.workerId,
    dispatchAttemptId: claim.attemptId,
    dispatchFence: claim.fence,
    ...extra
  };
  if (extra.providerGeneration) delete identity.nonce;
  return identity;
}

function killGroup(child) {
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function killAndWait(child, identity) {
  killGroup(child);
  await waitFor(() => processGroupGone(identity), { timeoutMs: 5_000, intervalMs: 20 });
}

function claim(state, label) {
  return claimWorkerDispatch({
    ...state,
    holderId: `host:recovery-fence:${label}`
  });
}

function prepareController(state, claimed, controllerProcess) {
  const intent = prepareDispatchProcessSpawn({
    root: state.root,
    workerId: state.workerId,
    attemptId: claimed.attemptId,
    fence: claimed.fence,
    processKind: "controller",
    nonce: claimed.nonce,
    env: state.env
  }).intent;
  const job = transitionWorkerDispatch({
    root: state.root,
    workerId: state.workerId,
    attemptId: claimed.attemptId,
    fence: claimed.fence,
    state: "controller-started",
    controllerProcess,
    spawnIntentId: intent.intentId,
    env: state.env
  });
  return { intent, job };
}

function prepareWorkerIntent(state, claimed) {
  return prepareDispatchProcessSpawn({
    root: state.root,
    workerId: state.workerId,
    attemptId: claimed.attemptId,
    fence: claimed.fence,
    processKind: "worker",
    nonce: claimed.nonce,
    env: state.env
  }).intent;
}

function prepareWorker(state, claimed, workerProcess) {
  const intent = prepareWorkerIntent(state, claimed);
  const job = transitionWorkerDispatch({
    root: state.root,
    workerId: state.workerId,
    attemptId: claimed.attemptId,
    fence: claimed.fence,
    state: "worker-started",
    workerProcess,
    spawnIntentId: intent.intentId,
    env: state.env
  });
  return { intent, job };
}

function prepareProvider(state, claimed, providerProcess) {
  return transitionWorkerDispatch({
    root: state.root,
    workerId: state.workerId,
    attemptId: claimed.attemptId,
    fence: claimed.fence,
    state: "provider-started",
    providerProcess,
    env: state.env
  });
}

function assertFenceRejects(action) {
  assert.throws(
    action,
    (error) => ["E_STATE", "E_PROCESS_IDENTITY"].includes(error?.code)
  );
}

test("registration committed after snapshot selection wins before recovery cleanup fencing", {
  skip: process.platform === "win32"
}, async (t) => {
  const state = fixture("registration-wins-0001");
  const claimed = claim(state, "registration-wins");
  const controllerChild = spawnIdleProcess(t);
  const workerChild = spawnIdleProcess(t);
  const controllerProcess = await boundIdentity(controllerChild, state, claimed);
  const workerProcess = await boundIdentity(workerChild, state, claimed);
  prepareController(state, claimed, controllerProcess);
  const workerIntent = prepareWorkerIntent(state, claimed);
  await killAndWait(controllerChild, controllerProcess);

  let registered = null;
  let hookCalls = 0;
  const recovery = await reconcileBrokerWorkers({
    root: state.root,
    principal: state.principal,
    dispatchStartupGraceMs: 0,
    testHooks: {
      afterSnapshotSelected(snapshot) {
        if (snapshot.id !== state.workerId) return;
        hookCalls += 1;
        registered = transitionWorkerDispatch({
          root: state.root,
          workerId: state.workerId,
          attemptId: claimed.attemptId,
          fence: claimed.fence,
          state: "worker-started",
          workerProcess,
          spawnIntentId: workerIntent.intentId,
          env: state.env
        });
      }
    },
    env: state.env
  });

  assert.equal(hookCalls, 1);
  assert.ok(recovery.results.some((entry) => (
    entry.workerId === state.workerId
    && entry.action === "none"
    && entry.reason === "worker-startup-intent-ambiguous"
  )));
  assert.deepEqual(tryReadJob(state.root, state.workerId, state.env), registered);
  assert.equal(registered.request.spawn.cleanupFence, undefined);
  assert.equal(registered.request.spawn.dispatch.state, "worker-started");
  assert.equal(registered.workerProcess.pid, workerProcess.pid);
  assert.equal(processGroupGone(workerProcess), false, "stale recovery must not signal the registered worker");
});

test("a controller cleanup fence rejects controller registration and settles only its original identity", {
  skip: process.platform === "win32"
}, async (t) => {
  const state = fixture("controller-fence-wins-0001");
  const claimed = claim(state, "controller-fence-wins");
  const controllerChild = spawnIdleProcess(t);
  const controllerProcess = await boundIdentity(controllerChild, state, claimed);
  const intent = prepareDispatchProcessSpawn({
    root: state.root,
    workerId: state.workerId,
    attemptId: claimed.attemptId,
    fence: claimed.fence,
    processKind: "controller",
    nonce: claimed.nonce,
    env: state.env
  }).intent;
  const blocked = updateJob(state.root, state.workerId, (job) => ({
    ...job,
    phase: "cleanup-blocked",
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        controllerCleanupPending: true,
        controllerCleanupProcess: controllerProcess
      }
    },
    result: {
      ...(job.result || {}),
      taskRuntimeCleaned: false
    }
  }), state.env);
  assert.doesNotThrow(() => assertDispatchContract(blocked));

  const cleanupFence = acquireRecoveryCleanupFence({
    root: state.root,
    workerId: state.workerId,
    attemptId: claimed.attemptId,
    fence: claimed.fence,
    source: "controller-cleanup",
    expectedDispatchState: "claimed",
    expectedProcessIdentity: controllerProcess,
    env: state.env
  });
  assertFenceRejects(() => transitionWorkerDispatch({
    root: state.root,
    workerId: state.workerId,
    attemptId: claimed.attemptId,
    fence: claimed.fence,
    state: "controller-started",
    controllerProcess,
    spawnIntentId: intent.intentId,
    env: state.env
  }));

  await killAndWait(controllerChild, controllerProcess);
  const settled = settleUnstartedDispatchLoss({
    root: state.root,
    workerId: state.workerId,
    attemptId: claimed.attemptId,
    dispatchState: "claimed",
    controllerCleanupProcess: controllerProcess,
    cleanupFenceId: cleanupFence.fenceId,
    runtimeCleanup: { ok: true },
    env: state.env
  });
  assert.equal(terminal(settled), true);
  assert.equal(settled.request.spawn.cleanupFence, null);
  assert.equal(settled.request.spawn.controllerCleanupProcess, null);
});

test("an unsettled-worker cleanup fence rejects worker registration and settles only its original identity", {
  skip: process.platform === "win32"
}, async (t) => {
  const state = fixture("worker-fence-wins-0001");
  const claimed = claim(state, "worker-fence-wins");
  const controllerChild = spawnIdleProcess(t);
  const workerChild = spawnIdleProcess(t);
  const controllerProcess = await boundIdentity(controllerChild, state, claimed);
  const workerProcess = await boundIdentity(workerChild, state, claimed);
  prepareController(state, claimed, controllerProcess);
  const workerIntent = prepareWorkerIntent(state, claimed);
  recordUnsettledWorkerProcess({
    root: state.root,
    workerId: state.workerId,
    attemptId: claimed.attemptId,
    workerProcess,
    env: state.env
  });
  const cleanupFence = acquireRecoveryCleanupFence({
    root: state.root,
    workerId: state.workerId,
    attemptId: claimed.attemptId,
    fence: claimed.fence,
    source: "unsettled-worker",
    expectedDispatchState: "controller-started",
    expectedProcessIdentity: workerProcess,
    env: state.env
  });

  assertFenceRejects(() => transitionWorkerDispatch({
    root: state.root,
    workerId: state.workerId,
    attemptId: claimed.attemptId,
    fence: claimed.fence,
    state: "worker-started",
    workerProcess,
    spawnIntentId: workerIntent.intentId,
    env: state.env
  }));

  await killAndWait(workerChild, workerProcess);
  await killAndWait(controllerChild, controllerProcess);
  const settled = settleUnstartedDispatchLoss({
    root: state.root,
    workerId: state.workerId,
    attemptId: claimed.attemptId,
    dispatchState: "controller-started",
    controllerProcess,
    unsettledWorkerProcess: workerProcess,
    cleanupFenceId: cleanupFence.fenceId,
    runtimeCleanup: { ok: true },
    env: state.env
  });
  assert.equal(terminal(settled), true);
  assert.equal(settled.request.spawn.cleanupFence, null);
  assert.equal(settled.request.spawn.unsettledWorkerProcess, null);
});

test("an unsettled-provider cleanup fence rejects provider registration and settles only its original identity", {
  skip: process.platform === "win32"
}, async (t) => {
  const state = fixture("provider-fence-wins-0001");
  const claimed = claim(state, "provider-fence-wins");
  const controllerChild = spawnIdleProcess(t);
  const workerChild = spawnIdleProcess(t);
  const providerChild = spawnIdleProcess(t, {
    args: [
      state.workerId,
      "agent",
      "--leader-socket",
      path.join(state.root, `leader-${state.workerId}.sock`),
      "stdio"
    ]
  });
  const controllerProcess = await boundIdentity(controllerChild, state, claimed);
  const workerProcess = await boundIdentity(workerChild, state, claimed);
  const providerProcess = await boundIdentity(providerChild, state, claimed, { providerGeneration: 1 });
  prepareController(state, claimed, controllerProcess);
  prepareWorker(state, claimed, workerProcess);
  const unsettledProviderProcess = { ...providerProcess, startToken: null };
  recordUnsettledProviderProcess({
    root: state.root,
    workerId: state.workerId,
    attemptId: claimed.attemptId,
    providerProcess: unsettledProviderProcess,
    env: state.env
  });
  const cleanupFence = acquireRecoveryCleanupFence({
    root: state.root,
    workerId: state.workerId,
    attemptId: claimed.attemptId,
    fence: claimed.fence,
    source: "provider-generation",
    expectedDispatchState: "worker-started",
    expectedProcessIdentity: unsettledProviderProcess,
    env: state.env
  });
  assert.equal(cleanupFence.mode, "observe-only");

  assertFenceRejects(() => prepareProvider(state, claimed, providerProcess));

  await killAndWait(providerChild, unsettledProviderProcess);
  await killAndWait(workerChild, workerProcess);
  await killAndWait(controllerChild, controllerProcess);
  const settled = settleUnstartedDispatchLoss({
    root: state.root,
    workerId: state.workerId,
    attemptId: claimed.attemptId,
    dispatchState: "worker-started",
    controllerProcess,
    workerProcess,
    unsettledProviderProcess,
    cleanupFenceId: cleanupFence.fenceId,
    runtimeCleanup: { ok: true },
    env: state.env
  });
  assert.equal(terminal(settled), true);
  assert.equal(settled.request.spawn.cleanupFence, null);
  assert.equal(settled.providerProcess.pid, providerProcess.pid);
  assert.equal(settled.providerProcess.startToken, null);
});

test("recovery fence verification rejects exact-identity tampering before process signaling", {
  skip: process.platform === "win32"
}, async (t) => {
  const workerState = fixture("verify-worker-tamper-0001");
  const workerClaim = claim(workerState, "verify-worker-tamper");
  const controllerChild = spawnIdleProcess(t);
  const workerChild = spawnIdleProcess(t);
  const controllerProcess = await boundIdentity(controllerChild, workerState, workerClaim);
  const workerProcess = await boundIdentity(workerChild, workerState, workerClaim);
  prepareController(workerState, workerClaim, controllerProcess);
  prepareWorkerIntent(workerState, workerClaim);
  recordUnsettledWorkerProcess({
    root: workerState.root,
    workerId: workerState.workerId,
    attemptId: workerClaim.attemptId,
    workerProcess,
    env: workerState.env
  });
  const workerFence = acquireRecoveryCleanupFence({
    root: workerState.root,
    workerId: workerState.workerId,
    attemptId: workerClaim.attemptId,
    fence: workerClaim.fence,
    source: "unsettled-worker",
    expectedDispatchState: "controller-started",
    expectedProcessIdentity: workerProcess,
    env: workerState.env
  });
  const workerBaseline = structuredClone(tryReadJob(
    workerState.root,
    workerState.workerId,
    workerState.env
  ));
  const workerCorruptions = [
    ["cleanup fence id", (job) => { job.request.spawn.cleanupFence.fenceId = "f".repeat(32); }],
    ["process attempt", (job) => { job.request.spawn.cleanupFence.processIdentity.dispatchAttemptId = "f".repeat(32); }],
    ["process fence", (job) => { job.request.spawn.cleanupFence.processIdentity.dispatchFence += 1; }],
    ["process marker", (job) => { job.request.spawn.cleanupFence.processIdentity.commandMarker = "foreign-worker"; }],
    ["process nonce", (job) => { job.request.spawn.cleanupFence.processIdentity.nonce = "f".repeat(32); }]
  ];
  for (const [label, corrupt] of workerCorruptions) {
    updateJob(workerState.root, workerState.workerId, (job) => {
      const next = structuredClone(job);
      corrupt(next);
      return next;
    }, workerState.env);
    assert.throws(
      () => verifyRecoveryCleanupFence({
        root: workerState.root,
        workerId: workerState.workerId,
        fenceId: workerFence.fenceId,
        expectedProcessIdentity: workerProcess,
        env: workerState.env
      }),
      (error) => ["E_STATE", "E_PROCESS_IDENTITY"].includes(error?.code),
      label
    );
    assert.equal(processGroupGone(workerProcess), false, `${label} must be rejected before signaling`);
    updateJob(
      workerState.root,
      workerState.workerId,
      () => structuredClone(workerBaseline),
      workerState.env
    );
  }

  const providerState = fixture("verify-provider-generation-0001");
  const providerClaim = claim(providerState, "verify-provider-generation");
  const providerControllerChild = spawnIdleProcess(t);
  const providerWorkerChild = spawnIdleProcess(t);
  const providerChild = spawnIdleProcess(t);
  const providerController = await boundIdentity(providerControllerChild, providerState, providerClaim);
  const providerWorker = await boundIdentity(providerWorkerChild, providerState, providerClaim);
  const providerProcess = await boundIdentity(providerChild, providerState, providerClaim, {
    providerGeneration: 1
  });
  prepareController(providerState, providerClaim, providerController);
  prepareWorker(providerState, providerClaim, providerWorker);
  prepareProvider(providerState, providerClaim, providerProcess);
  const providerFence = acquireRecoveryCleanupFence({
    root: providerState.root,
    workerId: providerState.workerId,
    attemptId: providerClaim.attemptId,
    fence: providerClaim.fence,
    source: "provider-generation",
    expectedDispatchState: "provider-started",
    expectedProcessIdentity: providerProcess,
    env: providerState.env
  });
  updateJob(providerState.root, providerState.workerId, (job) => {
    const next = structuredClone(job);
    next.request.spawn.cleanupFence.processIdentity.providerGeneration += 1;
    return next;
  }, providerState.env);
  assert.throws(
    () => verifyRecoveryCleanupFence({
      root: providerState.root,
      workerId: providerState.workerId,
      fenceId: providerFence.fenceId,
      expectedProcessIdentity: providerProcess,
      env: providerState.env
    }),
    (error) => ["E_STATE", "E_PROCESS_IDENTITY"].includes(error?.code)
  );
  assert.equal(processGroupGone(providerProcess), false, "provider generation tampering must be rejected before signaling");
});

test("observe-only recovery never signals a live null-token provider and remains blocked", {
  skip: process.platform === "win32"
}, async (t) => {
  const state = fixture("observe-only-live-0001");
  const claimed = claim(state, "observe-only-live");
  const signalFile = path.join(tempDir("recovery-observe-signal-"), "sigterm");
  const controllerChild = spawnIdleProcess(t);
  const workerChild = spawnIdleProcess(t);
  const providerChild = spawnIdleProcess(t, { signalFile });
  const controllerProcess = await boundIdentity(controllerChild, state, claimed);
  const workerProcess = await boundIdentity(workerChild, state, claimed);
  const providerProcess = await boundIdentity(providerChild, state, claimed, { providerGeneration: 1 });
  prepareController(state, claimed, controllerProcess);
  prepareWorker(state, claimed, workerProcess);
  const unsettledProviderProcess = { ...providerProcess, startToken: null };
  recordUnsettledProviderProcess({
    root: state.root,
    workerId: state.workerId,
    attemptId: claimed.attemptId,
    providerProcess: unsettledProviderProcess,
    env: state.env
  });
  await killAndWait(workerChild, workerProcess);
  await killAndWait(controllerChild, controllerProcess);

  const recovery = await reconcileBrokerWorkers({
    root: state.root,
    principal: state.principal,
    dispatchStartupGraceMs: 0,
    env: state.env
  });
  assert.ok(recovery.results.some((entry) => (
    entry.workerId === state.workerId
    && entry.action === "cleanup-blocked"
    && entry.reason === "unsettled-provider-alive"
  )));
  const blocked = tryReadJob(state.root, state.workerId, state.env);
  assert.equal(terminal(blocked), false);
  assert.equal(blocked.phase, "cleanup-blocked");
  assert.equal(blocked.request.spawn.cleanupFence.mode, "observe-only");
  assert.equal(blocked.request.spawn.cleanupFence.processIdentity.startToken, null);
  assert.equal(processGroupGone(unsettledProviderProcess), false);
  assert.equal(fs.existsSync(signalFile), false, "observe-only recovery must not send SIGTERM");
});

test("recovery crash-resume reuses one durable fence and settles the process generation once", {
  skip: process.platform === "win32"
}, async (t) => {
  const state = fixture("crash-resume-0001");
  const claimed = claim(state, "crash-resume");
  const controllerChild = spawnIdleProcess(t);
  const workerChild = spawnIdleProcess(t);
  const providerChild = spawnIdleProcess(t, {
    args: [
      state.workerId,
      "agent",
      "--leader-socket",
      path.join(state.root, `leader-${state.workerId}.sock`),
      "stdio"
    ]
  });
  const controllerProcess = await boundIdentity(controllerChild, state, claimed);
  const workerProcess = await boundIdentity(workerChild, state, claimed);
  const providerProcess = await boundIdentity(providerChild, state, claimed, { providerGeneration: 1 });
  prepareController(state, claimed, controllerProcess);
  prepareWorker(state, claimed, workerProcess);
  prepareProvider(state, claimed, providerProcess);
  await killAndWait(workerChild, workerProcess);
  await killAndWait(controllerChild, controllerProcess);

  let firstFenceId = null;
  const interrupted = await reconcileBrokerWorkers({
    root: state.root,
    principal: state.principal,
    dispatchStartupGraceMs: 0,
    testHooks: {
      afterCleanupFenceClaimed(fence) {
        firstFenceId = fence.fenceId;
        throw new Error("simulated reconciler crash after durable fence claim");
      }
    },
    env: state.env
  });
  assert.ok(interrupted.results.some((entry) => (
    entry.workerId === state.workerId
    && entry.action === "cleanup-blocked"
    && entry.reason === "provider-cleanup-unverified"
  )));
  assert.match(firstFenceId, /^[0-9a-f]{32}$/);
  const durable = tryReadJob(state.root, state.workerId, state.env);
  assert.equal(durable.request.spawn.cleanupFence.fenceId, firstFenceId);
  assert.equal(processGroupGone(providerProcess), false);

  const resumedFenceIds = [];
  const resumed = await reconcileBrokerWorkers({
    root: state.root,
    principal: state.principal,
    dispatchStartupGraceMs: 0,
    testHooks: {
      afterCleanupFenceClaimed(fence) {
        resumedFenceIds.push(fence.fenceId);
      }
    },
    env: state.env
  });
  assert.deepEqual(resumedFenceIds, [firstFenceId]);
  assert.ok(resumed.results.some((entry) => (
    entry.workerId === state.workerId
    && entry.action === "marked-lost"
    && entry.reason === "worker-process-not-alive"
  )), JSON.stringify(resumed.results));
  const settled = tryReadJob(state.root, state.workerId, state.env);
  assert.equal(terminal(settled), true);
  assert.equal(settled.request.spawn.cleanupFence, null);
  assert.equal(processGroupGone(providerProcess), true);

  const terminalSnapshot = structuredClone(settled);
  const replay = await reconcileBrokerWorkers({
    root: state.root,
    principal: state.principal,
    dispatchStartupGraceMs: 0,
    env: state.env
  });
  assert.ok(replay.results.some((entry) => (
    entry.workerId === state.workerId
    && entry.action === "none"
    && entry.reason === "terminal"
  )));
  assert.deepEqual(tryReadJob(state.root, state.workerId, state.env), terminalSnapshot);
});
