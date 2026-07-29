import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { cleanupExitCode, parseCleanupArgs } from "../scripts/cleanup-test-temp.mjs";
import { runDeterministicTestFiles } from "../scripts/lib/deterministic-test-runner.mjs";
import {
  environmentProvesOwnership,
  linuxKnownProcessIdentityMatches,
  linuxProcessGroupMemberFromStat,
  linuxProcessIdentityFromStat,
  linuxProcessProvesLiveOwnership
} from "../scripts/lib/test-temp-supervisor.mjs";
import {
  LEGACY_REPOSITORY_PREFIX,
  LEGACY_TEST_TEMP_PREFIXES,
  cleanupTestTemp,
  removeInventoriedTestTempRoot
} from "../scripts/lib/test-temp-cleanup.mjs";
import {
  TEST_TEMP_PROCESS_PREFIX,
  TEST_TEMP_ROOT_ENV,
  TEST_TEMP_RUN_PREFIX,
  createOwnedTestTempRoot,
  processStartToken
} from "../scripts/lib/test-temp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORTER = path.join(ROOT, "scripts/lib/zero-skip-test-reporter.mjs");
const OLD_MS = 2 * 60 * 60_000;

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-test-cleanup-sandbox-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync(root);
}

function age(target, nowMs = Date.now(), ageMs = OLD_MS) {
  const at = new Date(nowMs - ageMs);
  fs.utimesSync(target, at, at);
}

function legacy(root, prefix = LEGACY_REPOSITORY_PREFIX) {
  return fs.mkdtempSync(path.join(root, prefix));
}

function closedPaths() {
  return { available: true, paths: [], commands: [] };
}

function noWorktrees() {
  return { available: true, paths: [] };
}

function options(root, overrides = {}) {
  return {
    tempRoot: root,
    repoRoot: ROOT,
    legacy: true,
    nowMs: Date.now(),
    expectedUid: process.getuid(),
    openPathsProvider: closedPaths,
    worktreeProvider: noWorktrees,
    tokenForPid: () => null,
    ...overrides
  };
}

function record(result, target) {
  return result.candidates.find((candidate) => candidate.path === target);
}

async function pidIsGone(pid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch (error) {
      if (error?.code === "ESRCH") return true;
      throw error;
    }
  }
  return false;
}

async function waitForPath(target, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(target)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for test path.");
}

test("cleanup arguments default to dry-run and require explicit apply, legacy, and bounded age", () => {
  assert.deepEqual(parseCleanupArgs([]), {
    help: false,
    apply: false,
    legacy: false,
    olderThanMs: 60 * 60_000
  });
  assert.deepEqual(parseCleanupArgs(["--apply", "--legacy", "--older-than", "90m"]), {
    help: false,
    apply: true,
    legacy: true,
    olderThanMs: 90 * 60_000
  });
  assert.throws(() => parseCleanupArgs(["--older-than", "1hour"]), /Invalid/);
  assert.throws(() => parseCleanupArgs(["--delete"]), /Unknown/);
});

test("cleanup apply exits nonzero when a verified candidate is not removed", () => {
  assert.equal(cleanupExitCode({
    aborted: false,
    candidates: [{ eligible: false, removed: false, reasons: ["remove-failed"] }]
  }, { apply: true }), 1);
  assert.equal(cleanupExitCode({
    aborted: false,
    candidates: [{ eligible: false, removed: false, reasons: ["too-recent"] }]
  }, { apply: true }), 0);
  assert.equal(cleanupExitCode({
    aborted: true,
    candidates: []
  }, { apply: true }), 2);
});

test("Linux ownership matching requires an exact environment entry and excludes the supervisor", () => {
  const marker = "GROK_PLUGIN_TEST_SUPERVISOR_TOKEN=fixture";
  assert.equal(environmentProvesOwnership(
    Buffer.from(`PREFIX_${marker}\0`),
    [marker],
    { pid: 42, supervisorPid: 41 }
  ), false);
  assert.equal(environmentProvesOwnership(
    Buffer.from(`${marker}\0`),
    [marker],
    { pid: 42, supervisorPid: 42 }
  ), false);
  assert.equal(environmentProvesOwnership(
    Buffer.from(`${marker}\0`),
    [marker],
    { pid: 42, supervisorPid: 41 }
  ), true);
});

test("Linux fallback identity parses start time after complex process names", () => {
  const fields = ["S", ...Array.from({ length: 18 }, (_, index) => String(index + 1)), "987654"];
  assert.equal(
    linuxProcessIdentityFromStat(42, `42 (node worker (fixture)) ${fields.join(" ")}`),
    "42:987654"
  );
  assert.equal(
    linuxProcessIdentityFromStat(42, `42 (dead worker) Z ${fields.slice(1).join(" ")}`),
    null
  );
  assert.equal(linuxProcessIdentityFromStat(42, "malformed"), null);
  assert.equal(linuxProcessIdentityFromStat(1, `1 (init) ${fields.join(" ")}`), null);
});

