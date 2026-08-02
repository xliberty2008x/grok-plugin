import {
  assert, crypto, fs, path, test, appendLifecycleEvent,
  assertContextCompatible, assertContextManifestIntegrity, assertTaskContextReady, buildRuntimeEvidence, buildTaskEnvelope, buildWorkerReport,
  buildWorkerReportOutputSchema, captureContextManifest, composeProviderPrompt, composeWorkerReportRepairPrompt, CONTEXT_METADATA_POLICIES, evaluateScope,
  observeChangedPaths, validateReview, REVIEW_SCHEMA, processStartToken, STDIN_READY_MARKER, initRepo,
  git, run, runCompanion, spawnNonblockingStdin, testEnvironment, waitFor,
  ROOT, tempDir, installFakeGrok, readFakeLog, installPinnedFakeCompanion, missingInvalidProviderCapabilityReceiptMessage,
  PROVIDER_LIFECYCLE_AVAILABLE, fixture, parseJson, canonicalizeForDigest, stableDigestForTest, workerReport
} from "./control-plane-test-support.mjs";

function waitForBackgroundFailure(root, env, id) {
  const job = parseJson(runCompanion([
    "status",
    id,
    "--wait",
    "--timeout-ms",
    "10000",
    "--json"
  ], { cwd: root, env }));
  assert.equal(job.status, "failed");
  return job;
}

test("integration: Codex nonblocking stdin accepts arbitrary markers and records verification", {
  skip: process.platform === "win32" && "nonblocking fd regression harness is POSIX-only"
}, async (t) => {
  const root = initRepo();
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(root, "pyproject.toml"), "[project]\nname = \"fixture\"\n");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Fixture guidance\n");
  fs.writeFileSync(path.join(root, ".github", "workflows", "quality.yml"), "name: quality\n");
  git(root, "add", "pyproject.toml", "AGENTS.md", ".github/workflows/quality.yml");
  git(root, "commit", "-m", "add arbitrary project markers");
  const { env: fixtureEnv, fake, pluginData } = fixture({
    taskText: workerReport({
      summary: "Delayed Codex ingress completed",
      acceptanceResults: [{ id: "AC-01", status: "met" }]
    })
  });
  const env = {
    ...fixtureEnv,
    CODEX_THREAD_ID: "codex-delayed-stdin-regression",
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_HOST_SESSION_ID: "codex-delayed-stdin-regression",
    GROK_COMPANION_PLUGIN_DATA: pluginData
  };
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.GROK_COMPANION_CLAUDE_SESSION_ID;
  delete env.CLAUDE_SESSION_ID;
  delete env.CLAUDE_PROJECT_DIR;
  const pinned = installPinnedFakeCompanion(fake, env);
  t.after(pinned.cleanup);
  const setup = runCompanion(["setup", "--json"], {
    cwd: root,
    env: pinned.env,
    companionScript: pinned.codexCompanionScript
  });
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
    userRequest: "analyze issue #2 without editing the checkout",
    objective: "Prove Codex can dispatch after the process starts with empty nonblocking stdin",
    mode: "read",
    scope: { include: [], exclude: [] },
    context: {
      facts: ["The host writes the envelope after process creation."],
      constraints: ["Keep the checkout unchanged."],
      expectedProjectMarkers: ["pyproject.toml", "AGENTS.md", ".github/workflows/quality.yml"],
      requiredPaths: ["tracked.txt"],
      workspaceState: "task_scoped",
      upstreamFreshness: "not_checked"
    },
    nonGoals: ["Do not edit files."],
    acceptanceCriteria: [{ id: "AC-01", text: "Receive the complete delayed envelope." }],
    requiredVerification: ["git status --short"],
    expectedReturnFormat: "GROK_WORKER_REPORT JSON plus concise human summary"
  });
  const dispatch = spawnNonblockingStdin(
    pinned.codexCompanionScript,
    ["task", "--background", "--envelope-stdin", "--stdin-ready", "--fresh", "--effort", "high", "--json"],
    { cwd: root, env: pinned.env }
  );

  await waitFor(() => dispatch.stderr.includes(STDIN_READY_MARKER), { timeoutMs: 15000 });
  assert.equal(dispatch.child.exitCode, null, "dispatch exited before Codex could write the TaskEnvelope");
  const providerStartsBeforeInput = readFakeLog(fake.logFile).filter(
    (entry) => entry.event === "argv" && entry.args.includes("agent") && entry.args.includes("stdio")
  );
  assert.equal(providerStartsBeforeInput.length, providerStartsAfterSetup);
  const split = Math.floor(envelope.length / 2);
  dispatch.child.stdin.write(envelope.slice(0, split));
  await new Promise((resolve) => setTimeout(resolve, 25));
  dispatch.child.stdin.end(envelope.slice(split));
  const dispatched = await dispatch.completed;
  assert.equal(dispatched.code, 0, dispatched.stderr || dispatched.stdout);
  assert.equal(dispatched.stdinError, null);
  const job = JSON.parse(dispatched.stdout);
  assert.ok(job.id);

  const terminalStatus = runCompanion(
    ["status", job.id, "--wait", "--timeout-ms", "30000", "--json"],
    {
      cwd: root,
      env: pinned.env,
      timeout: 45_000,
      companionScript: pinned.codexCompanionScript
    }
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
  const record = spawnNonblockingStdin(
    pinned.codexCompanionScript,
    ["record-verification", job.id, "--verification-stdin", "--stdin-ready", "--json"],
    { cwd: root, env: pinned.env }
  );
  await waitFor(() => record.stderr.includes(STDIN_READY_MARKER), { timeoutMs: 15000 });
  assert.equal(record.child.exitCode, null, "verification command exited before Codex could write stdin");
  const verificationSplit = Math.floor(verification.length / 2);
  record.child.stdin.write(verification.slice(0, verificationSplit));
  await new Promise((resolve) => setTimeout(resolve, 25));
  record.child.stdin.end(verification.slice(verificationSplit));
  const recorded = await record.completed;
  assert.equal(recorded.code, 0, recorded.stderr || recorded.stdout);
  assert.equal(JSON.parse(recorded.stdout).result.hostVerification, "passed");
});

