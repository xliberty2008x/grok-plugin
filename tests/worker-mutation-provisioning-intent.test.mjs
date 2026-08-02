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

test("write spawn is rejected until allowWriteSpawn is enabled", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({ userRequest: "Edit file", mode: "write" });
  assert.throws(
    () => spawnReadOnlyWorker({
      root,
      principal: principal(root),
      envelope,
      idempotencyKey: "spawn-write-0001",
      write: true,
      env
    }),
    (error) => error?.code === "E_CAPABILITY"
  );
});

test("write provisioner intent is private, idempotent, fenced, and exactly settles without a child", () => {
  const fixture = plannedWriteProvisioningFixture("intent-no-child");
  const prepared = prepareProvisioningIntent(fixture);
  assert.equal(prepared.prepared, true);
  assert.equal(prepared.replayed, false);
  assert.equal(prepared.intent.status, "pending");
  assert.equal(prepared.intent.intentId, prepared.intent.providerSpawnIntentId);
  assert.match(prepared.intent.intentId, /^[a-f0-9]{32}$/);
  assert.equal(prepared.intent.executionBindingDigest, fixture.binding.bindingDigest);
  assert.equal(prepared.intent.expectedPlannedJournalDigest, fixture.journal.journalDigest);
  assert.equal(prepared.intent.processIdentity, null);

  const pending = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  assert.equal(pending.phase, "provisioning-intent-prepared");
  assert.equal(pending.provisioning.state, "planned");
  assert.equal(pending.provisioningRuntime.intent.intentId, prepared.intent.intentId);
  assert.equal(Object.hasOwn(pending.request.spawn, "providerSpawnIntent"), false);
  assert.equal(Object.hasOwn(pending.request.spawn, "dispatch"), false);
  assert.equal(Object.hasOwn(pending, "workerAuthorization"), false);
  assert.doesNotThrow(() => assertWriteExecutionJob(pending, fixture.env));

  const replay = prepareProvisioningIntent(fixture);
  assert.equal(replay.prepared, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.intent.intentId, prepared.intent.intentId);
  assert.equal(replay.intent.operationId, prepared.intent.operationId);
  assert.equal(
    tryReadJob(fixture.root, fixture.workerId, fixture.env).lifecycleEvents.length,
    pending.lifecycleEvents.length
  );

  for (const stale of [
    { attemptId: "d".repeat(32) },
    { fence: 2 },
    { holderId: "e".repeat(32) },
    { executionBindingDigest: "f".repeat(64) },
    { expectedJournalDigest: "0".repeat(64) }
  ]) {
    assert.throws(
      () => prepareWriteProvisionerIntent({
        root: fixture.root,
        principal: principal(fixture.root),
        workerId: fixture.workerId,
        executionBindingDigest: fixture.binding.bindingDigest,
        expectedJournalDigest: fixture.journal.journalDigest,
        ...fixture.actor,
        ...stale,
        env: fixture.env
      }),
      (error) => ["E_STATE", "E_PROCESS_IDENTITY"].includes(error?.code)
    );
  }

  const failedAt = new Date(
    Math.max(Date.now(), Date.parse(prepared.intent.preparedAt) + 1)
  ).toISOString();
  const settled = recordWriteProvisionerNoChild({
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: fixture.journal.journalDigest,
    ...fixture.actor,
    providerSpawnIntentId: prepared.intent.intentId,
    resolution: "spawn-not-created",
    processIdentity: null,
    cleanupProof: null,
    failedAt,
    env: fixture.env
  });
  assert.equal(settled.settled, true);
  assert.equal(settled.replayed, false);
  assert.equal(settled.job.status, "failed");
  assert.equal(settled.job.phase, "provisioning-failed");
  assert.equal(settled.job.provisioning.state, "failed");
  assert.equal(settled.job.provisioningRuntime.intent.status, "no-child");
  assert.equal(settled.job.request.spawn.providerLaunchOutcome, "not-launched");
  assert.equal(Object.hasOwn(settled.job.request.spawn, "dispatch"), false);
  assert.doesNotThrow(() => assertWriteExecutionJob(settled.job, fixture.env));

  const settledReplay = recordWriteProvisionerNoChild({
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: fixture.journal.journalDigest,
    ...fixture.actor,
    providerSpawnIntentId: prepared.intent.intentId,
    resolution: "spawn-not-created",
    processIdentity: null,
    cleanupProof: null,
    failedAt,
    env: fixture.env
  });
  assert.equal(settledReplay.settled, false);
  assert.equal(settledReplay.replayed, true);
});

