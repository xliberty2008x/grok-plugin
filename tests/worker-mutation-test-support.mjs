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

export const THREAD = "019f666a-6469-7cc1-9a8d-8c1adf61e103";
export const THREAD_B = "019f666b-1e72-74b1-b27c-9d186d7f1016";
export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const MUTATION_MODULE = new URL("../plugins/grok/scripts/lib/worker-mutation.mjs", import.meta.url).href;
export const TASK_CONTRACT_MODULE = new URL("../plugins/grok/scripts/lib/task-contract.mjs", import.meta.url).href;
export const TEST_EXECUTABLE_IDENTITY = createExecutableAttestation({
  canonicalPath: "/private/test/grok",
  device: "1",
  inode: "2",
  mode: 0o100755,
  size: 4096,
  executableDigest: "1".repeat(64)
}, {
  releaseSource: "official-package-pin-v1",
  packageName: "@xai-official/grok",
  packageVersion: "0.2.112",
  packageGitHead: "9".repeat(40),
  packageIntegrityDigest: "3".repeat(64),
  platform: process.platform,
  arch: process.arch,
  version: "0.2.112",
  buildCommit: "9bbd559437aa",
  channel: "stable",
  size: 4096,
  executableDigest: "1".repeat(64)
});
export const TEST_MANAGED_EXECUTABLE_IDENTITY = createManagedObservedAttestation({
  canonicalPath: "/private/test/grok-managed",
  device: "7",
  inode: "8",
  mode: 0o100755,
  size: 4096,
  executableDigest: "2".repeat(64)
}, {
  releaseRecognition: "managed-observed",
  releaseSource: "managed-observed-v1",
  sourceProvenanceDigest: "4".repeat(64),
  platform: process.platform,
  arch: process.arch,
  version: "0.2.114",
  buildCommit: "unobserved",
  channel: "stable",
  size: 4096,
  executableDigest: "2".repeat(64)
});

export function runIsolatedModule(source) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: TEST_DIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

export function lastJson(stdout) {
  const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).at(-1);
  return JSON.parse(line);
}

export function principal(root, overrides = {}) {
  return {
    hostKind: "codex",
    threadId: THREAD,
    turnId: "019f666e-4084-7902-8447-249f72043a37",
    source: "codex-mcp-stdio",
    pluginId: "grok@grok-companion",
    root,
    mutationCapable: true,
    ...overrides
  };
}

export function brokerPrincipal(root) {
  return resolveWorkerAuthority({
    threadId: THREAD,
    plugin_id: "grok@grok-companion",
    "x-codex-turn-metadata": {
      thread_id: THREAD,
      turn_id: "019f666e-4084-7902-8447-249f72043a37",
      plugin_id: "grok@grok-companion"
    },
    "codex/sandbox-state-meta": {
      sandboxCwd: pathToFileURL(root).href
    }
  }, { mutation: true });
}

export function envFor(root) {
  const pluginData = tempDir("grok-mutation-data-");
  return {
    env: {
      HOME: path.dirname(pluginData),
      GROK_COMPANION_HOST: "codex",
      GROK_COMPANION_PLUGIN_DATA: pluginData
    },
    pluginData
  };
}

export function cancelIdempotencyFile(root, key, env) {
  const keyDigest = crypto.createHash("sha256").update(key).digest("hex");
  return path.join(workspaceState(root, env), "idempotency", "cancel", `${keyDigest}.json`);
}

export function spawnIdempotencyFile(root, key, env) {
  const keyDigest = crypto.createHash("sha256").update(key).digest("hex");
  return path.join(workspaceState(root, env), "idempotency", "spawn", `${keyDigest}.json`);
}

export function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalize(value[key])])
  );
}

export function stableDigest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function rebindWorkerLaunchAuthorization(job) {
  return {
    ...job,
    workerAuthorization: {
      ...job.workerAuthorization,
      launchContractDigest: launchContractDigest(job)
    }
  };
}

