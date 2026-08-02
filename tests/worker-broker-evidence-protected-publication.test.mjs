import test from "node:test";
import {
  EVIDENCE_MODULE_URL,
  PHASE_MANDATORY_GATE_IDS,
  PHASE_THREE_SLICE,
  PHASE_TWO_SLICE,
  ROOT,
  assert,
  attachRecordDigest,
  buildEvidenceRecord,
  createReviewRequestFixture,
  crypto,
  deterministicQualification,
  exactPhaseProof,
  fs,
  git,
  independentReviewReceipt,
  initPhaseOneSignedReviewFixture,
  loadLedger,
  loadPrivateReviewPromotionHarness,
  path,
  proofProducer,
  rawEvidenceFixturePath,
  run,
  signedReviewAttestation,
  spawnPrivateReviewPromoter,
  updateLedger,
  verifyLedger,
  waitFor,
  writeEvidenceRecord,
  writeReviewAttestationFixture
} from "./worker-broker-evidence-test-support.mjs";

test("protected Phase 2 publication requires the exact signed chain and replays atomically", async () => {
  const fixture = initPhaseOneSignedReviewFixture("protected-phase-two");
  const requestResult = createReviewRequestFixture(fixture, { write: true });
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const attestation = signedReviewAttestation(requestResult, keyPair);
  const attestationPath = writeReviewAttestationFixture(fixture.root, attestation);
  const now = new Date(Date.parse(attestation.endedAt) + 1_000).toISOString();
  const trust = {
    publicKey: keyPair.publicKey,
    expectedIssuer: "test-protected-reviewer",
    revokedKeyFingerprints: [],
    now
  };
  const { api } = await loadPrivateReviewPromotionHarness(fixture.root);

  const buildPhaseTwoRecord = (phaseOneDigest) => {
    let record = buildEvidenceRecord({
      root: fixture.root,
      phase: "2",
      slice: PHASE_TWO_SLICE,
      status: "verified_on_draft",
      verification: exactPhaseProof("2"),
      qualification: deterministicQualification(),
      evidenceSystemQualification: true,
      prerequisites: [
        {
          phase: "0",
          recordDigest: fixture.phaseZero.recordDigest,
          gateIds: [...PHASE_MANDATORY_GATE_IDS["0"]]
        },
        {
          phase: "1",
          recordDigest: phaseOneDigest,
          gateIds: [...PHASE_MANDATORY_GATE_IDS["1"]]
        }
      ]
    });
    record = attachRecordDigest({
      ...record,
      proofProducer: proofProducer("2")
    });
    return record;
  };

  assert.throws(
    () => api.__testPublishPhaseTwo(
      buildPhaseTwoRecord(fixture.phaseOne.recordDigest),
      fixture.root,
      trust
    ),
    /prerequisite/i,
    "an unsigned current Phase 1 cannot authorize Phase 2 publication"
  );
  assert.equal(
    loadLedger(fixture.root).entries.some((entry) => entry.phase === "2"),
    false
  );

  const promoted = api.__testPromoteSignedReview({
    root: fixture.root,
    requestPath: requestResult.path,
    attestationPath,
    trust,
    now
  });
  assert.equal(promoted.ok, true);
  const signedLedgerWithoutPhaseTwo = api.__testVerifyPhaseTwo(
    fixture.root,
    trust
  );
  assert.equal(signedLedgerWithoutPhaseTwo.ok, false);
  assert.ok(signedLedgerWithoutPhaseTwo.errors.some((message) => (
    /no current ledger entry for phase 2/i.test(message)
  )));
  const record = buildPhaseTwoRecord(promoted.recordDigest);
  const publication = api.__testPublishPhaseTwo(record, fixture.root, trust);
  assert.deepEqual(publication.prerequisites, record.prerequisites);
  assert.match(publication.relative, /^tests\/e2e-results\/worker-broker\/phase-2\//);

  const replay = api.__testVerifyPhaseTwo(fixture.root, trust);
  assert.equal(replay.ok, true, replay.errors.join("; "));
  assert.equal(replay.integrityOk, true);
  assert.equal(replay.slice, PHASE_TWO_SLICE);
  assert.equal(replay.status, "verified_on_draft");
  assert.equal(replay.recordDigest, record.recordDigest);
  assert.equal(replay.verified, true);
  const publishedRecord = JSON.parse(fs.readFileSync(
    path.join(fixture.root, publication.relative),
    "utf8"
  ));
  assert.equal(Object.hasOwn(publishedRecord, "liveQualificationReceipts"), false);
  assert.deepEqual(publishedRecord.liveScenarios, []);
  assert.deepEqual(publishedRecord.qualification, deterministicQualification());

  const ordinaryReplay = verifyLedger(fixture.root, { strict: true });
  assert.equal(ordinaryReplay.ok, false);
  assert.ok(ordinaryReplay.errors.some((message) => /protected host trust/i.test(message)));

  const ledgerPath = path.join(
    fixture.root,
    "tests/e2e-results/worker-broker/ledger.json"
  );
  const ledgerBeforeRace = fs.readFileSync(ledgerPath, "utf8");
  const raced = attachRecordDigest({
    ...record,
    recordedAt: new Date(Date.parse(record.recordedAt) + 1_000).toISOString()
  });
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (path.basename(destination) === "ledger.json"
      && path.basename(source).startsWith(".ledger.json.")) {
      throw new Error("injected Phase 2 ledger race");
    }
    return rename(source, destination);
  };
  try {
    assert.throws(
      () => api.__testPublishPhaseTwo(raced, fixture.root, trust),
      /evidence|ledger/i
    );
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(fs.readFileSync(ledgerPath, "utf8"), ledgerBeforeRace);
  const afterRace = api.__testVerifyPhaseTwo(fixture.root, trust);
  assert.equal(afterRace.ok, true, afterRace.errors.join("; "));
  assert.equal(afterRace.recordDigest, record.recordDigest);
});

test("protected Phase 3 publication requires the signed chain and strictly replays", async () => {
  const fixture = initPhaseOneSignedReviewFixture("protected-phase-three");
  const requestResult = createReviewRequestFixture(fixture, { write: true });
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const attestation = signedReviewAttestation(requestResult, keyPair);
  const attestationPath = writeReviewAttestationFixture(fixture.root, attestation);
  const now = new Date(Date.parse(attestation.endedAt) + 1_000).toISOString();
  const trust = {
    publicKey: keyPair.publicKey,
    expectedIssuer: "test-protected-reviewer",
    revokedKeyFingerprints: [],
    now
  };
  const { api } = await loadPrivateReviewPromotionHarness(fixture.root);
  const buildPhaseThreeRecord = (phaseOneDigest) => {
    let record = buildEvidenceRecord({
      root: fixture.root,
      phase: "3",
      slice: PHASE_THREE_SLICE,
      status: "verified_on_draft",
      verification: exactPhaseProof("3"),
      qualification: deterministicQualification(),
      evidenceSystemQualification: true,
      prerequisites: [
        {
          phase: "0",
          recordDigest: fixture.phaseZero.recordDigest,
          gateIds: [...PHASE_MANDATORY_GATE_IDS["0"]]
        },
        {
          phase: "1",
          recordDigest: phaseOneDigest,
          gateIds: [...PHASE_MANDATORY_GATE_IDS["1"]]
        }
      ]
    });
    record = attachRecordDigest({
      ...record,
      proofProducer: proofProducer("3")
    });
    return record;
  };

  assert.throws(
    () => api.__testPublishPhaseThree(
      buildPhaseThreeRecord(fixture.phaseOne.recordDigest),
      fixture.root,
      trust
    ),
    /prerequisite/i,
    "an unsigned current Phase 1 cannot authorize Phase 3 publication"
  );

  const promoted = api.__testPromoteSignedReview({
    root: fixture.root,
    requestPath: requestResult.path,
    attestationPath,
    trust,
    now
  });
  assert.equal(promoted.ok, true);
  const record = buildPhaseThreeRecord(promoted.recordDigest);
  const publication = api.__testPublishPhaseThree(record, fixture.root, trust);
  assert.deepEqual(publication.prerequisites, record.prerequisites);
  assert.match(publication.relative, /^tests\/e2e-results\/worker-broker\/phase-3\//);

  const replay = api.__testVerifyPhaseThree(fixture.root, trust);
  assert.equal(replay.ok, true, replay.errors.join("; "));
  assert.equal(replay.integrityOk, true);
  assert.equal(replay.slice, PHASE_THREE_SLICE);
  assert.equal(replay.status, "verified_on_draft");
  assert.equal(replay.recordDigest, record.recordDigest);
  assert.equal(replay.verified, true);

  const recordPath = path.join(fixture.root, publication.relative);
  const immutableRecord = fs.readFileSync(recordPath);
  const tampered = JSON.parse(immutableRecord);
  tampered.verification[1].testsSkipped = 1;
  fs.writeFileSync(recordPath, `${JSON.stringify(tampered, null, 2)}\n`);
  const rejectedReplay = api.__testVerifyPhaseThree(fixture.root, trust);
  assert.equal(rejectedReplay.ok, false);
  assert.ok(rejectedReplay.errors.some((message) => (
    /record digest|zero-skip|immutable/i.test(message)
  )), rejectedReplay.errors.join("; "));
  fs.writeFileSync(recordPath, immutableRecord);

  const restoredReplay = api.__testVerifyPhaseThree(fixture.root, trust);
  assert.equal(restoredReplay.ok, true, restoredReplay.errors.join("; "));
  assert.equal(restoredReplay.recordDigest, record.recordDigest);
});

test("Phase 0 reproof after source evolution demotes a signed v4 Phase 1 and Phase 2 chain", async () => {
  const fixture = initPhaseOneSignedReviewFixture("phase-zero-source-evolution");
  const requestResult = createReviewRequestFixture(fixture, { write: true });
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const attestation = signedReviewAttestation(requestResult, keyPair);
  const attestationPath = writeReviewAttestationFixture(fixture.root, attestation);
  const now = new Date(Date.parse(attestation.endedAt) + 1_000).toISOString();
  const trust = {
    publicKey: keyPair.publicKey,
    expectedIssuer: "test-protected-reviewer",
    revokedKeyFingerprints: [],
    now
  };
  const { api } = await loadPrivateReviewPromotionHarness(fixture.root);
  const promoted = api.__testPromoteSignedReview({
    root: fixture.root,
    requestPath: requestResult.path,
    attestationPath,
    trust,
    now
  });
  assert.equal(promoted.ok, true);

  let phaseTwo = buildEvidenceRecord({
    root: fixture.root,
    phase: "2",
    slice: PHASE_TWO_SLICE,
    status: "verified_on_draft",
    verification: exactPhaseProof("2"),
    qualification: deterministicQualification(),
    evidenceSystemQualification: true,
    prerequisites: [
      {
        phase: "0",
        recordDigest: fixture.phaseZero.recordDigest,
        gateIds: [...PHASE_MANDATORY_GATE_IDS["0"]]
      },
      {
        phase: "1",
        recordDigest: promoted.recordDigest,
        gateIds: [...PHASE_MANDATORY_GATE_IDS["1"]]
      }
    ]
  });
  phaseTwo = attachRecordDigest({
    ...phaseTwo,
    proofProducer: proofProducer("2")
  });
  const phaseTwoPublication = api.__testPublishPhaseTwo(
    phaseTwo,
    fixture.root,
    trust
  );
  const protectedReplay = api.__testVerifyPhaseTwo(fixture.root, trust);
  assert.equal(protectedReplay.ok, true, protectedReplay.errors.join("; "));

  const immutableBefore = new Map(
    loadLedger(fixture.root).entries.map((entry) => [
      entry.recordDigest,
      fs.readFileSync(path.join(fixture.root, entry.path))
    ])
  );
  const evolvedSource = path.join(
    fixture.root,
    "plugins/grok/scripts/lib/errors.mjs"
  );
  fs.appendFileSync(evolvedSource, "\n// tracked source evolution after Phase 2\n");
  git(fixture.root, "add", "plugins/grok/scripts/lib/errors.mjs");
  git(fixture.root, "commit", "-m", "advance tracked source after phase 2");

  let replacement = buildEvidenceRecord({
    root: fixture.root,
    phase: "0",
    slice: "evidence-system",
    status: "verified_on_draft",
    verification: exactPhaseProof("0"),
    qualification: deterministicQualification(),
    evidenceSystemQualification: true
  });
  replacement = attachRecordDigest({
    ...replacement,
    proofProducer: proofProducer("0")
  });
  const replacementPath = api.__testPublishPhaseZero(
    replacement,
    fixture.root
  );
  assert.match(
    replacementPath,
    /^tests\/e2e-results\/worker-broker\/phase-0\//
  );

  const ledger = loadLedger(fixture.root);
  for (const digest of [
    fixture.phaseZero.recordDigest,
    promoted.recordDigest,
    phaseTwo.recordDigest
  ]) {
    assert.equal(
      ledger.entries.find((entry) => entry.recordDigest === digest)?.currency,
      "historical",
      digest
    );
    assert.deepEqual(
      fs.readFileSync(path.join(
        fixture.root,
        ledger.entries.find((entry) => entry.recordDigest === digest).path
      )),
      immutableBefore.get(digest),
      `superseded record ${digest} must remain immutable`
    );
  }
  const current = ledger.entries.filter((entry) => entry.currency === "current");
  assert.equal(current.length, 1);
  assert.equal(current[0].phase, "0");
  assert.equal(current[0].recordDigest, replacement.recordDigest);
  assert.equal(
    ledger.entries.find((entry) => (
      entry.recordDigest === phaseTwo.recordDigest
    ))?.path,
    phaseTwoPublication.relative
  );
  const strict = verifyLedger(fixture.root, { strict: true });
  assert.equal(strict.ok, true, strict.errors.join("; "));
});

test("Phase 0 source-evolution recovery rejects a malformed current v4 producer", async () => {
  const fixture = initPhaseOneSignedReviewFixture(
    "phase-zero-source-evolution-malformed-v4"
  );
  const { api } = await loadPrivateReviewPromotionHarness(fixture.root);
  const malformed = attachRecordDigest({
    ...fixture.phaseOne,
    proofProducer: {
      ...fixture.phaseOne.proofProducer,
      manifestDigest: "f".repeat(64)
    }
  });
  fs.writeFileSync(
    path.join(fixture.root, fixture.phaseOnePath),
    `${JSON.stringify(malformed, null, 2)}\n`
  );
  const ledgerPath = path.join(
    fixture.root,
    "tests/e2e-results/worker-broker/ledger.json"
  );
  const malformedLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  const phaseOneEntry = malformedLedger.entries.find((entry) => (
    entry.phase === "1" && entry.currency === "current"
  ));
  phaseOneEntry.recordDigest = malformed.recordDigest;
  fs.writeFileSync(ledgerPath, `${JSON.stringify(malformedLedger, null, 2)}\n`);

  const evolvedSource = path.join(
    fixture.root,
    "plugins/grok/scripts/lib/errors.mjs"
  );
  fs.appendFileSync(
    evolvedSource,
    "\n// source evolution must not excuse malformed producer identity\n"
  );
  git(fixture.root, "add", "plugins/grok/scripts/lib/errors.mjs");
  git(fixture.root, "commit", "-m", "advance source with malformed current v4");

  let replacement = buildEvidenceRecord({
    root: fixture.root,
    phase: "0",
    slice: "evidence-system",
    status: "verified_on_draft",
    verification: exactPhaseProof("0"),
    qualification: deterministicQualification(),
    evidenceSystemQualification: true
  });
  replacement = attachRecordDigest({
    ...replacement,
    proofProducer: proofProducer("0")
  });
  const ledgerBefore = fs.readFileSync(ledgerPath, "utf8");
  assert.throws(
    () => api.__testPublishPhaseZero(replacement, fixture.root),
    /evidence|ledger/i
  );
  assert.equal(fs.readFileSync(ledgerPath, "utf8"), ledgerBefore);
  const current = loadLedger(fixture.root).entries.filter((entry) => (
    entry.currency === "current"
  ));
  assert.equal(current.length, 2);
  assert.equal(
    current.find((entry) => entry.phase === "1")?.recordDigest,
    malformed.recordDigest
  );
});

test("private signed review promotion is atomic, immutable, concurrent, and restart-fail-closed", async () => {
  const fixture = initPhaseOneSignedReviewFixture("review-promotion");
  const requestResult = createReviewRequestFixture(fixture, { write: true });
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const attestation = signedReviewAttestation(requestResult, keyPair);
  const attestationPath = writeReviewAttestationFixture(fixture.root, attestation);
  const now = new Date(Date.parse(attestation.endedAt) + 1_000).toISOString();
  const trust = {
    publicKey: keyPair.publicKey,
    expectedIssuer: "test-protected-reviewer",
    revokedKeyFingerprints: [],
    now
  };
  const originalPath = path.join(fixture.root, ...fixture.phaseOnePath.split("/"));
  const originalBytes = fs.readFileSync(originalPath, "utf8");
  const { api, harnessPath, harnessDirectory } = await loadPrivateReviewPromotionHarness(
    fixture.root
  );
  const publicKeyPem = keyPair.publicKey.export({
    type: "spki",
    format: "pem"
  }).toString();
  const barrier = path.join(harnessDirectory, "promotion.barrier");
  const firstReady = path.join(harnessDirectory, "first.ready");
  const secondReady = path.join(harnessDirectory, "second.ready");
  const first = spawnPrivateReviewPromoter({
    harnessPath,
    root: fixture.root,
    requestPath: requestResult.path,
    attestationPath,
    publicKey: publicKeyPem,
    now,
    ready: firstReady,
    barrier
  });
  const second = spawnPrivateReviewPromoter({
    harnessPath,
    root: fixture.root,
    requestPath: requestResult.path,
    attestationPath,
    publicKey: publicKeyPem,
    now,
    ready: secondReady,
    barrier
  });
  // Hosted macOS runners may need more than ten seconds to start both isolated
  // ESM children. This extends only readiness scheduling; both writers still
  // block on the same barrier before the concurrency assertion begins.
  await waitFor(
    () => fs.existsSync(firstReady) && fs.existsSync(secondReady),
    { timeoutMs: 30_000 }
  );
  fs.writeFileSync(barrier, "go\n");
  const results = await Promise.all([first.completed, second.completed]);
  const payloads = [];
  let lockContentionCount = 0;
  for (const result of results) {
    if (result.code === 0) {
      assert.equal(result.stderr, "");
      payloads.push(JSON.parse(result.stdout));
      continue;
    }
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout, "");
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.code, "E_EVIDENCE_LEDGER_LOCK");
    assert.equal(failure.commitState, null);
    assert.equal(failure.recoveryRequired, false);
    assert.equal(failure.recordDigest, null);
    lockContentionCount += 1;
  }
  assert.equal(payloads.length, 2 - lockContentionCount);
  assert.ok(payloads.length >= 1);
  assert.ok(lockContentionCount <= 1);
  // The production lock wait is deliberately bounded. A sufficiently slow
  // hosted runner may safely reject the losing concurrent attempt; retry only
  // after the winning promoter has released the lock and require convergence.
  if (lockContentionCount === 1) {
    payloads.push(api.__testPromoteSignedReview({
      root: fixture.root,
      requestPath: requestResult.path,
      attestationPath,
      trust,
      now
    }));
  }
  assert.deepEqual(payloads.map((payload) => payload.converged).sort(), [false, true]);
  assert.equal(payloads[0].recordDigest, payloads[1].recordDigest);

  const ledger = loadLedger(fixture.root);
  const current = ledger.entries.find((entry) => (
    entry.phase === "1" && entry.currency === "current"
  ));
  const original = ledger.entries.find((entry) => (
    entry.path === fixture.phaseOnePath && entry.currency === "historical"
  ));
  assert.equal(current.status, "verified_on_draft");
  assert.ok(original);
  assert.equal(fs.readFileSync(originalPath, "utf8"), originalBytes);
  const promoted = JSON.parse(fs.readFileSync(path.join(fixture.root, current.path), "utf8"));
  assert.equal(promoted.independentReviewReceipt.schemaVersion, 2);
  assert.equal(promoted.independentReviewReceipt.reviewRequest.path, requestResult.path);
  assert.equal(promoted.independentReviewReceipt.attestation.path, attestationPath);
  assert.equal(promoted.authorities.independentValidation, "pass");

  const protectedReplay = api.__testVerifySignedLedger(fixture.root, trust);
  assert.equal(protectedReplay.ok, true, protectedReplay.errors.join("; "));
  const ordinaryRestart = verifyLedger(fixture.root, { strict: true });
  assert.equal(ordinaryRestart.ok, false);
  assert.ok(ordinaryRestart.errors.some((message) => /protected host trust/i.test(message)));
  const restartedHarness = await loadPrivateReviewPromotionHarness(fixture.root);
  const restartWithProtectedTrust = restartedHarness.api.__testVerifySignedLedger(
    fixture.root,
    trust
  );
  assert.equal(
    restartWithProtectedTrust.ok,
    true,
    restartWithProtectedTrust.errors.join("; ")
  );
  const postExpiryTrust = {
    ...trust,
    now: new Date(Date.parse(requestResult.request.expiresAt) + 60_000).toISOString()
  };
  const postExpiryProtectedReplay = restartedHarness.api.__testVerifySignedLedger(
    fixture.root,
    postExpiryTrust
  );
  assert.equal(
    postExpiryProtectedReplay.ok,
    true,
    postExpiryProtectedReplay.errors.join("; ")
  );
  const postExpiryUnprotectedReplay = verifyLedger(fixture.root, { strict: true });
  assert.equal(postExpiryUnprotectedReplay.ok, false);
  assert.ok(postExpiryUnprotectedReplay.errors.some((message) => /protected host trust/i.test(message)));
  git(
    fixture.root,
    "add",
    "-f",
    "tests/e2e-results/worker-broker"
  );
  git(fixture.root, "commit", "-m", "commit immutable signed review evidence");
  const evidenceOnlyHeadReplay = restartedHarness.api.__testVerifySignedLedger(
    fixture.root,
    postExpiryTrust
  );
  assert.equal(
    evidenceOnlyHeadReplay.ok,
    true,
    evidenceOnlyHeadReplay.errors.join("; ")
  );

  assert.throws(
    () => writeEvidenceRecord(promoted, fixture.root),
    (error) => error?.code === "E_EVIDENCE_RECORD_INVALID"
  );
  assert.throws(
    () => updateLedger({
      ...current,
      currency: "current"
    }, fixture.root),
    (error) => error?.code === "E_EVIDENCE_LEDGER_UPDATE_INVALID"
  );
  const converged = api.__testPromoteSignedReview({
    root: fixture.root,
    requestPath: requestResult.path,
    attestationPath,
    trust,
    now
  });
  assert.equal(converged.converged, true);
  const convergedAfterExpiry = api.__testPromoteSignedReview({
    root: fixture.root,
    requestPath: requestResult.path,
    attestationPath,
    trust,
    now: postExpiryTrust.now
  });
  assert.equal(convergedAfterExpiry.converged, true);
  assert.equal(convergedAfterExpiry.recordDigest, converged.recordDigest);

  const publicModule = await import(
    `${EVIDENCE_MODULE_URL}?public-surface=${crypto.randomBytes(8).toString("hex")}`
  );
  assert.equal(typeof publicModule.promotePhaseOneFromProtectedRuntime, "undefined");
  assert.equal(typeof publicModule.verifySignedLedgerFromProtectedRuntime, "undefined");
  assert.equal(typeof publicModule.provePhaseTwoFromProtectedRuntime, "undefined");
  assert.equal(typeof publicModule.verifyPhaseTwoFromProtectedRuntime, "undefined");
  assert.equal(typeof publicModule.provePhaseThreeFromProtectedRuntime, "undefined");
  assert.equal(typeof publicModule.verifyPhaseThreeFromProtectedRuntime, "undefined");
  assert.equal(
    Object.keys(publicModule).some((name) => (
      /promote.*review/i.test(name)
    )),
    false
  );
  const publicFunctions = Object.entries(publicModule)
    .filter(([, value]) => typeof value === "function")
    .map(([name]) => name);
  assert.deepEqual(
    publicFunctions.filter((name) => (
      /^(?:import|sign|mint|issue|load.*trust|create.*attestation|publish.*review|promote.*review)/i
        .test(name)
    )),
    []
  );
  for (const forbiddenAuthority of [
    "REVIEW_PROMOTION_PUBLICATION_AUTHORITY",
    "SIGNED_REVIEW_VALIDATION_AUTHORITY"
  ]) {
    assert.equal(Object.hasOwn(publicModule, forbiddenAuthority), false);
  }
  const cliSource = fs.readFileSync(
    path.join(ROOT, "scripts/worker-broker-evidence.mjs"),
    "utf8"
  );
  for (const forbidden of ["--trust", "--public-key", "--key", "--signature"]) {
    assert.equal(cliSource.includes(forbidden), false, `${forbidden} must not be a CLI option`);
  }
  const genericLedgerPath = path.join(
    ROOT,
    "tests/e2e-results/worker-broker/ledger.json"
  );
  const genericLedgerBefore = fs.readFileSync(genericLedgerPath, "utf8");
  const genericPromotion = run(process.execPath, [
    path.join(ROOT, "scripts/worker-broker-evidence.mjs"),
    "promote",
    "--request",
    requestResult.path,
    "--attestation",
    attestationPath
  ], {
    cwd: ROOT,
    env: process.env,
    timeout: 10_000
  });
  assert.equal(genericPromotion.status, 2);
  assert.match(genericPromotion.stderr, /^Usage:/);
  assert.equal(fs.readFileSync(genericLedgerPath, "utf8"), genericLedgerBefore);
});

