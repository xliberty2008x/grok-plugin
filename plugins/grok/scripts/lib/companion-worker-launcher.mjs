import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CompanionError, asErrorPayload } from "./errors.mjs";
import { cleanupTaskRuntimeArtifacts } from "./provider-controller-environments.mjs";
import { captureSpawnIdentity, ensureChildExit, providerCleanupIdentity } from "./provider-process.mjs";
import { applyResearchPrivacy, cleanupResearchRuntimeArtifacts, DEEP_RESEARCH_KIND } from "./deep-research.mjs";
import { updateJob, readJob, isCancelRequested, terminal, now, withWorkspaceStateTransaction } from "./state.mjs";
import { workspaceRoot } from "./workspace.mjs";
import { redact } from "./redact.mjs";
import { processGroupGone, processStartToken } from "./process-control.mjs";
import { appendLifecycleEvent } from "./task-lifecycle.mjs";
import { scrubStoredJob } from "./task-envelope.mjs";
import { prepareDispatchProcessSpawn, recordDispatchProcessNoChild } from "./worker-mutation-dispatch-admission.mjs";
import { assertDispatchContract } from "./worker-mutation-dispatch-contract.mjs";
import { recordUnsettledWorkerProcess, transitionWorkerDispatch } from "./worker-mutation-dispatch-transition.mjs";
import { recoverLostProviderStartedWorker } from "./worker-recovery.mjs";
import { captureTerminalEvidence, selectTaskTerminalError, terminalTaskProgress } from "./task-terminal-evidence.mjs";
import { assertWorkerAuthorization, isDispatchV2, isSupportedWorkerDispatch } from "./worker-launch-contract.mjs";
const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "grok-companion.mjs"
);
const PLUGIN_ROOT = path.resolve(path.dirname(SCRIPT), "..");
const VALID_EFFORTS = new Set(["low", "medium", "high"]);
import { applyTaskPrivacy, currentHost, sessionId, stateDir, touchJob, workerEnvironment } from "./companion-shared.mjs";

import { execute } from "./companion-task-executor.mjs";
import { executeDeepResearch } from "./companion-research.mjs";

function parseLaunchWorkerArguments(raw) {
  const brokerInvocation = raw[1] === "--attempt";
  const fencedInvocation = brokerInvocation && raw[3] === "--fence";
  const id = raw[0];
  const dispatchAttemptId = brokerInvocation ? raw[2] : null;
  const providedDispatchFence = fencedInvocation ? Number(raw[4]) : null;
  const controllerIntentFlag = brokerInvocation ? raw[fencedInvocation ? 5 : 3] : null;
  const controllerIntentId = brokerInvocation ? raw[fencedInvocation ? 6 : 4] : null;
  const cwdFlag = brokerInvocation ? raw[fencedInvocation ? 7 : 5] : raw[1];
  const cwd = brokerInvocation ? raw[fencedInvocation ? 8 : 6] : raw[2];
  if (raw.length !== (brokerInvocation ? (fencedInvocation ? 9 : 7) : 3)
    || cwdFlag !== "--cwd"
    || (brokerInvocation && (
      controllerIntentFlag !== "--controller-intent"
      || !/^[a-f0-9]{32}$/.test(String(dispatchAttemptId || ""))
      || !/^[a-f0-9]{32}$/.test(String(controllerIntentId || ""))
      || (fencedInvocation && (!Number.isSafeInteger(providedDispatchFence) || providedDispatchFence < 1))
    ))) {
    throw new CompanionError("E_USAGE", "Invalid worker launcher invocation.");
  }
  const root = workspaceRoot(cwd), nonce = process.env.GROK_COMPANION_WORKER_NONCE;
  let record = readJob(root, id);
  return {
    brokerInvocation,
    id,
    dispatchAttemptId,
    providedDispatchFence,
    controllerIntentId,
    root,
    nonce,
    record
  };
}

