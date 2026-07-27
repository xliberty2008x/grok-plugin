import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  launchCommittedWorker,
  terminateControllerProcess
} from "../plugins/grok/scripts/lib/worker-runtime.mjs";
import {
  cancellationNonce,
  spawnReadOnlyWorker
} from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import {
  jobFile,
  requestCancel,
  terminal,
  tryReadJob
} from "../plugins/grok/scripts/lib/state.mjs";
import {
  processGroupGone,
  processStartToken
} from "../plugins/grok/scripts/lib/process-control.mjs";
import { reconcileBrokerWorkers } from "../plugins/grok/scripts/lib/worker-recovery.mjs";
import { buildTaskEnvelope } from "../plugins/grok/scripts/lib/task-contract.mjs";

import { initRepo, tempDir, waitFor } from "./helpers.mjs";

const THREAD_ID = "019f6999-089e-76e2-a994-22abf4be17de";

function fixture(idempotencyKey) {
  const root = initRepo();
  const pluginData = tempDir("worker-runtime-teardown-data-");
  const env = {
    ...process.env,
    HOME: path.dirname(pluginData),
    GROK_COMPANION_PLUGIN_DATA: pluginData,
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_HOST_SESSION_ID: THREAD_ID,
    CODEX_THREAD_ID: THREAD_ID
  };
  const principal = { hostKind: "codex", threadId: THREAD_ID };
  const admitted = spawnReadOnlyWorker({
    root,
    principal,
    envelope: buildTaskEnvelope({
      userRequest: "Exercise exact controller teardown",
      mode: "read"
    }),
    idempotencyKey,
    env
  });
  return { root, env, principal, workerId: admitted.handle.id };
}

function waitSync(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return predicate();
}

function ignoringController(root, workerId, env) {
  const directory = tempDir("worker-runtime-ignoring-controller-");
  const readyFile = path.join(directory, "ready");
  const termSnapshotFile = path.join(directory, "term-snapshot.json");
  const script = path.join(directory, "controller.mjs");
  fs.writeFileSync(script, [
    'import fs from "node:fs";',
    `const jobFile = ${JSON.stringify(jobFile(root, workerId, env))};`,
    `const readyFile = ${JSON.stringify(readyFile)};`,
    `const termSnapshotFile = ${JSON.stringify(termSnapshotFile)};`,
    "process.on(\"SIGTERM\", () => {",
    "  const job = JSON.parse(fs.readFileSync(jobFile, \"utf8\"));",
    "  fs.writeFileSync(termSnapshotFile, JSON.stringify({",
    "    status: job.status,",
    "    phase: job.phase,",
    "    completedAt: job.completedAt,",
    "    dispatchState: job.request?.spawn?.dispatch?.state",
    "  }));",
    "});",
    "fs.writeFileSync(readyFile, \"ready\\n\");",
    "setInterval(() => {}, 1000);"
  ].join("\n"), { mode: 0o700 });
  return { script, readyFile, termSnapshotFile };
}

function killGroup(child) {
  if (!child?.pid) return;
  try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); }
  catch {}
}

