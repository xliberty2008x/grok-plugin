import test from "node:test";
import {
  EVIDENCE_MODULE_URL,
  LIVE_RECEIPT_AUTHORITY_CONFIG,
  LIVE_RECEIPT_AUTHORITY_NATURAL,
  LIVE_RECEIPT_AUTHORITY_SYNTHETIC,
  LIVE_RECEIPT_CAPABILITY_TOOL_IDS,
  LIVE_RECEIPT_MANIFEST,
  LIVE_RECEIPT_NATURAL_TOOL_IDS,
  LIVE_RECEIPT_PRODUCER_ID,
  LIVE_RECEIPT_PRODUCER_VERSION,
  LIVE_RECEIPT_PROVIDER_CAPABILITIES,
  LIVE_RECEIPT_ROOT,
  LIVE_RECEIPT_SCENARIO_IDS,
  LIVE_RECEIPT_SCHEMA_VERSION,
  PHASE_MANDATORY_GATE_IDS,
  ROOT,
  assert,
  attachRecordDigest,
  attachStructuralLiveReceiptDigest,
  buildEvidenceRecord,
  computeLiveQualificationReceiptDigest,
  computeLiveReceiptManifestDigest,
  computePhaseScopeDigest,
  createPluginInventory,
  crypto,
  digestInventory,
  exactPhaseProof,
  fs,
  git,
  initLiveReceiptFixture,
  liveQualificationRecord,
  passedCommand,
  path,
  phaseScopePaths,
  proofProducer,
  rawEvidenceFixturePath,
  seedStructuralLiveReceipt,
  sha256Text,
  spawn,
  structuralLiveReceipt,
  tempDir,
  updateLedger,
  validateEvidenceRecord,
  validateLiveQualificationReceipt,
  writeEvidenceRecord
} from "./worker-broker-evidence-test-support.mjs";

