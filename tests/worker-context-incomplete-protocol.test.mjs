import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  PUBLIC_WORKER_ERROR_CODES,
  WORKER_CONTEXT_INCOMPLETE_ERROR_SCHEMA_VERSION,
  WORKER_ERROR_SCHEMA_VERSION,
  WORKER_PROTOCOL_VERSION,
  projectWorkerError,
  projectWorkerSnapshot
} from "../plugins/grok/scripts/lib/worker-protocol.mjs";

const PROTOCOL_SCHEMA = JSON.parse(fs.readFileSync(
  new URL("../plugins/grok/schemas/worker-protocol.schema.json", import.meta.url),
  "utf8"
));

function schemaTypeMatches(type, value) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isSafeInteger(value);
  return typeof value === type;
}

function schemaErrors(schema, value, path = "$") {
  if (!schema || Object.keys(schema).length === 0) return [];
  if (schema.$ref) {
    const name = schema.$ref.replace("#/$defs/", "");
    return schemaErrors(PROTOCOL_SCHEMA.$defs[name], value, path);
  }
  if (schema.anyOf) {
    return schema.anyOf.some((candidate) => schemaErrors(candidate, value, path).length === 0)
      ? []
      : [`${path} did not match anyOf`];
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => schemaErrors(candidate, value, path).length === 0).length;
    return matches === 1 ? [] : [`${path} matched ${matches} oneOf branches`];
  }
  if (schema.if !== undefined) {
    const applies = schemaErrors(schema.if, value, path).length === 0;
    return applies
      ? (schema.then ? schemaErrors(schema.then, value, path) : [])
      : (schema.else ? schemaErrors(schema.else, value, path) : []);
  }
  if (schema.not !== undefined && schemaErrors(schema.not, value, path).length === 0) {
    return [`${path} matched forbidden schema`];
  }
  if (schema.const !== undefined && value !== schema.const) return [`${path} must equal ${schema.const}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${path} is not in enum`];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some((type) => schemaTypeMatches(type, value))) {
    return [`${path} has invalid type ${typeof value}`];
  }
  if (value === null) return [];
  const errors = [];
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path} is too short`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path} does not match pattern`);
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path} is below minimum`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path} is above maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path} has too few items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path} has too many items`);
    if (schema.uniqueItems === true
      && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      errors.push(`${path} has duplicate items`);
    }
    if (schema.items) {
      value.forEach((item, index) => errors.push(...schemaErrors(schema.items, item, `${path}[${index}]`)));
    }
  } else if (value && typeof value === "object") {
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties || {}, key)) errors.push(`${path}.${key} is not allowed`);
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) errors.push(...schemaErrors(childSchema, value[key], `${path}.${key}`));
    }
  }
  if (schema.allOf) {
    for (const candidate of schema.allOf) errors.push(...schemaErrors(candidate, value, path));
  }
  return errors;
}

function assertConforms(definition, value) {
  const errors = schemaErrors(PROTOCOL_SCHEMA.$defs[definition], JSON.parse(JSON.stringify(value)));
  assert.deepEqual(errors, [], `${definition} schema errors:\n${errors.join("\n")}`);
}

function job(overrides = {}) {
  return {
    schemaVersion: 3,
    id: "task-1111111111111111",
    kind: "task",
    jobClass: "task",
    write: false,
    status: "running",
    phase: "executing",
    summary: "Running",
    progress: "Reading files",
    createdAt: "2026-07-15T00:00:00.000Z",
    startedAt: "2026-07-15T00:00:01.000Z",
    updatedAt: "2026-07-15T00:00:02.000Z",
    completedAt: null,
    heartbeatAt: "2026-07-15T00:00:02.000Z",
    profile: { id: "rescue-read-v3", contractVersion: 3, agentProfileDigest: "a".repeat(64) },
    model: "grok-test",
    effort: "high",
    latestPlan: [],
    lifecycleEvents: [],
    request: null,
    result: null,
    error: null,
    ...overrides
  };
}

