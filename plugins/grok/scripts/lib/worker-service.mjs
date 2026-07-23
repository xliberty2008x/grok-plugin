import { performance } from "node:perf_hooks";

import { CompanionError } from "./errors.mjs";
import { sameHostSession } from "./host.mjs";
import { listJobsReadonly, tryReadJob } from "./state.mjs";
import {
  isWorkerTerminal,
  projectWorkerHandle,
  projectWorkerLifecycleCursor,
  projectWorkerSnapshot
} from "./worker-protocol.mjs";
import { isCanonicalUuid } from "./worker-authority.mjs";
import {
  cancelWorker,
  providerLaunchState,
  projectCancellationReceipt,
  spawnReadOnlyWorker
} from "./worker-mutation.mjs";
import { launchCommittedWorker } from "./worker-runtime.mjs";
import {
  followupWorker,
  sendWorkerMessage
} from "./worker-mailbox.mjs";
import {
  assertTaskEnvelope,
  buildTaskEnvelope,
  captureContextManifest
} from "./task-contract.mjs";

export const MAX_WORKER_WAIT_MS = 30_000;
const DEFAULT_WORKER_WAIT_MS = 10_000;
const WAIT_POLL_MS = 100;

function notFound() {
  return new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
}

function assertServicePrincipal(principal) {
  if (principal?.hostKind !== "codex" || !isCanonicalUuid(principal.threadId)) {
    throw new CompanionError("E_AUTH_REQUIRED", "Trusted Codex task identity is unavailable.");
  }
}

function assertWaitMs(value) {
  const timeoutMs = value == null ? DEFAULT_WORKER_WAIT_MS : value;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WORKER_WAIT_MS) {
    throw new CompanionError("E_USAGE", `Worker wait must be an integer from 0 to ${MAX_WORKER_WAIT_MS} milliseconds.`);
  }
  return timeoutMs;
}

