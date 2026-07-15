import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { resolveWorkerAuthority } from "../plugins/grok/scripts/lib/worker-authority.mjs";
import { createWorkerService } from "../plugins/grok/scripts/lib/worker-service.mjs";
import { workspaceStateSegment } from "../plugins/grok/scripts/lib/workspace.mjs";
import { initRepo, tempDir } from "./helpers.mjs";

const THREAD_A = "019f666a-6469-7cc1-9a8d-8c1adf61e103";
const THREAD_B = "019f666b-1e72-74b1-b27c-9d186d7f1016";
const TURN_ID = "019f666e-4084-7902-8447-249f72043a37";

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

test("worker wait is bounded, side-effect-free, and reauthorizes every reread", async () => {
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

test("terminal worker results use the public privacy projection", () => {
  const root = initRepo();
  const secret = "xai-private-worker-secret";
  const finished = record("task-eeeeeeeeeeeeeeee", THREAD_A, {
    status: "completed",
    phase: "done",
    completedAt: "2026-07-15T00:01:00.000Z",
    workspaceRoot: "/private/repository",
    workerProcess: { pid: 12, nonce: secret },
    result: {
      workerReport: { outcome: "complete", summary: secret },
      hostVerification: "passed"
    }
  });
  const service = createWorkerService({
    root,
    principal: { hostKind: "codex", threadId: THREAD_A },
    readJob: () => finished,
    listJobs: () => [finished]
  });
  const result = service.result(finished.id);
  const serialized = JSON.stringify(result);
  assert.equal(result.terminal, true);
  assert.equal(serialized.includes("workspaceRoot"), false);
  assert.equal(serialized.includes("workerProcess"), false);
  assert.equal(serialized.includes(secret), false);
});
