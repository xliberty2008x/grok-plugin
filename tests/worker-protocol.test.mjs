import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  LIFECYCLE_EVENT_TYPES,
  MAX_LIFECYCLE_EVENTS,
  appendLifecycleEvent,
  normalizeLifecycleEventSequences
} from "../plugins/grok/scripts/lib/task-contract.mjs";
import {
  WORKER_EVENT_CURSOR_SCHEMA_VERSION,
  WORKER_EVENT_SCHEMA_VERSION,
  WORKER_RESULT_SCHEMA_VERSION,
  WORKER_ERROR_SCHEMA_VERSION,
  WORKER_HANDLE_SCHEMA_VERSION,
  WORKER_PROTOCOL_VERSION,
  WORKER_SNAPSHOT_SCHEMA_VERSION,
  PUBLIC_WORKER_ERROR_CODES,
  normalizeWorkerSnapshot,
  projectLifecycleEvent,
  projectLifecycleEventsAfterCursor,
  projectWorkerHandle,
  projectWorkerLifecycleCursor,
  projectWorkerSnapshot
} from "../plugins/grok/scripts/lib/worker-protocol.mjs";
import { initRepo, runCompanion, tempDir } from "./helpers.mjs";

const PROTOCOL_SCHEMA = JSON.parse(fs.readFileSync(
  new URL("../plugins/grok/schemas/worker-protocol.schema.json", import.meta.url),
  "utf8"
));

function schemaTypeMatches(type, value) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isSafeInteger(value);
  return typeof value === type;
}

