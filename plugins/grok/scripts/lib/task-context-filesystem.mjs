import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { sha } from "./task-contract-primitives.mjs";

const MAX_GIT_METADATA_ENTRIES = 10_000;
/** Shared byte budget for hashing operational, non-ref, hooks, and config target contents. */
const MAX_METADATA_HASH_BYTES = 4 * 1024 * 1024;

const MAX_METADATA_SYMLINK_HOPS = 8;

/** Max depth when walking operational / non-ref metadata trees behind symlinks. */
const MAX_METADATA_DEPTH = 8;

/**
 * Accepted body size for loose ref files and reftable compatibility markers.
 * Reads use this limit + 1 byte so oversize bodies fail closed without unbounded I/O.
 */
const MAX_LOOSE_REF_BODY_BYTES = 512;

function metadataSymlinkStatSignature(stat) {
  return [
    String(stat.dev),
    String(stat.ino),
    String(stat.mode),
    String(stat.size),
    String(stat.mtimeNs),
    String(stat.ctimeNs)
  ].join(":");
}

/**
 * Bigint-capable identity for the final non-symlink node after hop resolution.
 * Matches the file-stability fields so retarget/replace races fail closed.
 */
function metadataResolvedNodeStatSignature(stat) {
  return [
    String(stat.dev),
    String(stat.ino),
    String(stat.mode),
    String(stat.size),
    String(stat.mtimeNs),
    String(stat.ctimeNs)
  ].join(":");
}

/**
 * Follow a symlink chain with explicit hop bounds and cycle detection.
 * Returns private digests of each link text plus the final non-symlink node.
 * Also retains transient per-hop absolute path, bigint lstat identity, and
 * link-text digest so callers can revalidate after target capture.
 * Absolute paths and raw link text never leave this helper except as
 * transient locals (never serialized into entry records).
 * Shared by effective-hooks, operational, and non-ref metadata capture.
 */
function resolveMetadataSymlinkChain(startAbsolute, inheritedChain, maxHops = MAX_METADATA_SYMLINK_HOPS) {
  const linkDigests = [];
  /** @type {{ absolute: string, linkDigest: string, signature: string }[]} */
  const hops = [];
  const chain = new Set(inheritedChain);
  let current = startAbsolute;

  for (let hopCount = 0; hopCount < maxHops; hopCount += 1) {
    const resolvedCurrent = path.resolve(current);
    if (chain.has(resolvedCurrent)) {
      return { ok: false, reason: "cycle", linkDigests, hops };
    }
    chain.add(resolvedCurrent);

    let stat;
    try {
      stat = fs.lstatSync(current, { bigint: true });
    } catch {
      return { ok: false, reason: "broken", linkDigests, hops };
    }

    if (!stat.isSymbolicLink()) {
      return {
        ok: true,
        linkDigests,
        hops,
        finalAbsolute: current,
        finalStat: stat,
        finalSignature: metadataResolvedNodeStatSignature(stat),
        chain
      };
    }

    let linkText;
    try {
      linkText = fs.readlinkSync(current);
    } catch {
      return { ok: false, reason: "unreadable", linkDigests, hops };
    }
    // Digest only — never retain raw link text (may be absolute).
    const linkDigest = sha(String(linkText));
    linkDigests.push(linkDigest);
    // Private hop identity for post-capture revalidation only.
    hops.push({
      absolute: current,
      linkDigest,
      signature: metadataSymlinkStatSignature(stat)
    });
    current = path.resolve(path.dirname(current), String(linkText));
  }

  return { ok: false, reason: "hop-limit", linkDigests, hops };
}

/**
 * Re-lstat/readlink every original hop after target hashing or directory
 * traversal. Requires identical symlink identity and link-text digest, then
 * revalidates final target path identity. Missing, replaced, retargeted,
 * unreadable, or non-symlink hops fail closed. Private absolute paths and raw
 * link text never leave this helper.
 */
