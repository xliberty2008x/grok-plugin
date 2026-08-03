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

test("write artifact rejection runs cleanup first and becomes one bounded failure", () => {
  const order = [];
  const outcome = settleWriteArtifactAfterRuntimeCleanup({
    job: { id: "task-artifact-rejection", write: true },
    pending: {
      status: "completed",
      phase: "done",
      completedAt: new Date().toISOString(),
      error: null,
      summary: "Provider claimed completion"
    },
    runtimeCleanup: () => {
      order.push("cleanup");
      return { ok: true };
    },
    persistArtifact: () => {
      order.push("artifact");
      throw new Error("private absolute path must never escape");
    }
  });
  assert.deepEqual(order, ["cleanup", "artifact"]);
  assert.equal(outcome.rejected, true);
  assert.equal(outcome.artifact, null);
  assert.equal(outcome.pending.status, "failed");
  assert.equal(outcome.pending.phase, "artifact-rejected");
  assert.deepEqual(outcome.pending.error, {
    code: "E_INTEGRATION",
    message: "Worker output failed bounded write-artifact validation."
  });
  assert.equal(JSON.stringify(outcome).includes("private absolute path"), false);

  let persisted = false;
  assert.throws(
    () => settleWriteArtifactAfterRuntimeCleanup({
      job: { id: "task-cleanup-blocked", write: true },
      pending: {
        status: "completed",
        phase: "done",
        completedAt: new Date().toISOString(),
        error: null,
        summary: "Provider claimed completion"
      },
      runtimeCleanup: { ok: false, warning: "still present" },
      persistArtifact: () => {
        persisted = true;
        return null;
      }
    }),
    (error) => error?.code === "E_RUNTIME_CLEANUP"
  );
  assert.equal(persisted, false);
});

