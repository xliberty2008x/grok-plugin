/** Issue #56 worker-mutation spawn domain. */
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
import {
  assertContextCompatible,
  assertContextManifestIntegrity,
  captureContextManifest
} from "./task-context-manifest.mjs";
import {
  bindContextMetadataCompleteness
} from "./task-context-metadata.mjs";
import {
  assertTaskEnvelope,
  bindTaskEnvelopeContext,
  buildTaskEnvelope,
  scrubStoredJob
} from "./task-envelope.mjs";
import { composeProviderPrompt } from "./task-provider-prompt.mjs";
import { appendLifecycleEvent } from "./task-lifecycle.mjs";
import {
  CONTEXT_BINDING_MODE,
  assertContextPacket,
  assertContextReceipt,
  buildContextPacket,
  buildContextReceipt,
  resolveJobProviderPrompt,
  verifyJobEffectivePrompt
} from "./worker-context.mjs";
import {
  assertRuntimeRolePolicy,
  buildRuntimeRolePolicy,
  materializeRole,
  assertRoleDigest
} from "./worker-roles.mjs";
import { profileFor, sameSecurityProfile } from "./profiles.mjs";
import { resolveControlWorkspace, workspaceState } from "./workspace.mjs";
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
  assertDispatchContract,
  normalizeProviderLaunchBindingInput
} from "./worker-mutation-dispatch-contract.mjs";
import {
  SPAWN_IDEMPOTENCY_SCHEMA_VERSION,
  assertIdempotencyKey,
  assertSpawnIdempotencyJobBinding,
  captureSpawnResponse,
  idempotencyConflict,
  normalizeSpawnIdempotencyRecord,
  readIdempotency,
  spawnIdempotencyStateError,
  writeIdempotency
} from "./worker-mutation-idempotency.mjs";
import {
  SHA256_HEX,
  SPAWN_OWNERSHIP_MODE,
  SPAWN_SUCCESS_DEFINITION,
  assertMutationOwnership,
  digestKey,
  ownershipHost,
  spawnRequestOwner,
  stableDigest
} from "./worker-mutation-primitives.mjs";
import {
  requestDigest
} from "./worker-mutation-request-contract.mjs";
import {
  assertDurableSpawnRequestBinding,
  storedSpawnReplayRequestDigest
} from "./worker-mutation-spawn-authority.mjs";
import {
  admitWriteWorkerPlan
} from "./worker-mutation-write-admission.mjs";


const {
  assertContextMetadataComplete,
  captureCompleteContextManifest
} = bindContextMetadataCompleteness({
  captureContextManifest,
  assertContextManifestIntegrity
});

function resolveAdmissionContext(root, manifest, metadataPolicy = null) {
  const options = {
    mode: "execute",
    contextPhase: "admission",
    ...(metadataPolicy ? { metadataPolicy } : {})
  };
  const accepted = manifest
    ? assertContextCompatible(root, manifest, options)
    : captureCompleteContextManifest(root, { contextPhase: "admission" });
  return assertContextMetadataComplete(accepted, { contextPhase: "admission" });
}

