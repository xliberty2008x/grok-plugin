import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildTaskEnvelope } from "../plugins/grok/scripts/lib/task-contract.mjs";
import { spawnReadOnlyWorker } from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import { reconcileOwnedWorkers } from "../plugins/grok/scripts/lib/worker-reconcile.mjs";
import { tryReadJob, updateJob } from "../plugins/grok/scripts/lib/state.mjs";
import { initRepo, tempDir } from "./helpers.mjs";

const THREAD_ID = "019f6aa8-3066-7ac2-80ac-e38b5cfe11b4";

function principal(root) {
  return {
    hostKind: "codex",
    threadId: THREAD_ID,
    source: "codex-mcp-stdio",
    pluginId: "grok@grok-companion",
    root,
    mutationCapable: true
  };
}

function envFor() {
  const pluginData = tempDir("grok-reconcile-safety-data-");
  return {
    HOME: path.dirname(pluginData),
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_PLUGIN_DATA: pluginData
  };
}

function spawn(root, env, suffix, userRequest = `Reconcile safety ${suffix}`) {
  return spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest, mode: "read" }),
    idempotencyKey: `reconcile-safety-${suffix}`,
    env
  });
}

function forceActiveDispatchState(root, env, workerId, state, attemptId) {
  updateJob(root, workerId, (job) => ({
    ...job,
    status: "running",
    phase: "provider-launching",
    workerAuthorization: null,
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        providerLaunchPending: false,
        providerLaunchInFlight: true,
        providerLaunchOutcome: "pending",
        dispatch: {
          ...job.request.spawn.dispatch,
          state,
          attemptId,
          claimedAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z"
        }
      }
    }
  }), env);
}

function forceLegacyActiveState(root, env, workerId) {
  updateJob(root, workerId, (job) => {
    const legacySpawn = { ...job.request.spawn };
    delete legacySpawn.dispatch;
    return {
      ...job,
      status: "running",
      workerAuthorization: null,
      request: {
        ...job.request,
        spawn: {
          ...legacySpawn,
          providerLaunchPending: false,
          providerLaunchInFlight: false,
          providerLaunchOutcome: "not-launched"
        }
      }
    };
  }, env);
}

test("Worker Dispatch v1 active states are delegated to authoritative recovery without callbacks or terminalization", () => {
  const root = initRepo();
  const env = envFor();
  const fixtures = ["claimed", "controller-started", "worker-started"].map((state, index) => {
    const admitted = spawn(root, env, `${state}-${index}`);
    const attemptId = String(index + 1).repeat(32);
    forceActiveDispatchState(root, env, admitted.handle.id, state, attemptId);
    return { workerId: admitted.handle.id, state, attemptId };
  });
  let livenessCalls = 0;
  let cleanupCalls = 0;

  const reconciliation = reconcileOwnedWorkers({
    root,
    principal: principal(root),
    trusted: true,
    dispatchStartupGraceMs: 0,
    clock: () => Date.parse("2030-01-01T00:00:00.000Z"),
    processAlive: () => {
      livenessCalls += 1;
      throw new Error("legacy liveness callback must not run for Worker Dispatch v1");
    },
    cleanupProcess: () => {
      cleanupCalls += 1;
      throw new Error("legacy cleanup callback must not run for Worker Dispatch v1");
    },
    env
  });

  assert.equal(livenessCalls, 0);
  assert.equal(cleanupCalls, 0);
  for (const fixture of fixtures) {
    assert.deepEqual(
      reconciliation.results.find((item) => item.workerId === fixture.workerId),
      {
        workerId: fixture.workerId,
        action: "none",
        reason: "authoritative-broker-recovery-required",
        replayedPrompt: false
      }
    );
    const current = tryReadJob(root, fixture.workerId, env);
    assert.equal(current.status, "running");
    assert.equal(current.completedAt, null);
    assert.equal(current.request.spawn.dispatch.state, fixture.state);
    assert.equal(current.request.spawn.dispatch.attemptId, fixture.attemptId);
  }
});

test("unclaimed Worker Dispatch v1 remains recoverable and never replays or invokes legacy callbacks", () => {
  const root = initRepo();
  const env = envFor();
  const admitted = spawn(root, env, "pending");
  let callbackCalls = 0;

  const reconciliation = reconcileOwnedWorkers({
    root,
    principal: principal(root),
    trusted: true,
    processAlive: () => {
      callbackCalls += 1;
      throw new Error("pending dispatch must not probe liveness");
    },
    cleanupProcess: () => {
      callbackCalls += 1;
      throw new Error("pending dispatch must not run cleanup");
    },
    env
  });

  assert.equal(callbackCalls, 0);
  assert.equal(reconciliation.replayedPrompt, false);
  assert.deepEqual(reconciliation.results, [{
    workerId: admitted.handle.id,
    action: "none",
    reason: "dispatch-pending-recoverable",
    replayedPrompt: false
  }]);
  assert.equal(tryReadJob(root, admitted.handle.id, env).status, "queued");
});

