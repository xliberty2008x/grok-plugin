import test from "node:test";
import {
  DETERMINISTIC_AGGREGATE_TEST_FILES,
  EXTERNAL_BOUNDARY_TESTS,
  PHASE1_FOCUSED_TEST_FILES,
  PHASE3_FOCUSED_TEST_FILES,
  ROOT,
  SHORT_ABSOLUTE_PATH_NAMES,
  TEST_TEMP_SUPERVISOR,
  ZERO_SKIP_MAX_SUMMARY_BYTES,
  ZERO_SKIP_MAX_VIOLATIONS,
  ZERO_SKIP_REPORTER,
  ZERO_SKIP_REPORTER_ID,
  ZERO_SKIP_SUMMARY_FIELDS,
  ZERO_SKIP_VIOLATION_FIELDS,
  assert,
  collectZeroSkipKnownSecrets,
  collectZeroSkipReport,
  fs,
  listDeterministicTestFiles,
  os,
  path,
  run,
  runDeterministicTestFiles,
  runPhaseOneFocusedTests,
  runPhaseThreeFocusedTests,
  sanitizeZeroSkipFile,
  sanitizeZeroSkipName,
  spawn,
  validateZeroSkipSummary,
  zeroSkipSummary,
  zeroSkipViolation
} from "./worker-broker-evidence-test-support.mjs";

test("deterministic zero-skip runner excludes only explicit external boundaries", () => {
  assert.deepEqual(EXTERNAL_BOUNDARY_TESTS, [
    "installed-codex.test.mjs",
    "live-grok.test.mjs",
    "worker-broker-protected-review.test.mjs"
  ]);
  const all = fs.readdirSync(path.join(ROOT, "tests"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => `tests/${entry.name}`)
    .sort();
  const expected = all.filter((relative) => (
    !EXTERNAL_BOUNDARY_TESTS.includes(path.basename(relative))
    && !DETERMINISTIC_AGGREGATE_TEST_FILES.includes(relative)
  ));
  expected.sort();
  assert.deepEqual(listDeterministicTestFiles(), expected);
});

test("deterministic runner executes files sequentially and aggregates exact zero-skip summaries", () => {
  const calls = [];
  const timeline = [];
  let output = "";
  let diagnostic = "";
  const files = ["tests/first.test.mjs", "tests/second.test.mjs"];
  const times = [100, 125, 200, 250];
  const status = runDeterministicTestFiles({
    files,
    root: "/exact/root",
    reporter: "/exact/reporter.mjs",
    node: "/exact/node",
    env: { PROOF_ENV: "fixed" },
    run(binary, args, options) {
      timeline.push(`run-${calls.length + 1}`);
      calls.push({ binary, args, options });
      return {
        status: 0,
        signal: null,
        stdout: zeroSkipSummary({ passed: calls.length }),
        stderr: ""
      };
    },
    now() {
      return times.shift();
    },
    stdout: { write(value) { output += value; } },
    stderr: { write(value) {
      diagnostic += value;
      timeline.push(value);
    } }
  });
  assert.equal(status, 0);
  assert.equal(
    diagnostic,
    [
      "Deterministic test child 1 started.",
      "Deterministic test child 1 completed in 25 ms.",
      "Deterministic test child 2 started.",
      "Deterministic test child 2 completed in 50 ms.",
      ""
    ].join("\n")
  );
  assert.deepEqual(timeline, [
    "Deterministic test child 1 started.\n",
    "run-1",
    "Deterministic test child 1 completed in 25 ms.\n",
    "Deterministic test child 2 started.\n",
    "run-2",
    "Deterministic test child 2 completed in 50 ms.\n"
  ]);
  assert.deepEqual(calls.map((call) => call.args), files.map((file) => [
    TEST_TEMP_SUPERVISOR,
    "--timeout-ms",
    "600000",
    "--",
    "/exact/node",
    "--test",
    "--test-reporter=/exact/reporter.mjs",
    file
  ]));
  assert.ok(calls.every((call) => call.binary === "/exact/node"));
  assert.ok(calls.every((call) => call.options.cwd === "/exact/root"));
  assert.ok(calls.every((call) => call.options.shell === false));
  assert.ok(calls.every((call) => call.options.timeout === 630000));
  assert.ok(calls.every((call) => call.options.killSignal === "SIGKILL"));
  assert.ok(calls.every((call) => call.options.maxBuffer === 1024 * 1024));
  assert.ok(calls.every((call) => call.options.env.TMPDIR === call.options.env.TMP));
  assert.ok(calls.every((call) => call.options.env.TMPDIR === call.options.env.TEMP));
  assert.deepEqual(JSON.parse(output), {
    reporter: ZERO_SKIP_REPORTER_ID,
    passed: 3,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    violations: [],
    omittedViolations: 0
  });
});

test("deterministic runner can execute the fixed evidence compatibility aggregate directly", () => {
  const calls = [];
  const files = DETERMINISTIC_AGGREGATE_TEST_FILES;
  assert.deepEqual(files, ["tests/worker-broker-evidence.test.mjs"]);
  const status = runDeterministicTestFiles({
    files,
    root: ROOT,
    reporter: ZERO_SKIP_REPORTER,
    run(binary, args, options) {
      calls.push({ binary, args, options });
      return {
        status: 0,
        signal: null,
        stdout: zeroSkipSummary(),
        stderr: ""
      };
    },
    stdout: { write() {} },
    stderr: { write() {} }
  });
  assert.equal(status, 0);
  assert.deepEqual(calls.map((call) => call.args.at(-1)), files);
  assert.ok(calls.every((call) => call.options.env.TMPDIR));
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
    reporter: ZERO_SKIP_REPORTER_ID,
    passed: PHASE1_FOCUSED_TEST_FILES.length,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    violations: [],
    omittedViolations: 0
  });
});

