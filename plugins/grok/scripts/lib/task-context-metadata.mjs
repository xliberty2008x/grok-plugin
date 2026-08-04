import { CompanionError } from "./errors.mjs";

const LEGACY_CONTEXT_MANIFEST_VERSION = 1;
const SHARED_REF_IDENTITY_SCHEMA_VERSION = 1;
const METADATA_COMPLETENESS_OBSERVATION_SCHEMA_VERSION = 1;
const MAX_SHARED_REFS = 10_000;
const MAX_SHARED_REF_ATTRIBUTABLE = 2_000;
const MAX_SHARED_REF_FIELD_BYTES = 512;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHARED_REF_CLASS_TASK_RELEVANT = "task_relevant";
const SHARED_REF_CLASS_UNRELATED = "unrelated";

export const TASK_RELEVANT_METADATA_OBSERVATION_SCHEMA_VERSION = 1;
export const TASK_RELEVANT_METADATA_COMPONENTS = Object.freeze([
  "nonRef",
  "operational",
  "hooks",
  "config",
  "indexFlags",
  "refs",
  "upstream"
]);

const CONTEXT_INCOMPLETE_COMPONENTS = new Set([
  ...TASK_RELEVANT_METADATA_COMPONENTS,
  "gitMetadata",
  "contextCapture"
]);
const CONTEXT_INCOMPLETE_PHASES = new Set([
  "admission",
  "execute",
  "resume",
  "terminal"
]);

export function buildTaskRelevantMetadataObservation({
  nonRef,
  operational,
  hooks,
  config,
  indexFlags,
  semanticRefs,
  upstreamConfigured,
  upstreamFullRef,
  sharedRefIdentity
}) {
  const complete = (value) => Boolean(value?.observable) && !value?.truncated;
  const components = {
    nonRef: complete(nonRef) ? "complete" : "incomplete",
    operational: complete(operational) ? "complete" : "incomplete",
    hooks: complete(hooks) ? "complete" : "incomplete",
    config: complete(config) ? "complete" : "incomplete",
    indexFlags: complete(indexFlags) ? "complete" : "incomplete",
    refs: semanticRefs.available && semanticRefs.complete ? "complete" : "incomplete",
    upstream: upstreamConfigured
      ? (upstreamFullRef ? "resolved" : "unresolved")
      : "not_configured"
  };
  const observation = {
    schemaVersion: TASK_RELEVANT_METADATA_OBSERVATION_SCHEMA_VERSION,
    complete: TASK_RELEVANT_METADATA_COMPONENTS.every((name) => (
      name === "upstream"
        ? components[name] !== "unresolved"
        : components[name] === "complete"
    )),
    components
  };
  if (sharedRefIdentity.complete !== observation.complete) {
    sharedRefIdentity.complete = observation.complete;
    if (!sharedRefIdentity.complete) {
      sharedRefIdentity.attributable = false;
      sharedRefIdentity.taskRelevantRefs = [];
      sharedRefIdentity.unrelatedRefs = [];
    }
  }
  return observation;
}

function isSha256Hex(value) {
  return typeof value === "string" && SHA256_HEX.test(value);
}

function hasExactKeys(value, expected) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
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
    && (entry.class === SHARED_REF_CLASS_TASK_RELEVANT
      || entry.class === SHARED_REF_CLASS_UNRELATED)
    && !entry.name.includes("\0")
    && !entry.target.includes("\0")
    && (entry.target.startsWith("refs/")
      || entry.target.toLowerCase() === entry.resolvedOid)
    && !/^(?:\/|[A-Za-z]:[\\/]|~\/)/.test(entry.target);
}

