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

test("transfer helpers format model-qualified resume and parse non-isolated models text", async () => {
  const {
    formatResumeCommand,
    parseAdvertisedModels,
    selectTransferModel,
    assertTransferEffort,
    deleteSession,
    inspectImportedSessionPresence,
    isImportedSessionReady,
    waitForImportedSession
  } = await import("../plugins/grok/scripts/lib/grok-provider.mjs");
  const { installFakeGrok, readFakeLog } = await import("./fake-grok.mjs");

  assert.equal(
    formatResumeCommand("12345678-1234-4234-8234-123456789abc", "grok-4.5"),
    "grok --model grok-4.5 --resume 12345678-1234-4234-8234-123456789abc"
  );
  assert.equal(
    formatResumeCommand("12345678-1234-4234-8234-123456789abc", "grok-4.5", "high"),
    "grok --model grok-4.5 --reasoning-effort high --resume 12345678-1234-4234-8234-123456789abc"
  );

  const models = parseAdvertisedModels(`
You are logged in with grok.com.

Default model: grok-primary

Available models:
  * grok-primary (default) efforts=low,medium,high
  - grok-secondary efforts=low
`);
  assert.deepEqual(models.map((item) => item.id), ["grok-primary", "grok-secondary"]);
  assert.deepEqual(models[0].efforts, ["low", "medium", "high"]);
  assert.equal(selectTransferModel(models).id, "grok-primary");
  assert.equal(selectTransferModel(models, "grok-secondary").id, "grok-secondary");
  assert.throws(
    () => selectTransferModel(models, "missing"),
    (error) => error?.code === "E_CAPABILITY"
  );
  assert.throws(
    () => assertTransferEffort(models[1], "high"),
    (error) => error?.code === "E_CAPABILITY" && /effort high/i.test(error.message)
  );
  assertTransferEffort(models[0], "high");

  const sessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const fake = installFakeGrok(tempDir("fake-grok-ready-"), {
    importSessionId: sessionId,
    importReadyAfterMs: 80
  });
  // Simulate a completed import registration without running transfer end-to-end.
  const storePath = `${fake.binary}.sessions.json`;
  fs.writeFileSync(storePath, JSON.stringify({
    sessions: [{ id: sessionId, readyAt: Date.now(), neverReady: true }]
  }), "utf8");
  assert.deepEqual(inspectImportedSessionPresence(sessionId, fake.binary), {
    ok: true,
    present: false
  });
  assert.equal(isImportedSessionReady(sessionId, fake.binary), false);
  const publish = setTimeout(() => fs.writeFileSync(storePath, JSON.stringify({
    sessions: [{ id: sessionId, readyAt: Date.now(), neverReady: false }]
  }), "utf8"), 80);
  try {
    await waitForImportedSession(sessionId, {
      binary: fake.binary,
      timeoutMs: 1500,
      intervalMs: 30
    });
  } finally {
    clearTimeout(publish);
  }
  assert.deepEqual(inspectImportedSessionPresence(sessionId, fake.binary), {
    ok: true,
    present: true
  });
  assert.equal(isImportedSessionReady(sessionId, fake.binary), true);
  assert.equal(deleteSession(sessionId, fake.binary).ok, true);
  assert.deepEqual(inspectImportedSessionPresence(sessionId, fake.binary), {
    ok: true,
    present: false
  });
  const listEvents = readFakeLog(fake.logFile).filter((entry) => entry.event === "sessions-list");
  assert.ok(listEvents.length >= 2);

  fs.writeFileSync(storePath, JSON.stringify({
    sessions: [{ id: sessionId, readyAt: Date.now(), neverReady: true }]
  }), "utf8");
  await assert.rejects(
    () => waitForImportedSession(sessionId, { binary: fake.binary, timeoutMs: 120, intervalMs: 30 }),
    (error) => error?.code === "E_IMPORT_RESULT" && /not yet observable/i.test(error.message)
  );

  const missingBinary = path.join(path.dirname(fake.binary), "missing-grok");
  assert.deepEqual(inspectImportedSessionPresence(sessionId, missingBinary), {
    ok: false,
    present: false
  });
  assert.equal(isImportedSessionReady(sessionId, missingBinary), false);
  assert.deepEqual(inspectImportedSessionPresence("", fake.binary), {
    ok: false,
    present: false
  });

  const header = "SESSION ID                            CREATED     UPDATED     STATUS      SUMMARY\n";
  for (const [label, output, stderr, expected] of [
    ["empty", "", "", { ok: false, present: false }],
    ["official-empty", "No sessions found.\n", "", { ok: true, present: false }],
    ["header-only", header, "", { ok: false, present: false }],
    ["malformed", "not a session table\n", "", { ok: false, present: false }],
    [
      "summary-only",
      `${header}aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa  2026-07-14  2026-07-14  local  ${sessionId}\n`,
      "",
      { ok: true, present: false }
    ],
    ["stderr-only", header, `${sessionId}\n`, { ok: false, present: false }],
    [
      "sentinel-with-table",
      `No sessions found.\n${header}`,
      "",
      { ok: false, present: false }
    ],
    [
      "malformed-label",
      `Label:\n${header}${sessionId}  2026-07-14  2026-07-14  local  imported\n`,
      "",
      { ok: false, present: false }
    ],
    [
      "empty-labeled-group",
      `Label: empty\n${header}`,
      "",
      { ok: false, present: false }
    ],
    [
      "duplicate-label",
      `Label: duplicate\n${header}aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa  2026-07-14  2026-07-14  local  one\nLabel: duplicate\n${header}bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb  2026-07-14  2026-07-14  local  two\n`,
      "",
      { ok: false, present: false }
    ],
    [
      "warning-row",
      `${header}WARNING partial output truncated now\n`,
      "",
      { ok: false, present: false }
    ],
    [
      "impossible-date",
      `${header}aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa  9999-99-99  2026-02-31  local  row\n`,
      "",
      { ok: false, present: false }
    ]
  ]) {
    const special = installFakeGrok(tempDir(`fake-grok-ready-${label}-`), {
      sessionsListOutput: output,
      sessionsListStderr: stderr
    });
    assert.deepEqual(inspectImportedSessionPresence(sessionId, special.binary), expected, label);
  }

  const saturatedRows = Array.from({ length: 200 }, (_, index) => (
    `${String(index + 1).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa  2026-07-14  2026-07-14  local  row-${index}`
  ));
  const saturated = installFakeGrok(tempDir("fake-grok-ready-saturated-"), {
    sessionsListOutput: `${header}${saturatedRows.join("\n")}\n`
  });
  assert.deepEqual(inspectImportedSessionPresence(sessionId, saturated.binary), {
    ok: false,
    present: false
  });

  const grouped = installFakeGrok(tempDir("fake-grok-ready-grouped-"), {
    sessionsListOutput: `(no label)\n${header}${sessionId}  2026-07-14  2026-07-14  local  imported\n`
  });
  assert.deepEqual(inspectImportedSessionPresence(sessionId, grouped.binary), {
    ok: true,
    present: true
  });
  const officiallyGrouped = installFakeGrok(tempDir("fake-grok-ready-official-grouped-"), {
    sessionsListOutput: `Label: qualification\n${header}${sessionId}  2026-07-14  2026-07-14  local  imported\n`
  });
  assert.deepEqual(inspectImportedSessionPresence(sessionId, officiallyGrouped.binary), {
    ok: true,
    present: true
  });
});

