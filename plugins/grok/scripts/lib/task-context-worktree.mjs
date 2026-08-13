import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { git } from "./workspace.mjs";
import { canonicalJson, sha } from "./task-contract-primitives.mjs";

const MAX_IGNORED_PATHS = 500_000;
const MAX_IGNORED_ATTRIBUTABLE = 2_000;
const MAX_IGNORED_HASH_BYTES = 64 * 1024 * 1024;
/** Cap for semantic shared-ref inventory; beyond this, identity is incomplete (fail closed). */

function parseDirtyEntries(root, raw) {
  const tokens = String(raw || "").split("\0");
  const allEntries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const status = token.slice(0, 2);
    const relativePath = token.length > 3 ? token.slice(3) : "";
    if (!relativePath) continue;
    const renamed = /[RC]/.test(status);
    const sourcePath = renamed ? String(tokens[++index] || "") : null;
    const identity = worktreePathIdentity(root, relativePath);
    allEntries.push({
      status,
      path: relativePath.slice(0, 4096),
      sourcePath: sourcePath ? sourcePath.slice(0, 4096) : null,
      ...identity
    });
  }
  allEntries.sort((left, right) => `${left.path}\0${left.sourcePath || ""}`.localeCompare(`${right.path}\0${right.sourcePath || ""}`));
  return {
    entries: allEntries.slice(0, 500),
    count: allEntries.length,
    truncated: allEntries.length > 500,
    digest: sha(canonicalJson(allEntries))
  };
}

function hashFile(file) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

/**
 * True when any path component is exactly `.pytest_cache` or `__pycache__`.
 * Used only for the verification-time ignored identity; ordinary task/resume
 * comparison keeps the full ignored inventory.
 */
export function isVerificationCacheIgnoredPath(relativePath) {
  return String(relativePath || "")
    .split("/")
    .some((part) => part === ".pytest_cache" || part === "__pycache__");
}

/**
 * True when `relativePath` is exactly a declared verification-generated path
 * or a descendant. Prefix matching uses a path-component boundary so `dist`
 * does not match `dist-backup`.
 */
