/** Issue #56 worker-mutation dispatch-transition domain. */
import crypto from "node:crypto";
import path from "node:path";
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
import {
  assertContextCompatible,
  assertContextManifestIntegrity,
  captureContextManifest
} from "./task-context-manifest.mjs";
import {
  assertTaskEnvelope,
  bindTaskEnvelopeContext,
  buildTaskEnvelope,
  scrubStoredJob
} from "./task-envelope.mjs";
import { composeProviderPrompt } from "./task-provider-prompt.mjs";
import { appendLifecycleEvent } from "./task-lifecycle.mjs";
import { profileFor, sameSecurityProfile } from "./profiles.mjs";
import { processGroupGone, processStartToken } from "./process-control.mjs";
import {
  assertProviderGuardForJob,
  loadProviderGuard,
  unregisterProviderGuardInWorkspaceTransaction
} from "./recursion-guard.mjs";
import { resolveControlWorkspace, workspaceState } from "./workspace.mjs";
import {
  captureTerminalEvidence,
  normalizeTerminalProcessSignalError,
  selectTaskTerminalError,
  terminalTaskProgress
} from "./task-terminal-evidence.mjs";
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
  recordWorkerProviderSpawnNoChild,
  sameSpawnIntent,
  spawnIntentField
} from "./worker-mutation-dispatch-admission.mjs";
import {
  PROVIDER_ROTATION_INTENT_SCHEMA_VERSION,
  WORKER_DISPATCH_SCHEMA_VERSION,
  assertDispatchContract,
  assertNoRecoveryCleanupFence,
  assertProviderRotationIntentContract,
  assertTransitionNotCleanupClaimed,
  exactLegacyPendingAuthorization,
  exactLegacyTaskSecurityProfile,
  providerSpawnIntentBindingFields,
  terminalJob
} from "./worker-mutation-dispatch-contract.mjs";
import {
  SHA256_HEX,
  assertMutationOwnership,
  cancellationNonce,
  completeOwnedProcessIdentity,
  currentOwnedProcessIdentity,
  digestKey,
  isPlainRecord,
  sameDispatchProcessIdentity
} from "./worker-mutation-primitives.mjs";
import {
  requestDigest
} from "./worker-mutation-request-contract.mjs";
import {
  assertDurableSpawnRequestBinding
} from "./worker-mutation-spawn-authority.mjs";
import {
  reconcileCleanupSafeTerminalObservation
} from "./worker-mutation-terminal.mjs";

export function legacyPendingMigrationEligible(root, job, principal, env = process.env) {
  const spawn = job?.request?.spawn;
  const postV1RequestFields = [
    "contextBindingMode",
    "contextPacket",
    "runtimeRolePolicy",
    "contextReceipt",
    "providerHomeId"
  ];
  if (!exactLegacyPendingAuthorization(job, principal)
    || postV1RequestFields.some((field) => (
      Object.hasOwn(job?.request || {}, field)
    ))
    || Object.hasOwn(spawn || {}, "contextBindingDigest")
    || Object.hasOwn(spawn || {}, "controllerSpawnIntent")
    || Object.hasOwn(spawn || {}, "workerSpawnIntent")
    || Object.hasOwn(spawn || {}, "unsettledWorkerProcess")
    || Object.hasOwn(spawn || {}, "controllerCleanupProcess")
    || spawn?.controllerCleanupPending === true
    || Object.hasOwn(job || {}, "controllerProcess")
    || Object.hasOwn(job || {}, "workerProcess")
    || Object.hasOwn(job || {}, "providerProcess")
    || Object.hasOwn(job || {}, "pendingTerminal")
    || !exactLegacyTaskSecurityProfile(job?.profile, job?.write)) return false;
  try {
    assertDispatchContract({
      ...job,
      profile: profileFor("task", Boolean(job?.write))
    });
    const callerControl = resolveControlWorkspace(root, env);
    const executionRoot = spawn?.executionRoot;
    if (typeof executionRoot !== "string"
      || !path.isAbsolute(executionRoot)
      || path.normalize(executionRoot) !== executionRoot) return false;
    const storedControl = resolveControlWorkspace(executionRoot, env);
    if (storedControl.executionRoot !== executionRoot
      || storedControl.controlWorkspaceId !== job.controlWorkspaceId
      || callerControl.controlWorkspaceId !== job.controlWorkspaceId
      || spawn.ownerThreadId !== job.host?.sessionId
      || !SHA256_HEX.test(spawn.idempotencyKeyDigest || "")) return false;
    const acceptedContext = assertContextCompatible(
      executionRoot,
      job.request?.contextManifest,
      { mode: "execute" }
    );
    if (job.request?.envelope?.contextManifestId != null
      && job.request.envelope.contextManifestId !== acceptedContext.manifestId) return false;
    const recomputedRequestDigest = requestDigest({
      principal: {
        hostKind: job.host?.kind,
        threadId: job.host?.sessionId
      },
      controlWorkspaceId: job.controlWorkspaceId,
      executionRoot,
      envelope: job.request?.envelope,
      contextManifest: acceptedContext,
      roleId: job.request?.roleId,
      write: job.write
    });
    if (spawn.requestDigest !== recomputedRequestDigest) return false;
    const recomputedProviderPromptDigest = digestKey(composeProviderPrompt(job.request.envelope, {
      root: executionRoot,
      contextManifest: acceptedContext
    }));
    if (job.request?.providerPromptDigest !== recomputedProviderPromptDigest) return false;
    return loadProviderGuard(executionRoot, job.id, env) === null;
  } catch {
    return false;
  }
}

