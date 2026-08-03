import { performance } from "node:perf_hooks";

import { CompanionError } from "./errors.mjs";
import { sameHostSession } from "./host.mjs";
import {
  assertProviderLaunchBinding,
  providerLaunchBindingDigest as digestProviderLaunchBinding
} from "./provider-executable-pin.mjs";
import { listJobsReadonly, tryReadJob } from "./state.mjs";
import {
  isWorkerTerminal,
  projectWriteArtifactMetadata,
  projectWorkerHandle,
  projectWorkerLifecycleCursor,
  projectWorkerSnapshot
} from "./worker-protocol.mjs";
import {
  assertBrokerMutationAuthority,
  isCanonicalUuid
} from "./worker-authority.mjs";
import {
  cancelWorker,
  authorizeReadyWriteWorkerDispatch,
  projectCancellationReceipt,
  spawnReadOnlyWorker
} from "./worker-mutation.mjs";
import { providerLaunchState } from "./worker-mutation-dispatch-contract.mjs";
import { launchCommittedWorker } from "./worker-runtime.mjs";
import { provisionWriteWorkerWorktree } from "./worker-provisioner.mjs";
import {
  followupWorker,
  sendWorkerMessage
} from "./worker-mailbox.mjs";
import {
  decideHostActionRoleAdmission,
  readHostActionRequestBinding
} from "./worker-host-actions.mjs";
import {
  assertTaskEnvelope,
  buildTaskEnvelope
} from "./task-envelope.mjs";
import { captureContextManifest } from "./task-context-manifest.mjs";
import {
  EXACT_WRITE_VERTICAL_SCOPE,
  assertExactWriteVerticalScope,
  assertTrackedWriteVerticalTarget,
  readWriteWorkerArtifact
} from "./worker-worktree.mjs";
import {
  abandonWriteWorker as abandonOwnedWriteWorker,
  cleanupWriteWorker as cleanupOwnedWriteWorker,
  integrateWriteWorker as integrateOwnedWriteWorker,
  previewWriteWorker as previewOwnedWriteWorker,
  verifyWriteWorkerIntegration as verifyOwnedWriteWorkerIntegration
} from "./worker-owner-lifecycle.mjs";
import {
  runCloseEffect as runOfficialCloseEffect,
  runIntegrationEffect as runOfficialIntegrationEffect,
  runRemoveEffect as runOfficialRemoveEffect
} from "./worker-owner-controller.mjs";
import {
  deleteOwnedProviderSession,
  inspectOwnedProviderSession
} from "./worker-session-lifecycle.mjs";