test("integration: delayed provider exposes job ID and meaningful progress", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, async () => {
  const root = initRepo();
  const { env } = fixture({ taskText: workerReport({ summary: "Slow final answer" }), delayMs: 1500 });
  const started = parseJson(runCompanion(
    ["task", "--background", "long running observability fixture", "--json"],
    { cwd: root, env }
  ));
  assert.ok(started.id);
  assert.ok(["queued", "running"].includes(started.status) || started.progress);

  const mid = await waitFor(() => {
    const status = runCompanion(["status", started.id, "--json"], { cwd: root, env });
    if (status.status !== 0) return null;
    const job = JSON.parse(status.stdout);
    if (job.progress && job.progress !== "Task accepted" && job.progress !== "Queued" && job.progress !== "Worker started") return job;
    if (job.lifecycleEvents?.some((event) => ["plan.updated", "activity.started", "checkpoint"].includes(event.type))) return job;
    return null;
  }, { timeoutMs: 5000 });

  assert.equal(mid.id, started.id);
  assert.ok(mid.progress);
  assert.ok(mid.heartbeatAt || mid.updatedAt);

  const finished = await waitFor(() => {
    const status = runCompanion(["status", started.id, "--json"], { cwd: root, env });
    if (status.status !== 0) return null;
    const job = JSON.parse(status.stdout);
    return job.status === "completed" ? job : null;
  }, { timeoutMs: 10000 });
  assert.equal(finished.status, "completed");
  assert.ok(finished.taskContract);
  assert.ok(finished.context);
  assert.equal(finished.result.hostVerification, "not_run");
  assert.ok(finished.lifecycleEvents.some((event) => event.type === "final.report"));
});

