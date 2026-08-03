#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  validateInstalledCancellationReplayScenario,
  validateInstalledScenarioEvidence,
  validateInstalledSetup,
  validateProviderCapabilityAgreement
} from "./lib/installed-worker-mcp-contract.mjs";
import {
  classifyInstalledWorkerMcpCleanupOutcome,
  formatInstalledWorkerMcpFailure,
  selectInstalledWorkerMcpFailure
} from "./lib/installed-worker-mcp-failure.mjs";
import { setupCleanupRequiresObservation } from "./lib/installed-worker-mcp-setup-boundary.mjs";
import {
  canonicalPath,
  createPluginInventory,
  describeInventoryDifference,
  digestInventory,
  digestRegularFile,
  isPathInside
} from "./lib/plugin-inventory.mjs";
import { ACTIVE_WINDOW_WORKLOAD_FILES, CANONICAL_UUID, EXPECTED_EXPERIMENTAL_CAPABILITIES, HELP, LIVE_GATES, MAX_COMMAND_OUTPUT_BYTES, MAX_RECEIPT_BYTES, MAX_TERMINAL_LIFECYCLE_EVENTS, PLUGIN_ID, PROTOCOL_VERSION, QUALIFICATION_STAGES, QualificationError, ROOT, SCENARIO_TIMEOUT_MS, SOURCE_PLUGIN, STATE_POLL_MS, TWO_WRITER_HELP, TWO_WRITER_TOOLS, WRITE_SMOKE_HELP, canonicalDigest, canonicalJson, checkInterrupted, enterQualificationStage, fail, hasExactKeys, isPlainRecord, qualificationStage, runBounded, runJson, safeParseJson, sameJson } from "./lib/installed-worker-mcp-runner-core.mjs";
import { buildChildEnvironment, callTool, callWriteSmokeResult, callWriteSmokeWait, captureProviderFileIdentity, closeMcp, createMetadata, importInstalled, initializeFixtureRepository, mkdirPrivate, poisonChildProviderDiscovery, privateLiveFixtureBase, recheckProviderExecutablePin, startInstalledMcp, verifyMcpSurface } from "./lib/installed-worker-mcp-runner-runtime.mjs";
import { cleanupSetupBoundary, createSetupBoundary, runSetupJson } from "./lib/installed-worker-mcp-runner-setup.mjs";
import { assertProviderPinPersistence, assertPublicPrivateBinding, assertTerminalEventHistory, createTracker, drainTerminalEventStream, observePrivateJob, observePublicWorker, observeTerminalResultWorker, pollPrivateJob, readPrivateJob, recordPrivateIdentityObservation, validateTerminalWorkerSnapshot, validateWriteSpawnResponseWitness, waitForTerminal } from "./lib/installed-worker-mcp-runner-observation.mjs";
import { beginScenario, bindSessionBoundary, deleteAndProveSessionAbsent, exactPrivateAuthFile, proveSessionAbsentWithCredential, proveTerminalCleanup, refreshSessionCredentialHandle, runCompletionScenario, runSessionCredentialTransaction, waitForSessionPresence } from "./lib/installed-worker-mcp-runner-session-read.mjs";
import {
  LIVE_RECEIPT_AUTHORITY_CONFIG,
  LIVE_RECEIPT_AUTHORITY_SYNTHETIC,
  LIVE_RECEIPT_CAPABILITY_TOOL_IDS,
  LIVE_RECEIPT_MANIFEST,
  LIVE_RECEIPT_PROVIDER_CAPABILITIES,
  LIVE_RECEIPT_PRODUCER_ID,
  LIVE_RECEIPT_PRODUCER_VERSION,
  LIVE_RECEIPT_ROOT,
  LIVE_RECEIPT_SCHEMA_VERSION,
  computeInventoryDigest,
  computeLiveQualificationReceiptDigest,
  computeLiveReceiptManifestDigest,
  computePhaseScopeDigest,
  gitIdentity,
  isNonEvidenceTreeClean,
  validateLiveQualificationReceipt
} from "./lib/worker-broker-evidence.mjs";

function observeActiveWriteProvider(
  context,
  workerId,
  parentBefore
) {
  const job = context.state.readJob(
    context.fixtureRoot,
    workerId,
    context.env
  );
  try {
    context.mutation.assertDispatchContract(job);
  } catch {
    fail("E_PRIVATE_STATE");
  }
  const dispatch = job.request?.spawn?.dispatch;
  const expectedExecutionRoot =
    context.workerWorktree.expectedWorkerWorktreeRoot(
      context.fixtureRoot,
      workerId,
      context.env
    );
  if (
    job.id !== workerId
    || job.write !== true
    || !["queued", "running"].includes(job.status)
    || job.role?.id !== "implementer"
    || job.profile?.id !== "rescue-write-v3"
    || job.host?.kind !== "codex"
    || job.host?.sessionId !== context.threadId
    || job.request?.spawn?.ownerThreadId !== context.threadId
    || job.provisioning?.state !== "ready"
    || job.request?.spawn?.providerLaunchOutcome !== "launched"
    || dispatch?.state !== "provider-started"
    || dispatch.providerGeneration !== 1
    || dispatch.nextProviderGeneration !== null
    || job.providerProcess?.providerGeneration !== 1
    || !CANONICAL_UUID.test(job.grokSessionId || "")
    || !CANONICAL_UUID.test(
      job.provisioningRuntime?.intent?.operationId || ""
    )
    || job.executionBinding?.expectedExecutionRoot !== expectedExecutionRoot
    || job.request?.spawn?.executionRoot !== expectedExecutionRoot
    || job.request?.spawn?.executionBindingDigest
      !== job.executionBinding?.bindingDigest
    || !sameJson(job.request?.envelope?.scope, {
      include: ["target.txt"],
      exclude: []
    })
  ) {
    fail("E_PRIVATE_STATE");
  }
  const processIdentities = {
    controller: job.controllerProcess,
    worker: job.workerProcess,
    provider: job.providerProcess
  };
  for (const [kind, identity] of Object.entries(processIdentities)) {
    try {
      context.processControl.assertCompleteDetachedOwnedIdentity(identity);
    } catch {
      fail("E_PRIVATE_STATE");
    }
    if (
      identity.commandMarker !== workerId
      || identity.processGroupId !== identity.pid
      || identity.dispatchAttemptId !== dispatch.attemptId
      || identity.dispatchFence !== dispatch.fence
      || (kind === "provider" && identity.providerGeneration !== 1)
      || (
        kind !== "controller"
        && context.processControl.processGroupGone(identity)
      )
    ) {
      fail("E_PRIVATE_STATE");
    }
  }
  let guard;
  try {
    guard = context.guard.loadProviderGuard(context.fixtureRoot, workerId);
    guard = context.guard.assertProviderGuardForJob(
      context.fixtureRoot,
      job,
      guard,
      { expectedGeneration: 1 }
    );
  } catch {
    fail("E_PRIVATE_STATE");
  }
  if (
    !guard
    || !context.guard.sameGuardProcessIdentity(
      guard.providerProcess,
      job.providerProcess
    )
  ) {
    fail("E_PRIVATE_STATE");
  }
  const managedIdentity =
    context.workerWorktree.assertRegisteredWorkerWorktreeIdentity({
      controlRoot: context.fixtureRoot,
      executionRoot: expectedExecutionRoot,
      baseCommit: parentBefore.head,
      workerId,
      env: context.env
    });
  const executionRootStat = fs.lstatSync(expectedExecutionRoot);
  if (
    !executionRootStat.isDirectory()
    || executionRootStat.isSymbolicLink()
  ) {
    fail("E_PRIVATE_STATE");
  }
  context.workerWorktree.assertParentUnchanged(
    parentBefore,
    context.fixtureRoot
  );
  if (
    fs.readFileSync(
      path.join(context.fixtureRoot, "target.txt"),
      "utf8"
    ) !== "before\n"
  ) {
    fail("E_PRIVATE_STATE");
  }
  assertProviderPinPersistence(context, job, {
    guard,
    requireCurrentIntent: true,
    requirePrimaryTurnAdmissions: true,
    requireWorktreeIntent: true
  });
  return Object.freeze({
    job,
    guard,
    identity: Object.freeze({
      workerId,
      controlWorkspaceId: job.controlWorkspaceId,
      executionBindingDigest: job.executionBinding.bindingDigest,
      provisioningOperationId:
        job.provisioningRuntime.intent.operationId,
      providerSessionId: job.grokSessionId,
      dispatchAttemptId: dispatch.attemptId,
      dispatchFence: dispatch.fence,
      providerGeneration: dispatch.providerGeneration,
      controllerProcess: structuredClone(job.controllerProcess),
      workerProcess: structuredClone(job.workerProcess),
      providerProcess: structuredClone(job.providerProcess),
      providerSpawnIntentId:
        job.request?.spawn?.providerSpawnIntent?.intentId,
      managedWorktree: structuredClone(managedIdentity),
      executionRootDevice: executionRootStat.dev,
      executionRootInode: executionRootStat.ino
    })
  });
}

async function waitForActiveWriteProvider(
  context,
  workerId,
  parentBefore
) {
  const deadline = Date.now() + 120_000;
  while (Date.now() <= deadline) {
    checkInterrupted(context.runner);
    try {
      const job = context.state.tryReadJob(
        context.fixtureRoot,
        workerId,
        context.env
      );
      if (
        job
        && !["completed", "failed", "cancelled"].includes(job.status)
        && job.request?.spawn?.dispatch?.state === "provider-started"
        && job.providerProcess?.providerGeneration === 1
        && CANONICAL_UUID.test(job.grokSessionId || "")
      ) {
        return observeActiveWriteProvider(
          context,
          workerId,
          parentBefore
        );
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, STATE_POLL_MS));
  }
  fail("E_PRIVATE_STATE");
}

function twoWriterPrompt(label, exactLine) {
  return [
    "Edit only target.txt in the current isolated worktree.",
    "Before editing, use read-only workspace tools to inspect every numbered file under qualification-workload in ascending order.",
    `Account for all ${ACTIVE_WINDOW_WORKLOAD_FILES} markers before any edit.`,
    `Replace the complete contents of target.txt with exactly the single line: ${exactLine}`,
    "The file must end with one newline.",
    "You must perform the mutation with an actual workspace editing tool; a completion report without an observed file change is a failure.",
    `Read target.txt again and verify its complete contents are exactly ${exactLine} followed by one newline.`,
    "Do not commit and do not modify any other path.",
    "Return the required structured worker report.",
    `Use ${label} only as the task label; list only target.txt in changedFiles and mark AC-01 and AC-02 met only if the exact edit and one-file scope were verified.`
  ].join(" ");
}

function assertTwoWriterSpawn(spawned) {
  const workerId = spawned.worker?.id;
  if (
    typeof workerId !== "string"
    || spawned.worker?.write !== true
    || spawned.worker?.roleId !== "implementer"
    || spawned.replayed !== false
    || spawned.spawnSuccessDefinition !== "durable-job-commit"
    || spawned.providerLaunchState !== "not-ready"
    || spawned.providerLaunched !== false
  ) {
    fail("E_SCENARIO");
  }
  return workerId;
}

async function waitForConcurrentActiveWriteProviders(
  context,
  workerIds,
  parentBefore
) {
  const deadline = Date.now() + 120_000;
  while (Date.now() <= deadline) {
    checkInterrupted(context.runner);
    try {
      const jobs = workerIds.map((workerId) => context.state.tryReadJob(
        context.fixtureRoot,
        workerId,
        context.env
      ));
      const bothDispatching = jobs.every((job, index) => (
        job?.id === workerIds[index]
        && !["completed", "failed", "cancelled"].includes(job.status)
        && job.request?.spawn?.dispatch?.state === "provider-started"
        && job.providerProcess?.providerGeneration === 1
        && CANONICAL_UUID.test(job.grokSessionId || "")
      ));
      if (bothDispatching) {
        const observations = workerIds.map((workerId) => (
          observeActiveWriteProvider(context, workerId, parentBefore)
        ));
        const providerProcesses = observations.map(
          ({ identity }) => identity.providerProcess
        );
        const allProvidersLive = providerProcesses.every((identity) => (
          !context.processControl.processGroupGone(identity)
        ));
        const roots = observations.map(
          ({ job }) => job.executionBinding.expectedExecutionRoot
        );
        const rootDigests = observations.map(
          ({ job }) => job.executionBinding.expectedExecutionRootDigest
        );
        const processKeys = providerProcesses.map(
          (identity) => `${identity.pid}\0${identity.startToken}\0${identity.processGroupId}`
        );
        if (
          allProvidersLive
          && new Set(roots).size === workerIds.length
          && new Set(rootDigests).size === workerIds.length
          && new Set(processKeys).size === workerIds.length
        ) {
          const observedAt = new Date().toISOString();
          const projection = observations.map(({ job, identity }) => ({
            workerId: job.id,
            executionBindingDigest: job.executionBinding.bindingDigest,
            executionRootDigest: job.executionBinding.expectedExecutionRootDigest,
            providerGeneration: identity.providerGeneration,
            providerProcessDigest: canonicalDigest(identity.providerProcess)
          }));
          return Object.freeze({
            observedAt,
            observations,
            observationDigest: canonicalDigest({
              observedAt,
              projection
            })
          });
        }
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, STATE_POLL_MS));
  }
  fail("E_PRIVATE_STATE");
}

async function waitForWriteWorkerTerminal(
  context,
  client,
  workerId,
  initialCursor
) {
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS;
  let cursor = initialCursor;
  while (Date.now() < deadline) {
    const page = await callWriteSmokeWait(
      context,
      client,
      workerId,
      cursor,
      30_000
    );
    if (
      !isPlainRecord(page.stream)
      || typeof page.stream.terminal !== "boolean"
      || !isPlainRecord(page.stream.nextCursor)
      || page.stream.nextCursor.workerId !== workerId
    ) {
      fail("E_SCENARIO");
    }
    cursor = page.stream.nextCursor;
    if (page.stream.terminal) return cursor;
  }
  fail("E_SCENARIO");
}

async function readTwoWriterArtifact(
  context,
  client,
  workerId,
  parentBefore,
  expectedContent,
  result
) {
  const metadata = await callTool(
    context,
    client,
    "worker_artifact",
    { id: workerId, part: "metadata" },
    ["artifact"]
  );
  const content = await callTool(
    context,
    client,
    "worker_artifact",
    { id: workerId, part: "content" },
    ["artifact"]
  );
  const patch = await callTool(
    context,
    client,
    "worker_artifact",
    { id: workerId, part: "patch" },
    ["artifact"]
  );
  const expectedContentDigest = crypto
    .createHash("sha256")
    .update(expectedContent)
    .digest("hex");
  const addedLine = expectedContent.trimEnd();
  if (
    !sameJson(result.artifact, metadata.artifact)
    || metadata.artifact?.path !== "target.txt"
    || metadata.artifact?.baseCommit !== parentBefore.head
    || metadata.artifact?.contentDigest !== expectedContentDigest
    || content.artifact?.part !== "content"
    || content.artifact?.payload !== expectedContent
    || content.artifact?.payloadDigest !== expectedContentDigest
    || content.artifact?.payloadBytes !== Buffer.byteLength(expectedContent)
    || patch.artifact?.part !== "patch"
    || patch.artifact?.payloadDigest !== metadata.artifact.patchDigest
    || !patch.artifact?.payload.includes("diff --git a/target.txt b/target.txt")
    || !patch.artifact?.payload.includes("-before")
    || !patch.artifact?.payload.includes(`+${addedLine}`)
  ) {
    fail("E_SCENARIO");
  }
  return Object.freeze({ metadata, content, patch });
}

function inspectTwoWriterTerminal(
  context,
  workerId,
  parentBefore,
  expectedContent,
  artifact
) {
  const job = context.state.readJob(context.fixtureRoot, workerId, context.env);
  try { context.mutation.assertDispatchContract(job); }
  catch { fail("E_PRIVATE_STATE"); }
  assertProviderPinPersistence(context, job, {
    requireCurrentIntent: true,
    requirePrimaryTurnAdmissions: true,
    requireWorktreeIntent: true
  });
  const executionRoot = context.workerWorktree.expectedWorkerWorktreeRoot(
    context.fixtureRoot,
    workerId,
    context.env
  );
  context.workerWorktree.assertRegisteredWorkerWorktreeIdentity({
    controlRoot: context.fixtureRoot,
    executionRoot,
    baseCommit: parentBefore.head,
    workerId,
    env: context.env
  });
  const storedArtifact = context.workerWorktree.readWriteWorkerArtifact({
    controlRoot: context.fixtureRoot,
    workerId,
    env: context.env,
    expectedManifestDigest: artifact.metadata.artifact.manifestDigest
  });
  const admissions = Object.values(
    job.request?.spawn?.primaryTurnAdmissions || {}
  );
  if (
    job.status !== "completed"
    || job.write !== true
    || job.request?.spawn?.providerLaunchOutcome !== "launched"
    || job.result?.taskRuntimeCleaned !== true
    || job.result?.workerReport?.valid !== true
    || job.result?.workerReport?.reportSource !== "acp-structured"
    || job.result?.providerClaims?.success !== true
    || job.result?.providerClaims?.observedFileAgreement !== true
    || !sameJson(job.result?.providerClaims?.changedFiles, ["target.txt"])
    || job.executionBinding?.expectedExecutionRoot !== executionRoot
    || storedArtifact.content !== expectedContent
    || storedArtifact.patch !== artifact.patch.artifact.payload
    || fs.readFileSync(path.join(executionRoot, "target.txt"), "utf8")
      !== expectedContent
    || admissions.length < 1
  ) {
    fail("E_PRIVATE_STATE");
  }
  return Object.freeze({
    job,
    executionRoot,
    storedArtifact,
    retainedProviderIdentities: admissions.map(
      (admission) => structuredClone(admission.providerProcess)
    )
  });
}

async function callTwoWriterPreview(
  context,
  client,
  workerId,
  manifestDigest,
  expectedStatus
) {
  const value = await callTool(
    context,
    client,
    TWO_WRITER_TOOLS.preview,
    { id: workerId, manifestDigest },
    ["preview"]
  );
  const preview = value.preview;
  if (
    preview?.workerId !== workerId
    || preview?.manifestDigest !== manifestDigest
    || preview?.status !== expectedStatus
    || !/^[a-z][a-z0-9-]{0,63}$/.test(preview?.classification || "")
    || !/^[a-f0-9]{64}$/.test(preview?.observationDigest || "")
  ) {
    fail("E_SCENARIO");
  }
  return preview;
}

async function callTwoWriterVerify(
  context,
  client,
  workerId,
  manifestDigest,
  integrationReceiptDigest
) {
  const value = await callTool(
    context,
    client,
    TWO_WRITER_TOOLS.verify,
    { id: workerId, manifestDigest, integrationReceiptDigest },
    ["verification"]
  );
  const verification = value.verification;
  if (
    verification?.workerId !== workerId
    || verification?.status !== "verified"
    || verification?.manifestDigest !== manifestDigest
    || verification?.integrationReceiptDigest !== integrationReceiptDigest
    || !/^[a-f0-9]{64}$/.test(verification?.observationDigest || "")
  ) {
    fail("E_SCENARIO");
  }
  return verification;
}

