#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { splitArgs, parseArgs } from "./lib/args.mjs";
import { CompanionError, asErrorPayload, attachTransferCleanupEvidence, exitCodeFor } from "./lib/errors.mjs";
import { collectContext, resolveTarget, integritySnapshot, assertUnchanged } from "./lib/git-review.mjs";
import {
  assertProviderPlatform,
  assertTransferEffort,
  childEnvironment,
  captureSpawnIdentity,
  cleanupReviewEnvironment,
  cleanupTaskRuntimeArtifacts,
  gatedCleanupReviewEnvironment,
  discoverGrok,
  ensureChildExit,
  formatResumeCommand,
  listAdvertisedModels,
  probe,
  providerCleanupIdentity,
  runProvider,
  runStructuredReview,
  selectTransferModel,
  grokVersion,
  processStartToken,
  waitForImportedSession
} from "./lib/grok-provider.mjs";
import { profileFor, sameSecurityProfile } from "./lib/profiles.mjs";
import {
  applyResearchPrivacy,
  cleanupResearchRuntimeArtifacts,
  consumeDeepResearchQuery,
  DEEP_RESEARCH_KIND,
  parseDeepResearchOptions,
  parseDeepResearchQuery,
  publicResearchReport,
  runDeepResearch,
  stageDeepResearchQuery
} from "./lib/deep-research.mjs";
import {
  clearProviderCapabilityReceipt,
  readValidProviderCapabilityReceipt,
  writeProviderCapabilityReceipt
} from "./lib/provider-capability.mjs";
import {
  assertProviderLaunchBinding as assertExecutableProviderLaunchBinding,
  providerLaunchBindingDigest as digestProviderLaunchBinding,
  publishProviderExecutablePin
} from "./lib/provider-executable-pin.mjs";
import { admitJob, appendJobLog, config, setConfig, generateId, writeJob, updateJob, listJobs, listStatusReadonly, readJob, readJobStatusReadonly, selectJob, requestCancel, isCancelRequested, terminal, now, retain, logFile, withWorkspaceAdmission, withWorkspaceStateTransaction } from "./lib/state.mjs";
import { resolveControlWorkspace, workspaceRoot, workspaceState } from "./lib/workspace.mjs";
import { redact, redactText, sanitizeDisplayText } from "./lib/redact.mjs";
import { readBoundedStdin, STDIN_READY_MARKER } from "./lib/stdin.mjs";
import { hasGrokAncestor, identityMatches, processGroupAlive, processGroupGone, processIsZombie, signalOwnedProcess, terminateOwnedProcess } from "./lib/process-control.mjs";
import {
  hasForeignActiveProvider,
  registerProviderGuard,
  resolveProviderCleanupTarget,
  unregisterProviderGuard,
  unregisterProviderGuardInWorkspaceTransaction
} from "./lib/recursion-guard.mjs";
import { hostCommand, hostContext, jobHostContext, missingInvalidProviderCapabilityReceiptMessage, pluginDataRoot, readCodexSessionMetadata, sameHostSession } from "./lib/host.mjs";
import { codexTranscriptToClaude, createAnonymousTranscript, disposeConvertedTranscript, openTranscriptSource, readTranscriptSnapshot } from "./lib/transcript.mjs";
import {
  appendLifecycleEvent,
  assertContextCompatible,
  assertContextManifestIntegrity,
  assertTaskContextReady,
  boundPathEvidence,
  buildRuntimeEvidence,
  buildTaskEnvelope,
  buildWorkerReport,
  buildWorkerReportOutputSchema,
  captureContextManifest,
  composeProviderPrompt,
  composeWorkerReportRepairPrompt,
  evaluateScope,
  observeChangedPaths,
  parseTaskEnvelopeInput,
  scrubStoredJob
} from "./lib/task-contract.mjs";
import {
  projectWorkerDiagnosticText,
  projectWorkerHandle,
  projectWorkerError,
  projectWorkerPublicText,
  projectWorkerSnapshot
} from "./lib/worker-protocol.mjs";
import { CONTEXT_BINDING_MODE, verifyJobEffectivePrompt } from "./lib/worker-context.mjs";
import {
  assertDispatchContract,
  assertWorkerProviderLaunchPreparation,
  authorizeWorkerProviderRotation,
  cancelWorker,
  cancellationNonce,
  prepareDispatchProcessSpawn,
  prepareWorkerProviderSpawn,
  recordWorkerProviderSpawnNoChild,
  recordWorkerProviderRotationNoChild,
  recordUnsettledProviderProcess,
  recordUnsettledWorkerProcess,
  recordDispatchProcessNoChild,
  settlePreProviderWorkerFinalization,
  settleProviderStartedWorkerFinalization,
  transitionWorkerDispatch
} from "./lib/worker-mutation.mjs";
import { providerLaunchCleanupBlocked } from "./lib/worker-reconcile.mjs";
import { reconcileBrokerWorkers, recoverLostProviderStartedWorker } from "./lib/worker-recovery.mjs";
import {
  captureTerminalEvidence,
  normalizeTerminalProcessSignalError,
  selectTaskTerminalError,
  terminalTaskProgress
} from "./lib/task-terminal-evidence.mjs";
import {
  assertWorkerAuthorization,
  createDispatchOutbox,
  createProviderGuardBindingForJob,
  createWorkerAuthorization,
  isDispatchV2,
  isSupportedWorkerDispatch,
  workerLaunchDigest
} from "./lib/worker-launch-contract.mjs";
import { launchCommittedWorker } from "./lib/worker-runtime.mjs";
import { materializeRole } from "./lib/worker-roles.mjs";
import { attachHostActionRequestToJob } from "./lib/worker-host-actions.mjs";
import {
  assertNoRetainedBodies,
  composeMailboxTurnPrompt,
  contentDigestOf as mailboxContentDigest,
  drainWorkerMailbox,
  openAttemptMailbox,
  readAttemptMailbox,
  recordPrimaryTurn,
  selectFinalReportSequence,
  settleInterruptedAttempt,
  stableDigest as mailboxStableDigest
} from "./lib/worker-mailbox.mjs";

