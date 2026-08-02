/** Internal Worker Broker evidence proof domain. */
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
  PHASE_PROOF_GATE_MANIFEST,
  PHASE_SCOPE,
  PROOF_PRODUCER_ID,
  PROOF_PRODUCER_VERSION,
  REPO_ROOT,
  computeProofManifestDigest,
  sha256Text,
  stableStringify
} from "./worker-broker-evidence-core.mjs";
import {
  unexpectedFields
} from "./worker-broker-evidence-files.mjs";
import {
  computeInventoryDigest,
  computePhaseScopeDigest,
  gitIdentity
} from "./worker-broker-evidence-inventory.mjs";
import {
  buildEvidenceRecord
} from "./worker-broker-evidence-record.mjs";
import {
  attachRecordDigest
} from "./worker-broker-evidence-review.mjs";
import {
  PROOF_PLATFORM_ERROR,
  PROOF_TOOLCHAIN_ERROR,
  assertProofToolchainIdentity,
  createProofExecutionContext,
  proofInvocation,
  proofToolchainDigest,
  runCommandCapture
} from "./worker-broker-evidence-toolchain.mjs";

export function captureProofSourceSnapshot(phase, root, toolchain) {
  const toolchainDigest = proofToolchainDigest(toolchain);
  const identity = gitIdentity(root);
  return {
    ...identity,
    sourceInventoryDigest: computeInventoryDigest(root, { includeEvidence: false }),
    phaseScopeDigest: computePhaseScopeDigest(phase, root),
    phaseScopeFileIdentityDigest: proofScopeFileIdentityDigest(phase, root),
    toolchainDigest
  };
}

