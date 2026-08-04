import {
  SHA256_HEX,
  canonicalJson,
  sha
} from "./task-contract-primitives.mjs";
import {
  CONTEXT_METADATA_POLICIES,
  GIT_METADATA_CLASSIFICATIONS,
  LEGACY_CONTEXT_MANIFEST_VERSION,
  SHARED_REF_CLASS_TASK_RELEVANT,
  SHARED_REF_CLASS_UNRELATED,
  SHARED_REF_IDENTITY_SCHEMA_VERSION,
  SHARED_REF_OBSERVATION_SCHEMA_VERSION
} from "./task-context-policy.mjs";
import {
  captureEffectiveGitConfigIdentity,
  captureEffectiveHooksIdentity,
  captureTaskRelevantNonRefEntries,
  captureWorktreeOperationalIdentity
} from "./task-git-controls.mjs";
import {
  MAX_SHARED_REFS,
  MAX_SHARED_REF_ATTRIBUTABLE,
  MAX_SHARED_REF_FIELD_BYTES,
  buildSharedRefIdentity,
  captureIndexFlagObservation,
  captureSemanticSharedRefs
} from "./task-git-refs.mjs";

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

export {
  captureTaskRelevantGitMetadata,
  classifyContextGitMetadataObservation,
  inspectTaskRelevantMetadataSupport,
  isSha256Hex,
  observeContextGitMetadataDrift
};