export function claimWorkerDispatch({
  root,
  principal,
  workerId,
  holderId = null,
  leaseMs = DEFAULT_DISPATCH_LEASE_MS,
  clock = () => Date.now(),
  env = process.env
} = {}) {
  if (!principal?.threadId) {
    throw new CompanionError("E_AUTH_REQUIRED", "Trusted Codex task identity is unavailable.");
  }
  if (!workerId) throw new CompanionError("E_USAGE", "workerId is required.");
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) {
    throw new CompanionError("E_USAGE", "Worker dispatch lease duration is invalid.");
  }
  const leaseHolderId = holderId || `codex:${principal.threadId}:${crypto.randomBytes(8).toString("hex")}`;
  if (typeof leaseHolderId !== "string" || !leaseHolderId || leaseHolderId.length > 256) {
    throw new CompanionError("E_USAGE", "Worker dispatch lease holder is invalid.");
  }

  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    assertMutationOwnership(current, principal);
    const dispatch = current.request?.spawn?.dispatch;
    if (!isSupportedWorkerDispatch(dispatch)) {
      return Object.freeze({ claimed: false, reason: "not-dispatchable", job: current });
    }
    const legacyPending = dispatch.schemaVersion === 1
      && legacyPendingMigrationEligible(root, current, principal, env);
    const pending = dispatch.state === "pending" && !dispatch.attemptId;
    const reclaimable = isDispatchV2(dispatch)
      && dispatch.state === "claimed"
      && dispatch.attemptId
      && dispatchLeaseExpired(dispatch, clock())
      && !current.request?.spawn?.controllerSpawnIntent
      && !current.controllerProcess?.pid
      && !current.workerProcess?.pid
      && !current.providerProcess?.pid;
    if ((!pending && !reclaimable) || (dispatch.schemaVersion === 1 && !legacyPending)) {
      return Object.freeze({ claimed: false, reason: "already-claimed", job: current });
    }
    assertDispatchContract(legacyPending
      ? {
          ...current,
          profile: profileFor("task", Boolean(current.write))
        }
      : current);
    if (current.request?.followup !== undefined) {
      assertDurableSpawnRequestBinding(current, env);
    }
    const nonce = cancellationNonce(current);
    if (
      !["queued", "running"].includes(current.status)
      || isCancelRequested(root, current.id, nonce, env)
    ) {
      return Object.freeze({ claimed: false, reason: "inactive", job: current });
    }

    const claimedAtMs = clock();
    if (!Number.isFinite(claimedAtMs)) {
      throw new CompanionError("E_STATE", "Worker dispatch clock is invalid.");
    }
    const claimedAt = new Date(claimedAtMs).toISOString();
    const attemptId = crypto.randomBytes(16).toString("hex");
    const fence = (isDispatchV2(dispatch) && Number.isSafeInteger(dispatch.fence) ? dispatch.fence : 0) + 1;
    const lease = Object.freeze({
      leaseId: crypto.randomBytes(16).toString("hex"),
      holderId: leaseHolderId,
      fence,
      claimedAt,
      expiresAt: new Date(claimedAtMs + leaseMs).toISOString()
    });
    const claimedJob = transaction.updateJob(current.id, (latest) => {
      const latestDispatch = latest.request?.spawn?.dispatch;
      const latestLegacyPending = latestDispatch?.schemaVersion === 1
        && legacyPendingMigrationEligible(root, latest, principal, env);
      const latestPending = latestDispatch?.state === "pending" && !latestDispatch.attemptId;
      const latestReclaimable = isDispatchV2(latestDispatch)
        && latestDispatch.state === "claimed"
        && latestDispatch.attemptId === dispatch.attemptId
        && dispatchLeaseExpired(latestDispatch, claimedAtMs)
        && !latest.request?.spawn?.controllerSpawnIntent
        && !latest.controllerProcess?.pid
        && !latest.workerProcess?.pid
        && !latest.providerProcess?.pid;
      if (terminalJob(latest)
        || ((!latestPending && !latestReclaimable)
          || (latestDispatch?.schemaVersion === 1 && !latestLegacyPending))) {
        throw new CompanionError("E_STATE", "Worker dispatch changed before its durable claim could be published.");
      }
      const dispatchContractJob = latestLegacyPending
        ? {
            ...latest,
            profile: profileFor("task", Boolean(latest.write))
          }
        : latest;
      assertDispatchContract(dispatchContractJob);
      if (latest.request?.followup !== undefined) {
        assertDurableSpawnRequestBinding(latest, env);
      }
      const upgradedDispatch = latestLegacyPending
        ? createDispatchOutbox({ createdAt: latestDispatch.createdAt || latest.createdAt || claimedAt })
        : latestDispatch;
      const trustedControlWorkspace = resolveControlWorkspace(root, env);
      if (latestLegacyPending
        && trustedControlWorkspace.controlWorkspaceId !== latest.controlWorkspaceId) {
        throw new CompanionError(
          "E_STATE",
          "Legacy worker dispatch control-workspace identity changed before migration."
        );
      }
      const boundExecutionRoot = latest.request?.spawn?.executionRoot;
      const authorizationJob = latestLegacyPending
        ? {
            ...dispatchContractJob,
            request: {
              ...dispatchContractJob.request,
              spawn: {
                ...dispatchContractJob.request?.spawn,
                executionRoot: boundExecutionRoot
              }
            }
          }
        : latest;
      const authorization = latestLegacyPending
        ? createWorkerAuthorization({
          job: authorizationJob,
          principal: { ...principal, hostKind: principal.hostKind || "codex" },
          nonce: cancellationNonce(latest),
          issuedAt: latest.workerAuthorization.issuedAt || latest.createdAt || claimedAt
        })
        : assertWorkerAuthorization(latest, { allowLegacy: false });
      return {
        ...authorizationJob,
        phase: latest.phase === "accepted" ? "provider-launching" : latest.phase,
        summary: "Worker dispatch claimed",
        progress: "Starting isolated Grok worker controller",
        workerAuthorization: bindWorkerAuthorizationAttempt(authorization, { attemptId, fence }),
        request: {
          ...authorizationJob.request,
          spawn: {
            ...authorizationJob.request?.spawn,
            providerLaunchPending: true,
            providerLaunchInFlight: false,
            dispatch: {
              ...upgradedDispatch,
              schemaVersion: WORKER_DISPATCH_SCHEMA_VERSION,
              state: "claimed",
              attemptId,
              fence,
              lease,
              claimedAt,
              updatedAt: claimedAt
            }
          }
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "checkpoint",
          "Worker dispatch claimed",
          { dispatchSchemaVersion: WORKER_DISPATCH_SCHEMA_VERSION, dispatchFence: fence }
        )
      };
    });
    return Object.freeze({
      claimed: true,
      reason: "claimed",
      attemptId,
      fence,
      lease,
      nonce: cancellationNonce(claimedJob),
      job: claimedJob
    });
  }, env);
}

