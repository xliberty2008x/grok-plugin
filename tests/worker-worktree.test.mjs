import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  resolveControlWorkspace,
  controlStateDir,
  controlStateSegment,
  resolveAdmissionLockName,
  controlAdmissionLockName,
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
import { admitJob, listJobs, tryReadJob, generateId, now } from "../plugins/grok/scripts/lib/state.mjs";
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

function principal(root) {
  return {
    hostKind: "codex",
    threadId: "019f666a-6469-7cc1-9a8d-8c1adf61e103",
    source: "codex-mcp-stdio",
    pluginId: "grok@grok-companion",
    root
  };
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

test("worktree create leaves parent content fingerprint unchanged; scope/tamper blocked", () => {
  const root = initRepo();
  const env = envFor();
  const before = captureParentFingerprint(root);
  const base = git(root, "rev-parse", "HEAD");
  const control = resolveControlWorkspace(root, env);

  const worktree = createWorkerWorktree({
    controlRoot: root,
    baseCommit: base,
    workerId: "task-aaaaaaaaaaaaaaaa",
    env
  });
  assert.ok(fs.existsSync(worktree.executionRoot));
  assert.equal(worktree.controlWorkspaceId, control.controlWorkspaceId);
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
    scope: { paths: ["tracked.txt"] }
  });
  assert.ok(manifest.manifestDigest);
  assert.ok(manifest.changedPaths.some((entry) => entry.path === "tracked.txt"));
  validateArtifactForIntegration(manifest, {
    expectedBaseCommit: base,
    expectedControlWorkspaceId: control.controlWorkspaceId
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
      scope: { paths: ["tracked.txt"] }
    }),
    (error) => error?.code === "E_SCOPE_VIOLATION"
  );

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
    manifest,
    parentFingerprint: before
  });
  assert.equal(prep.autoApplied, false);
  assert.equal(prep.hostVerification, "not_run");
  assert.equal(prep.requiresExplicitHostApply, true);

  removeWorkerWorktree(worktree.executionRoot, root);
});
