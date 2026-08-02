import test from "node:test";
import {
  PHASE_MANDATORY_GATE_IDS,
  PHASE_SCOPE,
  REPO_ROOT,
  assert,
  assertQuiescentProofCleanupBoundary,
  assessCompleteEvidenceChain,
  attachRecordDigest,
  buildEvidenceRecord,
  computeProofManifestDigest,
  deterministicQualification,
  exactPhaseProof,
  fs,
  git,
  independentReviewReceipt,
  initPhaseOneProofRunnerFixture,
  initPhaseZeroEvidenceFixture,
  initRepo,
  initRunnableEvidenceCliFixture,
  loadLedger,
  passedCommand,
  path,
  phaseProof,
  phaseScopePaths,
  proofProducer,
  proveWorkerBrokerPhase,
  rawEvidenceFixturePath,
  run,
  seedLedgerFixtureEntry,
  sha256Text,
  updateLedger,
  validateEvidenceRecord,
  verifyLedger,
  verifyPhase,
  writeEvidenceRecord
} from "./worker-broker-evidence-test-support.mjs";

test("Phase 1 proof fails closed when its current Phase 0 prerequisite is absent", () => {
  const { root, evidenceDir } = initPhaseOneProofRunnerFixture("phase-one-no-prerequisite");
  const result = proveWorkerBrokerPhase({
    phase: "1",
    slice: "worker-api",
    root,
    write: true
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "E_PROOF_PREREQUISITE");
  assert.equal(fs.existsSync(path.join(evidenceDir, "ledger.json")), false);
});

test("Phase 1 proof does not publish when a code-owned gate fails", () => {
  const { root } = initPhaseOneProofRunnerFixture("phase-one-gate-failure", {
    failingFocusedGate: true
  });
  const phaseZero = proveWorkerBrokerPhase({
    phase: "0",
    slice: "phase-zero-baseline",
    root,
    write: true
  });
  assert.equal(phaseZero.ok, true, phaseZero.code);
  const failed = proveWorkerBrokerPhase({
    phase: "1",
    slice: "worker-api",
    root,
    write: true
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "E_PROOF_GATE");
  assert.equal(failed.gateId, "phase-1-focused-tests");
  const ledger = loadLedger(root);
  assert.equal(ledger.entries.filter((entry) => entry.phase === "1").length, 0);
  assert.equal(ledger.entries.filter((entry) => entry.phase === "0" && entry.currency === "current").length, 1);
});

test("Phase 1 proof does not publish when a mandatory focused test is skipped", () => {
  const { root } = initPhaseOneProofRunnerFixture("phase-one-gate-skip", {
    skippingFocusedGate: true
  });
  const phaseZero = proveWorkerBrokerPhase({
    phase: "0",
    slice: "phase-zero-baseline",
    root,
    write: true
  });
  assert.equal(phaseZero.ok, true, phaseZero.code);
  const failed = proveWorkerBrokerPhase({
    phase: "1",
    slice: "worker-api",
    root,
    write: true
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "E_PROOF_GATE");
  assert.equal(failed.gateId, "phase-1-focused-tests");
  assert.equal(loadLedger(root).entries.filter((entry) => entry.phase === "1").length, 0);
});

test("Phase 1 proof rejects source drift produced during its focused gate", () => {
  const { root } = initPhaseOneProofRunnerFixture("phase-one-source-drift", {
    driftingFocusedGate: true
  });
  const phaseZero = proveWorkerBrokerPhase({
    phase: "0",
    slice: "phase-zero-baseline",
    root,
    write: true
  });
  assert.equal(phaseZero.ok, true, phaseZero.code);
  const drifted = proveWorkerBrokerPhase({
    phase: "1",
    slice: "worker-api",
    root,
    write: true
  });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.code, "E_PROOF_SOURCE_DRIFT");
  assert.equal(loadLedger(root).entries.filter((entry) => entry.phase === "1").length, 0);
});

test("Phase 1 proof separates strict integrity from verified readiness", () => {
  const { root } = initPhaseOneProofRunnerFixture("phase-one-publication");
  const phaseZero = proveWorkerBrokerPhase({
    phase: "0",
    slice: "phase-zero-baseline",
    root,
    write: true
  });
  assert.equal(phaseZero.ok, true, phaseZero.code);
  const phaseZeroReadiness = verifyPhase("0", root, {
    strict: true,
    requireVerified: true
  });
  assert.equal(phaseZeroReadiness.ok, true, phaseZeroReadiness.errors.join("; "));
  assert.equal(phaseZeroReadiness.integrityOk, true);
  assert.equal(phaseZeroReadiness.status, "verified_on_draft");
  assert.equal(phaseZeroReadiness.verified, true);
  assert.equal(phaseZeroReadiness.readinessRequired, true);
  assert.equal(phaseZeroReadiness.readinessReady, true);

  const first = proveWorkerBrokerPhase({
    phase: "1",
    slice: "worker-api",
    root,
    write: true
  });
  assert.equal(first.ok, true, first.code);
  assert.equal(first.status, "implemented_unverified");
  assert.match(first.path, /^tests\/e2e-results\/worker-broker\/phase-1\//);
  const firstRecord = JSON.parse(fs.readFileSync(path.join(root, first.path), "utf8"));
  assert.equal(firstRecord.status, "implemented_unverified");
  assertQuiescentProofCleanupBoundary(firstRecord);
  assert.equal(firstRecord.authorities.independentValidation, "not_run");
  assert.equal(Object.hasOwn(firstRecord, "independentReviewReceipt"), false);
  assert.deepEqual(firstRecord.prerequisites, [{
    phase: "0",
    recordDigest: phaseZero.recordDigest,
    gateIds: [...PHASE_MANDATORY_GATE_IDS["0"]]
  }]);
  assert.deepEqual(first.gateIds, [...PHASE_MANDATORY_GATE_IDS["1"]]);
  assert.equal(first.manifestDigest, computeProofManifestDigest("1"));
  const firstStrict = verifyPhase("1", root, { strict: true });
  assert.equal(firstStrict.ok, true, firstStrict.errors.join("; "));
  assert.equal(firstStrict.integrityOk, true);
  assert.equal(firstStrict.phase, "1");
  assert.equal(firstStrict.slice, "worker-api");
  assert.equal(firstStrict.status, "implemented_unverified");
  assert.equal(firstStrict.recordDigest, first.recordDigest);
  assert.equal(firstStrict.verified, false);
  assert.equal(firstStrict.readinessRequired, false);
  assert.equal(firstStrict.readinessReady, false);

  const firstReadiness = verifyPhase("1", root, {
    strict: true,
    requireVerified: true
  });
  assert.equal(firstReadiness.ok, false);
  assert.equal(firstReadiness.integrityOk, true);
  assert.equal(firstReadiness.verified, false);
  assert.deepEqual(firstReadiness.readinessErrors, [
    "Verified readiness requires phase 1 current status verified_on_draft; found implemented_unverified."
  ]);
  assert.deepEqual(firstReadiness.errors, firstReadiness.readinessErrors);

  const replay = proveWorkerBrokerPhase({
    phase: "1",
    slice: "worker-api",
    root,
    write: true
  });
  assert.equal(replay.ok, true, replay.code);
  const ledger = loadLedger(root);
  assert.equal(ledger.entries.filter((entry) => entry.phase === "0" && entry.currency === "current").length, 1);
  assert.equal(ledger.entries.filter((entry) => entry.phase === "1" && entry.currency === "current").length, 1);
  assert.equal(ledger.entries.filter((entry) => entry.phase === "1" && entry.currency === "historical").length, 1);
  const replayStrict = verifyPhase("1", root, { strict: true });
  assert.equal(replayStrict.ok, true, replayStrict.errors.join("; "));
});

test("verify CLI exits independently for integrity and verified readiness", () => {
  const { root } = initRunnableEvidenceCliFixture("verified-readiness-cli");
  let phaseZero = buildEvidenceRecord({
    root,
    phase: "0",
    slice: "evidence-system",
    status: "verified_on_draft",
    verification: exactPhaseProof("0"),
    qualification: deterministicQualification(),
    evidenceSystemQualification: true
  });
  phaseZero = attachRecordDigest({
    ...phaseZero,
    proofProducer: proofProducer("0")
  });
  assert.equal(
    validateEvidenceRecord(phaseZero, { strict: true, root }).ok,
    true
  );
  const phaseZeroPath = rawEvidenceFixturePath(root, phaseZero);
  seedLedgerFixtureEntry(root, {
    phase: phaseZero.phase,
    slice: phaseZero.slice,
    status: phaseZero.status,
    path: phaseZeroPath,
    recordDigest: phaseZero.recordDigest,
    sourceCommit: phaseZero.source.headCommit,
    recordedAt: phaseZero.recordedAt
  });

  let phaseOne = buildEvidenceRecord({
    root,
    phase: "1",
    slice: "worker-api",
    status: "implemented_unverified",
    verification: exactPhaseProof("1"),
    qualification: deterministicQualification(),
    evidenceSystemQualification: true,
    prerequisites: [{
      phase: "0",
      recordDigest: phaseZero.recordDigest,
      gateIds: [...PHASE_MANDATORY_GATE_IDS["0"]]
    }]
  });
  phaseOne = attachRecordDigest({
    ...phaseOne,
    proofProducer: proofProducer("1")
  });
  assert.equal(
    validateEvidenceRecord(phaseOne, { strict: true, root }).ok,
    true
  );
  const phaseOnePath = rawEvidenceFixturePath(root, phaseOne);
  updateLedger({
    phase: phaseOne.phase,
    slice: phaseOne.slice,
    status: phaseOne.status,
    path: phaseOnePath,
    recordDigest: phaseOne.recordDigest,
    sourceCommit: phaseOne.source.headCommit,
    recordedAt: phaseOne.recordedAt
  }, root);

  const fixtureCli = path.join(root, "scripts/worker-broker-evidence.mjs");
  const strictCli = run(process.execPath, [
    fixtureCli,
    "verify",
    "--phase",
    "1",
    "--strict"
  ], { cwd: root, timeout: 30_000 });
  assert.equal(strictCli.status, 0, `${strictCli.stderr}\n${strictCli.stdout}`);
  const strictPayload = JSON.parse(strictCli.stdout);
  assert.equal(strictPayload.ok, true);
  assert.equal(strictPayload.integrityOk, true);
  assert.equal(strictPayload.status, "implemented_unverified");
  assert.equal(strictPayload.verified, false);

  const requiredCli = run(process.execPath, [
    fixtureCli,
    "verify",
    "--phase",
    "1",
    "--strict",
    "--require-verified"
  ], { cwd: root, timeout: 30_000 });
  assert.equal(requiredCli.status, 1);
  assert.equal(requiredCli.stderr, "");
  const requiredPayload = JSON.parse(requiredCli.stdout);
  assert.equal(requiredPayload.ok, false);
  assert.equal(requiredPayload.integrityOk, true);
  assert.equal(requiredPayload.status, "implemented_unverified");
  assert.equal(requiredPayload.verified, false);
  assert.deepEqual(requiredPayload.readinessErrors, [
    "Verified readiness requires phase 1 current status verified_on_draft; found implemented_unverified."
  ]);

  const passingCli = run(process.execPath, [
    fixtureCli,
    "verify",
    "--phase",
    "0",
    "--strict",
    "--require-verified"
  ], { cwd: root, timeout: 30_000 });
  assert.equal(passingCli.status, 0, `${passingCli.stderr}\n${passingCli.stdout}`);
  const passingPayload = JSON.parse(passingCli.stdout);
  assert.equal(passingPayload.status, "verified_on_draft");
  assert.equal(passingPayload.verified, true);
  assert.equal(passingPayload.readinessReady, true);
});

test("re-proving Phase 0 atomically supersedes Phase 1 and permits strict chain rebuild", () => {
  const { root } = initPhaseOneProofRunnerFixture("phase-zero-chain-replacement");
  const firstPhaseZero = proveWorkerBrokerPhase({
    phase: "0",
    slice: "phase-zero-initial",
    root,
    write: true
  });
  assert.equal(firstPhaseZero.ok, true, firstPhaseZero.code);
  const firstPhaseOne = proveWorkerBrokerPhase({
    phase: "1",
    slice: "worker-api",
    root,
    write: true
  });
  assert.equal(firstPhaseOne.ok, true, firstPhaseOne.code);

  const replacementPhaseZero = proveWorkerBrokerPhase({
    phase: "0",
    slice: "phase-zero-replacement",
    root,
    write: true
  });
  assert.equal(replacementPhaseZero.ok, true, replacementPhaseZero.code);
  let ledger = loadLedger(root);
  assert.equal(
    ledger.entries.find((entry) => entry.recordDigest === replacementPhaseZero.recordDigest)?.currency,
    "current"
  );
  assert.equal(
    ledger.entries.find((entry) => entry.recordDigest === firstPhaseZero.recordDigest)?.currency,
    "historical"
  );
  assert.equal(
    ledger.entries.find((entry) => entry.recordDigest === firstPhaseOne.recordDigest)?.currency,
    "historical"
  );
  assert.equal(ledger.entries.filter((entry) => entry.currency === "invalidated").length, 0);
  const replacementStrict = verifyLedger(root, { strict: true });
  assert.equal(replacementStrict.ok, true, replacementStrict.errors.join("; "));

  const rebuiltPhaseOne = proveWorkerBrokerPhase({
    phase: "1",
    slice: "worker-api",
    root,
    write: true
  });
  assert.equal(rebuiltPhaseOne.ok, true, rebuiltPhaseOne.code);
  ledger = loadLedger(root);
  assert.equal(ledger.entries.filter((entry) => entry.phase === "0" && entry.currency === "current").length, 1);
  assert.equal(ledger.entries.filter((entry) => entry.phase === "1" && entry.currency === "current").length, 1);
  const rebuiltStrict = verifyPhase("1", root, { strict: true });
  assert.equal(rebuiltStrict.ok, true, rebuiltStrict.errors.join("; "));
});

test("re-proving Phase 1 demotes a current Phase 2 while retaining unaffected Phase 0", () => {
  const { root } = initPhaseOneProofRunnerFixture("phase-one-dependent-replacement");
  const phaseZero = proveWorkerBrokerPhase({
    phase: "0",
    slice: "phase-zero-baseline",
    root,
    write: true
  });
  assert.equal(phaseZero.ok, true, phaseZero.code);
  const firstPhaseOne = proveWorkerBrokerPhase({
    phase: "1",
    slice: "worker-api",
    root,
    write: true
  });
  assert.equal(firstPhaseOne.ok, true, firstPhaseOne.code);

  const phaseTwo = buildEvidenceRecord({
    phase: "2",
    slice: "phase-two-current",
    root,
    verification: [passedCommand("phase-two-fixture", "phase two fixture observation")],
    prerequisites: [
      {
        phase: "0",
        recordDigest: phaseZero.recordDigest,
        gateIds: [...PHASE_MANDATORY_GATE_IDS["0"]]
      },
      {
        phase: "1",
        recordDigest: firstPhaseOne.recordDigest,
        gateIds: [...PHASE_MANDATORY_GATE_IDS["1"]]
      }
    ]
  });
  const phaseTwoPath = writeEvidenceRecord(phaseTwo, root);
  updateLedger({
    phase: phaseTwo.phase,
    slice: phaseTwo.slice,
    status: phaseTwo.status,
    path: phaseTwoPath,
    recordDigest: phaseTwo.recordDigest,
    sourceCommit: phaseTwo.source.headCommit,
    recordedAt: phaseTwo.recordedAt
  }, root);
  const beforeReplacement = verifyLedger(root, { strict: true });
  assert.equal(beforeReplacement.ok, true, beforeReplacement.errors.join("; "));

  const replacementPhaseOne = proveWorkerBrokerPhase({
    phase: "1",
    slice: "worker-api",
    root,
    write: true
  });
  assert.equal(replacementPhaseOne.ok, true, replacementPhaseOne.code);
  const ledger = loadLedger(root);
  assert.equal(
    ledger.entries.find((entry) => entry.recordDigest === phaseZero.recordDigest)?.currency,
    "current",
    "the unaffected upstream prerequisite remains current"
  );
  assert.equal(
    ledger.entries.find((entry) => entry.recordDigest === firstPhaseOne.recordDigest)?.currency,
    "historical"
  );
  assert.equal(
    ledger.entries.find((entry) => entry.recordDigest === phaseTwo.recordDigest)?.currency,
    "historical",
    "the dependent cannot remain current against the replaced Phase 1 digest"
  );
  assert.equal(
    ledger.entries.find((entry) => entry.recordDigest === replacementPhaseOne.recordDigest)?.currency,
    "current"
  );
  assert.equal(ledger.entries.filter((entry) => entry.currency === "invalidated").length, 0);
  const replayStrict = verifyLedger(root, { strict: true });
  assert.equal(replayStrict.ok, true, replayStrict.errors.join("; "));
  const phaseOneStrict = verifyPhase("1", root, { strict: true });
  assert.equal(phaseOneStrict.ok, true, phaseOneStrict.errors.join("; "));
  const phaseTwoStrict = verifyPhase("2", root, { strict: true });
  assert.equal(phaseTwoStrict.ok, false);
  assert.ok(phaseTwoStrict.errors.some((message) => /no current ledger entry for phase 2/i.test(message)));
});

test("strict validator rejects caller-authored promotion without exact producer provenance", () => {
  const record = buildEvidenceRecord({
    phase: "0",
    slice: "strict-positive",
    status: "verified_on_draft",
    verification: phaseProof("0"),
    qualification: deterministicQualification(),
    evidenceSystemQualification: true,
    authorities: {
      workerClaims: "none",
      runtimeObservations: "bounded command digests",
      hostVerification: "deterministic gates passed",
      independentValidation: "not required for focused validator fixture"
    }
  });
  const result = validateEvidenceRecord(record, { strict: true, root: REPO_ROOT });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((message) => /proofProducer provenance/i.test(message)));
});

test("complete-chain assessment requires six verified drafts and one qualified aggregate", () => {
  const phases = ["0", "1", "2", "3", "4", "5"].map((phase) => ({
    phase,
    status: "verified_on_draft",
    recordDigest: sha256Text(`phase-${phase}`)
  }));
  const aggregate = {
    phase: "aggregate",
    status: "qualified",
    recordDigest: sha256Text("aggregate"),
    prerequisites: phases.map((record) => ({
      phase: record.phase,
      recordDigest: record.recordDigest,
      gateIds: [...PHASE_MANDATORY_GATE_IDS[record.phase]]
    })),
    qualification: {
      deterministic: "pass",
      installedHost: "pass",
      provider: "pass",
      release: "pass"
    },
    releaseQualification: true,
    ci: { jobs: [{ name: "required", result: "success" }] }
  };
  const complete = assessCompleteEvidenceChain([...phases, aggregate]);
  assert.equal(complete.ok, true, complete.errors.join("; "));

  const cases = [
    {
      label: "phase-qualified",
      records: [...phases.map((record, index) => (
        index === 2 ? { ...record, status: "qualified" } : record
      )), aggregate],
      expected: /phase 2 status verified_on_draft/i
    },
    {
      label: "phase-implemented",
      records: [...phases.map((record, index) => (
        index === 3 ? { ...record, status: "implemented_unverified" } : record
      )), aggregate],
      expected: /phase 3 status verified_on_draft/i
    },
    {
      label: "missing-phase",
      records: [...phases.filter((record) => record.phase !== "4"), aggregate],
      expected: /one current evidence record for phase 4/i
    },
    {
      label: "stale-prerequisite",
      records: [...phases, {
        ...aggregate,
        prerequisites: aggregate.prerequisites.map((prerequisite) => (
          prerequisite.phase === "5"
            ? { ...prerequisite, recordDigest: "f".repeat(64) }
            : prerequisite
        ))
      }],
      expected: /prerequisite phase 5 is stale or mismatched/i
    },
    {
      label: "unqualified-aggregate",
      records: [...phases, { ...aggregate, status: "verified_on_draft" }],
      expected: /phase aggregate status qualified/i
    },
    {
      label: "incomplete-aggregate",
      records: [...phases, {
        ...aggregate,
        releaseQualification: false,
        qualification: { ...aggregate.qualification, release: "not_run" },
        ci: { jobs: [] }
      }],
      expected: /aggregate release qualification to pass/i
    }
  ];
  for (const fixture of cases) {
    const result = assessCompleteEvidenceChain(fixture.records);
    assert.equal(result.ok, false, fixture.label);
    assert.ok(result.errors.some((message) => fixture.expected.test(message)), fixture.label);
  }
});

test("strict ledger validates incomplete integrity while readiness remains fail closed", () => {
  const root = initRepo();
  const scopedPaths = new Set([...PHASE_SCOPE["0"], ...PHASE_SCOPE["1"]]);
  for (const relative of scopedPaths) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(
      absolute,
      relative === "package.json"
        ? '{"name":"evidence-fixture","version":"1.0.0"}\n'
        : `fixture for ${relative}\n`
    );
  }
  const evidenceDir = path.join(root, "tests/e2e-results/worker-broker");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, ".gitkeep"), "");
  git(root, "add", ".");
  git(root, "commit", "-m", "add package identity");

  const phase0 = buildEvidenceRecord({
    root,
    phase: "0",
    slice: "evidence-system",
    status: "implemented_unverified",
    verification: phaseProof("0")
  });
  const phase0Path = writeEvidenceRecord(phase0, root);
  updateLedger({
    phase: phase0.phase,
    slice: phase0.slice,
    status: phase0.status,
    path: phase0Path,
    recordDigest: phase0.recordDigest,
    sourceCommit: phase0.source.headCommit,
    recordedAt: phase0.recordedAt
  }, root);

  const phase1 = buildEvidenceRecord({
    root,
    phase: "1",
    slice: "worker-api",
    status: "implemented_unverified",
    verification: phaseProof("1")
  });
  const phase1Path = writeEvidenceRecord(phase1, root);
  updateLedger({
    phase: phase1.phase,
    slice: phase1.slice,
    status: phase1.status,
    path: phase1Path,
    recordDigest: phase1.recordDigest,
    sourceCommit: phase1.source.headCommit,
    recordedAt: phase1.recordedAt
  }, root);

  const valid = verifyLedger(root, { strict: true });
  assert.equal(valid.ok, true, valid.errors.join("; "));
  assert.equal(valid.readinessRequired, false);

  const readiness = verifyLedger(root, { strict: true, requireComplete: true });
  assert.equal(readiness.ok, false);
  assert.equal(readiness.readinessRequired, true);
  assert.ok(readiness.errors.some((message) => /phase 0 status verified_on_draft/i.test(message)));
  assert.ok(readiness.errors.some((message) => /phase aggregate/i.test(message)));

  const ledgerPath = path.join(root, "tests/e2e-results/worker-broker/ledger.json");
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  ledger.entries.find((entry) => entry.phase === "1").status = "qualified";
  fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  const mismatched = verifyLedger(root, { strict: true });
  assert.equal(mismatched.ok, false);
  assert.ok(mismatched.errors.some((message) => /ledger status does not match/i.test(message)));
});

