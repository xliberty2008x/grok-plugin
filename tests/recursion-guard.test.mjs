import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { spawn } from "node:child_process";

import {
  processGroupGone,
  processStartToken
} from "../plugins/grok/scripts/lib/process-control.mjs";
import { createExecutableAttestation } from "../plugins/grok/scripts/lib/executable-identity.mjs";
import {
  assertProviderGuardForJob,
  assertWorktreeProvisioningGuardForJob,
  authenticateProviderBootstrapGuard,
  authenticateWorktreeProvisioningBootstrapGuard,
  hasForeignActiveProvider,
  loadProviderGuard,
  registerProviderGuard,
  registerWorktreeProvisioningGuard,
  unregisterProviderGuard
} from "../plugins/grok/scripts/lib/recursion-guard.mjs";
import {
  activateWriteProvisioningAttempt,
  admitWriteWorkerPlan,
  prepareWriteProvisionerIntent,
  prepareWriteProvisioningReissue,
  retainWriteProvisioningCleanupPending
} from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import { buildTaskEnvelope } from "../plugins/grok/scripts/lib/task-contract.mjs";
import {
  tryReadJob,
  withWorkspaceStateTransaction,
  writeJob
} from "../plugins/grok/scripts/lib/state.mjs";
import { resolveControlWorkspace } from "../plugins/grok/scripts/lib/workspace.mjs";
import { git, initRepo, tempDir, waitFor } from "./helpers.mjs";

const GUARD_MODULE_URL = new URL("../plugins/grok/scripts/lib/recursion-guard.mjs", import.meta.url).href;
const TEST_EXECUTABLE_IDENTITY = createExecutableAttestation({
  canonicalPath: "/private/test/grok",
  device: "1",
  inode: "2",
  mode: 0o100755,
  size: 4096,
  executableDigest: "1".repeat(64)
}, {
  releaseSource: "official-package-pin-v1",
  packageName: "@xai-official/grok",
  packageVersion: "0.2.112",
  packageGitHead: "9".repeat(40),
  packageIntegrityDigest: "3".repeat(64),
  platform: process.platform,
  arch: process.arch,
  version: "0.2.112",
  buildCommit: "9bbd559437aa",
  channel: "stable",
  size: 4096,
  executableDigest: "1".repeat(64)
});

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalize(value[key])])
  );
}

function stableDigest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function withoutDigest(value, key) {
  const { [key]: _digest, ...body } = value;
  return body;
}

function worktreeIntentDigestBody(intent) {
  return {
    schemaVersion: intent.schemaVersion,
    purpose: intent.purpose,
    workerId: intent.workerId,
    intentId: intent.intentId,
    providerSpawnIntentId: intent.providerSpawnIntentId,
    operationId: intent.operationId,
    executionBindingDigest: intent.executionBindingDigest,
    expectedPlannedJournalDigest: intent.expectedPlannedJournalDigest,
    provisioningAttemptId: intent.provisioningAttemptId,
    provisioningFence: intent.provisioningFence,
    holderId: intent.holderId,
    executableIdentity: intent.executableIdentity,
    preparedAt: intent.preparedAt
  };
}

function worktreeActivationDigest(runtime) {
  return stableDigest({
    schemaVersion: 1,
    intentDigest: runtime.intent.intentDigest,
    providerSpawnIntentId: runtime.intent.providerSpawnIntentId,
    processIdentity: runtime.intent.processIdentity,
    executableIdentityDigest: runtime.intent.executableIdentity.identityDigest,
    activatedAt: runtime.intent.activatedAt,
    activatedJournalDigest: runtime.activatedJournalDigest
  });
}