async function authorizeBrokerLauncher({
  id, dispatchAttemptId, providedDispatchFence, controllerIntentId, root, nonce, record
}) {
  let authorized = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    record = readJob(root, id);
    const authorization = record.workerAuthorization;
    const dispatch = record.request?.spawn?.dispatch;
    const dispatchFence = isDispatchV2(dispatch)
      ? (providedDispatchFence ?? Number(process.env.GROK_COMPANION_DISPATCH_FENCE || dispatch.fence))
      : null;
    const controllerIntent = record.request?.spawn?.controllerSpawnIntent;
    if (terminal(record)) return;
    const ownStartToken = processStartToken(process.pid);
    const ownController = {
      pid: process.pid,
      startToken: ownStartToken,
      nonce,
      processGroupId: process.platform === "win32" ? null : process.pid,
      commandMarker: id,
      dispatchAttemptId,
      dispatchFence
    };
    let exactAuthorization = false;
    try {
      if (isDispatchV2(dispatch)) {
        const bound = assertWorkerAuthorization(record, { allowLegacy: false });
        exactAuthorization = bound.nonce === nonce
          && bound.dispatchAttemptId === dispatchAttemptId
          && bound.dispatchFence === dispatchFence;
      } else {
        exactAuthorization = authorization?.schemaVersion === 1
          && authorization.nonce === nonce
          && authorization.purpose === "launch-worker"
          && authorization.ownerThreadId === record.host?.sessionId
          && authorization.dispatchAttemptId === dispatchAttemptId;
      }
    } catch {}
    const commonAuthorization = nonce
      && process.env.GROK_COMPANION_DISPATCH_ATTEMPT === dispatchAttemptId
      && (!isDispatchV2(dispatch)
        || (dispatch.fence === dispatchFence
          && Number(process.env.GROK_COMPANION_DISPATCH_FENCE || dispatchFence) === dispatchFence))
      && currentHost().kind === record.host?.kind
      && currentHost().sessionId === record.host?.sessionId
      && isSupportedWorkerDispatch(dispatch)
      && dispatch.attemptId === dispatchAttemptId
      && controllerIntent?.schemaVersion === 1
      && controllerIntent.intentId === controllerIntentId
      && controllerIntent.attemptId === dispatchAttemptId
      && (!isDispatchV2(dispatch) || controllerIntent.fence == null || controllerIntent.fence === dispatchFence)
      && controllerIntent.processKind === "controller"
      && ["pending", "registered"].includes(controllerIntent.status)
      && typeof ownStartToken === "string"
      && ownStartToken;
    const firstRegistrationAuthorized = commonAuthorization
      && dispatch.state === "claimed"
      && controllerIntent.status === "pending"
      && exactAuthorization;
    const alreadyRegistered = commonAuthorization
      && dispatch.state === "controller-started"
      && record.controllerProcess?.pid === process.pid
      && record.controllerProcess?.startToken === ownStartToken
      && record.controllerProcess?.nonce === nonce
      && record.controllerProcess?.processGroupId === ownController.processGroupId
      && record.controllerProcess?.commandMarker === id
      && record.controllerProcess?.dispatchAttemptId === dispatchAttemptId
      && (record.controllerProcess?.dispatchFence ?? null) === dispatchFence;
    if (firstRegistrationAuthorized || alreadyRegistered) {
      try {
        assertDispatchContract(record);
        transitionWorkerDispatch({
          root,
          workerId: id,
          attemptId: dispatchAttemptId,
          fence: dispatchFence,
          state: "controller-started",
          controllerProcess: ownController,
          spawnIntentId: controllerIntentId
        });
      } catch (error) {
        throw error;
      }
      authorized = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!authorized) {
    throw new CompanionError("E_RECURSION", "Unauthenticated or stale broker launcher invocation refused.");
  }
  return record;
}

