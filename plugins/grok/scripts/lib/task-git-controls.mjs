import fs from "node:fs";
import path from "node:path";

import { git } from "./workspace.mjs";
import { canonicalJson, sha } from "./task-contract-primitives.mjs";
import {
  MAX_GIT_METADATA_ENTRIES,
  MAX_METADATA_DEPTH,
  MAX_METADATA_HASH_BYTES,
  MAX_METADATA_SYMLINK_HOPS,
  hashBoundedMetadataFile,
  listDirectoryNamesBounded,
  metadataLexicalNodeStableSignature,
  metadataSymlinkStatSignature,
  revalidateBoundedDirectorySnapshot,
  revalidateOptionalRootWitnesses,
  visitBoundedMetadataTree
} from "./task-context-filesystem.mjs";

const MAX_HOOKS_HASH_BYTES = MAX_METADATA_HASH_BYTES;
const MAX_HOOKS_DEPTH = 8;
const MAX_HOOKS_SYMLINK_HOPS = MAX_METADATA_SYMLINK_HOPS;
/**
 * Bound for lexical hooksPath path components (ordinary dirs + symlink hops).
 * Higher than symlink-only hop limits so deep absolute temp paths remain observable.
 */
const MAX_LEXICAL_PATH_COMPONENTS = 64;
/** Cap for effective local/worktree config key/value pairs before fail-closed truncation. */
const MAX_CONFIG_ENTRIES = 10_000;
/** Cap for total effective config value bytes before fail-closed truncation. */
const MAX_CONFIG_VALUE_BYTES = MAX_METADATA_HASH_BYTES;

/**
 * Worktree-local operational pseudorefs and multi-step sequencer/rebase state.
 * Hashed from the effective worktree Git directory (not the shared common dir).
 *
 * Audited task-relevant controls (issue #34):
 * - Merge: MERGE_HEAD, MERGE_MODE, MERGE_MSG, MERGE_AUTOSTASH, MERGE_RR
 * - Cherry-pick / revert / rebase heads and directories
 * - AUTO_MERGE conflict materialization, bisect state, sequencer
 * - SQUASH_MSG (squash-merge in progress)
 *
 * Audited standard bisect controls (behavior-bearing only — not arbitrary
 * unbounded BISECT_* enumeration). Includes every control path Git writes for
 * interactive / scripted / first-parent bisect that affects resume semantics:
 *   BISECT_LOG, BISECT_EXPECTED_REV, BISECT_START, BISECT_TERMS, BISECT_RUN,
 *   BISECT_HEAD, BISECT_NAMES, BISECT_FIRST_PARENT, BISECT_ANCESTORS_OK
 *
 * OID-bearing root pseudorefs are also resolved via Git exactly (backend-aware
 * include-root-refs / non-DWIM rev-parse) so reftable repositories cannot hide
 * BISECT_HEAD / MERGE_HEAD drift that has no loose file, and refs/tags/BISECT_HEAD
 * cannot masquerade as the root. Volatile logs (FETCH_HEAD, ORIG_HEAD, logs/**,
 * COMMIT_EDITMSG) are intentionally omitted — they change on routine fetch/commit
 * without representing multi-step operation state.
 */
const WORKTREE_OPERATIONAL_PATHS = Object.freeze([
  "MERGE_HEAD",
  "MERGE_MODE",
  "MERGE_MSG",
  "MERGE_AUTOSTASH",
  "MERGE_RR",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "AUTO_MERGE",
  "BISECT_LOG",
  "BISECT_EXPECTED_REV",
  "BISECT_START",
  "BISECT_TERMS",
  "BISECT_RUN",
  "BISECT_HEAD",
  "BISECT_NAMES",
  "BISECT_FIRST_PARENT",
  "BISECT_ANCESTORS_OK",
  "SQUASH_MSG",
  "sequencer",
  "rebase-apply",
  "rebase-merge"
]);
/**
 * Fixed OID-bearing root pseudorefs resolved through Git so loose-file and
 * reftable backends both observe create/change/remove. Not an open-ended
 * BISECT_* enumeration — only the audited operational set.
 */
const WORKTREE_OPERATIONAL_PSEUDOREFS = Object.freeze([
  "MERGE_HEAD",
  "MERGE_AUTOSTASH",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "AUTO_MERGE",
  "BISECT_HEAD"
]);

function gitMetadataIdentity(gitDir, commonDir) {
  const entries = [];
  const state = {
    hashedBytes: 0,
    truncated: false,
    unreadable: false,
    depthExceeded: false
  };
  const roots = [
    [gitDir, ["HEAD", "commondir", "gitdir"]],
    [commonDir, ["config", "packed-refs", "refs", "hooks", "info/exclude", "info/attributes"]]
  ];
  visitGitMetadataEntries(entries, gitDir, commonDir, roots, state);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const truncated = state.truncated
    || state.unreadable
    || state.depthExceeded
    || entries.length >= MAX_GIT_METADATA_ENTRIES;
  return sha(canonicalJson({ entries, truncated }));
}

/**
 * Bigint-capable identity for a symlink hop (device/inode/mode/size/times).
 * Used only in transient private structures — never serialized publicly.
 */

