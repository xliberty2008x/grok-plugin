import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  activateWriteProvisioningAttempt,
  admitWriteWorkerPlan,
  assertDispatchContract,
  claimWorkerDispatch,
  prepareWriteProvisionerIntent,
  prepareDispatchProcessSpawn,
  prepareWorkerProviderSpawn,
  spawnReadOnlyWorker,
  transitionWorkerDispatch
} from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import { reconcileBrokerWorkers } from "../plugins/grok/scripts/lib/worker-recovery.mjs";
import { processGroupGone, processStartToken } from "../plugins/grok/scripts/lib/process-control.mjs";
import { createExecutableAttestation } from "../plugins/grok/scripts/lib/executable-identity.mjs";
import {
  loadProviderGuard,
  registerProviderGuard,
  unregisterProviderGuard
} from "../plugins/grok/scripts/lib/recursion-guard.mjs";
import { tryReadJob, updateJob, writeJob } from "../plugins/grok/scripts/lib/state.mjs";
import { buildTaskEnvelope } from "../plugins/grok/scripts/lib/task-contract.mjs";
import {
  providerChildEnvironment,
  readProviderBootstrapSpec,
  runProviderBootstrap
} from "../plugins/grok/scripts/lib/provider-bootstrap.mjs";
import {
  assertProviderBootstrapPromotionMessage,
  assertProviderBootstrapReadyMessage,
  cleanupBoundBootstrapStart,
  createProviderBootstrapLaunch,
  publishProviderBootstrapSpec,
  promoteProviderBootstrap,
  recordBoundBootstrapNoChild,
  settleWorktreeBootstrapRegistrationFailure
} from "../plugins/grok/scripts/lib/grok-provider.mjs";
import { resolveControlWorkspace } from "../plugins/grok/scripts/lib/workspace.mjs";

import { initRepo, tempDir, waitFor } from "./helpers.mjs";

const THREAD_ID = "019f76cf-150d-7ec6-892e-4e68fa7a71a3";
const BOOTSTRAP = fileURLToPath(new URL(
  "../plugins/grok/scripts/lib/provider-bootstrap.mjs",
  import.meta.url
));
let sequence = 0;
const TEST_EXECUTABLE_IDENTITY = createExecutableAttestation({
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

function ownerEnvironment(pluginData) {
  return {
    ...process.env,
    HOME: path.dirname(pluginData),
    GROK_COMPANION_PLUGIN_DATA: pluginData,
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_HOST_SESSION_ID: THREAD_ID,
    CODEX_THREAD_ID: THREAD_ID
  };
}

function spawnIdle(t) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    detached: true,
    stdio: "ignore"
  });
  t.after(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  });
  return child;
}

async function identityFor(child, fixture, { nonce = true, providerGeneration = null } = {}) {
  const identity = {
    pid: child.pid,
    startToken: await waitFor(() => processStartToken(child.pid)),
    processGroupId: child.pid,
    commandMarker: fixture.workerId,
    dispatchAttemptId: fixture.claim.attemptId,
    dispatchFence: fixture.claim.fence
  };
  if (nonce) identity.nonce = fixture.claim.nonce;
  if (providerGeneration != null) identity.providerGeneration = providerGeneration;
  return identity;
}

async function providerIdentityFor(child) {
  return {
    pid: child.pid,
    startToken: await waitFor(() => processStartToken(child.pid)),
    processGroupId: child.pid
  };
}

function waitForClose(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      reject(new Error(`child ${child.pid} did not close within ${timeoutMs}ms`));
    }, timeoutMs);
    const onClose = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("close", onClose);
    };
    child.once("close", onClose);
  });
}

async function killAndWait(child, identity) {
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  await waitFor(() => processGroupGone(identity));
}

async function workerStartedFixture(t, label) {
  sequence += 1;
  const root = initRepo();
  const pluginData = tempDir(`provider-bootstrap-${label}-data-`);
  const env = ownerEnvironment(pluginData);
  const principal = { hostKind: "codex", threadId: THREAD_ID };
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
  });
  const admitted = spawnReadOnlyWorker({
    root,
    principal,
    envelope: buildTaskEnvelope({
      userRequest: `Exercise provider bootstrap crash window ${label}`,
      mode: "read"
    }),
    idempotencyKey: `provider-bootstrap-${label}-${sequence}`,
    env
  });
  const workerId = admitted.handle.id;
  const claim = claimWorkerDispatch({ root, principal, workerId, env });
  const fixture = { root, pluginData, env, principal, workerId, claim };

  const controller = spawnIdle(t);
  const controllerProcess = await identityFor(controller, fixture);
  const controllerIntent = prepareDispatchProcessSpawn({
    root,
    workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    processKind: "controller",
    nonce: claim.nonce,
    env
  }).intent;
  transitionWorkerDispatch({
    root,
    workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    state: "controller-started",
    controllerProcess,
    spawnIntentId: controllerIntent.intentId,
    env
  });

  const worker = spawnIdle(t);
  const workerProcess = await identityFor(worker, fixture);
  const workerIntent = prepareDispatchProcessSpawn({
    root,
    workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    processKind: "worker",
    nonce: claim.nonce,
    env
  }).intent;
  transitionWorkerDispatch({
    root,
    workerId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    state: "worker-started",
    workerProcess,
    spawnIntentId: workerIntent.intentId,
    env
  });
  updateJob(root, workerId, (job) => ({
    ...job,
    workerAuthorization: null,
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        consumedLaunchContractDigest: job.workerAuthorization.launchContractDigest,
        launchContractConsumedAt: new Date().toISOString()
      }
    }
  }), env);
  await killAndWait(worker, workerProcess);
  await killAndWait(controller, controllerProcess);
  return { ...fixture, controllerProcess, workerProcess };
}

function bootstrapLaunch(fixture, intent, providerArgs, { binary = process.execPath } = {}) {
  const binding = bootstrapBinding(fixture, intent);
  return createProviderBootstrapLaunch({
    root: binding.executionRoot,
    marker: fixture.workerId,
    owner: THREAD_ID,
    binding,
    binary,
    args: providerArgs
  });
}