async function watchBrokerWorker({
  id, dispatchAttemptId, providedDispatchFence, root, nonce, record
}) {
  let child;
  let identity;
  let workerIntent;
  const dispatchFence = isDispatchV2(record.request?.spawn?.dispatch)
    ? (providedDispatchFence ?? Number(process.env.GROK_COMPANION_DISPATCH_FENCE || record.request.spawn.dispatch.fence))
    : null;
  try {
    const prepared = prepareDispatchProcessSpawn({
      root,
      workerId: id,
      attemptId: dispatchAttemptId,
      fence: dispatchFence,
      processKind: "worker",
      nonce
    });
    if (!prepared.prepared) return;
    workerIntent = prepared.intent;
    child = spawn(process.execPath, [
      SCRIPT,
      "--worker",
      id,
      "--attempt",
      dispatchAttemptId,
      ...(dispatchFence ? ["--fence", String(dispatchFence)] : []),
      "--worker-intent",
      workerIntent.intentId,
      "--cwd",
      root
    ], {
      cwd: root,
      detached: true,
      shell: false,
      stdio: "ignore",
      env: workerEnvironment(nonce, dispatchAttemptId, dispatchFence)
    });
    identity = await captureSpawnIdentity(child);
    if (isCancelRequested(root, id, nonce)) {
      await ensureChildExit(child, identity);
      recordDispatchProcessNoChild({
        root,
        workerId: id,
        attemptId: dispatchAttemptId,
        fence: dispatchFence,
        processKind: "worker",
        intentId: workerIntent.intentId,
        resolution: "cleanup-proven"
      });
      return;
    }
    const workerProcess = {
      ...identity,
      nonce,
      commandMarker: id,
      dispatchAttemptId,
      dispatchFence
    };
    const transitioned = transitionWorkerDispatch({
      root,
      workerId: id,
      attemptId: dispatchAttemptId,
      fence: dispatchFence,
      state: "worker-started",
      workerProcess,
      spawnIntentId: workerIntent.intentId
    });
    if (transitioned.request?.spawn?.dispatch?.state !== "worker-started") {
      await ensureChildExit(child, identity);
      return;
    }
    let exited = child.exitCode !== null || child.signalCode !== null;
    const observeExit = () => { exited = true; };
    child.once("exit", observeExit);
    child.once("error", observeExit);
    try {
      for (;;) {
        const latest = readJob(root, id);
        const latestDispatch = latest.request?.spawn?.dispatch;
        if (latestDispatch?.attemptId !== dispatchAttemptId) {
          await ensureChildExit(child, identity);
          return;
        }
        if (latestDispatch.state === "failed" || terminal(latest)) {
          await ensureChildExit(child, identity);
          return;
        }
        if (exited) {
          await ensureChildExit(child, identity);
          if (latestDispatch.state === "provider-started") {
            await recoverLostProviderStartedWorker({
              root,
              workerId: id,
              attemptId: dispatchAttemptId,
              workerProcess,
              reconciler: false
            });
          } else {
            // Leave the exact worker-started attempt nonterminal. Recovery
            // decides whether launch was explicitly absent or ambiguous.
          }
          return;
        }
        const watchdogPollMs = latestDispatch.state === "provider-started" ? 250 : 25;
        await new Promise((resolve) => setTimeout(resolve, watchdogPollMs));
      }
    } finally {
      child.removeListener("exit", observeExit);
      child.removeListener("error", observeExit);
    }
  } catch (error) {
    if (workerIntent && !Number.isInteger(child?.pid)) {
      try {
        recordDispatchProcessNoChild({
          root,
          workerId: id,
          attemptId: dispatchAttemptId,
          fence: dispatchFence,
          processKind: "worker",
          intentId: workerIntent.intentId,
          resolution: "spawn-not-created"
        });
      } catch {}
    }
    const attachedCleanupIdentity = providerCleanupIdentity(error);
    const cleanupIdentity = identity || attachedCleanupIdentity;
    if (child
      && Number.isInteger(child.pid)
      && !cleanupIdentity
      && workerIntent) {
      // captureSpawnIdentity attaches an observation-only identity whenever
      // the spawned group may still be alive. A valid PID with no attached
      // identity therefore means its SIGTERM/SIGKILL cleanup was proven
      // before the error escaped.
      try {
        recordDispatchProcessNoChild({
          root,
          workerId: id,
          attemptId: dispatchAttemptId,
          fence: dispatchFence,
          processKind: "worker",
          intentId: workerIntent.intentId,
          resolution: "cleanup-proven"
        });
      } catch {}
    }
    if (child && cleanupIdentity) {
      let cleanupVerified = false;
      if (cleanupIdentity.startToken) {
        try {
          await ensureChildExit(child, cleanupIdentity);
          cleanupVerified = processGroupGone(cleanupIdentity);
        } catch {}
      } else {
        cleanupVerified = processGroupGone(cleanupIdentity);
      }
      if (!cleanupVerified) {
        try {
          recordUnsettledWorkerProcess({
            root,
            workerId: id,
            attemptId: dispatchAttemptId,
            workerProcess: {
              pid: cleanupIdentity.pid,
              startToken: cleanupIdentity.startToken || null,
              processGroupId: cleanupIdentity.processGroupId,
              nonce,
              commandMarker: id,
              dispatchAttemptId,
              dispatchFence
            }
          });
        } catch {}
      } else if (workerIntent) {
        try {
          recordDispatchProcessNoChild({
            root,
            workerId: id,
            attemptId: dispatchAttemptId,
            fence: dispatchFence,
            processKind: "worker",
            intentId: workerIntent.intentId,
            resolution: "cleanup-proven"
          });
        } catch {}
      }
    }
    // The host-trusted reconciler publishes loss/cancellation only after
    // this controller and every child group are verified gone.
    throw error;
  }
}

