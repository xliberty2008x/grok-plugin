import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { CompanionError } from "../plugins/grok/scripts/lib/errors.mjs";
import { reconcileBrokerWorkers } from "../plugins/grok/scripts/lib/worker-recovery.mjs";
import {
  cancelWorker,
  persistCompletedWriteArtifact,
  settleStartedWorkerLoss,
  spawnReadOnlyWorker
} from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import { createWorkerService } from "../plugins/grok/scripts/lib/worker-service.mjs";
import { tryReadJob, updateJob } from "../plugins/grok/scripts/lib/state.mjs";
import {
  buildTaskEnvelope,
  captureContextManifest
} from "../plugins/grok/scripts/lib/task-contract.mjs";
import {
  captureTerminalEvidence,
  preferProvenTerminalSafetyPending,
  selectTaskTerminalError
} from "../plugins/grok/scripts/lib/task-terminal-evidence.mjs";
import { workspaceState } from "../plugins/grok/scripts/lib/workspace.mjs";

import { initRepo, tempDir } from "./helpers.mjs";

const THREAD_ID = "019f666a-6469-7cc1-9a8d-8c1adf61e103";
const OLD_TIMESTAMP = "2026-01-01T00:00:00.000Z";

function principal(root) {
  return {
    hostKind: "codex",
    threadId: THREAD_ID,
    turnId: "019f666e-4084-7902-8447-249f72043a37",
    source: "codex-mcp-stdio",
    pluginId: "grok@grok-companion",
    root,
    mutationCapable: true
  };
}

function envFor() {
  const pluginData = tempDir("grok-terminal-intent-data-");
  return {
    HOME: pluginData,
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_PLUGIN_DATA: pluginData
  };
}

function deadIdentity(pid, workerId, attemptId, { nonce, providerGeneration, dispatchFence = 1 } = {}) {
  return {
    pid,
    startToken: `gone-process-${pid}`,
    processGroupId: pid,
    commandMarker: workerId,
    dispatchAttemptId: attemptId,
    dispatchFence,
    ...(nonce ? { nonce } : {}),
    ...(providerGeneration ? { providerGeneration } : {})
  };
}

function registeredIntent(processKind, attemptId, fence = 1) {
  return {
    schemaVersion: 1,
    processKind,
    intentId: (processKind === "controller" ? "c" : "d").repeat(32),
    attemptId,
    fence,
    status: "registered",
    preparedAt: OLD_TIMESTAMP,
    updatedAt: OLD_TIMESTAMP,
    registeredAt: OLD_TIMESTAMP,
    noChildAt: null
  };
}

function providerStartedFixture(pendingTerminal) {
  const root = initRepo();
  const env = envFor();
  const admitted = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest: "Restore terminal intent", mode: "read" }),
    idempotencyKey: `spawn-terminal-intent-${pendingTerminal.status}-${pendingTerminal.phase}`,
    env
  });
  const workerId = admitted.handle.id;
  const attemptId = `${pendingTerminal.status[0] || "x"}`.repeat(32);
  const nonce = "a".repeat(32);
  const controllerProcess = deadIdentity(1_900_101, workerId, attemptId, { nonce });
  const workerProcess = deadIdentity(1_900_102, workerId, attemptId, { nonce });
  const providerProcess = deadIdentity(1_900_103, workerId, attemptId, { providerGeneration: 1 });

  updateJob(root, workerId, (job) => ({
    ...job,
    status: "running",
    phase: "cleanup-blocked",
    completedAt: null,
    summary: "Task finished, but transient runtime cleanup is incomplete.",
    error: {
      code: "E_STATE",
      message: "Task finished, but transient runtime cleanup is incomplete."
    },
    pendingTerminal,
    controllerProcess,
    workerProcess,
    providerProcess,
    workerAuthorization: null,
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        controllerSpawnIntent: registeredIntent("controller", attemptId),
        workerSpawnIntent: registeredIntent("worker", attemptId),
        consumedLaunchContractDigest: job.workerAuthorization.launchContractDigest,
        launchContractConsumedAt: OLD_TIMESTAMP,
        providerLaunchPending: false,
        providerLaunchInFlight: false,
        providerLaunchOutcome: "launched",
        providerLaunchCompletedAt: OLD_TIMESTAMP,
        dispatch: {
          ...job.request.spawn.dispatch,
          state: "provider-started",
          attemptId,
          fence: 1,
          lease: null,
          claimedAt: OLD_TIMESTAMP,
          controllerStartedAt: OLD_TIMESTAMP,
          workerStartedAt: OLD_TIMESTAMP,
          providerStartedAt: OLD_TIMESTAMP,
          providerGeneration: 1,
          nextProviderGeneration: null,
          updatedAt: OLD_TIMESTAMP
        }
      }
    },
    result: {
      ...(job.result || {}),
      hostVerification: "not_run",
      taskRuntimeCleaned: false,
      privacyWarning: "Transient task credentials remain."
    }
  }), env);

  return {
    root,
    env,
    workerId,
    attemptId,
    controllerProcess,
    workerProcess,
    providerProcess
  };
}