test("Linux process-group parsing distinguishes live members from terminal zombies", () => {
  const live = ["S", "1", "42", ...Array.from({ length: 17 }, (_, index) => String(index + 4))];
  const zombie = ["Z", ...live.slice(1)];
  assert.deepEqual(
    linuxProcessGroupMemberFromStat(43, `43 (worker (live)) ${live.join(" ")}`),
    { processGroupId: 42, terminal: false }
  );
  assert.deepEqual(
    linuxProcessGroupMemberFromStat(44, `44 (worker dead) ${zombie.join(" ")}`),
    { processGroupId: 42, terminal: true }
  );
  assert.equal(linuxProcessGroupMemberFromStat(44, "malformed"), null);
});

test("Linux terminal process states cannot retain a live ownership identity", () => {
  const marker = "GROK_PLUGIN_TEST_SUPERVISOR_TOKEN=fixture";
  for (const state of ["Z", "X", "x"]) {
    const fields = [
      state,
      "1",
      "42",
      ...Array.from({ length: 16 }, (_, index) => String(index + 4)),
      "987654"
    ];
    assert.equal(
      linuxProcessIdentityFromStat(42, `42 (terminal worker) ${fields.join(" ")}`),
      null
    );
    assert.equal(linuxProcessProvesLiveOwnership(
      42,
      `42 (terminal worker) ${fields.join(" ")}`,
      Buffer.from(`${marker}\0`),
      [marker],
      { supervisorPid: 41 }
    ), false);
  }
});

test("Linux fallback identities distinguish a live PID from exit or PID reuse", () => {
  const live = ["S", ...Array.from({ length: 18 }, (_, index) => String(index + 1)), "987654"];
  const reused = [...live.slice(0, 19), "987655"];
  const knownIdentity = linuxProcessIdentityFromStat(
    42,
    `42 (owned worker) ${live.join(" ")}`
  );
  assert.equal(knownIdentity, "42:987654");
  const reusedIdentity = linuxProcessIdentityFromStat(
    42,
    `42 (reused worker) ${reused.join(" ")}`
  );
  assert.equal(linuxKnownProcessIdentityMatches(knownIdentity, knownIdentity), true);
  assert.equal(linuxKnownProcessIdentityMatches(knownIdentity, reusedIdentity), false);
  assert.equal(linuxKnownProcessIdentityMatches(knownIdentity, null), false);
});

test("process start tokens use a stable C locale", () => {
  let invocation = null;
  const token = processStartToken(process.pid, {
    run(binary, args, options) {
      invocation = { binary, args, options };
      return { status: 0, stdout: "Mon Jan  1 00:00:00 2001\n" };
    }
  });
  if (process.platform === "win32") {
    assert.equal(token, null);
    assert.equal(invocation, null);
    return;
  }
  assert.equal(token, "Mon Jan  1 00:00:00 2001");
  assert.deepEqual(invocation.options.env, { LC_ALL: "C", LANG: "C" });
});