export function legacyContextManifest(manifest) {
  const body = structuredClone(manifest);
  const capturedAt = body.capturedAt;
  delete body.manifestId;
  delete body.digest;
  delete body.capturedAt;
  body.schemaVersion = 1;
  // Genuine historical v1 records predate issue #34's task-relevant/shared-ref
  // identity split. Keeping these fields would only relabel a v2 record.
  delete body.git.taskRelevantMetadataIdentity;
  delete body.git.sharedRefIdentity;
  const digest = stableDigest(body);
  return {
    ...body,
    manifestId: `ctx-${digest.slice(0, 24)}`,
    digest,
    capturedAt
  };
}

export function spawnResponseWitnessBody(witness) {
  const { witnessId: _witnessId, ...body } = witness;
  return body;
}

export function refreshSpawnWitnessId(record) {
  record.responseWitness.witnessId = `spawnw-${
    stableDigest(spawnResponseWitnessBody(record.responseWitness)).slice(0, 24)
  }`;
  return record;
}

export function providerGuardFile(root, marker) {
  const scopeDigest = crypto.createHash("sha256").update(gitCommonDir(root)).digest("hex");
  const guardRoot = path.join(
    os.tmpdir(),
    `grok-companion-guards-${typeof process.getuid === "function" ? process.getuid() : "user"}`
  );
  return path.join(guardRoot, scopeDigest, `${marker}.json`);
}

export function plannedWriteProvisioningFixture(label) {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({
    userRequest: `Provision bounded write ${label}`,
    mode: "write",
    scope: { include: ["tracked.txt"], exclude: [] }
  });
  const admitted = admitWriteWorkerPlan({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: `write-provisioning-${label}-0001`,
    roleId: "implementer",
    allowWriteSpawn: true,
    writeLifecycleCapabilityDigest: "c".repeat(64),
    env
  });
  const job = tryReadJob(root, admitted.handle.id, env);
  return {
    root,
    env,
    envelope,
    workerId: job.id,
    binding: job.executionBinding,
    journal: job.provisioning,
    actor: {
      attemptId: "a".repeat(32),
      fence: 1,
      holderId: "b".repeat(32),
      executableIdentity: TEST_EXECUTABLE_IDENTITY
    }
  };
}

export function plannedWriteVerticalFixture(label) {
  const root = initRepo();
  fs.writeFileSync(path.join(root, "target.txt"), "before\n", "utf8");
  git(root, "add", "target.txt");
  git(root, "commit", "-m", "add write vertical target");
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({
    userRequest: `Edit target.txt for ${label}`,
    mode: "write",
    scope: { include: ["target.txt"], exclude: [] },
    requiredVerification: ["git diff --check"]
  });
  const admitted = admitWriteWorkerPlan({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: `write-vertical-${label}-0001`,
    roleId: "implementer",
    allowWriteSpawn: true,
    writeLifecycleCapabilityDigest: "c".repeat(64),
    env
  });
  const job = tryReadJob(root, admitted.handle.id, env);
  return {
    root,
    env,
    envelope,
    workerId: job.id,
    binding: job.executionBinding,
    journal: job.provisioning,
    actor: {
      attemptId: "a".repeat(32),
      fence: 1,
      holderId: "b".repeat(32),
      executableIdentity: TEST_EXECUTABLE_IDENTITY
    }
  };
}

export async function detachedProvisioner(t, workerId) {
  const child = spawnProcess(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", workerId, "worktree-provisioning"],
    { detached: true, stdio: "ignore" }
  );
  const identity = {
    pid: child.pid,
    startToken: await waitFor(() => processStartToken(child.pid), {
      timeoutMs: 5_000,
      intervalMs: 25
    }),
    processGroupId: child.pid
  };
  t.after(async () => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    try {
      await waitFor(() => processGroupGone(identity), {
        timeoutMs: 5_000,
        intervalMs: 25
      });
    } catch {}
  });
  return { child, identity };
}

