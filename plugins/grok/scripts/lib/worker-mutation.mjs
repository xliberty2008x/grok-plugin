/** Issue #56 compatibility facade. Lifecycle authority remains in WorkerService and durable records. */
export {
  CANCEL_METRIC_TIMESTAMPS,
  cancelWorker,
  projectCancellationReceipt
} from "./worker-mutation-cancellation.mjs";
export {
  acquireRecoveryCleanupFence,
  prepareDispatchProcessSpawn,
  prepareWorkerProviderSpawn,
  recordDispatchProcessNoChild,
  recordWorkerProviderSpawnNoChild,
  verifyRecoveryCleanupFence
} from "./worker-mutation-dispatch-admission.mjs";
export {
  PROVIDER_ROTATION_INTENT_SCHEMA_VERSION,
  PROVIDER_SPAWN_INTENT_SCHEMA_VERSION,
  RECOVERY_CLEANUP_FENCE_SCHEMA_VERSION,
  WORKER_DISPATCH_SCHEMA_VERSION,
  WORKER_SPAWN_INTENT_SCHEMA_VERSION,
  assertDispatchContract,
  assertNoRecoveryCleanupFence,
  providerLaunchState
} from "./worker-mutation-dispatch-contract.mjs";
export {
  authorizeWorkerProviderRotation,
  claimWorkerDispatch,
  recordUnsettledProviderProcess,
  recordUnsettledWorkerProcess,
  recordWorkerProviderRotationNoChild,
  transitionWorkerDispatch
} from "./worker-mutation-dispatch-transition.mjs";
export {
  spawnGrantedFollowupWorker
} from "./worker-mutation-followup.mjs";
export {
  FOLLOWUP_ADMISSION_KIND,
  FOLLOWUP_ADMISSION_WITNESS_SCHEMA_VERSION,
  assertFollowupAdmissionBinding
} from "./worker-mutation-followup-contract.mjs";
export {
  getSpawnIdempotencyRecord
} from "./worker-mutation-idempotency.mjs";
export {
  FOLLOWUP_SPAWN_OWNERSHIP_MODE,
  SPAWN_OWNERSHIP_MODE,
  SPAWN_SUCCESS_DEFINITION,
  assertMutationOwnership,
  cancellationNonce
} from "./worker-mutation-primitives.mjs";
export {
  spawnReadOnlyWorker
} from "./worker-mutation-spawn.mjs";
export {
  assertDurableSpawnRequestBinding,
  assertWorkerProviderLaunchPreparation
} from "./worker-mutation-spawn-authority.mjs";
export {
  persistCompletedWriteArtifact,
  settleFailedDispatchCleanup,
  settlePreProviderWorkerFinalization,
  settleProviderStartedWorkerFinalization,
  settleStartedWorkerLoss,
  settleUnstartedDispatchLoss,
  settleWriteArtifactAfterRuntimeCleanup
} from "./worker-mutation-terminal.mjs";
export {
  admitWriteWorkerPlan,
  authorizeReadyWriteWorkerDispatch
} from "./worker-mutation-write-admission.mjs";
export {
  activateWriteProvisioningAttempt,
  prepareWriteProvisionerIntent,
  prepareWriteProvisioningReissue,
  promoteWriteWorkerReady,
  recordOfficialWorktreeReceipt
} from "./worker-mutation-write-provisioning.mjs";
export {
  adoptWriteProvisioningEffect,
  recordWriteProvisionerNoChild,
  retainWriteProvisioningCleanupPending
} from "./worker-mutation-write-recovery.mjs";
export {
  assertWriteExecutionJob
} from "./worker-mutation-write-runtime-contract.mjs";
