// Installed Worker MCP qualification domain. Keep import-time behavior inert.
import { validateInstalledCancellationReplayScenario } from "./installed-worker-mcp-contract.mjs";
import { ACTIVE_WINDOW_WORKLOAD_FILES, CANONICAL_UUID, canonicalDigest, canonicalJson, enterQualificationStage, fail, hasExactKeys, isPlainRecord, MAX_COMMAND_OUTPUT_BYTES, safeParseJson, sameJson, STATE_POLL_MS } from "./installed-worker-mcp-runner-core.mjs";
import { assertPublicPrivateBinding, assertTerminalEventHistory, createTracker, drainTerminalEventStream, observePrivateJob, observePublicWorker, observeTerminalResultWorker, pollPrivateJob, readPrivateJob, recordPrivateIdentityObservation, validateTerminalWorkerSnapshot, waitForTerminal } from "./installed-worker-mcp-runner-observation.mjs";
import { callTool, closeMcp, initializeFixtureRepository, startInstalledMcp, verifyMcpSurface } from "./installed-worker-mcp-runner-runtime.mjs";
import { beginScenario, bindSessionBoundary, deleteAndProveSessionAbsent, exactPrivateAuthFile, proveSessionAbsentWithCredential, proveTerminalCleanup, refreshSessionCredentialHandle, runSessionCredentialTransaction, waitForSessionPresence } from "./installed-worker-mcp-runner-session-read.mjs";
import { cleanupSetupBoundary } from "./installed-worker-mcp-runner-setup.mjs";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
export async function runCancellationScenario(baseContext, fixtureRoot) {
  const context = { ...baseContext, fixtureRoot };
  const fixtureStatus = initializeFixtureRepository(
    fixtureRoot,
    context.env,
    { workloadFiles: ACTIVE_WINDOW_WORKLOAD_FILES }
  );
  const tracker = createTracker("mcp-restart-reconnect-cancellation", fixtureStatus);
  context.runner.trackers.push({ context, tracker });
  enterQualificationStage("cancellation-mcp-surface");
  let client = await startInstalledMcp(context);
  await verifyMcpSurface(context, client);
  enterQualificationStage("cancellation-spawn");
  const started = await beginScenario(
    context,
    tracker,
    client,
    `installed-cancel-spawn-${crypto.randomUUID()}`,
    "restart and cancellation",
    { activeWindow: true }
  );
  enterQualificationStage("cancellation-live-provider");
  await pollPrivateJob(
    context,
    tracker,
    (job) => (
      CANONICAL_UUID.test(job?.grokSessionId || "")
      && job?.providerProcess?.providerGeneration === 1
      && job?.controllerProcess?.pid > 0
      && job?.workerProcess?.pid > 0
    ),
    {
      timeoutMs: 120_000,
      requireLiveProvider: true,
      recordProviderObservation: true
    }
  );
  enterQualificationStage("cancellation-session-id");
  if (!tracker.sessionId) fail("E_SESSION");
  await waitForSessionPresence(context, tracker);

  enterQualificationStage("cancellation-reconnect");
  await closeMcp(context, client);
  tracker.calls.reconnect += 1;
  client = await startInstalledMcp(context);
  await verifyMcpSurface(context, client);
  enterQualificationStage("cancellation-replay");
  const replay = await callTool(
    context,
    client,
    "worker_spawn",
    started.spawnArguments,
    [
      "worker",
      "replayed",
      "spawnSuccessDefinition",
      "providerLaunchState",
      "providerLaunched"
    ]
  );
  tracker.calls.spawnReplay += 1;
  observePublicWorker(tracker, replay.worker);
  const replayJob = readPrivateJob(context, tracker, {
    requireLiveProvider: true,
    recordProviderObservation: true
  });
  assertPublicPrivateBinding(replay.worker, replayJob);
  recordPrivateIdentityObservation(
    context,
    tracker,
    replayJob,
    replay.worker,
    {
      spawnKey: tracker.spawnIdempotencyKey,
      replayed: true
    }
  );
  if (
    replay.worker.id !== tracker.workerId
    || replayJob.request?.spawn?.dispatch?.providerGeneration !== 1
  ) {
    fail("E_SCENARIO");
  }

  enterQualificationStage("cancellation-request");
  const cancelKey = `installed-cancel-request-${crypto.randomUUID()}`;
  tracker.cancelIdempotencyKey = cancelKey;
  const cancel = await callTool(
    context,
    client,
    "worker_cancel",
    { id: tracker.workerId, idempotencyKey: cancelKey },
    ["receipt", "replayed"]
  );
  tracker.calls.cancel += 1;
  tracker.observedCancellationReceiptIds.push(cancel.receipt?.receiptId);
  const cancelReplay = await callTool(
    context,
    client,
    "worker_cancel",
    { id: tracker.workerId, idempotencyKey: cancelKey },
    ["receipt", "replayed"]
  );
  tracker.calls.cancelReplay += 1;
  tracker.observedCancellationReceiptIds.push(cancelReplay.receipt?.receiptId);
  if (
    !sameJson(cancel.receipt, cancelReplay.receipt)
    || cancel.replayed !== false
    || cancelReplay.replayed !== true
    || cancel.receipt?.idempotencyKeyDigest
      !== crypto.createHash("sha256").update(cancelKey).digest("hex")
  ) {
    fail("E_SCENARIO");
  }

  enterQualificationStage("cancellation-wait");
  const terminalWaitCursor = await waitForTerminal(
    context,
    client,
    tracker,
    started.cursor
  );
  enterQualificationStage("cancellation-cleanup-private");
  const terminalJob = await proveTerminalCleanup(context, tracker, "cancelled");
  enterQualificationStage("cancellation-terminal-drain");
  const terminalStreamCursor = await drainTerminalEventStream(
    context,
    client,
    tracker,
    terminalWaitCursor,
    terminalJob
  );
  enterQualificationStage("cancellation-result");
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

  enterQualificationStage("cancellation-cleanup-snapshot");
  validateTerminalWorkerSnapshot(
    result.worker,
    tracker,
    terminalJob,
    "cancelled"
  );
  enterQualificationStage("cancellation-cleanup-events");
  assertTerminalEventHistory(
    context,
    tracker,
    result.worker,
    terminalJob,
    "cancelled"
  );
  enterQualificationStage("cancellation-cleanup-binding");
  assertPublicPrivateBinding(result.worker, terminalJob);
  enterQualificationStage("cancellation-cleanup-identity");
  recordPrivateIdentityObservation(
    context,
    tracker,
    terminalJob,
    result.worker,
    { terminal: true }
  );
  enterQualificationStage("cancellation-cleanup-report");
  const cancellationEvents = (terminalJob.lifecycleEvents || [])
    .filter((event) => event?.type === "cancellation.requested");
  if (
    terminalJob.result?.stopReason !== "cancelled"
    || cancellationEvents.length !== 1
    || terminalJob.request?.spawn?.dispatch?.providerGeneration !== 1
  ) {
    fail("E_SCENARIO");
  }
  await deleteAndProveSessionAbsent(context, tracker);

  const publicEvidence = {
    spawn: started.spawn,
    spawnReplay: replay,
    cancel,
    cancelReplay,
    terminalResult: result
  };
  enterQualificationStage("cancellation-contract");
  validateInstalledCancellationReplayScenario(publicEvidence);
  return { context, tracker, publicEvidence };
}

