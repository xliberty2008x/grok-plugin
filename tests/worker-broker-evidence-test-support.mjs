import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  REPO_ROOT,
  PHASE_SCOPE,
  PHASE_MANDATORY_GATE_IDS,
  PHASE_PROOF_GATE_MANIFEST,
  PHASE_THREE_SLICE,
  PHASE_TWO_SLICE,
  PROOF_PRODUCER_ID,
  PROOF_PRODUCER_VERSION,
  INDEPENDENT_REVIEW_PRODUCER_ID,
  INDEPENDENT_REVIEW_PRODUCER_VERSION,
  INDEPENDENT_REVIEW_MANIFEST_DIGEST,
  REVIEW_ATTESTATION_ALGORITHM,
  REVIEW_ATTESTATION_DOMAIN,
  REVIEW_ATTESTATION_ROOT,
  REVIEW_REQUEST_DOMAIN,
  REVIEW_REQUEST_ROOT,
  PROTECTED_REVIEW_RUNTIME_BUNDLE_PATHS,
  SIGNED_REVIEW_MANIFEST_DIGEST,
  LIVE_RECEIPT_AUTHORITY_CONFIG,
  LIVE_RECEIPT_AUTHORITY_NATURAL,
  LIVE_RECEIPT_AUTHORITY_SYNTHETIC,
  LIVE_RECEIPT_CAPABILITY_TOOL_IDS,
  LIVE_RECEIPT_MANIFEST,
  LIVE_RECEIPT_NATURAL_TOOL_IDS,
  LIVE_RECEIPT_PROVIDER_CAPABILITIES,
  LIVE_RECEIPT_PRODUCER_ID,
  LIVE_RECEIPT_PRODUCER_VERSION,
  LIVE_RECEIPT_ROOT,
  LIVE_RECEIPT_SCHEMA_VERSION,
  LIVE_RECEIPT_SCENARIO_IDS,
  assessCompleteEvidenceChain,
  attachIndependentReviewReceiptDigest,
  attachReviewAttestationDigest,
  attachReviewRequestDigest,
  attachRecordDigest,
  buildEvidenceRecord,
  computeInventoryDigest,
  computeLiveQualificationReceiptDigest,
  computeLiveReceiptManifestDigest,
  computePhaseScopeDigest,
  computeProofManifestDigest,
  computeReviewAttestationDigest,
  computeReviewPublicKeyFingerprint,
  computeReviewRequestDigest,
  computeRecordDigest,
  captureProofTemporaryHomeIdentity,
  canonicalReviewAttestationSigningBody,
  cleanupProofTemporaryHome,
  createPhaseOneReviewRequest,
  digestsIgnoreEvidenceOnly,
  expandLocalStaticImportClosure,
  findMissingLocalStaticImportDependencies,
  gitIdentity,
  isEvidenceOnlyPath,
  isNonEvidenceTreeClean,
  listLocalStaticImportSpecifiers,
  listSourceInventory,
  loadLedger,
  parsePorcelainV1ZChanges,
  phaseScopePaths,
  provePhaseZero,
  proveWorkerBrokerPhase,
  runCommandCapture,
  sanitizeProofEnvironment,
  statusSatisfiesVerifiedPrerequisite,
  updateLedger,
  validateEvidenceRecord,
  validateIndependentReviewAttestation,
  validateLiveQualificationReceipt,
  validatePhaseOneReviewRequest,
  verifyLedger,
  verifyPhase,
  writeEvidenceRecord,
  sha256Text
} from "../scripts/lib/worker-broker-evidence.mjs";
import {
  DETERMINISTIC_AGGREGATE_TEST_FILES,
  EXTERNAL_BOUNDARY_TESTS,
  listDeterministicTestFiles,
  runDeterministicTestFiles
} from "../scripts/test-deterministic.mjs";
import {
  PHASE1_FOCUSED_TEST_FILES,
  runPhaseOneFocusedTests
} from "../scripts/test-phase1-focused.mjs";
import {
  PHASE2_FOCUSED_TEST_FILES,
  runPhaseTwoFocusedTests
} from "../scripts/test-phase2-focused.mjs";
import {
  PHASE3_FOCUSED_TEST_FILES,
  runPhaseThreeFocusedTests
} from "../scripts/test-phase3-focused.mjs";
import {
  createPluginInventory,
  digestInventory
} from "../scripts/lib/plugin-inventory.mjs";
import zeroSkipTestReporter, {
  ZERO_SKIP_MAX_SUMMARY_BYTES,
  ZERO_SKIP_MAX_VIOLATIONS,
  ZERO_SKIP_REPORTER_ID,
  ZERO_SKIP_SUMMARY_FIELDS,
  ZERO_SKIP_VIOLATION_FIELDS,
  collectZeroSkipKnownSecrets,
  sanitizeZeroSkipFile,
  sanitizeZeroSkipName,
  validateZeroSkipSummary
} from "../scripts/lib/zero-skip-test-reporter.mjs";
import { ROOT, git, initRepo, run, tempDir, waitFor } from "./helpers.mjs";
import { loadPrivateReviewPromotionHarness } from "./worker-broker-evidence-private-harness.mjs";

