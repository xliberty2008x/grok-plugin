import fs from "node:fs";
import path from "node:path";

import { git } from "./workspace.mjs";
import { canonicalJson, sha } from "./task-contract-primitives.mjs";
import {
  SHARED_REF_CLASS_TASK_RELEVANT,
  SHARED_REF_CLASS_UNRELATED,
  SHARED_REF_IDENTITY_SCHEMA_VERSION
} from "./task-context-policy.mjs";
import {
  MAX_GIT_METADATA_ENTRIES,
  MAX_LOOSE_REF_BODY_BYTES,
  MAX_METADATA_DEPTH,
  MAX_METADATA_HASH_BYTES,
  hashBoundedMetadataFile,
  listDirectoryNamesBounded,
  metadataSymlinkStatSignature,
  readBoundedNofollowTextFile,
  revalidateBoundedDirectorySnapshot
} from "./task-context-filesystem.mjs";

const MAX_SHARED_REFS = 10_000;
/** Cap for attributable ref snapshots retained on the manifest for evidence. */
const MAX_SHARED_REF_ATTRIBUTABLE = 2_000;
/**
 * Parser / private-evidence bound for semantic shared-ref names and targets.
 * Must stay collision-safe: do not truncate below this when retaining snapshots.
 */
const MAX_SHARED_REF_FIELD_BYTES = 512;

/** Cap for special index-flag entries (assume-unchanged / skip-worktree) before fail-closed. */
const MAX_INDEX_FLAG_ENTRIES = MAX_GIT_METADATA_ENTRIES;

/**
 * Positively classify a shared ref name.
 * Unrelated (tolerated only when both manifests are linked worktrees and only
 * these change): other local branches, unrelated remote-tracking refs, and
 * refs/codex/turn-diffs/**.
 * Task-relevant (fail closed): current branch, configured upstream,
 * refs/replace/**, and any unclassified/special ref.
 */
function classifySharedRef(refname, { currentBranchRef = null, upstreamFullRef = null } = {}) {
  const name = String(refname || "");
  if (!name.startsWith("refs/")) return SHARED_REF_CLASS_TASK_RELEVANT;
  if (currentBranchRef && name === currentBranchRef) return SHARED_REF_CLASS_TASK_RELEVANT;
  if (upstreamFullRef && name === upstreamFullRef) return SHARED_REF_CLASS_TASK_RELEVANT;
  if (name.startsWith("refs/replace/")) return SHARED_REF_CLASS_TASK_RELEVANT;
  if (name.startsWith("refs/codex/turn-diffs/")) return SHARED_REF_CLASS_UNRELATED;
  if (name.startsWith("refs/heads/")) return SHARED_REF_CLASS_UNRELATED;
  if (name.startsWith("refs/remotes/")) return SHARED_REF_CLASS_UNRELATED;
  return SHARED_REF_CLASS_TASK_RELEVANT;
}

/**
 * Exact Git reftable compatibility marker written as a regular file where a
 * loose-ref directory would otherwise live (e.g. refs/heads, refs/tags).
 * Content and relative locations are Git-defined; only ignore when the
 * repository backend is reftable (git rev-parse --show-ref-format).
 */
const REFTABLE_REFS_MARKER_BODY = "this repository uses the reftable format\n";
const REFTABLE_REFS_MARKER_RELATIVE = Object.freeze(new Set([
  "heads",
  "tags"
]));
const WORKTREE_PRIVATE_REF_NAMESPACES = Object.freeze([
  "bisect",
  "worktree",
  "rewritten"
]);

function finalizeLooseRefsInventory({
  rootSpecs,
  visit,
  refCount,
  snapshotRecords,
  directoryWitnesses,
  fileWitnesses,
  absentRootWitnesses
}) {
  for (const spec of rootSpecs) {
    const result = visit(spec, spec.absolute, "", 0, true);
    if (!result.ok) return result;
  }

  // Each scan is independently stable: after all roots have been traversed,
  // revalidate every captured directory membership, every descriptor-bound
  // file identity/body, and every optional absent root.
  for (const witness of directoryWitnesses) {
    const check = revalidateBoundedDirectorySnapshot(
      witness.absolute,
      witness.directorySignature,
      witness.names
    );
    if (!check.ok) return { ok: false, reason: "mutated" };
  }
  for (const witness of fileWitnesses) {
    const reread = readBoundedNofollowTextFile(
      witness.absolute,
      MAX_LOOSE_REF_BODY_BYTES
    );
    if (!reread.ok
      || reread.fileSignature !== witness.fileSignature
      || reread.mode !== witness.mode
      || reread.size !== witness.size
      || reread.bodyDigest !== witness.bodyDigest) {
      return { ok: false, reason: "mutated" };
    }
  }
  for (const absolute of absentRootWitnesses) {
    try {
      fs.lstatSync(absolute);
      return { ok: false, reason: "mutated" };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        return { ok: false, reason: "unreadable" };
      }
    }
  }

  snapshotRecords.sort((left, right) => (
    canonicalJson(left).localeCompare(canonicalJson(right))
  ));
  return {
    ok: true,
    refCount,
    identity: sha(canonicalJson({
      schema: "loose-refs-v2",
      records: snapshotRecords
    }))
  };
}

