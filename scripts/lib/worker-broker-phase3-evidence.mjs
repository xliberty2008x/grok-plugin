/**
 * Bounded Phase-3 live-evidence receipt producer.
 *
 * The installed Worker MCP runner emits one JSON document for the completion /
 * cancellation lifecycle and one for the two-writer lifecycle. This module
 * accepts only those exact public projections, binds their complete canonical
 * bodies, and emits one immutable supporting receipt. The receipt is not a
 * phase qualification record and cannot set any qualification boundary.
 */
import fs from "node:fs";
import path from "node:path";

import {
  EVIDENCE_ROOT,
  computeInventoryDigest,
  computePhaseScopeDigest,
  gitIdentity,
  isNonEvidenceTreeClean,
  publishImmutableEvidenceArtifact,
  sha256Text
} from "./worker-broker-evidence.mjs";
import {
  createPluginInventory,
  digestInventory
} from "./plugin-inventory.mjs";

export const PHASE_THREE_LIVE_RECEIPT_SCHEMA_VERSION = 1;
export const PHASE_THREE_LIVE_RECEIPT_PRODUCER_ID =
  "worker-broker-phase-3-live-receipt";
export const PHASE_THREE_LIVE_RECEIPT_PRODUCER_VERSION = 1;
export const PHASE_THREE_LIVE_RECEIPT_ROOT =
  `${EVIDENCE_ROOT}/live-receipts/phase-3/v1`;
export const PHASE_THREE_LIVE_GATE_IDS = Object.freeze([
  "completion-integration-cleanup",
  "completion-restart-replay",
  "active-cancellation-restart-absence",
  "distinct-root-writer-overlap",
  "typed-conflict-abandon",
  "two-writer-restart-replay-absence"
]);
export const PHASE_THREE_LIVE_RECEIPT_MANIFEST = Object.freeze({
  schemaVersion: PHASE_THREE_LIVE_RECEIPT_SCHEMA_VERSION,
  producerId: PHASE_THREE_LIVE_RECEIPT_PRODUCER_ID,
  producerVersion: PHASE_THREE_LIVE_RECEIPT_PRODUCER_VERSION,
  phase: "3",
  evidenceClass: "supporting-live-unqualified",
  providerBoundary: "pinned-official-grok-build-acp",
  inputScenarios: Object.freeze([
    "official-grok-build-target-txt-write-smoke",
    "official-grok-build-two-writer-conflict"
  ]),
  gateIds: PHASE_THREE_LIVE_GATE_IDS
});