function createMetadataVisitState() {
  return {
    entries: [],
    hashedBytes: 0,
    depthExceeded: false,
    unreadable: false,
    truncated: false,
    cyclic: false
  };
}

/**
 * Task-relevant non-ref metadata: worktree-local Git controls, shared config/
 * info, and semantic controls (shallow/grafts/alternates). Symlink entries bind
 * both link identity and target contents (cycle/bound safe). Refs are not
 * hashed as files; they are classified semantically via for-each-ref. Effective
 * hooks and effective included config are captured separately.
 *
 * Includes the effective worktree `info/sparse-checkout` control file so
 * linked/primary sparse pattern drift changes task-relevant identity. Cone and
 * index sparse settings bind through the separately captured effective config.
 * Top-level optional roots (present and absent) are revalidated after the full
 * batch so mid-capture appearance/disappearance fails closed.
 */
function captureTaskRelevantNonRefEntries(gitDir, commonDir) {
  const state = createMetadataVisitState();
  const roots = [
    [gitDir, [
      "HEAD",
      "commondir",
      "gitdir",
      "config.worktree",
      // Effective worktree sparse-checkout patterns (private digest only).
      "info/sparse-checkout"
    ]],
    [commonDir, [
      "config",
      "info/exclude",
      "info/attributes",
      "info/grafts",
      "shallow",
      "objects/info/alternates"
    ]]
  ];
  const rootWitnesses = [];
  for (const [base, relatives] of roots) {
    if (!base) {
      state.unreadable = true;
      continue;
    }
    for (const relative of relatives) {
      const key = `${base === gitDir ? "git" : "common"}/${relative.replace(/\\/g, "/")}`;
      const witness = visitBoundedMetadataTree(
        path.join(base, relative),
        key,
        0,
        new Set(),
        state
      );
      if (witness) rootWitnesses.push(witness);
    }
  }
  // Final present/absent revalidation of the complete non-ref root set.
  if (!state.truncated && !state.depthExceeded) {
    revalidateOptionalRootWitnesses(rootWitnesses, state);
  }
  state.entries.sort((left, right) => left.path.localeCompare(right.path));
  const failClosed = state.truncated
    || state.depthExceeded
    || state.unreadable
    || state.cyclic
    || state.entries.length >= MAX_GIT_METADATA_ENTRIES;
  return {
    entries: state.entries,
    truncated: failClosed,
    observable: !failClosed,
    identity: sha(canonicalJson({
      schema: "nonref-v2",
      entries: state.entries,
      truncated: failClosed,
      depthExceeded: state.depthExceeded,
      unreadable: state.unreadable,
      cyclic: state.cyclic
    }))
  };
}

/**
 * Resolve a fixed OID-bearing operational root pseudoref exactly.
 *
 * Never accepts DWIM tag/branch resolution and never ignores ambiguity stderr.
 * Prefer `for-each-ref --include-root-refs` (exact root inventory, backend-aware
 * for reftable and files). Fall back to rev-parse without --quiet plus
 * symbolic-full-name === name so refs/tags/BISECT_HEAD cannot masquerade as the
 * root. Status non-zero / empty include-root inventory is stable absence.
 *
 * @returns {{ kind: "absent" } | { kind: "oid", oidDigest: string } | { kind: "unobservable" }}
 */
function resolveExactRootPseudoref(workspaceRoot, name) {
  if (!workspaceRoot || typeof name !== "string" || !name) {
    return { kind: "unobservable" };
  }

  // Exact root-ref inventory when Git supports it (reftable + files).
  const includeRun = git(
    workspaceRoot,
    [
      "for-each-ref",
      "--include-root-refs",
      "--format=%(refname)%00%(objectname)%0a",
      "--",
      name
    ],
    { allowFailure: true }
  );
  const includeStderr = String(includeRun.stderr || "");
  const includeUnsupported = Boolean(includeRun.error)
    || includeRun.status === 129
    || /unknown option|include-root-refs/i.test(includeStderr);
  if (!includeUnsupported) {
    // Hard command failure or any diagnostic is unobservable. In particular,
    // never reinterpret a malformed root pseudoref warning as stable absence.
    if (includeRun.status !== 0 && includeRun.status !== 1) {
      return { kind: "unobservable" };
    }
    if (includeStderr.trim()) {
      return { kind: "unobservable" };
    }
    let matchedOid = null;
    for (const line of String(includeRun.stdout || "").split("\n")) {
      if (!line) continue;
      const parts = line.split("\0");
      const refname = parts[0] || "";
      const objectname = String(parts[1] || "").trim().toLowerCase();
      if (refname !== name) {
        // An exact root-name query must not surface a different ref.
        return { kind: "unobservable" };
      }
      if (!/^[a-f0-9]{40,64}$/.test(objectname)) {
        return { kind: "unobservable" };
      }
      if (matchedOid && matchedOid !== objectname) {
        return { kind: "unobservable" };
      }
      matchedOid = objectname;
    }
    if (matchedOid) {
      return { kind: "oid", oidDigest: sha(matchedOid) };
    }
    return { kind: "absent" };
  }

  // Fallback: rev-parse without --quiet so ambiguity diagnostics surface.
  const run = git(
    workspaceRoot,
    ["rev-parse", "--verify", "--end-of-options", name],
    { allowFailure: true }
  );
  if (run.error) return { kind: "unobservable" };
  if (run.status !== 0) {
    // Missing root pseudoref is normal. Do not interpret fatal stderr as a race.
    return { kind: "absent" };
  }
  // Present resolves must be quiet and unambiguous.
  if (String(run.stderr || "").trim()) {
    return { kind: "unobservable" };
  }
  const oid = String(run.stdout || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(oid)) {
    return { kind: "unobservable" };
  }
  // Confirm Git resolved the root name, not refs/tags/NAME (DWIM).
  const fullRun = git(
    workspaceRoot,
    ["rev-parse", "--verify", "--symbolic-full-name", "--end-of-options", name],
    { allowFailure: true }
  );
  if (fullRun.error) return { kind: "unobservable" };
  if (String(fullRun.stderr || "").trim()) {
    return { kind: "unobservable" };
  }
  if (fullRun.status !== 0) {
    // OID resolved but full name did not — untrustworthy for exact root capture.
    return { kind: "unobservable" };
  }
  const fullName = String(fullRun.stdout || "").trim();
  if (fullName !== name) {
    // DWIM to refs/tags/BISECT_HEAD (etc.) — root pseudoref is absent.
    return { kind: "absent" };
  }
  return { kind: "oid", oidDigest: sha(oid) };
}

