import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { reconcileBrokerWorkers } from "../plugins/grok/scripts/lib/worker-recovery.mjs";
import {
  cancelWorker,
  settleStartedWorkerLoss,
  spawnReadOnlyWorker
} from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import { createWorkerService } from "../plugins/grok/scripts/lib/worker-service.mjs";
import { tryReadJob, updateJob } from "../plugins/grok/scripts/lib/state.mjs";
import { buildTaskEnvelope } from "../plugins/grok/scripts/lib/task-contract.mjs";
import { workspaceState } from "../plugins/grok/scripts/lib/workspace.mjs";

import { initRepo, tempDir } from "./helpers.mjs";

const THREAD_ID = "019f666a-6469-7cc1-9a8d-8c1adf61e103";
const OLD_TIMESTAMP = "2026-01-01T00:00:00.000Z";

function principal(root) {
  return {
    hostKind: "codex",
    threadId: THREAD_ID,
    turnId: "019f666e-4084-7902-8447-249f72043a37",
    source: "codex-mcp-stdio",
    pluginId: "grok@grok-companion",
    root,
    mutationCapable: true
  };
}

function envFor() {
  const pluginData = tempDir("grok-terminal-intent-data-");
  return {
    HOME: pluginData,
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_PLUGIN_DATA: pluginData
  };
}

function deadIdentity(pid, workerId, attemptId, { nonce, providerGeneration, dispatchFence = 1 } = {}) {
  return {
    pid,
    startToken: `gone-process-${pid}`,
    processGroupId: pid,
    commandMarker: workerId,
    dispatchAttemptId: attemptId,
    dispatchFence,
    ...(nonce ? { nonce } : {}),
    ...(providerGeneration ? { providerGeneration } : {})
  };
}

function registeredIntent(processKind, attemptId, fence = 1) {
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

function providerStartedFixture(pendingTerminal) {
  const root = initRepo();
  const env = envFor();
  const admitted = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest: "Restore terminal intent", mode: "read" }),
    idempotencyKey: `spawn-terminal-intent-${pendingTerminal.status}-${pendingTerminal.phase}`,
    env
  });
  const workerId = admitted.handle.id;
  const attemptId = `${pendingTerminal.status[0] || "x"}`.repeat(32);
  const nonce = "a".repeat(32);
  const controllerProcess = deadIdentity(1_900_101, workerId, attemptId, { nonce });
  const workerProcess = deadIdentity(1_900_102, workerId, attemptId, { nonce });
  const providerProcess = deadIdentity(1_900_103, workerId, attemptId, { providerGeneration: 1 });

  updateJob(root, workerId, (job) => ({
    ...job,
    status: "running",
    phase: "cleanup-blocked",
    completedAt: null,
    summary: "Task finished, but transient runtime cleanup is incomplete.",
    error: {
      code: "E_STATE",
      message: "Task finished, but transient runtime cleanup is incomplete."
    },
    pendingTerminal,
    controllerProcess,
    workerProcess,
    providerProcess,
    workerAuthorization: null,
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        controllerSpawnIntent: registeredIntent("controller", attemptId),
        workerSpawnIntent: registeredIntent("worker", attemptId),
        consumedLaunchContractDigest: job.workerAuthorization.launchContractDigest,
        launchContractConsumedAt: OLD_TIMESTAMP,
        providerLaunchPending: false,
        providerLaunchInFlight: false,
        providerLaunchOutcome: "launched",
        providerLaunchCompletedAt: OLD_TIMESTAMP,
        dispatch: {
          ...job.request.spawn.dispatch,
          state: "provider-started",
          attemptId,
          fence: 1,
          lease: null,
          claimedAt: OLD_TIMESTAMP,
          controllerStartedAt: OLD_TIMESTAMP,
          workerStartedAt: OLD_TIMESTAMP,
          providerStartedAt: OLD_TIMESTAMP,
          providerGeneration: 1,
          nextProviderGeneration: null,
          updatedAt: OLD_TIMESTAMP
        }
      }
    },
    result: {
      ...(job.result || {}),
      hostVerification: "not_run",
      taskRuntimeCleaned: false,
      privacyWarning: "Transient task credentials remain."
    }
  }), env);

  return {
    root,
    env,
    workerId,
    attemptId,
    controllerProcess,
    workerProcess,
    providerProcess
  };
}