export const MAX_WORKER_WAIT_MS = 30_000;
const DEFAULT_WORKER_WAIT_MS = 10_000;
const WAIT_POLL_MS = 100;
const MAX_WRITE_ARTIFACT_PAYLOAD_BYTES = 512 * 1024;

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
  enableWriteVerticalDispatch = false,
  writeLifecycleCapabilityDigest = null,
  validateWriteLifecycleCapability = null,
  providerCapabilityDigest = null,
  providerLaunchBinding = null,
  providerLaunchBindingDigest = null,
  validateProviderCapability = null,
  allowUnboundDispatch = true,
  launchWorker = launchCommittedWorker,
  dispatchWorker = launchWorker,
  provisionWriteWorktree = provisionWriteWorkerWorktree,
  authorizeWriteDispatch = authorizeReadyWriteWorkerDispatch,
  previewWriteArtifact = previewOwnedWriteWorker,
  integrateWriteArtifact = integrateOwnedWriteWorker,
  verifyWriteIntegration = verifyOwnedWriteWorkerIntegration,
  abandonWriteArtifact = abandonOwnedWriteWorker,
  cleanupWriteWorker = cleanupOwnedWriteWorker,
  runIntegrationEffect = runOfficialIntegrationEffect,
  runCloseEffect = runOfficialCloseEffect,
  deleteProviderSession = null,
  inspectProviderSession = null,
  runRemoveEffect = runOfficialRemoveEffect,
  captureContext = captureContextManifest,
  maintain = null,
  maintenanceIntervalMs = 250
}) {
  assertServicePrincipal(principal);
  if (typeof root !== "string" || !root) {
    throw new CompanionError("E_CAPABILITY", "Trusted Codex workspace metadata is unavailable.");
  }
  if (typeof providerCapabilityDigest === "string") {
    assertProviderLaunchBinding(providerLaunchBinding);
    if (providerLaunchBindingDigest
      !== digestProviderLaunchBinding(providerLaunchBinding)) {
      throw new CompanionError(
        "E_CAPABILITY",
        "The provider executable launch binding is missing or inconsistent."
      );
    }
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

  const currentWriteLifecycleCapabilityDigest = () => {
    if (typeof validateWriteLifecycleCapability !== "function") {
      return writeLifecycleCapabilityDigest;
    }
    try {
      const observed = validateWriteLifecycleCapability();
      return typeof observed === "string" ? observed : null;
    } catch {
      return null;
    }
  };

  const canDispatch = (job) => {
    const boundDigest = job?.request?.spawn?.providerCapabilityDigest;
    if (typeof boundDigest === "string") {
      try {
        if (job?.request?.spawn?.providerLaunchBindingDigest
            !== providerLaunchBindingDigest
          || digestProviderLaunchBinding(
            job?.request?.spawn?.providerLaunchBinding
          ) !== providerLaunchBindingDigest) {
          return false;
        }
      } catch {
        return false;
      }
    }
    if (typeof boundDigest === "string") {
      if (job?.write === true) {
        return enableWriteVerticalDispatch === true
          && typeof writeLifecycleCapabilityDigest === "string"
          && writeLifecycleCapabilityDigest === boundDigest
          && currentWriteLifecycleCapabilityDigest() === boundDigest;
      }
      return typeof providerCapabilityDigest === "string"
        && providerCapabilityDigest === boundDigest
        && currentCapabilityDigest() === boundDigest;
    }
    return allowUnboundDispatch === true;
  };

  const driveWriteVertical = async (job) => {
    if (enableWriteVerticalDispatch !== true || job?.write !== true) return job;
    if (currentWriteLifecycleCapabilityDigest()
      !== writeLifecycleCapabilityDigest) {
      throw new CompanionError(
        "E_CAPABILITY",
        "The write-lifecycle capability changed before provisioning or dispatch."
      );
    }
    let current = job;
    if (!current.request?.spawn?.dispatch
      && current.status === "queued"
      && current.provisioning?.state !== "ready") {
      await provisionWriteWorktree({
        root,
        principal,
        workerId: current.id,
        env
      });
      current = ownedJob(current.id);
    }
    if (!current.request?.spawn?.dispatch
      && current.status === "queued"
      && current.provisioning?.state === "ready") {
      authorizeWriteDispatch({
        root,
        principal,
        workerId: current.id,
        writeLifecycleCapabilityDigest,
        validateWriteLifecycleCapability:
          currentWriteLifecycleCapabilityDigest,
        env
      });
      current = ownedJob(current.id);
    }
    return current;
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
      const admitted = await driveWriteVertical(ownedJob(id));
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
        const job = await driveWriteVertical(ownedJob(id));
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

    artifactMetadata(id) {
      const job = ownedJob(id);
      if (job.write !== true) return null;
      return projectWriteArtifactMetadata(job.result?.writeArtifact);
    },

    artifact(id, { part = "metadata" } = {}) {
      const job = ownedJob(id);
      if (job.write !== true || !isWorkerTerminal(job) || job.status !== "completed") {
        throw new CompanionError("E_JOB_ACTIVE", "Write-worker artifact is not available yet.");
      }
      const metadata = projectWriteArtifactMetadata(job.result?.writeArtifact);
      if (!metadata) {
        throw new CompanionError("E_STATE", "Completed write worker has no durable artifact metadata.");
      }
      if (part === "metadata") return metadata;
      const artifact = readWriteWorkerArtifact({
        controlRoot: root,
        workerId: id,
        env,
        expectedManifestDigest: metadata.manifestDigest
      });
      const payload = part === "patch"
        ? artifact.patch
        : part === "content"
          ? artifact.content
          : null;
      if (payload === null) {
        throw new CompanionError("E_USAGE", "Unsupported write-worker artifact part.");
      }
      const payloadBytes = Buffer.byteLength(payload, "utf8");
      if (payloadBytes > MAX_WRITE_ARTIFACT_PAYLOAD_BYTES) {
        throw new CompanionError(
          "E_OUTPUT_LIMIT",
          "Write-worker artifact payload exceeds the bounded retrieval limit.",
          { limitBytes: MAX_WRITE_ARTIFACT_PAYLOAD_BYTES }
        );
      }
      return Object.freeze({
        ...metadata,
        part,
        payload,
        payloadBytes,
        payloadDigest: part === "patch"
          ? metadata.patchDigest
          : metadata.contentDigest
      });
    },

    async preview({ id, manifestDigest } = {}) {
      if (!id || !manifestDigest) {
        throw new CompanionError(
          "E_USAGE",
          "id and manifestDigest are required for preview."
        );
      }
      assertBrokerMutationAuthority(principal, { root });
      const job = ownedJob(id);
      if (job.write !== true || !isWorkerTerminal(job) || job.status !== "completed") {
        throw new CompanionError(
          "E_JOB_ACTIVE",
          "Write worker is not ready for preview."
        );
      }
      if (currentWriteLifecycleCapabilityDigest()
        !== writeLifecycleCapabilityDigest) {
        throw new CompanionError(
          "E_CAPABILITY",
          "The write-lifecycle capability changed before preview."
        );
      }
      if (typeof previewWriteArtifact !== "function") {
        throw new CompanionError(
          "E_CAPABILITY",
          "The production integration preview is unavailable."
        );
      }
      return previewWriteArtifact({
        root,
        principal,
        workerId: id,
        manifestDigest,
        env
      });
    },

    async integrate({ id, manifestDigest, idempotencyKey } = {}) {
      if (!id || !manifestDigest || !idempotencyKey) {
        throw new CompanionError(
          "E_USAGE",
          "id, manifestDigest, and idempotencyKey are required for integration."
        );
      }
      assertBrokerMutationAuthority(principal, { root });
      const job = ownedJob(id);
      if (job.write !== true || !isWorkerTerminal(job) || job.status !== "completed") {
        throw new CompanionError(
          "E_JOB_ACTIVE",
          "Write worker is not ready for integration."
        );
      }
      if (currentWriteLifecycleCapabilityDigest()
        !== writeLifecycleCapabilityDigest) {
        throw new CompanionError(
          "E_CAPABILITY",
          "The write-lifecycle capability changed before integration."
        );
      }
      if (typeof integrateWriteArtifact !== "function"
        || typeof runIntegrationEffect !== "function") {
        throw new CompanionError(
          "E_CAPABILITY",
          "The production integration controller is unavailable."
        );
      }
      return integrateWriteArtifact({
        root,
        principal,
        workerId: id,
        manifestDigest,
        idempotencyKey,
        env,
        runIntegrationEffect
      });
    },

    async verifyIntegration({
      id,
      manifestDigest,
      integrationReceiptDigest
    } = {}) {
      if (!id || !manifestDigest
        || !/^[a-f0-9]{64}$/.test(integrationReceiptDigest || "")) {
        throw new CompanionError(
          "E_USAGE",
          "id, manifestDigest, and integrationReceiptDigest are required for verification."
        );
      }
      assertBrokerMutationAuthority(principal, { root });
      const job = ownedJob(id);
      if (job.write !== true || !isWorkerTerminal(job) || job.status !== "completed") {
        throw new CompanionError(
          "E_JOB_ACTIVE",
          "Write worker is not ready for integration verification."
        );
      }
      if (currentWriteLifecycleCapabilityDigest()
        !== writeLifecycleCapabilityDigest) {
        throw new CompanionError(
          "E_CAPABILITY",
          "The write-lifecycle capability changed before integration verification."
        );
      }
      if (typeof verifyWriteIntegration !== "function") {
        throw new CompanionError(
          "E_CAPABILITY",
          "The production integration verifier is unavailable."
        );
      }
      return verifyWriteIntegration({
        root,
        principal,
        workerId: id,
        manifestDigest,
        integrationReceiptDigest,
        env
      });
    },

    async abandon({
      id,
      manifestDigest,
      integrationReceiptDigest,
      idempotencyKey
    } = {}) {
      if (!id || !manifestDigest || !idempotencyKey) {
        throw new CompanionError(
          "E_USAGE",
          "id, manifestDigest, and idempotencyKey are required for abandon."
        );
      }
      if (integrationReceiptDigest !== undefined
        && integrationReceiptDigest !== null) {
        throw new CompanionError(
          "E_USAGE",
          "Write abandon forbids integrationReceiptDigest."
        );
      }
      assertBrokerMutationAuthority(principal, { root });
      const job = ownedJob(id);
      if (job.write !== true || !isWorkerTerminal(job) || job.status !== "completed") {
        throw new CompanionError(
          "E_JOB_ACTIVE",
          "Write worker is not ready for abandon."
        );
      }
      if (typeof abandonWriteArtifact !== "function"
        || typeof runCloseEffect !== "function"
        || typeof runRemoveEffect !== "function") {
        throw new CompanionError(
          "E_CAPABILITY",
          "The production abandon controller is unavailable."
        );
      }
      return abandonWriteArtifact({
        root,
        principal,
        workerId: id,
        manifestDigest,
        idempotencyKey,
        env,
        runCloseEffect,
        deleteProviderSession: deleteProviderSession || (({
          providerSessionId
        }) => deleteOwnedProviderSession({
          root,
          principal,
          workerId: id,
          providerSessionId,
          env
        })),
        inspectProviderSession: inspectProviderSession || (({
          providerSessionId
        }) => inspectOwnedProviderSession({
          root,
          principal,
          workerId: id,
          providerSessionId,
          env
        })),
        runRemoveEffect
      });
    },

    async cleanup({ id, integrationReceiptDigest, idempotencyKey } = {}) {
      if (!id || !idempotencyKey) {
        throw new CompanionError(
          "E_USAGE",
          "id and idempotencyKey are required for cleanup."
        );
      }
      assertBrokerMutationAuthority(principal, { root });
      const job = ownedJob(id);
      if (job.write !== true
        || !isWorkerTerminal(job)
        || !["completed", "cancelled"].includes(job.status)) {
        throw new CompanionError(
          "E_JOB_ACTIVE",
          "Write worker is not ready for cleanup."
        );
      }
      if (job.status === "completed"
        && !/^[a-f0-9]{64}$/.test(integrationReceiptDigest || "")) {
        throw new CompanionError(
          "E_USAGE",
          "Completed write cleanup requires integrationReceiptDigest."
        );
      }
      if (job.status === "cancelled"
        && integrationReceiptDigest !== undefined
        && integrationReceiptDigest !== null) {
        throw new CompanionError(
          "E_USAGE",
          "Cancelled write cleanup forbids integrationReceiptDigest."
        );
      }
      if (typeof cleanupWriteWorker !== "function"
        || typeof runCloseEffect !== "function"
        || typeof runRemoveEffect !== "function") {
        throw new CompanionError(
          "E_CAPABILITY",
          "The production cleanup controller is unavailable."
        );
      }
      return cleanupWriteWorker({
        root,
        principal,
        workerId: id,
        integrationReceiptDigest,
        idempotencyKey,
        env,
        runCloseEffect,
        deleteProviderSession: deleteProviderSession || (({
          providerSessionId
        }) => deleteOwnedProviderSession({
          root,
          principal,
          workerId: id,
          providerSessionId,
          env
        })),
        inspectProviderSession: inspectProviderSession || (({
          providerSessionId
        }) => inspectOwnedProviderSession({
          root,
          principal,
          workerId: id,
          providerSessionId,
          env
        })),
        runRemoveEffect
      });
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
      if (!write
        && typeof providerCapabilityDigest === "string"
        && currentCapabilityDigest() !== providerCapabilityDigest) {
        throw new CompanionError(
          "E_CAPABILITY",
          "The installed provider capability changed before worker admission."
        );
      }
      if (write && currentWriteLifecycleCapabilityDigest()
        !== writeLifecycleCapabilityDigest) {
        throw new CompanionError(
          "E_CAPABILITY",
          "The internal write-lifecycle capability changed before worker admission."
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
        writeLifecycleCapabilityDigest,
        providerCapabilityDigest,
        providerLaunchBinding,
        providerLaunchBindingDigest
      });
      if (write) {
        return {
          ...admitted,
          handle: admitted.handle,
          // Preserve the durable admission/replay state reported by the
          // mutation boundary. A terminal replay still performs no launch,
          // but its verified-ready provisioning chain must not be masked as
          // an unprovisioned admission.
          providerLaunchState: admitted.providerLaunchState,
          providerLaunched: false
        };
      }
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

    spawnWriteVertical({
      userRequest,
      objective = null,
      idempotencyKey
    } = {}) {
      if (enableWriteVerticalDispatch !== true || !allowWriteSpawn) {
        throw new CompanionError("E_CAPABILITY", "Write-smoke worker admission is disabled.");
      }
      assertExactWriteVerticalScope(EXACT_WRITE_VERTICAL_SCOPE);
      assertTrackedWriteVerticalTarget(root);
      return this.spawn({
        userRequest,
        objective,
        envelope: buildTaskEnvelope({
          userRequest: userRequest || objective || "Edit target.txt",
          objective,
          mode: "write",
          scope: EXACT_WRITE_VERTICAL_SCOPE
        }),
        idempotencyKey,
        roleId: "implementer",
        write: true
      });
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

    send({ id, message, idempotencyKey } = {}) {
      if (!id) throw new CompanionError("E_USAGE", "id is required for send.");
      if (typeof providerCapabilityDigest === "string"
        && currentCapabilityDigest() !== providerCapabilityDigest) {
        throw new CompanionError(
          "E_CAPABILITY",
          "The installed provider capability changed before mailbox admission."
        );
      }
      return sendWorkerMessage({
        root,
        principal,
        workerId: id,
        message,
        idempotencyKey,
        env
      });
    },

    decideRoleAdmission({ id, requestId, decision, idempotencyKey } = {}) {
      if (!id) throw new CompanionError("E_USAGE", "id is required for role admission.");
      assertBrokerMutationAuthority(principal, { root });
      const job = ownedJob(id);
      if (typeof providerCapabilityDigest === "string"
        && currentCapabilityDigest() !== providerCapabilityDigest) {
        throw new CompanionError(
          "E_CAPABILITY",
          "The installed provider capability changed before role-admission decision."
        );
      }
      const binding = readHostActionRequestBinding(job);
      if (!binding || binding.requestId !== requestId) throw notFound();
      return decideHostActionRoleAdmission({
        root,
        principal,
        workerId: id,
        requestId,
        // Never accept the private request digest from tool/caller input.
        requestDigest: binding.requestDigest,
        decision,
        idempotencyKey,
        env
      });
    },

    followup({ id, grantId, message, idempotencyKey } = {}) {
      if (!id) throw new CompanionError("E_USAGE", "id is required for followup.");
      // Preserve foreign/nonexistent equivalence before observing provider
      // readiness or any parent/grant state.
      assertBrokerMutationAuthority(principal, { root });
      ownedJob(id);
      if (typeof providerCapabilityDigest === "string"
        && currentCapabilityDigest() !== providerCapabilityDigest) {
        throw new CompanionError(
          "E_CAPABILITY",
          "The installed provider capability changed before follow-up admission."
        );
      }
      const admitted = followupWorker({
        root,
        principal,
        workerId: id,
        grantId,
        message,
        idempotencyKey,
        env,
        providerCapabilityDigest,
        providerLaunchBinding,
        providerLaunchBindingDigest
      });
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
    }
  });
}