/**
 * Backend-aware capture of fixed OID-bearing operational root pseudorefs.
 * Uses exact Git resolution so reftable backends (no loose BISECT_HEAD file)
 * still observe create/change/remove, and DWIM tag resolution / ambiguity
 * stderr cannot hide root create or remove. Stable absence is valid. Results
 * are private digests only — never raw paths. Revalidates after the batch so
 * mid-capture races fail closed.
 */
function captureOperationalPseudorefIdentity(workspaceRoot) {
  if (!workspaceRoot) {
    return { records: [], complete: false, observable: false };
  }
  const records = [];
  let unreadable = false;
  for (const name of WORKTREE_OPERATIONAL_PSEUDOREFS) {
    const resolved = resolveExactRootPseudoref(workspaceRoot, name);
    if (resolved.kind === "unobservable") {
      unreadable = true;
      records.push({ name, kind: "unobservable" });
      continue;
    }
    if (resolved.kind === "absent") {
      records.push({ name, kind: "absent" });
      continue;
    }
    // Digest only — identity structure stays private via outer hash.
    records.push({ name, kind: "oid", oidDigest: resolved.oidDigest });
  }
  // Revalidate the complete fixed set after capture (appear/disappear/mutate/DWIM).
  if (!unreadable) {
    for (const record of records) {
      const resolved = resolveExactRootPseudoref(workspaceRoot, record.name);
      if (resolved.kind === "unobservable") {
        unreadable = true;
        break;
      }
      if (record.kind === "absent") {
        if (resolved.kind !== "absent") {
          unreadable = true;
          break;
        }
        continue;
      }
      if (record.kind === "oid") {
        if (resolved.kind !== "oid" || resolved.oidDigest !== record.oidDigest) {
          unreadable = true;
          break;
        }
        continue;
      }
      unreadable = true;
      break;
    }
  }
  records.sort((left, right) => left.name.localeCompare(right.name));
  const failClosed = unreadable;
  return {
    records,
    complete: !failClosed,
    observable: !failClosed,
    identity: sha(canonicalJson({
      schema: "operational-pseudorefs-v2",
      records,
      unreadable: failClosed
    }))
  };
}

/**
 * Hash task-relevant worktree operational state (MERGE_HEAD, MERGE_AUTOSTASH,
 * sequencer/rebase, and related controls) from the effective worktree Git
 * directory plus backend-aware Git resolution of OID-bearing root pseudorefs.
 * Symlinks bind link text and target contents. Changes must surface as
 * task-relevant metadata drift even when unrelated shared refs also change.
 * Present and absent top-level operational roots are witnessed and revalidated
 * after the full fixed inventory so mid-batch create/remove/replace races fail
 * closed without treating stable absence as an error.
 */
function captureWorktreeOperationalIdentity(gitDir, workspaceRoot = null) {
  if (!gitDir) {
    return {
      identity: sha("operational-v2:unavailable"),
      truncated: true,
      observable: false
    };
  }
  const state = createMetadataVisitState();
  const rootWitnesses = [];
  for (const relative of WORKTREE_OPERATIONAL_PATHS) {
    const witness = visitBoundedMetadataTree(
      path.join(gitDir, relative),
      relative.replace(/\\/g, "/"),
      0,
      new Set(),
      state
    );
    if (witness) rootWitnesses.push(witness);
  }
  // Final present/absent revalidation of the complete operational root set.
  if (!state.truncated && !state.depthExceeded) {
    revalidateOptionalRootWitnesses(rootWitnesses, state);
  }
  state.entries.sort((left, right) => left.path.localeCompare(right.path));
  const pseudorefs = captureOperationalPseudorefIdentity(workspaceRoot || null);
  const failClosed = state.truncated
    || state.depthExceeded
    || state.unreadable
    || state.cyclic
    || state.entries.length >= MAX_GIT_METADATA_ENTRIES
    || !pseudorefs.observable
    || !pseudorefs.complete;
  return {
    identity: sha(canonicalJson({
      schema: "operational-v3",
      entries: state.entries,
      pseudorefIdentity: pseudorefs.identity,
      truncated: failClosed,
      depthExceeded: state.depthExceeded,
      unreadable: state.unreadable,
      cyclic: state.cyclic
    })),
    truncated: failClosed,
    observable: !failClosed
  };
}

