import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  assertDispatchContract,
  cancelWorker,
  claimWorkerDispatch,
  prepareDispatchProcessSpawn,
  recordUnsettledWorkerProcess,
  spawnReadOnlyWorker,
  transitionWorkerDispatch
} from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import { reconcileBrokerWorkers } from "../plugins/grok/scripts/lib/worker-recovery.mjs";
import {
  WORKER_AUTHORIZATION_SCHEMA_VERSION,
  WORKER_DISPATCH_OUTBOX_SCHEMA_VERSION,
  assertWorkerAuthorization,
  launchContractDigest
} from "../plugins/grok/scripts/lib/worker-launch-contract.mjs";
import { launchCommittedWorker } from "../plugins/grok/scripts/lib/worker-runtime.mjs";
import { createWorkerService } from "../plugins/grok/scripts/lib/worker-service.mjs";
import { processStartToken } from "../plugins/grok/scripts/lib/process-control.mjs";
import {
  registerProviderGuard,
  unregisterProviderGuard
} from "../plugins/grok/scripts/lib/recursion-guard.mjs";
import {
  buildTaskEnvelope,
  captureContextManifest,
  composeProviderPrompt,
  scrubStoredJob
} from "../plugins/grok/scripts/lib/task-contract.mjs";
import { tryReadJob, updateJob } from "../plugins/grok/scripts/lib/state.mjs";
import { resolveControlWorkspace } from "../plugins/grok/scripts/lib/workspace.mjs";

import { installFakeGrok, readFakeLog } from "./fake-grok.mjs";
import { git, initRepo, runCompanion, tempDir, testEnvironment } from "./helpers.mjs";

const THREAD_ID = "019f6a2f-8e34-7db1-a101-b9ca29e5fe01";

function taskReport() {
  return `GROK_WORKER_REPORT: ${JSON.stringify({
    outcome: "complete",
    summary: "Shared Codex task launcher completed",
    changedFiles: [],
    checksClaimed: [],
    acceptanceResults: ["AC-01", "AC-02"].map((id) => ({ id, status: "met" })),
    risks: [],
    questions: []
  })}`;
}

function fixture(idempotencyKey) {
  const root = initRepo();
  const pluginData = tempDir("worker-launch-outbox-data-");
  const env = {
    ...process.env,
    GROK_COMPANION_PLUGIN_DATA: pluginData,
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_HOST_SESSION_ID: THREAD_ID,
    CODEX_THREAD_ID: THREAD_ID
  };
  const principal = {
    hostKind: "codex",
    threadId: THREAD_ID,
    pluginId: "grok@grok-companion"
  };
  const admitted = spawnReadOnlyWorker({
    root,
    principal,
    envelope: buildTaskEnvelope({
      userRequest: "Prove authority-bound durable launch",
      mode: "read"
    }),
    idempotencyKey,
    env
  });
  return { root, env, principal, workerId: admitted.handle.id };
}

function addLinkedWorktree(primaryRoot, name) {
  const linked = path.join(path.dirname(primaryRoot), `${path.basename(primaryRoot)}-${name}`);
  git(primaryRoot, "worktree", "add", "--detach", linked, git(primaryRoot, "rev-parse", "HEAD"));
  return fs.realpathSync(linked);
}

function differentSha(value) {
  return `${value?.startsWith("0") ? "1" : "0"}${String(value || "").slice(1).padEnd(63, "0")}`;
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalize(value[key])])
  );
}

function stableDigest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function stableEnvelopeDigestBinding(envelope) {
  const userRequestDigest = crypto
    .createHash("sha256")
    .update(envelope.userRequest)
    .digest("hex");
  const stable = {};
  for (const [key, value] of Object.entries(envelope)) {
    if (key === "userRequest" || key === "userRequestDigest" || value === undefined) continue;
    stable[key] = key === "objective" && value === envelope.userRequest
      ? userRequestDigest
      : value;
  }
  stable.userRequestDigest = userRequestDigest;
  return stable;
}

function legacySpawnRequestDigest(job) {
  return stableDigest({
    owner: {
      hostKind: job.host?.kind || "codex",
      sessionId: job.host?.sessionId || null
    },
    controlWorkspaceId: job.controlWorkspaceId,
    executionRoot: job.request.spawn.executionRoot,
    envelope: stableEnvelopeDigestBinding(job.request.envelope),
    contextManifestDigest: job.request.contextManifest?.digest || null,
    roleId: job.request.roleId,
    write: Boolean(job.write)
  });
}

function dispatchIdentity(state, claim, extra = {}) {
  return {
    pid: process.pid,
    startToken: processStartToken(process.pid),
    processGroupId: process.platform === "win32" ? null : process.pid,
    nonce: claim.nonce,
    commandMarker: state.workerId,
    dispatchAttemptId: claim.attemptId,
    dispatchFence: claim.fence,
    ...extra
  };
}

function advanceToWorkerStarted(state) {
  const claim = claimWorkerDispatch({ ...state, holderId: "host:consumption-test" });
  const controllerIntent = prepareDispatchProcessSpawn({
    root: state.root,
    workerId: state.workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    processKind: "controller",
    nonce: claim.nonce,
    env: state.env
  }).intent;
  transitionWorkerDispatch({
    root: state.root,
    workerId: state.workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    state: "controller-started",
    controllerProcess: dispatchIdentity(state, claim),
    spawnIntentId: controllerIntent.intentId,
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
  }).intent;
  transitionWorkerDispatch({
    root: state.root,
    workerId: state.workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    state: "worker-started",
    workerProcess: dispatchIdentity(state, claim),
    spawnIntentId: workerIntent.intentId,
    env: state.env
  });
  return claim;
}

function consumeLaunchAuthorization(state) {
  advanceToWorkerStarted(state);
  updateJob(state.root, state.workerId, (job) => {
    const consumedLaunchContractDigest = job.workerAuthorization.launchContractDigest;
    return {
      ...job,
      workerAuthorization: null,
      request: {
        ...job.request,
        spawn: {
          ...job.request.spawn,
          consumedLaunchContractDigest,
          launchContractConsumedAt: new Date().toISOString()
        }
      }
    };
  }, state.env);
  const consumed = tryReadJob(state.root, state.workerId, state.env);
  assert.doesNotThrow(() => assertDispatchContract(consumed));
  return consumed;
}

