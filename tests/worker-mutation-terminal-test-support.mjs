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

export async function prepareExactWriteLifecycle(t) {
  const fixture = plannedWriteVerticalFixture("dispatched-spawn-replay");
  const idempotencyKey = "write-vertical-dispatched-spawn-replay-0001";
  const writeLifecycleCapabilityDigest = "c".repeat(64);
  const spawnRequest = {
    root: fixture.root,
    principal: principal(fixture.root),
    envelope: fixture.envelope,
    idempotencyKey,
    roleId: "implementer",
    write: true,
    allowWriteSpawn: true,
    writeLifecycleCapabilityDigest,
    env: fixture.env
  };
  const workerId = fixture.workerId;
  const storedAdmissionBefore = assertContextManifestIntegrity(
    tryReadJob(fixture.root, workerId, fixture.env).request.admissionContextManifest
  );
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
  const storedExecutionBefore = assertContextManifestIntegrity(executionContextManifest);
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

  // AC-4: unrelated control local branch churn after ready, before authorization.
  const controlHead = git(fixture.root, "rev-parse", "HEAD");
  git(fixture.root, "branch", "issue34-unrelated-control", controlHead);

  const authority = brokerPrincipal(fixture.root);
  const authorized = authorizeReadyWriteWorkerDispatch({
    root: fixture.root,
    principal: authority,
    workerId,
    writeLifecycleCapabilityDigest,
    validateWriteLifecycleCapability: () => writeLifecycleCapabilityDigest,
    env: fixture.env
  });
  assert.equal(authorized.authorized, true);
  assert.equal(authorized.job.request.spawn.dispatch.schemaVersion, 2);
  assert.equal(authorized.job.request.spawn.dispatch.state, "pending");
  assert.equal(
    authorized.job.request.admissionContextManifest.manifestId,
    storedAdmissionBefore.manifestId
  );
  assert.equal(
    authorized.job.request.admissionContextManifest.digest,
    storedAdmissionBefore.digest
  );
  assert.equal(
    authorized.job.request.contextManifest.manifestId,
    storedExecutionBefore.manifestId
  );
  assert.equal(
    authorized.job.request.contextManifest.digest,
    storedExecutionBefore.digest
  );
  assert.equal(
    authorized.job.provisioning.executionContextManifestId,
    storedExecutionBefore.manifestId
  );
  const journalDigestBeforeReplay = authorized.job.provisioning.journalDigest;
  const lifecycleBeforeReplay = authorized.job.lifecycleEvents.length;

  // A pre-provider dispatch replay remains exact without changing launch state.
  const preProviderTarget = path.join(official.executionRoot, "target.txt");
  const preProviderTargetBefore = fs.readFileSync(preProviderTarget);
  fs.writeFileSync(preProviderTarget, "untrusted pre-provider edit\n", "utf8");
  try {
    assert.throws(
      () => spawnReadOnlyWorker(spawnRequest),
      (error) => error?.code === "E_CONTEXT_DRIFT"
    );
  } finally {
    fs.writeFileSync(preProviderTarget, preProviderTargetBefore);
  }
  const dispatchedReplay = spawnReadOnlyWorker(spawnRequest);
  assert.equal(dispatchedReplay.replayed, true);
  assert.equal(dispatchedReplay.handle.id, workerId);
  assert.equal(dispatchedReplay.providerLaunched, false);
  const afterDispatchedReplay = tryReadJob(fixture.root, workerId, fixture.env);
  assert.equal(afterDispatchedReplay.provisioning.journalDigest, journalDigestBeforeReplay);
  assert.equal(afterDispatchedReplay.lifecycleEvents.length, lifecycleBeforeReplay);
  assert.equal(listJobs(fixture.root, fixture.env).length, 1);
  assert.equal(afterDispatchedReplay.request.spawn.dispatch.state, "pending");
  assert.doesNotThrow(() => assertDispatchContract(afterDispatchedReplay));

  const workerReport = `GROK_WORKER_REPORT: ${JSON.stringify({
    outcome: "complete",
    summary: "Write vertical completed",
    changedFiles: ["target.txt"],
    checksClaimed: [],
    acceptanceResults: fixture.envelope.acceptanceCriteria.map(
      ({ id }) => ({ id, status: "met" })
    ),
    risks: [],
    questions: []
  })}`;
  const fake = installFakeGrok(
    tempDir("grok-issue34-real-vertical-"),
    {
      taskText: workerReport,
      taskMutatePath: path.join(official.executionRoot, "target.txt"),
      taskMutation: "after\n",
      delayMs: 20_000
    }
  );
  const lifecycleEnv = testEnvironment({
    fake,
    pluginData: fixture.env.GROK_COMPANION_PLUGIN_DATA,
    sessionId: THREAD,
    extra: {
      ...fixture.env,
      GROK_COMPANION_HOST: "codex",
      GROK_COMPANION_HOST_SESSION_ID: THREAD,
      CODEX_THREAD_ID: THREAD,
      GROK_COMPANION_PLUGIN_DATA:
        fixture.env.GROK_COMPANION_PLUGIN_DATA
    }
  });
  delete lifecycleEnv.GROK_COMPANION_CHILD;
  delete lifecycleEnv.GROK_COMPANION_JOB_MARKER;
  delete lifecycleEnv.GROK_AGENT;
  delete lifecycleEnv.GROK_LEADER_SOCKET;

  const launched = launchCommittedWorker({
    root: fixture.root,
    workerId,
    principal: { hostKind: "codex", threadId: THREAD },
    env: lifecycleEnv
  });
  assert.equal(launched.claimed, true);
  await waitFor(() => {
    const current = tryReadJob(fixture.root, workerId, lifecycleEnv);
    return current?.request?.spawn?.dispatch?.state === "provider-started"
      ? current
      : null;
  }, { timeoutMs: 20_000, intervalMs: 25 });

  // Mutate unrelated shared refs only after the provider generation starts.
  git(
    fixture.root,
    "update-ref",
    "refs/heads/issue34-provider-local",
    controlHead
  );
  git(
    fixture.root,
    "update-ref",
    "refs/remotes/origin/issue34-provider-remote",
    controlHead
  );
  git(
    fixture.root,
    "update-ref",
    "refs/codex/turn-diffs/issue34-provider-started",
    controlHead
  );
  await waitFor(
    () => fs.readFileSync(
      path.join(official.executionRoot, "target.txt"),
      "utf8"
    ) === "after\n",
    { timeoutMs: 10_000, intervalMs: 25 }
  );

  const activeProviderReplay = authorizeReadyWriteWorkerDispatch({
    root: fixture.root,
    principal: authority,
    workerId,
    writeLifecycleCapabilityDigest,
    validateWriteLifecycleCapability: () => writeLifecycleCapabilityDigest,
    env: lifecycleEnv
  });
  assert.equal(activeProviderReplay.authorized, false);
  assert.equal(activeProviderReplay.replayed, true);
  assert.equal(activeProviderReplay.job.id, workerId);

  const replayAuthorization = () => authorizeReadyWriteWorkerDispatch({
    root: fixture.root,
    principal: authority,
    workerId,
    writeLifecycleCapabilityDigest,
    validateWriteLifecycleCapability: () => writeLifecycleCapabilityDigest,
    env: lifecycleEnv
  });
  const expectRejectedReplay = (mutate, restore, acceptedCodes) => {
    mutate();
    try {
      assert.throws(
        replayAuthorization,
        (error) => acceptedCodes.includes(error?.code)
      );
      assert.throws(
        () => spawnReadOnlyWorker(spawnRequest),
        (error) => acceptedCodes.includes(error?.code)
      );
    } finally {
      restore();
    }
  };

  const sharedConfig = path.join(fixture.root, ".git", "config");
  const sharedConfigBefore = fs.readFileSync(sharedConfig);
  expectRejectedReplay(
    () => fs.appendFileSync(
      sharedConfig,
      "\n[grok-issue34-post-provider]\n\tvalue = reject\n"
    ),
    () => fs.writeFileSync(sharedConfig, sharedConfigBefore),
    ["E_CONTEXT_DRIFT", "E_INTEGRATION"]
  );

  const sharedHooks = path.join(fixture.root, ".git", "hooks");
  fs.mkdirSync(sharedHooks, { recursive: true });
  const postProviderHook = path.join(sharedHooks, "pre-commit");
  const hookExisted = fs.existsSync(postProviderHook);
  const hookBefore = hookExisted ? fs.readFileSync(postProviderHook) : null;
  const hookMode = hookExisted ? fs.statSync(postProviderHook).mode & 0o777 : null;
  expectRejectedReplay(
    () => fs.writeFileSync(
      postProviderHook,
      "#!/bin/sh\nexit 1\n",
      { mode: 0o755 }
    ),
    () => {
      if (hookExisted) {
        fs.writeFileSync(postProviderHook, hookBefore, { mode: hookMode });
      } else {
        fs.unlinkSync(postProviderHook);
      }
    },
    ["E_CONTEXT_DRIFT", "E_INTEGRATION"]
  );

  const baseParent = git(
    official.executionRoot,
    "rev-parse",
    `${controlHead}^`
  );
  expectRejectedReplay(
    () => git(official.executionRoot, "update-ref", "HEAD", baseParent),
    () => git(official.executionRoot, "update-ref", "HEAD", controlHead),
    ["E_CONTEXT_DRIFT", "E_WORKTREE"]
  );

  expectRejectedReplay(
    () => git(official.executionRoot, "add", "target.txt"),
    () => git(official.executionRoot, "reset", "HEAD", "--", "target.txt"),
    ["E_CONTEXT_DRIFT", "E_SCOPE_VIOLATION"]
  );

  const executionGitDir = path.resolve(
    official.executionRoot,
    git(official.executionRoot, "rev-parse", "--git-dir")
  );
  const mergeRr = path.join(executionGitDir, "MERGE_RR");
  expectRejectedReplay(
    () => fs.writeFileSync(mergeRr, "post-provider-operational-state\n"),
    () => fs.unlinkSync(mergeRr),
    ["E_CONTEXT_DRIFT"]
  );

  const outOfScope = path.join(official.executionRoot, "outside.txt");
  expectRejectedReplay(
    () => fs.writeFileSync(outOfScope, "outside\n"),
    () => fs.unlinkSync(outOfScope),
    ["E_SCOPE_VIOLATION"]
  );
  assert.equal(replayAuthorization().replayed, true);

  const terminalJob = await waitFor(() => {
    const current = tryReadJob(fixture.root, workerId, lifecycleEnv);
    return ["completed", "failed", "cancelled"].includes(current?.status)
      ? current
      : null;
  }, { timeoutMs: 30_000, intervalMs: 50 });
  assert.equal(terminalJob.status, "completed");
  assert.equal(
    terminalJob.request.spawn.dispatch.state,
    "provider-started"
  );
  assert.equal(terminalJob.result.taskRuntimeCleaned, true);
  assert.equal(
    terminalJob.result.writeArtifact.contentDigest,
    crypto.createHash("sha256").update("after\n").digest("hex")
  );
  assert.equal(terminalJob.result.writeArtifact.path, "target.txt");
  assert.ok(terminalJob.completionContextManifest);
  assert.equal(terminalJob.result.runtimeEvidence.scopeViolations.length, 0);
  assert.ok(
    terminalJob.result.runtimeEvidence.observedChangedPaths.includes(
      "target.txt"
    )
  );
  assert.deepEqual(terminalJob.result.runtimeEvidence.sharedRefObservation, {
    schemaVersion: 1,
    classification: "tolerated_unrelated_shared_refs",
    toleratedUnrelatedSharedRefChurn: true,
    taskRelevantMetadataDrift: false
  });
  assert.equal(
    terminalJob.result.hostVerification,
    "not_run",
    "runtime never self-attests host verification"
  );
  assert.equal(
    fs.readFileSync(path.join(official.executionRoot, "target.txt"), "utf8"),
    "after\n"
  );
  assert.equal(
    terminalJob.request.admissionContextManifest.manifestId,
    storedAdmissionBefore.manifestId
  );
  assert.equal(
    terminalJob.request.contextManifest.manifestId,
    storedExecutionBefore.manifestId
  );
  assert.doesNotThrow(() => assertDispatchContract(terminalJob));
  return {
    fixture,
    idempotencyKey,
    writeLifecycleCapabilityDigest,
    spawnRequest,
    workerId,
    storedAdmissionBefore,
    storedExecutionBefore,
    official,
    journalDigestBeforeReplay,
    lifecycleEnv,
    outOfScope
  };
}

