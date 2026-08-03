/** Issue #56 worker-mutation dispatch-contract domain. */
import crypto from "node:crypto";
import path from "node:path";
import { CompanionError, asErrorPayload } from "./errors.mjs";
import {
  assertProviderLaunchBinding,
  providerLaunchBindingDigest as digestProviderLaunchBinding
} from "./provider-executable-pin.mjs";
import {
  assertRuntimeRolePolicy,
  buildRuntimeRolePolicy,
  materializeRole,
  assertRoleDigest
} from "./worker-roles.mjs";
import { profileFor, sameSecurityProfile } from "./profiles.mjs";
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
  completeOwnedProcessIdentity,
  isPlainRecord,
  sameDispatchProcessWitness,
  stableDigest,
  validIsoTimestamp
} from "./worker-mutation-primitives.mjs";

export const WORKER_DISPATCH_SCHEMA_VERSION = WORKER_DISPATCH_OUTBOX_SCHEMA_VERSION;

export const WORKER_SPAWN_INTENT_SCHEMA_VERSION = 1;

export const RECOVERY_CLEANUP_FENCE_SCHEMA_VERSION = 1;

export const PROVIDER_ROTATION_INTENT_SCHEMA_VERSION = 1;

export const PROVIDER_SPAWN_INTENT_SCHEMA_VERSION = 1;

export const BOUND_PROVIDER_SPAWN_INTENT_SCHEMA_VERSION = 2;

export function assertBoundDispatchProcess(job, dispatch, identity, processKind, {
  allowMissing = false,
  allowUnsettled = false,
  providerGeneration = null
} = {}) {
  if (identity == null) {
    if (allowMissing) return null;
    throw new CompanionError("E_PROCESS_IDENTITY", `Worker dispatch ${processKind} identity is missing.`);
  }
  const startTokenValid = allowUnsettled && identity.startToken === null
    ? true
    : typeof identity.startToken === "string"
      && identity.startToken.length > 0
      && identity.startToken.length <= 256
      && identity.startToken !== "[REDACTED]";
  const bound = isPlainRecord(identity)
    && Number.isInteger(identity.pid)
    && identity.pid > 0
    && startTokenValid
    && Object.hasOwn(identity, "processGroupId")
    && (process.platform === "win32"
      ? identity.processGroupId === null
      : identity.processGroupId === identity.pid)
    && identity.commandMarker === job.id
    && identity.dispatchAttemptId === dispatch.attemptId
    && identity.dispatchFence === dispatch.fence
    && (processKind === "provider"
      ? Number.isSafeInteger(identity.providerGeneration)
        && identity.providerGeneration === providerGeneration
      : typeof identity.nonce === "string" && identity.nonce.length > 0);
  if (!bound) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      `Worker dispatch ${processKind} identity is not bound to the active attempt and fence.`
    );
  }
  return identity;
}

export function assertBoundSpawnIntent(job, dispatch, field, processKind, { allowMissing = false } = {}) {
  const intent = job?.request?.spawn?.[field];
  if (intent == null) {
    if (allowMissing) return null;
    throw new CompanionError("E_PROCESS_IDENTITY", `Worker dispatch ${processKind} spawn intent is missing.`);
  }
  const bound = isPlainRecord(intent)
    && intent.schemaVersion === WORKER_SPAWN_INTENT_SCHEMA_VERSION
    && intent.processKind === processKind
    && /^[0-9a-f]{32}$/.test(intent.intentId || "")
    && intent.attemptId === dispatch.attemptId
    && intent.fence === dispatch.fence
    && ["pending", "registered", "no-child"].includes(intent.status);
  if (!bound) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      `Worker dispatch ${processKind} spawn intent is not bound to the active attempt and fence.`
    );
  }
  return intent;
}

export const RECOVERY_CLEANUP_FENCE_KEYS = new Set([
  "schemaVersion",
  "fenceId",
  "authority",
  "source",
  "mode",
  "processKind",
  "dispatchState",
  "attemptId",
  "dispatchFence",
  "processIdentity",
  "claimedAt"
]);

