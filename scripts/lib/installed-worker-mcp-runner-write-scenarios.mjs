// Installed Worker MCP qualification domain. Keep import-time behavior inert.
import { ACTIVE_WINDOW_WORKLOAD_FILES, canonicalDigest, enterQualificationStage, fail, isPlainRecord, sameJson, SCENARIO_TIMEOUT_MS } from "./installed-worker-mcp-runner-core.mjs";
import { assertProviderPinPersistence, validateWriteSpawnResponseWitness } from "./installed-worker-mcp-runner-observation.mjs";
import { callTool, callWriteSmokeResult, callWriteSmokeWait, closeMcp, initializeFixtureRepository, startInstalledMcp, verifyMcpSurface } from "./installed-worker-mcp-runner-runtime.mjs";
import { validWriteSmokePrimaryTurnAdmission, waitForWriteSmokeProcessClosure } from "./installed-worker-mcp-runner-session-read.mjs";
import { observeActiveWriteProvider, waitForActiveWriteProvider } from "./installed-worker-mcp-runner-write-two.mjs";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function collectWriteSmokePrivateEvidence(options) {
  const {
    context, fixtureRoot, workerId, parentBefore, metadata,
    expectedContent, expectedContentDigest, result, patch
  } = options;
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
  const primaryTurnAdmissions = terminalJob.request?.spawn?.primaryTurnAdmissions;
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
      === context.mailboxState.stableDigest(generationOneAdmission?.workerProcess)
    && mailboxAttempt.providerProcessDigest
      === context.mailboxState.stableDigest(generationOneAdmission?.providerProcess)
    && mailboxAttempt.providerSessionDigest
      === context.mailboxState.stableDigest({
        providerSessionId: terminalJob.grokSessionId
      })
    && mailboxAttempt.providerCapabilityDigest
      === terminalJob.request?.spawn?.providerCapabilityDigest
    && mailboxAttempt.providerCapabilityDigest
      === context.writeLifecycleCapabilityDigest
    && mailboxAttempt.contextReceiptDigest
      === context.mailboxState.stableDigest(terminalJob.request?.contextReceipt)
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
  return {
    terminalJob, terminalBindingValid, terminalDispatch, providerGeneration,
    primaryTurnAdmissions, primaryTurnAdmissionKeys, generationOneAdmission,
    generationOneAdmissionValid, mailboxAttempt, mailboxMessages,
    mailboxBodiesAbsent, workerReport, nativeStructuredReportProof,
    expectedFinalReportDigest, mailboxProofValid, generationOneProof,
    generationTwoAdmission, generationTwoAdmissionValid, generationTwoProof,
    providerLifecycleProof, expectedExecutionRoot, managedIdentity, storedArtifact,
    expectedContent, expectedContentDigest, result, patch
  };
}

async function validateWriteSmokePrivateEvidence(options) {
  const {
    context, fixtureRoot, workerId, parentBefore, metadata, spawned,
    spawnArguments, terminalJob, terminalBindingValid, providerGeneration,
    primaryTurnAdmissions, primaryTurnAdmissionKeys, generationOneAdmission,
    generationOneAdmissionValid, mailboxAttempt, mailboxMessages,
    mailboxBodiesAbsent, workerReport, nativeStructuredReportProof,
    expectedFinalReportDigest, mailboxProofValid, generationOneProof,
    generationTwoAdmission, generationTwoAdmissionValid, generationTwoProof,
    providerLifecycleProof, expectedExecutionRoot, managedIdentity,
    storedArtifact, expectedContent, expectedContentDigest, result, patch
  } = options;
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
    || !sameJson(terminalJob.result?.providerClaims?.changedFiles, ["target.txt"])
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
        storedArtifactPatchBound: storedArtifact.patch === patch.artifact.payload,
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
  return {
    terminalJobDigestBeforeReplay,
    managedIdentityBeforeReplay,
    executionRootBeforeReplay,
    writeSpawnWitnessBeforeReplay,
    retainedProviderIdentities
  };
}