const terminalIntents = [
  {
    status: "completed",
    phase: "done",
    completedAt: "2026-07-22T10:00:00.000Z",
    error: null,
    summary: "Provider work completed"
  },
  {
    status: "cancelled",
    phase: "cancelled",
    completedAt: "2026-07-22T10:01:00.000Z",
    error: { code: "E_CANCELLED", message: "Cancellation completed by the worker." },
    summary: "Cancelled by request"
  },
  {
    status: "failed",
    phase: "failed",
    completedAt: "2026-07-22T10:02:00.000Z",
    error: {
      code: "E_PROVIDER_EXIT",
      message: "Provider returned a specific terminal failure.",
      details: { exitCode: 17 }
    },
    summary: "Specific provider failure"
  }
];

for (const intent of terminalIntents) {
  test(`provider-started recovery restores the exact ${intent.status} terminal intent`, {
    skip: process.platform === "win32"
  }, async () => {
    const fixture = providerStartedFixture(structuredClone(intent));
    const recovery = await reconcileBrokerWorkers({
      root: fixture.root,
      principal: principal(fixture.root),
      dispatchStartupGraceMs: 0,
      env: fixture.env
    });

    assert.equal(recovery.results.length, 1);
    assert.equal(recovery.results[0].action, "terminalized");
    assert.equal(recovery.results[0].reason, "pending-terminal-restored");
    const restored = tryReadJob(fixture.root, fixture.workerId, fixture.env);
    assert.equal(restored.status, intent.status);
    assert.equal(restored.phase, intent.phase);
    assert.equal(restored.completedAt, intent.completedAt);
    assert.equal(restored.summary, intent.summary);
    assert.deepEqual(restored.error, intent.error);
    assert.equal(restored.pendingTerminal, undefined);
    assert.equal(restored.result.taskRuntimeCleaned, true);
    assert.equal(Object.hasOwn(restored.result, "privacyWarning"), false);
    assert.equal(restored.result.runtimeEvidence.reconciler.replayedPrompt, false);
  });
}