const STARTED_AT = "2026-07-16T10:00:00.000Z";
const ENDED_AT = "2026-07-16T10:00:01.000Z";
const PRE_V5_PROOF_MANIFEST_DIGESTS = Object.freeze({
  "0": "66426cce37e08f4041ed272bfe6c9400298b9f05e1494b5ebd47747e1f43de8a",
  "1": "b2fa2be3c0f70da875c7fdc268694bbd0c97c3e087ae5aabe3c995c675dab74a"
});
const EVIDENCE_MODULE_URL = new URL("../scripts/lib/worker-broker-evidence.mjs", import.meta.url).href;
const ZERO_SKIP_REPORTER = path.join(ROOT, "scripts/lib/zero-skip-test-reporter.mjs");
const DETERMINISTIC_CHECK_RUNNER = path.join(ROOT, "scripts/check-deterministic.mjs");
const DETERMINISTIC_TEST_LIBRARY = path.join(ROOT, "scripts/lib/deterministic-test-runner.mjs");
const TEST_TEMP_LIBRARY = path.join(ROOT, "scripts/lib/test-temp.mjs");
const TEST_TEMP_CHILD_HOOK = path.join(ROOT, "scripts/lib/test-temp-child-hook.cjs");
const TEST_TEMP_GIT_CONTAINMENT = path.join(
  ROOT,
  "scripts/lib/test-temp-git-containment.cjs"
);
const TEST_TEMP_PIDFD_SIGNAL = path.join(ROOT, "scripts/lib/test-temp-pidfd-signal.py");
const TEST_TEMP_REMOVE_HELPER = path.join(
  ROOT,
  "scripts/lib/test-temp-remove-helper.cjs"
);
const TEST_TEMP_SUPERVISOR = path.join(ROOT, "scripts/lib/test-temp-supervisor.mjs");
const REDACT_LIBRARY = path.join(ROOT, "plugins/grok/scripts/lib/redact.mjs");
const PROTECTED_REVIEW_BOOTSTRAP = path.join(
  ROOT,
  "scripts/trusted/worker-broker-review.mjs"
);
const PROTECTED_REVIEW_OPERATION = path.join(
  ROOT,
  "scripts/trusted/worker-broker-review-operation.cjs"
);
const STATIC_ESM_IMPORT_PARSER = path.join(ROOT, "scripts/lib/static-esm-import-parser.mjs");
const WORKER_MUTATION_TEST_INVENTORY = path.join(
  ROOT,
  "scripts/lib/worker-mutation-test-inventory.mjs"
);
const PHASE_ONE_FOCUSED_RUNNER = path.join(ROOT, "scripts/test-phase1-focused.mjs");
const POSIX_PROOF_PLATFORM = process.platform === "darwin" || process.platform === "linux";
const SHORT_ABSOLUTE_PATH_NAMES = Object.freeze([
  "file=/tmp/a",
  String.raw`path:C:\a\b`,
  String.raw`unc=\\server\share`,
  "FILE:///tmp/a",
  "uri=file://host/a",
  "p=//srv/a",
  "p=//srv",
  "p=C:\\",
  "p=C:/",
  String.raw`p=\\server`,
  "p=/",
  "p=(/tmp/a)",
  "p=!/tmp/a"
]);

