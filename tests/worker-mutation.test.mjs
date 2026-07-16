import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildTaskEnvelope } from "../plugins/grok/scripts/lib/task-contract.mjs";
import {
  cancelWorker,
  spawnReadOnlyWorker,
  SPAWN_SUCCESS_DEFINITION
} from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import { reconcileOwnedWorkers } from "../plugins/grok/scripts/lib/worker-reconcile.mjs";
import { createWorkerService } from "../plugins/grok/scripts/lib/worker-service.mjs";
import { callWorkerTool, handleMcpRequest } from "../plugins/grok/mcp/broker.mjs";
import { tryReadJob } from "../plugins/grok/scripts/lib/state.mjs";
import { workspaceStateSegment } from "../plugins/grok/scripts/lib/workspace.mjs";
import { initRepo, tempDir } from "./helpers.mjs";

const THREAD = "019f666a-6469-7cc1-9a8d-8c1adf61e103";
const THREAD_B = "019f666b-1e72-74b1-b27c-9d186d7f1016";

function principal(root, overrides = {}) {
  return {
    hostKind: "codex",
    threadId: THREAD,
    turnId: "019f666e-4084-7902-8447-249f72043a37",
    source: "codex-mcp-stdio",
    pluginId: "grok@grok-companion",
    root,
    mutationCapable: true,
    ...overrides
  };
}

function envFor(root) {
  const pluginData = tempDir("grok-mutation-data-");
  return {
    env: {
      HOME: path.dirname(pluginData),
      GROK_COMPANION_HOST: "codex",
      GROK_COMPANION_PLUGIN_DATA: pluginData
    },
    pluginData
  };
}

test("spawn commits durable job without provider launch; retry is idempotent", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({ userRequest: "Inspect package.json", mode: "read" });
  let launches = 0;
  const first = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "spawn-key-0001",
    env,
    providerLaunch: () => { launches += 1; }
  });
  assert.equal(first.replayed, false);
  assert.equal(first.spawnSuccessDefinition, SPAWN_SUCCESS_DEFINITION);
  assert.equal(first.handle.status, "queued");
  assert.equal(first.handle.externalWorkerLabel, "external-grok-worker");
  assert.equal(launches, 1);

  const second = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "spawn-key-0001",
    env,
    providerLaunch: () => { launches += 1; }
  });
  assert.equal(second.replayed, true);
  assert.equal(second.handle.id, first.handle.id);
  assert.equal(launches, 1, "provider launch must not re-run on idempotent retry");

  const job = tryReadJob(root, first.handle.id, env);
  assert.ok(job);
  assert.equal(job.host.sessionId, THREAD);
});

test("write spawn is rejected until allowWriteSpawn is enabled", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({ userRequest: "Edit file", mode: "write" });
  assert.throws(
    () => spawnReadOnlyWorker({
      root,
      principal: principal(root),
      envelope,
      idempotencyKey: "spawn-write-0001",
      write: true,
      env
    }),
    (error) => error?.code === "E_CAPABILITY"
  );
});

test("cancel is idempotent with exactly one cancellation-request event", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({ userRequest: "Long task", mode: "read" });
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "spawn-cancel-0001",
    env
  });
  const first = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: "cancel-key-0001",
    env
  });
  assert.equal(first.replayed, false);
  assert.equal(first.receipt.workerId, spawned.handle.id);
  assert.ok(first.receipt.requestAcceptedAt);

  const second = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: "cancel-key-0001",
    env
  });
  assert.equal(second.replayed, true);
  assert.equal(second.receipt.receiptId, first.receipt.receiptId);

  const job = tryReadJob(root, spawned.handle.id, env);
  const cancelEvents = (job.lifecycleEvents || []).filter((event) => event.type === "cancellation.requested");
  assert.equal(cancelEvents.length, 1);
  assert.equal(job.status, "cancelled");
  assert.equal(job.result.hostVerification, "not_run");
});

test("foreign worker id is observationally equivalent to missing id on cancel", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({ userRequest: "Owned", mode: "read" });
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "spawn-foreign-0001",
    env
  });
  const foreign = principal(root, { threadId: THREAD_B });
  assert.throws(
    () => cancelWorker({
      root,
      principal: foreign,
      workerId: spawned.handle.id,
      idempotencyKey: "cancel-foreign-0001",
      env
    }),
    (error) => error?.code === "E_JOB_NOT_FOUND"
  );
  assert.throws(
    () => cancelWorker({
      root,
      principal: principal(root),
      workerId: "task-ffffffffffffffffffffffffffffffff",
      idempotencyKey: "cancel-missing-0001",
      env
    }),
    (error) => error?.code === "E_JOB_NOT_FOUND"
  );
});