const SHA256 = /^[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const PIN_REF = /^gpin-[a-f0-9]{32}$/;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_RECEIPT_BYTES = 256 * 1024;

const COMMON_BINDING_FIELDS = Object.freeze([
  "sourceHeadCommit",
  "sourceHeadTree",
  "sourceInventoryDigest",
  "sourcePluginInventoryDigest",
  "installedPluginInventoryDigest",
  "installedEntrypointDigest",
  "providerVersion",
  "providerBinaryDigest",
  "providerCapabilityDigest",
  "providerPinRef",
  "providerLaunchBindingDigest",
  "providerExecutableIdentityDigest",
  "providerReleaseIdentityDigest",
  "ambientProviderDiscoveryPoisoned",
  "writeLifecycleCapabilityDigest"
]);

const COMPLETION_FIELDS = new Set([
  "schemaVersion",
  "scenario",
  "workerId",
  "status",
  "providerGeneration",
  "reportSource",
  "reportDigest",
  "nativeStructuredOutput",
  "targetPath",
  "baseCommit",
  "manifestDigest",
  "patchDigest",
  "contentDigest",
  "parentFingerprintDigest",
  "parentUnchangedBeforeIntegration",
  "integrationApplied",
  "runnerDisposableWorktreeRemoved",
  "runnerWorktreeRegistrationAbsent",
  "productionIntegrationQualified",
  "productionCleanupQualified",
  "hostVerification",
  "integrationReceiptDigest",
  "hostVerificationDigest",
  "cleanupReceiptDigest",
  "absenceProofDigest",
  "spawnReplayProven",
  "artifactReplayProven",
  "artifactReplayAfterCleanupProven",
  "spawnReplayNoDispatch",
  "providerGenerationDelta",
  "primaryTurnAdmissionDelta",
  "worktreeIdentityChanged",
  "integrationReplayProven",
  "cleanupReplayProven",
  "providerSessionAbsent",
  "activeWriteCancellationProven",
  "writeCancellation",
  ...COMMON_BINDING_FIELDS
]);
const CANCELLATION_FIELDS = new Set([
  "workerId",
  "status",
  "activeProviderObserved",
  "spawnReplayProven",
  "spawnReplayNoDispatch",
  "providerGenerationDelta",
  "providerProcessIdentityChanged",
  "worktreeIdentityChanged",
  "runtimeIdentityChanged",
  "cancelReplayProven",
  "taskRuntimeCleaned",
  "parentUnchanged",
  "artifactAbsent",
  "cleanupDisposition",
  "cleanupReceiptDigest",
  "terminalEvidenceDigest",
  "absenceProofDigest",
  "cleanupReplayProven",
  "providerSessionAbsent",
  "worktreeAbsent"
]);
const TWO_WRITER_FIELDS = new Set([
  "schemaVersion",
  "scenario",
  "workers",
  "providerOverlap",
  "parent",
  "replay",
  "absence",
  ...COMMON_BINDING_FIELDS
]);
const TWO_WRITER_A_FIELDS = new Set([
  "id",
  "executionBindingDigest",
  "executionRootDigest",
  "providerProcessDigest",
  "manifestDigest",
  "patchDigest",
  "contentDigest",
  "readyObservationDigest",
  "integrationReceiptDigest",
  "verificationObservationDigest",
  "cleanupReceiptDigest"
]);
const TWO_WRITER_B_FIELDS = new Set([
  "id",
  "executionBindingDigest",
  "executionRootDigest",
  "providerProcessDigest",
  "manifestDigest",
  "patchDigest",
  "contentDigest",
  "readyObservationDigest",
  "conflictObservationDigest",
  "conflictClassification",
  "rejectedIntegrationCode",
  "rejectedIntegrationMessageDigest",
  "abandonReceiptDigest"
]);
const TWO_WRITER_PARENT_FIELDS = new Set([
  "baseCommit",
  "beforeFingerprintDigest",
  "unchangedBeforeIntegration",
  "indexUnchangedBeforeIntegration",
  "integratedContentDigest",
  "rejectedIntegrationNoEffect",
  "abandonNoEffect"
]);
const TWO_WRITER_REPLAY_FIELDS = new Set([
  "retainedArtifactBAfterReconnect",
  "verificationA",
  "integrationA",
  "cleanupA",
  "abandonB",
  "immutableArtifactsAfterCleanup"
]);
const TWO_WRITER_ABSENCE_FIELDS = new Set([
  "sessions",
  "worktrees",
  "guards",
  "processes"
]);
const TWO_WRITER_OVERLAP_FIELDS = new Set([
  "proven",
  "observedAt",
  "observationDigest",
  "rootsDistinct"
]);

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`
  ).join(",")}}`;
}

function exactFields(value, fields) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === fields.size
    && Object.keys(value).every((key) => fields.has(key))
  );
}

function allTrue(value, fields) {
  return exactFields(value, fields)
    && [...fields].every((field) => value[field] === true);
}

function serializedWithin(value, limit) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= limit;
  } catch {
    return false;
  }
}

function safeRuntimeId(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}

function allDigests(value, fields) {
  return fields.every((field) => SHA256.test(value?.[field] || ""));
}

function validCommonBindings(evidence) {
  return SHA40.test(evidence.sourceHeadCommit || "")
    && SHA40.test(evidence.sourceHeadTree || "")
    && allDigests(evidence, [
      "sourceInventoryDigest",
      "sourcePluginInventoryDigest",
      "installedPluginInventoryDigest",
      "installedEntrypointDigest",
      "providerBinaryDigest",
      "providerCapabilityDigest",
      "providerLaunchBindingDigest",
      "providerExecutableIdentityDigest",
      "providerReleaseIdentityDigest",
      "writeLifecycleCapabilityDigest"
    ])
    && evidence.sourcePluginInventoryDigest
      === evidence.installedPluginInventoryDigest
    && safeRuntimeId(evidence.providerVersion)
    && PIN_REF.test(evidence.providerPinRef || "")
    && evidence.ambientProviderDiscoveryPoisoned === true;
}

function matchingCommonBindings(left, right) {
  return COMMON_BINDING_FIELDS.every((field) => (
    left?.[field] === right?.[field]
  ));
}

function validCancellation(value) {
  return exactFields(value, CANCELLATION_FIELDS)
    && safeRuntimeId(value.workerId)
    && value.status === "cancelled"
    && value.activeProviderObserved === true
    && value.spawnReplayProven === true
    && value.spawnReplayNoDispatch === true
    && value.providerGenerationDelta === 0
    && value.providerProcessIdentityChanged === false
    && value.worktreeIdentityChanged === false
    && value.runtimeIdentityChanged === false
    && value.cancelReplayProven === true
    && value.taskRuntimeCleaned === true
    && value.parentUnchanged === true
    && value.artifactAbsent === true
    && value.cleanupDisposition === "discarded"
    && allDigests(value, [
      "cleanupReceiptDigest",
      "terminalEvidenceDigest",
      "absenceProofDigest"
    ])
    && value.cleanupReplayProven === true
    && value.providerSessionAbsent === true
    && value.worktreeAbsent === true;
}

