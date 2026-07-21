import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  resolveControlWorkspace,
  controlStateDir,
  controlStateSegment,
  resolveAdmissionLockName,
  controlAdmissionLockName,
  workspaceStateSegment,
  workspaceState,
  resolveWorkspaceStateDir,
  mainWorktreeRoot
} from "../plugins/grok/scripts/lib/workspace.mjs";
import {
  assertSafeRelativePath,
  captureParentFingerprint,
  assertParentUnchanged,
  createWorkerWorktree,
  buildArtifactManifest,
  validateArtifactForIntegration,
  prepareIntegration,
  removeWorkerWorktree
} from "../plugins/grok/scripts/lib/worker-worktree.mjs";
import { admitJob, listJobs, tryReadJob, updateJob, generateId, now } from "../plugins/grok/scripts/lib/state.mjs";
import { buildTaskEnvelope } from "../plugins/grok/scripts/lib/task-contract.mjs";
import { spawnReadOnlyWorker } from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import { initRepo, tempDir, git } from "./helpers.mjs";

function envFor() {
  const pluginData = tempDir("grok-worktree-data-");
  return {
    HOME: path.dirname(pluginData),
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_PLUGIN_DATA: pluginData
  };
}

function installLegacyMigrationClock(env, {
  metadataTtl = 100,
  fullRescanInterval = 1_000
} = {}) {
  let current = 10_000;
  env.__GROK_COMPANION_LEGACY_MIGRATION_NOW = () => current;
  env.__GROK_COMPANION_LEGACY_METADATA_TTL_MS = metadataTtl;
  env.__GROK_COMPANION_LEGACY_FULL_RESCAN_MS = fullRescanInterval;
  return {
    advance(milliseconds) { current += milliseconds; }
  };
}

function principal(root) {
  return {
    hostKind: "codex",
    threadId: "019f666a-6469-7cc1-9a8d-8c1adf61e103",
    source: "codex-mcp-stdio",
    pluginId: "grok@grok-companion",
    root
  };
}

function scopeFor(...include) {
  return { include, exclude: [] };
}

/**
 * Create a real linked git worktree sibling of the primary repo.
 * Returns absolute execution path of the linked worktree.
 */
function addLinkedWorktree(primaryRoot, name = "linked-wt") {
  const linked = path.join(path.dirname(primaryRoot), `${path.basename(primaryRoot)}-${name}`);
  const base = git(primaryRoot, "rev-parse", "HEAD");
  git(primaryRoot, "worktree", "add", "--detach", linked, base);
  return fs.realpathSync(linked);
}

test("control workspace identity is stable across linked worktree paths", () => {
  const root = initRepo();
  const env = envFor();
  const linked = addLinkedWorktree(root);

  const fromPrimary = resolveControlWorkspace(root, env);
  const fromLinked = resolveControlWorkspace(linked, env);

  assert.match(fromPrimary.controlWorkspaceId, /^cws-[a-f0-9]{32}$/);
  assert.equal(fromPrimary.controlWorkspaceId, fromLinked.controlWorkspaceId);
  // controlRoot is the main worktree, not the linked path.
  assert.equal(fromPrimary.controlRoot, fs.realpathSync(root));
  assert.equal(fromLinked.controlRoot, fs.realpathSync(root));
  assert.notEqual(fromLinked.executionRoot, fromLinked.controlRoot);
  assert.equal(fromLinked.executionRoot, linked);
  assert.equal(fromPrimary.executionRoot, fs.realpathSync(root));

  // Shared state directory for both paths.
  const statePrimary = workspaceState(root, env);
  const stateLinked = workspaceState(linked, env);
  assert.equal(statePrimary, stateLinked);
  assert.ok(statePrimary.includes(controlStateSegment(fromPrimary.controlWorkspaceId)));

  // Shared admission lock name.
  const lockPrimary = resolveAdmissionLockName(root, env);
  const lockLinked = resolveAdmissionLockName(linked, env);
  assert.equal(lockPrimary, lockLinked);
  assert.equal(lockPrimary, controlAdmissionLockName(fromPrimary.controlWorkspaceId));

  git(root, "worktree", "remove", "--force", linked);
});

test("first control-state initialization migrates legacy jobs once without hiding later control updates", () => {
  const root = initRepo();
  const env = envFor();
  const stateParent = path.join(env.GROK_COMPANION_PLUGIN_DATA, "state");
  const legacy = path.join(stateParent, workspaceStateSegment(fs.realpathSync(root)));
  const jobs = path.join(legacy, "jobs");
  fs.mkdirSync(jobs, { recursive: true, mode: 0o700 });
  const id = "task-aaaaaaaaaaaaaaaa";
  const legacyJob = {
    schemaVersion: 3,
    id,
    kind: "task",
    jobClass: "task",
    write: false,
    status: "completed",
    phase: "completed",
    summary: "legacy-visible",
    createdAt: now(),
    updatedAt: now(),
    host: { kind: "codex", sessionId: principal(root).threadId },
    lifecycleEvents: [],
    request: null,
    result: null,
    error: null
  };
  fs.writeFileSync(path.join(jobs, `${id}.json`), `${JSON.stringify(legacyJob)}\n`, { mode: 0o600 });

  assert.equal(tryReadJob(root, id, env)?.summary, "legacy-visible");
  const controlState = workspaceState(root, env);
  assert.notEqual(controlState, legacy);
  assert.equal(tryReadJob(root, id, env)?.summary, "legacy-visible");
  assert.ok(listJobs(root, env).some((job) => job.id === id));

  updateJob(root, id, (job) => ({ ...job, summary: "control-evolved" }), env);
  assert.equal(workspaceState(root, env), controlState, "completed migration must not recopy stale legacy data");
  assert.equal(tryReadJob(root, id, env)?.summary, "control-evolved");
  assert.equal(
    fs.readdirSync(controlState).filter((name) => name.startsWith(".legacy-migration-v3-")).length,
    1
  );
});

