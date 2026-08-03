import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = path.join(ROOT, "plugins", "grok", "scripts", "lib");
const FACADE = "worker-mutation.mjs";
const LEAVES = Object.freeze([
  "worker-mutation-cancellation.mjs",
  "worker-mutation-dispatch-admission.mjs",
  "worker-mutation-dispatch-contract.mjs",
  "worker-mutation-dispatch-transition.mjs",
  "worker-mutation-followup-contract.mjs",
  "worker-mutation-followup.mjs",
  "worker-mutation-idempotency.mjs",
  "worker-mutation-primitives.mjs",
  "worker-mutation-request-contract.mjs",
  "worker-mutation-spawn-authority.mjs",
  "worker-mutation-spawn.mjs",
  "worker-mutation-terminal.mjs",
  "worker-mutation-write-admission.mjs",
  "worker-mutation-write-contract.mjs",
  "worker-mutation-write-provisioning.mjs",
  "worker-mutation-write-recovery.mjs",
  "worker-mutation-write-runtime-contract.mjs"
]);
const PUBLIC_EXPORTS = Object.freeze([
  "CANCEL_METRIC_TIMESTAMPS",
  "FOLLOWUP_ADMISSION_KIND",
  "FOLLOWUP_ADMISSION_WITNESS_SCHEMA_VERSION",
  "FOLLOWUP_SPAWN_OWNERSHIP_MODE",
  "PROVIDER_ROTATION_INTENT_SCHEMA_VERSION",
  "PROVIDER_SPAWN_INTENT_SCHEMA_VERSION",
  "RECOVERY_CLEANUP_FENCE_SCHEMA_VERSION",
  "SPAWN_OWNERSHIP_MODE",
  "SPAWN_SUCCESS_DEFINITION",
  "WORKER_DISPATCH_SCHEMA_VERSION",
  "WORKER_SPAWN_INTENT_SCHEMA_VERSION",
  "acquireRecoveryCleanupFence",
  "activateWriteProvisioningAttempt",
  "admitWriteWorkerPlan",
  "adoptWriteProvisioningEffect",
  "assertDispatchContract",
  "assertDurableSpawnRequestBinding",
  "assertFollowupAdmissionBinding",
  "assertMutationOwnership",
  "assertNoRecoveryCleanupFence",
  "assertWorkerProviderLaunchPreparation",
  "assertWriteExecutionJob",
  "authorizeReadyWriteWorkerDispatch",
  "authorizeWorkerProviderRotation",
  "cancelWorker",
  "cancellationNonce",
  "claimWorkerDispatch",
  "getSpawnIdempotencyRecord",
  "persistCompletedWriteArtifact",
  "prepareDispatchProcessSpawn",
  "prepareWorkerProviderSpawn",
  "prepareWriteProvisionerIntent",
  "prepareWriteProvisioningReissue",
  "projectCancellationReceipt",
  "promoteWriteWorkerReady",
  "providerLaunchState",
  "recordDispatchProcessNoChild",
  "recordOfficialWorktreeReceipt",
  "recordUnsettledProviderProcess",
  "recordUnsettledWorkerProcess",
  "recordWorkerProviderRotationNoChild",
  "recordWorkerProviderSpawnNoChild",
  "recordWriteProvisionerNoChild",
  "retainWriteProvisioningCleanupPending",
  "settleFailedDispatchCleanup",
  "settlePreProviderWorkerFinalization",
  "settleProviderStartedWorkerFinalization",
  "settleStartedWorkerLoss",
  "settleUnstartedDispatchLoss",
  "settleWriteArtifactAfterRuntimeCleanup",
  "spawnGrantedFollowupWorker",
  "spawnReadOnlyWorker",
  "transitionWorkerDispatch",
  "verifyRecoveryCleanupFence"
].sort());
const IMPLEMENTATION_CONSUMERS = Object.freeze([
  "plugins/grok/scripts/session-lifecycle-hook.mjs",
  "plugins/grok/scripts/lib/worker-dispatch-supervisor.mjs",
  "plugins/grok/scripts/lib/worker-mailbox.mjs",
  "plugins/grok/scripts/lib/worker-provisioner.mjs",
  "plugins/grok/scripts/lib/worker-recovery.mjs",
  "plugins/grok/scripts/lib/worker-runtime.mjs",
  "plugins/grok/scripts/lib/worker-service.mjs",
  "scripts/live-worker-provisioner-probe.mjs",
  "scripts/test-natural-codex.mjs"
]);
function lineCount(file) {
  return fs.readFileSync(file, "utf8").split("\n").length;
}

test("worker mutation compatibility facade preserves the exact public API", async () => {
  const facade = await import(pathToFileURL(path.join(LIB, FACADE)).href);
  assert.deepEqual(Object.keys(facade).sort(), PUBLIC_EXPORTS);
});

test("worker mutation facade and leaves retain bounded physical ownership", () => {
  assert.ok(lineCount(path.join(LIB, FACADE)) <= 300);
  for (const leaf of LEAVES) {
    assert.ok(lineCount(path.join(LIB, leaf)) <= 1500, `${leaf} exceeds 1500 lines`);
  }
});

test("implementation consumers import exact worker mutation leaves", () => {
  for (const relative of IMPLEMENTATION_CONSUMERS) {
    const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
    assert.doesNotMatch(
      source,
      /from\s+["'][^"']*worker-mutation\.mjs["']/,
      `${relative} imports the compatibility facade`
    );
  }
});