test("terminal evidence requires valid pre- and post-context comparison authority", () => {
  const root = initRepo();
  const context = captureContextManifest(root);
  const envelope = buildTaskEnvelope({
    userRequest: "Require exact terminal comparison authority",
    mode: "read"
  });
  const job = (contextManifest, { omit = false } = {}) => ({
    request: {
      ...(!omit ? { contextManifest } : {}),
      envelope
    },
    commandOutcomes: []
  });
  const assertUnavailable = (evidence) => {
    assert.equal(evidence.finalObservationUnavailable, true);
    assert.equal(evidence.postContext, null);
    assert.equal(evidence.runtimeEvidence.executionStatus, "failed");
    assert.equal(
      Object.hasOwn(evidence.runtimeEvidence, "metadataCompletenessObservation"),
      false
    );
    const selected = selectTaskTerminalError(evidence);
    assert.equal(selected.code, "E_CONTEXT_DRIFT");
    assert.deepEqual(
      selected.details.reasons,
      ["[final-context-unavailable]"]
    );
  };

  assertUnavailable(captureTerminalEvidence(
    root,
    job(null, { omit: true }),
    "completed",
    { captureContext: () => context }
  ));
  assertUnavailable(captureTerminalEvidence(
    root,
    job({ ...context, digest: "0".repeat(64) }),
    "completed",
    { captureContext: () => context }
  ));
  assertUnavailable(captureTerminalEvidence(
    root,
    job(context),
    "completed",
    { captureContext: () => null }
  ));
  assertUnavailable(captureTerminalEvidence(
    root,
    job(context),
    "completed",
    {
      captureContext: () => ({
        ...context,
        manifestId: "ctx-000000000000000000000000"
      })
    }
  ));

  const captureFailure = captureTerminalEvidence(
    root,
    job(context),
    "completed",
    {
      captureContext() {
        throw new Error("private terminal capture failure /Users/alice/secret");
      }
    }
  );
  const incomplete = selectTaskTerminalError(captureFailure, {
    code: "E_PROCESS_IDENTITY",
    message: "kill EPERM",
    details: {
      secondaryDiagnostic: { code: "EPERM", message: "kill EPERM" }
    }
  });
  assert.equal(captureFailure.finalObservationUnavailable, true);
  assert.equal(captureFailure.runtimeEvidence.executionStatus, "failed");
  assert.deepEqual(captureFailure.runtimeEvidence.metadataCompletenessObservation, {
    schemaVersion: 1,
    complete: false,
    metadataComponents: ["contextCapture"]
  });
  assert.equal(incomplete.code, "E_CONTEXT_INCOMPLETE");
  assert.deepEqual(incomplete.details, {
    contextPhase: "terminal",
    metadataComponents: ["contextCapture"]
  });
  for (const priorCaptureSafety of [
    {
      code: "E_CONTEXT_DRIFT",
      message: "Previously proven context drift.",
      details: { reasons: ["[HEAD]"] }
    },
    {
      code: "E_SCOPE_VIOLATION",
      message: "Previously proven scope violation.",
      details: { paths: ["outside.txt"] }
    }
  ]) {
    assert.equal(
      selectTaskTerminalError(captureFailure, priorCaptureSafety),
      priorCaptureSafety
    );
  }
  assert.equal(JSON.stringify(captureFailure).includes("/Users/alice"), false);

  const typedCaptureFailure = captureTerminalEvidence(
    root,
    job(context),
    "completed",
    {
      captureContext() {
        throw new CompanionError(
          "E_CONTEXT_DRIFT",
          "typed private terminal capture failure /Users/alice/secret"
        );
      }
    }
  );
  const typedIncomplete = selectTaskTerminalError(typedCaptureFailure);
  assert.equal(typedCaptureFailure.finalObservationFailureKind, "contextCapture");
  assert.equal(typedIncomplete.code, "E_CONTEXT_INCOMPLETE");
  assert.deepEqual(typedIncomplete.details, {
    contextPhase: "terminal",
    metadataComponents: ["contextCapture"]
  });
  assert.equal(JSON.stringify(typedCaptureFailure).includes("/Users/alice"), false);

  const incompleteHook = path.join(root, ".git", "hooks", "issue55-terminal-oversize");
  fs.writeFileSync(incompleteHook, Buffer.alloc((4 * 1024 * 1024) + 1, 0x61));
  try {
    const incompleteEvidence = captureTerminalEvidence(
      root,
      job(context),
      "completed"
    );
    assert.deepEqual(
      incompleteEvidence.changedPaths,
      ["[GIT_METADATA_INCOMPLETE]"]
    );
    assert.deepEqual(incompleteEvidence.scopeViolations, []);
    assert.deepEqual(incompleteEvidence.runtimeEvidence.scopeViolations, []);
    const componentError = selectTaskTerminalError(incompleteEvidence);
    assert.equal(componentError.code, "E_CONTEXT_INCOMPLETE");
    assert.deepEqual(componentError.details, {
      contextPhase: "terminal",
      metadataComponents: ["hooks"]
    });
  } finally {
    fs.unlinkSync(incompleteHook);
  }

  const stable = captureTerminalEvidence(
    root,
    job(context),
    "completed",
    { captureContext: () => context }
  );
  assert.equal(stable.finalObservationUnavailable, false);
  assert.equal(stable.postContext.manifestId, context.manifestId);
  assert.deepEqual(stable.changedPaths, []);
  assert.deepEqual(stable.scopeViolations, []);
  assert.equal(stable.runtimeEvidence.executionStatus, "completed");
  assert.equal(selectTaskTerminalError(stable), null);
  const recoveredTransient = selectTaskTerminalError(stable, {
    code: "E_CONTEXT_INCOMPLETE",
    message: "Git execution context could not be observed completely.",
    details: {
      contextPhase: "terminal",
      metadataComponents: ["hooks"]
    }
  });
  assert.equal(recoveredTransient.code, "E_CONTEXT_INCOMPLETE");
  assert.deepEqual(recoveredTransient.details, {
    contextPhase: "terminal",
    metadataComponents: ["hooks"]
  });
});

