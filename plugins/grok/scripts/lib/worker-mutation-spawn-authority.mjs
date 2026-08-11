import { contextIncompleteError } from "./task-context-metadata.mjs";
/** Issue #56 worker-mutation spawn-authority domain. */
import path from "node:path";
import { CompanionError, asErrorPayload } from "./errors.mjs";
import {
  assertProviderLaunchBinding,
  providerLaunchBindingDigest as digestProviderLaunchBinding
} from "./provider-executable-pin.mjs";
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
import { boundPathEvidence } from "./task-contract-primitives.mjs";
import {
  CONTEXT_MANIFEST_VERSION,
  CONTEXT_METADATA_POLICIES
} from "./task-context-policy.mjs";
import {
  buildRuntimeEvidence,
  observeChangedPaths
} from "./task-runtime-evidence.mjs";
import { composeProviderPrompt } from "./task-provider-prompt.mjs";
import { evaluateScope } from "./task-scope.mjs";
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
  assertExactWriteVerticalScope,
  assertParentUnchanged,
  assertManagedWorkerWorktree,
  assertRegisteredWorkerWorktreeIdentity,
  assertTrackedWriteVerticalTarget,
  classifyWorkerWorktreeEffect,
  captureParentFingerprint,
  expectedWorkerWorktreeRoot,
  persistWriteWorkerArtifact
} from "./worker-worktree.mjs";
import {
  assertExecutionBinding,
  assertProvisioningJournal,
  createExecutionBinding,
  createProvisioningJournal,
  transitionProvisioningJournal
} from "./worker-execution-binding.mjs";
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
  assertProviderRotationIntentContract,
  assertProviderSpawnIntentContract,
  terminalJob
} from "./worker-mutation-dispatch-contract.mjs";
import {
  assertFollowupAdmissionBinding
} from "./worker-mutation-followup-contract.mjs";
import {
  spawnIdempotencyStateError
} from "./worker-mutation-idempotency.mjs";
import {
  SHA256_HEX,
  digestKey,
  isPlainRecord,
  stableDigest
} from "./worker-mutation-primitives.mjs";
import {
  requestDigest
} from "./worker-mutation-request-contract.mjs";
import {
  writeAdmissionOwnerDigest,
  writeAdmissionRequestDigest
} from "./worker-mutation-write-contract.mjs";
import {
  assertWriteProvisioningRuntime
} from "./worker-mutation-write-runtime-contract.mjs";

export function assertWorkerProviderLaunchPreparation(job, {
  dispatchAttemptId = null,
  dispatchFence = null,
  providerGeneration = null,
  env = process.env
} = {}) {
  // Exhaustive split: every read job and every generation other than the
  // exact write-repair generation returns before post-binding validation.
  if (job?.write !== true || providerGeneration !== 2) {
    return assertDurableSpawnRequestBinding(job, env);
  }

  assertDispatchContract(job);
  assertManagedWritePostBindingContext(job, env);
  const spawn = job?.request?.spawn;
  const dispatch = spawn?.dispatch;
  const taskProfile = profileFor("task", true);
  // binding.envelopeDigest intentionally names the pre-provisioning admission
  // envelope. The durable dispatch envelope is separately covered by the
  // consumed launch contract after its execution-context identity is added.
  assertExecutionBinding(job.executionBinding, {
    workerId: job.id,
    controlWorkspaceId: job.controlWorkspaceId,
    expectedExecutionRoot: spawn?.executionRoot,
    bindingDigest: spawn?.executionBindingDigest,
    scope: job.request?.envelope?.scope,
    roleDigest: job.role?.digest,
    profileDigest: stableDigest(taskProfile),
    runtimeRolePolicyDigest: job.request?.runtimeRolePolicy?.digest,
    admissionContextManifestId:
      job.request?.admissionContextManifest?.manifestId,
    admissionContextManifestDigest:
      job.request?.admissionContextManifest?.digest,
    providerCapabilityDigest: spawn?.writeLifecycleCapabilityDigest,
    ownerDigest: writeAdmissionOwnerDigest(job.host)
  });
  const rotationIntent = assertProviderRotationIntentContract(job, dispatch);
  const providerSpawnIntent = assertProviderSpawnIntentContract(
    job,
    dispatch,
    { allowMissing: false }
  );
  const exactAuthorizedRepair = !terminalJob(job)
    && isDispatchV2(dispatch)
    && dispatch.state === "provider-started"
    && dispatch.attemptId === dispatchAttemptId
    && dispatch.fence === dispatchFence
    && dispatch.providerGeneration === 1
    && dispatch.nextProviderGeneration === 2
    && rotationIntent?.status === "pending"
    && rotationIntent.attemptId === dispatchAttemptId
    && rotationIntent.dispatchFence === dispatchFence
    && rotationIntent.baseProviderGeneration === 1
    && rotationIntent.targetProviderGeneration === 2
    && providerSpawnIntent.status === "pending"
    && providerSpawnIntent.intentId === rotationIntent.intentId
    && providerSpawnIntent.attemptId === dispatchAttemptId
    && providerSpawnIntent.dispatchFence === dispatchFence
    && providerSpawnIntent.providerGeneration === 2;
  if (!exactAuthorizedRepair) {
    throw new CompanionError(
      "E_AUTH_REQUIRED",
      "Write report-repair launch no longer matches its exact durable provider rotation."
    );
  }
  return job;
}

