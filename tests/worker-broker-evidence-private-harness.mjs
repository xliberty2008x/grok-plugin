import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { tempDir } from "./helpers.mjs";

const PRIVATE_EVIDENCE_MODULE_FILES = Object.freeze([
  "worker-mutation-test-inventory.mjs",
  "worker-broker-evidence-core.mjs",
  "worker-broker-evidence-files.mjs",
  "worker-broker-evidence-toolchain.mjs",
  "worker-broker-evidence-inventory.mjs",
  "worker-broker-evidence-review.mjs",
  "worker-broker-evidence-record.mjs",
  "worker-broker-evidence-ledger.mjs",
  "worker-broker-evidence-protected-trust.mjs",
  "worker-broker-evidence-verification.mjs",
  "worker-broker-evidence-proof.mjs",
  "worker-broker-evidence-authority.mjs"
]);

export async function loadPrivateReviewPromotionHarness(
  root,
  { faultMode = null, importApi = true } = {}
) {
  const moduleDirectory = path.join(root, "scripts/lib");
  const harnessDirectory = tempDir("review-promotion-harness-");
  const harnessPath = path.join(harnessDirectory, "worker-broker-evidence-harness.mjs");
  const redactorUrl = pathToFileURL(path.join(
    root,
    "plugins/grok/scripts/lib/redact.mjs"
  )).href;
  const inventoryUrl = pathToFileURL(path.join(
    root,
    "scripts/lib/plugin-inventory.mjs"
  )).href;

  const patchPrivateModuleSource = (moduleSource, filename) => {
    let patched = moduleSource.replace(
      '"../../plugins/grok/scripts/lib/redact.mjs"',
      JSON.stringify(redactorUrl)
    )
    .replace(
      '"./plugin-inventory.mjs"',
      JSON.stringify(inventoryUrl)
    );
    if (filename === "worker-broker-evidence-core.mjs") {
      patched = patched.replace(
        'export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");',
        `export const REPO_ROOT = ${JSON.stringify(root)};`
      );
    }
    if (filename === "worker-broker-evidence-files.mjs"
      && faultMode === "post-lock-release") {
      patched = patched.replace(
        "releaseEvidenceLedgerLock(lease);",
        `releaseEvidenceLedgerLock(lease);
    throw Object.assign(new Error("injected lock release acknowledgement failure"), {
      code: "E_EVIDENCE_LEDGER_LOCK"
    });`
      );
    }
    return patched;
  };

  for (const filename of PRIVATE_EVIDENCE_MODULE_FILES) {
    if (filename === "worker-broker-evidence-authority.mjs") continue;
    const sourcePath = path.join(moduleDirectory, filename);
    const destination = path.join(harnessDirectory, filename);
    fs.writeFileSync(
      destination,
      patchPrivateModuleSource(fs.readFileSync(sourcePath, "utf8"), filename)
    );
  }

  let source = patchPrivateModuleSource(
    fs.readFileSync(path.join(moduleDirectory, "worker-broker-evidence-authority.mjs"), "utf8"),
    "worker-broker-evidence-authority.mjs"
  );
  if (faultMode === "post-ledger-rename-fsync") {
    source += `
const __testOriginalRenameSync = fs.renameSync.bind(fs);
const __testOriginalFsyncSync = fs.fsyncSync.bind(fs);
let __testLedgerRenameObserved = false;
fs.renameSync = (from, to) => {
  const result = __testOriginalRenameSync(from, to);
  if (path.basename(String(to)) === "ledger.json") __testLedgerRenameObserved = true;
  return result;
};
fs.fsyncSync = (descriptor) => {
  if (__testLedgerRenameObserved && fs.fstatSync(descriptor).isDirectory()) {
    __testLedgerRenameObserved = false;
    const error = new Error("injected post-ledger-rename directory fsync failure");
    error.code = "EIO";
    throw error;
  }
  return __testOriginalFsyncSync(descriptor);
};
`;
  } else if (faultMode !== null && faultMode !== "post-lock-release") {
    throw new Error(`Unsupported signed-review fault mode ${faultMode}.`);
  }
  source += `
export function __testPromoteSignedReview(options) {
  return promotePhaseOneSignedReviewInternal(
    options,
    REVIEW_PROMOTION_PUBLICATION_AUTHORITY
  );
}
export function __testVerifySignedLedger(root, trust) {
  return verifyLedger(root, {
    strict: true,
    signedReviewAuthority: SIGNED_REVIEW_VALIDATION_AUTHORITY,
    signedReviewTrust: trust
  });
}
export function __testPublishPhaseTwo(record, root, trust) {
  const signedReviewTrust = { ...trust, requireFresh: false };
  const proofContext = createProofExecutionContext();
  try {
    const source = captureProofSourceSnapshot("2", root, proofContext.toolchain);
    const prerequisites = captureProofPrerequisites("2", root, signedReviewTrust);
    if (prerequisites == null) throw new Error("missing protected prerequisites");
    const relative = publishDependentPhaseProofRecord(
      record,
      root,
      source,
      prerequisites,
      proofContext.toolchain,
      signedReviewTrust
    );
    return { relative, prerequisites };
  } finally {
    const cleaned = proofContext.cleanup();
    if (!cleaned?.ok) throw new Error("proof cleanup failed");
  }
}
export function __testPublishPhaseThree(record, root, trust) {
  const signedReviewTrust = { ...trust, requireFresh: false };
  const proofContext = createProofExecutionContext();
  try {
    const source = captureProofSourceSnapshot("3", root, proofContext.toolchain);
    const prerequisites = captureProofPrerequisites("3", root, signedReviewTrust);
    if (prerequisites == null) throw new Error("missing protected prerequisites");
    const relative = publishDependentPhaseProofRecord(
      record,
      root,
      source,
      prerequisites,
      proofContext.toolchain,
      signedReviewTrust
    );
    return { relative, prerequisites };
  } finally {
    const cleaned = proofContext.cleanup();
    if (!cleaned?.ok) throw new Error("proof cleanup failed");
  }
}
export function __testPublishPhaseZero(record, root) {
  const proofContext = createProofExecutionContext();
  try {
    const source = captureProofSourceSnapshot("0", root, proofContext.toolchain);
    return publishPhaseZeroProofRecord(record, root, source, proofContext.toolchain);
  } finally {
    const cleaned = proofContext.cleanup();
    if (!cleaned?.ok) throw new Error("proof cleanup failed");
  }
}
export function __testVerifyPhaseTwo(root, trust) {
  return verifyPhase("2", root, {
    strict: true,
    requireVerified: true,
    signedReviewAuthority: SIGNED_REVIEW_VALIDATION_AUTHORITY,
    signedReviewTrust: { ...trust, requireFresh: false }
  });
}
export function __testVerifyPhaseThree(root, trust) {
  return verifyPhase("3", root, {
    strict: true,
    requireVerified: true,
    signedReviewAuthority: SIGNED_REVIEW_VALIDATION_AUTHORITY,
    signedReviewTrust: { ...trust, requireFresh: false }
  });
}
export function __testImportSignedReview(options) {
  return importPhaseOneReviewAttestationInternal(
    options,
    REVIEW_PROMOTION_PUBLICATION_AUTHORITY
  );
}
`;
  fs.writeFileSync(harnessPath, source);
  const api = importApi
    ? await import(
      `${pathToFileURL(harnessPath).href}?nonce=${crypto.randomBytes(8).toString("hex")}`
    )
    : null;
  return { api, harnessPath, harnessDirectory };
}