const terminalIntents = [
  {
    status: "completed",
    phase: "done",
    completedAt: "2026-07-22T10:00:00.000Z",
    error: null,
    summary: "Provider work completed"
  },
  {
    status: "cancelled",
    phase: "cancelled",
    completedAt: "2026-07-22T10:01:00.000Z",
    error: { code: "E_CANCELLED", message: "Cancellation completed by the worker." },
    summary: "Cancelled by request"
  },
  {
    status: "failed",
    phase: "failed",
    completedAt: "2026-07-22T10:02:00.000Z",
    error: {
      code: "E_PROVIDER_EXIT",
      message: "Provider returned a specific terminal failure.",
      details: { exitCode: 17 }
    },
    summary: "Specific provider failure"
  }
];

for (const intent of terminalIntents) {
  test(`provider-started recovery restores the exact ${intent.status} terminal intent`, {
    skip: process.platform === "win32"
  }, async () => {
    const fixture = providerStartedFixture(structuredClone(intent));
    const recovery = await reconcileBrokerWorkers({
      root: fixture.root,
      principal: principal(fixture.root),
      dispatchStartupGraceMs: 0,
      env: fixture.env
    });

    assert.equal(recovery.results.length, 1);
    assert.equal(recovery.results[0].action, "terminalized");
    assert.equal(recovery.results[0].reason, "pending-terminal-restored");
    const restored = tryReadJob(fixture.root, fixture.workerId, fixture.env);
    assert.equal(restored.status, intent.status);
    assert.equal(restored.phase, intent.phase);
    assert.equal(restored.completedAt, intent.completedAt);
    assert.equal(restored.summary, intent.summary);
    assert.deepEqual(restored.error, intent.error);
    assert.equal(restored.pendingTerminal, undefined);
    assert.equal(restored.result.taskRuntimeCleaned, true);
    assert.equal(Object.hasOwn(restored.result, "privacyWarning"), false);
    assert.equal(restored.result.runtimeEvidence.reconciler.replayedPrompt, false);
  });
}