test("runtime rejects conflicting execution flags and nested companion invocation", () => {
  const root = initRepo();
  const { env } = fixture();
  const conflict = runCompanion(
    ["task", "--wait", "--background", "conflict", "--json"],
    { cwd: root, env }
  );
  assert.equal(conflict.status, 2);
  assert.equal(JSON.parse(conflict.stdout).error.code, "E_USAGE");

  const nested = runCompanion(["task", "nested", "--json"], {
    cwd: root,
    env: { ...env, GROK_COMPANION_CHILD: "1" }
  });
  assert.equal(nested.status, 7);
  assert.equal(JSON.parse(nested.stdout).error.code, "E_RECURSION");

  const markerOnly = runCompanion(["setup", "--json"], {
    cwd: root,
    env: { ...env, GROK_COMPANION_JOB_MARKER: "forged-provider-context" }
  });
  assert.equal(markerOnly.status, 7);
  assert.equal(JSON.parse(markerOnly.stdout).error.code, "E_RECURSION");
});

test("transfer imports only regular Claude JSONL files beneath the canonical projects directory", () => {
  const root = initRepo();
  const home = tempDir("grok-transfer-home-");
  const projects = path.join(home, ".claude", "projects", "fixture");
  fs.mkdirSync(projects, { recursive: true });
  const source = path.join(projects, "session.jsonl");
  const originalTranscript = '{"type":"user"}\n';
  fs.writeFileSync(source, originalTranscript, "utf8");
  const { fake, env } = fixture({
    importSessionId: "12345678-1234-4234-8234-123456789abc",
    importSpawnStubbornDescendant: true,
    importAppendSourcePath: source,
    importAppendText: "APPENDED_AFTER_TRANSFER_STARTED\n"
  });
  const transferEnv = { ...env, HOME: home };

  const imported = parseJson(runCompanion(["transfer", "--source", source, "--json"], { cwd: root, env: transferEnv }));
  assert.equal(imported.sessionId, "12345678-1234-4234-8234-123456789abc");
  assert.equal(imported.model, "grok-test");
  assert.equal(imported.resume, "grok --model grok-test --resume 12345678-1234-4234-8234-123456789abc");
  const importInvocation = readFakeLog(fake.logFile).find((entry) => entry.event === "argv" && entry.args[0] === "import");
  const importPath = importInvocation.args.at(-1);
  assert.match(path.basename(importPath), /^import-[a-f0-9]{24}\.jsonl$/);
  assert.equal(importInvocation.args.includes(source), false, "transfer exposed the source transcript path to Grok");
  assert.equal(fs.existsSync(importPath), false, "transfer left its descriptor alias behind");
  const importInput = readFakeLog(fake.logFile).find((entry) => entry.event === "import-input");
  assert.equal(importInput.bytes, Buffer.byteLength(originalTranscript));
  assert.equal(importInput.sha256, crypto.createHash("sha256").update(originalTranscript).digest("hex"));
  assert.match(fs.readFileSync(source, "utf8"), /APPENDED_AFTER_TRANSFER_STARTED/);
  // Same non-isolated home for models listing, import, and readiness (not setup-probe review-homes).
  const modelsLog = readFakeLog(fake.logFile).find((entry) => entry.event === "models");
  assert.ok(modelsLog);
  assert.equal(modelsLog.home, home);
  assert.equal(modelsLog.grokHome, null);
  assert.equal(importInput.home, home);
  assert.equal(importInput.grokHome, null);
  const listLog = readFakeLog(fake.logFile).find((entry) => entry.event === "sessions-list");
  assert.ok(listLog);
  assert.equal(listLog.home, home);
  assert.ok(listLog.sessionIds.includes(imported.sessionId));
  // Logs must not retain source paths or transcript bodies.
  for (const entry of readFakeLog(fake.logFile)) {
    assert.equal(JSON.stringify(entry).includes(source), false);
    assert.equal(JSON.stringify(entry).includes('"type":"user"'), false);
  }

  const descendant = readFakeLog(fake.logFile).find((entry) => entry.event === "descendant" && entry.transport === "import");
  assert.ok(descendant?.pid);
  assert.equal(processStartToken(descendant.pid), null);
  assert.equal(processGroupAlive(descendant.processGroupId), false);

  const outside = path.join(home, "outside.jsonl");
  fs.writeFileSync(outside, "{}\n", "utf8");
  const escaped = runCompanion(["transfer", "--source", outside, "--json"], { cwd: root, env: transferEnv });
  assert.equal(escaped.status, 5);
  assert.equal(JSON.parse(escaped.stdout).error.code, "E_IMPORT_SOURCE");

  const link = path.join(projects, "linked.jsonl");
  fs.symlinkSync(source, link);
  const symlinked = runCompanion(["transfer", "--source", link, "--json"], { cwd: root, env: transferEnv });
  assert.equal(symlinked.status, 5);
  assert.equal(JSON.parse(symlinked.stdout).error.code, "E_IMPORT_SOURCE");
});

