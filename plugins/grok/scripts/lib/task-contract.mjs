import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CompanionError } from "./errors.mjs";
import { git } from "./workspace.mjs";
import { redact, redactText, sanitizeDisplayText } from "./redact.mjs";

const timestamp = () => new Date().toISOString();

export const TASK_ENVELOPE_VERSION = 1;
export const CONTEXT_MANIFEST_VERSION = 1;
export const WORKER_REPORT_VERSION = 1;
export const LIFECYCLE_EVENT_TYPES = Object.freeze([
  "task.accepted",
  "plan.updated",
  "activity.started",
  "activity.completed",
  "checkpoint",
  "blocked",
  "final.report"
]);
const MAX_LIFECYCLE_EVENTS = 128;
const MAX_TEXT = 16 * 1024;
const MAX_USER_REQUEST = 64 * 1024;
const MAX_LIST = 64;
const MAX_ITEM = 2 * 1024;
const MAX_IGNORED_PATHS = 500_000;
const MAX_IGNORED_ATTRIBUTABLE = 2_000;
const MAX_IGNORED_HASH_BYTES = 64 * 1024 * 1024;
const TASK_ENVELOPE_INPUT_KEYS = new Set([
  "schemaVersion",
  "userRequest",
  "objective",
  "mode",
  "scope",
  "context",
  "contextFacts",
  "constraints",
  "nonGoals",
  "acceptanceCriteria",
  "requiredVerification",
  "expectedReturnFormat"
]);

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function clip(value, limit = MAX_TEXT) {
  const text = sanitizeDisplayText(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function boundedLiteral(value, name, limit = MAX_USER_REQUEST) {
  const text = String(value ?? "").trim();
  if (!text) throw new CompanionError("E_USAGE", `${name} must be a non-empty string.`);
  if (text.length > limit) {
    throw new CompanionError("E_USAGE", `${name} exceeds the ${limit}-character TaskEnvelope limit.`);
  }
  return sanitizeDisplayText(text);
}

function asStringList(value, { max = MAX_LIST } = {}) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => clip(String(item ?? "").trim(), MAX_ITEM))
    .filter(Boolean)
    .slice(0, max);
}

export function boundPathEvidence(value, { max = 200, marker = "[CHANGED_PATHS_OVERFLOW]" } = {}) {
  const items = asStringList(value, { max: max + 1 });
  if (items.length <= max && (!Array.isArray(value) || value.length <= max)) return items;
  return [marker, ...items.slice(0, Math.max(0, max - 1))];
}

function asRepositoryPathList(value, name, { max = MAX_LIST } = {}) {
  const paths = asStringList(value, { max });
  return [...new Set(paths.map((item) => {
    const normalized = item.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!normalized || path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) {
      throw new CompanionError("E_USAGE", `${name} must contain only repository-relative paths.`);
    }
    return normalized;
  }))];
}

function stableAcceptanceId(index, provided) {
  const raw = String(provided ?? "").trim();
  if (/^AC-[A-Za-z0-9._-]{1,64}$/.test(raw)) return raw;
  return `AC-${String(index + 1).padStart(2, "0")}`;
}

function normalizeAcceptance(items) {
  const list = Array.isArray(items) ? items : [];
  return list.slice(0, MAX_LIST).map((item, index) => {
    if (typeof item === "string") {
      return { id: stableAcceptanceId(index), text: clip(item.trim(), MAX_ITEM) };
    }
    if (item && typeof item === "object") {
      return {
        id: stableAcceptanceId(index, item.id),
        text: clip(String(item.text ?? item.description ?? "").trim() || `Criterion ${index + 1}`, MAX_ITEM)
      };
    }
    return { id: stableAcceptanceId(index), text: `Criterion ${index + 1}` };
  }).filter((item) => item.text);
}

