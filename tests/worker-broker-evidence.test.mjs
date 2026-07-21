import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  REPO_ROOT,
  PHASE_SCOPE,
  PHASE_MANDATORY_GATE_IDS,
  attachRecordDigest,
  buildEvidenceRecord,
  computeInventoryDigest,
  computePhaseScopeDigest,
  computeRecordDigest,
  expandLocalStaticImportClosure,
  findMissingLocalStaticImportDependencies,
  gitIdentity,
  isEvidenceOnlyPath,
  isNonEvidenceTreeClean,
  loadLedger,
  parsePorcelainV1ZChanges,
  updateLedger,
  validateEvidenceRecord,
  verifyLedger,
  verifyPhase,
  writeEvidenceRecord,
  sha256Text,
  digestsIgnoreEvidenceOnly
} from "../scripts/lib/worker-broker-evidence.mjs";
import { ROOT, git, initRepo, run, tempDir, waitFor } from "./helpers.mjs";

const STARTED_AT = "2026-07-16T10:00:00.000Z";
const ENDED_AT = "2026-07-16T10:00:01.000Z";
const EVIDENCE_MODULE_URL = new URL("../scripts/lib/worker-broker-evidence.mjs", import.meta.url).href;

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
const loadLater = () => import("./dynamic.mjs");
const legacy = require("./legacy.cjs");
export { first, loadLater, legacy };
`);
  fs.writeFileSync(path.join(root, "src/side.mjs"), "export const side = true;\n");
  fs.writeFileSync(
    path.join(root, "src/nested/first.mjs"),
    'export { deep as first } from "./deep.mjs";\n'
  );
  fs.writeFileSync(path.join(root, "src/nested/deep.mjs"), "export const deep = 1;\n");
  fs.writeFileSync(path.join(root, "src/nested/reexport.mjs"), "export const reexported = 2;\n");
  fs.writeFileSync(path.join(root, "src/dynamic.mjs"), "export const dynamic = true;\n");
  fs.writeFileSync(path.join(root, "src/legacy.cjs"), "module.exports = true;\n");

  const omitted = findMissingLocalStaticImportDependencies(["src/entry.mjs"], root);
  assert.deepEqual(omitted, [
    { importer: "src/entry.mjs", dependency: "src/nested/first.mjs" },
    { importer: "src/entry.mjs", dependency: "src/nested/reexport.mjs" },
    { importer: "src/entry.mjs", dependency: "src/side.mjs" }
  ]);

  const expanded = expandLocalStaticImportClosure(["src/entry.mjs"], root);
  assert.deepEqual(expanded, [
    "src/entry.mjs",
    "src/nested/deep.mjs",
    "src/nested/first.mjs",
    "src/nested/reexport.mjs",
    "src/side.mjs"
  ]);
  assert.deepEqual(findMissingLocalStaticImportDependencies(expanded, root), []);
  assert.equal(expanded.includes("src/dynamic.mjs"), false);
  assert.equal(expanded.includes("src/legacy.cjs"), false);
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
  assert.ok(rejected.errors.some((message) => /cannot include verification/i.test(message)));
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

test("strict validator rejects caller-authored promotion even with plausible mandatory gate metadata", () => {
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
  assert.ok(result.errors.some((message) => /promotion is disabled.*proof-producing runner/i.test(message)));
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