async function callExpectedTwoWriterConflict(
  context,
  client,
  argumentsValue,
  expectedClassification
) {
  checkInterrupted(context.runner);
  let result;
  try {
    result = await client.request("tools/call", {
      name: "worker_integrate",
      arguments: argumentsValue,
      _meta: createMetadata(
        context.threadId,
        context.fixtureRoot,
        context.runner.turnIds
      )
    });
  } catch {
    fail("E_MCP");
  }
  const structured = result?.structuredContent;
  const details = structured?.error?.details;
  if (
    result?.isError !== true
    || !Array.isArray(result.content)
    || result.content.length !== 1
    || result.content[0]?.type !== "text"
    || result.content[0].text !== JSON.stringify(structured)
    || structured?.ok !== false
    || structured?.error?.code !== "E_INTEGRATION"
    || typeof structured.error.message !== "string"
    || structured.error.message.length < 1
    || structured.error.message.length > 8 * 1024
    || !isPlainRecord(details)
    || details.classification !== expectedClassification
    || !/^[a-z][a-z0-9-]{0,63}$/.test(details.classification)
    || Object.keys(details).some((key) => (
      !["classification", "observationDigest"].includes(key)
    ))
    || (
      Object.hasOwn(details, "observationDigest")
      && !/^[a-f0-9]{64}$/.test(details.observationDigest || "")
    )
  ) {
    fail("E_SCENARIO");
  }
  return Object.freeze({
    code: structured.error.code,
    classification: details.classification,
    observationDigest: details.observationDigest || null,
    messageDigest: crypto
      .createHash("sha256")
      .update(structured.error.message)
      .digest("hex")
  });
}

async function assertOwnedWriteSessionAbsent(
  context,
  workerId,
  providerSessionId
) {
  const principal = Object.freeze({
    hostKind: "codex",
    threadId: context.threadId
  });
  for (let observation = 0; observation < 2; observation += 1) {
    const absent = await context.workerSessionLifecycle.inspectOwnedProviderSession({
      root: context.fixtureRoot,
      principal,
      workerId,
      providerSessionId,
      env: context.env
    });
    if (absent?.present !== false) fail("E_SESSION");
  }
}

async function runTwoWriterScenario(baseContext, fixtureRoot) {
  const context = { ...baseContext, fixtureRoot, writeSmoke: true };
  context.runner.writeSmoke = {
    context,
    workerId: null,
    workerIds: []
  };
  enterQualificationStage("write-two-fixture");
  initializeFixtureRepository(fixtureRoot, context.env, {
    writeTarget: true,
    workloadFiles: ACTIVE_WINDOW_WORKLOAD_FILES
  });
  const parentBefore =
    context.workerWorktree.captureParentFingerprint(fixtureRoot);
  const specifications = [
    Object.freeze({
      label: "writer-a",
      content: "after-alpha\n",
      idempotencyKey: `installed-two-writer-a-${crypto.randomUUID()}`
    }),
    Object.freeze({
      label: "writer-b",
      content: "after-beta\n",
      idempotencyKey: `installed-two-writer-b-${crypto.randomUUID()}`
    })
  ];

  enterQualificationStage("write-two-mcp-surface");
  let client = await startInstalledMcp(context);
  await verifyMcpSurface(context, client, { negative: true });

  enterQualificationStage("write-two-spawn");
  const spawned = [];
  for (const specification of specifications) {
    const argumentsValue = {
      idempotencyKey: specification.idempotencyKey,
      userRequest: twoWriterPrompt(
        specification.label,
        specification.content.trimEnd()
      )
    };
    const value = await callTool(
      context,
      client,
      "worker_spawn_write",
      argumentsValue,
      [
        "worker",
        "replayed",
        "spawnSuccessDefinition",
        "providerLaunchState",
        "providerLaunched"
      ]
    );
    const workerId = assertTwoWriterSpawn(value);
    spawned.push({ argumentsValue, value, workerId });
    context.runner.writeSmoke.workerIds.push(workerId);
    context.runner.writeSmoke.workerId = workerId;
  }
  const workerIds = spawned.map(({ workerId }) => workerId);
  if (new Set(workerIds).size !== specifications.length) fail("E_SCENARIO");

  enterQualificationStage("write-two-dispatch");
  const initialPages = [];
  for (const workerId of workerIds) {
    const page = await callWriteSmokeWait(
      context,
      client,
      workerId,
      null,
      0
    );
    if (
      !isPlainRecord(page.stream)
      || page.stream.terminal !== false
      || !isPlainRecord(page.stream.nextCursor)
      || page.stream.nextCursor.workerId !== workerId
    ) {
      fail("E_SCENARIO");
    }
    initialPages.push(page);
  }

  enterQualificationStage("write-two-overlap");
  const overlap = await waitForConcurrentActiveWriteProviders(
    context,
    workerIds,
    parentBefore
  );
  const executionRootDigests = overlap.observations.map(
    ({ job }) => job.executionBinding.expectedExecutionRootDigest
  );
  if (new Set(executionRootDigests).size !== workerIds.length) {
    fail("E_PRIVATE_STATE");
  }

  enterQualificationStage("write-two-wait");
  for (let index = 0; index < workerIds.length; index += 1) {
    await waitForWriteWorkerTerminal(
      context,
      client,
      workerIds[index],
      initialPages[index].stream.nextCursor
    );
  }

  enterQualificationStage("write-two-result");
  const results = [];
  for (const workerId of workerIds) {
    const result = await callWriteSmokeResult(
      context,
      client,
      workerId
    );
    if (
      result.worker?.id !== workerId
      || result.worker?.status !== "completed"
      || result.worker?.write !== true
      || result.worker?.roleId !== "implementer"
      || result.worker?.result?.hostVerification !== "not_run"
    ) {
      fail("E_SCENARIO");
    }
    results.push(result);
  }

  enterQualificationStage("write-two-artifact");
  const artifacts = [];
  const terminal = [];
  for (let index = 0; index < workerIds.length; index += 1) {
    const artifact = await readTwoWriterArtifact(
      context,
      client,
      workerIds[index],
      parentBefore,
      specifications[index].content,
      results[index]
    );
    artifacts.push(artifact);
    terminal.push(inspectTwoWriterTerminal(
      context,
      workerIds[index],
      parentBefore,
      specifications[index].content,
      artifact
    ));
  }
  if (
    artifacts[0].metadata.artifact.manifestDigest
      === artifacts[1].metadata.artifact.manifestDigest
    || artifacts[0].metadata.artifact.contentDigest
      === artifacts[1].metadata.artifact.contentDigest
  ) {
    fail("E_PRIVATE_STATE");
  }

  enterQualificationStage("write-two-parent");
  context.workerWorktree.assertParentUnchanged(parentBefore, fixtureRoot);
  if (
    fs.readFileSync(path.join(fixtureRoot, "target.txt"), "utf8")
      !== "before\n"
  ) {
    fail("E_SCENARIO");
  }

  enterQualificationStage("write-two-preview");
  const readyPreviews = [];
  for (let index = 0; index < workerIds.length; index += 1) {
    readyPreviews.push(await callTwoWriterPreview(
      context,
      client,
      workerIds[index],
      artifacts[index].metadata.artifact.manifestDigest,
      "ready"
    ));
  }

  enterQualificationStage("write-two-retention-reconnect");
  await closeMcp(context, client);
  client = await startInstalledMcp(context);
  await verifyMcpSurface(context, client, { negative: true });
  const retainedB = await readTwoWriterArtifact(
    context,
    client,
    workerIds[1],
    parentBefore,
    specifications[1].content,
    results[1]
  );
  const retainedBPreview = await callTwoWriterPreview(
    context,
    client,
    workerIds[1],
    artifacts[1].metadata.artifact.manifestDigest,
    "ready"
  );
  if (
    !sameJson(retainedB, artifacts[1])
    || retainedBPreview.classification !== readyPreviews[1].classification
  ) {
    fail("E_PRIVATE_STATE");
  }

  enterQualificationStage("write-two-integration");
  const integrationArguments = {
    id: workerIds[0],
    manifestDigest: artifacts[0].metadata.artifact.manifestDigest,
    idempotencyKey: `installed-two-writer-integrate-${crypto.randomUUID()}`
  };
  const integrated = await callTool(
    context,
    client,
    "worker_integrate",
    integrationArguments,
    ["receipt", "replayed"]
  );
  const integrationReceipt = integrated.receipt;
  if (
    integrated.replayed !== false
    || integrationReceipt?.workerId !== workerIds[0]
    || integrationReceipt?.manifestDigest
      !== artifacts[0].metadata.artifact.manifestDigest
    || !/^[a-f0-9]{64}$/.test(integrationReceipt?.receiptDigest || "")
  ) {
    fail("E_SCENARIO");
  }

  enterQualificationStage("write-two-verification");
  const verification = await callTwoWriterVerify(
    context,
    client,
    workerIds[0],
    artifacts[0].metadata.artifact.manifestDigest,
    integrationReceipt.receiptDigest
  );
  const independentVerification =
    context.workerWorktree.verifyWriteVerticalIntegration({
      controlRoot: fixtureRoot,
      artifact: terminal[0].storedArtifact,
      parentFingerprint: parentBefore,
      expectedWorkerId: workerIds[0]
    });
  if (
    fs.readFileSync(path.join(fixtureRoot, "target.txt"), "utf8")
      !== specifications[0].content
    || independentVerification.manifestDigest
      !== artifacts[0].metadata.artifact.manifestDigest
    || independentVerification.patchDigest
      !== artifacts[0].metadata.artifact.patchDigest
    || independentVerification.contentDigest
      !== artifacts[0].metadata.artifact.contentDigest
  ) {
    fail("E_SCENARIO");
  }
  const parentAfterA =
    context.workerWorktree.captureParentFingerprint(fixtureRoot);

  enterQualificationStage("write-two-conflict");
  const conflictPreview = await callTwoWriterPreview(
    context,
    client,
    workerIds[1],
    artifacts[1].metadata.artifact.manifestDigest,
    "conflict"
  );
  if (
    conflictPreview.classification === readyPreviews[1].classification
    || conflictPreview.observationDigest === readyPreviews[1].observationDigest
  ) {
    fail("E_SCENARIO");
  }
  const rejectedIntegrationArguments = {
    id: workerIds[1],
    manifestDigest: artifacts[1].metadata.artifact.manifestDigest,
    idempotencyKey:
      `installed-two-writer-rejected-integrate-${crypto.randomUUID()}`
  };
  const rejectedIntegration = await callExpectedTwoWriterConflict(
    context,
    client,
    rejectedIntegrationArguments,
    conflictPreview.classification
  );
  context.workerWorktree.assertParentUnchanged(parentAfterA, fixtureRoot);

  enterQualificationStage("write-two-abandon");
  const abandonArguments = {
    id: workerIds[1],
    manifestDigest: artifacts[1].metadata.artifact.manifestDigest,
    idempotencyKey: `installed-two-writer-abandon-${crypto.randomUUID()}`
  };
  const abandoned = await callTool(
    context,
    client,
    TWO_WRITER_TOOLS.abandon,
    abandonArguments,
    ["receipt", "replayed"]
  );
  const abandonReceipt = abandoned.receipt;
  if (
    abandoned.replayed !== false
    || abandonReceipt?.workerId !== workerIds[1]
    || abandonReceipt?.disposition !== "abandoned"
    || abandonReceipt?.terminalStatus !== "completed"
    || !/^[a-f0-9]{64}$/.test(abandonReceipt?.receiptDigest || "")
  ) {
    fail("E_SCENARIO");
  }
  context.workerWorktree.assertParentUnchanged(parentAfterA, fixtureRoot);

  enterQualificationStage("write-two-cleanup");
  const cleanupArguments = {
    id: workerIds[0],
    integrationReceiptDigest: integrationReceipt.receiptDigest,
    idempotencyKey: `installed-two-writer-cleanup-${crypto.randomUUID()}`
  };
  const cleaned = await callTool(
    context,
    client,
    "worker_cleanup",
    cleanupArguments,
    ["receipt", "replayed"]
  );
  const cleanupReceipt = cleaned.receipt;
  if (
    cleaned.replayed !== false
    || cleanupReceipt?.workerId !== workerIds[0]
    || cleanupReceipt?.integrationReceiptDigest
      !== integrationReceipt.receiptDigest
    || !/^[a-f0-9]{64}$/.test(cleanupReceipt?.receiptDigest || "")
  ) {
    fail("E_SCENARIO");
  }
  context.workerWorktree.assertParentUnchanged(parentAfterA, fixtureRoot);

  enterQualificationStage("write-two-reconnect-replay");
  await closeMcp(context, client);
  client = await startInstalledMcp(context);
  await verifyMcpSurface(context, client);
  const verificationReplay = await callTwoWriterVerify(
    context,
    client,
    workerIds[0],
    artifacts[0].metadata.artifact.manifestDigest,
    integrationReceipt.receiptDigest
  );
  const integrationReplay = await callTool(
    context,
    client,
    "worker_integrate",
    integrationArguments,
    ["receipt", "replayed"]
  );
  const cleanupReplay = await callTool(
    context,
    client,
    "worker_cleanup",
    cleanupArguments,
    ["receipt", "replayed"]
  );
  const abandonReplay = await callTool(
    context,
    client,
    TWO_WRITER_TOOLS.abandon,
    abandonArguments,
    ["receipt", "replayed"]
  );
  if (
    verificationReplay.status !== verification.status
    || verificationReplay.classification !== verification.classification
    || verificationReplay.manifestDigest !== verification.manifestDigest
    || verificationReplay.integrationReceiptDigest
      !== verification.integrationReceiptDigest
    || integrationReplay.replayed !== true
    || !sameJson(integrationReplay.receipt, integrationReceipt)
    || cleanupReplay.replayed !== true
    || !sameJson(cleanupReplay.receipt, cleanupReceipt)
    || abandonReplay.replayed !== true
    || !sameJson(abandonReplay.receipt, abandonReceipt)
  ) {
    fail("E_SCENARIO");
  }

  enterQualificationStage("write-two-artifact-post-cleanup");
  const postCleanupArtifacts = [];
  for (let index = 0; index < workerIds.length; index += 1) {
    const replayed = await readTwoWriterArtifact(
      context,
      client,
      workerIds[index],
      parentBefore,
      specifications[index].content,
      results[index]
    );
    if (!sameJson(replayed, artifacts[index])) fail("E_PRIVATE_STATE");
    postCleanupArtifacts.push(replayed);
  }

  enterQualificationStage("write-two-absence");
  for (let index = 0; index < workerIds.length; index += 1) {
    await waitForWriteSmokeProcessClosure(
      context,
      workerIds[index],
      terminal[index].retainedProviderIdentities
    );
    if (context.guard.loadProviderGuard(fixtureRoot, workerIds[index]) !== null) {
      fail("E_CLEANUP");
    }
    await assertOwnedWriteSessionAbsent(
      context,
      workerIds[index],
      terminal[index].job.grokSessionId
    );
    const effect = context.workerWorktree.classifyWorkerWorktreeEffect({
      controlRoot: fixtureRoot,
      executionRoot: terminal[index].executionRoot,
      baseCommit: parentBefore.head,
      workerId: workerIds[index],
      env: context.env
    });
    if (
      effect.classification !== "absent"
      || fs.existsSync(terminal[index].executionRoot)
    ) {
      fail("E_CLEANUP");
    }
  }
  context.workerWorktree.assertParentUnchanged(parentAfterA, fixtureRoot);
  await closeMcp(context, client);

  return Object.freeze({
    schemaVersion: 1,
    scenario: "official-grok-build-two-writer-conflict",
    workers: Object.freeze({
      a: Object.freeze({
        id: workerIds[0],
        executionBindingDigest:
          terminal[0].job.executionBinding.bindingDigest,
        executionRootDigest:
          terminal[0].job.executionBinding.expectedExecutionRootDigest,
        providerProcessDigest: canonicalDigest(
          overlap.observations[0].identity.providerProcess
        ),
        manifestDigest: artifacts[0].metadata.artifact.manifestDigest,
        patchDigest: artifacts[0].metadata.artifact.patchDigest,
        contentDigest: artifacts[0].metadata.artifact.contentDigest,
        readyObservationDigest: readyPreviews[0].observationDigest,
        integrationReceiptDigest: integrationReceipt.receiptDigest,
        verificationObservationDigest: verification.observationDigest,
        cleanupReceiptDigest: cleanupReceipt.receiptDigest
      }),
      b: Object.freeze({
        id: workerIds[1],
        executionBindingDigest:
          terminal[1].job.executionBinding.bindingDigest,
        executionRootDigest:
          terminal[1].job.executionBinding.expectedExecutionRootDigest,
        providerProcessDigest: canonicalDigest(
          overlap.observations[1].identity.providerProcess
        ),
        manifestDigest: artifacts[1].metadata.artifact.manifestDigest,
        patchDigest: artifacts[1].metadata.artifact.patchDigest,
        contentDigest: artifacts[1].metadata.artifact.contentDigest,
        readyObservationDigest: readyPreviews[1].observationDigest,
        conflictObservationDigest: conflictPreview.observationDigest,
        conflictClassification: conflictPreview.classification,
        rejectedIntegrationCode: rejectedIntegration.code,
        rejectedIntegrationMessageDigest:
          rejectedIntegration.messageDigest,
        abandonReceiptDigest: abandonReceipt.receiptDigest
      })
    }),
    providerOverlap: Object.freeze({
      proven: true,
      observedAt: overlap.observedAt,
      observationDigest: overlap.observationDigest,
      rootsDistinct: true
    }),
    parent: Object.freeze({
      baseCommit: parentBefore.head,
      beforeFingerprintDigest: parentBefore.fingerprintDigest,
      unchangedBeforeIntegration: true,
      indexUnchangedBeforeIntegration: true,
      integratedContentDigest:
        artifacts[0].metadata.artifact.contentDigest,
      rejectedIntegrationNoEffect: true,
      abandonNoEffect: true
    }),
    replay: Object.freeze({
      retainedArtifactBAfterReconnect: true,
      verificationA: true,
      integrationA: true,
      cleanupA: true,
      abandonB: true,
      immutableArtifactsAfterCleanup: postCleanupArtifacts.length === 2
    }),
    absence: Object.freeze({
      sessions: true,
      worktrees: true,
      guards: true,
      processes: true
    })
  });
}

