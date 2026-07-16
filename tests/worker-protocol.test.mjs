import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_LIFECYCLE_EVENTS,
  appendLifecycleEvent,
  normalizeLifecycleEventSequences
} from "../plugins/grok/scripts/lib/task-contract.mjs";
import {
  WORKER_EVENT_CURSOR_SCHEMA_VERSION,
  WORKER_HANDLE_SCHEMA_VERSION,
  WORKER_PROTOCOL_VERSION,
  WORKER_SNAPSHOT_SCHEMA_VERSION,
  projectLifecycleEventsAfterCursor,
  projectWorkerHandle,
  projectWorkerLifecycleCursor,
  projectWorkerSnapshot
} from "../plugins/grok/scripts/lib/worker-protocol.mjs";
import { initRepo, runCompanion, tempDir } from "./helpers.mjs";

function lifecycle(type, summary, sequence = undefined) {
  return {
    type,
    at: "2026-07-15T00:00:00.000Z",
    summary,
    ...(sequence === undefined ? {} : { sequence })
  };
}

function job(overrides = {}) {
  return {
    schemaVersion: 3,
    id: "task-worker-protocol",
    kind: "task",
    jobClass: "task",
    write: false,
    status: "running",
    phase: "executing",
    summary: "Running",
    progress: "Reading files",
    createdAt: "2026-07-15T00:00:00.000Z",
    startedAt: "2026-07-15T00:00:01.000Z",
    updatedAt: "2026-07-15T00:00:02.000Z",
    completedAt: null,
    heartbeatAt: "2026-07-15T00:00:02.000Z",
    profile: {
      id: "rescue-read-v3",
      contractVersion: 3,
      agentProfileDigest: "a".repeat(64)
    },
    model: "grok-test",
    effort: "high",
    latestPlan: ["Inspect the protocol"],
    lifecycleEvents: [lifecycle("task.accepted", "Accepted", 1)],
    request: null,
    result: null,
    error: null,
    ...overrides
  };
}

test("lifecycle append assigns durable monotonic sequences and normalizes legacy events", () => {
  const legacy = [
    lifecycle("task.accepted", "Accepted"),
    lifecycle("checkpoint", "Legacy checkpoint"),
    lifecycle("activity.started", "Existing sequence", 9),
    lifecycle("activity.completed", "Duplicate sequence", 9)
  ];
  const normalized = normalizeLifecycleEventSequences(legacy);

  assert.deepEqual(normalized.map((event) => event.sequence), [1, 2, 9, 10]);
  assert.equal(Object.hasOwn(legacy[0], "sequence"), false, "legacy input was mutated");

  const appended = appendLifecycleEvent(normalized, "checkpoint", "Restart-safe append", {
    apiKey: "secret-value"
  });
  assert.deepEqual(appended.map((event) => event.sequence), [1, 2, 9, 10, 11]);
  assert.equal(appended.at(-1).detail.apiKey, "[REDACTED]");

  const persisted = JSON.parse(JSON.stringify(appended));
  const afterRestart = appendLifecycleEvent(persisted, "checkpoint", "After restart");
  assert.equal(afterRestart.at(-1).sequence, 12);

  const unsafe = normalizeLifecycleEventSequences([
    lifecycle("checkpoint", "Unsafe persisted sequence", Number.MAX_SAFE_INTEGER + 1)
  ]);
  assert.equal(unsafe[0].sequence, 1);
  assert.throws(
    () => appendLifecycleEvent([
      lifecycle("checkpoint", "Exhausted sequence", Number.MAX_SAFE_INTEGER)
    ], "checkpoint", "Cannot append"),
    (error) => error?.code === "E_STATE"
  );
});

