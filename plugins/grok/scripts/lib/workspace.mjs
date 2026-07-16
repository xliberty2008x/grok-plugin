import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CompanionError } from "./errors.mjs";
import { pluginDataRoot } from "./host.mjs";

export function git(cwd, args, { allowFailure = false, encoding = "utf8", maxBuffer = 8 * 1024 * 1024 } = {}) {
  const run = spawnSync("git", args, { cwd, encoding, maxBuffer, shell: false });
  if (run.error || (!allowFailure && run.status !== 0)) throw new CompanionError("E_GIT_REQUIRED", `Git command failed: git ${args.join(" ")}`, { stderr: String(run.stderr ?? "").trim() });
  return run;
}

export function workspaceRoot(cwd = process.cwd(), required = true) {
  const real = fs.realpathSync(cwd);
  const run = git(real, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (run.status !== 0) {
    if (required) throw new CompanionError("E_GIT_REQUIRED", "Run this command inside a Git repository.");
    return real;
  }
  return fs.realpathSync(String(run.stdout).trim());
}

/**
 * Stable per-repository state directory segment under the plugin data root.
 * Pure string derivation from a canonical repository path.
 */
export function workspaceStateSegment(canonicalRoot) {
  const hash = crypto.createHash("sha256").update(String(canonicalRoot)).digest("hex").slice(0, 16);
  const slug = path.basename(String(canonicalRoot)).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40) || "workspace";
  return `${slug}-${hash}`;
}

/**
 * Resolve the Git common directory for a checkout (shared by linked worktrees).
 */
export function gitCommonDir(root) {
  const run = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { allowFailure: true });
  if (run.status !== 0) {
    throw new CompanionError("E_GIT_REQUIRED", "Could not resolve git common directory.");
  }
  return fs.realpathSync(String(run.stdout).trim());
}

/**
 * Stable control-workspace identity shared by all linked worktrees of one repo.
 * controlRoot is the primary checkout root used for state/admission/integration.
 * executionRoot is per-worker and may differ (isolated worktree).
 */
export function resolveControlWorkspace(root, env = process.env) {
  const controlRoot = workspaceRoot(root, true);
  const common = gitCommonDir(controlRoot);
  const controlWorkspaceId = `cws-${crypto.createHash("sha256").update(common).digest("hex").slice(0, 32)}`;
  return Object.freeze({
    controlWorkspaceId,
    controlRoot,
    gitCommonDir: common,
    // Default execution root is the control root until a worktree is assigned.
    executionRoot: controlRoot
  });
}

/**
 * State directory keyed by control workspace (git common dir), not execution path.
 * Falls back to legacy path-keyed state for migration compatibility when
 * GROK_COMPANION_CONTROL_STATE is not set and legacy dir already exists.
 */
export function controlStateSegment(controlWorkspaceId) {
  const id = String(controlWorkspaceId || "");
  if (!/^cws-[a-f0-9]{32}$/.test(id)) {
    throw new CompanionError("E_STATE", "Invalid controlWorkspaceId.");
  }
  return `control-${id.slice(4, 20)}`;
}

export function controlStateDir(control, env = process.env) {
  const configuredData = pluginDataRoot(env);
  fs.mkdirSync(configuredData, { recursive: true, mode: 0o700 });
  const pluginData = fs.realpathSync(configuredData);
  const stateParent = path.join(pluginData, "state");
  try { fs.mkdirSync(stateParent, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const controlDir = path.join(stateParent, controlStateSegment(control.controlWorkspaceId));
  // Migration: if legacy path-keyed dir exists and control dir does not, prefer
  // creating control dir while leaving legacy intact (compatible dual-read later).
  try { fs.mkdirSync(controlDir, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  return controlDir;
}

/**
 * Shared admission lock name for a control workspace (cross-worktree).
 */
export function controlAdmissionLockName(controlWorkspaceId) {
  return `admission-${controlStateSegment(controlWorkspaceId)}`;
}

/**
 * Compute the workspace job-state directory without creating directories, locks,
 * or chmod side effects. Returns null when the plugin data root is absent.
 * Used by read-only MCP/service paths that must not call ensure().
 */
export function resolveWorkspaceStateDir(root, env = process.env) {
  let canonicalRoot;
  try {
    canonicalRoot = fs.realpathSync(root);
  } catch {
    return null;
  }
  const configuredData = pluginDataRoot(env);
  let pluginData;
  try {
    pluginData = fs.realpathSync(configuredData);
  } catch {
    return null;
  }
  const stateParent = path.join(pluginData, "state");
  const workspaceDirectory = path.join(stateParent, workspaceStateSegment(canonicalRoot));
  for (const directory of [stateParent, workspaceDirectory]) {
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      if (fs.realpathSync(directory) !== directory) return null;
    } catch {
      return null;
    }
  }
  return workspaceDirectory;
}

export function workspaceState(root, env = process.env) {
  const canonicalRoot = fs.realpathSync(root);
  const configuredData = pluginDataRoot(env);
  fs.mkdirSync(configuredData, { recursive: true, mode: 0o700 });
  const pluginData = fs.realpathSync(configuredData);
  const stateParent = path.join(pluginData, "state");
  try { fs.mkdirSync(stateParent, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const stateStat = fs.lstatSync(stateParent);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) {
    throw new CompanionError("E_STATE", `Refusing unsafe plugin state directory ${stateParent}.`);
  }
  if ((stateStat.mode & 0o077) !== 0) fs.chmodSync(stateParent, 0o700);
  return path.join(stateParent, workspaceStateSegment(canonicalRoot));
}

export function assertSafeJobId(id) {
  if (!/^(review|adversarial-review|task|stop-review)-[a-f0-9]{16,64}$/.test(String(id))) throw new CompanionError("E_USAGE", "Invalid job ID.");
  return id;
}
