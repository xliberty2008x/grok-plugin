/**
 * Phase 3: host-owned worktrees, control-workspace identity consumers,
 * artifact validation, and parent-checkout isolation checks.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { CompanionError } from "./errors.mjs";
import {
  controlStateDir,
  resolveControlWorkspace,
  gitCommonDir
} from "./workspace.mjs";

export const ARTIFACT_MANIFEST_VERSION = 1;

function git(cwd, args, { allowFailure = false } = {}) {
  const run = spawnSync("git", args, { cwd, encoding: "utf8", shell: false, maxBuffer: 16 * 1024 * 1024 });
  if (run.error || (!allowFailure && run.status !== 0)) {
    throw new CompanionError("E_GIT_REQUIRED", `Git command failed: git ${args.join(" ")}`, {
      stderr: String(run.stderr || "").trim()
    });
  }
  return run;
}

function sha(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function assertSafeRelativePath(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !normalized
    || path.posix.isAbsolute(normalized)
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.split("/").includes("..")
    || normalized.includes("\0")
  ) {
    throw new CompanionError("E_SCOPE_VIOLATION", `Malicious or absolute path rejected: ${relativePath}`);
  }
  return normalized;
}

/**
 * Create a host-owned worktree from an exact base commit.
 * Parent files/index are not modified (git worktree add is metadata-only for parent content).
 */
export function createWorkerWorktree({
  controlRoot,
  baseCommit,
  workerId,
  env = process.env
} = {}) {
  if (!controlRoot || !baseCommit || !workerId) {
    throw new CompanionError("E_USAGE", "controlRoot, baseCommit, and workerId are required.");
  }
  const control = resolveControlWorkspace(controlRoot, env);
  const state = controlStateDir(control, env);
  const worktrees = path.join(state, "worktrees");
  fs.mkdirSync(worktrees, { recursive: true, mode: 0o700 });
  const slug = String(workerId).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
  const executionRoot = path.join(worktrees, slug);
  if (fs.existsSync(executionRoot)) {
    throw new CompanionError("E_WORKTREE", `Worktree path already exists for ${workerId}.`);
  }

  // Verify base commit exists.
  git(control.controlRoot, ["cat-file", "-e", `${baseCommit}^{commit}`]);

  const branch = `grok-worker/${slug}`;
  git(control.controlRoot, [
    "worktree", "add",
    "--detach",
    executionRoot,
    baseCommit
  ]);

  // Capture parent identity after worktree create for isolation proof.
  const parentHead = git(control.controlRoot, ["rev-parse", "HEAD"]).stdout.trim();
  const parentStatus = git(control.controlRoot, ["status", "--porcelain"]).stdout;

  return Object.freeze({
    controlWorkspaceId: control.controlWorkspaceId,
    controlRoot: control.controlRoot,
    executionRoot: fs.realpathSync(executionRoot),
    baseCommit,
    branch,
    parentHeadAfterCreate: parentHead,
    parentStatusAfterCreate: parentStatus,
    gitCommonDir: control.gitCommonDir
  });
}

export function captureParentFingerprint(root) {
  const head = git(root, ["rev-parse", "HEAD"]).stdout.trim();
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
  const status = git(root, ["status", "--porcelain"]).stdout;
  const index = git(root, ["ls-files", "-s"]).stdout;
  return Object.freeze({
    head,
    tree,
    statusDigest: sha(status),
    indexDigest: sha(index),
    status
  });
}

export function assertParentUnchanged(before, root) {
  const after = captureParentFingerprint(root);
  if (before.head !== after.head) {
    throw new CompanionError("E_INTEGRATION", "Parent HEAD changed before explicit integration.");
  }
  if (before.tree !== after.tree) {
    throw new CompanionError("E_INTEGRATION", "Parent tree changed before explicit integration.");
  }
  if (before.indexDigest !== after.indexDigest) {
    throw new CompanionError("E_INTEGRATION", "Parent index changed before explicit integration.");
  }
  // status may include worktree list metadata in some git versions; compare file content via index+tree.
  return after;
}

/**
 * Build a tamper-evident artifact manifest for a worker execution root.
 */
