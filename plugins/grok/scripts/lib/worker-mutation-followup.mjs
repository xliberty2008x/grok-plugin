/** Issue #56 worker-mutation followup domain. */
import crypto from "node:crypto";
import { CompanionError, asErrorPayload } from "./errors.mjs";
import {
  assertProviderLaunchBinding,
  providerLaunchBindingDigest as digestProviderLaunchBinding
} from "./provider-executable-pin.mjs";
import { processGroupGone } from "./process-control.mjs";
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
import { projectWorkerHandle, projectWorkerSnapshot } from "./worker-protocol.mjs";
import {
  assertRuntimeRolePolicy,
  buildRuntimeRolePolicy,
  materializeRole,
  assertRoleDigest
} from "./worker-roles.mjs";
import { assertBrokerMutationAuthority } from "./worker-authority.mjs";
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
  assertFollowupAdmissionBinding,
  buildFollowupAdmissionWitness,
  followupIdempotencyRecord,
  followupRequestBody,
  followupStateError,
  interruptedFollowupParent,
  normalizeFollowupIdempotencyRecord,
  resolveParentAdmission
} from "./worker-mutation-followup-contract.mjs";
import {
  assertIdempotencyKey,
  idempotencyConflict,
  readIdempotency,
  writeIdempotency
} from "./worker-mutation-idempotency.mjs";
import {
  FOLLOWUP_SPAWN_OWNERSHIP_MODE,
  SHA256_HEX,
  SPAWN_SUCCESS_DEFINITION,
  assertMutationOwnership,
  digestKey,
  ownershipHost,
  stableDigest
} from "./worker-mutation-primitives.mjs";
import {
  requestDigest
} from "./worker-mutation-request-contract.mjs";
import {
  assertDurableSpawnRequestBinding
} from "./worker-mutation-spawn-authority.mjs";

export function prepareGrantedFollowupAdmission({
  root,
  principal,
  workerId,
  grantId,
  message,
  idempotencyKey,
  providerCapabilityDigest,
  providerLaunchBinding,
  providerLaunchBindingDigest
}) {
  assertIdempotencyKey(idempotencyKey);
  if (typeof workerId !== "string" || !workerId) {
    throw new CompanionError("E_USAGE", "workerId is required for follow-up.");
  }
  if (!/^hag-[a-f0-9]{24}$/.test(grantId || "")) {
    throw new CompanionError("E_USAGE", "grantId is required and malformed.");
  }
  if (typeof message !== "string" || !message.trim() || message.length > 16000) {
    throw new CompanionError("E_USAGE", "message must be a non-empty string of at most 16000 characters.");
  }
  if (providerCapabilityDigest !== null && !SHA256_HEX.test(providerCapabilityDigest)) {
    throw new CompanionError("E_CAPABILITY", "Provider capability binding is missing or malformed.");
  }
  const requestedProviderBinding = normalizeProviderLaunchBindingInput(
    providerLaunchBinding,
    providerLaunchBindingDigest
  );
  const keyDigest = digestKey(idempotencyKey);
  const messageDigest = digestKey(message);
  const ownerThreadDigest = digestKey(principal?.threadId || "");
  assertBrokerMutationAuthority(principal, { root });
  return { requestedProviderBinding, keyDigest, messageDigest, ownerThreadDigest };
}

export function publishGrantedFollowupAdmission({
  admitted,
  root,
  idempotencyKey,
  env
}) {
  // The child commit is authoritative and precedes this derived publication.
  // A crash here is repaired by the child scan on the same-key replay.
  writeIdempotency(
    root,
    "followup",
    idempotencyKey,
    followupIdempotencyRecord(admitted.committed),
    env
  );
  return {
    handle: projectWorkerHandle(admitted.committed, { trustHostAuthority: false }),
    replayed: admitted.replayed,
    spawnSuccessDefinition: SPAWN_SUCCESS_DEFINITION,
    providerLaunched: false
  };
}

