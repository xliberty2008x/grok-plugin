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

test("cancel is idempotent with exactly one cancellation-request event", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({ userRequest: "Long task", mode: "read" });
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "spawn-cancel-0001",
    env
  });
  const runtimeAuth = path.join(
    workspaceState(root, env),
    "task-homes",
    spawned.handle.id,
    ".grok",
    "auth.json"
  );
  fs.mkdirSync(path.dirname(runtimeAuth), { recursive: true, mode: 0o700 });
  fs.writeFileSync(runtimeAuth, "transient-auth\n", { mode: 0o600 });
  const first = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: "cancel-key-0001",
    env
  });
  assert.equal(first.replayed, false);
  assert.equal(first.receipt.workerId, spawned.handle.id);
  assert.ok(first.receipt.requestAcceptedAt);

  const second = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: "cancel-key-0001",
    env
  });
  assert.equal(second.replayed, true);
  assert.equal(second.receipt.receiptId, first.receipt.receiptId);

  assert.throws(
    () => cancelWorker({
      root,
      principal: principal(root, { threadId: THREAD_B }),
      workerId: spawned.handle.id,
      idempotencyKey: "cancel-key-0001",
      env
    }),
    (error) => error?.code === "E_IDEMPOTENCY_CONFLICT"
      && !String(error.message).includes(first.receipt.receiptId)
  );

  const job = tryReadJob(root, spawned.handle.id, env);
  const cancelEvents = (job.lifecycleEvents || []).filter((event) => event.type === "cancellation.requested");
  assert.equal(cancelEvents.length, 1);
  assert.equal(
    cancelEvents[0].detail.requestAcceptedAt,
    first.receipt.requestAcceptedAt
  );
  assert.equal(
    cancelEvents[0].sequence,
    first.receipt.cancellationRequestSequence
  );
  assert.ok(
    Date.parse(cancelEvents[0].at) >= Date.parse(first.receipt.requestAcceptedAt)
  );
  assert.equal(job.status, "cancelled");
  assert.equal(job.result.hostVerification, "not_run");
  assert.equal(job.result.taskRuntimeCleaned, true);
  assert.equal(fs.existsSync(runtimeAuth), false);
  assert.equal(job.request.spawn.providerLaunchPending, false);
  assert.equal(job.request.spawn.providerLaunchInFlight, false);
  assert.equal(job.request.spawn.providerLaunchOutcome, "not-launched");
  assert.equal(job.workerAuthorization, null);
  assert.equal(job.request.spawn.dispatch.state, "failed");
  assert.equal(job.request.spawn.dispatch.lease, null);
  assert.equal(job.request.spawn.dispatch.nextProviderGeneration, null);
  assert.equal(job.request.spawn.dispatch.failedAt, first.receipt.terminalRecordCommittedAt);
  assert.equal(job.request.spawn.dispatch.updatedAt, first.receipt.terminalRecordCommittedAt);
  assert.doesNotThrow(() => assertDispatchContract(job));

  const spawnReplay = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "spawn-cancel-0001",
    env
  });
  assert.equal(spawnReplay.replayed, true);
  assert.equal(spawnReplay.handle.status, "cancelled");
  const replayedJob = tryReadJob(root, spawned.handle.id, env);
  assert.equal(replayedJob.workerAuthorization, null);
  assert.equal(replayedJob.request.spawn.dispatch.state, "failed");
  assert.doesNotThrow(() => assertDispatchContract(replayedJob));
});