test("lifecycle retention stays bounded and cursor projection reports replay gaps", () => {
  let events = [];
  for (let index = 1; index <= MAX_LIFECYCLE_EVENTS + 12; index += 1) {
    events = appendLifecycleEvent(events, "checkpoint", `Event ${index}`);
  }

  assert.equal(events.length, MAX_LIFECYCLE_EVENTS);
  assert.equal(events[0].sequence, 13);
  assert.equal(events.at(-1).sequence, MAX_LIFECYCLE_EVENTS + 12);

  const fromStart = projectLifecycleEventsAfterCursor(events, 0, { terminal: false });
  assert.equal(fromStart.workerProtocolVersion, WORKER_PROTOCOL_VERSION);
  assert.equal(fromStart.eventCursorSchemaVersion, WORKER_EVENT_CURSOR_SCHEMA_VERSION);
  assert.equal(fromStart.firstAvailableSequence, 13);
  assert.equal(fromStart.latestAvailableSequence, MAX_LIFECYCLE_EVENTS + 12);
  assert.equal(fromStart.firstAvailableCursor, 12);
  assert.equal(fromStart.gap, true);
  assert.equal(fromStart.events.length, MAX_LIFECYCLE_EVENTS);
  assert.equal(fromStart.nextCursor, MAX_LIFECYCLE_EVENTS + 12);

  const replay = projectLifecycleEventsAfterCursor(events, fromStart.firstAvailableCursor);
  assert.equal(replay.gap, false);
  assert.equal(replay.events[0].sequence, 13);

  const current = projectLifecycleEventsAfterCursor(events, replay.nextCursor);
  assert.deepEqual(current.events, []);
  assert.equal(current.nextCursor, replay.nextCursor);
});

test("cursor projection rejects invalid or foreign cursors and reports worker terminal state", () => {
  for (const cursor of [-1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => projectLifecycleEventsAfterCursor([], cursor),
      (error) => error?.code === "E_USAGE"
    );
  }

  assert.throws(
    () => projectLifecycleEventsAfterCursor([lifecycle("checkpoint", "Only event", 1)], 2),
    (error) => error?.code === "E_USAGE"
      && error?.details?.latestAvailableSequence === 1
  );
  assert.throws(
    () => projectLifecycleEventsAfterCursor([], 1),
    (error) => error?.code === "E_USAGE"
      && error?.details?.latestAvailableSequence === 0
  );

  const activeJob = job();
  const active = projectWorkerLifecycleCursor(activeJob);
  assert.equal(active.terminal, false);
  assert.deepEqual(active.nextCursor, {
    schemaVersion: WORKER_EVENT_CURSOR_SCHEMA_VERSION,
    workerId: activeJob.id,
    sequence: 1
  });
  const current = projectWorkerLifecycleCursor(activeJob, active.nextCursor);
  assert.deepEqual(current.events, []);

  const foreignCursor = projectWorkerLifecycleCursor(job({ id: "task-foreign" })).nextCursor;
  assert.throws(
    () => projectWorkerLifecycleCursor(activeJob, foreignCursor),
    (error) => error?.code === "E_USAGE"
  );
  assert.throws(
    () => projectWorkerLifecycleCursor(activeJob, 0),
    (error) => error?.code === "E_USAGE"
  );

  const terminal = projectWorkerLifecycleCursor(job({ status: "completed" }));
  assert.equal(terminal.terminal, true);
});

