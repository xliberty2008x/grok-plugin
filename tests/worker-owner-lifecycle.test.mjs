import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { resolveWorkerAuthority } from "../plugins/grok/scripts/lib/worker-authority.mjs";
import {
  cleanupWriteWorker,
  integrateWriteWorker
} from "../plugins/grok/scripts/lib/worker-owner-lifecycle.mjs";
import { writeJob } from "../plugins/grok/scripts/lib/state.mjs";
import {
  resolveControlWorkspace,
  workspaceState
} from "../plugins/grok/scripts/lib/workspace.mjs";
import {
  captureParentFingerprint,
  classifyWorkerWorktreeEffect,
  createWorkerWorktree,
  expectedWorkerWorktreeRoot,
  inspectWriteVerticalIntegration,
  persistWriteWorkerArtifact
} from "../plugins/grok/scripts/lib/worker-worktree.mjs";
import { git, initRepo, tempDir } from "./helpers.mjs";

const THREAD_A = "019f666a-6469-7cc1-9a8d-8c1adf61e103";
const THREAD_B = "019f666b-1e72-74b1-b27c-9d186d7f1016";
const TURN = "019f666e-4084-7902-8447-249f72043a37";

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalize(value[key])])
  );
}

function digest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function authority(root, threadId = THREAD_A) {
  return resolveWorkerAuthority({
    threadId,
    plugin_id: "grok@grok-companion",
    "x-codex-turn-metadata": {
      thread_id: threadId,
      turn_id: TURN,
      plugin_id: "grok@grok-companion"
    },
    "codex/sandbox-state-meta": {
      sandboxCwd: pathToFileURL(root).href
    }
  }, { mutation: true });
}

function envFor() {
  const pluginData = tempDir("grok-owner-lifecycle-data-");
  return {
    HOME: path.dirname(pluginData),
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_PLUGIN_DATA: pluginData
  };
}

function terminalWriteFixture(t, label = "base") {
  const root = initRepo();
  const env = envFor();
  fs.writeFileSync(path.join(root, "target.txt"), "before\n");
  git(root, "add", "target.txt");
  git(root, "commit", "-m", "add target");
  const parentFingerprint = captureParentFingerprint(root);
  const control = resolveControlWorkspace(root, env);
  const workerId = `task-${crypto
    .createHash("sha256")
    .update(label)
    .digest("hex")
    .slice(0, 24)}`;
  const worktree = createWorkerWorktree({
    controlRoot: root,
    baseCommit: parentFingerprint.head,
    workerId,
    env
  });
  let removed = false;
  t.after(() => {
    if (removed) return;
    try {
      git(root, "worktree", "remove", "--force", worktree.executionRoot);
    } catch {}
    try {
      fs.rmdirSync(path.dirname(worktree.executionRoot));
    } catch {}
  });
  fs.writeFileSync(path.join(worktree.executionRoot, "target.txt"), "after\n");
  const artifact = persistWriteWorkerArtifact({
    workerId,
    controlWorkspaceId: control.controlWorkspaceId,
    controlRoot: root,
    executionRoot: worktree.executionRoot,
    baseCommit: parentFingerprint.head,
    env
  });
  const baseTree = git(root, "rev-parse", "HEAD^{tree}");
  const parentFingerprintDigest = digest(parentFingerprint);
  const executionBinding = {
    workerId,
    controlWorkspaceId: control.controlWorkspaceId,
    controlRoot: control.controlRoot,
    gitCommonDir: control.gitCommonDir,
    baseCommit: parentFingerprint.head,
    baseTree,
    parentFingerprint,
    parentFingerprintDigest,
    expectedExecutionRoot: worktree.executionRoot,
    bindingDigest: digest({
      workerId,
      controlWorkspaceId: control.controlWorkspaceId,
      baseCommit: parentFingerprint.head,
      parentFingerprintDigest,
      expectedExecutionRoot: worktree.executionRoot
    })
  };
  const record = artifact.record;
  const createdAt = new Date().toISOString();
  const job = {
    schemaVersion: 3,
    id: workerId,
    kind: "task",
    jobClass: "task",
    write: true,
    status: "completed",
    phase: "done",
    summary: "Completed exact write vertical",
    progress: "Runtime cleaned; artifact persisted",
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    completedAt: createdAt,
    heartbeatAt: createdAt,
    host: { kind: "codex", sessionId: THREAD_A },
    controlWorkspaceId: control.controlWorkspaceId,
    executionBinding,
    provisioning: { state: "ready" },
    provisioningRuntime: {
      intent: {
        operationId: `worktree-${label}`
      }
    },
    grokSessionId: `session-${label}`,
    controllerProcess: null,
    workerProcess: null,
    providerProcess: null,
    request: {
      providerHomeId: workerId,
      spawn: {
        executionBindingDigest: executionBinding.bindingDigest,
        providerLaunchOutcome: "launched",
        dispatch: {
          schemaVersion: 2,
          state: "provider-started",
          providerGeneration: 1
        }
      }
    },
    result: {
      hostVerification: "not_run",
      taskRuntimeCleaned: true,
      writeArtifact: {
        schemaVersion: record.schemaVersion,
        path: record.path,
        baseCommit: record.baseCommit,
        manifestDigest: record.manifestDigest,
        securityDigest: record.securityDigest,
        patchDigest: record.patchDigest,
        contentDigest: record.contentDigest,
        contentBytes: record.contentBytes,
        createdAt: record.createdAt
      }
    },
    error: null,
    lifecycleEvents: []
  };
  writeJob(root, job, env);
  return {
    root,
    env,
    workerId,
    parentFingerprint,
    control,
    worktree,
    artifact,
    job,
    principal: authority(root),
    markRemoved() { removed = true; }
  };
}

