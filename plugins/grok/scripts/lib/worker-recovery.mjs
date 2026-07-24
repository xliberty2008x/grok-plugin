/**
 * Host-trusted, demand-driven broker recovery. This module may settle or clean
 * an exact lost attempt, but it must never claim, launch, or replay work.
 */
import { CompanionError } from "./errors.mjs";
import { cleanupTaskRuntimeArtifacts } from "./grok-provider.mjs";
import { sameHostSession } from "./host.mjs";
import { processGroupGone, terminateOwnedProcess } from "./process-control.mjs";
import {
  assertProviderGuardForJob,
  loadProviderGuard,
  registerProviderGuard,
  resolveProviderCleanupTarget,
  sameGuardProcessIdentity,
  unregisterProviderGuardInWorkspaceTransaction
} from "./recursion-guard.mjs";
import { isCancelRequested, listJobs, terminal, tryReadJob, updateJob } from "./state.mjs";
import { appendLifecycleEvent } from "./task-contract.mjs";
import {
  assertDispatchContract,
  acquireRecoveryCleanupFence,
  cancellationNonce,
  recordWorkerProviderSpawnNoChild,
  settleFailedDispatchCleanup,
  settleStartedWorkerLoss,
  settleUnstartedDispatchLoss,
  transitionWorkerDispatch,
  verifyRecoveryCleanupFence
} from "./worker-mutation.mjs";
import { workspaceState } from "./workspace.mjs";
import {
  dispatchLeaseExpired,
  isDispatchV2,
  isSupportedWorkerDispatch
} from "./worker-launch-contract.mjs";

export const BROKER_RECOVERY_PRIVILEGE = "host-trusted-reconciler";
export const BROKER_DISPATCH_RECOVERY_GRACE_MS = 5_000;

function dispatchAgeMs(job, clock) {
  const dispatch = job?.request?.spawn?.dispatch;
  const timestamp = Date.parse(
    dispatch?.updatedAt || dispatch?.claimedAt || job?.updatedAt || job?.createdAt || ""
  );
  return Number.isFinite(timestamp) ? Math.max(0, clock() - timestamp) : Infinity;
}

function cleanupBlocked(root, workerId, warning, env) {
  const message = "Worker recovery is blocked because exact runtime cleanup could not be verified.";
  return updateJob(root, workerId, (current) => {
    if (terminal(current)) return current;
    const priorEvents = current.lifecycleEvents || [];
    const alreadyRecorded = priorEvents.some((event) => (
      event.type === "blocked" && event.summary === message
    ));
    return {
      ...current,
      phase: "cleanup-blocked",
      progress: message,
      error: { code: "E_PROCESS_IDENTITY", message },
      result: {
        ...(current.result || {}),
        hostVerification: current.result?.hostVerification || "not_run",
        taskRuntimeCleaned: false,
        privacyWarning: warning || "Runtime cleanup remained incomplete after worker loss."
      },
      lifecycleEvents: alreadyRecorded
        ? priorEvents
        : appendLifecycleEvent(priorEvents, "blocked", message, { replayedPrompt: false })
    };
  }, env);
}

function cleanupTaskRuntime(root, job, providerIdentity, env) {
  let target;
  try {
    target = providerCleanupTarget(root, job);
  } catch {
    return {
      ok: false,
      warning: "Provider ownership metadata is malformed, conflicting, or unreadable."
    };
  }
  if (target.pendingRotation && !target.identity) {
    return {
      ok: false,
      warning: "Replacement provider cleanup identity remains ambiguous."
    };
  }
  if (providerIdentity && target.identity
    && !sameProcessIdentity(providerIdentity, target.identity)) {
    return {
      ok: false,
      warning: "Provider ownership metadata changed before runtime cleanup."
    };
  }
  const cleanupIdentity = providerIdentity || target.identity;
  let cleanup = cleanupTaskRuntimeArtifacts(
    workspaceState(root, env),
    job.request?.providerHomeId || job.id,
    [cleanupIdentity, job.workerProcess].filter(Boolean)
  );
  if (cleanup.ok && target.guardRecord) {
    try { unregisterProviderGuardInWorkspaceTransaction(root, job.id, target.guardRecord); }
    catch {
      cleanup = {
        ok: false,
        warning: "Runtime cleanup remained incomplete because provider ownership metadata could not be removed."
      };
    }
  }
  return cleanup;
}

function sameProcessIdentity(left, right) {
  return Boolean(left?.pid
    && right?.pid
    && left.pid === right.pid
    && left.startToken === right.startToken
    && left.processGroupId === right.processGroupId);
}

function sameBoundWorkerIdentity(left, right) {
  return sameProcessIdentity(left, right)
    && left.nonce === right.nonce
    && left.commandMarker === right.commandMarker
    && left.dispatchAttemptId === right.dispatchAttemptId
    && left.dispatchFence === right.dispatchFence;
}

