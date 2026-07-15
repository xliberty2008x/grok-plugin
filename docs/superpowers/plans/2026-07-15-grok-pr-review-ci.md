# Grok PR Review CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On each same-repo, non-draft PR, run the plugin’s headless explore review from a trusted runtime (staged SuperGrok session auth) and post an informational GitHub `COMMENT` review with inline findings.

**Architecture:** Dedicated workflow checks out PR head for git state and a trusted ref for executables. `run-trusted-review.mjs` stages `GROK_AUTH_JSON`, invokes trusted `grok-companion.mjs review --wait --json --scope branch --base origin/<base>`, writes `review-job.json`. `post-grok-review.mjs` maps `result.review` to the Pull Request Reviews API using `GITHUB_TOKEN` only. Findings never fail the check.

**Tech Stack:** GitHub Actions, Node 22 ESM, `@xai-official/grok` CLI, plugin `grok-companion.mjs`, `gh` CLI / GitHub REST Reviews API, `node:test`.

**Spec:** `docs/superpowers/specs/2026-07-15-grok-pr-review-ci-design.md`

---

## File map

| Path | Responsibility |
| --- | --- |
| `scripts/ci/lib/diff-right-lines.mjs` | Parse unified diff → `Set` of `"path:line"` right-side commentable pairs |
| `scripts/ci/lib/build-pr-review-payload.mjs` | Map companion job JSON + right-lines → Reviews API payload or `{ skip: true, reason }` |
| `scripts/ci/post-grok-review.mjs` | CLI: read job JSON + diff, build payload, `gh api` POST review |
| `scripts/ci/run-trusted-review.mjs` | CLI: require auth secret, stage file, run trusted companion review, write job JSON |
| `.github/workflows/grok-pr-review.yml` | Triggers, concurrency, trust checkout, install, env split, cleanup |
| `tests/ci-post-grok-review.test.mjs` | Offline unit tests for diff filter + payload builder (+ CLI dry-run if useful) |
| `CONTRIBUTING.md` | Enable secret, vars, policy, rotation |
| `README.md` | Short pointer to optional PR review |

**Do not modify:** plugin review transport, `ci.yml` permissions, auth SPEC (no API-key path).

**Bootstrap note:** Until `main` contains `scripts/ci/*`, the first landing PR cannot use “trusted = main” for those scripts. Land scripts+workflow in one PR; after merge, trusted ref `main` works. For the bootstrap PR itself, set `vars.GROK_PR_REVIEW_TRUSTED_REF` to the PR branch name only if needed for self-test, or merge offline pieces first then enable the live job. End-state remains trusted ref default `main`.

---

### Task 1: Diff right-side line filter

**Files:**
- Create: `scripts/ci/lib/diff-right-lines.mjs`
- Create: `tests/ci-post-grok-review.test.mjs` (start here; extend in later tasks)

- [ ] **Step 1: Write failing tests for right-side line collection**

Create `tests/ci-post-grok-review.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { collectRightSideLines } from "../scripts/ci/lib/diff-right-lines.mjs";

test("collectRightSideLines records added and context lines on RIGHT side", () => {
  const diff = [
    "diff --git a/src/a.js b/src/a.js",
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -1,3 +1,4 @@",
    " line1",
    "-old",
    "+new",
    " line3",
    ""
  ].join("\n");
  const set = collectRightSideLines(diff);
  assert.equal(set.has("src/a.js:1"), true); // context line1 → new line 1
  assert.equal(set.has("src/a.js:2"), true); // +new → new line 2
  assert.equal(set.has("src/a.js:3"), true); // context line3 → new line 3
  assert.equal(set.has("src/a.js:99"), false);
});

test("collectRightSideLines skips pure deletions and /dev/null new files headers correctly", () => {
  const diff = [
    "diff --git a/gone.txt b/gone.txt",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "diff --git a/new.txt b/new.txt",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1,2 @@",
    "+hello",
    "+world",
    ""
  ].join("\n");
  const set = collectRightSideLines(diff);
  assert.equal(set.has("gone.txt:1"), false);
  assert.equal(set.has("new.txt:1"), true);
  assert.equal(set.has("new.txt:2"), true);
});

test("collectRightSideLines ignores No newline metadata", () => {
  const diff = [
    "diff --git a/f b/f",
    "--- a/f",
    "+++ b/f",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "\\ No newline at end of file",
    ""
  ].join("\n");
  const set = collectRightSideLines(diff);
  assert.equal(set.has("f:1"), true);
  assert.equal(set.size, 1);
});
```

