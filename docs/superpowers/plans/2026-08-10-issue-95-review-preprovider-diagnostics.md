# Issue #95 Review Pre-Provider Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a review worker dies before provider start, publish a typed, actionable durable error when the child recorded one; keep generic `E_WORKER_LOST` only for unknown loss; never replay prompts.

**Architecture:** Add a focused helper `recordReviewPreProviderFailure` that writes scrubbed `pendingTerminal` under the job lock. Wire the legacy review `--worker` path to call it before exit on auth and other pre-`execute()` failures. Harden recovery’s generic `E_WORKER_LOST` message for pre-provider vs mid-run when no pending intent exists (recovery already prefers `pendingTerminal.error` for non-task jobs).

**Tech Stack:** Node.js ESM (Node 18+), existing companion job state (`updateJob` / `readJob` / `pendingTerminal`), `node:test` suite.

**Spec:** `docs/superpowers/specs/2026-08-10-issue-95-review-preprovider-diagnostics-design.md`

---

## File map

| Path | Responsibility |
| --- | --- |
| `plugins/grok/scripts/lib/review-preprovider-failure.mjs` | **Create.** Pure helper: map error → scrubbed intent; write `pendingTerminal`; conflict/no-op rules; generic loss message builders |
| `tests/review-preprovider-failure.test.mjs` | **Create.** Unit tests for helper write, no-op, conflict, redaction, message builders |
| `plugins/grok/scripts/grok-companion.mjs` | **Modify.** Import helper; call on review worker auth failure and pre-`execute()` catch; improve `interruptedError` construction for review when pending is absent |
| `tests/runtime.test.mjs` | **Modify.** Integration: auth failure → typed code; pending intent promoted; mid-run regression still green; optional foreground/background parity |
| `docs/superpowers/specs/2026-08-10-issue-95-review-preprovider-diagnostics-design.md` | Reference only (already committed) |

**Out of scope (do not touch):** dispatch-v2 migration, `captureSpawnIdentity` timeouts, deep-research launch, task launch-unsettled path, stderr capture on detached spawn.

---

### Task 1: Unit tests for `recordReviewPreProviderFailure` (TDD red)

**Files:**
- Create: `tests/review-preprovider-failure.test.mjs`
- Create later in Task 2: `plugins/grok/scripts/lib/review-preprovider-failure.mjs`

- [ ] **Step 1: Write failing unit tests**

```js
import assert from "node:assert/strict";
import crypto from "node:crypto";
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
  return { id, state, job };
}

function envFixture() {
  const fake = installFakeGrok(tempDir("fake-preprovider-"));
  const pluginData = tempDir("preprovider-data-");
  const env = testEnvironment({ fake, pluginData });
  delete env.GROK_COMPANION_CHILD;
  delete env.GROK_COMPANION_JOB_MARKER;
  return env;
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
  assert.doesNotMatch(payload.message, /boom.{200,}/); // stays bounded
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
  assert.equal(stored.pendingTerminal.summary, stored.pendingTerminal.error.message);
  // Prompt must not reappear in error/summary after scrub path
  const serialized = JSON.stringify(stored.pendingTerminal);
  assert.equal(serialized.includes("SECRET_PROMPT_SHOULD_NOT_LEAK"), false);
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
  const result = recordReviewPreProviderFailure({
    root,
    jobId: id,
    error: new CompanionError("E_RECURSION", "late write"),
    env
  });
  assert.equal(result, null);
  const stored = readJob(root, id, env);
  assert.equal(stored.error.code, "E_CANCELLED");
  assert.equal(stored.pendingTerminal, undefined);
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
  assert.equal(stored.pendingTerminal.error.message, "first intent wins");
});

test("reviewLostWorkerError distinguishes pre-provider from mid-run", () => {
  const pre = reviewLostWorkerError({ startedAt: null, providerProcess: null });
  assert.equal(pre.code, "E_WORKER_LOST");
  assert.match(pre.message, /before provider start/i);
  assert.match(pre.message, /re-run|status|replay/i);

  const mid = reviewLostWorkerError({
    startedAt: "2026-08-10T00:00:00.000Z",
    providerProcess: { pid: 1 }
  });
  assert.equal(mid.code, "E_WORKER_LOST");
  assert.doesNotMatch(mid.message, /before provider start/i);
  assert.match(mid.message, /replay/i);
});
```