test("Phase 3 focused runner is fixed, serial, and fails closed on TODO", () => {
  const calls = [];
  let output = "";
  let diagnostic = "";
  const status = runPhaseThreeFocusedTests({
    run(_binary, args) {
      calls.push(args.at(-1));
      if (calls.length === 1) {
        return {
          status: 1,
          signal: null,
          stdout: zeroSkipSummary({
            passed: 0,
            todo: 1,
            violations: [zeroSkipViolation({ outcome: "todo" })]
          }),
          stderr: ""
        };
      }
      return { status: 0, signal: null, stdout: zeroSkipSummary(), stderr: "" };
    },
    stdout: { write(value) { output += value; } },
    stderr: { write(value) { diagnostic += value; } }
  });
  assert.equal(status, 1);
  assert.deepEqual(calls, PHASE3_FOCUSED_TEST_FILES);
  assert.equal(new Set(calls).size, PHASE3_FOCUSED_TEST_FILES.length);
  assert.match(diagnostic, /child 1 failed its zero-skip gate/i);
  const summary = JSON.parse(output);
  assert.equal(summary.todo, 1);
  assert.equal(summary.skipped, 0);
});

test("deterministic runner fails closed on malformed, partial, or non-passing child results", (t) => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runner-failures-")));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
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
      label: "legacy-summary",
      result: {
        status: 0,
        signal: null,
        stdout: zeroSkipSummary().replace(ZERO_SKIP_REPORTER_ID, "zero-skip-v1"),
        stderr: ""
      },
      message: /invalid zero-skip summary/
    },
    {
      label: "skip",
      result: {
        status: 1,
        signal: null,
        stdout: zeroSkipSummary({
          passed: 0,
          skipped: 1,
          violations: [zeroSkipViolation({ outcome: "skipped" })]
        }),
        stderr: ""
      },
      message: /failed its zero-skip gate/
    },
    {
      label: "empty-test-file",
      result: { status: 0, signal: null, stdout: zeroSkipSummary({ passed: 0 }), stderr: "" },
      message: /failed its zero-skip gate/
    },
    {
      label: "output-limit",
      result: { status: 125, signal: null, stdout: "", stderr: "" },
      message: /exceeded the output limit/
    },
    {
      label: "signal",
      result: { status: null, signal: "SIGTERM", stdout: "", stderr: "" },
      message: /containment could not be proven/
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
      tempRoot,
      run: () => fixture.result,
      stdout: { write(value) { output += value; } },
      stderr: { write(value) { diagnostic += value; } }
    });
    assert.equal(status, 1, fixture.label);
    assert.match(diagnostic, fixture.message, fixture.label);
    assert.equal(JSON.parse(output).reporter, ZERO_SKIP_REPORTER_ID, fixture.label);
  }

  let diagnostic = "";
  assert.equal(runDeterministicTestFiles({
    files: [],
    stdout: { write() {} },
    stderr: { write(value) { diagnostic += value; } }
  }), 1);
  assert.match(diagnostic, /No deterministic test files/);
});