export function prepareWorkerDispatchTransition({ workerId, attemptId, fence, state, controllerProcess, workerProcess, providerProcess, runtimeCleanup }) {
  const allowed = new Set(["controller-started", "worker-started", "provider-started", "failed"]);
  if (!workerId || !attemptId || !allowed.has(state)) {
    throw new CompanionError("E_USAGE", "Invalid worker dispatch transition.");
  }
  if (state === "failed" && (!isPlainRecord(runtimeCleanup) || runtimeCleanup.ok !== true)) {
    throw new CompanionError(
      "E_RUNTIME_CLEANUP",
      "A failed dispatch transition requires verified controller and task-runtime cleanup."
    );
  }
  const requiredPredecessor = new Map([
    ["controller-started", "claimed"],
    ["worker-started", "controller-started"],
    ["provider-started", "worker-started"]
  ]);
  const validIdentity = (identity) => Boolean(
    currentOwnedProcessIdentity(identity)
    && identity.commandMarker === workerId
    && identity.dispatchAttemptId === attemptId
    && (fence === null || identity.dispatchFence === fence)
  );
  const identityForState = state === "controller-started"
    ? controllerProcess
    : state === "worker-started"
      ? workerProcess
      : state === "provider-started"
        ? providerProcess
        : null;
  const processKindForState = state === "controller-started"
    ? "controller"
    : state === "worker-started"
      ? "worker"
      : state === "provider-started"
        ? "provider"
        : null;
  const intentFieldForState = processKindForState ? spawnIntentField(processKindForState) : null;
  const dispatchAdvancedPast = (dispatchState) => (
    (state === "controller-started" && ["worker-started", "provider-started"].includes(dispatchState))
    || (state === "worker-started" && dispatchState === "provider-started")
  );
  if (state !== "failed" && !validIdentity(identityForState)) {
    throw new CompanionError("E_PROCESS_IDENTITY", `Worker dispatch ${state} requires a complete attempt-bound process identity.`);
  }
  if (state === "provider-started"
    && (!Number.isSafeInteger(providerProcess?.providerGeneration) || providerProcess.providerGeneration < 1)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Worker provider identity requires a positive invocation generation.");
  }
  return {
    requiredPredecessor,
    identityForState,
    processKindForState,
    intentFieldForState,
    dispatchAdvancedPast
  };
}

export function validateWorkerDispatchTransitionSnapshot(transaction, options) {
  const { workerId, attemptId, fence, state, controllerProcess, workerProcess, providerProcess, spawnIntentId, requiredPredecessor, identityForState, processKindForState, intentFieldForState, dispatchAdvancedPast } = options;
  const current = transaction.tryReadJob(workerId);
  if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
  const dispatch = current.request?.spawn?.dispatch;
  if (!isSupportedWorkerDispatch(dispatch) || dispatch.attemptId !== attemptId) {
    throw new CompanionError("E_STATE", "Worker dispatch attempt does not match the durable claim.");
  }
  assertDispatchFence(dispatch, fence);
  if (state === "failed" && isDispatchV2(dispatch)) assertDispatchV2Structure(dispatch);
  else assertDispatchContract(current);
  assertTransitionNotCleanupClaimed(current, state);
  const currentSpawnIntent = intentFieldForState ? current.request?.spawn?.[intentFieldForState] : null;
  if (isDispatchV2(dispatch)
    && intentFieldForState
    && processKindForState !== "provider"
    && !currentSpawnIntent) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Dispatch-v2 process registration requires its durable spawn intent.");
  }
  if (currentSpawnIntent && (
    !spawnIntentId
    || !sameSpawnIntent(currentSpawnIntent, {
      processKind: processKindForState,
      attemptId,
      intentId: spawnIntentId,
      fence: isDispatchV2(dispatch) ? fence : null,
      providerGeneration: state === "provider-started" ? providerProcess?.providerGeneration : null
    })
    || !["pending", "registered"].includes(currentSpawnIntent.status)
  )) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Worker dispatch process identity does not match its durable spawn intent.");
  }
  if (!currentSpawnIntent && spawnIntentId !== undefined) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Worker dispatch spawn intent is missing.");
  }
  if (dispatchAdvancedPast(dispatch.state)) {
    const storedIdentity = state === "controller-started"
      ? current.controllerProcess
      : current.workerProcess;
    assertDispatchContract(current);
    if (!sameDispatchProcessIdentity(storedIdentity, identityForState, { nonce: true })
      || (currentSpawnIntent && currentSpawnIntent.status !== "registered")) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Advanced worker dispatch does not retain the exact registered process identity.");
    }
    return { done: true, job: current };
  }
  const currentProviderGeneration = Number.isSafeInteger(dispatch.providerGeneration)
    ? dispatch.providerGeneration
    : 0;
  const repeatedIdentity = dispatch.state === state && state !== "failed"
    ? (state === "controller-started"
        ? current.controllerProcess
        : state === "worker-started"
          ? current.workerProcess
          : current.providerProcess)
    : null;
  const providerRotation = state === "provider-started"
    && dispatch.state === "provider-started"
    && !terminalJob(current)
    && current.request?.spawn?.providerRotationIntent?.status === "pending"
    && current.request.spawn.providerRotationIntent.targetProviderGeneration === dispatch.nextProviderGeneration
    && dispatch.nextProviderGeneration === currentProviderGeneration + 1
    && providerProcess.providerGeneration === dispatch.nextProviderGeneration;
  if (dispatch.state === state && !providerRotation) {
    if (state === "failed") return { done: true, job: current };
    assertDispatchContract(current);
    if (!sameDispatchProcessIdentity(repeatedIdentity, identityForState, {
      nonce: state !== "provider-started"
    })) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Repeated worker dispatch transition changed its process identity.");
    }
    return { done: true, job: current };
  }
  if (dispatch.state === "failed" || (dispatch.state === "provider-started" && !providerRotation) || terminalJob(current)) {
    return { done: true, job: current };
  }
  if (state !== "failed") assertDispatchContract(current);
  if (state === "controller-started" && controllerProcess?.nonce !== cancellationNonce(current)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Worker controller nonce does not match the durable launch authorization.");
  }
  if (state === "worker-started" && workerProcess?.nonce !== cancellationNonce(current)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Worker process nonce does not match the durable launch authorization.");
  }
  if (state === "failed") {
    if (!["claimed", "controller-started", "worker-started"].includes(dispatch.state)) {
      throw new CompanionError("E_STATE", "Worker dispatch cannot fail from its current state.");
    }
  } else if (!providerRotation && dispatch.state !== requiredPredecessor.get(state)) {
    throw new CompanionError("E_STATE", `Worker dispatch ${state} requires ${requiredPredecessor.get(state)}.`);
  }
  if (state === "provider-started"
    && !providerRotation
    && providerProcess.providerGeneration !== currentProviderGeneration + 1) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Initial provider generation does not follow the durable dispatch generation.");
  }
  return { done: false, transitionedAt: now() };
}