test("strict ledger preserves immutable legacy history without trusting it as current evidence", () => {
  const root = initRepo();
  for (const relative of PHASE_SCOPE["0"]) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(
      absolute,
      relative === "package.json"
        ? '{"name":"legacy-evidence-fixture","version":"1.0.0"}\n'
        : `fixture for ${relative}\n`
    );
  }
  const evidenceDir = path.join(root, "tests/e2e-results/worker-broker");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, ".gitkeep"), "");
  git(root, "add", ".");
  git(root, "commit", "-m", "add legacy evidence fixture");

  const legacyDraft = buildEvidenceRecord({
    root,
    phase: "0",
    slice: "legacy-evidence-system",
    status: "verified_on_draft",
    verification: phaseProof("0"),
    qualification: deterministicQualification()
  });
  delete legacyDraft.qualification;
  delete legacyDraft.evidenceSystemQualification;
  delete legacyDraft.prerequisites;
  delete legacyDraft.source.phaseScopePaths;
  legacyDraft.verification = legacyDraft.verification.map(({ command, outcome }) => ({ command, outcome }));
  legacyDraft.legacyFormatVersion = 0;
  const legacy = attachRecordDigest(legacyDraft);
  // Intentionally invalid legacy bytes bypass the hardened production writer;
  // verification must retain compatibility without making them publishable.
  const legacyPath = rawEvidenceFixturePath(root, legacy);
  seedLedgerFixtureEntry(root, {
    phase: legacy.phase,
    slice: legacy.slice,
    status: legacy.status,
    path: legacyPath,
    recordDigest: legacy.recordDigest,
    sourceCommit: legacy.source.headCommit,
    recordedAt: legacy.recordedAt
  });

  const current = buildEvidenceRecord({
    root,
    phase: "0",
    slice: "current-evidence-system",
    status: "implemented_unverified",
    verification: phaseProof("0")
  });
  const currentPath = writeEvidenceRecord(current, root);
  updateLedger({
    phase: current.phase,
    slice: current.slice,
    status: current.status,
    path: currentPath,
    recordDigest: current.recordDigest,
    sourceCommit: current.source.headCommit,
    recordedAt: current.recordedAt
  }, root);

  const valid = verifyLedger(root, { strict: true });
  assert.equal(valid.ok, true, valid.errors.join("; "));
  const historicalEntry = valid.ledger.entries.find((entry) => entry.currency === "historical");
  assert.equal(historicalEntry.path, legacyPath);

  const legacyAbsolute = path.join(root, legacyPath);
  const legacySerialized = fs.readFileSync(legacyAbsolute, "utf8");
  const tamperedLegacy = JSON.parse(legacySerialized);
  tamperedLegacy.legacyFormatVersion = 1;
  fs.writeFileSync(legacyAbsolute, `${JSON.stringify(tamperedLegacy, null, 2)}\n`);
  const digestFailure = verifyLedger(root, { strict: true });
  assert.equal(digestFailure.ok, false);
  assert.ok(digestFailure.errors.some((message) => /historical recordDigest does not match/i.test(message)));

  fs.writeFileSync(legacyAbsolute, legacySerialized);
  const ledgerPath = path.join(root, "tests/e2e-results/worker-broker/ledger.json");
  const identityTamperedLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  identityTamperedLedger.entries.find((entry) => entry.currency === "historical").sourceCommit = "0".repeat(40);
  fs.writeFileSync(ledgerPath, `${JSON.stringify(identityTamperedLedger, null, 2)}\n`);
  const identityFailure = verifyLedger(root, { strict: true });
  assert.equal(identityFailure.ok, false);
  assert.ok(identityFailure.errors.some((message) => /ledger sourceCommit does not match/i.test(message)));
});