test("zero-skip v2 classifies Node 18 events exclusively and never reads forbidden error fields", async () => {
  const forbiddenSecret = "xai-FORBIDDENREPORTER000000";
  let getterExecutions = 0;
  const accessorEvent = {};
  Object.defineProperty(accessorEvent, "type", {
    get() {
      getterExecutions += 1;
      return "test:fail";
    }
  });
  const directFailure = {
    name: "AssertionError",
    code: "ERR_ASSERTION",
    operator: "strictEqual",
    failureType: "testCodeFailure"
  };
  for (const field of ["message", "stack", "cause", "actual", "expected"]) {
    Object.defineProperty(directFailure, field, {
      configurable: true,
      get() {
        throw new Error(`${field}-${forbiddenSecret}`);
      }
    });
  }
  const testFile = path.join(ROOT, "tests/reporter-node18.test.mjs");
  const { exitCode, summary } = await collectZeroSkipReport([
    {
      type: "test:pass",
      data: { file: testFile, name: "passing test", nesting: 0, testNumber: 1 }
    },
    {
      type: "test:pass",
      data: {
        file: testFile,
        name: "skipped test",
        nesting: 0,
        testNumber: 2,
        skip: forbiddenSecret
      }
    },
    {
      type: "test:fail",
      data: {
        file: testFile,
        name: "todo test",
        nesting: 0,
        testNumber: 3,
        todo: true,
        details: { error: directFailure }
      }
    },
    {
      type: "test:fail",
      data: {
        file: testFile,
        name: "cancelled child",
        nesting: 1,
        testNumber: 1,
        details: { error: { failureType: "cancelledByParent", name: "Error", code: "ERR_TEST_FAILURE" } }
      }
    },
    {
      type: "test:fail",
      data: {
        file: testFile,
        name: "details type is not cancellation",
        nesting: 0,
        testNumber: 4,
        details: { type: "cancelledByParent", error: directFailure }
      }
    },
    {
      type: "test:fail",
      data: {
        file: `/Users/private/${forbiddenSecret}.test.mjs`,
        name: `unsafe \u001b[31m\u202e ${forbiddenSecret} /Users/private/file ${"x".repeat(300)}`,
        nesting: 0,
        testNumber: 5,
        details: { error: directFailure }
      }
    },
    {
      type: "test:fail",
      data: {
        file: testFile,
        name: "suite wrapper",
        nesting: 0,
        testNumber: 6,
        details: { type: "suite", error: directFailure }
      }
    },
    accessorEvent
  ]);

  assert.equal(getterExecutions, 0);
  assert.equal(exitCode, 1);
  assert.deepEqual(
    Object.fromEntries(["passed", "failed", "cancelled", "skipped", "todo"].map((field) => [field, summary[field]])),
    { passed: 1, failed: 2, cancelled: 1, skipped: 1, todo: 1 }
  );
  assert.equal(summary.violations.length, 5);
  assert.equal(summary.omittedViolations, 0);
  assert.deepEqual(summary.violations.map((entry) => entry.outcome), [
    "skipped",
    "todo",
    "cancelled",
    "failed",
    "failed"
  ]);
  assert.equal(summary.violations[2].line, null, "Node 18 does not provide line/column");
  assert.equal(summary.violations[2].column, null);
  assert.equal(summary.violations[3].errorName, "AssertionError");
  assert.equal(summary.violations[3].errorCode, "ERR_ASSERTION");
  assert.equal(summary.violations[3].operator, "strictEqual");
  assert.equal(summary.violations[4].file, null);
  assert.equal(summary.violations[4].name, "[redacted]");
  assert.equal(JSON.stringify(summary).includes(forbiddenSecret), false);
  assert.equal(validateZeroSkipSummary(summary, { root: ROOT }), true);
});

