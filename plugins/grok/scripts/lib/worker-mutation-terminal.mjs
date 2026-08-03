/** Issue #56 worker-mutation terminal domain. */
import path from "node:path";
import { CompanionError, asErrorPayload } from "./errors.mjs";
import {
  generateId,
  isCancelRequested,
  now,
  readPrivateJsonFile,
  tryReadJob,
  writePrivateJsonFile,
  ensurePrivateStateDirectory,
  withWorkspaceStateTransaction
} from "./state.mjs";
import {
  assertContextCompatible,
  assertContextManifestIntegrity,
  captureContextManifest
} from "./task-context-manifest.mjs";
import {
  assertTaskEnvelope,
  bindTaskEnvelopeContext,
  buildTaskEnvelope,
  scrubStoredJob
} from "./task-envelope.mjs";
import { boundPathEvidence } from "./task-contract-primitives.mjs";
import {
  buildRuntimeEvidence,
  observeChangedPaths
} from "./task-runtime-evidence.mjs";
import { appendLifecycleEvent } from "./task-lifecycle.mjs";
import { processGroupGone, processStartToken } from "./process-control.mjs";
import {
  assertExactWriteVerticalScope,
  assertParentUnchanged,
  assertManagedWorkerWorktree,
  assertRegisteredWorkerWorktreeIdentity,
  assertTrackedWriteVerticalTarget,
  classifyWorkerWorktreeEffect,
  captureParentFingerprint,
  expectedWorkerWorktreeRoot,
  persistWriteWorkerArtifact
} from "./worker-worktree.mjs";
import {
  captureTerminalEvidence,
  normalizeTerminalProcessSignalError,
  selectTaskTerminalError,
  terminalTaskProgress
} from "./task-terminal-evidence.mjs";
import {
  DEFAULT_DISPATCH_LEASE_MS,
  WORKER_DISPATCH_OUTBOX_SCHEMA_VERSION,
  assertDispatchFence,
  assertDispatchV2,
  assertDispatchV2Structure,
  assertWorkerAuthorization,
  bindWorkerAuthorizationAttempt,
  createDispatchOutbox,
  createWorkerAuthorization,
  dispatchLeaseExpired,
  isDispatchV2,
  isSupportedWorkerDispatch,
  launchContractDigest,
  providerLaunchBindingForJob
} from "./worker-launch-contract.mjs";
import {
  assertDispatchContract,
  assertNoRecoveryCleanupFence,
  recoveryCleanupFenceMatches,
  terminalJob
} from "./worker-mutation-dispatch-contract.mjs";
import {
  currentOwnedProcessIdentity,
  isPlainRecord,
  runSuccessfulRuntimeCleanup,
  sameDispatchProcessIdentity,
  sameDispatchProcessWitness
} from "./worker-mutation-primitives.mjs";
import {
  captureManagedWritePostBindingContext,
  hasManagedWriteAuthority,
  hasManagedWritePostBinding
} from "./worker-mutation-spawn-authority.mjs";

export function cleanupSignalSecondaryDiagnostic(error) {
  const diagnostic = error?.code === "E_PROCESS_IDENTITY"
    && isPlainRecord(error.details?.secondaryDiagnostic)
    ? error.details.secondaryDiagnostic
    : null;
  if (!diagnostic) return null;
  const rawCode = String(diagnostic.code || "");
  if (rawCode.toUpperCase() === "ESRCH") return null;
  return Object.freeze({
    code: /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode)
      ? rawCode.slice(0, 64)
      : "UNKNOWN",
    message: String(
      diagnostic.message || "Process signalling failed."
    ).slice(0, 256)
  });
}

export function reconcileTerminalCleanupSignal(
  terminalIntent,
  cleanupError,
  { completedAt = now(), priorErrors = [] } = {}
) {
  const signalErrors = [
    terminalIntent?.error,
    ...(Array.isArray(priorErrors) ? priorErrors : []),
    cleanupError
  ]
    .map((error) => normalizeTerminalProcessSignalError(error))
    // E_PROCESS_IDENTITY is also the fail-closed code for several ownership
    // and runtime-cleanup blockers. Only a bounded secondary diagnostic proves
    // this record came from an actual non-ESRCH signal failure and may therefore
    // outrank the provider's prior terminal outcome.
    .filter((error) => (
      error?.code === "E_PROCESS_IDENTITY"
      && cleanupSignalSecondaryDiagnostic(error) !== null
    ));
  const signalError = signalErrors[0];
  if (!signalError) return terminalIntent;
  const secondaryDiagnostic =
    cleanupSignalSecondaryDiagnostic(signalError);
  if (["E_CONTEXT_DRIFT", "E_SCOPE_VIOLATION"].includes(
    terminalIntent?.error?.code
  )) {
    const priorDetails = isPlainRecord(terminalIntent.error.details)
      ? terminalIntent.error.details
      : {};
    return Object.freeze({
      ...terminalIntent,
      error: Object.freeze({
        ...terminalIntent.error,
        details: Object.freeze({
          ...priorDetails,
          ...(secondaryDiagnostic ? { secondaryDiagnostic } : {})
        })
      })
    });
  }
  const message = "Verified owned process signalling could not be completed.";
  return Object.freeze({
    status: "failed",
    phase: "failed",
    completedAt,
    error: Object.freeze({
      code: "E_PROCESS_IDENTITY",
      message,
      ...(secondaryDiagnostic
        ? { details: Object.freeze({ secondaryDiagnostic }) }
        : {})
    }),
    summary: message
  });
}

