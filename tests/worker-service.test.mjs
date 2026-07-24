import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { WORKER_SPAWN_TOOL } from "../plugins/grok/mcp/broker.mjs";
import { resolveWorkerAuthority } from "../plugins/grok/scripts/lib/worker-authority.mjs";
import {
  assertTaskEnvelope,
  buildTaskEnvelope,
  captureContextManifest
} from "../plugins/grok/scripts/lib/task-contract.mjs";
import {
  attachHostActionRequestToJob,
  readHostActionRequestBinding
} from "../plugins/grok/scripts/lib/worker-host-actions.mjs";
import { tryReadJob, updateJob } from "../plugins/grok/scripts/lib/state.mjs";
import { createWorkerService } from "../plugins/grok/scripts/lib/worker-service.mjs";
import {
  claimWorkerDispatch,
  providerLaunchState,
  spawnReadOnlyWorker
} from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import { materializeRole } from "../plugins/grok/scripts/lib/worker-roles.mjs";
import { workspaceStateSegment } from "../plugins/grok/scripts/lib/workspace.mjs";
import { initRepo, tempDir } from "./helpers.mjs";

const THREAD_A = "019f666a-6469-7cc1-9a8d-8c1adf61e103";
const THREAD_B = "019f666b-1e72-74b1-b27c-9d186d7f1016";
const TURN_ID = "019f666e-4084-7902-8447-249f72043a37";
const FOLLOWUP_ATTEMPT = "e".repeat(32);
const FOLLOWUP_SESSION = "019f918e-9a33-7781-b96a-2b2ddc635be1";

function metadata(cwd, overrides = {}) {
  const value = {
    threadId: THREAD_A,
    "x-codex-turn-metadata": {
      thread_id: THREAD_A,
      turn_id: TURN_ID
    },
    plugin_id: "grok@grok-companion",
    "codex/sandbox-state-meta": {
      permissionProfile: { type: "read-only" },
      sandboxCwd: pathToFileURL(cwd).href,
      useLegacyLandlock: false
    }
  };
  return { ...value, ...overrides };
}

function record(id, sessionId, overrides = {}) {
  return {
    schemaVersion: 3,
    id,
    kind: "task",
    jobClass: "task",
    write: false,
    status: "running",
    phase: "executing",
    summary: "Running",
    progress: "Inspecting",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:01.000Z",
    host: { kind: "codex", sessionId },
    lifecycleEvents: [{
      type: "task.accepted",
      at: "2026-07-15T00:00:00.000Z",
      summary: "Accepted",
      sequence: 1
    }],
    request: null,
    result: null,
    error: null,
    ...overrides
  };
}

function stateFixture(root) {
  const pluginData = tempDir("grok-worker-service-data-");
  const jobs = path.join(
    pluginData,
    "state",
    workspaceStateSegment(fs.realpathSync(root)),
    "jobs"
  );
  fs.mkdirSync(jobs, { recursive: true, mode: 0o700 });
  const env = {
    HOME: path.dirname(pluginData),
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_PLUGIN_DATA: pluginData
  };
  return {
    env,
    jobs,
    write(job) {
      fs.writeFileSync(path.join(jobs, `${job.id}.json`), `${JSON.stringify(job)}\n`, { mode: 0o600 });
    }
  };
}