test("zero-skip path and name sanitization remain bounded and fail-closed", () => {
  assert.equal(sanitizeZeroSkipFile("tests/first\u202e.test.mjs", ROOT), null);
  assert.equal(sanitizeZeroSkipFile("tests/second\u202e.test.mjs", ROOT), null);
  assert.equal(sanitizeZeroSkipFile("C:\\Users\\private\\fixture.test.mjs", ROOT), null);
  assert.equal(sanitizeZeroSkipFile(path.join(ROOT, "tests/safe.test.mjs"), ROOT), "tests/safe.test.mjs");
  const knownSecrets = collectZeroSkipKnownSecrets({ REPORTER_SECRET: "tiny" });
  assert.equal(sanitizeZeroSkipFile("tests/tiny.test.mjs", ROOT, knownSecrets), null);
  assert.equal(sanitizeZeroSkipFile(
    "tests/xai-COMMONSECRET000000.test.mjs",
    ROOT,
    []
  ), null);
  assert.equal(sanitizeZeroSkipFile("tests/ordinary.test.mjs", ROOT, knownSecrets), "tests/ordinary.test.mjs");
  const boundedName = sanitizeZeroSkipName(
    Array.from({ length: 100 }, (_, index) => `part ${index}`).join(" "),
    { root: ROOT }
  );
  assert.equal(Array.from(boundedName).length, 160);
  assert.match(boundedName, /…$/u);
  assert.equal(sanitizeZeroSkipName("contains short-canary", {
    root: ROOT,
    knownSecrets: ["short-canary"]
  }), "[redacted]");
  for (const [index, name] of SHORT_ABSOLUTE_PATH_NAMES.entries()) {
    assert.equal(
      sanitizeZeroSkipName(name, { root: ROOT }) === "[redacted]",
      true,
      `absolute path case ${index + 1}`
    );
  }
  assert.equal(sanitizeZeroSkipName("ordinary fraction 1/2", { root: ROOT }), "ordinary fraction 1/2");
  assert.equal(sanitizeZeroSkipName("slash /   ", { root: ROOT }), "slash /");
});

test("zero-skip reporter suppresses short absolute paths after common delimiters", async () => {
  const testFile = path.join(ROOT, "tests/reporter-short-path.test.mjs");
  for (const [index, rawName] of SHORT_ABSOLUTE_PATH_NAMES.entries()) {
    const label = `absolute path case ${index + 1}`;
    const { exitCode, summary } = await collectZeroSkipReport([
      {
        type: "test:fail",
        data: {
          file: testFile,
          name: rawName,
          nesting: 0,
          testNumber: index + 1,
          details: {
            error: {
              failureType: "testCodeFailure",
              name: "Error",
              code: "ERR_TEST_FAILURE"
            }
          }
        }
      }
    ], {
      root: ROOT,
      environment: {}
    });
    assert.equal(exitCode, 1, label);
    assert.equal(summary.failed, 1, label);
    assert.equal(summary.violations[0].name === "[redacted]", true, label);
    const serialized = `${JSON.stringify(summary)}\n`;
    assert.equal(serialized.includes(rawName), false, label);
    assert.equal(serialized.includes(JSON.stringify(rawName).slice(1, -1)), false, label);
    assert.equal(validateZeroSkipSummary(summary, {
      root: ROOT,
      environment: {}
    }), true, label);
  }
});