function settleLegacyPrelaunchCancellation(root, id, nonce) {
  withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(id);
    if (!current || terminal(current)) return current;
    if (current.workerAuthorization !== nonce) {
      throw new CompanionError(
        "E_RECURSION",
        "Worker launch authorization changed before cancellation cleanup."
      );
    }
    const cancelledAt = now();
    const intendedTerminal = {
      status: "cancelled",
      phase: "cancelled",
      completedAt: cancelledAt,
      error: {
        code: "E_CANCELLED",
        message: "Grok job was cancelled before worker launch."
      },
      summary: "Grok job was cancelled before worker launch."
    };
    const cleanup = cleanupTaskRuntimeArtifacts(
      stateDir(root),
      current.request?.providerHomeId || current.id,
      []
    );
    return transaction.updateJob(id, (latest) => {
      if (terminal(latest)) return latest;
      if (latest.workerAuthorization !== nonce) {
        throw new CompanionError(
          "E_RECURSION",
          "Worker launch authorization changed before cancellation publication."
        );
      }
      const settledAt = now();
      const base = {
        ...latest,
        workerAuthorization: null,
        heartbeatAt: settledAt,
        request: {
          ...latest.request,
          spawn: {
            ...(latest.request?.spawn || {}),
            providerLaunchPending: false,
            providerLaunchInFlight: false,
            providerLaunchOutcome: "not-launched",
            providerLaunchCompletedAt: settledAt
          }
        }
      };
      if (!cleanup.ok) {
        const message =
          "Cancellation is durable, but task runtime cleanup is incomplete.";
        return scrubStoredJob({
          ...base,
          status: "running",
          phase: "cleanup-blocked",
          completedAt: null,
          pendingTerminal: intendedTerminal,
          error: {
            code: "E_RUNTIME_CLEANUP",
            message,
            details: {
              privacyWarning:
                cleanup.warning || "Task runtime cleanup remained incomplete."
            }
          },
          summary: message,
          progress: "Cancellation accepted; runtime cleanup is still pending",
          result: applyTaskPrivacy(latest.result, cleanup),
          lifecycleEvents: appendLifecycleEvent(
            latest.lifecycleEvents || [],
            "blocked",
            message
          )
        });
      }

      const evidence = captureTerminalEvidence(
        latest.request?.spawn?.executionRoot || root,
        base,
        "cancelled"
      );
      const selectedTerminalError = selectTaskTerminalError(
        evidence,
        intendedTerminal.error
      );
      const selectedError = selectedTerminalError
        ? redact(asErrorPayload(selectedTerminalError))
        : null;
      const finalStatus = selectedError
        ? (selectedError.code === "E_CANCELLED" ? "cancelled" : "failed")
        : "cancelled";
      const finalPhase = selectedError?.code === "E_CONTEXT_DRIFT"
        ? "context-rejected"
        : selectedError?.code === "E_SCOPE_VIOLATION"
          ? "scope-rejected"
          : finalStatus;
      evidence.runtimeEvidence.executionStatus =
        finalStatus === "cancelled" ? "cancelled" : "failed";
      const result = {
        ...applyTaskPrivacy(latest.result, cleanup),
        hostVerification: latest.result?.hostVerification || "not_run",
        runtimeEvidence: {
          ...(latest.result?.runtimeEvidence || {}),
          ...evidence.runtimeEvidence
        },
        ...(finalStatus === "cancelled"
          ? { stopReason: "cancelled" }
          : {})
      };
      if (finalStatus !== "cancelled"
        && result.stopReason === "cancelled") {
        delete result.stopReason;
      }
      const summary = selectedError?.message
        || intendedTerminal.summary;
      return scrubStoredJob({
        ...base,
        status: finalStatus,
        phase: finalPhase,
        completedAt: selectedError?.code === "E_CONTEXT_DRIFT"
          || selectedError?.code === "E_SCOPE_VIOLATION"
          ? settledAt
          : intendedTerminal.completedAt,
        completionContextManifest: evidence.postContext,
        error: selectedError,
        summary,
        progress: terminalTaskProgress(finalStatus, selectedError),
        result,
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          finalStatus === "cancelled" ? "checkpoint" : "blocked",
          summary
        )
      });
    });
  });
}