async function runWriteSmokeScenario(baseContext, fixtureRoot) {
  const context = { ...baseContext, fixtureRoot, writeSmoke: true };
  context.runner.writeSmoke = { context, workerId: null };
  enterQualificationStage("write-smoke-fixture");
  initializeFixtureRepository(
    fixtureRoot,
    context.env,
    { writeTarget: true }
  );
  const parentBefore = context.workerWorktree.captureParentFingerprint(fixtureRoot);
  const expectedContent = "after\n";
  const expectedContentDigest = crypto
    .createHash("sha256")
    .update(expectedContent)
    .digest("hex");

  enterQualificationStage("write-smoke-mcp-surface");
  let client = await startInstalledMcp(context);
  await verifyMcpSurface(context, client, { negative: true });

  enterQualificationStage("write-smoke-spawn");
  const spawnArguments = {
    idempotencyKey: `installed-write-smoke-${crypto.randomUUID()}`,
    userRequest: [
      "Edit only target.txt in the current isolated worktree.",
      "Replace its complete contents with exactly the single line: after",
      "The file must end with one newline.",
      "You must perform the mutation with an actual workspace editing tool; a completion report without an observed file change is a failure.",
      "After editing, read target.txt again and verify its complete contents are exactly after followed by one newline.",
      "Do not commit and do not modify any other path.",
      "Verify the edit, then return the required structured worker report.",
      "In that report, list only target.txt in changedFiles and mark AC-01 and AC-02 met only if the exact edit and one-file scope were verified."
    ].join(" ")
  };
  const spawned = await callTool(
    context,
    client,
    "worker_spawn_write",
    spawnArguments,
    [
      "worker",
      "replayed",
      "spawnSuccessDefinition",
      "providerLaunchState",
      "providerLaunched"
    ]
  );
  const workerId = spawned.worker?.id;
  if (
    typeof workerId !== "string"
    || spawned.worker?.write !== true
    || spawned.worker?.roleId !== "implementer"
    || spawned.replayed !== false
    || spawned.spawnSuccessDefinition !== "durable-job-commit"
    || spawned.providerLaunchState !== "not-ready"
    || spawned.providerLaunched !== false
  ) {
    fail("E_SCENARIO");
  }
  context.runner.writeSmoke.workerId = workerId;

  enterQualificationStage("write-smoke-wait");
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS;
  let cursor = null;
  let terminal = false;
  let firstWait = true;
  while (Date.now() < deadline) {
    const page = await callWriteSmokeWait(
      context,
      client,
      workerId,
      cursor,
      firstWait ? 0 : 30_000
    );
    firstWait = false;
    if (
      !isPlainRecord(page.stream)
      || typeof page.stream.terminal !== "boolean"
      || !isPlainRecord(page.stream.nextCursor)
      || page.stream.nextCursor.workerId !== workerId
    ) {
      fail("E_SCENARIO");
    }
    cursor = page.stream.nextCursor;
    if (page.stream.terminal) {
      terminal = true;
      break;
    }
  }
  if (!terminal) fail("E_SCENARIO");

  enterQualificationStage("write-smoke-result");
  const result = await callWriteSmokeResult(
    context,
    client,
    workerId
  );
  if (
    result.worker?.id !== workerId
    || result.worker?.status !== "completed"
    || result.worker?.write !== true
    || result.worker?.roleId !== "implementer"
    || result.worker?.result?.hostVerification !== "not_run"
  ) {
    fail("E_SCENARIO");
  }

  enterQualificationStage("write-smoke-artifact");
  const metadata = await callTool(
    context,
    client,
    "worker_artifact",
    { id: workerId, part: "metadata" },
    ["artifact"]
  );
  const content = await callTool(
    context,
    client,
    "worker_artifact",
    { id: workerId, part: "content" },
    ["artifact"]
  );
  const patch = await callTool(
    context,
    client,
    "worker_artifact",
    { id: workerId, part: "patch" },
    ["artifact"]
  );
  if (
    !sameJson(result.artifact, metadata.artifact)
    || metadata.artifact?.path !== "target.txt"
    || metadata.artifact?.baseCommit !== parentBefore.head
    || metadata.artifact?.contentDigest !== expectedContentDigest
    || content.artifact?.part !== "content"
    || content.artifact?.payload !== expectedContent
    || content.artifact?.payloadDigest !== expectedContentDigest
    || content.artifact?.payloadBytes !== Buffer.byteLength(expectedContent)
    || patch.artifact?.part !== "patch"
    || patch.artifact?.payloadDigest !== metadata.artifact.patchDigest
    || !patch.artifact?.payload.includes("diff --git a/target.txt b/target.txt")
    || !patch.artifact?.payload.includes("-before")
    || !patch.artifact?.payload.includes("+after")
  ) {
    fail("E_SCENARIO");
  }

  enterQualificationStage("write-smoke-parent");
  context.workerWorktree.assertParentUnchanged(parentBefore, fixtureRoot);
  if (fs.readFileSync(path.join(fixtureRoot, "target.txt"), "utf8") !== "before\n") {
    fail("E_SCENARIO");
  }

  enterQualificationStage("write-smoke-private");
  const terminalJob = context.state.readJob(fixtureRoot, workerId, context.env);
  let terminalBindingValid = true;
  try {
    context.mutation.assertDispatchContract(terminalJob);
  } catch {
    terminalBindingValid = false;
  }
  assertProviderPinPersistence(context, terminalJob, {
    requireCurrentIntent: true,
    requirePrimaryTurnAdmissions: true,
    requireWorktreeIntent: true
  });
  const terminalDispatch = terminalJob.request?.spawn?.dispatch;
  const providerGeneration = terminalDispatch?.providerGeneration;
  const providerProcess = terminalJob.providerProcess;
  const providerSpawnIntent = terminalJob.request?.spawn?.providerSpawnIntent;
  const providerRotationIntent =
    terminalJob.request?.spawn?.providerRotationIntent;
  const primaryTurnAdmissions =
    terminalJob.request?.spawn?.primaryTurnAdmissions;
  const primaryTurnAdmissionKeys = isPlainRecord(primaryTurnAdmissions)
    ? Object.keys(primaryTurnAdmissions).sort()
    : [];
  const generationOneAdmission = primaryTurnAdmissions?.["1"];
  const generationOneAdmissionValid = validWriteSmokePrimaryTurnAdmission(
    generationOneAdmission,
    {
      generation: 1,
      dispatch: terminalDispatch,
      workerId,
      workerProcess: terminalJob.workerProcess,
      providerSessionId: terminalJob.grokSessionId,
      providerLaunchBindingDigest: context.providerLaunchBindingDigest,
      providerExecutableIdentityDigest:
        context.providerExecutableIdentityDigest,
      ...(providerGeneration === 1
        ? { expectedProviderProcess: providerProcess }
        : {})
    }
  );
  let mailboxAttempt = null;
  let mailboxMessages = null;
  let mailboxBodiesAbsent = false;
  try {
    mailboxAttempt = context.mailboxState.readAttemptMailbox(
      fixtureRoot,
      workerId,
      terminalDispatch?.attemptId,
      context.env
    );
    mailboxMessages = context.mailboxState.listAttemptMessages(
      fixtureRoot,
      workerId,
      terminalDispatch?.attemptId,
      context.env
    );
    context.mailboxState.assertNoRetainedBodies(
      fixtureRoot,
      workerId,
      terminalDispatch?.attemptId,
      context.env
    );
    mailboxBodiesAbsent = true;
  } catch {
    mailboxAttempt = null;
    mailboxMessages = null;
    mailboxBodiesAbsent = false;
  }
  const workerReport = terminalJob.result?.workerReport;
  const nativeStructuredReportProof =
    workerReport?.reportSource === "acp-structured"
    && /^[a-f0-9]{64}$/.test(workerReport?.reportDigest || "")
    && workerReport.valid === true
    && workerReport.structured === true;
  const expectedFinalReportDigest = nativeStructuredReportProof
    ? workerReport.reportDigest
    : terminalJob.result?.textDigest;
  const mailboxProofValid = mailboxAttempt?.state === "closed"
    && mailboxAttempt.workerId === workerId
    && mailboxAttempt.dispatchAttemptId === terminalDispatch?.attemptId
    && mailboxAttempt.dispatchFence === terminalDispatch?.fence
    && mailboxAttempt.providerGeneration === 1
    && generationOneAdmissionValid
    && mailboxAttempt.workerProcessDigest
      === context.mailboxState.stableDigest(
        generationOneAdmission?.workerProcess
      )
    && mailboxAttempt.providerProcessDigest
      === context.mailboxState.stableDigest(
        generationOneAdmission?.providerProcess
      )
    && mailboxAttempt.providerSessionDigest
      === context.mailboxState.stableDigest({
        providerSessionId: terminalJob.grokSessionId
      })
    && mailboxAttempt.providerCapabilityDigest
      === terminalJob.request?.spawn?.providerCapabilityDigest
    && mailboxAttempt.providerCapabilityDigest
      === context.writeLifecycleCapabilityDigest
    && mailboxAttempt.contextReceiptDigest
      === context.mailboxState.stableDigest(
        terminalJob.request?.contextReceipt
      )
    && mailboxAttempt.rolePolicyDigest
      === terminalJob.request?.runtimeRolePolicy?.digest
    && mailboxAttempt.nextSequence === 1
    && mailboxAttempt.acceptedCount === 0
    && mailboxAttempt.acceptedBytes === 0
    && mailboxAttempt.lastCompletedSequence === 0
    && mailboxAttempt.finalReportSequence === 0
    && mailboxAttempt.deliveryUnknownSequence === null
    && mailboxAttempt.activeSequence === null
    && Array.isArray(mailboxMessages)
    && mailboxMessages.length === 0
    && mailboxBodiesAbsent
    && terminalJob.result?.mailboxEvidence?.selectedSequence === 0
    && terminalJob.result?.mailboxEvidence?.lastCompletedSequence === 0
    && terminalJob.result?.mailboxEvidence?.finalReportSequence === 0
    && mailboxAttempt.communicationChainDigest
      === terminalJob.result?.mailboxEvidence?.communicationChainDigest
    && terminalJob.result?.mailboxEvidence?.deliveryUnknown === false
    && terminalJob.result?.mailboxEvidence?.closed === true
    && terminalJob.result?.mailboxEvidence?.bodiesRetained === false
    && mailboxAttempt.finalReportDigest === expectedFinalReportDigest
    && mailboxAttempt.finalReportDigest
      === terminalJob.result?.mailboxEvidence?.finalReportDigest;
  const generationOneProof = providerGeneration === 1
    && sameJson(primaryTurnAdmissionKeys, ["1"])
    && terminalDispatch?.nextProviderGeneration === null
    && terminalDispatch?.providerRotationCount == null
    && terminalDispatch?.providerRotatedAt == null
    && providerRotationIntent == null
    && terminalJob.result?.reportRepair == null
    && providerProcess?.providerGeneration === 1
    && providerSpawnIntent?.status === "registered"
    && providerSpawnIntent.providerGeneration === 1
    && generationOneAdmissionValid
    && generationOneAdmission.promptDigest
      === terminalJob.request?.providerPromptDigest;
  const generationTwoAdmission = primaryTurnAdmissions?.["2"];
  const generationTwoAdmissionValid = validWriteSmokePrimaryTurnAdmission(
    generationTwoAdmission,
    {
      generation: 2,
      dispatch: terminalDispatch,
      workerId,
      workerProcess: terminalJob.workerProcess,
      providerSessionId: terminalJob.grokSessionId,
      providerLaunchBindingDigest: context.providerLaunchBindingDigest,
      providerExecutableIdentityDigest:
        context.providerExecutableIdentityDigest,
      expectedProviderProcess: providerProcess
    }
  );
  const generationTwoProof = providerGeneration === 2
    && sameJson(primaryTurnAdmissionKeys, ["1", "2"])
    && terminalDispatch?.nextProviderGeneration === null
    && terminalDispatch?.providerRotationCount === 1
    && typeof terminalDispatch?.providerRotatedAt === "string"
    && providerRotationIntent?.status === "registered"
    && providerRotationIntent.baseProviderGeneration === 1
    && providerRotationIntent.targetProviderGeneration === 2
    && providerSpawnIntent?.status === "registered"
    && providerSpawnIntent.providerGeneration === 2
    && providerSpawnIntent.intentId === providerRotationIntent.intentId
    && terminalJob.result?.reportRepair?.attempted === true
    && terminalJob.result.reportRepair.valid === true
    && providerProcess?.providerGeneration === 2
    && providerProcess.commandMarker === workerId
    && providerProcess.dispatchAttemptId === terminalDispatch?.attemptId
    && providerProcess.dispatchFence === terminalDispatch?.fence
    && generationOneAdmissionValid
    && generationTwoAdmissionValid
    && generationOneAdmission.providerSessionId
      === generationTwoAdmission.providerSessionId
    && generationOneAdmission.promptDigest
      === terminalJob.request?.providerPromptDigest
    && generationOneAdmission.promptDigest
      !== generationTwoAdmission.promptDigest
    && (
      generationOneAdmission.providerProcess.pid
        !== generationTwoAdmission.providerProcess.pid
      || generationOneAdmission.providerProcess.startToken
        !== generationTwoAdmission.providerProcess.startToken
    );
  const providerLifecycleProof = mailboxProofValid
    && (generationOneProof || generationTwoProof)
    && nativeStructuredReportProof;
  const expectedExecutionRoot = context.workerWorktree.expectedWorkerWorktreeRoot(
    fixtureRoot,
    workerId,
    context.env
  );
  const managedIdentity =
    context.workerWorktree.assertRegisteredWorkerWorktreeIdentity({
      controlRoot: fixtureRoot,
      executionRoot: expectedExecutionRoot,
      baseCommit: parentBefore.head,
      workerId,
      env: context.env
    });
  const storedArtifact = context.workerWorktree.readWriteWorkerArtifact({
    controlRoot: fixtureRoot,
    workerId,
    env: context.env,
    expectedManifestDigest: metadata.artifact.manifestDigest
  });
  if (
    !terminalBindingValid
    || terminalJob.status !== "completed"
    || terminalJob.write !== true
    || terminalJob.role?.id !== "implementer"
    || terminalJob.profile?.id !== "rescue-write-v3"
    || !providerLifecycleProof
    || terminalJob.request?.spawn?.providerLaunchOutcome !== "launched"
    || terminalJob.result?.taskRuntimeCleaned !== true
    || terminalJob.result?.workerReport?.valid !== true
    || terminalJob.result?.workerReport?.outcome !== "complete"
    || !sameJson(
      terminalJob.result?.workerReport?.acceptanceResults?.map(
        ({ id, status }) => ({ id, status })
      ),
      [
        { id: "AC-01", status: "met" },
        { id: "AC-02", status: "met" }
      ]
    )
    || terminalJob.result?.providerClaims?.success !== true
    || terminalJob.result?.providerClaims?.observedFileAgreement !== true
    || !sameJson(
      terminalJob.result?.providerClaims?.changedFiles,
      ["target.txt"]
    )
    || result.worker?.result?.providerClaims?.success !== true
    || !sameJson(
      result.worker?.result?.providerClaims,
      terminalJob.result?.providerClaims
    )
    || !sameJson(terminalJob.request?.envelope?.scope, {
      include: ["target.txt"],
      exclude: []
    })
    || terminalJob.result?.writeArtifact?.contentDigest !== expectedContentDigest
    || managedIdentity.executionRoot !== fs.realpathSync(expectedExecutionRoot)
    || storedArtifact.content !== expectedContent
    || storedArtifact.patch !== patch.artifact.payload
    || storedArtifact.record.contentDigest !== metadata.artifact.contentDigest
    || storedArtifact.record.patchDigest !== metadata.artifact.patchDigest
    || fs.realpathSync(terminalJob.request?.spawn?.executionRoot)
      !== fs.realpathSync(expectedExecutionRoot)
    || fs.readFileSync(path.join(expectedExecutionRoot, "target.txt"), "utf8")
      !== expectedContent
  ) {
    process.stderr.write(
      `Installed Worker MCP write-smoke diagnostic ${JSON.stringify({
        schemaVersion: 1,
        stage: "write-smoke-private",
        terminalBindingValid,
        mailboxProofValid,
        generationOneProof,
        generationTwoProof,
        nativeStructuredReportProof,
        reportSource: workerReport?.reportSource || null,
        reportDigest: workerReport?.reportDigest || null,
        primaryTurnAdmissionKeys,
        generationOneAdmissionValid,
        generationTwoAdmissionValid,
        providerClaimsSuccess:
          terminalJob.result?.providerClaims?.success === true,
        publicProviderClaimsSuccess:
          result.worker?.result?.providerClaims?.success === true,
        publicPrivateProviderClaimsEqual: sameJson(
          result.worker?.result?.providerClaims,
          terminalJob.result?.providerClaims
        ),
        acceptanceResultsExact: sameJson(
          terminalJob.result?.workerReport?.acceptanceResults?.map(
            ({ id, status }) => ({ id, status })
          ),
          [
            { id: "AC-01", status: "met" },
            { id: "AC-02", status: "met" }
          ]
        ),
        providerChangedFilesExact: sameJson(
          terminalJob.result?.providerClaims?.changedFiles,
          ["target.txt"]
        ),
        envelopeScopeExact: sameJson(
          terminalJob.request?.envelope?.scope,
          { include: ["target.txt"], exclude: [] }
        ),
        writeArtifactContentBound:
          terminalJob.result?.writeArtifact?.contentDigest
            === expectedContentDigest,
        managedExecutionRootBound:
          managedIdentity.executionRoot === fs.realpathSync(expectedExecutionRoot),
        storedArtifactContentBound: storedArtifact.content === expectedContent,
        storedArtifactPatchBound:
          storedArtifact.patch === patch.artifact.payload,
        storedArtifactRecordBound:
          storedArtifact.record.contentDigest === metadata.artifact.contentDigest
          && storedArtifact.record.patchDigest === metadata.artifact.patchDigest,
        spawnExecutionRootBound:
          fs.realpathSync(terminalJob.request?.spawn?.executionRoot)
            === fs.realpathSync(expectedExecutionRoot),
        executionContentExact:
          fs.readFileSync(
            path.join(expectedExecutionRoot, "target.txt"),
            "utf8"
          ) === expectedContent,
        mailboxAttemptState: /^[a-z][a-z0-9-]{0,31}$/.test(
          String(mailboxAttempt?.state || "")
        )
          ? mailboxAttempt.state
          : null,
        mailboxFinalReportSequence: Number.isSafeInteger(
          mailboxAttempt?.finalReportSequence
        )
          ? mailboxAttempt.finalReportSequence
          : null,
        mailboxLastCompletedSequence: Number.isSafeInteger(
          mailboxAttempt?.lastCompletedSequence
        )
          ? mailboxAttempt.lastCompletedSequence
          : null,
        mailboxWorkerProcessBound:
          mailboxAttempt?.workerProcessDigest
            === context.mailboxState.stableDigest(
              generationOneAdmission?.workerProcess
            ),
        mailboxProviderProcessBound:
          mailboxAttempt?.providerProcessDigest
            === context.mailboxState.stableDigest(
              generationOneAdmission?.providerProcess
            ),
        mailboxProviderCapabilityBound:
          mailboxAttempt?.providerCapabilityDigest
            === terminalJob.request?.spawn?.providerCapabilityDigest
          && mailboxAttempt?.providerCapabilityDigest
            === context.writeLifecycleCapabilityDigest,
        mailboxContextReceiptBound:
          mailboxAttempt?.contextReceiptDigest
            === context.mailboxState.stableDigest(
              terminalJob.request?.contextReceipt
            ),
        mailboxRolePolicyBound:
          mailboxAttempt?.rolePolicyDigest
            === terminalJob.request?.runtimeRolePolicy?.digest,
        mailboxNoMessages:
          Array.isArray(mailboxMessages) && mailboxMessages.length === 0,
        mailboxBodiesAbsent,
        mailboxChainBound:
          mailboxAttempt?.communicationChainDigest
            === terminalJob.result?.mailboxEvidence?.communicationChainDigest,
        mailboxFinalDigestBound:
          mailboxAttempt?.finalReportDigest === expectedFinalReportDigest
          && mailboxAttempt?.finalReportDigest
            === terminalJob.result?.mailboxEvidence?.finalReportDigest,
        resultSelectedSequence: Number.isSafeInteger(
          terminalJob.result?.mailboxEvidence?.selectedSequence
        )
          ? terminalJob.result.mailboxEvidence.selectedSequence
          : null,
        resultLastCompletedSequence: Number.isSafeInteger(
          terminalJob.result?.mailboxEvidence?.lastCompletedSequence
        )
          ? terminalJob.result.mailboxEvidence.lastCompletedSequence
          : null,
        resultFinalReportSequence: Number.isSafeInteger(
          terminalJob.result?.mailboxEvidence?.finalReportSequence
        )
          ? terminalJob.result.mailboxEvidence.finalReportSequence
          : null,
        generationOnePromptMatchesCurrent:
          generationOneAdmission?.promptDigest
            === terminalJob.request?.providerPromptDigest,
        generationTwoPromptDiffersFromCurrent:
          generationTwoAdmission?.promptDigest
            !== terminalJob.request?.providerPromptDigest,
        admissionPromptDigestsDiffer: Boolean(
          generationOneAdmission?.promptDigest
          && generationTwoAdmission?.promptDigest
          && generationOneAdmission.promptDigest
            !== generationTwoAdmission.promptDigest
        )
      })}\n`
    );
    fail("E_PRIVATE_STATE");
  }

  const terminalJobDigestBeforeReplay = canonicalDigest(terminalJob);
  const managedIdentityBeforeReplay = structuredClone(managedIdentity);
  const executionRootBeforeReplay = fs.lstatSync(expectedExecutionRoot);
  if (
    !executionRootBeforeReplay.isDirectory()
    || executionRootBeforeReplay.isSymbolicLink()
  ) {
    fail("E_PRIVATE_STATE");
  }
  const writeSpawnWitnessBeforeReplay = validateWriteSpawnResponseWitness(
    context,
    spawned.worker,
    terminalJob,
    spawnArguments.idempotencyKey,
    { replayed: false }
  );
  const retainedProviderIdentities = Object.values(primaryTurnAdmissions).map(
    (admission) => structuredClone(admission.providerProcess)
  );
  await waitForWriteSmokeProcessClosure(
    context,
    workerId,
    retainedProviderIdentities
  );
  if (context.guard.loadProviderGuard(fixtureRoot, workerId) !== null) {
    fail("E_CLEANUP");
  }

  enterQualificationStage("write-smoke-spawn-reconnect");
  await closeMcp(context, client);
  client = await startInstalledMcp(context);
  await verifyMcpSurface(context, client, { negative: true });

  enterQualificationStage("write-smoke-spawn-replay");
  const spawnReplay = await callTool(
    context,
    client,
    "worker_spawn_write",
    spawnArguments,
    [
      "worker",
      "replayed",
      "spawnSuccessDefinition",
      "providerLaunchState",
      "providerLaunched"
    ]
  );
  if (
    spawnReplay.replayed !== true
    || spawnReplay.worker?.id !== workerId
    || spawnReplay.worker?.status !== "completed"
    || spawnReplay.worker?.phase !== "done"
    || spawnReplay.worker?.terminal !== true
    || spawnReplay.worker?.write !== true
    || spawnReplay.worker?.roleId !== "implementer"
    || spawnReplay.spawnSuccessDefinition !== "durable-job-commit"
    || spawnReplay.providerLaunchState !== "worktree-ready-no-dispatch"
    || spawnReplay.providerLaunched !== false
  ) {
    process.stderr.write(
      `Installed Worker MCP write-smoke diagnostic ${JSON.stringify({
        schemaVersion: 1,
        stage: "write-smoke-spawn-replay",
        replayed: spawnReplay.replayed === true,
        workerIdBound: spawnReplay.worker?.id === workerId,
        workerStatus: ["queued", "running", "completed", "cancelled", "failed"]
          .includes(spawnReplay.worker?.status)
          ? spawnReplay.worker.status
          : null,
        workerPhase: /^[a-z][a-z0-9-]{0,63}$/.test(
          String(spawnReplay.worker?.phase || "")
        )
          ? spawnReplay.worker.phase
          : null,
        terminal: spawnReplay.worker?.terminal === true,
        write: spawnReplay.worker?.write === true,
        implementer: spawnReplay.worker?.roleId === "implementer",
        durableCommit:
          spawnReplay.spawnSuccessDefinition === "durable-job-commit",
        providerLaunchState: /^[a-z][a-z0-9-]{0,63}$/.test(
          String(spawnReplay.providerLaunchState || "")
        )
          ? spawnReplay.providerLaunchState
          : null,
        providerLaunched: spawnReplay.providerLaunched === true
      })}\n`
    );
    fail("E_SCENARIO");
  }
  const replayedTerminalJob = context.state.readJob(
    fixtureRoot,
    workerId,
    context.env
  );
  const writeSpawnWitnessAfterReplay = validateWriteSpawnResponseWitness(
    context,
    spawnReplay.worker,
    replayedTerminalJob,
    spawnArguments.idempotencyKey,
    { replayed: true }
  );
  const executionRootAfterReplay = fs.lstatSync(expectedExecutionRoot);
  const managedIdentityAfterReplay =
    context.workerWorktree.assertRegisteredWorkerWorktreeIdentity({
      controlRoot: fixtureRoot,
      executionRoot: expectedExecutionRoot,
      baseCommit: parentBefore.head,
      workerId,
      env: context.env
    });
  const replayedPrimaryTurnAdmissionKeys = Object.keys(
    replayedTerminalJob.request?.spawn?.primaryTurnAdmissions || {}
  ).sort();
  const providerGenerationDelta =
    replayedTerminalJob.request?.spawn?.dispatch?.providerGeneration
    - providerGeneration;
  const primaryTurnAdmissionDelta =
    replayedPrimaryTurnAdmissionKeys.length
    - primaryTurnAdmissionKeys.length;
  const worktreeIdentityChanged =
    executionRootAfterReplay.dev !== executionRootBeforeReplay.dev
    || executionRootAfterReplay.ino !== executionRootBeforeReplay.ino
    || !sameJson(managedIdentityAfterReplay, managedIdentityBeforeReplay);
  if (
    canonicalDigest(replayedTerminalJob) !== terminalJobDigestBeforeReplay
    || !sameJson(replayedTerminalJob, terminalJob)
    || writeSpawnWitnessAfterReplay.witness.responseSequence
      !== writeSpawnWitnessBeforeReplay.witness.responseSequence + 1
    || writeSpawnWitnessAfterReplay.witness.requestDigest
      !== writeSpawnWitnessBeforeReplay.witness.requestDigest
    || writeSpawnWitnessAfterReplay.witness.idempotencyKeyDigest
      !== writeSpawnWitnessBeforeReplay.witness.idempotencyKeyDigest
    || Date.parse(writeSpawnWitnessAfterReplay.witness.recordedAt)
      < Date.parse(writeSpawnWitnessBeforeReplay.witness.recordedAt)
    || !executionRootAfterReplay.isDirectory()
    || executionRootAfterReplay.isSymbolicLink()
    || providerGenerationDelta !== 0
    || primaryTurnAdmissionDelta !== 0
    || !sameJson(
      replayedPrimaryTurnAdmissionKeys,
      primaryTurnAdmissionKeys
    )
    || worktreeIdentityChanged
    || context.guard.loadProviderGuard(fixtureRoot, workerId) !== null
  ) {
    fail("E_PRIVATE_STATE");
  }
  await waitForWriteSmokeProcessClosure(
    context,
    workerId,
    retainedProviderIdentities
  );
  context.workerWorktree.assertParentUnchanged(parentBefore, fixtureRoot);

  enterQualificationStage("write-smoke-artifact-replay");
  const metadataReplay = await callTool(
    context,
    client,
    "worker_artifact",
    { id: workerId, part: "metadata" },
    ["artifact"]
  );
  const contentReplay = await callTool(
    context,
    client,
    "worker_artifact",
    { id: workerId, part: "content" },
    ["artifact"]
  );
  const patchReplay = await callTool(
    context,
    client,
    "worker_artifact",
    { id: workerId, part: "patch" },
    ["artifact"]
  );
  if (
    !sameJson(metadataReplay, metadata)
    || !sameJson(contentReplay, content)
    || !sameJson(patchReplay, patch)
    || canonicalDigest(
      context.state.readJob(fixtureRoot, workerId, context.env)
    ) !== terminalJobDigestBeforeReplay
  ) {
    fail("E_PRIVATE_STATE");
  }

  enterQualificationStage("write-smoke-integration");
  const integrationArguments = {
    id: workerId,
    manifestDigest: metadata.artifact.manifestDigest,
    idempotencyKey: `installed-write-integrate-${crypto.randomUUID()}`
  };
  const integrated = await callTool(
    context,
    client,
    "worker_integrate",
    integrationArguments,
    ["receipt", "replayed"]
  );
  const integrationReceipt = integrated.receipt;
  if (
    integrated.replayed !== false
    || integrationReceipt?.workerId !== workerId
    || integrationReceipt?.manifestDigest !== metadata.artifact.manifestDigest
    || !/^[a-f0-9]{64}$/.test(integrationReceipt?.receiptDigest || "")
  ) {
    fail("E_SCENARIO");
  }
  const hostVerification =
    context.workerWorktree.verifyWriteVerticalIntegration({
      controlRoot: fixtureRoot,
      artifact: storedArtifact,
      parentFingerprint: parentBefore,
      expectedWorkerId: workerId
    });
  if (
    fs.readFileSync(path.join(fixtureRoot, "target.txt"), "utf8")
      !== expectedContent
    || hostVerification.manifestDigest !== metadata.artifact.manifestDigest
    || hostVerification.patchDigest !== metadata.artifact.patchDigest
    || hostVerification.contentDigest !== metadata.artifact.contentDigest
  ) {
    fail("E_SCENARIO");
  }

  enterQualificationStage("write-smoke-integration-reconnect");
  await closeMcp(context, client);
  client = await startInstalledMcp(context);
  await verifyMcpSurface(context, client);
  const integrationReplay = await callTool(
    context,
    client,
    "worker_integrate",
    integrationArguments,
    ["receipt", "replayed"]
  );
  if (
    integrationReplay.replayed !== true
    || !sameJson(integrationReplay.receipt, integrationReceipt)
  ) {
    fail("E_SCENARIO");
  }
  context.workerWorktree.verifyWriteVerticalIntegration({
    controlRoot: fixtureRoot,
    artifact: storedArtifact,
    parentFingerprint: parentBefore,
    expectedWorkerId: workerId
  });

  enterQualificationStage("write-smoke-production-cleanup");
  const cleanupArguments = {
    id: workerId,
    integrationReceiptDigest: integrationReceipt.receiptDigest,
    idempotencyKey: `installed-write-cleanup-${crypto.randomUUID()}`
  };
  const cleaned = await callTool(
    context,
    client,
    "worker_cleanup",
    cleanupArguments,
    ["receipt", "replayed"]
  );
  const cleanupReceipt = cleaned.receipt;
  if (
    cleaned.replayed !== false
    || cleanupReceipt?.workerId !== workerId
    || cleanupReceipt?.integrationReceiptDigest
      !== integrationReceipt.receiptDigest
    || !/^[a-f0-9]{64}$/.test(cleanupReceipt?.receiptDigest || "")
  ) {
    fail("E_SCENARIO");
  }

  enterQualificationStage("write-smoke-session-absence");
  const sessionPrincipal = Object.freeze({
    hostKind: "codex",
    threadId: context.threadId
  });
  for (let observation = 0; observation < 2; observation += 1) {
    const absent = await context.workerSessionLifecycle
      .inspectOwnedProviderSession({
        root: fixtureRoot,
        principal: sessionPrincipal,
        workerId,
        providerSessionId: terminalJob.grokSessionId,
        env: context.env
      });
    if (absent?.present !== false) fail("E_SESSION");
  }

  enterQualificationStage("write-smoke-cleanup-reconnect");
  await closeMcp(context, client);
  client = await startInstalledMcp(context);
  await verifyMcpSurface(context, client);
  const cleanupReplay = await callTool(
    context,
    client,
    "worker_cleanup",
    cleanupArguments,
    ["receipt", "replayed"]
  );
  if (
    cleanupReplay.replayed !== true
    || !sameJson(cleanupReplay.receipt, cleanupReceipt)
  ) {
    fail("E_SCENARIO");
  }

  enterQualificationStage("write-smoke-artifact-post-cleanup");
  const removedBeforeArtifactReplay =
    context.workerWorktree.classifyWorkerWorktreeEffect({
      controlRoot: fixtureRoot,
      executionRoot: expectedExecutionRoot,
      baseCommit: parentBefore.head,
      workerId,
      env: context.env
    });
  if (
    removedBeforeArtifactReplay.classification !== "absent"
    || fs.existsSync(expectedExecutionRoot)
  ) {
    fail("E_CLEANUP");
  }
  const metadataAfterCleanup = await callTool(
    context,
    client,
    "worker_artifact",
    { id: workerId, part: "metadata" },
    ["artifact"]
  );
  const contentAfterCleanup = await callTool(
    context,
    client,
    "worker_artifact",
    { id: workerId, part: "content" },
    ["artifact"]
  );
  const patchAfterCleanup = await callTool(
    context,
    client,
    "worker_artifact",
    { id: workerId, part: "patch" },
    ["artifact"]
  );
  if (
    !sameJson(metadataAfterCleanup, metadata)
    || !sameJson(contentAfterCleanup, content)
    || !sameJson(patchAfterCleanup, patch)
  ) {
    fail("E_PRIVATE_STATE");
  }

  enterQualificationStage("write-smoke-cleanup");
  await closeMcp(context, client);
  await waitForWriteSmokeProcessClosure(
    context,
    workerId,
    retainedProviderIdentities
  );
  if (context.guard.loadProviderGuard(fixtureRoot, workerId) !== null) {
    fail("E_CLEANUP");
  }
  const removed = context.workerWorktree.classifyWorkerWorktreeEffect({
    controlRoot: fixtureRoot,
    executionRoot: expectedExecutionRoot,
    baseCommit: parentBefore.head,
    workerId,
    env: context.env
  });
  if (
    removed.classification !== "absent"
    || fs.existsSync(expectedExecutionRoot)
  ) {
    fail("E_CLEANUP");
  }
  return Object.freeze({
    schemaVersion: 1,
    scenario: "official-grok-build-target-txt-write-smoke",
    workerId,
    status: result.worker.status,
    providerGeneration,
    reportSource: workerReport.reportSource,
    reportDigest: workerReport.reportDigest,
    nativeStructuredOutput: nativeStructuredReportProof,
    targetPath: metadata.artifact.path,
    baseCommit: metadata.artifact.baseCommit,
    manifestDigest: metadata.artifact.manifestDigest,
    patchDigest: metadata.artifact.patchDigest,
    contentDigest: metadata.artifact.contentDigest,
    parentFingerprintDigest: parentBefore.fingerprintDigest,
    parentUnchangedBeforeIntegration: true,
    integrationApplied: true,
    runnerDisposableWorktreeRemoved: true,
    runnerWorktreeRegistrationAbsent: true,
    productionIntegrationQualified: true,
    productionCleanupQualified: true,
    hostVerification: "passed",
    integrationReceiptDigest: integrationReceipt.receiptDigest,
    hostVerificationDigest: hostVerification.evidenceDigest,
    cleanupReceiptDigest: cleanupReceipt.receiptDigest,
    absenceProofDigest: cleanupReceipt.absenceProofDigest,
    spawnReplayProven: true,
    artifactReplayProven: true,
    artifactReplayAfterCleanupProven: true,
    spawnReplayNoDispatch: spawnReplay.providerLaunched === false,
    providerGenerationDelta,
    primaryTurnAdmissionDelta,
    worktreeIdentityChanged,
    integrationReplayProven: true,
    cleanupReplayProven: true,
    providerSessionAbsent: true
  });
}

