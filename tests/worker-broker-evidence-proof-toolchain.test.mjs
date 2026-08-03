import test from "node:test";
import {
  EVIDENCE_MODULE_URL,
  PHASE1_FOCUSED_TEST_FILES,
  PHASE2_FOCUSED_TEST_FILES,
  PHASE3_FOCUSED_TEST_FILES,
  PHASE_MANDATORY_GATE_IDS,
  PHASE_PROOF_GATE_MANIFEST,
  PHASE_SCOPE,
  PHASE_THREE_SLICE,
  PHASE_TWO_SLICE,
  POSIX_PROOF_PLATFORM,
  PROOF_PRODUCER_VERSION,
  ROOT,
  ZERO_SKIP_REPORTER,
  ZERO_SKIP_REPORTER_ID,
  assert,
  attachRecordDigest,
  buildEvidenceRecord,
  captureProofTemporaryHomeIdentity,
  cleanupProofTemporaryHome,
  computeProofManifestDigest,
  deterministicQualification,
  exactPhaseProof,
  exactPhaseZeroProof,
  findMissingLocalStaticImportDependencies,
  fs,
  git,
  initProofRunnerFixture,
  locateAmbientExecutable,
  passedCommand,
  path,
  proofProducer,
  provePhaseZero,
  proveWorkerBrokerPhase,
  run,
  runCommandCapture,
  runPhaseThreeFocusedTests,
  runPhaseTwoFocusedTests,
  sanitizeProofEnvironment,
  tempDir,
  validateEvidenceRecord,
  verifyPhase,
  writeEvidenceRecord,
  writePathPoisonForwarder
} from "./worker-broker-evidence-test-support.mjs";
import {
  WORKER_MUTATION_SEMANTIC_TEST_FILES
} from "../scripts/lib/worker-mutation-test-inventory.mjs";

test("Phase 0 proof manifest and persisted producer provenance are exact", () => {
  assert.deepEqual(
    PHASE_PROOF_GATE_MANIFEST["0"].map((gate) => gate.gateId),
    PHASE_MANDATORY_GATE_IDS["0"]
  );
  assert.equal(PROOF_PRODUCER_VERSION, 5);
  assert.deepEqual(PHASE_PROOF_GATE_MANIFEST["0"][1].argv, [
    "node",
    "--test",
    "--test-reporter=./scripts/lib/zero-skip-test-reporter.mjs",
    "tests/worker-broker-evidence.test.mjs"
  ]);
  assert.equal(
    computeProofManifestDigest("0"),
    "17238acc3ce55892b24c1a7d18dde7b33c0df1156d2b1c264695bdcb3cf6b719"
  );
  assert.equal(Object.isFrozen(PHASE_PROOF_GATE_MANIFEST["0"]), true);
  assert.equal(Object.isFrozen(PHASE_PROOF_GATE_MANIFEST["0"][0].argv), true);
  const focusedTimeouts = {
    "0": 5 * 60_000,
    "1": 15 * 60_000,
    "2": 15 * 60_000,
    "3": 15 * 60_000,
    "4": 5 * 60_000,
    "5": 10 * 60_000,
    aggregate: 5 * 60_000
  };
  for (const [phase, gates] of Object.entries(PHASE_PROOF_GATE_MANIFEST)) {
    assert.equal(
      gates.find((gate) => gate.gateId === "repository-check")?.timeoutMs,
      25 * 60_000,
      `${phase} repository-check keeps the code-owned proof budget`
    );
    assert.equal(
      gates[1]?.timeoutMs,
      focusedTimeouts[phase],
      `${phase} non-repository gate budget remains unchanged`
    );
  }
  assert.equal(
    PHASE_SCOPE["0"].filter((candidate) => candidate === ".github/workflows/ci.yml").length,
    1,
    "the Phase 0 proof scope must bind the supported OS/Node CI policy"
  );

  const { root } = initProofRunnerFixture("proof-provenance");
  let record = buildEvidenceRecord({
    root,
    phase: "0",
    slice: "proof-provenance",
    status: "verified_on_draft",
    verification: exactPhaseZeroProof(),
    qualification: deterministicQualification(),
    evidenceSystemQualification: true
  });
  record = attachRecordDigest({ ...record, proofProducer: proofProducer() });
  const accepted = validateEvidenceRecord(record, { strict: true, root });
  assert.equal(accepted.ok, true, accepted.errors.join("; "));

  const wrongArgv = structuredClone(record);
  wrongArgv.verification[0].argv = ["node", "-e", "process.exit(0)"];
  const wrongArgvResult = validateEvidenceRecord(attachRecordDigest(wrongArgv), { strict: true, root });
  assert.equal(wrongArgvResult.ok, false);
  assert.ok(wrongArgvResult.errors.some((message) => /argv.*code-owned proof manifest/i.test(message)));

  const missing = structuredClone(record);
  missing.verification.pop();
  const missingResult = validateEvidenceRecord(attachRecordDigest(missing), { strict: true, root });
  assert.equal(missingResult.ok, false);
  assert.ok(missingResult.errors.some((message) => /exactly the code-owned/i.test(message)));

  const duplicate = structuredClone(record);
  duplicate.verification[1] = structuredClone(duplicate.verification[0]);
  const duplicateResult = validateEvidenceRecord(attachRecordDigest(duplicate), { strict: true, root });
  assert.equal(duplicateResult.ok, false);
  assert.ok(duplicateResult.errors.some((message) => /duplicated/i.test(message)));

  const wrongProducer = structuredClone(record);
  wrongProducer.proofProducer.manifestDigest = "0".repeat(64);
  const wrongProducerResult = validateEvidenceRecord(attachRecordDigest(wrongProducer), { strict: true, root });
  assert.equal(wrongProducerResult.ok, false);
  assert.ok(wrongProducerResult.errors.some((message) => /manifestDigest.*code-owned/i.test(message)));

  assert.throws(
    () => writeEvidenceRecord(record, root),
    /invalid/i,
    "the generic writer must never gain verified publication authority"
  );
});