test("queued cancellation retry clears a stale runtime-cleanup warning", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({
      userRequest: "Retry queued cancellation cleanup",
      mode: "read"
    }),
    idempotencyKey: "spawn-cancel-cleanup-retry-0001",
    env
  });
  const runtimeAuth = path.join(
    workspaceState(root, env),
    "task-homes",
    spawned.handle.id,
    ".grok",
    "auth.json"
  );
  fs.mkdirSync(runtimeAuth, { recursive: true, mode: 0o700 });

  cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: "cancel-cleanup-retry-first-0001",
    env
  });
  const blocked = tryReadJob(root, spawned.handle.id, env);
  assert.equal(blocked.status, "queued");
  assert.equal(blocked.phase, "cancellation-requested");
  assert.equal(blocked.result.taskRuntimeCleaned, false);
  assert.equal(typeof blocked.result.privacyWarning, "string");

  fs.rmdirSync(runtimeAuth);
  cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: "cancel-cleanup-retry-second-0001",
    env
  });
  const settled = tryReadJob(root, spawned.handle.id, env);
  assert.equal(settled.status, "cancelled");
  assert.equal(settled.error, null);
  assert.equal(settled.result.taskRuntimeCleaned, true);
  assert.equal(settled.result.privacyWarning, undefined);
  assert.equal(settled.progress, "Cancellation completed");
  assert.equal(settled.result.stopReason, "cancelled");
  assert.doesNotThrow(() => assertDispatchContract(settled));
});

test("cancellation receipts reject impossible durable dates and project invalid dates as null", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({
      userRequest: "Reject impossible cancellation dates",
      mode: "read"
    }),
    idempotencyKey: "spawn-cancel-impossible-date-0001",
    env
  });
  const key = "cancel-impossible-date-0001";
  const first = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: key,
    env
  });
  const file = cancelIdempotencyFile(root, key, env);
  const original = JSON.parse(fs.readFileSync(file, "utf8"));
  const impossible = "2026-02-31T00:00:00.000Z";

  for (const field of [
    "requestAcceptedAt",
    "processGroupGoneAt",
    "terminalRecordCommittedAt"
  ]) {
    const corrupted = structuredClone(original);
    corrupted.receipt[field] = impossible;
    if (field === "requestAcceptedAt") {
      corrupted.committedAt = impossible;
    }
    fs.writeFileSync(file, `${JSON.stringify(corrupted)}\n`, {
      mode: 0o600
    });
    assert.throws(
      () => cancelWorker({
        root,
        principal: principal(root),
        workerId: spawned.handle.id,
        idempotencyKey: key,
        env
      }),
      (error) => error?.code === "E_STATE"
        && /receipt timestamp is malformed/i.test(error.message)
    );
  }
  fs.writeFileSync(file, `${JSON.stringify(original)}\n`, {
    mode: 0o600
  });
  assert.equal(cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: key,
    env
  }).replayed, true);

  const projected = projectCancellationReceipt({
    ...first.receipt,
    requestAcceptedAt: impossible,
    processGroupGoneAt: impossible,
    terminalRecordCommittedAt: impossible
  });
  assert.equal(projected.requestAcceptedAt, null);
  assert.equal(projected.processGroupGoneAt, null);
  assert.equal(projected.terminalRecordCommittedAt, null);
  assert.equal(
    projectCancellationReceipt(first.receipt).requestAcceptedAt,
    first.receipt.requestAcceptedAt
  );
});

test("queued cancellation never terminalizes a claimed dispatch with a pending spawn intent", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest: "Cancel after a durable controller claim", mode: "read" }),
    idempotencyKey: "spawn-cancel-claimed-intent-0001",
    env
  });
  const workerId = spawned.handle.id;
  const claim = claimWorkerDispatch({ root, principal: principal(root), workerId, env });
  const intent = prepareDispatchProcessSpawn({
    root,
    workerId,
    attemptId: claim.attemptId,
    processKind: "controller",
    nonce: claim.nonce,
    fence: claim.fence,
    env
  });
  assert.equal(intent.prepared, true);

  const runtimeAuth = path.join(
    workspaceState(root, env),
    "task-homes",
    workerId,
    ".grok",
    "auth.json"
  );
  fs.mkdirSync(path.dirname(runtimeAuth), { recursive: true, mode: 0o700 });
  fs.writeFileSync(runtimeAuth, "transient-auth\n", { mode: 0o600 });
  updateJob(root, workerId, (job) => ({
    ...job,
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        // Reproduce stale public launch flags without changing the authoritative
        // claimed dispatch, lease, or pending spawn boundary.
        providerLaunchPending: true,
        providerLaunchInFlight: false,
        providerLaunchOutcome: "pending"
      }
    }
  }), env);

  cancelWorker({
    root,
    principal: principal(root),
    workerId,
    idempotencyKey: "cancel-claimed-intent-0001",
    env
  });

  const job = tryReadJob(root, workerId, env);
  assert.equal(job.status, "queued");
  assert.equal(job.phase, "cancellation-requested");
  assert.equal(job.request.spawn.dispatch.state, "claimed");
  assert.ok(job.request.spawn.dispatch.lease);
  assert.equal(job.request.spawn.controllerSpawnIntent.status, "pending");
  assert.ok(job.workerAuthorization);
  assert.equal(fs.existsSync(runtimeAuth), true);
});