export function verifyExactWriteLifecycleReplay(context) {
  const {
    fixture,
    idempotencyKey,
    writeLifecycleCapabilityDigest,
    spawnRequest,
    workerId,
    storedAdmissionBefore,
    storedExecutionBefore,
    official,
    journalDigestBeforeReplay,
    lifecycleEnv,
    outOfScope
  } = context;
  // Host verification may legitimately generate or adjust an in-scope tracked
  // file. The stored verification baseline, not the older completion capture,
  // becomes the live terminal-replay baseline after scope validation.
  fs.writeFileSync(
    path.join(official.executionRoot, "target.txt"),
    "verification-adjusted\n",
    "utf8"
  );
  const diffCheck = run(
    "git",
    ["diff", "--check"],
    { cwd: official.executionRoot, env: lifecycleEnv }
  );
  assert.equal(diffCheck.status, 0, diffCheck.stderr);
  const verificationRun = runCompanion(
    [
      "record-verification",
      workerId,
      "--verification-stdin",
      "--json"
    ],
    {
      cwd: official.executionRoot,
      env: lifecycleEnv,
      input: JSON.stringify({
        commandOutcomes: [{
          command: "git diff --check",
          status: "passed",
          exitCode: 0
        }]
      })
    }
  );
  assert.equal(
    verificationRun.status,
    0,
    `record-verification failed\nstdout: ${verificationRun.stdout}\nstderr: ${verificationRun.stderr}`
  );
  const verifiedTerminalJob = tryReadJob(
    fixture.root,
    workerId,
    lifecycleEnv
  );
  assert.equal(verifiedTerminalJob.result.hostVerification, "passed");
  assert.ok(verifiedTerminalJob.verificationContextManifest);
  assert.deepEqual(
    verifiedTerminalJob.result.verification.observedChangedPaths,
    ["target.txt"]
  );
  assert.deepEqual(verifiedTerminalJob.commandOutcomes, [{
    command: "git diff --check",
    status: "passed",
    exitCode: 0
  }]);

  fs.writeFileSync(outOfScope, "terminal replay drift\n", "utf8");
  try {
    assert.throws(
      () => spawnReadOnlyWorker(spawnRequest),
      (error) => error?.code === "E_CONTEXT_DRIFT"
        || error?.code === "E_SCOPE_VIOLATION"
    );
  } finally {
    fs.unlinkSync(outOfScope);
  }
  const terminalReplay = spawnReadOnlyWorker(spawnRequest);
  assert.equal(terminalReplay.replayed, true);
  assert.equal(terminalReplay.handle.id, workerId);
  assert.equal(terminalReplay.handle.status, "completed");
  assert.equal(terminalReplay.providerLaunched, false);
  const afterTerminalReplay = tryReadJob(fixture.root, workerId, fixture.env);
  assert.equal(afterTerminalReplay.status, "completed");
  assert.equal(afterTerminalReplay.provisioning.journalDigest, journalDigestBeforeReplay);
  assert.equal(listJobs(fixture.root, fixture.env).length, 1);
  assert.equal(
    afterTerminalReplay.request.admissionContextManifest.digest,
    storedAdmissionBefore.digest
  );
  assert.equal(
    afterTerminalReplay.request.contextManifest.digest,
    storedExecutionBefore.digest
  );

  const recordFile = spawnIdempotencyFile(fixture.root, idempotencyKey, fixture.env);
  fs.unlinkSync(recordFile);
  const recovered = admitWriteWorkerPlan({
    root: fixture.root,
    principal: principal(fixture.root),
    envelope: fixture.envelope,
    idempotencyKey,
    roleId: "implementer",
    allowWriteSpawn: true,
    writeLifecycleCapabilityDigest,
    env: fixture.env
  });
  assert.equal(recovered.replayed, true);
  assert.equal(recovered.handle.id, workerId);
  assert.equal(recovered.handle.status, "completed");
  assert.equal(listJobs(fixture.root, fixture.env).length, 1);
  assert.equal(fs.existsSync(recordFile), true);

  const originalJob = structuredClone(tryReadJob(fixture.root, workerId, fixture.env));
  const jobFile = path.join(
    workspaceState(fixture.root, fixture.env),
    "jobs",
    `${workerId}.json`
  );
  const corruptions = [
    {
      name: "write identity",
      mutate(job) {
        job.write = false;
        job.role = {
          ...job.role,
          id: "explorer",
          write: false
        };
      }
    },
    {
      name: "execution binding digest",
      mutate(job) {
        job.request.spawn.executionBindingDigest = "0".repeat(64);
      }
    },
    {
      name: "capability",
      mutate(job) {
        job.request.spawn.writeLifecycleCapabilityDigest = "e".repeat(64);
        job.request.spawn.providerCapabilityDigest = "e".repeat(64);
        job.executionBinding = {
          ...job.executionBinding,
          providerCapabilityDigest: "e".repeat(64)
        };
      }
    },
    {
      name: "owner",
      mutate(job) {
        job.host = { ...job.host, sessionId: THREAD_B };
        job.request.spawn.ownerThreadId = THREAD_B;
      }
    },
    {
      name: "execution root",
      mutate(job) {
        job.request.spawn.executionRoot = path.join(fixture.root, "foreign-execution");
      }
    },
    {
      name: "admission digest",
      mutate(job) {
        job.request.spawn.admissionRequestDigest = "0".repeat(64);
      }
    },
    {
      name: "dispatch state",
      mutate(job) {
        job.request.spawn.dispatch = {
          ...job.request.spawn.dispatch,
          state: "pending"
        };
      }
    },
    {
      name: "provisioning journal",
      mutate(job) {
        job.provisioning = {
          ...job.provisioning,
          state: "planned"
        };
      }
    },
    {
      name: "provisioning runtime",
      mutate(job) {
        job.provisioningRuntime = {
          ...job.provisioningRuntime,
          executionContextManifestRecordDigest: "0".repeat(64)
        };
      }
    }
  ];
  for (const { name, mutate } of corruptions) {
    const corrupted = structuredClone(originalJob);
    mutate(corrupted);
    fs.writeFileSync(jobFile, `${JSON.stringify(corrupted)}\n`, { mode: 0o600 });
    assert.throws(
      () => spawnReadOnlyWorker(spawnRequest),
      (error) => error?.code !== undefined
        && !String(error.message).includes(workerId),
      name
    );
  }
  fs.writeFileSync(jobFile, `${JSON.stringify(originalJob)}\n`, { mode: 0o600 });
  assert.equal(spawnReadOnlyWorker(spawnRequest).handle.id, workerId);
}

