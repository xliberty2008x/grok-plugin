/** Issue #56 worker-mutation dispatch-admission domain. */
import crypto from "node:crypto";
import { CompanionError, asErrorPayload } from "./errors.mjs";
import {
  generateId,
  isCancelRequested,
  now,
  readPrivateJsonFile,
  tryReadJob,
  writePrivateJsonFile,
  ensurePrivateStateDirectory,
  withWorkspaceStateTransaction
} from "./state.mjs";
import { appendLifecycleEvent } from "./task-lifecycle.mjs";
import { processGroupGone, processStartToken } from "./process-control.mjs";
import {
  assertProviderGuardForJob,
  loadProviderGuard,
  unregisterProviderGuardInWorkspaceTransaction
} from "./recursion-guard.mjs";
import {
  DEFAULT_DISPATCH_LEASE_MS,
  WORKER_DISPATCH_OUTBOX_SCHEMA_VERSION,
  assertDispatchFence,
  assertDispatchV2,
  assertDispatchV2Structure,
  assertWorkerAuthorization,
  bindWorkerAuthorizationAttempt,
  createDispatchOutbox,
  createWorkerAuthorization,
  dispatchLeaseExpired,
  isDispatchV2,
  isSupportedWorkerDispatch,
  launchContractDigest,
  providerLaunchBindingForJob
} from "./worker-launch-contract.mjs";
import {
  BOUND_PROVIDER_SPAWN_INTENT_SCHEMA_VERSION,
  PROVIDER_SPAWN_INTENT_SCHEMA_VERSION,
  RECOVERY_CLEANUP_FENCE_SCHEMA_VERSION,
  WORKER_SPAWN_INTENT_SCHEMA_VERSION,
  assertDispatchContract,
  assertNoRecoveryCleanupFence,
  assertProviderSpawnIntentContract,
  assertRecoveryCleanupFenceContract,
  providerSpawnIntentBindingFields,
  recoveryCleanupSource,
  terminalJob
} from "./worker-mutation-dispatch-contract.mjs";
import {
  cancellationNonce,
  sameDispatchProcessWitness
} from "./worker-mutation-primitives.mjs";

export function acquireRecoveryCleanupFence({
  root,
  workerId,
  attemptId,
  fence = null,
  source,
  expectedDispatchState,
  expectedProcessIdentity,
  env = process.env
} = {}) {
  if (!root
    || !workerId
    || !attemptId
    || !["controller-cleanup", "unsettled-worker", "provider-generation"].includes(source)
    || typeof expectedDispatchState !== "string"
    || !expectedProcessIdentity) {
    throw new CompanionError("E_USAGE", "Recovery cleanup requires an exact durable process expectation.");
  }
  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    if (terminalJob(current)) {
      throw new CompanionError("E_STATE", "Terminal worker cannot acquire recovery cleanup authority.");
    }
    assertDispatchContract(current);
    const dispatch = current.request?.spawn?.dispatch;
    const durableSource = recoveryCleanupSource(current, source);
    if (!isDispatchV2(dispatch)
      || dispatch.attemptId !== attemptId
      || dispatch.state !== expectedDispatchState
      || dispatch.fence !== fence
      || !durableSource?.identity
      || !sameDispatchProcessWitness(durableSource.identity, expectedProcessIdentity, {
        nonce: durableSource.nonce,
        allowUnsettled: true
      })
      || (source === "provider-generation" && dispatch.nextProviderGeneration != null)) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Recovery cleanup expectation no longer matches the durable dispatch."
      );
    }
    const existing = current.request?.spawn?.cleanupFence;
    if (existing) {
      assertRecoveryCleanupFenceContract(current, dispatch);
      if (existing.source !== source
        || !sameDispatchProcessWitness(existing.processIdentity, expectedProcessIdentity, {
          nonce: durableSource.nonce,
          allowUnsettled: true
        })) {
        throw new CompanionError("E_PROCESS_IDENTITY", "A conflicting recovery cleanup fence already exists.");
      }
      return Object.freeze({ workerId, ...existing });
    }
    const claimedAt = now();
    const cleanupFence = Object.freeze({
      schemaVersion: RECOVERY_CLEANUP_FENCE_SCHEMA_VERSION,
      fenceId: crypto.randomBytes(16).toString("hex"),
      authority: "host-trusted-reconciler",
      source,
      mode: durableSource.identity.startToken === null ? "observe-only" : "signal",
      processKind: durableSource.processKind,
      dispatchState: dispatch.state,
      attemptId,
      dispatchFence: dispatch.fence,
      processIdentity: { ...durableSource.identity },
      claimedAt
    });
    transaction.updateJob(workerId, (latest) => {
      if (terminalJob(latest)) {
        throw new CompanionError("E_STATE", "Worker terminalized before cleanup fencing.");
      }
      assertDispatchContract(latest);
      const latestDispatch = latest.request?.spawn?.dispatch;
      const latestSource = recoveryCleanupSource(latest, source);
      if (latest.request?.spawn?.cleanupFence != null
        || latestDispatch?.attemptId !== attemptId
        || latestDispatch.state !== expectedDispatchState
        || latestDispatch.fence !== fence
        || !latestSource?.identity
        || !sameDispatchProcessWitness(latestSource.identity, expectedProcessIdentity, {
          nonce: latestSource.nonce,
          allowUnsettled: true
        })
        || (source === "provider-generation" && latestDispatch.nextProviderGeneration != null)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Recovery cleanup authority changed before fencing.");
      }
      const next = {
        ...latest,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            cleanupFence
          }
        }
      };
      assertDispatchContract(next);
      return next;
    });
    return Object.freeze({ workerId, ...cleanupFence });
  }, env);
}

