import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import crypto from "node:crypto";

import {
  buildTaskEnvelope,
  buildWorkerReport
} from "../plugins/grok/scripts/lib/task-contract.mjs";
import {
  attachHostActionRequestToJob,
  assertAdmissionGrantEligible,
  decideHostActionRoleAdmission,
  mintHostActionRequest,
  projectAwaitingHostAction,
  readHostActionRequestBinding
} from "../plugins/grok/scripts/lib/worker-host-actions.mjs";
import {
  resolveWorkerAuthority
} from "../plugins/grok/scripts/lib/worker-authority.mjs";
import { spawnReadOnlyWorker } from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import { profileFor } from "../plugins/grok/scripts/lib/profiles.mjs";
import { projectWorkerSnapshot } from "../plugins/grok/scripts/lib/worker-protocol.mjs";
import {
  tryReadJob,
  updateJob
} from "../plugins/grok/scripts/lib/state.mjs";
import { workspaceState } from "../plugins/grok/scripts/lib/workspace.mjs";
import { initRepo, tempDir } from "./helpers.mjs";

const THREAD = "019f666a-6469-7cc1-9a8d-8c1adf61e103";
const THREAD_B = "019f666b-1e72-74b1-b27c-9d186d7f1016";
const TURN = "019f666e-4084-7902-8447-249f72043a37";
const ATTEMPT = "a".repeat(32);
const FENCE = 1;
const GENERATION = 1;
const SESSION = "019f918e-9a33-7781-b96a-2b2ddc635be1";

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
  return crypto.createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function envFor() {
  const pluginData = tempDir("grok-host-action-data-");
  return {
    HOME: path.dirname(pluginData),
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_PLUGIN_DATA: pluginData
  };
}

function spawnPrincipal(root, threadId = THREAD) {
  return {
    hostKind: "codex",
    threadId,
    turnId: TURN,
    source: "codex-mcp-stdio",
    pluginId: "grok@grok-companion",
    root,
    mutationCapable: true
  };
}

function authority(root, {
  threadId = THREAD,
  attestedParentThreadId = null
} = {}) {
  return resolveWorkerAuthority({
    threadId,
    plugin_id: "grok@grok-companion",
    attestedByHost: attestedParentThreadId !== null,
    attestedParentThreadId,
    "x-codex-turn-metadata": {
      thread_id: threadId,
      turn_id: TURN,
      plugin_id: "grok@grok-companion",
      attested_by_host: attestedParentThreadId !== null,
      attested_parent_thread_id: attestedParentThreadId
    },
    "codex/sandbox-state-meta": {
      sandboxCwd: pathToFileURL(root).href
    }
  }, { mutation: true });
}

function providerReport(hostActionRequest = undefined) {
  const payload = {
    outcome: "complete",
    summary: "Completed",
    changedFiles: [],
    checksClaimed: [],
    acceptanceResults: [],
    risks: [],
    questions: [],
    ...(hostActionRequest !== undefined ? { hostActionRequest } : {})
  };
  return `GROK_WORKER_REPORT: ${JSON.stringify(payload)}`;
}