export function storedSpawnReplayRequestDigest({
  job,
  principal,
  envelope,
  roleId,
  write,
  providerLaunchBindingDigest = undefined
}) {
  const storedContextManifest = assertContextManifestIntegrity(
    job?.request?.contextManifest
  );
  const storedEnvelope = bindTaskEnvelopeContext(
    envelope,
    storedContextManifest.manifestId
  );
  const storedContextBindingDigest = job?.request?.spawn?.contextBindingDigest;
  const hasStoredContextBinding = storedContextBindingDigest !== undefined;
  if (hasStoredContextBinding
    && (!SHA256_HEX.test(storedContextBindingDigest || "")
      || job.request?.contextBindingMode !== CONTEXT_BINDING_MODE)) {
    spawnIdempotencyStateError(
      "Durable worker replay context binding is malformed."
    );
  }
  return requestDigest({
    principal,
    controlWorkspaceId: job.controlWorkspaceId,
    executionRoot: job.request.spawn.executionRoot,
    envelope: storedEnvelope,
    contextManifest: storedContextManifest,
    roleId,
    write,
    ...(hasStoredContextBinding
      ? {
          contextBinding: {
            mode: CONTEXT_BINDING_MODE,
            digest: storedContextBindingDigest
          }
        }
      : {}),
    ...(providerLaunchBindingDigest === undefined
      ? {}
      : { providerLaunchBindingDigest })
  });
}

export function hasManagedWriteAuthority(job) {
  const dispatch = job?.request?.spawn?.dispatch;
  if (job?.write !== true) {
    return false;
  }
  const authorities = [
    job.executionBinding,
    job.provisioning,
    job.provisioningRuntime,
    job.request?.admissionContextManifest,
    job.request?.contextManifest,
    job.request?.spawn?.executionBindingDigest
  ];
  const present = authorities.map((value) => value !== undefined && value !== null);
  const anyAuthority = present.some(Boolean);
  const managedDispatch = isDispatchV2(dispatch);
  if (!managedDispatch && !anyAuthority) {
    return false;
  }
  if (!managedDispatch || !present.every(Boolean)) {
    spawnIdempotencyStateError(
      "Managed write dispatch requires a complete execution-context authority."
    );
  }
  return true;
}

export function hasManagedWritePostBinding(job) {
  return hasManagedWriteAuthority(job)
    && job.request.spawn.dispatch.state === "provider-started";
}