function bootstrapBinding(fixture, intent) {
  const job = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  return {
    controlWorkspaceId: job.controlWorkspaceId,
    executionRoot: job.request.spawn.executionRoot,
    dispatchAttemptId: fixture.claim.attemptId,
    dispatchFence: fixture.claim.fence,
    providerGeneration: 1,
    providerSpawnIntentId: intent.intentId,
    ...(job.write === true
      ? { executionBindingDigest: job.executionBinding.bindingDigest }
      : {})
  };
}

function readiness(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      cleanup();
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      reject(new Error(`bootstrap ${child.pid} did not publish readiness within ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdio[3].off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const finish = (callback, value) => {
      cleanup();
      callback(value);
    };
    const onData = (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try { finish(resolve, JSON.parse(buffer.slice(0, newline))); }
      catch (error) { finish(reject, error); }
    };
    const onError = (error) => finish(reject, error);
    const onExit = (code, signal) => finish(
      reject,
      new Error(`bootstrap exited ${code ?? signal}`)
    );
    child.stdio[3].on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

test("bootstrap-only state authority is stripped and Windows rejects before spawn", async () => {
  const childEnv = providerChildEnvironment({
    HOME: "/isolated/provider-home",
    GROK_COMPANION_JOB_MARKER: "task-aabbccddeeff0011",
    GROK_COMPANION_BOOTSTRAP_PLUGIN_DATA: "/private/control-state",
    GROK_COMPANION_BOOTSTRAP_SECRET: "must-not-cross"
  });
  assert.equal(childEnv.HOME, "/isolated/provider-home");
  assert.equal(childEnv.GROK_COMPANION_JOB_MARKER, "task-aabbccddeeff0011");
  assert.equal(childEnv.GROK_COMPANION_BOOTSTRAP_PLUGIN_DATA, undefined);
  assert.equal(childEnv.GROK_COMPANION_BOOTSTRAP_SECRET, undefined);

  let spawnCalls = 0;
  await assert.rejects(
    runProviderBootstrap({
      platform: "win32",
      argv: [],
      spawnProvider: () => { spawnCalls += 1; }
    }),
    (error) => error?.code === "E_CAPABILITY"
  );
  assert.equal(spawnCalls, 0);
});

test("bootstrap argv contains only opaque dispatch coordinates while the private spec is exact", async () => {
  const root = "/private/workspace/root-that-must-not-enter-argv";
  const owner = "019f76cf-150d-7ec6-892e-4e68fa7a71a3";
  const marker = "task-aabbccddeeff0011";
  const intentId = "a".repeat(32);
  const launch = createProviderBootstrapLaunch({
    root,
    marker,
    owner,
    binding: {
      controlWorkspaceId: `cws-${"b".repeat(32)}`,
      executionRoot: root,
      dispatchAttemptId: "c".repeat(32),
      dispatchFence: 1,
      providerGeneration: 3,
      providerSpawnIntentId: intentId
    },
    binary: "/private/provider/binary-that-must-not-enter-argv",
    args: ["agent", "stdio", "--private-argument"]
  });
  assert.deepEqual(launch.argv, [
    BOOTSTRAP,
    "--job-marker", marker,
    "--provider-generation", "3",
    "--spawn-intent-id", intentId
  ]);
  const renderedArgv = launch.argv.join(" ");
  assert.equal(renderedArgv.includes(root), false);
  assert.equal(renderedArgv.includes(owner), false);
  assert.equal(renderedArgv.includes("binary-that-must-not-enter-argv"), false);
  assert.equal(renderedArgv.includes("private-argument"), false);
  assert.equal(renderedArgv.includes("--spec"), false);

  const expected = { marker, generation: 3, intentId };
  const parsed = await readProviderBootstrapSpec(Readable.from([launch.specPayload]), expected);
  assert.equal(parsed.root, root);
  assert.equal(parsed.owner, owner);
  assert.deepEqual(parsed.args, ["agent", "stdio", "--private-argument"]);
  assert.equal(Object.hasOwn(parsed.binding, "executionBindingDigest"), false);
  assert.equal(launch.specPayload.includes("executionBindingDigest"), false);
  assert.throws(
    () => createProviderBootstrapLaunch({
      root,
      marker,
      owner,
      binding: parsed.binding,
      binary: parsed.binary,
      args: ["x".repeat(64 * 1024)]
    }),
    (error) => error?.code === "E_USAGE"
  );
});

test("worktree provisioning bootstrap is separately bound and acknowledgements fail closed on identity drift", async () => {
  const root = "/private/control-root-that-must-not-enter-provisioning-argv";
  const controllerCwd = "/private/controller-cwd-that-must-not-enter-provisioning-argv";
  const expectedExecutionRoot = "/private/worker-root-that-does-not-exist-yet";
  const marker = "task-aabbccddeeff0011";
  const binding = {
    purpose: "worktree-provisioning",
    controlWorkspaceId: `cws-${"b".repeat(32)}`,
    controlRoot: root,
    expectedExecutionRoot,
    executionBindingDigest: "c".repeat(64),
    provisioningAttemptId: "d".repeat(32),
    provisioningFence: 2,
    holderId: "e".repeat(32),
    providerSpawnIntentId: "f".repeat(32)
  };
  const launch = createProviderBootstrapLaunch({
    root: controllerCwd,
    marker,
    owner: THREAD_ID,
    binding,
    binary: "/private/provider/binary-that-must-not-enter-argv",
    executableIdentity: TEST_EXECUTABLE_IDENTITY,
    args: ["agent", "stdio", "--private-argument"]
  });
  assert.deepEqual(launch.argv, [
    BOOTSTRAP,
    "--job-marker", marker,
    "--bootstrap-purpose", binding.purpose,
    "--provisioning-attempt-id", binding.provisioningAttemptId,
    "--provisioning-fence", String(binding.provisioningFence),
    "--holder-id", binding.holderId,
    "--spawn-intent-id", binding.providerSpawnIntentId
  ]);
  const renderedArgv = launch.argv.join(" ");
  for (const privateValue of [
    root,
    controllerCwd,
    expectedExecutionRoot,
    binding.executionBindingDigest,
    THREAD_ID,
    "binary-that-must-not-enter-argv",
    "private-argument"
  ]) {
    assert.equal(renderedArgv.includes(privateValue), false);
  }

  const parsed = await readProviderBootstrapSpec(
    Readable.from([launch.specPayload]),
    {
      marker,
      purpose: binding.purpose,
      provisioningAttemptId: binding.provisioningAttemptId,
      provisioningFence: binding.provisioningFence,
      holderId: binding.holderId,
      intentId: binding.providerSpawnIntentId
    }
  );
  assert.deepEqual(parsed.binding, binding);
  assert.equal(parsed.root, controllerCwd);

  const ready = {
    type: "provider-ready",
    grokPid: 1234,
    version: "0.3.0",
    purpose: binding.purpose,
    executionBindingDigest: binding.executionBindingDigest,
    provisioningAttemptId: binding.provisioningAttemptId,
    provisioningFence: binding.provisioningFence,
    holderId: binding.holderId,
    providerSpawnIntentId: binding.providerSpawnIntentId,
    executableIdentity: TEST_EXECUTABLE_IDENTITY
  };
  const promotion = {
    type: "provider-promoted",
    marker,
    purpose: binding.purpose,
    executionBindingDigest: binding.executionBindingDigest,
    provisioningAttemptId: binding.provisioningAttemptId,
    provisioningFence: binding.provisioningFence,
    holderId: binding.holderId,
    providerSpawnIntentId: binding.providerSpawnIntentId
  };
  assert.equal(
    assertProviderBootstrapReadyMessage(
      ready,
      binding,
      TEST_EXECUTABLE_IDENTITY
    ),
    ready
  );
  assert.equal(
    assertProviderBootstrapPromotionMessage(promotion, { marker, ...binding }),
    promotion
  );

  const drifts = [
    ["purpose", "provider-execution"],
    ["executionBindingDigest", "0".repeat(64)],
    ["provisioningAttemptId", "1".repeat(32)],
    ["provisioningFence", binding.provisioningFence + 1],
    ["holderId", "2".repeat(32)],
    ["providerSpawnIntentId", "3".repeat(32)],
    ["executableIdentity", {
      ...TEST_EXECUTABLE_IDENTITY,
      identityDigest: "4".repeat(64)
    }]
  ];
  for (const [field, value] of drifts) {
    assert.throws(
      () => assertProviderBootstrapReadyMessage(
        { ...ready, [field]: value },
        binding,
        TEST_EXECUTABLE_IDENTITY
      ),
      (error) => error?.code === "E_PROCESS_IDENTITY",
      `ready ${field}`
    );
    assert.throws(
      () => assertProviderBootstrapPromotionMessage(
        { ...promotion, [field]: value },
        { marker, ...binding }
      ),
      (error) => error?.code === "E_PROCESS_IDENTITY",
      `promotion ${field}`
    );
  }
  for (const [label, malformedReady, malformedPromotion] of [
    ["missing", (({ holderId, ...rest }) => rest)(ready), (({ holderId, ...rest }) => rest)(promotion)],
    ["extra", { ...ready, providerGeneration: 1 }, { ...promotion, providerGeneration: 1 }]
  ]) {
    assert.throws(
      () => assertProviderBootstrapReadyMessage(
        malformedReady,
        binding,
        TEST_EXECUTABLE_IDENTITY
      ),
      (error) => error?.code === "E_PROCESS_IDENTITY",
      `ready ${label}`
    );
    assert.throws(
      () => assertProviderBootstrapPromotionMessage(
        malformedPromotion,
        { marker, ...binding }
      ),
      (error) => error?.code === "E_PROCESS_IDENTITY",
      `promotion ${label}`
    );
  }
});

test("activated worktree bootstrap no-child callback is awaited and requires durable cleanup proof", async () => {
  const intentId = "8".repeat(32);
  const processIdentity = {
    pid: 1234,
    startToken: "provisioning-bootstrap-start-token",
    processGroupId: 1234
  };
  let callbackCompleted = false;
  let captured = null;
  const settlement = await recordBoundBootstrapNoChild({
    providerLaunch: {
      async noChild(details) {
        captured = details;
        await Promise.resolve();
        callbackCompleted = true;
        return {
          settled: true,
          replayed: false,
          job: {
            status: "failed",
            provisioning: { state: "failed" },
            provisioningRuntime: {
              intent: {
                intentId,
                providerSpawnIntentId: intentId,
                status: "no-child",
                resolution: "cleanup-proven"
              },
              cleanupProof: {
                processIdentity,
                processGroupGone: true,
                providerGuardAbsent: true
              }
            }
          }
        };
      }
    },
    preparedLaunch: { intent: { intentId } },
    worktreeProvisioning: true,
    resolution: "cleanup-proven",
    processIdentity,
    expectedJournalDigest: "9".repeat(64)
  });
  assert.equal(callbackCompleted, true);
  assert.equal(settlement.settled, true);
  assert.equal(captured.expectedJournalDigest, "9".repeat(64));
  assert.equal(captured.processIdentity, processIdentity);
  assert.equal(captured.cleanupProof.processIdentity, processIdentity);
  assert.equal(captured.cleanupProof.processGroupGone, true);
  assert.equal(captured.cleanupProof.providerGuardAbsent, true);
  assert.equal(typeof captured.cleanupProof.observedAt, "string");

  const retained = await recordBoundBootstrapNoChild({
    providerLaunch: {
      noChild: async () => ({
        retained: true,
        replayed: false,
        job: {
          status: "queued",
          provisioning: {
            state: "cleanup_pending",
            previousJournalDigest: "9".repeat(64)
          },
          provisioningRuntime: {
            intent: {
              intentId,
              providerSpawnIntentId: intentId,
              status: "registered",
              resolution: null
            },
            cleanupProof: {
              processIdentity,
              processGroupGone: true,
              providerGuardAbsent: true
            }
          }
        }
      })
    },
    preparedLaunch: { intent: { intentId } },
    worktreeProvisioning: true,
    resolution: "cleanup-proven",
    processIdentity,
    expectedJournalDigest: "9".repeat(64)
  });
  assert.equal(retained.retained, true);

  await assert.rejects(
    () => recordBoundBootstrapNoChild({
      providerLaunch: {
        noChild: async () => ({
          settled: true,
          replayed: false,
          job: {
            status: "failed",
            provisioning: { state: "failed" },
            provisioningRuntime: {
              intent: {
                intentId,
                providerSpawnIntentId: intentId,
                status: "no-child",
                resolution: "cleanup-proven"
              },
              cleanupProof: null
            }
          }
        })
      },
      preparedLaunch: { intent: { intentId } },
      worktreeProvisioning: true,
      resolution: "cleanup-proven",
      processIdentity,
      expectedJournalDigest: "9".repeat(64)
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
});

test("registration failure retains the prepared intent without calling planned noChild with process proof", async () => {
  let noChildCalls = 0;
  const outcome = await settleWorktreeBootstrapRegistrationFailure({
    providerLaunch: {
      noChild() {
        noChildCalls += 1;
      }
    },
    preparedLaunch: {
      intent: {
        intentId: "a".repeat(32),
        expectedPlannedJournalDigest: "b".repeat(64)
      }
    },
    processIdentity: {
      pid: 1234,
      startToken: "registration-failure-token",
      processGroupId: 1234
    },
    cleanupProof: {
      processIdentity: {
        pid: 1234,
        startToken: "registration-failure-token",
        processGroupId: 1234
      },
      processGroupGone: true,
      providerGuardAbsent: true,
      observedAt: new Date().toISOString()
    }
  });
  assert.deepEqual(outcome, {
    reconciled: false,
    retainedPreparedIntent: true
  });
  assert.equal(noChildCalls, 0);
});

test("actual worktree provisioning bootstrap registers the exact fenced process before ready", {
  skip: process.platform === "win32"
}, async (t) => {
  const root = initRepo();
  const controllerCwd = tempDir("provider-bootstrap-controller-cwd-");
  const providerCwdEvidence = path.join(
    tempDir("provider-bootstrap-controller-evidence-"),
    "cwd.txt"
  );
  const pluginData = tempDir("provider-bootstrap-worktree-provisioning-data-");
  const bootstrapWrapperDirectory = tempDir(
    "provider-bootstrap-worktree-wrapper-"
  );
  const bootstrapWrapper = path.join(
    bootstrapWrapperDirectory,
    "provider-bootstrap.mjs"
  );
  fs.writeFileSync(bootstrapWrapper, [
    "import fs from \"node:fs\";",
    `import { runProviderBootstrap } from ${JSON.stringify(
      pathToFileURL(BOOTSTRAP).href
    )};`,
    `const executableIdentity = ${JSON.stringify(TEST_EXECUTABLE_IDENTITY)};`,
    "const privateIdentity = {",
    "  canonicalPath: process.execPath,",
    "  device: \"1\",",
    "  inode: \"2\",",
    "  mode: 33261,",
    "  size: 4096,",
    "  mtimeMs: 1,",
    "  executableDigest: \"1\".repeat(64),",
    "  attestation: executableIdentity",
    "};",
    "try {",
    "  const controlInput = fs.createReadStream(null, { fd: 4, autoClose: false });",
    "  const specInput = fs.createReadStream(null, { fd: 6, autoClose: true });",
    "  const outcome = await runProviderBootstrap({",
    "    controlInput,",
    "    specInput,",
    "    captureExecutableIdentity: () => privateIdentity,",
    "    attestExecutable: () => executableIdentity",
    "  });",
    "  process.exitCode = outcome?.code ?? 0;",
    "} catch (error) {",
    "  process.stderr.write(`${error?.code || \"E_STATE\"}: ${error?.message || error}\\n`);",
    "  process.exitCode = 1;",
    "}",
    ""
  ].join("\n"));
  const env = ownerEnvironment(pluginData);
  const principal = { hostKind: "codex", threadId: THREAD_ID };
  const control = resolveControlWorkspace(root, env);
  const admitted = admitWriteWorkerPlan({
    root,
    principal,
    envelope: buildTaskEnvelope({
      userRequest: "Exercise the exact worktree provisioning bootstrap",
      mode: "write",
      scope: { include: ["tracked.txt"], exclude: [] }
    }),
    idempotencyKey: "provider-bootstrap-canonical-worktree-provisioning-0001",
    roleId: "implementer",
    allowWriteSpawn: true,
    writeLifecycleCapabilityDigest: "4".repeat(64),
    env
  });
  const marker = admitted.handle.id;
  const planned = tryReadJob(root, marker, env);
  const actor = {
    attemptId: "5".repeat(32),
    fence: 1,
    holderId: "6".repeat(32),
    executableIdentity: TEST_EXECUTABLE_IDENTITY
  };
  const prepared = prepareWriteProvisionerIntent({
    root,
    principal,
    workerId: marker,
    executionBindingDigest: planned.executionBinding.bindingDigest,
    expectedJournalDigest: planned.provisioning.journalDigest,
    ...actor,
    env
  });
  const expectedExecutionRoot = planned.executionBinding.expectedExecutionRoot;
  const binding = {
    purpose: "worktree-provisioning",
    controlWorkspaceId: control.controlWorkspaceId,
    controlRoot: control.controlRoot,
    expectedExecutionRoot,
    executionBindingDigest: planned.executionBinding.bindingDigest,
    provisioningAttemptId: actor.attemptId,
    provisioningFence: actor.fence,
    holderId: actor.holderId,
    providerSpawnIntentId: prepared.intent.providerSpawnIntentId
  };
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
    fs.rmSync(expectedExecutionRoot, { recursive: true, force: true });
    fs.rmSync(controllerCwd, { recursive: true, force: true });
    fs.rmSync(path.dirname(providerCwdEvidence), { recursive: true, force: true });
    fs.rmSync(bootstrapWrapperDirectory, { recursive: true, force: true });
  });

  const providerSource = `require("node:fs").writeFileSync(${JSON.stringify(providerCwdEvidence)}, process.cwd()); process.stdin.resume(); setInterval(() => {}, 1000);`;
  const launch = createProviderBootstrapLaunch({
    root: controllerCwd,
    marker,
    owner: THREAD_ID,
    binding,
    binary: process.execPath,
    executableIdentity: TEST_EXECUTABLE_IDENTITY,
    args: ["-e", providerSource, marker, "agent", "stdio"]
  });
  const child = spawn(process.execPath, [
    bootstrapWrapper,
    ...launch.argv.slice(1)
  ], {
    cwd: controllerCwd,
    env: {
      ...env,
      GROK_COMPANION_JOB_MARKER: marker,
      GROK_COMPANION_BOOTSTRAP_PLUGIN_DATA: pluginData
    },
    detached: true,
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"]
  });
  t.after(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  });
  const bootstrapStartToken = await waitFor(() => processStartToken(child.pid));
  const provisioningAt = new Date(
    Math.max(Date.now(), Date.parse(prepared.intent.preparedAt) + 1)
  ).toISOString();
  const activated = activateWriteProvisioningAttempt({
    root,
    principal,
    workerId: marker,
    executionBindingDigest: planned.executionBinding.bindingDigest,
    expectedJournalDigest: planned.provisioning.journalDigest,
    ...actor,
    providerSpawnIntentId: prepared.intent.providerSpawnIntentId,
    processIdentity: {
      pid: child.pid,
      startToken: bootstrapStartToken,
      processGroupId: child.pid
    },
    provisioningAt,
    leaseExpiresAt: new Date(Date.parse(provisioningAt) + 60_000).toISOString(),
    env
  });
  assert.equal(activated.job.phase, "worktree-provisioning");
  assert.equal(Object.hasOwn(activated.job.request.spawn, "dispatch"), false);

  await publishProviderBootstrapSpec(child, launch.specPayload);
  const ready = await readiness(child);
  assert.equal(ready.type, "provider-ready", JSON.stringify(ready));
  assert.equal(
    assertProviderBootstrapReadyMessage(
      ready,
      binding,
      TEST_EXECUTABLE_IDENTITY
    ),
    ready
  );
  assert.equal(await waitFor(() => {
    try { return fs.readFileSync(providerCwdEvidence, "utf8"); }
    catch { return null; }
  }), fs.realpathSync(controllerCwd));
  const guard = loadProviderGuard(root, marker);
  assert.equal(guard.schemaVersion, 5);
  assert.equal(guard.providerProcess.pid, child.pid);
  assert.equal(guard.providerProcess.startToken, bootstrapStartToken);
  assert.equal(tryReadJob(root, marker, env).provisioningRuntime.intent.status, "registered");
  assert.equal(fs.existsSync(expectedExecutionRoot), false);

  const acknowledgement = await promoteProviderBootstrap(
    child,
    { marker, ...binding }
  );
  assert.equal(
    assertProviderBootstrapPromotionMessage(
      acknowledgement,
      { marker, ...binding }
    ),
    acknowledgement
  );
  const closed = waitForClose(child);
  child.stdin.end();
  await closed;
  assert.equal(loadProviderGuard(root, marker), null);
  assert.equal(fs.existsSync(expectedExecutionRoot), false);
});