test("pending terminal settlement rejects missing controller proof or a changed provider identity", {
  skip: process.platform === "win32"
}, () => {
  const fixture = providerStartedFixture(structuredClone(terminalIntents[0]));
  const common = {
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.attemptId,
    workerProcess: fixture.workerProcess,
    runtimeCleanup: { ok: true },
    env: fixture.env
  };
  assert.throws(
    () => settleStartedWorkerLoss({
      ...common,
      providerProcess: fixture.providerProcess
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  assert.throws(
    () => settleStartedWorkerLoss({
      ...common,
      controllerProcess: fixture.controllerProcess,
      providerProcess: {
        ...fixture.providerProcess,
        pid: fixture.providerProcess.pid + 1,
        processGroupId: fixture.providerProcess.pid + 1
      }
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  const before = JSON.stringify(tryReadJob(fixture.root, fixture.workerId, fixture.env));
  for (const [label, patch] of [
    ["controller fence", { controllerProcess: { ...fixture.controllerProcess, dispatchFence: 2 } }],
    ["controller nonce", { controllerProcess: { ...fixture.controllerProcess, nonce: "f".repeat(32) } }],
    ["worker fence", { workerProcess: { ...fixture.workerProcess, dispatchFence: 2 } }],
    ["worker nonce", { workerProcess: { ...fixture.workerProcess, nonce: "f".repeat(32) } }],
    ["provider marker", { providerProcess: { ...fixture.providerProcess, commandMarker: "task-foreign" } }],
    ["provider attempt", { providerProcess: { ...fixture.providerProcess, dispatchAttemptId: "f".repeat(32) } }],
    ["provider fence", { providerProcess: { ...fixture.providerProcess, dispatchFence: 2 } }],
    ["provider generation", { providerProcess: { ...fixture.providerProcess, providerGeneration: 2 } }]
  ]) {
    assert.throws(
      () => settleStartedWorkerLoss({
        ...common,
        controllerProcess: fixture.controllerProcess,
        providerProcess: fixture.providerProcess,
        ...patch
      }),
      (error) => error?.code === "E_PROCESS_IDENTITY",
      label
    );
    assert.equal(JSON.stringify(tryReadJob(fixture.root, fixture.workerId, fixture.env)), before, label);
  }
  assert.equal(tryReadJob(fixture.root, fixture.workerId, fixture.env).phase, "cleanup-blocked");
});

test("a stale recovery actor cannot clean a newly admitted same-lineage continuation", {
  skip: process.platform === "win32"
}, () => {
  const fixture = providerStartedFixture(structuredClone(terminalIntents[0]));
  const grokHome = path.join(
    workspaceState(fixture.root, fixture.env),
    "task-homes",
    fixture.workerId,
    ".grok"
  );
  const credential = path.join(grokHome, "auth.json");
  fs.mkdirSync(grokHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(credential, "{}\n", { mode: 0o600 });
  let cleanupCalls = 0;
  const cleanup = () => {
    cleanupCalls += 1;
    try { fs.unlinkSync(credential); } catch (error) { if (error.code !== "ENOENT") throw error; }
    return { ok: true };
  };
  const settlement = {
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.attemptId,
    controllerProcess: fixture.controllerProcess,
    workerProcess: fixture.workerProcess,
    providerProcess: fixture.providerProcess,
    runtimeCleanup: cleanup,
    env: fixture.env
  };

  const terminalJob = settleStartedWorkerLoss(settlement);
  assert.equal(terminalJob.status, "completed");
  assert.equal(cleanupCalls, 1);
  assert.equal(fs.existsSync(credential), false);

  const continuation = spawnReadOnlyWorker({
    root: fixture.root,
    principal: principal(fixture.root),
    envelope: buildTaskEnvelope({
      userRequest: "Continue after the recovered result",
      mode: "read"
    }),
    idempotencyKey: "terminal-cleanup-followup-0001",
    env: fixture.env
  });
  updateJob(fixture.root, continuation.handle.id, (job) => ({
    ...job,
    request: {
      ...job.request,
      providerHomeId: fixture.workerId
    }
  }), fixture.env);
  const child = tryReadJob(fixture.root, continuation.handle.id, fixture.env);
  assert.equal(child.request.providerHomeId, fixture.workerId);
  fs.writeFileSync(credential, "{\"continuation\":true}\n", { mode: 0o600 });

  // This models the loser of a two-reconciler race resuming from its stale
  // snapshot after the winner committed terminal state and admission created
  // the continuation. The cleanup callback must not run a second time.
  const replay = settleStartedWorkerLoss(settlement);
  assert.equal(replay.status, "completed");
  assert.equal(cleanupCalls, 1);
  assert.equal(fs.existsSync(credential), true);
});

function activeFixture(label) {
  const root = initRepo();
  const env = envFor();
  const admitted = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest: "Cancel active worker", mode: "read" }),
    idempotencyKey: `spawn-active-cancel-${label}`,
    env
  });
  updateJob(root, admitted.handle.id, (job) => ({
    ...job,
    status: "running",
    phase: "executing",
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        providerLaunchPending: false,
        providerLaunchInFlight: true,
        providerLaunchOutcome: "pending"
      }
    }
  }), env);
  return { root, env, workerId: admitted.handle.id };
}

test("active cancel ignores the obsolete signal hook and stays nonterminal", () => {
  const fixture = activeFixture("direct-0001");
  let signalCalls = 0;
  const cancelled = cancelWorker({
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    idempotencyKey: "cancel-active-direct-0001",
    env: fixture.env,
    signalProcess: () => {
      signalCalls += 1;
      return { processGroupGone: true };
    }
  });

  assert.equal(signalCalls, 0);
  assert.equal(cancelled.receipt.status, "accepted");
  assert.equal(cancelled.receipt.processGroupGoneAt, null);
  assert.equal(cancelled.receipt.terminalRecordCommittedAt, null);
  const current = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  assert.equal(current.status, "running");
  assert.equal(current.phase, "cancellation-requested");
});

test("WorkerService does not expose or forward caller process signaling authority", () => {
  const fixture = activeFixture("service-0001");
  let signalCalls = 0;
  const service = createWorkerService({
    root: fixture.root,
    principal: principal(fixture.root),
    env: fixture.env
  });
  const cancelled = service.cancel({
    id: fixture.workerId,
    idempotencyKey: "cancel-active-service-0001",
    signalProcess: () => {
      signalCalls += 1;
      return { processGroupGone: true };
    }
  });

  assert.equal(signalCalls, 0);
  assert.equal(cancelled.receipt.processGroupGoneAt, null);
  assert.equal(cancelled.receipt.terminalRecordCommittedAt, null);
  assert.equal(tryReadJob(fixture.root, fixture.workerId, fixture.env).status, "running");
});
