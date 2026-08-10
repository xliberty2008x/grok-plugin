# Issue #95 Review Pre-Provider Loss Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix review pre-provider loss by (P0) durable typed diagnostics, (P1) provisional auth so identity-publish lag cannot fail auth, and (P2) recovery of aged unbound queued reviews — without automatic prompt replay.

**Architecture:** Add `review-preprovider-failure.mjs` for scrubbed `pendingTerminal` writes and stage-aware loss messages. Wire legacy review `--worker` to record intent on pre-provider failure and to provisionally authorize on matching `workerAuthorization` (deep-research pattern). Extend `recoverActiveJobs` for unbound orphans and improved generic `E_WORKER_LOST` wording. Implement strictly **P0 → P1 → P2**.

**Tech Stack:** Node.js ESM (Node 18+), companion job state (`updateJob` / `readJob` / `pendingTerminal`), `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-10-issue-95-review-preprovider-diagnostics-design.md` (extended after RCA).

---

## File map

| Path | Responsibility |
| --- | --- |
| `plugins/grok/scripts/lib/review-preprovider-failure.mjs` | **Create.** `buildReviewPreProviderError`, `reviewLostWorkerError`, `recordReviewPreProviderFailure` |
| `tests/review-preprovider-failure.test.mjs` | **Create.** Unit tests for helper |
| `plugins/grok/scripts/grok-companion.mjs` | **Modify.** P0 wire + recovery messages; P1 provisional auth; P2 orphan branch |
| `tests/runtime.test.mjs` | **Modify.** Integration: auth diagnostics, delayed publish, orphan recovery, mid-run regression |
| Spec / this plan | Docs only |

**Out of scope:** dispatch-v2 migration, task launch, deep-research rewrite, stderr capture as primary channel, new error codes.

**Test harness note:** If the agent runs under a live Grok tree, `hasGrokAncestor()` blocks non-internal CLI. Use double-fork/`setsid` reparent (ppid→1) or run CI-like environment when invoking `review`/`status`. Internal `--worker` only needs env markers cleared.

---

# Slice P0 — Diagnostics

### Task 1: Failing unit tests for helper

**Files:**
- Create: `tests/review-preprovider-failure.test.mjs`

- [ ] **Step 1: Write the test file** (module import will fail until Task 2)

```js
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
```

- [ ] **Step 2: Run — expect FAIL (module not found)**

```bash
node --test tests/review-preprovider-failure.test.mjs
```

- [ ] **Step 3: Commit**

```bash
git add tests/review-preprovider-failure.test.mjs
git commit -m "test: add review pre-provider failure unit coverage for #95"
```

---

### Task 2: Implement `review-preprovider-failure.mjs`

**Files:**
- Create: `plugins/grok/scripts/lib/review-preprovider-failure.mjs`

- [ ] **Step 1: Implement**