export function privateObservationFor(tracker, temporaryRemoved) {
  const generationCount = tracker.scenarioId === "authenticated-completion" ? 1 : 2;
  const evidenceCount = tracker.scenarioId === "authenticated-completion" ? 2 : 3;
  const witnessCount = tracker.scenarioId === "authenticated-completion" ? 1 : 2;
  if (
    tracker.observedProviderGenerations.length < generationCount
    || tracker.observedProviderWorkerIds.length
      !== tracker.observedProviderGenerations.length
    || tracker.observedPublicWorkerDigests.length !== evidenceCount
    || tracker.observedPublicWorkerDigests.some(
      (digest) => !/^[0-9a-f]{64}$/.test(digest)
    )
    || tracker.observedSpawnResponseWitnesses.length !== witnessCount
    || (
      tracker.scenarioId === "authenticated-completion"
      && (
        !Array.isArray(tracker.mailboxMessageBindings)
        || tracker.mailboxMessageBindings.length !== 2
      )
    )
  ) {
    fail("E_PRIVATE_STATE");
  }
  const providerIdentity = tracker.processIdentities.get("provider");
  const providerLaunchCount = tracker.providerStartEvidence.size;
  const providerTerminalCount = providerIdentity
    && tracker.context.processControl.processGroupGone(providerIdentity) ? 1 : 0;
  return {
    scenarioId: tracker.scenarioId,
    observedPublicWorkerDigests: [
      ...tracker.observedPublicWorkerDigests
    ],
    observedSpawnResponseWitnesses: tracker.observedSpawnResponseWitnesses
      .map((witness) => structuredClone(witness)),
    installedWorkerBinding: {
      workerId: tracker.privateBinding?.workerId,
      createdAt: tracker.privateBinding?.createdAt,
      model: tracker.privateBinding?.model,
      effort: tracker.privateBinding?.effort,
      securityProfile: structuredClone(
        tracker.privateBinding?.securityProfile
      ),
      taskEnvelopeId: tracker.privateBinding?.taskEnvelopeId,
      taskEnvelopeDigest: tracker.privateBinding?.taskEnvelopeDigest,
      contextManifestId: tracker.privateBinding?.contextManifestId,
      contextDigest: tracker.privateBinding?.contextDigest,
      workspaceSnapshotDigest: tracker.privateBinding?.workspaceSnapshotDigest,
      controlWorkspaceId: tracker.privateBinding?.controlWorkspaceId,
      hostTaskBinding: tracker.privateBinding?.hostTaskBinding
    },
    observedWorkerIds: [...tracker.observedWorkerIds],
    observedTaskEnvelopeIds: [...tracker.observedTaskEnvelopeIds],
    observedContextManifestIds: [...tracker.observedContextManifestIds],
    observedProviderGenerations: [...tracker.observedProviderGenerations],
    observedProviderWorkerIds: [...tracker.observedProviderWorkerIds],
    observedCancellationReceiptIds: [...tracker.observedCancellationReceiptIds],
    spawnInvocationCount: tracker.calls.spawn + tracker.calls.spawnReplay,
    spawnReplayCount: tracker.calls.spawnReplay,
    providerLaunchCount,
    providerTerminalCount,
    workerTerminalCount: tracker.latestJob
      && ["completed", "cancelled"].includes(tracker.latestJob.status) ? 1 : 0,
    resultReadCount: tracker.calls.result,
    reconnectCount: tracker.calls.reconnect,
    cancelInvocationCount: tracker.calls.cancel + tracker.calls.cancelReplay,
    cancelReplayCount: tracker.calls.cancelReplay,
    uniqueCancelRequestCount: tracker.calls.cancel > 0 ? 1 : 0,
    cancellationEventCount: (tracker.latestJob?.lifecycleEvents || [])
      .filter((event) => event?.type === "cancellation.requested").length,
    duplicateLaunchCount: Math.max(0, providerLaunchCount - 1),
    mailboxMessageBindings: tracker.scenarioId === "authenticated-completion"
      ? tracker.mailboxMessageBindings.map((binding) => structuredClone(binding))
      : null,
    mailbox: tracker.scenarioId === "authenticated-completion"
      ? structuredClone(tracker.mailboxObservation)
      : null,
    workerHostVerification: "not_run",
    processGroupGone: Boolean(tracker.context)
      && [...tracker.processIdentities.values()]
        .every((identity) => tracker.context.processControl.processGroupGone(identity)),
    taskRuntimeCleaned: tracker.latestJob?.result?.taskRuntimeCleaned === true,
    providerGuardAbsent: tracker.providerGuardAbsent,
    runnerTemporaryArtifactsRemoved: temporaryRemoved,
    qualificationSessionDeleted: tracker.sessionDeleted
  };
}