function awaitingRoleAdmissionParent(root, env) {
  const principal = resolveWorkerAuthority(metadata(root), { mutation: true });
  const admitted = spawnReadOnlyWorker({
    root,
    principal,
    envelope: buildTaskEnvelope({ userRequest: "Service follow-up parent", mode: "read" }),
    contextManifest: captureContextManifest(root),
    idempotencyKey: "service-followup-parent-0001",
    env
  });
  const workerId = admitted.handle.id;
  const at = new Date().toISOString();
  updateJob(root, workerId, (current) => {
    const active = {
      ...current,
      status: "running",
      phase: "finalizing",
      workerProcess: {
        pid: 997_991,
        startToken: "service-worker-start",
        processGroupId: process.platform === "win32" ? null : 997_991,
        commandMarker: workerId,
        dispatchAttemptId: FOLLOWUP_ATTEMPT,
        dispatchFence: 1,
        nonce: "service-worker-nonce"
      },
      providerProcess: {
        pid: 997_992,
        startToken: "service-provider-start",
        processGroupId: process.platform === "win32" ? null : 997_992,
        commandMarker: workerId,
        dispatchAttemptId: FOLLOWUP_ATTEMPT,
        dispatchFence: 1,
        providerGeneration: 1
      },
      request: {
        ...current.request,
        spawn: {
          ...current.request.spawn,
          dispatch: {
            ...current.request.spawn.dispatch,
            state: "provider-started",
            attemptId: FOLLOWUP_ATTEMPT,
            fence: 1,
            lease: null,
            providerGeneration: 1,
            nextProviderGeneration: null,
            claimedAt: at,
            controllerStartedAt: at,
            workerStartedAt: at,
            providerStartedAt: at,
            updatedAt: at
          },
          consumedLaunchContractDigest: "d".repeat(64),
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
        dispatchAttemptId: FOLLOWUP_ATTEMPT,
        dispatchFence: 1,
        providerGeneration: 1,
        providerSessionId: FOLLOWUP_SESSION
      }),
      grokSessionId: FOLLOWUP_SESSION,
      status: "completed",
      phase: "done",
      completedAt: at,
      completionContextManifest: captureContextManifest(root),
      result: {
        hostVerification: "not_run",
        taskRuntimeCleaned: true
      }
    };
  }, env);
  return {
    principal,
    workerId,
    binding: readHostActionRequestBinding(tryReadJob(root, workerId, env))
  };
}

test("Codex MCP authority requires matching per-call identity and a trusted Git workspace", () => {
  const root = initRepo();
  const child = path.join(root, "nested");
  fs.mkdirSync(child);
  const authority = resolveWorkerAuthority(metadata(child));
  assert.equal(authority.hostKind, "codex");
  assert.equal(authority.threadId, THREAD_A);
  assert.equal(authority.turnId, TURN_ID);
  assert.equal(authority.pluginId, "grok@grok-companion");
  assert.equal(authority.root, fs.realpathSync(root));

  assert.throws(
    () => resolveWorkerAuthority(metadata(root, { threadId: THREAD_B })),
    (error) => error?.code === "E_AUTH_REQUIRED"
  );
  assert.throws(
    () => resolveWorkerAuthority(metadata(root, {
      plugin_id: "other@market"
    })),
    (error) => error?.code === "E_AUTH_REQUIRED"
  );
  assert.throws(
    () => resolveWorkerAuthority(metadata(root, {
      "x-codex-turn-metadata": {
        thread_id: THREAD_A,
        turn_id: TURN_ID,
        plugin_id: "grok@different-market"
      }
    })),
    (error) => error?.code === "E_AUTH_REQUIRED"
  );
  assert.throws(
    () => resolveWorkerAuthority(metadata(root, { "codex/sandbox-state-meta": undefined })),
    (error) => error?.code === "E_CAPABILITY"
  );
  assert.throws(
    () => resolveWorkerAuthority(metadata(root, {
      "codex/sandbox-state-meta": { sandboxCwd: "https://example.com/repository" }
    })),
    (error) => error?.code === "E_CAPABILITY"
  );
});

test("read-only worker service lists and reads only the current Codex task", () => {
  const root = initRepo();
  const fixture = stateFixture(root);
  const owned = record("task-aaaaaaaaaaaaaaaa", THREAD_A);
  const foreign = record("task-bbbbbbbbbbbbbbbb", THREAD_B);
  fixture.write(owned);
  fixture.write(foreign);

  const service = createWorkerService({
    root,
    principal: { hostKind: "codex", threadId: THREAD_A },
    env: fixture.env
  });
  assert.deepEqual(service.listOwned().map((worker) => worker.id), [owned.id]);
  assert.equal(service.get(owned.id).id, owned.id);

  for (const id of [foreign.id, "task-cccccccccccccccc"]) {
    assert.throws(
      () => service.get(id),
      (error) => error?.code === "E_JOB_NOT_FOUND" && error?.message === "Worker was not found."
    );
  }
  assert.throws(
    () => service.eventsAfter(foreign.id, { schemaVersion: 99, workerId: owned.id, sequence: -1 }),
    (error) => error?.code === "E_JOB_NOT_FOUND",
    "ownership must be checked before a foreign cursor is validated"
  );
});

