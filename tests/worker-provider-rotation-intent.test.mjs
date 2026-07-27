import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  assertDispatchContract,
  authorizeWorkerProviderRotation,
  cancelWorker,
  claimWorkerDispatch,
  recordUnsettledProviderProcess,
  recordWorkerProviderRotationNoChild,
  spawnReadOnlyWorker,
  transitionWorkerDispatch
} from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import { reconcileBrokerWorkers } from "../plugins/grok/scripts/lib/worker-recovery.mjs";
import { processGroupGone, processStartToken } from "../plugins/grok/scripts/lib/process-control.mjs";
import {
  registerProviderGuard,
  unregisterProviderGuard
} from "../plugins/grok/scripts/lib/recursion-guard.mjs";
import { tryReadJob, updateJob } from "../plugins/grok/scripts/lib/state.mjs";
import { buildTaskEnvelope } from "../plugins/grok/scripts/lib/task-contract.mjs";

import { initRepo, tempDir, waitFor } from "./helpers.mjs";

const OWNER_THREAD = "019f6d85-3817-7db3-a541-c203c8c2db11";
const OLD_TIMESTAMP = "2026-01-01T00:00:00.000Z";
let fixtureSequence = 0;

function registeredSpawnIntent(processKind, attemptId, fence) {
  return {
    schemaVersion: 1,
    processKind,
    intentId: (processKind === "controller" ? "c" : "d").repeat(32),
    attemptId,
    fence,
    status: "registered",
    preparedAt: OLD_TIMESTAMP,
    updatedAt: OLD_TIMESTAMP,
    registeredAt: OLD_TIMESTAMP,
    noChildAt: null
  };
}

function ownerEnv(pluginData) {
  const env = {
    ...process.env,
    HOME: path.dirname(pluginData),
    GROK_COMPANION_PLUGIN_DATA: pluginData,
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_HOST_SESSION_ID: OWNER_THREAD,
    CODEX_THREAD_ID: OWNER_THREAD
  };
  for (const key of [
    "GROK_COMPANION_CHILD",
    "GROK_COMPANION_JOB_MARKER",
    "GROK_AGENT",
    "GROK_LEADER_SOCKET"
  ]) delete env[key];
  return env;
}

function goneProcess(pid, workerId, claim, extra = {}) {
  return {
    pid,
    startToken: `gone-${pid}`,
    processGroupId: process.platform === "win32" ? null : pid,
    nonce: claim.nonce,
    commandMarker: workerId,
    dispatchAttemptId: claim.attemptId,
    dispatchFence: claim.fence,
    ...extra
  };
}

function rotationFixture(label = "rotation-intent") {
  fixtureSequence += 1;
  const root = initRepo();
  const pluginData = tempDir(`grok-${label}-data-`);
  const env = ownerEnv(pluginData);
  const principal = { hostKind: "codex", threadId: OWNER_THREAD };
  const admitted = spawnReadOnlyWorker({
    root,
    principal,
    envelope: buildTaskEnvelope({
      userRequest: `Exercise provider rotation intent ${label}`,
      mode: "read"
    }),
    idempotencyKey: `${label}-${String(fixtureSequence).padStart(4, "0")}`,
    env
  });
  const workerId = admitted.handle.id;
  const claim = claimWorkerDispatch({ root, principal, workerId, env });
  const pidBase = 8_900_000 + (fixtureSequence * 10);
  const controllerProcess = goneProcess(pidBase + 1, workerId, claim);
  const workerProcess = goneProcess(pidBase + 2, workerId, claim);
  const providerProcess = goneProcess(pidBase + 3, workerId, claim, {
    nonce: undefined,
    providerGeneration: 1
  });
  assert.equal(processGroupGone(controllerProcess), true);
  assert.equal(processGroupGone(workerProcess), true);
  assert.equal(processGroupGone(providerProcess), true);

  updateJob(root, workerId, (job) => ({
    ...job,
    status: "running",
    phase: "responding",
    controllerProcess,
    workerProcess,
    providerProcess,
    workerAuthorization: null,
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        controllerSpawnIntent: registeredSpawnIntent("controller", claim.attemptId, claim.fence),
        workerSpawnIntent: registeredSpawnIntent("worker", claim.attemptId, claim.fence),
        consumedLaunchContractDigest: job.workerAuthorization.launchContractDigest,
        launchContractConsumedAt: OLD_TIMESTAMP,
        providerLaunchPending: false,
        providerLaunchInFlight: false,
        providerLaunchOutcome: "launched",
        providerLaunchCompletedAt: OLD_TIMESTAMP,
        dispatch: {
          ...job.request.spawn.dispatch,
          state: "provider-started",
          lease: null,
          providerGeneration: 1,
          nextProviderGeneration: null,
          controllerStartedAt: OLD_TIMESTAMP,
          workerStartedAt: OLD_TIMESTAMP,
          providerStartedAt: OLD_TIMESTAMP,
          updatedAt: OLD_TIMESTAMP
        }
      }
    }
  }), env);
  assertDispatchContract(tryReadJob(root, workerId, env));
  return {
    root,
    env,
    principal,
    workerId,
    claim,
    controllerProcess,
    workerProcess,
    providerProcess
  };
}