function sameBoundProviderIdentity(left, right) {
  return sameProcessIdentity(left, right)
    && left.commandMarker === right.commandMarker
    && left.dispatchAttemptId === right.dispatchAttemptId
    && left.dispatchFence === right.dispatchFence
    && left.providerGeneration === right.providerGeneration;
}

async function terminateWithRecoveryFence({
  root,
  job,
  source,
  expectedProcessIdentity,
  env,
  testHooks = null
}) {
  const dispatch = job?.request?.spawn?.dispatch;
  const claimed = acquireRecoveryCleanupFence({
    root,
    workerId: job.id,
    attemptId: dispatch?.attemptId,
    fence: dispatch?.fence,
    source,
    expectedDispatchState: dispatch?.state,
    expectedProcessIdentity,
    env
  });
  await testHooks?.afterCleanupFenceClaimed?.(claimed);
  await testHooks?.beforeCleanupSignal?.(claimed);
  const authority = verifyRecoveryCleanupFence({
    root,
    workerId: job.id,
    fenceId: claimed.fenceId,
    expectedProcessIdentity,
    env
  });
  const processIdentity = authority.processIdentity;
  if (authority.mode === "signal" && !processGroupGone(processIdentity)) {
    await terminateOwnedProcess(processIdentity, job.id, authority.processKind);
  }
  if (!processGroupGone(processIdentity)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Recovery cleanup remains incomplete.");
  }
  return authority;
}

function providerCleanupTarget(root, job) {
  const dispatch = job?.request?.spawn?.dispatch;
  const guard = loadProviderGuard(root, job.id);
  if (isDispatchV2(dispatch)) {
    const expectedGeneration = Number.isSafeInteger(dispatch.nextProviderGeneration)
      ? dispatch.nextProviderGeneration
      : job.providerProcess?.providerGeneration
        || (dispatch.state === "worker-started" ? (dispatch.providerGeneration || 0) + 1 : null);
    const boundGuard = guard
      ? assertProviderGuardForJob(root, job, guard, { expectedGeneration })
      : null;
    const guarded = boundGuard?.providerProcess || null;
    if (Number.isSafeInteger(dispatch.nextProviderGeneration)) {
      if (!guarded || sameProcessIdentity(guarded, job.providerProcess)) {
        return {
          identity: null,
          kind: "provider",
          pendingRotation: true,
          guardRecord: boundGuard
        };
      }
      return {
        identity: guarded,
        kind: "provider",
        pendingRotation: true,
        guardRecord: boundGuard
      };
    }
    if (job.providerProcess?.pid) {
      if (guarded && !sameProcessIdentity(guarded, job.providerProcess)) {
        throw new CompanionError(
          "E_PROCESS_IDENTITY",
          "Provider guard does not match the durable provider generation."
        );
      }
      return {
        identity: job.providerProcess,
        kind: "provider",
        pendingRotation: false,
        guardRecord: boundGuard
      };
    }
    return {
      identity: guarded,
      kind: "provider",
      pendingRotation: false,
      guardRecord: boundGuard
    };
  }
  if (Number.isSafeInteger(dispatch?.nextProviderGeneration)) {
    const guarded = guard?.schemaVersion === 1
      && guard.marker === job.id
      && guard.providerProcess?.pid
      ? guard.providerProcess
      : null;
    // While a provider rotation is authorized but not durably published, the
    // prior job.providerProcess is stale by definition. Only a distinct guard
    // identity can prove the replacement process that must be cleaned.
    if (!guarded || sameProcessIdentity(guarded, job.providerProcess)) {
      return { identity: null, kind: "provider", pendingRotation: true, guardRecord: guard };
    }
    return {
      identity: guarded,
      kind: guard.identityKind === "import" ? "import" : "provider",
      pendingRotation: true,
      guardRecord: guard
    };
  }
  const target = resolveProviderCleanupTarget(root, job);
  if (guard?.providerProcess && target.identity
    && !sameGuardProcessIdentity(guard.providerProcess, target.identity)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Provider guard conflicts with the durable provider identity.");
  }
  return { ...target, pendingRotation: false, guardRecord: guard };
}

function cancelledBeforeProviderIntent(root, job, env) {
  const nonce = cancellationNonce(job);
  if (!nonce || !isCancelRequested(root, job.id, nonce, env)) return null;
  return {
    status: "cancelled",
    phase: "cancelled",
    summary: "Cancelled",
    error: {
      code: "E_CANCELLED",
      message: "Grok job was cancelled before provider startup."
    }
  };
}

function pendingTerminalIntent(job) {
  const pending = job?.pendingTerminal;
  if (!pending || !["failed", "cancelled"].includes(pending.status)) return null;
  return {
    status: pending.status,
    phase: typeof pending.phase === "string" ? pending.phase : pending.status,
    summary: pending.summary || (pending.status === "cancelled" ? "Cancelled" : "Worker launch failed"),
    error: pending.error?.code && pending.error?.message
      ? pending.error
      : {
          code: pending.status === "cancelled" ? "E_CANCELLED" : "E_WORKER_LOST",
          message: pending.status === "cancelled"
            ? "Grok job was cancelled before provider startup."
            : "Worker controller launch failed."
        }
  };
}

