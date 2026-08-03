import test from "node:test";
import {
  EVIDENCE_MODULE_URL,
  PHASE_MANDATORY_GATE_IDS,
  PHASE_THREE_SLICE,
  PHASE_TWO_SLICE,
  PROOF_PRODUCER_VERSION,
  PROTECTED_REVIEW_BOOTSTRAP,
  PROTECTED_REVIEW_OPERATION,
  REVIEW_ATTESTATION_ROOT,
  REVIEW_REQUEST_DOMAIN,
  REVIEW_REQUEST_ROOT,
  ROOT,
  SIGNED_REVIEW_MANIFEST_DIGEST,
  assert,
  attachRecordDigest,
  attachReviewAttestationDigest,
  attachReviewRequestDigest,
  buildEvidenceRecord,
  canonicalReviewAttestationSigningBody,
  computeInventoryDigest,
  computePhaseScopeDigest,
  computeReviewAttestationDigest,
  computeReviewPublicKeyFingerprint,
  computeReviewRequestDigest,
  createPhaseOneReviewRequest,
  createReviewRequestFixture,
  crypto,
  deterministicQualification,
  exactPhaseProof,
  fs,
  git,
  gitIdentity,
  independentReviewReceipt,
  initPhaseOneProofRunnerFixture,
  initPhaseOneSignedReviewFixture,
  loadPrivateReviewPromotionHarness,
  path,
  pathToFileURL,
  phaseScopePaths,
  proofProducer,
  run,
  sha256Text,
  signedReviewAttestation,
  statusSatisfiesVerifiedPrerequisite,
  tempDir,
  validateEvidenceRecord,
  validateIndependentReviewAttestation,
  validatePhaseOneReviewRequest,
  writeEvidenceRecord
} from "./worker-broker-evidence-test-support.mjs";

test("numbered phases are draft-only and producer v5 preserves the signed Phase 1 barrier", () => {
  assert.equal(PROOF_PRODUCER_VERSION, 5);
  for (const phase of ["0", "1", "4", "5"]) {
    let unverified = buildEvidenceRecord({
      phase,
      slice: `phase-${phase}-state`,
      status: "implemented_unverified",
      verification: exactPhaseProof(phase),
      qualification: deterministicQualification(),
      evidenceSystemQualification: true
    });
    unverified = attachRecordDigest({
      ...unverified,
      source: { ...unverified.source, cleanTreeAtVerification: true },
      proofProducer: proofProducer(phase)
    });
    const unverifiedResult = validateEvidenceRecord(unverified);
    assert.equal(unverifiedResult.ok, true, `${phase}: ${unverifiedResult.errors.join("; ")}`);

    const draft = attachRecordDigest({
      ...unverified,
      status: "verified_on_draft"
    });
    const draftResult = validateEvidenceRecord(draft);
    if (phase === "1") {
      assert.equal(draftResult.ok, false);
      assert.ok(draftResult.errors.some((message) => /signed issuer-verified independent review/i.test(message)));
    } else {
      assert.equal(draftResult.ok, true, `${phase}: ${draftResult.errors.join("; ")}`);
    }

    const forbiddenQualified = attachRecordDigest({
      ...draft,
      status: "qualified"
    });
    const qualifiedResult = validateEvidenceRecord(forbiddenQualified);
    assert.equal(qualifiedResult.ok, false);
    assert.ok(qualifiedResult.errors.some((message) => /only aggregate evidence/i.test(message)));
  }

  const schema = JSON.parse(fs.readFileSync(
    path.join(ROOT, "plugins/grok/schemas/worker-broker-evidence.schema.json"),
    "utf8"
  ));
  assert.equal(schema.properties.proofProducer.properties.version.const, 4);
  const qualifiedRule = schema.allOf.find((rule) => (
    rule?.if?.properties?.status?.const === "qualified"
  ));
  assert.equal(qualifiedRule.then.properties.phase.const, "aggregate");
  assert.equal(qualifiedRule.then.properties.recordType.const, "worker-broker-aggregate");
  assert.equal(qualifiedRule.then.properties.releaseQualification.const, true);
  const numberedQualifiedProhibition = schema.allOf.find((rule) => (
    rule?.if?.properties?.phase?.enum?.length === 6
    && rule?.then?.not?.properties?.status?.const === "qualified"
  ));
  assert.ok(numberedQualifiedProhibition);
});