export async function verifyExactWriteRecovery(context) {
  const { fixture, workerId, official, lifecycleEnv } = context;
  // Recovery finalization must retain the independently reconciled fresh
  // runtime evidence, then append its reconciler marker. It must not spread
  // the stale provider evidence back over the reconciled result.
  const recoveryBase = tryReadJob(fixture.root, workerId, lifecycleEnv);
  assert.ok(recoveryBase.controllerProcess);
  assert.ok(recoveryBase.workerProcess);
  assert.ok(recoveryBase.providerProcess);
  await waitFor(() => (
    processGroupGone(recoveryBase.controllerProcess)
    && processGroupGone(recoveryBase.workerProcess)
    && processGroupGone(recoveryBase.providerProcess)
  ), { timeoutMs: 10_000, intervalMs: 25 });
  const stalePostDigest = recoveryBase.result.runtimeEvidence.postContext.digest;
  const recoveryArtifactDirectory = path.join(
    workspaceState(fixture.root, lifecycleEnv),
    "artifacts",
    workerWorktreeSlug(workerId)
  );
  for (const entry of fs.readdirSync(recoveryArtifactDirectory)) {
    fs.unlinkSync(path.join(recoveryArtifactDirectory, entry));
  }
  fs.writeFileSync(
    path.join(official.executionRoot, "target.txt"),
    "recovery-final\n",
    "utf8"
  );
  updateJob(fixture.root, workerId, (job) => {
    const recoveredAt = new Date().toISOString();
    const revived = {
      ...job,
      status: "running",
      phase: "cleanup-blocked",
      completedAt: null,
      summary: "Awaiting recovery finalization",
      error: {
        code: "E_PROCESS_IDENTITY",
        message: "Worker recovery is blocked because exact runtime cleanup could not be verified.",
        details: {
          secondaryDiagnostic: {
            code: "EPERM",
            message: "kill EPERM"
          }
        }
      },
      pendingTerminal: {
        status: "completed",
        phase: "done",
        completedAt: recoveredAt,
        error: null,
        summary: "Recovered provider completion"
      },
      completionContextManifest: recoveryBase.completionContextManifest,
      verificationContextManifest: null,
      commandOutcomes: [],
      result: {
        ...job.result,
        hostVerification: "not_run",
        taskRuntimeCleaned: false,
        runtimeEvidence: recoveryBase.result.runtimeEvidence
      }
    };
    delete revived.result.writeArtifact;
    return revived;
  }, lifecycleEnv);
  const recoveryInput = tryReadJob(
    fixture.root,
    workerId,
    lifecycleEnv
  );
  const recoveryConfig = path.join(fixture.root, ".git", "config");
  const recoveryConfigBefore = fs.readFileSync(recoveryConfig);
  let recoveryCleanupCalls = 0;
  let recoverySettled;
  try {
    recoverySettled = settleStartedWorkerLoss({
      root: fixture.root,
      workerId,
      attemptId: recoveryInput.request.spawn.dispatch.attemptId,
      controllerProcess: recoveryInput.controllerProcess,
      workerProcess: recoveryInput.workerProcess,
      providerProcess: recoveryInput.providerProcess,
      reconciler: true,
      runtimeCleanup: () => {
        recoveryCleanupCalls += 1;
        fs.appendFileSync(
          recoveryConfig,
          "\n[grok-issue49-recovery]\n\tvalue = context-drift\n"
        );
        return { ok: true };
      },
      env: lifecycleEnv
    });
  } finally {
    fs.writeFileSync(recoveryConfig, recoveryConfigBefore);
  }
  assert.equal(recoveryCleanupCalls, 1);
  assert.equal(recoverySettled.status, "failed");
  assert.equal(recoverySettled.phase, "context-rejected");
  assert.equal(recoverySettled.error.code, "E_CONTEXT_DRIFT");
  assert.equal(
    recoverySettled.error.details.secondaryDiagnostic.code,
    "EPERM"
  );
  assert.equal(recoverySettled.result.taskRuntimeCleaned, true);
  assert.equal(recoverySettled.progress.includes("pending"), false);
  assert.ok(
    recoverySettled.result.runtimeEvidence.observedChangedPaths.includes(
      "[GIT_METADATA]"
    )
  );
  assert.equal(
    recoverySettled.result.runtimeEvidence.reconciler.replayedPrompt,
    false
  );
  assert.equal(
    recoverySettled.result.runtimeEvidence.postContext.digest,
    recoverySettled.completionContextManifest.digest
  );
  assert.notEqual(
    recoverySettled.result.runtimeEvidence.postContext.digest,
    stalePostDigest
  );
  assert.ok(
    recoverySettled.result.runtimeEvidence.observedChangedPaths.includes(
      "target.txt"
    )
  );
  const publicRecovery = projectWorkerSnapshot(recoverySettled);
  assert.equal(publicRecovery.error.code, "E_CONTEXT_DRIFT");
  assert.equal(JSON.stringify(publicRecovery).includes("EPERM"), false);
  assert.equal(JSON.stringify(publicRecovery).includes("kill"), false);
  return recoveryBase;
}

