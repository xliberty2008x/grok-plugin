// v2 authenticates capturedAt. v1 remains an explicitly legacy integrity
// format whose timestamp must never be used as chronology authority.
export const CONTEXT_MANIFEST_VERSION = 2;
const LEGACY_CONTEXT_MANIFEST_VERSION = 1;

/**
 * Explicit ContextManifest metadata comparison policies.
 * Unknown policy names fail closed at assertContextCompatible.
 *
 * DEFAULT: strict primary worktrees; linked worktrees may tolerate only
 * positively classified unrelated shared-ref identity churn.
 * SUPERVISORY_LINKED_WRITE: managed write primary-control rechecks only —
 * tolerate unrelated-ref / full metadataIdentity representation drift when
 * task-relevant metadata and refs remain identical, complete, and attributable.
 */
export const CONTEXT_METADATA_POLICIES = Object.freeze({
  DEFAULT: "default",
  SUPERVISORY_LINKED_WRITE: "supervisory-linked-write"
});
const CONTEXT_METADATA_POLICY_VALUES = new Set(Object.values(CONTEXT_METADATA_POLICIES));

const SHARED_REF_IDENTITY_SCHEMA_VERSION = 1;
const SHARED_REF_OBSERVATION_SCHEMA_VERSION = 1;
const SHARED_REF_CLASS_TASK_RELEVANT = "task_relevant";
const SHARED_REF_CLASS_UNRELATED = "unrelated";
const GIT_METADATA_CLASSIFICATIONS = Object.freeze({
  UNCHANGED: "unchanged",
  TOLERATED_UNRELATED_SHARED_REFS: "tolerated_unrelated_shared_refs",
  TASK_RELEVANT_METADATA_DRIFT: "task_relevant_metadata_drift",
  LEGACY_METADATA_DRIFT: "legacy_metadata_drift",
  FAIL_CLOSED: "fail_closed"
});

export {
  CONTEXT_METADATA_POLICY_VALUES,
  GIT_METADATA_CLASSIFICATIONS,
  LEGACY_CONTEXT_MANIFEST_VERSION,
  SHARED_REF_CLASS_TASK_RELEVANT,
  SHARED_REF_CLASS_UNRELATED,
  SHARED_REF_IDENTITY_SCHEMA_VERSION,
  SHARED_REF_OBSERVATION_SCHEMA_VERSION
};