```js
import { asErrorPayload } from "./errors.mjs";
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
const ORPHAN_NEXT =
  "Inspect this job's status/result, then re-run the review if the failure persists.";

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

export function buildReviewPreProviderError(error) {
  const rawCode = typeof error?.code === "string" && error.code.startsWith("E_")
    ? error.code
    : "E_PROVIDER_EXIT";
  const rawMessage = typeof error?.message === "string" && error.message.trim()
    ? error.message
    : "Review worker failed before provider start";
  let cause = rawMessage;
  if (
    rawCode === "E_RECURSION"
    || /unauthenticated|stale.*worker|worker invocation refused/i.test(rawMessage)
  ) {
    cause = "Worker could not authenticate before execution";
  }
  const message = withNextAction(cause, AUTH_NEXT);
  const payload = redact(asErrorPayload({ code: rawCode, message }));
  return {
    code: payload.code || rawCode,
    message: clipMessage(payload.message || message)
  };
}

export function reviewLostWorkerError(jobLike = {}, { unbound = false } = {}) {
  if (unbound) {
    return {
      code: "E_WORKER_LOST",
      message: withNextAction(
        "Review launch never bound a worker process; the prompt was not replayed",
        ORPHAN_NEXT
      )
    };
  }
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
    if (terminal(current) || (current.jobClass && current.jobClass !== "review")) {
      recorded = null;
      return current;
    }
    if (current.pendingTerminal && !samePending(current.pendingTerminal, intendedTerminal)) {
      recorded = {
        error: current.pendingTerminal.error,
        pendingTerminal: current.pendingTerminal
      };
      return current;
    }
    const next = scrubStoredJob({
      ...current,
      pendingTerminal: intendedTerminal,
      summary: intendedError.message,
      progress: "Review worker failed before provider start; cleanup pending",
      lifecycleEvents: appendLifecycleEvent(
        current.lifecycleEvents || [],
        "blocked",
        intendedError.message
      )
    });
    // Ensure pending survives scrub if scrub strips unknown fields incorrectly.
    next.pendingTerminal = intendedTerminal;
    next.summary = intendedError.message;
    recorded = { error: intendedError, pendingTerminal: intendedTerminal };
    return next;
  }, env);
  return recorded;
}
```

Adjust `updateJob`/`writeJob`/`readJob` arity to match `state.mjs` (with or without `env`).

- [ ] **Step 2: Run unit tests — expect PASS**

```bash
node --test tests/review-preprovider-failure.test.mjs
```

- [ ] **Step 3: Commit**

```bash
git add plugins/grok/scripts/lib/review-preprovider-failure.mjs tests/review-preprovider-failure.test.mjs
git commit -m "feat: record durable review pre-provider failure intent"
```

---

### Task 3: Wire review `--worker` + recovery messages (P0)

**Files:**
- Modify: `plugins/grok/scripts/grok-companion.mjs`

- [ ] **Step 1: Import**

```js
import {
  recordReviewPreProviderFailure,
  reviewLostWorkerError
} from "./lib/review-preprovider-failure.mjs";
```

- [ ] **Step 2: Auth failure (~L5079)**

```js
if (!authorized) {
  const authError = new CompanionError(
    "E_RECURSION",
    "Unauthenticated Grok Companion worker invocation refused."
  );
  try {
    const record = readJob(root, id);
    if (record.jobClass === "review") {
      recordReviewPreProviderFailure({ root, jobId: id, error: authError });
    }
  } catch { /* best-effort diagnostics */ }
  throw authError;
}
```

- [ ] **Step 3: Pre-execute catch**

```js
try {
  await execute(root, id, { dispatchAttemptId, dispatchFence: authorizedFence });
} catch (error) {
  try {
    const record = readJob(root, id);
    if (
      record.jobClass === "review"
      && !terminal(record)
      && !record.providerProcess
      && record.startedAt == null
    ) {
      recordReviewPreProviderFailure({ root, jobId: id, error });
    }
  } catch { /* best-effort */ }
  throw error;
}
```

- [ ] **Step 4: Recovery `interruptedError` (~L917)**

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

- [ ] **Step 5: Syntax check + unit tests**

```bash
node --check plugins/grok/scripts/grok-companion.mjs
node --test tests/review-preprovider-failure.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add plugins/grok/scripts/grok-companion.mjs
git commit -m "fix: persist review pre-provider failures and stage-aware loss messages"
```

---

### Task 4: P0 integration tests

**Files:**
- Modify: `tests/runtime.test.mjs` (near lost-worker review tests)

Helpers already in file: `fixture`, `seedWorkspace`, `writeSeededJob`, `parseJson`, `waitFor`, `generateId`, `persistedJobs`. Add `persistedJob` if missing:

```js
function persistedJob(pluginData, id) {
  return persistedJobs(pluginData).find((job) => job.id === id);
}
```