/**
 * Bounded loose-ref scan under refs/ to catch broken files and dangling
 * symbolic refs that for-each-ref/show-ref may silently omit with status 0.
 *
 * When the authoritative ref backend is reftable, Git may place exact
 * compatibility marker *files* at refs/heads and refs/tags (not directories)
 * with body "this repository uses the reftable format\\n". Those markers are
 * not refs and must not fail closed. Any other loose file, arbitrary symlink,
 * or marker-like content on a files backend remains fail-closed.
 * Hard entry/depth bounds; absolute paths stay private.
 */
function validateLooseRefsInventory(workspaceRoot, knownNames) {
  const commonDirRun = git(
    workspaceRoot,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { allowFailure: true }
  );
  if (commonDirRun.error || commonDirRun.status !== 0) {
    return { ok: false, reason: "common-dir" };
  }
  const gitDirRun = git(
    workspaceRoot,
    ["rev-parse", "--path-format=absolute", "--git-dir"],
    { allowFailure: true }
  );
  if (gitDirRun.error || gitDirRun.status !== 0) {
    return { ok: false, reason: "git-dir" };
  }
  let commonDir;
  let gitDir;
  try {
    const commonCandidate = String(commonDirRun.stdout || "").trim();
    const gitCandidate = String(gitDirRun.stdout || "").trim();
    if (!commonCandidate
      || !gitCandidate
      || !path.isAbsolute(commonCandidate)
      || !path.isAbsolute(gitCandidate)) {
      return { ok: false, reason: "git-dir" };
    }
    commonDir = fs.realpathSync(commonCandidate);
    gitDir = fs.realpathSync(gitCandidate);
  } catch {
    return { ok: false, reason: "common-dir" };
  }

  // Authoritative backend detection — only reftable may use the marker exception.
  const formatRun = git(
    workspaceRoot,
    ["rev-parse", "--show-ref-format"],
    { allowFailure: true }
  );
  const isReftable = !formatRun.error
    && formatRun.status === 0
    && String(formatRun.stdout || "").trim() === "reftable";

  const linkedWorktree = gitDir !== commonDir;
  const privateNamespaces = new Set(WORKTREE_PRIVATE_REF_NAMESPACES);
  const rootSpecs = [{
    absolute: path.join(commonDir, "refs"),
    refPrefix: "refs",
    source: "common",
    excludeTopLevel: linkedWorktree ? privateNamespaces : new Set(),
    allowReftableMarkers: true
  }];
  if (linkedWorktree) {
    for (const namespace of WORKTREE_PRIVATE_REF_NAMESPACES) {
      rootSpecs.push({
        absolute: path.join(gitDir, "refs", namespace),
        refPrefix: `refs/${namespace}`,
        source: `worktree:${namespace}`,
        excludeTopLevel: new Set(),
        allowReftableMarkers: false
      });
    }
  }

  let seenNodes = 0;
  let refCount = 0;
  const observedRefNames = new Set();
  const snapshotRecords = [];
  const directoryWitnesses = [];
  const fileWitnesses = [];
  const absentRootWitnesses = [];

  const snapshotFile = (spec, relativeKey, bodyRead, kind) => {
    snapshotRecords.push({
      kind,
      sourceDigest: sha(spec.source),
      pathDigest: sha(`${spec.refPrefix}/${relativeKey}`),
      fileSignature: bodyRead.fileSignature,
      mode: bodyRead.mode,
      size: bodyRead.size,
      bodyDigest: bodyRead.bodyDigest
    });
    fileWitnesses.push({
      absolute: path.join(spec.absolute, ...relativeKey.split("/")),
      fileSignature: bodyRead.fileSignature,
      mode: bodyRead.mode,
      size: bodyRead.size,
      bodyDigest: bodyRead.bodyDigest
    });
  };

  const visit = (spec, absolute, relative, depth, isRoot = false) => {
    if (seenNodes >= MAX_SHARED_REFS || depth > MAX_METADATA_DEPTH) {
      return { ok: false, reason: "bound" };
    }
    let stat;
    try {
      stat = fs.lstatSync(absolute, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT" && isRoot) {
        absentRootWitnesses.push(absolute);
        snapshotRecords.push({
          kind: "absent-root",
          sourceDigest: sha(spec.source)
        });
        return { ok: true };
      }
      return { ok: false, reason: "unreadable" };
    }
    seenNodes += 1;
    // Arbitrary symlink nodes under refs/ always fail closed (no silent skip).
    if (stat.isSymbolicLink()) {
      return { ok: false, reason: "symlink-ref" };
    }
    if (stat.isDirectory()) {
      let listed;
      try {
        listed = listDirectoryNamesBounded(
          absolute,
          Math.max(0, MAX_SHARED_REFS - seenNodes)
        );
      } catch {
        return { ok: false, reason: "unreadable" };
      }
      if (listed.truncated) {
        return { ok: false, reason: "bound" };
      }
      const effectiveNames = relative === ""
        ? listed.names.filter((name) => !spec.excludeTopLevel.has(name))
        : listed.names;
      snapshotRecords.push({
        kind: "directory",
        sourceDigest: sha(spec.source),
        pathDigest: sha(`${spec.refPrefix}/${relative}`),
        stableSignature: listed.stableSignature,
        memberDigests: effectiveNames.map((name) => sha(name))
      });
      directoryWitnesses.push({
        absolute,
        directorySignature: listed.directorySignature,
        names: listed.names
      });
      for (const name of effectiveNames) {
        const child = visit(
          spec,
          path.join(absolute, name),
          relative ? `${relative}/${name}` : name,
          depth + 1
        );
        if (!child.ok) return child;
      }
      const directoryCheck = revalidateBoundedDirectorySnapshot(
        absolute,
        listed.directorySignature,
        listed.names
      );
      if (!directoryCheck.ok) {
        return { ok: false, reason: "mutated" };
      }
      return { ok: true };
    }
    if (!stat.isFile()) {
      // Non-file/non-dir nodes under refs/ are not valid loose refs.
      return { ok: false, reason: "other" };
    }
    // relative must be a non-empty path under refs/ (never the refs root itself).
    if (!relative) return { ok: false, reason: "name" };
    const relativeKey = relative.replace(/\\/g, "/");

    // Exact reftable compatibility marker only (backend + path + body).
    // Descriptor-bound nofollow read of accepted body limit + 1 byte.
    if (
      spec.allowReftableMarkers
      &&
      isReftable
      && REFTABLE_REFS_MARKER_RELATIVE.has(relativeKey)
      && !relativeKey.includes("/")
    ) {
      const markerRead = readBoundedNofollowTextFile(absolute, MAX_LOOSE_REF_BODY_BYTES);
      if (!markerRead.ok) {
        return { ok: false, reason: markerRead.reason === "oversize" ? "oversize" : "unreadable" };
      }
      if (markerRead.body === REFTABLE_REFS_MARKER_BODY) {
        // Not a ref — skip without counting toward inventory incompleteness.
        snapshotFile(spec, relativeKey, markerRead, "reftable-marker");
        return { ok: true };
      }
      // Same path but wrong body: fall through as a broken/malformed plant.
    }

    refCount += 1;
    if (refCount > MAX_SHARED_REFS) return { ok: false, reason: "bound" };
    const refname = `${spec.refPrefix}/${relativeKey}`;
    if (refname.length > MAX_SHARED_REF_FIELD_BYTES || refname.includes("//")) {
      return { ok: false, reason: "name" };
    }
    // Descriptor-bound nofollow read; never unbounded readFileSync of ref bodies.
    const bodyRead = readBoundedNofollowTextFile(absolute, MAX_LOOSE_REF_BODY_BYTES);
    if (!bodyRead.ok) {
      return {
        ok: false,
        reason: bodyRead.reason === "oversize" ? "oversize" : "unreadable"
      };
    }
    snapshotFile(spec, relativeKey, bodyRead, "loose-ref");
    const trimmed = String(bodyRead.body || "").trim();
    if (!trimmed || trimmed.length > MAX_SHARED_REF_FIELD_BYTES) {
      return { ok: false, reason: "body" };
    }
    if (trimmed.startsWith("ref:")) {
      const target = trimmed.slice(4).trim();
      if (
        !target
        || !target.startsWith("refs/")
        || target.length > MAX_SHARED_REF_FIELD_BYTES
      ) {
        return { ok: false, reason: "symref" };
      }
      // Dangling or broken symbolic ref: must resolve to an object.
      const resolveRun = git(
        workspaceRoot,
        ["rev-parse", "--verify", "--quiet", "--end-of-options", `${refname}^{object}`],
        { allowFailure: true }
      );
      if (resolveRun.error || resolveRun.status !== 0 || String(resolveRun.stderr || "").trim()) {
        return { ok: false, reason: "dangling" };
      }
    } else if (!/^[a-f0-9]{40,64}$/i.test(trimmed.split(/\s+/)[0] || "")) {
      // Broken loose OID file (includes marker-like content on files backend).
      return { ok: false, reason: "broken-oid" };
    }
    if (observedRefNames.has(refname)) {
      return { ok: false, reason: "duplicate" };
    }
    observedRefNames.add(refname);
    // Loose ref present but omitted from semantic inventory → incomplete.
    if (knownNames && !knownNames.has(refname) && knownNames.size <= MAX_SHARED_REFS) {
      return { ok: false, reason: "omitted" };
    }
    return { ok: true };
  };

  return finalizeLooseRefsInventory({
    rootSpecs, visit, refCount, snapshotRecords,
    directoryWitnesses, fileWitnesses, absentRootWitnesses
  });
}