test("zero-skip maximum-width legal v2 summary remains below its byte limit", () => {
  const maximumFile = `tests/${"a".repeat(246)}.mjs`;
  const maximumName = "😀".repeat(160);
  const maximumToken = `${"E".repeat(23)}:${"F".repeat(23)}:${"G".repeat(16)}`;
  assert.equal(maximumFile.length, 256);
  assert.equal(Array.from(maximumName).length, 160);
  assert.equal(maximumToken.length, 64);

  const summary = {
    reporter: ZERO_SKIP_REPORTER_ID,
    passed: 0,
    failed: Number.MAX_SAFE_INTEGER,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    violations: Array.from({ length: ZERO_SKIP_MAX_VIOLATIONS }, (_, index) => ({
      outcome: "failed",
      file: maximumFile,
      name: maximumName,
      testNumber: Number.MAX_SAFE_INTEGER - index,
      nesting: Number.MAX_SAFE_INTEGER,
      line: Number.MAX_SAFE_INTEGER,
      column: Number.MAX_SAFE_INTEGER,
      errorName: maximumToken,
      errorCode: maximumToken,
      operator: maximumToken
    })),
    omittedViolations: Number.MAX_SAFE_INTEGER - ZERO_SKIP_MAX_VIOLATIONS
  };
  assert.equal(validateZeroSkipSummary(summary, {
    root: ROOT,
    environment: {}
  }), true);
  assert.deepEqual(Object.keys(summary.violations[0]), ZERO_SKIP_VIOLATION_FIELDS);
  assert.ok(
    Buffer.byteLength(`${JSON.stringify(summary)}\n`, "utf8") < ZERO_SKIP_MAX_SUMMARY_BYTES
  );
});

test("zero-skip secret discovery exposes incompleteness and suppresses the uncollected 65th value", async () => {
  const lastSecret = "last-canary";
  const environment = {};
  for (let index = 0; index < 65; index += 1) {
    environment[`REPORTER_SECRET_${String(index).padStart(2, "0")}`] = (
      index === 64 ? lastSecret : `known-canary-${index}`
    );
  }

  const knownSecrets = collectZeroSkipKnownSecrets(environment);
  assert.equal(knownSecrets.length, 64);
  assert.equal(knownSecrets.complete, false);
  assert.equal(Object.keys(knownSecrets).includes("complete"), false);
  assert.equal(Object.getOwnPropertyDescriptor(knownSecrets, "complete")?.enumerable, false);

  const { exitCode, summary } = await collectZeroSkipReport([
    {
      type: "test:fail",
      data: {
        file: path.join(ROOT, "tests", `${lastSecret}.test.mjs`),
        name: `failure ${lastSecret}`,
        nesting: 0,
        testNumber: 1,
        details: {
          error: {
            failureType: "testCodeFailure",
            name: lastSecret,
            code: lastSecret,
            operator: lastSecret
          }
        }
      }
    }
  ], { root: ROOT, environment });

  assert.equal(exitCode, 1);
  assert.equal(summary.failed, 1);
  assert.deepEqual(Object.keys(summary).sort(), [
    "reporter",
    ...ZERO_SKIP_SUMMARY_FIELDS,
    "violations",
    "omittedViolations"
  ].sort());
  assert.deepEqual(Object.keys(summary.violations[0]), ZERO_SKIP_VIOLATION_FIELDS);
  assert.deepEqual(summary.violations[0], {
    outcome: "failed",
    file: null,
    name: "[redacted]",
    testNumber: 1,
    nesting: 0,
    line: null,
    column: null,
    errorName: null,
    errorCode: null,
    operator: null
  });
  const serialized = `${JSON.stringify(summary)}\n`;
  assert.ok(Buffer.byteLength(serialized, "utf8") <= ZERO_SKIP_MAX_SUMMARY_BYTES);
  assert.equal(serialized.includes(lastSecret), false);
  assert.equal(validateZeroSkipSummary(summary, { root: ROOT, environment }), true);

  let aggregateOutput = "";
  let aggregateDiagnostic = "";
  const aggregateStatus = runDeterministicTestFiles({
    files: [`tests/${lastSecret}.test.mjs`],
    root: ROOT,
    env: environment,
    run: () => ({
      status: 1,
      signal: null,
      stdout: serialized,
      stderr: lastSecret
    }),
    stdout: { write(value) { aggregateOutput += value; } },
    stderr: { write(value) { aggregateDiagnostic += value; } }
  });
  assert.equal(aggregateStatus, 1);
  assert.equal(JSON.parse(aggregateOutput).violations[0].file, null);
  assert.equal(`${aggregateOutput}${aggregateDiagnostic}`.includes(lastSecret), false);

  let rejectedOutput = "";
  let rejectedDiagnostic = "";
  const rejectedStatus = runDeterministicTestFiles({
    files: ["tests/malicious.test.mjs"],
    root: ROOT,
    env: environment,
    run: () => ({
      status: 1,
      signal: null,
      stdout: zeroSkipSummary({
        failed: 1,
        violations: [zeroSkipViolation({
          file: `tests/${lastSecret}.test.mjs`,
          name: lastSecret,
          errorName: lastSecret,
          errorCode: lastSecret,
          operator: lastSecret
        })]
      }),
      stderr: lastSecret
    }),
    stdout: { write(value) { rejectedOutput += value; } },
    stderr: { write(value) { rejectedDiagnostic += value; } }
  });
  assert.equal(rejectedStatus, 1);
  assert.match(rejectedDiagnostic, /invalid zero-skip summary/);
  assert.equal(`${rejectedOutput}${rejectedDiagnostic}`.includes(lastSecret), false);
});

