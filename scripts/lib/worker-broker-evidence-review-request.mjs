/** Public-safe Worker Broker review-request composition. */
import {
  cloneLedgerEntry,
  ledgerDocumentShapeIsValid,
  loadCanonicalCutoverRecord,
  loadLedgerDocument
} from "./worker-broker-evidence-ledger.mjs";
import {
  validateEvidenceRecord
} from "./worker-broker-evidence-record.mjs";
import {
  createPhaseOneReviewRequestInternal,
  validatePhaseOneReviewRequestInternal
} from "./worker-broker-evidence-review.mjs";
import {
  verifyLedger
} from "./worker-broker-evidence-verification.mjs";

const PUBLIC_REVIEW_VALIDATION_SERVICES = Object.freeze({
  cloneLedgerEntry,
  ledgerDocumentShapeIsValid,
  loadCanonicalCutoverRecord,
  loadLedgerDocument,
  validateEvidenceRecord,
  verifyLedger
});

export function validatePhaseOneReviewRequest(request, options = {}) {
  return validatePhaseOneReviewRequestInternal(
    request,
    options,
    PUBLIC_REVIEW_VALIDATION_SERVICES
  );
}

export function createPhaseOneReviewRequest(options = {}) {
  return createPhaseOneReviewRequestInternal(
    options,
    PUBLIC_REVIEW_VALIDATION_SERVICES
  );
}