async function runWriteCancellationScenario(baseContext, fixtureRoot) {
  const context = { ...baseContext, fixtureRoot, writeSmoke: true };
  context.runner.writeSmoke = { context, workerId: null };
  enterQualificationStage("write-cancel-fixture");
  initializeFixtureRepository(
    fixtureRoot,
    context.env,
    {
      writeTarget: true,
      workloadFiles: ACTIVE_WINDOW_WORKLOAD_FILES
    }
  );
  const parentBefore =
    context.workerWorktree.captureParentFingerprint(fixtureRoot);

  enterQualificationStage("write-cancel-mcp-surface");
  let client = await startInstalledMcp(context);
  await verifyMcpSurface(context, client, { negative: true });

  enterQualificationStage("write-cancel-spawn");
  const spawnArguments = {
    idempotencyKey:
      `installed-write-cancel-spawn-${crypto.randomUUID()}`,
    userRequest: [
      "Edit only target.txt in the current isolated worktree.",
      "Before editing target.txt, use read-only workspace tools to inspect every numbered file under qualification-workload in ascending order.",
      `Account for all ${ACTIVE_WINDOW_WORKLOAD_FILES} markers before any edit.`,
      "Only after that bounded inspection, replace target.txt with exactly the single line after followed by one newline.",
      "Do not commit and do not modify any other path.",
      "After editing, return the required structured worker report with only target.txt in changedFiles and AC-01 and AC-02 marked met."
    ].join(" ")
  };
  const spawned = await callTool(
    context,
    client,
    "worker_spawn_write",
    spawnArguments,
    [
      "worker",
      "replayed",
      "spawnSuccessDefinition",
      "providerLaunchState",
      "providerLaunched"
    ]
  );
  const workerId = spawned.worker?.id;
  if (
    typeof workerId !== "string"
    || spawned.worker?.write !== true
    || spawned.worker?.roleId !== "implementer"
    || spawned.replayed !== false
    || spawned.spawnSuccessDefinition !== "durable-job-commit"
    || spawned.providerLaunchState !== "not-ready"
    || spawned.providerLaunched !== false
  ) {
    fail("E_SCENARIO");
  }
  context.runner.writeSmoke.workerId = workerId;

  enterQualificationStage("write-cancel-dispatch");
  const initialPage = await callWriteSmokeWait(
    context,
    client,
    workerId,
    null,
    0
  );
  if (
    !isPlainRecord(initialPage.stream)
    || initialPage.stream.terminal !== false
    || !isPlainRecord(initialPage.stream.nextCursor)
    || initialPage.stream.nextCursor.workerId !== workerId
  ) {
    fail("E_SCENARIO");
  }
  let cursor = initialPage.stream.nextCursor;

  enterQualificationStage("write-cancel-live-provider");
  const activeBeforeReplay = await waitForActiveWriteProvider(
    context,
    workerId,
    parentBefore
  );
  const writeSpawnWitnessBeforeReplay = validateWriteSpawnResponseWitness(
    context,
    spawned.worker,
    activeBeforeReplay.job,
    spawnArguments.idempotencyKey,
    { replayed: false }
  );

  enterQualificationStage("write-cancel-reconnect");
  await closeMcp(context, client);
  client = await startInstalledMcp(context);
  await verifyMcpSurface(context, client, { negative: true });

  enterQualificationStage("write-cancel-spawn-replay");
  const spawnReplay = await callTool(
    context,
    client,
    "worker_spawn_write",
    spawnArguments,
    [
      "worker",
      "replayed",
      "spawnSuccessDefinition",
      "providerLaunchState",
      "providerLaunched"
    ]
  );
  if (
    spawnReplay.replayed !== true
    || spawnReplay.worker?.id !== workerId
    || !["queued", "running"].includes(spawnReplay.worker?.status)
    || spawnReplay.worker?.terminal !== false
    || spawnReplay.worker?.write !== true
    || spawnReplay.worker?.roleId !== "implementer"
    || spawnReplay.spawnSuccessDefinition !== "durable-job-commit"
    || spawnReplay.providerLaunchState !== "worktree-ready-no-dispatch"
    || spawnReplay.providerLaunched !== false
  ) {
    fail("E_SCENARIO");
  }
  const activeAfterReplay = observeActiveWriteProvider(
    context,
    workerId,
    parentBefore
  );
  const writeSpawnWitnessAfterReplay = validateWriteSpawnResponseWitness(
    context,
    spawnReplay.worker,
    activeAfterReplay.job,
    spawnArguments.idempotencyKey,
    { replayed: true, expectCurrentProjection: false }
  );
  const providerGenerationDelta =
    activeAfterReplay.identity.providerGeneration
    - activeBeforeReplay.identity.providerGeneration;
  const providerProcessIdentityChanged = !sameJson(
    activeAfterReplay.identity.providerProcess,
    activeBeforeReplay.identity.providerProcess
  );
  const worktreeIdentityChanged =
    activeAfterReplay.identity.executionRootDevice
      !== activeBeforeReplay.identity.executionRootDevice
    || activeAfterReplay.identity.executionRootInode
      !== activeBeforeReplay.identity.executionRootInode
    || !sameJson(
      activeAfterReplay.identity.managedWorktree,
      activeBeforeReplay.identity.managedWorktree
    );
  const runtimeIdentityChanged = !sameJson(
    activeAfterReplay.identity,
    activeBeforeReplay.identity
  );
  if (
    runtimeIdentityChanged
    || providerGenerationDelta !== 0
    || providerProcessIdentityChanged
    || worktreeIdentityChanged
    || writeSpawnWitnessAfterReplay.witness.responseSequence
      !== writeSpawnWitnessBeforeReplay.witness.responseSequence + 1
    || writeSpawnWitnessAfterReplay.witness.requestDigest
      !== writeSpawnWitnessBeforeReplay.witness.requestDigest
    || writeSpawnWitnessAfterReplay.witness.idempotencyKeyDigest
      !== writeSpawnWitnessBeforeReplay.witness.idempotencyKeyDigest
    || Date.parse(writeSpawnWitnessAfterReplay.witness.recordedAt)
      < Date.parse(writeSpawnWitnessBeforeReplay.witness.recordedAt)
  ) {
    fail("E_PRIVATE_STATE");
  }

  enterQualificationStage("write-cancel-request");
  const cancelArguments = {
    id: workerId,
    idempotencyKey:
      `installed-write-cancel-request-${crypto.randomUUID()}`
  };
  const cancelled = await callTool(
    context,
    client,
    "worker_cancel",
    cancelArguments,
    ["receipt", "replayed"]
  );
  const cancelReplay = await callTool(
    context,
    client,
    "worker_cancel",
    cancelArguments,
    ["receipt", "replayed"]
  );
  if (
    cancelled.replayed !== false
    || cancelReplay.replayed !== true
    || !sameJson(cancelled.receipt, cancelReplay.receipt)
    || cancelled.receipt?.workerId !== workerId
    || cancelled.receipt?.idempotencyKeyDigest
      !== crypto
        .createHash("sha256")
        .update(cancelArguments.idempotencyKey)
        .digest("hex")
  ) {
    fail("E_SCENARIO");
  }

  enterQualificationStage("write-cancel-wait");
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS;
  let terminal = false;
  while (Date.now() < deadline) {
    const page = await callWriteSmokeWait(
      context,
      client,
      workerId,
      cursor,
      30_000
    );
    if (
      !isPlainRecord(page.stream)
      || typeof page.stream.terminal !== "boolean"
      || !isPlainRecord(page.stream.nextCursor)
      || page.stream.nextCursor.workerId !== workerId
    ) {
      fail("E_SCENARIO");
    }
    cursor = page.stream.nextCursor;
    if (page.stream.terminal) {
      terminal = true;
      break;
    }
  }
  if (!terminal) fail("E_SCENARIO");

  enterQualificationStage("write-cancel-result");
  const result = await callTool(
    context,
    client,
    "worker_result",
    { id: workerId },
    ["worker"]
  );
  const terminalJob = context.state.readJob(
    fixtureRoot,
    workerId,
    context.env
  );
  let projectedTerminal;
  try {
    context.mutation.assertDispatchContract(terminalJob);
    assertProviderPinPersistence(context, terminalJob, {
      requireCurrentIntent: true,
      requirePrimaryTurnAdmissions: true,
      requireWorktreeIntent: true
    });
    projectedTerminal = context.workerProtocol.projectWorkerSnapshot(
      terminalJob,
      {
        detail: true,
        trustHostAuthority: false
      }
    );
  } catch {
    fail("E_PRIVATE_STATE");
  }
  const cancellationEvents = (terminalJob.lifecycleEvents || [])
    .filter((event) => event?.type === "cancellation.requested");
  if (
    !sameJson(result.worker, projectedTerminal)
    || result.worker?.id !== workerId
    || result.worker?.write !== true
    || result.worker?.roleId !== "implementer"
    || result.worker?.status !== "cancelled"
    || result.worker?.phase !== "cancelled"
    || result.worker?.terminal !== true
    || result.worker?.result?.stopReason !== "cancelled"
    || result.worker?.result?.taskRuntimeCleaned !== true
    || terminalJob.status !== "cancelled"
    || terminalJob.result?.stopReason !== "cancelled"
    || terminalJob.result?.taskRuntimeCleaned !== true
    || terminalJob.result?.hostVerification !== "not_run"
    || Object.hasOwn(terminalJob.result || {}, "writeArtifact")
    || terminalJob.request?.spawn?.dispatch?.providerGeneration !== 1
    || cancellationEvents.length !== 1
  ) {
    fail("E_PRIVATE_STATE");
  }

  enterQualificationStage("write-cancel-runtime-cleanup");
  const retainedProviderIdentities = [
    activeBeforeReplay.identity.providerProcess
  ];
  await waitForWriteSmokeProcessClosure(
    context,
    workerId,
    retainedProviderIdentities,
    "cancelled"
  );
  if (context.guard.loadProviderGuard(fixtureRoot, workerId) !== null) {
    fail("E_CLEANUP");
  }
  context.workerWorktree.assertParentUnchanged(parentBefore, fixtureRoot);
  if (
    fs.readFileSync(path.join(fixtureRoot, "target.txt"), "utf8")
      !== "before\n"
  ) {
    fail("E_CLEANUP");
  }

  enterQualificationStage("write-cancel-production-cleanup");
  const cleanupArguments = {
    id: workerId,
    idempotencyKey:
      `installed-write-discard-cleanup-${crypto.randomUUID()}`
  };
  const cleaned = await callTool(
    context,
    client,
    "worker_cleanup",
    cleanupArguments,
    ["receipt", "replayed"]
  );
  const cleanupReceipt = cleaned.receipt;
  const cleanupReceiptChecks = {
    firstResponse: cleaned.replayed === false,
    workerBound: cleanupReceipt?.workerId === workerId,
    cleanupOperation: cleanupReceipt?.operation === "cleanup",
    absent: cleanupReceipt?.status === "absent",
    discarded: cleanupReceipt?.disposition === "discarded",
    cancelled: cleanupReceipt?.terminalStatus === "cancelled",
    noIntegration: cleanupReceipt?.integrationReceiptDigest === null,
    parentBound:
      cleanupReceipt?.parentFingerprintDigest
        === canonicalDigest(parentBefore),
    terminalEvidence: /^[a-f0-9]{64}$/.test(
      cleanupReceipt?.terminalEvidenceDigest || ""
    ),
    receiptDigest: /^[a-f0-9]{64}$/.test(
      cleanupReceipt?.receiptDigest || ""
    ),
    absenceProof: /^[a-f0-9]{64}$/.test(
      cleanupReceipt?.absenceProofDigest || ""
    )
  };
  if (Object.values(cleanupReceiptChecks).some((passed) => passed !== true)) {
    process.stderr.write(
      `Installed Worker MCP write-smoke diagnostic ${JSON.stringify({
        schemaVersion: 1,
        stage: "write-cancel-production-cleanup",
        checks: cleanupReceiptChecks
      })}\n`
    );
    fail("E_SCENARIO");
  }

  enterQualificationStage("write-cancel-session-absence");
  const sessionPrincipal = Object.freeze({
    hostKind: "codex",
    threadId: context.threadId
  });
  for (let observation = 0; observation < 2; observation += 1) {
    const absent = await context.workerSessionLifecycle
      .inspectOwnedProviderSession({
        root: fixtureRoot,
        principal: sessionPrincipal,
        workerId,
        providerSessionId: terminalJob.grokSessionId,
        env: context.env
      });
    if (absent?.present !== false) fail("E_SESSION");
  }

  enterQualificationStage("write-cancel-cleanup-reconnect");
  await closeMcp(context, client);
  client = await startInstalledMcp(context);
  await verifyMcpSurface(context, client, { negative: true });
  const cleanupReplay = await callTool(
    context,
    client,
    "worker_cleanup",
    cleanupArguments,
    ["receipt", "replayed"]
  );
  if (
    cleanupReplay.replayed !== true
    || !sameJson(cleanupReplay.receipt, cleanupReceipt)
  ) {
    fail("E_SCENARIO");
  }

  enterQualificationStage("write-cancel-cleanup");
  await closeMcp(context, client);
  await waitForWriteSmokeProcessClosure(
    context,
    workerId,
    retainedProviderIdentities,
    "cancelled"
  );
  if (context.guard.loadProviderGuard(fixtureRoot, workerId) !== null) {
    fail("E_CLEANUP");
  }
  const expectedExecutionRoot =
    context.workerWorktree.expectedWorkerWorktreeRoot(
      fixtureRoot,
      workerId,
      context.env
    );
  const removed = context.workerWorktree.classifyWorkerWorktreeEffect({
    controlRoot: fixtureRoot,
    executionRoot: expectedExecutionRoot,
    baseCommit: parentBefore.head,
    workerId,
    env: context.env
  });
  context.workerWorktree.assertParentUnchanged(parentBefore, fixtureRoot);
  if (
    removed.classification !== "absent"
    || fs.existsSync(expectedExecutionRoot)
    || fs.readFileSync(path.join(fixtureRoot, "target.txt"), "utf8")
      !== "before\n"
  ) {
    fail("E_CLEANUP");
  }
  return Object.freeze({
    workerId,
    status: result.worker.status,
    activeProviderObserved: true,
    spawnReplayProven: true,
    spawnReplayNoDispatch: spawnReplay.providerLaunched === false,
    providerGenerationDelta,
    providerProcessIdentityChanged,
    worktreeIdentityChanged,
    runtimeIdentityChanged,
    cancelReplayProven: true,
    taskRuntimeCleaned: true,
    parentUnchanged: true,
    artifactAbsent: true,
    cleanupDisposition: cleanupReceipt.disposition,
    cleanupReceiptDigest: cleanupReceipt.receiptDigest,
    terminalEvidenceDigest: cleanupReceipt.terminalEvidenceDigest,
    absenceProofDigest: cleanupReceipt.absenceProofDigest,
    cleanupReplayProven: true,
    providerSessionAbsent: true,
    worktreeAbsent: true
  });
}