function revalidateMetadataSymlinkHops(hops, finalAbsolute, finalSignature, maxHops = MAX_METADATA_SYMLINK_HOPS) {
  if (!Array.isArray(hops) || hops.length === 0) {
    return { ok: false, reason: "broken" };
  }
  if (hops.length > maxHops) {
    return { ok: false, reason: "hop-limit" };
  }

  for (const hop of hops) {
    if (!hop || typeof hop.absolute !== "string" || typeof hop.linkDigest !== "string") {
      return { ok: false, reason: "unreadable" };
    }
    let stat;
    try {
      stat = fs.lstatSync(hop.absolute, { bigint: true });
    } catch {
      return { ok: false, reason: "broken" };
    }
    if (!stat.isSymbolicLink()) {
      return { ok: false, reason: "replaced" };
    }
    if (metadataSymlinkStatSignature(stat) !== hop.signature) {
      return { ok: false, reason: "replaced" };
    }
    let linkText;
    try {
      linkText = fs.readlinkSync(hop.absolute);
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    if (sha(String(linkText)) !== hop.linkDigest) {
      return { ok: false, reason: "retargeted" };
    }
  }

  if (typeof finalAbsolute === "string" && typeof finalSignature === "string") {
    let finalStat;
    try {
      finalStat = fs.lstatSync(finalAbsolute, { bigint: true });
    } catch {
      return { ok: false, reason: "broken" };
    }
    // Resolved final must remain a non-symlink node with the same identity
    // observed at hop resolution (no silent target replace/swap).
    if (finalStat.isSymbolicLink()) {
      return { ok: false, reason: "retargeted" };
    }
    if (metadataResolvedNodeStatSignature(finalStat) !== finalSignature) {
      return { ok: false, reason: "replaced" };
    }
  }

  return { ok: true };
}

/**
 * Map hop revalidation / chain failure reasons onto visit state flags.
 */
function applyMetadataSymlinkFailure(state, reason) {
  if (reason === "cycle") state.cyclic = true;
  else if (reason === "hop-limit") state.depthExceeded = true;
  else state.unreadable = true;
}

/**
 * Bigint-capable identity for an ordinary (non-symlink) directory node.
 * Used to bind enumeration/traversal snapshots so post-EOF growth, child
 * removal, and replace races fail closed without serializing paths.
 * Within-capture only — includes nlink/size/mtime/ctime that move when
 * unrelated children appear or disappear under the directory.
 */
function metadataDirectoryStatSignature(stat) {
  return [
    String(stat.dev),
    String(stat.ino),
    String(stat.mode),
    String(stat.nlink),
    String(stat.size),
    String(stat.mtimeNs),
    String(stat.ctimeNs)
  ].join(":");
}

/**
 * Stable identity for a lexical path component (directory, file, or symlink
 * node). Binds replacement (dev/ino) and type/chmod (mode) without directory
 * enumeration volatility (nlink/size/mtime/ctime) that changes when unrelated
 * siblings are created, modified, or removed under an ancestor.
 * Used for both cross-capture hooks hop digests and same-capture lexical hop
 * revalidation. Full metadataDirectoryStatSignature / file / symlink signatures
 * remain for metadata tree enumeration and content hashing race checks only.
 * Digested into hooks identity only — never serialized raw.
 */
function metadataLexicalNodeStableSignature(stat) {
  return [
    String(stat.dev),
    String(stat.ino),
    String(stat.mode)
  ].join(":");
}

/**
 * True when both stats describe the same ordinary directory identity snapshot.
 */
function sameMetadataDirectoryStat(left, right) {
  return Boolean(
    left
    && right
    && left.isDirectory()
    && right.isDirectory()
    && !left.isSymbolicLink()
    && !right.isSymbolicLink()
    && metadataDirectoryStatSignature(left) === metadataDirectoryStatSignature(right)
  );
}

/**
 * Descriptor-bound directory listing capped at remaining entry capacity + 1.
 * Captures bigint directory identity before open and re-checks it after EOF so
 * mid-list mutation fails closed. Stops immediately on overflow without
 * materializing the full directory. Within-bound names are sorted for
 * deterministic walks. Absolute paths never enter returned records.
 */
function listDirectoryNamesBounded(dirAbsolute, maxNames) {
  const capacity = Number.isSafeInteger(maxNames) && maxNames > 0 ? maxNames : 0;
  const limit = capacity + 1;
  let beforeStat;
  try {
    beforeStat = fs.lstatSync(dirAbsolute, { bigint: true });
  } catch (error) {
    const err = new Error("directory-unreadable");
    err.cause = error;
    throw err;
  }
  if (!beforeStat.isDirectory() || beforeStat.isSymbolicLink()) {
    const err = new Error("directory-not-directory");
    throw err;
  }
  const directorySignature = metadataDirectoryStatSignature(beforeStat);
  const names = [];
  let handle = null;
  try {
    handle = fs.opendirSync(dirAbsolute);
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      const name = entry?.name;
      if (typeof name !== "string" || !name || name === "." || name === "..") continue;
      names.push(name);
      if (names.length >= limit) break;
    }
  } finally {
    if (handle != null) {
      try { handle.closeSync(); } catch { /* ignore close races */ }
    }
  }
  // Re-bind directory identity immediately after enumeration closes so
  // mid-list additions/removals that change directory metadata fail closed.
  let afterStat;
  try {
    afterStat = fs.lstatSync(dirAbsolute, { bigint: true });
  } catch {
    const err = new Error("directory-mutated");
    throw err;
  }
  if (!sameMetadataDirectoryStat(beforeStat, afterStat)) {
    const err = new Error("directory-mutated");
    throw err;
  }
  if (names.length > capacity) {
    return { names: [], truncated: true, directorySignature };
  }
  names.sort((left, right) => left.localeCompare(right));
  return {
    names,
    truncated: false,
    directorySignature,
    stableSignature: metadataLexicalNodeStableSignature(beforeStat)
  };
}

