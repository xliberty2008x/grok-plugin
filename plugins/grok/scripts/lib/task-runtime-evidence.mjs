import {
  boundPathEvidence,
  canonicalJson,
  clip
} from "./task-contract-primitives.mjs";
import {
  classifyContextGitMetadataObservation,
  inspectTaskRelevantMetadataSupport,
  isSha256Hex,
  observeContextGitMetadataDrift
} from "./task-git-identity.mjs";
import {
  inspectTaskRelevantMetadataObservation,
  observeContextMetadataCompleteness
} from "./task-context-metadata.mjs";
import {
  MAX_IGNORED_ATTRIBUTABLE,
  MAX_IGNORED_PATHS,
  isVerificationCacheIgnoredPath
} from "./task-context-worktree.mjs";

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
  if (inspectTaskRelevantMetadataObservation(context.git) === "valid") {
    identity.taskRelevantMetadataObservation = {
      schemaVersion: context.git.taskRelevantMetadataObservation.schemaVersion,
      complete: context.git.taskRelevantMetadataObservation.complete,
      components: { ...context.git.taskRelevantMetadataObservation.components }
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
  const metadataObservation = preContext?.git && postContext?.git
    ? observeContextMetadataCompleteness(preContext, postContext)
    : null;
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
    ...(sharedRefObservation && (metadataObservation?.complete !== false
      || sharedRefObservation.taskRelevantMetadataDrift) ? { sharedRefObservation } : {}),
    ...(metadataObservation ? {
      metadataCompletenessObservation: metadataObservation
    } : {})
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