export function transitionWorkerDispatch({ root, workerId, attemptId, fence = null, state, controllerProcess = undefined, workerProcess = undefined, providerProcess = undefined, spawnIntentId = undefined, error = null, runtimeCleanup = null, env = process.env } = {}) {
  const prepared = prepareWorkerDispatchTransition({ workerId, attemptId, fence, state, controllerProcess, workerProcess, providerProcess, runtimeCleanup });
  const { requiredPredecessor, identityForState, processKindForState, intentFieldForState, dispatchAdvancedPast } = prepared;
  return withWorkspaceStateTransaction(root, (transaction) => {
    const snapshot = validateWorkerDispatchTransitionSnapshot(transaction, { workerId, attemptId, fence, state, controllerProcess, workerProcess, providerProcess, spawnIntentId, requiredPredecessor, identityForState, processKindForState, intentFieldForState, dispatchAdvancedPast });
    if (snapshot.done) return snapshot.job;
    const { transitionedAt } = snapshot;
    return transaction.updateJob(workerId, (latest) => {
      const latestDispatch = latest.request?.spawn?.dispatch;
      if (terminalJob(latest)) return latest;
      if (!isSupportedWorkerDispatch(latestDispatch) || latestDispatch.attemptId !== attemptId) {
        throw new CompanionError("E_STATE", "Worker dispatch attempt changed before transition publication.");
      }
      assertDispatchFence(latestDispatch, fence);
      if (state === "failed" && isDispatchV2(latestDispatch)) assertDispatchV2Structure(latestDispatch);
      else assertDispatchContract(latest);
      assertTransitionNotCleanupClaimed(latest, state);
      const latestSpawnIntent = intentFieldForState ? latest.request?.spawn?.[intentFieldForState] : null;
      if (isDispatchV2(latestDispatch)
        && intentFieldForState
        && processKindForState !== "provider"
        && !latestSpawnIntent) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Dispatch-v2 spawn intent disappeared before process registration.");
      }
      if (latestSpawnIntent && (
        !spawnIntentId
        || !sameSpawnIntent(latestSpawnIntent, {
          processKind: processKindForState,
          attemptId,
          intentId: spawnIntentId,
          fence: isDispatchV2(latestDispatch) ? fence : null,
          providerGeneration: state === "provider-started" ? providerProcess?.providerGeneration : null
        })
        || !["pending", "registered"].includes(latestSpawnIntent.status)
      )) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Worker dispatch spawn intent changed before process registration.");
      }
      if (!latestSpawnIntent && spawnIntentId !== undefined) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Worker dispatch spawn intent disappeared before process registration.");
      }
      if (dispatchAdvancedPast(latestDispatch.state)) {
        const storedIdentity = state === "controller-started"
          ? latest.controllerProcess
          : latest.workerProcess;
        assertDispatchContract(latest);
        if (!sameDispatchProcessIdentity(storedIdentity, identityForState, { nonce: true })
          || (latestSpawnIntent && latestSpawnIntent.status !== "registered")) {
          throw new CompanionError("E_PROCESS_IDENTITY", "Advanced worker dispatch changed its registered process identity.");
        }
        return latest;
      }
      const latestProviderGeneration = Number.isSafeInteger(latestDispatch.providerGeneration)
        ? latestDispatch.providerGeneration
        : 0;
      const latestRepeatedIdentity = latestDispatch.state === state && state !== "failed"
        ? (state === "controller-started"
            ? latest.controllerProcess
            : state === "worker-started"
              ? latest.workerProcess
              : latest.providerProcess)
        : null;
      const latestProviderRotation = state === "provider-started"
        && latestDispatch.state === "provider-started"
        && !terminalJob(latest)
        && latest.request?.spawn?.providerRotationIntent?.status === "pending"
        && latest.request.spawn.providerRotationIntent.targetProviderGeneration === latestDispatch.nextProviderGeneration
        && latestDispatch.nextProviderGeneration === latestProviderGeneration + 1
        && providerProcess.providerGeneration === latestDispatch.nextProviderGeneration;
      if (latestDispatch.state === state && !latestProviderRotation) {
        if (state === "failed") return latest;
        assertDispatchContract(latest);
        if (!sameDispatchProcessIdentity(latestRepeatedIdentity, identityForState, {
          nonce: state !== "provider-started"
        })) {
          throw new CompanionError("E_PROCESS_IDENTITY", "Repeated worker dispatch transition changed before publication.");
        }
        return latest;
      }
      if (latestDispatch.state === "failed" || (latestDispatch.state === "provider-started" && !latestProviderRotation)) return latest;
      if (state !== "failed") assertDispatchContract(latest);
      if (state === "controller-started" && controllerProcess?.nonce !== cancellationNonce(latest)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Worker controller nonce changed before transition publication.");
      }
      if (state === "worker-started" && workerProcess?.nonce !== cancellationNonce(latest)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Worker process nonce changed before transition publication.");
      }
      if (state === "failed") {
        if (!["claimed", "controller-started", "worker-started"].includes(latestDispatch.state)) {
          throw new CompanionError("E_STATE", "Worker dispatch cannot fail from its current state.");
        }
      } else if (!latestProviderRotation && latestDispatch.state !== requiredPredecessor.get(state)) {
        throw new CompanionError("E_STATE", `Worker dispatch ${state} requires ${requiredPredecessor.get(state)}.`);
      }
      if (state === "provider-started"
        && !latestProviderRotation
        && providerProcess.providerGeneration !== latestProviderGeneration + 1) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Provider generation changed before transition publication.");
      }
      const next = {
        ...latest,
        ...(state === "failed"
          ? { workerAuthorization: null }
          : {}),
        ...(controllerProcess !== undefined ? { controllerProcess } : {}),
        ...(workerProcess !== undefined ? { workerProcess } : {}),
        ...(providerProcess !== undefined ? { providerProcess } : {}),
        request: {
          ...latest.request,
          spawn: {
            ...latest.request?.spawn,
            ...(latestSpawnIntent ? {
              [intentFieldForState]: {
                ...latestSpawnIntent,
                status: "registered",
                registeredAt: latestSpawnIntent.registeredAt || transitionedAt,
                updatedAt: transitionedAt
              }
            } : {}),
            ...(latestProviderRotation ? {
              providerRotationIntent: {
                ...latest.request.spawn.providerRotationIntent,
                status: "registered",
                registeredAt: latestSpawnIntent?.registeredAt || transitionedAt,
                updatedAt: transitionedAt
              }
            } : {}),
            providerLaunchPending: ["provider-started", "failed"].includes(state)
              ? false
              : latest.request?.spawn?.providerLaunchPending,
            providerLaunchInFlight: ["provider-started", "failed"].includes(state)
              ? false
              : latest.request?.spawn?.providerLaunchInFlight,
            providerLaunchOutcome: state === "provider-started"
              ? "launched"
              : state === "failed"
                ? "not-launched"
                : latest.request?.spawn?.providerLaunchOutcome || "pending",
            providerLaunchCompletedAt: ["provider-started", "failed"].includes(state)
              ? transitionedAt
              : latest.request?.spawn?.providerLaunchCompletedAt || null,
            dispatch: {
              ...latestDispatch,
              state,
              ...(isDispatchV2(latestDispatch) && ["controller-started", "worker-started", "provider-started", "failed"].includes(state)
                ? { lease: null }
                : {}),
              updatedAt: transitionedAt,
              ...(state === "provider-started" ? {
                providerGeneration: providerProcess.providerGeneration,
                nextProviderGeneration: null
              } : {}),
              ...(state === "controller-started" ? { controllerStartedAt: transitionedAt } : {}),
              ...(state === "worker-started" ? { workerStartedAt: transitionedAt } : {}),
              ...(state === "failed" ? { failedAt: transitionedAt } : {}),
              ...(state === "provider-started" ? {
                providerStartedAt: latestDispatch.providerStartedAt || transitionedAt,
                ...(latestProviderRotation ? {
                  providerRotatedAt: transitionedAt,
                  providerRotationCount: (latestDispatch.providerRotationCount || 0) + 1
                } : {})
              } : {})
            }
          }
        }
      };
      if (state !== "failed") {
        assertDispatchContract(next);
        return next;
      }
      const cancelled = error?.code === "E_CANCELLED";
      const priorError = error || {
        code: "E_WORKER_LOST",
        message: "Could not launch the isolated Grok worker."
      };
      const observed = reconcileCleanupSafeTerminalObservation(
        next,
        {
          status: cancelled ? "cancelled" : "failed",
          phase: cancelled ? "cancelled" : "failed",
          completedAt: latest.completedAt || transitionedAt,
          error: priorError,
          summary: cancelled ? "Cancelled" : "Worker launch failed"
        },
        {
          cleanupError: latest.error || null
        }
      );
      const pending = observed.pending;
      return scrubStoredJob({
        ...observed.job,
        status: pending.status,
        phase: pending.phase,
        completedAt: pending.completedAt,
        summary: pending.summary,
        progress: terminalTaskProgress(pending.status, pending.error),
        error: pending.error || null,
        workerAuthorization: null,
        result: {
          ...(observed.job.result || {}),
          taskRuntimeCleaned: runtimeCleanup.ok,
          ...(pending.status === "cancelled" ? { stopReason: "cancelled" } : {})
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "blocked",
          pending.error?.message || "Worker launch failed before provider startup"
        )
      });
    });
  }, env);
}