export function verifyExactWriteControlAndNoIntent(context) {
  const { fixture, workerId, official, lifecycleEnv } = context;
  // A task-relevant control HEAD change during exact cleanup must be attributed
  // to the observed control boundary, not collapsed into an unavailable final
  // observation. Unrelated linked-worktree refs above remain tolerated.
  updateJob(fixture.root, workerId, (job) => {
    const completedAt = new Date().toISOString();
    return {
      ...job,
      status: "running",
      phase: "cleanup-blocked",
      completedAt: null,
      summary: "Awaiting control-HEAD recovery finalization",
      progress: "Task finished; runtime cleanup is still pending",
      error: {
        code: "E_PROCESS_IDENTITY",
        message: "Worker recovery is blocked because exact runtime cleanup could not be verified.",
        details: {
          secondaryDiagnostic: {
            code: "EPERM",
            message: "kill EPERM"
          }
        }
      },
      pendingTerminal: {
        status: "completed",
        phase: "done",
        completedAt,
        error: null,
        summary: "Provider reported completion"
      },
      result: {
        ...job.result,
        hostVerification: "not_run",
        taskRuntimeCleaned: false
      }
    };
  }, lifecycleEnv);
  const headDriftInput = tryReadJob(
    fixture.root,
    workerId,
    lifecycleEnv
  );
  const controlHeadBeforeFinalization = git(
    fixture.root,
    "rev-parse",
    "HEAD"
  );
  let headDriftCleanupCalls = 0;
  let headDriftSettled;
  try {
    headDriftSettled = settleStartedWorkerLoss({
      root: fixture.root,
      workerId,
      attemptId: headDriftInput.request.spawn.dispatch.attemptId,
      controllerProcess: headDriftInput.controllerProcess,
      workerProcess: headDriftInput.workerProcess,
      providerProcess: headDriftInput.providerProcess,
      reconciler: true,
      runtimeCleanup: () => {
        headDriftCleanupCalls += 1;
        git(
          fixture.root,
          "commit",
          "--allow-empty",
          "-m",
          "issue49 final control head drift"
        );
        return { ok: true };
      },
      env: lifecycleEnv
    });
  } finally {
    git(
      fixture.root,
      "reset",
      "--hard",
      controlHeadBeforeFinalization
    );
  }
  assert.equal(headDriftCleanupCalls, 1);
  assert.equal(headDriftSettled.status, "failed");
  assert.equal(headDriftSettled.phase, "context-rejected");
  assert.equal(headDriftSettled.error.code, "E_CONTEXT_DRIFT");
  assert.ok(headDriftSettled.error.details.reasons.includes("[HEAD]"));
  assert.ok(
    headDriftSettled.error.details.reasons.includes("[GIT_METADATA]")
  );
  assert.equal(
    headDriftSettled.error.details.secondaryDiagnostic.code,
    "EPERM"
  );
  assert.ok(
    headDriftSettled.result.runtimeEvidence.observedChangedPaths.includes(
      "[HEAD]"
    )
  );
  assert.ok(
    headDriftSettled.result.runtimeEvidence.observedChangedPaths.includes(
      "[GIT_METADATA]"
    )
  );
  assert.equal(
    headDriftSettled.result.runtimeEvidence.executionStatus,
    "failed"
  );
  assert.equal(headDriftSettled.result.taskRuntimeCleaned, true);
  assert.equal(headDriftSettled.progress.includes("pending"), false);
  assert.ok(headDriftSettled.completionContextManifest);
  assert.notDeepEqual(
    headDriftSettled.error.details.reasons,
    ["[final-context-unavailable]"]
  );

  // Loss before pendingTerminal publication still receives the same
  // post-cleanup safety observation. A cleanup callback that creates an
  // out-of-scope path must not fall through to E_PROCESS_IDENTITY/E_WORKER_LOST.
  updateJob(fixture.root, workerId, (job) => {
    const revived = {
      ...job,
      status: "running",
      phase: "cleanup-blocked",
      completedAt: null,
      summary: "Awaiting no-intent recovery finalization",
      progress: "Worker lost; provider cleanup could not be verified",
      error: {
        code: "E_PROCESS_IDENTITY",
        message: "Worker recovery is blocked because exact runtime cleanup could not be verified.",
        details: {
          secondaryDiagnostic: {
            code: "EPERM",
            message: "kill EPERM"
          }
        }
      },
      result: {
        ...job.result,
        hostVerification: "not_run",
        taskRuntimeCleaned: false
      }
    };
    delete revived.pendingTerminal;
    return revived;
  }, lifecycleEnv);
  const noIntentInput = tryReadJob(
    fixture.root,
    workerId,
    lifecycleEnv
  );
  const recoveryOutOfScope = path.join(
    official.executionRoot,
    "outside-after-cleanup.txt"
  );
  let noIntentCleanupCalls = 0;
  let noIntentSettled;
  try {
    noIntentSettled = settleStartedWorkerLoss({
      root: fixture.root,
      workerId,
      attemptId: noIntentInput.request.spawn.dispatch.attemptId,
      controllerProcess: noIntentInput.controllerProcess,
      workerProcess: noIntentInput.workerProcess,
      providerProcess: noIntentInput.providerProcess,
      reconciler: true,
      runtimeCleanup: () => {
        noIntentCleanupCalls += 1;
        fs.writeFileSync(recoveryOutOfScope, "out of scope\n", "utf8");
        return { ok: true };
      },
      env: lifecycleEnv
    });
  } finally {
    if (fs.existsSync(recoveryOutOfScope)) {
      fs.unlinkSync(recoveryOutOfScope);
    }
  }
  assert.equal(noIntentCleanupCalls, 1);
  assert.equal(noIntentSettled.status, "failed");
  assert.equal(noIntentSettled.phase, "scope-rejected");
  assert.equal(noIntentSettled.error.code, "E_SCOPE_VIOLATION");
  assert.equal(
    noIntentSettled.error.details.secondaryDiagnostic.code,
    "EPERM"
  );
  assert.equal(noIntentSettled.result.taskRuntimeCleaned, true);
  assert.ok(
    noIntentSettled.result.runtimeEvidence.scopeViolations.includes(
      "outside-after-cleanup.txt"
    )
  );
  const publicNoIntent = projectWorkerSnapshot(noIntentSettled);
  assert.equal(publicNoIntent.error.code, "E_SCOPE_VIOLATION");
  assert.equal(JSON.stringify(publicNoIntent).includes("EPERM"), false);
}

