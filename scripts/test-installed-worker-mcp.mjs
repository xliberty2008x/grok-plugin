#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  validateInstalledCancellationReplayScenario,
  validateInstalledScenarioEvidence,
  validateInstalledSetup,
  validateProviderCapabilityAgreement
} from "./lib/installed-worker-mcp-contract.mjs";
import {
  classifyInstalledWorkerMcpCleanupOutcome,
  formatInstalledWorkerMcpFailure,
  selectInstalledWorkerMcpFailure
} from "./lib/installed-worker-mcp-failure.mjs";
import { setupCleanupRequiresObservation } from "./lib/installed-worker-mcp-setup-boundary.mjs";
import {
  canonicalPath,
  createPluginInventory,
  describeInventoryDifference,
  digestInventory,
  digestRegularFile,
  isPathInside
} from "./lib/plugin-inventory.mjs";
import { ACTIVE_WINDOW_WORKLOAD_FILES, CANONICAL_UUID, EXPECTED_EXPERIMENTAL_CAPABILITIES, HELP, LIVE_GATES, MAX_COMMAND_OUTPUT_BYTES, MAX_RECEIPT_BYTES, MAX_TERMINAL_LIFECYCLE_EVENTS, PLUGIN_ID, PROTOCOL_VERSION, QUALIFICATION_STAGES, QualificationError, ROOT, SOURCE_PLUGIN, STATE_POLL_MS, TWO_WRITER_HELP, WRITE_SMOKE_HELP, canonicalDigest, canonicalJson, enterQualificationStage, fail, hasExactKeys, isPlainRecord, qualificationStage, runBounded, runJson, safeParseJson, sameJson } from "./lib/installed-worker-mcp-runner-core.mjs";
import { buildChildEnvironment, callTool, captureProviderFileIdentity, closeMcp, importInstalled, initializeFixtureRepository, mkdirPrivate, poisonChildProviderDiscovery, privateLiveFixtureBase, recheckProviderExecutablePin, startInstalledMcp, verifyMcpSurface } from "./lib/installed-worker-mcp-runner-runtime.mjs";
import { cleanupSetupBoundary, createSetupBoundary, runSetupJson } from "./lib/installed-worker-mcp-runner-setup.mjs";
import { assertProviderPinPersistence, assertPublicPrivateBinding, assertTerminalEventHistory, createTracker, drainTerminalEventStream, observePrivateJob, observePublicWorker, observeTerminalResultWorker, pollPrivateJob, readPrivateJob, recordPrivateIdentityObservation, validateTerminalWorkerSnapshot, validateWriteSpawnResponseWitness, waitForTerminal } from "./lib/installed-worker-mcp-runner-observation.mjs";
import { beginScenario, bindSessionBoundary, deleteAndProveSessionAbsent, exactPrivateAuthFile, proveSessionAbsentWithCredential, proveTerminalCleanup, refreshSessionCredentialHandle, runCompletionScenario, runSessionCredentialTransaction, validWriteSmokePrimaryTurnAdmission, waitForSessionPresence, waitForWriteSmokeProcessClosure } from "./lib/installed-worker-mcp-runner-session-read.mjs";
import { runWriteCancellationScenario, runWriteSmokeScenario } from "./lib/installed-worker-mcp-runner-write-scenarios.mjs";
import { runTwoWriterScenario } from "./lib/installed-worker-mcp-runner-write-two.mjs";
import {
  LIVE_RECEIPT_AUTHORITY_CONFIG,
  LIVE_RECEIPT_AUTHORITY_SYNTHETIC,
  LIVE_RECEIPT_CAPABILITY_TOOL_IDS,
  LIVE_RECEIPT_MANIFEST,
  LIVE_RECEIPT_PROVIDER_CAPABILITIES,
  LIVE_RECEIPT_PRODUCER_ID,
  LIVE_RECEIPT_PRODUCER_VERSION,
  LIVE_RECEIPT_ROOT,
  LIVE_RECEIPT_SCHEMA_VERSION,
  computeInventoryDigest,
  computeLiveQualificationReceiptDigest,
  computeLiveReceiptManifestDigest,
  computePhaseScopeDigest,
  gitIdentity,
  isNonEvidenceTreeClean,
  validateLiveQualificationReceipt
} from "./lib/worker-broker-evidence.mjs";

