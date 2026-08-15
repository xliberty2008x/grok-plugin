import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { STDIN_READY_MARKER } from "../plugins/grok/scripts/lib/stdin.mjs";
import { parseTaskEnvelopeInput } from "../plugins/grok/scripts/lib/task-envelope.mjs";
import { buildWorkerReport } from "../plugins/grok/scripts/lib/task-contract.mjs";
import { installFakeGrok, readFakeLog } from "./fake-grok.mjs";
import { installPinnedFakeCompanion } from "./pinned-fake-grok.mjs";
import {
  initRepo,
  ptyPythonAvailable,
  run,
  runCodexCompanion,
  runPtyStdin,
  tempDir,
  testEnvironment
} from "./helpers.mjs";

test("TaskEnvelope stdin requires a non-empty userRequest after --envelope-stdin", () => {
  assert.throws(
    () => parseTaskEnvelopeInput(JSON.stringify({ schemaVersion: 1, objective: "no userRequest field" })),
    (error) => error?.code === "E_USAGE"
      && /userRequest must be a non-empty string/.test(error.message)
      && !/pass --envelope-stdin/.test(error.message)
  );
  assert.throws(
    () => parseTaskEnvelopeInput(JSON.stringify({ schemaVersion: 1, userRequest: "   " })),
    (error) => error?.code === "E_USAGE" && /userRequest must be a non-empty string/.test(error.message)
  );
  const parsed = parseTaskEnvelopeInput(JSON.stringify({
    schemaVersion: 1,
    userRequest: "implement the handshake fixture"
  }));
  assert.equal(parsed.userRequest, "implement the handshake fixture");
});

const PYTHON_AVAILABLE = ptyPythonAvailable();
const PYTHON_BINDING = (() => {
  const proofBinding = process.env.GROK_PROOF_PYTHON;
  if (typeof proofBinding === "string" && path.isAbsolute(proofBinding)) return proofBinding;
  const probe = run("python3", [
    "-I",
    "-S",
    "-B",
    "-c",
    "import os,sys; print(os.path.realpath(sys.executable))"
  ], { timeout: 5_000 });
  const candidate = probe.status === 0 ? probe.stdout.trim() : "";
  return path.isAbsolute(candidate) ? candidate : null;
})();

function shellSingleQuote(value) {
  return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
}

function jobRecordFiles(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && path.basename(directory) === "jobs" && entry.name.endsWith(".json")) found.push(absolute);
    }
  };
  visit(root);
  return found;
}

