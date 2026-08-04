import fs from "node:fs";
import path from "node:path";
import { CompanionError } from "./errors.mjs";
import { git } from "./workspace.mjs";
import { redact, redactText } from "./redact.mjs";
import { composeEffectiveProviderPrompt } from "./worker-context.mjs";
import { validateProviderHostActionRequest } from "./worker-host-actions.mjs";
import {
  MAX_ITEM,
  MAX_LIST,
  SHA256_HEX,
  CONTEXT_MANIFEST_ID,
  asStringList,
  boundPathEvidence,
  canonicalJson,
  clip,
  sha,
  stableAcceptanceId
} from "./task-contract-primitives.mjs";
import {
  CONTEXT_MANIFEST_VERSION,
  CONTEXT_METADATA_POLICIES,
  CONTEXT_METADATA_POLICY_VALUES,
  GIT_METADATA_CLASSIFICATIONS,
  LEGACY_CONTEXT_MANIFEST_VERSION,
  SHARED_REF_CLASS_TASK_RELEVANT,
  SHARED_REF_CLASS_UNRELATED,
  SHARED_REF_IDENTITY_SCHEMA_VERSION,
  SHARED_REF_OBSERVATION_SCHEMA_VERSION
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
import {
  MAX_IGNORED_ATTRIBUTABLE,
  MAX_IGNORED_PATHS,
  ignoredWorktreeSnapshot,
  isVerificationCacheIgnoredPath,
  parseDirtyEntries
} from "./task-context-worktree.mjs";
import {
  captureEffectiveGitConfigIdentity,
  captureEffectiveHooksIdentity,
  captureTaskRelevantNonRefEntries,
  captureWorktreeOperationalIdentity,
  gitMetadataIdentity
} from "./task-git-controls.mjs";

export {
  TASK_ENVELOPE_VERSION,
  assertTaskEnvelope,
  bindTaskEnvelopeContext,
  buildTaskEnvelope,
  parseTaskEnvelopeInput,
  scrubStoredJob,
  scrubStoredRequest
} from "./task-envelope.mjs";
export { boundPathEvidence };
export { CONTEXT_MANIFEST_VERSION, CONTEXT_METADATA_POLICIES };
export { isVerificationCacheIgnoredPath };

export { evaluateScope } from "./task-scope.mjs";
export {
  LIFECYCLE_EVENT_TYPES,
  MAX_LIFECYCLE_EVENTS,
  appendLifecycleEvent,
  normalizeLifecycleEventSequences
} from "./task-lifecycle.mjs";

const timestamp = () => new Date().toISOString();

export const WORKER_REPORT_VERSION = 1;
const WORKER_REPORT_REQUIRED_FIELDS = Object.freeze([
  "outcome",
  "summary",
  "changedFiles",
  "checksClaimed",
  "acceptanceResults",
  "risks",
  "questions"
]);
const WORKER_REPORT_ALLOWED_FIELDS = Object.freeze([
  ...WORKER_REPORT_REQUIRED_FIELDS,
  "hostActionRequest"
]);
/** Cap for semantic shared-ref inventory; beyond this, identity is incomplete (fail closed). */
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
 * Code-owned JSON Schema passed through Grok Build's ACP `outputSchema`
 * extension. Grok performs the first structural validation; the broker still
 * owns semantic validation, exact acceptance-ID accounting, scope checks, and
 * host verification.
 */
export function buildWorkerReportOutputSchema(acceptanceCriteria = []) {
  const criteria = Array.isArray(acceptanceCriteria)
    ? acceptanceCriteria.slice(0, MAX_LIST)
    : [];
  const acceptanceIds = criteria
    .map((criterion) => criterion?.id)
    .filter((id) => typeof id === "string" && id.length > 0);
  const acceptanceItem = {
    type: "object",
    additionalProperties: false,
    required: ["id", "status"],
    properties: {
      id: acceptanceIds.length
        ? { type: "string", enum: acceptanceIds }
        : { type: "string", minLength: 1, maxLength: 80 },
      status: {
        type: "string",
        enum: ["met", "unmet", "unknown"]
      },
      note: { type: "string", maxLength: MAX_ITEM }
    }
  };
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: [...WORKER_REPORT_REQUIRED_FIELDS, "hostActionRequest"],
    properties: {
      outcome: {
        type: "string",
        enum: ["complete", "partial", "blocked"]
      },
      summary: {
        type: "string",
        minLength: 1,
        maxLength: 2000
      },
      changedFiles: {
        type: "array",
        maxItems: 200,
        items: { type: "string", minLength: 1, maxLength: 1024 }
      },
      checksClaimed: {
        type: "array",
        maxItems: MAX_LIST,
        items: { type: "string", maxLength: MAX_ITEM }
      },
      acceptanceResults: {
        type: "array",
        minItems: acceptanceIds.length,
        maxItems: acceptanceIds.length || MAX_LIST,
        items: acceptanceItem
      },
      risks: {
        type: "array",
        maxItems: MAX_LIST,
        items: { type: "string", maxLength: MAX_ITEM }
      },
      questions: {
        type: "array",
        maxItems: MAX_LIST,
        items: { type: "string", maxLength: MAX_ITEM }
      },
      hostActionRequest: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            required: ["schemaVersion", "kind", "requestedRoleId"],
            properties: {
              schemaVersion: { const: 1 },
              kind: { const: "role_admission" },
              requestedRoleId: {
                type: "string",
                enum: ["reviewer", "security", "test", "implementer"]
              }
            }
          }
        ]
      }
    }
  });
}
/**
 * Build TaskEnvelope v1 from structured fields or plain-text CLI task input.
 * Plain-text paths remain compatible by constructing a default envelope.
 */

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
  const upstreamRef = upstreamRefRun.status === 0 ? String(upstreamRefRun.stdout || "").trim() || null : null;
  const upstreamFullRefRun = git(workspaceRoot, ["rev-parse", "--symbolic-full-name", "@{upstream}"], { allowFailure: true });
  const upstreamFullRef = upstreamFullRefRun.status === 0
    ? String(upstreamFullRefRun.stdout || "").trim() || null
    : null;
  const upstreamCommitRun = upstreamRef
    ? git(workspaceRoot, ["rev-parse", "@{upstream}"], { allowFailure: true })
    : { status: 1, stdout: "" };
  const upstreamCommit = upstreamCommitRun.status === 0 ? String(upstreamCommitRun.stdout || "").trim() : null;
  const currentBranchRef = branch && branch !== "HEAD" ? `refs/heads/${branch}` : null;
  // Branch config may declare an upstream even when @{upstream} cannot resolve
  // (missing remote-tracking ref). That still counts as configured upstream.
  let upstreamConfiguredFromConfig = false;
  if (branch && branch !== "HEAD") {
    const remoteRun = git(workspaceRoot, ["config", "--get", `branch.${branch}.remote`], { allowFailure: true });
    const mergeRun = git(workspaceRoot, ["config", "--get", `branch.${branch}.merge`], { allowFailure: true });
    const remoteName = remoteRun.status === 0 ? String(remoteRun.stdout || "").trim() : "";
    const mergeName = mergeRun.status === 0 ? String(mergeRun.stdout || "").trim() : "";
    upstreamConfiguredFromConfig = Boolean(remoteName && mergeName);
  }
  // Positively resolved full upstream only: abbreviated/config names are not
  // enough to classify remote-tracking refs as task-relevant vs unrelated.
  const resolvedUpstreamFullRef = upstreamFullRef && upstreamFullRef.startsWith("refs/")
    ? upstreamFullRef
    : null;
  const upstreamConfigured = Boolean(upstreamRef) || upstreamConfiguredFromConfig;
  const taskMetadata = captureTaskRelevantGitMetadata(
    absoluteGitDir,
    absoluteCommonDir,
    workspaceRoot,
    {
      currentBranchRef,
      upstreamFullRef: resolvedUpstreamFullRef,
      upstreamConfigured
    }
  );
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
      // Verification-only identity excludes pytest/Python cache path components so
      // record-verification can tolerate host-check cache drift without weakening
      // ordinary resume or task-scope ignored-write protection.
      verificationIgnoredDigest: ignoredSnapshot.verificationDigest,
      verificationIgnoredEntryCount: ignoredSnapshot.verificationCount,
      verificationIgnoredEntries: ignoredSnapshot.verificationEntries,
      verificationIgnoredEntriesAttributable: ignoredSnapshot.verificationAttributable,
      verificationIgnoredInventoryComplete: ignoredSnapshot.verificationComplete,
      trackedTreeIdentity: trackedTree,
      metadataIdentity,
      // Explicit task-relevant / semantic shared-ref identity (issue #34).
      // Legacy metadataIdentity remains the full file-tree hash for mixed/legacy
      // comparisons; these fields enable tolerating only positively classified
      // unrelated shared refs when both sides are structurally valid.
      taskRelevantMetadataIdentity: taskMetadata.taskRelevantMetadataIdentity,
      sharedRefIdentity: taskMetadata.sharedRefIdentity,
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
  // capturedAt participates in the authenticated representation. Chronology is
  // security-relevant for ready promotion and replay, so a timestamp must never
  // be mutable while retaining the same manifest identity.
  const capturedAt = timestamp();
  const authenticatedBody = {
    ...body,
    capturedAt
  };
  const digest = sha(canonicalJson(authenticatedBody));
  return {
    ...authenticatedBody,
    manifestId: `ctx-${digest.slice(0, 24)}`,
    digest
  };
}