const SEMANTIC_REF_INVENTORY_ARGS = Object.freeze([
  "for-each-ref",
  "--sort=refname",
  "--format=%(refname)%00%(objectname)%00%(symref)%0a"
]);

/**
 * Parse a validated for-each-ref inventory run into sorted name/target records.
 * Caller must already enforce status 0, no error, and empty stderr.
 */
function parseSemanticRefInventoryStdout(stdout, workspaceRoot) {
  const refs = [];
  let unattributable = false;
  let malformed = false;
  const seenNames = new Set();
  let duplicates = false;
  for (const line of String(stdout || "").split("\n")) {
    if (!line) continue;
    const parts = line.split("\0");
    if (parts.length < 2) {
      malformed = true;
      unattributable = true;
      continue;
    }
    const name = parts[0] || "";
    const objectname = parts[1] || "";
    const symref = parts[2] || "";
    if (!name.startsWith("refs/") || name.length > MAX_SHARED_REF_FIELD_BYTES) {
      malformed = true;
      unattributable = true;
      continue;
    }
    if (seenNames.has(name)) {
      duplicates = true;
      unattributable = true;
      continue;
    }
    seenNames.add(name);
    const target = symref || objectname;
    if (!target
      || target.length > MAX_SHARED_REF_FIELD_BYTES
      || !/^[a-f0-9]{40,64}$/i.test(objectname)) {
      malformed = true;
      unattributable = true;
      continue;
    }
    // Reject absolute paths / private material in targets.
    if (/^(?:\/|[A-Za-z]:[\\/]|~\/)/.test(target)) {
      malformed = true;
      unattributable = true;
      continue;
    }
    // Dangling symbolic refs: symref target must resolve to an object.
    if (symref) {
      const resolveRun = git(
        workspaceRoot,
        ["rev-parse", "--verify", "--quiet", "--end-of-options", `${name}^{object}`],
        { allowFailure: true }
      );
      if (resolveRun.error || resolveRun.status !== 0 || String(resolveRun.stderr || "").trim()) {
        malformed = true;
        unattributable = true;
        continue;
      }
    }
    // Preserve both symbolic topology and the resolved object. A symbolic ref
    // can keep the same target name while that target advances.
    refs.push({
      name,
      target,
      resolvedOid: objectname.toLowerCase()
    });
    if (refs.length > MAX_SHARED_REFS) break;
  }
  refs.sort((left, right) => left.name.localeCompare(right.name));
  return { refs, unattributable, malformed, duplicates };
}