async function handleLaunchWorker(raw) {
  const parsed = parseLaunchWorkerArguments(raw);
  let { brokerInvocation, id, dispatchAttemptId, providedDispatchFence, root, nonce, record } = parsed;
  if (brokerInvocation) {
    record = await authorizeBrokerLauncher(parsed);
    if (!record) return;
  if (isCancelRequested(root, id, nonce)) {
    // Exit without terminalizing this still-live controller. The trusted
    // reconciler observes the durable cancel marker after group exit.
    return;
  }
    return watchBrokerWorker({
      id, dispatchAttemptId, providedDispatchFence, root, nonce, record
    });
  }
  if (!nonce || record.workerAuthorization !== nonce) throw new CompanionError("E_RECURSION", "Unauthenticated Grok Companion launcher invocation refused.");
  if (terminal(record)) return;
  if (isCancelRequested(root, id, nonce)) {
    settleLegacyPrelaunchCancellation(root, id, nonce);
    return;
  }
  const child = spawn(process.execPath, [SCRIPT, "--worker", id, "--cwd", root], { cwd: root, detached: true, shell: false, stdio: "ignore", env: workerEnvironment(nonce) });
  const identity = await captureSpawnIdentity(child);
  updateJob(root, id, (current) => {
    if (terminal(current)) return current;
    current.workerAuthorization = null;
    current.workerProcess = { ...identity, nonce, commandMarker: id };
    current.summary = "Worker started";
    return current;
  });
  child.unref(); return;
}

