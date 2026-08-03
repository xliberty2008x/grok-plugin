import path from "node:path";
import process from "node:process";
import { parseArgs } from "./args.mjs";
import { CompanionError, asErrorPayload } from "./errors.mjs";
import { cleanupReviewEnvironment } from "./provider-credentials.mjs";
import { cleanupTaskRuntimeArtifacts } from "./provider-controller-environments.mjs";
import { applyResearchPrivacy, cleanupResearchRuntimeArtifacts } from "./deep-research.mjs";
import { updateJob, listJobs, listStatusReadonly, readJob, readJobStatusReadonly, selectJob, requestCancel, terminal, now } from "./state.mjs";
import { workspaceRoot } from "./workspace.mjs";
import { redact } from "./redact.mjs";
import { hostCommand, sameHostSession } from "./host.mjs";
import { appendLifecycleEvent } from "./task-lifecycle.mjs";
import { scrubStoredJob } from "./task-envelope.mjs";
import { cancelWorker, cancellationNonce } from "./worker-mutation.mjs";
import { reconcileBrokerWorkers } from "./worker-recovery.mjs";
import { captureTerminalEvidence, selectTaskTerminalError, terminalTaskProgress } from "./task-terminal-evidence.mjs";
import { isSupportedWorkerDispatch } from "./worker-launch-contract.mjs";
import { applyReviewPrivacy, applyTaskPrivacy, argvFrom, assertHostJobAccess, currentHost, includeGuardCleanup, out, publicJson, recheckCancelLaunchSettlement, reconcileTerminalStopReason, renderJob, renderReview, renderStatusTable, researchResultJson, stateDir, terminateProviderCleanupTarget, terminateVerified } from "./companion-shared.mjs";

import { recoverActiveJobs } from "./companion-recovery.mjs";

async function handleStatus(raw) {
  const { options, positionals } = parseArgs(argvFrom(raw), {
    values: ["timeout-ms", "cwd"],
    booleans: ["wait", "all", "json", "readonly"]
  });
  if (positionals.length > 1) throw new CompanionError("E_USAGE", "Status accepts at most one job ID.");
  if (options.readonly) {
    if (options.wait || options["timeout-ms"] != null) {
      throw new CompanionError(
        "E_USAGE",
        "status --readonly cannot be combined with --wait or --timeout-ms; use default status for recovery waits."
      );
    }
    const root = workspaceRoot(options.cwd ? path.resolve(options.cwd) : process.cwd());
    const host = currentHost();
    if (positionals[0]) {
      const { job } = readJobStatusReadonly(root, positionals[0]);
      const value = assertHostJobAccess(job, "status");
      if (options.json) out(publicJson(value, { detail: true }), true);
      else out(renderJob(value));
      return;
    }
    const { jobs, migrationRequired } = listStatusReadonly(root);
    let value = jobs;
    if (!options.all) {
      if (!host.sessionId) {
        throw new CompanionError(
          "E_JOB_NOT_FOUND",
          "Current host session identity is unavailable; provide an explicit job ID or pass --all."
        );
      }
      value = jobs.filter((job) => sameHostSession(job, host));
    }
    if (options.json) {
      if (options.all) {
        out({ jobs: publicJson(value, { detail: false }), migrationRequired: Boolean(migrationRequired) }, true);
      } else {
        out(publicJson(value, { detail: false }), true);
      }
      return;
    }
    const table = renderStatusTable(value);
    if (options.all && migrationRequired) {
      table.push("", "migrationRequired: true (valid legacy state is pending; pure preflight did not migrate)");
    }
    out(table.join("\n"));
    return;
  }
  const root = workspaceRoot(options.cwd ? path.resolve(options.cwd) : process.cwd()); await recoverActiveJobs(root);
  if (positionals[0]) assertHostJobAccess(readJob(root, positionals[0]), "status");
  if (positionals[0] && options.wait) {
    const requested = Number(options["timeout-ms"] || 240000);
    if (!Number.isFinite(requested) || requested < 0) throw new CompanionError("E_USAGE", "--timeout-ms must be a non-negative number.");
    const timeout = Math.min(requested, 900000), start = Date.now();
    while (!terminal(readJob(root, positionals[0])) && Date.now() - start < timeout) { await new Promise((r) => setTimeout(r, 250)); await recoverActiveJobs(root); }
  }
  const host = currentHost();
  let value;
  if (positionals[0]) value = assertHostJobAccess(readJob(root, positionals[0]), "status");
  else if (options.all) value = listJobs(root);
  else {
    if (!host.sessionId) throw new CompanionError("E_JOB_NOT_FOUND", "Current host session identity is unavailable; provide an explicit job ID or pass --all.");
    value = listJobs(root).filter((job) => sameHostSession(job, host));
  }
  if (options.json) {
    out(publicJson(value, { detail: !options.all }), true);
  } else if (Array.isArray(value)) {
    out(renderStatusTable(value).join("\n"));
  } else {
    out(renderJob(value));
  }
}