test("legacy unavailable terminal evidence without a failure kind remains context drift", () => {
  const selected = selectTaskTerminalError({
    finalObservationUnavailable: true,
    changedPaths: [],
    scopeViolations: [],
    runtimeEvidence: {
      observedChangedPaths: [],
      scopeViolations: []
    }
  });
  assert.equal(selected.code, "E_CONTEXT_DRIFT");
  assert.deepEqual(selected.details.reasons, ["[final-context-unavailable]"]);
});

test("terminal safety precedence preserves proven drift and scope over incompleteness", () => {
  const processUncertainty = {
    code: "E_PROCESS_IDENTITY",
    message: "Verified owned process signalling could not be completed.",
    details: {
      secondaryDiagnostic: { code: "EPERM", message: "kill EPERM" }
    }
  };
  const evidence = ({ changedPaths, scopeViolations, components = ["refs"] }) => ({
    finalObservationUnavailable: false,
    changedPaths,
    scopeViolations,
    runtimeEvidence: {
      observedChangedPaths: changedPaths,
      scopeViolations,
      metadataCompletenessObservation: {
        schemaVersion: 1,
        complete: false,
        metadataComponents: components
      }
    }
  });

  const drift = selectTaskTerminalError(evidence({
    changedPaths: ["[HEAD]", "[GIT_METADATA_INCOMPLETE]"],
    scopeViolations: ["outside.txt", "[GIT_METADATA_INCOMPLETE]"]
  }), null, processUncertainty);
  assert.equal(drift.code, "E_CONTEXT_DRIFT");
  assert.deepEqual(drift.details.reasons, ["[HEAD]"]);
  assert.equal(drift.details.secondaryDiagnostic.code, "EPERM");

  const scope = selectTaskTerminalError(evidence({
    changedPaths: ["outside.txt", "[GIT_METADATA_INCOMPLETE]"],
    scopeViolations: ["outside.txt", "[GIT_METADATA_INCOMPLETE]"]
  }), null, processUncertainty);
  assert.equal(scope.code, "E_SCOPE_VIOLATION");
  assert.deepEqual(scope.details.paths, ["outside.txt"]);
  assert.equal(scope.details.secondaryDiagnostic.code, "EPERM");

  const incomplete = selectTaskTerminalError(evidence({
    changedPaths: ["[GIT_METADATA_INCOMPLETE]"],
    scopeViolations: ["[GIT_METADATA_INCOMPLETE]"],
    components: ["hooks", "refs"]
  }), { code: "E_CANCELLED", message: "Cancelled." }, processUncertainty);
  assert.equal(incomplete.code, "E_CONTEXT_INCOMPLETE");
  assert.deepEqual(incomplete.details, {
    contextPhase: "terminal",
    metadataComponents: ["hooks", "refs"]
  });
  assert.equal(JSON.stringify(incomplete).includes("EPERM"), false);

  for (const prior of [
    {
      code: "E_CONTEXT_DRIFT",
      message: "Previously proven context drift.",
      details: { reasons: ["[HEAD]"] }
    },
    {
      code: "E_SCOPE_VIOLATION",
      message: "Previously proven scope violation.",
      details: { paths: ["outside.txt"] }
    }
  ]) {
    const selected = selectTaskTerminalError(evidence({
      changedPaths: ["[GIT_METADATA_INCOMPLETE]"],
      scopeViolations: ["[GIT_METADATA_INCOMPLETE]"],
      components: ["hooks"]
    }), prior, processUncertainty);
    assert.equal(selected, prior);
    assert.equal(selected.code, prior.code);
  }

  const priorPending = {
    status: "failed",
    phase: "context-rejected",
    completedAt: "2026-07-22T10:03:00.000Z",
    error: { code: "E_CONTEXT_DRIFT", message: "Previously proven context drift." }
  };
  const incompletePending = {
    status: "failed",
    phase: "context-rejected",
    completedAt: "2026-07-22T10:04:00.000Z",
    error: { code: "E_CONTEXT_INCOMPLETE", message: "Incomplete terminal context." }
  };
  const preserved = preferProvenTerminalSafetyPending(
    incompletePending,
    {
      ...priorPending,
      status: "completed",
      phase: "done",
      summary: "Provider claimed completion"
    }
  );
  assert.equal(preserved.status, "failed");
  assert.equal(preserved.phase, "context-rejected");
  assert.equal(preserved.completedAt, incompletePending.completedAt);
  assert.equal(preserved.error, priorPending.error);
  assert.equal(preserved.summary, priorPending.error.message);

  // The write-artifact boundary independently rejects an incoherent completed
  // envelope even if one reaches it from older durable state.
  assert.equal(persistCompletedWriteArtifact(
    { write: true },
    {
      status: "completed",
      phase: "done",
      completedAt: priorPending.completedAt,
      error: priorPending.error,
      summary: "Provider claimed completion"
    }
  ), null);
  const freshDriftPending = {
    ...incompletePending,
    error: { code: "E_CONTEXT_DRIFT", message: "Fresh final drift." }
  };
  assert.equal(
    preferProvenTerminalSafetyPending(freshDriftPending, priorPending),
    freshDriftPending
  );
});