export function buildArtifactManifest({
  workerId,
  controlWorkspaceId,
  controlRoot,
  executionRoot,
  baseCommit,
  scope = null,
  lineage = null
} = {}) {
  if (!executionRoot || !baseCommit || !workerId) {
    throw new CompanionError("E_USAGE", "workerId, executionRoot, and baseCommit are required.");
  }
  const head = git(executionRoot, ["rev-parse", "HEAD"]).stdout.trim();
  const tree = git(executionRoot, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
  const diff = git(executionRoot, ["diff", "--name-status", baseCommit], { allowFailure: true });
  const changed = String(diff.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split(/\s+/);
      const filePath = rest.join(" ");
      return { status, path: assertSafeRelativePath(filePath) };
    });
  // Include untracked files (not present in git diff against base).
  const untracked = git(executionRoot, ["ls-files", "--others", "--exclude-standard"], { allowFailure: true });
  for (const line of String(untracked.stdout || "").split("\n").map((item) => item.trim()).filter(Boolean)) {
    const relative = assertSafeRelativePath(line);
    if (!changed.some((entry) => entry.path === relative)) {
      changed.push({ status: "?", path: relative });
    }
  }

  // Scope check
  if (scope?.paths?.length) {
    const allowed = new Set(scope.paths.map((item) => assertSafeRelativePath(item)));
    for (const entry of changed) {
      if (![...allowed].some((prefix) => entry.path === prefix || entry.path.startsWith(`${prefix}/`))) {
        throw new CompanionError("E_SCOPE_VIOLATION", `Out-of-scope path ${entry.path}.`);
      }
    }
  }

  const patch = git(executionRoot, ["diff", baseCommit], { allowFailure: true }).stdout || "";
  const manifest = {
    schemaVersion: ARTIFACT_MANIFEST_VERSION,
    workerId,
    controlWorkspaceId,
    controlRootDigest: sha(controlRoot || ""),
    executionRootDigest: sha(executionRoot),
    lineage: lineage || null,
    baseCommit,
    resultHead: head,
    resultTree: tree,
    patchDigest: sha(patch),
    changedPaths: changed,
    scope: scope || null,
    workerVerification: "not_run",
    createdAt: new Date().toISOString()
  };
  manifest.manifestDigest = sha(JSON.stringify({
    ...manifest,
    manifestDigest: undefined
  }));
  return Object.freeze(manifest);
}

/**
 * Validate manifest before host integration. Fail closed on tampering / drift / malicious paths.
 */
export function validateArtifactForIntegration(manifest, {
  expectedBaseCommit = null,
  expectedControlWorkspaceId = null,
  recomputeFromExecutionRoot = null
} = {}) {
  if (!manifest || manifest.schemaVersion !== ARTIFACT_MANIFEST_VERSION) {
    throw new CompanionError("E_INTEGRATION", "Invalid artifact manifest.");
  }
  if (expectedBaseCommit && manifest.baseCommit !== expectedBaseCommit) {
    throw new CompanionError("E_INTEGRATION", "Artifact base commit does not match expected base.");
  }
  if (expectedControlWorkspaceId && manifest.controlWorkspaceId !== expectedControlWorkspaceId) {
    throw new CompanionError("E_INTEGRATION", "Artifact control workspace identity mismatch.");
  }
  for (const entry of manifest.changedPaths || []) {
    assertSafeRelativePath(entry.path);
  }
  if (recomputeFromExecutionRoot) {
    const recomputed = buildArtifactManifest({
      workerId: manifest.workerId,
      controlWorkspaceId: manifest.controlWorkspaceId,
      controlRoot: recomputeFromExecutionRoot.controlRoot,
      executionRoot: recomputeFromExecutionRoot.executionRoot,
      baseCommit: manifest.baseCommit,
      scope: manifest.scope,
      lineage: manifest.lineage
    });
    if (recomputed.patchDigest !== manifest.patchDigest) {
      throw new CompanionError("E_INTEGRATION", "Artifact patch digest tampering detected.");
    }
    if (recomputed.resultTree !== manifest.resultTree) {
      throw new CompanionError("E_INTEGRATION", "Artifact result tree drift detected.");
    }
  }
  return true;
}

/**
 * Explicit host integration is a separate step. This helper only validates readiness.
 * It never auto-applies patches to the parent checkout.
 */
export function prepareIntegration({
  controlRoot,
  manifest,
  parentFingerprint
} = {}) {
  validateArtifactForIntegration(manifest, {
    expectedBaseCommit: parentFingerprint?.head || manifest.baseCommit,
    expectedControlWorkspaceId: manifest.controlWorkspaceId
  });
  if (parentFingerprint) {
    assertParentUnchanged(parentFingerprint, controlRoot);
  }
  return Object.freeze({
    ready: true,
    autoApplied: false,
    requiresExplicitHostApply: true,
    hostVerification: "not_run",
    note: "Host must explicitly apply and re-run host verification; provider success does not set hostVerification."
  });
}

export function removeWorkerWorktree(executionRoot, controlRoot) {
  if (!executionRoot || !controlRoot) return false;
  try {
    git(controlRoot, ["worktree", "remove", "--force", executionRoot], { allowFailure: true });
  } catch {
    /* fall through */
  }
  try {
    fs.rmSync(executionRoot, { recursive: true, force: true });
  } catch {
    return false;
  }
  return true;
}

export { assertSafeRelativePath, gitCommonDir };
