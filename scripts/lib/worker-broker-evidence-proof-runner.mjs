/** Public-safe Phase 0/1 proof orchestration and publication authority. */
import path from "node:path";

import {
  EVIDENCE_ROOT,
  ISSUE_URL,
  MAX_EVIDENCE_RECORD_BYTES,
  NUMBERED_PHASE_SET,
  PHASE_MANDATORY_GATE_IDS,
  PHASE_PREREQUISITES,
  PRIOR_PROOF_MANIFEST_DIGESTS,
  PROOF_PRODUCER_FIELDS,
  PROOF_PRODUCER_ID,
  PROOF_PRODUCER_VERSION,
  REPO_ROOT,
  ROADMAP_VERSION,
  SHA256,
  VERIFIED_STATUS_SET,
  computeProofManifestDigest,
  proofProducedStatusIsCurrent
} from "./worker-broker-evidence-core.mjs";
import {
  atomicReplaceEvidenceFile,
  ensureEvidenceDirectory,
  invalidEvidencePublicationError,
  invalidLedgerDocumentError,
  invalidLedgerUpdateError,
  publishImmutableEvidenceFile,
  rawEvidenceValueIsSafe,
  readBoundedEvidenceFile,
  statusSatisfiesVerifiedPrerequisite,
  unexpectedFields,
  withEvidenceLedgerLock
} from "./worker-broker-evidence-files.mjs";
import {
  cloneLedgerEntry,
  ledgerDocumentShapeIsValid,
  loadCanonicalCutoverRecord,
  loadLedgerDocument
} from "./worker-broker-evidence-ledger.mjs";
import {
  captureProofSourceSnapshot,
  proofRecordMatchesSnapshot,
  provePhaseZeroInternal,
  proveWorkerBrokerPhaseInternal,
  sameProofSourceSnapshot
} from "./worker-broker-evidence-proof.mjs";
import {
  validateEvidenceRecord
} from "./worker-broker-evidence-record.mjs";
import {
  attachRecordDigest,
  computeRecordDigest
} from "./worker-broker-evidence-review.mjs";
import {
  passedGateIds
} from "./worker-broker-evidence-toolchain.mjs";
import {
  verifyLedger
} from "./worker-broker-evidence-verification.mjs";

const PROOF_PUBLICATION_AUTHORITY = Symbol("proof-publication-authority");

function proofValidationOptions(root) {
  return { strict: true, root, requireEvidenceSystem: true };
}

function proofLedgerOptions() {
  return { strict: true };
}

function prerequisiteSnapshotFromInspected(phase, inspected, root) {
  const snapshots = [];
  for (const prerequisitePhase of PHASE_PREREQUISITES[String(phase)] || []) {
    const candidates = inspected.filter(({ entry }) => (
      entry.currency === "current" && entry.phase === prerequisitePhase
    ));
    if (candidates.length !== 1) return null;
    const { record } = candidates[0];
    const validation = validateEvidenceRecord(record, proofValidationOptions(root));
    if (!validation.ok
      || !statusSatisfiesVerifiedPrerequisite(record.status, record.phase)) return null;
    const requiredGateIds = PHASE_MANDATORY_GATE_IDS[prerequisitePhase] || [];
    const passed = passedGateIds(record);
    if (requiredGateIds.some((gateId) => !passed.has(gateId))) return null;
    snapshots.push({
      phase: prerequisitePhase,
      recordDigest: record.recordDigest,
      gateIds: [...requiredGateIds]
    });
  }
  return snapshots;
}

function captureProofPrerequisites(phase, root) {
  const expected = PHASE_PREREQUISITES[String(phase)] || [];
  if (expected.length === 0) return [];
  const strict = verifyLedger(root, proofLedgerOptions());
  if (!strict.ok) return null;
  let loaded;
  try {
    loaded = loadLedgerDocument(root);
  } catch {
    return null;
  }
  if (!ledgerDocumentShapeIsValid(loaded.ledger)) return null;
  let inspected;
  try {
    inspected = loaded.ledger.entries.map((entry) => ({
      entry: cloneLedgerEntry(entry),
      record: loadCanonicalCutoverRecord(entry, root)
    }));
  } catch {
    return null;
  }
  return prerequisiteSnapshotFromInspected(phase, inspected, root);
}

function sameProofPrerequisites(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && JSON.stringify(left) === JSON.stringify(right);
}

