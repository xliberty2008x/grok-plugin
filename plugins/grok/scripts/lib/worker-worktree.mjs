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
  controlStateSegment,
  resolveControlWorkspace,
  gitCommonDir
} from "./workspace.mjs";
import { pluginDataRoot } from "./host.mjs";

export const ARTIFACT_MANIFEST_VERSION = 1;
/** First write vertical permits exactly this one tracked text path. */
export const WRITE_VERTICAL_TARGET_PATH = "target.txt";
export const EXACT_WRITE_VERTICAL_SCOPE = Object.freeze({
  include: Object.freeze([WRITE_VERTICAL_TARGET_PATH]),
  exclude: Object.freeze([])
});
export const WRITE_ARTIFACT_RECORD_SCHEMA_VERSION = 1;
const WRITE_ARTIFACT_MAX_CONTENT_BYTES = 256 * 1024;
const WRITE_ARTIFACT_MAX_PATCH_BYTES = 512 * 1024;
const WRITE_ARTIFACT_MAX_RECORD_BYTES = 2 * 1024 * 1024;
const WRITE_ARTIFACT_MAX_DIRECTORY_ENTRIES = 4;
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

export function workerWorktreeSlug(workerId) {
  const rawWorkerId = String(workerId);
  const readable = rawWorkerId
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "worker";
  return `${readable}-${sha(rawWorkerId).slice(0, 12)}`;
}

/**
 * Return the one broker-owned private destination parent for a worker identity.
 *
 * The provider receives this unique parent instead of the shared worktree
 * directory, so one worker can never select or collide with a sibling's
 * checkout name.
 */
export function expectedWorkerWorktreeParent(controlRoot, workerId, env = process.env) {
  if (!controlRoot || !workerId) {
    throw new CompanionError("E_USAGE", "controlRoot and workerId are required.");
  }
  const control = resolveControlWorkspace(controlRoot, env);
  const state = controlStateDir(control, env);
  return path.join(state, "worktrees", workerWorktreeSlug(workerId));
}

/**
 * Return the one broker-owned detached-worktree path for a worker identity.
 *
 * The path is derived from the control-workspace state root and never from
 * provider input. Callers may persist this path before provisioning so crash
 * recovery can distinguish exact adoption from an unrelated directory.
 */
export function expectedWorkerWorktreeRoot(controlRoot, workerId, env = process.env) {
  return path.join(
    expectedWorkerWorktreeParent(controlRoot, workerId, env),
    "checkout"
  );
}

function readSmallRegularFileNoFollow(file, label, maxBytes = 16 * 1024) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size < 1 || before.size > maxBytes) {
      throw new CompanionError("E_WORKTREE", `Managed worker ${label} is unsafe.`);
    }
    const contents = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor);
    const pathStat = fs.lstatSync(file);
    if (
      pathStat.isSymbolicLink()
      || !pathStat.isFile()
      || fs.realpathSync(file) !== file
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || after.dev !== pathStat.dev
      || after.ino !== pathStat.ino
    ) {
      throw new CompanionError("E_WORKTREE", `Managed worker ${label} changed during validation.`);
    }
    return contents;
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    throw new CompanionError("E_WORKTREE", `Managed worker ${label} is unavailable.`);
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function worktreePorcelainInventory(controlRoot) {
  const raw = git(
    controlRoot,
    ["worktree", "list", "--porcelain", "-z"],
    { encoding: null }
  ).stdout || Buffer.alloc(0);
  const tokens = raw.toString("utf8").split("\0");
  const records = [];
  let fields = [];
  for (const token of tokens) {
    if (!token) {
      if (fields.length) {
        records.push(fields);
        fields = [];
      }
      continue;
    }
    fields.push(token);
  }
  if (fields.length) {
    throw new CompanionError("E_WORKTREE", "Git worktree inventory is truncated.");
  }
  return Object.freeze({
    raw,
    records: Object.freeze(records.map((record) => Object.freeze(record)))
  });
}

function worktreePorcelainRecords(controlRoot) {
  return worktreePorcelainInventory(controlRoot).records;
}

function exactDetachedWorktreeRecord(controlRoot, executionRoot, baseCommit) {
  const matching = worktreePorcelainRecords(controlRoot).filter((fields) => (
    fields.some((field) => field === `worktree ${executionRoot}`)
  ));
  if (matching.length !== 1) {
    throw new CompanionError(
      "E_WORKTREE",
      "Managed worker worktree is not registered with one exact Git identity."
    );
  }
  const fields = matching[0];
  const expected = new Set([
    `worktree ${executionRoot}`,
    `HEAD ${baseCommit}`,
    "detached"
  ]);
  if (fields.length !== expected.size || fields.some((field) => !expected.has(field))) {
    throw new CompanionError(
      "E_WORKTREE",
      "Managed worker worktree is not the exact detached base registration."
    );
  }
}

function canonicalizeInventoryPath(candidate, label) {
  let existingAncestor = candidate;
  const missingSuffix = [];
  while (true) {
    try {
      const canonicalAncestor = fs.realpathSync(existingAncestor);
      const canonical = path.join(canonicalAncestor, ...missingSuffix);
      if (!path.isAbsolute(canonical)
        || path.normalize(canonical) !== canonical) {
        throw new Error("resolved inventory path is not canonical");
      }
      return canonical;
    } catch (error) {
      if (error?.code === "ENOENT") {
        const parent = path.dirname(existingAncestor);
        if (parent !== existingAncestor) {
          missingSuffix.unshift(path.basename(existingAncestor));
          existingAncestor = parent;
          continue;
        }
      }
      throw new CompanionError(
        "E_WORKTREE",
        `${label} cannot be resolved through one stable existing ancestor.`,
        { classification: "inventory-ambiguous" }
      );
    }
  }
}

function exactWorktreeInventoryPaths(inventory) {
  return inventory.records.map((fields) => {
    const worktreeFields = fields.filter((field) => field.startsWith("worktree "));
    if (worktreeFields.length !== 1) {
      throw new CompanionError(
        "E_WORKTREE",
        "Git worktree inventory contains an ambiguous path record.",
        { classification: "inventory-ambiguous" }
      );
    }
    const candidate = worktreeFields[0].slice("worktree ".length);
    if (!path.isAbsolute(candidate)
      || path.normalize(candidate) !== candidate
      || candidate.includes("\0")) {
      throw new CompanionError(
        "E_WORKTREE",
        "Git worktree inventory contains a non-canonical path.",
        { classification: "inventory-ambiguous" }
      );
    }
    return canonicalizeInventoryPath(candidate, "Git worktree inventory path");
  });
}