test("provider-started recovery lets a cleanup signal failure outrank a completed intent", {
  skip: process.platform === "win32"
}, () => {
  const fixture = providerStartedFixture(structuredClone(terminalIntents[0]));
  updateJob(fixture.root, fixture.workerId, (job) => ({
    ...job,
    error: {
      code: "E_PROCESS_IDENTITY",
      message: "Worker recovery is blocked because exact runtime cleanup could not be verified.",
      details: {
        secondaryDiagnostic: {
          code: "EPERM",
          message: "kill EPERM"
        }
      }
    }
  }), fixture.env);

  const settled = settleStartedWorkerLoss({
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.attemptId,
    controllerProcess: fixture.controllerProcess,
    workerProcess: fixture.workerProcess,
    providerProcess: fixture.providerProcess,
    runtimeCleanup: { ok: true },
    env: fixture.env
  });

  assert.equal(settled.status, "failed");
  assert.equal(settled.phase, "failed");
  assert.equal(settled.error.code, "E_PROCESS_IDENTITY");
  assert.equal(settled.error.details.secondaryDiagnostic.code, "EPERM");
  assert.equal(settled.result.taskRuntimeCleaned, true);
  assert.equal(settled.progress.includes("pending"), false);
  assert.equal(settled.pendingTerminal, undefined);
});

