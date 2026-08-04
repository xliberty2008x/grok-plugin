import { CompanionError, asErrorPayload } from "./errors.mjs";
import { cleanupReviewEnvironment } from "./provider-credentials.mjs";
import { cleanupTaskRuntimeArtifacts } from "./provider-controller-environments.mjs";
import { applyResearchPrivacy, cleanupResearchRuntimeArtifacts } from "./deep-research.mjs";
import { updateJob, listJobs, readJob, terminal, now, withWorkspaceAdmission } from "./state.mjs";
import { redact } from "./redact.mjs";
import { identityMatches, processGroupGone, processIsZombie, processStartToken } from "./process-control.mjs";
import { resolveProviderCleanupTarget } from "./recursion-guard.mjs";
import { appendLifecycleEvent } from "./task-lifecycle.mjs";
import { scrubStoredJob } from "./task-envelope.mjs";
import { providerLaunchCleanupBlocked } from "./worker-reconcile.mjs";
import { reconcileBrokerWorkers } from "./worker-recovery.mjs";
import { captureTerminalEvidence, normalizeTerminalProcessSignalError, selectTaskTerminalError, terminalTaskProgress } from "./task-terminal-evidence.mjs";
import { isSupportedWorkerDispatch } from "./worker-launch-contract.mjs";
import { applyReviewPrivacy, applyTaskPrivacy, currentHost, includeGuardCleanup, reconcileTerminalStopReason, stateDir, terminateProviderCleanupTarget, terminateVerified } from "./companion-shared.mjs";

export function isBrokerDispatch(candidate) {
  return isSupportedWorkerDispatch(candidate?.request?.spawn?.dispatch);
}

async function recoverBrokerOwnedJobs(root) {
  const host = currentHost();
  if (host.kind === "codex" && host.sessionId) {
    // Worker Dispatch v1 has one owner-scoped, generation-aware recovery
    // authority. The legacy CLI sweeper must never inspect or mutate foreign
    // dispatch records and must never select a stale provider generation.
    await reconcileBrokerWorkers({
      root,
      principal: { hostKind: "codex", threadId: host.sessionId }
    });
  }
}

function recoverTerminalReviewJobs(root) {
  for (const job of listJobs(root).filter((candidate) => !isBrokerDispatch(candidate) && terminal(candidate) && candidate.jobClass === "review" && candidate.result?.providerSessionDeleted === false && candidate.result?.skipReason !== "empty-target")) {
    // Fail closed: require the complete owned provider process group to be gone
    // (not merely a dead leader). Mirrors SessionEnd processGroupGone semantics.
    // Use guard identity when providerProcess was never recorded on the job.
    const { identity: providerIdentity } = resolveProviderCleanupTarget(root, job);
    if (!processGroupGone(providerIdentity) || !processGroupGone(job.workerProcess)) continue;
    let cleanup = cleanupReviewEnvironment(stateDir(root), job.id);
    cleanup = includeGuardCleanup(root, job.id, cleanup);
    updateJob(root, job.id, (current) => {
      current.result = applyReviewPrivacy(current.result, cleanup);
      return current;
    });
  }
}

function recoverTerminalResearchJobs(root) {
  // Terminal research records: research-only privacy/cleanup (never TaskEnvelope).
  for (const job of listJobs(root).filter((candidate) => (
    !isBrokerDispatch(candidate)
    && terminal(candidate)
    && candidate.jobClass === "research"
    && candidate.result?.researchRuntimeCleaned !== true
  ))) {
    withWorkspaceAdmission(root, () => {
      const currentJob = readJob(root, job.id);
      if (!terminal(currentJob) || currentJob.result?.researchRuntimeCleaned === true) return;
      const { identity: providerIdentity } = resolveProviderCleanupTarget(root, currentJob);
      const identities = [providerIdentity, currentJob.workerProcess].filter(Boolean);
      let cleanup = cleanupResearchRuntimeArtifacts(stateDir(root), currentJob.id, identities);
      if (!cleanup.ok) {
        updateJob(root, currentJob.id, (current) => {
          current.pendingTerminal ||= {
            status: current.status,
            phase: current.phase,
            completedAt: current.completedAt,
            error: current.error || null,
            summary: current.summary || null
          };
          current.status = "running";
          current.phase = "cleanup-blocked";
          current.completedAt = null;
          current.progress = "Deep-research finished; runtime cleanup is still pending";
          current.result = applyResearchPrivacy(current.result, cleanup);
          return current;
        });
        return;
      }
      cleanup = includeGuardCleanup(root, currentJob.id, cleanup, { inWorkspaceTransaction: true });
      updateJob(root, currentJob.id, (current) => {
        current.result = applyResearchPrivacy(current.result, cleanup);
        return current;
      });
    });
  }
}

