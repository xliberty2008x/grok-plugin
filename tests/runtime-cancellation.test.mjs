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

test("legacy CLI recovery preserves broker jobs at every unsettled launch boundary", () => {
  const root = fs.realpathSync(initRepo());
  const runtime = codexBrokerFixture();
  const spawned = spawnPendingBrokerJob(root, runtime, "runtime-pending-recovery");
  const id = spawned.handle.id;
  const old = new Date(Date.now() - 10_000).toISOString();
  updateJob(root, id, (job) => ({ ...job, createdAt: old }), runtime.env);

  const states = [
    { providerLaunchPending: true, providerLaunchInFlight: false, providerLaunchOutcome: null },
    { providerLaunchPending: false, providerLaunchInFlight: true, providerLaunchOutcome: null },
    { providerLaunchPending: false, providerLaunchInFlight: false, providerLaunchOutcome: "unknown" }
  ];
  for (const launchState of states) {
    updateJob(root, id, (job) => ({
      ...job,
      status: "queued",
      phase: "provider-launching",
      error: null,
      request: {
        ...job.request,
        spawn: { ...job.request.spawn, ...launchState }
      }
    }), runtime.env);
    const status = parseJson(runCompanion(["status", id, "--json"], {
      cwd: root,
      env: runtime.env
    }));
    assert.equal(status.status, "queued");
    assert.equal(readJob(root, id, runtime.env).error, null);
  }
});

test("legacy CLI cancel extracts the broker object authorization nonce", async () => {
  const root = fs.realpathSync(initRepo());
  const runtime = codexBrokerFixture();
  const spawned = spawnPendingBrokerJob(root, runtime, "runtime-object-nonce-cancel");
  const id = spawned.handle.id;
  const nonce = readJob(root, id, runtime.env).workerAuthorization.nonce;
  const stateRoot = workspaceState(root, runtime.env);
  const marker = path.join(stateRoot, "jobs", `${id}.cancel`);

  const canceling = spawnCompanion(["cancel", id, "--json"], { cwd: root, env: runtime.env });
  await waitFor(() => fs.existsSync(marker), { timeoutMs: 5000 });
  assert.equal(fs.readFileSync(marker, "utf8"), `${nonce}\n`);

  updateJob(root, id, (job) => ({
    ...job,
    status: "cancelled",
    phase: "cancelled",
    completedAt: new Date().toISOString(),
    error: { code: "E_CANCELLED", message: "cancelled during broker launch window" },
    summary: "cancelled during broker launch window"
  }), runtime.env);
  const completed = await canceling.completed;
  assert.equal(completed.code, 0, completed.stderr || completed.stdout);
  assert.equal(JSON.parse(completed.stdout).status, "cancelled");
});