async function runCancellationScenario(baseContext, fixtureRoot) {
  const context = { ...baseContext, fixtureRoot };
  const fixtureStatus = initializeFixtureRepository(
    fixtureRoot,
    context.env,
    { workloadFiles: ACTIVE_WINDOW_WORKLOAD_FILES }
  );
  const tracker = createTracker("mcp-restart-reconnect-cancellation", fixtureStatus);
  context.runner.trackers.push({ context, tracker });
  enterQualificationStage("cancellation-mcp-surface");
  let client = await startInstalledMcp(context);
  await verifyMcpSurface(context, client);
  enterQualificationStage("cancellation-spawn");
  const started = await beginScenario(
    context,
    tracker,
    client,
    `installed-cancel-spawn-${crypto.randomUUID()}`,
    "restart and cancellation",
    { activeWindow: true }
  );
  enterQualificationStage("cancellation-live-provider");
  await pollPrivateJob(
    context,
    tracker,
    (job) => (
      CANONICAL_UUID.test(job?.grokSessionId || "")
      && job?.providerProcess?.providerGeneration === 1
      && job?.controllerProcess?.pid > 0
      && job?.workerProcess?.pid > 0
    ),
    {
      timeoutMs: 120_000,
      requireLiveProvider: true,
      recordProviderObservation: true
    }
  );
  enterQualificationStage("cancellation-session-id");
  if (!tracker.sessionId) fail("E_SESSION");
  await waitForSessionPresence(context, tracker);

  enterQualificationStage("cancellation-reconnect");
  await closeMcp(context, client);
  tracker.calls.reconnect += 1;
  client = await startInstalledMcp(context);
  await verifyMcpSurface(context, client);
  enterQualificationStage("cancellation-replay");
  const replay = await callTool(
    context,
    client,
    "worker_spawn",
    started.spawnArguments,
    [
      "worker",
      "replayed",
      "spawnSuccessDefinition",
      "providerLaunchState",
      "providerLaunched"
    ]
  );
  tracker.calls.spawnReplay += 1;
  observePublicWorker(tracker, replay.worker);
  const replayJob = readPrivateJob(context, tracker, {
    requireLiveProvider: true,
    recordProviderObservation: true
  });
  assertPublicPrivateBinding(replay.worker, replayJob);
  recordPrivateIdentityObservation(
    context,
    tracker,
    replayJob,
    replay.worker,
    {
      spawnKey: tracker.spawnIdempotencyKey,
      replayed: true
    }
  );
  if (
    replay.worker.id !== tracker.workerId
    || replayJob.request?.spawn?.dispatch?.providerGeneration !== 1
  ) {
    fail("E_SCENARIO");
  }

  enterQualificationStage("cancellation-request");
  const cancelKey = `installed-cancel-request-${crypto.randomUUID()}`;
  tracker.cancelIdempotencyKey = cancelKey;
  const cancel = await callTool(
    context,
    client,
    "worker_cancel",
    { id: tracker.workerId, idempotencyKey: cancelKey },
    ["receipt", "replayed"]
  );
  tracker.calls.cancel += 1;
  tracker.observedCancellationReceiptIds.push(cancel.receipt?.receiptId);
  const cancelReplay = await callTool(
    context,
    client,
    "worker_cancel",
    { id: tracker.workerId, idempotencyKey: cancelKey },
    ["receipt", "replayed"]
  );
  tracker.calls.cancelReplay += 1;
  tracker.observedCancellationReceiptIds.push(cancelReplay.receipt?.receiptId);
  if (
    !sameJson(cancel.receipt, cancelReplay.receipt)
    || cancel.replayed !== false
    || cancelReplay.replayed !== true
    || cancel.receipt?.idempotencyKeyDigest
      !== crypto.createHash("sha256").update(cancelKey).digest("hex")
  ) {
    fail("E_SCENARIO");
  }

  enterQualificationStage("cancellation-wait");
  const terminalWaitCursor = await waitForTerminal(
    context,
    client,
    tracker,
    started.cursor
  );
  enterQualificationStage("cancellation-cleanup-private");
  const terminalJob = await proveTerminalCleanup(context, tracker, "cancelled");
  enterQualificationStage("cancellation-terminal-drain");
  const terminalStreamCursor = await drainTerminalEventStream(
    context,
    client,
    tracker,
    terminalWaitCursor,
    terminalJob
  );
  enterQualificationStage("cancellation-result");
  const result = await callTool(
    context,
    client,
    "worker_result",
    { id: tracker.workerId },
    ["worker"]
  );
  tracker.calls.result += 1;
  observeTerminalResultWorker(
    tracker,
    result.worker,
    terminalStreamCursor
  );
  await closeMcp(context, client);
  client = null;

  enterQualificationStage("cancellation-cleanup-snapshot");
  validateTerminalWorkerSnapshot(
    result.worker,
    tracker,
    terminalJob,
    "cancelled"
  );
  enterQualificationStage("cancellation-cleanup-events");
  assertTerminalEventHistory(
    context,
    tracker,
    result.worker,
    terminalJob,
    "cancelled"
  );
  enterQualificationStage("cancellation-cleanup-binding");
  assertPublicPrivateBinding(result.worker, terminalJob);
  enterQualificationStage("cancellation-cleanup-identity");
  recordPrivateIdentityObservation(
    context,
    tracker,
    terminalJob,
    result.worker,
    { terminal: true }
  );
  enterQualificationStage("cancellation-cleanup-report");
  const cancellationEvents = (terminalJob.lifecycleEvents || [])
    .filter((event) => event?.type === "cancellation.requested");
  if (
    terminalJob.result?.stopReason !== "cancelled"
    || cancellationEvents.length !== 1
    || terminalJob.request?.spawn?.dispatch?.providerGeneration !== 1
  ) {
    fail("E_SCENARIO");
  }
  await deleteAndProveSessionAbsent(context, tracker);

  const publicEvidence = {
    spawn: started.spawn,
    spawnReplay: replay,
    cancel,
    cancelReplay,
    terminalResult: result
  };
  enterQualificationStage("cancellation-contract");
  validateInstalledCancellationReplayScenario(publicEvidence);
  return { context, tracker, publicEvidence };
}