function failClosedConfigIdentity(token) {
  return {
    identity: sha(`config-v1:${token}`),
    observable: false,
    truncated: true
  };
}

/**
 * Locate the optional worktree config file. Enabling
 * `extensions.worktreeConfig` does not create `config.worktree`; absence is a
 * complete empty scope. Any other path/stat failure stays fail-closed.
 */
function observeWorktreeConfigFile(workspaceRoot) {
  const pathRun = git(
    workspaceRoot,
    ["rev-parse", "--path-format=absolute", "--git-path", "config.worktree"],
    { allowFailure: true }
  );
  if (pathRun.error || pathRun.status !== 0) {
    return { ok: false, token: "worktree-path-unreadable" };
  }
  const absolute = String(pathRun.stdout || "").trim();
  if (!absolute || !path.isAbsolute(absolute)) {
    return { ok: false, token: "worktree-path-unreadable" };
  }
  try {
    fs.lstatSync(absolute);
    return { ok: true, present: true, absolute };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: true, present: false, absolute };
    }
    return { ok: false, token: "worktree-unreadable" };
  }
}

function revalidateWorktreeConfigPresence(absolute, expectedPresent) {
  const state = { unreadable: false };
  if (expectedPresent) {
    try {
      fs.lstatSync(absolute);
      return { ok: true };
    } catch {
      return { ok: false, token: "worktree-disappeared" };
    }
  }
  revalidateOptionalRootWitnesses([{ kind: "absent", absolute }], state);
  if (state.unreadable) {
    return { ok: false, token: "worktree-appeared" };
  }
  return { ok: true };
}

/**
 * Private digest of effective repository/worktree Git config with includes
 * resolved by Git (`--includes`). Only key/value digests are retained — never
 * raw values, origins, absolute paths, credentials, or included file
 * contents/paths. Entry and byte budgets are enforced across the combined
 * local+worktree inventory. Fail closed on resolution, read, parse, size, or
 * observability errors.
 */
function captureEffectiveGitConfigIdentity(workspaceRoot) {
  const scopes = [];
  let totalEntries = 0;
  let totalValueBytes = 0;
  let truncated = false;
  let unreadable = false;

  const parseNullConfigList = (stdout) => {
    const pairs = [];
    if (truncated) return pairs;
    const raw = String(stdout || "");
    if (!raw) return pairs;
    // git config --list --null: each record is "key\nvalue\0"
    for (const record of raw.split("\0")) {
      if (!record) continue;
      const nl = record.indexOf("\n");
      if (nl < 0) {
        unreadable = true;
        continue;
      }
      const key = record.slice(0, nl);
      const value = record.slice(nl + 1);
      if (!key || key.length > 1024) {
        unreadable = true;
        continue;
      }
      const valueBytes = Buffer.byteLength(value, "utf8");
      // One total bounded inventory across local + worktree scopes.
      if (totalEntries >= MAX_CONFIG_ENTRIES || totalValueBytes + valueBytes > MAX_CONFIG_VALUE_BYTES) {
        truncated = true;
        break;
      }
      totalEntries += 1;
      totalValueBytes += valueBytes;
      // Digest only — keys may embed includeIf gitdir absolute paths; values may
      // hold credentials or absolute include targets.
      pairs.push({
        index: totalEntries - 1,
        keyDigest: sha(key),
        valueDigest: sha(value)
      });
    }
    return pairs;
  };

  // Local (repository) config with includes explicitly resolved. Required.
  const localRun = git(
    workspaceRoot,
    ["config", "--local", "--includes", "--list", "--null"],
    { allowFailure: true, maxBuffer: 16 * 1024 * 1024 }
  );
  if (localRun.error || localRun.status !== 0) {
    return {
      identity: sha("config-v1:local-resolution-failed"),
      observable: false,
      truncated: true
    };
  }
  scopes.push({
    scope: "local",
    pairs: parseNullConfigList(localRun.stdout)
  });

  // Worktree config only when extensions.worktreeConfig is enabled.
  let worktreeEnabled = false;
  const worktreeFlag = git(
    workspaceRoot,
    ["config", "--local", "--bool", "extensions.worktreeConfig"],
    { allowFailure: true }
  );
  if (!worktreeFlag.error && worktreeFlag.status === 0) {
    worktreeEnabled = String(worktreeFlag.stdout || "").trim() === "true";
  } else if (worktreeFlag.error) {
    return {
      identity: sha("config-v1:worktree-flag-unreadable"),
      observable: false,
      truncated: true
    };
  }

  if (worktreeEnabled) {
    const file = observeWorktreeConfigFile(workspaceRoot);
    if (!file.ok) return failClosedConfigIdentity(file.token);
    if (!file.present) {
      const recheck = revalidateWorktreeConfigPresence(file.absolute, false);
      if (!recheck.ok) return failClosedConfigIdentity(recheck.token);
      // Feature enabled, file absent: complete empty worktree-config scope.
      // Distinct from disabled (`enabled: false`) and from a present file.
      scopes.push({
        scope: "worktree",
        pairs: [],
        enabled: true,
        present: false
      });
    } else {
      const worktreeRun = git(
        workspaceRoot,
        ["config", "--worktree", "--includes", "--list", "--null"],
        { allowFailure: true, maxBuffer: 16 * 1024 * 1024 }
      );
      // Present file: never treat a git-config failure as empty absence.
      if (worktreeRun.error || worktreeRun.status !== 0) {
        return failClosedConfigIdentity("worktree-resolution-failed");
      }
      const recheck = revalidateWorktreeConfigPresence(file.absolute, true);
      if (!recheck.ok) return failClosedConfigIdentity(recheck.token);
      scopes.push({
        scope: "worktree",
        pairs: parseNullConfigList(worktreeRun.stdout),
        enabled: true,
        present: true
      });
    }
  } else {
    scopes.push({ scope: "worktree", pairs: [], enabled: false });
  }

  const failClosed = truncated || unreadable;
  return {
    identity: sha(canonicalJson({
      schema: "config-v1",
      scopes,
      totalEntries,
      truncated: failClosed,
      unreadable
    })),
    observable: !failClosed,
    truncated: failClosed
  };
}

