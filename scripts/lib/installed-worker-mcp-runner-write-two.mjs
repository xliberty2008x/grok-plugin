// Installed Worker MCP qualification domain. Keep import-time behavior inert.
import { ACTIVE_WINDOW_WORKLOAD_FILES, CANONICAL_UUID, canonicalDigest, checkInterrupted, enterQualificationStage, fail, isPlainRecord, sameJson, SCENARIO_TIMEOUT_MS, STATE_POLL_MS, TWO_WRITER_TOOLS } from "./installed-worker-mcp-runner-core.mjs";
import { assertProviderPinPersistence } from "./installed-worker-mcp-runner-observation.mjs";
import { callTool, callWriteSmokeResult, callWriteSmokeWait, closeMcp, createMetadata, initializeFixtureRepository, startInstalledMcp, verifyMcpSurface } from "./installed-worker-mcp-runner-runtime.mjs";
import { waitForWriteSmokeProcessClosure } from "./installed-worker-mcp-runner-session-read.mjs";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
export function observeActiveWriteProvider(
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

export async function waitForActiveWriteProvider(
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

export function twoWriterPrompt(label, exactLine) {
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

export function assertTwoWriterSpawn(spawned) {
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

export async function waitForConcurrentActiveWriteProviders(
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

export async function waitForWriteWorkerTerminal(
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

export async function readTwoWriterArtifact(
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

export function inspectTwoWriterTerminal(
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

export async function callTwoWriterPreview(
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

export async function callTwoWriterVerify(
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

export async function callExpectedTwoWriterConflict(
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

export async function assertOwnedWriteSessionAbsent(
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

async function finishTwoWriterScenario(options) {
  let {
    context, fixtureRoot, client, workerIds, artifacts, integrationReceipt,
    integrationArguments, cleanupArguments, abandonArguments, verification,
    cleanupReceipt, abandonReceipt, specifications, results, parentBefore,
    terminal, parentAfterA, readyPreviews, overlap, conflictPreview,
    rejectedIntegration
  } = options;
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
      integratedContentDigest: artifacts[0].metadata.artifact.contentDigest,
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

export async function runTwoWriterScenario(baseContext, fixtureRoot) {
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

  return await finishTwoWriterScenario({
    context, fixtureRoot, client, workerIds, artifacts, integrationReceipt,
    integrationArguments, cleanupArguments, abandonArguments, verification,
    cleanupReceipt, abandonReceipt, specifications, results, parentBefore,
    terminal, parentAfterA, readyPreviews, overlap, conflictPreview,
    rejectedIntegration
  });
}