/**
 * After child traversal (or immediately after a stable empty listing), confirm
 * the ordinary directory still has the same bigint identity and the same
 * bounded name set. Detects post-EOF growth and listed-child disappearance
 * without unbounded re-listing (at most expectedNames.length + 1 reads).
 * Absolute paths never leave this helper.
 */
function revalidateBoundedDirectorySnapshot(dirAbsolute, directorySignature, expectedNames) {
  if (typeof directorySignature !== "string" || !Array.isArray(expectedNames)) {
    return { ok: false, reason: "unreadable" };
  }
  let stat;
  try {
    stat = fs.lstatSync(dirAbsolute, { bigint: true });
  } catch {
    return { ok: false, reason: "disappeared" };
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return { ok: false, reason: "replaced" };
  }
  if (metadataDirectoryStatSignature(stat) !== directorySignature) {
    return { ok: false, reason: "mutated" };
  }

  // Bounded re-list: capacity = prior name count; one extra name ⇒ growth.
  const capacity = expectedNames.length;
  const limit = capacity + 1;
  const names = [];
  let handle = null;
  try {
    handle = fs.opendirSync(dirAbsolute);
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      const name = entry?.name;
      if (typeof name !== "string" || !name || name === "." || name === "..") continue;
      names.push(name);
      if (names.length >= limit) break;
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    if (handle != null) {
      try { handle.closeSync(); } catch { /* ignore close races */ }
    }
  }
  if (names.length > capacity) {
    return { ok: false, reason: "grown" };
  }
  names.sort((left, right) => left.localeCompare(right));
  if (names.length !== expectedNames.length) {
    return { ok: false, reason: "mutated" };
  }
  for (let index = 0; index < names.length; index += 1) {
    if (names[index] !== expectedNames[index]) {
      return { ok: false, reason: "mutated" };
    }
  }

  // Final identity bind after the verification listing.
  let finalStat;
  try {
    finalStat = fs.lstatSync(dirAbsolute, { bigint: true });
  } catch {
    return { ok: false, reason: "disappeared" };
  }
  if (!sameMetadataDirectoryStat(stat, finalStat)
    || metadataDirectoryStatSignature(finalStat) !== directorySignature) {
    return { ok: false, reason: "mutated" };
  }
  return { ok: true };
}

/**
 * Bigint-capable identity for metadata file stability checks.
 * Compares device, inode, mode, size, and high-resolution mtime/ctime so
 * same-size in-place mutation and typical metadata churn fail closed.
 */
function metadataFileStatSignature(stat) {
  return [
    String(stat.dev),
    String(stat.ino),
    String(stat.mode),
    String(stat.size),
    String(stat.mtimeNs),
    String(stat.ctimeNs)
  ].join(":");
}

/**
 * True when both stats describe the same regular-file identity snapshot.
 * Uses lstat-friendly checks (symlink is never accepted as the captured file).
 */
function sameMetadataFileStat(left, right) {
  return Boolean(
    left
    && right
    && left.isFile()
    && right.isFile()
    && !left.isSymbolicLink()
    && !right.isSymbolicLink()
    && metadataFileStatSignature(left) === metadataFileStatSignature(right)
  );
}

/**
 * Descriptor-bound file content digest for private metadata identity.
 *
 * Reads at most the remaining byte budget + 1 from a stable open descriptor.
 * Before accepting a digest, re-validates full bigint metadata on the descriptor
 * and re-lstats the original path without following a newly introduced symlink
 * so path replacement, disappearance, symlink swap, or same-size mutation
 * (timestamp/mode/size identity drift) fails closed. Never retains path or raw
 * bytes beyond the local hash computation.
 */