function reconcileProviderSpawnBoundary(root, job, providerGeneration, env) {
  const dispatch = job?.request?.spawn?.dispatch;
  const intent = job?.request?.spawn?.providerSpawnIntent;
  if (!intent || intent.providerGeneration !== providerGeneration) {
    return { job, identity: null, intent: null, legacy: true, noChild: false };
  }
  let guard;
  try { guard = loadProviderGuard(root, job.id); }
  catch {
    throw new CompanionError("E_PROCESS_IDENTITY", "Provider guard aliases are malformed or conflicting.");
  }
  if (!guard) {
    if (intent.status === "pending") {
      const settled = recordWorkerProviderSpawnNoChild({
        root,
        workerId: job.id,
        attemptId: dispatch.attemptId,
        fence: dispatch.fence,
        providerGeneration,
        intentId: intent.intentId,
        resolution: "authorization-revoked",
        env
      });
      return { job: settled, identity: null, intent: settled.request.spawn.providerSpawnIntent, legacy: false, noChild: true };
    }
    if (intent.status === "no-child") {
      return { job, identity: null, intent, legacy: false, noChild: true };
    }
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Registered provider ownership metadata disappeared before recovery."
    );
  }
  const authenticated = assertProviderGuardForJob(root, job, guard, {
    expectedGeneration: providerGeneration
  });
  if (authenticated.schemaVersion !== 3
    || authenticated.providerSpawnIntentId !== intent.intentId) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Provider guard is not bound to the active spawn intent.");
  }
  if (processGroupGone(authenticated.providerProcess)) {
    const settled = recordWorkerProviderSpawnNoChild({
      root,
      workerId: job.id,
      attemptId: dispatch.attemptId,
      fence: dispatch.fence,
      providerGeneration,
      intentId: intent.intentId,
      resolution: "cleanup-proven",
      env
    });
    return { job: settled, identity: null, intent: settled.request.spawn.providerSpawnIntent, legacy: false, noChild: true };
  }
  let registeredJob = job;
  if (intent.status === "pending") {
    registerProviderGuard(
      root,
      job.id,
      authenticated.providerProcess,
      job.host?.sessionId,
      "provider",
      {
        controlWorkspaceId: job.controlWorkspaceId,
        executionRoot: job.request?.spawn?.executionRoot,
        dispatchAttemptId: dispatch.attemptId,
        dispatchFence: dispatch.fence,
        providerGeneration,
        providerSpawnIntentId: intent.intentId
      },
      env
    );
    registeredJob = tryReadJob(root, job.id, env);
  }
  return {
    job: registeredJob,
    identity: authenticated.providerProcess,
    intent: registeredJob.request.spawn.providerSpawnIntent,
    legacy: false,
    noChild: false
  };
}

function promotePendingProviderRotation(root, job, providerIdentity, env) {
  const dispatch = job.request?.spawn?.dispatch;
  if (!Number.isSafeInteger(dispatch?.nextProviderGeneration)) return job;
  const providerProcess = {
    pid: providerIdentity?.pid,
    startToken: providerIdentity?.startToken,
    processGroupId: providerIdentity?.processGroupId,
    commandMarker: job.id,
    dispatchAttemptId: dispatch.attemptId,
    dispatchFence: isDispatchV2(dispatch) ? dispatch.fence : undefined,
    providerGeneration: dispatch.nextProviderGeneration
  };
  // This transition is the durable crash witness. Once it commits, recovery
  // can restart after guard removal using job.providerProcess generation 2.
  return transitionWorkerDispatch({
    root,
    workerId: job.id,
    attemptId: dispatch.attemptId,
    fence: isDispatchV2(dispatch) ? dispatch.fence : null,
    state: "provider-started",
    providerProcess,
    spawnIntentId: job.request?.spawn?.providerSpawnIntent?.intentId,
    env
  });
}