export function inspectTaskRelevantMetadataObservation(gitManifest) {
  if (!gitManifest || typeof gitManifest !== "object") return "absent";
  if (!Object.hasOwn(gitManifest, "taskRelevantMetadataObservation")) return "absent";
  const observation = gitManifest.taskRelevantMetadataObservation;
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
    return "malformed";
  }
  if (!hasExactKeys(observation, ["complete", "components", "schemaVersion"])) {
    return "malformed";
  }
  if (observation.schemaVersion !== TASK_RELEVANT_METADATA_OBSERVATION_SCHEMA_VERSION
    || typeof observation.complete !== "boolean") {
    return "malformed";
  }
  const components = observation.components;
  if (!components || typeof components !== "object" || Array.isArray(components)) {
    return "malformed";
  }
  if (!hasExactKeys(components, TASK_RELEVANT_METADATA_COMPONENTS)) return "malformed";
  for (const name of TASK_RELEVANT_METADATA_COMPONENTS) {
    const status = components[name];
    if (name === "upstream") {
      if (!["not_configured", "resolved", "unresolved"].includes(status)) return "malformed";
    } else if (!["complete", "incomplete"].includes(status)) {
      return "malformed";
    }
  }
  const computedComplete = TASK_RELEVANT_METADATA_COMPONENTS.every((name) => (
    name === "upstream"
      ? components[name] !== "unresolved"
      : components[name] === "complete"
  ));
  if (observation.complete !== computedComplete) return "malformed";
  if (gitManifest.sharedRefIdentity
    && observation.complete !== gitManifest.sharedRefIdentity.complete) {
    return "malformed";
  }
  return "valid";
}

/** Return "absent", "valid", or "malformed" for authenticated Git metadata support. */
export function inspectTaskRelevantMetadataSupport(gitManifest) {
  if (!gitManifest || typeof gitManifest !== "object") return "absent";
  const hasTaskIdentity = Object.hasOwn(gitManifest, "taskRelevantMetadataIdentity");
  const hasShared = Object.hasOwn(gitManifest, "sharedRefIdentity");
  const hasObservation = Object.hasOwn(gitManifest, "taskRelevantMetadataObservation");
  if (!hasTaskIdentity && !hasShared) return hasObservation ? "malformed" : "absent";
  if (!hasTaskIdentity || !hasShared) return "malformed";
  if (!isSha256Hex(gitManifest.taskRelevantMetadataIdentity)) return "malformed";
  const identity = gitManifest.sharedRefIdentity;
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return "malformed";
  if (identity.schemaVersion !== SHARED_REF_IDENTITY_SCHEMA_VERSION) return "malformed";
  if (typeof identity.complete !== "boolean" || typeof identity.attributable !== "boolean") {
    return "malformed";
  }
  if (!Number.isInteger(identity.refCount) || identity.refCount < 0) return "malformed";
  if (!Number.isInteger(identity.taskRelevantRefCount) || identity.taskRelevantRefCount < 0) {
    return "malformed";
  }
  if (!Number.isInteger(identity.unrelatedRefCount) || identity.unrelatedRefCount < 0) {
    return "malformed";
  }
  if (identity.taskRelevantRefCount + identity.unrelatedRefCount !== identity.refCount) {
    return "malformed";
  }
  if (!isSha256Hex(identity.taskRelevantRefIdentity)
    || !isSha256Hex(identity.unrelatedRefIdentity)) {
    return "malformed";
  }
  if (!Array.isArray(identity.taskRelevantRefs) || !Array.isArray(identity.unrelatedRefs)) {
    return "malformed";
  }
  if (identity.complete && identity.refCount > MAX_SHARED_REFS) return "malformed";
  if (identity.attributable
    !== (identity.complete && identity.refCount <= MAX_SHARED_REF_ATTRIBUTABLE)) {
    return "malformed";
  }
  if (identity.taskRelevantRefs.length
    !== (identity.attributable ? identity.taskRelevantRefCount : 0)) {
    return "malformed";
  }
  if (identity.unrelatedRefs.length
    !== (identity.attributable ? identity.unrelatedRefCount : 0)) {
    return "malformed";
  }
  const names = new Set();
  for (const entry of [...identity.taskRelevantRefs, ...identity.unrelatedRefs]) {
    if (!isPublicRefSnapshotEntry(entry) || names.has(entry.name)) return "malformed";
    names.add(entry.name);
  }
  if (identity.taskRelevantRefs.some((entry) => entry.class !== SHARED_REF_CLASS_TASK_RELEVANT)) {
    return "malformed";
  }
  if (identity.unrelatedRefs.some((entry) => entry.class !== SHARED_REF_CLASS_UNRELATED)) {
    return "malformed";
  }
  return inspectTaskRelevantMetadataObservation(gitManifest) === "malformed"
    ? "malformed"
    : "valid";
}