export function settleUnstartedDispatchLoss({
  root,
  workerId,
  attemptId,
  dispatchState,
  controllerProcess = null,
  controllerCleanupProcess = null,
  workerProcess = null,
  unsettledWorkerProcess = null,
  unsettledProviderProcess = null,
  cleanupFenceId = null,
  terminalIntent = null,
  runtimeCleanup,
  env = process.env
} = {}) {
  const explicitIntent = terminalIntent == null ? null : terminalIntent;
  if (!workerId
    || !attemptId
    || !["claimed", "controller-started", "worker-started"].includes(dispatchState)
    || (explicitIntent && (
      !["failed", "cancelled"].includes(explicitIntent.status)
      || typeof explicitIntent.phase !== "string"
      || !explicitIntent.error?.code
      || !explicitIntent.error?.message
    ))
    || (typeof runtimeCleanup !== "function" && typeof runtimeCleanup?.ok !== "boolean")) {
    throw new CompanionError("E_USAGE", "Dispatch loss settlement requires an exact attempt and cleanup outcome.");
  }
  const identityGone = (stored, expected) => Boolean(
    expected
    && sameDispatchProcessIdentity(stored, expected, { nonce: true })
    && processGroupGone(expected)
  );
  const stateMatches = (job) => {
    const dispatch = job.request?.spawn?.dispatch;
    if (!isSupportedWorkerDispatch(dispatch)
      || dispatch.attemptId !== attemptId
      || dispatch.state !== dispatchState
      || !recoveryCleanupFenceMatches(job, cleanupFenceId, [
        "controller-cleanup",
        "unsettled-worker",
        "provider-generation"
      ])) return false;
    const storedProvider = job.providerProcess?.pid ? job.providerProcess : null;
    if (storedProvider) {
      if (!unsettledProviderProcess
        || !sameDispatchProcessWitness(storedProvider, unsettledProviderProcess, {
          allowUnsettled: true
        })
        || !processGroupGone(unsettledProviderProcess)) return false;
    } else if (unsettledProviderProcess) return false;
    const storedControllerCleanup = job.request?.spawn?.controllerCleanupProcess || null;
    if (storedControllerCleanup) {
      if (!controllerCleanupProcess
        || !sameDispatchProcessWitness(storedControllerCleanup, controllerCleanupProcess, {
          nonce: true,
          allowUnsettled: true
        })
        || !processGroupGone(controllerCleanupProcess)) return false;
    } else if (controllerCleanupProcess) return false;
    if (dispatchState === "claimed") {
      const intent = job.request?.spawn?.controllerSpawnIntent;
      const spawnBoundaryProven = !intent
        || intent.status === "no-child"
        || Boolean(storedControllerCleanup);
      return !job.controllerProcess?.pid && !job.workerProcess?.pid && spawnBoundaryProven;
    }
    if (!identityGone(job.controllerProcess, controllerProcess)) return false;
    if (dispatchState === "controller-started") {
      const intent = job.request?.spawn?.workerSpawnIntent;
      const witness = job.request?.spawn?.unsettledWorkerProcess || null;
      const witnessMatches = witness
        ? Boolean(
            unsettledWorkerProcess
            && sameDispatchProcessWitness(witness, unsettledWorkerProcess, {
              nonce: true,
              allowUnsettled: true
            })
            && processGroupGone(unsettledWorkerProcess)
          )
        : !unsettledWorkerProcess;
      const spawnBoundaryProven = !intent
        || intent.status === "no-child"
        || Boolean(witness && witnessMatches);
      return !job.workerProcess?.pid && witnessMatches && spawnBoundaryProven;
    }
    return identityGone(job.workerProcess, workerProcess);
  };

  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    if (terminalJob(current)) return current;
    assertDispatchContract(current);
    if (!stateMatches(current)) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Dispatch loss no longer matches the exact durable process state.");
    }
    return transaction.updateJob(workerId, (latest) => {
      if (terminalJob(latest)) return latest;
      assertDispatchContract(latest);
      if (!stateMatches(latest)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Dispatch identity changed before loss settlement publication.");
      }
      // Runtime artifact deletion and terminal publication share the workspace
      // admission lock and this exact job lock. A stale reconciler therefore
      // cannot delete a newly admitted continuation's credential/profile after
      // another reconciler has already settled this dispatch.
      const completedCleanup = runSuccessfulRuntimeCleanup(runtimeCleanup, latest);
      const completedAt = now();
      const latestDispatch = latest.request.spawn.dispatch;
      const observed = reconcileCleanupSafeTerminalObservation(
        latest,
        explicitIntent || {
          status: "failed",
          phase: "lost",
          completedAt,
          error: {
            code: "E_WORKER_LOST",
            message: "Worker dispatch process exited before provider startup; the prompt was not replayed."
          },
          summary: "Lost"
        },
        { cleanupError: latest.error }
      );
      const effectiveIntent = observed.pending;
      const message = effectiveIntent?.error?.message
        || "Worker dispatch process exited before provider startup; the prompt was not replayed.";
      const status = effectiveIntent.status;
      const phase = effectiveIntent.phase;
      return scrubStoredJob({
        ...observed.job,
        status,
        phase,
        summary: effectiveIntent?.summary || (status === "cancelled" ? "Cancelled" : "Lost"),
        progress: terminalTaskProgress(status, effectiveIntent.error),
        completedAt: effectiveIntent.completedAt || completedAt,
        heartbeatAt: completedAt,
        error: effectiveIntent.error || { code: "E_WORKER_LOST", message },
        workerAuthorization: null,
        pendingTerminal: undefined,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            cleanupFence: null,
            unsettledWorkerProcess: null,
            controllerCleanupPending: false,
            controllerCleanupProcess: null,
            providerLaunchPending: false,
            providerLaunchInFlight: false,
            providerLaunchOutcome: "not-launched",
            providerLaunchCompletedAt: completedAt,
            dispatch: {
              ...latestDispatch,
              state: "failed",
              ...(isDispatchV2(latestDispatch) ? { lease: null } : {}),
              ...(Number.isSafeInteger(latest.providerProcess?.providerGeneration)
                ? {
                    providerGeneration: latest.providerProcess.providerGeneration,
                    nextProviderGeneration: null
                  }
                : {}),
              failedAt: completedAt,
              runtimeLostAt: completedAt,
              updatedAt: completedAt
            }
          }
        },
        result: {
          ...(observed.job.result || {}),
          stopReason: status === "cancelled" ? "cancelled" : "reconciler-lost",
          taskRuntimeCleaned: completedCleanup.ok,
          ...(completedCleanup.ok
            ? { privacyWarning: undefined }
            : { privacyWarning: completedCleanup.warning || "Runtime cleanup remained incomplete after dispatch loss." }),
          runtimeEvidence: {
            ...(observed.job.result?.runtimeEvidence || {}),
            reconciler: {
              privilege: "host-trusted-reconciler",
              replayedPrompt: false,
              at: completedAt
            }
          }
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "blocked",
          message,
          { replayedPrompt: false }
        )
      });
    });
  }, env);
}