export function verifyRecoveryCleanupFence({
  root,
  workerId,
  fenceId,
  expectedProcessIdentity = null,
  env = process.env
} = {}) {
  if (!root || !workerId || !/^[0-9a-f]{32}$/.test(fenceId || "")) {
    throw new CompanionError("E_USAGE", "Recovery cleanup verification requires an exact fence identity.");
  }
  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current || terminalJob(current)) {
      throw new CompanionError("E_STATE", "Recovery cleanup fence is no longer active.");
    }
    assertDispatchContract(current);
    const cleanupFence = assertRecoveryCleanupFenceContract(
      current,
      current.request?.spawn?.dispatch
    );
    const source = recoveryCleanupSource(current, cleanupFence?.source);
    if (!cleanupFence
      || cleanupFence.fenceId !== fenceId
      || (expectedProcessIdentity
        && !sameDispatchProcessWitness(cleanupFence.processIdentity, expectedProcessIdentity, {
          nonce: source?.nonce,
          allowUnsettled: true
        }))) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Recovery cleanup fence changed before process signaling.");
    }
    return Object.freeze({ workerId, ...cleanupFence });
  }, env);
}

export function spawnIntentField(processKind) {
  if (processKind === "controller") return "controllerSpawnIntent";
  if (processKind === "worker") return "workerSpawnIntent";
  if (processKind === "provider") return "providerSpawnIntent";
  throw new CompanionError("E_USAGE", "Dispatch process kind must be controller, worker, or provider.");
}

export function expectedSpawnPredecessor(processKind) {
  return processKind === "controller" ? "claimed" : "controller-started";
}

export function sameSpawnIntent(intent, {
  processKind,
  attemptId,
  intentId = null,
  fence = null,
  providerGeneration = null
} = {}) {
  if (processKind === "provider") {
    return Boolean(
      [
        PROVIDER_SPAWN_INTENT_SCHEMA_VERSION,
        BOUND_PROVIDER_SPAWN_INTENT_SCHEMA_VERSION
      ].includes(intent?.schemaVersion)
      && intent.attemptId === attemptId
      && intent.dispatchFence === fence
      && intent.providerGeneration === providerGeneration
      && (!intentId || intent.intentId === intentId)
    );
  }
  return Boolean(
    intent?.schemaVersion === WORKER_SPAWN_INTENT_SCHEMA_VERSION
    && intent.processKind === processKind
    && intent.attemptId === attemptId
    && (!intentId || intent.intentId === intentId)
    && (fence === null ? intent.fence == null : intent.fence === fence)
  );
}

