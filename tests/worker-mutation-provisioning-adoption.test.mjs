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

import {
  completeAbsenceProvenReissue,
  completeOfficialWorktreePromotion,
  prepareAbsenceProvenReissue,
  prepareOfficialWorktreePromotion,
  activateAbsenceProvenReissue
} from "./worker-mutation-provisioning-test-support.mjs";

test("cleanup-pending unknown effect is host-adopted from exact worktree evidence without dispatch authority", {
  skip: process.platform === "win32"
}, async (t) => {
  const fixture = plannedWriteProvisioningFixture("cleanup-pending-unknown");
  const active = await activateRegisteredProvisioning(t, fixture);
  assert.equal(
    tryReadJob(fixture.root, fixture.workerId, fixture.env)
      .provisioningRuntime.officialReceipt,
    null
  );
  assert.equal(fs.existsSync(fixture.binding.expectedExecutionRoot), false);

  process.kill(-active.child.pid, "SIGKILL");
  await waitFor(() => processGroupGone(active.identity), {
    timeoutMs: 5_000,
    intervalMs: 25
  });
  const cleanupPendingAt = new Date(
    Math.max(Date.now(), Date.parse(active.registeredAt) + 1)
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
  assert.equal(retained.job.provisioning.state, "cleanup_pending");
  assert.equal(retained.job.provisioningRuntime.officialReceipt, null);
  assert.equal(retained.job.provisioningRuntime.intent.status, "registered");
  assert.equal(retained.job.provisioning.cleanedAt, null);
  assert.equal(retained.job.request.spawn.providerLaunchOutcome, "not-ready");
  assert.equal(Object.hasOwn(retained.job.request.spawn, "dispatch"), false);
  assert.equal(fs.existsSync(fixture.binding.expectedExecutionRoot), false);
  const serialized = JSON.stringify(retained.job);
  for (const unsupportedClaim of [
    "\"worktreeAbsent\"",
    "\"worktreeRemoved\"",
    "\"worktreeCleaned\"",
    "\"cleanedAt\":\""
  ]) {
    assert.equal(serialized.includes(unsupportedClaim), false);
  }
  assert.doesNotThrow(() => assertWriteExecutionJob(retained.job, fixture.env));

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
    env: fixture.env
  });
  assert.equal(replay.retained, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.job.provisioning.journalDigest, retained.job.provisioning.journalDigest);

  const corrupted = structuredClone(retained.job);
  corrupted.provisioningRuntime.cleanupProof.processIdentity.startToken =
    `${active.identity.startToken}-forged`;
  assert.throws(
    () => assertWriteExecutionJob(corrupted, fixture.env),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );

  const legacy = structuredClone(retained.job);
  delete legacy.provisioningRuntime.hostAdoption;
  assert.doesNotThrow(() => assertWriteExecutionJob(legacy, fixture.env));
  delete legacy.provisioningRuntime.priorAttempts;
  assert.doesNotThrow(() => assertWriteExecutionJob(legacy, fixture.env));

  const officialEffect = createWorkerWorktree({
    controlRoot: fixture.root,
    baseCommit: fixture.binding.baseCommit,
    workerId: fixture.workerId,
    env: fixture.env
  });
  t.after(() => {
    try {
      git(fixture.root, "worktree", "remove", "--force", officialEffect.executionRoot);
    } catch {}
  });
  let adopted;
  const staleCallerReplay = await provisionWriteWorkerWorktree({
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    leaseMs: 1,
    timeoutMs: 1,
    env: fixture.env,
    testHooks: {
      beforeHostAdoption() {
        adopted = adoptWriteProvisioningEffect({
          root: fixture.root,
          principal: principal(fixture.root),
          workerId: fixture.workerId,
          executionBindingDigest: fixture.binding.bindingDigest,
          expectedJournalDigest: retained.job.provisioning.journalDigest,
          providerSpawnIntentId: active.prepared.intent.intentId,
          cleanupProofDigest:
            retained.job.provisioningRuntime.cleanupProof.proofDigest,
          env: fixture.env
        });
      }
    }
  });

  assert.equal(adopted.adopted, true);
  assert.equal(adopted.replayed, false);
  assert.equal(staleCallerReplay.replayed, true);
  assert.equal(staleCallerReplay.providerLaunched, false);
  assert.equal(staleCallerReplay.workerDispatched, false);
  assert.equal(
    staleCallerReplay.hostAdoptionDigest,
    adopted.adoption.adoptionDigest
  );
  assert.equal(adopted.job.status, "queued");
  assert.equal(adopted.job.phase, "worktree-ready");
  assert.equal(adopted.job.provisioning.state, "ready");
  assert.equal(adopted.job.provisioningRuntime.officialReceipt, null);
  assert.equal(
    adopted.adoption.origin,
    "unknown-official-response-host-adoption"
  );
  assert.equal(adopted.adoption.operationId, active.prepared.intent.operationId);
  assert.equal(
    adopted.adoption.providerSpawnIntentId,
    active.prepared.intent.intentId
  );
  assert.equal(
    adopted.adoption.provisioningIntentDigest,
    active.prepared.intent.intentDigest
  );
  assert.equal(
    adopted.adoption.requestedExecutableIdentityDigest,
    fixture.actor.executableIdentity.identityDigest
  );
  assert.equal(
    adopted.adoption.requestedReleaseIdentityDigest,
    fixture.actor.executableIdentity.releaseIdentityDigest
  );
  assert.equal(adopted.adoption.cleanupPendingAt, cleanupPendingAt);
  assert.equal(
    adopted.adoption.cleanupProofDigest,
    retained.job.provisioningRuntime.cleanupProof.proofDigest
  );
  assert.equal(
    adopted.adoption.hostVerification.expectedExecutionRootDigest,
    fixture.binding.expectedExecutionRootDigest
  );
  assert.equal(
    adopted.adoption.hostVerification.baseCommit,
    fixture.binding.baseCommit
  );
  assert.equal(
    adopted.adoption.hostVerification.baseTree,
    fixture.binding.baseTree
  );
  assert.match(
    adopted.adoption.hostVerification.worktreeFingerprintDigest,
    /^[a-f0-9]{64}$/
  );
  assert.match(adopted.adoption.adoptionDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    adopted.job.request.spawn.providerLaunchOutcome,
    "worktree-ready-no-dispatch"
  );
  assert.equal(adopted.job.request.spawn.providerLaunchPending, false);
  assert.equal(adopted.job.request.spawn.providerLaunchInFlight, false);
  assert.equal(Object.hasOwn(adopted.job.request.spawn, "dispatch"), false);
  for (const forbidden of [
    "workerAuthorization",
    "controllerProcess",
    "workerProcess",
    "providerProcess",
    "grokSessionId"
  ]) {
    assert.equal(Object.hasOwn(adopted.job, forbidden), false);
  }
  assert.doesNotThrow(() => assertWriteExecutionJob(adopted.job, fixture.env));

  for (const corrupt of [
    (job) => { job.provisioningRuntime.hostAdoption.origin = "official-created"; },
    (job) => {
      job.provisioningRuntime.hostAdoption.requestedExecutableIdentityDigest =
        "0".repeat(64);
    },
    (job) => {
      job.provisioningRuntime.hostAdoption.cleanupProofDigest = "0".repeat(64);
    },
    (job) => {
      job.provisioningRuntime.hostAdoption.adoptionDigest = "0".repeat(64);
    }
  ]) {
    const forged = structuredClone(adopted.job);
    corrupt(forged);
    assert.throws(
      () => assertWriteExecutionJob(forged, fixture.env),
      (error) => error?.code === "E_STATE"
    );
  }
  const staleVerification = structuredClone(adopted.job);
  const staleAdoption = staleVerification.provisioningRuntime.hostAdoption;
  staleAdoption.hostVerification.verifiedAt = new Date(
    Date.parse(cleanupPendingAt) - 1
  ).toISOString();
  const {
    verificationDigest: _verificationDigest,
    ...verificationBody
  } = staleAdoption.hostVerification;
  staleAdoption.hostVerification.verificationDigest =
    stableDigest(verificationBody);
  const {
    adoptionDigest: _adoptionDigest,
    ...adoptionBody
  } = staleAdoption;
  staleAdoption.adoptionDigest = stableDigest(adoptionBody);
  assert.throws(
    () => assertWriteExecutionJob(staleVerification, fixture.env),
    (error) => error?.code === "E_STATE"
  );

  const adoptionReplay = adoptWriteProvisioningEffect({
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: retained.job.provisioning.journalDigest,
    providerSpawnIntentId: active.prepared.intent.intentId,
    cleanupProofDigest: retained.job.provisioningRuntime.cleanupProof.proofDigest,
    env: fixture.env
  });
  assert.equal(adoptionReplay.adopted, false);
  assert.equal(adoptionReplay.replayed, true);
  assert.deepEqual(adoptionReplay.adoption, adopted.adoption);
  assert.deepEqual(adoptionReplay.job, adopted.job);
});