test("Codex wrapper imports the captured current transcript through a privacy-filtered descriptor", () => {
  const root = fs.realpathSync(initRepo());
  const { fake, env } = fixture({ importSessionId: "12345678-1234-4234-8234-123456789abc" });
  const home = tempDir("grok-codex-transfer-home-");
  const codexHome = path.join(home, ".codex");
  const sessions = path.join(codexHome, "sessions", "2026", "07", "13");
  const pluginData = path.join(codexHome, "plugins", "data", "grok-grok-companion");
  const threadId = crypto.randomUUID();
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const source = path.join(sessions, `rollout-${threadId}.jsonl`);
  const records = [
    { timestamp: "2026-07-13T10:00:00.000Z", type: "session_meta", payload: { id: threadId, cwd: root, cli_version: "0.143.0" } },
    { timestamp: "2026-07-13T10:00:01.000Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "HIDDEN_DEVELOPER_TEXT" }] } },
    { timestamp: "2026-07-13T10:00:02.000Z", type: "event_msg", payload: { type: "user_message", message: "VISIBLE_CODEX_USER_TEXT" } },
    { timestamp: "2026-07-13T10:00:03.000Z", type: "response_item", payload: { type: "reasoning", summary: [{ text: "HIDDEN_REASONING_TEXT" }] } },
    { timestamp: "2026-07-13T10:00:04.000Z", type: "response_item", payload: { type: "function_call_output", output: "HIDDEN_TOOL_TEXT" } },
    { timestamp: "2026-07-13T10:00:05.000Z", type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "VISIBLE_CODEX_ASSISTANT_TEXT" } }
  ];
  fs.writeFileSync(source, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  writeCodexSessionMetadata(pluginData, { sessionId: threadId, transcriptPath: source, cwd: root });

  const transferEnv = {
    ...env,
    HOME: home,
    CODEX_HOME: codexHome,
    CODEX_THREAD_ID: threadId
  };
  delete transferEnv.CLAUDE_PLUGIN_DATA;
  delete transferEnv.GROK_COMPANION_CLAUDE_SESSION_ID;
  delete transferEnv.GROK_COMPANION_HOST;
  delete transferEnv.GROK_COMPANION_HOST_SESSION_ID;
  delete transferEnv.GROK_COMPANION_PLUGIN_DATA;

  const imported = parseJson(runCodexCompanion(["transfer", "--json"], { cwd: root, env: transferEnv }));
  assert.equal(imported.source, fs.realpathSync(source));
  assert.equal(imported.sourceFormat, "codex");
  assert.equal(imported.sessionId, "12345678-1234-4234-8234-123456789abc");
  const invocation = readFakeLog(fake.logFile).find((entry) => entry.event === "argv" && entry.args[0] === "import");
  assert.equal(invocation.args.includes(source), false);
  const importedInput = readFakeLog(fake.logFile).find((entry) => entry.event === "import-input");
  assert.ok(importedInput.bytes > 0);
  assert.notEqual(importedInput.bytes, fs.statSync(source).size, "raw Codex transcript was forwarded without filtering");
});

test("transfer rejects unavailable model/effort before conversion or alias artifacts", () => {
  const root = fs.realpathSync(initRepo());
  const { fake, env } = fixture({ importSessionId: "12345678-1234-4234-8234-123456789abc" });
  const home = tempDir("grok-transfer-cap-home-");
  const codexHome = path.join(home, ".codex");
  const sessions = path.join(codexHome, "sessions", "2026", "07", "13");
  const pluginData = path.join(codexHome, "plugins", "data", "grok-grok-companion");
  const threadId = crypto.randomUUID();
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const source = path.join(sessions, `rollout-${threadId}.jsonl`);
  // Valid Codex transcript that would require conversion if capability checks ran later.
  const records = [
    { timestamp: "2026-07-13T10:00:00.000Z", type: "session_meta", payload: { id: threadId, cwd: root, cli_version: "0.143.0" } },
    { timestamp: "2026-07-13T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "VISIBLE_CODEX_USER_TEXT" } },
    { timestamp: "2026-07-13T10:00:02.000Z", type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "VISIBLE_CODEX_ASSISTANT_TEXT" } }
  ];
  fs.writeFileSync(source, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  writeCodexSessionMetadata(pluginData, { sessionId: threadId, transcriptPath: source, cwd: root });

  const transferEnv = {
    ...env,
    HOME: home,
    CODEX_HOME: codexHome,
    CODEX_THREAD_ID: threadId
  };
  delete transferEnv.CLAUDE_PLUGIN_DATA;
  delete transferEnv.GROK_COMPANION_CLAUDE_SESSION_ID;
  delete transferEnv.GROK_COMPANION_HOST;
  delete transferEnv.GROK_COMPANION_HOST_SESSION_ID;
  delete transferEnv.GROK_COMPANION_PLUGIN_DATA;

  function assertFailedBeforeArtifacts(result, restrictedLog = null) {
    assert.notEqual(result.status, 0, result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "E_CAPABILITY");
    assert.match(payload.error.message, /not advertised|not-a-real-model|effort high/i);
    // Ordering proof: imports dir is created only after same-home model capability succeeds.
    const previous = process.env.GROK_COMPANION_PLUGIN_DATA;
    process.env.GROK_COMPANION_PLUGIN_DATA = pluginData;
    try {
      const importsDir = path.join(workspaceState(root), "imports");
      assert.equal(fs.existsSync(importsDir), false, "must not create import/conversion artifacts before capability acceptance");
    } finally {
      if (previous === undefined) delete process.env.GROK_COMPANION_PLUGIN_DATA;
      else process.env.GROK_COMPANION_PLUGIN_DATA = previous;
    }
    assert.equal(readFakeLog(fake.logFile).some((entry) => entry.event === "import-input"), false, "import must not run");
    if (restrictedLog) {
      assert.equal(readFakeLog(restrictedLog).some((entry) => entry.event === "import-input"), false);
    }
    return payload.error;
  }

  const modelError = assertFailedBeforeArtifacts(runCodexCompanion(
    ["transfer", "--source", source, "--model", "not-a-real-model", "--json"],
    { cwd: root, env: transferEnv }
  ));
  assert.match(modelError.message, /not-a-real-model|not advertised/i);

  const restricted = installFakeGrok(tempDir("fake-grok-transfer-effort-"), {
    models: [{ modelId: "grok-test", _meta: { reasoningEfforts: [{ id: "low" }] } }],
    importSessionId: "12345678-1234-4234-8234-123456789abc"
  });
  const effortError = assertFailedBeforeArtifacts(
    runCodexCompanion(
      ["transfer", "--source", source, "--model", "grok-test", "--effort", "high", "--json"],
      { cwd: root, env: { ...transferEnv, GROK_BIN: restricted.binary, GROK_AUTH_PATH: restricted.authPath } }
    ),
    restricted.logFile
  );
  assert.match(effortError.message, /effort high|not advertised/i);

  // Successful import returns a model-qualified resume including requested effort.
  const imported = parseJson(runCodexCompanion(
    ["transfer", "--source", source, "--model", "grok-test", "--effort", "high", "--json"],
    { cwd: root, env: transferEnv }
  ));
  assert.equal(imported.model, "grok-test");
  assert.equal(imported.effort, "high");
  assert.equal(
    imported.resume,
    "grok --model grok-test --reasoning-effort high --resume 12345678-1234-4234-8234-123456789abc"
  );
});

test("transfer selects resume model from non-isolated models listing and model-qualifies resume", () => {
  const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const { root, source, env, fake } = transferFixture({
    models: [
      { modelId: "grok-secondary", _meta: { reasoningEfforts: [{ id: "low" }] } },
      { modelId: "grok-primary", default: true, _meta: { reasoningEfforts: [{ id: "low" }, { id: "high" }] } }
    ],
    defaultModel: "grok-primary",
    importSessionId: sessionId
  });
  const home = env.HOME;
  const imported = parseJson(runCompanion(["transfer", "--source", source, "--json"], { cwd: root, env }));
  assert.equal(imported.model, "grok-primary");
  assert.equal(imported.effort, null);
  assert.equal(imported.resume, `grok --model grok-primary --resume ${sessionId}`);

  const secondary = parseJson(runCompanion(
    ["transfer", "--source", source, "--model", "grok-secondary", "--effort", "low", "--json"],
    { cwd: root, env }
  ));
  assert.equal(secondary.model, "grok-secondary");
  assert.equal(secondary.effort, "low");
  assert.equal(
    secondary.resume,
    `grok --model grok-secondary --reasoning-effort low --resume ${sessionId}`
  );

  const modelsEvents = readFakeLog(fake.logFile).filter((entry) => entry.event === "models");
  assert.ok(modelsEvents.length >= 2);
  for (const event of modelsEvents) {
    assert.equal(event.home, home, "models listing must use the non-isolated HOME");
    assert.equal(event.grokHome, null, "models listing must not use an isolated GROK_HOME");
  }
  const importEvents = readFakeLog(fake.logFile).filter((entry) => entry.event === "import-input");
  assert.ok(importEvents.length >= 2);
  for (const event of importEvents) {
    assert.equal(event.home, home);
    assert.equal(event.grokHome, null);
  }
  // Transfer must not open the isolated setup-probe review home path.
  const previous = process.env.GROK_COMPANION_PLUGIN_DATA;
  process.env.GROK_COMPANION_PLUGIN_DATA = env.GROK_COMPANION_PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA;
  try {
    const reviewHomes = path.join(workspaceState(root), "review-homes");
    assert.equal(fs.existsSync(reviewHomes), false, "transfer must not create isolated setup-probe homes");
  } finally {
    if (previous === undefined) delete process.env.GROK_COMPANION_PLUGIN_DATA;
    else process.env.GROK_COMPANION_PLUGIN_DATA = previous;
  }
});

test("transfer waits for import readiness delay then succeeds", () => {
  const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const { root, source, env, fake } = transferFixture({
    importSessionId: sessionId,
    importReadyAfterPolls: 2
  });
  const imported = parseJson(runCompanion(["transfer", "--source", source, "--json"], {
    cwd: root,
    env: {
      ...env,
      GROK_COMPANION_TEST_IMPORT_READY_TIMEOUT_MS: "2000",
      GROK_COMPANION_TEST_IMPORT_READY_INTERVAL_MS: "40"
    }
  }));
  assert.equal(imported.sessionId, sessionId);
  assert.equal(imported.resume, `grok --model grok-test --resume ${sessionId}`);
  const listEvents = readFakeLog(fake.logFile).filter((entry) => entry.event === "sessions-list");
  assert.ok(listEvents.length >= 2, "readiness delay should require more than one exact session-list poll");
  assert.ok(listEvents.some((entry) => entry.sessionIds.includes(sessionId)));
});

test("transfer fails closed when imported session never becomes observable", () => {
  const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const { root, source, env, fake } = transferFixture({
    importSessionId: sessionId,
    importNeverReady: true
  });
  const result = runCompanion(["transfer", "--source", source, "--json"], {
    cwd: root,
    env: {
      ...env,
      GROK_COMPANION_TEST_IMPORT_READY_TIMEOUT_MS: "250",
      GROK_COMPANION_TEST_IMPORT_READY_INTERVAL_MS: "40"
    }
  });
  const error = parseError(result, "E_IMPORT_RESULT");
  assert.match(error.message, /not yet observable for resume/i);
  assert.equal(error.details?.sessionId, sessionId);
  assert.equal(readFakeLog(fake.logFile).some((entry) => entry.event === "import-input"), true);
  const listEvents = readFakeLog(fake.logFile).filter((entry) => entry.event === "sessions-list");
  assert.ok(listEvents.length >= 1);
  assert.equal(listEvents.every((entry) => !entry.sessionIds.includes(sessionId)), true);
  // No transcript body or source path in provider logs/argv.
  for (const entry of readFakeLog(fake.logFile)) {
    assert.equal(JSON.stringify(entry).includes(source), false);
    assert.equal(JSON.stringify(entry).includes('"type":"user"'), false);
  }
});

test("transfer rejects malformed UUIDs, malformed NDJSON, and nonzero import exits", () => {
  {
    const { root, source, env } = transferFixture({ importSessionId: "not-a-session-uuid" });
    const error = parseError(
      runCompanion(["transfer", "--source", source, "--json"], { cwd: root, env }),
      "E_IMPORT_RESULT"
    );
    assert.match(error.message, /no usable session ID/i);
  }

  {
    const { root, source, env } = transferFixture({ importOutput: '{"sessionId":' });
    const error = parseError(
      runCompanion(["transfer", "--source", source, "--json"], { cwd: root, env }),
      "E_IMPORT_RESULT"
    );
    assert.match(error.message, /malformed NDJSON/i);
  }

  {
    const secret = "xai-abcdefghijklmnopqrstuvwxyz";
    const { root, source, env } = transferFixture({
      importExitCode: 19,
      importStderr: `provider failed with ${secret}\n`
    });
    const result = runCompanion(["transfer", "--source", source, "--json"], { cwd: root, env });
    const error = parseError(result, "E_IMPORT_RESULT");
    assert.match(error.message, /could not import/i);
    assert.equal(JSON.stringify(error).includes(secret), false);
    assert.equal(result.stdout.includes("xai-"), false);
  }
});

test("transfer rejects multiple different session IDs from NDJSON", () => {
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const { root, source, env } = transferFixture({
    importRecords: [
      { event: "started", sessionId: first },
      { event: "completed", grok_session_id: second }
    ]
  });
  const result = runCompanion(["transfer", "--source", source, "--json"], { cwd: root, env });
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  if (payload.error.code === "E_PROCESS_IDENTITY") {
    // Probe teardown may fail closed when process identity is unavailable.
    return;
  }
  const error = parseError(result, "E_IMPORT_RESULT");
  assert.match(error.message, /multiple different session IDs/i);
  assert.ok(error.details?.sessionIds?.includes(first));
  assert.ok(error.details?.sessionIds?.includes(second));
});

test("execute review-finally gate retains isolated home when resolved process group remains live", { skip: process.platform === "win32" }, async (t) => {
  // Deterministic execute-finally path: resolveProviderCleanupTarget(job) + gatedCleanupReviewEnvironment
  // with a live group must retain the credential home and never claim providerSessionDeleted.
  const { gatedCleanupReviewEnvironment } = await import("../plugins/grok/scripts/lib/grok-provider.mjs");
  const { resolveProviderCleanupTarget } = await import("../plugins/grok/scripts/lib/recursion-guard.mjs");
  const root = fs.realpathSync(initRepo());
  const { pluginData, env } = fixture();
  // Seed workspace state layout used by execute finally.
  parseJson(runCompanion(["review", "--scope", "working-tree", "--json"], { cwd: root, env }));
  const jobs = persistedJobs(pluginData);
  assert.ok(jobs.length >= 1);
  const stateRoot = path.dirname(path.dirname(jobs[0].logFile));
  const id = generateId("review");
  const home = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, "credential"), "execute-finally-retained\n", { mode: 0o600 });

  const live = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);"
  ], { detached: true, stdio: "ignore" });
  t.after(() => { try { process.kill(-live.pid, "SIGKILL"); } catch {} });
  await waitFor(() => processGroupAlive(live.pid), { timeoutMs: 5000 });
  const job = {
    id,
    providerProcess: {
      pid: live.pid,
      startToken: processStartToken(live.pid) || "unavailable-live-token",
      processGroupId: live.pid
    }
  };
  const { identity } = resolveProviderCleanupTarget(root, job);
  const cleanup = gatedCleanupReviewEnvironment(stateRoot, id, identity);
  assert.equal(cleanup.ok, false);
  assert.match(cleanup.warning, /Isolated review home retained/i);
  assert.equal(fs.existsSync(path.join(home, "credential")), true);
  assert.equal(processGroupAlive(live.pid), true, "gate must not signal the live group");
});

