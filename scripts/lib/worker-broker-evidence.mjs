/**
 * Compatibility facade for Worker Broker evidence.
 * Imports are side-effect-safe; direct execution delegates to the authority.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export {
  EVIDENCE_ONLY_PREFIXES,
  EVIDENCE_ROOT,
  EVIDENCE_SCHEMA_VERSION,
  INDEPENDENT_REVIEW_MANIFEST_DIGEST,
  INDEPENDENT_REVIEW_PRODUCER_ID,
  INDEPENDENT_REVIEW_PRODUCER_VERSION,
  ISSUE_URL,
  LIVE_INSTALLATION_METHODS,
  LIVE_RECEIPT_AUTHORITY_CONFIG,
  LIVE_RECEIPT_AUTHORITY_MODES,
  LIVE_RECEIPT_AUTHORITY_NATURAL,
  LIVE_RECEIPT_AUTHORITY_SYNTHETIC,
  LIVE_RECEIPT_CAPABILITY_TOOL_IDS,
  LIVE_RECEIPT_MANIFEST,
  LIVE_RECEIPT_NATURAL_TOOL_IDS,
  LIVE_RECEIPT_PRODUCER_ID,
  LIVE_RECEIPT_PRODUCER_VERSION,
  LIVE_RECEIPT_PROVIDER_CAPABILITIES,
  LIVE_RECEIPT_ROOT,
  LIVE_RECEIPT_SCENARIO_IDS,
  LIVE_RECEIPT_SCHEMA_VERSION,
  PHASE_MANDATORY_GATE_IDS,
  PHASE_PREREQUISITES,
  PHASE_PROOF_GATE_MANIFEST,
  PHASE_SCOPE,
  PHASE_THREE_SLICE,
  PHASE_TWO_SLICE,
  PROOF_PRODUCER_ID,
  PROOF_PRODUCER_VERSION,
  PROTECTED_REVIEW_POLICY_DIGEST,
  PROTECTED_REVIEW_RUNTIME_BUNDLE_PATHS,
  QUALIFICATION_BOUNDARIES,
  REPO_ROOT,
  REVIEW_ATTESTATION_ALGORITHM,
  REVIEW_ATTESTATION_DOMAIN,
  REVIEW_ATTESTATION_ROOT,
  REVIEW_ATTESTATION_SCHEMA_VERSION,
  REVIEW_REQUEST_DOMAIN,
  REVIEW_REQUEST_PRODUCER_ID,
  REVIEW_REQUEST_PRODUCER_VERSION,
  REVIEW_REQUEST_ROOT,
  REVIEW_REQUEST_SCHEMA_VERSION,
  ROADMAP_VERSION,
  SIGNED_REVIEW_MANIFEST,
  SIGNED_REVIEW_MANIFEST_DIGEST,
  SIGNED_REVIEW_RECEIPT_PRODUCER_ID,
  SIGNED_REVIEW_RECEIPT_PRODUCER_VERSION,
  SIGNED_REVIEW_RECEIPT_SCHEMA_VERSION,
  computeProofManifestDigest,
  expandLocalStaticImportClosure,
  findMissingLocalStaticImportDependencies,
  isEvidenceOnlyPath,
  listLocalStaticImportSpecifiers,
  sha256Text
} from "./worker-broker-evidence-core.mjs";
export {
  publishImmutableEvidenceArtifact,
  statusSatisfiesVerifiedPrerequisite
} from "./worker-broker-evidence-files.mjs";
export {
  canonicalRecordBody,
  computeInventoryDigest,
  computePhaseScopeDigest,
  gitIdentity,
  isNonEvidenceTreeClean,
  listSourceInventory,
  parsePorcelainV1ZChanges,
  phaseScopePaths,
  runtimeSnapshot
} from "./worker-broker-evidence-inventory.mjs";
export { loadLedger, updateLedger } from "./worker-broker-evidence-ledger.mjs";
export { provePhaseZero, proveWorkerBrokerPhase } from "./worker-broker-evidence-proof-runner.mjs";
export {
  buildEvidenceRecord,
  validateEvidenceRecord,
  writeEvidenceRecord
} from "./worker-broker-evidence-record.mjs";
export {
  attachIndependentReviewReceiptDigest,
  attachRecordDigest,
  attachReviewAttestationDigest,
  attachReviewRequestDigest,
  canonicalReviewAttestationSigningBody,
  computeIndependentReviewReceiptDigest,
  computeLiveQualificationReceiptDigest,
  computeLiveReceiptManifestDigest,
  computeRecordDigest,
  computeReviewAttestationDigest,
  computeReviewPublicKeyFingerprint,
  computeReviewRequestDigest,
  validateIndependentReviewAttestation,
  validateLiveQualificationReceipt
} from "./worker-broker-evidence-review.mjs";
export {
  createPhaseOneReviewRequest,
  validatePhaseOneReviewRequest
} from "./worker-broker-evidence-review-request.mjs";
export {
  captureProofTemporaryHomeIdentity,
  cleanupProofTemporaryHome,
  runCommandCapture,
  sanitizeProofEnvironment
} from "./worker-broker-evidence-toolchain.mjs";
export {
  assessCompleteEvidenceChain,
  digestsIgnoreEvidenceOnly,
  evidenceStatus,
  verifyLedger,
  verifyPhase
} from "./worker-broker-evidence-verification.mjs";

const MAX_ARGUMENTS = 32;
const MAX_ARGUMENT_CHARS = 32 * 1024;

function boundedArguments(argv) {
  if (!Array.isArray(argv) || argv.length > MAX_ARGUMENTS) return null;
  let characters = 0;
  const bounded = [];
  for (const value of argv) {
    if (typeof value !== "string" || value.includes("\0") || value.length > 4096) return null;
    characters += value.length;
    if (characters > MAX_ARGUMENT_CHARS) return null;
    bounded.push(value);
  }
  return bounded;
}

if (import.meta.main === true) {
  const argv = boundedArguments(process.argv.slice(2));
  if (!argv) {
    process.stderr.write("Invalid protected operation arguments.\n");
    process.exitCode = 2;
  } else {
    const authority = fileURLToPath(new URL("./worker-broker-evidence-authority.mjs", import.meta.url));
    const child = spawn(process.execPath, [authority, ...argv], {
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", () => {
      process.stderr.write("Protected operation failed.\n");
      process.exitCode = 1;
    });
    child.once("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exitCode = Number.isInteger(code) ? code : 1;
    });
  }
}