function proofRecordMatchesPrerequisites(record, prerequisites) {
  return sameProofPrerequisites(record?.prerequisites, prerequisites);
}

function phaseIsSupersededByReplacement(candidatePhase, replacementPhase, visited = new Set()) {
  const candidate = String(candidatePhase);
  const replacement = String(replacementPhase);
  if (candidate === replacement) return true;
  if (visited.has(candidate)) return false;
  visited.add(candidate);
  return (PHASE_PREREQUISITES[candidate] || []).some((prerequisite) => (
    String(prerequisite) === replacement
    || phaseIsSupersededByReplacement(prerequisite, replacement, visited)
  ));
}

function proofProducedRecordIsSafelySupersedable(record, root) {
  const producer = record?.proofProducer;
  const version = producer?.version;
  const phase = String(record?.phase ?? "");
  const currentVersion = version === PROOF_PRODUCER_VERSION;
  const shapeIsSupported = Boolean(
    producer
    && typeof producer === "object"
    && !Array.isArray(producer)
    && unexpectedFields(producer, PROOF_PRODUCER_FIELDS).length === 0
    && producer.id === PROOF_PRODUCER_ID
    && Number.isInteger(version)
    && version >= 1
    && version <= PROOF_PRODUCER_VERSION
    && NUMBERED_PHASE_SET.has(phase)
    && proofProducedStatusIsCurrent(record)
    && (currentVersion
      || producer.manifestDigest === PRIOR_PROOF_MANIFEST_DIGESTS[version]?.[phase])
  );
  if (!shapeIsSupported) return false;
  let normalized;
  try {
    normalized = structuredClone(record);
    if (!currentVersion) {
      normalized.proofProducer.version = PROOF_PRODUCER_VERSION;
      normalized.proofProducer.manifestDigest = computeProofManifestDigest(phase);
      normalized = attachRecordDigest(normalized);
    }
  } catch {
    return false;
  }
  const validation = validateEvidenceRecord(normalized, {
    strict: false,
    root,
    requireEvidenceSystem: true
  });
  if (validation.ok) return true;
  return phase === "1"
    && normalized.status === "verified_on_draft"
    && validation.errors.length === 1
    && validation.errors[0]
      === "Signed independent review requires protected host trust verification.";
}

function supersedeCurrentProofChainEntry(entry, replacementPhase) {
  const next = cloneLedgerEntry(entry);
  if (next.currency === "current"
    && phaseIsSupersededByReplacement(next.phase, replacementPhase)) {
    next.currency = "historical";
  }
  return next;
}

function prepareProofRecordForPublication(record, root) {
  if (!rawEvidenceValueIsSafe(record, "$record")) throw invalidEvidencePublicationError();
  let body;
  try {
    body = structuredClone(record);
  } catch {
    throw invalidEvidencePublicationError();
  }
  if (typeof body.recordDigest !== "string"
    || !SHA256.test(body.recordDigest)
    || body.recordDigest !== computeRecordDigest(body)
    || !Object.hasOwn(body, "proofProducer")
    || !new Set(["0", "1"]).has(String(body.phase))
    || (body.phase === "0" && body.status !== "verified_on_draft")
    || (body.phase === "1" && body.status !== "implemented_unverified")
    || body.qualification?.provider === "pass"
    || body.qualification?.installedHost === "pass"
    || Object.hasOwn(body, "liveQualificationReceipts")) {
    throw invalidEvidencePublicationError();
  }
  const validated = validateEvidenceRecord(body, proofValidationOptions(root));
  if (!validated.ok) throw invalidEvidencePublicationError();
  return body;
}