function privateObservationFor(tracker, temporaryRemoved) {
  const generationCount = tracker.scenarioId === "authenticated-completion" ? 1 : 2;
  const evidenceCount = tracker.scenarioId === "authenticated-completion" ? 2 : 3;
  const witnessCount = tracker.scenarioId === "authenticated-completion" ? 1 : 2;
  if (
    tracker.observedProviderGenerations.length < generationCount
    || tracker.observedProviderWorkerIds.length
      !== tracker.observedProviderGenerations.length
    || tracker.observedPublicWorkerDigests.length !== evidenceCount
    || tracker.observedPublicWorkerDigests.some(
      (digest) => !/^[0-9a-f]{64}$/.test(digest)
    )
    || tracker.observedSpawnResponseWitnesses.length !== witnessCount
    || (
      tracker.scenarioId === "authenticated-completion"
      && (
        !Array.isArray(tracker.mailboxMessageBindings)
        || tracker.mailboxMessageBindings.length !== 2
      )
    )
  ) {
    fail("E_PRIVATE_STATE");
  }
  const providerIdentity = tracker.processIdentities.get("provider");
  const providerLaunchCount = tracker.providerStartEvidence.size;
  const providerTerminalCount = providerIdentity
    && tracker.context.processControl.processGroupGone(providerIdentity) ? 1 : 0;
  return {
    scenarioId: tracker.scenarioId,
    observedPublicWorkerDigests: [
      ...tracker.observedPublicWorkerDigests
    ],
    observedSpawnResponseWitnesses: tracker.observedSpawnResponseWitnesses
      .map((witness) => structuredClone(witness)),
    installedWorkerBinding: {
      workerId: tracker.privateBinding?.workerId,
      createdAt: tracker.privateBinding?.createdAt,
      model: tracker.privateBinding?.model,
      effort: tracker.privateBinding?.effort,
      securityProfile: structuredClone(
        tracker.privateBinding?.securityProfile
      ),
      taskEnvelopeId: tracker.privateBinding?.taskEnvelopeId,
      taskEnvelopeDigest: tracker.privateBinding?.taskEnvelopeDigest,
      contextManifestId: tracker.privateBinding?.contextManifestId,
      contextDigest: tracker.privateBinding?.contextDigest,
      workspaceSnapshotDigest: tracker.privateBinding?.workspaceSnapshotDigest,
      controlWorkspaceId: tracker.privateBinding?.controlWorkspaceId,
      hostTaskBinding: tracker.privateBinding?.hostTaskBinding
    },
    observedWorkerIds: [...tracker.observedWorkerIds],
    observedTaskEnvelopeIds: [...tracker.observedTaskEnvelopeIds],
    observedContextManifestIds: [...tracker.observedContextManifestIds],
    observedProviderGenerations: [...tracker.observedProviderGenerations],
    observedProviderWorkerIds: [...tracker.observedProviderWorkerIds],
    observedCancellationReceiptIds: [...tracker.observedCancellationReceiptIds],
    spawnInvocationCount: tracker.calls.spawn + tracker.calls.spawnReplay,
    spawnReplayCount: tracker.calls.spawnReplay,
    providerLaunchCount,
    providerTerminalCount,
    workerTerminalCount: tracker.latestJob
      && ["completed", "cancelled"].includes(tracker.latestJob.status) ? 1 : 0,
    resultReadCount: tracker.calls.result,
    reconnectCount: tracker.calls.reconnect,
    cancelInvocationCount: tracker.calls.cancel + tracker.calls.cancelReplay,
    cancelReplayCount: tracker.calls.cancelReplay,
    uniqueCancelRequestCount: tracker.calls.cancel > 0 ? 1 : 0,
    cancellationEventCount: (tracker.latestJob?.lifecycleEvents || [])
      .filter((event) => event?.type === "cancellation.requested").length,
    duplicateLaunchCount: Math.max(0, providerLaunchCount - 1),
    mailboxMessageBindings: tracker.scenarioId === "authenticated-completion"
      ? tracker.mailboxMessageBindings.map((binding) => structuredClone(binding))
      : null,
    mailbox: tracker.scenarioId === "authenticated-completion"
      ? structuredClone(tracker.mailboxObservation)
      : null,
    workerHostVerification: "not_run",
    processGroupGone: Boolean(tracker.context)
      && [...tracker.processIdentities.values()]
        .every((identity) => tracker.context.processControl.processGroupGone(identity)),
    taskRuntimeCleaned: tracker.latestJob?.result?.taskRuntimeCleaned === true,
    providerGuardAbsent: tracker.providerGuardAbsent,
    runnerTemporaryArtifactsRemoved: temporaryRemoved,
    qualificationSessionDeleted: tracker.sessionDeleted
  };
}

async function terminateTrackedClients(runner) {
  let ok = true;
  for (const client of [...runner.clients]) {
    try {
      await client.terminate();
    } catch {
      ok = false;
    } finally {
      runner.clients.delete(client);
    }
  }
  return ok;
}

function writeEmergencyValidationMode(job) {
  const spawn = job?.request?.spawn || {};
  if (!Object.hasOwn(spawn, "dispatch")) return "pre-dispatch";
  return spawn.dispatch?.schemaVersion === 2 ? "dispatch" : "invalid";
}

function writeEmergencyRequiredKinds(job) {
  const spawn = job?.request?.spawn || {};
  return [...new Set([
    ["controller", job?.controllerProcess],
    ["controller", spawn.controllerCleanupProcess],
    ["worker", job?.workerProcess],
    ["worker", spawn.unsettledWorkerProcess],
    ["provider", job?.providerProcess]
  ]
    .filter(([, identity]) => identity?.startToken != null)
    .map(([kind]) => kind))];
}

function emergencySessionAction({
  deletionAcknowledged,
  observedPresent
}) {
  if (deletionAcknowledged === true) return "prove-absent";
  return observedPresent === false ? "adopt-absence" : "delete";
}

function emergencyCleanupSucceeded({
  clean,
  sessionCount,
  temporaryRootExists
}) {
  return clean === true
    && sessionCount === 0
    && temporaryRootExists === false;
}

function durableSessionDeletionAcknowledged(context, tracker) {
  let jobFile;
  try {
    jobFile = context.state.jobFileIfPresent(
      context.fixtureRoot,
      tracker.workerId,
      context.env
    );
  } catch {
    fail("E_CLEANUP");
  }
  if (!jobFile) return false;
  const registryFile = path.join(
    path.dirname(path.dirname(jobFile)),
    "owner-lifecycle",
    "registry.json"
  );
  let stat;
  try {
    stat = fs.lstatSync(registryFile);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    fail("E_CLEANUP");
  }
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.size < 2
    || stat.size > 2 * 1024 * 1024
    || (stat.mode & 0o077) !== 0
  ) {
    fail("E_CLEANUP");
  }
  const registry = safeParseJson(
    fs.readFileSync(registryFile, "utf8"),
    "E_CLEANUP"
  );
  const {
    registryDigest,
    ...registryBody
  } = registry || {};
  if (
    !hasExactKeys(registry, new Set([
      "schemaVersion",
      "records",
      "keys",
      "registryDigest"
    ]))
    || registry.schemaVersion !== 1
    || !isPlainRecord(registry.records)
    || !isPlainRecord(registry.keys)
    || registryDigest !== canonicalDigest(registryBody)
  ) {
    fail("E_CLEANUP");
  }
  const record = registry.records[tracker.workerId];
  if (!record) return false;
  const { recordDigest, ...recordBody } = record;
  const cleanup = record.cleanup;
  if (
    record.workerId !== tracker.workerId
    || record.controlWorkspaceId
      !== tracker.latestJob?.controlWorkspaceId
    || record.executionBindingDigest
      !== tracker.latestJob?.executionBinding?.bindingDigest
    || record.providerSessionId !== tracker.sessionId
    || recordDigest !== canonicalDigest(recordBody)
  ) {
    fail("E_CLEANUP");
  }
  if (cleanup === null) return false;
  if (
    !isPlainRecord(cleanup)
    || !Number.isSafeInteger(cleanup.sessionDeleteAttempts)
    || cleanup.sessionDeleteAttempts < 0
    || cleanup.sessionDeleteAttempts > 2
    || (
      cleanup.sessionDeletionDigest !== null
      && !/^[a-f0-9]{64}$/.test(cleanup.sessionDeletionDigest || "")
    )
    || (
      cleanup.receipt != null
      && cleanup.receipt.sessionDeletionDigest
        !== cleanup.sessionDeletionDigest
    )
  ) {
    fail("E_CLEANUP");
  }
  return /^[a-f0-9]{64}$/.test(cleanup.sessionDeletionDigest || "");
}

async function cleanupExactWorkerBoundary(
  runner,
  context,
  tracker,
  { write = false } = {}
) {
  let clean = true;
  let latest = null;
  const owned = new Map();
  const unsettled = new Map();
  const addOwned = (
    kind,
    identity,
    { durableProvisioningGuard = false } = {}
  ) => {
    if (!identity) return;
    try {
      context.processControl.assertCompleteDetachedOwnedIdentity(identity);
      if (
        identity.commandMarker !== tracker.workerId
        && !durableProvisioningGuard
      ) {
        clean = false;
        return;
      }
      owned.set(`${kind}:${identity.pid}:${identity.startToken}`, {
        kind,
        identity: structuredClone(identity)
      });
    } catch {
      clean = false;
    }
  };
  for (const [kind, identity] of tracker.processIdentities) {
    addOwned(kind, identity);
  }
  const addDurableDispatchWitness = (kind, identity) => {
    if (!identity) return;
    if (identity.startToken !== null) {
      addOwned(kind, identity);
      return;
    }
    unsettled.set(`${kind}:${identity.pid}:${identity.processGroupId}`, {
      kind,
      identity: structuredClone(identity)
    });
  };

  const bindObservedWriteSession = () => {
    if (!write || latest?.grokSessionId == null) return;
    if (
      !CANONICAL_UUID.test(latest.grokSessionId)
      || latest.request?.providerHomeId !== tracker.workerId
      || (
        tracker.sessionId
        && tracker.sessionId !== latest.grokSessionId
      )
    ) {
      clean = false;
      return;
    }
    tracker.sessionId = latest.grokSessionId;
    tracker.latestJob = latest;
    tracker.privateBinding ||= {
      lineageWorkerId: latest.request.providerHomeId
    };
    if (
      tracker.privateBinding.lineageWorkerId
        !== latest.request.providerHomeId
    ) {
      clean = false;
      return;
    }
    if (!runner.sessions.has(tracker.sessionId)) {
      runner.sessions.set(tracker.sessionId, null);
    }
    try {
      bindSessionBoundary(context, tracker);
      if (
        tracker.sessionDeleteAcknowledged !== true
        && durableSessionDeletionAcknowledged(context, tracker)
      ) {
        tracker.sessionDeleteAcknowledged = true;
      }
    } catch {
      clean = false;
    }
  };

  const collectLatest = () => {
    try {
      latest = context.state.tryReadJob(
        context.fixtureRoot,
        tracker.workerId,
        context.env
      );
    } catch {
      clean = false;
      return;
    }
    if (!latest) return;
    if (write) {
      const validationMode = writeEmergencyValidationMode(latest);
      let writeVerification;
      try {
        if (validationMode === "invalid") fail("E_CLEANUP");
        writeVerification = (
          validationMode === "dispatch"
            ? context.mutation.assertDispatchContract(latest)
            : context.mutation.assertWriteExecutionJob(
                latest,
                context.env
              )
        );
      } catch {
        latest = null;
        clean = false;
        return;
      }
      if (
        latest.id !== tracker.workerId
        || latest.write !== true
        || latest.host?.kind !== "codex"
        || latest.host?.sessionId !== context.threadId
        || latest.request?.spawn?.ownerThreadId !== context.threadId
      ) {
        latest = null;
        clean = false;
        return;
      }
      tracker.emergencyWriteValidationMode = validationMode;
      tracker.emergencyWriteVerification = writeVerification;
      tracker.latestJob = latest;
      bindObservedWriteSession();
    } else {
      try {
        latest = observePrivateJob(context, tracker, latest);
      } catch {
        latest = null;
        clean = false;
        return;
      }
    }
    for (const [kind, identity] of [
      ["controller", latest.controllerProcess],
      ["controller", latest.request?.spawn?.controllerCleanupProcess],
      ["worker", latest.workerProcess],
      ["worker", latest.request?.spawn?.unsettledWorkerProcess],
      ["provider", latest.providerProcess]
    ]) {
      addDurableDispatchWitness(kind, identity);
    }
    const admissions = latest.request?.spawn?.primaryTurnAdmissions;
    if (admissions != null && !isPlainRecord(admissions)) {
      clean = false;
      return;
    }
    for (const admission of Object.values(admissions || {})) {
      addOwned("worker", admission?.workerProcess);
      addOwned("provider", admission?.providerProcess);
    }
  };

  const discoverDetachedWorkerProcesses = () => {
    let listed;
    try {
      listed = context.processControl.runSystemPs([
        "-axo",
        "pid=,command="
      ]);
    } catch {
      clean = false;
      return;
    }
    if (
      listed?.status !== 0
      || listed?.signal
      || listed?.error
      || Buffer.byteLength(String(listed.stdout || ""), "utf8")
        > MAX_COMMAND_OUTPUT_BYTES
    ) {
      clean = false;
      return;
    }
    for (const line of String(listed.stdout || "").split("\n")) {
      const match = line.match(/^\s*(\d+)\s+([\s\S]+)$/);
      if (!match || !match[2].includes(tracker.workerId)) continue;
      const pid = Number(match[1]);
      const startToken = context.processControl.processStartToken(pid);
      if (!startToken) {
        clean = false;
        continue;
      }
      const identity = { pid, startToken, processGroupId: pid };
      let kind = null;
      try {
        context.processControl.assertCompleteDetachedOwnedIdentity(identity);
        for (const candidate of [
          "controller",
          "worker",
          "provider-bootstrap",
          "provider"
        ]) {
          if (
            context.processControl.identityMatches(
              identity,
              tracker.workerId,
              candidate
            )
          ) {
            kind = candidate;
            break;
          }
        }
      } catch {
        clean = false;
        continue;
      }
      if (!kind) {
        clean = false;
        continue;
      }
      addOwned(kind, identity);
    }
  };

  const collectAuthenticatedGuard = () => {
    let record;
    try {
      record = context.guard.loadProviderGuard(
        context.fixtureRoot,
        tracker.workerId
      );
    } catch {
      clean = false;
      return null;
    }
    if (!record) return null;
    if (!latest) {
      clean = false;
      return null;
    }
    let authenticated;
    try {
      authenticated = (
        write
        && tracker.emergencyWriteValidationMode === "pre-dispatch"
      )
        ? context.guard.assertWorktreeProvisioningGuardForJob(
            context.fixtureRoot,
            latest,
            record,
            { env: context.env }
          )
        : context.guard.assertProviderGuardForJob(
            context.fixtureRoot,
            latest,
            record,
            { expectedGeneration: record.providerGeneration }
          );
      context.processControl.assertCompleteDetachedOwnedIdentity(
        authenticated.providerProcess
      );
    } catch {
      clean = false;
      return null;
    }
    if (
      tracker.authenticatedGuard
      && !sameJson(tracker.authenticatedGuard, authenticated)
    ) {
      clean = false;
      return null;
    }
    tracker.authenticatedGuard ||= structuredClone(authenticated);
    addOwned(
      "provider",
      authenticated.providerProcess,
      {
        durableProvisioningGuard: Boolean(
          write
          && tracker.emergencyWriteValidationMode === "pre-dispatch"
        )
      }
    );
    return authenticated;
  };

  const terminateCollected = async () => {
    for (const markerKind of [
      "controller",
      "worker",
      "provider-bootstrap",
      "provider"
    ]) {
      for (const ownedProcess of owned.values()) {
        if (ownedProcess.kind !== markerKind) continue;
        const { identity } = ownedProcess;
        try {
          if (!context.processControl.processGroupGone(identity)) {
            await context.processControl.terminateOwnedProcess(
              identity,
              tracker.workerId,
              markerKind
            );
          }
          if (!context.processControl.processGroupGone(identity)) clean = false;
        } catch {
          clean = false;
        }
      }
    }
  };

  let stableClosureScans = 0;
  let previousClosureSignature = null;
  let provisioningGroupGone = true;
  let unsettledGroupsGone = true;
  for (let pass = 0; pass < 20; pass += 1) {
    collectLatest();
    discoverDetachedWorkerProcesses();
    collectAuthenticatedGuard();
    await terminateCollected();
    collectLatest();
    discoverDetachedWorkerProcesses();
    let authenticated = collectAuthenticatedGuard();
    await terminateCollected();

    const producerGroupsGone = [...owned.values()]
      .filter(({ kind }) => kind === "controller" || kind === "worker")
      .every(({ identity }) => (
        context.processControl.processGroupGone(identity)
      ));
    const allGroupsGone = [...owned.values()].every(({ identity }) => (
      context.processControl.processGroupGone(identity)
    ));
    try {
      unsettledGroupsGone = [...unsettled.values()].every(
        ({ identity }) => context.processControl.processGroupGone(identity)
      );
    } catch {
      unsettledGroupsGone = false;
      clean = false;
    }
    const provisioningProcess = (
      write
      && tracker.emergencyWriteValidationMode === "pre-dispatch"
    )
      ? tracker.emergencyWriteVerification
          ?.provisioningRuntime
          ?.intent
          ?.processIdentity
      : null;
    try {
      provisioningGroupGone = !provisioningProcess
        || context.processControl.processGroupGone(provisioningProcess);
    } catch {
      provisioningGroupGone = false;
      clean = false;
    }
    if (
      authenticated
      && producerGroupsGone
      && allGroupsGone
      && provisioningGroupGone
    ) {
      try {
        const current = context.guard.loadProviderGuard(
          context.fixtureRoot,
          tracker.workerId
        );
        if (!current || !sameJson(current, authenticated)) {
          clean = false;
        } else {
          context.guard.unregisterProviderGuard(
            context.fixtureRoot,
            tracker.workerId,
            authenticated,
            context.env
          );
          authenticated = null;
        }
      } catch {
        clean = false;
      }
    }
    let residualGuard = null;
    try {
      residualGuard = context.guard.loadProviderGuard(
        context.fixtureRoot,
        tracker.workerId
      );
    } catch {
      clean = false;
    }
    const closureSignature = JSON.stringify(canonicalJson({
      jobProcesses: {
        controller: latest?.controllerProcess || null,
        worker: latest?.workerProcess || null,
        provider: latest?.providerProcess || null
      },
      sessionId: latest?.grokSessionId || null,
      provisioningProcess,
      provisioningGroupGone,
      unsettled: [...unsettled.values()]
        .map(({ kind, identity }) => ({ kind, identity }))
        .sort((left, right) => (
          JSON.stringify(left).localeCompare(JSON.stringify(right))
        )),
      unsettledGroupsGone,
      residualGuard,
      owned: [...owned.values()]
        .map(({ kind, identity }) => ({ kind, identity }))
        .sort((left, right) => (
          JSON.stringify(left).localeCompare(JSON.stringify(right))
        ))
    }));
    if (
      producerGroupsGone
      && allGroupsGone
      && unsettledGroupsGone
      && provisioningGroupGone
      && residualGuard === null
    ) {
      stableClosureScans = closureSignature === previousClosureSignature
        ? stableClosureScans + 1
        : 1;
    } else {
      stableClosureScans = 0;
    }
    previousClosureSignature = closureSignature;
    if (stableClosureScans >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, STATE_POLL_MS));
  }
  if (
    stableClosureScans < 2
    || !unsettledGroupsGone
    || !provisioningGroupGone
    || [...owned.values()].some(
      ({ identity }) => !context.processControl.processGroupGone(identity)
    )
  ) {
    clean = false;
  }
  const observedKinds = new Set(
    [...owned.values()].map(({ kind }) => kind)
  );
  const requiredKinds = write
    ? (
        tracker.emergencyWriteValidationMode === "pre-dispatch"
          ? []
          : writeEmergencyRequiredKinds(latest)
      )
    : ["controller", "worker", "provider"];
  tracker.emergencySessionCleanupReady = (
    stableClosureScans >= 2
    && requiredKinds.every((kind) => observedKinds.has(kind))
    && [...unsettled.values()].every(
      ({ identity }) => context.processControl.processGroupGone(identity)
    )
    && [...owned.values()].every(
      ({ identity }) => context.processControl.processGroupGone(identity)
    )
  );
  tracker.emergencyLatestJob = latest;
  return clean;
}