export function assertTaskContextReady(envelope, manifest, { structuredInput = false } = {}) {
  if (!structuredInput) return;
  const expectedMarkers = envelope?.context?.expectedProjectMarkers || [];
  const workspaceRoot = manifest?.workspaceRoot ? fs.realpathSync(manifest.workspaceRoot) : null;
  const missingMarkers = [];
  const unsafeMarkers = [];
  for (const relative of expectedMarkers) {
    if (!workspaceRoot) { missingMarkers.push(relative); continue; }
    const absolute = path.resolve(workspaceRoot, relative);
    if (absolute !== workspaceRoot && !absolute.startsWith(`${workspaceRoot}${path.sep}`)) {
      unsafeMarkers.push(relative);
      continue;
    }
    if (!fs.existsSync(absolute)) {
      missingMarkers.push(relative);
      continue;
    }
    try {
      const real = fs.realpathSync(absolute);
      if (real !== workspaceRoot && !real.startsWith(`${workspaceRoot}${path.sep}`)) {
        unsafeMarkers.push(relative);
      }
    } catch {
      missingMarkers.push(relative);
    }
  }
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
  if (unsafeMarkers.length) reasons.push(`project-markers-escape-workspace:${unsafeMarkers.join(",")}`);
  if (missingPaths.length) reasons.push(`missing-required-paths:${missingPaths.join(",")}`);
  if (unsafePaths.length) reasons.push(`required-paths-escape-workspace:${unsafePaths.join(",")}`);
  if (reasons.length) {
    throw new CompanionError(
      "E_CONTEXT_INCOMPLETE",
      `Task context is not ready for delegation (${reasons.join("; ")}). Correct the declared markers, paths, workspace state, or freshness evidence before delegating.`,
      {
        reasons,
        missingMarkers,
        unsafeMarkers,
        missingPaths,
        unsafePaths,
        workspaceState,
        materialization: manifest?.materialization || null
      }
    );
  }
}


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

  const entries = [];
  let hashedBytes = 0;
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

