import path from "node:path";

import { CompanionError } from "./errors.mjs";
import { readValidProviderCapabilityReceipt } from "./provider-capability.mjs";
import {
  isCancelRequested,
  listBrokerRecoveryCandidates
} from "./state.mjs";
import { isCanonicalUuid } from "./worker-authority.mjs";
import {
  assertWorkerAuthorization,
  dispatchLeaseExpired,
  isDispatchV2
} from "./worker-launch-contract.mjs";
import {
  assertDurableSpawnRequestBinding,
  assertDispatchContract,
  SPAWN_OWNERSHIP_MODE,
  SPAWN_SUCCESS_DEFINITION
} from "./worker-mutation.mjs";
import { launchCommittedWorker } from "./worker-runtime.mjs";
import {
  controlStateSegment,
  resolveControlWorkspace
} from "./workspace.mjs";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const GROK_PLUGIN_ID = /^grok(?:@[a-zA-Z0-9][a-zA-Z0-9._-]{0,127})?$/;
const INTENT_FIELDS = Object.freeze([
  "controllerSpawnIntent",
  "workerSpawnIntent",
  "providerSpawnIntent",
  "providerRotationIntent"
]);
const PROCESS_FIELDS = Object.freeze([
  "controllerProcess",
  "workerProcess",
  "providerProcess"
]);
const AMBIGUOUS_SPAWN_FIELDS = Object.freeze([
  "controllerCleanupProcess",
  "unsettledWorkerProcess",
  "unsettledProviderProcess",
  "cleanupFence"
]);
const DEFAULT_MAX_LAUNCHES = 16;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RUNS = 4;

function hasLaunchEvidence(job) {
  const spawn = job.request?.spawn || {};
  return INTENT_FIELDS.some((key) => Object.hasOwn(spawn, key))
    || AMBIGUOUS_SPAWN_FIELDS.some((key) => Object.hasOwn(spawn, key))
    || PROCESS_FIELDS.some((key) => Object.hasOwn(job, key))
    || Object.hasOwn(job, "pendingTerminal");
}

function principalFromAuthorization(authorization) {
  return Object.freeze({
    hostKind: authorization.owner.hostKind,
    threadId: authorization.owner.sessionId,
    pluginId: authorization.owner.pluginId
  });
}

/** Validate one scanned job without granting any state mutation authority. */
export function validateRecoveryCandidate(candidate, {
  capabilityReceipt,
  env = process.env,
  clock = () => Date.now()
} = {}) {
  const job = candidate?.job;
  if (!job
    || job.schemaVersion !== 3
    || job.kind !== "task"
    || job.jobClass !== "task"
    || job.write !== false
    || job.host?.kind !== "codex"
    || !isCanonicalUuid(job.host?.sessionId)
    || !["queued", "running"].includes(job.status)) {
    throw new CompanionError("E_AUTH_REQUIRED", "Worker recovery candidate is not an active read-only Codex task.");
  }
  const authorization = assertWorkerAuthorization(job, { allowLegacy: false });
  if (authorization.purpose !== "launch-worker"
    || authorization.owner.hostKind !== "codex"
    || !isCanonicalUuid(authorization.owner.sessionId)
    || typeof authorization.owner.pluginId !== "string"
    || !GROK_PLUGIN_ID.test(authorization.owner.pluginId)) {
    throw new CompanionError("E_AUTH_REQUIRED", "Worker recovery authorization is not a Grok launch grant.");
  }
  assertDispatchContract(job);
  if (typeof job.request?.envelope?.userRequest !== "string") {
    throw new CompanionError("E_AUTH_REQUIRED", "Autonomous recovery requires the literal admitted task request.");
  }
  assertDurableSpawnRequestBinding(job, env);
  const dispatch = job.request?.spawn?.dispatch;
  if (!isDispatchV2(dispatch)) {
    throw new CompanionError("E_AUTH_REQUIRED", "Legacy worker dispatches are never launched autonomously.");
  }
  const capabilityDigest = capabilityReceipt?.capabilityDigest;
  if (!SHA256_HEX.test(capabilityDigest || "")
    || job.request?.spawn?.providerCapabilityDigest !== capabilityDigest) {
    throw new CompanionError("E_CAPABILITY", "Worker recovery capability receipt is missing, stale, or mismatched.");
  }
  const spawn = job.request?.spawn;
  if (!spawn
    || !SHA256_HEX.test(spawn.idempotencyKeyDigest || "")
    || spawn.ownerThreadId !== authorization.owner.sessionId
    || spawn.successDefinition !== SPAWN_SUCCESS_DEFINITION
    || spawn.ownershipMode !== SPAWN_OWNERSHIP_MODE
    || spawn.providerLaunchPending !== true
    || spawn.providerLaunchInFlight !== false
    || spawn.providerLaunchOutcome !== "pending"
    || hasLaunchEvidence(job)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Worker recovery candidate already has launch or cleanup evidence.");
  }
  const executionRoot = spawn.executionRoot;
  if (typeof executionRoot !== "string"
    || !path.isAbsolute(executionRoot)
    || path.normalize(executionRoot) !== executionRoot
    || executionRoot.length > 4_096) {
    throw new CompanionError("E_STATE", "Worker recovery execution root is malformed.");
  }
  const control = resolveControlWorkspace(executionRoot, env);
  if (control.executionRoot !== executionRoot
    || control.controlWorkspaceId !== job.controlWorkspaceId
    || control.controlWorkspaceId !== authorization.controlWorkspaceId
    || candidate.stateSegment !== controlStateSegment(control.controlWorkspaceId)) {
    throw new CompanionError("E_AUTH_REQUIRED", "Worker recovery state directory is not bound to the execution workspace.");
  }
  const observedAt = Number(clock());
  if (!Number.isFinite(observedAt)) {
    throw new CompanionError("E_STATE", "Worker recovery clock is invalid.");
  }
  const pending = dispatch.state === "pending"
    && dispatch.attemptId === null
    && dispatch.fence === 0
    && dispatch.lease === null;
  const reclaimable = dispatch.state === "claimed"
    && dispatchLeaseExpired(dispatch, observedAt);
  if (!pending && !reclaimable) {
    throw new CompanionError("E_STATE", "Worker recovery dispatch is not safely launchable.");
  }
  if (isCancelRequested(executionRoot, job.id, authorization.nonce, env)) {
    throw new CompanionError("E_CANCELLED", "Worker recovery candidate was cancelled before launch.");
  }
  return Object.freeze({
    root: executionRoot,
    workerId: job.id,
    principal: principalFromAuthorization(authorization),
    dispatchState: dispatch.state
  });
}