export const PROVIDER_ROTATION_INTENT_KEYS = new Set([
  "schemaVersion",
  "intentId",
  "attemptId",
  "dispatchFence",
  "baseProviderGeneration",
  "targetProviderGeneration",
  "status",
  "preparedAt",
  "updatedAt",
  "registeredAt",
  "noChildAt",
  "resolution"
]);

export const PROVIDER_SPAWN_INTENT_KEYS = new Set([
  "schemaVersion",
  "intentId",
  "attemptId",
  "dispatchFence",
  "providerGeneration",
  "status",
  "preparedAt",
  "updatedAt",
  "registeredAt",
  "noChildAt",
  "resolution"
]);

export const BOUND_PROVIDER_SPAWN_INTENT_KEYS = new Set([
  ...PROVIDER_SPAWN_INTENT_KEYS,
  "providerLaunchBinding",
  "providerLaunchBindingDigest"
]);

export function normalizeProviderLaunchBindingInput(
  providerLaunchBinding,
  providerLaunchBindingDigest,
  { required = false } = {}
) {
  if (providerLaunchBinding == null && providerLaunchBindingDigest == null && !required) {
    return null;
  }
  let binding;
  try {
    binding = assertProviderLaunchBinding(providerLaunchBinding);
  } catch {
    throw new CompanionError(
      "E_CAPABILITY",
      "Provider executable launch binding is missing or malformed."
    );
  }
  if (providerLaunchBindingDigest !== digestProviderLaunchBinding(binding)) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Provider executable launch binding digest is inconsistent."
    );
  }
  return binding;
}

export function providerSpawnIntentBindingFields(job) {
  const binding = providerLaunchBindingForJob(job, { required: false });
  return binding
    ? {
        schemaVersion: BOUND_PROVIDER_SPAWN_INTENT_SCHEMA_VERSION,
        providerLaunchBinding: binding,
        providerLaunchBindingDigest:
          job.request.spawn.providerLaunchBindingDigest
      }
    : { schemaVersion: PROVIDER_SPAWN_INTENT_SCHEMA_VERSION };
}

export function assertProviderSpawnIntentContract(job, dispatch, { allowMissing = true } = {}) {
  const intent = job?.request?.spawn?.providerSpawnIntent;
  if (intent == null) {
    if (allowMissing) return null;
    throw new CompanionError("E_PROCESS_IDENTITY", "Provider spawn intent is missing.");
  }
  const durableBinding = providerLaunchBindingForJob(job, { required: false });
  const intentKeys = durableBinding
    ? BOUND_PROVIDER_SPAWN_INTENT_KEYS
    : PROVIDER_SPAWN_INTENT_KEYS;
  const exact = isPlainRecord(intent)
    && Object.keys(intent).length === intentKeys.size
    && Object.keys(intent).every((key) => intentKeys.has(key))
    && intent.schemaVersion === (durableBinding
      ? BOUND_PROVIDER_SPAWN_INTENT_SCHEMA_VERSION
      : PROVIDER_SPAWN_INTENT_SCHEMA_VERSION)
    && (!durableBinding
      || (intent.providerLaunchBindingDigest
          === job.request.spawn.providerLaunchBindingDigest
        && stableDigest(intent.providerLaunchBinding)
          === stableDigest(durableBinding)))
    && /^[0-9a-f]{32}$/.test(intent.intentId || "")
    && intent.attemptId === dispatch.attemptId
    && intent.dispatchFence === dispatch.fence
    && Number.isSafeInteger(intent.providerGeneration)
    && intent.providerGeneration >= 1
    && intent.providerGeneration <= 2
    && ["pending", "registered", "no-child"].includes(intent.status)
    && validIsoTimestamp(intent.preparedAt)
    && validIsoTimestamp(intent.updatedAt)
    && (intent.registeredAt === null || validIsoTimestamp(intent.registeredAt))
    && (intent.noChildAt === null || validIsoTimestamp(intent.noChildAt))
    && (intent.resolution === null
      || ["spawn-not-created", "cleanup-proven", "authorization-revoked"].includes(intent.resolution));
  if (!exact) {
    throw new CompanionError("E_STATE", "Provider spawn intent is malformed or not dispatch-bound.");
  }
  const active = intent.status === "pending"
    ? intent.registeredAt === null && intent.noChildAt === null && intent.resolution === null
    : intent.status === "registered"
      ? validIsoTimestamp(intent.registeredAt) && intent.noChildAt === null && intent.resolution === null
      : false;
  const noChild = intent.status === "no-child"
    && (intent.registeredAt === null || validIsoTimestamp(intent.registeredAt))
    && validIsoTimestamp(intent.noChildAt)
    && intent.resolution !== null;
  if (!active && !noChild) {
    throw new CompanionError("E_STATE", "Provider spawn intent status fields are inconsistent.");
  }
  const initial = intent.providerGeneration === 1
    && dispatch.providerGeneration === (dispatch.state === "provider-started" ? 1 : 0)
    && dispatch.nextProviderGeneration == null;
  const rotation = intent.providerGeneration === 2
    && (
      (dispatch.providerGeneration === 1 && dispatch.nextProviderGeneration === 2)
      || (dispatch.nextProviderGeneration == null
        && ((intent.status === "registered" && dispatch.providerGeneration === 2)
          || (intent.status === "no-child" && dispatch.providerGeneration === 1)))
    );
  if (!initial && !rotation) {
    throw new CompanionError("E_STATE", "Provider spawn intent disagrees with the durable generation.");
  }
  return intent;
}