- [ ] **Step 2: Run tests — expect FAIL (module missing)**

```bash
node --test tests/review-preprovider-failure.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `review-preprovider-failure.mjs`.

- [ ] **Step 3: Commit the red tests**

```bash
git add tests/review-preprovider-failure.test.mjs
git commit -m "$(cat <<'EOF'
test: add review pre-provider failure unit coverage for #95

Failing tests lock durable pendingTerminal writes, conflict rules,
and typed loss messages before the helper exists.
EOF
)"
```

---

### Task 2: Implement `review-preprovider-failure.mjs` (TDD green)

**Files:**
- Create: `plugins/grok/scripts/lib/review-preprovider-failure.mjs`
- Test: `tests/review-preprovider-failure.test.mjs`

- [ ] **Step 1: Implement the helper module**

```js
import { CompanionError, asErrorPayload } from "./errors.mjs";
import { redact, redactText, sanitizeDisplayText } from "./redact.mjs";
import { appendLifecycleEvent } from "./task-lifecycle.mjs";
import { updateJob, terminal, now } from "./state.mjs";
import { scrubStoredJob } from "./task-contract.mjs";

const MAX_MESSAGE_CHARS = 1024;

const AUTH_NEXT =
  "Check job status for this review ID; do not expect automatic replay — re-run the review command if needed.";
const GENERIC_NEXT =
  "Inspect this job's status/result, then re-run the review if the failure persists.";
const MID_RUN_NEXT =
  "Inspect job status/result; do not expect automatic replay (prompts are not re-run).";

function clipMessage(text) {
  const cleaned = sanitizeDisplayText(redactText(String(text || "")));
  if (cleaned.length <= MAX_MESSAGE_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_MESSAGE_CHARS - 1)}…`;
}

function withNextAction(cause, nextAction) {
  const base = clipMessage(cause).replace(/\s+/g, " ").trim();
  const next = clipMessage(nextAction).replace(/\s+/g, " ").trim();
  if (!base) return next;
  if (base.includes(next)) return base;
  const joined = `${base}${/[.!?]$/.test(base) ? "" : "."} ${next}`;
  return clipMessage(joined);
}

/**
 * Map a thrown value to a scrubbed public error payload for review pre-provider failures.
 */
export function buildReviewPreProviderError(error) {
  const rawCode = typeof error?.code === "string" && error.code.startsWith("E_")
    ? error.code
    : "E_PROVIDER_EXIT";
  const rawMessage = typeof error?.message === "string" && error.message.trim()
    ? error.message
    : "Review worker failed before provider start";

  let cause = rawMessage;
  if (rawCode === "E_RECURSION"
    || /unauthenticated|stale.*worker|worker invocation refused/i.test(rawMessage)) {
    cause = "Worker could not authenticate before execution";
  }

  const message = withNextAction(cause, AUTH_NEXT);
  const payload = redact(asErrorPayload({
    code: rawCode,
    message,
    ...(error?.details === undefined ? {} : { details: { stage: "pre-provider", ...((error.details && typeof error.details === "object") ? error.details : {}) } })
  }));
  // Keep details optional and tiny: only stage marker if redaction left it.
  if (payload.details && Object.keys(payload.details).length === 0) delete payload.details;
  return {
    code: payload.code || rawCode,
    message: clipMessage(payload.message || message),
    ...(payload.details ? { details: payload.details } : {})
  };
}

/**
 * Generic E_WORKER_LOST when the child left no pendingTerminal.
 */
export function reviewLostWorkerError(jobLike = {}) {
  const preProvider = jobLike.startedAt == null && !jobLike.providerProcess;
  if (preProvider) {
    return {
      code: "E_WORKER_LOST",
      message: withNextAction(
        "The background worker disappeared before provider start; the prompt was not replayed",
        GENERIC_NEXT
      )
    };
  }
  return {
    code: "E_WORKER_LOST",
    message: withNextAction(
      "The background worker disappeared; the prompt was not replayed",
      MID_RUN_NEXT
    )
  };
}

function samePending(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Write scrubbed pendingTerminal for a review pre-provider failure.
 * Leaves the job non-terminal so recovery owns cleanup and final publication.
 * @returns {{ error, pendingTerminal } | null}
 */
export function recordReviewPreProviderFailure({ root, jobId, error, env = process.env }) {
  const intendedError = buildReviewPreProviderError(error);
  const intendedTerminal = {
    status: "failed",
    phase: "failed",
    completedAt: now(),
    error: intendedError,
    summary: intendedError.message
  };

  let recorded = null;
  updateJob(root, jobId, (current) => {
    if (terminal(current)) {
      recorded = null;
      return current;
    }
    if (current.jobClass && current.jobClass !== "review") {
      recorded = null;
      return current;
    }
    if (current.pendingTerminal
      && !samePending(current.pendingTerminal, intendedTerminal)) {
      recorded = {
        error: current.pendingTerminal.error,
        pendingTerminal: current.pendingTerminal
      };
      return current;
    }
    current.pendingTerminal = intendedTerminal;
    current.summary = intendedError.message;
    current.progress = "Review worker failed before provider start; cleanup pending";
    current.lifecycleEvents = appendLifecycleEvent(
      current.lifecycleEvents || [],
      "blocked",
      intendedError.message
    );
    recorded = { error: intendedError, pendingTerminal: intendedTerminal };
    return scrubStoredJob(current);
  }, env);

  return recorded;
}
```