test("worker wait is bounded and reauthorizes every reread", async () => {
  const root = initRepo();
  const missingData = path.join(tempDir("grok-worker-missing-parent-"), "not-created");
  const env = {
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_PLUGIN_DATA: missingData
  };
  const empty = createWorkerService({
    root,
    principal: { hostKind: "codex", threadId: THREAD_A },
    env
  });
  assert.deepEqual(empty.listOwned(), []);
  assert.equal(fs.existsSync(missingData), false, "read path created plugin state");

  const active = record("task-dddddddddddddddd", THREAD_A);
  const cursor = { schemaVersion: 1, workerId: active.id, sequence: 1 };
  let reads = 0;
  const changing = createWorkerService({
    root,
    principal: { hostKind: "codex", threadId: THREAD_A },
    readJob() {
      reads += 1;
      return reads === 1 ? active : { ...active, host: { kind: "codex", sessionId: THREAD_B } };
    },
    listJobs: () => [],
    clock: () => 0,
    sleep: async () => {}
  });
  await assert.rejects(
    changing.wait(active.id, { cursor, timeoutMs: 1 }),
    (error) => error?.code === "E_JOB_NOT_FOUND"
  );
  assert.equal(reads, 2);

  const timed = createWorkerService({
    root,
    principal: { hostKind: "codex", threadId: THREAD_A },
    readJob: () => active,
    listJobs: () => []
  });
  const timeout = await timed.wait(active.id, { cursor, timeoutMs: 0 });
  assert.equal(timeout.timedOut, true);
  assert.deepEqual(timeout.events, []);
  assert.throws(() => timed.result(active.id), (error) => error?.code === "E_JOB_ACTIVE");
});

test("terminal worker reads suppress host-attested verification claims on every surface", async () => {
  const root = initRepo();
  const secret = "xai-private-worker-secret";
  const finished = record("task-eeeeeeeeeeeeeeee", THREAD_A, {
    status: "completed",
    phase: "done",
    completedAt: "2026-07-15T00:01:00.000Z",
    summary: "Host verification: passed",
    progress: "hostVerification passed",
    workspaceRoot: "/private/repository",
    workerProcess: { pid: 12, nonce: secret },
    lifecycleEvents: [{
      type: "checkpoint",
      at: "2026-07-15T00:00:01.000Z",
      summary: "Host-verification passed",
      sequence: 1,
      detail: { authority: "host_asserted", hostVerification: "passed", state: "accepted" }
    }],
    result: {
      workerReport: { outcome: "complete", summary: secret },
      hostVerification: "passed",
      verification: { authority: "host_asserted", outcome: "passed" },
      runtimeEvidence: {
        hostVerification: "passed",
        commandOutcomes: [{ command: "secret command", status: "passed", exitCode: 0 }]
      }
    }
  });
  const service = createWorkerService({
    root,
    principal: { hostKind: "codex", threadId: THREAD_A },
    readJob: () => finished,
    listJobs: () => [finished]
  });
  const surfaces = [
    service.listOwned(),
    service.get(finished.id),
    service.eventsAfter(finished.id),
    await service.wait(finished.id, { timeoutMs: 0 }),
    service.result(finished.id)
  ];
  for (const surface of surfaces) {
    const publicJson = JSON.stringify(surface);
    assert.equal(publicJson.includes("host_asserted"), false);
    for (const claim of [
      "Host verification: passed",
      "hostVerification passed",
      "Host-verification passed"
    ]) assert.equal(publicJson.includes(claim), false, claim);
  }
  const result = surfaces.at(-1);
  const serialized = JSON.stringify(result);
  assert.equal(result.terminal, true);
  assert.equal(serialized.includes("workspaceRoot"), false);
  assert.equal(serialized.includes("workerProcess"), false);
  assert.equal(serialized.includes(secret), false);
  assert.equal(result.result.hostVerification, "not_run");
  assert.equal(Object.hasOwn(result.result, "verification"), false);
  assert.equal(Object.hasOwn(result.result, "runtimeEvidence"), false);
  assert.equal(serialized.includes("host_asserted"), false);
  assert.equal(serialized.includes("secret command"), false);
  const events = service.eventsAfter(finished.id);
  assert.equal(JSON.stringify(events).includes("host_asserted"), false);
  assert.equal(JSON.stringify(events).includes('"hostVerification":"passed"'), false);
});