export function assertProviderRotationIntentContract(job, dispatch) {
  const intent = job?.request?.spawn?.providerRotationIntent;
  if (intent == null) return null;
  const exact = isPlainRecord(intent)
    && Object.keys(intent).length === PROVIDER_ROTATION_INTENT_KEYS.size
    && Object.keys(intent).every((key) => PROVIDER_ROTATION_INTENT_KEYS.has(key))
    && intent.schemaVersion === PROVIDER_ROTATION_INTENT_SCHEMA_VERSION
    && /^[0-9a-f]{32}$/.test(intent.intentId || "")
    && intent.attemptId === dispatch.attemptId
    && intent.dispatchFence === dispatch.fence
    && intent.baseProviderGeneration === 1
    && intent.targetProviderGeneration === 2
    && ["pending", "registered", "no-child"].includes(intent.status)
    && validIsoTimestamp(intent.preparedAt)
    && validIsoTimestamp(intent.updatedAt)
    && (intent.registeredAt === null || validIsoTimestamp(intent.registeredAt))
    && (intent.noChildAt === null || validIsoTimestamp(intent.noChildAt))
    && (intent.resolution === null
      || ["spawn-not-created", "cleanup-proven", "authorization-revoked"].includes(intent.resolution));
  if (!exact) {
    throw new CompanionError("E_STATE", "Provider rotation intent is malformed or not attempt-bound.");
  }
  const pending = intent.status === "pending"
    && dispatch.state === "provider-started"
    && dispatch.providerGeneration === intent.baseProviderGeneration
    && dispatch.nextProviderGeneration === intent.targetProviderGeneration
    && intent.registeredAt === null
    && intent.noChildAt === null
    && intent.resolution === null;
  const registered = intent.status === "registered"
    && ["provider-started", "failed"].includes(dispatch.state)
    && dispatch.providerGeneration === intent.targetProviderGeneration
    && dispatch.nextProviderGeneration === null
    && validIsoTimestamp(intent.registeredAt)
    && intent.noChildAt === null
    && intent.resolution === null;
  const noChild = intent.status === "no-child"
    && dispatch.providerGeneration === intent.baseProviderGeneration
    && dispatch.nextProviderGeneration === null
    && (intent.registeredAt === null || validIsoTimestamp(intent.registeredAt))
    && validIsoTimestamp(intent.noChildAt)
    && ["spawn-not-created", "cleanup-proven", "authorization-revoked"].includes(intent.resolution);
  if (!pending && !registered && !noChild) {
    throw new CompanionError("E_STATE", "Provider rotation intent disagrees with the durable provider generation.");
  }
  return intent;
}