export function assertManagedWriteImmutableAuthority(
  job,
  env = process.env,
  { allowFinalControlContextDrift = false } = {}
) {
  if (!hasManagedWriteAuthority(job)) {
    spawnIdempotencyStateError(
      "Managed write verification requires a complete dispatch authority."
    );
  }
  assertDispatchContract(job);
  const spawn = job.request.spawn;
  if (!SHA256_HEX.test(spawn.admissionRequestDigest || "")
    || !SHA256_HEX.test(spawn.idempotencyKeyDigest || "")
    || !SHA256_HEX.test(spawn.writeLifecycleCapabilityDigest || "")
    || !SHA256_HEX.test(spawn.providerCapabilityDigest || "")) {
    spawnIdempotencyStateError(
      "Managed write retained admission or capability authority is malformed."
    );
  }
  // Provider-started records deliberately scrub literal request text. Their
  // envelope remains bound by its digest, launch contract, request digest, and
  // context receipt, but it is no longer an executable assertTaskEnvelope input.
  const envelope = job.request.envelope;
  if (!isPlainRecord(envelope)
    || envelope.mode !== "write"
    || !SHA256_HEX.test(envelope.digest || "")) {
    spawnIdempotencyStateError(
      "Managed write durable envelope authority is malformed."
    );
  }
  assertExactWriteVerticalScope(envelope.scope);
  const role = assertRoleDigest(job.role);
  const profile = profileFor("task", true);
  const runtimeRolePolicy = job.request?.runtimeRolePolicy;
  try {
    assertRuntimeRolePolicy(runtimeRolePolicy, { role, profile });
  } catch {
    spawnIdempotencyStateError(
      "Managed write runtime role authority is malformed."
    );
  }

  let admissionContextManifest;
  let requestContextManifest;
  let runtimeContextManifest;
  try {
    admissionContextManifest = assertContextManifestIntegrity(
      job.request.admissionContextManifest
    );
    requestContextManifest = assertContextManifestIntegrity(
      job.request.contextManifest
    );
    runtimeContextManifest = assertContextManifestIntegrity(
      job.provisioningRuntime.executionContextManifest
    );
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    spawnIdempotencyStateError(
      "Managed write ContextManifest authority failed integrity validation."
    );
  }
  if (admissionContextManifest.schemaVersion !== CONTEXT_MANIFEST_VERSION
    || requestContextManifest.schemaVersion !== CONTEXT_MANIFEST_VERSION
    || runtimeContextManifest.schemaVersion !== CONTEXT_MANIFEST_VERSION) {
    throw new CompanionError(
      "E_CONTEXT_DRIFT",
      "Managed write dispatch requires chronology-authenticated ContextManifest records.",
      { code: "E_CONTEXT_DRIFT", reasons: ["manifestVersion"] }
    );
  }

  const binding = assertExecutionBinding(job.executionBinding, {
    workerId: job.id,
    controlWorkspaceId: job.controlWorkspaceId,
    expectedExecutionRoot: spawn.executionRoot,
    bindingDigest: spawn.executionBindingDigest,
    scope: envelope.scope,
    roleDigest: role.digest,
    profileDigest: stableDigest(profile),
    runtimeRolePolicyDigest: runtimeRolePolicy.digest,
    admissionContextManifestId: admissionContextManifest.manifestId,
    admissionContextManifestDigest: admissionContextManifest.digest,
    providerCapabilityDigest: spawn.providerCapabilityDigest,
    ownerDigest: writeAdmissionOwnerDigest(job.host)
  });
  const journal = assertProvisioningJournal(binding, job.provisioning);
  const provisioningRuntime = assertWriteProvisioningRuntime(
    job.provisioningRuntime,
    binding,
    journal
  );
  let control;
  try {
    control = resolveControlWorkspace(binding.expectedExecutionRoot, env);
  } catch {
    spawnIdempotencyStateError(
      "Managed write control workspace authority could not be resolved."
    );
  }
  const retainedProviderLaunchBindingDigest =
    Object.hasOwn(spawn, "providerLaunchBindingDigest")
      ? spawn.providerLaunchBindingDigest
      : null;
  let observedProviderLaunchBindingDigest = null;
  if (retainedProviderLaunchBindingDigest !== null) {
    try {
      observedProviderLaunchBindingDigest =
        digestProviderLaunchBinding(spawn.providerLaunchBinding);
    } catch {
      spawnIdempotencyStateError(
        "Managed write provider executable authority is malformed."
      );
    }
  }
  const providerStarted =
    spawn.dispatch.state === "provider-started";
  if (!providerStarted && typeof envelope.userRequest !== "string") {
    spawnIdempotencyStateError(
      "Managed write admission envelope was privacy-scrubbed before provider start."
    );
  }
  let reconstructedAdmissionEnvelopeDigest = null;
  if (typeof envelope.userRequest === "string") {
    try {
      reconstructedAdmissionEnvelopeDigest = bindTaskEnvelopeContext(
        envelope,
        admissionContextManifest.manifestId
      ).digest;
    } catch {
      spawnIdempotencyStateError(
        "Managed write admission envelope authority could not be reconstructed."
      );
    }
  }
  const expectedAdmissionRequestDigest = writeAdmissionRequestDigest({
    binding,
    idempotencyKeyDigest: spawn.idempotencyKeyDigest
  });
  if (journal.state !== "ready"
    || binding.expectedExecutionRoot !== spawn.executionRoot
    || binding.bindingDigest !== spawn.executionBindingDigest
    || binding.controlWorkspaceId !== job.controlWorkspaceId
    || control.executionRoot !== binding.expectedExecutionRoot
    || control.controlWorkspaceId !== binding.controlWorkspaceId
    || control.controlRoot !== binding.controlRoot
    || control.gitCommonDir !== binding.gitCommonDir
    || spawn.admissionRequestDigest !== expectedAdmissionRequestDigest
    || spawn.writeLifecycleCapabilityDigest !== spawn.providerCapabilityDigest
    || spawn.writeLifecycleCapabilityDigest !== binding.providerCapabilityDigest
    || binding.providerCapabilityDigest !== spawn.providerCapabilityDigest
    || retainedProviderLaunchBindingDigest
      !== binding.providerLaunchBindingDigest
    || (retainedProviderLaunchBindingDigest !== null
      && observedProviderLaunchBindingDigest
        !== retainedProviderLaunchBindingDigest)
    || (reconstructedAdmissionEnvelopeDigest !== null
      && binding.envelopeDigest !== reconstructedAdmissionEnvelopeDigest)
    || requestContextManifest.workspaceRoot !== binding.expectedExecutionRoot
    || requestContextManifest.git?.head !== binding.baseCommit
    || requestContextManifest.manifestId
      !== journal.executionContextManifestId
    || requestContextManifest.digest
      !== journal.executionContextManifestDigest
    || runtimeContextManifest.manifestId
      !== journal.executionContextManifestId
    || runtimeContextManifest.digest
      !== journal.executionContextManifestDigest
    || stableDigest(requestContextManifest)
      !== stableDigest(runtimeContextManifest)
    || job.provisioningRuntime.executionContextManifestRecordDigest
      !== stableDigest(runtimeContextManifest)) {
    spawnIdempotencyStateError(
      "Managed write request, runtime, journal, and execution binding disagree."
    );
  }

  let parentFingerprintError = null;
  try {
    assertParentUnchanged(binding.parentFingerprint, binding.controlRoot);
  } catch (error) {
    if (!allowFinalControlContextDrift || error?.code !== "E_INTEGRATION") {
      throw error;
    }
    parentFingerprintError = error;
  }
  let controlContextError = null;
  try {
    assertContextCompatible(
      binding.controlRoot,
      admissionContextManifest,
      {
        mode: "execute",
        metadataPolicy: CONTEXT_METADATA_POLICIES.SUPERVISORY_LINKED_WRITE
      }
    );
  } catch (error) {
    if (!allowFinalControlContextDrift || error?.code !== "E_CONTEXT_DRIFT") {
      throw error;
    }
    controlContextError = error;
  }
  assertRegisteredWorkerWorktreeIdentity({
    controlRoot: binding.controlRoot,
    executionRoot: binding.expectedExecutionRoot,
    baseCommit: binding.baseCommit,
    workerId: job.id,
    env
  });

  return Object.freeze({
    binding,
    journal,
    provisioningRuntime,
    envelope,
    admissionContextManifest,
    requestContextManifest,
    runtimeContextManifest,
    controlContextError,
    parentFingerprintError
  });
}