test("transfer preserves imported session identity when private alias cleanup fails", () => {
  const sessionId = "12345678-1234-4234-8234-123456789abc";
  const { root, source, env } = transferFixture({
    importSessionId: sessionId,
    importPoisonAlias: true
  });
  const result = runCompanion(["transfer", "--source", source, "--json"], { cwd: root, env });
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  if (payload.error.code === "E_PROCESS_IDENTITY") {
    return;
  }
  const error = parseError(result, "E_STATE");
  assert.match(error.message, /cleanup failed/i);
  assert.match(error.message, new RegExp(sessionId));
  assert.equal(error.details?.sessionId, sessionId);
  assert.equal(error.details?.resume, `grok --model grok-test --resume ${sessionId}`);
  assert.equal(error.details?.delete, `grok sessions delete ${sessionId}`);
  assert.ok(error.details?.privacyWarning || error.details?.warning, "privacy failure must remain explicit");
  assert.match(String(error.details?.privacyWarning || error.details?.warning), /\S/);
});

test("attachTransferCleanupEvidence preserves primary probe/import codes with injected dispose/close/unlink failures", () => {
  const secret = "xai-abcdefghijklmnopqrstuvwxyz";

  // Primary probe/capability error + injected close failure: code/message stay; warning attached;
  // source-fd close alone is not residual private alias/converted evidence.
  {
    const primary = new CompanionError("E_CAPABILITY", "Model not-a-real-model is not advertised by Grok.", {
      available: ["grok-test"]
    });
    const attached = attachTransferCleanupEvidence(primary, ["injected close failure"], { privacy: false });
    assert.equal(attached.code, "E_CAPABILITY");
    assert.match(attached.message, /not-a-real-model/);
    assert.deepEqual(attached.details.available, ["grok-test"]);
    assert.equal(attached.details.warning, "injected close failure");
    assert.equal(attached.details.privacyWarning, undefined);
  }

  // Primary import failure + dispose/unlink evidence: privacyWarning required; prior details kept;
  // secrets in diagnostics/warnings are redacted in structured output.
  {
    const primary = new CompanionError(
      "E_IMPORT_RESULT",
      "Grok could not import the Claude Code transcript.",
      { diagnostic: `provider failed with ${secret}` }
    );
    const attached = attachTransferCleanupEvidence(
      primary,
      ["injected dispose failure", "injected unlink failure", `leftover path with ${secret}`],
      { privacy: true }
    );
    assert.equal(attached.code, "E_IMPORT_RESULT");
    assert.match(attached.message, /could not import/i);
    assert.match(attached.details.diagnostic, new RegExp(secret));
    assert.match(attached.details.warning, /injected dispose failure/);
    assert.match(attached.details.warning, /injected unlink failure/);
    assert.match(attached.details.warning, new RegExp(secret));
    assert.match(attached.details.privacyWarning, /injected dispose failure/);
    assert.match(attached.details.privacyWarning, /injected unlink failure/);
    // No warning lost across appends.
    assert.equal(
      attached.details.warning,
      `injected dispose failure; injected unlink failure; leftover path with ${secret}`
    );
    const redacted = redact(asErrorPayload(attached));
    assert.equal(redacted.code, "E_IMPORT_RESULT");
    assert.equal(JSON.stringify(redacted).includes(secret), false);
    assert.match(String(redacted.details.warning), /\[REDACTED\]/);
    assert.match(String(redacted.details.privacyWarning), /\[REDACTED\]/);
    assert.match(String(redacted.details.diagnostic), /\[REDACTED\]/);
  }

  // Timeout throw path + unlink: primary E_TIMEOUT preserved with privacy evidence.
  {
    const primary = new CompanionError("E_TIMEOUT", "Grok transcript import timed out.");
    const attached = attachTransferCleanupEvidence(primary, ["injected unlink failure"], { privacy: true });
    assert.equal(attached.code, "E_TIMEOUT");
    assert.match(attached.message, /timed out/i);
    assert.equal(attached.details.warning, "injected unlink failure");
    assert.equal(attached.details.privacyWarning, "injected unlink failure");
  }

  // Existing details.warning / privacyWarning are appended, never replaced.
  {
    const primary = new CompanionError("E_IMPORT_RESULT", "import failed", {
      warning: "prior-close",
      privacyWarning: "prior-privacy"
    });
    const attached = attachTransferCleanupEvidence(primary, ["new-unlink"], { privacy: true });
    assert.equal(attached.details.warning, "prior-close; new-unlink");
    assert.equal(attached.details.privacyWarning, "prior-privacy; new-unlink");
  }
});