function hashBoundedMetadataFile(absolute, state, maxBytes = MAX_METADATA_HASH_BYTES) {
  let descriptor;
  try {
    const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(absolute, openFlags);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      state.unreadable = true;
      return { kind: "unobservable", reason: "unreadable" };
    }
    // Path must name this same regular file at open time (no symlink/path swap).
    let pathBefore;
    try {
      pathBefore = fs.lstatSync(absolute, { bigint: true });
    } catch {
      state.unreadable = true;
      return { kind: "unobservable", reason: "unreadable" };
    }
    if (!sameMetadataFileStat(before, pathBefore)) {
      state.unreadable = true;
      return { kind: "unobservable", reason: "unreadable" };
    }

    const size = Number(before.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      state.unreadable = true;
      return { kind: "unobservable", reason: "unreadable" };
    }
    const modeBits = Number(before.mode & 0o7777n);

    const remaining = maxBytes - state.hashedBytes;
    if (!Number.isSafeInteger(remaining) || remaining < 0) {
      state.truncated = true;
      return { kind: "file", mode: modeBits, size, digest: null };
    }

    // Cap at remaining+1 so oversize content is detected without reading past budget+1.
    const readLimit = remaining + 1;
    const hash = crypto.createHash("sha256");
    const chunkSize = Math.min(64 * 1024, Math.max(readLimit, 1));
    const buffer = Buffer.allocUnsafe(chunkSize);
    let totalRead = 0;
    while (totalRead < readLimit) {
      const want = Math.min(buffer.length, readLimit - totalRead);
      const count = fs.readSync(descriptor, buffer, 0, want, totalRead);
      if (count === 0) break;
      if (totalRead < remaining) {
        const withinBudget = Math.min(count, remaining - totalRead);
        if (withinBudget > 0) hash.update(buffer.subarray(0, withinBudget));
      }
      totalRead += count;
    }

    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameMetadataFileStat(before, after)) {
      state.unreadable = true;
      return { kind: "unobservable", reason: "unreadable" };
    }

    // Re-lstat the original path without following a newly introduced symlink.
    // Path replacement leaves the descriptor on the detached old inode; this
    // check requires the path still names that same regular-file identity.
    let pathAfter;
    try {
      pathAfter = fs.lstatSync(absolute, { bigint: true });
    } catch {
      state.unreadable = true;
      return { kind: "unobservable", reason: "unreadable" };
    }
    if (!sameMetadataFileStat(before, pathAfter)) {
      state.unreadable = true;
      return { kind: "unobservable", reason: "unreadable" };
    }

    // Content exceeds remaining budget (observed via remaining+1 probe or size claim).
    if (totalRead > remaining || size > remaining) {
      state.truncated = true;
      return { kind: "file", mode: modeBits, size, digest: null };
    }

    // Short read against a stable size, or extra bytes beyond the size claim.
    if (totalRead !== size) {
      state.unreadable = true;
      return { kind: "unobservable", reason: "unreadable" };
    }

    state.hashedBytes += size;
    return {
      kind: "file",
      mode: modeBits,
      size,
      digest: hash.digest("hex")
    };
  } catch {
    state.unreadable = true;
    return { kind: "unobservable", reason: "unreadable" };
  } finally {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch { /* ignore close races */ }
    }
  }
}

/**
 * Public-safe file identity fields from a bounded hash result (no paths).
 */
function publicMetadataFileTarget(fileIdentity) {
  if (!fileIdentity || fileIdentity.kind === "unobservable") {
    return fileIdentity || { kind: "unobservable", reason: "unreadable" };
  }
  return {
    kind: "file",
    mode: fileIdentity.mode,
    size: fileIdentity.size,
    digest: fileIdentity.digest
  };
}

/**
 * Descriptor-bound nofollow text read capped at maxBytes + 1.
 *
 * Used for loose refs and reftable markers so oversize bodies fail closed without
 * unbounded I/O. Revalidates path/stat identity around the read. Never follows
 * symlinks (O_NOFOLLOW when available). Absolute paths stay local.
 *
 * @returns {{ ok: true, body: string } | { ok: false, reason: string }}
 */
function readBoundedNofollowTextFile(absolute, maxBytes = MAX_LOOSE_REF_BODY_BYTES) {
  if (typeof absolute !== "string" || !absolute || !path.isAbsolute(absolute)) {
    return { ok: false, reason: "invalid" };
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    return { ok: false, reason: "bound" };
  }
  let descriptor = null;
  try {
    const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(absolute, openFlags);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) {
      return { ok: false, reason: "not-file" };
    }
    let pathBefore;
    try {
      pathBefore = fs.lstatSync(absolute, { bigint: true });
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    if (!sameMetadataFileStat(before, pathBefore)) {
      return { ok: false, reason: "replaced" };
    }
    const size = Number(before.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      return { ok: false, reason: "unreadable" };
    }
    // Always probe at most accepted body limit + 1 byte. Never trust size alone
    // to skip the capped read (size can race), and never read past the bound
    // even when size claims to be huge.
    const readLimit = maxBytes + 1;
    const chunks = [];
    let totalRead = 0;
    const chunkSize = Math.min(64 * 1024, Math.max(readLimit, 1));
    const buffer = Buffer.allocUnsafe(chunkSize);
    while (totalRead < readLimit) {
      const want = Math.min(buffer.length, readLimit - totalRead);
      const count = fs.readSync(descriptor, buffer, 0, want, totalRead);
      if (count === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, count)));
      totalRead += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameMetadataFileStat(before, after)) {
      return { ok: false, reason: "mutated" };
    }
    let pathAfter;
    try {
      pathAfter = fs.lstatSync(absolute, { bigint: true });
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    if (!sameMetadataFileStat(before, pathAfter)) {
      return { ok: false, reason: "replaced" };
    }
    if (totalRead > maxBytes || size > maxBytes) {
      return { ok: false, reason: "oversize" };
    }
    // Stable within-bound size must match bytes actually read.
    if (totalRead !== size) {
      return { ok: false, reason: "short-read" };
    }
    const contents = Buffer.concat(chunks, totalRead);
    return {
      ok: true,
      body: contents.toString("utf8"),
      bodyDigest: sha(contents),
      fileSignature: metadataFileStatSignature(before),
      mode: Number(before.mode & 0o7777n),
      size
    };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch { /* ignore close races */ }
    }
  }
}