- [ ] **Step 2: Run tests — expect FAIL (module missing)**

```bash
node --test tests/ci-post-grok-review.test.mjs
```

Expected: fail to resolve `../scripts/ci/lib/diff-right-lines.mjs` or export missing.

- [ ] **Step 3: Implement `collectRightSideLines`**

Create `scripts/ci/lib/diff-right-lines.mjs`:

```js
/**
 * Parse a unified diff and return Set of "path:line" pairs that are valid
 * GitHub pull review comment targets on side RIGHT (added or context lines).
 */
export function collectRightSideLines(diffText) {
  const lines = String(diffText || "").split(/\r?\n/);
  const out = new Set();
  let file = null;
  let newLine = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      const rest = line.slice(4).trim();
      if (rest === "/dev/null") {
        file = null;
        inHunk = false;
        continue;
      }
      // "b/path" or "path"
      file = rest.startsWith("b/") ? rest.slice(2) : rest;
      inHunk = false;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = Boolean(file);
      continue;
    }
    if (!inHunk || !file) continue;
    if (line.startsWith("\\")) continue; // \ No newline at end of file
    if (line.startsWith("+") && !line.startsWith("+++")) {
      out.add(`${file}:${newLine}`);
      newLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      // deleted: do not advance newLine
      continue;
    }
    if (line.startsWith(" ") || line === "") {
      // context (empty line in hunk is rare; treat " " prefix as context)
      if (line.startsWith(" ")) {
        out.add(`${file}:${newLine}`);
        newLine += 1;
      }
      continue;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
node --test tests/ci-post-grok-review.test.mjs
```

Expected: all three tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/ci/lib/diff-right-lines.mjs tests/ci-post-grok-review.test.mjs
git commit -m "feat(ci): add unified-diff right-side line collector for PR reviews"
```

---

### Task 2: Build PR review payload from companion job JSON

**Files:**
- Create: `scripts/ci/lib/build-pr-review-payload.mjs`
- Modify: `tests/ci-post-grok-review.test.mjs`

- [ ] **Step 1: Write failing tests for payload builder**

Append to `tests/ci-post-grok-review.test.mjs`:

```js
import { buildPrReviewPayload } from "../scripts/ci/lib/build-pr-review-payload.mjs";

function sampleJob(findings) {
  return {
    id: "review-test",
    status: "completed",
    result: {
      review: {
        verdict: findings.length ? "needs_changes" : "pass",
        summary: "Summary text.",
        findings
      }
    }
  };
}

test("buildPrReviewPayload skips empty findings", () => {
  const right = new Set(["src/a.js:1"]);
  const r = buildPrReviewPayload({
    job: sampleJob([]),
    headSha: "abc123",
    rightSideLines: right
  });
  assert.equal(r.skip, true);
  assert.equal(r.reason, "no-findings");
});

test("buildPrReviewPayload skips empty-target", () => {
  const job = sampleJob([]);
  job.result.skipped = true;
  job.result.skipReason = "empty-target";
  const r = buildPrReviewPayload({
    job,
    headSha: "abc123",
    rightSideLines: new Set()
  });
  assert.equal(r.skip, true);
  assert.equal(r.reason, "empty-target");
});

