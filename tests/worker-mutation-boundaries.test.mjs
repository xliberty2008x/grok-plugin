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
  "interruptWorker",
  "claimWorkerDispatch",
  "getSpawnIdempotencyRecord",
  "persistCompletedWriteArtifact",
  "prepareDispatchProcessSpawn",
  "prepareWorkerProviderSpawn",
  "prepareWriteProvisionerIntent",
  "prepareWriteProvisioningReissue",
  "projectCancellationReceipt",
  "projectInterruptReceipt",
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
const MOVED_PUBLIC_BINDINGS = Object.freeze({
  "worker-mutation-cancellation.mjs": Object.freeze([
    "CANCEL_METRIC_TIMESTAMPS",
    "cancelWorker",
    "interruptWorker",
    "projectCancellationReceipt",
    "projectInterruptReceipt"
  ]),
  "worker-mutation-dispatch-admission.mjs": Object.freeze([
    "acquireRecoveryCleanupFence",
    "prepareDispatchProcessSpawn",
    "prepareWorkerProviderSpawn",
    "recordDispatchProcessNoChild",
    "recordWorkerProviderSpawnNoChild",
    "verifyRecoveryCleanupFence"
  ]),
  "worker-mutation-dispatch-contract.mjs": Object.freeze([
    "PROVIDER_ROTATION_INTENT_SCHEMA_VERSION",
    "PROVIDER_SPAWN_INTENT_SCHEMA_VERSION",
    "RECOVERY_CLEANUP_FENCE_SCHEMA_VERSION",
    "WORKER_DISPATCH_SCHEMA_VERSION",
    "WORKER_SPAWN_INTENT_SCHEMA_VERSION",
    "assertDispatchContract",
    "assertNoRecoveryCleanupFence",
    "providerLaunchState"
  ]),
  "worker-mutation-dispatch-transition.mjs": Object.freeze([
    "authorizeWorkerProviderRotation",
    "claimWorkerDispatch",
    "recordUnsettledProviderProcess",
    "recordUnsettledWorkerProcess",
    "recordWorkerProviderRotationNoChild",
    "transitionWorkerDispatch"
  ]),
  "worker-mutation-followup-contract.mjs": Object.freeze([
    "FOLLOWUP_ADMISSION_KIND",
    "FOLLOWUP_ADMISSION_WITNESS_SCHEMA_VERSION",
    "assertFollowupAdmissionBinding"
  ]),
  "worker-mutation-followup.mjs": Object.freeze([
    "spawnGrantedFollowupWorker"
  ]),
  "worker-mutation-idempotency.mjs": Object.freeze([
    "getSpawnIdempotencyRecord"
  ]),
  "worker-mutation-primitives.mjs": Object.freeze([
    "FOLLOWUP_SPAWN_OWNERSHIP_MODE",
    "SPAWN_OWNERSHIP_MODE",
    "SPAWN_SUCCESS_DEFINITION",
    "assertMutationOwnership",
    "cancellationNonce"
  ]),
  "worker-mutation-spawn-authority.mjs": Object.freeze([
    "assertDurableSpawnRequestBinding",
    "assertWorkerProviderLaunchPreparation"
  ]),
  "worker-mutation-spawn.mjs": Object.freeze([
    "spawnReadOnlyWorker"
  ]),
  "worker-mutation-terminal.mjs": Object.freeze([
    "persistCompletedWriteArtifact",
    "settleFailedDispatchCleanup",
    "settlePreProviderWorkerFinalization",
    "settleProviderStartedWorkerFinalization",
    "settleStartedWorkerLoss",
    "settleUnstartedDispatchLoss",
    "settleWriteArtifactAfterRuntimeCleanup"
  ]),
  "worker-mutation-write-admission.mjs": Object.freeze([
    "admitWriteWorkerPlan",
    "authorizeReadyWriteWorkerDispatch"
  ]),
  "worker-mutation-write-provisioning.mjs": Object.freeze([
    "activateWriteProvisioningAttempt",
    "prepareWriteProvisionerIntent",
    "prepareWriteProvisioningReissue",
    "promoteWriteWorkerReady",
    "recordOfficialWorktreeReceipt"
  ]),
  "worker-mutation-write-recovery.mjs": Object.freeze([
    "adoptWriteProvisioningEffect",
    "recordWriteProvisionerNoChild",
    "retainWriteProvisioningCleanupPending"
  ]),
  "worker-mutation-write-runtime-contract.mjs": Object.freeze([
    "assertWriteExecutionJob"
  ])
});
const DIRECT_IMPORTS = Object.freeze([
  ["plugins/grok/scripts/lib/companion-shared.mjs", "./worker-mutation-dispatch-contract.mjs", ["assertDispatchContract"]],
  ["plugins/grok/scripts/lib/companion-shared.mjs", "./worker-mutation-dispatch-transition.mjs", ["recordWorkerProviderRotationNoChild", "recordUnsettledProviderProcess", "transitionWorkerDispatch"]],
  ["plugins/grok/scripts/lib/companion-shared.mjs", "./worker-mutation-spawn-authority.mjs", ["assertWorkerProviderLaunchPreparation"]],
  ["plugins/grok/scripts/lib/companion-status.mjs", "./worker-mutation-cancellation.mjs", ["cancelWorker"]],
  ["plugins/grok/scripts/lib/companion-status.mjs", "./worker-mutation-primitives.mjs", ["cancellationNonce"]],
  ["plugins/grok/scripts/lib/companion-task-executor.mjs", "./worker-mutation-dispatch-contract.mjs", ["assertDispatchContract"]],
  ["plugins/grok/scripts/lib/companion-task-finalization.mjs", "./worker-mutation-terminal.mjs", ["settlePreProviderWorkerFinalization", "settleProviderStartedWorkerFinalization"]],
  ["plugins/grok/scripts/lib/companion-task-result.mjs", "./worker-mutation-dispatch-transition.mjs", ["authorizeWorkerProviderRotation"]],
  ["plugins/grok/scripts/lib/companion-task-turn.mjs", "./worker-mutation-dispatch-admission.mjs", ["prepareWorkerProviderSpawn", "recordWorkerProviderSpawnNoChild"]],
  ["plugins/grok/scripts/lib/companion-task-turn.mjs", "./worker-mutation-dispatch-contract.mjs", ["assertDispatchContract"]],
  ["plugins/grok/scripts/lib/companion-worker-launcher.mjs", "./worker-mutation-dispatch-admission.mjs", ["prepareDispatchProcessSpawn", "recordDispatchProcessNoChild"]],
  ["plugins/grok/scripts/lib/companion-worker-launcher.mjs", "./worker-mutation-dispatch-contract.mjs", ["assertDispatchContract"]],
  ["plugins/grok/scripts/lib/companion-worker-launcher.mjs", "./worker-mutation-dispatch-transition.mjs", ["recordUnsettledWorkerProcess", "transitionWorkerDispatch"]],
  ["plugins/grok/scripts/session-lifecycle-hook.mjs", "./lib/worker-mutation-primitives.mjs", ["cancellationNonce"]],
  ["plugins/grok/scripts/lib/worker-mailbox.mjs", "./worker-mutation-primitives.mjs", ["assertMutationOwnership", "cancellationNonce"]],
  ["plugins/grok/scripts/lib/worker-mailbox.mjs", "./worker-mutation-followup.mjs", ["spawnGrantedFollowupWorker"]],
  ["plugins/grok/scripts/lib/worker-dispatch-supervisor.mjs", "./worker-mutation-spawn-authority.mjs", ["assertDurableSpawnRequestBinding"]],
  ["plugins/grok/scripts/lib/worker-dispatch-supervisor.mjs", "./worker-mutation-dispatch-contract.mjs", ["assertDispatchContract"]],
  ["plugins/grok/scripts/lib/worker-dispatch-supervisor.mjs", "./worker-mutation-primitives.mjs", ["FOLLOWUP_SPAWN_OWNERSHIP_MODE", "SPAWN_OWNERSHIP_MODE", "SPAWN_SUCCESS_DEFINITION"]],
  ["plugins/grok/scripts/lib/worker-provisioner.mjs", "./worker-mutation-primitives.mjs", ["assertMutationOwnership"]],
  ["plugins/grok/scripts/lib/worker-provisioner.mjs", "./worker-mutation-write-provisioning.mjs", ["activateWriteProvisioningAttempt", "prepareWriteProvisionerIntent", "prepareWriteProvisioningReissue", "promoteWriteWorkerReady", "recordOfficialWorktreeReceipt"]],
  ["plugins/grok/scripts/lib/worker-provisioner.mjs", "./worker-mutation-write-recovery.mjs", ["adoptWriteProvisioningEffect", "recordWriteProvisionerNoChild", "retainWriteProvisioningCleanupPending"]],
  ["plugins/grok/scripts/lib/worker-provisioner.mjs", "./worker-mutation-write-runtime-contract.mjs", ["assertWriteExecutionJob"]],
  ["plugins/grok/scripts/lib/worker-recovery.mjs", "./worker-mutation-dispatch-admission.mjs", ["acquireRecoveryCleanupFence", "recordWorkerProviderSpawnNoChild", "verifyRecoveryCleanupFence"]],
  ["plugins/grok/scripts/lib/worker-recovery.mjs", "./worker-mutation-dispatch-contract.mjs", ["assertDispatchContract"]],
  ["plugins/grok/scripts/lib/worker-recovery.mjs", "./worker-mutation-dispatch-transition.mjs", ["transitionWorkerDispatch"]],
  ["plugins/grok/scripts/lib/worker-recovery.mjs", "./worker-mutation-primitives.mjs", ["cancellationNonce"]],
  ["plugins/grok/scripts/lib/worker-recovery.mjs", "./worker-mutation-terminal.mjs", ["settleFailedDispatchCleanup", "settleStartedWorkerLoss", "settleUnstartedDispatchLoss"]],
  ["plugins/grok/scripts/lib/worker-runtime.mjs", "./worker-mutation-dispatch-admission.mjs", ["prepareDispatchProcessSpawn", "recordDispatchProcessNoChild"]],
  ["plugins/grok/scripts/lib/worker-runtime.mjs", "./worker-mutation-dispatch-contract.mjs", ["providerLaunchState"]],
  ["plugins/grok/scripts/lib/worker-runtime.mjs", "./worker-mutation-dispatch-transition.mjs", ["claimWorkerDispatch", "transitionWorkerDispatch"]],
  ["plugins/grok/scripts/lib/worker-runtime.mjs", "./worker-mutation-primitives.mjs", ["assertMutationOwnership"]],
  ["plugins/grok/scripts/lib/worker-service.mjs", "./worker-mutation-dispatch-contract.mjs", ["providerLaunchState"]],
  ["plugins/grok/scripts/lib/worker-service.mjs", "./worker-mutation-cancellation.mjs", ["cancelWorker", "interruptWorker", "projectCancellationReceipt", "projectInterruptReceipt"]],
  ["plugins/grok/scripts/lib/worker-service.mjs", "./worker-mutation-spawn.mjs", ["spawnReadOnlyWorker"]],
  ["plugins/grok/scripts/lib/worker-service.mjs", "./worker-mutation-write-admission.mjs", ["authorizeReadyWriteWorkerDispatch"]],
  ["scripts/live-worker-provisioner-probe.mjs", "../plugins/grok/scripts/lib/worker-mutation-write-admission.mjs", ["admitWriteWorkerPlan"]],
  ["scripts/live-worker-provisioner-probe.mjs", "../plugins/grok/scripts/lib/worker-mutation-write-runtime-contract.mjs", ["assertWriteExecutionJob"]],
  ["scripts/test-natural-codex.mjs", "../plugins/grok/scripts/lib/worker-mutation-dispatch-contract.mjs", ["assertDispatchContract"]]
]);
const IMPLEMENTATION_CONSUMERS = Object.freeze([
  "plugins/grok/scripts/lib/companion-shared.mjs",
  "plugins/grok/scripts/lib/companion-status.mjs",
  "plugins/grok/scripts/lib/companion-task-executor.mjs",
  "plugins/grok/scripts/lib/companion-task-finalization.mjs",
  "plugins/grok/scripts/lib/companion-task-result.mjs",
  "plugins/grok/scripts/lib/companion-task-turn.mjs",
  "plugins/grok/scripts/lib/companion-worker-launcher.mjs",
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

function namedImports(source, specifier) {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(
    `import\\s*\\{([^}]*)\\}\\s*from\\s*["']${escaped}["']`,
    "u"
  ));
  return match
    ? match[1].split(",").map((name) => name.trim()).filter(Boolean)
    : [];
}

test("worker mutation compatibility surface preserves all 54 exports and moved identity", async () => {
  const facade = await import(pathToFileURL(path.join(LIB, FACADE)).href);
  assert.deepEqual(Object.keys(facade).sort(), PUBLIC_EXPORTS);
  for (const [leaf, names] of Object.entries(MOVED_PUBLIC_BINDINGS)) {
    const domain = await import(pathToFileURL(path.join(LIB, leaf)).href);
    for (const name of names) {
      assert.equal(facade[name], domain[name], `${name} lost referential identity`);
    }
  }
});

test("extracted mutation domains are bounded leaves and never import the mutation monolith", () => {
  const facade = fs.readFileSync(path.join(LIB, FACADE), "utf8");
  assert.ok(lineCount(path.join(LIB, FACADE)) <= 300, `${FACADE} exceeds 300 lines`);
  assert.doesNotMatch(facade, /^(?:export\s+)?(?:async\s+)?function\b|^(?:export\s+)?const\b/mu);
  for (const leaf of LEAVES) {
    const source = fs.readFileSync(path.join(LIB, leaf), "utf8");
    assert.ok(lineCount(path.join(LIB, leaf)) <= 1500, `${leaf} exceeds 1500 lines`);
    assert.doesNotMatch(source, /from\s+["'][^"']*worker-mutation\.mjs["']/u);
  }
});

test("implementation consumers bypass the compatibility facade", () => {
  for (const relative of IMPLEMENTATION_CONSUMERS) {
    const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
    assert.doesNotMatch(
      source,
      /from\s+["'][^"']*worker-mutation\.mjs["']/u,
      `${relative} imports the compatibility facade`
    );
  }
});

test("selected implementation consumers import extracted contracts directly", () => {
  for (const [relative, specifier, names] of DIRECT_IMPORTS) {
    const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
    const direct = namedImports(source, specifier);
    for (const name of names) {
      assert.ok(direct.includes(name), `${relative} does not import ${name} from ${specifier}`);
      const facadeImports = namedImports(
        source,
        relative.startsWith("plugins/grok/scripts/lib/")
          ? "./worker-mutation.mjs"
          : relative.startsWith("plugins/grok/scripts/")
            ? "./lib/worker-mutation.mjs"
            : "../plugins/grok/scripts/lib/worker-mutation.mjs"
      );
      assert.ok(!facadeImports.includes(name), `${relative} still imports moved ${name} from the monolith`);
    }
  }
});

test("the extracted provisioning domain consumes write contracts without redeclaring authority", () => {
  const facade = fs.readFileSync(path.join(LIB, FACADE), "utf8");
  const provisioning = fs.readFileSync(
    path.join(LIB, "worker-mutation-write-provisioning.mjs"),
    "utf8"
  );
  assert.doesNotMatch(facade, /from\s+"\.\/worker-mutation-write-contract\.mjs"/u);
  assert.match(provisioning, /from\s+"\.\/worker-mutation-write-contract\.mjs"/u);
  assert.match(provisioning, /from\s+"\.\/worker-mutation-write-runtime-contract\.mjs"/u);
  assert.doesNotMatch(provisioning, /^function assertWriteExecutionJob\b/mu);
  assert.doesNotMatch(provisioning, /^function assertWriteProvisioningRuntime\b/mu);
});
