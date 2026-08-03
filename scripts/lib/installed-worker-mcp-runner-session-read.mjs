// Installed Worker MCP qualification domain. Keep import-time behavior inert.
import { validateInstalledCompletionScenario } from "./installed-worker-mcp-contract.mjs";
import { decideInstalledWorkerMcpMailboxPoll } from "./installed-worker-mcp-mailbox-poll.mjs";
import { ACTIVE_WINDOW_WORKLOAD_FILES, CANONICAL_UUID, checkInterrupted, enterQualificationStage, fail, hasExactKeys, QualificationError, runBounded, sameJson, STATE_POLL_MS, TERMINAL_PROCESS_CLOSURE_TIMEOUT_MS } from "./installed-worker-mcp-runner-core.mjs";
import { assertPublicPrivateBinding, assertTerminalEventHistory, canonicalTimestamp, createTracker, drainTerminalEventStream, enterScenarioStage, observePrivateJob, observePublicWorker, observeStream, observeTerminalResultWorker, readPrivateJob, recordPrivateIdentityObservation, validateIntermediateWorkerSnapshot, validateTerminalWorkerSnapshot, waitForTerminal } from "./installed-worker-mcp-runner-observation.mjs";
import { callTool, closeMcp, initializeFixtureRepository, startInstalledMcp, verifyMcpSurface } from "./installed-worker-mcp-runner-runtime.mjs";
import { bindInstalledWorkerSessionBoundary, InstalledWorkerSessionTransactionError, runInstalledWorkerSessionCredentialTransaction } from "./installed-worker-mcp-session-boundary.mjs";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
export function sessionBoundaryIdentity(binding) {
  return {
    stateDirectory: binding.stateDirectory,
    homeMarker: binding.homeMarker,
    home: binding.home,
    grokHome: binding.grokHome,
    directoryIdentity: binding.directoryIdentity
  };
}

export function bindSessionBoundary(context, tracker) {
  const job = tracker.latestJob;
  if (
    !job
    || job.id !== tracker.workerId
    || !CANONICAL_UUID.test(tracker.sessionId || "")
  ) {
    fail("E_SESSION");
  }
  let jobFile;
  try {
    jobFile = context.state.jobFileIfPresent(
      context.fixtureRoot,
      tracker.workerId,
      context.env
    );
  } catch {
    fail("E_SESSION");
  }
  if (!jobFile) fail("E_SESSION");
  const stateDirectory = path.dirname(path.dirname(jobFile));
  const homeMarker = job.request?.providerHomeId;
  if (homeMarker !== job.id) fail("E_SESSION");
  if (homeMarker !== tracker.privateBinding?.lineageWorkerId) {
    fail("E_SESSION");
  }
  let binding;
  try {
    binding = bindInstalledWorkerSessionBoundary({
      stateDirectory,
      homeMarker,
      childEnvironment: context.provider.childEnvironment
    });
  } catch {
    fail("E_SESSION");
  }
  const identity = sessionBoundaryIdentity(binding);
  if (
    tracker.sessionBoundary
    && !sameJson(sessionBoundaryIdentity(tracker.sessionBoundary), identity)
  ) {
    fail("E_SESSION");
  }
  const registered = context.runner.sessions.get(tracker.sessionId);
  if (
    registered
    && (
      registered.workerId !== tracker.workerId
      || registered.fixtureRoot !== context.fixtureRoot
      || !sameJson(sessionBoundaryIdentity(registered.binding), identity)
    )
  ) {
    fail("E_SESSION");
  }
  tracker.sessionBoundary = binding;
  context.runner.sessions.set(tracker.sessionId, Object.freeze({
    workerId: tracker.workerId,
    fixtureRoot: context.fixtureRoot,
    binding
  }));
  return binding;
}

export function exactAuthFileAbsent(binding) {
  try {
    const stat = fs.lstatSync(binding.authFile);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("E_CLEANUP");
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    if (error instanceof QualificationError) throw error;
    fail("E_CLEANUP");
  }
}

export function exactPrivateAuthFile(binding) {
  try {
    const stat = fs.lstatSync(binding.authFile);
    return stat.isFile()
      && !stat.isSymbolicLink()
      && stat.size > 0
      && stat.size <= 2 * 1024 * 1024
      && (stat.mode & 0o077) === 0
      && (
        typeof process.getuid !== "function"
        || stat.uid === process.getuid()
      );
  } catch {
    return false;
  }
}

export async function waitForSessionCredentialRevocation(context, tracker) {
  const deadline = Date.now() + 30_000;
  while (Date.now() <= deadline) {
    checkInterrupted(context.runner);
    const binding = bindSessionBoundary(context, tracker);
    if (exactAuthFileAbsent(binding)) return binding;
    await new Promise((resolve) => setTimeout(resolve, STATE_POLL_MS));
  }
  fail("E_CLEANUP");
}