export function settlePreProviderWorkerFinalization({
  root,
  workerId,
  attemptId,
  workerProcess,
  intendedTerminal,
  runtimeCleanup,
  env = process.env
} = {}) {
  const intendedStatus = intendedTerminal?.status;
  if (!root
    || !workerId
    || !attemptId
    || !workerProcess
    || !currentOwnedProcessIdentity(workerProcess)
    || !["failed", "cancelled"].includes(intendedStatus)
    || typeof intendedTerminal?.phase !== "string"
    || typeof intendedTerminal?.completedAt !== "string"
    || typeof runtimeCleanup?.ok !== "boolean") {
    throw new CompanionError("E_USAGE", "Pre-provider finalization requires exact terminal intent and cleanup evidence.");
  }
  const stateMatches = (job) => {
    const dispatch = job.request?.spawn?.dispatch;
    return isSupportedWorkerDispatch(dispatch)
      && dispatch.attemptId === attemptId
      && dispatch.state === "worker-started"
      && sameDispatchProcessIdentity(job.workerProcess, workerProcess, { nonce: true });
  };

  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    if (terminalJob(current)) return current;
    assertDispatchContract(current);
    assertNoRecoveryCleanupFence(current, "finalize a live pre-provider worker");
    if (!stateMatches(current)) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Pre-provider finalization no longer matches the exact worker attempt.");
    }
    if (runtimeCleanup.ok && current.providerProcess?.pid && !processGroupGone(current.providerProcess)) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Runtime cleanup cannot succeed while an unsettled provider group remains live.");
    }
    const settledAt = now();
    return transaction.updateJob(workerId, (latest) => {
      if (terminalJob(latest)) return latest;
      assertDispatchContract(latest);
      assertNoRecoveryCleanupFence(latest, "finalize a live pre-provider worker");
      if (!stateMatches(latest)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Worker identity changed before finalization publication.");
      }
      if (runtimeCleanup.ok && latest.providerProcess?.pid && !processGroupGone(latest.providerProcess)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Provider cleanup changed before finalization publication.");
      }
      const latestDispatch = latest.request.spawn.dispatch;
      const providerGone = !latest.providerProcess?.pid || processGroupGone(latest.providerProcess);
      const result = {
        ...(latest.result || {}),
        hostVerification: latest.result?.hostVerification || "not_run",
        taskRuntimeCleaned: runtimeCleanup.ok
      };
      if (runtimeCleanup.ok) delete result.privacyWarning;
      else {
        result.privacyWarning = runtimeCleanup.warning
          || "Task runtime artifacts were retained because cleanup could not be verified.";
      }
      const next = {
        ...latest,
        workerAuthorization: null,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            providerLaunchPending: false,
            providerLaunchInFlight: false,
            providerLaunchOutcome: providerGone ? "not-launched" : "unknown",
            providerLaunchCompletedAt: providerGone ? settledAt : null,
            dispatch: {
              ...latestDispatch,
              state: "failed",
              ...(Number.isSafeInteger(latest.providerProcess?.providerGeneration)
                ? { providerGeneration: latest.providerProcess.providerGeneration }
                : {}),
              nextProviderGeneration: null,
              failedAt: settledAt,
              updatedAt: settledAt
            }
          }
        },
        result,
        heartbeatAt: settledAt,
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "blocked",
          intendedTerminal.error?.message || intendedTerminal.summary || "Worker stopped before provider startup",
          { replayedPrompt: false }
        )
      };
      if (runtimeCleanup.ok) {
        const observed = reconcileCleanupSafeTerminalObservation(
          next,
          intendedTerminal,
          { cleanupError: latest.error }
        );
        const pending = observed.pending;
        const terminalized = {
          ...observed.job,
          status: pending.status,
          phase: pending.phase,
          completedAt: pending.completedAt,
          error: pending.error || null,
          summary: pending.summary || pending.error?.message || null,
          progress: terminalTaskProgress(pending.status, pending.error),
          lifecycleEvents: appendLifecycleEvent(
            latest.lifecycleEvents || [],
            pending.status === "completed" ? "checkpoint" : "blocked",
            pending.error?.message
              || pending.summary
              || "Task runtime cleanup completed before provider startup.",
            { replayedPrompt: false }
          )
        };
        delete terminalized.pendingTerminal;
        return scrubStoredJob(terminalized);
      }
      return {
        ...next,
        status: "running",
        phase: "cleanup-blocked",
        completedAt: null,
        pendingTerminal: {
          status: intendedStatus,
          phase: intendedTerminal.phase,
          completedAt: intendedTerminal.completedAt,
          error: intendedTerminal.error || null,
          summary: intendedTerminal.summary || intendedTerminal.error?.message || null
        },
        error: {
          code: "E_STATE",
          message: "Task finished, but transient runtime cleanup is incomplete.",
          details: { privacyWarning: result.privacyWarning }
        },
        summary: "Task finished, but transient runtime cleanup is incomplete.",
        progress: "Task finished; runtime cleanup is still pending"
      };
    });
  }, env);
}

