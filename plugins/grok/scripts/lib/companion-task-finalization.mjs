import { asErrorPayload } from "./errors.mjs";
import { cleanupTaskRuntimeArtifacts } from "./provider-controller-environments.mjs";
import { gatedCleanupReviewEnvironment } from "./provider-credentials.mjs";
import { updateJob, readJob, terminal, now, retain } from "./state.mjs";
import { redact, redactText } from "./redact.mjs";
import { resolveProviderCleanupTarget } from "./recursion-guard.mjs";
import { settlePreProviderWorkerFinalization, settleProviderStartedWorkerFinalization } from "./worker-mutation-terminal.mjs";
import { captureTerminalEvidence, selectTaskTerminalError, terminalTaskProgress } from "./task-terminal-evidence.mjs";
import { applyReviewPrivacy, applyTaskPrivacy, includeGuardCleanup, reconcileTerminalStopReason, stateDir } from "./companion-shared.mjs";

function finalizeExecution(execution) {
  const { root, id, job, dispatchAttemptId, exactBrokerWorkerIdentity } = execution;
  let taskCleanup = null;
  const finalizationSnapshot = readJob(root, id);
  const brokerProviderFinalization = Boolean(
    job.jobClass === "task"
    && dispatchAttemptId
    && !terminal(finalizationSnapshot)
    && finalizationSnapshot.request?.spawn?.dispatch?.attemptId === dispatchAttemptId
    && finalizationSnapshot.request?.spawn?.dispatch?.state === "provider-started"
    && finalizationSnapshot.pendingTerminal
    && exactBrokerWorkerIdentity(finalizationSnapshot.workerProcess)
  );
  if (job.jobClass === "review") {
    // Gate on the resolved job/guard-backed process group: never delete an isolated credential
    // home or claim providerSessionDeleted while the group remains live or unverifiable.
    const latest = readJob(root, id);
    const { identity } = resolveProviderCleanupTarget(root, latest);
    let cleanup = gatedCleanupReviewEnvironment(stateDir(root), id, identity);
    if (cleanup.ok) cleanup = includeGuardCleanup(root, id, cleanup);
    updateJob(root, id, (value) => {
      value.result = applyReviewPrivacy(value.result, cleanup);
      return value;
    });
  } else if (!dispatchAttemptId || execution.brokerPreProviderFailure) {
    const latest = readJob(root, id);
    const { identity } = resolveProviderCleanupTarget(root, latest);
    taskCleanup = cleanupTaskRuntimeArtifacts(
      stateDir(root),
      latest.request?.providerHomeId || id,
      [identity].filter(Boolean)
    );
    taskCleanup = includeGuardCleanup(root, id, taskCleanup);
    if (!execution.brokerPreProviderFailure) {
      updateJob(root, id, (value) => {
        value.result = applyTaskPrivacy(value.result, taskCleanup);
        return value;
      });
    }
  }
  if (brokerProviderFinalization) {
    try {
      const current = readJob(root, id);
      settleProviderStartedWorkerFinalization({
        root,
        workerId: id,
        attemptId: dispatchAttemptId,
        workerProcess: current.workerProcess,
        providerProcess: current.providerProcess,
        runtimeCleanup: (latest) => {
          let cleanup = cleanupTaskRuntimeArtifacts(
            stateDir(root),
            latest.request?.providerHomeId || id,
            [latest.providerProcess].filter(Boolean)
          );
          if (cleanup.ok) {
            cleanup = includeGuardCleanup(root, id, cleanup, { inWorkspaceTransaction: true });
          }
          return cleanup;
        }
      });
    } catch (error) {
      const warning = error?.code === "E_RUNTIME_CLEANUP"
        ? error.details?.warning || "Task runtime cleanup remained incomplete."
        : "Task runtime cleanup was deferred because the exact provider generation is not settled.";
      updateJob(root, id, (current) => {
        if (terminal(current)) return current;
        const dispatch = current.request?.spawn?.dispatch;
        if (dispatch?.attemptId !== dispatchAttemptId
          || dispatch.state !== "provider-started"
          || !current.pendingTerminal) return current;
        current.status = "running";
        current.phase = "cleanup-blocked";
        current.completedAt = null;
        current.progress = "Task finished; exact-generation runtime cleanup is still pending";
        current.result = applyTaskPrivacy(current.result, { ok: false, warning });
        return current;
      });
    }
    retain(root);
    if (execution.terminalError) throw execution.terminalError;
    return readJob(root, id);
  }
  if (execution.brokerPreProviderFailure) {
    const current = readJob(root, id);
    const intendedStatus = execution.terminalError?.code === "E_CANCELLED" ? "cancelled" : "failed";
    settlePreProviderWorkerFinalization({
      root,
      workerId: id,
      attemptId: dispatchAttemptId,
      workerProcess: current.workerProcess,
      intendedTerminal: {
        status: intendedStatus,
        phase: intendedStatus,
        completedAt: now(),
        error: current.error || redact(asErrorPayload(execution.terminalError)),
        summary: current.summary || redactText(execution.terminalError?.message || "Worker failed before provider startup")
      },
      runtimeCleanup: taskCleanup || {
        ok: false,
        warning: "Task runtime cleanup outcome is unavailable."
      }
    });
    retain(root);
    if (execution.terminalError) throw execution.terminalError;
    return readJob(root, id);
  }
  if (dispatchAttemptId) {
    // Failed/unsettled broker generations are owned by authoritative
    // recovery. Never fall through to the legacy task cleanup/finalization
    // path, which has no generation binding.
    retain(root);
    if (execution.terminalError) throw execution.terminalError;
    return readJob(root, id);
  }
  updateJob(root, id, (current) => {
    if (terminal(current)) return current;
    const pending = current.pendingTerminal || null;
    const intendedStatus = pending?.status
      || (execution.terminalError
        ? (execution.terminalError.code === "E_CANCELLED" ? "cancelled" : "failed")
        : "completed");
    const intendedPhase = intendedStatus === "completed" ? "done" : intendedStatus;
    const completedAt = now();
    if (current.jobClass === "task" && taskCleanup && !taskCleanup.ok) {
      current.pendingTerminal = {
        status: intendedStatus,
        phase: intendedPhase,
        completedAt,
        error: current.error || null,
        summary: current.summary || null
      };
      current.status = "running";
      current.phase = "cleanup-blocked";
      current.completedAt = null;
      current.progress = "Task finished; runtime cleanup is still pending";
      if (!current.error) {
        current.error = {
          code: "E_STATE",
          message: "Task finished, but transient runtime cleanup is incomplete.",
          details: { privacyWarning: taskCleanup.warning }
        };
        current.summary = current.error.message;
      }
    } else {
      let finalStatus = intendedStatus;
      let finalPhase = intendedPhase;
      if (current.jobClass === "task") {
        const evidence = captureTerminalEvidence(
          root,
          current,
          intendedStatus === "completed"
            ? "completed"
            : intendedStatus === "cancelled"
              ? "cancelled"
              : "failed"
        );
        const selectedError = selectTaskTerminalError(
          evidence,
          pending ? pending.error || null : current.error || execution.terminalError,
          current.error || execution.terminalError
        );
        if (selectedError) {
          finalStatus = selectedError.code === "E_CANCELLED"
            ? "cancelled"
            : "failed";
          finalPhase = ["E_CONTEXT_DRIFT", "E_CONTEXT_INCOMPLETE"].includes(selectedError.code)
            ? "context-rejected"
            : selectedError.code === "E_SCOPE_VIOLATION"
              ? "scope-rejected"
              : finalStatus;
          current.error = redact(asErrorPayload(selectedError));
          current.summary = current.error.message;
          execution.terminalError = selectedError;
        } else {
          current.error = null;
          if (pending?.summary) current.summary = pending.summary;
          execution.terminalError = null;
        }
        evidence.runtimeEvidence.executionStatus = finalStatus === "completed"
          ? "completed"
          : finalStatus === "cancelled"
            ? "cancelled"
            : "failed";
        current.completionContextManifest = evidence.postContext;
        current.result = reconcileTerminalStopReason({
          ...(current.result || {}),
          hostVerification: current.result?.hostVerification || "not_run",
          runtimeEvidence: evidence.runtimeEvidence
        }, finalStatus);
        current.progress = terminalTaskProgress(finalStatus, current.error);
      }
      current.status = finalStatus;
      current.phase = finalPhase;
      current.completedAt = completedAt;
      delete current.pendingTerminal;
    }
    current.heartbeatAt = now();
    return current;
  });
  retain(root);
}

export { finalizeExecution };