function installZeroSkipReporter(root) {
  for (const source of [ZERO_SKIP_REPORTER, REDACT_LIBRARY]) {
    const destination = path.join(root, path.relative(ROOT, source));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

function installPhaseOneFocusedRunner(root) {
  for (const source of [
    DETERMINISTIC_TEST_LIBRARY,
    TEST_TEMP_LIBRARY,
    TEST_TEMP_CHILD_HOOK,
    TEST_TEMP_GIT_CONTAINMENT,
    TEST_TEMP_PIDFD_SIGNAL,
    TEST_TEMP_REMOVE_HELPER,
    TEST_TEMP_SUPERVISOR,
    STATIC_ESM_IMPORT_PARSER,
    WORKER_MUTATION_TEST_INVENTORY,
    PHASE_ONE_FOCUSED_RUNNER
  ]) {
    const relative = path.relative(ROOT, source);
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

function zeroSkipViolation(overrides = {}) {
  return {
    outcome: "failed",
    file: "tests/fixture.test.mjs",
    name: "fixture",
    testNumber: 1,
    nesting: 0,
    line: null,
    column: null,
    errorName: "Error",
    errorCode: "ERR_TEST_FAILURE",
    operator: null,
    ...overrides
  };
}

function zeroSkipSummary(overrides = {}) {
  return `${JSON.stringify({
    reporter: ZERO_SKIP_REPORTER_ID,
    passed: 1,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    violations: [],
    omittedViolations: 0,
    ...overrides
  })}\n`;
}

async function collectZeroSkipReport(events, options = {}) {
  let output = "";
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    const source = (async function* eventSource() {
      for (const event of events) yield event;
    })();
    for await (const chunk of zeroSkipTestReporter(source, options)) output += chunk;
    return {
      exitCode: process.exitCode,
      summary: JSON.parse(output)
    };
  } finally {
    process.exitCode = previousExitCode;
  }
}

function installProofRepositoryGate(root, command) {
  const checkRunner = path.join(root, "scripts/check-deterministic.mjs");
  fs.mkdirSync(path.dirname(checkRunner), { recursive: true });
  fs.copyFileSync(DETERMINISTIC_CHECK_RUNNER, checkRunner);
  fs.writeFileSync(path.join(root, "scripts/validate.mjs"), "process.exit(0);\n");
  fs.writeFileSync(
    path.join(root, "scripts/test-deterministic.mjs"),
    [
      'import { spawnSync } from "node:child_process";',
      `const result = spawnSync(${JSON.stringify(command)}, [], {`,
      '  cwd: process.cwd(), env: process.env, shell: true, stdio: "inherit"',
      '});',
      'process.exit(Number.isInteger(result.status) ? result.status : 1);',
      ''
    ].join("\n")
  );
}

function rawEvidenceFixturePath(root, record) {
  const phaseDirectory = record.phase === "aggregate" ? "aggregate" : `phase-${record.phase}`;
  const sourceDigest = record.source?.sourceInventoryDigest ?? record.recordDigest;
  const relative = path.join(
    "tests/e2e-results/worker-broker",
    phaseDirectory,
    `${sourceDigest.slice(0, 16)}-${record.recordDigest.slice(0, 12)}.json`
  );
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return relative.split(path.sep).join("/");
}

function seedLedgerFixtureEntry(root, entry) {
  const ledgerPath = path.join(root, "tests/e2e-results/worker-broker/ledger.json");
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  let ledger = {
    // Ledger and live-receipt schemas version independently. A live receipt
    // version bump must never rewrite the immutable ledger contract.
    schemaVersion: 1,
    roadmapVersion: "1.0",
    issue: "https://github.com/xliberty2008x/grok-plugin/issues/25",
    updatedAt: null,
    entries: []
  };
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const next = {
    ...entry,
    currency: entry.currency || "current",
    recordedAt: entry.recordedAt || STARTED_AT
  };
  if (next.currency === "current") {
    for (const existing of ledger.entries) {
      if (existing.phase === next.phase && existing.currency === "current") {
        existing.currency = "historical";
      }
    }
  }
  ledger.entries.push(next);
  ledger.updatedAt = next.recordedAt;
  fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  return ledger;
}

function syntheticLedgerEntry(phase, slice, overrides = {}) {
  const recordDigest = sha256Text(`${phase}:${slice}:record`);
  const directory = phase === "aggregate" ? "aggregate" : `phase-${phase}`;
  return {
    phase,
    slice,
    status: "implemented_unverified",
    path: `tests/e2e-results/worker-broker/${directory}/${recordDigest.slice(0, 16)}.json`,
    recordDigest,
    sourceCommit: "1".repeat(40),
    currency: "current",
    recordedAt: STARTED_AT,
    ...overrides
  };
}

function spawnLedgerAppender({
  root,
  entry,
  ready,
  barrier,
  crashBeforeLedgerRename = false,
  crashBeforeLockRetire = false
}) {
  const source = `
import fs from "node:fs";
import path from "node:path";
import { updateLedger } from ${JSON.stringify(EVIDENCE_MODULE_URL)};
const entry = JSON.parse(process.env.LEDGER_ENTRY);
if (process.env.CRASH_BEFORE_LEDGER_RENAME === "1"
  || process.env.CRASH_BEFORE_LOCK_RETIRE === "1") {
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (process.env.CRASH_BEFORE_LEDGER_RENAME === "1"
      && path.basename(destination) === "ledger.json"
      && path.basename(source).startsWith(".ledger.json.")) process.exit(73);
    if (process.env.CRASH_BEFORE_LOCK_RETIRE === "1"
      && path.basename(source) === ".ledger.lock"
      && path.basename(destination).startsWith(".ledger.lock.retired-release-")) process.exit(74);
    return rename(source, destination);
  };
}
fs.writeFileSync(process.env.READY_FILE, "ready\\n");
while (!fs.existsSync(process.env.BARRIER_FILE)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
try {
  updateLedger(entry, process.env.LEDGER_ROOT);
  process.stdout.write(JSON.stringify({ ok: true, code: null }) + "\\n");
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    code: typeof error?.code === "string" ? error.code : null
  }) + "\\n");
  process.exitCode = 1;
}
`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    cwd: root,
    env: {
      ...process.env,
      LEDGER_ROOT: root,
      LEDGER_ENTRY: JSON.stringify(entry),
      READY_FILE: ready,
      BARRIER_FILE: barrier,
      CRASH_BEFORE_LEDGER_RENAME: crashBeforeLedgerRename ? "1" : "0",
      CRASH_BEFORE_LOCK_RETIRE: crashBeforeLockRetire ? "1" : "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, completed };
}

function ledgerAppenderNeedsRetry(result) {
  assert.equal(result.signal, null, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  if (result.code === 0) {
    assert.deepEqual(payload, { ok: true, code: null });
    return false;
  }
  assert.equal(result.code, 1, result.stdout);
  assert.deepEqual(payload, { ok: false, code: "E_EVIDENCE_LEDGER_LOCK" });
  return true;
}

function passedCommand(gateId, command, boundary = "source-provider-neutral") {
  return {
    gateId,
    command,
    boundary,
    outcome: "pass",
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    exitCode: 0,
    outputDigest: sha256Text(`${gateId}:${command}:pass`)
  };
}

function phaseProof(phase) {
  return [
    passedCommand("repository-check", "npm run check"),
    passedCommand(`phase-${phase}-focused-tests`, `node --test phase-${phase}-focused`, "focused-source-provider-neutral"),
    passedCommand("git-diff-check", "git show --check --format= HEAD", "source")
  ];
}

function deterministicQualification() {
  return {
    deterministic: "pass",
    installedHost: "not_run",
    provider: "not_run",
    release: "not_run"
  };
}

function exactPhaseZeroProof() {
  return PHASE_PROOF_GATE_MANIFEST["0"].map((gate) => ({
    gateId: gate.gateId,
    argv: [...gate.argv],
    boundary: gate.boundary,
    outcome: "pass",
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    exitCode: 0,
    outputDigest: sha256Text(`${gate.gateId}:proof`)
  }));
}

function exactPhaseProof(phase) {
  return PHASE_PROOF_GATE_MANIFEST[String(phase)].map((gate) => ({
    gateId: gate.gateId,
    argv: [...gate.argv],
    boundary: gate.boundary,
    outcome: "pass",
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    exitCode: 0,
    outputDigest: sha256Text(`${gate.gateId}:phase-${phase}-proof`)
  }));
}

function proofProducer(phase = "0") {
  return {
    id: PROOF_PRODUCER_ID,
    version: PROOF_PRODUCER_VERSION,
    manifestDigest: computeProofManifestDigest(phase)
  };
}

function assertQuiescentProofCleanupBoundary(record) {
  assert.ok(
    record.limits.residualRisks.some((risk) => (
      /all descendants are quiescent/i.test(risk)
      && /hostile same-UID races/i.test(risk)
      && /separately privileged supervisor/i.test(risk)
    )),
    "proof-produced records must disclose the quiescent same-UID cleanup boundary"
  );
  assert.ok(
    record.limits.unsupportedPlatforms.includes("windows-proof-producer-cleanup"),
    "proof-produced records must disclose unsupported Windows cleanup"
  );
}

function independentReviewReceipt(record, overrides = {}) {
  return attachIndependentReviewReceiptDigest({
    schemaVersion: 1,
    producerId: INDEPENDENT_REVIEW_PRODUCER_ID,
    producerVersion: INDEPENDENT_REVIEW_PRODUCER_VERSION,
    manifestDigest: INDEPENDENT_REVIEW_MANIFEST_DIGEST,
    reviewerRuntimeDigest: sha256Text("bound codex reviewer runtime"),
    headCommit: record.source.headCommit,
    headTree: record.source.headTree,
    sourceInventoryDigest: record.source.sourceInventoryDigest,
    phaseScopeDigest: record.source.phaseScopeDigest,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    outcome: "pass",
    unresolvedFindings: 0,
    ...overrides
  });
}

function initPhaseZeroEvidenceFixture(name = "evidence-fixture") {
  const root = initRepo();
  for (const relative of PHASE_SCOPE["0"]) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(
      absolute,
      relative === "package.json"
        ? `${JSON.stringify({ name, version: "1.0.0" })}\n`
        : `fixture for ${relative}\n`
    );
  }
  const evidenceDir = path.join(root, "tests/e2e-results/worker-broker");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, ".gitkeep"), "");
  git(root, "add", ".");
  git(root, "commit", "-m", `add ${name}`);
  return { root, evidenceDir };
}

function initProofRunnerFixture(name, checkScript = "node --test tests/proof-smoke.test.mjs") {
  const { root, evidenceDir } = initPhaseZeroEvidenceFixture(name);
  installZeroSkipReporter(root);
  installProofRepositoryGate(root, checkScript);
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({
    name,
    version: "1.0.0",
    private: true,
    type: "module",
    scripts: { check: checkScript }
  }, null, 2)}\n`);
  fs.writeFileSync(
    path.join(root, "tests/worker-broker-evidence.test.mjs"),
    'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("focused", () => assert.equal(1, 1));\n'
  );
  fs.writeFileSync(
    path.join(root, "tests/proof-smoke.test.mjs"),
    'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("smoke", () => assert.equal(1, 1));\n'
  );
  git(root, "add", ".");
  git(root, "commit", "-m", `configure ${name}`);
  return { root, evidenceDir };
}

function locateAmbientExecutable(name) {
  const locator = process.platform === "win32" ? "where.exe" : "/usr/bin/which";
  const result = run(locator, [name]);
  assert.equal(result.status, 0, `cannot locate honest ${name}: ${result.stderr}`);
  const candidates = result.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  const candidate = process.platform === "win32" && name === "npm"
    ? candidates.find((entry) => /\.cmd$/i.test(entry)) || candidates[0]
    : candidates[0];
  assert.equal(path.isAbsolute(candidate || ""), true, `honest ${name} path must be absolute`);
  return candidate;
}

function shellSingleQuote(value) {
  return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
}

function writePathPoisonForwarder(directory, name, honestExecutable, marker) {
  fs.mkdirSync(directory, { recursive: true });
  if (process.platform === "win32") {
    const executable = path.join(directory, `${name}.cmd`);
    const invoke = /\.(?:cmd|bat)$/i.test(honestExecutable)
      ? `call "${honestExecutable}" %*`
      : `"${honestExecutable}" %*`;
    fs.writeFileSync(executable, [
      "@echo off",
      `> "${marker}" echo poisoned`,
      invoke,
      "exit /b %ERRORLEVEL%",
      ""
    ].join("\r\n"));
    return executable;
  }
  const executable = path.join(directory, name);
  fs.writeFileSync(executable, [
    "#!/bin/sh",
    `printf '%s\\n' poisoned > ${shellSingleQuote(marker)}`,
    `exec ${shellSingleQuote(honestExecutable)} "$@"`,
    ""
  ].join("\n"), { mode: 0o755 });
  fs.chmodSync(executable, 0o755);
  return executable;
}

function initPhaseOneProofRunnerFixture(name, {
  failingFocusedGate = false,
  driftingFocusedGate = false,
  skippingFocusedGate = false
} = {}) {
  const root = initRepo();
  const scopedPaths = new Set([
    ...PHASE_SCOPE["0"],
    ...PHASE_SCOPE["1"],
    ...PHASE_SCOPE["2"]
  ]);
  for (const relative of scopedPaths) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    let content = `fixture for ${relative}\n`;
    if (/\.(?:m?js)$/i.test(relative)) content = "export {};\n";
    else if (/\.cjs$/i.test(relative)) content = "module.exports = {};\n";
    else if (/\.json$/i.test(relative)) content = "{}\n";
    fs.writeFileSync(absolute, content);
  }
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({
    name,
    version: "1.0.0",
    private: true,
    type: "module",
    scripts: { check: "node --test tests/proof-smoke.test.mjs" }
  }, null, 2)}\n`);
  installZeroSkipReporter(root);
  installProofRepositoryGate(root, "node --test tests/proof-smoke.test.mjs");
  installPhaseOneFocusedRunner(root);
  const passingTest = 'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("focused", () => assert.equal(1, 1));\n';
  for (const relative of [
    "tests/worker-broker-evidence.test.mjs",
    "tests/proof-smoke.test.mjs",
    ...PHASE1_FOCUSED_TEST_FILES
  ]) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, passingTest);
  }
  if (failingFocusedGate) {
    fs.writeFileSync(
      path.join(root, "tests/worker-protocol.test.mjs"),
      'import test from "node:test";\ntest("focused failure", () => { throw new Error("expected"); });\n'
    );
  }
  if (driftingFocusedGate) {
    fs.writeFileSync(
      path.join(root, "tests/worker-protocol.test.mjs"),
      'import test from "node:test";\nimport fs from "node:fs";\ntest("focused drift", () => fs.writeFileSync("tracked.txt", "drifted\\n"));\n'
    );
  }
  if (skippingFocusedGate) {
    fs.writeFileSync(
      path.join(root, "tests/worker-protocol.test.mjs"),
      'import test from "node:test";\ntest("forbidden proof skip", { skip: true }, () => {});\n'
    );
  }
  const evidenceDir = path.join(root, "tests/e2e-results/worker-broker");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, ".gitkeep"), "");
  git(root, "add", ".");
  git(root, "commit", "-m", `configure ${name}`);
  return { root, evidenceDir };
}