test("signed review promotion reports durable ambiguity and converges after acknowledgement faults", async () => {
  for (const scenario of [
    {
      faultMode: "post-ledger-rename-fsync",
      expectedCommitState: "committed"
    },
    {
      faultMode: "post-lock-release",
      expectedCommitState: "committed_lock_unclean"
    }
  ]) {
    const fixture = initPhaseOneSignedReviewFixture(
      `review-${scenario.faultMode}`
    );
    const requestResult = createReviewRequestFixture(fixture, { write: true });
    const keyPair = crypto.generateKeyPairSync("ed25519");
    const attestation = signedReviewAttestation(requestResult, keyPair);
    const attestationPath = writeReviewAttestationFixture(fixture.root, attestation);
    const now = new Date(Date.parse(attestation.endedAt) + 1_000).toISOString();
    const publicKeyPem = keyPair.publicKey.export({
      type: "spki",
      format: "pem"
    }).toString();
    const faulty = await loadPrivateReviewPromotionHarness(fixture.root, {
      faultMode: scenario.faultMode,
      importApi: false
    });
    const ready = path.join(faulty.harnessDirectory, "fault.ready");
    const barrier = path.join(faulty.harnessDirectory, "fault.barrier");
    const child = spawnPrivateReviewPromoter({
      harnessPath: faulty.harnessPath,
      root: fixture.root,
      requestPath: requestResult.path,
      attestationPath,
      publicKey: publicKeyPem,
      now,
      ready,
      barrier
    });
    await waitFor(() => fs.existsSync(ready), { timeoutMs: 10_000 });
    fs.writeFileSync(barrier, "go\n");
    const failed = await child.completed;
    assert.equal(failed.code, 1, failed.stderr);
    assert.equal(failed.stdout, "");
    const failure = JSON.parse(failed.stderr);
    assert.equal(failure.code, "E_REVIEW_PROMOTION_COMMIT_UNKNOWN");
    assert.equal(failure.commitState, scenario.expectedCommitState);
    assert.equal(failure.recoveryRequired, true);
    assert.match(failure.recordDigest, /^[0-9a-f]{64}$/);

    const normal = await loadPrivateReviewPromotionHarness(fixture.root);
    const trust = {
      publicKey: keyPair.publicKey,
      expectedIssuer: "test-protected-reviewer",
      revokedKeyFingerprints: [],
      now
    };
    const replay = normal.api.__testVerifySignedLedger(fixture.root, trust);
    assert.equal(replay.ok, true, replay.errors.join("; "));
    const afterExpiry = new Date(
      Date.parse(requestResult.request.expiresAt) + 60_000
    ).toISOString();
    const converged = normal.api.__testPromoteSignedReview({
      root: fixture.root,
      requestPath: requestResult.path,
      attestationPath,
      trust,
      now: afterExpiry
    });
    assert.equal(converged.ok, true);
    assert.equal(converged.converged, true);
    assert.equal(converged.recordDigest, failure.recordDigest);
    const postExpiryReplay = normal.api.__testVerifySignedLedger(fixture.root, {
      ...trust,
      now: afterExpiry
    });
    assert.equal(
      postExpiryReplay.ok,
      true,
      postExpiryReplay.errors.join("; ")
    );
  }
});