test("reissue registration failure settles the exact preactivation planned digest", {
  skip: process.platform === "win32"
}, async (t) => {
  const { fixture, retained } = await cleanupPendingAbsentProvisioning(
    t,
    "reissue-registration-preactivation"
  );
  const transient = await detachedProvisioner(
    t,
    `${fixture.workerId}-transient-registration`
  );
  process.kill(-transient.child.pid, "SIGKILL");
  await waitFor(() => processGroupGone(transient.identity), {
    timeoutMs: 5_000,
    intervalMs: 25
  });

  const counter = { constructed: 0 };
  let prepared = null;
  let reconciled = null;
  const loaded = await loadWorkerProvisionerWithProviderSeam({
    taskEnvironment: controllerEnvironmentSeam(counter),
    async openProvider({ providerLaunch }) {
      prepared = providerLaunch.prepare({
        executableIdentity: TEST_EXECUTABLE_IDENTITY
      });
      assert.equal(prepared.prepared, true);
      assert.equal(prepared.job.provisioning.state, "reissue_planned");
      assert.notEqual(
        prepared.intent.expectedPlannedJournalDigest,
        retained.job.provisioning.journalDigest
      );
      const observedAt = new Date(
        Math.max(Date.now(), Date.parse(prepared.intent.preparedAt) + 1)
      ).toISOString();
      reconciled = await providerLaunch.settleRegistrationFailure({
        intentId: prepared.intent.intentId,
        providerSpawnIntentId: prepared.intent.providerSpawnIntentId,
        expectedPlannedJournalDigest:
          prepared.intent.expectedPlannedJournalDigest,
        processIdentity: transient.identity,
        cleanupProof: {
          processIdentity: transient.identity,
          processGroupGone: true,
          providerGuardAbsent: true,
          observedAt
        }
      });
      const error = new Error("synthetic preactivation registration failure");
      error.code = "E_TEST_REGISTRATION";
      throw error;
    },
    providerCleanupIdentity() {
      return null;
    }
  });
  try {
    await assert.rejects(
      () => loaded.provisionWriteWorkerWorktree({
        root: fixture.root,
        principal: principal(fixture.root),
        workerId: fixture.workerId,
        env: fixture.env
      }),
      (error) => error?.code === "E_TEST_REGISTRATION"
    );
  } finally {
    loaded.release();
  }

  assert.equal(counter.constructed, 1);
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.settlement.settled, true);
  assert.equal(reconciled.settlement.replayed, false);
  const failed = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  assert.equal(failed.status, "failed");
  assert.equal(failed.provisioning.state, "failed");
  assert.equal(failed.provisioningRuntime.intent.status, "no-child");
  assert.equal(
    failed.provisioningRuntime.intent.resolution,
    "preactivation-cleanup-proven"
  );
  assert.equal(failed.provisioningRuntime.intent.processIdentity, null);
  assert.equal(failed.provisioningRuntime.priorAttempts.length, 1);
  assert.equal(
    failed.provisioningRuntime.intent.expectedPlannedJournalDigest,
    prepared.intent.expectedPlannedJournalDigest
  );
  assert.doesNotThrow(() => assertWriteExecutionJob(failed, fixture.env));
});