function privateDirectoryObservation(directory, label) {
  let stat;
  try {
    stat = fs.lstatSync(directory, { bigint: true });
  } catch (error) {
    throw new CompanionError(
      "E_WORKTREE",
      `${label} is unavailable during worktree-effect reconciliation.`,
      { classification: error?.code === "ENOENT" ? "unsafe" : "inventory-ambiguous" }
    );
  }
  if (!stat.isDirectory()
    || stat.isSymbolicLink()
    || fs.realpathSync(directory) !== directory
    || (stat.mode & 0o077n) !== 0n
    || (typeof process.geteuid === "function"
      && stat.uid !== BigInt(process.geteuid()))) {
    throw new CompanionError(
      "E_WORKTREE",
      `${label} is aliased or not private during worktree-effect reconciliation.`,
      { classification: "unsafe" }
    );
  }
  return Object.freeze({
    identityDigest: sha(stableStringify({
      device: String(stat.dev),
      inode: String(stat.ino),
      mode: String(stat.mode),
      uid: String(stat.uid),
      gid: String(stat.gid),
      ctimeNs: String(stat.ctimeNs),
      mtimeNs: String(stat.mtimeNs)
    }))
  });
}

function assertPathAbsentNoFollow(candidate) {
  try {
    fs.lstatSync(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw new CompanionError(
      "E_WORKTREE",
      "Managed worker destination cannot be inspected safely.",
      { classification: "inventory-ambiguous" }
    );
  }
  throw new CompanionError(
    "E_WORKTREE",
    "Managed worker destination is occupied.",
    { classification: "occupied" }
  );
}

function adminBacklinkObservation(control, workerParent) {
  const adminRoot = path.join(control.gitCommonDir, "worktrees");
  let adminRootStat;
  try {
    adminRootStat = fs.lstatSync(adminRoot);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({
        inventoryDigest: sha("absent"),
        managedParentMatchCount: 0
      });
    }
    throw new CompanionError(
      "E_WORKTREE",
      "Git worktree administration inventory is unavailable.",
      { classification: "inventory-ambiguous" }
    );
  }
  if (!adminRootStat.isDirectory()
    || adminRootStat.isSymbolicLink()
    || fs.realpathSync(adminRoot) !== adminRoot) {
    throw new CompanionError(
      "E_WORKTREE",
      "Git worktree administration inventory is unsafe.",
      { classification: "inventory-ambiguous" }
    );
  }

  const records = [];
  let managedParentMatchCount = 0;
  const entries = fs.readdirSync(adminRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const adminDirectory = path.join(adminRoot, entry.name);
    if (!entry.isDirectory()
      || entry.isSymbolicLink()
      || fs.realpathSync(adminDirectory) !== adminDirectory) {
      throw new CompanionError(
        "E_WORKTREE",
        "Git worktree administration entry is unsafe.",
        { classification: "inventory-ambiguous" }
      );
    }
    const pointer = readSmallRegularFileNoFollow(
      path.join(adminDirectory, "gitdir"),
      "administration backlink"
    );
    const match = pointer.match(/^(.+)\n$/);
    const dotGit = match?.[1] || "";
    if (!path.isAbsolute(dotGit)
      || path.normalize(dotGit) !== dotGit
      || path.basename(dotGit) !== ".git") {
      throw new CompanionError(
        "E_WORKTREE",
        "Git worktree administration backlink is malformed.",
        { classification: "inventory-ambiguous" }
      );
    }
    const canonicalDotGit = canonicalizeInventoryPath(
      dotGit,
      "Git worktree administration backlink"
    );
    const worktreeRoot = path.dirname(canonicalDotGit);
    if (worktreeRoot === workerParent
      || worktreeRoot.startsWith(`${workerParent}${path.sep}`)) {
      managedParentMatchCount += 1;
    }
    records.push({
      entryDigest: sha(entry.name),
      backlinkDigest: sha(pointer),
      canonicalBacklinkDigest: sha(canonicalDotGit)
    });
  }
  return Object.freeze({
    inventoryDigest: sha(stableStringify(records)),
    managedParentMatchCount
  });
}

function absenceProofWithoutDigest(proof) {
  const { proofDigest: _proofDigest, ...body } = proof;
  return body;
}

function captureWorkerWorktreeAbsenceProof({
  control,
  executionRoot,
  baseCommit,
  workerId,
  env
}) {
  const managedRoot = path.dirname(
    expectedWorkerWorktreeParent(control.controlRoot, workerId, env)
  );
  const workerParent = expectedWorkerWorktreeParent(
    control.controlRoot,
    workerId,
    env
  );
  const capture = () => {
    const managedRootObservation = privateDirectoryObservation(
      managedRoot,
      "Managed worktree root"
    );
    let workerParentPresent = false;
    try {
      fs.lstatSync(workerParent);
      workerParentPresent = true;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new CompanionError(
          "E_WORKTREE",
          "Managed worker parent cannot be inspected safely.",
          { classification: "inventory-ambiguous" }
        );
      }
    }
    const parentObservation = workerParentPresent
      ? privateDirectoryObservation(workerParent, "Managed worker parent")
      : null;
    assertPathAbsentNoFollow(executionRoot);
    if (workerParentPresent && fs.readdirSync(workerParent).length !== 0) {
      throw new CompanionError(
        "E_WORKTREE",
        "Managed worker parent is not empty.",
        { classification: "occupied" }
      );
    }
    if (!workerParentPresent) assertPathAbsentNoFollow(workerParent);
    const inventory = worktreePorcelainInventory(control.controlRoot);
    const paths = exactWorktreeInventoryPaths(inventory);
    const exactRegistrationCount = paths.filter(
      (candidate) => candidate === executionRoot
    ).length;
    const managedParentRegistrationCount = paths.filter((candidate) => (
      candidate === workerParent
      || candidate.startsWith(`${workerParent}${path.sep}`)
    )).length;
    const admin = adminBacklinkObservation(control, workerParent);
    assertPathAbsentNoFollow(executionRoot);
    if (workerParentPresent && fs.readdirSync(workerParent).length !== 0) {
      throw new CompanionError(
        "E_WORKTREE",
        "Managed worker parent changed during absence verification.",
        { classification: "occupied" }
      );
    }
    if (!workerParentPresent) assertPathAbsentNoFollow(workerParent);
    if (exactRegistrationCount !== 0
      || managedParentRegistrationCount !== 0
      || admin.managedParentMatchCount !== 0) {
      throw new CompanionError(
        "E_WORKTREE",
        "A stale or foreign worktree registration still names the managed worker parent.",
        { classification: "stale-registration" }
      );
    }
    return Object.freeze({
      managedRootIdentityDigest: managedRootObservation.identityDigest,
      workerParentIdentityDigest: parentObservation?.identityDigest || null,
      workerParentState: workerParentPresent ? "private-empty" : "absent",
      rawInventoryDigest: sha(inventory.raw),
      adminInventoryDigest: admin.inventoryDigest,
      exactRegistrationCount,
      managedParentRegistrationCount,
      adminBacklinkMatchCount: admin.managedParentMatchCount
    });
  };

  const first = capture();
  const second = capture();
  if (stableStringify(first) !== stableStringify(second)) {
    throw new CompanionError(
      "E_WORKTREE",
      "Worktree absence evidence changed during verification.",
      { classification: "inventory-ambiguous" }
    );
  }
  const proof = {
    schemaVersion: 1,
    classification: "absent",
    workerId,
    controlWorkspaceId: control.controlWorkspaceId,
    controlRootDigest: sha(control.controlRoot),
    gitCommonDirDigest: sha(control.gitCommonDir),
    expectedExecutionRootDigest: sha(executionRoot),
    expectedWorkerParentDigest: sha(workerParent),
    baseCommitDigest: sha(baseCommit),
    filesystemPathState: "absent",
    workerParentState: second.workerParentState,
    ...second,
    observedAt: new Date().toISOString(),
    proofDigest: null
  };
  proof.proofDigest = sha(stableStringify(absenceProofWithoutDigest(proof)));
  return Object.freeze(proof);
}