function writeProofEvidenceRecord(record, root, authority) {
  if (authority !== PROOF_PUBLICATION_AUTHORITY) throw invalidEvidencePublicationError();
  const body = prepareProofRecordForPublication(record, root);
  const sourceDigest = body.source?.sourceInventoryDigest;
  if (typeof sourceDigest !== "string" || !SHA256.test(sourceDigest)) {
    throw invalidEvidencePublicationError();
  }
  const directory = path.join(root, EVIDENCE_ROOT, `phase-${body.phase}`);
  const file = path.join(
    directory,
    `${sourceDigest.slice(0, 16)}-${body.recordDigest.slice(0, 12)}.json`
  );
  const relativeFile = path.relative(root, file).split(path.sep).join("/");
  const serialized = `${JSON.stringify(body, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_EVIDENCE_RECORD_BYTES) {
    throw invalidEvidencePublicationError();
  }
  ensureEvidenceDirectory(root, directory);
  let existing;
  try {
    existing = readBoundedEvidenceFile(root, file);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error("Refusing an unsafe existing immutable evidence record.");
    }
  }
  if (existing !== undefined) {
    if (existing !== serialized) {
      throw new Error(`Refusing to overwrite immutable evidence record ${relativeFile}.`);
    }
    return relativeFile;
  }
  try {
    publishImmutableEvidenceFile(root, file, serialized);
  } catch (error) {
    if (error?.code === "EEXIST") {
      try {
        if (readBoundedEvidenceFile(root, file) === serialized) return relativeFile;
      } catch {}
      throw new Error("Refusing to replace a raced immutable evidence destination.");
    }
    throw error;
  }
  return relativeFile;
}

function invalidateAllCurrentLedgerEntriesUnderLock(root, loaded = null) {
  let document = loaded;
  if (!document) {
    try {
      document = loadLedgerDocument(root);
    } catch {
      throw invalidLedgerDocumentError();
    }
  }
  if (!ledgerDocumentShapeIsValid(document.ledger)) throw invalidLedgerDocumentError();
  for (const entry of document.ledger.entries) loadCanonicalCutoverRecord(entry, root);
  const entries = document.ledger.entries.map((entry) => ({
    ...cloneLedgerEntry(entry),
    currency: entry.currency === "current" ? "invalidated" : entry.currency
  }));
  if (!document.ledger.entries.some((entry) => entry.currency === "current")) return;
  const next = {
    schemaVersion: 1,
    roadmapVersion: ROADMAP_VERSION,
    issue: ISSUE_URL,
    updatedAt: new Date().toISOString(),
    entries
  };
  if (!ledgerDocumentShapeIsValid(next)) throw invalidLedgerUpdateError();
  const file = path.join(root, EVIDENCE_ROOT, "ledger.json");
  try {
    atomicReplaceEvidenceFile(root, file, `${JSON.stringify(next, null, 2)}\n`, document.expected);
  } catch {
    throw invalidLedgerDocumentError();
  }
  if (!verifyLedger(root, { strict: true }).ok) throw invalidLedgerDocumentError();
}

function invalidateAllCurrentLedgerEntries(root) {
  return withEvidenceLedgerLock(root, () => invalidateAllCurrentLedgerEntriesUnderLock(root));
}

function inspectLedgerForProof(root) {
  let loaded;
  try {
    loaded = loadLedgerDocument(root);
  } catch {
    throw invalidLedgerDocumentError();
  }
  if (!ledgerDocumentShapeIsValid(loaded.ledger)) throw invalidLedgerDocumentError();
  let inspected;
  try {
    inspected = loaded.ledger.entries.map((entry) => ({
      entry: cloneLedgerEntry(entry),
      record: loadCanonicalCutoverRecord(entry, root)
    }));
  } catch {
    throw invalidLedgerDocumentError();
  }
  return { loaded, inspected };
}

function publishPhaseZeroProofRecord(record, root, expectedSource, toolchain) {
  if (record?.phase !== "0" || record?.status !== "verified_on_draft") {
    throw invalidEvidencePublicationError();
  }
  if (!validateEvidenceRecord(record, proofValidationOptions(root)).ok) {
    throw invalidEvidencePublicationError();
  }
  const immediatelyBeforeRecord = captureProofSourceSnapshot("0", root, toolchain);
  if (!sameProofSourceSnapshot(expectedSource, immediatelyBeforeRecord)
    || !proofRecordMatchesSnapshot(record, expectedSource)) {
    throw invalidEvidencePublicationError();
  }

  const relative = writeProofEvidenceRecord(record, root, PROOF_PUBLICATION_AUTHORITY);
  withEvidenceLedgerLock(root, () => {
    const immediatelyBeforeLedger = captureProofSourceSnapshot("0", root, toolchain);
    if (!sameProofSourceSnapshot(expectedSource, immediatelyBeforeLedger)
      || !proofRecordMatchesSnapshot(record, expectedSource)) {
      throw invalidEvidencePublicationError();
    }
    const { loaded, inspected } = inspectLedgerForProof(root);
    const current = inspected.filter(({ entry }) => entry.currency === "current");
    const legacyCurrent = current.filter(({ record: existing }) => (
      !Object.hasOwn(existing, "proofProducer") && VERIFIED_STATUS_SET.has(existing.status)
    ));
    const runnerCurrent = current.filter(({ record: existing }) => (
      Object.hasOwn(existing, "proofProducer")
      && proofProducedRecordIsSafelySupersedable(existing, root)
    ));
    const malformedRunnerCurrent = current.filter(({ record: existing }) => (
      Object.hasOwn(existing, "proofProducer")
      && !proofProducedRecordIsSafelySupersedable(existing, root)
    ));
    const unsupportedCurrent = current.filter(({ record: existing }) => (
      !Object.hasOwn(existing, "proofProducer") && !VERIFIED_STATUS_SET.has(existing.status)
    ));
    if (unsupportedCurrent.length
      || malformedRunnerCurrent.length
      || (legacyCurrent.length && runnerCurrent.length)) {
      throw invalidLedgerDocumentError();
    }
    const entries = inspected.map(({ entry, record: existing }) => {
      const next = cloneLedgerEntry(entry);
      if (next.currency !== "current") return next;
      if (legacyCurrent.length && !Object.hasOwn(existing, "proofProducer")) {
        next.currency = "invalidated";
      } else if (!legacyCurrent.length) {
        return supersedeCurrentProofChainEntry(next, "0");
      }
      return next;
    });
    entries.push({
      phase: record.phase,
      slice: record.slice,
      status: record.status,
      path: relative,
      recordDigest: record.recordDigest,
      sourceCommit: record.source.headCommit,
      currency: "current",
      recordedAt: record.recordedAt
    });
    const next = {
      schemaVersion: 1,
      roadmapVersion: ROADMAP_VERSION,
      issue: ISSUE_URL,
      updatedAt: new Date().toISOString(),
      entries
    };
    if (!ledgerDocumentShapeIsValid(next)) throw invalidLedgerUpdateError();
    const file = path.join(root, EVIDENCE_ROOT, "ledger.json");
    const serializedNext = `${JSON.stringify(next, null, 2)}\n`;
    try {
      atomicReplaceEvidenceFile(root, file, serializedNext, loaded.expected);
    } catch {
      throw invalidLedgerDocumentError();
    }
    const published = loadLedgerDocument(root);
    if (published.expected.contents !== serializedNext) throw invalidLedgerDocumentError();
    let afterLedger;
    let afterStrict;
    let finalInsideLock;
    try {
      afterLedger = captureProofSourceSnapshot("0", root, toolchain);
      afterStrict = verifyLedger(root, { strict: true });
      finalInsideLock = captureProofSourceSnapshot("0", root, toolchain);
    } catch {
      afterStrict = { ok: false };
    }
    if (!sameProofSourceSnapshot(expectedSource, afterLedger)
      || !afterStrict.ok
      || !sameProofSourceSnapshot(expectedSource, finalInsideLock)) {
      invalidateAllCurrentLedgerEntriesUnderLock(root, published);
      throw invalidEvidencePublicationError();
    }
  });

  let afterRelease;
  let strictAfterRelease;
  let finalAfterRelease;
  try {
    afterRelease = captureProofSourceSnapshot("0", root, toolchain);
    strictAfterRelease = verifyLedger(root, { strict: true });
    finalAfterRelease = captureProofSourceSnapshot("0", root, toolchain);
  } catch {
    strictAfterRelease = { ok: false };
  }
  if (!sameProofSourceSnapshot(expectedSource, afterRelease)
    || !strictAfterRelease.ok
    || !sameProofSourceSnapshot(expectedSource, finalAfterRelease)) {
    invalidateAllCurrentLedgerEntries(root);
    throw invalidEvidencePublicationError();
  }
  return relative;
}

function publishPhaseOneProofRecord(
  record,
  root,
  expectedSource,
  expectedPrerequisites,
  toolchain
) {
  if (record?.phase !== "1"
    || record?.status !== "implemented_unverified"
    || !proofRecordMatchesPrerequisites(record, expectedPrerequisites)
    || !validateEvidenceRecord(record, proofValidationOptions(root)).ok) {
    throw invalidEvidencePublicationError();
  }
  const immediatelyBeforeRecord = captureProofSourceSnapshot("1", root, toolchain);
  const immediatelyBeforePrerequisites = captureProofPrerequisites("1", root);
  if (!sameProofSourceSnapshot(expectedSource, immediatelyBeforeRecord)
    || !sameProofPrerequisites(expectedPrerequisites, immediatelyBeforePrerequisites)
    || !proofRecordMatchesSnapshot(record, expectedSource)) {
    throw invalidEvidencePublicationError();
  }

  const relative = writeProofEvidenceRecord(record, root, PROOF_PUBLICATION_AUTHORITY);
  withEvidenceLedgerLock(root, () => {
    const immediatelyBeforeLedger = captureProofSourceSnapshot("1", root, toolchain);
    if (!sameProofSourceSnapshot(expectedSource, immediatelyBeforeLedger)
      || !proofRecordMatchesSnapshot(record, expectedSource)) {
      throw invalidEvidencePublicationError();
    }
    const { loaded, inspected } = inspectLedgerForProof(root);
    const lockedPrerequisites = prerequisiteSnapshotFromInspected("1", inspected, root);
    if (!sameProofPrerequisites(expectedPrerequisites, lockedPrerequisites)) {
      throw invalidLedgerDocumentError();
    }
    const entries = inspected.map(({ entry }) => (
      supersedeCurrentProofChainEntry(entry, "1")
    ));
    entries.push({
      phase: record.phase,
      slice: record.slice,
      status: record.status,
      path: relative,
      recordDigest: record.recordDigest,
      sourceCommit: record.source.headCommit,
      currency: "current",
      recordedAt: record.recordedAt
    });
    const next = {
      schemaVersion: 1,
      roadmapVersion: ROADMAP_VERSION,
      issue: ISSUE_URL,
      updatedAt: new Date().toISOString(),
      entries
    };
    if (!ledgerDocumentShapeIsValid(next)) throw invalidLedgerUpdateError();
    const file = path.join(root, EVIDENCE_ROOT, "ledger.json");
    const serializedNext = `${JSON.stringify(next, null, 2)}\n`;
    try {
      atomicReplaceEvidenceFile(root, file, serializedNext, loaded.expected);
    } catch {
      throw invalidLedgerDocumentError();
    }
    const published = loadLedgerDocument(root);
    if (published.expected.contents !== serializedNext) throw invalidLedgerDocumentError();
    let afterLedger;
    let afterPrerequisites;
    let afterStrict;
    let finalInsideLock;
    try {
      afterLedger = captureProofSourceSnapshot("1", root, toolchain);
      afterPrerequisites = captureProofPrerequisites("1", root);
      afterStrict = verifyLedger(root, { strict: true });
      finalInsideLock = captureProofSourceSnapshot("1", root, toolchain);
    } catch {
      afterStrict = { ok: false };
    }
    if (!sameProofSourceSnapshot(expectedSource, afterLedger)
      || !sameProofPrerequisites(expectedPrerequisites, afterPrerequisites)
      || !afterStrict.ok
      || !sameProofSourceSnapshot(expectedSource, finalInsideLock)) {
      invalidateAllCurrentLedgerEntriesUnderLock(root, published);
      throw invalidEvidencePublicationError();
    }
  });

  let afterRelease;
  let afterPrerequisites;
  let strictAfterRelease;
  let finalAfterRelease;
  try {
    afterRelease = captureProofSourceSnapshot("1", root, toolchain);
    afterPrerequisites = captureProofPrerequisites("1", root);
    strictAfterRelease = verifyLedger(root, { strict: true });
    finalAfterRelease = captureProofSourceSnapshot("1", root, toolchain);
  } catch {
    strictAfterRelease = { ok: false };
  }
  if (!sameProofSourceSnapshot(expectedSource, afterRelease)
    || !sameProofPrerequisites(expectedPrerequisites, afterPrerequisites)
    || !strictAfterRelease.ok
    || !sameProofSourceSnapshot(expectedSource, finalAfterRelease)) {
    invalidateAllCurrentLedgerEntries(root);
    throw invalidEvidencePublicationError();
  }
  return relative;
}

const PUBLIC_PROOF_SERVICES = Object.freeze({
  captureProofPrerequisites,
  proofRecordMatchesPrerequisites,
  proofSignedReviewOptions: proofValidationOptions,
  publishDependentPhaseProofRecord: publishPhaseOneProofRecord,
  publishPhaseZeroProofRecord,
  sameProofPrerequisites,
  validateEvidenceRecord
});

export function proveWorkerBrokerPhase(options = {}) {
  return proveWorkerBrokerPhaseInternal(options, PUBLIC_PROOF_SERVICES);
}

export function provePhaseZero(options = {}) {
  return provePhaseZeroInternal(options, PUBLIC_PROOF_SERVICES);
}