test("transfer primary model-selection error preserves code when injected close cleanup fails", () => {
  const { root, source, env } = transferFixture();
  const result = runCompanion(
    ["transfer", "--source", source, "--model", "not-a-real-model", "--json"],
    {
      cwd: root,
      env: {
        ...env,
        GROK_COMPANION_TEST_TRANSFER_CLEANUP_FAULTS: "close"
      }
    }
  );
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "E_CAPABILITY");
  assert.match(payload.error.message, /not-a-real-model|not advertised/i);
  assert.match(String(payload.error.details?.warning || ""), /injected close failure/);
  assert.equal(payload.error.details?.privacyWarning, undefined, "source fd close alone is not residual private alias/converted evidence");
});

test("transfer primary import error preserves code when alias cleanup fails", () => {
  const secret = "xai-abcdefghijklmnopqrstuvwxyz";
  const { root, source, env } = transferFixture({
    importExitCode: 19,
    importStderr: `provider failed with ${secret}\n`,
    importPoisonAlias: true
  });
  const result = runCompanion(["transfer", "--source", source, "--json"], { cwd: root, env });
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  if (payload.error.code === "E_PROCESS_IDENTITY") {
    // Probe/import process identity failed before the nonzero-import path; still fail closed.
    return;
  }
  const error = parseError(result, "E_IMPORT_RESULT");
  assert.match(error.message, /could not import/i);
  assert.ok(error.details?.privacyWarning, "alias may remain — privacyWarning required");
  assert.match(String(error.details.privacyWarning), /\S/);
  assert.equal(JSON.stringify(error).includes(secret), false);
  assert.equal(result.stdout.includes("xai-"), false);
});

