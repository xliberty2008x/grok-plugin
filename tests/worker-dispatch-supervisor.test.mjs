import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  attachHostActionRequestToJob,
  decideHostActionRoleAdmission,
  readHostActionRequestBinding
} from "../plugins/grok/scripts/lib/worker-host-actions.mjs";
import { resolveWorkerAuthority } from "../plugins/grok/scripts/lib/worker-authority.mjs";
import {
  claimWorkerDispatch,
  prepareDispatchProcessSpawn,
  spawnGrantedFollowupWorker,
  spawnReadOnlyWorker
} from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import { createWorkerAuthorization } from "../plugins/grok/scripts/lib/worker-launch-contract.mjs";
import {
  jobFile,
  listBrokerRecoveryCandidates,
  readJob,
  requestCancel,
  updateJob
} from "../plugins/grok/scripts/lib/state.mjs";
import {
  buildTaskEnvelope,
  captureContextManifest
} from "../plugins/grok/scripts/lib/task-contract.mjs";
import {
  drainAuthorizedPendingDispatches,
  startWorkerDispatchSupervisor,
  validateRecoveryCandidate
} from "../plugins/grok/scripts/lib/worker-dispatch-supervisor.mjs";

import { initRepo, tempDir } from "./helpers.mjs";

const THREAD_ID = "019f8111-1a2b-7c3d-8e4f-1234567890ab";
const CAPABILITY_DIGEST = "a".repeat(64);
const SERVER = fileURLToPath(new URL("../plugins/grok/mcp/server.mjs", import.meta.url));
let sequence = 0;

function fixture(t, label, { pluginId = "grok@grok-companion" } = {}) {
  sequence += 1;
  const root = initRepo();
  const pluginData = tempDir(`worker-supervisor-${label}-data-`);
  const env = {
    ...process.env,
    HOME: path.dirname(pluginData),
    GROK_COMPANION_PLUGIN_DATA: pluginData,
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_HOST_SESSION_ID: THREAD_ID,
    CODEX_THREAD_ID: THREAD_ID
  };
  const principal = {
    hostKind: "codex",
    threadId: THREAD_ID,
    pluginId
  };
  const admitted = spawnReadOnlyWorker({
    root,
    principal,
    envelope: buildTaskEnvelope({
      userRequest: `Recover autonomous worker ${label}`,
      mode: "read"
    }),
    idempotencyKey: `worker-supervisor-${label}-${sequence}`,
    providerCapabilityDigest: CAPABILITY_DIGEST,
    env
  });
  const workerId = admitted.handle.id;
  updateJob(root, workerId, (current) => {
    const next = {
      ...current,
      request: {
        ...current.request,
        spawn: {
          ...current.request.spawn,
          providerCapabilityDigest: CAPABILITY_DIGEST
        }
      }
    };
    next.workerAuthorization = createWorkerAuthorization({
      job: next,
      principal,
      nonce: current.workerAuthorization.nonce,
      issuedAt: current.workerAuthorization.issuedAt
    });
    return next;
  }, env);
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
  });
  return { root, pluginData, env, principal, workerId };
}

function mutationAuthority(root) {
  return resolveWorkerAuthority({
    threadId: THREAD_ID,
    plugin_id: "grok@grok-companion",
    "x-codex-turn-metadata": {
      thread_id: THREAD_ID,
      turn_id: "019f8112-1a2b-7c3d-8e4f-1234567890ab",
      plugin_id: "grok@grok-companion"
    },
    "codex/sandbox-state-meta": {
      sandboxCwd: pathToFileURL(root).href
    }
  }, { mutation: true });
}

