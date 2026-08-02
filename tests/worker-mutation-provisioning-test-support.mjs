import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

export async function prepareAbsenceProvenReissue(t) {
  const fixture = plannedWriteProvisioningFixture("absence-reissue");
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

  const workerParent = path.dirname(fixture.binding.expectedExecutionRoot);
  const managedRoot = path.dirname(workerParent);
  fs.mkdirSync(workerParent, { recursive: true, mode: 0o700 });
  fs.chmodSync(managedRoot, 0o700);
  fs.chmodSync(workerParent, 0o700);
  const nextExecutableIdentity = createExecutableAttestation({
    canonicalPath: "/private/test/reissued-grok",
    device: "3",
    inode: "4",
    mode: 0o100755,
    size: TEST_EXECUTABLE_IDENTITY.size,
    executableDigest: TEST_EXECUTABLE_IDENTITY.executableDigest
  }, {
    releaseSource: TEST_EXECUTABLE_IDENTITY.releaseSource,
    packageName: TEST_EXECUTABLE_IDENTITY.packageName,
    packageVersion: TEST_EXECUTABLE_IDENTITY.packageVersion,
    packageGitHead: TEST_EXECUTABLE_IDENTITY.packageGitHead,
    packageIntegrityDigest: TEST_EXECUTABLE_IDENTITY.packageIntegrityDigest,
    platform: TEST_EXECUTABLE_IDENTITY.platform,
    arch: TEST_EXECUTABLE_IDENTITY.arch,
    version: TEST_EXECUTABLE_IDENTITY.version,
    buildCommit: TEST_EXECUTABLE_IDENTITY.buildCommit,
    channel: TEST_EXECUTABLE_IDENTITY.channel,
    size: TEST_EXECUTABLE_IDENTITY.size,
    executableDigest: TEST_EXECUTABLE_IDENTITY.executableDigest
  });
  const reissueActor = {
    attemptId: "d".repeat(32),
    fence: 2,
    holderId: "e".repeat(32),
    executableIdentity: nextExecutableIdentity
  };
  const request = {
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: retained.job.provisioning.journalDigest,
    ...reissueActor,
    env: fixture.env
  };

  fs.symlinkSync(
    "missing-checkout",
    fixture.binding.expectedExecutionRoot
  );
  assert.throws(
    () => prepareWriteProvisioningReissue(request),
    (error) => error?.code === "E_WORKTREE"
  );
  fs.unlinkSync(fixture.binding.expectedExecutionRoot);
  assert.deepEqual(
    tryReadJob(fixture.root, fixture.workerId, fixture.env),
    retained.job
  );
  fs.rmdirSync(workerParent);
  assert.equal(fs.existsSync(workerParent), false);

  const prepared = prepareWriteProvisioningReissue(request);
  assert.equal(prepared.prepared, true);
  assert.equal(prepared.replayed, false);
  assert.equal(prepared.job.provisioning.state, "reissue_planned");
  assert.equal(prepared.job.provisioning.attemptId, reissueActor.attemptId);
  assert.equal(prepared.job.provisioning.fence, 2);
  assert.equal(prepared.job.provisioningRuntime.priorAttempts.length, 1);
  assert.equal(prepared.intent.operationId, active.prepared.intent.operationId);
  assert.notEqual(
    prepared.intent.providerSpawnIntentId,
    active.prepared.intent.providerSpawnIntentId
  );
  assert.notEqual(prepared.intent.holderId, fixture.actor.holderId);
  assert.notEqual(
    prepared.intent.executableIdentity.identityDigest,
    active.prepared.intent.executableIdentity.identityDigest
  );
  assert.equal(
    prepared.intent.executableIdentity.releaseIdentityDigest,
    active.prepared.intent.executableIdentity.releaseIdentityDigest
  );
  const archive = prepared.job.provisioningRuntime.priorAttempts[0];
  assert.equal(
    archive.sourceCleanupPendingJournal.journalDigest,
    retained.job.provisioning.journalDigest
  );
  assert.equal(
    archive.attemptEvidence.intent.intentDigest,
    active.prepared.intent.intentDigest
  );
  assert.equal(
    archive.attemptEvidence.cleanupProof.proofDigest,
    retained.job.provisioningRuntime.cleanupProof.proofDigest
  );
  assert.equal(archive.absenceProof.classification, "absent");
  assert.equal(archive.absenceProof.workerParentState, "absent");
  assert.equal(archive.absenceProof.workerParentIdentityDigest, null);
  assert.equal(archive.absenceProof.exactRegistrationCount, 0);
  assert.equal(
    prepared.job.provisioning.priorAttemptArchiveDigest,
    archive.archiveDigest
  );
  assert.doesNotThrow(
    () => assertWriteExecutionJob(prepared.job, fixture.env)
  );

  const replay = prepareWriteProvisioningReissue({
    ...request,
    expectedJournalDigest: prepared.job.provisioning.journalDigest
  });
  assert.equal(replay.prepared, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.intent.intentDigest, prepared.intent.intentDigest);
  assert.equal(replay.job.provisioningRuntime.priorAttempts.length, 1);
  assert.throws(
    () => prepareWriteProvisioningReissue({
      ...request,
      expectedJournalDigest: prepared.job.provisioning.journalDigest,
      attemptId: "f".repeat(32),
      holderId: "1".repeat(32)
    }),
    (error) => error?.code === "E_STATE"
  );
  return { fixture, active, retained, request, prepared, archive, reissueActor };
}