export function recoveryCleanupSource(job, source) {
  if (source === "controller-cleanup") {
    return {
      processKind: "controller",
      identity: job?.request?.spawn?.controllerCleanupProcess || null,
      nonce: true
    };
  }
  if (source === "unsettled-worker") {
    return {
      processKind: "worker",
      identity: job?.request?.spawn?.unsettledWorkerProcess || null,
      nonce: true
    };
  }
  if (source === "provider-generation") {
    return {
      processKind: "provider",
      identity: job?.providerProcess || null,
      nonce: false
    };
  }
  return null;
}

export function assertRecoveryCleanupFenceContract(job, dispatch) {
  const cleanupFence = job?.request?.spawn?.cleanupFence;
  if (cleanupFence == null) return null;
  const source = recoveryCleanupSource(job, cleanupFence.source);
  const exact = isPlainRecord(cleanupFence)
    && Object.keys(cleanupFence).length === RECOVERY_CLEANUP_FENCE_KEYS.size
    && Object.keys(cleanupFence).every((key) => RECOVERY_CLEANUP_FENCE_KEYS.has(key))
    && cleanupFence.schemaVersion === RECOVERY_CLEANUP_FENCE_SCHEMA_VERSION
    && /^[0-9a-f]{32}$/.test(cleanupFence.fenceId || "")
    && cleanupFence.authority === "host-trusted-reconciler"
    && source
    && cleanupFence.processKind === source.processKind
    && cleanupFence.dispatchState === dispatch.state
    && cleanupFence.attemptId === dispatch.attemptId
    && cleanupFence.dispatchFence === dispatch.fence
    && validIsoTimestamp(cleanupFence.claimedAt)
    && ["signal", "observe-only"].includes(cleanupFence.mode)
    && cleanupFence.mode === (cleanupFence.processIdentity?.startToken === null
      ? "observe-only"
      : "signal")
    && sameDispatchProcessWitness(source.identity, cleanupFence.processIdentity, {
      nonce: source.nonce,
      allowUnsettled: true
    })
    && (cleanupFence.source !== "provider-generation" || dispatch.nextProviderGeneration == null);
  if (!exact) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Recovery cleanup fence is malformed or no longer matches the durable process generation."
    );
  }
  return cleanupFence;
}

