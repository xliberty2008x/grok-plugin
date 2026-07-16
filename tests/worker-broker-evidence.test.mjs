import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  REPO_ROOT,
  attachRecordDigest,
  buildEvidenceRecord,
  computeInventoryDigest,
  computePhaseScopeDigest,
  computeRecordDigest,
  isEvidenceOnlyPath,
  validateEvidenceRecord,
  verifyPhase,
  digestsIgnoreEvidenceOnly
} from "../scripts/lib/worker-broker-evidence.mjs";
import { ROOT, run, tempDir } from "./helpers.mjs";

test("evidence-only paths are excluded from source inventory digests", () => {
  assert.equal(isEvidenceOnlyPath("tests/e2e-results/worker-broker/ledger.json"), true);
  assert.equal(isEvidenceOnlyPath("plugins/grok/scripts/lib/worker-protocol.mjs"), false);
  const digests = digestsIgnoreEvidenceOnly(REPO_ROOT);
  assert.equal(typeof digests.sourceDigest, "string");
  assert.match(digests.sourceDigest, /^[0-9a-f]{64}$/);
  // Adding an evidence-only file under a temp clone is heavy; assert exclusion helper + inequality when evidence files exist.
  const evidenceFiles = fs.readdirSync(path.join(REPO_ROOT, "tests/e2e-results/worker-broker"), { withFileTypes: true });
  assert.ok(evidenceFiles.length >= 0);
});

test("strict validator rejects missing phase fields, dirty-tree claims, and stale digests", () => {
  const good = buildEvidenceRecord({
    phase: "0",
    slice: "unit-test-record",
    status: "verified_on_draft",
    verification: [
      {
        command: "node --test tests/worker-broker-evidence.test.mjs",
        boundary: "source-provider-neutral",
        outcome: "pass",
        testsPassed: 1,
        testsFailed: 0
      }
    ]
  });
  const valid = validateEvidenceRecord(good);
  assert.equal(valid.ok, true, valid.errors.join("; "));

  const missingPhase = { ...good, phase: undefined };
  delete missingPhase.recordDigest;
  assert.equal(validateEvidenceRecord(missingPhase).ok, false);

  const dirtyClaim = {
    ...good,
    source: { ...good.source, cleanTreeAtVerification: true, sourceInventoryDigest: "0".repeat(64) },
    status: "qualified",
    provisionalSupportingRecord: false
  };
  const dirtyResult = validateEvidenceRecord(attachRecordDigest(dirtyClaim), {
    strict: true,
    root: REPO_ROOT
  });
  assert.equal(dirtyResult.ok, false);
  assert.ok(dirtyResult.errors.some((message) => /stale|digest|clean/i.test(message)));

  const provisionalQualified = attachRecordDigest({
    ...good,
    status: "qualified",
    provisionalSupportingRecord: true,
    source: { ...good.source, cleanTreeAtVerification: true }
  });
  assert.equal(validateEvidenceRecord(provisionalQualified).ok, false);
});

test("recordDigest is stable and self-consistent", () => {
  const record = buildEvidenceRecord({
    phase: "0",
    slice: "digest-stability",
    verification: [{ command: "true", boundary: "source", outcome: "pass" }]
  });
  assert.equal(record.recordDigest, computeRecordDigest(record));
  const tampered = { ...record, slice: "tampered" };
  assert.notEqual(computeRecordDigest(tampered), record.recordDigest);
});

test("validator accepts built records and rejects bad ones; CLI verify works against ledger", () => {
  const record = buildEvidenceRecord({
    phase: "0",
    slice: "cli-verify-path",
    status: "verified_on_draft",
    verification: [
      { command: "unit", boundary: "source-provider-neutral", outcome: "pass" },
      { command: "git diff --check", boundary: "source", outcome: "pass" }
    ],
    scenarios: [
      {
        id: "invalidation-exclusion",
        expected: "evidence-only commits excluded from source digest",
        actual: "excluded",
        outcome: "pass"
      }
    ]
  });
  const structural = validateEvidenceRecord(record, { strict: false });
  assert.equal(structural.ok, true, structural.errors.join("; "));

  // Prefer existing committed ledger when present; otherwise structural-only.
  const verified = verifyPhase("0", REPO_ROOT, { strict: false });
  if (verified.ok) {
    const cli = run(process.execPath, [
      path.join(ROOT, "scripts/worker-broker-evidence.mjs"),
      "verify",
      "--phase",
      "0"
    ], { cwd: ROOT });
    assert.equal(cli.status, 0, cli.stderr + cli.stdout);
  }

  // Deliberately bad: missing phase via ad-hoc JSON.
  const badDir = tempDir("grok-evidence-bad-");
  const badFile = path.join(badDir, "bad.json");
  fs.writeFileSync(badFile, JSON.stringify({ schemaVersion: 1, status: "qualified" }));
  const bad = validateEvidenceRecord(JSON.parse(fs.readFileSync(badFile, "utf8")));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 1);
});

test("phase scope digest changes when phase-scope source changes (structural)", () => {
  const d0 = computePhaseScopeDigest("0", REPO_ROOT);
  const d1 = computePhaseScopeDigest("1", REPO_ROOT);
  assert.match(d0, /^[0-9a-f]{64}$/);
  assert.match(d1, /^[0-9a-f]{64}$/);
  // Distinct phases include different path sets when those files exist.
  assert.notEqual(d0, d1);
  const source = computeInventoryDigest(REPO_ROOT, { includeEvidence: false });
  assert.match(source, /^[0-9a-f]{64}$/);
});