import {
  TRANSFER_SESSION_ID_PATTERN,
  appendLog,
  applyReviewPrivacy,
  applyTaskPrivacy,
  argvFrom,
  assertExecutableWorkerBinding,
  assertHostJobAccess,
  assertPromptProviderLaunchBinding,
  baseRecord,
  boundedLogEvent,
  boundedProviderText,
  currentHost,
  eventUpdater,
  exactProviderRotationIntentStatus,
  includeGuardCleanup,
  loadTemplate,
  out,
  parseVerificationRecord,
  primaryTurnAdmissionTestHooks,
  projectTransferCliError,
  providerLaunchBinding,
  providerOutputSchemaDigest,
  publicJson,
  readPrivateEnvelopeFile,
  reconcileTerminalStopReason, recordLifecycle,
  renderJob,
  renderReview,
  researchResultJson,
  sessionId,
  settlePendingProviderRotationNoChild,
  stateDir,
  stdinReadySignal,
  terminateVerified,
  textEvidence,
  touchJob,
  usage,
  validateModelEffort,
  workerEnvironment
} from "./lib/companion-shared.mjs";
import { recoverActiveJobs } from "./lib/companion-recovery.mjs";
import { invalidProviderCapabilityError, requiredProviderSpawnBinding, startJob } from "./lib/companion-dispatch.mjs";
import { handleCancel, handleResult, handleStatus } from "./lib/companion-status.mjs";

import { execute } from "./lib/companion-task-executor.mjs";
import { handleRecordVerification, handleReview, handleSetup, handleTask, resumeCandidate } from "./lib/companion-handlers.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
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

function importedSessionId(output) {
  const ids = new Set();
  for (const line of String(output).split(/\r?\n/).filter(Boolean)) {
    let value;
    try { value = JSON.parse(line); } catch { throw new CompanionError("E_IMPORT_RESULT", "Grok import returned malformed NDJSON."); }
    for (const key of ["sessionId", "session_id", "grokSessionId", "grok_session_id"]) {
      if (typeof value?.[key] === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value[key])) ids.add(value[key]);
    }
  }
  if (ids.size > 1) {
    throw new CompanionError("E_IMPORT_RESULT", "Grok import returned multiple different session IDs.", {
      sessionIds: [...ids]
    });
  }
  return ids.values().next().value || null;
}

/**
 * Shared post-finally transfer cleanup evidence.
 * Source-FD close-only failures are warning-only; converted/alias residuals also set privacyWarning.
 */
function transferCleanupDetails(cleanupWarnings, { privacy = false } = {}) {
  const warnings = (Array.isArray(cleanupWarnings) ? cleanupWarnings : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (!warnings.length) return undefined;
  const text = warnings.join("; ");
  return {
    warning: text,
    ...(privacy ? { privacyWarning: text } : {})
  };
}

function shellWord(value) {
  const text = String(value);
  return /^[a-zA-Z0-9_./:+-]+$/.test(text) ? text : `'${text.replaceAll("'", `'"'"'`)}'`;
}

async function runImportProcess({ binary, root, transcriptFd, alias, leaderSocket, marker, signal, timeoutMs = 120000, maxOutputBytes = 8 * 1024 * 1024 }) {
  // Hard-gate before spawn / identity: Windows must report E_CAPABILITY, not E_PROCESS_IDENTITY.
  assertProviderPlatform();
  // Test-only timeout override for deterministic cancel/timeout throw-path fixtures.
  const testTimeout = Number(process.env.GROK_COMPANION_TEST_IMPORT_TIMEOUT_MS);
  if (Number.isFinite(testTimeout) && testTimeout > 0) timeoutMs = testTimeout;
  const child = spawn(binary, ["import", "--json", "--leader-socket", leaderSocket, alias], {
    cwd: root,
    env: childEnvironment({ GROK_COMPANION_JOB_MARKER: marker }),
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe", transcriptFd]
  });
  const identity = { pid: child.pid, startToken: processStartToken(child.pid), processGroupId: process.platform === "win32" ? null : child.pid };
  let guardRecord;
  try { guardRecord = registerProviderGuard(root, marker, identity, sessionId(), "import"); }
  catch (error) { await ensureChildExit(child, identity); throw error; }
  let stdout = "", stdoutBytes = 0, stderr = "", terminationReason = null, forceTimer = null, terminationSignalError = null;
  let rejectTerminationSignalFailure;
  const terminationSignalFailure = new Promise((_, reject) => {
    rejectTerminationSignalFailure = reject;
  });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, closedBy) => resolve([exitCode, closedBy]));
  });
  const terminate = (name) => {
    try {
      return signalOwnedProcess(
        identity.processGroupId && process.platform !== "win32"
          ? -identity.processGroupId
          : identity.pid,
        name
      );
    } catch (error) {
      if (!terminationSignalError) {
        terminationSignalError = error;
        rejectTerminationSignalFailure(error);
      }
      return false;
    }
  };
  const beginTermination = (reason) => {
    if (terminationReason) return;
    terminationReason = reason;
    if (!terminate("SIGTERM")) return;
    forceTimer = setTimeout(() => { terminate("SIGKILL"); }, 2000);
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (terminationReason === "output") return;
    const bytes = Buffer.byteLength(chunk);
    if (stdoutBytes + bytes > maxOutputBytes) { beginTermination("output"); return; }
    stdout += chunk;
    stdoutBytes += bytes;
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-65536); });
  const onAbort = () => beginTermination("cancel");
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timeout = setTimeout(() => beginTermination("timeout"), timeoutMs);
  let code, exitSignal;
  try {
    [code, exitSignal] = await Promise.race([completion, terminationSignalFailure]);
  } finally {
    clearTimeout(timeout);
    if (forceTimer) clearTimeout(forceTimer);
    if (signal) signal.removeEventListener("abort", onAbort);
    await ensureChildExit(child, identity);
    unregisterProviderGuard(root, marker, guardRecord);
  }
  if (terminationReason === "cancel") throw new CompanionError("E_CANCELLED", "Grok transcript import was cancelled.");
  if (terminationReason === "timeout") throw new CompanionError("E_TIMEOUT", "Grok transcript import timed out.");
  if (terminationReason === "output") throw new CompanionError("E_OUTPUT_LIMIT", `Grok transcript import output exceeded ${maxOutputBytes} bytes.`);
  return { status: code, signal: exitSignal, stdout, stderr };
}