export async function activateAbsenceProvenReissue(t, context) {
  const { fixture, active, retained, request, prepared, archive, reissueActor } = context;
  const reauthorizedExecutableIdentity = createExecutableAttestation({
    canonicalPath: "/private/test/restarted-reissued-grok",
    device: "5",
    inode: "6",
    mode: 0o100755,
    size: TEST_EXECUTABLE_IDENTITY.size,
    executableDigest: TEST_EXECUTABLE_IDENTITY.executableDigest
  }, {
    releaseSource: TEST_EXECUTABLE_IDENTITY.releaseSource,
    packageName: TEST_EXECUTABLE_IDENTITY.packageName,
    packageVersion: TEST_EXECUTABLE_IDENTITY.packageVersion,
    packageGitHead: TEST_EXECUTABLE_IDENTITY.packageGitHead,
    packageIntegrityDigest: TEST_EXECUTABLE_IDENTITY.packageIntegrityDigest,
    platform: TEST_EXECUTABLE_IDENTITY.platform,
    arch: TEST_EXECUTABLE_IDENTITY.arch,
    version: TEST_EXECUTABLE_IDENTITY.version,
    buildCommit: TEST_EXECUTABLE_IDENTITY.buildCommit,
    channel: TEST_EXECUTABLE_IDENTITY.channel,
    size: TEST_EXECUTABLE_IDENTITY.size,
    executableDigest: TEST_EXECUTABLE_IDENTITY.executableDigest
  });
  const reauthorizedActor = {
    attemptId: reissueActor.attemptId,
    fence: reissueActor.fence,
    holderId: "1".repeat(32),
    executableIdentity: reauthorizedExecutableIdentity
  };
  const reauthorized = prepareWriteProvisioningReissue({
    ...request,
    expectedJournalDigest: prepared.job.provisioning.journalDigest,
    ...reauthorizedActor
  });
  assert.equal(reauthorized.prepared, true);
  assert.equal(reauthorized.replayed, false);
  assert.equal(reauthorized.reason, "reissue-reauthorized");
  assert.equal(
    reauthorized.job.provisioning.previousJournalDigest,
    prepared.job.provisioning.journalDigest
  );
  assert.equal(
    reauthorized.job.provisioning.priorAttemptArchiveDigest,
    archive.archiveDigest
  );
  assert.equal(reauthorized.intent.operationId, prepared.intent.operationId);
  assert.equal(
    reauthorized.intent.provisioningAttemptId,
    prepared.intent.provisioningAttemptId
  );
  assert.equal(
    reauthorized.intent.provisioningFence,
    prepared.intent.provisioningFence
  );
  assert.notEqual(
    reauthorized.intent.providerSpawnIntentId,
    prepared.intent.providerSpawnIntentId
  );
  assert.notEqual(reauthorized.intent.holderId, prepared.intent.holderId);
  assert.notEqual(
    reauthorized.intent.executableIdentity.identityDigest,
    prepared.intent.executableIdentity.identityDigest
  );
  assert.equal(
    reauthorized.intent.executableIdentity.releaseIdentityDigest,
    prepared.intent.executableIdentity.releaseIdentityDigest
  );

  const corrupted = structuredClone(prepared.job);
  corrupted.provisioningRuntime.priorAttempts[0]
    .absenceProof.rawInventoryDigest = "0".repeat(64);
  assert.throws(
    () => assertWriteExecutionJob(corrupted, fixture.env),
    (error) => error?.code === "E_STATE" || error?.code === "E_WORKTREE"
  );

  const { child, identity } = await detachedProvisioner(
    t,
    `${fixture.workerId}-reissue`
  );
  const provisioningAt = new Date(
    Math.max(Date.now(), Date.parse(prepared.intent.preparedAt) + 1)
  ).toISOString();
  const activated = activateWriteProvisioningAttempt({
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: reauthorized.job.provisioning.journalDigest,
    ...reauthorizedActor,
    providerSpawnIntentId: reauthorized.intent.providerSpawnIntentId,
    processIdentity: identity,
    provisioningAt,
    leaseExpiresAt: new Date(
      Date.parse(provisioningAt) + 60_000
    ).toISOString(),
    env: fixture.env
  });
  assert.equal(activated.activated, true);
  assert.equal(activated.job.provisioning.state, "provisioning");
  assert.equal(activated.job.provisioning.fence, 2);
  assert.equal(activated.job.provisioningRuntime.priorAttempts.length, 1);
  assert.equal(
    activated.job.provisioning.priorAttemptArchiveDigest,
    archive.archiveDigest
  );
  assert.doesNotThrow(
    () => assertWriteExecutionJob(activated.job, fixture.env)
  );
  assert.throws(
    () => activateWriteProvisioningAttempt({
      root: fixture.root,
      principal: principal(fixture.root),
      workerId: fixture.workerId,
      executionBindingDigest: fixture.binding.bindingDigest,
      expectedJournalDigest: retained.job.provisioning.journalDigest,
      ...fixture.actor,
      providerSpawnIntentId: active.prepared.intent.providerSpawnIntentId,
      processIdentity: identity,
      provisioningAt,
      leaseExpiresAt: activated.job.provisioning.leaseExpiresAt,
      env: fixture.env
    }),
    (error) => ["E_STATE", "E_PROCESS_IDENTITY"].includes(error?.code)
  );
  const guardBinding = {
    purpose: "worktree-provisioning",
    controlWorkspaceId: fixture.binding.controlWorkspaceId,
    controlRoot: fixture.binding.controlRoot,
    expectedExecutionRoot: fixture.binding.expectedExecutionRoot,
    executionBindingDigest: fixture.binding.bindingDigest,
    provisioningAttemptId: reauthorizedActor.attemptId,
    provisioningFence: reauthorizedActor.fence,
    holderId: reauthorizedActor.holderId,
    providerSpawnIntentId: reauthorized.intent.providerSpawnIntentId
  };
  const guard = registerWorktreeProvisioningGuard(
    fixture.root,
    fixture.workerId,
    identity,
    THREAD,
    guardBinding,
    fixture.env
  );
  const guardedJob = tryReadJob(
    fixture.root,
    fixture.workerId,
    fixture.env
  );
  assert.equal(guardedJob.provisioningRuntime.priorAttempts.length, 1);
  const missingArchiveHistory = structuredClone(guardedJob);
  delete missingArchiveHistory.provisioningRuntime.priorAttempts;
  assert.throws(
    () => assertWorktreeProvisioningGuardForJob(
      fixture.root,
      missingArchiveHistory,
      guard,
      { expectedBinding: guardBinding, env: fixture.env }
    ),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  const tamperedArchiveHistory = structuredClone(guardedJob);
  tamperedArchiveHistory.provisioningRuntime.priorAttempts[0]
    .absenceProof.rawInventoryDigest = "0".repeat(64);
  assert.throws(
    () => assertWorktreeProvisioningGuardForJob(
      fixture.root,
      tamperedArchiveHistory,
      guard,
      { expectedBinding: guardBinding, env: fixture.env }
    ),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  unregisterProviderGuard(fixture.root, fixture.workerId, guard, fixture.env);
  process.kill(-child.pid, "SIGKILL");
  await waitFor(() => processGroupGone(identity), {
    timeoutMs: 5_000,
    intervalMs: 25
  });
  return {
    ...context,
    reauthorizedActor,
    reauthorized,
    guardedJob,
    identity
  };
}

export async function completeAbsenceProvenReissue(t, context) {
  const {
    fixture,
    prepared,
    reauthorizedActor,
    reauthorized,
    guardedJob,
    identity
  } = context;
  const secondCleanupPendingAt = new Date(
    Math.max(
      Date.now(),
      Date.parse(
        guardedJob.provisioningRuntime.intent.registeredAt
      ) + 1
    )
  ).toISOString();
  const secondRetained = retainWriteProvisioningCleanupPending({
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: guardedJob.provisioning.journalDigest,
    ...reauthorizedActor,
    providerSpawnIntentId:
      guardedJob.provisioningRuntime.intent.providerSpawnIntentId,
    processIdentity: identity,
    cleanupProof: {
      processIdentity: identity,
      processGroupGone: true,
      providerGuardAbsent: true,
      observedAt: secondCleanupPendingAt
    },
    cleanupPendingAt: secondCleanupPendingAt,
    env: fixture.env
  });
  const thirdExecutableIdentity = createExecutableAttestation({
    canonicalPath: "/private/test/third-reissued-grok",
    device: "7",
    inode: "8",
    mode: 0o100755,
    size: TEST_EXECUTABLE_IDENTITY.size,
    executableDigest: TEST_EXECUTABLE_IDENTITY.executableDigest
  }, {
    releaseSource: TEST_EXECUTABLE_IDENTITY.releaseSource,
    packageName: TEST_EXECUTABLE_IDENTITY.packageName,
    packageVersion: TEST_EXECUTABLE_IDENTITY.packageVersion,
    packageGitHead: TEST_EXECUTABLE_IDENTITY.packageGitHead,
    packageIntegrityDigest: TEST_EXECUTABLE_IDENTITY.packageIntegrityDigest,
    platform: TEST_EXECUTABLE_IDENTITY.platform,
    arch: TEST_EXECUTABLE_IDENTITY.arch,
    version: TEST_EXECUTABLE_IDENTITY.version,
    buildCommit: TEST_EXECUTABLE_IDENTITY.buildCommit,
    channel: TEST_EXECUTABLE_IDENTITY.channel,
    size: TEST_EXECUTABLE_IDENTITY.size,
    executableDigest: TEST_EXECUTABLE_IDENTITY.executableDigest
  });
  const thirdActor = {
    attemptId: "2".repeat(32),
    fence: 3,
    holderId: "3".repeat(32),
    executableIdentity: thirdExecutableIdentity
  };
  const thirdPrepared = prepareWriteProvisioningReissue({
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: secondRetained.job.provisioning.journalDigest,
    ...thirdActor,
    env: fixture.env
  });
  assert.equal(thirdPrepared.prepared, true);
  assert.equal(thirdPrepared.job.provisioningRuntime.priorAttempts.length, 2);
  assert.equal(
    thirdPrepared.intent.operationId,
    reauthorized.intent.operationId
  );

  const thirdProvisioner = await detachedProvisioner(
    t,
    `${fixture.workerId}-third-reissue`
  );
  const thirdProvisioningAt = new Date(
    Math.max(Date.now(), Date.parse(thirdPrepared.intent.preparedAt) + 1)
  ).toISOString();
  const thirdActivated = activateWriteProvisioningAttempt({
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: thirdPrepared.job.provisioning.journalDigest,
    ...thirdActor,
    providerSpawnIntentId: thirdPrepared.intent.providerSpawnIntentId,
    processIdentity: thirdProvisioner.identity,
    provisioningAt: thirdProvisioningAt,
    leaseExpiresAt: new Date(
      Date.parse(thirdProvisioningAt) + 60_000
    ).toISOString(),
    env: fixture.env
  });
  const thirdGuardBinding = {
    purpose: "worktree-provisioning",
    controlWorkspaceId: fixture.binding.controlWorkspaceId,
    controlRoot: fixture.binding.controlRoot,
    expectedExecutionRoot: fixture.binding.expectedExecutionRoot,
    executionBindingDigest: fixture.binding.bindingDigest,
    provisioningAttemptId: thirdActor.attemptId,
    provisioningFence: thirdActor.fence,
    holderId: thirdActor.holderId,
    providerSpawnIntentId: thirdPrepared.intent.providerSpawnIntentId
  };
  const thirdGuard = registerWorktreeProvisioningGuard(
    fixture.root,
    fixture.workerId,
    thirdProvisioner.identity,
    THREAD,
    thirdGuardBinding,
    fixture.env
  );
  const thirdRegisteredJob = tryReadJob(
    fixture.root,
    fixture.workerId,
    fixture.env
  );
  assert.equal(
    thirdRegisteredJob.provisioningRuntime.priorAttempts.length,
    2
  );
  unregisterProviderGuard(
    fixture.root,
    fixture.workerId,
    thirdGuard,
    fixture.env
  );
  process.kill(-thirdProvisioner.child.pid, "SIGKILL");
  await waitFor(() => processGroupGone(thirdProvisioner.identity), {
    timeoutMs: 5_000,
    intervalMs: 25
  });
  const thirdCleanupPendingAt = new Date(
    Math.max(
      Date.now(),
      Date.parse(
        thirdRegisteredJob.provisioningRuntime.intent.registeredAt
      ) + 1
    )
  ).toISOString();
  const thirdRetained = retainWriteProvisioningCleanupPending({
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: thirdActivated.job.provisioning.journalDigest,
    ...thirdActor,
    providerSpawnIntentId:
      thirdRegisteredJob.provisioningRuntime.intent.providerSpawnIntentId,
    processIdentity: thirdProvisioner.identity,
    cleanupProof: {
      processIdentity: thirdProvisioner.identity,
      processGroupGone: true,
      providerGuardAbsent: true,
      observedAt: thirdCleanupPendingAt
    },
    cleanupPendingAt: thirdCleanupPendingAt,
    env: fixture.env
  });
  const exhaustedSnapshot = structuredClone(thirdRetained.job);
  const taskHomes = path.join(
    workspaceState(fixture.root, fixture.env),
    "task-homes"
  );
  const taskHomesBefore = fs.existsSync(taskHomes)
    ? fs.readdirSync(taskHomes).sort()
    : null;
  let constructedControllerHomes = 0;
  await assert.rejects(
    () => provisionWriteWorkerWorktree({
      root: fixture.root,
      principal: principal(fixture.root),
      workerId: fixture.workerId,
      env: fixture.env,
      testHooks: {
        afterControllerEnvironmentConstructedBeforeIntent() {
          constructedControllerHomes += 1;
        }
      }
    }),
    (error) => error?.code === "E_RETRY_EXHAUSTED"
  );
  assert.equal(constructedControllerHomes, 0);
  assert.deepEqual(
    fs.existsSync(taskHomes) ? fs.readdirSync(taskHomes).sort() : null,
    taskHomesBefore
  );
  assert.deepEqual(
    tryReadJob(fixture.root, fixture.workerId, fixture.env),
    exhaustedSnapshot
  );
  assert.throws(
    () => prepareWriteProvisioningReissue({
      root: fixture.root,
      principal: principal(fixture.root),
      workerId: fixture.workerId,
      executionBindingDigest: fixture.binding.bindingDigest,
      expectedJournalDigest:
        thirdRetained.job.provisioning.journalDigest,
      attemptId: "4".repeat(32),
      fence: 4,
      holderId: "5".repeat(32),
      executableIdentity: thirdExecutableIdentity,
      env: fixture.env
    }),
    (error) => error?.code === "E_STATE"
  );
  assert.deepEqual(
    tryReadJob(fixture.root, fixture.workerId, fixture.env),
    exhaustedSnapshot
  );
}

export async function prepareOfficialWorktreePromotion(t) {
  const fixture = plannedWriteProvisioningFixture("official-ready");
  const prepared = prepareProvisioningIntent(fixture);
  const { child, identity } = await detachedProvisioner(t, fixture.workerId);
  const provisioningAt = new Date(
    Math.max(Date.now(), Date.parse(prepared.intent.preparedAt) + 1)
  ).toISOString();
  const leaseExpiresAt = new Date(Date.parse(provisioningAt) + 60_000).toISOString();
  const activated = activateWriteProvisioningAttempt({
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
  });
  const registeredAt = new Date(
    Math.max(Date.now(), Date.parse(provisioningAt) + 1)
  ).toISOString();
  updateJob(fixture.root, fixture.workerId, (job) => ({
    ...job,
    provisioningRuntime: {
      ...job.provisioningRuntime,
      intent: {
        ...job.provisioningRuntime.intent,
        status: "registered",
        registeredAt,
        updatedAt: registeredAt
      }
    }
  }), fixture.env);
  const registered = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  assert.doesNotThrow(() => assertWriteExecutionJob(registered, fixture.env));

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
    sessionId: prepared.intent.operationId,
    worktreePath: official.executionRoot,
    sourceGitRoot: fixture.binding.controlRoot,
    commit: fixture.binding.baseCommit
  };
  const afterLeaseExpiry = new Date(
    Date.parse(activated.job.provisioning.leaseExpiresAt) + 1
  ).toISOString();
  assert.throws(
    () => recordOfficialWorktreeReceipt({
      root: fixture.root,
      principal: principal(fixture.root),
      workerId: fixture.workerId,
      executionBindingDigest: fixture.binding.bindingDigest,
      expectedJournalDigest: activated.job.provisioning.journalDigest,
      ...fixture.actor,
      providerSpawnIntentId: prepared.intent.intentId,
      officialReceipt,
      receivedAt: afterLeaseExpiry,
      env: fixture.env
    }),
    (error) => error?.code === "E_STATE"
  );
  for (const tamper of [
    { sessionId: "foreign-operation" },
    { worktreePath: path.join(fixture.root, "foreign") },
    { sourceGitRoot: path.dirname(fixture.root) },
    { commit: "0".repeat(fixture.binding.baseCommit.length) },
    { status: "creating" }
  ]) {
    assert.throws(
      () => recordOfficialWorktreeReceipt({
        root: fixture.root,
        principal: principal(fixture.root),
        workerId: fixture.workerId,
        executionBindingDigest: fixture.binding.bindingDigest,
        expectedJournalDigest: activated.job.provisioning.journalDigest,
        ...fixture.actor,
        providerSpawnIntentId: prepared.intent.intentId,
        officialReceipt: { ...officialReceipt, ...tamper },
        env: fixture.env
      }),
      (error) => ["E_STATE", "E_WORKTREE"].includes(error?.code)
    );
  }
  assert.throws(
    () => recordOfficialWorktreeReceipt({
      root: fixture.root,
      principal: principal(fixture.root),
      workerId: fixture.workerId,
      executionBindingDigest: fixture.binding.bindingDigest,
      expectedJournalDigest: activated.job.provisioning.journalDigest,
      ...fixture.actor,
      executableIdentity: {
        ...fixture.actor.executableIdentity,
        version: "0.2.111"
      },
      providerSpawnIntentId: prepared.intent.intentId,
      officialReceipt,
      env: fixture.env
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );

  const receivedAt = new Date(
    Math.max(Date.now(), Date.parse(registeredAt) + 1)
  ).toISOString();
  const recorded = recordOfficialWorktreeReceipt({
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: activated.job.provisioning.journalDigest,
    ...fixture.actor,
    providerSpawnIntentId: prepared.intent.intentId,
    officialReceipt,
    receivedAt,
    env: fixture.env
  });
  assert.equal(recorded.recorded, true);
  assert.equal(recorded.replayed, false);
  assert.equal(recorded.receipt.operationId, prepared.intent.operationId);
  assert.equal(recorded.receipt.officialSessionId, prepared.intent.operationId);
  assert.equal(recorded.receipt.worktreePath, fixture.binding.expectedExecutionRoot);
  assert.deepEqual(
    recorded.receipt.executableIdentity,
    fixture.actor.executableIdentity
  );
  assert.equal(recorded.receipt.hostVerification.baseCommit, fixture.binding.baseCommit);
  assert.match(recorded.receipt.receiptDigest, /^[a-f0-9]{64}$/);

  const receiptReplay = recordOfficialWorktreeReceipt({
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: activated.job.provisioning.journalDigest,
    ...fixture.actor,
    providerSpawnIntentId: prepared.intent.intentId,
    officialReceipt,
    receivedAt,
    env: fixture.env
  });
  assert.equal(receiptReplay.recorded, false);
  assert.equal(receiptReplay.replayed, true);
  assert.equal(receiptReplay.receipt.receiptDigest, recorded.receipt.receiptDigest);

  const liveProofAt = new Date(
    Math.max(Date.now(), Date.parse(receivedAt) + 1)
  ).toISOString();
  assert.throws(
    () => promoteWriteWorkerReady({
      root: fixture.root,
      principal: principal(fixture.root),
      workerId: fixture.workerId,
      executionBindingDigest: fixture.binding.bindingDigest,
      expectedJournalDigest: activated.job.provisioning.journalDigest,
      ...fixture.actor,
      providerSpawnIntentId: prepared.intent.intentId,
      executionContextManifest: captureContextManifest(official.executionRoot),
      cleanupProof: {
        processIdentity: identity,
        processGroupGone: true,
        providerGuardAbsent: true,
        observedAt: liveProofAt
      },
      env: fixture.env
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );

  process.kill(-child.pid, "SIGKILL");
  await waitFor(() => processGroupGone(identity), {
    timeoutMs: 5_000,
    intervalMs: 25
  });
  const executionContextManifest = captureContextManifest(official.executionRoot);
  const observedAt = new Date(
    Math.max(Date.now(), Date.parse(receivedAt) + 1)
  ).toISOString();
  const cleanupProof = {
    processIdentity: identity,
    processGroupGone: true,
    providerGuardAbsent: true,
    observedAt
  };
  return {
    fixture,
    prepared,
    identity,
    provisioningAt,
    activated,
    afterLeaseExpiry,
    recorded,
    official,
    executionContextManifest,
    observedAt,
    cleanupProof
  };
}

export function completeOfficialWorktreePromotion(context) {
  const {
    fixture,
    prepared,
    identity,
    provisioningAt,
    activated,
    afterLeaseExpiry,
    recorded,
    official,
    executionContextManifest,
    observedAt,
    cleanupProof
  } = context;

  for (const incomplete of [
    { executionContextManifest: null, cleanupProof },
    { executionContextManifest, cleanupProof: null }
  ]) {
    assert.throws(
      () => promoteWriteWorkerReady({
        root: fixture.root,
        principal: principal(fixture.root),
        workerId: fixture.workerId,
        executionBindingDigest: fixture.binding.bindingDigest,
        expectedJournalDigest: activated.job.provisioning.journalDigest,
        ...fixture.actor,
        providerSpawnIntentId: prepared.intent.intentId,
        ...incomplete,
        env: fixture.env
      }),
      (error) => ["E_STATE", "E_CONTEXT_DRIFT", "E_PROCESS_IDENTITY"].includes(error?.code)
    );
  }
  assert.throws(
    () => promoteWriteWorkerReady({
      root: fixture.root,
      principal: principal(fixture.root),
      workerId: fixture.workerId,
      executionBindingDigest: fixture.binding.bindingDigest,
      expectedJournalDigest: activated.job.provisioning.journalDigest,
      ...fixture.actor,
      providerSpawnIntentId: prepared.intent.intentId,
      executionContextManifest,
      cleanupProof,
      readyAt: provisioningAt,
      env: fixture.env
    }),
    (error) => error?.code === "E_STATE"
  );

  const guardFile = providerGuardFile(fixture.root, fixture.workerId);
  fs.mkdirSync(path.dirname(guardFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(guardFile, "{ambiguous", { mode: 0o600 });
  assert.throws(
    () => promoteWriteWorkerReady({
      root: fixture.root,
      principal: principal(fixture.root),
      workerId: fixture.workerId,
      executionBindingDigest: fixture.binding.bindingDigest,
      expectedJournalDigest: activated.job.provisioning.journalDigest,
      ...fixture.actor,
      providerSpawnIntentId: prepared.intent.intentId,
      executionContextManifest,
      cleanupProof,
      env: fixture.env
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  fs.unlinkSync(guardFile);

  const unsafeIndexPromoteArgs = {
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: activated.job.provisioning.journalDigest,
    ...fixture.actor,
    providerSpawnIntentId: prepared.intent.intentId,
    executionContextManifest,
    cleanupProof,
    env: fixture.env
  };
  for (const [enable, disable] of [
    ["--assume-unchanged", "--no-assume-unchanged"],
    ["--skip-worktree", "--no-skip-worktree"]
  ]) {
    git(fixture.root, "update-index", enable, "tracked.txt");
    assert.throws(
      () => promoteWriteWorkerReady(unsafeIndexPromoteArgs),
      (error) => error?.code === "E_SCOPE_VIOLATION"
        && /unsafe Git index state/i.test(error.message)
        && !/tracked\.txt|assume-unchanged|skip-worktree/i.test(error.message)
    );
    git(fixture.root, "update-index", disable, "tracked.txt");
  }

  const parentTracked = path.join(fixture.root, "tracked.txt");
  const parentContents = fs.readFileSync(parentTracked, "utf8");
  fs.writeFileSync(parentTracked, "parent drift\n");
  assert.throws(
    () => promoteWriteWorkerReady({
      root: fixture.root,
      principal: principal(fixture.root),
      workerId: fixture.workerId,
      executionBindingDigest: fixture.binding.bindingDigest,
      expectedJournalDigest: activated.job.provisioning.journalDigest,
      ...fixture.actor,
      providerSpawnIntentId: prepared.intent.intentId,
      executionContextManifest,
      cleanupProof,
      env: fixture.env
    }),
    (error) => ["E_CONTEXT_DRIFT", "E_INTEGRATION"].includes(error?.code)
      && error?.code !== "E_SCOPE_VIOLATION"
      && !/unsafe Git index state/i.test(error.message)
  );
  fs.writeFileSync(parentTracked, parentContents);

  const readyAt = new Date(Math.max(
    Date.now(),
    Date.parse(recorded.receipt.hostVerification.verifiedAt) + 1,
    Date.parse(executionContextManifest.capturedAt) + 1,
    Date.parse(observedAt) + 1
  )).toISOString();
  assert.throws(
    () => promoteWriteWorkerReady({
      root: fixture.root,
      principal: principal(fixture.root),
      workerId: fixture.workerId,
      executionBindingDigest: fixture.binding.bindingDigest,
      expectedJournalDigest: activated.job.provisioning.journalDigest,
      ...fixture.actor,
      providerSpawnIntentId: prepared.intent.intentId,
      executionContextManifest,
      cleanupProof,
      readyAt: afterLeaseExpiry,
      env: fixture.env
    }),
    (error) => error?.code === "E_STATE"
  );
  const promoted = promoteWriteWorkerReady({
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: activated.job.provisioning.journalDigest,
    ...fixture.actor,
    providerSpawnIntentId: prepared.intent.intentId,
    executionContextManifest,
    cleanupProof,
    readyAt,
    env: fixture.env
  });
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.replayed, false);
  assert.equal(promoted.job.status, "queued");
  assert.equal(promoted.job.phase, "worktree-ready");
  assert.equal(promoted.job.provisioning.state, "ready");
  assert.equal(promoted.job.request.spawn.providerLaunchOutcome, "worktree-ready-no-dispatch");
  assert.equal(promoted.job.request.spawn.providerLaunchPending, false);
  assert.equal(promoted.job.request.spawn.providerLaunchInFlight, false);
  for (const field of [
    "dispatch",
    "executionRoot",
    "providerSpawnIntent",
    "contextBindingDigest",
    "requestDigest"
  ]) assert.equal(Object.hasOwn(promoted.job.request.spawn, field), false, field);
  for (const field of [
    "workerAuthorization",
    "controllerProcess",
    "workerProcess",
    "providerProcess",
    "grokSessionId"
  ]) assert.equal(Object.hasOwn(promoted.job, field), false, field);
  for (const field of [
    "contextPacket",
    "contextReceipt",
    "contextManifest",
    "providerPrompt",
    "providerPromptDigest",
    "resumeSessionId"
  ]) assert.equal(Object.hasOwn(promoted.job.request, field), false, field);
  assert.doesNotThrow(() => assertWriteExecutionJob(promoted.job, fixture.env));

  // Ready replay retains the immutable stored execution authority while a
  // fresh, semantically compatible capture can include unrelated shared-ref
  // churn and a different authenticated capture time/identity.
  git(
    fixture.root,
    "update-ref",
    "refs/codex/turn-diffs/ready-replay-fresh-capture",
    fixture.binding.baseCommit
  );
  const freshReplayContext = captureContextManifest(official.executionRoot);
  assert.notEqual(freshReplayContext.digest, executionContextManifest.digest);
  const replay = promoteWriteWorkerReady({
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: activated.job.provisioning.journalDigest,
    ...fixture.actor,
    providerSpawnIntentId: prepared.intent.intentId,
    executionContextManifest: freshReplayContext,
    cleanupProof,
    readyAt,
    env: fixture.env
  });
  assert.equal(replay.promoted, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.job.provisioning.journalDigest, promoted.job.provisioning.journalDigest);

  for (const corrupt of [
    (job) => { job.provisioningRuntime.officialReceipt.receiptDigest = "0".repeat(64); },
    (job) => { job.provisioningRuntime.cleanupProof = null; },
    (job) => { job.provisioningRuntime.executionContextManifest = null; },
    (job) => { job.workerAuthorization = "forged"; }
  ]) {
    const forged = structuredClone(promoted.job);
    corrupt(forged);
    assert.throws(
      () => assertWriteExecutionJob(forged, fixture.env),
      (error) => error?.code === "E_STATE"
    );
  }
}