export async function detachedDispatchProcess(t, {
  workerId,
  attemptId,
  fence,
  nonce,
  processKind
}) {
  const child = spawnProcess(
    process.execPath,
    [
      "-e",
      "setInterval(() => {}, 1000)",
      workerId,
      processKind
    ],
    { detached: true, stdio: "ignore" }
  );
  const identity = {
    pid: child.pid,
    startToken: await waitFor(() => processStartToken(child.pid), {
      timeoutMs: 5_000,
      intervalMs: 25
    }),
    nonce,
    processGroupId: child.pid,
    commandMarker: workerId,
    dispatchAttemptId: attemptId,
    dispatchFence: fence
  };
  t.after(async () => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    try {
      await waitFor(() => processGroupGone(identity), {
        timeoutMs: 5_000,
        intervalMs: 25
      });
    } catch {}
  });
  return { child, identity };
}

export function claimedReadDispatchFixture(label) {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({
    userRequest: `Observe pre-provider terminal workspace for ${label}`,
    mode: "read",
    scope: { include: ["tracked.txt"], exclude: [] }
  });
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: `terminal-observation-${label}-spawn-0001`,
    env
  });
  const workerId = spawned.handle.id;
  const claim = claimWorkerDispatch({
    root,
    principal: principal(root),
    workerId,
    env
  });
  return { root, env, envelope, workerId, claim };
}

export async function workerStartedReadDispatchFixture(t, label) {
  const fixture = claimedReadDispatchFixture(label);
  const controllerIntent = prepareDispatchProcessSpawn({
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    processKind: "controller",
    nonce: fixture.claim.nonce,
    fence: fixture.claim.fence,
    env: fixture.env
  });
  const controller = await detachedDispatchProcess(t, {
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    fence: fixture.claim.fence,
    nonce: fixture.claim.nonce,
    processKind: "controller"
  });
  transitionWorkerDispatch({
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    fence: fixture.claim.fence,
    state: "controller-started",
    controllerProcess: controller.identity,
    spawnIntentId: controllerIntent.intent.intentId,
    env: fixture.env
  });
  const workerIntent = prepareDispatchProcessSpawn({
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    processKind: "worker",
    nonce: fixture.claim.nonce,
    fence: fixture.claim.fence,
    env: fixture.env
  });
  const worker = await detachedDispatchProcess(t, {
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    fence: fixture.claim.fence,
    nonce: fixture.claim.nonce,
    processKind: "worker"
  });
  transitionWorkerDispatch({
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    fence: fixture.claim.fence,
    state: "worker-started",
    workerProcess: worker.identity,
    spawnIntentId: workerIntent.intent.intentId,
    env: fixture.env
  });
  return { ...fixture, controller, worker };
}

export async function providerStartedReadDispatchFixture(t, label) {
  const fixture = await workerStartedReadDispatchFixture(t, label);
  const provider = await detachedDispatchProcess(t, {
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    fence: fixture.claim.fence,
    nonce: fixture.claim.nonce,
    processKind: "provider"
  });
  provider.identity.providerGeneration = 1;
  transitionWorkerDispatch({
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    fence: fixture.claim.fence,
    state: "provider-started",
    providerProcess: provider.identity,
    env: fixture.env
  });
  return { ...fixture, provider };
}

export function prepareProvisioningIntent(fixture) {
  return prepareWriteProvisionerIntent({
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    executionBindingDigest: fixture.binding.bindingDigest,
    expectedJournalDigest: fixture.journal.journalDigest,
    ...fixture.actor,
    env: fixture.env
  });
}

export async function activateRegisteredProvisioning(t, fixture) {
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
  return {
    prepared,
    child,
    identity,
    activated,
    registered,
    registeredAt
  };
}