Notes for implementers:
- If `updateJob` / `writeJob` / `readJob` in this repo take `env` only on some call sites, match the local signatures used in nearby modules (`state.mjs`). Prefer the same pattern as other lib helpers that accept optional `env`.
- If `scrubStoredJob` clears `pendingTerminal`, write `pendingTerminal` **after** scrub or re-apply it post-scrub. Verify with the unit test that pending survives. Adjust order to:

```js
const scrubbed = scrubStoredJob(current);
scrubbed.pendingTerminal = intendedTerminal;
scrubbed.summary = intendedError.message;
// ... lifecycle on scrubbed
return scrubbed;
```

- If `appendLifecycleEvent` is not re-exported cleanly from `task-contract.mjs`, import from `task-lifecycle.mjs` as shown.

- [ ] **Step 2: Run unit tests — expect PASS**

```bash
node --test tests/review-preprovider-failure.test.mjs
```

Expected: all tests PASS. Fix scrub/order issues if any fail.

- [ ] **Step 3: Commit**

```bash
git add plugins/grok/scripts/lib/review-preprovider-failure.mjs tests/review-preprovider-failure.test.mjs
git commit -m "$(cat <<'EOF'
feat: record durable review pre-provider failure intent

Add a bounded helper that writes scrubbed pendingTerminal for review
workers and builds typed/actionable loss messages for #95.
EOF
)"
```

---

### Task 3: Wire review `--worker` to record intent before exit

**Files:**
- Modify: `plugins/grok/scripts/grok-companion.mjs` (import near other lib imports; review worker block ~L4940–5091)

- [ ] **Step 1: Add import**

Near the other `./lib/` imports:

```js
import {
  recordReviewPreProviderFailure,
  reviewLostWorkerError
} from "./lib/review-preprovider-failure.mjs";
```

- [ ] **Step 2: Replace bare auth throw with record-then-throw**

In the `--worker` command path, where today:

```js
if (!authorized) throw new CompanionError("E_RECURSION", "Unauthenticated Grok Companion worker invocation refused.");
```

Use:

```js
if (!authorized) {
  const authError = new CompanionError(
    "E_RECURSION",
    "Unauthenticated Grok Companion worker invocation refused."
  );
  // Only review jobs need this durable pre-provider intent for issue #95.
  // Task/broker workers keep their existing settlement paths.
  try {
    const record = readJob(root, id);
    if (record.jobClass === "review") {
      recordReviewPreProviderFailure({ root, jobId: id, error: authError });
    }
  } catch {
    // Best-effort diagnostics; still refuse execution.
  }
  throw authError;
}
```

- [ ] **Step 3: Record on pre-`execute()` failures for review**

Where today:

```js
try {
  await execute(root, id, { dispatchAttemptId, dispatchFence: authorizedFence });
} catch (error) {
  // The executing worker never terminalizes its own still-live process.
  // execute() atomically settles cleanup-safe pre-provider failures; if it
  // could not, the controller/reconciler observes exact process exit and
  // performs loss recovery without replaying the prompt.
  throw error;
}
```

Use:

```js
try {
  await execute(root, id, { dispatchAttemptId, dispatchFence: authorizedFence });
} catch (error) {
  // execute() may already settle cleanup-safe task terminals. For review,
  // ensure a scrubbed pre-provider (or early) intent exists before exit so
  // recovery does not collapse the cause into opaque E_WORKER_LOST.
  try {
    const record = readJob(root, id);
    if (record.jobClass === "review"
      && !terminal(record)
      && !record.providerProcess
      && record.startedAt == null) {
      recordReviewPreProviderFailure({ root, jobId: id, error });
    }
  } catch {
    // Best-effort; preserve original throw.
  }
  throw error;
}
```

Do **not** record after provider has started (`providerProcess` set or `startedAt` set): mid-run failures must keep existing terminal paths / generic loss behavior.

- [ ] **Step 4: Syntax check**

```bash
node --check plugins/grok/scripts/grok-companion.mjs
node --check plugins/grok/scripts/lib/review-preprovider-failure.mjs
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add plugins/grok/scripts/grok-companion.mjs
git commit -m "$(cat <<'EOF'
fix: persist review worker pre-provider failures before exit

Call recordReviewPreProviderFailure on auth refusal and early review
worker throws so recovery can publish a typed cause for #95.
EOF
)"
```

---

### Task 4: Harden recovery generic `E_WORKER_LOST` for review

**Files:**
- Modify: `plugins/grok/scripts/grok-companion.mjs` inside `recoverActiveJobs`, ~L917–924 where `interruptedError` is built

- [ ] **Step 1: Prefer helper for non-research interrupted error**

Replace:

```js
const interruptedError = {
  code: current.jobClass === "research"
    ? "E_WORKFLOW_INCOMPLETE"
    : "E_WORKER_LOST",
  message: current.jobClass === "research"
    ? "The deep-research workflow was interrupted when its worker disappeared; it was not replayed."
    : "The background worker disappeared; the prompt was not replayed."
};
```

With:

```js
const interruptedError = current.jobClass === "research"
  ? {
      code: "E_WORKFLOW_INCOMPLETE",
      message: "The deep-research workflow was interrupted when its worker disappeared; it was not replayed."
    }
  : current.jobClass === "review"
    ? reviewLostWorkerError(current)
    : {
        code: "E_WORKER_LOST",
        message: "The background worker disappeared; the prompt was not replayed."
      };
```

Recall: when `pendingTerminal` exists, the non-task branch already sets `current.error = pending.error` (~L965–967). This change only affects the **no-pending** path.

- [ ] **Step 2: Syntax check**

```bash
node --check plugins/grok/scripts/grok-companion.mjs
```

- [ ] **Step 3: Commit**

```bash
git add plugins/grok/scripts/grok-companion.mjs
git commit -m "$(cat <<'EOF'
fix: make review lost-worker messages stage-aware

Use pre-provider vs mid-run E_WORKER_LOST wording when review recovery
has no pendingTerminal intent (#95).
EOF
)"
```

---

### Task 5: Integration tests (auth failure + pending promotion + regression)

**Files:**
- Modify: `tests/runtime.test.mjs` (add near existing lost-worker review tests ~L4310)