test("context-incomplete errors preserve foreground compatibility and use strict v2 snapshots", () => {
  const identifierOnly = projectWorkerError({
    code: "E_CONTEXT_INCOMPLETE",
    message: "Cleanup still owns providerPid=410028."
  });
  assert.deepEqual(identifierOnly, {
    code: "E_CONTEXT_INCOMPLETE",
    message: "Cleanup still owns providerPid=[REDACTED]."
  });
  assert.equal(PUBLIC_WORKER_ERROR_CODES.includes("E_CONTEXT_INCOMPLETE"), true);
  assert.deepEqual(projectWorkerError({
    code: "E_CONTEXT_INCOMPLETE",
    message: "Git metadata could not be observed."
  }), {
    code: "E_CONTEXT_INCOMPLETE",
    message: "Git metadata could not be observed."
  });
  const typed = projectWorkerError({
    code: "E_CONTEXT_INCOMPLETE",
    message: "Context capture failed at /Users/alice/private for providerPid=410029.",
    details: {
      contextPhase: "resume",
      metadataComponents: ["hooks", "refs", "hooks", "privateComponent"],
      privatePath: "/Users/alice/private",
      providerPid: 410029
    }
  });
  assert.deepEqual(Object.keys(typed).sort(), ["code", "message"]);
  assert.match(typed.message, /Incomplete metadata: hooks, refs\./);
  for (const privateValue of ["/Users/alice", "410029", "privateComponent", "contextPhase", "privatePath"]) {
    assert.equal(JSON.stringify(typed).includes(privateValue), false);
  }
  const incompleteSnapshot = projectWorkerSnapshot(job({
    status: "failed",
    phase: "context-rejected",
    error: {
      code: "E_CONTEXT_INCOMPLETE",
      message: "Context capture failed at /Users/alice/private.",
      details: {
        contextPhase: "terminal",
        metadataComponents: ["refs", "refs", "contextCapture"],
        privatePath: "/Users/alice/private",
        providerPid: 410029
      }
    }
  }));
  assert.deepEqual(incompleteSnapshot.error, {
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    errorSchemaVersion: WORKER_CONTEXT_INCOMPLETE_ERROR_SCHEMA_VERSION,
    code: "E_CONTEXT_INCOMPLETE",
    message: "Context capture failed at [PRIVATE_PATH]",
    details: { contextPhase: "terminal", metadataComponents: ["refs", "contextCapture"] }
  });
  assertConforms("WorkerError", incompleteSnapshot.error);
  assert.ok(schemaErrors(PROTOCOL_SCHEMA.$defs.WorkerError, {
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    errorSchemaVersion: WORKER_ERROR_SCHEMA_VERSION,
    code: "E_CONTEXT_INCOMPLETE",
    message: "Legacy v1 must not carry context incompleteness."
  }).length > 0);
  assert.ok(schemaErrors(PROTOCOL_SCHEMA.$defs.WorkerError, {
    ...incompleteSnapshot.error,
    details: { contextPhase: "terminal", metadataComponents: ["refs", "refs"] }
  }).length > 0);
  const hostile = projectWorkerSnapshot(job({
    status: "failed",
    phase: "context-rejected",
    error: {
      code: "E_CONTEXT_INCOMPLETE",
      message: "Context observation incomplete.",
      details: "/Users/alice/private/providerPid=410030"
    }
  }));
  assert.deepEqual(hostile.error.details, {
    contextPhase: "execute",
    metadataComponents: ["gitMetadata"]
  });
  assertConforms("WorkerError", hostile.error);
  assert.equal(JSON.stringify(hostile).includes("/Users/alice"), false);
  assert.equal(JSON.stringify(hostile).includes("410030"), false);
});