test("CLI cancel terminalizes only cleanup-proven broker boundaries and retains ambiguous launch states", { timeout: 60_000 }, async () => {
  const runtime = codexBrokerFixture();
  const cases = [
    {
      name: "pending",
      launch: { providerLaunchPending: true, providerLaunchInFlight: false, providerLaunchOutcome: null },
      retained: false
    },
    {
      name: "inflight",
      launch: { providerLaunchPending: false, providerLaunchInFlight: true, providerLaunchOutcome: null },
      retained: true
    },
    {
      name: "unknown",
      launch: { providerLaunchPending: false, providerLaunchInFlight: false, providerLaunchOutcome: "unknown" },
      retained: true
    },
    {
      name: "authorization-only",
      launch: null,
      retained: true
    },
    {
      name: "not-launched",
      launch: { providerLaunchPending: false, providerLaunchInFlight: false, providerLaunchOutcome: "not-launched" },
      retained: false
    }
  ];

  // These cases assert independent launch-boundary semantics. Give each one a
  // private workspace so parallel CLI recovery cannot turn the test into a
  // shared state-lock scheduling benchmark.
  for (const fixture of cases) {
    fixture.root = fs.realpathSync(initRepo());
    fixture.stateRoot = workspaceState(fixture.root, runtime.env);
    const spawned = spawnPendingBrokerJob(
      fixture.root,
      runtime,
      `runtime-cancel-settlement-${fixture.name}`
    );
    fixture.id = spawned.handle.id;
    updateJob(fixture.root, fixture.id, (job) => {
      const spawnState = { ...job.request.spawn };
      if (fixture.launch) Object.assign(spawnState, fixture.launch);
      else {
        delete spawnState.providerLaunchPending;
        delete spawnState.providerLaunchInFlight;
        delete spawnState.providerLaunchOutcome;
      }
      return {
        ...job,
        request: { ...job.request, spawn: spawnState }
      };
    }, runtime.env);
    fixture.before = readJob(fixture.root, fixture.id, runtime.env);
    fixture.nonce = fixture.before.workerAuthorization.nonce;
    fixture.runtimeFile = path.join(
      fixture.stateRoot,
      "task-homes",
      fixture.id,
      ".grok",
      "auth.json"
    );
    fs.mkdirSync(path.dirname(fixture.runtimeFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(fixture.runtimeFile, `private-${fixture.name}-runtime\n`, { mode: 0o600 });
  }

  const canceling = cases.map((fixture) => ({
    fixture,
    process: spawnCompanion(
      ["cancel", fixture.id, "--json"],
      { cwd: fixture.root, env: runtime.env }
    )
  }));

  const outcomes = await Promise.all(canceling.map(async ({ fixture, process: running }) => ({
    fixture,
    completed: await running.completed
  })));
  for (const { fixture, completed } of outcomes) {
    assert.equal(completed.code, 0, completed.stderr || completed.stdout);
    const projected = JSON.parse(completed.stdout);
    const stored = readJob(fixture.root, fixture.id, runtime.env);
    const marker = path.join(fixture.stateRoot, "jobs", `${fixture.id}.cancel`);
    assert.equal(fs.readFileSync(marker, "utf8"), `${fixture.nonce}\n`);

    if (!fixture.retained) {
      assert.equal(projected.status, "cancelled");
      assert.equal(stored.status, "cancelled");
      assert.equal(stored.result?.taskRuntimeCleaned, true);
      assert.equal(fs.existsSync(fixture.runtimeFile), false, "explicit not-launched runtime must be cleaned");
      continue;
    }

    assert.equal(projected.status, "queued");
    assert.equal(projected.phase, "cancellation-requested");
    assert.equal(stored.status, "queued");
    assert.equal(stored.phase, "cancellation-requested");
    assert.equal(stored.completedAt, null);
    assert.deepEqual(stored.request, fixture.before.request, `${fixture.name} launch state must remain intact`);
    assert.deepEqual(stored.workerAuthorization, fixture.before.workerAuthorization);
    assert.equal(
      stored.lifecycleEvents.length,
      fixture.before.lifecycleEvents.length + 1,
      `${fixture.name} must append exactly one durable cancellation event`
    );
    assert.equal(stored.lifecycleEvents.at(-1).type, "cancellation.requested");
    assert.equal(stored.error, null);
    assert.equal(stored.result?.taskRuntimeCleaned, undefined);
    assert.equal(fs.existsSync(fixture.runtimeFile), true, `${fixture.name} runtime must be retained`);
    assert.doesNotMatch(stored.error?.message || "", new RegExp(fixture.id));
    assert.doesNotMatch(stored.error?.message || "", new RegExp(fixture.nonce));
    assert.doesNotMatch(
      completed.stdout,
      new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );
    assert.doesNotMatch(completed.stderr, new RegExp(fixture.nonce));
  }
});

test("cancel during worker launch window uses workerAuthorization when workerProcess is null", async () => {
  // Launch window: startJob persists workerAuthorization before workerProcess exists.
  // requestCancel must use that authenticated nonce rather than throwing E_PROCESS_IDENTITY.
  const root = fs.realpathSync(initRepo());
  const { pluginData, env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("task");
  const authNonce = crypto.randomBytes(16).toString("hex");
  const stamped = new Date().toISOString();
  const jobPath = path.join(stateRoot, "jobs", `${id}.json`);
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "task",
    jobClass: "task",
    title: "task: launch-window cancel fixture",
    summary: "Queued",
    write: false,
    status: "queued",
    phase: "queued",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: null,
    updatedAt: stamped,
    completedAt: null,
    workerAuthorization: authNonce,
    workerProcess: null,
    providerProcess: null,
    profile: { id: "rescue-read-v2", transport: "acp" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: { prompt: null, promptDigest: "abc" },
    result: null,
    error: null
  });

  const canceling = spawnCompanion(["cancel", id, "--json"], { cwd: root, env });
  const marker = path.join(stateRoot, "jobs", `${id}.cancel`);
  await waitFor(() => fs.existsSync(marker), { timeoutMs: 5000 });
  assert.equal(fs.readFileSync(marker, "utf8"), `${authNonce}\n`);

  // End the graceful wait early: the launch-window worker never started.
  // Write the job file directly so we do not depend on process.env plugin-data routing.
  const current = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  current.status = "cancelled";
  current.phase = "cancelled";
  current.completedAt = new Date().toISOString();
  current.error = { code: "E_CANCELLED", message: "cancelled during launch window" };
  current.summary = current.error.message;
  current.updatedAt = current.completedAt;
  fs.writeFileSync(jobPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });

  const completed = await canceling.completed;
  assert.equal(completed.code, 0, completed.stderr || completed.stdout);
  const cancelled = JSON.parse(completed.stdout);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(fs.readFileSync(marker, "utf8"), `${authNonce}\n`);
});

test("cancel fails closed when neither workerProcess nonce nor workerAuthorization exists", () => {
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("task");
  const stamped = new Date().toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "task",
    jobClass: "task",
    title: "task: missing-nonce cancel fixture",
    summary: "Queued",
    write: false,
    status: "queued",
    phase: "queued",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: null,
    updatedAt: stamped,
    completedAt: null,
    workerAuthorization: null,
    workerProcess: null,
    providerProcess: null,
    profile: { id: "rescue-read-v2", transport: "acp" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: { prompt: null },
    result: null,
    error: null
  });

  const failed = runCompanion(["cancel", id, "--json"], { cwd: root, env });
  parseError(failed, "E_PROCESS_IDENTITY");
  assert.equal(fs.existsSync(path.join(stateRoot, "jobs", `${id}.cancel`)), false);
});

test("lost-worker recovery uses provider guard when providerProcess is missing and group is gone", { skip: process.platform === "win32" }, () => {
  // Guard-created / providerProcess-missing window: job never recorded providerProcess, but
  // registerProviderGuard persisted an identity that is already gone. Recovery must load the
  // guard, verify the group is gone, then unregister and clean the isolated home.
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const isolatedHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(isolatedHome, "marker"), "guard-window\n", { mode: 0o600 });

  const deadIdentity = { pid: 999999998, startToken: "dead-provider-token", processGroupId: 999999998 };
  const stamped = new Date(Date.now() - 60_000).toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: guard-only provider cleanup",
    summary: "Running",
    write: false,
    status: "running",
    phase: "prompting",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: stamped,
    updatedAt: stamped,
    completedAt: null,
    workerProcess: { pid: 999999999, startToken: "dead-worker-token", nonce: "n", processGroupId: 999999999, commandMarker: id },
    providerProcess: null,
    profile: { id: "review", transport: "headless" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: { prompt: null, target: { mode: "working-tree", label: "fixture", base: null } },
    result: { privacyWarning: "prior-privacy-signal" },
    error: null
  });
  registerProviderGuard(root, id, deadIdentity, env.GROK_COMPANION_HOST_SESSION_ID);

  try {
    const recovered = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.error.code, "E_WORKER_LOST");
    assert.equal(hasForeignActiveProvider(root, null), false, "guard must be removed after verified teardown");
    assert.equal(fs.existsSync(isolatedHome), false, "isolated home must be removed after verified teardown");
    assert.equal(recovered.result?.providerSessionDeleted, true);
  } finally {
    try { unregisterProviderGuard(root, id); } catch {}
  }
});