function initLiveReceiptFixture(name = "live-receipt-fixture") {
  const root = fs.realpathSync.native(initRepo());
  const scopedPaths = new Set([...PHASE_SCOPE["1"], ...PHASE_SCOPE["4"]]);
  for (const relative of scopedPaths) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    let content = `fixture for ${relative}\n`;
    if (relative === "plugins/grok/.codex-plugin/plugin.json") {
      content = `${JSON.stringify({ name: "grok", version: "1.0.0" })}\n`;
    } else if (/\.json$/i.test(relative)) {
      content = "{}\n";
    } else if (/\.(?:m?js)$/i.test(relative)) {
      content = "export {};\n";
    } else if (/\.cjs$/i.test(relative)) {
      content = "module.exports = {};\n";
    }
    fs.writeFileSync(absolute, content);
  }
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({
    name,
    version: "1.0.0",
    private: true,
    type: "module"
  }, null, 2)}\n`);
  const evidenceDir = path.join(root, "tests/e2e-results/worker-broker");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, ".gitkeep"), "");
  git(root, "add", ".");
  git(root, "commit", "-m", `configure ${name}`);
  return {
    name,
    root,
    providerCapabilityDigest: sha256Text(`${name}:stable-provider-capability`),
    hostTaskDigest: sha256Text(`${name}:opaque-host-task-authority`)
  };
}

function structuralPluginInventory(pluginRoot) {
  const entries = createPluginInventory(pluginRoot);
  const manifestEntry = entries.find(
    (entry) => entry.path === ".codex-plugin/plugin.json"
  );
  const installedEntrypoint = entries.find(
    (entry) => entry.path === LIVE_RECEIPT_MANIFEST.installedEntrypoint
  );
  const pluginVersion = JSON.parse(
    fs.readFileSync(path.join(pluginRoot, ".codex-plugin/plugin.json"), "utf8")
  ).version;
  assert.equal(typeof pluginVersion, "string");
  assert.equal(manifestEntry?.sha256, sha256Text(
    fs.readFileSync(path.join(pluginRoot, ".codex-plugin/plugin.json"))
  ));
  assert.match(installedEntrypoint?.sha256, /^[0-9a-f]{64}$/);
  return {
    digest: digestInventory(entries),
    fileCount: entries.length,
    pluginVersion,
    installedEntrypointDigest: installedEntrypoint.sha256
  };
}

// These fixtures deliberately author JSON below the unsupported publication
// boundary. They exercise strict offline replay only and are not proof that a
// live runner observed or authenticated any provider or host event.
function attachStructuralLiveReceiptDigest(receipt) {
  const next = { ...receipt };
  delete next.receiptDigest;
  next.receiptDigest = computeLiveQualificationReceiptDigest(next);
  return next;
}

function structuralLiveReceipt(fixture, authorityMode, overrides = {}) {
  const config = LIVE_RECEIPT_AUTHORITY_CONFIG[authorityMode];
  assert.ok(config, authorityMode);
  const sourceInventoryDigest = computeInventoryDigest(
    fixture.root,
    { includeEvidence: false }
  );
  const identity = gitIdentity(fixture.root);
  const pluginInventory = structuralPluginInventory(
    path.join(fixture.root, "plugins/grok")
  );
  const natural = authorityMode === LIVE_RECEIPT_AUTHORITY_NATURAL;
  const providerBinaryDigest = sha256Text(
    `${fixture.name}:structural-provider-binary`
  );
  const receipt = {
    schemaVersion: LIVE_RECEIPT_SCHEMA_VERSION,
    producerId: LIVE_RECEIPT_PRODUCER_ID,
    producerVersion: LIVE_RECEIPT_PRODUCER_VERSION,
    manifestDigest: computeLiveReceiptManifestDigest(),
    authorityMode,
    phase: config.phase,
    pluginVersion: pluginInventory.pluginVersion,
    headCommit: identity.headCommit,
    headTree: identity.headTree,
    sourceInventoryDigest,
    phaseScopeDigest: computePhaseScopeDigest(config.phase, fixture.root),
    repositoryBeforeDigest: sourceInventoryDigest,
    repositoryAfterDigest: sourceInventoryDigest,
    sourcePluginInventoryDigest: pluginInventory.digest,
    installedPluginInventoryDigest: pluginInventory.digest,
    installedFileCount: pluginInventory.fileCount,
    installedEntrypointDigest: pluginInventory.installedEntrypointDigest,
    providerCapabilityDigest: fixture.providerCapabilityDigest,
    observedProviderCapabilities: [...config.observedProviderCapabilities],
    observedToolIds: [...config.observedToolIds],
    providerBinaryDigest,
    providerVersion: "0.2.106-fixture",
    providerRevision: `binary-sha256-${providerBinaryDigest}`,
    mcpProtocolVersion: LIVE_RECEIPT_MANIFEST.mcpProtocolVersion,
    codexBinaryDigest: natural
      ? sha256Text(`${fixture.name}:structural-codex-binary`)
      : null,
    codexVersion: natural ? "0.120.0-fixture" : null,
    codexModel: natural ? "gpt-5.6-fixture" : null,
    hostTaskDigest: natural ? fixture.hostTaskDigest : null,
    installationMethod: "codex-local-plugin-cache",
    scenarios: structuredClone(config.scenarios),
    outcome: "pass",
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    ...overrides
  };
  delete receipt.receiptDigest;
  return attachStructuralLiveReceiptDigest(receipt);
}

function seedStructuralLiveReceipt(root, receipt) {
  const relative = [
    LIVE_RECEIPT_ROOT,
    receipt.authorityMode,
    `${receipt.sourceInventoryDigest.slice(0, 16)}-${receipt.receiptDigest.slice(0, 16)}.json`
  ].join("/");
  const absolute = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return {
    path: relative,
    receiptDigest: receipt.receiptDigest
  };
}

function liveQualificationRecord({
  fixture,
  phase,
  syntheticReceipt,
  syntheticReference,
  naturalReceipt = null,
  naturalReference = null
}) {
  const installationReceipt = naturalReceipt || syntheticReceipt;
  const liveScenarios = [
    ...LIVE_RECEIPT_AUTHORITY_CONFIG[LIVE_RECEIPT_AUTHORITY_SYNTHETIC].scenarios.map((scenario) => ({
      id: scenario.id,
      boundary: "provider-live",
      outcome: "pass"
    })),
    ...(naturalReceipt
      ? LIVE_RECEIPT_AUTHORITY_CONFIG[LIVE_RECEIPT_AUTHORITY_NATURAL].scenarios.map((scenario) => ({
        id: scenario.id,
        boundary: "installed-host",
        outcome: "pass"
      }))
      : [])
  ];
  const base = buildEvidenceRecord({
    root: fixture.root,
    phase,
    slice: phase === "1" ? "live-provider-transport" : "live-natural-host",
    status: "implemented_unverified",
    provisionalSupportingRecord: true,
    verification: [
      passedCommand("provider-live", "code-owned-live-runner", "provider-live"),
      ...(naturalReceipt
        ? [passedCommand("installed-host", "code-owned-natural-host-runner", "installed-host")]
        : [])
    ],
    liveScenarios,
    installation: {
      method: installationReceipt.installationMethod,
      sourcePluginInventoryDigest: installationReceipt.sourcePluginInventoryDigest,
      installedPluginInventoryDigest: installationReceipt.installedPluginInventoryDigest,
      installedFileCount: installationReceipt.installedFileCount,
      sourceAndInstalledInventoriesEqual: true,
      privateInstallPathRecorded: false
    },
    runtime: {
      platform: "test",
      architecture: "test",
      node: process.versions.node,
      git: "test",
      codexStandalone: naturalReceipt?.codexVersion || "test",
      codexDesktopBundled: null,
      grokBuild: installationReceipt.providerVersion,
      grokBuildRevision: installationReceipt.providerRevision,
      mcpProtocolVersion: "2025-11-25"
    },
    qualification: {
      deterministic: "not_run",
      installedHost: naturalReceipt ? "pass" : "not_run",
      provider: "pass",
      release: "not_run"
    },
    authorities: {
      workerClaims: "none",
      runtimeObservations: "bounded live receipt",
      hostVerification: "not_run",
      independentValidation: "not_run"
    }
  });
  const record = {
    ...base,
    liveQualificationReceipts: {
      syntheticDirectMcp: syntheticReference,
      naturalCodexHost: naturalReference
    }
  };
  delete record.recordDigest;
  return attachRecordDigest(record);
}

function initRunnableEvidenceCliFixture(name) {
  const root = initRepo();
  for (const relative of listSourceInventory(ROOT)) {
    const source = path.join(ROOT, relative);
    const destination = path.join(root, relative);
    const stat = fs.lstatSync(source);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (stat.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(source), destination);
    } else if (stat.isFile()) {
      fs.copyFileSync(source, destination);
      fs.chmodSync(destination, stat.mode);
    }
  }
  const evidenceDir = path.join(root, "tests/e2e-results/worker-broker");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, ".gitkeep"), "");
  git(root, "add", ".");
  git(root, "commit", "-m", `configure ${name}`);
  return { root, evidenceDir };
}

function initPhaseOneSignedReviewFixture(name = "signed-review") {
  const fixture = initRunnableEvidenceCliFixture(name);
  const baseCommit = git(fixture.root, "rev-parse", "HEAD").trim();
  const reviewedFile = path.join(
    fixture.root,
    "plugins/grok/scripts/lib/errors.mjs"
  );
  fs.appendFileSync(reviewedFile, `\n// ${name} reviewed source delta\n`);
  git(fixture.root, "add", "plugins/grok/scripts/lib/errors.mjs");
  git(fixture.root, "commit", "-m", `add ${name} reviewed delta`);

  let phaseZero = buildEvidenceRecord({
    root: fixture.root,
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
  const phaseZeroPath = rawEvidenceFixturePath(fixture.root, phaseZero);
  seedLedgerFixtureEntry(fixture.root, {
    phase: phaseZero.phase,
    slice: phaseZero.slice,
    status: phaseZero.status,
    path: phaseZeroPath,
    recordDigest: phaseZero.recordDigest,
    sourceCommit: phaseZero.source.headCommit,
    recordedAt: phaseZero.recordedAt
  });

  let phaseOne = buildEvidenceRecord({
    root: fixture.root,
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
    }],
    authorities: {
      workerClaims: "none",
      runtimeObservations: "broker-owned bounded Phase 1 gate runner",
      hostVerification: "not_run",
      independentValidation: "not_run"
    }
  });
  phaseOne = attachRecordDigest({
    ...phaseOne,
    proofProducer: proofProducer("1")
  });
  const phaseOnePath = rawEvidenceFixturePath(fixture.root, phaseOne);
  seedLedgerFixtureEntry(fixture.root, {
    phase: phaseOne.phase,
    slice: phaseOne.slice,
    status: phaseOne.status,
    path: phaseOnePath,
    recordDigest: phaseOne.recordDigest,
    sourceCommit: phaseOne.source.headCommit,
    recordedAt: phaseOne.recordedAt
  });
  const strict = verifyLedger(fixture.root, { strict: true });
  assert.equal(strict.ok, true, strict.errors.join("; "));
  return {
    ...fixture,
    baseCommit,
    phaseZero,
    phaseZeroPath,
    phaseOne,
    phaseOnePath
  };
}