for (const guardCase of [
  { label: "live provider guard", corrupt: false },
  { label: "corrupt provider guard", corrupt: true }
]) {
  test(`queued cancel retains private runtime artifacts with a ${guardCase.label}`, {
    skip: process.platform === "win32"
  }, async (t) => {
    const root = initRepo();
    const { env } = envFor(root);
    const spawned = spawnReadOnlyWorker({
      root,
      principal: principal(root),
      envelope: buildTaskEnvelope({ userRequest: `Guarded cancellation: ${guardCase.label}`, mode: "read" }),
      idempotencyKey: `spawn-guarded-cancel-${guardCase.corrupt ? "corrupt" : "live"}-0001`,
      env
    });
    const workerId = spawned.handle.id;
    const grokHome = path.join(workspaceState(root, env), "task-homes", workerId, ".grok");
    const runtimeAuth = path.join(grokHome, "auth.json");
    const agentProfile = path.join(grokHome, "agent-profiles", "audit-profile.md");
    fs.mkdirSync(path.dirname(agentProfile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(runtimeAuth, "transient-auth\n", { mode: 0o600 });
    fs.writeFileSync(agentProfile, "private-profile\n", { mode: 0o600 });

    const provider = spawnProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", workerId, "agent", "stdio"],
      { detached: true, stdio: "ignore" }
    );
    let providerIdentity = null;
    t.after(async () => {
      try { unregisterProviderGuard(root, workerId); } catch {}
      try { process.kill(-provider.pid, "SIGKILL"); } catch {}
      if (providerIdentity) {
        try {
          await waitFor(() => processGroupGone(providerIdentity), { timeoutMs: 5_000, intervalMs: 25 });
        } catch {}
      }
    });
    providerIdentity = {
      pid: provider.pid,
      startToken: await waitFor(() => processStartToken(provider.pid), {
        timeoutMs: 5_000,
        intervalMs: 25
      }),
      processGroupId: provider.pid
    };
    registerProviderGuard(root, workerId, providerIdentity, THREAD);
    const guardFile = providerGuardFile(root, workerId);
    if (guardCase.corrupt) fs.writeFileSync(guardFile, "{malformed-provider-guard", { mode: 0o600 });

    const cancellation = cancelWorker({
      root,
      principal: principal(root),
      workerId,
      idempotencyKey: `cancel-guarded-${guardCase.corrupt ? "corrupt" : "live"}-0001`,
      env
    });
    const job = tryReadJob(root, workerId, env);

    assert.equal(cancellation.receipt.status, "accepted");
    assert.equal(cancellation.receipt.processGroupGoneAt, null);
    assert.equal(cancellation.receipt.terminalRecordCommittedAt, null);
    assert.equal(["completed", "failed", "cancelled"].includes(job.status), false);
    assert.equal(job.status, "queued");
    assert.equal(job.phase, "cancellation-requested");
    assert.equal(job.result.taskRuntimeCleaned, false);
    assert.equal(fs.readFileSync(runtimeAuth, "utf8"), "transient-auth\n");
    assert.equal(fs.readFileSync(agentProfile, "utf8"), "private-profile\n");
    assert.equal(fs.existsSync(guardFile), true);
    if (guardCase.corrupt) {
      assert.equal(fs.readFileSync(guardFile, "utf8"), "{malformed-provider-guard");
    } else {
      assert.equal(loadProviderGuard(root, workerId)?.providerProcess?.pid, provider.pid);
    }
    assert.equal(processStartToken(provider.pid), providerIdentity.startToken);
    assert.equal(processGroupGone(providerIdentity), false);
  });
}

test("terminal cancellation recovers the exact receipt after adjacent idempotency publication loss", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest: "Already complete", mode: "read" }),
    idempotencyKey: "spawn-terminal-cancel-0001",
    env
  });
  const completedAt = new Date().toISOString();
  updateJob(root, spawned.handle.id, (job) => ({
    ...job,
    status: "completed",
    phase: "completed",
    completedAt,
    result: { hostVerification: "not_run" }
  }), env);

  const first = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: "cancel-terminal-crash-0001",
    env
  });
  assert.equal(first.receipt.status, "already_terminal");
  assert.equal(first.receipt.terminalRecordCommittedAt, completedAt);

  // Simulate the prior single-record layout, then a crash after the terminal
  // job update but before its adjacent idempotency file became durable.
  updateJob(root, spawned.handle.id, (job) => {
    const legacyResult = { ...job.result };
    delete legacyResult.cancellationReceiptsByKey;
    return { ...job, result: legacyResult };
  }, env);
  fs.rmSync(path.join(workspaceState(root, env), "idempotency", "cancel"), {
    recursive: true,
    force: true
  });
  const recovered = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: "cancel-terminal-crash-0001",
    env
  });
  assert.equal(recovered.replayed, true);
  assert.deepEqual(recovered.receipt, first.receipt);
});

