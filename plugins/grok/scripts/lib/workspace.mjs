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

const LEGACY_MIGRATION_MARKER = ".legacy-migration-v1.json";
const LEGACY_MIGRATION_MARKER_PREFIX = ".legacy-migration-v2-";
const LEGACY_SNAPSHOT_MARKER_PREFIX = ".legacy-migration-v3-";
const LEGACY_TRANSIENT_TOP_LEVEL = new Set(["locks", "worktrees"]);
const LEGACY_TRANSIENT_FILE = /\.\d+\.[a-f0-9]{12}\.(?:migrate|tmp)$/;
const LEGACY_MAX_FILE_BYTES = 64 * 1024 * 1024;
const LEGACY_MAX_MARKER_BYTES = 16 * 1024 * 1024;
const LEGACY_METADATA_TTL_MS = 500;
const LEGACY_FULL_RESCAN_MS = 60_000;
const legacySnapshotCache = new Map();

function safeDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
    throw new CompanionError("E_STATE", `Refusing unsafe ${label} ${directory}.`);
  }
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(directory, 0o700);
  return directory;
}

function legacyStateDir(stateParent, controlRoot) {
  return path.join(stateParent, workspaceStateSegment(fs.realpathSync(controlRoot)));
}

export function listedWorktreeRoots(fromRoot) {
  const run = git(fromRoot, ["worktree", "list", "--porcelain", "-z"], { allowFailure: true });
  if (run.status !== 0) return [];
  return [...new Set(String(run.stdout || "")
    .split("\0")
    .filter((entry) => entry.startsWith("worktree "))
    .flatMap((entry) => {
      try { return [fs.realpathSync(entry.slice("worktree ".length))]; }
      catch { return []; }
    }))];
}

function legacyStateDirs(stateParent, controlRoot) {
  const roots = [...new Set([
    fs.realpathSync(controlRoot),
    ...listedWorktreeRoots(controlRoot)
  ])];
  return roots.map((root) => legacyStateDir(stateParent, root));
}

function legacySourceDigest(legacyDir) {
  return crypto.createHash("sha256").update(fs.realpathSync(legacyDir)).digest("hex");
}

function migrationMarkerPath(controlDir, legacyDir) {
  return path.join(
    controlDir,
    `${LEGACY_MIGRATION_MARKER_PREFIX}${legacySourceDigest(legacyDir).slice(0, 32)}.json`
  );
}

function isLegacyMigrationMarker(name) {
  return name === LEGACY_MIGRATION_MARKER
    || (name.startsWith(LEGACY_MIGRATION_MARKER_PREFIX) && name.endsWith(".json"))
    || (name.startsWith(LEGACY_SNAPSHOT_MARKER_PREFIX) && name.endsWith(".json"));
}