- [ ] **Step 1: Auth failure → typed recovery**

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
  const stamped = new Date(Date.now() - 60_000).toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: pre-provider auth fixture",
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

  const worker = runCompanion(["--worker", id, "--cwd", root], {
    cwd: root,
    env: { ...env, GROK_COMPANION_WORKER_NONCE: crypto.randomBytes(16).toString("hex") },
    timeout: 15_000
  });
  assert.notEqual(worker.status, 0);

  const afterWorker = persistedJob(pluginData, id);
  assert.equal(afterWorker.pendingTerminal.error.code, "E_RECURSION");

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
  assert.equal(JSON.stringify(recovered).includes("PROMPT_MUST_BE_SCRUBBED_IF_PRESENT"), false);
});
```

- [ ] **Step 2: Silent pre-provider loss message**

```js
test("review pre-provider silent loss uses stage-aware E_WORKER_LOST", {
  skip: process.platform === "win32"
}, () => {
  const root = initRepo();
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const isolatedHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
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
  assert.equal(fs.existsSync(isolatedHome), false);
});
```

- [ ] **Step 3: Soften mid-run test message assertion if it used exact equality**

Keep `error.code === "E_WORKER_LOST"`; allow next-action suffix; forbid “before provider start”.

- [ ] **Step 4: Run focused tests**

```bash
node --test tests/review-preprovider-failure.test.mjs tests/runtime.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add tests/runtime.test.mjs
git commit -m "test: prove review pre-provider diagnostics for #95"
```

---

# Slice P1 — Provisional auth

### Task 5: Provisional authorization for legacy review `--worker`

**Files:**
- Modify: `plugins/grok/scripts/grok-companion.mjs` auth loop in `--worker` (legacy non-broker branch only)

Deep-research precedent (~L5208–5213):

```js
if (nonce && (record.workerAuthorization === nonce || identity?.nonce === nonce)) {
  if (!identity?.pid || identity.pid === process.pid) {
    authorized = true;
    break;
  }
}
```

- [ ] **Step 1: Inside the existing 40-attempt loop for non-broker workers**, after full identity match fails, add:

```js
// Legacy review (and any non-broker worker): provisional admit while launcher
// still records birth token — mirror deep-research first-registration window.
if (
  !brokerInvocation
  && nonce
  && (
    record.workerAuthorization === nonce
    || identity?.nonce === nonce
  )
  && (
    !identity?.pid
    || identity.pid === process.pid
  )
  && (
    identity?.commandMarker == null
    || identity.commandMarker === id
  )
) {
  authorized = true;
  break;
}
```

Place this **only** on the path that is not already covered by broker registration. Prefer scoping with `record.jobClass === "review"` if non-review legacy workers must stay strict — **spec says review only**, so:

```js
if (!brokerInvocation && record.jobClass === "review" && nonce && ...)
```

- [ ] **Step 2: Confirm parent still publishes full identity** before any kill path (no change required if `captureSpawnIdentity` + updateJob remain). Do not signal without startToken.

- [ ] **Step 3: Commit**

```bash
git add plugins/grok/scripts/grok-companion.mjs
git commit -m "fix: provisionally authorize review workers during identity publish lag"
```

---

### Task 6: Delayed identity-publication test (P1)

**Files:**
- Modify: `tests/runtime.test.mjs`

- [ ] **Step 1: Add test**

```js
test("review worker provisionally authorizes before workerProcess is published", {
  skip: process.platform === "win32",
  timeout: 30_000
}, async () => {
  const root = initRepo();
  fs.appendFileSync(path.join(root, "tracked.txt"), "provisional-auth\n", "utf8");
  const { env, pluginData } = fixture({ headlessDelayMs: 60_000 });
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const nonce = crypto.randomBytes(16).toString("hex");
  const stamped = new Date().toISOString();
  const logFile = path.join(stateRoot, "jobs", `${id}.log`);
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: provisional auth",
    summary: "Queued",
    write: false,
    status: "queued",
    phase: "queued",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: null,
    updatedAt: stamped,
    completedAt: null,
    workerAuthorization: nonce,
    workerProcess: null,
    providerProcess: null,
    profile: { id: "review", transport: "headless" },
    model: null,
    effort: null,
    logFile,
    progress: null,
    request: {
      prompt: "review provisional",
      target: { mode: "working-tree", label: "fixture", base: null }
    },
    result: null,
    error: null
  });

  const child = spawn(process.execPath, [COMPANION, "--worker", id, "--cwd", root], {
    cwd: root,
    env: { ...env, GROK_COMPANION_WORKER_NONCE: nonce },
    detached: true,
    stdio: "ignore"
  });

  // Withhold workerProcess longer than the old pure sleep budget.
  await new Promise((r) => setTimeout(r, 1200));

  const started = await waitFor(() => {
    const job = persistedJob(pluginData, id);
    return job?.startedAt ? job : false;
  }, { timeoutMs: 10_000 });

  assert.ok(started.startedAt, "provisional auth must reach execute without parent workerProcess publish");
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  try { process.kill(child.pid, "SIGKILL"); } catch {}
});
```

Import `spawn` from `node:child_process` and `COMPANION` from helpers if not already.

- [ ] **Step 2: Foreign PID rejection test**

```js
test("review provisional auth rejects foreign workerProcess pid", {
  skip: process.platform === "win32",
  timeout: 20_000
}, async () => {
  const root = initRepo();
  const { env, pluginData } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const nonce = crypto.randomBytes(16).toString("hex");
  const stamped = new Date().toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: foreign pid",
    summary: "Queued",
    write: false,
    status: "queued",
    phase: "queued",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: null,
    updatedAt: stamped,
    completedAt: null,
    workerAuthorization: nonce,
    workerProcess: {
      pid: 1,
      startToken: "foreign",
      nonce,
      processGroupId: 1,
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

  const worker = runCompanion(["--worker", id, "--cwd", root], {
    cwd: root,
    env: { ...env, GROK_COMPANION_WORKER_NONCE: nonce },
    timeout: 15_000
  });
  assert.notEqual(worker.status, 0);
  const stored = persistedJob(pluginData, id);
  assert.equal(stored.startedAt, null);
  assert.equal(stored.pendingTerminal?.error?.code, "E_RECURSION");
});
```

- [ ] **Step 3: Run tests — expect PASS**

```bash
node --test tests/runtime.test.mjs
```

- [ ] **Step 4: Commit**

```bash
git add plugins/grok/scripts/grok-companion.mjs tests/runtime.test.mjs
git commit -m "test: prove review provisional auth and foreign pid rejection"
```

---

# Slice P2 — Orphan recovery

### Task 7: Terminalize aged unbound review jobs

**Files:**
- Modify: `plugins/grok/scripts/grok-companion.mjs` in `recoverActiveJobs` active loop (~L813+)

- [ ] **Step 1: After the queued &lt;5s continue and controller/worker liveness gates**, before heavy terminate work, handle unbound review:

When `job.jobClass === "review"` and `!job.workerProcess?.pid` and not cleanup-blocked and not controller-live:

- Skip if still inside the existing `queued && age < 5000` gate (already applied).
- Run review home cleanup (`cleanupReviewEnvironment` + guard cleanup).
- In `updateJob`, if still non-terminal and still unbound, set terminal failed with `reviewLostWorkerError(current, { unbound: true })`, scrub, `replay: false`, privacy fields as other review loss paths.

Concrete structure (fit into existing loop rather than duplicating terminate logic):

```js
const unboundReview =
  job.jobClass === "review"
  && !cleanupBlocked
  && !job.workerProcess?.pid;

// existing continues for live worker / starting grace remain first

if (unboundReview) {
  // No process to terminate; cleanup home and terminalize with unbound message.
  let cleanup = cleanupReviewEnvironment(stateDir(root), job.id);
  cleanup = includeGuardCleanup(root, job.id, cleanup);
  updateJob(root, job.id, (current) => {
    if (terminal(current) || current.workerProcess?.pid) return current;
    const err = reviewLostWorkerError(current, { unbound: true });
    Object.assign(current, scrubStoredJob(current));
    current.status = "failed";
    current.phase = "failed";
    current.completedAt = now();
    current.error = err;
    current.summary = err.message;
    current.result = {
      ...(current.result || {}),
      hostVerification: current.result?.hostVerification || "not_run",
      replay: false,
      resume: false
    };
    current.result = applyReviewPrivacy(current.result, cleanup);
    current.lifecycleEvents = appendLifecycleEvent(
      current.lifecycleEvents || [],
      "blocked",
      err.message
    );
    delete current.pendingTerminal;
    return current;
  });
  continue;
}
```

Place this **after** live-worker checks and **after** the 5s queued grace so young launchers are not stolen. If the main loop structure already falls through when `workerProcess` is missing, ensure it does not no-op: today missing pid skips `identityMatches` continue and may still run terminate with null identities — verify behavior and either use the explicit branch above or ensure terminalization always runs.

- [ ] **Step 2: Syntax check**

```bash
node --check plugins/grok/scripts/grok-companion.mjs
```

- [ ] **Step 3: Commit**

```bash
git add plugins/grok/scripts/grok-companion.mjs
git commit -m "fix: terminalize aged unbound review jobs without workerProcess"
```

---

### Task 8: Orphan recovery tests + final verification

**Files:**
- Modify: `tests/runtime.test.mjs`

- [ ] **Step 1: Aged unbound fails**

```js
test("aged unbound review without workerProcess is recovered as failed", {
  skip: process.platform === "win32"
}, () => {
  const root = initRepo();
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const stamped = new Date(Date.now() - 10_000).toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: orphan unbound",
    summary: "Queued",
    write: false,
    status: "queued",
    phase: "queued",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: null,
    updatedAt: stamped,
    completedAt: null,
    workerAuthorization: "abc",
    workerProcess: null,
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
  assert.match(recovered.error.message, /never bound|before provider start|re-run|replay/i);
});
```

- [ ] **Step 2: Young unbound keeps grace**

```js
test("young unbound review remains queued during launch grace", {
  skip: process.platform === "win32"
}, () => {
  const root = initRepo();
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const stamped = new Date().toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: young unbound",
    summary: "Queued",
    write: false,
    status: "queued",
    phase: "queued",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: null,
    updatedAt: stamped,
    completedAt: null,
    workerAuthorization: "abc",
    workerProcess: null,
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
  assert.equal(recovered.status, "queued");
  assert.equal(recovered.error, null);
});
```

- [ ] **Step 3: Full slice verification**

```bash
node --check plugins/grok/scripts/lib/review-preprovider-failure.mjs
node --check plugins/grok/scripts/grok-companion.mjs
node --test tests/review-preprovider-failure.test.mjs
node --test tests/runtime.test.mjs
git diff --check
```

Expected: all green; mid-run lost-worker test still passes.

- [ ] **Step 4: Commit**

```bash
git add tests/runtime.test.mjs
git commit -m "test: cover unbound review orphan recovery and launch grace"
```

---

## Spec coverage checklist

| Spec item | Tasks |
| --- | --- |
| P0 pendingTerminal + typed codes | 1–4 |
| P0 stage-aware E_WORKER_LOST | 2–4 |
| P1 provisional auth | 5–6 |
| P1 foreign pid reject | 6 |
| P2 orphan + grace | 7–8 |
| No replay / scrub / mid-run regression | 4, 8 |
| No dispatch-v2 | Out of scope |

## Placeholder / consistency self-review

- APIs stable: `recordReviewPreProviderFailure`, `buildReviewPreProviderError`, `reviewLostWorkerError(..., { unbound })`.
- Order enforced: P0 before P1 before P2.
- `updateJob` env arg may need local signature tweak — unit tests are authority.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-10-issue-95-review-preprovider-diagnostics.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — this session with checkpoints  

Which approach?