test("unknown authoritative status fails cancellation and reconciliation closed", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest: "Corrupt status fixture", mode: "read" }),
    idempotencyKey: "spawn-unknown-state-0001",
    env
  });
  const file = path.join(workspaceState(root, env), "jobs", `${spawned.handle.id}.json`);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.status = "UNKNOWN_AUTHORITATIVE_STATUS_CANARY";
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
  const genericStateFailure = (error) => error?.code === "E_STATE"
    && error.message === "Authoritative job state is malformed or unsafe."
    && !error.message.includes(spawned.handle.id)
    && !error.message.includes(root)
    && !error.message.includes("CANARY")
    && !error.message.includes("already_terminal")
    && error.details === undefined;

  assert.equal(tryReadJob(root, spawned.handle.id, env), null);
  assert.throws(() => cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: "cancel-unknown-state-0001",
    env
  }), genericStateFailure);
  assert.throws(() => reconcileOwnedWorkers({
    root,
    principal: principal(root),
    trusted: true,
    processAlive: () => false,
    env
  }), genericStateFailure);
});

test("distinct cancellation keys retain exact crash recovery and binding independently", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest: "Cancel with interleaved keys", mode: "read" }),
    idempotencyKey: "spawn-interleaved-cancel-0001",
    env
  });
  const keyA = "cancel-interleaved-key-A";
  const keyB = "cancel-interleaved-key-B";
  const firstA = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: keyA,
    env
  });
  fs.rmSync(cancelIdempotencyFile(root, keyA, env));

  const firstB = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: keyB,
    env
  });
  fs.rmSync(cancelIdempotencyFile(root, keyB, env));

  const afterBoth = tryReadJob(root, spawned.handle.id, env);
  assert.equal(Object.keys(afterBoth.result.cancellationReceiptsByKey).length, 2);
  const snapshot = projectWorkerSnapshot(afterBoth);
  assert.equal(Object.hasOwn(snapshot.result, "cancellationReceiptsByKey"), false);
  assert.equal(JSON.stringify(snapshot).includes(THREAD), false);

  const recoveredA = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: keyA,
    env
  });
  const recoveredB = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: keyB,
    env
  });
  assert.equal(recoveredA.replayed, true);
  assert.equal(recoveredB.replayed, true);
  assert.deepEqual(recoveredA.receipt, firstA.receipt);
  assert.deepEqual(recoveredB.receipt, firstB.receipt);

  // Removing the adjacent mappings again must not permit either cross-worker
  // or cross-owner reuse of a key whose job-side recovery is still durable.
  fs.rmSync(cancelIdempotencyFile(root, keyA, env));
  fs.rmSync(cancelIdempotencyFile(root, keyB, env));
  const other = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest: "Different cancellation target", mode: "read" }),
    idempotencyKey: "spawn-interleaved-other-0001",
    env
  });
  assert.throws(
    () => cancelWorker({
      root,
      principal: principal(root),
      workerId: other.handle.id,
      idempotencyKey: keyA,
      env
    }),
    (error) => error?.code === "E_IDEMPOTENCY_CONFLICT"
      && !String(error.message).includes(spawned.handle.id)
  );
  assert.throws(
    () => cancelWorker({
      root,
      principal: principal(root, { threadId: THREAD_B }),
      workerId: spawned.handle.id,
      idempotencyKey: keyB,
      env
    }),
    (error) => error?.code === "E_IDEMPOTENCY_CONFLICT"
      && !String(error.message).includes(THREAD)
  );
});