export function validatePhaseThreeCompletionEvidence(evidence) {
  const errors = [];
  if (!serializedWithin(evidence, MAX_INPUT_BYTES)) {
    return { ok: false, errors: ["Completion evidence is malformed or oversized."] };
  }
  if (!exactFields(evidence, COMPLETION_FIELDS)) {
    errors.push("Completion evidence fields do not match the fixed runner projection.");
  }
  if (evidence?.schemaVersion !== 1
    || evidence?.scenario !== "official-grok-build-target-txt-write-smoke") {
    errors.push("Completion evidence scenario identity is invalid.");
  }
  if (!safeRuntimeId(evidence?.workerId)
    || evidence?.status !== "completed"
    || !Number.isSafeInteger(evidence?.providerGeneration)
    || evidence.providerGeneration < 1
    || evidence?.reportSource !== "acp-structured"
    || evidence?.nativeStructuredOutput !== true
    || evidence?.targetPath !== "target.txt"
    || !SHA40.test(evidence?.baseCommit || "")) {
    errors.push("Completion evidence does not prove the fixed target/provider outcome.");
  }
  if (!allDigests(evidence, [
    "reportDigest",
    "manifestDigest",
    "patchDigest",
    "contentDigest",
    "parentFingerprintDigest",
    "integrationReceiptDigest",
    "hostVerificationDigest",
    "cleanupReceiptDigest",
    "absenceProofDigest"
  ])) {
    errors.push("Completion evidence is missing content-addressed lifecycle receipts.");
  }
  for (const field of [
    "parentUnchangedBeforeIntegration",
    "integrationApplied",
    "runnerDisposableWorktreeRemoved",
    "runnerWorktreeRegistrationAbsent",
    "productionIntegrationQualified",
    "productionCleanupQualified",
    "spawnReplayProven",
    "artifactReplayProven",
    "artifactReplayAfterCleanupProven",
    "spawnReplayNoDispatch",
    "integrationReplayProven",
    "cleanupReplayProven",
    "providerSessionAbsent",
    "activeWriteCancellationProven"
  ]) {
    if (evidence?.[field] !== true) {
      errors.push(`Completion evidence ${field} must be true.`);
    }
  }
  if (evidence?.hostVerification !== "passed"
    || evidence?.providerGenerationDelta !== 0
    || evidence?.primaryTurnAdmissionDelta !== 0
    || evidence?.worktreeIdentityChanged !== false) {
    errors.push("Completion evidence replay or host-verification binding is invalid.");
  }
  if (!validCancellation(evidence?.writeCancellation)) {
    errors.push("Completion evidence cancellation lifecycle is invalid.");
  }
  if (!validCommonBindings(evidence || {})) {
    errors.push("Completion evidence source/install/provider binding is invalid.");
  }
  return { ok: errors.length === 0, errors };
}

function validTwoWriterWorker(value, fields) {
  if (!exactFields(value, fields)
    || !safeRuntimeId(value.id)
    || !allDigests(value, [...fields].filter((field) => field.endsWith("Digest")))) {
    return false;
  }
  return true;
}