test("integration: structured task text stays off argv and public JSON omits private runtime identity", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, () => {
  const root = initRepo();
  const canary = "ARGV_CANARY_SHOULD_ONLY_REACH_PROVIDER_PROMPT_7f93";
  const { env, fake } = fixture({
    taskText: workerReport({
      summary: "Structured ingress completed",
      acceptanceResults: [{ id: "AC-01", status: "met" }]
    })
  });
  const envelope = {
    schemaVersion: 1,
    userRequest: canary,
    objective: "Verify structured ingress",
    mode: "read",
    scope: { include: [], exclude: [] },
    context: { workspaceState: "task_scoped", upstreamFreshness: "not_checked", requiredPaths: ["tracked.txt"] },
    acceptanceCriteria: [{ id: "AC-01", text: "Provider received the task through stdin" }],
    requiredVerification: [],
    expectedReturnFormat: "GROK_WORKER_REPORT JSON"
  };
  const result = runCompanion(
    ["task", "--wait", "--envelope-stdin", "--json"],
    { cwd: root, env, input: JSON.stringify(envelope) }
  );
  const job = parseJson(result);
  const providerArgv = readFakeLog(fake.logFile).filter((entry) => entry.event === "argv");
  assert.ok(providerArgv.length > 0);
  assert.equal(providerArgv.some((entry) => JSON.stringify(entry.args).includes(canary)), false);
  for (const privateField of ["userRequest", "workerProcess", "providerProcess", "workerAuthorization", "grokSessionId"]) {
    assert.equal(result.stdout.includes(`\"${privateField}\"`), false, `${privateField} leaked through public JSON`);
  }
  assert.equal(result.stdout.includes(canary), false, "literal task input leaked through public JSON");
  assert.equal(result.stdout.includes("fake-session-00000001"), false, "provider session ID leaked through lifecycle detail");
  assert.equal(job.result.workerReport.valid, true);
  assert.equal(job.result.hostVerification, "not_run");
});

test("integration: malformed task report gets one same-session format repair", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, () => {
  const root = initRepo();
  const repairedText = workerReport({ summary: "Repair succeeded" });
  const { env, fake } = fixture({
    taskTexts: [JSON.stringify({ summary: "wrong provider schema", evidence: [] }), repairedText]
  });
  const job = parseJson(runCompanion(["task", "--wait", "repair malformed final", "--json"], { cwd: root, env }));
  assert.equal(job.status, "completed");
  assert.equal(job.result.workerReport.valid, true);
  assert.equal(job.result.workerReport.summary, "Repair succeeded");
  assert.equal(job.result.reportRepair.attempted, true);
  assert.equal(job.result.reportRepair.valid, true);
  assert.equal(Array.isArray(job.result.workerReport.validationIssues), true);
  assert.equal(Array.isArray(job.result.providerClaims.changedFiles), true);
  const rendered = runCompanion(["result", job.id], { cwd: root, env });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /Outcome: complete/);
  assert.match(rendered.stdout, /Repair succeeded/);
  const prompts = readFakeLog(fake.logFile).filter((entry) => entry.event === "prompt");
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].sessionId, prompts[0].sessionId);
  assert.match(prompts[1].prompt, /Report-format repair only/);
  const promptRequests = readFakeLog(fake.logFile).filter(
    (entry) => entry.event === "rpc" && entry.message?.method === "session/prompt"
  );
  assert.equal(promptRequests.length, 2);
  assert.equal(
    typeof promptRequests[1].message.params?._meta?.outputSchema,
    "object"
  );
  const invocations = readFakeLog(fake.logFile).filter((entry) => entry.event === "argv" && entry.args.includes("agent"));
  assert.equal(invocations.length, 2);
  const repairProfileIndex = invocations[1].args.indexOf("--agent-profile");
  const stagedRepairProfile = invocations[1].args[repairProfileIndex + 1];
  assert.equal(fs.existsSync(stagedRepairProfile), false, "repair profile remained after verified provider exit");
  const repairProfile = fs.readFileSync(path.join(ROOT, "plugins/grok/provider-agents/report-repair.md"), "utf8");
  assert.match(repairProfile, /name: grok-companion-report-repair/);
  assert.match(repairProfile, /tools:\s*\n\s+- id: GrokBuild:todo_write/);
  assert.equal((repairProfile.match(/^\s+- id:/gm) || []).length, 1);
  assert.equal(repairProfile.includes("GrokBuild:search_replace"), false);
});