function resealArchivedAttemptJob(candidate) {
  const runtime = candidate.provisioningRuntime;
  const archive = runtime.priorAttempts[0];
  const archived = archive.attemptEvidence;
  archived.intent.intentDigest = stableDigest(
    worktreeIntentDigestBody(archived.intent)
  );
  archived.activationDigest = worktreeActivationDigest({
    intent: archived.intent,
    activatedJournalDigest: archived.activatedJournalDigest
  });
  archived.cleanupProof.proofDigest = stableDigest(
    withoutDigest(archived.cleanupProof, "proofDigest")
  );
  archive.absenceProof.proofDigest = stableDigest(
    withoutDigest(archive.absenceProof, "proofDigest")
  );
  archive.archiveDigest = stableDigest(
    withoutDigest(archive, "archiveDigest")
  );
  candidate.provisioning.priorAttemptArchiveDigest = archive.archiveDigest;
  candidate.provisioning.journalDigest = stableDigest(
    withoutDigest(candidate.provisioning, "journalDigest")
  );
  runtime.activatedJournalDigest = candidate.provisioning.journalDigest;
  runtime.activationDigest = worktreeActivationDigest(runtime);
  return candidate;
}

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
  assert.equal(first.schemaVersion, 2);
  assert.equal(Object.hasOwn(first, "executionBindingDigest"), false);

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