test("worker wait never starts a capability-bound job without the exact current receipt", async () => {
  const root = initRepo();
  const capabilityDigest = "a".repeat(64);
  const active = (state = "pending", boundDigest = capabilityDigest) => (
    record("task-ffffffffffffffff", THREAD_A, {
      status: "running",
      request: {
        spawn: {
          providerCapabilityDigest: boundDigest,
          dispatch: { schemaVersion: 2, state, attemptId: null }
        }
      }
    })
  );
  const cursor = { schemaVersion: 1, workerId: active().id, sequence: 1 };

  const unavailable = [
    ["expired", null],
    ["cleared", null],
    ["binary-drift", null],
    ["digest-drift", "b".repeat(64)]
  ];
  for (const [label, liveDigest] of unavailable) {
    let launches = 0;
    let reconciliations = 0;
    let validations = 0;
    const service = createWorkerService({
      root,
      principal: { hostKind: "codex", threadId: THREAD_A },
      readJob: () => active(),
      listJobs: () => [],
      providerCapabilityDigest: capabilityDigest,
      validateProviderCapability() {
        validations += 1;
        return liveDigest;
      },
      allowUnboundDispatch: false,
      maintain() {
        reconciliations += 1;
      },
      dispatchWorker() {
        launches += 1;
        return { providerLaunchState: "pending", providerLaunched: false };
      }
    });
    const observed = await service.wait(active().id, { cursor, timeoutMs: 0 });
    assert.equal(observed.timedOut, true, label);
    assert.equal(launches, 0, label);
    assert.equal(validations, 2, label);
    assert.equal(reconciliations, 1, label);
  }

  let bindingLaunches = 0;
  const bindingMismatch = createWorkerService({
    root,
    principal: { hostKind: "codex", threadId: THREAD_A },
    readJob: () => active("pending", "b".repeat(64)),
    listJobs: () => [],
    providerCapabilityDigest: capabilityDigest,
    validateProviderCapability: () => capabilityDigest,
    allowUnboundDispatch: false,
    dispatchWorker() {
      bindingLaunches += 1;
      return { providerLaunchState: "pending", providerLaunched: false };
    }
  });
  await bindingMismatch.wait(active().id, { cursor, timeoutMs: 0 });
  assert.equal(bindingLaunches, 0);

  for (const state of ["pending", "claimed"]) {
    let exactLaunches = 0;
    let validations = 0;
    const exact = createWorkerService({
      root,
      principal: { hostKind: "codex", threadId: THREAD_A },
      readJob: () => active(state),
      listJobs: () => [],
      providerCapabilityDigest: capabilityDigest,
      validateProviderCapability() {
        validations += 1;
        return capabilityDigest;
      },
      allowUnboundDispatch: false,
      dispatchWorker() {
        exactLaunches += 1;
        return { providerLaunchState: state, providerLaunched: false };
      }
    });
    await exact.wait(active().id, { cursor, timeoutMs: 0 });
    assert.equal(exactLaunches, 2, state);
    assert.equal(validations, exactLaunches, state);
  }
});

test("worker service closes a broker-to-admission receipt race without durable commit or launch", () => {
  const root = initRepo();
  const fixture = stateFixture(root);
  const capabilityDigest = "a".repeat(64);
  let validations = 0;
  let launches = 0;
  const service = createWorkerService({
    root,
    principal: { hostKind: "codex", threadId: THREAD_A },
    env: fixture.env,
    providerCapabilityDigest: capabilityDigest,
    validateProviderCapability() {
      validations += 1;
      return null;
    },
    allowUnboundDispatch: false,
    dispatchWorker() {
      launches += 1;
      return { providerLaunchState: "pending", providerLaunched: false };
    }
  });

  assert.throws(
    () => service.spawn({
      userRequest: "Receipt vanished after the broker gate",
      idempotencyKey: "service-live-race-0001"
    }),
    (error) => error?.code === "E_CAPABILITY"
  );
  assert.equal(validations, 1);
  assert.equal(launches, 0);
  assert.deepEqual(fs.readdirSync(fixture.jobs), []);
});