export function persistCompletedWriteArtifact(job, pending, env) {
  if (job?.write !== true || pending?.status !== "completed") return null;
  assertDispatchContract(job);
  assertExactWriteVerticalScope(job.request?.envelope?.scope);
  const binding = job.executionBinding;
  if (!binding
    || binding.bindingDigest !== job.request?.spawn?.executionBindingDigest
    || binding.expectedExecutionRoot !== job.request?.spawn?.executionRoot
    || binding.controlWorkspaceId !== job.controlWorkspaceId) {
    throw new CompanionError(
      "E_INTEGRATION",
      "Completed write worker lost its exact execution binding before artifact capture."
    );
  }
  assertParentUnchanged(
    binding.parentFingerprint,
    binding.controlRoot
  );
  const persisted = persistWriteWorkerArtifact({
    workerId: job.id,
    controlWorkspaceId: binding.controlWorkspaceId,
    controlRoot: binding.controlRoot,
    executionRoot: binding.expectedExecutionRoot,
    baseCommit: binding.baseCommit,
    env
  });
  const record = persisted.record;
  return Object.freeze({
    schemaVersion: record.schemaVersion,
    path: record.path,
    baseCommit: record.baseCommit,
    manifestDigest: record.manifestDigest,
    securityDigest: record.securityDigest,
    patchDigest: record.patchDigest,
    contentDigest: record.contentDigest,
    contentBytes: record.contentBytes,
    createdAt: record.createdAt
  });
}

export function settleWriteArtifactAfterRuntimeCleanup({
  job,
  pending,
  runtimeCleanup,
  env = process.env,
  persistArtifact = persistCompletedWriteArtifact
} = {}) {
  runSuccessfulRuntimeCleanup(runtimeCleanup, job);
  try {
    return Object.freeze({
      pending,
      artifact: persistArtifact(job, pending, env),
      rejected: false
    });
  } catch {
    const completedAt = now();
    return Object.freeze({
      pending: Object.freeze({
        status: "failed",
        phase: "artifact-rejected",
        completedAt,
        error: Object.freeze({
          code: "E_INTEGRATION",
          message: "Worker output failed bounded write-artifact validation."
        }),
        summary: "Worker output failed bounded write-artifact validation."
      }),
      artifact: null,
      rejected: true
    });
  }
}

export function unavailableManagedWriteTerminalObservation(job) {
  let preContext = null;
  try {
    preContext = assertContextManifestIntegrity(
      job.request?.contextManifest
    );
  } catch {
    // A missing or malformed stored pre-context is itself part of the
    // unavailable final observation. Do not fabricate a replacement.
  }
  const completedAt = now();
  const message =
    "Final managed-write context could not be observed after runtime cleanup.";
  return Object.freeze({
    pending: Object.freeze({
      status: "failed",
      phase: "context-rejected",
      completedAt,
      error: Object.freeze({
        code: "E_CONTEXT_DRIFT",
        message,
        details: Object.freeze({
          reasons: Object.freeze(["[final-context-unavailable]"])
        })
      }),
      summary: message
    }),
    job: {
      ...job,
      completionContextManifest: null,
      result: {
        ...(job.result || {}),
        runtimeEvidence: buildRuntimeEvidence({
          preContext,
          postContext: null,
          changedPaths: [],
          commandOutcomes: job.commandOutcomes || [],
          scopeViolations: [],
          executionStatus: "failed"
        }),
        hostVerification: "not_run"
      }
    }
  });
}

export function knownManagedWriteSafetyTerminalObservation(job, error) {
  if (!["E_CONTEXT_DRIFT", "E_SCOPE_VIOLATION"].includes(error?.code)) {
    return null;
  }
  let preContext = null;
  try {
    preContext = assertContextManifestIntegrity(
      job.request?.contextManifest
    );
  } catch {
    // The independently classified final safety error remains authoritative.
    // Do not invent a replacement pre-context merely to populate evidence.
  }
  const contextMarkers = () => {
    const reasons = Array.isArray(error.details?.reasons)
      ? error.details.reasons.map((item) => String(item))
      : [];
    const markers = [];
    if (reasons.some((reason) => ["head", "branch"].includes(reason))) {
      markers.push("[HEAD]");
    }
    if (reasons.some((reason) => [
      "taskRelevantMetadataIdentity",
      "metadataIdentity",
      "upstreamRef",
      "upstreamCommit"
    ].includes(reason))) {
      markers.push("[GIT_METADATA]");
    }
    if (reasons.some((reason) => [
      "trackedTreeIdentity",
      "dirtyDigest",
      "ignoredDigest"
    ].includes(reason))) {
      markers.push("[INDEX]");
    }
    if (reasons.some((reason) => reason === "projectMarkers")) {
      markers.push("[PROJECT_MARKERS]");
    }
    if (markers.length === 0) {
      if (/\b(?:HEAD|branch)\b/i.test(error.message || "")) {
        markers.push("[HEAD]");
      } else if (/\bindex\b/i.test(error.message || "")) {
        markers.push("[INDEX]");
      } else {
        markers.push("[CONTEXT_DRIFT]");
      }
    }
    return [...new Set(markers)].slice(0, 8);
  };
  const scopePaths = () => {
    const provided = Array.isArray(error.details?.paths)
      ? boundPathEvidence(error.details.paths, {
          max: 64,
          marker: "[SCOPE_VIOLATIONS_OVERFLOW]"
        })
      : [];
    if (provided.length > 0) return provided;
    return [
      /\bindex\b/i.test(error.message || "")
        ? "[INDEX]"
        : "[SCOPE_VIOLATION]"
    ];
  };
  const code = error.code;
  const observedChangedPaths = code === "E_CONTEXT_DRIFT"
    ? contextMarkers()
    : scopePaths();
  const scopeViolations = code === "E_SCOPE_VIOLATION"
    ? observedChangedPaths
    : [];
  const details = code === "E_CONTEXT_DRIFT"
    ? { reasons: Object.freeze(observedChangedPaths) }
    : { paths: Object.freeze(scopeViolations) };
  const completedAt = now();
  const message = code === "E_CONTEXT_DRIFT"
    ? "Final managed-write context drift was observed after runtime cleanup."
    : "Final managed-write scope violation was observed after runtime cleanup.";
  return Object.freeze({
    pending: Object.freeze({
      status: "failed",
      phase: code === "E_CONTEXT_DRIFT"
        ? "context-rejected"
        : "scope-rejected",
      completedAt,
      error: Object.freeze({
        code,
        message,
        details: Object.freeze(details)
      }),
      summary: message
    }),
    job: {
      ...job,
      completionContextManifest: null,
      result: {
        ...(job.result || {}),
        runtimeEvidence: buildRuntimeEvidence({
          preContext,
          postContext: null,
          changedPaths: observedChangedPaths,
          commandOutcomes: job.commandOutcomes || [],
          scopeViolations,
          executionStatus: "failed"
        }),
        hostVerification: "not_run"
      }
    }
  });
}