test("cancellation recovery history fails closed at its bound without pruning old receipts", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest: "Bound cancellation recovery", mode: "read" }),
    idempotencyKey: "spawn-cancel-bound-0001",
    env
  });
  updateJob(root, spawned.handle.id, (job) => ({
    ...job,
    status: "completed",
    phase: "completed",
    completedAt: new Date().toISOString(),
    result: { hostVerification: "not_run", taskRuntimeCleaned: true }
  }), env);

  const receipts = [];
  for (let index = 0; index < 32; index += 1) {
    receipts.push(cancelWorker({
      root,
      principal: principal(root),
      workerId: spawned.handle.id,
      idempotencyKey: `cancel-bounded-${String(index).padStart(4, "0")}`,
      env
    }).receipt);
  }
  assert.throws(
    () => cancelWorker({
      root,
      principal: principal(root),
      workerId: spawned.handle.id,
      idempotencyKey: "cancel-bounded-overflow",
      env
    }),
    (error) => error?.code === "E_STATE"
  );
  const firstKey = "cancel-bounded-0000";
  fs.rmSync(cancelIdempotencyFile(root, firstKey, env));
  const recovered = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: firstKey,
    env
  });
  assert.deepEqual(recovered.receipt, receipts[0]);
  assert.equal(
    Object.keys(tryReadJob(root, spawned.handle.id, env).result.cancellationReceiptsByKey).length,
    32
  );
});

test("running cancellation stays nonterminal even when a caller claims process-group exit", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest: "Running worker", mode: "read" }),
    idempotencyKey: "spawn-running-cancel-0001",
    env
  });
  updateJob(root, spawned.handle.id, (job) => ({
    ...job,
    status: "running",
    request: {
      ...job.request,
      spawn: { ...job.request.spawn, providerLaunchPending: false }
    }
  }), env);

  const accepted = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: "cancel-running-no-confirm-0001",
    env
  });
  assert.equal(accepted.receipt.processGroupGoneAt, null);
  assert.equal(accepted.receipt.terminalRecordCommittedAt, null);
  assert.equal(tryReadJob(root, spawned.handle.id, env).status, "running");
  assert.equal(fs.readFileSync(cancelFile(root, spawned.handle.id, env), "utf8").trim().length > 0, true);

  let obsoleteSignals = 0;
  const repeated = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: "cancel-running-confirmed-0001",
    env,
    signalProcess: () => {
      obsoleteSignals += 1;
      return { processGroupGone: true };
    }
  });
  assert.equal(obsoleteSignals, 0);
  assert.equal(repeated.receipt.processGroupGoneAt, null);
  assert.equal(repeated.receipt.terminalRecordCommittedAt, null);
  assert.equal(tryReadJob(root, spawned.handle.id, env).status, "running");
});