test("live receipt v2 supports strict offline replay but exports no generic mint or publication authority", async () => {
  const evidenceModule = await import(EVIDENCE_MODULE_URL);
  for (const unsupported of [
    "attachLiveQualificationReceiptDigest",
    "buildLiveQualificationReceipt",
    "publishLiveQualificationReceipt",
    "writeLiveQualifiedEvidenceRecord"
  ]) {
    assert.equal(Object.hasOwn(evidenceModule, unsupported), false, unsupported);
  }
  assert.deepEqual(
    Object.keys(evidenceModule).filter((name) => (
      /(?:attach|build|create|mint|publish|write|link).*LiveQualification/i.test(name)
      || /LiveQualification.*(?:attach|build|create|mint|publish|write|link)/i.test(name)
    )),
    []
  );
  assert.equal(
    LIVE_RECEIPT_ROOT,
    "tests/e2e-results/worker-broker/live-receipts/v2"
  );
  const historicalV1 = path.join(
    ROOT,
    "tests/e2e-results/worker-broker/live-receipts/v1/synthetic-direct-mcp",
    "9e109ac49369cb53-2babb2f1362e0b7e.json"
  );
  assert.equal(fs.existsSync(historicalV1), true);
  assert.equal(
    crypto.createHash("sha256").update(fs.readFileSync(historicalV1)).digest("hex"),
    "d8347082d42c1f6ad931350b82d6ed0efee0e1a5c031e71d56cfeec38d3137ef"
  );
  const staleV1 = JSON.parse(fs.readFileSync(historicalV1, "utf8"));
  assert.equal(staleV1.schemaVersion, 1);
  assert.equal(validateLiveQualificationReceipt(staleV1).ok, false);

  const fixture = initLiveReceiptFixture("live-receipt-positive");
  const ignoredLinkInput = buildEvidenceRecord({
    root: fixture.root,
    phase: "1",
    slice: "unsupported-live-link-input",
    liveQualificationReceipts: {
      syntheticDirectMcp: {
        path: `${LIVE_RECEIPT_ROOT}/synthetic-direct-mcp/${"a".repeat(16)}-${"b".repeat(16)}.json`,
        receiptDigest: "c".repeat(64)
      },
      naturalCodexHost: null
    }
  });
  assert.equal(Object.hasOwn(ignoredLinkInput, "liveQualificationReceipts"), false);
  const synthetic = structuralLiveReceipt(fixture, LIVE_RECEIPT_AUTHORITY_SYNTHETIC);
  assert.equal(synthetic.producerId, LIVE_RECEIPT_PRODUCER_ID);
  assert.equal(synthetic.producerVersion, LIVE_RECEIPT_PRODUCER_VERSION);
  assert.equal(synthetic.manifestDigest, computeLiveReceiptManifestDigest());
  assert.equal(synthetic.phase, "1");
  assert.deepEqual(synthetic.observedToolIds, LIVE_RECEIPT_CAPABILITY_TOOL_IDS);
  assert.deepEqual(
    synthetic.observedProviderCapabilities,
    LIVE_RECEIPT_PROVIDER_CAPABILITIES
  );
  assert.equal(
    synthetic.sourcePluginInventoryDigest,
    synthetic.installedPluginInventoryDigest
  );
  assert.equal(synthetic.repositoryBeforeDigest, synthetic.sourceInventoryDigest);
  assert.equal(synthetic.repositoryAfterDigest, synthetic.sourceInventoryDigest);
  assert.equal(
    synthetic.receiptDigest,
    computeLiveQualificationReceiptDigest(synthetic)
  );
  assert.equal(
    synthetic.providerRevision,
    `binary-sha256-${synthetic.providerBinaryDigest}`
  );
  assert.equal(LIVE_RECEIPT_MANIFEST.providerRevisionScheme, "binary-sha256-v1");
  assert.deepEqual(
    synthetic.scenarios,
    LIVE_RECEIPT_AUTHORITY_CONFIG[LIVE_RECEIPT_AUTHORITY_SYNTHETIC].scenarios
  );
  assert.deepEqual(synthetic.scenarios[0].mailbox, {
    providerGenerationCount: 1,
    providerSessionCount: 1,
    promptCount: 3,
    sendInvocationCount: 3,
    sendReplayCount: 1,
    acceptedCount: 2,
    deliveredCount: 2,
    deliveryUnknownCount: 0,
    rejectedCount: 0,
    finalReportSequence: 2,
    replayPromptDelta: 0,
    retainedBodyCount: 0,
    closed: true
  });
  assert.equal(synthetic.scenarios[1].mailbox, null);
  assert.deepEqual(
    {
      spawnInvocationCount: synthetic.scenarios[1].spawnInvocationCount,
      spawnReplayCount: synthetic.scenarios[1].spawnReplayCount,
      providerLaunchCount: synthetic.scenarios[1].providerLaunchCount,
      duplicateLaunchCount: synthetic.scenarios[1].duplicateLaunchCount,
      cancelInvocationCount: synthetic.scenarios[1].cancelInvocationCount,
      cancelReplayCount: synthetic.scenarios[1].cancelReplayCount,
      uniqueCancelRequestCount: synthetic.scenarios[1].uniqueCancelRequestCount,
      cancellationEventCount: synthetic.scenarios[1].cancellationEventCount
    },
    {
      spawnInvocationCount: 2,
      spawnReplayCount: 1,
      providerLaunchCount: 1,
      duplicateLaunchCount: 0,
      cancelInvocationCount: 2,
      cancelReplayCount: 1,
      uniqueCancelRequestCount: 1,
      cancellationEventCount: 1
    }
  );
  assert.equal(
    validateLiveQualificationReceipt(synthetic, { strict: true, root: fixture.root }).ok,
    true
  );

  const natural = structuralLiveReceipt(fixture, LIVE_RECEIPT_AUTHORITY_NATURAL);
  assert.equal(natural.phase, "4");
  assert.equal(natural.installationMethod, "codex-local-plugin-cache");
  assert.match(natural.codexBinaryDigest, /^[0-9a-f]{64}$/);
  assert.equal(natural.codexVersion, "0.120.0-fixture");
  assert.equal(natural.codexModel, "gpt-5.6-fixture");
  assert.equal(natural.hostTaskDigest, fixture.hostTaskDigest);
  assert.equal(natural.providerCapabilityDigest, synthetic.providerCapabilityDigest);
  assert.deepEqual(natural.observedToolIds, LIVE_RECEIPT_NATURAL_TOOL_IDS);
  assert.equal(synthetic.codexBinaryDigest, null);
  assert.equal(synthetic.codexVersion, null);
  assert.equal(synthetic.codexModel, null);
  assert.equal(synthetic.hostTaskDigest, null);
  assert.deepEqual(
    natural.scenarios,
    LIVE_RECEIPT_AUTHORITY_CONFIG[LIVE_RECEIPT_AUTHORITY_NATURAL].scenarios
  );
  assert.equal(natural.scenarios[0].mailbox, null);
  assert.ok(natural.scenarios.every((scenario) => (
    scenario.workerHostVerification === "not_run"
  )));

  const serialized = JSON.stringify({ synthetic, natural });
  for (const forbidden of [
    fixture.root,
    "\"pid\"",
    "\"token\"",
    "\"sessionId\"",
    "\"prompt\"",
    "\"transcript\"",
    "\"rawOutput\""
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  const schema = JSON.parse(fs.readFileSync(
    path.join(ROOT, "plugins/grok/schemas/worker-broker-live-receipt.schema.json"),
    "utf8"
  ));
  assert.equal(schema.properties.manifestDigest.const, computeLiveReceiptManifestDigest());
  const syntheticRule = schema.allOf.find((rule) => (
    rule?.if?.properties?.authorityMode?.const === LIVE_RECEIPT_AUTHORITY_SYNTHETIC
  ));
  const naturalRule = schema.allOf.find((rule) => (
    rule?.if?.properties?.authorityMode?.const === LIVE_RECEIPT_AUTHORITY_NATURAL
  ));
  assert.deepEqual(
    syntheticRule.then.properties.observedToolIds.const,
    LIVE_RECEIPT_CAPABILITY_TOOL_IDS
  );
  assert.deepEqual(
    schema.properties.observedProviderCapabilities.const,
    LIVE_RECEIPT_PROVIDER_CAPABILITIES
  );
  assert.deepEqual(
    naturalRule.then.properties.observedToolIds.const,
    LIVE_RECEIPT_NATURAL_TOOL_IDS
  );
  assert.equal(
    LIVE_RECEIPT_MANIFEST.authorityModes[LIVE_RECEIPT_AUTHORITY_NATURAL].phase,
    "4"
  );
  assert.match(
    schema.description,
    /cannot authenticate historical origin.*protected signature or external immutable anchor/i
  );
});

test("strict live receipt replay shares binary Unicode inventory ordering with the installer", () => {
  const fixture = initLiveReceiptFixture("live-inventory-unicode-order");
  const unicodeDirectory = path.join(fixture.root, "plugins/grok/unicode-order");
  fs.mkdirSync(unicodeDirectory);
  const names = ["zeta.txt", "äther.txt", "Ωmega.txt", "😀.txt"];
  for (const name of [...names].reverse()) {
    fs.writeFileSync(path.join(unicodeDirectory, name), `${name}\n`);
  }
  git(fixture.root, "add", ".");
  git(fixture.root, "commit", "-m", "add unicode inventory fixture");

  const pluginRoot = path.join(fixture.root, "plugins/grok");
  const sharedInventory = createPluginInventory(pluginRoot);
  const expectedOrder = [...names].sort(
    (left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  );
  assert.deepEqual(
    sharedInventory
      .map((entry) => entry.path)
      .filter((relative) => relative.startsWith("unicode-order/"))
      .map((relative) => path.posix.basename(relative)),
    expectedOrder
  );

  const receipt = structuralLiveReceipt(fixture, LIVE_RECEIPT_AUTHORITY_SYNTHETIC);
  assert.equal(
    receipt.sourcePluginInventoryDigest,
    digestInventory([...sharedInventory].reverse())
  );

  const localeCompareDescriptor = Object.getOwnPropertyDescriptor(
    String.prototype,
    "localeCompare"
  );
  const originalLocaleCompare = localeCompareDescriptor.value;
  const targetNames = new Set(names);
  Object.defineProperty(String.prototype, "localeCompare", {
    ...localeCompareDescriptor,
    value(other, ...args) {
      const left = String(this);
      const right = String(other);
      if (targetNames.has(left) && targetNames.has(right)) {
        return Buffer.compare(Buffer.from(right, "utf8"), Buffer.from(left, "utf8"));
      }
      return Reflect.apply(originalLocaleCompare, left, [other, ...args]);
    }
  });
  try {
    assert.deepEqual(
      [...names].sort((left, right) => left.localeCompare(right)),
      [...expectedOrder].reverse()
    );
    assert.equal(
      validateLiveQualificationReceipt(
        receipt,
        { strict: true, root: fixture.root }
      ).ok,
      true
    );
  } finally {
    Object.defineProperty(String.prototype, "localeCompare", localeCompareDescriptor);
  }
});

test("manually seeded structural receipts replay offline while generic publication rejects linkage", () => {
  const fixture = initLiveReceiptFixture("live-linkage-positive");
  const synthetic = structuralLiveReceipt(fixture, LIVE_RECEIPT_AUTHORITY_SYNTHETIC);
  const syntheticReference = seedStructuralLiveReceipt(fixture.root, synthetic);
  const phaseOne = liveQualificationRecord({
    fixture,
    phase: "1",
    syntheticReceipt: synthetic,
    syntheticReference
  });
  assert.equal(validateEvidenceRecord(phaseOne).ok, false);
  assert.ok(validateEvidenceRecord(phaseOne).errors.some((message) => (
    /strict offline receipt replay/i.test(message)
  )));
  assert.equal(
    validateEvidenceRecord(phaseOne, { strict: true, root: fixture.root }).ok,
    true
  );
  assert.throws(
    () => writeEvidenceRecord(phaseOne, fixture.root),
    /invalid/i,
    "generic publication cannot publish provider pass or receipt linkage"
  );
  assert.equal(fs.existsSync(path.join(
    fixture.root,
    "tests/e2e-results/worker-broker/phase-1"
  )), false);

  const natural = structuralLiveReceipt(fixture, LIVE_RECEIPT_AUTHORITY_NATURAL);
  const naturalReference = seedStructuralLiveReceipt(fixture.root, natural);
  const phaseFour = liveQualificationRecord({
    fixture,
    phase: "4",
    syntheticReceipt: synthetic,
    syntheticReference,
    naturalReceipt: natural,
    naturalReference
  });
  assert.equal(
    validateEvidenceRecord(phaseFour, { strict: true, root: fixture.root }).ok,
    true
  );
  assert.throws(
    () => writeEvidenceRecord(phaseFour, fixture.root),
    /invalid/i,
    "generic publication cannot publish installed-host pass or receipt linkage"
  );
  assert.equal(fs.existsSync(path.join(
    fixture.root,
    "tests/e2e-results/worker-broker/phase-4"
  )), false);
});

test("natural host receipts require bounded Codex identity and correlate through stable provider capability", () => {
  const fixture = initLiveReceiptFixture("natural-host-identity");
  const missingIdentity = structuralLiveReceipt(
    fixture,
    LIVE_RECEIPT_AUTHORITY_NATURAL,
    {
      codexBinaryDigest: null,
      codexVersion: null,
      codexModel: null,
      hostTaskDigest: null
    }
  );
  assert.equal(validateLiveQualificationReceipt(missingIdentity).ok, false);

  const synthetic = structuralLiveReceipt(fixture, LIVE_RECEIPT_AUTHORITY_SYNTHETIC);
  const syntheticReference = seedStructuralLiveReceipt(fixture.root, synthetic);
  const natural = structuralLiveReceipt(fixture, LIVE_RECEIPT_AUTHORITY_NATURAL, {
    providerCapabilityDigest: "c".repeat(64)
  });
  const naturalReference = seedStructuralLiveReceipt(fixture.root, natural);
  const confused = liveQualificationRecord({
    fixture,
    phase: "4",
    syntheticReceipt: synthetic,
    syntheticReference,
    naturalReceipt: natural,
    naturalReference
  });
  const result = validateEvidenceRecord(confused, { strict: true, root: fixture.root });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((message) => /same source, install, capability, and provider/i.test(message)));

  const leaked = structuredClone(natural);
  delete leaked.receiptDigest;
  leaked.hostThreadId = "RAW_HOST_THREAD_CANARY";
  const leakedResult = validateLiveQualificationReceipt(
    attachStructuralLiveReceiptDigest(leaked)
  );
  assert.equal(leakedResult.ok, false);
  assert.equal(JSON.stringify(leakedResult).includes("hostThreadId"), false);
  assert.equal(JSON.stringify(leakedResult).includes("RAW_HOST_THREAD_CANARY"), false);
});

test("live receipt validation rejects digest, method, authority, scenario, cleanup, count, drift, and raw-field forgeries", () => {
  const fixture = initLiveReceiptFixture("live-receipt-adversarial");
  const base = structuralLiveReceipt(fixture, LIVE_RECEIPT_AUTHORITY_SYNTHETIC);
  const forgedCases = [
    ["install-digest-mismatch", (receipt) => {
      receipt.installedPluginInventoryDigest = "f".repeat(64);
    }],
    ["arbitrary-install-method", (receipt) => {
      receipt.installationMethod = "caller-copy";
    }],
    ["tool-inventory-substitution", (receipt) => {
      receipt.observedToolIds = receipt.observedToolIds.slice(0, -1);
    }],
    ["provider-capability-substitution", (receipt) => {
      receipt.observedProviderCapabilities = receipt.observedProviderCapabilities.slice(0, -1);
    }],
    ["provider-capability-order", (receipt) => {
      receipt.observedProviderCapabilities.reverse();
    }],
    ["provider-revision-substitution", (receipt) => {
      receipt.providerRevision = `binary-sha256-${"f".repeat(64)}`;
    }],
    ["authority-confusion", (receipt) => {
      receipt.authorityMode = LIVE_RECEIPT_AUTHORITY_NATURAL;
    }],
    ["scenario-substitution", (receipt) => {
      receipt.scenarios[0].id = "natural-codex-installed-host";
    }],
    ["scenario-order", (receipt) => {
      receipt.scenarios.reverse();
    }],
    ["cleanup-false", (receipt) => {
      receipt.scenarios[1].taskRuntimeCleaned = false;
    }],
    ["worker-host-overclaim", (receipt) => {
      receipt.scenarios[0].workerHostVerification = "pass";
    }],
    ["duplicate-launch", (receipt) => {
      receipt.scenarios[1].duplicateLaunchCount = 1;
    }],
    ["launch-count", (receipt) => {
      receipt.scenarios[0].providerLaunchCount = 2;
    }],
    ["mailbox-prompt-count", (receipt) => {
      receipt.scenarios[0].mailbox.promptCount = 4;
    }],
    ["mailbox-send-replay-count", (receipt) => {
      receipt.scenarios[0].mailbox.sendReplayCount = 0;
    }],
    ["mailbox-delivered-count", (receipt) => {
      receipt.scenarios[0].mailbox.deliveredCount = 1;
    }],
    ["mailbox-delivery-unknown", (receipt) => {
      receipt.scenarios[0].mailbox.deliveryUnknownCount = 1;
    }],
    ["mailbox-final-report", (receipt) => {
      receipt.scenarios[0].mailbox.finalReportSequence = 1;
    }],
    ["mailbox-replay-prompt-delta", (receipt) => {
      receipt.scenarios[0].mailbox.replayPromptDelta = 1;
    }],
    ["mailbox-retained-body", (receipt) => {
      receipt.scenarios[0].mailbox.retainedBodyCount = 1;
    }],
    ["mailbox-not-closed", (receipt) => {
      receipt.scenarios[0].mailbox.closed = false;
    }],
    ["mailbox-private-field", (receipt) => {
      receipt.scenarios[0].mailbox.contentDigest = "PRIVATE_MAILBOX_CANARY";
    }],
    ["mailbox-on-cancellation", (receipt) => {
      receipt.scenarios[1].mailbox = structuredClone(receipt.scenarios[0].mailbox);
    }],
    ["spawn-replay-count", (receipt) => {
      receipt.scenarios[1].spawnReplayCount = 0;
    }],
    ["cancel-invocation-count", (receipt) => {
      receipt.scenarios[1].cancelInvocationCount = 1;
    }],
    ["cancel-replay-count", (receipt) => {
      receipt.scenarios[1].cancelReplayCount = 0;
    }],
    ["unique-cancel-request-count", (receipt) => {
      receipt.scenarios[1].uniqueCancelRequestCount = 2;
    }],
    ["runner-temporary-artifacts", (receipt) => {
      receipt.scenarios[1].runnerTemporaryArtifactsRemoved = false;
    }],
    ["qualification-session-delete", (receipt) => {
      receipt.scenarios[1].qualificationSessionDeleted = false;
    }],
    ["manifest-drift", (receipt) => {
      receipt.manifestDigest = "e".repeat(64);
    }],
    ["source-drift", (receipt) => {
      receipt.sourceInventoryDigest = "d".repeat(64);
      receipt.repositoryBeforeDigest = receipt.sourceInventoryDigest;
      receipt.repositoryAfterDigest = receipt.sourceInventoryDigest;
    }],
    ["raw-private-field", (receipt) => {
      receipt.rawTranscript = "PRIVATE_LIVE_TRANSCRIPT_CANARY";
    }]
  ];
  for (const [label, mutate] of forgedCases) {
    const candidate = structuredClone(base);
    delete candidate.receiptDigest;
    mutate(candidate);
    const forged = attachStructuralLiveReceiptDigest(candidate);
    const result = validateLiveQualificationReceipt(
      forged,
      { strict: label === "source-drift", root: fixture.root }
    );
    assert.equal(result.ok, false, label);
    if (label === "raw-private-field") {
      assert.equal(JSON.stringify(result).includes("rawTranscript"), false);
      assert.equal(JSON.stringify(result).includes("PRIVATE_LIVE_TRANSCRIPT_CANARY"), false);
    }
  }
});

test("caller-authored live claims have no supported publication path", async () => {
  const fixture = initLiveReceiptFixture("live-no-write");
  const callerAuthored = structuralLiveReceipt(
    fixture,
    LIVE_RECEIPT_AUTHORITY_SYNTHETIC
  );
  const liveRoot = path.join(fixture.root, ...LIVE_RECEIPT_ROOT.split("/"));
  assert.equal(fs.existsSync(liveRoot), false);
  assert.equal(validateLiveQualificationReceipt(callerAuthored).ok, true);
  const evidenceModule = await import(EVIDENCE_MODULE_URL);
  assert.equal(Object.hasOwn(evidenceModule, "publishLiveQualificationReceipt"), false);
  assert.equal(Object.hasOwn(evidenceModule, "writeLiveQualifiedEvidenceRecord"), false);
  assert.equal(fs.existsSync(liveRoot), false);

  const forgedProvider = buildEvidenceRecord({
    root: fixture.root,
    phase: "1",
    slice: "forged-provider-pass",
    verification: [passedCommand("provider-live", "caller-authored", "provider-live")],
    liveScenarios: LIVE_RECEIPT_SCENARIO_IDS[LIVE_RECEIPT_AUTHORITY_SYNTHETIC].map((id) => ({
      id,
      boundary: "provider-live",
      outcome: "pass"
    })),
    qualification: {
      deterministic: "not_run",
      installedHost: "not_run",
      provider: "pass",
      release: "not_run"
    },
    runtime: {
      platform: "test",
      architecture: "test",
      node: process.versions.node,
      git: "test",
      codexStandalone: null,
      codexDesktopBundled: null,
      grokBuild: "0.2.106",
      grokBuildRevision: "revision-1",
      mcpProtocolVersion: "2025-11-25"
    }
  });
  const forgedValidation = validateEvidenceRecord(forgedProvider);
  assert.equal(forgedValidation.ok, false);
  assert.ok(forgedValidation.errors.some((message) => /strict offline receipt replay/i.test(message)));
  const strictForgedValidation = validateEvidenceRecord(
    forgedProvider,
    { strict: true, root: fixture.root }
  );
  assert.equal(strictForgedValidation.ok, false);
  assert.ok(strictForgedValidation.errors.some((message) => /synthetic-direct-mcp receipt/i.test(message)));
  assert.throws(
    () => writeEvidenceRecord(forgedProvider, fixture.root),
    (error) => error?.code === "E_EVIDENCE_RECORD_INVALID"
  );
  assert.equal(fs.existsSync(path.join(
    fixture.root,
    "tests/e2e-results/worker-broker/phase-1"
  )), false);
});

test("live evidence runtime and JSON Schema enforce bidirectional provisional semantics", () => {
  const fixture = initLiveReceiptFixture("live-schema-parity");
  const synthetic = structuralLiveReceipt(fixture, LIVE_RECEIPT_AUTHORITY_SYNTHETIC);
  const syntheticReference = seedStructuralLiveReceipt(fixture.root, synthetic);
  const phaseOne = liveQualificationRecord({
    fixture,
    phase: "1",
    syntheticReceipt: synthetic,
    syntheticReference
  });

  const semanticForgeries = [
    ["status", /remain implemented_unverified/i, (record) => {
      record.status = "qualified";
    }],
    ["provisional", /provisionalSupportingRecord=true/i, (record) => {
      record.provisionalSupportingRecord = false;
    }],
    ["release-boolean", /cannot claim release qualification/i, (record) => {
      record.releaseQualification = true;
    }],
    ["release-result", /cannot claim release qualification/i, (record) => {
      record.qualification.release = "pass";
    }],
    ["host-verification", /hostVerification=not_run/i, (record) => {
      record.authorities.hostVerification = "pass";
    }]
  ];
  for (const [label, expected, mutate] of semanticForgeries) {
    const candidate = structuredClone(phaseOne);
    delete candidate.recordDigest;
    mutate(candidate);
    const result = validateEvidenceRecord(attachRecordDigest(candidate));
    assert.equal(result.ok, false, label);
    assert.ok(result.errors.some((message) => expected.test(message)), label);
  }

  {
    const candidate = structuredClone(phaseOne);
    delete candidate.recordDigest;
    candidate.qualification.provider = "not_run";
    const result = validateEvidenceRecord(attachRecordDigest(candidate));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => (
      /synthetic live receipt linkage is forbidden without provider qualification pass/i.test(message)
    )));
  }

  const natural = structuralLiveReceipt(fixture, LIVE_RECEIPT_AUTHORITY_NATURAL);
  const naturalReference = seedStructuralLiveReceipt(fixture.root, natural);
  const phaseFour = liveQualificationRecord({
    fixture,
    phase: "4",
    syntheticReceipt: synthetic,
    syntheticReference,
    naturalReceipt: natural,
    naturalReference
  });
  {
    const candidate = structuredClone(phaseFour);
    delete candidate.recordDigest;
    candidate.qualification.installedHost = "not_run";
    const result = validateEvidenceRecord(attachRecordDigest(candidate));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => (
      /natural live receipt linkage is forbidden without installedHost qualification pass/i.test(message)
    )));
  }
  {
    const candidate = structuredClone(phaseOne);
    delete candidate.recordDigest;
    candidate.phase = "2";
    const result = validateEvidenceRecord(attachRecordDigest(candidate));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => (
      /provider live qualification may link only to Phase 1, Phase 4, or aggregate evidence/i.test(message)
    )));
  }

  const evidenceSchema = JSON.parse(fs.readFileSync(
    path.join(ROOT, "plugins/grok/schemas/worker-broker-evidence.schema.json"),
    "utf8"
  ));
  const rules = evidenceSchema.allOf || [];
  const providerPassRule = rules.find((rule) => (
    rule?.if?.properties?.qualification?.properties?.provider?.const === "pass"
  ));
  const providerNonPassRule = rules.find((rule) => (
    rule?.if?.properties?.qualification?.properties?.provider?.enum?.includes("not_run")
  ));
  const installedPassRule = rules.find((rule) => (
    rule?.if?.properties?.qualification?.properties?.installedHost?.const === "pass"
  ));
  const installedNonPassRule = rules.find((rule) => (
    rule?.if?.properties?.qualification?.properties?.installedHost?.enum?.includes("not_run")
  ));
  const syntheticConverse = rules.find((rule) => (
    rule?.if?.properties?.liveQualificationReceipts
      ?.properties?.syntheticDirectMcp?.type === "object"
  ));
  const naturalConverse = rules.find((rule) => (
    rule?.if?.properties?.liveQualificationReceipts
      ?.properties?.naturalCodexHost?.type === "object"
  ));
  const liveSemantics = rules.find((rule) => (
    Array.isArray(rule?.if?.anyOf)
    && rule?.then?.properties?.provisionalSupportingRecord?.const === true
  ));
  const aggregateLiveSemantics = rules.find((rule) => (
    rule?.if?.properties?.status?.const === "qualified"
    && rule?.then?.properties?.phase?.const === "aggregate"
  ));
  assert.deepEqual(providerPassRule.then.properties.phase.enum, ["1", "4", "aggregate"]);
  assert.equal(
    providerPassRule.then.properties.liveQualificationReceipts
      .properties.syntheticDirectMcp.type,
    "object"
  );
  assert.equal(
    providerNonPassRule.then.properties.liveQualificationReceipts
      .properties.syntheticDirectMcp.type,
    "null"
  );
  assert.deepEqual(installedPassRule.then.properties.phase.enum, ["4", "aggregate"]);
  assert.equal(
    installedPassRule.then.properties.qualification.properties.provider.const,
    "pass"
  );
  assert.equal(
    installedNonPassRule.then.properties.liveQualificationReceipts
      .properties.naturalCodexHost.type,
    "null"
  );
  assert.equal(
    syntheticConverse.then.properties.qualification.properties.provider.const,
    "pass"
  );
  assert.deepEqual(naturalConverse.then.properties.phase.enum, ["4", "aggregate"]);
  assert.equal(
    naturalConverse.then.properties.qualification.properties.installedHost.const,
    "pass"
  );
  assert.equal(liveSemantics.then.properties.status.const, "implemented_unverified");
  assert.equal(liveSemantics.then.properties.releaseQualification.const, false);
  assert.deepEqual(
    liveSemantics.then.properties.qualification.properties.release.enum,
    ["fail", "skip", "not_run"]
  );
  assert.equal(
    liveSemantics.then.properties.authorities.properties.hostVerification.const,
    "not_run"
  );
  assert.equal(aggregateLiveSemantics.then.properties.releaseQualification.const, true);
  assert.equal(
    aggregateLiveSemantics.then.properties.qualification.properties.release.const,
    "pass"
  );

  const receiptSchema = JSON.parse(fs.readFileSync(
    path.join(ROOT, "plugins/grok/schemas/worker-broker-live-receipt.schema.json"),
    "utf8"
  ));
  assert.equal(receiptSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(
    receiptSchema.properties.schemaVersion.const,
    LIVE_RECEIPT_SCHEMA_VERSION
  );
  assert.equal(receiptSchema.properties.producerId.const, LIVE_RECEIPT_PRODUCER_ID);
  assert.equal(receiptSchema.properties.producerVersion.const, LIVE_RECEIPT_PRODUCER_VERSION);
  assert.equal(receiptSchema.properties.manifestDigest.const, computeLiveReceiptManifestDigest());
  assert.equal(
    receiptSchema.properties.mcpProtocolVersion.const,
    LIVE_RECEIPT_MANIFEST.mcpProtocolVersion
  );
  assert.equal(
    receiptSchema.properties.providerRevision.pattern,
    "^binary-sha256-[0-9a-f]{64}$"
  );
  assert.match(
    receiptSchema.properties.scenarios.items.properties.providerTerminalCount.description,
    /unique launched provider generations.*captured process group.*observed gone/i
  );
  assert.match(
    receiptSchema.description,
    /private installed state.*rather than public provider-start or session-created events/i
  );
  assert.ok(Object.keys(synthetic).every((field) => receiptSchema.required.includes(field)));
  const syntheticRule = receiptSchema.allOf.find((rule) => (
    rule?.if?.properties?.authorityMode?.const === LIVE_RECEIPT_AUTHORITY_SYNTHETIC
  ));
  const naturalRule = receiptSchema.allOf.find((rule) => (
    rule?.if?.properties?.authorityMode?.const === LIVE_RECEIPT_AUTHORITY_NATURAL
  ));
  assert.equal(syntheticRule.then.properties.phase.const, "1");
  assert.deepEqual(
    syntheticRule.then.properties.installationMethod.enum,
    LIVE_RECEIPT_AUTHORITY_CONFIG[LIVE_RECEIPT_AUTHORITY_SYNTHETIC].installationMethods
  );
  assert.deepEqual(
    syntheticRule.then.properties.observedToolIds.const,
    LIVE_RECEIPT_CAPABILITY_TOOL_IDS
  );
  assert.deepEqual(
    syntheticRule.then.properties.scenarios.const,
    LIVE_RECEIPT_AUTHORITY_CONFIG[LIVE_RECEIPT_AUTHORITY_SYNTHETIC].scenarios
  );
  assert.equal(naturalRule.then.properties.phase.const, "4");
  assert.equal(naturalRule.then.properties.installationMethod.const, "codex-local-plugin-cache");
  assert.deepEqual(
    naturalRule.then.properties.observedToolIds.const,
    LIVE_RECEIPT_NATURAL_TOOL_IDS
  );
  assert.deepEqual(
    naturalRule.then.properties.scenarios.const,
    LIVE_RECEIPT_AUTHORITY_CONFIG[LIVE_RECEIPT_AUTHORITY_NATURAL].scenarios
  );
});

