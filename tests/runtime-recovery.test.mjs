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

test("cleanup-blocked legacy SessionEnd recovery preserves its completed outcome and evidence status", { skip: process.platform === "win32" }, () => {
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const preContext = captureContextManifest(root);
  const id = generateId("task");
  const taskHome = path.join(stateRoot, "task-homes", id, ".grok");
  fs.mkdirSync(path.join(taskHome, "agent-profiles"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(taskHome, "auth.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(taskHome, "agent-profiles", "staged.md"), "profile\n", { mode: 0o600 });
  const stamped = new Date(Date.now() - 60_000).toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 3,
    id,
    kind: "task",
    jobClass: "task",
    title: "task: completed cleanup retry",
    summary: "Worker completed",
    write: false,
    status: "running",
    phase: "cleanup-blocked",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: "fake-session-00000001",
    createdAt: stamped,
    startedAt: stamped,
    updatedAt: stamped,
    completedAt: null,
    heartbeatAt: stamped,
    controllerProcess: null,
    workerProcess: { pid: 999999997, startToken: "dead-worker", nonce: "n", processGroupId: 999999997, commandMarker: id },
    providerProcess: { pid: 999999996, startToken: "dead-provider", processGroupId: 999999996 },
    profile: profileFor("task", false),
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: "Task finished; runtime cleanup is still pending",
    request: {
      prompt: null,
      providerHomeId: id,
      contextManifest: preContext,
      envelope: null
    },
    result: { hostVerification: "not_run", taskRuntimeCleaned: false, privacyWarning: "cleanup pending" },
    error: {
      code: "E_PROCESS_IDENTITY",
      message: "SessionEnd could not verify complete process-group shutdown."
    },
    pendingTerminal: { status: "completed", phase: "done", completedAt: stamped, error: null, summary: "Worker completed" }
  });

  const recovered = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
  assert.equal(recovered.status, "completed", JSON.stringify(recovered));
  assert.equal(recovered.phase, "done");
  assert.equal(recovered.error, null);
  assert.equal(recovered.summary, "Worker completed");
  assert.equal(recovered.result.taskRuntimeCleaned, true);
  assert.equal(recovered.result.runtimeEvidence.executionStatus, "completed");
  assert.equal(fs.existsSync(path.join(taskHome, "auth.json")), false);
  assert.equal(fs.existsSync(path.join(taskHome, "agent-profiles")), false);
});

test("final task evidence fails closed when post-cleanup context is unavailable", () => {
  const root = fs.realpathSync(initRepo());
  const preContext = captureContextManifest(root);
  const evidence = captureTerminalEvidence(
    root,
    {
      request: {
        contextManifest: preContext,
        envelope: {
          scope: { include: ["tracked.txt"], exclude: [] }
        }
      },
      commandOutcomes: []
    },
    "completed",
    {
      captureContext() {
        throw new Error("private capture failure");
      }
    }
  );
  const selected = selectTaskTerminalError(
    evidence,
    null,
    {
      code: "E_PROCESS_IDENTITY",
      message: "Verified owned process signalling could not be completed.",
      details: {
        secondaryDiagnostic: {
          code: "EPERM",
          message: "kill EPERM"
        }
      }
    }
  );

  assert.equal(evidence.finalObservationUnavailable, true);
  assert.equal(evidence.postContext, null);
  assert.deepEqual(evidence.changedPaths, []);
  assert.deepEqual(evidence.scopeViolations, []);
  assert.equal(evidence.runtimeEvidence.postContext, null);
  assert.equal(selected.code, "E_CONTEXT_DRIFT");
  assert.deepEqual(selected.details.reasons, [
    "[final-context-unavailable]"
  ]);
  assert.equal(selected.details.secondaryDiagnostic.code, "EPERM");
  assert.equal(
    JSON.stringify(evidence).includes("private capture failure"),
    false
  );

  const malformedPreContext = {
    ...preContext,
    digest: "0".repeat(64)
  };
  const malformedEvidence = captureTerminalEvidence(
    root,
    {
      request: {
        contextManifest: malformedPreContext,
        envelope: {
          scope: { include: ["tracked.txt"], exclude: [] }
        }
      },
      commandOutcomes: []
    },
    "completed"
  );
  const malformedSelected = selectTaskTerminalError(
    malformedEvidence,
    { code: "E_CANCELLED", message: "Cancellation completed." }
  );
  assert.equal(malformedEvidence.finalObservationUnavailable, true);
  assert.equal(malformedEvidence.postContext, null);
  assert.equal(malformedEvidence.runtimeEvidence.preContext, null);
  assert.equal(malformedEvidence.runtimeEvidence.postContext, null);
  assert.equal(malformedEvidence.runtimeEvidence.executionStatus, "failed");
  assert.deepEqual(malformedEvidence.changedPaths, []);
  assert.deepEqual(malformedEvidence.scopeViolations, []);
  assert.equal(malformedSelected.code, "E_CONTEXT_DRIFT");
  assert.deepEqual(
    malformedSelected.details.reasons,
    ["[final-context-unavailable]"]
  );

  const stableEvidence = {
    finalObservationUnavailable: false,
    changedPaths: [],
    scopeViolations: [],
    runtimeEvidence: {
      observedChangedPaths: [],
      scopeViolations: []
    }
  };
  const genericOwnershipBlocker = selectTaskTerminalError(
    stableEvidence,
    { code: "E_CANCELLED", message: "Cancellation completed." },
    {
      code: "E_PROCESS_IDENTITY",
      message: "SessionEnd could not verify complete process-group shutdown."
    }
  );
  assert.equal(genericOwnershipBlocker.code, "E_CANCELLED");

  const legacySignalFailure = selectTaskTerminalError(
    stableEvidence,
    null,
    {
      code: "E_PROCESS_IDENTITY",
      message: "Provider kill failed with EPERM."
    }
  );
  assert.equal(legacySignalFailure.code, "E_PROCESS_IDENTITY");
  assert.equal(
    legacySignalFailure.details.secondaryDiagnostic.code,
    "EPERM"
  );

  const benignMissingProcess = selectTaskTerminalError(
    stableEvidence,
    { code: "E_CANCELLED", message: "Cancellation completed." },
    {
      code: "E_PROCESS_IDENTITY",
      message: "Provider kill observed ESRCH.",
      details: {
        secondaryDiagnostic: {
          code: "ESRCH",
          message: "kill ESRCH"
        }
      }
    }
  );
  assert.equal(benignMissingProcess.code, "E_CANCELLED");
});

function recoverDriftedCleanupFixture() {
const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("task");
  const taskHome = path.join(stateRoot, "task-homes", id, ".grok");
  fs.mkdirSync(path.join(taskHome, "agent-profiles"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(taskHome, "auth.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(taskHome, "agent-profiles", "staged.md"), "profile\n", { mode: 0o600 });
  const preContext = captureContextManifest(root);
  const envelope = buildTaskEnvelope({
    userRequest: "recover cleanup with final context drift",
    objective: "recover cleanup with final context drift",
    mode: "write",
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
    acceptanceCriteria: [{ id: "AC-01", text: "Recover safely" }]
  });
  const stamped = new Date(Date.now() - 60_000).toISOString();
  const processError = {
    code: "EPERM",
    message: "kill EPERM"
  };
  writeSeededJob(stateRoot, {
    schemaVersion: 3,
    id,
    kind: "task",
    jobClass: "task",
    title: "task: cleanup signal precedence",
    summary: processError.message,
    write: true,
    status: "running",
    phase: "cleanup-blocked",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: "fake-session-cleanup-signal",
    createdAt: stamped,
    startedAt: stamped,
    updatedAt: stamped,
    completedAt: null,
    heartbeatAt: stamped,
    controllerProcess: null,
    workerProcess: {
      pid: 999999995,
      startToken: "dead-worker",
      nonce: "n",
      processGroupId: 999999995,
      commandMarker: id
    },
    providerProcess: {
      pid: 999999994,
      startToken: "dead-provider",
      processGroupId: 999999994
    },
    profile: profileFor("task", true),
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: "Task finished; runtime cleanup is still pending",
    request: {
      prompt: null,
      providerHomeId: id,
      contextManifest: preContext,
      envelope
    },
    result: {
      hostVerification: "not_run",
      taskRuntimeCleaned: false,
      privacyWarning: "cleanup pending",
      stopReason: "cancelled"
    },
    error: processError,
    pendingTerminal: {
      status: "failed",
      phase: "failed",
      completedAt: stamped,
      error: processError,
      summary: processError.message
    }
  });
  git(root, "config", "--local", "--add", "grok.issue49RecoveryDrift", "true");

  const recovered = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.phase, "context-rejected");
  assert.equal(recovered.error.code, "E_CONTEXT_DRIFT");
  assert.match(recovered.error.message, /workspace execution context changed/i);
  assert.equal(recovered.result.taskRuntimeCleaned, true);
  assert.equal(recovered.result.stopReason, undefined);
  assert.equal(recovered.result.runtimeEvidence.executionStatus, "failed");
  assert.ok(recovered.result.runtimeEvidence.observedChangedPaths.includes("[GIT_METADATA]"));
  assert.equal(recovered.progress, "Task runtime cleanup completed; workspace safety review is required");
  assert.equal(JSON.stringify(recovered).includes("secondaryDiagnostic"), false);
  const stored = readJob(root, id, env);
  assert.equal(stored.error.details.secondaryDiagnostic.code, "EPERM");
  assert.equal(stored.result.stopReason, undefined);
  assert.equal(fs.existsSync(path.join(taskHome, "auth.json")), false);
  assert.equal(fs.existsSync(path.join(taskHome, "agent-profiles")), false);
  return { root, env, stateRoot, stored, stamped };
}

function assertStableCleanupSignal(context) {
  const { root, env, stateRoot, stored, stamped } = context;
const stableId = generateId("task");
  const stableContext = captureContextManifest(root);
  const stableEnvelope = buildTaskEnvelope({
    userRequest: "recover cleanup without workspace drift",
    objective: "recover cleanup without workspace drift",
    mode: "write",
    scope: { include: ["tracked.txt"], exclude: [] },
    contextManifestId: stableContext.manifestId,
    context: {
      facts: [],
      constraints: [],
      expectedProjectMarkers: [],
      requiredPaths: ["tracked.txt"],
      workspaceState: "task_scoped",
      upstreamFreshness: "not_checked"
    },
    acceptanceCriteria: [{ id: "AC-01", text: "Recover safely" }]
  });
  writeSeededJob(stateRoot, {
    ...stored,
    id: stableId,
    title: "task: cleanup signal without drift",
    summary: "signal failed: EIO",
    status: "running",
    phase: "cleanup-blocked",
    createdAt: stamped,
    startedAt: stamped,
    updatedAt: stamped,
    completedAt: null,
    heartbeatAt: stamped,
    grokSessionId: "fake-session-cleanup-signal-stable",
    workerProcess: {
      ...stored.workerProcess,
      commandMarker: stableId
    },
    completionContextManifest: null,
    logFile: path.join(stateRoot, "jobs", `${stableId}.log`),
    progress: "Task finished; runtime cleanup is still pending",
    request: {
      ...stored.request,
      providerHomeId: stableId,
      contextManifest: stableContext,
      envelope: stableEnvelope
    },
    result: {
      hostVerification: "not_run",
      taskRuntimeCleaned: false,
      privacyWarning: "cleanup pending",
      stopReason: "cancelled"
    },
    error: {
      code: "E_PROCESS_IDENTITY",
      message: "Verified owned process signalling could not be completed.",
      details: {
        secondaryDiagnostic: {
          code: "EIO",
          message: "signal failed: EIO"
        }
      }
    },
    pendingTerminal: {
      status: "completed",
      phase: "done",
      completedAt: stamped,
      error: {
        code: "E_PROCESS_IDENTITY",
        message: "Process ownership verification failed."
      },
      summary: "Worker completed"
    },
    lifecycleEvents: []
  });

  const stable = parseJson(runCompanion(["status", stableId, "--json"], { cwd: root, env }));
  assert.equal(stable.status, "failed");
  assert.equal(stable.phase, "failed");
  assert.equal(stable.error.code, "E_PROCESS_IDENTITY");
  assert.equal(stable.error.message, "Process ownership verification failed.");
  assert.equal(stable.result.taskRuntimeCleaned, true);
  assert.deepEqual(stable.result.runtimeEvidence.observedChangedPaths, []);
  assert.equal(stable.progress, "Worker finalization completed");
  assert.equal(JSON.stringify(stable).includes("EIO"), false);
  assert.equal(readJob(root, stableId, env).error.details.secondaryDiagnostic.code, "EIO");
  return { ...context, stableId, stableContext, stableEnvelope };
}

function assertPriorCleanupError(context) {
  const {
    root, env, stateRoot, stored, stamped, stableId, stableContext, stableEnvelope
  } = context;
const priorErrorId = generateId("task");
  writeSeededJob(stateRoot, {
    ...readJob(root, stableId, env),
    id: priorErrorId,
    title: "task: cleanup signal outranks prior outcome",
    summary: "invalid worker report",
    status: "running",
    phase: "cleanup-blocked",
    createdAt: stamped,
    startedAt: stamped,
    updatedAt: stamped,
    completedAt: null,
    heartbeatAt: stamped,
    grokSessionId: "fake-session-cleanup-signal-prior-error",
    workerProcess: {
      ...stored.workerProcess,
      commandMarker: priorErrorId
    },
    completionContextManifest: null,
    logFile: path.join(stateRoot, "jobs", `${priorErrorId}.log`),
    progress: "Task finished; runtime cleanup is still pending",
    request: {
      ...stored.request,
      providerHomeId: priorErrorId,
      contextManifest: stableContext,
      envelope: stableEnvelope
    },
    result: {
      hostVerification: "not_run",
      taskRuntimeCleaned: false,
      privacyWarning: "cleanup pending"
    },
    error: { code: "EPERM", message: "kill EPERM" },
    pendingTerminal: {
      status: "failed",
      phase: "failed",
      completedAt: stamped,
      error: { code: "E_SCHEMA", message: "Invalid worker report." },
      summary: "Invalid worker report."
    },
    lifecycleEvents: []
  });

  const priorError = parseJson(
    runCompanion(["status", priorErrorId, "--json"], { cwd: root, env })
  );
  assert.equal(priorError.status, "failed");
  assert.equal(priorError.phase, "failed");
  assert.equal(priorError.error.code, "E_PROCESS_IDENTITY");
  assert.equal(JSON.stringify(priorError).includes("EPERM"), false);
  return { ...context, priorErrorId };
}

function assertRepeatedCleanupSignal(context) {
  const {
    root, env, stateRoot, stored, stamped, priorErrorId, stableContext, stableEnvelope
  } = context;
const repeatedCleanupId = generateId("task");
  const repeatedCleanupHome = path.join(
    stateRoot,
    "task-homes",
    repeatedCleanupId,
    ".grok"
  );
  fs.mkdirSync(
    path.join(repeatedCleanupHome, "agent-profiles"),
    { recursive: true, mode: 0o700 }
  );
  fs.writeFileSync(
    path.join(repeatedCleanupHome, "auth.json"),
    "{}\n",
    { mode: 0o600 }
  );
  fs.writeFileSync(
    path.join(repeatedCleanupHome, "agent-profiles", "staged.md"),
    "profile\n",
    { mode: 0o600 }
  );
  writeSeededJob(stateRoot, {
    ...readJob(root, priorErrorId, env),
    id: repeatedCleanupId,
    title: "task: cleanup signal survives generic blocker",
    summary: "Verified owned process signalling could not be completed.",
    status: "running",
    phase: "cleanup-blocked",
    createdAt: stamped,
    startedAt: stamped,
    updatedAt: stamped,
    completedAt: null,
    heartbeatAt: stamped,
    grokSessionId: "fake-session-cleanup-signal-retry",
    workerProcess: {
      ...stored.workerProcess,
      commandMarker: repeatedCleanupId
    },
    completionContextManifest: null,
    logFile: path.join(
      stateRoot,
      "jobs",
      `${repeatedCleanupId}.log`
    ),
    progress: "Worker lost; provider cleanup could not be verified",
    request: {
      ...stored.request,
      providerHomeId: repeatedCleanupId,
      contextManifest: stableContext,
      envelope: stableEnvelope
    },
    result: {
      hostVerification: "not_run",
      taskRuntimeCleaned: false,
      privacyWarning: "cleanup pending"
    },
    error: {
      code: "E_PROCESS_IDENTITY",
      message: "Verified owned process signalling could not be completed.",
      details: {
        secondaryDiagnostic: {
          code: "EPERM",
          message: "kill EPERM"
        }
      }
    },
    pendingTerminal: {
      status: "completed",
      phase: "done",
      completedAt: stamped,
      error: null,
      summary: "Worker completed"
    },
    lifecycleEvents: []
  });
  let repeatedBlocked;
  fs.chmodSync(repeatedCleanupHome, 0o500);
  try {
    repeatedBlocked = parseJson(
      runCompanion(
        ["status", repeatedCleanupId, "--json"],
        { cwd: root, env }
      )
    );
  } finally {
    fs.chmodSync(repeatedCleanupHome, 0o700);
  }
  assert.equal(repeatedBlocked.status, "running");
  assert.equal(repeatedBlocked.phase, "cleanup-blocked");
  assert.equal(repeatedBlocked.error.code, "E_PROCESS_IDENTITY");
  assert.equal(
    readJob(root, repeatedCleanupId, env)
      .error.details.secondaryDiagnostic.code,
    "EPERM"
  );
  const repeatedSettled = parseJson(
    runCompanion(
      ["status", repeatedCleanupId, "--json"],
      { cwd: root, env }
    )
  );
  assert.equal(repeatedSettled.status, "failed");
  assert.equal(repeatedSettled.error.code, "E_PROCESS_IDENTITY");
  assert.equal(repeatedSettled.result.taskRuntimeCleaned, true);
  assert.equal(
    readJob(root, repeatedCleanupId, env)
      .error.details.secondaryDiagnostic.code,
    "EPERM"
  );
  assert.equal(JSON.stringify(repeatedSettled).includes("EPERM"), false);
}

function assertInterruptedCleanup(context) {
  const {
    root, env, stateRoot, stored, stamped, priorErrorId, stableContext, stableEnvelope
  } = context;
const interruptedId = generateId("task");
  writeSeededJob(stateRoot, {
    ...readJob(root, priorErrorId, env),
    id: interruptedId,
    title: "task: cleanup error does not replace interruption",
    summary: "Task provider exited, but transient runtime cleanup is incomplete.",
    status: "running",
    phase: "cleanup-blocked",
    createdAt: stamped,
    startedAt: stamped,
    updatedAt: stamped,
    completedAt: null,
    heartbeatAt: stamped,
    grokSessionId: "fake-session-cleanup-generic-prior",
    workerProcess: {
      ...stored.workerProcess,
      commandMarker: interruptedId
    },
    completionContextManifest: null,
    logFile: path.join(stateRoot, "jobs", `${interruptedId}.log`),
    progress: "Worker lost; provider cleanup could not be verified",
    request: {
      ...stored.request,
      providerHomeId: interruptedId,
      contextManifest: stableContext,
      envelope: stableEnvelope
    },
    result: {
      hostVerification: "not_run",
      taskRuntimeCleaned: false,
      privacyWarning: "cleanup pending"
    },
    error: {
      code: "E_STATE",
      message: "Task provider exited, but transient runtime cleanup is incomplete."
    },
    pendingTerminal: undefined,
    lifecycleEvents: []
  });

  const interrupted = parseJson(
    runCompanion(["status", interruptedId, "--json"], { cwd: root, env })
  );
  assert.equal(interrupted.status, "failed");
  assert.equal(interrupted.phase, "failed");
  assert.equal(interrupted.error.code, "E_WORKER_LOST");
  assert.equal(interrupted.result.taskRuntimeCleaned, true);
  return { ...context, interruptedId };
}

function assertTerminalCleanupDrift(context) {
  const {
    root, env, stateRoot, stored, stamped, interruptedId, stableContext, stableEnvelope
  } = context;
const terminalId = generateId("task");
  writeSeededJob(stateRoot, {
    ...readJob(root, interruptedId, env),
    id: terminalId,
    title: "task: terminal re-clean final evidence",
    summary: "kill EPERM",
    status: "failed",
    phase: "failed",
    createdAt: stamped,
    startedAt: stamped,
    updatedAt: stamped,
    completedAt: stamped,
    heartbeatAt: stamped,
    grokSessionId: "fake-session-terminal-re-clean",
    workerProcess: {
      ...stored.workerProcess,
      commandMarker: terminalId
    },
    completionContextManifest: null,
    logFile: path.join(stateRoot, "jobs", `${terminalId}.log`),
    progress: "Task finished; runtime cleanup is still pending",
    request: {
      ...stored.request,
      providerHomeId: terminalId,
      contextManifest: stableContext,
      envelope: stableEnvelope
    },
    result: {
      hostVerification: "not_run",
      taskRuntimeCleaned: false,
      privacyWarning: "cleanup pending"
    },
    error: { code: "E_BROKER", message: "kill EPERM" },
    pendingTerminal: undefined,
    lifecycleEvents: []
  });
  git(root, "config", "--local", "--add", "grok.issue49TerminalDrift", "true");

  const terminalReclean = parseJson(
    runCompanion(["status", terminalId, "--json"], { cwd: root, env })
  );
  assert.equal(terminalReclean.status, "failed");
  assert.equal(terminalReclean.phase, "context-rejected");
  assert.equal(terminalReclean.error.code, "E_CONTEXT_DRIFT");
  assert.equal(terminalReclean.result.taskRuntimeCleaned, true);
  assert.equal(terminalReclean.result.stopReason, undefined);
  assert.equal(terminalReclean.progress.includes("pending"), false);
  assert.ok(
    terminalReclean.result.runtimeEvidence.observedChangedPaths.includes(
      "[GIT_METADATA]"
    )
  );
  assert.equal(JSON.stringify(terminalReclean).includes("EPERM"), false);
  assert.equal(
    readJob(root, terminalId, env).error.details.secondaryDiagnostic.code,
    "EPERM"
  );
  assert.equal(readJob(root, terminalId, env).result.stopReason, undefined);
  return { ...context, terminalId };
}

function assertTerminalGenericOwnership(context) {
  const { root, env, stateRoot, stored, stamped, terminalId } = context;
const terminalGenericId = generateId("task");
  const terminalGenericContext = captureContextManifest(root);
  const terminalGenericEnvelope = buildTaskEnvelope({
    userRequest: "preserve generic terminal ownership failure",
    objective: "preserve generic terminal ownership failure",
    mode: "read",
    scope: { include: ["tracked.txt"], exclude: [] },
    contextManifestId: terminalGenericContext.manifestId,
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
      text: "Keep the prior generic ownership outcome"
    }]
  });
  writeSeededJob(stateRoot, {
    ...readJob(root, terminalId, env),
    id: terminalGenericId,
    title: "task: terminal generic ownership re-clean",
    summary: "Process ownership verification failed.",
    status: "failed",
    phase: "failed",
    completedAt: stamped,
    grokSessionId: "fake-session-terminal-generic-ownership",
    workerProcess: {
      ...stored.workerProcess,
      commandMarker: terminalGenericId
    },
    completionContextManifest: null,
    logFile: path.join(
      stateRoot,
      "jobs",
      `${terminalGenericId}.log`
    ),
    progress: "Task finished; runtime cleanup is still pending",
    request: {
      ...stored.request,
      providerHomeId: terminalGenericId,
      contextManifest: terminalGenericContext,
      envelope: terminalGenericEnvelope
    },
    result: {
      hostVerification: "not_run",
      taskRuntimeCleaned: false,
      privacyWarning: "cleanup pending",
      stopReason: "cancelled"
    },
    error: {
      code: "E_PROCESS_IDENTITY",
      message: "Process ownership verification failed."
    },
    pendingTerminal: undefined,
    lifecycleEvents: []
  });

  const terminalGeneric = parseJson(
    runCompanion(
      ["status", terminalGenericId, "--json"],
      { cwd: root, env }
    )
  );
  assert.equal(terminalGeneric.status, "failed");
  assert.equal(terminalGeneric.phase, "failed");
  assert.equal(terminalGeneric.error.code, "E_PROCESS_IDENTITY");
  assert.equal(terminalGeneric.result.taskRuntimeCleaned, true);
  assert.equal(terminalGeneric.result.stopReason, undefined);
  assert.deepEqual(
    terminalGeneric.result.runtimeEvidence.observedChangedPaths,
    []
  );
  assert.equal(terminalGeneric.progress, "Worker finalization completed");
  const storedTerminalGeneric = readJob(root, terminalGenericId, env);
  assert.equal(
    storedTerminalGeneric.error.message,
    "Process ownership verification failed."
  );
  assert.equal(storedTerminalGeneric.result.stopReason, undefined);
}

test("cleanup-blocked recovery lets final context drift override a process signalling failure", {
  skip: process.platform === "win32"
}, () => {
  let context = recoverDriftedCleanupFixture();
  context = assertStableCleanupSignal(context);
  context = assertPriorCleanupError(context);
  assertRepeatedCleanupSignal(context);
  context = assertInterruptedCleanup(context);
  context = assertTerminalCleanupDrift(context);
  assertTerminalGenericOwnership(context);
});

test("terminal task cleanup defers while an active continuation owns the same lineage", { skip: process.platform === "win32" }, () => {
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const lineage = generateId("task");
  const oldId = generateId("task");
  const activeId = generateId("task");
  const taskHome = path.join(stateRoot, "task-homes", lineage, ".grok");
  fs.mkdirSync(path.join(taskHome, "agent-profiles"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(taskHome, "auth.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(taskHome, "agent-profiles", "active.md"), "active profile\n", { mode: 0o600 });
  const stamped = new Date().toISOString();
  const common = {
    schemaVersion: 3,
    kind: "task",
    jobClass: "task",
    write: false,
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    profile: profileFor("task", false),
    model: null,
    effort: null,
    createdAt: stamped,
    startedAt: stamped,
    updatedAt: stamped,
    heartbeatAt: stamped,
    workerProcess: null,
    providerProcess: null,
    error: null
  };
  writeSeededJob(stateRoot, {
    ...common,
    id: oldId,
    title: "old cleanup-pending task",
    summary: "completed",
    status: "completed",
    phase: "done",
    completedAt: stamped,
    grokSessionId: "66666666-6666-4666-8666-666666666666",
    logFile: path.join(stateRoot, "jobs", `${oldId}.log`),
    progress: "done",
    request: { prompt: null, providerHomeId: lineage },
    result: { taskRuntimeCleaned: false, privacyWarning: "cleanup pending" }
  });
  writeSeededJob(stateRoot, {
    ...common,
    id: activeId,
    title: "active continuation",
    summary: "queued",
    status: "queued",
    phase: "queued",
    completedAt: null,
    grokSessionId: null,
    logFile: path.join(stateRoot, "jobs", `${activeId}.log`),
    progress: "queued",
    request: { prompt: null, providerHomeId: lineage },
    result: null
  });

  const deferred = parseJson(runCompanion(["status", oldId, "--json"], { cwd: root, env }));
  assert.equal(deferred.result.taskRuntimeCleaned, false);
  assert.equal(fs.existsSync(path.join(taskHome, "auth.json")), true);
  assert.equal(fs.existsSync(path.join(taskHome, "agent-profiles", "active.md")), true);

  writeSeededJob(stateRoot, {
    ...JSON.parse(fs.readFileSync(path.join(stateRoot, "jobs", `${activeId}.json`), "utf8")),
    status: "completed",
    phase: "done",
    completedAt: stamped,
    result: { taskRuntimeCleaned: true }
  });
  const cleaned = parseJson(runCompanion(["status", oldId, "--json"], { cwd: root, env }));
  assert.equal(cleaned.result.taskRuntimeCleaned, true);
  assert.equal(fs.existsSync(path.join(taskHome, "auth.json")), false);
  assert.equal(fs.existsSync(path.join(taskHome, "agent-profiles")), false);
});

test("cleanup-blocked recovery terminates a verified live worker before restoring completion", { skip: process.platform === "win32" }, async () => {
  const root = fs.realpathSync(initRepo());
  const { env, pluginData } = fixture({ cancelMode: "wait" });
  const launch = parseJson(runCompanion(["task", "--background", "live finalizer fixture", "--json"], { cwd: root, env }));
  const running = await waitFor(() => {
    const job = persistedJob(pluginData, launch.id);
    return job.status === "running" && job.phase === "responding" && job.workerProcess?.pid && job.providerProcess?.pid ? job : false;
  }, { timeoutMs: 10_000 });
  const stateRoot = path.dirname(path.dirname(running.logFile));
  const taskHome = path.join(stateRoot, "task-homes", running.request.providerHomeId, ".grok");
  const stamped = new Date().toISOString();
  const jobFile = path.join(stateRoot, "jobs", `${running.id}.json`);
  fs.writeFileSync(jobFile, `${JSON.stringify({
    ...running,
    status: "running",
    phase: "cleanup-blocked",
    completedAt: null,
    controllerProcess: null,
    progress: "cleanup pending",
    result: { ...(running.result || {}), hostVerification: "not_run", taskRuntimeCleaned: false },
    error: { code: "E_STATE", message: "cleanup pending" },
    pendingTerminal: { status: "completed", phase: "done", completedAt: stamped, error: null, summary: "completed" }
  }, null, 2)}\n`, { mode: 0o600 });

  const recovered = parseJson(runCompanion(["status", running.id, "--json"], { cwd: root, env, timeout: 15_000 }));
  assert.equal(recovered.status, "completed", JSON.stringify(recovered));
  assert.equal(recovered.phase, "done");
  assert.equal(recovered.error, null);
  assert.equal(recovered.result.taskRuntimeCleaned, true);
  assert.equal(processGroupAlive(running.workerProcess.processGroupId), false);
  assert.equal(fs.existsSync(path.join(taskHome, "auth.json")), false);
  assert.equal(fs.existsSync(path.join(taskHome, "agent-profiles")), false);
});

test("terminal review cleanup waits for the recorded worker group", { skip: process.platform === "win32" }, async (t) => {
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const reviewHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(reviewHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(reviewHome, "retained.txt"), "privacy\n", { mode: 0o600 });
  const worker = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", id], { detached: true, stdio: "ignore" });
  t.after(() => { try { process.kill(-worker.pid, "SIGKILL"); } catch {} });
  await waitFor(() => processGroupAlive(worker.pid), { timeoutMs: 5000 });
  const stamped = new Date().toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 3,
    id,
    kind: "review",
    jobClass: "review",
    title: "terminal review with live worker",
    summary: "pass",
    write: false,
    status: "completed",
    phase: "done",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: stamped,
    updatedAt: stamped,
    completedAt: stamped,
    heartbeatAt: stamped,
    workerProcess: { pid: worker.pid, startToken: processStartToken(worker.pid), processGroupId: worker.pid, nonce: "n", commandMarker: id },
    providerProcess: null,
    profile: profileFor("review"),
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: "done",
    request: { prompt: null, target: { mode: "working-tree", label: "fixture", base: null } },
    result: { review: { verdict: "pass", summary: "pass", findings: [] }, providerSessionDeleted: false, privacyWarning: "cleanup pending" },
    error: null
  });

  const deferred = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
  assert.equal(deferred.result.providerSessionDeleted, false);
  assert.equal(fs.existsSync(path.join(reviewHome, "retained.txt")), true);
  process.kill(-worker.pid, "SIGKILL");
  await waitFor(() => !processGroupAlive(worker.pid), { timeoutMs: 5000 });
  const cleaned = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
  assert.equal(cleaned.result.providerSessionDeleted, true);
  assert.equal(cleaned.result.privacyWarning, undefined);
  assert.equal(fs.existsSync(reviewHome), false);
});

test("a foreground caller returns the recovered worker-crash failure", { skip: process.platform === "win32" }, async () => {
  const root = initRepo();
  const { fake, pluginData, env } = fixture({ cancelMode: "wait" });
  const foreground = spawnCompanion(
    ["task", "--wait", "foreground worker crash fixture", "--json"],
    { cwd: root, env }
  );

  try {
    const running = await waitFor(() => {
      const job = persistedJobs(pluginData)[0];
      return job?.status === "running" && job.providerProcess?.pid ? job : false;
    }, { timeoutMs: 10000 });
    process.kill(running.workerProcess.pid, "SIGKILL");

    let completionTimer;
    let completed;
    try {
      completed = await Promise.race([
        foreground.completed,
        new Promise((_, reject) => {
          completionTimer = setTimeout(
            () => reject(new Error("Foreground caller did not observe recovered worker failure.")),
            25000
          );
        })
      ]);
    } finally {
      clearTimeout(completionTimer);
    }
    assert.equal(completed.signal, null);
    assert.notEqual(completed.code, 0, completed.stdout);
    const payload = JSON.parse(completed.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "E_WORKER_LOST");
    const recovered = persistedJob(pluginData, running.id);
    assert.equal(recovered.id, running.id);
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.phase, "failed");
    assert.equal(recovered.error.code, "E_WORKER_LOST");
    assert.ok(recovered.completedAt);
    assert.ok(readFakeLog(fake.logFile).filter((entry) => entry.event === "prompt").length <= 1, "crashed foreground prompt was replayed");
  } finally {
    if (foreground.child.exitCode == null && foreground.child.signalCode == null) foreground.child.kill("SIGKILL");
  }
});

test("lost-worker recovery terminates headless review and removes its isolated home", { skip: process.platform === "win32" }, async () => {
  const root = initRepo();
  fs.appendFileSync(path.join(root, "tracked.txt"), "review worker crash fixture\n", "utf8");
  const { pluginData, env } = fixture({ headlessDelayMs: 60_000 });
  const launch = parseJson(runCompanion(
    ["review", "--background", "--json"],
    { cwd: root, env }
  ));
  const running = await waitFor(() => {
    const result = runCompanion(["status", launch.id, "--json"], { cwd: root, env });
    if (result.status !== 0) return false;
    const job = persistedJob(pluginData, launch.id);
    return job.status === "running" && job.providerProcess?.pid ? job : false;
  });
  const isolatedHome = path.join(path.dirname(path.dirname(running.logFile)), "review-homes", launch.id);
  assert.equal(fs.existsSync(isolatedHome), true);

  try {
    process.kill(running.workerProcess.pid, "SIGKILL");
    const recovered = await waitFor(() => {
      const result = runCompanion(["status", launch.id, "--json"], { cwd: root, env });
      if (result.status !== 0) return false;
      const job = JSON.parse(result.stdout);
      return job.status === "failed" ? job : false;
    }, { timeoutMs: 15000 });
    assert.equal(recovered.error.code, "E_WORKER_LOST");
    assert.equal(fs.existsSync(isolatedHome), false);
  } finally {
    try { process.kill(-running.providerProcess.processGroupId, "SIGKILL"); } catch {}
    fs.rmSync(path.join(pluginData, "state"), { recursive: true, force: true });
  }
});

test("lost-worker recovery retains privacy evidence when provider terminate cannot verify cleanup", { skip: process.platform === "win32" }, () => {
  const root = initRepo();
  const { pluginData, env } = fixture();
  // Seed workspace state by creating one empty-target job first.
  parseJson(runCompanion(["review", "--scope", "working-tree", "--json"], { cwd: root, env }));
  const jobs = persistedJobs(pluginData);
  assert.ok(jobs.length >= 1);
  const stateRoot = path.dirname(path.dirname(jobs[0].logFile));
  const id = `review-${crypto.randomBytes(12).toString("hex")}`;
  const isolatedHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(isolatedHome, "marker"), "retained\n", { mode: 0o600 });
  const stamped = new Date(Date.now() - 60_000).toISOString();
  const job = {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: retained privacy fixture",
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
    providerProcess: { pid: 1, startToken: null, processGroupId: null },
    profile: { id: "review", transport: "headless" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: { prompt: null, target: { mode: "working-tree", label: "fixture", base: null } },
    result: { privacyWarning: "prior-privacy-signal" },
    error: null
  };
  fs.writeFileSync(path.join(stateRoot, "jobs", `${id}.json`), `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(job.logFile, "", { mode: 0o600 });

  const recovered = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
  assert.equal(recovered.status, "running");
  assert.equal(recovered.phase, "cleanup-blocked");
  assert.equal(recovered.result.providerSessionDeleted, false);
  assert.match(recovered.result.privacyWarning, /prior-privacy-signal/);
  assert.match(recovered.result.privacyWarning, /Isolated review home retained/);
  assert.equal(fs.existsSync(isolatedHome), true);
});

test("successful later review re-cleanup clears prior privacy warning", () => {
  const root = initRepo();
  const { pluginData, env } = fixture();
  parseJson(runCompanion(["review", "--scope", "working-tree", "--json"], { cwd: root, env }));
  const jobs = persistedJobs(pluginData);
  assert.ok(jobs.length >= 1);
  const stateRoot = path.dirname(path.dirname(jobs[0].logFile));
  const id = `review-${crypto.randomBytes(12).toString("hex")}`;
  const isolatedHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(isolatedHome, "marker"), "to-remove\n", { mode: 0o600 });
  const stamped = new Date().toISOString();
  const job = {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: recleanup fixture",
    summary: "pass: fixture",
    write: false,
    status: "completed",
    phase: "done",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: stamped,
    updatedAt: stamped,
    completedAt: stamped,
    workerProcess: null,
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
  };
  fs.writeFileSync(path.join(stateRoot, "jobs", `${id}.json`), `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(job.logFile, "", { mode: 0o600 });

  const cleaned = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
  assert.equal(cleaned.status, "completed");
  assert.equal(cleaned.result.providerSessionDeleted, true);
  assert.equal(cleaned.result.privacyWarning, undefined);
  assert.equal(fs.existsSync(isolatedHome), false);
});

test("terminal re-cleanup retains privacy until the full provider process group is gone", { skip: process.platform === "win32" }, async () => {
  const root = initRepo();
  const { pluginData, env } = fixture();
  parseJson(runCompanion(["review", "--scope", "working-tree", "--json"], { cwd: root, env }));
  const jobs = persistedJobs(pluginData);
  assert.ok(jobs.length >= 1);
  const stateRoot = path.dirname(path.dirname(jobs[0].logFile));
  const id = `review-${crypto.randomBytes(12).toString("hex")}`;
  const isolatedHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(isolatedHome, "marker"), "group-retained\n", { mode: 0o600 });

  // Detached leader starts a same-group descendant then exits → live group, no live leader.
  const leader = spawn(process.execPath, ["-e", [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: false, stdio: 'ignore' });",
    "child.unref();",
    "setTimeout(() => process.exit(0), 100);"
  ].join("")], { detached: true, stdio: "ignore" });
  leader.unref();
  const processGroupId = leader.pid;
  const leaderPid = leader.pid;
  try {
    await waitFor(() => processStartToken(leaderPid) === null && processGroupAlive(processGroupId), { timeoutMs: 5000 });
    assert.equal(processGroupAlive(processGroupId), true);
    assert.equal(processStartToken(leaderPid), null);

    const stamped = new Date(Date.now() - 60_000).toISOString();
    const job = {
      schemaVersion: 2,
      id,
      kind: "review",
      jobClass: "review",
      title: "review: live-group recleanup fixture",
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
      providerProcess: { pid: leaderPid, startToken: "dead-leader-token", processGroupId },
      profile: { id: "review", transport: "headless" },
      model: null,
      effort: null,
      logFile: path.join(stateRoot, "jobs", `${id}.log`),
      progress: null,
      request: { prompt: null, target: { mode: "working-tree", label: "fixture", base: null } },
      result: { privacyWarning: "prior-privacy-signal" },
      error: null
    };
    fs.writeFileSync(path.join(stateRoot, "jobs", `${id}.json`), `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(job.logFile, "", { mode: 0o600 });

    // Recovery 1: lost worker + dead leader with live group → fail closed privacy retention.
    const first = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
    assert.equal(first.status, "running");
    assert.equal(first.phase, "cleanup-blocked");
    assert.equal(first.error.code, "E_PROCESS_IDENTITY");
    assert.equal(first.result.providerSessionDeleted, false);
    assert.match(first.result.privacyWarning, /prior-privacy-signal/);
    assert.match(first.result.privacyWarning, /Isolated review home retained/);
    assert.equal(fs.existsSync(isolatedHome), true);
    assert.equal(processGroupAlive(processGroupId), true);

    // Recovery 2: active cleanup must still refuse while the group remains live.
    const second = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
    assert.equal(second.status, "running");
    assert.equal(second.result.providerSessionDeleted, false);
    assert.match(second.result.privacyWarning, /prior-privacy-signal/);
    assert.match(second.result.privacyWarning, /Isolated review home retained/);
    assert.equal(fs.existsSync(isolatedHome), true);
    assert.equal(processGroupAlive(processGroupId), true);

    // After the full owned group is gone, a later recovery cleans and clears as intended.
    try { process.kill(-processGroupId, "SIGKILL"); } catch {}
    await waitFor(() => !processGroupAlive(processGroupId), { timeoutMs: 5000 });

    const cleaned = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
    assert.equal(cleaned.status, "failed");
    assert.equal(cleaned.result.providerSessionDeleted, true);
    assert.equal(cleaned.result.privacyWarning, undefined);
    assert.equal(fs.existsSync(isolatedHome), false);
  } finally {
    try { process.kill(-processGroupId, "SIGKILL"); } catch {}
  }
});