export function verifyExactWriteSignalAndUnavailable(context) {
  const { fixture, workerId, official, lifecycleEnv } = context;
  // A later generic cleanup-blocked record must not erase the original
  // signalling uncertainty, and the final runtime evidence must describe the
  // effective failed result rather than the provider's earlier completion.
  updateJob(fixture.root, workerId, (job) => {
    const completedAt = new Date().toISOString();
    return {
      ...job,
      status: "running",
      phase: "cleanup-blocked",
      completedAt: null,
      summary: "Awaiting signal-precedence finalization",
      progress: "Task finished; runtime cleanup is still pending",
      error: {
        code: "E_PROCESS_IDENTITY",
        message: "Worker recovery is blocked because exact runtime cleanup could not be verified.",
        details: {
          secondaryDiagnostic: {
            code: "EIO",
            message: "signal failed with EIO"
          }
        }
      },
      pendingTerminal: {
        status: "completed",
        phase: "done",
        completedAt,
        error: null,
        summary: "Provider reported completion"
      },
      result: {
        ...job.result,
        hostVerification: "not_run",
        taskRuntimeCleaned: false
      }
    };
  }, lifecycleEnv);
  const signalInput = tryReadJob(fixture.root, workerId, lifecycleEnv);
  const signalSettled = settleStartedWorkerLoss({
    root: fixture.root,
    workerId,
    attemptId: signalInput.request.spawn.dispatch.attemptId,
    controllerProcess: signalInput.controllerProcess,
    workerProcess: signalInput.workerProcess,
    providerProcess: signalInput.providerProcess,
    reconciler: true,
    runtimeCleanup: { ok: true },
    env: lifecycleEnv
  });
  assert.equal(signalSettled.status, "failed");
  assert.equal(signalSettled.error.code, "E_PROCESS_IDENTITY");
  assert.equal(
    signalSettled.error.details.secondaryDiagnostic.code,
    "EIO"
  );
  assert.equal(
    signalSettled.result.runtimeEvidence.executionStatus,
    "failed"
  );
  const publicSignal = projectWorkerSnapshot(signalSettled);
  assert.equal(publicSignal.error.code, "E_PROCESS_IDENTITY");
  assert.equal(JSON.stringify(publicSignal).includes("EIO"), false);

  // If the linked execution root becomes unobservable only during exact
  // cleanup, terminal publication must fail closed instead of throwing after
  // cleanup and leaving the job active.
  updateJob(fixture.root, workerId, (job) => {
    const completedAt = new Date().toISOString();
    return {
      ...job,
      status: "running",
      phase: "cleanup-blocked",
      completedAt: null,
      summary: "Awaiting unavailable-observation finalization",
      progress: "Task finished; runtime cleanup is still pending",
      error: {
        code: "E_PROCESS_IDENTITY",
        message: "Worker recovery is blocked because exact runtime cleanup could not be verified.",
        details: {
          secondaryDiagnostic: {
            code: "EPERM",
            message: "kill EPERM"
          }
        }
      },
      pendingTerminal: {
        status: "completed",
        phase: "done",
        completedAt,
        error: null,
        summary: "Provider reported completion"
      },
      result: {
        ...job.result,
        hostVerification: "not_run",
        taskRuntimeCleaned: false
      }
    };
  }, lifecycleEnv);
  const unavailableInput = tryReadJob(
    fixture.root,
    workerId,
    lifecycleEnv
  );
  const executionGitFile = path.join(official.executionRoot, ".git");
  const hiddenExecutionGitFile = path.join(
    official.executionRoot,
    ".git.issue49-hidden"
  );
  let unavailableSettled;
  try {
    unavailableSettled = settleStartedWorkerLoss({
      root: fixture.root,
      workerId,
      attemptId: unavailableInput.request.spawn.dispatch.attemptId,
      controllerProcess: unavailableInput.controllerProcess,
      workerProcess: unavailableInput.workerProcess,
      providerProcess: unavailableInput.providerProcess,
      reconciler: true,
      runtimeCleanup: () => {
        fs.renameSync(executionGitFile, hiddenExecutionGitFile);
        return { ok: true };
      },
      env: lifecycleEnv
    });
  } finally {
    if (fs.existsSync(hiddenExecutionGitFile)) {
      fs.renameSync(hiddenExecutionGitFile, executionGitFile);
    }
  }
  assert.equal(unavailableSettled.status, "failed");
  assert.equal(unavailableSettled.phase, "context-rejected");
  assert.equal(unavailableSettled.error.code, "E_CONTEXT_DRIFT");
  assert.deepEqual(
    unavailableSettled.error.details.reasons,
    ["[final-context-unavailable]"]
  );
  assert.equal(
    unavailableSettled.error.details.secondaryDiagnostic.code,
    "EPERM"
  );
  assert.equal(unavailableSettled.completionContextManifest, null);
  assert.equal(unavailableSettled.result.taskRuntimeCleaned, true);
  assert.equal(
    unavailableSettled.result.runtimeEvidence.postContext,
    null
  );
  assert.deepEqual(
    unavailableSettled.result.runtimeEvidence.observedChangedPaths,
    []
  );
  assert.deepEqual(
    unavailableSettled.result.runtimeEvidence.scopeViolations,
    []
  );
  assert.equal(
    unavailableSettled.result.runtimeEvidence.executionStatus,
    "failed"
  );
  const publicUnavailable = projectWorkerSnapshot(unavailableSettled);
  assert.equal(publicUnavailable.error.code, "E_CONTEXT_DRIFT");
  assert.equal(JSON.stringify(publicUnavailable).includes("EPERM"), false);
  assert.equal(
    JSON.stringify(publicUnavailable).includes(official.executionRoot),
    false
  );
}