function assertLinkedWorktreeMetadata(control, executionRoot) {
  const dotGit = path.join(executionRoot, ".git");
  const pointer = readSmallRegularFileNoFollow(dotGit, "Git pointer");
  const match = pointer.match(/^gitdir: (.+)\r?\n$/);
  if (!match || !path.isAbsolute(match[1]) || path.normalize(match[1]) !== match[1]) {
    throw new CompanionError("E_WORKTREE", "Managed worker Git pointer is malformed.");
  }
  let adminDirectory;
  try {
    adminDirectory = fs.realpathSync(match[1]);
  } catch {
    throw new CompanionError("E_WORKTREE", "Managed worker Git directory is unavailable.");
  }
  const adminStat = fs.lstatSync(adminDirectory);
  const expectedAdminParent = path.join(control.gitCommonDir, "worktrees");
  if (
    adminDirectory !== match[1]
    || !adminStat.isDirectory()
    || adminStat.isSymbolicLink()
    || path.dirname(adminDirectory) !== expectedAdminParent
  ) {
    throw new CompanionError("E_WORKTREE", "Managed worker Git directory is not broker-owned.");
  }
  const observedAdmin = String(
    git(executionRoot, ["rev-parse", "--path-format=absolute", "--absolute-git-dir"]).stdout || ""
  ).trim();
  if (observedAdmin !== adminDirectory) {
    throw new CompanionError("E_WORKTREE", "Managed worker Git directory identity changed.");
  }
  const backlink = readSmallRegularFileNoFollow(
    path.join(adminDirectory, "gitdir"),
    "Git backlink"
  );
  if (backlink !== `${dotGit}\n`) {
    throw new CompanionError("E_WORKTREE", "Managed worker Git backlink does not match its root.");
  }
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

  const exactBaseCommit = resolveExactCommit(control.controlRoot, baseCommit);
  const workerParent = expectedWorkerWorktreeParent(control.controlRoot, workerId, env);
  const executionRoot = expectedWorkerWorktreeRoot(control.controlRoot, workerId, env);
  if (fs.existsSync(workerParent)) {
    throw new CompanionError("E_WORKTREE", `Worktree path already exists for ${workerId}.`);
  }
  fs.mkdirSync(workerParent, { mode: 0o700 });
  safePrivateDirectory(workerParent, "worker worktree parent");

  try {
    git(control.controlRoot, ["worktree", "add", "--detach", executionRoot, exactBaseCommit]);
  } catch (error) {
    fs.rmdirSync(workerParent);
    throw error;
  }
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
    fs.rmdirSync(workerParent);
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

/**
 * Validate an already-created managed worktree for exact crash adoption.
 * No path is accepted unless it is the deterministic path for workerId, a
 * registered worktree of the expected common directory, and still points at
 * the exact detached base commit with no local changes.
 */
export function assertRegisteredWorkerWorktreeIdentity({
  controlRoot,
  executionRoot,
  baseCommit,
  workerId,
  env = process.env
} = {}) {
  if (!controlRoot || !executionRoot || !baseCommit || !workerId) {
    throw new CompanionError(
      "E_USAGE",
      "controlRoot, executionRoot, baseCommit, and workerId are required."
    );
  }
  const control = resolveControlWorkspace(controlRoot, env);
  const expectedRoot = expectedWorkerWorktreeRoot(control.controlRoot, workerId, env);
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseCommit)) {
    throw new CompanionError(
      "E_WORKTREE",
      "Managed worker base must be one persisted exact lowercase object ID."
    );
  }
  let canonicalRoot;
  try {
    canonicalRoot = fs.realpathSync(executionRoot);
  } catch {
    throw new CompanionError("E_WORKTREE", "Managed worker worktree is unavailable.");
  }
  if (executionRoot !== canonicalRoot || canonicalRoot !== expectedRoot) {
    throw new CompanionError(
      "E_WORKTREE",
      "Managed worker worktree path does not match its exact worker identity."
    );
  }
  if (!listedWorktreeRoots(control.controlRoot).includes(canonicalRoot)) {
    throw new CompanionError("E_WORKTREE", "Managed worker worktree is not registered with Git.");
  }
  const exactBaseCommit = resolveExactCommit(control.controlRoot, baseCommit);
  const actualHead = resolveExactCommit(canonicalRoot, "HEAD");
  if (exactBaseCommit !== baseCommit
    || actualHead !== exactBaseCommit
    || gitCommonDir(canonicalRoot) !== control.gitCommonDir) {
    throw new CompanionError(
      "E_WORKTREE",
      "Managed worker worktree no longer matches its exact base or control repository."
    );
  }
  exactDetachedWorktreeRecord(control.controlRoot, canonicalRoot, exactBaseCommit);
  assertLinkedWorktreeMetadata(control, canonicalRoot);
  return Object.freeze({
    controlWorkspaceId: control.controlWorkspaceId,
    controlRoot: control.controlRoot,
    executionRoot: canonicalRoot,
    baseCommit: exactBaseCommit,
    branch: null,
    detached: true,
    gitCommonDir: control.gitCommonDir
  });
}

