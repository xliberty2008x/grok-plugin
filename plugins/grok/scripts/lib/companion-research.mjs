import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./args.mjs";
import { CompanionError, asErrorPayload } from "./errors.mjs";
import { processStartToken } from "./process-control.mjs";
import { profileFor } from "./profiles.mjs";
import { applyResearchPrivacy, cleanupResearchRuntimeArtifacts, consumeDeepResearchQuery, DEEP_RESEARCH_KIND, parseDeepResearchOptions, parseDeepResearchQuery, publicResearchReport, runDeepResearch, stageDeepResearchQuery } from "./deep-research.mjs";
import { assertProviderLaunchBinding as assertExecutableProviderLaunchBinding, providerLaunchBindingDigest as digestProviderLaunchBinding } from "./provider-executable-pin.mjs";
import { admitJob, generateId, updateJob, readJob, isCancelRequested, terminal, now } from "./state.mjs";
import { workspaceRoot } from "./workspace.mjs";
import { redact, redactText, sanitizeDisplayText } from "./redact.mjs";
import { readBoundedStdin } from "./stdin.mjs";
import { hostCommand } from "./host.mjs";
import { appendLifecycleEvent } from "./task-lifecycle.mjs";
import { projectWorkerDiagnosticText, projectWorkerHandle } from "./worker-protocol.mjs";
const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "grok-companion.mjs"
);
import { baseRecord, out, providerLaunchBinding, publicJson, renderJob, researchResultJson, stateDir, stdinReadySignal, touchJob, validateModelEffort, workerEnvironment } from "./companion-shared.mjs";

import {
  invalidProviderCapabilityError,
  requiredProviderSpawnBinding
} from "./companion-dispatch.mjs";
import { recoverActiveJobs } from "./companion-recovery.mjs";

async function handleDeepResearch(raw) {
  // Deep-research is a dedicated branch: no TaskEnvelope, mailbox, report repair,
  // rescue resume, or record-verification. Query arrives on private stdin only.
  const { options, positionals } = parseArgs(raw, {
    values: ["model", "effort", "cwd"],
    booleans: ["wait", "background", "web-only", "workspace", "json", "query-stdin", "stdin-ready"]
  });
  if (positionals.length) {
    throw new CompanionError(
      "E_USAGE",
      "Deep-research query must be supplied on private stdin via --query-stdin; positional query text is refused."
    );
  }
  if (!options["query-stdin"]) {
    throw new CompanionError("E_USAGE", "Deep-research requires --query-stdin for private query ingress.");
  }
  if (options["stdin-ready"] && !options["query-stdin"]) {
    throw new CompanionError("E_USAGE", "--stdin-ready requires --query-stdin.");
  }
  const researchOptions = parseDeepResearchOptions({
    wait: options.wait,
    background: options.background,
    "web-only": options["web-only"],
    workspace: options.workspace,
    model: options.model,
    effort: options.effort
  });
  if (options.model || options.effort) validateModelEffort(options);
  const query = parseDeepResearchQuery(await readBoundedStdin({
    limitBytes: 32 * 1024,
    label: "Deep-research query",
    onReady: stdinReadySignal(options["stdin-ready"])
  }));
  const root = workspaceRoot(options.cwd ? path.resolve(options.cwd) : process.cwd());
  const profile = researchOptions.workspace
    ? profileFor("deep-research-workspace")
    : profileFor("deep-research");
  // Deep-research uses a dedicated detached launcher, but it must retain the
  // same setup-owned executable identity as broker-dispatched tasks. Ambient
  // GROK_BIN/PATH discovery is intentionally unavailable to the worker.
  const providerSpawnBinding = requiredProviderSpawnBinding();
  const id = generateId(DEEP_RESEARCH_KIND);
  const stagedQuery = stageDeepResearchQuery(stateDir(root), id, query);
  const job = baseRecord({
    id,
    kind: DEEP_RESEARCH_KIND,
    root,
    profile,
    title: "Deep-research query",
    request: {
      queryDigest: stagedQuery.digest,
      queryBytes: stagedQuery.bytes,
      researchOptions: {
        background: researchOptions.background,
        webOnly: researchOptions.webOnly,
        workspace: researchOptions.workspace
      },
      publicObjective: null,
      spawn: providerSpawnBinding
    },
    write: false,
    model: researchOptions.model || options.model || null,
    effort: researchOptions.effort || options.effort || null,
    lifecycleEvents: appendLifecycleEvent([], "task.accepted", "Deep-research accepted", {
      mode: researchOptions.workspace ? "workspace" : "web-only"
    })
  });
  job.progress = "Deep-research accepted";
  job.summary = "Deep-research accepted";
  job.workflow = null;
  let finished;
  try {
    finished = await startDeepResearchJob(root, job, researchOptions.background, {
      announce: researchOptions.wait && !options.json
    });
  } catch (error) {
    cleanupResearchRuntimeArtifacts(stateDir(root), id, []);
    throw error;
  }
  const finishedHandle = projectWorkerHandle(finished);
  out(
    options.json
      ? (researchOptions.background ? publicJson(finished) : researchResultJson(finished))
      : researchOptions.background
        ? `Grok deep-research started in the background.\nJob: ${finishedHandle.id}\nPhase: ${finishedHandle.phase || "unknown"}\nProgress: ${finishedHandle.progress || finishedHandle.summary || "Deep-research accepted"}\nCheck: ${hostCommand("status", finishedHandle.id)}`
        : renderJob(finished, { includeResearchReport: true }),
    options.json
  );
}