test("Phase 2 proof record is fixed, ordered, deterministic-only, and non-live", () => {
  let record = buildEvidenceRecord({
    phase: "2",
    slice: PHASE_TWO_SLICE,
    status: "verified_on_draft",
    verification: exactPhaseProof("2"),
    qualification: deterministicQualification(),
    evidenceSystemQualification: true,
    prerequisites: [
      {
        phase: "0",
        recordDigest: sha256Text("phase-2-prerequisite-0"),
        gateIds: [...PHASE_MANDATORY_GATE_IDS["0"]]
      },
      {
        phase: "1",
        recordDigest: sha256Text("phase-2-prerequisite-1"),
        gateIds: [...PHASE_MANDATORY_GATE_IDS["1"]]
      }
    ]
  });
  record = attachRecordDigest({
    ...record,
    source: {
      ...record.source,
      cleanTreeAtVerification: true
    },
    proofProducer: proofProducer("2")
  });
  const accepted = validateEvidenceRecord(record);
  assert.equal(accepted.ok, true, accepted.errors.join("; "));

  const mutations = [
    ["slice", (candidate) => { candidate.slice = "caller-selected"; }, /fixed slice/i],
    ["status", (candidate) => { candidate.status = "implemented_unverified"; }, /verified_on_draft/i],
    ["gate order", (candidate) => {
      candidate.verification = [
        candidate.verification[1],
        candidate.verification[0],
        candidate.verification[2]
      ];
    }, /exact ordered gate/i],
    ["prerequisite order", (candidate) => {
      candidate.prerequisites = [
        candidate.prerequisites[1],
        candidate.prerequisites[0]
      ];
    }, /exact ordered Phase 0 and signed Phase 1/i],
    ["non-deterministic boundary", (candidate) => {
      candidate.qualification.installedHost = "skip";
    }, /deterministic-only/i],
    ["live receipt slots", (candidate) => {
      candidate.liveQualificationReceipts = {
        syntheticDirectMcp: null,
        naturalCodexHost: null
      };
    }, /cannot link live qualification/i]
  ];
  for (const [label, mutate, expected] of mutations) {
    const candidate = structuredClone(record);
    mutate(candidate);
    const result = validateEvidenceRecord(attachRecordDigest(candidate));
    assert.equal(result.ok, false, label);
    assert.ok(result.errors.some((message) => expected.test(message)), label);
  }
  assert.throws(
    () => writeEvidenceRecord(record),
    /invalid/i,
    "the generic writer cannot publish the protected Phase 2 claim"
  );
});

test("Phase 3 proof record is fixed, predecessor-bound, zero-skip, and non-live", () => {
  let record = buildEvidenceRecord({
    phase: "3",
    slice: PHASE_THREE_SLICE,
    status: "verified_on_draft",
    verification: exactPhaseProof("3"),
    qualification: deterministicQualification(),
    evidenceSystemQualification: true,
    prerequisites: [
      {
        phase: "0",
        recordDigest: sha256Text("phase-3-prerequisite-0"),
        gateIds: [...PHASE_MANDATORY_GATE_IDS["0"]]
      },
      {
        phase: "1",
        recordDigest: sha256Text("phase-3-prerequisite-1"),
        gateIds: [...PHASE_MANDATORY_GATE_IDS["1"]]
      }
    ]
  });
  record = attachRecordDigest({
    ...record,
    source: {
      ...record.source,
      cleanTreeAtVerification: true
    },
    proofProducer: proofProducer("3")
  });
  const accepted = validateEvidenceRecord(record);
  assert.equal(accepted.ok, true, accepted.errors.join("; "));

  const mutations = [
    ["slice", (candidate) => { candidate.slice = "caller-selected"; }, /fixed slice/i],
    ["gate order", (candidate) => {
      candidate.verification = [
        candidate.verification[1],
        candidate.verification[0],
        candidate.verification[2]
      ];
    }, /exact ordered gate/i],
    ["prerequisite order", (candidate) => {
      candidate.prerequisites.reverse();
    }, /exact ordered Phase 0 and signed Phase 1/i],
    ["wrong predecessor gates", (candidate) => {
      candidate.prerequisites[1].gateIds = ["repository-check"];
    }, /exact ordered Phase 0 and signed Phase 1/i],
    ["skipped test", (candidate) => {
      candidate.verification[1].testsSkipped = 1;
      candidate.verification[1].skipMeaning = "not available";
    }, /zero-skip/i],
    ["TODO result", (candidate) => {
      candidate.verification[1].todo = 1;
    }, /forbidden fields/i],
    ["live receipt absorption", (candidate) => {
      candidate.liveQualificationReceipts = {
        syntheticDirectMcp: null,
        naturalCodexHost: null
      };
    }, /cannot absorb live receipts/i]
  ];
  for (const [label, mutate, expected] of mutations) {
    const candidate = structuredClone(record);
    mutate(candidate);
    const result = validateEvidenceRecord(attachRecordDigest(candidate));
    assert.equal(result.ok, false, label);
    assert.ok(result.errors.some((message) => expected.test(message)), label);
  }
  assert.throws(
    () => writeEvidenceRecord(record),
    /invalid/i,
    "the generic writer cannot publish the protected Phase 3 claim"
  );
});

