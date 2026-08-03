/** Internal Worker Broker evidence review domain. */
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
  LIVE_RECEIPT_AUTHORITY_CONFIG,
  LIVE_RECEIPT_FIELDS,
  LIVE_RECEIPT_MAILBOX_FIELDS,
  LIVE_RECEIPT_MANIFEST,
  LIVE_RECEIPT_RUNTIME_ID,
  LIVE_RECEIPT_PRODUCER_ID,
  LIVE_RECEIPT_PRODUCER_VERSION,
  LIVE_RECEIPT_REFERENCE_FIELDS,
  LIVE_RECEIPT_ROOT,
  LIVE_RECEIPT_SCENARIO_BOOLEAN_FIELDS,
  LIVE_RECEIPT_SCENARIO_COUNT_FIELDS,
  LIVE_RECEIPT_SCENARIO_FIELDS,
  LIVE_RECEIPT_SCHEMA_VERSION,
  MAX_EVIDENCE_RECORD_BYTES,
  MAX_EVIDENCE_STRING_CHARS,
  MAX_PHASE_SCOPE_PATHS,
  PHASE_MANDATORY_GATE_IDS,
  PRIVATE_EVIDENCE_PATH,
  PROOF_PRODUCER_ID,
  PROOF_PRODUCER_VERSION,
  REPO_ROOT,
  REVIEW_ATTESTATION_ALGORITHM,
  REVIEW_ATTESTATION_DOMAIN,
  REVIEW_ATTESTATION_FIELDS,
  REVIEW_ATTESTATION_ROOT,
  REVIEW_ATTESTATION_SCHEMA_VERSION,
  REVIEW_REQUEST_DIFF_FIELDS,
  REVIEW_REQUEST_DOMAIN,
  REVIEW_REQUEST_FIELDS,
  REVIEW_REQUEST_PREREQUISITE_FIELDS,
  REVIEW_REQUEST_PRODUCER_ID,
  REVIEW_REQUEST_PRODUCER_VERSION,
  REVIEW_REQUEST_PROOF_FIELDS,
  REVIEW_REQUEST_ROOT,
  REVIEW_REQUEST_SCHEMA_VERSION,
  REVIEW_REQUEST_SOURCE_FIELDS,
  SHA256,
  SIGNED_REVIEW_MANIFEST_DIGEST,
  SIGNED_REVIEW_REFERENCE_FIELDS,
  computeProofManifestDigest,
  isEvidenceOnlyPath,
  sha256Text,
  stableStringify
} from "./worker-broker-evidence-core.mjs";
import {
  boundedEvidenceErrors,
  captureEvidencePathChain,
  ensureEvidenceDirectory,
  exactFields,
  fixedEvidenceError,
  invalidLiveQualificationPublicationError,
  publishImmutableEvidenceFile,
  rawEvidenceValueIsSafe,
  readBoundedEvidenceFile,
  readBoundedEvidenceFileSnapshot,
  sameFileSnapshot,
  unexpectedFields
} from "./worker-broker-evidence-files.mjs";
import {
  MAX_LIVE_PLUGIN_FILES,
  canonicalRecordBody,
  captureLivePluginInventory,
  computeInventoryDigest,
  computePhaseScopeDigest,
  gitIdentity,
  isNonEvidenceTreeClean,
  phaseScopePaths
} from "./worker-broker-evidence-inventory.mjs";
import {
  execTrustedGit,
  passedGateIds
} from "./worker-broker-evidence-toolchain.mjs";

export function computeRecordDigest(record) {
  return sha256Text(canonicalRecordBody(record));
}

export function computeIndependentReviewReceiptDigest(receipt) {
  const body = structuredClone(receipt);
  delete body.receiptDigest;
  return sha256Text(stableStringify(body));
}

export function computeReviewRequestDigest(request) {
  const body = structuredClone(request);
  delete body.requestDigest;
  return sha256Text(stableStringify(body));
}

export function attachReviewRequestDigest(request) {
  const next = structuredClone(request);
  delete next.requestDigest;
  next.requestDigest = computeReviewRequestDigest(next);
  return next;
}

export function canonicalReviewAttestationSigningBody(attestation) {
  const body = structuredClone(attestation);
  delete body.signature;
  delete body.attestationDigest;
  return stableStringify(body);
}

export function computeReviewAttestationDigest(attestation) {
  const body = structuredClone(attestation);
  delete body.attestationDigest;
  return sha256Text(stableStringify(body));
}

export function attachReviewAttestationDigest(attestation) {
  const next = structuredClone(attestation);
  delete next.attestationDigest;
  next.attestationDigest = computeReviewAttestationDigest(next);
  return next;
}

export function computeReviewPublicKeyFingerprint(publicKey) {
  let key;
  try {
    key = publicKey?.type === "public" && publicKey?.asymmetricKeyType
      ? publicKey
      : crypto.createPublicKey(publicKey);
  } catch {
    throw fixedEvidenceError("E_REVIEW_ATTESTATION_INVALID", "Review public key is invalid.");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw fixedEvidenceError("E_REVIEW_ATTESTATION_INVALID", "Review public key must be Ed25519.");
  }
  let spki;
  try {
    spki = key.export({ type: "spki", format: "der" });
  } catch {
    throw fixedEvidenceError("E_REVIEW_ATTESTATION_INVALID", "Review public key SPKI export failed.");
  }
  return sha256Text(spki);
}

export function reviewRequestRelativePath(request) {
  return `${REVIEW_REQUEST_ROOT}/${request.source.headCommit.slice(0, 16)}-${request.requestDigest.slice(0, 16)}.json`;
}

export function reviewAttestationRelativePath(attestation) {
  return `${REVIEW_ATTESTATION_ROOT}/${attestation.requestDigest.slice(0, 16)}-${attestation.attestationDigest.slice(0, 16)}.json`;
}

export function normalizedReviewArtifactPath(value, prefix, pattern) {
  return typeof value === "string"
    && value.startsWith(`${prefix}/`)
    && !value.includes("\\")
    && !value.includes("\0")
    && !value.split("/").includes("..")
    && path.posix.normalize(value) === value
    && pattern.test(value);
}

function canonicalBase64UrlBytes(value, expectedBytes) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let bytes;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    return null;
  }
  if (bytes.length !== expectedBytes || bytes.toString("base64url") !== value) return null;
  return bytes;
}

function safeReviewDiffPath(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_EVIDENCE_STRING_CHARS
    && !value.includes("\0")
    && !value.includes("\\")
    && !path.posix.isAbsolute(value)
    && path.posix.normalize(value) === value
    && value !== "."
    && value !== ".."
    && !value.startsWith("../")
    && !isEvidenceOnlyPath(value)
    && redactText(value) === value
    && !PRIVATE_EVIDENCE_PATH.test(value);
}

