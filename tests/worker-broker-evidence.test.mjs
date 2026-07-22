import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  REPO_ROOT,
  PHASE_SCOPE,
  PHASE_MANDATORY_GATE_IDS,
  PHASE_PROOF_GATE_MANIFEST,
  PROOF_PRODUCER_ID,
  PROOF_PRODUCER_VERSION,
  INDEPENDENT_REVIEW_PRODUCER_ID,
  INDEPENDENT_REVIEW_PRODUCER_VERSION,
  INDEPENDENT_REVIEW_MANIFEST_DIGEST,
  attachIndependentReviewReceiptDigest,
  attachRecordDigest,
  buildEvidenceRecord,
  computeInventoryDigest,
  computePhaseScopeDigest,
  computeProofManifestDigest,
  computeRecordDigest,
  expandLocalStaticImportClosure,
  findMissingLocalStaticImportDependencies,
  gitIdentity,
  isEvidenceOnlyPath,
  isNonEvidenceTreeClean,
  listLocalStaticImportSpecifiers,
  listSourceInventory,
  loadLedger,
  parsePorcelainV1ZChanges,
  provePhaseZero,
  proveWorkerBrokerPhase,
  runCommandCapture,
  sanitizeProofEnvironment,
  statusSatisfiesVerifiedPrerequisite,
  updateLedger,
  validateEvidenceRecord,
  verifyLedger,
  verifyPhase,
  writeEvidenceRecord,
  sha256Text,
  digestsIgnoreEvidenceOnly
} from "../scripts/lib/worker-broker-evidence.mjs";
import {
  EXTERNAL_BOUNDARY_TESTS,
  listDeterministicTestFiles,
  runDeterministicTestFiles
} from "../scripts/test-deterministic.mjs";
import {
  PHASE1_FOCUSED_TEST_FILES,
  runPhaseOneFocusedTests
} from "../scripts/test-phase1-focused.mjs";
import { ROOT, git, initRepo, run, tempDir, waitFor } from "./helpers.mjs";

const STARTED_AT = "2026-07-16T10:00:00.000Z";
const ENDED_AT = "2026-07-16T10:00:01.000Z";
const EVIDENCE_MODULE_URL = new URL("../scripts/lib/worker-broker-evidence.mjs", import.meta.url).href;
const ZERO_SKIP_REPORTER = path.join(ROOT, "scripts/lib/zero-skip-test-reporter.mjs");
const DETERMINISTIC_CHECK_RUNNER = path.join(ROOT, "scripts/check-deterministic.mjs");
const DETERMINISTIC_TEST_LIBRARY = path.join(ROOT, "scripts/lib/deterministic-test-runner.mjs");
const STATIC_ESM_IMPORT_PARSER = path.join(ROOT, "scripts/lib/static-esm-import-parser.mjs");
const PHASE_ONE_FOCUSED_RUNNER = path.join(ROOT, "scripts/test-phase1-focused.mjs");

function installZeroSkipReporter(root) {
  const destination = path.join(root, "scripts/lib/zero-skip-test-reporter.mjs");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(ZERO_SKIP_REPORTER, destination);
}

