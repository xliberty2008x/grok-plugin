import test from "node:test";
import {
  PHASE_MANDATORY_GATE_IDS,
  PRE_V5_PROOF_MANIFEST_DIGESTS,
  PROOF_PRODUCER_VERSION,
  ROOT,
  assert,
  assertQuiescentProofCleanupBoundary,
  attachIndependentReviewReceiptDigest,
  attachRecordDigest,
  buildEvidenceRecord,
  computeInventoryDigest,
  fs,
  git,
  independentReviewReceipt,
  initPhaseOneProofRunnerFixture,
  initProofRunnerFixture,
  loadLedger,
  passedCommand,
  path,
  proofProducer,
  provePhaseZero,
  run,
  seedPreRunnerCurrent,
  seedPriorProofRunnerCurrent,
  spawnProofWriter,
  tempDir,
  updateLedger,
  verifyLedger,
  verifyPhase,
  waitFor,
  writeEvidenceRecord
} from "./worker-broker-evidence-test-support.mjs";

test("proof publication atomically invalidates canonical pre-runner current claims", () => {
  const { root } = initProofRunnerFixture("proof-cutover");
  seedPreRunnerCurrent(root, "0", "legacy-zero");
  seedPreRunnerCurrent(root, "1", "legacy-one");

  const result = provePhaseZero({ phase: "0", slice: "phase-zero-baseline", root, write: true });
  assert.equal(result.ok, true, result.code);
  assert.match(result.path, /^tests\/e2e-results\/worker-broker\/phase-0\//);
  assertQuiescentProofCleanupBoundary(
    JSON.parse(fs.readFileSync(path.join(root, result.path), "utf8"))
  );
  const ledger = loadLedger(root);
  const current = ledger.entries.filter((entry) => entry.currency === "current");
  assert.equal(current.length, 1);
  assert.equal(current[0].phase, "0");
  assert.equal(current[0].recordDigest, result.recordDigest);
  assert.equal(
    ledger.entries.filter((entry) => entry.currency === "invalidated").length,
    2
  );
  const strict = verifyPhase("0", root, { strict: true });
  assert.equal(strict.ok, true, strict.errors.join("; "));
  const allStrict = verifyLedger(root, { strict: true });
  assert.equal(allStrict.ok, true, allStrict.errors.join("; "));
  const readiness = verifyLedger(root, { strict: true, requireComplete: true });
  assert.equal(readiness.ok, false);
  assert.equal(readiness.readinessReady, false);
  assert.ok(readiness.errors.some((message) => /phase 1/i.test(message)));
});

test("Phase 0 proof safely supersedes a canonical current v1 proof runner record", () => {
  const { root } = initProofRunnerFixture("proof-runner-v1-cutover");
  const prior = seedPriorProofRunnerCurrent(root);

  const result = provePhaseZero({
    phase: "0",
    slice: "phase-zero-v4-baseline",
    root,
    write: true
  });
  assert.equal(result.ok, true, result.code);
  const ledger = loadLedger(root);
  assert.equal(
    ledger.entries.find((entry) => entry.recordDigest === prior.record.recordDigest)?.currency,
    "historical"
  );
  assert.equal(
    ledger.entries.find((entry) => entry.recordDigest === result.recordDigest)?.currency,
    "current"
  );
  const strict = verifyLedger(root, { strict: true });
  assert.equal(strict.ok, true, strict.errors.join("; "));

  const malformedFixture = initProofRunnerFixture("proof-runner-v1-malformed");
  const malformedPrior = seedPriorProofRunnerCurrent(
    malformedFixture.root,
    "0",
    "runner-v2-malformed",
    2
  );
  const malformed = attachRecordDigest({
    ...malformedPrior.record,
    proofProducer: {
      ...malformedPrior.record.proofProducer,
      manifestDigest: "9".repeat(64)
    }
  });
  fs.writeFileSync(
    path.join(malformedFixture.root, malformedPrior.recordPath),
    `${JSON.stringify(malformed, null, 2)}\n`
  );
  const ledgerPath = path.join(
    malformedFixture.root,
    "tests/e2e-results/worker-broker/ledger.json"
  );
  const malformedLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  malformedLedger.entries[0].recordDigest = malformed.recordDigest;
  fs.writeFileSync(ledgerPath, `${JSON.stringify(malformedLedger, null, 2)}\n`);
  const rejected = provePhaseZero({
    phase: "0",
    slice: "must-reject-malformed-v1",
    root: malformedFixture.root,
    write: true
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "E_PROOF_PUBLICATION");
  assert.equal(loadLedger(malformedFixture.root).entries[0].currency, "current");
});

test("producer v5 atomically supersedes an immutable current v4 Phase 0/1 chain", () => {
  const { root } = initPhaseOneProofRunnerFixture("proof-runner-v4-chain-cutover");
  const priorPhaseZero = seedPriorProofRunnerCurrent(
    root,
    "0",
    "runner-v4-phase-0",
    4,
    [],
    PRE_V5_PROOF_MANIFEST_DIGESTS["0"]
  );
  const priorPhaseOne = seedPriorProofRunnerCurrent(
    root,
    "1",
    "runner-v4-phase-1",
    4,
    [{
      phase: "0",
      recordDigest: priorPhaseZero.record.recordDigest,
      gateIds: [...PHASE_MANDATORY_GATE_IDS["0"]]
    }],
    PRE_V5_PROOF_MANIFEST_DIGESTS["1"]
  );
  priorPhaseOne.record = attachRecordDigest({
    ...priorPhaseOne.record,
    status: "verified_on_draft",
    authorities: {
      ...priorPhaseOne.record.authorities,
      independentValidation: "pass"
    },
    independentReviewReceipt: attachIndependentReviewReceiptDigest({
      schemaVersion: 2,
      producerId: "worker-broker-protected-review-promoter",
      producerVersion: 1,
      reviewRequest: {
        path: "tests/e2e-results/worker-broker/review-requests/v1/0000000000000000-0000000000000000.json",
        digest: "0".repeat(64)
      },
      attestation: {
        path: "tests/e2e-results/worker-broker/review-attestations/v1/0000000000000000-0000000000000000.json",
        digest: "0".repeat(64)
      },
      issuer: "historical-v4-protected-reviewer",
      keyFingerprint: "0".repeat(64)
    })
  });
  fs.writeFileSync(
    path.join(root, priorPhaseOne.recordPath),
    `${JSON.stringify(priorPhaseOne.record, null, 2)}\n`
  );
  const priorLedgerPath = path.join(
    root,
    "tests/e2e-results/worker-broker/ledger.json"
  );
  const priorLedger = JSON.parse(fs.readFileSync(priorLedgerPath, "utf8"));
  const priorPhaseOneEntry = priorLedger.entries.find((entry) => (
    entry.phase === "1" && entry.currency === "current"
  ));
  priorPhaseOneEntry.status = priorPhaseOne.record.status;
  priorPhaseOneEntry.recordDigest = priorPhaseOne.record.recordDigest;
  fs.writeFileSync(priorLedgerPath, `${JSON.stringify(priorLedger, null, 2)}\n`);
  const phaseZeroBytes = fs.readFileSync(path.join(root, priorPhaseZero.recordPath));
  const phaseOneBytes = fs.readFileSync(path.join(root, priorPhaseOne.recordPath));
  fs.writeFileSync(path.join(root, "tracked.txt"), "source advanced after producer v4\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "advance source after producer v4");
  assert.notEqual(
    priorPhaseZero.record.source.sourceInventoryDigest,
    computeInventoryDigest(root, { includeEvidence: false }),
    "the v4 chain must be stale before cutover"
  );

  const replacement = provePhaseZero({
    phase: "0",
    slice: "producer-v5-baseline",
    root,
    write: true
  });
  assert.equal(replacement.ok, true, replacement.code);
  assert.equal(replacement.record.proofProducer.version, 5);
  const ledger = loadLedger(root);
  assert.equal(
    ledger.entries.find((entry) => (
      entry.recordDigest === priorPhaseZero.record.recordDigest
    ))?.currency,
    "historical"
  );
  assert.equal(
    ledger.entries.find((entry) => (
      entry.recordDigest === priorPhaseOne.record.recordDigest
    ))?.currency,
    "historical"
  );
  assert.equal(
    ledger.entries.find((entry) => entry.recordDigest === replacement.recordDigest)?.currency,
    "current"
  );
  assert.deepEqual(
    fs.readFileSync(path.join(root, priorPhaseZero.recordPath)),
    phaseZeroBytes,
    "Phase 0 v4 bytes remain immutable"
  );
  assert.deepEqual(
    fs.readFileSync(path.join(root, priorPhaseOne.recordPath)),
    phaseOneBytes,
    "Phase 1 v4 bytes remain immutable"
  );
  const strict = verifyLedger(root, { strict: true });
  assert.equal(strict.ok, true, strict.errors.join("; "));
});

test("baseline cutover refuses current captures, private history, and identity tampering", () => {
  {
    const { root } = initProofRunnerFixture("proof-cutover-current-capture");
    const current = buildEvidenceRecord({
      root,
      phase: "0",
      slice: "caller-capture",
      verification: [passedCommand("identity", "identity")]
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
    const result = provePhaseZero({ phase: "0", slice: "must-refuse-current", root, write: true });
    assert.equal(result.ok, false);
    assert.equal(result.code, "E_PROOF_PUBLICATION");
    assert.equal(loadLedger(root).entries.filter((entry) => entry.currency === "current")[0].slice, "caller-capture");
  }

  {
    const { root } = initProofRunnerFixture("proof-cutover-private");
    const { record } = seedPreRunnerCurrent(root, "0", "private-legacy");
    const ledger = loadLedger(root);
    const entry = ledger.entries[0];
    const privateRecord = attachRecordDigest({
      ...record,
      rawSecret: "PRIVATE_EVIDENCE_CANARY"
    });
    fs.writeFileSync(path.join(root, entry.path), `${JSON.stringify(privateRecord, null, 2)}\n`);
    entry.recordDigest = privateRecord.recordDigest;
    const ledgerPath = path.join(root, "tests/e2e-results/worker-broker/ledger.json");
    fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    const result = provePhaseZero({ phase: "0", slice: "must-refuse-private", root, write: true });
    assert.equal(result.ok, false);
    assert.equal(result.code, "E_PROOF_PUBLICATION");
    assert.equal(JSON.stringify(result).includes("PRIVATE_EVIDENCE_CANARY"), false);
    assert.equal(loadLedger(root).entries[0].currency, "current");
  }

  {
    const { root } = initProofRunnerFixture("proof-cutover-identity");
    seedPreRunnerCurrent(root, "0", "identity-legacy");
    const ledgerPath = path.join(root, "tests/e2e-results/worker-broker/ledger.json");
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    ledger.entries[0].sourceCommit = "0".repeat(40);
    fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    const result = provePhaseZero({ phase: "0", slice: "must-refuse-identity", root, write: true });
    assert.equal(result.ok, false);
    assert.equal(result.code, "E_PROOF_PUBLICATION");
    assert.equal(loadLedger(root).entries[0].currency, "current");
  }
});

test("baseline cutover rejects malformed object and null proofProducer values by property presence", () => {
  const { root } = initProofRunnerFixture("proof-cutover-malformed-producer");
  const { record, recordPath } = seedPreRunnerCurrent(root, "0", "malformed-producer-current");
  const malformed = attachRecordDigest({
    ...record,
    proofProducer: {
      id: "caller-forged-producer",
      version: PROOF_PRODUCER_VERSION,
      manifestDigest: "0".repeat(64)
    }
  });
  fs.writeFileSync(path.join(root, recordPath), `${JSON.stringify(malformed, null, 2)}\n`);
  const ledgerPath = path.join(root, "tests/e2e-results/worker-broker/ledger.json");
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  ledger.entries[0].recordDigest = malformed.recordDigest;
  fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  const result = provePhaseZero({ phase: "0", slice: "must-refuse-malformed-producer", root, write: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, "E_PROOF_PUBLICATION");
  const unchanged = loadLedger(root);
  assert.equal(unchanged.entries.filter((entry) => entry.currency === "current").length, 1);
  assert.equal(unchanged.entries[0].slice, "malformed-producer-current");
  assert.equal(unchanged.entries[0].currency, "current");

  const nullProducer = attachRecordDigest({ ...record, proofProducer: null });
  fs.writeFileSync(path.join(root, recordPath), `${JSON.stringify(nullProducer, null, 2)}\n`);
  const nullLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  nullLedger.entries[0].recordDigest = nullProducer.recordDigest;
  fs.writeFileSync(ledgerPath, `${JSON.stringify(nullLedger, null, 2)}\n`);
  const nullResult = provePhaseZero({ phase: "0", slice: "must-refuse-null-producer", root, write: true });
  assert.equal(nullResult.ok, false);
  assert.equal(nullResult.code, "E_PROOF_PUBLICATION");
  const nullUnchanged = loadLedger(root);
  assert.equal(nullUnchanged.entries.filter((entry) => entry.currency === "current").length, 1);
  assert.equal(nullUnchanged.entries[0].slice, "malformed-producer-current");
});

test("proof publication crash leaves only an orphan and retry completes cutover", () => {
  const { root } = initProofRunnerFixture("proof-cutover-crash");
  seedPreRunnerCurrent(root, "0", "legacy-before-crash");
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (path.basename(destination) === "ledger.json"
      && path.basename(source).startsWith(".ledger.json.")) {
      throw new Error("injected ledger publication crash");
    }
    return rename(source, destination);
  };
  let crashed;
  try {
    crashed = provePhaseZero({ phase: "0", slice: "crash-before-ledger", root, write: true });
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(crashed.ok, false);
  assert.equal(crashed.code, "E_PROOF_PUBLICATION");
  assert.equal(loadLedger(root).entries.filter((entry) => entry.currency === "current")[0].slice, "legacy-before-crash");
  const phaseDirectory = path.join(root, "tests/e2e-results/worker-broker/phase-0");
  assert.ok(fs.readdirSync(phaseDirectory).filter((name) => name.endsWith(".json")).length >= 2);

  const retried = provePhaseZero({ phase: "0", slice: "retry-after-crash", root, write: true });
  assert.equal(retried.ok, true, retried.code);
  const strict = verifyLedger(root, { strict: true });
  assert.equal(strict.ok, true, strict.errors.join("; "));
});

test("tracked source drift at ledger replacement invalidates every current claim before failure", () => {
  const { root } = initProofRunnerFixture("proof-post-ledger-drift");
  seedPreRunnerCurrent(root, "0", "legacy-before-post-ledger-drift");
  const rename = fs.renameSync;
  let ledgerReplacements = 0;
  fs.renameSync = (source, destination) => {
    const result = rename(source, destination);
    if (path.basename(destination) === "ledger.json"
      && path.basename(source).startsWith(".ledger.json.")) {
      ledgerReplacements += 1;
      fs.writeFileSync(path.join(root, "tracked.txt"), "drift-after-ledger-replacement\n");
    }
    return result;
  };
  let observed;
  try {
    observed = provePhaseZero({ phase: "0", slice: "post-ledger-drift", root, write: true });
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(observed.ok, false);
  assert.equal(observed.code, "E_PROOF_PUBLICATION");
  assert.ok(ledgerReplacements >= 2, "the successful rename must be followed by a fail-closed invalidation rename");
  const ledger = loadLedger(root);
  assert.equal(ledger.entries.filter((entry) => entry.currency === "current").length, 0);
  assert.equal(ledger.entries.filter((entry) => entry.currency === "invalidated").length, 2);
  const strict = verifyLedger(root, { strict: true });
  assert.equal(strict.ok, true, strict.errors.join("; "));
});

test("concurrent Phase 0 proof writers retain one current record without lost cutover", async () => {
  const { root } = initProofRunnerFixture("proof-cutover-concurrent");
  seedPreRunnerCurrent(root, "0", "legacy-concurrent");
  const control = tempDir("proof-writer-barrier-");
  const barrier = path.join(control, "go");
  const readyA = path.join(control, "ready-a");
  const readyB = path.join(control, "ready-b");
  const first = spawnProofWriter({ root, slice: "concurrent-a", ready: readyA, barrier });
  const second = spawnProofWriter({ root, slice: "concurrent-b", ready: readyB, barrier });
  await waitFor(() => fs.existsSync(readyA) && fs.existsSync(readyB));
  fs.writeFileSync(barrier, "go\n");
  const [firstResult, secondResult] = await Promise.all([first.completed, second.completed]);
  const attempts = [
    { slice: "concurrent-a", result: firstResult },
    { slice: "concurrent-b", result: secondResult }
  ];
  const retrySlices = [];
  let successfulAttempts = 0;
  for (const { slice, result } of attempts) {
    assert.equal(result.signal, null, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    const payload = JSON.parse(result.stdout);
    if (result.code === 0) {
      assert.deepEqual(payload, { ok: true, code: null });
      successfulAttempts += 1;
      continue;
    }
    assert.equal(result.code, 1, result.stdout);
    assert.deepEqual(payload, { ok: false, code: "E_PROOF_PUBLICATION" });
    retrySlices.push(slice);
  }
  assert.ok(successfulAttempts >= 1);
  assert.ok(retrySlices.length <= 1);
  // Proof publication deliberately bounds lock contention. A sufficiently
  // slow runner may reject one concurrent attempt after the other writer
  // acquired the lock; retry only after both children have closed.
  for (const slice of retrySlices) {
    const retried = provePhaseZero({ phase: "0", slice, root, write: true });
    assert.equal(retried.ok, true, retried.code);
  }
  const ledger = loadLedger(root);
  assert.equal(ledger.entries.filter((entry) => entry.currency === "current").length, 1);
  assert.equal(ledger.entries.filter((entry) => entry.currency === "invalidated").length, 1);
  assert.equal(ledger.entries.filter((entry) => entry.currency === "historical").length, 1);
  const strict = verifyLedger(root, { strict: true });
  assert.equal(strict.ok, true, strict.errors.join("; "));
});

test("prove CLI rejects injection-shaped and duplicate arguments before execution", () => {
  const cases = [
    ["--phase", "0", "--phase", "0", "--slice", "duplicate"],
    ["--phase", "0", "--slice", "valid", "--command", "true"],
    ["--phase", "0", "--slice", "valid", "--argv", "true"],
    ["--phase", "1", "--slice", "wrong-phase"],
    ["--phase", "aggregate", "--slice", "release-qualification"],
    ["--phase", "0", "--slice", "bad;touch-sentinel"],
    ["--phase", "0", "--slice", "valid", "--write", "--write"]
  ];
  for (const args of cases) {
    const result = run(process.execPath, [
      path.join(ROOT, "scripts/worker-broker-evidence.mjs"),
      "prove",
      ...args
    ], { cwd: ROOT });
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stderr, /Usage:/);
  }
});

test("verify CLI keeps require-verified code-owned and rejects ambiguous or injected modes", () => {
  const cli = path.join(ROOT, "scripts/worker-broker-evidence.mjs");
  const cases = [
    ["verify", "--phase", "1", "--require-verified", "--require-verified"],
    ["verify", "--phase", "1", "--require-verified", "--slice", "worker-api"],
    ["verify", "--phase", "1;touch-readiness-sentinel", "--require-verified"],
    ["verify", "--all", "--require-verified"],
    ["verify", "--phase", "1", "--require-complete"],
    ["status", "--require-verified"],
    ["capture", "--phase", "1", "--slice", "worker-api", "--require-verified"]
  ];
  for (const args of cases) {
    const result = run(process.execPath, [cli, ...args], { cwd: ROOT });
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, /^Usage:\n/);
    assert.equal(result.stdout, "");
  }
});

test("capture CLI refuses fabricated verified or qualified status", () => {
  for (const [phase, status] of [
    ["5", "verified_on_draft"],
    ["5", "qualified"],
    ["aggregate", "qualified"]
  ]) {
    const result = run(process.execPath, [
      path.join(ROOT, "scripts/worker-broker-evidence.mjs"),
      "capture",
      "--phase",
      phase,
      "--slice",
      "fabricated",
      "--status",
      status
    ], { cwd: ROOT });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot create/i);
  }
});

test("qualify CLI fails closed when it only records skipped live work", () => {
  const result = run(process.execPath, [
    path.join(ROOT, "scripts/worker-broker-evidence.mjs"),
    "qualify",
    "--phase",
    "1",
    "--host",
    "codex"
  ], {
    cwd: ROOT,
    env: { ...process.env, GROK_E2E: "", XAI_API_KEY: "" }
  });
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.qualified, false);
  assert.equal(payload.record.status, "implemented_unverified");
  assert.equal(payload.record.verification[0].outcome, "skip");
  assert.deepEqual(payload.record.qualification, {
    deterministic: "not_run",
    installedHost: "not_run",
    provider: "not_run",
    release: "not_run"
  });
});