/**
 * True when two sorted semantic ref inventories have identical name+target pairs.
 */
function semanticRefInventoriesEqual(leftRefs, rightRefs) {
  if (!Array.isArray(leftRefs) || !Array.isArray(rightRefs)) return false;
  if (leftRefs.length !== rightRefs.length) return false;
  for (let index = 0; index < leftRefs.length; index += 1) {
    const left = leftRefs[index];
    const right = rightRefs[index];
    if (!left
      || !right
      || left.name !== right.name
      || left.target !== right.target
      || left.resolvedOid !== right.resolvedOid) {
      return false;
    }
  }
  return true;
}

/**
 * Capture semantic shared refs (name → OID or symref target) so loose↔packed
 * rewrites with identical semantics produce the same identity.
 *
 * Status-0 enumerations with stderr/warnings, malformed entries, duplicates,
 * dangling symbolic targets, or cross-check disagreement with `show-ref` /
 * bounded loose refs are incomplete/unavailable and never eligible for
 * linked-worktree tolerance.
 *
 * After all cross-checks, a second bounded exact name-and-target inventory pass
 * must match the first exactly (validated status and empty stderr) so mid-capture
 * same-name target mutations cannot publish a stale complete identity.
 */
function captureSemanticSharedRefs(workspaceRoot) {
  // Once Git's authoritative semantic inventory is untrusted, fail immediately.
  // A second loose-tree walk cannot restore attribution and would add needless
  // filesystem work to an already fail-closed capture.
  const failUntrustedInventory = () => (
    { refs: [], complete: false, available: false }
  );

  // One record per line: refname\0objectname\0symref. Newline separates records
  // so empty symref fields cannot merge adjacent refs.
  const run = git(
    workspaceRoot,
    [...SEMANTIC_REF_INVENTORY_ARGS],
    { allowFailure: true, maxBuffer: 64 * 1024 * 1024 }
  );
  if (run.status !== 0 || run.error) {
    return failUntrustedInventory();
  }
  // Any warning/diagnostic on stderr means the inventory is not trustworthy
  // (broken loose refs, reftable issues, etc.) even when status is 0.
  if (String(run.stderr || "").trim()) {
    return failUntrustedInventory();
  }
  const parsed = parseSemanticRefInventoryStdout(run.stdout, workspaceRoot);
  let { refs, unattributable, malformed, duplicates } = parsed;

  // Cross-check against show-ref so silently omitted dangling/broken refs
  // cannot publish a complete inventory (for-each-ref may drop them with status 0).
  const showRun = git(
    workspaceRoot,
    ["show-ref", "--head"],
    { allowFailure: true, maxBuffer: 64 * 1024 * 1024 }
  );
  // show-ref exits 1 when the repository has no refs at all; treat other
  // failures, stderr, or parse errors as incomplete.
  if (showRun.error) {
    return failUntrustedInventory();
  }
  if (String(showRun.stderr || "").trim()) {
    return failUntrustedInventory();
  }
  const showNames = new Set();
  let showMalformed = false;
  for (const line of String(showRun.stdout || "").split("\n")) {
    if (!line) continue;
    // Format: <oid> SP <refname>
    const sp = line.indexOf(" ");
    if (sp <= 0) {
      showMalformed = true;
      continue;
    }
    const refname = line.slice(sp + 1).trim();
    if (!refname || refname.length > MAX_SHARED_REF_FIELD_BYTES) {
      showMalformed = true;
      continue;
    }
    // Compare only refs/** — HEAD is not in for-each-ref output.
    if (refname.startsWith("refs/")) showNames.add(refname);
  }
  // When show-ref exits non-zero with empty stdout and no refs expected, allow
  // empty agreement; any partial/non-empty disagreement fails closed.
  if (showRun.status !== 0 && showNames.size > 0) {
    return { refs: [], complete: false, available: false };
  }
  if (showMalformed) {
    return { refs: [], complete: false, available: false };
  }
  const forEachNames = new Set(refs.map((entry) => entry.name));
  // Names only in show-ref (omitted by for-each-ref) or only in for-each-ref
  // indicate incomplete inventory. Truncation over MAX_SHARED_REFS is handled
  // separately via overBudget; still treat show-ref exclusives as omissions.
  if (refs.length <= MAX_SHARED_REFS) {
    for (const name of showNames) {
      if (!forEachNames.has(name)) {
        unattributable = true;
        malformed = true;
        break;
      }
    }
    if (!malformed) {
      for (const name of forEachNames) {
        if (!showNames.has(name)) {
          unattributable = true;
          malformed = true;
          break;
        }
      }
    }
  }

  // Bounded loose refs/ walk catches broken OID files and dangling symrefs that
  // both for-each-ref and show-ref may omit without non-zero status.
  let firstLooseSnapshot = null;
  if (!malformed && !duplicates && refs.length <= MAX_SHARED_REFS) {
    firstLooseSnapshot = validateLooseRefsInventory(
      workspaceRoot,
      forEachNames
    );
    if (!firstLooseSnapshot.ok) {
      malformed = true;
      unattributable = true;
    }
  }

  // Second exact name-and-target inventory after all cross-checks. Same-name
  // target mutations between passes must fail closed rather than return the
  // first-pass complete identity (show-ref name-only cross-check is insufficient).
  if (!malformed && !duplicates && !unattributable && refs.length <= MAX_SHARED_REFS) {
    const secondRun = git(
      workspaceRoot,
      [...SEMANTIC_REF_INVENTORY_ARGS],
      { allowFailure: true, maxBuffer: 64 * 1024 * 1024 }
    );
    if (
      secondRun.error
      || secondRun.status !== 0
      || String(secondRun.stderr || "").trim()
    ) {
      malformed = true;
      unattributable = true;
    } else {
      const second = parseSemanticRefInventoryStdout(secondRun.stdout, workspaceRoot);
      if (
        second.malformed
        || second.duplicates
        || second.unattributable
        || !semanticRefInventoriesEqual(refs, second.refs)
      ) {
        malformed = true;
        unattributable = true;
      } else {
        // The second semantic pass is bracketed by two independently
        // race-stable bounded loose inventories. Membership or descriptor-bound
        // file identity/body changes after the first scan fail closed even when
        // both Git semantic passes happen to agree.
        const secondLooseSnapshot = validateLooseRefsInventory(
          workspaceRoot,
          new Set(second.refs.map((entry) => entry.name))
        );
        if (!firstLooseSnapshot?.ok
          || !secondLooseSnapshot.ok
          || secondLooseSnapshot.refCount !== firstLooseSnapshot.refCount
          || secondLooseSnapshot.identity !== firstLooseSnapshot.identity) {
          malformed = true;
          unattributable = true;
        }
      }
    }
  }

  const overBudget = refs.length > MAX_SHARED_REFS;
  const complete = !unattributable
    && !malformed
    && !duplicates
    && !overBudget
    && refs.length <= MAX_SHARED_REFS;
  // Malformed/dangling/warning inventories are unavailable so they can never
  // receive linked-worktree unrelated-ref tolerance.
  const available = !malformed && !duplicates && !String(run.stderr || "").trim();
  return {
    refs: refs.slice(0, MAX_SHARED_REFS),
    complete,
    available
  };
}

