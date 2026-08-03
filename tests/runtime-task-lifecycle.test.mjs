import {
  assert, crypto, fs, os, path, test,
  spawn, processGroupAlive, processStartToken, hasForeignActiveProvider, registerProviderGuard, unregisterProviderGuard,
  generateId, logFile, readJob, updateJob, writeJob, profileFor,
  workspaceState, CompanionError, attachTransferCleanupEvidence, asErrorPayload, redact, spawnReadOnlyWorker,
  assertContextCompatible, buildRuntimeEvidence, buildTaskEnvelope, captureContextManifest, evaluateScope, observeChangedPaths,
  scrubStoredJob, launchContractDigest, captureTerminalEvidence, normalizeTerminalProcessSignalError, selectTaskTerminalError, installFakeGrok,
  readFakeLog, installPinnedFakeCompanion, CODEX_COMPANION, COMPANION, ROOT, git,
  initRepo, runCodexCompanion, runCompanion, spawnNonblockingStdin, tempDir, testEnvironment,
  waitFor, missingInvalidProviderCapabilityReceiptMessage, pluginDataRoot, writeCodexSessionMetadata, parseJson, parseError,
  taskReport, fixture, codexTaskEnv, agentStdioCount, receiptPathFor, pluginDataForJobs,
  canonicalReceiptAdmissionMessage, transferFixture, injectedImportSignalEnv, transferGuardDirectories, assertTransferRuntimeArtifactsGone, spawnCompanion,
  persistedJobs, persistedJob, writeEnvelope, seedTerminalTaskJob, seedWorkspace, writeSeededJob,
  codexBrokerFixture, spawnPendingBrokerJob
} from "./runtime-test-support.mjs";

test("empty review target records a skipped empty-target result without claiming session deletion", () => {
  const root = initRepo();
  const { env } = fixture();
  const result = runCompanion(["review", "--scope", "working-tree", "--json"], { cwd: root, env });
  const job = parseJson(result);
  assert.equal(job.status, "completed");
  assert.equal(job.phase, "done");
  assert.equal(Object.hasOwn(job, "grokSessionId"), false);
  assert.equal(job.result.skipped, true);
  assert.equal(job.result.skipReason, "empty-target");
  assert.equal(job.result.providerSessionDeleted, false);
  assert.equal(job.result.review.verdict, "pass");
  assert.deepEqual(job.result.review.findings, []);

  const human = runCompanion(["result", job.id], { cwd: root, env });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Grok session: not started \(empty target\)/);
  assert.equal(human.stdout.includes("deleted after review"), false);
});

test("runtime review validates structured output, preserves workspace integrity, and deletes provider session", () => {
  const root = initRepo();
  fs.appendFileSync(path.join(root, "tracked.txt"), "review me\n");
  const before = fs.readFileSync(path.join(root, "tracked.txt"), "utf8");
  const secret = "xai-abcdefghijklmnop";
  const { fake, env, pluginData } = fixture({
    unknownSecret: secret,
    review: {
      verdict: "needs_changes",
      summary: "One fake issue.",
      findings: [
        {
          severity: "high",
          title: "Fake finding",
          body: "The fixture demonstrates deterministic rendering.",
          file: "tracked.txt",
          line: 1
        }
      ]
    }
  });

  const result = runCompanion(["review", "--wait", "--json"], { cwd: root, env });
  const job = parseJson(result);
  assert.equal(job.kind, "review");
  assert.equal(job.status, "completed");
  assert.equal(job.phase, "done");
  assert.equal(job.write, false);
  assert.equal(job.profileId, "review-v1");
  assert.equal(job.result.review.verdict, "needs_changes");
  assert.equal(job.result.providerSessionDeleted, true);
  assert.equal(fs.readFileSync(path.join(root, "tracked.txt"), "utf8"), before);
  const stored = persistedJob(pluginData, job.id);
  assert.equal(stored.request.prompt, null);
  assert.match(stored.request.promptDigest, /^[a-f0-9]{64}$/);

  const providerLog = readFakeLog(fake.logFile);
  assert.equal(providerLog.some((entry) => entry.event === "delete-session"), false);
  const reviewInvocation = providerLog.find((entry) => entry.event === "headless");
  assert.ok(reviewInvocation);
  assert.equal(reviewInvocation.args[reviewInvocation.args.indexOf("--agent") + 1], "explore");
  assert.match(reviewInvocation.args[reviewInvocation.args.indexOf("--sandbox") + 1], /^companion_[a-f0-9]{20}$/);
  assert.equal(reviewInvocation.args[reviewInvocation.args.indexOf("--permission-mode") + 1], "default");
  assert.ok(reviewInvocation.args.includes("--no-subagents"));
  assert.ok(reviewInvocation.args.includes("--json-schema"));
  assert.equal(reviewInvocation.args[reviewInvocation.args.indexOf("--tools") + 1], "todo_write");
  assert.ok(reviewInvocation.args.includes("MCPTool(*)"));
  assert.equal(providerLog.some((entry) => entry.event === "rpc"), false);
  const persistedLog = fs.readFileSync(stored.logFile, "utf8");
  assert.equal(persistedLog.includes(secret), false);

  const human = runCompanion(["result", job.id], { cwd: root, env });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Verdict: needs_changes/);
  assert.match(human.stdout, /\[HIGH\] Fake finding \(tracked\.txt:1\)/);
});