function schemaErrors(schema, value, path = "$") {
  if (!schema || Object.keys(schema).length === 0) return [];
  if (schema.$ref) {
    const name = schema.$ref.replace("#/$defs/", "");
    return schemaErrors(PROTOCOL_SCHEMA.$defs[name], value, path);
  }
  if (schema.anyOf) {
    if (schema.anyOf.some((candidate) => schemaErrors(candidate, value, path).length === 0)) return [];
    return [`${path} did not match anyOf`];
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => schemaErrors(candidate, value, path).length === 0).length;
    return matches === 1 ? [] : [`${path} matched ${matches} oneOf branches`];
  }
  if (schema.const !== undefined && value !== schema.const) return [`${path} must equal ${schema.const}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${path} is not in enum`];

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some((type) => schemaTypeMatches(type, value))) {
    return [`${path} has invalid type ${typeof value}`];
  }
  if (value === null) return [];

  const errors = [];
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path} is too short`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path} does not match pattern`);
  }
  if (typeof value === "number" && schema.minimum != null && value < schema.minimum) {
    errors.push(`${path} is below minimum`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path} has too many items`);
    if (schema.items) {
      value.forEach((item, index) => errors.push(...schemaErrors(schema.items, item, `${path}[${index}]`)));
    }
  } else if (value && typeof value === "object") {
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties || {}, key)) errors.push(`${path}.${key} is not allowed`);
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) errors.push(...schemaErrors(childSchema, value[key], `${path}.${key}`));
    }
  }
  return errors;
}

function assertConforms(definition, value) {
  const serialized = JSON.parse(JSON.stringify(value));
  const errors = schemaErrors(PROTOCOL_SCHEMA.$defs[definition], serialized);
  assert.deepEqual(errors, [], `${definition} schema errors:\n${errors.join("\n")}`);
}

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
    id: "task-1111111111111111",
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
  assert.equal(fromStart.events[0].eventSchemaVersion, WORKER_EVENT_SCHEMA_VERSION);
  assert.equal(fromStart.events[0].workerProtocolVersion, WORKER_PROTOCOL_VERSION);
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
  assertConforms("WorkerEventPage", active);
  const current = projectWorkerLifecycleCursor(activeJob, active.nextCursor);
  assert.deepEqual(current.events, []);

  const foreignCursor = projectWorkerLifecycleCursor(job({ id: "task-2222222222222222" })).nextCursor;
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
  assertConforms("WorkerEventPage", { ...terminal, timedOut: false });
});

test("public projections bound text and map unknown errors fail closed", () => {
  const event = projectLifecycleEvent({
    type: "x".repeat(300),
    at: "2026-07-16T00:00:00.000Z",
    summary: "s".repeat(3000),
    sequence: 1
  });
  assert.equal(event.type, "checkpoint");
  assert.equal(event.summary.length, 2000);
  assertConforms("WorkerEvent", event);

  const snapshot = projectWorkerSnapshot(job({
    latestPlan: [...Array.from({ length: 140 }, (_, index) => `step-${index}`), { forged: true }],
    error: {
      code: "E_PRIVATE_INTERNAL",
      message: "m".repeat(3000),
      details: ["arrays are not a public details object"]
    }
  }));
  assert.equal(snapshot.latestPlan.length, 128);
  assert.equal(snapshot.error.code, "E_BROKER");
  assert.equal(snapshot.error.message.length, 2000);
  assert.equal(Object.hasOwn(snapshot.error, "details"), false);
  assertConforms("WorkerSnapshot", snapshot);

  const oversizedEvents = Array.from({ length: MAX_LIFECYCLE_EVENTS + 12 }, (_, index) => (
    lifecycle("checkpoint", `event-${index + 1}`, index + 1)
  ));
  const boundedEvents = projectWorkerSnapshot(job({ lifecycleEvents: oversizedEvents }));
  assert.equal(boundedEvents.lifecycleEvents.length, MAX_LIFECYCLE_EVENTS);
  assert.equal(boundedEvents.lifecycleEvents[0].sequence, 13);
  const boundedPage = projectLifecycleEventsAfterCursor(oversizedEvents, 0);
  assert.equal(boundedPage.events.length, MAX_LIFECYCLE_EVENTS);
  assert.equal(boundedPage.gap, true);
  assertConforms("WorkerEventPage", {
    ...boundedPage,
    workerId: boundedEvents.id,
    nextCursor: boundedEvents.eventCursor,
    firstAvailableCursor: {
      schemaVersion: WORKER_EVENT_CURSOR_SCHEMA_VERSION,
      workerId: boundedEvents.id,
      sequence: 12
    },
    latestAvailableCursor: boundedEvents.eventCursor
  });

  const lost = projectWorkerSnapshot(job({
    status: "failed",
    phase: "failed",
    error: { code: "E_WORKER_LOST", message: "Worker disappeared." }
  }));
  assert.equal(lost.error.code, "E_WORKER_LOST");
  assertConforms("WorkerSnapshot", lost);

  const cleanup = projectWorkerSnapshot(job({
    status: "failed",
    phase: "cleanup-blocked",
    error: {
      code: "E_STATE",
      message: "Cleanup incomplete.",
      details: {
        privacyWarning: "Transient task material remains under /home/alice/private/job.",
        diagnostic: "RAW_DIAGNOSTIC_MUST_NOT_CROSS",
        pid: 1234
      }
    }
  }));
  assert.deepEqual(cleanup.error.details, {
    privacyWarning: "Transient task material remains under [PRIVATE_PATH]"
  });
  assert.equal(JSON.stringify(cleanup).includes("RAW_DIAGNOSTIC_MUST_NOT_CROSS"), false);
  assertConforms("WorkerError", cleanup.error);

  const providerExit = projectWorkerSnapshot(job({
    status: "failed",
    error: {
      code: "E_PROVIDER_EXIT",
      message: "Provider exited.",
      details: { code: 19, signal: "SIGTERM", diagnostic: "private provider output" }
    }
  }));
  assert.deepEqual(providerExit.error.details, { code: 19, signal: "SIGTERM" });
  assertConforms("WorkerError", providerExit.error);
});

test("purported public snapshots are re-projected instead of trusted by version flags", () => {
  const canary = ["gh", "p_", "abcdefghijklmnopqrstuvwxyz", "1234567890"].join("");
  const base = projectWorkerSnapshot(job());
  const normalized = normalizeWorkerSnapshot({
    ...base,
    latestPlan: [`Use ${canary}`],
    lifecycleEvents: [{
      type: "checkpoint",
      at: "2026-07-16T00:00:00.000Z",
      summary: "forged authority",
      sequence: 1,
      detail: { authority: "host_asserted", hostVerification: "passed", state: "accepted" }
    }],
    taskContract: {
      schemaVersion: 1,
      mode: "read",
      context: { upstreamFreshness: "verified" }
    },
    context: {
      schemaVersion: 1,
      upstreamFreshness: "verified",
      materialization: { state: "local_complete", upstreamFreshness: "verified" }
    },
    result: {
      workerProtocolVersion: 1,
      resultSchemaVersion: 1,
      hostVerification: "passed",
      workerReport: { summary: `Leaked ${canary}` },
      runtimeEvidence: { hostVerification: "passed", commandOutcomes: [] },
      verification: {
        outcome: "passed",
        authority: "host_asserted",
        recordedAt: "2026-07-16T00:00:00.000Z",
        observedChangedPaths: []
      },
      arbitraryPrivateField: canary
    },
    arbitraryRootField: canary
  });
  const serialized = JSON.stringify(normalized);
  assert.equal(serialized.includes(canary), false);
  assert.equal(Object.hasOwn(normalized, "arbitraryRootField"), false);
  assert.equal(Object.hasOwn(normalized.result, "arbitraryPrivateField"), false);
  assert.equal(normalized.result.hostVerification, "not_run");
  assert.equal(Object.hasOwn(normalized.result, "runtimeEvidence"), false);
  assert.equal(Object.hasOwn(normalized.result, "verification"), false);
  assert.deepEqual(normalized.lifecycleEvents[0].detail, { state: "accepted" });
  assert.equal(normalized.taskContract.context.upstreamFreshness, "not_checked");
  assert.equal(normalized.context.upstreamFreshness, "not_checked");
  assert.equal(normalized.context.materialization.upstreamFreshness, "not_checked");
  assertConforms("WorkerSnapshot", normalized);
});

test("untrusted cursor projection suppresses host verification authority", () => {
  for (const claim of [
    "Host verification: passed",
    "hostVerification passed",
    "Host-verification passed",
    "Verification by trusted host passed",
    "Host verified"
  ]) {
    const worker = job({
      lifecycleEvents: [{
        type: "checkpoint",
        at: "2026-07-16T00:00:00.000Z",
        summary: claim,
        sequence: 1,
        detail: {
          authority: "host_asserted",
          hostVerification: "passed",
          state: "accepted"
        }
      }]
    });
    const trusted = projectWorkerLifecycleCursor(worker);
    assert.equal(trusted.events[0].summary, claim);
    assert.equal(trusted.events[0].detail.authority, "host_asserted");
    assert.equal(trusted.events[0].detail.hostVerification, "passed");

    const untrusted = projectWorkerLifecycleCursor(worker, null, { trustHostAuthority: false });
    assert.deepEqual(untrusted.events[0].detail, { state: "accepted" });
    assert.equal(untrusted.events[0].summary, null, claim);
    assert.equal(JSON.stringify(untrusted).includes("host_asserted"), false, claim);
    assert.equal(JSON.stringify(untrusted).includes('"hostVerification":"passed"'), false, claim);
  }
});

test("worker handle and snapshot are versioned and omit private runtime fields", () => {
  const secret = "WORKER_PROTOCOL_PRIVATE_CANARY";
  const nestedSecret = "xai-abcdefghijklmnop";
  const githubTokenCanary = ["gh", "p_", "abcdefghijklmnopqrstuvwxyz", "1234567890"].join("");
  const postgresCanary = [
    "post",
    "gresql",
    "://",
    "worker",
    ":",
    "hunter2",
    "@",
    "db.example.test",
    "/app"
  ].join("");
  const broadSecrets = [
    githubTokenCanary,
    "AKIAIOSFODNN7EXAMPLE",
    postgresCanary,
    "password=correct-horse-battery-staple",
    "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----"
  ];
  const privateJob = job({
    status: "completed",
    phase: "done",
    completedAt: "2026-07-15T00:01:00.000Z",
    latestPlan: [`Inspect with ${nestedSecret}`, ...broadSecrets],
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
          notes: broadSecrets,
          providerProcess: { pid: 456, processGroupId: 456, startToken: secret }
        }
      },
      hostVerification: "not_run",
      cancellation: {
        requestAcceptedAt: "2026-07-15T00:00:10.000Z",
        processGroupGoneAt: null,
        terminalRecordCommittedAt: null,
        receiptId: "cancel-public",
        ownerThreadId: secret,
        requestDigest: secret
      }
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
    projectWorkerHandle({ ...privateJob, id: "task-3333333333333333" }).hostTaskBinding,
    handle.hostTaskBinding,
    "host-task binding should be stable across workers in one host task"
  );
  assert.equal(snapshot.workerProtocolVersion, WORKER_PROTOCOL_VERSION);
  assert.equal(snapshot.snapshotSchemaVersion, WORKER_SNAPSHOT_SCHEMA_VERSION);
  assert.equal(snapshot.taskContract.objective, "Public objective");
  assert.equal(snapshot.result.textDigest, "public-text-digest");
  assert.equal(snapshot.result.resultSchemaVersion, WORKER_RESULT_SCHEMA_VERSION);
  assert.equal(snapshot.result.workerProtocolVersion, WORKER_PROTOCOL_VERSION);
  assert.deepEqual(snapshot.result.cancellation, {
    requestAcceptedAt: "2026-07-15T00:00:10.000Z",
    processGroupGoneAt: null,
    terminalRecordCommittedAt: null,
    receiptId: "cancel-public"
  });
  assert.equal(snapshot.lifecycleEvents[0].sequence, 1);
  assert.equal(Object.hasOwn(snapshot.lifecycleEvents[0], "detail"), false);
  assert.equal(snapshot.error.message, "Process ownership verification failed.");
  assert.equal(snapshot.error.errorSchemaVersion, WORKER_ERROR_SCHEMA_VERSION);
  assert.equal(snapshot.error.workerProtocolVersion, WORKER_PROTOCOL_VERSION);
  assert.equal(Object.hasOwn(snapshot.error, "details"), false);
  assert.equal(Object.hasOwn(snapshot.result.workerReport, "nested"), false);
  assertConforms("WorkerHandle", handle);
  assertConforms("WorkerSnapshot", snapshot);

  for (const projection of [handle, snapshot]) {
    const serialized = JSON.stringify(projection);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes(nestedSecret), false);
    for (const broadSecret of broadSecrets) assert.equal(serialized.includes(broadSecret), false);
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

test("task contract, context manifest, and lifecycle detail use bounded public allowlists", () => {
  const canary = "RAW_CONTEXT_CANARY_41f0";
  const privatePath = "/Users/alice/private/repository";
  const snapshot = projectWorkerSnapshot(job({
    lifecycleEvents: [{
      type: "checkpoint",
      at: "2026-07-16T00:00:00.000Z",
      summary: "Safe",
      sequence: 1,
      detail: {
        state: "delivered",
        messageId: "message-public",
        questions: [`\u001b[31mquestion\u202E ${privatePath}`],
        rawDiagnostics: canary,
        nested: { canary }
      }
    }],
    request: {
      publicObjective: `Inspect\u0007 ${privatePath}`,
      resumeJobId: null,
      providerHomeId: "task-1111111111111111",
      envelope: {
        schemaVersion: 1,
        envelopeId: "env-public",
        digest: "a".repeat(64),
        objective: canary,
        userRequest: canary,
        mode: "write",
        scope: {
          include: ["src/**", privatePath, "../outside/**"],
          exclude: ["vendor/**", privatePath],
          raw: canary
        },
        context: {
          facts: ["fact"],
          constraints: ["constraint"],
          expectedProjectMarkers: ["package.json", privatePath],
          requiredPaths: ["src", privatePath],
          workspaceState: "task_scoped",
          upstreamFreshness: "not_checked",
          rawDiagnostics: canary
        },
        nonGoals: ["none"],
        acceptanceCriteria: [{ id: "AC-01", text: "Works", raw: canary }],
        requiredVerification: ["npm test"],
        expectedReturnFormat: "structured",
        contextManifestId: "ctx-public",
        rawDiagnostics: canary
      },
      contextManifest: {
        schemaVersion: 1,
        manifestId: "ctx-public",
        digest: "b".repeat(64),
        capturedAt: "2026-07-16T00:00:00.000Z",
        workspaceRoot: privatePath,
        git: {
          branch: "main",
          head: "c".repeat(40),
          dirtyDigest: "d".repeat(64),
          dirtyEntryCount: 2,
          ignoredDigest: "e".repeat(64),
          ignoredEntryCount: 3,
          trackedTreeIdentity: "f".repeat(64),
          metadataIdentity: "1".repeat(64),
          insideWorktree: true,
          linkedWorktree: false,
          sparse: false,
          shallow: false,
          upstreamRef: "origin/main",
          upstreamCommit: "2".repeat(40),
          upstreamFreshness: "not_checked",
          dirtyEntries: [{ path: privatePath, diagnostic: canary }],
          rawDiagnostics: canary
        },
        projectMarkers: ["package.json", privatePath],
        materialization: {
          state: "local_complete",
          reasons: [],
          submodules: [],
          upstreamFreshness: "not_checked",
          rawDiagnostics: canary
        },
        rawDiagnostics: canary
      }
    }
  }));

  const serialized = JSON.stringify(snapshot);
  for (const forbidden of [canary, privatePath, "\u001b", "\u0007", "\u202E", "workspaceRoot", "dirtyEntries", "rawDiagnostics", "userRequest"]) {
    assert.equal(serialized.includes(forbidden), false, `public snapshot leaked ${JSON.stringify(forbidden)}`);
  }
  assert.equal(snapshot.taskContract.objective.includes("[PRIVATE_PATH]"), true);
  assert.deepEqual(snapshot.taskContract.scope, {
    include: ["src/**"],
    exclude: ["vendor/**"]
  });
  assert.deepEqual(snapshot.taskContract.context.requiredPaths, ["src"]);
  assert.deepEqual(snapshot.context.projectMarkers, ["package.json"]);
  assert.deepEqual(snapshot.lifecycleEvents[0].detail, {
    messageId: "message-public",
    state: "delivered",
    questions: ["question [PRIVATE_PATH]"]
  });
  assertConforms("WorkerSnapshot", snapshot);
});

test("public nested result shapes are exact, bounded, and display-safe", () => {
  const canary = "RAW_DIAGNOSTIC_CANARY_9d4fd6";
  const privatePath = "/Users/alice/private/project/secrets.txt";
  const runtimePaths = [
    "/tmp/grok-job/private.txt",
    "/private/tmp/grok-job/private.txt",
    "/private/var/folders/aa/bb/T/grok-job/private.txt",
    "/var/folders/aa/bb/T/grok-job/private.txt"
  ];
  const unsafeText = `\u001b[31mvisible\u0007\u009B31m\u202E A\rOVER ${privatePath} ${runtimePaths.join(" ")}`;
  const snapshot = projectWorkerSnapshot(job({
    status: "completed",
    phase: "done",
    result: {
      review: {
        verdict: "needs_changes",
        summary: unsafeText,
        findings: [{
          severity: "high",
          title: unsafeText,
          body: `${"b".repeat(7000)} ${privatePath}`,
          file: privatePath,
          line: 7,
          rawDiagnostics: canary
        }],
        rawProviderMessage: canary
      },
      workerReport: {
        schemaVersion: 1,
        structured: true,
        valid: true,
        outcome: "complete",
        summary: unsafeText,
        changedFiles: ["src/index.mjs", privatePath, ...Array.from({ length: 220 }, (_, index) => `src/${index}.mjs`)],
        checksClaimed: Array.from({ length: 80 }, (_, index) => `check ${index}`),
        acceptanceResults: [{ id: "AC-01", status: "met", note: unsafeText, raw: canary }],
        risks: [unsafeText],
        questions: [],
        validationIssues: [],
        nested: { privatePath, rawDiagnostics: canary }
      },
      reportRepair: {
        attempted: true,
        valid: false,
        initialResponse: { bytes: 12, digest: "a".repeat(64), raw: canary },
        validationIssues: [unsafeText],
        error: { code: "E_SCHEMA", message: unsafeText, details: { diagnostic: canary } },
        responseText: canary
      },
      providerClaims: {
        success: true,
        outcome: "complete",
        summary: unsafeText,
        changedFiles: ["src/index.mjs", privatePath],
        checksClaimed: [unsafeText],
        observedFileAgreement: true,
        diagnostic: canary
      },
      runtimeEvidence: {
        schemaVersion: 1,
        preContext: { manifestId: "before", digest: "d".repeat(64), workspaceRoot: privatePath },
        postContext: { manifestId: "after", digest: "e".repeat(64), arbitrary: canary },
        observedChangedPaths: ["src/index.mjs", privatePath],
        diffSummary: unsafeText,
        commandOutcomes: [{ command: `node ${privatePath}`, status: unsafeText, exitCode: 0, stderr: canary }],
        scopeViolations: [privatePath],
        executionStatus: unsafeText,
        hostVerification: "passed",
        rawDiagnostics: canary
      },
      verification: {
        outcome: "passed",
        authority: "host_asserted",
        recordedAt: "2026-07-16T00:00:00.000Z",
        observedChangedPaths: ["src/index.mjs", privatePath],
        commandOutput: canary
      },
      interim: { bytes: 4, digest: "f".repeat(64), text: canary },
      hostVerification: "passed",
      arbitraryResultField: { deep: { deeper: { rawDiagnostics: canary } } }
    },
    error: {
      code: "E_PROVIDER_EXIT",
      message: unsafeText,
      details: { diagnostic: canary, path: privatePath }
    }
  }));

  const serialized = JSON.stringify(snapshot);
  for (const forbidden of ["\u001b", "\u0007", "\u009B", "\u202E", "\r", privatePath, ...runtimePaths, canary]) {
    assert.equal(serialized.includes(forbidden), false, `public projection leaked ${JSON.stringify(forbidden)}`);
  }
  assert.equal(serialized.includes("[PRIVATE_PATH]"), true);
  assert.equal(snapshot.result.review.findings[0].body.length, 6000);
  assert.equal(Object.hasOwn(snapshot.result.review.findings[0], "file"), false);
  assert.equal(snapshot.result.workerReport.changedFiles.length, 200);
  assert.equal(snapshot.result.workerReport.checksClaimed.length, 64);
  assert.deepEqual(snapshot.result.runtimeEvidence.observedChangedPaths, ["src/index.mjs"]);
  assert.deepEqual(snapshot.result.verification.observedChangedPaths, ["src/index.mjs"]);
  assert.deepEqual(Object.keys(snapshot.error).sort(), [
    "code", "errorSchemaVersion", "message", "workerProtocolVersion"
  ]);
  assertConforms("WorkerSnapshot", snapshot);
  assertConforms("WorkerResult", snapshot.result);
  assertConforms("WorkerError", snapshot.error);
});

test("public path projections reject URI-shaped and absolute path disguises", () => {
  const snapshot = projectWorkerSnapshot(job({
    status: "completed",
    phase: "done",
    result: {
      hostVerification: "not_run",
      workerReport: {
        summary: "Completed",
        changedFiles: [
          "src/index.mjs",
          "file:///etc/hosts",
          "./file:///etc/hosts",
          "file:///Volumes/Private/project.txt",
          "https://example.test/source.mjs",
          "././https://example.test/source.mjs",
          ".\\\\file:///etc/hosts",
          "./C:/Users/alice/private.txt",
          "./\\\\server\\share\\private.txt",
          "ssh://host.example/repository/file.mjs"
        ]
      }
    }
  }));

  assert.deepEqual(snapshot.result.workerReport.changedFiles, ["src/index.mjs"]);
  assertConforms("WorkerSnapshot", snapshot);
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

test("published Worker Protocol schema has public roots, versions, and broker error parity", () => {
  const schema = PROTOCOL_SCHEMA;
  assert.ok(Array.isArray(schema.oneOf));
  const roots = new Set(schema.oneOf.map((entry) => entry.$ref));
  for (const name of ["WorkerHandle", "WorkerSnapshot", "WorkerEvent", "WorkerEventPage", "WorkerResult", "WorkerError"]) {
    assert.ok(roots.has(`#/$defs/${name}`), `${name} is not a root validation target`);
  }
  assert.deepEqual(
    [...schema.$defs.publicErrorCode.enum].sort(),
    [...PUBLIC_WORKER_ERROR_CODES].sort()
  );
  for (const [name, versionField] of [
    ["WorkerEvent", "eventSchemaVersion"],
    ["WorkerResult", "resultSchemaVersion"],
    ["WorkerError", "errorSchemaVersion"]
  ]) {
    assert.ok(schema.$defs[name].required.includes("workerProtocolVersion"));
    assert.ok(schema.$defs[name].required.includes(versionField));
  }
  assert.deepEqual(schema.$defs.WorkerEvent.properties.type.enum, LIFECYCLE_EVENT_TYPES);
  assert.equal(schema.$defs.WorkerEvent.properties.detail.$ref, "#/$defs/lifecycleDetail");
  assert.equal(schema.$defs.WorkerSnapshot.properties.taskContract.anyOf[0].$ref, "#/$defs/taskContract");
  assert.equal(schema.$defs.WorkerSnapshot.properties.context.anyOf[0].$ref, "#/$defs/contextManifest");
  for (const [property, definition] of [
    ["review", "review"],
    ["workerReport", "workerReport"],
    ["reportRepair", "reportRepair"],
    ["providerClaims", "providerClaims"],
    ["runtimeEvidence", "runtimeEvidence"],
    ["verification", "verification"],
    ["interim", "textEvidence"]
  ]) {
    assert.equal(schema.$defs.WorkerResult.properties[property].$ref, `#/$defs/${definition}`);
  }
  for (const definition of [
    "lifecycleDetail",
    "review",
    "reviewFinding",
    "workerReport",
    "providerClaims",
    "runtimeEvidence",
    "verification",
    "taskContract",
    "taskContext",
    "contextManifest",
    "errorDetails"
  ]) {
    assert.equal(schema.$defs[definition].additionalProperties, false, `${definition} must remain exact`);
  }
  const projected = projectWorkerSnapshot(job({
    lifecycleEvents: [{
      type: "checkpoint",
      at: "2026-07-16T00:00:00.000Z",
      summary: "Safe",
      sequence: 1,
      detail: { state: "accepted" }
    }],
    request: {
      publicObjective: "Safe objective",
      envelope: {
        schemaVersion: 1,
        envelopeId: "env-public",
        digest: "a".repeat(64),
        mode: "read",
        scope: { include: ["src/**"], exclude: [] },
        context: {},
        nonGoals: [],
        acceptanceCriteria: [],
        requiredVerification: [],
        expectedReturnFormat: "structured",
        contextManifestId: "ctx-public"
      },
      contextManifest: {
        schemaVersion: 1,
        manifestId: "ctx-public",
        digest: "b".repeat(64),
        git: {},
        materialization: {}
      }
    }
  }));
  for (const [path, mutated] of [
    ["WorkerEvent.detail", {
      ...projected.lifecycleEvents[0],
      detail: { ...projected.lifecycleEvents[0].detail, rawDiagnostics: "SCHEMA_CANARY" }
    }],
    ["WorkerSnapshot.taskContract", {
      ...projected,
      taskContract: { ...projected.taskContract, rawPrompt: "SCHEMA_CANARY" }
    }],
    ["WorkerSnapshot.context", {
      ...projected,
      context: { ...projected.context, workspaceRoot: "/private/repository" }
    }]
  ]) {
    const definition = path.startsWith("WorkerEvent") ? "WorkerEvent" : "WorkerSnapshot";
    assert.notDeepEqual(
      schemaErrors(schema.$defs[definition], mutated),
      [],
      `${path} accepted an unknown nested field`
    );
  }
  for (const absolutePath of [
    "/tmp/private.txt",
    "C:/Users/alice/private.txt",
    "C:\\Users\\alice\\private.txt",
    "\\\\server\\share\\private.txt",
    "file:///etc/hosts",
    "./file:///etc/hosts",
    "file:///Volumes/Private/project.txt",
    "https://example.test/source.mjs",
    "././https://example.test/source.mjs",
    ".\\file:///etc/hosts",
    "./C:/Users/alice/private.txt",
    "./\\server\\share\\private.txt",
    "ssh://host.example/repository/file.mjs",
    "../private.txt"
  ]) {
    assert.notDeepEqual(
      schemaErrors(schema.$defs.publicPath, absolutePath),
      [],
      `publicPath schema accepted ${absolutePath}`
    );
  }
});