test("worker handle and snapshot are versioned and omit private runtime fields", () => {
  const secret = "WORKER_PROTOCOL_PRIVATE_CANARY";
  const nestedSecret = "xai-abcdefghijklmnop";
  const privateJob = job({
    status: "completed",
    phase: "done",
    completedAt: "2026-07-15T00:01:00.000Z",
    latestPlan: [`Inspect with ${nestedSecret}`],
    lifecycleEvents: [{
      ...lifecycle("task.accepted", "Accepted", 1),
      detail: { nested: { authorization: nestedSecret }, note: nestedSecret }
    }],
    host: { kind: "codex", sessionId: secret },
    workspaceRoot: "/private/repository",
    grokSessionId: secret,
    workerProcess: { pid: 123, nonce: secret },
    providerProcess: { pid: 456, startToken: secret },
    credentials: secret,
    request: {
      prompt: secret,
      resumeJobId: "task-parent-public",
      providerHomeId: "task-lineage-public",
      publicObjective: "Public objective",
      envelope: {
        schemaVersion: 1,
        envelopeId: "env-public",
        digest: "digest-public",
        userRequest: secret,
        mode: "read",
        scope: { include: [], exclude: [] },
        nonGoals: [],
        acceptanceCriteria: [],
        requiredVerification: [],
        expectedReturnFormat: "worker report",
        context: { facts: ["public fact", nestedSecret] },
        contextManifestId: "ctx-public"
      },
      contextManifest: {
        manifestId: "ctx-public",
        digest: "context-digest",
        git: { branch: "main", head: "abc", dirtyDigest: "dirty", dirtyEntryCount: 0 },
        projectMarkers: ["package.json"],
        materialization: { state: "local_complete" }
      }
    },
    result: {
      text: secret,
      textBytes: secret.length,
      textDigest: "public-text-digest",
      workerReport: {
        valid: true,
        outcome: "complete",
        summary: "Public report",
        nested: {
          secret: nestedSecret,
          providerProcess: { pid: 456, processGroupId: 456, startToken: secret }
        }
      },
      hostVerification: "not_run"
    },
    error: {
      code: "E_PROCESS_IDENTITY",
      message: "Refusing to signal process 987654.",
      details: {
        pid: 987654,
        nested: {
          processGroupId: 987654,
          startToken: secret,
          nonce: secret,
          sessionId: secret,
          workspaceRoot: "/private/repository",
          token: nestedSecret
        }
      }
    }
  });

  const handle = projectWorkerHandle(privateJob);
  const snapshot = projectWorkerSnapshot(privateJob);
  assert.equal(handle.workerProtocolVersion, WORKER_PROTOCOL_VERSION);
  assert.equal(handle.handleSchemaVersion, WORKER_HANDLE_SCHEMA_VERSION);
  assert.equal(handle.terminal, true);
  assert.equal(handle.parentWorkerId, "task-parent-public");
  assert.equal(handle.lineageWorkerId, "task-lineage-public");
  assert.deepEqual(handle.eventCursor, {
    schemaVersion: WORKER_EVENT_CURSOR_SCHEMA_VERSION,
    workerId: privateJob.id,
    sequence: 1
  });
  assert.equal(handle.taskEnvelopeId, "env-public");
  assert.equal(handle.taskEnvelopeDigest, "digest-public");
  assert.equal(handle.contextManifestId, "ctx-public");
  assert.equal(handle.contextDigest, "context-digest");
  assert.equal(handle.workspaceSnapshotDigest, "context-digest");
  assert.match(handle.hostTaskBinding, /^host-task-[a-f0-9]{32}$/);
  assert.deepEqual(handle.securityProfile, {
    id: "rescue-read-v3",
    contractVersion: 3,
    agentProfileDigest: "a".repeat(64)
  });
  assert.equal(
    projectWorkerHandle({ ...privateJob, id: "task-sibling" }).hostTaskBinding,
    handle.hostTaskBinding,
    "host-task binding should be stable across workers in one host task"
  );
  assert.equal(snapshot.workerProtocolVersion, WORKER_PROTOCOL_VERSION);
  assert.equal(snapshot.snapshotSchemaVersion, WORKER_SNAPSHOT_SCHEMA_VERSION);
  assert.equal(snapshot.taskContract.objective, "Public objective");
  assert.equal(snapshot.result.textDigest, "public-text-digest");
  assert.equal(snapshot.lifecycleEvents[0].sequence, 1);
  assert.equal(snapshot.error.message, "Process ownership verification failed.");
  assert.deepEqual(snapshot.error.details, { nested: { token: "[REDACTED]" } });

  for (const projection of [handle, snapshot]) {
    const serialized = JSON.stringify(projection);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes(nestedSecret), false);
    for (const privateField of ["host", "grokSessionId", "workerProcess", "providerProcess", "credentials", "userRequest", "text"]) {
      assert.equal(Object.hasOwn(projection, privateField), false, `${privateField} leaked at the projection root`);
    }
  }
  assert.equal(JSON.stringify(snapshot).includes("[REDACTED]"), true);
  for (const privateField of ["pid", "processGroupId", "startToken", "nonce", "sessionId", "workspaceRoot"]) {
    assert.equal(JSON.stringify(snapshot).includes(`\"${privateField}\"`), false);
  }
  assert.equal(JSON.stringify(snapshot).includes("987654"), false);

  const compact = projectWorkerSnapshot(privateJob, { detail: false });
  assert.deepEqual(compact.latestPlan, []);
  assert.deepEqual(compact.lifecycleEvents, []);
  assert.equal(compact.taskContract, null);
  assert.equal(compact.context, null);
  assert.equal(compact.result, null);
});

