/** Internal Worker Broker evidence verification domain. */
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
  LEDGER_ENTRY_FIELDS,
  LEDGER_FIELDS,
  MAX_EVIDENCE_ARRAY_ITEMS,
  NUMBERED_PHASES,
  PHASE_MANDATORY_GATE_IDS,
  REPO_ROOT,
  ROADMAP_VERSION,
  SHA256,
  STATUS_SET,
  VERIFIED_STATUS_SET,
  isEvidenceOnlyPath
} from "./worker-broker-evidence-core.mjs";
import {
  boundedEvidenceErrors,
  isIsoDateTime,
  readBoundedEvidenceFile,
  statusSatisfiesPhaseReadiness,
  statusSatisfiesVerifiedPrerequisite,
  unexpectedFields
} from "./worker-broker-evidence-files.mjs";
import {
  computeInventoryDigest,
  listSourceInventory
} from "./worker-broker-evidence-inventory.mjs";
import {
  loadLedger,
  projectLedgerForOutput
} from "./worker-broker-evidence-ledger.mjs";
import {
  computeRecordDigest
} from "./worker-broker-evidence-review.mjs";
import {
  validateEvidenceRecord
} from "./worker-broker-evidence-record.mjs";
import {
  passedGateIds,
  recordCarriesLiveQualification
} from "./worker-broker-evidence-toolchain.mjs";

export function assessCompleteEvidenceChain(records) {
  const errors = [];
  if (!Array.isArray(records)) {
    return { ok: false, errors: ["Release readiness requires exactly seven current evidence records."] };
  }
  const byPhase = new Map();
  for (const record of records) {
    const phase = String(record?.phase ?? "");
    if (!Object.hasOwn(PHASE_MANDATORY_GATE_IDS, phase) || byPhase.has(phase)) {
      errors.push("Release readiness requires exactly one current record for each phase.");
      continue;
    }
    byPhase.set(phase, record);
  }
  if (records.length !== NUMBERED_PHASES.length + 1
    || byPhase.size !== NUMBERED_PHASES.length + 1) {
    errors.push("Release readiness requires exactly seven current evidence records.");
  }
  for (const phase of NUMBERED_PHASES) {
    const record = byPhase.get(phase);
    if (!record) {
      errors.push(`Release readiness requires one current evidence record for phase ${phase}.`);
      continue;
    }
    if (record.status !== "verified_on_draft") {
      errors.push(`Release readiness requires phase ${phase} status verified_on_draft.`);
    }
  }
  const aggregate = byPhase.get("aggregate");
  if (!aggregate) {
    errors.push("Release readiness requires one current evidence record for phase aggregate.");
  } else {
    if (aggregate.status !== "qualified") {
      errors.push("Release readiness requires phase aggregate status qualified.");
    }
    const prerequisites = Array.isArray(aggregate.prerequisites)
      ? aggregate.prerequisites
      : [];
    const prerequisiteByPhase = new Map();
    for (const prerequisite of prerequisites) {
      const prerequisitePhase = String(prerequisite?.phase ?? "");
      if (prerequisiteByPhase.has(prerequisitePhase)) {
        errors.push("Release readiness aggregate prerequisites contain a duplicate phase.");
      } else {
        prerequisiteByPhase.set(prerequisitePhase, prerequisite);
      }
    }
    if (prerequisites.length !== NUMBERED_PHASES.length
      || prerequisiteByPhase.size !== NUMBERED_PHASES.length) {
      errors.push("Release readiness requires aggregate prerequisites for exactly phases 0 through 5.");
    }
    for (const phase of NUMBERED_PHASES) {
      const dependency = byPhase.get(phase);
      const prerequisite = prerequisiteByPhase.get(phase);
      if (!prerequisite) {
        errors.push(`Release readiness aggregate is missing prerequisite phase ${phase}.`);
      } else if (dependency && prerequisite.recordDigest !== dependency.recordDigest) {
        errors.push(`Release readiness aggregate prerequisite phase ${phase} is stale or mismatched.`);
      }
    }
    if (aggregate.qualification?.release !== "pass"
      || aggregate.releaseQualification !== true) {
      errors.push("Release readiness requires aggregate release qualification to pass.");
    }
    if (!aggregate.ci?.jobs?.length
      || aggregate.ci.jobs.some((job) => job?.result !== "success")) {
      errors.push("Release readiness requires a nonempty all-success aggregate CI matrix.");
    }
  }
  return { ok: errors.length === 0, errors };
}