export async function terminateTrackedClients(runner) {
  let ok = true;
  for (const client of [...runner.clients]) {
    try {
      await client.terminate();
    } catch {
      ok = false;
    } finally {
      runner.clients.delete(client);
    }
  }
  return ok;
}

export function writeEmergencyValidationMode(job) {
  const spawn = job?.request?.spawn || {};
  if (!Object.hasOwn(spawn, "dispatch")) return "pre-dispatch";
  return spawn.dispatch?.schemaVersion === 2 ? "dispatch" : "invalid";
}

export function writeEmergencyRequiredKinds(job) {
  const spawn = job?.request?.spawn || {};
  return [...new Set([
    ["controller", job?.controllerProcess],
    ["controller", spawn.controllerCleanupProcess],
    ["worker", job?.workerProcess],
    ["worker", spawn.unsettledWorkerProcess],
    ["provider", job?.providerProcess]
  ]
    .filter(([, identity]) => identity?.startToken != null)
    .map(([kind]) => kind))];
}

export function emergencySessionAction({
  deletionAcknowledged,
  observedPresent
}) {
  if (deletionAcknowledged === true) return "prove-absent";
  return observedPresent === false ? "adopt-absence" : "delete";
}

export function emergencyCleanupSucceeded({
  clean,
  sessionCount,
  temporaryRootExists
}) {
  return clean === true
    && sessionCount === 0
    && temporaryRootExists === false;
}