test("buildPrReviewPayload places mappable findings inline and promotes others", () => {
  const right = new Set(["src/a.js:2"]);
  const r = buildPrReviewPayload({
    job: sampleJob([
      {
        severity: "high",
        title: "Bug",
        body: "Broken thing",
        file: "src/a.js",
        line: 2
      },
      {
        severity: "low",
        title: "Off",
        body: "Not in diff",
        file: "src/a.js",
        line: 99
      },
      {
        severity: "info",
        title: "General",
        body: "No location",
        file: null,
        line: null
      }
    ]),
    headSha: "deadbeef",
    rightSideLines: right
  });
  assert.equal(r.skip, false);
  assert.equal(r.payload.commit_id, "deadbeef");
  assert.equal(r.payload.event, "COMMENT");
  assert.equal(r.payload.comments.length, 1);
  assert.equal(r.payload.comments[0].path, "src/a.js");
  assert.equal(r.payload.comments[0].line, 2);
  assert.equal(r.payload.comments[0].side, "RIGHT");
  assert.match(r.payload.comments[0].body, /\[high\]/);
  assert.match(r.payload.comments[0].body, /Bug/);
  assert.match(r.payload.body, /Summary text/);
  assert.match(r.payload.body, /high:\s*1/);
  assert.match(r.payload.body, /Issues outside the diff/);
  assert.match(r.payload.body, /Off/);
  assert.match(r.payload.body, /General/);
});

