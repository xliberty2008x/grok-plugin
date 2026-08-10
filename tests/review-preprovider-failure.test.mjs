import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
import {
  failedReviewLauncherBlocksForeground,
  shouldWaitAfterFailedReviewLauncher,
  terminalizeCleanLaunchFailure
} from "../plugins/grok/scripts/lib/review-launch-failure.mjs";
import { cleanupReviewEnvironment } from "../plugins/grok/scripts/lib/provider-credentials.mjs";
import { processStartToken } from "../plugins/grok/scripts/lib/process-control.mjs";
import { terminal } from "../plugins/grok/scripts/lib/state.mjs";
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

test("terminalizeCleanLaunchFailure revokes auth under lock before home cleanup", () => {
  const root = initRepo();
  const env = envFixture();
  const nonce = "i".repeat(32);
  const { id } = reviewJobFixture(root, env, {
    status: "running",
    phase: "starting",
    workerAuthorization: nonce
  });
  const state = workspaceState(root, env);
  const home = path.join(state, "review-homes", id);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, "marker"), "live", { mode: 0o600 });

  let sawAuthAfterDecision = "unset";
  let provisionalAfterRevoke = null;
  const outcome = terminalizeCleanLaunchFailure({
    root,
    jobId: id,
    diagnostic: "launcher exit 1",
    env,
    onAfterUnboundDecision(job) {
      sawAuthAfterDecision = job.workerAuthorization;
      // Authorized provisional bind must lose once auth is revoked under lock.
      provisionalAfterRevoke = tryBindProvisionalReviewWorker({
        root,
        jobId: id,
        nonce,
        env
      });
    },
    cleanupReviewHome: () => cleanupReviewEnvironment(state, id)
  });

  assert.equal(outcome.terminalized, true);
  assert.equal(sawAuthAfterDecision, null);
  assert.equal(provisionalAfterRevoke, false);
  assert.equal(fs.existsSync(home), false);
  const stored = readJob(root, id, env);
  assert.equal(stored.status, "failed");
  assert.equal(stored.workerAuthorization, null);
  assert.equal(stored.error?.code, "E_WORKER_LOST");
  assert.equal(stored.result?.providerSessionDeleted, true);
});

test("terminalizeCleanLaunchFailure skips cleanup when worker already bound", () => {
  const root = initRepo();
  const env = envFixture();
  const nonce = "j".repeat(32);
  const startToken = processStartToken(process.pid) || "bound-token";
  const { id } = reviewJobFixture(root, env, {
    status: "running",
    phase: "starting",
    workerAuthorization: null
  });
  // Attach a bound identity after create so commandMarker can use the job id.
  writeJob(root, {
    ...readJob(root, id, env),
    workerProcess: {
      pid: process.pid,
      startToken,
      nonce,
      processGroupId: process.pid,
      commandMarker: id
    }
  }, env);
  const state = workspaceState(root, env);
  const home = path.join(state, "review-homes", id);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, "marker"), "bound", { mode: 0o600 });

  let cleanupCalled = false;
  const outcome = terminalizeCleanLaunchFailure({
    root,
    jobId: id,
    diagnostic: "launcher exit 1 after bind",
    env,
    cleanupReviewHome: () => {
      cleanupCalled = true;
      return cleanupReviewEnvironment(state, id);
    }
  });

  assert.equal(outcome.terminalized, false);
  assert.equal(cleanupCalled, false);
  assert.equal(fs.existsSync(home), true);
  const stored = readJob(root, id, env);
  assert.equal(stored.status, "running");
  assert.equal(stored.workerProcess?.pid, process.pid);
});

test("terminalizeCleanLaunchFailure race: bind before lock leaves home intact", () => {
  // Regression for the outer-read → cleanup → locked-recheck window: if a
  // provisional worker binds before the locked decision, home must not be
  // deleted and the job must not be terminalized as a clean launch failure.
  const root = initRepo();
  const env = envFixture();
  const nonce = "k".repeat(32);
  const { id } = reviewJobFixture(root, env, {
    status: "running",
    phase: "starting",
    workerAuthorization: nonce
  });
  const state = workspaceState(root, env);
  const home = path.join(state, "review-homes", id);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, "marker"), "race", { mode: 0o600 });

  // Simulate the provisional child winning the race before launcher cleanup.
  assert.equal(tryBindProvisionalReviewWorker({ root, jobId: id, nonce, env }), true);
  assert.ok(readJob(root, id, env).workerProcess?.pid);

  let cleanupCalled = false;
  const outcome = terminalizeCleanLaunchFailure({
    root,
    jobId: id,
    diagnostic: "launcher exit after provisional bind",
    env,
    cleanupReviewHome: () => {
      cleanupCalled = true;
      return cleanupReviewEnvironment(state, id);
    }
  });

  assert.equal(outcome.terminalized, false);
  assert.equal(cleanupCalled, false);
  assert.equal(fs.existsSync(home), true);
  const stored = readJob(root, id, env);
  assert.equal(stored.status, "running");
  assert.ok(stored.workerProcess?.pid);
});