test("lost-worker recovery preserves guard and home when guard identity is live/unverifiable", { skip: process.platform === "win32" }, async (t) => {
  // Same window, but the guard points at a live process group. Without the guard fallback the
  // old path treated null providerProcess as "nothing to terminate" and unregistered/cleaned.
  // Fail closed: retain guard, home, and privacy evidence with E_PROCESS_IDENTITY.
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const isolatedHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(isolatedHome, "retained.txt"), "privacy-evidence\n", { mode: 0o600 });

  const provider = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);"
  ], { detached: true, stdio: "ignore" });
  t.after(() => {
    try { process.kill(-provider.pid, "SIGKILL"); } catch {}
    try { unregisterProviderGuard(root, id); } catch {}
  });
  await waitFor(() => processGroupAlive(provider.pid), { timeoutMs: 5000 });
  // Synthetic token: live group cannot be verified for ownership → terminate must fail closed.
  const identity = { pid: provider.pid, startToken: "unverified-live-provider-token", processGroupId: provider.pid };

  const stamped = new Date(Date.now() - 60_000).toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: unverifiable guard-only provider",
    summary: "Running",
    write: false,
    status: "running",
    phase: "prompting",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: stamped,
    updatedAt: stamped,
    completedAt: null,
    workerProcess: { pid: 999999999, startToken: "dead-worker-token", nonce: "n", processGroupId: 999999999, commandMarker: id },
    providerProcess: null,
    profile: { id: "review", transport: "headless" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: { prompt: null, target: { mode: "working-tree", label: "fixture", base: null } },
    result: { privacyWarning: "prior-privacy-signal" },
    error: null
  });
  registerProviderGuard(root, id, identity, env.GROK_COMPANION_HOST_SESSION_ID);
  assert.equal(processGroupAlive(provider.pid), true);

  const recovered = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
  assert.equal(recovered.status, "running");
  assert.equal(recovered.phase, "cleanup-blocked");
  assert.equal(recovered.error.code, "E_PROCESS_IDENTITY");
  assert.equal(processGroupAlive(provider.pid), true, "must not tear down an unverifiable live process group");
  assert.equal(hasForeignActiveProvider(root, null), true, "guard must be retained");
  assert.equal(fs.existsSync(path.join(isolatedHome, "retained.txt")), true, "isolated home must be retained");
  assert.equal(recovered.result?.providerSessionDeleted, false);
  assert.match(recovered.result?.privacyWarning || "", /prior-privacy-signal/);
  assert.match(recovered.result?.privacyWarning || "", /Isolated review home retained/);
});

test("force-cancel uses provider guard when providerProcess is missing", { skip: process.platform === "win32" }, async (t) => {
  // Force-cancel path after graceful timeout: providerProcess never recorded, guard has a dead
  // identity (verified gone). Cancel must still load the guard, unregister, and clean the home.
  // Queued+young avoids recoverActiveJobs stealing the job before the force path runs.
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const isolatedHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(isolatedHome, "marker"), "force-cancel-guard\n", { mode: 0o600 });
  const workerNonce = crypto.randomBytes(16).toString("hex");
  const deadIdentity = { pid: 999999997, startToken: "dead-provider-token", processGroupId: 999999997 };
  const stamped = new Date().toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: force-cancel guard-only provider",
    summary: "Queued",
    write: false,
    status: "queued",
    phase: "queued",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: null,
    updatedAt: stamped,
    completedAt: null,
    workerAuthorization: workerNonce,
    workerProcess: { pid: 999999992, startToken: "dead-worker-token", nonce: workerNonce, processGroupId: 999999992, commandMarker: id },
    providerProcess: null,
    profile: { id: "review", transport: "headless" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: { prompt: null, target: { mode: "working-tree", label: "fixture", base: null } },
    result: null,
    error: null
  });
  registerProviderGuard(root, id, deadIdentity, env.GROK_COMPANION_HOST_SESSION_ID);
  t.after(() => { try { unregisterProviderGuard(root, id); } catch {} });

  const cancelled = parseJson(runCompanion(["cancel", id, "--json"], {
    cwd: root,
    env,
    timeout: 20000
  }));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.error.code, "E_CANCELLED");
  assert.match(cancelled.error.message, /force-cancelled/i);
  assert.equal(fs.readFileSync(path.join(stateRoot, "jobs", `${id}.cancel`), "utf8"), `${workerNonce}\n`);
  assert.equal(hasForeignActiveProvider(root, null), false, "guard must be removed after force-cancel teardown");
  assert.equal(fs.existsSync(isolatedHome), false, "isolated home must be removed after force-cancel teardown");
  assert.equal(cancelled.result?.providerSessionDeleted, true);
});