function proveEmergencyWriteWorktreeAbsent(context, tracker) {
  const job = tracker.emergencyLatestJob;
  const baseCommit = job?.executionBinding?.baseCommit;
  if (
    !job
    || job.id !== tracker.workerId
    || job.write !== true
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseCommit || "")
  ) {
    return false;
  }
  let executionRoot;
  let effect;
  try {
    executionRoot = context.workerWorktree.expectedWorkerWorktreeRoot(
      context.fixtureRoot,
      tracker.workerId,
      context.env
    );
    if (job.executionBinding.expectedExecutionRoot !== executionRoot) {
      return false;
    }
    effect = context.workerWorktree.classifyWorkerWorktreeEffect({
      controlRoot: context.fixtureRoot,
      executionRoot,
      baseCommit,
      workerId: tracker.workerId,
      env: context.env
    });
    if (
      effect.classification === "exact-clean-registered"
      || effect.classification === "dirty"
    ) {
      context.workerWorktree.removeWorkerWorktree(
        executionRoot,
        context.fixtureRoot,
        tracker.workerId,
        context.env
      );
      effect = context.workerWorktree.classifyWorkerWorktreeEffect({
        controlRoot: context.fixtureRoot,
        executionRoot,
        baseCommit,
        workerId: tracker.workerId,
        env: context.env
      });
    }
  } catch {
    return false;
  }
  return (
    effect?.classification === "absent"
    && !fs.existsSync(executionRoot)
  );
}

async function observeEmergencySessionAbsence(
  context,
  tracker,
  timeoutMs
) {
  let absent = false;
  await runSessionCredentialTransaction(context, tracker, {
    mode: "observe",
    provePresent: async (environment) => {
      const binding = bindSessionBoundary(context, tracker);
      if (!exactPrivateAuthFile(binding)) fail("E_CLEANUP");
      let observed;
      try {
        observed = context.provider.inspectImportedSessionPresence(
          tracker.sessionId,
          context.providerBinary,
          binding.env,
          context.fixtureRoot
        );
      } finally {
        refreshSessionCredentialHandle(environment);
      }
      if (observed?.ok !== true) fail("E_SESSION");
      if (observed.present === true) return true;
      if (observed.present !== false) fail("E_SESSION");
      await proveSessionAbsentWithCredential(
        context,
        tracker,
        environment,
        timeoutMs
      );
      absent = true;
      return true;
    }
  });
  return absent;
}

async function deleteOrAdoptEmergencySessionAbsence(
  context,
  tracker
) {
  let action = emergencySessionAction({
    deletionAcknowledged: tracker.sessionDeleteAcknowledged,
    observedPresent: null
  });
  if (action !== "prove-absent") {
    const absent = await observeEmergencySessionAbsence(
      context,
      tracker,
      30_000
    );
    action = emergencySessionAction({
      deletionAcknowledged: false,
      observedPresent: !absent
    });
    if (action === "adopt-absence") {
      tracker.sessionDeleteAcknowledged = true;
      tracker.sessionDeleted = true;
      context.runner.sessions.delete(tracker.sessionId);
      return;
    }
  }
  await deleteAndProveSessionAbsent(context, tracker, {
    updateStage: false,
    timeoutMs: 30_000
  });
}

async function emergencyCleanup(runner) {
  let clean = await terminateTrackedClients(runner);
  if (runner.temporaryRemoved === true) {
    return emergencyCleanupSucceeded({
      clean,
      sessionCount: runner.sessions.size,
      temporaryRootExists: false
    });
  }
  if (
    runner.setupBoundary
    && !await cleanupSetupBoundary(
      runner.setupBoundary,
      { terminate: true, requireObservation: false }
    )
  ) {
    clean = false;
  }
  const writeEmergencyEntries = [];
  if (runner.writeSmoke?.context) {
    const { context } = runner.writeSmoke;
    const workerIds = new Set([
      ...(Array.isArray(runner.writeSmoke.workerIds)
        ? runner.writeSmoke.workerIds
        : []),
      ...(typeof runner.writeSmoke.workerId === "string"
        ? [runner.writeSmoke.workerId]
        : [])
    ]);
    try {
      const candidates = context.state.listJobsReadonly(
        context.fixtureRoot,
        context.env
      ).filter((job) => (
        job?.write === true
        && job?.host?.kind === "codex"
        && job?.host?.sessionId === context.threadId
      ));
      for (const candidate of candidates) workerIds.add(candidate.id);
    } catch {
      clean = false;
    }
    runner.writeSmoke.workerIds = [...workerIds];
    for (const workerId of workerIds) {
      const tracker = {
        workerId,
        processIdentities: new Map(),
        authenticatedGuard: null,
        latestJob: null,
        privateBinding: null,
        sessionId: null,
        sessionBoundary: null,
        sessionDeleteAcknowledged: false,
        sessionDeleted: false,
        emergencySessionCleanupReady: false
      };
      writeEmergencyEntries.push({ context, tracker });
      if (!await cleanupExactWorkerBoundary(
        runner,
        context,
        tracker,
        { write: true }
      )) {
        clean = false;
      }
    }
    runner.writeSmoke.emergencyTrackers = writeEmergencyEntries.map(
      ({ tracker }) => tracker
    );
  }
  for (const entry of [...runner.trackers].reverse()) {
    const { context, tracker } = entry;
    if (typeof tracker.workerId !== "string") {
      try {
        const candidates = context.state.listJobsReadonly(
          context.fixtureRoot,
          context.env
        ).filter((job) => (
          job?.host?.kind === "codex"
          && job?.host?.sessionId === context.threadId
        ));
        if (candidates.length === 1) tracker.workerId = candidates[0].id;
        else if (candidates.length > 1) clean = false;
      } catch {
        clean = false;
      }
    }
    if (typeof tracker.workerId !== "string") continue;
    if (!await cleanupExactWorkerBoundary(
      runner,
      context,
      tracker
    )) {
      clean = false;
    }
  }
  const emergencyEntries = [...runner.trackers, ...writeEmergencyEntries];
  if (runner.provider && runner.providerBinary) {
    for (const [sessionId] of [...runner.sessions]) {
      const entry = emergencyEntries.find(
        ({ tracker }) => tracker.sessionId === sessionId
      );
      if (!entry || entry.tracker.emergencySessionCleanupReady !== true) {
        clean = false;
        continue;
      }
      const { context, tracker } = entry;
      try {
        await deleteOrAdoptEmergencySessionAbsence(
          context,
          tracker
        );
      } catch {
        clean = false;
      }
    }
  } else if (runner.sessions.size > 0) {
    clean = false;
  }
  for (const { context, tracker } of writeEmergencyEntries) {
    if (
      tracker.emergencySessionCleanupReady !== true
      || !proveEmergencyWriteWorktreeAbsent(
        context,
        tracker
      )
    ) {
      clean = false;
    }
  }
  if (runner.temporaryRoot && fs.existsSync(runner.temporaryRoot)) {
    if (clean) {
      try {
        fs.rmSync(runner.temporaryRoot, { recursive: true, force: true });
        if (!fs.existsSync(runner.temporaryRoot)) {
          runner.temporaryRemoved = true;
        } else {
          clean = false;
        }
      } catch {
        clean = false;
      }
    }
  }
  return emergencyCleanupSucceeded({
    clean,
    sessionCount: runner.sessions.size,
    temporaryRootExists: Boolean(
      runner.temporaryRoot
      && fs.existsSync(runner.temporaryRoot)
    )
  });
}

function ensurePublicationDirectory(relativeDirectory, created) {
  const root = canonicalPath(ROOT, "Repository root");
  let current = root;
  for (const segment of relativeDirectory.split("/")) {
    if (
      !segment
      || segment === "."
      || segment === ".."
      || segment.includes("\\")
      || segment.includes("\0")
    ) {
      fail("E_RECEIPT");
    }
    const next = path.join(current, segment);
    try {
      fs.mkdirSync(next, { mode: 0o755 });
      created.push(next);
      fsyncDirectory(current);
      fsyncDirectory(next);
    } catch (error) {
      if (error?.code !== "EEXIST") fail("E_RECEIPT");
    }
    const stat = fs.lstatSync(next);
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || !isPathInside(root, fs.realpathSync(next))
    ) {
      fail("E_RECEIPT");
    }
    current = fs.realpathSync(next);
  }
  return current;
}