async function handleWorker(raw) {
  const brokerInvocation = raw[1] === "--attempt";
  const fencedInvocation = brokerInvocation && raw[3] === "--fence";
  const id = raw[0];
  const dispatchAttemptId = brokerInvocation ? raw[2] : null;
  const providedDispatchFence = fencedInvocation ? Number(raw[4]) : null;
  const workerIntentFlag = brokerInvocation ? raw[fencedInvocation ? 5 : 3] : null;
  const workerIntentId = brokerInvocation ? raw[fencedInvocation ? 6 : 4] : null;
  const cwdFlag = brokerInvocation ? raw[fencedInvocation ? 7 : 5] : raw[1];
  const cwd = brokerInvocation ? raw[fencedInvocation ? 8 : 6] : raw[2];
  if (raw.length !== (brokerInvocation ? (fencedInvocation ? 9 : 7) : 3)
    || cwdFlag !== "--cwd"
    || (brokerInvocation && (
      workerIntentFlag !== "--worker-intent"
      || !/^[a-f0-9]{32}$/.test(String(dispatchAttemptId || ""))
      || !/^[a-f0-9]{32}$/.test(String(workerIntentId || ""))
      || (fencedInvocation && (!Number.isSafeInteger(providedDispatchFence) || providedDispatchFence < 1))
    ))) {
    throw new CompanionError("E_USAGE", "Invalid worker invocation.");
  }
  const root = workspaceRoot(cwd), nonce = process.env.GROK_COMPANION_WORKER_NONCE;
  let authorized = false;
  let authorizedFence = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const record = readJob(root, id);
    let identity = record.workerProcess;
    const activeDispatchFence = isDispatchV2(record.request?.spawn?.dispatch)
      ? (providedDispatchFence
        ?? Number(process.env.GROK_COMPANION_DISPATCH_FENCE || record.request.spawn.dispatch.fence))
      : null;
    if (terminal(record)) return;
    if (brokerInvocation) {
      const authorization = record.workerAuthorization;
      const dispatch = record.request?.spawn?.dispatch;
      const dispatchFence = activeDispatchFence;
      const intent = record.request?.spawn?.workerSpawnIntent;
      const ownStartToken = processStartToken(process.pid);
      const ownIdentity = {
        pid: process.pid,
        startToken: ownStartToken,
        nonce,
        processGroupId: process.platform === "win32" ? null : process.pid,
        commandMarker: id,
        dispatchAttemptId,
        dispatchFence
      };
      let exactAuthorization = false;
      try {
        if (isDispatchV2(dispatch)) {
          const bound = assertWorkerAuthorization(record, { allowLegacy: false });
          exactAuthorization = bound.nonce === nonce
            && bound.dispatchAttemptId === dispatchAttemptId
            && bound.dispatchFence === dispatchFence;
        } else {
          exactAuthorization = authorization?.schemaVersion === 1
            && authorization.nonce === nonce
            && authorization.purpose === "launch-worker"
            && authorization.ownerThreadId === record.host?.sessionId
            && authorization.dispatchAttemptId === dispatchAttemptId;
        }
      } catch {}
      const commonAuthorization = nonce
        && process.env.GROK_COMPANION_DISPATCH_ATTEMPT === dispatchAttemptId
        && (!isDispatchV2(dispatch)
          || (dispatch.fence === dispatchFence
            && Number(process.env.GROK_COMPANION_DISPATCH_FENCE || dispatchFence) === dispatchFence))
        && currentHost().kind === record.host?.kind
        && currentHost().sessionId === record.host?.sessionId
        && isSupportedWorkerDispatch(dispatch)
        && dispatch.attemptId === dispatchAttemptId
        && intent?.schemaVersion === 1
        && intent.intentId === workerIntentId
        && intent.attemptId === dispatchAttemptId
        && (!isDispatchV2(dispatch) || intent.fence == null || intent.fence === dispatchFence)
        && intent.processKind === "worker"
        && ["pending", "registered"].includes(intent.status)
        && typeof ownStartToken === "string"
        && ownStartToken;
      const firstRegistrationAuthorized = commonAuthorization
        && dispatch.state === "controller-started"
        && intent.status === "pending"
        && exactAuthorization;
      const alreadyRegistered = commonAuthorization
        && dispatch.state === "worker-started"
        && identity?.pid === process.pid
        && identity?.startToken === ownStartToken
        && identity?.nonce === nonce
        && identity?.processGroupId === ownIdentity.processGroupId
        && identity?.commandMarker === id
        && identity?.dispatchAttemptId === dispatchAttemptId
        && (identity?.dispatchFence ?? null) === dispatchFence;
      if (firstRegistrationAuthorized || alreadyRegistered) {
        assertDispatchContract(record);
        const registered = transitionWorkerDispatch({
          root,
          workerId: id,
          attemptId: dispatchAttemptId,
          fence: dispatchFence,
          state: "worker-started",
          workerProcess: ownIdentity,
          spawnIntentId: workerIntentId
        });
        identity = registered.workerProcess;
      }
    }
    if (nonce
      && (!brokerInvocation || (
        process.env.GROK_COMPANION_DISPATCH_ATTEMPT === dispatchAttemptId
        && currentHost().kind === record.host?.kind
        && currentHost().sessionId === record.host?.sessionId
      ))
      && identity?.nonce === nonce
      && identity?.pid === process.pid
      && identity?.startToken === processStartToken(process.pid)
      && (process.platform === "win32"
        ? identity?.processGroupId === null
        : identity?.processGroupId === process.pid)
      && identity?.commandMarker === id
      && (!brokerInvocation || (
        identity.dispatchAttemptId === dispatchAttemptId
        && (identity.dispatchFence ?? null) === activeDispatchFence
        && record.request?.spawn?.dispatch?.attemptId === dispatchAttemptId
        && record.request?.spawn?.dispatch?.state === "worker-started"
      ))) {
      if (brokerInvocation) {
        try {
          assertDispatchContract(record);
        } catch (error) {
          throw error;
        }
      }
      authorized = true;
      authorizedFence = brokerInvocation
        ? (record.request?.spawn?.dispatch?.schemaVersion === 2
            ? (providedDispatchFence ?? Number(process.env.GROK_COMPANION_DISPATCH_FENCE || record.request.spawn.dispatch.fence))
            : null)
        : null;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!authorized) throw new CompanionError("E_RECURSION", "Unauthenticated Grok Companion worker invocation refused.");
  try {
    await execute(root, id, { dispatchAttemptId, dispatchFence: authorizedFence });
  } catch (error) {
    // The executing worker never terminalizes its own still-live process.
    // execute() atomically settles cleanup-safe pre-provider failures; if it
    // could not, the controller/reconciler observes exact process exit and
    // performs loss recovery without replaying the prompt.
    throw error;
  }
  return;
}