export function assertManagedWorkerWorktree(options = {}) {
  const identity = assertRegisteredWorkerWorktreeIdentity(options);
  const fingerprint = captureParentFingerprint(identity.executionRoot);
  if (!fingerprint.clean || fingerprint.head !== identity.baseCommit) {
    throw new CompanionError(
      "E_WORKTREE",
      "A provisioning worktree is not clean at its exact base and cannot be adopted."
    );
  }
  // Repeat the symlink preflight used by createWorkerWorktree so an interrupted
  // provision cannot be adopted after its base contents were path-swapped.
  captureWithStableVisibleIndex(identity.executionRoot, () => (
    captureWorktreeEntries(identity.executionRoot, { rejectEscapingSymlink: true })
  ));
  return identity;
}

/**
 * Observe one deterministic worker destination without mutating Git or the
 * filesystem. Only the exact `absent` result is sufficient to authorize a
 * provisioning reissue; every other result remains fail-closed.
 */
export function classifyWorkerWorktreeEffect({
  controlRoot,
  executionRoot,
  baseCommit,
  workerId,
  env = process.env
} = {}) {
  if (!controlRoot || !executionRoot || !baseCommit || !workerId) {
    throw new CompanionError(
      "E_USAGE",
      "Worktree-effect classification requires control, execution, base, and worker identities."
    );
  }
  const control = resolveControlWorkspace(controlRoot, env);
  const expectedRoot = expectedWorkerWorktreeRoot(
    control.controlRoot,
    workerId,
    env
  );
  if (executionRoot !== expectedRoot
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseCommit)) {
    throw new CompanionError(
      "E_WORKTREE",
      "Worktree-effect classification is not bound to the deterministic exact base.",
      { classification: "foreign" }
    );
  }
  let exactBaseCommit;
  try {
    exactBaseCommit = resolveExactCommit(control.controlRoot, baseCommit);
  } catch {
    throw new CompanionError(
      "E_WORKTREE",
      "Worktree-effect classification base is not one existing exact commit.",
      { classification: "foreign" }
    );
  }
  if (exactBaseCommit !== baseCommit) {
    throw new CompanionError(
      "E_WORKTREE",
      "Worktree-effect classification base is not one canonical exact commit.",
      { classification: "foreign" }
    );
  }

  try {
    const identity = assertManagedWorkerWorktree({
      controlRoot: control.controlRoot,
      executionRoot,
      baseCommit,
      workerId,
      env
    });
    return Object.freeze({
      classification: "exact-clean-registered",
      evidence: identity
    });
  } catch {
    // Positive adoption failed. Inspect the raw path and registration state
    // rather than treating a positive-proof failure as absence.
  }

  let rootPresent = false;
  try {
    fs.lstatSync(executionRoot);
    rootPresent = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return Object.freeze({
        classification: "inventory-ambiguous",
        evidence: null
      });
    }
  }

  let inventory;
  let paths;
  try {
    inventory = worktreePorcelainInventory(control.controlRoot);
    paths = exactWorktreeInventoryPaths(inventory);
  } catch {
    return Object.freeze({
      classification: "inventory-ambiguous",
      evidence: null
    });
  }
  const workerParent = expectedWorkerWorktreeParent(
    control.controlRoot,
    workerId,
    env
  );
  const targetRegistrationCount = paths.filter(
    (candidate) => candidate === executionRoot
  ).length;
  const managedParentRegistrationCount = paths.filter((candidate) => (
    candidate === workerParent
    || candidate.startsWith(`${workerParent}${path.sep}`)
  )).length;

  if (rootPresent) {
    if (targetRegistrationCount === 1) {
      try {
        assertRegisteredWorkerWorktreeIdentity({
          controlRoot: control.controlRoot,
          executionRoot,
          baseCommit,
          workerId,
          env
        });
        return Object.freeze({
          classification: "dirty",
          evidence: null
        });
      } catch {
        return Object.freeze({
          classification: "mismatched",
          evidence: null
        });
      }
    }
    return Object.freeze({
      classification: targetRegistrationCount > 0 ? "mismatched" : "occupied",
      evidence: null
    });
  }
  if (targetRegistrationCount > 0 || managedParentRegistrationCount > 0) {
    return Object.freeze({
      classification: "stale-registration",
      evidence: null
    });
  }

  try {
    return Object.freeze({
      classification: "absent",
      evidence: captureWorkerWorktreeAbsenceProof({
        control,
        executionRoot,
        baseCommit: exactBaseCommit,
        workerId,
        env
      })
    });
  } catch (error) {
    return Object.freeze({
      classification: error?.details?.classification || "inventory-ambiguous",
      evidence: null
    });
  }
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
    const patch = git(canonicalExecutionRoot, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      "--full-index",
      exactBaseCommit,
      "--"
    ]).stdout || "";
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
  const expectedExecutionRoot = expectedWorkerWorktreeRoot(
    control.controlRoot,
    expectedWorkerId,
    env
  );
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

function sameScope(left, right) {
  return stableStringify(left ?? null) === stableStringify(right ?? null);
}

function strictUtf8(buffer, label) {
  if (!Buffer.isBuffer(buffer)
    || buffer.length < 1
    || buffer.length > WRITE_ARTIFACT_MAX_CONTENT_BYTES
    || buffer.includes(0)) {
    throw new CompanionError(
      "E_SCOPE_VIOLATION",
      `Write vertical ${label} must be bounded, non-empty UTF-8 text without NUL bytes.`
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new CompanionError(
      "E_SCOPE_VIOLATION",
      `Write vertical ${label} must be bounded, non-empty UTF-8 text without NUL bytes.`
    );
  }
}

function readBoundedWriteTargetNoFollow(file, label) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()
      || (before.mode & 0o7777) !== 0o644
      || before.size < 1
      || before.size > WRITE_ARTIFACT_MAX_CONTENT_BYTES) {
      throw new CompanionError(
        "E_SCOPE_VIOLATION",
        `Write vertical ${label} must be one bounded regular 100644 file.`
      );
    }
    const buffer = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const pathStat = fs.lstatSync(file);
    if (pathStat.isSymbolicLink()
      || !pathStat.isFile()
      || fs.realpathSync(file) !== file
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || after.dev !== pathStat.dev
      || after.ino !== pathStat.ino) {
      throw new CompanionError(
        "E_SCOPE_VIOLATION",
        `Write vertical ${label} changed during capture.`
      );
    }
    return Object.freeze({
      buffer,
      text: strictUtf8(buffer, label),
      stat: after
    });
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    throw new CompanionError(
      "E_SCOPE_VIOLATION",
      `Write vertical ${label} is unavailable or unsafe.`
    );
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function exactFieldSet(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length
    && actual.every((field, index) => field === expected[index]);
}