function createReviewRequestFixture(fixture, {
  createdAt = new Date(Date.now() - 60_000).toISOString(),
  expiresAt = new Date(Date.now() + 60 * 60_000).toISOString(),
  nonce = crypto.randomBytes(32).toString("base64url"),
  write = true
} = {}) {
  return createPhaseOneReviewRequest({
    root: fixture.root,
    baseCommit: fixture.baseCommit,
    createdAt,
    expiresAt,
    nonce,
    write
  });
}

function signedReviewAttestation(requestResult, keyPair, overrides = {}) {
  const request = requestResult.request;
  const requestPath = requestResult.path
    || `${REVIEW_REQUEST_ROOT}/${request.source.headCommit.slice(0, 16)}-${request.requestDigest.slice(0, 16)}.json`;
  const startedAt = new Date(Date.parse(request.createdAt) + 1_000).toISOString();
  const endedAt = new Date(Date.parse(request.createdAt) + 2_000).toISOString();
  const body = {
    schemaVersion: 1,
    domain: REVIEW_ATTESTATION_DOMAIN,
    issuer: "test-protected-reviewer",
    keyFingerprint: computeReviewPublicKeyFingerprint(keyPair.publicKey),
    algorithm: REVIEW_ATTESTATION_ALGORITHM,
    requestPath,
    requestDigest: request.requestDigest,
    nonce: request.nonce,
    manifestDigest: SIGNED_REVIEW_MANIFEST_DIGEST,
    reviewerRuntimeDigest: sha256Text("ephemeral-test-reviewer-runtime"),
    headCommit: request.source.headCommit,
    headTree: request.source.headTree,
    sourceInventoryDigest: request.source.sourceInventoryDigest,
    phaseScopeDigest: request.source.phaseScopeDigest,
    diffBaseCommit: request.diff.baseCommit,
    diffPatchDigest: request.diff.patchDigest,
    diffPathsDigest: request.diff.pathsDigest,
    proofRecordDigest: request.proof.recordDigest,
    prerequisiteRecordDigest: request.prerequisite.recordDigest,
    startedAt,
    endedAt,
    outcome: "pass",
    unresolvedFindings: 0,
    ...overrides
  };
  const unsigned = { ...body };
  delete unsigned.signature;
  delete unsigned.attestationDigest;
  const signature = crypto.sign(
    null,
    Buffer.from(canonicalReviewAttestationSigningBody(unsigned), "utf8"),
    keyPair.privateKey
  ).toString("base64url");
  return attachReviewAttestationDigest({ ...unsigned, signature });
}