function digest(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function safeLegacyRelativePath(relative) {
  const value = String(relative || "");
  if (!value || value.includes("\0") || value.startsWith("/") || value.endsWith("/")
    || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new CompanionError("E_STATE", "Invalid path in legacy state migration.");
  }
  return value;
}

function assertOpenedPathIdentity(file, descriptorStat, label) {
  const resolved = fs.realpathSync(file);
  const pathStat = fs.statSync(file);
  if (resolved !== file || pathStat.dev !== descriptorStat.dev || pathStat.ino !== descriptorStat.ino) {
    throw new CompanionError("E_STATE", `Refusing path-swapped ${label} ${file}.`);
  }
}

function readStableRegularFile(file, label, maxBytes = LEGACY_MAX_FILE_BYTES) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > maxBytes) {
      throw new CompanionError("E_STATE", `Refusing unsafe ${label} ${file}.`);
    }
    assertOpenedPathIdentity(file, before, label);
    const contents = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < contents.length) {
      const count = fs.readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    assertOpenedPathIdentity(file, after, label);
    if (offset !== contents.length
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs) {
      throw new CompanionError("E_STATE", `Legacy state changed while reading ${file}.`);
    }
    return contents;
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function legacyTiming(env, key, fallback) {
  const value = Number(env?.[key]);
  return Number.isFinite(value) && value >= 0 && value <= 60_000 ? value : fallback;
}

function legacyNow(env) {
  const hook = env?.__GROK_COMPANION_LEGACY_MIGRATION_NOW;
  const value = typeof hook === "function" ? Number(hook()) : Date.now();
  if (!Number.isFinite(value)) throw new CompanionError("E_STATE", "Invalid legacy migration clock.");
  return value;
}

function withinInterval(nowValue, previous, interval) {
  const elapsed = nowValue - previous;
  return elapsed >= 0 && elapsed < interval;
}

function legacyMetadataRecord(relative, stat, kind) {
  return [relative, kind, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
}

function assertLegacyMetadataPath(file, stat, relative) {
  if (stat.isSymbolicLink()) {
    throw new CompanionError("E_STATE", `Refusing symlink in legacy state migration at ${relative || "."}.`);
  }
  const resolved = fs.realpathSync(file);
  const current = fs.statSync(file);
  if (resolved !== file || current.dev !== stat.dev || current.ino !== stat.ino) {
    throw new CompanionError("E_STATE", "Legacy state changed during migration metadata capture.");
  }
}

function captureLegacyGeneration(legacyDir, { recursive }) {
  const records = [];

  function walk(directory, relativeDirectory = "") {
    const directoryStat = fs.lstatSync(directory);
    assertLegacyMetadataPath(directory, directoryStat, relativeDirectory);
    if (!directoryStat.isDirectory()) {
      throw new CompanionError("E_STATE", "Legacy state root is not a directory.");
    }
    records.push(legacyMetadataRecord(relativeDirectory || ".", directoryStat, "directory"));
    for (const name of fs.readdirSync(directory).sort()) {
      if (!relativeDirectory && (LEGACY_TRANSIENT_TOP_LEVEL.has(name) || isLegacyMigrationMarker(name))) continue;
      if (LEGACY_TRANSIENT_FILE.test(name)) continue;
      const source = path.join(directory, name);
      const relative = safeLegacyRelativePath(relativeDirectory ? `${relativeDirectory}/${name}` : name);
      const child = fs.lstatSync(source);
      assertLegacyMetadataPath(source, child, relative);
      if (child.isDirectory()) {
        if (recursive) walk(source, relative);
        else records.push(legacyMetadataRecord(relative, child, "directory"));
      } else if (child.isFile()) {
        records.push(legacyMetadataRecord(relative, child, "file"));
      } else {
        throw new CompanionError("E_STATE", `Refusing non-regular legacy state at ${relative}.`);
      }
    }
  }

  try {
    walk(legacyDir);
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    throw new CompanionError("E_STATE", "Could not capture legacy migration metadata.");
  }
  return digest(JSON.stringify(records));
}

function cachedLegacySnapshot(legacyDir, env) {
  const nowValue = legacyNow(env);
  const metadataTtl = legacyTiming(
    env,
    "__GROK_COMPANION_LEGACY_METADATA_TTL_MS",
    LEGACY_METADATA_TTL_MS
  );
  const fullRescanInterval = legacyTiming(
    env,
    "__GROK_COMPANION_LEGACY_FULL_RESCAN_MS",
    LEGACY_FULL_RESCAN_MS
  );
  const cheapGeneration = captureLegacyGeneration(legacyDir, { recursive: false });
  const cached = legacySnapshotCache.get(legacyDir);
  if (cached
    && cached.cheapGeneration === cheapGeneration
    && withinInterval(nowValue, cached.metadataAt, metadataTtl)) {
    return { snapshot: cached.snapshot, cache: cached, mustApply: false };
  }

  const metadataGeneration = captureLegacyGeneration(legacyDir, { recursive: true });
  if (cached
    && cached.metadataGeneration === metadataGeneration
    && withinInterval(nowValue, cached.fullScanAt, fullRescanInterval)) {
    cached.cheapGeneration = cheapGeneration;
    cached.metadataAt = nowValue;
    return { snapshot: cached.snapshot, cache: cached, mustApply: false };
  }

  const snapshot = captureLegacySnapshot(legacyDir);
  const stableMetadataGeneration = captureLegacyGeneration(legacyDir, { recursive: true });
  if (metadataGeneration !== stableMetadataGeneration) {
    throw new CompanionError("E_STATE", "Legacy state changed during migration snapshot capture.");
  }
  const cache = {
    snapshot,
    cheapGeneration: captureLegacyGeneration(legacyDir, { recursive: false }),
    metadataGeneration: stableMetadataGeneration,
    metadataAt: nowValue,
    fullScanAt: nowValue,
    appliedKey: cached?.snapshot.snapshotDigest === snapshot.snapshotDigest ? cached.appliedKey : null
  };
  legacySnapshotCache.set(legacyDir, cache);
  return { snapshot, cache, mustApply: true };
}

function captureLegacySnapshot(legacyDir) {
  const sourceDigest = legacySourceDigest(legacyDir);
  const entries = [];

  function walk(directory, relativeDirectory = "") {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
      throw new CompanionError("E_STATE", `Refusing unsafe legacy state directory ${directory}.`);
    }
    for (const name of fs.readdirSync(directory).sort()) {
      if (!relativeDirectory && (LEGACY_TRANSIENT_TOP_LEVEL.has(name) || isLegacyMigrationMarker(name))) continue;
      if (LEGACY_TRANSIENT_FILE.test(name)) continue;
      const source = path.join(directory, name);
      const relative = safeLegacyRelativePath(relativeDirectory ? `${relativeDirectory}/${name}` : name);
      const child = fs.lstatSync(source);
      if (child.isSymbolicLink()) {
        throw new CompanionError("E_STATE", `Refusing symlink in legacy state migration at ${relative}.`);
      }
      if (child.isDirectory()) {
        walk(source, relative);
        continue;
      }
      if (!child.isFile()) {
        throw new CompanionError("E_STATE", `Refusing non-regular legacy state at ${relative}.`);
      }
      const contents = readStableRegularFile(source, "legacy state file");
      entries.push({ path: relative, contentDigest: digest(contents), size: contents.length, contents });
    }
  }

  try {
    walk(legacyDir);
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    throw new CompanionError("E_STATE", `Could not capture legacy state ${legacyDir}.`);
  }
  const publicEntries = entries.map(({ path: relative, contentDigest, size }) => ({
    path: relative,
    contentDigest,
    size
  }));
  const snapshotDigest = digest(JSON.stringify(publicEntries));
  return { sourceDigest, snapshotDigest, entries, publicEntries };
}

function snapshotMarkerName(snapshot) {
  return `${LEGACY_SNAPSHOT_MARKER_PREFIX}${snapshot.sourceDigest.slice(0, 32)}-${snapshot.snapshotDigest}.json`;
}

function snapshotMarkerPath(controlDir, snapshot) {
  return path.join(controlDir, snapshotMarkerName(snapshot));
}

function entryAcknowledgementKey(entry) {
  return `${entry.path}\0${entry.contentDigest}\0${entry.size}`;
}

function parseSnapshotMarker(file, expectedSourceDigest) {
  let value;
  try {
    const contents = readStableRegularFile(file, "legacy migration marker", LEGACY_MAX_MARKER_BYTES);
    value = JSON.parse(contents.toString("utf8"));
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    throw new CompanionError("E_STATE", "Could not validate legacy migration marker.");
  }
  if (value?.schemaVersion !== 3
    || value.sourceDigest !== expectedSourceDigest
    || !/^[a-f0-9]{64}$/.test(String(value.snapshotDigest || ""))
    || !Array.isArray(value.entries)) {
    throw new CompanionError("E_STATE", "Invalid legacy migration snapshot marker.");
  }
  const seen = new Set();
  const entries = value.entries.map((entry) => {
    const relative = safeLegacyRelativePath(entry?.path);
    if (!/^[a-f0-9]{64}$/.test(String(entry?.contentDigest || ""))
      || !Number.isSafeInteger(entry?.size)
      || entry.size < 0
      || seen.has(relative)) {
      throw new CompanionError("E_STATE", "Invalid legacy migration snapshot marker entry.");
    }
    seen.add(relative);
    return { path: relative, contentDigest: entry.contentDigest, size: entry.size };
  });
  if (digest(JSON.stringify(entries)) !== value.snapshotDigest
    || path.basename(file) !== snapshotMarkerName(value)) {
    throw new CompanionError("E_STATE", "Legacy migration snapshot marker does not match its contents.");
  }
  return entries;
}

function validateLegacyPathMarker(controlDir, legacyDir) {
  const singleton = path.join(controlDir, LEGACY_MIGRATION_MARKER);
  try {
    const contents = readStableRegularFile(singleton, "legacy migration marker", 4096);
    const value = JSON.parse(contents.toString("utf8"));
    if (value?.schemaVersion !== 1 || typeof value.sourceDigest !== "string") {
      throw new CompanionError("E_STATE", "Invalid legacy migration marker.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      if (error instanceof CompanionError) throw error;
      throw new CompanionError("E_STATE", "Could not validate legacy migration marker.");
    }
  }

  const marker = migrationMarkerPath(controlDir, legacyDir);
  let value;
  try {
    const contents = readStableRegularFile(marker, "legacy migration marker", 4096);
    value = JSON.parse(contents.toString("utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    if (error instanceof CompanionError) throw error;
    throw new CompanionError("E_STATE", "Could not validate legacy migration marker.");
  }
  if (value?.schemaVersion !== 2 || value.sourceDigest !== legacySourceDigest(legacyDir)) {
    throw new CompanionError("E_STATE", "Legacy migration marker does not match its source state directory.");
  }
}

function acknowledgedLegacyEntries(controlDir, snapshot) {
  validateLegacyPathMarker(controlDir, snapshot.legacyDir);
  const prefix = `${LEGACY_SNAPSHOT_MARKER_PREFIX}${snapshot.sourceDigest.slice(0, 32)}-`;
  const acknowledged = new Set();
  for (const name of fs.readdirSync(controlDir).sort()) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    for (const entry of parseSnapshotMarker(path.join(controlDir, name), snapshot.sourceDigest)) {
      acknowledged.add(entryAcknowledgementKey(entry));
    }
  }
  return acknowledged;
}

function destinationFor(controlDir, relative) {
  const segments = safeLegacyRelativePath(relative).split("/");
  let parent = controlDir;
  for (const segment of segments.slice(0, -1)) {
    parent = path.join(parent, segment);
    try { fs.mkdirSync(parent, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    safeDirectory(parent, "legacy migration destination");
  }
  const destination = path.join(parent, segments.at(-1));
  if (!destination.startsWith(`${controlDir}${path.sep}`)) {
    throw new CompanionError("E_STATE", "Legacy migration destination escaped the control state directory.");
  }
  return destination;
}

function destinationDigest(destination) {
  try {
    const contents = readStableRegularFile(destination, "control state file");
    return { contentDigest: digest(contents), size: contents.length };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof CompanionError) throw error;
    throw new CompanionError("E_STATE", `Could not validate control state file ${destination}.`);
  }
}

function planLegacyEntry(controlDir, entry, acknowledged) {
  const destination = destinationFor(controlDir, entry.path);
  const existing = destinationDigest(destination);
  if (acknowledged.has(entryAcknowledgementKey(entry))) {
    // This exact legacy generation was imported before. The control copy may
    // legitimately have evolved since then, but unsafe or missing destinations
    // still need validation/repair.
    if (existing) return null;
  } else if (existing) {
    if (existing.contentDigest !== entry.contentDigest || existing.size !== entry.size) {
      throw new CompanionError("E_STATE", `Conflicting late legacy/control state at ${entry.path}.`);
    }
    return null;
  }
  return { destination, entry };
}

function publishLegacyEntry(destination, entry) {
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.migrate`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, entry.contents);
      fs.fchmodSync(descriptor, 0o600);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
      descriptor = null;
    }
    // linkSync publishes a complete file without replacing an existing record.
    fs.linkSync(temporary, destination);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const raced = destinationDigest(destination);
    if (!raced || raced.contentDigest !== entry.contentDigest || raced.size !== entry.size) {
      throw new CompanionError("E_STATE", `Conflicting late legacy/control state at ${entry.path}.`);
    }
  } finally {
    if (descriptor != null) try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function legacySnapshotMarkerContents(snapshot) {
  const value = {
    schemaVersion: 3,
    sourceDigest: snapshot.sourceDigest,
    snapshotDigest: snapshot.snapshotDigest,
    entries: snapshot.publicEntries
  };
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized) > LEGACY_MAX_MARKER_BYTES) {
    throw new CompanionError("E_STATE", "Legacy migration snapshot marker is oversized.");
  }
  return serialized;
}

function assertLegacySnapshotQuiescent(snapshot) {
  for (const entry of snapshot.entries) {
    const directJob = entry.path.match(/^jobs\/([^/]+)\.json$/);
    if (!directJob) continue;
    const safeJob = directJob[1].match(/^((?:review|adversarial-review|task|stop-review)-[a-f0-9]{16,64})$/);
    if (!safeJob) {
      throw new CompanionError("E_STATE", "Invalid legacy job state during control-state cutover.");
    }
    let job;
    try {
      job = JSON.parse(entry.contents.toString("utf8"));
    } catch {
      throw new CompanionError("E_STATE", "Invalid legacy job state during control-state cutover.");
    }
    if (job?.id !== safeJob[1] || typeof job.status !== "string") {
      throw new CompanionError("E_STATE", "Invalid legacy job state during control-state cutover.");
    }
    if (job.status === "queued" || job.status === "running") {
      throw new CompanionError(
        "E_STATE",
        "Control-state cutover requires all pre-upgrade workers to finish or stop before retrying."
      );
    }
    if (job.status !== "completed" && job.status !== "failed" && job.status !== "cancelled") {
      throw new CompanionError("E_STATE", "Invalid legacy job state during control-state cutover.");
    }
  }
}

function writeLegacySnapshotMarker(controlDir, snapshot, serialized) {
  const marker = snapshotMarkerPath(controlDir, snapshot);
  const temporary = `${marker}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, serialized);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    try {
      fs.linkSync(temporary, marker);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      parseSnapshotMarker(marker, snapshot.sourceDigest);
    }
    if (process.platform !== "win32") {
      const directoryDescriptor = fs.openSync(controlDir, fs.constants.O_RDONLY);
      try { fs.fsyncSync(directoryDescriptor); }
      finally { fs.closeSync(directoryDescriptor); }
    }
  } finally {
    if (descriptor != null) try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function migrateLegacyState(controlDir, stateParent, controlRoot, env) {
  const sources = [];
  for (const legacyDir of legacyStateDirs(stateParent, controlRoot)) {
    if (legacyDir === controlDir || !fs.existsSync(legacyDir)) continue;
    safeDirectory(legacyDir, "legacy plugin state directory");
    const captured = cachedLegacySnapshot(legacyDir, env);
    const snapshot = { ...captured.snapshot, legacyDir };
    const markerContents = legacySnapshotMarkerContents(snapshot);
    assertLegacySnapshotQuiescent(snapshot);
    sources.push({ ...captured, snapshot, markerContents });
  }

  // Quiescence is global across every registered legacy source. Only after the
  // complete preflight succeeds may any durable control artifact be published.
  for (const { snapshot, cache, mustApply, markerContents } of sources) {
    const appliedKey = `${controlDir}\0${snapshot.sourceDigest}\0${snapshot.snapshotDigest}`;
    if (!mustApply && cache.appliedKey === appliedKey) continue;
    const acknowledged = acknowledgedLegacyEntries(controlDir, snapshot);
    // Detect every conflict before publishing any file from this snapshot.
    // A race after this preflight is still caught by the no-replace publish.
    const pending = snapshot.entries
      .map((entry) => planLegacyEntry(controlDir, entry, acknowledged))
      .filter(Boolean);
    for (const { destination, entry } of pending) publishLegacyEntry(destination, entry);
    // Immutable, source-and-content-bound receipts make concurrent migration
    // attempts monotonic. Late files get a new snapshot receipt; an already
    // acknowledged source generation never overwrites an evolved control file.
    writeLegacySnapshotMarker(controlDir, snapshot, markerContents);
    cache.appliedKey = appliedKey;
  }
}

export function controlStateDir(control, env = process.env) {
  const configuredData = pluginDataRoot(env);
  fs.mkdirSync(configuredData, { recursive: true, mode: 0o700 });
  const pluginData = fs.realpathSync(configuredData);
  const stateParent = path.join(pluginData, "state");
  try { fs.mkdirSync(stateParent, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  safeDirectory(stateParent, "plugin state directory");
  const controlDir = path.join(stateParent, controlStateSegment(control.controlWorkspaceId));
  try { fs.mkdirSync(controlDir, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  safeDirectory(controlDir, "control state directory");
  migrateLegacyState(controlDir, stateParent, control.controlRoot, env);
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
 * Compute the workspace job-state directory without creating the initial store.
 * When a control store already exists, this also performs the idempotent legacy
 * read-through so readonly status/result calls cannot hide a late legacy write.
 * Returns null when the plugin data root is absent.
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

  // Control-keyed (shared) state first. Keep repository-resolution failures
  // separate from migration failures: unsafe or divergent legacy state must be
  // surfaced as E_STATE, never converted into a silent legacy-path fallback.
  let resolvedControl = null;
  try {
    const executionRoot = workspaceRoot(root, true);
    const common = gitCommonDir(executionRoot);
    const controlWorkspaceId = controlWorkspaceIdFromCommon(common);
    resolvedControl = {
      controlDir: path.join(stateParent, controlStateSegment(controlWorkspaceId)),
      controlRoot: mainWorktreeRoot(executionRoot)
    };
  } catch {
    /* fall through to legacy */
  }
  if (resolvedControl && fs.existsSync(resolvedControl.controlDir)) {
    safeDirectory(stateParent, "plugin state directory");
    safeDirectory(resolvedControl.controlDir, "control state directory");
    migrateLegacyState(resolvedControl.controlDir, stateParent, resolvedControl.controlRoot, env);
    return resolvedControl.controlDir;
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
  let control = null;
  try {
    control = resolveControlWorkspace(root, env);
  } catch {
    // Only repository-resolution failures use the legacy non-git layout.
    // Safety failures from controlStateDir below are deliberately not caught.
  }
  if (control) return controlStateDir(control, env);
  const canonicalRoot = fs.realpathSync(root);
  const configuredData = pluginDataRoot(env);
  fs.mkdirSync(configuredData, { recursive: true, mode: 0o700 });
  const pluginData = fs.realpathSync(configuredData);
  const stateParent = path.join(pluginData, "state");
  try { fs.mkdirSync(stateParent, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  safeDirectory(stateParent, "plugin state directory");
  return path.join(stateParent, workspaceStateSegment(canonicalRoot));
}

export function assertSafeJobId(id) {
  if (!/^(review|adversarial-review|task|stop-review)-[a-f0-9]{16,64}$/.test(String(id))) throw new CompanionError("E_USAGE", "Invalid job ID.");
  return id;
}