export function assertDispatchLifecycleContract(job, dispatch) {
  const state = dispatch.state;
  assertRecoveryCleanupFenceContract(job, dispatch);
  const providerRotationIntent = assertProviderRotationIntentContract(job, dispatch);
  const providerSpawnIntent = assertProviderSpawnIntentContract(job, dispatch);
  const controllerRequired = ["controller-started", "worker-started", "provider-started"].includes(state);
  const workerRequired = ["worker-started", "provider-started"].includes(state);
  const providerRequired = state === "provider-started";
  const controller = assertBoundDispatchProcess(job, dispatch, job.controllerProcess, "controller", {
    allowMissing: !controllerRequired
  });
  const worker = assertBoundDispatchProcess(job, dispatch, job.workerProcess, "worker", {
    allowMissing: !workerRequired
  });
  if (["pending", "claimed"].includes(state) && (controller || worker || job.providerProcess != null)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Pre-controller dispatch retains an impossible process witness.");
  }
  if (state === "controller-started" && (worker || job.providerProcess != null)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Controller-started dispatch retains a premature process witness.");
  }

  const unsettledProvider = Boolean(dispatch.providerLaunchUnsettledAt)
    && ["worker-started", "failed"].includes(state);
  const expectedProviderGeneration = state === "worker-started"
    ? dispatch.providerGeneration + 1
    : dispatch.providerGeneration;
  const provider = assertBoundDispatchProcess(job, dispatch, job.providerProcess, "provider", {
    allowMissing: !providerRequired && !unsettledProvider,
    allowUnsettled: unsettledProvider,
    providerGeneration: expectedProviderGeneration
  });

  const controllerIntent = assertBoundSpawnIntent(
    job,
    dispatch,
    "controllerSpawnIntent",
    "controller",
    { allowMissing: ["pending", "claimed", "failed"].includes(state) }
  );
  const workerIntent = assertBoundSpawnIntent(
    job,
    dispatch,
    "workerSpawnIntent",
    "worker",
    { allowMissing: ["pending", "claimed", "controller-started", "failed"].includes(state) }
  );
  if (state === "pending" && (controllerIntent || workerIntent)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Pending dispatch cannot retain a process spawn intent.");
  }
  if (state === "claimed"
    && (controllerIntent?.status === "registered" || workerIntent != null)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Claimed dispatch retains an impossible registered process intent.");
  }
  if (state === "controller-started" && workerIntent?.status === "registered") {
    throw new CompanionError("E_PROCESS_IDENTITY", "Controller-started dispatch retains a registered worker without its process.");
  }
  if (controllerRequired && controllerIntent?.status !== "registered") {
    throw new CompanionError("E_PROCESS_IDENTITY", "Controller process is not paired with a registered spawn intent.");
  }
  if (workerRequired && workerIntent?.status !== "registered") {
    throw new CompanionError("E_PROCESS_IDENTITY", "Worker process is not paired with a registered spawn intent.");
  }
  if (state === "provider-started"
    && providerSpawnIntent?.providerGeneration === dispatch.providerGeneration
    && providerSpawnIntent.status !== "registered") {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Durable provider identity is not paired with its registered spawn intent."
    );
  }
  if (providerRotationIntent) {
    const matchingStatus = providerRotationIntent.status === "pending"
      ? ["pending", "registered"].includes(providerSpawnIntent?.status)
      : providerSpawnIntent?.status === providerRotationIntent.status;
    const matchingSettlement = providerRotationIntent.status === "pending"
      || (
        providerSpawnIntent?.registeredAt === providerRotationIntent.registeredAt
        && providerSpawnIntent?.noChildAt === providerRotationIntent.noChildAt
        && providerSpawnIntent?.resolution === providerRotationIntent.resolution
      );
    if (!providerSpawnIntent
      || providerSpawnIntent.intentId !== providerRotationIntent.intentId
      || providerSpawnIntent.providerGeneration !== providerRotationIntent.targetProviderGeneration
      || !matchingStatus
      || !matchingSettlement) {
      throw new CompanionError(
        "E_STATE",
        "Provider rotation and spawn intents do not describe one exact launch boundary."
      );
    }
  }

  const unsettledWorker = job?.request?.spawn?.unsettledWorkerProcess;
  if (unsettledWorker != null) {
    if (state !== "controller-started" || !dispatch.workerLaunchUnsettledAt || job.workerProcess != null) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Unsettled worker witness is inconsistent with dispatch state.");
    }
    if (!workerIntent || workerIntent.status === "registered") {
      throw new CompanionError("E_PROCESS_IDENTITY", "Unsettled worker witness is missing its unresolved spawn intent.");
    }
    assertBoundDispatchProcess(job, dispatch, unsettledWorker, "worker", { allowUnsettled: true });
    if (unsettledWorker.nonce !== (controller?.nonce || job?.workerAuthorization?.nonce)) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Unsettled worker witness does not share the active launch nonce.");
    }
  }
  const controllerCleanup = job?.request?.spawn?.controllerCleanupProcess;
  if (controllerCleanup != null) {
    if (!["claimed", "controller-started", "failed"].includes(state)
      || job?.request?.spawn?.controllerCleanupPending !== true
      || !controllerIntent) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Controller cleanup witness is inconsistent with dispatch state.");
    }
    assertBoundDispatchProcess(job, dispatch, controllerCleanup, "controller", { allowUnsettled: true });
    if (controllerCleanup.nonce !== (controller?.nonce || job?.workerAuthorization?.nonce)) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Controller cleanup witness does not share the active launch nonce.");
    }
  }

  if (controller && worker && controller.nonce !== worker.nonce) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Controller and worker witnesses do not share one launch nonce.");
  }
  if (worker && !controller) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Worker process witness is missing its controller lineage.");
  }
  if (provider && (!controller || !worker)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Provider process witness is missing its controller/worker lineage.");
  }
  const authorizationNonce = job?.workerAuthorization?.nonce;
  if (authorizationNonce
    && ((controller && controller.nonce !== authorizationNonce)
      || (worker && worker.nonce !== authorizationNonce))) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Process witness nonce does not match launch authorization.");
  }
  return job;
}