test("force-cancel preserves a terminal result published during exact cleanup", {
  skip: process.platform === "win32",
  timeout: 25_000
}, async (t) => {
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const isolatedHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(isolatedHome, "marker"),
    "terminal-publication-race\n",
    { mode: 0o600 }
  );
  const signalMarker = path.join(
    tempDir("grok-force-cancel-terminal-race-"),
    "sigterm"
  );
  const worker = spawn(
    process.execPath,
    [
      "-e",
      [
        "const fs=require('node:fs');",
        "const marker=process.argv[1];",
        "process.on('SIGTERM',()=>{",
        "fs.writeFileSync(marker,'received\\n');",
        "setTimeout(()=>process.exit(0),1000);",
        "});",
        "setInterval(()=>{},1000);"
      ].join(""),
      signalMarker,
      "grok-companion.mjs",
      "--worker",
      id
    ],
    { detached: true, stdio: "ignore" }
  );
  t.after(() => {
    try { process.kill(-worker.pid, "SIGKILL"); } catch {}
  });
  const workerStartToken = await waitFor(
    () => processStartToken(worker.pid),
    { timeoutMs: 5_000 }
  );
  const workerNonce = crypto.randomBytes(16).toString("hex");
  const stamped = new Date().toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: force-cancel terminal publication race",
    summary: "Queued",
    write: false,
    status: "queued",
    phase: "queued",
    workspaceRoot: root,
    host: {
      kind: "claude-code",
      sessionId: env.GROK_COMPANION_HOST_SESSION_ID
    },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: null,
    updatedAt: stamped,
    completedAt: null,
    workerAuthorization: workerNonce,
    workerProcess: {
      pid: worker.pid,
      startToken: workerStartToken,
      nonce: workerNonce,
      processGroupId: worker.pid,
      commandMarker: id
    },
    providerProcess: null,
    profile: { id: "review", transport: "headless" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: {
      prompt: null,
      target: { mode: "working-tree", label: "fixture", base: null }
    },
    result: null,
    error: null
  });

  const cancellation = spawnCompanion(
    ["cancel", id, "--json"],
    { cwd: root, env }
  );
  await Promise.race([
    waitFor(
      () => fs.existsSync(signalMarker),
      { timeoutMs: 15_000, intervalMs: 25 }
    ),
    cancellation.completed.then((result) => {
      throw new Error(
        `force-cancel ended before SIGTERM race checkpoint\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
      );
    })
  ]);
  const publishedAt = new Date().toISOString();
  updateJob(root, id, (job) => ({
    ...job,
    status: "completed",
    phase: "done",
    completedAt: publishedAt,
    heartbeatAt: publishedAt,
    summary: "Authoritative worker result",
    progress: "Authoritative worker result",
    error: null,
    result: {
      review: {
        verdict: "pass",
        summary: "Authoritative worker result",
        findings: []
      },
      providerSessionDeleted: true,
      hostVerification: "not_run"
    }
  }), env);

  const completed = await cancellation.completed;
  assert.equal(
    completed.code,
    0,
    `force-cancel failed\nstdout: ${completed.stdout}\nstderr: ${completed.stderr}`
  );
  const projected = JSON.parse(completed.stdout);
  assert.equal(projected.status, "completed");
  assert.equal(projected.phase, "done");
  assert.equal(projected.error, null);
  assert.equal(projected.summary, "Authoritative worker result");
  assert.equal(projected.result.review.verdict, "pass");
  const stored = readJob(root, id, env);
  assert.equal(stored.completedAt, publishedAt);
  assert.equal(stored.status, "completed");
  assert.equal(stored.error, null);
  assert.equal(fs.existsSync(isolatedHome), false);
});

test("force-cancel preserves a terminal task result across cleanup failure", {
  skip: process.platform === "win32",
  timeout: 25_000
}, async (t) => {
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("task");
  const taskHome = path.join(stateRoot, "task-homes", id);
  const authPath = path.join(taskHome, ".grok", "auth.json");
  fs.mkdirSync(authPath, { recursive: true, mode: 0o700 });
  t.after(() => {
    try { fs.rmSync(taskHome, { recursive: true, force: true }); } catch {}
  });
  const signalMarker = path.join(
    tempDir("grok-force-cancel-task-cleanup-race-"),
    "sigterm"
  );
  const worker = spawn(
    process.execPath,
    [
      "-e",
      [
        "const fs=require('node:fs');",
        "const marker=process.argv[1];",
        "process.on('SIGTERM',()=>{",
        "fs.writeFileSync(marker,'received\\n');",
        "setTimeout(()=>process.exit(0),1000);",
        "});",
        "setInterval(()=>{},1000);"
      ].join(""),
      signalMarker,
      "grok-companion.mjs",
      "--worker",
      id
    ],
    { detached: true, stdio: "ignore" }
  );
  t.after(() => {
    try { process.kill(-worker.pid, "SIGKILL"); } catch {}
  });
  const workerStartToken = await waitFor(
    () => processStartToken(worker.pid),
    { timeoutMs: 5_000 }
  );
  const preContext = captureContextManifest(root);
  const envelope = buildTaskEnvelope({
    userRequest: "Preserve the task result during failed cleanup",
    objective: "Preserve the task result during failed cleanup",
    mode: "read",
    scope: { include: ["tracked.txt"], exclude: [] },
    contextManifestId: preContext.manifestId,
    context: {
      facts: [],
      constraints: [],
      expectedProjectMarkers: [],
      requiredPaths: ["tracked.txt"],
      workspaceState: "task_scoped",
      upstreamFreshness: "not_checked"
    },
    acceptanceCriteria: [{
      id: "AC-01",
      text: "A concurrent terminal result remains authoritative"
    }]
  });
  const workerNonce = crypto.randomBytes(16).toString("hex");
  const stamped = new Date().toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 3,
    id,
    kind: "task",
    jobClass: "task",
    title: "task: force-cancel cleanup failure race",
    summary: "Queued",
    write: false,
    status: "queued",
    phase: "queued",
    workspaceRoot: root,
    host: {
      kind: "claude-code",
      sessionId: env.GROK_COMPANION_HOST_SESSION_ID
    },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: null,
    updatedAt: stamped,
    completedAt: null,
    heartbeatAt: stamped,
    workerAuthorization: workerNonce,
    workerProcess: {
      pid: worker.pid,
      startToken: workerStartToken,
      nonce: workerNonce,
      processGroupId: worker.pid,
      commandMarker: id
    },
    providerProcess: null,
    profile: profileFor("task", false),
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: {
      prompt: null,
      providerHomeId: id,
      contextManifest: preContext,
      envelope
    },
    result: {
      hostVerification: "not_run",
      taskRuntimeCleaned: false,
      stopReason: "cancelled"
    },
    error: null
  });

  const cancellation = spawnCompanion(
    ["cancel", id, "--json"],
    { cwd: root, env }
  );
  await Promise.race([
    waitFor(
      () => fs.existsSync(signalMarker),
      { timeoutMs: 15_000, intervalMs: 25 }
    ),
    cancellation.completed.then((result) => {
      throw new Error(
        `force-cancel ended before task cleanup race checkpoint\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
      );
    })
  ]);
  const publishedAt = new Date().toISOString();
  updateJob(root, id, (job) => ({
    ...job,
    status: "completed",
    phase: "done",
    completedAt: publishedAt,
    heartbeatAt: publishedAt,
    summary: "Authoritative task result",
    progress: "Authoritative task result",
    error: null,
    result: {
      text: "Authoritative task result",
      hostVerification: "not_run",
      taskRuntimeCleaned: false,
      replay: false
    }
  }), env);

  const completed = await cancellation.completed;
  assert.equal(
    completed.code,
    0,
    `force-cancel failed\nstdout: ${completed.stdout}\nstderr: ${completed.stderr}`
  );
  const projected = JSON.parse(completed.stdout);
  assert.equal(projected.status, "completed");
  assert.equal(projected.phase, "done");
  assert.equal(projected.error, null);
  assert.equal(projected.summary, "Authoritative task result");
  const stored = readJob(root, id, env);
  assert.equal(stored.completedAt, publishedAt);
  assert.equal(stored.status, "completed");
  assert.equal(stored.phase, "done");
  assert.equal(stored.error, null);
  assert.equal(stored.pendingTerminal, undefined);
  assert.equal(stored.result.text, "Authoritative task result");
  assert.equal(stored.result.taskRuntimeCleaned, false);
  assert.equal(fs.lstatSync(authPath).isDirectory(), true);
});