export function recordUnsettledProviderProcess({
  root,
  workerId,
  attemptId,
  providerProcess,
  env = process.env
} = {}) {
  const validUnsettledIdentity = Boolean(
    providerProcess
    && Number.isInteger(providerProcess.pid)
    && providerProcess.pid > 0
    && providerProcess.startToken === null
    && (process.platform === "win32"
      ? providerProcess.processGroupId === null
      : providerProcess.processGroupId === providerProcess.pid)
    && providerProcess.commandMarker === workerId
    && providerProcess.dispatchAttemptId === attemptId
    && (providerProcess.dispatchFence === undefined
      || (Number.isSafeInteger(providerProcess.dispatchFence) && providerProcess.dispatchFence > 0))
    && Number.isSafeInteger(providerProcess.providerGeneration)
    && providerProcess.providerGeneration > 0
  );
  if (!root || !workerId || !attemptId || !validUnsettledIdentity) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Unsettled provider cleanup requires an exact attempt-bound PID/PGID witness.");
  }
  const sameUnsettledIdentity = (left, right) => Boolean(
    left?.pid === right.pid
    && left.startToken === null
    && left.processGroupId === right.processGroupId
    && left.commandMarker === right.commandMarker
    && left.dispatchAttemptId === right.dispatchAttemptId
    && left.dispatchFence === right.dispatchFence
    && left.providerGeneration === right.providerGeneration
  );

  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    if (terminalJob(current)) return current;
    const dispatch = current.request?.spawn?.dispatch;
    const initialLaunch = isSupportedWorkerDispatch(dispatch)
      && dispatch.attemptId === attemptId
      && dispatch.state === "worker-started"
      && !current.providerProcess?.pid
      && providerProcess.providerGeneration === (Number.isSafeInteger(dispatch.providerGeneration)
        ? dispatch.providerGeneration + 1
        : 1);
    const pendingRotation = isSupportedWorkerDispatch(dispatch)
      && dispatch.attemptId === attemptId
      && dispatch.state === "provider-started"
      && Number.isSafeInteger(dispatch.providerGeneration)
      && dispatch.providerGeneration > 0
      && dispatch.nextProviderGeneration === dispatch.providerGeneration + 1
      && providerProcess.providerGeneration === dispatch.nextProviderGeneration
      && completeOwnedProcessIdentity(current.providerProcess)
      && current.providerProcess.commandMarker === workerId
      && current.providerProcess.dispatchAttemptId === attemptId
      && current.providerProcess.providerGeneration === dispatch.providerGeneration;
    const repeatedRotationWitness = isSupportedWorkerDispatch(dispatch)
      && dispatch.attemptId === attemptId
      && dispatch.state === "failed"
      && current.phase === "cleanup-blocked"
      && sameUnsettledIdentity(current.providerProcess, providerProcess)
      && dispatch.providerGeneration === providerProcess.providerGeneration
      && dispatch.nextProviderGeneration === null;
    if (repeatedRotationWitness) return current;
    if (!initialLaunch && !pendingRotation) {
      throw new CompanionError("E_STATE", "Unsettled provider identity no longer matches the active dispatch.");
    }
    assertDispatchContract(current);
    assertNoRecoveryCleanupFence(current, "record an unsettled provider");
    assertDispatchFence(dispatch, isDispatchV2(dispatch) ? providerProcess.dispatchFence : null);
    if (initialLaunch && current.providerProcess?.pid) {
      if (sameUnsettledIdentity(current.providerProcess, providerProcess)) return current;
      throw new CompanionError("E_PROCESS_IDENTITY", "Provider cleanup identity changed before durable settlement.");
    }
    const recordedAt = now();
    return transaction.updateJob(workerId, (latest) => {
      const latestDispatch = latest.request?.spawn?.dispatch;
      const latestInitialLaunch = isSupportedWorkerDispatch(latestDispatch)
        && latestDispatch.attemptId === attemptId
        && latestDispatch.state === "worker-started"
        && !latest.providerProcess?.pid
        && providerProcess.providerGeneration === (Number.isSafeInteger(latestDispatch.providerGeneration)
          ? latestDispatch.providerGeneration + 1
          : 1);
      const latestPendingRotation = isSupportedWorkerDispatch(latestDispatch)
        && latestDispatch.attemptId === attemptId
        && latestDispatch.state === "provider-started"
        && Number.isSafeInteger(latestDispatch.providerGeneration)
        && latestDispatch.providerGeneration > 0
        && latestDispatch.nextProviderGeneration === latestDispatch.providerGeneration + 1
        && providerProcess.providerGeneration === latestDispatch.nextProviderGeneration
        && completeOwnedProcessIdentity(latest.providerProcess)
        && latest.providerProcess.commandMarker === workerId
        && latest.providerProcess.dispatchAttemptId === attemptId
        && latest.providerProcess.providerGeneration === latestDispatch.providerGeneration;
      const latestRepeatedRotationWitness = isSupportedWorkerDispatch(latestDispatch)
        && latestDispatch.attemptId === attemptId
        && latestDispatch.state === "failed"
        && latest.phase === "cleanup-blocked"
        && sameUnsettledIdentity(latest.providerProcess, providerProcess)
        && latestDispatch.providerGeneration === providerProcess.providerGeneration
        && latestDispatch.nextProviderGeneration === null;
      if (latestRepeatedRotationWitness) return latest;
      if (terminalJob(latest) || (!latestInitialLaunch && !latestPendingRotation)) {
        throw new CompanionError("E_STATE", "Provider dispatch changed before unsettled cleanup evidence was published.");
      }
      assertDispatchContract(latest);
      assertNoRecoveryCleanupFence(latest, "record an unsettled provider");
      assertDispatchFence(latestDispatch, isDispatchV2(latestDispatch) ? providerProcess.dispatchFence : null);
      if (latestInitialLaunch && latest.providerProcess?.pid) {
        if (sameUnsettledIdentity(latest.providerProcess, providerProcess)) return latest;
        throw new CompanionError("E_PROCESS_IDENTITY", "Provider cleanup identity changed before publication.");
      }
      const next = {
        ...latest,
        providerProcess,
        phase: latestPendingRotation ? "cleanup-blocked" : "launch-unsettled",
        progress: latestPendingRotation
          ? "Replacement provider shutdown is unverified; terminal publication is blocked"
          : "Provider shutdown is unverified; runtime cleanup is blocked",
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            ...(latestPendingRotation && latest.request.spawn.providerRotationIntent?.status === "pending"
              ? {
                  providerRotationIntent: {
                    ...latest.request.spawn.providerRotationIntent,
                    status: "registered",
                    registeredAt: recordedAt,
                    updatedAt: recordedAt
                  },
                  ...(latest.request.spawn.providerSpawnIntent?.intentId
                    === latest.request.spawn.providerRotationIntent.intentId
                    ? {
                        providerSpawnIntent: {
                          ...latest.request.spawn.providerSpawnIntent,
                          status: "registered",
                          registeredAt: recordedAt,
                          updatedAt: recordedAt
                        }
                      }
                    : {})
                }
              : {}),
            providerLaunchPending: false,
            providerLaunchInFlight: false,
            providerLaunchOutcome: "unknown",
            dispatch: {
              ...latestDispatch,
              ...(latestPendingRotation ? {
                state: "failed",
                providerGeneration: providerProcess.providerGeneration,
                nextProviderGeneration: null,
                failedAt: recordedAt,
                providerRotationUnsettledAt: recordedAt
              } : {}),
              providerLaunchUnsettledAt: recordedAt,
              updatedAt: recordedAt
            }
          }
        },
        result: {
          ...(latest.result || {}),
          hostVerification: latest.result?.hostVerification || "not_run",
          taskRuntimeCleaned: false,
          privacyWarning: "Task runtime artifacts were retained because provider shutdown could not be verified."
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "blocked",
          latestPendingRotation
            ? "Replacement provider shutdown is unverified; terminal publication and prompt replay are forbidden."
            : "Provider shutdown is unverified; prompt replay is forbidden.",
          { replayedPrompt: false, providerGeneration: providerProcess.providerGeneration }
        )
      };
      if (!latestPendingRotation) return next;
      const message = "Replacement provider startup failed before an exact birth identity could be recorded.";
      return {
        ...next,
        status: "running",
        completedAt: null,
        pendingTerminal: {
          status: "failed",
          phase: "failed",
          completedAt: recordedAt,
          error: { code: "E_PROCESS_IDENTITY", message },
          summary: message
        },
        error: { code: "E_PROCESS_IDENTITY", message },
        summary: message,
        workerAuthorization: null
      };
    });
  }, env);
}