function downgradePendingDispatchToV1(state, mutate = (job) => job) {
  return updateJob(state.root, state.workerId, (job) => {
    const legacy = structuredClone(job);
    delete legacy.request.contextBindingMode;
    delete legacy.request.contextPacket;
    delete legacy.request.runtimeRolePolicy;
    delete legacy.request.contextReceipt;
    delete legacy.request.providerHomeId;
    delete legacy.request.spawn.contextBindingDigest;
    delete legacy.profile.providerToolIds;
    delete legacy.profile.deniedProviderToolIds;
    legacy.request.providerPromptDigest = crypto
      .createHash("sha256")
      .update(composeProviderPrompt(legacy.request.envelope, {
        root: legacy.request.spawn.executionRoot,
        contextManifest: legacy.request.contextManifest
      }))
      .digest("hex");
    legacy.request.spawn.requestDigest = legacySpawnRequestDigest(legacy);
    legacy.workerAuthorization = {
      schemaVersion: 1,
      nonce: job.workerAuthorization.nonce,
      ownerThreadId: THREAD_ID,
      purpose: "launch-worker",
      issuedAt: job.createdAt
    };
    legacy.request.spawn.dispatch = {
      schemaVersion: 1,
      state: "pending",
      attemptId: null,
      providerGeneration: 0,
      nextProviderGeneration: null,
      claimedAt: null,
      createdAt: job.request.spawn.dispatch.createdAt,
      updatedAt: job.request.spawn.dispatch.updatedAt
    };
    return mutate(legacy);
  }, state.env);
}

test("new broker admissions bind WorkerAuthorization v2 to dispatch-v2", () => {
  const state = fixture("launch-contract-v2-0001");
  const job = tryReadJob(state.root, state.workerId, state.env);
  const authorization = assertWorkerAuthorization(job, { allowLegacy: false });
  assert.equal(authorization.schemaVersion, WORKER_AUTHORIZATION_SCHEMA_VERSION);
  assert.equal(authorization.workerId, state.workerId);
  assert.equal(authorization.owner.sessionId, THREAD_ID);
  assert.equal(authorization.requestDigest, job.request.spawn.requestDigest);
  assert.equal(authorization.dispatchAttemptId, null);
  assert.equal(authorization.dispatchFence, null);
  assert.equal(job.request.spawn.dispatch.schemaVersion, WORKER_DISPATCH_OUTBOX_SCHEMA_VERSION);
  assert.equal(job.request.spawn.dispatch.state, "pending");
  assert.equal(job.request.spawn.dispatch.fence, 0);
  assert.equal(job.request.spawn.dispatch.lease, null);
});