test("private bootstrap spec channel rejects missing, truncated, extra, malformed, and oversized input", async () => {
  const expected = {
    marker: "task-aabbccddeeff0011",
    generation: 1,
    intentId: "d".repeat(32)
  };
  const spec = {
    schemaVersion: 1,
    root: "/private/exact-bootstrap-root",
    marker: expected.marker,
    owner: THREAD_ID,
    binding: {
      controlWorkspaceId: `cws-${"e".repeat(32)}`,
      executionRoot: "/private/exact-bootstrap-root",
      dispatchAttemptId: "f".repeat(32),
      dispatchFence: 1,
      providerGeneration: expected.generation,
      providerSpawnIntentId: expected.intentId
    },
    binary: "/private/exact-provider-binary",
    args: ["agent", "stdio"]
  };
  const payload = `${JSON.stringify(spec)}\n`;
  const executionBindingDigest = "1".repeat(64);
  const writeSpec = {
    ...spec,
    binding: {
      ...spec.binding,
      executionBindingDigest
    }
  };
  const parsedWrite = await readProviderBootstrapSpec(
    Readable.from([`${JSON.stringify(writeSpec)}\n`]),
    expected
  );
  assert.equal(parsedWrite.binding.executionBindingDigest, executionBindingDigest);
  await assert.rejects(
    () => readProviderBootstrapSpec(null, expected),
    (error) => error?.code === "E_PROTOCOL" && /unavailable/.test(error.message)
  );
  for (const invalid of [
    payload.slice(0, -1),
    `${payload}extra`,
    "{malformed}\n",
    `${JSON.stringify({ ...spec, unexpected: true })}\n`,
    `${JSON.stringify({ ...spec, args: ["x".repeat(8 * 1024 + 1)] })}\n`,
    `${JSON.stringify({
      ...writeSpec,
      binding: {
        ...writeSpec.binding,
        executionBindingDigest: "not-a-digest"
      }
    })}\n`,
    `${JSON.stringify({
      ...writeSpec,
      binding: {
        ...writeSpec.binding,
        unexpected: true
      }
    })}\n`
  ]) {
    await assert.rejects(
      () => readProviderBootstrapSpec(Readable.from([invalid]), expected),
      (error) => ["E_PROTOCOL", "E_USAGE"].includes(error?.code)
    );
  }
  await assert.rejects(
    () => readProviderBootstrapSpec(Readable.from([Buffer.alloc(64 * 1024 + 1, 0x61)]), expected),
    (error) => error?.code === "E_PROTOCOL" && /exceeded/.test(error.message)
  );
});