test("integration: two invalid task reports fail with E_SCHEMA and retain bounded repair evidence", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, () => {
  const root = initRepo();
  const { env, fake } = fixture({ taskTexts: ["not a worker report", "still not a worker report"] });
  const started = parseJson(runCompanion(
    ["task", "--background", "exercise invalid report failure", "--json"],
    { cwd: root, env }
  ));
  const failed = waitForBackgroundFailure(root, env, started.id);
  assert.equal(failed.error.code, "E_SCHEMA");
  assert.equal(failed.result.workerReport.valid, false);
  assert.equal(failed.result.providerClaims.success, false);
  assert.equal(failed.result.reportRepair.attempted, true);
  assert.equal(failed.result.reportRepair.valid, false);
  assert.ok(failed.result.reportRepair.initialResponse.bytes > 0);
  const invocations = readFakeLog(fake.logFile).filter((entry) => entry.event === "argv" && entry.args.includes("agent"));
  assert.equal(invocations.length, 2);
  const repairProfileIndex = invocations[1].args.indexOf("--agent-profile");
  assert.equal(fs.existsSync(invocations[1].args[repairProfileIndex + 1]), false, "failed repair retained its staged profile");
  assert.match(
    fs.readFileSync(path.join(ROOT, "plugins/grok/provider-agents/report-repair.md"), "utf8"),
    /tools:\s*\n\s+- id: GrokBuild:todo_write/
  );
});

test("integration: report-repair transport failures preserve their operational error code", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, () => {
  const root = initRepo();
  const { env } = fixture({
    taskTexts: ["not a worker report"],
    promptErrors: [null, "authentication expired"]
  });
  const started = parseJson(runCompanion(
    ["task", "--background", "exercise report repair auth failure", "--json"],
    { cwd: root, env }
  ));
  const failed = waitForBackgroundFailure(root, env, started.id);
  assert.equal(failed.error.code, "E_AUTH_REQUIRED");
  assert.equal(failed.result.workerReport.valid, false);
  assert.equal(failed.result.reportRepair.attempted, true);
  assert.equal(failed.result.reportRepair.valid, false);
  assert.equal(failed.result.reportRepair.error.code, "E_AUTH_REQUIRED");
});

test("integration: recorded host verification creates one scoped host-asserted continuation baseline", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, () => {
  const root = initRepo();
  const { env } = fixture({ taskText: workerReport() });
  const envelope = {
    schemaVersion: 1,
    userRequest: "prepare the fixture for host verification",
    objective: "Prepare verification fixture",
    mode: "read",
    scope: { include: ["tracked.txt"], exclude: [] },
    context: { workspaceState: "task_scoped", requiredPaths: ["tracked.txt"] },
    acceptanceCriteria: [
      { id: "AC-01", text: "Prepare the fixture" },
      { id: "AC-02", text: "Report the result" }
    ],
    requiredVerification: ["node verify-fixture.mjs"]
  };
  const job = parseJson(runCompanion(
    ["task", "--wait", "--envelope-stdin", "--json"],
    { cwd: root, env, input: JSON.stringify(envelope) }
  ));
  fs.writeFileSync(path.join(root, "tracked.txt"), "verification-created state\n");

  const premature = runCompanion(
    ["task", "--wait", "--job-id", job.id, "continue before verification record", "--json"],
    { cwd: root, env }
  );
  assert.notEqual(premature.status, 0);
  assert.match(premature.stdout, /E_CONTEXT_DRIFT/);

  const recorded = parseJson(runCompanion(
    ["record-verification", job.id, "--verification-stdin", "--json"],
    {
      cwd: root,
      env,
      input: JSON.stringify({
        commandOutcomes: [{ command: "node verify-fixture.mjs", status: "failed", exitCode: 1 }]
      })
    }
  ));
  assert.equal(recorded.result.hostVerification, "failed");
  assert.equal(recorded.result.verification.authority, "host_asserted");
  assert.deepEqual(recorded.result.verification.observedChangedPaths, ["tracked.txt"]);

  const duplicate = runCompanion(
    ["record-verification", job.id, "--verification-stdin", "--json"],
    {
      cwd: root,
      env,
      input: JSON.stringify({
        commandOutcomes: [{ command: "node verify-fixture.mjs", status: "failed", exitCode: 1 }]
      })
    }
  );
  assert.notEqual(duplicate.status, 0);
  assert.equal(JSON.parse(duplicate.stdout).error.code, "E_STATE");

  const resumed = parseJson(runCompanion(
    ["task", "--wait", "--job-id", job.id, "fix the recorded verification failure", "--json"],
    { cwd: root, env }
  ));
  assert.equal(resumed.resumeJobId, job.id);
});