test("force-cancel publishes final task drift after exact runtime cleanup", {
  skip: process.platform === "win32"
}, () => {
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("task");
  const taskHome = path.join(stateRoot, "task-homes", id, ".grok");
  fs.mkdirSync(
    path.join(taskHome, "agent-profiles"),
    { recursive: true, mode: 0o700 }
  );
  fs.writeFileSync(
    path.join(taskHome, "auth.json"),
    "{}\n",
    { mode: 0o600 }
  );
  fs.writeFileSync(
    path.join(taskHome, "agent-profiles", "staged.md"),
    "profile\n",
    { mode: 0o600 }
  );
  const preContext = captureContextManifest(root);
  const envelope = buildTaskEnvelope({
    userRequest: "force-cancel with final context drift",
    objective: "force-cancel with final context drift",
    mode: "read",
    scope: { include: ["tracked.txt"], exclude: [] },
    contextManifestId: preContext.manifestId,
    context: {
      facts: [],
      constraints: [],
      expectedProjectMarkers: [],
      requiredPaths: ["tracked.txt"],
      workspaceState: "task_scoped",
      upstreamFreshness: "not_checked"
    },
    acceptanceCriteria: [{
      id: "AC-01",
      text: "Final drift outranks force-cancellation"
    }]
  });
  const workerNonce = crypto.randomBytes(16).toString("hex");
  const stamped = new Date().toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 3,
    id,
    kind: "task",
    jobClass: "task",
    title: "task: force-cancel final evidence",
    summary: "Queued",
    write: false,
    status: "queued",
    phase: "queued",
    workspaceRoot: root,
    host: {
      kind: "claude-code",
      sessionId: env.GROK_COMPANION_HOST_SESSION_ID
    },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: null,
    updatedAt: stamped,
    completedAt: null,
    heartbeatAt: stamped,
    workerAuthorization: workerNonce,
    workerProcess: {
      pid: 999999989,
      startToken: "dead-worker-token",
      nonce: workerNonce,
      processGroupId: 999999989,
      commandMarker: id
    },
    providerProcess: null,
    profile: profileFor("task", false),
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: {
      prompt: null,
      providerHomeId: id,
      contextManifest: preContext,
      envelope
    },
    result: {
      hostVerification: "not_run",
      taskRuntimeCleaned: false
    },
    error: null
  });
  git(root, "config", "--local", "--add", "grok.issue49ForceCancel", "true");

  const cancelled = parseJson(runCompanion(["cancel", id, "--json"], {
    cwd: root,
    env,
    timeout: 20_000
  }));
  assert.equal(cancelled.status, "failed");
  assert.equal(cancelled.phase, "context-rejected");
  assert.equal(cancelled.error.code, "E_CONTEXT_DRIFT");
  assert.deepEqual(cancelled.error.details.reasons, ["[GIT_METADATA]"]);
  assert.equal(cancelled.result.taskRuntimeCleaned, true);
  assert.equal(cancelled.result.stopReason, undefined);
  assert.equal(cancelled.result.runtimeEvidence.executionStatus, "failed");
  assert.ok(
    cancelled.result.runtimeEvidence.observedChangedPaths.includes(
      "[GIT_METADATA]"
    )
  );
  assert.equal(
    cancelled.progress,
    "Task runtime cleanup completed; workspace safety review is required"
  );
  assert.equal(
    fs.readFileSync(
      path.join(stateRoot, "jobs", `${id}.cancel`),
      "utf8"
    ),
    `${workerNonce}\n`
  );
  assert.equal(fs.existsSync(path.join(taskHome, "auth.json")), false);
  assert.equal(fs.existsSync(path.join(taskHome, "agent-profiles")), false);
  assert.equal(readJob(root, id, env).result.stopReason, undefined);
});