export function prepareDispatchProcessSpawn({
  root,
  workerId,
  attemptId,
  processKind,
  nonce,
  fence = null,
  env = process.env
} = {}) {
  if (!new Set(["controller", "worker"]).has(processKind)) {
    throw new CompanionError("E_USAGE", "Detached process spawn intent requires controller or worker kind.");
  }
  const field = spawnIntentField(processKind);
  if (!root || !workerId || !attemptId || !nonce) {
    throw new CompanionError("E_USAGE", "Dispatch spawn intent requires an exact attempt and nonce.");
  }
  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    if (terminalJob(current)) {
      return Object.freeze({ prepared: false, reason: "terminal", intent: current.request?.spawn?.[field] || null, job: current });
    }
    assertDispatchContract(current);
    assertNoRecoveryCleanupFence(current, "prepare a process spawn");
    const dispatch = current.request?.spawn?.dispatch;
    if (!isSupportedWorkerDispatch(dispatch)
      || dispatch.attemptId !== attemptId
      || dispatch.state !== expectedSpawnPredecessor(processKind)
      || cancellationNonce(current) !== nonce) {
      throw new CompanionError("E_STATE", "Dispatch changed before its spawn intent could be prepared.");
    }
    assertDispatchFence(dispatch, fence);
    if (processKind === "controller" && current.controllerProcess?.pid) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Controller identity already exists before spawn intent preparation.");
    }
    if (processKind === "worker" && current.workerProcess?.pid) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Worker identity already exists before spawn intent preparation.");
    }
    const existing = current.request?.spawn?.[field];
    if (existing) {
      if (!sameSpawnIntent(existing, { processKind, attemptId, fence: isDispatchV2(dispatch) ? fence : null })) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Durable spawn intent changed for this dispatch attempt.");
      }
      return Object.freeze({
        prepared: false,
        reason: existing.status === "pending" ? "already-pending" : existing.status,
        intent: existing,
        job: current
      });
    }

    const preparedAt = now();
    const intent = Object.freeze({
      schemaVersion: WORKER_SPAWN_INTENT_SCHEMA_VERSION,
      processKind,
      intentId: crypto.randomBytes(16).toString("hex"),
      attemptId,
      ...(isDispatchV2(dispatch) ? { fence } : {}),
      status: "pending",
      preparedAt,
      updatedAt: preparedAt,
      registeredAt: null,
      noChildAt: null
    });
    const job = transaction.updateJob(workerId, (latest) => {
      const latestDispatch = latest.request?.spawn?.dispatch;
      if (terminalJob(latest)
        || latestDispatch?.attemptId !== attemptId
        || latestDispatch.state !== expectedSpawnPredecessor(processKind)
        || cancellationNonce(latest) !== nonce
        || latest.request?.spawn?.[field]) {
        throw new CompanionError("E_STATE", "Dispatch changed before spawn intent publication.");
      }
      assertDispatchFence(latestDispatch, fence);
      assertNoRecoveryCleanupFence(latest, "publish a process spawn intent");
      return {
        ...latest,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            [field]: intent,
            dispatch: { ...latestDispatch, updatedAt: preparedAt }
          }
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "checkpoint",
          `${processKind === "controller" ? "Controller" : "Worker"} spawn intent committed before process creation.`,
          { dispatchAttemptId: attemptId, processKind, replayedPrompt: false }
        )
      };
    });
    return Object.freeze({ prepared: true, reason: "prepared", intent, job });
  }, env);
}

