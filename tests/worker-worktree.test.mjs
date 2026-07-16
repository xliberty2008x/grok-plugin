import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  resolveControlWorkspace,
  controlStateDir,
  controlStateSegment
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
import { initRepo, tempDir, git } from "./helpers.mjs";

function envFor() {
  const pluginData = tempDir("grok-worktree-data-");
  return {
    HOME: path.dirname(pluginData),
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_PLUGIN_DATA: pluginData
  };
}

test("control workspace identity is stable across linked worktree paths", () => {
  const root = initRepo();
  const env = envFor();
  const control = resolveControlWorkspace(root, env);
  assert.match(control.controlWorkspaceId, /^cws-[a-f0-9]{32}$/);
  assert.equal(control.controlRoot, fs.realpathSync(root));
  const state = controlStateDir(control, env);
  assert.ok(state.includes(controlStateSegment(control.controlWorkspaceId)));
  assert.ok(fs.existsSync(state));
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