test("force-cancel successful home cleanup clears prior privacy warning", { skip: process.platform === "win32" }, async (t) => {
  // Force-cancel path must use applyReviewPrivacy: a successful later cleanup clears a stale
  // privacyWarning rather than leaving it on the cancelled job.
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const isolatedHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(isolatedHome, "marker"), "force-cancel-clear\n", { mode: 0o600 });
  const workerNonce = crypto.randomBytes(16).toString("hex");
  const deadIdentity = { pid: 999999995, startToken: "dead-provider-token", processGroupId: 999999995 };
  const stamped = new Date().toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: force-cancel privacy clear",
    summary: "Queued",
    write: false,
    status: "queued",
    phase: "queued",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: null,
    updatedAt: stamped,
    completedAt: null,
    workerAuthorization: workerNonce,
    workerProcess: { pid: 999999991, startToken: "dead-worker-token", nonce: workerNonce, processGroupId: 999999991, commandMarker: id },
    providerProcess: null,
    profile: { id: "review", transport: "headless" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: { prompt: null, target: { mode: "working-tree", label: "fixture", base: null } },
    result: {
      review: { verdict: "pass", summary: "fixture", findings: [] },
      providerSessionDeleted: false,
      privacyWarning: "earlier-cleanup-failed"
    },
    error: null
  });
  registerProviderGuard(root, id, deadIdentity, env.GROK_COMPANION_HOST_SESSION_ID);
  t.after(() => { try { unregisterProviderGuard(root, id); } catch {} });

  const cancelled = parseJson(runCompanion(["cancel", id, "--json"], {
    cwd: root,
    env,
    timeout: 20000
  }));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.error.code, "E_CANCELLED");
  assert.match(cancelled.error.message, /force-cancelled/i);
  assert.equal(fs.existsSync(isolatedHome), false, "isolated home must be removed after successful force-cancel cleanup");
  assert.equal(cancelled.result?.providerSessionDeleted, true);
  assert.equal(cancelled.result?.privacyWarning, undefined, "successful cleanup must clear stale privacyWarning");
  assert.equal(cancelled.result?.review?.verdict, "pass", "prior review evidence must remain");
});

test("force-cancel failed home cleanup appends privacyWarning without erasing prior evidence", { skip: process.platform === "win32" }, async (t) => {
  // Force-cancel path must use applyReviewPrivacy: failed home cleanup appends a warning and
  // keeps prior privacy evidence rather than replacing the result object wholesale.
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const isolatedHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  const nest = path.join(isolatedHome, "undeletable-cleanup");
  fs.mkdirSync(nest, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(nest, "locked"), "locked\n", { mode: 0o600 });
  fs.chmodSync(nest, 0o000);
  const workerNonce = crypto.randomBytes(16).toString("hex");
  const deadIdentity = { pid: 999999994, startToken: "dead-provider-token", processGroupId: 999999994 };
  const stamped = new Date().toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: force-cancel privacy append",
    summary: "Queued",
    write: false,
    status: "queued",
    phase: "queued",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: null,
    updatedAt: stamped,
    completedAt: null,
    workerAuthorization: workerNonce,
    workerProcess: { pid: 999999993, startToken: "dead-worker-token", nonce: workerNonce, processGroupId: 999999993, commandMarker: id },
    providerProcess: null,
    profile: { id: "review", transport: "headless" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: { prompt: null, target: { mode: "working-tree", label: "fixture", base: null } },
    result: {
      review: { verdict: "pass", summary: "fixture", findings: [] },
      providerSessionDeleted: false,
      privacyWarning: "prior-privacy-signal"
    },
    error: null
  });
  registerProviderGuard(root, id, deadIdentity, env.GROK_COMPANION_HOST_SESSION_ID);
  t.after(() => {
    try { unregisterProviderGuard(root, id); } catch {}
    try { fs.chmodSync(nest, 0o700); } catch {}
    try { fs.rmSync(isolatedHome, { recursive: true, force: true }); } catch {}
  });

  try {
    const cancelled = parseJson(runCompanion(["cancel", id, "--json"], {
      cwd: root,
      env,
      timeout: 20000
    }));
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.error.code, "E_CANCELLED");
    assert.match(cancelled.error.message, /force-cancelled/i);
    assert.equal(fs.existsSync(isolatedHome), true, "failed cleanup must retain the isolated review home");
    assert.equal(cancelled.result?.providerSessionDeleted, false);
    assert.equal(
      cancelled.result?.privacyWarning,
      "Process ownership verification failed."
    );
    assert.equal(cancelled.result?.review?.verdict, "pass", "prior review evidence must remain");
    const stored = readJob(root, id, env);
    assert.match(stored.result?.privacyWarning || "", /^prior-privacy-signal; /);
    assert.ok(
      (stored.result?.privacyWarning || "").length
        > "prior-privacy-signal; ".length
    );
  } finally {
    try { fs.chmodSync(nest, 0o700); } catch {}
  }
});