/**
 * Bind every lexical component along a configured absolute path (ancestors and
 * final): ordinary directories, regular files, and symlinks. Used for
 * core.hooksPath so swapping an ordinary ancestor to a symlink (or retargeting
 * a symlink) changes identity even when final hook bytes are identical.
 * Each hop keeps a stable node signature (dev/ino/mode) for same-capture
 * revalidation and cross-capture identity so unrelated sibling activity under
 * an ancestor (nlink/size/mtime/ctime) cannot fail-close or drift hooks.
 * Symlink hops also bind linkDigest for retarget detection.
 * Bounded by maxComponents; absolute paths and raw link text stay private.
 */
function captureLexicalPathSymlinkHops(absolutePath, maxComponents = MAX_LEXICAL_PATH_COMPONENTS) {
  if (typeof absolutePath !== "string" || !absolutePath || !path.isAbsolute(absolutePath)) {
    return { ok: false, reason: "invalid", hops: [] };
  }
  const hops = [];
  // Walk progressive absolute prefixes: /a, /a/b, /a/b/c ...
  const normalized = path.resolve(absolutePath);
  const parts = normalized.split(path.sep).filter((part) => part.length > 0);
  let current = path.sep;
  // Windows drive roots keep their prefix; path.resolve already normalized.
  if (path.sep !== "/" && /^[A-Za-z]:/.test(normalized)) {
    current = `${parts.shift()}${path.sep}`;
  }
  for (let index = 0; index < parts.length; index += 1) {
    current = index === 0 && current === path.sep
      ? path.sep + parts[index]
      : path.join(current, parts[index]);
    if (hops.length >= maxComponents) {
      return { ok: false, reason: "hop-limit", hops };
    }
    let stat;
    try {
      stat = fs.lstatSync(current, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        // Missing intermediate is recorded as absence of further hops.
        break;
      }
      return { ok: false, reason: "unreadable", hops };
    }
    if (stat.isSymbolicLink()) {
      let linkText;
      try {
        linkText = fs.readlinkSync(current);
      } catch {
        return { ok: false, reason: "unreadable", hops };
      }
      hops.push({
        // Private absolute for revalidation only — never serialized publicly.
        kind: "symlink",
        absolute: current,
        linkDigest: sha(String(linkText)),
        // Stable node identity for same-capture revalidation and cross-capture digests.
        stableSignature: metadataLexicalNodeStableSignature(stat)
      });
      continue;
    }
    if (stat.isDirectory()) {
      hops.push({
        kind: "directory",
        absolute: current,
        // Stable node identity only: sibling nlink/mtime/ctime under this
        // ancestor must not fail-close same-capture revalidation.
        stableSignature: metadataLexicalNodeStableSignature(stat)
      });
      continue;
    }
    if (stat.isFile()) {
      hops.push({
        kind: "file",
        absolute: current,
        stableSignature: metadataLexicalNodeStableSignature(stat)
      });
      continue;
    }
    return { ok: false, reason: "other", hops };
  }
  return { ok: true, hops };
}

/**
 * Re-lstat/readlink every lexical component so ordinary→symlink swaps, ancestor
 * replacement, chmod/mode changes, and symlink retarget races fail closed.
 *
 * Lexical witnesses deliberately use stable dev/ino/mode (+ symlink linkDigest)
 * rather than full directory/file/symlink enumeration signatures. Unrelated
 * sibling create/change/remove under an ordinary ancestor changes nlink/size/
 * mtime/ctime without replacing the node and must not mark hooks unreadable.
 */