export function reconcileCleanupSafeTerminalObservation(
  job,
  pending,
  { cleanupError = null } = {}
) {
  const intendedStatus = pending?.status || null;
  const executionStatus = intendedStatus === "completed"
    ? "completed"
    : intendedStatus === "cancelled"
      ? "cancelled"
      : "failed";
  const executionRoot = job?.request?.spawn?.executionRoot
    || job?.workspaceRoot;
  let managedAuthorityUnavailable = false;
  const dispatch = job?.request?.spawn?.dispatch;
  const explicitManagedAuthority = [
    job?.executionBinding,
    job?.provisioning,
    job?.provisioningRuntime,
    job?.request?.admissionContextManifest,
    job?.request?.spawn?.executionBindingDigest
  ].some((value) => value !== undefined && value !== null);
  if (job?.write === true
    && (isDispatchV2(dispatch) || explicitManagedAuthority)) {
    try {
      hasManagedWriteAuthority(job);
    } catch {
      // Partial managed-write authority is not a legacy unmanaged write. It
      // cannot be trusted as a final observation boundary even before provider
      // startup, so force the same bounded unavailable-context terminal.
      managedAuthorityUnavailable = true;
    }
  }
  const evidence = captureTerminalEvidence(
    executionRoot,
    job,
    executionStatus,
    managedAuthorityUnavailable
      ? {
          captureContext() {
            throw new CompanionError(
              "E_CONTEXT_DRIFT",
              "Managed-write terminal authority is incomplete."
            );
          }
        }
      : {}
  );
  const selectedTerminalError = selectTaskTerminalError(
    evidence,
    pending?.error || null,
    cleanupError
  );
  // Error.message is non-enumerable on Error/CompanionError instances. Every
  // terminal error must cross the durable JSON boundary as an ordinary record.
  const selectedError = selectedTerminalError
    ? Object.freeze(asErrorPayload(selectedTerminalError))
    : null;
  const safetyFailure = [
    "E_CONTEXT_DRIFT",
    "E_SCOPE_VIOLATION"
  ].includes(selectedError?.code);
  const selectedStatus = selectedError
    ? (selectedError.code === "E_CANCELLED" ? "cancelled" : "failed")
    : intendedStatus;
  const statusChanged = selectedStatus !== intendedStatus;
  const errorChanged = Boolean(
    selectedError
    && (
      selectedError.code !== pending?.error?.code
      || selectedError.message !== pending?.error?.message
    )
  );
  const outcomeChanged = statusChanged || errorChanged;
  const reconciledPending = selectedError
    ? Object.freeze({
        status: selectedStatus,
        phase: selectedError.code === "E_CONTEXT_DRIFT"
          ? "context-rejected"
          : selectedError.code === "E_SCOPE_VIOLATION"
            ? "scope-rejected"
            : outcomeChanged
              ? selectedStatus
              : pending?.phase || selectedStatus,
        completedAt: safetyFailure
          ? now()
          : pending?.completedAt || now(),
        error: selectedError,
        summary: safetyFailure || outcomeChanged
          ? selectedError.message
          : pending?.summary || selectedError.message
      })
    : pending;
  const effectiveStatus = reconciledPending?.status || "failed";
  const effectiveError = reconciledPending?.error || null;
  evidence.runtimeEvidence.executionStatus = effectiveStatus === "completed"
    ? "completed"
    : effectiveStatus === "cancelled"
      ? "cancelled"
      : "failed";
  const result = {
    ...(job.result || {}),
    runtimeEvidence: {
      ...(job.result?.runtimeEvidence || {}),
      ...evidence.runtimeEvidence
    },
    hostVerification: "not_run"
  };
  // Every caller reaches this helper only after exact runtime cleanup. A
  // warning from an earlier failed cleanup attempt is therefore stale.
  delete result.privacyWarning;
  if (effectiveStatus !== "cancelled" && result.stopReason === "cancelled") {
    delete result.stopReason;
  }
  return Object.freeze({
    pending: reconciledPending,
    job: {
      ...job,
      progress: terminalTaskProgress(effectiveStatus, effectiveError),
      completionContextManifest: evidence.postContext,
      result
    }
  });
}