function canonicalJson(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

/**
 * Build TaskEnvelope v1 from structured fields or plain-text CLI task input.
 * Plain-text paths remain compatible by constructing a default envelope.
 */
export function buildTaskEnvelope({
  userRequest,
  objective = null,
  mode = "read",
  scope = null,
  context = null,
  contextFacts = [],
  constraints = [],
  nonGoals = [],
  acceptanceCriteria = null,
  requiredVerification = [],
  expectedReturnFormat = null,
  contextManifestId = null
} = {}) {
  const request = boundedLiteral(userRequest, "userRequest");
  const resolvedMode = mode === "write" ? "write" : "read";
  const criteria = normalizeAcceptance(
    acceptanceCriteria?.length
      ? acceptanceCriteria
      : ["Complete the requested task within the stated constraints.", "Report changes, verification, risks, and remaining questions."]
  );
  const acceptanceIds = new Set();
  for (const criterion of criteria) {
    if (acceptanceIds.has(criterion.id)) throw new CompanionError("E_USAGE", `Duplicate acceptance criterion ID ${criterion.id}.`);
    acceptanceIds.add(criterion.id);
  }
  const envelope = {
    schemaVersion: TASK_ENVELOPE_VERSION,
    userRequest: request,
    objective: clip(String(objective ?? request).trim() || request),
    mode: resolvedMode,
    scope: {
      include: asStringList(scope?.include),
      exclude: asStringList(scope?.exclude)
    },
    context: {
      facts: asStringList(context?.facts ?? contextFacts),
      constraints: asStringList(context?.constraints ?? constraints),
      expectedProjectMarkers: asStringList(context?.expectedProjectMarkers, { max: 32 }),
      requiredPaths: asRepositoryPathList(context?.requiredPaths, "context.requiredPaths"),
      workspaceState: ["complete", "task_scoped", "unknown"].includes(context?.workspaceState)
        ? context.workspaceState
        : "unknown",
      upstreamFreshness: context?.upstreamFreshness === "verified" ? "verified" : "not_checked"
    },
    nonGoals: asStringList(nonGoals),
    acceptanceCriteria: criteria,
    requiredVerification: asStringList(requiredVerification),
    expectedReturnFormat: clip(
      expectedReturnFormat
        || "End with GROK_WORKER_REPORT: followed by one JSON object containing outcome, summary, changedFiles, checksClaimed, acceptanceResults, risks, and questions."
    ),
    contextManifestId: contextManifestId || null
  };
  const digest = sha(canonicalJson(envelope));
  return {
    ...envelope,
    envelopeId: `env-${digest.slice(0, 24)}`,
    digest
  };
}

/** Parse and validate the bounded JSON object accepted by --envelope-stdin. */
export function parseTaskEnvelopeInput(text) {
  const raw = String(text ?? "");
  if (!raw.trim()) throw new CompanionError("E_USAGE", "--envelope-stdin requires one TaskEnvelope JSON object on stdin.");
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) {
    throw new CompanionError("E_USAGE", "TaskEnvelope stdin exceeds the 256 KiB input limit.");
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new CompanionError("E_USAGE", `TaskEnvelope stdin is not valid JSON: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CompanionError("E_USAGE", "TaskEnvelope stdin must be one JSON object.");
  }
  const unknown = Object.keys(value).filter((key) => !TASK_ENVELOPE_INPUT_KEYS.has(key));
  if (unknown.length) {
    throw new CompanionError("E_USAGE", `TaskEnvelope stdin contains unsupported fields: ${unknown.slice(0, 8).join(", ")}.`);
  }
  if (value.schemaVersion != null && value.schemaVersion !== TASK_ENVELOPE_VERSION) {
    throw new CompanionError("E_USAGE", `Unsupported TaskEnvelope schemaVersion ${value.schemaVersion}.`);
  }
  if (value.mode != null && !["read", "write"].includes(value.mode)) {
    throw new CompanionError("E_USAGE", "TaskEnvelope mode must be read or write.");
  }
  return value;
}

/**
 * Capture a ContextManifest for the workspace. Used for job identity and drift checks.
 * Never stores task text or credentials.
 */
export function captureContextManifest(root) {
  const workspaceRoot = fs.realpathSync(root);
  const headRun = git(workspaceRoot, ["rev-parse", "HEAD"], { allowFailure: true });
  const head = headRun.status === 0 ? String(headRun.stdout || "").trim() : null;
  const branchRun = git(workspaceRoot, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true });
  const branch = branchRun.status === 0 ? String(branchRun.stdout || "").trim() : null;
  const dirtyRaw = String(git(workspaceRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { allowFailure: true }).stdout || "");
  const dirtySnapshot = parseDirtyEntries(workspaceRoot, dirtyRaw);
  const dirtyEntries = dirtySnapshot.entries;
  const dirtyPaths = dirtyEntries.flatMap((entry) => [entry.path, entry.sourcePath]).filter(Boolean);
  const dirtyDigest = dirtySnapshot.digest;
  const trackedTree = sha(String(git(workspaceRoot, ["ls-files", "--stage", "-z"], { allowFailure: true }).stdout || ""));
  const ignoredSnapshot = ignoredWorktreeSnapshot(workspaceRoot);
  const worktreeRun = git(workspaceRoot, ["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
  const insideWorktree = worktreeRun.status === 0 && String(worktreeRun.stdout || "").trim() === "true";
  const gitDirRun = git(workspaceRoot, ["rev-parse", "--git-dir"], { allowFailure: true });
  const gitDir = gitDirRun.status === 0 ? String(gitDirRun.stdout || "").trim() : "";
  const commonDirRun = git(workspaceRoot, ["rev-parse", "--git-common-dir"], { allowFailure: true });
  const commonDir = commonDirRun.status === 0 ? String(commonDirRun.stdout || "").trim() : "";
  const absoluteGitDir = gitDir ? path.resolve(workspaceRoot, gitDir) : path.join(workspaceRoot, ".git");
  const absoluteCommonDir = commonDir ? path.resolve(workspaceRoot, commonDir) : absoluteGitDir;
  const metadataIdentity = gitMetadataIdentity(absoluteGitDir, absoluteCommonDir);
  const isLinkedWorktree = Boolean(gitDir && commonDir && path.resolve(workspaceRoot, gitDir) !== path.resolve(workspaceRoot, commonDir));
  const sparseRun = git(workspaceRoot, ["sparse-checkout", "list"], { allowFailure: true });
  const sparse = sparseRun.status === 0 && String(sparseRun.stdout || "").trim().length > 0;
  const shallowRun = git(workspaceRoot, ["rev-parse", "--is-shallow-repository"], { allowFailure: true });
  const shallow = shallowRun.status === 0
    ? String(shallowRun.stdout || "").trim() === "true"
    : fs.existsSync(path.join(path.resolve(workspaceRoot, commonDir || gitDir || ".git"), "shallow"));
  const upstreamRefRun = git(workspaceRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { allowFailure: true });
  const upstreamRef = upstreamRefRun.status === 0 ? String(upstreamRefRun.stdout || "").trim() : null;
  const upstreamCommitRun = upstreamRef
    ? git(workspaceRoot, ["rev-parse", "@{upstream}"], { allowFailure: true })
    : { status: 1, stdout: "" };
  const upstreamCommit = upstreamCommitRun.status === 0 ? String(upstreamCommitRun.stdout || "").trim() : null;
  const projectMarkers = [
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json"
  ].filter((relative) => fs.existsSync(path.join(workspaceRoot, relative)));
  const submoduleRun = git(workspaceRoot, ["submodule", "status", "--recursive"], { allowFailure: true });
  const submoduleLines = submoduleRun.status === 0
    ? String(submoduleRun.stdout || "").split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean)
    : [];
  const incompleteSubmodules = submoduleLines.filter((line) => /^[-+U]/.test(line));
  const materializationReasons = [
    ...(sparse ? ["sparse-checkout"] : []),
    ...(shallow ? ["shallow-history"] : []),
    ...(incompleteSubmodules.length ? ["submodules-not-at-recorded-commit"] : [])
  ];
  const body = {
    schemaVersion: CONTEXT_MANIFEST_VERSION,
    workspaceRoot,
    git: {
      branch: branch || null,
      head: head || null,
      dirtyPaths,
      dirtyEntries,
      dirtyDigest,
      dirtyEntryCount: dirtySnapshot.count,
      dirtyEntriesTruncated: dirtySnapshot.truncated,
      ignoredDigest: ignoredSnapshot.digest,
      ignoredEntryCount: ignoredSnapshot.count,
      ignoredEntries: ignoredSnapshot.entries,
      ignoredEntriesAttributable: ignoredSnapshot.attributable,
      ignoredInventoryComplete: ignoredSnapshot.complete,
      trackedTreeIdentity: trackedTree,
      metadataIdentity,
      insideWorktree,
      linkedWorktree: isLinkedWorktree,
      sparse,
      shallow,
      upstreamRef,
      upstreamCommit,
      upstreamFreshness: "not_checked"
    },
    projectMarkers,
    materialization: {
      state: materializationReasons.length ? "partial" : "local_complete",
      reasons: materializationReasons,
      submodules: submoduleLines.slice(0, 100),
      upstreamFreshness: "not_checked"
    }
  };
  const digest = sha(canonicalJson(body));
  return {
    ...body,
    manifestId: `ctx-${digest.slice(0, 24)}`,
    digest,
    capturedAt: timestamp()
  };
}

export function assertTaskContextReady(envelope, manifest, { structuredInput = false } = {}) {
  if (!structuredInput) return;
  const expectedMarkers = envelope?.context?.expectedProjectMarkers || [];
  const availableMarkers = new Set(manifest?.projectMarkers || []);
  const missingMarkers = expectedMarkers.filter((marker) => !availableMarkers.has(marker));
  const workspaceRoot = manifest?.workspaceRoot ? fs.realpathSync(manifest.workspaceRoot) : null;
  const requiredPaths = envelope?.context?.requiredPaths || [];
  const missingPaths = [];
  const unsafePaths = [];
  for (const relative of requiredPaths) {
    if (!workspaceRoot) { missingPaths.push(relative); continue; }
    const absolute = path.resolve(workspaceRoot, relative);
    if (absolute === workspaceRoot || !absolute.startsWith(`${workspaceRoot}${path.sep}`) || !fs.existsSync(absolute)) {
      missingPaths.push(relative);
      continue;
    }
    try {
      const real = fs.realpathSync(absolute);
      if (real !== workspaceRoot && !real.startsWith(`${workspaceRoot}${path.sep}`)) unsafePaths.push(relative);
    } catch {
      missingPaths.push(relative);
    }
  }
  const workspaceState = envelope?.context?.workspaceState || "unknown";
  const reasons = [];
  if (workspaceState === "unknown") reasons.push("host-workspace-state-unknown");
  if (workspaceState === "task_scoped" && requiredPaths.length === 0) {
    reasons.push("task-scoped-inventory-missing");
  }
  if (workspaceState === "complete" && manifest?.materialization?.state !== "local_complete") {
    reasons.push(...(manifest?.materialization?.reasons || ["workspace-not-fully-materialized"]));
  }
  if (workspaceState === "complete" && envelope?.context?.upstreamFreshness !== "verified") {
    reasons.push("upstream-freshness-not-verified");
  }
  if (envelope?.mode === "write" && manifest?.git?.ignoredInventoryComplete === false) {
    reasons.push("ignored-worktree-inventory-incomplete");
  }
  if (missingMarkers.length) reasons.push(`missing-project-markers:${missingMarkers.join(",")}`);
  if (missingPaths.length) reasons.push(`missing-required-paths:${missingPaths.join(",")}`);
  if (unsafePaths.length) reasons.push(`required-paths-escape-workspace:${unsafePaths.join(",")}`);
  if (reasons.length) {
    throw new CompanionError(
      "E_CONTEXT_INCOMPLETE",
      `Task context is not ready for delegation (${reasons.join("; ")}). Complete host preflight or mark a bounded task_scoped checkout explicitly.`,
      { reasons, missingMarkers, missingPaths, unsafePaths, workspaceState, materialization: manifest?.materialization || null }
    );
  }
}

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
 * Fingerprint ignored worktree paths that `git status --untracked-files=all` omits.
 * Small files receive content hashes up to a global budget; every path also carries
 * high-resolution metadata so ordinary search/replace writes remain observable.
 * Large inventories retain only a digest and fail closed to an unattributed marker.
 */
function ignoredWorktreeSnapshot(root) {
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
      complete: false
    };
  }
  const allPaths = String(run.stdout || "").split("\0").filter(Boolean).sort();
  const complete = allPaths.length <= MAX_IGNORED_PATHS;
  const paths = allPaths.slice(0, MAX_IGNORED_PATHS);
  const attributable = complete && paths.length <= MAX_IGNORED_ATTRIBUTABLE;
  const entries = [];
  const digest = crypto.createHash("sha256");
  digest.update("ignored-v1\0");
  let hashedBytes = 0;
  for (const relativePath of paths) {
    const absolute = path.resolve(root, relativePath);
    let identity;
    if (absolute === root || !absolute.startsWith(`${root}${path.sep}`)) {
      identity = { kind: "outside" };
    } else {
      try {
        const stat = fs.lstatSync(absolute, { bigint: true });
        const mode = Number(stat.mode & 0o7777n);
        if (stat.isSymbolicLink()) {
          identity = { kind: "symlink", mode, targetDigest: sha(fs.readlinkSync(absolute)) };
        } else if (stat.isFile()) {
          const size = Number(stat.size);
          const mayHash = Number.isSafeInteger(size) && size >= 0 && hashedBytes + size <= MAX_IGNORED_HASH_BYTES;
          identity = {
            kind: "file",
            mode,
            size: stat.size.toString(),
            mtimeNs: stat.mtimeNs.toString(),
            ...(mayHash ? { contentDigest: hashFile(absolute) } : { contentDigest: null })
          };
          if (mayHash) hashedBytes += size;
        } else if (stat.isDirectory()) {
          identity = { kind: "directory", mode, mtimeNs: stat.mtimeNs.toString() };
        } else {
          identity = { kind: "other", mode, mtimeNs: stat.mtimeNs.toString() };
        }
      } catch (error) {
        identity = { kind: error?.code === "ENOENT" ? "missing" : "unreadable", code: String(error?.code || "ERR").slice(0, 32) };
      }
    }
    const fingerprint = canonicalJson(identity);
    digest.update(`${relativePath.length}:`);
    digest.update(relativePath);
    digest.update("\0");
    digest.update(fingerprint);
    digest.update("\0");
    if (attributable) entries.push({ path: relativePath.slice(0, 4096), fingerprint });
  }
  digest.update(`count=${allPaths.length};complete=${complete}`);
  return {
    digest: digest.digest("hex"),
    count: allPaths.length,
    entries,
    attributable,
    complete
  };
}

function gitMetadataIdentity(gitDir, commonDir) {
  const entries = [];
  const roots = [
    [gitDir, ["HEAD", "commondir", "gitdir"]],
    [commonDir, ["config", "packed-refs", "refs", "hooks", "info/exclude", "info/attributes"]]
  ];
  const visit = (base, relative, depth = 0) => {
    if (entries.length >= 10_000 || depth > 32) return;
    const absolute = path.join(base, relative);
    let stat;
    try { stat = fs.lstatSync(absolute); } catch { return; }
    const key = `${base === gitDir ? "git" : "common"}/${relative.replace(/\\/g, "/")}`;
    if (stat.isSymbolicLink()) {
      entries.push({ path: key, kind: "symlink", mode: stat.mode & 0o7777, digest: sha(fs.readlinkSync(absolute)) });
      return;
    }
    if (stat.isFile()) {
      entries.push({ path: key, kind: "file", mode: stat.mode & 0o7777, size: stat.size, digest: hashFile(absolute) });
      return;
    }
    if (!stat.isDirectory()) {
      entries.push({ path: key, kind: "other", mode: stat.mode & 0o7777 });
      return;
    }
    for (const name of fs.readdirSync(absolute).sort()) visit(base, path.join(relative, name), depth + 1);
  };
  for (const [base, relatives] of roots) for (const relative of relatives) visit(base, relative);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return sha(canonicalJson({ entries, truncated: entries.length >= 10_000 }));
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

/**
 * Validate current workspace still matches a stored ContextManifest.
 * Throws E_CONTEXT_DRIFT rather than executing in the wrong checkout.
 *
 * mode:
 * Both execute and explicit resume require the exact recorded checkout state. Resume callers
 * must pass the previous job's completion manifest, not its acceptance-time manifest.
 * "legacy-resume" exists only for schema-v2 jobs that did not retain a completion manifest.
 */
export function assertContextCompatible(root, expected, { mode = "execute" } = {}) {
  if (!expected || typeof expected !== "object") {
    throw new CompanionError("E_CONTEXT_DRIFT", "Stored context manifest is missing; refusing to continue in an unverified workspace.", {
      code: "E_CONTEXT_DRIFT"
    });
  }
  const current = captureContextManifest(root);
  const reasons = [];
  if (current.workspaceRoot !== expected.workspaceRoot) reasons.push("workspaceRoot");
  if (Boolean(current.git?.linkedWorktree) !== Boolean(expected.git?.linkedWorktree)) reasons.push("linkedWorktree");
  if (Boolean(current.git?.sparse) !== Boolean(expected.git?.sparse)) reasons.push("sparse");
  if (Boolean(current.git?.shallow) !== Boolean(expected.git?.shallow)) reasons.push("shallow");
  if ((current.git?.branch || null) !== (expected.git?.branch || null)) reasons.push("branch");
  if (Boolean(current.git?.insideWorktree) !== Boolean(expected.git?.insideWorktree)) reasons.push("insideWorktree");
  if (Array.isArray(expected.projectMarkers)
    && canonicalJson(current.projectMarkers) !== canonicalJson(expected.projectMarkers)) reasons.push("projectMarkers");
  if (mode !== "legacy-resume") {
    if ((current.git?.head || null) !== (expected.git?.head || null)) reasons.push("head");
    if ((current.git?.trackedTreeIdentity || null) !== (expected.git?.trackedTreeIdentity || null)) reasons.push("trackedTreeIdentity");
    if ((current.git?.metadataIdentity || null) !== (expected.git?.metadataIdentity || null)) reasons.push("metadataIdentity");
    if ((current.git?.dirtyDigest || null) !== (expected.git?.dirtyDigest || null)) reasons.push("dirtyDigest");
    if ((current.git?.ignoredDigest || null) !== (expected.git?.ignoredDigest || null)) reasons.push("ignoredDigest");
    if ((current.git?.upstreamRef || null) !== (expected.git?.upstreamRef || null)) reasons.push("upstreamRef");
    if ((current.git?.upstreamCommit || null) !== (expected.git?.upstreamCommit || null)) reasons.push("upstreamCommit");
  }
  if (reasons.length) {
    throw new CompanionError(
      "E_CONTEXT_DRIFT",
      `Workspace identity drifted (${reasons.join(", ")}); refusing to execute or resume in a different checkout.`,
      {
        code: "E_CONTEXT_DRIFT",
        reasons,
        expected: {
          manifestId: expected.manifestId || null,
          digest: expected.digest || null,
          workspaceRoot: expected.workspaceRoot || null,
          head: expected.git?.head || null,
          branch: expected.git?.branch || null
        },
        current: {
          manifestId: current.manifestId,
          digest: current.digest,
          workspaceRoot: current.workspaceRoot,
          head: current.git?.head || null,
          branch: current.git?.branch || null
        }
      }
    );
  }
  return current;
}

export function appendLifecycleEvent(events, type, summary, detail = undefined) {
  if (!LIFECYCLE_EVENT_TYPES.includes(type)) {
    throw new CompanionError("E_STATE", `Unknown lifecycle event type ${type}.`);
  }
  const list = Array.isArray(events) ? events.slice(-MAX_LIFECYCLE_EVENTS + 1) : [];
  const entry = {
    type,
    at: timestamp(),
    summary: clip(redactText(summary || type), 500)
  };
  if (detail !== undefined) entry.detail = redact(boundLifecycleDetail(detail));
  list.push(entry);
  return list;
}

function boundLifecycleDetail(detail) {
  if (detail == null) return null;
  if (typeof detail === "string") return clip(detail, 1000);
  if (Array.isArray(detail)) return detail.slice(0, 20).map((item) => boundLifecycleDetail(item));
  if (typeof detail !== "object") return detail;
  const out = {};
  for (const [key, value] of Object.entries(detail).slice(0, 20)) {
    if (/(secret|token|authorization|password|credential|cookie|api[-_]?key)/i.test(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    if (typeof value === "string") out[key] = clip(value, 1000);
    else if (Array.isArray(value)) out[key] = value.slice(0, 20).map((item) => (typeof item === "string" ? clip(item, 500) : item));
    else if (value && typeof value === "object") out[key] = boundLifecycleDetail(value);
    else out[key] = value;
  }
  return out;
}

/**
 * Build a structured final worker report from provider output.
 * Interim message text must not be passed here.
 */
export function buildWorkerReport({
  providerText = "",
  outcome = null,
  summary = null,
  changedFiles = null,
  checksClaimed = null,
  acceptanceResults = null,
  risks = null,
  questions = null,
  acceptanceCriteria = []
} = {}) {
  const parsedReport = parseStructuredWorkerPayload(providerText);
  const parsed = parsedReport?.value || null;
  const text = clip(String(providerText || "").trim());
  const requiredFields = ["outcome", "summary", "changedFiles", "checksClaimed", "acceptanceResults", "risks", "questions"];
  const allowedFields = new Set(requiredFields);
  const shapeIssues = [];
  if (parsed) {
    for (const field of requiredFields) if (!Object.hasOwn(parsed, field)) shapeIssues.push(`Structured worker report omitted ${field}.`);
    for (const field of Object.keys(parsed)) if (!allowedFields.has(field)) shapeIssues.push(`Structured worker report included unsupported field ${field}.`);
    if (typeof parsed.summary !== "string" || !parsed.summary.trim()) shapeIssues.push("Structured worker report summary must be a non-empty string.");
    for (const field of ["changedFiles", "checksClaimed", "acceptanceResults", "risks", "questions"]) {
      if (!Array.isArray(parsed[field])) shapeIssues.push(`Structured worker report ${field} must be an array.`);
    }
  }
  const resolvedSummary = clip(
    summary
      || (typeof parsed?.summary === "string" ? parsed.summary : null)
      || text.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
      || "Completed"
  , 2000);
  const normalizedPaths = normalizeClaimedPaths(changedFiles ?? parsed?.changedFiles);
  const files = normalizedPaths.paths;
  const checks = asStringList(checksClaimed ?? parsed?.checksClaimed);
  const risksList = asStringList(risks ?? parsed?.risks);
  const questionsList = asStringList(questions ?? parsed?.questions);
  const criteria = Array.isArray(acceptanceCriteria) ? acceptanceCriteria : [];
  const normalizedAcceptance = normalizeAcceptanceResults(acceptanceResults ?? parsed?.acceptanceResults, criteria);
  const requestedOutcome = ["complete", "partial", "blocked"].includes(outcome)
    ? outcome
    : ["complete", "partial", "blocked"].includes(parsed?.outcome)
      ? parsed.outcome
      : null;
  const validationIssues = [...shapeIssues, ...normalizedPaths.issues, ...normalizedAcceptance.issues];
  if (parsed && !requestedOutcome) validationIssues.push("Structured worker report omitted a valid outcome.");
  if (!parsed) validationIssues.push("Provider did not return a GROK_WORKER_REPORT JSON object.");
  else if (!parsedReport.markerPresent) validationIssues.push("Provider returned JSON without the required GROK_WORKER_REPORT marker.");
  const resolvedOutcome = requestedOutcome || "partial";
  return {
    schemaVersion: WORKER_REPORT_VERSION,
    structured: Boolean(parsedReport?.markerPresent),
    valid: Boolean(parsedReport?.markerPresent) && validationIssues.length === 0,
    outcome: resolvedOutcome,
    summary: resolvedSummary,
    changedFiles: files,
    checksClaimed: checks,
    acceptanceResults: normalizedAcceptance.results,
    risks: risksList,
    questions: questionsList,
    validationIssues
  };
}

/** Build one same-session, no-tool repair turn for a malformed final worker report. */
export function composeWorkerReportRepairPrompt(envelope, report) {
  const criteria = Array.isArray(envelope?.acceptanceCriteria) ? envelope.acceptanceCriteria : [];
  const acceptanceTemplate = criteria.map((criterion) => ({
    id: criterion.id,
    status: "unknown",
    note: "short evidence"
  }));
  const template = {
    outcome: "partial",
    summary: "concise factual summary",
    changedFiles: ["repository/relative/path"],
    checksClaimed: ["only checks actually run with available tools"],
    acceptanceResults: acceptanceTemplate,
    risks: ["remaining risk"],
    questions: ["blocking question"]
  };
  const issues = asStringList(report?.validationIssues, { max: 20 });
  return [
    "Report-format repair only. The task turn already ran.",
    "Do not call tools, inspect files, modify the workspace, or repeat implementation.",
    `The previous report was invalid: ${issues.join("; ") || "required report marker/schema missing"}.`,
    "Return exactly one line. It must begin with GROK_WORKER_REPORT: followed immediately by one JSON object.",
    "Use exactly the seven keys shown below, no Markdown fence, no prose before or after, and exactly one acceptance result for every supplied ID. Choose outcome from complete, partial, or blocked; choose each status from met, unmet, or unknown.",
    `GROK_WORKER_REPORT: ${JSON.stringify(template)}`
  ].join("\n");
}

function normalizeClaimedPaths(items) {
  if (!Array.isArray(items)) return { paths: [], issues: [] };
  const paths = [];
  const issues = [];
  for (const item of items.slice(0, 200)) {
    const value = clip(String(item ?? "").trim(), 1024).replace(/\\/g, "/");
    if (!value || path.posix.isAbsolute(value) || /^[A-Za-z]:\//.test(value) || value.split("/").includes("..")) {
      issues.push(`Worker reported an invalid repository path: ${value || "(empty)"}.`);
      continue;
    }
    paths.push(value.replace(/^\.\//, ""));
  }
  return { paths: [...new Set(paths)], issues };
}

function normalizeAcceptanceResults(items, criteria) {
  const declared = Array.isArray(criteria) ? criteria.slice(0, MAX_LIST) : [];
  const provided = Array.isArray(items) ? items.slice(0, MAX_LIST) : [];
  const issues = [];
  if (!declared.length) {
    const results = provided.map((item, index) => {
      const value = typeof item === "string" ? { note: item } : item || {};
      return {
        id: stableAcceptanceId(index, value.id),
        status: ["met", "unmet", "unknown"].includes(value.status) ? value.status : "unknown",
        ...(value.note != null ? { note: clip(String(value.note), MAX_ITEM) } : {})
      };
    });
    return { results, issues };
  }
  const allowed = new Set(declared.map((item) => item.id));
  const byId = new Map();
  provided.forEach((item, index) => {
    const value = typeof item === "string" ? { note: item } : item || {};
    const id = String(value.id || declared[index]?.id || "");
    if (!allowed.has(id)) {
      issues.push(`Unknown acceptance criterion ${id || `(index ${index})`}.`);
      return;
    }
    if (byId.has(id)) {
      issues.push(`Duplicate acceptance result ${id}.`);
      return;
    }
    const status = ["met", "unmet", "unknown"].includes(value.status) ? value.status : "unknown";
    if (status === "unknown" && value.status !== "unknown") issues.push(`Acceptance result ${id} has invalid status ${String(value.status ?? "(missing)")}.`);
    byId.set(id, {
      id,
      status,
      ...(value.note != null ? { note: clip(String(value.note), MAX_ITEM) } : {})
    });
  });
  const results = declared.map((criterion) => {
    if (byId.has(criterion.id)) return byId.get(criterion.id);
    issues.push(`Missing acceptance result ${criterion.id}.`);
    return { id: criterion.id, status: "unknown", note: "Provider did not report this criterion." };
  });
  return { results, issues };
}

function parseStructuredWorkerPayload(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  const tryParse = (raw) => {
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
      }
    } catch {}
    return null;
  };
  const marker = trimmed.lastIndexOf("GROK_WORKER_REPORT:");
  if (marker >= 0) {
    const marked = extractFirstJsonObject(trimmed.slice(marker + "GROK_WORKER_REPORT:".length));
    const parsed = marked ? tryParse(marked) : null;
    if (parsed) return { value: parsed, markerPresent: true };
  }
  const direct = tryParse(trimmed);
  if (direct) return { value: direct, markerPresent: false };
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const nested = tryParse(fenced[1].trim());
    if (nested) return { value: nested, markerPresent: false };
  }
  let candidate = null;
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] !== "{") continue;
    const extracted = extractFirstJsonObject(trimmed.slice(index));
    const parsed = extracted ? tryParse(extracted) : null;
    if (parsed) candidate = parsed;
  }
  if (candidate) return { value: candidate, markerPresent: false };
  return null;
}

function extractFirstJsonObject(text) {
  const source = String(text || "");
  const start = source.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  return null;
}

/**
 * Observe runtime evidence independent of provider claims.
 * hostVerification is always not_run from the Grok runtime.
 */
export function buildRuntimeEvidence({
  preContext = null,
  postContext = null,
  changedPaths = null,
  diffSummary = null,
  commandOutcomes = null,
  scopeViolations = null,
  executionStatus = "completed"
} = {}) {
  return {
    schemaVersion: 1,
    preContext: preContext
      ? {
          manifestId: preContext.manifestId || null,
          digest: preContext.digest || null,
          head: preContext.git?.head || null,
          branch: preContext.git?.branch || null,
          dirtyDigest: preContext.git?.dirtyDigest || null,
          ignoredDigest: preContext.git?.ignoredDigest || null,
          trackedTreeIdentity: preContext.git?.trackedTreeIdentity || null,
          metadataIdentity: preContext.git?.metadataIdentity || null
        }
      : null,
    postContext: postContext
      ? {
          manifestId: postContext.manifestId || null,
          digest: postContext.digest || null,
          head: postContext.git?.head || null,
          branch: postContext.git?.branch || null,
          dirtyDigest: postContext.git?.dirtyDigest || null,
          ignoredDigest: postContext.git?.ignoredDigest || null,
          trackedTreeIdentity: postContext.git?.trackedTreeIdentity || null,
          metadataIdentity: postContext.git?.metadataIdentity || null
        }
      : null,
    observedChangedPaths: boundPathEvidence(changedPaths),
    diffSummary: diffSummary ? clip(String(diffSummary), 4000) : null,
    commandOutcomes: Array.isArray(commandOutcomes)
      ? commandOutcomes.slice(0, 40).map((item) => ({
          command: clip(String(item?.command || "command"), 200),
          status: clip(String(item?.status || "unknown"), 64),
          exitCode: Number.isInteger(item?.exitCode) ? item.exitCode : null
        }))
      : [],
    scopeViolations: boundPathEvidence(scopeViolations, { marker: "[SCOPE_VIOLATIONS_OVERFLOW]" }),
    executionStatus: clip(String(executionStatus || "completed"), 64),
    hostVerification: "not_run"
  };
}

export function evaluateScope(paths, scope = null) {
  const include = asStringList(scope?.include, { max: 64 }).map((item) => item.replace(/\\/g, "/"));
  const exclude = asStringList(scope?.exclude, { max: 64 }).map((item) => item.replace(/\\/g, "/"));
  const matches = (relativePath, pattern) => globToRegExp(pattern).test(relativePath);
  return [...new Set(Array.isArray(paths) ? paths : [])].filter((rawPath) => {
    const relativePath = String(rawPath || "").replace(/\\/g, "/").replace(/^\.\//, "");
    if (!relativePath || relativePath.startsWith("[")) return true;
    const included = include.length === 0 || include.some((pattern) => matches(relativePath, pattern));
    const excluded = exclude.some((pattern) => matches(relativePath, pattern));
    return !included || excluded;
  });
}

function globToRegExp(pattern) {
  const source = String(pattern || "").replace(/^\.\//, "");
  let expression = "^";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "*" && source[index + 1] === "*") {
      if (source[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${expression}$`);
}

export function observeChangedPaths(preContext, postContext) {
  if (!preContext?.git || !postContext?.git) return [];
  const fingerprint = (entry) => canonicalJson({
    status: entry?.status || null,
    path: entry?.path || null,
    sourcePath: entry?.sourcePath || null,
    fileKind: entry?.fileKind || null,
    fileMode: entry?.fileMode ?? null,
    worktreeHash: entry?.worktreeHash || null
  });
  const toMap = (manifest) => {
    if (Array.isArray(manifest.git?.dirtyEntries)) {
      return new Map(manifest.git.dirtyEntries.map((entry) => [entry.path, fingerprint(entry)]));
    }
    return new Map((manifest.git?.dirtyPaths || []).map((entry) => [entry, entry]));
  };
  const before = toMap(preContext);
  const after = toMap(postContext);
  const changed = new Set();
  for (const [relativePath, value] of after) if (before.get(relativePath) !== value) changed.add(relativePath);
  for (const [relativePath, value] of before) if (after.get(relativePath) !== value) changed.add(relativePath);
  for (const entry of [...(preContext.git.dirtyEntries || []), ...(postContext.git.dirtyEntries || [])]) {
    if (entry?.sourcePath && changed.has(entry.path)) changed.add(entry.sourcePath);
  }
  if ((preContext.git.dirtyDigest || null) !== (postContext.git.dirtyDigest || null)
    && (changed.size === 0 || preContext.git.dirtyEntriesTruncated || postContext.git.dirtyEntriesTruncated)) {
    changed.add("[DIRTY_OVERFLOW]");
  }
  if ((preContext.git.ignoredDigest || null) !== (postContext.git.ignoredDigest || null)) {
    if (preContext.git.ignoredEntriesAttributable && postContext.git.ignoredEntriesAttributable) {
      const beforeIgnored = new Map((preContext.git.ignoredEntries || []).map((entry) => [entry.path, entry.fingerprint]));
      const afterIgnored = new Map((postContext.git.ignoredEntries || []).map((entry) => [entry.path, entry.fingerprint]));
      for (const [relativePath, value] of afterIgnored) if (beforeIgnored.get(relativePath) !== value) changed.add(relativePath);
      for (const [relativePath, value] of beforeIgnored) if (afterIgnored.get(relativePath) !== value) changed.add(relativePath);
    } else {
      changed.add("[IGNORED_WORKTREE]");
    }
  }
  if ((preContext.git.head || null) !== (postContext.git.head || null)) changed.add("[HEAD]");
  if ((preContext.git.trackedTreeIdentity || null) !== (postContext.git.trackedTreeIdentity || null)) changed.add("[INDEX]");
  if ((preContext.git.metadataIdentity || null) !== (postContext.git.metadataIdentity || null)) changed.add("[GIT_METADATA]");
  // Keep the complete internally attributable set for scope evaluation. Public/runtime
  // projections apply boundPathEvidence separately and expose an explicit overflow marker.
  return [...changed];
}

/**
 * Compose the provider prompt from a TaskEnvelope without putting envelope JSON on argv.
 */
export function composeProviderPrompt(envelope, { root, constraints = null, contextManifest = null } = {}) {
  const context = envelope.context || { facts: [], constraints: [], expectedProjectMarkers: [], requiredPaths: [], workspaceState: "unknown", upstreamFreshness: "not_checked" };
  const facts = Array.isArray(context.facts) ? context.facts : [];
  const hostConstraints = Array.isArray(context.constraints) ? context.constraints : [];
  const manifestSummary = contextManifest
    ? [
        `workspace=${contextManifest.workspaceRoot}`,
        `branch=${contextManifest.git?.branch || "detached/unknown"}`,
        `head=${contextManifest.git?.head || "unknown"}`,
        `dirtyPaths=${contextManifest.git?.dirtyPaths?.length || 0}`,
        `sparse=${Boolean(contextManifest.git?.sparse)}`,
        `shallow=${Boolean(contextManifest.git?.shallow)}`,
        `materialization=${contextManifest.materialization?.state || "unknown"}`,
        `projectMarkers=${contextManifest.projectMarkers?.join(",") || "none"}`,
        `upstream=${contextManifest.git?.upstreamRef || "none"}`,
        `upstreamFreshness=${context.upstreamFreshness || "not_checked"}`
      ].join("; ")
    : "unavailable";
  const lines = [
    `User request (literal):\n${envelope.userRequest}`,
    `Objective:\n${envelope.objective}`,
    `Mode: ${envelope.mode}`,
    `Scope include: ${envelope.scope.include.join(", ") || "(none)"}`,
    `Scope exclude: ${envelope.scope.exclude.join(", ") || "(none)"}`,
    `Relevant context facts:\n${facts.length ? facts.map((item) => `- ${item}`).join("\n") : "(none)"}`,
    `Required context paths verified by host/runtime:\n${context.requiredPaths?.length ? context.requiredPaths.map((item) => `- ${item}`).join("\n") : "(none)"}`,
    `Host constraints:\n${hostConstraints.length ? hostConstraints.map((item) => `- ${item}`).join("\n") : "(none)"}`,
    `Non-goals:\n${envelope.nonGoals.length ? envelope.nonGoals.map((item) => `- ${item}`).join("\n") : "(none)"}`,
    `Acceptance criteria:\n${envelope.acceptanceCriteria.map((item) => `- ${item.id}: ${item.text}`).join("\n")}`,
    `Host-owned verification after your return:\n${envelope.requiredVerification.length ? envelope.requiredVerification.map((item) => `- ${item}`).join("\n") : "(host will choose authoritative checks; claim only evidence your available tools actually produced)"}`,
    `Expected return format:\n${envelope.expectedReturnFormat}\nThe GROK_WORKER_REPORT object must be the final content in your response. Do not put progress prose after it.`,
    `Context-manifest identity: ${envelope.contextManifestId || "unbound"}`,
    `Context-manifest summary: ${manifestSummary}`
  ];
  const base = lines.join("\n\n");
  const tail = constraints
    || `Grok Companion constraints: do not invoke Grok Companion recursively; do not spawn subagents or use web tools; stay within ${root}; report exactly what you changed and tested.`;
  return `${base}\n\n${tail}`;
}