async function startDeepResearchJob(root, job, background, { announce = false } = {}) {
  const nonce = crypto.randomBytes(16).toString("hex");
  job.workerAuthorization = nonce;
  admitJob(root, job);
  let diagnostic = "";
  let launcher = null;
  let launcherCode = -1;
  try {
    // Detached launcher pattern: launcher records an owned child and exits;
    // --wait polls the durable job, --background returns immediately.
    launcher = spawn(process.execPath, [SCRIPT, "--launch-deep-research", job.id, "--cwd", root], {
      cwd: root,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      env: workerEnvironment(nonce)
    });
    launcher.stderr?.setEncoding("utf8");
    launcher.stderr?.on("data", (chunk) => { diagnostic = `${diagnostic}${chunk}`.slice(-8192); });
    launcherCode = await new Promise((resolve) => {
      launcher.once("error", (error) => { diagnostic = sanitizeDisplayText(error.message); resolve(-1); });
      launcher.once("close", resolve);
    });
  } catch (error) {
    diagnostic = sanitizeDisplayText(error.message);
  }
  if (launcherCode !== 0) {
    const cleanup = cleanupResearchRuntimeArtifacts(stateDir(root), job.id, []);
    updateJob(root, job.id, (current) => {
      const intendedTerminal = {
        status: "failed",
        phase: "failed",
        completedAt: now(),
        error: {
          code: "E_WORKER_LOST",
          message: redactText(diagnostic) || "Could not launch the isolated deep-research worker."
        }
      };
      if (cleanup.ok) {
        current.status = intendedTerminal.status;
        current.phase = intendedTerminal.phase;
        current.completedAt = intendedTerminal.completedAt;
      } else {
        current.pendingTerminal = {
          ...intendedTerminal,
          summary: intendedTerminal.error.message
        };
        current.status = "running";
        current.phase = "cleanup-blocked";
        current.completedAt = null;
      }
      current.error = intendedTerminal.error;
      current.summary = current.error.message;
      current.progress = cleanup.ok
        ? current.summary
        : "Deep-research launch failed; private query cleanup is pending";
      current.result = applyResearchPrivacy({
        hostVerification: "not_run",
        workflow: null,
        researchReport: null,
        replay: false,
        resume: false
      }, cleanup);
      current.lifecycleEvents = appendLifecycleEvent(current.lifecycleEvents, "blocked", current.error.message);
      return current;
    });
  }
  if (background) return readJob(root, job.id);
  let finished = readJob(root, job.id);
  let lastRecovery = 0;
  let lastProgressSignature = null;
  while (!terminal(finished)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (Date.now() - lastRecovery >= 500) {
      lastRecovery = Date.now();
      await recoverActiveJobs(root);
    }
    finished = readJob(root, job.id);
    if (announce) {
      const signature = JSON.stringify([
        finished.phase,
        finished.workflow?.revision ?? null,
        finished.workflow?.status ?? null,
        finished.workflow?.currentPhase ?? null
      ]);
      if (signature !== lastProgressSignature) {
        lastProgressSignature = signature;
        const rawPhase = finished.workflow?.currentPhase
          || finished.workflow?.status
          || finished.phase
          || "running";
        const phase = projectWorkerDiagnosticText(String(rawPhase), {
          job: finished,
          maxBytes: 160
        }) || "running";
        const agents = Number.isSafeInteger(finished.workflow?.activeAgents)
          ? `; active agents ${finished.workflow.activeAgents}`
          : "";
        process.stderr.write(`Deep-research: ${phase}${agents}\n`);
      }
    }
  }
  if (finished.status === "failed" || finished.status === "cancelled") {
    throw new CompanionError(
      finished.error?.code || "E_PROVIDER_EXIT",
      finished.error?.message || diagnostic || "Deep-research job failed.",
      finished.error?.details
    );
  }
  return finished;
}