function providerStartedJob({
  requestedRoleId = "reviewer",
  attach = true,
  threadId = THREAD,
  sourceWrite = false
} = {}) {
  const root = initRepo();
  const env = envFor();
  const admitted = spawnReadOnlyWorker({
    root,
    principal: spawnPrincipal(root, threadId),
    envelope: buildTaskEnvelope({
      userRequest: "Inspect repository",
      mode: sourceWrite ? "write" : "read"
    }),
    idempotencyKey: `host-action-spawn-${crypto.randomBytes(6).toString("hex")}`,
    roleId: sourceWrite ? "implementer" : "explorer",
    write: sourceWrite,
    allowWriteSpawn: sourceWrite,
    env
  });
  const workerId = admitted.handle.id;
  const at = new Date().toISOString();
  const workerProcess = {
    pid: 999_991,
    startToken: "worker-start-token",
    processGroupId: process.platform === "win32" ? null : 999_991,
    commandMarker: workerId,
    dispatchAttemptId: ATTEMPT,
    dispatchFence: FENCE,
    nonce: "worker-nonce"
  };
  const providerProcess = {
    pid: 999_992,
    startToken: "provider-start-token",
    processGroupId: process.platform === "win32" ? null : 999_992,
    commandMarker: workerId,
    dispatchAttemptId: ATTEMPT,
    dispatchFence: FENCE,
    providerGeneration: GENERATION
  };
  updateJob(root, workerId, (current) => {
    const active = {
      ...current,
      status: "running",
      phase: "finalizing",
      workerProcess,
      providerProcess,
      request: {
        ...current.request,
        spawn: {
          ...current.request.spawn,
          dispatch: {
            ...current.request.spawn.dispatch,
            state: "provider-started",
            attemptId: ATTEMPT,
            fence: FENCE,
            lease: null,
            providerGeneration: GENERATION,
            nextProviderGeneration: null,
            claimedAt: at,
            controllerStartedAt: at,
            workerStartedAt: at,
            providerStartedAt: at,
            updatedAt: at
          },
          consumedLaunchContractDigest: "b".repeat(64),
          launchContractConsumedAt: at
        }
      }
    };
    if (!attach) return active;
    return {
      ...attachHostActionRequestToJob(active, {
        providerRequest: {
          schemaVersion: 1,
          kind: "role_admission",
          requestedRoleId
        },
        dispatchAttemptId: ATTEMPT,
        dispatchFence: FENCE,
        providerGeneration: GENERATION,
        providerSessionId: SESSION
      }),
      grokSessionId: SESSION,
      status: "completed",
      phase: "done",
      completedAt: at
    };
  }, env);
  return {
    root,
    env,
    workerId,
    job: tryReadJob(root, workerId, env)
  };
}

function decide(fixture, overrides = {}) {
  const binding = readHostActionRequestBinding(
    tryReadJob(fixture.root, fixture.workerId, fixture.env)
  );
  return decideHostActionRoleAdmission({
    root: fixture.root,
    principal: authority(fixture.root),
    workerId: fixture.workerId,
    requestId: binding.requestId,
    requestDigest: binding.requestDigest,
    decision: "grant",
    idempotencyKey: "host-action-decision-0001",
    env: fixture.env,
    ...overrides
  });
}

function sidecarPath(fixture, key) {
  const keyDigest = stableDigest({ idempotencyKey: key });
  return path.join(
    workspaceState(fixture.root, fixture.env),
    "idempotency",
    "host-action",
    `${keyDigest}.json`
  );
}

test("worker reports accept one exact optional role request and reject arbitrary authority", () => {
  const exact = buildWorkerReport({
    providerText: providerReport({
      schemaVersion: 1,
      kind: "role_admission",
      requestedRoleId: "reviewer"
    })
  });
  assert.equal(exact.valid, true);
  assert.deepEqual(exact.hostActionRequest, {
    schemaVersion: 1,
    kind: "role_admission",
    requestedRoleId: "reviewer"
  });

  const absent = buildWorkerReport({ providerText: providerReport() });
  assert.equal(absent.valid, true);
  assert.equal(Object.hasOwn(absent, "hostActionRequest"), false);

  for (const forged of [
    { schemaVersion: 1, kind: "role_admission", requestedRoleId: "reviewer", tools: ["edit"] },
    { schemaVersion: 1, kind: "role_admission", requestedRoleId: "explorer" },
    { schemaVersion: 1, kind: "widen_tools", requestedRoleId: "reviewer" },
    { schemaVersion: 1, kind: "role_admission", requestedRoleId: "root" }
  ]) {
    const report = buildWorkerReport({ providerText: providerReport(forged) });
    assert.equal(report.valid, false);
    assert.equal(report.hostActionRequest, undefined);
  }

  const implementer = buildWorkerReport({
    providerText: providerReport({
      schemaVersion: 1,
      kind: "role_admission",
      requestedRoleId: "implementer"
    })
  });
  assert.equal(implementer.valid, true);
  assert.equal(implementer.hostActionRequest.requestedRoleId, "implementer");
});