test("Phase 1 rejects the reserved self-digested review receipt as unauthenticated", () => {
  assert.equal(statusSatisfiesVerifiedPrerequisite("implemented_unverified"), false);
  assert.equal(statusSatisfiesVerifiedPrerequisite("verified_on_draft"), true);
  assert.equal(statusSatisfiesVerifiedPrerequisite("verified_on_draft", "1"), true);
  assert.equal(statusSatisfiesVerifiedPrerequisite("qualified", "1"), false);
  const { root } = initPhaseOneProofRunnerFixture("phase-one-review-receipt");
  let base = buildEvidenceRecord({
    root,
    phase: "1",
    slice: "worker-api",
    status: "verified_on_draft",
    verification: exactPhaseProof("1"),
    qualification: deterministicQualification(),
    evidenceSystemQualification: true,
    authorities: {
      workerClaims: "none",
      runtimeObservations: "broker-owned bounded Phase 1 gate runner",
      hostVerification: "not_run",
      independentValidation: "pass"
    }
  });
  base = attachRecordDigest({ ...base, proofProducer: proofProducer("1") });

  const missing = validateEvidenceRecord(base, { root });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.includes(
    "verified_on_draft Phase 1 evidence requires signed issuer-verified independent review proof."
  ));
  assert.throws(() => writeEvidenceRecord(base, root), /invalid/i);

  const proofProducedUnreviewed = attachRecordDigest({
    ...base,
    status: "implemented_unverified",
    authorities: {
      ...base.authorities,
      independentValidation: "not_run"
    }
  });
  const unreviewedValidation = validateEvidenceRecord(proofProducedUnreviewed, { root });
  assert.equal(unreviewedValidation.ok, true, unreviewedValidation.errors.join("; "));
  assert.throws(
    () => writeEvidenceRecord(proofProducedUnreviewed, root),
    /invalid/i,
    "caller-authored proofProducer provenance cannot use the generic writer"
  );
  const wrongManifestGate = structuredClone(proofProducedUnreviewed);
  wrongManifestGate.verification[1].argv = ["node", "-e", "process.exit(0)"];
  const wrongManifestValidation = validateEvidenceRecord(
    attachRecordDigest(wrongManifestGate),
    { root }
  );
  assert.equal(wrongManifestValidation.ok, false);
  assert.ok(wrongManifestValidation.errors.some((message) => /argv.*code-owned proof manifest/i.test(message)));

  const receipt = independentReviewReceipt(base);
  const accepted = attachRecordDigest({ ...base, independentReviewReceipt: receipt });
  const acceptedValidation = validateEvidenceRecord(accepted, { root });
  assert.equal(acceptedValidation.ok, false);
  assert.ok(acceptedValidation.errors.includes(
    "independentReviewReceipt v1 is historical and permanently unauthenticated."
  ));
  assert.ok(acceptedValidation.errors.includes(
    "verified_on_draft Phase 1 evidence requires signed issuer-verified independent review proof."
  ));
  const publishedSchema = JSON.parse(fs.readFileSync(
    path.join(ROOT, "plugins/grok/schemas/worker-broker-evidence.schema.json"),
    "utf8"
  ));
  const signedPhaseOnePromotionRule = publishedSchema.allOf.find((rule) => (
    rule?.if?.properties?.phase?.const === "1"
    && rule?.if?.properties?.status?.const === "verified_on_draft"
    && rule?.then?.required?.includes("independentReviewReceipt")
  ));
  assert.equal(
    signedPhaseOnePromotionRule.then.properties.independentReviewReceipt
      .properties.schemaVersion.const,
    2,
    "published schema must require signed receipt v2 for Phase 1 promotion"
  );
  assert.throws(
    () => writeEvidenceRecord(accepted, root),
    /invalid/i,
    "a locally constructed receipt cannot promote or publish Phase 1"
  );
  const receiptOnlyUnverified = attachRecordDigest({
    ...proofProducedUnreviewed,
    independentReviewReceipt: receipt
  });
  assert.throws(
    () => writeEvidenceRecord(receiptOnlyUnverified, root),
    /invalid/i,
    "caller-authored review receipts cannot use the generic writer at any status"
  );

  for (const [field, value] of [
    ["manifestDigest", "9".repeat(64)],
    ["headCommit", "0".repeat(40)],
    ["headTree", "1".repeat(40)],
    ["sourceInventoryDigest", "2".repeat(64)],
    ["phaseScopeDigest", "3".repeat(64)],
    ["outcome", "fail"],
    ["unresolvedFindings", 1]
  ]) {
    const forgedReceipt = independentReviewReceipt(base, { [field]: value });
    const forged = attachRecordDigest({ ...base, independentReviewReceipt: forgedReceipt });
    const result = validateEvidenceRecord(forged, { root });
    assert.equal(result.ok, false, field);
    assert.ok(result.errors.some((message) => /independentReviewReceipt|independent review receipt/i.test(message)));
  }

  const tamperedReceipt = { ...receipt, reviewerRuntimeDigest: "4".repeat(64) };
  const tampered = attachRecordDigest({ ...base, independentReviewReceipt: tamperedReceipt });
  const tamperedValidation = validateEvidenceRecord(tampered, { root });
  assert.equal(tamperedValidation.ok, false);
  assert.ok(tamperedValidation.errors.some((message) => /receiptDigest/i.test(message)));
});