test("signed review convergence rejects a foreign current prerequisite chain", async () => {
  const fixture = initPhaseOneSignedReviewFixture("review-foreign-prerequisite");
  const requestResult = createReviewRequestFixture(fixture, { write: true });
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const attestation = signedReviewAttestation(requestResult, keyPair);
  const attestationPath = writeReviewAttestationFixture(fixture.root, attestation);
  const now = new Date(Date.parse(attestation.endedAt) + 1_000).toISOString();
  const trust = {
    publicKey: keyPair.publicKey,
    expectedIssuer: "test-protected-reviewer",
    revokedKeyFingerprints: [],
    now
  };
  const { api } = await loadPrivateReviewPromotionHarness(fixture.root);
  const promoted = api.__testPromoteSignedReview({
    root: fixture.root,
    requestPath: requestResult.path,
    attestationPath,
    trust,
    now
  });
  assert.equal(promoted.ok, true);
  assert.equal(promoted.converged, false);

  let foreignPhaseZero = buildEvidenceRecord({
    root: fixture.root,
    phase: "0",
    slice: "foreign-current-prerequisite",
    status: "verified_on_draft",
    verification: exactPhaseProof("0"),
    qualification: deterministicQualification(),
    evidenceSystemQualification: true
  });
  foreignPhaseZero = attachRecordDigest({
    ...foreignPhaseZero,
    proofProducer: proofProducer("0")
  });
  const foreignPath = rawEvidenceFixturePath(fixture.root, foreignPhaseZero);
  const ledgerPath = path.join(
    fixture.root,
    "tests/e2e-results/worker-broker/ledger.json"
  );
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  for (const entry of ledger.entries) {
    if (entry.phase === "0" && entry.currency === "current") {
      entry.currency = "historical";
    }
  }
  ledger.entries.push({
    phase: "0",
    slice: foreignPhaseZero.slice,
    status: foreignPhaseZero.status,
    path: foreignPath,
    recordDigest: foreignPhaseZero.recordDigest,
    sourceCommit: foreignPhaseZero.source.headCommit,
    currency: "current",
    recordedAt: foreignPhaseZero.recordedAt
  });
  ledger.updatedAt = foreignPhaseZero.recordedAt;
  fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  const ledgerBefore = fs.readFileSync(ledgerPath, "utf8");

  const protectedReplay = api.__testVerifySignedLedger(fixture.root, trust);
  assert.equal(protectedReplay.ok, false);
  assert.ok(protectedReplay.errors.some((message) => /prerequisite|current/i.test(message)));
  assert.throws(
    () => api.__testPromoteSignedReview({
      root: fixture.root,
      requestPath: requestResult.path,
      attestationPath,
      trust,
      now
    }),
    (error) => error?.code === "E_REVIEW_PROMOTION_CONFLICT"
  );
  assert.equal(fs.readFileSync(ledgerPath, "utf8"), ledgerBefore);
});