/**
 * Re-hash a previously captured ordinary file and require identical
 * descriptor-validated mode/size/digest. Uses an isolated byte budget equal to
 * the captured size so parent hashedBytes is not double-counted and I/O stays
 * proportional to prior capture (not unbounded).
 */
function revalidateCapturedFileSnapshot(snapshot) {
  if (
    !snapshot
    || snapshot.kind !== "file"
    || typeof snapshot.absolute !== "string"
    || !Number.isSafeInteger(snapshot.mode)
    || !Number.isSafeInteger(snapshot.size)
    || snapshot.size < 0
  ) {
    return { ok: false, reason: "unreadable" };
  }
  const probe = { hashedBytes: 0, unreadable: false, truncated: false };
  const result = hashBoundedMetadataFile(snapshot.absolute, probe, snapshot.size);
  if (probe.unreadable || result.kind === "unobservable") {
    return { ok: false, reason: "unreadable" };
  }
  if (probe.truncated || result.digest == null) {
    // Grew past captured size, or captured was truncated — either is drift.
    if (snapshot.digest == null && probe.truncated && result.size === snapshot.size) {
      return { ok: true };
    }
    return { ok: false, reason: "mutated" };
  }
  if (
    result.mode !== snapshot.mode
    || result.size !== snapshot.size
    || result.digest !== snapshot.digest
  ) {
    return { ok: false, reason: "mutated" };
  }
  return { ok: true };
}

/**
 * Revalidate private snapshots for already-captured directory children so
 * sibling-after-hash content/mode/hop drift fails closed. Runs in O(children)
 * per directory (at most one re-hash per captured file along each ancestor
 * path, depth-capped). Absolute paths stay transient.
 */
function revalidateCapturedChildSnapshots(snapshots) {
  if (!Array.isArray(snapshots)) return { ok: true };
  for (const snapshot of snapshots) {
    if (!snapshot || typeof snapshot !== "object") continue;
    if (snapshot.kind === "file") {
      const fileCheck = revalidateCapturedFileSnapshot(snapshot);
      if (!fileCheck.ok) return fileCheck;
      continue;
    }
    if (snapshot.kind === "symlink") {
      const hopCheck = revalidateMetadataSymlinkHops(
        snapshot.hops,
        snapshot.finalAbsolute,
        snapshot.finalSignature,
        snapshot.maxHops
      );
      if (!hopCheck.ok) return { ok: false, reason: hopCheck.reason || "retargeted" };
      if (snapshot.targetKind === "file") {
        const fileCheck = revalidateCapturedFileSnapshot({
          kind: "file",
          absolute: snapshot.finalAbsolute,
          mode: snapshot.targetMode,
          size: snapshot.targetSize,
          digest: snapshot.targetDigest
        });
        if (!fileCheck.ok) return fileCheck;
      } else if (snapshot.targetKind === "directory") {
        const dirCheck = revalidateBoundedDirectorySnapshot(
          snapshot.finalAbsolute,
          snapshot.directorySignature,
          snapshot.names
        );
        if (!dirCheck.ok) return dirCheck;
        const childCheck = revalidateCapturedChildSnapshots(snapshot.children);
        if (!childCheck.ok) return childCheck;
      }
      continue;
    }
    if (snapshot.kind === "directory") {
      const dirCheck = revalidateBoundedDirectorySnapshot(
        snapshot.absolute,
        snapshot.directorySignature,
        snapshot.names
      );
      if (!dirCheck.ok) return dirCheck;
      const childCheck = revalidateCapturedChildSnapshots(snapshot.children);
      if (!childCheck.ok) return childCheck;
    }
  }
  return { ok: true };
}

/**
 * Revalidate top-level optional root witnesses after a fixed capture batch.
 *
 * Stable absence is valid and remains complete, but every absent root must be
 * re-lstat'd so a root that appears after its early ENOENT fails closed.
 * Present roots re-use the same bounded child/file/symlink revalidation so
 * disappearance, replace, or mutation while later siblings are hashed also
 * fails closed. Absolute paths stay transient and never enter public records.
 */