function captureReviewSourcePathSet(root, paths) {
  const snapshots = new Map();
  for (const relative of [...new Set(paths)].sort()) {
    const absolute = path.join(root, ...relative.split("/"));
    let stat;
    try {
      stat = fs.lstatSync(absolute, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw fixedEvidenceError("E_REVIEW_REQUEST_INVALID", "Review source path is unreadable.");
    }
    if (stat.isSymbolicLink()) {
      throw fixedEvidenceError("E_REVIEW_REQUEST_INVALID", "Review source paths cannot contain symlinks.");
    }
    const chain = captureEvidencePathChain(root, absolute);
    const leaf = chain.snapshots.at(-1);
    if (!leaf?.isFile() && !leaf?.isDirectory()) {
      throw fixedEvidenceError("E_REVIEW_REQUEST_INVALID", "Review source path type is unsupported.");
    }
    snapshots.set(relative, chain);
  }
  return snapshots;
}

function sameReviewSourcePathSets(left, right) {
  if (!(left instanceof Map)
    || !(right instanceof Map)
    || left.size !== right.size) return false;
  for (const [relative, before] of left) {
    const after = right.get(relative);
    if (!after
      || before.canonicalRoot !== after.canonicalRoot
      || before.canonicalAbsolute !== after.canonicalAbsolute
      || before.snapshots.length !== after.snapshots.length
      || !after.snapshots.every((stat, index) => (
        sameFileSnapshot(stat, before.snapshots[index])
      ))) return false;
  }
  return true;
}

function deriveReviewDiff(root, baseCommit, headCommit) {
  if (!/^[0-9a-f]{40}$/.test(baseCommit || "")
    || !/^[0-9a-f]{40}$/.test(headCommit || "")
    || baseCommit === headCommit) {
    throw fixedEvidenceError("E_REVIEW_REQUEST_INVALID", "Review diff base is invalid.");
  }
  try {
    execTrustedGit(["cat-file", "-e", `${baseCommit}^{commit}`], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 1024,
      stdio: ["ignore", "pipe", "pipe"]
    });
    execTrustedGit(["merge-base", "--is-ancestor", baseCommit, headCommit], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 1024,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch {
    throw fixedEvidenceError("E_REVIEW_REQUEST_INVALID", "Review diff base is not an ancestor commit.");
  }
  let changed;
  try {
    changed = execTrustedGit([
      "diff",
      "--name-only",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "-z",
      baseCommit,
      headCommit,
      "--"
    ], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024
    }).toString("utf8").split("\0").filter(Boolean)
      .filter((relative) => !isEvidenceOnlyPath(relative));
  } catch {
    throw fixedEvidenceError("E_REVIEW_REQUEST_INVALID", "Review diff paths could not be derived.");
  }
  const paths = [...new Set(changed)].sort();
  if (paths.length < 1
    || paths.length > MAX_PHASE_SCOPE_PATHS
    || paths.some((relative) => !safeReviewDiffPath(relative))) {
    throw fixedEvidenceError("E_REVIEW_REQUEST_INVALID", "Review diff paths are invalid or empty.");
  }
  let patch;
  try {
    patch = execTrustedGit([
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      baseCommit,
      headCommit,
      "--",
      ...paths.map((relative) => `:(literal)${relative}`)
    ], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024
    });
  } catch {
    throw fixedEvidenceError("E_REVIEW_REQUEST_INVALID", "Review diff patch could not be derived.");
  }
  return Object.freeze({
    baseCommit,
    headCommit,
    patchDigest: sha256Text(patch),
    pathsDigest: sha256Text(stableStringify(paths)),
    paths
  });
}

function currentPhaseOneReviewBindings(root, services) {
  const {
    cloneLedgerEntry,
    ledgerDocumentShapeIsValid,
    loadCanonicalCutoverRecord,
    loadLedgerDocument,
    verifyLedger
  } = services || {};
  if ([
    cloneLedgerEntry,
    ledgerDocumentShapeIsValid,
    loadCanonicalCutoverRecord,
    loadLedgerDocument,
    verifyLedger
  ].some((service) => typeof service !== "function")) {
    throw fixedEvidenceError("E_REVIEW_REQUEST_INVALID", "Current evidence services are unavailable.");
  }
  const verified = verifyLedger(root, { strict: true });
  if (!verified.ok) {
    throw fixedEvidenceError("E_REVIEW_REQUEST_INVALID", "Current evidence ledger is not strictly valid.");
  }
  let loaded;
  try {
    loaded = loadLedgerDocument(root);
  } catch {
    throw fixedEvidenceError("E_REVIEW_REQUEST_INVALID", "Current evidence ledger is unreadable.");
  }
  if (!ledgerDocumentShapeIsValid(loaded.ledger)) {
    throw fixedEvidenceError("E_REVIEW_REQUEST_INVALID", "Current evidence ledger is invalid.");
  }
  const current = loaded.ledger.entries.filter((entry) => entry.currency === "current");
  const phaseZeroEntry = current.find((entry) => entry.phase === "0");
  const phaseOneEntry = current.find((entry) => entry.phase === "1");
  if (!phaseZeroEntry || !phaseOneEntry) {
    throw fixedEvidenceError("E_REVIEW_REQUEST_INVALID", "Phase 0 and Phase 1 current evidence are required.");
  }
  let phaseZero;
  let phaseOne;
  try {
    phaseZero = loadCanonicalCutoverRecord(phaseZeroEntry, root);
    phaseOne = loadCanonicalCutoverRecord(phaseOneEntry, root);
  } catch {
    throw fixedEvidenceError("E_REVIEW_REQUEST_INVALID", "Current review evidence could not be loaded safely.");
  }
  if (phaseZero.status !== "verified_on_draft"
    || phaseOne.status !== "implemented_unverified"
    || phaseZero.proofProducer?.id !== PROOF_PRODUCER_ID
    || phaseZero.proofProducer?.version !== PROOF_PRODUCER_VERSION
    || phaseOne.proofProducer?.id !== PROOF_PRODUCER_ID
    || phaseOne.proofProducer?.version !== PROOF_PRODUCER_VERSION
    || phaseOne.prerequisites?.length !== 1
    || phaseOne.prerequisites[0]?.phase !== "0"
    || phaseOne.prerequisites[0]?.recordDigest !== phaseZero.recordDigest
    || JSON.stringify(phaseOne.prerequisites[0]?.gateIds)
      !== JSON.stringify(PHASE_MANDATORY_GATE_IDS["0"])) {
    throw fixedEvidenceError("E_REVIEW_REQUEST_INVALID", "Current Phase 1 proof prerequisite is not exact.");
  }
  const phaseZeroGates = [...passedGateIds(phaseZero)].sort();
  const phaseOneGates = [...passedGateIds(phaseOne)].sort();
  if (JSON.stringify(phaseZeroGates) !== JSON.stringify([...PHASE_MANDATORY_GATE_IDS["0"]].sort())
    || JSON.stringify(phaseOneGates) !== JSON.stringify([...PHASE_MANDATORY_GATE_IDS["1"]].sort())) {
    throw fixedEvidenceError("E_REVIEW_REQUEST_INVALID", "Current proof gates are incomplete.");
  }
  return Object.freeze({
    phaseZeroEntry: cloneLedgerEntry(phaseZeroEntry),
    phaseOneEntry: cloneLedgerEntry(phaseOneEntry),
    phaseZero,
    phaseOne
  });
}