function authorizeRotation(fixture) {
  return authorizeWorkerProviderRotation({
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    workerProcess: fixture.workerProcess,
    env: fixture.env
  });
}

function spawnIdleProcess(t) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    detached: true,
    stdio: "ignore"
  });
  t.after(() => {
    try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch {}
  });
  return child;
}

async function liveProviderIdentity(child, fixture) {
  return {
    pid: child.pid,
    startToken: await waitFor(() => processStartToken(child.pid)),
    processGroupId: process.platform === "win32" ? null : child.pid,
    commandMarker: fixture.workerId,
    dispatchAttemptId: fixture.claim.attemptId,
    dispatchFence: fixture.claim.fence,
    providerGeneration: 2
  };
}

test("cleanup-proven no-child consumes one rotation intent without advancing generation", () => {
  const fixture = rotationFixture("rotation-no-child");
  const authorization = authorizeRotation(fixture);
  assert.equal(authorization.providerGeneration, 2);
  assert.equal(authorization.replayed, false);

  const authorized = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  assert.equal(authorized.request.spawn.providerRotationIntent.status, "pending");
  assert.equal(authorized.request.spawn.providerRotationIntent.intentId, authorization.intentId);
  assert.equal(authorized.request.spawn.dispatch.providerGeneration, 1);
  assert.equal(authorized.request.spawn.dispatch.nextProviderGeneration, 2);

  const settled = recordWorkerProviderRotationNoChild({
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    fence: fixture.claim.fence,
    intentId: authorization.intentId,
    resolution: "cleanup-proven",
    env: fixture.env
  });
  assert.equal(settled.request.spawn.dispatch.providerGeneration, 1);
  assert.equal(settled.request.spawn.dispatch.nextProviderGeneration, null);
  assert.equal(settled.request.spawn.providerRotationIntent.status, "no-child");
  assert.equal(settled.request.spawn.providerRotationIntent.resolution, "cleanup-proven");
  assert.ok(settled.request.spawn.providerRotationIntent.noChildAt);
  assert.equal(settled.request.spawn.providerRotationIntent.registeredAt, null);
  assertDispatchContract(settled);

  const replay = recordWorkerProviderRotationNoChild({
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    fence: fixture.claim.fence,
    intentId: authorization.intentId,
    resolution: "cleanup-proven",
    env: fixture.env
  });
  assert.equal(replay.request.spawn.providerRotationIntent.noChildAt,
    settled.request.spawn.providerRotationIntent.noChildAt);
  assert.throws(
    () => authorizeRotation(fixture),
    (error) => error?.code === "E_STATE"
  );
});