test("integration: host verification rejects empty declarations and outcomes", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, () => {
  const root = initRepo();
  const { env } = fixture({ taskText: workerReport() });
  const envelope = {
    schemaVersion: 1,
    userRequest: "complete without declared host checks",
    objective: "No host checks",
    mode: "read",
    scope: { include: [], exclude: [] },
    context: { workspaceState: "task_scoped", requiredPaths: ["tracked.txt"] },
    acceptanceCriteria: [
      { id: "AC-01", text: "Complete the task" },
      { id: "AC-02", text: "Report the result" }
    ],
    requiredVerification: []
  };
  const job = parseJson(runCompanion(
    ["task", "--wait", "--envelope-stdin", "--json"],
    { cwd: root, env, input: JSON.stringify(envelope) }
  ));
  const rejected = runCompanion(
    ["record-verification", job.id, "--verification-stdin", "--json"],
    { cwd: root, env, input: JSON.stringify({ commandOutcomes: [] }) }
  );
  assert.notEqual(rejected.status, 0);
  assert.equal(JSON.parse(rejected.stdout).error.code, "E_USAGE");
});

test("integration: record-verification accepts pytest/Python cache drift and continues", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, () => {
  const root = initRepo();
  fs.writeFileSync(path.join(root, ".gitignore"), ".pytest_cache/\n__pycache__/\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-m", "ignore pytest and pycache");
  const { env } = fixture({ taskText: workerReport() });
  const envelope = {
    schemaVersion: 1,
    userRequest: "prepare cache-tolerant verification",
    objective: "Prepare cache-tolerant verification",
    mode: "read",
    scope: { include: ["tracked.txt"], exclude: [] },
    context: { workspaceState: "task_scoped", requiredPaths: ["tracked.txt"] },
    acceptanceCriteria: [
      { id: "AC-01", text: "Prepare the fixture" },
      { id: "AC-02", text: "Report the result" }
    ],
    requiredVerification: ["node verify-fixture.mjs", "npm run check"]
  };
  const job = parseJson(runCompanion(
    ["task", "--wait", "--envelope-stdin", "--json"],
    { cwd: root, env, input: JSON.stringify(envelope) }
  ));

  fs.mkdirSync(path.join(root, ".pytest_cache", "v"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pytest_cache", "v", "cache"), "nodeids\n");
  fs.mkdirSync(path.join(root, "src", "__pycache__"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "__pycache__", "mod.cpython-311.pyc"), "pyc");

  const recorded = parseJson(runCompanion(
    ["record-verification", job.id, "--verification-stdin", "--json"],
    {
      cwd: root,
      env,
      input: JSON.stringify({
        commandOutcomes: [
          { command: "node verify-fixture.mjs", status: "passed", exitCode: 0 },
          { command: "npm run check", status: "passed", exitCode: 0 }
        ]
      })
    }
  ));
  assert.equal(recorded.result.hostVerification, "passed");
  assert.equal(recorded.result.verification.authority, "host_asserted");
  assert.deepEqual(recorded.result.verification.observedChangedPaths, []);
  assert.deepEqual(recorded.result.runtimeEvidence.commandOutcomes, [
    { command: "node verify-fixture.mjs", status: "passed", exitCode: 0 },
    { command: "npm run check", status: "passed", exitCode: 0 }
  ]);

  const resumed = parseJson(runCompanion(
    ["task", "--wait", "--job-id", job.id, "continue after cache-only verification", "--json"],
    { cwd: root, env }
  ));
  assert.equal(resumed.resumeJobId, job.id);
});

test("integration: record-verification rejects cache drift mixed with meaningful ignored writes", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, () => {
  const root = initRepo();
  fs.writeFileSync(path.join(root, ".gitignore"), ".pytest_cache/\n__pycache__/\nsecret-output.txt\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-m", "ignore cache and secret output");
  const { env } = fixture({ taskText: workerReport() });
  const envelope = {
    schemaVersion: 1,
    userRequest: "prepare mixed ignored verification",
    objective: "Prepare mixed ignored verification",
    mode: "read",
    scope: { include: ["tracked.txt"], exclude: [] },
    context: { workspaceState: "task_scoped", requiredPaths: ["tracked.txt"] },
    acceptanceCriteria: [
      { id: "AC-01", text: "Prepare the fixture" },
      { id: "AC-02", text: "Report the result" }
    ],
    requiredVerification: ["node verify-fixture.mjs"]
  };
  const job = parseJson(runCompanion(
    ["task", "--wait", "--envelope-stdin", "--json"],
    { cwd: root, env, input: JSON.stringify(envelope) }
  ));

  fs.mkdirSync(path.join(root, ".pytest_cache"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pytest_cache", "CACHEDIR.TAG"), "tag\n");
  fs.writeFileSync(path.join(root, "secret-output.txt"), "out-of-scope ignored write\n");

  const rejected = runCompanion(
    ["record-verification", job.id, "--verification-stdin", "--json"],
    {
      cwd: root,
      env,
      input: JSON.stringify({
        commandOutcomes: [{ command: "node verify-fixture.mjs", status: "passed", exitCode: 0 }]
      })
    }
  );
  assert.notEqual(rejected.status, 0);
  const error = JSON.parse(rejected.stdout).error;
  assert.equal(error.code, "E_SCOPE_VIOLATION");
  assert.deepEqual(error.details.paths, ["secret-output.txt"]);
});

test("integration: commandOutcomes contract accepts complete/partial records and rejects invalid shapes", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, () => {
  const root = initRepo();
  const requiredVerification = ["node verify-fixture.mjs", "npm run check"];
  const baseEnvelope = {
    schemaVersion: 1,
    userRequest: "exercise verification contract",
    objective: "Exercise verification contract",
    mode: "read",
    scope: { include: ["tracked.txt"], exclude: [] },
    context: { workspaceState: "task_scoped", requiredPaths: ["tracked.txt"] },
    acceptanceCriteria: [
      { id: "AC-01", text: "Prepare the fixture" },
      { id: "AC-02", text: "Report the result" }
    ],
    requiredVerification
  };

  const rejectCase = (label, input, setup = {}) => {
    const { env } = fixture({ taskText: workerReport() });
    const job = parseJson(runCompanion(
      ["task", "--wait", "--envelope-stdin", "--json"],
      { cwd: root, env, input: JSON.stringify({ ...baseEnvelope, ...setup.envelope }) }
    ));
    const rejected = runCompanion(
      ["record-verification", job.id, "--verification-stdin", "--json"],
      { cwd: root, env, input: JSON.stringify(input) }
    );
    assert.notEqual(rejected.status, 0, label);
    assert.equal(JSON.parse(rejected.stdout).error.code, "E_USAGE", label);
  };

  rejectCase("missing status", {
    commandOutcomes: [{ command: "node verify-fixture.mjs", exitCode: 0 }]
  });
  rejectCase("non-declared command", {
    commandOutcomes: [{ command: "node not-declared.mjs", status: "passed", exitCode: 0 }]
  });
  rejectCase("incomplete passing record", {
    commandOutcomes: [{ command: "node verify-fixture.mjs", status: "passed", exitCode: 0 }]
  });
  rejectCase("duplicate command", {
    commandOutcomes: [
      { command: "node verify-fixture.mjs", status: "passed", exitCode: 0 },
      { command: "node verify-fixture.mjs", status: "passed", exitCode: 0 }
    ]
  });
  rejectCase("unsupported output field", {
    commandOutcomes: [{
      command: "node verify-fixture.mjs",
      status: "passed",
      exitCode: 0,
      output: "should not be recorded"
    }]
  });
  rejectCase("unsupported root field", {
    commandOutcomes: [{ command: "npm run check", status: "failed", exitCode: 1 }],
    summary: "not part of the contract"
  });
  rejectCase("more than 64 outcomes", {
    commandOutcomes: Array.from({ length: 65 }, () => ({
      command: "node verify-fixture.mjs",
      status: "failed",
      exitCode: 1
    }))
  });

  {
    const { env } = fixture({ taskText: workerReport() });
    const job = parseJson(runCompanion(
      ["task", "--wait", "--envelope-stdin", "--json"],
      { cwd: root, env, input: JSON.stringify(baseEnvelope) }
    ));
    const partial = parseJson(runCompanion(
      ["record-verification", job.id, "--verification-stdin", "--json"],
      {
        cwd: root,
        env,
        input: JSON.stringify({
          commandOutcomes: [{ command: "npm run check", status: "failed", exitCode: 1 }]
        })
      }
    ));
    assert.equal(partial.result.hostVerification, "failed");
    assert.equal(partial.result.verification.authority, "host_asserted");
    assert.deepEqual(partial.result.runtimeEvidence.commandOutcomes, [
      { command: "npm run check", status: "failed", exitCode: 1 }
    ]);
  }

  {
    const { env } = fixture({ taskText: workerReport() });
    const job = parseJson(runCompanion(
      ["task", "--wait", "--envelope-stdin", "--json"],
      { cwd: root, env, input: JSON.stringify(baseEnvelope) }
    ));
    const complete = parseJson(runCompanion(
      ["record-verification", job.id, "--verification-stdin", "--json"],
      {
        cwd: root,
        env,
        input: JSON.stringify({
          commandOutcomes: [
            { command: "node verify-fixture.mjs", status: "passed", exitCode: 0 },
            { command: "npm run check", status: "passed", exitCode: 0 }
          ]
        })
      }
    ));
    assert.equal(complete.result.hostVerification, "passed");
    assert.deepEqual(complete.result.runtimeEvidence.commandOutcomes, [
      { command: "node verify-fixture.mjs", status: "passed", exitCode: 0 },
      { command: "npm run check", status: "passed", exitCode: 0 }
    ]);
  }
});

test("integration: host verification cannot rebase a lineage while a writer is active", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, async () => {
  const root = initRepo();
  const { env, pluginData } = fixture({ taskText: workerReport() });
  const priorEnvelope = {
    schemaVersion: 1,
    userRequest: "prepare a verification checkpoint",
    objective: "Prepare verification checkpoint",
    mode: "read",
    scope: { include: [], exclude: [] },
    context: { workspaceState: "task_scoped", requiredPaths: ["tracked.txt"] },
    acceptanceCriteria: [
      { id: "AC-01", text: "Complete the task" },
      { id: "AC-02", text: "Report the result" }
    ],
    requiredVerification: ["node verify-fixture.mjs"]
  };
  const prior = parseJson(runCompanion(
    ["task", "--wait", "--envelope-stdin", "--json"],
    { cwd: root, env, input: JSON.stringify(priorEnvelope) }
  ));

  const blockingFake = installFakeGrok(tempDir("grok-cp-writer-"), { cancelMode: "wait" });
  const writerEnv = testEnvironment({ fake: blockingFake, pluginData });
  delete writerEnv.GROK_COMPANION_CHILD;
  delete writerEnv.GROK_COMPANION_JOB_MARKER;
  delete writerEnv.GROK_AGENT;
  delete writerEnv.GROK_LEADER_SOCKET;
  const writerEnvelope = {
    schemaVersion: 1,
    userRequest: "hold the writer lease",
    objective: "Hold writer lease",
    mode: "write",
    scope: { include: ["tracked.txt"], exclude: [] },
    context: { workspaceState: "task_scoped", requiredPaths: ["tracked.txt"] },
    acceptanceCriteria: [{ id: "AC-01", text: "Wait until cancelled" }],
    requiredVerification: []
  };
  const writer = parseJson(runCompanion(
    ["task", "--background", "--write", "--envelope-stdin", "--json"],
    { cwd: root, env: writerEnv, input: JSON.stringify(writerEnvelope) }
  ));

  const rejected = runCompanion(
    ["record-verification", prior.id, "--verification-stdin", "--json"],
    {
      cwd: root,
      env,
      input: JSON.stringify({
        commandOutcomes: [{ command: "node verify-fixture.mjs", status: "passed", exitCode: 0 }]
      })
    }
  );
  assert.notEqual(rejected.status, 0);
  assert.equal(JSON.parse(rejected.stdout).error.code, "E_JOB_ACTIVE");

  parseJson(runCompanion(["cancel", writer.id, "--json"], { cwd: root, env: writerEnv }));
  await waitFor(() => {
    const status = runCompanion(["status", writer.id, "--json"], { cwd: root, env: writerEnv });
    if (status.status !== 0) return null;
    return ["cancelled", "failed"].includes(JSON.parse(status.stdout).status);
  }, { timeoutMs: 10000 });
});

test("integration: ignored out-of-scope task writes fail with E_SCOPE_VIOLATION", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, () => {
  const root = initRepo();
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored-output.txt\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-m", "ignore generated output");
  const ignored = path.join(root, "ignored-output.txt");
  fs.writeFileSync(ignored, "original ignored value\n");
  const { env } = fixture({
    taskText: workerReport({ acceptanceResults: [{ id: "AC-01", status: "met" }] }),
    taskMutatePath: ignored,
    taskMutation: "changed outside delegated scope\n"
  });
  const envelope = {
    schemaVersion: 1,
    userRequest: "edit only tracked.txt",
    objective: "Bounded ignored-scope fixture",
    mode: "write",
    scope: { include: ["tracked.txt"], exclude: [] },
    context: { workspaceState: "task_scoped", requiredPaths: ["tracked.txt"] },
    acceptanceCriteria: [{ id: "AC-01", text: "Only tracked.txt may change" }],
    requiredVerification: []
  };
  const result = runCompanion(
    ["task", "--wait", "--write", "--envelope-stdin", "--json"],
    { cwd: root, env, input: JSON.stringify(envelope) }
  );
  assert.notEqual(result.status, 0);
  const error = JSON.parse(result.stdout).error;
  assert.equal(error.code, "E_SCOPE_VIOLATION");
  assert.deepEqual(error.details.paths, ["ignored-output.txt"]);
});

test("integration: interim/final separation, resume by job ID, context drift", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, async () => {
  const root = initRepo();
  const interim = "INTERIM_SHOULD_NOT_ENTER_WORKER_REPORT";
  const finalText = workerReport({ summary: "FINAL_ANSWER_ONLY_FOR_REPORT" });
  const { env, pluginData } = fixture({ interimText: interim, taskText: finalText, toolAfterFinal: true });
  const job = parseJson(runCompanion(["task", "--wait", "separate interim final", "--json"], { cwd: root, env }));
  assert.equal(job.result.workerReport.summary, "FINAL_ANSWER_ONLY_FOR_REPORT");
  assert.equal(job.result.interim.bytes, Buffer.byteLength(interim));
  assert.equal(JSON.stringify(job.result.workerReport).includes(interim), false);
  assert.equal(job.result.hostVerification, "not_run");
  assert.equal(job.taskContract.objective, null);
  assert.equal(JSON.stringify(job).includes("separate interim final"), false);

  const resumed = parseJson(runCompanion(
    ["task", "--wait", "--job-id", job.id, "continue from explicit job", "--json"],
    { cwd: root, env }
  ));
  assert.equal(resumed.resumeJobId, job.id);

  const hostlessEnv = { ...env };
  delete hostlessEnv.GROK_COMPANION_HOST_SESSION_ID;
  delete hostlessEnv.GROK_COMPANION_CLAUDE_SESSION_ID;
  delete hostlessEnv.CLAUDE_SESSION_ID;
  const hostlessResume = runCompanion(
    ["task", "--wait", "--job-id", job.id, "hostless caller must not resume", "--json"],
    { cwd: root, env: hostlessEnv }
  );
  assert.notEqual(hostlessResume.status, 0, hostlessResume.stdout);
  assert.match(hostlessResume.stdout, /E_JOB_NOT_FOUND/);

  const { readJob, writeJob } = await import("../plugins/grok/scripts/lib/state.mjs");
  const previousData = process.env.CLAUDE_PLUGIN_DATA;
  const previousHost = process.env.GROK_COMPANION_HOST;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  process.env.GROK_COMPANION_HOST = "claude-code";
  try {
    const forged = readJob(fs.realpathSync(root), job.id);
    forged.completionContextManifest = {
      ...forged.completionContextManifest,
      workspaceRoot: "/tmp/definitely-not-this-workspace"
    };
    writeJob(root, forged);
  } finally {
    if (previousData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousData;
    if (previousHost === undefined) delete process.env.GROK_COMPANION_HOST;
    else process.env.GROK_COMPANION_HOST = previousHost;
  }

  const drift = runCompanion(
    ["task", "--wait", "--job-id", job.id, "should fail drift", "--json"],
    { cwd: root, env }
  );
  assert.notEqual(drift.status, 0, drift.stdout);
  assert.match(`${drift.stderr}\n${drift.stdout}`, /E_CONTEXT_DRIFT/);
});