export function durableSessionDeletionAcknowledged(context, tracker) {
  let jobFile;
  try {
    jobFile = context.state.jobFileIfPresent(
      context.fixtureRoot,
      tracker.workerId,
      context.env
    );
  } catch {
    fail("E_CLEANUP");
  }
  if (!jobFile) return false;
  const registryFile = path.join(
    path.dirname(path.dirname(jobFile)),
    "owner-lifecycle",
    "registry.json"
  );
  let stat;
  try {
    stat = fs.lstatSync(registryFile);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    fail("E_CLEANUP");
  }
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.size < 2
    || stat.size > 2 * 1024 * 1024
    || (stat.mode & 0o077) !== 0
  ) {
    fail("E_CLEANUP");
  }
  const registry = safeParseJson(
    fs.readFileSync(registryFile, "utf8"),
    "E_CLEANUP"
  );
  const {
    registryDigest,
    ...registryBody
  } = registry || {};
  if (
    !hasExactKeys(registry, new Set([
      "schemaVersion",
      "records",
      "keys",
      "registryDigest"
    ]))
    || registry.schemaVersion !== 1
    || !isPlainRecord(registry.records)
    || !isPlainRecord(registry.keys)
    || registryDigest !== canonicalDigest(registryBody)
  ) {
    fail("E_CLEANUP");
  }
  const record = registry.records[tracker.workerId];
  if (!record) return false;
  const { recordDigest, ...recordBody } = record;
  const cleanup = record.cleanup;
  if (
    record.workerId !== tracker.workerId
    || record.controlWorkspaceId
      !== tracker.latestJob?.controlWorkspaceId
    || record.executionBindingDigest
      !== tracker.latestJob?.executionBinding?.bindingDigest
    || record.providerSessionId !== tracker.sessionId
    || recordDigest !== canonicalDigest(recordBody)
  ) {
    fail("E_CLEANUP");
  }
  if (cleanup === null) return false;
  if (
    !isPlainRecord(cleanup)
    || !Number.isSafeInteger(cleanup.sessionDeleteAttempts)
    || cleanup.sessionDeleteAttempts < 0
    || cleanup.sessionDeleteAttempts > 2
    || (
      cleanup.sessionDeletionDigest !== null
      && !/^[a-f0-9]{64}$/.test(cleanup.sessionDeletionDigest || "")
    )
    || (
      cleanup.receipt != null
      && cleanup.receipt.sessionDeletionDigest
        !== cleanup.sessionDeletionDigest
    )
  ) {
    fail("E_CLEANUP");
  }
  return /^[a-f0-9]{64}$/.test(cleanup.sessionDeletionDigest || "");
}

async function scanExactWorkerBoundaryClosure(options) {
  const {
    context, tracker, write, owned, unsettled, collectLatest,
    discoverDetachedWorkerProcesses, collectAuthenticatedGuard,
    terminateCollected, getLatest
  } = options;
  let clean = true;
  let stableClosureScans = 0;
  let previousClosureSignature = null;
  let provisioningGroupGone = true;
  let unsettledGroupsGone = true;
  for (let pass = 0; pass < 20; pass += 1) {
    collectLatest();
    discoverDetachedWorkerProcesses();
    collectAuthenticatedGuard();
    await terminateCollected();
    collectLatest();
    discoverDetachedWorkerProcesses();
    let authenticated = collectAuthenticatedGuard();
    await terminateCollected();

    const producerGroupsGone = [...owned.values()]
      .filter(({ kind }) => kind === "controller" || kind === "worker")
      .every(({ identity }) => (
        context.processControl.processGroupGone(identity)
      ));
    const allGroupsGone = [...owned.values()].every(({ identity }) => (
      context.processControl.processGroupGone(identity)
    ));
    try {
      unsettledGroupsGone = [...unsettled.values()].every(
        ({ identity }) => context.processControl.processGroupGone(identity)
      );
    } catch {
      unsettledGroupsGone = false;
      clean = false;
    }
    const provisioningProcess = (
      write
      && tracker.emergencyWriteValidationMode === "pre-dispatch"
    )
      ? tracker.emergencyWriteVerification
          ?.provisioningRuntime
          ?.intent
          ?.processIdentity
      : null;
    try {
      provisioningGroupGone = !provisioningProcess
        || context.processControl.processGroupGone(provisioningProcess);
    } catch {
      provisioningGroupGone = false;
      clean = false;
    }
    if (
      authenticated
      && producerGroupsGone
      && allGroupsGone
      && provisioningGroupGone
    ) {
      try {
        const current = context.guard.loadProviderGuard(
          context.fixtureRoot,
          tracker.workerId
        );
        if (!current || !sameJson(current, authenticated)) {
          clean = false;
        } else {
          context.guard.unregisterProviderGuard(
            context.fixtureRoot,
            tracker.workerId,
            authenticated,
            context.env
          );
          authenticated = null;
        }
      } catch {
        clean = false;
      }
    }
    let residualGuard = null;
    try {
      residualGuard = context.guard.loadProviderGuard(
        context.fixtureRoot,
        tracker.workerId
      );
    } catch {
      clean = false;
    }
    const latest = getLatest();
    const closureSignature = JSON.stringify(canonicalJson({
      jobProcesses: {
        controller: latest?.controllerProcess || null,
        worker: latest?.workerProcess || null,
        provider: latest?.providerProcess || null
      },
      sessionId: latest?.grokSessionId || null,
      provisioningProcess,
      provisioningGroupGone,
      unsettled: [...unsettled.values()]
        .map(({ kind, identity }) => ({ kind, identity }))
        .sort((left, right) => (
          JSON.stringify(left).localeCompare(JSON.stringify(right))
        )),
      unsettledGroupsGone,
      residualGuard,
      owned: [...owned.values()]
        .map(({ kind, identity }) => ({ kind, identity }))
        .sort((left, right) => (
          JSON.stringify(left).localeCompare(JSON.stringify(right))
        ))
    }));
    if (
      producerGroupsGone
      && allGroupsGone
      && unsettledGroupsGone
      && provisioningGroupGone
      && residualGuard === null
    ) {
      stableClosureScans = closureSignature === previousClosureSignature
        ? stableClosureScans + 1
        : 1;
    } else {
      stableClosureScans = 0;
    }
    previousClosureSignature = closureSignature;
    if (stableClosureScans >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, STATE_POLL_MS));
  }
  return {
    clean,
    stableClosureScans,
    provisioningGroupGone,
    unsettledGroupsGone
  };
}