/**
 * Fail closed unless scope is exactly the first-vertical one-file contract.
 */
export function assertExactWriteVerticalScope(scope) {
  if (!sameScope(scope, EXACT_WRITE_VERTICAL_SCOPE)) {
    throw new CompanionError(
      "E_SCOPE_VIOLATION",
      "P3-P4 write vertical permits only exact include:[target.txt] with empty exclude."
    );
  }
  return EXACT_WRITE_VERTICAL_SCOPE;
}

function readExactBaseTarget(root, baseCommit) {
  const exactBaseCommit = resolveExactCommit(root, baseCommit);
  const listed = git(
    root,
    ["ls-tree", "-z", exactBaseCommit, "--", WRITE_VERTICAL_TARGET_PATH],
    { encoding: null }
  ).stdout || Buffer.alloc(0);
  const header = listed.toString("utf8");
  const match = header.match(
    /^100644 blob ([a-f0-9]{40}|[a-f0-9]{64})\ttarget\.txt\0$/
  );
  if (!match) {
    throw new CompanionError(
      "E_SCOPE_VIOLATION",
      "Write vertical base must contain one ordinary 100644 target.txt blob."
    );
  }
  const sizeRun = git(root, ["cat-file", "-s", match[1]]);
  const size = Number(String(sizeRun.stdout || "").trim());
  if (!Number.isSafeInteger(size) || size < 1 || size > WRITE_ARTIFACT_MAX_CONTENT_BYTES) {
    throw new CompanionError(
      "E_SCOPE_VIOLATION",
      "Write vertical base target.txt exceeds the bounded text contract."
    );
  }
  const content = git(
    root,
    ["show", `${exactBaseCommit}:${WRITE_VERTICAL_TARGET_PATH}`],
    { encoding: null }
  ).stdout || Buffer.alloc(0);
  strictUtf8(content, "base target.txt");
  if (content.length !== size) {
    throw new CompanionError("E_INTEGRATION", "Write vertical base target changed during capture.");
  }
  return Object.freeze({
    baseCommit: exactBaseCommit,
    contentDigest: sha(content),
    size
  });
}

/**
 * Require one existing tracked regular non-symlink text file named target.txt
 * at the control checkout before write admission/dispatch.
 */
export function assertTrackedWriteVerticalTarget(controlRoot) {
  if (!controlRoot) {
    throw new CompanionError("E_USAGE", "controlRoot is required for write-vertical target validation.");
  }
  const root = fs.realpathSync(controlRoot);
  const absolute = path.join(root, WRITE_VERTICAL_TARGET_PATH);
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    throw new CompanionError(
      "E_SCOPE_VIOLATION",
      "Write vertical requires an existing tracked target.txt path."
    );
  }
  if (stat.isSymbolicLink()
    || !stat.isFile()
    || (stat.mode & 0o7777) !== 0o644
    || stat.size < 1
    || stat.size > WRITE_ARTIFACT_MAX_CONTENT_BYTES) {
    throw new CompanionError(
      "E_SCOPE_VIOLATION",
      "Write vertical target.txt must be one bounded regular non-symlink 100644 file."
    );
  }
  const index = git(
    root,
    ["ls-files", "-s", "-z", "--", WRITE_VERTICAL_TARGET_PATH],
    { encoding: null }
  ).stdout || Buffer.alloc(0);
  const match = index.toString("utf8").match(
    /^100644 ([a-f0-9]{40}|[a-f0-9]{64}) 0\ttarget\.txt\0$/
  );
  if (!match) {
    throw new CompanionError(
      "E_SCOPE_VIOLATION",
      "Write vertical target.txt must be one ordinary stage-0 100644 text blob."
    );
  }
  const content = readBoundedWriteTargetNoFollow(
    absolute,
    "control target.txt"
  ).buffer;
  return Object.freeze({
    path: WRITE_VERTICAL_TARGET_PATH,
    mode: 0o100644,
    size: content.length,
    contentDigest: sha(content),
    indexObjectId: match[1]
  });
}

function assertExactTargetTxtArtifactManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== ARTIFACT_MANIFEST_VERSION) {
    throw new CompanionError("E_INTEGRATION", "Invalid write-vertical artifact manifest.");
  }
  assertExactWriteVerticalScope(manifest.scope);
  if (manifest.resultHead !== manifest.baseCommit
    || !Array.isArray(manifest.changedPaths)
    || manifest.changedPaths.length !== 1) {
    throw new CompanionError(
      "E_SCOPE_VIOLATION",
      "Write vertical artifact must remain at its base and change exactly one path."
    );
  }
  const entry = manifest.changedPaths[0];
  if (!exactFieldSet(entry, ["status", "path", "identity"])
    || entry.path !== WRITE_VERTICAL_TARGET_PATH
    || entry.status !== "M"
    || !exactFieldSet(entry.identity, ["kind", "mode", "size", "contentDigest"])
    || entry.identity.kind !== "file"
    || entry.identity.mode !== 0o644
    || !Number.isSafeInteger(entry.identity.size)
    || entry.identity.size < 1
    || entry.identity.size > WRITE_ARTIFACT_MAX_CONTENT_BYTES
    || !/^[a-f0-9]{64}$/.test(entry.identity.contentDigest || "")) {
    throw new CompanionError(
      "E_SCOPE_VIOLATION",
      "Write vertical artifact must be one bounded ordinary target.txt content edit."
    );
  }
  return entry;
}

