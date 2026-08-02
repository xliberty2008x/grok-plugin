/** Internal Worker Broker evidence ledger domain. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { redactText } from "../../plugins/grok/scripts/lib/redact.mjs";
import {
  createPluginInventory,
  digestInventory
} from "./plugin-inventory.mjs";

import {
  EVIDENCE_ROOT,
  ISSUE_URL,
  LEDGER_CURRENCIES,
  LEDGER_ENTRY_FIELDS,
  LEDGER_FIELDS,
  MAX_EVIDENCE_ARRAY_ITEMS,
  MAX_EVIDENCE_STRING_CHARS,
  PHASE_MANDATORY_GATE_IDS,
  PRIVATE_EVIDENCE_PATH,
  REPO_ROOT,
  ROADMAP_VERSION,
  SHA256,
  STATUS_SET,
  VERIFIED_STATUS_SET
} from "./worker-broker-evidence-core.mjs";
import {
  atomicReplaceEvidenceFile,
  boundedEvidenceErrors,
  evidencePathIsStablyAbsent,
  exactFields,
  invalidLedgerDocumentError,
  invalidLedgerUpdateError,
  isIsoDateTime,
  rawEvidenceValueIsSafe,
  readBoundedEvidenceFile,
  readBoundedEvidenceFileSnapshot,
  unexpectedFields,
  withEvidenceLedgerLock
} from "./worker-broker-evidence-files.mjs";
import {
  computeRecordDigest
} from "./worker-broker-evidence-review.mjs";
import {
  recordCarriesLiveQualification
} from "./worker-broker-evidence-toolchain.mjs";

function emptyLedger() {
  return {
    schemaVersion: 1,
    roadmapVersion: ROADMAP_VERSION,
    issue: ISSUE_URL,
    updatedAt: null,
    entries: []
  };
}

export function loadLedgerDocument(root = REPO_ROOT) {
  const file = path.join(root, EVIDENCE_ROOT, "ledger.json");
  try {
    const loaded = readBoundedEvidenceFileSnapshot(root, file);
    return {
      ledger: JSON.parse(loaded.contents),
      expected: {
        exists: true,
        contents: loaded.contents,
        fileSnapshot: loaded.fileSnapshot
      }
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        ledger: emptyLedger(),
        expected: { exists: false, contents: null, fileSnapshot: null }
      };
    }
    throw error;
  }
}

export function loadLedger(root = REPO_ROOT) {
  return loadLedgerDocument(root).ledger;
}

function safeLedgerString(value) {
  if (typeof value !== "string") return null;
  if (value.length > MAX_EVIDENCE_STRING_CHARS
    || redactText(value) !== value
    || PRIVATE_EVIDENCE_PATH.test(value)) return "[REDACTED]";
  return value;
}

export function projectLedgerForOutput(ledger) {
  const entries = Array.isArray(ledger?.entries)
    ? ledger.entries.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      return {
        phase: safeLedgerString(entry.phase),
        slice: safeLedgerString(entry.slice),
        status: safeLedgerString(entry.status),
        path: safeLedgerString(entry.path),
        recordDigest: safeLedgerString(entry.recordDigest),
        sourceCommit: safeLedgerString(entry.sourceCommit),
        currency: safeLedgerString(entry.currency),
        recordedAt: safeLedgerString(entry.recordedAt)
      };
    })
    : [];
  return {
    schemaVersion: Number.isInteger(ledger?.schemaVersion) ? ledger.schemaVersion : null,
    roadmapVersion: safeLedgerString(ledger?.roadmapVersion),
    issue: safeLedgerString(ledger?.issue),
    updatedAt: safeLedgerString(ledger?.updatedAt),
    entries
  };
}

function normalizedLedgerEvidencePath(value) {
  if (typeof value !== "string"
    || !value
    || value.includes("\0")
    || value.includes("\\")
    || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || !value.startsWith(`${EVIDENCE_ROOT}/`)) return false;
  const relative = path.posix.relative(EVIDENCE_ROOT, value);
  return Boolean(relative
    && relative !== "."
    && relative !== ".."
    && !relative.startsWith("../")
    && !path.posix.isAbsolute(relative));
}

function ledgerEntryShapeIsValid(entry) {
  return exactFields(entry, LEDGER_ENTRY_FIELDS)
    && typeof entry.phase === "string"
    && Object.hasOwn(PHASE_MANDATORY_GATE_IDS, entry.phase)
    && typeof entry.slice === "string"
    && entry.slice.length > 0
    && STATUS_SET.has(entry.status)
    && normalizedLedgerEvidencePath(entry.path)
    && typeof entry.recordDigest === "string"
    && SHA256.test(entry.recordDigest)
    && typeof entry.sourceCommit === "string"
    && /^[0-9a-f]{40}$/.test(entry.sourceCommit)
    && LEDGER_CURRENCIES.has(entry.currency)
    && isIsoDateTime(entry.recordedAt);
}

export function ledgerDocumentShapeIsValid(ledger) {
  if (!rawEvidenceValueIsSafe(ledger, "$ledger")
    || !exactFields(ledger, LEDGER_FIELDS)
    || ledger.schemaVersion !== 1
    || ledger.roadmapVersion !== ROADMAP_VERSION
    || ledger.issue !== ISSUE_URL
    || !Array.isArray(ledger.entries)
    || ledger.entries.length > MAX_EVIDENCE_ARRAY_ITEMS
    || !ledger.entries.every(ledgerEntryShapeIsValid)) return false;
  if (ledger.entries.length === 0) {
    if (ledger.updatedAt !== null) return false;
  } else if (!isIsoDateTime(ledger.updatedAt)) {
    return false;
  }
  const currentPhases = new Set();
  const currentPhaseSlices = new Set();
  for (const entry of ledger.entries) {
    if (entry.currency !== "current") continue;
    const phaseSlice = `${entry.phase}\0${entry.slice}`;
    if (currentPhases.has(entry.phase) || currentPhaseSlices.has(phaseSlice)) return false;
    currentPhases.add(entry.phase);
    currentPhaseSlices.add(phaseSlice);
  }
  return true;
}

function prepareIncomingLedgerEntry(entry) {
  if (!rawEvidenceValueIsSafe(entry, "$entry")
    || !entry
    || typeof entry !== "object"
    || Array.isArray(entry)
    || unexpectedFields(entry, LEDGER_ENTRY_FIELDS).length) {
    throw invalidLedgerUpdateError();
  }
  let detached;
  try {
    detached = structuredClone(entry);
  } catch {
    throw invalidLedgerUpdateError();
  }
  const next = {
    phase: detached.phase,
    slice: detached.slice,
    status: detached.status,
    path: detached.path,
    recordDigest: detached.recordDigest,
    sourceCommit: detached.sourceCommit,
    currency: detached.currency ?? "current",
    recordedAt: detached.recordedAt ?? new Date().toISOString()
  };
  if (!ledgerEntryShapeIsValid(next)) throw invalidLedgerUpdateError();
  return next;
}

export function cloneLedgerEntry(entry) {
  return {
    phase: entry.phase,
    slice: entry.slice,
    status: entry.status,
    path: entry.path,
    recordDigest: entry.recordDigest,
    sourceCommit: entry.sourceCommit,
    currency: entry.currency,
    recordedAt: entry.recordedAt
  };
}

export function updateLedger(entry, root = REPO_ROOT) {
  // Incoming caller data is checked before lock acquisition can create the
  // evidence directory. The complete read/validate/mutate/replace transaction
  // is then serialized by the repository-local evidence lock.
  const incoming = prepareIncomingLedgerEntry(entry);
  if (incoming.currency === "current"
    && VERIFIED_STATUS_SET.has(incoming.status)) {
    throw invalidLedgerUpdateError();
  }
  return withEvidenceLedgerLock(root, () => {
    let loaded;
    try {
      loaded = loadLedgerDocument(root);
    } catch {
      throw invalidLedgerDocumentError();
    }
    if (!ledgerDocumentShapeIsValid(loaded.ledger)) throw invalidLedgerDocumentError();
    const entries = loaded.ledger.entries.map(cloneLedgerEntry);
    if (incoming.currency === "current") {
      // Legacy/concurrency callers may reserve a ledger path before the record
      // exists. Genuinely absent paths retain that compatibility, but existing
      // bytes of any kind must parse and match the entry exactly; malformed,
      // unsafe, mismatched, provisional, or live-supporting records fail closed.
      const incomingRecord = loadCanonicalCutoverRecord(
        incoming,
        root,
        { allowMissing: true }
      );
      if (incomingRecord
        && (incomingRecord.provisionalSupportingRecord === true
          || recordCarriesLiveQualification(incomingRecord))) {
        throw invalidLedgerUpdateError();
      }
      for (const existing of entries) {
        if (existing.phase === incoming.phase && existing.currency === "current") {
          existing.currency = "historical";
        }
      }
    }
    entries.push(cloneLedgerEntry(incoming));
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
      atomicReplaceEvidenceFile(root, file, `${JSON.stringify(next, null, 2)}\n`, loaded.expected);
    } catch {
      throw invalidLedgerDocumentError();
    }
    return next;
  });
}

export function loadCanonicalCutoverRecord(entry, root, { allowMissing = false } = {}) {
  if (!ledgerEntryShapeIsValid(entry) || !normalizedLedgerEvidencePath(entry.path)) {
    throw invalidLedgerDocumentError();
  }
  let absolute;
  try {
    absolute = path.resolve(root, entry.path);
    const evidenceRoot = path.resolve(root, EVIDENCE_ROOT);
    if (!absolute.startsWith(`${evidenceRoot}${path.sep}`)) {
      throw invalidLedgerDocumentError();
    }
    if (allowMissing && evidencePathIsStablyAbsent(root, absolute)) return null;
  } catch {
    throw invalidLedgerDocumentError();
  }
  let record;
  try {
    record = JSON.parse(readBoundedEvidenceFile(root, absolute));
  } catch {
    throw invalidLedgerDocumentError();
  }
  if (!record || typeof record !== "object" || Array.isArray(record)
    || !rawEvidenceValueIsSafe(record, "$record")
    || boundedEvidenceErrors(record, "$record").length
    || !SHA256.test(record.recordDigest || "")
    || record.recordDigest !== computeRecordDigest(record)
    || entry.phase !== record.phase
    || entry.slice !== record.slice
    || entry.status !== record.status
    || entry.recordDigest !== record.recordDigest
    || entry.sourceCommit !== record.source?.headCommit
    || entry.recordedAt !== record.recordedAt) {
    throw invalidLedgerDocumentError();
  }
  return record;
}

export function restoreLedgerAfterFailedReviewPromotion(root, expectedPublished, original) {
  try {
    const current = loadLedgerDocument(root);
    if (current.expected.contents !== expectedPublished) return false;
    const file = path.join(root, EVIDENCE_ROOT, "ledger.json");
    atomicReplaceEvidenceFile(root, file, original.expected.contents, current.expected);
    return true;
  } catch {
    return false;
  }
}