async function simulateOwnerController(input, effectName, invoke) {
  assert.equal(typeof input.stateDir, "string");
  assert.equal(typeof input.controlRoot, "string");
  assert.equal(typeof input.executionRoot, "string");
  assert.equal(typeof input.callbacks?.prepare, "function");
  const executableIdentity = Object.freeze({
    identityDigest: "e".repeat(64),
    releaseIdentityDigest: "f".repeat(64)
  });
  const prepared = await input.callbacks.prepare({
    purpose: input.binding.purpose,
    effect: effectName,
    binding: input.binding,
    executableIdentity
  });
  const binding = Object.freeze({
    ...input.binding,
    providerSpawnIntentId: prepared.intent.intentId
  });
  const processIdentity = Object.freeze({
    pid: 999_991,
    startToken: "test-controller-start",
    processGroupId: 999_991
  });
  await input.callbacks.activate({
    purpose: input.binding.purpose,
    effect: effectName,
    intentId: prepared.intent.intentId,
    providerSpawnIntentId: prepared.intent.intentId,
    binding,
    executableIdentity,
    processIdentity
  });
  const effectReceipt = await invoke(input);
  const cleanupProof = {
    processGroupGone: true,
    providerGuardAbsent: true,
    credentialAbsent: true,
    controllerHomeAbsent: true
  };
  await input.callbacks.settle({
    purpose: input.binding.purpose,
    effect: effectName,
    intentId: prepared.intent.intentId,
    providerSpawnIntentId: prepared.intent.intentId,
    binding,
    executableIdentity,
    processIdentity,
    outcome: "completed",
    receipts: [effectReceipt],
    cleanupProof
  });
  return {
    receipts: [effectReceipt],
    cleanupProof
  };
}

function integrationArguments(fixture, overrides = {}) {
  return {
    root: fixture.root,
    principal: fixture.principal,
    workerId: fixture.workerId,
    manifestDigest: fixture.artifact.record.manifestDigest,
    idempotencyKey: `integrate-${fixture.workerId}`,
    env: fixture.env,
    runIntegrationEffect: (input) => simulateOwnerController(
      input,
      "apply",
      async () => {
        fs.writeFileSync(
          path.join(fixture.root, "target.txt"),
          fixture.artifact.content
        );
        return { status: "applied" };
      }
    ),
    ...overrides
  };
}

test("host integration observer distinguishes unchanged, exact effect, and drift", () => {
  const root = initRepo();
  fs.writeFileSync(path.join(root, "target.txt"), "before\n");
  git(root, "add", "target.txt");
  git(root, "commit", "-m", "add target");
  const env = envFor();
  const workerId = "task-111111111111111111111111";
  const before = captureParentFingerprint(root);
  const control = resolveControlWorkspace(root, env);
  const worktree = createWorkerWorktree({
    controlRoot: root,
    baseCommit: before.head,
    workerId,
    env
  });
  fs.writeFileSync(path.join(worktree.executionRoot, "target.txt"), "after\n");
  const artifact = persistWriteWorkerArtifact({
    workerId,
    controlWorkspaceId: control.controlWorkspaceId,
    controlRoot: root,
    executionRoot: worktree.executionRoot,
    baseCommit: before.head,
    env
  });

  assert.equal(inspectWriteVerticalIntegration({
    controlRoot: root,
    artifact,
    parentFingerprint: before,
    expectedWorkerId: workerId
  }).classification, "unchanged");

  fs.writeFileSync(path.join(root, "target.txt"), artifact.content);
  const exact = inspectWriteVerticalIntegration({
    controlRoot: root,
    artifact,
    parentFingerprint: before,
    expectedWorkerId: workerId
  });
  assert.equal(exact.classification, "exact-effect");
  assert.equal(exact.evidence.patchDigest, artifact.record.patchDigest);
  assert.equal(exact.evidence.contentDigest, artifact.record.contentDigest);

  fs.writeFileSync(path.join(root, "tracked.txt"), "foreign drift\n");
  assert.equal(inspectWriteVerticalIntegration({
    controlRoot: root,
    artifact,
    parentFingerprint: before,
    expectedWorkerId: workerId
  }).classification, "drift");

  git(root, "worktree", "remove", "--force", worktree.executionRoot);
  fs.rmdirSync(path.dirname(worktree.executionRoot));
});