function assertOnlyTargetChanged(executionRoot, baseCommit) {
  const changed = git(
    executionRoot,
    ["diff", "--name-status", "-z", "--no-renames", baseCommit, "--"],
    { encoding: null }
  ).stdout || Buffer.alloc(0);
  if (!changed.equals(Buffer.from(`M\0${WRITE_VERTICAL_TARGET_PATH}\0`))) {
    throw new CompanionError(
      "E_SCOPE_VIOLATION",
      "Write vertical result must be exactly one target.txt modification."
    );
  }
  for (const args of [
    ["ls-files", "--others", "--exclude-standard", "-z"],
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]
  ]) {
    const untracked = git(executionRoot, args, { encoding: null }).stdout || Buffer.alloc(0);
    if (untracked.length !== 0) {
      throw new CompanionError(
        "E_SCOPE_VIOLATION",
        "Write vertical result contains an extra untracked or ignored path."
      );
    }
  }
}

function currentOwner() {
  return typeof process.geteuid === "function" ? process.geteuid() : null;
}

function assertPrivateOwnedDirectory(directory, label) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    throw new CompanionError("E_STATE", `Write artifact ${label} is unavailable.`);
  }
  const owner = currentOwner();
  if (!stat.isDirectory()
    || stat.isSymbolicLink()
    || fs.realpathSync(directory) !== directory
    || (stat.mode & 0o777) !== 0o700
    || (owner !== null && stat.uid !== owner)) {
    throw new CompanionError("E_STATE", `Write artifact ${label} is unsafe.`);
  }
  return directory;
}

function createPrivateOwnedDirectory(directory, label) {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    fsyncDirectory(path.dirname(directory));
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return assertPrivateOwnedDirectory(directory, label);
}

function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function artifactDirectoryForWrite(controlRoot, workerId, env) {
  const control = resolveControlWorkspace(controlRoot, env);
  const state = controlStateDir(control, env);
  const pluginData = fs.realpathSync(pluginDataRoot(env));
  const stateParent = path.join(pluginData, "state");
  assertPrivateOwnedDirectory(pluginData, "plugin data root");
  assertPrivateOwnedDirectory(stateParent, "state parent");
  if (state !== path.join(stateParent, controlStateSegment(control.controlWorkspaceId))) {
    throw new CompanionError("E_STATE", "Write artifact control state root is unsafe.");
  }
  assertPrivateOwnedDirectory(state, "control state root");
  const artifacts = createPrivateOwnedDirectory(
    path.join(state, "artifacts"),
    "directory"
  );
  const workerDirectory = createPrivateOwnedDirectory(
    path.join(artifacts, workerWorktreeSlug(workerId)),
    "worker directory"
  );
  return Object.freeze({ control, workerDirectory });
}

function artifactDirectoryForRead(controlRoot, workerId, env) {
  const control = resolveControlWorkspace(controlRoot, env);
  const configured = pluginDataRoot(env);
  let pluginData;
  try {
    pluginData = fs.realpathSync(configured);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new CompanionError("E_STATE", "Write artifact private root is unsafe.");
  }
  // System ancestors such as macOS /var may themselves be symlinks. Bind all
  // later paths to the canonical final plugin-data directory and validate the
  // artifact-owned descendants individually rather than rejecting a safe
  // canonicalization of an ancestor.
  assertPrivateOwnedDirectory(pluginData, "plugin data root");
  const stateParent = path.join(pluginData, "state");
  const state = path.join(
    stateParent,
    controlStateSegment(control.controlWorkspaceId)
  );
  const artifacts = path.join(state, "artifacts");
  const workerDirectory = path.join(artifacts, workerWorktreeSlug(workerId));
  for (const [directory, label] of [
    [stateParent, "state parent"],
    [state, "control state root"],
    [artifacts, "directory"],
    [workerDirectory, "worker directory"]
  ]) {
    try {
      assertPrivateOwnedDirectory(directory, label);
    } catch (error) {
      if (error?.code === "E_STATE") {
        try {
          fs.lstatSync(directory);
        } catch (pathError) {
          if (pathError?.code === "ENOENT") return null;
        }
      }
      throw error;
    }
  }
  return Object.freeze({ control, workerDirectory });
}

function recordWithoutDigest(record) {
  const { recordDigest: _recordDigest, ...unsigned } = record;
  return unsigned;
}

const WRITE_ARTIFACT_RECORD_FIELDS = Object.freeze([
  "schemaVersion",
  "artifactDigest",
  "workerId",
  "controlWorkspaceId",
  "path",
  "baseCommit",
  "baseContentDigest",
  "manifestDigest",
  "securityDigest",
  "patchDigest",
  "contentDigest",
  "patchBytes",
  "contentBytes",
  "createdAt",
  "manifest",
  "patch",
  "content",
  "recordDigest"
]);