/**
 * Parent-side spec channel that queues one coded error from end().
 * Uses a minimal EventEmitter surface (not Node Writable) so publisher error
 * mapping is deterministic across platforms and does not depend on stream
 * teardown ordering (close/finish/destroyed races on Node 22 vs 18).
 * destroy() is inert state-only; production still maps the queued error to
 * E_PROVIDER_EXIT before any teardown timing matters.
 */
function publisherTargetWithCodedChannelError() {
  const channel = new EventEmitter();
  channel.destroyed = false;
  channel.closed = false;
  channel.writableEnded = false;
  channel.writableFinished = false;
  channel.end = function end(_payload) {
    queueMicrotask(() => {
      if (channel.destroyed) return;
      const error = new Error("write EPIPE");
      error.code = "EPIPE";
      channel.emit("error", error);
    });
  };
  channel.destroy = function destroy() {
    channel.destroyed = true;
  };
  return {
    stdio: { 6: channel },
    exitCode: null,
    signalCode: null,
    once() {},
    off() {},
    on() {}
  };
}

test("bootstrap process fails closed when the inherited fd6 spec pipe ends with zero bytes", {
  skip: process.platform === "win32"
}, async (t) => {
  // Production-shaped proof: inherit a real pipe on fd6, then parent-end it
  // with zero payload. stdio "ignore" is not a portable missing/non-pipe proof
  // on all Node 22 hosts; empty-pipe EOF is the real bootstrap contract.
  const marker = "task-aabbccddeeff0011";
  const intentId = "a".repeat(32);
  const child = spawn(process.execPath, [
    BOOTSTRAP,
    "--job-marker", marker,
    "--provider-generation", "1",
    "--spawn-intent-id", intentId
  ], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "pipe", "ignore", "ignore", "pipe"]
  });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} });
  let unexpectedReadiness = "";
  child.stdio[3].on("data", (chunk) => { unexpectedReadiness += String(chunk); });

  const specPipe = child.stdio[6];
  assert.ok(specPipe && typeof specPipe.end === "function", "fd6 must be a real parent-side pipe");
  // Install error handling before ending so parent-side EPIPE cannot become
  // an unhandled 'error' if the child closes its end during teardown.
  let parentPipeError = null;
  specPipe.on("error", (error) => {
    parentPipeError = error;
  });
  // Zero-byte EOF: end without writing any specification payload.
  specPipe.end();

  const exit = await waitForClose(child);
  assert.equal(exit.code, 1);
  assert.equal(exit.signal, null);
  assert.equal(unexpectedReadiness, "");
  // Accept only EPIPE if the writer closed exceptionally; any other code is a
  // real parent-side failure that must not be swallowed.
  if (parentPipeError != null) {
    assert.equal(parentPipeError.code, "EPIPE");
  }
});

