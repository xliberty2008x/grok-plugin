/**
 * Phase 3: host-owned worktrees, control-workspace identity consumers,
 * artifact validation, and parent-checkout isolation checks.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { CompanionError } from "./errors.mjs";
import { evaluateScope } from "./task-contract.mjs";
import {
  controlStateDir,
  resolveControlWorkspace,
  gitCommonDir
} from "./workspace.mjs";

export const ARTIFACT_MANIFEST_VERSION = 1;
const PARENT_FINGERPRINT_VERSION = 1;
const PARENT_FINGERPRINT_FIELDS = Object.freeze([
  "clean",
  "fingerprintDigest",
  "fingerprintVersion",
  "head",
  "indexDigest",
  "indexSecurityDigest",
  "status",
  "statusDigest",
  "tree",
  "worktreeDigest",
  "worktreeEntryCount"
].sort());

function git(cwd, args, { allowFailure = false, encoding = "utf8" } = {}) {
  const run = spawnSync("git", args, { cwd, encoding, shell: false, maxBuffer: 32 * 1024 * 1024 });
  if (run.error || (!allowFailure && run.status !== 0)) {
    throw new CompanionError("E_GIT_REQUIRED", `Git command failed: git ${args.join(" ")}`, {
      stderr: String(run.stderr || "").trim()
    });
  }
  return run;
}

function sha(value) {
  return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : String(value)).digest("hex");
}

function stableStringify(value) {
  if (value === undefined) return "null";
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
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

function safePrivateDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
    throw new CompanionError("E_WORKTREE", `Refusing unsafe ${label} ${directory}.`);
  }
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(directory, 0o700);
  return directory;
}

function containedPath(root, candidate) {
  return candidate !== root && candidate.startsWith(`${root}${path.sep}`);
}

function assertContainedPathChain(root, candidate, relativePath, visited = new Set()) {
  const relative = path.relative(root, candidate);
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (!stat.isSymbolicLink()) continue;
    if (visited.has(current)) {
      throw new CompanionError("E_SCOPE_VIOLATION", `Symlink cycle detected for ${relativePath}.`);
    }
    visited.add(current);
    const nestedTarget = fs.readlinkSync(current);
    if (path.isAbsolute(nestedTarget)) {
      throw new CompanionError("E_SCOPE_VIOLATION", `Symlink ${relativePath} resolves through an absolute target.`);
    }
    const nestedAbsolute = path.resolve(path.dirname(current), nestedTarget);
    if (!containedPath(root, nestedAbsolute)) {
      throw new CompanionError("E_SCOPE_VIOLATION", `Symlink ${relativePath} resolves outside the execution root.`);
    }
    assertContainedPathChain(root, nestedAbsolute, relativePath, visited);
  }
}

function assertContainedSymlinkTarget(root, linkPath, target, relativePath) {
  if (path.isAbsolute(target)) {
    throw new CompanionError("E_SCOPE_VIOLATION", `Symlink ${relativePath} has an absolute target.`);
  }
  const targetAbsolute = path.resolve(path.dirname(linkPath), target);
  if (!containedPath(root, targetAbsolute)) {
    throw new CompanionError("E_SCOPE_VIOLATION", `Symlink ${relativePath} escapes the execution root.`);
  }
  // Lexical containment is insufficient when an intermediate component is a
  // symlink. Inspect every existing link in the target chain, including broken
  // links whose final target cannot be realpath-resolved.
  assertContainedPathChain(root, targetAbsolute, relativePath, new Set([linkPath]));
}

function resolveExactCommit(root, revision) {
  const run = git(root, ["rev-parse", "--verify", `${revision}^{commit}`]);
  const exact = String(run.stdout || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(exact)) {
    throw new CompanionError("E_WORKTREE", "Base revision did not resolve to an exact commit object ID.");
  }
  return exact;
}

function workerWorktreeSlug(workerId) {
  const rawWorkerId = String(workerId);
  const readable = rawWorkerId
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "worker";
  return `${readable}-${sha(rawWorkerId).slice(0, 12)}`;
}

function statSignature(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs]
    .map((value) => String(value))
    .join(":");
}

function hashRegularFileNoFollow(file, expectedStat) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || statSignature(opened) !== statSignature(expectedStat)) {
      throw new CompanionError("E_INTEGRATION", `File identity changed while hashing ${file}.`);
    }
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  const after = fs.lstatSync(file, { bigint: true });
  if (statSignature(after) !== statSignature(expectedStat)) {
    throw new CompanionError("E_INTEGRATION", `File identity changed while hashing ${file}.`);
  }
  return hash.digest("hex");
}

function gitlinkIdentity(root, relativePath, absolutePath, present) {
  const run = git(root, ["ls-files", "-s", "--", relativePath], { allowFailure: true });
  if (run.status !== 0 || run.error) {
    throw new CompanionError("E_INTEGRATION", `Could not resolve index identity for ${relativePath}.`);
  }
  const match = String(run.stdout || "").match(/^160000 ([a-f0-9]{40,64}) [0-3]\t/);
  if (!match) return null;
  if (present) {
    const contents = fs.readdirSync(absolutePath);
    if (contents.length) {
      // A status digest is not content identity: same-path/same-status edits in
      // an initialized submodule produce identical manifests. Until recursive
      // submodule capture exists, allow only the empty directory Git creates for
      // an uninitialized gitlink and bind it to the index object ID below.
      throw new CompanionError(
        "E_SCOPE_VIOLATION",
        `Initialized or populated gitlink ${relativePath} is unsupported for isolated artifacts.`
      );
    }
  }
  return Object.freeze({
    kind: "gitlink",
    indexMode: "160000",
    indexObjectId: match[1],
    present,
    initialized: false
  });
}

function pathIdentity(root, relativePath, { rejectEscapingSymlink = true } = {}) {
  const relative = assertSafeRelativePath(relativePath);
  const absolute = path.resolve(root, relative);
  if (!containedPath(root, absolute)) {
    throw new CompanionError("E_SCOPE_VIOLATION", `Path escapes execution root: ${relative}.`);
  }
  let stat;
  try {
    stat = fs.lstatSync(absolute, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return gitlinkIdentity(root, relative, absolute, false) || Object.freeze({ kind: "missing" });
    }
    throw error;
  }
  const mode = Number(stat.mode & 0o7777n);
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(absolute);
    if (rejectEscapingSymlink) assertContainedSymlinkTarget(root, absolute, target, relative);
    return Object.freeze({
      kind: "symlink",
      mode,
      target,
      targetDigest: sha(target)
    });
  }
  if (stat.isFile()) {
    const size = Number(stat.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new CompanionError("E_INTEGRATION", `Unsafe file size for ${relative}.`);
    }
    return Object.freeze({
      kind: "file",
      mode,
      size,
      contentDigest: hashRegularFileNoFollow(absolute, stat)
    });
  }
  if (stat.isDirectory()) {
    const gitlink = gitlinkIdentity(root, relative, absolute, true);
    if (gitlink) return gitlink;
    // `git ls-files --others` collapses an embedded repository to one directory
    // entry. Recording only its mode would omit every descendant byte and any
    // escaping symlink. Ordinary tracked/untracked files are enumerated
    // individually, so a non-gitlink directory is necessarily opaque here.
    throw new CompanionError(
      "E_SCOPE_VIOLATION",
      `Opaque non-gitlink directory ${relative} is unsupported for isolated artifacts.`
    );
  }
  throw new CompanionError("E_SCOPE_VIOLATION", `Unsupported filesystem object at ${relative}.`);
}

function nulPaths(value) {
  return String(value || "").split("\0").filter(Boolean);
}

const SUPPORTED_INDEX_MODES = new Set(["100644", "100755", "120000", "160000"]);

function unsafeIndexState() {
  throw new CompanionError("E_SCOPE_VIOLATION", "Unsupported or unsafe Git index state.");
}

function nulBufferRecords(value) {
  const raw = Buffer.isBuffer(value) ? value : Buffer.from(value || "");
  if (raw.length === 0) return [];
  if (raw.at(-1) !== 0) unsafeIndexState();
  const records = [];
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0) continue;
    if (index === start) unsafeIndexState();
    records.push(raw.subarray(start, index));
    start = index + 1;
  }
  if (start !== raw.length) unsafeIndexState();
  return records;
}

function assertNoIntentToAdd(root) {
  // Modern Git exposes intent-to-add as an empty-blob stage-0 ls-files entry,
  // not necessarily a zero OID. The raw worktree diff retains the authoritative
  // all-zero A record, so reject it in addition to zero OIDs in the index parser.
  const raw = git(root, ["diff", "--raw", "--no-abbrev", "--no-renames", "-z", "--"], {
    encoding: null
  }).stdout || Buffer.alloc(0);
  const records = nulBufferRecords(raw);
  if (records.length % 2 !== 0) unsafeIndexState();
  const headerPattern = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([A-Z][0-9]*)$/;
  for (let index = 0; index < records.length; index += 2) {
    const match = records[index].toString("ascii").match(headerPattern);
    if (!match || records[index + 1].length === 0) unsafeIndexState();
    const [, oldMode, , oldOid, newOid, status] = match;
    if (
      oldMode === "000000"
      && status === "A"
      && /^0+$/.test(oldOid)
      && /^0+$/.test(newOid)
    ) {
      unsafeIndexState();
    }
  }
}

function captureVisibleIndexIdentity(root) {
  // Strictly accept only ordinary stage-0 cache entries. `-v` lower-cases the
  // tag for assume-unchanged entries and emits S for skip-worktree; all tags
  // except H, all nonzero stages, malformed records, duplicate opaque paths,
  // unsupported modes, and zero/invalid OIDs fail closed without path leakage.
  const raw = git(root, ["ls-files", "-s", "-v", "-z"], { encoding: null }).stdout || Buffer.alloc(0);
  const records = nulBufferRecords(raw);
  const paths = new Set();
  const headerPattern = /^H (100644|100755|120000|160000) ([0-9a-f]{40}|[0-9a-f]{64}) 0$/;
  for (const record of records) {
    const tab = record.indexOf(0x09);
    if (tab <= 0 || tab === record.length - 1) unsafeIndexState();
    const header = record.subarray(0, tab).toString("ascii");
    const match = header.match(headerPattern);
    if (!match || !SUPPORTED_INDEX_MODES.has(match[1]) || /^0+$/.test(match[2])) unsafeIndexState();
    const opaquePath = record.subarray(tab + 1).toString("hex");
    if (paths.has(opaquePath)) unsafeIndexState();
    paths.add(opaquePath);
  }
  assertNoIntentToAdd(root);
  return sha(raw);
}

function captureWithStableVisibleIndex(root, capture) {
  const before = captureVisibleIndexIdentity(root);
  const value = capture();
  const after = captureVisibleIndexIdentity(root);
  if (before !== after) {
    throw new CompanionError("E_INTEGRATION", "Git index identity changed during worktree security capture.");
  }
  return Object.freeze({ value, indexSecurityDigest: after });
}

function captureWorktreeEntries(root, { rejectEscapingSymlink = false } = {}) {
  const listed = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const ignored = git(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"]);
  return [...new Set([...nulPaths(listed.stdout), ...nulPaths(ignored.stdout)].map((item) => assertSafeRelativePath(item)))]
    .sort()
    .map((relativePath) => ({
      path: relativePath,
      identity: pathIdentity(root, relativePath, { rejectEscapingSymlink })
    }));
}

function parentFingerprintCore(value) {
  return {
    fingerprintVersion: value.fingerprintVersion,
    head: value.head,
    tree: value.tree,
    clean: value.clean,
    statusDigest: value.statusDigest,
    indexDigest: value.indexDigest,
    indexSecurityDigest: value.indexSecurityDigest,
    worktreeDigest: value.worktreeDigest,
    worktreeEntryCount: value.worktreeEntryCount,
    status: value.status
  };
}

function assertValidParentFingerprint(value) {
  const invalid = () => {
    throw new CompanionError(
      "E_INTEGRATION",
      "Parent fingerprint is malformed or lacks bound cleanliness evidence."
    );
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const fields = Object.keys(value).sort();
  if (
    fields.length !== PARENT_FINGERPRINT_FIELDS.length
    || fields.some((field, index) => field !== PARENT_FINGERPRINT_FIELDS[index])
  ) invalid();
  const objectId = /^[a-f0-9]{40,64}$/;
  const digest = /^[a-f0-9]{64}$/;
  if (
    value.fingerprintVersion !== PARENT_FINGERPRINT_VERSION
    || !objectId.test(value.head)
    || !objectId.test(value.tree)
    || typeof value.clean !== "boolean"
    || typeof value.status !== "string"
    || !digest.test(value.statusDigest)
    || !digest.test(value.indexDigest)
    || !digest.test(value.indexSecurityDigest)
    || !digest.test(value.worktreeDigest)
    || !digest.test(value.fingerprintDigest)
    || !Number.isSafeInteger(value.worktreeEntryCount)
    || value.worktreeEntryCount < 0
    || value.statusDigest !== sha(value.status)
    || value.clean !== (value.status.length === 0)
    || value.fingerprintDigest !== sha(stableStringify(parentFingerprintCore(value)))
  ) invalid();
  return value;
}

/**
 * Create a host-owned detached worktree from one resolved exact base commit.
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
  try { fs.mkdirSync(worktrees, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  safePrivateDirectory(worktrees, "worktree directory");

  const slug = workerWorktreeSlug(workerId);
  const executionRoot = path.join(worktrees, slug);
  if (fs.existsSync(executionRoot)) {
    throw new CompanionError("E_WORKTREE", `Worktree path already exists for ${workerId}.`);
  }

  const exactBaseCommit = resolveExactCommit(control.controlRoot, baseCommit);
  git(control.controlRoot, ["worktree", "add", "--detach", executionRoot, exactBaseCommit]);
  const resolvedExecutionRoot = fs.realpathSync(executionRoot);
  const actualHead = resolveExactCommit(resolvedExecutionRoot, "HEAD");
  const actualCommon = gitCommonDir(resolvedExecutionRoot);
  if (actualHead !== exactBaseCommit || actualCommon !== control.gitCommonDir) {
    git(control.controlRoot, ["worktree", "remove", "--force", resolvedExecutionRoot], { allowFailure: true });
    throw new CompanionError("E_WORKTREE", "Created worktree identity did not match its exact base/control repository.");
  }
  try {
    // A worker can follow a tracked symlink before it creates any Git-visible
    // change. Refuse unsafe base trees before exposing the execution root.
    captureWithStableVisibleIndex(resolvedExecutionRoot, () => (
      captureWorktreeEntries(resolvedExecutionRoot, { rejectEscapingSymlink: true })
    ));
  } catch (error) {
    const removed = git(control.controlRoot, ["worktree", "remove", "--force", resolvedExecutionRoot], { allowFailure: true });
    if (removed.status !== 0 || fs.existsSync(resolvedExecutionRoot)) {
      throw new CompanionError("E_WORKTREE", "Unsafe worker worktree could not be removed after preflight failure.");
    }
    throw error;
  }

  return Object.freeze({
    controlWorkspaceId: control.controlWorkspaceId,
    controlRoot: control.controlRoot,
    executionRoot: resolvedExecutionRoot,
    baseCommit: exactBaseCommit,
    branch: null,
    detached: true,
    parentHeadAfterCreate: resolveExactCommit(control.controlRoot, "HEAD"),
    parentStatusAfterCreate: git(control.controlRoot, ["status", "--porcelain"]).stdout,
    gitCommonDir: control.gitCommonDir
  });
}

export function captureParentFingerprint(root) {
  const canonicalRoot = fs.realpathSync(root);
  const head = resolveExactCommit(canonicalRoot, "HEAD");
  const tree = git(canonicalRoot, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
  const captured = captureWithStableVisibleIndex(canonicalRoot, () => ({
    status: git(canonicalRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=matching"
    ]).stdout,
    index: git(canonicalRoot, ["ls-files", "-s", "-z"]).stdout,
    worktreeEntries: captureWorktreeEntries(canonicalRoot)
  }));
  const { status, index, worktreeEntries } = captured.value;
  const fingerprint = {
    fingerprintVersion: PARENT_FINGERPRINT_VERSION,
    head,
    tree,
    clean: status.length === 0,
    statusDigest: sha(status),
    indexDigest: sha(index),
    indexSecurityDigest: captured.indexSecurityDigest,
    worktreeDigest: sha(stableStringify(worktreeEntries)),
    worktreeEntryCount: worktreeEntries.length,
    status
  };
  return Object.freeze({
    ...fingerprint,
    fingerprintDigest: sha(stableStringify(fingerprint))
  });
}

export function assertParentUnchanged(before, root) {
  const trustedBefore = assertValidParentFingerprint(before);
  const after = captureParentFingerprint(root);
  if (trustedBefore.head !== after.head) {
    throw new CompanionError("E_INTEGRATION", "Parent HEAD changed before explicit integration.");
  }
  if (trustedBefore.tree !== after.tree) {
    throw new CompanionError("E_INTEGRATION", "Parent tree changed before explicit integration.");
  }
  if (trustedBefore.indexDigest !== after.indexDigest) {
    throw new CompanionError("E_INTEGRATION", "Parent index changed before explicit integration.");
  }
  if (trustedBefore.indexSecurityDigest !== after.indexSecurityDigest) {
    throw new CompanionError("E_INTEGRATION", "Parent index security identity changed before explicit integration.");
  }
  if (
    trustedBefore.clean !== after.clean
    || trustedBefore.statusDigest !== after.statusDigest
    || trustedBefore.worktreeDigest !== after.worktreeDigest
    || trustedBefore.worktreeEntryCount !== after.worktreeEntryCount
  ) {
    throw new CompanionError("E_INTEGRATION", "Parent working tree changed before explicit integration.");
  }
  if (trustedBefore.fingerprintDigest !== after.fingerprintDigest) {
    throw new CompanionError("E_INTEGRATION", "Parent fingerprint changed before explicit integration.");
  }
  return after;
}

function changedWorktreeEntries(executionRoot, baseCommit) {
  const diff = git(executionRoot, ["diff", "--name-status", "-z", "--find-renames", baseCommit, "--"]);
  const tokens = nulPaths(diff.stdout);
  const changed = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (/^[RC]/.test(status)) {
      const sourcePath = assertSafeRelativePath(tokens[index++]);
      const filePath = assertSafeRelativePath(tokens[index++]);
      changed.push({ status, path: filePath, sourcePath });
    } else {
      const filePath = assertSafeRelativePath(tokens[index++]);
      changed.push({ status, path: filePath });
    }
  }
  const untracked = git(executionRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  for (const item of nulPaths(untracked.stdout)) {
    const relative = assertSafeRelativePath(item);
    if (!changed.some((entry) => entry.path === relative)) changed.push({ status: "?", path: relative });
  }
  const ignored = git(executionRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]);
  for (const item of nulPaths(ignored.stdout)) {
    const relative = assertSafeRelativePath(item);
    if (!changed.some((entry) => entry.path === relative)) changed.push({ status: "!", path: relative });
  }
  return changed
    .map((entry) => ({
      ...entry,
      identity: pathIdentity(executionRoot, entry.path, { rejectEscapingSymlink: true }),
      ...(entry.sourcePath ? {
        sourceIdentity: pathIdentity(executionRoot, entry.sourcePath, { rejectEscapingSymlink: true })
      } : {})
    }))
    .sort((left, right) => `${left.path}\0${left.sourcePath || ""}`.localeCompare(`${right.path}\0${right.sourcePath || ""}`));
}

function validateScope(changed, scope) {
  if (scope == null) return;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new CompanionError("E_SCOPE_VIOLATION", "Artifact scope must use the TaskEnvelope include/exclude contract.");
  }
  const unknown = Object.keys(scope).filter((key) => key !== "include" && key !== "exclude");
  if (unknown.length || !Array.isArray(scope.include) || !Array.isArray(scope.exclude)) {
    throw new CompanionError("E_SCOPE_VIOLATION", "Artifact scope must contain only include[] and exclude[].");
  }
  if (scope.include.length > 64 || scope.exclude.length > 64) {
    throw new CompanionError("E_SCOPE_VIOLATION", "Artifact scope exceeds TaskEnvelope pattern bounds.");
  }
  for (const pattern of [...scope.include, ...scope.exclude]) {
    if (typeof pattern !== "string" || pattern.length > 4096) {
      throw new CompanionError("E_SCOPE_VIOLATION", "Artifact scope contains an invalid path pattern.");
    }
    assertSafeRelativePath(pattern);
  }
  const paths = changed.flatMap((entry) => [entry.path, ...(
    /^R/.test(entry.status) && entry.sourcePath ? [entry.sourcePath] : []
  )]);
  const violations = evaluateScope(paths, scope);
  if (violations.length) {
    throw new CompanionError(
      "E_SCOPE_VIOLATION",
      `Out-of-scope artifact paths: ${violations.join(", ")}.`,
      { paths: violations }
    );
  }
}

function manifestWithoutDigest(manifest) {
  const { manifestDigest: _manifestDigest, ...unsigned } = manifest;
  return unsigned;
}

function securityProjection(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    workerId: manifest.workerId,
    controlWorkspaceId: manifest.controlWorkspaceId,
    controlRootDigest: manifest.controlRootDigest,
    executionRootDigest: manifest.executionRootDigest,
    lineage: manifest.lineage ?? null,
    baseCommit: manifest.baseCommit,
    resultHead: manifest.resultHead,
    resultTree: manifest.resultTree,
    patchDigest: manifest.patchDigest,
    indexSecurityDigest: manifest.indexSecurityDigest,
    worktreeSafetyDigest: manifest.worktreeSafetyDigest,
    worktreeEntryCount: manifest.worktreeEntryCount,
    workingTreeDigest: manifest.workingTreeDigest,
    changedPaths: manifest.changedPaths,
    scope: manifest.scope ?? null
  };
}

function manifestDigest(manifest) {
  return sha(stableStringify(manifestWithoutDigest(manifest)));
}

function securityDigest(manifest) {
  return sha(stableStringify(securityProjection(manifest)));
}

/** Build a content-, type-, mode-, symlink-, scope-, and identity-bound artifact manifest. */
export function buildArtifactManifest({
  workerId,
  controlWorkspaceId,
  controlRoot,
  executionRoot,
  baseCommit,
  scope = null,
  lineage = null
} = {}) {
  if (!executionRoot || !baseCommit || !workerId || !controlRoot || !controlWorkspaceId) {
    throw new CompanionError("E_USAGE", "workerId, control identity/roots, executionRoot, and baseCommit are required.");
  }
  const canonicalControlRoot = fs.realpathSync(controlRoot);
  const canonicalExecutionRoot = fs.realpathSync(executionRoot);
  const exactBaseCommit = resolveExactCommit(canonicalExecutionRoot, baseCommit);
  const captured = captureWithStableVisibleIndex(canonicalExecutionRoot, () => {
    const head = resolveExactCommit(canonicalExecutionRoot, "HEAD");
    const tree = git(canonicalExecutionRoot, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
    // Scan the complete tracked/untracked/ignored tree, not only Git changes.
    // This closes the pre-existing-symlink escape where an external target can be
    // mutated without changing the symlink entry or producing a Git diff.
    const worktreeEntries = captureWorktreeEntries(canonicalExecutionRoot, {
      rejectEscapingSymlink: true
    });
    const changed = changedWorktreeEntries(canonicalExecutionRoot, exactBaseCommit);
    validateScope(changed, scope);
    const patch = git(canonicalExecutionRoot, ["diff", "--binary", "--full-index", exactBaseCommit, "--"]).stdout || "";
    return { head, tree, worktreeEntries, changed, patch };
  });
  const { head, tree, worktreeEntries, changed, patch } = captured.value;
  const manifest = {
    schemaVersion: ARTIFACT_MANIFEST_VERSION,
    workerId,
    controlWorkspaceId,
    controlRootDigest: sha(canonicalControlRoot),
    executionRootDigest: sha(canonicalExecutionRoot),
    lineage: lineage ?? null,
    baseCommit: exactBaseCommit,
    resultHead: head,
    resultTree: tree,
    patchDigest: sha(patch),
    indexSecurityDigest: captured.indexSecurityDigest,
    worktreeSafetyDigest: sha(stableStringify(worktreeEntries)),
    worktreeEntryCount: worktreeEntries.length,
    workingTreeDigest: sha(stableStringify(changed)),
    changedPaths: changed,
    scope: scope ?? null,
    workerVerification: "not_run",
    createdAt: new Date().toISOString()
  };
  manifest.securityDigest = securityDigest(manifest);
  manifest.manifestDigest = manifestDigest(manifest);
  return Object.freeze(manifest);
}

/** Validate stored digest and, when supplied, recompute all security-relevant fields. */
export function validateArtifactForIntegration(manifest, {
  expectedBaseCommit = null,
  expectedControlWorkspaceId = null,
  expectedWorkerId = null,
  expectedScope = undefined,
  expectedLineage = undefined,
  expectedControlRoot = null,
  expectedExecutionRoot = null,
  recomputeFromExecutionRoot = null
} = {}) {
  if (!manifest || manifest.schemaVersion !== ARTIFACT_MANIFEST_VERSION) {
    throw new CompanionError("E_INTEGRATION", "Invalid artifact manifest.");
  }
  if (manifest.manifestDigest !== manifestDigest(manifest)) {
    throw new CompanionError("E_INTEGRATION", "Artifact manifest digest tampering detected.");
  }
  if (manifest.securityDigest !== securityDigest(manifest)) {
    throw new CompanionError("E_INTEGRATION", "Artifact security digest tampering detected.");
  }
  if (!/^[a-f0-9]{40,64}$/.test(String(manifest.baseCommit || ""))) {
    throw new CompanionError("E_INTEGRATION", "Artifact base is not an exact commit object ID.");
  }
  if (!/^[a-f0-9]{64}$/.test(String(manifest.indexSecurityDigest || ""))) {
    throw new CompanionError("E_INTEGRATION", "Artifact lacks a content-bound visible index identity.");
  }
  if (expectedBaseCommit && manifest.baseCommit !== expectedBaseCommit) {
    throw new CompanionError("E_INTEGRATION", "Artifact base commit does not match expected base.");
  }
  if (expectedControlWorkspaceId && manifest.controlWorkspaceId !== expectedControlWorkspaceId) {
    throw new CompanionError("E_INTEGRATION", "Artifact control workspace identity mismatch.");
  }
  if (expectedWorkerId && manifest.workerId !== expectedWorkerId) {
    throw new CompanionError("E_INTEGRATION", "Artifact worker identity mismatch.");
  }
  if (expectedScope !== undefined && stableStringify(manifest.scope ?? null) !== stableStringify(expectedScope)) {
    throw new CompanionError("E_INTEGRATION", "Artifact scope does not match the host contract.");
  }
  if (expectedLineage !== undefined && stableStringify(manifest.lineage ?? null) !== stableStringify(expectedLineage)) {
    throw new CompanionError("E_INTEGRATION", "Artifact lineage does not match the host contract.");
  }
  for (const entry of manifest.changedPaths || []) {
    assertSafeRelativePath(entry.path);
    if (entry.sourcePath) assertSafeRelativePath(entry.sourcePath);
  }
  if (expectedControlRoot && manifest.controlRootDigest !== sha(fs.realpathSync(expectedControlRoot))) {
    throw new CompanionError("E_INTEGRATION", "Artifact control root mismatch.");
  }
  if (expectedExecutionRoot && manifest.executionRootDigest !== sha(fs.realpathSync(expectedExecutionRoot))) {
    throw new CompanionError("E_INTEGRATION", "Artifact execution root mismatch.");
  }
  if (recomputeFromExecutionRoot) {
    const trustedScope = expectedScope === undefined ? (manifest.scope ?? null) : expectedScope;
    const trustedLineage = expectedLineage === undefined ? (manifest.lineage ?? null) : expectedLineage;
    const trustedWorkerId = expectedWorkerId || manifest.workerId;
    const trustedControlWorkspaceId = expectedControlWorkspaceId || manifest.controlWorkspaceId;
    const recomputed = buildArtifactManifest({
      workerId: trustedWorkerId,
      controlWorkspaceId: trustedControlWorkspaceId,
      controlRoot: recomputeFromExecutionRoot.controlRoot,
      executionRoot: recomputeFromExecutionRoot.executionRoot,
      baseCommit: expectedBaseCommit || manifest.baseCommit,
      scope: trustedScope,
      lineage: trustedLineage
    });
    if (stableStringify(securityProjection(recomputed)) !== stableStringify(securityProjection(manifest))) {
      throw new CompanionError("E_INTEGRATION", "Artifact filesystem identity, content, scope, or lineage drift detected.");
    }
  }
  return true;
}

/** Explicit host readiness gate. It always recomputes from a registered execution root. */
export function prepareIntegration(options = {}) {
  const {
    controlRoot,
    executionRoot,
    manifest,
    parentFingerprint,
    expectedWorkerId,
    env = process.env
  } = options;
  if (!controlRoot || !executionRoot || !manifest || !parentFingerprint || !expectedWorkerId) {
    throw new CompanionError("E_USAGE", "prepareIntegration requires trusted control/execution roots, parent fingerprint, manifest, and worker ID.");
  }
  if (!Object.hasOwn(options, "expectedScope") || !Object.hasOwn(options, "expectedLineage")) {
    throw new CompanionError("E_USAGE", "prepareIntegration requires explicit trusted scope and lineage expectations.");
  }
  const trustedParentFingerprint = assertValidParentFingerprint(parentFingerprint);
  if (!trustedParentFingerprint.clean) {
    throw new CompanionError(
      "E_INTEGRATION",
      "Parent fingerprint must represent a clean checkout before explicit integration."
    );
  }
  const control = resolveControlWorkspace(controlRoot, env);
  const canonicalExecutionRoot = fs.realpathSync(executionRoot);
  const state = controlStateDir(control, env);
  const worktrees = path.join(state, "worktrees");
  if (!fs.existsSync(worktrees)) {
    throw new CompanionError("E_INTEGRATION", "Control workspace has no managed worker worktree directory.");
  }
  let managedRoot;
  try {
    managedRoot = fs.realpathSync(safePrivateDirectory(worktrees, "worktree directory"));
  } catch (error) {
    if (error instanceof CompanionError) {
      throw new CompanionError("E_INTEGRATION", "Managed worker worktree directory is unsafe.");
    }
    throw error;
  }
  const expectedExecutionRoot = path.join(managedRoot, workerWorktreeSlug(expectedWorkerId));
  if (
    !containedPath(managedRoot, canonicalExecutionRoot)
    || canonicalExecutionRoot !== expectedExecutionRoot
  ) {
    throw new CompanionError(
      "E_INTEGRATION",
      "Execution root is not the managed worktree registered for this worker."
    );
  }
  if (!listedWorktreeRoots(control.controlRoot).includes(canonicalExecutionRoot)) {
    throw new CompanionError("E_INTEGRATION", "Execution root is not a registered Git worktree.");
  }
  if (gitCommonDir(canonicalExecutionRoot) !== control.gitCommonDir) {
    throw new CompanionError("E_INTEGRATION", "Execution root belongs to a different Git control workspace.");
  }
  validateArtifactForIntegration(manifest, {
    expectedBaseCommit: trustedParentFingerprint.head,
    expectedControlWorkspaceId: control.controlWorkspaceId,
    expectedWorkerId,
    expectedScope: options.expectedScope,
    expectedLineage: options.expectedLineage,
    expectedControlRoot: control.controlRoot,
    expectedExecutionRoot: canonicalExecutionRoot,
    recomputeFromExecutionRoot: {
      controlRoot: control.controlRoot,
      executionRoot: canonicalExecutionRoot
    }
  });
  const currentParentFingerprint = assertParentUnchanged(trustedParentFingerprint, control.controlRoot);
  if (!currentParentFingerprint.clean) {
    throw new CompanionError("E_INTEGRATION", "Parent checkout is not clean before explicit integration.");
  }
  return Object.freeze({
    ready: true,
    autoApplied: false,
    requiresExplicitHostApply: true,
    hostVerification: "not_run",
    note: "Host must explicitly apply and re-run host verification; provider success does not set hostVerification."
  });
}

function listedWorktreeRoots(controlRoot) {
  const run = git(controlRoot, ["worktree", "list", "--porcelain"]);
  return String(run.stdout || "")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .flatMap((candidate) => {
      try { return [fs.realpathSync(candidate)]; }
      catch { return []; }
    });
}

export function removeWorkerWorktree(executionRoot, controlRoot, expectedWorkerId, env = process.env) {
  if (!executionRoot || !controlRoot || !expectedWorkerId) {
    throw new CompanionError("E_USAGE", "executionRoot, controlRoot, and expectedWorkerId are required for worker cleanup.");
  }
  const control = resolveControlWorkspace(controlRoot, env);
  const state = controlStateDir(control, env);
  const worktrees = path.join(state, "worktrees");
  if (!fs.existsSync(worktrees)) {
    throw new CompanionError("E_WORKTREE", "Control workspace has no managed worktree directory.");
  }
  const managedRoot = fs.realpathSync(safePrivateDirectory(worktrees, "worktree directory"));
  let candidate;
  try { candidate = fs.realpathSync(executionRoot); }
  catch { throw new CompanionError("E_WORKTREE", "Worker worktree does not exist."); }
  if (!containedPath(managedRoot, candidate)) {
    throw new CompanionError("E_WORKTREE", "Refusing to remove a path outside the managed worktree directory.");
  }
  const expectedExecutionRoot = path.join(managedRoot, workerWorktreeSlug(expectedWorkerId));
  if (candidate !== expectedExecutionRoot) {
    throw new CompanionError("E_WORKTREE", "Refusing to remove a worktree that does not match the expected worker identity.");
  }
  if (!listedWorktreeRoots(control.controlRoot).includes(candidate)) {
    throw new CompanionError("E_WORKTREE", "Refusing to remove a path that is not a registered Git worktree.");
  }
  if (gitCommonDir(candidate) !== control.gitCommonDir) {
    throw new CompanionError("E_WORKTREE", "Refusing to remove a worktree from a different Git common directory.");
  }
  const removed = git(control.controlRoot, ["worktree", "remove", "--force", candidate], { allowFailure: true });
  if (removed.status !== 0 || removed.error) {
    throw new CompanionError("E_WORKTREE", "Git refused to remove the managed worker worktree.", {
      stderr: String(removed.stderr || "").trim()
    });
  }
  if (fs.existsSync(candidate)) {
    throw new CompanionError("E_WORKTREE", "Git reported success but the managed worktree still exists.");
  }
  return true;
}

export { assertSafeRelativePath, gitCommonDir };