test("the Codex CLI task entrypoint uses the shared versioned launcher", {
  skip: process.platform === "win32"
}, () => {
  const root = initRepo();
  const pluginData = tempDir("worker-launch-cli-data-");
  const fake = installFakeGrok(tempDir("worker-launch-cli-provider-"), { taskText: taskReport() });
  const env = {
    ...testEnvironment({ fake, pluginData }),
    GROK_COMPANION_PLUGIN_DATA: pluginData,
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_HOST_SESSION_ID: THREAD_ID,
    CODEX_THREAD_ID: THREAD_ID
  };
  const run = runCompanion(["task", "--wait", "prove shared launcher", "--json"], {
    cwd: root,
    env,
    timeout: 20_000
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout);
  const job = tryReadJob(root, result.id, env);
  assert.equal(job.status, "completed");
  assert.equal(job.request.spawn.dispatch.schemaVersion, 2);
  assert.equal(job.request.spawn.dispatch.fence, 1);
  assert.equal(job.role.id, "explorer");
  assert.equal(readFakeLog(fake.logFile).filter((entry) => entry.event === "prompt").length, 1);
});

test("authorization validation fails closed after immutable launch-contract drift", () => {
  const state = fixture("launch-contract-drift-0001");
  updateJob(state.root, state.workerId, (job) => ({
    ...job,
    request: {
      ...job.request,
      envelope: { ...job.request.envelope, objective: "tampered objective" }
    }
  }), state.env);
  assert.throws(
    () => assertWorkerAuthorization(tryReadJob(state.root, state.workerId, state.env), { allowLegacy: false }),
    (error) => error?.code === "E_AUTH_REQUIRED"
  );
});

test("provider-prompt authorization uses the canonical execution root across path aliases", () => {
  const canonicalRoot = initRepo();
  const aliasParent = tempDir("worker-launch-root-alias-");
  const aliasRoot = path.join(aliasParent, "repo-alias");
  fs.symlinkSync(canonicalRoot, aliasRoot, "dir");
  const pluginData = tempDir("worker-launch-root-alias-data-");
  const env = {
    ...process.env,
    GROK_COMPANION_PLUGIN_DATA: pluginData,
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_HOST_SESSION_ID: THREAD_ID,
    CODEX_THREAD_ID: THREAD_ID
  };
  const principal = {
    hostKind: "codex",
    threadId: THREAD_ID,
    pluginId: "grok@grok-companion"
  };
  const envelope = buildTaskEnvelope({
    userRequest: "Bind a canonical repository root",
    mode: "read"
  });
  const admitted = spawnReadOnlyWorker({
    root: aliasRoot,
    principal,
    envelope,
    idempotencyKey: "launch-contract-canonical-root-0001",
    env
  });
  const job = tryReadJob(aliasRoot, admitted.handle.id, env);
  const executionRoot = resolveControlWorkspace(aliasRoot, env).executionRoot;
  const expectedDigest = crypto
    .createHash("sha256")
    .update(composeProviderPrompt(job.request.envelope, {
      root: executionRoot,
      contextManifest: job.request.contextManifest,
      contextPacket: job.request.contextPacket,
      runtimeRolePolicy: job.request.runtimeRolePolicy
    }))
    .digest("hex");
  const aliasDigest = crypto
    .createHash("sha256")
    .update(composeProviderPrompt(job.request.envelope, {
      root: aliasRoot,
      contextManifest: job.request.contextManifest,
      contextPacket: job.request.contextPacket,
      runtimeRolePolicy: job.request.runtimeRolePolicy
    }))
    .digest("hex");
  assert.equal(job.request.providerPromptDigest, expectedDigest);
  assert.notEqual(aliasDigest, expectedDigest);
  assertWorkerAuthorization(job, { allowLegacy: false });

  const replay = spawnReadOnlyWorker({
    root: canonicalRoot,
    principal,
    envelope,
    idempotencyKey: "launch-contract-canonical-root-0001",
    env
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.handle.id, admitted.handle.id);
});

test("launch request privacy digest is stable across scrubbing and rejects mismatches", () => {
  const stable = fixture("launch-request-privacy-stable-0001");
  updateJob(stable.root, stable.workerId, (job) => scrubStoredJob(job), stable.env);
  assertWorkerAuthorization(tryReadJob(stable.root, stable.workerId, stable.env), { allowLegacy: false });

  for (const [label, mutateEnvelope] of [
    ["raw-mismatch", (envelope) => ({ ...envelope, userRequestDigest: "f".repeat(64) })],
    ["scrubbed-missing", (envelope) => ({ ...envelope, userRequest: null, userRequestDigest: null })],
    ["scrubbed-malformed", (envelope) => ({ ...envelope, userRequest: null, userRequestDigest: "invalid" })]
  ]) {
    const state = fixture(`launch-request-privacy-${label}-0001`);
    updateJob(state.root, state.workerId, (job) => ({
      ...job,
      request: {
        ...job.request,
        envelope: mutateEnvelope(job.request.envelope)
      }
    }), state.env);
    assert.throws(
      () => assertWorkerAuthorization(tryReadJob(state.root, state.workerId, state.env), { allowLegacy: false }),
      (error) => error?.code === "E_AUTH_REQUIRED"
    );
  }
});

test("post-claim executable-input drift fails before controller registration or provider launch", () => {
  const driftCases = [
    ["envelope", (job) => ({
      ...job,
      request: {
        ...job.request,
        envelope: { ...job.request.envelope, objective: "tampered after claim" }
      }
    })],
    ["prompt", (job) => ({
      ...job,
      request: { ...job.request, prompt: "tampered provider prompt" }
    })],
    ["model", (job) => ({ ...job, model: "tampered-model" })],
    ["effort", (job) => ({ ...job, effort: "tampered-effort" })]
  ];

  for (const [label, mutate] of driftCases) {
    const state = fixture(`launch-contract-toctou-${label}-0001`);
    let controllerSpawnCalls = 0;
    const launched = launchCommittedWorker({
      ...state,
      spawnProcess() {
        controllerSpawnCalls += 1;
        updateJob(state.root, state.workerId, mutate, state.env);
        return { pid: 1_800_000 + controllerSpawnCalls, once() {}, unref() {} };
      },
      startToken: () => `fixture-token-${label}`
    });
    const job = tryReadJob(state.root, state.workerId, state.env);
    assert.equal(controllerSpawnCalls, 1);
    assert.equal(launched.providerLaunched, false);
    assert.equal(job.status, "failed");
    assert.equal(job.request.spawn.dispatch.state, "failed");
    assert.equal(job.controllerProcess, undefined);
    assert.equal(job.workerProcess, undefined);
    assert.equal(job.providerProcess, undefined);
    assert.equal(job.result.taskRuntimeCleaned, true);
  }
});

test("post-consumption launch-contract drift is rejected without mutating durable state", () => {
  const driftCases = [
    ["prompt", (job) => ({
      ...job,
      request: { ...job.request, prompt: "tampered consumed provider prompt" }
    })],
    ["provider-prompt-digest", (job) => ({
      ...job,
      request: { ...job.request, providerPromptDigest: "f".repeat(64) }
    })],
    ["envelope", (job) => ({
      ...job,
      request: {
        ...job.request,
        envelope: { ...job.request.envelope, objective: "tampered after consumption" }
      }
    })],
    ["model", (job) => ({ ...job, model: "tampered-consumed-model" })],
    ["effort", (job) => ({ ...job, effort: "tampered-consumed-effort" })]
  ];

  for (const [label, mutate] of driftCases) {
    const state = fixture(`launch-contract-consumed-drift-${label}-0001`);
    consumeLaunchAuthorization(state);
    updateJob(state.root, state.workerId, mutate, state.env);
    const drifted = tryReadJob(state.root, state.workerId, state.env);
    const beforeValidation = structuredClone(drifted);
    assert.throws(
      () => assertDispatchContract(drifted),
      (error) => error?.code === "E_AUTH_REQUIRED",
      `${label} drift must invalidate the consumed launch contract`
    );
    assert.deepEqual(drifted, beforeValidation, `${label} validation mutated its input`);
    assert.deepEqual(
      tryReadJob(state.root, state.workerId, state.env),
      beforeValidation,
      `${label} validation mutated durable state`
    );
  }
});

test("dispatch-v2 rejects a mixed live authorization and consumption receipt", () => {
  const state = fixture("launch-contract-mixed-auth-consumption-0001");
  advanceToWorkerStarted(state);
  updateJob(state.root, state.workerId, (job) => ({
    ...job,
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        consumedLaunchContractDigest: job.workerAuthorization.launchContractDigest,
        launchContractConsumedAt: new Date().toISOString()
      }
    }
  }), state.env);
  const mixed = tryReadJob(state.root, state.workerId, state.env);
  const beforeValidation = structuredClone(mixed);
  assert.throws(
    () => assertDispatchContract(mixed),
    (error) => error?.code === "E_AUTH_REQUIRED"
  );
  assert.deepEqual(mixed, beforeValidation);
  assert.deepEqual(tryReadJob(state.root, state.workerId, state.env), beforeValidation);
});

test("failed dispatch transitions require cleanup proof and reject malformed dispatch-v2", () => {
  for (const [label, runtimeCleanup] of [
    ["missing", undefined],
    ["false", { ok: false, warning: "injected incomplete cleanup" }]
  ]) {
    const state = fixture(`launch-failed-cleanup-${label}-0001`);
    const claim = claimWorkerDispatch({ ...state, holderId: `host:failed-${label}` });
    const before = tryReadJob(state.root, state.workerId, state.env);
    assert.throws(
      () => transitionWorkerDispatch({
        root: state.root,
        workerId: state.workerId,
        attemptId: claim.attemptId,
        fence: claim.fence,
        state: "failed",
        error: { code: "E_WORKER_LOST", message: "Injected launch failure" },
        runtimeCleanup,
        env: state.env
      }),
      (error) => error?.code === "E_RUNTIME_CLEANUP"
    );
    assert.deepEqual(tryReadJob(state.root, state.workerId, state.env), before);
  }

  const malformed = fixture("launch-failed-malformed-dispatch-0001");
  const malformedClaim = claimWorkerDispatch({ ...malformed, holderId: "host:failed-malformed" });
  updateJob(malformed.root, malformed.workerId, (job) => ({
    ...job,
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        dispatch: { ...job.request.spawn.dispatch, unexpectedLifecycleAuthority: true }
      }
    }
  }), malformed.env);
  const malformedBefore = tryReadJob(malformed.root, malformed.workerId, malformed.env);
  assert.throws(
    () => transitionWorkerDispatch({
      root: malformed.root,
      workerId: malformed.workerId,
      attemptId: malformedClaim.attemptId,
      fence: malformedClaim.fence,
      state: "failed",
      error: { code: "E_WORKER_LOST", message: "Injected launch failure" },
      runtimeCleanup: { ok: true },
      env: malformed.env
    }),
    (error) => error?.code === "E_STATE"
  );
  assert.deepEqual(tryReadJob(malformed.root, malformed.workerId, malformed.env), malformedBefore);

  const valid = fixture("launch-failed-cleanup-valid-0001");
  const validClaim = claimWorkerDispatch({ ...valid, holderId: "host:failed-valid" });
  const failed = transitionWorkerDispatch({
    root: valid.root,
    workerId: valid.workerId,
    attemptId: validClaim.attemptId,
    fence: validClaim.fence,
    state: "failed",
    error: { code: "E_WORKER_LOST", message: "Injected launch failure" },
    runtimeCleanup: { ok: true },
    env: valid.env
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.request.spawn.dispatch.state, "failed");
  assert.equal(failed.request.spawn.dispatch.lease, null);
  assert.equal(failed.result.taskRuntimeCleaned, true);
});

