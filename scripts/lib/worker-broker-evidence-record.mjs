/** Internal Worker Broker evidence record domain. */
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
  AUTHORITIES_FIELDS,
  BOOLEAN_MEASUREMENT_FIELDS,
  CI_FIELDS,
  CI_JOB_FIELDS,
  EVIDENCE_ROOT,
  EVIDENCE_SCHEMA_VERSION,
  INDEPENDENT_REVIEW_MANIFEST_DIGEST,
  INDEPENDENT_REVIEW_PRODUCER_ID,
  INDEPENDENT_REVIEW_PRODUCER_VERSION,
  INDEPENDENT_REVIEW_RECEIPT_V1_FIELDS,
  INDEPENDENT_REVIEW_RECEIPT_V2_FIELDS,
  INSTALLATION_FIELDS,
  ISSUE_URL,
  LIMITS_FIELDS,
  LIVE_QUALIFICATION_RECEIPTS_FIELDS,
  LIVE_RECEIPT_AUTHORITY_NATURAL,
  LIVE_RECEIPT_AUTHORITY_SYNTHETIC,
  LIVE_RECEIPT_REFERENCE_FIELDS,
  LIVE_RECEIPT_SCENARIO_IDS,
  LIVE_SCENARIO_FIELDS,
  MAX_EVIDENCE_RECORD_BYTES,
  MAX_PHASE_SCOPE_PATHS,
  MEASUREMENT_FIELDS,
  NUMERIC_MEASUREMENT_FIELDS,
  OUTCOME_SET,
  PHASE_MANDATORY_GATE_IDS,
  PHASE_PREREQUISITES,
  PHASE_PROOF_GATE_MANIFEST,
  PHASE_THREE_SLICE,
  PHASE_TWO_SLICE,
  PROOF_PRODUCER_FIELDS,
  PROOF_PRODUCER_ID,
  PROOF_PRODUCER_VERSION,
  QUALIFICATION_BOUNDARIES,
  RECORD_TOP_LEVEL_FIELDS,
  REPO_ROOT,
  ROADMAP_VERSION,
  RUNTIME_FIELDS,
  SCENARIO_FIELDS,
  SHA256,
  SIGNED_REVIEW_RECEIPT_PRODUCER_ID,
  SIGNED_REVIEW_RECEIPT_PRODUCER_VERSION,
  SIGNED_REVIEW_RECEIPT_SCHEMA_VERSION,
  SOURCE_FIELDS,
  STATUS_SET,
  VERIFICATION_FIELDS,
  VERIFIED_STATUS_SET,
  computeProofManifestDigest,
  isEvidenceOnlyPath,
  proofProducedStatusIsCurrent
} from "./worker-broker-evidence-core.mjs";
import {
  boundedEvidenceErrors,
  ensureEvidenceDirectory,
  exactFields,
  invalidEvidencePublicationError,
  isIsoDateTime,
  publishImmutableEvidenceFile,
  rawEvidenceValueIsSafe,
  readBoundedEvidenceFile,
  unexpectedFields
} from "./worker-broker-evidence-files.mjs";
import {
  computeInventoryDigest,
  computePhaseScopeDigest,
  gitIdentity,
  isNonEvidenceTreeClean,
  phaseScopePaths,
  runtimeSnapshot
} from "./worker-broker-evidence-inventory.mjs";
import {
  attachRecordDigest,
  computeIndependentReviewReceiptDigest,
  computeRecordDigest,
  loadLiveReceiptReference,
  loadSignedReviewArtifacts,
  receiptMatchesRecordSource,
  receiptsShareRuntimeIdentity
} from "./worker-broker-evidence-review.mjs";
import {
  defaultQualification,
  hasPassedBoundary,
  passedGateIds
} from "./worker-broker-evidence-toolchain.mjs";