test("existing v2 migration read-through imports a late legacy job and artifacts idempotently", () => {
  const root = initRepo();
  const env = envFor();
  const clock = installLegacyMigrationClock(env);
  const stateParent = path.join(env.GROK_COMPANION_PLUGIN_DATA, "state");
  const legacy = path.join(stateParent, workspaceStateSegment(fs.realpathSync(root)));
  const legacyJobs = path.join(legacy, "jobs");
  const control = resolveControlWorkspace(root, env);
  const controlState = path.join(stateParent, controlStateSegment(control.controlWorkspaceId));
  const controlJobs = path.join(controlState, "jobs");
  fs.mkdirSync(legacyJobs, { recursive: true, mode: 0o700 });
  fs.mkdirSync(controlJobs, { recursive: true, mode: 0o700 });

  const makeJob = (id, summary) => ({
    schemaVersion: 3,
    id,
    kind: "task",
    jobClass: "task",
    write: false,
    status: "completed",
    phase: "completed",
    summary,
    createdAt: now(),
    updatedAt: now(),
    host: { kind: "codex", sessionId: principal(root).threadId },
    lifecycleEvents: [],
    request: null,
    result: null,
    error: null
  });
  const firstId = "task-aaaaaaaaaaaaaaa1";
  const firstContents = `${JSON.stringify(makeJob(firstId, "already-migrated"))}\n`;
  const retainedLegacyJob = path.join(legacyJobs, `${firstId}.json`);
  fs.writeFileSync(retainedLegacyJob, firstContents, { mode: 0o600 });
  fs.writeFileSync(path.join(controlJobs, `${firstId}.json`), firstContents, { mode: 0o600 });

  // Simulate the exact on-disk state produced by the former one-shot v2
  // migrator before the old process performs another write.
  const sourceDigest = crypto.createHash("sha256").update(fs.realpathSync(legacy)).digest("hex");
  const v2Marker = path.join(controlState, `.legacy-migration-v2-${sourceDigest.slice(0, 32)}.json`);
  fs.writeFileSync(v2Marker, `${JSON.stringify({ schemaVersion: 2, sourceDigest })}\n`, { mode: 0o600 });

  // Prime the v2-to-v3 acknowledgement, then prove hot readonly polling does
  // not re-open/hash retained legacy payloads inside the metadata TTL.
  assert.equal(tryReadJob(root, firstId, env)?.summary, "already-migrated");
  let legacyPayloadOpens = 0;
  const originalOpen = fs.openSync;
  fs.openSync = (file, ...args) => {
    if (file === retainedLegacyJob) legacyPayloadOpens += 1;
    return originalOpen(file, ...args);
  };
  try {
    for (let index = 0; index < 10; index += 1) {
      assert.equal(tryReadJob(root, firstId, env)?.summary, "already-migrated");
    }
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(
    legacyPayloadOpens,
    0,
    "hot read-through polling reopened the retained legacy payload"
  );

  const lateId = "task-bbbbbbbbbbbbbbb2";
  const lateContents = `${JSON.stringify(makeJob(lateId, "late-legacy-visible"))}\n`;
  fs.writeFileSync(path.join(legacyJobs, `${lateId}.json`), lateContents, { mode: 0o600 });
  fs.writeFileSync(path.join(legacyJobs, `${lateId}.log`), "late log evidence\n", { mode: 0o600 });
  clock.advance(101);

  // A readonly lookup performs the cutover read-through into the already
  // existing control store; callers do not need a separate mutating command.
  assert.equal(tryReadJob(root, lateId, env)?.summary, "late-legacy-visible");
  assert.equal(fs.readFileSync(path.join(controlJobs, `${lateId}.log`), "utf8"), "late log evidence\n");
  assert.ok(fs.existsSync(v2Marker), "legacy evidence/marker must be retained");
  const markerCount = fs.readdirSync(controlState)
    .filter((name) => name.startsWith(".legacy-migration-v3-")).length;
  assert.equal(markerCount, 2);

  assert.equal(workspaceState(root, env), fs.realpathSync(controlState));
  assert.equal(tryReadJob(root, lateId, env)?.summary, "late-legacy-visible");
  assert.equal(
    fs.readdirSync(controlState).filter((name) => name.startsWith(".legacy-migration-v3-")).length,
    markerCount,
    "repeated access must reuse the immutable source snapshot receipt"
  );

  updateJob(root, lateId, (job) => ({ ...job, summary: "control-evolved-after-cutover" }), env);
  assert.equal(tryReadJob(root, lateId, env)?.summary, "control-evolved-after-cutover");
  assert.equal(fs.readFileSync(path.join(legacyJobs, `${lateId}.json`), "utf8"), lateContents);
});

test("divergent late legacy write fails closed without overwriting control state", () => {
  const root = initRepo();
  const env = envFor();
  const clock = installLegacyMigrationClock(env);
  const stateParent = path.join(env.GROK_COMPANION_PLUGIN_DATA, "state");
  const legacy = path.join(stateParent, workspaceStateSegment(fs.realpathSync(root)));
  const legacyJobs = path.join(legacy, "jobs");
  fs.mkdirSync(legacyJobs, { recursive: true, mode: 0o700 });
  const id = "task-ccccccccccccccc3";
  const base = {
    schemaVersion: 3,
    id,
    kind: "task",
    jobClass: "task",
    write: false,
    status: "completed",
    phase: "completed",
    summary: "initial",
    createdAt: now(),
    updatedAt: now(),
    host: { kind: "codex", sessionId: principal(root).threadId },
    lifecycleEvents: [],
    request: null,
    result: null,
    error: null
  };
  const legacyJobFile = path.join(legacyJobs, `${id}.json`);
  fs.writeFileSync(legacyJobFile, `${JSON.stringify(base)}\n`, { mode: 0o600 });
  const controlState = workspaceState(root, env);
  updateJob(root, id, (job) => ({ ...job, summary: "control-authoritative" }), env);
  const controlJobFile = path.join(controlState, "jobs", `${id}.json`);
  const controlContents = fs.readFileSync(controlJobFile, "utf8");

  fs.writeFileSync(legacyJobFile, `${JSON.stringify({ ...base, summary: "late-legacy-divergence" })}\n`);
  clock.advance(101);
  for (const access of [
    () => workspaceState(root, env),
    () => tryReadJob(root, id, env),
    () => workspaceState(root, env)
  ]) {
    assert.throws(
      access,
      (error) => error?.code === "E_STATE" && /Conflicting late legacy\/control state/.test(error.message)
    );
    assert.equal(fs.readFileSync(controlJobFile, "utf8"), controlContents, "control record was overwritten");
  }
  assert.equal(
    fs.readdirSync(controlState).filter((name) => name.startsWith(".legacy-migration-v3-")).length,
    1,
    "a conflicting source generation must not receive an acknowledgement"
  );
});

test("active legacy job blocks cutover and admission until quiescent without partial copy", () => {
  const root = initRepo();
  const env = envFor();
  const clock = installLegacyMigrationClock(env);
  const stateParent = path.join(env.GROK_COMPANION_PLUGIN_DATA, "state");
  const legacy = path.join(stateParent, workspaceStateSegment(fs.realpathSync(root)));
  const legacyJobs = path.join(legacy, "jobs");
  fs.mkdirSync(legacyJobs, { recursive: true, mode: 0o700 });
  const makeJob = (id, status, summary) => ({
    schemaVersion: 3,
    id,
    kind: "task",
    jobClass: "task",
    write: false,
    status,
    phase: status === "running" ? "executing" : "completed",
    summary,
    createdAt: now(),
    updatedAt: now(),
    host: { kind: "codex", sessionId: principal(root).threadId },
    lifecycleEvents: [],
    request: null,
    result: null,
    error: null
  });
  const terminalId = "task-111111111111111a";
  const activeId = "task-222222222222222b";
  const activeFile = path.join(legacyJobs, `${activeId}.json`);
  fs.writeFileSync(
    path.join(legacyJobs, `${terminalId}.json`),
    `${JSON.stringify(makeJob(terminalId, "completed", "terminal-ready"))}\n`,
    { mode: 0o600 }
  );
  fs.writeFileSync(
    activeFile,
    `${JSON.stringify(makeJob(activeId, "running", "old-worker-active"))}\n`,
    { mode: 0o600 }
  );

  const cutoverBlocked = (error) => error?.code === "E_STATE"
    && /pre-upgrade workers to finish or stop/.test(error.message)
    && !error.message.includes(root)
    && !error.message.includes(activeId);
  assert.throws(() => workspaceState(root, env), cutoverBlocked);
  const control = resolveControlWorkspace(root, env);
  const controlState = path.join(
    fs.realpathSync(stateParent),
    controlStateSegment(control.controlWorkspaceId)
  );
  assert.equal(fs.existsSync(path.join(controlState, "jobs")), false, "terminal record copied before global quiescence");
  assert.equal(
    fs.readdirSync(controlState).some((name) => name.startsWith(".legacy-migration-v3-")),
    false
  );

  assert.throws(
    () => admitJob(root, makeJob("task-333333333333333c", "queued", "new-control-admission"), env),
    cutoverBlocked
  );
  assert.equal(fs.existsSync(path.join(controlState, "jobs")), false, "control admission bypassed cutover fence");

  fs.writeFileSync(
    activeFile,
    `${JSON.stringify(makeJob(activeId, "completed", "old-worker-finished"))}\n`,
    { mode: 0o600 }
  );
  clock.advance(101);
  assert.equal(workspaceState(root, env), controlState);
  assert.equal(tryReadJob(root, terminalId, env)?.summary, "terminal-ready");
  assert.equal(tryReadJob(root, activeId, env)?.summary, "old-worker-finished");
});

test("active legacy job in a linked worktree blocks every source before cutover", () => {
  const root = initRepo();
  const env = envFor();
  const clock = installLegacyMigrationClock(env);
  const linked = addLinkedWorktree(root, "active-legacy-source");
  const stateParent = path.join(env.GROK_COMPANION_PLUGIN_DATA, "state");
  const primaryId = "task-444444444444444d";
  const linkedId = "task-555555555555555e";
  const makeJob = (id, status, summary, sourceRoot) => ({
    schemaVersion: 3,
    id,
    kind: "task",
    jobClass: "task",
    write: false,
    status,
    phase: status === "running" ? "executing" : "completed",
    summary,
    createdAt: now(),
    updatedAt: now(),
    host: { kind: "codex", sessionId: principal(sourceRoot).threadId },
    lifecycleEvents: [],
    request: null,
    result: null,
    error: null
  });
  const primaryJobs = path.join(
    stateParent,
    workspaceStateSegment(fs.realpathSync(root)),
    "jobs"
  );
  const linkedJobs = path.join(
    stateParent,
    workspaceStateSegment(fs.realpathSync(linked)),
    "jobs"
  );
  fs.mkdirSync(primaryJobs, { recursive: true, mode: 0o700 });
  fs.mkdirSync(linkedJobs, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(primaryJobs, `${primaryId}.json`),
    `${JSON.stringify(makeJob(primaryId, "completed", "primary-terminal", root))}\n`,
    { mode: 0o600 }
  );
  const linkedJobFile = path.join(linkedJobs, `${linkedId}.json`);
  fs.writeFileSync(
    linkedJobFile,
    `${JSON.stringify(makeJob(linkedId, "running", "linked-active", linked))}\n`,
    { mode: 0o600 }
  );

  assert.throws(
    () => workspaceState(root, env),
    (error) => error?.code === "E_STATE" && /pre-upgrade workers to finish or stop/.test(error.message)
  );
  const control = resolveControlWorkspace(root, env);
  const controlState = path.join(
    fs.realpathSync(stateParent),
    controlStateSegment(control.controlWorkspaceId)
  );
  assert.equal(fs.existsSync(path.join(controlState, "jobs")), false, "primary source was copied before linked preflight");

  fs.writeFileSync(
    linkedJobFile,
    `${JSON.stringify(makeJob(linkedId, "completed", "linked-finished", linked))}\n`,
    { mode: 0o600 }
  );
  clock.advance(101);
  assert.equal(workspaceState(linked, env), controlState);
  assert.equal(tryReadJob(root, primaryId, env)?.summary, "primary-terminal");
  assert.equal(tryReadJob(linked, linkedId, env)?.summary, "linked-finished");

  git(root, "worktree", "remove", "--force", linked);
});

test("unknown status and invalid legacy job filename fail closed without private-path disclosure", () => {
  const root = initRepo();
  const env = envFor();
  const clock = installLegacyMigrationClock(env);
  const stateParent = path.join(env.GROK_COMPANION_PLUGIN_DATA, "state");
  const legacyJobs = path.join(
    stateParent,
    workspaceStateSegment(fs.realpathSync(root)),
    "jobs"
  );
  fs.mkdirSync(legacyJobs, { recursive: true, mode: 0o700 });
  const id = "task-666666666666666f";
  const record = {
    schemaVersion: 3,
    id,
    kind: "task",
    jobClass: "task",
    write: false,
    status: "draining",
    phase: "unknown-future-phase",
    summary: "unknown status",
    createdAt: now(),
    updatedAt: now(),
    host: { kind: "codex", sessionId: principal(root).threadId },
    lifecycleEvents: [],
    request: null,
    result: null,
    error: null
  };
  const jobFile = path.join(legacyJobs, `${id}.json`);
  fs.writeFileSync(jobFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  const invalidLegacyState = (error) => error?.code === "E_STATE"
    && error.message === "Invalid legacy job state during control-state cutover."
    && !error.message.includes(root)
    && !error.message.includes(id);
  assert.throws(() => workspaceState(root, env), invalidLegacyState);

  fs.writeFileSync(
    jobFile,
    `${JSON.stringify({ ...record, status: "completed", phase: "completed" })}\n`
  );
  const invalidName = path.join(legacyJobs, "task-short.json");
  fs.writeFileSync(invalidName, `${JSON.stringify({ ...record, id: "task-short", status: "completed" })}\n`);
  clock.advance(101);
  assert.throws(() => workspaceState(root, env), invalidLegacyState);

  fs.unlinkSync(invalidName);
  clock.advance(101);
  assert.ok(workspaceState(root, env));
  assert.equal(tryReadJob(root, id, env)?.status, "completed");
});

test("legacy migration rejects nested symlink escape without copying external evidence", () => {
  const root = initRepo();
  const env = envFor();
  const stateParent = path.join(env.GROK_COMPANION_PLUGIN_DATA, "state");
  const legacy = path.join(stateParent, workspaceStateSegment(fs.realpathSync(root)));
  const outside = tempDir("grok-legacy-outside-");
  const external = path.join(outside, "task-ddddddddddddddd4.json");
  fs.writeFileSync(external, "outside evidence\n", { mode: 0o600 });
  fs.mkdirSync(legacy, { recursive: true, mode: 0o700 });
  fs.symlinkSync(outside, path.join(legacy, "jobs"), "dir");

  assert.throws(
    () => workspaceState(root, env),
    (error) => error?.code === "E_STATE" && /symlink in legacy state migration/.test(error.message)
  );
  assert.equal(fs.readFileSync(external, "utf8"), "outside evidence\n");
  const control = resolveControlWorkspace(root, env);
  const controlState = path.join(stateParent, controlStateSegment(control.controlWorkspaceId));
  assert.equal(fs.existsSync(path.join(controlState, "jobs", path.basename(external))), false);
});

test("control-state initialization migrates legacy jobs from every registered linked worktree", () => {
  const root = initRepo();
  const env = envFor();
  const clock = installLegacyMigrationClock(env);
  const linked = addLinkedWorktree(root, "legacy-source");
  const stateParent = path.join(env.GROK_COMPANION_PLUGIN_DATA, "state");
  const sources = [
    {
      root,
      id: "task-1111111111111111",
      summary: "legacy-primary"
    },
    {
      root: linked,
      id: "task-2222222222222222",
      summary: "legacy-linked"
    }
  ];

  for (const source of sources) {
    const legacy = path.join(stateParent, workspaceStateSegment(fs.realpathSync(source.root)));
    const jobs = path.join(legacy, "jobs");
    fs.mkdirSync(jobs, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(jobs, `${source.id}.json`), `${JSON.stringify({
      schemaVersion: 3,
      id: source.id,
      kind: "task",
      jobClass: "task",
      write: false,
      status: "completed",
      phase: "completed",
      summary: source.summary,
      createdAt: now(),
      updatedAt: now(),
      host: { kind: "codex", sessionId: principal(source.root).threadId },
      lifecycleEvents: [],
      request: null,
      result: null,
      error: null
    })}\n`, { mode: 0o600 });
  }

  // Before control initialization, the readonly resolver still discovers the
  // path-keyed source belonging to the caller.
  assert.equal(tryReadJob(linked, sources[1].id, env)?.summary, "legacy-linked");
  const controlState = workspaceState(root, env);
  for (const source of sources) {
    assert.equal(tryReadJob(root, source.id, env)?.summary, source.summary);
    assert.equal(tryReadJob(linked, source.id, env)?.summary, source.summary);
  }
  assert.equal(
    fs.readdirSync(controlState).filter((name) => name.startsWith(".legacy-migration-v3-")).length,
    2
  );

  // Re-entry from another process/path must use the completed per-source
  // markers and never overwrite newer control-state mutations.
  updateJob(root, sources[1].id, (job) => ({ ...job, summary: "control-linked-evolved" }), env);
  assert.equal(workspaceState(linked, env), controlState);
  assert.equal(tryReadJob(root, sources[1].id, env)?.summary, "control-linked-evolved");

  const lateLinkedId = "task-3333333333333333";
  const lateLinkedLegacy = path.join(
    stateParent,
    workspaceStateSegment(fs.realpathSync(linked)),
    "jobs",
    `${lateLinkedId}.json`
  );
  fs.writeFileSync(lateLinkedLegacy, `${JSON.stringify({
    schemaVersion: 3,
    id: lateLinkedId,
    kind: "task",
    jobClass: "task",
    write: false,
    status: "completed",
    phase: "completed",
    summary: "late-linked-visible-from-primary",
    createdAt: now(),
    updatedAt: now(),
    host: { kind: "codex", sessionId: principal(linked).threadId },
    lifecycleEvents: [],
    request: null,
    result: null,
    error: null
  })}\n`, { mode: 0o600 });
  clock.advance(101);
  assert.equal(tryReadJob(root, lateLinkedId, env)?.summary, "late-linked-visible-from-primary");
  assert.equal(tryReadJob(linked, lateLinkedId, env)?.summary, "late-linked-visible-from-primary");
  const lateMarkerCount = fs.readdirSync(controlState)
    .filter((name) => name.startsWith(".legacy-migration-v3-")).length;
  assert.equal(lateMarkerCount, 3);
  assert.equal(workspaceState(root, env), controlState);
  assert.equal(
    fs.readdirSync(controlState).filter((name) => name.startsWith(".legacy-migration-v3-")).length,
    lateMarkerCount
  );

  git(root, "worktree", "remove", "--force", linked);
});

test("jobs admitted from controlRoot and linked worktree share one store", () => {
  const root = initRepo();
  const env = envFor();
  const linked = addLinkedWorktree(root);
  const thread = "019f666a-6469-7cc1-9a8d-8c1adf61e103";

  // Ensure state dirs resolve the same before writes.
  assert.equal(workspaceState(root, env), workspaceState(linked, env));

  const parentJob = {
    schemaVersion: 3,
    id: generateId("task"),
    kind: "task",
    jobClass: "task",
    write: false,
    status: "queued",
    phase: "accepted",
    summary: "from-parent",
    createdAt: now(),
    updatedAt: now(),
    host: { kind: "codex", sessionId: thread },
    lifecycleEvents: [],
    request: null,
    result: null,
    error: null
  };
  admitJob(root, parentJob, env);

  // Parent job must be visible from the linked worktree path.
  const fromLinked = tryReadJob(linked, parentJob.id, env);
  assert.ok(fromLinked, "linked worktree must see job admitted from controlRoot");
  assert.equal(fromLinked.summary, "from-parent");
  assert.ok(listJobs(linked, env).some((job) => job.id === parentJob.id));

  // Admit from linked path; parent must see it.
  const wtJob = {
    ...parentJob,
    id: generateId("task"),
    summary: "from-worktree",
    // parent job is still active read-only without lineage conflict
    request: { providerHomeId: "lineage-b" }
  };
  // First cancel parent activity for write rules - actually both read-only without same lineage OK.
  // parent has request:null so no lineage; wt has different lineage - both can be active if neither write.
  // Wait - admitJob: if neither write and no shared lineage, both can be active. Good.
  // But parentJob still queued - listJobs finds it. wtJob has no write, parent no write - OK.
  admitJob(linked, wtJob, env);

  const fromParent = tryReadJob(root, wtJob.id, env);
  assert.ok(fromParent, "controlRoot must see job admitted from linked worktree");
  assert.equal(fromParent.summary, "from-worktree");

  const parentSeesWtJob = Boolean(tryReadJob(root, wtJob.id, env));
  const wtSeesParentJob = Boolean(tryReadJob(linked, parentJob.id, env));
  assert.equal(parentSeesWtJob, true);
  assert.equal(wtSeesParentJob, true);

  // Readonly resolver also shares after ensure.
  assert.equal(resolveWorkspaceStateDir(root, env), resolveWorkspaceStateDir(linked, env));

  git(root, "worktree", "remove", "--force", linked);
});

test("spawn via linked worktree path is visible from primary controlRoot", () => {
  const root = initRepo();
  const env = envFor();
  const linked = addLinkedWorktree(root);
  const envelope = buildTaskEnvelope({ userRequest: "from linked path", mode: "read" });

  const spawned = spawnReadOnlyWorker({
    root: linked,
    principal: principal(linked),
    envelope,
    idempotencyKey: "shared-store-spawn-0001",
    env
  });

  const fromPrimary = tryReadJob(root, spawned.handle.id, env);
  assert.ok(fromPrimary, "primary controlRoot must see spawn from linked worktree");
  assert.equal(fromPrimary.id, spawned.handle.id);

  // Idempotency shared too.
  const replay = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "shared-store-spawn-0001",
    env
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.handle.id, spawned.handle.id);

  git(root, "worktree", "remove", "--force", linked);
});

test("mainWorktreeRoot returns primary even when resolved from linked path", () => {
  const root = initRepo();
  const linked = addLinkedWorktree(root, "main-probe");
  assert.equal(mainWorktreeRoot(linked), fs.realpathSync(root));
  assert.equal(mainWorktreeRoot(root), fs.realpathSync(root));
  git(root, "worktree", "remove", "--force", linked);
});

test("malicious paths are rejected", () => {
  assert.throws(() => assertSafeRelativePath("../etc/passwd"), (error) => error?.code === "E_SCOPE_VIOLATION");
  assert.throws(() => assertSafeRelativePath("/absolute"), (error) => error?.code === "E_SCOPE_VIOLATION");
  assert.equal(assertSafeRelativePath("src/file.txt"), "src/file.txt");
});

test("parent fingerprint detects tracked, untracked, and symlink mutations", () => {
  const root = initRepo();
  const tracked = path.join(root, "tracked.txt");
  const original = fs.readFileSync(tracked, "utf8");
  const before = captureParentFingerprint(root);
  assert.equal(before.clean, true);
  assert.match(before.fingerprintDigest, /^[a-f0-9]{64}$/);

  fs.writeFileSync(tracked, `${original}changed\n`);
  assert.throws(() => assertParentUnchanged(before, root), (error) => error?.code === "E_INTEGRATION");
  fs.writeFileSync(tracked, original);
  assertParentUnchanged(before, root);

  const originalMode = fs.statSync(tracked).mode & 0o777;
  fs.chmodSync(tracked, originalMode ^ 0o100);
  assert.throws(() => assertParentUnchanged(before, root), (error) => error?.code === "E_INTEGRATION");
  fs.chmodSync(tracked, originalMode);
  assertParentUnchanged(before, root);

  fs.unlinkSync(tracked);
  fs.symlinkSync("missing-target", tracked);
  assert.throws(() => assertParentUnchanged(before, root), (error) => error?.code === "E_INTEGRATION");
  fs.unlinkSync(tracked);
  fs.writeFileSync(tracked, original, { mode: originalMode });
  assertParentUnchanged(before, root);

  const untracked = path.join(root, "new.txt");
  fs.writeFileSync(untracked, "new\n");
  assert.throws(() => assertParentUnchanged(before, root), (error) => error?.code === "E_INTEGRATION");
  fs.unlinkSync(untracked);
  assertParentUnchanged(before, root);

  const link = path.join(root, "link.txt");
  fs.symlinkSync("tracked.txt", link);
  assert.throws(() => assertParentUnchanged(before, root), (error) => error?.code === "E_INTEGRATION");
  fs.unlinkSync(link);
  assertParentUnchanged(before, root);
});

test("parent fingerprint rejects malformed, legacy, and tampered cleanliness claims", () => {
  const root = initRepo();
  const clean = captureParentFingerprint(root);
  const { fingerprintDigest: _fingerprintDigest, ...legacy } = clean;

  assert.throws(
    () => assertParentUnchanged(legacy, root),
    (error) => error?.code === "E_INTEGRATION" && /fingerprint/.test(error.message)
  );
  assert.throws(
    () => assertParentUnchanged({ ...clean, clean: false }, root),
    (error) => error?.code === "E_INTEGRATION" && /fingerprint/.test(error.message)
  );

  fs.writeFileSync(path.join(root, "tracked.txt"), "dirty parent\n");
  const dirty = captureParentFingerprint(root);
  assert.equal(dirty.clean, false);
  assert.throws(
    () => assertParentUnchanged({ ...dirty, clean: true }, root),
    (error) => error?.code === "E_INTEGRATION" && /fingerprint/.test(error.message)
  );
});

test("worktree create leaves parent content fingerprint unchanged; scope/tamper blocked", () => {
  const root = initRepo();
  const env = envFor();
  const before = captureParentFingerprint(root);
  const base = git(root, "rev-parse", "HEAD");
  const control = resolveControlWorkspace(root, env);

  const worktree = createWorkerWorktree({
    controlRoot: root,
    baseCommit: "HEAD",
    workerId: "task-aaaaaaaaaaaaaaaa",
    env
  });
  assert.ok(fs.existsSync(worktree.executionRoot));
  assert.equal(worktree.controlWorkspaceId, control.controlWorkspaceId);
  assert.equal(worktree.baseCommit, base);
  assert.equal(worktree.branch, null);
  assert.equal(worktree.detached, true);
  // Identity from the worker execution path still points at primary controlRoot.
  const fromExec = resolveControlWorkspace(worktree.executionRoot, env);
  assert.equal(fromExec.controlRoot, control.controlRoot);
  assert.equal(fromExec.controlWorkspaceId, control.controlWorkspaceId);
  assertParentUnchanged(before, root);

  // Mutate only inside execution root.
  fs.writeFileSync(path.join(worktree.executionRoot, "tracked.txt"), "worker change\n");
  // Still parent unchanged.
  assertParentUnchanged(before, root);

  const manifest = buildArtifactManifest({
    workerId: "task-aaaaaaaaaaaaaaaa",
    controlWorkspaceId: control.controlWorkspaceId,
    controlRoot: root,
    executionRoot: worktree.executionRoot,
    baseCommit: base,
    scope: scopeFor("tracked.txt")
  });
  assert.ok(manifest.manifestDigest);
  assert.ok(manifest.changedPaths.some((entry) => entry.path === "tracked.txt"));
  validateArtifactForIntegration(manifest, {
    expectedBaseCommit: base,
    expectedControlWorkspaceId: control.controlWorkspaceId,
    expectedWorkerId: "task-aaaaaaaaaaaaaaaa",
    expectedScope: scopeFor("tracked.txt"),
    expectedLineage: null,
    expectedControlRoot: root,
    expectedExecutionRoot: worktree.executionRoot,
    recomputeFromExecutionRoot: {
      controlRoot: root,
      executionRoot: worktree.executionRoot
    }
  });

  // Out of scope write blocked at manifest build.
  fs.writeFileSync(path.join(worktree.executionRoot, "secret.env"), "x\n");
  assert.throws(
    () => buildArtifactManifest({
      workerId: "task-aaaaaaaaaaaaaaaa",
      controlWorkspaceId: control.controlWorkspaceId,
      controlRoot: root,
      executionRoot: worktree.executionRoot,
      baseCommit: base,
      scope: scopeFor("tracked.txt")
    }),
    (error) => error?.code === "E_SCOPE_VIOLATION"
  );
  fs.unlinkSync(path.join(worktree.executionRoot, "secret.env"));

  // Wrong base rejected.
  assert.throws(
    () => validateArtifactForIntegration(manifest, { expectedBaseCommit: "0".repeat(40) }),
    (error) => error?.code === "E_INTEGRATION"
  );

  // Tampered patch digest (use pre-scope-violation manifest only).
  assert.throws(
    () => validateArtifactForIntegration(
      { ...manifest, patchDigest: "0".repeat(64) },
      {
        expectedBaseCommit: base,
        recomputeFromExecutionRoot: {
          controlRoot: root,
          executionRoot: worktree.executionRoot
        }
      }
    ),
    (error) => error?.code === "E_INTEGRATION" || error?.code === "E_SCOPE_VIOLATION"
  );

  // Integration prep uses the in-scope manifest captured before secret.env.
  const prep = prepareIntegration({
    controlRoot: root,
    executionRoot: worktree.executionRoot,
    manifest,
    parentFingerprint: before,
    expectedWorkerId: "task-aaaaaaaaaaaaaaaa",
    expectedScope: scopeFor("tracked.txt"),
    expectedLineage: null,
    env
  });
  assert.equal(prep.ready, true);
  assert.equal(prep.autoApplied, false);
  assert.equal(prep.hostVerification, "not_run");
  assert.equal(prep.requiresExplicitHostApply, true);

  assert.equal(removeWorkerWorktree(worktree.executionRoot, root, "task-aaaaaaaaaaaaaaaa", env), true);
});

test("integration fails closed when the captured parent already has tracked, untracked, or ignored content", () => {
  const cases = [
    {
      name: "tracked",
      path: "tracked.txt",
      prepare(root) {
        fs.writeFileSync(path.join(root, "tracked.txt"), "parent version\n");
      }
    },
    {
      name: "untracked",
      path: "parent-new.txt",
      prepare(root) {
        fs.writeFileSync(path.join(root, "parent-new.txt"), "parent version\n");
      }
    },
    {
      name: "ignored",
      path: "ignored.bin",
      prepare(root) {
        fs.writeFileSync(path.join(root, ".gitignore"), "ignored.bin\n");
        git(root, "add", ".gitignore");
        git(root, "commit", "-m", "add ignored fixture");
        fs.writeFileSync(path.join(root, "ignored.bin"), "parent version\n");
      }
    }
  ];

  for (const fixture of cases) {
    const root = initRepo();
    const env = envFor();
    fixture.prepare(root);
    const parentFingerprint = captureParentFingerprint(root);
    assert.equal(parentFingerprint.clean, false, fixture.name);
    const base = git(root, "rev-parse", "HEAD");
    const control = resolveControlWorkspace(root, env);
    const workerId = `task-dirty-${fixture.name}-0001`;
    const worktree = createWorkerWorktree({ controlRoot: root, baseCommit: base, workerId, env });
    fs.writeFileSync(path.join(worktree.executionRoot, fixture.path), "worker version\n");
    const manifest = buildArtifactManifest({
      workerId,
      controlWorkspaceId: control.controlWorkspaceId,
      controlRoot: root,
      executionRoot: worktree.executionRoot,
      baseCommit: base,
      scope: scopeFor(fixture.path),
      lineage: null
    });

    assert.throws(
      () => prepareIntegration({
        controlRoot: root,
        executionRoot: worktree.executionRoot,
        manifest,
        parentFingerprint,
        expectedWorkerId: workerId,
        expectedScope: scopeFor(fixture.path),
        expectedLineage: null,
        env
      }),
      (error) => error?.code === "E_INTEGRATION"
        && /clean checkout/.test(error.message)
        && !error.message.includes(root)
        && !JSON.stringify(error.details ?? {}).includes(root),
      fixture.name
    );

    assert.equal(removeWorkerWorktree(worktree.executionRoot, root, workerId, env), true);
  }
});

test("artifact capture rejects assume-unchanged entries that hide out-of-scope content", () => {
  const root = initRepo();
  const env = envFor();
  fs.writeFileSync(path.join(root, "hidden.txt"), "base\n");
  git(root, "add", "hidden.txt");
  git(root, "commit", "-m", "add hidden-index fixture");
  const base = git(root, "rev-parse", "HEAD");
  const control = resolveControlWorkspace(root, env);
  const workerId = "task-assume00000001";
  const worktree = createWorkerWorktree({ controlRoot: root, baseCommit: base, workerId, env });

  fs.writeFileSync(path.join(worktree.executionRoot, "tracked.txt"), "allowed\n");
  git(worktree.executionRoot, "update-index", "--assume-unchanged", "hidden.txt");
  fs.writeFileSync(path.join(worktree.executionRoot, "hidden.txt"), "out of scope\n");

  const rejectsAssumeUnchanged = (error) => error?.code === "E_SCOPE_VIOLATION"
    && error.message === "Unsupported or unsafe Git index state."
    && !error.message.includes("hidden.txt")
    && !error.message.includes(root);
  assert.throws(
    () => buildArtifactManifest({
      workerId,
      controlWorkspaceId: control.controlWorkspaceId,
      controlRoot: root,
      executionRoot: worktree.executionRoot,
      baseCommit: base,
      scope: scopeFor("tracked.txt")
    }),
    rejectsAssumeUnchanged
  );
  assert.throws(() => captureParentFingerprint(worktree.executionRoot), rejectsAssumeUnchanged);

  git(worktree.executionRoot, "update-index", "--no-assume-unchanged", "hidden.txt");
  assert.equal(removeWorkerWorktree(worktree.executionRoot, root, workerId, env), true);
});

test("artifact capture rejects skip-worktree entries that hide out-of-scope content", () => {
  const root = initRepo();
  const env = envFor();
  fs.writeFileSync(path.join(root, "hidden.txt"), "base\n");
  git(root, "add", "hidden.txt");
  git(root, "commit", "-m", "add hidden-index fixture");
  const base = git(root, "rev-parse", "HEAD");
  const control = resolveControlWorkspace(root, env);
  const workerId = "task-skip0000000001";
  const worktree = createWorkerWorktree({ controlRoot: root, baseCommit: base, workerId, env });

  fs.writeFileSync(path.join(worktree.executionRoot, "tracked.txt"), "allowed\n");
  git(worktree.executionRoot, "update-index", "--skip-worktree", "hidden.txt");
  fs.writeFileSync(path.join(worktree.executionRoot, "hidden.txt"), "out of scope\n");

  const rejectsSkipWorktree = (error) => error?.code === "E_SCOPE_VIOLATION"
    && error.message === "Unsupported or unsafe Git index state."
    && !error.message.includes("hidden.txt")
    && !error.message.includes(root);
  assert.throws(
    () => buildArtifactManifest({
      workerId,
      controlWorkspaceId: control.controlWorkspaceId,
      controlRoot: root,
      executionRoot: worktree.executionRoot,
      baseCommit: base,
      scope: scopeFor("tracked.txt")
    }),
    rejectsSkipWorktree
  );
  assert.throws(() => captureParentFingerprint(worktree.executionRoot), rejectsSkipWorktree);

  git(worktree.executionRoot, "update-index", "--no-skip-worktree", "hidden.txt");
  assert.equal(removeWorkerWorktree(worktree.executionRoot, root, workerId, env), true);
});

test("artifact capture rejects intent-to-add index entries", () => {
  const root = initRepo();
  const env = envFor();
  const base = git(root, "rev-parse", "HEAD");
  const control = resolveControlWorkspace(root, env);
  const workerId = "task-intent000000001";
  const worktree = createWorkerWorktree({ controlRoot: root, baseCommit: base, workerId, env });
  const planned = path.join(worktree.executionRoot, "planned.txt");
  fs.writeFileSync(planned, "planned content\n");
  git(worktree.executionRoot, "add", "--intent-to-add", "planned.txt");

  const rejectsUnsafeIndex = (error) => error?.code === "E_SCOPE_VIOLATION"
    && error.message === "Unsupported or unsafe Git index state."
    && !error.message.includes("planned.txt")
    && !error.message.includes(root);
  assert.throws(
    () => buildArtifactManifest({
      workerId,
      controlWorkspaceId: control.controlWorkspaceId,
      controlRoot: root,
      executionRoot: worktree.executionRoot,
      baseCommit: base,
      scope: scopeFor("planned.txt")
    }),
    rejectsUnsafeIndex
  );
  assert.throws(() => captureParentFingerprint(worktree.executionRoot), rejectsUnsafeIndex);

  git(worktree.executionRoot, "reset", "--", "planned.txt");
  fs.unlinkSync(planned);
  assert.equal(removeWorkerWorktree(worktree.executionRoot, root, workerId, env), true);
});

test("unmerged managed-worker index cannot build an artifact or pass integration readiness", () => {
  const root = initRepo();
  const env = envFor();
  const parentFingerprint = captureParentFingerprint(root);
  const base = git(root, "rev-parse", "HEAD");
  const control = resolveControlWorkspace(root, env);
  const workerId = "task-unmerged0000001";
  const worktree = createWorkerWorktree({ controlRoot: root, baseCommit: base, workerId, env });
  const manifest = buildArtifactManifest({
    workerId,
    controlWorkspaceId: control.controlWorkspaceId,
    controlRoot: root,
    executionRoot: worktree.executionRoot,
    baseCommit: base,
    scope: null,
    lineage: null
  });

  fs.writeFileSync(path.join(worktree.executionRoot, "tracked.txt"), "ours\n");
  git(worktree.executionRoot, "add", "tracked.txt");
  git(worktree.executionRoot, "commit", "-m", "worker ours");
  const ours = git(worktree.executionRoot, "rev-parse", "HEAD");
  git(worktree.executionRoot, "reset", "--hard", base);
  fs.writeFileSync(path.join(worktree.executionRoot, "tracked.txt"), "theirs\n");
  git(worktree.executionRoot, "add", "tracked.txt");
  git(worktree.executionRoot, "commit", "-m", "worker theirs");
  const theirs = git(worktree.executionRoot, "rev-parse", "HEAD");
  git(worktree.executionRoot, "reset", "--hard", ours);
  assert.throws(() => git(worktree.executionRoot, "merge", "--no-edit", theirs));
  assert.notEqual(git(worktree.executionRoot, "ls-files", "--unmerged"), "");

  const rejectsUnsafeIndex = (error) => error?.code === "E_SCOPE_VIOLATION"
    && error.message === "Unsupported or unsafe Git index state."
    && !error.message.includes("tracked.txt")
    && !error.message.includes(root);
  assert.throws(
    () => buildArtifactManifest({
      workerId,
      controlWorkspaceId: control.controlWorkspaceId,
      controlRoot: root,
      executionRoot: worktree.executionRoot,
      baseCommit: base,
      scope: null,
      lineage: null
    }),
    rejectsUnsafeIndex
  );
  assert.throws(
    () => prepareIntegration({
      controlRoot: root,
      executionRoot: worktree.executionRoot,
      manifest,
      parentFingerprint,
      expectedWorkerId: workerId,
      expectedScope: null,
      expectedLineage: null,
      env
    }),
    rejectsUnsafeIndex
  );

  git(worktree.executionRoot, "merge", "--abort");
  assert.equal(removeWorkerWorktree(worktree.executionRoot, root, workerId, env), true);
});

test("uninitialized gitlinks are index-bound but initialized content cannot build or validate", () => {
  const submodule = initRepo();
  const root = initRepo();
  const env = envFor();
  git(root, "-c", "protocol.file.allow=always", "submodule", "add", submodule, "modules/sub");
  git(root, "commit", "-m", "add submodule fixture");
  const base = git(root, "rev-parse", "HEAD");
  const control = resolveControlWorkspace(root, env);
  const workerId = "task-gitlink0000001";
  const worktree = createWorkerWorktree({ controlRoot: root, baseCommit: base, workerId, env });
  const manifest = buildArtifactManifest({
    workerId,
    controlWorkspaceId: control.controlWorkspaceId,
    controlRoot: root,
    executionRoot: worktree.executionRoot,
    baseCommit: base,
    scope: null
  });
  assert.equal(validateArtifactForIntegration(manifest, {
    expectedBaseCommit: base,
    expectedControlWorkspaceId: control.controlWorkspaceId,
    expectedWorkerId: workerId,
    expectedScope: null,
    expectedLineage: null,
    recomputeFromExecutionRoot: { controlRoot: root, executionRoot: worktree.executionRoot }
  }), true);

  git(
    worktree.executionRoot,
    "-c", "protocol.file.allow=always",
    "submodule", "update", "--init", "--", "modules/sub"
  );
  fs.writeFileSync(path.join(worktree.executionRoot, "modules", "sub", "tracked.txt"), "content drift\n");
  assert.throws(
    () => validateArtifactForIntegration(manifest, {
      expectedBaseCommit: base,
      expectedControlWorkspaceId: control.controlWorkspaceId,
      expectedWorkerId: workerId,
      expectedScope: null,
      expectedLineage: null,
      recomputeFromExecutionRoot: { controlRoot: root, executionRoot: worktree.executionRoot }
    }),
    (error) => error?.code === "E_SCOPE_VIOLATION" && /gitlink/.test(error.message)
  );
  assert.throws(
    () => buildArtifactManifest({
      workerId,
      controlWorkspaceId: control.controlWorkspaceId,
      controlRoot: root,
      executionRoot: worktree.executionRoot,
      baseCommit: base,
      scope: null
    }),
    (error) => error?.code === "E_SCOPE_VIOLATION" && /gitlink/.test(error.message)
  );

  git(worktree.executionRoot, "submodule", "deinit", "-f", "--", "modules/sub");
  assert.equal(removeWorkerWorktree(worktree.executionRoot, root, workerId, env), true);
});

test("embedded repositories remain opaque and cannot hide an escaping symlink from build or validation", () => {
  const root = initRepo();
  const env = envFor();
  const base = git(root, "rev-parse", "HEAD");
  const control = resolveControlWorkspace(root, env);
  const workerId = "task-embedded000001";
  const worktree = createWorkerWorktree({ controlRoot: root, baseCommit: base, workerId, env });
  const manifest = buildArtifactManifest({
    workerId,
    controlWorkspaceId: control.controlWorkspaceId,
    controlRoot: root,
    executionRoot: worktree.executionRoot,
    baseCommit: base,
    scope: null
  });
  const victim = tempDir("grok-embedded-victim-");
  const external = path.join(victim, "important.txt");
  fs.writeFileSync(external, "keep\n");
  const embedded = path.join(worktree.executionRoot, "embedded");
  fs.mkdirSync(embedded);
  git(embedded, "init", "-b", "main");
  fs.writeFileSync(path.join(embedded, "payload.txt"), "opaque\n");
  fs.symlinkSync(external, path.join(embedded, "escape"));

  const rejectsOpaqueDirectory = (error) => error?.code === "E_SCOPE_VIOLATION"
    && /Opaque non-gitlink directory/.test(error.message);
  assert.throws(
    () => buildArtifactManifest({
      workerId,
      controlWorkspaceId: control.controlWorkspaceId,
      controlRoot: root,
      executionRoot: worktree.executionRoot,
      baseCommit: base,
      scope: null
    }),
    rejectsOpaqueDirectory
  );
  assert.throws(
    () => validateArtifactForIntegration(manifest, {
      expectedBaseCommit: base,
      expectedControlWorkspaceId: control.controlWorkspaceId,
      expectedWorkerId: workerId,
      expectedScope: null,
      expectedLineage: null,
      recomputeFromExecutionRoot: { controlRoot: root, executionRoot: worktree.executionRoot }
    }),
    rejectsOpaqueDirectory
  );
  assert.equal(fs.readFileSync(external, "utf8"), "keep\n");

  fs.rmSync(embedded, { recursive: true, force: true });
  assert.equal(removeWorkerWorktree(worktree.executionRoot, root, workerId, env), true);
});

test("integration rejects the parent checkout and unmanaged linked worktrees", () => {
  const root = initRepo();
  const env = envFor();
  const parentFingerprint = captureParentFingerprint(root);
  const base = git(root, "rev-parse", "HEAD");
  const control = resolveControlWorkspace(root, env);
  const workerId = "task-3333333333333333";
  const managed = createWorkerWorktree({ controlRoot: root, baseCommit: base, workerId, env });
  const unmanaged = addLinkedWorktree(root, "unmanaged-integration");

  for (const executionRoot of [root, unmanaged]) {
    const manifest = buildArtifactManifest({
      workerId,
      controlWorkspaceId: control.controlWorkspaceId,
      controlRoot: root,
      executionRoot,
      baseCommit: base,
      scope: null,
      lineage: null
    });
    assert.throws(
      () => prepareIntegration({
        controlRoot: root,
        executionRoot,
        manifest,
        parentFingerprint,
        expectedWorkerId: workerId,
        expectedScope: null,
        expectedLineage: null,
        env
      }),
      (error) => error?.code === "E_INTEGRATION"
        && /managed worktree registered for this worker/.test(error.message)
    );
  }

  assertParentUnchanged(parentFingerprint, root);
  git(root, "worktree", "remove", "--force", unmanaged);
  assert.equal(removeWorkerWorktree(managed.executionRoot, root, workerId, env), true);
});

test("worker worktree preflight rejects tracked symlinks that escape the execution root", () => {
  const root = initRepo();
  const env = envFor();
  const victim = tempDir("grok-worktree-external-");
  const external = path.join(victim, "outside.txt");
  fs.writeFileSync(external, "unchanged\n");
  fs.symlinkSync(external, path.join(root, "external-link"));
  git(root, "add", "external-link");
  git(root, "commit", "-m", "add unsafe tracked symlink");
  const before = git(root, "worktree", "list", "--porcelain");

  assert.throws(
    () => createWorkerWorktree({
      controlRoot: root,
      baseCommit: "HEAD",
      workerId: "task-4444444444444444",
      env
    }),
    (error) => error?.code === "E_SCOPE_VIOLATION"
  );
  assert.equal(git(root, "worktree", "list", "--porcelain"), before);
  assert.equal(fs.readFileSync(external, "utf8"), "unchanged\n");
});

test("artifact validation binds untracked content and rejects escaping symlinks and arbitrary cleanup", () => {
  const root = initRepo();
  const env = envFor();
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored.bin\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-m", "add artifact fixtures");
  const before = captureParentFingerprint(root);
  const base = git(root, "rev-parse", "HEAD");
  const control = resolveControlWorkspace(root, env);
  const workerId = "task-bbbbbbbbbbbbbbbb";
  const worktree = createWorkerWorktree({ controlRoot: root, baseCommit: base, workerId, env });
  const untracked = path.join(worktree.executionRoot, "new.txt");
  const ignored = path.join(worktree.executionRoot, "ignored.bin");
  fs.writeFileSync(untracked, "one\n");
  fs.writeFileSync(ignored, "ignored-one\n");
  const scope = buildTaskEnvelope({
    userRequest: "Create bounded artifacts",
    mode: "write",
    scope: scopeFor("new.txt", "ignored.bin")
  }).scope;
  const manifest = buildArtifactManifest({
    workerId,
    controlWorkspaceId: control.controlWorkspaceId,
    controlRoot: root,
    executionRoot: worktree.executionRoot,
    baseCommit: base,
    scope
  });
  const entry = manifest.changedPaths.find((item) => item.path === "new.txt");
  assert.equal(entry.identity.kind, "file");
  assert.match(entry.identity.contentDigest, /^[a-f0-9]{64}$/);
  const ignoredEntry = manifest.changedPaths.find((item) => item.path === "ignored.bin");
  assert.equal(ignoredEntry.status, "!");
  assert.equal(ignoredEntry.identity.kind, "file");
  assert.match(ignoredEntry.identity.contentDigest, /^[a-f0-9]{64}$/);

  fs.writeFileSync(path.join(worktree.executionRoot, "secret.env"), "outside envelope scope\n");
  assert.throws(
    () => buildArtifactManifest({
      workerId,
      controlWorkspaceId: control.controlWorkspaceId,
      controlRoot: root,
      executionRoot: worktree.executionRoot,
      baseCommit: base,
      scope
    }),
    (error) => error?.code === "E_SCOPE_VIOLATION"
  );
  fs.unlinkSync(path.join(worktree.executionRoot, "secret.env"));

  fs.writeFileSync(untracked, "TAMPERED\n");
  assert.throws(
    () => validateArtifactForIntegration(manifest, {
      expectedBaseCommit: base,
      expectedControlWorkspaceId: control.controlWorkspaceId,
      expectedWorkerId: workerId,
      expectedScope: scope,
      expectedLineage: null,
      recomputeFromExecutionRoot: { controlRoot: root, executionRoot: worktree.executionRoot }
    }),
    (error) => error?.code === "E_INTEGRATION"
  );
  fs.writeFileSync(untracked, "one\n");

  fs.chmodSync(untracked, 0o755);
  assert.throws(
    () => validateArtifactForIntegration(manifest, {
      expectedBaseCommit: base,
      expectedControlWorkspaceId: control.controlWorkspaceId,
      expectedWorkerId: workerId,
      expectedScope: scope,
      expectedLineage: null,
      recomputeFromExecutionRoot: { controlRoot: root, executionRoot: worktree.executionRoot }
    }),
    (error) => error?.code === "E_INTEGRATION"
  );
  fs.chmodSync(untracked, 0o644);

  fs.writeFileSync(ignored, "IGNORED-TAMPER\n");
  assert.throws(
    () => validateArtifactForIntegration(manifest, {
      expectedBaseCommit: base,
      expectedControlWorkspaceId: control.controlWorkspaceId,
      expectedWorkerId: workerId,
      expectedScope: scope,
      expectedLineage: null,
      recomputeFromExecutionRoot: { controlRoot: root, executionRoot: worktree.executionRoot }
    }),
    (error) => error?.code === "E_INTEGRATION"
  );
  fs.writeFileSync(ignored, "ignored-one\n");

  assert.throws(
    () => validateArtifactForIntegration({ ...manifest, patchDigest: "0".repeat(64) }),
    (error) => error?.code === "E_INTEGRATION"
  );
  assert.throws(
    () => prepareIntegration({
      controlRoot: root,
      executionRoot: worktree.executionRoot,
      manifest,
      parentFingerprint: before,
      expectedWorkerId: workerId,
      expectedScope: scopeFor("different.txt"),
      expectedLineage: null,
      env
    }),
    (error) => error?.code === "E_INTEGRATION"
  );

  fs.unlinkSync(untracked);
  fs.symlinkSync("/etc", path.join(worktree.executionRoot, "chain"));
  fs.symlinkSync("chain/passwd", path.join(worktree.executionRoot, "new.txt"));
  assert.throws(
    () => buildArtifactManifest({
      workerId,
      controlWorkspaceId: control.controlWorkspaceId,
      controlRoot: root,
      executionRoot: worktree.executionRoot,
      baseCommit: base,
      scope
    }),
    (error) => error?.code === "E_SCOPE_VIOLATION"
  );
  fs.unlinkSync(path.join(worktree.executionRoot, "new.txt"));
  fs.unlinkSync(path.join(worktree.executionRoot, "chain"));

  const victim = tempDir("grok-worktree-victim-");
  fs.writeFileSync(path.join(victim, "important.txt"), "keep\n");
  assert.throws(
    () => removeWorkerWorktree(victim, root, workerId, env),
    (error) => error?.code === "E_WORKTREE"
  );
  assert.ok(fs.existsSync(path.join(victim, "important.txt")));
  const unregistered = path.join(path.dirname(worktree.executionRoot), "not-a-worktree");
  fs.mkdirSync(unregistered);
  fs.writeFileSync(path.join(unregistered, "important.txt"), "keep\n");
  assert.throws(
    () => removeWorkerWorktree(unregistered, root, workerId, env),
    (error) => error?.code === "E_WORKTREE"
  );
  assert.ok(fs.existsSync(path.join(unregistered, "important.txt")));
  assertParentUnchanged(before, root);
  assert.equal(removeWorkerWorktree(worktree.executionRoot, root, workerId, env), true);
});