test("runtime write task forwards model and effort under the write security profile", () => {
  const root = initRepo();
  const { fake, env, pluginData } = fixture({ taskText: taskReport("Implemented the requested fake change and ran tests.", ["AC-01"]) });
  const result = runCompanion(
    ["task", "--wait", "--write", "--model", "grok-test", "--effort", "high", "--envelope-stdin", "--json"],
    { cwd: root, env, input: writeEnvelope("implement fixture") }
  );
  const job = parseJson(result);
  const stored = persistedJob(pluginData, job.id);
  assert.equal(job.kind, "task");
  assert.equal(job.status, "completed");
  assert.equal(job.write, true);
  assert.equal(job.model, "grok-test");
  assert.equal(job.effort, "high");
  assert.equal(job.profileId, "rescue-write-v3");
  assert.equal(stored.profile.transport, "acp");
  assert.equal(stored.profile.agent, "build");
  assert.equal(stored.profile.sandbox, "strict");
  assert.equal(stored.profile.permissionMode, "acceptEdits");
  assert.match(stored.result.text, /Implemented the requested fake change and ran tests\./);
  assert.equal(stored.request.prompt, null);
  assert.match(stored.request.promptDigest, /^[a-f0-9]{64}$/);
  assert.ok(stored.providerProcess.pid > 0);
  assert.ok(stored.grokSessionId);

  const providerLog = readFakeLog(fake.logFile);
  const invocation = providerLog.find(
    (entry) => entry.event === "argv" && entry.args.includes("agent")
  );
  assert.match(invocation.args[invocation.args.indexOf("--sandbox") + 1], /^companion_[a-f0-9]{20}$/);
  assert.ok(invocation.args.includes("acceptEdits"));
  assert.equal(invocation.args.includes("--always-approve"), false);
  assert.ok(invocation.args.includes("grok-test"));
  assert.ok(invocation.args.includes("high"));
  assert.equal(invocation.args.includes("--tools"), false);
  assert.equal(invocation.args.includes("--disallowed-tools"), false);
  assert.ok(invocation.args.includes("--agent-profile"));
  assert.equal(invocation.args.at(-1), "stdio");
  assert.equal(invocation.args.includes("explore"), false);
  assert.ok(providerLog.some((entry) => entry.event === "rpc" && entry.message.method === "session/prompt"));
  assert.equal(providerLog.some((entry) => entry.event === "headless"), false);
});

test("successful task storage digests duplicate private objectives and preserves a distinct public objective", () => {
  const root = initRepo();
  const { env, pluginData } = fixture({ taskText: taskReport("Stored request privacy complete", ["AC-01"]) });
  const privateRequest = "private terminal request literal 8de43c3f";
  const expectedDigest = crypto.createHash("sha256").update(privateRequest).digest("hex");
  const launchEnvelope = buildTaskEnvelope({ userRequest: privateRequest, objective: privateRequest });
  const launchJob = {
    id: "task-launch-privacy",
    kind: "task",
    jobClass: "task",
    write: false,
    title: privateRequest,
    host: { kind: "codex", sessionId: "privacy-test-thread" },
    controlWorkspaceId: "privacy-test-workspace",
    profile: null,
    role: null,
    model: null,
    effort: null,
    request: {
      prompt: "assembled provider prompt",
      promptDigest: null,
      providerPromptDigest: crypto.createHash("sha256").update("assembled provider prompt").digest("hex"),
      publicObjective: privateRequest,
      envelope: launchEnvelope,
      spawn: {}
    }
  };
  const scrubbedLaunchJob = scrubStoredJob(launchJob);
  assert.equal(launchContractDigest(scrubbedLaunchJob), launchContractDigest(launchJob));
  assert.equal(scrubbedLaunchJob.title, `task:${expectedDigest.slice(0, 24)}`);

  const duplicate = parseJson(runCompanion(
    ["task", "--wait", "--write", "--envelope-stdin", "--json"],
    { cwd: root, env, input: writeEnvelope(privateRequest) }
  ));
  assert.equal(duplicate.status, "completed");
  const duplicateStored = persistedJob(pluginData, duplicate.id);
  assert.equal(duplicateStored.request.prompt, null);
  assert.match(duplicateStored.request.promptDigest, /^[a-f0-9]{64}$/);
  assert.equal(duplicateStored.request.envelope.userRequest, null);
  assert.equal(duplicateStored.request.envelope.userRequestDigest, expectedDigest);
  assert.equal(duplicateStored.request.envelope.objective, expectedDigest);
  assert.equal(duplicateStored.request.publicObjective, null);
  assert.equal(duplicateStored.title, `task:${expectedDigest.slice(0, 24)}`);
  assert.equal(JSON.stringify(duplicateStored).includes(privateRequest), false);

  const publicObjective = "Summarize the bounded fixture change";
  const distinct = parseJson(runCompanion(
    ["task", "--wait", "--write", "--envelope-stdin", "--json"],
    { cwd: root, env, input: writeEnvelope(privateRequest, { objective: publicObjective }) }
  ));
  assert.equal(distinct.status, "completed");
  const distinctStored = persistedJob(pluginData, distinct.id);
  assert.equal(distinctStored.request.envelope.userRequest, null);
  assert.equal(distinctStored.request.envelope.userRequestDigest, expectedDigest);
  assert.equal(distinctStored.request.envelope.objective, publicObjective);
  assert.equal(distinctStored.request.publicObjective, publicObjective);
  assert.equal(distinctStored.title, publicObjective);
  assert.equal(JSON.stringify(distinctStored).includes(privateRequest), false);
});