test("reissue registration failure settles the exact activated planned predecessor", {
  skip: process.platform === "win32"
}, async (t) => {
  const { fixture, retained } = await cleanupPendingAbsentProvisioning(
    t,
    "reissue-registration-activated"
  );
  const controller = await detachedProvisioner(
    t,
    `${fixture.workerId}-registration-activated`
  );

  const counter = { constructed: 0 };
  let prepared = null;
  let activation = null;
  let reconciled = null;
  const loaded = await loadWorkerProvisionerWithProviderSeam({
    taskEnvironment: controllerEnvironmentSeam(counter),
    async openProvider({ providerLaunch }) {
      prepared = providerLaunch.prepare({
        executableIdentity: TEST_EXECUTABLE_IDENTITY
      });
      assert.equal(prepared.prepared, true);
      assert.equal(prepared.job.provisioning.state, "reissue_planned");
      assert.notEqual(
        prepared.intent.expectedPlannedJournalDigest,
        retained.job.provisioning.journalDigest
      );
      activation = await providerLaunch.registerBootstrap({
        intentId: prepared.intent.intentId,
        providerSpawnIntentId: prepared.intent.providerSpawnIntentId,
        expectedJournalDigest:
          prepared.intent.expectedPlannedJournalDigest,
        processIdentity: controller.identity
      });
      assert.equal(activation.activated, true);
      assert.equal(activation.job.provisioning.state, "provisioning");
      assert.equal(
        activation.job.provisioning.previousJournalDigest,
        prepared.intent.expectedPlannedJournalDigest
      );
      process.kill(-controller.child.pid, "SIGKILL");
      await waitFor(() => processGroupGone(controller.identity), {
        timeoutMs: 5_000,
        intervalMs: 25
      });
      const observedAt = new Date(
        Math.max(Date.now(), Date.parse(activation.intent.activatedAt) + 1)
      ).toISOString();
      reconciled = await providerLaunch.settleRegistrationFailure({
        intentId: prepared.intent.intentId,
        providerSpawnIntentId: prepared.intent.providerSpawnIntentId,
        expectedPlannedJournalDigest:
          prepared.intent.expectedPlannedJournalDigest,
        processIdentity: controller.identity,
        cleanupProof: {
          processIdentity: controller.identity,
          processGroupGone: true,
          providerGuardAbsent: true,
          observedAt
        }
      });
      const error = new Error("synthetic activated registration failure");
      error.code = "E_TEST_REGISTRATION";
      throw error;
    },
    providerCleanupIdentity() {
      return null;
    }
  });
  try {
    await assert.rejects(
      () => loaded.provisionWriteWorkerWorktree({
        root: fixture.root,
        principal: principal(fixture.root),
        workerId: fixture.workerId,
        env: fixture.env
      }),
      (error) => error?.code === "E_TEST_REGISTRATION"
    );
  } finally {
    loaded.release();
  }

  assert.equal(counter.constructed, 1);
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.settlement.settled, true);
  assert.equal(reconciled.settlement.replayed, false);
  const failed = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  assert.equal(failed.status, "failed");
  assert.equal(failed.provisioning.state, "failed");
  assert.equal(failed.provisioningRuntime.intent.status, "no-child");
  assert.equal(failed.provisioningRuntime.intent.resolution, "cleanup-proven");
  assert.deepEqual(
    failed.provisioningRuntime.intent.processIdentity,
    controller.identity
  );
  assert.equal(failed.provisioningRuntime.priorAttempts.length, 1);
  assert.equal(
    failed.provisioningRuntime.activatedJournalDigest,
    activation.job.provisioning.journalDigest
  );
  assert.doesNotThrow(() => assertWriteExecutionJob(failed, fixture.env));
});