export function validatePhaseThreeTwoWriterEvidence(evidence) {
  const errors = [];
  if (!serializedWithin(evidence, MAX_INPUT_BYTES)) {
    return { ok: false, errors: ["Two-writer evidence is malformed or oversized."] };
  }
  if (!exactFields(evidence, TWO_WRITER_FIELDS)) {
    errors.push("Two-writer evidence fields do not match the fixed runner projection.");
  }
  if (evidence?.schemaVersion !== 1
    || evidence?.scenario !== "official-grok-build-two-writer-conflict") {
    errors.push("Two-writer evidence scenario identity is invalid.");
  }
  const workerA = evidence?.workers?.a;
  const workerB = evidence?.workers?.b;
  if (!exactFields(evidence?.workers, new Set(["a", "b"]))
    || !validTwoWriterWorker(workerA, TWO_WRITER_A_FIELDS)
    || !validTwoWriterWorker(workerB, TWO_WRITER_B_FIELDS)
    || workerA?.id === workerB?.id
    || workerA?.executionBindingDigest === workerB?.executionBindingDigest
    || workerA?.executionRootDigest === workerB?.executionRootDigest
    || workerA?.providerProcessDigest === workerB?.providerProcessDigest
    || workerA?.manifestDigest === workerB?.manifestDigest
    || workerA?.contentDigest === workerB?.contentDigest) {
    errors.push("Two-writer evidence does not prove distinct writer identities and roots.");
  }
  if (!exactFields(evidence?.providerOverlap, TWO_WRITER_OVERLAP_FIELDS)
    || evidence?.providerOverlap?.proven !== true
    || evidence?.providerOverlap?.rootsDistinct !== true
    || !Number.isSafeInteger(evidence?.providerOverlap?.observedAt)
    || evidence.providerOverlap.observedAt <= 0
    || !SHA256.test(evidence?.providerOverlap?.observationDigest || "")) {
    errors.push("Two-writer evidence does not prove simultaneous provider overlap.");
  }
  if (!exactFields(evidence?.parent, TWO_WRITER_PARENT_FIELDS)
    || !SHA40.test(evidence?.parent?.baseCommit || "")
    || !allDigests(evidence?.parent, [
      "beforeFingerprintDigest",
      "integratedContentDigest"
    ])
    || evidence?.parent?.integratedContentDigest !== workerA?.contentDigest
    || evidence?.parent?.unchangedBeforeIntegration !== true
    || evidence?.parent?.indexUnchangedBeforeIntegration !== true
    || evidence?.parent?.rejectedIntegrationNoEffect !== true
    || evidence?.parent?.abandonNoEffect !== true) {
    errors.push("Two-writer parent isolation or rejected-effect evidence is invalid.");
  }
  if (workerB?.conflictClassification !== "parent-drift"
    || workerB?.rejectedIntegrationCode !== "E_INTEGRATION") {
    errors.push("Two-writer evidence lacks the typed parent-drift conflict.");
  }
  if (!allTrue(evidence?.replay, TWO_WRITER_REPLAY_FIELDS)) {
    errors.push("Two-writer restart/replay evidence is incomplete.");
  }
  if (!allTrue(evidence?.absence, TWO_WRITER_ABSENCE_FIELDS)) {
    errors.push("Two-writer terminal absence evidence is incomplete.");
  }
  if (!validCommonBindings(evidence || {})) {
    errors.push("Two-writer source/install/provider binding is invalid.");
  }
  return { ok: errors.length === 0, errors };
}

export function computePhaseThreeLiveManifestDigest() {
  return sha256Text(stableStringify(PHASE_THREE_LIVE_RECEIPT_MANIFEST));
}

export function computePhaseThreeLiveInputDigest(input) {
  if (!serializedWithin(input, MAX_INPUT_BYTES)) {
    throw new Error("Phase-3 live input is malformed or oversized.");
  }
  return sha256Text(stableStringify(input));
}

export function computePhaseThreeLiveReceiptDigest(receipt) {
  const body = structuredClone(receipt);
  delete body.receiptDigest;
  return sha256Text(stableStringify(body));
}

function projectReceipt(completion, twoWriter, recordedAt, root) {
  const workerA = twoWriter.workers.a;
  const workerB = twoWriter.workers.b;
  const cancellation = completion.writeCancellation;
  const receipt = {
    schemaVersion: PHASE_THREE_LIVE_RECEIPT_SCHEMA_VERSION,
    producerId: PHASE_THREE_LIVE_RECEIPT_PRODUCER_ID,
    producerVersion: PHASE_THREE_LIVE_RECEIPT_PRODUCER_VERSION,
    manifestDigest: computePhaseThreeLiveManifestDigest(),
    phase: "3",
    evidenceClass: "supporting-live-unqualified",
    recordedAt,
    source: {
      headCommit: completion.sourceHeadCommit,
      headTree: completion.sourceHeadTree,
      sourceInventoryDigest: completion.sourceInventoryDigest,
      phaseScopeDigest: computePhaseScopeDigest("3", root),
      sourcePluginInventoryDigest: completion.sourcePluginInventoryDigest,
      installedPluginInventoryDigest: completion.installedPluginInventoryDigest,
      installedEntrypointDigest: completion.installedEntrypointDigest
    },
    provider: {
      implementation: "official-grok-build-acp",
      version: completion.providerVersion,
      binaryDigest: completion.providerBinaryDigest,
      capabilityDigest: completion.providerCapabilityDigest,
      pinRef: completion.providerPinRef,
      launchBindingDigest: completion.providerLaunchBindingDigest,
      executableIdentityDigest: completion.providerExecutableIdentityDigest,
      releaseIdentityDigest: completion.providerReleaseIdentityDigest,
      ambientDiscoveryPoisoned: true
    },
    writeLifecycleCapabilityDigest: completion.writeLifecycleCapabilityDigest,
    inputs: {
      completion: {
        digest: computePhaseThreeLiveInputDigest(completion),
        projection: structuredClone(completion)
      },
      twoWriter: {
        digest: computePhaseThreeLiveInputDigest(twoWriter),
        projection: structuredClone(twoWriter)
      }
    },
    completion: {
      workerId: completion.workerId,
      providerGeneration: completion.providerGeneration,
      reportSource: completion.reportSource,
      reportDigest: completion.reportDigest,
      manifestDigest: completion.manifestDigest,
      patchDigest: completion.patchDigest,
      contentDigest: completion.contentDigest,
      integrationReceiptDigest: completion.integrationReceiptDigest,
      hostVerificationDigest: completion.hostVerificationDigest,
      cleanupReceiptDigest: completion.cleanupReceiptDigest,
      absenceProofDigest: completion.absenceProofDigest
    },
    cancellation: {
      workerId: cancellation.workerId,
      cleanupReceiptDigest: cancellation.cleanupReceiptDigest,
      terminalEvidenceDigest: cancellation.terminalEvidenceDigest,
      absenceProofDigest: cancellation.absenceProofDigest
    },
    concurrency: {
      workerAId: workerA.id,
      workerBId: workerB.id,
      executionBindingDigests: [
        workerA.executionBindingDigest,
        workerB.executionBindingDigest
      ],
      executionRootDigests: [
        workerA.executionRootDigest,
        workerB.executionRootDigest
      ],
      providerProcessDigests: [
        workerA.providerProcessDigest,
        workerB.providerProcessDigest
      ],
      overlapObservationDigest: twoWriter.providerOverlap.observationDigest,
      observedAt: twoWriter.providerOverlap.observedAt
    },
    conflict: {
      classification: workerB.conflictClassification,
      errorCode: workerB.rejectedIntegrationCode,
      errorMessageDigest: workerB.rejectedIntegrationMessageDigest,
      observationDigest: workerB.conflictObservationDigest,
      abandonReceiptDigest: workerB.abandonReceiptDigest
    },
    gates: [...PHASE_THREE_LIVE_GATE_IDS],
    outcome: "pass"
  };
  receipt.receiptDigest = computePhaseThreeLiveReceiptDigest(receipt);
  return receipt;
}