function revalidateOptionalRootWitnesses(witnesses, state) {
  if (!Array.isArray(witnesses)) {
    state.unreadable = true;
    return;
  }
  for (const witness of witnesses) {
    if (!witness || typeof witness !== "object" || typeof witness.kind !== "string") {
      state.unreadable = true;
      return;
    }
    if (witness.kind === "absent") {
      if (typeof witness.absolute !== "string" || !witness.absolute) {
        state.unreadable = true;
        return;
      }
      try {
        fs.lstatSync(witness.absolute);
        // Optional root appeared after its batch-start absence witness.
        state.unreadable = true;
        return;
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        state.unreadable = true;
        return;
      }
    }
    if (witness.kind === "file" || witness.kind === "directory" || witness.kind === "symlink") {
      const check = revalidateCapturedChildSnapshots([witness]);
      if (!check.ok) {
        state.unreadable = true;
        return;
      }
      continue;
    }
    if (witness.kind === "other-root") {
      if (typeof witness.absolute !== "string" || !witness.absolute) {
        state.unreadable = true;
        return;
      }
      let stat;
      try {
        stat = fs.lstatSync(witness.absolute);
      } catch {
        state.unreadable = true;
        return;
      }
      // Type replacement (became file/dir/symlink) is drift.
      if (stat.isFile() || stat.isDirectory() || stat.isSymbolicLink()) {
        state.unreadable = true;
        return;
      }
      continue;
    }
    if (witness.kind === "legacy-present") {
      if (typeof witness.absolute !== "string" || !witness.absolute) {
        state.unreadable = true;
        return;
      }
      let stat;
      try {
        stat = fs.lstatSync(witness.absolute, { bigint: true });
      } catch {
        state.unreadable = true;
        return;
      }
      if (witness.nodeKind === "file") {
        if (!stat.isFile() || stat.isSymbolicLink()) {
          state.unreadable = true;
          return;
        }
        const fileCheck = revalidateCapturedFileSnapshot({
          kind: "file",
          absolute: witness.absolute,
          mode: witness.mode,
          size: witness.size,
          digest: witness.digest
        });
        if (!fileCheck.ok) {
          state.unreadable = true;
          return;
        }
        continue;
      }
      if (witness.nodeKind === "symlink") {
        if (!stat.isSymbolicLink()) {
          state.unreadable = true;
          return;
        }
        if (metadataSymlinkStatSignature(stat) !== witness.signature) {
          state.unreadable = true;
          return;
        }
        let linkText;
        try {
          linkText = fs.readlinkSync(witness.absolute);
        } catch {
          state.unreadable = true;
          return;
        }
        if (sha(String(linkText)) !== witness.linkDigest) {
          state.unreadable = true;
          return;
        }
        continue;
      }
      if (witness.nodeKind === "directory") {
        const dirCheck = revalidateBoundedDirectorySnapshot(
          witness.absolute,
          witness.directorySignature,
          witness.names
        );
        if (!dirCheck.ok) {
          state.unreadable = true;
          return;
        }
        continue;
      }
      if (witness.nodeKind === "other") {
        if (stat.isFile() || stat.isDirectory() || stat.isSymbolicLink()) {
          state.unreadable = true;
          return;
        }
        continue;
      }
      state.unreadable = true;
      return;
    }
    state.unreadable = true;
    return;
  }
}