test("Phase 1 review requests bind immutable source, diff, proof, and prerequisite identities", () => {
  const fixture = initPhaseOneSignedReviewFixture("review-request-bindings");
  const createdAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const nonce = crypto.randomBytes(32).toString("base64url");
  const first = createReviewRequestFixture(fixture, {
    createdAt,
    expiresAt,
    nonce,
    write: true
  });
  assert.equal(first.ok, true);
  assert.match(
    first.path,
    new RegExp(`^${REVIEW_REQUEST_ROOT}/[0-9a-f]{16}-[0-9a-f]{16}\\.json$`)
  );
  assert.equal(first.request.domain, REVIEW_REQUEST_DOMAIN);
  assert.equal(first.request.manifestDigest, SIGNED_REVIEW_MANIFEST_DIGEST);
  assert.equal(first.request.source.headCommit, gitIdentity(fixture.root).headCommit);
  assert.equal(
    first.request.source.sourceInventoryDigest,
    computeInventoryDigest(fixture.root, { includeEvidence: false })
  );
  assert.equal(
    first.request.source.phaseScopeDigest,
    computePhaseScopeDigest("1", fixture.root)
  );
  assert.deepEqual(first.request.source.phaseScopePaths, phaseScopePaths("1", fixture.root));
  assert.equal(first.request.diff.baseCommit, fixture.baseCommit);
  assert.deepEqual(first.request.diff.paths, ["plugins/grok/scripts/lib/errors.mjs"]);
  assert.equal(first.request.proof.path, fixture.phaseOnePath);
  assert.equal(first.request.proof.recordDigest, fixture.phaseOne.recordDigest);
  assert.equal(first.request.prerequisite.path, fixture.phaseZeroPath);
  assert.equal(first.request.prerequisite.recordDigest, fixture.phaseZero.recordDigest);
  assert.equal(first.request.requestDigest, computeReviewRequestDigest(first.request));
  const valid = validatePhaseOneReviewRequest(first.request, {
    root: fixture.root,
    now: createdAt
  });
  assert.equal(valid.ok, true, valid.errors.join("; "));

  const requestFile = path.join(fixture.root, ...first.path.split("/"));
  const originalBytes = fs.readFileSync(requestFile, "utf8");
  const replay = createReviewRequestFixture(fixture, {
    createdAt,
    expiresAt,
    nonce,
    write: true
  });
  assert.equal(replay.path, first.path);
  assert.equal(fs.readFileSync(requestFile, "utf8"), originalBytes);

  assert.throws(
    () => createPhaseOneReviewRequest({
      root: fixture.root,
      baseCommit: "f".repeat(40),
      createdAt,
      expiresAt,
      nonce,
      write: false
    }),
    (error) => error?.code === "E_REVIEW_REQUEST_INVALID"
  );
  const privateRequest = attachReviewRequestDigest({
    ...structuredClone(first.request),
    diff: {
      ...structuredClone(first.request.diff),
      paths: ["/private/tmp/review-canary"],
      pathsDigest: sha256Text(JSON.stringify(["/private/tmp/review-canary"]))
    }
  });
  const privateValidation = validatePhaseOneReviewRequest(privateRequest, {
    now: createdAt
  });
  assert.equal(privateValidation.ok, false);
  assert.ok(privateValidation.errors.some((message) => /unsafe|diff binding/i.test(message)));

  const external = tempDir("review-request-symlink-");
  const requestDirectory = path.join(fixture.root, REVIEW_REQUEST_ROOT);
  fs.rmSync(requestDirectory, { recursive: true, force: true });
  fs.symlinkSync(external, requestDirectory);
  assert.throws(
    () => createReviewRequestFixture(fixture, {
      createdAt,
      expiresAt,
      nonce: crypto.randomBytes(32).toString("base64url"),
      write: true
    }),
    (error) => error?.code === "E_REVIEW_REQUEST_INVALID"
  );
  assert.deepEqual(fs.readdirSync(external), []);
});

test("Phase 1 review request rejects dirty and stale source identities", () => {
  const dirtyFixture = initPhaseOneSignedReviewFixture("review-request-dirty");
  const dirtyFile = path.join(dirtyFixture.root, "plugins/grok/scripts/lib/errors.mjs");
  fs.appendFileSync(dirtyFile, "\n// uncommitted dirty review\n");
  assert.throws(
    () => createReviewRequestFixture(dirtyFixture, { write: false }),
    (error) => error?.code === "E_REVIEW_REQUEST_INVALID"
  );

  const staleFixture = initPhaseOneSignedReviewFixture("review-request-stale");
  const result = createReviewRequestFixture(staleFixture, { write: true });
  const staleFile = path.join(staleFixture.root, "plugins/grok/scripts/lib/errors.mjs");
  fs.appendFileSync(staleFile, "\n// source moved after request\n");
  git(staleFixture.root, "add", "plugins/grok/scripts/lib/errors.mjs");
  git(staleFixture.root, "commit", "-m", "move source after review request");
  const stale = validatePhaseOneReviewRequest(result.request, {
    root: staleFixture.root,
    now: result.request.createdAt
  });
  assert.equal(stale.ok, false);
  assert.ok(stale.errors.some((message) => /stale|current bindings/i.test(message)));

  const symlinkFixture = initPhaseOneSignedReviewFixture("review-request-source-symlink");
  const symlinkRequest = createReviewRequestFixture(symlinkFixture, { write: true });
  const sourceDirectory = path.join(
    symlinkFixture.root,
    "plugins/grok/scripts/lib"
  );
  const externalMirror = path.join(tempDir("review-source-mirror-"), "lib");
  fs.renameSync(sourceDirectory, externalMirror);
  fs.symlinkSync(externalMirror, sourceDirectory);
  const symlinked = validatePhaseOneReviewRequest(symlinkRequest.request, {
    root: symlinkFixture.root,
    now: symlinkRequest.request.createdAt
  });
  assert.equal(symlinked.ok, false);
  assert.ok(symlinked.errors.some((message) => /clean|symlink|bindings/i.test(message)));
});