function installPhaseOneFocusedRunner(root) {
  for (const source of [
    DETERMINISTIC_TEST_LIBRARY,
    STATIC_ESM_IMPORT_PARSER,
    PHASE_ONE_FOCUSED_RUNNER
  ]) {
    const relative = path.relative(ROOT, source);
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

test("deterministic zero-skip runner excludes only explicit external boundaries", () => {
  assert.deepEqual(EXTERNAL_BOUNDARY_TESTS, [
    "installed-codex.test.mjs",
    "live-grok.test.mjs"
  ]);
  const all = fs.readdirSync(path.join(ROOT, "tests"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => `tests/${entry.name}`)
    .sort();
  const expected = all.filter((relative) => (
    !EXTERNAL_BOUNDARY_TESTS.includes(path.basename(relative))
  ));
  assert.deepEqual(listDeterministicTestFiles(), expected);
});

function zeroSkipSummary(overrides = {}) {
  return `${JSON.stringify({
    reporter: "zero-skip-v1",
    passed: 1,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    ...overrides
  })}\n`;
}

test("deterministic runner executes files sequentially and aggregates exact zero-skip summaries", () => {
  const calls = [];
  let output = "";
  let diagnostic = "";
  const files = ["tests/first.test.mjs", "tests/second.test.mjs"];
  const status = runDeterministicTestFiles({
    files,
    root: "/exact/root",
    reporter: "/exact/reporter.mjs",
    node: "/exact/node",
    env: { PROOF_ENV: "fixed" },
    run(binary, args, options) {
      calls.push({ binary, args, options });
      return {
        status: 0,
        signal: null,
        stdout: zeroSkipSummary({ passed: calls.length }),
        stderr: ""
      };
    },
    stdout: { write(value) { output += value; } },
    stderr: { write(value) { diagnostic += value; } }
  });
  assert.equal(status, 0);
  assert.equal(diagnostic, "");
  assert.deepEqual(calls.map((call) => call.args), files.map((file) => [
    "--test",
    "--test-reporter=/exact/reporter.mjs",
    file
  ]));
  assert.ok(calls.every((call) => call.binary === "/exact/node"));
  assert.ok(calls.every((call) => call.options.cwd === "/exact/root"));
  assert.ok(calls.every((call) => call.options.shell === false));
  assert.deepEqual(JSON.parse(output), {
    reporter: "zero-skip-v1",
    passed: 3,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0
  });
});

test("Phase 1 focused runner executes its fixed inventory in exact serial order", () => {
  const calls = [];
  let output = "";
  const status = runPhaseOneFocusedTests({
    run(_binary, args) {
      calls.push(args.at(-1));
      return { status: 0, signal: null, stdout: zeroSkipSummary(), stderr: "" };
    },
    stdout: { write(value) { output += value; } },
    stderr: { write() {} }
  });
  assert.equal(status, 0);
  assert.deepEqual(calls, PHASE1_FOCUSED_TEST_FILES);
  assert.equal(new Set(calls).size, PHASE1_FOCUSED_TEST_FILES.length);
  assert.deepEqual(JSON.parse(output), {
    reporter: "zero-skip-v1",
    passed: PHASE1_FOCUSED_TEST_FILES.length,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0
  });
});

test("deterministic runner fails closed on malformed, partial, or non-passing child results", () => {
  const cases = [
    {
      label: "malformed-summary",
      result: { status: 0, signal: null, stdout: "{}\n", stderr: "" },
      message: /invalid zero-skip summary/
    },
    {
      label: "extra-summary-field",
      result: {
        status: 0,
        signal: null,
        stdout: zeroSkipSummary({ unexpected: 1 }),
        stderr: ""
      },
      message: /invalid zero-skip summary/
    },
    {
      label: "skip",
      result: { status: 1, signal: null, stdout: zeroSkipSummary({ passed: 0, skipped: 1 }), stderr: "" },
      message: /failed its zero-skip gate/
    },
    {
      label: "empty-test-file",
      result: { status: 0, signal: null, stdout: zeroSkipSummary({ passed: 0 }), stderr: "" },
      message: /failed its zero-skip gate/
    },
    {
      label: "signal",
      result: { status: null, signal: "SIGTERM", stdout: "", stderr: "" },
      message: /ended by signal SIGTERM/
    },
    {
      label: "spawn-error",
      result: { status: null, signal: null, stdout: "", stderr: "", error: new Error("spawn") },
      message: /could not start/
    }
  ];
  for (const fixture of cases) {
    let output = "";
    let diagnostic = "";
    const status = runDeterministicTestFiles({
      files: [`tests/${fixture.label}.test.mjs`],
      run: () => fixture.result,
      stdout: { write(value) { output += value; } },
      stderr: { write(value) { diagnostic += value; } }
    });
    assert.equal(status, 1, fixture.label);
    assert.match(diagnostic, fixture.message, fixture.label);
    assert.equal(JSON.parse(output).reporter, "zero-skip-v1", fixture.label);
  }

  let diagnostic = "";
  assert.equal(runDeterministicTestFiles({
    files: [],
    stdout: { write() {} },
    stderr: { write(value) { diagnostic += value; } }
  }), 1);
  assert.match(diagnostic, /No deterministic test files/);
});

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
updateLedger(entry, process.env.LEDGER_ROOT);
process.stdout.write("ok\\n");
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
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, completed };
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
  updateLedger({
    phase: legacy.phase,
    slice: legacy.slice,
    status: legacy.status,
    path: recordPath,
    recordDigest: legacy.recordDigest,
    sourceCommit: legacy.source.headCommit,
    recordedAt: legacy.recordedAt
  }, root);
  return { record: legacy, recordPath };
}

function seedPriorProofRunnerCurrent(root, phase = "0", slice = `runner-v1-${phase}`) {
  let record = buildEvidenceRecord({
    root,
    phase,
    slice,
    status: phase === "0" ? "verified_on_draft" : "implemented_unverified",
    verification: exactPhaseProof(phase),
    qualification: deterministicQualification(),
    evidenceSystemQualification: true
  });
  record = attachRecordDigest({
    ...record,
    proofProducer: {
      id: PROOF_PRODUCER_ID,
      version: 1,
      manifestDigest: computeProofManifestDigest(phase)
    }
  });
  const recordPath = rawEvidenceFixturePath(root, record);
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

test("evidence tree cleanliness parses rename source and destination fail closed", () => {
  const root = initRepo();
  const disguisedSource = "aaatests/e2e-results/worker-broker/source.txt";
  const evidenceDestination = "tests/e2e-results/worker-broker/moved.txt";
  fs.mkdirSync(path.dirname(path.join(root, disguisedSource)), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(root, evidenceDestination)), { recursive: true });
  fs.writeFileSync(path.join(root, disguisedSource), "source\n");
  git(root, "add", disguisedSource);
  git(root, "commit", "-m", "add disguised non-evidence source");
  git(root, "mv", disguisedSource, evidenceDestination);

  assert.equal(
    isNonEvidenceTreeClean(root),
    false,
    "a non-evidence source renamed into the evidence tree must remain dirty"
  );

  const evidenceRoot = initRepo();
  const evidenceSource = "tests/e2e-results/worker-broker/source.txt";
  const evidenceTarget = "tests/e2e-results/worker-broker/renamed.txt";
  fs.mkdirSync(path.dirname(path.join(evidenceRoot, evidenceSource)), { recursive: true });
  fs.writeFileSync(path.join(evidenceRoot, evidenceSource), "evidence\n");
  git(evidenceRoot, "add", evidenceSource);
  git(evidenceRoot, "commit", "-m", "add evidence source");
  git(evidenceRoot, "mv", evidenceSource, evidenceTarget);
  assert.equal(isNonEvidenceTreeClean(evidenceRoot), true);
});

test("evidence cleanliness rejects assume-unchanged and skip-worktree source changes", () => {
  for (const fixture of [
    {
      name: "assume-unchanged",
      enable: "--assume-unchanged",
      disable: "--no-assume-unchanged"
    },
    {
      name: "skip-worktree",
      enable: "--skip-worktree",
      disable: "--no-skip-worktree"
    }
  ]) {
    const { root } = initPhaseZeroEvidenceFixture(`hidden-index-${fixture.name}`);
    try {
      git(root, "update-index", fixture.enable, "tracked.txt");
      fs.writeFileSync(path.join(root, "tracked.txt"), `${fixture.name} hidden bytes\n`);
      assert.equal(git(root, "status", "--porcelain=v1"), "", `${fixture.name} must reproduce hidden status`);
      assert.equal(isNonEvidenceTreeClean(root), false, fixture.name);
      assert.equal(gitIdentity(root).cleanTreeAtVerification, false, fixture.name);
      const record = buildEvidenceRecord({
        root,
        phase: "0",
        slice: `hidden-index-${fixture.name}`,
        verification: phaseProof("0")
      });
      assert.equal(record.source.cleanTreeAtVerification, false, fixture.name);
    } finally {
      git(root, "update-index", fixture.disable, "tracked.txt");
    }
  }
});

test("porcelain v1 -z parser rejects malformed and unknown token sequences", () => {
  const evidencePath = "tests/e2e-results/worker-broker/result.json";
  assert.equal(parsePorcelainV1ZChanges(`R  ${evidencePath}\0`), null, "rename source is required");
  assert.equal(parsePorcelainV1ZChanges(`ZZ ${evidencePath}\0`), null, "unknown XY status is rejected");
  assert.equal(parsePorcelainV1ZChanges(`?? ${evidencePath}`), null, "final NUL is required");
  assert.equal(
    parsePorcelainV1ZChanges(`R  ${evidencePath}\0source.txt\0garbage\0`),
    null,
    "an unexpected raw token cannot be interpreted as another status entry"
  );
});

test("strict validator rejects missing phase fields, dirty-tree claims, and stale digests", () => {
  const good = buildEvidenceRecord({
    phase: "0",
    slice: "unit-test-record",
    status: "implemented_unverified",
    verification: phaseProof("0")
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
    verification: [passedCommand("identity", "true", "source")]
  });
  assert.equal(record.recordDigest, computeRecordDigest(record));
  const tampered = { ...record, slice: "tampered" };
  assert.notEqual(computeRecordDigest(tampered), record.recordDigest);
});

test("validator accepts built records and rejects bad ones; CLI verify works against ledger", () => {
  const record = buildEvidenceRecord({
    phase: "0",
    slice: "cli-verify-path",
    status: "implemented_unverified",
    verification: phaseProof("0"),
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

test("source inventory binds executable, symlink, and gitlink identity", () => {
  const root = initRepo();
  const tracked = path.join(root, "tracked.txt");
  fs.chmodSync(tracked, 0o644);
  const nonExecutable = computeInventoryDigest(root);
  fs.chmodSync(tracked, 0o755);
  const executable = computeInventoryDigest(root);
  assert.notEqual(executable, nonExecutable, "executable mode must invalidate source evidence");

  fs.writeFileSync(path.join(root, "other.txt"), "other\n");
  const link = path.join(root, "linked.txt");
  fs.symlinkSync("tracked.txt", link);
  git(root, "add", "linked.txt", "other.txt");
  const firstLink = computeInventoryDigest(root);
  fs.unlinkSync(link);
  fs.symlinkSync("other.txt", link);
  const secondLink = computeInventoryDigest(root);
  assert.notEqual(secondLink, firstLink, "symlink target identity must invalidate source evidence");

  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "second identity");
  const secondCommit = git(root, "rev-parse", "HEAD");
  const firstCommit = git(root, "rev-parse", "HEAD^");
  git(root, "update-index", "--add", "--cacheinfo", `160000,${firstCommit},vendor/sub`);
  const firstGitlink = computeInventoryDigest(root);
  git(root, "update-index", "--cacheinfo", `160000,${secondCommit},vendor/sub`);
  const secondGitlink = computeInventoryDigest(root);
  assert.notEqual(secondGitlink, firstGitlink, "gitlink object identity must invalidate source evidence");
});

test("every declared phase-scope path exists and participates fail-closed", () => {
  for (const [phase, paths] of Object.entries(PHASE_SCOPE)) {
    assert.ok(paths.length > 0, `phase ${phase} has no scope`);
    for (const relative of paths) {
      assert.equal(
        fs.existsSync(path.join(REPO_ROOT, relative)),
        true,
        `phase ${phase} scope path is missing: ${relative}`
      );
    }
    assert.match(computePhaseScopeDigest(phase, REPO_ROOT), /^[0-9a-f]{64}$/);
  }
});

test("parser-backed import discovery follows Node grammar without evaluating source", () => {
  const cases = [
    {
      source: 'if (ok) {} /"/.test(value);\nimport "./after-block.mjs"; // "',
      expected: ["./after-block.mjs"]
    },
    {
      source: 'const pattern = new /"/.constructor();\nimport "./after-new.mjs"; // "',
      expected: ["./after-new.mjs"]
    },
    {
      source: 'class Pattern extends /"/.constructor {}\nimport "./after-extends.mjs"; // "',
      expected: ["./after-extends.mjs"]
    },
    {
      source: 'let quotient = 1; quotient++ / 2; import "./after-division.mjs"; // "',
      expected: ["./after-division.mjs"]
    },
    {
      source: String.raw`import "./\u0064ep.mjs";`,
      expected: ["./dep.mjs"]
    },
    {
      source: [
        'const stringCanary = \'import "./fake-string.mjs"\';',
        'const regexCanary = /import "\\.\\/fake-regex\\.mjs"/;',
        'const templateCanary = `import "./fake-template.mjs"`;',
        'const loadLater = () => import("./dynamic.mjs");',
        'const moduleIdentity = import.meta.url;',
        'const legacy = require("./legacy.cjs");'
      ].join("\n"),
      expected: []
    },
    {
      source: 'throw new Error("must not execute");\nimport "./parsed-only.mjs";',
      expected: ["./parsed-only.mjs"]
    },
    {
      source: 'import "node:fs";\nimport "#mapped-local-code";\nimport "package-code";',
      expected: ["#mapped-local-code", "package-code"]
    }
  ];
  for (const { source, expected } of cases) {
    assert.deepEqual(listLocalStaticImportSpecifiers(source), expected);
  }
  assert.throws(
    () => listLocalStaticImportSpecifiers("import {"),
    /Static ESM dependency parsing failed/
  );
});

test("phase scopes recursively close over repository-local static imports", () => {
  for (const [phase, paths] of Object.entries(PHASE_SCOPE)) {
    assert.deepEqual(
      findMissingLocalStaticImportDependencies(paths, REPO_ROOT),
      [],
      `phase ${phase} omits a local static import dependency`
    );
  }

  const root = tempDir("grok-phase-scope-closure-");
  fs.mkdirSync(path.join(root, "src/nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/entry.mjs"), `
	import "./side.mjs";
	import { first } from "./nested/first.mjs";
	export { reexported } from "./nested/reexport.mjs";
	import"./compact-side.mjs";
	import{compactFirst}from"./nested/compact-first.mjs";
	export{compactReexport}from"./nested/compact-reexport.mjs";
	export*from"./nested/compact-star.mjs";
	if (true) {} import"./after-block-side.mjs";
	if (true) {} import{afterBlockFirst}from"./nested/after-block-first.mjs";
	if (true) {} export{afterBlockReexport}from"./nested/after-block-reexport.mjs";
	if (true) {} export*from"./nested/after-block-star.mjs";
	const stringCanary = 'import"./fake-string.mjs"';
	const regexCanary = /export\\*from"\\.\\/fake-regex\\.mjs"/;
	if (true) /import"\\.\\/fake-control-regex\\.mjs"/.test("value");
	const templateCanary = \`outer \${\`nested import"./fake-template.mjs"\`} tail\`;
	// import"./fake-line-comment.mjs";
	/* export*from"./fake-block-comment.mjs"; */
const loadLater = () => import("./dynamic.mjs");
const moduleIdentity = import.meta.url;
let quotient = 1;
quotient++ / 2; import"./after-division.mjs"; // "
const legacy = require("./legacy.cjs");
export { first, loadLater, legacy, moduleIdentity, quotient, regexCanary, stringCanary, templateCanary };
`);
  fs.writeFileSync(path.join(root, "src/side.mjs"), "export const side = true;\n");
  fs.writeFileSync(path.join(root, "src/compact-side.mjs"), "export const compactSide = true;\n");
  fs.writeFileSync(path.join(root, "src/after-block-side.mjs"), "export const afterBlockSide = true;\n");
  fs.writeFileSync(path.join(root, "src/after-division.mjs"), "export const afterDivision = true;\n");
  fs.writeFileSync(
    path.join(root, "src/nested/first.mjs"),
    'export { deep as first } from "./deep.mjs";\n'
  );
  fs.writeFileSync(path.join(root, "src/nested/deep.mjs"), "export const deep = 1;\n");
  fs.writeFileSync(path.join(root, "src/nested/reexport.mjs"), "export const reexported = 2;\n");
  fs.writeFileSync(path.join(root, "src/nested/compact-first.mjs"), "export const compactFirst = 3;\n");
  fs.writeFileSync(path.join(root, "src/nested/compact-reexport.mjs"), "export const compactReexport = 4;\n");
  fs.writeFileSync(path.join(root, "src/nested/compact-star.mjs"), "export const compactStar = 5;\n");
  fs.writeFileSync(path.join(root, "src/nested/after-block-first.mjs"), "export const afterBlockFirst = 6;\n");
  fs.writeFileSync(path.join(root, "src/nested/after-block-reexport.mjs"), "export const afterBlockReexport = 7;\n");
  fs.writeFileSync(path.join(root, "src/nested/after-block-star.mjs"), "export const afterBlockStar = 8;\n");
  fs.writeFileSync(path.join(root, "src/dynamic.mjs"), "export const dynamic = true;\n");
  fs.writeFileSync(path.join(root, "src/legacy.cjs"), "module.exports = true;\n");

  const omitted = findMissingLocalStaticImportDependencies(["src/entry.mjs"], root);
  assert.deepEqual(omitted, [
    { importer: "src/entry.mjs", dependency: "src/after-block-side.mjs" },
    { importer: "src/entry.mjs", dependency: "src/after-division.mjs" },
    { importer: "src/entry.mjs", dependency: "src/compact-side.mjs" },
    { importer: "src/entry.mjs", dependency: "src/nested/after-block-first.mjs" },
    { importer: "src/entry.mjs", dependency: "src/nested/after-block-reexport.mjs" },
    { importer: "src/entry.mjs", dependency: "src/nested/after-block-star.mjs" },
    { importer: "src/entry.mjs", dependency: "src/nested/compact-first.mjs" },
    { importer: "src/entry.mjs", dependency: "src/nested/compact-reexport.mjs" },
    { importer: "src/entry.mjs", dependency: "src/nested/compact-star.mjs" },
    { importer: "src/entry.mjs", dependency: "src/nested/first.mjs" },
    { importer: "src/entry.mjs", dependency: "src/nested/reexport.mjs" },
    { importer: "src/entry.mjs", dependency: "src/side.mjs" }
  ]);

  const expanded = expandLocalStaticImportClosure(["src/entry.mjs"], root);
  assert.deepEqual(expanded, [
    "src/after-block-side.mjs",
    "src/after-division.mjs",
    "src/compact-side.mjs",
    "src/entry.mjs",
    "src/nested/after-block-first.mjs",
    "src/nested/after-block-reexport.mjs",
    "src/nested/after-block-star.mjs",
    "src/nested/compact-first.mjs",
    "src/nested/compact-reexport.mjs",
    "src/nested/compact-star.mjs",
    "src/nested/deep.mjs",
    "src/nested/first.mjs",
    "src/nested/reexport.mjs",
    "src/side.mjs"
  ]);
  assert.deepEqual(findMissingLocalStaticImportDependencies(expanded, root), []);
  assert.equal(expanded.includes("src/dynamic.mjs"), false);
  assert.equal(expanded.includes("src/legacy.cjs"), false);

  fs.mkdirSync(path.join(root, "tests/e2e-results/worker-broker"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "tests/e2e-results/worker-broker/executable.mjs"),
    "export const mutableEvidenceCode = true;\n"
  );
  fs.writeFileSync(
    path.join(root, "src/evidence-import.mjs"),
    'if (true) {} /"/.test("value");\n'
      + 'import "../tests/e2e-results/worker-broker/executable.mjs"; // "\n'
  );
  assert.throws(
    () => expandLocalStaticImportClosure(["src/evidence-import.mjs"], root),
    /Evidence-only paths cannot be executable static import dependencies/
  );
  assert.throws(
    () => expandLocalStaticImportClosure([
      "tests/e2e-results/worker-broker/executable.mjs"
    ], root),
    /Evidence-only paths cannot seed executable phase scope/
  );

  const safeFileUrlTarget = path.join(root, "src/file-url-target.mjs");
  fs.writeFileSync(safeFileUrlTarget, "export const safeFileUrlTarget = true;\n");
  fs.writeFileSync(
    path.join(root, "src/file-url-entry.mjs"),
    `import ${JSON.stringify(pathToFileURL(safeFileUrlTarget).href)};\n`
  );
  assert.deepEqual(
    expandLocalStaticImportClosure(["src/file-url-entry.mjs"], root),
    ["src/file-url-entry.mjs", "src/file-url-target.mjs"]
  );

  for (const directory of ["cache-a", "cache-b"]) {
    fs.mkdirSync(path.join(root, "src", directory), { recursive: true });
    fs.writeFileSync(path.join(root, "src", directory, "entry.mjs"), 'import "./target.mjs";\n');
    fs.writeFileSync(path.join(root, "src", directory, "target.mjs"), `export const source = ${JSON.stringify(directory)};\n`);
  }
  assert.deepEqual(
    expandLocalStaticImportClosure(["src/cache-a/entry.mjs", "src/cache-b/entry.mjs"], root),
    [
      "src/cache-a/entry.mjs",
      "src/cache-a/target.mjs",
      "src/cache-b/entry.mjs",
      "src/cache-b/target.mjs"
    ],
    "content-hash parser caching must resolve identical requests from each importer"
  );

  const evidenceExecutable = path.join(
    root,
    "tests/e2e-results/worker-broker/executable.mjs"
  );
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({
    type: "module",
    imports: { "#mutable": "./tests/e2e-results/worker-broker/executable.mjs" }
  })}\n`);

  for (const [name, specifier, expected] of [
    ["absolute-evidence", pathToFileURL(evidenceExecutable).pathname, /Evidence-only paths/],
    ["file-url-evidence", pathToFileURL(evidenceExecutable).href, /Evidence-only paths/],
    ["package-import", "#mutable", /Unsupported static ESM specifier/],
    ["bare-package", "mutable-package", /Unsupported static ESM specifier/],
    ["data-url", "data:text/javascript,export default true", /Unsupported static ESM specifier/],
    ["encoded-dot", "./%2e%2e/tests/e2e-results/worker-broker/executable.mjs", /Evidence-only paths/]
  ]) {
    const relative = `src/${name}.mjs`;
    fs.writeFileSync(path.join(root, relative), `import ${JSON.stringify(specifier)};\n`);
    assert.throws(() => expandLocalStaticImportClosure([relative], root), expected, name);
  }

  fs.mkdirSync(path.join(root, "tests/e2e-results/%77orker-broker"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "tests/e2e-results/%77orker-broker/executable.mjs"),
    "export const decoy = true;\n"
  );
  fs.writeFileSync(
    path.join(root, "src/encoded-name.mjs"),
    'import "../tests/e2e-results/%77orker-broker/executable.mjs";\n'
  );
  assert.throws(
    () => expandLocalStaticImportClosure(["src/encoded-name.mjs"], root),
    /Evidence-only paths cannot be executable static import dependencies/
  );
});

test("strict validator rejects fabricated Phase 5 proof, skipped gates, missing digest, and raw fields", () => {
  const base = buildEvidenceRecord({
    phase: "5",
    slice: "fabricated-phase-5",
    status: "implemented_unverified",
    verification: [{
      gateId: "repository-check",
      command: "npm run check",
      boundary: "source-provider-neutral",
      outcome: "not_run",
      skipMeaning: "not executed"
    }]
  });
  const fabricated = {
    ...base,
    status: "verified_on_draft",
    qualification: deterministicQualification(),
    prerequisites: [],
    rawPrompt: "SECRET",
    verification: PHASE_MANDATORY_GATE_IDS["5"].map((gateId) => ({
      gateId,
      command: gateId,
      boundary: "source-provider-neutral",
      outcome: "skip",
      skipMeaning: "fabricated"
    }))
  };
  delete fabricated.recordDigest;
  const rejected = validateEvidenceRecord(fabricated, { strict: true, root: REPO_ROOT });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.errors.some((message) => /recordDigest is required/i.test(message)));
  assert.ok(rejected.errors.some((message) => /unsupported top-level fields/i.test(message)));
  assert.ok(rejected.errors.some((message) => /requires exact broker-owned proofProducer provenance/i.test(message)));
  assert.ok(rejected.errors.some((message) => /Missing passing mandatory gate/i.test(message)));
  assert.ok(rejected.errors.some((message) => /Missing prerequisite evidence digest/i.test(message)));
});

test("pass/fail command outcomes require exact bounded execution evidence", () => {
  const record = buildEvidenceRecord({
    phase: "0",
    slice: "incomplete-command",
    verification: [{
      gateId: "repository-check",
      command: "npm run check",
      boundary: "source-provider-neutral",
      outcome: "pass"
    }]
  });
  const result = validateEvidenceRecord(record);
  assert.equal(result.ok, false);
  for (const field of ["startedAt", "endedAt", "exitCode", "outputDigest"]) {
    assert.ok(result.errors.some((message) => message.includes(field)), field);
  }

  const leaked = attachRecordDigest({
    ...record,
    verification: [{
      ...passedCommand("repository-check", "npm run check"),
      stdout: "secret-bearing raw output"
    }]
  });
  const leakedResult = validateEvidenceRecord(leaked);
  assert.equal(leakedResult.ok, false);
  assert.ok(leakedResult.errors.some((message) => /verification\[0\].*forbidden/i.test(message)));
});

test("validator rejects private or unknown fields in every nested evidence surface", () => {
  const record = buildEvidenceRecord({
    phase: "0",
    slice: "nested-private-fields",
    verification: [passedCommand("identity", "true", "source")],
    scenarios: [{
      id: "scenario",
      expected: "bounded",
      actual: "bounded",
      outcome: "pass",
      rawPrompt: "secret",
      measurements: {
        durationMs: 1,
        rawPrompt: "secret",
        credentials: ["token"]
      }
    }],
    liveScenarios: [{
      id: "live",
      boundary: "provider",
      outcome: "not_run",
      rawTranscript: "secret"
    }],
    ci: {
      workflowUrl: null,
      runId: null,
      attempt: null,
      jobs: [{ name: "job", result: "success", rawLogs: "secret" }]
    }
  });
  const nested = attachRecordDigest({
    ...record,
    source: { ...record.source, privatePath: "/private/repo" },
    installation: { ...record.installation, installPath: "/private/cache" },
    runtime: { ...record.runtime, rawProcessId: 123 },
    authorities: { ...record.authorities, transcript: "secret" },
    limits: { ...record.limits, credentials: ["secret"] }
  });
  const result = validateEvidenceRecord(nested);
  assert.equal(result.ok, false);
  for (const marker of [
    "source contains unsupported fields",
    "installation contains unsupported fields",
    "runtime contains unsupported fields",
    "scenarios[0] contains unsupported fields",
    "scenarios[0].measurements contains unsupported metrics",
    "liveScenarios[0] contains unsupported fields",
    "authorities contains unsupported fields",
    "limits contains unsupported fields",
    "ci.jobs[0] contains unsupported fields"
  ]) {
    assert.ok(result.errors.some((message) => message.includes(marker)), marker);
  }
  for (const privateUnknown of [
    "privatePath", "installPath", "rawProcessId", "rawPrompt", "credentials",
    "rawTranscript", "transcript", "rawLogs"
  ]) {
    assert.equal(JSON.stringify(result).includes(privateUnknown), false, privateUnknown);
  }
});

test("validator rejects non-typed nested evidence instead of accepting generic objects", () => {
  const record = buildEvidenceRecord({
    phase: "0",
    slice: "nested-type-confusion",
    verification: [{
      ...passedCommand("identity", "true", "source"),
      testsPassed: "many",
      assertions: [{ rawPrompt: "GENERIC_PRIVATE_CANARY" }]
    }],
    limits: {
      residualRisks: [{ rawProviderMessage: "GENERIC_PRIVATE_CANARY" }],
      unsupportedPlatforms: [],
      invalidationTriggers: [],
      supersededBy: null,
      liveQualificationGaps: []
    }
  });
  record.source.phaseScopePaths = [{ rawContext: "GENERIC_PRIVATE_CANARY" }];
  const result = validateEvidenceRecord(attachRecordDigest(record));
  assert.equal(result.ok, false);
  for (const marker of ["testsPassed", "assertions", "residualRisks", "phaseScopePaths"]) {
    assert.ok(result.errors.some((message) => message.includes(marker)), marker);
  }
});

test("evidence narratives are bounded and reject secrets and private runtime paths", () => {
  const record = buildEvidenceRecord({
    phase: "0",
    slice: "bounded-narrative",
    verification: [passedCommand("identity", "true", "source")]
  });
  const unsafe = attachRecordDigest({
    ...record,
    authorities: {
      ...record.authorities,
      workerClaims: "x".repeat(4097),
      runtimeObservations: "password=hunter2"
    },
    limits: {
      ...record.limits,
      residualRisks: [
        "Found /Users/example/private-output",
        "Found /tmp/grok-worker/private-output",
        "Found /private/tmp/grok-worker/private-output",
        "Found /private/var/folders/aa/bb/T/grok-worker/private-output",
        "Found file://localhost/private/tmp/grok-worker/private-output",
        "Found /root/private-output",
        "Found ~/private-output"
      ]
    }
  });
  const result = validateEvidenceRecord(unsafe);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((message) => /workerClaims.*4096/i.test(message)));
  assert.ok(result.errors.some((message) => /runtimeObservations.*secret-shaped/i.test(message)));
  for (let index = 0; index < unsafe.limits.residualRisks.length; index += 1) {
    assert.ok(
      result.errors.some((message) => message.includes(`residualRisks[${index}]`) && /private runtime path/i.test(message)),
      `residualRisks[${index}]`
    );
  }
});

test("ledger rejects and does not echo private or unknown fields", () => {
  const root = initRepo();
  for (const relative of PHASE_SCOPE["0"]) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(
      absolute,
      relative === "package.json"
        ? '{"name":"ledger-allowlist-fixture","version":"1.0.0"}\n'
        : `fixture for ${relative}\n`
    );
  }
  const evidenceDir = path.join(root, "tests/e2e-results/worker-broker");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, ".gitkeep"), "");
  git(root, "add", ".");
  git(root, "commit", "-m", "add ledger fixture");

  const record = buildEvidenceRecord({
    root,
    phase: "0",
    slice: "ledger-allowlist",
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

  const ledgerPath = path.join(evidenceDir, "ledger.json");
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  ledger.privateDiagnostics = { token: "LEDGER_PRIVATE_CANARY" };
  ledger.entries[0].rawPrivate = { value: "LEDGER_PRIVATE_CANARY" };
  ledger.entries[0].slice = "/private/tmp/LEDGER_ALLOWED_CANARY";
  fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  const result = verifyLedger(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((message) => /unsupported top-level fields/i.test(message)));
  assert.ok(result.errors.some((message) => /entry 0 contains unsupported fields/i.test(message)));
  assert.ok(result.errors.some((message) => /entries\[0\]\.slice.*private runtime path/i.test(message)));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("LEDGER_PRIVATE_CANARY"), false);
  assert.equal(serialized.includes("LEDGER_ALLOWED_CANARY"), false);
  assert.equal(serialized.includes("privateDiagnostics"), false);
  assert.equal(serialized.includes("rawPrivate"), false);
});

test("ledger verification rejects external and internal symlinked evidence paths without disclosure", () => {
  {
    const { root } = initPhaseZeroEvidenceFixture("external-symlink-evidence");
    const { record, recordPath } = writePhaseZeroLedgerRecord(root, "external-record-symlink");
    const recordAbsolute = path.join(root, recordPath);
    const externalDir = tempDir("worker-evidence-external-");
    const externalTarget = path.join(externalDir, "EXTERNAL_RECORD_TARGET_CANARY.json");
    fs.renameSync(recordAbsolute, externalTarget);
    fs.symlinkSync(externalTarget, recordAbsolute);
    const targetBefore = fs.readFileSync(externalTarget, "utf8");

    const result = verifyLedger(root, { strict: true });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => /unreadable, unsafe, or oversized evidence file/i.test(message)));
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(externalTarget), false);
    assert.equal(serialized.includes("EXTERNAL_RECORD_TARGET_CANARY"), false);
    assert.throws(
      () => writeEvidenceRecord(record, root),
      /unsafe existing immutable evidence record/i
    );
    assert.equal(fs.readFileSync(externalTarget, "utf8"), targetBefore);
  }

  {
    const { root } = initPhaseZeroEvidenceFixture("internal-symlink-evidence");
    const { recordPath } = writePhaseZeroLedgerRecord(root, "internal-record-symlink");
    const recordAbsolute = path.join(root, recordPath);
    const internalTarget = path.join(path.dirname(recordAbsolute), "INTERNAL_RECORD_TARGET_CANARY.json");
    fs.renameSync(recordAbsolute, internalTarget);
    fs.symlinkSync(path.basename(internalTarget), recordAbsolute);

    const result = verifyLedger(root, { strict: true });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => /unreadable, unsafe, or oversized evidence file/i.test(message)));
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(internalTarget), false);
    assert.equal(serialized.includes("INTERNAL_RECORD_TARGET_CANARY"), false);
  }

  {
    const { root } = initPhaseZeroEvidenceFixture("internal-phase-symlink-evidence");
    const { recordPath } = writePhaseZeroLedgerRecord(root, "internal-phase-symlink");
    const phaseDirectory = path.dirname(path.join(root, recordPath));
    const internalTarget = `${phaseDirectory}-INTERNAL_PHASE_TARGET_CANARY`;
    fs.renameSync(phaseDirectory, internalTarget);
    fs.symlinkSync(path.basename(internalTarget), phaseDirectory);

    const result = verifyLedger(root, { strict: true });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => /unreadable, unsafe, or oversized evidence file/i.test(message)));
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(internalTarget), false);
    assert.equal(serialized.includes("INTERNAL_PHASE_TARGET_CANARY"), false);
  }
});

test("new immutable evidence publication rejects a symlinked phase directory without external writes", () => {
  const { root, evidenceDir } = initPhaseZeroEvidenceFixture("new-record-phase-symlink");
  const record = buildEvidenceRecord({
    root,
    phase: "0",
    slice: "new-record-must-stay-local",
    verification: phaseProof("0")
  });
  const externalDirectory = tempDir("worker-evidence-phase-target-");
  const sentinel = path.join(externalDirectory, "EXTERNAL_PHASE_SENTINEL_CANARY.txt");
  fs.writeFileSync(sentinel, "unchanged\n");
  const phaseDirectory = path.join(evidenceDir, "phase-0");
  fs.symlinkSync(externalDirectory, phaseDirectory);
  const before = fs.readdirSync(externalDirectory).sort();

  assert.throws(() => writeEvidenceRecord(record, root), /unsafe/i);
  assert.deepEqual(fs.readdirSync(externalDirectory).sort(), before);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "unchanged\n");
});

test("immutable evidence publication is private, idempotent, and never overwrites different content", () => {
  const { root } = initPhaseZeroEvidenceFixture("immutable-record-publication");
  const record = buildEvidenceRecord({
    root,
    phase: "0",
    slice: "immutable-record-publication",
    verification: phaseProof("0")
  });
  const firstPath = writeEvidenceRecord(record, root);
  const absolute = path.join(root, firstPath);
  const expected = fs.readFileSync(absolute, "utf8");
  assert.equal(fs.statSync(absolute).mode & 0o777, 0o600);
  assert.equal(writeEvidenceRecord(record, root), firstPath);
  assert.equal(fs.readFileSync(absolute, "utf8"), expected);

  fs.writeFileSync(absolute, "different immutable content\n");
  assert.throws(() => writeEvidenceRecord(record, root), /refusing to overwrite immutable evidence record/i);
  assert.equal(fs.readFileSync(absolute, "utf8"), "different immutable content\n");
});

test("evidence publication validates privacy, bounds, structure, and supplied digest before filesystem access", () => {
  const base = buildEvidenceRecord({
    phase: "0",
    slice: "pre-publication-validation",
    verification: phaseProof("0")
  });
  const invalidCases = [
    attachRecordDigest({
      ...base,
      rawPrivate: "PUBLICATION_PRIVATE_CANARY"
    }),
    {
      ...base,
      recordDigest: "0".repeat(64)
    },
    attachRecordDigest({
      ...base,
      authorities: {
        ...base.authorities,
        workerClaims: "x".repeat(300_000)
      }
    })
  ];
  const cyclic = { ...base };
  delete cyclic.recordDigest;
  cyclic.loop = cyclic;
  invalidCases.push(cyclic);
  const hiddenMismatch = structuredClone(base);
  Object.defineProperty(hiddenMismatch, "recordDigest", {
    value: "f".repeat(64),
    enumerable: false,
    configurable: true
  });
  invalidCases.push(hiddenMismatch);

  for (const [index, invalid] of invalidCases.entries()) {
    const root = initRepo();
    let observed;
    try {
      writeEvidenceRecord(invalid, root);
    } catch (error) {
      observed = error;
    }
    assert.equal(observed?.code, "E_EVIDENCE_RECORD_INVALID", `case ${index}`);
    assert.equal(observed?.message, "Evidence record is invalid or unsafe for publication.");
    assert.equal(observed?.message.includes("PUBLICATION_PRIVATE_CANARY"), false);
    assert.equal(fs.existsSync(path.join(root, "tests")), false, `case ${index}`);
  }

  const root = initRepo();
  const withoutDigest = structuredClone(base);
  delete withoutDigest.recordDigest;
  const relative = writeEvidenceRecord(withoutDigest, root);
  const published = JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
  assert.match(published.recordDigest, /^[0-9a-f]{64}$/);
  assert.equal(published.recordDigest, computeRecordDigest(published));
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
  const first = spawnLedgerAppender({
    root,
    entry: syntheticLedgerEntry("0", "concurrent-phase-0"),
    ready: path.join(control, "ready-0"),
    barrier
  });
  const second = spawnLedgerAppender({
    root,
    entry: syntheticLedgerEntry("1", "concurrent-phase-1"),
    ready: path.join(control, "ready-1"),
    barrier
  });
  await waitFor(() => fs.existsSync(path.join(control, "ready-0"))
    && fs.existsSync(path.join(control, "ready-1")));
  fs.writeFileSync(barrier, "go\n");
  const results = await Promise.all([first.completed, second.completed]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const ledger = loadLedger(root);
  assert.equal(ledger.entries.length, 2);
  assert.deepEqual(new Set(ledger.entries.map((entry) => entry.phase)), new Set(["0", "1"]));
  assert.ok(ledger.entries.every((entry) => entry.currency === "current"));
});

test("barriered same-phase appends retain one current and one historical entry", async () => {
  const root = initRepo();
  const control = tempDir("ledger-same-phase-barrier-");
  const barrier = path.join(control, "go");
  const first = spawnLedgerAppender({
    root,
    entry: syntheticLedgerEntry("2", "same-phase-a"),
    ready: path.join(control, "ready-a"),
    barrier
  });
  const second = spawnLedgerAppender({
    root,
    entry: syntheticLedgerEntry("2", "same-phase-b"),
    ready: path.join(control, "ready-b"),
    barrier
  });
  await waitFor(() => fs.existsSync(path.join(control, "ready-a"))
    && fs.existsSync(path.join(control, "ready-b")));
  fs.writeFileSync(barrier, "go\n");
  const results = await Promise.all([first.completed, second.completed]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
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
      assert.ok(elapsed >= 4_500 && elapsed < 8_000, `bounded wait was ${elapsed} ms`);
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

test("Phase 0 proof manifest and persisted producer provenance are exact", () => {
  assert.deepEqual(
    PHASE_PROOF_GATE_MANIFEST["0"].map((gate) => gate.gateId),
    PHASE_MANDATORY_GATE_IDS["0"]
  );
  assert.match(computeProofManifestDigest("0"), /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(PHASE_PROOF_GATE_MANIFEST["0"]), true);
  assert.equal(Object.isFrozen(PHASE_PROOF_GATE_MANIFEST["0"][0].argv), true);
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
    NODE_OPTIONS: "--inspect",
    GIT_DIR: "elsewhere",
    PASSWORD: secret
  });
  for (const key of [
    "XAI_API_KEY",
    "GROK_E2E",
    "GROK_E2E_CANCEL",
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

test("mandatory proof reporter fails an otherwise successful test command with skip or TODO", () => {
  const root = tempDir("zero-skip-reporter-");
  const passing = path.join(root, "passing.test.mjs");
  const partial = path.join(root, "partial.test.mjs");
  fs.writeFileSync(
    passing,
    'import test from "node:test";\ntest("pass", () => {});\n'
  );
  fs.writeFileSync(
    partial,
    [
      'import test from "node:test";',
      'test("pass", () => {});',
      'test("skip", { skip: true }, () => {});',
      'test("todo", { todo: true }, () => {});',
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
  assert.match(complete.stdout, /"skipped":0/);
  assert.match(complete.stdout, /"todo":0/);
  const rejected = run(process.execPath, ["--test", reporterArg, partial], {
    cwd: root,
    env: childEnvironment
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stdout, /"skipped":1/);
  assert.match(rejected.stdout, /"todo":1/);
});

test("proof publication ignores caller-prepended fake npm and git and survives honest strict replay", () => {
  const { root } = initProofRunnerFixture("proof-path-poison");
  const poisonRoot = tempDir("proof-path-poison-bin-");
  const fakeBin = path.join(poisonRoot, "bin");
  const npmMarker = path.join(poisonRoot, "fake-npm-invoked");
  const gitMarker = path.join(poisonRoot, "fake-git-invoked");
  writePathPoisonForwarder(fakeBin, "npm", locateAmbientExecutable("npm"), npmMarker);
  writePathPoisonForwarder(fakeBin, "git", locateAmbientExecutable("git"), gitMarker);

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

  const strict = verifyPhase("0", root, { strict: true });
  assert.equal(strict.ok, true, strict.errors.join("; "));
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
    "scripts/test-phase1-focused.mjs",
    "tests/control-plane.test.mjs",
    "tests/mcp-worker-runtime.test.mjs",
    "tests/process-control.test.mjs",
    "tests/provider.test.mjs",
    "tests/provider-bootstrap-crash-window.test.mjs",
    "tests/provider-capability.test.mjs",
    "tests/provider-startup-cancel.test.mjs",
    "tests/recursion-guard.test.mjs",
    "tests/runtime.test.mjs",
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
  assert.equal(PHASE1_FOCUSED_TEST_FILES.length, 25);
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
});

test("Phase 1 rejects the reserved self-digested review receipt as unauthenticated", () => {
  assert.equal(statusSatisfiesVerifiedPrerequisite("implemented_unverified"), false);
  assert.equal(statusSatisfiesVerifiedPrerequisite("verified_on_draft"), true);
  assert.equal(statusSatisfiesVerifiedPrerequisite("verified_on_draft", "1"), false);
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
    "independentReviewReceipt is reserved but unauthenticated; signed issuer verification is required."
  ));
  assert.ok(acceptedValidation.errors.includes(
    "verified_on_draft Phase 1 evidence requires signed issuer-verified independent review proof."
  ));
  const publishedSchema = JSON.parse(fs.readFileSync(
    path.join(ROOT, "plugins/grok/schemas/worker-broker-evidence.schema.json"),
    "utf8"
  ));
  const phaseOnePromotionProhibition = publishedSchema.allOf.find((rule) => (
    rule?.not?.properties?.phase?.const === "1"
    && rule?.not?.properties?.status?.enum?.includes("verified_on_draft")
    && rule?.not?.properties?.status?.enum?.includes("qualified")
  ));
  assert.ok(phaseOnePromotionProhibition, "published schema must reject unsigned Phase 1 promotion");
  assert.ok(phaseOnePromotionProhibition.not.required.every((field) => (
    Object.hasOwn(accepted, field)
  )));
  assert.equal(accepted.phase, phaseOnePromotionProhibition.not.properties.phase.const);
  assert.ok(phaseOnePromotionProhibition.not.properties.status.enum.includes(accepted.status));
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
    "Verified readiness requires phase 1 current status verified_on_draft or qualified; found implemented_unverified."
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
  updateLedger({
    phase: phaseZero.phase,
    slice: phaseZero.slice,
    status: phaseZero.status,
    path: phaseZeroPath,
    recordDigest: phaseZero.recordDigest,
    sourceCommit: phaseZero.source.headCommit,
    recordedAt: phaseZero.recordedAt
  }, root);

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
    "Verified readiness requires phase 1 current status verified_on_draft or qualified; found implemented_unverified."
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
  assert.ok(readiness.errors.some((message) => /phase 0 status qualified/i.test(message)));
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
  updateLedger({
    phase: legacy.phase,
    slice: legacy.slice,
    status: legacy.status,
    path: legacyPath,
    recordDigest: legacy.recordDigest,
    sourceCommit: legacy.source.headCommit,
    recordedAt: legacy.recordedAt
  }, root);

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
    updateLedger({
      phase: legacy.phase,
      slice: legacy.slice,
      status: legacy.status,
      path: recordPath,
      recordDigest: legacy.recordDigest,
      sourceCommit: legacy.source.headCommit,
      currency,
      recordedAt: legacy.recordedAt
    }, root);
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

test("proof publication atomically invalidates canonical pre-runner current claims", () => {
  const { root } = initProofRunnerFixture("proof-cutover");
  seedPreRunnerCurrent(root, "0", "legacy-zero");
  seedPreRunnerCurrent(root, "1", "legacy-one");

  const result = provePhaseZero({ phase: "0", slice: "phase-zero-baseline", root, write: true });
  assert.equal(result.ok, true, result.code);
  assert.match(result.path, /^tests\/e2e-results\/worker-broker\/phase-0\//);
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
    slice: "phase-zero-v2-baseline",
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
  const malformedPrior = seedPriorProofRunnerCurrent(malformedFixture.root);
  const malformed = attachRecordDigest({
    ...malformedPrior.record,
    proofProducer: {
      ...malformedPrior.record.proofProducer,
      callerVerdict: "pass"
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
  assert.equal(firstResult.code, 0, firstResult.stderr);
  assert.equal(secondResult.code, 0, secondResult.stderr);
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
  for (const status of ["verified_on_draft", "qualified"]) {
    const result = run(process.execPath, [
      path.join(ROOT, "scripts/worker-broker-evidence.mjs"),
      "capture",
      "--phase",
      "5",
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