test("signed review promotion fails unchanged on source, prerequisite, and attestation swaps", async () => {
  for (const scenario of ["source", "prerequisite", "attestation"]) {
    const fixture = initPhaseOneSignedReviewFixture(`review-race-${scenario}`);
    const requestResult = createReviewRequestFixture(fixture, { write: true });
    const keyPair = crypto.generateKeyPairSync("ed25519");
    const attestation = signedReviewAttestation(requestResult, keyPair);
    const attestationPath = writeReviewAttestationFixture(fixture.root, attestation);
    const now = new Date(Date.parse(attestation.endedAt) + 1_000).toISOString();
    const { api } = await loadPrivateReviewPromotionHarness(fixture.root);
    if (scenario === "source") {
      fs.appendFileSync(
        path.join(fixture.root, "plugins/grok/scripts/lib/errors.mjs"),
        "\n// raced source\n"
      );
    } else if (scenario === "prerequisite") {
      const ledgerPath = path.join(
        fixture.root,
        "tests/e2e-results/worker-broker/ledger.json"
      );
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
      ledger.entries.find((entry) => (
        entry.phase === "0" && entry.currency === "current"
      )).recordDigest = "f".repeat(64);
      fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    } else {
      const absolute = path.join(fixture.root, ...attestationPath.split("/"));
      const swapped = {
        ...attestation,
        reviewerRuntimeDigest: "f".repeat(64)
      };
      fs.writeFileSync(absolute, `${JSON.stringify(swapped, null, 2)}\n`);
    }
    const ledgerPath = path.join(
      fixture.root,
      "tests/e2e-results/worker-broker/ledger.json"
    );
    const ledgerBefore = fs.readFileSync(ledgerPath, "utf8");
    const originalBefore = fs.readFileSync(
      path.join(fixture.root, ...fixture.phaseOnePath.split("/")),
      "utf8"
    );
    assert.throws(
      () => api.__testPromoteSignedReview({
        root: fixture.root,
        requestPath: requestResult.path,
        attestationPath,
        now,
        trust: {
          publicKey: keyPair.publicKey,
          expectedIssuer: "test-protected-reviewer",
          revokedKeyFingerprints: []
        }
      }),
      /review|evidence|ledger/i,
      scenario
    );
    assert.equal(fs.readFileSync(ledgerPath, "utf8"), ledgerBefore, scenario);
    assert.equal(
      fs.readFileSync(
        path.join(fixture.root, ...fixture.phaseOnePath.split("/")),
        "utf8"
      ),
      originalBefore,
      scenario
    );
  }
});