export function isDeclaredVerificationGeneratedPath(relativePath, generatedPaths = []) {
  const normalized = String(relativePath || "").replace(/\\/g, "/");
  if (!normalized) return false;
  for (const raw of Array.isArray(generatedPaths) ? generatedPaths : []) {
    const prefix = String(raw || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (!prefix) continue;
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

export function isVerificationExcludedIgnoredPath(relativePath, generatedPaths = []) {
  return isVerificationCacheIgnoredPath(relativePath)
    || isDeclaredVerificationGeneratedPath(relativePath, generatedPaths);
}

export function verificationGeneratedPathsFrom(source) {
  const value = source?.request?.envelope?.verificationGeneratedPaths
    ?? source?.verificationGeneratedPaths
    ?? [];
  return Array.isArray(value) ? value : [];
}

export function contextCaptureOptions(contextPhase, source) {
  return {
    ...(contextPhase ? { contextPhase } : {}),
    verificationGeneratedPaths: verificationGeneratedPathsFrom(source)
  };
}

/**
 * Fingerprint ignored worktree paths that `git status --untracked-files=all` omits.
 * Small files receive content hashes up to a global budget; every path also carries
 * high-resolution metadata so ordinary search/replace writes remain observable.
 * Large inventories retain only a digest and fail closed to an unattributed marker.
 *
 * From the same inventory, also compute a verification-only identity that drops
 * standard pytest/Python cache path components and any author-declared
 * verification-generated paths so host checks can leave those outputs without
 * triggering out-of-scope write detection. Ordinary ignored identity is
 * unchanged.
 */
function ignoredWorktreeSnapshot(root, { verificationGeneratedPaths = [] } = {}) {
  const run = git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], {
    allowFailure: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (run.status !== 0 || run.error) {
    return {
      digest: sha("ignored-v1:unavailable"),
      count: 0,
      entries: [],
      attributable: false,
      complete: false,
      verificationDigest: sha("ignored-verification-v1:unavailable"),
      verificationCount: 0,
      verificationEntries: [],
      verificationAttributable: false,
      verificationComplete: false
    };
  }
  const allPaths = String(run.stdout || "").split("\0").filter(Boolean).sort();
  const complete = allPaths.length <= MAX_IGNORED_PATHS;
  const paths = allPaths.slice(0, MAX_IGNORED_PATHS);
  const attributable = complete && paths.length <= MAX_IGNORED_ATTRIBUTABLE;
  const allVerificationPaths = allPaths.filter((relativePath) => (
    !isVerificationExcludedIgnoredPath(relativePath, verificationGeneratedPaths)
  ));
  const verificationCount = allVerificationPaths.length;
  const verificationComplete = verificationCount <= MAX_IGNORED_PATHS;
  const verificationPaths = allVerificationPaths.slice(0, MAX_IGNORED_PATHS);
  const verificationAttributable = verificationComplete && verificationCount <= MAX_IGNORED_ATTRIBUTABLE;
  const fullPathSet = new Set(paths);
  const verificationPathSet = new Set(verificationPaths);
  const snapshotPaths = [...new Set([...paths, ...verificationPaths])].sort();
  const entries = [];
  const verificationEntries = [];
  const digest = crypto.createHash("sha256");
  const verificationDigest = crypto.createHash("sha256");
  digest.update("ignored-v1\0");
  verificationDigest.update("ignored-verification-v1\0");
  let hashedBytes = 0;
  let verificationHashedBytes = 0;
  for (const relativePath of snapshotPaths) {
    const inFullSnapshot = fullPathSet.has(relativePath);
    const inVerificationSnapshot = verificationPathSet.has(relativePath);
    const absolute = path.resolve(root, relativePath);
    let identity;
    let verificationIdentity;
    if (absolute === root || !absolute.startsWith(`${root}${path.sep}`)) {
      identity = { kind: "outside" };
      verificationIdentity = identity;
    } else {
      try {
        const stat = fs.lstatSync(absolute, { bigint: true });
        const mode = Number(stat.mode & 0o7777n);
        if (stat.isSymbolicLink()) {
          identity = { kind: "symlink", mode, targetDigest: sha(fs.readlinkSync(absolute)) };
          verificationIdentity = identity;
        } else if (stat.isFile()) {
          const size = Number(stat.size);
          const safeSize = Number.isSafeInteger(size) && size >= 0;
          const mayHash = inFullSnapshot && safeSize && hashedBytes + size <= MAX_IGNORED_HASH_BYTES;
          const verificationMayHash = inVerificationSnapshot
            && safeSize
            && verificationHashedBytes + size <= MAX_IGNORED_HASH_BYTES;
          const contentDigest = mayHash || verificationMayHash ? hashFile(absolute) : null;
          const baseIdentity = {
            kind: "file",
            mode,
            size: stat.size.toString(),
            mtimeNs: stat.mtimeNs.toString()
          };
          identity = { ...baseIdentity, contentDigest: mayHash ? contentDigest : null };
          verificationIdentity = { ...baseIdentity, contentDigest: verificationMayHash ? contentDigest : null };
          if (mayHash) hashedBytes += size;
          if (verificationMayHash) verificationHashedBytes += size;
        } else if (stat.isDirectory()) {
          identity = { kind: "directory", mode, mtimeNs: stat.mtimeNs.toString() };
          verificationIdentity = identity;
        } else {
          identity = { kind: "other", mode, mtimeNs: stat.mtimeNs.toString() };
          verificationIdentity = identity;
        }
      } catch (error) {
        identity = { kind: error?.code === "ENOENT" ? "missing" : "unreadable", code: String(error?.code || "ERR").slice(0, 32) };
        verificationIdentity = identity;
      }
    }
    if (inFullSnapshot) {
      const fingerprint = canonicalJson(identity);
      digest.update(`${relativePath.length}:`);
      digest.update(relativePath);
      digest.update("\0");
      digest.update(fingerprint);
      digest.update("\0");
      if (attributable) entries.push({ path: relativePath.slice(0, 4096), fingerprint });
    }
    if (inVerificationSnapshot) {
      const fingerprint = canonicalJson(verificationIdentity);
      verificationDigest.update(`${relativePath.length}:`);
      verificationDigest.update(relativePath);
      verificationDigest.update("\0");
      verificationDigest.update(fingerprint);
      verificationDigest.update("\0");
      if (verificationAttributable) {
        verificationEntries.push({ path: relativePath.slice(0, 4096), fingerprint });
      }
    }
  }
  digest.update(`count=${allPaths.length};complete=${complete}`);
  verificationDigest.update(`count=${verificationCount};complete=${verificationComplete}`);
  return {
    digest: digest.digest("hex"),
    count: allPaths.length,
    entries,
    attributable,
    complete,
    verificationDigest: verificationDigest.digest("hex"),
    verificationCount,
    verificationEntries,
    verificationAttributable,
    verificationComplete
  };
}

function worktreePathIdentity(root, relativePath) {
  const absolute = path.resolve(root, relativePath);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return { fileKind: "outside", fileMode: null, worktreeHash: null };
  let stat;
  try { stat = fs.lstatSync(absolute); }
  catch (error) { return { fileKind: error.code === "ENOENT" ? "missing" : "unreadable", fileMode: null, worktreeHash: null }; }
  const fileMode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) {
    let target = "";
    try { target = fs.readlinkSync(absolute); } catch {}
    return { fileKind: "symlink", fileMode, worktreeHash: sha(target) };
  }
  if (stat.isFile()) {
    const hashRun = git(root, ["hash-object", "--no-filters", "--", relativePath], { allowFailure: true });
    return {
      fileKind: "file",
      fileMode,
      worktreeHash: hashRun.status === 0 ? String(hashRun.stdout || "").trim() || null : null
    };
  }
  if (stat.isDirectory()) {
    const submoduleRun = git(root, ["-C", absolute, "rev-parse", "HEAD"], { allowFailure: true });
    return {
      fileKind: "directory",
      fileMode,
      worktreeHash: submoduleRun.status === 0 ? String(submoduleRun.stdout || "").trim() || null : null
    };
  }
  return { fileKind: "other", fileMode, worktreeHash: null };
}

export {
  MAX_IGNORED_ATTRIBUTABLE,
  MAX_IGNORED_PATHS,
  ignoredWorktreeSnapshot,
  parseDirtyEntries
};