export function stageAuthenticatedSessionCredential(context, tracker) {
  const binding = bindSessionBoundary(context, tracker);
  let environment = null;
  try {
    environment = context.provider.taskCredentialEnvironment(
      binding.stateDirectory,
      binding.homeMarker,
      { providerExecutableBinary: context.providerBinary }
    );
    if (
      environment?.home !== binding.home
      || environment?.grokHome !== binding.grokHome
      || environment?.env?.HOME !== binding.home
      || environment?.env?.GROK_HOME !== binding.grokHome
    ) {
      fail("E_CLEANUP");
    }
    const rebound = bindSessionBoundary(context, tracker);
    if (!exactPrivateAuthFile(rebound)) fail("E_CLEANUP");
    return environment;
  } catch (error) {
    if (environment) {
      try {
        environment.revokeCredential();
      } catch {
        fail("E_CLEANUP");
      }
    }
    if (error instanceof QualificationError) throw error;
    fail("E_SESSION");
  }
}

export function refreshSessionCredentialHandle(environment) {
  try {
    environment?.refreshCredentialHandle();
  } catch (error) {
    if (error instanceof QualificationError) throw error;
    fail("E_CLEANUP");
  }
}

export function authenticateSessionCredential(context, tracker, environment) {
  const binding = bindSessionBoundary(context, tracker);
  if (!exactPrivateAuthFile(binding)) fail("E_CLEANUP");
  let authenticatedModels;
  try {
    authenticatedModels = runBounded(
      context.providerBinary,
      ["models"],
      {
        cwd: context.fixtureRoot,
        env: binding.env,
        timeoutMs: 30_000,
        code: "E_SESSION"
      }
    );
  } finally {
    refreshSessionCredentialHandle(environment);
  }
  const advertised = context.provider.parseAdvertisedModels(
    authenticatedModels.stdout
  );
  if (!Array.isArray(advertised) || advertised.length === 0) fail("E_SESSION");
  const rebound = bindSessionBoundary(context, tracker);
  if (!exactPrivateAuthFile(rebound)) fail("E_CLEANUP");
}

export function revokeSessionCredential(context, tracker, environment) {
  try {
    environment?.revokeCredential();
  } catch {
    throw new Error("credential-revocation-failed");
  }
}

export function assertSessionCredentialAbsent(context, tracker) {
  const binding = bindSessionBoundary(context, tracker);
  if (!exactAuthFileAbsent(binding)) {
    throw new Error("credential-remained");
  }
}

export async function runSessionCredentialTransaction(context, tracker, options) {
  try {
    return await runInstalledWorkerSessionCredentialTransaction({
      ...options,
      stageCredential: () => stageAuthenticatedSessionCredential(
        context,
        tracker
      ),
      authenticate: (environment) => authenticateSessionCredential(
        context,
        tracker,
        environment
      ),
      revokeCredential: (environment) => revokeSessionCredential(
        context,
        tracker,
        environment
      ),
      assertCredentialAbsent: () => assertSessionCredentialAbsent(
        context,
        tracker
      )
    });
  } catch (error) {
    if (error instanceof QualificationError) throw error;
    if (
      error instanceof InstalledWorkerSessionTransactionError
      && error.kind === "cleanup"
    ) {
      fail("E_CLEANUP");
    }
    fail("E_SESSION");
  }
}

export async function observeSessionPresentWithCredential(
  context,
  tracker,
  environment,
  timeoutMs
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    checkInterrupted(context.runner);
    const binding = bindSessionBoundary(context, tracker);
    if (!exactPrivateAuthFile(binding)) fail("E_CLEANUP");
    let observed;
    try {
      observed = context.provider.inspectImportedSessionPresence(
        tracker.sessionId,
        context.providerBinary,
        binding.env,
        context.fixtureRoot
      );
    } finally {
      refreshSessionCredentialHandle(environment);
    }
    if (observed?.ok === true && observed.present === true) return true;
    if (observed?.ok !== true) fail("E_SESSION");
    await new Promise((resolve) => setTimeout(resolve, STATE_POLL_MS));
  }
  fail("E_SESSION");
}

export async function proveSessionAbsentWithCredential(
  context,
  tracker,
  environment,
  timeoutMs
) {
  const deadline = Date.now() + timeoutMs;
  let consecutiveAbsenceProofs = 0;
  while (Date.now() <= deadline) {
    checkInterrupted(context.runner);
    const binding = bindSessionBoundary(context, tracker);
    if (!exactPrivateAuthFile(binding)) fail("E_CLEANUP");
    let observed;
    try {
      observed = context.provider.inspectImportedSessionPresence(
        tracker.sessionId,
        context.providerBinary,
        binding.env,
        context.fixtureRoot
      );
    } finally {
      refreshSessionCredentialHandle(environment);
    }
    if (observed?.ok !== true) fail("E_SESSION");
    consecutiveAbsenceProofs = observed.present === false
      ? consecutiveAbsenceProofs + 1
      : 0;
    if (consecutiveAbsenceProofs >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, STATE_POLL_MS));
  }
  fail("E_SESSION");
}

export async function waitForSessionPresence(context, tracker) {
  enterScenarioStage(tracker, "session-binding");
  bindSessionBoundary(context, tracker);
  enterScenarioStage(tracker, "session-credential-revoked");
  await waitForSessionCredentialRevocation(context, tracker);
  enterScenarioStage(tracker, "session-presence");
  await runSessionCredentialTransaction(context, tracker, {
    mode: "observe",
    provePresent: (environment) => observeSessionPresentWithCredential(
      context,
      tracker,
      environment,
      60_000
    ),
    beforeCredentialRevocation: () => enterScenarioStage(
      tracker,
      "session-cleanup-credential-revoked"
    )
  });
  tracker.sessionPresent = true;
}