test("null-token controller teardown kills a SIGTERM-ignoring group before publishing failure", { skip: process.platform === "win32" }, async (t) => {
  const { root, env, principal, workerId } = fixture("worker-runtime-null-token-teardown-0001");
  const fake = ignoringController(root, workerId, env);
  let child = null;
  t.after(() => killGroup(child));

  const launched = launchCommittedWorker({
    root,
    workerId,
    principal,
    env,
    executable: process.execPath,
    companionScript: fake.script,
    spawnProcess: (...args) => {
      child = spawn(...args);
      return child;
    },
    startToken: () => {
      assert.equal(waitSync(() => fs.existsSync(fake.readyFile)), true);
      return null;
    }
  });

  assert.equal(launched.providerLaunchState, "failed");
  assert.equal(fs.existsSync(fake.termSnapshotFile), true, "SIGTERM handler did not observe pre-terminal state");
  const atTerm = JSON.parse(fs.readFileSync(fake.termSnapshotFile, "utf8"));
  assert.equal(["completed", "failed", "cancelled"].includes(atTerm.status), false);
  assert.equal(atTerm.completedAt, null);
  assert.equal(atTerm.dispatchState, "claimed");

  const job = tryReadJob(root, workerId, env);
  assert.equal(job.status, "failed");
  assert.equal(job.request.spawn.dispatch.state, "failed");
  assert.equal(job.result.taskRuntimeCleaned, true);
  assert.deepEqual(job.result.runtimeEvidence.controllerTeardown.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(job.result.runtimeEvidence.controllerTeardown.birthTokenCaptured, false);
  assert.equal(job.result.runtimeEvidence.controllerTeardown.processGroupGone, true);
  await waitFor(() => processGroupGone({
    pid: child.pid,
    processGroupId: child.pid,
    startToken: processStartToken(child.pid) || "exited"
  }), { timeoutMs: 5_000, intervalMs: 25 });
});

test("cancel-window teardown publishes cancelled only after the exact controller group exits", { skip: process.platform === "win32" }, async (t) => {
  const { root, env, principal, workerId } = fixture("worker-runtime-cancel-teardown-0001");
  const fake = ignoringController(root, workerId, env);
  const nonce = cancellationNonce(tryReadJob(root, workerId, env));
  let child = null;
  let cancellationWritten = false;
  t.after(() => killGroup(child));

  const launched = launchCommittedWorker({
    root,
    workerId,
    principal,
    env,
    executable: process.execPath,
    companionScript: fake.script,
    spawnProcess: (...args) => {
      child = spawn(...args);
      return child;
    },
    startToken: (pid) => {
      assert.equal(waitSync(() => fs.existsSync(fake.readyFile)), true);
      if (!cancellationWritten) {
        requestCancel(root, workerId, nonce, env);
        cancellationWritten = true;
      }
      return processStartToken(pid);
    }
  });

  assert.equal(launched.providerLaunchState, "failed");
  const atTerm = JSON.parse(fs.readFileSync(fake.termSnapshotFile, "utf8"));
  assert.equal(terminal(atTerm), false);
  assert.equal(atTerm.completedAt, null);
  const job = tryReadJob(root, workerId, env);
  assert.equal(job.status, "cancelled");
  assert.equal(job.error.code, "E_CANCELLED");
  assert.equal(job.result.taskRuntimeCleaned, true);
  assert.deepEqual(job.result.runtimeEvidence.controllerTeardown.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(job.result.runtimeEvidence.controllerTeardown.birthTokenCaptured, true);
  await waitFor(() => processGroupGone(job.result.runtimeEvidence.controllerTeardown), {
    timeoutMs: 5_000,
    intervalMs: 25
  });
});

test("unproven cleanup remains nonterminal and a forged birth token is never signalled", { skip: process.platform === "win32" }, async (t) => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore"
  });
  t.after(() => killGroup(child));
  assert.equal(waitSync(() => Boolean(processStartToken(child.pid))), true);
  let signals = 0;
  const cleanup = terminateControllerProcess(child, {
    startToken: `${processStartToken(child.pid)}-forged`,
    signalProcess: () => { signals += 1; }
  });
  assert.equal(cleanup.ok, false);
  assert.equal(signals, 0);
  assert.equal(processGroupGone({
    pid: child.pid,
    processGroupId: child.pid,
    startToken: processStartToken(child.pid)
  }), false);

  const fixtureState = fixture("worker-runtime-cleanup-blocked-0001");
  const fake = ignoringController(fixtureState.root, fixtureState.workerId, fixtureState.env);
  const blockedNonce = cancellationNonce(tryReadJob(
    fixtureState.root,
    fixtureState.workerId,
    fixtureState.env
  ));
  let blockedChild = null;
  let blockedCancellationWritten = false;
  t.after(() => killGroup(blockedChild));
  const launched = launchCommittedWorker({
    ...fixtureState,
    executable: process.execPath,
    companionScript: fake.script,
    spawnProcess: (...args) => {
      blockedChild = spawn(...args);
      return blockedChild;
    },
    startToken: (pid) => {
      assert.equal(waitSync(() => fs.existsSync(fake.readyFile)), true);
      if (!blockedCancellationWritten) {
        requestCancel(
          fixtureState.root,
          fixtureState.workerId,
          blockedNonce,
          fixtureState.env
        );
        blockedCancellationWritten = true;
      }
      return processStartToken(pid);
    },
    terminateProcess: () => {
      const failure = new Error("denied");
      failure.code = "EPERM";
      throw failure;
    }
  });
  assert.equal(launched.providerLaunchState, "pending");
  const blocked = tryReadJob(fixtureState.root, fixtureState.workerId, fixtureState.env);
  assert.equal(terminal(blocked), false);
  assert.equal(blocked.status, "running");
  assert.equal(blocked.phase, "cleanup-blocked");
  assert.equal(blocked.request.spawn.dispatch.state, "claimed");
  assert.equal(blocked.request.spawn.controllerCleanupPending, true);
  assert.equal(blocked.result.taskRuntimeCleaned, false);
  assert.equal(blocked.pendingTerminal.status, "cancelled");
  assert.equal(blocked.result.runtimeEvidence.controllerTeardown.ok, false);

  killGroup(blockedChild);
  await waitFor(
    () => processGroupGone(blocked.request.spawn.controllerCleanupProcess),
    { timeoutMs: 5_000, intervalMs: 25 }
  );
  const recovery = await reconcileBrokerWorkers({
    root: fixtureState.root,
    principal: fixtureState.principal,
    dispatchStartupGraceMs: 0,
    env: fixtureState.env
  });
  assert.equal(recovery.results[0].action, "terminalized");
  const recovered = tryReadJob(fixtureState.root, fixtureState.workerId, fixtureState.env);
  assert.equal(recovered.status, "cancelled");
  assert.equal(recovered.error.code, "E_CANCELLED");
  assert.equal(recovered.request.spawn.controllerCleanupPending, false);
  assert.equal(recovered.request.spawn.controllerCleanupProcess, null);
  assert.equal(recovered.pendingTerminal, undefined);
  assert.equal(recovered.result.taskRuntimeCleaned, true);
  assert.equal(recovered.result.privacyWarning, undefined);
});