test("strict ledger applies raw privacy checks to historical and invalidated legacy records", () => {
  const { root } = initPhaseZeroEvidenceFixture("legacy-privacy-evidence");
  const canaries = [];
  for (const currency of ["historical", "invalidated"]) {
    const rawCanary = `${currency.toUpperCase()}_RAW_VALUE_CANARY`;
    const pathCanary = `${currency.toUpperCase()}_PRIVATE_PATH_CANARY`;
    canaries.push(rawCanary, pathCanary);
    const legacyDraft = buildEvidenceRecord({
      root,
      phase: "0",
      slice: `${currency}-legacy-privacy`,
      status: "verified_on_draft",
      verification: phaseProof("0"),
      qualification: deterministicQualification()
    });
    delete legacyDraft.qualification;
    delete legacyDraft.evidenceSystemQualification;
    delete legacyDraft.prerequisites;
    delete legacyDraft.source.phaseScopePaths;
    legacyDraft.verification = legacyDraft.verification.map(({ command, outcome }) => ({ command, outcome }));
    legacyDraft.legacyFormatVersion = 0;
    legacyDraft.rawSecret = rawCanary;
    legacyDraft.limits.residualRisks = [`Found /private/tmp/${pathCanary}`];
    const legacy = attachRecordDigest(legacyDraft);
    // Privacy-negative legacy fixtures are seeded as bytes. Production
    // publication must reject these records before creating a path.
    const recordPath = rawEvidenceFixturePath(root, legacy);
    seedLedgerFixtureEntry(root, {
      phase: legacy.phase,
      slice: legacy.slice,
      status: legacy.status,
      path: recordPath,
      recordDigest: legacy.recordDigest,
      sourceCommit: legacy.source.headCommit,
      currency,
      recordedAt: legacy.recordedAt
    });
  }

  const result = verifyLedger(root, { strict: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((message) => /forbidden raw\/private evidence field/i.test(message)));
  assert.ok(result.errors.some((message) => /private runtime path/i.test(message)));
  assert.equal(
    result.errors.some((message) => /qualification is required|gateId is required|phaseScopePaths does not match/i.test(message)),
    false,
    "legacy structure remains compatible; the shared raw privacy boundary causes rejection"
  );
  const serialized = JSON.stringify(result);
  for (const canary of canaries) assert.equal(serialized.includes(canary), false);
  assert.equal(serialized.includes("rawSecret"), false);
});