export function captureManagedWritePostBindingContext(
  job,
  env = process.env,
  { observedContextManifest = null } = {}
) {
  if (!hasManagedWritePostBinding(job)) {
    spawnIdempotencyStateError(
      "Managed write post-binding verification requires provider-started authority."
    );
  }
  const {
    binding,
    journal,
    provisioningRuntime,
    envelope,
    admissionContextManifest,
    requestContextManifest,
    runtimeContextManifest,
    controlContextError,
    parentFingerprintError
  } = assertManagedWriteImmutableAuthority(
    job,
    env,
    { allowFinalControlContextDrift: true }
  );
  let currentContextManifest;
  if (observedContextManifest == null) {
    try {
      currentContextManifest = captureContextManifest(binding.expectedExecutionRoot);
    } catch {
      throw contextIncompleteError("terminal", ["contextCapture"]);
    }
    currentContextManifest = assertContextManifestIntegrity(currentContextManifest);
  } else {
    currentContextManifest = assertContextManifestIntegrity(observedContextManifest);
  }
  const controlReasons = Array.isArray(controlContextError?.details?.reasons)
    ? [...controlContextError.details.reasons]
    : controlContextError
      ? ["controlContext"]
      : [];
  const coreReasons = [
    ...controlReasons,
    ...(parentFingerprintError && controlReasons.length === 0
      ? ["parentFingerprint"]
      : [])
  ];
  const controlContextMarkers = [];
  if (controlReasons.some((reason) => [
    "head",
    "branch"
  ].includes(reason))) {
    controlContextMarkers.push("[HEAD]");
  }
  if (controlReasons.some((reason) => [
    "taskRelevantMetadataIdentity",
    "metadataIdentity",
    "upstreamRef",
    "upstreamCommit"
  ].includes(reason))) {
    controlContextMarkers.push("[GIT_METADATA]");
  }
  if (controlReasons.some((reason) => [
    "trackedTreeIdentity",
    "dirtyDigest",
    "ignoredDigest"
  ].includes(reason))) {
    controlContextMarkers.push("[INDEX]");
  }
  if (parentFingerprintError
    && controlContextMarkers.length === 0
    && /\bHEAD\b/i.test(parentFingerprintError.message || "")) {
    controlContextMarkers.push("[HEAD]");
  }
  if (currentContextManifest.workspaceRoot !== requestContextManifest.workspaceRoot) {
    coreReasons.push("workspaceRoot");
  }
  if (Boolean(currentContextManifest.git?.linkedWorktree)
    !== Boolean(requestContextManifest.git?.linkedWorktree)) {
    coreReasons.push("linkedWorktree");
  }
  if (Boolean(currentContextManifest.git?.sparse)
    !== Boolean(requestContextManifest.git?.sparse)) {
    coreReasons.push("sparse");
  }
  if (Boolean(currentContextManifest.git?.shallow)
    !== Boolean(requestContextManifest.git?.shallow)) {
    coreReasons.push("shallow");
  }
  if ((currentContextManifest.git?.branch || null)
    !== (requestContextManifest.git?.branch || null)) {
    coreReasons.push("branch");
  }
  if (Boolean(currentContextManifest.git?.insideWorktree)
    !== Boolean(requestContextManifest.git?.insideWorktree)) {
    coreReasons.push("insideWorktree");
  }
  if (stableDigest(currentContextManifest.projectMarkers)
    !== stableDigest(requestContextManifest.projectMarkers)) {
    coreReasons.push("projectMarkers");
  }
  if ((currentContextManifest.git?.upstreamRef || null)
      !== (requestContextManifest.git?.upstreamRef || null)
    || (currentContextManifest.git?.upstreamCommit || null)
      !== (requestContextManifest.git?.upstreamCommit || null)) {
    coreReasons.push("upstream");
  }
  const observedChangedPaths = [...new Set([
    ...observeChangedPaths(
      requestContextManifest,
      currentContextManifest
    ),
    ...controlContextMarkers
  ])];
  const scopeViolations = evaluateScope(
    observedChangedPaths,
    envelope.scope
  );
  const metadataMarkers = scopeViolations.filter(
    (item) => String(item).startsWith("[")
  );
  return Object.freeze({
    binding,
    journal,
    provisioningRuntime,
    envelope,
    admissionContextManifest,
    requestContextManifest,
    runtimeContextManifest,
    currentContextManifest,
    observedChangedPaths,
    scopeViolations,
    coreReasons,
    controlContextMarkers,
    metadataMarkers
  });
}

