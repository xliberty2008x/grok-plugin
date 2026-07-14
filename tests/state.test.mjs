import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  admitJob,
  cancelFile,
  config,
  generateId,
  isCancelRequested,
  listJobs,
  readJob,
  requestCancel,
  retain,
  selectJob,
  setConfig,
  updateJob,
  writeJob
} from "../plugins/grok/scripts/lib/state.mjs";
import { workspaceState } from "../plugins/grok/scripts/lib/workspace.mjs";
import { initRepo, tempDir } from "./helpers.mjs";

function job(id, overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    kind: "task",
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    claudeSessionId: "session-a",
    unknownFutureField: { preserved: true },
    ...overrides
  };
}

test("configuration uses isolated workspace state and atomic private files", () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  const pluginData = tempDir("grok-state-data-");
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    const root = initRepo();
    assert.deepEqual(config(root), {
      schemaVersion: 1,
      stopReviewGate: false,
      disclosureAccepted: false
    });
    const updated = setConfig(root, { stopReviewGate: true, disclosureAccepted: true });
    assert.equal(updated.stopReviewGate, true);
    assert.equal(updated.disclosureAccepted, true);

    const stateRoot = workspaceState(root);
    assert.ok(stateRoot.startsWith(fs.realpathSync(pluginData)));
    const configFile = `${stateRoot}/config.json`;
    assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(stateRoot).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("workspace state refuses symlinked state and lock directories", () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  const pluginData = tempDir("grok-state-data-");
  const outside = tempDir("grok-state-outside-");
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    fs.symlinkSync(outside, `${pluginData}/state`, "dir");
    const root = initRepo();
    assert.throws(
      () => config(root),
      (error) => error?.code === "E_STATE" && /unsafe plugin state directory/.test(error.message)
    );
    fs.unlinkSync(`${pluginData}/state`);

    const stateRoot = workspaceState(root);
    config(root);
    fs.rmSync(`${stateRoot}/locks`, { recursive: true });
    fs.symlinkSync(outside, `${stateRoot}/locks`, "dir");
    assert.throws(
      () => setConfig(root, { disclosureAccepted: true }),
      (error) => error?.code === "E_STATE" && /unsafe plugin state directory/.test(error.message)
    );
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("job IDs are random, path-safe, and records preserve unknown fields", () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tempDir("grok-state-data-");
  try {
    const root = initRepo();
    const first = generateId("task");
    const second = generateId("task");
    assert.match(first, /^task-[a-f0-9]{24}$/);
    assert.notEqual(first, second);

    writeJob(root, job(first));
    updateJob(root, first, (current) => {
      current.summary = "updated";
      return current;
    });
    const stored = readJob(root, first);
    assert.equal(stored.summary, "updated");
    assert.deepEqual(stored.unknownFutureField, { preserved: true });
    assert.equal(fs.statSync(`${workspaceState(root)}/jobs/${first}.json`).mode & 0o777, 0o600);

    assert.throws(
      () => readJob(root, "../../outside"),
      (error) => error.code === "E_USAGE"
    );
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("workspace admission gives write jobs an exclusive lease", () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tempDir("grok-state-data-");
  try {
    const root = initRepo();
    const writer = job(generateId("task"), { status: "running", write: true });
    admitJob(root, writer);
    assert.throws(
      () => admitJob(root, job(generateId("task"), { status: "queued", write: false })),
      (error) => error?.code === "E_JOB_ACTIVE" && error.details?.conflictingJobId === writer.id
    );
    assert.throws(
      () => admitJob(root, job(generateId("task"), { status: "queued", write: true })),
      (error) => error?.code === "E_JOB_ACTIVE"
    );
    updateJob(root, writer.id, (current) => ({ ...current, status: "completed" }));
    assert.doesNotThrow(() => admitJob(root, job(generateId("task"), { status: "queued", write: false })));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("workspace admission serializes continuations that share one provider lineage", () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tempDir("grok-state-data-");
  try {
    const root = initRepo();
    const first = job(generateId("task"), {
      jobClass: "task",
      status: "running",
      write: false,
      request: { providerHomeId: "shared-lineage" }
    });
    admitJob(root, first);
    assert.throws(
      () => admitJob(root, job(generateId("task"), {
        jobClass: "task",
        status: "queued",
        write: false,
        request: { providerHomeId: "shared-lineage" }
      })),
      (error) => error?.code === "E_JOB_ACTIVE"
        && error.details?.conflictingJobId === first.id
        && error.details?.conflictingProviderHomeId === "shared-lineage"
    );
    assert.doesNotThrow(() => admitJob(root, job(generateId("task"), {
      jobClass: "task",
      status: "queued",
      write: false,
      request: { providerHomeId: "independent-lineage" }
    })));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("workspace admission blocks a lineage until terminal task cleanup is complete", () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tempDir("grok-state-data-");
  try {
    const root = initRepo();
    const pending = job(generateId("task"), {
      jobClass: "task",
      status: "completed",
      request: { providerHomeId: "cleanup-pending-lineage" },
      result: { taskRuntimeCleaned: false }
    });
    writeJob(root, pending);
    assert.throws(
      () => admitJob(root, job(generateId("task"), {
        jobClass: "task",
        status: "queued",
        request: { providerHomeId: "cleanup-pending-lineage" }
      })),
      (error) => error?.code === "E_JOB_ACTIVE"
        && error.details?.conflictingJobId === pending.id
        && error.details?.conflictingProviderHomeId === "cleanup-pending-lineage"
    );
    updateJob(root, pending.id, (current) => ({
      ...current,
      result: { ...current.result, taskRuntimeCleaned: true }
    }));
    assert.doesNotThrow(() => admitJob(root, job(generateId("task"), {
      jobClass: "task",
      status: "queued",
      request: { providerHomeId: "cleanup-pending-lineage" }
    })));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("job selection scopes implicit choices by Claude session and status", () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tempDir("grok-state-data-");
  try {
    const root = initRepo();
    const ids = [generateId("task"), generateId("task"), generateId("task")];
    writeJob(root, job(ids[0], { createdAt: "2026-01-03T00:00:00.000Z", status: "running", claudeSessionId: "session-a" }));
    writeJob(root, job(ids[1], { createdAt: "2026-01-02T00:00:00.000Z", status: "completed", claudeSessionId: "session-a" }));
    writeJob(root, job(ids[2], { createdAt: "2026-01-04T00:00:00.000Z", status: "completed", claudeSessionId: "session-b" }));

    assert.equal(selectJob(root, { claudeSessionId: "session-a", active: true }).id, ids[0]);
    assert.equal(selectJob(root, { claudeSessionId: "session-a", finished: true }).id, ids[1]);
    assert.equal(selectJob(root, { id: ids[2], claudeSessionId: "session-a" }).id, ids[2]);
    assert.equal(listJobs(root)[0].id, ids[2]);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("cancellation markers are private and retention keeps active plus newest terminal jobs", () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tempDir("grok-state-data-");
  try {
    const root = initRepo();
    const activeId = generateId("task");
    writeJob(root, job(activeId, { status: "running", createdAt: "2026-01-05T00:00:00.000Z" }));
    assert.throws(
      () => requestCancel(root, activeId),
      (error) => error.code === "E_PROCESS_IDENTITY" && /nonce/i.test(error.message)
    );
    assert.equal(fs.existsSync(cancelFile(root, activeId)), false);

    requestCancel(root, activeId, "nonce-value");
    assert.equal(isCancelRequested(root, activeId, "nonce-value"), true);
    assert.equal(isCancelRequested(root, activeId, "wrong-nonce"), false);
    assert.equal(isCancelRequested(root, activeId, ""), false);
    assert.equal(isCancelRequested(root, activeId), false);
    assert.equal(fs.readFileSync(cancelFile(root, activeId), "utf8"), "nonce-value\n");
    assert.equal(fs.statSync(cancelFile(root, activeId)).mode & 0o777, 0o600);

    const terminalIds = [];
    for (let index = 0; index < 4; index += 1) {
      const id = generateId("task");
      terminalIds.push(id);
      writeJob(root, job(id, { createdAt: `2026-01-0${4 - index}T00:00:00.000Z` }));
    }
    retain(root, 3);
    const retained = listJobs(root);
    assert.equal(retained.length, 3);
    assert.ok(retained.some((item) => item.id === activeId));
    assert.deepEqual(
      retained.filter((item) => item.status === "completed").map((item) => item.id),
      terminalIds.slice(0, 2)
    );
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("retain never prunes unclean review or task jobs while empty-target skips stay eligible", () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tempDir("grok-state-data-");
  try {
    const root = initRepo();
    const uncleanId = generateId("review");
    const uncleanTaskId = generateId("task");
    const emptyTargetId = generateId("review");
    const normalId = generateId("task");

    // Unclean review: providerSessionDeleted false and not empty-target → permanent retention.
    writeJob(root, job(uncleanId, {
      kind: "review",
      jobClass: "review",
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      result: {
        review: { verdict: "pass", summary: "fixture", findings: [] },
        providerSessionDeleted: false,
        privacyWarning: "Isolated review home retained"
      }
    }));
    writeJob(root, job(uncleanTaskId, {
      jobClass: "task",
      status: "failed",
      createdAt: "2026-01-01T12:00:00.000Z",
      result: {
        taskRuntimeCleaned: false,
        privacyWarning: "Task runtime artifacts retained"
      }
    }));
    // Empty-target skip uses the same providerSessionDeleted flag but remains eligible for prune.
    writeJob(root, job(emptyTargetId, {
      kind: "review",
      jobClass: "review",
      status: "completed",
      createdAt: "2026-01-02T00:00:00.000Z",
      result: {
        review: { verdict: "pass", summary: "No changes in the selected review target.", findings: [] },
        providerSessionDeleted: false,
        skipped: true,
        skipReason: "empty-target"
      }
    }));
    writeJob(root, job(normalId, {
      status: "completed",
      createdAt: "2026-01-03T00:00:00.000Z"
    }));

    // Keep one terminal slot: newest eligible terminal job survives; unclean is never eligible.
    retain(root, 1);
    const retained = listJobs(root);
    const retainedIds = new Set(retained.map((item) => item.id));
    assert.equal(retainedIds.has(uncleanId), true, "unclean review with providerSessionDeleted false must never be pruned");
    assert.equal(retainedIds.has(uncleanTaskId), true, "unclean task with taskRuntimeCleaned false must never be pruned");
    assert.equal(retainedIds.has(normalId), true, "newest normal terminal job fills the retention limit");
    assert.equal(retainedIds.has(emptyTargetId), false, "empty-target skip remains eligible for normal terminal pruning");
    assert.equal(retained.length, 3);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});