function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function publishReceipt(receipt) {
  const validation = validateLiveQualificationReceipt(receipt, {
    strict: true,
    root: ROOT
  });
  if (!validation.ok) fail("E_RECEIPT");
  const relativeDirectory = [
    LIVE_RECEIPT_ROOT,
    LIVE_RECEIPT_AUTHORITY_SYNTHETIC
  ].join("/");
  const fileName = [
    receipt.sourceInventoryDigest.slice(0, 16),
    receipt.receiptDigest.slice(0, 16)
  ].join("-") + ".json";
  const created = [];
  let publishedFile = null;
  let descriptor;
  let fileCreated = false;
  let publishedIdentity = null;
  try {
    const directory = ensurePublicationDirectory(relativeDirectory, created);
    publishedFile = path.join(directory, fileName);
    if (!isPathInside(ROOT, publishedFile)) fail("E_RECEIPT");
    descriptor = fs.openSync(
      publishedFile,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600
    );
    fileCreated = true;
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) fail("E_RECEIPT");
    publishedIdentity = { dev: opened.dev, ino: opened.ino };
    const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
    const buffer = Buffer.from(serialized, "utf8");
    if (buffer.length > MAX_RECEIPT_BYTES) fail("E_RECEIPT");
    let offset = 0;
    while (offset < buffer.length) {
      const written = fs.writeSync(
        descriptor,
        buffer,
        offset,
        buffer.length - offset
      );
      if (!Number.isSafeInteger(written) || written <= 0) fail("E_RECEIPT");
      offset += written;
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fsyncDirectory(directory);

    descriptor = fs.openSync(
      publishedFile,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const reopened = fs.fstatSync(descriptor);
    const stat = fs.lstatSync(publishedFile);
    if (
      !reopened.isFile()
      || reopened.dev !== publishedIdentity.dev
      || reopened.ino !== publishedIdentity.ino
      || !stat.isFile()
      || stat.isSymbolicLink()
      || stat.size !== buffer.length
      || stat.dev !== publishedIdentity.dev
      || stat.ino !== publishedIdentity.ino
      || !isPathInside(ROOT, fs.realpathSync(publishedFile))
    ) {
      fail("E_RECEIPT");
    }
    const reread = fs.readFileSync(descriptor, "utf8");
    fs.closeSync(descriptor);
    descriptor = null;
    if (reread !== serialized) fail("E_RECEIPT");
    const parsed = safeParseJson(reread, "E_RECEIPT");
    if (!sameJson(parsed, receipt)) fail("E_RECEIPT");
    const post = validateLiveQualificationReceipt(parsed, {
      strict: true,
      root: ROOT
    });
    if (!post.ok || parsed.receiptDigest !== receipt.receiptDigest) {
      fail("E_RECEIPT");
    }
    const finalStat = fs.lstatSync(publishedFile);
    if (
      !finalStat.isFile()
      || finalStat.isSymbolicLink()
      || finalStat.dev !== publishedIdentity.dev
      || finalStat.ino !== publishedIdentity.ino
    ) {
      fail("E_RECEIPT");
    }
  } catch (error) {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (publishedFile && fileCreated) {
      try {
        const current = fs.lstatSync(publishedFile);
        if (
          current.isFile()
          && !current.isSymbolicLink()
          && current.dev === publishedIdentity?.dev
          && current.ino === publishedIdentity?.ino
        ) {
          fs.unlinkSync(publishedFile);
          fsyncDirectory(path.dirname(publishedFile));
        }
      } catch {}
    }
    for (const directory of created.reverse()) {
      try {
        fs.rmdirSync(directory);
        fsyncDirectory(path.dirname(directory));
      } catch {}
    }
    if (error instanceof QualificationError) throw error;
    fail("E_RECEIPT");
  }
}

function buildReceipt({
  startedAt,
  endedAt,
  sourceIdentity,
  sourceDigest,
  phaseScopeDigest,
  pluginVersion,
  sourcePluginDigest,
  installedPluginDigest,
  installedFileCount,
  installedEntrypointDigest,
  providerCapabilityDigest,
  observedProviderCapabilities,
  providerBinaryDigest,
  providerVersion
}) {
  const config = LIVE_RECEIPT_AUTHORITY_CONFIG[LIVE_RECEIPT_AUTHORITY_SYNTHETIC];
  const receipt = {
    schemaVersion: LIVE_RECEIPT_SCHEMA_VERSION,
    producerId: LIVE_RECEIPT_PRODUCER_ID,
    producerVersion: LIVE_RECEIPT_PRODUCER_VERSION,
    manifestDigest: computeLiveReceiptManifestDigest(),
    authorityMode: LIVE_RECEIPT_AUTHORITY_SYNTHETIC,
    phase: config.phase,
    pluginVersion,
    headCommit: sourceIdentity.headCommit,
    headTree: sourceIdentity.headTree,
    sourceInventoryDigest: sourceDigest,
    phaseScopeDigest,
    repositoryBeforeDigest: sourceDigest,
    repositoryAfterDigest: sourceDigest,
    sourcePluginInventoryDigest: sourcePluginDigest,
    installedPluginInventoryDigest: installedPluginDigest,
    installedFileCount,
    installedEntrypointDigest,
    providerCapabilityDigest,
    observedProviderCapabilities: [...observedProviderCapabilities],
    observedToolIds: [...LIVE_RECEIPT_CAPABILITY_TOOL_IDS],
    providerBinaryDigest,
    providerVersion,
    providerRevision: `binary-sha256-${providerBinaryDigest}`,
    mcpProtocolVersion: LIVE_RECEIPT_MANIFEST.mcpProtocolVersion,
    codexBinaryDigest: null,
    codexVersion: null,
    codexModel: null,
    hostTaskDigest: null,
    installationMethod: "codex-local-plugin-cache",
    scenarios: config.scenarios.map((scenario) => ({ ...scenario })),
    outcome: "pass",
    startedAt,
    endedAt
  };
  receipt.receiptDigest = computeLiveQualificationReceiptDigest(receipt);
  return receipt;
}

async function qualify(
  runner,
  { writeSmoke = false, twoWriter = false } = {}
) {
  const writeLifecycle = writeSmoke || twoWriter;
  enterQualificationStage("source-boundary");
  const startedAt = new Date().toISOString();
  if (!isNonEvidenceTreeClean(ROOT)) fail("E_SOURCE");
  const sourceIdentity = gitIdentity(ROOT);
  if (sourceIdentity.cleanTreeAtVerification !== true) fail("E_SOURCE");
  const sourceDigest = computeInventoryDigest(ROOT, { includeEvidence: false });
  const phaseScopeDigest = computePhaseScopeDigest("1", ROOT);
  const sourceEntries = createPluginInventory(SOURCE_PLUGIN);
  const sourcePluginDigest = digestInventory(sourceEntries);
  const packageJson = safeParseJson(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
    "E_SOURCE"
  );
  const pluginManifest = safeParseJson(
    fs.readFileSync(path.join(SOURCE_PLUGIN, ".codex-plugin", "plugin.json"), "utf8"),
    "E_SOURCE"
  );
  if (
    typeof packageJson.version !== "string"
    || packageJson.version !== pluginManifest.version
  ) {
    fail("E_SOURCE");
  }

  const runnerBase = writeLifecycle ? privateLiveFixtureBase() : os.tmpdir();
  runner.temporaryRoot = fs.mkdtempSync(
    path.join(runnerBase, "grok-installed-worker-mcp-")
  );
  fs.chmodSync(runner.temporaryRoot, 0o700);
  const codexHome = path.join(runner.temporaryRoot, "codex-home");
  const pluginData = path.join(runner.temporaryRoot, "plugin-data");
  const setupFixture = path.join(runner.temporaryRoot, "setup-fixture");
  const completionFixture = path.join(runner.temporaryRoot, "completion-fixture");
  const cancellationFixture = path.join(runner.temporaryRoot, "cancellation-fixture");
  const writeSmokeFixture = path.join(runner.temporaryRoot, "write-smoke-fixture");
  const writeCancelFixture = path.join(runner.temporaryRoot, "write-cancel-fixture");
  const twoWriterFixture = path.join(runner.temporaryRoot, "two-writer-fixture");
  mkdirPrivate(codexHome);
  mkdirPrivate(pluginData);
  const threadId = crypto.randomUUID();
  if (!CANONICAL_UUID.test(threadId)) fail("E_MCP");
  const env = buildChildEnvironment({ codexHome, pluginData, threadId });
  initializeFixtureRepository(setupFixture, env);

  enterQualificationStage("private-install");
  const codexBinary = process.env.CODEX_BIN || "codex";
  runJson(codexBinary, ["plugin", "marketplace", "add", ROOT, "--json"], {
    cwd: ROOT,
    env,
    timeoutMs: 60_000,
    code: "E_INSTALL"
  });
  const installedPayload = runJson(
    codexBinary,
    ["plugin", "add", PLUGIN_ID, "--json"],
    {
      cwd: ROOT,
      env,
      timeoutMs: 60_000,
      code: "E_INSTALL"
    }
  );
  if (typeof installedPayload.installedPath !== "string") fail("E_INSTALL");
  const installedRoot = canonicalPath(
    installedPayload.installedPath,
    "Installed plugin root"
  );
  const cacheRoot = canonicalPath(
    path.join(codexHome, "plugins", "cache"),
    "Private Codex plugin cache"
  );
  if (
    !isPathInside(cacheRoot, installedRoot)
    || isPathInside(SOURCE_PLUGIN, installedRoot)
  ) {
    fail("E_INSTALL");
  }
  const listedPlugins = runJson(codexBinary, ["plugin", "list", "--json"], {
    cwd: ROOT,
    env,
    timeoutMs: 30_000,
    code: "E_INSTALL"
  });
  const installedRecord = listedPlugins.installed?.filter(
    (entry) => entry?.pluginId === PLUGIN_ID
  );
  if (
    !Array.isArray(installedRecord)
    || installedRecord.length !== 1
    || installedRecord[0].installed !== true
    || installedRecord[0].enabled !== true
    || installedRecord[0].version !== packageJson.version
  ) {
    fail("E_INSTALL");
  }
  const installedEntries = createPluginInventory(installedRoot);
  const installedPluginDigest = digestInventory(installedEntries);
  if (
    describeInventoryDifference(sourceEntries, installedEntries).length !== 0
    || installedPluginDigest !== sourcePluginDigest
  ) {
    fail("E_INSTALL");
  }
  const installedEntrypointDigest = digestRegularFile(
    path.join(installedRoot, "mcp", "server.mjs")
  );
  const sourceEntrypoint = sourceEntries.find(
    (entry) => entry.path === "mcp/server.mjs"
  );
  if (
    !sourceEntrypoint
    || sourceEntrypoint.sha256 !== installedEntrypointDigest
  ) {
    fail("E_INSTALL");
  }

  enterQualificationStage("installed-imports");
  const providerCapability = await importInstalled(
    installedRoot,
    "scripts/lib/provider-capability.mjs"
  );
  const providerExecutablePin = await importInstalled(
    installedRoot,
    "scripts/lib/provider-executable-pin.mjs"
  );
  const state = await importInstalled(installedRoot, "scripts/lib/state.mjs");
  const processControl = await importInstalled(
    installedRoot,
    "scripts/lib/process-control.mjs"
  );
  const guard = await importInstalled(
    installedRoot,
    "scripts/lib/recursion-guard.mjs"
  );
  const mutation = await importInstalled(
    installedRoot,
    "scripts/lib/worker-mutation.mjs"
  );
  const launchContract = await importInstalled(
    installedRoot,
    "scripts/lib/worker-launch-contract.mjs"
  );
  const provider = await importInstalled(
    installedRoot,
    "scripts/lib/grok-provider.mjs"
  );
  const profiles = await importInstalled(
    installedRoot,
    "scripts/lib/profiles.mjs"
  );
  const authority = await importInstalled(
    installedRoot,
    "scripts/lib/worker-authority.mjs"
  );
  const workerProtocol = await importInstalled(
    installedRoot,
    "scripts/lib/worker-protocol.mjs"
  );
  const workerWorktree = await importInstalled(
    installedRoot,
    "scripts/lib/worker-worktree.mjs"
  );
  const workerSessionLifecycle = await importInstalled(
    installedRoot,
    "scripts/lib/worker-session-lifecycle.mjs"
  );
  if (
    workerProtocol.MAX_LIFECYCLE_EVENTS
      !== MAX_TERMINAL_LIFECYCLE_EVENTS
  ) {
    fail("E_INSTALL");
  }
  const mailboxState = await importInstalled(
    installedRoot,
    "scripts/lib/worker-mailbox-state.mjs"
  );
  const broker = await importInstalled(installedRoot, "mcp/broker.mjs");

  enterQualificationStage("provider-setup");
  runner.setupBoundary = createSetupBoundary({
    fixtureRoot: setupFixture,
    pluginData,
    env,
    threadId,
    processControl,
    guard
  });
  enterQualificationStage("provider-setup-command");
  const setupJson = await runSetupJson(
    process.execPath,
    [path.join(installedRoot, "scripts", "grok-codex.mjs"), "setup", "--json"],
    {
      cwd: setupFixture,
      env,
      timeoutMs: 120_000,
      boundary: runner.setupBoundary,
      runner
    }
  );
  enterQualificationStage("provider-setup-cleanup");
  if (!await cleanupSetupBoundary(
    runner.setupBoundary,
    {
      terminate: false,
      requireObservation: setupCleanupRequiresObservation(setupJson)
    }
  )) {
    fail("E_CLEANUP");
  }
  enterQualificationStage("provider-setup-contract");
  let setup;
  try {
    setup = validateInstalledSetup(setupJson);
  } catch {
    fail("E_SETUP");
  }
  const setupFixtureStatus = runBounded("git", [
    "status", "--porcelain=v1", "-z", "--untracked-files=all"
  ], {
    cwd: setupFixture,
    env,
    requireSilentStderr: false,
    code: "E_SETUP"
  }).stdout;
  if (setupFixtureStatus !== "") fail("E_SETUP");

  enterQualificationStage("provider-discovery-poison");
  const discoveryPoison = poisonChildProviderDiscovery(env, runner.temporaryRoot);
  enterQualificationStage("provider-capability");
  const providerLaunchBinding =
    providerExecutablePin.readActiveProviderLaunchBinding({ env });
  if (!providerLaunchBinding) fail("E_CAPABILITY");
  const providerLaunchBindingDigest =
    providerExecutablePin.providerLaunchBindingDigest(providerLaunchBinding);
  const capability = providerCapability.readValidProviderCapabilityReceipt({ env });
  if (!capability) fail("E_CAPABILITY");
  let resolvedProviderPin;
  try {
    resolvedProviderPin = providerExecutablePin.resolveProviderExecutablePin(
      providerLaunchBinding,
      { env }
    );
  } catch {
    fail("E_CAPABILITY");
  }
  const providerIdentity = captureProviderFileIdentity(
    resolvedProviderPin.binary
  );
  validateProviderCapabilityAgreement(capability, {
    setup,
    pluginVersion: packageJson.version,
    mcpCapabilityContractVersion: providerCapability.MCP_CAPABILITY_CONTRACT_VERSION,
    platform: process.platform,
    architecture: process.arch,
    providerLaunchBinding,
    providerLaunchBindingDigest,
    rootReadProfileDigest: profiles.profileFor("task", false).agentProfileDigest,
    observedAt: Date.now()
  });
  if (
    Object.hasOwn(setup.grok, "binary")
    || JSON.stringify(setup).includes(providerIdentity.path)
    || JSON.stringify(capability).includes(providerIdentity.path)
    || Object.hasOwn(capability, "providerFileIdentity")
    || setup.grok.version !== resolvedProviderPin.executableIdentity.version
    || providerIdentity.contentDigest
      !== resolvedProviderPin.executableIdentity.executableDigest
    || providerLaunchBinding.executableIdentityDigest
      !== resolvedProviderPin.executableIdentity.identityDigest
    || providerLaunchBinding.releaseIdentityDigest
      !== resolvedProviderPin.executableIdentity.releaseIdentityDigest
    || capability.providerLaunchBindingDigest !== providerLaunchBindingDigest
    || !sameJson(capability.providerLaunchBinding, providerLaunchBinding)
    || capability.capabilities?.length !== 3
    || !sameJson(capability.capabilities, LIVE_RECEIPT_PROVIDER_CAPABILITIES)
    || capability.capabilities[0]
      !== providerCapability.ROOT_READ_PROVIDER_CAPABILITY
    || capability.capabilities[1]
      !== providerCapability.SAME_SESSION_READ_FOLLOWUP_PROVIDER_CAPABILITY
    || capability.capabilities[2]
      !== providerCapability.ORDERED_TURN_BOUNDARY_MAILBOX_PROVIDER_CAPABILITY
    || broker.DEFAULT_MCP_PROTOCOL_VERSION !== PROTOCOL_VERSION
    || broker.MCP_SERVER_NAME !== "grok-worker-broker"
    || broker.MCP_SERVER_VERSION
      !== providerCapability.MCP_CAPABILITY_CONTRACT_VERSION
    || !sameJson(
      authority.CODEX_MCP_EXPERIMENTAL_CAPABILITIES,
      EXPECTED_EXPERIMENTAL_CAPABILITIES
    )
  ) {
    fail("E_CAPABILITY");
  }

  runner.provider = provider;
  runner.providerBinary = providerIdentity.path;
  const baseContext = {
    runner,
    env,
    discoveryPoison,
    threadId,
    installedRoot,
    providerCapability: capability,
    providerCapabilityModule: providerCapability,
    providerExecutablePin,
    providerLaunchBinding,
    providerLaunchBindingDigest,
    providerExecutableIdentityDigest:
      resolvedProviderPin.executableIdentity.identityDigest,
    providerReleaseIdentityDigest:
      resolvedProviderPin.executableIdentity.releaseIdentityDigest,
    providerBinary: providerIdentity.path,
    state,
    processControl,
    guard,
    mutation,
    launchContract,
    provider,
    workerProtocol,
    workerWorktree,
    workerSessionLifecycle,
    mailboxState,
    workerTools: writeLifecycle
      ? broker.WRITE_SMOKE_WORKER_TOOLS
      : broker.WORKER_TOOLS,
    defaultWorkerTools: broker.WORKER_TOOLS,
    serverVersion: broker.MCP_SERVER_VERSION,
    experimentalCapabilities: EXPECTED_EXPERIMENTAL_CAPABILITIES
  };
  if (writeLifecycle) {
    env.GROK_COMPANION_WRITE_SMOKE = broker.WRITE_SMOKE_ENV_VALUE;
    const runtime = broker.createMcpBrokerRuntime({
      env,
      providerCapabilityReceipt: capability
    });
    if (
      runtime.writeLifecycleCapabilityDigest == null
      || !/^[a-f0-9]{64}$/.test(runtime.writeLifecycleCapabilityDigest)
      || !sameJson(runtime.tools, broker.WRITE_SMOKE_WORKER_TOOLS)
    ) {
      fail("E_CAPABILITY");
    }
    baseContext.writeSmoke = true;
    baseContext.writeLifecycleCapabilityDigest =
      runtime.writeLifecycleCapabilityDigest;
    baseContext.pluginData = pluginData;
    const evidence = twoWriter
      ? await runTwoWriterScenario(baseContext, twoWriterFixture)
      : await runWriteSmokeScenario(baseContext, writeSmokeFixture);
    const cancellationEvidence = twoWriter
      ? null
      : await runWriteCancellationScenario(baseContext, writeCancelFixture);
    const pinnedEvidence = Object.freeze({
      ...evidence,
      ...(twoWriter ? {} : {
        activeWriteCancellationProven: true,
        writeCancellation: cancellationEvidence
      }),
      sourceHeadCommit: sourceIdentity.headCommit,
      sourceHeadTree: sourceIdentity.headTree,
      sourceInventoryDigest: sourceDigest,
      sourcePluginInventoryDigest: sourcePluginDigest,
      installedPluginInventoryDigest: installedPluginDigest,
      installedEntrypointDigest,
      providerVersion: capability.providerVersion,
      providerBinaryDigest: providerIdentity.contentDigest,
      providerCapabilityDigest: capability.capabilityDigest,
      providerPinRef: providerLaunchBinding.pinRef,
      providerLaunchBindingDigest,
      providerExecutableIdentityDigest:
        resolvedProviderPin.executableIdentity.identityDigest,
      providerReleaseIdentityDigest:
        resolvedProviderPin.executableIdentity.releaseIdentityDigest,
      ambientProviderDiscoveryPoisoned: true,
      writeLifecycleCapabilityDigest:
        runtime.writeLifecycleCapabilityDigest
    });
    if (!(await terminateTrackedClients(runner))) fail("E_CLEANUP");
    recheckProviderExecutablePin(baseContext, providerIdentity);
    const finalInstalledEntries = createPluginInventory(installedRoot);
    if (
      describeInventoryDifference(installedEntries, finalInstalledEntries).length
        !== 0
      || digestInventory(finalInstalledEntries) !== installedPluginDigest
      || digestRegularFile(path.join(installedRoot, "mcp", "server.mjs"))
        !== installedEntrypointDigest
    ) {
      fail("E_INSTALL");
    }
    const finalSourceIdentity = gitIdentity(ROOT);
    if (
      !isNonEvidenceTreeClean(ROOT)
      || finalSourceIdentity.cleanTreeAtVerification !== true
      || finalSourceIdentity.headCommit !== sourceIdentity.headCommit
      || finalSourceIdentity.headTree !== sourceIdentity.headTree
      || computeInventoryDigest(ROOT, { includeEvidence: false }) !== sourceDigest
      || digestInventory(createPluginInventory(SOURCE_PLUGIN))
        !== sourcePluginDigest
    ) {
      fail("E_SOURCE");
    }
    fs.rmSync(runner.temporaryRoot, { recursive: true, force: true });
    if (fs.existsSync(runner.temporaryRoot)) fail("E_CLEANUP");
    runner.temporaryRemoved = true;
    return pinnedEvidence;
  }
  const completion = await runCompletionScenario(baseContext, completionFixture);
  const cancellation = await runCancellationScenario(
    baseContext,
    cancellationFixture
  );

  enterQualificationStage("global-cleanup");
  if (!(await terminateTrackedClients(runner))) fail("E_CLEANUP");
  for (const { tracker } of [completion, cancellation]) {
    if (
      tracker.processIdentities.size !== 3
      || [...tracker.processIdentities.values()]
        .some((identity) => !processControl.processGroupGone(identity))
    ) {
      fail("E_CLEANUP");
    }
  }
  enterQualificationStage("installed-recheck");
  const finalInstalledEntries = createPluginInventory(installedRoot);
  const finalInstalledDigest = digestInventory(finalInstalledEntries);
  const finalInstalledEntrypointDigest = digestRegularFile(
    path.join(installedRoot, "mcp", "server.mjs")
  );
  const finalProviderIdentity = recheckProviderExecutablePin(
    baseContext,
    providerIdentity
  ).currentIdentity;
  if (
    describeInventoryDifference(installedEntries, finalInstalledEntries).length
      !== 0
    || describeInventoryDifference(sourceEntries, finalInstalledEntries).length
      !== 0
    || finalInstalledDigest !== installedPluginDigest
    || finalInstalledDigest !== sourcePluginDigest
    || finalInstalledEntries.length !== installedEntries.length
    || finalInstalledEntrypointDigest !== installedEntrypointDigest
    || !sameJson(finalProviderIdentity, providerIdentity)
  ) {
    fail("E_INSTALL");
  }
  fs.rmSync(runner.temporaryRoot, { recursive: true, force: true });
  if (fs.existsSync(runner.temporaryRoot)) fail("E_CLEANUP");
  runner.temporaryRemoved = true;

  enterQualificationStage("evidence-binding");
  for (const completed of [completion, cancellation]) {
    completed.tracker.context = completed.context;
    const observation = privateObservationFor(completed.tracker, true);
    validateInstalledScenarioEvidence(completed.publicEvidence, observation);
  }

  const finalSourceIdentity = gitIdentity(ROOT);
  if (
    !isNonEvidenceTreeClean(ROOT)
    || finalSourceIdentity.cleanTreeAtVerification !== true
    || finalSourceIdentity.headCommit !== sourceIdentity.headCommit
    || finalSourceIdentity.headTree !== sourceIdentity.headTree
    || computeInventoryDigest(ROOT, { includeEvidence: false }) !== sourceDigest
    || computePhaseScopeDigest("1", ROOT) !== phaseScopeDigest
    || digestInventory(createPluginInventory(SOURCE_PLUGIN)) !== sourcePluginDigest
  ) {
    fail("E_SOURCE");
  }
  const endedAt = new Date().toISOString();
  const receipt = buildReceipt({
    startedAt,
    endedAt,
    sourceIdentity,
    sourceDigest,
    phaseScopeDigest,
    pluginVersion: packageJson.version,
    sourcePluginDigest,
    installedPluginDigest,
    installedFileCount: installedEntries.length,
    installedEntrypointDigest,
    providerCapabilityDigest: capability.capabilityDigest,
    observedProviderCapabilities: capability.capabilities,
    providerBinaryDigest: providerIdentity.contentDigest,
    providerVersion: capability.providerVersion
  });
  enterQualificationStage("receipt-publication");
  publishReceipt(receipt);
}

async function main() {
  const argv = process.argv.slice(2);
  if (
    argv.length === 2
    && ["--write-smoke", "--two-writer"].includes(argv[0])
    && (argv[1] === "--help" || argv[1] === "-h")
  ) {
    process.stdout.write(
      argv[0] === "--two-writer" ? TWO_WRITER_HELP : WRITE_SMOKE_HELP
    );
    return;
  }
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(HELP);
    return;
  }
  const writeSmoke = argv.length === 1 && argv[0] === "--write-smoke";
  const twoWriter = argv.length === 1 && argv[0] === "--two-writer";
  if (argv.length !== 0 && !writeSmoke && !twoWriter) fail("E_ARGUMENT");
  if (LIVE_GATES.some((name) => process.env[name] !== "1")) fail("E_GATE");
  if (
    (writeSmoke || twoWriter)
    && process.env.GROK_WORKER_WRITE_E2E !== "1"
  ) {
    fail("E_GATE");
  }
  if (
    twoWriter
    && process.env.GROK_WORKER_TWO_WRITER_E2E !== "1"
  ) {
    fail("E_GATE");
  }
  if (process.platform === "win32") fail("E_PLATFORM");

  const runner = {
    interrupted: false,
    temporaryRoot: null,
    temporaryRemoved: false,
    provider: null,
    providerBinary: null,
    setupBoundary: null,
    clients: new Set(),
    sessions: new Map(),
    turnIds: new Set(),
    trackers: [],
    writeSmoke: null
  };
  const interrupt = () => { runner.interrupted = true; };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const evidence = await qualify(runner, { writeSmoke, twoWriter });
    if (writeSmoke || twoWriter) {
      process.stdout.write(`${JSON.stringify(evidence)}\n`);
    } else {
      process.stdout.write(
        "Installed Worker MCP E2E passed; one provisional synthetic direct-MCP receipt was published.\n"
      );
    }
  } catch (error) {
    const originalCode = error instanceof QualificationError
      ? error.code
      : "E_SCENARIO";
    const originalStage = error instanceof QualificationError
      ? error.stage
      : qualificationStage;
    enterQualificationStage("emergency-cleanup");
    let cleanupOutcome = "proof-returned-false";
    try {
      cleanupOutcome = classifyInstalledWorkerMcpCleanupOutcome(
        await emergencyCleanup(runner)
      );
    } catch {
      cleanupOutcome = "cleanup-threw";
    }
    const selected = selectInstalledWorkerMcpFailure({
      originalCode,
      originalStage,
      cleanupOutcome
    }, QUALIFICATION_STAGES);
    throw new QualificationError(
      selected.code,
      selected.stage,
      selected.diagnostic
    );
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

const IS_MAIN = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_MAIN) {
  main().catch((error) => {
    process.stderr.write(
      formatInstalledWorkerMcpFailure(
        error instanceof QualificationError
          ? {
              code: error.code,
              stage: error.stage,
              diagnostic: error.diagnostic
            }
          : {
              code: "E_SCENARIO",
              stage: "startup",
              diagnostic: null
            },
        QUALIFICATION_STAGES
      )
    );
    process.exitCode = 1;
  });
}