export async function deleteAndProveSessionAbsent(context, tracker, {
  updateStage = true,
  timeoutMs = 60_000
} = {}) {
  if (!CANONICAL_UUID.test(tracker.sessionId || "")) fail("E_SESSION");
  const enterStage = (stage) => {
    if (updateStage) enterScenarioStage(tracker, stage);
  };
  enterStage("session-binding");
  bindSessionBoundary(context, tracker);
  enterStage("session-credential-revoked");
  await waitForSessionCredentialRevocation(context, tracker);
  enterStage(tracker.sessionDeleteAcknowledged === true
    ? "session-absence"
    : "session-presence");
  await runSessionCredentialTransaction(context, tracker, {
    mode: "delete",
    deleteAcknowledged: tracker.sessionDeleteAcknowledged === true,
    provePresent: async (environment) => {
      enterStage("session-presence");
      await observeSessionPresentWithCredential(
        context,
        tracker,
        environment,
        timeoutMs
      );
      tracker.sessionPresent = true;
    },
    deleteExact: (environment) => {
      enterStage("session-delete");
      const binding = bindSessionBoundary(context, tracker);
      if (!exactPrivateAuthFile(binding)) fail("E_CLEANUP");
      let deleted;
      try {
        deleted = context.provider.deleteSession(
          tracker.sessionId,
          context.providerBinary,
          binding.env
        );
      } finally {
        if (deleted?.ok === true && deleted.removed === true) {
          tracker.sessionDeleteAcknowledged = true;
        }
        refreshSessionCredentialHandle(environment);
      }
      if (deleted?.ok !== true || deleted.removed !== true) fail("E_SESSION");
      return true;
    },
    onDeleteAcknowledged: () => {
      tracker.sessionDeleteAcknowledged = true;
    },
    proveAbsent: (environment) => {
      enterStage("session-absence");
      return proveSessionAbsentWithCredential(
        context,
        tracker,
        environment,
        timeoutMs
      );
    },
    beforeCredentialRevocation: () => enterStage(
      "session-cleanup-credential-revoked"
    )
  });
  tracker.sessionDeleted = true;
  context.runner.sessions.delete(tracker.sessionId);
}

export function terminalCleanupRecordMatches(job, expectedStatus) {
  return (
    job.status === expectedStatus
    && job.result?.hostVerification === "not_run"
    && job.result?.taskRuntimeCleaned === true
  );
}

export async function waitForTerminalProcessClosure(
  context,
  tracker,
  expectedStatus
) {
  const deadline = Date.now() + TERMINAL_PROCESS_CLOSURE_TIMEOUT_MS;
  let stableScans = 0;
  let latest = null;
  while (Date.now() <= deadline) {
    checkInterrupted(context.runner);
    latest = readPrivateJob(context, tracker);
    if (!terminalCleanupRecordMatches(latest, expectedStatus)) {
      fail("E_CLEANUP");
    }
    const allGone = [...tracker.processIdentities.values()]
      .every((identity) => context.processControl.processGroupGone(identity));
    stableScans = allGone ? stableScans + 1 : 0;
    if (stableScans >= 2) return latest;
    await new Promise((resolve) => setTimeout(resolve, STATE_POLL_MS));
  }
  fail("E_CLEANUP");
}

export async function waitForWriteSmokeProcessClosure(
  context,
  workerId,
  retainedProviderIdentities = [],
  expectedStatus = "completed"
) {
  const deadline = Date.now() + TERMINAL_PROCESS_CLOSURE_TIMEOUT_MS;
  let stableScans = 0;
  let latest = null;
  while (Date.now() <= deadline) {
    checkInterrupted(context.runner);
    latest = context.state.readJob(
      context.fixtureRoot,
      workerId,
      context.env
    );
    if (
      latest.status !== expectedStatus
      || latest.result?.taskRuntimeCleaned !== true
    ) {
      fail("E_CLEANUP");
    }
    const identities = [
      latest.controllerProcess,
      latest.workerProcess,
      latest.providerProcess,
      ...retainedProviderIdentities
    ];
    const distinctIdentities = [...new Map(identities.map((identity) => [
      `${identity?.pid}:${identity?.startToken}`,
      identity
    ])).values()];
    try {
      distinctIdentities.forEach((identity) => (
        context.processControl.assertCompleteDetachedOwnedIdentity(identity)
      ));
    } catch {
      fail("E_CLEANUP");
    }
    const allGone = distinctIdentities.every((identity) => (
      context.processControl.processGroupGone(identity)
    ));
    stableScans = allGone ? stableScans + 1 : 0;
    if (stableScans >= 2) return latest;
    await new Promise((resolve) => setTimeout(resolve, STATE_POLL_MS));
  }
  fail("E_CLEANUP");
}