export function recordUnsettledWorkerProcess({
  root,
  workerId,
  attemptId,
  workerProcess,
  env = process.env
} = {}) {
  const validWitness = Boolean(
    workerProcess
    && Number.isInteger(workerProcess.pid)
    && workerProcess.pid > 0
    && (workerProcess.startToken === null || currentOwnedProcessIdentity(workerProcess))
    && (process.platform === "win32"
      ? workerProcess.processGroupId === null
      : workerProcess.processGroupId === workerProcess.pid)
    && workerProcess.commandMarker === workerId
    && workerProcess.dispatchAttemptId === attemptId
    && typeof workerProcess.nonce === "string"
    && workerProcess.nonce.length > 0
    && (workerProcess.dispatchFence === undefined
      || (Number.isSafeInteger(workerProcess.dispatchFence) && workerProcess.dispatchFence > 0))
  );
  if (!root || !workerId || !attemptId || !validWitness) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Unsettled worker cleanup requires an exact attempt-bound PID/PGID witness.");
  }
  const sameWitness = (left, right) => Boolean(
    left?.pid === right.pid
    && left.startToken === right.startToken
    && left.processGroupId === right.processGroupId
    && left.commandMarker === right.commandMarker
    && left.dispatchAttemptId === right.dispatchAttemptId
    && left.dispatchFence === right.dispatchFence
    && left.nonce === right.nonce
  );
  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    if (terminalJob(current)) return current;
    const dispatch = current.request?.spawn?.dispatch;
    if (!isSupportedWorkerDispatch(dispatch)
      || dispatch.attemptId !== attemptId
      || dispatch.state !== "controller-started"
      || current.workerProcess?.pid) {
      throw new CompanionError("E_STATE", "Unsettled worker identity no longer matches controller startup.");
    }
    assertDispatchContract(current);
    assertNoRecoveryCleanupFence(current, "record an unsettled worker");
    assertDispatchFence(dispatch, isDispatchV2(dispatch) ? workerProcess.dispatchFence : null);
    if (workerProcess.nonce !== cancellationNonce(current)) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Unsettled worker witness nonce changed before settlement.");
    }
    const existing = current.request?.spawn?.unsettledWorkerProcess;
    if (existing) {
      if (sameWitness(existing, workerProcess)) return current;
      throw new CompanionError("E_PROCESS_IDENTITY", "Worker cleanup witness changed before durable settlement.");
    }
    const recordedAt = now();
    return transaction.updateJob(workerId, (latest) => {
      const latestDispatch = latest.request?.spawn?.dispatch;
      if (terminalJob(latest)
        || latestDispatch?.attemptId !== attemptId
        || latestDispatch.state !== "controller-started"
        || latest.workerProcess?.pid) {
        throw new CompanionError("E_STATE", "Worker startup changed before cleanup witness publication.");
      }
      assertDispatchContract(latest);
      assertNoRecoveryCleanupFence(latest, "record an unsettled worker");
      assertDispatchFence(latestDispatch, isDispatchV2(latestDispatch) ? workerProcess.dispatchFence : null);
      if (workerProcess.nonce !== cancellationNonce(latest)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Unsettled worker witness nonce changed before publication.");
      }
      const latestWitness = latest.request?.spawn?.unsettledWorkerProcess;
      if (latestWitness) {
        if (sameWitness(latestWitness, workerProcess)) return latest;
        throw new CompanionError("E_PROCESS_IDENTITY", "Worker cleanup witness changed before publication.");
      }
      return {
        ...latest,
        phase: "cleanup-blocked",
        progress: "Worker child shutdown is unverified; terminal publication is blocked",
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            unsettledWorkerProcess: workerProcess,
            providerLaunchPending: false,
            providerLaunchInFlight: false,
            providerLaunchOutcome: "unknown",
            dispatch: {
              ...latestDispatch,
              workerLaunchUnsettledAt: recordedAt,
              updatedAt: recordedAt
            }
          }
        },
        result: {
          ...(latest.result || {}),
          hostVerification: latest.result?.hostVerification || "not_run",
          taskRuntimeCleaned: false,
          privacyWarning: "Task runtime artifacts were retained because worker child shutdown could not be verified."
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "blocked",
          "Worker child shutdown is unverified; prompt replay is forbidden.",
          { replayedPrompt: false }
        )
      };
    });
  }, env);
}