export function verifyLedgerInternal(root = REPO_ROOT, {
  strict = false,
  requireComplete = false,
  signedReviewAuthority = null,
  signedReviewTrust = null
} = {}, validateEvidenceRecord) {
  const effectiveStrict = Boolean(strict || requireComplete);
  let ledger;
  try {
    ledger = loadLedger(root);
  } catch {
    return {
      ok: false,
      errors: ["Ledger is unreadable, unsafe, or exceeds the evidence size bound."],
      ledger: projectLedgerForOutput(null),
      readinessRequired: Boolean(requireComplete),
      readinessReady: false
    };
  }
  const publicLedger = projectLedgerForOutput(ledger);
  const errors = [];
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
    return { ok: false, errors: ["Ledger must be a JSON object."], ledger: publicLedger };
  }
  if (unexpectedFields(ledger, LEDGER_FIELDS).length) {
    errors.push("Ledger contains unsupported top-level fields.");
  }
  // Validate the raw ledger so redaction never turns a forbidden secret/path into
  // an accepted value. boundedEvidenceErrors masks unsupported key names, while
  // the returned ledger remains the allowlisted public projection above.
  for (const message of boundedEvidenceErrors(ledger, "$ledger")) errors.push(message);
  if (ledger.schemaVersion !== 1) errors.push("Ledger schemaVersion must be 1.");
  if (ledger.roadmapVersion !== ROADMAP_VERSION) {
    errors.push(`Ledger roadmapVersion must be ${ROADMAP_VERSION}.`);
  }
  if (ledger.issue !== ISSUE_URL) errors.push("Ledger issue URL must match #25.");
  if (!isIsoDateTime(ledger.updatedAt)) errors.push("Ledger updatedAt must be a valid date-time.");
  if (!Array.isArray(ledger.entries) || !ledger.entries.length) {
    errors.push("Ledger entries must be a nonempty array.");
    return { ok: false, errors, ledger: publicLedger };
  }
  if (ledger.entries.length > MAX_EVIDENCE_ARRAY_ITEMS) {
    errors.push(`Ledger exceeds ${MAX_EVIDENCE_ARRAY_ITEMS} entries.`);
  }
  const currentByPhase = new Map();
  const currentByPhaseSlice = new Set();
  const loaded = [];
  for (const [index, entry] of ledger.entries.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`Ledger entry ${index} must be an object.`);
      continue;
    }
    if (unexpectedFields(entry, LEDGER_ENTRY_FIELDS).length) {
      errors.push(`Ledger entry ${index} contains unsupported fields.`);
    }
    for (const field of [
      "phase",
      "slice",
      "status",
      "path",
      "recordDigest",
      "sourceCommit",
      "currency",
      "recordedAt"
    ]) {
      if (entry[field] === undefined || entry[field] === null || entry[field] === "") {
        errors.push(`Ledger entry ${index} is missing ${field}.`);
      }
    }
    if (typeof entry.phase !== "string"
      || !Object.hasOwn(PHASE_MANDATORY_GATE_IDS, entry.phase)) {
      errors.push(`Ledger entry ${index} has an invalid phase.`);
    }
    for (const field of ["slice", "path"]) {
      if (typeof entry[field] !== "string" || !entry[field]) {
        errors.push(`Ledger entry ${index} has an invalid ${field}.`);
      }
    }
    if (typeof entry.status !== "string" || !STATUS_SET.has(entry.status)) {
      errors.push(`Ledger entry ${index} has invalid status.`);
    }
    if (!['current', 'historical', 'invalidated'].includes(entry.currency)) {
      errors.push(`Ledger entry ${index} has invalid currency.`);
    }
    if (!SHA256.test(entry.recordDigest || "")) {
      errors.push(`Ledger entry ${index} recordDigest must be sha256 hex.`);
    }
    if (!/^[0-9a-f]{40}$/.test(entry.sourceCommit || "")) {
      errors.push(`Ledger entry ${index} sourceCommit must be a full 40-char SHA.`);
    }
    if (!isIsoDateTime(entry.recordedAt)) {
      errors.push(`Ledger entry ${index} recordedAt must be a valid date-time.`);
    }
    if (entry.currency === "current") {
      const phase = String(entry.phase);
      const phaseSlice = `${phase}\0${entry.slice}`;
      if (currentByPhase.has(phase)) {
        errors.push(`Ledger entry ${index} duplicates a current phase.`);
      } else {
        currentByPhase.set(phase, { entry, record: null });
      }
      if (currentByPhaseSlice.has(phaseSlice)) {
        errors.push(`Ledger entry ${index} duplicates a current phase/slice pair.`);
      }
      currentByPhaseSlice.add(phaseSlice);
    }
    if (typeof entry.path !== "string" || !entry.path) {
      errors.push(`Ledger entry ${index} is missing a usable path.`);
      continue;
    }
    const normalizedPath = String(entry.path).replace(/\\/g, "/");
    if (path.isAbsolute(entry.path)
      || normalizedPath.includes("../")
      || !normalizedPath.startsWith(`${EVIDENCE_ROOT}/`)) {
      errors.push(`Ledger entry ${index} has an unsafe evidence path.`);
      continue;
    }
    const absolute = path.resolve(root, entry.path);
    const evidenceRoot = path.resolve(root, EVIDENCE_ROOT);
    if (!absolute.startsWith(`${evidenceRoot}${path.sep}`)) {
      errors.push(`Ledger entry ${index} escapes the evidence root.`);
      continue;
    }
    let record;
    try {
      record = JSON.parse(readBoundedEvidenceFile(root, absolute));
    } catch {
      errors.push(`Ledger entry ${index} references an unreadable, unsafe, or oversized evidence file.`);
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      errors.push(`Ledger entry ${index} evidence record must be a JSON object.`);
      continue;
    }
    const rawSafetyErrors = boundedEvidenceErrors(record, "$record");
    if (rawSafetyErrors.length) {
      errors.push(...rawSafetyErrors.map((message) => `Ledger entry ${index}: ${message}`));
    }
    let currentRecordValidated = false;
    const provisionalCurrent = entry.currency === "current"
      && (record.provisionalSupportingRecord === true
        || recordCarriesLiveQualification(record));
    if (provisionalCurrent) {
      errors.push(`Ledger entry ${index}: provisional/live supporting records cannot be current evidence.`);
    }
    if (entry.currency === "current") {
      if (rawSafetyErrors.length === 0 && !provisionalCurrent) {
        const result = validateEvidenceRecord(record, {
          strict: effectiveStrict,
          root,
          rejectProvisional: effectiveStrict && entry.status === "qualified",
          signedReviewAuthority,
          signedReviewTrust
        });
        if (!result.ok) {
          errors.push(...result.errors.map((message) => `Ledger entry ${index}: ${message}`));
        } else {
          currentRecordValidated = true;
        }
      }
    } else if (!SHA256.test(record.recordDigest || "")) {
      errors.push(`Ledger entry ${index}: historical recordDigest must be sha256 hex.`);
    } else if (rawSafetyErrors.length === 0 && record.recordDigest !== computeRecordDigest(record)) {
      errors.push(`Ledger entry ${index}: historical recordDigest does not match canonical body.`);
    }
    if (entry.phase !== record.phase) {
      errors.push(`Ledger entry ${index}: ledger phase does not match record phase.`);
    }
    if (entry.slice !== record.slice) {
      errors.push(`Ledger entry ${index}: ledger slice does not match record slice.`);
    }
    if (entry.status !== record.status) {
      errors.push(`Ledger entry ${index}: ledger status does not match record status.`);
    }
    if (entry.sourceCommit !== record.source?.headCommit) {
      errors.push(`Ledger entry ${index}: ledger sourceCommit does not match record source.headCommit.`);
    }
    if (entry.recordedAt !== record.recordedAt) {
      errors.push(`Ledger entry ${index}: ledger recordedAt does not match record recordedAt.`);
    }
    if (entry.recordDigest !== record.recordDigest) {
      errors.push(`Ledger entry ${index}: ledger recordDigest mismatch.`);
    }
    if (entry.currency === "current"
      && currentRecordValidated
      && currentByPhase.has(String(entry.phase))) {
      currentByPhase.get(String(entry.phase)).record = record;
      loaded.push({ index, entry, record });
    }
  }

  if (effectiveStrict) {
    for (const { index, entry, record } of loaded.filter((item) => item.entry.currency === "current")) {
      if (!VERIFIED_STATUS_SET.has(record.status)
        && !(record.status === "implemented_unverified"
          && Object.hasOwn(record, "proofProducer"))) continue;
      for (const [prerequisiteIndex, prerequisite] of (record.prerequisites || []).entries()) {
        const dependency = currentByPhase.get(String(prerequisite.phase));
        if (!dependency?.record) {
          errors.push(`Ledger entry ${index}: prerequisite ${prerequisiteIndex} has no current record.`);
          continue;
        }
        if (dependency.record.recordDigest !== prerequisite.recordDigest) {
          errors.push(`Ledger entry ${index}: prerequisite ${prerequisiteIndex} digest is stale or mismatched.`);
        }
        if (!statusSatisfiesVerifiedPrerequisite(
          dependency.record.status,
          dependency.record.phase
        )) {
          errors.push(`Ledger entry ${index}: prerequisite ${prerequisiteIndex} is not verified.`);
        }
        const dependencyPassGates = passedGateIds(dependency.record);
        const requiredDependencyGates = PHASE_MANDATORY_GATE_IDS[String(prerequisite.phase)] || [];
        for (const gateId of requiredDependencyGates) {
          if (!prerequisite.gateIds?.includes(gateId)) {
            errors.push(`Ledger entry ${index}: prerequisite ${prerequisiteIndex} omits a mandatory gate.`);
          }
        }
        for (const gateId of prerequisite.gateIds || []) {
          if (!dependencyPassGates.has(gateId)) {
            errors.push(`Ledger entry ${index}: prerequisite ${prerequisiteIndex} references a gate not passed by its record.`);
          }
        }
      }
    }
  }
  if (requireComplete) {
    const complete = assessCompleteEvidenceChain(
      [...currentByPhase.values()].map((current) => current.record).filter(Boolean)
    );
    errors.push(...complete.errors);
  }
  return {
    ok: errors.length === 0,
    errors,
    ledger: publicLedger,
    readinessRequired: Boolean(requireComplete),
    readinessReady: Boolean(requireComplete && errors.length === 0)
  };
}