function writeReviewAttestationFixture(root, attestation) {
  const relative = `${REVIEW_ATTESTATION_ROOT}/${attestation.requestDigest.slice(0, 16)}-${attestation.attestationDigest.slice(0, 16)}.json`;
  const absolute = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(attestation, null, 2)}\n`, { mode: 0o600 });
  return relative;
}

function spawnPrivateReviewPromoter({
  harnessPath,
  root,
  requestPath,
  attestationPath,
  publicKey,
  now,
  ready,
  barrier
}) {
  const source = `
import fs from "node:fs";
import { __testPromoteSignedReview } from ${JSON.stringify(pathToFileURL(harnessPath).href)};
fs.writeFileSync(${JSON.stringify(ready)}, "ready\\n");
while (!fs.existsSync(${JSON.stringify(barrier)})) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
try {
  const result = __testPromoteSignedReview({
    root: ${JSON.stringify(root)},
    requestPath: ${JSON.stringify(requestPath)},
    attestationPath: ${JSON.stringify(attestationPath)},
    now: ${JSON.stringify(now)},
    trust: {
      publicKey: ${JSON.stringify(publicKey)},
      expectedIssuer: "test-protected-reviewer",
      revokedKeyFingerprints: []
    }
  });
  process.stdout.write(JSON.stringify(result) + "\\n");
} catch (error) {
  process.stderr.write(JSON.stringify({
    code: error?.code || "E_UNKNOWN",
    commitState: error?.commitState || null,
    recoveryRequired: error?.recoveryRequired === true,
    recordDigest: error?.recordDigest || null
  }) + "\\n");
  process.exitCode = 1;
}
`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, completed };
}

function seedPreRunnerCurrent(root, phase, slice = `legacy-${phase}`) {
  const base = buildEvidenceRecord({
    root,
    phase: "0",
    slice,
    status: "implemented_unverified",
    verification: [passedCommand("legacy", "legacy proof")]
  });
  const legacy = attachRecordDigest({
    ...base,
    phase: String(phase),
    slice,
    status: "verified_on_draft",
    evidenceSystemQualification: true,
    qualification: deterministicQualification()
  });
  const recordPath = rawEvidenceFixturePath(root, legacy);
  seedLedgerFixtureEntry(root, {
    phase: legacy.phase,
    slice: legacy.slice,
    status: legacy.status,
    path: recordPath,
    recordDigest: legacy.recordDigest,
    sourceCommit: legacy.source.headCommit,
    recordedAt: legacy.recordedAt
  });
  return { record: legacy, recordPath };
}

function seedPriorProofRunnerCurrent(
  root,
  phase = "0",
  slice = `runner-v1-${phase}`,
  version = 1,
  prerequisites = [],
  manifestDigest = version < PROOF_PRODUCER_VERSION
    ? PRE_V5_PROOF_MANIFEST_DIGESTS[phase]
    : computeProofManifestDigest(phase)
) {
  let record = buildEvidenceRecord({
    root,
    phase,
    slice,
    status: phase === "0" ? "verified_on_draft" : "implemented_unverified",
    verification: exactPhaseProof(phase),
    qualification: deterministicQualification(),
    evidenceSystemQualification: true,
    prerequisites
  });
  record = attachRecordDigest({
    ...record,
    proofProducer: {
      id: PROOF_PRODUCER_ID,
      version,
      manifestDigest
    }
  });
  const recordPath = rawEvidenceFixturePath(root, record);
  seedLedgerFixtureEntry(root, {
    phase: record.phase,
    slice: record.slice,
    status: record.status,
    path: recordPath,
    recordDigest: record.recordDigest,
    sourceCommit: record.source.headCommit,
    recordedAt: record.recordedAt
  });
  return { record, recordPath };
}

function spawnProofWriter({ root, slice, ready, barrier }) {
  const source = `