test("absence-proven reissue archives the prior attempt and activates only a fresh fence", {
  skip: process.platform === "win32"
}, async (t) => {
  let context = await prepareAbsenceProvenReissue(t);
  context = await activateAbsenceProvenReissue(t, context);
  await completeAbsenceProvenReissue(t, context);
});

test("host adoption rejects mismatched evidence and a dirty worktree without mutating cleanup-pending", {
  skip: process.platform === "win32"
}, async (t) => {
  const fixture = plannedWriteProvisioningFixture("host-adoption-reject");
  const active = await activateRegisteredProvisioning(t, fixture);
  process.kill(-active.child.pid, "SIGKILL");
  await waitFor(() => processGroupGone(active.identity), {
    timeoutMs: 5_000,
    intervalMs: 25
  });
  const cleanupPendingAt = new Date(
    Math.max(Date.now(), Date.parse(active.registeredAt) + 1)
  ).toISOString();
  const retained = retainWriteProvisioningCleanupPending({
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: active.activated.job.provisioning.journalDigest,
    ...fixture.actor,
    providerSpawnIntentId: active.prepared.intent.intentId,
    processIdentity: active.identity,
    cleanupProof: {
      processIdentity: active.identity,
      processGroupGone: true,
      providerGuardAbsent: true,
      observedAt: cleanupPendingAt
    },
    cleanupPendingAt,
    env: fixture.env
  });
  const officialEffect = createWorkerWorktree({
    controlRoot: fixture.root,
    baseCommit: fixture.binding.baseCommit,
    workerId: fixture.workerId,
    env: fixture.env
  });
  t.after(() => {
    try {
      git(fixture.root, "worktree", "remove", "--force", officialEffect.executionRoot);
    } catch {}
  });

  assert.throws(
    () => adoptWriteProvisioningEffect({
      root: fixture.root,
      principal: principal(fixture.root),
      workerId: fixture.workerId,
      executionBindingDigest: fixture.binding.bindingDigest,
      expectedJournalDigest: retained.job.provisioning.journalDigest,
      providerSpawnIntentId: active.prepared.intent.intentId,
      cleanupProofDigest: "0".repeat(64),
      env: fixture.env
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  assert.deepEqual(
    tryReadJob(fixture.root, fixture.workerId, fixture.env),
    retained.job
  );

  fs.appendFileSync(
    path.join(officialEffect.executionRoot, "tracked.txt"),
    "\ndirty host-adoption candidate\n"
  );
  assert.throws(
    () => adoptWriteProvisioningEffect({
      root: fixture.root,
      principal: principal(fixture.root),
      workerId: fixture.workerId,
      executionBindingDigest: fixture.binding.bindingDigest,
      expectedJournalDigest: retained.job.provisioning.journalDigest,
      providerSpawnIntentId: active.prepared.intent.intentId,
      cleanupProofDigest:
        retained.job.provisioningRuntime.cleanupProof.proofDigest,
      env: fixture.env
    }),
    (error) => error?.code === "E_WORKTREE"
  );
  const unchanged = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  assert.deepEqual(unchanged, retained.job);
  assert.equal(unchanged.provisioning.state, "cleanup_pending");
  assert.equal(unchanged.provisioningRuntime.officialReceipt, null);
  assert.equal(unchanged.provisioningRuntime.hostAdoption, null);
  assert.equal(unchanged.request.spawn.providerLaunchOutcome, "not-ready");
  assert.equal(Object.hasOwn(unchanged.request.spawn, "dispatch"), false);
});

test("official worktree receipt and cleanup proof promote only verified-worktree-ready with zero dispatch authority", {
  skip: process.platform === "win32"
}, async (t) => {
  const context = await prepareOfficialWorktreePromotion(t);
  completeOfficialWorktreePromotion(context);
});
