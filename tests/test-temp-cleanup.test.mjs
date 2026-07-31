import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { cleanupExitCode, parseCleanupArgs } from "../scripts/cleanup-test-temp.mjs";
import {
  runDeterministicTestFiles,
  runDeterministicTestFilesCli
} from "../scripts/lib/deterministic-test-runner.mjs";
import {
  environmentProvesOwnership,
  linuxKnownProcessIdentityMatches,
  linuxProcessGroupMemberFromStat,
  linuxProcessIdentityFromStat,
  linuxProcessProvesLiveOwnership,
  processGroupAlive,
  signalOwnedGroup
} from "../scripts/lib/test-temp-supervisor.mjs";
import {
  LEGACY_REPOSITORY_PREFIX,
  LEGACY_TEST_TEMP_PREFIXES,
  captureRegisteredWorktrees,
  cleanupTestTemp,
  removeInventoriedTestTempRoot
} from "../scripts/lib/test-temp-cleanup.mjs";
import {
  TEST_TEMP_MANIFEST,
  TEST_TEMP_PROCESS_PREFIX,
  TEST_TEMP_RUN_PREFIX,
  createOwnedTestTempRoot,
  processStartToken,
  removeOwnedTestTempRoot
} from "../scripts/lib/test-temp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORTER = path.join(ROOT, "scripts/lib/zero-skip-test-reporter.mjs");
const REMOVE_HELPER = path.join(ROOT, "scripts/lib/test-temp-remove-helper.cjs");
const CHILD_HOOK = path.join(ROOT, "scripts/lib/test-temp-child-hook.cjs");
const PIDFD_SIGNAL_HELPER = path.join(ROOT, "scripts/lib/test-temp-pidfd-signal.py");
const SUPERVISOR = path.join(ROOT, "scripts/lib/test-temp-supervisor.mjs");
const OLD_MS = 2 * 60 * 60_000;
const TEST_OWNERSHIP_ENVIRONMENT_KEYS = Object.freeze([
  "GROK_PLUGIN_TEST_CHILD_HOOK_BYPASS",
  "GROK_PLUGIN_TEST_PID_REGISTRY",
  "GROK_PLUGIN_TEST_PID_REGISTRY_SECRET",
  "GROK_PLUGIN_TEST_SUPERVISOR_PID",
  "GROK_PLUGIN_TEST_SUPERVISOR_TOKEN",
  "GROK_PLUGIN_TEST_TEMP_ROOT",
  "NODE_OPTIONS"
]);

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

test("macOS never signals a bare stale or reused process-group identity", () => {
  const signals = [];
  const child = {
    pid: 42_424,
    kill(signal) {
      signals.push(signal);
    }
  };
  assert.equal(signalOwnedGroup(child, "SIGKILL", { platform: "darwin" }), false);
  assert.deepEqual(signals, []);
});