test("reconciler never replays prompts and marks lost processes", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({ userRequest: "Reconcile me", mode: "read" });
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "spawn-reconcile-0001",
    env
  });
  assert.throws(
    () => reconcileOwnedWorkers({
      root,
      principal: principal(root),
      trusted: true,
      replayPrompt: () => {}
    }),
    (error) => error?.code === "E_POLICY"
  );
  assert.throws(
    () => reconcileOwnedWorkers({
      root,
      principal: principal(root),
      trusted: false
    }),
    (error) => error?.code === "E_AUTH_REQUIRED"
  );
  const result = reconcileOwnedWorkers({
    root,
    principal: principal(root),
    trusted: true,
    processAlive: () => false,
    env
  });
  assert.equal(result.replayedPrompt, false);
  assert.ok(result.results.some((item) => item.workerId === spawned.handle.id && item.action === "marked-lost"));
  const job = tryReadJob(root, spawned.handle.id, env);
  assert.equal(job.status, "failed");
  assert.equal(job.result.runtimeEvidence.reconciler.replayedPrompt, false);
  assert.equal(job.result.hostVerification, "not_run");
});

test("spawn with throw after commit still left job on disk (two-step simulation)", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({ userRequest: "Two process", mode: "read" });
  const first = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "spawn-two-proc-0001",
    env
  });
  // Simulate broker restart: new service reads same env/state.
  const service = createWorkerService({
    root,
    principal: principal(root),
    env
  });
  const snapshot = service.get(first.handle.id);
  assert.equal(snapshot.id, first.handle.id);
  assert.equal(snapshot.lifecycleEvents.length >= 1, true);
  // Idempotent spawn after restart returns same worker.
  const replay = service.spawn({
    userRequest: "Two process",
    idempotencyKey: "spawn-two-proc-0001"
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.handle.id, first.handle.id);
});

test("MCP worker_spawn and worker_cancel drive real service functions", async () => {
  const root = initRepo();
  const { env } = envFor(root);
  const auth = principal(root);
  const options = {
    resolveAuthority: () => auth,
    env,
    createService: () => createWorkerService({ root, principal: auth, env })
  };
  const spawned = await callWorkerTool({
    name: "worker_spawn",
    arguments: {
      idempotencyKey: "mcp-spawn-00000001",
      userRequest: "List top-level files"
    }
  }, options);
  assert.equal(spawned.structuredContent.ok, true);
  assert.equal(spawned.structuredContent.providerLaunched, false);
  assert.ok(spawned.structuredContent.worker.id);

  const again = await callWorkerTool({
    name: "worker_spawn",
    arguments: {
      idempotencyKey: "mcp-spawn-00000001",
      userRequest: "List top-level files"
    }
  }, options);
  assert.equal(again.structuredContent.replayed, true);
  assert.equal(again.structuredContent.worker.id, spawned.structuredContent.worker.id);

  const writeRejected = await callWorkerTool({
    name: "worker_spawn",
    arguments: {
      idempotencyKey: "mcp-spawn-write-0001",
      userRequest: "Edit something",
      write: true
    }
  }, options);
  assert.equal(writeRejected.isError, true);
  assert.equal(writeRejected.structuredContent.error.code, "E_CAPABILITY");

  const cancelled = await callWorkerTool({
    name: "worker_cancel",
    arguments: {
      id: spawned.structuredContent.worker.id,
      idempotencyKey: "mcp-cancel-00000001"
    }
  }, options);
  assert.equal(cancelled.structuredContent.ok, true);
  assert.ok(cancelled.structuredContent.receipt.receiptId);

  const cancelAgain = await callWorkerTool({
    name: "worker_cancel",
    arguments: {
      id: spawned.structuredContent.worker.id,
      idempotencyKey: "mcp-cancel-00000001"
    }
  }, options);
  assert.equal(cancelAgain.structuredContent.replayed, true);

  const listed = await callWorkerTool({ name: "worker_list_owned", arguments: {} }, options);
  assert.ok(listed.structuredContent.workers.some((worker) => worker.id === spawned.structuredContent.worker.id));
});

// Fix crash-path test: spawn should commit even if we don't call providerLaunch
test("provider launch failure after durable commit does not delete the job", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({ userRequest: "Launch fail", mode: "read" });
  let threw = false;
  try {
    spawnReadOnlyWorker({
      root,
      principal: principal(root),
      envelope,
      idempotencyKey: "spawn-launch-fail-0001",
      env,
      providerLaunch: () => {
        throw new Error("provider boom");
      }
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, true);
  // Idempotency record may or may not exist depending on order — job must exist if commit-before-launch.
  // Our implementation writes idempotency then launches; if launch throws, job+idempotency remain.
  const replay = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "spawn-launch-fail-0001",
    env
  });
  assert.equal(replay.replayed, true);
  assert.ok(tryReadJob(root, replay.handle.id, env));
});