test("present null or undefined proofProducer values fail validation and publication", () => {
  const { root } = initProofRunnerFixture("proof-producer-presence");
  const base = buildEvidenceRecord({
    root,
    phase: "0",
    slice: "proof-producer-presence",
    verification: [passedCommand("identity", "identity")]
  });
  const phaseDirectory = path.join(root, "tests/e2e-results/worker-broker/phase-0");
  for (const value of [null, undefined]) {
    const candidate = attachRecordDigest({ ...base, proofProducer: value });
    assert.equal(Object.hasOwn(candidate, "proofProducer"), true);
    const validation = validateEvidenceRecord(candidate);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((message) => /proofProducer must be an object when present/i.test(message)));
    assert.throws(() => writeEvidenceRecord(candidate, root), /invalid/i);
    if (value === undefined) {
      assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(candidate)), "proofProducer"), false);
    }
  }
  assert.equal(fs.existsSync(phaseDirectory), false, "invalid producer values must not create evidence paths");
});

test("proof command capture strips ambient authority and never returns secret-bearing output", () => {
  const ambientAuthorityCanary = path.join(tempDir("proof-ambient-authority-"), "poison-bin");
  const secret = ["xai", "A".repeat(24)].join("-");
  const environment = sanitizeProofEnvironment({
    ...process.env,
    PATH: ambientAuthorityCanary,
    HOME: ambientAuthorityCanary,
    XAI_API_KEY: secret,
    GROK_E2E: "1",
    GROK_E2E_CANCEL: "1",
    GROK_PROOF_PYTHON: path.join(ambientAuthorityCanary, "python3"),
    NODE_OPTIONS: "--inspect",
    GIT_DIR: "elsewhere",
    PASSWORD: secret
  });
  for (const key of [
    "XAI_API_KEY",
    "GROK_E2E",
    "GROK_E2E_CANCEL",
    "GROK_PROOF_PYTHON",
    "NODE_OPTIONS",
    "GIT_DIR",
    "PASSWORD"
  ]) assert.equal(Object.hasOwn(environment, key), false, key);
  assert.equal(environment.CI, "1");
  assert.equal(environment.PATH.includes(ambientAuthorityCanary), false);
  assert.equal(Object.hasOwn(environment, "HOME"), false);

  const secretResult = runCommandCapture(
    process.execPath,
    ["-e", `process.stdout.write(${JSON.stringify(secret)})`],
    { timeout: 5_000 }
  );
  assert.equal(secretResult.outcome, "fail");
  assert.equal(secretResult.failureKind, "secret_output");
  assert.equal(JSON.stringify(secretResult).includes(secret), false);
  assert.equal(Object.hasOwn(secretResult, "stdout"), false);
  assert.equal(Object.hasOwn(secretResult, "stderr"), false);

  const nonzero = runCommandCapture(process.execPath, ["-e", "process.exit(7)"], { timeout: 5_000 });
  assert.equal(nonzero.failureKind, "nonzero_exit");
  assert.equal(nonzero.exitCode, 7);

  const timeout = runCommandCapture(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { timeout: 25 }
  );
  assert.equal(timeout.outcome, "fail");
  assert.equal(timeout.failureKind, "timeout");

  const signalled = runCommandCapture(
    process.execPath,
    ["-e", 'process.kill(process.pid, "SIGTERM")'],
    { timeout: 5_000 }
  );
  assert.equal(signalled.outcome, "fail");
  assert.equal(signalled.failureKind, "signal");

  const missingExecutable = runCommandCapture(
    "definitely-not-a-worker-proof-executable",
    [],
    { timeout: 5_000 }
  );
  assert.equal(missingExecutable.outcome, "fail");
  assert.equal(missingExecutable.failureKind, "spawn_error");
});