function captureTaskRelevantGitMetadata(gitDir, commonDir, workspaceRoot, {
  currentBranchRef = null,
  upstreamFullRef = null,
  upstreamConfigured = false
} = {}) {
  const nonRef = captureTaskRelevantNonRefEntries(gitDir, commonDir);
  const operational = captureWorktreeOperationalIdentity(gitDir, workspaceRoot);
  const hooks = captureEffectiveHooksIdentity(workspaceRoot);
  const config = captureEffectiveGitConfigIdentity(workspaceRoot);
  const indexFlags = captureIndexFlagObservation(workspaceRoot);
  const semanticRefs = captureSemanticSharedRefs(workspaceRoot);
  const sharedRefIdentity = buildSharedRefIdentity(semanticRefs, { currentBranchRef, upstreamFullRef });
  // Fail closed when non-ref / operational / effective-hooks / effective-config
  // inventory is truncated or unobservable, refs are unavailable, or a
  // configured upstream cannot be positively resolved to a full refs/ name.
  // Without a full upstream ref, remote-tracking refs must not be treated as
  // unrelated (which would incorrectly tolerate upstream target churn).
  const upstreamUnresolved = Boolean(upstreamConfigured) && !upstreamFullRef;
  if (
    nonRef.truncated
    || !nonRef.observable
    || operational.truncated
    || !operational.observable
    || !hooks.observable
    || hooks.truncated
    || !config.observable
    || config.truncated
    || !indexFlags.observable
    || indexFlags.truncated
    || !semanticRefs.available
    || upstreamUnresolved
  ) {
    sharedRefIdentity.complete = false;
    sharedRefIdentity.attributable = false;
    sharedRefIdentity.taskRelevantRefs = [];
    sharedRefIdentity.unrelatedRefs = [];
  }
  // Private digests only: operational/hooks/config absolute paths and raw
  // config values never appear here.
  const taskRelevantMetadataIdentity = sha(canonicalJson({
    nonRefIdentity: nonRef.identity,
    nonRefTruncated: nonRef.truncated,
    nonRefObservable: nonRef.observable,
    operationalIdentity: operational.identity,
    operationalObservable: operational.observable,
    hooksIdentity: hooks.identity,
    hooksObservable: hooks.observable,
    configIdentity: config.identity,
    configObservable: config.observable,
    indexFlagIdentity: indexFlags.identity,
    indexFlagObservable: indexFlags.observable,
    taskRelevantRefIdentity: sharedRefIdentity.taskRelevantRefIdentity,
    sharedRefComplete: sharedRefIdentity.complete,
    sharedRefAttributable: sharedRefIdentity.attributable,
    upstreamUnresolved
  }));
  return { taskRelevantMetadataIdentity, sharedRefIdentity };
}

function isSha256Hex(value) {
  return typeof value === "string" && SHA256_HEX.test(value);
}

function isPublicRefSnapshotEntry(entry) {
  return entry
    && typeof entry === "object"
    && !Array.isArray(entry)
    && typeof entry.name === "string"
    && entry.name.startsWith("refs/")
    && entry.name.length > 0
    && entry.name.length <= MAX_SHARED_REF_FIELD_BYTES
    && typeof entry.target === "string"
    && entry.target.length > 0
    && entry.target.length <= MAX_SHARED_REF_FIELD_BYTES
    && typeof entry.resolvedOid === "string"
    && /^[a-f0-9]{40,64}$/.test(entry.resolvedOid)
    && (entry.class === SHARED_REF_CLASS_TASK_RELEVANT || entry.class === SHARED_REF_CLASS_UNRELATED)
    && !entry.name.includes("\0")
    && !entry.target.includes("\0")
    && (entry.target.startsWith("refs/")
      || entry.target.toLowerCase() === entry.resolvedOid)
    && !/^(?:\/|[A-Za-z]:[\\/]|~\/)/.test(entry.target);
}

/**
 * Inspect explicit task-relevant metadata support on a stored git manifest.
 * Returns "absent" | "valid" | "malformed".
 */
function inspectTaskRelevantMetadataSupport(gitManifest) {
  if (!gitManifest || typeof gitManifest !== "object") return "absent";
  const hasTaskIdentity = Object.hasOwn(gitManifest, "taskRelevantMetadataIdentity");
  const hasShared = Object.hasOwn(gitManifest, "sharedRefIdentity");
  if (!hasTaskIdentity && !hasShared) return "absent";
  if (!hasTaskIdentity || !hasShared) return "malformed";
  if (!isSha256Hex(gitManifest.taskRelevantMetadataIdentity)) return "malformed";
  const identity = gitManifest.sharedRefIdentity;
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return "malformed";
  if (identity.schemaVersion !== SHARED_REF_IDENTITY_SCHEMA_VERSION) return "malformed";
  if (typeof identity.complete !== "boolean" || typeof identity.attributable !== "boolean") return "malformed";
  if (!Number.isInteger(identity.refCount) || identity.refCount < 0) return "malformed";
  if (!Number.isInteger(identity.taskRelevantRefCount) || identity.taskRelevantRefCount < 0) return "malformed";
  if (!Number.isInteger(identity.unrelatedRefCount) || identity.unrelatedRefCount < 0) return "malformed";
  if (identity.taskRelevantRefCount + identity.unrelatedRefCount !== identity.refCount) return "malformed";
  if (!isSha256Hex(identity.taskRelevantRefIdentity) || !isSha256Hex(identity.unrelatedRefIdentity)) {
    return "malformed";
  }
  if (!Array.isArray(identity.taskRelevantRefs) || !Array.isArray(identity.unrelatedRefs)) return "malformed";
  // complete ⇒ within inventory budget; attributable ⇒ complete and within
  // per-entry evidence budget. Reject impossible combinations.
  if (identity.complete && identity.refCount > MAX_SHARED_REFS) return "malformed";
  if (identity.attributable !== (identity.complete && identity.refCount <= MAX_SHARED_REF_ATTRIBUTABLE)) {
    return "malformed";
  }
  if (identity.taskRelevantRefs.length !== (identity.attributable ? identity.taskRelevantRefCount : 0)) {
    return "malformed";
  }
  if (identity.unrelatedRefs.length !== (identity.attributable ? identity.unrelatedRefCount : 0)) {
    return "malformed";
  }
  const names = new Set();
  for (const entry of [...identity.taskRelevantRefs, ...identity.unrelatedRefs]) {
    if (!isPublicRefSnapshotEntry(entry) || names.has(entry.name)) return "malformed";
    names.add(entry.name);
  }
  for (const entry of identity.taskRelevantRefs) {
    if (entry.class !== SHARED_REF_CLASS_TASK_RELEVANT) return "malformed";
  }
  for (const entry of identity.unrelatedRefs) {
    if (entry.class !== SHARED_REF_CLASS_UNRELATED) return "malformed";
  }
  return "valid";
}