/** Shared provider-started loss recovery used by the controller and MCP wait. */
export async function recoverLostProviderStartedWorker({
  root,
  workerId,
  attemptId,
  workerProcess,
  controllerProcess = null,
  requireControllerGone = false,
  reconciler = false,
  testHooks = null,
  env = process.env
} = {}) {
  let current = tryReadJob(root, workerId, env);
  if (!current || terminal(current)) return { action: "none", reason: "terminal" };
  const dispatch = current.request?.spawn?.dispatch;
  if (!isSupportedWorkerDispatch(dispatch)
    || dispatch.attemptId !== attemptId
    || dispatch.state !== "provider-started") {
    return { action: "none", reason: "dispatch-changed" };
  }
  if (isDispatchV2(dispatch)) assertDispatchContract(current);
  if (!sameBoundWorkerIdentity(current.workerProcess, workerProcess)) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Recovery worker witness does not match the durable dispatch."
    );
  }
  if (requireControllerGone
    && !sameBoundWorkerIdentity(current.controllerProcess, controllerProcess)) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Recovery controller witness does not match the durable dispatch."
    );
  }
  if (requireControllerGone && (!controllerProcess || !processGroupGone(controllerProcess))) {
    return { action: "none", reason: "controller-alive-or-unverifiable" };
  }
  if (!workerProcess || !processGroupGone(workerProcess)) {
    return { action: "none", reason: "worker-alive-or-unverifiable" };
  }
  const restoringTerminalIntent = Boolean(current.pendingTerminal);
  if (restoringTerminalIntent && !requireControllerGone) {
    // A live controller cannot attest its own process-group teardown. Leave
    // the durable intent untouched; host recovery will settle it after the
    // controller, worker, and provider groups are all verified gone.
    return { action: "none", reason: "controller-exit-required-for-terminal-intent" };
  }

  if (Number.isSafeInteger(dispatch.nextProviderGeneration)
    && current.request?.spawn?.providerSpawnIntent?.providerGeneration === dispatch.nextProviderGeneration) {
    let boundary;
    try {
      boundary = reconcileProviderSpawnBoundary(
        root,
        current,
        dispatch.nextProviderGeneration,
        env
      );
      current = boundary.job;
      if (boundary.identity) {
        current = promotePendingProviderRotation(root, current, boundary.identity, env);
      }
    } catch {
      cleanupBlocked(root, workerId, "Replacement provider spawn boundary could not be reconciled exactly.", env);
      return { action: "cleanup-blocked", reason: "provider-rotation-promotion-failed" };
    }
  }
  let { identity: providerIdentity, pendingRotation } = providerCleanupTarget(root, current);
  if (!providerIdentity) {
    cleanupBlocked(
      root,
      workerId,
      pendingRotation
        ? "Replacement provider launch is unsettled and its cleanup identity is unavailable."
        : "Provider cleanup identity is unavailable.",
      env
    );
    return {
      action: "cleanup-blocked",
      reason: pendingRotation ? "provider-rotation-unsettled" : "provider-identity-unavailable"
    };
  }
  if (pendingRotation) {
    try {
      current = promotePendingProviderRotation(root, current, providerIdentity, env);
      ({ identity: providerIdentity } = providerCleanupTarget(root, current));
      if (isDispatchV2(current.request?.spawn?.dispatch)) assertDispatchContract(current);
    } catch {
      cleanupBlocked(root, workerId, "Replacement provider identity could not be durably promoted before cleanup.", env);
      return { action: "cleanup-blocked", reason: "provider-rotation-promotion-failed" };
    }
  }
  const beforeSignal = tryReadJob(root, workerId, env);
  if (!beforeSignal || terminal(beforeSignal)) return { action: "none", reason: "terminal" };
  if (isDispatchV2(beforeSignal.request?.spawn?.dispatch)) assertDispatchContract(beforeSignal);
  if (!sameBoundWorkerIdentity(beforeSignal.workerProcess, workerProcess)
    || (requireControllerGone
      && !sameBoundWorkerIdentity(beforeSignal.controllerProcess, controllerProcess))
    || !sameBoundProviderIdentity(beforeSignal.providerProcess, providerIdentity)) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Recovery process authority changed before provider cleanup."
    );
  }
  current = beforeSignal;
  let cleanupAuthority;
  try {
    cleanupAuthority = await terminateWithRecoveryFence({
      root,
      job: current,
      source: "provider-generation",
      expectedProcessIdentity: providerIdentity,
      env,
      testHooks
    });
    providerIdentity = cleanupAuthority.processIdentity;
  } catch {
    cleanupBlocked(root, workerId, "Provider process-group cleanup could not be verified.", env);
    return { action: "cleanup-blocked", reason: "provider-cleanup-unverified" };
  }

  let settled;
  try {
    settled = settleStartedWorkerLoss({
      root,
      workerId,
      attemptId,
      workerProcess,
      controllerProcess: requireControllerGone ? controllerProcess : null,
      providerProcess: providerIdentity,
      cleanupFenceId: cleanupAuthority.fenceId,
      reconciler,
      runtimeCleanup: (latest) => cleanupTaskRuntime(root, latest, providerIdentity, env),
      env
    });
  } catch (error) {
    if (error?.code !== "E_RUNTIME_CLEANUP") throw error;
    cleanupBlocked(root, workerId, error.details?.warning, env);
    return { action: "cleanup-blocked", reason: "runtime-cleanup-incomplete" };
  }
  return restoringTerminalIntent
    ? { action: "terminalized", reason: "pending-terminal-restored", job: settled }
    : { action: "marked-lost", reason: "worker-process-not-alive", job: settled };
}

/**
 * Reconcile only jobs owned by the attested Codex task. The caller supplies no
 * prompt, launch adapter, or model-authored authority.
 */