test("resume candidates preserve read/write profiles and never escalate an existing session", () => {
  const root = initRepo();
  const { fake, env, pluginData } = fixture({
    taskTexts: [
      taskReport("Profile-specific read result."),
      taskReport("Profile-specific write result.", ["AC-01"]),
      taskReport("Profile-specific resumed write result.", ["AC-01"])
    ]
  });

  const read = parseJson(runCompanion(
    ["task", "--wait", "--fresh", "read-only investigation", "--json"],
    { cwd: root, env }
  ));
  assert.equal(read.profileId, "rescue-read-v3");
  const readCandidate = parseJson(runCompanion(["task-resume-candidate", "--json"], { cwd: root, env }));
  assert.deepEqual(readCandidate, {
    available: true,
    jobId: read.id,
    profileId: "rescue-read-v3"
  });

  const escalated = runCompanion(
    ["task", "--wait", "--write", "--resume", "--envelope-stdin", "--json"],
    { cwd: root, env, input: writeEnvelope("attempt privilege escalation") }
  );
  parseError(escalated, "E_NO_RESUME_CANDIDATE");

  const write = parseJson(runCompanion(
    ["task", "--wait", "--write", "--fresh", "--envelope-stdin", "--json"],
    { cwd: root, env, input: writeEnvelope("write-profile implementation") }
  ));
  assert.equal(write.profileId, "rescue-write-v3");
  const storedWrite = persistedJob(pluginData, write.id);
  const writeCandidate = parseJson(runCompanion(["task-resume-candidate", "--write", "--json"], { cwd: root, env }));
  assert.deepEqual(writeCandidate, {
    available: true,
    jobId: write.id,
    profileId: "rescue-write-v3"
  });

  const resumed = parseJson(runCompanion(
    ["task", "--wait", "--write", "--resume", "--envelope-stdin", "--json"],
    { cwd: root, env, input: writeEnvelope("continue write-profile work") }
  ));
  const storedResumed = persistedJob(pluginData, resumed.id);
  assert.equal(storedResumed.grokSessionId, storedWrite.grokSessionId);
  assert.equal(storedResumed.request.resumeSessionId, storedWrite.grokSessionId);
  assert.ok(readFakeLog(fake.logFile).some((entry) =>
    entry.event === "rpc" && entry.message.method === "session/load" && entry.message.params.sessionId === storedWrite.grokSessionId
  ));
});

test("resume candidates accept failed and cancelled terminal tasks with a Grok session id", () => {
  {
    // realpath so workspaceState hash matches companion's workspaceRoot resolution
    const root = fs.realpathSync(initRepo());
    const { env } = fixture();
    const failedSession = "11111111-1111-4111-8111-111111111111";
    const failedId = seedTerminalTaskJob(root, env, { status: "failed", grokSessionId: failedSession });
    const candidate = parseJson(runCompanion(["task-resume-candidate", "--json"], { cwd: root, env }));
    assert.deepEqual(candidate, {
      available: true,
      jobId: failedId,
      profileId: "rescue-read-v3"
    });
  }

  {
    const root = fs.realpathSync(initRepo());
    const { env } = fixture();
    const cancelledSession = "22222222-2222-4222-8222-222222222222";
    const cancelledId = seedTerminalTaskJob(root, env, {
      status: "cancelled",
      grokSessionId: cancelledSession
    });
    const candidate = parseJson(runCompanion(["task-resume-candidate", "--json"], { cwd: root, env }));
    assert.deepEqual(candidate, {
      available: true,
      jobId: cancelledId,
      profileId: "rescue-read-v3"
    });
  }
});

test("resume candidates reject queued and running tasks even when a Grok session id is present", () => {
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  seedTerminalTaskJob(root, env, {
    status: "queued",
    grokSessionId: "33333333-3333-4333-8333-333333333333"
  });
  seedTerminalTaskJob(root, env, {
    status: "running",
    grokSessionId: "44444444-4444-4444-8444-444444444444"
  });

  const candidate = parseJson(runCompanion(["task-resume-candidate", "--json"], { cwd: root, env }));
  assert.deepEqual(candidate, {
    available: false,
    jobId: null,
    profileId: null
  });

  const resume = runCompanion(
    ["task", "--wait", "--resume", "should not resume active work", "--json"],
    { cwd: root, env }
  );
  parseError(resume, "E_NO_RESUME_CANDIDATE");
});