test("managed-observed schema v2 survives durable write-provisioning admission", () => {
  const fixture = plannedWriteProvisioningFixture("managed-v2-intent");
  fixture.actor = {
    ...fixture.actor,
    executableIdentity: TEST_MANAGED_EXECUTABLE_IDENTITY
  };
  const prepared = prepareProvisioningIntent(fixture);
  assert.equal(prepared.intent.executableIdentity.schemaVersion, 2);
  assert.equal(
    prepared.intent.executableIdentity.releaseRecognition,
    "managed-observed"
  );
  const stored = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  assert.doesNotThrow(() => assertWriteExecutionJob(stored, fixture.env));
  assert.equal(
    stored.provisioningRuntime.intent.executableIdentity.identityDigest,
    TEST_MANAGED_EXECUTABLE_IDENTITY.identityDigest
  );
});

test("planned preactivation cleanup records one transient process proof without activation authority", {
  skip: process.platform === "win32"
}, async (t) => {
  const fixture = plannedWriteProvisioningFixture("preactivation-cleanup");
  const prepared = prepareProvisioningIntent(fixture);
  const { child, identity } = await detachedProvisioner(t, fixture.workerId);
  process.kill(-child.pid, "SIGKILL");
  await waitFor(() => processGroupGone(identity), {
    timeoutMs: 5_000,
    intervalMs: 25
  });

  const observedAt = new Date(
    Math.max(Date.now(), Date.parse(prepared.intent.preparedAt) + 1)
  ).toISOString();
  const cleanupProof = {
    processIdentity: identity,
    processGroupGone: true,
    providerGuardAbsent: true,
    observedAt
  };
  const request = {
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: fixture.journal.journalDigest,
    ...fixture.actor,
    providerSpawnIntentId: prepared.intent.intentId,
    resolution: "preactivation-cleanup-proven",
    processIdentity: identity,
    cleanupProof,
    failedAt: observedAt,
    env: fixture.env
  };
  const settled = recordWriteProvisionerNoChild(request);
  assert.equal(settled.settled, true);
  assert.equal(settled.replayed, false);
  assert.equal(settled.job.status, "failed");
  assert.equal(settled.job.phase, "provisioning-failed");
  assert.equal(settled.job.provisioning.state, "failed");
  assert.equal(
    settled.job.provisioning.previousJournalDigest,
    fixture.journal.journalDigest
  );
  assert.equal(settled.job.provisioningRuntime.intent.status, "no-child");
  assert.equal(
    settled.job.provisioningRuntime.intent.resolution,
    "preactivation-cleanup-proven"
  );
  assert.equal(settled.job.provisioningRuntime.intent.processIdentity, null);
  assert.equal(settled.job.provisioningRuntime.intent.activatedAt, null);
  assert.equal(settled.job.provisioningRuntime.activatedJournalDigest, null);
  assert.equal(settled.job.provisioningRuntime.activationDigest, null);
  assert.deepEqual(
    settled.job.provisioningRuntime.cleanupProof.processIdentity,
    identity
  );
  assert.equal(settled.job.provisioningRuntime.cleanupProof.processGroupGone, true);
  assert.equal(settled.job.provisioningRuntime.cleanupProof.providerGuardAbsent, true);
  for (const forbidden of [
    "workerAuthorization",
    "controllerProcess",
    "workerProcess",
    "providerProcess",
    "grokSessionId"
  ]) {
    assert.equal(Object.hasOwn(settled.job, forbidden), false, forbidden);
  }
  assert.equal(Object.hasOwn(settled.job.request.spawn, "dispatch"), false);
  assert.doesNotThrow(() => assertWriteExecutionJob(settled.job, fixture.env));

  const replay = recordWriteProvisionerNoChild(request);
  assert.equal(replay.settled, false);
  assert.equal(replay.replayed, true);
  assert.equal(
    replay.job.provisioningRuntime.cleanupProof.proofDigest,
    settled.job.provisioningRuntime.cleanupProof.proofDigest
  );

  assert.throws(
    () => recordWriteProvisionerNoChild({
      ...request,
      processIdentity: {
        ...identity,
        startToken: `${identity.startToken}-forged`
      }
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  const changedObservedAt = new Date(Date.parse(observedAt) + 1).toISOString();
  assert.throws(
    () => recordWriteProvisionerNoChild({
      ...request,
      cleanupProof: {
        ...cleanupProof,
        observedAt: changedObservedAt
      }
    }),
    (error) => error?.code === "E_STATE"
  );

  for (const tamper of [
    (job) => { job.provisioningRuntime.cleanupProof.processGroupGone = false; },
    (job) => {
      job.provisioningRuntime.cleanupProof.processIdentity.startToken =
        `${identity.startToken}-forged`;
    },
    (job) => { job.provisioningRuntime.activationDigest = "0".repeat(64); },
    (job) => { job.provisioningRuntime.intent.processIdentity = identity; }
  ]) {
    const corrupted = structuredClone(settled.job);
    tamper(corrupted);
    assert.throws(
      () => assertWriteExecutionJob(corrupted, fixture.env),
      (error) => ["E_STATE", "E_PROCESS_IDENTITY"].includes(error?.code)
    );
  }
});

test("preactivation cleanup rejects live groups, mismatched proof, present guards, and provisioning journals", {
  skip: process.platform === "win32"
}, async (t) => {
  const fixture = plannedWriteProvisioningFixture("preactivation-reject");
  const prepared = prepareProvisioningIntent(fixture);
  const { child, identity } = await detachedProvisioner(t, fixture.workerId);
  const observedAt = new Date(
    Math.max(Date.now(), Date.parse(prepared.intent.preparedAt) + 1)
  ).toISOString();
  const cleanupProof = {
    processIdentity: identity,
    processGroupGone: true,
    providerGuardAbsent: true,
    observedAt
  };
  const request = {
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: fixture.journal.journalDigest,
    ...fixture.actor,
    providerSpawnIntentId: prepared.intent.intentId,
    resolution: "preactivation-cleanup-proven",
    processIdentity: identity,
    cleanupProof,
    failedAt: observedAt,
    env: fixture.env
  };

  assert.throws(
    () => recordWriteProvisionerNoChild(request),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  assert.throws(
    () => recordWriteProvisionerNoChild({
      ...request,
      cleanupProof: { ...cleanupProof, processGroupGone: false }
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  assert.throws(
    () => recordWriteProvisionerNoChild({
      ...request,
      cleanupProof: {
        ...cleanupProof,
        processIdentity: {
          ...identity,
          startToken: `${identity.startToken}-forged`
        }
      }
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );

  process.kill(-child.pid, "SIGKILL");
  await waitFor(() => processGroupGone(identity), {
    timeoutMs: 5_000,
    intervalMs: 25
  });
  registerProviderGuard(fixture.root, fixture.workerId, identity, THREAD);
  t.after(() => {
    try { unregisterProviderGuard(fixture.root, fixture.workerId); } catch {}
  });
  assert.throws(
    () => recordWriteProvisionerNoChild(request),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  unregisterProviderGuard(fixture.root, fixture.workerId);

  const provisioningFixture = plannedWriteProvisioningFixture(
    "preactivation-provisioning-reject"
  );
  const active = await activateRegisteredProvisioning(t, provisioningFixture);
  process.kill(-active.child.pid, "SIGKILL");
  await waitFor(() => processGroupGone(active.identity), {
    timeoutMs: 5_000,
    intervalMs: 25
  });
  const activeObservedAt = new Date(
    Math.max(Date.now(), Date.parse(active.registeredAt) + 1)
  ).toISOString();
  assert.throws(
    () => recordWriteProvisionerNoChild({
      root: provisioningFixture.root,
      principal: principal(provisioningFixture.root),
      workerId: provisioningFixture.workerId,
      executionBindingDigest: provisioningFixture.binding.bindingDigest,
      expectedJournalDigest: active.activated.job.provisioning.journalDigest,
      ...provisioningFixture.actor,
      providerSpawnIntentId: active.prepared.intent.intentId,
      resolution: "preactivation-cleanup-proven",
      processIdentity: active.identity,
      cleanupProof: {
        processIdentity: active.identity,
        processGroupGone: true,
        providerGuardAbsent: true,
        observedAt: activeObservedAt
      },
      failedAt: activeObservedAt,
      env: provisioningFixture.env
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
});

test("write provisioner activation persists the exact detached identity and cleanup-fenced failure", {
  skip: process.platform === "win32"
}, async (t) => {
  const fixture = plannedWriteProvisioningFixture("activate-cleanup");
  const prepared = prepareProvisioningIntent(fixture);
  const { child, identity } = await detachedProvisioner(t, fixture.workerId);
  const provisioningAt = new Date(
    Math.max(Date.now(), Date.parse(prepared.intent.preparedAt) + 1)
  ).toISOString();
  const leaseExpiresAt = new Date(Date.parse(provisioningAt) + 60_000).toISOString();
  const activateRequest = {
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: fixture.journal.journalDigest,
    ...fixture.actor,
    providerSpawnIntentId: prepared.intent.intentId,
    processIdentity: identity,
    provisioningAt,
    leaseExpiresAt,
    env: fixture.env
  };
  const activated = activateWriteProvisioningAttempt(activateRequest);
  assert.equal(activated.activated, true);
  assert.equal(activated.replayed, false);
  assert.deepEqual(activated.intent.processIdentity, identity);
  assert.equal(activated.job.provisioning.state, "provisioning");
  assert.equal(activated.job.provisioning.provisioner.pid, identity.pid);
  assert.equal(activated.job.provisioning.provisioner.startToken, identity.startToken);
  assert.equal(activated.job.provisioning.provisioner.holderId, fixture.actor.holderId);
  assert.equal(activated.job.provisioningRuntime.activatedJournalDigest, activated.job.provisioning.journalDigest);
  assert.equal(Object.hasOwn(activated.job.request.spawn, "dispatch"), false);

  const replay = activateWriteProvisioningAttempt(activateRequest);
  assert.equal(replay.activated, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.intent.processIdentity, identity);

  assert.throws(
    () => activateWriteProvisioningAttempt({
      ...activateRequest,
      holderId: "c".repeat(32)
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  assert.throws(
    () => activateWriteProvisioningAttempt({
      ...activateRequest,
      processIdentity: { ...identity, startToken: `${identity.startToken}-forged` }
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );

  process.kill(-child.pid, "SIGKILL");
  await waitFor(() => processGroupGone(identity), {
    timeoutMs: 5_000,
    intervalMs: 25
  });
  const observedAt = new Date(
    Math.max(Date.now(), Date.parse(provisioningAt) + 1)
  ).toISOString();
  assert.throws(
    () => recordWriteProvisionerNoChild({
      root: fixture.root,
      principal: principal(fixture.root),
      workerId: fixture.workerId,
      executionBindingDigest: fixture.binding.bindingDigest,
      expectedJournalDigest: activated.job.provisioning.journalDigest,
      ...fixture.actor,
      providerSpawnIntentId: prepared.intent.intentId,
      resolution: "cleanup-proven",
      processIdentity: identity,
      cleanupProof: {
        processIdentity: identity,
        processGroupGone: true,
        providerGuardAbsent: true,
        observedAt
      },
      failedAt: provisioningAt,
      env: fixture.env
    }),
    (error) => error?.code === "E_STATE"
  );
  const settled = recordWriteProvisionerNoChild({
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: activated.job.provisioning.journalDigest,
    ...fixture.actor,
    providerSpawnIntentId: prepared.intent.intentId,
    resolution: "cleanup-proven",
    processIdentity: identity,
    cleanupProof: {
      processIdentity: identity,
      processGroupGone: true,
      providerGuardAbsent: true,
      observedAt
    },
    failedAt: observedAt,
    env: fixture.env
  });
  assert.equal(settled.job.status, "failed");
  assert.equal(settled.job.provisioning.state, "failed");
  assert.equal(settled.job.provisioning.cleanupPendingAt, observedAt);
  assert.equal(settled.job.provisioning.failedAt, observedAt);
  assert.equal(settled.job.provisioningRuntime.cleanupProof.processGroupGone, true);
  assert.equal(settled.job.provisioningRuntime.cleanupProof.providerGuardAbsent, true);
  assert.equal(settled.job.provisioningRuntime.intent.status, "no-child");
  assert.equal(Object.hasOwn(settled.job, "providerProcess"), false);
  assert.doesNotThrow(() => assertWriteExecutionJob(settled.job, fixture.env));
});

test("cleanup-pending retention preserves a known official receipt without launch or worktree-cleaned authority", {
  skip: process.platform === "win32"
}, async (t) => {
  const fixture = plannedWriteProvisioningFixture("cleanup-pending-known");
  const active = await activateRegisteredProvisioning(t, fixture);
  const official = createWorkerWorktree({
    controlRoot: fixture.root,
    baseCommit: fixture.binding.baseCommit,
    workerId: fixture.workerId,
    env: fixture.env
  });
  t.after(() => {
    try { git(fixture.root, "worktree", "remove", "--force", official.executionRoot); }
    catch {}
  });
  const officialReceipt = {
    status: "created",
    sessionId: active.prepared.intent.operationId,
    worktreePath: official.executionRoot,
    sourceGitRoot: fixture.binding.controlRoot,
    commit: fixture.binding.baseCommit
  };
  const recorded = recordOfficialWorktreeReceipt({
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: active.activated.job.provisioning.journalDigest,
    ...fixture.actor,
    providerSpawnIntentId: active.prepared.intent.intentId,
    officialReceipt,
    receivedAt: active.registeredAt,
    env: fixture.env
  });

  process.kill(-active.child.pid, "SIGKILL");
  await waitFor(() => processGroupGone(active.identity), {
    timeoutMs: 5_000,
    intervalMs: 25
  });
  const cleanupPendingAt = new Date(
    Math.max(
      Date.now(),
      Date.parse(recorded.receipt.hostVerification.verifiedAt) + 1
    )
  ).toISOString();
  const cleanupProof = {
    processIdentity: active.identity,
    processGroupGone: true,
    providerGuardAbsent: true,
    observedAt: cleanupPendingAt
  };
  const retained = retainWriteProvisioningCleanupPending({
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: active.activated.job.provisioning.journalDigest,
    ...fixture.actor,
    providerSpawnIntentId: active.prepared.intent.intentId,
    processIdentity: active.identity,
    cleanupProof,
    cleanupPendingAt,
    env: fixture.env
  });

  assert.equal(retained.retained, true);
  assert.equal(retained.replayed, false);
  assert.equal(retained.job.status, "queued");
  assert.equal(retained.job.phase, "worktree-cleanup-pending");
  assert.equal(retained.job.provisioning.state, "cleanup_pending");
  assert.equal(retained.job.provisioning.cleanupPendingAt, cleanupPendingAt);
  assert.equal(retained.job.provisioning.cleanedAt, null);
  assert.equal(retained.job.provisioning.failedAt, null);
  assert.equal(
    retained.job.provisioningRuntime.officialReceipt.receiptDigest,
    recorded.receipt.receiptDigest
  );
  assert.equal(retained.job.provisioningRuntime.intent.status, "registered");
  assert.equal(retained.job.provisioningRuntime.intent.updatedAt, cleanupPendingAt);
  assert.deepEqual(
    retained.job.provisioningRuntime.cleanupProof.processIdentity,
    active.identity
  );
  assert.equal(retained.job.request.spawn.providerLaunchOutcome, "not-ready");
  assert.equal(retained.job.request.spawn.providerLaunchPending, false);
  assert.equal(retained.job.request.spawn.providerLaunchInFlight, false);
  for (const forbidden of [
    "workerAuthorization",
    "controllerProcess",
    "workerProcess",
    "providerProcess",
    "grokSessionId"
  ]) {
    assert.equal(Object.hasOwn(retained.job, forbidden), false);
  }
  assert.equal(Object.hasOwn(retained.job.request.spawn, "dispatch"), false);
  assert.equal(fs.existsSync(fixture.binding.expectedExecutionRoot), true);
  assert.equal(JSON.stringify(retained.job).includes("\"worktreeAbsent\""), false);
  assert.equal(JSON.stringify(retained.job).includes("\"worktreeCleaned\""), false);
  assert.doesNotThrow(() => assertWriteExecutionJob(retained.job, fixture.env));

  const eventCount = retained.job.lifecycleEvents.length;
  const replay = retainWriteProvisioningCleanupPending({
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: active.activated.job.provisioning.journalDigest,
    ...fixture.actor,
    providerSpawnIntentId: active.prepared.intent.intentId,
    processIdentity: active.identity,
    cleanupProof,
    cleanupPendingAt,
    env: fixture.env
  });
  assert.equal(replay.retained, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.job.provisioning.journalDigest, retained.job.provisioning.journalDigest);
  assert.equal(replay.job.lifecycleEvents.length, eventCount);

  const changedReplayAt = new Date(Date.parse(cleanupPendingAt) + 1).toISOString();
  assert.throws(
    () => retainWriteProvisioningCleanupPending({
      root: fixture.root,
      principal: principal(fixture.root),
      workerId: fixture.workerId,
      executionBindingDigest: fixture.binding.bindingDigest,
      expectedJournalDigest: active.activated.job.provisioning.journalDigest,
      ...fixture.actor,
      providerSpawnIntentId: active.prepared.intent.intentId,
      processIdentity: active.identity,
      cleanupProof: { ...cleanupProof, observedAt: changedReplayAt },
      cleanupPendingAt: changedReplayAt,
      env: fixture.env
    }),
    (error) => error?.code === "E_STATE"
  );

  const tamperCases = [
    (job) => { job.provisioningRuntime.cleanupProof.processGroupGone = false; },
    (job) => { job.provisioningRuntime.intent.status = "no-child"; },
    (job) => {
      job.provisioningRuntime.intent.executableIdentity.identityDigest =
        "0".repeat(64);
    },
    (job) => { job.provisioningRuntime.officialReceipt.receivedAt = changedReplayAt; },
    (job) => { job.request.spawn.dispatch = { schemaVersion: 2 }; },
    (job) => { job.grokSessionId = "forged-session"; }
  ];
  for (const tamper of tamperCases) {
    const corrupted = structuredClone(retained.job);
    tamper(corrupted);
    assert.throws(
      () => assertWriteExecutionJob(corrupted, fixture.env),
      (error) => ["E_STATE", "E_PROCESS_IDENTITY"].includes(error?.code)
    );
  }
});