export async function readyManagedWriteDispatchFixture(t, label) {
  const fixture = plannedWriteVerticalFixture(label);
  const active = await activateRegisteredProvisioning(t, fixture);
  const official = createWorkerWorktree({
    controlRoot: fixture.root,
    baseCommit: fixture.binding.baseCommit,
    workerId: fixture.workerId,
    env: fixture.env
  });
  t.after(() => {
    try {
      git(
        fixture.root,
        "worktree",
        "remove",
        "--force",
        official.executionRoot
      );
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
  const executionContextManifest = captureContextManifest(
    official.executionRoot
  );
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
    workerId: fixture.workerId,
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
  const authorized = authorizeReadyWriteWorkerDispatch({
    root: fixture.root,
    principal: authority,
    workerId: fixture.workerId,
    writeLifecycleCapabilityDigest: "c".repeat(64),
    validateWriteLifecycleCapability: () => "c".repeat(64),
    env: fixture.env
  });
  assert.equal(authorized.authorized, true);
  assert.equal(authorized.job.request.spawn.dispatch.state, "pending");
  return {
    ...fixture,
    active,
    official,
    executionContextManifest,
    authority,
    authorized
  };
}

export async function cleanupPendingAbsentProvisioning(t, label) {
  const fixture = plannedWriteProvisioningFixture(label);
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
  fs.mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(managedRoot, 0o700);
  assert.equal(fs.existsSync(workerParent), false);
  return { fixture, active, retained };
}

export async function loadWorkerProvisionerWithProviderSeam(seam) {
  const moduleFile = fileURLToPath(new URL(
    "../plugins/grok/scripts/lib/worker-provisioner.mjs",
    import.meta.url
  ));
  const seamKey = `__grokWorkerProvisionerSeam${
    crypto.randomBytes(12).toString("hex")
  }`;
  globalThis[seamKey] = seam;
  const shimSource = `
    function seam() {
      const value = globalThis[${JSON.stringify(seamKey)}];
      if (!value) throw new Error("worker provisioner test seam was released");
      return value;
    }
    export async function ensureChildExit(...args) {
      return seam().ensureChildExit?.(...args);
    }
    export async function openProvider(...args) {
      return seam().openProvider(...args);
    }
    export function providerCleanupIdentity(...args) {
      return seam().providerCleanupIdentity?.(...args) ?? null;
    }
    export function taskEnvironment(...args) {
      return seam().taskEnvironment(...args);
    }
  `;
  const shimUrl = `data:text/javascript;base64,${
    Buffer.from(shimSource).toString("base64")
  }`;
  const providerSeamSpecifiers = new Set([
    "./provider-acp-runtime.mjs",
    "./provider-process.mjs",
    "./provider-task-environment.mjs"
  ]);
  const replacedProviderSeams = new Set();
  const moduleBase = pathToFileURL(moduleFile);
  const source = fs.readFileSync(moduleFile, "utf8").replace(
    /from "(\.\/[^"]+)"/g,
    (_match, specifier) => {
      if (providerSeamSpecifiers.has(specifier)) {
        replacedProviderSeams.add(specifier);
        return `from "${shimUrl}"`;
      }
      return `from "${new URL(specifier, moduleBase).href}"`;
    }
  );
  assert.deepEqual(
    [...replacedProviderSeams].sort(),
    [...providerSeamSpecifiers].sort(),
    "worker provisioner provider seams must cover the exact leaf imports"
  );
  try {
    const loaded = await import(`data:text/javascript;base64,${
      Buffer.from(source).toString("base64")
    }#${crypto.randomBytes(8).toString("hex")}`);
    return {
      provisionWriteWorkerWorktree: loaded.provisionWriteWorkerWorktree,
      release() {
        delete globalThis[seamKey];
      }
    };
  } catch (error) {
    delete globalThis[seamKey];
    throw error;
  }
}

export function controllerEnvironmentSeam(counter) {
  return function taskEnvironment(
    stateDir,
    _root,
    _profile,
    homeMarker
  ) {
    counter.constructed += 1;
    const home = path.join(stateDir, "task-homes", homeMarker);
    const grokHome = path.join(home, ".grok");
    const controllerCwd = path.join(home, "controller-cwd");
    fs.mkdirSync(grokHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(controllerCwd, { mode: 0o700 });
    return {
      env: {},
      home,
      grokHome,
      knownSecrets: [],
      sandboxProfile: "companion_test_worktree_controller",
      controllerCwd,
      controllerProfileId: "worktree-controller-v1",
      gitExecutableDigest: "7".repeat(64),
      gitInstallationRoot: path.dirname(process.execPath),
      verifyGitExecutable() {},
      revokeCredential() {}
    };
  };
}
