/** Internal Worker Broker evidence authority domain. */
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
  ATOMIC_REPLACE_COMMIT_STATE,
  EVIDENCE_ROOT,
  ISSUE_URL,
  LEDGER_LOCK_ACTION_COMPLETED,
  LEDGER_LOCK_RELEASE_FAILURE,
  MAX_EVIDENCE_RECORD_BYTES,
  NUMBERED_PHASE_SET,
  PHASE_MANDATORY_GATE_IDS,
  PHASE_PREREQUISITES,
  PHASE_PROOF_GATE_MANIFEST,
  PHASE_THREE_SLICE,
  PHASE_TWO_SLICE,
  PRIOR_PROOF_MANIFEST_DIGESTS,
  PROOF_PRODUCER_FIELDS,
  PROOF_PRODUCER_ID,
  PROOF_PRODUCER_VERSION,
  REPO_ROOT,
  REVIEW_ATTESTATION_ROOT,
  REVIEW_REQUEST_ROOT,
  ROADMAP_VERSION,
  SHA256,
  SIGNED_REVIEW_RECEIPT_PRODUCER_ID,
  SIGNED_REVIEW_RECEIPT_PRODUCER_VERSION,
  SIGNED_REVIEW_RECEIPT_SCHEMA_VERSION,
  VERIFIED_STATUS_SET,
  computeProofManifestDigest,
  proofProducedStatusIsCurrent
} from "./worker-broker-evidence-core.mjs";
import {
  atomicReplaceEvidenceFile,
  ensureEvidenceDirectory,
  evidencePathIsStablyAbsent,
  fixedEvidenceError,
  invalidEvidencePublicationError,
  invalidLedgerDocumentError,
  invalidLedgerUpdateError,
  publishImmutableEvidenceFile,
  protectedReviewTrustError,
  rawEvidenceValueIsSafe,
  readBoundedEvidenceFile,
  readBoundedEvidenceFileSnapshot,
  sameFileSnapshot,
  statusSatisfiesVerifiedPrerequisite,
  unexpectedFields,
  withEvidenceLedgerLock
} from "./worker-broker-evidence-files.mjs";
import {
  cloneLedgerEntry,
  ledgerDocumentShapeIsValid,
  loadCanonicalCutoverRecord,
  loadLedgerDocument,
  restoreLedgerAfterFailedReviewPromotion
} from "./worker-broker-evidence-ledger.mjs";
import {
  captureProofSourceSnapshot,
  proofFailure,
  proofFailureForError,
  proofRecordMatchesSnapshot,
  provePhaseZeroInternal,
  proveWorkerBrokerPhaseInternal,
  proveWorkerBrokerPhaseWithContext as proveWorkerBrokerPhaseWithContextInternal,
  sameProofSourceSnapshot
} from "./worker-broker-evidence-proof.mjs";
import {
  assertProtectedWorkspaceGitConfiguration,
  loadProtectedReviewTrust,
  protectedWorkspaceRoot
} from "./worker-broker-evidence-protected-trust.mjs";
import {
  validateEvidenceRecordInternal
} from "./worker-broker-evidence-record.mjs";
import {
  attachIndependentReviewReceiptDigest,
  attachRecordDigest,
  computeRecordDigest,
  isCanonicalIsoDateTime,
  normalizedReviewArtifactPath,
  reviewAttestationRelativePath,
  reviewRequestRelativePath,
  createPhaseOneReviewRequestInternal,
  validateIndependentReviewAttestation,
  validatePhaseOneReviewRequestInternal
} from "./worker-broker-evidence-review.mjs";
import {
  PROOF_TOOLCHAIN_ERROR,
  createProofExecutionContext,
  passedGateIds,
  withProtectedReviewGitBinding
} from "./worker-broker-evidence-toolchain.mjs";
import {
  evidenceStatusInternal,
  verifyLedgerInternal,
  verifyPhaseInternal
} from "./worker-broker-evidence-verification.mjs";

const PROOF_PUBLICATION_AUTHORITY = Symbol("proof-publication-authority");

const REVIEW_PROMOTION_PUBLICATION_AUTHORITY = Symbol("review-promotion-publication-authority");

const SIGNED_REVIEW_VALIDATION_AUTHORITY = Symbol("signed-review-validation-authority");

const REVIEW_VALIDATION_SERVICES = Object.freeze({
  cloneLedgerEntry,
  ledgerDocumentShapeIsValid,
  loadCanonicalCutoverRecord,
  loadLedgerDocument,
  validateEvidenceRecord,
  verifyLedger
});

function validateEvidenceRecord(record, options = {}) {
  return validateEvidenceRecordInternal(record, options, {
    review: REVIEW_VALIDATION_SERVICES,
    signedReviewAuthorized:
      options?.signedReviewAuthority === SIGNED_REVIEW_VALIDATION_AUTHORITY
  });
}

function validatePhaseOneReviewRequest(request, options = {}) {
  return validatePhaseOneReviewRequestInternal(
    request,
    options,
    REVIEW_VALIDATION_SERVICES
  );
}

function createPhaseOneReviewRequest(options = {}) {
  return createPhaseOneReviewRequestInternal(options, REVIEW_VALIDATION_SERVICES);
}

function verifyLedger(root = REPO_ROOT, options = {}) {
  return verifyLedgerInternal(root, options, validateEvidenceRecord);
}

function verifyPhase(phase, root = REPO_ROOT, options = {}) {
  return verifyPhaseInternal(phase, root, options, validateEvidenceRecord);
}

function evidenceStatus(root = REPO_ROOT, options = {}) {
  return evidenceStatusInternal(root, options, validateEvidenceRecord);
}

const PROOF_SERVICES = Object.freeze({
  captureProofPrerequisites,
  proofRecordMatchesPrerequisites,
  proofSignedReviewOptions,
  publishDependentPhaseProofRecord,
  publishPhaseZeroProofRecord,
  sameProofPrerequisites,
  validateEvidenceRecord
});

function proveWorkerBrokerPhase(options = {}) {
  return proveWorkerBrokerPhaseInternal(options, PROOF_SERVICES);
}

function provePhaseZero(options = {}) {
  return provePhaseZeroInternal(options, PROOF_SERVICES);
}

function proveWorkerBrokerPhaseWithContext(...args) {
  return proveWorkerBrokerPhaseWithContextInternal(...args, PROOF_SERVICES);
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
  const strict = verifyLedger(root, { strict: true });
  if (!strict.ok) throw invalidLedgerDocumentError();
}

function invalidateAllCurrentLedgerEntries(root) {
  return withEvidenceLedgerLock(root, () => invalidateAllCurrentLedgerEntriesUnderLock(root));
}