export async function reconcileBrokerWorkers({
  root,
  principal,
  clock = () => Date.now(),
  dispatchStartupGraceMs = BROKER_DISPATCH_RECOVERY_GRACE_MS,
  testHooks = null,
  env = process.env
} = {}) {
  if (principal?.hostKind !== "codex" || !principal.threadId) {
    throw new CompanionError("E_AUTH_REQUIRED", "Trusted Codex task identity is unavailable.");
  }
  if (!Number.isFinite(dispatchStartupGraceMs) || dispatchStartupGraceMs < 0) {
    throw new CompanionError("E_USAGE", "Worker recovery grace must be a non-negative duration.");
  }
  const host = { kind: "codex", sessionId: principal.threadId };
  const results = [];

  for (const snapshot of listJobs(root, env).filter((job) => sameHostSession(job, host))) {
    await testHooks?.afterSnapshotSelected?.(snapshot);
    if (terminal(snapshot)) {
      results.push({ workerId: snapshot.id, action: "none", reason: "terminal" });
      continue;
    }
    const dispatch = snapshot.request?.spawn?.dispatch;
    if (!isSupportedWorkerDispatch(dispatch)) {
      results.push({ workerId: snapshot.id, action: "none", reason: "not-broker-dispatch" });
      continue;
    }
    if (isDispatchV2(dispatch)) assertDispatchContract(snapshot);
    if (dispatch.state === "pending" && !dispatch.attemptId) {
      results.push({ workerId: snapshot.id, action: "none", reason: "dispatch-pending-recoverable" });
      continue;
    }
    if (dispatchAgeMs(snapshot, clock) < dispatchStartupGraceMs) {
      results.push({ workerId: snapshot.id, action: "none", reason: "dispatch-startup-grace" });
      continue;
    }

    if (snapshot.request?.spawn?.controllerCleanupPending) {
      const cleanupProcess = snapshot.request.spawn.controllerCleanupProcess || null;
      if (!cleanupProcess) {
        cleanupBlocked(root, snapshot.id, "Controller cleanup is pending without a durable process witness.", env);
        results.push({ workerId: snapshot.id, action: "cleanup-blocked", reason: "controller-cleanup-witness-missing" });
        continue;
      }
      let cleanupAuthority;
      try {
        cleanupAuthority = await terminateWithRecoveryFence({
          root,
          job: snapshot,
          source: "controller-cleanup",
          expectedProcessIdentity: cleanupProcess,
          env,
          testHooks
        });
      } catch {
        cleanupBlocked(root, snapshot.id, "Controller process-group cleanup could not be verified.", env);
        results.push({ workerId: snapshot.id, action: "cleanup-blocked", reason: "controller-cleanup-unverified" });
        continue;
      }
      const fencedCleanupProcess = cleanupAuthority.processIdentity;
      if (!["claimed", "controller-started"].includes(dispatch.state)) {
        cleanupBlocked(root, snapshot.id, "Controller cleanup witness no longer matches a pre-worker dispatch.", env);
        results.push({ workerId: snapshot.id, action: "cleanup-blocked", reason: "controller-cleanup-state-changed" });
        continue;
      }
      try {
        const job = settleUnstartedDispatchLoss({
          root,
          workerId: snapshot.id,
          attemptId: dispatch.attemptId,
          dispatchState: dispatch.state,
          controllerProcess: dispatch.state === "controller-started" ? snapshot.controllerProcess : null,
          controllerCleanupProcess: fencedCleanupProcess,
          cleanupFenceId: cleanupAuthority.fenceId,
          terminalIntent: pendingTerminalIntent(snapshot)
            || cancelledBeforeProviderIntent(root, snapshot, env),
          runtimeCleanup: (latest) => cleanupTaskRuntime(root, latest, null, env),
          env
        });
        results.push({ workerId: snapshot.id, action: "terminalized", reason: "controller-cleanup-completed", job });
      } catch (error) {
        if (error?.code === "E_RUNTIME_CLEANUP") {
          cleanupBlocked(root, snapshot.id, error.details?.warning, env);
          results.push({ workerId: snapshot.id, action: "cleanup-blocked", reason: "runtime-cleanup-incomplete" });
          continue;
        }
        if (error?.code === "E_PROCESS_IDENTITY" || error?.code === "E_STATE") {
          results.push({ workerId: snapshot.id, action: "none", reason: "dispatch-settled-concurrently" });
        } else throw error;
      }
      continue;
    }

    if (dispatch.state === "failed" && snapshot.phase === "cleanup-blocked" && snapshot.pendingTerminal) {
      const controllerProcess = snapshot.controllerProcess;
      const workerProcess = snapshot.workerProcess;
      if (!controllerProcess || !workerProcess
        || !processGroupGone(controllerProcess)
        || !processGroupGone(workerProcess)) {
        results.push({ workerId: snapshot.id, action: "none", reason: "cleanup-process-alive-or-unverifiable" });
        continue;
      }
      let providerIdentity = snapshot.providerProcess?.pid ? snapshot.providerProcess : null;
      if (!providerIdentity) {
        const target = providerCleanupTarget(root, snapshot);
        providerIdentity = target.identity;
      }
      if (providerIdentity && !snapshot.providerProcess?.pid) {
        cleanupBlocked(root, snapshot.id, "A provider guard exists without an attempt-bound durable cleanup witness.", env);
        results.push({ workerId: snapshot.id, action: "cleanup-blocked", reason: "provider-witness-not-durable" });
        continue;
      }
      if (!providerIdentity && snapshot.request?.spawn?.providerLaunchOutcome !== "not-launched") {
        cleanupBlocked(root, snapshot.id, "Provider launch outcome remains ambiguous.", env);
        results.push({ workerId: snapshot.id, action: "cleanup-blocked", reason: "provider-launch-ambiguous" });
        continue;
      }
      let cleanupAuthority = null;
      if (providerIdentity) {
        try {
          cleanupAuthority = await terminateWithRecoveryFence({
            root,
            job: snapshot,
            source: "provider-generation",
            expectedProcessIdentity: providerIdentity,
            env,
            testHooks
          });
          providerIdentity = cleanupAuthority.processIdentity;
        } catch {
          const unsettledLive = providerIdentity?.startToken === null && !processGroupGone(providerIdentity);
          cleanupBlocked(
            root,
            snapshot.id,
            unsettledLive
              ? "Provider group is still live without a verified birth token; it was not signalled."
              : "Provider process-group cleanup could not be verified.",
            env
          );
          results.push({
            workerId: snapshot.id,
            action: "cleanup-blocked",
            reason: unsettledLive ? "unsettled-provider-alive" : "provider-cleanup-unverified"
          });
          continue;
        }
      }
      try {
        const job = settleFailedDispatchCleanup({
          root,
          workerId: snapshot.id,
          attemptId: dispatch.attemptId,
          controllerProcess,
          workerProcess,
          providerProcess: snapshot.providerProcess?.pid ? snapshot.providerProcess : null,
          cleanupFenceId: cleanupAuthority?.fenceId || null,
          runtimeCleanup: (latest) => cleanupTaskRuntime(root, latest, providerIdentity, env),
          reconciler: true,
          env
        });
        results.push({ workerId: snapshot.id, action: "terminalized", reason: "cleanup-completed", job });
      } catch (error) {
        if (error?.code === "E_RUNTIME_CLEANUP") {
          cleanupBlocked(root, snapshot.id, error.details?.warning, env);
          results.push({ workerId: snapshot.id, action: "cleanup-blocked", reason: "runtime-cleanup-incomplete" });
          continue;
        }
        if (error?.code === "E_PROCESS_IDENTITY" || error?.code === "E_STATE") {
          results.push({ workerId: snapshot.id, action: "none", reason: "dispatch-settled-concurrently" });
        } else throw error;
      }
      continue;
    }

    if (dispatch.state === "claimed") {
      const controllerIntent = snapshot.request?.spawn?.controllerSpawnIntent;
      if (isDispatchV2(dispatch) && !controllerIntent && !snapshot.controllerProcess?.pid) {
        const cancellationIntent = cancelledBeforeProviderIntent(root, snapshot, env);
        if (cancellationIntent && dispatchLeaseExpired(dispatch, clock())) {
          let guard = null;
          try { guard = loadProviderGuard(root, snapshot.id); }
          catch { guard = { malformed: true }; }
          if (guard) {
            results.push({
              workerId: snapshot.id,
              action: "none",
              reason: "abandoned-claim-provider-guard-ambiguous"
            });
            continue;
          }
          try {
            const job = settleUnstartedDispatchLoss({
              root,
              workerId: snapshot.id,
              attemptId: dispatch.attemptId,
              dispatchState: "claimed",
              terminalIntent: cancellationIntent,
              runtimeCleanup: (latest) => cleanupTaskRuntime(root, latest, null, env),
              env
            });
            results.push({
              workerId: snapshot.id,
              action: "terminalized",
              reason: "abandoned-claim-cancelled",
              job
            });
          } catch (error) {
            if (error?.code === "E_RUNTIME_CLEANUP") {
              cleanupBlocked(root, snapshot.id, error.details?.warning, env);
              results.push({ workerId: snapshot.id, action: "cleanup-blocked", reason: "runtime-cleanup-incomplete" });
            } else if (error?.code === "E_PROCESS_IDENTITY" || error?.code === "E_STATE") {
              results.push({ workerId: snapshot.id, action: "none", reason: "dispatch-settled-concurrently" });
            } else throw error;
          }
          continue;
        }
        // A live or uncancelled v2 lease with no durable spawn intent is an
        // outbox claim, not evidence that a child existed. Authority-bound
        // dispatch may reclaim it only after expiry; recovery never replays it.
        results.push({
          workerId: snapshot.id,
          action: "none",
          reason: "dispatch-lease-recoverable"
        });
        continue;
      }
      if (controllerIntent && controllerIntent.status !== "no-child") {
        // The broker crossed spawn(2)'s durable boundary but died before a
        // child identity or a definitive no-child outcome was published. Do
        // not signal, clean runtime state, terminalize, or replay the prompt.
        results.push({
          workerId: snapshot.id,
          action: "none",
          reason: "controller-startup-intent-ambiguous"
        });
        continue;
      }
      try {
        const job = settleUnstartedDispatchLoss({
          root,
          workerId: snapshot.id,
          attemptId: dispatch.attemptId,
          dispatchState: "claimed",
          terminalIntent: cancelledBeforeProviderIntent(root, snapshot, env),
          runtimeCleanup: (latest) => cleanupTaskRuntime(root, latest, null, env),
          env
        });
        results.push({ workerId: snapshot.id, action: "marked-lost", reason: "claimed-attempt-lost", job });
      } catch (error) {
        if (error?.code === "E_RUNTIME_CLEANUP") {
          cleanupBlocked(root, snapshot.id, error.details?.warning, env);
          results.push({ workerId: snapshot.id, action: "cleanup-blocked", reason: "runtime-cleanup-incomplete" });
        } else if (error?.code === "E_PROCESS_IDENTITY" || error?.code === "E_STATE") {
          results.push({ workerId: snapshot.id, action: "none", reason: "dispatch-settled-concurrently" });
        } else throw error;
      }
      continue;
    }

    const controllerProcess = snapshot.controllerProcess;
    if (!controllerProcess || !processGroupGone(controllerProcess)) {
      results.push({ workerId: snapshot.id, action: "none", reason: "controller-alive-or-unverifiable" });
      continue;
    }
    if (dispatch.state === "controller-started") {
      const unsettledWorkerProcess = snapshot.request?.spawn?.unsettledWorkerProcess || null;
      const workerIntent = snapshot.request?.spawn?.workerSpawnIntent;
      if (workerIntent
        && workerIntent.status !== "no-child"
        && !snapshot.workerProcess?.pid
        && !unsettledWorkerProcess) {
        // The controller may have created a child which has not yet run its
        // self-registration. With no exact identity there is no signal or
        // terminal authority; leave the attempt live and non-replayable.
        results.push({
          workerId: snapshot.id,
          action: "none",
          reason: "worker-startup-intent-ambiguous"
        });
        continue;
      }
      let cleanupAuthority = null;
      if (unsettledWorkerProcess) {
        try {
          cleanupAuthority = await terminateWithRecoveryFence({
            root,
            job: snapshot,
            source: "unsettled-worker",
            expectedProcessIdentity: unsettledWorkerProcess,
            env,
            testHooks
          });
        } catch {
          cleanupBlocked(root, snapshot.id, "Worker child process-group cleanup could not be verified.", env);
          results.push({ workerId: snapshot.id, action: "cleanup-blocked", reason: "worker-child-cleanup-unverified" });
          continue;
        }
      }
      try {
        const job = settleUnstartedDispatchLoss({
          root,
          workerId: snapshot.id,
          attemptId: dispatch.attemptId,
          dispatchState: "controller-started",
          controllerProcess,
          unsettledWorkerProcess: cleanupAuthority?.processIdentity || unsettledWorkerProcess,
          cleanupFenceId: cleanupAuthority?.fenceId || null,
          terminalIntent: cancelledBeforeProviderIntent(root, snapshot, env),
          runtimeCleanup: (latest) => cleanupTaskRuntime(root, latest, null, env),
          env
        });
        results.push({ workerId: snapshot.id, action: "marked-lost", reason: "controller-process-not-alive", job });
      } catch (error) {
        if (error?.code === "E_RUNTIME_CLEANUP") {
          cleanupBlocked(root, snapshot.id, error.details?.warning, env);
          results.push({ workerId: snapshot.id, action: "cleanup-blocked", reason: "runtime-cleanup-incomplete" });
          continue;
        }
        if (error?.code === "E_PROCESS_IDENTITY" || error?.code === "E_STATE") {
          results.push({ workerId: snapshot.id, action: "none", reason: "dispatch-settled-concurrently" });
        } else throw error;
      }
      continue;
    }

    const workerProcess = snapshot.workerProcess;
    if (!workerProcess || !processGroupGone(workerProcess)) {
      results.push({ workerId: snapshot.id, action: "none", reason: "worker-alive-or-unverifiable" });
      continue;
    }
    if (dispatch.state === "worker-started") {
      let workingSnapshot = snapshot;
      let providerBoundary = null;
      if (snapshot.request?.spawn?.providerSpawnIntent?.providerGeneration === 1) {
        try {
          providerBoundary = reconcileProviderSpawnBoundary(root, snapshot, 1, env);
          workingSnapshot = providerBoundary.job;
        } catch {
          cleanupBlocked(root, snapshot.id, "Provider spawn boundary could not be reconciled exactly.", env);
          results.push({ workerId: snapshot.id, action: "cleanup-blocked", reason: "provider-spawn-boundary-invalid" });
          continue;
        }
      }
      let { identity: providerIdentity } = providerBoundary?.legacy === false
        ? { identity: providerBoundary.identity }
        : providerCleanupTarget(root, workingSnapshot);
      if (providerIdentity?.startToken && !workingSnapshot.providerProcess?.pid) {
        try {
          transitionWorkerDispatch({
            root,
            workerId: workingSnapshot.id,
            attemptId: dispatch.attemptId,
            fence: isDispatchV2(dispatch) ? dispatch.fence : null,
            state: "provider-started",
            providerProcess: {
              pid: providerIdentity.pid,
              startToken: providerIdentity.startToken,
              processGroupId: providerIdentity.processGroupId,
              commandMarker: workingSnapshot.id,
              dispatchAttemptId: dispatch.attemptId,
              dispatchFence: isDispatchV2(dispatch) ? dispatch.fence : undefined,
              providerGeneration: 1
            },
            spawnIntentId: workingSnapshot.request?.spawn?.providerSpawnIntent?.intentId,
            env
          });
          const recovered = await recoverLostProviderStartedWorker({
            root,
            workerId: snapshot.id,
            attemptId: dispatch.attemptId,
            workerProcess,
            controllerProcess,
            requireControllerGone: true,
            reconciler: true,
            testHooks,
            env
          });
          results.push({ workerId: snapshot.id, ...recovered });
        } catch {
          cleanupBlocked(root, snapshot.id, "Provider guard identity could not be durably promoted before cleanup.", env);
          results.push({ workerId: snapshot.id, action: "cleanup-blocked", reason: "provider-promotion-failed" });
        }
        continue;
      }
      const explicitlyNotLaunched = !providerIdentity
        && workingSnapshot.request?.spawn?.providerLaunchOutcome === "not-launched";
      if (!providerIdentity && !explicitlyNotLaunched) {
        cleanupBlocked(root, snapshot.id, "Provider launch outcome is ambiguous and no cleanup identity is available.", env);
        results.push({ workerId: snapshot.id, action: "cleanup-blocked", reason: "provider-launch-ambiguous" });
        continue;
      }
      let cleanupAuthority = null;
      if (providerIdentity) {
        try {
          cleanupAuthority = await terminateWithRecoveryFence({
            root,
            job: workingSnapshot,
            source: "provider-generation",
            expectedProcessIdentity: providerIdentity,
            env,
            testHooks
          });
          providerIdentity = cleanupAuthority.processIdentity;
        } catch {
          const unsettledLive = providerIdentity?.startToken === null && !processGroupGone(providerIdentity);
          cleanupBlocked(
            root,
            snapshot.id,
            unsettledLive
              ? "Provider group is still live without a verified birth token; it was not signalled."
              : "Provider process-group cleanup could not be verified.",
            env
          );
          results.push({
            workerId: snapshot.id,
            action: "cleanup-blocked",
            reason: unsettledLive ? "unsettled-provider-alive" : "provider-cleanup-unverified"
          });
          continue;
        }
      }
      try {
        const job = settleUnstartedDispatchLoss({
          root,
          workerId: snapshot.id,
          attemptId: dispatch.attemptId,
          dispatchState: "worker-started",
          controllerProcess,
          workerProcess,
          unsettledProviderProcess: workingSnapshot.providerProcess?.pid ? workingSnapshot.providerProcess : null,
          cleanupFenceId: cleanupAuthority?.fenceId || null,
          terminalIntent: cancelledBeforeProviderIntent(root, workingSnapshot, env),
          runtimeCleanup: (latest) => cleanupTaskRuntime(root, latest, providerIdentity, env),
          env
        });
        results.push({ workerId: snapshot.id, action: "marked-lost", reason: "worker-process-not-alive", job });
      } catch (error) {
        if (error?.code === "E_RUNTIME_CLEANUP") {
          cleanupBlocked(root, snapshot.id, error.details?.warning, env);
          results.push({ workerId: snapshot.id, action: "cleanup-blocked", reason: "runtime-cleanup-incomplete" });
        } else if (error?.code === "E_PROCESS_IDENTITY" || error?.code === "E_STATE") {
          results.push({ workerId: snapshot.id, action: "none", reason: "dispatch-settled-concurrently" });
        } else throw error;
      }
      continue;
    }
    if (dispatch.state === "provider-started") {
      const recovered = await recoverLostProviderStartedWorker({
        root,
        workerId: snapshot.id,
        attemptId: dispatch.attemptId,
        workerProcess,
        controllerProcess,
        requireControllerGone: true,
        reconciler: true,
        testHooks,
        env
      });
      results.push({ workerId: snapshot.id, ...recovered });
      continue;
    }
    results.push({ workerId: snapshot.id, action: "none", reason: "dispatch-settled" });
  }
  return Object.freeze({ privilege: BROKER_RECOVERY_PRIVILEGE, replayedPrompt: false, results });
}