/**
 * Test-only faults: GROK_COMPANION_TEST_TRANSFER_CLEANUP_FAULTS=close,dispose,unlink
 * Injects cleanup evidence while still performing real close/dispose/unlink.
 */
function transferCleanupFaults() {
  const raw = process.env.GROK_COMPANION_TEST_TRANSFER_CLEANUP_FAULTS;
  if (!raw) return new Set();
  return new Set(String(raw).split(",").map((part) => part.trim()).filter(Boolean));
}

async function handleTransfer(raw) {
  const { options } = parseArgs(argvFrom(raw), { values: ["source", "cwd", "model", "effort"], booleans: ["json"] });
  validateModelEffort(options);
  const root = workspaceRoot(options.cwd ? path.resolve(options.cwd) : process.cwd(), false);
  const host = currentHost();
  const metadata = host.kind === "codex" ? readCodexSessionMetadata(pluginDataRoot(), host.sessionId) : null;
  const source = options.source || process.env.GROK_COMPANION_TRANSCRIPT_PATH || metadata?.transcriptPath;
  if (!source) {
    const guidance = host.kind === "codex" ? "Review and trust the plugin SessionStart hook with /hooks, start a new task, or pass --source <file.jsonl>." : "Pass --source <file.jsonl>.";
    throw new CompanionError("E_IMPORT_SOURCE", `No host transcript path is available. ${guidance}`);
  }
  const opened = openTranscriptSource(source);
  let importAlias = null, run, importFd = opened.fd, convertedFile = null, primaryError = null;
  const cleanupWarnings = [];
  let convertedCleanupFailed = false;
  let aliasCleanupFailed = false;
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const binary = discoverGrok(); grokVersion(binary);
    // Freeze both Claude and Codex sources at the validated descriptor size before any provider
    // work. An active host may append to its live transcript while model discovery/import runs;
    // Grok must receive the bounded point-in-time snapshot, never the growing source descriptor.
    const sourceSnapshot = readTranscriptSnapshot(opened);
    // After path-validated open, resolve model/effort from the same non-isolated Grok home used by
    // import/resume (not the isolated setup-probe ACP view) before Codex conversion or alias creation
    // so unavailable selections fail without private conversion work. finally still closes every
    // opened descriptor/artifact (source fd, converted fd/file, import alias).
    const models = listAdvertisedModels(binary);
    const selected = selectTransferModel(models, options.model || null);
    assertTransferEffort(selected, options.effort || null);
    const importDir = path.join(stateDir(root), "imports");
    fs.mkdirSync(importDir, { recursive: true, mode: 0o700 });
    const importContents = opened.format === "codex"
      ? codexTranscriptToClaude(sourceSnapshot, { cwd: root })
      : sourceSnapshot;
    const anonymous = createAnonymousTranscript(importContents, importDir);
    importFd = anonymous.fd;
    convertedFile = anonymous.file;
    importAlias = path.join(importDir, `import-${crypto.randomBytes(12).toString("hex")}.jsonl`);
    const inheritedFd = process.platform === "linux" ? "/proc/self/fd/3" : "/dev/fd/3";
    fs.symlinkSync(inheritedFd, importAlias);
    const marker = `transfer-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
    const leaderSocket = path.join(stateDir(root), `leader-${marker}.sock`);
    run = await runImportProcess({ binary, root, transcriptFd: importFd, alias: importAlias, leaderSocket, marker, signal: controller.signal });
    run.selectedModel = selected.id;
  } catch (error) {
    // Preserve the primary model-selection/conversion/import error; finally still runs cleanup and may
    // attach cleanupWarnings without replacing this code/message.
    primaryError = error;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    const faults = transferCleanupFaults();
    // Test-only faults inject cleanup evidence while still performing real close/dispose/unlink
    // so fixture processes do not leak descriptors. Production never sets the env var.
    if (importFd !== opened.fd) {
      if (faults.has("dispose")) {
        cleanupWarnings.push("injected dispose failure");
        convertedCleanupFailed = true;
      }
      const cleanup = disposeConvertedTranscript({ fd: importFd, file: convertedFile });
      if (!cleanup.ok) {
        cleanupWarnings.push(cleanup.warning);
        convertedCleanupFailed = true;
      }
    }
    if (faults.has("close")) cleanupWarnings.push("injected close failure");
    try { fs.closeSync(opened.fd); } catch (error) { cleanupWarnings.push(error.message); }
    if (importAlias) {
      if (faults.has("unlink")) {
        cleanupWarnings.push("injected unlink failure");
        aliasCleanupFailed = true;
      }
      try { fs.unlinkSync(importAlias); }
      catch (error) {
        if (error.code !== "ENOENT") {
          cleanupWarnings.push(error.message);
          aliasCleanupFailed = true;
        }
      }
    }
  }
  const privacy = convertedCleanupFailed || aliasCleanupFailed;
  if (primaryError) {
    throw attachTransferCleanupEvidence(primaryError, cleanupWarnings, { privacy });
  }
  if (!run) {
    if (cleanupWarnings.length) {
      throw new CompanionError(
        "E_STATE",
        "Could not completely remove the private transcript transfer artifacts.",
        transferCleanupDetails(cleanupWarnings, { privacy })
      );
    }
    throw new CompanionError("E_IMPORT_RESULT", "Grok transcript import did not complete.");
  }
  if (run.status !== 0) {
    throw new CompanionError(
      "E_IMPORT_RESULT",
      `Grok could not import the ${opened.format === "codex" ? "Codex" : "Claude Code"} transcript.`,
      {
        diagnostic: redactText(run.stderr || run.stdout),
        ...transferCleanupDetails(cleanupWarnings, { privacy })
      }
    );
  }
  let id;
  try {
    id = importedSessionId(run.stdout);
  } catch (error) {
    // Parser throws (malformed NDJSON / multiple IDs) after cleanup ran — attach residual evidence.
    throw attachTransferCleanupEvidence(error, cleanupWarnings, { privacy });
  }
  if (!id) {
    throw attachTransferCleanupEvidence(
      new CompanionError("E_IMPORT_RESULT", "Grok import succeeded but returned no usable session ID."),
      cleanupWarnings,
      { privacy }
    );
  }
  // Fail closed until the exact imported session is listed in the same non-isolated store
  // that resume uses. Bounded polling absorbs short Grok import persistence races.
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    await waitForImportedSession(id, { cwd: root, signal: controller.signal });
  } catch (error) {
    throw attachTransferCleanupEvidence(error, cleanupWarnings, { privacy });
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
  // Model-qualified resume is required: imported legacy placeholder models otherwise resume empty.
  const resume = formatResumeCommand(id, run.selectedModel, options.effort || null);
  const deleteParts = ["grok", "sessions", "delete", id];
  const label = opened.format === "codex" ? "Codex" : "Claude Code";
  const result = {
    sessionId: id,
    source: opened.real,
    sourceFormat: opened.format,
    model: run.selectedModel,
    effort: options.effort || null,
    resume,
    delete: deleteParts.map(shellWord).join(" ")
  };
  if (cleanupWarnings.length) {
    // Fail closed on any cleanup residual (including source-FD close-only). Session resume/delete
    // details keep the imported provider session from being orphaned. privacyWarning is set only
    // when converted/alias residuals may remain — close-only is warning-only.
    throw new CompanionError(
      "E_STATE",
      `Imported ${label} transcript into Grok session ${id}, but private alias or descriptor cleanup failed. Resume with \`${result.resume}\` or delete with \`${result.delete}\`, then remove leftover transfer artifacts.`,
      {
        ...transferCleanupDetails(cleanupWarnings, { privacy }),
        sessionId: result.sessionId,
        source: result.source,
        sourceFormat: result.sourceFormat,
        model: result.model,
        effort: result.effort,
        resume: result.resume,
        delete: result.delete
      }
    );
  }
  out(options.json ? result : `Imported ${label} transcript into Grok session ${id}.\nResume: ${result.resume}`, options.json);
}