test("generation-1 immutable authority rejects corruption; verified target.txt worktree rejects legacy capturedAt and gains one exact dispatch-v2 authorization", {
  skip: process.platform === "win32"
}, async (t) => {
  const fixture = plannedWriteVerticalFixture("ready-dispatch");
  const active = await activateRegisteredProvisioning(t, fixture);
  const official = createWorkerWorktree({
    controlRoot: fixture.root,
    baseCommit: fixture.binding.baseCommit,
    workerId: fixture.workerId,
    env: fixture.env
  });
  t.after(() => {
    try {
      git(fixture.root, "worktree", "remove", "--force", official.executionRoot);
    } catch {}
  });
  const receivedAt = new Date(
    Math.max(Date.now(), Date.parse(active.registeredAt) + 1)
  ).toISOString();
  const recorded = recordOfficialWorktreeReceipt({
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: active.activated.job.provisioning.journalDigest,
    ...fixture.actor,
    providerSpawnIntentId: active.prepared.intent.intentId,
    officialReceipt: {
      status: "created",
      sessionId: active.prepared.intent.operationId,
      worktreePath: official.executionRoot,
      sourceGitRoot: fixture.binding.controlRoot,
      commit: fixture.binding.baseCommit
    },
    receivedAt,
    env: fixture.env
  });
  process.kill(-active.child.pid, "SIGKILL");
  await waitFor(() => processGroupGone(active.identity), {
    timeoutMs: 5_000,
    intervalMs: 25
  });
  const executionContextManifest = captureContextManifest(official.executionRoot);
  const observedAt = new Date(
    Math.max(Date.now(), Date.parse(receivedAt) + 1)
  ).toISOString();
  const readyAt = new Date(Math.max(
    Date.now(),
    Date.parse(recorded.receipt.hostVerification.verifiedAt) + 1,
    Date.parse(executionContextManifest.capturedAt) + 1,
    Date.parse(observedAt) + 1
  )).toISOString();
  const cleanupProof = {
    processIdentity: active.identity,
    processGroupGone: true,
    providerGuardAbsent: true,
    observedAt
  };
  assert.throws(
    () => promoteWriteWorkerReady({
      root: fixture.root,
      principal: principal(fixture.root),
      workerId: fixture.workerId,
      executionBindingDigest: fixture.binding.bindingDigest,
      expectedJournalDigest: active.activated.job.provisioning.journalDigest,
      ...fixture.actor,
      providerSpawnIntentId: active.prepared.intent.intentId,
      executionContextManifest: legacyContextManifest(
        executionContextManifest
      ),
      cleanupProof,
      readyAt,
      env: fixture.env
    }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
  );
  promoteWriteWorkerReady({
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: active.activated.job.provisioning.journalDigest,
    ...fixture.actor,
    providerSpawnIntentId: active.prepared.intent.intentId,
    executionContextManifest,
    cleanupProof,
    readyAt,
    env: fixture.env
  });

  let capability = "c".repeat(64);
  const authority = brokerPrincipal(fixture.root);
  const authorized = authorizeReadyWriteWorkerDispatch({
    root: fixture.root,
    principal: authority,
    workerId: fixture.workerId,
    writeLifecycleCapabilityDigest: capability,
    validateWriteLifecycleCapability: () => capability,
    env: fixture.env
  });
  assert.equal(authorized.authorized, true);
  assert.equal(authorized.replayed, false);
  assert.equal(authorized.job.request.spawn.dispatch.schemaVersion, 2);
  assert.equal(authorized.job.request.spawn.dispatch.state, "pending");
  assert.equal(
    authorized.job.request.spawn.executionRoot,
    fixture.binding.expectedExecutionRoot
  );
  assert.equal(
    authorized.job.request.spawn.executionBindingDigest,
    fixture.binding.bindingDigest
  );
  assert.equal(
    authorized.job.request.spawn.providerCapabilityDigest,
    capability
  );
  assert.equal(authorized.job.profile.id, "rescue-write-v3");
  assert.equal(authorized.job.request.envelope.mode, "write");
  assert.deepEqual(authorized.job.request.envelope.scope, {
    include: ["target.txt"],
    exclude: []
  });
  assert.doesNotThrow(() => assertDispatchContract(authorized.job));
  assert.doesNotThrow(() => (
    assertDurableSpawnRequestBinding(authorized.job, fixture.env)
  ));

  for (const { name, mutate } of [
    {
      name: "executionBinding.scope",
      mutate(job) {
        job.executionBinding.scope = {
          include: ["outside.txt"],
          exclude: []
        };
      }
    },
    {
      name: "provisioning.state",
      mutate(job) {
        job.provisioning.state = "planned";
      }
    },
    {
      name: "provisioningRuntime manifest-record digest",
      mutate(job) {
        job.provisioningRuntime.executionContextManifestRecordDigest =
          "0".repeat(64);
      }
    },
    {
      name: "partial managed authority",
      mutate(job) {
        delete job.provisioningRuntime;
      }
    },
    {
      name: "dispatch downgrade with retained authority",
      mutate(job) {
        job.request.spawn.dispatch.schemaVersion = 1;
      }
    },
    {
      name: "missing admissionRequestDigest",
      mutate(job) {
        delete job.request.spawn.admissionRequestDigest;
      }
    },
    {
      name: "mismatched admissionRequestDigest",
      mutate(job) {
        job.request.spawn.admissionRequestDigest = "0".repeat(64);
      }
    },
    {
      name: "missing writeLifecycleCapabilityDigest",
      mutate(job) {
        delete job.request.spawn.writeLifecycleCapabilityDigest;
      }
    },
    {
      name: "mismatched write lifecycle capability",
      mutate(job) {
        job.request.spawn.writeLifecycleCapabilityDigest = "d".repeat(64);
      }
    },
    {
      name: "missing provider capability",
      mutate(job) {
        delete job.request.spawn.providerCapabilityDigest;
      }
    },
    {
      name: "mismatched retained control workspace",
      mutate(job) {
        job.controlWorkspaceId = `cws-${"0".repeat(32)}`;
      }
    },
    {
      name: "mismatched provider launch binding digest",
      mutate(job) {
        job.request.spawn.providerLaunchBindingDigest = "0".repeat(64);
      }
    },
    {
      name: "mismatched retained admission envelope",
      mutate(job) {
        job.request.envelope.digest = "0".repeat(64);
      }
    },
    {
      name: "prematurely privacy-scrubbed admission envelope",
      mutate(job) {
        const literal = job.request.envelope.userRequest;
        const userRequestDigest = crypto
          .createHash("sha256")
          .update(literal)
          .digest("hex");
        job.request.envelope.userRequest = null;
        job.request.envelope.userRequestDigest = userRequestDigest;
        if (job.request.envelope.objective === literal) {
          job.request.envelope.objective = userRequestDigest;
        }
        if (job.request.publicObjective === literal) {
          job.request.publicObjective = null;
        }
      }
    }
  ]) {
    const corrupted = structuredClone(authorized.job);
    mutate(corrupted);
    assert.throws(
      () => assertWorkerProviderLaunchPreparation(
        corrupted,
        {
          providerGeneration: 1,
          env: fixture.env
        }
      ),
      (error) => error?.code !== undefined
        && !String(error.message).includes(official.executionRoot),
      name
    );
  }

  // Dispatch-v2 alone is not provider authority. Before the exact generation
  // reaches provider-started, intended-scope dirtiness is still untrusted.
  const executionTarget = path.join(official.executionRoot, "target.txt");
  const executionTargetBefore = fs.readFileSync(executionTarget);
  fs.writeFileSync(executionTarget, "pre-provider mutation\n", "utf8");
  try {
    assert.throws(
      () => authorizeReadyWriteWorkerDispatch({
        root: fixture.root,
        principal: authority,
        workerId: fixture.workerId,
        writeLifecycleCapabilityDigest: capability,
        validateWriteLifecycleCapability: () => capability,
        env: fixture.env
      }),
      (error) => error?.code === "E_CONTEXT_DRIFT"
    );
    assert.throws(
      () => assertWorkerProviderLaunchPreparation(
        tryReadJob(fixture.root, fixture.workerId, fixture.env),
        {
          providerGeneration: 1,
          env: fixture.env
        }
      ),
      (error) => error?.code === "E_CONTEXT_DRIFT"
    );
  } finally {
    fs.writeFileSync(executionTarget, executionTargetBefore);
  }

  const authorizationId = authorized.job.workerAuthorization.authorizationId;
  const dispatchDigest = stableDigest(authorized.job.request.spawn.dispatch);
  const replay = authorizeReadyWriteWorkerDispatch({
    root: fixture.root,
    principal: authority,
    workerId: fixture.workerId,
    writeLifecycleCapabilityDigest: capability,
    validateWriteLifecycleCapability: () => capability,
    env: fixture.env
  });
  assert.equal(replay.authorized, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.job.workerAuthorization.authorizationId, authorizationId);
  assert.equal(stableDigest(replay.job.request.spawn.dispatch), dispatchDigest);

  capability = null;
  assert.throws(
    () => authorizeReadyWriteWorkerDispatch({
      root: fixture.root,
      principal: authority,
      workerId: fixture.workerId,
      writeLifecycleCapabilityDigest: "c".repeat(64),
      validateWriteLifecycleCapability: () => capability,
      env: fixture.env
    }),
    (error) => error?.code === "E_CAPABILITY"
  );

  fs.writeFileSync(
    path.join(fixture.root, "target.txt"),
    "parent drift\n",
    "utf8"
  );
  assert.throws(
    () => persistCompletedWriteArtifact(
      authorized.job,
      {
        status: "completed",
        phase: "done",
        completedAt: new Date().toISOString(),
        error: null,
        summary: "Provider claimed completion"
      },
      fixture.env
    ),
    (error) => error?.code === "E_INTEGRATION"
      && /Parent working tree changed/.test(error.message)
  );
});

test("write admission durably binds one planned journal without creating launch authority", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const idempotencyKey = "spawn-write-plan-0001";
  const writeLifecycleCapabilityDigest = "c".repeat(64);
  const envelope = buildTaskEnvelope({
    userRequest: "Edit only target.txt",
    mode: "write",
    scope: {
      include: ["target.txt"],
      exclude: ["secrets/**"]
    },
    acceptanceCriteria: ["target.txt contains the requested change"],
    requiredVerification: ["node --test"]
  });
  const request = {
    root,
    principal: principal(root),
    envelope,
    idempotencyKey,
    roleId: "implementer",
    write: true,
    allowWriteSpawn: true,
    writeLifecycleCapabilityDigest,
    env
  };

  const first = spawnReadOnlyWorker(request);
  assert.equal(first.replayed, false);
  assert.equal(first.providerLaunchState, "not-ready");
  assert.equal(first.providerLaunched, false);
  assert.equal(first.handle.write, true);
  assert.equal(first.handle.phase, "provisioning-planned");

  const job = tryReadJob(root, first.handle.id, env);
  const binding = assertExecutionBinding(job.executionBinding, {
    workerId: job.id,
    controlWorkspaceId: job.controlWorkspaceId,
    scope: job.request.envelope.scope,
    envelopeDigest: job.request.envelope.digest,
    roleDigest: job.role.digest,
    providerCapabilityDigest: writeLifecycleCapabilityDigest
  });
  const journal = assertProvisioningJournal(binding, job.provisioning);
  assert.equal(journal.state, "planned");
  assert.equal(journal.journalRevision, 0);
  assert.equal(journal.bindingDigest, binding.bindingDigest);
  assert.equal(fs.existsSync(binding.expectedExecutionRoot), false);
  assert.equal(job.request.spawn.providerLaunchOutcome, "not-ready");
  assert.equal(job.request.spawn.providerLaunchPending, false);
  assert.equal(job.request.spawn.providerLaunchInFlight, false);
  for (const field of [
    "executionRoot",
    "requestDigest",
    "contextBindingDigest",
    "executionBindingDigest",
    "dispatch",
    "consumedLaunchContractDigest",
    "launchContractConsumedAt",
    "controllerSpawnIntent",
    "workerSpawnIntent",
    "providerSpawnIntent",
    "providerRotationIntent"
  ]) assert.equal(Object.hasOwn(job.request.spawn, field), false, field);
  for (const field of [
    "contextBindingMode",
    "contextPacket",
    "contextReceipt",
    "contextManifest",
    "providerPrompt",
    "providerPromptDigest"
  ]) assert.equal(Object.hasOwn(job.request, field), false, field);
  for (const field of [
    "workerAuthorization",
    "controllerProcess",
    "workerProcess",
    "providerProcess",
    "grokSessionId"
  ]) assert.equal(Object.hasOwn(job, field), false, field);
  assert.doesNotThrow(() => projectWorkerSnapshot(job, { trustHostAuthority: false }));

  const recordFile = spawnIdempotencyFile(root, idempotencyKey, env);
  const firstRecord = JSON.parse(fs.readFileSync(recordFile, "utf8"));
  assert.equal(firstRecord.schemaVersion, 5);
  assert.equal(firstRecord.workerId, job.id);
  assert.equal(firstRecord.expectedExecutionRoot, binding.expectedExecutionRoot);
  assert.equal(firstRecord.executionBindingDigest, binding.bindingDigest);
  assert.equal(
    firstRecord.admissionRequestDigest,
    job.request.spawn.admissionRequestDigest
  );
  assert.equal(firstRecord.responseWitness.responseSequence, 1);
  assert.equal(
    firstRecord.responseWitness.requestDigest,
    firstRecord.admissionRequestDigest
  );

  const replay = spawnReadOnlyWorker(request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.handle.id, first.handle.id);
  const replayedJob = tryReadJob(root, first.handle.id, env);
  assert.equal(replayedJob.provisioning.journalRevision, 0);
  assert.equal(replayedJob.provisioning.journalDigest, journal.journalDigest);
  assert.equal(replayedJob.lifecycleEvents.length, 1);
  assert.equal(listJobs(root, env).length, 1);
  assert.equal(
    JSON.parse(fs.readFileSync(recordFile, "utf8")).responseWitness.responseSequence,
    2
  );

  fs.unlinkSync(recordFile);
  const recovered = admitWriteWorkerPlan({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey,
    roleId: "implementer",
    allowWriteSpawn: true,
    writeLifecycleCapabilityDigest,
    env
  });
  assert.equal(recovered.replayed, true);
  assert.equal(recovered.handle.id, first.handle.id);
  assert.equal(tryReadJob(root, first.handle.id, env).provisioning.journalRevision, 0);
  assert.equal(listJobs(root, env).length, 1);

  for (const [enable, disable] of [
    ["--assume-unchanged", "--no-assume-unchanged"],
    ["--skip-worktree", "--no-skip-worktree"]
  ]) {
    git(root, "update-index", enable, "tracked.txt");
    assert.throws(
      () => spawnReadOnlyWorker(request),
      (error) => error?.code === "E_SCOPE_VIOLATION"
        && /unsafe Git index state/i.test(error.message)
        && !/tracked\.txt|assume-unchanged|skip-worktree/i.test(error.message)
    );
    git(root, "update-index", disable, "tracked.txt");
  }
  assert.equal(spawnReadOnlyWorker(request).handle.id, first.handle.id);
});

