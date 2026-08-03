import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { readJob, updateJob } from "../plugins/grok/scripts/lib/state.mjs";
import { buildTaskEnvelope } from "../plugins/grok/scripts/lib/task-contract.mjs";
import { spawnReadOnlyWorker } from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import { installFakeGrok } from "./fake-grok.mjs";
import {
  initRepo,
  runCompanion,
  tempDir,
  testEnvironment
} from "./helpers.mjs";

function parseJson(result) {
  assert.equal(
    result.status,
    0,
    `command failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  return JSON.parse(result.stdout);
}

function brokerFixture() {
  const fake = installFakeGrok(tempDir("fake-grok-companion-recovery-"));
  const threadId = "codex-companion-recovery-session";
  const env = testEnvironment({
    fake,
    pluginData: tempDir("grok-companion-recovery-data-"),
    sessionId: threadId,
    extra: {
      GROK_COMPANION_HOST: "codex",
      GROK_COMPANION_HOST_SESSION_ID: threadId,
      CODEX_THREAD_ID: threadId
    }
  });
  delete env.GROK_COMPANION_CHILD;
  delete env.GROK_COMPANION_JOB_MARKER;
  delete env.GROK_AGENT;
  delete env.GROK_LEADER_SOCKET;
  return { env, threadId };
}

function spawnPendingBrokerJob(root, { env, threadId }) {
  return spawnReadOnlyWorker({
    root,
    principal: { threadId, source: "codex" },
    envelope: buildTaskEnvelope({
      userRequest: "Inspect the repository without writing files.",
      mode: "read"
    }),
    idempotencyKey: "companion-terminal-broker-recovery",
    env
  });
}

test("legacy CLI recovery never mutates terminal broker records", () => {
  const root = fs.realpathSync(initRepo());
  const runtime = brokerFixture();
  const spawned = spawnPendingBrokerJob(root, runtime);
  const id = spawned.handle.id;
  updateJob(root, id, (job) => ({
    ...job,
    status: "completed",
    phase: "done",
    completedAt: new Date().toISOString(),
    progress: "Terminal broker record must remain owner-controlled",
    result: {
      ...(job.result || {}),
      taskRuntimeCleaned: false,
      recoverySentinel: "broker-owner-only"
    }
  }), runtime.env);
  const before = readJob(root, id, runtime.env);

  const status = parseJson(runCompanion(["status", id, "--json"], {
    cwd: root,
    env: runtime.env
  }));

  assert.equal(status.status, "completed");
  assert.deepEqual(readJob(root, id, runtime.env), before);
});