test("terminalizeCleanLaunchFailure does not cleanup when bind sneaks after outer observation", () => {
  // Models the old bug order: observe unbound → (bind happens) → cleanup home.
  // The helper must revoke under lock first so a concurrent bind either wins
  // the lock (skip cleanup) or loses auth (cannot bind before cleanup).
  const root = initRepo();
  const env = envFixture();
  const nonce = "l".repeat(32);
  const { id } = reviewJobFixture(root, env, {
    status: "running",
    phase: "starting",
    workerAuthorization: nonce
  });
  const state = workspaceState(root, env);
  const home = path.join(state, "review-homes", id);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, "marker"), "outer", { mode: 0o600 });

  // Outer observation (legacy buggy path) sees no PID.
  const outer = readJob(root, id, env);
  assert.equal(outer.workerProcess?.pid, undefined);

  // Concurrent provisional bind between observation and cleanup decision.
  // Injected via a second writer that races the helper's phase-1 lock: if the
  // helper acquires first, auth is revoked and bind fails; if bind wins, the
  // helper skips cleanup. Either way home is not deleted under a live bind.
  let bindWon = false;
  const outcome = terminalizeCleanLaunchFailure({
    root,
    jobId: id,
    diagnostic: "launcher exit race",
    env,
    onAfterUnboundDecision() {
      // After helper revoked auth: attempt bind (must fail) then try forging
      // a PID as a hostile mid-window mutation would — cleanup already deferred
      // past revoke, so even a forged bind in this hook runs after revoke.
      bindWon = tryBindProvisionalReviewWorker({ root, jobId: id, nonce, env });
    },
    cleanupReviewHome: () => cleanupReviewEnvironment(state, id)
  });

  // Helper won the unbound path (bind after revoke loses).
  assert.equal(bindWon, false);
  assert.equal(outcome.terminalized, true);
  assert.equal(fs.existsSync(home), false);

  // And when bind wins the lock before the helper:
  const { id: id2 } = reviewJobFixture(root, env, {
    status: "running",
    phase: "starting",
    workerAuthorization: "m".repeat(32)
  });
  const home2 = path.join(state, "review-homes", id2);
  fs.mkdirSync(home2, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home2, "marker"), "bound-first", { mode: 0o600 });
  assert.equal(tryBindProvisionalReviewWorker({
    root,
    jobId: id2,
    nonce: "m".repeat(32),
    env
  }), true);
  let cleanup2 = false;
  const outcome2 = terminalizeCleanLaunchFailure({
    root,
    jobId: id2,
    diagnostic: "launcher exit after bind won",
    env,
    cleanupReviewHome: () => {
      cleanup2 = true;
      return cleanupReviewEnvironment(state, id2);
    }
  });
  assert.equal(outcome2.terminalized, false);
  assert.equal(cleanup2, false);
  assert.equal(fs.existsSync(home2), true);
});

test("shouldWaitAfterFailedReviewLauncher only for live bound identity", () => {
  assert.equal(shouldWaitAfterFailedReviewLauncher({
    status: "running",
    workerProcess: { pid: 42 },
    providerProcess: null
  }), true);
  assert.equal(shouldWaitAfterFailedReviewLauncher({
    status: "running",
    workerProcess: null,
    providerProcess: { pid: 7 }
  }), true);
  assert.equal(shouldWaitAfterFailedReviewLauncher({
    status: "running",
    workerProcess: null,
    providerProcess: null
  }), false);
  assert.equal(shouldWaitAfterFailedReviewLauncher({
    status: "failed",
    completedAt: new Date().toISOString(),
    workerProcess: { pid: 42 }
  }), false);
});

test("startJob foreground gate waits when launcher fails after provisional bind", () => {
  // Mirrors startJob's post-launcher control flow: terminalize first, then the
  // foreground throw gate. Bound workers must wait (not E_PROCESS_IDENTITY).
  const root = initRepo();
  const env = envFixture();
  const nonce = "n".repeat(32);
  const { id } = reviewJobFixture(root, env, {
    status: "running",
    phase: "starting",
    workerAuthorization: nonce
  });
  assert.equal(tryBindProvisionalReviewWorker({ root, jobId: id, nonce, env }), true);

  const launcherCode = 1;
  const outcome = terminalizeCleanLaunchFailure({
    root,
    jobId: id,
    diagnostic: "captureSpawnIdentity failed after bind",
    env,
    cleanupReviewHome: () => {
      throw new Error("cleanup must not run for bound workers");
    }
  });
  assert.equal(outcome.terminalized, false);

  const finished = readJob(root, id, env);
  assert.equal(terminal(finished), false);
  assert.equal(shouldWaitAfterFailedReviewLauncher(finished), true);
  assert.equal(failedReviewLauncherBlocksForeground(finished, launcherCode), false);
  assert.equal(failedReviewLauncherBlocksForeground({
    status: "running",
    workerProcess: null,
    providerProcess: null
  }, 1), true);

  // Companion startJob uses the shared foreground gate (not a local reimplementation).
  const companion = fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../plugins/grok/scripts/grok-companion.mjs"
    ),
    "utf8"
  );
  assert.match(companion, /failedReviewLauncherBlocksForeground\(finished, launcherCode\)/);
});