export const WRITE_SMOKE_PRIMARY_TURN_ADMISSION_KEYS = new Set([
  "schemaVersion",
  "status",
  "admissionId",
  "dispatchAttemptId",
  "dispatchFence",
  "providerGeneration",
  "workerProcess",
  "providerProcess",
  "providerSessionId",
  "providerLaunchBindingDigest",
  "providerExecutableIdentityDigest",
  "promptDigest",
  "admittedAt",
  "consumedAt"
]);

export function validWriteSmokePrimaryTurnAdmission(admission, {
  generation,
  dispatch,
  workerId,
  workerProcess,
  providerSessionId,
  providerLaunchBindingDigest,
  providerExecutableIdentityDigest,
  expectedProviderProcess = null
}) {
  const expectedWorkerProcess = {
    pid: workerProcess?.pid ?? null,
    startToken: workerProcess?.startToken ?? null,
    processGroupId: workerProcess?.processGroupId ?? null,
    commandMarker: workerProcess?.commandMarker ?? null,
    dispatchAttemptId: workerProcess?.dispatchAttemptId ?? null,
    dispatchFence: workerProcess?.dispatchFence ?? null,
    nonce: workerProcess?.nonce ?? null
  };
  const providerProcess = admission?.providerProcess;
  const expectedProviderBinding = expectedProviderProcess
    ? {
        pid: expectedProviderProcess.pid,
        startToken: expectedProviderProcess.startToken,
        processGroupId: expectedProviderProcess.processGroupId,
        commandMarker: expectedProviderProcess.commandMarker,
        dispatchAttemptId: expectedProviderProcess.dispatchAttemptId,
        dispatchFence: expectedProviderProcess.dispatchFence,
        providerGeneration: expectedProviderProcess.providerGeneration
      }
    : null;
  return (
    hasExactKeys(admission, WRITE_SMOKE_PRIMARY_TURN_ADMISSION_KEYS)
    && admission.schemaVersion === 1
    && admission.status === "consumed"
    && /^[0-9a-f]{32}$/.test(admission.admissionId || "")
    && admission.dispatchAttemptId === dispatch?.attemptId
    && admission.dispatchFence === dispatch?.fence
    && admission.providerGeneration === generation
    && sameJson(admission.workerProcess, expectedWorkerProcess)
    && hasExactKeys(providerProcess, new Set([
      "pid",
      "startToken",
      "processGroupId",
      "commandMarker",
      "dispatchAttemptId",
      "dispatchFence",
      "providerGeneration"
    ]))
    && Number.isSafeInteger(providerProcess.pid)
    && providerProcess.pid > 0
    && typeof providerProcess.startToken === "string"
    && providerProcess.startToken.length > 0
    && providerProcess.processGroupId === providerProcess.pid
    && providerProcess.commandMarker === workerId
    && providerProcess.dispatchAttemptId === dispatch?.attemptId
    && providerProcess.dispatchFence === dispatch?.fence
    && providerProcess.providerGeneration === generation
    && (
      expectedProviderBinding === null
      || sameJson(providerProcess, expectedProviderBinding)
    )
    && admission.providerSessionId === providerSessionId
    && admission.providerLaunchBindingDigest === providerLaunchBindingDigest
    && admission.providerExecutableIdentityDigest
      === providerExecutableIdentityDigest
    && /^[0-9a-f]{64}$/.test(admission.promptDigest || "")
    && canonicalTimestamp(admission.admittedAt)
    && canonicalTimestamp(admission.consumedAt)
    && Date.parse(admission.consumedAt) >= Date.parse(admission.admittedAt)
  );
}