export function assertManagedWritePostBindingObservation(observed) {
  if (observed.coreReasons.length || observed.metadataMarkers.length) {
    throw new CompanionError(
      "E_CONTEXT_DRIFT",
      "Managed write execution context drifted after provider binding; refusing to continue.",
      {
        code: "E_CONTEXT_DRIFT",
        reasons: [
          ...observed.coreReasons,
          ...observed.metadataMarkers
        ]
      }
    );
  }
  if (observed.scopeViolations.length) {
    const paths = boundPathEvidence(
      observed.scopeViolations,
      { marker: "[SCOPE_VIOLATIONS_OVERFLOW]" }
    );
    throw new CompanionError(
      "E_SCOPE_VIOLATION",
      "Managed write execution produced changes outside its exact delegated scope.",
      { paths }
    );
  }
  return observed;
}

export function assertManagedWritePostBindingContext(job, env = process.env) {
  return assertManagedWritePostBindingObservation(
    captureManagedWritePostBindingContext(job, env)
  );
}

export function assertManagedWriteReplayContext(job, env = process.env) {
  if (!terminalJob(job) || !job.verificationContextManifest) {
    return assertManagedWritePostBindingContext(job, env);
  }
  const completionContextManifest = assertContextManifestIntegrity(
    job.completionContextManifest
  );
  const runtimePostContext = job.result?.runtimeEvidence?.postContext;
  if (!runtimePostContext
    || runtimePostContext.manifestId !== completionContextManifest.manifestId
    || runtimePostContext.digest !== completionContextManifest.digest) {
    spawnIdempotencyStateError(
      "Verified terminal write completion evidence is malformed."
    );
  }
  const completionObservation = assertManagedWritePostBindingObservation(
    captureManagedWritePostBindingContext(
      job,
      env,
      { observedContextManifest: completionContextManifest }
    )
  );
  const verificationContextManifest = assertContextManifestIntegrity(
    job.verificationContextManifest
  );
  const verificationReasons = [];
  if (verificationContextManifest.workspaceRoot
      !== completionContextManifest.workspaceRoot) {
    verificationReasons.push("workspaceRoot");
  }
  for (const field of [
    "linkedWorktree",
    "sparse",
    "shallow",
    "branch",
    "insideWorktree",
    "upstreamRef",
    "upstreamCommit"
  ]) {
    if ((verificationContextManifest.git?.[field] ?? null)
      !== (completionContextManifest.git?.[field] ?? null)) {
      verificationReasons.push(field);
    }
  }
  if (stableDigest(verificationContextManifest.projectMarkers)
    !== stableDigest(completionContextManifest.projectMarkers)) {
    verificationReasons.push("projectMarkers");
  }
  const verificationChangedPaths = observeChangedPaths(
    completionContextManifest,
    verificationContextManifest,
    { observer: "verification" }
  );
  verificationReasons.push(...evaluateScope(
    verificationChangedPaths,
    completionObservation.envelope.scope
  ));
  if (verificationReasons.length) {
    spawnIdempotencyStateError(
      "Verified terminal write baseline disagrees with its completion context."
    );
  }
  assertContextCompatible(
    completionObservation.binding.expectedExecutionRoot,
    verificationContextManifest,
    { mode: "resume" }
  );
  return completionObservation;
}

