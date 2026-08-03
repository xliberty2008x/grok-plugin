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
  prepareExactWriteLifecycle,
  verifyExactWriteLifecycleReplay,
  verifyExactWriteRecovery,
  verifyExactWriteControlAndNoIntent,
  verifyExactWriteSignalAndUnavailable,
  verifyExactWriteUnsafeAndPartial
} from "./worker-mutation-terminal-test-support.mjs";

test("issue #34 lifecycle exact write spawn replay returns the original handle after dispatch and terminal state", {
  skip: process.platform === "win32"
}, async (t) => {
  const context = await prepareExactWriteLifecycle(t);
  verifyExactWriteLifecycleReplay(context);
  const recoveryBase = await verifyExactWriteRecovery(context);
  verifyExactWriteControlAndNoIntent(context);
  verifyExactWriteSignalAndUnavailable(context);
  verifyExactWriteUnsafeAndPartial(context, recoveryBase);
});

test("issue #34 lifecycle rejects task-relevant control/execution drift and retained stored IDs", {
  skip: process.platform === "win32"
}, async (t) => {
  const fixture = plannedWriteVerticalFixture("issue34-negatives");
  const writeLifecycleCapabilityDigest = "c".repeat(64);
  const workerId = fixture.workerId;
  const active = await activateRegisteredProvisioning(t, fixture);
  const official = createWorkerWorktree({
    controlRoot: fixture.root,
    baseCommit: fixture.binding.baseCommit,
    workerId,
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
    workerId,
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
  promoteWriteWorkerReady({
    root: fixture.root,
    principal: principal(fixture.root),
    workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: active.activated.job.provisioning.journalDigest,
    ...fixture.actor,
    providerSpawnIntentId: active.prepared.intent.intentId,
    executionContextManifest,
    cleanupProof: {
      processIdentity: active.identity,
      processGroupGone: true,
      providerGuardAbsent: true,
      observedAt
    },
    readyAt,
    env: fixture.env
  });

  const authority = brokerPrincipal(fixture.root);
  const jobFile = path.join(
    workspaceState(fixture.root, fixture.env),
    "jobs",
    `${workerId}.json`
  );
  const readyBytes = fs.readFileSync(jobFile);
  const authorize = () => authorizeReadyWriteWorkerDispatch({
    root: fixture.root,
    principal: authority,
    workerId,
    writeLifecycleCapabilityDigest,
    validateWriteLifecycleCapability: () => writeLifecycleCapabilityDigest,
    env: fixture.env
  });

  // Active control branch/HEAD target change.
  const controlHead = git(fixture.root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(fixture.root, "control-branch-move.txt"), "x\n");
  git(fixture.root, "add", "control-branch-move.txt");
  git(fixture.root, "commit", "-m", "control branch move");
  assert.throws(
    authorize,
    (error) => error?.code === "E_CONTEXT_DRIFT" || error?.code === "E_INTEGRATION"
  );
  assert.equal(fs.readFileSync(jobFile).equals(readyBytes), true);
  git(fixture.root, "reset", "--hard", controlHead);

  // Linked execution HEAD/branch target change.
  fs.writeFileSync(path.join(official.executionRoot, "exec-branch-move.txt"), "y\n");
  git(official.executionRoot, "add", "exec-branch-move.txt");
  git(official.executionRoot, "commit", "-m", "execution branch move");
  assert.throws(
    authorize,
    (error) => error?.code === "E_CONTEXT_DRIFT" || error?.code === "E_WORKTREE"
  );
  assert.equal(fs.readFileSync(jobFile).equals(readyBytes), true);
  git(official.executionRoot, "reset", "--hard", controlHead);

  // Shared config drift.
  const configPath = path.join(fixture.root, ".git", "config");
  const previousConfig = fs.readFileSync(configPath);
  fs.appendFileSync(configPath, "\n[grok-issue34]\n\tvalue = reject\n");
  assert.throws(authorize, (error) => error?.code === "E_CONTEXT_DRIFT");
  assert.equal(fs.readFileSync(jobFile).equals(readyBytes), true);
  fs.writeFileSync(configPath, previousConfig);

  // Shared hook drift under default hooks path.
  const hooksDir = path.join(fixture.root, ".git", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, "pre-commit");
  const hadHook = fs.existsSync(hookPath);
  const previousHook = hadHook ? fs.readFileSync(hookPath) : null;
  fs.writeFileSync(hookPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.throws(authorize, (error) => error?.code === "E_CONTEXT_DRIFT");
  assert.equal(fs.readFileSync(jobFile).equals(readyBytes), true);
  if (hadHook) fs.writeFileSync(hookPath, previousHook, { mode: 0o755 });
  else fs.unlinkSync(hookPath);

  // Stored admission-manifest tamper with stale digest/id.
  const readyJob = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  readyJob.request.admissionContextManifest = {
    ...readyJob.request.admissionContextManifest,
    git: {
      ...readyJob.request.admissionContextManifest.git,
      branch: "tampered-branch"
    }
  };
  fs.writeFileSync(jobFile, `${JSON.stringify(readyJob)}\n`, { mode: 0o600 });
  assert.throws(
    authorize,
    (error) => error?.code === "E_CONTEXT_DRIFT"
      && /integrity|tampered|malformed|drift/i.test(error.message)
  );
  fs.writeFileSync(jobFile, readyBytes, { mode: 0o600 });

  // Task-relevant shared ref (current control branch tip) remains fail-closed.
  const beforeTip = captureContextManifest(fixture.root);
  fs.writeFileSync(path.join(fixture.root, "tip-move.txt"), "tip\n");
  git(fixture.root, "add", "tip-move.txt");
  git(fixture.root, "commit", "-m", "tip move");
  assert.notEqual(
    captureContextManifest(fixture.root).git.taskRelevantMetadataIdentity,
    beforeTip.git.taskRelevantMetadataIdentity
  );
  assert.throws(authorize, (error) => error?.code === "E_CONTEXT_DRIFT" || error?.code === "E_INTEGRATION");
  assert.equal(fs.readFileSync(jobFile).equals(readyBytes), true);
  git(fixture.root, "reset", "--hard", controlHead);

  // Unrelated control ref churn alone is authorized and retains stored IDs.
  git(fixture.root, "branch", "issue34-negative-unrelated", controlHead);
  const authorized = authorize();
  assert.equal(authorized.authorized, true);
  assert.equal(
    authorized.job.request.admissionContextManifest.manifestId,
    JSON.parse(readyBytes.toString("utf8")).request.admissionContextManifest.manifestId
  );
  assert.equal(
    authorized.job.request.contextManifest.manifestId,
    executionContextManifest.manifestId
  );
});

test("issue #34 lifecycle primary read-worker replay rejects unrelated ref churn", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const head = git(root, "rev-parse", "HEAD");
  const envelope = buildTaskEnvelope({
    userRequest: "Read-only issue #34 confinement",
    mode: "read",
    scope: { include: ["tracked.txt"], exclude: [] }
  });
  const request = {
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "issue34-read-unrelated-ref-0001",
    roleId: "explorer",
    write: false,
    env
  };
  const first = spawnReadOnlyWorker(request);
  assert.equal(first.replayed, false);
  const job = tryReadJob(root, first.handle.id, env);
  const stored = assertContextManifestIntegrity(job.request.contextManifest);
  assert.equal(stored.git.linkedWorktree, false);

  git(root, "branch", "read-unrelated-local", head);
  git(root, "update-ref", "refs/codex/turn-diffs/read-1", head);
  // Passing the stored primary capture forces DEFAULT compatibility (strict).
  assert.throws(
    () => spawnReadOnlyWorker({ ...request, contextManifest: stored }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
  );
  // Same-key replay without an explicit capture rebuilds request digests from a
  // fresh primary capture and fail-closes against the durable admission.
  assert.throws(
    () => spawnReadOnlyWorker(request),
    (error) => error?.code === "E_IDEMPOTENCY_CONFLICT"
      || error?.code === "E_CONTEXT_DRIFT"
  );
  // Explicit DEFAULT policy confinement: supervisory is not used on read paths.
  assert.throws(
    () => assertContextCompatible(root, stored, {
      mode: "execute",
      metadataPolicy: CONTEXT_METADATA_POLICIES.DEFAULT
    }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
  );
  // Supervisory would tolerate the same primary unrelated churn, proving the
  // read path does not opt into managed-write policy.
  assert.doesNotThrow(() => assertContextCompatible(root, stored, {
    mode: "execute",
    metadataPolicy: CONTEXT_METADATA_POLICIES.SUPERVISORY_LINKED_WRITE
  }));
  const after = tryReadJob(root, first.handle.id, env);
  assert.equal(after.request.contextManifest.manifestId, stored.manifestId);
  assert.equal(after.request.contextManifest.digest, stored.digest);
});

test("all cleanup-safe pre-provider terminal paths observe final HEAD drift", {
  skip: process.platform === "win32"
}, async (t) => {
  const cancellationIntent = () => ({
    status: "cancelled",
    phase: "cancelled",
    completedAt: new Date().toISOString(),
    error: {
      code: "E_CANCELLED",
      message: "Cancellation completed before provider startup."
    },
    summary: "Cancelled"
  });
  const cases = [
    {
      name: "failed dispatch transition",
      async run(subtest) {
        const fixture = claimedReadDispatchFixture(
          "head-drift-transition-failed"
        );
        updateJob(fixture.root, fixture.workerId, (job) => ({
          ...job,
          error: {
            code: "E_PROCESS_IDENTITY",
            message: "Verified owned process signalling could not be completed.",
            details: {
              secondaryDiagnostic: {
                code: "EPERM",
                message: `kill EPERM ${fixture.root}/private-auth.json`
              }
            }
          }
        }), fixture.env);
        git(
          fixture.root,
          "commit",
          "--allow-empty",
          "-m",
          "terminal observation transition drift"
        );
        return {
          fixture,
          privateSignalCode: "EPERM",
          job: transitionWorkerDispatch({
            root: fixture.root,
            workerId: fixture.workerId,
            attemptId: fixture.claim.attemptId,
            fence: fixture.claim.fence,
            state: "failed",
            error: cancellationIntent().error,
            runtimeCleanup: { ok: true },
            env: fixture.env
          })
        };
      }
    },
    {
      name: "unstarted dispatch loss",
      async run(subtest) {
        const fixture = claimedReadDispatchFixture(
          "head-drift-unstarted-loss"
        );
        return {
          fixture,
          job: settleUnstartedDispatchLoss({
            root: fixture.root,
            workerId: fixture.workerId,
            attemptId: fixture.claim.attemptId,
            dispatchState: "claimed",
            terminalIntent: cancellationIntent(),
            runtimeCleanup: () => {
              git(
                fixture.root,
                "commit",
                "--allow-empty",
                "-m",
                "terminal observation unstarted drift"
              );
              return { ok: true };
            },
            env: fixture.env
          })
        };
      }
    },
    {
      name: "live pre-provider finalization",
      async run(subtest) {
        const fixture = await workerStartedReadDispatchFixture(
          subtest,
          "head-drift-live-finalization"
        );
        git(
          fixture.root,
          "commit",
          "--allow-empty",
          "-m",
          "terminal observation live pre-provider drift"
        );
        return {
          fixture,
          job: settlePreProviderWorkerFinalization({
            root: fixture.root,
            workerId: fixture.workerId,
            attemptId: fixture.claim.attemptId,
            workerProcess: fixture.worker.identity,
            intendedTerminal: cancellationIntent(),
            runtimeCleanup: { ok: true },
            env: fixture.env
          })
        };
      }
    },
    {
      name: "failed dispatch cleanup recovery",
      async run(subtest) {
        const fixture = await workerStartedReadDispatchFixture(
          subtest,
          "head-drift-failed-cleanup"
        );
        const blocked = settlePreProviderWorkerFinalization({
          root: fixture.root,
          workerId: fixture.workerId,
          attemptId: fixture.claim.attemptId,
          workerProcess: fixture.worker.identity,
          intendedTerminal: cancellationIntent(),
          runtimeCleanup: {
            ok: false,
            warning: "Runtime cleanup is pending."
          },
          env: fixture.env
        });
        assert.equal(blocked.status, "running");
        assert.equal(blocked.phase, "cleanup-blocked");
        process.kill(-fixture.controller.child.pid, "SIGKILL");
        process.kill(-fixture.worker.child.pid, "SIGKILL");
        await waitFor(() => (
          processGroupGone(fixture.controller.identity)
          && processGroupGone(fixture.worker.identity)
        ), { timeoutMs: 5_000, intervalMs: 25 });
        return {
          fixture,
          job: settleFailedDispatchCleanup({
            root: fixture.root,
            workerId: fixture.workerId,
            attemptId: fixture.claim.attemptId,
            controllerProcess: fixture.controller.identity,
            workerProcess: fixture.worker.identity,
            runtimeCleanup: () => {
              git(
                fixture.root,
                "commit",
                "--allow-empty",
                "-m",
                "terminal observation failed cleanup drift"
              );
              return { ok: true };
            },
            reconciler: true,
            env: fixture.env
          })
        };
      }
    },
    {
      name: "broker-only queued cancellation",
      async run(subtest) {
        const root = initRepo();
        const { env } = envFor(root);
        const spawned = spawnReadOnlyWorker({
          root,
          principal: principal(root),
          envelope: buildTaskEnvelope({
            userRequest: "Observe queued cancellation terminal drift",
            mode: "read",
            scope: { include: ["tracked.txt"], exclude: [] }
          }),
          idempotencyKey: "terminal-observation-cancel-spawn-0001",
          env
        });
        git(
          root,
          "commit",
          "--allow-empty",
          "-m",
          "terminal observation queued cancellation drift"
        );
        cancelWorker({
          root,
          principal: principal(root),
          workerId: spawned.handle.id,
          idempotencyKey: "terminal-observation-cancel-0001",
          env
        });
        return {
          fixture: { root, env, workerId: spawned.handle.id },
          job: tryReadJob(root, spawned.handle.id, env)
        };
      }
    }
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const { fixture, job, privateSignalCode = null } =
        await entry.run(subtest);
      const persisted = tryReadJob(
        fixture.root,
        fixture.workerId,
        fixture.env
      );
      assert.equal(job.status, "failed");
      assert.equal(job.phase, "context-rejected");
      assert.equal(job.error.code, "E_CONTEXT_DRIFT");
      assert.equal(typeof persisted.error.message, "string");
      assert.ok(persisted.error.message.length > 0);
      const publicSnapshot = projectWorkerSnapshot(persisted);
      assert.equal(publicSnapshot.error.code, "E_CONTEXT_DRIFT");
      assert.equal(typeof publicSnapshot.error.message, "string");
      assert.notEqual(publicSnapshot.error.message, "undefined");
      assert.ok(job.error.details.reasons.includes("[HEAD]"));
      assert.equal(job.result.taskRuntimeCleaned, true);
      assert.equal(job.result.hostVerification, "not_run");
      assert.equal(job.result.runtimeEvidence.executionStatus, "failed");
      assert.ok(
        job.result.runtimeEvidence.observedChangedPaths.includes("[HEAD]")
      );
      assert.ok(job.completionContextManifest);
      assert.equal(
        job.result.runtimeEvidence.postContext.digest,
        job.completionContextManifest.digest
      );
      assert.equal(
        job.progress,
        "Task runtime cleanup completed; workspace safety review is required"
      );
      assert.equal(job.pendingTerminal, undefined);
      assert.notEqual(job.result.stopReason, "cancelled");
      assert.equal(job.request.spawn.dispatch.state, "failed");
      assert.doesNotThrow(() => assertDispatchContract(job));
      if (entry.name === "live pre-provider finalization") {
        assert.equal(
          persisted.lifecycleEvents.at(-1).summary,
          persisted.error.message
        );
      }
      if (privateSignalCode) {
        assert.equal(
          job.error.details.secondaryDiagnostic.code,
          privateSignalCode
        );
        const projected = projectWorkerSnapshot(job);
        assert.equal(
          JSON.stringify(projected).includes(privateSignalCode),
          false
        );
        assert.equal(
          JSON.stringify(projected).includes(fixture.root),
          false
        );
      }
    });
  }
});

test("provider-started cleanup reconciliation treats mixed-case ESRCH as benign", {
  skip: process.platform === "win32"
}, async (t) => {
  const fixture = await providerStartedReadDispatchFixture(
    t,
    "benign-mixed-case-esrch"
  );
  const completedAt = new Date().toISOString();
  updateJob(fixture.root, fixture.workerId, (job) => ({
    ...job,
    error: {
      code: "E_PROCESS_IDENTITY",
      message: "Verified owned process signalling could not be completed.",
      details: {
        secondaryDiagnostic: {
          code: "eSrCh",
          message: "signal ESRCH"
        }
      }
    },
    pendingTerminal: {
      status: "completed",
      phase: "done",
      completedAt,
      error: null,
      summary: "Provider completed"
    }
  }), fixture.env);
  process.kill(-fixture.provider.child.pid, "SIGKILL");
  await waitFor(() => processGroupGone(fixture.provider.identity), {
    timeoutMs: 5_000,
    intervalMs: 25
  });

  const settled = settleProviderStartedWorkerFinalization({
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    workerProcess: fixture.worker.identity,
    providerProcess: fixture.provider.identity,
    runtimeCleanup: { ok: true },
    env: fixture.env
  });
  assert.equal(settled.status, "completed");
  assert.equal(settled.phase, "done");
  assert.equal(settled.error, null);
  assert.equal(settled.completedAt, completedAt);
  assert.equal(settled.result.taskRuntimeCleaned, true);
  assert.equal(settled.result.runtimeEvidence.executionStatus, "completed");
  assert.ok(settled.completionContextManifest);
  assert.equal(settled.progress, "Task runtime cleanup completed");
  assert.equal(JSON.stringify(settled).includes("eSrCh"), false);
});

test("pre-provider final observation fails closed for scope and unavailable context", {
  skip: process.platform === "win32"
}, async (t) => {
  const terminalIntent = () => ({
    status: "cancelled",
    phase: "cancelled",
    completedAt: new Date().toISOString(),
    error: {
      code: "E_CANCELLED",
      message: "Cancellation completed before provider startup."
    },
    summary: "Cancelled"
  });
  const cases = [
    {
      name: "out-of-scope change",
      expectedCode: "E_SCOPE_VIOLATION",
      expectedPath: "outside-terminal-scope.txt",
      prepare() {},
      cleanup(fixture) {
        fs.writeFileSync(
          path.join(fixture.root, "outside-terminal-scope.txt"),
          "outside scope\n",
          "utf8"
        );
        return { ok: true };
      }
    },
    {
      name: "missing pre-context",
      expectedCode: "E_CONTEXT_DRIFT",
      unavailable: true,
      prepare(fixture) {
        updateJob(fixture.root, fixture.workerId, (job) => (
          rebindWorkerLaunchAuthorization({
            ...job,
            request: {
              ...job.request,
              contextManifest: null
            }
          })
        ), fixture.env);
      },
      cleanup() {
        return { ok: true };
      }
    },
    {
      name: "malformed pre-context",
      expectedCode: "E_CONTEXT_DRIFT",
      unavailable: true,
      prepare(fixture) {
        updateJob(fixture.root, fixture.workerId, (job) => (
          rebindWorkerLaunchAuthorization({
            ...job,
            request: {
              ...job.request,
              contextManifest: {
                ...job.request.contextManifest,
                digest: "0".repeat(64)
              }
            }
          })
        ), fixture.env);
      },
      cleanup() {
        return { ok: true };
      }
    },
    {
      name: "final capture unavailable",
      expectedCode: "E_CONTEXT_DRIFT",
      unavailable: true,
      prepare(fixture) {
        updateJob(fixture.root, fixture.workerId, (job) => (
          rebindWorkerLaunchAuthorization({
            ...job,
            request: {
              ...job.request,
              spawn: {
                ...job.request.spawn,
                executionRoot: path.join(fixture.root, "tracked.txt")
              }
            }
          })
        ), fixture.env);
      },
      cleanup() {
        return { ok: true };
      }
    }
  ];

  for (const [index, entry] of cases.entries()) {
    await t.test(entry.name, () => {
      const fixture = claimedReadDispatchFixture(
        `unavailable-${index}-${entry.name.replaceAll(" ", "-")}`
      );
      entry.prepare(fixture);
      let settled;
      try {
        settled = settleUnstartedDispatchLoss({
          root: fixture.root,
          workerId: fixture.workerId,
          attemptId: fixture.claim.attemptId,
          dispatchState: "claimed",
          terminalIntent: terminalIntent(),
          runtimeCleanup: () => entry.cleanup(fixture),
          env: fixture.env
        });
      } finally {
        fixture.restoreRoot?.();
      }
      assert.equal(settled.status, "failed");
      assert.equal(settled.error.code, entry.expectedCode);
      assert.equal(settled.result.taskRuntimeCleaned, true);
      assert.equal(settled.result.hostVerification, "not_run");
      assert.equal(settled.result.runtimeEvidence.executionStatus, "failed");
      assert.equal(
        settled.progress,
        "Task runtime cleanup completed; workspace safety review is required"
      );
      assert.equal(settled.pendingTerminal, undefined);
      assert.notEqual(settled.result.stopReason, "cancelled");
      if (entry.unavailable) {
        assert.deepEqual(
          settled.error.details.reasons,
          ["[final-context-unavailable]"]
        );
        assert.equal(settled.completionContextManifest, null);
        assert.equal(settled.result.runtimeEvidence.postContext, null);
      } else {
        assert.ok(settled.completionContextManifest);
        assert.ok(
          settled.error.details.paths.includes(entry.expectedPath)
        );
        assert.ok(
          settled.result.runtimeEvidence.scopeViolations.includes(
            entry.expectedPath
          )
        );
      }
    });
  }
});

test("managed pre-provider cancellation uses its bound linked-worktree observation", {
  skip: process.platform === "win32"
}, async (t) => {
  await t.test("unrelated shared refs remain tolerated", async (subtest) => {
    const fixture = await readyManagedWriteDispatchFixture(
      subtest,
      "terminal-observation-linked-refs"
    );
    const controlHead = git(fixture.root, "rev-parse", "HEAD");
    git(
      fixture.root,
      "update-ref",
      "refs/heads/terminal-observation-unrelated",
      controlHead
    );
    git(
      fixture.root,
      "update-ref",
      "refs/codex/turn-diffs/terminal-observation-unrelated",
      controlHead
    );
    const cancellation = cancelWorker({
      root: fixture.root,
      principal: principal(fixture.root),
      workerId: fixture.workerId,
      idempotencyKey: "terminal-observation-linked-cancel-0001",
      env: fixture.env
    });
    const settled = tryReadJob(
      fixture.root,
      fixture.workerId,
      fixture.env
    );
    assert.equal(cancellation.receipt.terminalRecordCommittedAt !== null, true);
    assert.equal(settled.status, "cancelled");
    assert.equal(settled.phase, "cancelled");
    assert.equal(settled.error, null);
    assert.equal(settled.result.stopReason, "cancelled");
    assert.equal(settled.result.taskRuntimeCleaned, true);
    assert.equal(settled.result.hostVerification, "not_run");
    assert.equal(
      settled.result.runtimeEvidence.executionStatus,
      "cancelled"
    );
    assert.deepEqual(settled.result.runtimeEvidence.scopeViolations, []);
    assert.deepEqual(settled.result.runtimeEvidence.sharedRefObservation, {
      schemaVersion: 1,
      classification: "tolerated_unrelated_shared_refs",
      toleratedUnrelatedSharedRefChurn: true,
      taskRelevantMetadataDrift: false
    });
    assert.equal(
      settled.completionContextManifest.workspaceRoot,
      fixture.official.executionRoot
    );
    assert.equal(
      settled.result.runtimeEvidence.postContext.digest,
      settled.completionContextManifest.digest
    );
    assert.equal(settled.progress, "Cancellation completed");
    assert.doesNotThrow(() => assertDispatchContract(settled));
  });

  await t.test("partial managed authority fails closed", async (subtest) => {
    const fixture = await readyManagedWriteDispatchFixture(
      subtest,
      "terminal-observation-partial-authority"
    );
    updateJob(fixture.root, fixture.workerId, (job) => {
      const corrupted = { ...job };
      delete corrupted.provisioningRuntime;
      return corrupted;
    }, fixture.env);
    cancelWorker({
      root: fixture.root,
      principal: principal(fixture.root),
      workerId: fixture.workerId,
      idempotencyKey: "terminal-observation-partial-cancel-0001",
      env: fixture.env
    });
    const settled = tryReadJob(
      fixture.root,
      fixture.workerId,
      fixture.env
    );
    assert.equal(settled.status, "failed");
    assert.equal(settled.phase, "context-rejected");
    assert.equal(settled.error.code, "E_CONTEXT_DRIFT");
    assert.deepEqual(
      settled.error.details.reasons,
      ["[final-context-unavailable]"]
    );
    assert.equal(settled.completionContextManifest, null);
    assert.equal(settled.result.taskRuntimeCleaned, true);
    assert.equal(settled.result.hostVerification, "not_run");
    assert.equal(settled.result.runtimeEvidence.executionStatus, "failed");
    assert.equal(settled.result.runtimeEvidence.postContext, null);
    assert.notEqual(settled.result.stopReason, "cancelled");
    assert.equal(
      settled.progress,
      "Task runtime cleanup completed; workspace safety review is required"
    );
    assert.equal(settled.request.spawn.dispatch.state, "failed");
    assert.doesNotThrow(() => assertDispatchContract(settled));
  });
});