function finalizeExactWorkerBoundaryClosure(options) {
  const {
    context, tracker, write, latest, owned, unsettled, closure
  } = options;
  const {
    stableClosureScans,
    provisioningGroupGone,
    unsettledGroupsGone
  } = closure;
  let clean = closure.clean;
  if (
    stableClosureScans < 2
    || !unsettledGroupsGone
    || !provisioningGroupGone
    || [...owned.values()].some(
      ({ identity }) => !context.processControl.processGroupGone(identity)
    )
  ) {
    clean = false;
  }
  const observedKinds = new Set(
    [...owned.values()].map(({ kind }) => kind)
  );
  const requiredKinds = write
    ? (
        tracker.emergencyWriteValidationMode === "pre-dispatch"
          ? []
          : writeEmergencyRequiredKinds(latest)
      )
    : ["controller", "worker", "provider"];
  tracker.emergencySessionCleanupReady = (
    stableClosureScans >= 2
    && requiredKinds.every((kind) => observedKinds.has(kind))
    && [...unsettled.values()].every(
      ({ identity }) => context.processControl.processGroupGone(identity)
    )
    && [...owned.values()].every(
      ({ identity }) => context.processControl.processGroupGone(identity)
    )
  );
  tracker.emergencyLatestJob = latest;
  return clean;
}