function readPrivateArtifactRecord(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const before = fs.fstatSync(descriptor);
    const owner = currentOwner();
    if (!before.isFile()
      || before.size < 1
      || before.size > WRITE_ARTIFACT_MAX_RECORD_BYTES
      || (before.mode & 0o777) !== 0o600
      || (owner !== null && before.uid !== owner)) {
      throw new CompanionError("E_STATE", "Stored write artifact record is unsafe.");
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const pathStat = fs.lstatSync(file);
    if (pathStat.isSymbolicLink()
      || !pathStat.isFile()
      || fs.realpathSync(file) !== file
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || after.dev !== pathStat.dev
      || after.ino !== pathStat.ino) {
      throw new CompanionError("E_STATE", "Stored write artifact changed during retrieval.");
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new CompanionError("E_INTEGRATION", "Stored write artifact record is corrupt.");
    }
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    throw new CompanionError("E_STATE", "Stored write artifact record is unavailable.");
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function validateStoredWriteArtifact(record, {
  controlRoot,
  expectedWorkerId,
  expectedControlWorkspaceId,
  expectedManifestDigest = null
}) {
  if (!exactFieldSet(record, WRITE_ARTIFACT_RECORD_FIELDS)
    || record.schemaVersion !== WRITE_ARTIFACT_RECORD_SCHEMA_VERSION
    || record.artifactDigest !== record.securityDigest
    || record.workerId !== expectedWorkerId
    || record.controlWorkspaceId !== expectedControlWorkspaceId
    || record.path !== WRITE_VERTICAL_TARGET_PATH
    || !/^[a-f0-9]{40,64}$/.test(String(record.baseCommit || ""))
    || !/^[a-f0-9]{64}$/.test(String(record.baseContentDigest || ""))
    || !/^[a-f0-9]{64}$/.test(String(record.manifestDigest || ""))
    || !/^[a-f0-9]{64}$/.test(String(record.securityDigest || ""))
    || !/^[a-f0-9]{64}$/.test(String(record.patchDigest || ""))
    || !/^[a-f0-9]{64}$/.test(String(record.contentDigest || ""))
    || !Number.isSafeInteger(record.patchBytes)
    || record.patchBytes < 1
    || record.patchBytes > WRITE_ARTIFACT_MAX_PATCH_BYTES
    || !Number.isSafeInteger(record.contentBytes)
    || record.contentBytes < 1
    || record.contentBytes > WRITE_ARTIFACT_MAX_CONTENT_BYTES
    || record.createdAt !== record.manifest?.createdAt
    || typeof record.patch !== "string"
    || typeof record.content !== "string"
    || record.recordDigest !== sha(stableStringify(recordWithoutDigest(record)))) {
    throw new CompanionError("E_INTEGRATION", "Stored write artifact record is malformed or tampered.");
  }
  if (expectedManifestDigest && record.manifestDigest !== expectedManifestDigest) {
    throw new CompanionError("E_INTEGRATION", "Write artifact digest does not match the job result.");
  }
  validateArtifactForIntegration(record.manifest, {
    expectedBaseCommit: record.baseCommit,
    expectedControlWorkspaceId,
    expectedWorkerId,
    expectedScope: EXACT_WRITE_VERTICAL_SCOPE,
    expectedLineage: null,
    expectedControlRoot: controlRoot
  });
  const entry = assertExactTargetTxtArtifactManifest(record.manifest);
  const patch = Buffer.from(record.patch, "utf8");
  const content = Buffer.from(record.content, "utf8");
  strictUtf8(content, "stored target.txt");
  const patchHeader = `diff --git a/${WRITE_VERTICAL_TARGET_PATH} b/${WRITE_VERTICAL_TARGET_PATH}\n`;
  if (record.manifestDigest !== record.manifest.manifestDigest
    || record.securityDigest !== record.manifest.securityDigest
    || record.patchDigest !== record.manifest.patchDigest
    || record.contentDigest !== entry.identity.contentDigest
    || record.patchBytes !== patch.length
    || record.contentBytes !== content.length
    || sha(patch) !== record.patchDigest
    || sha(content) !== record.contentDigest
    || !record.patch.startsWith(patchHeader)
    || record.patch.indexOf("\ndiff --git ", patchHeader.length) !== -1
    || !record.patch.includes(`\n--- a/${WRITE_VERTICAL_TARGET_PATH}\n+++ b/${WRITE_VERTICAL_TARGET_PATH}\n`)
    || record.patch.includes("GIT binary patch")
    || record.patch.includes("Binary files ")
    || record.patch.includes("\nold mode ")
    || record.patch.includes("\nnew mode ")) {
    throw new CompanionError("E_INTEGRATION", "Stored write artifact bytes disagree with their digests or contract.");
  }
  const base = readExactBaseTarget(controlRoot, record.baseCommit);
  if (base.contentDigest !== record.baseContentDigest) {
    throw new CompanionError("E_INTEGRATION", "Stored write artifact base content identity drifted.");
  }
  return Object.freeze({
    record: Object.freeze(record),
    manifest: Object.freeze(record.manifest),
    patch: record.patch,
    content: record.content
  });
}

function sameArtifactGeneration(existing, proposed) {
  return existing.artifactDigest === proposed.artifactDigest
    && existing.workerId === proposed.workerId
    && existing.controlWorkspaceId === proposed.controlWorkspaceId
    && existing.baseCommit === proposed.baseCommit
    && existing.baseContentDigest === proposed.baseContentDigest
    && existing.patchDigest === proposed.patchDigest
    && existing.contentDigest === proposed.contentDigest
    && existing.patch === proposed.patch
    && existing.content === proposed.content;
}

function artifactDirectoryEntries(directory) {
  const entries = fs.readdirSync(directory);
  if (entries.length > WRITE_ARTIFACT_MAX_DIRECTORY_ENTRIES) {
    throw new CompanionError("E_STATE", "Write artifact directory exceeds its bounded inventory.");
  }
  return entries;
}

function atomicPublishArtifactRecord(file, temporary, record) {
  const serialized = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > WRITE_ARTIFACT_MAX_RECORD_BYTES) {
    throw new CompanionError("E_SCOPE_VIOLATION", "Write artifact record exceeds its bounded contract.");
  }
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, serialized);
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, file);
    fsyncDirectory(path.dirname(file));
  } catch (error) {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

/**
 * Persist one content-addressed target.txt artifact after terminal provider
 * success. One fsynced JSON record is the complete retrieval authority.
 */
export function persistWriteWorkerArtifact({
  workerId,
  controlWorkspaceId,
  controlRoot,
  executionRoot,
  baseCommit,
  env = process.env
} = {}) {
  if (!workerId || !controlWorkspaceId || !controlRoot || !executionRoot || !baseCommit) {
    throw new CompanionError(
      "E_USAGE",
      "persistWriteWorkerArtifact requires worker, control, execution, and base identities."
    );
  }
  const control = resolveControlWorkspace(controlRoot, env);
  if (control.controlWorkspaceId !== controlWorkspaceId
    || typeof workerId !== "string"
    || workerId.length > 128) {
    throw new CompanionError("E_INTEGRATION", "Write artifact control or worker identity is invalid.");
  }
  assertTrackedWriteVerticalTarget(control.controlRoot);
  const identity = assertRegisteredWorkerWorktreeIdentity({
    controlRoot: control.controlRoot,
    executionRoot,
    baseCommit,
    workerId,
    env
  });
  const base = readExactBaseTarget(identity.executionRoot, identity.baseCommit);
  assertOnlyTargetChanged(identity.executionRoot, identity.baseCommit);
  const resultPath = path.join(identity.executionRoot, WRITE_VERTICAL_TARGET_PATH);
  const capturedContent = readBoundedWriteTargetNoFollow(
    resultPath,
    "result target.txt"
  );
  const contentBuffer = capturedContent.buffer;
  const content = capturedContent.text;
  const patchBuffer = git(
    identity.executionRoot,
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      "--full-index",
      identity.baseCommit,
      "--"
    ],
    { encoding: null }
  ).stdout || Buffer.alloc(0);
  if (patchBuffer.length < 1 || patchBuffer.length > WRITE_ARTIFACT_MAX_PATCH_BYTES) {
    throw new CompanionError("E_SCOPE_VIOLATION", "Write vertical patch exceeds its bounded contract.");
  }
  let patch;
  try {
    patch = new TextDecoder("utf-8", { fatal: true }).decode(patchBuffer);
  } catch {
    throw new CompanionError("E_SCOPE_VIOLATION", "Write vertical patch is not strict UTF-8 text.");
  }
  const manifest = buildArtifactManifest({
    workerId,
    controlWorkspaceId,
    controlRoot: control.controlRoot,
    executionRoot: identity.executionRoot,
    baseCommit: identity.baseCommit,
    scope: EXACT_WRITE_VERTICAL_SCOPE,
    lineage: null
  });
  const entry = assertExactTargetTxtArtifactManifest(manifest);
  if (manifest.patchDigest !== sha(patchBuffer)
    || entry.identity.size !== contentBuffer.length
    || entry.identity.contentDigest !== sha(contentBuffer)) {
    throw new CompanionError("E_INTEGRATION", "Write artifact recomputation disagrees with captured bytes.");
  }
  validateArtifactForIntegration(manifest, {
    expectedBaseCommit: identity.baseCommit,
    expectedControlWorkspaceId: controlWorkspaceId,
    expectedWorkerId: workerId,
    expectedScope: EXACT_WRITE_VERTICAL_SCOPE,
    expectedLineage: null,
    expectedControlRoot: control.controlRoot,
    expectedExecutionRoot: identity.executionRoot,
    recomputeFromExecutionRoot: {
      controlRoot: control.controlRoot,
      executionRoot: identity.executionRoot
    }
  });
  const unsignedRecord = {
    schemaVersion: WRITE_ARTIFACT_RECORD_SCHEMA_VERSION,
    artifactDigest: manifest.securityDigest,
    workerId,
    controlWorkspaceId,
    path: WRITE_VERTICAL_TARGET_PATH,
    baseCommit: identity.baseCommit,
    baseContentDigest: base.contentDigest,
    manifestDigest: manifest.manifestDigest,
    securityDigest: manifest.securityDigest,
    patchDigest: manifest.patchDigest,
    contentDigest: entry.identity.contentDigest,
    patchBytes: patchBuffer.length,
    contentBytes: contentBuffer.length,
    createdAt: manifest.createdAt,
    manifest,
    patch,
    content
  };
  const record = Object.freeze({
    ...unsignedRecord,
    recordDigest: sha(stableStringify(unsignedRecord))
  });
  validateStoredWriteArtifact(record, {
    controlRoot: control.controlRoot,
    expectedWorkerId: workerId,
    expectedControlWorkspaceId: controlWorkspaceId,
    expectedManifestDigest: manifest.manifestDigest
  });
  const { workerDirectory } = artifactDirectoryForWrite(
    control.controlRoot,
    workerId,
    env
  );
  const recordName = `${record.artifactDigest}.json`;
  const temporaryName = `.${record.artifactDigest}.publish.tmp`;
  const recordPath = path.join(workerDirectory, recordName);
  const temporaryPath = path.join(workerDirectory, temporaryName);
  const entries = artifactDirectoryEntries(workerDirectory);
  const unexpected = entries.filter((name) => name !== recordName && name !== temporaryName);
  if (unexpected.length || (entries.includes(recordName) && entries.includes(temporaryName))) {
    throw new CompanionError("E_STATE", "Write artifact directory contains an ambiguous publication.");
  }
  for (const candidate of [recordPath, temporaryPath]) {
    if (!fs.existsSync(candidate)) continue;
    const existing = readPrivateArtifactRecord(candidate);
    const validated = validateStoredWriteArtifact(existing, {
      controlRoot: control.controlRoot,
      expectedWorkerId: workerId,
      expectedControlWorkspaceId: controlWorkspaceId
    });
    if (!sameArtifactGeneration(existing, record)) {
      throw new CompanionError("E_STATE", "Write artifact identity was reused for different bytes.");
    }
    if (candidate === temporaryPath) {
      fs.renameSync(temporaryPath, recordPath);
      fsyncDirectory(workerDirectory);
    }
    return Object.freeze({ ...validated, replayed: true });
  }
  atomicPublishArtifactRecord(recordPath, temporaryPath, record);
  const validated = validateStoredWriteArtifact(
    readPrivateArtifactRecord(recordPath),
    {
      controlRoot: control.controlRoot,
      expectedWorkerId: workerId,
      expectedControlWorkspaceId: controlWorkspaceId,
      expectedManifestDigest: record.manifestDigest
    }
  );
  return Object.freeze({ ...validated, replayed: false });
}