function buildSharedRefIdentity(semanticRefs, { currentBranchRef = null, upstreamFullRef = null } = {}) {
  const taskRelevant = [];
  const unrelated = [];
  for (const entry of semanticRefs.refs) {
    const classification = classifySharedRef(entry.name, { currentBranchRef, upstreamFullRef });
    const record = {
      name: entry.name,
      target: entry.target,
      resolvedOid: entry.resolvedOid,
      class: classification
    };
    if (classification === SHARED_REF_CLASS_UNRELATED) unrelated.push(record);
    else taskRelevant.push(record);
  }
  taskRelevant.sort((left, right) => left.name.localeCompare(right.name));
  unrelated.sort((left, right) => left.name.localeCompare(right.name));
  const refCount = taskRelevant.length + unrelated.length;
  const complete = Boolean(semanticRefs.complete) && refCount <= MAX_SHARED_REFS;
  const attributable = complete && refCount <= MAX_SHARED_REF_ATTRIBUTABLE;
  const taskRelevantRefIdentity = sha(canonicalJson(
    taskRelevant.map((entry) => ({
      name: entry.name,
      target: entry.target,
      resolvedOid: entry.resolvedOid
    }))
  ));
  const unrelatedRefIdentity = sha(canonicalJson(
    unrelated.map((entry) => ({
      name: entry.name,
      target: entry.target,
      resolvedOid: entry.resolvedOid
    }))
  ));
  // Private evidence only (public protocol projection omits these arrays).
  // Keep full parser-bounded names/targets (≤512) so long-ref prefixes cannot
  // collide and self-observation cannot spuriously fail closed.
  const privateRecord = (entry) => ({
    name: entry.name,
    target: entry.target,
    resolvedOid: entry.resolvedOid,
    class: entry.class
  });
  return {
    schemaVersion: SHARED_REF_IDENTITY_SCHEMA_VERSION,
    complete,
    attributable,
    refCount,
    taskRelevantRefCount: taskRelevant.length,
    unrelatedRefCount: unrelated.length,
    taskRelevantRefIdentity,
    unrelatedRefIdentity,
    taskRelevantRefs: attributable ? taskRelevant.map(privateRecord) : [],
    unrelatedRefs: attributable ? unrelated.map(privateRecord) : []
  };
}