test("review canonicalization, Ed25519 SPKI, fingerprint, and signature match a fixed vector", () => {
  const spkiBase64 = "MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=";
  const fingerprint = "06e3fd8fda29bb60ab59557de61edb0aecdb231134be30e75b455f8e1b792fa9";
  const signature = "c7-LfcysTSUWuQiPO7uXKxYVXSK8QdDUUyR-v9RetBlVWn7sHvtka73Qv1Rg7MHyE-rH-xjWPVOLdu1ywHo0Bw";
  const expectedBody = '{"a":{"x":1,"y":2},"list":[3,"x"],"z":"last"}';
  const unordered = {
    z: "last",
    list: [3, "x"],
    a: { y: 2, x: 1 },
    signature: "not-part-of-the-signing-body",
    attestationDigest: "not-part-of-the-signing-body"
  };
  const body = canonicalReviewAttestationSigningBody(unordered);
  assert.equal(body, expectedBody);
  const publicKey = crypto.createPublicKey({
    key: Buffer.from(spkiBase64, "base64"),
    type: "spki",
    format: "der"
  });
  assert.equal(publicKey.asymmetricKeyType, "ed25519");
  assert.equal(computeReviewPublicKeyFingerprint(publicKey), fingerprint);
  assert.equal(Buffer.from(signature, "base64url").length, 64);
  assert.equal(
    crypto.verify(
      null,
      Buffer.from(expectedBody, "utf8"),
      publicKey,
      Buffer.from(signature, "base64url")
    ),
    true
  );
  assert.equal(
    computeReviewAttestationDigest({
      ...unordered,
      signature,
      attestationDigest: "ignored"
    }),
    "ab3d72d8d3a4a8827cc9b808c0d1f92aea9b1c8c938b9f9d9535608bba733c5c"
  );
});

test("external Ed25519 review attestations verify exact bindings and fail closed", () => {
  const fixture = initPhaseOneSignedReviewFixture("review-attestation");
  const requestResult = createReviewRequestFixture(fixture, { write: true });
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const otherKeyPair = crypto.generateKeyPairSync("ed25519");
  const attestation = signedReviewAttestation(requestResult, keyPair);
  const now = new Date(Date.parse(attestation.endedAt) + 1_000).toISOString();
  const valid = validateIndependentReviewAttestation(attestation, {
    request: requestResult.request,
    requestPath: requestResult.path,
    publicKey: keyPair.publicKey,
    expectedIssuer: "test-protected-reviewer",
    revokedKeyFingerprints: [],
    now
  });
  assert.equal(valid.ok, true, valid.errors.join("; "));
  assert.equal(attestation.attestationDigest, computeReviewAttestationDigest(attestation));
  assert.equal(valid.keyFingerprint, computeReviewPublicKeyFingerprint(keyPair.publicKey));

  const cases = [
    ["wrong-key", attestation, { publicKey: otherKeyPair.publicKey }],
    ["wrong-issuer", attestation, { expectedIssuer: "different-protected-reviewer" }],
    ["wrong-fingerprint", signedReviewAttestation(requestResult, keyPair, {
      keyFingerprint: "f".repeat(64)
    }), {}],
    ["wrong-algorithm", signedReviewAttestation(requestResult, keyPair, {
      algorithm: "RSA-PSS"
    }), {}],
    ["malformed-signature", attachReviewAttestationDigest({
      ...attestation,
      signature: "A".repeat(85)
    }), {}],
    ["tampered-after-sign", attachReviewAttestationDigest({
      ...attestation,
      reviewerRuntimeDigest: "e".repeat(64)
    }), {}],
    ["revoked", attestation, {
      revokedKeyFingerprints: [attestation.keyFingerprint]
    }],
    ["non-pass", signedReviewAttestation(requestResult, keyPair, {
      outcome: "fail"
    }), {}],
    ["findings", signedReviewAttestation(requestResult, keyPair, {
      unresolvedFindings: 1
    }), {}],
    ["future-attestation", signedReviewAttestation(requestResult, keyPair, {
      startedAt: new Date(Date.parse(now) + 10_000).toISOString(),
      endedAt: new Date(Date.parse(now) + 20_000).toISOString()
    }), {}]
  ];
  for (const [label, candidate, overrides] of cases) {
    const result = validateIndependentReviewAttestation(candidate, {
      request: requestResult.request,
      requestPath: requestResult.path,
      publicKey: keyPair.publicKey,
      expectedIssuer: "test-protected-reviewer",
      revokedKeyFingerprints: [],
      now,
      ...overrides
    });
    assert.equal(result.ok, false, label);
  }
  const futureAttestation = signedReviewAttestation(requestResult, keyPair, {
    startedAt: new Date(Date.parse(now) + 10_000).toISOString(),
    endedAt: new Date(Date.parse(now) + 20_000).toISOString()
  });
  const futureDurableReplay = validateIndependentReviewAttestation(
    futureAttestation,
    {
      request: requestResult.request,
      requestPath: requestResult.path,
      publicKey: keyPair.publicKey,
      expectedIssuer: "test-protected-reviewer",
      revokedKeyFingerprints: [],
      now,
      requireFreshRequest: false
    }
  );
  assert.equal(futureDurableReplay.ok, false);
  assert.ok(futureDurableReplay.errors.some((message) => /chronology/i.test(message)));
  const replayedRequest = attachReviewRequestDigest({
    ...structuredClone(requestResult.request),
    nonce: crypto.randomBytes(32).toString("base64url")
  });
  assert.equal(validateIndependentReviewAttestation(attestation, {
    request: replayedRequest,
    publicKey: keyPair.publicKey,
    expectedIssuer: "test-protected-reviewer",
    now
  }).ok, false);
  const expired = validateIndependentReviewAttestation(attestation, {
    request: requestResult.request,
    requestPath: requestResult.path,
    publicKey: keyPair.publicKey,
    expectedIssuer: "test-protected-reviewer",
    now: new Date(Date.parse(requestResult.request.expiresAt) + 1).toISOString()
  });
  assert.equal(expired.ok, false);
  assert.ok(expired.errors.some((message) => /expired request/i.test(message)));
  const rsaKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
  const wrongKeyType = validateIndependentReviewAttestation(attestation, {
    request: requestResult.request,
    requestPath: requestResult.path,
    publicKey: rsaKey,
    expectedIssuer: "test-protected-reviewer",
    now
  });
  assert.equal(wrongKeyType.ok, false);
  assert.ok(wrongKeyType.errors.some((message) => /Ed25519 key/i.test(message)));
});