export function assertDurableSpawnRequestBinding(job, env = process.env) {
  const spawn = job?.request?.spawn;
  const executionRoot = spawn?.executionRoot;
  const isGrantedFollowup = job?.request?.followup !== undefined;
  if (typeof executionRoot !== "string"
    || !path.isAbsolute(executionRoot)
    || path.normalize(executionRoot) !== executionRoot
    || !SHA256_HEX.test(spawn?.idempotencyKeyDigest || "")
    || (Object.hasOwn(spawn || {}, "providerCapabilityDigest")
      && !SHA256_HEX.test(spawn.providerCapabilityDigest || ""))
    || (Object.hasOwn(spawn || {}, "contextBindingDigest")
      && !SHA256_HEX.test(spawn.contextBindingDigest || ""))
    || spawn?.ownerThreadId !== job?.host?.sessionId) {
    spawnIdempotencyStateError("Durable worker spawn provenance is malformed.");
  }
  try {
    providerLaunchBindingForJob(job, { required: false });
  } catch {
    spawnIdempotencyStateError(
      "Durable worker provider executable binding is malformed or partial."
    );
  }
  let control;
  let acceptedContext;
  try {
    control = resolveControlWorkspace(executionRoot, env);
    if (control.executionRoot !== executionRoot
      || control.controlWorkspaceId !== job.controlWorkspaceId) {
      spawnIdempotencyStateError("Durable worker spawn execution root no longer matches its control workspace.");
    }
    const managedWriteAuthority = hasManagedWriteAuthority(job);
    if (managedWriteAuthority
      && job.request.spawn.dispatch.state === "provider-started") {
      acceptedContext =
        assertManagedWriteReplayContext(job, env).requestContextManifest;
    } else if (managedWriteAuthority) {
      const authority = assertManagedWriteImmutableAuthority(job, env);
      acceptedContext = assertContextCompatible(
        executionRoot,
        authority.requestContextManifest,
        { mode: "execute" }
      );
    } else {
      acceptedContext = assertContextCompatible(
        executionRoot,
        job.request?.contextManifest,
        { mode: isGrantedFollowup ? "resume" : "execute" }
      );
    }
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    spawnIdempotencyStateError("Durable worker spawn context could not be verified.");
  }
  if (job.request?.envelope?.contextManifestId != null
    && job.request.envelope.contextManifestId !== acceptedContext?.manifestId) {
    spawnIdempotencyStateError("Durable worker spawn envelope no longer matches its context identity.");
  }
  const bindingValues = [
    job.request?.contextBindingMode,
    job.request?.contextPacket,
    job.request?.runtimeRolePolicy,
    job.request?.contextReceipt,
    spawn?.contextBindingDigest
  ];
  const hasAnyContextBinding = bindingValues.some((value) => value !== undefined);
  const hasCompleteContextBinding = job.request?.contextBindingMode === CONTEXT_BINDING_MODE
    && job.request?.contextPacket
    && job.request?.runtimeRolePolicy
    && job.request?.contextReceipt
    && SHA256_HEX.test(spawn?.contextBindingDigest || "");
  if (hasAnyContextBinding && !hasCompleteContextBinding) {
    spawnIdempotencyStateError("Durable worker context binding is partial or downgraded.");
  }
  let contextBinding;
  if (hasCompleteContextBinding) {
    const validRootLineage = !isGrantedFollowup && job.request?.providerHomeId === job.id;
    const validFollowupLineage = isGrantedFollowup
      && job.request?.providerHomeId !== job.id
      && job.request?.resumeJobId === job.request?.followup?.parentWorkerId
      && ["reviewer", "security", "test"].includes(job.request?.roleId);
    if ((!validRootLineage && !validFollowupLineage)
      || typeof job.request?.roleId !== "string"
      || job.role?.id !== job.request.roleId
      || (!job.write && !isGrantedFollowup && job.request.roleId !== "explorer")) {
      spawnIdempotencyStateError("Durable worker context lineage or logical role is malformed.");
    }
    const expectedRole = materializeRole(job.request.roleId);
    const expectedProfile = profileFor("task", Boolean(job.write));
    try {
      assertRoleDigest(job.role);
      if (!sameSecurityProfile(job.profile, expectedProfile)) {
        throw new CompanionError("E_ROLE", "Durable provider profile drifted.");
      }
      assertContextPacket(job.request.contextPacket, {
        envelope: job.request.envelope
      });
      assertRuntimeRolePolicy(job.request.runtimeRolePolicy, {
        role: expectedRole,
        profile: expectedProfile
      });
      assertContextReceipt(job.request.contextReceipt, {
        contextPacket: job.request.contextPacket,
        rolePolicy: job.request.runtimeRolePolicy,
        contextManifest: acceptedContext,
        lineageWorkerId: isGrantedFollowup ? job.id : job.request.providerHomeId,
        effectivePromptDigest: job.request?.providerPromptDigest
      });
    } catch {
      spawnIdempotencyStateError("Durable worker context packet, role policy, or receipt drifted.");
    }
    const expectedContextBindingDigest = stableDigest({
      mode: CONTEXT_BINDING_MODE,
      packetDigest: job.request.contextPacket.digest,
      runtimeRolePolicyDigest: job.request.runtimeRolePolicy.digest,
      providerPromptDigest: job.request.providerPromptDigest
    });
    if (spawn.contextBindingDigest !== expectedContextBindingDigest) {
      spawnIdempotencyStateError("Durable worker context binding digest drifted.");
    }
    contextBinding = {
      mode: CONTEXT_BINDING_MODE,
      digest: expectedContextBindingDigest
    };
    if (isGrantedFollowup) {
      try {
        assertFollowupAdmissionBinding(job, {
          root: executionRoot,
          env,
          verifyCurrentContext: true
        });
      } catch (error) {
        if (error instanceof CompanionError) throw error;
        spawnIdempotencyStateError("Durable follow-up admission witness drifted.");
      }
    }
  }
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
    write: job.write,
    ...(contextBinding ? { contextBinding } : {}),
    ...(Object.hasOwn(spawn, "providerLaunchBindingDigest")
      ? { providerLaunchBindingDigest: spawn.providerLaunchBindingDigest }
      : {})
  });
  if (spawn.requestDigest !== recomputedRequestDigest) {
    spawnIdempotencyStateError("Durable worker spawn request no longer matches its admitted binding.");
  }
  if (!SHA256_HEX.test(job.request?.providerPromptDigest || "")) {
    spawnIdempotencyStateError("Durable worker provider-prompt digest is malformed.");
  }
  if (typeof job.request?.envelope?.userRequest === "string") {
    let recomputedPromptDigest;
    try {
      recomputedPromptDigest = hasCompleteContextBinding
        ? verifyJobEffectivePrompt(job, {
          root: executionRoot,
          contextManifest: acceptedContext,
          composeLegacyProviderPrompt: composeProviderPrompt
        }).digest
        : digestKey(composeProviderPrompt(job.request.envelope, {
          root: executionRoot,
          contextManifest: acceptedContext
        }));
    } catch {
      spawnIdempotencyStateError("Durable worker provider prompt reconstruction failed.");
    }
    if (recomputedPromptDigest !== job.request.providerPromptDigest) {
      spawnIdempotencyStateError("Durable worker provider prompt no longer matches its admitted binding.");
    }
  }
  return job;
}
