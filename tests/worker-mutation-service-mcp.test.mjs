import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertContextCompatible,
  assertContextManifestIntegrity,
  assertTaskEnvelope,
  buildRuntimeEvidence,
  buildTaskEnvelope,
  captureContextManifest,
  CONTEXT_METADATA_POLICIES,
  evaluateScope,
  observeChangedPaths
} from "../plugins/grok/scripts/lib/task-contract.mjs";
import {
  createWorkerAuthorization,
  launchContractDigest
} from "../plugins/grok/scripts/lib/worker-launch-contract.mjs";
import { projectWorkerSnapshot } from "../plugins/grok/scripts/lib/worker-protocol.mjs";
import {
  admitWriteWorkerPlan,
  activateWriteProvisioningAttempt,
  authorizeReadyWriteWorkerDispatch,
  assertDurableSpawnRequestBinding,
  assertWorkerProviderLaunchPreparation,
  assertWriteExecutionJob,
  adoptWriteProvisioningEffect,
  cancelWorker,
  claimWorkerDispatch,
  assertDispatchContract,
  prepareWriteProvisionerIntent,
  prepareWriteProvisioningReissue,
  prepareDispatchProcessSpawn,
  persistCompletedWriteArtifact,
  promoteWriteWorkerReady,
  projectCancellationReceipt,
  recordOfficialWorktreeReceipt,
  recordWriteProvisionerNoChild,
  retainWriteProvisioningCleanupPending,
  settleFailedDispatchCleanup,
  settlePreProviderWorkerFinalization,
  settleProviderStartedWorkerFinalization,
  settleStartedWorkerLoss,
  settleUnstartedDispatchLoss,
  settleWriteArtifactAfterRuntimeCleanup,
  spawnReadOnlyWorker,
  SPAWN_SUCCESS_DEFINITION,
  transitionWorkerDispatch
} from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import {
  assertExecutionBinding,
  assertProvisioningJournal,
  transitionProvisioningJournal
} from "../plugins/grok/scripts/lib/worker-execution-binding.mjs";
import {
  assertContextReceipt,
  assertContextReceiptShape,
  verifyJobEffectivePrompt
} from "../plugins/grok/scripts/lib/worker-context.mjs";
import { reconcileOwnedWorkers } from "../plugins/grok/scripts/lib/worker-reconcile.mjs";
import { createWorkerService } from "../plugins/grok/scripts/lib/worker-service.mjs";
import { launchCommittedWorker } from "../plugins/grok/scripts/lib/worker-runtime.mjs";
import {
  callWorkerTool,
  createMcpBrokerRuntime,
  handleMcpRequest
} from "../plugins/grok/mcp/broker.mjs";
import {
  ORDERED_TURN_BOUNDARY_MAILBOX_PROVIDER_CAPABILITY,
  ROOT_READ_PROVIDER_CAPABILITY,
  SAME_SESSION_READ_FOLLOWUP_PROVIDER_CAPABILITY
} from "../plugins/grok/scripts/lib/provider-capability.mjs";
import {
  resolveWorkerAuthority
} from "../plugins/grok/scripts/lib/worker-authority.mjs";
import { processGroupGone, processStartToken } from "../plugins/grok/scripts/lib/process-control.mjs";
import {
  createExecutableAttestation,
  createManagedObservedAttestation
} from "../plugins/grok/scripts/lib/executable-identity.mjs";
import {
  providerLaunchBindingDigest
} from "../plugins/grok/scripts/lib/provider-executable-pin.mjs";
import {
  assertWorktreeProvisioningGuardForJob,
  loadProviderGuard,
  registerProviderGuard,
  registerWorktreeProvisioningGuard,
  unregisterProviderGuard
} from "../plugins/grok/scripts/lib/recursion-guard.mjs";
import {
  cancelFile,
  generateId,
  listJobs,
  tryReadJob,
  updateJob,
  writeJob
} from "../plugins/grok/scripts/lib/state.mjs";
import {
  gitCommonDir,
  workspaceState,
  workspaceStateSegment
} from "../plugins/grok/scripts/lib/workspace.mjs";
import {
  createWorkerWorktree,
  workerWorktreeSlug
} from "../plugins/grok/scripts/lib/worker-worktree.mjs";
import { provisionWriteWorkerWorktree } from "../plugins/grok/scripts/lib/worker-provisioner.mjs";
import { installFakeGrok } from "./fake-grok.mjs";
import {
  git,
  initRepo,
  run,
  runCompanion,
  tempDir,
  testEnvironment,
  waitFor
} from "./helpers.mjs";
import {
  THREAD,
  THREAD_B,
  TEST_DIR,
  MUTATION_MODULE,
  TASK_CONTRACT_MODULE,
  TEST_EXECUTABLE_IDENTITY,
  TEST_MANAGED_EXECUTABLE_IDENTITY,
  runIsolatedModule,
  lastJson,
  principal,
  brokerPrincipal,
  envFor,
  cancelIdempotencyFile,
  spawnIdempotencyFile,
  canonicalize,
  stableDigest,
  rebindWorkerLaunchAuthorization,
  legacyContextManifest,
  spawnResponseWitnessBody,
  refreshSpawnWitnessId,
  providerGuardFile,
  plannedWriteProvisioningFixture,
  plannedWriteVerticalFixture,
  detachedProvisioner,
  detachedDispatchProcess,
  claimedReadDispatchFixture,
  workerStartedReadDispatchFixture,
  providerStartedReadDispatchFixture,
  prepareProvisioningIntent,
  activateRegisteredProvisioning,
  readyManagedWriteDispatchFixture,
  cleanupPendingAbsentProvisioning,
  loadWorkerProvisionerWithProviderSeam,
  controllerEnvironmentSeam,
} from "./worker-mutation-test-support.mjs";