export function buildPhaseThreeLiveReceipt({
  completionEvidence,
  twoWriterEvidence,
  recordedAt = new Date().toISOString(),
  root,
  strict = false
} = {}) {
  const completion = validatePhaseThreeCompletionEvidence(completionEvidence);
  const twoWriter = validatePhaseThreeTwoWriterEvidence(twoWriterEvidence);
  if (!completion.ok || !twoWriter.ok
    || !matchingCommonBindings(completionEvidence, twoWriterEvidence)
    || typeof root !== "string"
    || !root
    || typeof strict !== "boolean"
    || typeof recordedAt !== "string"
    || new Date(recordedAt).toISOString() !== recordedAt) {
    const error = new Error("Phase-3 live evidence is invalid.");
    error.code = "E_PHASE3_LIVE_EVIDENCE_INVALID";
    throw error;
  }
  const receipt = projectReceipt(
    completionEvidence,
    twoWriterEvidence,
    recordedAt,
    root
  );
  const validation = validatePhaseThreeLiveReceipt(receipt, {
    strict,
    root
  });
  if (!validation.ok) {
    const error = new Error("Phase-3 live receipt is invalid or stale.");
    error.code = "E_PHASE3_LIVE_EVIDENCE_INVALID";
    throw error;
  }
  return receipt;
}

const RECEIPT_FIELDS = new Set([
  "schemaVersion",
  "producerId",
  "producerVersion",
  "manifestDigest",
  "phase",
  "evidenceClass",
  "recordedAt",
  "source",
  "provider",
  "writeLifecycleCapabilityDigest",
  "inputs",
  "completion",
  "cancellation",
  "concurrency",
  "conflict",
  "gates",
  "outcome",
  "receiptDigest"
]);
const RECEIPT_SOURCE_FIELDS = new Set([
  "headCommit",
  "headTree",
  "sourceInventoryDigest",
  "phaseScopeDigest",
  "sourcePluginInventoryDigest",
  "installedPluginInventoryDigest",
  "installedEntrypointDigest"
]);
const RECEIPT_PROVIDER_FIELDS = new Set([
  "implementation",
  "version",
  "binaryDigest",
  "capabilityDigest",
  "pinRef",
  "launchBindingDigest",
  "executableIdentityDigest",
  "releaseIdentityDigest",
  "ambientDiscoveryPoisoned"
]);
const RECEIPT_INPUT_FIELDS = new Set([
  "completion",
  "twoWriter"
]);
const RECEIPT_INPUT_ENTRY_FIELDS = new Set(["digest", "projection"]);
const RECEIPT_COMPLETION_FIELDS = new Set([
  "workerId",
  "providerGeneration",
  "reportSource",
  "reportDigest",
  "manifestDigest",
  "patchDigest",
  "contentDigest",
  "integrationReceiptDigest",
  "hostVerificationDigest",
  "cleanupReceiptDigest",
  "absenceProofDigest"
]);
const RECEIPT_CANCELLATION_FIELDS = new Set([
  "workerId",
  "cleanupReceiptDigest",
  "terminalEvidenceDigest",
  "absenceProofDigest"
]);
const RECEIPT_CONCURRENCY_FIELDS = new Set([
  "workerAId",
  "workerBId",
  "executionBindingDigests",
  "executionRootDigests",
  "providerProcessDigests",
  "overlapObservationDigest",
  "observedAt"
]);
const RECEIPT_CONFLICT_FIELDS = new Set([
  "classification",
  "errorCode",
  "errorMessageDigest",
  "observationDigest",
  "abandonReceiptDigest"
]);