function captureFlaggedWorktreeEntries(
  workspaceRoot,
  flagged,
  stageEntries,
  initialTruncated,
  initialUnreadable
) {
  const entries = [];
  let hashedBytes = 0;
  let truncated = initialTruncated;
  let unreadable = initialUnreadable;
  for (const flaggedEntry of flagged) {
    const {
      tag,
      flagClass,
      isSkipWorktree,
      relativePath,
      pathDigest
    } = flaggedEntry;
    const indexed = stageEntries.get(relativePath) || [];
    const indexEntry = indexed.length === 1 && indexed[0].stage === 0
      ? indexed[0]
      : null;
    if (!indexEntry) {
      unreadable = true;
      entries.push({
        pathDigest,
        flag: tag,
        flagClass,
        indexMode: null,
        indexOid: null,
        worktreeKind: "unreadable",
        worktreeDigest: null
      });
      continue;
    }
    const { indexMode, indexOid } = indexEntry;
    let worktreeDigest = null;
    let worktreeKind = "absent";
    const absolute = path.resolve(workspaceRoot, relativePath);
    // Refuse path escape.
    if (absolute !== workspaceRoot && !absolute.startsWith(`${workspaceRoot}${path.sep}`)) {
      unreadable = true;
      entries.push({
        pathDigest,
        flag: tag,
        flagClass,
        indexMode,
        indexOid,
        worktreeKind: "outside",
        worktreeDigest: null
      });
      continue;
    }

    // A 160000 entry is a gitlink, not an ordinary directory. The context
    // manifest does not attempt to authenticate a nested repository lifecycle;
    // detect it from the exact index mode and fail closed.
    if (indexMode === "160000") {
      unreadable = true;
      entries.push({
        pathDigest,
        flag: tag,
        flagClass,
        indexMode,
        indexOid,
        worktreeKind: "gitlink",
        worktreeDigest: sha(canonicalJson({
          schema: "flagged-gitlink-v1",
          indexMode,
          indexOid
        }))
      });
      continue;
    }

    let stat;
    try {
      stat = fs.lstatSync(absolute, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT" && isSkipWorktree) {
        // skip-worktree absence is normal for sparse-checkout cones.
        worktreeKind = "absent";
      } else {
        unreadable = true;
        worktreeKind = "unreadable";
      }
      entries.push({
        pathDigest,
        flag: tag,
        flagClass,
        indexMode,
        indexOid,
        worktreeKind,
        worktreeDigest: null
      });
      continue;
    }
    if (stat.isSymbolicLink()) {
      worktreeKind = "symlink";
      try {
        if (indexMode !== "120000") {
          throw new Error("Index/worktree type mismatch.");
        }
        const beforeSignature = metadataSymlinkStatSignature(stat);
        const targetDigest = sha(String(fs.readlinkSync(absolute)));
        const after = fs.lstatSync(absolute, { bigint: true });
        if (!after.isSymbolicLink()
          || metadataSymlinkStatSignature(after) !== beforeSignature) {
          throw new Error("Symlink changed during observation.");
        }
        worktreeDigest = sha(canonicalJson({
          schema: "flagged-symlink-v1",
          statSignature: beforeSignature,
          targetDigest
        }));
      } catch {
        unreadable = true;
        worktreeKind = "unreadable";
        worktreeDigest = null;
      }
    } else if (stat.isFile()) {
      worktreeKind = "file";
      if (!/^100[0-7]{3}$/.test(indexMode)) {
        unreadable = true;
        worktreeKind = "unreadable";
      }
      // Bound content hashing; oversize files truncate the inventory.
      const remaining = MAX_METADATA_HASH_BYTES - hashedBytes;
      if (worktreeKind === "unreadable") {
        worktreeDigest = null;
      } else if (remaining <= 0) {
        truncated = true;
        worktreeDigest = null;
      } else {
        const probe = { hashedBytes: 0, unreadable: false, truncated: false };
        const fileIdentity = hashBoundedMetadataFile(absolute, probe, remaining);
        hashedBytes += probe.hashedBytes;
        if (probe.unreadable || fileIdentity.kind === "unobservable") {
          unreadable = true;
          worktreeKind = "unreadable";
          worktreeDigest = null;
        } else if (probe.truncated || fileIdentity.digest == null) {
          truncated = true;
          worktreeDigest = null;
        } else {
          worktreeDigest = sha(canonicalJson({
            schema: "flagged-file-v1",
            mode: fileIdentity.mode,
            size: fileIdentity.size,
            contentDigest: fileIdentity.digest
          }));
        }
      }
    } else if (stat.isDirectory()) {
      // Non-gitlink index entries cannot legitimately be directories.
      unreadable = true;
      worktreeKind = "unreadable";
      worktreeDigest = null;
    } else {
      unreadable = true;
      worktreeKind = "unreadable";
      worktreeDigest = null;
    }
    entries.push({
      pathDigest,
      flag: tag,
      flagClass,
      indexMode,
      indexOid,
      worktreeKind,
      worktreeDigest
    });
  }
  return { entries, truncated, unreadable };
}