export function spawnGrantedFollowupWorker({ root, principal, workerId, grantId, message, idempotencyKey, env = process.env, providerCapabilityDigest = null, providerLaunchBinding = null, providerLaunchBindingDigest = null } = {}) {
  const { requestedProviderBinding, keyDigest, messageDigest, ownerThreadDigest } = prepareGrantedFollowupAdmission({ root, principal, workerId, grantId, message, idempotencyKey, providerCapabilityDigest, providerLaunchBinding, providerLaunchBindingDigest });
  const admitted = withWorkspaceStateTransaction(root, (transaction) => {
    const parent = transaction.tryReadJob(workerId);
    if (!parent) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    const parentProviderBinding = providerLaunchBindingForJob(parent, {
      required: false
    });
    const effectiveProviderBinding = parentProviderBinding || requestedProviderBinding;
    const effectiveProviderBindingDigest = effectiveProviderBinding
      ? digestProviderLaunchBinding(effectiveProviderBinding)
      : null;
    if (requestedProviderBinding
      && parentProviderBinding
      && effectiveProviderBindingDigest !== providerLaunchBindingDigest) {
      throw new CompanionError(
        "E_CONTEXT_DRIFT",
        "Provider executable pin changed since the parent worker admission."
      );
    }
    const jobs = transaction.listJobs();
    const grantOwners = jobs.filter((candidate) => candidate.request?.followup?.grantId === grantId);
    const keyOwners = jobs.filter((candidate) => (
      candidate.request?.followup?.idempotencyKeyDigest === keyDigest
    ));
    if (grantOwners.length > 1 || keyOwners.length > 1) {
      followupStateError("Follow-up admission ownership is ambiguous across durable jobs.");
    }
    if (grantOwners[0] && keyOwners[0] && grantOwners[0].id !== keyOwners[0].id) {
      idempotencyConflict("Role-admission grant and idempotencyKey belong to different follow-up jobs.");
    }
    const existingChild = grantOwners[0] || keyOwners[0] || null;
    const admission = resolveParentAdmission(parent, {
      root,
      principal,
      grantId,
      child: existingChild,
      verifyCurrentContext: true
    });
    const requestBody = followupRequestBody({
      parentWorkerId: parent.id,
      lineageWorkerId: admission.lineageWorkerId,
      grant: admission.grant,
      finalContextManifest: admission.finalContextManifest,
      messageDigest,
      ownerThreadDigest,
      idempotencyKeyDigest: keyDigest
    });
    const followupRequestDigest = stableDigest(requestBody);
    if (existingChild) {
      const witness = assertFollowupAdmissionBinding(existingChild, {
        root,
        env,
        verifyCurrentContext: true
      });
      if (witness.grantId !== grantId
        || witness.idempotencyKeyDigest !== keyDigest
        || witness.followupRequestDigest !== followupRequestDigest
        || witness.ownerThreadDigest !== ownerThreadDigest) {
        idempotencyConflict("Role-admission grant or idempotencyKey was already used for a different follow-up.");
      }
      assertBrokerMutationAuthority(principal, {
        root,
        exactThreadId: existingChild.host?.sessionId
      });
      assertDispatchContract(existingChild);
      assertDurableSpawnRequestBinding(existingChild, env);
      if (providerCapabilityDigest !== null
        && existingChild.request?.spawn?.providerCapabilityDigest !== providerCapabilityDigest) {
        throw new CompanionError(
          "E_CONTEXT_DRIFT",
          "Provider capability changed since durable follow-up admission."
        );
      }
      if (effectiveProviderBinding
        && existingChild.request?.spawn?.providerLaunchBindingDigest
          !== effectiveProviderBindingDigest) {
        throw new CompanionError(
          "E_CONTEXT_DRIFT",
          "Provider executable pin changed since durable follow-up admission."
        );
      }
      return { committed: existingChild, replayed: true };
    }

    const sidecar = readIdempotency(root, "followup", idempotencyKey, env);
    if (sidecar) {
      normalizeFollowupIdempotencyRecord(sidecar, { keyDigest });
      followupStateError("Follow-up idempotency record exists without its authoritative child job.");
    }

    const controlWorkspace = resolveControlWorkspace(root, env);
    const { controlWorkspaceId, executionRoot } = controlWorkspace;
    if (parent.controlWorkspaceId !== controlWorkspaceId
      || parent.request?.spawn?.executionRoot !== executionRoot) {
      throw new CompanionError("E_CONTEXT_DRIFT", "Follow-up parent belongs to a different control workspace.");
    }
    const envelope = bindTaskEnvelopeContext(
      buildTaskEnvelope({
        userRequest: message,
        objective: message,
        mode: "read",
        contextManifestId: admission.finalContextManifest.manifestId
      }),
      admission.finalContextManifest.manifestId
    );
    const role = assertRoleDigest(admission.grant.targetRole);
    const profile = admission.targetProfile;
    const runtimeRolePolicy = assertRuntimeRolePolicy(
      admission.grant.targetRuntimeRolePolicy,
      { role, profile }
    );
    const contextPacket = buildContextPacket({
      mode: "explicit-envelope",
      envelope,
      facts: envelope.context.facts,
      constraints: envelope.context.constraints
    });
    assertContextPacket(contextPacket, { envelope });
    const providerPrompt = composeProviderPrompt(envelope, {
      root: executionRoot,
      contextManifest: admission.finalContextManifest,
      contextPacket,
      runtimeRolePolicy
    });
    const providerPromptDigest = digestKey(providerPrompt);
    const contextBindingDigest = stableDigest({
      mode: CONTEXT_BINDING_MODE,
      packetDigest: contextPacket.digest,
      runtimeRolePolicyDigest: runtimeRolePolicy.digest,
      providerPromptDigest
    });
    const spawnDigest = requestDigest({
      principal,
      controlWorkspaceId,
      executionRoot,
      envelope,
      contextManifest: admission.finalContextManifest,
      roleId: role.id,
      write: false,
      contextBinding: {
        mode: CONTEXT_BINDING_MODE,
        digest: contextBindingDigest
      },
      ...(effectiveProviderBindingDigest
        ? { providerLaunchBindingDigest: effectiveProviderBindingDigest }
        : {})
    });
    const id = generateId("task");
    const createdAt = now();
    const contextReceipt = buildContextReceipt({
      contextPacket,
      rolePolicy: runtimeRolePolicy,
      contextManifest: admission.finalContextManifest,
      lineageWorkerId: id,
      effectivePromptDigest: providerPromptDigest
    });
    const followup = buildFollowupAdmissionWitness({
      childWorkerId: id,
      parent,
      admission,
      messageDigest,
      ownerThreadDigest,
      idempotencyKeyDigest: keyDigest,
      followupRequestDigest
    });
    const job = {
      schemaVersion: 3,
      id,
      kind: "task",
      jobClass: "task",
      write: false,
      status: "queued",
      phase: "accepted",
      summary: "Follow-up committed",
      progress: "Grant-bound continuation committed to the durable launch outbox.",
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
        envelope,
        contextManifest: admission.finalContextManifest,
        providerPromptDigest,
        providerHomeId: admission.lineageWorkerId,
        resumeJobId: parent.id,
        resumeSessionId: admission.resumeSessionId,
        publicObjective: null,
        roleId: role.id,
        followup,
        spawn: {
          executionRoot,
          idempotencyKeyDigest: keyDigest,
          ownerThreadId: principal.threadId,
          requestDigest: spawnDigest,
          contextBindingDigest,
          successDefinition: SPAWN_SUCCESS_DEFINITION,
          ownershipMode: FOLLOWUP_SPAWN_OWNERSHIP_MODE,
          ...(providerCapabilityDigest !== null ? { providerCapabilityDigest } : {}),
          ...(effectiveProviderBinding
            ? {
                providerLaunchBinding: effectiveProviderBinding,
                providerLaunchBindingDigest: effectiveProviderBindingDigest
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
        "Durable grant-bound follow-up accepted by worker broker.",
        { parentWorkerId: parent.id }
      ),
      result: null,
      error: null,
      workerAuthorization: null
    };
    job.workerAuthorization = createWorkerAuthorization({
      job,
      principal,
      issuedAt: createdAt
    });
    const committed = transaction.admitJob(job);
    assertFollowupAdmissionBinding(committed, {
      root,
      env,
      verifyCurrentContext: true
    });
    return { committed, replayed: false };
  }, env);
  return publishGrantedFollowupAdmission({ admitted, root, idempotencyKey, env });
}

function assertPriorAttemptStopped(job) {
  for (const identity of [job.controllerProcess, job.workerProcess, job.providerProcess]) {
    if (!identity) continue;
    if (!processGroupGone(identity)) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Prior provider attempt is still running."
      );
    }
  }
}

