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
 * @deprecated Prefer control-workspace state keyed by git common dir.
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
 * Main (primary) worktree root for a git common directory.
 * Prefer `git worktree list` first entry; fall back to parent of `.git` common dir.
 */
export function mainWorktreeRoot(fromRoot) {
  const list = git(fromRoot, ["worktree", "list", "--porcelain"], { allowFailure: true });
  if (list.status === 0) {
    const match = String(list.stdout).match(/^worktree (.+)$/m);
    if (match?.[1]) {
      return fs.realpathSync(match[1].trim());
    }
  }
  const common = gitCommonDir(fromRoot);
  if (path.basename(common) === ".git") {
    return fs.realpathSync(path.dirname(common));
  }
  // Bare or unusual layouts: fall back to the caller's toplevel.
  return workspaceRoot(fromRoot, true);
}

function controlWorkspaceIdFromCommon(common) {
  return `cws-${crypto.createHash("sha256").update(String(common)).digest("hex").slice(0, 32)}`;
}

/**
 * Stable control-workspace identity shared by all linked worktrees of one repo.
 *
 * - controlWorkspaceId: digest of git common dir (stable across worktrees)
 * - controlRoot: main worktree root (NOT the caller's worktree path when linked)
 * - executionRoot: the specific checkout root for this call (may be a worker worktree)
 */
export function resolveControlWorkspace(root, env = process.env) {
  void env;
  const executionRoot = workspaceRoot(root, true);
  const common = gitCommonDir(executionRoot);
  const controlRoot = mainWorktreeRoot(executionRoot);
  const controlWorkspaceId = controlWorkspaceIdFromCommon(common);
  return Object.freeze({
    controlWorkspaceId,
    controlRoot,
    gitCommonDir: common,
    executionRoot
  });
}

/**
 * State directory segment keyed by control workspace id (shared across worktrees).
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
  const stateStat = fs.lstatSync(stateParent);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) {
    throw new CompanionError("E_STATE", `Refusing unsafe plugin state directory ${stateParent}.`);
  }
  if ((stateStat.mode & 0o077) !== 0) fs.chmodSync(stateParent, 0o700);
  const controlDir = path.join(stateParent, controlStateSegment(control.controlWorkspaceId));
  try { fs.mkdirSync(controlDir, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const controlStat = fs.lstatSync(controlDir);
  if (!controlStat.isDirectory() || controlStat.isSymbolicLink()) {
    throw new CompanionError("E_STATE", `Refusing unsafe control state directory ${controlDir}.`);
  }
  if ((controlStat.mode & 0o077) !== 0) fs.chmodSync(controlDir, 0o700);
  return controlDir;
}

/**
 * Shared admission lock name for a control workspace (cross-worktree).
 */
export function controlAdmissionLockName(controlWorkspaceId) {
  return `admission-${controlStateSegment(controlWorkspaceId)}`;
}

/**
 * Resolve the shared admission lock name for any path in a control workspace.
 */
export function resolveAdmissionLockName(root, env = process.env) {
  try {
    const control = resolveControlWorkspace(root, env);
    return controlAdmissionLockName(control.controlWorkspaceId);
  } catch {
    return "workspace-admission";
  }
}

function isSafeExistingDir(directory) {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (fs.realpathSync(directory) !== directory) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the workspace job-state directory without creating directories, locks,
 * or chmod side effects. Returns null when the plugin data root is absent.
 * Prefers control-workspace state (shared across linked worktrees); falls back
 * to legacy path-keyed state for migration compatibility.
 */
export function resolveWorkspaceStateDir(root, env = process.env) {
  let configuredData;
  try {
    configuredData = pluginDataRoot(env);
  } catch {
    return null;
  }
  let pluginData;
  try {
    pluginData = fs.realpathSync(configuredData);
  } catch {
    return null;
  }
  const stateParent = path.join(pluginData, "state");
  if (!isSafeExistingDir(stateParent)) return null;

  // Control-keyed (shared) state first.
  try {
    const executionRoot = workspaceRoot(root, true);
    const common = gitCommonDir(executionRoot);
    const controlWorkspaceId = controlWorkspaceIdFromCommon(common);
    const controlDir = path.join(stateParent, controlStateSegment(controlWorkspaceId));
    if (isSafeExistingDir(controlDir)) return controlDir;
  } catch {
    /* fall through to legacy */
  }

  // Legacy path-keyed state (pre-control-workspace migration).
  let canonicalRoot;
  try {
    canonicalRoot = fs.realpathSync(root);
  } catch {
    return null;
  }
  // Also try show-toplevel if root is a path inside the repo.
  try {
    canonicalRoot = workspaceRoot(root, false);
  } catch {
    /* keep realpath */
  }
  const legacy = path.join(stateParent, workspaceStateSegment(canonicalRoot));
  if (isSafeExistingDir(legacy)) return legacy;
  return null;
}

/**
 * Ensure and return the job-state directory for a workspace path.
 * Uses control-workspace identity so all linked worktrees share one store.
 */
export function workspaceState(root, env = process.env) {
  try {
    const control = resolveControlWorkspace(root, env);
    return controlStateDir(control, env);
  } catch {
    // Non-git or resolution failure: legacy path-keyed behaviour.
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
}

export function assertSafeJobId(id) {
  if (!/^(review|adversarial-review|task|stop-review)-[a-f0-9]{16,64}$/.test(String(id))) throw new CompanionError("E_USAGE", "Invalid job ID.");
  return id;
}
