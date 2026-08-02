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

test("runtime evidence distinguishes tolerated linked-worktree ref churn from metadata drift (issue #34)", () => {
  const root = initRepo();
  const head = git(root, "rev-parse", "HEAD");
  const linkedParent = tempDir("grok-runtime-linked-ref-");
  const linkedRoot = path.join(linkedParent, "checkout");
  git(root, "worktree", "add", "-b", "runtime-task", linkedRoot);

  const pre = captureContextManifest(linkedRoot);
  git(root, "branch", "unrelated-runtime", head);
  git(root, "update-ref", "refs/codex/turn-diffs/runtime-1", head);
  const postUnrelated = captureContextManifest(linkedRoot);
  const unrelatedPaths = observeChangedPaths(pre, postUnrelated);
  assert.equal(unrelatedPaths.includes("[GIT_METADATA]"), false);
  assert.deepEqual(evaluateScope(unrelatedPaths, { include: ["tracked.txt"] }), []);
  assert.doesNotThrow(() => assertContextCompatible(linkedRoot, pre, { mode: "execute" }));
  const unrelatedEvidence = buildRuntimeEvidence({
    preContext: pre,
    postContext: postUnrelated,
    changedPaths: unrelatedPaths
  });
  assert.equal(unrelatedEvidence.sharedRefObservation.toleratedUnrelatedSharedRefChurn, true);
  assert.equal(unrelatedEvidence.sharedRefObservation.taskRelevantMetadataDrift, false);
  assert.equal(unrelatedEvidence.sharedRefObservation.classification, "tolerated_unrelated_shared_refs");

  const preHook = captureContextManifest(linkedRoot);
  const hooksDir = path.join(root, ".git", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 0\n");
  const postHook = captureContextManifest(linkedRoot);
  const hookPaths = observeChangedPaths(preHook, postHook);
  assert.ok(hookPaths.includes("[GIT_METADATA]"));
  const hookEvidence = buildRuntimeEvidence({
    preContext: preHook,
    postContext: postHook,
    changedPaths: hookPaths
  });
  assert.equal(hookEvidence.sharedRefObservation.toleratedUnrelatedSharedRefChurn, false);
  assert.equal(hookEvidence.sharedRefObservation.taskRelevantMetadataDrift, true);
  assert.equal(hookEvidence.sharedRefObservation.classification, "task_relevant_metadata_drift");
  const serialized = JSON.stringify({ unrelatedEvidence, hookEvidence });
  assert.equal(serialized.includes(linkedRoot), false);
  assert.equal(serialized.includes(root), false);
});

test("setup validates headless isolation before enabling the stop gate", (t) => {
  const root = initRepo();
  const readyFixture = fixture();
  const readyPinned = installPinnedFakeCompanion(
    readyFixture.fake,
    readyFixture.env
  );
  t.after(readyPinned.cleanup);
  const ready = parseJson(runCompanion(
    ["setup", "--enable-review-gate", "--json"],
    {
      cwd: root,
      env: readyPinned.env,
      companionScript: readyPinned.companionScript
    }
  ));
  assert.equal(ready.ready, true);
  assert.equal(ready.grok.headlessReview.isolated, true);
  assert.equal(ready.config.stopReviewGate, true);

  const failedRoot = initRepo();
  const failedFixture = fixture({ helpText: "Usage: grok --sandbox PROFILE\n" });
  const failedPinned = installPinnedFakeCompanion(
    failedFixture.fake,
    failedFixture.env
  );
  t.after(failedPinned.cleanup);
  const failed = parseJson(runCompanion(
    ["setup", "--enable-review-gate", "--json"],
    {
      cwd: failedRoot,
      env: failedPinned.env,
      companionScript: failedPinned.companionScript
    }
  ));
  assert.equal(failed.ready, false);
  assert.equal(failed.grok.error.code, "E_CAPABILITY");
  assert.equal(failed.config.stopReviewGate, false);
});

test("a failed setup attempt revokes the previously published provider capability", (t) => {
  const root = initRepo();
  const readyFixture = fixture();
  const readyPinned = installPinnedFakeCompanion(
    readyFixture.fake,
    readyFixture.env
  );
  t.after(readyPinned.cleanup);
  const ready = parseJson(runCompanion(
    ["setup", "--json"],
    {
      cwd: root,
      env: readyPinned.env,
      companionScript: readyPinned.companionScript
    }
  ));
  assert.equal(ready.ready, true);
  const receipt = path.join(
    pluginDataRoot(readyPinned.env),
    "capabilities",
    "provider-capability-v2.json"
  );
  assert.equal(fs.existsSync(receipt), true);

  const failedFake = installFakeGrok(tempDir("fake-grok-setup-revocation-"), {
    helpText: "Usage: grok --sandbox PROFILE\n"
  });
  const failedPinned = installPinnedFakeCompanion(
    failedFake,
    readyPinned.env
  );
  t.after(failedPinned.cleanup);
  const failed = parseJson(runCompanion(
    ["setup", "--json"],
    {
      cwd: root,
      env: failedPinned.env,
      companionScript: failedPinned.companionScript
    }
  ));
  assert.equal(failed.ready, false);
  assert.equal(failed.grok.error.code, "E_CAPABILITY");
  assert.equal(fs.existsSync(receipt), false);
});

test("missingInvalidProviderCapabilityReceiptMessage is hostCommand-parameterized only", () => {
  assert.equal(
    missingInvalidProviderCapabilityReceiptMessage({ CODEX_THREAD_ID: "codex-thread" }),
    "Valid provider capability receipt is missing or invalid; run $grok:setup before admitting a Codex task."
  );
  assert.equal(
    missingInvalidProviderCapabilityReceiptMessage({
      GROK_COMPANION_CLAUDE_SESSION_ID: "claude-session"
    }),
    "Valid provider capability receipt is missing or invalid; run /grok:setup before admitting a Codex task."
  );
  assert.equal(
    missingInvalidProviderCapabilityReceiptMessage({ GROK_COMPANION_HOST: "cli" }),
    "Valid provider capability receipt is missing or invalid; run /grok:setup before admitting a Codex task."
  );
});

test("Codex task admission emits the canonical receipt E_CAPABILITY before durable job or task provider launch", {
  skip: process.platform === "win32" && "pinned fake-provider setup fixtures require /bin/bash"
}, (t) => {
  const canonical = canonicalReceiptAdmissionMessage();
  const companionSource = fs.readFileSync(
    path.join(ROOT, "plugins/grok/scripts/lib/companion-provider-admission.mjs"),
    "utf8"
  );
  // Every gate emitter must use one local error factory and the single exported
  // message helper (no inline duplicates).
  assert.equal(
    companionSource.split("missingInvalidProviderCapabilityReceiptMessage(").length - 1,
    1
  );
  assert.equal(
    companionSource.includes("Valid provider capability receipt is missing or invalid; run"),
    false
  );

  // Missing receipt: fail closed before admitJob and before any task provider launch.
  const missingRoot = initRepo();
  const missingFixture = fixture({ taskText: taskReport("should not launch") });
  const missingEnv = codexTaskEnv(
    missingFixture.env,
    missingFixture.pluginData,
    "codex-receipt-missing"
  );
  const missingAttempt = runCompanion(
    ["task", "--wait", "missing receipt gate fixture", "--json"],
    { cwd: missingRoot, env: missingEnv }
  );
  assert.notEqual(missingAttempt.status, 0, missingAttempt.stdout);
  const missingError = JSON.parse(missingAttempt.stdout).error;
  assert.equal(missingError.code, "E_CAPABILITY");
  assert.equal(missingError.message, canonical);
  assert.deepEqual(persistedJobs(pluginDataForJobs(missingEnv)), []);
  assert.equal(agentStdioCount(missingFixture.fake.logFile), 0);

  // Tampered receipt after one successful setup: same canonical gate, still no admission/launch.
  const tamperedRoot = initRepo();
  const tamperedFixture = fixture({ taskText: taskReport("tampered should not launch") });
  const tamperedBase = codexTaskEnv(
    tamperedFixture.env,
    tamperedFixture.pluginData,
    "codex-receipt-tampered"
  );
  const pinned = installPinnedFakeCompanion(tamperedFixture.fake, tamperedBase);
  t.after(pinned.cleanup);
  const setup = parseJson(runCompanion(["setup", "--json"], {
    cwd: tamperedRoot,
    env: pinned.env,
    companionScript: pinned.codexCompanionScript
  }));
  assert.equal(setup.ready, true);
  const setupProviderStarts = agentStdioCount(tamperedFixture.fake.logFile);
  assert.equal(setupProviderStarts, 1);
  const receiptFile = receiptPathFor(pinned.env);
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  fs.writeFileSync(
    receiptFile,
    `${JSON.stringify({ ...receipt, capabilityDigest: "0".repeat(64) }, null, 2)}\n`,
    { mode: 0o600 }
  );
  const tamperedAttempt = runCompanion(
    ["task", "--wait", "tampered receipt gate fixture", "--json"],
    {
      cwd: tamperedRoot,
      env: pinned.env,
      companionScript: pinned.codexCompanionScript
    }
  );
  assert.notEqual(tamperedAttempt.status, 0, tamperedAttempt.stdout);
  const tamperedError = JSON.parse(tamperedAttempt.stdout).error;
  assert.equal(tamperedError.code, "E_CAPABILITY");
  assert.equal(tamperedError.message, canonical);
  assert.deepEqual(persistedJobs(pluginDataForJobs(pinned.env)), []);
  assert.equal(agentStdioCount(tamperedFixture.fake.logFile), setupProviderStarts);
});

test("Codex receipt recovery: one setup then identical task retry admits without duplicate launch", {
  skip: process.platform === "win32" && "pinned fake-provider setup fixtures require /bin/bash"
}, (t) => {
  const root = initRepo();
  const runtime = fixture({ taskText: taskReport("receipt recovery completed") });
  const baseEnv = codexTaskEnv(runtime.env, runtime.pluginData, "codex-receipt-recovery");
  const pinned = installPinnedFakeCompanion(runtime.fake, baseEnv);
  t.after(pinned.cleanup);
  const canonical = missingInvalidProviderCapabilityReceiptMessage(pinned.env);
  const taskArgs = ["task", "--wait", "identical receipt recovery fixture", "--json"];

  // First admission fails closed on the exact missing-receipt message.
  const first = runCompanion(taskArgs, {
    cwd: root,
    env: pinned.env,
    companionScript: pinned.codexCompanionScript
  });
  assert.notEqual(first.status, 0, first.stdout);
  const firstError = JSON.parse(first.stdout).error;
  assert.equal(firstError.code, "E_CAPABILITY");
  assert.equal(firstError.message, canonical);
  assert.deepEqual(persistedJobs(pluginDataForJobs(pinned.env)), []);
  assert.equal(agentStdioCount(runtime.fake.logFile), 0);

  // Host rescue workflow: exactly one authoritative setup.
  const setup = parseJson(runCompanion(["setup", "--json"], {
    cwd: root,
    env: pinned.env,
    companionScript: pinned.codexCompanionScript
  }));
  assert.equal(setup.ready, true);
  assert.equal(agentStdioCount(runtime.fake.logFile), 1);
  assert.equal(fs.existsSync(receiptPathFor(pinned.env)), true);

  // Identical task argv/input retry is admitted once; no duplicate job or task provider launch.
  const retry = parseJson(runCompanion(taskArgs, {
    cwd: root,
    env: pinned.env,
    companionScript: pinned.codexCompanionScript
  }));
  assert.equal(retry.status, "completed");
  const jobs = persistedJobs(pluginDataForJobs(pinned.env));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, retry.id);
  assert.equal(agentStdioCount(runtime.fake.logFile), 2);
});