export function recordDispatchProcessNoChild({
  root,
  workerId,
  attemptId,
  processKind,
  intentId,
  fence = null,
  resolution = "spawn-not-created",
  env = process.env
} = {}) {
  if (!new Set(["controller", "worker"]).has(processKind)) {
    throw new CompanionError("E_USAGE", "Detached process no-child outcome requires controller or worker kind.");
  }
  const field = spawnIntentField(processKind);
  if (!root
    || !workerId
    || !attemptId
    || !intentId
    || !["spawn-not-created", "cleanup-proven"].includes(resolution)) {
    throw new CompanionError("E_USAGE", "No-child publication requires an exact durable spawn intent.");
  }
  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    if (terminalJob(current)) return current;
    assertDispatchContract(current);
    assertNoRecoveryCleanupFence(current, "publish a no-child outcome");
    const dispatch = current.request?.spawn?.dispatch;
    const intent = current.request?.spawn?.[field];
    const processExists = processKind === "controller"
      ? current.controllerProcess?.pid
      : current.workerProcess?.pid;
    if (dispatch?.attemptId !== attemptId
      || dispatch.state !== expectedSpawnPredecessor(processKind)
      || !sameSpawnIntent(intent, {
        processKind,
        attemptId,
        intentId,
        fence: isDispatchV2(dispatch) ? fence : null
      })
      || processExists) {
      throw new CompanionError("E_PROCESS_IDENTITY", "No-child outcome no longer matches the active spawn boundary.");
    }
    assertDispatchFence(dispatch, fence);
    if (isDispatchV2(dispatch) && intent.fence !== fence) {
      throw new CompanionError("E_PROCESS_IDENTITY", "No-child outcome does not match the active dispatch fence.");
    }
    if (intent.status === "no-child") return current;
    if (intent.status !== "pending") {
      throw new CompanionError("E_PROCESS_IDENTITY", "A registered child cannot be replaced with a no-child outcome.");
    }
    const noChildAt = now();
    return transaction.updateJob(workerId, (latest) => {
      const latestIntent = latest.request?.spawn?.[field];
      const latestDispatch = latest.request?.spawn?.dispatch;
      const latestProcessExists = processKind === "controller"
        ? latest.controllerProcess?.pid
        : latest.workerProcess?.pid;
      if (terminalJob(latest)
        || latestDispatch?.attemptId !== attemptId
        || latestDispatch.state !== expectedSpawnPredecessor(processKind)
        || !sameSpawnIntent(latestIntent, {
          processKind,
          attemptId,
          intentId,
          fence: isDispatchV2(latestDispatch) ? fence : null
        })
        || latestIntent.status !== "pending"
        || latestProcessExists) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Spawn boundary changed before no-child publication.");
      }
      assertDispatchFence(latestDispatch, fence);
      assertNoRecoveryCleanupFence(latest, "publish a no-child outcome");
      if (isDispatchV2(latestDispatch) && latestIntent.fence !== fence) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Spawn boundary fence changed before no-child publication.");
      }
      return {
        ...latest,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            [field]: {
              ...latestIntent,
              status: "no-child",
              resolution,
              noChildAt,
              updatedAt: noChildAt
            },
            providerLaunchOutcome: "not-launched",
            dispatch: { ...latestDispatch, updatedAt: noChildAt }
          }
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "checkpoint",
          resolution === "cleanup-proven"
            ? `${processKind === "controller" ? "Controller" : "Worker"} child cleanup was exactly proven.`
            : `${processKind === "controller" ? "Controller" : "Worker"} spawn definitively created no child.`,
          { dispatchAttemptId: attemptId, processKind, resolution, replayedPrompt: false }
        )
      };
    });
  }, env);
}

export function providerSpawnBoundaryMatches(dispatch, attemptId, fence, providerGeneration) {
  if (!isDispatchV2(dispatch)
    || dispatch.attemptId !== attemptId
    || dispatch.fence !== fence) return false;
  if (dispatch.state === "worker-started") {
    return providerGeneration === dispatch.providerGeneration + 1
      && dispatch.nextProviderGeneration == null;
  }
  return dispatch.state === "provider-started"
    && dispatch.nextProviderGeneration === providerGeneration
    && providerGeneration === dispatch.providerGeneration + 1;
}