test("protected attestation import validates, publishes immutably, and promotes", async () => {
  const fixture = initPhaseOneSignedReviewFixture("review-import");
  const requestResult = createReviewRequestFixture(fixture, { write: true });
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const attestation = signedReviewAttestation(requestResult, keyPair);
  const now = new Date(Date.parse(attestation.endedAt) + 1_000).toISOString();
  const trust = {
    publicKey: keyPair.publicKey,
    expectedIssuer: "test-protected-reviewer",
    revokedKeyFingerprints: []
  };
  const { api } = await loadPrivateReviewPromotionHarness(fixture.root);
  const attestationPath = api.__testImportSignedReview({
    root: fixture.root,
    requestPath: requestResult.path,
    attestation,
    trust,
    now
  });
  assert.match(
    attestationPath,
    new RegExp(`^${REVIEW_ATTESTATION_ROOT}/[0-9a-f]{16}-[0-9a-f]{16}\\.json$`)
  );
  const absolute = path.join(fixture.root, ...attestationPath.split("/"));
  const originalBytes = fs.readFileSync(absolute, "utf8");
  assert.deepEqual(JSON.parse(originalBytes), attestation);
  assert.equal(api.__testImportSignedReview({
    root: fixture.root,
    requestPath: requestResult.path,
    attestation,
    trust,
    now
  }), attestationPath);
  assert.equal(fs.readFileSync(absolute, "utf8"), originalBytes);

  const promoted = api.__testPromoteSignedReview({
    root: fixture.root,
    requestPath: requestResult.path,
    attestationPath,
    trust,
    now
  });
  assert.equal(promoted.ok, true);
  assert.equal(promoted.converged, false);
  assert.equal(api.__testImportSignedReview({
    root: fixture.root,
    requestPath: requestResult.path,
    attestation,
    trust,
    now: new Date(
      Date.parse(requestResult.request.expiresAt) + 60_000
    ).toISOString()
  }), attestationPath);

  const rejectedFixture = initPhaseOneSignedReviewFixture("review-import-reject");
  const rejectedRequest = createReviewRequestFixture(rejectedFixture, { write: true });
  const rejectedHarness = await loadPrivateReviewPromotionHarness(rejectedFixture.root);
  const rejectedRoot = path.join(
    rejectedFixture.root,
    REVIEW_ATTESTATION_ROOT
  );
  const ledgerBefore = fs.readFileSync(
    path.join(rejectedFixture.root, "tests/e2e-results/worker-broker/ledger.json"),
    "utf8"
  );
  const malformed = {
    ...signedReviewAttestation(rejectedRequest, keyPair),
    unsupported: "caller-controlled"
  };
  assert.throws(
    () => rejectedHarness.api.__testImportSignedReview({
      root: rejectedFixture.root,
      requestPath: rejectedRequest.path,
      attestation: malformed,
      trust,
      now
    }),
    (error) => error?.code === "E_REVIEW_ATTESTATION_INVALID"
  );
  const oversized = {
    ...signedReviewAttestation(rejectedRequest, keyPair),
    unsupported: "x".repeat(2 * 1024 * 1024)
  };
  assert.throws(
    () => rejectedHarness.api.__testImportSignedReview({
      root: rejectedFixture.root,
      requestPath: rejectedRequest.path,
      attestation: oversized,
      trust,
      now
    }),
    (error) => error?.code === "E_REVIEW_ATTESTATION_INVALID"
  );
  assert.equal(fs.existsSync(rejectedRoot), false);
  assert.equal(
    fs.readFileSync(
      path.join(rejectedFixture.root, "tests/e2e-results/worker-broker/ledger.json"),
      "utf8"
    ),
    ledgerBefore
  );

  const collisionFixture = initPhaseOneSignedReviewFixture("review-import-collision");
  const collisionRequest = createReviewRequestFixture(collisionFixture, { write: true });
  const collisionAttestation = signedReviewAttestation(collisionRequest, keyPair);
  const collisionNow = new Date(
    Date.parse(collisionAttestation.endedAt) + 1_000
  ).toISOString();
  const collisionRelative = `${REVIEW_ATTESTATION_ROOT}/${
    collisionAttestation.requestDigest.slice(0, 16)
  }-${collisionAttestation.attestationDigest.slice(0, 16)}.json`;
  const collisionAbsolute = path.join(
    collisionFixture.root,
    ...collisionRelative.split("/")
  );
  fs.mkdirSync(path.dirname(collisionAbsolute), { recursive: true });
  const collisionBytes = "{\"immutable\":\"foreign\"}\n";
  fs.writeFileSync(collisionAbsolute, collisionBytes, { mode: 0o600 });
  const collisionLedger = path.join(
    collisionFixture.root,
    "tests/e2e-results/worker-broker/ledger.json"
  );
  const collisionLedgerBefore = fs.readFileSync(collisionLedger, "utf8");
  const collisionHarness = await loadPrivateReviewPromotionHarness(
    collisionFixture.root
  );
  assert.throws(
    () => collisionHarness.api.__testImportSignedReview({
      root: collisionFixture.root,
      requestPath: collisionRequest.path,
      attestation: collisionAttestation,
      trust,
      now: collisionNow
    }),
    (error) => error?.code === "E_REVIEW_ATTESTATION_INVALID"
  );
  assert.equal(fs.readFileSync(collisionAbsolute, "utf8"), collisionBytes);
  assert.equal(fs.readFileSync(collisionLedger, "utf8"), collisionLedgerBefore);

  const symlinkFixture = initPhaseOneSignedReviewFixture("review-import-symlink");
  const symlinkRequest = createReviewRequestFixture(symlinkFixture, { write: true });
  const symlinkHarness = await loadPrivateReviewPromotionHarness(symlinkFixture.root);
  const external = tempDir("review-import-external-");
  const symlinkAttestation = signedReviewAttestation(symlinkRequest, keyPair);
  const symlinkNow = new Date(
    Date.parse(symlinkAttestation.endedAt) + 1_000
  ).toISOString();
  const attestationDirectory = path.join(
    symlinkFixture.root,
    REVIEW_ATTESTATION_ROOT
  );
  fs.mkdirSync(path.dirname(attestationDirectory), { recursive: true });
  fs.symlinkSync(external, attestationDirectory);
  assert.throws(
    () => symlinkHarness.api.__testImportSignedReview({
      root: symlinkFixture.root,
      requestPath: symlinkRequest.path,
      attestation: symlinkAttestation,
      trust,
      now: symlinkNow
    }),
    (error) => error?.code === "E_REVIEW_ATTESTATION_INVALID"
  );
  assert.deepEqual(fs.readdirSync(external), []);
});