test("transfer primary import timeout preserves code when injected unlink cleanup fails", () => {
  const { root, source, env } = transferFixture({ importHang: true });
  const result = runCompanion(["transfer", "--source", source, "--json"], {
    cwd: root,
    env: {
      ...env,
      GROK_COMPANION_TEST_IMPORT_TIMEOUT_MS: "200",
      GROK_COMPANION_TEST_TRANSFER_CLEANUP_FAULTS: "unlink"
    }
  });
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  if (payload.error.code === "E_PROCESS_IDENTITY") {
    // Probe/import process identity failed closed; privacy or unlink evidence may be present.
    if (payload.error.details?.warning || payload.error.details?.privacyWarning) {
      assert.match(
        String(payload.error.details?.warning || payload.error.details?.privacyWarning),
        /injected unlink failure|Isolated review home retained/
      );
    }
    return;
  }
  const error = parseError(result, "E_TIMEOUT");
  assert.match(error.message, /timed out/i);
  assert.match(String(error.details?.warning || ""), /injected unlink failure/);
  assert.match(String(error.details?.privacyWarning || ""), /injected unlink failure/, "alias residual evidence must stay explicit");
});

test("transfer import timeout normalizes owned-process signal failures and proves cleanup", {
  skip: process.platform === "win32"
}, async () => {
  for (const mode of ["EPERM", "ESRCH", "THENABLE", "ASYNC_REJECT"]) {
    const { root, source, env } = transferFixture({ importHang: true });
    const privatePath = path.join(
      tempDir(`grok-import-private-${mode.toLowerCase()}-`),
      "provider-auth.json"
    );
    const injected = injectedImportSignalEnv(env, mode, privatePath);
    const runEnv = {
      ...injected.env,
      GROK_COMPANION_TEST_IMPORT_TIMEOUT_MS: "200"
    };
    let processGroupId = null;
    try {
      const result = runCompanion(
        ["transfer", "--source", source, "--json"],
        { cwd: root, env: runEnv, timeout: 15_000 }
      );
      const events = readFakeLog(injected.logFile);
      const loaded = events.filter((event) => event.type === "loaded");
      const injectedSignal = events.find((event) => event.type === "signal");
      assert.equal(loaded.length, 1, `${mode}: NODE_OPTIONS preload escaped into a provider child`);
      assert.ok(
        Number.isSafeInteger(injectedSignal?.target) && injectedSignal.target < 0,
        `${mode}: owned process-group SIGTERM was not intercepted`
      );
      processGroupId = Math.abs(injectedSignal.target);

      assert.notEqual(result.status, 0, `${mode}: transfer unexpectedly succeeded`);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.ok, false);
      assert.equal(
        payload.error.code,
        mode === "ESRCH" ? "E_TIMEOUT" : "E_PROCESS_IDENTITY",
        `${mode}: wrong public terminal error`
      );

      const publicOutput = `${result.stdout}\n${result.stderr}`;
      for (const privateValue of [
        "EPERM",
        "E_ASYNC_SIGNAL",
        privatePath,
        path.basename(privatePath),
        injected.preload,
        path.basename(injected.preload),
        `providerPid=${processGroupId}`
      ]) {
        assert.equal(
          publicOutput.includes(privateValue),
          false,
          `${mode}: public output leaked ${privateValue}`
        );
      }
      assert.equal(
        publicOutput.includes(String(processGroupId)),
        false,
        `${mode}: public output leaked the provider process group`
      );
      assert.doesNotMatch(
        result.stderr,
        /uncaught|unhandled|signal denied|signal-injection\.cjs/i,
        `${mode}: callback failure escaped the shared boundary`
      );

      await waitFor(() => !processGroupAlive(processGroupId), {
        timeoutMs: 5_000
      });
      assertTransferRuntimeArtifactsGone(root, runEnv);
    } finally {
      if (processGroupId && processGroupAlive(processGroupId)) {
        try { process.kill(-processGroupId, "SIGKILL"); } catch {}
        try {
          await waitFor(() => !processGroupAlive(processGroupId), {
            timeoutMs: 5_000
          });
        } catch {}
      }
    }
  }
});