test("strict replay accepts a complete qualified aggregate without exposing a generic producer", () => {
  const fixture = initLiveReceiptFixture("qualified-aggregate-structure");
  const synthetic = structuralLiveReceipt(fixture, LIVE_RECEIPT_AUTHORITY_SYNTHETIC);
  const syntheticReference = seedStructuralLiveReceipt(fixture.root, synthetic);
  const natural = structuralLiveReceipt(fixture, LIVE_RECEIPT_AUTHORITY_NATURAL);
  const naturalReference = seedStructuralLiveReceipt(fixture.root, natural);
  const phaseFour = liveQualificationRecord({
    fixture,
    phase: "4",
    syntheticReceipt: synthetic,
    syntheticReference,
    naturalReceipt: natural,
    naturalReference
  });
  const prerequisites = ["0", "1", "2", "3", "4", "5"].map((phase) => ({
    phase,
    recordDigest: sha256Text(`qualified-aggregate-prerequisite-${phase}`),
    gateIds: [...PHASE_MANDATORY_GATE_IDS[phase]]
  }));
  const aggregate = attachRecordDigest({
    ...phaseFour,
    recordType: "worker-broker-aggregate",
    phase: "aggregate",
    slice: "release-qualification",
    status: "qualified",
    releaseQualification: true,
    evidenceSystemQualification: true,
    provisionalSupportingRecord: false,
    proofProducer: proofProducer("aggregate"),
    qualification: {
      deterministic: "pass",
      installedHost: "pass",
      provider: "pass",
      release: "pass"
    },
    source: {
      ...phaseFour.source,
      phaseScopeDigest: computePhaseScopeDigest("aggregate", fixture.root),
      phaseScopePaths: phaseScopePaths("aggregate", fixture.root)
    },
    prerequisites,
    verification: exactPhaseProof("aggregate"),
    scenarios: [{
      id: "aggregate-release-chain",
      boundary: "release",
      expected: "all current phase and live authority records are bound",
      actual: "bounded aggregate inputs passed",
      outcome: "pass"
    }],
    ci: {
      workflowUrl: "https://github.com/xliberty2008x/grok-plugin/actions/runs/1",
      runId: "1",
      attempt: 1,
      jobs: [{ name: "required", result: "success" }]
    },
    authorities: {
      ...phaseFour.authorities,
      hostVerification: "pass",
      independentValidation: "pass"
    }
  });
  const strict = validateEvidenceRecord(aggregate, {
    strict: true,
    root: fixture.root
  });
  assert.equal(strict.ok, true, strict.errors.join("; "));
  assert.throws(
    () => writeEvidenceRecord(aggregate, fixture.root),
    (error) => error?.code === "E_EVIDENCE_RECORD_INVALID"
  );
  assert.throws(
    () => updateLedger({
      phase: aggregate.phase,
      slice: aggregate.slice,
      status: aggregate.status,
      path: rawEvidenceFixturePath(fixture.root, aggregate),
      recordDigest: aggregate.recordDigest,
      sourceCommit: aggregate.source.headCommit,
      recordedAt: aggregate.recordedAt
    }, fixture.root),
    (error) => error?.code === "E_EVIDENCE_LEDGER_UPDATE_INVALID"
  );
});