async function runCancellationScenario(baseContext, fixtureRoot) {
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

function privateObservationFor(tracker, temporaryRemoved) {
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

async function terminateTrackedClients(runner) {
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

function writeEmergencyValidationMode(job) {
  const spawn = job?.request?.spawn || {};
  if (!Object.hasOwn(spawn, "dispatch")) return "pre-dispatch";
  return spawn.dispatch?.schemaVersion === 2 ? "dispatch" : "invalid";
}

function writeEmergencyRequiredKinds(job) {
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

function emergencySessionAction({
  deletionAcknowledged,
  observedPresent
}) {
  if (deletionAcknowledged === true) return "prove-absent";
  return observedPresent === false ? "adopt-absence" : "delete";
}

function emergencyCleanupSucceeded({
  clean,
  sessionCount,
  temporaryRootExists
}) {
  return clean === true
    && sessionCount === 0
    && temporaryRootExists === false;
}

function durableSessionDeletionAcknowledged(context, tracker) {
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

async function cleanupExactWorkerBoundary(
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

function proveEmergencyWriteWorktreeAbsent(context, tracker) {
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

async function observeEmergencySessionAbsence(
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

async function deleteOrAdoptEmergencySessionAbsence(
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

async function emergencyCleanup(runner) {
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

function ensurePublicationDirectory(relativeDirectory, created) {
  const root = canonicalPath(ROOT, "Repository root");
  let current = root;
  for (const segment of relativeDirectory.split("/")) {
    if (
      !segment
      || segment === "."
      || segment === ".."
      || segment.includes("\\")
      || segment.includes("\0")
    ) {
      fail("E_RECEIPT");
    }
    const next = path.join(current, segment);
    try {
      fs.mkdirSync(next, { mode: 0o755 });
      created.push(next);
      fsyncDirectory(current);
      fsyncDirectory(next);
    } catch (error) {
      if (error?.code !== "EEXIST") fail("E_RECEIPT");
    }
    const stat = fs.lstatSync(next);
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || !isPathInside(root, fs.realpathSync(next))
    ) {
      fail("E_RECEIPT");
    }
    current = fs.realpathSync(next);
  }
  return current;
}

function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function publishReceipt(receipt) {
  const validation = validateLiveQualificationReceipt(receipt, {
    strict: true,
    root: ROOT
  });
  if (!validation.ok) fail("E_RECEIPT");
  const relativeDirectory = [
    LIVE_RECEIPT_ROOT,
    LIVE_RECEIPT_AUTHORITY_SYNTHETIC
  ].join("/");
  const fileName = [
    receipt.sourceInventoryDigest.slice(0, 16),
    receipt.receiptDigest.slice(0, 16)
  ].join("-") + ".json";
  const created = [];
  let publishedFile = null;
  let descriptor;
  let fileCreated = false;
  let publishedIdentity = null;
  try {
    const directory = ensurePublicationDirectory(relativeDirectory, created);
    publishedFile = path.join(directory, fileName);
    if (!isPathInside(ROOT, publishedFile)) fail("E_RECEIPT");
    descriptor = fs.openSync(
      publishedFile,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600
    );
    fileCreated = true;
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) fail("E_RECEIPT");
    publishedIdentity = { dev: opened.dev, ino: opened.ino };
    const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
    const buffer = Buffer.from(serialized, "utf8");
    if (buffer.length > MAX_RECEIPT_BYTES) fail("E_RECEIPT");
    let offset = 0;
    while (offset < buffer.length) {
      const written = fs.writeSync(
        descriptor,
        buffer,
        offset,
        buffer.length - offset
      );
      if (!Number.isSafeInteger(written) || written <= 0) fail("E_RECEIPT");
      offset += written;
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fsyncDirectory(directory);

    descriptor = fs.openSync(
      publishedFile,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const reopened = fs.fstatSync(descriptor);
    const stat = fs.lstatSync(publishedFile);
    if (
      !reopened.isFile()
      || reopened.dev !== publishedIdentity.dev
      || reopened.ino !== publishedIdentity.ino
      || !stat.isFile()
      || stat.isSymbolicLink()
      || stat.size !== buffer.length
      || stat.dev !== publishedIdentity.dev
      || stat.ino !== publishedIdentity.ino
      || !isPathInside(ROOT, fs.realpathSync(publishedFile))
    ) {
      fail("E_RECEIPT");
    }
    const reread = fs.readFileSync(descriptor, "utf8");
    fs.closeSync(descriptor);
    descriptor = null;
    if (reread !== serialized) fail("E_RECEIPT");
    const parsed = safeParseJson(reread, "E_RECEIPT");
    if (!sameJson(parsed, receipt)) fail("E_RECEIPT");
    const post = validateLiveQualificationReceipt(parsed, {
      strict: true,
      root: ROOT
    });
    if (!post.ok || parsed.receiptDigest !== receipt.receiptDigest) {
      fail("E_RECEIPT");
    }
    const finalStat = fs.lstatSync(publishedFile);
    if (
      !finalStat.isFile()
      || finalStat.isSymbolicLink()
      || finalStat.dev !== publishedIdentity.dev
      || finalStat.ino !== publishedIdentity.ino
    ) {
      fail("E_RECEIPT");
    }
  } catch (error) {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (publishedFile && fileCreated) {
      try {
        const current = fs.lstatSync(publishedFile);
        if (
          current.isFile()
          && !current.isSymbolicLink()
          && current.dev === publishedIdentity?.dev
          && current.ino === publishedIdentity?.ino
        ) {
          fs.unlinkSync(publishedFile);
          fsyncDirectory(path.dirname(publishedFile));
        }
      } catch {}
    }
    for (const directory of created.reverse()) {
      try {
        fs.rmdirSync(directory);
        fsyncDirectory(path.dirname(directory));
      } catch {}
    }
    if (error instanceof QualificationError) throw error;
    fail("E_RECEIPT");
  }
}

function buildReceipt({
  startedAt,
  endedAt,
  sourceIdentity,
  sourceDigest,
  phaseScopeDigest,
  pluginVersion,
  sourcePluginDigest,
  installedPluginDigest,
  installedFileCount,
  installedEntrypointDigest,
  providerCapabilityDigest,
  observedProviderCapabilities,
  providerBinaryDigest,
  providerVersion
}) {
  const config = LIVE_RECEIPT_AUTHORITY_CONFIG[LIVE_RECEIPT_AUTHORITY_SYNTHETIC];
  const receipt = {
    schemaVersion: LIVE_RECEIPT_SCHEMA_VERSION,
    producerId: LIVE_RECEIPT_PRODUCER_ID,
    producerVersion: LIVE_RECEIPT_PRODUCER_VERSION,
    manifestDigest: computeLiveReceiptManifestDigest(),
    authorityMode: LIVE_RECEIPT_AUTHORITY_SYNTHETIC,
    phase: config.phase,
    pluginVersion,
    headCommit: sourceIdentity.headCommit,
    headTree: sourceIdentity.headTree,
    sourceInventoryDigest: sourceDigest,
    phaseScopeDigest,
    repositoryBeforeDigest: sourceDigest,
    repositoryAfterDigest: sourceDigest,
    sourcePluginInventoryDigest: sourcePluginDigest,
    installedPluginInventoryDigest: installedPluginDigest,
    installedFileCount,
    installedEntrypointDigest,
    providerCapabilityDigest,
    observedProviderCapabilities: [...observedProviderCapabilities],
    observedToolIds: [...LIVE_RECEIPT_CAPABILITY_TOOL_IDS],
    providerBinaryDigest,
    providerVersion,
    providerRevision: `binary-sha256-${providerBinaryDigest}`,
    mcpProtocolVersion: LIVE_RECEIPT_MANIFEST.mcpProtocolVersion,
    codexBinaryDigest: null,
    codexVersion: null,
    codexModel: null,
    hostTaskDigest: null,
    installationMethod: "codex-local-plugin-cache",
    scenarios: config.scenarios.map((scenario) => ({ ...scenario })),
    outcome: "pass",
    startedAt,
    endedAt
  };
  receipt.receiptDigest = computeLiveQualificationReceiptDigest(receipt);
  return receipt;
}

async function qualify(
  runner,
  { writeSmoke = false, twoWriter = false } = {}
) {
  const writeLifecycle = writeSmoke || twoWriter;
  enterQualificationStage("source-boundary");
  const startedAt = new Date().toISOString();
  if (!isNonEvidenceTreeClean(ROOT)) fail("E_SOURCE");
  const sourceIdentity = gitIdentity(ROOT);
  if (sourceIdentity.cleanTreeAtVerification !== true) fail("E_SOURCE");
  const sourceDigest = computeInventoryDigest(ROOT, { includeEvidence: false });
  const phaseScopeDigest = computePhaseScopeDigest("1", ROOT);
  const sourceEntries = createPluginInventory(SOURCE_PLUGIN);
  const sourcePluginDigest = digestInventory(sourceEntries);
  const packageJson = safeParseJson(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
    "E_SOURCE"
  );
  const pluginManifest = safeParseJson(
    fs.readFileSync(path.join(SOURCE_PLUGIN, ".codex-plugin", "plugin.json"), "utf8"),
    "E_SOURCE"
  );
  if (
    typeof packageJson.version !== "string"
    || packageJson.version !== pluginManifest.version
  ) {
    fail("E_SOURCE");
  }

  const runnerBase = writeLifecycle ? privateLiveFixtureBase() : os.tmpdir();
  runner.temporaryRoot = fs.mkdtempSync(
    path.join(runnerBase, "grok-installed-worker-mcp-")
  );
  fs.chmodSync(runner.temporaryRoot, 0o700);
  const codexHome = path.join(runner.temporaryRoot, "codex-home");
  const pluginData = path.join(runner.temporaryRoot, "plugin-data");
  const setupFixture = path.join(runner.temporaryRoot, "setup-fixture");
  const completionFixture = path.join(runner.temporaryRoot, "completion-fixture");
  const cancellationFixture = path.join(runner.temporaryRoot, "cancellation-fixture");
  const writeSmokeFixture = path.join(runner.temporaryRoot, "write-smoke-fixture");
  const writeCancelFixture = path.join(runner.temporaryRoot, "write-cancel-fixture");
  const twoWriterFixture = path.join(runner.temporaryRoot, "two-writer-fixture");
  mkdirPrivate(codexHome);
  mkdirPrivate(pluginData);
  const threadId = crypto.randomUUID();
  if (!CANONICAL_UUID.test(threadId)) fail("E_MCP");
  const env = buildChildEnvironment({ codexHome, pluginData, threadId });
  initializeFixtureRepository(setupFixture, env);

  enterQualificationStage("private-install");
  const codexBinary = process.env.CODEX_BIN || "codex";
  runJson(codexBinary, ["plugin", "marketplace", "add", ROOT, "--json"], {
    cwd: ROOT,
    env,
    timeoutMs: 60_000,
    code: "E_INSTALL"
  });
  const installedPayload = runJson(
    codexBinary,
    ["plugin", "add", PLUGIN_ID, "--json"],
    {
      cwd: ROOT,
      env,
      timeoutMs: 60_000,
      code: "E_INSTALL"
    }
  );
  if (typeof installedPayload.installedPath !== "string") fail("E_INSTALL");
  const installedRoot = canonicalPath(
    installedPayload.installedPath,
    "Installed plugin root"
  );
  const cacheRoot = canonicalPath(
    path.join(codexHome, "plugins", "cache"),
    "Private Codex plugin cache"
  );
  if (
    !isPathInside(cacheRoot, installedRoot)
    || isPathInside(SOURCE_PLUGIN, installedRoot)
  ) {
    fail("E_INSTALL");
  }
  const listedPlugins = runJson(codexBinary, ["plugin", "list", "--json"], {
    cwd: ROOT,
    env,
    timeoutMs: 30_000,
    code: "E_INSTALL"
  });
  const installedRecord = listedPlugins.installed?.filter(
    (entry) => entry?.pluginId === PLUGIN_ID
  );
  if (
    !Array.isArray(installedRecord)
    || installedRecord.length !== 1
    || installedRecord[0].installed !== true
    || installedRecord[0].enabled !== true
    || installedRecord[0].version !== packageJson.version
  ) {
    fail("E_INSTALL");
  }
  const installedEntries = createPluginInventory(installedRoot);
  const installedPluginDigest = digestInventory(installedEntries);
  if (
    describeInventoryDifference(sourceEntries, installedEntries).length !== 0
    || installedPluginDigest !== sourcePluginDigest
  ) {
    fail("E_INSTALL");
  }
  const installedEntrypointDigest = digestRegularFile(
    path.join(installedRoot, "mcp", "server.mjs")
  );
  const sourceEntrypoint = sourceEntries.find(
    (entry) => entry.path === "mcp/server.mjs"
  );
  if (
    !sourceEntrypoint
    || sourceEntrypoint.sha256 !== installedEntrypointDigest
  ) {
    fail("E_INSTALL");
  }

  enterQualificationStage("installed-imports");
  const providerCapability = await importInstalled(
    installedRoot,
    "scripts/lib/provider-capability.mjs"
  );
  const providerExecutablePin = await importInstalled(
    installedRoot,
    "scripts/lib/provider-executable-pin.mjs"
  );
  const state = await importInstalled(installedRoot, "scripts/lib/state.mjs");
  const processControl = await importInstalled(
    installedRoot,
    "scripts/lib/process-control.mjs"
  );
  const guard = await importInstalled(
    installedRoot,
    "scripts/lib/recursion-guard.mjs"
  );
  const mutation = await importInstalled(
    installedRoot,
    "scripts/lib/worker-mutation.mjs"
  );
  const launchContract = await importInstalled(
    installedRoot,
    "scripts/lib/worker-launch-contract.mjs"
  );
  const provider = await importInstalled(
    installedRoot,
    "scripts/lib/grok-provider.mjs"
  );
  const profiles = await importInstalled(
    installedRoot,
    "scripts/lib/profiles.mjs"
  );
  const authority = await importInstalled(
    installedRoot,
    "scripts/lib/worker-authority.mjs"
  );
  const workerProtocol = await importInstalled(
    installedRoot,
    "scripts/lib/worker-protocol.mjs"
  );
  const workerWorktree = await importInstalled(
    installedRoot,
    "scripts/lib/worker-worktree.mjs"
  );
  const workerSessionLifecycle = await importInstalled(
    installedRoot,
    "scripts/lib/worker-session-lifecycle.mjs"
  );
  if (
    workerProtocol.MAX_LIFECYCLE_EVENTS
      !== MAX_TERMINAL_LIFECYCLE_EVENTS
  ) {
    fail("E_INSTALL");
  }
  const mailboxState = await importInstalled(
    installedRoot,
    "scripts/lib/worker-mailbox-state.mjs"
  );
  const broker = await importInstalled(installedRoot, "mcp/broker.mjs");

  enterQualificationStage("provider-setup");
  runner.setupBoundary = createSetupBoundary({
    fixtureRoot: setupFixture,
    pluginData,
    env,
    threadId,
    processControl,
    guard
  });
  enterQualificationStage("provider-setup-command");
  const setupJson = await runSetupJson(
    process.execPath,
    [path.join(installedRoot, "scripts", "grok-codex.mjs"), "setup", "--json"],
    {
      cwd: setupFixture,
      env,
      timeoutMs: 120_000,
      boundary: runner.setupBoundary,
      runner
    }
  );
  enterQualificationStage("provider-setup-cleanup");
  if (!await cleanupSetupBoundary(
    runner.setupBoundary,
    {
      terminate: false,
      requireObservation: setupCleanupRequiresObservation(setupJson)
    }
  )) {
    fail("E_CLEANUP");
  }
  enterQualificationStage("provider-setup-contract");
  let setup;
  try {
    setup = validateInstalledSetup(setupJson);
  } catch {
    fail("E_SETUP");
  }
  const setupFixtureStatus = runBounded("git", [
    "status", "--porcelain=v1", "-z", "--untracked-files=all"
  ], {
    cwd: setupFixture,
    env,
    requireSilentStderr: false,
    code: "E_SETUP"
  }).stdout;
  if (setupFixtureStatus !== "") fail("E_SETUP");

  enterQualificationStage("provider-discovery-poison");
  const discoveryPoison = poisonChildProviderDiscovery(env, runner.temporaryRoot);
  enterQualificationStage("provider-capability");
  const providerLaunchBinding =
    providerExecutablePin.readActiveProviderLaunchBinding({ env });
  if (!providerLaunchBinding) fail("E_CAPABILITY");
  const providerLaunchBindingDigest =
    providerExecutablePin.providerLaunchBindingDigest(providerLaunchBinding);
  const capability = providerCapability.readValidProviderCapabilityReceipt({ env });
  if (!capability) fail("E_CAPABILITY");
  let resolvedProviderPin;
  try {
    resolvedProviderPin = providerExecutablePin.resolveProviderExecutablePin(
      providerLaunchBinding,
      { env }
    );
  } catch {
    fail("E_CAPABILITY");
  }
  const providerIdentity = captureProviderFileIdentity(
    resolvedProviderPin.binary
  );
  validateProviderCapabilityAgreement(capability, {
    setup,
    pluginVersion: packageJson.version,
    mcpCapabilityContractVersion: providerCapability.MCP_CAPABILITY_CONTRACT_VERSION,
    platform: process.platform,
    architecture: process.arch,
    providerLaunchBinding,
    providerLaunchBindingDigest,
    rootReadProfileDigest: profiles.profileFor("task", false).agentProfileDigest,
    observedAt: Date.now()
  });
  if (
    Object.hasOwn(setup.grok, "binary")
    || JSON.stringify(setup).includes(providerIdentity.path)
    || JSON.stringify(capability).includes(providerIdentity.path)
    || Object.hasOwn(capability, "providerFileIdentity")
    || setup.grok.version !== resolvedProviderPin.executableIdentity.version
    || providerIdentity.contentDigest
      !== resolvedProviderPin.executableIdentity.executableDigest
    || providerLaunchBinding.executableIdentityDigest
      !== resolvedProviderPin.executableIdentity.identityDigest
    || providerLaunchBinding.releaseIdentityDigest
      !== resolvedProviderPin.executableIdentity.releaseIdentityDigest
    || capability.providerLaunchBindingDigest !== providerLaunchBindingDigest
    || !sameJson(capability.providerLaunchBinding, providerLaunchBinding)
    || capability.capabilities?.length !== 3
    || !sameJson(capability.capabilities, LIVE_RECEIPT_PROVIDER_CAPABILITIES)
    || capability.capabilities[0]
      !== providerCapability.ROOT_READ_PROVIDER_CAPABILITY
    || capability.capabilities[1]
      !== providerCapability.SAME_SESSION_READ_FOLLOWUP_PROVIDER_CAPABILITY
    || capability.capabilities[2]
      !== providerCapability.ORDERED_TURN_BOUNDARY_MAILBOX_PROVIDER_CAPABILITY
    || broker.DEFAULT_MCP_PROTOCOL_VERSION !== PROTOCOL_VERSION
    || broker.MCP_SERVER_NAME !== "grok-worker-broker"
    || broker.MCP_SERVER_VERSION
      !== providerCapability.MCP_CAPABILITY_CONTRACT_VERSION
    || !sameJson(
      authority.CODEX_MCP_EXPERIMENTAL_CAPABILITIES,
      EXPECTED_EXPERIMENTAL_CAPABILITIES
    )
  ) {
    fail("E_CAPABILITY");
  }

  runner.provider = provider;
  runner.providerBinary = providerIdentity.path;
  const baseContext = {
    runner,
    env,
    discoveryPoison,
    threadId,
    installedRoot,
    providerCapability: capability,
    providerCapabilityModule: providerCapability,
    providerExecutablePin,
    providerLaunchBinding,
    providerLaunchBindingDigest,
    providerExecutableIdentityDigest:
      resolvedProviderPin.executableIdentity.identityDigest,
    providerReleaseIdentityDigest:
      resolvedProviderPin.executableIdentity.releaseIdentityDigest,
    providerBinary: providerIdentity.path,
    state,
    processControl,
    guard,
    mutation,
    launchContract,
    provider,
    workerProtocol,
    workerWorktree,
    workerSessionLifecycle,
    mailboxState,
    workerTools: writeLifecycle
      ? broker.WRITE_SMOKE_WORKER_TOOLS
      : broker.WORKER_TOOLS,
    defaultWorkerTools: broker.WORKER_TOOLS,
    serverVersion: broker.MCP_SERVER_VERSION,
    experimentalCapabilities: EXPECTED_EXPERIMENTAL_CAPABILITIES
  };
  if (writeLifecycle) {
    env.GROK_COMPANION_WRITE_SMOKE = broker.WRITE_SMOKE_ENV_VALUE;
    const runtime = broker.createMcpBrokerRuntime({
      env,
      providerCapabilityReceipt: capability
    });
    if (
      runtime.writeLifecycleCapabilityDigest == null
      || !/^[a-f0-9]{64}$/.test(runtime.writeLifecycleCapabilityDigest)
      || !sameJson(runtime.tools, broker.WRITE_SMOKE_WORKER_TOOLS)
    ) {
      fail("E_CAPABILITY");
    }
    baseContext.writeSmoke = true;
    baseContext.writeLifecycleCapabilityDigest =
      runtime.writeLifecycleCapabilityDigest;
    baseContext.pluginData = pluginData;
    const evidence = twoWriter
      ? await runTwoWriterScenario(baseContext, twoWriterFixture)
      : await runWriteSmokeScenario(baseContext, writeSmokeFixture);
    const cancellationEvidence = twoWriter
      ? null
      : await runWriteCancellationScenario(baseContext, writeCancelFixture);
    const pinnedEvidence = Object.freeze({
      ...evidence,
      ...(twoWriter ? {} : {
        activeWriteCancellationProven: true,
        writeCancellation: cancellationEvidence
      }),
      sourceHeadCommit: sourceIdentity.headCommit,
      sourceHeadTree: sourceIdentity.headTree,
      sourceInventoryDigest: sourceDigest,
      sourcePluginInventoryDigest: sourcePluginDigest,
      installedPluginInventoryDigest: installedPluginDigest,
      installedEntrypointDigest,
      providerVersion: capability.providerVersion,
      providerBinaryDigest: providerIdentity.contentDigest,
      providerCapabilityDigest: capability.capabilityDigest,
      providerPinRef: providerLaunchBinding.pinRef,
      providerLaunchBindingDigest,
      providerExecutableIdentityDigest:
        resolvedProviderPin.executableIdentity.identityDigest,
      providerReleaseIdentityDigest:
        resolvedProviderPin.executableIdentity.releaseIdentityDigest,
      ambientProviderDiscoveryPoisoned: true,
      writeLifecycleCapabilityDigest:
        runtime.writeLifecycleCapabilityDigest
    });
    if (!(await terminateTrackedClients(runner))) fail("E_CLEANUP");
    recheckProviderExecutablePin(baseContext, providerIdentity);
    const finalInstalledEntries = createPluginInventory(installedRoot);
    if (
      describeInventoryDifference(installedEntries, finalInstalledEntries).length
        !== 0
      || digestInventory(finalInstalledEntries) !== installedPluginDigest
      || digestRegularFile(path.join(installedRoot, "mcp", "server.mjs"))
        !== installedEntrypointDigest
    ) {
      fail("E_INSTALL");
    }
    const finalSourceIdentity = gitIdentity(ROOT);
    if (
      !isNonEvidenceTreeClean(ROOT)
      || finalSourceIdentity.cleanTreeAtVerification !== true
      || finalSourceIdentity.headCommit !== sourceIdentity.headCommit
      || finalSourceIdentity.headTree !== sourceIdentity.headTree
      || computeInventoryDigest(ROOT, { includeEvidence: false }) !== sourceDigest
      || digestInventory(createPluginInventory(SOURCE_PLUGIN))
        !== sourcePluginDigest
    ) {
      fail("E_SOURCE");
    }
    fs.rmSync(runner.temporaryRoot, { recursive: true, force: true });
    if (fs.existsSync(runner.temporaryRoot)) fail("E_CLEANUP");
    runner.temporaryRemoved = true;
    return pinnedEvidence;
  }
  const completion = await runCompletionScenario(baseContext, completionFixture);
  const cancellation = await runCancellationScenario(
    baseContext,
    cancellationFixture
  );

  enterQualificationStage("global-cleanup");
  if (!(await terminateTrackedClients(runner))) fail("E_CLEANUP");
  for (const { tracker } of [completion, cancellation]) {
    if (
      tracker.processIdentities.size !== 3
      || [...tracker.processIdentities.values()]
        .some((identity) => !processControl.processGroupGone(identity))
    ) {
      fail("E_CLEANUP");
    }
  }
  enterQualificationStage("installed-recheck");
  const finalInstalledEntries = createPluginInventory(installedRoot);
  const finalInstalledDigest = digestInventory(finalInstalledEntries);
  const finalInstalledEntrypointDigest = digestRegularFile(
    path.join(installedRoot, "mcp", "server.mjs")
  );
  const finalProviderIdentity = recheckProviderExecutablePin(
    baseContext,
    providerIdentity
  ).currentIdentity;
  if (
    describeInventoryDifference(installedEntries, finalInstalledEntries).length
      !== 0
    || describeInventoryDifference(sourceEntries, finalInstalledEntries).length
      !== 0
    || finalInstalledDigest !== installedPluginDigest
    || finalInstalledDigest !== sourcePluginDigest
    || finalInstalledEntries.length !== installedEntries.length
    || finalInstalledEntrypointDigest !== installedEntrypointDigest
    || !sameJson(finalProviderIdentity, providerIdentity)
  ) {
    fail("E_INSTALL");
  }
  fs.rmSync(runner.temporaryRoot, { recursive: true, force: true });
  if (fs.existsSync(runner.temporaryRoot)) fail("E_CLEANUP");
  runner.temporaryRemoved = true;

  enterQualificationStage("evidence-binding");
  for (const completed of [completion, cancellation]) {
    completed.tracker.context = completed.context;
    const observation = privateObservationFor(completed.tracker, true);
    validateInstalledScenarioEvidence(completed.publicEvidence, observation);
  }

  const finalSourceIdentity = gitIdentity(ROOT);
  if (
    !isNonEvidenceTreeClean(ROOT)
    || finalSourceIdentity.cleanTreeAtVerification !== true
    || finalSourceIdentity.headCommit !== sourceIdentity.headCommit
    || finalSourceIdentity.headTree !== sourceIdentity.headTree
    || computeInventoryDigest(ROOT, { includeEvidence: false }) !== sourceDigest
    || computePhaseScopeDigest("1", ROOT) !== phaseScopeDigest
    || digestInventory(createPluginInventory(SOURCE_PLUGIN)) !== sourcePluginDigest
  ) {
    fail("E_SOURCE");
  }
  const endedAt = new Date().toISOString();
  const receipt = buildReceipt({
    startedAt,
    endedAt,
    sourceIdentity,
    sourceDigest,
    phaseScopeDigest,
    pluginVersion: packageJson.version,
    sourcePluginDigest,
    installedPluginDigest,
    installedFileCount: installedEntries.length,
    installedEntrypointDigest,
    providerCapabilityDigest: capability.capabilityDigest,
    observedProviderCapabilities: capability.capabilities,
    providerBinaryDigest: providerIdentity.contentDigest,
    providerVersion: capability.providerVersion
  });
  enterQualificationStage("receipt-publication");
  publishReceipt(receipt);
}

async function main() {
  const argv = process.argv.slice(2);
  if (
    argv.length === 2
    && ["--write-smoke", "--two-writer"].includes(argv[0])
    && (argv[1] === "--help" || argv[1] === "-h")
  ) {
    process.stdout.write(
      argv[0] === "--two-writer" ? TWO_WRITER_HELP : WRITE_SMOKE_HELP
    );
    return;
  }
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(HELP);
    return;
  }
  const writeSmoke = argv.length === 1 && argv[0] === "--write-smoke";
  const twoWriter = argv.length === 1 && argv[0] === "--two-writer";
  if (argv.length !== 0 && !writeSmoke && !twoWriter) fail("E_ARGUMENT");
  if (LIVE_GATES.some((name) => process.env[name] !== "1")) fail("E_GATE");
  if (
    (writeSmoke || twoWriter)
    && process.env.GROK_WORKER_WRITE_E2E !== "1"
  ) {
    fail("E_GATE");
  }
  if (
    twoWriter
    && process.env.GROK_WORKER_TWO_WRITER_E2E !== "1"
  ) {
    fail("E_GATE");
  }
  if (process.platform === "win32") fail("E_PLATFORM");

  const runner = {
    interrupted: false,
    temporaryRoot: null,
    temporaryRemoved: false,
    provider: null,
    providerBinary: null,
    setupBoundary: null,
    clients: new Set(),
    sessions: new Map(),
    turnIds: new Set(),
    trackers: [],
    writeSmoke: null
  };
  const interrupt = () => { runner.interrupted = true; };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const evidence = await qualify(runner, { writeSmoke, twoWriter });
    if (writeSmoke || twoWriter) {
      process.stdout.write(`${JSON.stringify(evidence)}\n`);
    } else {
      process.stdout.write(
        "Installed Worker MCP E2E passed; one provisional synthetic direct-MCP receipt was published.\n"
      );
    }
  } catch (error) {
    const originalCode = error instanceof QualificationError
      ? error.code
      : "E_SCENARIO";
    const originalStage = error instanceof QualificationError
      ? error.stage
      : qualificationStage;
    enterQualificationStage("emergency-cleanup");
    let cleanupOutcome = "proof-returned-false";
    try {
      cleanupOutcome = classifyInstalledWorkerMcpCleanupOutcome(
        await emergencyCleanup(runner)
      );
    } catch {
      cleanupOutcome = "cleanup-threw";
    }
    const selected = selectInstalledWorkerMcpFailure({
      originalCode,
      originalStage,
      cleanupOutcome
    }, QUALIFICATION_STAGES);
    throw new QualificationError(
      selected.code,
      selected.stage,
      selected.diagnostic
    );
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

const IS_MAIN = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_MAIN) {
  main().catch((error) => {
    process.stderr.write(
      formatInstalledWorkerMcpFailure(
        error instanceof QualificationError
          ? {
              code: error.code,
              stage: error.stage,
              diagnostic: error.diagnostic
            }
          : {
              code: "E_SCENARIO",
              stage: "startup",
              diagnostic: null
            },
        QUALIFICATION_STAGES
      )
    );
    process.exitCode = 1;
  });
}