function twoDistinctDigests(value) {
  return Array.isArray(value)
    && value.length === 2
    && value.every((digest) => SHA256.test(digest || ""))
    && value[0] !== value[1];
}

function replayableInputsMatchReceipt(receipt) {
  const completion = receipt?.inputs?.completion?.projection;
  const twoWriter = receipt?.inputs?.twoWriter?.projection;
  const cancellation = completion?.writeCancellation;
  const workerA = twoWriter?.workers?.a;
  const workerB = twoWriter?.workers?.b;
  if (!completion || !twoWriter || !cancellation || !workerA || !workerB) {
    return false;
  }
  return stableStringify(receipt.source) === stableStringify({
    headCommit: completion.sourceHeadCommit,
    headTree: completion.sourceHeadTree,
    sourceInventoryDigest: completion.sourceInventoryDigest,
    phaseScopeDigest: receipt.source?.phaseScopeDigest,
    sourcePluginInventoryDigest: completion.sourcePluginInventoryDigest,
    installedPluginInventoryDigest: completion.installedPluginInventoryDigest,
    installedEntrypointDigest: completion.installedEntrypointDigest
  })
    && stableStringify(receipt.provider) === stableStringify({
      implementation: "official-grok-build-acp",
      version: completion.providerVersion,
      binaryDigest: completion.providerBinaryDigest,
      capabilityDigest: completion.providerCapabilityDigest,
      pinRef: completion.providerPinRef,
      launchBindingDigest: completion.providerLaunchBindingDigest,
      executableIdentityDigest: completion.providerExecutableIdentityDigest,
      releaseIdentityDigest: completion.providerReleaseIdentityDigest,
      ambientDiscoveryPoisoned: completion.ambientProviderDiscoveryPoisoned
    })
    && receipt.writeLifecycleCapabilityDigest
      === completion.writeLifecycleCapabilityDigest
    && stableStringify(receipt.completion) === stableStringify({
      workerId: completion.workerId,
      providerGeneration: completion.providerGeneration,
      reportSource: completion.reportSource,
      reportDigest: completion.reportDigest,
      manifestDigest: completion.manifestDigest,
      patchDigest: completion.patchDigest,
      contentDigest: completion.contentDigest,
      integrationReceiptDigest: completion.integrationReceiptDigest,
      hostVerificationDigest: completion.hostVerificationDigest,
      cleanupReceiptDigest: completion.cleanupReceiptDigest,
      absenceProofDigest: completion.absenceProofDigest
    })
    && stableStringify(receipt.cancellation) === stableStringify({
      workerId: cancellation.workerId,
      cleanupReceiptDigest: cancellation.cleanupReceiptDigest,
      terminalEvidenceDigest: cancellation.terminalEvidenceDigest,
      absenceProofDigest: cancellation.absenceProofDigest
    })
    && stableStringify(receipt.concurrency) === stableStringify({
      workerAId: workerA.id,
      workerBId: workerB.id,
      executionBindingDigests: [
        workerA.executionBindingDigest,
        workerB.executionBindingDigest
      ],
      executionRootDigests: [
        workerA.executionRootDigest,
        workerB.executionRootDigest
      ],
      providerProcessDigests: [
        workerA.providerProcessDigest,
        workerB.providerProcessDigest
      ],
      overlapObservationDigest: twoWriter.providerOverlap.observationDigest,
      observedAt: twoWriter.providerOverlap.observedAt
    })
    && stableStringify(receipt.conflict) === stableStringify({
      classification: workerB.conflictClassification,
      errorCode: workerB.rejectedIntegrationCode,
      errorMessageDigest: workerB.rejectedIntegrationMessageDigest,
      observationDigest: workerB.conflictObservationDigest,
      abandonReceiptDigest: workerB.abandonReceiptDigest
    });
}