export function proveExactCancellationMarker(
  context,
  tracker,
  jobsDirectory,
  job,
  expectedStatus
) {
  const markerName = `${job.id}.cancel`;
  const marker = path.join(jobsDirectory, markerName);
  let names;
  try {
    names = fs.readdirSync(jobsDirectory);
  } catch {
    fail("E_CLEANUP");
  }
  if (names.some((name) => name.startsWith(`${markerName}.`))) {
    fail("E_CLEANUP");
  }
  if (expectedStatus !== "cancelled") {
    try {
      fs.lstatSync(marker);
      fail("E_CLEANUP");
    } catch (error) {
      if (error instanceof QualificationError) throw error;
      if (error?.code !== "ENOENT") fail("E_CLEANUP");
    }
    return;
  }

  const nonce = context.mutation.cancellationNonce(job);
  const workerNonce = tracker.processIdentities.get("worker")?.nonce;
  if (
    typeof nonce !== "string"
    || nonce.length < 1
    || nonce.length > 256
    || /[\r\n]/.test(nonce)
    || nonce !== workerNonce
  ) {
    fail("E_CLEANUP");
  }
  let descriptor;
  try {
    const entry = fs.lstatSync(marker);
    if (!entry.isFile() || entry.isSymbolicLink()) fail("E_CLEANUP");
    descriptor = fs.openSync(
      marker,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.dev !== entry.dev
      || opened.ino !== entry.ino
      || (opened.mode & 0o777) !== 0o600
      || (
        typeof process.getuid === "function"
        && opened.uid !== process.getuid()
      )
      || opened.size !== Buffer.byteLength(`${nonce}\n`)
      || fs.readFileSync(descriptor, "utf8") !== `${nonce}\n`
    ) {
      fail("E_CLEANUP");
    }
  } catch (error) {
    if (error instanceof QualificationError) throw error;
    fail("E_CLEANUP");
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

export async function proveTerminalCleanup(context, tracker, expectedStatus) {
  let job = readPrivateJob(context, tracker, {
    recordProviderObservation: tracker.observedProviderGenerations.length === 0
  });
  if (!terminalCleanupRecordMatches(job, expectedStatus)) fail("E_CLEANUP");
  if (tracker.processIdentities.size !== 3) fail("E_CLEANUP");
  const distinctIdentities = new Set(
    [...tracker.processIdentities.values()].map((identity) => (
      `${identity.pid}\0${identity.startToken}\0${identity.processGroupId}`
    ))
  );
  if (distinctIdentities.size !== 3) fail("E_CLEANUP");
  job = await waitForTerminalProcessClosure(context, tracker, expectedStatus);
  let guard;
  try {
    guard = context.guard.loadProviderGuard(context.fixtureRoot, tracker.workerId);
  } catch {
    fail("E_CLEANUP");
  }
  if (guard !== null) fail("E_CLEANUP");
  tracker.providerGuardAbsent = true;
  const jobFile = context.state.jobFileIfPresent(
    context.fixtureRoot,
    tracker.workerId,
    context.env
  );
  if (!jobFile) fail("E_CLEANUP");
  const stateDirectory = path.dirname(path.dirname(jobFile));
  const jobsDirectory = path.dirname(jobFile);
  const homeMarker = job.request?.providerHomeId;
  if (homeMarker !== job.id) fail("E_CLEANUP");
  const transient = [
    path.join(stateDirectory, "task-homes", homeMarker, ".grok", "auth.json"),
    path.join(stateDirectory, "task-homes", homeMarker, ".grok", "agent-profiles")
  ];
  if (transient.some((candidate) => fs.existsSync(candidate))) fail("E_CLEANUP");
  proveExactCancellationMarker(
    context,
    tracker,
    jobsDirectory,
    job,
    expectedStatus
  );
  let stateNames;
  try {
    stateNames = fs.readdirSync(stateDirectory);
  } catch {
    fail("E_CLEANUP");
  }
  if (stateNames.some((name) => name.startsWith(`leader-${job.id}-`))) {
    fail("E_CLEANUP");
  }
  const afterFixtureStatus = runBounded("git", [
    "status", "--porcelain=v1", "-z", "--untracked-files=all"
  ], {
    cwd: context.fixtureRoot,
    env: context.env,
    requireSilentStderr: false,
    code: "E_CLEANUP"
  }).stdout;
  if (afterFixtureStatus !== tracker.fixtureStatus) fail("E_CLEANUP");
  return job;
}

export function scenarioPrompt(label, { activeWindow = false } = {}) {
  const instructions = [
    `Inspect tracked.txt for the ${label} installed Worker MCP qualification.`,
    "Do not edit files and do not invoke another agent.",
    ...(activeWindow ? [
      "Before finishing, use the read-only tools to inspect every numbered file under qualification-workload in ascending order.",
      `Account for all ${ACTIVE_WINDOW_WORKLOAD_FILES} markers; do not return the final report before that bounded inspection is complete.`
    ] : []),
    "Your first response must complete the task without a repair attempt.",
    "End that first response with this exact final line:",
    "GROK_WORKER_REPORT: {\"outcome\":\"complete\",\"summary\":\"Installed Worker MCP fixture inspected.\",\"changedFiles\":[],\"checksClaimed\":[],\"acceptanceResults\":[{\"id\":\"AC-01\",\"status\":\"met\"},{\"id\":\"AC-02\",\"status\":\"met\"}],\"risks\":[],\"questions\":[]}"
  ];
  return instructions.join(" ");
}

export async function beginScenario(
  context,
  tracker,
  client,
  key,
  label,
  { activeWindow = false } = {}
) {
  enterScenarioStage(tracker, "owned-list");
  const empty = await callTool(
    context,
    client,
    "worker_list_owned",
    {},
    ["workers"]
  );
  if (!Array.isArray(empty.workers) || empty.workers.length !== 0) {
    fail("E_SCENARIO");
  }
  const spawnArguments = Object.freeze({
    idempotencyKey: key,
    userRequest: scenarioPrompt(label, { activeWindow }),
    objective: `Complete the ${label} installed Worker MCP qualification.`,
    roleId: "explorer"
  });
  tracker.spawnIdempotencyKey = key;
  enterScenarioStage(tracker, "spawn-call");
  const spawn = await callTool(
    context,
    client,
    "worker_spawn",
    spawnArguments,
    [
      "worker",
      "replayed",
      "spawnSuccessDefinition",
      "providerLaunchState",
      "providerLaunched"
    ]
  );
  tracker.calls.spawn += 1;
  tracker.workerId = spawn.worker?.id;
  if (!tracker.workerId) fail("E_SCENARIO");
  enterScenarioStage(tracker, "spawn-private");
  observePublicWorker(tracker, spawn.worker);
  const spawnedJob = readPrivateJob(context, tracker);
  assertPublicPrivateBinding(spawn.worker, spawnedJob);
  enterScenarioStage(tracker, "spawn-witness");
  recordPrivateIdentityObservation(
    context,
    tracker,
    spawnedJob,
    spawn.worker,
    { spawnKey: key, replayed: false }
  );

  enterScenarioStage(tracker, "get");
  const got = await callTool(
    context,
    client,
    "worker_get",
    { id: tracker.workerId },
    ["worker"]
  );
  if (got.worker.id !== tracker.workerId) fail("E_SCENARIO");
  const gotJob = readPrivateJob(context, tracker);
  validateIntermediateWorkerSnapshot(got.worker, tracker, gotJob);
  tracker.events.observe(got.worker.lifecycleEvents);
  assertPublicPrivateBinding(got.worker, gotJob);

  enterScenarioStage(tracker, "events");
  const events = await callTool(
    context,
    client,
    "worker_events_after",
    { id: tracker.workerId },
    ["stream"]
  );
  const cursor = observeStream(
    tracker.events,
    events.stream,
    tracker.workerId,
    { wait: false, cursor: null }
  );
  readPrivateJob(context, tracker);
  return { spawnArguments, spawn, cursor };
}

export function mailboxTurnMessage(label) {
  return [
    `Re-check tracked.txt for mailbox turn ${label}.`,
    "Do not edit files and do not invoke another agent.",
    "End this response with this exact final line:",
    "GROK_WORKER_REPORT: {\"outcome\":\"complete\",\"summary\":\"Installed Worker MCP fixture inspected.\",\"changedFiles\":[],\"checksClaimed\":[],\"acceptanceResults\":[{\"id\":\"AC-01\",\"status\":\"met\"},{\"id\":\"AC-02\",\"status\":\"met\"}],\"risks\":[],\"questions\":[]}"
  ].join(" ");
}

export async function waitForInstalledMailboxOpen(context, tracker) {
  const deadline = Date.now() + 120_000;
  while (Date.now() <= deadline) {
    checkInterrupted(context.runner);
    const waitingJob = readPrivateJob(context, tracker);
    let attempt = null;
    try {
      attempt = context.mailboxState.resolveOpenMailbox(
        context.fixtureRoot,
        tracker.workerId,
        context.env
      );
    } catch {
      attempt = null;
    }
    let decision;
    try {
      decision = decideInstalledWorkerMcpMailboxPoll({
        workerStatus: waitingJob.status,
        mailboxState: attempt?.state ?? null
      });
    } catch {
      fail("E_PRIVATE_STATE");
    }
    if (decision === "terminal-before-open") fail("E_PRIVATE_STATE");
    if (decision === "observe-live-provider") {
      const job = readPrivateJob(context, tracker, {
        requireLiveProvider: true,
        recordProviderObservation: false
      });
      const dispatch = job.request?.spawn?.dispatch;
      if (
        attempt.workerId !== tracker.workerId
        || attempt.dispatchAttemptId !== dispatch?.attemptId
        || attempt.dispatchFence !== dispatch?.fence
        || attempt.providerGeneration !== 1
        || attempt.workerProcessDigest
          !== context.mailboxState.stableDigest(job.workerProcess)
        || attempt.providerProcessDigest
          !== context.mailboxState.stableDigest(job.providerProcess)
        || attempt.providerSessionDigest
          !== context.mailboxState.stableDigest({
            providerSessionId: job.grokSessionId
          })
        || attempt.providerCapabilityDigest
          !== context.providerCapability.capabilityDigest
        || attempt.contextReceiptDigest
          !== context.mailboxState.stableDigest(job.request?.contextReceipt)
        || attempt.rolePolicyDigest !== job.request?.runtimeRolePolicy?.digest
      ) {
        fail("E_PRIVATE_STATE");
      }
      observePrivateJob(context, tracker, job, {
        requireLiveProvider: true,
        recordProviderObservation: true
      });
      tracker.mailboxAttemptId = attempt.dispatchAttemptId;
      return attempt;
    }
    await new Promise((resolve) => setTimeout(resolve, STATE_POLL_MS));
  }
  fail("E_PRIVATE_STATE");
}

export function snapshotInstalledMailboxProof(context, tracker, terminalJob) {
  const attemptId = tracker.mailboxAttemptId;
  if (typeof attemptId !== "string") fail("E_PRIVATE_STATE");
  const expectedFinalReportDigest =
    terminalJob.result?.workerReport?.reportSource === "acp-structured"
      ? terminalJob.result?.workerReport?.reportDigest
      : terminalJob.result?.textDigest;
  let attempt;
  let messages;
  try {
    attempt = context.mailboxState.readAttemptMailbox(
      context.fixtureRoot,
      tracker.workerId,
      attemptId,
      context.env
    );
    messages = context.mailboxState.listAttemptMessages(
      context.fixtureRoot,
      tracker.workerId,
      attemptId,
      context.env
    );
    context.mailboxState.assertNoRetainedBodies(
      context.fixtureRoot,
      tracker.workerId,
      attemptId,
      context.env
    );
  } catch {
    fail("E_PRIVATE_STATE");
  }
  if (
    !attempt
    || attempt.state !== "closed"
    || attempt.workerId !== tracker.workerId
    || attempt.providerGeneration !== 1
    || attempt.workerProcessDigest
      !== context.mailboxState.stableDigest(terminalJob.workerProcess)
    || attempt.providerProcessDigest
      !== context.mailboxState.stableDigest(terminalJob.providerProcess)
    || attempt.providerSessionDigest
      !== context.mailboxState.stableDigest({
        providerSessionId: tracker.sessionId
      })
    || attempt.providerCapabilityDigest
      !== context.providerCapability.capabilityDigest
    || attempt.acceptedCount !== 2
    || attempt.lastCompletedSequence !== 2
    || attempt.finalReportSequence !== 2
    || attempt.deliveryUnknownSequence !== null
    || attempt.activeSequence !== null
    || !Array.isArray(messages)
    || messages.length !== 2
    || !Array.isArray(tracker.mailboxPublicReceipts)
    || tracker.mailboxPublicReceipts.length !== 2
    || tracker.mailboxMessageCountAfterReplay !== 2
    || messages.some((message, index) => (
      message.sequence !== index + 1
      || message.state !== "delivered"
      || Object.hasOwn(message, "_privateBody")
      || message.turnEvidence?.outcome !== "delivered"
      || message.turnEvidence?.sequence !== index + 1
      || message.messageId
        !== tracker.mailboxPublicReceipts[index]?.messageId
      || message.sequence
        !== tracker.mailboxPublicReceipts[index]?.sequence
      || message.acceptedAt
        !== tracker.mailboxPublicReceipts[index]?.acceptedAt
    ))
    || terminalJob.result?.mailboxEvidence?.communicationChainDigest
      !== attempt.communicationChainDigest
    || terminalJob.result?.mailboxEvidence?.deliveryUnknown !== false
    || terminalJob.result?.mailboxEvidence?.closed !== true
    || terminalJob.result?.mailboxEvidence?.bodiesRetained !== false
    || terminalJob.result?.mailboxEvidence?.selectedSequence !== 2
    || terminalJob.result?.mailboxEvidence?.lastCompletedSequence !== 2
    || terminalJob.result?.mailboxEvidence?.finalReportSequence !== 2
    || terminalJob.result?.mailboxEvidence?.finalReportDigest
      !== attempt.finalReportDigest
    || attempt.finalReportDigest !== expectedFinalReportDigest
  ) {
    fail("E_PRIVATE_STATE");
  }
  tracker.mailboxMessageBindings = messages.map((message) => Object.freeze({
    messageId: message.messageId,
    sequence: message.sequence,
    acceptedAt: message.acceptedAt
  }));

  let previousDigest;
  try {
    previousDigest = context.mailboxState.genesisCommunicationChainDigest(attempt);
    const primary = context.mailboxState.verifyChainExtension({
      ...attempt,
      communicationChainDigest: previousDigest
    }, attempt.primaryTurnEvidence);
    previousDigest = primary.turnDigest;
    for (const message of messages) {
      const turn = context.mailboxState.verifyChainExtension({
        ...attempt,
        communicationChainDigest: previousDigest
      }, message.turnEvidence);
      previousDigest = turn.turnDigest;
    }
  } catch {
    fail("E_PRIVATE_STATE");
  }
  if (previousDigest !== attempt.communicationChainDigest) {
    fail("E_PRIVATE_STATE");
  }

  const allTurns = [attempt.primaryTurnEvidence, ...messages.map(
    (message) => message.turnEvidence
  )];
  const providerGenerationCount = new Set(
    allTurns.map((turn) => turn.providerGeneration)
  ).size;
  const providerSessionCount = new Set(
    allTurns.map((turn) => turn.providerSessionDigest)
  ).size;
  const deliveredCount = messages.filter(
    (message) => message.state === "delivered"
  ).length;
  const deliveryUnknownCount = messages.filter(
    (message) => message.state === "delivery_unknown"
  ).length;
  const rejectedCount = messages.filter(
    (message) => message.state === "rejected"
  ).length;
  const retainedBodyCount = messages.filter(
    (message) => Object.hasOwn(message, "_privateBody")
  ).length;
  const observation = Object.freeze({
    providerGenerationCount,
    providerSessionCount,
    promptCount: allTurns.length,
    sendInvocationCount: tracker.calls.send + tracker.calls.sendReplay,
    sendReplayCount: tracker.calls.sendReplay,
    acceptedCount: attempt.acceptedCount,
    deliveredCount,
    deliveryUnknownCount,
    rejectedCount,
    finalReportSequence: attempt.finalReportSequence,
    replayPromptDelta: messages.length - tracker.mailboxMessageCountAfterReplay,
    retainedBodyCount,
    closed: attempt.state === "closed"
  });
  if (!sameJson(observation, {
    providerGenerationCount: 1,
    providerSessionCount: 1,
    promptCount: 3,
    sendInvocationCount: 3,
    sendReplayCount: 1,
    acceptedCount: 2,
    deliveredCount: 2,
    deliveryUnknownCount: 0,
    rejectedCount: 0,
    finalReportSequence: 2,
    replayPromptDelta: 0,
    retainedBodyCount: 0,
    closed: true
  })) {
    fail("E_PRIVATE_STATE");
  }
  tracker.mailboxObservation = observation;
  return observation;
}

export async function runCompletionScenario(baseContext, fixtureRoot) {
  const context = { ...baseContext, fixtureRoot };
  const fixtureStatus = initializeFixtureRepository(
    fixtureRoot,
    context.env
  );
  const tracker = createTracker("authenticated-completion", fixtureStatus);
  context.runner.trackers.push({ context, tracker });
  enterQualificationStage("completion-mcp-surface");
  let client = await startInstalledMcp(context);
  await verifyMcpSurface(context, client, { negative: true });
  enterQualificationStage("completion-spawn");
  // Immediate ordered mailbox sends already exercise the active primary-turn
  // window. Keep the provider task minimal so fixture work cannot become the
  // lifecycle gate that this scenario is meant to measure.
  const started = await beginScenario(
    context,
    tracker,
    client,
    `installed-completion-${crypto.randomUUID()}`,
    "authenticated completion"
  );
  enterQualificationStage("completion-mailbox-open");
  await waitForInstalledMailboxOpen(context, tracker);
  const firstSendArguments = {
    id: tracker.workerId,
    message: mailboxTurnMessage("one"),
    idempotencyKey: `installed-mailbox-one-${crypto.randomUUID()}`
  };
  enterQualificationStage("completion-send-first");
  const firstSend = await callTool(
    context,
    client,
    "worker_send",
    firstSendArguments,
    ["message", "replayed"]
  );
  tracker.calls.send += 1;
  enterQualificationStage("completion-send-second");
  const secondSend = await callTool(
    context,
    client,
    "worker_send",
    {
      id: tracker.workerId,
      message: mailboxTurnMessage("two"),
      idempotencyKey: `installed-mailbox-two-${crypto.randomUUID()}`
    },
    ["message", "replayed"]
  );
  tracker.calls.send += 1;
  enterQualificationStage("completion-send-replay");
  const sendReplay = await callTool(
    context,
    client,
    "worker_send",
    firstSendArguments,
    ["message", "replayed"]
  );
  tracker.calls.sendReplay += 1;
  tracker.mailboxPublicReceipts = [
    structuredClone(firstSend.message),
    structuredClone(secondSend.message)
  ];
  let afterReplayMessages;
  try {
    afterReplayMessages = context.mailboxState.listAttemptMessages(
      context.fixtureRoot,
      tracker.workerId,
      tracker.mailboxAttemptId,
      context.env
    );
  } catch {
    fail("E_PRIVATE_STATE");
  }
  tracker.mailboxMessageCountAfterReplay = afterReplayMessages.length;
  enterQualificationStage("completion-wait");
  const terminalWaitCursor = await waitForTerminal(
    context,
    client,
    tracker,
    started.cursor
  );
  enterQualificationStage("completion-cleanup-private");
  const terminalJob = await proveTerminalCleanup(context, tracker, "completed");
  enterQualificationStage("completion-terminal-drain");
  const terminalStreamCursor = await drainTerminalEventStream(
    context,
    client,
    tracker,
    terminalWaitCursor,
    terminalJob
  );
  enterQualificationStage("completion-result");
  const result = await callTool(
    context,
    client,
    "worker_result",
    { id: tracker.workerId },
    ["worker"]
  );
  tracker.calls.result += 1;
  observeTerminalResultWorker(
    tracker,
    result.worker,
    terminalStreamCursor
  );
  await closeMcp(context, client);
  client = null;

  enterQualificationStage("completion-cleanup-snapshot");
  validateTerminalWorkerSnapshot(
    result.worker,
    tracker,
    terminalJob,
    "completed"
  );
  enterQualificationStage("completion-cleanup-events");
  assertTerminalEventHistory(
    context,
    tracker,
    result.worker,
    terminalJob,
    "completed"
  );
  enterQualificationStage("completion-cleanup-binding");
  assertPublicPrivateBinding(result.worker, terminalJob);
  enterQualificationStage("completion-cleanup-identity");
  recordPrivateIdentityObservation(
    context,
    tracker,
    terminalJob,
    result.worker,
    { terminal: true }
  );
  enterQualificationStage("completion-cleanup-report");
  if (
    terminalJob.result?.workerReport?.valid !== true
    || terminalJob.result?.workerReport?.outcome !== "complete"
    || terminalJob.result?.reportRepair != null
  ) {
    fail("E_SCENARIO");
  }
  enterQualificationStage("completion-mailbox-proof");
  snapshotInstalledMailboxProof(context, tracker, terminalJob);
  enterQualificationStage("completion-session-id");
  if (!tracker.sessionId) fail("E_SESSION");
  await deleteAndProveSessionAbsent(context, tracker);

  const publicEvidence = {
    spawn: started.spawn,
    firstSend,
    secondSend,
    sendReplay,
    terminalResult: result
  };
  enterQualificationStage("completion-contract");
  validateInstalledCompletionScenario(publicEvidence);
  return { context, tracker, publicEvidence };
}