/**
 * Compare Git metadata between two manifests.
 *
 * DEFAULT policy:
 * Both sides valid + complete + attributable + linkedWorktree=true: tolerate only
 * unrelated shared-ref identity changes (issue #34 linked-worktree scope).
 * Both sides valid with linkedWorktree=false: strict full metadataIdentity
 * comparison (no unrelated-ref tolerance); task-relevant identity still fails
 * closed for operational/hooks/config drift the legacy tree may omit.
 * Attribution is required only for linked-worktree unrelated-ref tolerance.
 * Primary complete-but-unattributable inventories with identical strict digests
 * pass; any primary full/task/ref identity drift fails.
 * Mismatched or missing linkedWorktree when new support is claimed: fail closed.
 * Both sides absent (pure legacy): full metadataIdentity comparison; equal digests pass.
 * Mixed or malformed claims: fail closed unconditionally (even when legacy digests match).
 * Incomplete inventories always fail closed. Linked unattributable inventories
 * fail closed (no unrelated-ref tolerance without attribution).
 *
 * SUPERVISORY_LINKED_WRITE policy (managed write primary-control rechecks only):
 * both sides must be valid, complete, attributable primary worktrees with identical
 * taskRelevantMetadataIdentity and taskRelevantRefIdentity; only unrelatedRefIdentity
 * and full metadataIdentity representation drift is tolerated. Linked, mixed,
 * incomplete, unattributable, or malformed inventories fail closed.
 */
function classifyGitMetadataObservation(
  preGit,
  postGit,
  metadataPolicy = CONTEXT_METADATA_POLICIES.DEFAULT
) {
  const empty = {
    schemaVersion: SHARED_REF_OBSERVATION_SCHEMA_VERSION,
    classification: GIT_METADATA_CLASSIFICATIONS.UNCHANGED,
    toleratedUnrelatedSharedRefChurn: false,
    taskRelevantMetadataDrift: false
  };
  const failClosed = {
    schemaVersion: SHARED_REF_OBSERVATION_SCHEMA_VERSION,
    classification: GIT_METADATA_CLASSIFICATIONS.FAIL_CLOSED,
    toleratedUnrelatedSharedRefChurn: false,
    taskRelevantMetadataDrift: true
  };
  const taskRelevantDrift = {
    schemaVersion: SHARED_REF_OBSERVATION_SCHEMA_VERSION,
    classification: GIT_METADATA_CLASSIFICATIONS.TASK_RELEVANT_METADATA_DRIFT,
    toleratedUnrelatedSharedRefChurn: false,
    taskRelevantMetadataDrift: true
  };
  const toleratedUnrelated = {
    schemaVersion: SHARED_REF_OBSERVATION_SCHEMA_VERSION,
    classification: GIT_METADATA_CLASSIFICATIONS.TOLERATED_UNRELATED_SHARED_REFS,
    toleratedUnrelatedSharedRefChurn: true,
    taskRelevantMetadataDrift: false
  };
  if (!preGit || !postGit) return empty;
  const preSupport = inspectTaskRelevantMetadataSupport(preGit);
  const postSupport = inspectTaskRelevantMetadataSupport(postGit);

  if (metadataPolicy === CONTEXT_METADATA_POLICIES.SUPERVISORY_LINKED_WRITE) {
    // Supervisory policy never degrades to legacy/mixed acceptance.
    if (preSupport !== "valid" || postSupport !== "valid") return failClosed;
    if (!preGit.sharedRefIdentity.complete || !postGit.sharedRefIdentity.complete) {
      return failClosed;
    }
    if (!preGit.sharedRefIdentity.attributable || !postGit.sharedRefIdentity.attributable) {
      return failClosed;
    }
    const preLinked = preGit.linkedWorktree;
    const postLinked = postGit.linkedWorktree;
    // Primary-vs-primary only: managed control-root rechecks.
    if (preLinked !== false || postLinked !== false) return failClosed;
    if (preGit.taskRelevantMetadataIdentity !== postGit.taskRelevantMetadataIdentity) {
      return taskRelevantDrift;
    }
    if (preGit.sharedRefIdentity.taskRelevantRefIdentity
      !== postGit.sharedRefIdentity.taskRelevantRefIdentity) {
      return taskRelevantDrift;
    }
    // Allow only unrelated-ref / full metadataIdentity representation drift.
    if (preGit.sharedRefIdentity.unrelatedRefIdentity
        !== postGit.sharedRefIdentity.unrelatedRefIdentity
      || (preGit.metadataIdentity || null) !== (postGit.metadataIdentity || null)) {
      return toleratedUnrelated;
    }
    return empty;
  }

  if (preSupport === "valid" && postSupport === "valid") {
    // Incomplete inventories cannot safely classify refs.
    if (!preGit.sharedRefIdentity.complete || !postGit.sharedRefIdentity.complete) {
      return failClosed;
    }
    // Linked-worktree tolerance requires explicit boolean linkedWorktree on both
    // sides. Missing or mismatched identity fails closed when new support is claimed.
    const preLinked = preGit.linkedWorktree;
    const postLinked = postGit.linkedWorktree;
    if (typeof preLinked !== "boolean" || typeof postLinked !== "boolean") {
      return failClosed;
    }
    if (preLinked !== postLinked) {
      return failClosed;
    }

    // Primary worktree: strict digest comparison; attribution not required.
    // complete-but-unattributable (>attributable cap, <=inventory cap) identical
    // manifests pass. Any full/task/ref identity drift still fails.
    if (!preLinked) {
      if (preGit.taskRelevantMetadataIdentity !== postGit.taskRelevantMetadataIdentity) {
        return taskRelevantDrift;
      }
      if ((preGit.metadataIdentity || null) !== (postGit.metadataIdentity || null)) {
        return taskRelevantDrift;
      }
      if (preGit.sharedRefIdentity.taskRelevantRefIdentity
        !== postGit.sharedRefIdentity.taskRelevantRefIdentity) {
        return taskRelevantDrift;
      }
      if (preGit.sharedRefIdentity.unrelatedRefIdentity
        !== postGit.sharedRefIdentity.unrelatedRefIdentity) {
        return taskRelevantDrift;
      }
      return empty;
    }

    // Linked worktree: attribution is required before unrelated-ref tolerance.
    if (!preGit.sharedRefIdentity.attributable || !postGit.sharedRefIdentity.attributable) {
      return failClosed;
    }

    // Linked worktree: tolerate only unrelated shared-ref identity changes.
    if (preGit.taskRelevantMetadataIdentity !== postGit.taskRelevantMetadataIdentity) {
      return taskRelevantDrift;
    }
    if (preGit.sharedRefIdentity.unrelatedRefIdentity !== postGit.sharedRefIdentity.unrelatedRefIdentity) {
      return toleratedUnrelated;
    }
    return empty;
  }

  // Pure legacy: both sides claim neither new field. Equal full metadataIdentity passes.
  if (preSupport === "absent" && postSupport === "absent") {
    if ((preGit.metadataIdentity || null) !== (postGit.metadataIdentity || null)) {
      return {
        schemaVersion: SHARED_REF_OBSERVATION_SCHEMA_VERSION,
        classification: GIT_METADATA_CLASSIFICATIONS.LEGACY_METADATA_DRIFT,
        toleratedUnrelatedSharedRefChurn: false,
        taskRelevantMetadataDrift: true
      };
    }
    return empty;
  }

  // Mixed (only one side has valid new identity) or any malformed claim:
  // fail closed unconditionally — never treat equal legacy digests as unchanged.
  return failClosed;
}