function pendingFollowupFixture(t, label) {
  const state = fixture(t, label);
  const attemptId = "b".repeat(32);
  const sessionId = "019f8113-1a2b-7c3d-8e4f-1234567890ab";
  const finalContext = captureContextManifest(state.root);
  updateJob(state.root, state.workerId, (current) => {
    const at = new Date().toISOString();
    const active = {
      ...current,
      status: "running",
      phase: "finalizing",
      workerAuthorization: null,
      workerProcess: {
        pid: 999_961,
        startToken: "supervisor-followup-worker",
        processGroupId: process.platform === "win32" ? null : 999_961,
        commandMarker: state.workerId,
        dispatchAttemptId: attemptId,
        dispatchFence: 1,
        nonce: current.workerAuthorization.nonce
      },
      providerProcess: {
        pid: 999_962,
        startToken: "supervisor-followup-provider",
        processGroupId: process.platform === "win32" ? null : 999_962,
        commandMarker: state.workerId,
        dispatchAttemptId: attemptId,
        dispatchFence: 1,
        providerGeneration: 1
      },
      request: {
        ...current.request,
        spawn: {
          ...current.request.spawn,
          consumedLaunchContractDigest: current.workerAuthorization.launchContractDigest,
          launchContractConsumedAt: at,
          providerLaunchPending: false,
          providerLaunchInFlight: false,
          providerLaunchOutcome: "launched",
          providerLaunchCompletedAt: at,
          dispatch: {
            ...current.request.spawn.dispatch,
            state: "provider-started",
            attemptId,
            fence: 1,
            lease: null,
            providerGeneration: 1,
            nextProviderGeneration: null,
            claimedAt: at,
            controllerStartedAt: at,
            workerStartedAt: at,
            providerStartedAt: at,
            updatedAt: at
          }
        }
      }
    };
    return {
      ...attachHostActionRequestToJob(active, {
        providerRequest: {
          schemaVersion: 1,
          kind: "role_admission",
          requestedRoleId: "reviewer"
        },
        dispatchAttemptId: attemptId,
        dispatchFence: 1,
        providerGeneration: 1,
        providerSessionId: sessionId
      }),
      grokSessionId: sessionId,
      status: "completed",
      phase: "done",
      completedAt: at,
      completionContextManifest: finalContext,
      result: {
        ...(current.result || {}),
        hostVerification: "not_run",
        taskRuntimeCleaned: true
      }
    };
  }, state.env);
  const binding = readHostActionRequestBinding(
    readJob(state.root, state.workerId, state.env)
  );
  const authority = mutationAuthority(state.root);
  const decision = decideHostActionRoleAdmission({
    root: state.root,
    principal: authority,
    workerId: state.workerId,
    requestId: binding.requestId,
    requestDigest: binding.requestDigest,
    decision: "grant",
    idempotencyKey: `supervisor-followup-decision-${label}`,
    env: state.env
  });
  const admitted = spawnGrantedFollowupWorker({
    root: state.root,
    principal: authority,
    workerId: state.workerId,
    grantId: decision.grant.grantId,
    message: "Recover this pending read-only follow-up",
    idempotencyKey: `supervisor-followup-child-${label}`,
    providerCapabilityDigest: CAPABILITY_DIGEST,
    env: state.env
  });
  return {
    ...state,
    parentWorkerId: state.workerId,
    workerId: admitted.handle.id,
    authority
  };
}

function receipt(digest = CAPABILITY_DIGEST) {
  return Object.freeze({ capabilityDigest: digest });
}

function claimOnly(log) {
  return ({ root, workerId, principal, env }) => {
    const claim = claimWorkerDispatch({ root, workerId, principal, env });
    log.push({ claimed: claim.claimed, principal, attemptId: claim.attemptId || null });
    return { claimed: claim.claimed };
  };
}

test("startup drain launches one capability-bound pending job and restart does not replay it", async (t) => {
  const state = fixture(t, "restart");
  const candidates = listBrokerRecoveryCandidates({ env: state.env });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].job.id, state.workerId);
  const calls = [];
  const options = {
    env: state.env,
    readCapability: () => receipt(),
    launchWorker: claimOnly(calls)
  };
  const first = await drainAuthorizedPendingDispatches(options);
  const restarted = await drainAuthorizedPendingDispatches(options);
  assert.equal(first.launched, 1);
  assert.equal(restarted.launched, 0);
  assert.equal(calls.filter((entry) => entry.claimed).length, 1);
  assert.deepEqual(calls[0].principal, {
    hostKind: "codex",
    threadId: THREAD_ID,
    pluginId: "grok@grok-companion"
  });
  assert.equal(readJob(state.root, state.workerId, state.env).request.spawn.dispatch.fence, 1);
});