test("write admission is cross-process idempotent under the workspace transaction", async () => {
  const root = initRepo();
  const { env } = envFor(root);
  const source = `
    import { spawnReadOnlyWorker } from ${JSON.stringify(MUTATION_MODULE)};
    import { buildTaskEnvelope } from ${JSON.stringify(TASK_CONTRACT_MODULE)};
    const result = spawnReadOnlyWorker({
      root: ${JSON.stringify(root)},
      env: ${JSON.stringify(env)},
      principal: ${JSON.stringify(principal(root))},
      envelope: buildTaskEnvelope({
        userRequest: "Concurrent bounded write admission",
        mode: "write",
        scope: { include: ["tracked.txt"], exclude: [] }
      }),
      idempotencyKey: "spawn-write-cross-process-0001",
      roleId: "implementer",
      write: true,
      allowWriteSpawn: true,
      writeLifecycleCapabilityDigest: ${JSON.stringify("c".repeat(64))}
    });
    console.log(JSON.stringify(result));
  `;
  const runs = await Promise.all([runIsolatedModule(source), runIsolatedModule(source)]);
  for (const run of runs) assert.equal(run.code, 0, run.stderr);
  const results = runs.map((run) => lastJson(run.stdout));
  assert.equal(results[0].handle.id, results[1].handle.id);
  assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
  assert.equal(results[0].providerLaunchState, "not-ready");
  assert.equal(results[1].providerLaunchState, "not-ready");
  assert.equal(results[0].providerLaunched, false);
  assert.equal(results[1].providerLaunched, false);

  const jobs = listJobs(root, env);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].provisioning.state, "planned");
  assert.equal(jobs[0].provisioning.journalRevision, 0);
  assert.equal(jobs[0].lifecycleEvents.length, 1);
  assert.equal(
    Object.hasOwn(jobs[0].request.spawn, "dispatch"),
    false
  );
});

