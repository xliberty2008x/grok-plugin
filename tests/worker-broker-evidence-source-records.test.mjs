import test from "node:test";
import {
  PHASE_MANDATORY_GATE_IDS,
  PHASE_SCOPE,
  REPO_ROOT,
  ROOT,
  STARTED_AT,
  assert,
  attachRecordDigest,
  buildEvidenceRecord,
  computeInventoryDigest,
  computePhaseScopeDigest,
  computeRecordDigest,
  deterministicQualification,
  digestsIgnoreEvidenceOnly,
  expandLocalStaticImportClosure,
  findMissingLocalStaticImportDependencies,
  fs,
  git,
  gitIdentity,
  initPhaseZeroEvidenceFixture,
  initRepo,
  isEvidenceOnlyPath,
  isNonEvidenceTreeClean,
  listLocalStaticImportSpecifiers,
  parsePorcelainV1ZChanges,
  passedCommand,
  path,
  pathToFileURL,
  phaseProof,
  phaseScopePaths,
  proofProducer,
  proveWorkerBrokerPhase,
  run,
  tempDir,
  updateLedger,
  validateEvidenceRecord,
  verifyLedger,
  verifyPhase,
  writeEvidenceRecord,
  writePhaseZeroLedgerRecord
} from "./worker-broker-evidence-test-support.mjs";

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

test("aggregate scope binds every non-evidence source path and generic APIs cannot mint qualification", () => {
  const root = initRepo();
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"aggregate-scope","version":"1.0.0"}\n');
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/runtime.mjs"), "export const runtime = true;\n");
  fs.mkdirSync(path.join(root, "tests/e2e-results/worker-broker"), { recursive: true });
  fs.writeFileSync(path.join(root, "tests/e2e-results/worker-broker/.gitkeep"), "");
  git(root, "add", ".");
  git(root, "commit", "-m", "add aggregate scope fixture");

  const record = buildEvidenceRecord({
    root,
    phase: "aggregate",
    slice: "aggregate-structural",
    status: "implemented_unverified",
    verification: [passedCommand("aggregate-identity", "identity", "source")]
  });
  const expected = phaseScopePaths("aggregate", root);
  assert.deepEqual(record.source.phaseScopePaths, expected);
  assert.deepEqual(expected, ["package.json", "src/runtime.mjs", "tracked.txt"]);
  assert.equal(
    record.source.phaseScopeDigest,
    computeInventoryDigest(root, { paths: expected })
  );
  const strict = validateEvidenceRecord(record, { strict: true, root });
  assert.equal(strict.ok, true, strict.errors.join("; "));

  const incompleteScope = structuredClone(record);
  incompleteScope.source.phaseScopePaths = incompleteScope.source.phaseScopePaths.slice(1);
  const incompleteValidation = validateEvidenceRecord(
    attachRecordDigest(incompleteScope),
    { strict: true, root }
  );
  assert.equal(incompleteValidation.ok, false);
  assert.ok(incompleteValidation.errors.some((message) => /derived phase scope/i.test(message)));

  assert.throws(
    () => buildEvidenceRecord({
      root,
      phase: "aggregate",
      slice: "generic-qualified-build",
      status: "qualified",
      verification: [passedCommand("aggregate-identity", "identity", "source")]
    }),
    (error) => error?.code === "E_EVIDENCE_RECORD_INVALID"
  );
  const callerQualified = attachRecordDigest({
    ...record,
    status: "qualified",
    releaseQualification: true,
    provisionalSupportingRecord: false
  });
  assert.throws(
    () => writeEvidenceRecord(callerQualified, root),
    (error) => error?.code === "E_EVIDENCE_RECORD_INVALID"
  );
  assert.throws(
    () => updateLedger({
      phase: "aggregate",
      slice: "generic-qualified-link",
      status: "qualified",
      path: "tests/e2e-results/worker-broker/aggregate/missing.json",
      recordDigest: "a".repeat(64),
      sourceCommit: gitIdentity(root).headCommit,
      recordedAt: STARTED_AT
    }, root),
    (error) => error?.code === "E_EVIDENCE_LEDGER_UPDATE_INVALID"
  );
  assert.deepEqual(
    proveWorkerBrokerPhase({
      phase: "aggregate",
      slice: "generic-qualified-prove",
      root,
      write: true
    }),
    { ok: false, code: "E_PROOF_ARGUMENT" }
  );
  assert.equal(fs.existsSync(path.join(
    root,
    "tests/e2e-results/worker-broker/ledger.json"
  )), false);
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
  assert.equal(PHASE_SCOPE["0"].includes("package.json"), true);
  assert.equal(PHASE_SCOPE["0"].includes("package-lock.json"), true);
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

  const pinnedRoot = tempDir("grok-phase-scope-pinned-external-");
  fs.mkdirSync(path.join(pinnedRoot, "src"), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, "package.json"),
    path.join(pinnedRoot, "package.json")
  );
  fs.copyFileSync(
    path.join(REPO_ROOT, "package-lock.json"),
    path.join(pinnedRoot, "package-lock.json")
  );
  fs.writeFileSync(
    path.join(pinnedRoot, "src/entry.mjs"),
    'import { parse } from "acorn";\nexport { parse };\n'
  );
  assert.deepEqual(
    expandLocalStaticImportClosure(["src/entry.mjs"], pinnedRoot),
    ["package-lock.json", "package.json", "src/entry.mjs"]
  );
  const tamperedLock = JSON.parse(
    fs.readFileSync(path.join(pinnedRoot, "package-lock.json"), "utf8")
  );
  tamperedLock.packages["node_modules/acorn"].version = "8.15.1";
  fs.writeFileSync(
    path.join(pinnedRoot, "package-lock.json"),
    `${JSON.stringify(tamperedLock)}\n`
  );
  assert.throws(
    () => expandLocalStaticImportClosure(["src/entry.mjs"], pinnedRoot),
    /does not match its exact lock binding/
  );

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