test("explicit resume completes pending lineage cleanup before provider admission", () => {
  const root = fs.realpathSync(initRepo());
  const { env, pluginData } = fixture();
  const first = parseJson(runCompanion(["task", "--wait", "seed resumable cleanup lineage", "--json"], { cwd: root, env }));
  const stored = persistedJob(pluginData, first.id);
  const stateRoot = path.dirname(path.dirname(stored.logFile));
  const taskHome = path.join(stateRoot, "task-homes", stored.request.providerHomeId, ".grok");
  fs.mkdirSync(path.join(taskHome, "agent-profiles"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(taskHome, "auth.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(taskHome, "agent-profiles", "pending.md"), "profile\n", { mode: 0o600 });
  const jobFile = path.join(stateRoot, "jobs", `${first.id}.json`);
  fs.writeFileSync(jobFile, `${JSON.stringify({
    ...stored,
    result: { ...(stored.result || {}), taskRuntimeCleaned: false, privacyWarning: "cleanup pending" }
  }, null, 2)}\n`, { mode: 0o600 });

  const resumed = parseJson(runCompanion(["task", "--wait", "--job-id", first.id, "continue after cleanup", "--json"], { cwd: root, env }));
  assert.equal(resumed.resumeJobId, first.id);
  assert.equal(resumed.status, "completed");
  assert.equal(persistedJob(pluginData, first.id).result.taskRuntimeCleaned, true);
  assert.equal(fs.existsSync(path.join(taskHome, "auth.json")), false);
  assert.equal(fs.existsSync(path.join(taskHome, "agent-profiles")), false);
});

test("concurrent read-only continuations admit only one job per provider lineage", { skip: process.platform === "win32" }, async () => {
  const root = fs.realpathSync(initRepo());
  const { fake, pluginData, env } = fixture({ cancelMode: "wait" });
  const priorId = seedTerminalTaskJob(root, env, {
    status: "completed",
    grokSessionId: "55555555-5555-4555-8555-555555555555"
  });
  const args = ["task", "--background", "--job-id", priorId, "continue shared lineage", "--json"];
  const first = spawnCompanion(args, { cwd: root, env });
  const second = spawnCompanion(args, { cwd: root, env });
  const outcomes = await Promise.all([first.completed, second.completed]);
  const successes = outcomes.filter((outcome) => outcome.code === 0);
  const failures = outcomes.filter((outcome) => outcome.code !== 0);
  assert.equal(successes.length, 1, JSON.stringify(outcomes));
  assert.equal(failures.length, 1, JSON.stringify(outcomes));
  const rejected = JSON.parse(failures[0].stdout);
  assert.equal(rejected.error?.code, "E_JOB_ACTIVE");
  assert.equal(rejected.error?.details?.conflictingProviderHomeId, priorId);

  const started = JSON.parse(successes[0].stdout);
  const running = await waitFor(() => {
    const job = persistedJob(pluginData, started.id);
    return job.status === "running" && job.providerProcess?.pid ? job : false;
  }, { timeoutMs: 10_000 });
  assert.equal(running.request.providerHomeId, priorId);
  const providerStarts = await waitFor(() => {
    const starts = readFakeLog(fake.logFile).filter((entry) => entry.event === "argv" && entry.args.includes("agent") && entry.args.includes("stdio"));
    return starts.length === 1 ? starts : false;
  }, { timeoutMs: 5000 });
  assert.equal(providerStarts.length, 1, "rejected continuation launched a second provider");

  const cancelled = parseJson(runCompanion(["cancel", started.id, "--json"], { cwd: root, env, timeout: 15_000 }));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.result?.taskRuntimeCleaned, true);
  const stored = persistedJob(pluginData, started.id);
  const grokHome = path.join(path.dirname(path.dirname(stored.logFile)), "task-homes", priorId, ".grok");
  assert.equal(fs.existsSync(path.join(grokHome, "auth.json")), false);
  assert.equal(fs.existsSync(path.join(grokHome, "agent-profiles")), false);
});

test("three independent Codex read envelopes run concurrently with isolated provider profiles", { skip: process.platform === "win32" }, async () => {
  const root = fs.realpathSync(initRepo());
  const { fake, pluginData, env } = fixture({
    delayMs: 1500,
    requireAgentProfileUnderGrokHome: true
  });
  const dispatches = ["stdin", "profile", "lifecycle"].map((slice) => {
    const dispatch = spawnNonblockingStdin(
      CODEX_COMPANION,
      ["task", "--background", "--envelope-stdin", "--stdin-ready", "--fresh", "--json"],
      { cwd: root, env, timeout: 20_000 }
    );
    return { slice, dispatch };
  });

  await waitFor(
    () => dispatches.every(({ dispatch }) => dispatch.stderr.includes("GROK_COMPANION_STDIN_READY")),
    { timeoutMs: 5000 }
  );
  assert.equal(
    readFakeLog(fake.logFile).filter((entry) => entry.event === "argv" && entry.args.includes("agent") && entry.args.includes("stdio")).length,
    0,
    "a provider started before its private TaskEnvelope arrived"
  );

  for (const { slice, dispatch } of dispatches) {
    dispatch.child.stdin.end(writeEnvelope(`inspect ${slice}`, {
      mode: "read",
      scope: { include: ["tracked.txt"], exclude: [] },
      acceptanceCriteria: [
        { id: "AC-01", text: `Inspect the ${slice} slice` },
        { id: "AC-02", text: "Return a structured read-only report" }
      ]
    }));
  }
  const accepted = await Promise.all(dispatches.map(({ dispatch }) => dispatch.completed));
  assert.ok(accepted.every((outcome) => outcome.code === 0), JSON.stringify(accepted));
  const jobIds = accepted.map((outcome) => JSON.parse(outcome.stdout).id);
  assert.equal(new Set(jobIds).size, 3);

  const overlapping = await waitFor(() => {
    const jobs = jobIds.map((id) => persistedJob(pluginData, id));
    return jobs.every((job) => job.status === "running" && job.providerProcess?.pid) ? jobs : false;
  }, { timeoutMs: 10_000 });
  assert.equal(new Set(overlapping.map((job) => job.request.providerHomeId)).size, 3);

  const terminal = await waitFor(() => {
    const jobs = jobIds.map((id) => persistedJob(pluginData, id));
    return jobs.every((job) => ["completed", "failed", "cancelled"].includes(job.status)) ? jobs : false;
  }, { timeoutMs: 20_000 });
  for (const job of terminal) {
    assert.equal(job.status, "completed", JSON.stringify(job.error));
    assert.equal(job.error, null);
    assert.equal(job.result?.workerReport?.outcome, "complete");
    assert.equal(job.result?.taskRuntimeCleaned, true);
    assert.deepEqual(job.result?.runtimeEvidence?.observedChangedPaths, []);
  }

  const profiles = readFakeLog(fake.logFile).filter((entry) => entry.event === "agent-profile");
  assert.equal(profiles.length, 3);
  assert.equal(new Set(profiles.map((entry) => entry.path)).size, 3);
  for (const profile of profiles) {
    assert.equal(profile.exists, true);
    assert.equal(profile.insideGrokHome, true);
    assert.equal(profile.mode, 0o600);
    assert.equal(fs.existsSync(profile.path), false, "provider profile remained after verified job cleanup");
  }
});

test("background task is durable across command processes and supports status, wait, and result", () => {
  const root = initRepo();
  const { env, pluginData } = fixture({ taskText: taskReport("Background fake result"), delayMs: 250 });
  const launch = parseJson(runCompanion(
    ["task", "--background", "background fixture", "--json"],
    { cwd: root, env }
  ));
  assert.equal(launch.status, "queued");
  assert.equal(Object.hasOwn(launch, "workerProcess"), false);

  const waited = parseJson(runCompanion(
    ["status", launch.id, "--wait", "--timeout-ms", "10000", "--json"],
    { cwd: root, env, timeout: 15000 }
  ));
  assert.equal(waited.status, "completed");
  const stored = persistedJob(pluginData, launch.id);
  assert.match(stored.result.text, /Background fake result/);
  assert.equal(stored.request.prompt, null);
  assert.match(stored.request.promptDigest, /^[a-f0-9]{64}$/);

  const result = parseJson(runCompanion(["result", launch.id, "--json"], { cwd: root, env }));
  assert.equal(result.id, launch.id);
  assert.equal(result.status, "completed");

  const listing = runCompanion(["status"], { cwd: root, env });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, new RegExp(launch.id));
  assert.match(listing.stdout, /completed/);
});

test("task results redact provider secrets in immediate, stored, JSON, and human output", () => {
  const root = initRepo();
  const secret = "xai-abcdefghijklmnopqrstuvwxyz";
  const { env, pluginData } = fixture({ taskText: taskReport(`Completed safely; provider token was ${secret}.`) });
  const immediate = runCompanion(["task", "--wait", "redaction fixture", "--json"], { cwd: root, env });
  const job = parseJson(immediate);
  assert.match(persistedJob(pluginData, job.id).result.text, /Completed safely/);

  const jsonResult = runCompanion(["result", job.id, "--json"], { cwd: root, env });
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  const humanResult = runCompanion(["result", job.id], { cwd: root, env });
  assert.equal(humanResult.status, 0, humanResult.stderr);
  const stored = persistedJob(pluginData, job.id);
  const persisted = `${fs.readFileSync(stored.logFile, "utf8")}\n${fs.readFileSync(path.join(path.dirname(stored.logFile), `${job.id}.json`), "utf8")}`;

  for (const output of [immediate.stdout, jsonResult.stdout, humanResult.stdout, persisted]) {
    assert.equal(output.includes(secret), false);
    assert.equal(output.includes("xai-"), false);
  }
});

test("static human launch surfaces use public worker projections", () => {
  const dispatchSource = fs.readFileSync(path.join(ROOT, "plugins/grok/scripts/lib/companion-dispatch.mjs"), "utf8");
  const handlerSource = fs.readFileSync(path.join(ROOT, "plugins/grok/scripts/lib/companion-handlers.mjs"), "utf8");
  const researchSource = fs.readFileSync(path.join(ROOT, "plugins/grok/scripts/lib/companion-research.mjs"), "utf8");
  const acceptedStart = dispatchSource.indexOf(
    "if (launcherCode === 0 && !background && announce)"
  );
  const acceptedBlock = dispatchSource.slice(
    acceptedStart,
    dispatchSource.indexOf("if (background) return readJob(root, job.id);", acceptedStart)
  );
  assert.match(
    acceptedBlock,
    /const acceptedHandle = projectWorkerHandle\(accepted\)/
  );
  assert.doesNotMatch(
    acceptedBlock,
    /accepted\.(?:id|status|phase|progress|summary)/
  );

  const taskStart = handlerSource.indexOf("const finished = await startJob(root, job");
  const taskBlock = handlerSource.slice(taskStart);
  assert.match(
    taskBlock,
    /const finishedHandle = projectWorkerHandle\(finished\)/
  );
  assert.doesNotMatch(
    taskBlock,
    /\$\{finished\.(?:id|phase|progress|summary)\}/
  );

  const researchStart = researchSource.indexOf("async function handleDeepResearch");
  const researchBlock = researchSource.slice(
    researchStart,
    researchSource.indexOf("async function startDeepResearchJob", researchStart)
  );
  assert.match(
    researchBlock,
    /const finishedHandle = projectWorkerHandle\(finished\)/
  );
  assert.doesNotMatch(
    researchBlock,
    /\$\{finished\.(?:id|phase|progress|summary)\}/
  );

  const liveStart = researchSource.indexOf("if (announce) {", researchStart);
  const liveBlock = researchSource.slice(
    liveStart,
    researchSource.indexOf("if (finished.status ===", liveStart)
  );
  assert.match(
    liveBlock,
    /projectWorkerDiagnosticText\(String\(rawPhase\), \{/
  );
  assert.doesNotMatch(
    liveBlock,
    /sanitizeDisplayText\(String\(phase\)\)/
  );
});

test("foreground launch-unsettled failures retain a public durable job handle", (t) => {
  const forcedLauncherFixture = () => {
    const runtime = fixture();
    const pinned = installPinnedFakeCompanion(runtime.fake, runtime.env);
    t.after(pinned.cleanup);
    const source = fs.readFileSync(pinned.companionScript, "utf8");
    const injection = [
      'if (process.argv.includes("--launch-worker")) {',
      '  process.stderr.write("forced launcher exit\\n");',
      "  process.exit(42);",
      "}",
      ""
    ].join("\n");
    const firstNewline = source.indexOf("\n");
    const injectedSource = source.startsWith("#!") && firstNewline !== -1
      ? `${source.slice(0, firstNewline + 1)}${injection}${source.slice(firstNewline + 1)}`
      : `${injection}${source}`;
    fs.writeFileSync(
      pinned.companionScript,
      injectedSource,
      "utf8"
    );
    return {
      ...runtime,
      env: pinned.env,
      companionScript: pinned.companionScript
    };
  };

  const jsonRoot = initRepo();
  const jsonFixture = forcedLauncherFixture();
  const jsonFailure = runCompanion(
    ["task", "--wait", "retain the unsettled JSON handle", "--json"],
    {
      cwd: jsonRoot,
      env: jsonFixture.env,
      companionScript: jsonFixture.companionScript
    }
  );
  const jsonError = parseError(jsonFailure, "E_PROCESS_IDENTITY");
  assert.match(jsonError.details.workerId, /^task-[a-f0-9]{16,64}$/);
  const jsonStored = persistedJobs(jsonFixture.pluginData);
  assert.equal(jsonStored.length, 1);
  assert.equal(jsonStored[0].id, jsonError.details.workerId);
  assert.equal(jsonStored[0].phase, "launch-unsettled");
  assert.equal(jsonStored[0].terminal, undefined);

  const humanRoot = initRepo();
  const humanFixture = forcedLauncherFixture();
  const humanFailure = runCompanion(
    ["task", "--wait", "retain the unsettled human handle"],
    {
      cwd: humanRoot,
      env: humanFixture.env,
      companionScript: humanFixture.companionScript
    }
  );
  assert.notEqual(humanFailure.status, 0);
  const humanStored = persistedJobs(humanFixture.pluginData);
  assert.equal(humanStored.length, 1);
  assert.equal(humanStored[0].phase, "launch-unsettled");
  assert.match(
    humanFailure.stderr,
    new RegExp(`Job: ${humanStored[0].id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  );
  assert.match(
    humanFailure.stderr,
    new RegExp(
      `Check: /grok:status ${humanStored[0].id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
    )
  );
});

test("terminal process secondary diagnostics use the authoritative 256-character cap", () => {
  const normalized = normalizeTerminalProcessSignalError(
    new CompanionError(
      "E_PROCESS_IDENTITY",
      "Verified owned process signalling could not be completed.",
      {
        secondaryDiagnostic: {
          code: "EPERM",
          message: "x".repeat(500)
        }
      }
    )
  );
  assert.equal(normalized.details.secondaryDiagnostic.code, "EPERM");
  assert.equal(normalized.details.secondaryDiagnostic.message, "x".repeat(256));
});

function seedHumanProjectionJobs() {
const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const stamped = new Date().toISOString();
  const taskId = generateId("task");
  const reviewId = generateId("review");
  const normalTaskId = generateId("task");
  const researchId = generateId("deep-research");
  const privateResearchId = generateId("deep-research");
  const errorNullTaskId = generateId("task");
  const errorNullResearchId = generateId("deep-research");
  const normalResultText = `NORMAL_RESULT_START ${"n".repeat(2_200)} NORMAL_RESULT_END`;
  const fullResearchText =
    `NORMAL_RESEARCH_START ${"r".repeat(900)} NORMAL_RESEARCH_END`;
  const errorNullDiagnostic =
    "Terminal cleanup kill process -451005 failed with EIO at /home/alice/private/error-null.";
  const rawSessionDiagnostic =
    "Terminal cleanup kill EPERM for providerPid=451004";
  const documentaryDiagnostic =
    "Historical: the retry behavior remains documented for this fixture.";
  const ordinaryMissingInput =
    "Could not read the requested input: ENOENT.";
  const privateResearchDiagnostic = [
    "Recovery cleanup failed with EIO",
    "for worker_process_id='+451003'",
    "at /home/alice/private/research."
  ].join(" ");
  const contextDiagnostic = [
    "Final observation cleanup failed with EACCES",
    "for provider_pid='+451001'",
    "at /Users/alice/private/runtime."
  ].join(" ");
  const processDiagnostic = [
    "Terminal cleanup failed with EBUSY",
    'for controller_pid_t="-451002"',
    "at /private/provider/runtime."
  ].join(" ");
  const base = (id, kind, jobClass) => ({
    schemaVersion: 3,
    id,
    kind,
    jobClass,
    title: `${kind}: human privacy fixture`,
    summary: "Terminal worker fixture",
    write: false,
    status: "failed",
    phase: "failed",
    workspaceRoot: root,
    host: {
      kind: "claude-code",
      sessionId: env.GROK_COMPANION_HOST_SESSION_ID
    },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: stamped,
    updatedAt: stamped,
    completedAt: stamped,
    heartbeatAt: stamped,
    workerAuthorization: null,
    workerProcess: null,
    providerProcess: null,
    profile: { id: jobClass === "review" ? "review" : "rescue-read-v3" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    latestPlan: [],
    lifecycleEvents: [],
    request: { prompt: null },
    result: null,
    error: null
  });

  writeSeededJob(stateRoot, {
    ...base(taskId, "task", "task"),
    phase: "context-rejected",
    summary: contextDiagnostic,
    progress: `Waiting after ${contextDiagnostic}`,
    grokSessionId: "human-context-session",
    result: {
      hostVerification: "not_run",
      taskRuntimeCleaned: true,
      workerReport: {
        schemaVersion: 1,
        structured: true,
        valid: false,
        outcome: "blocked",
        summary: contextDiagnostic,
        changedFiles: ["src/safe.mjs"],
        checksClaimed: ["Could not read the requested input: ENOENT."],
        acceptanceResults: [],
        risks: [contextDiagnostic],
        questions: [],
        validationIssues: []
      },
      privacyWarning: contextDiagnostic
    },
    error: {
      code: "E_CONTEXT_DRIFT",
      message: contextDiagnostic,
      details: {
        reasons: ["[GIT_METADATA]"],
        secondaryDiagnostic: {
          code: "EPERM",
          message: "Recovery cleanup failed with EPERM."
        }
      }
    }
  });
  writeSeededJob(stateRoot, {
    ...base(reviewId, "review", "review"),
    phase: "cleanup-blocked",
    summary: processDiagnostic,
    progress: `Still waiting: ${processDiagnostic}`,
    grokSessionId: rawSessionDiagnostic,
    result: {
      hostVerification: "not_run",
      review: {
        verdict: "needs_changes",
        summary: processDiagnostic,
        findings: [{
          severity: "high",
          title: processDiagnostic,
          body: "Could not read the requested input: ENOENT.",
          file: "src/safe.mjs",
          line: 7
        }]
      },
      providerSessionDeleted: true,
      privacyWarning: processDiagnostic
    },
    error: {
      code: "E_PROCESS_IDENTITY",
      message: "Verified owned process signalling could not be completed.",
      details: {
        secondaryDiagnostic: {
          code: "EBUSY",
          message: processDiagnostic
        }
      }
    }
  });
  writeSeededJob(stateRoot, {
    ...base(normalTaskId, "task", "task"),
    status: "completed",
    phase: "done",
    summary: "Normal task completed",
    progress: "Normal task completed",
    result: {
      hostVerification: "not_run",
      taskRuntimeCleaned: true,
      text: normalResultText
    }
  });
  writeSeededJob(stateRoot, {
    ...base(researchId, "deep-research", "research"),
    status: "completed",
    phase: "done",
    summary: "Normal research completed",
    progress: "Normal research completed",
    profile: { id: "deep-research-v1" },
    result: {
      hostVerification: "not_run",
      researchRuntimeCleaned: true,
      workflow: {
        runId: "normal-research-workflow",
        revision: 1,
        status: "completed",
        phases: [],
        currentPhase: "done"
      },
      researchReport: {
        valid: true,
        path: "workflows/normal-research-workflow/scratch/report.md",
        bytes: Buffer.byteLength(fullResearchText),
        sha256: "a".repeat(64),
        sourceCount: 2,
        coverageNotes: [],
        status: "verified",
        textPreview: "NORMAL_RESEARCH_START projected preview",
        markdown: fullResearchText
      }
    }
  });
  writeSeededJob(stateRoot, {
    ...base(privateResearchId, "deep-research", "research"),
    phase: "scope-rejected",
    summary: privateResearchDiagnostic,
    progress: privateResearchDiagnostic,
    profile: { id: "deep-research-v1" },
    result: {
      hostVerification: "not_run",
      researchRuntimeCleaned: true,
      workflow: {
        runId: "private-research-workflow",
        revision: 1,
        status: "paused",
        phases: [],
        currentPhase: "cleanup"
      },
      researchReport: {
        valid: false,
        path: "workflows/private-research-workflow/scratch/report.md",
        bytes: Buffer.byteLength(privateResearchDiagnostic),
        sha256: "b".repeat(64),
        sourceCount: 0,
        coverageNotes: [privateResearchDiagnostic],
        status: "partial",
        textPreview: privateResearchDiagnostic,
        markdown: privateResearchDiagnostic
      },
      privacyWarning: privateResearchDiagnostic
    },
    error: {
      code: "E_SCOPE_VIOLATION",
      message: privateResearchDiagnostic,
      details: {
        paths: ["src/safe.mjs"],
        secondaryDiagnostic: {
          code: "EIO",
          message: privateResearchDiagnostic
        }
      }
    }
  });
  writeSeededJob(stateRoot, {
    ...base(errorNullTaskId, "task", "task"),
    status: "completed",
    phase: "done",
    summary: errorNullDiagnostic,
    progress: errorNullDiagnostic,
    grokSessionId: rawSessionDiagnostic,
    latestPlan: [
      errorNullDiagnostic,
      documentaryDiagnostic,
      ordinaryMissingInput
    ],
    result: {
      hostVerification: "not_run",
      taskRuntimeCleaned: true,
      text: errorNullDiagnostic
    }
  });
  writeSeededJob(stateRoot, {
    ...base(errorNullResearchId, "deep-research", "research"),
    status: "completed",
    phase: "done",
    summary: errorNullDiagnostic,
    progress: errorNullDiagnostic,
    grokSessionId: rawSessionDiagnostic,
    profile: { id: "deep-research-v1" },
    result: {
      hostVerification: "not_run",
      researchRuntimeCleaned: true,
      workflow: {
        runId: "error-null-research-workflow",
        revision: 1,
        status: "completed",
        phases: [],
        currentPhase: "done"
      },
      researchReport: {
        valid: true,
        path: "workflows/error-null-research-workflow/scratch/report.md",
        bytes: Buffer.byteLength(errorNullDiagnostic),
        sha256: "c".repeat(64),
        sourceCount: 1,
        coverageNotes: [
          errorNullDiagnostic,
          documentaryDiagnostic,
          ordinaryMissingInput
        ],
        status: "verified",
        textPreview: errorNullDiagnostic,
        markdown: errorNullDiagnostic
      }
    }
  });
  return {
    root, env, taskId, reviewId, normalTaskId, researchId, privateResearchId,
    errorNullTaskId, errorNullResearchId, documentaryDiagnostic, ordinaryMissingInput
  };
}

function collectHumanProjectionResults(context) {
  const {
    root, env, taskId, reviewId, normalTaskId, researchId, privateResearchId,
    errorNullTaskId, errorNullResearchId
  } = context;
const taskStatus = runCompanion(["status", taskId], { cwd: root, env });
  const taskReadonlyStatus = runCompanion(
    ["status", taskId, "--readonly"],
    { cwd: root, env }
  );
  const taskResult = runCompanion(["result", taskId], { cwd: root, env });
  const reviewStatus = runCompanion(["status", reviewId], { cwd: root, env });
  const reviewResult = runCompanion(["result", reviewId], { cwd: root, env });
  const normalTaskResult = runCompanion(
    ["result", normalTaskId],
    { cwd: root, env }
  );
  const normalResearchResult = runCompanion(
    ["result", researchId],
    { cwd: root, env }
  );
  const normalResearchJson = runCompanion(
    ["result", researchId, "--json"],
    { cwd: root, env }
  );
  const privateResearchResult = runCompanion(
    ["result", privateResearchId],
    { cwd: root, env }
  );
  const privateResearchJson = runCompanion(
    ["result", privateResearchId, "--json"],
    { cwd: root, env }
  );
  const errorNullTaskStatus = runCompanion(
    ["status", errorNullTaskId],
    { cwd: root, env }
  );
  const errorNullTaskStatusJson = runCompanion(
    ["status", errorNullTaskId, "--json"],
    { cwd: root, env }
  );
  const errorNullTaskResult = runCompanion(
    ["result", errorNullTaskId],
    { cwd: root, env }
  );
  const errorNullTaskResultJson = runCompanion(
    ["result", errorNullTaskId, "--json"],
    { cwd: root, env }
  );
  const errorNullResearchResult = runCompanion(
    ["result", errorNullResearchId],
    { cwd: root, env }
  );
  const errorNullResearchJson = runCompanion(
    ["result", errorNullResearchId, "--json"],
    { cwd: root, env }
  );
  const readonlyTable = runCompanion(
    ["status", "--all", "--readonly"],
    { cwd: root, env }
  );
  const recoveringTable = runCompanion(["status", "--all"], { cwd: root, env });
  const results = [
    taskStatus,
    taskReadonlyStatus,
    taskResult,
    reviewStatus,
    reviewResult,
    normalTaskResult,
    normalResearchResult,
    normalResearchJson,
    privateResearchResult,
    privateResearchJson,
    errorNullTaskStatus,
    errorNullTaskStatusJson,
    errorNullTaskResult,
    errorNullTaskResultJson,
    errorNullResearchResult,
    errorNullResearchJson,
    readonlyTable,
    recoveringTable
  ];
  return {
    taskStatus, taskReadonlyStatus, taskResult, reviewStatus, reviewResult,
    normalTaskResult, normalResearchResult, normalResearchJson,
    privateResearchResult, privateResearchJson, errorNullTaskStatus,
    errorNullTaskStatusJson, errorNullTaskResult, errorNullTaskResultJson,
    errorNullResearchResult, errorNullResearchJson, readonlyTable, recoveringTable,
    results
  };
}

function assertHumanProjectionResults(context, projections) {
  const {
    taskId, reviewId, normalTaskId, researchId, privateResearchId,
    errorNullTaskId, errorNullResearchId, documentaryDiagnostic, ordinaryMissingInput
  } = context;
  const {
    taskStatus, taskReadonlyStatus, taskResult, reviewStatus, reviewResult,
    normalTaskResult, normalResearchResult, normalResearchJson,
    privateResearchResult, privateResearchJson, errorNullTaskStatus,
    errorNullTaskStatusJson, errorNullTaskResult, errorNullTaskResultJson,
    errorNullResearchResult, errorNullResearchJson, readonlyTable, recoveringTable,
    results
  } = projections;
for (const result of results) {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const privateValue of [
      "EACCES",
      "EPERM",
      "EBUSY",
      "451001",
      "451002",
      "/Users/alice",
      "/private/provider",
      "451003",
      "451004",
      "451005",
      "/home/alice",
      "/home/alice/private/error-null"
    ]) {
      assert.equal(
        result.stdout.includes(privateValue),
        false,
        `${privateValue} leaked from:\n${result.stdout}`
      );
    }
  }

  for (const result of [taskStatus, taskReadonlyStatus, taskResult]) {
    assert.match(result.stdout, /E_CONTEXT_DRIFT:/);
    assert.match(result.stdout, /human-context-session/);
    assert.match(result.stdout, /Resume through this host:/);
    assert.match(result.stdout, /provider_pid='\[REDACTED\]'/);
  }
  assert.match(taskResult.stdout, /Could not read the requested input: ENOENT\./);
  assert.match(reviewStatus.stdout, /E_PROCESS_IDENTITY: Process ownership verification failed\./);
  assert.match(reviewStatus.stdout, /providerPid=\[REDACTED\]/);
  assert.match(reviewResult.stdout, new RegExp(`Grok review ${reviewId}`));
  assert.match(reviewResult.stdout, /Verdict: needs_changes/);
  assert.match(
    reviewResult.stdout,
    /Grok session: Terminal cleanup kill Process ownership verification failed\. for providerPid=\[REDACTED\] \(deleted after review\)/
  );
  assert.match(reviewResult.stdout, /controller_pid_t="\[REDACTED\]"/);
  assert.match(normalTaskResult.stdout, /NORMAL_RESULT_START/);
  assert.match(normalTaskResult.stdout, /NORMAL_RESULT_END/);
  assert.match(normalResearchResult.stdout, /NORMAL_RESEARCH_START/);
  assert.match(normalResearchResult.stdout, /NORMAL_RESEARCH_END/);
  const normalResearchPayload = JSON.parse(normalResearchJson.stdout);
  assert.match(
    normalResearchPayload.result.researchReport.markdown,
    /NORMAL_RESEARCH_END/
  );
  assert.match(privateResearchResult.stdout, /E_SCOPE_VIOLATION:/);
  assert.match(privateResearchResult.stdout, /worker_process_id='\[REDACTED\]'/);
  const privateResearchPayload = JSON.parse(privateResearchJson.stdout);
  assert.equal(privateResearchPayload.error.code, "E_SCOPE_VIOLATION");
  assert.equal(
    Object.hasOwn(privateResearchPayload.result.researchReport, "markdown"),
    false
  );
  assert.match(
    privateResearchPayload.result.researchReport.textPreview,
    /worker_process_id='\[REDACTED\]'/
  );
  for (const result of [
    errorNullTaskStatus,
    errorNullTaskResult,
    errorNullResearchResult
  ]) {
    assert.match(result.stdout, /Grok session:/);
    assert.match(result.stdout, /providerPid=\[REDACTED\]/);
  }
  assert.match(errorNullTaskResult.stdout, /kill process \[REDACTED\]/);
  const errorNullTaskStatusPayload = JSON.parse(errorNullTaskStatusJson.stdout);
  const errorNullTaskResultPayload = JSON.parse(errorNullTaskResultJson.stdout);
  for (const payload of [
    errorNullTaskStatusPayload,
    errorNullTaskResultPayload
  ]) {
    assert.equal(payload.error, null);
    assert.match(payload.summary, /kill process \[REDACTED\]/);
    assert.equal(payload.latestPlan[1], documentaryDiagnostic);
    assert.equal(payload.latestPlan[2], ordinaryMissingInput);
  }
  assert.match(errorNullResearchResult.stdout, /kill process \[REDACTED\]/);
  assert.match(
    errorNullResearchResult.stdout,
    new RegExp(documentaryDiagnostic)
  );
  assert.match(
    errorNullResearchResult.stdout,
    new RegExp(ordinaryMissingInput)
  );
  const errorNullResearchPayload = JSON.parse(errorNullResearchJson.stdout);
  assert.equal(errorNullResearchPayload.error, null);
  assert.equal(
    errorNullResearchPayload.result.researchReport.coverageNotes[1],
    documentaryDiagnostic
  );
  assert.equal(
    errorNullResearchPayload.result.researchReport.coverageNotes[2],
    ordinaryMissingInput
  );
  assert.match(
    errorNullResearchPayload.result.researchReport.markdown,
    /kill process \[REDACTED\]/
  );
  for (const table of [readonlyTable, recoveringTable]) {
    assert.match(table.stdout, /\| Job \| Kind \| Status \| Phase \| Progress \| Heartbeat \|/);
    assert.match(table.stdout, new RegExp(taskId));
    assert.match(table.stdout, new RegExp(reviewId));
    assert.match(table.stdout, new RegExp(normalTaskId));
    assert.match(table.stdout, new RegExp(researchId));
    assert.match(table.stdout, new RegExp(privateResearchId));
    assert.match(table.stdout, new RegExp(errorNullTaskId));
    assert.match(table.stdout, new RegExp(errorNullResearchId));
  }
}

test("human CLI process diagnostics stay behind public status, result, review, and table projections", () => {
  const context = seedHumanProjectionJobs();
  const projections = collectHumanProjectionResults(context);
  assertHumanProjectionResults(context, projections);
});