test("provider-started read recovery lets final cleanup-time drift outrank a signal failure", {
  skip: process.platform === "win32"
}, () => {
  const fixture = providerStartedFixture(
    structuredClone(terminalIntents[0])
  );
  updateJob(fixture.root, fixture.workerId, (job) => ({
    ...job,
    error: {
      code: "E_PROCESS_IDENTITY",
      message: "Worker recovery is blocked because exact runtime cleanup could not be verified.",
      details: {
        secondaryDiagnostic: {
          code: "EPERM",
          message: "kill EPERM"
        }
      }
    }
  }), fixture.env);
  const configPath = path.join(fixture.root, ".git", "config");
  const configBefore = fs.readFileSync(configPath);
  let settled;
  try {
    settled = settleStartedWorkerLoss({
      root: fixture.root,
      workerId: fixture.workerId,
      attemptId: fixture.attemptId,
      controllerProcess: fixture.controllerProcess,
      workerProcess: fixture.workerProcess,
      providerProcess: fixture.providerProcess,
      runtimeCleanup: () => {
        fs.appendFileSync(
          configPath,
          "\n[grok-issue49-read-final]\n\tvalue = drift\n"
        );
        return { ok: true };
      },
      env: fixture.env
    });
  } finally {
    fs.writeFileSync(configPath, configBefore);
  }

  assert.equal(settled.status, "failed");
  assert.equal(settled.phase, "context-rejected");
  assert.equal(settled.error.code, "E_CONTEXT_DRIFT");
  assert.equal(
    settled.error.details.secondaryDiagnostic.code,
    "EPERM"
  );
  assert.ok(
    settled.result.runtimeEvidence.observedChangedPaths.includes(
      "[GIT_METADATA]"
    )
  );
  assert.equal(settled.result.runtimeEvidence.executionStatus, "failed");
  assert.equal(settled.result.taskRuntimeCleaned, true);
  assert.equal(settled.progress.includes("pending"), false);
  assert.ok(settled.completionContextManifest);
  assert.equal(settled.pendingTerminal, undefined);
});

test("broker recovery durably carries bounded signal evidence through a later retry", {
  skip: process.platform === "win32"
}, async () => {
  const fixture = providerStartedFixture(structuredClone(terminalIntents[0]));
  const first = await reconcileBrokerWorkers({
    root: fixture.root,
    principal: principal(fixture.root),
    dispatchStartupGraceMs: 0,
    testHooks: {
      beforeCleanupSignal() {
        throw new CompanionError(
          "E_PROCESS_IDENTITY",
          "Verified owned process signalling could not be completed.",
          {
            secondaryDiagnostic: {
              code: "EPERM",
              message: "kill EPERM"
            }
          }
        );
      }
    },
    env: fixture.env
  });
  assert.equal(first.results[0].action, "cleanup-blocked");
  const blocked = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  assert.equal(blocked.status, "running");
  assert.equal(blocked.phase, "cleanup-blocked");
  assert.equal(
    blocked.error.details.secondaryDiagnostic.code,
    "EPERM"
  );
  assert.equal(blocked.result.taskRuntimeCleaned, false);

  const genericallyBlocked = await reconcileBrokerWorkers({
    root: fixture.root,
    principal: principal(fixture.root),
    dispatchStartupGraceMs: 0,
    testHooks: {
      beforeCleanupSignal() {
        throw new CompanionError(
          "E_RUNTIME_CLEANUP",
          "Runtime cleanup remained incomplete."
        );
      }
    },
    env: fixture.env
  });
  assert.equal(genericallyBlocked.results[0].action, "cleanup-blocked");
  const stillBlocked = tryReadJob(
    fixture.root,
    fixture.workerId,
    fixture.env
  );
  assert.equal(
    stillBlocked.error.details.secondaryDiagnostic.code,
    "EPERM"
  );

  const retried = await reconcileBrokerWorkers({
    root: fixture.root,
    principal: principal(fixture.root),
    dispatchStartupGraceMs: 0,
    env: fixture.env
  });
  assert.equal(retried.results[0].action, "terminalized");
  const settled = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  assert.equal(settled.status, "failed");
  assert.equal(settled.error.code, "E_PROCESS_IDENTITY");
  assert.equal(settled.error.details.secondaryDiagnostic.code, "EPERM");
  assert.equal(settled.result.taskRuntimeCleaned, true);
  assert.equal(settled.progress.includes("pending"), false);
});