export function resumeInterruptedWorker({
  root,
  principal,
  workerId,
  message,
  idempotencyKey,
  env = process.env,
  providerCapabilityDigest = null,
  providerLaunchBinding = null,
  providerLaunchBindingDigest = null
} = {}) {
  assertIdempotencyKey(idempotencyKey);
  if (typeof workerId !== "string" || !workerId) {
    throw new CompanionError("E_USAGE", "workerId is required for follow-up.");
  }
  if (typeof message !== "string" || !message.trim() || message.length > 16000) {
    throw new CompanionError("E_USAGE", "message must be a non-empty string of at most 16000 characters.");
  }
  const parentProbe = tryReadJob(root, workerId, env);
  if (!parentProbe) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
  assertMutationOwnership(parentProbe, principal);
  const keyDigest = digestKey(idempotencyKey);
  const messageDigest = digestKey(message);
  const admitted = withWorkspaceStateTransaction(root, (transaction) => {
    const existing = readIdempotency(root, "resume", idempotencyKey, env);
    if (existing) {
      if (existing.workerId !== workerId
        || existing.ownerThreadId !== principal.threadId
        || existing.messageDigest !== messageDigest) {
        idempotencyConflict("idempotencyKey was reused with a different resume owner or request.");
      }
      const committed = transaction.readJob(existing.workerId);
      return { committed, replayed: true };
    }
    const parent = transaction.readJob(workerId);
    if (!interruptedFollowupParent(parent)) {
      throw new CompanionError(
        "E_CAPABILITY",
        "Follow-up without grantId requires an interrupted worker with a preserved provider session."
      );
    }
    assertPriorAttemptStopped(parent);
    transaction.clearCancel(workerId);
    const createdAt = now();
    const envelope = bindTaskEnvelopeContext(
      buildTaskEnvelope({
        userRequest: message,
        objective: message,
        mode: "read",
        contextManifestId: parent.request?.contextManifest?.manifestId
      }),
      parent.request?.contextManifest?.manifestId
    );
    const role = materializeRole("explorer");
    const runtimeRolePolicy = buildRuntimeRolePolicy({ role, profile: parent.profile });
    const contextPacket = buildContextPacket({
      mode: "explicit-envelope",
      envelope,
      facts: [],
      constraints: []
    });
    const providerPrompt = composeProviderPrompt(envelope, {
      root: parent.request.spawn.executionRoot,
      contextManifest: parent.request.contextManifest,
      contextPacket,
      runtimeRolePolicy
    });
    const providerPromptDigest = crypto.createHash("sha256").update(providerPrompt).digest("hex");
    const committed = transaction.updateJob(workerId, (job) => {
      const next = {
        ...job,
        status: "queued",
        phase: "accepted",
        progress: "Interrupted worker resumed; provider not started by broker follow-up.",
        updatedAt: createdAt,
        completedAt: null,
        error: null,
        controllerProcess: null,
        workerProcess: null,
        providerProcess: null,
        request: {
          ...job.request,
          envelope,
          contextPacket,
          runtimeRolePolicy,
          providerPromptDigest,
          resumeMessageDigest: messageDigest,
          spawn: {
            ...job.request.spawn,
            providerLaunchPending: true,
            providerLaunchInFlight: false,
            providerLaunchOutcome: "pending",
            dispatch: createDispatchOutbox({ createdAt })
          }
        },
        result: {
          ...(job.result || {}),
          interrupt: {
            ...(job.result?.interrupt || {}),
            resumedAt: createdAt
          }
        },
        lifecycleEvents: appendLifecycleEvent(
          job.lifecycleEvents || [],
          "task.accepted",
          "Interrupted worker resumed without replaying the original prompt.",
          { resumeIdempotencyKeyDigest: keyDigest }
        )
      };
      next.workerAuthorization = createWorkerAuthorization({
        job: next,
        principal,
        issuedAt: createdAt
      });
      return next;
    });
    writeIdempotency(root, "resume", idempotencyKey, {
      workerId,
      ownerThreadId: principal.threadId,
      messageDigest,
      keyDigest
    }, env);
    return { committed, replayed: false };
  }, env);
  return {
    handle: projectWorkerHandle(admitted.committed, { trustHostAuthority: false }),
    replayed: admitted.replayed,
    spawnSuccessDefinition: SPAWN_SUCCESS_DEFINITION,
    providerLaunched: false,
    providerLaunchState: "pending"
  };
}