export function createWorkerService({
  root,
  principal,
  env = process.env,
  readJob = tryReadJob,
  listJobs = listJobsReadonly,
  clock = () => performance.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  allowWriteSpawn = false,
  providerCapabilityDigest = null,
  validateProviderCapability = null,
  allowUnboundDispatch = true,
  launchWorker = launchCommittedWorker,
  dispatchWorker = launchWorker,
  captureContext = captureContextManifest,
  maintain = null,
  maintenanceIntervalMs = 250
}) {
  assertServicePrincipal(principal);
  if (typeof root !== "string" || !root) {
    throw new CompanionError("E_CAPABILITY", "Trusted Codex workspace metadata is unavailable.");
  }
  const host = Object.freeze({ kind: "codex", sessionId: principal.threadId });
  let nextMaintenanceAt = -Infinity;

  const currentCapabilityDigest = () => {
    if (typeof validateProviderCapability !== "function") return providerCapabilityDigest;
    try {
      const observed = validateProviderCapability();
      return typeof observed === "string" ? observed : null;
    } catch {
      return null;
    }
  };

  const canDispatch = (job) => {
    const boundDigest = job?.request?.spawn?.providerCapabilityDigest;
    if (typeof boundDigest === "string") {
      return typeof providerCapabilityDigest === "string"
        && providerCapabilityDigest === boundDigest
        && currentCapabilityDigest() === boundDigest;
    }
    return allowUnboundDispatch === true;
  };

  const maintainIfDue = async () => {
    if (typeof maintain !== "function") return;
    const observedAt = clock();
    if (observedAt < nextMaintenanceAt) return;
    nextMaintenanceAt = observedAt + maintenanceIntervalMs;
    await maintain();
  };

  const ownedJob = (id) => {
    const job = readJob(root, id, env);
    if (!job || !sameHostSession(job, host)) throw notFound();
    // Host-attested parent access is mutation-path only; reads stay exact-thread
    // equivalent so foreign/nonexistent remain observationally identical.
    return job;
  };

  return Object.freeze({
    listOwned() {
      return listJobs(root, env)
        .filter((job) => sameHostSession(job, host))
        .map((job) => projectWorkerHandle(job, { trustHostAuthority: false }));
    },

    get(id) {
      return projectWorkerSnapshot(ownedJob(id), { trustHostAuthority: false });
    },

    eventsAfter(id, cursor = null) {
      const job = ownedJob(id);
      return projectWorkerLifecycleCursor(job, cursor, { trustHostAuthority: false });
    },

    async wait(id, { cursor = null, timeoutMs: requestedTimeoutMs } = {}) {
      const timeoutMs = assertWaitMs(requestedTimeoutMs);
      const deadline = clock() + timeoutMs;
      let latest;
      // worker_wait is a mutation-authorized tool. Resolve exact ownership
      // before touching launch state, then drain only this authority-bound
      // worker's durable outbox. Generic read tools never dispatch work.
      const admitted = ownedJob(id);
      const admittedDispatch = admitted.request?.spawn?.dispatch;
      if ([1, 2].includes(admittedDispatch?.schemaVersion)
        && ["pending", "claimed"].includes(admittedDispatch.state)
        && canDispatch(admitted)) {
        await dispatchWorker({ root, workerId: id, principal, env });
      }
      for (;;) {
        // Demand-driven host maintenance settles only exact lost attempts and
        // never claims, launches, or replays work. Re-authorize every reread.
        await maintainIfDue();
        const job = ownedJob(id);
        const dispatch = job.request?.spawn?.dispatch;
        if ([1, 2].includes(dispatch?.schemaVersion)
          && ["pending", "claimed"].includes(dispatch.state)
          && canDispatch(job)) {
          await dispatchWorker({ root, workerId: id, principal, env });
        }
        latest = projectWorkerLifecycleCursor(job, cursor, { trustHostAuthority: false });
        if (latest.events.length || latest.terminal) return { ...latest, timedOut: false };
        const remaining = deadline - clock();
        if (remaining <= 0) return { ...latest, timedOut: true };
        await sleep(Math.min(WAIT_POLL_MS, remaining));
      }
    },

    result(id) {
      const job = ownedJob(id);
      if (!isWorkerTerminal(job)) {
        throw new CompanionError("E_JOB_ACTIVE", "Worker result is not available yet.");
      }
      return projectWorkerSnapshot(job, { trustHostAuthority: false });
    },

    /**
     * Idempotent read-only spawn. Durable commit is success; provider not started.
     */
    spawn({
      userRequest,
      objective = null,
      envelope = null,
      contextManifest = null,
      idempotencyKey,
      roleId = "explorer",
      write = false
    } = {}) {
      if (!idempotencyKey) {
        throw new CompanionError("E_USAGE", "idempotencyKey is required for spawn.");
      }
      const boundContextManifest = contextManifest || captureContext(root);
      const taskEnvelope = envelope ? assertTaskEnvelope(envelope) : buildTaskEnvelope({
        userRequest: userRequest || objective || "worker task",
        objective,
        mode: write ? "write" : "read",
        contextManifestId: boundContextManifest.manifestId
      });
      if (typeof providerCapabilityDigest === "string"
        && currentCapabilityDigest() !== providerCapabilityDigest) {
        throw new CompanionError(
          "E_CAPABILITY",
          "The installed provider capability changed before worker admission."
        );
      }
      const admitted = spawnReadOnlyWorker({
        root,
        principal,
        envelope: taskEnvelope,
        contextManifest: boundContextManifest,
        idempotencyKey,
        roleId,
        write,
        env,
        allowWriteSpawn,
        providerCapabilityDigest
      });
      // Admission is intentionally durable before provider launch. Revalidate
      // once more at that exact boundary: if readiness changed while the job
      // was being committed, preserve the pending outbox for a later valid
      // worker_wait/supervisor pass and report that no provider was started.
      // Keep admitted.handle as the stable transaction-time snapshot even when
      // dispatch advances the private job synchronously; launch observation is
      // reported only via providerLaunchState / providerLaunched.
      const mayLaunch = typeof providerCapabilityDigest !== "string"
        || currentCapabilityDigest() === providerCapabilityDigest;
      const launch = mayLaunch
        ? dispatchWorker({
          root,
          workerId: admitted.handle.id,
          principal,
          env
        })
        : null;
      const launchState = launch?.providerLaunchState
        || providerLaunchState(readJob(root, admitted.handle.id, env));
      return {
        ...admitted,
        handle: admitted.handle,
        providerLaunchState: launchState,
        providerLaunched: launch?.providerLaunched === true
      };
    },

    cancel({ id, idempotencyKey } = {}) {
      if (!id) throw new CompanionError("E_USAGE", "id is required for cancel.");
      if (!idempotencyKey) {
        throw new CompanionError("E_USAGE", "idempotencyKey is required for cancel.");
      }
      const { receipt, replayed } = cancelWorker({
        root,
        principal,
        workerId: id,
        idempotencyKey,
        env
      });
      return { receipt: projectCancellationReceipt(receipt), replayed };
    },

    send({ id, message, idempotencyKey, deliver = null } = {}) {
      if (!id) throw new CompanionError("E_USAGE", "id is required for send.");
      return sendWorkerMessage({
        root,
        principal,
        workerId: id,
        message,
        idempotencyKey,
        deliver,
        env
      });
    },

    followup({ id, message, idempotencyKey, envelope = null, contextManifest = null } = {}) {
      if (!id) throw new CompanionError("E_USAGE", "id is required for followup.");
      return followupWorker({
        root,
        principal,
        workerId: id,
        message,
        idempotencyKey,
        envelope,
        contextManifest,
        env
      });
    }
  });
}