function revalidateLexicalPathSymlinkHops(hops, maxComponents = MAX_LEXICAL_PATH_COMPONENTS) {
  if (!Array.isArray(hops)) return { ok: false, reason: "unreadable" };
  if (hops.length > maxComponents) return { ok: false, reason: "hop-limit" };
  for (const hop of hops) {
    if (!hop || typeof hop.absolute !== "string" || typeof hop.kind !== "string") {
      return { ok: false, reason: "unreadable" };
    }
    if (typeof hop.stableSignature !== "string") {
      return { ok: false, reason: "unreadable" };
    }
    let stat;
    try {
      stat = fs.lstatSync(hop.absolute, { bigint: true });
    } catch {
      return { ok: false, reason: "broken" };
    }
    if (hop.kind === "symlink") {
      if (typeof hop.linkDigest !== "string") return { ok: false, reason: "unreadable" };
      if (!stat.isSymbolicLink()) return { ok: false, reason: "replaced" };
      if (metadataLexicalNodeStableSignature(stat) !== hop.stableSignature) {
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
      continue;
    }
    if (hop.kind === "directory") {
      // Ordinary directory swapped to a symlink (even same content) fails closed.
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return { ok: false, reason: "replaced" };
      }
      if (metadataLexicalNodeStableSignature(stat) !== hop.stableSignature) {
        return { ok: false, reason: "replaced" };
      }
      continue;
    }
    if (hop.kind === "file") {
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { ok: false, reason: "replaced" };
      }
      if (metadataLexicalNodeStableSignature(stat) !== hop.stableSignature) {
        return { ok: false, reason: "replaced" };
      }
      continue;
    }
    return { ok: false, reason: "unreadable" };
  }
  return { ok: true };
}

/**
 * Choose the private hooks-tree walk root.
 *
 * `rev-parse --git-path hooks` is authoritative for Git's effective hooks
 * directory, but it may canonicalize a final directory symlink and drop the
 * configured hop. When `core.hooksPath` is set (absolute, relative, or
 * include-derived), build an unresolved candidate from the configured value:
 * absolute values are used as-is; relative values are resolved against the
 * worktree root (cwd for the git helper) without realpathing the final hop.
 * Walk that candidate when its realpath matches the effective directory so hop
 * digests observe final-component retarget races. Ancestor symlink components
 * of the configured path are always bound separately (see lexical hops).
 * Absolute paths never leave this helper publicly.
 */
function resolveHooksWalkRoot(workspaceRoot, effectiveHooksPath) {
  const configuredRun = git(
    workspaceRoot,
    // Explicit includes so include-derived core.hooksPath is observed the same
    // way Git resolves effective configuration for hooks.
    ["config", "--includes", "--path", "--get", "core.hooksPath"],
    { allowFailure: true }
  );
  // Unset / not found: Git uses the rev-parse effective path alone.
  if (configuredRun.error || configuredRun.status !== 0) {
    return { ok: true, hooksPath: effectiveHooksPath, configuredCandidate: null };
  }
  const configured = String(configuredRun.stdout || "").trim();
  if (!configured) {
    return { ok: true, hooksPath: effectiveHooksPath, configuredCandidate: null };
  }

  // Absolute: keep unresolved string (may be a symlink hop). Relative: join to
  // the worktree root without realpath — matches Git cwd/worktree semantics for
  // this helper's git() invocations — so a relative directory symlink remains
  // observable. Never use raw relative strings as the walk root.
  const configuredCandidate = path.isAbsolute(configured)
    ? configured
    : path.resolve(workspaceRoot, configured);
  if (!configuredCandidate || !path.isAbsolute(configuredCandidate)) {
    return { ok: true, hooksPath: effectiveHooksPath, configuredCandidate: null };
  }

  let configuredStat;
  try {
    configuredStat = fs.lstatSync(configuredCandidate);
  } catch {
    // Missing/unreadable configured path: keep effective (may also be missing).
    return { ok: true, hooksPath: effectiveHooksPath, configuredCandidate };
  }

  // Non-symlink final component: walk the effective path for content, but still
  // return configuredCandidate so ancestor lexical hops can be bound.
  if (!configuredStat.isSymbolicLink()) {
    return { ok: true, hooksPath: effectiveHooksPath, configuredCandidate };
  }

  // Configured directory (or multi-hop) symlink: retain the unresolved hop
  // only when it realpath-matches Git's effective hooks root.
  try {
    const configuredReal = fs.realpathSync(configuredCandidate);
    const effectiveReal = fs.realpathSync(effectiveHooksPath);
    if (path.resolve(configuredReal) !== path.resolve(effectiveReal)) {
      return { ok: true, hooksPath: effectiveHooksPath, configuredCandidate };
    }
    return { ok: true, hooksPath: configuredCandidate, configuredCandidate };
  } catch {
    // Dangling / partially unreadable symlink: if the single-hop logical
    // target agrees with the effective path string, still walk the unresolved
    // hop so broken/retargeted roots fail closed via the bounded walker.
    try {
      const linkText = fs.readlinkSync(configuredCandidate);
      const logicalTarget = path.resolve(
        path.dirname(configuredCandidate),
        String(linkText)
      );
      if (path.resolve(logicalTarget) === path.resolve(effectiveHooksPath)) {
        return { ok: true, hooksPath: configuredCandidate, configuredCandidate };
      }
    } catch {
      // ignore readlink races
    }
    return { ok: true, hooksPath: effectiveHooksPath, configuredCandidate };
  }
}

/**
 * Resolve the effective hooks directory with Git semantics (respects
 * core.hooksPath) and hash bounded contents under a private digest only.
 * Symlink link-text and resolved target contents are both bound into the
 * identity so unchanged symlink paths cannot hide target drift. Absolute hook
 * paths never enter public/runtime evidence.
 * Missing after resolution failure, unreadable, cyclic, excessive-depth, or
 * truncated inventories fail closed via observable=false.
 */