export function prepareWorkerProviderSpawn({
  root,
  workerId,
  attemptId,
  fence,
  providerGeneration,
  env = process.env
} = {}) {
  if (!root
    || !workerId
    || !/^[0-9a-f]{32}$/.test(attemptId || "")
    || !Number.isSafeInteger(fence)
    || fence < 1
    || !Number.isSafeInteger(providerGeneration)
    || providerGeneration < 1) {
    throw new CompanionError("E_USAGE", "Provider spawn preparation requires an exact dispatch generation.");
  }
  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    if (terminalJob(current)) {
      return Object.freeze({ prepared: false, reason: "terminal", intent: null, job: current });
    }
    assertDispatchContract(current);
    assertNoRecoveryCleanupFence(current, "prepare a provider spawn");
    const dispatch = current.request?.spawn?.dispatch;
    if (!providerSpawnBoundaryMatches(dispatch, attemptId, fence, providerGeneration)) {
      throw new CompanionError("E_STATE", "Dispatch changed before provider spawn preparation.");
    }
    let guard;
    try { guard = loadProviderGuard(root, workerId); }
    catch {
      throw new CompanionError("E_PROCESS_IDENTITY", "Provider guard aliases are malformed or conflicting.");
    }
    if (guard) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Provider ownership metadata already exists before spawn preparation.");
    }
    const existing = assertProviderSpawnIntentContract(current, dispatch);
    if (existing) {
      if (existing.providerGeneration !== providerGeneration
        || existing.status !== "pending") {
        throw new CompanionError("E_PROCESS_IDENTITY", "Provider spawn authorization was already consumed.");
      }
      return Object.freeze({ prepared: false, reason: "already-pending", intent: existing, job: current });
    }
    const preparedAt = now();
    const intent = Object.freeze({
      ...providerSpawnIntentBindingFields(current),
      intentId: crypto.randomBytes(16).toString("hex"),
      attemptId,
      dispatchFence: fence,
      providerGeneration,
      status: "pending",
      preparedAt,
      updatedAt: preparedAt,
      registeredAt: null,
      noChildAt: null,
      resolution: null
    });
    const job = transaction.updateJob(workerId, (latest) => {
      const latestDispatch = latest.request?.spawn?.dispatch;
      if (terminalJob(latest)
        || latest.request?.spawn?.providerSpawnIntent != null
        || !providerSpawnBoundaryMatches(latestDispatch, attemptId, fence, providerGeneration)) {
        throw new CompanionError("E_STATE", "Provider spawn boundary changed before intent publication.");
      }
      assertDispatchContract(latest);
      assertNoRecoveryCleanupFence(latest, "publish a provider spawn intent");
      const next = {
        ...latest,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            providerSpawnIntent: intent,
            providerLaunchPending: false,
            providerLaunchInFlight: true,
            providerLaunchOutcome: "pending",
            providerLaunchAttemptedAt: preparedAt,
            providerLaunchCompletedAt: null,
            dispatch: { ...latestDispatch, updatedAt: preparedAt }
          }
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "checkpoint",
          "Provider spawn intent committed before bootstrap creation.",
          { providerGeneration, replayedPrompt: false }
        )
      };
      assertDispatchContract(next);
      return next;
    });
    return Object.freeze({ prepared: true, reason: "prepared", intent, job });
  }, env);
}