test("request minting requires the exact provider-started attempt, process generation, and session", () => {
  const fixture = providerStartedJob({ attach: false });
  const active = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  const providerRequest = {
    schemaVersion: 1,
    kind: "role_admission",
    requestedRoleId: "reviewer"
  };
  assert.doesNotThrow(() => mintHostActionRequest(active, {
    providerRequest,
    dispatchAttemptId: ATTEMPT,
    dispatchFence: FENCE,
    providerGeneration: GENERATION,
    providerSessionId: SESSION
  }));
  for (const options of [
    { dispatchAttemptId: null },
    { dispatchAttemptId: "c".repeat(32) },
    { dispatchFence: FENCE + 1 },
    { providerGeneration: GENERATION + 1 },
    { providerSessionId: null }
  ]) {
    assert.throws(
      () => mintHostActionRequest(active, {
        providerRequest,
        dispatchAttemptId: ATTEMPT,
        dispatchFence: FENCE,
        providerGeneration: GENERATION,
        providerSessionId: SESSION,
        ...options
      }),
      (error) => [
        "E_RECURSION",
        "E_PROCESS_IDENTITY",
        "E_STATE"
      ].includes(error?.code)
    );
  }
  assert.throws(
    () => mintHostActionRequest(active, {
      providerRequest: { ...providerRequest, requestedRoleId: "implementer" },
      dispatchAttemptId: ATTEMPT,
      dispatchFence: FENCE,
      providerGeneration: GENERATION,
      providerSessionId: SESSION
    }),
    (error) => error?.code === "E_CAPABILITY"
  );
});

test("exact broker owner grants once without mutating current worker authority", () => {
  const fixture = providerStartedJob();
  const before = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  const authorityBefore = stableDigest({
    host: before.host,
    role: before.role,
    write: before.write,
    profile: before.profile,
    request: before.request,
    workerProcess: before.workerProcess,
    providerProcess: before.providerProcess,
    grokSessionId: before.grokSessionId,
    controlWorkspaceId: before.controlWorkspaceId
  });
  const first = decide(fixture);
  assert.equal(first.decision, "grant");
  assert.equal(first.application, "future-admission-only");
  assert.equal(first.applied, false);
  assert.equal(first.replayed, false);
  assert.equal(first.grant.requestedRoleId, "reviewer");
  assert.equal(first.grant.applied, false);
  const after = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  const authorityAfter = stableDigest({
    host: after.host,
    role: after.role,
    write: after.write,
    profile: after.profile,
    request: after.request,
    workerProcess: after.workerProcess,
    providerProcess: after.providerProcess,
    grokSessionId: after.grokSessionId,
    controlWorkspaceId: after.controlWorkspaceId
  });
  assert.equal(authorityAfter, authorityBefore);

  const replay = decide(fixture);
  assert.equal(replay.replayed, true);
  assert.equal(replay.grant.grantId, first.grant.grantId);
  assert.throws(
    () => decide(fixture, { idempotencyKey: "host-action-different-key" }),
    (error) => error?.code === "E_IDEMPOTENCY_CONFLICT"
  );
});

test("plain, foreign, and host-attested child principals cannot observe or decide owner state", () => {
  const fixture = providerStartedJob();
  const binding = readHostActionRequestBinding(fixture.job);
  const input = {
    root: fixture.root,
    workerId: fixture.workerId,
    requestId: binding.requestId,
    requestDigest: binding.requestDigest,
    decision: "grant",
    idempotencyKey: "foreign-host-action-key",
    env: fixture.env
  };
  assert.throws(
    () => decideHostActionRoleAdmission({
      ...input,
      principal: spawnPrincipal(fixture.root)
    }),
    (error) => error?.code === "E_AUTH_REQUIRED"
  );
  assert.throws(
    () => decideHostActionRoleAdmission({
      ...input,
      principal: authority(fixture.root, { threadId: THREAD_B })
    }),
    (error) => error?.code === "E_JOB_NOT_FOUND"
  );
  assert.throws(
    () => decideHostActionRoleAdmission({
      ...input,
      principal: authority(fixture.root, {
        threadId: THREAD_B,
        attestedParentThreadId: THREAD
      })
    }),
    (error) => error?.code === "E_JOB_NOT_FOUND"
  );
});

test("durable decision replay repairs a lost sidecar but rejects another key and sidecar tamper", () => {
  const fixture = providerStartedJob();
  const key = "host-action-decision-0001";
  decide(fixture, { idempotencyKey: key });
  const file = sidecarPath(fixture, key);
  fs.unlinkSync(file);
  const recovered = decide(fixture, { idempotencyKey: key });
  assert.equal(recovered.replayed, true);
  assert.equal(fs.existsSync(file), true);

  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, `${JSON.stringify({ ...stored, recordDigest: "0".repeat(64) })}\n`);
  assert.throws(
    () => decide(fixture, { idempotencyKey: key }),
    (error) => error?.code === "E_STATE"
  );
});