export function validatePhaseThreeLiveReceipt(receipt, {
  strict = false,
  root = null
} = {}) {
  const errors = [];
  if (!serializedWithin(receipt, MAX_RECEIPT_BYTES)) {
    return { ok: false, errors: ["Phase-3 live receipt is malformed or oversized."] };
  }
  if (!exactFields(receipt, RECEIPT_FIELDS)) {
    errors.push("Phase-3 live receipt fields do not match the fixed manifest.");
  }
  if (receipt?.schemaVersion !== PHASE_THREE_LIVE_RECEIPT_SCHEMA_VERSION
    || receipt?.producerId !== PHASE_THREE_LIVE_RECEIPT_PRODUCER_ID
    || receipt?.producerVersion !== PHASE_THREE_LIVE_RECEIPT_PRODUCER_VERSION
    || receipt?.manifestDigest !== computePhaseThreeLiveManifestDigest()
    || receipt?.phase !== "3"
    || receipt?.evidenceClass !== "supporting-live-unqualified"
    || receipt?.outcome !== "pass") {
    errors.push("Phase-3 live receipt producer or outcome identity is invalid.");
  }
  if (typeof receipt?.recordedAt !== "string"
    || !Number.isFinite(Date.parse(receipt.recordedAt))
    || new Date(Date.parse(receipt.recordedAt)).toISOString() !== receipt.recordedAt) {
    errors.push("Phase-3 live receipt recordedAt is invalid.");
  }
  const source = receipt?.source;
  if (!exactFields(source, RECEIPT_SOURCE_FIELDS)
    || !SHA40.test(source?.headCommit || "")
    || !SHA40.test(source?.headTree || "")
    || !allDigests(source, [
      "sourceInventoryDigest",
      "phaseScopeDigest",
      "sourcePluginInventoryDigest",
      "installedPluginInventoryDigest",
      "installedEntrypointDigest"
    ])
    || source?.sourcePluginInventoryDigest
      !== source?.installedPluginInventoryDigest) {
    errors.push("Phase-3 live receipt source/install identity is invalid.");
  }
  const provider = receipt?.provider;
  if (!exactFields(provider, RECEIPT_PROVIDER_FIELDS)
    || provider?.implementation !== "official-grok-build-acp"
    || !safeRuntimeId(provider?.version)
    || !PIN_REF.test(provider?.pinRef || "")
    || !allDigests(provider, [
      "binaryDigest",
      "capabilityDigest",
      "launchBindingDigest",
      "executableIdentityDigest",
      "releaseIdentityDigest"
    ])
    || provider?.ambientDiscoveryPoisoned !== true) {
    errors.push("Phase-3 live receipt provider identity is invalid.");
  }
  const inputs = receipt?.inputs;
  const completionInputValidation = validatePhaseThreeCompletionEvidence(
    inputs?.completion?.projection
  );
  const twoWriterInputValidation = validatePhaseThreeTwoWriterEvidence(
    inputs?.twoWriter?.projection
  );
  if (!SHA256.test(receipt?.writeLifecycleCapabilityDigest || "")
    || !exactFields(inputs, RECEIPT_INPUT_FIELDS)
    || !exactFields(inputs?.completion, RECEIPT_INPUT_ENTRY_FIELDS)
    || !exactFields(inputs?.twoWriter, RECEIPT_INPUT_ENTRY_FIELDS)
    || !SHA256.test(inputs?.completion?.digest || "")
    || !SHA256.test(inputs?.twoWriter?.digest || "")
    || !completionInputValidation.ok
    || !twoWriterInputValidation.ok
    || !matchingCommonBindings(
      inputs?.completion?.projection,
      inputs?.twoWriter?.projection
    )
    || inputs?.completion?.digest
      !== computePhaseThreeLiveInputDigest(inputs?.completion?.projection)
    || inputs?.twoWriter?.digest
      !== computePhaseThreeLiveInputDigest(inputs?.twoWriter?.projection)) {
    errors.push("Phase-3 live receipt input/capability binding is invalid.");
  }
  if (completionInputValidation.ok
    && twoWriterInputValidation.ok
    && !replayableInputsMatchReceipt(receipt)) {
    errors.push("Phase-3 live receipt projections do not match replayable inputs.");
  }
  if (!exactFields(receipt?.completion, RECEIPT_COMPLETION_FIELDS)
    || !safeRuntimeId(receipt?.completion?.workerId)
    || !Number.isSafeInteger(receipt?.completion?.providerGeneration)
    || receipt.completion.providerGeneration < 1
    || receipt?.completion?.reportSource !== "acp-structured"
    || !allDigests(
      receipt?.completion,
      [...RECEIPT_COMPLETION_FIELDS].filter((field) => field.endsWith("Digest"))
    )) {
    errors.push("Phase-3 live receipt completion projection is invalid.");
  }
  if (!exactFields(receipt?.cancellation, RECEIPT_CANCELLATION_FIELDS)
    || !safeRuntimeId(receipt?.cancellation?.workerId)
    || !allDigests(
      receipt?.cancellation,
      [...RECEIPT_CANCELLATION_FIELDS].filter((field) => field.endsWith("Digest"))
    )) {
    errors.push("Phase-3 live receipt cancellation projection is invalid.");
  }
  const concurrency = receipt?.concurrency;
  if (!exactFields(concurrency, RECEIPT_CONCURRENCY_FIELDS)
    || !safeRuntimeId(concurrency?.workerAId)
    || !safeRuntimeId(concurrency?.workerBId)
    || concurrency?.workerAId === concurrency?.workerBId
    || !twoDistinctDigests(concurrency?.executionBindingDigests)
    || !twoDistinctDigests(concurrency?.executionRootDigests)
    || !twoDistinctDigests(concurrency?.providerProcessDigests)
    || !SHA256.test(concurrency?.overlapObservationDigest || "")
    || !Number.isSafeInteger(concurrency?.observedAt)
    || concurrency.observedAt <= 0) {
    errors.push("Phase-3 live receipt concurrency projection is invalid.");
  }
  if (!exactFields(receipt?.conflict, RECEIPT_CONFLICT_FIELDS)
    || receipt?.conflict?.classification !== "parent-drift"
    || receipt?.conflict?.errorCode !== "E_INTEGRATION"
    || !allDigests(receipt?.conflict, [
      "errorMessageDigest",
      "observationDigest",
      "abandonReceiptDigest"
    ])) {
    errors.push("Phase-3 live receipt conflict projection is invalid.");
  }
  if (JSON.stringify(receipt?.gates) !== JSON.stringify(PHASE_THREE_LIVE_GATE_IDS)) {
    errors.push("Phase-3 live receipt gates do not match the fixed manifest.");
  }
  if (!SHA256.test(receipt?.receiptDigest || "")
    || receipt?.receiptDigest !== computePhaseThreeLiveReceiptDigest(receipt)) {
    errors.push("Phase-3 live receipt digest does not match its canonical body.");
  }

  if (strict) {
    if (typeof root !== "string" || !root) {
      errors.push("Strict Phase-3 live receipt replay requires a repository root.");
    } else {
      try {
        const identity = gitIdentity(root);
        const sourceDigest = computeInventoryDigest(root, { includeEvidence: false });
        const pluginRoot = path.join(root, "plugins/grok");
        const pluginDigest = digestInventory(createPluginInventory(pluginRoot));
        const entrypointDigest = sha256Text(
          fs.readFileSync(path.join(pluginRoot, "mcp/server.mjs"))
        );
        if (!isNonEvidenceTreeClean(root)) {
          errors.push("Strict Phase-3 live receipt replay requires a clean non-evidence source.");
        }
        if (sourceDigest !== source?.sourceInventoryDigest
          || computePhaseScopeDigest("3", root) !== source?.phaseScopeDigest
          || pluginDigest !== source?.sourcePluginInventoryDigest
          || entrypointDigest !== source?.installedEntrypointDigest) {
          errors.push("Phase-3 live receipt is stale relative to current source/install identity.");
        }
        if (identity.headCommit !== source?.headCommit
          && sourceDigest !== source?.sourceInventoryDigest) {
          errors.push("Phase-3 live receipt head commit does not match current source.");
        }
        if (identity.headTree !== source?.headTree
          && sourceDigest !== source?.sourceInventoryDigest) {
          errors.push("Phase-3 live receipt head tree does not match current source.");
        }
      } catch {
        errors.push("Phase-3 live receipt current source identity could not be verified.");
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function phaseThreeLiveReceiptRelativePath(receipt) {
  const validated = validatePhaseThreeLiveReceipt(receipt);
  if (!validated.ok) {
    const error = new Error("Phase-3 live receipt is invalid.");
    error.code = "E_PHASE3_LIVE_EVIDENCE_INVALID";
    throw error;
  }
  return [
    PHASE_THREE_LIVE_RECEIPT_ROOT,
    `${receipt.source.sourceInventoryDigest.slice(0, 16)}-${receipt.receiptDigest.slice(0, 16)}.json`
  ].join("/");
}

export function writePhaseThreeLiveReceipt(receipt, root) {
  const validation = validatePhaseThreeLiveReceipt(receipt, {
    strict: true,
    root
  });
  if (!validation.ok) {
    const error = new Error("Phase-3 live receipt is invalid or stale.");
    error.code = "E_PHASE3_LIVE_EVIDENCE_INVALID";
    throw error;
  }
  const relative = phaseThreeLiveReceiptRelativePath(receipt);
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  return publishImmutableEvidenceArtifact({ root, relative, contents: serialized });
}