function proofScopeFileIdentityDigest(phase, root) {
  const scope = PHASE_SCOPE[String(phase)];
  if (!scope?.length) throw new Error("Proof phase scope is unavailable.");
  const realRoot = fs.realpathSync(root);
  const identities = scope.map((relative) => {
    const expected = path.resolve(realRoot, relative);
    const actual = fs.realpathSync(path.resolve(root, relative));
    if (actual !== expected) {
      throw new Error(`Proof phase scope path resolves through a symlink: ${relative}`);
    }
    const stat = fs.lstatSync(actual, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Proof phase scope path is not a regular file: ${relative}`);
    }
    return {
      path: relative,
      dev: String(stat.dev),
      ino: String(stat.ino),
      mode: String(stat.mode),
      size: String(stat.size),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs)
    };
  });
  return sha256Text(stableStringify(identities));
}

export function sameProofSourceSnapshot(left, right) {
  return Boolean(left && right
    && left.headCommit === right.headCommit
    && left.headTree === right.headTree
    && left.cleanTreeAtVerification === true
    && right.cleanTreeAtVerification === true
    && left.sourceInventoryDigest === right.sourceInventoryDigest
    && left.phaseScopeDigest === right.phaseScopeDigest
    && left.phaseScopeFileIdentityDigest === right.phaseScopeFileIdentityDigest
    && left.toolchainDigest === right.toolchainDigest);
}

export function proofFailure(code, extras = {}) {
  return { ok: false, code, ...extras };
}

export function proofFailureForError(error, fallback) {
  if (error?.code === PROOF_TOOLCHAIN_ERROR || error?.code === PROOF_PLATFORM_ERROR) {
    return proofFailure(error.code);
  }
  return proofFailure(fallback);
}

export function proofRecordMatchesSnapshot(record, snapshot) {
  return Boolean(record?.source
    && record.source.headCommit === snapshot.headCommit
    && record.source.headTree === snapshot.headTree
    && record.source.cleanTreeAtVerification === true
    && record.source.sourceInventoryDigest === snapshot.sourceInventoryDigest
    && record.source.phaseScopeDigest === snapshot.phaseScopeDigest);
}

export function proveWorkerBrokerPhaseInternal(options = {}, services = null) {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || unexpectedFields(options, new Set(["phase", "slice", "root", "write"])).length) {
    return proofFailure("E_PROOF_ARGUMENT");
  }
  const {
    phase: requestedPhase = "0",
    slice,
    root = REPO_ROOT,
    write = false
  } = options;
  const phase = String(requestedPhase);
  const validSlug = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slice || "");
  const supportedSelection = (phase === "0" && validSlug)
    || (phase === "1" && slice === "worker-api");
  if (!supportedSelection || typeof root !== "string" || !root || typeof write !== "boolean") {
    return proofFailure("E_PROOF_ARGUMENT");
  }
  let proofContext;
  try {
    proofContext = createProofExecutionContext();
  } catch (error) {
    return proofFailureForError(error, PROOF_TOOLCHAIN_ERROR);
  }
  let result;
  try {
    result = proveWorkerBrokerPhaseWithContext(
      { phase, slice, root, write },
      proofContext,
      null,
      services
    );
  } catch (error) {
    result = proofFailureForError(error, "E_PROOF_SOURCE");
  }
  // Always finish temporary-home cleanup before returning. Cleanup is idempotent
  // when the success path already cleaned before publication. Never let a raw
  // cleanup exception escape or overwrite a structured result with a throw.
  let cleaned;
  try {
    cleaned = proofContext.cleanup();
  } catch {
    cleaned = { ok: false };
  }
  if (!cleaned?.ok) return proofFailure("E_PROOF_CLEANUP");
  return result;
}

export function proveWorkerBrokerPhaseWithContext(
  { phase, slice, root, write },
  proofContext,
  signedReviewTrust = null,
  services = null
) {
  const {
    captureProofPrerequisites,
    proofRecordMatchesPrerequisites,
    proofSignedReviewOptions,
    publishDependentPhaseProofRecord,
    publishPhaseZeroProofRecord,
    sameProofPrerequisites,
    validateEvidenceRecord
  } = services || {};
  const manifest = PHASE_PROOF_GATE_MANIFEST[phase];
  let initial;
  try {
    initial = captureProofSourceSnapshot(phase, root, proofContext.toolchain);
  } catch (error) {
    return proofFailureForError(error, "E_PROOF_SOURCE");
  }
  if (initial.cleanTreeAtVerification !== true) return proofFailure("E_PROOF_SOURCE_DIRTY");
  const initialPrerequisites = captureProofPrerequisites(
    phase,
    root,
    signedReviewTrust
  );
  if (initialPrerequisites == null) return proofFailure("E_PROOF_PREREQUISITE");

  const verification = [];
  for (const gate of manifest) {
    let beforeGate;
    try {
      beforeGate = captureProofSourceSnapshot(phase, root, proofContext.toolchain);
    } catch (error) {
      return proofFailureForError(error, "E_PROOF_SOURCE");
    }
    if (!sameProofSourceSnapshot(initial, beforeGate)) {
      return proofFailure("E_PROOF_SOURCE_DRIFT");
    }
    const [logicalExecutable, ...args] = gate.argv;
    let observed;
    try {
      const invocation = proofInvocation(logicalExecutable, args, proofContext);
      observed = runCommandCapture(invocation.command, invocation.args, {
        cwd: root,
        timeout: gate.timeoutMs,
        proofContext
      });
      assertProofToolchainIdentity(proofContext.toolchain);
    } catch (error) {
      return proofFailureForError(error, PROOF_TOOLCHAIN_ERROR);
    }
    if (observed.outcome !== "pass" || observed.exitCode !== 0) {
      return proofFailure("E_PROOF_GATE", {
        gateId: gate.gateId,
        failureKind: observed.failureKind,
        outputDigest: observed.outputDigest
      });
    }
    verification.push({
      gateId: gate.gateId,
      argv: [...gate.argv],
      boundary: gate.boundary,
      outcome: "pass",
      startedAt: observed.startedAt,
      endedAt: observed.endedAt,
      exitCode: 0,
      outputDigest: observed.outputDigest,
      assertions: [
        "code-owned manifest gate exited successfully",
        "output was bounded and redacted before digest"
      ]
    });
  }

  let afterGates;
  try {
    afterGates = captureProofSourceSnapshot(phase, root, proofContext.toolchain);
  } catch (error) {
    return proofFailureForError(error, "E_PROOF_SOURCE");
  }
  if (!sameProofSourceSnapshot(initial, afterGates)) return proofFailure("E_PROOF_SOURCE_DRIFT");
  const afterGatePrerequisites = captureProofPrerequisites(
    phase,
    root,
    signedReviewTrust
  );
  if (afterGatePrerequisites == null) return proofFailure("E_PROOF_PREREQUISITE");
  if (!sameProofPrerequisites(initialPrerequisites, afterGatePrerequisites)) {
    return proofFailure("E_PROOF_PREREQUISITE_DRIFT");
  }

  let record = buildEvidenceRecord({
    root,
    phase,
    slice,
    status: phase === "1" ? "implemented_unverified" : "verified_on_draft",
    prerequisites: initialPrerequisites,
    verification,
    scenarios: [{
      id: `phase-${phase}-proof-runner`,
      boundary: "deterministic",
      expected: phase === "0"
        ? "all fixed Phase 0 gates pass on one stable clean source identity"
        : `all fixed Phase ${phase} gates pass on one stable clean source and prerequisite identity`,
      actual: "all fixed gates passed and source identity remained stable",
      outcome: "pass"
    }],
    liveScenarios: [],
    evidenceSystemQualification: true,
    provisionalSupportingRecord: false,
    releaseQualification: false,
    qualification: {
      deterministic: "pass",
      installedHost: "not_run",
      provider: "not_run",
      release: "not_run"
    },
    authorities: {
      workerClaims: "none",
      runtimeObservations: `broker-owned bounded Phase ${phase} gate runner`,
      hostVerification: "not_run",
      independentValidation: "not_run"
    },
    limits: {
      residualRisks: [
        "Installed-host and authenticated-provider qualification remain unproven.",
        "The local producer assumes reviewed gates and all descendants are quiescent; hostile same-UID races and data retained through open descriptors require a separately privileged supervisor."
      ],
      unsupportedPlatforms: [
        "windows-proof-producer-cleanup",
        "windows-provider-execution",
        "linux-provider-unqualified"
      ],
      invalidationTriggers: [
        "source inventory change outside evidence-only paths",
        "phase-scope path change",
        "proof gate manifest change",
        "dirty tree when cleanTreeAtVerification claimed"
      ],
      supersededBy: null,
      liveQualificationGaps: [
        "installed natural host proof not run",
        "authenticated Grok provider proof not run"
      ]
    }
  });
  record = attachRecordDigest({
    ...record,
    proofProducer: {
      id: PROOF_PRODUCER_ID,
      version: PROOF_PRODUCER_VERSION,
      manifestDigest: computeProofManifestDigest(phase)
    }
  });

  let beforePublication;
  try {
    beforePublication = captureProofSourceSnapshot(phase, root, proofContext.toolchain);
  } catch (error) {
    return proofFailureForError(error, "E_PROOF_SOURCE");
  }
  if (!sameProofSourceSnapshot(initial, beforePublication)
    || !proofRecordMatchesSnapshot(record, initial)) {
    return proofFailure("E_PROOF_SOURCE_DRIFT");
  }
  const beforePublicationPrerequisites = captureProofPrerequisites(
    phase,
    root,
    signedReviewTrust
  );
  if (beforePublicationPrerequisites == null) return proofFailure("E_PROOF_PREREQUISITE");
  if (!sameProofPrerequisites(initialPrerequisites, beforePublicationPrerequisites)
    || !proofRecordMatchesPrerequisites(record, initialPrerequisites)) {
    return proofFailure("E_PROOF_PREREQUISITE_DRIFT");
  }
  const validated = validateEvidenceRecord(
    record,
    proofSignedReviewOptions(root, signedReviewTrust)
  );
  if (!validated.ok) return proofFailure("E_PROOF_RECORD");

  // Temporary-home cleanup must complete before any ledger/record publication so
  // an unproven cleanup cannot leave ENOTEMPTY debris after a published claim.
  let cleaned;
  try {
    cleaned = proofContext.cleanup();
  } catch {
    cleaned = { ok: false };
  }
  if (!cleaned?.ok) return proofFailure("E_PROOF_CLEANUP");

  if (!write) {
    return {
      ok: true,
      phase,
      slice,
      status: record.status,
      manifestDigest: record.proofProducer.manifestDigest,
      gateIds: verification.map((entry) => entry.gateId),
      record
    };
  }
  try {
    const path = phase === "0"
      ? publishPhaseZeroProofRecord(record, root, initial, proofContext.toolchain)
      : publishDependentPhaseProofRecord(
        record,
        root,
        initial,
        initialPrerequisites,
        proofContext.toolchain,
        signedReviewTrust
      );
    return {
      ok: true,
      phase,
      slice,
      status: record.status,
      path,
      recordDigest: record.recordDigest,
      sourceCommit: record.source.headCommit,
      manifestDigest: record.proofProducer.manifestDigest,
      gateIds: verification.map((entry) => entry.gateId),
      record
    };
  } catch {
    return proofFailure("E_PROOF_PUBLICATION");
  }
}

export function provePhaseZeroInternal(options = {}, services = null) {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || (options.phase != null && String(options.phase) !== "0")) {
    return proofFailure("E_PROOF_ARGUMENT");
  }
  return proveWorkerBrokerPhaseInternal({ ...options, phase: "0" }, services);
}