import fs from "node:fs";
import { provePhaseZero } from ${JSON.stringify(EVIDENCE_MODULE_URL)};
fs.writeFileSync(process.env.READY_FILE, "ready\\n");
while (!fs.existsSync(process.env.BARRIER_FILE)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
const result = provePhaseZero({ phase: "0", slice: process.env.PROOF_SLICE, root: process.env.PROOF_ROOT, write: true });
process.stdout.write(JSON.stringify({ ok: result.ok, code: result.code || null }) + "\\n");
process.exitCode = result.ok ? 0 : 1;
`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    cwd: root,
    env: {
      ...process.env,
      PROOF_ROOT: root,
      PROOF_SLICE: slice,
      READY_FILE: ready,
      BARRIER_FILE: barrier
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, completed };
}

function writePhaseZeroLedgerRecord(root, slice) {
  const record = buildEvidenceRecord({
    root,
    phase: "0",
    slice,
    verification: phaseProof("0")
  });
  const recordPath = writeEvidenceRecord(record, root);
  updateLedger({
    phase: record.phase,
    slice: record.slice,
    status: record.status,
    path: recordPath,
    recordDigest: record.recordDigest,
    sourceCommit: record.source.headCommit,
    recordedAt: record.recordedAt
  }, root);
  return { record, recordPath };
}

export {
  DETERMINISTIC_AGGREGATE_TEST_FILES,
  DETERMINISTIC_CHECK_RUNNER,
  DETERMINISTIC_TEST_LIBRARY,
  ENDED_AT,
  EVIDENCE_MODULE_URL,
  EXTERNAL_BOUNDARY_TESTS,
  INDEPENDENT_REVIEW_MANIFEST_DIGEST,
  INDEPENDENT_REVIEW_PRODUCER_ID,
  INDEPENDENT_REVIEW_PRODUCER_VERSION,
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
  PHASE1_FOCUSED_TEST_FILES,
  PHASE2_FOCUSED_TEST_FILES,
  PHASE3_FOCUSED_TEST_FILES,
  PHASE_MANDATORY_GATE_IDS,
  PHASE_ONE_FOCUSED_RUNNER,
  PHASE_PROOF_GATE_MANIFEST,
  PHASE_SCOPE,
  PHASE_THREE_SLICE,
  PHASE_TWO_SLICE,
  POSIX_PROOF_PLATFORM,
  PRE_V5_PROOF_MANIFEST_DIGESTS,
  PROOF_PRODUCER_ID,
  PROOF_PRODUCER_VERSION,
  PROTECTED_REVIEW_BOOTSTRAP,
  PROTECTED_REVIEW_OPERATION,
  PROTECTED_REVIEW_RUNTIME_BUNDLE_PATHS,
  REDACT_LIBRARY,
  REPO_ROOT,
  REVIEW_ATTESTATION_ALGORITHM,
  REVIEW_ATTESTATION_DOMAIN,
  REVIEW_ATTESTATION_ROOT,
  REVIEW_REQUEST_DOMAIN,
  REVIEW_REQUEST_ROOT,
  ROOT,
  SHORT_ABSOLUTE_PATH_NAMES,
  SIGNED_REVIEW_MANIFEST_DIGEST,
  STARTED_AT,
  STATIC_ESM_IMPORT_PARSER,
  TEST_TEMP_CHILD_HOOK,
  TEST_TEMP_GIT_CONTAINMENT,
  TEST_TEMP_LIBRARY,
  TEST_TEMP_PIDFD_SIGNAL,
  TEST_TEMP_REMOVE_HELPER,
  TEST_TEMP_SUPERVISOR,
  ZERO_SKIP_MAX_SUMMARY_BYTES,
  ZERO_SKIP_MAX_VIOLATIONS,
  ZERO_SKIP_REPORTER,
  ZERO_SKIP_REPORTER_ID,
  ZERO_SKIP_SUMMARY_FIELDS,
  ZERO_SKIP_VIOLATION_FIELDS,
  assert,
  assertQuiescentProofCleanupBoundary,
  assessCompleteEvidenceChain,
  attachIndependentReviewReceiptDigest,
  attachRecordDigest,
  attachReviewAttestationDigest,
  attachReviewRequestDigest,
  attachStructuralLiveReceiptDigest,
  buildEvidenceRecord,
  canonicalReviewAttestationSigningBody,
  captureProofTemporaryHomeIdentity,
  cleanupProofTemporaryHome,
  collectZeroSkipKnownSecrets,
  collectZeroSkipReport,
  computeInventoryDigest,
  computeLiveQualificationReceiptDigest,
  computeLiveReceiptManifestDigest,
  computePhaseScopeDigest,
  computeProofManifestDigest,
  computeRecordDigest,
  computeReviewAttestationDigest,
  computeReviewPublicKeyFingerprint,
  computeReviewRequestDigest,
  createPhaseOneReviewRequest,
  createPluginInventory,
  createReviewRequestFixture,
  crypto,
  deterministicQualification,
  digestInventory,
  digestsIgnoreEvidenceOnly,
  exactPhaseProof,
  exactPhaseZeroProof,
  expandLocalStaticImportClosure,
  findMissingLocalStaticImportDependencies,
  fs,
  git,
  gitIdentity,
  independentReviewReceipt,
  initLiveReceiptFixture,
  initPhaseOneProofRunnerFixture,
  initPhaseOneSignedReviewFixture,
  initPhaseZeroEvidenceFixture,
  initProofRunnerFixture,
  initRepo,
  initRunnableEvidenceCliFixture,
  installPhaseOneFocusedRunner,
  installProofRepositoryGate,
  installZeroSkipReporter,
  isEvidenceOnlyPath,
  isNonEvidenceTreeClean,
  ledgerAppenderNeedsRetry,
  listDeterministicTestFiles,
  listLocalStaticImportSpecifiers,
  listSourceInventory,
  liveQualificationRecord,
  loadLedger,
  loadPrivateReviewPromotionHarness,
  locateAmbientExecutable,
  os,
  parsePorcelainV1ZChanges,
  passedCommand,
  path,
  pathToFileURL,
  phaseProof,
  phaseScopePaths,
  proofProducer,
  provePhaseZero,
  proveWorkerBrokerPhase,
  rawEvidenceFixturePath,
  run,
  runCommandCapture,
  runDeterministicTestFiles,
  runPhaseOneFocusedTests,
  runPhaseThreeFocusedTests,
  runPhaseTwoFocusedTests,
  sanitizeProofEnvironment,
  sanitizeZeroSkipFile,
  sanitizeZeroSkipName,
  seedLedgerFixtureEntry,
  seedPreRunnerCurrent,
  seedPriorProofRunnerCurrent,
  seedStructuralLiveReceipt,
  sha256Text,
  shellSingleQuote,
  signedReviewAttestation,
  spawn,
  spawnLedgerAppender,
  spawnPrivateReviewPromoter,
  spawnProofWriter,
  statusSatisfiesVerifiedPrerequisite,
  structuralLiveReceipt,
  structuralPluginInventory,
  syntheticLedgerEntry,
  tempDir,
  updateLedger,
  validateEvidenceRecord,
  validateIndependentReviewAttestation,
  validateLiveQualificationReceipt,
  validatePhaseOneReviewRequest,
  validateZeroSkipSummary,
  verifyLedger,
  verifyPhase,
  waitFor,
  writeEvidenceRecord,
  writePathPoisonForwarder,
  writePhaseZeroLedgerRecord,
  writeReviewAttestationFixture,
  zeroSkipSummary,
  zeroSkipTestReporter,
  zeroSkipViolation
};
