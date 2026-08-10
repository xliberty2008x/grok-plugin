import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { CompanionError } from "../plugins/grok/scripts/lib/errors.mjs";
import { generateId, readJob, writeJob, now } from "../plugins/grok/scripts/lib/state.mjs";
import { workspaceState } from "../plugins/grok/scripts/lib/workspace.mjs";
import {
  recordReviewPreProviderFailure,
  reviewLostWorkerError,
  buildReviewPreProviderError
} from "../plugins/grok/scripts/lib/review-preprovider-failure.mjs";
import { initRepo, tempDir, testEnvironment } from "./helpers.mjs";
import { installFakeGrok } from "./fake-grok.mjs";

function envFixture() {
  const fake = installFakeGrok(tempDir("fake-preprovider-"));
  const pluginData = tempDir("preprovider-data-");
  const env = testEnvironment({ fake, pluginData });
  delete env.GROK_COMPANION_CHILD;
  delete env.GROK_COMPANION_JOB_MARKER;
  delete env.GROK_AGENT;
  delete env.GROK_LEADER_SOCKET;
  return env;
}

function reviewJobFixture(root, env, overrides = {}) {
  const id = generateId("review");
  const state = workspaceState(root, env);
  const stamped = now();
  const job = {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: pre-provider fixture",
    summary: "Queued",
    write: false,
    status: "running",
    phase: "queued",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID || "test-session" },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: null,
    updatedAt: stamped,
    completedAt: null,
    workerProcess: null,
    providerProcess: null,
    profile: { id: "review", transport: "headless" },
    model: null,
    effort: null,
    logFile: path.join(state, "jobs", `${id}.log`),
    progress: null,
    request: {
      prompt: "SECRET_PROMPT_SHOULD_NOT_LEAK",
      target: { mode: "working-tree", label: "fixture", base: null }
    },
    result: null,
    error: null,
    ...overrides
  };
  fs.mkdirSync(path.join(state, "jobs"), { recursive: true, mode: 0o700 });
  writeJob(root, job, env);
  fs.writeFileSync(job.logFile, "", { mode: 0o600 });
  return { id, job };
}

test("buildReviewPreProviderError keeps CompanionError code and adds next action", () => {
  const payload = buildReviewPreProviderError(
    new CompanionError("E_RECURSION", "Unauthenticated Grok Companion worker invocation refused.")
  );
  assert.equal(payload.code, "E_RECURSION");
  assert.match(payload.message, /authenticate|authentication|before execution/i);
  assert.match(payload.message, /re-run|status|replay/i);
});

test("buildReviewPreProviderError maps untyped throws to E_PROVIDER_EXIT", () => {
  const payload = buildReviewPreProviderError(new Error("boom"));
  assert.equal(payload.code, "E_PROVIDER_EXIT");
  assert.match(payload.message, /re-run|status|replay/i);
});

test("recordReviewPreProviderFailure writes pendingTerminal and leaves job non-terminal", () => {
  const root = initRepo();
  const env = envFixture();
  const { id } = reviewJobFixture(root, env);
  const written = recordReviewPreProviderFailure({
    root,
    jobId: id,
    error: new CompanionError("E_RECURSION", "Unauthenticated Grok Companion worker invocation refused."),
    env
  });
  assert.equal(written.error.code, "E_RECURSION");
  const stored = readJob(root, id, env);
  assert.equal(stored.status, "running");
  assert.equal(stored.completedAt, null);
  assert.equal(stored.pendingTerminal.status, "failed");
  assert.equal(stored.pendingTerminal.error.code, "E_RECURSION");
  assert.match(stored.pendingTerminal.error.message, /re-run|status|replay/i);
  assert.equal(JSON.stringify(stored.pendingTerminal).includes("SECRET_PROMPT_SHOULD_NOT_LEAK"), false);
});

test("recordReviewPreProviderFailure no-ops when job already terminal", () => {
  const root = initRepo();
  const env = envFixture();
  const { id } = reviewJobFixture(root, env, {
    status: "failed",
    phase: "failed",
    completedAt: now(),
    error: { code: "E_CANCELLED", message: "already done" }
  });
  assert.equal(recordReviewPreProviderFailure({
    root,
    jobId: id,
    error: new CompanionError("E_RECURSION", "late write"),
    env
  }), null);
  assert.equal(readJob(root, id, env).error.code, "E_CANCELLED");
});

test("recordReviewPreProviderFailure does not replace a different pendingTerminal", () => {
  const root = initRepo();
  const env = envFixture();
  const existing = {
    status: "failed",
    phase: "failed",
    completedAt: now(),
    error: { code: "E_PROCESS_IDENTITY", message: "first intent wins" },
    summary: "first intent wins"
  };
  const { id } = reviewJobFixture(root, env, { pendingTerminal: existing });
  recordReviewPreProviderFailure({
    root,
    jobId: id,
    error: new CompanionError("E_RECURSION", "second intent"),
    env
  });
  const stored = readJob(root, id, env);
  assert.equal(stored.pendingTerminal.error.code, "E_PROCESS_IDENTITY");
});

test("reviewLostWorkerError distinguishes pre-provider from mid-run", () => {
  const pre = reviewLostWorkerError({ startedAt: null, providerProcess: null });
  assert.equal(pre.code, "E_WORKER_LOST");
  assert.match(pre.message, /before provider start/i);
  const mid = reviewLostWorkerError({
    startedAt: "2026-08-10T00:00:00.000Z",
    providerProcess: { pid: 1 }
  });
  assert.equal(mid.code, "E_WORKER_LOST");
  assert.doesNotMatch(mid.message, /before provider start/i);
});