/**
 * Observe assume-unchanged / skip-worktree index flags and the actual worktree
 * bytes they would otherwise hide from `status` / `ls-files --stage`.
 *
 * Does not mutate the index. Paths are digested only. Absence of a
 * skip-worktree path is valid (legitimate sparse-checkout); presence binds
 * content. Assume-unchanged always binds worktree content and an absent path
 * fails closed, so pre-flagged out-of-scope changes cannot hide. Hard
 * entry/byte bounds apply.
 */
function captureIndexFlagObservation(workspaceRoot) {
  const flagRun = git(
    workspaceRoot,
    ["ls-files", "-v", "-z"],
    { allowFailure: true, maxBuffer: 64 * 1024 * 1024 }
  );
  if (flagRun.error || flagRun.status !== 0) {
    return {
      identity: sha("index-flags-v2:unavailable"),
      observable: false,
      truncated: true
    };
  }
  if (String(flagRun.stderr || "").trim()) {
    return {
      identity: sha("index-flags-v2:stderr"),
      observable: false,
      truncated: true
    };
  }

  const flagged = [];
  let truncated = false;
  let unreadable = false;
  const flagRaw = String(flagRun.stdout || "");
  // Exact Git format for `ls-files -v -z`: <tag><SP><path>\0
  // (tag is one character, then a single ASCII space, then the path bytes).
  // Do not treat the separator as part of the path — that hashes a wrong
  // absent path and misses assume-unchanged / skip-worktree overwrites.
  for (const record of flagRaw.split("\0")) {
    if (!record) continue;
    if (record.length < 3 || record[1] !== " ") {
      unreadable = true;
      continue;
    }
    const tag = record[0];
    const relativePath = record.slice(2);
    if (!tag || !relativePath || relativePath.length > 4096) {
      unreadable = true;
      continue;
    }
    // Reject NUL/control separators already split; keep arbitrary valid path
    // bytes for private digest only (never published).
    if (relativePath.includes("\0")) {
      unreadable = true;
      continue;
    }
    // Normalize flag class without retaining raw path text in the identity
    // record beyond a private digest.
    const pathDigest = sha(relativePath.replace(/\\/g, "/"));
    // Git ls-files -v tags (common):
    //   H = cached normal, S = skip-worktree, h = assume-unchanged,
    //   lowercase variants mark assume-unchanged combinations.
    const isSkipWorktree = tag === "S" || tag === "s";
    const isAssumeUnchanged = tag === "h"
      || (tag !== "H" && tag !== "S" && tag === tag.toLowerCase());
    if (!isSkipWorktree && !isAssumeUnchanged) {
      // Ordinary cached entries are covered by trackedTreeIdentity; skip.
      continue;
    }
    if (flagged.length >= MAX_INDEX_FLAG_ENTRIES) {
      truncated = true;
      break;
    }
    const flagClass = isSkipWorktree
      ? (isAssumeUnchanged
          ? "skip-worktree+assume-unchanged"
          : "skip-worktree")
      : "assume-unchanged";
    flagged.push({
      tag,
      flagClass,
      isSkipWorktree,
      relativePath,
      pathDigest
    });
  }

  const stageRun = flagged.length === 0
    ? { status: 0, stdout: "", stderr: "", error: null }
    : git(
        workspaceRoot,
        ["ls-files", "--stage", "-z"],
        { allowFailure: true, maxBuffer: 64 * 1024 * 1024 }
      );
  if (stageRun.error
    || stageRun.status !== 0
    || String(stageRun.stderr || "").trim()) {
    unreadable = true;
  }

  // Bind flagged paths to their exact stage-0 index mode and object ID.
  // Multiple stages, malformed records, or a flag/index inventory race are
  // unobservable rather than being guessed from the worktree node type.
  const flaggedPaths = new Set(flagged.map((entry) => entry.relativePath));
  const stageEntries = new Map();
  const stageRaw = String(stageRun.stdout || "");
  if (!unreadable) {
    for (const record of stageRaw.split("\0")) {
      if (!record) continue;
      const separator = record.indexOf("\t");
      if (separator <= 0) {
        unreadable = true;
        continue;
      }
      const header = record.slice(0, separator);
      const relativePath = record.slice(separator + 1);
      const match = /^([0-7]{6}) ([a-fA-F0-9]{40,64}) ([0-3])$/.exec(header);
      if (!match || !relativePath) {
        unreadable = true;
        continue;
      }
      if (!flaggedPaths.has(relativePath)) continue;
      const records = stageEntries.get(relativePath) || [];
      records.push({
        indexMode: match[1],
        indexOid: match[2].toLowerCase(),
        stage: Number(match[3])
      });
      stageEntries.set(relativePath, records);
    }
  }

  const worktreeObservation = captureFlaggedWorktreeEntries(
    workspaceRoot,
    flagged,
    stageEntries,
    truncated,
    unreadable
  );
  const { entries } = worktreeObservation;
  truncated = worktreeObservation.truncated;
  unreadable = worktreeObservation.unreadable;

  if (flagged.length > 0) {
    const flagReread = git(
      workspaceRoot,
      ["ls-files", "-v", "-z"],
      { allowFailure: true, maxBuffer: 64 * 1024 * 1024 }
    );
    const stageReread = git(
      workspaceRoot,
      ["ls-files", "--stage", "-z"],
      { allowFailure: true, maxBuffer: 64 * 1024 * 1024 }
    );
    if (flagReread.error
      || flagReread.status !== 0
      || String(flagReread.stderr || "").trim()
      || String(flagReread.stdout || "") !== flagRaw
      || stageReread.error
      || stageReread.status !== 0
      || String(stageReread.stderr || "").trim()
      || String(stageReread.stdout || "") !== stageRaw) {
      unreadable = true;
    }
  }
  entries.sort((left, right) => {
    const byPath = left.pathDigest.localeCompare(right.pathDigest);
    if (byPath !== 0) return byPath;
    return left.flag.localeCompare(right.flag);
  });
  const failClosed = truncated || unreadable || entries.length >= MAX_INDEX_FLAG_ENTRIES;
  return {
    identity: sha(canonicalJson({
      schema: "index-flags-v2",
      entries,
      truncated: failClosed,
      unreadable
    })),
    observable: !failClosed,
    truncated: failClosed
  };
}

export {
  MAX_SHARED_REFS,
  MAX_SHARED_REF_ATTRIBUTABLE,
  MAX_SHARED_REF_FIELD_BYTES,
  buildSharedRefIdentity,
  captureIndexFlagObservation,
  captureSemanticSharedRefs
};