test("transfer attaches cleanup evidence when importedSessionId throws after unlink fault", () => {
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const { root, source, env } = transferFixture({
    importRecords: [
      { event: "started", sessionId: first },
      { event: "completed", grok_session_id: second }
    ]
  });
  const result = runCompanion(["transfer", "--source", source, "--json"], {
    cwd: root,
    env: {
      ...env,
      GROK_COMPANION_TEST_TRANSFER_CLEANUP_FAULTS: "unlink"
    }
  });
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  if (payload.error.code === "E_PROCESS_IDENTITY") {
    return;
  }
  const error = parseError(result, "E_IMPORT_RESULT");
  assert.match(error.message, /multiple different session IDs/i);
  assert.match(String(error.details?.warning || ""), /injected unlink failure/);
  assert.match(String(error.details?.privacyWarning || ""), /injected unlink failure/, "alias residual requires privacyWarning");
  assert.ok(error.details?.sessionIds?.includes(first));
  assert.ok(error.details?.sessionIds?.includes(second));
});

test("transfer malformed NDJSON after cleanup attaches close/unlink evidence consistently", () => {
  const { root, source, env } = transferFixture({ importOutput: '{"sessionId":' });
  const result = runCompanion(["transfer", "--source", source, "--json"], {
    cwd: root,
    env: {
      ...env,
      GROK_COMPANION_TEST_TRANSFER_CLEANUP_FAULTS: "close,unlink"
    }
  });
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  if (payload.error.code === "E_PROCESS_IDENTITY") {
    return;
  }
  const error = parseError(result, "E_IMPORT_RESULT");
  assert.match(error.message, /malformed NDJSON/i);
  assert.match(String(error.details?.warning || ""), /injected close failure/);
  assert.match(String(error.details?.warning || ""), /injected unlink failure/);
  // Unlink is a private residual; privacyWarning is set. Close is included in warning text.
  assert.match(String(error.details?.privacyWarning || ""), /injected unlink failure/);
  assert.match(String(error.details?.privacyWarning || ""), /injected close failure/);
});