/** Drain a bounded set of exact durable launch grants. */
export async function drainAuthorizedPendingDispatches({
  env = process.env,
  scan = listBrokerRecoveryCandidates,
  readCapability = readValidProviderCapabilityReceipt,
  launchWorker = launchCommittedWorker,
  clock = () => Date.now(),
  maxLaunches = DEFAULT_MAX_LAUNCHES,
  scanLimits = null
} = {}) {
  if (!Number.isSafeInteger(maxLaunches) || maxLaunches < 1 || maxLaunches > 64) {
    throw new CompanionError("E_USAGE", "Worker recovery launch budget is invalid.");
  }
  let capabilityReceipt;
  let candidates;
  try {
    capabilityReceipt = readCapability({ env });
    if (!SHA256_HEX.test(capabilityReceipt?.capabilityDigest || "")) {
      return Object.freeze({ scanned: 0, launched: 0, reconcileOnly: 0, capabilityAvailable: false });
    }
    candidates = scan({ env, ...(scanLimits ? { limits: scanLimits } : {}) });
  } catch {
    return Object.freeze({ scanned: 0, launched: 0, reconcileOnly: 0, capabilityAvailable: false });
  }
  let launched = 0;
  let reconcileOnly = 0;
  let capabilityAvailable = true;
  for (const candidate of candidates) {
    if (launched >= maxLaunches) break;
    let launch;
    try {
      launch = validateRecoveryCandidate(candidate, {
        capabilityReceipt,
        env,
        clock
      });
      // The initial receipt only authorizes discovery. Re-read it at the
      // launch boundary so expiry, setup revocation, profile drift, or binary
      // replacement during a bounded scan cannot start a provider.
      const liveCapability = readCapability({ env });
      if (!SHA256_HEX.test(liveCapability?.capabilityDigest || "")
        || liveCapability.capabilityDigest !== capabilityReceipt.capabilityDigest) {
        capabilityAvailable = false;
        break;
      }
      const result = await launchWorker({
        root: launch.root,
        workerId: launch.workerId,
        principal: launch.principal,
        env
      });
      if (result?.claimed === true) launched += 1;
      else reconcileOnly += 1;
    } catch {
      reconcileOnly += 1;
    }
  }
  return Object.freeze({
    scanned: candidates.length,
    launched,
    reconcileOnly,
    capabilityAvailable
  });
}

/** Start one immediate drain followed by a small, non-overlapping retry set. */
export function startWorkerDispatchSupervisor({
  env = process.env,
  drain = drainAuthorizedPendingDispatches,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  maxRuns = DEFAULT_MAX_RUNS,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1 || retryDelayMs > 60_000
    || !Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 16) {
    throw new CompanionError("E_USAGE", "Worker dispatch supervisor retry bounds are invalid.");
  }
  let stopped = false;
  let running = false;
  let runs = 0;
  let timer = null;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const finishIfDone = () => {
    if (!running && (stopped || runs >= maxRuns)) resolveDone();
  };
  const run = async () => {
    if (stopped || running || runs >= maxRuns) {
      finishIfDone();
      return;
    }
    running = true;
    runs += 1;
    try { await drain({ env }); }
    catch { /* Startup recovery never writes diagnostics to MCP stdout. */ }
    finally {
      running = false;
      if (!stopped && runs < maxRuns) {
        timer = setTimer(() => {
          timer = null;
          void run();
        }, retryDelayMs);
      }
      finishIfDone();
    }
  };
  void run();
  return Object.freeze({
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer != null) {
        clearTimer(timer);
        timer = null;
      }
      finishIfDone();
    },
    done
  });
}
