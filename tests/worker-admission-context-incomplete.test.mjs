import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildTaskEnvelope } from "../plugins/grok/scripts/lib/task-contract.mjs";
import {
  admitWriteWorkerPlan,
  spawnReadOnlyWorker
} from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import { listJobs } from "../plugins/grok/scripts/lib/state.mjs";
import { workspaceState } from "../plugins/grok/scripts/lib/workspace.mjs";
import { initRepo, tempDir } from "./helpers.mjs";
import {
  installOversizeGitHook,
  spawnIdempotencyFile
} from "./worker-mutation-test-helpers.mjs";

const THREAD = "019f666a-6469-7cc1-9a8d-8c1adf61e103";

function principal(root) {
  return {
    hostKind: "codex",
    threadId: THREAD,
    turnId: "019f666e-4084-7902-8447-249f72043a37",
    source: "codex-mcp-stdio",
    pluginId: "grok@grok-companion",
    root,
    mutationCapable: true
  };
}

function environment() {
  const pluginData = tempDir("grok-mutation-data-");
  return {
    HOME: path.dirname(pluginData),
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_PLUGIN_DATA: pluginData
  };
}

function assertAdmissionContextIncomplete(action) {
  assert.throws(
    action,
    (error) => error?.code === "E_CONTEXT_INCOMPLETE"
      && error.details?.contextPhase === "admission"
      && error.details?.metadataComponents?.includes("hooks")
      && !/drifted|different checkout/i.test(error.message)
  );
}

function durableJobFile(root, workerId, env) {
  return path.join(workspaceState(root, env), "jobs", `${workerId}.json`);
}

test("incomplete metadata cannot mutate a read replay or orphan recovery", () => {
  const root = initRepo();
  const env = environment();
  const envelope = buildTaskEnvelope({
    userRequest: "Recover a bounded read admission",
    mode: "read"
  });
  const idempotencyKey = "context-incomplete-read-replay-0001";
  const request = { root, principal: principal(root), envelope, idempotencyKey, env };
  const first = spawnReadOnlyWorker(request);
  const recordFile = spawnIdempotencyFile(root, idempotencyKey, env);
  const jobFile = durableJobFile(root, first.handle.id, env);
  const jobBeforeReplay = fs.readFileSync(jobFile);
  const recordBeforeReplay = fs.readFileSync(recordFile);
  const replayHook = installOversizeGitHook(root, "read-replay");
  try {
    assertAdmissionContextIncomplete(() => spawnReadOnlyWorker(request));
  } finally {
    fs.unlinkSync(replayHook);
  }
  assert.equal(fs.readFileSync(jobFile).equals(jobBeforeReplay), true);
  assert.equal(fs.readFileSync(recordFile).equals(recordBeforeReplay), true);

  fs.unlinkSync(recordFile);
  const jobBeforeOrphan = fs.readFileSync(jobFile);
  const orphanHook = installOversizeGitHook(root, "read-orphan-replay");
  try {
    assertAdmissionContextIncomplete(() => spawnReadOnlyWorker(request));
  } finally {
    fs.unlinkSync(orphanHook);
  }
  assert.equal(fs.existsSync(recordFile), false);
  assert.equal(fs.readFileSync(jobFile).equals(jobBeforeOrphan), true);

  const recovered = spawnReadOnlyWorker(request);
  assert.equal(recovered.replayed, true);
  assert.equal(recovered.handle.id, first.handle.id);
  assert.equal(listJobs(root, env).length, 1);
});

test("incomplete metadata blocks initial read and write admission without residue", () => {
  const root = initRepo();
  const env = environment();
  const hook = installOversizeGitHook(root, "initial-admission");
  try {
    for (const request of [
      {
        envelope: buildTaskEnvelope({
          userRequest: "Reject incomplete read context before admission",
          mode: "read"
        }),
        idempotencyKey: "context-incomplete-read-admission-0001"
      },
      {
        envelope: buildTaskEnvelope({
          userRequest: "Reject incomplete write context before admission",
          mode: "write",
          scope: { include: ["tracked.txt"], exclude: [] }
        }),
        idempotencyKey: "context-incomplete-write-admission-0001",
        roleId: "implementer",
        write: true,
        allowWriteSpawn: true,
        writeLifecycleCapabilityDigest: "c".repeat(64)
      }
    ]) {
      assertAdmissionContextIncomplete(() => spawnReadOnlyWorker({
        root,
        principal: principal(root),
        env,
        ...request
      }));
      assert.equal(
        fs.existsSync(spawnIdempotencyFile(root, request.idempotencyKey, env)),
        false
      );
    }
  } finally {
    fs.unlinkSync(hook);
  }
  assert.equal(listJobs(root, env).length, 0);
});

test("incomplete metadata cannot mutate a write replay or orphan recovery", () => {
  const root = initRepo();
  const env = environment();
  const envelope = buildTaskEnvelope({
    userRequest: "Edit only target.txt",
    mode: "write",
    scope: { include: ["target.txt"], exclude: ["secrets/**"] },
    acceptanceCriteria: ["target.txt contains the requested change"],
    requiredVerification: ["node --test"]
  });
  const idempotencyKey = "context-incomplete-write-replay-0001";
  const writeLifecycleCapabilityDigest = "c".repeat(64);
  const request = {
    root,
    principal: principal(root),
    envelope,
    idempotencyKey,
    roleId: "implementer",
    write: true,
    allowWriteSpawn: true,
    writeLifecycleCapabilityDigest,
    env
  };
  const first = spawnReadOnlyWorker(request);
  const recordFile = spawnIdempotencyFile(root, idempotencyKey, env);
  const jobFile = durableJobFile(root, first.handle.id, env);
  const jobBeforeReplay = fs.readFileSync(jobFile);
  const recordBeforeReplay = fs.readFileSync(recordFile);
  const replayHook = installOversizeGitHook(root, "write-replay");
  try {
    assertAdmissionContextIncomplete(() => spawnReadOnlyWorker(request));
  } finally {
    fs.unlinkSync(replayHook);
  }
  assert.equal(fs.readFileSync(jobFile).equals(jobBeforeReplay), true);
  assert.equal(fs.readFileSync(recordFile).equals(recordBeforeReplay), true);

  fs.unlinkSync(recordFile);
  const jobBeforeOrphan = fs.readFileSync(jobFile);
  const orphanHook = installOversizeGitHook(root, "write-orphan-replay");
  try {
    assertAdmissionContextIncomplete(() => admitWriteWorkerPlan({
      root,
      principal: principal(root),
      envelope,
      idempotencyKey,
      roleId: "implementer",
      allowWriteSpawn: true,
      writeLifecycleCapabilityDigest,
      env
    }));
  } finally {
    fs.unlinkSync(orphanHook);
  }
  assert.equal(fs.existsSync(recordFile), false);
  assert.equal(fs.readFileSync(jobFile).equals(jobBeforeOrphan), true);

  const recovered = admitWriteWorkerPlan({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey,
    roleId: "implementer",
    allowWriteSpawn: true,
    writeLifecycleCapabilityDigest,
    env
  });
  assert.equal(recovered.replayed, true);
  assert.equal(recovered.handle.id, first.handle.id);
  assert.equal(listJobs(root, env).length, 1);
});