export async function cleanupExactWorkerBoundary(
  runner,
  context,
  tracker,
  { write = false } = {}
) {
  let clean = true;
  let latest = null;
  const owned = new Map();
  const unsettled = new Map();
  const addOwned = (
    kind,
    identity,
    { durableProvisioningGuard = false } = {}
  ) => {
    if (!identity) return;
    try {
      context.processControl.assertCompleteDetachedOwnedIdentity(identity);
      if (
        identity.commandMarker !== tracker.workerId
        && !durableProvisioningGuard
      ) {
        clean = false;
        return;
      }
      owned.set(`${kind}:${identity.pid}:${identity.startToken}`, {
        kind,
        identity: structuredClone(identity)
      });
    } catch {
      clean = false;
    }
  };
  for (const [kind, identity] of tracker.processIdentities) {
    addOwned(kind, identity);
  }
  const addDurableDispatchWitness = (kind, identity) => {
    if (!identity) return;
    if (identity.startToken !== null) {
      addOwned(kind, identity);
      return;
    }
    unsettled.set(`${kind}:${identity.pid}:${identity.processGroupId}`, {
      kind,
      identity: structuredClone(identity)
    });
  };

  const bindObservedWriteSession = () => {
    if (!write || latest?.grokSessionId == null) return;
    if (
      !CANONICAL_UUID.test(latest.grokSessionId)
      || latest.request?.providerHomeId !== tracker.workerId
      || (
        tracker.sessionId
        && tracker.sessionId !== latest.grokSessionId
      )
    ) {
      clean = false;
      return;
    }
    tracker.sessionId = latest.grokSessionId;
    tracker.latestJob = latest;
    tracker.privateBinding ||= {
      lineageWorkerId: latest.request.providerHomeId
    };
    if (
      tracker.privateBinding.lineageWorkerId
        !== latest.request.providerHomeId
    ) {
      clean = false;
      return;
    }
    if (!runner.sessions.has(tracker.sessionId)) {
      runner.sessions.set(tracker.sessionId, null);
    }
    try {
      bindSessionBoundary(context, tracker);
      if (
        tracker.sessionDeleteAcknowledged !== true
        && durableSessionDeletionAcknowledged(context, tracker)
      ) {
        tracker.sessionDeleteAcknowledged = true;
      }
    } catch {
      clean = false;
    }
  };

  const collectLatest = () => {
    try {
      latest = context.state.tryReadJob(
        context.fixtureRoot,
        tracker.workerId,
        context.env
      );
    } catch {
      clean = false;
      return;
    }
    if (!latest) return;
    if (write) {
      const validationMode = writeEmergencyValidationMode(latest);
      let writeVerification;
      try {
        if (validationMode === "invalid") fail("E_CLEANUP");
        writeVerification = (
          validationMode === "dispatch"
            ? context.mutation.assertDispatchContract(latest)
            : context.mutation.assertWriteExecutionJob(
                latest,
                context.env
              )
        );
      } catch {
        latest = null;
        clean = false;
        return;
      }
      if (
        latest.id !== tracker.workerId
        || latest.write !== true
        || latest.host?.kind !== "codex"
        || latest.host?.sessionId !== context.threadId
        || latest.request?.spawn?.ownerThreadId !== context.threadId
      ) {
        latest = null;
        clean = false;
        return;
      }
      tracker.emergencyWriteValidationMode = validationMode;
      tracker.emergencyWriteVerification = writeVerification;
      tracker.latestJob = latest;
      bindObservedWriteSession();
    } else {
      try {
        latest = observePrivateJob(context, tracker, latest);
      } catch {
        latest = null;
        clean = false;
        return;
      }
    }
    for (const [kind, identity] of [
      ["controller", latest.controllerProcess],
      ["controller", latest.request?.spawn?.controllerCleanupProcess],
      ["worker", latest.workerProcess],
      ["worker", latest.request?.spawn?.unsettledWorkerProcess],
      ["provider", latest.providerProcess]
    ]) {
      addDurableDispatchWitness(kind, identity);
    }
    const admissions = latest.request?.spawn?.primaryTurnAdmissions;
    if (admissions != null && !isPlainRecord(admissions)) {
      clean = false;
      return;
    }
    for (const admission of Object.values(admissions || {})) {
      addOwned("worker", admission?.workerProcess);
      addOwned("provider", admission?.providerProcess);
    }
  };

  const discoverDetachedWorkerProcesses = () => {
    let listed;
    try {
      listed = context.processControl.runSystemPs([
        "-axo",
        "pid=,command="
      ]);
    } catch {
      clean = false;
      return;
    }
    if (
      listed?.status !== 0
      || listed?.signal
      || listed?.error
      || Buffer.byteLength(String(listed.stdout || ""), "utf8")
        > MAX_COMMAND_OUTPUT_BYTES
    ) {
      clean = false;
      return;
    }
    for (const line of String(listed.stdout || "").split("\n")) {
      const match = line.match(/^\s*(\d+)\s+([\s\S]+)$/);
      if (!match || !match[2].includes(tracker.workerId)) continue;
      const pid = Number(match[1]);
      const startToken = context.processControl.processStartToken(pid);
      if (!startToken) {
        clean = false;
        continue;
      }
      const identity = { pid, startToken, processGroupId: pid };
      let kind = null;
      try {
        context.processControl.assertCompleteDetachedOwnedIdentity(identity);
        for (const candidate of [
          "controller",
          "worker",
          "provider-bootstrap",
          "provider"
        ]) {
          if (
            context.processControl.identityMatches(
              identity,
              tracker.workerId,
              candidate
            )
          ) {
            kind = candidate;
            break;
          }
        }
      } catch {
        clean = false;
        continue;
      }
      if (!kind) {
        clean = false;
        continue;
      }
      addOwned(kind, identity);
    }
  };

  const collectAuthenticatedGuard = () => {
    let record;
    try {
      record = context.guard.loadProviderGuard(
        context.fixtureRoot,
        tracker.workerId
      );
    } catch {
      clean = false;
      return null;
    }
    if (!record) return null;
    if (!latest) {
      clean = false;
      return null;
    }
    let authenticated;
    try {
      authenticated = (
        write
        && tracker.emergencyWriteValidationMode === "pre-dispatch"
      )
        ? context.guard.assertWorktreeProvisioningGuardForJob(
            context.fixtureRoot,
            latest,
            record,
            { env: context.env }
          )
        : context.guard.assertProviderGuardForJob(
            context.fixtureRoot,
            latest,
            record,
            { expectedGeneration: record.providerGeneration }
          );
      context.processControl.assertCompleteDetachedOwnedIdentity(
        authenticated.providerProcess
      );
    } catch {
      clean = false;
      return null;
    }
    if (
      tracker.authenticatedGuard
      && !sameJson(tracker.authenticatedGuard, authenticated)
    ) {
      clean = false;
      return null;
    }
    tracker.authenticatedGuard ||= structuredClone(authenticated);
    addOwned(
      "provider",
      authenticated.providerProcess,
      {
        durableProvisioningGuard: Boolean(
          write
          && tracker.emergencyWriteValidationMode === "pre-dispatch"
        )
      }
    );
    return authenticated;
  };

  const terminateCollected = async () => {
    for (const markerKind of [
      "controller",
      "worker",
      "provider-bootstrap",
      "provider"
    ]) {
      for (const ownedProcess of owned.values()) {
        if (ownedProcess.kind !== markerKind) continue;
        const { identity } = ownedProcess;
        try {
          if (!context.processControl.processGroupGone(identity)) {
            await context.processControl.terminateOwnedProcess(
              identity,
              tracker.workerId,
              markerKind
            );
          }
          if (!context.processControl.processGroupGone(identity)) clean = false;
        } catch {
          clean = false;
        }
      }
    }
  };

  const closure = await scanExactWorkerBoundaryClosure({
    context, tracker, write, owned, unsettled, collectLatest,
    discoverDetachedWorkerProcesses, collectAuthenticatedGuard,
    terminateCollected, getLatest: () => latest
  });
  const closureClean = finalizeExactWorkerBoundaryClosure({
    context, tracker, write, latest, owned, unsettled, closure
  });
  return clean && closureClean;
}

