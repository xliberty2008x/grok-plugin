import test from "node:test";
import {
  ENDED_AT,
  LIVE_RECEIPT_AUTHORITY_SYNTHETIC,
  ROOT,
  STARTED_AT,
  assert,
  attachRecordDigest,
  buildEvidenceRecord,
  computeRecordDigest,
  fs,
  git,
  initLiveReceiptFixture,
  initPhaseZeroEvidenceFixture,
  initRepo,
  ledgerAppenderNeedsRetry,
  liveQualificationRecord,
  loadLedger,
  passedCommand,
  path,
  rawEvidenceFixturePath,
  run,
  seedStructuralLiveReceipt,
  sha256Text,
  spawnLedgerAppender,
  structuralLiveReceipt,
  syntheticLedgerEntry,
  tempDir,
  updateLedger,
  validateEvidenceRecord,
  verifyLedger,
  waitFor,
  writeEvidenceRecord,
  writePhaseZeroLedgerRecord
} from "./worker-broker-evidence-test-support.mjs";

test("provisional live supporting records cannot become current ledger evidence", () => {
  const fixture = initLiveReceiptFixture("live-provisional-ledger");
  const synthetic = structuralLiveReceipt(fixture, LIVE_RECEIPT_AUTHORITY_SYNTHETIC);
  const syntheticReference = seedStructuralLiveReceipt(fixture.root, synthetic);
  const record = liveQualificationRecord({
    fixture,
    phase: "1",
    syntheticReceipt: synthetic,
    syntheticReference
  });
  const recordPath = rawEvidenceFixturePath(fixture.root, record);
  const entry = {
    phase: record.phase,
    slice: record.slice,
    status: record.status,
    path: recordPath,
    recordDigest: record.recordDigest,
    sourceCommit: record.source.headCommit,
    currency: "current",
    recordedAt: record.recordedAt
  };
  assert.throws(
    () => updateLedger(entry, fixture.root),
    (error) => error?.code === "E_EVIDENCE_LEDGER_UPDATE_INVALID"
  );

  const historical = updateLedger({ ...entry, currency: "historical" }, fixture.root);
  assert.equal(historical.entries.at(-1).currency, "historical");
  const ledgerPath = path.join(
    fixture.root,
    "tests/e2e-results/worker-broker/ledger.json"
  );
  fs.writeFileSync(ledgerPath, `${JSON.stringify({
    schemaVersion: 1,
    roadmapVersion: "1.0",
    issue: "https://github.com/xliberty2008x/grok-plugin/issues/25",
    updatedAt: STARTED_AT,
    entries: [entry]
  }, null, 2)}\n`, { mode: 0o600 });
  const result = verifyLedger(fixture.root, { strict: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((message) => (
    /provisional\/live supporting records cannot be current evidence/i.test(message)
  )));
});

test("ledger admission distinguishes absent records from existing malformed or mismatched live bytes", () => {
  const fixture = initLiveReceiptFixture("live-ledger-existing-bytes");
  const baseline = syntheticLedgerEntry("0", "missing-prepublication-reservation");
  updateLedger(baseline, fixture.root);
  const ledgerPath = path.join(
    fixture.root,
    "tests/e2e-results/worker-broker/ledger.json"
  );
  const ledgerBefore = fs.readFileSync(ledgerPath, "utf8");

  const synthetic = structuralLiveReceipt(fixture, LIVE_RECEIPT_AUTHORITY_SYNTHETIC);
  const syntheticReference = seedStructuralLiveReceipt(fixture.root, synthetic);
  const record = liveQualificationRecord({
    fixture,
    phase: "1",
    syntheticReceipt: synthetic,
    syntheticReference
  });
  const recordPath = rawEvidenceFixturePath(fixture.root, record);
  const entry = {
    phase: record.phase,
    slice: record.slice,
    status: record.status,
    path: recordPath,
    recordDigest: record.recordDigest,
    sourceCommit: record.source.headCommit,
    currency: "current",
    recordedAt: record.recordedAt
  };
  const mismatches = [
    ["status", { status: "blocked" }],
    ["recordDigest", { recordDigest: "f".repeat(64) }],
    ["sourceCommit", { sourceCommit: "2".repeat(40) }],
    ["recordedAt", { recordedAt: ENDED_AT }]
  ];
  for (const [label, mismatch] of mismatches) {
    assert.throws(
      () => updateLedger({ ...entry, ...mismatch }, fixture.root),
      (error) => error?.code === "E_EVIDENCE_LEDGER_INVALID",
      label
    );
    assert.equal(fs.readFileSync(ledgerPath, "utf8"), ledgerBefore, label);
  }

  fs.writeFileSync(path.join(fixture.root, recordPath), "{malformed-json\n");
  assert.throws(
    () => updateLedger(entry, fixture.root),
    (error) => error?.code === "E_EVIDENCE_LEDGER_INVALID"
  );
  assert.equal(fs.readFileSync(ledgerPath, "utf8"), ledgerBefore);
});

test("installedHost boolean cannot mask digest mismatch and legacy not-run records stay deterministic", () => {
  const fixture = initLiveReceiptFixture("live-digest-and-legacy");
  const mismatched = buildEvidenceRecord({
    root: fixture.root,
    phase: "4",
    slice: "forged-installed-host",
    verification: [
      passedCommand("provider-live", "caller-provider", "provider-live"),
      passedCommand("installed-host", "caller-host", "installed-host")
    ],
    qualification: {
      deterministic: "not_run",
      installedHost: "pass",
      provider: "pass",
      release: "not_run"
    },
    installation: {
      method: "codex-local-plugin-cache",
      sourcePluginInventoryDigest: "a".repeat(64),
      installedPluginInventoryDigest: "b".repeat(64),
      installedFileCount: 1,
      sourceAndInstalledInventoriesEqual: true,
      privateInstallPathRecorded: false
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
  const mismatchResult = validateEvidenceRecord(mismatched);
  assert.equal(mismatchResult.ok, false);
  assert.ok(mismatchResult.errors.some((message) => /matching source\/install digests/i.test(message)));

  const legacy = buildEvidenceRecord({
    root: fixture.root,
    phase: "1",
    slice: "legacy-not-run-compatible",
    verification: [passedCommand("identity", "true", "source")]
  });
  assert.equal(Object.hasOwn(legacy, "liveQualificationReceipts"), false);
  assert.equal(validateEvidenceRecord(legacy).ok, true);
  assert.equal(computeRecordDigest(legacy), legacy.recordDigest);
  assert.equal(
    computeRecordDigest(structuredClone(legacy)),
    legacy.recordDigest,
    "optional live linkage must not perturb deterministic legacy digests"
  );
  const evidenceSchema = JSON.parse(fs.readFileSync(
    path.join(ROOT, "plugins/grok/schemas/worker-broker-evidence.schema.json"),
    "utf8"
  ));
  assert.equal(evidenceSchema.required.includes("liveQualificationReceipts"), false);
});

test("evidence publication rejects traversal-shaped phase and digest before filesystem access", () => {
  {
    const root = initRepo();
    const escapedName = `${path.basename(root)}-PHASE_ESCAPE_CANARY`;
    const phase = `a/../../../../../${escapedName}`;
    const escapedDirectory = path.join(root, "tests/e2e-results/worker-broker", `phase-${phase}`);
    assert.ok(path.relative(root, escapedDirectory).startsWith(`..${path.sep}`));
    assert.equal(fs.existsSync(escapedDirectory), false);
    assert.throws(() => writeEvidenceRecord({
      phase,
      source: { sourceInventoryDigest: "0".repeat(64) }
    }, root), /invalid or unsafe for publication/i);
    assert.equal(fs.existsSync(path.join(root, "tests")), false);
    assert.equal(fs.existsSync(escapedDirectory), false);
  }

  {
    const root = initRepo();
    const sourceInventoryDigest = "../../../../../x";
    const record = { phase: "0", source: { sourceInventoryDigest }, slice: "digest-traversal" };
    const body = attachRecordDigest(record);
    const escapedFile = path.join(
      root,
      "tests/e2e-results/worker-broker/phase-0",
      `${sourceInventoryDigest.slice(0, 16)}-${body.recordDigest.slice(0, 12)}.json`
    );
    assert.ok(path.relative(root, escapedFile).startsWith(`..${path.sep}`));
    assert.equal(fs.existsSync(escapedFile), false);
    assert.throws(
      () => writeEvidenceRecord(record, root),
      /invalid or unsafe for publication/i
    );
    assert.equal(fs.existsSync(path.join(root, "tests")), false);
    assert.equal(fs.existsSync(escapedFile), false);
  }
});

test("ledger verification rejects a symlinked ledger without disclosing its target", () => {
  const { root, evidenceDir } = initPhaseZeroEvidenceFixture("symlink-ledger-evidence");
  const { record } = writePhaseZeroLedgerRecord(root, "ledger-symlink");
  const ledgerPath = path.join(evidenceDir, "ledger.json");
  const externalDir = tempDir("worker-ledger-external-");
  const externalTarget = path.join(externalDir, "EXTERNAL_LEDGER_TARGET_CANARY.json");
  fs.renameSync(ledgerPath, externalTarget);
  fs.symlinkSync(externalTarget, ledgerPath);
  const targetBefore = fs.readFileSync(externalTarget, "utf8");

  const result = verifyLedger(root, { strict: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((message) => /ledger is unreadable, unsafe, or exceeds/i.test(message)));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(externalTarget), false);
  assert.equal(serialized.includes("EXTERNAL_LEDGER_TARGET_CANARY"), false);
  assert.throws(() => updateLedger({
    phase: record.phase,
    slice: "ledger-symlink-update",
    status: record.status,
    path: "tests/e2e-results/worker-broker/phase-0/unpublished.json",
    recordDigest: record.recordDigest,
    sourceCommit: record.source.headCommit,
    recordedAt: record.recordedAt
  }, root), /malformed, unsafe, or unreadable/i);
  assert.equal(fs.readFileSync(externalTarget, "utf8"), targetBefore);
});

test("ledger update rejects malformed incoming data before creating evidence state", () => {
  const cases = [
    {
      ...syntheticLedgerEntry("0", "private-incoming"),
      rawPrivate: "INCOMING_LEDGER_PRIVATE_CANARY"
    },
    syntheticLedgerEntry("0", "unsafe-path", {
      path: "tests/e2e-results/worker-broker/phase-0/../escape.json"
    }),
    syntheticLedgerEntry("0", "bad-currency", { currency: "latest" }),
    syntheticLedgerEntry("not-a-phase", "bad-phase")
  ];
  for (const [index, entry] of cases.entries()) {
    const root = initRepo();
    let observed;
    try {
      updateLedger(entry, root);
    } catch (error) {
      observed = error;
    }
    assert.equal(observed?.code, "E_EVIDENCE_LEDGER_UPDATE_INVALID", `case ${index}`);
    assert.equal(observed?.message, "Evidence ledger update is invalid or unsafe.");
    assert.equal(observed?.message.includes("INCOMING_LEDGER_PRIVATE_CANARY"), false);
    assert.equal(fs.existsSync(path.join(root, "tests")), false, `case ${index}`);
  }
});

test("ledger update preserves malformed/private loaded bytes and rejects a 129th entry", () => {
  {
    const root = initRepo();
    const evidenceDirectory = path.join(root, "tests/e2e-results/worker-broker");
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    const ledgerFile = path.join(evidenceDirectory, "ledger.json");
    const poisoned = `${JSON.stringify({
      schemaVersion: 1,
      roadmapVersion: "1.0",
      issue: "https://github.com/xliberty2008x/grok-plugin/issues/25",
      updatedAt: STARTED_AT,
      entries: [syntheticLedgerEntry("0", "loaded-private")],
      rawPrivate: "LOADED_LEDGER_PRIVATE_CANARY"
    }, null, 2)}\n`;
    fs.writeFileSync(ledgerFile, poisoned);
    let observed;
    try {
      updateLedger(syntheticLedgerEntry("1", "must-not-append"), root);
    } catch (error) {
      observed = error;
    }
    assert.equal(observed?.code, "E_EVIDENCE_LEDGER_INVALID");
    assert.equal(observed?.message.includes("LOADED_LEDGER_PRIVATE_CANARY"), false);
    assert.equal(fs.readFileSync(ledgerFile, "utf8"), poisoned);
  }

  {
    const root = initRepo();
    const evidenceDirectory = path.join(root, "tests/e2e-results/worker-broker");
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    const ledgerFile = path.join(evidenceDirectory, "ledger.json");
    const entries = Array.from({ length: 128 }, (_, index) => syntheticLedgerEntry(
      String(index % 6),
      `history-${index}`,
      {
        currency: "historical",
        recordDigest: sha256Text(`history-record-${index}`),
        path: `tests/e2e-results/worker-broker/phase-${index % 6}/${sha256Text(`history-path-${index}`)}.json`
      }
    ));
    const full = `${JSON.stringify({
      schemaVersion: 1,
      roadmapVersion: "1.0",
      issue: "https://github.com/xliberty2008x/grok-plugin/issues/25",
      updatedAt: STARTED_AT,
      entries
    }, null, 2)}\n`;
    fs.writeFileSync(ledgerFile, full);
    assert.throws(
      () => updateLedger(syntheticLedgerEntry("aggregate", "entry-129"), root),
      (error) => error?.code === "E_EVIDENCE_LEDGER_UPDATE_INVALID"
    );
    assert.equal(fs.readFileSync(ledgerFile, "utf8"), full);
  }
});

test("barriered cross-process ledger appends retain distinct phases", async () => {
  const root = initRepo();
  const control = tempDir("ledger-append-barrier-");
  const barrier = path.join(control, "go");
  const firstEntry = syntheticLedgerEntry("0", "concurrent-phase-0");
  const secondEntry = syntheticLedgerEntry("1", "concurrent-phase-1");
  const first = spawnLedgerAppender({
    root,
    entry: firstEntry,
    ready: path.join(control, "ready-0"),
    barrier
  });
  const second = spawnLedgerAppender({
    root,
    entry: secondEntry,
    ready: path.join(control, "ready-1"),
    barrier
  });
  await waitFor(() => fs.existsSync(path.join(control, "ready-0"))
    && fs.existsSync(path.join(control, "ready-1")));
  fs.writeFileSync(barrier, "go\n");
  const results = await Promise.all([first.completed, second.completed]);
  const retryEntries = [firstEntry, secondEntry].filter(
    (_entry, index) => ledgerAppenderNeedsRetry(results[index])
  );
  assert.ok(retryEntries.length <= 1);
  assert.ok(results.length - retryEntries.length >= 1);
  // Lock acquisition is intentionally bounded. On a slow runner, retry only
  // the exact losing append after both children have closed.
  for (const entry of retryEntries) updateLedger(entry, root);
  const ledger = loadLedger(root);
  assert.equal(ledger.entries.length, 2);
  assert.deepEqual(new Set(ledger.entries.map((entry) => entry.phase)), new Set(["0", "1"]));
  assert.ok(ledger.entries.every((entry) => entry.currency === "current"));
});

test("barriered same-phase appends retain one current and one historical entry", async () => {
  const root = initRepo();
  const control = tempDir("ledger-same-phase-barrier-");
  const barrier = path.join(control, "go");
  const firstEntry = syntheticLedgerEntry("2", "same-phase-a");
  const secondEntry = syntheticLedgerEntry("2", "same-phase-b");
  const first = spawnLedgerAppender({
    root,
    entry: firstEntry,
    ready: path.join(control, "ready-a"),
    barrier
  });
  const second = spawnLedgerAppender({
    root,
    entry: secondEntry,
    ready: path.join(control, "ready-b"),
    barrier
  });
  await waitFor(() => fs.existsSync(path.join(control, "ready-a"))
    && fs.existsSync(path.join(control, "ready-b")));
  fs.writeFileSync(barrier, "go\n");
  const results = await Promise.all([first.completed, second.completed]);
  const retryEntries = [firstEntry, secondEntry].filter(
    (_entry, index) => ledgerAppenderNeedsRetry(results[index])
  );
  assert.ok(retryEntries.length <= 1);
  assert.ok(results.length - retryEntries.length >= 1);
  // Preserve the same bounded-contention contract for same-phase cutover.
  for (const entry of retryEntries) updateLedger(entry, root);
  const ledger = loadLedger(root);
  assert.equal(ledger.entries.length, 2);
  assert.deepEqual(
    new Set(ledger.entries.map((entry) => entry.slice)),
    new Set(["same-phase-a", "same-phase-b"])
  );
  assert.equal(ledger.entries.filter((entry) => entry.currency === "current").length, 1);
  assert.equal(ledger.entries.filter((entry) => entry.currency === "historical").length, 1);
});

test("dead lock owner is reclaimed after a crash before ledger publication", async () => {
  const root = initRepo();
  const control = tempDir("ledger-crash-reclaim-");
  const ready = path.join(control, "ready");
  const barrier = path.join(control, "go");
  const crashed = spawnLedgerAppender({
    root,
    entry: syntheticLedgerEntry("0", "crash-before-ledger-rename"),
    ready,
    barrier,
    crashBeforeLedgerRename: true
  });
  await waitFor(() => fs.existsSync(ready));
  fs.writeFileSync(barrier, "go\n");
  const crashResult = await crashed.completed;
  assert.equal(crashResult.code, 73, crashResult.stderr);
  const lock = path.join(root, "tests/e2e-results/worker-broker/.ledger.lock");
  assert.equal(fs.existsSync(path.join(lock, "owner.json")), true);

  updateLedger(syntheticLedgerEntry("1", "reclaimed-after-crash"), root);
  const ledger = loadLedger(root);
  assert.deepEqual(ledger.entries.map((entry) => entry.slice), ["reclaimed-after-crash"]);
  assert.equal(fs.existsSync(lock), false);
});

test("an abandoned immutable transition is cleared before reclaiming its dead generation", async () => {
  const root = initRepo();
  const control = tempDir("ledger-transition-crash-");
  const ready = path.join(control, "ready");
  const barrier = path.join(control, "go");
  const crashed = spawnLedgerAppender({
    root,
    entry: syntheticLedgerEntry("0", "published-before-transition-crash"),
    ready,
    barrier,
    crashBeforeLockRetire: true
  });
  await waitFor(() => fs.existsSync(ready));
  fs.writeFileSync(barrier, "go\n");
  const crashResult = await crashed.completed;
  assert.equal(crashResult.code, 74, crashResult.stderr);
  const lock = path.join(root, "tests/e2e-results/worker-broker/.ledger.lock");
  assert.equal(fs.existsSync(path.join(lock, "transition.json")), true);

  updateLedger(syntheticLedgerEntry("1", "after-transition-reclaim"), root);
  const ledger = loadLedger(root);
  assert.deepEqual(
    ledger.entries.map((entry) => entry.slice),
    ["published-before-transition-crash", "after-transition-reclaim"]
  );
  assert.equal(fs.existsSync(lock), false);
});

test("an ownerless ledger-lock construction is reclaimable only after its grace period", () => {
  const root = initRepo();
  const evidenceDirectory = path.join(root, "tests/e2e-results/worker-broker");
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const lock = path.join(evidenceDirectory, ".ledger.lock");
  fs.mkdirSync(lock, { mode: 0o700 });
  const old = new Date(Date.now() - 31_000);
  fs.utimesSync(lock, old, old);

  updateLedger(syntheticLedgerEntry("0", "ownerless-after-grace"), root);
  assert.deepEqual(loadLedger(root).entries.map((entry) => entry.slice), ["ownerless-after-grace"]);
  assert.equal(fs.existsSync(lock), false);
});

test("fresh ownerless and old live ledger locks are never stolen", async () => {
  for (const kind of ["fresh-ownerless", "old-live-owner"]) {
    const root = initRepo();
    const evidenceDirectory = path.join(root, "tests/e2e-results/worker-broker");
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    const lock = path.join(evidenceDirectory, ".ledger.lock");
    fs.mkdirSync(lock, { mode: 0o700 });
    if (kind === "old-live-owner") {
      const stat = fs.lstatSync(lock, { bigint: true });
      fs.writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify({
        schemaVersion: 1,
        token: "a".repeat(64),
        pid: process.pid,
        directory: { dev: String(stat.dev), ino: String(stat.ino) }
      })}\n`, { mode: 0o600 });
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(lock, old, old);
    }
    const before = fs.lstatSync(lock, { bigint: true });
    const control = tempDir(`ledger-${kind}-`);
    const ready = path.join(control, "ready");
    const barrier = path.join(control, "go");
    fs.writeFileSync(barrier, "go\n");
    const startedAt = Date.now();
    const contender = spawnLedgerAppender({
      root,
      entry: syntheticLedgerEntry("0", `contender-${kind}`),
      ready,
      barrier
    });
    await waitFor(() => fs.existsSync(ready));
    if (kind === "old-live-owner") {
      const result = await contender.completed;
      const elapsed = Date.now() - startedAt;
      assert.notEqual(result.code, 0, result.stderr);
      assert.ok(elapsed >= 4_500 && elapsed < 15_000, `bounded wait was ${elapsed} ms`);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(contender.child.exitCode, null, kind);
    }
    const after = fs.lstatSync(lock, { bigint: true });
    assert.equal(String(after.dev), String(before.dev), kind);
    assert.equal(String(after.ino), String(before.ino), kind);
    assert.equal(fs.existsSync(path.join(evidenceDirectory, "ledger.json")), false, kind);
    if (kind === "fresh-ownerless") {
      contender.child.kill("SIGKILL");
      await contender.completed;
    }
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

test("malformed, unbound, and symlinked ledger locks fail closed", () => {
  const kinds = ["malformed", "unbound-owner", "unbound-transition"];
  if (process.platform !== "win32") kinds.push("symlink");
  for (const kind of kinds) {
    const root = initRepo();
    const evidenceDirectory = path.join(root, "tests/e2e-results/worker-broker");
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    const lock = path.join(evidenceDirectory, ".ledger.lock");
    let external;
    if (kind === "symlink") {
      external = tempDir("external-ledger-lock-");
      fs.writeFileSync(path.join(external, "sentinel"), "unchanged\n");
      fs.symlinkSync(external, lock);
    } else {
      fs.mkdirSync(lock, { mode: 0o700 });
      if (kind === "malformed") {
        fs.writeFileSync(path.join(lock, "owner.json"), "{malformed\n");
      } else if (kind === "unbound-owner") {
        fs.writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify({
          schemaVersion: 1,
          token: "b".repeat(64),
          pid: process.pid,
          directory: { dev: "0", ino: "0" }
        })}\n`);
      } else {
        const stat = fs.lstatSync(lock, { bigint: true });
        const ownerToken = "c".repeat(64);
        fs.writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify({
          schemaVersion: 1,
          token: ownerToken,
          pid: process.pid,
          directory: { dev: String(stat.dev), ino: String(stat.ino) }
        })}\n`);
        fs.writeFileSync(path.join(lock, "transition.json"), `${JSON.stringify({
          schemaVersion: 1,
          kind: "release",
          token: "d".repeat(64),
          pid: 2147483647,
          target: { dev: "0", ino: "0" },
          ownerToken
        })}\n`);
      }
    }
    let observed;
    try {
      updateLedger(syntheticLedgerEntry("0", `lock-${kind}`), root);
    } catch (error) {
      observed = error;
    }
    assert.equal(observed?.code, "E_EVIDENCE_LEDGER_LOCK", kind);
    assert.equal(observed?.message, "Evidence ledger lock is unsafe or unavailable.");
    assert.equal(fs.existsSync(path.join(evidenceDirectory, "ledger.json")), false);
    if (external) assert.equal(fs.readFileSync(path.join(external, "sentinel"), "utf8"), "unchanged\n");
  }
});

test("release transition retires only its generation and cannot delete a successor", {
  concurrency: false
}, () => {
  const root = initRepo();
  const lock = path.join(root, "tests/e2e-results/worker-broker/.ledger.lock");
  const rename = fs.renameSync;
  let intercepted = false;
  let transition;
  fs.renameSync = (source, destination) => {
    if (!intercepted
      && path.basename(source) === ".ledger.lock"
      && path.basename(destination).startsWith(".ledger.lock.retired-release-")) {
      transition = JSON.parse(fs.readFileSync(path.join(source, "transition.json"), "utf8"));
      rename(source, destination);
      fs.mkdirSync(source, { mode: 0o700 });
      fs.writeFileSync(path.join(source, "successor-sentinel"), "successor\n");
      intercepted = true;
      return;
    }
    return rename(source, destination);
  };
  try {
    updateLedger(syntheticLedgerEntry("0", "generation-safe-release"), root);
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(intercepted, true);
  assert.equal(transition.kind, "release");
  assert.match(transition.token, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(path.join(lock, "successor-sentinel"), "utf8"), "successor\n");
  fs.rmSync(lock, { recursive: true, force: true });
});