test("no-child settlement loses to a bound generation-2 guard and leaves intent pending", {
  skip: process.platform === "win32"
}, async (t) => {
  const fixture = rotationFixture("rotation-guard-wins");
  const authorization = authorizeRotation(fixture);
  const child = spawnIdleProcess(t);
  const providerProcess = await liveProviderIdentity(child, fixture);
  const current = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  const guard = registerProviderGuard(
    fixture.root,
    fixture.workerId,
    {
      pid: providerProcess.pid,
      startToken: providerProcess.startToken,
      processGroupId: providerProcess.processGroupId
    },
    OWNER_THREAD,
    "provider",
    {
      controlWorkspaceId: current.controlWorkspaceId,
      executionRoot: current.request.spawn.executionRoot,
      dispatchAttemptId: fixture.claim.attemptId,
      dispatchFence: fixture.claim.fence,
      providerGeneration: 2,
      providerSpawnIntentId: authorization.intentId
    },
    fixture.env
  );
  const replayedGuard = registerProviderGuard(
    fixture.root,
    fixture.workerId,
    {
      pid: providerProcess.pid,
      startToken: providerProcess.startToken,
      processGroupId: providerProcess.processGroupId
    },
    OWNER_THREAD,
    "provider",
    {
      controlWorkspaceId: current.controlWorkspaceId,
      executionRoot: current.request.spawn.executionRoot,
      dispatchAttemptId: fixture.claim.attemptId,
      dispatchFence: fixture.claim.fence,
      providerGeneration: 2,
      providerSpawnIntentId: authorization.intentId
    },
    fixture.env
  );
  assert.deepEqual(replayedGuard, guard, "exact schema-3 re-registration must be idempotent");
  assert.throws(
    () => registerProviderGuard(
      fixture.root,
      fixture.workerId,
      {
        pid: providerProcess.pid + 10_000,
        startToken: `${providerProcess.startToken}-replacement`,
        processGroupId: providerProcess.pid + 10_000
      },
      OWNER_THREAD,
      "provider",
      {
        controlWorkspaceId: current.controlWorkspaceId,
        executionRoot: current.request.spawn.executionRoot,
        dispatchAttemptId: fixture.claim.attemptId,
        dispatchFence: fixture.claim.fence,
        providerGeneration: 2,
        providerSpawnIntentId: authorization.intentId
      },
      fixture.env
    ),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  t.after(() => {
    try { unregisterProviderGuard(fixture.root, fixture.workerId, guard, fixture.env); } catch {}
  });

  assert.throws(
    () => recordWorkerProviderRotationNoChild({
      root: fixture.root,
      workerId: fixture.workerId,
      attemptId: fixture.claim.attemptId,
      fence: fixture.claim.fence,
      intentId: authorization.intentId,
      resolution: "spawn-not-created",
      env: fixture.env
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  const unchanged = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  assert.equal(unchanged.request.spawn.providerRotationIntent.status, "pending");
  assert.equal(unchanged.request.spawn.dispatch.providerGeneration, 1);
  assert.equal(unchanged.request.spawn.dispatch.nextProviderGeneration, 2);
  assertDispatchContract(unchanged);
});

test("a registered generation-2 provider consumes the rotation intent", {
  skip: process.platform === "win32"
}, async (t) => {
  const fixture = rotationFixture("rotation-registered");
  const authorization = authorizeRotation(fixture);
  const child = spawnIdleProcess(t);
  const providerProcess = await liveProviderIdentity(child, fixture);
  const current = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  const guard = registerProviderGuard(
    fixture.root,
    fixture.workerId,
    {
      pid: providerProcess.pid,
      startToken: providerProcess.startToken,
      processGroupId: providerProcess.processGroupId
    },
    OWNER_THREAD,
    "provider",
    {
      controlWorkspaceId: current.controlWorkspaceId,
      executionRoot: current.request.spawn.executionRoot,
      dispatchAttemptId: fixture.claim.attemptId,
      dispatchFence: fixture.claim.fence,
      providerGeneration: 2,
      providerSpawnIntentId: authorization.intentId
    },
    fixture.env
  );
  t.after(() => {
    try { unregisterProviderGuard(fixture.root, fixture.workerId, guard, fixture.env); } catch {}
  });

  const registered = transitionWorkerDispatch({
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    fence: fixture.claim.fence,
    state: "provider-started",
    providerProcess,
    spawnIntentId: authorization.intentId,
    env: fixture.env
  });
  assert.equal(registered.request.spawn.providerRotationIntent.status, "registered");
  assert.equal(registered.request.spawn.providerRotationIntent.intentId, authorization.intentId);
  assert.ok(registered.request.spawn.providerRotationIntent.registeredAt);
  assert.equal(registered.request.spawn.providerRotationIntent.noChildAt, null);
  assert.equal(registered.request.spawn.dispatch.providerGeneration, 2);
  assert.equal(registered.request.spawn.dispatch.nextProviderGeneration, null);
  assert.equal(registered.request.spawn.dispatch.providerRotationCount, 1);
  assert.equal(registered.providerProcess.pid, providerProcess.pid);
  assertDispatchContract(registered);
});

test("an unsettled generation-2 process consumes the intent but remains cleanup-blocked", {
  skip: process.platform === "win32"
}, async (t) => {
  const fixture = rotationFixture("rotation-unsettled");
  const authorization = authorizeRotation(fixture);
  const child = spawnIdleProcess(t);
  await waitFor(() => processStartToken(child.pid));
  const unsettledProvider = {
    pid: child.pid,
    startToken: null,
    processGroupId: child.pid,
    commandMarker: fixture.workerId,
    dispatchAttemptId: fixture.claim.attemptId,
    dispatchFence: fixture.claim.fence,
    providerGeneration: 2
  };

  const blocked = recordUnsettledProviderProcess({
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    providerProcess: unsettledProvider,
    env: fixture.env
  });
  assert.equal(blocked.status, "running");
  assert.equal(blocked.phase, "cleanup-blocked");
  assert.equal(blocked.request.spawn.providerRotationIntent.status, "registered");
  assert.equal(blocked.request.spawn.providerRotationIntent.intentId, authorization.intentId);
  assert.ok(blocked.request.spawn.providerRotationIntent.registeredAt);
  assert.equal(blocked.request.spawn.dispatch.state, "failed");
  assert.equal(blocked.request.spawn.dispatch.providerGeneration, 2);
  assert.equal(blocked.request.spawn.dispatch.nextProviderGeneration, null);
  assert.equal(blocked.providerProcess.startToken, null);
  assert.equal(blocked.pendingTerminal.status, "failed");
  assert.equal(blocked.result.taskRuntimeCleaned, false);
  assertDispatchContract(blocked);
});

test("cancellation before replacement spawn can consume the intent as cleanup-proven", () => {
  const fixture = rotationFixture("rotation-cancel-before-spawn");
  const authorization = authorizeRotation(fixture);
  const cancellation = cancelWorker({
    root: fixture.root,
    principal: fixture.principal,
    workerId: fixture.workerId,
    idempotencyKey: "rotation-cancel-before-spawn-receipt",
    env: fixture.env
  });
  assert.equal(cancellation.receipt.status, "accepted");

  const settled = recordWorkerProviderRotationNoChild({
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    fence: fixture.claim.fence,
    intentId: authorization.intentId,
    resolution: "cleanup-proven",
    env: fixture.env
  });
  assert.equal(settled.status, "running");
  assert.equal(settled.phase, "cancellation-requested");
  assert.equal(settled.request.spawn.providerRotationIntent.status, "no-child");
  assert.equal(settled.request.spawn.providerRotationIntent.resolution, "cleanup-proven");
  assert.equal(settled.request.spawn.dispatch.providerGeneration, 1);
  assert.equal(settled.request.spawn.dispatch.nextProviderGeneration, null);
  assert.equal(
    settled.lifecycleEvents.filter((event) => event.type === "cancellation.requested").length,
    1
  );
  assertDispatchContract(settled);
});

test("foreign intent, fence, and malformed durable intent are rejected without settlement", async (t) => {
  await t.test("foreign intent id", () => {
    const fixture = rotationFixture("rotation-foreign-intent");
    const authorization = authorizeRotation(fixture);
    const foreignIntentId = `${authorization.intentId[0] === "f" ? "e" : "f"}${authorization.intentId.slice(1)}`;
    assert.throws(
      () => recordWorkerProviderRotationNoChild({
        root: fixture.root,
        workerId: fixture.workerId,
        attemptId: fixture.claim.attemptId,
        fence: fixture.claim.fence,
        intentId: foreignIntentId,
        env: fixture.env
      }),
      (error) => error?.code === "E_PROCESS_IDENTITY"
    );
    const unchanged = tryReadJob(fixture.root, fixture.workerId, fixture.env);
    assert.equal(unchanged.request.spawn.providerRotationIntent.status, "pending");
    assert.equal(unchanged.request.spawn.providerRotationIntent.intentId, authorization.intentId);
    assert.equal(unchanged.request.spawn.dispatch.nextProviderGeneration, 2);
  });

  await t.test("foreign dispatch fence", () => {
    const fixture = rotationFixture("rotation-foreign-fence");
    const authorization = authorizeRotation(fixture);
    assert.throws(
      () => recordWorkerProviderRotationNoChild({
        root: fixture.root,
        workerId: fixture.workerId,
        attemptId: fixture.claim.attemptId,
        fence: fixture.claim.fence + 1,
        intentId: authorization.intentId,
        env: fixture.env
      }),
      (error) => error?.code === "E_PROCESS_IDENTITY"
    );
    const unchanged = tryReadJob(fixture.root, fixture.workerId, fixture.env);
    assert.equal(unchanged.request.spawn.providerRotationIntent.status, "pending");
    assert.equal(unchanged.request.spawn.dispatch.nextProviderGeneration, 2);
  });

  await t.test("malformed durable intent", () => {
    const fixture = rotationFixture("rotation-malformed-intent");
    const authorization = authorizeRotation(fixture);
    updateJob(fixture.root, fixture.workerId, (job) => ({
      ...job,
      request: {
        ...job.request,
        spawn: {
          ...job.request.spawn,
          providerRotationIntent: {
            ...job.request.spawn.providerRotationIntent,
            attemptId: "foreign-attempt"
          }
        }
      }
    }), fixture.env);
    assert.throws(
      () => recordWorkerProviderRotationNoChild({
        root: fixture.root,
        workerId: fixture.workerId,
        attemptId: fixture.claim.attemptId,
        fence: fixture.claim.fence,
        intentId: authorization.intentId,
        env: fixture.env
      }),
      (error) => error?.code === "E_STATE"
    );
    const malformed = tryReadJob(fixture.root, fixture.workerId, fixture.env);
    assert.equal(malformed.request.spawn.providerRotationIntent.status, "pending");
    assert.equal(malformed.request.spawn.dispatch.nextProviderGeneration, 2);
  });
});

test("pending rotation without a guard is atomically revoked and never replayed", async () => {
  const fixture = rotationFixture("rotation-pending-recovery");
  const authorization = authorizeRotation(fixture);

  const first = await reconcileBrokerWorkers({
    root: fixture.root,
    principal: fixture.principal,
    dispatchStartupGraceMs: 0,
    env: fixture.env
  });
  assert.equal(first.results.length, 1);
  assert.equal(first.results[0].action, "marked-lost");
  assert.equal(first.results[0].reason, "worker-process-not-alive");
  let settled = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  assert.equal(settled.status, "failed");
  assert.equal(settled.request.spawn.providerRotationIntent.status, "no-child");
  assert.equal(settled.request.spawn.providerRotationIntent.resolution, "authorization-revoked");
  assert.equal(settled.request.spawn.providerRotationIntent.intentId, authorization.intentId);
  assert.equal(settled.request.spawn.providerSpawnIntent.status, "no-child");
  assert.equal(settled.request.spawn.providerSpawnIntent.intentId, authorization.intentId);
  assert.equal(settled.request.spawn.dispatch.providerGeneration, 1);
  assert.equal(settled.request.spawn.dispatch.nextProviderGeneration, null);
  assert.equal(settled.result.runtimeEvidence.reconciler.replayedPrompt, false);

  const second = await reconcileBrokerWorkers({
    root: fixture.root,
    principal: fixture.principal,
    dispatchStartupGraceMs: 0,
    env: fixture.env
  });
  assert.equal(second.results.length, 1);
  assert.equal(second.results[0].action, "none");
  assert.equal(second.results[0].reason, "terminal");
  settled = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  assert.equal(settled.request.spawn.providerRotationIntent.status, "no-child");
  assert.equal(settled.request.spawn.dispatch.providerGeneration, 1);
  assert.equal(settled.request.spawn.dispatch.nextProviderGeneration, null);
  assertDispatchContract(settled);
});