function captureEffectiveHooksIdentity(workspaceRoot) {
  const run = git(
    workspaceRoot,
    ["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
    { allowFailure: true }
  );
  if (run.status !== 0 || run.error) {
    return {
      identity: sha("hooks-v2:resolution-failed"),
      observable: false,
      truncated: true
    };
  }
  const effectiveHooksPath = String(run.stdout || "").trim();
  if (!effectiveHooksPath || !path.isAbsolute(effectiveHooksPath)) {
    return {
      identity: sha("hooks-v2:resolution-failed"),
      observable: false,
      truncated: true
    };
  }

  const walkRoot = resolveHooksWalkRoot(workspaceRoot, effectiveHooksPath);
  if (!walkRoot.ok) {
    return {
      identity: sha(`hooks-v2:${walkRoot.reason || "walk-root-failed"}`),
      observable: false,
      truncated: true
    };
  }
  const hooksPath = walkRoot.hooksPath;
  if (!hooksPath || !path.isAbsolute(hooksPath)) {
    return {
      identity: sha("hooks-v2:resolution-failed"),
      observable: false,
      truncated: true
    };
  }

  // Bind every lexical component along the configured path (ordinary dirs,
  // files, and symlink hops) so ordinary→symlink ancestor swaps and symlink
  // retargets change identity even when hook tree bytes are identical.
  let lexicalHops = [];
  let lexicalHopFailure = null;
  const hopSource = walkRoot.configuredCandidate || null;
  if (hopSource) {
    const hopCapture = captureLexicalPathSymlinkHops(hopSource, MAX_LEXICAL_PATH_COMPONENTS);
    if (!hopCapture.ok) {
      lexicalHopFailure = hopCapture.reason || "unreadable";
    } else {
      lexicalHops = hopCapture.hops;
    }
  }

  // Reuse the shared bounded walker so hooks, operational, and non-ref capture
  // enforce the same hard entry/byte/descriptor bounds without path leakage.
  const state = createMetadataVisitState();
  let missing = false;
  /** @type {object[]} */
  const rootWitnesses = [];
  try {
    fs.lstatSync(hooksPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      missing = true;
      // Witness absence so a hooks root that appears mid-capture fails closed.
      rootWitnesses.push({ kind: "absent", absolute: hooksPath });
    } else {
      return {
        identity: sha("hooks-v2:unreadable-root"),
        observable: false,
        truncated: true
      };
    }
  }
  if (!missing) {
    const witness = visitBoundedMetadataTree(hooksPath, "", 0, new Set(), state, {
      maxDepth: MAX_HOOKS_DEPTH,
      maxBytes: MAX_HOOKS_HASH_BYTES,
      maxEntries: MAX_GIT_METADATA_ENTRIES,
      maxHops: MAX_HOOKS_SYMLINK_HOPS
    });
    if (witness) rootWitnesses.push(witness);
  }
  // Final present/absent validation of the effective hooks root.
  if (!state.truncated && !state.depthExceeded) {
    revalidateOptionalRootWitnesses(rootWitnesses, state);
    // If the missing witness flipped to present, revalidation already set
    // unreadable. Keep the missing flag consistent with the final witness.
    if (missing && state.unreadable) {
      missing = false;
    }
  }
  // Revalidate configured lexical ancestor/final components after content capture.
  if (!lexicalHopFailure && lexicalHops.length > 0) {
    const hopRecheck = revalidateLexicalPathSymlinkHops(lexicalHops, MAX_LEXICAL_PATH_COMPONENTS);
    if (!hopRecheck.ok) {
      lexicalHopFailure = hopRecheck.reason || "retargeted";
      state.unreadable = true;
    }
  } else if (lexicalHopFailure) {
    state.unreadable = true;
  }
  state.entries.sort((left, right) => left.path.localeCompare(right.path));
  // Public-safe hop digests only (no absolute paths, raw stats, or link text).
  // kind is retained so ordinary→symlink type swaps change identity.
  // Cross-capture and same-capture lexical witnesses both use stable
  // dev/ino/mode (+ symlink linkDigest). Full enumeration signatures remain
  // for metadata tree hashing only — not lexical hop revalidation.
  const publicLexicalHops = lexicalHops.map((hop) => {
    const stable = hop.stableSignature;
    if (hop.kind === "symlink") {
      return {
        kind: "symlink",
        linkDigest: hop.linkDigest,
        signatureDigest: sha(stable)
      };
    }
    return {
      kind: hop.kind,
      signatureDigest: sha(stable)
    };
  });
  // A completely missing hooks directory is normal (empty effective hooks).
  // Unreadable, cyclic, depth-limited, or truncated inventories fail closed.
  const failClosed = state.unreadable
    || state.depthExceeded
    || state.truncated
    || state.cyclic
    || state.entries.length >= MAX_GIT_METADATA_ENTRIES
    || Boolean(lexicalHopFailure);
  return {
    identity: sha(canonicalJson({
      schema: "hooks-v4",
      entries: state.entries,
      lexicalHops: publicLexicalHops,
      lexicalHopFailure: lexicalHopFailure || null,
      missing,
      truncated: failClosed,
      depthExceeded: state.depthExceeded,
      unreadable: state.unreadable,
      cyclic: state.cyclic
    })),
    observable: !failClosed,
    truncated: failClosed
  };
}

/**
 * Bounded legacy metadata tree walk for gitMetadataIdentity.
 * Hard entry/byte/depth caps and descriptor-bound file hashing; directory
 * listings use listDirectoryNamesBounded (no unbounded readdirSync().sort()).
 * Optional missing roots stay silent (stable absence is valid) but are
 * witnessed and revalidated after the full root batch so mid-capture
 * appearance/disappearance/replace fails closed via state.
 */
function visitGitMetadataEntries(entries, gitDir, commonDir, roots, state) {
  const visit = (base, relative, depth = 0) => {
    if (!state || state.truncated || state.unreadable || state.depthExceeded) {
      return null;
    }
    if (entries.length >= MAX_GIT_METADATA_ENTRIES) {
      state.truncated = true;
      return null;
    }
    if (depth > MAX_METADATA_DEPTH) {
      state.depthExceeded = true;
      return null;
    }
    const absolute = path.join(base, relative);
    let stat;
    try {
      // Top-level roots use bigint so present witnesses can revalidate identity.
      stat = depth === 0
        ? fs.lstatSync(absolute, { bigint: true })
        : fs.lstatSync(absolute);
    } catch (error) {
      // Optional legacy roots may be absent (e.g. missing hooks).
      if (error?.code === "ENOENT") {
        if (depth === 0) return { kind: "absent", absolute };
        // Listed child disappeared mid-walk.
        state.unreadable = true;
        return null;
      }
      state.unreadable = true;
      return null;
    }
    const key = `${base === gitDir ? "git" : "common"}/${relative.replace(/\\/g, "/")}`;
    if (stat.isSymbolicLink()) {
      let linkText;
      try {
        linkText = fs.readlinkSync(absolute);
      } catch {
        state.unreadable = true;
        return null;
      }
      const linkDigest = sha(String(linkText));
      entries.push({
        path: key,
        kind: "symlink",
        mode: Number(stat.mode & (depth === 0 ? 0o7777n : 0o7777)),
        digest: linkDigest
      });
      if (depth === 0) {
        return {
          kind: "legacy-present",
          absolute,
          nodeKind: "symlink",
          signature: metadataSymlinkStatSignature(stat),
          linkDigest
        };
      }
      return null;
    }
    if (stat.isFile()) {
      // Descriptor-validated mode/size/digest only — same hard byte bound.
      const fileIdentity = hashBoundedMetadataFile(absolute, state, MAX_METADATA_HASH_BYTES);
      if (fileIdentity.kind === "unobservable") {
        state.unreadable = true;
        return null;
      }
      entries.push({
        path: key,
        kind: "file",
        mode: fileIdentity.mode,
        size: fileIdentity.size,
        digest: fileIdentity.digest
      });
      if (depth === 0) {
        return {
          kind: "legacy-present",
          absolute,
          nodeKind: "file",
          mode: fileIdentity.mode,
          size: fileIdentity.size,
          digest: fileIdentity.digest
        };
      }
      return null;
    }
    if (!stat.isDirectory()) {
      entries.push({
        path: key,
        kind: "other",
        mode: Number(stat.mode & (depth === 0 ? 0o7777n : 0o7777))
      });
      if (depth === 0) {
        return { kind: "legacy-present", absolute, nodeKind: "other" };
      }
      return null;
    }
    let listed;
    try {
      listed = listDirectoryNamesBounded(absolute, MAX_GIT_METADATA_ENTRIES - entries.length);
    } catch {
      state.unreadable = true;
      return null;
    }
    if (listed.truncated) {
      state.truncated = true;
      return null;
    }
    for (const name of listed.names) {
      if (entries.length >= MAX_GIT_METADATA_ENTRIES || state.truncated || state.unreadable) {
        state.truncated = true;
        break;
      }
      visit(base, path.join(relative, name), depth + 1);
    }
    // Membership revalidation after children (post-EOF growth / shrink).
    if (!state.truncated && !state.unreadable) {
      const dirRecheck = revalidateBoundedDirectorySnapshot(
        absolute,
        listed.directorySignature,
        listed.names
      );
      if (!dirRecheck.ok) state.unreadable = true;
    }
    if (depth === 0) {
      return {
        kind: "legacy-present",
        absolute,
        nodeKind: "directory",
        directorySignature: listed.directorySignature,
        names: listed.names
      };
    }
    return null;
  };
  const rootWitnesses = [];
  for (const [base, relatives] of roots) {
    if (!base) {
      state.unreadable = true;
      continue;
    }
    for (const relative of relatives) {
      const witness = visit(base, relative, 0);
      if (witness) rootWitnesses.push(witness);
    }
  }
  // Final present/absent validation of the complete legacy root set.
  if (!state.truncated && !state.depthExceeded) {
    revalidateOptionalRootWitnesses(rootWitnesses, state);
  }
}

export {
  captureEffectiveGitConfigIdentity,
  captureEffectiveHooksIdentity,
  captureTaskRelevantNonRefEntries,
  captureWorktreeOperationalIdentity,
  gitMetadataIdentity
};