function validateRecordHeaderAndSource(record, options, fail) {
  const serializedBytes = Buffer.byteLength(JSON.stringify(record));
  if (serializedBytes > MAX_EVIDENCE_RECORD_BYTES) {
    fail(`Record exceeds ${MAX_EVIDENCE_RECORD_BYTES} serialized bytes.`);
  }
  for (const message of boundedEvidenceErrors(record)) fail(message);

  if (unexpectedFields(record, RECORD_TOP_LEVEL_FIELDS).length) {
    fail("Record contains unsupported top-level fields. Raw/private evidence is forbidden.");
  }

  if (record.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${EVIDENCE_SCHEMA_VERSION}.`);
  }
  if (record.roadmapVersion !== ROADMAP_VERSION) {
    fail(`roadmapVersion must be ${ROADMAP_VERSION}.`);
  }
  if (record.issue !== ISSUE_URL) fail("issue URL must match #25.");
  if (record.pullRequest != null && typeof record.pullRequest !== "string") {
    fail("pullRequest must be null or string.");
  }
  if (!["worker-broker-slice", "worker-broker-aggregate"].includes(record.recordType)) {
    fail("recordType is invalid.");
  }
  if (typeof record.phase !== "string"
    || !["0", "1", "2", "3", "4", "5", "aggregate"].includes(record.phase)) {
    fail("phase is invalid.");
  }
  if (typeof record.slice !== "string" || !record.slice) fail("slice is required.");
  if (!STATUS_SET.has(record.status)) fail("status is invalid.");
  if (!isIsoDateTime(record.recordedAt)) fail("recordedAt must be a valid date-time.");
  const phase = String(record.phase ?? "");
  if ((phase === "aggregate") !== (record.recordType === "worker-broker-aggregate")) {
    fail("recordType must be worker-broker-aggregate if and only if phase is aggregate.");
  }
  if (record.status === "qualified" && phase !== "aggregate") {
    fail("Only aggregate evidence may use status qualified.");
  }
  if (typeof record.releaseQualification !== "boolean") {
    fail("releaseQualification must be boolean.");
  }
  if (typeof record.evidenceSystemQualification !== "boolean") {
    fail("evidenceSystemQualification must be boolean.");
  }
  if (typeof record.provisionalSupportingRecord !== "boolean") {
    fail("provisionalSupportingRecord must be boolean.");
  }

  const hasProofProducer = Object.hasOwn(record, "proofProducer");
  const proofProducer = record.proofProducer;
  let proofProducerValid = false;
  if (hasProofProducer) {
    if (!proofProducer || typeof proofProducer !== "object" || Array.isArray(proofProducer)) {
      fail("proofProducer must be an object when present.");
    } else {
      if (unexpectedFields(proofProducer, PROOF_PRODUCER_FIELDS).length) {
        fail("proofProducer contains unsupported fields.");
      }
      if (proofProducer.id !== PROOF_PRODUCER_ID) {
        fail("proofProducer.id is invalid.");
      }
      if (proofProducer.version !== PROOF_PRODUCER_VERSION) {
        fail("proofProducer.version is invalid.");
      }
      let expectedManifestDigest = null;
      try {
        expectedManifestDigest = computeProofManifestDigest(phase);
      } catch {
        fail(`No proof-producing gate manifest exists for phase ${phase}.`);
      }
      if (!SHA256.test(proofProducer.manifestDigest || "")) {
        fail("proofProducer.manifestDigest must be sha256 hex.");
      } else if (expectedManifestDigest && proofProducer.manifestDigest !== expectedManifestDigest) {
        fail("proofProducer.manifestDigest does not match the code-owned gate manifest.");
      }
      proofProducerValid = Boolean(
        proofProducer.id === PROOF_PRODUCER_ID
        && proofProducer.version === PROOF_PRODUCER_VERSION
        && expectedManifestDigest
        && proofProducer.manifestDigest === expectedManifestDigest
      );
    }
  }

  const qualification = record.qualification;
  if (!qualification || typeof qualification !== "object" || Array.isArray(qualification)) {
    fail("qualification is required and must separate deterministic, installedHost, provider, and release boundaries.");
  } else {
    const allowed = new Set(QUALIFICATION_BOUNDARIES);
    if (unexpectedFields(qualification, allowed).length) {
      fail("qualification contains unsupported fields.");
    }
    for (const boundary of QUALIFICATION_BOUNDARIES) {
      if (!OUTCOME_SET.has(qualification[boundary])) {
        fail(`qualification.${boundary} must be pass, fail, skip, or not_run.`);
      }
    }
  }

  const hasLiveQualificationReceipts = Object.hasOwn(record, "liveQualificationReceipts");
  const liveQualificationReceipts = record.liveQualificationReceipts;
  if (hasLiveQualificationReceipts) {
    if (!exactFields(liveQualificationReceipts, LIVE_QUALIFICATION_RECEIPTS_FIELDS)) {
      fail("liveQualificationReceipts must contain the exact synthetic and natural receipt slots.");
    } else {
      for (const field of LIVE_QUALIFICATION_RECEIPTS_FIELDS) {
        const reference = liveQualificationReceipts[field];
        if (reference !== null
          && !exactFields(reference, LIVE_RECEIPT_REFERENCE_FIELDS)) {
          fail(`liveQualificationReceipts.${field} must be null or an exact receipt reference.`);
          continue;
        }
        if (reference !== null) {
          if (typeof reference.path !== "string" || !reference.path) {
            fail(`liveQualificationReceipts.${field}.path is required.`);
          }
          if (!SHA256.test(reference.receiptDigest || "")) {
            fail(`liveQualificationReceipts.${field}.receiptDigest must be sha256 hex.`);
          }
        }
      }
    }
  }

  const source = record.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    fail("source is required.");
  } else {
    if (unexpectedFields(source, SOURCE_FIELDS).length) {
      fail("source contains unsupported fields.");
    }
    for (const field of [
      "pluginVersion",
      "headCommit",
      "headTree",
      "sourceInventoryDigest",
      "phaseScopeDigest",
      "cleanTreeAtVerification"
    ]) {
      if (source[field] === undefined || source[field] === null || source[field] === "") {
        fail(`source.${field} is required.`);
      }
    }
    if (source.headCommit && !/^[0-9a-f]{40}$/.test(source.headCommit)) {
      fail("source.headCommit must be a full 40-char SHA.");
    }
    if (source.headTree && !/^[0-9a-f]{40}$/.test(source.headTree)) {
      fail("source.headTree must be a full 40-char SHA.");
    }
    if (source.sourceInventoryDigest && !/^[0-9a-f]{64}$/.test(source.sourceInventoryDigest)) {
      fail("source.sourceInventoryDigest must be sha256 hex.");
    }
    if (source.phaseScopeDigest && !/^[0-9a-f]{64}$/.test(source.phaseScopeDigest)) {
      fail("source.phaseScopeDigest must be sha256 hex.");
    }
    if (source.cleanTreeAtVerification !== true && source.cleanTreeAtVerification !== false) {
      fail("source.cleanTreeAtVerification must be boolean.");
    }
    if (typeof source.pluginVersion !== "string" || !source.pluginVersion) {
      fail("source.pluginVersion must be a nonempty string.");
    }
    if (source.foundationCommit != null && typeof source.foundationCommit !== "string") {
      fail("source.foundationCommit must be null or string.");
    }
    if (!Array.isArray(source.phaseScopePaths)
      || source.phaseScopePaths.some((relative) => typeof relative !== "string" || !relative)) {
      fail("source.phaseScopePaths must contain only nonempty strings.");
    } else {
      if (source.phaseScopePaths.length > MAX_PHASE_SCOPE_PATHS) {
        fail(`source.phaseScopePaths exceeds ${MAX_PHASE_SCOPE_PATHS} items.`);
      }
      const normalizedScope = [...new Set(source.phaseScopePaths)].sort();
      if (JSON.stringify(source.phaseScopePaths) !== JSON.stringify(normalizedScope)
        || source.phaseScopePaths.some((relative) => isEvidenceOnlyPath(relative))) {
        fail("source.phaseScopePaths must be sorted, unique, and exclude evidence-only paths.");
      }
      const scopeRoot = options.root || (phase === "aggregate" ? null : REPO_ROOT);
      if (scopeRoot) {
        const expectedScope = phaseScopePaths(phase, scopeRoot);
        if (JSON.stringify(source.phaseScopePaths) !== JSON.stringify(expectedScope)) {
          fail("source.phaseScopePaths does not match the derived phase scope.");
        }
      }
    }
  }
  return proofProducerValid;
}

function validateRecordReviewAndRuntime(record, options, services, fail) {
  const phase = String(record.phase ?? "");
  const source = record.source;
  const hasIndependentReviewReceipt = Object.hasOwn(record, "independentReviewReceipt");
  const independentReviewReceipt = record.independentReviewReceipt;
  if (hasIndependentReviewReceipt) {
    if (phase !== "1") {
      fail("independentReviewReceipt is supported only for Phase 1 evidence.");
    }
    if (!VERIFIED_STATUS_SET.has(record.status)
      || record.authorities?.independentValidation !== "pass") {
      fail("independentReviewReceipt requires a verified Phase 1 status and independentValidation=pass.");
    }
    if (!independentReviewReceipt
      || typeof independentReviewReceipt !== "object"
      || Array.isArray(independentReviewReceipt)) {
      fail("independentReviewReceipt must be an object when present.");
    } else if (independentReviewReceipt.schemaVersion === 1) {
      if (unexpectedFields(
        independentReviewReceipt,
        INDEPENDENT_REVIEW_RECEIPT_V1_FIELDS
      ).length) {
        fail("independentReviewReceipt contains unsupported fields.");
      }
      if (independentReviewReceipt.producerId !== INDEPENDENT_REVIEW_PRODUCER_ID
        || independentReviewReceipt.producerVersion !== INDEPENDENT_REVIEW_PRODUCER_VERSION) {
        fail("independentReviewReceipt producer identity is invalid.");
      }
      for (const field of ["manifestDigest", "reviewerRuntimeDigest", "sourceInventoryDigest", "phaseScopeDigest"]) {
        if (!SHA256.test(independentReviewReceipt[field] || "")) {
          fail(`independentReviewReceipt.${field} must be sha256 hex.`);
        }
      }
      if (independentReviewReceipt.manifestDigest !== INDEPENDENT_REVIEW_MANIFEST_DIGEST) {
        fail("independentReviewReceipt.manifestDigest does not match the code-owned review manifest.");
      }
      for (const field of ["headCommit", "headTree"]) {
        if (!/^[0-9a-f]{40}$/.test(independentReviewReceipt[field] || "")) {
          fail(`independentReviewReceipt.${field} must be a full 40-char SHA.`);
        }
      }
      for (const field of ["startedAt", "endedAt"]) {
        if (!isIsoDateTime(independentReviewReceipt[field])) {
          fail(`independentReviewReceipt.${field} must be a valid date-time.`);
        }
      }
      if (isIsoDateTime(independentReviewReceipt.startedAt)
        && isIsoDateTime(independentReviewReceipt.endedAt)
        && Date.parse(independentReviewReceipt.endedAt) < Date.parse(independentReviewReceipt.startedAt)) {
        fail("independentReviewReceipt.endedAt precedes startedAt.");
      }
      if (independentReviewReceipt.outcome !== "pass"
        || independentReviewReceipt.unresolvedFindings !== 0) {
        fail("independentReviewReceipt must record pass with zero unresolved findings.");
      }
      if (!SHA256.test(independentReviewReceipt.receiptDigest || "")
        || independentReviewReceipt.receiptDigest
          !== computeIndependentReviewReceiptDigest(independentReviewReceipt)) {
        fail("independentReviewReceipt.receiptDigest does not match its canonical body.");
      }
      const sourceMatches = Boolean(source
        && independentReviewReceipt.headCommit === source.headCommit
        && independentReviewReceipt.headTree === source.headTree
        && independentReviewReceipt.sourceInventoryDigest === source.sourceInventoryDigest
        && independentReviewReceipt.phaseScopeDigest === source.phaseScopeDigest);
      if (!sourceMatches) {
        fail("independentReviewReceipt does not match the exact record source identity.");
      }
      fail("independentReviewReceipt v1 is historical and permanently unauthenticated.");
    } else if (independentReviewReceipt.schemaVersion === SIGNED_REVIEW_RECEIPT_SCHEMA_VERSION) {
      if (unexpectedFields(
        independentReviewReceipt,
        INDEPENDENT_REVIEW_RECEIPT_V2_FIELDS
      ).length
        || independentReviewReceipt.producerId !== SIGNED_REVIEW_RECEIPT_PRODUCER_ID
        || independentReviewReceipt.producerVersion !== SIGNED_REVIEW_RECEIPT_PRODUCER_VERSION
        || typeof independentReviewReceipt.issuer !== "string"
        || !independentReviewReceipt.issuer
        || !SHA256.test(independentReviewReceipt.keyFingerprint || "")
        || !SHA256.test(independentReviewReceipt.receiptDigest || "")
        || independentReviewReceipt.receiptDigest
          !== computeIndependentReviewReceiptDigest(independentReviewReceipt)) {
        fail("Signed independentReviewReceipt v2 structure or digest is invalid.");
      }
      if (services.signedReviewAuthorized !== true) {
        fail("Signed independent review requires protected host trust verification.");
      } else if (!(options.strict && options.root)) {
        fail("Signed independent review requires strict repository replay.");
      } else {
        try {
          loadSignedReviewArtifacts(
            independentReviewReceipt,
            record,
            options.root,
            options.signedReviewTrust,
            services.review
          );
        } catch {
          fail("Signed independent review artifacts or protected trust are invalid.");
        }
      }
    } else {
      fail("independentReviewReceipt.schemaVersion is invalid.");
    }
  }

  const installation = record.installation;
  if (!installation || typeof installation !== "object" || Array.isArray(installation)) {
    fail("installation is required.");
  } else {
    if (unexpectedFields(installation, INSTALLATION_FIELDS).length) {
      fail("installation contains unsupported fields.");
    }
    if (typeof installation.method !== "string" || !installation.method) {
      fail("installation.method is required.");
    }
    if (typeof installation.privateInstallPathRecorded !== "boolean") {
      fail("installation.privateInstallPathRecorded must be boolean.");
    } else if (installation.privateInstallPathRecorded) {
      fail("installation.privateInstallPathRecorded must be false.");
    }
    for (const field of ["sourcePluginInventoryDigest", "installedPluginInventoryDigest"]) {
      if (installation[field] != null && !SHA256.test(installation[field])) {
        fail(`installation.${field} must be null or sha256 hex.`);
      }
    }
    if (installation.installedFileCount != null
      && (!Number.isInteger(installation.installedFileCount) || installation.installedFileCount < 0)) {
      fail("installation.installedFileCount must be null or a nonnegative integer.");
    }
    if (installation.sourceAndInstalledInventoriesEqual != null
      && typeof installation.sourceAndInstalledInventoriesEqual !== "boolean") {
      fail("installation.sourceAndInstalledInventoriesEqual must be null or boolean.");
    }
  }

  if (!record.runtime || typeof record.runtime !== "object" || Array.isArray(record.runtime)) {
    fail("runtime is required.");
  } else {
    if (unexpectedFields(record.runtime, RUNTIME_FIELDS).length) {
      fail("runtime contains unsupported fields.");
    }
    for (const field of ["platform", "architecture", "node", "git"]) {
      if (typeof record.runtime[field] !== "string" || !record.runtime[field]) {
        fail(`runtime.${field} must be a nonempty string.`);
      }
    }
    for (const field of [
      "codexStandalone",
      "codexDesktopBundled",
      "grokBuild",
      "grokBuildRevision",
      "mcpProtocolVersion"
    ]) {
      if (record.runtime[field] != null && typeof record.runtime[field] !== "string") {
        fail(`runtime.${field} must be null or string.`);
      }
    }
  }

  if (!Array.isArray(record.prerequisites)) {
    fail("prerequisites must be an array.");
  } else {
    const seenPrerequisites = new Set();
    for (const [index, prerequisite] of record.prerequisites.entries()) {
      if (!prerequisite || typeof prerequisite !== "object" || Array.isArray(prerequisite)) {
        fail(`prerequisites[${index}] must be an object.`);
        continue;
      }
      if (unexpectedFields(prerequisite, new Set(["phase", "recordDigest", "gateIds"])).length) {
        fail(`prerequisites[${index}] contains unsupported fields.`);
      }
      const prerequisitePhase = prerequisite.phase;
      if (typeof prerequisitePhase !== "string"
        || !Object.hasOwn(PHASE_MANDATORY_GATE_IDS, prerequisitePhase)) {
        fail(`prerequisites[${index}].phase is invalid.`);
      }
      if (seenPrerequisites.has(prerequisitePhase)) {
        fail("prerequisites contains a duplicate phase.");
      }
      seenPrerequisites.add(prerequisitePhase);
      if (!SHA256.test(prerequisite.recordDigest || "")) {
        fail(`prerequisites[${index}].recordDigest must be sha256 hex.`);
      }
      if (!Array.isArray(prerequisite.gateIds) || prerequisite.gateIds.length < 1
        || prerequisite.gateIds.some((gateId) => typeof gateId !== "string" || !gateId)) {
        fail(`prerequisites[${index}].gateIds must contain stable gate IDs.`);
      }
    }
  }
}

function validateRecordCollections(record, fail) {
  if (!Array.isArray(record.verification) || record.verification.length < 1) {
    fail("verification must contain at least one command record.");
  } else {
    const seenGates = new Set();
    for (const [index, entry] of record.verification.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        fail(`verification[${index}] must be an object.`);
        continue;
      }
      if (unexpectedFields(entry, VERIFICATION_FIELDS).length) {
        fail(`verification[${index}] contains forbidden fields; store only bounded digests and assertions.`);
      }
      if (typeof entry.gateId !== "string" || !entry.gateId) {
        fail(`verification[${index}].gateId is required.`);
      } else if (seenGates.has(entry.gateId)) {
        fail(`verification[${index}].gateId is duplicated.`);
      } else {
        seenGates.add(entry.gateId);
      }
      const hasCommand = typeof entry.command === "string" && entry.command.trim().length > 0;
      const hasArgv = Array.isArray(entry.argv)
        && entry.argv.length > 0
        && entry.argv.every((value) => typeof value === "string" && value.length > 0);
      if (hasCommand === hasArgv) {
        fail(`verification[${index}] must contain exactly one of exact command or argv.`);
      }
      if (entry.command != null && typeof entry.command !== "string") {
        fail(`verification[${index}].command must be a string when present.`);
      }
      if (entry.argv != null && (!Array.isArray(entry.argv)
        || entry.argv.length < 1
        || entry.argv.some((value) => typeof value !== "string" || !value))) {
        fail(`verification[${index}].argv must contain only nonempty strings.`);
      }
      if (!entry.boundary || typeof entry.boundary !== "string") {
        fail(`verification[${index}].boundary is required.`);
      }
      for (const field of ["testsPassed", "testsSkipped", "testsFailed"]) {
        if (entry[field] != null && (!Number.isInteger(entry[field]) || entry[field] < 0)) {
          fail(`verification[${index}].${field} must be null or a nonnegative integer.`);
        }
      }
      if (entry.assertions != null && (!Array.isArray(entry.assertions)
        || entry.assertions.some((assertion) => typeof assertion !== "string"))) {
        fail(`verification[${index}].assertions must contain only strings.`);
      }
      for (const field of ["startedAt", "endedAt"]) {
        if (entry[field] != null && typeof entry[field] !== "string") {
          fail(`verification[${index}].${field} must be null or string.`);
        }
      }
      if (entry.exitCode != null && !Number.isInteger(entry.exitCode)) {
        fail(`verification[${index}].exitCode must be null or an integer.`);
      }
      if (entry.outputDigest != null && !SHA256.test(entry.outputDigest)) {
        fail(`verification[${index}].outputDigest must be null or sha256 hex.`);
      }
      if (entry.skipMeaning != null && typeof entry.skipMeaning !== "string") {
        fail(`verification[${index}].skipMeaning must be null or string.`);
      }
      if (!OUTCOME_SET.has(entry.outcome)) {
        fail(`verification[${index}].outcome is invalid.`);
        continue;
      }
      if (entry.outcome === "pass" || entry.outcome === "fail") {
        if (!isIsoDateTime(entry.startedAt)) {
          fail(`verification[${index}].startedAt is required for ${entry.outcome}.`);
        }
        if (!isIsoDateTime(entry.endedAt)) {
          fail(`verification[${index}].endedAt is required for ${entry.outcome}.`);
        }
        if (isIsoDateTime(entry.startedAt) && isIsoDateTime(entry.endedAt)
          && Date.parse(entry.endedAt) < Date.parse(entry.startedAt)) {
          fail(`verification[${index}].endedAt precedes startedAt.`);
        }
        if (!Number.isInteger(entry.exitCode)) {
          fail(`verification[${index}].exitCode is required for ${entry.outcome}.`);
        } else if (entry.outcome === "pass" && entry.exitCode !== 0) {
          fail(`verification[${index}] pass requires exitCode=0.`);
        } else if (entry.outcome === "fail" && entry.exitCode === 0) {
          fail(`verification[${index}] fail requires a nonzero exitCode.`);
        }
        if (!SHA256.test(entry.outputDigest || "")) {
          fail(`verification[${index}].outputDigest is required for ${entry.outcome}.`);
        }
      } else if (typeof entry.skipMeaning !== "string" || !entry.skipMeaning.trim()) {
        fail(`verification[${index}].skipMeaning is required for ${entry.outcome}.`);
      }
    }
  }

  for (const collection of ["scenarios", "liveScenarios"]) {
    if (!Array.isArray(record[collection])) {
      fail(`${collection} must be an array.`);
      continue;
    }
    for (const [index, scenario] of record[collection].entries()) {
      if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) {
        fail(`${collection}[${index}] must be an object.`);
        continue;
      }
      const fields = collection === "scenarios" ? SCENARIO_FIELDS : LIVE_SCENARIO_FIELDS;
      if (unexpectedFields(scenario, fields).length) {
        fail(`${collection}[${index}] contains unsupported fields.`);
      }
      if (!OUTCOME_SET.has(scenario.outcome)) {
        fail(`${collection}[${index}].outcome is invalid.`);
      }
      if (typeof scenario.id !== "string" || !scenario.id) {
        fail(`${collection}[${index}].id is required.`);
      }
      if (collection === "scenarios") {
        if (scenario.boundary != null && typeof scenario.boundary !== "string") {
          fail(`scenarios[${index}].boundary must be null or string.`);
        }
        if (typeof scenario.expected !== "string" || typeof scenario.actual !== "string") {
          fail(`scenarios[${index}] requires expected and actual strings.`);
        }
        if (scenario.measurements != null) {
          if (typeof scenario.measurements !== "object" || Array.isArray(scenario.measurements)) {
            fail(`scenarios[${index}].measurements must be an object.`);
          } else {
            if (unexpectedFields(scenario.measurements, MEASUREMENT_FIELDS).length) {
              fail(`scenarios[${index}].measurements contains unsupported metrics.`);
            }
            for (const [field, value] of Object.entries(scenario.measurements)) {
              if (NUMERIC_MEASUREMENT_FIELDS.has(field)
                && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
                fail(`scenarios[${index}].measurements.${field} must be a nonnegative finite number.`);
              }
              if (BOOLEAN_MEASUREMENT_FIELDS.has(field) && typeof value !== "boolean") {
                fail(`scenarios[${index}].measurements.${field} must be boolean.`);
              }
            }
          }
        }
        if (scenario.negative != null && typeof scenario.negative !== "boolean") {
          fail(`scenarios[${index}].negative must be boolean.`);
        }
      } else {
        if (typeof scenario.boundary !== "string" || !scenario.boundary) {
          fail(`liveScenarios[${index}].boundary is required.`);
        }
        for (const field of ["runtime", "expected", "actual"]) {
          if (scenario[field] != null && typeof scenario[field] !== "string") {
            fail(`liveScenarios[${index}].${field} must be null or string.`);
          }
        }
      }
    }
  }

  if (!record.authorities || typeof record.authorities !== "object" || Array.isArray(record.authorities)) {
    fail("authorities is required.");
  } else {
    if (unexpectedFields(record.authorities, AUTHORITIES_FIELDS).length) {
      fail("authorities contains unsupported fields.");
    }
    for (const field of [
      "workerClaims",
      "runtimeObservations",
      "hostVerification",
      "independentValidation"
    ]) {
      if (typeof record.authorities[field] !== "string") {
        fail(`authorities.${field} is required.`);
      }
    }
  }

  if (!record.limits || typeof record.limits !== "object" || Array.isArray(record.limits)) {
    fail("limits is required.");
  } else {
    if (unexpectedFields(record.limits, LIMITS_FIELDS).length) {
      fail("limits contains unsupported fields.");
    }
    for (const field of ["residualRisks", "unsupportedPlatforms", "invalidationTriggers"]) {
      if (!Array.isArray(record.limits[field])
        || record.limits[field].some((item) => typeof item !== "string")) {
        fail(`limits.${field} must contain only strings.`);
      }
    }
    if (record.limits.liveQualificationGaps != null
      && (!Array.isArray(record.limits.liveQualificationGaps)
        || record.limits.liveQualificationGaps.some((item) => typeof item !== "string"))) {
      fail("limits.liveQualificationGaps must contain only strings.");
    }
    if (record.limits.supersededBy != null && typeof record.limits.supersededBy !== "string") {
      fail("limits.supersededBy must be null or string.");
    }
  }

  if (record.ci != null) {
    if (typeof record.ci !== "object" || Array.isArray(record.ci)) {
      fail("ci must be null or an object.");
    } else {
      if (unexpectedFields(record.ci, CI_FIELDS).length) {
        fail("ci contains unsupported fields.");
      }
      if (record.ci.workflowUrl != null && typeof record.ci.workflowUrl !== "string") {
        fail("ci.workflowUrl must be null or string.");
      }
      if (record.ci.runId != null && typeof record.ci.runId !== "string") {
        fail("ci.runId must be null or string.");
      }
      if (record.ci.attempt != null && !Number.isInteger(record.ci.attempt)) {
        fail("ci.attempt must be null or integer.");
      }
      if (record.ci.jobs != null && !Array.isArray(record.ci.jobs)) {
        fail("ci.jobs must be an array.");
      }
      for (const [index, job] of (record.ci.jobs || []).entries()) {
        if (!job || typeof job !== "object" || Array.isArray(job)) {
          fail(`ci.jobs[${index}] must be an object.`);
          continue;
        }
        if (unexpectedFields(job, CI_JOB_FIELDS).length) {
          fail(`ci.jobs[${index}] contains unsupported fields.`);
        }
        if (typeof job.name !== "string" || !job.name) fail(`ci.jobs[${index}].name is required.`);
        if (!["success", "failure", "skipped", "cancelled"].includes(job.result)) {
          fail(`ci.jobs[${index}].result is invalid.`);
        }
      }
    }
  }
}

function validateRecordProofClaims(record, proofProducerValid, fail) {
  const phase = String(record.phase ?? "");
  const qualification = record.qualification;
  const source = record.source;
  const independentReviewReceipt = record.independentReviewReceipt;
  if (typeof record.recordDigest !== "string" || !SHA256.test(record.recordDigest)) {
    fail("recordDigest is required and must be sha256 hex.");
  } else {
    const expected = computeRecordDigest(record);
    if (record.recordDigest !== expected) {
      fail("recordDigest does not match canonical body.");
    }
  }

  const requiredGates = PHASE_MANDATORY_GATE_IDS[phase] || [];
  const passGates = passedGateIds(record);
  if (qualification?.deterministic === "pass") {
    for (const gateId of requiredGates) {
      if (!passGates.has(gateId)) fail(`Missing passing mandatory gate ${gateId} for phase ${phase}.`);
    }
  }

  if (proofProducerValid) {
    if (!proofProducedStatusIsCurrent(record)) {
      fail("proofProducer-backed evidence has an unsupported phase or status.");
    }
    const manifest = PHASE_PROOF_GATE_MANIFEST[phase] || [];
    if ((record.verification || []).length !== manifest.length) {
      fail("proofProducer-backed evidence requires exactly the code-owned gate manifest.");
    }
    for (const gate of manifest) {
      const entry = (record.verification || []).find((candidate) => candidate?.gateId === gate.gateId);
      if (!entry) continue;
      if (entry.command != null || JSON.stringify(entry.argv) !== JSON.stringify(gate.argv)) {
        fail(`Gate ${gate.gateId} argv does not match the code-owned proof manifest.`);
      }
      if (entry.boundary !== gate.boundary) {
        fail(`Gate ${gate.gateId} boundary does not match the code-owned proof manifest.`);
      }
    }
    if (source?.cleanTreeAtVerification !== true) {
      fail("proofProducer-backed evidence requires source.cleanTreeAtVerification=true.");
    }
    if (record.evidenceSystemQualification !== true) {
      fail("proofProducer-backed evidence requires evidenceSystemQualification=true.");
    }
    if (qualification?.deterministic !== "pass") {
      fail("proofProducer-backed evidence requires qualification.deterministic=pass.");
    }
    for (const [index, entry] of (record.verification || []).entries()) {
      if (entry?.outcome !== "pass") {
        fail(`Proof-produced evidence cannot include verification[${index}] with a non-passing outcome.`);
      }
    }
    for (const [index, scenario] of (record.scenarios || []).entries()) {
      if (scenario?.outcome !== "pass") {
        fail(`Proof-produced evidence cannot include scenarios[${index}] with a non-passing outcome.`);
      }
    }
    if (phase === "2") {
      if (record.slice !== PHASE_TWO_SLICE
        || record.status !== "verified_on_draft") {
        fail(`Phase 2 proofProducer evidence requires fixed slice ${PHASE_TWO_SLICE} and verified_on_draft status.`);
      }
      if (JSON.stringify((record.verification || []).map((entry) => entry?.gateId))
        !== JSON.stringify(PHASE_MANDATORY_GATE_IDS["2"])) {
        fail("Phase 2 proofProducer evidence requires the exact ordered gate manifest.");
      }
      if (JSON.stringify((record.prerequisites || []).map((item) => ({
        phase: String(item?.phase ?? ""),
        gateIds: item?.gateIds
      }))) !== JSON.stringify([
        { phase: "0", gateIds: [...PHASE_MANDATORY_GATE_IDS["0"]] },
        { phase: "1", gateIds: [...PHASE_MANDATORY_GATE_IDS["1"]] }
      ])) {
        fail("Phase 2 proofProducer evidence requires exact ordered Phase 0 and signed Phase 1 prerequisites.");
      }
      if (qualification?.installedHost !== "not_run"
        || qualification?.provider !== "not_run"
        || qualification?.release !== "not_run"
        || record.releaseQualification !== false
        || record.provisionalSupportingRecord !== false
        || Object.hasOwn(record, "liveQualificationReceipts")
        || (record.liveScenarios || []).length !== 0) {
        fail("Phase 2 proofProducer evidence is deterministic-only and cannot link live qualification.");
      }
    }
    if (phase === "3") {
      if (record.slice !== PHASE_THREE_SLICE
        || record.status !== "verified_on_draft") {
        fail(`Phase 3 proofProducer evidence requires fixed slice ${PHASE_THREE_SLICE} and verified_on_draft status.`);
      }
      if (JSON.stringify((record.verification || []).map((entry) => entry?.gateId))
        !== JSON.stringify(PHASE_MANDATORY_GATE_IDS["3"])) {
        fail("Phase 3 proofProducer evidence requires the exact ordered gate manifest.");
      }
      if (JSON.stringify((record.prerequisites || []).map((item) => ({
        phase: String(item?.phase ?? ""),
        gateIds: item?.gateIds
      }))) !== JSON.stringify([
        { phase: "0", gateIds: [...PHASE_MANDATORY_GATE_IDS["0"]] },
        { phase: "1", gateIds: [...PHASE_MANDATORY_GATE_IDS["1"]] }
      ])) {
        fail("Phase 3 proofProducer evidence requires exact ordered Phase 0 and signed Phase 1 prerequisites.");
      }
      if ((record.verification || []).some((entry) => (
        (entry?.testsSkipped ?? 0) !== 0
        || (entry?.testsFailed ?? 0) !== 0
        || entry?.skipMeaning != null
      ))) {
        fail("Phase 3 proofProducer evidence requires a zero-skip, zero-failure gate record.");
      }
      if (qualification?.installedHost !== "not_run"
        || qualification?.provider !== "not_run"
        || qualification?.release !== "not_run"
        || record.releaseQualification !== false
        || record.provisionalSupportingRecord !== false
        || Object.hasOwn(record, "liveQualificationReceipts")
        || (record.liveScenarios || []).length !== 0) {
        fail("Phase 3 proofProducer evidence is deterministic-only and cannot absorb live receipts or claim lifecycle qualification.");
      }
    }
  }

  if (VERIFIED_STATUS_SET.has(record.status)) {
    if (!proofProducerValid) {
      fail(`${record.status} requires exact broker-owned proofProducer provenance.`);
    }
    if (phase === "1"
      && independentReviewReceipt?.schemaVersion !== SIGNED_REVIEW_RECEIPT_SCHEMA_VERSION) {
      fail(`${record.status} Phase 1 evidence requires signed issuer-verified independent review proof.`);
    }
  }
}

function validateRecordLiveQualification(record, options, fail) {
  const phase = String(record.phase ?? "");
  const qualification = record.qualification;
  const liveQualificationReceipts = record.liveQualificationReceipts;
  const source = record.source;
  const installation = record.installation;
  const providerPassRequested = qualification?.provider === "pass";
  const installedHostPassRequested = qualification?.installedHost === "pass";
  const hasSyntheticReference = Boolean(
    exactFields(liveQualificationReceipts, LIVE_QUALIFICATION_RECEIPTS_FIELDS)
    && liveQualificationReceipts.syntheticDirectMcp !== null
  );
  const hasNaturalReference = Boolean(
    exactFields(liveQualificationReceipts, LIVE_QUALIFICATION_RECEIPTS_FIELDS)
    && liveQualificationReceipts.naturalCodexHost !== null
  );
  const hasAnyLiveReference = hasSyntheticReference || hasNaturalReference;
  let syntheticReceipt = null;
  let naturalReceipt = null;

  if (providerPassRequested || installedHostPassRequested || hasAnyLiveReference) {
    const qualifiedAggregate = phase === "aggregate" && record.status === "qualified";
    if (qualifiedAggregate) {
      if (record.provisionalSupportingRecord !== false
        || record.releaseQualification !== true
        || qualification?.release !== "pass") {
        fail("Qualified aggregate live evidence must be non-provisional release qualification.");
      }
    } else {
      if (record.status !== "implemented_unverified") {
        fail("Live receipt/pass supporting records must remain implemented_unverified.");
      }
      if (record.provisionalSupportingRecord !== true) {
        fail("Live receipt/pass supporting records must be provisionalSupportingRecord=true.");
      }
      if (record.releaseQualification !== false
        || qualification?.release === "pass") {
        fail("Live receipt/pass supporting records cannot claim release qualification.");
      }
      if (record.authorities?.hostVerification !== "not_run") {
        fail("Live receipt/pass supporting records must preserve hostVerification=not_run.");
      }
    }
    if (providerPassRequested && !hasSyntheticReference) {
      fail("Provider qualification requires a synthetic-direct-mcp receipt reference.");
    }
    if (!providerPassRequested && hasSyntheticReference) {
      fail("Synthetic live receipt linkage is forbidden without provider qualification pass.");
    }
    if (installedHostPassRequested && (!hasNaturalReference || !hasSyntheticReference)) {
      fail("Installed-host qualification requires both natural-host and synthetic provider receipts.");
    }
    if (!installedHostPassRequested && hasNaturalReference) {
      fail("Natural live receipt linkage is forbidden without installedHost qualification pass.");
    }
    if (providerPassRequested && !["1", "4", "aggregate"].includes(phase)) {
      fail("Provider live qualification may link only to Phase 1, Phase 4, or aggregate evidence.");
    }
    if (installedHostPassRequested
      && (!["4", "aggregate"].includes(phase) || !providerPassRequested)) {
      fail("Natural installed-host qualification may link only to Phase 4 or aggregate evidence with provider pass.");
    }
    if (phase === "1" && installedHostPassRequested) {
      fail("Synthetic Phase 1 evidence cannot claim natural installed-host authority.");
    }
    if (!(options.strict && options.root)) {
      fail("Live qualification pass/linkage requires strict offline receipt replay.");
    } else {
      try {
        if (hasSyntheticReference) {
          syntheticReceipt = loadLiveReceiptReference(
            liveQualificationReceipts.syntheticDirectMcp,
            LIVE_RECEIPT_AUTHORITY_SYNTHETIC,
            options.root
          );
        }
        if (hasNaturalReference) {
          naturalReceipt = loadLiveReceiptReference(
            liveQualificationReceipts.naturalCodexHost,
            LIVE_RECEIPT_AUTHORITY_NATURAL,
            options.root
          );
        }
      } catch {
        fail("Live qualification receipt reference is missing, unsafe, stale, or invalid.");
      }

      for (const receipt of [syntheticReceipt, naturalReceipt].filter(Boolean)) {
        if (!receiptMatchesRecordSource(receipt, record)) {
          fail("Live qualification receipt does not match the exact record source identity.");
        }
      }
      if (phase === "1"
        && syntheticReceipt
        && syntheticReceipt.phaseScopeDigest !== source?.phaseScopeDigest) {
        fail("Phase 1 live receipt does not match the record phase scope.");
      }
      if (phase === "4"
        && naturalReceipt
        && naturalReceipt.phaseScopeDigest !== source?.phaseScopeDigest) {
        fail("Phase 4 natural-host receipt does not match the record phase scope.");
      }
      if (syntheticReceipt
        && naturalReceipt
        && !receiptsShareRuntimeIdentity(syntheticReceipt, naturalReceipt)) {
        fail("Synthetic and natural live receipts do not bind the same source, install, capability, and provider.");
      }

      const installationReceipt = naturalReceipt || syntheticReceipt;
      if (installationReceipt) {
        if (installation?.method !== installationReceipt.installationMethod
          || installation?.sourcePluginInventoryDigest
            !== installationReceipt.sourcePluginInventoryDigest
          || installation?.installedPluginInventoryDigest
            !== installationReceipt.installedPluginInventoryDigest
          || installation?.installedFileCount !== installationReceipt.installedFileCount
          || installation?.sourceAndInstalledInventoriesEqual !== true
          || installation?.sourcePluginInventoryDigest
            !== installation?.installedPluginInventoryDigest) {
          fail("Evidence installation fields do not directly match the live receipt's equal inventories.");
        }
        if (record.runtime?.grokBuild !== installationReceipt.providerVersion
          || record.runtime?.grokBuildRevision !== installationReceipt.providerRevision
          || record.runtime?.mcpProtocolVersion
            !== installationReceipt.mcpProtocolVersion) {
          fail("Evidence provider runtime identity does not match the live receipt.");
        }
        if (naturalReceipt
          && ![
            record.runtime?.codexStandalone,
            record.runtime?.codexDesktopBundled
          ].includes(naturalReceipt.codexVersion)) {
          fail("Evidence Codex host version does not match the natural-host receipt.");
        }
      }

      const expectedLiveScenarios = [
        ...(syntheticReceipt
          ? LIVE_RECEIPT_SCENARIO_IDS[LIVE_RECEIPT_AUTHORITY_SYNTHETIC].map((id) => ({
            id,
            boundary: "provider-live",
            outcome: "pass"
          }))
          : []),
        ...(naturalReceipt
          ? LIVE_RECEIPT_SCENARIO_IDS[LIVE_RECEIPT_AUTHORITY_NATURAL].map((id) => ({
            id,
            boundary: "installed-host",
            outcome: "pass"
          }))
          : [])
      ];
      const actualLiveScenarios = Array.isArray(record.liveScenarios)
        ? record.liveScenarios.map((scenario) => ({
          id: scenario?.id,
          boundary: scenario?.boundary,
          outcome: scenario?.outcome,
          boundedNarrativeOnly: ["runtime", "expected", "actual"].every((field) => (
            scenario?.[field] == null
          ))
        }))
        : [];
      if (JSON.stringify(actualLiveScenarios.map((scenario) => ({
        id: scenario.id,
        boundary: scenario.boundary,
        outcome: scenario.outcome
      }))) !== JSON.stringify(expectedLiveScenarios)
        || actualLiveScenarios.some((scenario) => !scenario.boundedNarrativeOnly)) {
        fail("Evidence liveScenarios do not exactly match the linked bounded receipt scenarios.");
      }
    }
  }
}

function validateRecordQualificationAndStrictState(
  record,
  options,
  proofProducerValid,
  fail
) {
  const phase = String(record.phase ?? "");
  const qualification = record.qualification;
  const source = record.source;
  const installation = record.installation;
  if (record.status === "qualified") {
    if (qualification?.installedHost !== "pass" || qualification?.provider !== "pass") {
      fail("qualified requires installedHost and provider qualification to pass.");
    }
    if (!record.liveScenarios?.length
      || record.liveScenarios.some((scenario) => scenario?.outcome !== "pass")) {
      fail("qualified requires at least one passing live scenario and no skipped live scenarios.");
    }
  }

  if (record.status === "qualified"
    && (record.recordType === "worker-broker-aggregate" || phase === "aggregate")
    && qualification?.release !== "pass") {
    fail("qualified aggregate evidence requires qualification.release=pass.");
  }

  if (qualification?.installedHost === "pass") {
    if (phase !== "aggregate" && !hasPassedBoundary(record, "installed-host")) {
      fail("installedHost qualification requires a passing installed-host command gate.");
    }
    if (!SHA256.test(installation?.sourcePluginInventoryDigest || "")
      || !SHA256.test(installation?.installedPluginInventoryDigest || "")
      || installation?.sourcePluginInventoryDigest
        !== installation?.installedPluginInventoryDigest
      || installation?.sourceAndInstalledInventoriesEqual !== true
      || !Number.isInteger(installation?.installedFileCount)
      || installation.installedFileCount < 1) {
      fail("installedHost qualification requires matching source/install digests and a positive file count.");
    }
  }

  if (qualification?.provider === "pass") {
    if (phase !== "aggregate" && !hasPassedBoundary(record, "provider-live")) {
      fail("provider qualification requires a passing provider-live command gate.");
    }
    if (!record.runtime?.grokBuild || !record.runtime?.grokBuildRevision) {
      fail("provider qualification requires Grok version and revision identity.");
    }
  }

  if (qualification?.release === "pass") {
    if (record.releaseQualification !== true) {
      fail("qualification.release=pass requires releaseQualification=true.");
    }
    if (record.recordType !== "worker-broker-aggregate" || phase !== "aggregate") {
      fail("release qualification requires an aggregate evidence record.");
    }
    if (!hasPassedBoundary(record, "release")) {
      fail("release qualification requires a passing release command gate.");
    }
    if (!record.ci?.jobs?.length || record.ci.jobs.some((job) => job?.result !== "success")) {
      fail("release qualification requires a nonempty all-success CI job matrix.");
    }
  } else if (record.releaseQualification === true) {
    fail("releaseQualification=true requires qualification.release=pass.");
  }

  // Strict mode: bind to current non-evidence source identity when requested.
  // Evidence-only commits may advance HEAD/tree without invalidating records whose
  // sourceInventoryDigest and phaseScopeDigest still match (plan §6.4).
  if (options.strict && options.root) {
    const identity = gitIdentity(options.root);
    if (source?.cleanTreeAtVerification === true && !isNonEvidenceTreeClean(options.root)) {
      fail("Record claims clean tree but non-evidence working tree is dirty.");
    }
    const currentSourceDigest = computeInventoryDigest(options.root, { includeEvidence: false });
    const sourceDigestMatches = source?.sourceInventoryDigest
      && source.sourceInventoryDigest === currentSourceDigest;
    if (source?.sourceInventoryDigest && !sourceDigestMatches) {
      fail("sourceInventoryDigest is stale relative to current non-evidence source inventory.");
    }
    if (source?.phaseScopeDigest && record.phase != null) {
      try {
        const currentPhase = computePhaseScopeDigest(record.phase, options.root);
        if (source.phaseScopeDigest !== currentPhase) {
          fail(`phaseScopeDigest for phase ${record.phase} is stale.`);
        }
      } catch (error) {
        fail(`phaseScopeDigest for phase ${record.phase} cannot be computed: ${error.message}`);
      }
    }
    // headCommit/headTree must match HEAD, unless only evidence-only identity drifted
    // (source digests still match the current non-evidence inventory).
    if (source?.headCommit && source.headCommit !== identity.headCommit) {
      if (!sourceDigestMatches) {
        fail(`Record headCommit ${source.headCommit} does not match current HEAD ${identity.headCommit}.`);
      }
    }
    if (source?.headTree && source.headTree !== identity.headTree) {
      if (!sourceDigestMatches) {
        fail(`Record headTree ${source.headTree} does not match current tree ${identity.headTree}.`);
      }
    }

    if (VERIFIED_STATUS_SET.has(record.status)
      || (record.status === "implemented_unverified" && proofProducerValid)) {
      const expectedPrerequisites = PHASE_PREREQUISITES[phase] || [];
      const actualPrerequisites = new Set((record.prerequisites || []).map((item) => String(item.phase)));
      for (const prerequisitePhase of expectedPrerequisites) {
        if (!actualPrerequisites.has(prerequisitePhase)) {
          fail(`Missing prerequisite evidence digest for phase ${prerequisitePhase}.`);
        }
      }
      for (const prerequisitePhase of actualPrerequisites) {
        if (!expectedPrerequisites.includes(prerequisitePhase)) {
          fail(`Unexpected prerequisite phase ${prerequisitePhase} for phase ${phase}.`);
        }
      }
    }
  }

  if (options.rejectProvisional && record.provisionalSupportingRecord === true) {
    fail("Provisional supporting records cannot satisfy strict qualification.");
  }

  if (options.requireEvidenceSystem && record.evidenceSystemQualification !== true) {
    fail("evidenceSystemQualification must be true for this gate.");
  }

  // Historical promotion guard: qualified status cannot be claimed with dirty/stale flags.
  if (record.status === "qualified") {
    if (source?.cleanTreeAtVerification !== true) {
      fail("qualified records require cleanTreeAtVerification=true.");
    }
    if (record.provisionalSupportingRecord === true) {
      fail("qualified records cannot be provisionalSupportingRecord.");
    }
  }
}

export function validateEvidenceRecordInternal(record, options = {}, services = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, errors: ["Record must be a JSON object."] };
  }

  const proofProducerValid = validateRecordHeaderAndSource(record, options, fail);
  validateRecordReviewAndRuntime(record, options, services, fail);
  validateRecordCollections(record, fail);
  validateRecordProofClaims(record, proofProducerValid, fail);
  validateRecordLiveQualification(record, options, fail);
  validateRecordQualificationAndStrictState(record, options, proofProducerValid, fail);
  return { ok: errors.length === 0, errors };
}

export function validateEvidenceRecord(record, options = {}) {
  return validateEvidenceRecordInternal(record, options, {
    review: null,
    signedReviewAuthorized: false
  });
}

function preparePublicEvidenceRecordForPublication(record) {
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
  const validated = validateEvidenceRecord(body, { strict: false });
  if (!validated.ok
    || VERIFIED_STATUS_SET.has(body.status)
    || Object.hasOwn(body, "proofProducer")
    || Object.hasOwn(body, "independentReviewReceipt")
    || body.qualification?.provider === "pass"
    || body.qualification?.installedHost === "pass"
    || Object.hasOwn(body, "liveQualificationReceipts")) {
    throw invalidEvidencePublicationError();
  }
  return body;
}

export function writeEvidenceRecord(record, root = REPO_ROOT) {
  // Complete validation precedes directory creation, so rejected caller data
  // cannot leave even an empty evidence directory behind.
  const body = preparePublicEvidenceRecordForPublication(record);
  const phase = body.phase;
  const sourceDigest = body.source?.sourceInventoryDigest ?? body.recordDigest;
  if (typeof sourceDigest !== "string"
    || typeof body.recordDigest !== "string"
    || !SHA256.test(sourceDigest)
    || !SHA256.test(body.recordDigest)) {
    throw invalidEvidencePublicationError();
  }
  const directory = path.join(
    root,
    EVIDENCE_ROOT,
    phase === "aggregate" ? "aggregate" : `phase-${phase}`
  );
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

export function buildEvidenceRecord({
  phase,
  slice,
  status = "implemented_unverified",
  root = REPO_ROOT,
  verification = [],
  scenarios = [],
  liveScenarios = [],
  installation = null,
  authorities = null,
  limits = null,
  pullRequest = "https://github.com/xliberty2008x/grok-plugin/pull/26",
  pluginVersion = null,
  evidenceSystemQualification = false,
  provisionalSupportingRecord = false,
  independentReviewReceipt = null,
  releaseQualification = false,
  qualification = null,
  runtime = null,
  prerequisites = [],
  ci = null
} = {}) {
  if (status === "qualified") {
    throw invalidEvidencePublicationError();
  }
  const identity = gitIdentity(root);
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const sourceInventoryDigest = computeInventoryDigest(root, { includeEvidence: false });
  const phaseScopeDigest = computePhaseScopeDigest(phase, root);
  const record = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    roadmapVersion: ROADMAP_VERSION,
    recordType: phase === "aggregate" ? "worker-broker-aggregate" : "worker-broker-slice",
    issue: ISSUE_URL,
    pullRequest,
    phase: String(phase),
    slice,
    status,
    recordedAt: new Date().toISOString(),
    releaseQualification,
    evidenceSystemQualification,
    provisionalSupportingRecord,
    ...(independentReviewReceipt ? { independentReviewReceipt } : {}),
    qualification: qualification || defaultQualification(),
    source: {
      pluginVersion: pluginVersion || packageJson.version,
      foundationCommit: null,
      headCommit: identity.headCommit,
      headTree: identity.headTree,
      sourceInventoryDigest,
      phaseScopeDigest,
      cleanTreeAtVerification: identity.cleanTreeAtVerification,
      phaseScopePaths: phaseScopePaths(phase, root)
    },
    installation: installation || {
      method: "source-tree",
      sourcePluginInventoryDigest: null,
      installedPluginInventoryDigest: null,
      installedFileCount: null,
      sourceAndInstalledInventoriesEqual: null,
      privateInstallPathRecorded: false
    },
    runtime: runtime || runtimeSnapshot(),
    prerequisites,
    verification,
    scenarios,
    liveScenarios,
    ci,
    authorities: authorities || {
      workerClaims: "none",
      runtimeObservations: "deterministic node:test and inventory digests",
      hostVerification: "not_run",
      independentValidation: "not_run"
    },
    limits: limits || {
      residualRisks: [],
      unsupportedPlatforms: ["windows-provider-execution", "linux-provider-unqualified"],
      invalidationTriggers: [
        "source inventory change outside evidence-only paths",
        "phase-scope path change",
        "dirty tree when cleanTreeAtVerification claimed"
      ],
      supersededBy: null,
      liveQualificationGaps: []
    }
  };
  return attachRecordDigest(record);
}