async function executeDeepResearch(root, id) {
  const workerNonce = process.env.GROK_COMPANION_WORKER_NONCE;
  let job = updateJob(root, id, (current) => {
    if (terminal(current)) return current;
    current.status = "running";
    current.phase = "starting";
    current.startedAt = current.startedAt || now();
    current.workerProcess = {
      pid: process.pid,
      startToken: processStartToken(process.pid),
      nonce: workerNonce || current.workerAuthorization || null,
      processGroupId: process.platform === "win32" ? null : process.pid,
      commandMarker: id
    };
    current.progress = "Deep-research provider starting";
    current.lifecycleEvents = appendLifecycleEvent(
      current.lifecycleEvents,
      "checkpoint",
      "Deep-research provider starting"
    );
    return touchJob(current);
  });
  if (terminal(job)) return;
  let query = null;
  const heartbeatTimer = setInterval(() => {
    try {
      updateJob(root, id, (current) => (terminal(current) ? current : touchJob(current)));
    } catch { /* best effort */ }
  }, 1000);
  heartbeatTimer.unref?.();
  try {
    const providerLaunchBinding = assertExecutableProviderLaunchBinding(
      job.request?.spawn?.providerLaunchBinding
    );
    if (digestProviderLaunchBinding(providerLaunchBinding)
        !== job.request?.spawn?.providerLaunchBindingDigest) {
      throw invalidProviderCapabilityError();
    }
    query = consumeDeepResearchQuery(
      stateDir(root),
      id,
      job.request?.queryDigest
    );
    if (isCancelRequested(root, id, workerNonce)) {
      throw new CompanionError("E_CANCELLED", "Deep-research was cancelled before provider execution.");
    }
    const result = await runDeepResearch({
      root,
      profile: job.profile,
      query,
      options: job.request?.researchOptions || {},
      stateDir: stateDir(root),
      jobMarker: id,
      model: job.model,
      effort: job.effort,
      providerExecutableBinding: providerLaunchBinding,
      cancelRequested: () => isCancelRequested(root, id, workerNonce),
      onEvent: (event) => {
        try {
          if (event?.type === "workflow") {
            updateJob(root, id, (current) => {
              if (terminal(current)) return current;
              current.workflow = {
                runId: event.runId || null,
                revision: event.revision ?? null,
                status: event.status || null,
                phases: event.phases || [],
                currentPhase: event.currentPhase ?? null,
                elapsedMs: event.elapsedMs ?? 0,
                agentsUsed: event.agentsUsed ?? 0,
                agentBudget: event.agentBudget ?? null,
                usageIncomplete: Boolean(event.usageIncomplete),
                activeAgents: event.activeAgents ?? null,
                agentLaunches: event.agentLaunches ?? null,
                pauseMessage: event.pauseMessage ?? null
              };
              current.progress = `Workflow ${event.status || "running"}${event.runId ? ` (${event.runId})` : ""}`.slice(0, 160);
              current.phase = "researching";
              return touchJob(current);
            });
          } else if (event?.type === "launch-ack") {
            updateJob(root, id, (current) => {
              if (terminal(current)) return current;
              current.grokSessionId = event.sessionId || current.grokSessionId;
              current.progress = "Deep-research launch acknowledged; waiting for workflow";
              current.phase = "launched";
              current.lifecycleEvents = appendLifecycleEvent(
                current.lifecycleEvents,
                "checkpoint",
                "Deep-research launch acknowledged"
              );
              return touchJob(current);
            });
          } else if (event?.type === "session") {
            updateJob(root, id, (current) => {
              if (terminal(current)) return current;
              current.grokSessionId = event.sessionId || current.grokSessionId;
              return touchJob(current);
            });
          } else if (event?.type === "provider" && event.process) {
            updateJob(root, id, (current) => {
              if (terminal(current)) return current;
              current.providerProcess = event.process;
              return touchJob(current);
            });
          }
        } catch { /* progress updates are best effort */ }
      }
    });
    const researchReport = result.researchReport
      ? {
          ...result.researchReport,
          textPreview: publicResearchReport(result.researchReport)?.textPreview || null
        }
      : null;
    const providerIdentity = result.provider?.process || null;
    const cleanup = cleanupResearchRuntimeArtifacts(
      stateDir(root),
      id,
      [providerIdentity].filter(Boolean)
    );
    if (!cleanup.ok) {
      throw new CompanionError(
        "E_STATE",
        cleanup.warning || "Deep-research cleanup could not be verified."
      );
    }
    // Commit terminal success only after provider exit and private-home cleanup.
    updateJob(root, id, (current) => {
      current.status = "completed";
      current.phase = "done";
      current.completedAt = now();
      current.grokSessionId = result.sessionId || current.grokSessionId;
      current.workflow = result.workflow || current.workflow;
      current.summary = `Deep-research completed (${researchReport?.status || researchReport?.assessment || "verified"})`;
      current.progress = current.summary;
      current.result = applyResearchPrivacy({
        hostVerification: "not_run",
        capabilityReceipt: result.capabilityReceipt || null,
        workflow: result.workflow || null,
        researchReport: researchReport
          ? {
              schemaVersion: 1,
              valid: researchReport.valid,
              runId: researchReport.runId,
              path: researchReport.path,
              bytes: researchReport.bytes,
              sha256: researchReport.sha256,
              sourceCount: researchReport.sourceCount,
              coverageNotes: researchReport.coverageNotes,
              status: researchReport.status || researchReport.assessment || "partial",
              hostVerification: "not_run",
              markdown: researchReport.markdown || researchReport.text,
              textPreview: researchReport.textPreview
            }
          : null,
        workspaceSnapshot: result.workspaceSnapshot || null,
        webFetchAttestation: result.webFetchAttestation || null,
        stopReason: result.stopReason || "workflow_complete"
      }, cleanup);
      current.lifecycleEvents = appendLifecycleEvent(
        current.lifecycleEvents,
        "checkpoint",
        current.summary
      );
      return touchJob(current);
    });
  } catch (error) {
    const payload = redact(asErrorPayload(error));
    const status = payload.code === "E_CANCELLED" ? "cancelled" : "failed";
    let failureCleanup = null;
    try {
      const latest = readJob(root, id);
      failureCleanup = cleanupResearchRuntimeArtifacts(
        stateDir(root),
        id,
        [latest.providerProcess].filter(Boolean)
      );
    } catch (cleanupError) {
      failureCleanup = { ok: false, warning: cleanupError?.message || String(cleanupError) };
    }
    updateJob(root, id, (current) => {
      const intendedTerminal = {
        status,
        phase: status,
        completedAt: now(),
        error: payload,
        summary: payload.message
      };
      if (!failureCleanup?.ok) {
        current.pendingTerminal = intendedTerminal;
        current.status = "running";
        current.phase = "cleanup-blocked";
        current.completedAt = null;
      } else {
        current.status = status;
        current.phase = status;
        current.completedAt = intendedTerminal.completedAt;
        delete current.pendingTerminal;
      }
      current.error = payload;
      current.summary = payload.message;
      current.progress = failureCleanup?.ok
        ? payload.message
        : "Deep-research finished; runtime cleanup is still pending";
      current.workflow = error?.details?.workflow || current.workflow || null;
      current.result = applyResearchPrivacy({
        hostVerification: "not_run",
        workflow: current.workflow,
        researchReport: error?.details?.researchReport
          ? publicResearchReport(error.details.researchReport)
          : null,
        replay: false,
        resume: false
      }, failureCleanup);
      current.lifecycleEvents = appendLifecycleEvent(
        current.lifecycleEvents,
        "blocked",
        payload.message
      );
      return touchJob(current);
    });
  } finally {
    clearInterval(heartbeatTimer);
  }
}

export { executeDeepResearch, handleDeepResearch };