test("Codex receipt recovery stops on setup failure and keeps non-receipt E_CAPABILITY terminal", {
  skip: process.platform === "win32" && "pinned fake-provider setup fixtures require /bin/bash"
}, (t) => {
  const canonical = canonicalReceiptAdmissionMessage();

  // Setup failure: surface setup error and stop without task retry.
  const stopRoot = initRepo();
  const stopFixture = fixture({ taskText: taskReport("must not retry after setup failure") });
  const stopEnv = codexTaskEnv(stopFixture.env, stopFixture.pluginData, "codex-receipt-setup-fail");
  const stopPinned = installPinnedFakeCompanion(stopFixture.fake, stopEnv);
  t.after(stopPinned.cleanup);
  const blocked = runCompanion(
    ["task", "--wait", "setup failure stop fixture", "--json"],
    {
      cwd: stopRoot,
      env: stopPinned.env,
      companionScript: stopPinned.codexCompanionScript
    }
  );
  assert.notEqual(blocked.status, 0);
  assert.equal(JSON.parse(blocked.stdout).error.message, canonical);
  assert.deepEqual(persistedJobs(pluginDataForJobs(stopPinned.env)), []);

  const brokenFake = installFakeGrok(tempDir("fake-grok-receipt-setup-fail-"), {
    helpText: "Usage: grok --sandbox PROFILE\n"
  });
  const brokenPinned = installPinnedFakeCompanion(brokenFake, stopPinned.env);
  t.after(brokenPinned.cleanup);
  const failedSetup = parseJson(runCompanion(["setup", "--json"], {
    cwd: stopRoot,
    env: brokenPinned.env,
    companionScript: brokenPinned.codexCompanionScript
  }));
  assert.equal(failedSetup.ready, false);
  assert.equal(failedSetup.grok.error.code, "E_CAPABILITY");
  // Non-receipt capability failure from setup is not the exact receipt prerequisite message.
  assert.notEqual(failedSetup.grok.error.message, canonical);
  // Host workflow surfaces setup failure unchanged and stops: no task retry after failed setup.
  assert.deepEqual(persistedJobs(pluginDataForJobs(brokenPinned.env)), []);
  assert.equal(fs.existsSync(receiptPathFor(brokenPinned.env)), false);

  // Persistent invalid receipt after one setup + one retry remains terminal (no second setup).
  const persistentRoot = initRepo();
  const persistentFixture = fixture({ taskText: taskReport("persistent invalid receipt") });
  const persistentEnv = codexTaskEnv(
    persistentFixture.env,
    persistentFixture.pluginData,
    "codex-receipt-persistent"
  );
  const persistentPinned = installPinnedFakeCompanion(persistentFixture.fake, persistentEnv);
  t.after(persistentPinned.cleanup);
  const firstMissing = runCompanion(
    ["task", "--wait", "persistent receipt fixture", "--json"],
    {
      cwd: persistentRoot,
      env: persistentPinned.env,
      companionScript: persistentPinned.codexCompanionScript
    }
  );
  assert.equal(JSON.parse(firstMissing.stdout).error.message, canonical);
  const setupOnce = parseJson(runCompanion(["setup", "--json"], {
    cwd: persistentRoot,
    env: persistentPinned.env,
    companionScript: persistentPinned.codexCompanionScript
  }));
  assert.equal(setupOnce.ready, true);
  const setupStarts = agentStdioCount(persistentFixture.fake.logFile);
  assert.equal(setupStarts, 1);
  // Simulate a still-invalid receipt on the single allowed retry.
  const receiptFile = receiptPathFor(persistentPinned.env);
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  fs.writeFileSync(
    receiptFile,
    `${JSON.stringify({ ...receipt, capabilityDigest: "a".repeat(64) }, null, 2)}\n`,
    { mode: 0o600 }
  );
  const retry = runCompanion(
    ["task", "--wait", "persistent receipt fixture", "--json"],
    {
      cwd: persistentRoot,
      env: persistentPinned.env,
      companionScript: persistentPinned.codexCompanionScript
    }
  );
  assert.notEqual(retry.status, 0);
  assert.equal(JSON.parse(retry.stdout).error.code, "E_CAPABILITY");
  assert.equal(JSON.parse(retry.stdout).error.message, canonical);
  assert.deepEqual(persistedJobs(pluginDataForJobs(persistentPinned.env)), []);
  // No second setup and no task provider launch after the terminal receipt error.
  assert.equal(agentStdioCount(persistentFixture.fake.logFile), setupStarts);
});