test("metadata completeness schemas and context projection enforce consistent authority", () => {
  const completeComponents = {
    nonRef: "complete", operational: "complete", hooks: "complete", config: "complete",
    indexFlags: "complete", refs: "complete", upstream: "resolved"
  };
  const completeObservation = { schemaVersion: 1, complete: true, components: completeComponents };
  const incompleteObservation = {
    schemaVersion: 1,
    complete: false,
    components: { ...completeComponents, hooks: "incomplete" }
  };
  assert.deepEqual(schemaErrors(PROTOCOL_SCHEMA.$defs.taskRelevantMetadataObservation, completeObservation), []);
  assert.deepEqual(schemaErrors(PROTOCOL_SCHEMA.$defs.taskRelevantMetadataObservation, incompleteObservation), []);
  for (const contradictory of [
    { ...completeObservation, complete: false },
    { ...incompleteObservation, complete: true }
  ]) {
    assert.ok(schemaErrors(PROTOCOL_SCHEMA.$defs.taskRelevantMetadataObservation, contradictory).length > 0);
  }
  for (const valid of [
    { schemaVersion: 1, complete: true, metadataComponents: [] },
    { schemaVersion: 1, complete: false, metadataComponents: ["hooks"] }
  ]) {
    assert.deepEqual(schemaErrors(PROTOCOL_SCHEMA.$defs.metadataCompletenessObservation, valid), []);
  }
  for (const invalid of [
    { schemaVersion: 1, complete: true, metadataComponents: ["hooks"] },
    { schemaVersion: 1, complete: false, metadataComponents: [] },
    { schemaVersion: 1, complete: false, metadataComponents: ["hooks", "hooks"] }
  ]) {
    assert.ok(schemaErrors(PROTOCOL_SCHEMA.$defs.metadataCompletenessObservation, invalid).length > 0);
  }
  const sharedRefIdentity = {
    schemaVersion: 1,
    complete: true,
    refCount: 2,
    taskRelevantRefCount: 1,
    unrelatedRefCount: 1,
    taskRelevantRefIdentity: "a".repeat(64),
    unrelatedRefIdentity: "b".repeat(64)
  };
  const contextIdentity = {
    manifestId: "ctx-before",
    digest: "c".repeat(64),
    head: "d".repeat(40),
    branch: "task-branch",
    dirtyDigest: "e".repeat(64),
    ignoredDigest: "f".repeat(64),
    trackedTreeIdentity: "1".repeat(64),
    metadataIdentity: "2".repeat(64),
    sharedRefIdentity,
    taskRelevantMetadataObservation: incompleteObservation
  };
  assert.ok(schemaErrors(PROTOCOL_SCHEMA.$defs.contextIdentity, contextIdentity).length > 0);
  const snapshot = projectWorkerSnapshot(job({
    status: "completed",
    phase: "done",
    result: {
      hostVerification: "not_run",
      runtimeEvidence: {
        schemaVersion: 1,
        preContext: contextIdentity,
        postContext: null,
        observedChangedPaths: [],
        diffSummary: null,
        commandOutcomes: [],
        scopeViolations: [],
        executionStatus: "completed",
        hostVerification: "not_run"
      }
    }
  }));
  const projected = snapshot.result.runtimeEvidence.preContext;
  assert.equal(Object.hasOwn(projected, "sharedRefIdentity"), false);
  assert.equal(Object.hasOwn(projected, "taskRelevantMetadataObservation"), false);
  assertConforms("contextIdentity", projected);
});

test("published WorkerError schema exposes exact v1 and context-incomplete v2 branches", () => {
  assert.deepEqual(PROTOCOL_SCHEMA.$defs.WorkerError.oneOf, [
    { $ref: "#/$defs/WorkerErrorV1" },
    { $ref: "#/$defs/WorkerContextIncompleteErrorV2" }
  ]);
  for (const name of ["WorkerErrorV1", "WorkerContextIncompleteErrorV2"]) {
    assert.ok(PROTOCOL_SCHEMA.$defs[name].required.includes("workerProtocolVersion"));
    assert.ok(PROTOCOL_SCHEMA.$defs[name].required.includes("errorSchemaVersion"));
  }
});