function observeGitMetadataDrift(preGit, postGit, changed) {
  const observation = classifyGitMetadataObservation(preGit, postGit);
  if (observation.taskRelevantMetadataDrift) changed.add("[GIT_METADATA]");
  return observation;
}

/**
 * ContextManifest v1 predates the split task-relevant/shared-ref identities.
 * When either side is a genuine v1 record, compare the retained full metadata
 * identity strictly. This permits an unchanged historical record to cross the
 * v1 -> v2 reader boundary without granting v2's linked-worktree ref-churn
 * tolerance to legacy evidence that cannot attribute that churn safely.
 */
function classifyContextGitMetadataObservation(
  preContext,
  postContext,
  metadataPolicy = CONTEXT_METADATA_POLICIES.DEFAULT
) {
  const legacyBoundary = preContext?.schemaVersion === LEGACY_CONTEXT_MANIFEST_VERSION
    || postContext?.schemaVersion === LEGACY_CONTEXT_MANIFEST_VERSION;
  if (!legacyBoundary) {
    return classifyGitMetadataObservation(
      preContext?.git,
      postContext?.git,
      metadataPolicy
    );
  }
  const unchanged = {
    schemaVersion: SHARED_REF_OBSERVATION_SCHEMA_VERSION,
    classification: GIT_METADATA_CLASSIFICATIONS.UNCHANGED,
    toleratedUnrelatedSharedRefChurn: false,
    taskRelevantMetadataDrift: false
  };
  const failClosed = {
    schemaVersion: SHARED_REF_OBSERVATION_SCHEMA_VERSION,
    classification: GIT_METADATA_CLASSIFICATIONS.FAIL_CLOSED,
    toleratedUnrelatedSharedRefChurn: false,
    taskRelevantMetadataDrift: true
  };
  const legacyDrift = {
    schemaVersion: SHARED_REF_OBSERVATION_SCHEMA_VERSION,
    classification: GIT_METADATA_CLASSIFICATIONS.LEGACY_METADATA_DRIFT,
    toleratedUnrelatedSharedRefChurn: false,
    taskRelevantMetadataDrift: true
  };
  if (metadataPolicy !== CONTEXT_METADATA_POLICIES.DEFAULT) return failClosed;
  const preMetadataIdentity = preContext?.git?.metadataIdentity;
  const postMetadataIdentity = postContext?.git?.metadataIdentity;
  if (!isSha256Hex(preMetadataIdentity) || !isSha256Hex(postMetadataIdentity)) {
    return failClosed;
  }
  return preMetadataIdentity === postMetadataIdentity
    ? unchanged
    : legacyDrift;
}

function observeContextGitMetadataDrift(preContext, postContext, changed) {
  const observation = classifyContextGitMetadataObservation(
    preContext,
    postContext
  );
  if (observation.taskRelevantMetadataDrift) changed.add("[GIT_METADATA]");
  return observation;
}


function isCanonicalIsoTimestamp(value) {
  if (typeof value !== "string" || !value) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function contextManifestIntegrityError(message = "Stored context manifest integrity check failed; refusing to continue with a tampered or malformed identity.") {
  throw new CompanionError("E_CONTEXT_DRIFT", message, {
    code: "E_CONTEXT_DRIFT",
    reasons: ["manifestIntegrity"]
  });
}

/**
 * Validate a stored ContextManifest's immutable body/digest/id/capturedAt binding.
 * Recomputes sha(canonicalJson(body)) after excluding only manifestId and digest.
 * capturedAt is chronology-bearing authority and therefore remains authenticated.
 * Returns the unchanged stored object on success; never rebinds identity.
 * Failures are privacy-safe E_CONTEXT_DRIFT (no private path/config/hook leakage).
 */
export function assertContextManifestIntegrity(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    contextManifestIntegrityError();
  }
  if (manifest.schemaVersion !== CONTEXT_MANIFEST_VERSION
    && manifest.schemaVersion !== LEGACY_CONTEXT_MANIFEST_VERSION) {
    contextManifestIntegrityError();
  }
  if (typeof manifest.workspaceRoot !== "string" || !manifest.workspaceRoot) {
    contextManifestIntegrityError();
  }
  if (!manifest.git || typeof manifest.git !== "object" || Array.isArray(manifest.git)) {
    contextManifestIntegrityError();
  }
  if (!Array.isArray(manifest.projectMarkers)) {
    contextManifestIntegrityError();
  }
  if (!manifest.materialization || typeof manifest.materialization !== "object"
    || Array.isArray(manifest.materialization)) {
    contextManifestIntegrityError();
  }
  if (typeof manifest.digest !== "string" || !SHA256_HEX.test(manifest.digest)) {
    contextManifestIntegrityError();
  }
  if (typeof manifest.manifestId !== "string"
    || !CONTEXT_MANIFEST_ID.test(manifest.manifestId)
    || manifest.manifestId !== `ctx-${manifest.digest.slice(0, 24)}`) {
    contextManifestIntegrityError();
  }
  if (!isCanonicalIsoTimestamp(manifest.capturedAt)) {
    contextManifestIntegrityError();
  }
  const body = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (key === "manifestId" || key === "digest") continue;
    if (manifest.schemaVersion === LEGACY_CONTEXT_MANIFEST_VERSION
      && key === "capturedAt") continue;
    body[key] = value;
  }
  const recomputed = sha(canonicalJson(body));
  if (recomputed !== manifest.digest
    || `ctx-${recomputed.slice(0, 24)}` !== manifest.manifestId) {
    contextManifestIntegrityError();
  }
  return manifest;
}