export function prepareReadOnlyWorkerAdmission({ root, principal, envelope, contextManifest, idempotencyKey, roleId, write, env, allowWriteSpawn, writeLifecycleCapabilityDigest, providerCapabilityDigest, providerLaunchBinding, providerLaunchBindingDigest, providerLaunch }) {
  assertIdempotencyKey(idempotencyKey);
  if (!principal?.threadId) {
    throw new CompanionError("E_AUTH_REQUIRED", "Trusted Codex task identity is unavailable.");
  }
  if (write && !allowWriteSpawn) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Broker write spawn is disabled until Phase 3 control-workspace identity and worktrees are enabled."
    );
  }
  if (!envelope || typeof envelope !== "object") {
    throw new CompanionError("E_USAGE", "TaskEnvelope is required for spawn.");
  }
  if (providerLaunch !== undefined && providerLaunch !== null) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Provider launch adapters must use the attempt-bound WorkerService dispatcher."
    );
  }
  if (providerCapabilityDigest !== null && !SHA256_HEX.test(providerCapabilityDigest)) {
    throw new CompanionError("E_CAPABILITY", "Provider capability binding is missing or malformed.");
  }
  const admittedProviderBinding = normalizeProviderLaunchBindingInput(
    providerLaunchBinding,
    providerLaunchBindingDigest
  );
  const validatedEnvelope = assertTaskEnvelope(envelope);
  if (validatedEnvelope.mode === "write" && !allowWriteSpawn) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Broker write spawn is disabled until Phase 3 control-workspace identity and worktrees are enabled."
    );
  }
  if (write) {
    return { writeAdmission: admitWriteWorkerPlan({
      root,
      principal,
      envelope: validatedEnvelope,
      contextManifest,
      idempotencyKey,
      roleId,
      env,
      allowWriteSpawn,
      writeLifecycleCapabilityDigest,
      providerLaunchBinding: admittedProviderBinding,
      providerLaunchBindingDigest: admittedProviderBinding
        ? providerLaunchBindingDigest
        : null
    }) };
  }

  const role = materializeRole(roleId);
  if (!write && role.id !== "explorer") {
    throw new CompanionError(
      "E_ROLE",
      "Read-only broker admission supports only the immutable explorer runtime role."
    );
  }
  if (Boolean(role.write) !== Boolean(write)) {
    throw new CompanionError(
      "E_ROLE",
      write
        ? `Role ${roleId} cannot perform write work.`
        : `Write-capable role ${roleId} cannot be attached to a read-only worker.`
    );
  }
  if ((validatedEnvelope.mode === "write") !== Boolean(write)) {
    throw new CompanionError("E_ROLE", "TaskEnvelope mode must match the worker write capability.");
  }
  assertRoleDigest(role);
  const controlWorkspace = resolveControlWorkspace(root, env);
  const { controlWorkspaceId, executionRoot } = controlWorkspace;
  const acceptedContextManifest = resolveAdmissionContext(executionRoot, contextManifest);
  if (validatedEnvelope.contextManifestId != null
    && validatedEnvelope.contextManifestId !== acceptedContextManifest.manifestId) {
    throw new CompanionError(
      "E_CONTEXT_DRIFT",
      "TaskEnvelope context identity does not match the trusted execution workspace."
    );
  }
  const boundEnvelope = bindTaskEnvelopeContext(
    validatedEnvelope,
    acceptedContextManifest.manifestId
  );
  const profile = profileFor("task", Boolean(write));
  const contextPacket = buildContextPacket({
    mode: "explicit-envelope",
    envelope: boundEnvelope,
    facts: boundEnvelope.context.facts,
    constraints: boundEnvelope.context.constraints
  });
  assertContextPacket(contextPacket, { envelope: boundEnvelope });
  const runtimeRolePolicy = buildRuntimeRolePolicy({ role, profile });
  assertRuntimeRolePolicy(runtimeRolePolicy, { role, profile });
  const providerPrompt = composeProviderPrompt(boundEnvelope, {
    root: executionRoot,
    contextManifest: acceptedContextManifest,
    contextPacket,
    runtimeRolePolicy
  });
  const providerPromptDigest = crypto
    .createHash("sha256")
    .update(providerPrompt)
    .digest("hex");
  const contextBindingDigest = stableDigest({
    mode: CONTEXT_BINDING_MODE,
    packetDigest: contextPacket.digest,
    runtimeRolePolicyDigest: runtimeRolePolicy.digest,
    providerPromptDigest
  });

  const keyDigest = digestKey(idempotencyKey);
  const requestOwner = spawnRequestOwner(principal);
  const spawnDigest = requestDigest({
    principal,
    controlWorkspaceId,
    executionRoot,
    envelope: boundEnvelope,
    contextManifest: acceptedContextManifest,
    roleId,
    write,
    contextBinding: {
      mode: CONTEXT_BINDING_MODE,
      digest: contextBindingDigest
    },
    ...(admittedProviderBinding
      ? { providerLaunchBindingDigest }
      : {})
  });
  return {
    validatedEnvelope,
    role,
    controlWorkspaceId,
    executionRoot,
    acceptedContextManifest,
    boundEnvelope,
    profile,
    contextPacket,
    runtimeRolePolicy,
    providerPromptDigest,
    contextBindingDigest,
    keyDigest,
    requestOwner,
    spawnDigest,
    admittedProviderBinding
  };
}

function assertOwnedSpawnParent(root, principal, publicSpawn, env) {
  if (!publicSpawn?.parentId) return;
  const parent = tryReadJob(root, publicSpawn.parentId, env);
  if (!parent) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
  assertMutationOwnership(parent, principal);
}

function publicSpawnRequestFields(publicSpawn) {
  return {
    displayName: publicSpawn?.name || null,
    resumeJobId: publicSpawn?.parentId || null,
    contextInheritance: publicSpawn?.contextMode
      ? {
        mode: publicSpawn.contextMode,
        digest: publicSpawn.contextDigest,
        inheritTurns: publicSpawn.inheritTurns
      }
      : null
  };
}