test("legacy allowlist exactly covers checked-in literal system-temp allocation patterns", () => {
  const proven = new Set([
    // These wrappers bind their literal prefix to os.tmpdir() or fixed /tmp
    // through a local variable rather than in the same allocation expression.
    "grok-ci-auth-installer-",
    "grok-ci-auth-test-",
    "grok-installed-worker-mcp-",
    "grok-mcp-client-",
    "grok-mcp-reflection-secret-",
    "grok-worker-proof-"
  ]);
  for (const prefix of [
    "fake-grok-ready-duplicate-label-",
    "fake-grok-ready-empty-",
    "fake-grok-ready-empty-labeled-group-",
    "fake-grok-ready-header-only-",
    "fake-grok-ready-impossible-date-",
    "fake-grok-ready-malformed-",
    "fake-grok-ready-malformed-label-",
    "fake-grok-ready-official-empty-",
    "fake-grok-ready-sentinel-with-table-",
    "fake-grok-ready-stderr-only-",
    "fake-grok-ready-summary-only-",
    "fake-grok-ready-warning-row-",
    "grok-rotation-cancel-before-spawn-data-",
    "grok-rotation-foreign-fence-data-",
    "grok-rotation-foreign-intent-data-",
    "grok-rotation-guard-wins-data-",
    "grok-rotation-malformed-intent-data-",
    "grok-rotation-no-child-data-",
    "grok-rotation-pending-recovery-data-",
    "grok-rotation-registered-data-",
    "grok-rotation-unsettled-data-",
    "ledger-fresh-ownerless-",
    "ledger-old-live-owner-",
    "provider-bootstrap-cleanup-winner-data-",
    "provider-bootstrap-guard-wins-data-",
    "provider-bootstrap-late-registration-data-",
    "provider-bootstrap-term-resistant-data-",
    "provider-bootstrap-version-descendant-data-",
    "provider-bootstrap-write-binding-data-",
    "worker-supervisor-cancelled-data-",
    "worker-supervisor-capability-revalidation-data-",
    "worker-supervisor-concurrent-data-",
    "worker-supervisor-durable-binding-data-",
    "worker-supervisor-expired-data-",
    "worker-supervisor-grant-bound-data-",
    "worker-supervisor-intent-data-",
    "worker-supervisor-negative-data-",
    "worker-supervisor-process-data-",
    "worker-supervisor-restart-data-",
    "worker-supervisor-scan-safety-data-",
    "worker-supervisor-terminal-data-"
  ]) proven.add(prefix);
  const files = [
    ...fs.readdirSync(path.join(ROOT, "tests"))
      .filter((name) => name.endsWith(".mjs"))
      .map((name) => path.join(ROOT, "tests", name)),
    ...fs.readdirSync(path.join(ROOT, "scripts"))
      .filter((name) => name.endsWith(".mjs"))
      .map((name) => path.join(ROOT, "scripts", name)),
    path.join(ROOT, "scripts/lib/worker-broker-evidence.mjs")
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const usesSharedHelper = /import\s*\{[\s\S]*?\btempDir\b[\s\S]*?\}\s*from\s*["']\.\/helpers\.mjs["']/u.test(source)
      || file === path.join(ROOT, "tests/helpers.mjs");
    const definesSystemTempHelper = /function\s+tempDir\s*\([^)]*\)\s*\{[\s\S]{0,300}?os\.tmpdir\(\)/u.test(source);
    if (usesSharedHelper || definesSystemTempHelper) {
      for (const match of source.matchAll(/\btempDir\(\s*(["'])([A-Za-z0-9._-]+-)\1/gu)) {
        proven.add(match[2]);
      }
    }
    for (const match of source.matchAll(
      /\bmkdtempSync\(\s*path\.join\(\s*os\.tmpdir\(\)\s*,\s*(["'])([A-Za-z0-9._-]+-)\1/gu
    )) {
      proven.add(match[2]);
    }
  }
  assert.equal(proven.delete(LEGACY_REPOSITORY_PREFIX), true);
  assert.deepEqual([...LEGACY_TEST_TEMP_PREFIXES], [...proven].sort());
});

test("dry-run inventories identity, ownership, age, size, activity, and Git state without deleting", (t) => {
  const root = sandbox(t);
  const eligible = legacy(root);
  fs.writeFileSync(path.join(eligible, "payload"), "fixture");
  age(eligible);
  const result = cleanupTestTemp(options(root));
  const candidate = record(result, eligible);
  assert.equal(result.mode, "dry-run");
  assert.equal(result.removed, 0);
  assert.equal(candidate.eligible, true);
  assert.equal(candidate.uid, process.getuid());
  assert.equal(Number.isSafeInteger(candidate.dev), true);
  assert.equal(Number.isSafeInteger(candidate.ino), true);
  assert.equal(candidate.ageMs >= OLD_MS, true);
  assert.equal(candidate.sizeBytes > 0, true);
  assert.equal(candidate.active, false);
  assert.equal(candidate.registeredWorktree, false);
  assert.equal(fs.existsSync(eligible), true);
});

test("dry-run bounds recursive size measurement without weakening candidate eligibility", (t) => {
  const root = sandbox(t);
  const eligible = legacy(root);
  fs.mkdirSync(path.join(eligible, "nested"));
  fs.writeFileSync(path.join(eligible, "nested", "payload"), "fixture");
  age(eligible);
  const result = cleanupTestTemp(options(root, { sizeScanEntryBudget: 1 }));
  const candidate = record(result, eligible);
  assert.equal(result.sizeScanTruncated, true);
  assert.equal(candidate.sizeBytes, null);
  assert.equal(candidate.sizeTruncated, true);
  assert.equal(candidate.eligible, true);
  assert.equal(fs.existsSync(eligible), true);
});

test("cleanup safety guards fail closed for recent, active, registered, linked, symlink, and owner-mismatched paths", (t) => {
  const root = sandbox(t);
  const recent = legacy(root);
  const active = legacy(root);
  const activeArgv = legacy(root);
  const registered = legacy(root);
  const linked = legacy(root);
  fs.writeFileSync(path.join(linked, ".git"), "gitdir: /outside/repository/worktrees/fixture\n");
  const outside = fs.mkdtempSync(path.join(root, "outside-canary-"));
  fs.writeFileSync(path.join(outside, "keep"), "keep");
  const symlink = path.join(root, `${LEGACY_REPOSITORY_PREFIX}ABC123`);
  fs.symlinkSync(outside, symlink);
  for (const target of [active, activeArgv, registered, linked]) age(target);

  const result = cleanupTestTemp(options(root, {
    openPathsProvider: () => ({
      available: true,
      paths: [path.join(active, "open-file")],
      commands: [
        `node fixture.mjs --workspace ${
          activeArgv.startsWith("/private/") ? activeArgv.slice("/private".length) : activeArgv
        }`
      ]
    }),
    worktreeProvider: () => ({ available: true, paths: [registered] })
  }));
  assert.deepEqual(record(result, recent).reasons, ["too-recent"]);
  assert.ok(record(result, active).reasons.includes("active-process-reference"));
  assert.ok(record(result, activeArgv).reasons.includes("active-process-reference"));
  assert.ok(record(result, registered).reasons.includes("registered-worktree"));
  assert.ok(record(result, linked).reasons.includes("external-worktree-link"));
  assert.ok(record(result, symlink).reasons.includes("not-real-directory"));

  const ownership = cleanupTestTemp(options(root, { expectedUid: process.getuid() + 1 }));
  assert.ok(record(ownership, active).reasons.includes("owner-mismatch"));
  assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "keep");
});

test("cleanup aborts before inventory when active-process visibility is unavailable", (t) => {
  const root = sandbox(t);
  const target = legacy(root);
  age(target);
  const result = cleanupTestTemp(options(root, {
    apply: true,
    openPathsProvider: () => ({ available: false, paths: [], commands: [], reason: "fixture" })
  }));
  assert.equal(result.aborted, true);
  assert.equal(result.reason, "active-process-visibility-unavailable");
  assert.equal(fs.existsSync(target), true);
});

test("cleanup aborts before inventory when worktree visibility is unavailable", (t) => {
  const root = sandbox(t);
  const target = legacy(root);
  age(target);
  const result = cleanupTestTemp(options(root, {
    apply: true,
    worktreeProvider: () => ({ available: false, paths: [], reason: "fixture" })
  }));
  assert.equal(result.aborted, true);
  assert.equal(result.reason, "worktree-visibility-unavailable");
  assert.equal(fs.existsSync(target), true);
});

test("apply refreshes process visibility and aborts remaining deletions on refresh failure", (t) => {
  const root = sandbox(t);
  const target = legacy(root);
  age(target);
  let snapshots = 0;
  const result = cleanupTestTemp(options(root, {
    apply: true,
    snapshotRefreshMs: 0,
    openPathsProvider() {
      snapshots += 1;
      return snapshots < 3
        ? closedPaths()
        : { available: false, paths: [], commands: [], reason: "fixture" };
    }
  }));
  assert.equal(result.aborted, true);
  assert.equal(result.reason, "active-process-visibility-unavailable");
  assert.equal(result.removed, 0);
  assert.equal(fs.existsSync(target), true);
});

test("standalone repositories with linked-worktree metadata and external canaries are preserved", (t) => {
  const root = sandbox(t);
  const target = legacy(root);
  const external = fs.mkdtempSync(path.join(root, "external-worktree-canary-"));
  const sentinel = path.join(external, "keep");
  fs.writeFileSync(sentinel, "keep");
  const metadata = path.join(target, ".git", "worktrees", "linked");
  fs.mkdirSync(metadata, { recursive: true });
  fs.writeFileSync(path.join(metadata, "gitdir"), `${path.join(external, ".git")}\n`);
  age(target);
  const result = cleanupTestTemp(options(root, { apply: true }));
  assert.ok(record(result, target).reasons.includes("git-worktree-metadata"));
  assert.equal(fs.existsSync(target), true);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
});

test("apply rechecks inode identity and preserves a rename-swap replacement", (t) => {
  const root = sandbox(t);
  const target = legacy(root);
  fs.writeFileSync(path.join(target, "original"), "original");
  age(target);
  const moved = `${target}-moved`;
  const result = cleanupTestTemp(options(root, {
    apply: true,
    beforeDelete(candidate) {
      if (candidate.path !== target) return;
      fs.renameSync(target, moved);
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, "replacement"), "replacement");
    }
  }));
  assert.ok(record(result, target).reasons.includes("identity-changed"));
  assert.equal(fs.readFileSync(path.join(target, "replacement"), "utf8"), "replacement");
  assert.equal(fs.readFileSync(path.join(moved, "original"), "utf8"), "original");
});

test("apply preserves a replacement swapped after the final path identity check", (t) => {
  const root = sandbox(t);
  const target = legacy(root);
  fs.writeFileSync(path.join(target, "original"), "original");
  age(target);
  const moved = `${target}-moved-after-check`;
  const result = cleanupTestTemp(options(root, {
    apply: true,
    removeRoot(candidate, identity) {
      fs.renameSync(candidate, moved);
      fs.mkdirSync(candidate);
      fs.writeFileSync(path.join(candidate, "replacement"), "replacement");
      return removeInventoriedTestTempRoot(candidate, identity);
    }
  }));
  assert.ok(record(result, target).reasons.includes("identity-changed"));
  assert.equal(fs.readFileSync(path.join(target, "replacement"), "utf8"), "replacement");
  assert.equal(fs.readFileSync(path.join(moved, "original"), "utf8"), "original");
  assert.equal(
    fs.readdirSync(root).some((name) => name.startsWith(".grok-plugin-cleanup-quarantine-")),
    false
  );
});

test("verified recursive removal has no timeout that can orphan a descendant helper", (t) => {
  const root = sandbox(t);
  const target = legacy(root);
  fs.writeFileSync(path.join(target, "payload"), "payload");
  const identity = fs.lstatSync(target);
  let helperOptions;
  assert.equal(removeInventoriedTestTempRoot(target, identity, {
    run(_executable, _arguments, options) {
      helperOptions = options;
      fs.rmSync(options.cwd, { recursive: true, force: true });
      return { status: 0, error: null, signal: null };
    }
  }), true);
  assert.equal(Object.hasOwn(helperOptions, "timeout"), false);
  assert.doesNotMatch(
    fs.readFileSync(path.join(ROOT, "scripts/lib/test-temp-remove-helper.cjs"), "utf8"),
    /\btimeout\s*:/u
  );
});

test("apply does not count a candidate that disappears during removal", (t) => {
  const root = sandbox(t);
  const target = legacy(root);
  fs.writeFileSync(path.join(target, "payload"), "payload");
  age(target);
  const result = cleanupTestTemp(options(root, {
    apply: true,
    removeRoot(candidate) {
      fs.rmSync(candidate, { recursive: true, force: true });
      return false;
    }
  }));
  const candidate = record(result, target);
  assert.ok(candidate.reasons.includes("candidate-disappeared"));
  assert.notEqual(candidate.removed, true);
  assert.equal(result.removed, 0);
  assert.equal(result.reclaimedBytes, 0);
});

test("apply removes verified old trees with restricted descendants without following symlinks", (t) => {
  const root = sandbox(t);
  const target = legacy(root);
  const restricted = path.join(target, "restricted");
  const outside = fs.mkdtempSync(path.join(root, "outside-canary-"));
  fs.writeFileSync(path.join(outside, "keep"), "keep");
  fs.mkdirSync(restricted);
  fs.writeFileSync(path.join(restricted, "payload"), "payload");
  fs.symlinkSync(outside, path.join(target, "outside-link"));
  fs.chmodSync(restricted, 0o000);
  age(target);
  const result = cleanupTestTemp(options(root, { apply: true }));
  assert.equal(record(result, target).removed, true);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "keep");
});

test("stale manifest-backed crash roots are reaped while an active owner sibling is preserved", (t) => {
  const root = sandbox(t);
  const token = processStartToken(process.pid) || "active-fixture-start-token";
  const stale = createOwnedTestTempRoot({
    base: root,
    prefix: TEST_TEMP_RUN_PREFIX,
    kind: "run",
    pid: process.pid,
    startToken: `${token}-stale`
  });
  const active = createOwnedTestTempRoot({
    base: root,
    prefix: TEST_TEMP_PROCESS_PREFIX,
    kind: "process",
    pid: process.pid,
    startToken: token
  });
  age(stale);
  age(active);
  const result = cleanupTestTemp(options(root, {
    apply: true,
    legacy: false,
    tokenForPid: () => token
  }));
  assert.equal(record(result, stale).removed, true);
  assert.ok(record(result, active).reasons.includes("active-owner"));
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(active), true);
});

test("managed cleanup binds each direct prefix to its exact manifest kind", (t) => {
  const root = sandbox(t);
  const runWithProcessOwner = createOwnedTestTempRoot({
    base: root,
    prefix: TEST_TEMP_RUN_PREFIX,
    kind: "process",
    pid: process.pid,
    startToken: "stale-process-owner"
  });
  const processWithRunOwner = createOwnedTestTempRoot({
    base: root,
    prefix: TEST_TEMP_PROCESS_PREFIX,
    kind: "run",
    pid: process.pid,
    startToken: "stale-run-owner"
  });
  age(runWithProcessOwner);
  age(processWithRunOwner);
  const result = cleanupTestTemp(options(root, {
    apply: true,
    legacy: false
  }));
  assert.ok(record(result, runWithProcessOwner).reasons.includes("manifest-kind-mismatch"));
  assert.ok(record(result, processWithRunOwner).reasons.includes("manifest-kind-mismatch"));
  assert.equal(fs.existsSync(runWithProcessOwner), true);
  assert.equal(fs.existsSync(processWithRunOwner), true);
});

test("opaque owner tokens preserve a managed root while the owner PID remains live", (t) => {
  const root = sandbox(t);
  const target = createOwnedTestTempRoot({
    base: root,
    prefix: TEST_TEMP_RUN_PREFIX,
    kind: "run",
    pid: process.pid,
    startToken: `opaque:${"a".repeat(32)}`
  });
  age(target);
  const result = cleanupTestTemp(options(root, {
    apply: true,
    legacy: false,
    tokenForPid: () => "Mon Jan  1 00:00:00 2001"
  }));
  const candidate = record(result, target);
  assert.ok(candidate.reasons.includes("owner-identity-unavailable"));
  assert.notEqual(candidate.removed, true);
  assert.equal(fs.existsSync(target), true);
});

test("direct node --test helper fallback removes its one process-owned container on normal exit", (t) => {
  const root = sandbox(t);
  const helper = path.join(ROOT, "tests", "helpers.mjs");
  const environment = { ...process.env, TMPDIR: root, TMP: root, TEMP: root };
  delete environment[TEST_TEMP_ROOT_ENV];
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `import { tempDir } from ${JSON.stringify(new URL(`file://${helper}`).href)}; process.stdout.write(tempDir("grok-plugin-repo-"));`
  ], {
    cwd: ROOT,
    env: environment,
    encoding: "utf8",
    shell: false,
    timeout: 10_000
  });
  assert.equal(result.status, 0, result.stderr);
  const processRoot = path.dirname(result.stdout);
  assert.match(path.basename(processRoot), new RegExp(`^${TEST_TEMP_PROCESS_PREFIX}[A-Za-z0-9]{6}$`, "u"));
  assert.equal(fs.existsSync(processRoot), false);
});

test("deterministic runner cleans run and file roots after pass, failure, and timeout results", (t) => {
  const root = sandbox(t);
  const summaries = [
    { status: 0, stdout: '{"reporter":"zero-skip-v2","passed":1,"failed":0,"cancelled":0,"skipped":0,"todo":0,"violations":[],"omittedViolations":0}\n' },
    { status: 1, stdout: '{"reporter":"zero-skip-v2","passed":0,"failed":1,"cancelled":0,"skipped":0,"todo":0,"violations":[],"omittedViolations":1}\n' },
    { status: 124, stdout: "" }
  ];
  for (const fixture of summaries) {
    runDeterministicTestFiles({
      files: ["tests/fixture.test.mjs"],
      root: ROOT,
      reporter: REPORTER,
      tempRoot: root,
      run: () => ({ signal: null, stderr: "", ...fixture }),
      stdout: { write() {} },
      stderr: { write() {} }
    });
    assert.equal(
      fs.readdirSync(root).some((name) => name.startsWith(TEST_TEMP_RUN_PREFIX)),
      false
    );
  }
});

test("deterministic runner preserves one manifest-backed run root when containment is unproven", (t) => {
  const root = sandbox(t);
  let diagnostics = "";
  let launches = 0;
  const status = runDeterministicTestFiles({
    files: ["tests/fixture.test.mjs", "tests/must-not-start.test.mjs"],
    root: ROOT,
    reporter: REPORTER,
    tempRoot: root,
    run: () => {
      launches += 1;
      return {
        status: 126,
        signal: null,
        stderr: "private detail\ngrok-plugin-containment-v1:termination-incomplete-owned\n",
        stdout: ""
      };
    },
    stdout: { write() {} },
    stderr: { write(value) { diagnostics += value; } }
  });
  assert.equal(status, 1);
  assert.match(diagnostics, /containment could not be proven/);
  assert.match(diagnostics, /containment reason: termination-incomplete-owned/);
  assert.doesNotMatch(diagnostics, /private detail/);
  assert.match(diagnostics, /preserved for stale reaping/);
  assert.equal(launches, 1);
  const entries = fs.readdirSync(root);
  assert.equal(entries.filter((name) => name.startsWith(TEST_TEMP_RUN_PREFIX)).length, 1);
});

test("real per-file timeout kills the isolated process group and cleans its temp roots", async (t) => {
  if (process.platform === "win32") return;
  const root = sandbox(t);
  const pidFile = path.join(root, "descendant.pid");
  const fixture = path.join(root, "hang.test.mjs");
  fs.writeFileSync(fixture, [
    'import fs from "node:fs";',
    'import process from "node:process";',
    'import { spawn } from "node:child_process";',
    `const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });`,
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    "setInterval(() => {}, 1000);",
    ""
  ].join("\n"));
  let diagnostics = "";
  const status = runDeterministicTestFiles({
    files: [fixture],
    root: ROOT,
    reporter: REPORTER,
    tempRoot: root,
    timeoutMs: 300,
    stdout: { write() {} },
    stderr: { write(value) { diagnostics += value; } }
  });
  assert.equal(status, 1);
  assert.match(diagnostics, /child 1 timed out/);
  assert.equal(fs.readdirSync(root).some((name) => name.startsWith(TEST_TEMP_RUN_PREFIX)), false);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.equal(await pidIsGone(pid), true);
});

test("supervisor interruption promptly kills a TERM-resistant group and runner cleans temp roots", async (t) => {
  if (process.platform === "win32") return;
  const root = sandbox(t);
  const controlFile = path.join(root, "interrupt-control.json");
  const fixture = path.join(root, "interrupt.test.mjs");
  const driver = path.join(root, "interrupt-driver.mjs");
  fs.writeFileSync(fixture, [
    'import fs from "node:fs";',
    'import process from "node:process";',
    'import { spawn } from "node:child_process";',
    'const child = spawn(process.execPath, ["--eval", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });',
    'process.on("SIGTERM", () => {});',
    `fs.writeFileSync(${JSON.stringify(controlFile)}, JSON.stringify({`,
    "  supervisorPid: Number(process.env.GROK_PLUGIN_TEST_SUPERVISOR_PID),",
    "  fixturePid: process.pid,",
    "  descendantPid: child.pid",
    "}));",
    "setInterval(() => {}, 1000);",
    ""
  ].join("\n"));
  fs.writeFileSync(driver, [
    'import process from "node:process";',
    `import { runDeterministicTestFiles } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "scripts/lib/deterministic-test-runner.mjs")).href)};`,
    `const status = runDeterministicTestFiles({`,
    `  files: [${JSON.stringify(fixture)}],`,
    `  root: ${JSON.stringify(ROOT)},`,
    `  reporter: ${JSON.stringify(REPORTER)},`,
    `  tempRoot: ${JSON.stringify(root)},`,
    "  timeoutMs: 60_000,",
    "  stdout: { write() {} },",
    "  stderr: { write() {} }",
    "});",
    "process.exit(status);",
    ""
  ].join("\n"));
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const runner = spawn(process.execPath, [driver], {
    cwd: ROOT,
    env: environment,
    detached: true,
    stdio: "ignore"
  });
  t.after(() => {
    try { process.kill(-runner.pid, "SIGKILL"); } catch {}
  });
  await waitForPath(controlFile);
  const control = JSON.parse(fs.readFileSync(controlFile, "utf8"));
  assert.equal(Number.isSafeInteger(control.supervisorPid), true);
  assert.equal(Number.isSafeInteger(control.fixturePid), true);
  assert.equal(Number.isSafeInteger(control.descendantPid), true);
  assert.notEqual(
    control.supervisorPid,
    Number(process.env.GROK_PLUGIN_TEST_SUPERVISOR_PID),
    "the nested lifecycle fixture must target its inner supervisor"
  );
  assert.notEqual(
    control.supervisorPid,
    process.pid,
    "the nested lifecycle fixture must not target its parent test process"
  );
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Interrupted runner did not exit.")), 6_000);
    runner.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  const startedAt = Date.now();
  process.kill(control.supervisorPid, "SIGTERM");
  const exit = await exited;
  assert.equal(exit.code, 1);
  assert.equal(exit.signal, null);
  assert.ok(Date.now() - startedAt < 6_000);
  assert.equal(await pidIsGone(control.descendantPid), true);
  assert.equal(fs.readdirSync(root).some((name) => name.startsWith(TEST_TEMP_RUN_PREFIX)), false);
});

test("supervisor reaps a detached Node descendant that requests an empty environment", async (t) => {
  if (process.platform === "win32") return;
  const root = sandbox(t);
  const pidFile = path.join(root, "empty-environment-descendant.pid");
  const fixture = path.join(root, "empty-environment.test.mjs");
  fs.writeFileSync(fixture, [
    'import fs from "node:fs";',
    'import process from "node:process";',
    'import { spawn } from "node:child_process";',
    "const child = spawn(process.execPath, [\"--eval\", \"setInterval(() => {}, 1000)\"], {",
    '  detached: true, env: {}, stdio: "ignore"',
    "});",
    "child.unref();",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    ""
  ].join("\n"));
  let diagnostics = "";
  const status = runDeterministicTestFiles({
    files: [fixture],
    root: ROOT,
    reporter: REPORTER,
    tempRoot: root,
    timeoutMs: 5_000,
    stdout: { write() {} },
    stderr: { write(value) { diagnostics += value; } }
  });
  assert.equal(status, 0, diagnostics);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.equal(await pidIsGone(pid), true);
  assert.equal(fs.readdirSync(root).some((name) => name.startsWith(TEST_TEMP_RUN_PREFIX)), false);
});

test("supervisor ownership survives an execFileSync chain with empty environments", async (t) => {
  if (process.platform === "win32") return;
  const root = sandbox(t);
  const pidFile = path.join(root, "exec-sync-descendant.pid");
  const helper = path.join(root, "exec-sync-helper.mjs");
  const fixture = path.join(root, "exec-sync.test.mjs");
  fs.writeFileSync(helper, [
    'import fs from "node:fs";',
    'import process from "node:process";',
    'import { spawn } from "node:child_process";',
    "const child = spawn(process.execPath, [\"--eval\", \"setInterval(() => {}, 1000)\"], {",
    '  detached: true, env: {}, stdio: "ignore"',
    "});",
    "child.unref();",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    ""
  ].join("\n"));
  fs.writeFileSync(fixture, [
    'import process from "node:process";',
    'import { execFileSync } from "node:child_process";',
    `execFileSync(process.execPath, [${JSON.stringify(helper)}], { env: {}, stdio: "ignore" });`,
    ""
  ].join("\n"));
  let diagnostics = "";
  const status = runDeterministicTestFiles({
    files: [fixture],
    root: ROOT,
    reporter: REPORTER,
    tempRoot: root,
    timeoutMs: 5_000,
    stdout: { write() {} },
    stderr: { write(value) { diagnostics += value; } }
  });
  assert.equal(status, 0, diagnostics);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.equal(await pidIsGone(pid), true);
  assert.equal(fs.readdirSync(root).some((name) => name.startsWith(TEST_TEMP_RUN_PREFIX)), false);
});

test("sync child-process options-only overloads preserve ownership and compatibility", async (t) => {
  if (process.platform === "win32") return;
  const root = sandbox(t);
  const spawnPidFile = path.join(root, "spawn-sync-options-only.pid");
  const execPidFile = path.join(root, "exec-file-sync-options-only.pid");
  const spawnHelper = path.join(root, "spawn-sync-options-only");
  const execHelper = path.join(root, "exec-file-sync-options-only");
  const fixture = path.join(root, "sync-options-only.test.mjs");
  const helperSource = (pidFile) => [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    'const process = require("node:process");',
    'const { spawn } = require("node:child_process");',
    "const child = spawn(process.execPath, [\"--eval\", \"setInterval(() => {}, 1000)\"], {",
    '  detached: true, env: {}, stdio: "ignore"',
    "});",
    "child.unref();",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    ""
  ].join("\n");
  fs.writeFileSync(spawnHelper, helperSource(spawnPidFile));
  fs.writeFileSync(execHelper, helperSource(execPidFile));
  fs.chmodSync(spawnHelper, 0o700);
  fs.chmodSync(execHelper, 0o700);
  fs.writeFileSync(fixture, [
    'import { execFileSync, spawnSync } from "node:child_process";',
    `const spawned = spawnSync(${JSON.stringify(spawnHelper)}, { env: {}, stdio: "ignore" });`,
    'if (spawned.status !== 0) throw new Error("options-only spawnSync failed");',
    `execFileSync(${JSON.stringify(execHelper)}, { env: {}, stdio: "ignore" });`,
    ""
  ].join("\n"));
  let diagnostics = "";
  const status = runDeterministicTestFiles({
    files: [fixture],
    root: ROOT,
    reporter: REPORTER,
    tempRoot: root,
    timeoutMs: 5_000,
    stdout: { write() {} },
    stderr: { write(value) { diagnostics += value; } }
  });
  assert.equal(status, 0, diagnostics);
  for (const pidFile of [spawnPidFile, execPidFile]) {
    assert.equal(await pidIsGone(Number(fs.readFileSync(pidFile, "utf8"))), true);
  }
  assert.equal(fs.readdirSync(root).some((name) => name.startsWith(TEST_TEMP_RUN_PREFIX)), false);
});

test("representative passing file run twice leaves no temp growth or surviving child", async (t) => {
  if (process.platform === "win32") return;
  const root = sandbox(t);
  const foreign = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore"
  });
  t.after(() => {
    try { process.kill(-foreign.pid, "SIGKILL"); } catch {}
  });
  const fixture = path.join(root, "pass-with-child.test.mjs");
  fs.writeFileSync(fixture, [
    'import fs from "node:fs";',
    'import process from "node:process";',
    'import { spawn } from "node:child_process";',
    'import test from "node:test";',
    'test("pass", () => {',
    '  const childEnvironment = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };',
    '  const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { detached: true, env: childEnvironment, stdio: "ignore" });',
    '  child.unref();',
    '  fs.writeFileSync(process.env.DESCENDANT_PID_FILE, String(child.pid));',
    "});",
    ""
  ].join("\n"));
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const pidFile = path.join(root, `pass-descendant-${iteration}.pid`);
    const status = runDeterministicTestFiles({
      files: [fixture],
      root: ROOT,
      reporter: REPORTER,
      tempRoot: root,
      env: { ...process.env, DESCENDANT_PID_FILE: pidFile },
      stdout: { write() {} },
      stderr: { write() {} }
    });
    assert.equal(status, 0);
    assert.equal(fs.readdirSync(root).some((name) => name.startsWith(TEST_TEMP_RUN_PREFIX)), false);
    assert.equal(await pidIsGone(Number(fs.readFileSync(pidFile, "utf8"))), true);
    assert.equal(await pidIsGone(foreign.pid, 100), false);
  }
});