export function hasComparableRefIdentityDrift(
  preGit,
  postGit,
  { includeUnrelated = false } = {}
) {
  if (inspectTaskRelevantMetadataSupport(preGit) !== "valid"
    || inspectTaskRelevantMetadataSupport(postGit) !== "valid"
    || inspectTaskRelevantMetadataObservation(preGit) !== "valid"
    || inspectTaskRelevantMetadataObservation(postGit) !== "valid"
    || preGit.taskRelevantMetadataObservation.components.refs !== "complete"
    || postGit.taskRelevantMetadataObservation.components.refs !== "complete") {
    return false;
  }
  const taskRelevantDrift = preGit.sharedRefIdentity.taskRelevantRefCount
      !== postGit.sharedRefIdentity.taskRelevantRefCount
    || preGit.sharedRefIdentity.taskRelevantRefIdentity
      !== postGit.sharedRefIdentity.taskRelevantRefIdentity;
  const unrelatedComparable = includeUnrelated
    && preGit.taskRelevantMetadataObservation.components.upstream !== "unresolved"
    && postGit.taskRelevantMetadataObservation.components.upstream !== "unresolved";
  return taskRelevantDrift || (unrelatedComparable && (
    preGit.sharedRefIdentity.unrelatedRefCount
      !== postGit.sharedRefIdentity.unrelatedRefCount
    || preGit.sharedRefIdentity.unrelatedRefIdentity
      !== postGit.sharedRefIdentity.unrelatedRefIdentity
  ));
}

function metadataIncompleteComponents(manifest) {
  if (manifest?.schemaVersion === LEGACY_CONTEXT_MANIFEST_VERSION) return [];
  const gitManifest = manifest?.git;
  const observationSupport = inspectTaskRelevantMetadataObservation(gitManifest);
  if (observationSupport === "valid") {
    const observation = gitManifest.taskRelevantMetadataObservation;
    if (observation.complete) return [];
    return TASK_RELEVANT_METADATA_COMPONENTS.filter((name) => (
      name === "upstream"
        ? observation.components[name] === "unresolved"
        : observation.components[name] === "incomplete"
    ));
  }
  if (observationSupport === "absent"
    && inspectTaskRelevantMetadataSupport(gitManifest) === "valid") {
    return gitManifest.sharedRefIdentity.complete ? [] : ["gitMetadata"];
  }
  return [];
}

export function observeContextMetadataCompleteness(...manifests) {
  const metadataComponents = [...new Set(
    manifests.flatMap((manifest) => metadataIncompleteComponents(manifest))
  )].filter((component) => CONTEXT_INCOMPLETE_COMPONENTS.has(component));
  return {
    schemaVersion: METADATA_COMPLETENESS_OBSERVATION_SCHEMA_VERSION,
    complete: metadataComponents.length === 0,
    metadataComponents
  };
}

export function contextIncompleteError(contextPhase, metadataComponents) {
  const phase = CONTEXT_INCOMPLETE_PHASES.has(contextPhase) ? contextPhase : "execute";
  const components = [...new Set(Array.isArray(metadataComponents)
    ? metadataComponents
    : [])].filter((component) => CONTEXT_INCOMPLETE_COMPONENTS.has(component));
  return new CompanionError(
    "E_CONTEXT_INCOMPLETE",
    "Git execution context could not be observed completely; refusing to continue.",
    {
      contextPhase: phase,
      metadataComponents: components.length ? components : ["gitMetadata"]
    }
  );
}

/**
 * Bind completeness checks to the task-contract capture and integrity authority
 * without widening that module's exact public compatibility facade.
 */
export function bindContextMetadataCompleteness({
  captureContextManifest,
  assertContextManifestIntegrity
}) {
  if (typeof captureContextManifest !== "function"
    || typeof assertContextManifestIntegrity !== "function") {
    throw new TypeError("Context metadata completeness requires capture and integrity authorities.");
  }
  function assertContextMetadataComplete(manifest, { contextPhase = "execute" } = {}) {
    const stored = assertContextManifestIntegrity(manifest);
    const incomplete = metadataIncompleteComponents(stored);
    if (incomplete.length) throw contextIncompleteError(contextPhase, incomplete);
    return stored;
  }
  function captureCompleteContextManifest(root, { contextPhase = "admission" } = {}) {
    let captured;
    try {
      captured = captureContextManifest(root);
    } catch {
      throw contextIncompleteError(contextPhase, ["contextCapture"]);
    }
    return assertContextMetadataComplete(captured, { contextPhase });
  }
  return Object.freeze({
    assertContextMetadataComplete,
    captureCompleteContextManifest
  });
}