test("force-cancel preserves guard and home when guard identity is live/unverifiable", { skip: process.platform === "win32" }, async (t) => {
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const isolatedHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(isolatedHome, "retained.txt"), "force-cancel-privacy\n", { mode: 0o600 });
  const workerNonce = crypto.randomBytes(16).toString("hex");

  const provider = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);"
  ], { detached: true, stdio: "ignore" });
  t.after(() => {
    try { process.kill(-provider.pid, "SIGKILL"); } catch {}
    try { unregisterProviderGuard(root, id); } catch {}
  });
  await waitFor(() => processGroupAlive(provider.pid), { timeoutMs: 5000 });
  const identity = { pid: provider.pid, startToken: "unverified-live-provider-token", processGroupId: provider.pid };
  const stamped = new Date().toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: force-cancel live guard-only provider",
    summary: "Queued",
    write: false,
    status: "queued",
    phase: "queued",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: null,
    updatedAt: stamped,
    completedAt: null,
    workerAuthorization: workerNonce,
    workerProcess: { pid: 999999990, startToken: "dead-worker-token", nonce: workerNonce, processGroupId: 999999990, commandMarker: id },
    providerProcess: null,
    profile: { id: "review", transport: "headless" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: { prompt: null, target: { mode: "working-tree", label: "fixture", base: null } },
    result: { privacyWarning: "prior-privacy-signal" },
    error: null
  });
  registerProviderGuard(root, id, identity, env.GROK_COMPANION_HOST_SESSION_ID);

  const failed = runCompanion(["cancel", id, "--json"], { cwd: root, env, timeout: 20000 });
  parseError(failed, "E_PROCESS_IDENTITY");
  assert.equal(fs.readFileSync(path.join(stateRoot, "jobs", `${id}.cancel`), "utf8"), `${workerNonce}\n`);
  assert.equal(processGroupAlive(provider.pid), true, "must not tear down an unverifiable live process group");
  assert.equal(hasForeignActiveProvider(root, null), true, "guard must be retained after force-cancel failure");
  assert.equal(fs.existsSync(path.join(isolatedHome, "retained.txt")), true, "isolated home must be retained");
  const job = JSON.parse(fs.readFileSync(path.join(stateRoot, "jobs", `${id}.json`), "utf8"));
  assert.equal(job.status, "running", "force-cancel failure must remain recoverable rather than falsely terminal");
  assert.equal(job.phase, "cleanup-blocked");
  assert.equal(job.pendingTerminal?.status, "cancelled");
  assert.equal(job.result?.providerSessionDeleted, false);
  assert.match(job.result?.privacyWarning || "", /prior-privacy-signal/);
  assert.match(job.result?.privacyWarning || "", /force-cancel process cleanup could not be verified/);
});

test("force-cancel persists cleanup-blocked when worker termination cannot be verified", { skip: process.platform === "win32" }, async (t) => {
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("task");
  const taskHome = path.join(stateRoot, "task-homes", id, ".grok");
  fs.mkdirSync(path.join(taskHome, "agent-profiles"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(taskHome, "auth.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(taskHome, "agent-profiles", "retained.md"), "profile\n", { mode: 0o600 });
  const worker = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", id], { detached: true, stdio: "ignore" });
  t.after(() => { try { process.kill(-worker.pid, "SIGKILL"); } catch {} });
  await waitFor(() => processGroupAlive(worker.pid), { timeoutMs: 5000 });
  const workerNonce = crypto.randomBytes(16).toString("hex");
  const stamped = new Date().toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 3,
    id,
    kind: "task",
    jobClass: "task",
    title: "task: force-cancel unverifiable worker",
    summary: "Queued",
    write: false,
    status: "queued",
    phase: "queued",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: null,
    updatedAt: stamped,
    completedAt: null,
    workerAuthorization: null,
    workerProcess: { pid: worker.pid, startToken: "unverified-worker-token", nonce: workerNonce, processGroupId: worker.pid, commandMarker: id },
    providerProcess: null,
    profile: profileFor("task", false),
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: { prompt: null, providerHomeId: id },
    result: { privacyWarning: "prior-task-privacy" },
    error: null
  });

  const failed = runCompanion(["cancel", id, "--json"], { cwd: root, env, timeout: 20_000 });
  parseError(failed, "E_PROCESS_IDENTITY");
  const job = JSON.parse(fs.readFileSync(path.join(stateRoot, "jobs", `${id}.json`), "utf8"));
  assert.equal(job.status, "running");
  assert.equal(job.phase, "cleanup-blocked");
  assert.equal(job.pendingTerminal?.status, "cancelled");
  assert.equal(job.result?.taskRuntimeCleaned, false);
  assert.match(job.result?.privacyWarning || "", /prior-task-privacy/);
  assert.match(job.result?.privacyWarning || "", /force-cancel process cleanup could not be verified/);
  assert.equal(processGroupAlive(worker.pid), true);
  assert.equal(fs.existsSync(path.join(taskHome, "auth.json")), true);
  assert.equal(fs.existsSync(path.join(taskHome, "agent-profiles", "retained.md")), true);
});

test("background cancellation writes a marker, sends ACP cancel, and reaches cancelled once", async () => {
  const root = initRepo();
  const { fake, env, pluginData } = fixture({ cancelMode: "wait" });
  const launch = parseJson(runCompanion(
    ["task", "--background", "wait until cancelled", "--json"],
    { cwd: root, env }
  ));

  await waitFor(() => {
    const result = runCompanion(["status", launch.id, "--json"], { cwd: root, env });
    if (result.status !== 0) return false;
    const job = persistedJob(pluginData, launch.id);
    return job.status === "running" && job.grokSessionId ? job : false;
  });

  const cancelled = parseJson(runCompanion(["cancel", launch.id, "--json"], {
    cwd: root,
    env,
    timeout: 15000
  }));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancelled.error.code, "E_CANCELLED");
  const stored = persistedJob(pluginData, launch.id);
  const marker = path.join(path.dirname(stored.logFile), `${launch.id}.cancel`);
  assert.equal(fs.readFileSync(marker, "utf8"), `${stored.workerProcess.nonce}\n`);
  assert.ok(readFakeLog(fake.logFile).some((entry) => entry.event === "cancel"));

  const second = parseJson(runCompanion(["cancel", launch.id, "--json"], { cwd: root, env }));
  assert.equal(second.status, "cancelled");
  assert.equal(second.completedAt, cancelled.completedAt);
});