export function proveEmergencyWriteWorktreeAbsent(context, tracker) {
  const job = tracker.emergencyLatestJob;
  const baseCommit = job?.executionBinding?.baseCommit;
  if (
    !job
    || job.id !== tracker.workerId
    || job.write !== true
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseCommit || "")
  ) {
    return false;
  }
  let executionRoot;
  let effect;
  try {
    executionRoot = context.workerWorktree.expectedWorkerWorktreeRoot(
      context.fixtureRoot,
      tracker.workerId,
      context.env
    );
    if (job.executionBinding.expectedExecutionRoot !== executionRoot) {
      return false;
    }
    effect = context.workerWorktree.classifyWorkerWorktreeEffect({
      controlRoot: context.fixtureRoot,
      executionRoot,
      baseCommit,
      workerId: tracker.workerId,
      env: context.env
    });
    if (
      effect.classification === "exact-clean-registered"
      || effect.classification === "dirty"
    ) {
      context.workerWorktree.removeWorkerWorktree(
        executionRoot,
        context.fixtureRoot,
        tracker.workerId,
        context.env
      );
      effect = context.workerWorktree.classifyWorkerWorktreeEffect({
        controlRoot: context.fixtureRoot,
        executionRoot,
        baseCommit,
        workerId: tracker.workerId,
        env: context.env
      });
    }
  } catch {
    return false;
  }
  return (
    effect?.classification === "absent"
    && !fs.existsSync(executionRoot)
  );
}

export async function observeEmergencySessionAbsence(
  context,
  tracker,
  timeoutMs
) {
  let absent = false;
  await runSessionCredentialTransaction(context, tracker, {
    mode: "observe",
    provePresent: async (environment) => {
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
      if (observed.present === true) return true;
      if (observed.present !== false) fail("E_SESSION");
      await proveSessionAbsentWithCredential(
        context,
        tracker,
        environment,
        timeoutMs
      );
      absent = true;
      return true;
    }
  });
  return absent;
}

export async function deleteOrAdoptEmergencySessionAbsence(
  context,
  tracker
) {
  let action = emergencySessionAction({
    deletionAcknowledged: tracker.sessionDeleteAcknowledged,
    observedPresent: null
  });
  if (action !== "prove-absent") {
    const absent = await observeEmergencySessionAbsence(
      context,
      tracker,
      30_000
    );
    action = emergencySessionAction({
      deletionAcknowledged: false,
      observedPresent: !absent
    });
    if (action === "adopt-absence") {
      tracker.sessionDeleteAcknowledged = true;
      tracker.sessionDeleted = true;
      context.runner.sessions.delete(tracker.sessionId);
      return;
    }
  }
  await deleteAndProveSessionAbsent(context, tracker, {
    updateStage: false,
    timeoutMs: 30_000
  });
}

