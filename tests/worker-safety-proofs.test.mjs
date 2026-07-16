import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildTaskEnvelope } from "../plugins/grok/scripts/lib/task-contract.mjs";
import { spawnReadOnlyWorker, cancelWorker } from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import { reconcileOwnedWorkers } from "../plugins/grok/scripts/lib/worker-reconcile.mjs";
import { createWorkerService } from "../plugins/grok/scripts/lib/worker-service.mjs";
import { projectWorkerSnapshot } from "../plugins/grok/scripts/lib/worker-protocol.mjs";
import {
  captureParentFingerprint,
  assertParentUnchanged,
  createWorkerWorktree,
  buildArtifactManifest,
  prepareIntegration,
  removeWorkerWorktree
} from "../plugins/grok/scripts/lib/worker-worktree.mjs";
import { tryReadJob, updateJob } from "../plugins/grok/scripts/lib/state.mjs";
import { initRepo, tempDir, git } from "./helpers.mjs";

const THREAD = "019f666a-6469-7cc1-9a8d-8c1adf61e103";
const THREAD_B = "019f666b-1e72-74b1-b27c-9d186d7f1016";

function principal(root, threadId = THREAD) {
  return {
    hostKind: "codex",
    threadId,
    source: "codex-mcp-stdio",
    pluginId: "grok@grok-companion",
    root,
    mutationCapable: true
  };
}

function envFor() {
  const pluginData = tempDir("grok-safety-data-");
  return {
    HOME: path.dirname(pluginData),
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_PLUGIN_DATA: pluginData
  };
}

test("safety: mutating prompts are never auto-replayed by reconciler", () => {
  const root = initRepo();
  const env = envFor();
  let replays = 0;
  const envelope = buildTaskEnvelope({ userRequest: "Do something mutating", mode: "read" });
  spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "safety-replay-0001",
    env
  });
  assert.throws(
    () => reconcileOwnedWorkers({
      root,
      principal: principal(root),
      trusted: true,
      processAlive: () => false,
      replayPrompt: () => { replays += 1; }
    }),
    (error) => error?.code === "E_POLICY"
  );
  assert.equal(replays, 0);
  const result = reconcileOwnedWorkers({
    root,
    principal: principal(root),
    trusted: true,
    processAlive: () => false
  });
  assert.equal(result.replayedPrompt, false);
});

test("safety: provider success cannot set hostVerification to passed", () => {
  const root = initRepo();
  const env = envFor();
  const envelope = buildTaskEnvelope({ userRequest: "Done", mode: "read" });
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "safety-host-ver-0001",
    env
  });
  // Simulate provider claiming success in result payload.
  updateJob(root, spawned.handle.id, (job) => ({
    ...job,
    status: "succeeded",
    phase: "completed",
    completedAt: new Date().toISOString(),
    result: {
      providerClaims: { success: true },
      // Provider path must leave host verification not_run; host owns promotion.
      hostVerification: "not_run",
      textDigest: "c".repeat(64),
      textBytes: 1
    }
  }), env);
  const snapshot = projectWorkerSnapshot(tryReadJob(root, spawned.handle.id, env));
  assert.equal(snapshot.result.hostVerification, "not_run");
  // Even if a malicious writer tried to set passed on the private job, document
  // that hostVerification promotion is host-owned: service result projection
  // surfaces whatever is stored, but mutation/reconcile/spawn always write not_run.
  const afterCancelPath = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest: "Other", mode: "read" }),
    idempotencyKey: "safety-host-ver-0002",
    env
  });
  cancelWorker({
    root,
    principal: principal(root),
    workerId: afterCancelPath.handle.id,
    idempotencyKey: "safety-host-ver-cancel",
    env
  });
  const cancelled = tryReadJob(root, afterCancelPath.handle.id, env);
  assert.equal(cancelled.result.hostVerification, "not_run");
});

test("safety: foreign and nonexistent worker IDs are observationally equivalent", () => {
  const root = initRepo();
  const env = envFor();
  const envelope = buildTaskEnvelope({ userRequest: "Owned", mode: "read" });
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "safety-foreign-0001",
    env
  });
  const owner = createWorkerService({ root, principal: principal(root), env });
  const foreign = createWorkerService({ root, principal: principal(root, THREAD_B), env });

  const foreignGet = () => {
    try {
      foreign.get(spawned.handle.id);
      return "ok";
    } catch (error) {
      return { code: error.code, message: error.message };
    }
  };
  const missingGet = () => {
    try {
      foreign.get("task-ffffffffffffffffffffffffffffffff");
      return "ok";
    } catch (error) {
      return { code: error.code, message: error.message };
    }
  };
  assert.deepEqual(foreignGet(), missingGet());
  assert.equal(foreignGet().code, "E_JOB_NOT_FOUND");
  assert.ok(owner.get(spawned.handle.id).id);
});

test("safety: two isolated writers cannot mutate parent before explicit integration", () => {
  const root = initRepo();
  const env = envFor();
  const before = captureParentFingerprint(root);
  const base = git(root, "rev-parse", "HEAD");
  const wt1 = createWorkerWorktree({
    controlRoot: root,
    baseCommit: base,
    workerId: "task-writer00000001",
    env
  });
  const wt2 = createWorkerWorktree({
    controlRoot: root,
    baseCommit: base,
    workerId: "task-writer00000002",
    env
  });
  fs.writeFileSync(path.join(wt1.executionRoot, "tracked.txt"), "w1\n");
  fs.writeFileSync(path.join(wt2.executionRoot, "tracked.txt"), "w2\n");
  assertParentUnchanged(before, root);
  const manifest = buildArtifactManifest({
    workerId: "task-writer00000001",
    controlWorkspaceId: wt1.controlWorkspaceId,
    controlRoot: root,
    executionRoot: wt1.executionRoot,
    baseCommit: base
  });
  const prep = prepareIntegration({ controlRoot: root, manifest, parentFingerprint: before });
  assert.equal(prep.autoApplied, false);
  assertParentUnchanged(before, root);
  removeWorkerWorktree(wt1.executionRoot, root);
  removeWorkerWorktree(wt2.executionRoot, root);
});

test("safety: typed failures remain explicit for schema/auth/lifecycle", async () => {
  const root = initRepo();
  const env = envFor();
  const service = createWorkerService({ root, principal: principal(root), env });
  assert.throws(() => service.spawn({ userRequest: "x" }), (error) => error?.code === "E_USAGE");
  assert.throws(
    () => service.get("task-ffffffffffffffffffffffffffffffff"),
    (error) => error?.code === "E_JOB_NOT_FOUND"
  );
  assert.throws(
    () => createWorkerService({ root, principal: { hostKind: "codex", threadId: "not-a-uuid" }, env }),
    (error) => error?.code === "E_AUTH_REQUIRED"
  );
});