export function reconcileProviderStartedWriteCompletion(job, pending, env) {
  let managedWritePostBinding;
  try {
    managedWritePostBinding = hasManagedWritePostBinding(job);
  } catch {
    // Runtime cleanup already succeeded before every caller reaches this
    // function. A malformed partial managed-write authority must therefore
    // become one terminal fail-closed observation, not abort the transaction
    // and strand a cleaned task as active.
    return unavailableManagedWriteTerminalObservation(job);
  }
  if (job?.write !== true || !managedWritePostBinding) {
    return reconcileCleanupSafeTerminalObservation(job, pending);
  }
  let observed;
  try {
    if (pending) {
      const providerCompletionContext = assertContextManifestIntegrity(
        job.completionContextManifest
      );
      const providerRuntimeContext = job.result?.runtimeEvidence?.postContext;
      if (!providerRuntimeContext
        || providerRuntimeContext.manifestId !== providerCompletionContext.manifestId
        || providerRuntimeContext.digest !== providerCompletionContext.digest) {
        throw new CompanionError(
          "E_STATE",
          "Provider completion evidence is not bound to its stored ContextManifest."
        );
      }
    }

    // Capture again under the workspace transaction immediately before artifact
    // and terminal publication. A worker that disappeared before publishing an
    // intent still receives the same final safety observation. Provider evidence
    // is informative, never the terminal authority for the live filesystem
    // boundary.
    observed = captureManagedWritePostBindingContext(job, env);
  } catch (error) {
    const safetyObservation =
      knownManagedWriteSafetyTerminalObservation(job, error);
    if (safetyObservation) return safetyObservation;
    return unavailableManagedWriteTerminalObservation(job);
  }
  const contextDrift = observed.coreReasons.length > 0
    || observed.metadataMarkers.length > 0;
  const scopeDrift = observed.scopeViolations.length > 0;
  const rejected = contextDrift || scopeDrift;
  const contextReasons = [...new Set([
    ...(observed.controlContextMarkers || []),
    ...observed.metadataMarkers
  ])].slice(0, 8);
  const reconciledPending = rejected
    ? Object.freeze({
        status: "failed",
        phase: contextDrift ? "context-rejected" : "scope-rejected",
        completedAt: now(),
        error: Object.freeze({
          code: contextDrift ? "E_CONTEXT_DRIFT" : "E_SCOPE_VIOLATION",
          message: contextDrift
            ? "Worker output failed final execution-context reconciliation."
            : "Worker output changed paths outside the delegated scope.",
          ...(contextDrift && contextReasons.length
            ? {
                details: Object.freeze({
                  reasons: Object.freeze(contextReasons)
                })
              }
            : {})
        }),
        summary: contextDrift
          ? "Worker output failed final execution-context reconciliation."
          : "Worker output changed paths outside the delegated scope."
      })
    : pending;
  const runtimeEvidence = buildRuntimeEvidence({
    preContext: observed.requestContextManifest,
    postContext: observed.currentContextManifest,
    changedPaths: observed.observedChangedPaths,
    diffSummary: observed.observedChangedPaths.length
      ? observed.observedChangedPaths.join("\n")
      : "No workspace changes observed.",
    commandOutcomes: job.commandOutcomes || [],
    scopeViolations: observed.scopeViolations,
    executionStatus: rejected
      ? "failed"
      : pending?.status === "cancelled"
        ? "cancelled"
        : pending?.status === "failed"
          ? "failed"
          : pending?.status === "completed"
            ? "completed"
            : "failed"
  });
  return Object.freeze({
    pending: reconciledPending,
    job: {
      ...job,
      completionContextManifest: observed.currentContextManifest,
      result: {
        ...(job.result || {}),
        runtimeEvidence,
        hostVerification: "not_run"
      }
    }
  });
}

export function settleProviderStartedWorkerFinalization({
  root,
  workerId,
  attemptId,
  workerProcess,
  providerProcess,
  runtimeCleanup,
  env = process.env
} = {}) {
  if (!root
    || !workerId
    || !attemptId
    || !workerProcess
    || !providerProcess
    || !currentOwnedProcessIdentity(workerProcess)
    || (typeof runtimeCleanup !== "function" && runtimeCleanup?.ok !== true)) {
    throw new CompanionError(
      "E_USAGE",
      "Provider-started finalization requires the live exact worker, gone provider, and cleanup authority."
    );
  }
  const pendingIntent = (job) => {
    const pending = job?.pendingTerminal;
    if (!isPlainRecord(pending)
      || !["completed", "failed", "cancelled"].includes(pending.status)
      || typeof pending.phase !== "string"
      || !pending.phase
      || typeof pending.completedAt !== "string"
      || !pending.completedAt
      || (pending.summary !== null && typeof pending.summary !== "string")
      || (pending.error !== null && !isPlainRecord(pending.error))) {
      throw new CompanionError("E_STATE", "Pending worker terminal intent is missing or malformed.");
    }
    return pending;
  };
  const stateMatches = (job) => {
    const dispatch = job.request?.spawn?.dispatch;
    return isSupportedWorkerDispatch(dispatch)
      && dispatch.attemptId === attemptId
      && dispatch.state === "provider-started"
      && dispatch.nextProviderGeneration == null
      && sameDispatchProcessIdentity(job.workerProcess, workerProcess, { nonce: true })
      && currentOwnedProcessIdentity(workerProcess)
      && sameDispatchProcessIdentity(job.providerProcess, providerProcess)
      && processGroupGone(providerProcess)
      && Boolean(pendingIntent(job));
  };

  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    if (terminalJob(current)) return current;
    assertDispatchContract(current);
    assertNoRecoveryCleanupFence(current, "finalize a live provider-started worker");
    if (!stateMatches(current)) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Provider-started finalization no longer matches the exact active generation."
      );
    }
    return transaction.updateJob(workerId, (latest) => {
      if (terminalJob(latest)) return latest;
      assertDispatchContract(latest);
      assertNoRecoveryCleanupFence(latest, "finalize a live provider-started worker");
      if (!stateMatches(latest)) {
        throw new CompanionError(
          "E_PROCESS_IDENTITY",
          "Provider generation changed before cleanup and terminal publication."
        );
      }
      const intended = pendingIntent(latest);
      const completedCleanup = runSuccessfulRuntimeCleanup(
        runtimeCleanup,
        latest
      );
      const reconciled = reconcileProviderStartedWriteCompletion(
        latest,
        intended,
        env
      );
      const signalReconciled = reconcileTerminalCleanupSignal(
        reconciled.pending,
        latest.error,
        {
          completedAt: now(),
          priorErrors: [intended.error]
        }
      );
      const artifactSettlement = settleWriteArtifactAfterRuntimeCleanup({
        job: reconciled.job,
        pending: signalReconciled,
        runtimeCleanup: completedCleanup,
        env
      });
      const pending = artifactSettlement.pending;
      const writeArtifact = artifactSettlement.artifact;
      const settledAt = now();
      const result = {
        ...(reconciled.job.result || {}),
        ...(writeArtifact ? { writeArtifact } : {}),
        hostVerification: latest.result?.hostVerification || "not_run",
        taskRuntimeCleaned: true,
        ...(pending.status === "cancelled" && !latest.result?.stopReason
          ? { stopReason: "cancelled" }
          : {})
      };
      if (artifactSettlement.rejected) {
        delete result.writeArtifact;
        result.stopReason = "write-artifact-rejected";
      }
      if (result.runtimeEvidence) {
        result.runtimeEvidence = {
          ...result.runtimeEvidence,
          executionStatus: pending.status === "completed"
            ? "completed"
            : pending.status === "cancelled"
              ? "cancelled"
              : "failed"
        };
      }
      delete result.privacyWarning;
      const terminalized = {
        ...reconciled.job,
        status: pending.status,
        phase: pending.phase,
        completedAt: pending.completedAt,
        heartbeatAt: settledAt,
        error: pending.error || null,
        summary: pending.summary || pending.error?.message || latest.summary,
        progress: pending.status === "completed"
          ? "Task runtime cleanup completed"
          : pending.status === "cancelled"
            ? "Cancellation completed"
            : "Worker finalization completed",
        workerAuthorization: null,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            providerLaunchPending: false,
            providerLaunchInFlight: false,
            providerLaunchOutcome: "launched",
            providerLaunchCompletedAt: settledAt,
            dispatch: {
              ...latest.request.spawn.dispatch,
              nextProviderGeneration: null,
              updatedAt: settledAt
            }
          }
        },
        result,
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          pending.status === "completed" ? "checkpoint" : "blocked",
          artifactSettlement.rejected
            ? "Task runtime cleanup completed; write artifact validation failed closed."
            : "Task runtime cleanup completed; durable terminal intent published.",
          { replayedPrompt: false }
        )
      };
      delete terminalized.pendingTerminal;
      return scrubStoredJob(terminalized);
    });
  }, env);
}

