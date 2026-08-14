import fs from "node:fs";
import path from "node:path";

import { CompanionError } from "./errors.mjs";
import { git } from "./workspace.mjs";
import {
  CONTEXT_MANIFEST_ID,
  SHA256_HEX,
  canonicalJson,
  sha
} from "./task-contract-primitives.mjs";
import {
  CONTEXT_MANIFEST_VERSION,
  CONTEXT_METADATA_POLICIES,
  CONTEXT_METADATA_POLICY_VALUES,
  LEGACY_CONTEXT_MANIFEST_VERSION
} from "./task-context-policy.mjs";
import {
  ignoredWorktreeSnapshot,
  parseDirtyEntries
} from "./task-context-worktree.mjs";
import { gitMetadataIdentity } from "./task-git-controls.mjs";
import {
  captureTaskRelevantGitMetadata,
  classifyContextGitMetadataObservation,
  inspectTaskRelevantMetadataSupport
} from "./task-git-identity.mjs";
import {
  contextIncompleteError,
  observeContextMetadataCompleteness
} from "./task-context-metadata.mjs";

const timestamp = () => new Date().toISOString();

function resolveAbsoluteGitPath(workspaceRoot, reported, fallback) {
  if (!reported) return fallback;
  const candidate = path.isAbsolute(reported) ? reported : path.resolve(workspaceRoot, reported);
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

/**
 * Capture a ContextManifest for the workspace. Used for job identity and drift checks.
 * Never stores task text or credentials.
 */
export function captureContextManifest(root, { verificationGeneratedPaths = [] } = {}) {
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
  const ignoredSnapshot = ignoredWorktreeSnapshot(workspaceRoot, {
    verificationGeneratedPaths
  });
  const worktreeRun = git(workspaceRoot, ["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
  const insideWorktree = worktreeRun.status === 0 && String(worktreeRun.stdout || "").trim() === "true";
  const gitDirRun = git(workspaceRoot, ["rev-parse", "--path-format=absolute", "--git-dir"], { allowFailure: true });
  const gitDir = gitDirRun.status === 0 ? String(gitDirRun.stdout || "").trim() : "";
  const commonDirRun = git(workspaceRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { allowFailure: true });
  const commonDir = commonDirRun.status === 0 ? String(commonDirRun.stdout || "").trim() : "";
  const absoluteGitDir = resolveAbsoluteGitPath(workspaceRoot, gitDir, path.join(workspaceRoot, ".git"));
  const absoluteCommonDir = resolveAbsoluteGitPath(workspaceRoot, commonDir, absoluteGitDir);
  const metadataIdentity = gitMetadataIdentity(absoluteGitDir, absoluteCommonDir);
  const isLinkedWorktree = Boolean(gitDir && commonDir && absoluteGitDir !== absoluteCommonDir);
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
      // Verification-only identity excludes pytest/Python cache path components
      // and author-declared verification-generated paths so record-verification
      // can tolerate those host-check outputs without weakening ordinary resume.
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
      taskRelevantMetadataObservation: taskMetadata.taskRelevantMetadataObservation,
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
  if (manifest.schemaVersion === CONTEXT_MANIFEST_VERSION) {
    const metadataSupport = inspectTaskRelevantMetadataSupport(manifest.git);
    if (metadataSupport === "malformed") contextManifestIntegrityError();
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
  metadataPolicy = CONTEXT_METADATA_POLICIES.DEFAULT,
  contextPhase = mode === "resume" || mode === "legacy-resume" ? "resume" : "execute"
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
  let currentCapture;
  try {
    currentCapture = captureContextManifest(root);
  } catch {
    throw contextIncompleteError(contextPhase, ["contextCapture"]);
  }
  const current = assertContextManifestIntegrity(currentCapture);
  const completeness = observeContextMetadataCompleteness(stored, current);
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
  if (!completeness.complete) {
    throw contextIncompleteError(contextPhase, completeness.metadataComponents);
  }
  // Immutable stored authority: never rebind callers to a fresh capture.
  return stored;
}