test("protected review entrypoints fail closed outside the fixed host runtime", async () => {
  const fixture = initPhaseOneSignedReviewFixture("review-protected-bootstrap");
  const requestResult = createReviewRequestFixture(fixture, { write: true });
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const attestation = signedReviewAttestation(requestResult, keyPair);
  const ledgerPath = path.join(
    fixture.root,
    "tests/e2e-results/worker-broker/ledger.json"
  );
  const ledgerBefore = fs.readFileSync(ledgerPath, "utf8");
  const cleanEnvironment = { PATH: "/usr/bin:/bin" };
  const cases = [
    {
      label: "ordinary source checkout",
      args: ["verify", "--workspace", fixture.root],
      env: cleanEnvironment
    },
    {
      label: "ordinary source checkout Phase 2 proof",
      args: ["prove-phase-2", "--workspace", fixture.root],
      env: cleanEnvironment
    },
    {
      label: "ordinary source checkout Phase 2 replay",
      args: ["verify-phase-2", "--workspace", fixture.root],
      env: cleanEnvironment
    },
    {
      label: "ordinary source checkout Phase 3 proof",
      args: ["prove-phase-3", "--workspace", fixture.root],
      env: cleanEnvironment
    },
    {
      label: "ordinary source checkout Phase 3 replay",
      args: ["verify-phase-3", "--workspace", fixture.root],
      env: cleanEnvironment
    },
    {
      label: "caller PATH",
      args: ["verify", "--workspace", fixture.root],
      env: { PATH: `/caller-controlled${path.delimiter}/usr/bin:/bin` }
    },
    {
      label: "Node preload controls",
      args: ["verify", "--workspace", fixture.root],
      env: { ...cleanEnvironment, NODE_OPTIONS: "--no-warnings" }
    },
    {
      label: "caller-selected trust",
      args: ["verify", "--workspace", fixture.root, "--key", "attacker-key"],
      env: cleanEnvironment
    },
    {
      label: "caller-selected attestation path",
      args: [
        "promote",
        "--workspace",
        fixture.root,
        "--request",
        requestResult.path,
        "--attestation",
        "attacker.json"
      ],
      env: cleanEnvironment,
      input: `${JSON.stringify(attestation)}\n`
    }
  ];
  for (const scenario of cases) {
    const result = run(process.execPath, [
      PROTECTED_REVIEW_BOOTSTRAP,
      ...scenario.args
    ], {
      cwd: ROOT,
      env: scenario.env,
      input: scenario.input,
      timeout: 10_000
    });
    assert.equal(result.status, 1, scenario.label);
    assert.equal(result.signal, null, scenario.label);
    assert.equal(result.stderr, "", scenario.label);
    assert.deepEqual(
      JSON.parse(result.stdout),
      { ok: false, code: "E_REVIEW_TRUST_UNAVAILABLE" },
      scenario.label
    );
    assert.equal(fs.readFileSync(ledgerPath, "utf8"), ledgerBefore, scenario.label);
  }

  const directOperation = run(process.execPath, [
    PROTECTED_REVIEW_OPERATION,
    "verify",
    "--workspace",
    fixture.root
  ], {
    cwd: ROOT,
    env: cleanEnvironment,
    timeout: 10_000
  });
  assert.equal(directOperation.status, 1);
  assert.equal(directOperation.signal, null);
  assert.equal(directOperation.stderr, "");
  assert.deepEqual(JSON.parse(directOperation.stdout), {
    ok: false,
    code: "E_REVIEW_TRUST_UNAVAILABLE"
  });

  const publicModule = await import(
    `${EVIDENCE_MODULE_URL}?protected-surface=${
      crypto.randomBytes(8).toString("hex")
    }`
  );
  for (const privileged of [
    "promotePhaseOneFromProtectedRuntime",
    "verifySignedLedgerFromProtectedRuntime",
    "provePhaseTwoFromProtectedRuntime",
    "verifyPhaseTwoFromProtectedRuntime",
    "provePhaseThreeFromProtectedRuntime",
    "verifyPhaseThreeFromProtectedRuntime"
  ]) {
    assert.equal(Object.hasOwn(publicModule, privileged), false, privileged);
  }

  const forgedSpawnMarker = path.join(
    tempDir("worker-review-direct-import-"),
    "spawned"
  );
  const adversarialSource = `
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const originalSpawnSync = childProcess.spawnSync.bind(childProcess);
childProcess.spawnSync = (command, args, options) => {
  const invocation = JSON.stringify({
    command,
    args,
    protectedChild: options?.env?.GROK_PROTECTED_OPERATION_CHILD || null
  });
  if (/worker-broker-review-operation|prove-phase-[23]|verify-phase-[23]|promote/u
    .test(invocation)) {
    fs.writeFileSync(${JSON.stringify(forgedSpawnMarker)}, "privileged\\n");
  }
  return originalSpawnSync(command, args, options);
};
syncBuiltinESMExports();
process.argv[1] = ${JSON.stringify(path.join(
    ROOT,
    "scripts/lib/worker-broker-evidence.mjs"
  ))};
await import(${JSON.stringify(pathToFileURL(PROTECTED_REVIEW_BOOTSTRAP).href)}
  + "?adversarial-bootstrap=" + Math.random());
const api = await import(${JSON.stringify(EVIDENCE_MODULE_URL)}
  + "?adversarial=" + Math.random());
const forbidden = [
  "promotePhaseOneFromProtectedRuntime",
  "verifySignedLedgerFromProtectedRuntime",
  "provePhaseTwoFromProtectedRuntime",
  "verifyPhaseTwoFromProtectedRuntime",
  "provePhaseThreeFromProtectedRuntime",
  "verifyPhaseThreeFromProtectedRuntime"
];
if (forbidden.some((name) => Object.hasOwn(api, name))) process.exitCode = 2;
process.stdout.write(JSON.stringify({
  inert: true,
  privilegedExports: forbidden.filter((name) => Object.hasOwn(api, name))
}));
`;
  const adversarialImport = run(process.execPath, [
    "--input-type=module",
    "--eval",
    adversarialSource
  ], {
    cwd: ROOT,
    env: process.env,
    timeout: 10_000
  });
  assert.equal(
    adversarialImport.status,
    0,
    `${adversarialImport.stdout}\n${adversarialImport.stderr}`
  );
  assert.equal(adversarialImport.stderr, "");
  assert.deepEqual(JSON.parse(adversarialImport.stdout), {
    inert: true,
    privilegedExports: []
  });
  assert.equal(fs.existsSync(forgedSpawnMarker), false);
  assert.equal(fs.readFileSync(ledgerPath, "utf8"), ledgerBefore);
});