/**
 * Validate current workspace still matches a stored ContextManifest.
 * Throws E_CONTEXT_DRIFT rather than executing in the wrong checkout.
 *
 * Integrity-checks the stored expected manifest first and returns that unchanged
 * object on success so callers retain immutable stored ID/digest bindings.
 *
 * mode:
 * Both execute and explicit resume require the exact recorded checkout state. Resume callers
 * must pass the previous job's completion manifest, not its acceptance-time manifest.
 * "legacy-resume" exists only for schema-v2 jobs that did not retain a completion manifest.
 *
 * metadataPolicy:
 * DEFAULT keeps strict-primary / tolerant-linked classification.
 * SUPERVISORY_LINKED_WRITE is only for managed write primary-control rechecks and is
 * rejected under legacy-resume. Unknown policies fail closed.
 */
export function assertContextCompatible(root, expected, {
  mode = "execute",
  metadataPolicy = CONTEXT_METADATA_POLICIES.DEFAULT
} = {}) {
  if (!CONTEXT_METADATA_POLICY_VALUES.has(metadataPolicy)) {
    throw new CompanionError(
      "E_CONTEXT_DRIFT",
      "Unknown context metadata policy; refusing to continue with an unverified workspace identity.",
      { code: "E_CONTEXT_DRIFT", reasons: ["metadataPolicy"] }
    );
  }
  if (mode === "legacy-resume"
    && metadataPolicy === CONTEXT_METADATA_POLICIES.SUPERVISORY_LINKED_WRITE) {
    throw new CompanionError(
      "E_CONTEXT_DRIFT",
      "Supervisory linked-write context policy is unavailable for legacy resume.",
      { code: "E_CONTEXT_DRIFT", reasons: ["metadataPolicy"] }
    );
  }
  const stored = assertContextManifestIntegrity(expected);
  const current = captureContextManifest(root);
  const reasons = [];
  if (current.workspaceRoot !== stored.workspaceRoot) reasons.push("workspaceRoot");
  if (Boolean(current.git?.linkedWorktree) !== Boolean(stored.git?.linkedWorktree)) reasons.push("linkedWorktree");
  if (Boolean(current.git?.sparse) !== Boolean(stored.git?.sparse)) reasons.push("sparse");
  if (Boolean(current.git?.shallow) !== Boolean(stored.git?.shallow)) reasons.push("shallow");
  if ((current.git?.branch || null) !== (stored.git?.branch || null)) reasons.push("branch");
  if (Boolean(current.git?.insideWorktree) !== Boolean(stored.git?.insideWorktree)) reasons.push("insideWorktree");
  if (Array.isArray(stored.projectMarkers)
    && canonicalJson(current.projectMarkers) !== canonicalJson(stored.projectMarkers)) reasons.push("projectMarkers");
  if (mode !== "legacy-resume") {
    if ((current.git?.head || null) !== (stored.git?.head || null)) reasons.push("head");
    if ((current.git?.trackedTreeIdentity || null) !== (stored.git?.trackedTreeIdentity || null)) reasons.push("trackedTreeIdentity");
    const metadataObservation = classifyContextGitMetadataObservation(
      stored,
      current,
      metadataPolicy
    );
    if (metadataObservation.taskRelevantMetadataDrift) {
      const currentSupport = inspectTaskRelevantMetadataSupport(current.git);
      const expectedSupport = inspectTaskRelevantMetadataSupport(stored.git);
      if (currentSupport === "valid" && expectedSupport === "valid") {
        reasons.push("taskRelevantMetadataIdentity");
      } else {
        reasons.push("metadataIdentity");
      }
    }
    if ((current.git?.dirtyDigest || null) !== (stored.git?.dirtyDigest || null)) reasons.push("dirtyDigest");
    if ((current.git?.ignoredDigest || null) !== (stored.git?.ignoredDigest || null)) reasons.push("ignoredDigest");
    if ((current.git?.upstreamRef || null) !== (stored.git?.upstreamRef || null)) reasons.push("upstreamRef");
    if ((current.git?.upstreamCommit || null) !== (stored.git?.upstreamCommit || null)) reasons.push("upstreamCommit");
  }
  if (reasons.length) {
    throw new CompanionError(
      "E_CONTEXT_DRIFT",
      `Workspace identity drifted (${reasons.join(", ")}); refusing to execute or resume in a different checkout.`,
      {
        code: "E_CONTEXT_DRIFT",
        reasons,
        expected: {
          manifestId: stored.manifestId || null,
          digest: stored.digest || null,
          workspaceRoot: stored.workspaceRoot || null,
          head: stored.git?.head || null,
          branch: stored.git?.branch || null
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
  // Immutable stored authority: never rebind callers to a fresh capture.
  return stored;
}

/**
 * Build a structured final worker report from provider output.
 * Interim message text must not be passed here.
 */
export function buildWorkerReport(options = {}) {
  const {
    providerText = "",
    outcome = null,
    summary = null,
    changedFiles = null,
    checksClaimed = null,
    acceptanceResults = null,
    risks = null,
    questions = null,
    hostActionRequest = undefined,
    acceptanceCriteria = [],
    nativeStructuredOutput = undefined,
    nativeStructuredOutputError = undefined
  } = options;
  const nativeOutputPresent = Object.hasOwn(options, "nativeStructuredOutput");
  const nativeErrorPresent = Object.hasOwn(options, "nativeStructuredOutputError");
  const nativeOutputValidShape = nativeStructuredOutput
    && typeof nativeStructuredOutput === "object"
    && !Array.isArray(nativeStructuredOutput);
  const nativeShapeIssues = [];
  if (nativeOutputPresent && nativeErrorPresent) {
    nativeShapeIssues.push("ACP returned both structured output and a structured-output error.");
  } else if (nativeErrorPresent) {
    nativeShapeIssues.push("Grok Build could not produce schema-valid structured output.");
  } else if (nativeOutputPresent && !nativeOutputValidShape) {
    nativeShapeIssues.push("ACP structured output must be a Worker Report object.");
  }
  const parsedReport = nativeOutputPresent && !nativeErrorPresent && nativeOutputValidShape
    ? {
        value: nativeStructuredOutput,
        markerPresent: true,
        source: "acp-structured"
      }
    : (!nativeOutputPresent && !nativeErrorPresent
        ? parseStructuredWorkerPayload(providerText)
        : null);
  const parsed = parsedReport?.value || null;
  const text = clip(String(providerText || "").trim());
  const allowedFields = new Set(WORKER_REPORT_ALLOWED_FIELDS);
  const shapeIssues = [];
  if (parsed) {
    for (const field of WORKER_REPORT_REQUIRED_FIELDS) if (!Object.hasOwn(parsed, field)) shapeIssues.push(`Structured worker report omitted ${field}.`);
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
  const hostActionPresent = hostActionRequest !== undefined
    || Boolean(parsed && Object.hasOwn(parsed, "hostActionRequest"));
  const normalizedHostAction = validateProviderHostActionRequest(
    hostActionRequest !== undefined ? hostActionRequest : parsed?.hostActionRequest,
    { present: hostActionPresent }
  );
  const requestedOutcome = ["complete", "partial", "blocked"].includes(outcome)
    ? outcome
    : ["complete", "partial", "blocked"].includes(parsed?.outcome)
      ? parsed.outcome
      : null;
  const validationIssues = [
    ...nativeShapeIssues,
    ...shapeIssues,
    ...normalizedPaths.issues,
    ...normalizedAcceptance.issues,
    ...normalizedHostAction.issues
  ];
  if (parsed && !requestedOutcome) validationIssues.push("Structured worker report omitted a valid outcome.");
  if (!parsed && !nativeOutputPresent && !nativeErrorPresent) {
    validationIssues.push("Provider did not return a GROK_WORKER_REPORT JSON object.");
  } else if (parsed && parsedReport.source !== "acp-structured" && !parsedReport.markerPresent) {
    validationIssues.push("Provider returned JSON without the required GROK_WORKER_REPORT marker.");
  }
  const resolvedOutcome = requestedOutcome || "partial";
  const reportSource = parsedReport?.source === "acp-structured"
    ? "acp-structured"
    : nativeErrorPresent
      ? "acp-structured-error"
      : parsedReport?.markerPresent
        ? "text-marker"
        : "text-unmarked";
  const report = {
    schemaVersion: WORKER_REPORT_VERSION,
    structured: parsedReport?.source === "acp-structured"
      || Boolean(parsedReport?.markerPresent),
    valid: (
      parsedReport?.source === "acp-structured"
      || Boolean(parsedReport?.markerPresent)
    ) && validationIssues.length === 0,
    outcome: resolvedOutcome,
    summary: resolvedSummary,
    changedFiles: files,
    checksClaimed: checks,
    acceptanceResults: normalizedAcceptance.results,
    risks: risksList,
    questions: questionsList,
    ...(hostActionPresent && normalizedHostAction.ok
      ? { hostActionRequest: normalizedHostAction.value }
      : {}),
    validationIssues,
    reportSource,
    reportDigest: null
  };
  if (report.valid) {
    report.reportDigest = sha(canonicalJson({
      schemaVersion: report.schemaVersion,
      outcome: report.outcome,
      summary: report.summary,
      changedFiles: report.changedFiles,
      checksClaimed: report.checksClaimed,
      acceptanceResults: report.acceptanceResults,
      risks: report.risks,
      questions: report.questions,
      ...(Object.hasOwn(report, "hostActionRequest")
        ? { hostActionRequest: report.hostActionRequest }
        : {})
    }));
  }
  return report;
}

/** Build one same-session, no-tool-use repair turn for a malformed final worker report. */
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
    questions: ["blocking question"],
    hostActionRequest: null
  };
  const issues = asStringList(report?.validationIssues, { max: 20 });
  return [
    "Report-format repair only. The task turn already ran.",
    "Do not call tools, inspect files, modify the workspace, or repeat implementation.",
    `The previous report was invalid: ${issues.join("; ") || "required report marker/schema missing"}.`,
    "Return exactly one line. It must begin with GROK_WORKER_REPORT: followed immediately by one JSON object.",
    "Use exactly the eight keys shown below, no Markdown fence, no prose before or after, and exactly one acceptance result for every supplied ID. Choose outcome from complete, partial, or blocked; choose each status from met, unmet, or unknown. hostActionRequest must be null unless the worker is requesting one future read-only role admission.",
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
function projectRuntimeContextIdentity(context) {
  if (!context) return null;
  const identity = {
    manifestId: context.manifestId || null,
    digest: context.digest || null,
    head: context.git?.head || null,
    branch: context.git?.branch || null,
    dirtyDigest: context.git?.dirtyDigest || null,
    ignoredDigest: context.git?.ignoredDigest || null,
    trackedTreeIdentity: context.git?.trackedTreeIdentity || null,
    metadataIdentity: context.git?.metadataIdentity || null
  };
  if (isSha256Hex(context.git?.taskRelevantMetadataIdentity)) {
    identity.taskRelevantMetadataIdentity = context.git.taskRelevantMetadataIdentity;
  }
  if (inspectTaskRelevantMetadataSupport(context.git) === "valid") {
    identity.sharedRefIdentity = {
      schemaVersion: context.git.sharedRefIdentity.schemaVersion,
      complete: context.git.sharedRefIdentity.complete,
      refCount: context.git.sharedRefIdentity.refCount,
      taskRelevantRefCount: context.git.sharedRefIdentity.taskRelevantRefCount,
      unrelatedRefCount: context.git.sharedRefIdentity.unrelatedRefCount,
      taskRelevantRefIdentity: context.git.sharedRefIdentity.taskRelevantRefIdentity,
      unrelatedRefIdentity: context.git.sharedRefIdentity.unrelatedRefIdentity
    };
  }
  return identity;
}

export function buildRuntimeEvidence({
  preContext = null,
  postContext = null,
  changedPaths = null,
  diffSummary = null,
  commandOutcomes = null,
  scopeViolations = null,
  executionStatus = "completed"
} = {}) {
  const sharedRefObservation = preContext?.git && postContext?.git
    ? classifyContextGitMetadataObservation(preContext, postContext)
    : null;
  return {
    schemaVersion: 1,
    preContext: projectRuntimeContextIdentity(preContext),
    postContext: projectRuntimeContextIdentity(postContext),
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
    hostVerification: "not_run",
    // Bounded public-safe classification distinguishing tolerated unrelated
    // shared-ref churn from task-relevant Git metadata/ref drift (issue #34).
    ...(sharedRefObservation ? { sharedRefObservation } : {})
  };
}

/**
 * Observe path-level drift between two ContextManifests.
 *
 * observer:
 * - "full" (default): compare the complete ignored-worktree identity. Used for
 *   task completion scope checks and ordinary resume compatibility.
 * - "verification": compare the verification-only ignored identity that excludes
 *   exact `.pytest_cache` / `__pycache__` path components. Used only by
 *   record-verification. Older manifests without verification fields fall back
 *   fail-closed to the full ignored comparison.
 */
export function observeChangedPaths(preContext, postContext, { observer = "full" } = {}) {
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
  observeIgnoredDrift(preContext.git, postContext.git, changed, { observer });
  if ((preContext.git.head || null) !== (postContext.git.head || null)) changed.add("[HEAD]");
  if ((preContext.git.trackedTreeIdentity || null) !== (postContext.git.trackedTreeIdentity || null)) changed.add("[INDEX]");
  observeContextGitMetadataDrift(preContext, postContext, changed);
  // Keep the complete internally attributable set for scope evaluation. Public/runtime
  // projections apply boundPathEvidence separately and expose an explicit overflow marker.
  return [...changed];
}

function observeFullIgnoredDrift(preGit, postGit, changed) {
  if ((preGit.ignoredDigest || null) !== (postGit.ignoredDigest || null)) {
    if (preGit.ignoredEntriesAttributable && postGit.ignoredEntriesAttributable) {
      const beforeIgnored = new Map((preGit.ignoredEntries || []).map((entry) => [entry.path, entry.fingerprint]));
      const afterIgnored = new Map((postGit.ignoredEntries || []).map((entry) => [entry.path, entry.fingerprint]));
      for (const [relativePath, value] of afterIgnored) if (beforeIgnored.get(relativePath) !== value) changed.add(relativePath);
      for (const [relativePath, value] of beforeIgnored) if (afterIgnored.get(relativePath) !== value) changed.add(relativePath);
    } else {
      changed.add("[IGNORED_WORKTREE]");
    }
  }
}

function hasVerificationIgnoredIdentity(gitManifest) {
  if (!gitManifest || typeof gitManifest !== "object") return false;
  const digest = gitManifest.verificationIgnoredDigest;
  const entries = gitManifest.verificationIgnoredEntries;
  const count = gitManifest.verificationIgnoredEntryCount;
  const attributable = gitManifest.verificationIgnoredEntriesAttributable;
  const complete = gitManifest.verificationIgnoredInventoryComplete;
  if (typeof digest !== "string"
    || !/^[a-f0-9]{64}$/.test(digest)
    || !Number.isInteger(count)
    || count < 0
    || !Array.isArray(entries)
    || typeof attributable !== "boolean"
    || typeof complete !== "boolean") return false;
  // A captured inventory is complete exactly while it remains within the path
  // budget, and it is attributable exactly while the complete inventory also
  // remains within the per-path evidence budget. Reject impossible combinations
  // rather than trusting an equal but malformed verification digest.
  if (complete !== (count <= MAX_IGNORED_PATHS)) return false;
  if (attributable !== (complete && count <= MAX_IGNORED_ATTRIBUTABLE)) return false;
  if (entries.length !== (attributable ? count : 0)) return false;
  const paths = new Set();
  for (const entry of entries) {
    if (typeof entry?.path !== "string"
      || !entry.path
      || typeof entry?.fingerprint !== "string"
      || !entry.fingerprint
      || isVerificationCacheIgnoredPath(entry.path)
      || paths.has(entry.path)) return false;
    paths.add(entry.path);
  }
  return true;
}

function observeIgnoredDrift(preGit, postGit, changed, { observer }) {
  if (observer === "verification") {
    // Fail closed: missing or malformed verification identity on either side
    // reverts to the complete ignored-worktree comparison.
    if (!hasVerificationIgnoredIdentity(preGit) || !hasVerificationIgnoredIdentity(postGit)) {
      observeFullIgnoredDrift(preGit, postGit, changed);
      return;
    }
    const preDigest = preGit.verificationIgnoredDigest;
    const postDigest = postGit.verificationIgnoredDigest;
    if (preDigest !== postDigest) {
      if (preGit.verificationIgnoredEntriesAttributable && postGit.verificationIgnoredEntriesAttributable) {
        const beforeIgnored = new Map((preGit.verificationIgnoredEntries || []).map((entry) => [entry.path, entry.fingerprint]));
        const afterIgnored = new Map((postGit.verificationIgnoredEntries || []).map((entry) => [entry.path, entry.fingerprint]));
        for (const [relativePath, value] of afterIgnored) if (beforeIgnored.get(relativePath) !== value) changed.add(relativePath);
        for (const [relativePath, value] of beforeIgnored) if (afterIgnored.get(relativePath) !== value) changed.add(relativePath);
      } else {
        changed.add("[IGNORED_WORKTREE]");
      }
    }
    return;
  }
  observeFullIgnoredDrift(preGit, postGit, changed);
}

/**
 * Compose the provider prompt from a TaskEnvelope without putting envelope JSON on argv.
 */
export function composeProviderPrompt(envelope, {
  root,
  constraints = null,
  contextManifest = null,
  contextPacket = null,
  runtimeRolePolicy = null
} = {}) {
  if (contextPacket !== null || runtimeRolePolicy !== null) {
    if (constraints !== null || contextPacket === null || runtimeRolePolicy === null) {
      throw new CompanionError(
        "E_STATE",
        "Receipt-backed provider prompt requires one packet/policy pair and no prompt override."
      );
    }
    return composeEffectiveProviderPrompt({
      envelope,
      contextPacket,
      rolePolicy: runtimeRolePolicy,
      contextManifest,
      root
    });
  }
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
    `Expected return format:\n${envelope.expectedReturnFormat}\nReturn the Worker Report object as the final response through the runtime's native structured-output channel. Do not prefix native JSON with GROK_WORKER_REPORT:. Only if native structured output is unavailable, use GROK_WORKER_REPORT: followed by the object. Do not put progress prose after the final object.`,
    `Context-manifest identity: ${envelope.contextManifestId || "unbound"}`,
    `Context-manifest summary: ${manifestSummary}`
  ];
  const base = lines.join("\n\n");
  const tail = constraints
    || `Grok Companion constraints: do not invoke Grok Companion recursively; do not spawn subagents or use web tools; stay within ${root}; report exactly what you changed and tested.`;
  return `${base}\n\n${tail}`;
}