- [ ] **Step 1: Add integration test — worker auth failure records typed intent and recovery promotes it**

```js
test("review worker auth failure records typed pendingTerminal instead of opaque E_WORKER_LOST", {
  skip: process.platform === "win32",
  timeout: 20_000
}, async () => {
  const root = initRepo();
  const { env, pluginData } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const isolatedHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(isolatedHome, "marker"), "pre-auth\n", { mode: 0o600 });
  const stamped = new Date(Date.now() - 60_000).toISOString();
  // Deliberately leave workerProcess null / mismatched so --worker cannot authorize.
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: pre-provider auth fixture",
    summary: "Queued",
    write: false,
    status: "running",
    phase: "queued",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: null,
    updatedAt: stamped,
    completedAt: null,
    workerAuthorization: null,
    workerProcess: null,
    providerProcess: null,
    profile: { id: "review", transport: "headless" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: {
      prompt: "PROMPT_MUST_BE_SCRUBBED_IF_PRESENT",
      target: { mode: "working-tree", label: "fixture", base: null }
    },
    result: null,
    error: null
  });

  const workerEnv = {
    ...env,
    GROK_COMPANION_WORKER_NONCE: crypto.randomBytes(16).toString("hex")
  };
  const worker = runCompanion(
    ["--worker", id, "--cwd", root],
    { cwd: root, env: workerEnv, timeout: 15_000 }
  );
  assert.notEqual(worker.status, 0);

  // Intent should be durable even before status recovery.
  const afterWorker = persistedJob(pluginData, id);
  assert.ok(afterWorker.pendingTerminal, "expected pendingTerminal after auth failure");
  assert.equal(afterWorker.pendingTerminal.error.code, "E_RECURSION");
  assert.match(afterWorker.pendingTerminal.error.message, /re-run|status|replay|authenticate/i);
  assert.equal(afterWorker.startedAt, null);
  assert.equal(afterWorker.providerProcess, null);

  const recovered = await waitFor(() => {
    const result = runCompanion(["status", id, "--json"], { cwd: root, env });
    if (result.status !== 0) return false;
    const job = JSON.parse(result.stdout);
    return job.status === "failed" ? job : false;
  }, { timeoutMs: 15_000 });

  assert.equal(recovered.error.code, "E_RECURSION");
  assert.match(recovered.error.message, /re-run|status|replay|authenticate/i);
  assert.equal(recovered.result?.replay, false);
  assert.equal(fs.existsSync(isolatedHome), false);
  const raw = JSON.stringify(recovered);
  assert.equal(raw.includes("PROMPT_MUST_BE_SCRUBBED_IF_PRESENT"), false);
});
```

If `persistedJob` is not already defined in this file, use the same helper pattern as nearby tests (`persistedJobs` filter by id) or:

```js
function persistedJob(pluginData, id) {
  return persistedJobs(pluginData).find((job) => job.id === id);
}
```

(only add if missing).

- [ ] **Step 2: Add integration test — unknown pre-provider loss keeps E_WORKER_LOST with stage-aware message**

```js
test("review pre-provider silent loss uses stage-aware E_WORKER_LOST", {
  skip: process.platform === "win32"
}, () => {
  const root = initRepo();
  const { env, pluginData } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const isolatedHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(isolatedHome, "marker"), "silent\n", { mode: 0o600 });
  const stamped = new Date(Date.now() - 60_000).toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: silent pre-provider loss",
    summary: "Running",
    write: false,
    status: "running",
    phase: "queued",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: null,
    updatedAt: stamped,
    completedAt: null,
    workerProcess: {
      pid: 999999991,
      startToken: "dead-worker-token",
      nonce: "n",
      processGroupId: 999999991,
      commandMarker: id
    },
    providerProcess: null,
    profile: { id: "review", transport: "headless" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: { prompt: null, target: { mode: "working-tree", label: "fixture", base: null } },
    result: null,
    error: null
  });

  const recovered = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.error.code, "E_WORKER_LOST");
  assert.match(recovered.error.message, /before provider start/i);
  assert.match(recovered.error.message, /re-run|status|replay/i);
  assert.equal(fs.existsSync(isolatedHome), false);
});
```