async function main() {
  const [command, ...raw] = process.argv.slice(2);
  const internal = command === "--launch-worker"
    || command === "--worker"
    || command === "--launch-deep-research"
    || command === "--deep-research-worker";
  const grokEnvironment = process.env.GROK_COMPANION_CHILD === "1" || process.env.GROK_COMPANION_JOB_MARKER || process.env.GROK_AGENT || process.env.GROK_LEADER_SOCKET;
  let guardedWorkspace = false;
  if (!internal && ["setup", "review", "adversarial-review", "task", "deep-research", "transfer"].includes(command)) {
    const invocationArgs = command === "task" ? raw : argvFrom(raw);
    const cwdIndex = invocationArgs.indexOf("--cwd");
    const candidates = [process.cwd(), cwdIndex >= 0 && invocationArgs[cwdIndex + 1]].filter(Boolean);
    guardedWorkspace = candidates.some((candidate) => {
      try { return hasForeignActiveProvider(workspaceRoot(path.resolve(candidate), false), sessionId()); }
      catch { return false; }
    });
  }
  if (grokEnvironment || (!internal && hasGrokAncestor()) || guardedWorkspace) throw new CompanionError("E_RECURSION", "Nested Grok Companion invocation refused.");
  if (!command || ["help", "--help", "-h"].includes(command)) { out(usage()); return; }
  if (command === "--launch-worker") {
    const brokerInvocation = raw[1] === "--attempt";
    const fencedInvocation = brokerInvocation && raw[3] === "--fence";
    const id = raw[0];
    const dispatchAttemptId = brokerInvocation ? raw[2] : null;
    const providedDispatchFence = fencedInvocation ? Number(raw[4]) : null;
    const controllerIntentFlag = brokerInvocation ? raw[fencedInvocation ? 5 : 3] : null;
    const controllerIntentId = brokerInvocation ? raw[fencedInvocation ? 6 : 4] : null;
    const cwdFlag = brokerInvocation ? raw[fencedInvocation ? 7 : 5] : raw[1];
    const cwd = brokerInvocation ? raw[fencedInvocation ? 8 : 6] : raw[2];
    if (raw.length !== (brokerInvocation ? (fencedInvocation ? 9 : 7) : 3)
      || cwdFlag !== "--cwd"
      || (brokerInvocation && (
        controllerIntentFlag !== "--controller-intent"
        || !/^[a-f0-9]{32}$/.test(String(dispatchAttemptId || ""))
        || !/^[a-f0-9]{32}$/.test(String(controllerIntentId || ""))
        || (fencedInvocation && (!Number.isSafeInteger(providedDispatchFence) || providedDispatchFence < 1))
      ))) {
      throw new CompanionError("E_USAGE", "Invalid worker launcher invocation.");
    }
    const root = workspaceRoot(cwd), nonce = process.env.GROK_COMPANION_WORKER_NONCE;
    let record = readJob(root, id);
    if (brokerInvocation) {
      let authorized = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        record = readJob(root, id);
        const authorization = record.workerAuthorization;
        const dispatch = record.request?.spawn?.dispatch;
        const dispatchFence = isDispatchV2(dispatch)
          ? (providedDispatchFence ?? Number(process.env.GROK_COMPANION_DISPATCH_FENCE || dispatch.fence))
          : null;
        const controllerIntent = record.request?.spawn?.controllerSpawnIntent;
        if (terminal(record)) return;
        const ownStartToken = processStartToken(process.pid);
        const ownController = {
          pid: process.pid,
          startToken: ownStartToken,
          nonce,
          processGroupId: process.platform === "win32" ? null : process.pid,
          commandMarker: id,
          dispatchAttemptId,
          dispatchFence
        };
        let exactAuthorization = false;
        try {
          if (isDispatchV2(dispatch)) {
            const bound = assertWorkerAuthorization(record, { allowLegacy: false });
            exactAuthorization = bound.nonce === nonce
              && bound.dispatchAttemptId === dispatchAttemptId
              && bound.dispatchFence === dispatchFence;
          } else {
            exactAuthorization = authorization?.schemaVersion === 1
              && authorization.nonce === nonce
              && authorization.purpose === "launch-worker"
              && authorization.ownerThreadId === record.host?.sessionId
              && authorization.dispatchAttemptId === dispatchAttemptId;
          }
        } catch {}
        const commonAuthorization = nonce
          && process.env.GROK_COMPANION_DISPATCH_ATTEMPT === dispatchAttemptId
          && (!isDispatchV2(dispatch)
            || (dispatch.fence === dispatchFence
              && Number(process.env.GROK_COMPANION_DISPATCH_FENCE || dispatchFence) === dispatchFence))
          && currentHost().kind === record.host?.kind
          && currentHost().sessionId === record.host?.sessionId
          && isSupportedWorkerDispatch(dispatch)
          && dispatch.attemptId === dispatchAttemptId
          && controllerIntent?.schemaVersion === 1
          && controllerIntent.intentId === controllerIntentId
          && controllerIntent.attemptId === dispatchAttemptId
          && (!isDispatchV2(dispatch) || controllerIntent.fence == null || controllerIntent.fence === dispatchFence)
          && controllerIntent.processKind === "controller"
          && ["pending", "registered"].includes(controllerIntent.status)
          && typeof ownStartToken === "string"
          && ownStartToken;
        const firstRegistrationAuthorized = commonAuthorization
          && dispatch.state === "claimed"
          && controllerIntent.status === "pending"
          && exactAuthorization;
        const alreadyRegistered = commonAuthorization
          && dispatch.state === "controller-started"
          && record.controllerProcess?.pid === process.pid
          && record.controllerProcess?.startToken === ownStartToken
          && record.controllerProcess?.nonce === nonce
          && record.controllerProcess?.processGroupId === ownController.processGroupId
          && record.controllerProcess?.commandMarker === id
          && record.controllerProcess?.dispatchAttemptId === dispatchAttemptId
          && (record.controllerProcess?.dispatchFence ?? null) === dispatchFence;
        if (firstRegistrationAuthorized || alreadyRegistered) {
          try {
            assertDispatchContract(record);
            transitionWorkerDispatch({
              root,
              workerId: id,
              attemptId: dispatchAttemptId,
              fence: dispatchFence,
              state: "controller-started",
              controllerProcess: ownController,
              spawnIntentId: controllerIntentId
            });
          } catch (error) {
            throw error;
          }
          authorized = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!authorized) {
        throw new CompanionError("E_RECURSION", "Unauthenticated or stale broker launcher invocation refused.");
      }
      if (isCancelRequested(root, id, nonce)) {
        // Exit without terminalizing; reconciler observes cancel after group exit.
        return;
      }
      let child;
      let identity;
      let workerIntent;
      const dispatchFence = isDispatchV2(record.request?.spawn?.dispatch)
        ? (providedDispatchFence ?? Number(process.env.GROK_COMPANION_DISPATCH_FENCE || record.request.spawn.dispatch.fence))
        : null;
      try {
        const prepared = prepareDispatchProcessSpawn({
          root,
          workerId: id,
          attemptId: dispatchAttemptId,
          fence: dispatchFence,
          processKind: "worker",
          nonce
        });
        if (!prepared.prepared) return;
        workerIntent = prepared.intent;
        child = spawn(process.execPath, [
          SCRIPT,
          "--worker",
          id,
          "--attempt",
          dispatchAttemptId,
          ...(dispatchFence ? ["--fence", String(dispatchFence)] : []),
          "--worker-intent",
          workerIntent.intentId,
          "--cwd",
          root
        ], {
          cwd: root,
          detached: true,
          shell: false,
          stdio: "ignore",
          env: workerEnvironment(nonce, dispatchAttemptId, dispatchFence)
        });
        identity = await captureSpawnIdentity(child);
        if (isCancelRequested(root, id, nonce)) {
          await ensureChildExit(child, identity);
          recordDispatchProcessNoChild({
            root,
            workerId: id,
            attemptId: dispatchAttemptId,
            fence: dispatchFence,
            processKind: "worker",
            intentId: workerIntent.intentId,
            resolution: "cleanup-proven"
          });
          return;
        }
        const workerProcess = {
          ...identity,
          nonce,
          commandMarker: id,
          dispatchAttemptId,
          dispatchFence
        };
        const transitioned = transitionWorkerDispatch({
          root,
          workerId: id,
          attemptId: dispatchAttemptId,
          fence: dispatchFence,
          state: "worker-started",
          workerProcess,
          spawnIntentId: workerIntent.intentId
        });
        if (transitioned.request?.spawn?.dispatch?.state !== "worker-started") {
          await ensureChildExit(child, identity);
          return;
        }
        let exited = child.exitCode !== null || child.signalCode !== null;
        const observeExit = () => { exited = true; };
        child.once("exit", observeExit);
        child.once("error", observeExit);
        try {
          for (;;) {
            const latest = readJob(root, id);
            const latestDispatch = latest.request?.spawn?.dispatch;
            if (latestDispatch?.attemptId !== dispatchAttemptId) {
              await ensureChildExit(child, identity);
              return;
            }
            if (latestDispatch.state === "failed" || terminal(latest)) {
              await ensureChildExit(child, identity);
              return;
            }
            if (exited) {
              await ensureChildExit(child, identity);
              if (latestDispatch.state === "provider-started") {
                await recoverLostProviderStartedWorker({
                  root,
                  workerId: id,
                  attemptId: dispatchAttemptId,
                  workerProcess,
                  reconciler: false
                });
              } else {
                // Leave the exact worker-started attempt nonterminal. Recovery
                // decides whether launch was explicitly absent or ambiguous.
              }
              return;
            }
            const watchdogPollMs = latestDispatch.state === "provider-started" ? 250 : 25;
            await new Promise((resolve) => setTimeout(resolve, watchdogPollMs));
          }
        } finally {
          child.removeListener("exit", observeExit);
          child.removeListener("error", observeExit);
        }
      } catch (error) {
        if (workerIntent && !Number.isInteger(child?.pid)) {
          try {
            recordDispatchProcessNoChild({
              root,
              workerId: id,
              attemptId: dispatchAttemptId,
              fence: dispatchFence,
              processKind: "worker",
              intentId: workerIntent.intentId,
              resolution: "spawn-not-created"
            });
          } catch {}
        }
        const attachedCleanupIdentity = providerCleanupIdentity(error);
        const cleanupIdentity = identity || attachedCleanupIdentity;
        if (child
          && Number.isInteger(child.pid)
          && !cleanupIdentity
          && workerIntent) {
          // captureSpawnIdentity attaches an observation-only identity whenever
          // the spawned group may still be alive. A valid PID with no attached
          // identity therefore means its SIGTERM/SIGKILL cleanup was proven
          // before the error escaped.
          try {
            recordDispatchProcessNoChild({
              root,
              workerId: id,
              attemptId: dispatchAttemptId,
              fence: dispatchFence,
              processKind: "worker",
              intentId: workerIntent.intentId,
              resolution: "cleanup-proven"
            });
          } catch {}
        }
        if (child && cleanupIdentity) {
          let cleanupVerified = false;
          if (cleanupIdentity.startToken) {
            try {
              await ensureChildExit(child, cleanupIdentity);
              cleanupVerified = processGroupGone(cleanupIdentity);
            } catch {}
          } else {
            cleanupVerified = processGroupGone(cleanupIdentity);
          }
          if (!cleanupVerified) {
            try {
              recordUnsettledWorkerProcess({
                root,
                workerId: id,
                attemptId: dispatchAttemptId,
                workerProcess: {
                  pid: cleanupIdentity.pid,
                  startToken: cleanupIdentity.startToken || null,
                  processGroupId: cleanupIdentity.processGroupId,
                  nonce,
                  commandMarker: id,
                  dispatchAttemptId,
                  dispatchFence
                }
              });
            } catch {}
          } else if (workerIntent) {
            try {
              recordDispatchProcessNoChild({
                root,
                workerId: id,
                attemptId: dispatchAttemptId,
                fence: dispatchFence,
                processKind: "worker",
                intentId: workerIntent.intentId,
                resolution: "cleanup-proven"
              });
            } catch {}
          }
        }
        // The host-trusted reconciler publishes loss/cancellation only after
        // this controller and every child group are verified gone.
        throw error;
      }
    }
    if (!nonce || record.workerAuthorization !== nonce) throw new CompanionError("E_RECURSION", "Unauthenticated Grok Companion launcher invocation refused.");
    if (terminal(record)) return;
    if (isCancelRequested(root, id, nonce)) {
      withWorkspaceStateTransaction(root, (transaction) => {
        const current = transaction.tryReadJob(id);
        if (!current || terminal(current)) return current;
        if (current.workerAuthorization !== nonce) {
          throw new CompanionError(
            "E_RECURSION",
            "Worker launch authorization changed before cancellation cleanup."
          );
        }
        const cancelledAt = now();
        const intendedTerminal = {
          status: "cancelled",
          phase: "cancelled",
          completedAt: cancelledAt,
          error: {
            code: "E_CANCELLED",
            message: "Grok job was cancelled before worker launch."
          },
          summary: "Grok job was cancelled before worker launch."
        };
        const cleanup = cleanupTaskRuntimeArtifacts(
          stateDir(root),
          current.request?.providerHomeId || current.id,
          []
        );
        return transaction.updateJob(id, (latest) => {
          if (terminal(latest)) return latest;
          if (latest.workerAuthorization !== nonce) {
            throw new CompanionError(
              "E_RECURSION",
              "Worker launch authorization changed before cancellation publication."
            );
          }
          const settledAt = now();
          const base = {
            ...latest,
            workerAuthorization: null,
            heartbeatAt: settledAt,
            request: {
              ...latest.request,
              spawn: {
                ...(latest.request?.spawn || {}),
                providerLaunchPending: false,
                providerLaunchInFlight: false,
                providerLaunchOutcome: "not-launched",
                providerLaunchCompletedAt: settledAt
              }
            }
          };
          if (!cleanup.ok) {
            const message =
              "Cancellation is durable, but task runtime cleanup is incomplete.";
            return scrubStoredJob({
              ...base,
              status: "running",
              phase: "cleanup-blocked",
              completedAt: null,
              pendingTerminal: intendedTerminal,
              error: {
                code: "E_RUNTIME_CLEANUP",
                message,
                details: {
                  privacyWarning:
                    cleanup.warning || "Task runtime cleanup remained incomplete."
                }
              },
              summary: message,
              progress: "Cancellation accepted; runtime cleanup is still pending",
              result: applyTaskPrivacy(latest.result, cleanup),
              lifecycleEvents: appendLifecycleEvent(
                latest.lifecycleEvents || [],
                "blocked",
                message
              )
            });
          }
          const evidence = captureTerminalEvidence(
            latest.request?.spawn?.executionRoot || root,
            base,
            "cancelled"
          );
          const selectedTerminalError = selectTaskTerminalError(
            evidence,
            intendedTerminal.error
          );
          const selectedError = selectedTerminalError
            ? redact(asErrorPayload(selectedTerminalError))
            : null;
          const finalStatus = selectedError
            ? (selectedError.code === "E_CANCELLED" ? "cancelled" : "failed")
            : "cancelled";
          const finalPhase = selectedError?.code === "E_CONTEXT_DRIFT"
            ? "context-rejected"
            : selectedError?.code === "E_SCOPE_VIOLATION"
              ? "scope-rejected"
              : finalStatus;
          evidence.runtimeEvidence.executionStatus =
            finalStatus === "cancelled" ? "cancelled" : "failed";
          const result = {
            ...applyTaskPrivacy(latest.result, cleanup),
            hostVerification: latest.result?.hostVerification || "not_run",
            runtimeEvidence: {
              ...(latest.result?.runtimeEvidence || {}),
              ...evidence.runtimeEvidence
            },
            ...(finalStatus === "cancelled"
              ? { stopReason: "cancelled" }
              : {})
          };
          if (finalStatus !== "cancelled"
            && result.stopReason === "cancelled") {
            delete result.stopReason;
          }
          const summary = selectedError?.message
            || intendedTerminal.summary;
          return scrubStoredJob({
            ...base,
            status: finalStatus,
            phase: finalPhase,
            completedAt: selectedError?.code === "E_CONTEXT_DRIFT"
              || selectedError?.code === "E_SCOPE_VIOLATION"
              ? settledAt
              : intendedTerminal.completedAt,
            completionContextManifest: evidence.postContext,
            error: selectedError,
            summary,
            progress: terminalTaskProgress(finalStatus, selectedError),
            result,
            lifecycleEvents: appendLifecycleEvent(
              latest.lifecycleEvents || [],
              finalStatus === "cancelled" ? "checkpoint" : "blocked",
              summary
            )
          });
        });
      });
      return;
    }
    const child = spawn(process.execPath, [SCRIPT, "--worker", id, "--cwd", root], { cwd: root, detached: true, shell: false, stdio: "ignore", env: workerEnvironment(nonce) });
    const identity = await captureSpawnIdentity(child);
    updateJob(root, id, (current) => {
      if (terminal(current)) return current;
      current.workerAuthorization = null;
      current.workerProcess = { ...identity, nonce, commandMarker: id };
      current.summary = "Worker started";
      return current;
    });
    child.unref(); return;
  }
  if (command === "--worker") {
    const brokerInvocation = raw[1] === "--attempt";
    const fencedInvocation = brokerInvocation && raw[3] === "--fence";
    const id = raw[0];
    const dispatchAttemptId = brokerInvocation ? raw[2] : null;
    const providedDispatchFence = fencedInvocation ? Number(raw[4]) : null;
    const workerIntentFlag = brokerInvocation ? raw[fencedInvocation ? 5 : 3] : null;
    const workerIntentId = brokerInvocation ? raw[fencedInvocation ? 6 : 4] : null;
    const cwdFlag = brokerInvocation ? raw[fencedInvocation ? 7 : 5] : raw[1];
    const cwd = brokerInvocation ? raw[fencedInvocation ? 8 : 6] : raw[2];
    if (raw.length !== (brokerInvocation ? (fencedInvocation ? 9 : 7) : 3)
      || cwdFlag !== "--cwd"
      || (brokerInvocation && (
        workerIntentFlag !== "--worker-intent"
        || !/^[a-f0-9]{32}$/.test(String(dispatchAttemptId || ""))
        || !/^[a-f0-9]{32}$/.test(String(workerIntentId || ""))
        || (fencedInvocation && (!Number.isSafeInteger(providedDispatchFence) || providedDispatchFence < 1))
      ))) {
      throw new CompanionError("E_USAGE", "Invalid worker invocation.");
    }
    const root = workspaceRoot(cwd), nonce = process.env.GROK_COMPANION_WORKER_NONCE;
    let authorized = false;
    let authorizedFence = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      const record = readJob(root, id);
      let identity = record.workerProcess;
      const activeDispatchFence = isDispatchV2(record.request?.spawn?.dispatch)
        ? (providedDispatchFence
          ?? Number(process.env.GROK_COMPANION_DISPATCH_FENCE || record.request.spawn.dispatch.fence))
        : null;
      if (terminal(record)) return;
      if (brokerInvocation) {
        const authorization = record.workerAuthorization;
        const dispatch = record.request?.spawn?.dispatch;
        const dispatchFence = activeDispatchFence;
        const intent = record.request?.spawn?.workerSpawnIntent;
        const ownStartToken = processStartToken(process.pid);
        const ownIdentity = {
          pid: process.pid,
          startToken: ownStartToken,
          nonce,
          processGroupId: process.platform === "win32" ? null : process.pid,
          commandMarker: id,
          dispatchAttemptId,
          dispatchFence
        };
        let exactAuthorization = false;
        try {
          if (isDispatchV2(dispatch)) {
            const bound = assertWorkerAuthorization(record, { allowLegacy: false });
            exactAuthorization = bound.nonce === nonce
              && bound.dispatchAttemptId === dispatchAttemptId
              && bound.dispatchFence === dispatchFence;
          } else {
            exactAuthorization = authorization?.schemaVersion === 1
              && authorization.nonce === nonce
              && authorization.purpose === "launch-worker"
              && authorization.ownerThreadId === record.host?.sessionId
              && authorization.dispatchAttemptId === dispatchAttemptId;
          }
        } catch {}
        const commonAuthorization = nonce
          && process.env.GROK_COMPANION_DISPATCH_ATTEMPT === dispatchAttemptId
          && (!isDispatchV2(dispatch)
            || (dispatch.fence === dispatchFence
              && Number(process.env.GROK_COMPANION_DISPATCH_FENCE || dispatchFence) === dispatchFence))
          && currentHost().kind === record.host?.kind
          && currentHost().sessionId === record.host?.sessionId
          && isSupportedWorkerDispatch(dispatch)
          && dispatch.attemptId === dispatchAttemptId
          && intent?.schemaVersion === 1
          && intent.intentId === workerIntentId
          && intent.attemptId === dispatchAttemptId
          && (!isDispatchV2(dispatch) || intent.fence == null || intent.fence === dispatchFence)
          && intent.processKind === "worker"
          && ["pending", "registered"].includes(intent.status)
          && typeof ownStartToken === "string"
          && ownStartToken;
        const firstRegistrationAuthorized = commonAuthorization
          && dispatch.state === "controller-started"
          && intent.status === "pending"
          && exactAuthorization;
        const alreadyRegistered = commonAuthorization
          && dispatch.state === "worker-started"
          && identity?.pid === process.pid
          && identity?.startToken === ownStartToken
          && identity?.nonce === nonce
          && identity?.processGroupId === ownIdentity.processGroupId
          && identity?.commandMarker === id
          && identity?.dispatchAttemptId === dispatchAttemptId
          && (identity?.dispatchFence ?? null) === dispatchFence;
        if (firstRegistrationAuthorized || alreadyRegistered) {
          assertDispatchContract(record);
          const registered = transitionWorkerDispatch({
            root,
            workerId: id,
            attemptId: dispatchAttemptId,
            fence: dispatchFence,
            state: "worker-started",
            workerProcess: ownIdentity,
            spawnIntentId: workerIntentId
          });
          identity = registered.workerProcess;
        }
      }
      if (nonce
        && (!brokerInvocation || (
          process.env.GROK_COMPANION_DISPATCH_ATTEMPT === dispatchAttemptId
          && currentHost().kind === record.host?.kind
          && currentHost().sessionId === record.host?.sessionId
        ))
        && identity?.nonce === nonce
        && identity?.pid === process.pid
        && identity?.startToken === processStartToken(process.pid)
        && (process.platform === "win32"
          ? identity?.processGroupId === null
          : identity?.processGroupId === process.pid)
        && identity?.commandMarker === id
        && (!brokerInvocation || (
          identity.dispatchAttemptId === dispatchAttemptId
          && (identity.dispatchFence ?? null) === activeDispatchFence
          && record.request?.spawn?.dispatch?.attemptId === dispatchAttemptId
          && record.request?.spawn?.dispatch?.state === "worker-started"
        ))) {
        if (brokerInvocation) {
          try {
            assertDispatchContract(record);
          } catch (error) {
            throw error;
          }
        }
        authorized = true;
        authorizedFence = brokerInvocation
          ? (record.request?.spawn?.dispatch?.schemaVersion === 2
              ? (providedDispatchFence ?? Number(process.env.GROK_COMPANION_DISPATCH_FENCE || record.request.spawn.dispatch.fence))
              : null)
          : null;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!authorized) throw new CompanionError("E_RECURSION", "Unauthenticated Grok Companion worker invocation refused.");
    try {
      await execute(root, id, { dispatchAttemptId, dispatchFence: authorizedFence });
    } catch (error) {
      // The executing worker never terminalizes its own still-live process.
      // execute() atomically settles cleanup-safe pre-provider failures; if it
      // could not, the controller/reconciler observes exact process exit and
      // performs loss recovery without replaying the prompt.
      throw error;
    }
    return;
  }
  if (command === "--launch-deep-research") {
    const id = raw[0];
    const cwdFlag = raw[1];
    const cwd = raw[2];
    if (raw.length !== 3 || cwdFlag !== "--cwd") {
      throw new CompanionError("E_USAGE", "Invalid deep-research launcher invocation.");
    }
    const root = workspaceRoot(cwd);
    const nonce = process.env.GROK_COMPANION_WORKER_NONCE;
    const record = readJob(root, id);
    if (record.kind !== DEEP_RESEARCH_KIND || record.jobClass !== "research") {
      throw new CompanionError("E_USAGE", "Deep-research launcher requires a deep-research job.");
    }
    if (!nonce || record.workerAuthorization !== nonce) {
      throw new CompanionError("E_RECURSION", "Unauthenticated deep-research worker invocation refused.");
    }
    if (terminal(record)) return;
    if (isCancelRequested(root, id, nonce)) {
      const cleanup = cleanupResearchRuntimeArtifacts(stateDir(root), id, []);
      updateJob(root, id, (current) => {
        if (terminal(current)) return current;
        current.workerAuthorization = null;
        const intendedTerminal = {
          status: "cancelled",
          phase: "cancelled",
          completedAt: now(),
          error: {
            code: "E_CANCELLED",
            message: "Deep-research was cancelled before worker launch."
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
          : "Deep-research cancellation accepted; private query cleanup is pending";
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
      return;
    }
    // Spawn a detached research worker, record owned identity, then exit so
    // --background returns immediately while wait mode polls durable state.
    const child = spawn(
      process.execPath,
      [SCRIPT, "--deep-research-worker", id, "--cwd", root],
      {
        cwd: root,
        detached: true,
        shell: false,
        stdio: "ignore",
        env: workerEnvironment(nonce)
      }
    );
    const identity = await captureSpawnIdentity(child);
    updateJob(root, id, (current) => {
      if (terminal(current)) return current;
      current.workerAuthorization = null;
      current.workerProcess = { ...identity, nonce, commandMarker: id };
      current.status = "running";
      current.phase = "starting";
      current.startedAt = current.startedAt || now();
      current.summary = "Deep-research worker started";
      current.progress = current.summary;
      return touchJob(current);
    });
    child.unref();
    return;
  }
  if (command === "--deep-research-worker") {
    const id = raw[0];
    const cwdFlag = raw[1];
    const cwd = raw[2];
    if (raw.length !== 3 || cwdFlag !== "--cwd") {
      throw new CompanionError("E_USAGE", "Invalid deep-research worker invocation.");
    }
    const root = workspaceRoot(cwd);
    const nonce = process.env.GROK_COMPANION_WORKER_NONCE;
    let authorized = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const record = readJob(root, id);
      if (terminal(record)) return;
      if (record.kind !== DEEP_RESEARCH_KIND || record.jobClass !== "research") {
        throw new CompanionError("E_USAGE", "Deep-research worker requires a deep-research job.");
      }
      const identity = record.workerProcess;
      const ownStartToken = processStartToken(process.pid);
      if (
        nonce
        && identity?.nonce === nonce
        && identity?.pid === process.pid
        && identity?.startToken === ownStartToken
        && identity?.commandMarker === id
      ) {
        authorized = true;
        break;
      }
      // First registration window: launcher may still be recording identity.
      if (nonce && (record.workerAuthorization === nonce || identity?.nonce === nonce)) {
        if (!identity?.pid || identity.pid === process.pid) {
          authorized = true;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!authorized) {
      throw new CompanionError("E_RECURSION", "Unauthenticated deep-research worker invocation refused.");
    }
    await executeDeepResearch(root, id);
    return;
  }
  if (command === "setup") return handleSetup(raw);
  if (["review", "adversarial-review"].includes(command)) return handleReview(command, raw);
  if (command === "task") return handleTask(raw);
  if (command === "deep-research") return handleDeepResearch(raw);
  if (command === "task-resume-candidate") {
    const { options } = parseArgs(argvFrom(raw), { values: ["cwd"], booleans: ["write", "json"] });
    const root = workspaceRoot(options.cwd ? path.resolve(options.cwd) : process.cwd());
    const candidate = resumeCandidate(root, profileFor("task", Boolean(options.write)));
    out({ available: Boolean(candidate), jobId: candidate?.id || null, profileId: candidate?.profile?.id || null }, true);
    return;
  }
  if (command === "record-verification") return handleRecordVerification(raw);
  if (command === "status") return handleStatus(raw);
  if (command === "result") return handleResult(raw);
  if (command === "cancel") return handleCancel(raw);
  if (command === "transfer") return handleTransfer(raw);
  throw new CompanionError("E_USAGE", `Unknown command ${command}.\n${usage()}`);
}

main().catch((error) => {
  const privatePayload = asErrorPayload(error);
  const payload = (
    process.argv[2] === "transfer"
      ? projectTransferCliError(privatePayload)
      : projectWorkerError(privatePayload)
  ) || {
    code: "E_BROKER",
    message: "Worker failed."
  };
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: payload }, null, 2)}\n`);
  } else {
    process.stderr.write(`${payload.code}: ${payload.message}\n`);
    if (payload.details?.workerId) {
      process.stderr.write(
        `Job: ${payload.details.workerId}\n`
        + `Check: ${hostCommand("status", payload.details.workerId)}\n`
      );
    }
  }
  process.exitCode = exitCodeFor(error);
});