function recoverTerminalTaskJobs(root) {
  // Re-clean terminal task records produced by older runtimes or a cleanup
  // failure after provider exit. If either recorded group still lives, move the
  // record back to cleanup-blocked so the active recovery path can terminate it.
  for (const job of listJobs(root).filter((candidate) => !isBrokerDispatch(candidate) && terminal(candidate) && candidate.jobClass === "task" && candidate.result?.taskRuntimeCleaned !== true)) {
    withWorkspaceAdmission(root, () => {
      const currentJob = readJob(root, job.id);
      if (!terminal(currentJob) || currentJob.result?.taskRuntimeCleaned === true) return;
      const lineage = currentJob.request?.providerHomeId || currentJob.id;
      const activeLineage = listJobs(root).find((candidate) => (
        candidate.id !== currentJob.id
        && !terminal(candidate)
        && candidate.jobClass === "task"
        && (candidate.request?.providerHomeId || candidate.id) === lineage
      ));
      // Admission holds the same workspace lock. Existing lineage ownership
      // defers cleanup; new ownership cannot appear until this cleanup ends.
      if (activeLineage) return;

      const { identity: providerIdentity } = resolveProviderCleanupTarget(root, currentJob);
      const identities = [providerIdentity, currentJob.workerProcess].filter(Boolean);
      let cleanup = cleanupTaskRuntimeArtifacts(stateDir(root), lineage, identities);
      if (!cleanup.ok) {
        updateJob(root, currentJob.id, (current) => {
          current.pendingTerminal ||= {
            status: current.status,
            phase: current.phase,
            completedAt: current.completedAt,
            error: current.error || null,
            summary: current.summary || null
          };
          current.status = "running";
          current.phase = "cleanup-blocked";
          current.completedAt = null;
          current.progress = "Task finished; runtime cleanup is still pending";
          current.result = applyTaskPrivacy(current.result, cleanup);
          return current;
        });
        return;
      }
      cleanup = includeGuardCleanup(root, currentJob.id, cleanup, { inWorkspaceTransaction: true });
      if (!cleanup.ok) {
        updateJob(root, currentJob.id, (current) => {
          current.pendingTerminal ||= {
            status: current.status,
            phase: current.phase,
            completedAt: current.completedAt,
            error: current.error || null,
            summary: current.summary || null
          };
          current.status = "running";
          current.phase = "cleanup-blocked";
          current.completedAt = null;
          current.progress = "Task finished; runtime cleanup is still pending";
          current.result = applyTaskPrivacy(current.result, cleanup);
          return current;
        });
        return;
      }
      updateJob(root, currentJob.id, (current) => {
        const executionStatus = current.status === "completed"
          ? "completed"
          : current.status === "cancelled"
            ? "cancelled"
            : "failed";
        const evidence = captureTerminalEvidence(root, current, executionStatus);
        const normalizedCurrentError = normalizeTerminalProcessSignalError(
          current.error
        );
        const cleanupSignalError =
          normalizedCurrentError?.code === "E_PROCESS_IDENTITY"
            && normalizedCurrentError.details?.secondaryDiagnostic != null
            ? current.error
            : null;
        const selectedError = selectTaskTerminalError(
          evidence,
          cleanupSignalError ? null : current.error,
          cleanupSignalError
        );
        const finalStatus = selectedError
          ? (selectedError.code === "E_CANCELLED" ? "cancelled" : "failed")
          : current.status;
        current.status = finalStatus;
        current.phase = selectedError?.code === "E_CONTEXT_DRIFT"
          ? "context-rejected"
          : selectedError?.code === "E_SCOPE_VIOLATION"
            ? "scope-rejected"
            : selectedError
              ? finalStatus
              : current.phase;
        current.error = selectedError ? redact(asErrorPayload(selectedError)) : null;
        if (current.error?.message) current.summary = current.error.message;
        current.progress = terminalTaskProgress(finalStatus, current.error);
        evidence.runtimeEvidence.executionStatus = finalStatus === "completed"
          ? "completed"
          : finalStatus === "cancelled"
            ? "cancelled"
            : "failed";
        current.completionContextManifest = evidence.postContext;
        current.result = reconcileTerminalStopReason({
          ...applyTaskPrivacy(current.result, cleanup),
          runtimeEvidence: evidence.runtimeEvidence,
          hostVerification: current.result?.hostVerification || "not_run"
        }, finalStatus);
        return current;
      });
    });
  }
}