test("POSIX liveness never trusts a live group that may reuse a closed child's PGID", (t) => {
  if (process.platform === "win32") return;
  const foreign = spawn(
    process.execPath,
    ["--eval", "setInterval(() => {}, 1000)"],
    { detached: true, stdio: "ignore" }
  );
  t.after(() => {
    try { process.kill(-foreign.pid, "SIGKILL"); } catch {}
  });
  const closedChild = {
    pid: foreign.pid,
    exitCode: 0,
    signalCode: null
  };
  assert.equal(processGroupAlive(closedChild, { platform: "linux" }), false);
  assert.equal(processGroupAlive(closedChild, { platform: "darwin" }), false);
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

test("Linux pidfd helper refuses a reused identity and signals only the pinned process", async (t) => {
  if (process.platform !== "linux") return;
  const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  t.after(() => {
    try { child.kill("SIGKILL"); } catch {}
  });
  const stat = fs.readFileSync(`/proc/${child.pid}/stat`, "utf8");
  const identity = linuxProcessIdentityFromStat(child.pid, stat);
  assert.ok(identity);
  const [pid, startTime] = identity.split(":");
  const mismatch = spawnSync("/usr/bin/python3", [
    PIDFD_SIGNAL_HELPER,
    `${pid}:${BigInt(startTime) + 1n}`,
    "SIGKILL"
  ], {
    env: { GROK_PLUGIN_TEST_CHILD_HOOK_BYPASS: "1" },
    encoding: "utf8",
    shell: false
  });
  assert.equal(mismatch.status, 3);
  assert.doesNotThrow(() => process.kill(child.pid, 0));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const signaled = spawnSync("/usr/bin/python3", [
    PIDFD_SIGNAL_HELPER,
    identity,
    "SIGKILL"
  ], {
    env: { GROK_PLUGIN_TEST_CHILD_HOOK_BYPASS: "1" },
    encoding: "utf8",
    shell: false
  });
  assert.equal(signaled.status, 0);
  await exited;
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
    // Historical prefix retained so legacy cleanup remains source-proven after
    // shortening the fixture path for macOS filename-component limits.
    "deep-research-pinned-plugin-",
    "grok-installed-worker-mcp-",
    "grok-mcp-client-",
    "grok-mcp-reflection-secret-",
    "grok-plugin-test-",
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

test("worktree visibility uses a bounded scan window", () => {
  const calls = [];
  const result = captureRegisteredWorktrees(ROOT, {
    run(binary, args, options) {
      calls.push({ binary, args, options });
      return {
        status: 0,
        stdout: "worktree /private/tmp/grok-plugin-visible\n"
      };
    }
  });
  assert.deepEqual(result, {
    available: true,
    paths: ["/private/tmp/grok-plugin-visible"]
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["worktree", "list", "--porcelain"]);
  assert.equal(calls[0].options.cwd, ROOT);
  assert.equal(calls[0].options.timeout, 120_000);
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

test("apply restores a quarantined candidate when a fresh snapshot finds activity", (t) => {
  const root = sandbox(t);
  const target = legacy(root);
  fs.writeFileSync(path.join(target, "payload"), "payload");
  age(target);
  let snapshots = 0;
  const result = cleanupTestTemp(options(root, {
    apply: true,
    openPathsProvider() {
      snapshots += 1;
      if (snapshots < 3) return closedPaths();
      const quarantine = fs.readdirSync(root)
        .find((name) => name.startsWith(".grok-plugin-cleanup-quarantine-"));
      return quarantine
        ? {
            available: true,
            paths: [path.join(root, quarantine, "payload")],
            commands: []
          }
        : closedPaths();
    }
  }));
  const candidate = record(result, target);
  assert.ok(candidate.reasons.includes("active-process-reference"));
  assert.equal(candidate.removed, undefined);
  assert.equal(fs.readFileSync(path.join(target, "payload"), "utf8"), "payload");
  assert.equal(
    fs.readdirSync(root).some((name) => name.startsWith(".grok-plugin-cleanup-quarantine-")),
    false
  );
});

test("apply aborts and restores quarantine when post-rename visibility is lost", (t) => {
  const root = sandbox(t);
  const target = legacy(root);
  fs.writeFileSync(path.join(target, "payload"), "payload");
  age(target);
  let snapshots = 0;
  const result = cleanupTestTemp(options(root, {
    apply: true,
    openPathsProvider() {
      snapshots += 1;
      return snapshots < 3
        ? closedPaths()
        : { available: false, paths: [], commands: [], reason: "fixture" };
    }
  }));
  assert.equal(result.aborted, true);
  assert.equal(result.reason, "active-process-visibility-unavailable");
  assert.ok(record(result, target).reasons.includes("remove-failed"));
  assert.equal(fs.readFileSync(path.join(target, "payload"), "utf8"), "payload");
});

test("apply restores quarantine when a fresh worktree snapshot registers the candidate", (t) => {
  const root = sandbox(t);
  const target = legacy(root);
  fs.writeFileSync(path.join(target, "payload"), "payload");
  age(target);
  let snapshots = 0;
  const result = cleanupTestTemp(options(root, {
    apply: true,
    worktreeProvider() {
      snapshots += 1;
      return {
        available: true,
        paths: snapshots < 3 ? [] : [target]
      };
    }
  }));
  assert.equal(result.aborted, false);
  assert.ok(record(result, target).reasons.includes("registered-worktree"));
  assert.equal(fs.readFileSync(path.join(target, "payload"), "utf8"), "payload");
});

test("managed apply restores a same-size in-place owner manifest rewrite after quarantine", (t) => {
  if (process.platform === "win32") return;
  const liveToken = processStartToken(process.pid);
  if (!liveToken) {
    t.skip("A stable process-start token is required.");
    return;
  }
  const root = sandbox(t);
  const staleToken = `${liveToken[0] === "X" ? "Y" : "X"}${liveToken.slice(1)}`;
  const target = createOwnedTestTempRoot({
    base: root,
    prefix: TEST_TEMP_PROCESS_PREFIX,
    kind: "process",
    pid: process.pid,
    startToken: staleToken
  });
  const outside = fs.mkdtempSync(path.join(root, "manifest-race-outside-"));
  const canary = path.join(outside, "keep");
  fs.writeFileSync(canary, "keep");
  const manifestPath = path.join(target, TEST_TEMP_MANIFEST);
  const fixedTime = new Date(Math.floor((Date.now() - OLD_MS) / 1_000) * 1_000);
  fs.utimesSync(manifestPath, fixedTime, fixedTime);
  const initialManifestStat = fs.lstatSync(manifestPath);
  const initialManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const freshContents = Buffer.from(`${JSON.stringify({
    ...initialManifest,
    startToken: liveToken
  })}\n`);
  assert.equal(freshContents.length, initialManifestStat.size);
  age(target);

  const result = cleanupTestTemp(options(root, {
    apply: true,
    legacy: false,
    tokenForPid: (pid) => (pid === process.pid ? liveToken : null),
    beforeDelete(candidate) {
      if (candidate.path !== target) return;
      const descriptor = fs.openSync(manifestPath, "r+");
      try {
        fs.writeSync(descriptor, freshContents, 0, freshContents.length, 0);
        fs.ftruncateSync(descriptor, freshContents.length);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.utimesSync(
        manifestPath,
        initialManifestStat.atime,
        initialManifestStat.mtime
      );
      const rewrittenStat = fs.lstatSync(manifestPath);
      assert.equal(rewrittenStat.size, initialManifestStat.size);
      assert.equal(rewrittenStat.mtimeMs, initialManifestStat.mtimeMs);
    }
  }));

  const candidate = record(result, target);
  assert.equal(candidate.removed, undefined);
  assert.ok(candidate.reasons.includes("owner-manifest-changed"));
  assert.equal(fs.existsSync(target), true);
  assert.equal(
    JSON.parse(fs.readFileSync(manifestPath, "utf8")).startToken,
    liveToken
  );
  assert.equal(fs.readFileSync(canary, "utf8"), "keep");
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

test("restricted descendant cleanup is inode-pinned on Linux and otherwise reports safely", (t) => {
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
  if (process.platform === "linux") {
    assert.equal(record(result, target).removed, true);
    assert.equal(fs.existsSync(target), false);
  } else {
    assert.ok(record(result, target).reasons.includes("remove-failed"));
    assert.equal(fs.existsSync(target), true);
    fs.chmodSync(restricted, 0o700);
  }
  assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "keep");
});

test("recursive permission repair cannot chmod through a raced symlink", (t) => {
  if (process.platform === "win32") return;
  const root = sandbox(t);
  const target = legacy(root);
  const restricted = path.join(target, "restricted");
  const moved = path.join(target, "restricted-original");
  const outside = fs.mkdtempSync(path.join(root, "outside-mode-canary-"));
  const preload = path.join(root, "swap-before-open.cjs");
  fs.mkdirSync(restricted);
  fs.chmodSync(restricted, 0o000);
  fs.chmodSync(outside, 0o500);
  fs.writeFileSync(preload, [
    '"use strict";',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `const restricted = ${JSON.stringify(restricted)};`,
    `const moved = ${JSON.stringify(moved)};`,
    `const outside = ${JSON.stringify(outside)};`,
    "const originalOpenSync = fs.openSync;",
    "const originalChmodSync = fs.chmodSync;",
    "const originalLchmodSync = fs.lchmodSync;",
    "const originalRenameSync = fs.renameSync;",
    "const originalSymlinkSync = fs.symlinkSync;",
    "let swapped = false;",
    "function swap(targetPath) {",
    "  if (swapped || path.resolve(String(targetPath)) !== restricted) return;",
    "  swapped = true;",
    "  originalRenameSync(restricted, moved);",
    "  originalSymlinkSync(outside, restricted);",
    "}",
    "fs.openSync = function(targetPath, ...args) {",
    "  swap(targetPath);",
    "  return originalOpenSync.call(fs, targetPath, ...args);",
    "};",
    "fs.chmodSync = function(targetPath, ...args) {",
    "  swap(targetPath);",
    "  return originalChmodSync.call(fs, targetPath, ...args);",
    "};",
    "if (typeof originalLchmodSync === \"function\") {",
    "  fs.lchmodSync = function(targetPath, ...args) {",
    "    swap(targetPath);",
    "    return originalLchmodSync.call(fs, targetPath, ...args);",
    "  };",
    "}",
    ""
  ].join("\n"));
  const identity = fs.lstatSync(target);
  const result = spawnSync(process.execPath, [
    REMOVE_HELPER,
    String(identity.dev),
    String(identity.ino)
  ], {
    cwd: target,
    env: {
      GROK_PLUGIN_TEST_CHILD_HOOK_BYPASS: "1",
      NODE_OPTIONS: `--require=${preload}`
    },
    encoding: "utf8",
    shell: false
  });
  assert.notEqual(result.status, 0);
  assert.equal(fs.statSync(outside).mode & 0o777, 0o500);
  fs.chmodSync(moved, 0o700);
  fs.chmodSync(outside, 0o700);
});

test("recursive permission repair cannot chmod a raced real-directory replacement", (t) => {
  if (process.platform === "win32") return;
  const root = sandbox(t);
  const target = legacy(root);
  const restricted = path.join(target, "restricted");
  const moved = path.join(target, "restricted-original");
  const replacement = path.join(target, "zz-replacement-source");
  const preload = path.join(root, "swap-real-directory-before-open.cjs");
  fs.mkdirSync(restricted);
  fs.mkdirSync(replacement);
  fs.chmodSync(restricted, 0o000);
  fs.chmodSync(replacement, 0o500);
  fs.writeFileSync(preload, [
    '"use strict";',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `const restricted = ${JSON.stringify(restricted)};`,
    `const moved = ${JSON.stringify(moved)};`,
    `const replacement = ${JSON.stringify(replacement)};`,
    "const originalOpenSync = fs.openSync;",
    "const originalRenameSync = fs.renameSync;",
    "let swapped = false;",
    "fs.openSync = function(targetPath, ...args) {",
    "  if (!swapped && path.resolve(String(targetPath)) === restricted) {",
    "    swapped = true;",
    "    originalRenameSync(restricted, moved);",
    "    originalRenameSync(replacement, restricted);",
    "  }",
    "  return originalOpenSync.call(fs, targetPath, ...args);",
    "};",
    ""
  ].join("\n"));
  const identity = fs.lstatSync(target);
  const result = spawnSync(process.execPath, [
    REMOVE_HELPER,
    String(identity.dev),
    String(identity.ino)
  ], {
    cwd: target,
    env: {
      GROK_PLUGIN_TEST_CHILD_HOOK_BYPASS: "1",
      NODE_OPTIONS: `--require=${preload}`
    },
    encoding: "utf8",
    shell: false
  });
  assert.notEqual(result.status, 0);
  assert.equal(fs.statSync(restricted).mode & 0o777, 0o500);
  fs.chmodSync(restricted, 0o700);
  fs.chmodSync(moved, 0o700);
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
  const helper = path.join(ROOT, "tests", "direct-temp-fallback-child.mjs");
  const environment = {
    ...process.env,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    GROK_PLUGIN_TEST_CHILD_HOOK_BYPASS: "1"
  };
  for (const key of TEST_OWNERSHIP_ENVIRONMENT_KEYS) delete environment[key];
  environment.GROK_PLUGIN_TEST_CHILD_HOOK_BYPASS = "1";
  const result = spawnSync(process.execPath, [helper], {
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

test("deterministic runner preserves an outside canary swapped into an owned file-root path", (t) => {
  if (process.platform === "win32") return;
  const root = sandbox(t);
  const canary = path.join(root, "outside-runner-canary");
  const marker = path.join(canary, "must-survive.txt");
  const controlFile = path.join(root, "swapped-file-root.txt");
  const fixture = path.join(root, "swap-owned-root.test.mjs");
  fs.mkdirSync(canary);
  fs.writeFileSync(marker, "outside\n");
  fs.writeFileSync(fixture, [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'import process from "node:process";',
    'import test from "node:test";',
    'test("swap owned root", () => {',
    "  const ownedRoot = process.env.TMPDIR;",
    '  const registryName = ".grok-plugin-owned-pids";',
    "  const originalRoot = `${ownedRoot}-original`;",
    `  fs.writeFileSync(${JSON.stringify(controlFile)}, ownedRoot);`,
    `  fs.linkSync(path.join(ownedRoot, registryName), path.join(${JSON.stringify(canary)}, registryName));`,
    "  fs.renameSync(ownedRoot, originalRoot);",
    `  fs.renameSync(${JSON.stringify(canary)}, ownedRoot);`,
    "});",
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
  const swappedRoot = fs.readFileSync(controlFile, "utf8");
  assert.equal(status, 1);
  assert.match(
    diagnostics,
    /(?:temp cleanup failed|containment could not be proven)/
  );
  assert.match(diagnostics, /run temp root was preserved/);
  assert.equal(fs.readFileSync(path.join(swappedRoot, "must-survive.txt"), "utf8"), "outside\n");
  assert.equal(
    fs.readdirSync(root).filter((name) => name.startsWith(TEST_TEMP_RUN_PREFIX)).length,
    1
  );
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

test("sync deterministic runner preserves its run root on bounded-output containment failures", (t) => {
  for (const errorCode of ["ENOBUFS", "E_TEST_TEMP_CONTAINMENT"]) {
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
          status: null,
          signal: null,
          error: { code: errorCode },
          stderr: "",
          stdout: ""
        };
      },
      stdout: { write() {} },
      stderr: { write(value) { diagnostics += value; } }
    });
    assert.equal(status, 1, errorCode);
    assert.equal(launches, 1, errorCode);
    assert.match(diagnostics, /containment could not be proven/, errorCode);
    assert.match(diagnostics, /preserved for stale reaping/, errorCode);
    assert.equal(
      fs.readdirSync(root).filter((name) => name.startsWith(TEST_TEMP_RUN_PREFIX)).length,
      1,
      errorCode
    );
  }
});

test("startup visibility failure is containment failure, not generic cleanup", (t) => {
  const root = sandbox(t);
  const fixture = path.join(root, "startup-visibility.test.mjs");
  fs.writeFileSync(fixture, 'import test from "node:test"; test("never starts", () => {});\n');
  let diagnostics = "";
  const status = runDeterministicTestFiles({
    files: [fixture],
    root: ROOT,
    reporter: REPORTER,
    tempRoot: root,
    timeoutMs: 5_000,
    simulateStartupVisibilityFailure: true,
    stdout: { write() {} },
    stderr: { write(value) { diagnostics += value; } }
  });
  assert.equal(status, 1);
  assert.match(diagnostics, /containment could not be proven/);
  assert.match(diagnostics, /containment reason: startup-visibility/);
  assert.equal(
    fs.readdirSync(root).filter((name) => name.startsWith(TEST_TEMP_RUN_PREFIX)).length,
    1
  );
});

test("async CLI settles an error without close and removes roots when no PID exists", {
  timeout: 5_000
}, async (t) => {
  const root = sandbox(t);
  const fixture = path.join(root, "never-starts.test.mjs");
  fs.writeFileSync(fixture, 'import test from "node:test"; test("never starts", () => {});\n');
  const supervisor = new EventEmitter();
  supervisor.exitCode = null;
  supervisor.signalCode = null;
  supervisor.stdout = new PassThrough();
  supervisor.stderr = new PassThrough();
  supervisor.kill = () => true;
  let diagnostics = "";
  let output = "";
  const startedAt = Date.now();
  queueMicrotask(() => supervisor.emit("error", new Error("synthetic spawn failure")));
  const status = await runDeterministicTestFilesCli({
    files: [fixture],
    root: ROOT,
    reporter: REPORTER,
    spawnProcess: () => supervisor,
    tempRoot: root,
    timeoutMs: 500,
    stdout: { write(value) { output += value; } },
    stderr: { write(value) { diagnostics += value; } }
  });
  assert.equal(status, 1);
  assert.ok(Date.now() - startedAt < 5_000);
  assert.match(diagnostics, /child 1 could not start/);
  assert.doesNotMatch(diagnostics, /containment could not be proven/);
  assert.deepEqual(JSON.parse(output.trim()), {
    reporter: "zero-skip-v2",
    passed: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    violations: [],
    omittedViolations: 0
  });
  assert.equal(
    fs.readdirSync(root).some((name) => name.startsWith(TEST_TEMP_RUN_PREFIX)),
    false
  );
});

test("async CLI preserves roots when a PID-bearing error precedes a late close", {
  timeout: 5_000
}, async (t) => {
  const root = sandbox(t);
  const fixture = path.join(root, "uncertain-start.test.mjs");
  fs.writeFileSync(fixture, 'import test from "node:test"; test("never starts", () => {});\n');
  const supervisor = new EventEmitter();
  supervisor.pid = 424_242;
  supervisor.exitCode = null;
  supervisor.signalCode = null;
  supervisor.stdout = new PassThrough();
  supervisor.stderr = new PassThrough();
  supervisor.kill = () => true;
  let diagnostics = "";
  let output = "";
  queueMicrotask(() => {
    supervisor.emit("error", new Error("synthetic PID-bearing failure"));
    supervisor.emit("close", 0, null);
  });
  const status = await runDeterministicTestFilesCli({
    files: [fixture],
    root: ROOT,
    reporter: REPORTER,
    spawnProcess: () => supervisor,
    tempRoot: root,
    timeoutMs: 500,
    stdout: { write(value) { output += value; } },
    stderr: { write(value) { diagnostics += value; } }
  });
  assert.equal(status, 1);
  assert.match(diagnostics, /containment could not be proven/);
  assert.match(diagnostics, /run temp root was preserved/);
  assert.doesNotMatch(diagnostics, /child 1 could not start/);
  assert.deepEqual(JSON.parse(output.trim()), {
    reporter: "zero-skip-v2",
    passed: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    violations: [],
    omittedViolations: 0
  });
  assert.equal(
    fs.readdirSync(root).filter((name) => name.startsWith(TEST_TEMP_RUN_PREFIX)).length,
    1
  );
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

test("ordinary process-group interruption cleans the run root and preserves a foreign process", async (t) => {
  if (process.platform === "win32") return;
  const root = sandbox(t);
  const controlFile = path.join(root, "group-interrupt-control.json");
  const fixture = path.join(root, "group-interrupt.test.mjs");
  const driver = path.join(root, "group-interrupt-driver.mjs");
  fs.writeFileSync(fixture, [
    'import fs from "node:fs";',
    'import process from "node:process";',
    'import { spawn } from "node:child_process";',
    'const child = spawn(process.execPath, ["--eval", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });',
    'process.on("SIGTERM", () => {});',
    `fs.writeFileSync(${JSON.stringify(controlFile)}, JSON.stringify({`,
    "  fixturePid: process.pid,",
    "  descendantPid: child.pid",
    "}));",
    "setInterval(() => {}, 1000);",
    ""
  ].join("\n"));
  fs.writeFileSync(driver, [
    'import process from "node:process";',
    `import { runDeterministicTestFiles } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "scripts/lib/deterministic-test-runner.mjs")).href)};`,
    "const status = runDeterministicTestFiles({",
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
  const foreign = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
    cwd: ROOT,
    env: environment,
    detached: true,
    stdio: "ignore"
  });
  t.after(() => {
    try { process.kill(-runner.pid, "SIGKILL"); } catch {}
    try { process.kill(-foreign.pid, "SIGKILL"); } catch {}
  });
  await waitForPath(controlFile);
  const control = JSON.parse(fs.readFileSync(controlFile, "utf8"));
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Interrupted runner did not exit.")), 6_000);
    runner.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  process.kill(-runner.pid, "SIGINT");
  const exit = await exited;
  assert.deepEqual(exit, { code: 1, signal: null });
  assert.equal(await pidIsGone(control.fixturePid), true);
  assert.equal(await pidIsGone(control.descendantPid), true);
  assert.doesNotThrow(() => process.kill(foreign.pid, 0));
  assert.equal(
    fs.readdirSync(root).some((name) => name.startsWith(TEST_TEMP_RUN_PREFIX)),
    false
  );
});

test("direct CLI PID interruption before supervisor readiness launches no test command", async (t) => {
  if (process.platform === "win32") return;
  const root = sandbox(t);
  const readyFile = path.join(root, "pre-ready-supervisor.json");
  const fixtureControlFile = path.join(root, "pre-ready-fixture.json");
  const fixture = path.join(root, "pre-ready-interrupt.test.mjs");
  const driver = path.join(root, "pre-ready-interrupt-driver.mjs");
  fs.writeFileSync(fixture, [
    'import fs from "node:fs";',
    'import process from "node:process";',
    'import { spawn } from "node:child_process";',
    'const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });',
    `fs.writeFileSync(${JSON.stringify(fixtureControlFile)}, JSON.stringify({`,
    "  fixturePid: process.pid,",
    "  descendantPid: child.pid",
    "}));",
    "setInterval(() => {}, 1000);",
    ""
  ].join("\n"));
  fs.writeFileSync(driver, [
    'import fs from "node:fs";',
    'import process from "node:process";',
    `import { runDeterministicTestFilesCli } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "scripts/lib/deterministic-test-runner.mjs")).href)};`,
    "const status = await runDeterministicTestFilesCli({",
    `  files: [${JSON.stringify(fixture)}],`,
    `  root: ${JSON.stringify(ROOT)},`,
    `  reporter: ${JSON.stringify(REPORTER)},`,
    `  tempRoot: ${JSON.stringify(root)},`,
    "  timeoutMs: 60_000,",
    "  testPreCommandDelayMs: 30_000,",
    "  onTestSupervisorPreCommandReady({ supervisorPid }) {",
    `    fs.writeFileSync(${JSON.stringify(readyFile)}, JSON.stringify({ supervisorPid }));`,
    "  },",
    "  stdout: { write() {} },",
    "  stderr: { write() {} }",
    "});",
    "process.exitCode = status;",
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
  const foreign = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
    cwd: ROOT,
    env: environment,
    detached: true,
    stdio: "ignore"
  });
  let supervisorPid = null;
  let fixtureControl = null;
  t.after(() => {
    for (const pid of [
      runner.pid,
      supervisorPid,
      fixtureControl?.fixturePid,
      fixtureControl?.descendantPid,
      foreign.pid
    ]) {
      if (!Number.isSafeInteger(pid)) continue;
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  });
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Pre-ready interrupted CLI did not exit.")), 8_000);
    runner.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  await waitForPath(readyFile);
  ({ supervisorPid } = JSON.parse(fs.readFileSync(readyFile, "utf8")));
  assert.equal(Number.isSafeInteger(supervisorPid), true);
  assert.equal(fs.existsSync(fixtureControlFile), false);

  const startedAt = Date.now();
  process.kill(runner.pid, "SIGTERM");
  const exit = await exited;
  assert.deepEqual(exit, { code: 1, signal: null });
  assert.ok(Date.now() - startedAt < 8_000);
  assert.equal(await pidIsGone(supervisorPid), true);
  if (fs.existsSync(fixtureControlFile)) {
    fixtureControl = JSON.parse(fs.readFileSync(fixtureControlFile, "utf8"));
    assert.equal(await pidIsGone(fixtureControl.fixturePid), true);
    assert.equal(await pidIsGone(fixtureControl.descendantPid), true);
  }
  assert.equal(fs.existsSync(fixtureControlFile), false);
  assert.doesNotThrow(() => process.kill(foreign.pid, 0));
  assert.equal(
    fs.readdirSync(root).some((name) => name.startsWith(TEST_TEMP_RUN_PREFIX)),
    false
  );
});

test("direct CLI PID interruption reaches the supervisor and preserves a foreign process", async (t) => {
  if (process.platform === "win32") return;
  for (const relative of [
    "scripts/test-deterministic.mjs",
    "scripts/test-phase1-focused.mjs",
    "scripts/test-phase2-focused.mjs",
    "scripts/test-phase3-focused.mjs"
  ]) {
    const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
    assert.match(source, /\brunDeterministicTestFilesCli\b/u, relative);
    assert.match(source, /process\.exitCode\s*=\s*await\b/u, relative);
  }
  const root = sandbox(t);
  const controlFile = path.join(root, "direct-pid-interrupt-control.json");
  const fixture = path.join(root, "direct-pid-interrupt.test.mjs");
  const driver = path.join(root, "direct-pid-interrupt-driver.mjs");
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
    `import { runDeterministicTestFilesCli } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "scripts/lib/deterministic-test-runner.mjs")).href)};`,
    "const status = await runDeterministicTestFilesCli({",
    `  files: [${JSON.stringify(fixture)}],`,
    `  root: ${JSON.stringify(ROOT)},`,
    `  reporter: ${JSON.stringify(REPORTER)},`,
    `  tempRoot: ${JSON.stringify(root)},`,
    "  timeoutMs: 60_000,",
    "  stdout: { write() {} },",
    "  stderr: { write() {} }",
    "});",
    "process.exitCode = status;",
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
  const foreign = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
    cwd: ROOT,
    env: environment,
    detached: true,
    stdio: "ignore"
  });
  let control = null;
  t.after(() => {
    for (const pid of [
      runner.pid,
      control?.supervisorPid,
      control?.fixturePid,
      control?.descendantPid,
      foreign.pid
    ]) {
      if (!Number.isSafeInteger(pid)) continue;
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  });
  await waitForPath(controlFile);
  control = JSON.parse(fs.readFileSync(controlFile, "utf8"));
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Directly interrupted CLI did not exit.")), 8_000);
    runner.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  const startedAt = Date.now();
  process.kill(runner.pid, "SIGTERM");
  const exit = await exited;
  const elapsedMs = Date.now() - startedAt;
  assert.deepEqual(exit, { code: 1, signal: null });
  assert.ok(elapsedMs < 8_000);
  assert.ok(elapsedMs < 60_000 / 4);
  assert.equal(await pidIsGone(control.supervisorPid), true);
  assert.equal(await pidIsGone(control.fixturePid), true);
  assert.equal(await pidIsGone(control.descendantPid), true);
  assert.doesNotThrow(() => process.kill(foreign.pid, 0));
  assert.equal(
    fs.readdirSync(root).some((name) => name.startsWith(TEST_TEMP_RUN_PREFIX)),
    false
  );
});

test("forced runner crash leaves one manifest root that the stale reaper removes", async (t) => {
  if (process.platform === "win32") return;
  const root = sandbox(t);
  const controlFile = path.join(root, "forced-crash-control.json");
  const fixture = path.join(root, "forced-crash.test.mjs");
  const driver = path.join(root, "forced-crash-driver.mjs");
  fs.writeFileSync(fixture, [
    'import fs from "node:fs";',
    'import process from "node:process";',
    `fs.writeFileSync(${JSON.stringify(controlFile)}, JSON.stringify({`,
    "  fixturePid: process.pid,",
    "  fixtureGroupPid: process.ppid",
    "}));",
    "setInterval(() => {}, 1000);",
    ""
  ].join("\n"));
  fs.writeFileSync(driver, [
    'import process from "node:process";',
    `import { runDeterministicTestFiles } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "scripts/lib/deterministic-test-runner.mjs")).href)};`,
    "const status = runDeterministicTestFiles({",
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
  let fixturePid = null;
  let fixtureGroupPid = null;
  t.after(() => {
    try { process.kill(-runner.pid, "SIGKILL"); } catch {}
    if (fixtureGroupPid) {
      try { process.kill(-fixtureGroupPid, "SIGKILL"); } catch {}
    }
  });
  await waitForPath(controlFile);
  const control = JSON.parse(fs.readFileSync(controlFile, "utf8"));
  fixturePid = control.fixturePid;
  fixtureGroupPid = control.fixtureGroupPid;
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Crashed runner did not exit.")), 6_000);
    runner.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  process.kill(-runner.pid, "SIGKILL");
  const exit = await exited;
  assert.equal(exit.code, null);
  assert.equal(exit.signal, "SIGKILL");
  process.kill(-fixtureGroupPid, "SIGKILL");
  assert.equal(await pidIsGone(fixturePid), true);

  const crashedRoots = fs.readdirSync(root)
    .filter((name) => name.startsWith(TEST_TEMP_RUN_PREFIX));
  assert.equal(crashedRoots.length, 1);
  const crashedRoot = path.join(root, crashedRoots[0]);
  age(crashedRoot);

  const token = processStartToken(process.pid) || "active-crash-sibling-token";
  const active = createOwnedTestTempRoot({
    base: root,
    prefix: TEST_TEMP_PROCESS_PREFIX,
    kind: "process",
    pid: process.pid,
    startToken: token
  });
  age(active);
  const result = cleanupTestTemp(options(root, {
    apply: true,
    legacy: false,
    tokenForPid: (pid) => (pid === process.pid ? token : null)
  }));
  assert.equal(record(result, crashedRoot).removed, true);
  assert.ok(record(result, active).reasons.includes("active-owner"));
  assert.equal(fs.existsSync(crashedRoot), false);
  assert.equal(fs.existsSync(active), true);
});

test("supervisor replaces async-spawn decoy ownership and reaps the detached descendant", async (t) => {
  if (process.platform === "win32") return;
  const root = sandbox(t);
  const pidFile = path.join(root, "empty-environment-descendant.pid");
  const fixture = path.join(root, "empty-environment.test.mjs");
  fs.writeFileSync(fixture, [
    'import fs from "node:fs";',
    'import process from "node:process";',
    'import { spawn, spawnSync } from "node:child_process";',
    `for (const key of ${JSON.stringify([...TEST_OWNERSHIP_ENVIRONMENT_KEYS, "TMPDIR", "TMP", "TEMP"])}) delete process.env[key];`,
    "process.env.GROK_PLUGIN_TEST_SUPERVISOR_PID = String(process.pid);",
    'globalThis[Symbol.for("grok-plugin.testSupervisorAuthority")] = {',
    '  GROK_PLUGIN_TEST_SUPERVISOR_PID: String(process.pid),',
    '  GROK_PLUGIN_TEST_PID_REGISTRY: "/tmp/decoy-registry",',
    '  GROK_PLUGIN_TEST_PID_REGISTRY_SECRET: "decoy-secret"',
    "};",
    'const ordinaryEnvironment = spawnSync("/usr/bin/env", [], { encoding: "utf8" });',
    'if (ordinaryEnvironment.status !== 0) throw new Error("environment probe failed");',
    'if (ordinaryEnvironment.stdout.includes("GROK_PLUGIN_TEST_PID_REGISTRY_SECRET=")) {',
    '  throw new Error("registry authority leaked to an ordinary child");',
    "}",
    "const child = spawn(process.execPath, [\"--eval\", \"setInterval(() => {}, 1000)\"], {",
    "  detached: true,",
    '  env: { GROK_PLUGIN_TEST_SUPERVISOR_TOKEN: "decoy", NODE_OPTIONS: "" },',
    '  stdio: "ignore"',
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

test("supervisor fails closed when its signed PID registry is replaced, truncated, or rolled back", async (t) => {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  for (const tamper of ["replace", "truncate", "rollback"]) {
    const root = sandbox(t);
    const pidFile = path.join(root, `${tamper}-registry-descendant.pid`);
    const fixture = path.join(root, `${tamper}-registry.test.mjs`);
    fs.writeFileSync(fixture, [
      'import fs from "node:fs";',
      'import process from "node:process";',
      'import { spawn } from "node:child_process";',
      'const registry = process.env.GROK_PLUGIN_TEST_PID_REGISTRY;',
      'const initialRegistry = fs.readFileSync(registry, "utf8");',
      'const child = spawn("/bin/sh", ["-c", "exec /usr/bin/env -i /bin/sleep 30"], {',
      '  detached: true, stdio: "ignore"',
      "});",
      "child.unref();",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      tamper === "replace"
        ? "fs.unlinkSync(registry); fs.writeFileSync(registry, \"\", { mode: 0o600 });"
        : tamper === "truncate"
          ? "fs.truncateSync(registry, 0);"
          : "fs.writeFileSync(registry, initialRegistry);",
      ""
    ].join("\n"));
    let descendantPid = null;
    t.after(() => {
      if (!descendantPid) return;
      try { process.kill(descendantPid, "SIGKILL"); } catch {}
    });
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
    descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.equal(status, 1);
    assert.match(diagnostics, /containment could not be proven/);
    assert.match(diagnostics, /containment reason: (?:visibility-monitor|post-close-inspection)/);
    assert.equal(await pidIsGone(descendantPid), true);
    assert.equal(
      fs.readdirSync(root).filter((name) => name.startsWith(TEST_TEMP_RUN_PREFIX)).length,
      1
    );
  }
});

test("async spawn kills the exact child immediately when ownership registration cannot be written", async (t) => {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  const root = sandbox(t);
  const invalidRegistry = path.join(root, "invalid-registry");
  const evidenceFile = path.join(root, "registration-write-failure.json");
  const driver = path.join(root, "registration-write-failure.mjs");
  fs.mkdirSync(invalidRegistry);
  fs.writeFileSync(driver, [
    'import fs from "node:fs";',
    'import process from "node:process";',
    'import { spawn } from "node:child_process";',
    "const startedAt = Date.now();",
    "let failure = null;",
    "try {",
    '  spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    "} catch (error) {",
    "  failure = {",
    "    code: error?.code || null,",
    "    registration: error?.registration || null,",
    "    elapsedMs: Date.now() - startedAt",
    "  };",
    "}",
    `fs.writeFileSync(${JSON.stringify(evidenceFile)}, JSON.stringify(failure));`,
    ""
  ].join("\n"));
  const result = spawnSync("/usr/bin/env", [
    "GROK_PLUGIN_TEST_CHILD_HOOK_BYPASS=1",
    `GROK_PLUGIN_TEST_PID_REGISTRY=${invalidRegistry}`,
    `GROK_PLUGIN_TEST_PID_REGISTRY_SECRET=${"r".repeat(32)}`,
    `GROK_PLUGIN_TEST_SUPERVISOR_PID=${process.pid}`,
    `GROK_PLUGIN_TEST_SUPERVISOR_TOKEN=${"t".repeat(32)}`,
    `GROK_PLUGIN_TEST_TEMP_ROOT=${root}`,
    `NODE_OPTIONS=--require=${CHILD_HOOK}`,
    process.execPath,
    driver
  ], {
    cwd: ROOT,
    env: {},
    encoding: "utf8",
    shell: false,
    timeout: 5_000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, "utf8"));
  assert.equal(evidence.code, "E_TEST_TEMP_REGISTRATION_WRITE");
  assert.match(evidence.registration, /^\d+:(?:m[0-9a-f]+|\d+)$/);
  assert.ok(
    evidence.elapsedMs < 2_000,
    `registration failure took ${evidence.elapsedMs} ms`
  );
  const childPid = Number(evidence.registration.split(":", 1)[0]);
  assert.equal(await pidIsGone(childPid), true);
});

test("async spawn kills the exact child when ownership acknowledgement times out", async (t) => {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  const root = sandbox(t);
  const registry = path.join(root, "unacknowledged-registry");
  const evidenceFile = path.join(root, "registration-ack-failure.json");
  const driver = path.join(root, "registration-ack-failure.mjs");
  fs.writeFileSync(registry, "", { mode: 0o600 });
  fs.writeFileSync(driver, [
    'import fs from "node:fs";',
    'import process from "node:process";',
    'import { spawn } from "node:child_process";',
    "const startedAt = Date.now();",
    "let failure = null;",
    "try {",
    '  spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    "} catch (error) {",
    "  failure = {",
    "    code: error?.code || null,",
    "    registration: error?.registration || null,",
    "    elapsedMs: Date.now() - startedAt",
    "  };",
    "}",
    `fs.writeFileSync(${JSON.stringify(evidenceFile)}, JSON.stringify(failure));`,
    ""
  ].join("\n"));
  const result = spawnSync("/usr/bin/env", [
    "GROK_PLUGIN_TEST_CHILD_HOOK_BYPASS=1",
    `GROK_PLUGIN_TEST_PID_REGISTRY=${registry}`,
    `GROK_PLUGIN_TEST_PID_REGISTRY_SECRET=${"r".repeat(32)}`,
    `GROK_PLUGIN_TEST_SUPERVISOR_PID=${process.pid}`,
    `GROK_PLUGIN_TEST_SUPERVISOR_TOKEN=${"t".repeat(32)}`,
    `GROK_PLUGIN_TEST_TEMP_ROOT=${root}`,
    `NODE_OPTIONS=--require=${CHILD_HOOK}`,
    process.execPath,
    driver
  ], {
    cwd: ROOT,
    env: {},
    encoding: "utf8",
    shell: false,
    timeout: 10_000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, "utf8"));
  assert.equal(evidence.code, "E_TEST_TEMP_REGISTRATION_ACK");
  assert.match(evidence.registration, /^\d+:(?:m[0-9a-f]+|\d+)$/);
  assert.ok(
    evidence.elapsedMs >= 4_500 && evidence.elapsedMs < 8_000,
    `registration acknowledgement failure took ${evidence.elapsedMs} ms`
  );
  const childPid = Number(evidence.registration.split(":", 1)[0]);
  assert.equal(await pidIsGone(childPid), true);
});

test("a recognized supervisor copy executes only the canonical containment bundle", (t) => {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  const activeFileRoot = process.env.GROK_PLUGIN_TEST_TEMP_ROOT;
  if (!path.isAbsolute(activeFileRoot || "")) return;
  const root = sandbox(t);
  const copiedSupervisor = path.join(root, "test-temp-supervisor.mjs");
  const copiedHook = path.join(root, "test-temp-child-hook.cjs");
  const copiedPidfdHelper = path.join(root, "test-temp-pidfd-signal.py");
  const copiedHookMarker = path.join(root, "copied-hook-ran");
  const fixtureMarker = path.join(root, "canonical-supervisor-ran");
  fs.copyFileSync(SUPERVISOR, copiedSupervisor);
  fs.writeFileSync(copiedHook, [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(copiedHookMarker)}, "unsafe\\n");`,
    'throw new Error("copied hook must not execute");',
    ""
  ].join("\n"));
  fs.writeFileSync(
    copiedPidfdHelper,
    "raise SystemExit('copied pidfd helper must not execute')\n"
  );
  const nestedRoot = createOwnedTestTempRoot({
    base: path.dirname(activeFileRoot),
    prefix: "file-",
    kind: "file"
  });
  t.after(() => removeOwnedTestTempRoot(nestedRoot));
  const result = spawnSync(process.execPath, [
    copiedSupervisor,
    "--timeout-ms",
    "10000",
    "--",
    process.execPath,
    "--eval",
    `require("node:fs").writeFileSync(${JSON.stringify(fixtureMarker)}, "canonical\\n")`
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      GROK_PLUGIN_TEST_TEMP_ROOT: nestedRoot,
      TEMP: nestedRoot,
      TMP: nestedRoot,
      TMPDIR: nestedRoot
    },
    encoding: "utf8",
    shell: false,
    timeout: 20_000,
    maxBuffer: 1024 * 1024
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(copiedHookMarker), false);
  assert.equal(fs.readFileSync(fixtureMarker, "utf8"), "canonical\n");
});

test("execFileSync executes a recognized supervisor copy through the canonical containment bundle", (t) => {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  const activeFileRoot = process.env.GROK_PLUGIN_TEST_TEMP_ROOT;
  if (!path.isAbsolute(activeFileRoot || "")) return;
  const root = sandbox(t);
  const copiedSupervisor = path.join(root, "test-temp-supervisor.mjs");
  const copiedHookMarker = path.join(root, "copied-hook-ran");
  const fixtureMarker = path.join(root, "canonical-supervisor-ran");
  fs.copyFileSync(SUPERVISOR, copiedSupervisor);
  fs.writeFileSync(path.join(root, "test-temp-child-hook.cjs"), [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(copiedHookMarker)}, "unsafe\\n");`,
    'throw new Error("copied hook must not execute");',
    ""
  ].join("\n"));
  fs.writeFileSync(
    path.join(root, "test-temp-pidfd-signal.py"),
    "raise SystemExit('copied pidfd helper must not execute')\n"
  );
  const nestedRoot = createOwnedTestTempRoot({
    base: path.dirname(activeFileRoot),
    prefix: "file-",
    kind: "file"
  });
  t.after(() => removeOwnedTestTempRoot(nestedRoot));
  execFileSync(process.execPath, [
    copiedSupervisor,
    "--timeout-ms",
    "10000",
    "--",
    process.execPath,
    "--eval",
    `require("node:fs").writeFileSync(${JSON.stringify(fixtureMarker)}, "canonical\\n")`
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      GROK_PLUGIN_TEST_TEMP_ROOT: nestedRoot,
      TEMP: nestedRoot,
      TMP: nestedRoot,
      TMPDIR: nestedRoot
    },
    encoding: "utf8",
    shell: false,
    timeout: 20_000,
    maxBuffer: 1024 * 1024
  });
  assert.equal(fs.existsSync(copiedHookMarker), false);
  assert.equal(fs.readFileSync(fixtureMarker, "utf8"), "canonical\n");
});

test("an asynchronously launched supervisor copy executes only the canonical containment bundle", {
  timeout: 30_000
}, async (t) => {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  const activeFileRoot = process.env.GROK_PLUGIN_TEST_TEMP_ROOT;
  if (!path.isAbsolute(activeFileRoot || "")) return;
  const root = sandbox(t);
  const copiedSupervisor = path.join(root, "test-temp-supervisor.mjs");
  const copiedHookMarker = path.join(root, "copied-hook-ran");
  const authorityMarker = path.join(root, "canonical-supervisor-authority.json");
  fs.copyFileSync(SUPERVISOR, copiedSupervisor);
  fs.writeFileSync(path.join(root, "test-temp-child-hook.cjs"), [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(copiedHookMarker)}, "unsafe\\n");`,
    'throw new Error("copied hook must not execute");',
    ""
  ].join("\n"));
  fs.writeFileSync(
    path.join(root, "test-temp-pidfd-signal.py"),
    "raise SystemExit('copied pidfd helper must not execute')\n"
  );
  const nestedRoot = createOwnedTestTempRoot({
    base: path.dirname(activeFileRoot),
    prefix: "file-",
    kind: "file"
  });
  t.after(() => removeOwnedTestTempRoot(nestedRoot));
  const child = spawn(process.execPath, [
    copiedSupervisor,
    "--timeout-ms",
    "10000",
    "--",
    process.execPath,
    "--eval",
    `require("node:fs").writeFileSync(${JSON.stringify(authorityMarker)}, JSON.stringify({`
      + "parentPid: process.ppid,"
      + "supervisorPid: Number(process.env.GROK_PLUGIN_TEST_SUPERVISOR_PID),"
      + "tempRoot: process.env.GROK_PLUGIN_TEST_TEMP_ROOT,"
      + "registry: process.env.GROK_PLUGIN_TEST_PID_REGISTRY"
      + '}) + "\\n")'
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      GROK_PLUGIN_TEST_TEMP_ROOT: nestedRoot,
      TEMP: nestedRoot,
      TMP: nestedRoot,
      TMPDIR: nestedRoot
    },
    shell: false,
    stdio: "ignore"
  });
  const outcome = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(outcome, { code: 0, signal: null });
  assert.equal(fs.existsSync(copiedHookMarker), false);
  const authority = JSON.parse(fs.readFileSync(authorityMarker, "utf8"));
  assert.equal(authority.supervisorPid, authority.parentPid);
  assert.equal(authority.tempRoot, nestedRoot);
  assert.equal(path.dirname(authority.registry), nestedRoot);
});

test("supervisor ownership propagates through an async execFile chain", async (t) => {
  if (process.platform === "win32") return;
  const root = sandbox(t);
  const pidFile = path.join(root, "exec-file-descendant.pid");
  const helper = path.join(root, "exec-file-helper.mjs");
  const fixture = path.join(root, "exec-file.test.mjs");
  fs.writeFileSync(helper, [
    'import fs from "node:fs";',
    'import process from "node:process";',
    'import { spawn } from "node:child_process";',
    'const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {',
    '  detached: true, env: {}, stdio: "ignore"',
    "});",
    "child.unref();",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    ""
  ].join("\n"));
  fs.writeFileSync(fixture, [
    'import process from "node:process";',
    'import { execFile } from "node:child_process";',
    `execFile(process.execPath, [${JSON.stringify(helper)}], { env: {} }, (error) => {`,
    "  if (error) throw error;",
    "});",
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

test("supervisor never silently loses an immediate environment-scrubbing detached exec", async (t) => {
  if (process.platform === "win32") return;
  const root = sandbox(t);
  const pidFile = path.join(root, "scrubbed-reexec-descendant.pid");
  const registryFile = path.join(root, "scrubbed-reexec-registry.txt");
  const fixture = path.join(root, "scrubbed-reexec.test.mjs");
  fs.writeFileSync(fixture, [
    'import fs from "node:fs";',
    'import { spawn } from "node:child_process";',
    `const child = spawn("/bin/sh", ["-c", "exec /usr/bin/env -i /bin/sleep 30"], {`,
    '  detached: true, stdio: "ignore"',
    "});",
    "child.unref();",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    `fs.writeFileSync(${JSON.stringify(registryFile)}, fs.readFileSync(process.env.GROK_PLUGIN_TEST_PID_REGISTRY, "utf8"));`,
    ""
  ].join("\n"));
  let descendantPid = null;
  t.after(() => {
    if (!descendantPid) return;
    try { process.kill(descendantPid, "SIGKILL"); } catch {}
  });
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
  descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.match(fs.readFileSync(registryFile, "utf8"), new RegExp(`^${descendantPid}:`, "m"));
  if (process.platform === "linux" || process.platform === "darwin") {
    assert.equal(status, 0, diagnostics);
    assert.equal(await pidIsGone(descendantPid), true);
    assert.equal(
      fs.readdirSync(root).some((name) => name.startsWith(TEST_TEMP_RUN_PREFIX)),
      false
    );
  } else {
    assert.equal(status, 1);
    assert.match(diagnostics, /containment could not be proven/);
    assert.doesNotThrow(() => process.kill(descendantPid, 0));
    assert.equal(
      fs.readdirSync(root).filter((name) => name.startsWith(TEST_TEMP_RUN_PREFIX)).length,
      1
    );
  }
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

test("child hook rejects detached synchronous launches before process creation", (t) => {
  if (process.platform === "win32") return;
  const root = sandbox(t);
  const pidFile = path.join(root, "detached-sync-must-not-start.pid");
  const fixture = path.join(root, "detached-sync-rejected.test.mjs");
  fs.writeFileSync(fixture, [
    'import assert from "node:assert/strict";',
    'import process from "node:process";',
    'import { spawnSync } from "node:child_process";',
    "process.env.GROK_PLUGIN_TEST_SUPERVISOR_PID = String(process.pid);",
    "assert.throws(() => spawnSync(process.execPath, [\"--eval\",",
    `  ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`)}`,
    "], { detached: true, env: { GROK_PLUGIN_TEST_CHILD_HOOK_BYPASS: \"1\" }, stdio: \"ignore\" }),",
    '(error) => error?.code === "E_TEST_TEMP_DETACHED_SYNC");',
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
  assert.equal(fs.existsSync(pidFile), false);
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