test("transfer success path with close-only fault is fail-closed E_STATE without privacyWarning", () => {
  const sessionId = "12345678-1234-4234-8234-123456789abc";
  const { root, source, env } = transferFixture({ importSessionId: sessionId });
  const result = runCompanion(["transfer", "--source", source, "--json"], {
    cwd: root,
    env: {
      ...env,
      GROK_COMPANION_TEST_TRANSFER_CLEANUP_FAULTS: "close"
    }
  });
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  if (payload.error.code === "E_PROCESS_IDENTITY") {
    return;
  }
  const error = parseError(result, "E_STATE");
  assert.match(error.message, /cleanup failed/i);
  assert.equal(error.details?.sessionId, sessionId);
  assert.match(String(error.details?.warning || ""), /injected close failure/);
  assert.equal(error.details?.privacyWarning, undefined, "source-FD close-only must not claim residual private alias/converted artifacts");
  assert.equal(error.details?.resume, `grok --model grok-test --resume ${sessionId}`);
  assert.equal(error.details?.delete, `grok sessions delete ${sessionId}`);
});

test("transfer codex dispose fault sets privacyWarning on success-path fail-closed E_STATE", () => {
  const sessionId = "12345678-1234-4234-8234-123456789abc";
  const root = initRepo();
  const { fake, env } = fixture({ importSessionId: sessionId });
  const home = tempDir("grok-transfer-dispose-home-");
  const codexHome = path.join(home, ".codex");
  const sessions = path.join(codexHome, "sessions", "2026", "07", "13");
  const pluginData = path.join(codexHome, "plugins", "data", "grok-grok-companion");
  const threadId = crypto.randomUUID();
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const source = path.join(sessions, `rollout-${threadId}.jsonl`);
  const records = [
    { timestamp: "2026-07-13T10:00:00.000Z", type: "session_meta", payload: { id: threadId, cwd: root, cli_version: "0.143.0" } },
    { timestamp: "2026-07-13T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "transfer dispose fixture" } },
    { timestamp: "2026-07-13T10:00:02.000Z", type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "ok" } }
  ];
  fs.writeFileSync(source, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  writeCodexSessionMetadata(pluginData, { sessionId: threadId, transcriptPath: source, cwd: root });
  const transferEnv = {
    ...env,
    HOME: home,
    CODEX_HOME: codexHome,
    CODEX_THREAD_ID: threadId,
    GROK_COMPANION_TEST_TRANSFER_CLEANUP_FAULTS: "dispose"
  };
  delete transferEnv.CLAUDE_PLUGIN_DATA;
  delete transferEnv.GROK_COMPANION_CLAUDE_SESSION_ID;
  delete transferEnv.GROK_COMPANION_HOST;
  delete transferEnv.GROK_COMPANION_HOST_SESSION_ID;
  delete transferEnv.GROK_COMPANION_PLUGIN_DATA;

  const result = runCodexCompanion(["transfer", "--source", source, "--json"], { cwd: root, env: transferEnv });
  assert.notEqual(result.status, 0, result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  if (payload.error.code === "E_PROCESS_IDENTITY") {
    return;
  }
  assert.equal(payload.error.code, "E_STATE");
  assert.match(payload.error.message, /cleanup failed/i);
  assert.equal(payload.error.details?.sessionId, sessionId);
  assert.match(String(payload.error.details?.warning || ""), /injected dispose failure/);
  assert.match(String(payload.error.details?.privacyWarning || ""), /injected dispose failure/, "converted dispose residual requires privacyWarning");
  assert.ok(fake);
});