export function recordWorkerProviderSpawnNoChild({
  root,
  workerId,
  attemptId,
  fence,
  providerGeneration,
  intentId,
  resolution = "spawn-not-created",
  env = process.env
} = {}) {
  if (!root
    || !workerId
    || !/^[0-9a-f]{32}$/.test(attemptId || "")
    || !Number.isSafeInteger(fence)
    || !Number.isSafeInteger(providerGeneration)
    || !/^[0-9a-f]{32}$/.test(intentId || "")
    || !["spawn-not-created", "cleanup-proven", "authorization-revoked"].includes(resolution)) {
    throw new CompanionError("E_USAGE", "Provider no-child publication requires an exact spawn intent.");
  }
  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    const dispatch = current.request?.spawn?.dispatch;
    const intent = assertProviderSpawnIntentContract(current, dispatch, { allowMissing: false });
    if (intent.intentId !== intentId
      || intent.attemptId !== attemptId
      || intent.dispatchFence !== fence
      || intent.providerGeneration !== providerGeneration) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Provider no-child proof does not match the durable spawn intent.");
    }
    if (intent.status === "no-child") return current;
    if (terminalJob(current)) {
      throw new CompanionError("E_STATE", "Provider spawn authorization is already terminal.");
    }
    assertDispatchContract(current);
    assertNoRecoveryCleanupFence(current, "settle a provider spawn without a child");
    if (!providerSpawnBoundaryMatches(dispatch, attemptId, fence, providerGeneration)) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Provider spawn boundary changed before no-child settlement.");
    }
    let guard;
    try { guard = loadProviderGuard(root, workerId); }
    catch {
      throw new CompanionError("E_PROCESS_IDENTITY", "Provider guard aliases are malformed or conflicting.");
    }
    if (guard) {
      const authenticated = assertProviderGuardForJob(root, current, guard, {
        expectedGeneration: providerGeneration
      });
      if (authenticated.providerSpawnIntentId !== intentId
        || !["pending", "registered"].includes(intent.status)
        || !processGroupGone(authenticated.providerProcess)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "A live or ambiguous provider guard wins the no-child race.");
      }
      unregisterProviderGuardInWorkspaceTransaction(root, workerId, authenticated);
    } else if (intent.status === "registered") {
      throw new CompanionError("E_PROCESS_IDENTITY", "Registered provider ownership disappeared without exact cleanup proof.");
    }
    if (resolution === "authorization-revoked" && intent.status !== "pending") {
      throw new CompanionError("E_PROCESS_IDENTITY", "Only an unregistered provider authorization can be revoked.");
    }
    const noChildAt = now();
    return transaction.updateJob(workerId, (latest) => {
      const latestDispatch = latest.request?.spawn?.dispatch;
      const latestIntent = assertProviderSpawnIntentContract(latest, latestDispatch, { allowMissing: false });
      if (latestIntent.intentId !== intentId
        || latestIntent.status !== intent.status
        || !providerSpawnBoundaryMatches(latestDispatch, attemptId, fence, providerGeneration)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Provider spawn boundary changed before no-child publication.");
      }
      let latestGuard;
      try { latestGuard = loadProviderGuard(root, workerId); }
      catch {
        throw new CompanionError("E_PROCESS_IDENTITY", "Provider guard aliases changed during no-child settlement.");
      }
      if (latestGuard) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Provider guard appeared before no-child publication.");
      }
      const providerSpawnIntent = {
        ...latestIntent,
        status: "no-child",
        updatedAt: noChildAt,
        noChildAt,
        resolution
      };
      const rotation = latest.request?.spawn?.providerRotationIntent;
      const next = {
        ...latest,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            providerSpawnIntent,
            ...(rotation ? {
              providerRotationIntent: {
                ...rotation,
                status: "no-child",
                registeredAt: providerSpawnIntent.registeredAt,
                updatedAt: noChildAt,
                noChildAt,
                resolution
              }
            } : {}),
            providerLaunchPending: false,
            providerLaunchInFlight: false,
            providerLaunchOutcome: "not-launched",
            providerLaunchCompletedAt: noChildAt,
            dispatch: {
              ...latestDispatch,
              ...(providerGeneration === 2 ? { nextProviderGeneration: null } : {}),
              updatedAt: noChildAt
            }
          }
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "checkpoint",
          "Provider spawn authorization was settled without a child.",
          { providerGeneration, resolution, replayedPrompt: false }
        )
      };
      assertDispatchContract(next);
      return next;
    });
  }, env);
}