test("broker recovery does not promote a generic cleanup blocker over completed intent", {
  skip: process.platform === "win32"
}, async () => {
  const fixture = providerStartedFixture(structuredClone(terminalIntents[0]));
  const blocked = await reconcileBrokerWorkers({
    root: fixture.root,
    principal: principal(fixture.root),
    dispatchStartupGraceMs: 0,
    testHooks: {
      beforeCleanupSignal() {
        throw new CompanionError(
          "E_RUNTIME_CLEANUP",
          "Runtime cleanup remained incomplete."
        );
      }
    },
    env: fixture.env
  });
  assert.equal(blocked.results[0].action, "cleanup-blocked");
  const blockedJob = tryReadJob(
    fixture.root,
    fixture.workerId,
    fixture.env
  );
  assert.equal(blockedJob.status, "running");
  assert.equal(blockedJob.phase, "cleanup-blocked");
  assert.equal(blockedJob.error.code, "E_PROCESS_IDENTITY");
  assert.equal(blockedJob.error.details?.secondaryDiagnostic, undefined);

  const retried = await reconcileBrokerWorkers({
    root: fixture.root,
    principal: principal(fixture.root),
    dispatchStartupGraceMs: 0,
    env: fixture.env
  });
  assert.equal(retried.results[0].action, "terminalized");
  const settled = tryReadJob(
    fixture.root,
    fixture.workerId,
    fixture.env
  );
  assert.equal(settled.status, "completed");
  assert.equal(settled.phase, "done");
  assert.equal(settled.error, null);
  assert.equal(settled.summary, terminalIntents[0].summary);
  assert.equal(settled.result.taskRuntimeCleaned, true);
  assert.equal(settled.progress.includes("pending"), false);
  assert.equal(settled.pendingTerminal, undefined);
});