test("write provider guard is schema-4 bound and rejects missing, mismatch, downgrade, and stale cleanup", (t) => {
  const root = initRepo();
  const scratch = tempDir("grok-guard-write-binding-");
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: path.join(scratch, "plugin-data") };
  const workerId = "task-ddeeff001122334455667788";
  const attemptId = "223344556677889900aabbccddeeff00";
  const intentId = "3344556677889900aabbccddeeff0011";
  const owner = "guard-write-binding-owner";
  const control = resolveControlWorkspace(root, env);
  const timestamp = new Date().toISOString();
  const executionBindingDigest = "4".repeat(64);
  const providerProcess = {
    pid: 1_960_101,
    startToken: "write-binding-provider-start-token",
    processGroupId: process.platform === "win32" ? null : 1_960_101
  };
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
    write: true,
    status: "running",
    createdAt: timestamp,
    updatedAt: timestamp,
    controlWorkspaceId: control.controlWorkspaceId,
    host: { kind: "codex", sessionId: owner },
    executionBinding: { bindingDigest: executionBindingDigest },
    request: {
      spawn: {
        executionRoot: control.executionRoot,
        executionBindingDigest,
        dispatch: {
          schemaVersion: 2,
          state: "worker-started",
          attemptId,
          fence: 8,
          providerGeneration: 0,
          nextProviderGeneration: null
        },
        providerSpawnIntent: {
          schemaVersion: 1,
          intentId,
          status: "pending",
          attemptId,
          dispatchFence: 8,
          providerGeneration: 1,
          createdAt: timestamp,
          updatedAt: timestamp
        }
      }
    }
  }, env);

  const readShapeBinding = {
    controlWorkspaceId: control.controlWorkspaceId,
    executionRoot: control.executionRoot,
    dispatchAttemptId: attemptId,
    dispatchFence: 8,
    providerGeneration: 1,
    providerSpawnIntentId: intentId
  };
  const writeBinding = {
    ...readShapeBinding,
    executionBindingDigest
  };
  for (const [label, binding] of [
    ["missing", readShapeBinding],
    ["mismatch", {
      ...writeBinding,
      executionBindingDigest: "5".repeat(64)
    }]
  ]) {
    assert.throws(
      () => registerProviderGuard(
        root,
        workerId,
        providerProcess,
        owner,
        "provider",
        binding,
        env
      ),
      (error) => error?.code === "E_PROCESS_IDENTITY",
      label
    );
    assert.equal(loadProviderGuard(root, workerId), null, label);
  }

  const record = registerProviderGuard(
    root,
    workerId,
    providerProcess,
    owner,
    "provider",
    writeBinding,
    env
  );
  assert.equal(record.schemaVersion, 4);
  assert.equal(record.executionBindingDigest, executionBindingDigest);
  const job = withWorkspaceStateTransaction(
    root,
    (transaction) => transaction.tryReadJob(workerId),
    env
  );
  assert.equal(
    assertProviderGuardForJob(root, job, record, { expectedGeneration: 1 }),
    record
  );
  assert.deepEqual(
    authenticateProviderBootstrapGuard(
      root,
      workerId,
      providerProcess,
      writeBinding,
      env
    ),
    record
  );
  assert.throws(
    () => authenticateProviderBootstrapGuard(
      root,
      workerId,
      providerProcess,
      {
        ...writeBinding,
        executionBindingDigest: "6".repeat(64)
      },
      env
    ),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );

  const missingDigest = { ...record };
  delete missingDigest.executionBindingDigest;
  assert.throws(
    () => assertProviderGuardForJob(root, job, missingDigest, { expectedGeneration: 1 }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  const schema3Downgrade = {
    ...missingDigest,
    schemaVersion: 3
  };
  assert.throws(
    () => assertProviderGuardForJob(root, job, schema3Downgrade, { expectedGeneration: 1 }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  const mismatchedRecord = {
    ...record,
    executionBindingDigest: "7".repeat(64)
  };
  assert.throws(
    () => assertProviderGuardForJob(root, job, mismatchedRecord, { expectedGeneration: 1 }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  for (const staleExpected of [schema3Downgrade, mismatchedRecord]) {
    assert.throws(
      () => unregisterProviderGuard(root, workerId, staleExpected, env),
      (error) => error?.code === "E_PROCESS_IDENTITY"
    );
    assert.deepEqual(loadProviderGuard(root, workerId), record);
  }
  assert.equal(unregisterProviderGuard(root, workerId, record, env), true);
  assert.equal(loadProviderGuard(root, workerId), null);
});

test("worktree provisioning guard authenticates only canonical admitted and activated state", async function worktreeProvisioningGuardAuthenticationTest(t) {
  const root = initRepo();
  const scratch = tempDir("grok-guard-worktree-provisioning-");
  const env = {
    ...process.env,
    HOME: scratch,
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_PLUGIN_DATA: path.join(scratch, "plugin-data")
  };
  const owner = "worktree-provisioning-owner";
  const principal = {
    hostKind: "codex",
    threadId: owner,
    turnId: "worktree-provisioning-guard-turn",
    source: "codex-mcp-stdio",
    pluginId: "grok@grok-companion",
    root,
    mutationCapable: true
  };
  const admitted = admitWriteWorkerPlan({
    root,
    principal,
    envelope: buildTaskEnvelope({
      userRequest: "Provision a bounded worker for tracked.txt",
      mode: "write",
      scope: { include: ["tracked.txt"], exclude: [] }
    }),
    idempotencyKey: "guard-canonical-worktree-provisioning-0001",
    roleId: "implementer",
    allowWriteSpawn: true,
    writeLifecycleCapabilityDigest: "8".repeat(64),
    env
  });
  const workerId = admitted.handle.id;
  const planned = tryReadJob(root, workerId, env);
  const actor = {
    attemptId: "9".repeat(32),
    fence: 1,
    holderId: "a".repeat(32),
    executableIdentity: TEST_EXECUTABLE_IDENTITY
  };
  const prepared = prepareWriteProvisionerIntent({
    root,
    principal,
    workerId,
    executionBindingDigest: planned.executionBinding.bindingDigest,
    expectedJournalDigest: planned.provisioning.journalDigest,
    ...actor,
    env
  });
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", workerId, "worktree-provisioning"],
    { detached: true, stdio: "ignore" }
  );
  const startToken = await waitFor(() => processStartToken(child.pid), {
    timeoutMs: 5_000,
    intervalMs: 25
  });
  const providerProcess = {
    pid: child.pid,
    startToken,
    processGroupId: process.platform === "win32" ? null : child.pid
  };
  const provisioningAt = new Date(
    Math.max(Date.now(), Date.parse(prepared.intent.preparedAt) + 1)
  ).toISOString();
  const activated = activateWriteProvisioningAttempt({
    root,
    principal,
    workerId,
    executionBindingDigest: planned.executionBinding.bindingDigest,
    expectedJournalDigest: planned.provisioning.journalDigest,
    ...actor,
    providerSpawnIntentId: prepared.intent.providerSpawnIntentId,
    processIdentity: providerProcess,
    provisioningAt,
    leaseExpiresAt: new Date(Date.parse(provisioningAt) + 60_000).toISOString(),
    env
  });
  const control = resolveControlWorkspace(root, env);
  const expectedExecutionRoot = activated.job.executionBinding.expectedExecutionRoot;
  const binding = {
    purpose: "worktree-provisioning",
    controlWorkspaceId: control.controlWorkspaceId,
    controlRoot: control.controlRoot,
    expectedExecutionRoot,
    executionBindingDigest: activated.job.executionBinding.bindingDigest,
    provisioningAttemptId: actor.attemptId,
    provisioningFence: actor.fence,
    holderId: actor.holderId,
    providerSpawnIntentId: prepared.intent.providerSpawnIntentId
  };
  let reissueChild = null;
  let reissueIdentity = null;
  t.after(async () => {
    try { unregisterProviderGuard(root, workerId, null, env); } catch {}
    for (const [ownedChild, identity] of [
      [child, providerProcess],
      [reissueChild, reissueIdentity]
    ]) {
      if (!ownedChild || !identity) continue;
      try {
        process.kill(
          process.platform === "win32"
            ? ownedChild.pid
            : -ownedChild.pid,
          "SIGKILL"
        );
      } catch {}
      try {
        await waitFor(() => processGroupGone(identity), {
          timeoutMs: 5_000,
          intervalMs: 25
        });
      } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const record = registerWorktreeProvisioningGuard(
    root,
    workerId,
    providerProcess,
    owner,
    binding,
    env
  );
  assert.equal(record.schemaVersion, 5);
  assert.equal(record.purpose, "worktree-provisioning");
  assert.equal(record.controlRoot, control.controlRoot);
  assert.equal(record.expectedExecutionRoot, expectedExecutionRoot);
  assert.equal(record.executionBindingDigest, binding.executionBindingDigest);
  assert.equal(record.provisioningAttemptId, binding.provisioningAttemptId);
  assert.equal(record.provisioningFence, binding.provisioningFence);
  assert.equal(record.holderId, binding.holderId);
  assert.equal(record.providerSpawnIntentId, binding.providerSpawnIntentId);
  const job = withWorkspaceStateTransaction(
    root,
    (transaction) => transaction.tryReadJob(workerId),
    env
  );
  assert.equal(job.request?.spawn?.dispatch, undefined, "provisioning guard must not synthesize dispatch");
  assert.equal(job.provisioningRuntime.intent.status, "registered");
  assert.equal(
    assertWorktreeProvisioningGuardForJob(
      root,
      job,
      record,
      { expectedBinding: binding, env }
    ),
    record
  );
  assert.deepEqual(
    authenticateWorktreeProvisioningBootstrapGuard(
      root,
      workerId,
      providerProcess,
      binding,
      env
    ),
    record
  );
  assert.deepEqual(
    registerWorktreeProvisioningGuard(
      root,
      workerId,
      providerProcess,
      owner,
      binding,
      env
    ),
    record,
    "exact registration replay must preserve the original guard"
  );

  const corruptions = [
    ["execution binding digest", (candidate) => {
      candidate.executionBinding.bindingDigest = "d".repeat(64);
    }],
    ["provisioning journal digest", (candidate) => {
      candidate.provisioning.journalDigest = "d".repeat(64);
    }],
    ["runtime extra field", (candidate) => {
      candidate.provisioningRuntime.extra = true;
    }],
    ["intent extra field", (candidate) => {
      candidate.provisioningRuntime.intent.extra = true;
    }],
    ["process extra field", (candidate) => {
      candidate.provisioningRuntime.intent.processIdentity.extra = true;
    }],
    ["intent digest", (candidate) => {
      candidate.provisioningRuntime.intent.intentDigest = "d".repeat(64);
    }],
    ["activation digest", (candidate) => {
      candidate.provisioningRuntime.activationDigest = "d".repeat(64);
    }],
    ["premature official receipt", (candidate) => {
      candidate.provisioningRuntime.officialReceipt = {};
    }],
    ["premature host adoption", (candidate) => {
      candidate.provisioningRuntime.hostAdoption = {};
    }],
    ["premature execution context", (candidate) => {
      candidate.provisioningRuntime.executionContextManifest = {};
    }],
    ["premature execution context digest", (candidate) => {
      candidate.provisioningRuntime.executionContextManifestRecordDigest = "d".repeat(64);
    }],
    ["premature cleanup proof", (candidate) => {
      candidate.provisioningRuntime.cleanupProof = {};
    }],
    ["dispatch authority", (candidate) => {
      candidate.request.spawn.dispatch = {};
    }],
    ["provider launch flag", (candidate) => {
      candidate.request.spawn.providerLaunchInFlight = true;
    }],
    ["wrong lifecycle phase", (candidate) => {
      candidate.phase = "worktree-ready";
    }]
  ];
  for (const [label, corrupt] of corruptions) {
    const candidate = structuredClone(job);
    corrupt(candidate);
    assert.throws(
      () => assertWorktreeProvisioningGuardForJob(
        root,
        candidate,
        record,
        { expectedBinding: binding, env }
      ),
      (error) => error?.code === "E_PROCESS_IDENTITY",
      label
    );
  }

  const bindingDrifts = [
    ["purpose", "provider-execution"],
    ["controlWorkspaceId", `cws-${"c".repeat(32)}`],
    ["controlRoot", `${control.controlRoot}-other`],
    ["expectedExecutionRoot", `${expectedExecutionRoot}-other`],
    ["executionBindingDigest", "d".repeat(64)],
    ["provisioningAttemptId", "e".repeat(32)],
    ["provisioningFence", 2],
    ["holderId", "f".repeat(32)],
    ["providerSpawnIntentId", "0".repeat(32)]
  ];
  for (const [field, value] of bindingDrifts) {
    assert.throws(
      () => authenticateWorktreeProvisioningBootstrapGuard(
        root,
        workerId,
        providerProcess,
        { ...binding, [field]: value },
        env
      ),
      (error) => error?.code === "E_PROCESS_IDENTITY",
      field
    );
  }
  const missingHolder = { ...binding };
  delete missingHolder.holderId;
  assert.throws(
    () => authenticateWorktreeProvisioningBootstrapGuard(
      root,
      workerId,
      providerProcess,
      missingHolder,
      env
    ),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  const missingPurposeRecord = { ...record };
  delete missingPurposeRecord.purpose;
  assert.throws(
    () => assertWorktreeProvisioningGuardForJob(root, job, missingPurposeRecord, { env }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  const competingProcess = {
    ...providerProcess,
    pid: providerProcess.pid + 1,
    processGroupId: process.platform === "win32" ? null : providerProcess.pid + 1
  };
  assert.throws(
    () => registerWorktreeProvisioningGuard(
      root,
      workerId,
      competingProcess,
      owner,
      binding,
      env
    ),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  assert.deepEqual(loadProviderGuard(root, workerId), record);
  assert.equal(unregisterProviderGuard(root, workerId, record, env), true);
  assert.equal(loadProviderGuard(root, workerId), null);

  process.kill(
    process.platform === "win32" ? child.pid : -child.pid,
    "SIGKILL"
  );
  await waitFor(() => processGroupGone(providerProcess), {
    timeoutMs: 5_000,
    intervalMs: 25
  });
  const cleanupPendingAt = new Date(
    Math.max(
      Date.now(),
      Date.parse(job.provisioningRuntime.intent.registeredAt) + 1
    )
  ).toISOString();
  const retained = retainWriteProvisioningCleanupPending({
    root,
    principal,
    workerId,
    executionBindingDigest: binding.executionBindingDigest,
    expectedJournalDigest: job.provisioning.journalDigest,
    ...actor,
    providerSpawnIntentId: prepared.intent.providerSpawnIntentId,
    processIdentity: providerProcess,
    cleanupProof: {
      processIdentity: providerProcess,
      processGroupGone: true,
      providerGuardAbsent: true,
      observedAt: cleanupPendingAt
    },
    cleanupPendingAt,
    env
  });
  const workerParent = path.dirname(expectedExecutionRoot);
  const managedRoot = path.dirname(workerParent);
  fs.mkdirSync(workerParent, { recursive: true, mode: 0o700 });
  fs.chmodSync(managedRoot, 0o700);
  fs.chmodSync(workerParent, 0o700);
  const reissueActor = {
    attemptId: "b".repeat(32),
    fence: 2,
    holderId: "c".repeat(32),
    executableIdentity: TEST_EXECUTABLE_IDENTITY
  };
  const reissue = prepareWriteProvisioningReissue({
    root,
    principal,
    workerId,
    executionBindingDigest: binding.executionBindingDigest,
    expectedJournalDigest: retained.job.provisioning.journalDigest,
    ...reissueActor,
    env
  });
  reissueChild = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", workerId, "worktree-provisioning"],
    { detached: true, stdio: "ignore" }
  );
  reissueIdentity = {
    pid: reissueChild.pid,
    startToken: await waitFor(() => processStartToken(reissueChild.pid), {
      timeoutMs: 5_000,
      intervalMs: 25
    }),
    processGroupId: process.platform === "win32" ? null : reissueChild.pid
  };
  const reissueProvisioningAt = new Date(
    Math.max(Date.now(), Date.parse(reissue.intent.preparedAt) + 1)
  ).toISOString();
  const reissueActivated = activateWriteProvisioningAttempt({
    root,
    principal,
    workerId,
    executionBindingDigest: binding.executionBindingDigest,
    expectedJournalDigest: reissue.job.provisioning.journalDigest,
    ...reissueActor,
    providerSpawnIntentId: reissue.intent.providerSpawnIntentId,
    processIdentity: reissueIdentity,
    provisioningAt: reissueProvisioningAt,
    leaseExpiresAt: new Date(
      Date.parse(reissueProvisioningAt) + 60_000
    ).toISOString(),
    env
  });
  const reissueBinding = {
    ...binding,
    provisioningAttemptId: reissueActor.attemptId,
    provisioningFence: reissueActor.fence,
    holderId: reissueActor.holderId,
    providerSpawnIntentId: reissue.intent.providerSpawnIntentId
  };
  const reissueRecord = registerWorktreeProvisioningGuard(
    root,
    workerId,
    reissueIdentity,
    owner,
    reissueBinding,
    env
  );
  const reissueJob = withWorkspaceStateTransaction(
    root,
    (transaction) => transaction.tryReadJob(workerId),
    env
  );
  assert.equal(
    assertWorktreeProvisioningGuardForJob(
      root,
      reissueJob,
      reissueRecord,
      { expectedBinding: reissueBinding, env }
    ),
    reissueRecord
  );
  assert.equal(
    reissueJob.provisioningRuntime.priorAttempts.length,
    1
  );
  const absentParentArchiveJob = structuredClone(reissueJob);
  absentParentArchiveJob.provisioningRuntime
    .priorAttempts[0].absenceProof.workerParentState = "absent";
  absentParentArchiveJob.provisioningRuntime
    .priorAttempts[0].absenceProof.workerParentIdentityDigest = null;
  resealArchivedAttemptJob(absentParentArchiveJob);
  assert.equal(
    assertWorktreeProvisioningGuardForJob(
      root,
      absentParentArchiveJob,
      reissueRecord,
      { expectedBinding: reissueBinding, env }
    ),
    reissueRecord
  );

  const rehashedArchiveCorruptions = [
    ["archived intent purpose", (candidate) => {
      candidate.provisioningRuntime
        .priorAttempts[0].attemptEvidence.intent.purpose = "provider-execution";
    }],
    ["cleanup proof schema", (candidate) => {
      candidate.provisioningRuntime
        .priorAttempts[0].attemptEvidence.cleanupProof.schemaVersion = 2;
    }],
    ["absence inventory digest", (candidate) => {
      candidate.provisioningRuntime
        .priorAttempts[0].absenceProof.rawInventoryDigest = "not-sha256";
    }],
    ["archived cleanup timeline", (candidate) => {
      const archive = candidate.provisioningRuntime.priorAttempts[0];
      archive.attemptEvidence.intent.updatedAt = new Date(
        Date.parse(
          archive.sourceCleanupPendingJournal.cleanupPendingAt
        ) + 1
      ).toISOString();
    }]
  ];
  for (const [label, corrupt] of rehashedArchiveCorruptions) {
    const candidate = structuredClone(reissueJob);
    corrupt(candidate);
    resealArchivedAttemptJob(candidate);
    assert.throws(
      () => assertWorktreeProvisioningGuardForJob(
        root,
        candidate,
        reissueRecord,
        { expectedBinding: reissueBinding, env }
      ),
      (error) => error?.code === "E_PROCESS_IDENTITY",
      label
    );
  }
  assert.equal(
    unregisterProviderGuard(root, workerId, reissueRecord, env),
    true
  );
  assert.equal(loadProviderGuard(root, workerId), null);
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