export function authorizeWorkerProviderRotation({
  root,
  workerId,
  attemptId,
  workerProcess,
  env = process.env
} = {}) {
  if (!workerId || !attemptId || !workerProcess) {
    throw new CompanionError("E_USAGE", "Provider rotation requires an attempt-bound worker identity.");
  }
  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    const dispatch = current.request?.spawn?.dispatch;
    if (terminalJob(current)
      || !isSupportedWorkerDispatch(dispatch)
      || !isDispatchV2(dispatch)
      || dispatch.attemptId !== attemptId
      || dispatch.state !== "provider-started") {
      throw new CompanionError("E_STATE", "Provider rotation requires one active provider-started dispatch.");
    }
    assertDispatchContract(current);
    assertNoRecoveryCleanupFence(current, "authorize provider rotation");
    if (!sameDispatchProcessIdentity(current.workerProcess, workerProcess, { nonce: true })) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Provider rotation worker identity does not match the durable dispatch.");
    }
    const generation = Number.isSafeInteger(dispatch.providerGeneration)
      ? dispatch.providerGeneration
      : 0;
    if (generation !== 1 || !completeOwnedProcessIdentity(current.providerProcess)
      || current.providerProcess.commandMarker !== workerId
      || current.providerProcess.dispatchAttemptId !== attemptId
      || current.providerProcess.providerGeneration !== generation) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Provider rotation requires the complete first provider identity.");
    }
    if (!processGroupGone(current.providerProcess)) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Provider rotation refused while the prior provider group is still active.");
    }
    let existingGuard;
    try { existingGuard = loadProviderGuard(root, workerId); }
    catch {
      throw new CompanionError("E_PROCESS_IDENTITY", "Provider guard aliases are malformed or conflicting.");
    }
    if (existingGuard) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Provider rotation requires the prior generation guard to be absent."
      );
    }
    const nextGeneration = generation + 1;
    const existingIntent = assertProviderRotationIntentContract(current, dispatch);
    if (existingIntent?.status === "pending"
      && dispatch.nextProviderGeneration === nextGeneration) {
      return Object.freeze({
        providerGeneration: nextGeneration,
        intentId: existingIntent.intentId,
        replayed: true
      });
    }
    if (existingIntent) {
      throw new CompanionError("E_STATE", "The single provider report-repair attempt was already consumed.");
    }
    if (dispatch.nextProviderGeneration !== null && dispatch.nextProviderGeneration !== undefined) {
      throw new CompanionError("E_STATE", "A legacy provider rotation is ambiguous without a durable spawn intent.");
    }
    const authorizedAt = now();
    const rotationIntent = Object.freeze({
      schemaVersion: PROVIDER_ROTATION_INTENT_SCHEMA_VERSION,
      intentId: crypto.randomBytes(16).toString("hex"),
      attemptId,
      dispatchFence: dispatch.fence,
      baseProviderGeneration: generation,
      targetProviderGeneration: nextGeneration,
      status: "pending",
      preparedAt: authorizedAt,
      updatedAt: authorizedAt,
      registeredAt: null,
      noChildAt: null,
      resolution: null
    });
    const providerSpawnIntent = Object.freeze({
      ...providerSpawnIntentBindingFields(current),
      intentId: rotationIntent.intentId,
      attemptId,
      dispatchFence: dispatch.fence,
      providerGeneration: nextGeneration,
      status: "pending",
      preparedAt: authorizedAt,
      updatedAt: authorizedAt,
      registeredAt: null,
      noChildAt: null,
      resolution: null
    });
    transaction.updateJob(workerId, (latest) => {
      const latestDispatch = latest.request?.spawn?.dispatch;
      if (terminalJob(latest)
        || latestDispatch?.attemptId !== attemptId
        || latestDispatch.state !== "provider-started"
        || latestDispatch.providerGeneration !== generation
        || latest.request?.spawn?.providerRotationIntent != null
        || latest.request?.spawn?.providerSpawnIntent?.providerGeneration === nextGeneration
        || (latestDispatch.nextProviderGeneration !== null
          && latestDispatch.nextProviderGeneration !== undefined)) {
        throw new CompanionError("E_STATE", "Provider rotation state changed before authorization publication.");
      }
      assertDispatchContract(latest);
      assertNoRecoveryCleanupFence(latest, "authorize provider rotation");
      if (!sameDispatchProcessIdentity(latest.workerProcess, workerProcess, { nonce: true })
        || !sameDispatchProcessIdentity(latest.providerProcess, current.providerProcess)
        || !processGroupGone(latest.providerProcess)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Provider rotation identity changed before authorization publication.");
      }
      let latestGuard;
      try { latestGuard = loadProviderGuard(root, workerId); }
      catch {
        throw new CompanionError("E_PROCESS_IDENTITY", "Provider guard aliases changed before rotation authorization.");
      }
      if (latestGuard) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Provider guard appeared before rotation authorization.");
      }
      const next = {
        ...latest,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request?.spawn,
            providerRotationIntent: rotationIntent,
            providerSpawnIntent,
            providerLaunchPending: false,
            providerLaunchInFlight: true,
            providerLaunchOutcome: "pending",
            providerLaunchAttemptedAt: authorizedAt,
            providerLaunchCompletedAt: null,
            dispatch: {
              ...latestDispatch,
              nextProviderGeneration: nextGeneration,
              providerRotationAuthorizedAt: authorizedAt,
              updatedAt: authorizedAt
            }
          }
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "checkpoint",
          "Authorized one same-session provider report repair.",
          { providerGeneration: nextGeneration }
        )
      };
      assertDispatchContract(next);
      return next;
    });
    return Object.freeze({
      providerGeneration: nextGeneration,
      intentId: rotationIntent.intentId,
      replayed: false
    });
  }, env);
}

export function recordWorkerProviderRotationNoChild({
  root,
  workerId,
  attemptId,
  fence,
  intentId,
  resolution = "spawn-not-created",
  env = process.env
} = {}) {
  return recordWorkerProviderSpawnNoChild({
    root,
    workerId,
    attemptId,
    fence,
    providerGeneration: 2,
    intentId,
    resolution,
    env
  });
}