test("worker ignores forged and missing cancellation nonces", async () => {
  for (const forged of ["wrong-worker-nonce\n", "\n"]) {
    const root = initRepo();
    const { fake, env, pluginData } = fixture({ cancelMode: "wait" });
    const launch = parseJson(runCompanion(
      ["task", "--background", "reject forged cancellation", "--json"],
      { cwd: root, env }
    ));

    const running = await waitFor(() => {
      const result = runCompanion(["status", launch.id, "--json"], { cwd: root, env });
      if (result.status !== 0) return false;
      const job = persistedJob(pluginData, launch.id);
      return job.status === "running" && job.grokSessionId ? job : false;
    });
    const marker = path.join(path.dirname(running.logFile), `${launch.id}.cancel`);
    fs.writeFileSync(marker, forged, { mode: 0o600 });

    await new Promise((resolve) => setTimeout(resolve, 350));
    const afterForgery = parseJson(runCompanion(["status", launch.id, "--json"], { cwd: root, env }));
    assert.equal(afterForgery.status, "running", `worker accepted forged marker ${JSON.stringify(forged)}`);
    assert.equal(readFakeLog(fake.logFile).some((entry) => entry.event === "cancel"), false);

    const cancelled = parseJson(runCompanion(["cancel", launch.id, "--json"], {
      cwd: root,
      env,
      timeout: 15000
    }));
    assert.equal(cancelled.status, "cancelled");
    assert.equal(fs.readFileSync(marker, "utf8"), `${persistedJob(pluginData, launch.id).workerProcess.nonce}\n`);
  }
});

test("background review cancellation terminates the headless process and preserves the workspace", async () => {
  const root = initRepo();
  const tracked = path.join(root, "tracked.txt");
  fs.appendFileSync(tracked, "review cancellation fixture\n", "utf8");
  const before = fs.readFileSync(tracked, "utf8");
  const { fake, env, pluginData } = fixture({ headlessDelayMs: 60_000 });
  const launch = parseJson(runCompanion(
    ["review", "--background", "--json"],
    { cwd: root, env }
  ));

  await waitFor(() => {
    const status = runCompanion(["status", launch.id, "--json"], { cwd: root, env });
    if (status.status !== 0) return false;
    const job = persistedJob(pluginData, launch.id);
    const headlessStarted = readFakeLog(fake.logFile).some((entry) => entry.event === "headless");
    return job.status === "running" && job.providerProcess?.pid && headlessStarted ? job : false;
  });

  const cancelled = parseJson(runCompanion(["cancel", launch.id, "--json"], {
    cwd: root,
    env,
    timeout: 15000
  }));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancelled.error.code, "E_CANCELLED");
  assert.equal(fs.readFileSync(tracked, "utf8"), before);
  const stored = persistedJob(pluginData, launch.id);
  assert.equal(fs.existsSync(path.join(path.dirname(path.dirname(stored.logFile)), "review-homes", launch.id)), false);

  const providerLog = readFakeLog(fake.logFile);
  assert.ok(providerLog.some((entry) => entry.event === "headless"));
  assert.ok(providerLog.some(
    (entry) => entry.event === "signal" && entry.signal === "SIGTERM" && entry.transport === "headless"
  ));
  assert.equal(providerLog.some((entry) => entry.event === "rpc"), false);
});

test("status recovers a background task whose worker crashes without replaying its prompt", { skip: process.platform === "win32" }, async () => {
  const root = initRepo();
  const { fake, env, pluginData } = fixture({ cancelMode: "wait" });
  const launch = parseJson(runCompanion(
    ["task", "--background", "worker crash fixture", "--json"],
    { cwd: root, env }
  ));
  const running = await waitFor(() => {
    const result = runCompanion(["status", launch.id, "--json"], { cwd: root, env });
    if (result.status !== 0) return false;
    const job = persistedJob(pluginData, launch.id);
    return job.status === "running" && job.providerProcess?.pid ? job : false;
  });

  process.kill(running.workerProcess.pid, "SIGKILL");
  const recovered = await waitFor(() => {
    const result = runCompanion(["status", launch.id, "--json"], { cwd: root, env });
    if (result.status !== 0) return false;
    const job = JSON.parse(result.stdout);
    return job.status === "failed" ? job : false;
  }, { timeoutMs: 15000 });
  assert.equal(recovered.error.code, "E_WORKER_LOST");
  assert.match(recovered.error.message, /prompt was not replayed/i);
  assert.ok(readFakeLog(fake.logFile).filter((entry) => entry.event === "prompt").length <= 1, "crashed background prompt was replayed");
  assert.equal(recovered.result?.taskRuntimeCleaned, true, "worker-crash recovery did not clean transient task artifacts");
  const stored = persistedJob(pluginData, launch.id);
  const taskHome = path.join(
    path.dirname(path.dirname(stored.logFile)),
    "task-homes",
    stored.request?.providerHomeId || stored.id,
    ".grok"
  );
  assert.equal(fs.existsSync(path.join(taskHome, "auth.json")), false, "worker-crash recovery retained the task credential");
  assert.equal(fs.existsSync(path.join(taskHome, "agent-profiles")), false, "worker-crash recovery retained the staged profile");
});