test("zero-skip secret discovery never invokes accessors and fails closed on incomplete values", async () => {
  const accessorSecret = "accessor-canary";
  let getterExecutions = 0;
  const accessorEnvironment = {};
  Object.defineProperty(accessorEnvironment, "REPORTER_SECRET", {
    enumerable: true,
    get() {
      getterExecutions += 1;
      return accessorSecret;
    }
  });
  const accessorKnowledge = collectZeroSkipKnownSecrets(accessorEnvironment);
  assert.equal(getterExecutions, 0);
  assert.equal(accessorKnowledge.complete, false);
  assert.deepEqual([...accessorKnowledge], []);

  const oversizedKnowledge = collectZeroSkipKnownSecrets({
    REPORTER_SECRET: "x".repeat(4_097)
  });
  assert.equal(oversizedKnowledge.complete, false);
  assert.deepEqual([...oversizedKnowledge], []);

  const failedCollection = collectZeroSkipKnownSecrets(new Proxy({}, {
    ownKeys() {
      throw new Error("descriptor failure");
    }
  }));
  assert.equal(failedCollection.complete, false);

  const { summary } = await collectZeroSkipReport([
    {
      type: "test:fail",
      data: {
        file: path.join(ROOT, "tests/accessor-visible.test.mjs"),
        name: "accessor visible name",
        nesting: 0,
        testNumber: 1,
        details: {
          error: {
            failureType: "testCodeFailure",
            name: "VisibleError",
            code: "VISIBLE_CODE",
            operator: "visibleOperator"
          }
        }
      }
    }
  ], { root: ROOT, environment: accessorEnvironment });
  assert.equal(getterExecutions, 0);
  assert.deepEqual(summary.violations[0], {
    outcome: "failed",
    file: null,
    name: "[redacted]",
    testNumber: 1,
    nesting: 0,
    line: null,
    column: null,
    errorName: null,
    errorCode: null,
    operator: null
  });
  assert.equal(JSON.stringify(summary).includes(accessorSecret), false);
  assert.equal(validateZeroSkipSummary(summary, {
    root: ROOT,
    environment: accessorEnvironment
  }), true);
  assert.equal(getterExecutions, 0);
});

test("zero-skip v2 retains the first eight violations and counts every omitted outcome", async () => {
  const testFile = path.join(ROOT, "tests/reporter-cap.test.mjs");
  const events = Array.from({ length: 10 }, (_, index) => ({
    type: "test:fail",
    data: {
      file: testFile,
      name: `failure ${index + 1}`,
      nesting: 0,
      testNumber: index + 1,
      details: {
        error: {
          failureType: "testCodeFailure",
          name: "Error",
          code: "ERR_TEST_FAILURE"
        }
      }
    }
  }));
  const { exitCode, summary } = await collectZeroSkipReport(events);
  assert.equal(exitCode, 1);
  assert.equal(summary.failed, 10);
  assert.equal(summary.violations.length, ZERO_SKIP_MAX_VIOLATIONS);
  assert.equal(summary.omittedViolations, 2);
  assert.deepEqual(
    summary.violations.map((entry) => entry.name),
    Array.from({ length: ZERO_SKIP_MAX_VIOLATIONS }, (_, index) => `failure ${index + 1}`)
  );
  assert.equal(validateZeroSkipSummary(summary, { root: ROOT }), true);
});