async function handleResult(raw) {
  const { options, positionals } = parseArgs(argvFrom(raw), { values: ["cwd"], booleans: ["json"] }); const root = workspaceRoot(options.cwd ? path.resolve(options.cwd) : process.cwd()); await recoverActiveJobs(root); const job = assertHostJobAccess(selectJob(root, { id: positionals[0], host: currentHost(), finished: !positionals[0] }), "result");
  if (!terminal(job)) throw new CompanionError("E_JOB_ACTIVE", `Job ${job.id} is still ${job.status}; run ${hostCommand("status", `${job.id} --wait`)}.`);
  out(
    options.json
      ? (job.jobClass === "research" ? researchResultJson(job) : publicJson(job))
      : job.jobClass === "review"
        ? renderReview(job)
        : renderJob(job, { includeResearchReport: job.jobClass === "research" }),
    options.json
  );
}

async function handleCancel(raw) {
  const { options, positionals } = parseArgs(argvFrom(raw), { values: ["cwd"], booleans: ["json"] }); const root = workspaceRoot(options.cwd ? path.resolve(options.cwd) : process.cwd()); await recoverActiveJobs(root); const job = assertHostJobAccess(selectJob(root, { id: positionals[0], host: currentHost(), active: !positionals[0] }), "active");
  if (isSupportedWorkerDispatch(job.request?.spawn?.dispatch)) {
    const host = currentHost();
    if (host.kind !== "codex" || !host.sessionId) {
      throw new CompanionError("E_AUTH_REQUIRED", "Trusted Codex task identity is unavailable.");
    }
    cancelWorker({
      root,
      principal: { hostKind: "codex", threadId: host.sessionId },
      workerId: job.id,
      idempotencyKey: `cli-cancel-${job.id}`
    });
    const deadline = Date.now() + 10000;
    let current = readJob(root, job.id);
    while (!terminal(current) && Date.now() < deadline) {
      await reconcileBrokerWorkers({
        root,
        principal: { hostKind: "codex", threadId: host.sessionId },
        dispatchStartupGraceMs: 0
      });
      current = readJob(root, job.id);
      if (!terminal(current)) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    out(options.json ? publicJson(current) : `Cancellation requested.\n${renderJob(current)}`, options.json);
    return;
  }
  // Launch window: workerAuthorization is persisted before workerProcess exists.
  // Prefer the live worker nonce; fall back to the authenticated launch nonce; fail closed if neither.
  if (!terminal(job)) requestCancel(root, job.id, cancellationNonce(job) || "");
  const deadline = Date.now() + 10000; let current = readJob(root, job.id); while (!terminal(current) && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 200)); current = readJob(root, job.id); }
  if (!terminal(current)) {
    // The timeout snapshot cannot authorize teardown. Re-read and classify under
    // the per-job update lock so a launch-window authorization or settlement
    // committed during the wait wins before any process signal or runtime cleanup.
    const settlement = recheckCancelLaunchSettlement(root, current.id);
    current = settlement.job;
    if (settlement.retained) {
      out(options.json ? publicJson(current) : `Cancellation requested.\n${renderJob(current)}`, options.json);
      return;
    }
  }
  if (!terminal(current)) {
    const forcedTerminal = {
      status: "cancelled",
      phase: "cancelled",
      completedAt: now(),
      error: { code: "E_CANCELLED", message: "Grok job was force-cancelled after the graceful timeout." },
      summary: "Grok job was force-cancelled after the graceful timeout."
    };
    let providerIdentity = null;
    try {
      providerIdentity = await terminateProviderCleanupTarget(root, current);
      await terminateVerified(current.workerProcess, current.id, "worker");
    } catch (error) {
      const payload = redact(asErrorPayload(error));
      const blocked = updateJob(root, current.id, (value) => {
        if (terminal(value)) return value;
        value.pendingTerminal = forcedTerminal;
        value.status = "running";
        value.phase = "cleanup-blocked";
        value.completedAt = null;
        value.error = payload;
        value.summary = payload.message;
        value.progress = "Cancellation requested; process cleanup is still pending";
        if (value.jobClass === "review") {
          value.result = applyReviewPrivacy(value.result, null, "Isolated review home retained because force-cancel process cleanup could not be verified.");
        } else if (value.jobClass === "research") {
          value.result = applyResearchPrivacy(value.result, null, "Research runtime artifacts retained because force-cancel process cleanup could not be verified.");
        } else {
          value.result = applyTaskPrivacy(value.result, null, "Task runtime artifacts retained because force-cancel process cleanup could not be verified.");
        }
        return value;
      });
      if (terminal(blocked)) {
        out(
          options.json
            ? publicJson(blocked)
            : `Cancellation requested.\n${renderJob(blocked)}`,
          options.json
        );
        return;
      }
      throw error;
    }
    let taskCleanup = current.jobClass === "task"
      ? cleanupTaskRuntimeArtifacts(
        stateDir(root),
        current.request?.providerHomeId || current.id,
        [providerIdentity, current.workerProcess].filter(Boolean)
      )
      : null;
    if (taskCleanup) taskCleanup = includeGuardCleanup(root, current.id, taskCleanup);
    if (taskCleanup && !taskCleanup.ok) {
      const blocked = updateJob(root, current.id, (value) => {
        if (terminal(value)) return value;
        value.pendingTerminal = forcedTerminal;
        value.status = "running";
        value.phase = "cleanup-blocked";
        value.completedAt = null;
        value.error = { code: "E_STATE", message: "Task was stopped, but transient runtime cleanup is incomplete.", details: { privacyWarning: taskCleanup.warning } };
        value.summary = value.error.message;
        value.result = applyTaskPrivacy(value.result, taskCleanup);
        return value;
      });
      if (terminal(blocked)) {
        out(
          options.json
            ? publicJson(blocked)
            : `Cancellation requested.\n${renderJob(blocked)}`,
          options.json
        );
        return;
      }
      throw new CompanionError("E_STATE", "Task was stopped, but transient runtime cleanup is incomplete.", { privacyWarning: taskCleanup.warning });
    }
    let researchCleanup = current.jobClass === "research"
      ? cleanupResearchRuntimeArtifacts(
        stateDir(root),
        current.id,
        [providerIdentity, current.workerProcess].filter(Boolean)
      )
      : null;
    if (researchCleanup) researchCleanup = includeGuardCleanup(root, current.id, researchCleanup);
    if (researchCleanup && !researchCleanup.ok) {
      const blocked = updateJob(root, current.id, (value) => {
        if (terminal(value)) return value;
        value.pendingTerminal = forcedTerminal;
        value.status = "running";
        value.phase = "cleanup-blocked";
        value.completedAt = null;
        value.error = {
          code: "E_STATE",
          message: "Deep-research was stopped, but transient runtime cleanup is incomplete.",
          details: { privacyWarning: researchCleanup.warning }
        };
        value.summary = value.error.message;
        value.result = applyResearchPrivacy(value.result, researchCleanup);
        return value;
      });
      if (terminal(blocked)) {
        out(
          options.json
            ? publicJson(blocked)
            : `Cancellation requested.\n${renderJob(blocked)}`,
          options.json
        );
        return;
      }
      throw new CompanionError(
        "E_STATE",
        "Deep-research was stopped, but transient runtime cleanup is incomplete.",
        { privacyWarning: researchCleanup.warning }
      );
    }
    let cleanup = current.jobClass === "review" ? cleanupReviewEnvironment(stateDir(root), current.id) : null;
    if (cleanup) cleanup = includeGuardCleanup(root, current.id, cleanup);
    current = updateJob(root, current.id, (value) => {
      // A worker may publish its terminal result while force-cancel is
      // completing exact process/runtime cleanup. The locked terminal record
      // is authoritative and must never be replaced by a stale cancellation
      // snapshot.
      if (terminal(value)) return value;
      const forcedError = {
        code: "E_CANCELLED",
        message: "Grok job was force-cancelled after the graceful timeout."
      };
      // Final evidence is captured only after exact process/runtime cleanup and
      // under terminal publication authority. A stale pre-lock observation
      // cannot mask task-relevant drift that occurs during cleanup.
      const evidence = value.jobClass === "research"
        ? { postContext: null, runtimeEvidence: null }
        : captureTerminalEvidence(root, value, "cancelled");
      const selectedError = value.jobClass === "task"
        ? selectTaskTerminalError(
            evidence,
            forcedError,
            value.error || null
          )
        : forcedError;
      const finalStatus = selectedError?.code === "E_CANCELLED"
        ? "cancelled"
        : "failed";
      value.status = finalStatus;
      value.phase = selectedError?.code === "E_CONTEXT_DRIFT"
        ? "context-rejected"
        : selectedError?.code === "E_SCOPE_VIOLATION"
          ? "scope-rejected"
          : finalStatus;
      value.completedAt = now();
      value.error = redact(asErrorPayload(selectedError || forcedError));
      value.summary = value.error.message;
      value.progress = value.jobClass === "task"
        ? terminalTaskProgress(finalStatus, value.error)
        : value.progress;
      Object.assign(value, scrubStoredJob(value));
      if (value.jobClass !== "research") {
        value.completionContextManifest = evidence.postContext;
      }
      if (evidence.runtimeEvidence) {
        evidence.runtimeEvidence.executionStatus = finalStatus === "cancelled"
          ? "cancelled"
          : "failed";
      }
      value.result = {
        ...(value.result || {}),
        hostVerification: value.result?.hostVerification || "not_run",
        ...(evidence.runtimeEvidence ? { runtimeEvidence: evidence.runtimeEvidence } : {}),
        replay: false,
        resume: false
      };
      value.lifecycleEvents = appendLifecycleEvent(value.lifecycleEvents, "blocked", value.error.message);
      // Additive/clearing privacy: success clears a stale warning; failure appends without erasing prior evidence.
      if (cleanup) value.result = applyReviewPrivacy(value.result, cleanup);
      if (taskCleanup) value.result = applyTaskPrivacy(value.result, taskCleanup);
      if (researchCleanup) value.result = applyResearchPrivacy(value.result, researchCleanup);
      value.result = reconcileTerminalStopReason(value.result, finalStatus);
      return value;
    });
  }
  out(options.json ? publicJson(current) : `Cancellation requested.\n${renderJob(current)}`, options.json);
}

export { handleCancel, handleResult, handleStatus };