export async function emergencyCleanup(runner) {
  let clean = await terminateTrackedClients(runner);
  if (runner.temporaryRemoved === true) {
    return emergencyCleanupSucceeded({
      clean,
      sessionCount: runner.sessions.size,
      temporaryRootExists: false
    });
  }
  if (
    runner.setupBoundary
    && !await cleanupSetupBoundary(
      runner.setupBoundary,
      { terminate: true, requireObservation: false }
    )
  ) {
    clean = false;
  }
  const writeEmergencyEntries = [];
  if (runner.writeSmoke?.context) {
    const { context } = runner.writeSmoke;
    const workerIds = new Set([
      ...(Array.isArray(runner.writeSmoke.workerIds)
        ? runner.writeSmoke.workerIds
        : []),
      ...(typeof runner.writeSmoke.workerId === "string"
        ? [runner.writeSmoke.workerId]
        : [])
    ]);
    try {
      const candidates = context.state.listJobsReadonly(
        context.fixtureRoot,
        context.env
      ).filter((job) => (
        job?.write === true
        && job?.host?.kind === "codex"
        && job?.host?.sessionId === context.threadId
      ));
      for (const candidate of candidates) workerIds.add(candidate.id);
    } catch {
      clean = false;
    }
    runner.writeSmoke.workerIds = [...workerIds];
    for (const workerId of workerIds) {
      const tracker = {
        workerId,
        processIdentities: new Map(),
        authenticatedGuard: null,
        latestJob: null,
        privateBinding: null,
        sessionId: null,
        sessionBoundary: null,
        sessionDeleteAcknowledged: false,
        sessionDeleted: false,
        emergencySessionCleanupReady: false
      };
      writeEmergencyEntries.push({ context, tracker });
      if (!await cleanupExactWorkerBoundary(
        runner,
        context,
        tracker,
        { write: true }
      )) {
        clean = false;
      }
    }
    runner.writeSmoke.emergencyTrackers = writeEmergencyEntries.map(
      ({ tracker }) => tracker
    );
  }
  for (const entry of [...runner.trackers].reverse()) {
    const { context, tracker } = entry;
    if (typeof tracker.workerId !== "string") {
      try {
        const candidates = context.state.listJobsReadonly(
          context.fixtureRoot,
          context.env
        ).filter((job) => (
          job?.host?.kind === "codex"
          && job?.host?.sessionId === context.threadId
        ));
        if (candidates.length === 1) tracker.workerId = candidates[0].id;
        else if (candidates.length > 1) clean = false;
      } catch {
        clean = false;
      }
    }
    if (typeof tracker.workerId !== "string") continue;
    if (!await cleanupExactWorkerBoundary(
      runner,
      context,
      tracker
    )) {
      clean = false;
    }
  }
  const emergencyEntries = [...runner.trackers, ...writeEmergencyEntries];
  if (runner.provider && runner.providerBinary) {
    for (const [sessionId] of [...runner.sessions]) {
      const entry = emergencyEntries.find(
        ({ tracker }) => tracker.sessionId === sessionId
      );
      if (!entry || entry.tracker.emergencySessionCleanupReady !== true) {
        clean = false;
        continue;
      }
      const { context, tracker } = entry;
      try {
        await deleteOrAdoptEmergencySessionAbsence(
          context,
          tracker
        );
      } catch {
        clean = false;
      }
    }
  } else if (runner.sessions.size > 0) {
    clean = false;
  }
  for (const { context, tracker } of writeEmergencyEntries) {
    if (
      tracker.emergencySessionCleanupReady !== true
      || !proveEmergencyWriteWorktreeAbsent(
        context,
        tracker
      )
    ) {
      clean = false;
    }
  }
  if (runner.temporaryRoot && fs.existsSync(runner.temporaryRoot)) {
    if (clean) {
      try {
        fs.rmSync(runner.temporaryRoot, { recursive: true, force: true });
        if (!fs.existsSync(runner.temporaryRoot)) {
          runner.temporaryRemoved = true;
        } else {
          clean = false;
        }
      } catch {
        clean = false;
      }
    }
  }
  return emergencyCleanupSucceeded({
    clean,
    sessionCount: runner.sessions.size,
    temporaryRootExists: Boolean(
      runner.temporaryRoot
      && fs.existsSync(runner.temporaryRoot)
    )
  });
}