test("strict offline live receipt replay rejects symlinks, directory replacement, depth, and directory budgets", async (t) => {
  await t.test("static symlink", (t) => {
    const fixture = initLiveReceiptFixture("live-inventory-static-symlink");
    const receipt = structuralLiveReceipt(fixture, LIVE_RECEIPT_AUTHORITY_SYNTHETIC);
    const outside = tempDir("live-inventory-outside-");
    fs.writeFileSync(path.join(outside, "outside.txt"), "outside\n");
    const link = path.join(fixture.root, "plugins/grok/static-link");
    t.after(() => {
      fs.rmSync(link, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    });
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    const result = validateLiveQualificationReceipt(
      receipt,
      { strict: true, root: fixture.root }
    );
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => /source identity could not be verified/i.test(message)));
  });

  await t.test("nested directory replacement", () => {
    const fixture = initLiveReceiptFixture("live-inventory-directory-replacement");
    const target = path.join(fixture.root, "plugins/grok/snapshot-target");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "entry.txt"), "stable bytes\n");
    git(fixture.root, "add", ".");
    git(fixture.root, "commit", "-m", "add directory snapshot target");
    const receipt = structuralLiveReceipt(fixture, LIVE_RECEIPT_AUTHORITY_SYNTHETIC);
    const backup = `${target}-original`;
    const originalOpendirSync = fs.opendirSync;
    let swapped = false;
    fs.opendirSync = function patchedOpendirSync(directory, ...args) {
      const handle = originalOpendirSync.call(fs, directory, ...args);
      if (path.resolve(String(directory)) !== target) return handle;
      return {
        readSync: handle.readSync.bind(handle),
        closeSync() {
          handle.closeSync();
          if (!swapped) {
            swapped = true;
            fs.renameSync(target, backup);
            fs.mkdirSync(target);
            fs.writeFileSync(path.join(target, "entry.txt"), "stable bytes\n");
          }
        }
      };
    };
    let validation;
    try {
      validation = validateLiveQualificationReceipt(
        receipt,
        { strict: true, root: fixture.root }
      );
    } finally {
      fs.opendirSync = originalOpendirSync;
      if (swapped) {
        fs.rmSync(target, { recursive: true, force: true });
        fs.renameSync(backup, target);
      }
    }
    assert.equal(swapped, true);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((message) => /source identity could not be verified/i.test(message)));
  });

  await t.test("nested symlink replacement", () => {
    const fixture = initLiveReceiptFixture("live-inventory-symlink-replacement");
    const target = path.join(fixture.root, "plugins/grok/symlink-swap-target");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "entry.txt"), "stable bytes\n");
    git(fixture.root, "add", ".");
    git(fixture.root, "commit", "-m", "add symlink swap target");
    const receipt = structuralLiveReceipt(fixture, LIVE_RECEIPT_AUTHORITY_SYNTHETIC);
    const backup = `${target}-original`;
    const originalOpendirSync = fs.opendirSync;
    let swapped = false;
    fs.opendirSync = function patchedOpendirSync(directory, ...args) {
      const handle = originalOpendirSync.call(fs, directory, ...args);
      if (path.resolve(String(directory)) !== target) return handle;
      return {
        readSync: handle.readSync.bind(handle),
        closeSync() {
          handle.closeSync();
          if (!swapped) {
            swapped = true;
            fs.renameSync(target, backup);
            fs.symlinkSync(
              backup,
              target,
              process.platform === "win32" ? "junction" : "dir"
            );
          }
        }
      };
    };
    let validation;
    try {
      validation = validateLiveQualificationReceipt(
        receipt,
        { strict: true, root: fixture.root }
      );
    } finally {
      fs.opendirSync = originalOpendirSync;
      if (swapped) {
        fs.rmSync(target, { recursive: true, force: true });
        fs.renameSync(backup, target);
      }
    }
    assert.equal(swapped, true);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((message) => /source identity could not be verified/i.test(message)));
  });

  await t.test("depth budget", (t) => {
    const fixture = initLiveReceiptFixture("live-inventory-depth-budget");
    const receipt = structuralLiveReceipt(fixture, LIVE_RECEIPT_AUTHORITY_SYNTHETIC);
    const deepRoot = path.join(fixture.root, "plugins/grok/deep");
    t.after(() => fs.rmSync(deepRoot, { recursive: true, force: true }));
    let directory = deepRoot;
    for (let index = 0; index < 33; index += 1) {
      fs.mkdirSync(directory);
      directory = path.join(directory, "d");
    }
    fs.writeFileSync(path.join(path.dirname(directory), "leaf.txt"), "too deep\n");
    const result = validateLiveQualificationReceipt(
      receipt,
      { strict: true, root: fixture.root }
    );
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => /source identity could not be verified/i.test(message)));
  });

  await t.test("directory budget", (t) => {
    const fixture = initLiveReceiptFixture("live-inventory-directory-budget");
    const receipt = structuralLiveReceipt(fixture, LIVE_RECEIPT_AUTHORITY_SYNTHETIC);
    const parent = path.join(fixture.root, "plugins/grok/many-directories");
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    fs.mkdirSync(parent);
    for (let index = 0; index < 512; index += 1) {
      fs.mkdirSync(path.join(parent, `d-${String(index).padStart(3, "0")}`));
    }
    const result = validateLiveQualificationReceipt(
      receipt,
      { strict: true, root: fixture.root }
    );
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => /source identity could not be verified/i.test(message)));
  });

  await t.test("directory entry fan-out budget", (t) => {
    const fixture = initLiveReceiptFixture("live-inventory-fanout-budget");
    const receipt = structuralLiveReceipt(fixture, LIVE_RECEIPT_AUTHORITY_SYNTHETIC);
    const parent = path.join(fixture.root, "plugins/grok/fanout");
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    fs.mkdirSync(parent);
    const sentinelPath = path.join(parent, "d-sentinel");
    fs.mkdirSync(sentinelPath);
    const sentinel = fs.readdirSync(
      parent,
      { withFileTypes: true }
    ).find((entry) => entry.name === path.basename(sentinelPath));
    assert.ok(sentinel?.isDirectory());
    const originalOpendirSync = fs.opendirSync;
    let targetReadCount = 0;
    fs.opendirSync = function countedOpendirSync(directory, ...args) {
      const handle = originalOpendirSync.call(fs, directory, ...args);
      if (path.resolve(String(directory)) !== parent) return handle;
      let index = 0;
      return {
        readSync() {
          targetReadCount += 1;
          if (index >= 4097) return null;
          index += 1;
          return sentinel;
        },
        closeSync: handle.closeSync.bind(handle)
      };
    };
    let result;
    try {
      result = validateLiveQualificationReceipt(
        receipt,
        { strict: true, root: fixture.root }
      );
    } finally {
      fs.opendirSync = originalOpendirSync;
    }
    assert.equal(result.ok, false);
    assert.equal(targetReadCount, 4097);
    assert.ok(result.errors.some((message) => /source identity could not be verified/i.test(message)));
  });
});