function reviewRequestShapeErrors(request, {
  now = new Date().toISOString(),
  requireFresh = true
} = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return ["Review request must be a JSON object."];
  }
  if (!rawEvidenceValueIsSafe(request, "$reviewRequest")
    || unexpectedFields(request, REVIEW_REQUEST_FIELDS).length) {
    fail("Review request contains unsafe or unsupported fields.");
  }
  if (request.schemaVersion !== REVIEW_REQUEST_SCHEMA_VERSION
    || request.domain !== REVIEW_REQUEST_DOMAIN
    || request.producerId !== REVIEW_REQUEST_PRODUCER_ID
    || request.producerVersion !== REVIEW_REQUEST_PRODUCER_VERSION
    || request.manifestDigest !== SIGNED_REVIEW_MANIFEST_DIGEST
    || request.phase !== "1") {
    fail("Review request producer, domain, phase, or manifest identity is invalid.");
  }
  if (!isCanonicalIsoDateTime(request.createdAt)
    || !isCanonicalIsoDateTime(request.expiresAt)
    || (isCanonicalIsoDateTime(request.createdAt)
      && isCanonicalIsoDateTime(request.expiresAt)
      && (Date.parse(request.expiresAt) <= Date.parse(request.createdAt)
        || Date.parse(request.expiresAt) - Date.parse(request.createdAt) > 7 * 24 * 60 * 60_000))) {
    fail("Review request validity window is invalid.");
  }
  if (requireFresh && (!isCanonicalIsoDateTime(now)
    || Date.parse(now) < Date.parse(request.createdAt || "")
    || Date.parse(now) > Date.parse(request.expiresAt || ""))) {
    fail("Review request is not currently valid.");
  }
  if (!canonicalBase64UrlBytes(request.nonce, 32)) {
    fail("Review request nonce must be canonical 32-byte base64url.");
  }
  const source = request.source;
  if (!exactFields(source, REVIEW_REQUEST_SOURCE_FIELDS)
    || !/^[0-9a-f]{40}$/.test(source?.headCommit || "")
    || !/^[0-9a-f]{40}$/.test(source?.headTree || "")
    || !SHA256.test(source?.sourceInventoryDigest || "")
    || !SHA256.test(source?.phaseScopeDigest || "")
    || !Array.isArray(source?.phaseScopePaths)
    || source.phaseScopePaths.length < 1
    || source.phaseScopePaths.length > MAX_PHASE_SCOPE_PATHS
    || JSON.stringify(source.phaseScopePaths)
      !== JSON.stringify([...new Set(source.phaseScopePaths)].sort())
    || source.phaseScopePaths.some((relative) => !safeReviewDiffPath(relative))) {
    fail("Review request source binding is invalid.");
  }
  const diff = request.diff;
  if (!exactFields(diff, REVIEW_REQUEST_DIFF_FIELDS)
    || !/^[0-9a-f]{40}$/.test(diff?.baseCommit || "")
    || diff?.headCommit !== source?.headCommit
    || !SHA256.test(diff?.patchDigest || "")
    || !SHA256.test(diff?.pathsDigest || "")
    || !Array.isArray(diff?.paths)
    || diff.paths.length < 1
    || diff.paths.length > MAX_PHASE_SCOPE_PATHS
    || JSON.stringify(diff.paths) !== JSON.stringify([...new Set(diff.paths)].sort())
    || diff.paths.some((relative) => !safeReviewDiffPath(relative))
    || (Array.isArray(diff?.paths)
      && diff.pathsDigest !== sha256Text(stableStringify(diff.paths)))) {
    fail("Review request diff binding is invalid.");
  }
  const proof = request.proof;
  if (!exactFields(proof, REVIEW_REQUEST_PROOF_FIELDS)
    || !normalizedReviewArtifactPath(
      proof?.path,
      `${EVIDENCE_ROOT}/phase-1`,
      new RegExp(`^${EVIDENCE_ROOT}/phase-1/[0-9a-f]{16}-[0-9a-f]{12}\\.json$`)
    )
    || !SHA256.test(proof?.recordDigest || "")
    || proof?.producerManifestDigest !== computeProofManifestDigest("1")
    || JSON.stringify(proof?.gateIds) !== JSON.stringify(PHASE_MANDATORY_GATE_IDS["1"])) {
    fail("Review request Phase 1 proof binding is invalid.");
  }
  const prerequisite = request.prerequisite;
  if (!exactFields(prerequisite, REVIEW_REQUEST_PREREQUISITE_FIELDS)
    || prerequisite?.phase !== "0"
    || !normalizedReviewArtifactPath(
      prerequisite?.path,
      `${EVIDENCE_ROOT}/phase-0`,
      new RegExp(`^${EVIDENCE_ROOT}/phase-0/[0-9a-f]{16}-[0-9a-f]{12}\\.json$`)
    )
    || !SHA256.test(prerequisite?.recordDigest || "")
    || JSON.stringify(prerequisite?.gateIds) !== JSON.stringify(PHASE_MANDATORY_GATE_IDS["0"])) {
    fail("Review request Phase 0 prerequisite binding is invalid.");
  }
  if (!SHA256.test(request.requestDigest || "")
    || request.requestDigest !== computeReviewRequestDigest(request)) {
    fail("Review request digest does not match its canonical body.");
  }
  return errors;
}