test("mandatory proof reporter emits secret-safe v2 identities for pass, skip, TODO, failure, and cancellation", () => {
  const root = tempDir("zero-skip-reporter-");
  const passing = path.join(root, "passing.test.mjs");
  const partial = path.join(root, "partial.test.mjs");
  const failing = path.join(root, "failing.test.mjs");
  const cancelled = path.join(root, "cancelled.test.mjs");
  const directiveSecret = "xai-DIRECTIVEREPORTER000000";
  const assertionSecret = "xai-ASSERTIONREPORTER000000";
  const actualSecret = "xai-ACTUALREPORTER000000";
  const unsafeName = `unsafe \u001b[31m\u202e xai-NAMEREPORTER000000 /Users/private/file ${"z".repeat(300)}`;
  fs.writeFileSync(
    passing,
    'import test from "node:test";\ntest("pass", () => {});\n'
  );
  fs.writeFileSync(
    partial,
    [
      'import test from "node:test";',
      'test("pass", () => {});',
      `test("skip", { skip: ${JSON.stringify(directiveSecret)} }, () => {});`,
      `test("todo", { todo: ${JSON.stringify(directiveSecret)} }, () => {});`,
      ''
    ].join("\n")
  );
  fs.writeFileSync(
    failing,
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      `test(${JSON.stringify(unsafeName)}, () => {`,
      `  assert.equal(${JSON.stringify(actualSecret)}, "expected", ${JSON.stringify(assertionSecret)});`,
      "});",
      ''
    ].join("\n")
  );
  fs.writeFileSync(
    cancelled,
    [
      'import test from "node:test";',
      'test("cancelled by timeout", { timeout: 25 }, async () => {',
      '  await new Promise(() => {});',
      '});',
      ''
    ].join("\n")
  );
  const reporterArg = `--test-reporter=${ZERO_SKIP_REPORTER}`;
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const complete = run(process.execPath, ["--test", reporterArg, passing], {
    cwd: root,
    env: childEnvironment
  });
  assert.equal(complete.status, 0, complete.stderr || complete.stdout);
  const completeSummary = JSON.parse(complete.stdout);
  assert.equal(completeSummary.reporter, ZERO_SKIP_REPORTER_ID);
  assert.equal(completeSummary.skipped, 0);
  assert.equal(completeSummary.todo, 0);
  assert.deepEqual(completeSummary.violations, []);
  assert.equal(completeSummary.omittedViolations, 0);
  const rejected = run(process.execPath, ["--test", reporterArg, partial], {
    cwd: root,
    env: childEnvironment
  });
  assert.notEqual(rejected.status, 0);
  const partialSummary = JSON.parse(rejected.stdout);
  assert.equal(partialSummary.skipped, 1);
  assert.equal(partialSummary.todo, 1);
  assert.deepEqual(partialSummary.violations.map((entry) => entry.outcome), ["skipped", "todo"]);
  assert.equal(`${rejected.stdout}${rejected.stderr}`.includes(directiveSecret), false);

  const failed = run(process.execPath, ["--test", reporterArg, failing], {
    cwd: root,
    env: childEnvironment
  });
  assert.notEqual(failed.status, 0);
  const failedSummary = JSON.parse(failed.stdout);
  assert.ok(failedSummary.failed >= 1);
  assert.ok(failedSummary.violations.some((entry) => (
    entry.outcome === "failed" && entry.name === "[redacted]"
  )));
  const failureOutput = `${failed.stdout}${failed.stderr}`;
  for (const secret of [assertionSecret, actualSecret, "xai-NAMEREPORTER000000"]) {
    assert.equal(failureOutput.includes(secret), false, secret);
  }
  assert.equal(failureOutput.includes("/Users/private"), false);
  assert.equal(failureOutput.includes("\u001b"), false);
  assert.equal(failureOutput.includes("\u202e"), false);

  const cancelledResult = run(process.execPath, ["--test", reporterArg, cancelled], {
    cwd: root,
    env: childEnvironment
  });
  assert.notEqual(cancelledResult.status, 0);
  const cancelledSummary = JSON.parse(cancelledResult.stdout);
  assert.ok(cancelledSummary.cancelled >= 1);
  assert.ok(cancelledSummary.violations.some((entry) => entry.outcome === "cancelled"));
});

test("proof publication ignores caller-prepended fake npm, git, and python and survives honest strict replay", () => {
  const { root } = initProofRunnerFixture(
    "proof-path-poison",
    '"$GROK_PROOF_PYTHON" -I -S -B -c "import pty"'
  );
  const poisonRoot = tempDir("proof-path-poison-bin-");
  const fakeBin = path.join(poisonRoot, "bin");
  const npmMarker = path.join(poisonRoot, "fake-npm-invoked");
  const gitMarker = path.join(poisonRoot, "fake-git-invoked");
  const pythonMarker = path.join(poisonRoot, "fake-python-invoked");
  writePathPoisonForwarder(fakeBin, "npm", locateAmbientExecutable("npm"), npmMarker);
  writePathPoisonForwarder(fakeBin, "git", locateAmbientExecutable("git"), gitMarker);
  const fakePython = writePathPoisonForwarder(
    fakeBin,
    "python3",
    locateAmbientExecutable("python3"),
    pythonMarker
  );

  const source = `
import { proveWorkerBrokerPhase } from ${JSON.stringify(EVIDENCE_MODULE_URL)};
const result = proveWorkerBrokerPhase({
  phase: "0",
  slice: "path-poison",
  root: process.env.PROOF_ROOT,
  write: true
});
process.stdout.write(JSON.stringify({
  ok: result.ok,
  code: result.code || null,
  path: result.path || null
}) + "\\n");
process.exitCode = result.ok ? 0 : 1;
`;
  const poisoned = run(process.execPath, ["--input-type=module", "-e", source], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
      GROK_PROOF_PYTHON: fakePython,
      PROOF_ROOT: root
    },
    timeout: 120_000
  });
  assert.equal(poisoned.status, 0, poisoned.stderr || poisoned.stdout);
  const result = JSON.parse(poisoned.stdout.trim());
  assert.equal(result.ok, true, result.code);
  assert.match(result.path, /^tests\/e2e-results\/worker-broker\/phase-0\//);
  assert.equal(fs.existsSync(npmMarker), false, "fake npm must never execute");
  assert.equal(fs.existsSync(gitMarker), false, "fake git must never execute");
  assert.equal(fs.existsSync(pythonMarker), false, "fake python must never execute");

  const strict = verifyPhase("0", root, { strict: true });
  assert.equal(strict.ok, true, strict.errors.join("; "));
});