export function settleFailedDispatchCleanup({
  root,
  workerId,
  attemptId,
  controllerProcess,
  workerProcess,
  providerProcess = null,
  cleanupFenceId = null,
  runtimeCleanup,
  reconciler = false,
  env = process.env
} = {}) {
  if (!root
    || !workerId
    || !attemptId
    || !controllerProcess
    || !workerProcess
    || (typeof runtimeCleanup !== "function" && runtimeCleanup?.ok !== true)) {
    throw new CompanionError("E_USAGE", "Failed dispatch cleanup settlement requires exact gone process identities.");
  }
  const stateMatches = (job) => {
    const dispatch = job.request?.spawn?.dispatch;
    return isSupportedWorkerDispatch(dispatch)
      && dispatch.attemptId === attemptId
      && dispatch.state === "failed"
      && recoveryCleanupFenceMatches(job, cleanupFenceId, ["provider-generation"])
      && job.phase === "cleanup-blocked"
      && job.pendingTerminal
      && sameDispatchProcessIdentity(job.controllerProcess, controllerProcess, { nonce: true })
      && sameDispatchProcessIdentity(job.workerProcess, workerProcess, { nonce: true })
      && processGroupGone(controllerProcess)
      && processGroupGone(workerProcess)
      && ((!job.providerProcess?.pid && !providerProcess)
        || (sameDispatchProcessWitness(job.providerProcess, providerProcess, {
          allowUnsettled: true
        })
          && processGroupGone(providerProcess)));
  };
  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    if (terminalJob(current)) return current;
    assertDispatchContract(current);
    if (!stateMatches(current)) {
      throw new CompanionError("E_PROCESS_IDENTITY", "Cleanup settlement no longer matches the exact failed dispatch.");
    }
    return transaction.updateJob(workerId, (latest) => {
      if (terminalJob(latest)) return latest;
      assertDispatchContract(latest);
      if (!stateMatches(latest)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Cleanup identity changed before terminal publication.");
      }
      runSuccessfulRuntimeCleanup(runtimeCleanup, latest);
      const settledAt = now();
      const observed = reconcileCleanupSafeTerminalObservation(
        latest,
        latest.pendingTerminal,
        { cleanupError: latest.error }
      );
      const pending = observed.pending;
      const result = {
        ...(observed.job.result || {}),
        taskRuntimeCleaned: true,
        hostVerification: "not_run",
        ...(reconciler ? {
          runtimeEvidence: {
            ...(observed.job.result?.runtimeEvidence || {}),
            reconciler: {
              privilege: "host-trusted-reconciler",
              replayedPrompt: false,
              at: settledAt
            }
          }
        } : {})
      };
      if (result.runtimeEvidence) {
        result.runtimeEvidence = {
          ...result.runtimeEvidence,
          executionStatus: pending.status === "completed"
            ? "completed"
            : pending.status === "cancelled"
              ? "cancelled"
              : "failed"
        };
      }
      delete result.privacyWarning;
      const terminalized = {
        ...observed.job,
        status: pending.status,
        phase: pending.phase,
        completedAt: pending.completedAt || settledAt,
        error: pending.error || null,
        summary: pending.summary || pending.error?.message || latest.summary,
        progress: terminalTaskProgress(pending.status, pending.error),
        result,
        heartbeatAt: settledAt,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            cleanupFence: null
          }
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          "checkpoint",
          "Task runtime cleanup completed; terminal result published.",
          { replayedPrompt: false }
        )
      };
      delete terminalized.pendingTerminal;
      return scrubStoredJob(terminalized);
    });
  }, env);
}