test("startup recovery accepts and claims one valid pending grant-bound follow-up", async (t) => {
  const state = pendingFollowupFixture(t, "grant-bound");
  const candidates = listBrokerRecoveryCandidates({ env: state.env });
  const candidate = candidates.find(({ job }) => job.id === state.workerId);
  assert.ok(candidate);
  assert.equal(candidate.job.request.resumeJobId, state.parentWorkerId);
  assert.equal(candidate.job.request.spawn.ownershipMode, "exact-root-owner-grant");
  assert.doesNotThrow(() => validateRecoveryCandidate(candidate, {
    capabilityReceipt: receipt(),
    env: state.env
  }));

  const calls = [];
  const result = await drainAuthorizedPendingDispatches({
    env: state.env,
    readCapability: () => receipt(),
    launchWorker: claimOnly(calls)
  });
  assert.equal(result.launched, 1);
  assert.equal(calls.filter((entry) => entry.claimed).length, 1);
  assert.equal(
    readJob(state.root, state.workerId, state.env).request.spawn.dispatch.state,
    "claimed"
  );
});

test("startup drain revalidates capability immediately before launch", async (t) => {
  const state = fixture(t, "capability-revalidation");
  let reads = 0;
  let launches = 0;
  const result = await drainAuthorizedPendingDispatches({
    env: state.env,
    readCapability: () => {
      reads += 1;
      return reads === 1 ? receipt() : null;
    },
    launchWorker: async () => {
      launches += 1;
      return { claimed: true };
    }
  });
  assert.equal(reads, 2);
  assert.equal(launches, 0);
  assert.deepEqual(result, {
    scanned: 1,
    launched: 0,
    reconcileOnly: 0,
    capabilityAvailable: false
  });
  const job = readJob(state.root, state.workerId, state.env);
  assert.equal(job.request.spawn.dispatch.state, "pending");
  assert.equal(job.request.spawn.dispatch.fence, 0);
});

test("two concurrent drains still publish exactly one dispatch claim", async (t) => {
  const state = fixture(t, "concurrent");
  let arrivals = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const claims = [];
  const launchWorker = async (args) => {
    arrivals += 1;
    if (arrivals === 2) release();
    await barrier;
    return claimOnly(claims)(args);
  };
  const options = {
    env: state.env,
    readCapability: () => receipt(),
    launchWorker
  };
  const results = await Promise.all([
    drainAuthorizedPendingDispatches(options),
    drainAuthorizedPendingDispatches(options)
  ]);
  assert.equal(results.reduce((sum, result) => sum + result.launched, 0), 1);
  assert.equal(claims.filter((entry) => entry.claimed).length, 1);
  assert.equal(readJob(state.root, state.workerId, state.env).request.spawn.dispatch.fence, 1);
});