function prepareEvidenceRecordForPublication(record, authority = null, validationOptions = {}) {
  if (!rawEvidenceValueIsSafe(record, "$record")) throw invalidEvidencePublicationError();
  const suppliedDigest = Object.hasOwn(record, "recordDigest");
  let body;
  try {
    const detached = structuredClone(record);
    if (suppliedDigest) {
      if (!Object.hasOwn(detached, "recordDigest")
        || typeof detached.recordDigest !== "string"
        || !SHA256.test(detached.recordDigest)
        || detached.recordDigest !== computeRecordDigest(detached)) {
        throw invalidEvidencePublicationError();
      }
      body = detached;
    } else {
      body = attachRecordDigest(detached);
    }
  } catch (error) {
    if (error?.code === "E_EVIDENCE_RECORD_INVALID") throw error;
    throw invalidEvidencePublicationError();
  }
  const validated = validateEvidenceRecord(body, {
    strict: false,
    ...validationOptions
  });
  if (!validated.ok) throw invalidEvidencePublicationError();
  const signedPhaseOnePromotion = body.phase === "1"
    && body.status === "verified_on_draft"
    && body.independentReviewReceipt?.schemaVersion === SIGNED_REVIEW_RECEIPT_SCHEMA_VERSION;
  if (signedPhaseOnePromotion
    && authority !== REVIEW_PROMOTION_PUBLICATION_AUTHORITY) {
    throw invalidEvidencePublicationError();
  }
  if (!signedPhaseOnePromotion
    && (VERIFIED_STATUS_SET.has(body.status)
      || Object.hasOwn(body, "proofProducer")
      || Object.hasOwn(body, "independentReviewReceipt"))
    && authority !== PROOF_PUBLICATION_AUTHORITY) {
    throw invalidEvidencePublicationError();
  }
  const hasLivePass = body.qualification?.provider === "pass"
    || body.qualification?.installedHost === "pass";
  if (hasLivePass || Object.hasOwn(body, "liveQualificationReceipts")) {
    throw invalidEvidencePublicationError();
  }
  return body;
}