test("write admission requires a distinct capability and fails closed on dirty or mismatched input", () => {
  const capability = "d".repeat(64);
  const envelopeFor = (scope = ["target.txt"]) => buildTaskEnvelope({
    userRequest: "Bounded write admission",
    mode: "write",
    scope: { include: scope, exclude: [] }
  });

  {
    const root = initRepo();
    const { env } = envFor(root);
    assert.throws(
      () => admitWriteWorkerPlan({
        root,
        principal: principal(root),
        envelope: envelopeFor(),
        idempotencyKey: "spawn-write-capability-0001",
        allowWriteSpawn: true,
        env
      }),
      (error) => error?.code === "E_CAPABILITY"
    );
    assert.equal(
      fs.existsSync(path.join(workspaceState(root, env), "jobs")),
      false
    );
  }

  {
    const root = initRepo();
    const { env } = envFor(root);
    fs.writeFileSync(path.join(root, "untracked.txt"), "dirty\n");
    assert.throws(
      () => admitWriteWorkerPlan({
        root,
        principal: principal(root),
        envelope: envelopeFor(),
        idempotencyKey: "spawn-write-dirty-0001",
        allowWriteSpawn: true,
        writeLifecycleCapabilityDigest: capability,
        env
      }),
      (error) => error?.code === "E_WORKTREE"
    );
    assert.equal(listJobs(root, env).length, 0);
  }

  {
    const root = initRepo();
    const { env } = envFor(root);
    const base = {
      root,
      principal: principal(root),
      envelope: envelopeFor(),
      idempotencyKey: "spawn-write-mismatch-0001",
      allowWriteSpawn: true,
      writeLifecycleCapabilityDigest: capability,
      env
    };
    const admitted = admitWriteWorkerPlan(base);
    const before = tryReadJob(root, admitted.handle.id, env);
    for (const mismatch of [
      { ...base, envelope: envelopeFor(["other.txt"]) },
      { ...base, writeLifecycleCapabilityDigest: "e".repeat(64) },
      {
        ...base,
        principal: principal(root, {
          threadId: THREAD_B
        })
      }
    ]) {
      assert.throws(
        () => admitWriteWorkerPlan(mismatch),
        (error) => error?.code === "E_IDEMPOTENCY_CONFLICT"
      );
    }
    const after = tryReadJob(root, admitted.handle.id, env);
    assert.equal(after.provisioning.journalDigest, before.provisioning.journalDigest);
    assert.equal(after.lifecycleEvents.length, 1);
    assert.equal(listJobs(root, env).length, 1);
  }
});