- [ ] **Step 3: Run focused tests**

```bash
node --test tests/review-preprovider-failure.test.mjs tests/runtime.test.mjs
```

If the full runtime suite is slow, run with a name filter if your Node version supports it, or run the whole file. Expected: new tests PASS; existing `lost-worker recovery terminates headless review...` still PASS (`E_WORKER_LOST` without “before provider start” is OK for mid-run — message may now include mid-run next action).

If the mid-run test asserts exact message equality, update it only to allow the added next-action suffix, **not** a code change:

```js
assert.equal(recovered.error.code, "E_WORKER_LOST");
assert.match(recovered.error.message, /background worker disappeared/i);
assert.doesNotMatch(recovered.error.message, /before provider start/i);
```

- [ ] **Step 4: Commit**

```bash
git add tests/runtime.test.mjs
git commit -m "$(cat <<'EOF'
test: prove review pre-provider diagnostics for #95

Cover typed auth failure promotion, stage-aware silent loss, and keep
mid-run lost-worker recovery fail-closed.
EOF
)"
```

---

### Task 6: Foreground/background contract note + final verification

**Files:**
- Modify: `tests/runtime.test.mjs` only if a second entry path is easy; otherwise document that both paths share job state (same helper + recovery) and the seeded `--worker` test is path-agnostic.

- [ ] **Step 1: Optional compact parity assertion**

If background review can be forced to hit auth failure without flaking, skip inventing a flaky race. The design treats durable job projection as the contract; Task 5’s seeded `--worker` path is the authoritative proof. Add a short comment above the integration test:

```js
// Foreground and background review share durable job state + recovery; this
// fixture exercises the worker entry both launch modes use.
```

- [ ] **Step 2: Full offline checks used for this slice**

```bash
node --check plugins/grok/scripts/lib/review-preprovider-failure.mjs
node --check plugins/grok/scripts/grok-companion.mjs
node --test tests/review-preprovider-failure.test.mjs
node --test tests/runtime.test.mjs
git diff --check
```

Expected: all green; no authenticated Grok run required.

- [ ] **Step 3: Final commit only if comment/docs tweaks remain**

```bash
git add tests/runtime.test.mjs
git commit -m "test: note shared review diagnostic contract for foreground and background"
```

(Skip empty commit if nothing changed.)

---

## Spec coverage checklist

| Spec requirement | Task |
| --- | --- |
| Child writes bounded `pendingTerminal` | Task 1–2, 3 |
| Typed primary code when known (`E_RECURSION`, etc.) | Task 2–3, 5 |
| Untyped → `E_PROVIDER_EXIT` | Task 1–2 |
| Generic `E_WORKER_LOST` only without pending | Task 4–5 |
| Pre-provider vs mid-run unknown-loss wording | Task 2, 4–5 |
| One concrete next action | Task 2 |
| No prompt/credential leakage | Task 1, 5 |
| No automatic replay | Task 5 (`replay: false`) |
| Recovery prefers pending (existing path + write) | Task 3, 5 |
| Mid-run regression green | Task 5 |
| Foreground/background same durable contract | Task 5–6 |
| No race fix / no dispatch-v2 | Explicit non-touch |

## Placeholder / consistency self-review

- No TBD steps; helper API names are stable across tasks: `recordReviewPreProviderFailure`, `buildReviewPreProviderError`, `reviewLostWorkerError`.
- `pendingTerminal` shape matches the design doc.
- Env plumbing may need a one-line adjustment to match `updateJob(root, id, fn, env)` vs `updateJob(root, id, fn)` — verify against `plugins/grok/scripts/lib/state.mjs` during Task 2 and keep unit tests as the authority.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-10-issue-95-review-preprovider-diagnostics.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — execute tasks in this session with checkpoints  

Which approach?