test("parent publisher rejects when the bootstrap specification channel is absent", async () => {
  await assert.rejects(
    () => publishProviderBootstrapSpec({ stdio: [] }, "{}\n"),
    (error) => error?.code === "E_PROTOCOL"
  );
});

test("parent publisher maps a coded channel error to E_PROVIDER_EXIT without Writable teardown timing", async () => {
  const target = publisherTargetWithCodedChannelError();
  await assert.rejects(
    () => publishProviderBootstrapSpec(target, "{}\n", { timeoutMs: 1_000 }),
    (error) => error?.code === "E_PROVIDER_EXIT"
  );
});

test("promotion handshake fails closed when the bootstrap closes its control pipes", {
  skip: process.platform === "win32"
}, async (t) => {
  const source = [
    "const fs = require('node:fs');",
    "fs.closeSync(4);",
    "fs.closeSync(5);",
    "fs.writeSync(3, 'ready\\n');",
    "setInterval(() => {}, 1000);"
  ].join(" ");
  const child = spawn(process.execPath, ["-e", source], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe", "pipe"]
  });
  t.after(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  });
  await new Promise((resolve, reject) => {
    child.stdio[3].once("data", resolve);
    child.once("error", reject);
    child.once("exit", () => reject(new Error("control-race fixture exited before readiness")));
  });
  await assert.rejects(
    () => promoteProviderBootstrap(child, {
      marker: "task-aabbccddeeff0011",
      providerGeneration: 1,
      providerSpawnIntentId: "a".repeat(32)
    }, { timeoutMs: 1_000 }),
    (error) => ["E_PROVIDER_EXIT", "E_PROCESS_IDENTITY"].includes(error?.code)
  );
  const closed = waitForClose(child);
  process.kill(-child.pid, "SIGKILL");
  await closed;
});