export function verifyLedger(root = REPO_ROOT, options = {}) {
  return verifyLedgerInternal(root, options, validateEvidenceRecord);
}

export function verifyPhaseInternal(phase, root = REPO_ROOT, {
  strict = true,
  requireVerified = false,
  signedReviewAuthority = null,
  signedReviewTrust = null
} = {}, validateEvidenceRecord) {
  const phaseId = String(phase);
  const ledgerResult = verifyLedgerInternal(root, {
    strict,
    signedReviewAuthority,
    signedReviewTrust
  }, validateEvidenceRecord);
  const ledger = ledgerResult.ledger;
  const current = [...(ledger.entries || [])]
    .reverse()
    .find((entry) => String(entry.phase) === phaseId && entry.currency === "current") || null;
  const integrityErrors = [...ledgerResult.errors];
  let record = null;

  if (ledgerResult.ok && !current) {
    integrityErrors.push(`No current ledger entry for phase ${phaseId}.`);
  } else if (ledgerResult.ok) {
    const absolute = path.join(root, current.path);
    try {
      record = JSON.parse(readBoundedEvidenceFile(root, absolute));
    } catch {
      integrityErrors.push("Current evidence file is unreadable, unsafe, or oversized.");
    }
    if (record) {
      const recordResult = validateEvidenceRecord(record, {
        strict,
        root,
        signedReviewAuthority,
        signedReviewTrust
      });
      integrityErrors.push(...recordResult.errors);
    }
  }

  const integrityOk = integrityErrors.length === 0;
  const verified = Boolean(
    integrityOk
    && record
    && statusSatisfiesPhaseReadiness(record.status, record.phase)
  );
  const readinessErrors = [];
  if (requireVerified && !verified) {
    if (!current) {
      readinessErrors.push(`Verified readiness requires one current evidence record for phase ${phaseId}.`);
    } else if (!integrityOk) {
      readinessErrors.push(
        `Verified readiness for phase ${phaseId} requires the current exact record to pass integrity validation.`
      );
    } else {
      readinessErrors.push(
        `Verified readiness requires phase ${phaseId} current status ${
          phaseId === "aggregate" ? "qualified" : "verified_on_draft"
        }; found ${record.status}.`
      );
    }
  }

  return {
    ok: integrityOk && readinessErrors.length === 0,
    integrityOk,
    errors: [...integrityErrors, ...readinessErrors],
    readinessErrors,
    phase: phaseId,
    slice: current?.slice ?? null,
    status: current?.status ?? null,
    recordDigest: current?.recordDigest ?? null,
    sourceCommit: current?.sourceCommit ?? null,
    verified,
    readinessRequired: Boolean(requireVerified),
    readinessReady: verified
  };
}