test("deterministic runner rejects malformed v2 summaries without echoing raw values", () => {
  const secret = "xai-RUNNERMALFORMED000000";
  const baseViolation = zeroSkipViolation();
  const cases = [
    "{}\n",
    zeroSkipSummary({ skipped: 1 }),
    zeroSkipSummary({ failed: 1, omittedViolations: 1 }),
    zeroSkipSummary({
      failed: 1,
      violations: [{ ...baseViolation, outcome: "skipped" }]
    }),
    zeroSkipSummary({
      failed: 1,
      violations: [{ ...baseViolation, file: `/Users/private/${secret}.test.mjs` }]
    }),
    zeroSkipSummary({
      failed: 1,
      violations: [{ ...baseViolation, name: secret }]
    }),
    zeroSkipSummary({
      failed: 1,
      violations: [{ ...baseViolation, unexpected: null }]
    }),
    zeroSkipSummary({
      failed: ZERO_SKIP_MAX_VIOLATIONS + 1,
      violations: Array.from(
        { length: ZERO_SKIP_MAX_VIOLATIONS + 1 },
        (_, index) => zeroSkipViolation({ name: `failure ${index}` })
      )
    }),
    zeroSkipSummary({ passed: -1 }),
    `${zeroSkipSummary()}${zeroSkipSummary()}`,
    "x".repeat(ZERO_SKIP_MAX_SUMMARY_BYTES + 1)
  ];

  for (const [index, childOutput] of cases.entries()) {
    let output = "";
    let diagnostic = "";
    const privateInput = `/Users/private/${secret}-${index}.test.mjs`;
    const status = runDeterministicTestFiles({
      files: [privateInput],
      run: () => ({
        status: 0,
        signal: null,
        stdout: childOutput,
        stderr: `${secret}-stderr-${index}`
      }),
      stdout: { write(value) { output += value; } },
      stderr: { write(value) { diagnostic += value; } }
    });
    assert.equal(status, 1, String(index));
    assert.match(diagnostic, /child 1 emitted an invalid zero-skip summary/, String(index));
    assert.equal(`${output}${diagnostic}`.includes(secret), false, String(index));
    assert.equal(`${output}${diagnostic}`.includes(privateInput), false, String(index));
  }

  const environmentSecret = "short-canary";
  const secretViolations = [
    zeroSkipViolation({ name: environmentSecret }),
    zeroSkipViolation({ file: `tests/${environmentSecret}.test.mjs` }),
    zeroSkipViolation({ errorCode: environmentSecret })
  ];
  for (const [index, violation] of secretViolations.entries()) {
    let output = "";
    let diagnostic = "";
    const status = runDeterministicTestFiles({
      files: [`tests/environment-secret-${index}.test.mjs`],
      env: { REPORTER_SECRET: environmentSecret },
      run: () => ({
        status: 1,
        signal: null,
        stdout: zeroSkipSummary({
          failed: 1,
          violations: [violation]
        }),
        stderr: environmentSecret
      }),
      stdout: { write(value) { output += value; } },
      stderr: { write(value) { diagnostic += value; } }
    });
    assert.equal(status, 1, String(index));
    assert.match(diagnostic, /invalid zero-skip summary/, String(index));
    assert.equal(`${output}${diagnostic}`.includes(environmentSecret), false, String(index));
  }

  let fallbackOutput = "";
  let fallbackDiagnostic = "";
  const fallbackStatus = runDeterministicTestFiles({
    files: [`tests/${environmentSecret}.test.mjs`],
    env: { REPORTER_SECRET: environmentSecret },
    run: () => ({
      status: 1,
      signal: null,
      stdout: zeroSkipSummary({
        failed: 1,
        violations: [zeroSkipViolation({ file: null })]
      }),
      stderr: environmentSecret
    }),
    stdout: { write(value) { fallbackOutput += value; } },
    stderr: { write(value) { fallbackDiagnostic += value; } }
  });
  assert.equal(fallbackStatus, 1);
  assert.equal(JSON.parse(fallbackOutput).violations[0].file, null);
  assert.equal(`${fallbackOutput}${fallbackDiagnostic}`.includes(environmentSecret), false);
});

