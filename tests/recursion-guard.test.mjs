import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { spawn } from "node:child_process";

import { processStartToken } from "../plugins/grok/scripts/lib/process-control.mjs";
import {
  hasForeignActiveProvider,
  loadProviderGuard,
  registerProviderGuard,
  unregisterProviderGuard
} from "../plugins/grok/scripts/lib/recursion-guard.mjs";
import { withWorkspaceStateTransaction, writeJob } from "../plugins/grok/scripts/lib/state.mjs";
import { resolveControlWorkspace } from "../plugins/grok/scripts/lib/workspace.mjs";
import { git, initRepo, tempDir, waitFor } from "./helpers.mjs";

const GUARD_MODULE_URL = new URL("../plugins/grok/scripts/lib/recursion-guard.mjs", import.meta.url).href;

function waitForFileSync(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return fs.existsSync(file);
}

function canonicalGuardFile(root, marker) {
  const common = fs.realpathSync(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  const scope = crypto.createHash("sha256").update(common).digest("hex");
  const directory = path.join(
    os.tmpdir(),
    `grok-companion-guards-${typeof process.getuid === "function" ? process.getuid() : "user"}`,
    scope
  );
  return path.join(directory, `${String(marker).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80)}.json`);
}

function legacyGuardFile(root, marker) {
  const scope = crypto.createHash("sha256").update(fs.realpathSync(root)).digest("hex");
  const directory = path.join(
    os.tmpdir(),
    `grok-companion-guards-${typeof process.getuid === "function" ? process.getuid() : "user"}`,
    scope
  );
  return path.join(directory, `${String(marker).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80)}.json`);
}

function spawnGuardOperation({ mode, root, marker, expected = null, owner = null, readyFile, resultFile, env }) {
  const source = `
    import fs from "node:fs";
    import { hasForeignActiveProvider, unregisterProviderGuard } from ${JSON.stringify(GUARD_MODULE_URL)};
    const [mode, root, marker, expectedValue, owner, readyFile, resultFile] = process.argv.slice(1);
    fs.writeFileSync(readyFile, "ready\\n");
    try {
      const value = mode === "unregister"
        ? unregisterProviderGuard(root, marker, JSON.parse(Buffer.from(expectedValue, "base64").toString("utf8")))
        : hasForeignActiveProvider(root, owner || null);
      fs.writeFileSync(resultFile, JSON.stringify({ ok: true, value }));
    } catch (error) {
      fs.writeFileSync(resultFile, JSON.stringify({ ok: false, code: error?.code || null, message: error?.message || String(error) }));
    }
  `;
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    source,
    mode,
    root,
    marker,
    Buffer.from(JSON.stringify(expected)).toString("base64"),
    owner || "",
    readyFile,
    resultFile
  ], { env, stdio: "ignore" });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, completed };
}