async function replayWriteSmokeSpawn(options) {
  let {
    context, fixtureRoot, client, workerId, spawnArguments, parentBefore,
    metadata, content, patch, providerGeneration, primaryTurnAdmissionKeys,
    terminalJob, expectedExecutionRoot, retainedProviderIdentities,
    terminalJobDigestBeforeReplay, writeSpawnWitnessBeforeReplay,
    executionRootBeforeReplay, managedIdentityBeforeReplay
  } = options;
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
    || !sameJson(replayedPrimaryTurnAdmissionKeys, primaryTurnAdmissionKeys)
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
    || canonicalDigest(context.state.readJob(fixtureRoot, workerId, context.env))
      !== terminalJobDigestBeforeReplay
  ) {
    fail("E_PRIVATE_STATE");
  }
  return {
    client,
    spawnReplay,
    providerGenerationDelta,
    primaryTurnAdmissionDelta,
    worktreeIdentityChanged
  };
}

async function integrateAndCleanupWriteSmoke(options) {
  let {
    context, fixtureRoot, client, workerId, metadata, content, patch,
    expectedContent, parentBefore, storedArtifact, terminalJob,
    expectedExecutionRoot
  } = options;
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
  return { client, integrationReceipt, hostVerification, cleanupReceipt };
}

export async function runWriteSmokeScenario(baseContext, fixtureRoot) {
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

  const privateEvidence = collectWriteSmokePrivateEvidence({
    context, fixtureRoot, workerId, parentBefore, metadata, expectedContent,
    expectedContentDigest, result, patch
  });
  const {
    providerGeneration,
    workerReport,
    nativeStructuredReportProof,
    expectedExecutionRoot
  } = privateEvidence;
  const replayBoundary = await validateWriteSmokePrivateEvidence({
    context, fixtureRoot, workerId, parentBefore, metadata, spawned,
    spawnArguments, ...privateEvidence
  });
  const { retainedProviderIdentities } = replayBoundary;

  const replay = await replayWriteSmokeSpawn({
    context, fixtureRoot, client, workerId, spawnArguments, parentBefore,
    metadata, content, patch, ...privateEvidence, ...replayBoundary
  });
  client = replay.client;
  const {
    spawnReplay, providerGenerationDelta, primaryTurnAdmissionDelta,
    worktreeIdentityChanged
  } = replay;

  const integration = await integrateAndCleanupWriteSmoke({
    context, fixtureRoot, client, workerId, metadata, content, patch,
    expectedContent, parentBefore, ...privateEvidence
  });
  client = integration.client;
  const { integrationReceipt, hostVerification, cleanupReceipt } = integration;

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

async function finishWriteCancellationScenario(options) {
  let {
    context, fixtureRoot, client, workerId, cursor, activeBeforeReplay,
    parentBefore, spawnReplay, providerGenerationDelta,
    providerProcessIdentityChanged, worktreeIdentityChanged,
    runtimeIdentityChanged
  } = options;
  enterQualificationStage("write-cancel-request");
  const cancelArguments = {
    id: workerId,
    idempotencyKey: `installed-write-cancel-request-${crypto.randomUUID()}`
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
      { detail: true, trustHostAuthority: false }
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
    fs.readFileSync(path.join(fixtureRoot, "target.txt"), "utf8") !== "before\n"
  ) {
    fail("E_CLEANUP");
  }

  enterQualificationStage("write-cancel-production-cleanup");
  const cleanupArguments = {
    id: workerId,
    idempotencyKey: `installed-write-discard-cleanup-${crypto.randomUUID()}`
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
      cleanupReceipt?.parentFingerprintDigest === canonicalDigest(parentBefore),
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

export async function runWriteCancellationScenario(baseContext, fixtureRoot) {
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

  return await finishWriteCancellationScenario({
    context, fixtureRoot, client, workerId, cursor, activeBeforeReplay,
    parentBefore, spawnReplay, providerGenerationDelta,
    providerProcessIdentityChanged, worktreeIdentityChanged,
    runtimeIdentityChanged
  });
}