test("legacy non-dispatch reconciliation publishes terminal only after exact cleanup proof and scrubs raw request", () => {
  const root = initRepo();
  const env = envFor();
  const rawCanary = "LEGACY_TERMINAL_RAW_CANARY_5aeed4c4";
  const admitted = spawn(root, env, "legacy", rawCanary);
  forceLegacyActiveState(root, env, admitted.handle.id);
  assert.match(JSON.stringify(tryReadJob(root, admitted.handle.id, env)), new RegExp(rawCanary));
  let livenessCalls = 0;
  let cleanupCalls = 0;

  const reconciliation = reconcileOwnedWorkers({
    root,
    principal: principal(root),
    trusted: true,
    processAlive: () => {
      livenessCalls += 1;
      return false;
    },
    cleanupProcess: (snapshot) => {
      cleanupCalls += 1;
      assert.equal(snapshot.id, admitted.handle.id);
      return { ok: true };
    },
    env
  });

  assert.equal(livenessCalls, 1);
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(reconciliation.results, [{
    workerId: admitted.handle.id,
    action: "marked-lost",
    reason: "process-not-alive",
    replayedPrompt: false
  }]);
  const terminal = tryReadJob(root, admitted.handle.id, env);
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.result.taskRuntimeCleaned, true);
  assert.equal(terminal.request.prompt, null);
  assert.equal(terminal.request.envelope.userRequest, null);
  assert.match(terminal.request.envelope.userRequestDigest, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(terminal), new RegExp(rawCanary));
});

test("legacy non-dispatch cleanup failure preserves scrubbed pending terminal intent until a proven retry", () => {
  const root = initRepo();
  const env = envFor();
  const rawCanary = "LEGACY_CLEANUP_FAILURE_RAW_CANARY_936ad84f";
  const admitted = spawn(root, env, "legacy-cleanup-failure", rawCanary);
  forceLegacyActiveState(root, env, admitted.handle.id);
  let cleanupCalls = 0;

  const blocked = reconcileOwnedWorkers({
    root,
    principal: principal(root),
    trusted: true,
    processAlive: () => false,
    cleanupProcess: () => {
      cleanupCalls += 1;
      throw new Error(`cleanup failed ${rawCanary}`);
    },
    env
  });

  assert.equal(cleanupCalls, 1);
  assert.deepEqual(blocked.results, [{
    workerId: admitted.handle.id,
    action: "cleanup-blocked",
    reason: "cleanup-unverified",
    replayedPrompt: false
  }]);
  const retained = tryReadJob(root, admitted.handle.id, env);
  assert.equal(retained.status, "running");
  assert.equal(retained.phase, "cleanup-blocked");
  assert.equal(retained.completedAt, null);
  assert.equal(retained.pendingTerminal.status, "failed");
  assert.equal(retained.pendingTerminal.phase, "lost");
  assert.equal(retained.pendingTerminal.error.code, "E_PROVIDER_EXIT");
  assert.equal(retained.error.code, "E_RUNTIME_CLEANUP");
  assert.equal(retained.result.taskRuntimeCleaned, false);
  assert.equal(retained.request.prompt, null);
  assert.equal(retained.request.envelope.userRequest, null);
  assert.doesNotMatch(JSON.stringify(retained), new RegExp(rawCanary));
  const pendingIntent = retained.pendingTerminal;

  const recovered = reconcileOwnedWorkers({
    root,
    principal: principal(root),
    trusted: true,
    processAlive: () => false,
    cleanupProcess: () => {
      cleanupCalls += 1;
      return { ok: true };
    },
    env
  });

  assert.equal(cleanupCalls, 2);
  assert.deepEqual(recovered.results, [{
    workerId: admitted.handle.id,
    action: "marked-lost",
    reason: "process-not-alive",
    replayedPrompt: false
  }]);
  const terminal = tryReadJob(root, admitted.handle.id, env);
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.phase, pendingIntent.phase);
  assert.equal(terminal.completedAt, pendingIntent.completedAt);
  assert.equal(terminal.error.code, pendingIntent.error.code);
  assert.equal(terminal.pendingTerminal, undefined);
  assert.equal(terminal.result.taskRuntimeCleaned, true);
  assert.equal(terminal.result.privacyWarning, undefined);
  assert.doesNotMatch(JSON.stringify(terminal), new RegExp(rawCanary));
});