export function validatePhaseOneReviewRequestInternal(request, options = {}, services = null) {
  const errors = reviewRequestShapeErrors(request, options);
  const fail = (message) => errors.push(message);
  if (errors.length || !options.root) return { ok: errors.length === 0, errors };
  const root = options.root;
  try {
    if (!isNonEvidenceTreeClean(root)) {
      fail("Review request requires a clean non-evidence source tree.");
      return { ok: false, errors };
    }
    const protectedSourcePaths = [
      ...request.source.phaseScopePaths,
      ...request.diff.paths
    ];
    const pathsBefore = captureReviewSourcePathSet(root, protectedSourcePaths);
    const identity = gitIdentity(root);
    const expectedScopePaths = phaseScopePaths("1", root);
    const currentSourceInventoryDigest = computeInventoryDigest(
      root,
      { includeEvidence: false }
    );
    const currentPhaseScopeDigest = computePhaseScopeDigest("1", root);
    const pathsAfter = captureReviewSourcePathSet(root, protectedSourcePaths);
    if (!sameReviewSourcePathSets(pathsBefore, pathsAfter)) {
      fail("Review request source paths changed during validation.");
    }
    const sourceEquivalent = request.source.sourceInventoryDigest
      === currentSourceInventoryDigest
      && request.source.phaseScopeDigest === currentPhaseScopeDigest;
    const allowEvidenceOnlyIdentityDrift = options.allowEvidenceOnlyIdentityDrift === true;
    let reviewedHeadIsCurrentAncestor = request.source.headCommit === identity.headCommit;
    if (allowEvidenceOnlyIdentityDrift && !reviewedHeadIsCurrentAncestor) {
      try {
        execTrustedGit([
          "merge-base",
          "--is-ancestor",
          request.source.headCommit,
          identity.headCommit
        ], {
          cwd: root,
          encoding: "buffer",
          maxBuffer: 1024,
          stdio: ["ignore", "pipe", "pipe"]
        });
        reviewedHeadIsCurrentAncestor = true;
      } catch {
        reviewedHeadIsCurrentAncestor = false;
      }
    }
    if ((!allowEvidenceOnlyIdentityDrift
        && (request.source.headCommit !== identity.headCommit
          || request.source.headTree !== identity.headTree))
      || (allowEvidenceOnlyIdentityDrift && !reviewedHeadIsCurrentAncestor)
      || !sourceEquivalent
      || JSON.stringify(request.source.phaseScopePaths) !== JSON.stringify(expectedScopePaths)) {
      fail("Review request source binding is stale.");
    }
    const diff = deriveReviewDiff(
      root,
      request.diff.baseCommit,
      request.source.headCommit
    );
    if (JSON.stringify(request.diff) !== JSON.stringify(diff)) {
      fail("Review request diff binding is stale or mismatched.");
    }
    if (options.requireCurrentProof !== false) {
      const bindings = currentPhaseOneReviewBindings(root, services);
      if (request.proof.path !== bindings.phaseOneEntry.path
        || request.proof.recordDigest !== bindings.phaseOne.recordDigest
        || request.proof.producerManifestDigest !== bindings.phaseOne.proofProducer.manifestDigest
        || JSON.stringify(request.proof.gateIds)
          !== JSON.stringify(PHASE_MANDATORY_GATE_IDS["1"])
        || request.prerequisite.path !== bindings.phaseZeroEntry.path
        || request.prerequisite.recordDigest !== bindings.phaseZero.recordDigest
        || JSON.stringify(request.prerequisite.gateIds)
          !== JSON.stringify(PHASE_MANDATORY_GATE_IDS["0"])) {
        fail("Review request no longer matches the exact current proof chain.");
      }
    } else {
      const phaseOne = JSON.parse(readBoundedEvidenceFile(
        root,
        path.join(root, ...request.proof.path.split("/"))
      ));
      const phaseZero = JSON.parse(readBoundedEvidenceFile(
        root,
        path.join(root, ...request.prerequisite.path.split("/"))
      ));
      const phaseOneValidation = services.validateEvidenceRecord(phaseOne, {
        strict: true,
        root,
        requireEvidenceSystem: true
      });
      const phaseZeroValidation = services.validateEvidenceRecord(phaseZero, {
        strict: true,
        root,
        requireEvidenceSystem: true
      });
      if (!phaseOneValidation.ok
        || !phaseZeroValidation.ok
        || phaseOne.phase !== "1"
        || phaseOne.status !== "implemented_unverified"
        || phaseOne.recordDigest !== request.proof.recordDigest
        || phaseOne.proofProducer?.manifestDigest !== request.proof.producerManifestDigest
        || phaseZero.phase !== "0"
        || phaseZero.status !== "verified_on_draft"
        || phaseZero.recordDigest !== request.prerequisite.recordDigest
        || phaseOne.prerequisites?.length !== 1
        || phaseOne.prerequisites[0]?.recordDigest !== phaseZero.recordDigest) {
        fail("Review request referenced proof records are stale, unsafe, or mismatched.");
      }
    }
  } catch {
    fail("Review request current bindings could not be verified.");
  }
  return { ok: errors.length === 0, errors };
}

export function validateIndependentReviewAttestation(attestation, {
  request,
  requestPath = request ? reviewRequestRelativePath(request) : null,
  publicKey = null,
  expectedIssuer = null,
  revokedKeyFingerprints = [],
  now = new Date().toISOString(),
  requireFreshRequest = true
} = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)) {
    return { ok: false, errors: ["Review attestation must be a JSON object."] };
  }
  if (!rawEvidenceValueIsSafe(attestation, "$reviewAttestation")
    || unexpectedFields(attestation, REVIEW_ATTESTATION_FIELDS).length) {
    fail("Review attestation contains unsafe or unsupported fields.");
  }
  const requestValidation = validatePhaseOneReviewRequestInternal(request, {
    now,
    requireFresh: requireFreshRequest
  });
  if (!requestValidation.ok) fail("Review attestation references an invalid or expired request.");
  if (attestation.schemaVersion !== REVIEW_ATTESTATION_SCHEMA_VERSION
    || attestation.domain !== REVIEW_ATTESTATION_DOMAIN
    || attestation.algorithm !== REVIEW_ATTESTATION_ALGORITHM) {
    fail("Review attestation domain, version, or algorithm is invalid.");
  }
  if (typeof expectedIssuer !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(expectedIssuer)
    || attestation.issuer !== expectedIssuer) {
    fail("Review attestation issuer is not the protected expected issuer.");
  }
  if (!normalizedReviewArtifactPath(
    attestation.requestPath,
    REVIEW_REQUEST_ROOT,
    new RegExp(`^${REVIEW_REQUEST_ROOT}/[0-9a-f]{16}-[0-9a-f]{16}\\.json$`)
  )
    || attestation.requestPath !== requestPath
    || attestation.requestDigest !== request?.requestDigest
    || attestation.nonce !== request?.nonce
    || attestation.manifestDigest !== SIGNED_REVIEW_MANIFEST_DIGEST
    || !SHA256.test(attestation.reviewerRuntimeDigest || "")
    || attestation.headCommit !== request?.source?.headCommit
    || attestation.headTree !== request?.source?.headTree
    || attestation.sourceInventoryDigest !== request?.source?.sourceInventoryDigest
    || attestation.phaseScopeDigest !== request?.source?.phaseScopeDigest
    || attestation.diffBaseCommit !== request?.diff?.baseCommit
    || attestation.diffPatchDigest !== request?.diff?.patchDigest
    || attestation.diffPathsDigest !== request?.diff?.pathsDigest
    || attestation.proofRecordDigest !== request?.proof?.recordDigest
    || attestation.prerequisiteRecordDigest !== request?.prerequisite?.recordDigest) {
    fail("Review attestation does not bind the exact request, source, diff, proof, and prerequisite.");
  }
  if (!isCanonicalIsoDateTime(attestation.startedAt)
    || !isCanonicalIsoDateTime(attestation.endedAt)
    || !isCanonicalIsoDateTime(now)
    || Date.parse(attestation.startedAt || "") < Date.parse(request?.createdAt || "")
    || Date.parse(attestation.endedAt || "") < Date.parse(attestation.startedAt || "")
    || Date.parse(attestation.endedAt || "") > Date.parse(request?.expiresAt || "")
    || Date.parse(attestation.endedAt || "") > Date.parse(now || "")) {
    fail("Review attestation chronology is invalid.");
  }
  if (attestation.outcome !== "pass" || attestation.unresolvedFindings !== 0) {
    fail("Review attestation must record pass with zero unresolved findings.");
  }
  if (!SHA256.test(attestation.keyFingerprint || "")) {
    fail("Review attestation key fingerprint is invalid.");
  }
  if (!Array.isArray(revokedKeyFingerprints)
    || revokedKeyFingerprints.some((fingerprint) => !SHA256.test(fingerprint || ""))
    || revokedKeyFingerprints.includes(attestation.keyFingerprint)) {
    fail("Review attestation key is revoked or revocation state is invalid.");
  }
  const signature = canonicalBase64UrlBytes(attestation.signature, 64);
  if (!signature) fail("Review attestation signature must be canonical 64-byte base64url.");
  let key = null;
  try {
    key = publicKey?.type === "public" && publicKey?.asymmetricKeyType
      ? publicKey
      : crypto.createPublicKey(publicKey);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    const fingerprint = computeReviewPublicKeyFingerprint(key);
    if (fingerprint !== attestation.keyFingerprint) {
      fail("Review attestation key fingerprint does not match the protected key.");
    }
  } catch {
    fail("Review attestation protected Ed25519 key is unavailable or invalid.");
  }
  if (key && signature) {
    let verified = false;
    try {
      verified = crypto.verify(
        null,
        Buffer.from(canonicalReviewAttestationSigningBody(attestation), "utf8"),
        key,
        signature
      );
    } catch {
      verified = false;
    }
    if (!verified) fail("Review attestation signature verification failed.");
  }
  if (!SHA256.test(attestation.attestationDigest || "")
    || attestation.attestationDigest !== computeReviewAttestationDigest(attestation)) {
    fail("Review attestation digest does not match its canonical body.");
  }
  return {
    ok: errors.length === 0,
    errors,
    keyFingerprint: errors.length === 0 ? attestation.keyFingerprint : null
  };
}