test("zero-skip validator and deterministic parser reject raw short absolute paths", () => {
  for (const [index, rawName] of SHORT_ABSOLUTE_PATH_NAMES.entries()) {
    const label = `absolute path case ${index + 1}`;
    const childOutput = zeroSkipSummary({
      passed: 0,
      failed: 1,
      violations: [zeroSkipViolation({ name: rawName })]
    });
    assert.equal(validateZeroSkipSummary(JSON.parse(childOutput), {
      root: ROOT,
      environment: {}
    }), false, label);

    let output = "";
    let diagnostic = "";
    const status = runDeterministicTestFiles({
      files: [`tests/absolute-path-${index}.test.mjs`],
      root: ROOT,
      env: {},
      run: () => ({
        status: 1,
        signal: null,
        stdout: childOutput,
        stderr: rawName
      }),
      stdout: { write(value) { output += value; } },
      stderr: { write(value) { diagnostic += value; } }
    });
    assert.equal(status, 1, label);
    assert.match(diagnostic, /invalid zero-skip summary/, label);
    assert.equal(`${output}${diagnostic}`.includes(rawName), false, label);
    assert.equal(
      `${output}${diagnostic}`.includes(JSON.stringify(rawName).slice(1, -1)),
      false,
      label
    );
  }
});

test("deterministic runner suppresses child stderr and globally caps structural violations", () => {
  const stderrSentinel = "runner-stderr-sentinel";
  const childSummaries = [
    zeroSkipSummary({
      failed: 6,
      violations: Array.from(
        { length: 6 },
        (_, index) => zeroSkipViolation({ name: `failed ${index + 1}` })
      )
    }),
    zeroSkipSummary({
      skipped: 4,
      violations: Array.from(
        { length: 4 },
        (_, index) => zeroSkipViolation({ outcome: "skipped", name: `skipped ${index + 1}` })
      )
    })
  ];
  let call = 0;
  let output = "";
  let diagnostic = "";
  const status = runDeterministicTestFiles({
    files: ["tests/first.test.mjs", "tests/second.test.mjs"],
    run: () => ({
      status: 1,
      signal: null,
      stdout: childSummaries[call++],
      stderr: `${stderrSentinel}-must-not-be-forwarded`
    }),
    stdout: { write(value) { output += value; } },
    stderr: { write(value) { diagnostic += value; } }
  });
  const aggregate = JSON.parse(output);
  assert.equal(status, 1);
  assert.equal(`${output}${diagnostic}`.includes(stderrSentinel), false);
  assert.deepEqual(
    Object.fromEntries(["passed", "failed", "cancelled", "skipped", "todo"].map((field) => [field, aggregate[field]])),
    { passed: 2, failed: 6, cancelled: 0, skipped: 4, todo: 0 }
  );
  assert.equal(aggregate.violations.length, ZERO_SKIP_MAX_VIOLATIONS);
  assert.equal(aggregate.omittedViolations, 2);
  assert.deepEqual(aggregate.violations.map((entry) => entry.name), [
    "failed 1",
    "failed 2",
    "failed 3",
    "failed 4",
    "failed 5",
    "failed 6",
    "skipped 1",
    "skipped 2"
  ]);
  assert.equal(validateZeroSkipSummary(aggregate, { root: ROOT }), true);
});

test("deterministic runner fails closed on safe-integer aggregation overflow", () => {
  const summaries = [
    zeroSkipSummary({ passed: Number.MAX_SAFE_INTEGER }),
    zeroSkipSummary()
  ];
  let call = 0;
  let output = "";
  let diagnostic = "";
  const status = runDeterministicTestFiles({
    files: ["tests/first.test.mjs", "tests/second.test.mjs"],
    run: () => ({
      status: 0,
      signal: null,
      stdout: summaries[call++],
      stderr: ""
    }),
    stdout: { write(value) { output += value; } },
    stderr: { write(value) { diagnostic += value; } }
  });
  assert.equal(status, 1);
  assert.match(diagnostic, /child 2 could not be aggregated safely/);
  assert.equal(JSON.parse(output).passed, Number.MAX_SAFE_INTEGER);
  assert.equal(validateZeroSkipSummary(JSON.parse(output), { root: ROOT }), true);
});