async function handleDeepResearchLauncher(raw) {
  const id = raw[0];
  const cwdFlag = raw[1];
  const cwd = raw[2];
  if (raw.length !== 3 || cwdFlag !== "--cwd") {
    throw new CompanionError("E_USAGE", "Invalid deep-research launcher invocation.");
  }
  const root = workspaceRoot(cwd);
  const nonce = process.env.GROK_COMPANION_WORKER_NONCE;
  const record = readJob(root, id);
  if (record.kind !== DEEP_RESEARCH_KIND || record.jobClass !== "research") {
    throw new CompanionError("E_USAGE", "Deep-research launcher requires a deep-research job.");
  }
  if (!nonce || record.workerAuthorization !== nonce) {
    throw new CompanionError("E_RECURSION", "Unauthenticated deep-research worker invocation refused.");
  }
  if (terminal(record)) return;
  if (isCancelRequested(root, id, nonce)) {
    const cleanup = cleanupResearchRuntimeArtifacts(stateDir(root), id, []);
    updateJob(root, id, (current) => {
      if (terminal(current)) return current;
      current.workerAuthorization = null;
      const intendedTerminal = {
        status: "cancelled",
        phase: "cancelled",
        completedAt: now(),
        error: {
          code: "E_CANCELLED",
          message: "Deep-research was cancelled before worker launch."
        }
      };
      if (cleanup.ok) {
        current.status = intendedTerminal.status;
        current.phase = intendedTerminal.phase;
        current.completedAt = intendedTerminal.completedAt;
      } else {
        current.pendingTerminal = {
          ...intendedTerminal,
          summary: intendedTerminal.error.message
        };
        current.status = "running";
        current.phase = "cleanup-blocked";
        current.completedAt = null;
      }
      current.error = intendedTerminal.error;
      current.summary = current.error.message;
      current.progress = cleanup.ok
        ? current.summary
        : "Deep-research cancellation accepted; private query cleanup is pending";
      current.result = applyResearchPrivacy({
        hostVerification: "not_run",
        workflow: null,
        researchReport: null,
        replay: false,
        resume: false
      }, cleanup);
      current.lifecycleEvents = appendLifecycleEvent(current.lifecycleEvents, "blocked", current.error.message);
      return current;
    });
    return;
  }
  // Spawn a detached research worker, record owned identity, then exit so
  // --background returns immediately while wait mode polls durable state.
  const child = spawn(
    process.execPath,
    [SCRIPT, "--deep-research-worker", id, "--cwd", root],
    {
      cwd: root,
      detached: true,
      shell: false,
      stdio: "ignore",
      env: workerEnvironment(nonce)
    }
  );
  const identity = await captureSpawnIdentity(child);
  updateJob(root, id, (current) => {
    if (terminal(current)) return current;
    current.workerAuthorization = null;
    current.workerProcess = { ...identity, nonce, commandMarker: id };
    current.status = "running";
    current.phase = "starting";
    current.startedAt = current.startedAt || now();
    current.summary = "Deep-research worker started";
    current.progress = current.summary;
    return touchJob(current);
  });
  child.unref();
  return;
}