async function recoverNonterminalJobs(root) {
  for (const job of listJobs(root).filter((candidate) => !isBrokerDispatch(candidate) && !terminal(candidate))) {
    // Broker-owned spawns deliberately commit before provider launch. Missing
    // process identity is not evidence of loss while that launch boundary is
    // pending, in flight, or explicitly ambiguous.
    if (providerLaunchCleanupBlocked(job)) continue;
    const cleanupBlocked = job.phase === "cleanup-blocked" && Boolean(job.pendingTerminal);
    if (job.status === "queued" && Date.now() - Date.parse(job.createdAt) < 5000) continue;
    const controllerTokenMatches = Boolean(job.controllerProcess?.pid && job.controllerProcess.startToken && processStartToken(job.controllerProcess.pid) === job.controllerProcess.startToken);
    if (!cleanupBlocked && controllerTokenMatches && !processIsZombie(job.controllerProcess.pid)) continue;
    if (!cleanupBlocked && job.workerProcess?.pid && identityMatches(job.workerProcess, job.id, "worker")) continue;
    const workerTokenMatches = Boolean(job.workerProcess?.pid && job.workerProcess.startToken && processStartToken(job.workerProcess.pid) === job.workerProcess.startToken);
    const workerMayStillBeStarting = workerTokenMatches && !processIsZombie(job.workerProcess.pid);
    if (!cleanupBlocked && workerMayStillBeStarting && Date.now() - Date.parse(job.updatedAt || job.startedAt || job.createdAt) < 1500) continue;
    let cleanupError = null;
    let providerIdentity = null;
    let taskCleanup = null;
    let researchCleanup = null;
    try {
      providerIdentity = await terminateProviderCleanupTarget(root, job);
      if (cleanupBlocked) await terminateVerified(job.workerProcess, job.id, "worker");
    } catch (error) { cleanupError = error; }
    if (!cleanupError && job.jobClass === "task") {
      taskCleanup = cleanupTaskRuntimeArtifacts(
        stateDir(root),
        job.request?.providerHomeId || job.id,
        [providerIdentity, job.workerProcess].filter(Boolean)
      );
      taskCleanup = includeGuardCleanup(root, job.id, taskCleanup);
      if (!taskCleanup.ok) {
        cleanupError = new CompanionError("E_STATE", "Task provider exited, but transient runtime cleanup is incomplete.", {
          privacyWarning: taskCleanup.warning
        });
      }
    }
    if (!cleanupError && job.jobClass === "research") {
      researchCleanup = cleanupResearchRuntimeArtifacts(
        stateDir(root),
        job.id,
        [providerIdentity, job.workerProcess].filter(Boolean)
      );
      researchCleanup = includeGuardCleanup(root, job.id, researchCleanup);
      if (!researchCleanup.ok) {
        cleanupError = new CompanionError("E_STATE", "Deep-research provider exited, but transient runtime cleanup is incomplete.", {
          privacyWarning: researchCleanup.warning
        });
      }
    }
    if (cleanupError) {
      updateJob(root, job.id, (current) => {
        if (terminal(current)) return current;
        const priorSignalError = normalizeTerminalProcessSignalError(
          current.error
        );
        const nextCleanupError = normalizeTerminalProcessSignalError(
          cleanupError
        );
        const retainedCleanupError =
          priorSignalError?.code === "E_PROCESS_IDENTITY"
            && priorSignalError.details?.secondaryDiagnostic
            ? priorSignalError
            : nextCleanupError;
        current.phase = "cleanup-blocked";
        current.progress = "Worker lost; provider cleanup could not be verified";
        current.error = redact(asErrorPayload(retainedCleanupError));
        current.summary = current.error.message;
        current.heartbeatAt = now();
        if (current.jobClass === "review") {
          current.result = applyReviewPrivacy(current.result, null, "Isolated review home retained because process cleanup could not be verified.");
        } else if (current.jobClass === "research") {
          current.result = applyResearchPrivacy(
            current.result,
            researchCleanup,
            researchCleanup?.warning || "Research runtime artifacts retained because process cleanup could not be verified."
          );
        } else {
          current.result = applyTaskPrivacy(
            current.result,
            taskCleanup,
            taskCleanup?.warning || "Task runtime artifacts retained because process cleanup could not be verified."
          );
        }
        return current;
      });
      continue;
    }
    let cleanup = !cleanupError && job.jobClass === "review" ? cleanupReviewEnvironment(stateDir(root), job.id) : null;
    if (cleanup) cleanup = includeGuardCleanup(root, job.id, cleanup);
    updateJob(root, job.id, (current) => {
      // The worker can finish between the liveness check above and this locked
      // update. Never turn that freshly completed record into E_WORKER_LOST.
      if (terminal(current)) return current;
      // Re-check the broker launch boundary under the job lock. The outer
      // snapshot is only an optimization and cannot authorize terminalization.
      if (providerLaunchCleanupBlocked(current)) return current;
      Object.assign(current, scrubStoredJob(current));
      const pending = current.pendingTerminal || null;
      const pendingExecutionStatus = pending?.status === "completed"
        ? "completed"
        : pending?.status === "cancelled"
          ? "cancelled"
          : "failed";
      // Research jobs never use TaskEnvelope evidence paths. Task evidence is
      // captured from the authoritative locked record only after cleanup was
      // proven, so a stale outer snapshot cannot mask final workspace drift.
      const evidence = current.jobClass === "research"
        ? { postContext: null, runtimeEvidence: null }
        : captureTerminalEvidence(root, current, pendingExecutionStatus);
      const interruptedError = {
        code: current.jobClass === "research"
          ? "E_WORKFLOW_INCOMPLETE"
          : "E_WORKER_LOST",
        message: current.jobClass === "research"
          ? "The deep-research workflow was interrupted when its worker disappeared; it was not replayed."
          : "The background worker disappeared; the prompt was not replayed."
      };
      const taskError = current.jobClass === "task"
        ? selectTaskTerminalError(
            evidence,
            pending ? pending.error || null : interruptedError,
            current.error || null
          )
        : null;
      const intendedStatus = current.jobClass === "task"
        ? (
            taskError
              ? (taskError.code === "E_CANCELLED" ? "cancelled" : "failed")
              : pending?.status || "failed"
          )
        : pending?.status || "failed";
      current.status = intendedStatus;
      current.phase = taskError
        ? (
            taskError.code === "E_CONTEXT_DRIFT"
              ? "context-rejected"
              : taskError.code === "E_SCOPE_VIOLATION"
                ? "scope-rejected"
                : current.status
          )
        : pending?.phase || (current.status === "completed" ? "done" : current.status);
      current.completedAt = pending?.completedAt || now();
      if (current.jobClass === "task") {
        current.error = taskError ? redact(asErrorPayload(taskError)) : null;
        if (current.error?.message) {
          current.summary = current.error.message;
        } else if (pending?.summary) {
          current.summary = pending.summary;
        }
        current.progress = terminalTaskProgress(current.status, current.error);
        if (evidence.runtimeEvidence) {
          evidence.runtimeEvidence.executionStatus = current.status === "completed"
            ? "completed"
            : current.status === "cancelled"
              ? "cancelled"
              : "failed";
        }
      } else if (pending) {
        current.error = pending.error || null;
        if (pending.summary) current.summary = pending.summary;
      } else {
        current.error = interruptedError;
        if (current.jobClass === "research") {
          current.workflow = {
            ...(current.workflow || {}),
            status: "interrupted"
          };
        }
      }
      if (current.error?.message) current.summary = current.error.message;
      if (current.jobClass !== "research") {
        current.completionContextManifest = evidence.postContext;
      }
      current.result = {
        ...(current.result || {}),
        hostVerification: current.result?.hostVerification || "not_run",
        ...(evidence.runtimeEvidence ? { runtimeEvidence: evidence.runtimeEvidence } : {}),
        replay: false,
        resume: false
      };
      if (cleanup) {
        current.result = applyReviewPrivacy(current.result, cleanup);
      } else if (current.jobClass === "task") {
        current.result = applyTaskPrivacy(current.result, taskCleanup || { ok: true });
      } else if (current.jobClass === "research") {
        current.result = applyResearchPrivacy(current.result, researchCleanup || { ok: true });
      }
      current.result = reconcileTerminalStopReason(
        current.result,
        current.status
      );
      delete current.pendingTerminal;
      current.lifecycleEvents = appendLifecycleEvent(
        current.lifecycleEvents,
        current.error ? "blocked" : "checkpoint",
        current.error?.message || (current.jobClass === "research"
          ? "Deep-research runtime cleanup completed"
          : "Task runtime cleanup completed")
      );
      return current;
    });
  }
}

async function recoverActiveJobs(root) {
  await recoverBrokerOwnedJobs(root);
  recoverTerminalReviewJobs(root);
  recoverTerminalResearchJobs(root);
  recoverTerminalTaskJobs(root);
  await recoverNonterminalJobs(root);
}

export { recoverActiveJobs };