test("cancel uses the live worker-process nonce without caller-driven terminalization", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest: "Attached worker", mode: "read" }),
    idempotencyKey: "spawn-attached-cancel-0001",
    env
  });
  const liveNonce = "c".repeat(32);
  updateJob(root, spawned.handle.id, (job) => ({
    ...job,
    status: "running",
    workerAuthorization: null,
    workerProcess: { pid: process.pid, nonce: liveNonce },
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        providerLaunchPending: false,
        providerLaunchInFlight: false,
        providerLaunchOutcome: "launched"
      }
    }
  }), env);

  let obsoleteSignals = 0;
  const cancelled = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: "cancel-attached-worker-0001",
    env,
    signalProcess: () => {
      obsoleteSignals += 1;
      return { processGroupGone: true };
    }
  });
  assert.equal(obsoleteSignals, 0);
  assert.equal(cancelled.receipt.terminalRecordCommittedAt, null);
  assert.equal(fs.readFileSync(cancelFile(root, spawned.handle.id, env), "utf8").trim(), liveNonce);
  assert.equal(tryReadJob(root, spawned.handle.id, env).status, "running");
});

test("cancel marker publication failure is propagated without a false terminal record", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest: "Marker failure", mode: "read" }),
    idempotencyKey: "spawn-marker-failure-0001",
    env
  });
  updateJob(root, spawned.handle.id, (job) => ({
    ...job,
    status: "running",
    request: {
      ...job.request,
      spawn: { ...job.request.spawn, providerLaunchPending: false }
    }
  }), env);
  fs.mkdirSync(cancelFile(root, spawned.handle.id, env));

  assert.throws(() => cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: "cancel-marker-failure-0001",
    env
  }));
  const current = tryReadJob(root, spawned.handle.id, env);
  assert.equal(current.status, "running");
  assert.equal(current.lifecycleEvents.some((event) => event.type === "cancellation.requested"), false);
  assert.equal(current.result?.cancellation, undefined);
});

test("foreign worker id is observationally equivalent to missing id on cancel", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({ userRequest: "Owned", mode: "read" });
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "spawn-foreign-0001",
    env
  });
  const foreign = principal(root, { threadId: THREAD_B });
  assert.throws(
    () => cancelWorker({
      root,
      principal: foreign,
      workerId: spawned.handle.id,
      idempotencyKey: "cancel-foreign-0001",
      env
    }),
    (error) => error?.code === "E_JOB_NOT_FOUND"
  );
  assert.throws(
    () => cancelWorker({
      root,
      principal: principal(root),
      workerId: "task-ffffffffffffffffffffffffffffffff",
      idempotencyKey: "cancel-missing-0001",
      env
    }),
    (error) => error?.code === "E_JOB_NOT_FOUND"
  );
});

test("legacy reconciler never replays prompts and delegates Worker Dispatch v1 recovery", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({ userRequest: "Reconcile me", mode: "read" });
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "spawn-reconcile-0001",
    env
  });
  assert.throws(
    () => reconcileOwnedWorkers({
      root,
      principal: principal(root),
      trusted: true,
      replayPrompt: () => {}
    }),
    (error) => error?.code === "E_POLICY"
  );
  assert.throws(
    () => reconcileOwnedWorkers({
      root,
      principal: principal(root),
      trusted: false
    }),
    (error) => error?.code === "E_AUTH_REQUIRED"
  );
  const pending = reconcileOwnedWorkers({
    root,
    principal: principal(root),
    trusted: true,
    processAlive: () => false,
    env
  });
  assert.equal(pending.replayedPrompt, false);
  assert.ok(pending.results.some((item) => (
    item.workerId === spawned.handle.id
    && item.action === "none"
    && item.reason === "dispatch-pending-recoverable"
  )));
  assert.equal(tryReadJob(root, spawned.handle.id, env).status, "queued");

  const dispatchAttemptId = "a".repeat(32);
  updateJob(root, spawned.handle.id, (job) => ({
    ...job,
    status: "running",
    workerAuthorization: null,
    providerProcess: {
      pid: 12345,
      startToken: "provider-token",
      processGroupId: process.platform === "win32" ? null : 12345,
      commandMarker: job.id,
      dispatchAttemptId
    },
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        providerLaunchPending: false,
        providerLaunchInFlight: false,
        providerLaunchOutcome: "launched",
        dispatch: {
          ...job.request.spawn.dispatch,
          state: "provider-started",
          attemptId: dispatchAttemptId,
          updatedAt: new Date().toISOString()
        }
      }
    }
  }), env);
  let legacyLivenessCalls = 0;
  const alive = reconcileOwnedWorkers({
    root,
    principal: principal(root),
    trusted: true,
    processAlive: () => {
      legacyLivenessCalls += 1;
      return true;
    },
    env
  });
  assert.ok(alive.results.some((item) => (
    item.workerId === spawned.handle.id
    && item.action === "none"
    && item.reason === "authoritative-broker-recovery-required"
  )));
  assert.equal(legacyLivenessCalls, 0);
  assert.equal(tryReadJob(root, spawned.handle.id, env).status, "running");

  const result = reconcileOwnedWorkers({
    root,
    principal: principal(root),
    trusted: true,
    processAlive: () => false,
    env
  });
  assert.equal(result.replayedPrompt, false);
  assert.ok(result.results.some((item) => (
    item.workerId === spawned.handle.id
    && item.action === "none"
    && item.reason === "authoritative-broker-recovery-required"
  )));
  const job = tryReadJob(root, spawned.handle.id, env);
  assert.equal(job.status, "running");
  assert.equal(job.completedAt, null);
  assert.equal(job.result, null);
});