export function exactLegacyPendingAuthorization(job, principal) {
  const authorization = job?.workerAuthorization;
  const dispatch = job?.request?.spawn?.dispatch;
  const authorizationKeys = new Set([
    "schemaVersion",
    "nonce",
    "ownerThreadId",
    "purpose",
    "issuedAt"
  ]);
  const dispatchKeys = new Set([
    "schemaVersion",
    "state",
    "attemptId",
    "providerGeneration",
    "nextProviderGeneration",
    "claimedAt",
    "createdAt",
    "updatedAt"
  ]);
  return Boolean(
    job?.host?.kind === "codex"
    && job?.status === "queued"
    && job?.phase === "accepted"
    && principal?.hostKind === "codex"
    && authorization
    && typeof authorization === "object"
    && !Array.isArray(authorization)
    && Object.keys(authorization).length === authorizationKeys.size
    && Object.keys(authorization).every((key) => authorizationKeys.has(key))
    && authorization.schemaVersion === 1
    && /^[0-9a-f]{32}$/.test(authorization.nonce || "")
    && authorization.ownerThreadId === job?.host?.sessionId
    && authorization.ownerThreadId === principal?.threadId
    && authorization.purpose === "launch-worker"
    && validIsoTimestamp(authorization.issuedAt)
    && authorization.issuedAt === job?.createdAt
    && dispatch
    && typeof dispatch === "object"
    && !Array.isArray(dispatch)
    && Object.keys(dispatch).length === dispatchKeys.size
    && Object.keys(dispatch).every((key) => dispatchKeys.has(key))
    && dispatch.schemaVersion === 1
    && dispatch.state === "pending"
    && dispatch.attemptId === null
    && dispatch.providerGeneration === 0
    && dispatch.nextProviderGeneration === null
    && dispatch.claimedAt === null
    && validIsoTimestamp(dispatch.createdAt)
    && validIsoTimestamp(dispatch.updatedAt)
    && dispatch.createdAt === job.createdAt
    && dispatch.updatedAt === dispatch.createdAt
  );
}

export function exactLegacyTaskSecurityProfile(profile, write) {
  if (!isPlainRecord(profile)) return false;
  const expected = { ...profileFor("task", Boolean(write)) };
  delete expected.providerToolIds;
  delete expected.deniedProviderToolIds;
  const expectedKeys = Object.keys(expected).sort();
  const observedKeys = Object.keys(profile).sort();
  return observedKeys.length === expectedKeys.length
    && observedKeys.every((key, index) => key === expectedKeys[index])
    && expectedKeys.every((key) => (
      JSON.stringify(profile[key]) === JSON.stringify(expected[key])
    ));
}

export function providerLaunchState(job) {
  const dispatch = job?.request?.spawn?.dispatch;
  const completeProviderIdentity = (
    completeOwnedProcessIdentity(job?.providerProcess)
    && (!isSupportedWorkerDispatch(dispatch) || (
      dispatch.state === "provider-started"
      && dispatch.attemptId
      && Number.isSafeInteger(dispatch.providerGeneration)
      && dispatch.providerGeneration > 0
      && job.providerProcess.providerGeneration === dispatch.providerGeneration
      && job.providerProcess.commandMarker === job.id
      && job.providerProcess.dispatchAttemptId === dispatch.attemptId
      && (!isDispatchV2(dispatch) || job.providerProcess.dispatchFence === dispatch.fence)
    ))
  );
  if (completeProviderIdentity) {
    return "started";
  }
  if (job?.request?.spawn?.dispatch?.state === "failed" || terminalWithoutProvider(job)) {
    return "failed";
  }
  return "pending";
}

export function terminalJob(job) {
  return ["completed", "failed", "cancelled"].includes(job?.status);
}

export function terminalWithoutProvider(job) {
  return terminalJob(job)
    && !Number.isInteger(job?.providerProcess?.pid);
}

