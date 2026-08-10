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
  buildReviewPreProviderError,
  tryBindProvisionalReviewWorker,
  reviewLaunchAuthorizationMatches
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

test("recordReviewPreProviderFailure no-ops without authorization", () => {
  const root = initRepo();
  const env = envFixture();
  const { id } = reviewJobFixture(root, env, { workerAuthorization: "deadbeef".repeat(4) });
  assert.equal(recordReviewPreProviderFailure({
    root,
    jobId: id,
    error: new CompanionError("E_RECURSION", "Unauthenticated"),
    env
  }), null);
  assert.equal(readJob(root, id, env).pendingTerminal, undefined);
});

test("recordReviewPreProviderFailure no-ops for wrong nonce", () => {
  const root = initRepo();
  const env = envFixture();
  const nonce = "a".repeat(32);
  const { id } = reviewJobFixture(root, env, { workerAuthorization: nonce });
  assert.equal(recordReviewPreProviderFailure({
    root,
    jobId: id,
    error: new CompanionError("E_RECURSION", "Unauthenticated"),
    authorization: { nonce: "b".repeat(32), pid: 1, startToken: "x", commandMarker: id },
    env
  }), null);
  assert.equal(readJob(root, id, env).pendingTerminal, undefined);
});

test("recordReviewPreProviderFailure writes pendingTerminal when launch auth matches", () => {
  const root = initRepo();
  const env = envFixture();
  const nonce = "c".repeat(32);
  const { id } = reviewJobFixture(root, env, { workerAuthorization: nonce });
  const written = recordReviewPreProviderFailure({
    root,
    jobId: id,
    error: new CompanionError("E_RECURSION", "Unauthenticated Grok Companion worker invocation refused."),
    authorization: { nonce, pid: process.pid, startToken: "unused", commandMarker: id },
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
  const nonce = "d".repeat(32);
  const { id } = reviewJobFixture(root, env, {
    status: "failed",
    phase: "failed",
    completedAt: now(),
    workerAuthorization: nonce,
    error: { code: "E_CANCELLED", message: "already done" }
  });
  assert.equal(recordReviewPreProviderFailure({
    root,
    jobId: id,
    error: new CompanionError("E_RECURSION", "late write"),
    authorization: { nonce, pid: 1, startToken: "x", commandMarker: id },
    env
  }), null);
  assert.equal(readJob(root, id, env).error.code, "E_CANCELLED");
});

test("recordReviewPreProviderFailure does not replace a different pendingTerminal", () => {
  const root = initRepo();
  const env = envFixture();
  const nonce = "e".repeat(32);
  const existing = {
    status: "failed",
    phase: "failed",
    completedAt: now(),
    error: { code: "E_PROCESS_IDENTITY", message: "first intent wins" },
    summary: "first intent wins"
  };
  const { id } = reviewJobFixture(root, env, {
    workerAuthorization: nonce,
    pendingTerminal: existing
  });
  recordReviewPreProviderFailure({
    root,
    jobId: id,
    error: new CompanionError("E_RECURSION", "second intent"),
    authorization: { nonce, pid: 1, startToken: "x", commandMarker: id },
    env
  });
  const stored = readJob(root, id, env);
  assert.equal(stored.pendingTerminal.error.code, "E_PROCESS_IDENTITY");
});

test("reviewLostWorkerError uses providerProcess not worker startedAt", () => {
  const pre = reviewLostWorkerError({
    startedAt: "2026-08-10T00:00:00.000Z",
    providerProcess: null
  });
  assert.equal(pre.code, "E_WORKER_LOST");
  assert.match(pre.message, /before provider start/i);
  const mid = reviewLostWorkerError({
    startedAt: "2026-08-10T00:00:00.000Z",
    providerProcess: { pid: 1 }
  });
  assert.equal(mid.code, "E_WORKER_LOST");
  assert.doesNotMatch(mid.message, /before provider start/i);
});

test("tryBindProvisionalReviewWorker consumes auth and binds full identity", {
  skip: process.platform === "win32"
}, () => {
  const root = initRepo();
  const env = envFixture();
  const nonce = "f".repeat(32);
  const { id } = reviewJobFixture(root, env, {
    status: "queued",
    workerAuthorization: nonce
  });
  assert.equal(tryBindProvisionalReviewWorker({ root, jobId: id, nonce, env }), true);
  const stored = readJob(root, id, env);
  assert.equal(stored.workerAuthorization, null);
  assert.equal(stored.workerProcess.pid, process.pid);
  assert.ok(stored.workerProcess.startToken);
  assert.equal(stored.workerProcess.nonce, nonce);
  assert.equal(stored.workerProcess.commandMarker, id);
  assert.equal(stored.workerProcess.processGroupId, process.pid);
  assert.equal(
    reviewLaunchAuthorizationMatches(stored, {
      nonce,
      pid: process.pid,
      startToken: stored.workerProcess.startToken,
      commandMarker: id
    }),
    true
  );
});

test("tryBindProvisionalReviewWorker rejects foreign pid and missing auth", () => {
  const root = initRepo();
  const env = envFixture();
  const nonce = "g".repeat(32);
  const foreignMarker = generateId("review");
  const { id } = reviewJobFixture(root, env, {
    workerAuthorization: nonce,
    workerProcess: {
      pid: 1,
      startToken: "foreign",
      nonce,
      processGroupId: 1,
      commandMarker: foreignMarker
    }
  });
  assert.equal(tryBindProvisionalReviewWorker({ root, jobId: id, nonce, env }), false);
  assert.equal(readJob(root, id, env).workerProcess.pid, 1);
  const { id: id2 } = reviewJobFixture(root, env, { workerAuthorization: null });
  assert.equal(tryBindProvisionalReviewWorker({
    root,
    jobId: id2,
    nonce: "h".repeat(32),
    env
  }), false);
});
