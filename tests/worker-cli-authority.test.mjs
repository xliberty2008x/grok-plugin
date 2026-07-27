import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  authorizeWorkerProviderRotation,
  claimWorkerDispatch,
  spawnReadOnlyWorker
} from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import { processGroupGone, processStartToken } from "../plugins/grok/scripts/lib/process-control.mjs";
import { loadProviderGuard, registerProviderGuard } from "../plugins/grok/scripts/lib/recursion-guard.mjs";
import { tryReadJob, updateJob } from "../plugins/grok/scripts/lib/state.mjs";
import { buildTaskEnvelope } from "../plugins/grok/scripts/lib/task-contract.mjs";

import { initRepo, tempDir, waitFor } from "./helpers.mjs";

const OWNER_THREAD = "019f6cb4-6d5e-7bf1-ae31-41b1519f5b01";
const FOREIGN_THREAD = "019f6cb4-6d5e-7bf1-ae31-41b1519f5b02";
const OLD_TIMESTAMP = "2026-01-01T00:00:00.000Z";
const COMPANION = fileURLToPath(new URL(
  "../plugins/grok/scripts/grok-companion.mjs",
  import.meta.url
));

function registeredIntent(processKind, attemptId, fence) {
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

function cliEnv(pluginData, threadId) {
  const env = {
    ...process.env,
    HOME: path.dirname(pluginData),
    GROK_COMPANION_PLUGIN_DATA: pluginData,
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_HOST_SESSION_ID: threadId,
    CODEX_THREAD_ID: threadId
  };
  for (const key of [
    "GROK_COMPANION_CHILD",
    "GROK_COMPANION_JOB_MARKER",
    "GROK_AGENT",
    "GROK_LEADER_SOCKET"
  ]) delete env[key];
  return env;
}

async function runCli(command, root, workerId, env) {
  const child = spawn(process.execPath, [
    COMPANION,
    command,
    workerId,
    "--json",
    "--cwd",
    root
  ], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const status = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error("CLI status timed out."));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  return { status, stdout, stderr };
}

test("CLI recovery is owner-scoped and cleans the authoritative replacement provider generation", {
  skip: process.platform === "win32",
  timeout: 25_000
}, async (t) => {
  const root = initRepo();
  const pluginData = tempDir("grok-cli-authority-data-");
  const ownerEnv = cliEnv(pluginData, OWNER_THREAD);
  const principal = { hostKind: "codex", threadId: OWNER_THREAD };
  const admitted = spawnReadOnlyWorker({
    root,
    principal,
    envelope: buildTaskEnvelope({
      userRequest: "Recover only the current replacement provider generation",
      mode: "read"
    }),
    idempotencyKey: "cli-authority-rotation-0001",
    env: ownerEnv
  });
  const workerId = admitted.handle.id;
  const claim = claimWorkerDispatch({ root, principal, workerId, env: ownerEnv });
  const deadIdentity = (pid, extra = {}) => ({
    pid,
    startToken: `gone-${pid}`,
    processGroupId: pid,
    nonce: claim.nonce,
    commandMarker: workerId,
    dispatchAttemptId: claim.attemptId,
    dispatchFence: claim.fence,
    ...extra
  });
  const controllerProcess = deadIdentity(1_940_101);
  const workerProcess = deadIdentity(1_940_102);
  const staleProvider = deadIdentity(1_940_103, {
    nonce: undefined,
    providerGeneration: 1
  });
  updateJob(root, workerId, (job) => ({
    ...job,
    status: "running",
    phase: "responding",
    controllerProcess,
    workerProcess,
    providerProcess: staleProvider,
    workerAuthorization: null,
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        controllerSpawnIntent: registeredIntent("controller", claim.attemptId, claim.fence),
        workerSpawnIntent: registeredIntent("worker", claim.attemptId, claim.fence),
        consumedLaunchContractDigest: job.workerAuthorization.launchContractDigest,
        launchContractConsumedAt: OLD_TIMESTAMP,
        providerLaunchPending: false,
        providerLaunchInFlight: false,
        providerLaunchOutcome: "launched",
        dispatch: {
          ...job.request.spawn.dispatch,
          state: "provider-started",
          fence: claim.fence,
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
  }), ownerEnv);
  assert.equal(authorizeWorkerProviderRotation({
    root,
    workerId,
    attemptId: claim.attemptId,
    workerProcess,
    env: ownerEnv
  }).providerGeneration, 2);

  const replacement = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
    workerId,
    "agent",
    "stdio"
  ], { detached: true, stdio: "ignore" });
  t.after(() => {
    try { process.kill(-replacement.pid, "SIGKILL"); } catch {}
  });
  const replacementIdentity = {
    pid: replacement.pid,
    startToken: await waitFor(() => processStartToken(replacement.pid)),
    processGroupId: replacement.pid
  };
  const rotationJob = tryReadJob(root, workerId, ownerEnv);
  registerProviderGuard(
    root,
    workerId,
    replacementIdentity,
    OWNER_THREAD,
    "provider",
    {
      controlWorkspaceId: rotationJob.controlWorkspaceId,
      executionRoot: rotationJob.request.spawn.executionRoot,
      dispatchAttemptId: claim.attemptId,
      dispatchFence: claim.fence,
      providerGeneration: 2,
      providerSpawnIntentId: rotationJob.request.spawn.providerSpawnIntent.intentId
    },
    ownerEnv
  );
  updateJob(root, workerId, (job) => ({
    ...job,
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        dispatch: { ...job.request.spawn.dispatch, updatedAt: OLD_TIMESTAMP }
      }
    }
  }), ownerEnv);

  const foreign = await runCli("status", root, workerId, cliEnv(pluginData, FOREIGN_THREAD));
  assert.notEqual(foreign.status, 0);
  assert.match(`${foreign.stdout}\n${foreign.stderr}`, /E_JOB_NOT_FOUND/);
  assert.equal(processGroupGone(replacementIdentity), false);
  let current = tryReadJob(root, workerId, ownerEnv);
  assert.equal(current.request.spawn.dispatch.nextProviderGeneration, 2);
  assert.equal(current.providerProcess.pid, staleProvider.pid);

  const owner = await runCli("status", root, workerId, ownerEnv);
  assert.equal(owner.status, 0, owner.stderr);
  current = tryReadJob(root, workerId, ownerEnv);
  assert.equal(current.status, "failed", JSON.stringify({
    cliStatus: owner.status,
    stdout: owner.stdout,
    stderr: owner.stderr,
    current
  }, null, 2));
  assert.equal(current.phase, "lost");
  assert.equal(current.request.spawn.dispatch.providerGeneration, 2);
  assert.equal(current.request.spawn.dispatch.nextProviderGeneration, null);
  assert.equal(current.providerProcess.pid, replacement.pid);
  assert.equal(current.result.taskRuntimeCleaned, true);
  assert.equal(loadProviderGuard(root, workerId), null);
  assert.equal(processGroupGone(current.providerProcess), true);
});

test("CLI cancel uses the broker mutation receipt for an unlaunched dispatch", async () => {
  const root = initRepo();
  const pluginData = tempDir("grok-cli-cancel-data-");
  const ownerEnv = cliEnv(pluginData, OWNER_THREAD);
  const admitted = spawnReadOnlyWorker({
    root,
    principal: { hostKind: "codex", threadId: OWNER_THREAD },
    envelope: buildTaskEnvelope({ userRequest: "Cancel before launch", mode: "read" }),
    idempotencyKey: "cli-authority-cancel-0001",
    env: ownerEnv
  });

  const cancelled = await runCli("cancel", root, admitted.handle.id, ownerEnv);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  const current = tryReadJob(root, admitted.handle.id, ownerEnv);
  assert.equal(current.status, "cancelled");
  assert.equal(current.result.taskRuntimeCleaned, true);
  assert.equal(current.result.cancellation.idempotencyKeyDigest.length, 64);
  assert.equal(
    current.lifecycleEvents.filter((event) => event.type === "cancellation.requested").length,
    1
  );
});