export function createPhaseOneReviewRequestInternal({
  root = REPO_ROOT,
  baseCommit,
  createdAt = new Date().toISOString(),
  expiresAt = new Date(Date.parse(createdAt) + 24 * 60 * 60_000).toISOString(),
  nonce = crypto.randomBytes(32).toString("base64url"),
  write = false
} = {}, services = null) {
  if (typeof root !== "string"
    || !root
    || typeof write !== "boolean"
    || !isCanonicalIsoDateTime(createdAt)
    || !isCanonicalIsoDateTime(expiresAt)
    || !canonicalBase64UrlBytes(nonce, 32)) {
    throw fixedEvidenceError("E_REVIEW_REQUEST_INVALID", "Review request arguments are invalid.");
  }
  if (!isNonEvidenceTreeClean(root)) {
    throw fixedEvidenceError("E_REVIEW_REQUEST_INVALID", "Review request source tree is dirty.");
  }
  const identity = gitIdentity(root);
  const bindings = currentPhaseOneReviewBindings(root, services);
  const diff = deriveReviewDiff(root, baseCommit, identity.headCommit);
  const request = attachReviewRequestDigest({
    schemaVersion: REVIEW_REQUEST_SCHEMA_VERSION,
    domain: REVIEW_REQUEST_DOMAIN,
    producerId: REVIEW_REQUEST_PRODUCER_ID,
    producerVersion: REVIEW_REQUEST_PRODUCER_VERSION,
    manifestDigest: SIGNED_REVIEW_MANIFEST_DIGEST,
    phase: "1",
    createdAt,
    expiresAt,
    nonce,
    source: {
      headCommit: identity.headCommit,
      headTree: identity.headTree,
      sourceInventoryDigest: computeInventoryDigest(root, { includeEvidence: false }),
      phaseScopeDigest: computePhaseScopeDigest("1", root),
      phaseScopePaths: phaseScopePaths("1", root)
    },
    diff,
    proof: {
      path: bindings.phaseOneEntry.path,
      recordDigest: bindings.phaseOne.recordDigest,
      producerManifestDigest: bindings.phaseOne.proofProducer.manifestDigest,
      gateIds: [...PHASE_MANDATORY_GATE_IDS["1"]]
    },
    prerequisite: {
      phase: "0",
      path: bindings.phaseZeroEntry.path,
      recordDigest: bindings.phaseZero.recordDigest,
      gateIds: [...PHASE_MANDATORY_GATE_IDS["0"]]
    }
  });
  const validation = validatePhaseOneReviewRequestInternal(request, {
    root,
    now: createdAt,
    requireFresh: true
  }, services);
  if (!validation.ok) {
    throw fixedEvidenceError("E_REVIEW_REQUEST_INVALID", "Review request bindings are invalid.");
  }
  const relative = reviewRequestRelativePath(request);
  if (write) {
    const absolute = path.join(root, ...relative.split("/"));
    const serialized = `${JSON.stringify(request, null, 2)}\n`;
    try {
      ensureEvidenceDirectory(root, path.dirname(absolute));
      publishImmutableEvidenceFile(root, absolute, serialized);
    } catch {
      try {
        if (readBoundedEvidenceFile(root, absolute) === serialized) {
          return { ok: true, path: relative, request };
        }
      } catch {}
      throw fixedEvidenceError("E_REVIEW_REQUEST_INVALID", "Immutable review request publication failed.");
    }
  }
  return { ok: true, path: write ? relative : null, request };
}

export function computeLiveReceiptManifestDigest() {
  return sha256Text(stableStringify(LIVE_RECEIPT_MANIFEST));
}

export function computeLiveQualificationReceiptDigest(receipt) {
  const body = structuredClone(receipt);
  delete body.receiptDigest;
  return sha256Text(stableStringify(body));
}

export function attachIndependentReviewReceiptDigest(receipt) {
  const next = { ...receipt };
  delete next.receiptDigest;
  next.receiptDigest = computeIndependentReviewReceiptDigest(next);
  return next;
}

export function attachRecordDigest(record) {
  const next = { ...record };
  delete next.recordDigest;
  next.recordDigest = computeRecordDigest(next);
  return next;
}