test("integration persists exact host proof and same-key replay keeps receipt byte-identical", async (t) => {
  const fixture = terminalWriteFixture(t, "success");
  const first = await integrateWriteWorker(integrationArguments(fixture));
  assert.equal(first.replayed, false);
  assert.equal(first.receipt.status, "verified");
  assert.equal(first.receipt.manifestDigest, fixture.artifact.record.manifestDigest);
  assert.equal(first.receipt.contentDigest, fixture.artifact.record.contentDigest);
  assert.equal(JSON.stringify(first.receipt).includes(fixture.root), false);
  assert.equal(JSON.stringify(first.receipt).includes(fixture.job.grokSessionId), false);

  const replay = await integrateWriteWorker(integrationArguments(fixture, {
    runIntegrationEffect: async () => {
      throw new Error("must not execute on replay");
    }
  }));
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, first.receipt);

  const registry = path.join(
    workspaceState(fixture.root, fixture.env),
    "owner-lifecycle",
    "registry.json"
  );
  assert.equal(fs.lstatSync(registry).mode & 0o777, 0o600);
});

test("integration adopts exact effect after provider response loss and blocks parent drift", async (t) => {
  const adopted = terminalWriteFixture(t, "response-loss");
  const result = await integrateWriteWorker(integrationArguments(adopted, {
    runIntegrationEffect: async () => {
      fs.writeFileSync(
        path.join(adopted.root, "target.txt"),
        adopted.artifact.content
      );
      throw new Error("response lost");
    }
  }));
  assert.equal(result.receipt.status, "verified");
  assert.equal(result.replayed, false);

  const drifted = terminalWriteFixture(t, "drift");
  fs.writeFileSync(path.join(drifted.root, "tracked.txt"), "foreign\n");
  await assert.rejects(
    integrateWriteWorker(integrationArguments(drifted)),
    (error) => error?.code === "E_INTEGRATION"
      && error?.details?.classification === "drift"
  );
});

test("foreign owner is rejected before malformed idempotency is examined", async (t) => {
  const fixture = terminalWriteFixture(t, "foreign");
  await assert.rejects(
    integrateWriteWorker(integrationArguments(fixture, {
      principal: authority(fixture.root, THREAD_B),
      idempotencyKey: "",
      runIntegrationEffect: null
    })),
    (error) => error?.code === "E_JOB_NOT_FOUND"
  );
});