test("receipt drift after durable admission leaves a recoverable pending launch outbox", async () => {
  const root = initRepo();
  const fixture = stateFixture(root);
  const capabilityDigest = "a".repeat(64);
  let validations = 0;
  let launches = 0;
  const service = createWorkerService({
    root,
    principal: { hostKind: "codex", threadId: THREAD_A },
    env: fixture.env,
    providerCapabilityDigest: capabilityDigest,
    validateProviderCapability() {
      validations += 1;
      return validations === 1 ? capabilityDigest : null;
    },
    allowUnboundDispatch: false,
    dispatchWorker() {
      launches += 1;
      return { providerLaunchState: "pending", providerLaunched: false };
    }
  });

  const admitted = service.spawn({
    userRequest: "Preserve a committed job if capability clears at launch",
    idempotencyKey: "service-post-commit-race-0001"
  });
  assert.equal(validations, 2);
  assert.equal(launches, 0);
  assert.equal(admitted.replayed, false);
  assert.equal(admitted.providerLaunchState, "pending");
  assert.equal(admitted.providerLaunched, false);

  const pending = tryReadJob(root, admitted.handle.id, fixture.env);
  assert.equal(pending.request.spawn.providerCapabilityDigest, capabilityDigest);
  assert.equal(pending.request.spawn.dispatch.state, "pending");

  let recoveredLaunches = 0;
  const recovered = createWorkerService({
    root,
    principal: { hostKind: "codex", threadId: THREAD_A },
    env: fixture.env,
    providerCapabilityDigest: capabilityDigest,
    validateProviderCapability: () => capabilityDigest,
    allowUnboundDispatch: false,
    dispatchWorker() {
      recoveredLaunches += 1;
      return { providerLaunchState: "pending", providerLaunched: false };
    }
  });
  await recovered.wait(admitted.handle.id, { timeoutMs: 0 });
  assert.ok(recoveredLaunches > 0);
});