export function verifyPhase(phase, root = REPO_ROOT, options = {}) {
  return verifyPhaseInternal(phase, root, options, validateEvidenceRecord);
}

export function evidenceStatusInternal(
  root = REPO_ROOT,
  { strict = false } = {},
  validateEvidenceRecord
) {
  const verification = verifyLedgerInternal(root, { strict }, validateEvidenceRecord);
  const ledger = verification.ledger;
  const byPhase = {};
  for (const entry of ledger.entries || []) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.currency !== "current") continue;
    byPhase[entry.phase] = entry;
  }
  return {
    ok: verification.ok,
    errors: verification.errors,
    phases: byPhase,
    ledger
  };
}

export function evidenceStatus(root = REPO_ROOT, options = {}) {
  return evidenceStatusInternal(root, options, validateEvidenceRecord);
}

export function digestsIgnoreEvidenceOnly(root = REPO_ROOT) {
  const without = computeInventoryDigest(root, { includeEvidence: false });
  const withEvidence = computeInventoryDigest(root, { includeEvidence: true });
  return {
    sourceDigest: without,
    fullDigest: withEvidence,
    evidenceOnlyExcluded: without !== withEvidence || listSourceInventory(root, { includeEvidence: true })
      .some((relative) => isEvidenceOnlyPath(relative))
  };
}