test("provider guards are shared across linked worktrees and compare-and-delete rejects ABA replacement", (t) => {
  const primary = initRepo();
  const linked = path.join(path.dirname(primary), `${path.basename(primary)}-guard-linked`);
  git(primary, "worktree", "add", "--detach", linked, "HEAD");
  const linkedRoot = fs.realpathSync(linked);
  const markers = [
    "task-linked-to-primary-01234567",
    "task-primary-to-linked-01234567",
    "task-guard-aba-0123456789abcdef"
  ];
  t.after(() => {
    for (const marker of markers) {
      try { unregisterProviderGuard(primary, marker); } catch {}
      try { unregisterProviderGuard(linkedRoot, marker); } catch {}
    }
    try { git(primary, "worktree", "remove", "--force", linkedRoot); } catch {}
    fs.rmSync(primary, { recursive: true, force: true });
  });

  const fromLinked = {
    pid: 1_910_101,
    startToken: "linked-provider-start-token",
    processGroupId: process.platform === "win32" ? null : 1_910_101
  };
  registerProviderGuard(linkedRoot, markers[0], fromLinked, "shared-owner");
  const linkedRecord = loadProviderGuard(primary, markers[0]);
  assert.deepEqual(linkedRecord.providerProcess, fromLinked);
  unregisterProviderGuard(primary, markers[0], linkedRecord);
  assert.equal(loadProviderGuard(linkedRoot, markers[0]), null);

  const fromPrimary = {
    pid: 1_910_102,
    startToken: "primary-provider-start-token",
    processGroupId: process.platform === "win32" ? null : 1_910_102
  };
  registerProviderGuard(primary, markers[1], fromPrimary, "shared-owner");
  const primaryRecord = loadProviderGuard(linkedRoot, markers[1]);
  assert.deepEqual(primaryRecord.providerProcess, fromPrimary);
  unregisterProviderGuard(linkedRoot, markers[1], primaryRecord);
  assert.equal(loadProviderGuard(primary, markers[1]), null);

  registerProviderGuard(linkedRoot, markers[2], fromLinked, "shared-owner");
  const staleRecord = loadProviderGuard(primary, markers[2]);
  registerProviderGuard(primary, markers[2], fromPrimary, "shared-owner");
  const replacementRecord = loadProviderGuard(linkedRoot, markers[2]);
  assert.notDeepEqual(replacementRecord.providerProcess, staleRecord.providerProcess);
  assert.throws(
    () => unregisterProviderGuard(linkedRoot, markers[2], staleRecord),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  assert.deepEqual(loadProviderGuard(primary, markers[2]), replacementRecord);
  unregisterProviderGuard(primary, markers[2], replacementRecord);
  assert.equal(loadProviderGuard(linkedRoot, markers[2]), null);
});

test("expected guard deletion is serialized with replacement publication across linked worktrees", async (t) => {
  const primary = initRepo();
  const linked = path.join(path.dirname(primary), `${path.basename(primary)}-guard-cas-linked`);
  git(primary, "worktree", "add", "--detach", linked, "HEAD");
  const linkedRoot = fs.realpathSync(linked);
  const marker = "task-guard-cas-interleave-01234567";
  const scratch = tempDir("grok-guard-cas-");
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: path.join(scratch, "plugin-data") };
  const readyFile = path.join(scratch, "ready");
  const resultFile = path.join(scratch, "result.json");
  let operation;
  t.after(() => {
    try { unregisterProviderGuard(primary, marker, null, env); } catch {}
    try { git(primary, "worktree", "remove", "--force", linkedRoot); } catch {}
    fs.rmSync(primary, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const original = registerProviderGuard(primary, marker, {
    pid: 1_920_101,
    startToken: "guard-original-start-token",
    processGroupId: process.platform === "win32" ? null : 1_920_101
  }, "guard-owner", "provider", null, env);
  const replacement = {
    ...original,
    providerProcess: {
      pid: 1_920_102,
      startToken: "guard-replacement-start-token",
      processGroupId: process.platform === "win32" ? null : 1_920_102
    },
    createdAt: new Date(Date.now() + 1).toISOString()
  };

  withWorkspaceStateTransaction(primary, () => {
    operation = spawnGuardOperation({
      mode: "unregister",
      root: linkedRoot,
      marker,
      expected: original,
      readyFile,
      resultFile,
      env
    });
    assert.equal(waitForFileSync(readyFile), true, "competing cleanup did not start");
    assert.equal(waitForFileSync(resultFile, 250), false, "exact cleanup bypassed the workspace transaction");
    fs.writeFileSync(canonicalGuardFile(primary, marker), `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
  }, env);

  const exit = await operation.completed;
  assert.deepEqual(exit, { code: 0, signal: null });
  const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  assert.equal(result.ok, false);
  assert.equal(result.code, "E_PROCESS_IDENTITY");
  assert.deepEqual(loadProviderGuard(primary, marker), replacement, "stale cleanup deleted the replacement guard");
});

test("foreign-provider stale cleanup is workspace-locked and preserves a concurrent replacement", async (t) => {
  const primary = initRepo();
  const linked = path.join(path.dirname(primary), `${path.basename(primary)}-guard-stale-linked`);
  git(primary, "worktree", "add", "--detach", linked, "HEAD");
  const linkedRoot = fs.realpathSync(linked);
  const marker = "task-guard-stale-interleave-01234567";
  const scratch = tempDir("grok-guard-stale-");
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: path.join(scratch, "plugin-data") };
  const readyFile = path.join(scratch, "ready");
  const resultFile = path.join(scratch, "result.json");
  let operation;
  t.after(() => {
    try { unregisterProviderGuard(primary, marker, null, env); } catch {}
    try { git(primary, "worktree", "remove", "--force", linkedRoot); } catch {}
    fs.rmSync(primary, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const stale = registerProviderGuard(primary, marker, {
    pid: 1_930_101,
    startToken: "stale-provider-start-token",
    processGroupId: process.platform === "win32" ? null : 1_930_101
  }, "same-owner", "provider", null, env);
  const replacement = {
    ...stale,
    owner: crypto.createHash("sha256").update("different-owner").digest("hex"),
    providerProcess: {
      pid: 1_930_102,
      startToken: "replacement-provider-start-token",
      processGroupId: process.platform === "win32" ? null : 1_930_102
    },
    createdAt: new Date(Date.now() + 1).toISOString()
  };

  withWorkspaceStateTransaction(primary, () => {
    operation = spawnGuardOperation({
      mode: "has-foreign",
      root: linkedRoot,
      marker,
      owner: "same-owner",
      readyFile,
      resultFile,
      env
    });
    assert.equal(waitForFileSync(readyFile), true, "foreign-provider scan did not start");
    assert.equal(waitForFileSync(resultFile, 250), false, "stale cleanup bypassed the workspace transaction");
    fs.writeFileSync(canonicalGuardFile(primary, marker), `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
  }, env);

  const exit = await operation.completed;
  assert.deepEqual(exit, { code: 0, signal: null });
  const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  assert.deepEqual(result, { ok: true, value: true });
  assert.deepEqual(loadProviderGuard(linkedRoot, marker), replacement, "stale scan deleted a replacement guard");
});

test("bound provider guard registration fails closed after cleanup authority is fenced", (t) => {
  const root = initRepo();
  const scratch = tempDir("grok-guard-cleanup-fence-");
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: path.join(scratch, "plugin-data") };
  const workerId = "task-aabbccddeeff001122334455";
  const attemptId = "00112233445566778899aabbccddeeff";
  const control = resolveControlWorkspace(root, env);
  const timestamp = new Date().toISOString();
  t.after(() => {
    try { unregisterProviderGuard(root, workerId, null, env); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  writeJob(root, {
    schemaVersion: 3,
    id: workerId,
    kind: "task",
    jobClass: "task",
    write: false,
    status: "running",
    createdAt: timestamp,
    updatedAt: timestamp,
    controlWorkspaceId: control.controlWorkspaceId,
    host: { kind: "codex", sessionId: "guard-cleanup-owner" },
    request: {
      spawn: {
        executionRoot: control.executionRoot,
        cleanupFence: {
          attemptId,
          dispatchFence: 4,
          reason: "recovery-cleanup"
        },
        dispatch: {
          schemaVersion: 2,
          state: "worker-started",
          attemptId,
          fence: 4,
          providerGeneration: 0
        }
      }
    }
  }, env);

  assert.throws(
    () => registerProviderGuard(
      root,
      workerId,
      {
        pid: 1_940_101,
        startToken: "cleanup-fenced-provider-start-token",
        processGroupId: process.platform === "win32" ? null : 1_940_101
      },
      "guard-cleanup-owner",
      "provider",
      {
        controlWorkspaceId: control.controlWorkspaceId,
        executionRoot: control.executionRoot,
        dispatchAttemptId: attemptId,
        dispatchFence: 4,
        providerGeneration: 1
      },
      env
    ),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  assert.equal(loadProviderGuard(root, workerId), null);
});

test("bound provider guard registration is exact-idempotent and rejects a duplicate generation identity", (t) => {
  const root = initRepo();
  const scratch = tempDir("grok-guard-generation-owner-");
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: path.join(scratch, "plugin-data") };
  const workerId = "task-bbccddeeff00112233445566";
  const attemptId = "11223344556677889900aabbccddeeff";
  const owner = "guard-generation-owner";
  const control = resolveControlWorkspace(root, env);
  const timestamp = new Date().toISOString();
  t.after(() => {
    try { unregisterProviderGuard(root, workerId, null, env); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  writeJob(root, {
    schemaVersion: 3,
    id: workerId,
    kind: "task",
    jobClass: "task",
    write: false,
    status: "running",
    createdAt: timestamp,
    updatedAt: timestamp,
    controlWorkspaceId: control.controlWorkspaceId,
    host: { kind: "codex", sessionId: owner },
    request: {
      spawn: {
        executionRoot: control.executionRoot,
        dispatch: {
          schemaVersion: 2,
          state: "worker-started",
          attemptId,
          fence: 7,
          providerGeneration: 0,
          nextProviderGeneration: null
        }
      }
    }
  }, env);

  const binding = {
    controlWorkspaceId: control.controlWorkspaceId,
    executionRoot: control.executionRoot,
    dispatchAttemptId: attemptId,
    dispatchFence: 7,
    providerGeneration: 1
  };
  const firstIdentity = {
    pid: 1_950_101,
    startToken: "first-generation-provider-start-token",
    processGroupId: process.platform === "win32" ? null : 1_950_101
  };
  const first = registerProviderGuard(
    root,
    workerId,
    firstIdentity,
    owner,
    "provider",
    binding,
    env
  );

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  const replay = registerProviderGuard(
    root,
    workerId,
    firstIdentity,
    owner,
    "provider",
    binding,
    env
  );
  assert.deepEqual(replay, first, "exact replay replaced the original guard record");
  assert.deepEqual(loadProviderGuard(root, workerId), first);

  const replacementIdentity = {
    pid: 1_950_102,
    startToken: "replacement-generation-provider-start-token",
    processGroupId: process.platform === "win32" ? null : 1_950_102
  };
  assert.throws(
    () => registerProviderGuard(
      root,
      workerId,
      replacementIdentity,
      owner,
      "provider",
      binding,
      env
    ),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  assert.deepEqual(loadProviderGuard(root, workerId), first, "duplicate registration overwrote the original guard");
});

test("foreign-provider scan fails closed and preserves conflicting canonical and legacy aliases", {
  skip: process.platform === "win32"
}, async (t) => {
  const root = initRepo();
  const scratch = tempDir("grok-guard-alias-conflict-");
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: path.join(scratch, "plugin-data") };
  const marker = "task-ccddeeff0011223344556677";
  const owner = "canonical-guard-owner";
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", marker, "agent", "stdio"],
    { detached: true, stdio: "ignore" }
  );
  t.after(async () => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    try { await waitFor(() => processStartToken(child.pid) === null); } catch {}
    try { unregisterProviderGuard(root, marker, null, env); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const startToken = await waitFor(() => processStartToken(child.pid));
  const canonical = registerProviderGuard(root, marker, {
    pid: child.pid,
    startToken,
    processGroupId: child.pid
  }, owner, "provider", null, env);
  const conflicting = {
    ...canonical,
    owner: crypto.createHash("sha256").update("foreign-guard-owner").digest("hex"),
    createdAt: new Date(Date.now() + 1).toISOString()
  };
  const canonicalFile = canonicalGuardFile(root, marker);
  const legacyFile = legacyGuardFile(root, marker);
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(legacyFile, `${JSON.stringify(conflicting)}\n`, { mode: 0o600 });
  const canonicalBefore = fs.readFileSync(canonicalFile, "utf8");
  const legacyBefore = fs.readFileSync(legacyFile, "utf8");

  assert.equal(hasForeignActiveProvider(root, owner, env), true);
  assert.equal(fs.readFileSync(canonicalFile, "utf8"), canonicalBefore);
  assert.equal(fs.readFileSync(legacyFile, "utf8"), legacyBefore);
});

test("active-provider guards distinguish the owning Claude session and remove stale providers", { skip: process.platform === "win32" }, async () => {
  const root = tempDir("grok-recursion-guard-");
  const marker = "task-0123456789abcdef01234567";
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", marker, "agent", "stdio"], {
    detached: true,
    stdio: "ignore"
  });
  let identity;
  try {
    const startToken = await waitFor(() => processStartToken(child.pid));
    identity = { pid: child.pid, startToken, processGroupId: child.pid };
    registerProviderGuard(root, marker, identity, "claude-owner");
    assert.equal(hasForeignActiveProvider(root, "claude-owner"), false);
    assert.equal(hasForeignActiveProvider(root, "different-session"), true);
    assert.equal(hasForeignActiveProvider(root, null), true);

    process.kill(-child.pid, "SIGKILL");
    await waitFor(() => processStartToken(child.pid) !== startToken);
    assert.equal(hasForeignActiveProvider(root, null), true, "unowned sandbox invocation did not fail closed on a recent guard");
    assert.equal(hasForeignActiveProvider(root, "claude-owner"), false, "owner could not clear its stale provider guard");
    assert.equal(hasForeignActiveProvider(root, null), false, "stale provider guard was not removed");
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    unregisterProviderGuard(root, marker);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("import --json process guards use import identity kind for ownership, recovery, and cleanup", { skip: process.platform === "win32" }, async () => {
  const root = tempDir("grok-import-guard-");
  const marker = "transfer-0123456789abcdef01234567";
  // Mimic `grok import --json ... <marker>` so identityMatches(..., "import") succeeds.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "import", "--json", "--leader-socket", "/tmp/leader.sock", marker], {
    detached: true,
    stdio: "ignore"
  });
  let identity;
  try {
    const startToken = await waitFor(() => processStartToken(child.pid));
    identity = { pid: child.pid, startToken, processGroupId: child.pid };
    registerProviderGuard(root, marker, identity, "transfer-owner", "import");

    assert.equal(hasForeignActiveProvider(root, "transfer-owner"), false, "same-session owner must not treat its live import as foreign");
    assert.equal(hasForeignActiveProvider(root, "other-session"), true, "foreign session must see the live import as active");
    assert.equal(hasForeignActiveProvider(root, null), true, "unowned callers must fail closed on a live import");

    // Cancellation / cleanup path: terminate the import process group and drop the guard.
    process.kill(-child.pid, "SIGTERM");
    await waitFor(() => processStartToken(child.pid) !== startToken);
    assert.equal(hasForeignActiveProvider(root, "transfer-owner"), false, "owner recovery must clear a dead import guard");
    assert.equal(hasForeignActiveProvider(root, null), false, "stale import guard must be removed after verified exit");
    unregisterProviderGuard(root, marker);
    assert.equal(hasForeignActiveProvider(root, "other-session"), false, "cleanup must leave no import guard behind");
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    unregisterProviderGuard(root, marker);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