test("proof temporary-home cleanup removes its bound root without following symlinks", {
  skip: !POSIX_PROOF_PLATFORM
}, () => {
  const proofHome = tempDir("proof-home-cleanup-");
  const external = tempDir("proof-home-external-");
  const sentinel = path.join(external, "sentinel.txt");
  fs.writeFileSync(sentinel, "outside\n", { mode: 0o640 });
  const sentinelMode = fs.statSync(sentinel).mode & 0o777;
  const identity = captureProofTemporaryHomeIdentity(proofHome);
  const locked = path.join(proofHome, "nested", "ordinary");
  fs.mkdirSync(locked, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(locked, "inside.txt"), "inside\n", { mode: 0o600 });

  const externalLink = path.join(proofHome, "external-link");
  let linkCreated = false;
  try {
    fs.symlinkSync(external, externalLink, process.platform === "win32" ? "junction" : "dir");
    linkCreated = true;
  } catch (error) {
    if (process.platform !== "win32"
      || !new Set(["EPERM", "EACCES", "ENOTSUP"]).has(error?.code)) throw error;
  }

  try {
    assert.deepEqual(cleanupProofTemporaryHome(identity), { ok: true });
    assert.equal(fs.existsSync(proofHome), false);
    assert.deepEqual(cleanupProofTemporaryHome(identity), { ok: true }, "cleanup must be idempotent");
    assert.equal(fs.readFileSync(sentinel, "utf8"), "outside\n");
    assert.equal(fs.statSync(sentinel).mode & 0o777, sentinelMode);
    if (linkCreated) assert.equal(fs.existsSync(externalLink), false);
  } finally {
    fs.rmSync(proofHome, { recursive: true, force: true, maxRetries: 3 });
    fs.rmSync(external, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("proof temporary-home cleanup rejects copied identity without its bound handle", {
  skip: !POSIX_PROOF_PLATFORM
}, () => {
  const proofHome = tempDir("proof-home-forged-identity-");
  const identity = captureProofTemporaryHomeIdentity(proofHome);
  const copiedIdentity = Object.freeze({ ...identity });
  fs.writeFileSync(path.join(proofHome, "retained.txt"), "retained\n", { mode: 0o600 });
  try {
    assert.deepEqual(cleanupProofTemporaryHome(copiedIdentity), { ok: false });
    assert.equal(fs.readFileSync(path.join(proofHome, "retained.txt"), "utf8"), "retained\n");
    assert.deepEqual(cleanupProofTemporaryHome(identity), { ok: true });
    assert.equal(fs.existsSync(proofHome), false);
  } finally {
    fs.rmSync(proofHome, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("proof temporary-home cleanup fails closed on inaccessible descendants", {
  skip: !POSIX_PROOF_PLATFORM
}, () => {
  const proofHome = tempDir("proof-home-inaccessible-");
  const identity = captureProofTemporaryHomeIdentity(proofHome);
  const locked = path.join(proofHome, "mode-zero");
  fs.mkdirSync(locked, { mode: 0o700 });
  fs.writeFileSync(path.join(locked, "inside.txt"), "inside\n", { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(locked, 0o000);
  try {
    const result = cleanupProofTemporaryHome(identity);
    assert.deepEqual(result, { ok: false });
    assert.equal(fs.existsSync(proofHome), true);
  } finally {
    if (process.platform !== "win32") {
      try { fs.chmodSync(locked, 0o700); } catch {}
    }
    fs.rmSync(proofHome, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("proof temporary-home cleanup does not accept a concurrent root rename", {
  skip: !POSIX_PROOF_PLATFORM
}, () => {
  const proofHome = tempDir("proof-home-rename-race-");
  const moved = `${proofHome}-moved`;
  const identity = captureProofTemporaryHomeIdentity(proofHome);
  const remove = fs.rmSync;
  fs.writeFileSync(path.join(proofHome, "retained.txt"), "retained\n", { mode: 0o600 });
  try {
    fs.rmSync = (target, options) => {
      if (path.resolve(target) === identity.path) {
        fs.renameSync(identity.path, moved);
        return;
      }
      return remove(target, options);
    };
    assert.deepEqual(cleanupProofTemporaryHome(identity), { ok: false });
    assert.equal(fs.readFileSync(path.join(moved, "retained.txt"), "utf8"), "retained\n");
  } finally {
    fs.rmSync = remove;
    fs.rmSync(proofHome, { recursive: true, force: true, maxRetries: 3 });
    fs.rmSync(moved, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("proof cleanup failure is structured and occurs before evidence publication", {
  skip: !POSIX_PROOF_PLATFORM
}, () => {
  const markerRoot = tempDir("proof-home-replacement-marker-");
  const marker = path.join(markerRoot, "paths.json");
  const { root, evidenceDir } = initProofRunnerFixture(
    "proof-cleanup-before-publication",
    "node tests/replace-proof-home.mjs"
  );
  fs.writeFileSync(path.join(root, "tests/replace-proof-home.mjs"), [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'const home = fs.realpathSync(process.env.HOME);',
    'const moved = `${home}-moved`;',
    'fs.renameSync(home, moved);',
    'fs.mkdirSync(home, { mode: 0o700 });',
    `fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ home, moved }));`,
    ''
  ].join("\n"));
  git(root, "add", ".");
  git(root, "commit", "-m", "add proof-home replacement gate");

  let paths = null;
  try {
    const result = provePhaseZero({
      phase: "0",
      slice: "cleanup-before-publication",
      root,
      write: true
    });
    paths = JSON.parse(fs.readFileSync(marker, "utf8"));
    assert.deepEqual(result, { ok: false, code: "E_PROOF_CLEANUP" });
    assert.equal(fs.existsSync(path.join(evidenceDir, "ledger.json")), false);
    assert.equal(path.isAbsolute(paths.home), true);
    assert.equal(path.isAbsolute(paths.moved), true);
  } finally {
    if (paths == null && fs.existsSync(marker)) {
      try { paths = JSON.parse(fs.readFileSync(marker, "utf8")); } catch {}
    }
    for (const candidate of [paths?.home, paths?.moved]) {
      if (typeof candidate === "string" && path.isAbsolute(candidate)) {
        fs.rmSync(candidate, { recursive: true, force: true, maxRetries: 3 });
      }
    }
    fs.rmSync(markerRoot, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("proof producer rejects unsupported cleanup platforms before publication", () => {
  const { root, evidenceDir } = initProofRunnerFixture("proof-platform-rejected");
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", {
      configurable: true,
      enumerable: originalPlatform?.enumerable ?? true,
      value: "win32"
    });
    const result = proveWorkerBrokerPhase({
      phase: "0",
      slice: "unsupported-platform",
      root,
      write: true
    });
    assert.deepEqual(result, { ok: false, code: "E_PROOF_PLATFORM" });
    assert.equal(fs.existsSync(path.join(evidenceDir, "ledger.json")), false);
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

test("proof producer fails closed before publication when no fixed Python binding is usable", {
  skip: !POSIX_PROOF_PLATFORM
}, () => {
  const { root, evidenceDir } = initProofRunnerFixture("proof-python-unavailable");
  const originalLstat = fs.lstatSync;
  try {
    fs.lstatSync = (candidate, ...args) => {
      const basename = path.basename(String(candidate));
      if (basename === "python3" || basename === "python.exe") {
        const error = new Error("fixed Python candidate unavailable");
        error.code = "ENOENT";
        throw error;
      }
      return originalLstat.call(fs, candidate, ...args);
    };
    assert.deepEqual(proveWorkerBrokerPhase({
      phase: "0",
      slice: "python-unavailable",
      root,
      write: true
    }), { ok: false, code: "E_PROOF_TOOLCHAIN" });
  } finally {
    fs.lstatSync = originalLstat;
  }
  assert.equal(fs.existsSync(path.join(evidenceDir, "ledger.json")), false);
  const phaseDirectory = path.join(evidenceDir, "phase-0");
  assert.equal(
    fs.existsSync(phaseDirectory)
      && fs.readdirSync(phaseDirectory).some((entry) => entry.endsWith(".json")),
    false,
    "toolchain failure must not publish a record"
  );
});

test("Phase 0 proof fails without publication on dirty, drifting, failed, or secret-output gates", () => {
  const failed = initProofRunnerFixture("proof-failed", 'node -e "process.exit(7)"');
  const failedResult = provePhaseZero({ phase: "0", slice: "proof-failed", root: failed.root, write: true });
  assert.equal(failedResult.ok, false);
  assert.equal(failedResult.code, "E_PROOF_GATE");
  assert.equal(fs.existsSync(path.join(failed.evidenceDir, "ledger.json")), false);

  const secretExpression = "process.stdout.write(['xai', 'A'.repeat(24)].join('-'))";
  const secret = initProofRunnerFixture("proof-secret", `node -e "${secretExpression}"`);
  const secretResult = provePhaseZero({ phase: "0", slice: "proof-secret", root: secret.root, write: true });
  assert.equal(secretResult.ok, false);
  assert.equal(secretResult.failureKind, "secret_output");
  assert.equal(fs.existsSync(path.join(secret.evidenceDir, "ledger.json")), false);

  const dirty = initProofRunnerFixture("proof-dirty");
  fs.writeFileSync(path.join(dirty.root, "tracked.txt"), "dirty\n");
  const dirtyResult = provePhaseZero({ phase: "0", slice: "proof-dirty", root: dirty.root, write: true });
  assert.equal(dirtyResult.ok, false);
  assert.equal(dirtyResult.code, "E_PROOF_SOURCE_DIRTY");
  assert.equal(fs.existsSync(path.join(dirty.evidenceDir, "ledger.json")), false);

  const drift = initProofRunnerFixture(
    "proof-drift",
    'node -e "require(\'node:fs\').writeFileSync(\'tracked.txt\', \'drift\\n\')"'
  );
  const driftResult = provePhaseZero({ phase: "0", slice: "proof-drift", root: drift.root, write: true });
  assert.equal(driftResult.ok, false);
  assert.equal(driftResult.code, "E_PROOF_SOURCE_DRIFT");
  assert.equal(fs.existsSync(path.join(drift.evidenceDir, "ledger.json")), false);
});

test("proof execution rejects clean tracked scope symlinks to mutable external code", {
  skip: process.platform === "win32"
}, () => {
  const { root, evidenceDir } = initProofRunnerFixture("proof-external-symlink");
  const externalRoot = tempDir("proof-external-target-");
  const external = path.join(externalRoot, "check.mjs");
  fs.writeFileSync(external, "process.exit(0);\n");
  const runner = path.join(root, "scripts/check-deterministic.mjs");
  fs.unlinkSync(runner);
  fs.symlinkSync(external, runner);
  git(root, "add", "scripts/check-deterministic.mjs");
  git(root, "commit", "-m", "track unsafe external proof runner");

  const first = provePhaseZero({
    phase: "0",
    slice: "external-symlink",
    root,
    write: true
  });
  assert.equal(first.ok, false);
  assert.equal(first.code, "E_PROOF_SOURCE");
  fs.writeFileSync(external, "process.exit(7);\n");
  const mutated = provePhaseZero({
    phase: "0",
    slice: "external-symlink-mutated",
    root,
    write: true
  });
  assert.equal(mutated.ok, false);
  assert.equal(mutated.code, "E_PROOF_SOURCE");
  assert.equal(fs.existsSync(path.join(evidenceDir, "ledger.json")), false);
});

test("Phase 1 proof scope and code-owned worker-api manifest are explicit", () => {
  assert.deepEqual(
    PHASE_PROOF_GATE_MANIFEST["1"].map((gate) => gate.gateId),
    PHASE_MANDATORY_GATE_IDS["1"]
  );
  assert.deepEqual(
    exactPhaseProof("1").map((entry) => entry.argv),
    PHASE_PROOF_GATE_MANIFEST["1"].map((gate) => [...gate.argv])
  );
  assert.match(computeProofManifestDigest("1"), /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(PHASE_PROOF_GATE_MANIFEST["1"]), true);
  assert.equal(Object.isFrozen(PHASE_PROOF_GATE_MANIFEST["1"][1].argv), true);
  for (const relative of [
    "plugins/grok/.codex-plugin/plugin.json",
    "plugins/grok/.mcp.json",
    "plugins/grok/provider-agents/report-repair.md",
    "plugins/grok/provider-agents/rescue-read.md",
    "plugins/grok/provider-agents/rescue-write.md",
    "plugins/grok/provider-agents/setup-probe.md",
    "plugins/grok/schemas/review-output.schema.json",
    "plugins/grok/scripts/grok-companion.mjs",
    "plugins/grok/scripts/lib/process-control.mjs",
    "plugins/grok/scripts/lib/provider-bootstrap.mjs",
    "plugins/grok/scripts/lib/provider-capability.mjs",
    "plugins/grok/scripts/lib/recursion-guard.mjs",
    "plugins/grok/scripts/lib/worker-dispatch-supervisor.mjs",
    "plugins/grok/scripts/lib/worker-launch-contract.mjs",
    "plugins/grok/scripts/lib/worker-recovery.mjs",
    "plugins/grok/scripts/lib/worker-runtime.mjs",
    "plugins/grok/skills/rescue/SKILL.md",
    "plugins/grok/skills/result/SKILL.md",
    "plugins/grok/skills/status/SKILL.md",
    "scripts/lib/static-esm-import-parser.mjs",
    "scripts/lib/zero-skip-test-reporter.mjs",
    "scripts/lib/deterministic-test-runner.mjs",
    "scripts/lib/installed-worker-mcp-contract.mjs",
    "scripts/test-installed-worker-mcp.mjs",
    "scripts/test-phase1-focused.mjs",
    "scripts/validate.mjs",
    "package.json",
    "tests/control-plane-context-manifest.test.mjs",
    "tests/control-plane-git-refs.test.mjs",
    "tests/control-plane-lifecycle.test.mjs",
    "tests/control-plane-metadata-races.test.mjs",
    "tests/control-plane-worker-contracts.test.mjs",
    "tests/installed-worker-mcp-contract.test.mjs",
    "tests/installed-worker-mcp-runner.test.mjs",
    "tests/mcp-worker-runtime.test.mjs",
    "tests/process-control.test.mjs",
    "tests/provider.test.mjs",
    "tests/provider-bootstrap-crash-window.test.mjs",
    "tests/provider-capability.test.mjs",
    "tests/provider-startup-cancel.test.mjs",
    "tests/recursion-guard.test.mjs",
    "tests/runtime-admission.test.mjs",
    "tests/runtime-cancellation.test.mjs",
    "tests/runtime-recovery.test.mjs",
    "tests/runtime-task-lifecycle.test.mjs",
    "tests/runtime-transfer.test.mjs",
    "tests/worker-mailbox.test.mjs",
    "tests/worker-provider-rotation-intent.test.mjs",
    "tests/worker-reconcile-safety.test.mjs",
    "tests/worker-recovery-fence.test.mjs",
    "tests/worker-runtime-teardown.test.mjs",
    "tests/worker-startup-crash-window.test.mjs",
    "tests/worker-launch-outbox.test.mjs",
    "tests/worker-dispatch-supervisor.test.mjs",
    "tests/worker-cli-authority.test.mjs",
    "tests/worker-terminal-intent.test.mjs",
    "tests/process-control-owned-identity.test.mjs",
    "tests/worker-safety-proofs.test.mjs"
  ]) {
    assert.equal(
      PHASE_SCOPE["1"].filter((candidate) => candidate === relative).length,
      1,
      `${relative} must occur exactly once in the Phase 1 source scope`
    );
  }
  assert.equal(
    JSON.stringify(PHASE_PROOF_GATE_MANIFEST["1"][1].argv),
    JSON.stringify(["node", "scripts/test-phase1-focused.mjs"]),
    "the Phase 1 focused gate must use only the fixed serial runner"
  );
  for (const relative of [
    "tests/installed-worker-mcp-contract.test.mjs",
    "tests/installed-worker-mcp-runner.test.mjs",
    "tests/worker-launch-outbox.test.mjs",
    "tests/provider-bootstrap-crash-window.test.mjs",
    "tests/provider-capability.test.mjs",
    "tests/worker-dispatch-supervisor.test.mjs"
  ]) {
    assert.equal(
      PHASE1_FOCUSED_TEST_FILES.filter((candidate) => candidate === relative).length,
      1,
      `the Phase 1 focused gate must execute ${relative} exactly once`
    );
  }
  assert.equal(PHASE1_FOCUSED_TEST_FILES.length, 42);
});

test("Phase 2 protected manifest, scope, and serial inventory are exact", () => {
  assert.equal(PHASE_TWO_SLICE, "mailbox-context-roles");
  assert.equal(PROOF_PRODUCER_VERSION, 5);
  assert.deepEqual(PHASE_PROOF_GATE_MANIFEST["2"], [
    {
      gateId: "repository-check",
      argv: ["node", "scripts/check-deterministic.mjs"],
      boundary: "source-provider-neutral",
      timeoutMs: 25 * 60_000
    },
    {
      gateId: "phase-2-focused-tests",
      argv: ["node", "scripts/test-phase2-focused.mjs"],
      boundary: "focused-source-provider-neutral",
      timeoutMs: 15 * 60_000
    },
    {
      gateId: "git-diff-check",
      argv: ["git", "show", "--check", "--format=", "HEAD"],
      boundary: "source",
      timeoutMs: 60_000
    }
  ]);
  assert.equal(
    computeProofManifestDigest("2"),
    "966cacdb484e4fb5d214658a0d72aa24ace5e3b96910a479dc458587bc243d9c"
  );
  assert.deepEqual(PHASE2_FOCUSED_TEST_FILES, [
    "tests/acp-client.test.mjs",
    "tests/provider-capability.test.mjs",
    "tests/provider.test.mjs",
    "tests/state.test.mjs",
    "tests/worker-context-roles.test.mjs",
    "tests/worker-host-actions.test.mjs",
    "tests/worker-mailbox.test.mjs",
    ...WORKER_MUTATION_SEMANTIC_TEST_FILES,
    "tests/worker-protocol.test.mjs",
    "tests/worker-service.test.mjs",
    "tests/worker-dispatch-supervisor.test.mjs",
    "tests/worker-terminal-intent.test.mjs",
    "tests/worker-recovery-fence.test.mjs",
    "tests/worker-provider-rotation-intent.test.mjs",
    "tests/mcp-worker-broker.test.mjs",
    "tests/mcp-worker-runtime.test.mjs",
    "tests/installed-worker-mcp-contract.test.mjs",
    "tests/installed-worker-mcp-runner.test.mjs"
  ]);
  assert.equal(typeof runPhaseTwoFocusedTests, "function");
  for (const relative of [
    "plugins/grok/.codex-plugin/plugin.json",
    "plugins/grok/.mcp.json",
    "plugins/grok/provider-agents/report-repair.md",
    "plugins/grok/provider-agents/rescue-read.md",
    "plugins/grok/provider-agents/rescue-write.md",
    "plugins/grok/provider-agents/setup-probe.md",
    "plugins/grok/schemas/review-output.schema.json",
    "plugins/grok/schemas/worker-broker-evidence.schema.json",
    "plugins/grok/schemas/worker-broker-live-receipt.schema.json",
    "plugins/grok/schemas/worker-broker-review-attestation.schema.json",
    "plugins/grok/schemas/worker-broker-review-request.schema.json",
    "plugins/grok/schemas/worker-protocol.schema.json",
    "plugins/grok/scripts/lib/worker-authority.mjs",
    "plugins/grok/scripts/lib/worker-dispatch-supervisor.mjs",
    "plugins/grok/scripts/lib/worker-runtime.mjs",
    "scripts/lib/deterministic-test-runner.mjs",
    "scripts/lib/installed-worker-mcp-contract.mjs",
    "scripts/lib/worker-broker-evidence.mjs",
    "scripts/test-installed-worker-mcp.mjs",
    "scripts/test-phase2-focused.mjs",
    "scripts/trusted/worker-broker-review.mjs",
    "scripts/validate.mjs",
    "package.json",
    "tests/worker-broker-evidence.test.mjs",
    "tests/worker-broker-protected-review.test.mjs",
    ...PHASE2_FOCUSED_TEST_FILES
  ]) {
    assert.equal(
      PHASE_SCOPE["2"].filter((candidate) => candidate === relative).length,
      1,
      `${relative} must occur exactly once in the Phase 2 source scope`
    );
  }
  assert.deepEqual(findMissingLocalStaticImportDependencies(PHASE_SCOPE["2"]), []);
});

test("Phase 3 protected manifest, scope, and zero-skip inventory are exact", () => {
  assert.equal(PHASE_THREE_SLICE, "execution-lease-artifact-integration");
  assert.deepEqual(PHASE_PROOF_GATE_MANIFEST["3"], [
    {
      gateId: "repository-check",
      argv: ["node", "scripts/check-deterministic.mjs"],
      boundary: "source-provider-neutral",
      timeoutMs: 25 * 60_000
    },
    {
      gateId: "phase-3-focused-tests",
      argv: ["node", "scripts/test-phase3-focused.mjs"],
      boundary: "focused-source-provider-neutral",
      timeoutMs: 15 * 60_000
    },
    {
      gateId: "git-diff-check",
      argv: ["git", "show", "--check", "--format=", "HEAD"],
      boundary: "source",
      timeoutMs: 60_000
    }
  ]);
  assert.deepEqual(PHASE3_FOCUSED_TEST_FILES, [
    "tests/acp-client.test.mjs",
    "tests/grok-worktree-acp.test.mjs",
    "tests/provider-bootstrap-crash-window.test.mjs",
    "tests/provider-capability.test.mjs",
    "tests/provider.test.mjs",
    "tests/recursion-guard.test.mjs",
    "tests/state.test.mjs",
    "tests/worker-dispatch-supervisor.test.mjs",
    "tests/worker-execution-binding.test.mjs",
    "tests/worker-launch-outbox.test.mjs",
    ...WORKER_MUTATION_SEMANTIC_TEST_FILES,
    "tests/worker-owner-controller.test.mjs",
    "tests/worker-owner-lifecycle.test.mjs",
    "tests/worker-protocol.test.mjs",
    "tests/worker-service.test.mjs",
    "tests/worker-session-close-environment.test.mjs",
    "tests/worker-worktree.test.mjs",
    "tests/mcp-worker-broker.test.mjs",
    "tests/mcp-worker-runtime.test.mjs",
    "tests/installed-worker-mcp-contract.test.mjs",
    "tests/installed-worker-mcp-runner.test.mjs",
    "tests/worker-broker-phase3-evidence.test.mjs"
  ]);
  assert.equal(typeof runPhaseThreeFocusedTests, "function");
  for (const relative of [
    "scripts/lib/worker-broker-phase3-evidence.mjs",
    "scripts/lib/worker-broker-evidence.mjs",
    "scripts/test-phase3-focused.mjs",
    "scripts/worker-broker-phase3-evidence.mjs",
    "scripts/trusted/worker-broker-review.mjs",
    "scripts/trusted/worker-broker-review-operation.cjs",
    "tests/worker-broker-evidence.test.mjs",
    "tests/worker-broker-phase3-evidence.test.mjs",
    "tests/worker-broker-protected-review.test.mjs",
    ...PHASE3_FOCUSED_TEST_FILES
  ]) {
    assert.equal(
      PHASE_SCOPE["3"].filter((candidate) => candidate === relative).length,
      1,
      `${relative} must occur exactly once in the Phase 3 source scope`
    );
  }
  assert.deepEqual(findMissingLocalStaticImportDependencies(PHASE_SCOPE["3"]), []);
});

test("Phase 1 proof rejects unsupported slices and caller-supplied execution authority", () => {
  const legacyPhaseZeroEntrypoint = provePhaseZero({ phase: "1", slice: "worker-api" });
  assert.equal(legacyPhaseZeroEntrypoint.ok, false);
  assert.equal(legacyPhaseZeroEntrypoint.code, "E_PROOF_ARGUMENT");
  for (const options of [
    { phase: "1", slice: "not-worker-api" },
    { phase: "2", slice: "worker-api" },
    { phase: "1", slice: "worker-api", commands: [["node", "-e", "process.exit(0)"]] },
    { phase: "1", slice: "worker-api", outcomes: ["pass"] },
    { phase: "1", slice: "worker-api", env: { XAI_API_KEY: "caller-value" } }
  ]) {
    const result = proveWorkerBrokerPhase(options);
    assert.equal(result.ok, false);
    assert.equal(result.code, "E_PROOF_ARGUMENT");
  }

  const cli = path.join(ROOT, "scripts/worker-broker-evidence.mjs");
  const unsupported = run(process.execPath, [
    cli,
    "prove",
    "--phase",
    "1",
    "--slice",
    "not-worker-api"
  ], { cwd: ROOT });
  assert.equal(unsupported.status, 2);
  assert.match(unsupported.stderr, /phase 1 --slice worker-api/i);
  const injected = run(process.execPath, [
    cli,
    "prove",
    "--phase",
    "1",
    "--slice",
    "worker-api",
    "--command",
    "node"
  ], { cwd: ROOT });
  assert.equal(injected.status, 2);

  const protectedOnlyPhaseTwo = proveWorkerBrokerPhase({
    phase: "2",
    slice: PHASE_TWO_SLICE
  });
  assert.deepEqual(protectedOnlyPhaseTwo, {
    ok: false,
    code: "E_PROOF_ARGUMENT"
  });
  const protectedOnlyCli = run(process.execPath, [
    cli,
    "prove",
    "--phase",
    "2",
    "--slice",
    PHASE_TWO_SLICE
  ], { cwd: ROOT });
  assert.equal(protectedOnlyCli.status, 1);
  assert.equal(protectedOnlyCli.stderr, "");
  assert.equal(JSON.parse(protectedOnlyCli.stdout).code, "E_PROOF_ARGUMENT");

  const protectedOnlyPhaseThree = proveWorkerBrokerPhase({
    phase: "3",
    slice: PHASE_THREE_SLICE
  });
  assert.deepEqual(protectedOnlyPhaseThree, {
    ok: false,
    code: "E_PROOF_ARGUMENT"
  });
});