export function settleStartedWorkerLoss({
  root,
  workerId,
  attemptId,
  workerProcess,
  controllerProcess = null,
  providerProcess,
  cleanupFenceId = null,
  reconciler = false,
  runtimeCleanup,
  env = process.env
} = {}) {
  if (!workerId
    || !attemptId
    || !workerProcess
    || !providerProcess
    || (typeof runtimeCleanup !== "function" && runtimeCleanup?.ok !== true)) {
    throw new CompanionError(
      "E_USAGE",
      "Worker loss settlement requires exact gone worker/provider identities and successful runtime cleanup."
    );
  }
  const pendingIntent = (job) => {
    const pending = job?.pendingTerminal;
    if (pending == null) return null;
    if (!isPlainRecord(pending)
      || !["completed", "failed", "cancelled"].includes(pending.status)
      || typeof pending.phase !== "string"
      || !pending.phase
      || typeof pending.completedAt !== "string"
      || !pending.completedAt
      || (pending.summary !== null && typeof pending.summary !== "string")
      || (pending.error !== null && !isPlainRecord(pending.error))) {
      throw new CompanionError("E_STATE", "Pending worker terminal intent is malformed.");
    }
    return pending;
  };
  const stateMatches = (job) => {
    const dispatch = job.request?.spawn?.dispatch;
    const pending = pendingIntent(job);
    return isSupportedWorkerDispatch(dispatch)
      && dispatch.attemptId === attemptId
      && dispatch.state === "provider-started"
      && recoveryCleanupFenceMatches(job, cleanupFenceId, ["provider-generation"])
      && sameDispatchProcessIdentity(job.workerProcess, workerProcess, { nonce: true })
      && processGroupGone(workerProcess)
      && sameDispatchProcessIdentity(job.providerProcess, providerProcess)
      && processGroupGone(providerProcess)
      && (!controllerProcess || (
        sameDispatchProcessIdentity(job.controllerProcess, controllerProcess, { nonce: true })
        && processGroupGone(controllerProcess)
      ))
      // A cleanup-blocked terminal intent is published only by host recovery
      // after the controller has also exited. The live controller may settle a
      // genuine lost-worker record, but it cannot publish its own teardown as
      // already complete.
      && (!pending || Boolean(controllerProcess));
  };
  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    if (terminalJob(current)) return current;
    const dispatch = current.request?.spawn?.dispatch;
    if (!isSupportedWorkerDispatch(dispatch)
      || dispatch.attemptId !== attemptId
      || dispatch.state !== "provider-started") {
      throw new CompanionError("E_STATE", "Started worker loss does not match the durable dispatch.");
    }
    assertDispatchContract(current);
    if (!stateMatches(current)) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Refusing to settle worker runtime cleanup without exact gone controller/worker/provider identities."
      );
    }
    return transaction.updateJob(workerId, (latest) => {
      if (terminalJob(latest)) return latest;
      if (!stateMatches(latest)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Worker identity changed before loss settlement publication.");
      }
      assertDispatchContract(latest);
      const latestDispatch = latest.request.spawn.dispatch;
      const intended = pendingIntent(latest);
      const completedCleanup = runSuccessfulRuntimeCleanup(
        runtimeCleanup,
        latest
      );
      const reconciled = reconcileProviderStartedWriteCompletion(
        latest,
        intended,
        env
      );
      const recoveredPending = reconcileTerminalCleanupSignal(
        reconciled.pending,
        latest.error,
        { priorErrors: [intended?.error] }
      );
      const artifactSettlement = settleWriteArtifactAfterRuntimeCleanup({
        job: reconciled.job,
        pending: recoveredPending,
        runtimeCleanup: completedCleanup,
        env
      });
      const effective = artifactSettlement.pending;
      const writeArtifact = artifactSettlement.artifact;
      const settledAt = now();
      const message = artifactSettlement.rejected
        ? "Task runtime cleanup completed; write artifact validation failed closed."
        : effective
          ? "Task runtime cleanup completed; the durable terminal result was published."
        : "Worker process exited before publishing a terminal result; the prompt was not replayed.";
      const status = effective?.status || "failed";
      const result = {
        ...(reconciled.job.result || {}),
        ...(writeArtifact ? { writeArtifact } : {}),
        hostVerification: latest.result?.hostVerification || "not_run",
        taskRuntimeCleaned: true,
        ...(effective
          ? (status === "cancelled" && !reconciled.job.result?.stopReason
              ? { stopReason: "cancelled" }
              : {})
          : { stopReason: "worker-runtime-lost" }),
        ...(reconciler ? {
          runtimeEvidence: {
            ...(reconciled.job.result?.runtimeEvidence || {}),
            reconciler: {
              privilege: "host-trusted-reconciler",
              replayedPrompt: false,
              at: settledAt
            }
          }
        } : {})
      };
      if (artifactSettlement.rejected) {
        delete result.writeArtifact;
        result.stopReason = "write-artifact-rejected";
      }
      if (result.runtimeEvidence) {
        result.runtimeEvidence = {
          ...result.runtimeEvidence,
          executionStatus: status === "completed"
            ? "completed"
            : status === "cancelled"
              ? "cancelled"
              : "failed"
        };
      }
      delete result.privacyWarning;
      const terminalized = {
        ...reconciled.job,
        status,
        phase: effective?.phase || "lost",
        summary: effective ? effective.summary : "Lost",
        progress: message,
        completedAt: effective?.completedAt || settledAt,
        heartbeatAt: settledAt,
        error: effective ? effective.error : { code: "E_WORKER_LOST", message },
        workerAuthorization: null,
        request: {
          ...latest.request,
          spawn: {
            ...latest.request.spawn,
            cleanupFence: null,
            dispatch: {
              ...latestDispatch,
              nextProviderGeneration: null,
              ...(!effective ? { runtimeLostAt: settledAt } : {}),
              updatedAt: settledAt
            }
          }
        },
        result,
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          status === "completed" ? "checkpoint" : "blocked",
          message,
          { replayedPrompt: false }
        )
      };
      delete terminalized.pendingTerminal;
      return scrubStoredJob(terminalized);
    });
  }, env);
}