test("failed dispatch accepts no consumption receipt but rejects partial or malformed receipt pairs", () => {
  const valid = fixture("launch-failed-consumption-absent-0001");
  const validClaim = claimWorkerDispatch({ ...valid, holderId: "host:failed-consumption-absent" });
  const validFailed = transitionWorkerDispatch({
    root: valid.root,
    workerId: valid.workerId,
    attemptId: validClaim.attemptId,
    fence: validClaim.fence,
    state: "failed",
    error: { code: "E_WORKER_LOST", message: "Injected pre-launch failure" },
    runtimeCleanup: { ok: true },
    env: valid.env
  });
  assert.equal(validFailed.workerAuthorization, null);
  assert.equal(Object.hasOwn(validFailed.request.spawn, "consumedLaunchContractDigest"), false);
  assert.equal(Object.hasOwn(validFailed.request.spawn, "launchContractConsumedAt"), false);
  assert.doesNotThrow(() => assertDispatchContract(validFailed));
  const invalidFailedLifecycle = structuredClone(validFailed);
  invalidFailedLifecycle.request.spawn.dispatch.failedAt = null;
  assert.throws(
    () => assertDispatchContract(invalidFailedLifecycle),
    (error) => error?.code === "E_STATE",
    "absent consumption evidence bypassed malformed failed lifecycle validation"
  );

  const malformedCases = [
    {
      label: "digest-only",
      fields: ({ expectedDigest }) => ({ consumedLaunchContractDigest: expectedDigest })
    },
    {
      label: "timestamp-only",
      fields: () => ({ launchContractConsumedAt: new Date().toISOString() })
    },
    {
      label: "malformed-digest",
      fields: () => ({
        consumedLaunchContractDigest: "not-a-sha256",
        launchContractConsumedAt: new Date().toISOString()
      })
    },
    {
      label: "malformed-timestamp",
      fields: ({ expectedDigest }) => ({
        consumedLaunchContractDigest: expectedDigest,
        launchContractConsumedAt: "not-an-iso-timestamp"
      })
    },
    {
      label: "mismatched-digest",
      fields: ({ expectedDigest }) => ({
        consumedLaunchContractDigest: differentSha(expectedDigest),
        launchContractConsumedAt: new Date().toISOString()
      })
    }
  ];

  for (const { label, fields } of malformedCases) {
    const state = fixture(`launch-failed-consumption-${label}-0001`);
    const admitted = tryReadJob(state.root, state.workerId, state.env);
    const expectedDigest = launchContractDigest(admitted);
    const claim = claimWorkerDispatch({ ...state, holderId: `host:failed-consumption-${label}` });
    transitionWorkerDispatch({
      root: state.root,
      workerId: state.workerId,
      attemptId: claim.attemptId,
      fence: claim.fence,
      state: "failed",
      error: { code: "E_WORKER_LOST", message: "Injected pre-launch failure" },
      runtimeCleanup: { ok: true },
      env: state.env
    });
    updateJob(state.root, state.workerId, (job) => ({
      ...job,
      request: {
        ...job.request,
        spawn: {
          ...job.request.spawn,
          ...fields({ expectedDigest })
        }
      }
    }), state.env);
    const malformed = tryReadJob(state.root, state.workerId, state.env);
    const beforeValidation = structuredClone(malformed);
    assert.throws(
      () => assertDispatchContract(malformed),
      (error) => error?.code === "E_AUTH_REQUIRED",
      `${label} consumption evidence unexpectedly validated`
    );
    assert.deepEqual(malformed, beforeValidation, `${label} validation mutated its input`);
    assert.deepEqual(
      tryReadJob(state.root, state.workerId, state.env),
      beforeValidation,
      `${label} validation mutated durable state`
    );
  }
});

test("dispatch lifecycle rejects impossible intent and state pairings", () => {
  const intent = (processKind, dispatch, status) => ({
    schemaVersion: 1,
    processKind,
    intentId: (processKind === "controller" ? "c" : "d").repeat(32),
    attemptId: dispatch.attemptId,
    fence: dispatch.fence,
    status,
    preparedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    registeredAt: status === "registered" ? new Date().toISOString() : null,
    noChildAt: null
  });

  const pending = fixture("launch-impossible-pending-intent-0001");
  updateJob(pending.root, pending.workerId, (job) => ({
    ...job,
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        controllerSpawnIntent: intent("controller", job.request.spawn.dispatch, "pending")
      }
    }
  }), pending.env);
  assert.throws(
    () => assertDispatchContract(tryReadJob(pending.root, pending.workerId, pending.env)),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );

  const claimedController = fixture("launch-impossible-claimed-controller-0001");
  claimWorkerDispatch({ ...claimedController, holderId: "host:impossible-controller" });
  updateJob(claimedController.root, claimedController.workerId, (job) => ({
    ...job,
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        controllerSpawnIntent: intent("controller", job.request.spawn.dispatch, "registered")
      }
    }
  }), claimedController.env);
  assert.throws(
    () => assertDispatchContract(tryReadJob(
      claimedController.root,
      claimedController.workerId,
      claimedController.env
    )),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );

  const claimedWorker = fixture("launch-impossible-claimed-worker-0001");
  claimWorkerDispatch({ ...claimedWorker, holderId: "host:impossible-worker" });
  updateJob(claimedWorker.root, claimedWorker.workerId, (job) => ({
    ...job,
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        workerSpawnIntent: intent("worker", job.request.spawn.dispatch, "pending")
      }
    }
  }), claimedWorker.env);
  assert.throws(
    () => assertDispatchContract(tryReadJob(claimedWorker.root, claimedWorker.workerId, claimedWorker.env)),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );

  const controllerStarted = fixture("launch-impossible-controller-worker-0001");
  const claim = claimWorkerDispatch({ ...controllerStarted, holderId: "host:impossible-pair" });
  const controllerIntent = prepareDispatchProcessSpawn({
    root: controllerStarted.root,
    workerId: controllerStarted.workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    processKind: "controller",
    nonce: claim.nonce,
    env: controllerStarted.env
  }).intent;
  transitionWorkerDispatch({
    root: controllerStarted.root,
    workerId: controllerStarted.workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    state: "controller-started",
    controllerProcess: dispatchIdentity(controllerStarted, claim),
    spawnIntentId: controllerIntent.intentId,
    env: controllerStarted.env
  });
  const workerIntent = prepareDispatchProcessSpawn({
    root: controllerStarted.root,
    workerId: controllerStarted.workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    processKind: "worker",
    nonce: claim.nonce,
    env: controllerStarted.env
  }).intent;
  updateJob(controllerStarted.root, controllerStarted.workerId, (job) => ({
    ...job,
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        workerSpawnIntent: {
          ...workerIntent,
          status: "registered",
          registeredAt: new Date().toISOString()
        }
      }
    }
  }), controllerStarted.env);
  assert.throws(
    () => assertDispatchContract(tryReadJob(
      controllerStarted.root,
      controllerStarted.workerId,
      controllerStarted.env
    )),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
});