export function assertDispatchContract(job) {
  const role = assertRoleDigest(job?.role);
  if (role.id !== job?.request?.roleId
    || Boolean(role.write) !== Boolean(job?.write)
    || !sameSecurityProfile(job?.profile, profileFor("task", Boolean(job?.write)))) {
    throw new CompanionError("E_ROLE", "Worker role or provider profile does not match the durable dispatch contract.");
  }
  const dispatch = job?.request?.spawn?.dispatch;
  if (isDispatchV2(dispatch)) {
    const executionRoot = job?.request?.spawn?.executionRoot;
    if (typeof executionRoot !== "string"
      || !path.isAbsolute(executionRoot)
      || path.normalize(executionRoot) !== executionRoot
      || executionRoot.length > 4096) {
      throw new CompanionError("E_STATE", "Worker dispatch-v2 is missing its canonical execution root.");
    }
    const authorization = job?.workerAuthorization
      ? assertWorkerAuthorization(job, { allowLegacy: false })
      : null;
    const spawn = job?.request?.spawn || {};
    const digestPresent = Object.hasOwn(spawn, "consumedLaunchContractDigest");
    const consumedAtPresent = Object.hasOwn(spawn, "launchContractConsumedAt");
    const consumedDigest = spawn.consumedLaunchContractDigest;
    const consumedAt = spawn.launchContractConsumedAt;
    if (authorization && (digestPresent || consumedAtPresent)) {
      throw new CompanionError(
        "E_AUTH_REQUIRED",
        "Worker launch authorization cannot remain active after durable consumption."
      );
    }
    const consumption = {};
    if (digestPresent) consumption.digest = consumedDigest;
    if (consumedAtPresent) consumption.consumedAt = consumedAt;
    assertDispatchV2(dispatch, {
      authorization,
      consumption
    });
    if (!authorization && (digestPresent || consumedAtPresent)) {
      const prompt = job?.request?.prompt;
      const promptMatches = typeof prompt !== "string"
        || crypto.createHash("sha256").update(prompt).digest("hex") === job?.request?.providerPromptDigest;
      if (consumedDigest !== launchContractDigest(job) || !promptMatches) {
        throw new CompanionError(
          "E_AUTH_REQUIRED",
          "Consumed worker launch authorization no longer matches its durable contract."
        );
      }
    }
    assertDispatchLifecycleContract(job, dispatch);
  }
  return role;
}

export function assertNoRecoveryCleanupFence(job, operation = "advance worker dispatch") {
  if (job?.request?.spawn?.cleanupFence != null) {
    throw new CompanionError(
      "E_STATE",
      `Cannot ${operation} while host recovery owns an exact cleanup fence.`
    );
  }
  return job;
}

export function assertTransitionNotCleanupClaimed(job, state) {
  assertNoRecoveryCleanupFence(job, `transition worker dispatch to ${state}`);
  const spawn = job?.request?.spawn || {};
  if (["controller-started", "worker-started", "provider-started", "failed"].includes(state)
    && (spawn.controllerCleanupPending === true || spawn.controllerCleanupProcess != null)) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Controller cleanup authority was already published before process registration."
    );
  }
  if (["worker-started", "provider-started", "failed"].includes(state)
    && (spawn.unsettledWorkerProcess != null
      || spawn.dispatch?.workerLaunchUnsettledAt != null)) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Worker cleanup authority was already published before process registration."
    );
  }
  if (["provider-started", "failed"].includes(state)
    && (spawn.dispatch?.providerLaunchUnsettledAt != null
      || (job.providerProcess != null && job.providerProcess.startToken === null))) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Provider cleanup authority was already published before provider registration."
    );
  }
  if (state === "failed"
    && (spawn.providerRotationIntent?.status === "pending"
      || spawn.dispatch?.nextProviderGeneration != null)) {
    throw new CompanionError(
      "E_STATE",
      "Pending provider rotation must be durably resolved before dispatch failure."
    );
  }
  return job;
}

export function recoveryCleanupFenceMatches(job, fenceId, allowedSources) {
  const cleanupFence = job?.request?.spawn?.cleanupFence;
  if (cleanupFence == null) return fenceId == null;
  return typeof fenceId === "string"
    && cleanupFence.fenceId === fenceId
    && allowedSources.includes(cleanupFence.source);
}