test("cross-worker replay conflicts only after exact owner authorization", () => {
  const first = providerStartedJob();
  const secondRoot = first.root;
  const second = spawnReadOnlyWorker({
    root: secondRoot,
    principal: spawnPrincipal(secondRoot),
    envelope: buildTaskEnvelope({ userRequest: "Second worker", mode: "read" }),
    idempotencyKey: "second-worker-spawn-key",
    env: first.env
  });
  // Reuse the fixture builder's exact runtime bindings on the second worker.
  const at = new Date().toISOString();
  updateJob(secondRoot, second.handle.id, (current) => {
    const active = {
      ...current,
      status: "running",
      phase: "finalizing",
      workerProcess: {
        pid: 999_981,
        startToken: "second-worker",
        processGroupId: process.platform === "win32" ? null : 999_981,
        commandMarker: second.handle.id,
        dispatchAttemptId: ATTEMPT,
        dispatchFence: FENCE,
        nonce: "second-nonce"
      },
      providerProcess: {
        pid: 999_982,
        startToken: "second-provider",
        processGroupId: process.platform === "win32" ? null : 999_982,
        commandMarker: second.handle.id,
        dispatchAttemptId: ATTEMPT,
        dispatchFence: FENCE,
        providerGeneration: GENERATION
      },
      request: {
        ...current.request,
        spawn: {
          ...current.request.spawn,
          dispatch: {
            ...current.request.spawn.dispatch,
            state: "provider-started",
            attemptId: ATTEMPT,
            fence: FENCE,
            lease: null,
            providerGeneration: GENERATION,
            nextProviderGeneration: null,
            claimedAt: at,
            controllerStartedAt: at,
            workerStartedAt: at,
            providerStartedAt: at,
            updatedAt: at
          },
          consumedLaunchContractDigest: "c".repeat(64),
          launchContractConsumedAt: at
        }
      }
    };
    return {
      ...attachHostActionRequestToJob(active, {
        providerRequest: {
          schemaVersion: 1,
          kind: "role_admission",
          requestedRoleId: "security"
        },
        dispatchAttemptId: ATTEMPT,
        dispatchFence: FENCE,
        providerGeneration: GENERATION,
        providerSessionId: "019f918e-9a33-7781-b96a-2b2ddc635be2"
      }),
      grokSessionId: "019f918e-9a33-7781-b96a-2b2ddc635be2",
      status: "completed",
      phase: "done"
    };
  }, first.env);
  const firstDecision = decide(first, { idempotencyKey: "cross-worker-host-action" });
  assert.equal(firstDecision.replayed, false);
  const secondBinding = readHostActionRequestBinding(
    tryReadJob(secondRoot, second.handle.id, first.env)
  );
  assert.throws(
    () => decideHostActionRoleAdmission({
      root: secondRoot,
      principal: authority(secondRoot),
      workerId: second.handle.id,
      requestId: secondBinding.requestId,
      requestDigest: secondBinding.requestDigest,
      decision: "grant",
      idempotencyKey: "cross-worker-host-action",
      env: first.env
    }),
    (error) => error?.code === "E_IDEMPOTENCY_CONFLICT"
  );
});

test("role, policy, context, process, session, and resume drift fail closed", () => {
  const mutations = [
    (job) => { job.grokSessionId = "019f918e-9a33-7781-b96a-2b2ddc635be9"; },
    (job) => { job.providerProcess.providerGeneration += 1; },
    (job) => { job.request.contextManifest.digest = "0".repeat(64); },
    (job) => { job.request.resumeJobId = "task-aaaaaaaaaaaaaaaa"; },
    (job) => { job.request.runtimeRolePolicy.digest = "0".repeat(64); },
    (job) => { job.role.digest = "0".repeat(64); }
  ];
  for (const mutate of mutations) {
    const fixture = providerStartedJob();
    updateJob(fixture.root, fixture.workerId, (current) => {
      const next = structuredClone(current);
      mutate(next);
      return next;
    }, fixture.env);
    assert.throws(
      () => decide(fixture),
      (error) => [
        "E_PROCESS_IDENTITY",
        "E_CONTEXT_DRIFT",
        "E_ROLE",
        "E_AUTH_REQUIRED",
        "E_STATE"
      ].includes(error?.code)
    );
  }
});