function visitBoundedMetadataSymlink(
  absolute,
  relativeKey,
  key,
  depth,
  chain,
  state,
  stat,
  childVisitOptions
) {
  const { maxBytes, maxEntries, maxHops } = childVisitOptions;
  const mode = stat.mode & 0o7777;
  const resolved = resolveMetadataSymlinkChain(absolute, chain, maxHops);
  if (!resolved.ok) {
    applyMetadataSymlinkFailure(state, resolved.reason);
    state.entries.push({
      path: key,
      kind: "symlink",
      mode,
      linkDigests: resolved.linkDigests,
      target: { kind: "unobservable", reason: resolved.reason }
    });
    return null;
  }
  const {
    linkDigests,
    hops,
    finalAbsolute,
    finalStat,
    finalSignature,
    chain: nextChain
  } = resolved;
  const finalMode = Number(finalStat.mode & 0o7777n);
  if (finalStat.isFile()) {
    // Hash the resolved target first, then revalidate every hop so an
    // atomic retarget at open/hash boundaries cannot bind old link digests
    // to a target that is no longer live.
    const target = hashBoundedMetadataFile(finalAbsolute, state, maxBytes);
    const recheck = revalidateMetadataSymlinkHops(
      hops,
      finalAbsolute,
      finalSignature,
      maxHops
    );
    if (!recheck.ok) {
      applyMetadataSymlinkFailure(state, recheck.reason);
      state.entries.push({
        path: key,
        kind: "symlink",
        mode,
        linkDigests,
        target: { kind: "unobservable", reason: recheck.reason }
      });
      return null;
    }
    if (target.kind === "unobservable") {
      state.entries.push({
        path: key,
        kind: "symlink",
        mode,
        linkDigests,
        target
      });
      return null;
    }
    const publicTarget = publicMetadataFileTarget(target);
    state.entries.push({
      path: key,
      kind: "symlink",
      mode,
      linkDigests,
      target: publicTarget
    });
    return {
      kind: "symlink",
      hops,
      finalAbsolute,
      finalSignature,
      maxHops,
      targetKind: "file",
      targetMode: target.mode,
      targetSize: target.size,
      targetDigest: target.digest
    };
  }
  if (finalStat.isDirectory()) {
    const directoryEntryIndex = state.entries.length;
    state.entries.push({
      path: key,
      kind: "symlink",
      mode,
      linkDigests,
      target: { kind: "directory", mode: finalMode }
    });
    const finalResolved = path.resolve(finalAbsolute);
    if (chain.has(finalResolved)) {
      state.cyclic = true;
      return null;
    }
    let listed;
    try {
      listed = listDirectoryNamesBounded(
        finalAbsolute,
        maxEntries - state.entries.length
      );
    } catch {
      state.unreadable = true;
      return null;
    }
    if (listed.truncated) {
      state.truncated = true;
      return null;
    }
    const childSnapshots = [];
    for (const name of listed.names) {
      if (state.entries.length >= maxEntries || state.truncated) {
        state.truncated = true;
        break;
      }
      const childKey = relativeKey ? `${relativeKey}/${name}` : name;
      const childSnap = visitBoundedMetadataTree(
        path.join(finalAbsolute, name),
        childKey,
        depth + 1,
        nextChain,
        state,
        childVisitOptions
      );
      if (childSnap) childSnapshots.push(childSnap);
    }
    // Revalidate membership, already-captured children, then symlink hops.
    if (!state.truncated) {
      const dirRecheck = revalidateBoundedDirectorySnapshot(
        finalAbsolute,
        listed.directorySignature,
        listed.names
      );
      if (!dirRecheck.ok) {
        state.unreadable = true;
        const entry = state.entries[directoryEntryIndex];
        if (entry && entry.kind === "symlink" && entry.path === key) {
          entry.target = { kind: "unobservable", reason: dirRecheck.reason };
        }
      } else {
        const childRecheck = revalidateCapturedChildSnapshots(childSnapshots);
        if (!childRecheck.ok) {
          state.unreadable = true;
          const entry = state.entries[directoryEntryIndex];
          if (entry && entry.kind === "symlink" && entry.path === key) {
            entry.target = { kind: "unobservable", reason: childRecheck.reason };
          }
        }
      }
    }
    const recheck = revalidateMetadataSymlinkHops(
      hops,
      finalAbsolute,
      finalSignature,
      maxHops
    );
    if (!recheck.ok) {
      applyMetadataSymlinkFailure(state, recheck.reason);
      // Mark the symlink entry itself unobservable; children may already
      // be recorded from the pre-retarget target — fail closed via flags.
      const entry = state.entries[directoryEntryIndex];
      if (entry && entry.kind === "symlink" && entry.path === key) {
        entry.target = { kind: "unobservable", reason: recheck.reason };
      }
      return null;
    }
    return {
      kind: "symlink",
      hops,
      finalAbsolute,
      finalSignature,
      maxHops,
      targetKind: "directory",
      directorySignature: listed.directorySignature,
      names: listed.names,
      children: childSnapshots
    };
  }
  // Non-file/dir final nodes: still revalidate hops so retarget races
  // cannot freeze a stale other-node snapshot as complete.
  const recheckOther = revalidateMetadataSymlinkHops(
    hops,
    finalAbsolute,
    finalSignature,
    maxHops
  );
  if (!recheckOther.ok) {
    applyMetadataSymlinkFailure(state, recheckOther.reason);
    state.entries.push({
      path: key,
      kind: "symlink",
      mode,
      linkDigests,
      target: { kind: "unobservable", reason: recheckOther.reason }
    });
    return null;
  }
  state.entries.push({
    path: key,
    kind: "symlink",
    mode,
    linkDigests,
    target: { kind: "other", mode: finalMode }
  });
  return {
    kind: "symlink",
    hops,
    finalAbsolute,
    finalSignature,
    maxHops,
    targetKind: "other"
  };
}

function visitBoundedMetadataDirectory(
  absolute,
  relativeKey,
  key,
  depth,
  chain,
  state,
  stat,
  childVisitOptions
) {
  const { maxEntries } = childVisitOptions;
  if (relativeKey !== "") {
    state.entries.push({ path: key, kind: "directory", mode: stat.mode & 0o7777 });
  }
  const dirResolved = path.resolve(absolute);
  if (chain.has(dirResolved)) {
    state.cyclic = true;
    return null;
  }
  const nextChain = new Set(chain);
  nextChain.add(dirResolved);
  let listed;
  try {
    listed = listDirectoryNamesBounded(absolute, maxEntries - state.entries.length);
  } catch {
    state.unreadable = true;
    return null;
  }
  if (listed.truncated) {
    state.truncated = true;
    return null;
  }
  const childSnapshots = [];
  for (const name of listed.names) {
    if (state.entries.length >= maxEntries || state.truncated) {
      state.truncated = true;
      break;
    }
    const childKey = relativeKey ? `${relativeKey}/${name}` : name;
    const childSnap = visitBoundedMetadataTree(
      path.join(absolute, name),
      childKey,
      depth + 1,
      nextChain,
      state,
      childVisitOptions
    );
    if (childSnap) childSnapshots.push(childSnap);
  }
  // Ordinary non-symlink directories: re-bind identity/membership, then
  // revalidate already-captured children so sibling-after-hash content/mode
  // drift fails closed even when parent dir stat/name set is unchanged.
  if (!state.truncated) {
    const dirRecheck = revalidateBoundedDirectorySnapshot(
      absolute,
      listed.directorySignature,
      listed.names
    );
    if (!dirRecheck.ok) {
      state.unreadable = true;
    } else {
      const childRecheck = revalidateCapturedChildSnapshots(childSnapshots);
      if (!childRecheck.ok) {
        state.unreadable = true;
      }
    }
  }
  return {
    kind: "directory",
    absolute,
    directorySignature: listed.directorySignature,
    names: listed.names,
    children: childSnapshots
  };
}

