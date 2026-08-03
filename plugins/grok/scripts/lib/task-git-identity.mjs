import {
  SHA256_HEX,
  canonicalJson,
  sha
} from "./task-contract-primitives.mjs";
import {
  CONTEXT_METADATA_POLICIES,
  GIT_METADATA_CLASSIFICATIONS,
  LEGACY_CONTEXT_MANIFEST_VERSION,
  SHARED_REF_OBSERVATION_SCHEMA_VERSION
} from "./task-context-policy.mjs";
import {
  captureEffectiveGitConfigIdentity,
  captureEffectiveHooksIdentity,
  captureTaskRelevantNonRefEntries,
  captureWorktreeOperationalIdentity
} from "./task-git-controls.mjs";
import {
  buildSharedRefIdentity,
  captureIndexFlagObservation,
  captureSemanticSharedRefs
} from "./task-git-refs.mjs";
import {
  buildTaskRelevantMetadataObservation,
  hasComparableRefIdentityDrift,
  inspectTaskRelevantMetadataSupport,
  observeContextMetadataCompleteness
} from "./task-context-metadata.mjs";

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
  const taskRelevantMetadataObservation = buildTaskRelevantMetadataObservation({
    nonRef,
    operational,
    hooks,
    config,
    indexFlags,
    semanticRefs,
    upstreamConfigured,
    upstreamFullRef,
    sharedRefIdentity
  });
  return {
    taskRelevantMetadataIdentity,
    sharedRefIdentity,
    taskRelevantMetadataObservation
  };
}

function isSha256Hex(value) {
  return typeof value === "string" && SHA256_HEX.test(value);
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
    if (hasComparableRefIdentityDrift(preContext?.git, postContext?.git, {
      includeUnrelated: metadataPolicy === CONTEXT_METADATA_POLICIES.DEFAULT
        && preContext?.git?.linkedWorktree === false
        && postContext?.git?.linkedWorktree === false
    })) {
      return {
        schemaVersion: SHARED_REF_OBSERVATION_SCHEMA_VERSION,
        classification: GIT_METADATA_CLASSIFICATIONS.TASK_RELEVANT_METADATA_DRIFT,
        toleratedUnrelatedSharedRefChurn: false,
        taskRelevantMetadataDrift: true
      };
    }
    // Incomplete-but-well-formed observations are not comparable metadata
    // drift. They are surfaced independently as E_CONTEXT_INCOMPLETE.
    if (!observeContextMetadataCompleteness(preContext, postContext).complete) {
      return {
        schemaVersion: SHARED_REF_OBSERVATION_SCHEMA_VERSION,
        classification: GIT_METADATA_CLASSIFICATIONS.UNCHANGED,
        toleratedUnrelatedSharedRefChurn: false,
        taskRelevantMetadataDrift: false
      };
    }
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
  const completeness = observeContextMetadataCompleteness(preContext, postContext);
  if (!completeness.complete) {
    changed.add("[GIT_METADATA_INCOMPLETE]");
  }
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