export function verifyExactWriteUnsafeAndPartial(context, recoveryBase) {
  const { fixture, workerId, lifecycleEnv } = context;
  // A known final scope classification must remain attributable after exact
  // cleanup. Unsafe control-index state is E_SCOPE_VIOLATION, not an
  // unavailable context observation, and still outranks signal uncertainty.
  updateJob(fixture.root, workerId, (job) => {
    const completedAt = new Date().toISOString();
    return {
      ...job,
      status: "running",
      phase: "cleanup-blocked",
      completedAt: null,
      completionContextManifest: recoveryBase.completionContextManifest,
      summary: "Awaiting unsafe-index finalization",
      progress: "Task finished; runtime cleanup is still pending",
      error: {
        code: "E_PROCESS_IDENTITY",
        message: "Verified owned process signalling could not be completed.",
        details: {
          secondaryDiagnostic: {
            code: "EPERM",
            message: "kill EPERM"
          }
        }
      },
      pendingTerminal: {
        status: "completed",
        phase: "done",
        completedAt,
        error: null,
        summary: "Provider reported completion"
      },
      result: {
        ...job.result,
        hostVerification: "not_run",
        taskRuntimeCleaned: false,
        runtimeEvidence: recoveryBase.result.runtimeEvidence
      }
    };
  }, lifecycleEnv);
  const unsafeIndexInput = tryReadJob(
    fixture.root,
    workerId,
    lifecycleEnv
  );
  let unsafeIndexCleanupCalls = 0;
  let unsafeIndexSettled;
  try {
    unsafeIndexSettled = settleStartedWorkerLoss({
      root: fixture.root,
      workerId,
      attemptId: unsafeIndexInput.request.spawn.dispatch.attemptId,
      controllerProcess: unsafeIndexInput.controllerProcess,
      workerProcess: unsafeIndexInput.workerProcess,
      providerProcess: unsafeIndexInput.providerProcess,
      reconciler: true,
      runtimeCleanup: () => {
        unsafeIndexCleanupCalls += 1;
        git(
          fixture.root,
          "update-index",
          "--assume-unchanged",
          "target.txt"
        );
        return { ok: true };
      },
      env: lifecycleEnv
    });
  } finally {
    git(
      fixture.root,
      "update-index",
      "--no-assume-unchanged",
      "target.txt"
    );
  }
  assert.equal(unsafeIndexCleanupCalls, 1);
  assert.equal(unsafeIndexSettled.status, "failed");
  assert.equal(unsafeIndexSettled.phase, "scope-rejected");
  assert.equal(unsafeIndexSettled.error.code, "E_SCOPE_VIOLATION");
  assert.deepEqual(unsafeIndexSettled.error.details.paths, ["[INDEX]"]);
  assert.equal(
    unsafeIndexSettled.error.details.secondaryDiagnostic.code,
    "EPERM"
  );
  assert.equal(unsafeIndexSettled.completionContextManifest, null);
  assert.deepEqual(
    unsafeIndexSettled.result.runtimeEvidence.observedChangedPaths,
    ["[INDEX]"]
  );
  assert.deepEqual(
    unsafeIndexSettled.result.runtimeEvidence.scopeViolations,
    ["[INDEX]"]
  );
  assert.equal(
    unsafeIndexSettled.result.runtimeEvidence.executionStatus,
    "failed"
  );
  assert.equal(unsafeIndexSettled.result.taskRuntimeCleaned, true);
  assert.equal(unsafeIndexSettled.progress.includes("pending"), false);
  assert.notDeepEqual(
    unsafeIndexSettled.error.details.paths,
    ["[final-context-unavailable]"]
  );

  // A partial managed-write authority discovered only after successful cleanup
  // must terminalize fail-closed. It must not abort the transaction and leave
  // the already-cleaned job active.
  updateJob(fixture.root, workerId, (job) => {
    const completedAt = new Date().toISOString();
    const revived = {
      ...job,
      status: "running",
      phase: "cleanup-blocked",
      completedAt: null,
      summary: "Awaiting partial-authority finalization",
      progress: "Task finished; runtime cleanup is still pending",
      error: {
        code: "E_STATE",
        message: "Task finished, but transient runtime cleanup is incomplete."
      },
      pendingTerminal: {
        status: "completed",
        phase: "done",
        completedAt,
        error: null,
        summary: "Provider reported completion"
      },
      result: {
        ...job.result,
        hostVerification: "not_run",
        taskRuntimeCleaned: false
      }
    };
    delete revived.provisioningRuntime;
    return revived;
  }, lifecycleEnv);
  const partialAuthorityInput = tryReadJob(
    fixture.root,
    workerId,
    lifecycleEnv
  );
  let partialAuthorityCleanupCalls = 0;
  const partialAuthoritySettled = settleStartedWorkerLoss({
    root: fixture.root,
    workerId,
    attemptId: partialAuthorityInput.request.spawn.dispatch.attemptId,
    controllerProcess: partialAuthorityInput.controllerProcess,
    workerProcess: partialAuthorityInput.workerProcess,
    providerProcess: partialAuthorityInput.providerProcess,
    reconciler: true,
    runtimeCleanup: () => {
      partialAuthorityCleanupCalls += 1;
      return { ok: true };
    },
    env: lifecycleEnv
  });
  assert.equal(partialAuthorityCleanupCalls, 1);
  assert.equal(partialAuthoritySettled.status, "failed");
  assert.equal(partialAuthoritySettled.phase, "context-rejected");
  assert.equal(partialAuthoritySettled.error.code, "E_CONTEXT_DRIFT");
  assert.deepEqual(
    partialAuthoritySettled.error.details.reasons,
    ["[final-context-unavailable]"]
  );
  assert.equal(partialAuthoritySettled.completionContextManifest, null);
  assert.equal(partialAuthoritySettled.result.taskRuntimeCleaned, true);
  assert.equal(
    partialAuthoritySettled.result.runtimeEvidence.postContext,
    null
  );
  assert.equal(
    partialAuthoritySettled.result.runtimeEvidence.executionStatus,
    "failed"
  );
  assert.equal(
    partialAuthoritySettled.progress.includes("pending"),
    false
  );
  assert.equal(partialAuthoritySettled.pendingTerminal, undefined);
}