test("worker spawn returns a stable admission snapshot while dispatch advances private state", () => {
  const root = initRepo();
  const fixture = stateFixture(root);
  const capabilityDigest = "a".repeat(64);
  let dispatchCalls = 0;
  let successfulClaims = 0;
  const dispatchWorker = ({ workerId, principal, env }) => {
    dispatchCalls += 1;
    const claim = claimWorkerDispatch({ root, workerId, principal, env });
    if (claim.claimed) successfulClaims += 1;
    const launchState = providerLaunchState(claim.job);
    return {
      providerLaunchState: launchState,
      providerLaunched: launchState === "started"
    };
  };
  const service = createWorkerService({
    root,
    principal: { hostKind: "codex", threadId: THREAD_A },
    env: fixture.env,
    providerCapabilityDigest: capabilityDigest,
    validateProviderCapability: () => capabilityDigest,
    allowUnboundDispatch: false,
    dispatchWorker
  });

  const first = service.spawn({
    userRequest: "Capture admission before synchronous dispatch",
    idempotencyKey: "service-stable-admission-0001"
  });
  assert.equal(first.replayed, false);
  assert.equal(first.handle.status, "queued");
  assert.equal(first.handle.phase, "accepted");
  assert.equal(first.handle.eventCursor.sequence, 1);
  assert.equal(first.handle.heartbeatAt, first.handle.createdAt);
  assert.ok(
    Date.parse(first.handle.updatedAt) >= Date.parse(first.handle.createdAt),
    "admission persistence may advance updatedAt beyond the creation heartbeat"
  );
  assert.equal(first.providerLaunchState, "pending");
  assert.equal(first.providerLaunched, false);

  const afterDispatch = tryReadJob(root, first.handle.id, fixture.env);
  assert.equal(afterDispatch.status, "queued");
  assert.equal(afterDispatch.phase, "provider-launching");
  assert.equal(afterDispatch.lifecycleEvents.at(-1).sequence, 2);
  assert.equal(afterDispatch.lifecycleEvents.at(-1).type, "checkpoint");
  assert.equal(
    afterDispatch.lifecycleEvents.at(-1).summary,
    "Worker dispatch claimed"
  );
  assert.equal(afterDispatch.startedAt, null);
  assert.equal(afterDispatch.request.spawn.dispatch.state, "claimed");

  const replay = service.spawn({
    userRequest: "Capture admission before synchronous dispatch",
    idempotencyKey: "service-stable-admission-0001"
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.handle.id, first.handle.id);
  assert.equal(replay.handle.phase, "provider-launching");
  assert.equal(replay.handle.eventCursor.sequence, 2);
  assert.equal(replay.providerLaunchState, "pending");
  assert.equal(replay.providerLaunched, false);
  assert.equal(dispatchCalls, 2);
  assert.equal(successfulClaims, 1, "idempotent replay created a duplicate dispatch claim");
  assert.equal(
    tryReadJob(root, first.handle.id, fixture.env).lifecycleEvents.at(-1).sequence,
    2,
    "idempotent replay appended a duplicate dispatch event"
  );
});

test("MCP advertises only the generic explorer role until runtime role policy exists", () => {
  const advertisedRoles = WORKER_SPAWN_TOOL.inputSchema.properties.roleId.enum;
  assert.deepEqual(advertisedRoles, ["explorer"]);
  for (const hiddenRole of ["implementer", "reviewer", "security", "test"]) {
    assert.equal(advertisedRoles.includes(hiddenRole), false);
  }
  assert.equal(materializeRole("implementer").write, true);

  const root = initRepo();
  const fixture = stateFixture(root);
  const capabilityDigest = "a".repeat(64);
  let launches = 0;
  const service = createWorkerService({
    root,
    principal: { hostKind: "codex", threadId: THREAD_A },
    env: fixture.env,
    providerCapabilityDigest: capabilityDigest,
    validateProviderCapability: () => capabilityDigest,
    allowUnboundDispatch: false,
    dispatchWorker() {
      launches += 1;
      return { providerLaunchState: "pending", providerLaunched: false };
    }
  });

  for (const roleId of advertisedRoles) {
    const admitted = service.spawn({
      userRequest: `Exercise advertised ${roleId} role`,
      idempotencyKey: `advertised-role-${roleId}-0001`,
      roleId
    });
    const stored = tryReadJob(root, admitted.handle.id, fixture.env);
    assert.equal(stored.role.id, roleId);
    assert.equal(stored.role.write, false);
    assert.equal(stored.write, false);
    assert.equal(stored.request.spawn.providerCapabilityDigest, capabilityDigest);
  }
  assert.equal(launches, advertisedRoles.length);
});

test("worker service validates caller envelopes and delegates canonical context rebinding", () => {
  const root = initRepo();
  const fixture = stateFixture(root);
  let dispatches = 0;
  const providerCapabilityDigest = "c".repeat(64);
  const service = createWorkerService({
    root,
    principal: { hostKind: "codex", threadId: THREAD_A },
    env: fixture.env,
    providerCapabilityDigest,
    dispatchWorker() {
      dispatches += 1;
      return { providerLaunchState: "pending", providerLaunched: false };
    }
  });
  const input = buildTaskEnvelope({ userRequest: "Service envelope binding", mode: "read" });
  const admitted = service.spawn({
    envelope: input,
    idempotencyKey: "service-envelope-binding-0001"
  });
  const stored = tryReadJob(root, admitted.handle.id, fixture.env);
  assert.equal(stored.request.envelope.contextManifestId, stored.request.contextManifest.manifestId);
  assert.notEqual(stored.request.envelope.digest, input.digest);
  assert.doesNotThrow(() => assertTaskEnvelope(stored.request.envelope));
  assert.equal(stored.request.spawn.providerCapabilityDigest, providerCapabilityDigest);
  assert.equal(dispatches, 1);

  assert.throws(
    () => service.spawn({
      envelope: { ...input, digest: "f".repeat(64) },
      idempotencyKey: "service-forged-envelope-0001"
    }),
    (error) => error?.code === "E_SCHEMA"
  );
  assert.equal(dispatches, 1);
});

test("WorkerService resolves private decision bindings after owner authorization and starts a grant-bound followup", () => {
  const root = initRepo();
  const fixture = stateFixture(root);
  const parent = awaitingRoleAdmissionParent(root, fixture.env);
  const capabilityDigest = "a".repeat(64);
  let validations = 0;
  let dispatches = 0;
  const service = createWorkerService({
    root,
    principal: parent.principal,
    env: fixture.env,
    providerCapabilityDigest: capabilityDigest,
    validateProviderCapability() {
      validations += 1;
      return capabilityDigest;
    },
    allowUnboundDispatch: false,
    dispatchWorker({ workerId }) {
      dispatches += 1;
      const job = tryReadJob(root, workerId, fixture.env);
      assert.equal(job.request.spawn.dispatch.state, "pending");
      return { providerLaunchState: "pending", providerLaunched: false };
    }
  });
  const decision = service.decideRoleAdmission({
    id: parent.workerId,
    requestId: parent.binding.requestId,
    decision: "grant",
    idempotencyKey: "service-role-decision-0001"
  });
  assert.equal(decision.grant.requestedRoleId, "security");
  assert.equal(Object.hasOwn(decision, "requestDigest"), false);

  const followup = service.followup({
    id: parent.workerId,
    grantId: decision.grant.grantId,
    message: "Perform the bounded security review",
    idempotencyKey: "service-role-followup-0001"
  });
  assert.equal(followup.providerLaunchState, "pending");
  assert.equal(followup.providerLaunched, false);
  assert.equal(dispatches, 1);
  assert.equal(validations, 3);
  const child = tryReadJob(root, followup.handle.id, fixture.env);
  assert.equal(child.role.id, "security");
  assert.equal(child.request.resumeSessionId, FOLLOWUP_SESSION);
  assert.equal(child.request.spawn.providerCapabilityDigest, capabilityDigest);
});

test("WorkerService preserves a committed followup outbox when capability expires at dispatch", () => {
  const root = initRepo();
  const fixture = stateFixture(root);
  const parent = awaitingRoleAdmissionParent(root, fixture.env);
  const capabilityDigest = "b".repeat(64);
  let validations = 0;
  let dispatches = 0;
  const service = createWorkerService({
    root,
    principal: parent.principal,
    env: fixture.env,
    providerCapabilityDigest: capabilityDigest,
    validateProviderCapability() {
      validations += 1;
      return validations <= 2 ? capabilityDigest : null;
    },
    allowUnboundDispatch: false,
    dispatchWorker() {
      dispatches += 1;
      return { providerLaunchState: "pending", providerLaunched: false };
    }
  });
  const decision = service.decideRoleAdmission({
    id: parent.workerId,
    requestId: parent.binding.requestId,
    decision: "grant",
    idempotencyKey: "service-role-decision-race"
  });
  const followup = service.followup({
    id: parent.workerId,
    grantId: decision.grant.grantId,
    message: "Preserve this continuation if readiness expires",
    idempotencyKey: "service-role-followup-race"
  });
  assert.equal(validations, 3);
  assert.equal(dispatches, 0);
  assert.equal(followup.providerLaunchState, "pending");
  assert.equal(
    tryReadJob(root, followup.handle.id, fixture.env).request.spawn.dispatch.state,
    "pending"
  );
});

test("WorkerService does not persist a role decision after provider capability expiry", () => {
  const root = initRepo();
  const fixture = stateFixture(root);
  const parent = awaitingRoleAdmissionParent(root, fixture.env);
  const capabilityDigest = "c".repeat(64);
  const service = createWorkerService({
    root,
    principal: parent.principal,
    env: fixture.env,
    providerCapabilityDigest: capabilityDigest,
    validateProviderCapability: () => null,
    allowUnboundDispatch: false
  });
  assert.throws(
    () => service.decideRoleAdmission({
      id: parent.workerId,
      requestId: parent.binding.requestId,
      decision: "grant",
      idempotencyKey: "service-expired-decision-0001"
    }),
    (error) => error?.code === "E_CAPABILITY"
  );
  const stored = tryReadJob(root, parent.workerId, fixture.env);
  assert.equal(stored.hostAction.decision, null);
  assert.equal(stored.hostAction.grant, null);
});