test("an expired claim with no intent or process is reclaimed once", async (t) => {
  const state = fixture(t, "expired");
  const first = claimWorkerDispatch({
    root: state.root,
    workerId: state.workerId,
    principal: state.principal,
    leaseMs: 1,
    env: state.env
  });
  assert.equal(first.claimed, true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const calls = [];
  const result = await drainAuthorizedPendingDispatches({
    env: state.env,
    readCapability: () => receipt(),
    launchWorker: claimOnly(calls)
  });
  assert.equal(result.launched, 1);
  const job = readJob(state.root, state.workerId, state.env);
  assert.equal(job.request.spawn.dispatch.fence, 2);
  assert.notEqual(job.request.spawn.dispatch.attemptId, first.attemptId);
});

test("intent, process, cancellation, and terminal evidence are never replayed", async (t) => {
  const intentState = fixture(t, "intent");
  const claim = claimWorkerDispatch({
    root: intentState.root,
    workerId: intentState.workerId,
    principal: intentState.principal,
    leaseMs: 1,
    env: intentState.env
  });
  prepareDispatchProcessSpawn({
    root: intentState.root,
    workerId: intentState.workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    processKind: "controller",
    nonce: claim.nonce,
    env: intentState.env
  });
  await new Promise((resolve) => setTimeout(resolve, 5));

  const processState = fixture(t, "process");
  updateJob(processState.root, processState.workerId, (job) => ({
    ...job,
    controllerProcess: {
      pid: 99_999_991,
      startToken: "ambiguous-controller",
      processGroupId: 99_999_991
    }
  }), processState.env);

  const cancelledState = fixture(t, "cancelled");
  const cancelled = readJob(cancelledState.root, cancelledState.workerId, cancelledState.env);
  requestCancel(
    cancelledState.root,
    cancelledState.workerId,
    cancelled.workerAuthorization.nonce,
    cancelledState.env
  );

  const terminalState = fixture(t, "terminal");
  updateJob(terminalState.root, terminalState.workerId, (job) => ({
    ...job,
    status: "cancelled",
    phase: "cancelled",
    completedAt: new Date().toISOString()
  }), terminalState.env);

  for (const state of [intentState, processState, cancelledState, terminalState]) {
    const calls = [];
    const result = await drainAuthorizedPendingDispatches({
      env: state.env,
      readCapability: () => receipt(),
      launchWorker: claimOnly(calls)
    });
    assert.equal(result.launched, 0);
    assert.equal(calls.length, 0);
  }
});

test("foreign, legacy, write, wrong-state, null-plugin, malformed, and capability-drift candidates fail closed", (t) => {
  const state = fixture(t, "negative");
  const candidate = listBrokerRecoveryCandidates({ env: state.env })[0];
  const variants = [
    { ...candidate, job: { ...candidate.job, write: true } },
    { ...candidate, job: { ...candidate.job, host: { ...candidate.job.host, kind: "claude-code" } } },
    {
      ...candidate,
      job: {
        ...candidate.job,
        request: {
          ...candidate.job.request,
          spawn: {
            ...candidate.job.request.spawn,
            dispatch: { ...candidate.job.request.spawn.dispatch, schemaVersion: 1 }
          }
        }
      }
    },
    { ...candidate, stateSegment: "control-ffffffffffffffff" },
    { ...candidate, job: { ...candidate.job, workerAuthorization: { ...candidate.job.workerAuthorization, owner: { ...candidate.job.workerAuthorization.owner, pluginId: null } } } },
    { ...candidate, job: { ...candidate.job, request: { ...candidate.job.request, providerPromptDigest: "bad" } } }
  ];
  for (const variant of variants) {
    assert.throws(
      () => validateRecoveryCandidate(variant, {
        capabilityReceipt: receipt(),
        env: state.env
      })
    );
  }
  assert.throws(
    () => validateRecoveryCandidate(candidate, {
      capabilityReceipt: receipt("b".repeat(64)),
      env: state.env
    }),
    (error) => error?.code === "E_CAPABILITY"
  );
});

test("canonical durable spawn binding rejects a re-authorized request-digest mismatch", (t) => {
  const state = fixture(t, "durable-binding");
  const candidate = listBrokerRecoveryCandidates({ env: state.env })[0];
  const malformedJob = {
    ...candidate.job,
    request: {
      ...candidate.job.request,
      spawn: {
        ...candidate.job.request.spawn,
        requestDigest: "b".repeat(64)
      }
    }
  };
  malformedJob.workerAuthorization = createWorkerAuthorization({
    job: malformedJob,
    principal: state.principal,
    nonce: candidate.job.workerAuthorization.nonce,
    issuedAt: candidate.job.workerAuthorization.issuedAt
  });
  assert.throws(
    () => validateRecoveryCandidate({ ...candidate, job: malformedJob }, {
      capabilityReceipt: receipt(),
      env: state.env
    }),
    (error) => error?.code === "E_STATE"
      && /Durable worker spawn request no longer matches/.test(error.message)
  );
});

test("state discovery rejects symlink, unsafe-mode, oversized, and over-budget entries", (t) => {
  const state = fixture(t, "scan-safety");
  const file = jobFile(state.root, state.workerId, state.env);
  const backup = `${file}.backup`;
  fs.renameSync(file, backup);
  fs.symlinkSync(backup, file);
  assert.equal(listBrokerRecoveryCandidates({ env: state.env }).length, 0);
  fs.unlinkSync(file);
  fs.renameSync(backup, file);

  fs.chmodSync(file, 0o644);
  assert.equal(listBrokerRecoveryCandidates({ env: state.env }).length, 0);
  fs.chmodSync(file, 0o600);

  assert.equal(listBrokerRecoveryCandidates({
    env: state.env,
    limits: { maxJobBytes: 100 }
  }).length, 0);

  const malformed = path.join(path.dirname(file), `task-${"f".repeat(16)}.json`);
  fs.writeFileSync(malformed, `{${"x".repeat(64)}`, { mode: 0o600 });
  assert.throws(
    () => listBrokerRecoveryCandidates({
      env: state.env,
      limits: { maxTotalJobBytes: fs.statSync(file).size + 10 }
    }),
    (error) => error?.code === "E_STATE"
  );
  fs.unlinkSync(malformed);

  const stateParent = path.join(state.pluginData, "state");
  fs.mkdirSync(path.join(stateParent, "control-ffffffffffffffff"), { mode: 0o700 });
  assert.throws(
    () => listBrokerRecoveryCandidates({
      env: state.env,
      limits: { maxStateEntries: 1 }
    }),
    (error) => error?.code === "E_STATE"
  );
});

test("bounded supervisor retries without overlap, stops, and server EOF emits no stdout", async (t) => {
  let runs = 0;
  let active = 0;
  let maximumActive = 0;
  const supervisor = startWorkerDispatchSupervisor({
    drain: async () => {
      runs += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 3));
      active -= 1;
    },
    retryDelayMs: 2,
    maxRuns: 3
  });
  await supervisor.done;
  assert.equal(runs, 3);
  assert.equal(maximumActive, 1);

  let stoppedRuns = 0;
  let releaseDrain;
  let announceDrain;
  const drainStarted = new Promise((resolve) => { announceDrain = resolve; });
  const drainReleased = new Promise((resolve) => { releaseDrain = resolve; });
  const stoppedSupervisor = startWorkerDispatchSupervisor({
    drain: async () => {
      stoppedRuns += 1;
      announceDrain();
      await drainReleased;
    },
    retryDelayMs: 2,
    maxRuns: 3
  });
  await drainStarted;
  stoppedSupervisor.stop();
  releaseDrain();
  await stoppedSupervisor.done;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(stoppedRuns, 1);

  const pluginData = tempDir("worker-supervisor-server-data-");
  t.after(() => fs.rmSync(pluginData, { recursive: true, force: true }));
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      HOME: path.dirname(pluginData),
      GROK_COMPANION_PLUGIN_DATA: pluginData
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.end();
  const outcome = await exited;
  assert.equal(outcome.code, 0, stderr);
  assert.equal(stdout, "");

  const signalled = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      HOME: path.dirname(pluginData),
      GROK_COMPANION_PLUGIN_DATA: pluginData
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let signalledStdout = "";
  let signalledStderr = "";
  let protocolReady;
  const ready = new Promise((resolve) => { protocolReady = resolve; });
  signalled.stdout.on("data", (chunk) => {
    signalledStdout += String(chunk);
    if (signalledStdout.includes("\n")) protocolReady();
  });
  signalled.stderr.on("data", (chunk) => { signalledStderr += String(chunk); });
  const signalledExit = new Promise((resolve, reject) => {
    signalled.once("error", reject);
    signalled.once("exit", (code, signal) => resolve({ code, signal }));
  });
  signalled.stdin.write("{\n");
  await ready;
  signalled.kill("SIGTERM");
  const signalledOutcome = await signalledExit;
  assert.deepEqual(signalledOutcome, { code: 0, signal: null }, signalledStderr);
  assert.deepEqual(JSON.parse(signalledStdout.trim()), {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: "Parse error." }
  });
});
