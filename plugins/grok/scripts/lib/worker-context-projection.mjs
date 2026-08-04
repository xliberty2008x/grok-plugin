const MAX_PUBLIC_SHARED_REFS = 10_000;
const SHA256_HEX_DIGEST = /^[a-f0-9]{64}$/;
const CONTEXT_INCOMPLETE_PHASES = Object.freeze([
  "admission",
  "execute",
  "resume",
  "terminal"
]);
const TASK_RELEVANT_METADATA_COMPONENT_NAMES = Object.freeze([
  "nonRef",
  "operational",
  "hooks",
  "config",
  "indexFlags",
  "refs",
  "upstream"
]);
const CONTEXT_INCOMPLETE_METADATA_COMPONENT_SET = new Set([
  ...TASK_RELEVANT_METADATA_COMPONENT_NAMES,
  "gitMetadata",
  "contextCapture"
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function projectContextIncompleteDetails(value) {
  const contextPhase = isPlainObject(value) && CONTEXT_INCOMPLETE_PHASES.includes(value.contextPhase)
    ? value.contextPhase
    : "execute";
  const metadataComponents = isPlainObject(value) && Array.isArray(value.metadataComponents)
    ? [...new Set(value.metadataComponents)]
      .filter((component) => CONTEXT_INCOMPLETE_METADATA_COMPONENT_SET.has(component))
    : [];
  return {
    contextPhase,
    metadataComponents: metadataComponents.length ? metadataComponents : ["gitMetadata"]
  };
}

export function appendContextIncompleteMessage(message, error) {
  if (error?.code !== "E_CONTEXT_INCOMPLETE"
    || !isPlainObject(error.details)
    || !Array.isArray(error.details.metadataComponents)) {
    return message;
  }
  const components = [...new Set(error.details.metadataComponents)]
    .filter((component) => CONTEXT_INCOMPLETE_METADATA_COMPONENT_SET.has(component));
  return components.length > 0
    ? `${message} Incomplete metadata: ${components.join(", ")}.`
    : message;
}

export function projectSharedRefIdentitySummary(value) {
  if (!isPlainObject(value)
    || value.schemaVersion !== 1
    || typeof value.complete !== "boolean"
    || !Number.isSafeInteger(value.refCount)
    || value.refCount < 0
    || !Number.isSafeInteger(value.taskRelevantRefCount)
    || value.taskRelevantRefCount < 0
    || !Number.isSafeInteger(value.unrelatedRefCount)
    || value.unrelatedRefCount < 0
    || value.refCount > MAX_PUBLIC_SHARED_REFS
    || value.taskRelevantRefCount > MAX_PUBLIC_SHARED_REFS
    || value.unrelatedRefCount > MAX_PUBLIC_SHARED_REFS
    || value.taskRelevantRefCount + value.unrelatedRefCount !== value.refCount
    || (value.complete && value.refCount > MAX_PUBLIC_SHARED_REFS)
    || typeof value.taskRelevantRefIdentity !== "string"
    || !SHA256_HEX_DIGEST.test(value.taskRelevantRefIdentity)
    || typeof value.unrelatedRefIdentity !== "string"
    || !SHA256_HEX_DIGEST.test(value.unrelatedRefIdentity)) {
    return null;
  }
  return {
    schemaVersion: 1,
    complete: value.complete,
    refCount: value.refCount,
    taskRelevantRefCount: value.taskRelevantRefCount,
    unrelatedRefCount: value.unrelatedRefCount,
    taskRelevantRefIdentity: value.taskRelevantRefIdentity,
    unrelatedRefIdentity: value.unrelatedRefIdentity
  };
}

export function projectSharedRefObservation(value) {
  if (!isPlainObject(value)
    || value.schemaVersion !== 1
    || typeof value.classification !== "string"
    || typeof value.toleratedUnrelatedSharedRefChurn !== "boolean"
    || typeof value.taskRelevantMetadataDrift !== "boolean") return null;
  const classification = value.classification;
  const tolerated = value.toleratedUnrelatedSharedRefChurn;
  const drift = value.taskRelevantMetadataDrift;
  const validTuple = (
    (classification === "unchanged" && tolerated === false && drift === false)
    || (classification === "tolerated_unrelated_shared_refs" && tolerated === true && drift === false)
    || (classification === "task_relevant_metadata_drift" && tolerated === false && drift === true)
    || (classification === "legacy_metadata_drift" && tolerated === false && drift === true)
    || (classification === "fail_closed" && tolerated === false && drift === true)
  );
  if (!validTuple) return null;
  return {
    schemaVersion: 1,
    classification,
    toleratedUnrelatedSharedRefChurn: tolerated,
    taskRelevantMetadataDrift: drift
  };
}

export function projectTaskRelevantMetadataObservation(value) {
  if (!isPlainObject(value)
    || value.schemaVersion !== 1
    || typeof value.complete !== "boolean"
    || !isPlainObject(value.components)
    || Object.keys(value).sort().join("\0") !== ["complete", "components", "schemaVersion"].join("\0")
    || Object.keys(value.components).sort().join("\0")
      !== [...TASK_RELEVANT_METADATA_COMPONENT_NAMES].sort().join("\0")) return null;
  for (const name of TASK_RELEVANT_METADATA_COMPONENT_NAMES) {
    const status = value.components[name];
    if (name === "upstream") {
      if (!["not_configured", "resolved", "unresolved"].includes(status)) return null;
    } else if (!["complete", "incomplete"].includes(status)) return null;
  }
  const complete = TASK_RELEVANT_METADATA_COMPONENT_NAMES.every((name) => (
    name === "upstream"
      ? value.components[name] !== "unresolved"
      : value.components[name] === "complete"
  ));
  if (complete !== value.complete) return null;
  return { schemaVersion: 1, complete, components: { ...value.components } };
}

export function projectMetadataCompletenessObservation(value) {
  if (!isPlainObject(value)
    || value.schemaVersion !== 1
    || typeof value.complete !== "boolean"
    || !Array.isArray(value.metadataComponents)) return null;
  const metadataComponents = [...new Set(value.metadataComponents)]
    .filter((component) => CONTEXT_INCOMPLETE_METADATA_COMPONENT_SET.has(component));
  if (metadataComponents.length !== value.metadataComponents.length
    || value.complete !== (metadataComponents.length === 0)) return null;
  return { schemaVersion: 1, complete: value.complete, metadataComponents };
}