test("cleanup closes, deletes, officially removes, proves absence, and replays", async (t) => {
  const fixture = terminalWriteFixture(t, "cleanup");
  const integrated = await integrateWriteWorker(integrationArguments(fixture));
  let sessionPresent = true;
  let closeCalls = 0;
  let deleteCalls = 0;
  let removeCalls = 0;
  const cleanupArgs = {
    root: fixture.root,
    principal: fixture.principal,
    workerId: fixture.workerId,
    integrationReceiptDigest: integrated.receipt.receiptDigest,
    idempotencyKey: `cleanup-${fixture.workerId}`,
    env: fixture.env,
    runCloseEffect: async ({ binding }) => {
      closeCalls += 1;
      assert.equal(binding.sessionId, fixture.job.grokSessionId);
      assert.equal(binding.executionRoot, fixture.worktree.executionRoot);
      return { status: "closed" };
    },
    inspectProviderSession: async ({ providerSessionId }) => {
      assert.equal(providerSessionId, fixture.job.grokSessionId);
      return { present: sessionPresent };
    },
    deleteProviderSession: async ({ providerSessionId }) => {
      deleteCalls += 1;
      assert.equal(providerSessionId, fixture.job.grokSessionId);
      sessionPresent = false;
      return { deleted: true };
    },
    runRemoveEffect: async ({ binding }) => {
      removeCalls += 1;
      assert.equal(binding.sessionId, fixture.job.grokSessionId);
      git(fixture.root, "worktree", "remove", "--force", fixture.worktree.executionRoot);
      return { status: "removed" };
    }
  };
  const cleaned = await cleanupWriteWorker(cleanupArgs);
  fixture.markRemoved();
  assert.equal(cleaned.replayed, false);
  assert.equal(cleaned.receipt.status, "absent");
  assert.equal(closeCalls, 1);
  assert.equal(deleteCalls, 1);
  assert.equal(removeCalls, 1);
  assert.equal(JSON.stringify(cleaned.receipt).includes(fixture.root), false);
  assert.equal(JSON.stringify(cleaned.receipt).includes(fixture.job.grokSessionId), false);
  assert.equal(fs.existsSync(path.dirname(fixture.worktree.executionRoot)), false);
  assert.equal(classifyWorkerWorktreeEffect({
    controlRoot: fixture.root,
    executionRoot: expectedWorkerWorktreeRoot(
      fixture.root,
      fixture.workerId,
      fixture.env
    ),
    baseCommit: fixture.parentFingerprint.head,
    workerId: fixture.workerId,
    env: fixture.env
  }).classification, "absent");

  const replay = await cleanupWriteWorker({
    ...cleanupArgs,
    runCloseEffect: async () => { throw new Error("must not close"); },
    deleteProviderSession: async () => { throw new Error("must not delete"); },
    inspectProviderSession: async () => { throw new Error("must not inspect"); },
    runRemoveEffect: async () => { throw new Error("must not remove"); }
  });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, cleaned.receipt);
});

test("cleanup adopts delete and official remove effects after response loss", async (t) => {
  const fixture = terminalWriteFixture(t, "cleanup-loss");
  const integrated = await integrateWriteWorker(integrationArguments(fixture));
  let sessionPresent = true;
  const cleaned = await cleanupWriteWorker({
    root: fixture.root,
    principal: fixture.principal,
    workerId: fixture.workerId,
    integrationReceiptDigest: integrated.receipt.receiptDigest,
    idempotencyKey: `cleanup-loss-${fixture.workerId}`,
    env: fixture.env,
    runCloseEffect: async () => ({ status: "closed" }),
    inspectProviderSession: async () => ({ present: sessionPresent }),
    deleteProviderSession: async () => {
      sessionPresent = false;
      throw new Error("delete response lost");
    },
    runRemoveEffect: async () => {
      git(fixture.root, "worktree", "remove", "--force", fixture.worktree.executionRoot);
      throw new Error("remove response lost");
    }
  });
  fixture.markRemoved();
  assert.equal(cleaned.receipt.status, "absent");
  assert.match(cleaned.receipt.sessionDeletionDigest, /^[a-f0-9]{64}$/);
  assert.match(cleaned.receipt.absenceProofDigest, /^[a-f0-9]{64}$/);
});

test("cleanup classifies bound session-load failure and does not delete or remove", async (t) => {
  const fixture = terminalWriteFixture(t, "cleanup-load-failure");
  const integrated = await integrateWriteWorker(integrationArguments(fixture));
  let closeAttempts = 0;
  let deleteCalls = 0;
  let removeCalls = 0;

  await assert.rejects(
    cleanupWriteWorker({
      root: fixture.root,
      principal: fixture.principal,
      workerId: fixture.workerId,
      integrationReceiptDigest: integrated.receipt.receiptDigest,
      idempotencyKey: `cleanup-load-failure-${fixture.workerId}`,
      env: fixture.env,
      runCloseEffect: async ({ binding }) => {
        closeAttempts += 1;
        assert.equal(binding.providerHomeId, fixture.workerId);
        const error = new Error("provider session persistence unavailable");
        error.details = { ownerControllerStage: "load" };
        throw error;
      },
      inspectProviderSession: async () => {
        throw new Error("must not inspect before exact close");
      },
      deleteProviderSession: async () => {
        deleteCalls += 1;
      },
      runRemoveEffect: async () => {
        removeCalls += 1;
      }
    }),
    (error) => error?.code === "E_WORKTREE"
      && error?.details?.classification === "session-load-failed"
  );

  assert.equal(closeAttempts, 2);
  assert.equal(deleteCalls, 0);
  assert.equal(removeCalls, 0);
  assert.equal(fs.existsSync(fixture.worktree.executionRoot), true);
});