test("buildPrReviewPayload throws on missing review when not skippable", () => {
  assert.throws(
    () =>
      buildPrReviewPayload({
        job: { status: "failed", result: null, error: { code: "E_AUTH_REQUIRED" } },
        headSha: "x",
        rightSideLines: new Set()
      }),
    /review/i
  );
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
node --test tests/ci-post-grok-review.test.mjs
```

Expected: cannot find `build-pr-review-payload.mjs`.

- [ ] **Step 3: Implement payload builder**

Create `scripts/ci/lib/build-pr-review-payload.mjs`:

```js
/**
 * @typedef {{ severity: string, title: string, body: string, file?: string|null, line?: number|null }} Finding
 * @typedef {{ skip: true, reason: string } | { skip: false, payload: object }} BuildResult
 */

/**
 * Map companion public job JSON + right-side diff lines to a GitHub create-review body.
 * @param {{ job: object, headSha: string, rightSideLines: Set<string> }} args
 * @returns {BuildResult}
 */
export function buildPrReviewPayload({ job, headSha, rightSideLines }) {
  if (!headSha || typeof headSha !== "string") {
    throw new Error("headSha is required");
  }
  const result = job?.result || null;
  if (result?.skipped && result?.skipReason === "empty-target") {
    return { skip: true, reason: "empty-target" };
  }
  const review = result?.review;
  if (!review || typeof review !== "object") {
    throw new Error("Job JSON missing result.review (review may have failed before completion)");
  }
  const findings = Array.isArray(review.findings) ? review.findings : [];
  if (findings.length === 0) {
    return { skip: true, reason: "no-findings" };
  }

  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const inline = [];
  const promoted = [];

  for (const f of findings) {
    const severity = String(f.severity || "info");
    if (Object.hasOwn(counts, severity)) counts[severity] += 1;
    else counts.info += 1;

    const file = f.file == null || f.file === "" ? null : String(f.file);
    const line = f.line == null ? null : Number(f.line);
    const key = file && line && Number.isFinite(line) ? `${file}:${line}` : null;
    const commentBody = formatFindingComment(f);

    if (key && rightSideLines.has(key)) {
      inline.push({
        path: file,
        line,
        side: "RIGHT",
        body: commentBody
      });
    } else {
      promoted.push({ severity, file, line, title: f.title, body: f.body });
    }
  }

  const bodyParts = [
    "## Grok review",
    "",
    String(review.summary || "").trim() || "(no summary)",
    "",
    "## Issue counts by severity",
    "",
    `- critical: ${counts.critical}`,
    `- high: ${counts.high}`,
    `- medium: ${counts.medium}`,
    `- low: ${counts.low}`,
    `- info: ${counts.info}`,
    ""
  ];

  if (promoted.length) {
    bodyParts.push("## Issues outside the diff", "");
    for (const p of promoted) {
      const loc =
        p.file && p.line
          ? `${p.file}:${p.line}`
          : p.file
            ? p.file
            : "(no location)";
      bodyParts.push(`- **[${p.severity}]** ${loc} — ${p.title}`);
      bodyParts.push(`  ${p.body}`);
      bodyParts.push("");
    }
  }

  bodyParts.push(
    "---",
    "",
    "_Automated Grok Companion review (informational; does not block merge)._"
  );

  return {
    skip: false,
    payload: {
      commit_id: headSha,
      event: "COMMENT",
      body: bodyParts.join("\n"),
      comments: inline
    }
  };
}

function formatFindingComment(f) {
  const title = String(f.title || "Finding").trim();
  const body = String(f.body || "").trim();
  const severity = String(f.severity || "info");
  return `**[${severity}] ${title}**\n\n${body}`;
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
node --test tests/ci-post-grok-review.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add scripts/ci/lib/build-pr-review-payload.mjs tests/ci-post-grok-review.test.mjs
git commit -m "feat(ci): map Grok review findings to GitHub PR review payload"
```

---

### Task 3: `post-grok-review.mjs` CLI

**Files:**
- Create: `scripts/ci/post-grok-review.mjs`
- Modify: `tests/ci-post-grok-review.test.mjs` (optional dry-run unit via spawn)

- [ ] **Step 1: Implement CLI**

Create `scripts/ci/post-grok-review.mjs`:

```js
#!/usr/bin/env node
/**
 * Post a Grok companion review job JSON as a GitHub PR COMMENT review.
 *
 * Usage:
 *   node scripts/ci/post-grok-review.mjs \
 *     --job-json <path> \
 *     --diff <path> \
 *     --owner <owner> \
 *     --repo <repo> \
 *     --pr <number> \
 *     --head-sha <sha> \
 *     [--dry-run]
 *
 * Requires GH_TOKEN or GITHUB_TOKEN in env unless --dry-run.
 * Never reads GROK_AUTH_*.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { collectRightSideLines } from "./lib/diff-right-lines.mjs";
import { buildPrReviewPayload } from "./lib/build-pr-review-payload.mjs";

function usage() {
  return `Usage: node post-grok-review.mjs --job-json <path> --diff <path> --owner <o> --repo <r> --pr <n> --head-sha <sha> [--dry-run]`;
}

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--job-json") out.jobJson = argv[++i];
    else if (a === "--diff") out.diff = argv[++i];
    else if (a === "--owner") out.owner = argv[++i];
    else if (a === "--repo") out.repo = argv[++i];
    else if (a === "--pr") out.pr = argv[++i];
    else if (a === "--head-sha") out.headSha = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}\n${usage()}`);
  }
  for (const k of ["jobJson", "diff", "owner", "repo", "pr", "headSha"]) {
    if (!out[k]) throw new Error(`Missing --${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}\n${usage()}`);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const job = JSON.parse(fs.readFileSync(path.resolve(args.jobJson), "utf8"));
  const diffText = fs.readFileSync(path.resolve(args.diff), "utf8");
  const rightSideLines = collectRightSideLines(diffText);
  const built = buildPrReviewPayload({
    job,
    headSha: args.headSha,
    rightSideLines
  });

  if (built.skip) {
    console.log(`post-grok-review: skip (${built.reason})`);
    process.exit(0);
  }

  const payloadPath = path.join(
    process.env.RUNNER_TEMP || process.env.TMPDIR || "/tmp",
    `grok-pr-review-payload-${process.pid}.json`
  );
  fs.writeFileSync(payloadPath, JSON.stringify(built.payload, null, 2), { mode: 0o600 });

  if (args.dryRun) {
    console.log(JSON.stringify({ dryRun: true, payloadPath, payload: built.payload }, null, 2));
    process.exit(0);
  }

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("post-grok-review: GH_TOKEN or GITHUB_TOKEN required");
    process.exit(2);
  }

  const endpoint = `repos/${args.owner}/${args.repo}/pulls/${args.pr}/reviews`;
  const result = spawnSync(
    "gh",
    ["api", endpoint, "-X", "POST", "--input", payloadPath],
    {
      encoding: "utf8",
      env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
      shell: false
    }
  );

  try {
    fs.unlinkSync(payloadPath);
  } catch {
    /* ignore */
  }

  if (result.status !== 0) {
    console.error(result.stderr || result.stdout || "gh api failed");
    process.exit(result.status || 1);
  }
  console.log(result.stdout.trim());
  process.exit(0);
}

try {
  main();
} catch (error) {
  console.error(`post-grok-review: ${error.message || error}`);
  process.exit(1);
}
```

- [ ] **Step 2: Dry-run smoke against a fixture**

Write a temp job + diff and run:

```bash
mkdir -p /tmp/grok-ci-fixture
cat > /tmp/grok-ci-fixture/job.json <<'EOF'
{
  "id": "review-fixture",
  "status": "completed",
  "result": {
    "review": {
      "verdict": "needs_changes",
      "summary": "One issue.",
      "findings": [
        {
          "severity": "medium",
          "title": "Example",
          "body": "Demo body",
          "file": "src/a.js",
          "line": 2
        }
      ]
    }
  }
}
EOF
cat > /tmp/grok-ci-fixture/pr.diff <<'EOF'
diff --git a/src/a.js b/src/a.js
--- a/src/a.js
+++ b/src/a.js
@@ -1,2 +1,3 @@
 line1
+new
 line3
EOF

node scripts/ci/post-grok-review.mjs \
  --job-json /tmp/grok-ci-fixture/job.json \
  --diff /tmp/grok-ci-fixture/pr.diff \
  --owner o --repo r --pr 1 --head-sha abc \
  --dry-run
```

Expected: JSON with `dryRun: true`, one inline comment on `src/a.js:2`, `event: "COMMENT"`.

- [ ] **Step 3: Run full unit suite**

```bash
node --test tests/ci-post-grok-review.test.mjs
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/ci/post-grok-review.mjs
git commit -m "feat(ci): add post-grok-review CLI for GitHub COMMENT reviews"
```

---

### Task 4: `run-trusted-review.mjs`

**Files:**
- Create: `scripts/ci/run-trusted-review.mjs`

- [ ] **Step 1: Implement runner CLI**

Create `scripts/ci/run-trusted-review.mjs`:

```js
#!/usr/bin/env node
/**
 * Stage GROK_AUTH_JSON and run trusted grok-companion review against a workspace.
 *
 * Usage:
 *   node run-trusted-review.mjs \
 *     --trusted-root <path> \
 *     --workspace <path> \
 *     --base-ref <git-ref-for-origin/base> \
 *     --out <review-job.json> \
 *     [--auth-json-env GROK_AUTH_JSON]
 *
 * Env:
 *   GROK_AUTH_JSON — raw auth.json contents (required unless GROK_AUTH_PATH already set to a file)
 *   GROK_BIN — optional path to grok binary
 *
 * Does not set or use GITHUB_TOKEN.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function usage() {
  return `Usage: node run-trusted-review.mjs --trusted-root <dir> --workspace <dir> --base-ref <ref> --out <file>`;
}

function parseArgs(argv) {
  const out = { authJsonEnv: "GROK_AUTH_JSON" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--trusted-root") out.trustedRoot = path.resolve(argv[++i]);
    else if (a === "--workspace") out.workspace = path.resolve(argv[++i]);
    else if (a === "--base-ref") out.baseRef = argv[++i];
    else if (a === "--out") out.out = path.resolve(argv[++i]);
    else if (a === "--auth-json-env") out.authJsonEnv = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}\n${usage()}`);
  }
  for (const k of ["trustedRoot", "workspace", "baseRef", "out"]) {
    if (!out[k]) throw new Error(`Missing required flag\n${usage()}`);
  }
  return out;
}

function stageAuth(raw, destDir) {
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const dest = path.join(destDir, "auth.json");
  fs.writeFileSync(dest, raw, { mode: 0o600 });
  // re-apply mode for platforms that ignore writeFile mode
  fs.chmodSync(dest, 0o600);
  return dest;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const companion = path.join(
    args.trustedRoot,
    "plugins",
    "grok",
    "scripts",
    "grok-companion.mjs"
  );
  if (!fs.existsSync(companion)) {
    throw new Error(`Trusted companion not found: ${companion}`);
  }

  let authPath = process.env.GROK_AUTH_PATH || "";
  let staged = null;
  if (!authPath) {
    const raw = process.env[args.authJsonEnv];
    if (!raw || !String(raw).trim()) {
      console.error(
        `run-trusted-review: missing ${args.authJsonEnv} (or set GROK_AUTH_PATH to an existing auth file)`
      );
      process.exit(2);
    }
    const dir = path.join(process.env.RUNNER_TEMP || os.tmpdir(), `grok-ci-auth-${process.pid}`);
    staged = stageAuth(String(raw), dir);
    authPath = staged;
  } else if (!fs.existsSync(authPath)) {
    console.error(`run-trusted-review: GROK_AUTH_PATH does not exist: ${authPath}`);
    process.exit(2);
  }

  const base = args.baseRef.startsWith("origin/")
    ? args.baseRef
    : `origin/${args.baseRef}`;

  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    LANG: process.env.LANG,
    GROK_AUTH_PATH: authPath,
    // Isolate plugin state from runner home noise
    CLAUDE_PLUGIN_DATA: path.join(
      process.env.RUNNER_TEMP || os.tmpdir(),
      `grok-ci-plugin-data-${process.pid}`
    ),
    GROK_COMPANION_HOST: "ci",
    GROK_COMPANION_HOST_SESSION_ID: process.env.GITHUB_RUN_ID || `ci-${process.pid}`
  };
  if (process.env.GROK_BIN) env.GROK_BIN = process.env.GROK_BIN;
  // Explicitly do not pass GITHUB_TOKEN / GH_TOKEN / GROK_AUTH_JSON into child

  fs.mkdirSync(env.CLAUDE_PLUGIN_DATA, { recursive: true, mode: 0o700 });

  const result = spawnSync(
    process.execPath,
    [
      companion,
      "review",
      "--wait",
      "--json",
      "--scope",
      "branch",
      "--base",
      base
    ],
    {
      cwd: args.workspace,
      env,
      encoding: "utf8",
      shell: false,
      maxBuffer: 32 * 1024 * 1024
    }
  );

  if (result.stdout) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, result.stdout, "utf8");
  }
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    console.error(
      `run-trusted-review: companion exited ${result.status}`
    );
    process.exit(result.status || 1);
  }

  // Validate JSON parseable and looks complete enough for poster
  let job;
  try {
    job = JSON.parse(result.stdout);
  } catch {
    console.error("run-trusted-review: companion stdout is not JSON");
    process.exit(1);
  }
  if (job?.ok === false) {
    console.error(
      `run-trusted-review: companion error ${job.error?.code || ""} ${job.error?.message || ""}`
    );
    process.exit(1);
  }
  if (job?.status && job.status !== "completed") {
    console.error(`run-trusted-review: unexpected status ${job.status}`);
    process.exit(1);
  }

  console.log(`run-trusted-review: wrote ${args.out}`);
  process.exit(0);
}

try {
  main();
} catch (error) {
  console.error(`run-trusted-review: ${error.message || error}`);
  process.exit(1);
}
```

- [ ] **Step 2: Sanity check — missing secret exits 2**

```bash
env -u GROK_AUTH_JSON -u GROK_AUTH_PATH node scripts/ci/run-trusted-review.mjs \
  --trusted-root . \
  --workspace . \
  --base-ref main \
  --out /tmp/review-job.json
```

Expected: exit 2, message about missing `GROK_AUTH_JSON`.

- [ ] **Step 3: Commit**

```bash
git add scripts/ci/run-trusted-review.mjs
git commit -m "feat(ci): add trusted-runtime Grok review runner for Actions"
```

---

### Task 5: GitHub workflow

**Files:**
- Create: `.github/workflows/grok-pr-review.yml`

- [ ] **Step 1: Add workflow**

Create `.github/workflows/grok-pr-review.yml`:

```yaml
# Grok PR Review — same-repo non-draft PRs only.
# Security invariants:
# - No pull_request_target
# - Trusted runtime for scripts/plugin; PR head is git review target only
# - GROK_AUTH never shared with GITHUB_TOKEN in the same child process
# - Findings never fail the job; infra/auth/schema/post failures do
name: Grok PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: grok-pr-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  grok-pr-review:
    name: Grok headless review
    if: >-
      github.event.pull_request.head.repo.full_name == github.repository
      && github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - name: Check out PR head (code under review)
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha }}

      - name: Fetch base ref
        run: git fetch origin "${{ github.event.pull_request.base.ref }}":"refs/remotes/origin/${{ github.event.pull_request.base.ref }}"

      - name: Check out trusted runtime
        uses: actions/checkout@v4
        with:
          ref: ${{ vars.GROK_PR_REVIEW_TRUSTED_REF || 'main' }}
          path: .grok-trusted
          fetch-depth: 1

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22.x

      - name: Install Grok Build CLI
        env:
          GROK_CLI_VERSION: ${{ vars.GROK_CLI_VERSION || '0.2.99' }}
        run: npm install -g "@xai-official/grok@${GROK_CLI_VERSION}"

      - name: Run trusted Grok review
        id: review
        env:
          GROK_AUTH_JSON: ${{ secrets.GROK_AUTH_JSON }}
        run: |
          set -euo pipefail
          OUT="${RUNNER_TEMP}/review-job.json"
          node .grok-trusted/scripts/ci/run-trusted-review.mjs \
            --trusted-root "${GITHUB_WORKSPACE}/.grok-trusted" \
            --workspace "${GITHUB_WORKSPACE}" \
            --base-ref "${{ github.event.pull_request.base.ref }}" \
            --out "${OUT}"
          echo "job_json=${OUT}" >> "$GITHUB_OUTPUT"

      - name: Collect PR diff for inline mapping
        run: |
          set -euo pipefail
          git diff \
            "origin/${{ github.event.pull_request.base.ref }}...${{ github.event.pull_request.head.sha }}" \
            > "${RUNNER_TEMP}/pr.diff"

      - name: Post review to GitHub
        env:
          GH_TOKEN: ${{ github.token }}
          # Do not pass GROK_AUTH_JSON here
        run: |
          set -euo pipefail
          node .grok-trusted/scripts/ci/post-grok-review.mjs \
            --job-json "${{ steps.review.outputs.job_json }}" \
            --diff "${RUNNER_TEMP}/pr.diff" \
            --owner "${{ github.repository_owner }}" \
            --repo "${{ github.event.repository.name }}" \
            --pr "${{ github.event.pull_request.number }}" \
            --head-sha "${{ github.event.pull_request.head.sha }}"

      - name: Upload review job JSON on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: grok-review-job-${{ github.event.pull_request.number }}
          path: ${{ runner.temp }}/review-job.json
          if-no-files-found: ignore

      - name: Wipe staged Grok auth
        if: always()
        run: |
          set +e
          find "${RUNNER_TEMP}" -name 'auth.json' -type f -delete 2>/dev/null
          true
```

**Note:** `actions/checkout` twice leaves PR head in `$GITHUB_WORKSPACE` and trusted tree in `.grok-trusted`. Confirm workspace still at PR head after second checkout (path option should not replace root). If root is polluted, adjust to: first checkout trusted to path, then checkout PR head to workspace with `clean: false` carefully — prefer **PR head first at root**, trusted to subdirectory as written.

- [ ] **Step 2: YAML sanity**

```bash
# if actionlint available:
actionlint .github/workflows/grok-pr-review.yml || true
# always:
test -f .github/workflows/grok-pr-review.yml && python3 -c "import pathlib; print(pathlib.Path('.github/workflows/grok-pr-review.yml').stat().st_size)"
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/grok-pr-review.yml
git commit -m "ci: add Grok PR review workflow for same-repo non-draft PRs"
```

---

### Task 6: Documentation

**Files:**
- Modify: `CONTRIBUTING.md`
- Modify: `README.md` (short section only)

- [ ] **Step 1: Add CONTRIBUTING subsection**

Append (or insert under CI section if present) in `CONTRIBUTING.md`:

```markdown
## Optional Grok PR review (GitHub Actions)

Same-repository, non-draft pull requests can run the plugin’s headless Grok
review and post an informational GitHub review (`COMMENT`) with inline findings
when mappable. Findings never fail the check; only auth, CLI, schema, or API
errors fail the job.

### Enable

1. Create a dedicated SuperGrok / `grok login` session (prefer a bot identity).
2. Copy the session file contents into a repository secret named `GROK_AUTH_JSON`
   (the full `auth.json` body).
3. Merge the workflow `.github/workflows/grok-pr-review.yml` (already in tree when
   this section applies).
4. Optional repository variables:
   - `GROK_PR_REVIEW_TRUSTED_REF` — git ref for the review runtime (default `main`)
   - `GROK_CLI_VERSION` — `@xai-official/grok` version (default `0.2.99`)

### Policy

- **Forks** are skipped (secrets are unavailable and `pull_request_target` is not used).
- **Drafts** are skipped until `ready_for_review`.
- Runtime scripts and the companion binary path come from the **trusted ref**, not
  from the PR tip. The PR head is only the git tree under review.
- Rotate `GROK_AUTH_JSON` when jobs fail with authentication errors.

### Local dry-run of the poster

```bash
node scripts/ci/post-grok-review.mjs \
  --job-json /path/to/review-job.json \
  --diff /path/to/pr.diff \
  --owner OWNER --repo REPO --pr N --head-sha SHA \
  --dry-run
```
```

- [ ] **Step 2: README pointer**

Add a short bullet under an appropriate “CI” or “Development” section in `README.md`:

```markdown
- **Optional PR Grok review:** same-repo non-draft PRs can post informational Grok reviews when `GROK_AUTH_JSON` is configured. See CONTRIBUTING.md.
```

- [ ] **Step 3: Commit**

```bash
git add CONTRIBUTING.md README.md
git commit -m "docs: document optional Grok PR review CI setup"
```

---

### Task 7: Full offline verification + validate

**Files:** none new (maybe fix imports if validate complains)

- [ ] **Step 1: Run offline suite**

```bash
npm test
npm run validate
```

Expected: all existing tests pass; new `ci-post-grok-review` tests pass; validate clean (if validate requires listing new scripts, add `scripts/ci/**` only if the repo’s validate policy demands it — do **not** force new scripts into release package lists unless required).

- [ ] **Step 2: Fix any regressions**

If `npm test` fails due to import/path issues, fix minimally and re-run.

- [ ] **Step 3: Final commit if needed**

```bash
git status
# commit only if fixes were required
```

---

### Task 8: Manual enablement checklist (operator, not code)

- [ ] **Step 1:** Add `GROK_AUTH_JSON` secret in GitHub repo settings  
- [ ] **Step 2:** Open a same-repo non-draft PR with a tiny intentional issue  
- [ ] **Step 3:** Confirm job is green and a COMMENT review appears  
- [ ] **Step 4:** Confirm a clean PR posts nothing (or skip log only)  
- [ ] **Step 5:** Confirm fork PR (if available) does not run the job  

---

## Spec coverage self-check

| Spec requirement | Task |
| --- | --- |
| Plugin headless explore + host post | 4, 5 |
| `GROK_AUTH_JSON` staging | 4, 5 |
| Same-repo + skip drafts/forks | 5 |
| Trusted runtime | 4, 5 |
| Formal COMMENT + inline | 2, 3 |
| Never fail on findings | 2, 5 (workflow only fails on step failures) |
| Offline mapper tests | 1, 2, 7 |
| CONTRIBUTING / README | 6 |
| No API-key auth | not implemented (correct) |
| No `ci.yml` permission change | not touched |
| Bootstrap note | File map + operator Task 8 |

## Placeholder scan

No TBD/TODO steps; commands and code are concrete. Adjust hunk-header regex only if real `git diff` fixtures fail in Task 1.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-15-grok-pr-review-ci.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — execute tasks in this session with checkpoints  

Which approach?