/**
 * Walk a metadata path tree binding symlink link-text digests and target
 * contents with entry/byte/depth/hop bounds and cycle detection. After file
 * target hashing and after directory traversal, every original symlink hop is
 * re-lstat/readlink-validated (identity + link digest) and the final target
 * path identity is rechecked so retarget/mutation races fail closed. Ordinary
 * (non-symlink) directories bind bigint identity around enumeration and
 * revalidate the bounded name set after traversal so post-EOF growth and
 * listed-child disappearance fail closed. After a directory subtree is
 * captured, already-captured child identities (ordinary files and symlink
 * hops/final targets) are revalidated so sibling-after-hash drift fails closed.
 * Ordinary file entries serialize only descriptor-validated mode/size/digest.
 * Optional top-level roots that were absent before capture still treat ENOENT
 * as normal absence (returning a private absent witness for post-batch
 * revalidation); children already present in a bounded listing are required.
 * Absolute paths and raw link text never enter the returned entry records.
 * Returns a transient private child/root snapshot for parent/batch revalidation
 * (or null when the visit failed without a reusable witness).
 */
function visitBoundedMetadataTree(absolute, relativeKey, depth, chain, state, {
  maxDepth = MAX_METADATA_DEPTH,
  maxBytes = MAX_METADATA_HASH_BYTES,
  maxEntries = MAX_GIT_METADATA_ENTRIES,
  maxHops = MAX_METADATA_SYMLINK_HOPS,
  // When true, ENOENT means a listed child disappeared mid-capture (fail closed)
  // rather than an optional metadata root that was absent before listing.
  required = false
} = {}) {
  if (state.entries.length >= maxEntries) {
    state.truncated = true;
    return null;
  }
  if (depth > maxDepth) {
    state.depthExceeded = true;
    return null;
  }
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (required) {
        state.unreadable = true;
        return null;
      }
      // Optional root absence is valid; caller rechecks after the full batch.
      return { kind: "absent", absolute };
    }
    state.unreadable = true;
    return null;
  }
  const key = relativeKey || ".";
  const childVisitOptions = {
    maxDepth,
    maxBytes,
    maxEntries,
    maxHops,
    required: true
  };
  try {
    if (stat.isSymbolicLink()) {
      return visitBoundedMetadataSymlink(
        absolute,
        relativeKey,
        key,
        depth,
        chain,
        state,
        stat,
        childVisitOptions
      );
    }
    if (stat.isFile()) {
      // Serialize only descriptor-validated identity — never pre-open lstat mode.
      const fileIdentity = hashBoundedMetadataFile(absolute, state, maxBytes);
      if (fileIdentity.kind === "unobservable") {
        state.entries.push({
          path: key,
          kind: "file",
          target: fileIdentity
        });
        return null;
      }
      state.entries.push({
        path: key,
        kind: "file",
        mode: fileIdentity.mode,
        size: fileIdentity.size,
        digest: fileIdentity.digest
      });
      return {
        kind: "file",
        absolute,
        mode: fileIdentity.mode,
        size: fileIdentity.size,
        digest: fileIdentity.digest
      };
    }
    if (!stat.isDirectory()) {
      state.entries.push({ path: key, kind: "other", mode: stat.mode & 0o7777 });
      // Top-level optional "other" nodes still need a batch presence witness.
      return { kind: "other-root", absolute };
    }
    return visitBoundedMetadataDirectory(
      absolute,
      relativeKey,
      key,
      depth,
      chain,
      state,
      stat,
      childVisitOptions
    );
  } catch {
    state.unreadable = true;
    return null;
  }
}

export {
  MAX_GIT_METADATA_ENTRIES,
  MAX_LOOSE_REF_BODY_BYTES,
  MAX_METADATA_DEPTH,
  MAX_METADATA_HASH_BYTES,
  MAX_METADATA_SYMLINK_HOPS,
  hashBoundedMetadataFile,
  listDirectoryNamesBounded,
  metadataLexicalNodeStableSignature,
  metadataSymlinkStatSignature,
  readBoundedNofollowTextFile,
  revalidateBoundedDirectorySnapshot,
  revalidateOptionalRootWitnesses,
  visitBoundedMetadataTree
};
