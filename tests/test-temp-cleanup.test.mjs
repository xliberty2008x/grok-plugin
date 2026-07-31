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
  createRegisteredWorktreeProvider,
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

function worktreePorcelain(paths) {
  return paths.map((target, index) => [
    `worktree ${target}`,
    `HEAD ${String(index + 1).padStart(40, "0")}`,
    "branch refs/heads/main",
    ""
  ].join("\n")).join("\n");
}

function worktreeMetadataFixture(t, { linked = false } = {}) {
  const root = sandbox(t);
  const repo = path.join(root, "repo");
  const gitExecutable = path.join(root, "git");
  const gitExecutableLink = path.join(root, "git-hardlink");
  fs.mkdirSync(repo, { mode: 0o700 });
  fs.writeFileSync(gitExecutable, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  fs.chmodSync(gitExecutable, 0o755);
  fs.linkSync(gitExecutable, gitExecutableLink);
  const commonDir = linked ? path.join(root, "common.git") : path.join(repo, ".git");
  fs.mkdirSync(commonDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(commonDir, "config"), [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tbare = false",
    "[extensions]",
    "\tworktreeConfig = true",
    ""
  ].join("\n"), { mode: 0o600 });

  function addRegistration(name, target) {
    const registration = path.join(commonDir, "worktrees", name);
    fs.mkdirSync(registration, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(registration, "gitdir"),
      `${path.join(target, ".git")}\n`,
      { mode: 0o600 }
    );
    fs.writeFileSync(path.join(registration, "commondir"), "../..\n", { mode: 0o600 });
    fs.writeFileSync(
      path.join(registration, "HEAD"),
      `${"1".repeat(40)}\n`,
      { mode: 0o600 }
    );
    return registration;
  }

  let activeGitDir = commonDir;
  if (linked) {
    activeGitDir = addRegistration("active", repo);
    fs.writeFileSync(
      path.join(repo, ".git"),
      `gitdir: ${activeGitDir}\n`,
      { mode: 0o600 }
    );
    fs.writeFileSync(
      path.join(activeGitDir, "config.worktree"),
      "[core]\n\tsparseCheckout = false\n",
      { mode: 0o600 }
    );
    fs.mkdirSync(path.join(activeGitDir, "info"), { mode: 0o700 });
    fs.writeFileSync(
      path.join(activeGitDir, "info", "sparse-checkout"),
      "/*\n",
      { mode: 0o600 }
    );
    fs.writeFileSync(
      path.join(activeGitDir, `sharedindex.${"a".repeat(40)}`),
      "split-index\n",
      { mode: 0o600 }
    );
  }

  return {
    activeGitDir,
    addRegistration,
    commonDir,
    gitExecutable,
    repo: fs.realpathSync(repo),
    root
  };
}

function addInternalLinkedWorktree(root) {
  const primary = path.join(root, "repository", "primary");
  const linked = path.join(root, "repository", "linked");
  const common = path.join(primary, ".git");
  const registration = path.join(common, "worktrees", "linked");
  fs.mkdirSync(path.join(common, "objects"), { recursive: true });
  fs.mkdirSync(path.join(common, "refs"));
  fs.mkdirSync(registration, { recursive: true });
  fs.mkdirSync(linked, { recursive: true });
  fs.writeFileSync(path.join(common, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(common, "config"), "[core]\n\tbare = false\n");
  fs.writeFileSync(
    path.join(linked, ".git"),
    `gitdir: ${registration}\n`
  );
  fs.writeFileSync(
    path.join(registration, "gitdir"),
    `${path.join(linked, ".git")}\n`
  );
  fs.writeFileSync(path.join(registration, "commondir"), "../..\n");
  fs.writeFileSync(
    path.join(registration, "config.worktree"),
    "[core]\n\tsparseCheckout = false\n"
  );
  fs.writeFileSync(path.join(registration, "HEAD"), "1".repeat(40) + "\n");
  const submodule = path.join(primary, "submodule");
  const submoduleGit = path.join(common, "modules", "submodule");
  fs.mkdirSync(path.join(submoduleGit, "objects"), { recursive: true });
  fs.mkdirSync(path.join(submoduleGit, "refs"));
  fs.mkdirSync(submodule);
  fs.writeFileSync(
    path.join(submodule, ".git"),
    `gitdir: ${submoduleGit}\n`
  );
  fs.writeFileSync(
    path.join(submoduleGit, "gitdir"),
    `${path.join(submodule, ".git")}\n`
  );
  fs.writeFileSync(path.join(submoduleGit, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(
    path.join(submoduleGit, "config"),
    [
      "[core]",
      "\tbare = false",
      `\tworktree = ${path.relative(submoduleGit, submodule)}`,
      ""
    ].join("\n")
  );
  return {
    common,
    linked,
    primary,
    registration,
    submodule,
    submoduleGit
  };
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
  assert.match(candidate.dev, /^(?:0|[1-9][0-9]*)$/u);
  assert.match(candidate.ino, /^(?:0|[1-9][0-9]*)$/u);
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

  const registeredAncestor = cleanupTestTemp(options(root, {
    worktreeProvider: () => ({ available: true, paths: [root] })
  }));
  assert.ok(
    record(registeredAncestor, registered).reasons.includes("registered-worktree")
  );

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

test("worktree metadata cache reuses a cryptographically bound snapshot and copy-protects paths", (t) => {
  const fixture = worktreeMetadataFixture(t);
  let calls = 0;
  const provider = createRegisteredWorktreeProvider(fixture.repo, {
    gitCandidates: [fixture.gitExecutable],
    run(_binary, _args, options) {
      calls += 1;
      assert.deepEqual(Object.keys(options.env).sort(), [
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_OPTIONAL_LOCKS",
        "GIT_TERMINAL_PROMPT",
        "LANG",
        "LC_ALL"
      ]);
      assert.equal(options.env.GIT_DIR, undefined);
      return { status: 0, stdout: worktreePorcelain([fixture.repo]) };
    }
  });

  const first = provider();
  assert.equal(first.available, true);
  assert.ok(first.paths.includes(fixture.repo));
  first.paths.push("/cache-poison");
  for (let index = 0; index < 20; index += 1) {
    const current = provider();
    assert.equal(current.available, true);
    assert.equal(current.paths.includes("/cache-poison"), false);
  }
  assert.equal(calls, 1);
});

test("worktree metadata cache freshly hashes the Git executable on every proof pass", (t) => {
  const fixture = worktreeMetadataFixture(t);
  const originalOpenSync = fs.openSync;
  const originalReadFileSync = fs.readFileSync;
  const originalCloseSync = fs.closeSync;
  const executableDescriptors = new Set();
  let executableReads = 0;
  fs.openSync = (...args) => {
    const descriptor = originalOpenSync(...args);
    if (args[0] === fixture.gitExecutable) executableDescriptors.add(descriptor);
    return descriptor;
  };
  fs.readFileSync = (target, ...args) => {
    if (executableDescriptors.has(target)) executableReads += 1;
    return originalReadFileSync(target, ...args);
  };
  fs.closeSync = (descriptor, ...args) => {
    try {
      return originalCloseSync(descriptor, ...args);
    } finally {
      executableDescriptors.delete(descriptor);
    }
  };
  t.after(() => {
    fs.openSync = originalOpenSync;
    fs.readFileSync = originalReadFileSync;
    fs.closeSync = originalCloseSync;
  });

  let calls = 0;
  const provider = createRegisteredWorktreeProvider(fixture.repo, {
    gitCandidates: [fixture.gitExecutable],
    run() {
      calls += 1;
      return { status: 0, stdout: worktreePorcelain([fixture.repo]) };
    }
  });
  assert.equal(provider().available, true);
  assert.equal(provider().available, true);
  assert.equal(calls, 1);
  assert.equal(executableReads, 6);
});

test("one cleanup invocation enumerates Git once across many stable candidates and safety rechecks", (t) => {
  const fixture = worktreeMetadataFixture(t);
  const cleanupRoot = path.join(fixture.root, "many-candidates");
  fs.mkdirSync(cleanupRoot);
  const targets = Array.from({ length: 12 }, () => legacy(cleanupRoot));
  for (const target of targets) age(target);
  let gitCalls = 0;
  let quarantineSequence = 0;
  const provider = createRegisteredWorktreeProvider(fixture.repo, {
    gitCandidates: [fixture.gitExecutable],
    run() {
      gitCalls += 1;
      return { status: 0, stdout: worktreePorcelain([fixture.repo]) };
    }
  });
  const result = cleanupTestTemp(options(cleanupRoot, {
    apply: true,
    snapshotRefreshMs: 0,
    worktreeProvider: provider,
    removeRoot(candidate, _identity, { afterQuarantine }) {
      quarantineSequence += 1;
      const quarantine = path.join(cleanupRoot, `.fixture-quarantine-${quarantineSequence}`);
      fs.renameSync(candidate, quarantine);
      try {
        afterQuarantine(quarantine);
        fs.rmSync(quarantine, { recursive: true });
        return true;
      } catch (error) {
        fs.renameSync(quarantine, candidate);
        throw error;
      }
    }
  }));
  assert.equal(result.removed, targets.length);
  assert.equal(gitCalls, 1);
  assert.equal(targets.some((target) => fs.existsSync(target)), false);
});

test("worktree metadata cache refreshes for registration changes but ignores pure mtime touches", (t) => {
  const fixture = worktreeMetadataFixture(t);
  const listed = [fixture.repo];
  let calls = 0;
  const provider = createRegisteredWorktreeProvider(fixture.repo, {
    gitCandidates: [fixture.gitExecutable],
    run() {
      calls += 1;
      return { status: 0, stdout: worktreePorcelain(listed) };
    }
  });
  assert.equal(provider().available, true);
  assert.equal(calls, 1);

  const external = path.join(fixture.root, "external-one");
  const registration = fixture.addRegistration("external", external);
  listed.push(external);
  assert.equal(provider().available, true);
  assert.equal(calls, 2);

  const gitdir = path.join(registration, "gitdir");
  const initial = fs.lstatSync(gitdir);
  const replacement = Buffer.from(fs.readFileSync(gitdir));
  const originalMarker = "external-one";
  const replacementMarker = "external-two";
  assert.equal(originalMarker.length, replacementMarker.length);
  const rewritten = Buffer.from(
    replacement.toString("utf8").replace(originalMarker, replacementMarker)
  );
  assert.equal(rewritten.length, replacement.length);
  fs.writeFileSync(gitdir, rewritten);
  fs.utimesSync(gitdir, initial.atime, initial.mtime);
  assert.equal(provider().available, true);
  assert.equal(calls, 3);

  const touched = new Date(Date.now() - 10_000);
  fs.utimesSync(gitdir, touched, touched);
  assert.equal(provider().available, true);
  assert.equal(calls, 3);

  const renamed = path.join(fixture.commonDir, "worktrees", "renamed");
  fs.renameSync(registration, renamed);
  assert.equal(provider().available, true);
  assert.equal(calls, 4);
  fs.rmSync(renamed, { recursive: true });
  listed.pop();
  assert.equal(provider().available, true);
  assert.equal(calls, 5);
});

test("worktree metadata cache brackets Git with matching proofs and fails closed after repeated churn", (t) => {
  const fixture = worktreeMetadataFixture(t);
  const registration = fixture.addRegistration("churn", path.join(fixture.root, "churn-one"));
  const gitdir = path.join(registration, "gitdir");
  let calls = 0;
  const provider = createRegisteredWorktreeProvider(fixture.repo, {
    gitCandidates: [fixture.gitExecutable],
    run() {
      calls += 1;
      const current = fs.readFileSync(gitdir, "utf8");
      fs.writeFileSync(
        gitdir,
        current.includes("churn-one")
          ? current.replace("churn-one", "churn-two")
          : current.replace("churn-two", "churn-one")
      );
      return { status: 0, stdout: worktreePorcelain([fixture.repo]) };
    }
  });
  assert.deepEqual(provider(), {
    available: false,
    paths: [],
    reason: "worktree-metadata-unstable"
  });
  assert.equal(calls, 2);
});

test("worktree metadata cache rejects a registration removed and restored during Git enumeration", (t) => {
  const fixture = worktreeMetadataFixture(t);
  const external = path.join(fixture.root, "external-aba");
  const registration = fixture.addRegistration("aba", external);
  const holding = path.join(fixture.root, "aba-holding");
  let calls = 0;
  const provider = createRegisteredWorktreeProvider(fixture.repo, {
    gitCandidates: [fixture.gitExecutable],
    run() {
      calls += 1;
      fs.renameSync(registration, holding);
      fs.renameSync(holding, registration);
      const generationTime = new Date(Date.now() - calls * 1_000);
      fs.utimesSync(registration, generationTime, generationTime);
      return { status: 0, stdout: worktreePorcelain([fixture.repo]) };
    }
  });
  assert.deepEqual(provider(), {
    available: false,
    paths: [],
    reason: "worktree-metadata-unstable"
  });
  assert.equal(calls, 2);
});

test("worktree metadata proof supports linked checkouts and scrubs ambient Git authority", (t) => {
  const fixture = worktreeMetadataFixture(t, { linked: true });
  const calls = [];
  const previousGitDir = process.env.GIT_DIR;
  let result;
  try {
    process.env.GIT_DIR = path.join(fixture.root, "poisoned-git-dir");
    const provider = createRegisteredWorktreeProvider(fixture.repo, {
      gitCandidates: [fixture.gitExecutable],
      run(binary, args, options) {
        calls.push({ args, binary, options });
        return { status: 0, stdout: worktreePorcelain([fixture.repo]) };
      }
    });
    result = provider();
  } finally {
    if (previousGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousGitDir;
  }
  assert.equal(result.available, true);
  assert.ok(result.paths.includes(fixture.repo));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env.GIT_DIR, undefined);
  assert.equal(calls[0].options.env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.deepEqual(calls[0].args, ["worktree", "list", "--porcelain"]);
});

test("worktree metadata proof accepts a bare main record with a linked checkout", (t) => {
  const fixture = worktreeMetadataFixture(t, { linked: true });
  let calls = 0;
  const provider = createRegisteredWorktreeProvider(fixture.repo, {
    gitCandidates: [fixture.gitExecutable],
    run() {
      calls += 1;
      return {
        status: 0,
        stdout: [
          `worktree ${fixture.commonDir}`,
          "bare",
          "",
          worktreePorcelain([fixture.repo])
        ].join("\n")
      };
    }
  });
  const result = provider();
  assert.equal(result.available, true);
  assert.ok(result.paths.includes(fixture.commonDir));
  assert.ok(result.paths.includes(fixture.repo));
  assert.equal(calls, 1);
});

test("worktree metadata proof supports a live relative registration gitdir", (t) => {
  const fixture = worktreeMetadataFixture(t, { linked: true });
  const relativeWorktree = path.join(fixture.root, "relative-worktree");
  fs.mkdirSync(relativeWorktree, { mode: 0o700 });
  const registration = fixture.addRegistration("relative", relativeWorktree);
  const marker = path.join(relativeWorktree, ".git");
  fs.writeFileSync(marker, `gitdir: ${registration}\n`, { mode: 0o600 });
  fs.writeFileSync(
    path.join(registration, "gitdir"),
    `${path.relative(registration, marker)}\n`,
    { mode: 0o600 }
  );
  let calls = 0;
  const provider = createRegisteredWorktreeProvider(fixture.repo, {
    gitCandidates: [fixture.gitExecutable],
    run() {
      calls += 1;
      return {
        status: 0,
        stdout: worktreePorcelain([fixture.repo, relativeWorktree])
      };
    }
  });
  const result = provider();
  assert.equal(result.available, true);
  assert.ok(result.paths.includes(fs.realpathSync(relativeWorktree)));
  assert.equal(calls, 1);
});

test("worktree metadata proof binds a fixed executable symlink and its canonical target", (t) => {
  const fixture = worktreeMetadataFixture(t);
  const gitAuthority = path.join(fixture.root, "git-authority");
  fs.symlinkSync(path.basename(fixture.gitExecutable), gitAuthority);
  const calls = [];
  const provider = createRegisteredWorktreeProvider(fixture.repo, {
    gitCandidates: [gitAuthority],
    run(binary) {
      calls.push(binary);
      return { status: 0, stdout: worktreePorcelain([fixture.repo]) };
    }
  });
  assert.equal(provider().available, true);
  assert.deepEqual(calls, [fs.realpathSync(fixture.gitExecutable)]);
});

test("worktree metadata proof fails closed when its executable symlink is retargeted", (t) => {
  const fixture = worktreeMetadataFixture(t);
  const alternateGit = path.join(fixture.root, "alternate-git");
  const gitAuthority = path.join(fixture.root, "git-authority");
  fs.writeFileSync(alternateGit, "#!/bin/sh\nexit 2\n", { mode: 0o755 });
  fs.symlinkSync(path.basename(fixture.gitExecutable), gitAuthority);
  let calls = 0;
  const provider = createRegisteredWorktreeProvider(fixture.repo, {
    gitCandidates: [gitAuthority],
    run() {
      calls += 1;
      fs.rmSync(gitAuthority);
      fs.symlinkSync(
        path.basename(calls % 2 === 1 ? alternateGit : fixture.gitExecutable),
        gitAuthority
      );
      return { status: 0, stdout: worktreePorcelain([fixture.repo]) };
    }
  });
  assert.deepEqual(provider(), {
    available: false,
    paths: [],
    reason: "worktree-metadata-unstable"
  });
  assert.equal(calls, 2);
});

test("worktree metadata cache rematerializes registered path aliases after symlink retarget", (t) => {
  const fixture = worktreeMetadataFixture(t);
  const firstTarget = path.join(fixture.root, "first-target");
  const secondTarget = path.join(fixture.root, "second-target");
  const registeredLink = path.join(fixture.root, "registered-link");
  const firstWorktree = path.join(firstTarget, "worktree");
  const secondWorktree = path.join(secondTarget, "worktree");
  fs.mkdirSync(firstWorktree, { recursive: true });
  fs.mkdirSync(secondWorktree, { recursive: true });
  fs.symlinkSync(firstTarget, registeredLink);
  const rawWorktree = path.join(registeredLink, "worktree");
  fixture.addRegistration("retargeted", rawWorktree);
  let calls = 0;
  const provider = createRegisteredWorktreeProvider(fixture.repo, {
    gitCandidates: [fixture.gitExecutable],
    run() {
      calls += 1;
      return {
        status: 0,
        stdout: worktreePorcelain([fixture.repo, rawWorktree])
      };
    }
  });

  const first = provider();
  assert.equal(first.available, true);
  assert.ok(first.paths.includes(fs.realpathSync(firstWorktree)));
  fs.unlinkSync(registeredLink);
  fs.symlinkSync(secondTarget, registeredLink);
  const second = provider();
  assert.equal(second.available, true);
  assert.ok(second.paths.includes(fs.realpathSync(secondWorktree)));
  assert.equal(second.paths.includes(fs.realpathSync(firstWorktree)), false);
  assert.equal(calls, 1);
});

test("worktree metadata cache resolves missing suffixes but fails closed on a dangling alias", (t) => {
  const fixture = worktreeMetadataFixture(t);
  const candidate = path.join(fixture.root, "candidate");
  const moved = path.join(fixture.root, "candidate-moved");
  const registeredLink = path.join(fixture.root, "registered-link");
  fs.mkdirSync(candidate);
  fs.symlinkSync(candidate, registeredLink);
  const rawNestedWorktree = path.join(registeredLink, "missing-nested-worktree");
  fixture.addRegistration("nested", rawNestedWorktree);
  let calls = 0;
  const provider = createRegisteredWorktreeProvider(fixture.repo, {
    gitCandidates: [fixture.gitExecutable],
    run() {
      calls += 1;
      return {
        status: 0,
        stdout: worktreePorcelain([fixture.repo, rawNestedWorktree])
      };
    }
  });

  const first = provider();
  assert.equal(first.available, true);
  assert.ok(first.paths.includes(path.join(candidate, "missing-nested-worktree")));
  fs.renameSync(candidate, moved);
  assert.deepEqual(provider(), {
    available: false,
    paths: [],
    reason: "worktree-path-alias-unavailable"
  });
  assert.equal(calls, 1);
});

test("worktree metadata cache revalidates the active checkout after alias retarget", (t) => {
  const fixture = worktreeMetadataFixture(t);
  const activeAlias = path.join(fixture.root, "active-alias");
  const unrelated = path.join(fixture.root, "unrelated");
  fs.mkdirSync(unrelated);
  fs.symlinkSync(fixture.repo, activeAlias);
  let calls = 0;
  const provider = createRegisteredWorktreeProvider(fixture.repo, {
    gitCandidates: [fixture.gitExecutable],
    run() {
      calls += 1;
      return { status: 0, stdout: worktreePorcelain([activeAlias]) };
    }
  });
  assert.equal(provider().available, true);
  fs.unlinkSync(activeAlias);
  fs.symlinkSync(unrelated, activeAlias);
  assert.deepEqual(provider(), {
    available: false,
    paths: [],
    reason: "worktree-path-alias-unavailable"
  });
  assert.equal(calls, 1);
});

test("non-normal registered worktree paths fail closed before cleanup", (t) => {
  const fixture = worktreeMetadataFixture(t);
  const cleanupRoot = path.join(fixture.root, "physical-parent");
  fs.mkdirSync(cleanupRoot, { recursive: true });
  const target = legacy(cleanupRoot);
  const ambiguousPath = [
    path.dirname(target),
    ".",
    path.basename(target)
  ].join(path.sep);
  assert.equal(fs.realpathSync(ambiguousPath), fs.realpathSync(target));
  fixture.addRegistration("ambiguous", ambiguousPath);
  age(target);
  let calls = 0;
  const provider = createRegisteredWorktreeProvider(fixture.repo, {
    gitCandidates: [fixture.gitExecutable],
    run() {
      calls += 1;
      return {
        status: 0,
        stdout: worktreePorcelain([fixture.repo, ambiguousPath])
      };
    }
  });

  const result = cleanupTestTemp(options(cleanupRoot, {
    apply: true,
    worktreeProvider: provider
  }));
  assert.equal(result.aborted, true);
  assert.equal(result.reason, "worktree-visibility-unavailable");
  assert.equal(fs.existsSync(target), true);
  assert.equal(calls, 1);
});

test("worktree metadata proof fails closed for unsafe metadata and Git failure", async (t) => {
  await t.test("symlinked registration control", (subtest) => {
    const fixture = worktreeMetadataFixture(subtest);
    const registration = fixture.addRegistration("unsafe", path.join(fixture.root, "unsafe"));
    fs.rmSync(path.join(registration, "gitdir"));
    fs.symlinkSync(path.join(fixture.root, "outside"), path.join(registration, "gitdir"));
    let calls = 0;
    const provider = createRegisteredWorktreeProvider(fixture.repo, {
      gitCandidates: [fixture.gitExecutable],
      run() { calls += 1; return { status: 0, stdout: "" }; }
    });
    assert.equal(provider().available, false);
    assert.equal(calls, 0);
  });

  await t.test("owner mismatch", (subtest) => {
    const fixture = worktreeMetadataFixture(subtest);
    let calls = 0;
    const provider = createRegisteredWorktreeProvider(fixture.repo, {
      expectedUid: process.getuid() + 1,
      gitCandidates: [fixture.gitExecutable],
      run() { calls += 1; return { status: 0, stdout: "" }; }
    });
    assert.equal(provider().available, false);
    assert.equal(calls, 0);
  });

  await t.test("oversized config", (subtest) => {
    const fixture = worktreeMetadataFixture(subtest);
    fs.writeFileSync(path.join(fixture.commonDir, "config"), Buffer.alloc(1024 * 1024 + 1));
    let calls = 0;
    const provider = createRegisteredWorktreeProvider(fixture.repo, {
      gitCandidates: [fixture.gitExecutable],
      run() { calls += 1; return { status: 0, stdout: "" }; }
    });
    assert.equal(provider().available, false);
    assert.equal(calls, 0);
  });

  await t.test("config include and lock", (subtest) => {
    const fixture = worktreeMetadataFixture(subtest);
    fs.writeFileSync(path.join(fixture.commonDir, "config"), "[include]\n\tpath = /outside\n");
    let calls = 0;
    const provider = createRegisteredWorktreeProvider(fixture.repo, {
      gitCandidates: [fixture.gitExecutable],
      run() { calls += 1; return { status: 0, stdout: "" }; }
    });
    assert.equal(provider().available, false);
    fs.writeFileSync(path.join(fixture.commonDir, "config"), "[core]\n\tbare = false\n");
    fs.writeFileSync(path.join(fixture.commonDir, "config.lock"), "locked");
    assert.equal(provider().available, false);
    assert.equal(calls, 0);
  });

  await t.test("gitfile surrounding whitespace", (subtest) => {
    const fixture = worktreeMetadataFixture(subtest, { linked: true });
    fs.writeFileSync(
      path.join(fixture.repo, ".git"),
      `gitdir: ${fixture.activeGitDir} \n`
    );
    let calls = 0;
    const provider = createRegisteredWorktreeProvider(fixture.repo, {
      gitCandidates: [fixture.gitExecutable],
      run() { calls += 1; return { status: 0, stdout: "" }; }
    });
    assert.equal(provider().available, false);
    assert.equal(calls, 0);
  });

  await t.test("gitfile symlink parent traversal", (subtest) => {
    const fixture = worktreeMetadataFixture(subtest, { linked: true });
    const physical = path.join(fixture.root, "physical-gitdir");
    const hop = path.join(physical, "hop");
    const actual = path.join(physical, "active");
    const decoy = path.join(fixture.repo, "active");
    fs.mkdirSync(hop, { recursive: true, mode: 0o700 });
    fs.mkdirSync(actual, { mode: 0o700 });
    fs.mkdirSync(decoy, { mode: 0o700 });
    fs.writeFileSync(path.join(actual, "config"), "[core]\n\tbare = false\n", {
      mode: 0o600
    });
    fs.writeFileSync(path.join(decoy, "config"), "[core]\n\tbare = false\n", {
      mode: 0o600
    });
    fs.symlinkSync(hop, path.join(fixture.repo, "control-link"));
    fs.writeFileSync(
      path.join(fixture.repo, ".git"),
      `gitdir: control-link${path.sep}..${path.sep}active\n`
    );
    let calls = 0;
    const provider = createRegisteredWorktreeProvider(fixture.repo, {
      gitCandidates: [fixture.gitExecutable],
      run() { calls += 1; return { status: 0, stdout: "" }; }
    });
    assert.equal(provider().available, false);
    assert.equal(calls, 0);
  });

  await t.test("commondir symlink parent traversal", (subtest) => {
    const fixture = worktreeMetadataFixture(subtest, { linked: true });
    const physical = path.join(fixture.root, "physical-common");
    const hop = path.join(physical, "hop");
    const actual = path.join(physical, "common");
    const decoy = path.join(fixture.activeGitDir, "info", "common");
    fs.mkdirSync(hop, { recursive: true, mode: 0o700 });
    fs.mkdirSync(actual, { mode: 0o700 });
    fs.mkdirSync(decoy, { mode: 0o700 });
    fs.writeFileSync(path.join(actual, "config"), "[core]\n\tbare = false\n", {
      mode: 0o600
    });
    fs.writeFileSync(path.join(decoy, "config"), "[core]\n\tbare = false\n", {
      mode: 0o600
    });
    fs.symlinkSync(hop, path.join(fixture.activeGitDir, "info", "control-link"));
    fs.writeFileSync(
      path.join(fixture.activeGitDir, "commondir"),
      `info${path.sep}control-link${path.sep}..${path.sep}common\n`
    );
    let calls = 0;
    const provider = createRegisteredWorktreeProvider(fixture.repo, {
      gitCandidates: [fixture.gitExecutable],
      run() { calls += 1; return { status: 0, stdout: "" }; }
    });
    assert.equal(provider().available, false);
    assert.equal(calls, 0);
  });

  await t.test("missing relative registration gitdir", (subtest) => {
    const fixture = worktreeMetadataFixture(subtest);
    const registration = fixture.addRegistration(
      "relative",
      path.join(fixture.root, "relative")
    );
    fs.writeFileSync(path.join(registration, "gitdir"), "../relative/.git\n");
    let calls = 0;
    const provider = createRegisteredWorktreeProvider(fixture.repo, {
      gitCandidates: [fixture.gitExecutable],
      run() { calls += 1; return { status: 0, stdout: "" }; }
    });
    assert.equal(provider().available, false);
    assert.equal(calls, 0);
  });

  await t.test("symlinked relative registration gitdir", (subtest) => {
    const fixture = worktreeMetadataFixture(subtest);
    const actual = path.join(fixture.root, "actual-relative-worktree");
    const alias = path.join(fixture.root, "relative-worktree-alias");
    fs.mkdirSync(actual, { mode: 0o700 });
    fs.symlinkSync(actual, alias);
    const registration = fixture.addRegistration("relative", alias);
    const marker = path.join(actual, ".git");
    fs.writeFileSync(marker, `gitdir: ${registration}\n`, { mode: 0o600 });
    fs.writeFileSync(
      path.join(registration, "gitdir"),
      `${path.relative(registration, path.join(alias, ".git"))}\n`,
      { mode: 0o600 }
    );
    let calls = 0;
    const provider = createRegisteredWorktreeProvider(fixture.repo, {
      gitCandidates: [fixture.gitExecutable],
      run() { calls += 1; return { status: 0, stdout: "" }; }
    });
    assert.equal(provider().available, false);
    assert.equal(calls, 0);
  });

  await t.test("relative registration symlink parent traversal", (subtest) => {
    const fixture = worktreeMetadataFixture(subtest);
    const registration = fixture.addRegistration(
      "relative-traversal",
      path.join(fixture.root, "relative-traversal")
    );
    const info = path.join(registration, "info");
    const physical = path.join(fixture.root, "physical-relative");
    const hop = path.join(physical, "hop");
    const actual = path.join(physical, "marker.git");
    const decoy = path.join(info, "marker.git");
    fs.mkdirSync(info, { mode: 0o700 });
    fs.mkdirSync(hop, { recursive: true, mode: 0o700 });
    fs.symlinkSync(hop, path.join(info, "control-link"));
    fs.writeFileSync(actual, `gitdir: ${registration}\n`, { mode: 0o600 });
    fs.writeFileSync(decoy, `gitdir: ${registration}\n`, { mode: 0o600 });
    fs.writeFileSync(
      path.join(registration, "gitdir"),
      `info${path.sep}control-link${path.sep}..${path.sep}marker.git\n`
    );
    let calls = 0;
    const provider = createRegisteredWorktreeProvider(fixture.repo, {
      gitCandidates: [fixture.gitExecutable],
      run() { calls += 1; return { status: 0, stdout: "" }; }
    });
    assert.equal(provider().available, false);
    assert.equal(calls, 0);
  });

  await t.test("Git failure", (subtest) => {
    const fixture = worktreeMetadataFixture(subtest);
    const provider = createRegisteredWorktreeProvider(fixture.repo, {
      gitCandidates: [fixture.gitExecutable],
      run() { return { status: 1, stderr: "failure" }; }
    });
    assert.deepEqual(provider(), {
      available: false,
      paths: [],
      reason: "git-worktree-list-failed"
    });
  });
});

test("post-quarantine registration change refreshes Git and restores the outside-canary candidate", (t) => {
  const fixture = worktreeMetadataFixture(t);
  const cleanupRoot = path.join(fixture.root, "cleanup");
  fs.mkdirSync(cleanupRoot);
  const target = legacy(cleanupRoot);
  const canary = path.join(target, "keep");
  fs.writeFileSync(canary, "keep");
  age(target);
  const listed = [fixture.repo];
  let gitCalls = 0;
  let openCalls = 0;
  const provider = createRegisteredWorktreeProvider(fixture.repo, {
    gitCandidates: [fixture.gitExecutable],
    run() {
      gitCalls += 1;
      return { status: 0, stdout: worktreePorcelain(listed) };
    }
  });
  const result = cleanupTestTemp(options(cleanupRoot, {
    apply: true,
    worktreeProvider: provider,
    openPathsProvider() {
      openCalls += 1;
      if (openCalls === 3) {
        fixture.addRegistration("late", target);
        listed.push(target);
      }
      return closedPaths();
    }
  }));
  assert.equal(gitCalls, 2);
  assert.ok(record(result, target).reasons.includes("registered-worktree"));
  assert.equal(fs.readFileSync(canary, "utf8"), "keep");
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

test("legacy and managed candidates scan for nested external worktree links", (t) => {
  const root = sandbox(t);
  const targets = [
    legacy(root),
    createOwnedTestTempRoot({
      base: root,
      prefix: TEST_TEMP_RUN_PREFIX,
      kind: "run",
      pid: process.pid,
      startToken: "stale-nested-worktree-owner"
    })
  ];
  const outside = path.join(root, "nested-worktree-outside");
  const sentinel = path.join(outside, "keep");
  fs.mkdirSync(outside);
  for (const [index, target] of targets.entries()) {
    const checkout = path.join(target, "checkout");
    fs.mkdirSync(checkout);
    fs.writeFileSync(
      path.join(checkout, index === 0 ? ".git" : ".GiT"),
      `gitdir: ${path.join(outside, ".git", "worktrees", `checkout-${index}`)}\n`
    );
    age(target);
  }
  fs.writeFileSync(sentinel, "keep");
  const result = cleanupTestTemp(options(root, {
    apply: true,
    tokenForPid: () => "live-nested-worktree-owner"
  }));
  for (const target of targets) {
    assert.ok(record(result, target).reasons.includes("external-worktree-link"));
    assert.equal(fs.existsSync(target), true);
  }
  assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
});

test("nested Git directories and bare common dirs preserve external registrations", (t) => {
  const root = sandbox(t);
  const controlTarget = legacy(root);
  const controlGit = path.join(controlTarget, "checkout", ".git");
  fs.mkdirSync(controlGit, { recursive: true });
  fs.writeFileSync(path.join(controlGit, "commondir"), "/outside/common.git\n");
  age(controlTarget);

  const bareTarget = legacy(root);
  const bare = path.join(bareTarget, "nested-common.git");
  const registration = path.join(bare, "worktrees", "outside");
  fs.mkdirSync(path.join(bare, "objects"), { recursive: true });
  fs.mkdirSync(path.join(bare, "refs"));
  fs.mkdirSync(registration, { recursive: true });
  fs.writeFileSync(path.join(bare, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(bare, "config"), "[core]\n\tbare = true\n");
  fs.writeFileSync(path.join(registration, "gitdir"), "/outside/checkout/.git\n");
  fs.writeFileSync(path.join(registration, "commondir"), "../..\n");
  age(bareTarget);

  const result = cleanupTestTemp(options(root, { apply: true }));
  assert.ok(record(result, controlTarget).reasons.includes("external-worktree-link"));
  assert.ok(record(result, bareTarget).reasons.includes("git-worktree-metadata"));
  assert.equal(fs.existsSync(controlTarget), true);
  assert.equal(fs.existsSync(bareTarget), true);
});

test("legacy standalone Git directories preserve external core.worktree targets", (t) => {
  const root = sandbox(t);
  const target = legacy(root);
  const outside = fs.mkdtempSync(path.join(root, "outside-legacy-worktree-"));
  const sentinel = path.join(outside, "keep");
  const bare = path.join(target, "standalone.git");
  fs.mkdirSync(path.join(bare, "objects"), { recursive: true });
  fs.mkdirSync(path.join(bare, "refs"));
  fs.writeFileSync(path.join(bare, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(
    path.join(bare, "config"),
    `[core]\n\tworktree = ${outside}\n`
  );
  fs.writeFileSync(sentinel, "keep");
  age(target);

  const result = cleanupTestTemp(options(root, { apply: true }));
  assert.ok(record(result, target).reasons.includes("external-worktree-link"));
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

test("apply distinguishes exact inode identities above Number precision", (t) => {
  const root = sandbox(t);
  const target = legacy(root);
  age(target);
  const firstInode = 2n ** 60n + 1n;
  const replacementInode = firstInode + 1n;
  assert.equal(Number(firstInode), Number(replacementInode));
  const originalLstat = fs.lstatSync;
  let replaced = false;
  let removalCalls = 0;
  fs.lstatSync = (selected, options_) => {
    const stat = originalLstat(selected, options_);
    if (
      path.resolve(String(selected)) !== target
      || options_?.bigint !== true
    ) {
      return stat;
    }
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(stat)),
      stat
    );
    clone.ino = replaced ? replacementInode : firstInode;
    return clone;
  };
  try {
    const result = cleanupTestTemp(options(root, {
      apply: true,
      beforeDelete(candidate) {
        if (candidate.path === target) replaced = true;
      },
      removeRoot() {
        removalCalls += 1;
        return true;
      }
    }));
    const candidate = record(result, target);
    assert.equal(candidate.ino, String(firstInode));
    assert.ok(candidate.reasons.includes("identity-changed"));
    assert.equal(removalCalls, 0);
    assert.equal(result.removed, 0);
    assert.equal(fs.existsSync(target), true);
  } finally {
    fs.lstatSync = originalLstat;
  }
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
  const identity = fs.lstatSync(target, { bigint: true });
  let helperOptions;
  let helperArguments;
  assert.equal(removeInventoriedTestTempRoot(target, identity, {
    run(_executable, arguments_, options) {
      helperArguments = arguments_;
      helperOptions = options;
      fs.rmSync(options.cwd, { recursive: true, force: true });
      return { status: 0, error: null, signal: null };
    }
  }), true);
  assert.deepEqual(helperArguments.slice(1), [
    String(identity.dev),
    String(identity.ino),
    String(identity.dev),
    "guarded",
    "none"
  ]);
  assert.equal(Object.hasOwn(helperOptions, "timeout"), false);
  assert.doesNotMatch(
    fs.readFileSync(path.join(ROOT, "scripts/lib/test-temp-remove-helper.cjs"), "utf8"),
    /\btimeout\s*:/u
  );
});

test("guarded recursive removal keeps descendant helper argv child-hook compatible", (t) => {
  if (process.platform === "win32") return;
  const root = sandbox(t);
  const target = legacy(root);
  const nested = path.join(target, "nested");
  const log = path.join(root, "recursive-spawn.jsonl");
  const preload = path.join(root, "recursive-spawn-preload.cjs");
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, "payload"), "payload");
  fs.writeFileSync(preload, [
    '"use strict";',
    'const childProcess = require("node:child_process");',
    'const fs = require("node:fs");',
    'const { syncBuiltinESMExports } = require("node:module");',
    `const log = ${JSON.stringify(log)};`,
    "const originalSpawnSync = childProcess.spawnSync;",
    "childProcess.spawnSync = function(file, args, options) {",
    "  fs.appendFileSync(log, `${JSON.stringify(args)}\\n`);",
    "  return originalSpawnSync.call(this, file, args, options);",
    "};",
    "syncBuiltinESMExports();",
    ""
  ].join("\n"));
  const targetIdentity = fs.lstatSync(target, { bigint: true });
  const nestedIdentity = fs.lstatSync(nested, { bigint: true });
  const result = spawnSync(process.execPath, [
    REMOVE_HELPER,
    String(targetIdentity.dev),
    String(targetIdentity.ino),
    String(targetIdentity.dev),
    "guarded",
    "none"
  ], {
    cwd: target,
    env: {
      GROK_PLUGIN_TEST_CHILD_HOOK_BYPASS: "1",
      NODE_OPTIONS: `--require=${preload}`
    },
    encoding: "utf8",
    shell: false
  });
  assert.equal(result.status, 0, result.stderr);
  const launches = fs.readFileSync(log, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.deepEqual(launches, [[
    REMOVE_HELPER,
    String(nestedIdentity.dev),
    String(nestedIdentity.ino),
    String(targetIdentity.dev),
    "guarded",
    "none"
  ]]);
  assert.equal(fs.existsSync(target), false);
});

test("recursive remover refuses late Git controls but permits a standalone .git directory", (t) => {
  const root = sandbox(t);
  const linked = legacy(root);
  fs.writeFileSync(path.join(linked, ".GiT"), "gitdir: /outside/worktrees/late\n");
  const linkedIdentity = fs.lstatSync(linked, { bigint: true });
  assert.throws(
    () => removeInventoriedTestTempRoot(linked, linkedIdentity),
    (error) => error?.code === "E_TEST_TEMP_IDENTITY_CHANGED"
  );
  assert.equal(
    fs.readFileSync(path.join(linked, ".GiT"), "utf8"),
    "gitdir: /outside/worktrees/late\n"
  );

  const controlled = legacy(root);
  fs.mkdirSync(path.join(controlled, ".git"));
  fs.writeFileSync(
    path.join(controlled, ".git", "commondir"),
    "/outside/common.git\n"
  );
  const controlledIdentity = fs.lstatSync(controlled, { bigint: true });
  assert.throws(
    () => removeInventoriedTestTempRoot(controlled, controlledIdentity),
    (error) => error?.code === "E_TEST_TEMP_IDENTITY_CHANGED"
  );
  assert.equal(
    fs.readFileSync(path.join(controlled, ".git", "commondir"), "utf8"),
    "/outside/common.git\n"
  );

  const bareControlled = legacy(root);
  const bare = path.join(bareControlled, "common.git");
  const bareRegistration = path.join(bare, "worktrees", "outside");
  fs.mkdirSync(path.join(bare, "objects"), { recursive: true });
  fs.mkdirSync(path.join(bare, "refs"));
  fs.mkdirSync(bareRegistration, { recursive: true });
  fs.writeFileSync(path.join(bare, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(bare, "config"), "[core]\n\tbare = true\n");
  fs.writeFileSync(path.join(bareRegistration, "gitdir"), "/outside/.git\n");
  fs.writeFileSync(path.join(bareRegistration, "commondir"), "../..\n");
  const bareIdentity = fs.lstatSync(bareControlled, { bigint: true });
  assert.throws(
    () => removeInventoriedTestTempRoot(bareControlled, bareIdentity),
    (error) => error?.code === "E_TEST_TEMP_IDENTITY_CHANGED"
  );
  assert.equal(
    fs.readFileSync(path.join(bareRegistration, "gitdir"), "utf8"),
    "/outside/.git\n"
  );

  const standaloneCore = legacy(root);
  const standaloneBare = path.join(standaloneCore, "standalone.git");
  fs.mkdirSync(path.join(standaloneBare, "objects"), { recursive: true });
  fs.mkdirSync(path.join(standaloneBare, "refs"));
  fs.writeFileSync(
    path.join(standaloneBare, "HEAD"),
    "ref: refs/heads/main\n"
  );
  fs.writeFileSync(
    path.join(standaloneBare, "config"),
    "[core]\n\tworktree = /outside/checkout\n"
  );
  const standaloneCoreIdentity = fs.lstatSync(standaloneCore, {
    bigint: true
  });
  assert.throws(
    () => removeInventoriedTestTempRoot(
      standaloneCore,
      standaloneCoreIdentity
    ),
    (error) => error?.code === "E_TEST_TEMP_IDENTITY_CHANGED"
  );
  assert.match(
    fs.readFileSync(path.join(standaloneBare, "config"), "utf8"),
    /worktree/u
  );

  const standalone = legacy(root);
  fs.mkdirSync(path.join(standalone, ".git"));
  fs.writeFileSync(path.join(standalone, ".git", "HEAD"), "ref: refs/heads/main\n");
  const standaloneIdentity = fs.lstatSync(standalone, { bigint: true });
  assert.equal(
    removeInventoriedTestTempRoot(standalone, standaloneIdentity),
    true
  );
  assert.equal(fs.existsSync(standalone), false);
});

test("exact owned-root cleanup permits internal linked-worktree metadata", (t) => {
  const root = sandbox(t);
  const owned = createOwnedTestTempRoot({
    base: root,
    prefix: TEST_TEMP_PROCESS_PREFIX,
    kind: "process",
    pid: process.pid,
    startToken: "owned-internal-worktree"
  });
  addInternalLinkedWorktree(owned);
  assert.equal(removeOwnedTestTempRoot(owned), true);
  assert.equal(fs.existsSync(owned), false);
});

test("exact owned-root cleanup permits ordinary application worktrees directories", (t) => {
  const root = sandbox(t);
  const owned = createOwnedTestTempRoot({
    base: root,
    prefix: TEST_TEMP_PROCESS_PREFIX,
    kind: "process",
    pid: process.pid,
    startToken: "owned-ordinary-worktrees-directory"
  });
  const checkout = path.join(owned, "state", "worktrees", "checkout");
  fs.mkdirSync(checkout, { recursive: true });
  fs.writeFileSync(path.join(checkout, "config"), "application-config\n");
  for (const name of ["toString", "constructor", "__proto__"]) {
    fs.mkdirSync(path.join(owned, name));
    fs.writeFileSync(path.join(owned, name, "payload"), "ordinary-entry\n");
  }
  assert.equal(removeOwnedTestTempRoot(owned), true);
  assert.equal(fs.existsSync(owned), false);
});

test("exact owned-root cleanup preserves Git metadata that escapes its root", (t) => {
  const root = sandbox(t);
  const owned = createOwnedTestTempRoot({
    base: root,
    prefix: TEST_TEMP_PROCESS_PREFIX,
    kind: "process",
    pid: process.pid,
    startToken: "owned-external-worktree"
  });
  const outside = fs.mkdtempSync(path.join(root, "outside-common-"));
  const canary = path.join(outside, "keep");
  fs.writeFileSync(canary, "keep");
  fs.writeFileSync(path.join(owned, ".git"), `gitdir: ${outside}\n`);
  assert.throws(
    () => removeOwnedTestTempRoot(owned),
    /unproven Git metadata/u
  );
  assert.equal(fs.existsSync(owned), true);
  assert.equal(fs.readFileSync(canary, "utf8"), "keep");
});

test("exact owned-root cleanup rejects symlink-parent Git control traversal", (t) => {
  const root = sandbox(t);
  const owned = createOwnedTestTempRoot({
    base: root,
    prefix: TEST_TEMP_PROCESS_PREFIX,
    kind: "process",
    pid: process.pid,
    startToken: "owned-symlink-parent-traversal"
  });
  const outside = fs.mkdtempSync(path.join(root, "outside-control-traversal-"));
  const outsideHop = path.join(outside, "hop");
  const outsideTarget = path.join(outside, "actual");
  const canary = path.join(outsideTarget, "keep");
  fs.mkdirSync(outsideHop);
  fs.mkdirSync(outsideTarget);
  fs.writeFileSync(canary, "keep");
  fs.mkdirSync(path.join(owned, "actual"));
  fs.symlinkSync(outsideHop, path.join(owned, "control-link"));
  fs.writeFileSync(
    path.join(owned, ".git"),
    `gitdir: control-link${path.sep}..${path.sep}actual\n`
  );
  assert.throws(
    () => removeOwnedTestTempRoot(owned),
    /unproven Git metadata/u
  );
  assert.equal(fs.existsSync(owned), true);
  assert.equal(fs.readFileSync(canary, "utf8"), "keep");
});

test("exact owned-root cleanup preserves an external core.worktree", (t) => {
  const root = sandbox(t);
  const owned = createOwnedTestTempRoot({
    base: root,
    prefix: TEST_TEMP_PROCESS_PREFIX,
    kind: "process",
    pid: process.pid,
    startToken: "owned-external-core-worktree"
  });
  const outside = fs.mkdtempSync(path.join(root, "outside-worktree-"));
  const canary = path.join(outside, "keep");
  fs.writeFileSync(canary, "keep");
  fs.mkdirSync(path.join(owned, ".git"));
  fs.writeFileSync(
    path.join(owned, ".git", "config"),
    `[core]\n\tworktree = ${outside}\n`
  );
  assert.throws(
    () => removeOwnedTestTempRoot(owned),
    /unproven Git metadata/u
  );
  assert.equal(fs.existsSync(owned), true);
  assert.equal(fs.readFileSync(canary, "utf8"), "keep");
});

test("owned cleanup rejects external worktrees in nested and standalone Git directories", (t) => {
  const root = sandbox(t);
  const outside = fs.mkdtempSync(path.join(root, "outside-nested-worktree-"));
  const canary = path.join(outside, "keep");
  fs.writeFileSync(canary, "keep");

  for (const [token, gitDirectory] of [
    ["owned-external-submodule-worktree", [".git", "modules", "submodule"]],
    ["owned-external-standalone-worktree", ["standalone.git"]]
  ]) {
    const owned = createOwnedTestTempRoot({
      base: root,
      prefix: TEST_TEMP_PROCESS_PREFIX,
      kind: "process",
      pid: process.pid,
      startToken: token
    });
    const gitRoot = path.join(owned, ...gitDirectory);
    fs.mkdirSync(path.join(gitRoot, "objects"), { recursive: true });
    fs.mkdirSync(path.join(gitRoot, "refs"));
    fs.writeFileSync(path.join(gitRoot, "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(
      path.join(gitRoot, "config"),
      `[core]\n\tworktree = ${outside}\n`
    );
    assert.throws(
      () => removeOwnedTestTempRoot(owned),
      /unproven Git metadata/u
    );
    assert.equal(fs.existsSync(owned), true);
  }
  assert.equal(fs.readFileSync(canary, "utf8"), "keep");
});

test("owned cleanup rejects Git-expanded core.worktree path syntax", (t) => {
  const root = sandbox(t);
  const owned = createOwnedTestTempRoot({
    base: root,
    prefix: TEST_TEMP_PROCESS_PREFIX,
    kind: "process",
    pid: process.pid,
    startToken: "owned-expanded-core-worktree"
  });
  const gitDirectory = path.join(owned, ".git");
  fs.mkdirSync(path.join(gitDirectory, "~", "outside"), { recursive: true });
  fs.writeFileSync(
    path.join(gitDirectory, "config"),
    "[core]\n\tworktree = ~/outside\n"
  );
  assert.throws(
    () => removeOwnedTestTempRoot(owned),
    /unproven Git metadata/u
  );
  assert.equal(fs.existsSync(owned), true);
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

test("unreadable descendants fail closed before recursive removal", (t) => {
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
  assert.ok(record(result, target).reasons.includes("git-metadata-ambiguous"));
  assert.equal(record(result, target).removed, undefined);
  assert.equal(fs.existsSync(target), true);
  fs.chmodSync(restricted, 0o700);
  assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "keep");
});

test("candidate and descendant device changes fail closed before removal", (t) => {
  const root = sandbox(t);
  const mountedCandidate = legacy(root);
  const nestedCandidate = legacy(root);
  const mountedDescendant = path.join(nestedCandidate, "mounted-descendant");
  fs.writeFileSync(path.join(mountedCandidate, "keep"), "candidate");
  fs.mkdirSync(mountedDescendant);
  fs.writeFileSync(path.join(mountedDescendant, "keep"), "descendant");
  age(mountedCandidate);
  age(nestedCandidate);

  const originalLstat = fs.lstatSync;
  const crossDevicePaths = new Set([
    path.resolve(mountedCandidate),
    path.resolve(mountedDescendant)
  ]);
  fs.lstatSync = (target, ...args) => {
    const stat = originalLstat.call(fs, target, ...args);
    if (
      typeof target !== "string"
      || !crossDevicePaths.has(path.resolve(target))
    ) {
      return stat;
    }
    const changed = Object.assign(
      Object.create(Object.getPrototypeOf(stat)),
      stat
    );
    changed.dev = typeof stat.dev === "bigint" ? stat.dev + 1n : stat.dev + 1;
    return changed;
  };
  let result;
  try {
    result = cleanupTestTemp(options(root, { apply: true }));
  } finally {
    fs.lstatSync = originalLstat;
  }

  assert.ok(
    record(result, mountedCandidate).reasons.includes("cross-device-candidate")
  );
  assert.ok(
    record(result, nestedCandidate).reasons.includes("cross-device-descendant")
  );
  assert.equal(fs.readFileSync(path.join(mountedCandidate, "keep"), "utf8"), "candidate");
  assert.equal(
    fs.readFileSync(path.join(mountedDescendant, "keep"), "utf8"),
    "descendant"
  );
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
  const identity = fs.lstatSync(target, { bigint: true });
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
  const identity = fs.lstatSync(target, { bigint: true });
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

test("recursive removal restores readable ancestor modes after a deeper guard failure", (t) => {
  if (process.platform === "win32") return;
  const root = sandbox(t);
  const target = legacy(root);
  const readonly = path.join(target, "readonly");
  fs.mkdirSync(readonly);
  fs.writeFileSync(
    path.join(readonly, ".git"),
    "gitdir: /outside/worktrees/late\n"
  );
  fs.chmodSync(readonly, 0o500);
  const identity = fs.lstatSync(target, { bigint: true });
  assert.throws(
    () => removeInventoriedTestTempRoot(target, identity),
    (error) => error?.code === "E_TEST_TEMP_IDENTITY_CHANGED"
  );
  assert.equal(fs.statSync(readonly).mode & 0o777, 0o500);
  fs.chmodSync(readonly, 0o700);
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
  addInternalLinkedWorktree(stale);
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

test("Linux stale managed cleanup safely repairs a permission-locked descendant", (t) => {
  if (process.platform !== "linux") return;
  const root = sandbox(t);
  const token = processStartToken(process.pid) || "active-fixture-start-token";
  const stale = createOwnedTestTempRoot({
    base: root,
    prefix: TEST_TEMP_RUN_PREFIX,
    kind: "run",
    pid: process.pid,
    startToken: `${token}-stale-permission`
  });
  const restricted = path.join(stale, "restricted");
  fs.mkdirSync(restricted);
  fs.writeFileSync(path.join(restricted, "payload"), "payload");
  fs.chmodSync(restricted, 0o000);
  t.after(() => {
    try {
      if (fs.existsSync(restricted)) fs.chmodSync(restricted, 0o700);
    } catch {
      // The assertion below reports a failed or partially restored cleanup.
    }
  });
  age(stale);
  const result = cleanupTestTemp(options(root, {
    apply: true,
    legacy: false,
    tokenForPid: () => token
  }));
  assert.equal(record(result, stale).removed, true);
  assert.equal(fs.existsSync(stale), false);
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