test("recovery revokes a committed provider intent before a late bootstrap can register", {
  skip: process.platform === "win32"
}, async (t) => {
  const fixture = await workerStartedFixture(t, "late-registration");
  const prepared = prepareWorkerProviderSpawn({
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    fence: fixture.claim.fence,
    providerGeneration: 1,
    env: fixture.env
  });
  const recovery = await reconcileBrokerWorkers({
    root: fixture.root,
    principal: fixture.principal,
    dispatchStartupGraceMs: 0,
    env: fixture.env
  });
  assert.equal(recovery.results[0].action, "marked-lost");
  const settled = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  assert.equal(settled.request.spawn.providerSpawnIntent.status, "no-child");
  assert.equal(settled.request.spawn.providerSpawnIntent.resolution, "authorization-revoked");
  assert.equal(settled.result.runtimeEvidence.reconciler.replayedPrompt, false);
  assert.equal(loadProviderGuard(fixture.root, fixture.workerId), null);

  const binding = {
    controlWorkspaceId: settled.controlWorkspaceId,
    executionRoot: settled.request.spawn.executionRoot,
    dispatchAttemptId: fixture.claim.attemptId,
    dispatchFence: fixture.claim.fence,
    providerGeneration: 1,
    providerSpawnIntentId: prepared.intent.intentId
  };
  assert.throws(
    () => registerProviderGuard(
      fixture.root,
      fixture.workerId,
      { pid: 9_700_001, startToken: "late-bootstrap", processGroupId: 9_700_001 },
      THREAD_ID,
      "provider",
      binding,
      fixture.env
    ),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  assert.equal(loadProviderGuard(fixture.root, fixture.workerId), null);
});

test("failed bootstrap cleanup preserves an exact concurrent guard winner", {
  skip: process.platform === "win32"
}, async (t) => {
  const fixture = await workerStartedFixture(t, "cleanup-winner");
  const prepared = prepareWorkerProviderSpawn({
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    fence: fixture.claim.fence,
    providerGeneration: 1,
    env: fixture.env
  });
  const binding = bootstrapBinding(fixture, prepared.intent);
  const winner = spawnIdle(t);
  const winnerIdentity = await providerIdentityFor(winner);
  const winnerGuard = registerProviderGuard(
    fixture.root,
    fixture.workerId,
    winnerIdentity,
    THREAD_ID,
    "provider",
    binding,
    fixture.env
  );
  const loser = spawnIdle(t);
  const loserIdentity = await providerIdentityFor(loser);
  let profileCleaned = false;
  await assert.rejects(
    () => cleanupBoundBootstrapStart({
      child: loser,
      identity: loserIdentity,
      root: fixture.root,
      marker: fixture.workerId,
      stagedProfile: { cleanup: () => { profileCleaned = true; } },
      guardBinding: binding,
      env: fixture.env
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  assert.equal(await waitFor(() => processGroupGone(loserIdentity)), true);
  assert.deepEqual(loadProviderGuard(fixture.root, fixture.workerId), winnerGuard);
  assert.equal(processGroupGone(winnerIdentity), false);
  assert.equal(profileCleaned, false, "ambiguous ownership must retain the staged profile");

  unregisterProviderGuard(fixture.root, fixture.workerId, winnerGuard, fixture.env);
  await killAndWait(winner, winnerIdentity);
});

test("write bootstrap retains its execution binding through spec, guard, readiness, promotion, and cleanup", {
  skip: process.platform === "win32"
}, async (t) => {
  const fixture = await workerStartedFixture(t, "write-binding");
  const prepared = prepareWorkerProviderSpawn({
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    fence: fixture.claim.fence,
    providerGeneration: 1,
    env: fixture.env
  });
  const executionBindingDigest = "2".repeat(64);
  updateJob(fixture.root, fixture.workerId, (job) => ({
    ...job,
    write: true,
    executionBinding: { bindingDigest: executionBindingDigest },
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        executionBindingDigest
      }
    }
  }), fixture.env);

  const providerSource = [
    "process.stdin.resume();",
    "setInterval(() => {}, 1000);"
  ].join(" ");
  const launch = bootstrapLaunch(fixture, prepared.intent, [
    "-e", providerSource, fixture.workerId, "agent", "stdio"
  ]);
  const privateSpec = JSON.parse(launch.specPayload);
  assert.equal(privateSpec.binding.executionBindingDigest, executionBindingDigest);

  const child = spawn(
    process.execPath,
    launch.argv,
    {
      cwd: fixture.root,
      env: {
        ...fixture.env,
        GROK_COMPANION_JOB_MARKER: fixture.workerId,
        GROK_COMPANION_BOOTSTRAP_PLUGIN_DATA: fixture.pluginData
      },
      detached: true,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"]
    }
  );
  t.after(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  });
  await publishProviderBootstrapSpec(child, launch.specPayload);
  const ready = await readiness(child);
  assert.equal(ready.type, "provider-ready");
  assert.equal(ready.executionBindingDigest, executionBindingDigest);

  const guard = loadProviderGuard(fixture.root, fixture.workerId);
  assert.equal(guard.schemaVersion, 4);
  assert.equal(guard.executionBindingDigest, executionBindingDigest);
  const binding = bootstrapBinding(fixture, prepared.intent);
  const acknowledgement = await promoteProviderBootstrap(child, {
    marker: fixture.workerId,
    providerGeneration: binding.providerGeneration,
    providerSpawnIntentId: binding.providerSpawnIntentId,
    executionBindingDigest
  });
  assert.equal(acknowledgement.type, "provider-promoted");
  assert.equal(acknowledgement.executionBindingDigest, executionBindingDigest);

  const closed = waitForClose(child);
  child.stdin.end();
  await closed;
  assert.equal(loadProviderGuard(fixture.root, fixture.workerId), null);
});

test("post-guard version failure kills the whole owned group and retains exact recovery evidence", {
  skip: process.platform === "win32"
}, async (t) => {
  const fixture = await workerStartedFixture(t, "version-descendant");
  const prepared = prepareWorkerProviderSpawn({
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    fence: fixture.claim.fence,
    providerGeneration: 1,
    env: fixture.env
  });
  const binaryDirectory = tempDir("provider-version-descendant-");
  const binary = path.join(binaryDirectory, "grok-version-fixture.mjs");
  const resistantSource = [
    "process.on('SIGTERM', () => {});",
    "process.stdout.write('ready\\n');",
    "setInterval(() => {}, 1000);"
  ].join(" ");
  fs.writeFileSync(binary, [
    `#!${process.execPath}`,
    "import process from 'node:process';",
    "import { spawn } from 'node:child_process';",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(resistantSource)}], { detached: false, stdio: ['ignore', 'pipe', 'ignore'] });`,
    "child.stdout.once('data', () => { child.stdout.destroy(); child.unref(); process.exit(23); });"
  ].join("\n"), { mode: 0o700 });
  t.after(() => fs.rmSync(binaryDirectory, { recursive: true, force: true }));

  const launch = bootstrapLaunch(fixture, prepared.intent, [], { binary });
  const child = spawn(
    process.execPath,
    launch.argv,
    {
      cwd: fixture.root,
      env: {
        ...fixture.env,
        GROK_COMPANION_JOB_MARKER: fixture.workerId,
        GROK_COMPANION_BOOTSTRAP_PLUGIN_DATA: fixture.pluginData
      },
      detached: true,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"]
    }
  );
  t.after(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  });
  await publishProviderBootstrapSpec(child, launch.specPayload);
  await waitForClose(child);
  const guard = loadProviderGuard(fixture.root, fixture.workerId);
  assert.equal(guard?.schemaVersion, 3);
  assert.equal(Object.hasOwn(guard, "executionBindingDigest"), false);
  assert.equal(guard?.providerSpawnIntentId, prepared.intent.intentId);
  assert.equal(await waitFor(() => processGroupGone(guard.providerProcess)), true);
  unregisterProviderGuard(fixture.root, fixture.workerId, guard, fixture.env);
});

test("an actual bootstrap guard wins recovery, is promoted exactly, and receives no ACP before promotion", {
  skip: process.platform === "win32"
}, async (t) => {
  const fixture = await workerStartedFixture(t, "guard-wins");
  const prepared = prepareWorkerProviderSpawn({
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    fence: fixture.claim.fence,
    providerGeneration: 1,
    env: fixture.env
  });
  const stdinEvidence = path.join(tempDir("provider-bootstrap-stdin-"), "stdin.log");
  t.after(() => fs.rmSync(path.dirname(stdinEvidence), { recursive: true, force: true }));
  const providerSource = [
    "const fs = require('node:fs');",
    `process.stdin.on('data', chunk => fs.appendFileSync(${JSON.stringify(stdinEvidence)}, chunk));`,
    "setInterval(() => {}, 1000);"
  ].join(" ");
  const launch = bootstrapLaunch(fixture, prepared.intent, [
    "-e", providerSource, fixture.workerId, "agent", "stdio"
  ]);
  const child = spawn(
    process.execPath,
    launch.argv,
    {
      cwd: fixture.root,
      env: {
        ...fixture.env,
        GROK_COMPANION_JOB_MARKER: fixture.workerId,
        GROK_COMPANION_BOOTSTRAP_PLUGIN_DATA: fixture.pluginData
      },
      detached: true,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"]
    }
  );
  t.after(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  });
  await publishProviderBootstrapSpec(child, launch.specPayload);
  const ready = await readiness(child);
  assert.equal(ready.type, "provider-ready");
  assert.equal(Object.hasOwn(ready, "executionBindingDigest"), false);
  const guard = loadProviderGuard(fixture.root, fixture.workerId);
  assert.equal(guard.schemaVersion, 3);
  assert.equal(Object.hasOwn(guard, "executionBindingDigest"), false);
  assert.equal(guard.providerSpawnIntentId, prepared.intent.intentId);
  assert.equal(guard.providerProcess.pid, child.pid);
  assert.equal(fs.existsSync(stdinEvidence), false, "bootstrap forwarded bytes before dispatch promotion");

  const recovery = await reconcileBrokerWorkers({
    root: fixture.root,
    principal: fixture.principal,
    dispatchStartupGraceMs: 0,
    env: fixture.env
  });
  assert.equal(recovery.results[0].action, "marked-lost");
  assert.equal(recovery.replayedPrompt, false);
  const settled = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  assert.equal(settled.request.spawn.dispatch.providerGeneration, 1);
  assert.equal(settled.request.spawn.providerSpawnIntent.status, "registered");
  assert.equal(settled.providerProcess.pid, child.pid);
  assert.equal(settled.result.runtimeEvidence.reconciler.replayedPrompt, false);
  await waitFor(() => processGroupGone(guard.providerProcess));
  assert.equal(loadProviderGuard(fixture.root, fixture.workerId), null);
  assert.equal(fs.existsSync(stdinEvidence), false, "recovery sent ACP bytes while cleaning the unpromoted bootstrap");
  assertDispatchContract(settled);
});

test("bootstrap shutdown escalates a TERM-resistant Grok child and acknowledges promotion before ACP", {
  skip: process.platform === "win32"
}, async (t) => {
  const fixture = await workerStartedFixture(t, "term-resistant");
  const prepared = prepareWorkerProviderSpawn({
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.claim.attemptId,
    fence: fixture.claim.fence,
    providerGeneration: 1,
    env: fixture.env
  });
  const binding = bootstrapBinding(fixture, prepared.intent);
  const providerSource = [
    "process.on('SIGTERM', () => {});",
    "process.stdout.write('term-handler-ready\\n');",
    "process.stdin.resume();",
    "setInterval(() => {}, 1000);"
  ].join(" ");
  const launch = bootstrapLaunch(fixture, prepared.intent, [
    "-e", providerSource, fixture.workerId, "agent", "stdio"
  ]);
  const child = spawn(
    process.execPath,
    launch.argv,
    {
      cwd: fixture.root,
      env: {
        ...fixture.env,
        GROK_COMPANION_JOB_MARKER: fixture.workerId,
        GROK_COMPANION_BOOTSTRAP_PLUGIN_DATA: fixture.pluginData
      },
      detached: true,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"]
    }
  );
  t.after(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  });
  await publishProviderBootstrapSpec(child, launch.specPayload);
  const providerHandlerReady = new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("error", reject);
    child.once("exit", () => reject(new Error("bootstrap exited before provider signal handler was ready")));
  });
  const ready = await readiness(child);
  assert.equal(ready.type, "provider-ready");
  await providerHandlerReady;
  const acknowledgement = await promoteProviderBootstrap(child, {
    marker: fixture.workerId,
    providerGeneration: binding.providerGeneration,
    providerSpawnIntentId: binding.providerSpawnIntentId
  });
  assert.equal(acknowledgement.type, "provider-promoted");
  assert.equal(Object.hasOwn(acknowledgement, "executionBindingDigest"), false);

  const closed = waitForClose(child);
  child.stdin.end();
  await closed;
  const guard = loadProviderGuard(fixture.root, fixture.workerId);
  assert.equal(await waitFor(() => processGroupGone({
    pid: child.pid,
    startToken: null,
    processGroupId: child.pid
  })), true);
  assert.equal(guard?.schemaVersion, 3);
  assert.equal(guard?.providerSpawnIntentId, prepared.intent.intentId);
  unregisterProviderGuard(fixture.root, fixture.workerId, guard, fixture.env);
});
