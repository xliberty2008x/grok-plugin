import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = path.join(ROOT, "plugins", "grok", "scripts", "lib");
const FACADE = "worker-mutation.mjs";
const LEAVES = Object.freeze([
  "worker-mutation-dispatch-admission.mjs",
  "worker-mutation-dispatch-contract.mjs",
  "worker-mutation-followup-contract.mjs",
  "worker-mutation-idempotency.mjs",
  "worker-mutation-primitives.mjs",
  "worker-mutation-request-contract.mjs",
  "worker-mutation-spawn-authority.mjs",
  "worker-mutation-spawn.mjs",
  "worker-mutation-write-admission.mjs",
  "worker-mutation-write-contract.mjs",
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
const MOVED_PUBLIC_BINDINGS = Object.freeze({
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
  "worker-mutation-followup-contract.mjs": Object.freeze([
    "FOLLOWUP_ADMISSION_KIND",
    "FOLLOWUP_ADMISSION_WITNESS_SCHEMA_VERSION",
    "assertFollowupAdmissionBinding"
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
  "worker-mutation-write-admission.mjs": Object.freeze([
    "admitWriteWorkerPlan",
    "authorizeReadyWriteWorkerDispatch"
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
  ["plugins/grok/scripts/session-lifecycle-hook.mjs", "./lib/worker-mutation-primitives.mjs", ["cancellationNonce"]],
  ["plugins/grok/scripts/lib/worker-mailbox.mjs", "./worker-mutation-primitives.mjs", ["assertMutationOwnership", "cancellationNonce"]],
  ["plugins/grok/scripts/lib/worker-dispatch-supervisor.mjs", "./worker-mutation-spawn-authority.mjs", ["assertDurableSpawnRequestBinding"]],
  ["plugins/grok/scripts/lib/worker-dispatch-supervisor.mjs", "./worker-mutation-dispatch-contract.mjs", ["assertDispatchContract"]],
  ["plugins/grok/scripts/lib/worker-dispatch-supervisor.mjs", "./worker-mutation-primitives.mjs", ["FOLLOWUP_SPAWN_OWNERSHIP_MODE", "SPAWN_OWNERSHIP_MODE", "SPAWN_SUCCESS_DEFINITION"]],
  ["plugins/grok/scripts/lib/worker-provisioner.mjs", "./worker-mutation-primitives.mjs", ["assertMutationOwnership"]],
  ["plugins/grok/scripts/lib/worker-provisioner.mjs", "./worker-mutation-write-recovery.mjs", ["adoptWriteProvisioningEffect", "recordWriteProvisionerNoChild", "retainWriteProvisioningCleanupPending"]],
  ["plugins/grok/scripts/lib/worker-provisioner.mjs", "./worker-mutation-write-runtime-contract.mjs", ["assertWriteExecutionJob"]],
  ["plugins/grok/scripts/lib/worker-recovery.mjs", "./worker-mutation-dispatch-admission.mjs", ["acquireRecoveryCleanupFence", "recordWorkerProviderSpawnNoChild", "verifyRecoveryCleanupFence"]],
  ["plugins/grok/scripts/lib/worker-recovery.mjs", "./worker-mutation-dispatch-contract.mjs", ["assertDispatchContract"]],
  ["plugins/grok/scripts/lib/worker-recovery.mjs", "./worker-mutation-primitives.mjs", ["cancellationNonce"]],
  ["plugins/grok/scripts/lib/worker-runtime.mjs", "./worker-mutation-dispatch-admission.mjs", ["prepareDispatchProcessSpawn", "recordDispatchProcessNoChild"]],
  ["plugins/grok/scripts/lib/worker-runtime.mjs", "./worker-mutation-dispatch-contract.mjs", ["providerLaunchState"]],
  ["plugins/grok/scripts/lib/worker-runtime.mjs", "./worker-mutation-primitives.mjs", ["assertMutationOwnership"]],
  ["plugins/grok/scripts/lib/worker-service.mjs", "./worker-mutation-dispatch-contract.mjs", ["providerLaunchState"]],
  ["plugins/grok/scripts/lib/worker-service.mjs", "./worker-mutation-spawn.mjs", ["spawnReadOnlyWorker"]],
  ["plugins/grok/scripts/lib/worker-service.mjs", "./worker-mutation-write-admission.mjs", ["authorizeReadyWriteWorkerDispatch"]],
  ["scripts/live-worker-provisioner-probe.mjs", "../plugins/grok/scripts/lib/worker-mutation-write-admission.mjs", ["admitWriteWorkerPlan"]],
  ["scripts/live-worker-provisioner-probe.mjs", "../plugins/grok/scripts/lib/worker-mutation-write-runtime-contract.mjs", ["assertWriteExecutionJob"]],
  ["scripts/test-natural-codex.mjs", "../plugins/grok/scripts/lib/worker-mutation-dispatch-contract.mjs", ["assertDispatchContract"]]
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
  for (const leaf of LEAVES) {
    const source = fs.readFileSync(path.join(LIB, leaf), "utf8");
    assert.ok(lineCount(path.join(LIB, leaf)) <= 1500, `${leaf} exceeds 1500 lines`);
    assert.doesNotMatch(source, /from\s+["'][^"']*worker-mutation\.mjs["']/u);
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

test("the mutation monolith consumes both write contracts without redeclaring their authority", () => {
  const source = fs.readFileSync(path.join(LIB, FACADE), "utf8");
  assert.match(source, /from\s+"\.\/worker-mutation-write-contract\.mjs"/u);
  assert.match(source, /from\s+"\.\/worker-mutation-write-runtime-contract\.mjs"/u);
  assert.doesNotMatch(source, /^function assertWriteExecutionJob\b/mu);
  assert.doesNotMatch(source, /^function assertWriteProvisioningRuntime\b/mu);
});