test("service restart replays an unchanged spawn despite a fresh context capture timestamp", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const stableManifest = captureContextManifest(root);
  let captures = 0;
  const captureContext = () => {
    const body = {
      ...stableManifest,
      capturedAt: new Date(
        Date.parse(stableManifest.capturedAt) + (++captures * 1000)
      ).toISOString()
    };
    delete body.manifestId;
    delete body.digest;
    const digest = stableDigest(body);
    return {
      ...body,
      manifestId: `ctx-${digest.slice(0, 24)}`,
      digest
    };
  };
  const launchWorker = () => ({ providerLaunchState: "pending", providerLaunched: false });
  const firstService = createWorkerService({
    root,
    principal: principal(root),
    env,
    launchWorker,
    captureContext
  });
  const first = firstService.spawn({
    userRequest: "Two process",
    idempotencyKey: "spawn-two-proc-0001"
  });
  // Simulate broker restart: new service reads same env/state.
  const service = createWorkerService({
    root,
    principal: principal(root),
    env,
    launchWorker,
    captureContext
  });
  const snapshot = service.get(first.handle.id);
  assert.equal(snapshot.id, first.handle.id);
  assert.equal(snapshot.lifecycleEvents.length >= 1, true);
  // Idempotent spawn after restart returns same worker.
  const replay = service.spawn({
    userRequest: "Two process",
    idempotencyKey: "spawn-two-proc-0001"
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.handle.id, first.handle.id);
});

test("read spawn replay accepts a fresh v2 capture for genuine stored ContextManifest v1 authority", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const idempotencyKey = "spawn-genuine-context-v1-0001";
  const userRequest = "Replay a historical context record";
  const legacy = legacyContextManifest(captureContextManifest(root));
  const first = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({
      userRequest,
      mode: "read",
      contextManifestId: legacy.manifestId
    }),
    contextManifest: legacy,
    idempotencyKey,
    env
  });
  assert.equal(
    tryReadJob(root, first.handle.id, env).request.contextManifest.schemaVersion,
    1
  );

  const current = captureContextManifest(root);
  assert.equal(current.schemaVersion, 2);
  const replay = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({
      userRequest,
      mode: "read",
      contextManifestId: current.manifestId
    }),
    contextManifest: current,
    idempotencyKey,
    env
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.handle.id, first.handle.id);

  const head = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/heads/legacy-replay-drift", head);
  const drifted = captureContextManifest(root);
  assert.throws(
    () => spawnReadOnlyWorker({
      root,
      principal: principal(root),
      envelope: buildTaskEnvelope({
        userRequest,
        mode: "read",
        contextManifestId: drifted.manifestId
      }),
      contextManifest: drifted,
      idempotencyKey,
      env
    }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
  );
});