test("write admission schema-v5 records and pre-ready jobs fail closed on tamper", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({
    userRequest: "Reject tampered write admission",
    mode: "write",
    scope: { include: ["tracked.txt"], exclude: [] }
  });
  const idempotencyKey = "spawn-write-tamper-0001";
  const request = {
    root,
    principal: principal(root),
    envelope,
    idempotencyKey,
    roleId: "implementer",
    write: true,
    allowWriteSpawn: true,
    writeLifecycleCapabilityDigest: "c".repeat(64),
    env
  };
  const admitted = spawnReadOnlyWorker(request);
  const recordFile = spawnIdempotencyFile(root, idempotencyKey, env);
  const originalRecord = JSON.parse(fs.readFileSync(recordFile, "utf8"));
  const recordCorruptions = [
    (record) => { record.expectedExecutionRoot = path.join(root, "foreign"); },
    (record) => { record.executionBindingDigest = "0".repeat(64); },
    (record) => { record.admissionRequestDigest = "0".repeat(64); },
    (record) => { record.responseWitness.requestDigest = "0".repeat(64); },
    (record) => { record.responseWitness.witnessId = `spawnw-${"0".repeat(24)}`; }
  ];
  for (const corrupt of recordCorruptions) {
    const record = structuredClone(originalRecord);
    corrupt(record);
    fs.writeFileSync(recordFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    assert.throws(
      () => spawnReadOnlyWorker(request),
      (error) => error?.code === "E_STATE"
        && !String(error.message).includes(admitted.handle.id)
    );
  }
  fs.writeFileSync(recordFile, `${JSON.stringify(originalRecord)}\n`, { mode: 0o600 });

  const jobFile = path.join(
    workspaceState(root, env),
    "jobs",
    `${admitted.handle.id}.json`
  );
  const originalJob = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  const jobCorruptions = [
    {
      name: "capability",
      mutate(job) {
        job.request.spawn.writeLifecycleCapabilityDigest = "e".repeat(64);
      },
      message: /execution binding does not match/i
    },
    {
      name: "role",
      mutate(job) {
        job.role.id = "explorer";
      },
      message: /role|digest/i
    },
    {
      name: "context",
      mutate(job) {
        job.request.admissionContextManifest.git.dirtyDigest = "e".repeat(64);
      },
      message: /workspace identity drifted|context/i
    },
    {
      name: "pre-ready authority",
      mutate(job) {
        job.request.spawn.executionRoot = job.executionBinding.expectedExecutionRoot;
      },
      message: /launch or provider authority/i
    },
    {
      name: "pre-ready launch pending",
      mutate(job) {
        job.request.spawn.providerLaunchPending = true;
      },
      message: /launch or provider authority/i
    },
    {
      name: "pre-ready launch outcome",
      mutate(job) {
        job.request.spawn.providerLaunchOutcome = "started";
      },
      message: /launch or provider authority/i
    },
    {
      name: "pre-ready runtime policy",
      mutate(job) {
        job.request.runtimeRolePolicy = { digest: "f".repeat(64) };
      },
      message: /launch or provider authority/i
    },
    {
      name: "pre-ready prompt",
      mutate(job) {
        job.request.providerPromptDigest = "f".repeat(64);
      },
      message: /launch or provider authority/i
    },
    {
      name: "pre-ready resume authority",
      mutate(job) {
        job.request.resumeSessionId = "session-that-must-not-exist";
      },
      message: /launch or provider authority/i
    },
    {
      name: "pre-ready cleanup authority",
      mutate(job) {
        job.request.spawn.cleanupRequired = true;
      },
      message: /launch or provider authority/i
    }
  ];
  for (const { name, mutate, message } of jobCorruptions) {
    const job = structuredClone(originalJob);
    mutate(job);
    fs.writeFileSync(jobFile, `${JSON.stringify(job)}\n`, { mode: 0o600 });
    assert.throws(
      () => spawnReadOnlyWorker(request),
      (error) => error?.code !== undefined
        && message.test(String(error.message))
        && !String(error.message).includes(admitted.handle.id),
      name
    );
  }
  fs.writeFileSync(jobFile, `${JSON.stringify(originalJob)}\n`, { mode: 0o600 });

  const provisioningAt = new Date(Date.parse(originalJob.createdAt) + 1_000).toISOString();
  const leaseExpiresAt = new Date(Date.parse(originalJob.createdAt) + 31_000).toISOString();
  const readyAt = new Date(Date.parse(originalJob.createdAt) + 2_000).toISOString();
  const provisioning = transitionProvisioningJournal(
    originalJob.executionBinding,
    originalJob.provisioning,
    {
      state: "provisioning",
      expectedCurrentJournalDigest: originalJob.provisioning.journalDigest,
      attemptId: "a".repeat(32),
      fence: 1,
      provisioner: {
        pid: 42,
        startToken: "test-process-start-token",
        holderId: "b".repeat(32)
      },
      leaseExpiresAt,
      provisioningAt
    }
  );
  const ready = transitionProvisioningJournal(
    originalJob.executionBinding,
    provisioning,
    {
      state: "ready",
      expectedCurrentJournalDigest: provisioning.journalDigest,
      actorAttemptId: provisioning.attemptId,
      actorFence: provisioning.fence,
      actorHolderId: provisioning.provisioner.holderId,
      readyAt,
      executionContextManifestId: `ctx-${"f".repeat(24)}`,
      executionContextManifestDigest: "f".repeat(64)
    }
  );
  const forgedPartialReadyJob = structuredClone(originalJob);
  forgedPartialReadyJob.provisioning = ready;
  fs.writeFileSync(
    jobFile,
    `${JSON.stringify(forgedPartialReadyJob)}\n`,
    { mode: 0o600 }
  );
  assert.throws(
    () => spawnReadOnlyWorker(request),
    (error) => error?.code === "E_STATE"
      && /launch or provider authority|ready write provisioning runtime/i.test(String(error.message))
  );
  fs.writeFileSync(jobFile, `${JSON.stringify(originalJob)}\n`, { mode: 0o600 });
  assert.equal(spawnReadOnlyWorker(request).handle.id, admitted.handle.id);
});

test("spawn binds role capability, envelope mode, and job write flag", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const readEnvelope = buildTaskEnvelope({ userRequest: "Inspect", mode: "read" });
  const writeEnvelope = buildTaskEnvelope({ userRequest: "Edit", mode: "write" });

  assert.throws(
    () => spawnReadOnlyWorker({
      root,
      principal: principal(root),
      envelope: readEnvelope,
      idempotencyKey: "spawn-role-write-on-read-0001",
      roleId: "implementer",
      env
    }),
    (error) => error?.code === "E_ROLE"
  );
  assert.throws(
    () => spawnReadOnlyWorker({
      root,
      principal: principal(root),
      envelope: writeEnvelope,
      idempotencyKey: "spawn-role-read-on-write-0001",
      roleId: "explorer",
      write: true,
      allowWriteSpawn: true,
      env
    }),
    (error) => error?.code === "E_ROLE"
  );
  assert.throws(
    () => spawnReadOnlyWorker({
      root,
      principal: principal(root),
      envelope: writeEnvelope,
      idempotencyKey: "spawn-mode-mismatch-0001",
      roleId: "explorer",
      allowWriteSpawn: true,
      env
    }),
    (error) => error?.code === "E_ROLE"
  );
});