async function handleDeepResearchWorker(raw) {
  const id = raw[0];
  const cwdFlag = raw[1];
  const cwd = raw[2];
  if (raw.length !== 3 || cwdFlag !== "--cwd") {
    throw new CompanionError("E_USAGE", "Invalid deep-research worker invocation.");
  }
  const root = workspaceRoot(cwd);
  const nonce = process.env.GROK_COMPANION_WORKER_NONCE;
  let authorized = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const record = readJob(root, id);
    if (terminal(record)) return;
    if (record.kind !== DEEP_RESEARCH_KIND || record.jobClass !== "research") {
      throw new CompanionError("E_USAGE", "Deep-research worker requires a deep-research job.");
    }
    const identity = record.workerProcess;
    const ownStartToken = processStartToken(process.pid);
    if (
      nonce
      && identity?.nonce === nonce
      && identity?.pid === process.pid
      && identity?.startToken === ownStartToken
      && identity?.commandMarker === id
    ) {
      authorized = true;
      break;
    }
    // First registration window: launcher may still be recording identity.
    if (nonce && (record.workerAuthorization === nonce || identity?.nonce === nonce)) {
      if (!identity?.pid || identity.pid === process.pid) {
        authorized = true;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!authorized) {
    throw new CompanionError("E_RECURSION", "Unauthenticated deep-research worker invocation refused.");
  }
  await executeDeepResearch(root, id);
  return;
}

async function handleInternalCommand(command, raw) {
  if (command === "--launch-worker") return handleLaunchWorker(raw);
  if (command === "--worker") return handleWorker(raw);
  if (command === "--launch-deep-research") return handleDeepResearchLauncher(raw);
  if (command === "--deep-research-worker") return handleDeepResearchWorker(raw);
  throw new CompanionError("E_USAGE", `Unknown internal command ${command}.`);
}

export { handleInternalCommand };