export function spawnReadOnlyWorker({ root, principal, envelope, contextManifest = null, idempotencyKey, roleId = "explorer", write = false, env = process.env, allowWriteSpawn = false, writeLifecycleCapabilityDigest = null, providerCapabilityDigest = null, providerLaunchBinding = null, providerLaunchBindingDigest = null, providerLaunch = undefined, publicSpawn = null } = {}) {
  const prepared = prepareReadOnlyWorkerAdmission({ root, principal, envelope, contextManifest, idempotencyKey, roleId, write, env, allowWriteSpawn, writeLifecycleCapabilityDigest, providerCapabilityDigest, providerLaunchBinding, providerLaunchBindingDigest, providerLaunch });
  if (prepared.writeAdmission) return prepared.writeAdmission;
  assertOwnedSpawnParent(root, principal, publicSpawn, env);
  const { validatedEnvelope, role, controlWorkspaceId, executionRoot, acceptedContextManifest, boundEnvelope, profile, contextPacket, runtimeRolePolicy, providerPromptDigest, contextBindingDigest, keyDigest, requestOwner, spawnDigest, admittedProviderBinding } = prepared;
  const admitted = withWorkspaceStateTransaction(root, (transaction) => {
    const digestOwners = transaction.listJobs().filter((candidate) => (
      candidate.request?.spawn?.idempotencyKeyDigest === keyDigest
    ));
    const existing = readIdempotency(root, "spawn", idempotencyKey, env);
    if (existing) {
      const record = normalizeSpawnIdempotencyRecord(existing, { keyDigest });
      if (record.owner.hostKind !== requestOwner.hostKind
        || record.owner.sessionId !== requestOwner.sessionId
        || record.controlWorkspaceId !== controlWorkspaceId
        || record.executionRoot !== executionRoot) {
        idempotencyConflict("idempotencyKey was reused with a different spawn owner or request.");
      }
      const committed = transaction.tryReadJob(record.workerId);
      if (!committed) {
        throw new CompanionError("E_STATE", "Spawn idempotency record refers to a missing durable job.");
      }
      if (digestOwners.length !== 1 || digestOwners[0].id !== record.workerId) {
        spawnIdempotencyStateError("Spawn idempotency digest ownership is ambiguous.");
      }
      assertSpawnIdempotencyJobBinding(record, committed, { keyDigest });
      assertDispatchContract(committed);
      assertDurableSpawnRequestBinding(committed, env, {
        contextPhase: "admission"
      });
      assertMutationOwnership(committed, principal);
      const replayRequestDigest = storedSpawnReplayRequestDigest({
        job: committed,
        principal,
        envelope: validatedEnvelope,
        roleId,
        write,
        ...(admittedProviderBinding
          ? { providerLaunchBindingDigest }
          : {})
      });
      if (record.requestDigest !== replayRequestDigest) {
        idempotencyConflict("idempotencyKey was reused with a different spawn owner or request.");
      }
      if (providerCapabilityDigest !== null
        && committed.request?.spawn?.providerCapabilityDigest !== providerCapabilityDigest) {
        throw new CompanionError("E_CONTEXT_DRIFT", "Provider capability changed since durable worker admission.");
      }
      if (admittedProviderBinding
        && committed.request?.spawn?.providerLaunchBindingDigest
          !== providerLaunchBindingDigest) {
        throw new CompanionError(
          "E_CONTEXT_DRIFT",
          "Provider executable pin changed since durable worker admission."
        );
      }
      if (record.schemaVersion === SPAWN_IDEMPOTENCY_SCHEMA_VERSION
        && record.responseWitness.responseSequence === Number.MAX_SAFE_INTEGER) {
        spawnIdempotencyStateError("Spawn response sequence cannot be incremented safely.");
      }
      const responseSequence = record.schemaVersion === SPAWN_IDEMPOTENCY_SCHEMA_VERSION
        ? record.responseWitness.responseSequence + 1
        : 1;
      const recordedAt = now();
      if (record.schemaVersion === SPAWN_IDEMPOTENCY_SCHEMA_VERSION
        && Date.parse(recordedAt) < Date.parse(record.responseWitness.recordedAt)) {
        spawnIdempotencyStateError("Spawn response witness time moved backwards.");
      }
      const captured = captureSpawnResponse({
        job: committed,
        keyDigest,
        replayed: true,
        responseSequence,
        recordedAt
      });
      writeIdempotency(root, "spawn", idempotencyKey, captured.record, env);
      return { committed, handle: captured.handle, replayed: true };
    }

    // Recover a commit whose adjacent idempotency publication was interrupted.
    if (digestOwners.length > 1) {
      spawnIdempotencyStateError("Spawn idempotency digest ownership is ambiguous.");
    }
    const orphan = digestOwners[0] || null;
    if (orphan) {
      if (
        orphan.host?.kind !== requestOwner.hostKind
        || orphan.host?.sessionId !== requestOwner.sessionId
        || orphan.controlWorkspaceId !== controlWorkspaceId
        || orphan.request?.spawn?.executionRoot !== executionRoot
        || orphan.request?.spawn?.ownerThreadId !== principal.threadId
      ) {
        idempotencyConflict("idempotencyKey was reused with a different spawn owner or request.");
      }
      assertDispatchContract(orphan);
      assertDurableSpawnRequestBinding(orphan, env, {
        contextPhase: "admission"
      });
      assertMutationOwnership(orphan, principal);
      const replayRequestDigest = storedSpawnReplayRequestDigest({
        job: orphan,
        principal,
        envelope: validatedEnvelope,
        roleId,
        write,
        ...(admittedProviderBinding
          ? { providerLaunchBindingDigest }
          : {})
      });
      if (orphan.request?.spawn?.requestDigest !== replayRequestDigest) {
        idempotencyConflict("idempotencyKey was reused with a different spawn owner or request.");
      }
      if (providerCapabilityDigest !== null
        && orphan.request?.spawn?.providerCapabilityDigest !== providerCapabilityDigest) {
        throw new CompanionError("E_CONTEXT_DRIFT", "Provider capability changed since durable worker admission.");
      }
      if (admittedProviderBinding
        && orphan.request?.spawn?.providerLaunchBindingDigest
          !== providerLaunchBindingDigest) {
        throw new CompanionError(
          "E_CONTEXT_DRIFT",
          "Provider executable pin changed since durable worker admission."
        );
      }
      const captured = captureSpawnResponse({
        job: orphan,
        keyDigest,
        replayed: true,
        responseSequence: 1
      });
      writeIdempotency(root, "spawn", idempotencyKey, captured.record, env);
      return { committed: orphan, handle: captured.handle, replayed: true };
    }

    const id = generateId("task");
    const createdAt = now();
    const contextReceipt = buildContextReceipt({
      contextPacket,
      rolePolicy: runtimeRolePolicy,
      contextManifest: acceptedContextManifest,
      lineageWorkerId: id,
      effectivePromptDigest: providerPromptDigest
    });
    const job = {
      schemaVersion: 3,
      id,
      kind: "task",
      jobClass: "task",
      write: Boolean(write),
      status: "queued",
      phase: "accepted",
      summary: "Spawn committed",
      progress: "Durable job record committed; provider not started by broker spawn.",
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      completedAt: null,
      heartbeatAt: createdAt,
      host: ownershipHost(principal),
      profile,
      role: {
        ...role,
        tools: [...role.tools]
      },
      model: null,
      effort: null,
      controlWorkspaceId,
      request: {
        contextBindingMode: CONTEXT_BINDING_MODE,
        contextPacket,
        runtimeRolePolicy,
        contextReceipt,
        envelope: boundEnvelope,
        contextManifest: acceptedContextManifest,
        providerPromptDigest,
        providerHomeId: id,
        publicObjective: boundEnvelope.objective !== boundEnvelope.userRequest
          ? boundEnvelope.objective
          : null,
        roleId: role.id,
        ...publicSpawnRequestFields(publicSpawn),
        spawn: {
          executionRoot,
          idempotencyKeyDigest: keyDigest,
          ownerThreadId: principal.threadId,
          requestDigest: spawnDigest,
          contextBindingDigest,
          successDefinition: SPAWN_SUCCESS_DEFINITION,
          ownershipMode: SPAWN_OWNERSHIP_MODE,
          ...(providerCapabilityDigest !== null ? { providerCapabilityDigest } : {}),
          ...(admittedProviderBinding
            ? {
                providerLaunchBinding: admittedProviderBinding,
                providerLaunchBindingDigest
              }
            : {}),
          providerLaunchPending: true,
          providerLaunchInFlight: false,
          providerLaunchOutcome: "pending",
          dispatch: createDispatchOutbox({ createdAt })
        }
      },
      lifecycleEvents: appendLifecycleEvent(
        [],
        "task.accepted",
        "Durable spawn commit accepted by worker broker.",
        {
          spawnSuccessDefinition: SPAWN_SUCCESS_DEFINITION,
          write: Boolean(write)
        }
      ),
      result: null,
      error: null,
      workerAuthorization: null
    };

    job.workerAuthorization = createWorkerAuthorization({
      job,
      principal: { ...principal, hostKind: principal.hostKind || "codex" },
      issuedAt: createdAt
    });

    const committed = transaction.admitJob(job);
    const captured = captureSpawnResponse({
      job: committed,
      keyDigest,
      replayed: false,
      responseSequence: 1
    });
    writeIdempotency(root, "spawn", idempotencyKey, captured.record, env);
    return { committed, handle: captured.handle, replayed: false };
  }, env);

  // Return the exact handle captured and witnessed inside the transaction. A
  // later reread would observe moving active state (dispatch claim, provider
  // launch) and replace this durable response boundary with a TOCTOU race.
  return {
    handle: admitted.handle,
    replayed: admitted.replayed,
    spawnSuccessDefinition: SPAWN_SUCCESS_DEFINITION,
    providerLaunched: false
  };
}