test("public snapshot exposes only the exact bounded request projection", () => {
  const fixture = providerStartedJob();
  const snapshot = projectWorkerSnapshot(fixture.job);
  assert.deepEqual(snapshot.awaitingHostAction, projectAwaitingHostAction(fixture.job));
  assert.equal(snapshot.awaitingHostAction.status, "awaiting");
  const text = JSON.stringify(snapshot.awaitingHostAction);
  for (const forbidden of [
    THREAD,
    SESSION,
    "worker-start-token",
    "provider-start-token",
    "worker-nonce",
    fixture.job.request.runtimeRolePolicy.digest
  ]) {
    assert.equal(text.includes(forbidden), false);
  }
  assert.throws(
    () => projectWorkerSnapshot({
      ...fixture.job,
      hostAction: null,
      awaitingHostAction: {
        ...snapshot.awaitingHostAction,
        privateDigest: "0".repeat(64)
      }
    }),
    (error) => error?.code === "E_SCHEMA"
  );
  const missing = structuredClone(snapshot.awaitingHostAction);
  delete missing.application;
  assert.throws(
    () => projectWorkerSnapshot({
      ...fixture.job,
      hostAction: null,
      awaitingHostAction: missing
    }),
    (error) => error?.code === "E_SCHEMA"
  );
});

test("grant eligibility requires every exact parent and target binding", () => {
  const fixture = providerStartedJob();
  decide(fixture);
  const job = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  const grant = job.hostAction.grant;
  const decision = job.hostAction.decision;
  const request = job.hostAction.request;
  assert.throws(
    () => assertAdmissionGrantEligible(grant, {}),
    (error) => error?.code === "E_CAPABILITY"
  );
  const bindings = {
    sourceWorkerId: job.id,
    sourceRequestId: request.requestId,
    sourceRequestDigest: request.requestDigest,
    sourceDecisionId: decision.decisionId,
    sourceDecisionDigest: decision.decisionDigest,
    grantId: grant.grantId,
    grantDigest: grant.grantDigest,
    lineageWorkerId: job.request.providerHomeId,
    resumeJobId: job.request.resumeJobId ?? null,
    parentRole: job.role,
    parentRuntimeRolePolicy: job.request.runtimeRolePolicy,
    parentProfile: job.profile,
    parentContextManifest: job.request.contextManifest,
    parentContextReceipt: job.request.contextReceipt,
    providerPromptDigest: job.request.providerPromptDigest,
    targetProfile: profileFor("task", false)
  };
  assert.equal(assertAdmissionGrantEligible(grant, bindings).grantId, grant.grantId);
  assert.throws(
    () => assertAdmissionGrantEligible(grant, {
      ...bindings,
      sourceWorkerId: "task-ffffffffffffffff"
    }),
    (error) => error?.code === "E_CAPABILITY"
  );
  assert.throws(
    () => assertAdmissionGrantEligible(grant, {
      ...bindings,
      parentContextManifest: {
        ...bindings.parentContextManifest,
        digest: "0".repeat(64)
      }
    }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
  );
  assert.throws(
    () => readHostActionRequestBinding({
      ...job,
      id: "task-ffffffffffffffff"
    }),
    (error) => error?.code === "E_STATE"
  );
  assert.throws(
    () => projectAwaitingHostAction({
      ...job,
      id: "task-ffffffffffffffff"
    }),
    (error) => error?.code === "E_STATE"
  );
});

test("a write-source worker can only mint a read-only target role policy", () => {
  const fixture = providerStartedJob({ sourceWrite: true });
  decide(fixture);
  const job = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  assert.equal(job.profile.id, "rescue-write-v3");
  assert.equal(job.hostAction.grant.targetRole.write, false);
  assert.equal(job.hostAction.grant.targetRuntimeRolePolicy.providerProfileId, "rescue-read-v3");
  assert.equal(
    job.hostAction.grant.targetRuntimeRolePolicy.allowedProviderToolIds.includes("GrokBuild:search_replace"),
    false
  );
  assert.equal(
    job.hostAction.grant.targetRuntimeRolePolicy.allowedProviderToolIds.includes("GrokBuild:todo_write"),
    false
  );
});

test("deny is durable and never creates a grant", () => {
  const fixture = providerStartedJob({ requestedRoleId: "test" });
  const denied = decide(fixture, {
    decision: "deny",
    idempotencyKey: "host-action-deny-key"
  });
  assert.equal(denied.decision, "deny");
  assert.equal(denied.grant, null);
  const job = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  assert.equal(job.hostAction.grant, null);
  assert.equal(projectWorkerSnapshot(job).awaitingHostAction.status, "denied");
});