test("CLI public JSON preserves legacy fields and adds Worker Protocol metadata", (t) => {
  // When the test runner itself is nested under Grok, companion refuses CLI entry.
  // Unit projection coverage above still proves the public schema contract.
  if (process.env.GROK_AGENT || process.env.GROK_COMPANION_CHILD || process.env.GROK_COMPANION_JOB_MARKER) {
    t.skip("CLI companion entry is recursion-guarded under nested Grok test runners.");
    return;
  }
  const root = initRepo();
  const env = {
    ...process.env,
    GROK_COMPANION_PLUGIN_DATA: tempDir("worker-protocol-data-"),
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_HOST_SESSION_ID: "worker-protocol-cli",
    CODEX_THREAD_ID: "worker-protocol-cli"
  };
  delete env.GROK_AGENT;
  delete env.GROK_COMPANION_CHILD;
  delete env.GROK_COMPANION_JOB_MARKER;
  delete env.GROK_LEADER_SOCKET;
  const result = runCompanion(["review", "--scope", "working-tree", "--json"], {
    cwd: root,
    env
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.workerProtocolVersion, WORKER_PROTOCOL_VERSION);
  assert.equal(output.snapshotSchemaVersion, WORKER_SNAPSHOT_SCHEMA_VERSION);
  assert.equal(output.schemaVersion, 3);
  assert.equal(output.kind, "review");
  assert.equal(output.jobClass, "review");
  assert.equal(output.write, false);
  assert.equal(output.status, "completed");
  assert.equal(output.phase, "done");
  assert.equal(output.terminal, true);
  assert.equal(output.result.skipped, true);
  assert.equal(output.result.skipReason, "empty-target");
  assert.deepEqual(output.lifecycleEvents, []);
});

test("public snapshot schema matches Worker Protocol fixtures without CLI", () => {
  const snapshot = projectWorkerSnapshot({
    schemaVersion: 3,
    id: "task-cccccccccccccccc",
    kind: "review",
    jobClass: "review",
    write: false,
    status: "completed",
    phase: "done",
    summary: "Skipped",
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    completedAt: "2026-07-16T00:00:00.000Z",
    host: { kind: "codex", sessionId: "019f666a-6469-7cc1-9a8d-8c1adf61e103" },
    lifecycleEvents: [],
    request: null,
    result: { skipped: true, skipReason: "empty-target", hostVerification: "not_run" },
    error: null
  });
  assert.equal(snapshot.workerProtocolVersion, WORKER_PROTOCOL_VERSION);
  assert.equal(snapshot.snapshotSchemaVersion, WORKER_SNAPSHOT_SCHEMA_VERSION);
  assert.equal(snapshot.externalWorkerLabel, "external-grok-worker");
  assert.equal(snapshot.result.skipped, true);
  assert.equal(snapshot.terminal, true);
});