/** Read a previously published one-file write-vertical artifact without writes. */
export function readWriteWorkerArtifact({
  controlRoot,
  workerId,
  env = process.env,
  expectedManifestDigest = null
} = {}) {
  if (!controlRoot || !workerId) {
    throw new CompanionError("E_USAGE", "controlRoot and workerId are required for artifact retrieval.");
  }
  const resolved = artifactDirectoryForRead(controlRoot, workerId, env);
  if (!resolved) {
    throw new CompanionError("E_JOB_ACTIVE", "Write artifact is not available yet.");
  }
  const entries = artifactDirectoryEntries(resolved.workerDirectory);
  if (entries.length === 0) {
    throw new CompanionError("E_JOB_ACTIVE", "Write artifact is not available yet.");
  }
  if (entries.some((name) => name.endsWith(".tmp"))) {
    throw new CompanionError("E_INTEGRATION", "Write artifact publication is incomplete.");
  }
  const records = entries.filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
  if (records.length !== 1 || records.length !== entries.length) {
    throw new CompanionError("E_STATE", "Write artifact directory does not contain one canonical record.");
  }
  const recordPath = path.join(resolved.workerDirectory, records[0]);
  const record = readPrivateArtifactRecord(recordPath);
  if (`${record.artifactDigest}.json` !== records[0]) {
    throw new CompanionError("E_INTEGRATION", "Write artifact filename does not match its content identity.");
  }
  return validateStoredWriteArtifact(record, {
    controlRoot: resolved.control.controlRoot,
    expectedWorkerId: workerId,
    expectedControlWorkspaceId: resolved.control.controlWorkspaceId,
    expectedManifestDigest
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
  const expectedExecutionRoot = expectedWorkerWorktreeRoot(
    control.controlRoot,
    expectedWorkerId,
    env
  );
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
  const workerParent = path.dirname(candidate);
  try {
    fs.rmdirSync(workerParent);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new CompanionError(
        "E_WORKTREE",
        "Managed worker parent remained non-empty after worktree removal."
      );
    }
  }
  return true;
}

export { assertSafeRelativePath, gitCommonDir };