test("MCP worker_spawn and worker_cancel drive real service functions", async () => {
  const root = initRepo();
  const { env } = envFor(root);
  const auth = principal(root);
  const providerLaunchBinding = {
    schemaVersion: 1,
    pinRef: `gpin-${"1".repeat(32)}`,
    pinRecordDigest: "2".repeat(64),
    executableIdentityDigest: "3".repeat(64),
    releaseIdentityDigest: "4".repeat(64)
  };
  const providerCapabilityReceipt = {
    capabilityDigest: "d".repeat(64),
    providerLaunchBinding,
    providerLaunchBindingDigest:
      providerLaunchBindingDigest(providerLaunchBinding),
    capabilities: [
      ROOT_READ_PROVIDER_CAPABILITY,
      SAME_SESSION_READ_FOLLOWUP_PROVIDER_CAPABILITY,
      ORDERED_TURN_BOUNDARY_MAILBOX_PROVIDER_CAPABILITY
    ]
  };
  const runtime = createMcpBrokerRuntime({
    providerCapabilityReceipt
  });
  const options = {
    runtime,
    readProviderCapabilityReceipt: () => providerCapabilityReceipt,
    resolveAuthority: () => auth,
    env,
    createService: (serviceOptions) => createWorkerService({
      root,
      principal: auth,
      env,
      launchWorker: () => ({ providerLaunchState: "pending", providerLaunched: false }),
      providerCapabilityDigest: serviceOptions.providerCapabilityDigest,
      providerLaunchBinding: serviceOptions.providerLaunchBinding,
      providerLaunchBindingDigest:
        serviceOptions.providerLaunchBindingDigest
    })
  };
  const spawned = await callWorkerTool({
    name: "worker_spawn",
    arguments: {
      idempotencyKey: "mcp-spawn-00000001",
      userRequest: "List top-level files"
    }
  }, options);
  assert.equal(spawned.structuredContent.ok, true);
  assert.equal(spawned.structuredContent.providerLaunched, false);
  assert.ok(spawned.structuredContent.worker.id);
  assert.equal(tryReadJob(root, spawned.structuredContent.worker.id, env).write, false);

  const again = await callWorkerTool({
    name: "worker_spawn",
    arguments: {
      idempotencyKey: "mcp-spawn-00000001",
      userRequest: "List top-level files"
    }
  }, options);
  assert.equal(again.structuredContent.replayed, true);
  assert.equal(again.structuredContent.worker.id, spawned.structuredContent.worker.id);

  const writeRejected = await callWorkerTool({
    name: "worker_spawn",
    arguments: {
      idempotencyKey: "mcp-spawn-write-0001",
      userRequest: "Edit something",
      write: true
    }
  }, options);
  assert.equal(writeRejected.isError, true);
  assert.equal(writeRejected.structuredContent.error.code, "E_USAGE");

  const cancelled = await callWorkerTool({
    name: "worker_cancel",
    arguments: {
      id: spawned.structuredContent.worker.id,
      idempotencyKey: "mcp-cancel-00000001"
    }
  }, options);
  assert.equal(cancelled.structuredContent.ok, true);
  assert.ok(cancelled.structuredContent.receipt.receiptId);

  const cancelAgain = await callWorkerTool({
    name: "worker_cancel",
    arguments: {
      id: spawned.structuredContent.worker.id,
      idempotencyKey: "mcp-cancel-00000001"
    }
  }, options);
  assert.equal(cancelAgain.structuredContent.replayed, true);

  const listed = await callWorkerTool({ name: "worker_list_owned", arguments: {} }, options);
  assert.ok(listed.structuredContent.workers.some((worker) => worker.id === spawned.structuredContent.worker.id));
});

test("low-level spawn rejects a second provider launch lifecycle before durable commit", () => {
  const root = initRepo();
  const { env } = envFor(root);
  assert.throws(
    () => spawnReadOnlyWorker({
        root,
        principal: principal(root),
        envelope: buildTaskEnvelope({ userRequest: "Reject split launch", mode: "read" }),
        idempotencyKey: "spawn-split-launch-0001",
        env,
        providerLaunch: () => ({ providerLaunched: true })
      }),
    (error) => error?.code === "E_CAPABILITY"
  );
  assert.equal(listJobs(root, env).length, 0);
});