export function isCanonicalIsoDateTime(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function liveReceiptRelativePath(receipt) {
  return [
    LIVE_RECEIPT_ROOT,
    receipt.authorityMode,
    `${receipt.sourceInventoryDigest.slice(0, 16)}-${receipt.receiptDigest.slice(0, 16)}.json`
  ].join("/");
}

function fixedLiveReceiptScenarioProjection(scenarios) {
  return scenarios.map((scenario) => ({
    id: scenario.id,
    spawnInvocationCount: scenario.spawnInvocationCount,
    spawnReplayCount: scenario.spawnReplayCount,
    providerLaunchCount: scenario.providerLaunchCount,
    providerTerminalCount: scenario.providerTerminalCount,
    workerTerminalCount: scenario.workerTerminalCount,
    resultReadCount: scenario.resultReadCount,
    reconnectCount: scenario.reconnectCount,
    cancelInvocationCount: scenario.cancelInvocationCount,
    cancelReplayCount: scenario.cancelReplayCount,
    uniqueCancelRequestCount: scenario.uniqueCancelRequestCount,
    cancellationEventCount: scenario.cancellationEventCount,
    duplicateLaunchCount: scenario.duplicateLaunchCount,
    mailbox: scenario.mailbox == null ? null : { ...scenario.mailbox },
    workerHostVerification: scenario.workerHostVerification,
    processGroupGone: scenario.processGroupGone,
    taskRuntimeCleaned: scenario.taskRuntimeCleaned,
    runnerTemporaryArtifactsRemoved: scenario.runnerTemporaryArtifactsRemoved,
    qualificationSessionDeleted: scenario.qualificationSessionDeleted
  }));
}

export function validateLiveQualificationReceipt(receipt, options = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { ok: false, errors: ["Live receipt must be a JSON object."] };
  }

  let serialized;
  try {
    serialized = JSON.stringify(receipt);
  } catch {
    return { ok: false, errors: ["Live receipt is not serializable."] };
  }
  if (Buffer.byteLength(serialized) > MAX_EVIDENCE_RECORD_BYTES) {
    fail(`Live receipt exceeds ${MAX_EVIDENCE_RECORD_BYTES} serialized bytes.`);
  }
  for (const message of boundedEvidenceErrors(receipt, "$receipt")) fail(message);
  if (!exactFields(receipt, LIVE_RECEIPT_FIELDS)) {
    fail("Live receipt fields do not match the fixed v2 manifest.");
  }

  if (receipt.schemaVersion !== LIVE_RECEIPT_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${LIVE_RECEIPT_SCHEMA_VERSION}.`);
  }
  if (receipt.producerId !== LIVE_RECEIPT_PRODUCER_ID
    || receipt.producerVersion !== LIVE_RECEIPT_PRODUCER_VERSION) {
    fail("Live receipt producer identity is invalid.");
  }
  if (receipt.manifestDigest !== computeLiveReceiptManifestDigest()) {
    fail("Live receipt manifestDigest does not match the code-owned manifest.");
  }

  const config = LIVE_RECEIPT_AUTHORITY_CONFIG[receipt.authorityMode];
  if (!config) {
    fail("Live receipt authorityMode is invalid.");
  } else {
    if (receipt.phase !== config.phase) {
      fail("Live receipt phase does not match its authority mode.");
    }
    if (!config.installationMethods.includes(receipt.installationMethod)) {
      fail("Live receipt installationMethod is not allowed for its authority mode.");
    }
  }

  if (typeof receipt.pluginVersion !== "string"
    || !LIVE_RECEIPT_RUNTIME_ID.test(receipt.pluginVersion)) {
    fail("Live receipt pluginVersion is invalid.");
  }
  for (const field of ["headCommit", "headTree"]) {
    if (!/^[0-9a-f]{40}$/.test(receipt[field] || "")) {
      fail(`Live receipt ${field} must be a full 40-char SHA.`);
    }
  }
  for (const field of [
    "sourceInventoryDigest",
    "phaseScopeDigest",
    "repositoryBeforeDigest",
    "repositoryAfterDigest",
    "sourcePluginInventoryDigest",
    "installedPluginInventoryDigest",
    "installedEntrypointDigest",
    "providerCapabilityDigest",
    "providerBinaryDigest"
  ]) {
    if (!SHA256.test(receipt[field] || "")) {
      fail(`Live receipt ${field} must be sha256 hex.`);
    }
  }
  if (receipt.repositoryBeforeDigest !== receipt.sourceInventoryDigest
    || receipt.repositoryAfterDigest !== receipt.sourceInventoryDigest) {
    fail("Live receipt repository before/after digests must equal the bound source inventory.");
  }
  if (receipt.sourcePluginInventoryDigest !== receipt.installedPluginInventoryDigest) {
    fail("Live receipt source and installed plugin inventory digests differ.");
  }
  if (!Number.isInteger(receipt.installedFileCount)
    || receipt.installedFileCount < 1
    || receipt.installedFileCount > MAX_LIVE_PLUGIN_FILES) {
    fail("Live receipt installedFileCount is invalid.");
  }
  if (config
    && JSON.stringify(receipt.observedProviderCapabilities)
      !== JSON.stringify(config.observedProviderCapabilities)) {
    fail("Live receipt observedProviderCapabilities do not match the exact provider capability manifest.");
  }
  if (config
    && JSON.stringify(receipt.observedToolIds)
      !== JSON.stringify(config.observedToolIds)) {
    fail("Live receipt observedToolIds do not match the exact authority-specific operation manifest.");
  }
  for (const field of ["providerVersion", "providerRevision"]) {
    if (typeof receipt[field] !== "string"
      || !LIVE_RECEIPT_RUNTIME_ID.test(receipt[field])) {
      fail(`Live receipt ${field} is invalid.`);
    }
  }
  if (receipt.providerRevision
    !== `binary-sha256-${receipt.providerBinaryDigest}`) {
    fail("Live receipt providerRevision does not match its provider binary digest.");
  }
  if (receipt.mcpProtocolVersion !== LIVE_RECEIPT_MANIFEST.mcpProtocolVersion) {
    fail("Live receipt mcpProtocolVersion does not match the code-owned manifest.");
  }
  if (config?.codexHostIdentity) {
    if (!SHA256.test(receipt.codexBinaryDigest || "")) {
      fail("Natural live receipt codexBinaryDigest must be sha256 hex.");
    }
    if (typeof receipt.codexVersion !== "string"
      || !LIVE_RECEIPT_RUNTIME_ID.test(receipt.codexVersion)) {
      fail("Natural live receipt codexVersion is invalid.");
    }
    if (receipt.codexModel !== null
      && (typeof receipt.codexModel !== "string"
        || !LIVE_RECEIPT_RUNTIME_ID.test(receipt.codexModel))) {
      fail("Natural live receipt codexModel must be null or a bounded runtime identity.");
    }
    if (!SHA256.test(receipt.hostTaskDigest || "")) {
      fail("Natural live receipt hostTaskDigest must be sha256 hex.");
    }
  } else if (receipt.codexBinaryDigest !== null
    || receipt.codexVersion !== null
    || receipt.codexModel !== null
    || receipt.hostTaskDigest !== null) {
    fail("Synthetic direct-MCP authority cannot contain or claim Codex host identity.");
  }

  if (!Array.isArray(receipt.scenarios)) {
    fail("Live receipt scenarios must be an array.");
  } else {
    for (const [index, scenario] of receipt.scenarios.entries()) {
      if (!exactFields(scenario, LIVE_RECEIPT_SCENARIO_FIELDS)) {
        fail(`Live receipt scenarios[${index}] fields are invalid.`);
        continue;
      }
      if (typeof scenario.id !== "string" || !scenario.id) {
        fail(`Live receipt scenarios[${index}].id is invalid.`);
      }
      for (const field of LIVE_RECEIPT_SCENARIO_COUNT_FIELDS) {
        if (!Number.isInteger(scenario[field])
          || scenario[field] < 0
          || scenario[field] > 8) {
          fail(`Live receipt scenarios[${index}].${field} is invalid.`);
        }
      }
      for (const field of LIVE_RECEIPT_SCENARIO_BOOLEAN_FIELDS) {
        if (typeof scenario[field] !== "boolean") {
          fail(`Live receipt scenarios[${index}].${field} must be boolean.`);
        }
      }
      if (scenario.workerHostVerification !== "not_run") {
        fail(`Live receipt scenarios[${index}].workerHostVerification must be not_run.`);
      }
      if (scenario.id === "authenticated-completion") {
        const mailbox = scenario.mailbox;
        if (!exactFields(mailbox, LIVE_RECEIPT_MAILBOX_FIELDS)) {
          fail(`Live receipt scenarios[${index}].mailbox fields are invalid.`);
        } else {
          for (const field of [...LIVE_RECEIPT_MAILBOX_FIELDS].filter(
            (candidate) => candidate !== "closed"
          )) {
            if (!Number.isInteger(mailbox[field])
              || mailbox[field] < 0
              || mailbox[field] > 32) {
              fail(`Live receipt scenarios[${index}].mailbox.${field} is invalid.`);
            }
          }
          if (mailbox.closed !== true) {
            fail(`Live receipt scenarios[${index}].mailbox.closed must be true.`);
          }
          if (mailbox.providerGenerationCount !== scenario.providerLaunchCount
            || mailbox.promptCount
              !== 1 + mailbox.deliveredCount + mailbox.deliveryUnknownCount
            || mailbox.acceptedCount
              !== mailbox.deliveredCount
                + mailbox.deliveryUnknownCount
                + mailbox.rejectedCount
            || mailbox.sendInvocationCount
              !== mailbox.acceptedCount + mailbox.sendReplayCount
            || mailbox.finalReportSequence !== mailbox.deliveredCount
            || mailbox.replayPromptDelta !== 0
            || mailbox.retainedBodyCount !== 0) {
            fail(`Live receipt scenarios[${index}].mailbox cross-bindings are invalid.`);
          }
        }
      } else if (scenario.mailbox !== null) {
        fail(`Live receipt scenarios[${index}].mailbox must be null.`);
      }
    }
    if (config && stableStringify(fixedLiveReceiptScenarioProjection(receipt.scenarios))
      !== stableStringify(config.scenarios)) {
      fail("Live receipt scenario order, lifecycle counts, or cleanup outcomes do not match the authority manifest.");
    }
  }
  if (receipt.outcome !== "pass") fail("Live receipt outcome must be pass.");
  for (const field of ["startedAt", "endedAt"]) {
    if (!isCanonicalIsoDateTime(receipt[field])) {
      fail(`Live receipt ${field} must be a canonical date-time.`);
    }
  }
  if (isCanonicalIsoDateTime(receipt.startedAt)
    && isCanonicalIsoDateTime(receipt.endedAt)
    && Date.parse(receipt.endedAt) < Date.parse(receipt.startedAt)) {
    fail("Live receipt endedAt precedes startedAt.");
  }
  if (!SHA256.test(receipt.receiptDigest || "")
    || receipt.receiptDigest !== computeLiveQualificationReceiptDigest(receipt)) {
    fail("Live receipt receiptDigest does not match its canonical body.");
  }

  if (options.strict && options.root) {
    let sourceDigestMatches = false;
    try {
      const identity = gitIdentity(options.root);
      const sourceDigest = computeInventoryDigest(options.root, { includeEvidence: false });
      sourceDigestMatches = sourceDigest === receipt.sourceInventoryDigest;
      if (!sourceDigestMatches) {
        fail("Live receipt sourceInventoryDigest is stale.");
      }
      if (!isNonEvidenceTreeClean(options.root)) {
        fail("Live receipt replay requires a clean non-evidence source tree.");
      }
      if (receipt.headCommit !== identity.headCommit && !sourceDigestMatches) {
        fail("Live receipt headCommit does not match current source.");
      }
      if (receipt.headTree !== identity.headTree && !sourceDigestMatches) {
        fail("Live receipt headTree does not match current source.");
      }
      if (config
        && computePhaseScopeDigest(config.phase, options.root) !== receipt.phaseScopeDigest) {
        fail("Live receipt phaseScopeDigest is stale.");
      }
      const sourcePlugin = captureLivePluginInventory(path.join(options.root, "plugins/grok"));
      if (sourcePlugin.digest !== receipt.sourcePluginInventoryDigest
        || sourcePlugin.fileCount !== receipt.installedFileCount) {
        fail("Live receipt source plugin inventory no longer matches its installed-artifact binding.");
      }
      if (sourcePlugin.pluginVersion !== receipt.pluginVersion) {
        fail("Live receipt pluginVersion is stale.");
      }
      if (sourcePlugin.installedEntrypointDigest !== receipt.installedEntrypointDigest) {
        fail("Live receipt installed entrypoint does not match current source.");
      }
    } catch {
      fail("Live receipt current source identity could not be verified.");
    }
  }

  return { ok: errors.length === 0, errors };
}

export function loadLiveReceiptReference(reference, authorityMode, root) {
  if (!exactFields(reference, LIVE_RECEIPT_REFERENCE_FIELDS)
    || typeof reference.path !== "string"
    || !SHA256.test(reference.receiptDigest || "")) {
    throw invalidLiveQualificationPublicationError();
  }
  const prefix = `${LIVE_RECEIPT_ROOT}/${authorityMode}/`;
  if (!reference.path.startsWith(prefix)
    || reference.path.includes("\\")
    || reference.path.split("/").includes("..")) {
    throw invalidLiveQualificationPublicationError();
  }
  let receipt;
  try {
    const absolute = path.join(root, ...reference.path.split("/"));
    receipt = JSON.parse(readBoundedEvidenceFile(root, absolute));
  } catch {
    throw invalidLiveQualificationPublicationError();
  }
  const validation = validateLiveQualificationReceipt(receipt, { strict: true, root });
  if (!validation.ok
    || receipt.authorityMode !== authorityMode
    || receipt.receiptDigest !== reference.receiptDigest
    || liveReceiptRelativePath(receipt) !== reference.path) {
    throw invalidLiveQualificationPublicationError();
  }
  return receipt;
}

export function receiptMatchesRecordSource(receipt, record) {
  return Boolean(receipt
    && record?.source
    && receipt.headCommit === record.source.headCommit
    && receipt.headTree === record.source.headTree
    && receipt.sourceInventoryDigest === record.source.sourceInventoryDigest);
}

export function receiptsShareRuntimeIdentity(left, right) {
  return JSON.stringify(left?.observedProviderCapabilities)
    === JSON.stringify(right?.observedProviderCapabilities)
    && [
    "headCommit",
    "headTree",
    "sourceInventoryDigest",
    "pluginVersion",
    "sourcePluginInventoryDigest",
    "installedPluginInventoryDigest",
    "installedFileCount",
    "installedEntrypointDigest",
    "providerCapabilityDigest",
    "providerBinaryDigest",
    "providerVersion",
    "providerRevision",
    "mcpProtocolVersion"
    ].every((field) => left?.[field] === right?.[field]);
}

function promotedPhaseOneMatchesOriginal(record, original, attestation) {
  if (record?.phase !== "1"
    || record?.status !== "verified_on_draft"
    || record?.recordedAt !== attestation?.endedAt
    || original?.phase !== "1"
    || original?.status !== "implemented_unverified"
    || original?.authorities?.independentValidation !== "not_run"
    || record?.authorities?.independentValidation !== "pass") return false;
  let promotedBody;
  let originalBody;
  try {
    promotedBody = structuredClone(record);
    originalBody = structuredClone(original);
  } catch {
    return false;
  }
  for (const body of [promotedBody, originalBody]) {
    delete body.recordDigest;
    delete body.status;
    delete body.recordedAt;
    delete body.independentReviewReceipt;
    if (body.authorities && typeof body.authorities === "object") {
      body.authorities.independentValidation = "not_run";
    }
  }
  return stableStringify(promotedBody) === stableStringify(originalBody);
}

export function loadSignedReviewArtifacts(receipt, record, root, trust, services = null) {
  if (!trust || typeof trust !== "object" || Array.isArray(trust)) {
    throw fixedEvidenceError("E_REVIEW_TRUST_UNAVAILABLE", "Protected review trust is unavailable.");
  }
  const requestReference = receipt.reviewRequest;
  const attestationReference = receipt.attestation;
  if (!exactFields(requestReference, SIGNED_REVIEW_REFERENCE_FIELDS)
    || !exactFields(attestationReference, SIGNED_REVIEW_REFERENCE_FIELDS)
    || !normalizedReviewArtifactPath(
      requestReference.path,
      REVIEW_REQUEST_ROOT,
      new RegExp(`^${REVIEW_REQUEST_ROOT}/[0-9a-f]{16}-[0-9a-f]{16}\\.json$`)
    )
    || !normalizedReviewArtifactPath(
      attestationReference.path,
      REVIEW_ATTESTATION_ROOT,
      new RegExp(`^${REVIEW_ATTESTATION_ROOT}/[0-9a-f]{16}-[0-9a-f]{16}\\.json$`)
    )
    || !SHA256.test(requestReference.digest || "")
    || !SHA256.test(attestationReference.digest || "")) {
    throw fixedEvidenceError("E_REVIEW_ATTESTATION_INVALID", "Signed review references are invalid.");
  }
  let requestSnapshot;
  let attestationSnapshot;
  let request;
  let attestation;
  try {
    requestSnapshot = readBoundedEvidenceFileSnapshot(
      root,
      path.join(root, ...requestReference.path.split("/"))
    );
    attestationSnapshot = readBoundedEvidenceFileSnapshot(
      root,
      path.join(root, ...attestationReference.path.split("/"))
    );
    request = JSON.parse(requestSnapshot.contents);
    attestation = JSON.parse(attestationSnapshot.contents);
  } catch {
    throw fixedEvidenceError("E_REVIEW_ATTESTATION_INVALID", "Signed review artifacts are unreadable or unsafe.");
  }
  if (request.requestDigest !== requestReference.digest
    || requestReference.path !== reviewRequestRelativePath(request)
    || attestation.attestationDigest !== attestationReference.digest
    || attestationReference.path !== reviewAttestationRelativePath(attestation)) {
    throw fixedEvidenceError("E_REVIEW_ATTESTATION_INVALID", "Signed review artifact paths or digests are mismatched.");
  }
  const requestValidation = validatePhaseOneReviewRequestInternal(request, {
    root,
    now: trust.now,
    requireFresh: trust.requireFresh === true,
    requireCurrentProof: false,
    allowEvidenceOnlyIdentityDrift: trust.requireFresh !== true
  }, services);
  if (!requestValidation.ok) {
    throw fixedEvidenceError("E_REVIEW_REQUEST_INVALID", "Signed review request is stale or invalid.");
  }
  const attestationValidation = validateIndependentReviewAttestation(attestation, {
    request,
    requestPath: requestReference.path,
    publicKey: trust.publicKey,
    expectedIssuer: trust.expectedIssuer,
    revokedKeyFingerprints: trust.revokedKeyFingerprints || [],
    now: trust.now,
    requireFreshRequest: trust.requireFresh === true
  });
  if (!attestationValidation.ok) {
    throw fixedEvidenceError("E_REVIEW_ATTESTATION_INVALID", "Signed review attestation is invalid.");
  }
  let original;
  try {
    original = JSON.parse(readBoundedEvidenceFile(
      root,
      path.join(root, ...request.proof.path.split("/"))
    ));
  } catch {
    throw fixedEvidenceError("E_REVIEW_ATTESTATION_INVALID", "Original Phase 1 proof is unavailable.");
  }
  if (receipt.issuer !== attestation.issuer
    || receipt.keyFingerprint !== attestation.keyFingerprint
    || !promotedPhaseOneMatchesOriginal(record, original, attestation)
    || record.source?.headCommit !== request.source.headCommit
    || record.source?.headTree !== request.source.headTree
    || record.source?.sourceInventoryDigest !== request.source.sourceInventoryDigest
    || record.source?.phaseScopeDigest !== request.source.phaseScopeDigest
    || record.prerequisites?.length !== 1
    || record.prerequisites[0]?.recordDigest !== request.prerequisite.recordDigest) {
    throw fixedEvidenceError("E_REVIEW_ATTESTATION_INVALID", "Promoted Phase 1 record does not match the signed review.");
  }
  return {
    request,
    attestation,
    original,
    requestSnapshot,
    attestationSnapshot
  };
}