test("unsettled worker witnesses require and retain the active launch nonce", () => {
  const controllerStartedFixture = (key) => {
    const state = fixture(key);
    const claim = claimWorkerDispatch({ ...state, holderId: `host:${key}` });
    const controllerIntent = prepareDispatchProcessSpawn({
      root: state.root,
      workerId: state.workerId,
      attemptId: claim.attemptId,
      fence: claim.fence,
      processKind: "controller",
      nonce: claim.nonce,
      env: state.env
    }).intent;
    transitionWorkerDispatch({
      root: state.root,
      workerId: state.workerId,
      attemptId: claim.attemptId,
      fence: claim.fence,
      state: "controller-started",
      controllerProcess: dispatchIdentity(state, claim),
      spawnIntentId: controllerIntent.intentId,
      env: state.env
    });
    prepareDispatchProcessSpawn({
      root: state.root,
      workerId: state.workerId,
      attemptId: claim.attemptId,
      fence: claim.fence,
      processKind: "worker",
      nonce: claim.nonce,
      env: state.env
    });
    return { state, claim };
  };
  const witnessFor = (state, claim, nonce, pid) => ({
    pid,
    startToken: null,
    processGroupId: process.platform === "win32" ? null : pid,
    nonce,
    commandMarker: state.workerId,
    dispatchAttemptId: claim.attemptId,
    dispatchFence: claim.fence
  });

  const valid = controllerStartedFixture("launch-unsettled-worker-nonce-valid-0001");
  const recorded = recordUnsettledWorkerProcess({
    root: valid.state.root,
    workerId: valid.state.workerId,
    attemptId: valid.claim.attemptId,
    workerProcess: witnessFor(valid.state, valid.claim, valid.claim.nonce, 1_995_001),
    env: valid.state.env
  });
  assert.equal(recorded.phase, "cleanup-blocked");
  assert.equal(recorded.request.spawn.unsettledWorkerProcess.nonce, valid.claim.nonce);
  assert.doesNotThrow(() => assertDispatchContract(recorded));
  const validWorkerIntent = recorded.request.spawn.workerSpawnIntent;
  assert.throws(
    () => transitionWorkerDispatch({
      root: valid.state.root,
      workerId: valid.state.workerId,
      attemptId: valid.claim.attemptId,
      fence: valid.claim.fence,
      state: "worker-started",
      workerProcess: dispatchIdentity(valid.state, valid.claim),
      spawnIntentId: validWorkerIntent.intentId,
      env: valid.state.env
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  assert.equal(tryReadJob(valid.state.root, valid.state.workerId, valid.state.env).request.spawn.dispatch.state, "controller-started");

  const cleanupClaimed = controllerStartedFixture("launch-controller-cleanup-blocks-worker-0001");
  const cleanupController = dispatchIdentity(cleanupClaimed.state, cleanupClaimed.claim);
  updateJob(cleanupClaimed.state.root, cleanupClaimed.state.workerId, (job) => ({
    ...job,
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        controllerCleanupPending: true,
        controllerCleanupProcess: cleanupController
      }
    }
  }), cleanupClaimed.state.env);
  const cleanupJob = tryReadJob(cleanupClaimed.state.root, cleanupClaimed.state.workerId, cleanupClaimed.state.env);
  assert.doesNotThrow(() => assertDispatchContract(cleanupJob));
  assert.throws(
    () => transitionWorkerDispatch({
      root: cleanupClaimed.state.root,
      workerId: cleanupClaimed.state.workerId,
      attemptId: cleanupClaimed.claim.attemptId,
      fence: cleanupClaimed.claim.fence,
      state: "worker-started",
      workerProcess: dispatchIdentity(cleanupClaimed.state, cleanupClaimed.claim),
      spawnIntentId: cleanupJob.request.spawn.workerSpawnIntent.intentId,
      env: cleanupClaimed.state.env
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  assert.equal(tryReadJob(
    cleanupClaimed.state.root,
    cleanupClaimed.state.workerId,
    cleanupClaimed.state.env
  ).request.spawn.dispatch.state, "controller-started");

  const invalid = controllerStartedFixture("launch-unsettled-worker-nonce-invalid-0001");
  const before = tryReadJob(invalid.state.root, invalid.state.workerId, invalid.state.env);
  assert.throws(
    () => recordUnsettledWorkerProcess({
      root: invalid.state.root,
      workerId: invalid.state.workerId,
      attemptId: invalid.claim.attemptId,
      workerProcess: witnessFor(invalid.state, invalid.claim, "f".repeat(32), 1_995_002),
      env: invalid.state.env
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  assert.deepEqual(tryReadJob(invalid.state.root, invalid.state.workerId, invalid.state.env), before);
});

test("one pending outbox has one concurrent claimant", () => {
  const state = fixture("launch-outbox-concurrent-0001");
  const first = claimWorkerDispatch({
    ...state,
    holderId: "host:first",
    clock: () => 1_000,
    leaseMs: 100
  });
  const second = claimWorkerDispatch({
    ...state,
    holderId: "host:second",
    clock: () => 1_001,
    leaseMs: 100
  });
  assert.equal(first.claimed, true);
  assert.equal(first.fence, 1);
  assert.equal(second.claimed, false);
  assert.equal(second.reason, "already-claimed");
  assert.equal(second.job.request.spawn.dispatch.attemptId, first.attemptId);
});

test("an expired pre-intent lease is reclaimed with a new attempt and monotonic fence", () => {
  const state = fixture("launch-outbox-reclaim-0001");
  const first = claimWorkerDispatch({
    ...state,
    holderId: "host:first",
    clock: () => 1_000,
    leaseMs: 10
  });
  const second = claimWorkerDispatch({
    ...state,
    holderId: "host:restarted",
    clock: () => 1_011,
    leaseMs: 10
  });
  assert.equal(second.claimed, true);
  assert.notEqual(second.attemptId, first.attemptId);
  assert.equal(second.fence, first.fence + 1);
  assert.equal(second.lease.holderId, "host:restarted");
  const job = tryReadJob(state.root, state.workerId, state.env);
  assert.equal(job.workerAuthorization.dispatchAttemptId, second.attemptId);
  assert.equal(job.workerAuthorization.dispatchFence, second.fence);
});

test("a durable controller intent permanently closes lease-reclaim authority", () => {
  const state = fixture("launch-outbox-intent-0001");
  const first = claimWorkerDispatch({
    ...state,
    holderId: "host:first",
    clock: () => 1_000,
    leaseMs: 10
  });
  prepareDispatchProcessSpawn({
    root: state.root,
    workerId: state.workerId,
    attemptId: first.attemptId,
    fence: first.fence,
    processKind: "controller",
    nonce: first.nonce,
    env: state.env
  });
  const replay = claimWorkerDispatch({
    ...state,
    holderId: "host:restarted",
    clock: () => 9_999,
    leaseMs: 10
  });
  assert.equal(replay.claimed, false);
  assert.equal(replay.reason, "already-claimed");
  assert.equal(replay.job.request.spawn.dispatch.attemptId, first.attemptId);
});

test("stale dispatch fences cannot prepare a spawn boundary", () => {
  const state = fixture("launch-outbox-stale-fence-0001");
  const claim = claimWorkerDispatch({ ...state, holderId: "host:first" });
  assert.throws(
    () => prepareDispatchProcessSpawn({
      root: state.root,
      workerId: state.workerId,
      attemptId: claim.attemptId,
      fence: claim.fence + 1,
      processKind: "controller",
      nonce: claim.nonce,
      env: state.env
    }),
    (error) => error?.code === "E_STATE"
  );
});

test("dispatch-v2 rejects omitted fences and malformed lease bindings", () => {
  const omitted = fixture("launch-outbox-omitted-fence-0001");
  const omittedClaim = claimWorkerDispatch({ ...omitted, holderId: "host:first" });
  assert.throws(
    () => prepareDispatchProcessSpawn({
      root: omitted.root,
      workerId: omitted.workerId,
      attemptId: omittedClaim.attemptId,
      processKind: "controller",
      nonce: omittedClaim.nonce,
      env: omitted.env
    }),
    (error) => error?.code === "E_STATE"
  );

  const malformed = fixture("launch-outbox-malformed-lease-0001");
  const malformedClaim = claimWorkerDispatch({ ...malformed, holderId: "host:first" });
  updateJob(malformed.root, malformed.workerId, (job) => ({
    ...job,
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        dispatch: {
          ...job.request.spawn.dispatch,
          lease: {
            ...job.request.spawn.dispatch.lease,
            fence: malformedClaim.fence + 1
          }
        }
      }
    }
  }), malformed.env);
  assert.throws(
    () => prepareDispatchProcessSpawn({
      root: malformed.root,
      workerId: malformed.workerId,
      attemptId: malformedClaim.attemptId,
      fence: malformedClaim.fence,
      processKind: "controller",
      nonce: malformedClaim.nonce,
      env: malformed.env
    }),
    (error) => error?.code === "E_STATE"
  );
});

test("expired pre-intent cancellation terminalizes without replay or duplicate spawn", async () => {
  const state = fixture("launch-outbox-expired-cancel-0001");
  const claim = claimWorkerDispatch({
    ...state,
    holderId: "host:crashed",
    clock: () => 1_000,
    leaseMs: 10
  });
  const cancelled = cancelWorker({
    root: state.root,
    principal: state.principal,
    workerId: state.workerId,
    idempotencyKey: "launch-outbox-expired-cancel-request-0001",
    env: state.env
  });
  assert.equal(cancelled.receipt.status, "accepted");

  const staleRetry = claimWorkerDispatch({
    ...state,
    holderId: "host:restarted",
    clock: () => 1_011,
    leaseMs: 10
  });
  assert.equal(staleRetry.claimed, false);
  assert.equal(staleRetry.reason, "inactive");

  const recovery = await reconcileBrokerWorkers({
    root: state.root,
    principal: state.principal,
    clock: () => 1_011,
    dispatchStartupGraceMs: 0,
    env: state.env
  });
  assert.ok(recovery.results.some((entry) => (
    entry.workerId === state.workerId
    && entry.action === "terminalized"
    && entry.reason === "abandoned-claim-cancelled"
  )));
  const job = tryReadJob(state.root, state.workerId, state.env);
  assert.equal(job.status, "cancelled");
  assert.equal(job.request.spawn.dispatch.state, "failed");
  assert.equal(job.request.spawn.dispatch.attemptId, claim.attemptId);
  assert.equal(job.controllerProcess, undefined);
  assert.equal(job.workerProcess, undefined);
  assert.equal(job.providerProcess, undefined);
  assert.equal(job.result.taskRuntimeCleaned, true);
});

test("worker_wait starts an owned committed pending job once after service restart", {
  skip: process.platform === "win32"
}, async () => {
  const state = fixture("launch-outbox-wait-restart-0001");
  let spawnCalls = 0;
  const dispatchWorker = (args) => launchCommittedWorker({
    ...args,
    spawnProcess() {
      spawnCalls += 1;
      return { pid: process.pid, once() {}, unref() {} };
    },
    startToken: processStartToken
  });
  const firstService = createWorkerService({ ...state, dispatchWorker });
  const initial = tryReadJob(state.root, state.workerId, state.env);
  const cursor = {
    schemaVersion: 1,
    workerId: state.workerId,
    sequence: initial.lifecycleEvents.at(-1).sequence
  };
  await firstService.wait(state.workerId, { cursor, timeoutMs: 0 });
  assert.equal(spawnCalls, 1);
  assert.equal(tryReadJob(state.root, state.workerId, state.env).request.spawn.dispatch.state, "controller-started");

  const restartedService = createWorkerService({ ...state, dispatchWorker });
  await restartedService.wait(state.workerId, { cursor, timeoutMs: 0 });
  assert.equal(spawnCalls, 1, "restart must observe the durable boundary, not create another controller");
});

test("restarted worker_wait reclaims an expired pre-intent lease without another spawn request", {
  skip: process.platform === "win32"
}, async () => {
  const state = fixture("launch-outbox-wait-reclaim-0001");
  const abandoned = claimWorkerDispatch({
    ...state,
    holderId: "host:crashed",
    clock: () => 1_000,
    leaseMs: 1
  });
  let spawnCalls = 0;
  const service = createWorkerService({
    ...state,
    dispatchWorker: (args) => launchCommittedWorker({
      ...args,
      spawnProcess() {
        spawnCalls += 1;
        return { pid: process.pid, once() {}, unref() {} };
      },
      startToken: processStartToken
    })
  });
  const before = tryReadJob(state.root, state.workerId, state.env);
  await service.wait(state.workerId, {
    cursor: {
      schemaVersion: 1,
      workerId: state.workerId,
      sequence: before.lifecycleEvents.at(-1).sequence
    },
    timeoutMs: 0
  });
  const recovered = tryReadJob(state.root, state.workerId, state.env);
  assert.equal(spawnCalls, 1);
  assert.equal(recovered.request.spawn.dispatch.state, "controller-started");
  assert.notEqual(recovered.request.spawn.dispatch.attemptId, abandoned.attemptId);
  assert.equal(recovered.request.spawn.dispatch.fence, abandoned.fence + 1);
});

test("only an unambiguous pending v1 object authorization migrates to v2", (t) => {
  const safe = fixture("launch-outbox-v1-safe-0001");
  downgradePendingDispatchToV1(safe);
  const migrated = claimWorkerDispatch({ ...safe, holderId: "host:migration" });
  assert.equal(migrated.claimed, true);
  assert.equal(migrated.job.request.spawn.dispatch.schemaVersion, 2);
  assert.equal(migrated.job.workerAuthorization.schemaVersion, 2);
  assert.deepEqual(migrated.job.profile.providerToolIds, [
    "GrokBuild:read_file",
    "GrokBuild:list_dir",
    "GrokBuild:grep"
  ]);
  assert.ok(migrated.job.profile.deniedProviderToolIds.includes("GrokBuild:run_terminal_cmd"));

  const raw = fixture("launch-outbox-v1-raw-0001");
  downgradePendingDispatchToV1(raw, (job) => {
    job.workerAuthorization = job.workerAuthorization.nonce;
    return job;
  });
  const refused = claimWorkerDispatch({ ...raw, holderId: "host:migration" });
  assert.equal(refused.claimed, false);
  assert.equal(refused.reason, "already-claimed");
  assert.equal(refused.job.request.spawn.dispatch.schemaVersion, 1);

  const foreign = fixture("launch-outbox-v1-foreign-0001");
  downgradePendingDispatchToV1(foreign, (job) => {
    job.workerAuthorization = {
      schemaVersion: 1,
      nonce: job.workerAuthorization.nonce,
      ownerThreadId: "019f6a2f-8e34-7db1-a101-b9ca29e5ffff",
      purpose: "wrong-purpose",
      issuedAt: job.createdAt,
      unexpected: true
    };
    return job;
  });
  const foreignRefused = claimWorkerDispatch({ ...foreign, holderId: "host:migration" });
  assert.equal(foreignRefused.claimed, false);
  assert.equal(foreignRefused.job.request.spawn.dispatch.schemaVersion, 1);

  const guarded = fixture("launch-outbox-v1-guarded-0001");
  downgradePendingDispatchToV1(guarded);
  registerProviderGuard(guarded.root, guarded.workerId, {
    pid: process.pid,
    startToken: processStartToken(process.pid),
    processGroupId: process.platform === "win32" ? null : process.pid
  }, THREAD_ID);
  t.after(() => unregisterProviderGuard(guarded.root, guarded.workerId));
  const guardedRefused = claimWorkerDispatch({ ...guarded, holderId: "host:migration" });
  assert.equal(guardedRefused.claimed, false);
  assert.equal(guardedRefused.job.request.spawn.dispatch.schemaVersion, 1);

  for (const [field, witness] of [
    ["controllerProcess", { pid: null, startToken: "stale-controller-witness" }],
    ["providerProcess", {
      pid: 0,
      startToken: "stale-provider-witness",
      processGroupId: 12345
    }]
  ]) {
    const ambiguous = fixture(`launch-outbox-v1-${field}-0001`);
    downgradePendingDispatchToV1(ambiguous, (job) => {
      job[field] = witness;
      return job;
    });
    const ambiguousRefused = claimWorkerDispatch({
      ...ambiguous,
      holderId: "host:migration"
    });
    assert.equal(ambiguousRefused.claimed, false);
    assert.equal(ambiguousRefused.job.request.spawn.dispatch.schemaVersion, 1);
  }
});

test("v1 migration rejects each legacy ambiguity independently", () => {
  const predicateCases = [
    {
      label: "authorization-extra-key",
      mutate(job) { job.workerAuthorization.unexpected = true; }
    },
    {
      label: "dispatch-extra-key",
      mutate(job) { job.request.spawn.dispatch.unexpected = true; }
    },
    {
      label: "foreign-owner",
      mutate(job) { job.workerAuthorization.ownerThreadId = "019f6a2f-8e34-7db1-a101-b9ca29e5ffff"; }
    },
    {
      label: "wrong-purpose",
      mutate(job) { job.workerAuthorization.purpose = "inspect-worker"; }
    },
    {
      label: "wrong-valid-issued-at",
      mutate(job) {
        job.workerAuthorization.issuedAt = new Date(Date.parse(job.createdAt) + 1_000).toISOString();
      }
    },
    {
      label: "non-codex-host-principal",
      mutate(job) { job.host = { ...job.host, kind: "claude-code" }; },
      principal(principal) { return { ...principal, hostKind: "claude-code" }; }
    },
    {
      label: "legacy-profile-drift",
      mutate(job) { job.profile.permissionMode = "acceptEdits"; }
    }
  ];

  for (const { label, mutate, principal: principalFor } of predicateCases) {
    const state = fixture(`launch-outbox-v1-isolated-${label}-0001`);
    downgradePendingDispatchToV1(state, (job) => {
      mutate(job);
      return job;
    });
    const before = tryReadJob(state.root, state.workerId, state.env);
    const refused = claimWorkerDispatch({
      ...state,
      principal: principalFor ? principalFor(state.principal) : state.principal,
      holderId: `host:migration-${label}`
    });
    assert.equal(refused.claimed, false, `${label} unexpectedly migrated`);
    assert.equal(refused.reason, "already-claimed");
    assert.equal(refused.job.request.spawn.dispatch.schemaVersion, 1);
    assert.deepEqual(tryReadJob(state.root, state.workerId, state.env), before);
  }

  const presentFieldCases = [
    ["controller-spawn-intent", (job) => { job.request.spawn.controllerSpawnIntent = null; }],
    ["worker-spawn-intent", (job) => { job.request.spawn.workerSpawnIntent = null; }],
    ["controller-process", (job) => { job.controllerProcess = null; }],
    ["worker-process", (job) => { job.workerProcess = null; }],
    ["provider-process", (job) => { job.providerProcess = null; }],
    ["context-binding-mode", (job) => { job.request.contextBindingMode = null; }],
    ["context-packet", (job) => { job.request.contextPacket = null; }],
    ["runtime-role-policy", (job) => { job.request.runtimeRolePolicy = null; }],
    ["context-receipt", (job) => { job.request.contextReceipt = null; }],
    ["provider-home-id", (job) => { job.request.providerHomeId = job.id; }],
    ["context-binding-digest", (job) => {
      job.request.spawn.contextBindingDigest = "f".repeat(64);
    }],
    ["provider-tool-ids", (job) => {
      job.profile.providerToolIds = ["GrokBuild:read_file"];
    }],
    ["denied-provider-tool-ids", (job) => {
      job.profile.deniedProviderToolIds = ["GrokBuild:run_terminal_cmd"];
    }]
  ];
  for (const [label, addPresentField] of presentFieldCases) {
    const state = fixture(`launch-outbox-v1-present-${label}-0001`);
    downgradePendingDispatchToV1(state, (job) => {
      addPresentField(job);
      return job;
    });
    const before = tryReadJob(state.root, state.workerId, state.env);
    const refused = claimWorkerDispatch({
      ...state,
      holderId: `host:migration-present-${label}`
    });
    assert.equal(refused.claimed, false, `${label}:null unexpectedly migrated`);
    assert.equal(refused.reason, "already-claimed");
    assert.equal(refused.job.request.spawn.dispatch.schemaVersion, 1);
    assert.deepEqual(tryReadJob(state.root, state.workerId, state.env), before);
  }
});

test("v1 migration rejects an altered stored execution root without launching", () => {
  const state = fixture("launch-outbox-v1-untrusted-execution-root-0001");
  const untrustedExecutionRoot = tempDir("worker-launch-untrusted-root-");
  downgradePendingDispatchToV1(state, (job) => {
    job.request.spawn.executionRoot = untrustedExecutionRoot;
    return job;
  });

  const before = tryReadJob(state.root, state.workerId, state.env);
  let spawnCalls = 0;
  const launched = launchCommittedWorker({
    ...state,
    spawnProcess() {
      spawnCalls += 1;
      return { pid: process.pid, once() {}, unref() {} };
    },
    startToken: processStartToken
  });
  assert.equal(launched.claimed, false);
  assert.equal(spawnCalls, 0);
  assert.deepEqual(tryReadJob(state.root, state.workerId, state.env), before);
});

test("v1 migration rejects altered executable request and prompt bindings", () => {
  const cases = [
    {
      label: "envelope",
      mutate(job) {
        job.request.envelope.objective = "Tampered legacy objective";
      }
    },
    {
      label: "request-digest",
      mutate(job) {
        job.request.spawn.requestDigest = differentSha(job.request.spawn.requestDigest);
      }
    },
    {
      label: "provider-prompt-digest",
      mutate(job) {
        job.request.providerPromptDigest = differentSha(job.request.providerPromptDigest);
      }
    }
  ];

  for (const { label, mutate } of cases) {
    const state = fixture(`launch-outbox-v1-binding-${label}-0001`);
    downgradePendingDispatchToV1(state, (job) => {
      mutate(job);
      return job;
    });
    const before = tryReadJob(state.root, state.workerId, state.env);
    const refused = claimWorkerDispatch({
      ...state,
      holderId: `host:migration-binding-${label}`
    });
    assert.equal(refused.claimed, false, `${label} unexpectedly migrated`);
    assert.equal(refused.reason, "already-claimed");
    assert.equal(refused.job.request.spawn.dispatch.schemaVersion, 1);
    assert.deepEqual(tryReadJob(state.root, state.workerId, state.env), before);
  }
});

test("v1 migration rejects a forged linked-worktree context manifest", (t) => {
  const state = fixture("launch-outbox-v1-forged-linked-context-0001");
  const linked = addLinkedWorktree(state.root, "forged-v1-context");
  t.after(() => git(state.root, "worktree", "remove", "--force", linked));
  downgradePendingDispatchToV1(state, (job) => {
    job.request.contextManifest = captureContextManifest(linked);
    return job;
  });

  const before = tryReadJob(state.root, state.workerId, state.env);
  const refused = claimWorkerDispatch({
    ...state,
    holderId: "host:migration-forged-linked-context"
  });
  assert.equal(refused.claimed, false);
  assert.equal(refused.reason, "already-claimed");
  assert.equal(refused.job.request.spawn.dispatch.schemaVersion, 1);
  assert.deepEqual(tryReadJob(state.root, state.workerId, state.env), before);
});

test("exact v1 migration preserves its linked execution root when claimed through the primary", (t) => {
  const primaryRoot = initRepo();
  const linkedRoot = addLinkedWorktree(primaryRoot, "exact-v1-context");
  t.after(() => git(primaryRoot, "worktree", "remove", "--force", linkedRoot));
  const pluginData = tempDir("worker-launch-outbox-linked-data-");
  const env = {
    ...process.env,
    GROK_COMPANION_PLUGIN_DATA: pluginData,
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_HOST_SESSION_ID: THREAD_ID,
    CODEX_THREAD_ID: THREAD_ID
  };
  const principal = {
    hostKind: "codex",
    threadId: THREAD_ID,
    pluginId: "grok@grok-companion"
  };
  const admitted = spawnReadOnlyWorker({
    root: linkedRoot,
    principal,
    envelope: buildTaskEnvelope({
      userRequest: "Preserve the admitted linked execution root",
      mode: "read"
    }),
    idempotencyKey: "launch-outbox-v1-linked-preserve-0001",
    env
  });
  const state = { root: linkedRoot, env, principal, workerId: admitted.handle.id };
  downgradePendingDispatchToV1(state);
  const before = tryReadJob(primaryRoot, state.workerId, env);
  const storedExecutionRoot = before.request.spawn.executionRoot;
  assert.equal(storedExecutionRoot, resolveControlWorkspace(linkedRoot, env).executionRoot);

  const migrated = claimWorkerDispatch({
    root: primaryRoot,
    principal,
    workerId: state.workerId,
    holderId: "host:migration-through-primary",
    env
  });
  assert.equal(migrated.claimed, true);
  assert.equal(migrated.job.request.spawn.dispatch.schemaVersion, 2);
  assert.equal(migrated.job.request.spawn.executionRoot, storedExecutionRoot);
  assert.equal(migrated.job.request.contextManifest.workspaceRoot, storedExecutionRoot);
  assert.equal(
    tryReadJob(primaryRoot, state.workerId, env).request.spawn.executionRoot,
    storedExecutionRoot
  );
});