test("pending terminal settlement rejects missing controller proof or a changed provider identity", {
  skip: process.platform === "win32"
}, () => {
  const fixture = providerStartedFixture(structuredClone(terminalIntents[0]));
  const common = {
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.attemptId,
    workerProcess: fixture.workerProcess,
    runtimeCleanup: { ok: true },
    env: fixture.env
  };
  assert.throws(
    () => settleStartedWorkerLoss({
      ...common,
      providerProcess: fixture.providerProcess
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  assert.throws(
    () => settleStartedWorkerLoss({
      ...common,
      controllerProcess: fixture.controllerProcess,
      providerProcess: {
        ...fixture.providerProcess,
        pid: fixture.providerProcess.pid + 1,
        processGroupId: fixture.providerProcess.pid + 1
      }
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
  const before = JSON.stringify(tryReadJob(fixture.root, fixture.workerId, fixture.env));
  for (const [label, patch] of [
    ["controller fence", { controllerProcess: { ...fixture.controllerProcess, dispatchFence: 2 } }],
    ["controller nonce", { controllerProcess: { ...fixture.controllerProcess, nonce: "f".repeat(32) } }],
    ["worker fence", { workerProcess: { ...fixture.workerProcess, dispatchFence: 2 } }],
    ["worker nonce", { workerProcess: { ...fixture.workerProcess, nonce: "f".repeat(32) } }],
    ["provider marker", { providerProcess: { ...fixture.providerProcess, commandMarker: "task-foreign" } }],
    ["provider attempt", { providerProcess: { ...fixture.providerProcess, dispatchAttemptId: "f".repeat(32) } }],
    ["provider fence", { providerProcess: { ...fixture.providerProcess, dispatchFence: 2 } }],
    ["provider generation", { providerProcess: { ...fixture.providerProcess, providerGeneration: 2 } }]
  ]) {
    assert.throws(
      () => settleStartedWorkerLoss({
        ...common,
        controllerProcess: fixture.controllerProcess,
        providerProcess: fixture.providerProcess,
        ...patch
      }),
      (error) => error?.code === "E_PROCESS_IDENTITY",
      label
    );
    assert.equal(JSON.stringify(tryReadJob(fixture.root, fixture.workerId, fixture.env)), before, label);
  }
  assert.equal(tryReadJob(fixture.root, fixture.workerId, fixture.env).phase, "cleanup-blocked");
});

test("a stale recovery actor cannot clean a newly admitted same-lineage continuation", {
  skip: process.platform === "win32"
}, () => {
  const fixture = providerStartedFixture(structuredClone(terminalIntents[0]));
  const grokHome = path.join(
    workspaceState(fixture.root, fixture.env),
    "task-homes",
    fixture.workerId,
    ".grok"
  );
  const credential = path.join(grokHome, "auth.json");
  fs.mkdirSync(grokHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(credential, "{}\n", { mode: 0o600 });
  let cleanupCalls = 0;
  const cleanup = () => {
    cleanupCalls += 1;
    try { fs.unlinkSync(credential); } catch (error) { if (error.code !== "ENOENT") throw error; }
    return { ok: true };
  };
  const settlement = {
    root: fixture.root,
    workerId: fixture.workerId,
    attemptId: fixture.attemptId,
    controllerProcess: fixture.controllerProcess,
    workerProcess: fixture.workerProcess,
    providerProcess: fixture.providerProcess,
    runtimeCleanup: cleanup,
    env: fixture.env
  };

  const terminalJob = settleStartedWorkerLoss(settlement);
  assert.equal(terminalJob.status, "completed");
  assert.equal(cleanupCalls, 1);
  assert.equal(fs.existsSync(credential), false);

  const continuation = spawnReadOnlyWorker({
    root: fixture.root,
    principal: principal(fixture.root),
    envelope: buildTaskEnvelope({
      userRequest: "Continue after the recovered result",
      mode: "read"
    }),
    idempotencyKey: "terminal-cleanup-followup-0001",
    env: fixture.env
  });
  updateJob(fixture.root, continuation.handle.id, (job) => ({
    ...job,
    request: {
      ...job.request,
      providerHomeId: fixture.workerId
    }
  }), fixture.env);
  const child = tryReadJob(fixture.root, continuation.handle.id, fixture.env);
  assert.equal(child.request.providerHomeId, fixture.workerId);
  fs.writeFileSync(credential, "{\"continuation\":true}\n", { mode: 0o600 });

  // This models the loser of a two-reconciler race resuming from its stale
  // snapshot after the winner committed terminal state and admission created
  // the continuation. The cleanup callback must not run a second time.
  const replay = settleStartedWorkerLoss(settlement);
  assert.equal(replay.status, "completed");
  assert.equal(cleanupCalls, 1);
  assert.equal(fs.existsSync(credential), true);
});

function activeFixture(label) {
  const root = initRepo();
  const env = envFor();
  const admitted = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest: "Cancel active worker", mode: "read" }),
    idempotencyKey: `spawn-active-cancel-${label}`,
    env
  });
  updateJob(root, admitted.handle.id, (job) => ({
    ...job,
    status: "running",
    phase: "executing",
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        providerLaunchPending: false,
        providerLaunchInFlight: true,
        providerLaunchOutcome: "pending"
      }
    }
  }), env);
  return { root, env, workerId: admitted.handle.id };
}

test("active cancel ignores the obsolete signal hook and stays nonterminal", () => {
  const fixture = activeFixture("direct-0001");
  let signalCalls = 0;
  const cancelled = cancelWorker({
    root: fixture.root,
    principal: principal(fixture.root),
    workerId: fixture.workerId,
    idempotencyKey: "cancel-active-direct-0001",
    env: fixture.env,
    signalProcess: () => {
      signalCalls += 1;
      return { processGroupGone: true };
    }
  });

  assert.equal(signalCalls, 0);
  assert.equal(cancelled.receipt.status, "accepted");
  assert.equal(cancelled.receipt.processGroupGoneAt, null);
  assert.equal(cancelled.receipt.terminalRecordCommittedAt, null);
  const current = tryReadJob(fixture.root, fixture.workerId, fixture.env);
  assert.equal(current.status, "running");
  assert.equal(current.phase, "cancellation-requested");
});

test("WorkerService does not expose or forward caller process signaling authority", () => {
  const fixture = activeFixture("service-0001");
  let signalCalls = 0;
  const service = createWorkerService({
    root: fixture.root,
    principal: principal(fixture.root),
    env: fixture.env
  });
  const cancelled = service.cancel({
    id: fixture.workerId,
    idempotencyKey: "cancel-active-service-0001",
    signalProcess: () => {
      signalCalls += 1;
      return { processGroupGone: true };
    }
  });

  assert.equal(signalCalls, 0);
  assert.equal(cancelled.receipt.processGroupGoneAt, null);
  assert.equal(cancelled.receipt.terminalRecordCommittedAt, null);
  assert.equal(tryReadJob(fixture.root, fixture.workerId, fixture.env).status, "running");
});