function writeEvidenceRecordInternal(record, root, authority = null, validationOptions = {}) {
  // Publication validation is deliberately complete before ensureEvidenceDirectory
  // can create even the evidence root. Invalid/private caller data leaves no files.
  const body = prepareEvidenceRecordForPublication(record, authority, validationOptions);
  const phase = body.phase;
  const declaredSourceDigest = body.source?.sourceInventoryDigest;
  const sourceDigest = declaredSourceDigest == null ? body.recordDigest : declaredSourceDigest;
  if (typeof sourceDigest !== "string"
    || typeof body.recordDigest !== "string"
    || !SHA256.test(sourceDigest)
    || !SHA256.test(body.recordDigest)) {
    throw invalidEvidencePublicationError();
  }
  const dir = path.join(root, EVIDENCE_ROOT, phase === "aggregate" ? "aggregate" : `phase-${phase}`);
  const file = path.join(
    dir,
    `${sourceDigest.slice(0, 16)}-${body.recordDigest.slice(0, 12)}.json`
  );
  const relativeFile = path.relative(root, file).split(path.sep).join("/");
  const serialized = `${JSON.stringify(body, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_EVIDENCE_RECORD_BYTES) {
    throw invalidEvidencePublicationError();
  }
  ensureEvidenceDirectory(root, dir);
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

function reviewPromotionCommitUnknown(commitState, recordDigest = null) {
  const error = fixedEvidenceError(
    "E_REVIEW_PROMOTION_COMMIT_UNKNOWN",
    "Review promotion requires protected recovery."
  );
  error.commitState = commitState;
  error.recoveryRequired = true;
  if (SHA256.test(recordDigest || "")) error.recordDigest = recordDigest;
  return error;
}

function classifyReviewPromotionState(root, {
  expectedPublished,
  original,
  recordDigest,
  replayReviewTrust
}) {
  try {
    const current = loadLedgerDocument(root);
    if (current.expected.contents === expectedPublished) {
      const currentPhaseOne = current.ledger.entries.find((entry) => (
        entry.phase === "1"
        && entry.currency === "current"
        && entry.recordDigest === recordDigest
      ));
      if (!currentPhaseOne) return "unknown";
      const replay = verifyLedger(root, {
        strict: true,
        signedReviewAuthority: SIGNED_REVIEW_VALIDATION_AUTHORITY,
        signedReviewTrust: replayReviewTrust
      });
      return replay.ok ? "committed" : "unknown";
    }
    if (current.expected.contents === original.expected.contents) {
      return "restored";
    }
  } catch {
    // The bounded exact re-read could not establish either durable state.
  }
  return "unknown";
}

function prepareSignedReviewPromotion(options, authority) {
  if (authority !== REVIEW_PROMOTION_PUBLICATION_AUTHORITY
    || !options
    || typeof options !== "object"
    || Array.isArray(options)
    || unexpectedFields(
      options,
      new Set(["root", "requestPath", "attestationPath", "trust", "now"])
    ).length) {
    throw fixedEvidenceError("E_REVIEW_PROMOTION_FORBIDDEN", "Protected review promotion is unavailable.");
  }
  const {
    root = REPO_ROOT,
    requestPath,
    attestationPath,
    trust,
    now = new Date().toISOString()
  } = options;
  if (typeof root !== "string"
    || !root
    || !isCanonicalIsoDateTime(now)
    || !normalizedReviewArtifactPath(
      requestPath,
      REVIEW_REQUEST_ROOT,
      new RegExp(`^${REVIEW_REQUEST_ROOT}/[0-9a-f]{16}-[0-9a-f]{16}\\.json$`)
    )
    || !normalizedReviewArtifactPath(
      attestationPath,
      REVIEW_ATTESTATION_ROOT,
      new RegExp(`^${REVIEW_ATTESTATION_ROOT}/[0-9a-f]{16}-[0-9a-f]{16}\\.json$`)
    )
    || !trust
    || typeof trust !== "object"
    || Array.isArray(trust)
    || typeof trust.expectedIssuer !== "string"
    || trust.expectedIssuer.length < 1
    || !trust.publicKey) {
    throw fixedEvidenceError("E_REVIEW_PROMOTION_FORBIDDEN", "Protected review promotion inputs are invalid.");
  }
  const signedReviewTrust = Object.freeze({
    publicKey: trust.publicKey,
    expectedIssuer: trust.expectedIssuer,
    revokedKeyFingerprints: [...(trust.revokedKeyFingerprints || [])],
    now
  });
  const promotionReviewTrust = Object.freeze({
    ...signedReviewTrust,
    requireFresh: true
  });
  const replayReviewTrust = Object.freeze({
    ...signedReviewTrust,
    requireFresh: false
  });
  return {
    root,
    requestPath,
    attestationPath,
    now,
    signedReviewTrust,
    promotionReviewTrust,
    replayReviewTrust
  };
}

function promotePhaseOneSignedReviewInternal(options = {}, authority = null) {
  const {
    root,
    requestPath,
    attestationPath,
    now,
    signedReviewTrust,
    promotionReviewTrust,
    replayReviewTrust
  } = prepareSignedReviewPromotion(options, authority);
  let promotionResult = null;
  let rollback = null;

  try {
    withEvidenceLedgerLock(root, () => {
    let loaded;
    try {
      loaded = loadLedgerDocument(root);
    } catch {
      throw invalidLedgerDocumentError();
    }
    if (!ledgerDocumentShapeIsValid(loaded.ledger)) throw invalidLedgerDocumentError();
    const inspected = loaded.ledger.entries.map((entry) => ({
      entry: cloneLedgerEntry(entry),
      record: loadCanonicalCutoverRecord(entry, root)
    }));
    const currentPhaseZero = inspected.find(({ entry }) => (
      entry.currency === "current" && entry.phase === "0"
    ));
    const currentPhaseOne = inspected.find(({ entry }) => (
      entry.currency === "current" && entry.phase === "1"
    ));
    if (!currentPhaseZero || !currentPhaseOne
      || currentPhaseZero.record.status !== "verified_on_draft") {
      throw fixedEvidenceError("E_REVIEW_PROMOTION_INVALID", "Current Phase 0/1 proof chain is unavailable.");
    }

    if (currentPhaseOne.record.status === "verified_on_draft") {
      const receipt = currentPhaseOne.record.independentReviewReceipt;
      const validation = validateEvidenceRecord(currentPhaseOne.record, {
        strict: true,
        root,
        requireEvidenceSystem: true,
        signedReviewAuthority: SIGNED_REVIEW_VALIDATION_AUTHORITY,
        signedReviewTrust: replayReviewTrust
      });
      const strictLedgerReplay = verifyLedger(root, {
        strict: true,
        signedReviewAuthority: SIGNED_REVIEW_VALIDATION_AUTHORITY,
        signedReviewTrust: replayReviewTrust
      });
      if (!validation.ok
        || !strictLedgerReplay.ok
        || receipt?.reviewRequest?.path !== requestPath
        || receipt?.attestation?.path !== attestationPath) {
        throw fixedEvidenceError("E_REVIEW_PROMOTION_CONFLICT", "A different Phase 1 promotion is already current.");
      }
      promotionResult = Object.freeze({
        ok: true,
        converged: true,
        path: currentPhaseOne.entry.path,
        recordDigest: currentPhaseOne.record.recordDigest
      });
      return;
    }
    if (currentPhaseOne.record.status !== "implemented_unverified"
      || currentPhaseOne.record.proofProducer?.id !== PROOF_PRODUCER_ID
      || currentPhaseOne.record.proofProducer?.version !== PROOF_PRODUCER_VERSION) {
      throw fixedEvidenceError("E_REVIEW_PROMOTION_INVALID", "Current Phase 1 is not an unverified proof record.");
    }

    let requestSnapshot;
    let attestationSnapshot;
    let request;
    let attestation;
    try {
      requestSnapshot = readBoundedEvidenceFileSnapshot(
        root,
        path.join(root, ...requestPath.split("/"))
      );
      attestationSnapshot = readBoundedEvidenceFileSnapshot(
        root,
        path.join(root, ...attestationPath.split("/"))
      );
      request = JSON.parse(requestSnapshot.contents);
      attestation = JSON.parse(attestationSnapshot.contents);
    } catch {
      throw fixedEvidenceError("E_REVIEW_PROMOTION_INVALID", "Review artifacts are unreadable or unsafe.");
    }
    if (reviewRequestRelativePath(request) !== requestPath
      || reviewAttestationRelativePath(attestation) !== attestationPath
      || request.proof.path !== currentPhaseOne.entry.path
      || request.proof.recordDigest !== currentPhaseOne.record.recordDigest
      || request.prerequisite.path !== currentPhaseZero.entry.path
      || request.prerequisite.recordDigest !== currentPhaseZero.record.recordDigest) {
      throw fixedEvidenceError("E_REVIEW_PROMOTION_INVALID", "Review artifacts do not bind the current proof chain.");
    }
    const requestValidation = validatePhaseOneReviewRequest(request, {
      root,
      now,
      requireFresh: true,
      requireCurrentProof: true
    });
    const attestationValidation = validateIndependentReviewAttestation(attestation, {
      request,
      requestPath,
      publicKey: signedReviewTrust.publicKey,
      expectedIssuer: signedReviewTrust.expectedIssuer,
      revokedKeyFingerprints: signedReviewTrust.revokedKeyFingerprints,
      now
    });
    if (!requestValidation.ok || !attestationValidation.ok) {
      throw fixedEvidenceError("E_REVIEW_PROMOTION_INVALID", "Review request or attestation verification failed.");
    }

    const receipt = attachIndependentReviewReceiptDigest({
      schemaVersion: SIGNED_REVIEW_RECEIPT_SCHEMA_VERSION,
      producerId: SIGNED_REVIEW_RECEIPT_PRODUCER_ID,
      producerVersion: SIGNED_REVIEW_RECEIPT_PRODUCER_VERSION,
      reviewRequest: {
        path: requestPath,
        digest: request.requestDigest
      },
      attestation: {
        path: attestationPath,
        digest: attestation.attestationDigest
      },
      issuer: attestation.issuer,
      keyFingerprint: attestation.keyFingerprint
    });
    const promoted = attachRecordDigest({
      ...structuredClone(currentPhaseOne.record),
      status: "verified_on_draft",
      recordedAt: attestation.endedAt,
      independentReviewReceipt: receipt,
      authorities: {
        ...structuredClone(currentPhaseOne.record.authorities),
        independentValidation: "pass"
      }
    });
    const promotedValidationOptions = {
      strict: true,
      root,
      requireEvidenceSystem: true,
      signedReviewAuthority: SIGNED_REVIEW_VALIDATION_AUTHORITY,
      signedReviewTrust: promotionReviewTrust
    };
    const promotedValidation = validateEvidenceRecord(promoted, promotedValidationOptions);
    if (!promotedValidation.ok) {
      throw fixedEvidenceError("E_REVIEW_PROMOTION_INVALID", "Promoted Phase 1 record is invalid.");
    }

    const originalBefore = readBoundedEvidenceFileSnapshot(
      root,
      path.join(root, ...currentPhaseOne.entry.path.split("/"))
    );
    const relative = writeEvidenceRecordInternal(
      promoted,
      root,
      REVIEW_PROMOTION_PUBLICATION_AUTHORITY,
      promotedValidationOptions
    );
    const lockedRequest = readBoundedEvidenceFileSnapshot(
      root,
      path.join(root, ...requestPath.split("/"))
    );
    const lockedAttestation = readBoundedEvidenceFileSnapshot(
      root,
      path.join(root, ...attestationPath.split("/"))
    );
    const originalAfter = readBoundedEvidenceFileSnapshot(
      root,
      path.join(root, ...currentPhaseOne.entry.path.split("/"))
    );
    if (requestSnapshot.contents !== lockedRequest.contents
      || attestationSnapshot.contents !== lockedAttestation.contents
      || originalBefore.contents !== originalAfter.contents
      || !sameFileSnapshot(requestSnapshot.fileSnapshot, lockedRequest.fileSnapshot)
      || !sameFileSnapshot(attestationSnapshot.fileSnapshot, lockedAttestation.fileSnapshot)
      || !sameFileSnapshot(originalBefore.fileSnapshot, originalAfter.fileSnapshot)) {
      throw fixedEvidenceError("E_REVIEW_PROMOTION_RACE", "Review artifacts changed during promotion.");
    }
    const finalRequestValidation = validatePhaseOneReviewRequest(request, {
      root,
      now,
      requireFresh: true,
      requireCurrentProof: true
    });
    if (!finalRequestValidation.ok) {
      throw fixedEvidenceError("E_REVIEW_PROMOTION_RACE", "Review source or prerequisite changed during promotion.");
    }

    const entries = inspected.map(({ entry }) => (
      supersedeCurrentProofChainEntry(entry, "1")
    ));
    entries.push({
      phase: promoted.phase,
      slice: promoted.slice,
      status: promoted.status,
      path: relative,
      recordDigest: promoted.recordDigest,
      sourceCommit: promoted.source.headCommit,
      currency: "current",
      recordedAt: promoted.recordedAt
    });
    const next = {
      schemaVersion: 1,
      roadmapVersion: ROADMAP_VERSION,
      issue: ISSUE_URL,
      updatedAt: new Date().toISOString(),
      entries
    };
    if (!ledgerDocumentShapeIsValid(next)) throw invalidLedgerUpdateError();
    const ledgerFile = path.join(root, EVIDENCE_ROOT, "ledger.json");
    const serializedNext = `${JSON.stringify(next, null, 2)}\n`;
    rollback = { expectedPublished: serializedNext, original: loaded };
    try {
      atomicReplaceEvidenceFile(root, ledgerFile, serializedNext, loaded.expected);
    } catch (error) {
      const commitState = error?.[ATOMIC_REPLACE_COMMIT_STATE] || "unknown";
      if (commitState === "not_committed") {
        rollback = null;
        throw fixedEvidenceError(
          "E_REVIEW_PROMOTION_RACE",
          "Review promotion ledger cutover did not commit."
        );
      }
      if (commitState === "committed") {
        const committedReplay = verifyLedger(root, {
          strict: true,
          signedReviewAuthority: SIGNED_REVIEW_VALIDATION_AUTHORITY,
          signedReviewTrust: replayReviewTrust
        });
        if (committedReplay.ok) {
          promotionResult = Object.freeze({
            ok: true,
            converged: false,
            path: relative,
            recordDigest: promoted.recordDigest
          });
          throw reviewPromotionCommitUnknown("committed", promoted.recordDigest);
        }
        restoreLedgerAfterFailedReviewPromotion(root, serializedNext, loaded);
        const recoveredState = classifyReviewPromotionState(root, {
          expectedPublished: serializedNext,
          original: loaded,
          recordDigest: promoted.recordDigest,
          replayReviewTrust
        });
        rollback = null;
        throw reviewPromotionCommitUnknown(recoveredState, promoted.recordDigest);
      }
      throw reviewPromotionCommitUnknown("unknown", promoted.recordDigest);
    }
    const replay = verifyLedger(root, {
      strict: true,
      signedReviewAuthority: SIGNED_REVIEW_VALIDATION_AUTHORITY,
      signedReviewTrust: replayReviewTrust
    });
    const requestAfterCutover = validatePhaseOneReviewRequest(request, {
      root,
      now,
      requireFresh: true,
      requireCurrentProof: false
    });
    if (!replay.ok || !requestAfterCutover.ok) {
      restoreLedgerAfterFailedReviewPromotion(root, serializedNext, loaded);
      const recoveredState = classifyReviewPromotionState(root, {
        expectedPublished: serializedNext,
        original: loaded,
        recordDigest: promoted.recordDigest,
        replayReviewTrust
      });
      rollback = null;
      throw reviewPromotionCommitUnknown(recoveredState, promoted.recordDigest);
    }
    promotionResult = Object.freeze({
      ok: true,
      converged: false,
      path: relative,
      recordDigest: promoted.recordDigest
    });
    });
  } catch (error) {
    const releaseFailed = Boolean(
      error?.[LEDGER_LOCK_ACTION_COMPLETED]
      || error?.[LEDGER_LOCK_RELEASE_FAILURE]
    );
    if (releaseFailed && promotionResult) {
      let state = "unknown";
      if (rollback) {
        state = classifyReviewPromotionState(root, {
          expectedPublished: rollback.expectedPublished,
          original: rollback.original,
          recordDigest: promotionResult.recordDigest,
          replayReviewTrust
        });
      } else {
        try {
          const replay = verifyLedger(root, {
            strict: true,
            signedReviewAuthority: SIGNED_REVIEW_VALIDATION_AUTHORITY,
            signedReviewTrust: replayReviewTrust
          });
          if (replay.ok) state = "committed";
        } catch {}
      }
      state = `${state}_lock_unclean`;
      throw reviewPromotionCommitUnknown(state, promotionResult.recordDigest);
    }
    throw error;
  }

  if (!promotionResult) {
    throw fixedEvidenceError("E_REVIEW_PROMOTION_INVALID", "Review promotion did not complete.");
  }
  const replayAfterRelease = verifyLedger(root, {
    strict: true,
    signedReviewAuthority: SIGNED_REVIEW_VALIDATION_AUTHORITY,
    signedReviewTrust: replayReviewTrust
  });
  if (!replayAfterRelease.ok) {
    let recoveredState = "unknown";
    if (rollback) {
      try {
        withEvidenceLedgerLock(root, () => {
          restoreLedgerAfterFailedReviewPromotion(
            root,
            rollback.expectedPublished,
            rollback.original
          );
        });
      } catch {}
      recoveredState = classifyReviewPromotionState(root, {
        expectedPublished: rollback.expectedPublished,
        original: rollback.original,
        recordDigest: promotionResult.recordDigest,
        replayReviewTrust
      });
    }
    throw reviewPromotionCommitUnknown(
      recoveredState,
      promotionResult.recordDigest
    );
  }
  return promotionResult;
}

function importPhaseOneReviewAttestationInternal(options = {}, authority = null) {
  if (authority !== REVIEW_PROMOTION_PUBLICATION_AUTHORITY
    || !options
    || typeof options !== "object"
    || Array.isArray(options)
    || unexpectedFields(
      options,
      new Set(["root", "requestPath", "attestation", "trust", "now"])
    ).length) {
    throw fixedEvidenceError(
      "E_REVIEW_PROMOTION_FORBIDDEN",
      "Protected review attestation import is unavailable."
    );
  }
  const {
    root,
    requestPath,
    attestation: suppliedAttestation,
    trust,
    now
  } = options;
  if (typeof root !== "string"
    || !root
    || !isCanonicalIsoDateTime(now)
    || !normalizedReviewArtifactPath(
      requestPath,
      REVIEW_REQUEST_ROOT,
      new RegExp(`^${REVIEW_REQUEST_ROOT}/[0-9a-f]{16}-[0-9a-f]{16}\\.json$`)
    )
    || !trust
    || typeof trust !== "object"
    || Array.isArray(trust)
    || !trust.publicKey
    || typeof trust.expectedIssuer !== "string"
    || !Array.isArray(trust.revokedKeyFingerprints)
    || !rawEvidenceValueIsSafe(suppliedAttestation, "$reviewAttestation")) {
    throw fixedEvidenceError(
      "E_REVIEW_ATTESTATION_INVALID",
      "Protected review attestation import is invalid."
    );
  }
  let attestation;
  let request;
  try {
    attestation = structuredClone(suppliedAttestation);
    request = JSON.parse(readBoundedEvidenceFile(
      root,
      path.join(root, ...requestPath.split("/"))
    ));
  } catch {
    throw fixedEvidenceError(
      "E_REVIEW_ATTESTATION_INVALID",
      "Protected review attestation import is unreadable."
    );
  }
  if (reviewRequestRelativePath(request) !== requestPath) {
    throw fixedEvidenceError(
      "E_REVIEW_REQUEST_INVALID",
      "Protected review request path is invalid."
    );
  }
  const attestationValidation = validateIndependentReviewAttestation(attestation, {
    request,
    requestPath,
    publicKey: trust.publicKey,
    expectedIssuer: trust.expectedIssuer,
    revokedKeyFingerprints: trust.revokedKeyFingerprints,
    now,
    requireFreshRequest: false
  });
  if (!attestationValidation.ok) {
    throw fixedEvidenceError(
      "E_REVIEW_ATTESTATION_INVALID",
      "Protected review attestation does not match the signed request."
    );
  }
  const relative = reviewAttestationRelativePath(attestation);
  if (!normalizedReviewArtifactPath(
    relative,
    REVIEW_ATTESTATION_ROOT,
    new RegExp(`^${REVIEW_ATTESTATION_ROOT}/[0-9a-f]{16}-[0-9a-f]{16}\\.json$`)
  )) {
    throw fixedEvidenceError(
      "E_REVIEW_ATTESTATION_INVALID",
      "Protected review attestation path is invalid."
    );
  }
  const serialized = `${JSON.stringify(attestation, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_EVIDENCE_RECORD_BYTES) {
    throw fixedEvidenceError(
      "E_REVIEW_ATTESTATION_INVALID",
      "Protected review attestation exceeds its bound."
    );
  }
  const absolute = path.join(root, ...relative.split("/"));
  let existing = null;
  try {
    existing = readBoundedEvidenceFile(root, absolute);
  } catch {}
  if (existing !== null) {
    const replayRequestValidation = validatePhaseOneReviewRequest(request, {
      root,
      now,
      requireFresh: false,
      requireCurrentProof: false,
      allowEvidenceOnlyIdentityDrift: true
    });
    if (existing !== serialized || !replayRequestValidation.ok) {
      throw fixedEvidenceError(
        "E_REVIEW_ATTESTATION_INVALID",
        "Immutable review attestation replay is invalid."
      );
    }
    return relative;
  }
  let absent = false;
  try {
    absent = evidencePathIsStablyAbsent(root, absolute);
  } catch {}
  if (!absent) {
    throw fixedEvidenceError(
      "E_REVIEW_ATTESTATION_INVALID",
      "Immutable review attestation destination is unsafe."
    );
  }
  const requestValidation = validatePhaseOneReviewRequest(request, {
    root,
    now,
    requireFresh: true,
    requireCurrentProof: true
  });
  if (!requestValidation.ok) {
    throw fixedEvidenceError(
      "E_REVIEW_ATTESTATION_INVALID",
      "Protected review request is not current for attestation admission."
    );
  }
  try {
    ensureEvidenceDirectory(root, path.dirname(absolute));
    publishImmutableEvidenceFile(root, absolute, serialized);
  } catch (error) {
    if (error?.code === "EEXIST") {
      try {
        if (readBoundedEvidenceFile(root, absolute) === serialized) return relative;
      } catch {}
    }
    throw fixedEvidenceError(
      "E_REVIEW_ATTESTATION_INVALID",
      "Immutable review attestation publication failed."
    );
  }
  return relative;
}

function promotePhaseOneFromProtectedRuntime(options = {}) {
  if (!options
    || typeof options !== "object"
    || Array.isArray(options)
    || unexpectedFields(
      options,
      new Set(["workspace", "requestPath", "attestation"])
    ).length) {
    throw protectedReviewTrustError();
  }
  const protectedTrust = loadProtectedReviewTrust();
  const root = protectedWorkspaceRoot(options.workspace, protectedTrust.runtimeRoot);
  const now = new Date().toISOString();
  const trust = {
    publicKey: protectedTrust.publicKey,
    expectedIssuer: protectedTrust.expectedIssuer,
    revokedKeyFingerprints: protectedTrust.revokedKeyFingerprints
  };
  return withProtectedReviewGitBinding(protectedTrust.gitBinding, () => {
    assertProtectedWorkspaceGitConfiguration(root);
    const attestationPath = importPhaseOneReviewAttestationInternal({
      root,
      requestPath: options.requestPath,
      attestation: options.attestation,
      trust,
      now
    }, REVIEW_PROMOTION_PUBLICATION_AUTHORITY);
    return promotePhaseOneSignedReviewInternal({
      root,
      requestPath: options.requestPath,
      attestationPath,
      now,
      trust
    }, REVIEW_PROMOTION_PUBLICATION_AUTHORITY);
  });
}

function verifySignedLedgerFromProtectedRuntime(options = {}) {
  if (!options
    || typeof options !== "object"
    || Array.isArray(options)
    || unexpectedFields(options, new Set(["workspace"])).length) {
    throw protectedReviewTrustError();
  }
  const protectedTrust = loadProtectedReviewTrust();
  const root = protectedWorkspaceRoot(options.workspace, protectedTrust.runtimeRoot);
  return withProtectedReviewGitBinding(protectedTrust.gitBinding, () => {
    assertProtectedWorkspaceGitConfiguration(root);
    return verifyLedger(root, {
      strict: true,
      signedReviewAuthority: SIGNED_REVIEW_VALIDATION_AUTHORITY,
      signedReviewTrust: {
        publicKey: protectedTrust.publicKey,
        expectedIssuer: protectedTrust.expectedIssuer,
        revokedKeyFingerprints: protectedTrust.revokedKeyFingerprints,
        now: new Date().toISOString(),
        requireFresh: false
      }
    });
  });
}

function protectedSignedReviewReplayTrust(protectedTrust) {
  return Object.freeze({
    publicKey: protectedTrust.publicKey,
    expectedIssuer: protectedTrust.expectedIssuer,
    revokedKeyFingerprints: protectedTrust.revokedKeyFingerprints,
    now: new Date().toISOString(),
    requireFresh: false
  });
}

function provePhaseTwoFromProtectedRuntime(options = {}) {
  if (!options
    || typeof options !== "object"
    || Array.isArray(options)
    || unexpectedFields(options, new Set(["workspace"])).length) {
    throw protectedReviewTrustError();
  }
  const protectedTrust = loadProtectedReviewTrust();
  const root = protectedWorkspaceRoot(options.workspace, protectedTrust.runtimeRoot);
  return withProtectedReviewGitBinding(protectedTrust.gitBinding, () => {
    assertProtectedWorkspaceGitConfiguration(root);
    const signedReviewTrust = protectedSignedReviewReplayTrust(protectedTrust);
    let proofContext;
    try {
      proofContext = createProofExecutionContext();
    } catch (error) {
      return proofFailureForError(error, PROOF_TOOLCHAIN_ERROR);
    }
    let result;
    try {
      result = proveWorkerBrokerPhaseWithContext({
        phase: "2",
        slice: PHASE_TWO_SLICE,
        root,
        write: true
      }, proofContext, signedReviewTrust);
    } catch (error) {
      result = proofFailureForError(error, "E_PROOF_SOURCE");
    }
    let cleaned;
    try {
      cleaned = proofContext.cleanup();
    } catch {
      cleaned = { ok: false };
    }
    if (!cleaned?.ok) return proofFailure("E_PROOF_CLEANUP");
    return result;
  });
}

function verifyPhaseTwoFromProtectedRuntime(options = {}) {
  if (!options
    || typeof options !== "object"
    || Array.isArray(options)
    || unexpectedFields(options, new Set(["workspace"])).length) {
    throw protectedReviewTrustError();
  }
  const protectedTrust = loadProtectedReviewTrust();
  const root = protectedWorkspaceRoot(options.workspace, protectedTrust.runtimeRoot);
  return withProtectedReviewGitBinding(protectedTrust.gitBinding, () => {
    assertProtectedWorkspaceGitConfiguration(root);
    const signedReviewTrust = protectedSignedReviewReplayTrust(protectedTrust);
    const result = verifyPhase("2", root, {
      strict: true,
      requireVerified: true,
      signedReviewAuthority: SIGNED_REVIEW_VALIDATION_AUTHORITY,
      signedReviewTrust
    });
    if (!result.ok || result.slice === PHASE_TWO_SLICE) return result;
    const error = `Protected Phase 2 verification requires slice ${PHASE_TWO_SLICE}.`;
    return {
      ...result,
      ok: false,
      integrityOk: false,
      errors: [...result.errors, error],
      readinessReady: false,
      verified: false
    };
  });
}

function provePhaseThreeFromProtectedRuntime(options = {}) {
  if (!options
    || typeof options !== "object"
    || Array.isArray(options)
    || unexpectedFields(options, new Set(["workspace"])).length) {
    throw protectedReviewTrustError();
  }
  const protectedTrust = loadProtectedReviewTrust();
  const root = protectedWorkspaceRoot(options.workspace, protectedTrust.runtimeRoot);
  return withProtectedReviewGitBinding(protectedTrust.gitBinding, () => {
    assertProtectedWorkspaceGitConfiguration(root);
    const signedReviewTrust = protectedSignedReviewReplayTrust(protectedTrust);
    let proofContext;
    try {
      proofContext = createProofExecutionContext();
    } catch (error) {
      return proofFailureForError(error, PROOF_TOOLCHAIN_ERROR);
    }
    let result;
    try {
      result = proveWorkerBrokerPhaseWithContext({
        phase: "3",
        slice: PHASE_THREE_SLICE,
        root,
        write: true
      }, proofContext, signedReviewTrust);
    } catch (error) {
      result = proofFailureForError(error, "E_PROOF_SOURCE");
    }
    let cleaned;
    try {
      cleaned = proofContext.cleanup();
    } catch {
      cleaned = { ok: false };
    }
    if (!cleaned?.ok) return proofFailure("E_PROOF_CLEANUP");
    return result;
  });
}

function verifyPhaseThreeFromProtectedRuntime(options = {}) {
  if (!options
    || typeof options !== "object"
    || Array.isArray(options)
    || unexpectedFields(options, new Set(["workspace"])).length) {
    throw protectedReviewTrustError();
  }
  const protectedTrust = loadProtectedReviewTrust();
  const root = protectedWorkspaceRoot(options.workspace, protectedTrust.runtimeRoot);
  return withProtectedReviewGitBinding(protectedTrust.gitBinding, () => {
    assertProtectedWorkspaceGitConfiguration(root);
    const signedReviewTrust = protectedSignedReviewReplayTrust(protectedTrust);
    const result = verifyPhase("3", root, {
      strict: true,
      requireVerified: true,
      signedReviewAuthority: SIGNED_REVIEW_VALIDATION_AUTHORITY,
      signedReviewTrust
    });
    if (!result.ok || result.slice === PHASE_THREE_SLICE) return result;
    const error = `Protected Phase 3 verification requires slice ${PHASE_THREE_SLICE}.`;
    return {
      ...result,
      ok: false,
      integrityOk: false,
      errors: [...result.errors, error],
      readinessReady: false,
      verified: false
    };
  });
}

function proofSignedReviewOptions(root, signedReviewTrust = null) {
  const options = {
    strict: true,
    root,
    requireEvidenceSystem: true
  };
  if (signedReviewTrust) {
    options.signedReviewAuthority = SIGNED_REVIEW_VALIDATION_AUTHORITY;
    options.signedReviewTrust = signedReviewTrust;
  }
  return options;
}

function proofLedgerOptions(signedReviewTrust = null) {
  const options = { strict: true };
  if (signedReviewTrust) {
    options.signedReviewAuthority = SIGNED_REVIEW_VALIDATION_AUTHORITY;
    options.signedReviewTrust = signedReviewTrust;
  }
  return options;
}

function prerequisiteSnapshotFromInspected(
  phase,
  inspected,
  root,
  signedReviewTrust = null
) {
  const snapshots = [];
  for (const prerequisitePhase of PHASE_PREREQUISITES[String(phase)] || []) {
    const candidates = inspected.filter(({ entry }) => (
      entry.currency === "current" && entry.phase === prerequisitePhase
    ));
    if (candidates.length !== 1) return null;
    const { record } = candidates[0];
    const validation = validateEvidenceRecord(
      record,
      proofSignedReviewOptions(root, signedReviewTrust)
    );
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

function captureProofPrerequisites(phase, root, signedReviewTrust = null) {
  const expected = PHASE_PREREQUISITES[String(phase)] || [];
  if (expected.length === 0) return [];
  const strict = verifyLedger(root, proofLedgerOptions(signedReviewTrust));
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
  return prerequisiteSnapshotFromInspected(
    phase,
    inspected,
    root,
    signedReviewTrust
  );
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
    && (
      currentVersion
      || producer.manifestDigest
        === PRIOR_PROOF_MANIFEST_DIGESTS[version]?.[phase]
    )
  );
  if (!shapeIsSupported) return false;
  let normalized;
  try {
    normalized = structuredClone(record);
    if (!currentVersion) {
      normalized.proofProducer.version = PROOF_PRODUCER_VERSION;
      normalized.proofProducer.manifestDigest =
        computeProofManifestDigest(phase);
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

function publishPhaseZeroProofRecord(record, root, expectedSource, toolchain) {
  if (record?.phase !== "0" || record?.status !== "verified_on_draft") {
    throw invalidEvidencePublicationError();
  }
  const validation = validateEvidenceRecord(record, {
    strict: true,
    root,
    requireEvidenceSystem: true
  });
  if (!validation.ok) throw invalidEvidencePublicationError();
  const immediatelyBeforeRecord = captureProofSourceSnapshot("0", root, toolchain);
  if (!sameProofSourceSnapshot(expectedSource, immediatelyBeforeRecord)
    || !proofRecordMatchesSnapshot(record, expectedSource)) {
    throw invalidEvidencePublicationError();
  }

  const relative = writeEvidenceRecordInternal(record, root, PROOF_PUBLICATION_AUTHORITY);
  withEvidenceLedgerLock(root, () => {
    const immediatelyBeforeLedger = captureProofSourceSnapshot("0", root, toolchain);
    if (!sameProofSourceSnapshot(expectedSource, immediatelyBeforeLedger)
      || !proofRecordMatchesSnapshot(record, expectedSource)) {
      throw invalidEvidencePublicationError();
    }

    let loaded;
    try {
      loaded = loadLedgerDocument(root);
    } catch {
      throw invalidLedgerDocumentError();
    }
    if (!ledgerDocumentShapeIsValid(loaded.ledger)) throw invalidLedgerDocumentError();

    const inspected = loaded.ledger.entries.map((entry) => ({
      entry: cloneLedgerEntry(entry),
      record: loadCanonicalCutoverRecord(entry, root)
    }));
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

    let published;
    try {
      published = loadLedgerDocument(root);
    } catch {
      throw invalidLedgerDocumentError();
    }
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

function publishDependentPhaseProofRecord(
  record,
  root,
  expectedSource,
  expectedPrerequisites,
  toolchain,
  signedReviewTrust = null
) {
  const phase = String(record?.phase ?? "");
  const expectedStatus = new Set(["2", "3"]).has(phase) && signedReviewTrust
    ? "verified_on_draft"
    : "implemented_unverified";
  if (phase === "0"
    || !PHASE_PROOF_GATE_MANIFEST[phase]
    || record?.status !== expectedStatus
    || !proofRecordMatchesPrerequisites(record, expectedPrerequisites)) {
    throw invalidEvidencePublicationError();
  }
  const validationOptions = proofSignedReviewOptions(root, signedReviewTrust);
  const validation = validateEvidenceRecord(record, validationOptions);
  if (!validation.ok) throw invalidEvidencePublicationError();
  const immediatelyBeforeRecord = captureProofSourceSnapshot(phase, root, toolchain);
  const immediatelyBeforePrerequisites = captureProofPrerequisites(
    phase,
    root,
    signedReviewTrust
  );
  if (!sameProofSourceSnapshot(expectedSource, immediatelyBeforeRecord)
    || !sameProofPrerequisites(expectedPrerequisites, immediatelyBeforePrerequisites)
    || !proofRecordMatchesSnapshot(record, expectedSource)) {
    throw invalidEvidencePublicationError();
  }

  const relative = writeEvidenceRecordInternal(
    record,
    root,
    PROOF_PUBLICATION_AUTHORITY,
    validationOptions
  );
  withEvidenceLedgerLock(root, () => {
    const immediatelyBeforeLedger = captureProofSourceSnapshot(phase, root, toolchain);
    if (!sameProofSourceSnapshot(expectedSource, immediatelyBeforeLedger)
      || !proofRecordMatchesSnapshot(record, expectedSource)) {
      throw invalidEvidencePublicationError();
    }

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
    const lockedPrerequisites = prerequisiteSnapshotFromInspected(
      phase,
      inspected,
      root,
      signedReviewTrust
    );
    if (!sameProofPrerequisites(expectedPrerequisites, lockedPrerequisites)) {
      throw invalidLedgerDocumentError();
    }

    const entries = inspected.map(({ entry }) => (
      supersedeCurrentProofChainEntry(entry, phase)
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

    let published;
    try {
      published = loadLedgerDocument(root);
    } catch {
      throw invalidLedgerDocumentError();
    }
    if (published.expected.contents !== serializedNext) throw invalidLedgerDocumentError();
    let afterLedger;
    let afterStrict;
    let afterPrerequisites;
    let finalInsideLock;
    try {
      afterLedger = captureProofSourceSnapshot(phase, root, toolchain);
      afterStrict = verifyLedger(root, proofLedgerOptions(signedReviewTrust));
      afterPrerequisites = captureProofPrerequisites(
        phase,
        root,
        signedReviewTrust
      );
      finalInsideLock = captureProofSourceSnapshot(phase, root, toolchain);
    } catch {
      afterStrict = { ok: false };
    }
    if (!sameProofSourceSnapshot(expectedSource, afterLedger)
      || !afterStrict.ok
      || !sameProofPrerequisites(expectedPrerequisites, afterPrerequisites)
      || !sameProofSourceSnapshot(expectedSource, finalInsideLock)) {
      invalidateAllCurrentLedgerEntriesUnderLock(root, published);
      throw invalidEvidencePublicationError();
    }
  });

  let afterRelease;
  let strictAfterRelease;
  let prerequisitesAfterRelease;
  let finalAfterRelease;
  try {
    afterRelease = captureProofSourceSnapshot(phase, root, toolchain);
    strictAfterRelease = verifyLedger(root, proofLedgerOptions(signedReviewTrust));
    prerequisitesAfterRelease = captureProofPrerequisites(
      phase,
      root,
      signedReviewTrust
    );
    finalAfterRelease = captureProofSourceSnapshot(phase, root, toolchain);
  } catch {
    strictAfterRelease = { ok: false };
  }
  if (!sameProofSourceSnapshot(expectedSource, afterRelease)
    || !strictAfterRelease.ok
    || !sameProofPrerequisites(expectedPrerequisites, prerequisitesAfterRelease)
    || !sameProofSourceSnapshot(expectedSource, finalAfterRelease)) {
    invalidateAllCurrentLedgerEntries(root);
    throw invalidEvidencePublicationError();
  }
  return relative;
}

const PROTECTED_OPERATION_CHILD_MARKER =
  "worker-broker-review-operation-v1";

const PROTECTED_OPERATION_ENVIRONMENT = Object.freeze({
  GROK_PROTECTED_OPERATION_CHILD: PROTECTED_OPERATION_CHILD_MARKER,
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin",
  TZ: "UTC"
});

const PROTECTED_OPERATION_MAX_STDIN_BYTES = 256 * 1024;

function parseProtectedOperationArguments(argv) {
  const mode = argv[0];
  const allowed = mode === "promote"
    ? new Set(["--workspace", "--request"])
    : new Set([
      "verify",
      "prove-phase-2",
      "verify-phase-2",
      "prove-phase-3",
      "verify-phase-3"
    ]).has(mode)
      ? new Set(["--workspace"])
      : null;
  if (!allowed || argv.length !== 1 + allowed.size * 2) {
    throw protectedReviewTrustError();
  }
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag)
      || Object.hasOwn(values, flag)
      || typeof value !== "string"
      || !value
      || value.startsWith("--")) {
      throw protectedReviewTrustError();
    }
    values[flag] = value;
  }
  if (Object.keys(values).length !== allowed.size) {
    throw protectedReviewTrustError();
  }
  return Object.freeze({ mode, values: Object.freeze(values) });
}

function assertProtectedOperationProcess() {
  const actualEnvironment = Object.fromEntries(
    Object.keys(PROTECTED_OPERATION_ENVIRONMENT)
      .map((name) => [name, process.env[name]])
  );
  if (process.platform === "win32"
    || typeof process.getuid !== "function"
    || process.getuid() === 0
    || process.execArgv.length !== 0
    || JSON.stringify(actualEnvironment)
      !== JSON.stringify(PROTECTED_OPERATION_ENVIRONMENT)
    || Object.keys(process.env).length
      !== Object.keys(PROTECTED_OPERATION_ENVIRONMENT).length) {
    throw protectedReviewTrustError();
  }
}

async function readProtectedOperationAttestation() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > PROTECTED_OPERATION_MAX_STDIN_BYTES) {
      throw protectedReviewTrustError();
    }
    chunks.push(chunk);
  }
  if (size < 2) throw protectedReviewTrustError();
  let attestation;
  try {
    attestation = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    throw protectedReviewTrustError();
  }
  if (!attestation
    || typeof attestation !== "object"
    || Array.isArray(attestation)) {
    throw protectedReviewTrustError();
  }
  return attestation;
}

function boundedProtectedOperationResult(result) {
  if (Object.hasOwn(result || {}, "integrityOk")) {
    return {
      ok: result.ok === true,
      integrityOk: result.integrityOk === true,
      errors: Array.isArray(result.errors)
        ? result.errors.slice(0, 32).map((message) => String(message).slice(0, 512))
        : [],
      phase: result.phase || null,
      slice: result.slice || null,
      status: result.status || null,
      recordDigest: result.recordDigest || null,
      verified: result.verified === true
    };
  }
  if (result?.code) {
    return {
      ok: false,
      code: String(result.code).slice(0, 64),
      gateId: result.gateId ? String(result.gateId).slice(0, 128) : null,
      failureKind: result.failureKind
        ? String(result.failureKind).slice(0, 64)
        : null,
      outputDigest: SHA256.test(result.outputDigest || "")
        ? result.outputDigest
        : null
    };
  }
  if (result?.recordDigest) {
    return {
      ok: result.ok === true,
      converged: result.converged === true,
      path: result.path || null,
      phase: result.phase || null,
      slice: result.slice || null,
      status: result.status || null,
      recordDigest: result.recordDigest
    };
  }
  return {
    ok: result?.ok === true,
    errors: Array.isArray(result?.errors)
      ? result.errors.slice(0, 32).map((message) => String(message).slice(0, 512))
      : []
  };
}

function boundedProtectedOperationFailure(error) {
  const allowedCodes = new Set([
    "E_REVIEW_ATTESTATION_INVALID",
    "E_REVIEW_PROMOTION_COMMIT_UNKNOWN",
    "E_REVIEW_PROMOTION_CONFLICT",
    "E_REVIEW_PROMOTION_FORBIDDEN",
    "E_REVIEW_PROMOTION_INVALID",
    "E_REVIEW_PROMOTION_RACE",
    "E_REVIEW_REQUEST_INVALID",
    "E_REVIEW_TRUST_UNAVAILABLE"
  ]);
  const code = allowedCodes.has(error?.code)
    ? error.code
    : "E_REVIEW_TRUST_UNAVAILABLE";
  const result = { ok: false, code };
  if (code === "E_REVIEW_PROMOTION_COMMIT_UNKNOWN") {
    result.commitState = String(error?.commitState || "unknown").slice(0, 64);
    result.recoveryRequired = true;
    if (SHA256.test(error?.recordDigest || "")) {
      result.recordDigest = error.recordDigest;
    }
  }
  return result;
}

async function runProtectedOperationMain() {
  assertProtectedOperationProcess();
  const parsed = parseProtectedOperationArguments(process.argv.slice(2));
  if (parsed.mode === "promote") {
    return promotePhaseOneFromProtectedRuntime({
      workspace: parsed.values["--workspace"],
      requestPath: parsed.values["--request"],
      attestation: await readProtectedOperationAttestation()
    });
  }
  if (parsed.mode === "prove-phase-2") {
    return provePhaseTwoFromProtectedRuntime({
      workspace: parsed.values["--workspace"]
    });
  }
  if (parsed.mode === "verify-phase-2") {
    return verifyPhaseTwoFromProtectedRuntime({
      workspace: parsed.values["--workspace"]
    });
  }
  if (parsed.mode === "prove-phase-3") {
    return provePhaseThreeFromProtectedRuntime({
      workspace: parsed.values["--workspace"]
    });
  }
  if (parsed.mode === "verify-phase-3") {
    return verifyPhaseThreeFromProtectedRuntime({
      workspace: parsed.values["--workspace"]
    });
  }
  return verifySignedLedgerFromProtectedRuntime({
    workspace: parsed.values["--workspace"]
  });
}

if (import.meta.main === true) {
  void runProtectedOperationMain()
    .then((result) => {
      process.stdout.write(
        `${JSON.stringify(boundedProtectedOperationResult(result), null, 2)}\n`
      );
      if (result?.ok !== true) process.exitCode = 1;
    })
    .catch((error) => {
      process.stdout.write(
        `${JSON.stringify(boundedProtectedOperationFailure(error), null, 2)}\n`
      );
      process.exitCode = 1;
    });
}