function removeFixtureDirectories(directories) {
  for (const directory of directories) {
    const deadline = Date.now() + 15_000;
    while (fs.existsSync(directory)) {
      try {
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
      } catch (error) {
        if (error?.code !== "ENOTEMPTY" || Date.now() >= deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      }
    }
  }
}

test("PTY harness uses but does not expose the proof-only Python binding", {
  skip: process.platform === "win32"
    ? "PTY harness is POSIX-only"
    : (!(PYTHON_AVAILABLE && PYTHON_BINDING) ? "Python 3 PTY harness is unavailable" : false)
}, (t) => {
  const root = tempDir("grok-proof-python-control-");
  const target = path.join(root, "inspect-proof-python.mjs");
  const wrapper = path.join(root, "bound-python-wrapper");
  const argumentLog = path.join(root, "python-arguments.log");
  const exposedMarker = path.join(root, "proof-python-was-exposed");
  t.after(() => removeFixtureDirectories([root]));
  fs.writeFileSync(wrapper, [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${shellSingleQuote(argumentLog)}`,
    `if [ "\${GROK_PROOF_PYTHON+x}" = x ]; then : > ${shellSingleQuote(exposedMarker)}; fi`,
    `exec ${shellSingleQuote(PYTHON_BINDING)} "$@"`,
    ""
  ].join("\n"), { mode: 0o755 });
  fs.chmodSync(wrapper, 0o755);
  fs.writeFileSync(target, [
    'process.stdout.write(JSON.stringify({',
    '  proofPythonVisible: Object.hasOwn(process.env, "GROK_PROOF_PYTHON"),',
    '  ordinaryMarker: process.env.GROK_TEST_ORDINARY_MARKER || null',
    '}));',
    ''
  ].join("\n"));

  const environment = {
    ...process.env,
    GROK_PROOF_PYTHON: wrapper,
    GROK_TEST_ORDINARY_MARKER: "preserved"
  };
  assert.equal(ptyPythonAvailable({ env: environment }), true);
  const invocation = runPtyStdin(target, [], {
    cwd: root,
    env: environment,
    input: "",
    timeout: 10_000
  });
  assert.equal(invocation.driver.status, 0, invocation.driver.stderr || invocation.driver.stdout);
  assert.ok(invocation.result);
  assert.equal(invocation.result.code, 0, invocation.result.stderr);
  assert.deepEqual(JSON.parse(invocation.result.stdout), {
    proofPythonVisible: false,
    ordinaryMarker: "preserved"
  });
  assert.equal(fs.existsSync(exposedMarker), false, "proof selector must be scrubbed before Python starts");
  const invocations = fs.readFileSync(argumentLog, "utf8").trim().split("\n");
  assert.equal(invocations.length, 2);
  assert.match(invocations[0], /^-I -S -B -c import pty$/);
  assert.match(invocations[1], /^-I -S -B .*pty-stdin-driver\.py /);
});

test("source Codex wrapper survives delayed input on a genuinely nonblocking PTY", {
  skip: process.platform === "win32"
    ? "nonblocking PTY regression is POSIX-only"
    : (!PYTHON_AVAILABLE ? "Python 3 PTY harness is unavailable" : false)
}, async (t) => {
  const root = initRepo();
  const pluginData = tempDir("grok-source-pty-data-");
  const fakeRoot = tempDir("grok-source-pty-fake-");
  t.after(() => removeFixtureDirectories([root, pluginData, fakeRoot]));

  const fake = installFakeGrok(fakeRoot, {
    taskText: `GROK_WORKER_REPORT: ${JSON.stringify({
      outcome: "complete",
      summary: "Source PTY ingress completed",
      changedFiles: [],
      checksClaimed: [],
      acceptanceResults: [{ id: "AC-01", status: "met" }],
      risks: [],
      questions: []
    })}`
  });
  const env = testEnvironment({
    fake,
    pluginData,
    sessionId: "source-pty-ingress-regression",
    extra: {
      CODEX_THREAD_ID: "source-pty-ingress-regression",
      GROK_COMPANION_HOST: "codex",
      GROK_COMPANION_HOST_SESSION_ID: "source-pty-ingress-regression",
      GROK_COMPANION_PLUGIN_DATA: pluginData,
      GROK_TEST_PTY_OBSERVE_LOG: fake.logFile
    }
  });
  for (const key of [
    "CLAUDE_PLUGIN_DATA",
    "CLAUDE_PROJECT_DIR",
    "CLAUDE_SESSION_ID",
    "GROK_COMPANION_CLAUDE_SESSION_ID",
    "GROK_COMPANION_CHILD",
    "GROK_COMPANION_JOB_MARKER",
    "GROK_AGENT",
    "GROK_LEADER_SOCKET"
  ]) delete env[key];
  const pinned = installPinnedFakeCompanion(fake, env);
  t.after(pinned.cleanup);
  const setup = run(
    process.execPath,
    [pinned.codexCompanionScript, "setup", "--json"],
    { cwd: root, env: pinned.env, timeout: 30_000 }
  );
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  assert.equal(JSON.parse(setup.stdout).ready, true);
  const providerStartsAfterSetup = readFakeLog(fake.logFile).filter(
    (entry) => entry.event === "argv"
      && entry.args.includes("agent")
      && entry.args.includes("stdio")
  ).length;
  assert.equal(providerStartsAfterSetup, 1);

  const envelope = JSON.stringify({
    schemaVersion: 1,
    userRequest: "reproduce GitHub issue #2 through the Codex PTY contract",
    objective: "Wait for delayed framed input without leaking EAGAIN",
    mode: "read",
    scope: { include: [], exclude: [] },
    context: {
      facts: ["The PTY slave is nonblocking before the wrapper starts."],
      constraints: ["Do not edit the fixture."],
      expectedProjectMarkers: [],
      requiredPaths: ["tracked.txt"],
      workspaceState: "task_scoped",
      upstreamFreshness: "not_checked"
    },
    nonGoals: ["Do not use a blocking pipe as a substitute."],
    acceptanceCriteria: [{ id: "AC-01", text: "Dispatch exactly once after the reader-ready marker." }],
    requiredVerification: ["git status --short"],
    expectedReturnFormat: "GROK_WORKER_REPORT JSON plus concise human summary"
  });
  const dispatch = runPtyStdin(
    pinned.codexCompanionScript,
    ["task", "--background", "--envelope-stdin", "--stdin-ready", "--fresh", "--effort", "high", "--json"],
    { cwd: root, env: pinned.env, input: envelope, timeout: 45_000 }
  );
  assert.equal(dispatch.driver.status, 0, dispatch.driver.stderr || dispatch.driver.stdout);
  assert.ok(dispatch.result, "PTY driver did not return structured evidence");
  assert.equal(dispatch.result.ready, true, dispatch.result.stderr);
  assert.equal(dispatch.result.aliveBeforeInput, true);
  assert.equal(
    dispatch.result.providerStartsBeforeInput,
    providerStartsAfterSetup
  );
  assert.equal(dispatch.result.writeError, null);
  assert.equal(dispatch.result.code, 0, dispatch.result.stderr || dispatch.result.stdout);
  assert.match(dispatch.result.stderr, new RegExp(STDIN_READY_MARKER));
  assert.doesNotMatch(dispatch.result.stderr, /EAGAIN|resource temporarily unavailable/i);
  assert.equal(dispatch.result.ptyOutput, "", "private TaskEnvelope or terminal control data was echoed by the PTY");
  const job = JSON.parse(dispatch.result.stdout);
  assert.ok(job.id);

  const terminalStatus = run(
    process.execPath,
    [
      pinned.codexCompanionScript,
      "status",
      job.id,
      "--wait",
      "--timeout-ms",
      "30000",
      "--json"
    ],
    { cwd: root, env: pinned.env, timeout: 45_000 }
  );
  assert.equal(terminalStatus.status, 0, terminalStatus.stderr || terminalStatus.stdout);
  const terminal = JSON.parse(terminalStatus.stdout);
  assert.equal(terminal.status, "completed");
  const providerStarts = readFakeLog(fake.logFile).filter(
    (entry) => entry.event === "argv" && entry.args.includes("agent") && entry.args.includes("stdio")
  );
  assert.equal(providerStarts.length, providerStartsAfterSetup + 1);

  const verification = JSON.stringify({
    commandOutcomes: [{ command: "git status --short", status: "passed", exitCode: 0 }]
  });
  const record = runPtyStdin(
    pinned.codexCompanionScript,
    ["record-verification", job.id, "--verification-stdin", "--stdin-ready", "--json"],
    {
      cwd: root,
      env: pinned.env,
      input: verification,
      timeout: 45_000
    }
  );
  assert.equal(record.driver.status, 0, record.driver.stderr || record.driver.stdout);
  assert.equal(record.result?.ready, true, record.result?.stderr);
  assert.equal(record.result?.aliveBeforeInput, true);
  assert.equal(
    record.result?.providerStartsBeforeInput,
    providerStartsAfterSetup + 1
  );
  assert.equal(record.result?.writeError, null);
  assert.equal(record.result?.code, 0, record.result?.stderr || record.result?.stdout);
  assert.equal(record.result?.ptyOutput, "", "private verification record or terminal control data was echoed by the PTY");
  assert.equal(JSON.parse(record.result.stdout).result.hostVerification, "passed");
});

test("original issue #2 invocation waits for a delayed PTY writer without a readiness flag", {
  skip: process.platform === "win32"
    ? "nonblocking PTY regression is POSIX-only"
    : (!PYTHON_AVAILABLE ? "Python 3 PTY harness is unavailable" : false)
}, async (t) => {
  const root = initRepo();
  const pluginData = tempDir("grok-source-pty-no-ready-data-");
  const fakeRoot = tempDir("grok-source-pty-no-ready-fake-");
  t.after(() => removeFixtureDirectories([root, pluginData, fakeRoot]));
  const fake = installFakeGrok(fakeRoot, {
    taskText: `GROK_WORKER_REPORT: ${JSON.stringify({
      outcome: "complete",
      summary: "Original delayed writer completed",
      changedFiles: [],
      checksClaimed: [],
      acceptanceResults: [{ id: "AC-01", status: "met" }],
      risks: [],
      questions: []
    })}`
  });
  const env = testEnvironment({
    fake,
    pluginData,
    sessionId: "source-pty-original-ordering",
    extra: {
      CODEX_THREAD_ID: "source-pty-original-ordering",
      GROK_COMPANION_HOST: "codex",
      GROK_COMPANION_HOST_SESSION_ID: "source-pty-original-ordering",
      GROK_COMPANION_PLUGIN_DATA: pluginData,
      GROK_TEST_PTY_OBSERVE_LOG: fake.logFile
    }
  });
  const pinned = installPinnedFakeCompanion(fake, env);
  t.after(pinned.cleanup);
  const setup = run(
    process.execPath,
    [pinned.codexCompanionScript, "setup", "--json"],
    { cwd: root, env: pinned.env, timeout: 30_000 }
  );
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  assert.equal(JSON.parse(setup.stdout).ready, true);
  const providerStartsAfterSetup = readFakeLog(fake.logFile).filter(
    (entry) => entry.event === "argv"
      && entry.args.includes("agent")
      && entry.args.includes("stdio")
  ).length;
  assert.equal(providerStartsAfterSetup, 1);
  const envelope = JSON.stringify({
    schemaVersion: 1,
    userRequest: "reproduce the original issue #2 invocation",
    objective: "Accept delayed nonblocking PTY input without requiring a readiness flag",
    mode: "read",
    scope: { include: [], exclude: [] },
    context: {
      facts: ["The host writes after its initial process-start yield."],
      constraints: ["Do not edit the fixture."],
      expectedProjectMarkers: [],
      requiredPaths: ["tracked.txt"],
      workspaceState: "task_scoped",
      upstreamFreshness: "not_checked"
    },
    nonGoals: [],
    acceptanceCriteria: [{ id: "AC-01", text: "Return one job ID after delayed input." }],
    requiredVerification: ["git status --short"],
    expectedReturnFormat: "GROK_WORKER_REPORT JSON plus concise human summary"
  });
  const dispatch = runPtyStdin(
    pinned.codexCompanionScript,
    ["task", "--background", "--envelope-stdin", "--fresh", "--effort", "high", "--json"],
    { cwd: root, env: pinned.env, input: envelope, timeout: 45_000 }
  );
  assert.equal(dispatch.driver.status, 0, dispatch.driver.stderr || dispatch.driver.stdout);
  assert.equal(dispatch.result?.requiresReady, false);
  assert.equal(dispatch.result?.ready, false, "the original invocation must not depend on a synthetic ready marker");
  assert.equal(dispatch.result?.aliveBeforeInput, true);
  assert.equal(
    dispatch.result?.providerStartsBeforeInput,
    providerStartsAfterSetup
  );
  assert.equal(dispatch.result?.writeError, null);
  assert.equal(dispatch.result?.code, 0, dispatch.result?.stderr || dispatch.result?.stdout);
  assert.doesNotMatch(dispatch.result?.stderr || "", /EAGAIN|resource temporarily unavailable/i);
  const job = JSON.parse(dispatch.result.stdout);
  assert.ok(job.id);
  const terminalStatus = run(
    process.execPath,
    [
      pinned.codexCompanionScript,
      "status",
      job.id,
      "--wait",
      "--timeout-ms",
      "30000",
      "--json"
    ],
    { cwd: root, env: pinned.env, timeout: 45_000 }
  );
  assert.equal(terminalStatus.status, 0, terminalStatus.stderr || terminalStatus.stdout);
  const terminal = JSON.parse(terminalStatus.stdout);
  assert.equal(terminal.status, "completed");
  const providerStarts = readFakeLog(fake.logFile).filter(
    (entry) => entry.event === "argv" && entry.args.includes("agent") && entry.args.includes("stdio")
  );
  assert.equal(providerStarts.length, providerStartsAfterSetup + 1);
});

test("task envelope stdin keeps empty, malformed, and oversized failures as public E_USAGE", (t) => {
  const root = initRepo();
  const pluginData = tempDir("grok-source-stdin-negative-data-");
  const fakeRoot = tempDir("grok-source-stdin-negative-fake-");
  t.after(() => removeFixtureDirectories([root, pluginData, fakeRoot]));
  const fake = installFakeGrok(fakeRoot);
  const env = testEnvironment({
    fake,
    pluginData,
    sessionId: "source-stdin-negative",
    extra: {
      CODEX_THREAD_ID: "source-stdin-negative",
      GROK_COMPANION_HOST: "codex",
      GROK_COMPANION_HOST_SESSION_ID: "source-stdin-negative",
      GROK_COMPANION_PLUGIN_DATA: pluginData
    }
  });
  const cases = [
    ["empty", "", /requires one TaskEnvelope JSON object/],
    ["malformed", "{not-json", /TaskEnvelope stdin is not valid JSON/],
    ["oversized", "x".repeat(256 * 1024 + 1), /exceeds the 256 KiB input limit/],
    [
      "missing-userRequest",
      JSON.stringify({ schemaVersion: 1, objective: "no userRequest field", mode: "read" }),
      /TaskEnvelope userRequest must be a non-empty string/
    ]
  ];
  for (const [label, input, message] of cases) {
    const result = runCodexCompanion(
      ["task", "--background", "--envelope-stdin", "--fresh", "--json"],
      { cwd: root, env, input, timeout: 10_000 }
    );
    assert.equal(result.status, 2, `${label}: ${result.stderr || result.stdout}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false, label);
    assert.equal(payload.error?.code, "E_USAGE", label);
    assert.match(payload.error?.message || "", message, label);
    assert.doesNotMatch(
      payload.error?.message || "",
      /pass --envelope-stdin/,
      `${label}: must not claim --envelope-stdin was absent after that flag was supplied`
    );
    assert.deepEqual(jobRecordFiles(pluginData), [], `${label}: invalid stdin created a job record`);
  }
  const providerStarts = readFakeLog(fake.logFile).filter(
    (entry) => entry.event === "argv" && entry.args.includes("agent") && entry.args.includes("stdio")
  );
  assert.equal(providerStarts.length, 0, "invalid stdin launched the provider");
});

test("write PTY --envelope-stdin --stdin-ready admits one delayed envelope after STDIN_READY", {
  skip: process.platform === "win32"
    ? "PTY harness is POSIX-only"
    : (!(PYTHON_AVAILABLE && PYTHON_BINDING) ? "Python 3 PTY harness is unavailable" : false)
}, (t) => {
  const root = initRepo();
  const pluginData = tempDir("grok-source-pty-data-");
  const fakeRoot = tempDir("grok-source-pty-fake-");
  t.after(() => removeFixtureDirectories([root, pluginData, fakeRoot]));
  const fake = installFakeGrok(fakeRoot, {
    taskText: `GROK_WORKER_REPORT: ${JSON.stringify({
      outcome: "complete",
      summary: "Issue 104 write handshake completed",
      changedFiles: [],
      checksClaimed: [],
      acceptanceResults: [{ id: "AC-01", status: "met" }],
      risks: [],
      questions: []
    })}`
  });
  const env = testEnvironment({
    fake,
    pluginData,
    sessionId: "issue-104-write-pty",
    extra: {
      CODEX_THREAD_ID: "issue-104-write-pty",
      GROK_COMPANION_HOST: "codex",
      GROK_COMPANION_HOST_SESSION_ID: "issue-104-write-pty",
      GROK_COMPANION_PLUGIN_DATA: pluginData,
      GROK_TEST_PTY_OBSERVE_LOG: fake.logFile
    }
  });
  for (const key of [
    "CLAUDE_PLUGIN_DATA",
    "CLAUDE_PROJECT_DIR",
    "CLAUDE_SESSION_ID",
    "GROK_COMPANION_CLAUDE_SESSION_ID",
    "GROK_COMPANION_CHILD",
    "GROK_COMPANION_JOB_MARKER",
    "GROK_AGENT",
    "GROK_LEADER_SOCKET"
  ]) delete env[key];
  const pinned = installPinnedFakeCompanion(fake, env);
  t.after(pinned.cleanup);
  const setup = run(
    process.execPath,
    [pinned.codexCompanionScript, "setup", "--json"],
    { cwd: root, env: pinned.env, timeout: 30_000 }
  );
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  const envelope = JSON.stringify({
    schemaVersion: 1,
    userRequest: "implement the issue 104 write handshake fixture",
    objective: "Admit one delayed write envelope after STDIN_READY",
    mode: "write",
    scope: { include: ["tracked.txt"], exclude: [] },
    context: {
      facts: ["The host writes the envelope only after readiness."],
      constraints: ["Do not edit the fixture."],
      expectedProjectMarkers: [],
      requiredPaths: ["tracked.txt"],
      workspaceState: "task_scoped",
      upstreamFreshness: "not_checked"
    },
    nonGoals: [],
    acceptanceCriteria: [{ id: "AC-01", text: "Create exactly one durable write job." }],
    requiredVerification: ["git status --short"],
    expectedReturnFormat: "GROK_WORKER_REPORT JSON plus concise human summary"
  });
  const dispatch = runPtyStdin(
    pinned.codexCompanionScript,
    ["task", "--background", "--envelope-stdin", "--stdin-ready", "--write", "--fresh", "--json"],
    { cwd: root, env: pinned.env, input: envelope, timeout: 45_000 }
  );
  assert.equal(dispatch.driver.status, 0, dispatch.driver.stderr || dispatch.driver.stdout);
  assert.equal(dispatch.result?.ready, true, dispatch.result?.stderr);
  assert.equal(dispatch.result?.code, 0, dispatch.result?.stderr || dispatch.result?.stdout);
  assert.match(dispatch.result?.stderr || "", new RegExp(STDIN_READY_MARKER));
  assert.doesNotMatch(dispatch.result?.stderr || "", /Provide a task for Grok or pass --envelope-stdin/);
  const job = JSON.parse(dispatch.result.stdout);
  assert.ok(job.id);
  assert.equal(job.write, true);
  assert.equal(jobRecordFiles(pluginData).length, 1);
  const terminalStatus = run(
    process.execPath,
    [
      pinned.codexCompanionScript,
      "status",
      job.id,
      "--wait",
      "--timeout-ms",
      "30000",
      "--json"
    ],
    { cwd: root, env: pinned.env, timeout: 45_000 }
  );
  assert.equal(terminalStatus.status, 0, terminalStatus.stderr || terminalStatus.stdout);
});

test("buildWorkerReport refuses complete when required acceptance stays unknown", () => {
  const report = buildWorkerReport({
    providerText: `GROK_WORKER_REPORT: ${JSON.stringify({
      outcome: "complete",
      summary: "Pending source review",
      changedFiles: [],
      checksClaimed: [],
      acceptanceResults: [
        { id: "AC-01", status: "unknown", note: "Pending source review" },
        { id: "AC-02", status: "unknown", note: "Pending source review" }
      ],
      risks: [],
      questions: []
    })}`,
    acceptanceCriteria: [
      { id: "AC-01", text: "First" },
      { id: "AC-02", text: "Second" }
    ]
  });
  assert.equal(report.valid, true);
  assert.notEqual(report.outcome, "complete");
  assert.match(report.classificationReason || "", /unknown/i);
  assert.match(report.summary, /unknown/i);
});

test("task cannot publish outcome complete when required acceptance criteria stay unknown", (t) => {
  const root = initRepo();
  const pluginData = tempDir("grok-source-stdin-negative-data-");
  const fakeRoot = tempDir("grok-source-stdin-negative-fake-");
  t.after(() => removeFixtureDirectories([root, pluginData, fakeRoot]));
  const fake = installFakeGrok(fakeRoot, {
    taskText: `GROK_WORKER_REPORT: ${JSON.stringify({
      outcome: "complete",
      summary: "Pending source review",
      changedFiles: [],
      checksClaimed: [],
      acceptanceResults: [
        { id: "AC-01", status: "unknown", note: "Pending source review" },
        { id: "AC-02", status: "unknown", note: "Pending source review" },
        { id: "AC-03", status: "unknown", note: "Pending source review" },
        { id: "AC-04", status: "unknown", note: "Pending source review" }
      ],
      risks: [],
      questions: []
    })}`
  });
  const env = testEnvironment({ fake, pluginData, sessionId: "issue-105-unknown-complete" });
  delete env.GROK_COMPANION_CHILD;
  delete env.GROK_COMPANION_JOB_MARKER;
  delete env.GROK_AGENT;
  delete env.GROK_LEADER_SOCKET;
  delete env.CODEX_THREAD_ID;
  const envelope = JSON.stringify({
    schemaVersion: 1,
    userRequest: "review the payment service contract against source",
    objective: "Diagnose incomplete implementation",
    mode: "read",
    scope: { include: [], exclude: [] },
    context: {
      facts: [],
      constraints: [],
      expectedProjectMarkers: [],
      requiredPaths: ["tracked.txt"],
      workspaceState: "task_scoped",
      upstreamFreshness: "not_checked"
    },
    nonGoals: [],
    acceptanceCriteria: [
      { id: "AC-01", text: "Contract identified" },
      { id: "AC-02", text: "Implementation gap stated" },
      { id: "AC-03", text: "Risks listed" },
      { id: "AC-04", text: "Next action listed" }
    ],
    requiredVerification: ["git diff --exit-code"],
    expectedReturnFormat: "GROK_WORKER_REPORT JSON plus concise human summary"
  });
  const result = runCodexCompanion(
    ["task", "--wait", "--envelope-stdin", "--json"],
    { cwd: root, env, input: envelope }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const job = JSON.parse(result.stdout);
  assert.equal(job.status, "completed");
  assert.notEqual(job.result.workerReport.outcome, "complete");
  assert.equal(job.result.providerClaims.success, false);
  assert.equal(
    job.result.workerReport.acceptanceResults.every((entry) => entry.status === "unknown"),
    true
  );
  assert.match(`${job.summary || ""} ${job.result.workerReport.summary || ""}`, /unknown|incomplete|not complete/i);
  const human = runCodexCompanion(["result", job.id], { cwd: root, env });
  assert.equal(human.status, 0, human.stderr);
  assert.doesNotMatch(human.stdout, /Outcome: complete/);
});

test("persist demotes complete to partial when acceptance is unmet without crashing", (t) => {
  const providerText = `GROK_WORKER_REPORT: ${JSON.stringify({
    outcome: "complete",
    summary: "Charge path implemented",
    changedFiles: [],
    checksClaimed: [],
    acceptanceResults: [
      { id: "AC-01", status: "met", note: "Contract identified" },
      { id: "AC-02", status: "unmet", note: "Retry path missing" }
    ],
    risks: [],
    questions: []
  })}`;
  const acceptanceCriteria = [
    { id: "AC-01", text: "Contract identified" },
    { id: "AC-02", text: "Retry path implemented" }
  ];
  const parsed = buildWorkerReport({ providerText, acceptanceCriteria });
  assert.equal(parsed.valid, true);
  assert.equal(parsed.outcome, "complete", "unmet criteria must stay complete through buildWorkerReport so persist reclassifies");
  assert.equal(parsed.acceptanceResults.some((entry) => entry.status === "unmet"), true);

  const root = initRepo();
  const pluginData = tempDir("grok-source-stdin-negative-data-");
  const fakeRoot = tempDir("grok-source-stdin-negative-fake-");
  t.after(() => removeFixtureDirectories([root, pluginData, fakeRoot]));
  const fake = installFakeGrok(fakeRoot, { taskText: providerText });
  const env = testEnvironment({ fake, pluginData, sessionId: "issue-105-unmet-complete" });
  delete env.GROK_COMPANION_CHILD;
  delete env.GROK_COMPANION_JOB_MARKER;
  delete env.GROK_AGENT;
  delete env.GROK_LEADER_SOCKET;
  delete env.CODEX_THREAD_ID;
  const envelope = JSON.stringify({
    schemaVersion: 1,
    userRequest: "review the payment retry path against source",
    objective: "Diagnose incomplete implementation",
    mode: "read",
    scope: { include: [], exclude: [] },
    context: {
      facts: [],
      constraints: [],
      expectedProjectMarkers: [],
      requiredPaths: ["tracked.txt"],
      workspaceState: "task_scoped",
      upstreamFreshness: "not_checked"
    },
    nonGoals: [],
    acceptanceCriteria,
    requiredVerification: ["git diff --exit-code"],
    expectedReturnFormat: "GROK_WORKER_REPORT JSON plus concise human summary"
  });
  const result = runCodexCompanion(
    ["task", "--wait", "--envelope-stdin", "--json"],
    { cwd: root, env, input: envelope }
  );
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
  assert.doesNotMatch(combined, /Assignment to constant variable/);
  assert.equal(result.status, 0, combined);
  const job = JSON.parse(result.stdout);
  assert.equal(job.status, "completed");
  assert.equal(job.result.workerReport.outcome, "partial");
  assert.equal(job.result.providerClaims.success, false);
  assert.equal(job.result.providerClaims.outcome, "partial");
  assert.match(
    `${job.result.workerReport.classificationReason || ""} ${job.result.workerReport.summary || ""}`,
    /success conditions were not met/i
  );
});
