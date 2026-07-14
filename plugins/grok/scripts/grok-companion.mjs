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
import { admitJob, appendJobLog, config, setConfig, generateId, writeJob, updateJob, listJobs, readJob, selectJob, requestCancel, isCancelRequested, terminal, now, retain, logFile, withWorkspaceAdmission } from "./lib/state.mjs";
import { workspaceRoot, workspaceState } from "./lib/workspace.mjs";
import { redact, redactText, sanitizeDisplayText } from "./lib/redact.mjs";
import { readBoundedStdin, STDIN_READY_MARKER } from "./lib/stdin.mjs";
import { hasGrokAncestor, identityMatches, processGroupAlive, processGroupGone, processIsZombie } from "./lib/process-control.mjs";
import { hasForeignActiveProvider, registerProviderGuard, resolveProviderCleanupTarget, unregisterProviderGuard } from "./lib/recursion-guard.mjs";
import { hostCommand, hostContext, jobHostContext, pluginDataRoot, readCodexSessionMetadata, sameHostSession } from "./lib/host.mjs";
import { codexTranscriptToClaude, createAnonymousTranscript, disposeConvertedTranscript, openTranscriptSource, readTranscriptSnapshot } from "./lib/transcript.mjs";
import {
  appendLifecycleEvent,
  assertContextCompatible,
  assertTaskContextReady,
  boundPathEvidence,
  buildRuntimeEvidence,
  buildTaskEnvelope,
  buildWorkerReport,
  captureContextManifest,
  composeProviderPrompt,
  composeWorkerReportRepairPrompt,
  evaluateScope,
  observeChangedPaths,
  parseTaskEnvelopeInput
} from "./lib/task-contract.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(SCRIPT), "..");
const VALID_EFFORTS = new Set(["low", "medium", "high"]);

function usage() {
  return ["Usage:", "  grok-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]", "  grok-companion.mjs review|adversarial-review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]", "  grok-companion.mjs task [--wait|--background] [--write] [--resume|--fresh] [--job-id <id>] [--model <id>] [--effort low|medium|high] [--envelope-stdin [--stdin-ready] | --envelope-file <private-path> | -- <task>]", "  grok-companion.mjs transfer [--source <claude-or-codex-jsonl>] [--model <id>] [--effort low|medium|high] [--json]", "  grok-companion.mjs status [job-id] [--wait] [--timeout-ms <ms>] [--all] [--json]", "  grok-companion.mjs result [job-id] [--json]", "  grok-companion.mjs cancel [job-id] [--json]"].join("\n");
}

function stdinReadySignal(enabled) {
  return enabled ? () => process.stderr.write(`${STDIN_READY_MARKER}\n`) : null;
}

function parseVerificationRecord(text, requiredVerification = []) {
  let value;
  try { value = JSON.parse(String(text || "")); }
  catch (error) { throw new CompanionError("E_USAGE", `Host verification input is not valid JSON: ${error.message}`); }
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.commandOutcomes)) {
    throw new CompanionError("E_USAGE", "Host verification input must be one object with commandOutcomes[].");
  }
  const allowedRoot = new Set(["commandOutcomes"]);
  const unknownRoot = Object.keys(value).filter((key) => !allowedRoot.has(key));
  if (unknownRoot.length) throw new CompanionError("E_USAGE", `Host verification input contains unsupported fields: ${unknownRoot.join(", ")}.`);
  const required = [...new Set((requiredVerification || []).map((item) => String(item)))];
  if (required.length === 0) {
    throw new CompanionError("E_USAGE", "Host verification reconciliation requires at least one declared requiredVerification command.");
  }
  const allowedCommands = new Set(required);
  const commandOutcomes = value.commandOutcomes.slice(0, 64).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new CompanionError("E_USAGE", "Each host verification outcome must be an object.");
    const unknown = Object.keys(item).filter((key) => !["command", "status", "exitCode"].includes(key));
    if (unknown.length) throw new CompanionError("E_USAGE", `Host verification outcome contains unsupported fields: ${unknown.join(", ")}.`);
    const command = sanitizeDisplayText(String(item.command || "")).slice(0, 2 * 1024);
    const status = String(item.status || "");
    if (!command || !["passed", "failed"].includes(status) || !Number.isInteger(item.exitCode)) {
      throw new CompanionError("E_USAGE", "Each host verification outcome requires command, status passed|failed, and an integer exitCode.");
    }
    if (required.length && !allowedCommands.has(command)) {
      throw new CompanionError("E_USAGE", `Host verification command was not declared in requiredVerification: ${command}`);
    }
    return { command, status, exitCode: item.exitCode };
  });
  const byCommand = new Map(commandOutcomes.map((item) => [item.command, item]));
  if (commandOutcomes.length === 0) throw new CompanionError("E_USAGE", "Host verification reconciliation requires at least one command outcome.");
  if (byCommand.size !== commandOutcomes.length) throw new CompanionError("E_USAGE", "Host verification commands must be unique.");
  const anyFailed = commandOutcomes.some((item) => item.status === "failed" || item.exitCode !== 0);
  const allRequiredPassed = required.every((command) => {
    const item = byCommand.get(command);
    return item?.status === "passed" && item.exitCode === 0;
  });
  if (!anyFailed && !allRequiredPassed) {
    throw new CompanionError("E_USAGE", "A passing host verification record must include every requiredVerification command.");
  }
  return { outcome: anyFailed ? "failed" : "passed", commandOutcomes };
}

function argvFrom(raw) { return raw.length === 1 && /\s/.test(raw[0]) ? splitArgs(raw[0]) : raw; }
function out(value, json = false) { process.stdout.write(`${json ? JSON.stringify(value, null, 2) : value}\n`); }
function currentHost() { return hostContext(); }
function sessionId() { return currentHost().sessionId; }
function stateDir(root) { return workspaceState(root); }
function publicJob(job, { detail = true } = {}) {
  const envelope = job.request?.envelope || null;
  const manifest = job.request?.contextManifest || null;
  const result = detail && job.result
    ? {
        ...(job.result.review ? { review: job.result.review } : {}),
        ...(job.result.workerReport ? { workerReport: job.result.workerReport } : {}),
        ...(job.result.reportRepair ? { reportRepair: job.result.reportRepair } : {}),
        ...(job.result.providerClaims ? { providerClaims: job.result.providerClaims } : {}),
        ...(job.result.runtimeEvidence ? { runtimeEvidence: job.result.runtimeEvidence } : {}),
        ...(job.result.verification ? { verification: job.result.verification } : {}),
        ...(job.result.textDigest ? { textBytes: job.result.textBytes || 0, textDigest: job.result.textDigest, textTruncated: Boolean(job.result.textTruncated) } : {}),
        ...(job.result.interim ? { interim: job.result.interim } : {}),
        hostVerification: job.result.hostVerification || "not_run",
        ...(job.result.stopReason ? { stopReason: job.result.stopReason } : {}),
        ...(job.result.skipped ? { skipped: true, skipReason: job.result.skipReason || null } : {}),
        ...(job.result.providerSessionDeleted != null ? { providerSessionDeleted: job.result.providerSessionDeleted } : {}),
        ...(job.result.taskRuntimeCleaned != null ? { taskRuntimeCleaned: job.result.taskRuntimeCleaned } : {}),
        ...(job.result.privacyWarning ? { privacyWarning: job.result.privacyWarning } : {})
      }
    : null;
  return {
    schemaVersion: job.schemaVersion,
    id: job.id,
    kind: job.kind,
    jobClass: job.jobClass,
    write: Boolean(job.write),
    status: job.status,
    phase: job.phase,
    summary: job.summary || null,
    progress: job.progress || null,
    createdAt: job.createdAt || null,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null,
    completedAt: job.completedAt || null,
    heartbeatAt: job.heartbeatAt || null,
    profileId: job.profile?.id || null,
    model: job.model || null,
    effort: job.effort || null,
    latestPlan: detail ? job.latestPlan || [] : [],
    lifecycleEvents: detail ? job.lifecycleEvents || [] : [],
    taskContract: detail && envelope ? {
      schemaVersion: envelope.schemaVersion,
      envelopeId: envelope.envelopeId,
      digest: envelope.digest,
      // Positional/default envelopes use literal task text as the objective. Keep that raw
      // prompt private; expose only the separately recorded control-plane objective.
      objective: job.request?.publicObjective || null,
      mode: envelope.mode,
      scope: envelope.scope,
      nonGoals: envelope.nonGoals,
      acceptanceCriteria: envelope.acceptanceCriteria,
      requiredVerification: envelope.requiredVerification,
      expectedReturnFormat: envelope.expectedReturnFormat,
      context: envelope.context,
      contextManifestId: envelope.contextManifestId
    } : null,
    context: detail && manifest ? {
      manifestId: manifest.manifestId,
      digest: manifest.digest,
      branch: manifest.git?.branch || null,
      head: manifest.git?.head || null,
      dirtyDigest: manifest.git?.dirtyDigest || null,
      dirtyEntryCount: manifest.git?.dirtyEntryCount || 0,
      projectMarkers: manifest.projectMarkers || [],
      materialization: manifest.materialization || null
    } : null,
    resumeJobId: job.request?.resumeJobId || null,
    result,
    error: job.error || null
  };
}
function publicJson(value, options = {}) { return Array.isArray(value) ? value.map((job) => publicJob(job, options)) : publicJob(value, options); }
function assertHostJobAccess(job, operation) {
  const host = currentHost();
  const recorded = jobHostContext(job);
  const scoped = Boolean(host.sessionId || recorded.sessionId);
  if (scoped && !sameHostSession(job, host)) {
    throw new CompanionError("E_JOB_NOT_FOUND", `No ${operation} job with that ID exists in the current host task.`);
  }
  return job;
}
function readPrivateEnvelopeFile(file) {
  const resolved = path.resolve(file);
  const configuredRoot = path.resolve(pluginDataRoot());
  fs.mkdirSync(configuredRoot, { recursive: true, mode: 0o700 });
  const dataRoot = fs.realpathSync(configuredRoot);
  const parent = fs.realpathSync(path.dirname(resolved));
  const candidate = path.join(parent, path.basename(resolved));
  const relative = path.relative(dataRoot, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new CompanionError("E_USAGE", "--envelope-file must be a private file beneath the plugin data root.");
  }
  let descriptor;
  try {
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new CompanionError("E_USAGE", "--envelope-file must be a regular non-symlink file.");
    if ((stat.mode & 0o077) !== 0) throw new CompanionError("E_USAGE", "--envelope-file permissions must deny group and other access.");
    if (stat.size > 256 * 1024) throw new CompanionError("E_USAGE", "TaskEnvelope file exceeds the 256 KiB input limit.");
    const text = fs.readFileSync(descriptor, "utf8");
    const current = fs.lstatSync(candidate);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) {
      throw new CompanionError("E_USAGE", "TaskEnvelope file identity changed during its no-follow read.");
    }
    return text;
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
    try { fs.unlinkSync(candidate); } catch {}
  }
}
function loadTemplate(name, values) {
  const text = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", `${name}.md`), "utf8");
  return text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
}
function appendLog(root, id, entry) {
  const line = `${JSON.stringify({ at: now(), ...entry })}\n`;
  if (Buffer.byteLength(line, "utf8") > 16 * 1024) return;
  appendJobLog(root, id, line);
}
function boundedLogEvent(event) {
  if (!event || typeof event !== "object") return { type: "unknown" };
  if (event.type === "message") {
    const text = String(event.text || "");
    return { type: "message", bytes: Buffer.byteLength(text, "utf8"), digest: crypto.createHash("sha256").update(text).digest("hex") };
  }
  if (event.type === "diagnostic") return { type: "diagnostic", text: sanitizeDisplayText(event.text).slice(0, 4000) };
  if (event.type === "plan") {
    return {
      type: "plan",
      entries: (event.value?.entries || []).map((item) => sanitizeDisplayText(item?.content || item?.text || item?.title || "").slice(0, 500)).filter(Boolean).slice(0, 20)
    };
  }
  if (event.type === "tool") return { type: "tool", name: sanitizeDisplayText(event.name).slice(0, 300), status: sanitizeDisplayText(event.status).slice(0, 80), ...(Number.isInteger(event.exitCode) ? { exitCode: event.exitCode } : {}) };
  if (event.type === "provider") return { type: "provider", version: event.version || null, process: event.process || null };
  if (event.type === "session") return { type: "session", sessionId: event.sessionId || null };
  return { type: event.type || "unknown" };
}
function validateModelEffort(options) { if (options.effort && !VALID_EFFORTS.has(options.effort)) throw new CompanionError("E_USAGE", "--effort must be low, medium, or high."); }

function scrubStoredRequest(request) {
  if (!request || typeof request !== "object") return request;
  const prompt = typeof request.prompt === "string" ? request.prompt : null;
  const literal = typeof request.envelope?.userRequest === "string" ? request.envelope.userRequest : null;
  return {
    ...request,
    prompt: null,
    promptDigest: request.promptDigest || (prompt ? crypto.createHash("sha256").update(prompt).digest("hex") : null),
    envelope: request.envelope ? {
      ...request.envelope,
      userRequest: null,
      userRequestDigest: literal ? crypto.createHash("sha256").update(literal).digest("hex") : request.envelope.userRequestDigest || null
    } : null
  };
}

function boundedProviderText(value, limitBytes = 64 * 1024) {
  const text = sanitizeDisplayText(value);
  const buffer = Buffer.from(text, "utf8");
  const retained = buffer.length > limitBytes ? buffer.subarray(0, limitBytes).toString("utf8") : text;
  return {
    text: retained,
    textBytes: buffer.length,
    textDigest: crypto.createHash("sha256").update(buffer).digest("hex"),
    textTruncated: buffer.length > limitBytes
  };
}

function textEvidence(value) {
  const text = String(value || "");
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    digest: crypto.createHash("sha256").update(text).digest("hex")
  };
}

function workerEnvironment(nonce) {
  const env = {};
  const allowed = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "TERM", "COLORTERM", "NO_COLOR", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ComSpec", "PATHEXT"]);
  for (const [key, value] of Object.entries(process.env)) if ((allowed.has(key) || key.startsWith("LC_")) && value != null) env[key] = value;
  const host = currentHost();
  env.GROK_COMPANION_HOST = host.kind;
  if (host.sessionId) env.GROK_COMPANION_HOST_SESSION_ID = host.sessionId;
  env.GROK_COMPANION_PLUGIN_DATA = pluginDataRoot();
  if (process.env.GROK_BIN) env.GROK_BIN = process.env.GROK_BIN;
  // The trusted detached worker must be able to locate a configured credential so it can
  // sanitize/copy it into the isolated task home. Provider children still receive only GROK_HOME.
  if (process.env.GROK_AUTH_PATH) env.GROK_AUTH_PATH = process.env.GROK_AUTH_PATH;
  env.GROK_COMPANION_WORKER_NONCE = nonce;
  return env;
}

function applyReviewPrivacy(result, cleanup, retentionNote = null) {
  const next = { ...(result || {}) };
  if (cleanup) {
    next.providerSessionDeleted = cleanup.ok;
    if (cleanup.warning) {
      // Additive: retain prior evidence when another cleanup attempt fails.
      next.privacyWarning = [next.privacyWarning, cleanup.warning].filter(Boolean).join("; ");
    } else if (cleanup.ok) {
      // Successful later re-cleanup deliberately clears a prior privacy warning.
      delete next.privacyWarning;
    }
    return next;
  }
  if (retentionNote) {
    next.providerSessionDeleted = false;
    next.privacyWarning = [...new Set([next.privacyWarning, retentionNote].filter(Boolean))].join("; ");
  }
  return next;
}

function applyTaskPrivacy(result, cleanup, retentionNote = null) {
  const next = { ...(result || {}) };
  if (cleanup) {
    next.taskRuntimeCleaned = cleanup.ok;
    if (cleanup.warning) {
      next.privacyWarning = [...new Set([next.privacyWarning, cleanup.warning].filter(Boolean))].join("; ");
    } else if (cleanup.ok) {
      delete next.privacyWarning;
    }
    return next;
  }
  if (retentionNote) {
    next.taskRuntimeCleaned = false;
    next.privacyWarning = [...new Set([next.privacyWarning, retentionNote].filter(Boolean))].join("; ");
  }
  return next;
}

function includeGuardCleanup(root, id, cleanup) {
  if (!cleanup?.ok) return cleanup;
  try {
    unregisterProviderGuard(root, id);
    return cleanup;
  } catch (error) {
    return {
      ok: false,
      warning: `Runtime cleanup incomplete: provider guard removal failed (${error?.code || "unknown"}).`
    };
  }
}

async function terminateProviderCleanupTarget(root, job) {
  const { identity, kind } = resolveProviderCleanupTarget(root, job);
  await terminateVerified(identity, job.id, kind);
  // Only allow guard/home teardown after the original process group is verified gone.
  // Absent identity remains fail-open (nothing to signal); live/unverifiable groups fail closed.
  if (identity && !processGroupGone(identity)) {
    throw new CompanionError("E_PROCESS_IDENTITY", `Could not verify complete process-group shutdown for provider ${identity.pid}.`, {
      pid: identity.pid,
      processGroupId: identity.processGroupId ?? null
    });
  }
  return identity;
}

function captureTerminalEvidence(root, job, executionStatus) {
  const preContext = job.request?.contextManifest || null;
  let postContext = null;
  try { postContext = captureContextManifest(root); } catch {}
  const changedPaths = preContext && postContext ? observeChangedPaths(preContext, postContext) : [];
  const scopeViolations = evaluateScope(changedPaths, job.request?.envelope?.scope);
  return {
    postContext,
    runtimeEvidence: buildRuntimeEvidence({
      preContext,
      postContext,
      changedPaths,
      commandOutcomes: job.commandOutcomes || [],
      scopeViolations,
      executionStatus
    })
  };
}

async function recoverActiveJobs(root) {
  for (const job of listJobs(root).filter((candidate) => terminal(candidate) && candidate.jobClass === "review" && candidate.result?.providerSessionDeleted === false && candidate.result?.skipReason !== "empty-target")) {
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
  // Re-clean terminal task records produced by older runtimes or a cleanup
  // failure after provider exit. If either recorded group still lives, move the
  // record back to cleanup-blocked so the active recovery path can terminate it.
  for (const job of listJobs(root).filter((candidate) => terminal(candidate) && candidate.jobClass === "task" && candidate.result?.taskRuntimeCleaned !== true)) {
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
      cleanup = includeGuardCleanup(root, currentJob.id, cleanup);
      updateJob(root, currentJob.id, (current) => {
        current.result = applyTaskPrivacy(current.result, cleanup);
        return current;
      });
    });
  }
  for (const job of listJobs(root).filter((candidate) => !terminal(candidate))) {
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
    if (cleanupError) {
      updateJob(root, job.id, (current) => {
        if (terminal(current)) return current;
        current.phase = "cleanup-blocked";
        current.progress = "Worker lost; provider cleanup could not be verified";
        current.error = redact(asErrorPayload(cleanupError));
        current.summary = current.error.message;
        current.heartbeatAt = now();
        if (current.jobClass === "review") {
          current.result = applyReviewPrivacy(current.result, null, "Isolated review home retained because process cleanup could not be verified.");
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
    const pendingExecutionStatus = job.pendingTerminal?.status === "completed"
      ? "completed"
      : job.pendingTerminal?.status === "cancelled"
        ? "cancelled"
        : "failed";
    const evidence = captureTerminalEvidence(root, job, pendingExecutionStatus);
    updateJob(root, job.id, (current) => {
      // The worker can finish between the liveness check above and this locked
      // update. Never turn that freshly completed record into E_WORKER_LOST.
      if (terminal(current)) return current;
      current.request = scrubStoredRequest(current.request);
      const pending = current.pendingTerminal || null;
      current.status = pending?.status || "failed";
      current.phase = pending?.phase || (current.status === "completed" ? "done" : current.status);
      current.completedAt = pending?.completedAt || now();
      if (pending) {
        current.error = pending.error || null;
        if (pending.summary) current.summary = pending.summary;
      } else {
        current.error = { code: "E_WORKER_LOST", message: "The background worker disappeared; the prompt was not replayed." };
      }
      if (current.error?.message) current.summary = current.error.message;
      current.completionContextManifest = evidence.postContext;
      current.result = {
        ...(current.result || {}),
        hostVerification: current.result?.hostVerification || "not_run",
        runtimeEvidence: evidence.runtimeEvidence
      };
      if (cleanup) {
        current.result = applyReviewPrivacy(current.result, cleanup);
      } else if (current.jobClass === "task") {
        current.result = applyTaskPrivacy(current.result, taskCleanup || { ok: true });
      }
      delete current.pendingTerminal;
      current.lifecycleEvents = appendLifecycleEvent(
        current.lifecycleEvents,
        current.error ? "blocked" : "checkpoint",
        current.error?.message || "Task runtime cleanup completed"
      );
      return current;
    });
  }
}

async function terminateVerified(identity, marker, kind) {
  if (!identity) return false;
  // Defense in depth: unsupported platforms must surface E_CAPABILITY before identity failures.
  assertProviderPlatform();
  if (processGroupGone(identity)) return false;
  if (!identity.startToken) throw new CompanionError("E_PROCESS_IDENTITY", `Refusing to signal process ${identity.pid} without a start token.`, { pid: identity.pid });
  const current = processStartToken(identity.pid);
  const groupAlive = Boolean(identity.processGroupId && process.platform !== "win32" && processGroupAlive(identity.processGroupId));
  if (!current) {
    if (groupAlive) throw new CompanionError("E_PROCESS_IDENTITY", `Process ${identity.pid} exited while its process group remained active; ownership can no longer be verified.`, { pid: identity.pid, processGroupId: identity.processGroupId });
    return false;
  }
  if (current !== identity.startToken || !identityMatches(identity, marker, kind)) throw new CompanionError("E_PROCESS_IDENTITY", `Refusing to signal unverified process ${identity.pid}.`, { pid: identity.pid });
  try { process.kill(identity.processGroupId && process.platform !== "win32" ? -identity.processGroupId : identity.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  const stillAlive = () => processStartToken(identity.pid) === identity.startToken || Boolean(identity.processGroupId && process.platform !== "win32" && processGroupAlive(identity.processGroupId));
  const waitGone = async (timeout) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (!stillAlive()) return true; await new Promise((resolve) => setTimeout(resolve, 50)); } return !stillAlive(); };
  if (await waitGone(2000)) return true;
  try { process.kill(identity.processGroupId && process.platform !== "win32" ? -identity.processGroupId : identity.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  if (!await waitGone(1500)) throw new CompanionError("E_PROCESS_IDENTITY", `Verified process ${identity.pid} did not exit after SIGKILL.`, { pid: identity.pid });
  return true;
}

function baseRecord({ id, kind, root, profile, title, request, write, model, effort, lifecycleEvents = null }) {
  const timestamp = now();
  return {
    schemaVersion: 3,
    id,
    kind,
    jobClass: kind.includes("review") ? "review" : "task",
    title,
    summary: "Queued",
    write,
    status: "queued",
    phase: "queued",
    workspaceRoot: root,
    host: currentHost(),
    grokSessionId: null,
    createdAt: timestamp,
    startedAt: null,
    updatedAt: timestamp,
    completedAt: null,
    heartbeatAt: timestamp,
    workerProcess: null,
    providerProcess: null,
    profile,
    model: model || null,
    effort: effort || null,
    logFile: logFile(root, id),
    progress: null,
    latestPlan: [],
    commandOutcomes: [],
    lifecycleEvents: Array.isArray(lifecycleEvents) ? lifecycleEvents : [],
    completionContextManifest: null,
    request,
    result: null,
    error: null
  };
}

function touchJob(job, patch = {}) {
  const next = { ...job, ...patch };
  next.heartbeatAt = now();
  next.updatedAt = next.heartbeatAt;
  return next;
}

function recordLifecycle(root, id, type, summary, detail = undefined) {
  return updateJob(root, id, (job) => {
    job.lifecycleEvents = appendLifecycleEvent(job.lifecycleEvents, type, summary, detail);
    job.heartbeatAt = now();
    if (summary) job.progress = summary.slice(0, 160);
    return job;
  });
}

function renderReviewSession(job) {
  if (job.grokSessionId) {
    return `Grok session: ${job.grokSessionId}${job.result?.providerSessionDeleted ? " (deleted after review)" : ""}`;
  }
  if (job.result?.skipped && job.result?.skipReason === "empty-target") {
    return "Grok session: not started (empty target)";
  }
  if (job.result?.providerSessionDeleted === false && job.result?.privacyWarning) {
    return "Grok session: not created (isolated home retained)";
  }
  return "Grok session: not created";
}

function renderReview(job) {
  const review = job.result?.review;
  if (!review) return renderJob(job);
  const lines = [`Grok ${job.kind} ${job.id}`, `Verdict: ${review.verdict}`, "", review.summary];
  for (const f of review.findings) lines.push("", `[${f.severity.toUpperCase()}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}`, f.body);
  lines.push("", renderReviewSession(job));
  return lines.join("\n");
}

function renderJob(job) {
  const lines = [
    `Job: ${job.id}`,
    `Kind: ${job.kind}`,
    `Status: ${job.status}`,
    `Phase: ${job.phase}`,
    `Summary: ${job.summary || "-"}`
  ];
  if (job.progress) lines.push(`Progress: ${job.progress}`);
  if (job.heartbeatAt) lines.push(`Heartbeat: ${job.heartbeatAt}`);
  if (job.createdAt) lines.push(`Created: ${job.createdAt}`);
  if (job.updatedAt) lines.push(`Updated: ${job.updatedAt}`);
  if (job.grokSessionId) {
    lines.push(
      `Grok session: ${job.grokSessionId}`,
      `Resume through this host: ${hostCommand("rescue", `--resume --job-id ${job.id} <next task>`)}`
    );
  }
  if (job.result?.workerReport) {
    const report = job.result.workerReport;
    lines.push("", `Outcome: ${report.outcome}`, report.summary);
    if (report.changedFiles?.length) lines.push(`Changed files: ${report.changedFiles.join(", ")}`);
    if (report.checksClaimed?.length) lines.push(`Checks claimed: ${report.checksClaimed.join(", ")}`);
    if (report.acceptanceResults?.length) {
      lines.push("Acceptance claims:", ...report.acceptanceResults.map((entry) => `- ${entry.id}: ${entry.status}${entry.note ? ` — ${entry.note}` : ""}`));
    }
    if (report.risks?.length) lines.push("Risks:", ...report.risks.map((item) => `- ${item}`));
    if (report.questions?.length) lines.push("Questions:", ...report.questions.map((item) => `- ${item}`));
    // Schema-v3 results store an array. Be defensive for records written by
    // 0.3.0-dev.1 before shared-reference redaction was repaired.
    if (Array.isArray(report.validationIssues) && report.validationIssues.length) {
      lines.push("Report validation:", ...report.validationIssues.map((item) => `- ${item}`));
    }
    if (job.result.hostVerification) lines.push(`Host verification: ${job.result.hostVerification}`);
    if (job.result.runtimeEvidence?.observedChangedPaths?.length) {
      lines.push(`Runtime-observed paths: ${job.result.runtimeEvidence.observedChangedPaths.join(", ")}`);
    }
  } else if (job.result?.text) {
    lines.push("", job.result.text);
  }
  if (job.error) lines.push("", `${job.error.code}: ${job.error.message}`);
  return lines.join("\n");
}

function eventUpdater(root, id) {
  let lastMessageUpdate = 0;
  return (event) => {
    const safeEvent = boundedLogEvent(redact(event));
    appendLog(root, id, safeEvent);
    if (safeEvent.type === "provider") {
      updateJob(root, id, (job) => touchJob(job, {
        providerProcess: safeEvent.process,
        profile: { ...job.profile, grokVersion: safeEvent.version },
        phase: "creating-session",
        progress: "Provider process started",
        lifecycleEvents: appendLifecycleEvent(job.lifecycleEvents, "activity.started", "Provider process started", {
          version: safeEvent.version || null
        })
      }));
    } else if (safeEvent.type === "session") {
      updateJob(root, id, (job) => touchJob(job, {
        grokSessionId: safeEvent.sessionId,
        phase: "prompting",
        progress: "Grok session created",
        lifecycleEvents: appendLifecycleEvent(job.lifecycleEvents, "checkpoint", "Grok session created")
      }));
    } else if (["tool", "plan", "message"].includes(safeEvent.type)) {
      if (safeEvent.type === "message" && Date.now() - lastMessageUpdate < 1000) return;
      if (safeEvent.type === "message") lastMessageUpdate = Date.now();
      const planItems = safeEvent.type === "plan"
        ? (safeEvent.entries || []).map((entry) => sanitizeDisplayText(entry).slice(0, 500)).filter(Boolean).slice(0, 20)
        : [];
      const progress = safeEvent.type === "tool"
        ? `${safeEvent.status || "tool"}: ${safeEvent.name || "tool"}`
        : safeEvent.type === "plan"
          ? planItems[0] || "Plan updated"
          : "Provider message";
      updateJob(root, id, (job) => {
        const type = safeEvent.type === "plan"
          ? "plan.updated"
          : safeEvent.type === "tool" && /completed|failed|cancelled/i.test(String(safeEvent.status || ""))
            ? "activity.completed"
            : safeEvent.type === "tool"
              ? "activity.started"
              : "checkpoint";
        const completedTool = safeEvent.type === "tool" && /completed|failed|cancelled/i.test(String(safeEvent.status || ""));
        const commandOutcomes = completedTool
          ? [...(job.commandOutcomes || []), {
              command: safeEvent.name || "tool",
              status: safeEvent.status || "completed",
              exitCode: Number.isInteger(safeEvent.exitCode) ? safeEvent.exitCode : null
            }].slice(-40)
          : job.commandOutcomes || [];
        return touchJob(job, {
          progress,
          phase: safeEvent.type === "tool" ? "executing" : safeEvent.type === "plan" ? "planning" : "responding",
          latestPlan: planItems.length ? planItems : job.latestPlan || [],
          commandOutcomes,
          lifecycleEvents: appendLifecycleEvent(job.lifecycleEvents, type, progress, {
            eventType: safeEvent.type,
            name: safeEvent.name || null,
            status: safeEvent.status || null,
            exitCode: Number.isInteger(safeEvent.exitCode) ? safeEvent.exitCode : null,
            ...(planItems.length ? { plan: planItems } : {})
          })
        });
      });
    }
  };
}

async function execute(root, id) {
  let job = readJob(root, id);
  let prompt = job.request?.prompt;
  if (!prompt && job.request?.envelope) {
    prompt = composeProviderPrompt(job.request.envelope, {
      root,
      contextManifest: job.request?.contextManifest || null
    });
  }
  if (!prompt) throw new CompanionError("E_STATE", "Queued job has no prompt.");

  // Keep the accepted manifest available for failure evidence; exact validation happens
  // inside the terminal-state guard below so drift is persisted on the job.
  let preContext = job.request?.contextManifest || captureContextManifest(root);
  updateJob(root, id, (current) => {
    const promptDigest = crypto.createHash("sha256").update(prompt).digest("hex");
    current.status = "running";
    current.phase = "starting";
    current.startedAt = now();
    current.summary = "Starting Grok";
    current.progress = "Starting Grok";
    current.heartbeatAt = now();
    // Retain structured envelope fields; only clear the assembled provider prompt text.
    current.request = scrubStoredRequest({
      ...current.request,
      promptDigest,
      contextManifest: current.request?.contextManifest || preContext
    });
    current.workerProcess = {
      ...(current.workerProcess || {}),
      pid: process.pid,
      startToken: processStartToken(process.pid),
      nonce: process.env.GROK_COMPANION_WORKER_NONCE || current.workerProcess?.nonce || crypto.randomBytes(16).toString("hex"),
      processGroupId: current.workerProcess?.processGroupId ?? (process.platform === "win32" ? null : process.pid),
      commandMarker: id
    };
    current.lifecycleEvents = appendLifecycleEvent(current.lifecycleEvents, "checkpoint", "Worker starting provider execution");
    return current;
  });
  const before = job.jobClass === "review" ? integritySnapshot(root) : null;
  let terminalError = null;
  let heartbeatTimer = null;
  try {
    preContext = job.request?.contextManifest
      ? assertContextCompatible(root, job.request.contextManifest, { mode: "execute" })
      : captureContextManifest(root);
    const workerNonce = process.env.GROK_COMPANION_WORKER_NONCE;
    if (isCancelRequested(root, id, workerNonce)) {
      throw new CompanionError("E_CANCELLED", "Grok job was cancelled before provider execution.");
    }
    heartbeatTimer = setInterval(() => {
      try {
        updateJob(root, id, (current) => terminal(current) ? current : touchJob(current));
      } catch {}
    }, 1000);
    heartbeatTimer.unref?.();
    const common = {
      root,
      profile: job.profile,
      prompt,
      model: job.model,
      effort: job.effort,
      stateDir: stateDir(root),
      jobMarker: id,
      providerHomeId: job.request?.providerHomeId || id,
      resumeSessionId: job.request?.resumeSessionId || null,
      cancelRequested: () => isCancelRequested(root, id, workerNonce),
      onEvent: eventUpdater(root, id)
    };
    let result = job.jobClass === "review" && job.kind !== "stop-review"
      ? await runStructuredReview(common)
      : await runProvider(common);
    if (before) assertUnchanged(before, integritySnapshot(root));
    const envelope = job.request?.envelope || null;
    let workerReport = null;
    let reportRepair = null;
    let reportRepairError = null;
    if (job.jobClass !== "review") {
      workerReport = buildWorkerReport({
        providerText: result.text || "",
        acceptanceCriteria: envelope?.acceptanceCriteria || []
      });
      if (!workerReport.valid && result.sessionId) {
        const initialResponse = textEvidence(result.text || "");
        recordLifecycle(root, id, "checkpoint", "Requesting one same-session report-format repair", {
          validationIssues: workerReport.validationIssues
        });
        try {
          const repaired = await runProvider({
            ...common,
            profile: profileFor("report-repair"),
            prompt: composeWorkerReportRepairPrompt(envelope, workerReport),
            resumeSessionId: result.sessionId
          });
          const repairedReport = buildWorkerReport({
            providerText: repaired.text || "",
            acceptanceCriteria: envelope?.acceptanceCriteria || []
          });
          reportRepair = {
            attempted: true,
            valid: repairedReport.valid,
            initialResponse,
            validationIssues: repairedReport.validationIssues
          };
          if (repairedReport.valid) {
            result = repaired;
            workerReport = repairedReport;
          }
        } catch (repairError) {
          if (repairError?.code === "E_CANCELLED") throw repairError;
          reportRepairError = repairError;
          reportRepair = {
            attempted: true,
            valid: false,
            initialResponse,
            error: redact(asErrorPayload(repairError))
          };
        }
      }
    }
    const postContext = captureContextManifest(root);
    if (job.jobClass === "review" && result.review) {
      const safeResult = redact({
        review: result.review,
        stopReason: result.stopReason,
        hostVerification: "not_run",
        runtimeEvidence: buildRuntimeEvidence({
          preContext,
          postContext,
          changedPaths: observeChangedPaths(preContext, postContext),
          executionStatus: "completed"
        })
      });
      updateJob(root, id, (current) => touchJob(current, {
        phase: "finalizing",
        completionContextManifest: postContext,
        grokSessionId: result.sessionId,
        providerProcess: result.provider?.process || null,
        profile: { ...current.profile, grokVersion: result.provider?.version || null },
        result: safeResult,
        summary: `${safeResult.review.verdict}: ${safeResult.review.summary}`.slice(0, 160),
        progress: "Review finalized",
        lifecycleEvents: appendLifecycleEvent(current.lifecycleEvents, "final.report", "Review report ready", {
          verdict: safeResult.review.verdict,
          findings: safeResult.review.findings?.length ?? 0
        })
      }));
    } else {
      const observedChanged = observeChangedPaths(preContext, postContext);
      const scopeViolations = evaluateScope(observedChanged, envelope?.scope);
      const changedPathEvidence = boundPathEvidence(observedChanged);
      const scopeViolationEvidence = boundPathEvidence(scopeViolations, { marker: "[SCOPE_VIOLATIONS_OVERFLOW]" });
      const latestJob = readJob(root, id);
      const runtimeEvidence = buildRuntimeEvidence({
        preContext,
        postContext,
        changedPaths: observedChanged,
        diffSummary: changedPathEvidence.length ? changedPathEvidence.join("\n") : "No workspace changes observed.",
        commandOutcomes: latestJob.commandOutcomes || [],
        scopeViolations,
        executionStatus: "completed"
      });
      const claimedPaths = new Set(workerReport.changedFiles);
      const observedPaths = new Set(observedChanged.filter((item) => !String(item).startsWith("[")));
      const observedFileAgreement = claimedPaths.size === observedPaths.size
        && [...claimedPaths].every((item) => observedPaths.has(item));
      const storedText = boundedProviderText(result.text || "");
      // Provider success is a claim only; hostVerification stays not_run.
      const safeResult = redact({
        ...storedText,
        interim: textEvidence(result.interimText || ""),
        ...(reportRepair ? { reportRepair } : {}),
        stopReason: result.stopReason,
        workerReport,
        providerClaims: {
          success: workerReport.valid
            && workerReport.outcome === "complete"
            && workerReport.acceptanceResults.every((entry) => entry.status === "met")
            && observedFileAgreement,
          outcome: workerReport.outcome,
          summary: workerReport.summary,
          changedFiles: workerReport.changedFiles,
          checksClaimed: workerReport.checksClaimed,
          observedFileAgreement
        },
        hostVerification: "not_run",
        runtimeEvidence
      });
      updateJob(root, id, (current) => touchJob(current, {
        phase: "finalizing",
        completionContextManifest: postContext,
        grokSessionId: result.sessionId,
        providerProcess: result.provider?.process || null,
        profile: { ...current.profile, grokVersion: result.provider?.version || null },
        result: safeResult,
        summary: workerReport.summary.slice(0, 160),
        progress: "Final report ready",
        lifecycleEvents: appendLifecycleEvent(
          workerReport.outcome === "blocked"
            ? appendLifecycleEvent(current.lifecycleEvents, "blocked", workerReport.summary, { questions: workerReport.questions })
            : current.lifecycleEvents,
          "final.report",
          "Worker report ready",
          { outcome: workerReport.outcome, structured: workerReport.structured, hostVerification: "not_run" }
        )
      }));
      if (scopeViolations.length) {
        throw new CompanionError(
          "E_SCOPE_VIOLATION",
          `Grok changed paths outside the delegated scope: ${scopeViolationEvidence.join(", ")}. Host review is required; changes were not rolled back.`,
          { paths: scopeViolationEvidence }
        );
      }
      if (reportRepairError) throw reportRepairError;
      if (!workerReport.valid) {
        throw new CompanionError(
          "E_SCHEMA",
          "Grok did not return a valid final worker report after one same-session format-repair attempt.",
          {
            repairAttempted: Boolean(reportRepair?.attempted),
            attempts: reportRepair?.attempted ? 2 : 1,
            validationIssues: workerReport.validationIssues
          }
        );
      }
    }
  } catch (error) {
    terminalError = error;
    const failedProviderProcess = providerCleanupIdentity(error);
    const postContext = (() => {
      try { return captureContextManifest(root); } catch { return null; }
    })();
    updateJob(root, id, (current) => touchJob(current, {
      phase: "finalizing",
      providerProcess: current.providerProcess || failedProviderProcess || null,
      error: redact(asErrorPayload(error)),
      summary: redactText(error.message),
      progress: error.code === "E_CONTEXT_DRIFT" ? "Blocked: context drift" : "Finalizing failure",
      result: {
        ...(current.result || {}),
        hostVerification: current.result?.hostVerification || "not_run",
        runtimeEvidence: buildRuntimeEvidence({
          preContext,
          postContext,
          changedPaths: postContext ? observeChangedPaths(preContext, postContext) : [],
          commandOutcomes: current.commandOutcomes || [],
          scopeViolations: error.code === "E_SCOPE_VIOLATION" ? error.details?.paths || [] : [],
          executionStatus: error.code === "E_CANCELLED" ? "cancelled" : "failed"
        })
      },
      completionContextManifest: postContext,
      lifecycleEvents: appendLifecycleEvent(
        current.lifecycleEvents,
        error.code === "E_CONTEXT_DRIFT" || error.code === "E_CANCELLED" ? "blocked" : "checkpoint",
        redactText(error.message)
      )
    }));
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    let taskCleanup = null;
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
    } else {
      const latest = readJob(root, id);
      const { identity } = resolveProviderCleanupTarget(root, latest);
      taskCleanup = cleanupTaskRuntimeArtifacts(
        stateDir(root),
        latest.request?.providerHomeId || id,
        [identity].filter(Boolean)
      );
      taskCleanup = includeGuardCleanup(root, id, taskCleanup);
      updateJob(root, id, (value) => {
        value.result = applyTaskPrivacy(value.result, taskCleanup);
        return value;
      });
    }
    updateJob(root, id, (current) => {
      const intendedStatus = terminalError ? (terminalError.code === "E_CANCELLED" ? "cancelled" : "failed") : "completed";
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
        current.status = intendedStatus;
        current.phase = intendedPhase;
        current.completedAt = completedAt;
        delete current.pendingTerminal;
      }
      current.heartbeatAt = now();
      return current;
    });
    retain(root);
  }
  if (terminalError) throw terminalError;
  return readJob(root, id);
}

async function startJob(root, job, background, { announce = false } = {}) {
  const nonce = crypto.randomBytes(16).toString("hex");
  job.workerAuthorization = nonce;
  admitJob(root, job);
  let diagnostic = "";
  let launcher = null;
  let launcherCode = -1;
  try {
    launcher = spawn(process.execPath, [SCRIPT, "--launch-worker", job.id, "--cwd", root], { cwd: root, shell: false, stdio: ["ignore", "ignore", "pipe"], env: workerEnvironment(nonce) });
    launcher.stderr?.setEncoding("utf8"); launcher.stderr?.on("data", (chunk) => { diagnostic = `${diagnostic}${chunk}`.slice(-8192); });
    launcherCode = await new Promise((resolve) => {
      launcher.once("error", (error) => { diagnostic = sanitizeDisplayText(error.message); resolve(-1); });
      launcher.once("close", resolve);
    });
  } catch (error) {
    diagnostic = sanitizeDisplayText(error.message);
  }
  if (launcherCode !== 0) {
    const cleanup = job.jobClass === "review" ? cleanupReviewEnvironment(stateDir(root), job.id) : null;
    const evidence = captureTerminalEvidence(root, job, "failed");
    updateJob(root, job.id, (current) => {
      current.request = scrubStoredRequest(current.request);
      current.status = "failed"; current.phase = "failed"; current.completedAt = now(); current.error = { code: "E_WORKER_LOST", message: redactText(diagnostic) || "Could not launch the isolated Grok worker." }; current.summary = current.error.message;
      current.completionContextManifest = evidence.postContext;
      current.result = { ...(current.result || {}), hostVerification: "not_run", runtimeEvidence: evidence.runtimeEvidence };
      current.lifecycleEvents = appendLifecycleEvent(current.lifecycleEvents, "blocked", current.error.message);
      if (cleanup) { current.result = { ...(current.result || {}), providerSessionDeleted: cleanup.ok }; if (cleanup.warning) current.result.privacyWarning = cleanup.warning; }
      return current;
    });
  }
  if (launcherCode === 0 && !background && announce) {
    const accepted = readJob(root, job.id);
    process.stderr.write(`GROK_JOB_ACCEPTED ${JSON.stringify({
      id: accepted.id,
      status: accepted.status,
      phase: accepted.phase,
      progress: accepted.progress || accepted.summary || "Worker started"
    })}\n`);
  }
  if (background) return readJob(root, job.id);
  let finished = readJob(root, job.id);
  let lastRecovery = 0;
  while (!terminal(finished)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (Date.now() - lastRecovery >= 500) { lastRecovery = Date.now(); await recoverActiveJobs(root); }
    finished = readJob(root, job.id);
  }
  if (finished.status === "failed" || finished.status === "cancelled") throw new CompanionError(finished.error?.code || "E_PROVIDER_EXIT", finished.error?.message || diagnostic || "Grok job failed.", finished.error?.details);
  return finished;
}

async function handleSetup(raw) {
  const { options } = parseArgs(argvFrom(raw), { booleans: ["json", "enable-review-gate", "disable-review-gate"], values: ["cwd"] });
  if (options["enable-review-gate"] && options["disable-review-gate"]) throw new CompanionError("E_USAGE", "Choose only one review-gate option.");
  const root = workspaceRoot(options.cwd ? path.resolve(options.cwd) : process.cwd(), false);
  if (options["disable-review-gate"]) setConfig(root, { stopReviewGate: false });
  let runtime;
  try { runtime = await probe(root, stateDir(root)); } catch (error) { runtime = { ready: false, error: asErrorPayload(error) }; }
  if (options["enable-review-gate"] && !runtime.error) setConfig(root, { stopReviewGate: true });
  const nextSteps = !runtime.error
    ? [`Run ${hostCommand("review", "--wait")} or ${hostCommand("rescue", "<task>")}.`]
    : runtime.error.code === "E_GROK_NOT_FOUND"
      ? ["Install with `npm install -g @xai-official/grok`, then retry."]
      : runtime.error.code === "E_AUTH_REQUIRED"
        ? ["Authenticate with `grok login`, then retry."]
        : ["Update to a compatible Grok CLI and review the reported capability or platform limitation before retrying."];
  const result = { ready: !runtime.error, grok: runtime, config: config(root), disclosure: "Grok/xAI may process task prompts, selected repository content, provider-tool output, and imported Claude Code or privacy-filtered Codex transcript context. Each task lineage uses a private Grok home under this workspace's plugin state; its sanitized cached credential is removed before the task prompt is sent, while provider session data may remain for explicit resume. Imported sessions remain under ~/.grok/sessions. Each headless review uses a private per-job home and removes it on completion or verified crash recovery.", nextSteps };
  out(options.json ? result : [`Grok Companion: ${result.ready ? "ready" : "not ready"}`, result.disclosure, ...(result.grok.version ? [`Grok ${result.grok.version}; ACP v${result.grok.protocolVersion}`, `Models: ${result.grok.models.map((x) => x.id).join(", ")}`] : [result.grok.error?.message]), `Stop gate: ${result.config.stopReviewGate ? "enabled" : "disabled"}`, ...result.nextSteps].join("\n"), options.json);
}

async function handleReview(command, raw) {
  const { options, positionals } = parseArgs(argvFrom(raw), { values: ["base", "scope", "cwd"], booleans: ["wait", "background", "json"] });
  if (command === "review" && positionals.length) throw new CompanionError("E_USAGE", `Use ${hostCommand("adversarial-review")} for custom focus text.`);
  if (options.wait && options.background) throw new CompanionError("E_USAGE", "Choose --wait or --background.");
  const root = workspaceRoot(options.cwd ? path.resolve(options.cwd) : process.cwd());
  const target = resolveTarget(root, { scope: options.scope || "auto", base: options.base || null });
  const context = collectContext(root, target), kind = command;
  const prompt = loadTemplate(command === "review" ? "review" : "adversarial-review", { TARGET_LABEL: context.target.label, REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance, REVIEW_INPUT: context.content, USER_FOCUS: positionals.join(" ") || "No extra focus provided." });
  const id = generateId(kind), profile = profileFor(kind);
  const job = baseRecord({ id, kind, root, profile, title: `${kind}: ${target.label}`, request: { prompt, target }, write: false });
  if (context.empty) {
    job.status = "completed"; job.phase = "done"; job.startedAt = job.createdAt; job.completedAt = now(); job.summary = "pass: no changes in the selected review target"; job.request = { target, prompt: null };
    // Empty targets never invoke Grok; do not claim a provider session was deleted.
    job.result = {
      review: { verdict: "pass", summary: "No changes in the selected review target.", findings: [] },
      providerSessionDeleted: false,
      skipped: true,
      skipReason: "empty-target"
    };
    writeJob(root, job);
    out(options.json ? publicJson(job) : renderReview(job), options.json);
    return;
  }
  const finished = await startJob(root, job, Boolean(options.background));
  out(options.json ? publicJson(finished) : options.background ? `Grok ${kind} started in the background.\nJob: ${id}\nCheck: ${hostCommand("status", id)}` : renderReview(finished), options.json);
}

function resumeCandidate(root, profile) {
  const host = currentHost();
  if (!host.sessionId) return null;
  // SPEC §11.5: any finished task (not queued/running) with a Grok session ID is eligible,
  // including failed/cancelled — not only completed.
  return listJobs(root).find((job) => job.kind === "task" && terminal(job) && job.grokSessionId && sameHostSession(job, host) && sameSecurityProfile(job.profile, profile));
}

function resolveResumeSource(root, profile, { resume, jobId } = {}) {
  if (!resume && !jobId) return null;
  if (jobId) {
    const prior = readJob(root, jobId);
    if (prior.kind !== "task") throw new CompanionError("E_USAGE", `Job ${jobId} is not a task job.`);
    if (!terminal(prior)) throw new CompanionError("E_JOB_ACTIVE", `Job ${jobId} is still ${prior.status}; wait or cancel it before resuming.`);
    if (!prior.grokSessionId) throw new CompanionError("E_NO_RESUME_CANDIDATE", `Job ${jobId} has no Grok session to resume.`);
    assertHostJobAccess(prior, "resumable task");
    if (!sameSecurityProfile(prior.profile, profile)) {
      throw new CompanionError("E_NO_RESUME_CANDIDATE", `Job ${jobId} security profile does not match the requested task profile.`);
    }
    // Explicit resume path: refuse when the prior job's workspace identity drifted.
    if (prior.verificationContextManifest || prior.completionContextManifest) {
      // Host checks may legitimately create generated or tracked evidence. Once the same host
      // task records bounded outcomes, resume binds to that post-verification manifest exactly.
      assertContextCompatible(root, prior.verificationContextManifest || prior.completionContextManifest, { mode: "resume" });
    } else if (prior.request?.contextManifest) {
      if (Number(prior.schemaVersion || 0) >= 3) {
        throw new CompanionError("E_CONTEXT_DRIFT", `Job ${jobId} is missing its completion context; refusing an unverifiable resume.`);
      }
      // Compatibility only for schema-v2 records. New jobs always resume from exact final state.
      assertContextCompatible(root, prior.request.contextManifest, { mode: "legacy-resume" });
    } else if (prior.workspaceRoot && fs.realpathSync(root) !== fs.realpathSync(prior.workspaceRoot)) {
      throw new CompanionError("E_CONTEXT_DRIFT", "Workspace identity drifted; refusing to resume in a different checkout.", {
        code: "E_CONTEXT_DRIFT",
        reasons: ["workspaceRoot"],
        expected: { workspaceRoot: prior.workspaceRoot },
        current: { workspaceRoot: fs.realpathSync(root) }
      });
    }
    return prior;
  }
  // Legacy compatibility path: implicit same-session candidate without --job-id.
  const candidate = resumeCandidate(root, profile);
  if (!candidate) throw new CompanionError("E_NO_RESUME_CANDIDATE", "No resumable Grok task with the same security profile exists in this host session.");
  return candidate;
}

async function handleRecordVerification(raw) {
  const { options, positionals } = parseArgs(argvFrom(raw), {
    values: ["cwd"],
    booleans: ["verification-stdin", "stdin-ready", "json"]
  });
  if (!options["verification-stdin"] || positionals.length !== 1) {
    throw new CompanionError("E_USAGE", "Use record-verification <job-id> --verification-stdin.");
  }
  const root = workspaceRoot(options.cwd ? path.resolve(options.cwd) : process.cwd());
  const input = await readBoundedStdin({
    limitBytes: 64 * 1024,
    label: "Host verification",
    onReady: stdinReadySignal(options["stdin-ready"])
  });
  const updated = withWorkspaceAdmission(root, () => {
    const job = assertHostJobAccess(readJob(root, positionals[0]), "verification");
    if (job.jobClass !== "task") throw new CompanionError("E_USAGE", `Job ${job.id} is not a task job.`);
    if (!terminal(job)) throw new CompanionError("E_JOB_ACTIVE", `Job ${job.id} is still ${job.status}; wait before recording host verification.`);
    if (!job.completionContextManifest) throw new CompanionError("E_CONTEXT_DRIFT", `Job ${job.id} has no completion context to reconcile.`);
    if (job.verificationContextManifest) throw new CompanionError("E_STATE", `Job ${job.id} already has a host verification baseline; record verification once per job.`);
    const activeWriter = listJobs(root).find((candidate) => candidate.id !== job.id && !terminal(candidate) && candidate.write);
    if (activeWriter) throw new CompanionError("E_JOB_ACTIVE", `Cannot record verification while writer ${activeWriter.id} is active.`);
    const record = parseVerificationRecord(input, job.request?.envelope?.requiredVerification || []);
    const verificationContextManifest = captureContextManifest(root);
    const observedChangedPaths = observeChangedPaths(job.completionContextManifest, verificationContextManifest);
    const scope = job.request?.envelope?.scope || { include: [], exclude: [] };
    const scopeViolations = scope.include?.length
      ? evaluateScope(observedChangedPaths, scope)
      : observedChangedPaths;
    if (scopeViolations.length) {
      const scopeViolationEvidence = boundPathEvidence(scopeViolations, { marker: "[SCOPE_VIOLATIONS_OVERFLOW]" });
      throw new CompanionError(
        "E_SCOPE_VIOLATION",
        `Host verification changed paths outside the delegated scope: ${scopeViolationEvidence.join(", ")}. Refusing to rebase the Grok lineage.`,
        { paths: scopeViolationEvidence }
      );
    }
    const observedChangedEvidence = boundPathEvidence(observedChangedPaths);
    return updateJob(root, job.id, (current) => {
      current.verificationContextManifest = verificationContextManifest;
      current.commandOutcomes = record.commandOutcomes;
      current.result = {
        ...(current.result || {}),
        hostVerification: record.outcome,
        verification: {
          outcome: record.outcome,
          authority: "host_asserted",
          recordedAt: now(),
          observedChangedPaths: observedChangedEvidence
        },
        runtimeEvidence: {
          ...(current.result?.runtimeEvidence || {}),
          commandOutcomes: record.commandOutcomes,
          hostVerification: record.outcome
        }
      };
      current.lifecycleEvents = appendLifecycleEvent(
        current.lifecycleEvents,
        record.outcome === "passed" ? "checkpoint" : "blocked",
        `Host verification ${record.outcome}`,
        { authority: "host_asserted", commands: record.commandOutcomes.length, observedChangedPaths: observedChangedEvidence }
      );
      return touchJob(current, { progress: `Host verification ${record.outcome}` });
    });
  });
  out(options.json ? publicJson(updated) : renderJob(updated), options.json);
}

async function handleTask(raw) {
  // Task argv elements are already separated by the host. Never split a lone literal task
  // argument again: embedded strings such as "--write" must not become capability flags.
  const { options, positionals } = parseArgs(raw, {
    values: ["model", "effort", "cwd", "job-id", "envelope-file"],
    booleans: ["wait", "background", "write", "resume", "fresh", "json", "envelope-stdin", "stdin-ready"]
  });
  if (options.resume && options.fresh) throw new CompanionError("E_USAGE", "Choose --resume or --fresh.");
  if (options.wait && options.background) throw new CompanionError("E_USAGE", "Choose --wait or --background.");
  if (options.fresh && options["job-id"]) throw new CompanionError("E_USAGE", "--job-id cannot be combined with --fresh.");
  if (options["job-id"] && !options.resume) {
    // Explicit job resume is the preferred native-like path; --job-id implies resume.
    options.resume = true;
  }
  validateModelEffort(options);
  const envelopeSources = Number(Boolean(options["envelope-stdin"])) + Number(Boolean(options["envelope-file"])) + Number(positionals.length > 0);
  if (envelopeSources > 1) {
    throw new CompanionError("E_USAGE", "Use exactly one of --envelope-stdin, --envelope-file, or positional task text.");
  }
  if (options["stdin-ready"] && !options["envelope-stdin"]) {
    throw new CompanionError("E_USAGE", "--stdin-ready requires --envelope-stdin.");
  }
  const envelopeInput = options["envelope-stdin"]
    ? parseTaskEnvelopeInput(await readBoundedStdin({
      label: "TaskEnvelope",
      onReady: stdinReadySignal(options["stdin-ready"])
    }))
    : options["envelope-file"]
      ? parseTaskEnvelopeInput(readPrivateEnvelopeFile(options["envelope-file"]))
      : null;
  const promptText = envelopeInput?.userRequest ?? positionals.join(" ").trim();
  if (!promptText) throw new CompanionError("E_USAGE", "Provide a task for Grok or pass --envelope-stdin.");
  if (options.write && !envelopeInput) {
    throw new CompanionError("E_USAGE", "Write tasks require a structured TaskEnvelope via --envelope-stdin or --envelope-file.");
  }
  const root = workspaceRoot(options.cwd ? path.resolve(options.cwd) : process.cwd());
  const profile = profileFor("task", Boolean(options.write));
  if (envelopeInput?.mode && (envelopeInput.mode === "write") !== Boolean(options.write)) {
    throw new CompanionError("E_USAGE", "TaskEnvelope mode must match the --write security profile.");
  }
  let prior = options.resume || options["job-id"]
    ? resolveResumeSource(root, profile, { resume: Boolean(options.resume), jobId: options["job-id"] || null })
    : null;
  if (prior?.result?.taskRuntimeCleaned === false) {
    // Only terminal cleanup-pending sources are recovered here. Queued/running
    // jobs remain explicit E_JOB_ACTIVE conflicts rather than being converted
    // and unexpectedly resumed by a new task invocation.
    await recoverActiveJobs(root);
    prior = resolveResumeSource(root, profile, { resume: Boolean(options.resume), jobId: options["job-id"] || null });
  }
  if ((options.resume || options["job-id"]) && !prior) {
    throw new CompanionError("E_NO_RESUME_CANDIDATE", "No resumable Grok task with the same security profile exists in this host session.");
  }

  const contextManifest = captureContextManifest(root);
  const envelope = buildTaskEnvelope({
    ...(envelopeInput || {}),
    userRequest: promptText,
    objective: envelopeInput?.objective || promptText,
    mode: options.write ? "write" : "read",
    contextManifestId: contextManifest.manifestId
  });
  if (options.write && envelope.scope.include.length === 0) {
    throw new CompanionError("E_USAGE", "Write TaskEnvelope scope.include must contain at least one bounded repository path or glob.");
  }
  assertTaskContextReady(envelope, contextManifest, { structuredInput: Boolean(envelopeInput) });
  const prompt = composeProviderPrompt(envelope, { root, contextManifest });
  const accepted = appendLifecycleEvent([], "task.accepted", "Task accepted", {
    envelopeId: envelope.envelopeId,
    mode: envelope.mode,
    resumeJobId: prior?.id || null
  });
  const id = generateId("task");
  const providerHomeId = prior?.request?.providerHomeId || prior?.id || id;
  const job = baseRecord({
    id,
    kind: "task",
    root,
    profile,
    title: envelope.objective.slice(0, 100),
    request: {
      prompt,
      promptDigest: null,
      resumeSessionId: prior?.grokSessionId || null,
      resumeJobId: prior?.id || null,
      providerHomeId,
      envelopeSource: options["envelope-stdin"] ? "structured-stdin" : options["envelope-file"] ? "structured-private-file" : "legacy-positional",
      publicObjective: envelopeInput?.objective ? envelope.objective : null,
      envelope,
      contextManifest
    },
    write: Boolean(options.write),
    model: options.model,
    effort: options.effort,
    lifecycleEvents: accepted
  });
  job.progress = "Task accepted";
  job.summary = "Task accepted";
  const finished = await startJob(root, job, Boolean(options.background), {
    announce: !options.background && !options.json
  });
  out(
    options.json
      ? publicJson(finished)
      : options.background
        ? `Grok task started in the background.\nJob: ${id}\nPhase: ${finished.phase}\nProgress: ${finished.progress || "Task accepted"}\nCheck: ${hostCommand("status", id)}`
        : renderJob(finished),
    options.json
  );
}

async function handleStatus(raw) {
  const { options, positionals } = parseArgs(argvFrom(raw), { values: ["timeout-ms", "cwd"], booleans: ["wait", "all", "json"] });
  if (positionals.length > 1) throw new CompanionError("E_USAGE", "Status accepts at most one job ID.");
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
  if (options.json) out(publicJson(value, { detail: !options.all }), true); else if (Array.isArray(value)) out(["| Job | Kind | Status | Phase | Progress | Heartbeat |", "|---|---|---|---|---|---|", ...value.map((j) => `| ${j.id} | ${j.kind} | ${j.status} | ${j.phase} | ${sanitizeDisplayText(j.progress || j.summary || "").replace(/\|/g, "\\|")} | ${j.heartbeatAt || j.updatedAt || "-"} |`)].join("\n")); else out(renderJob(value));
}

async function handleResult(raw) {
  const { options, positionals } = parseArgs(argvFrom(raw), { values: ["cwd"], booleans: ["json"] }); const root = workspaceRoot(options.cwd ? path.resolve(options.cwd) : process.cwd()); await recoverActiveJobs(root); const job = assertHostJobAccess(selectJob(root, { id: positionals[0], host: currentHost(), finished: !positionals[0] }), "result");
  if (!terminal(job)) throw new CompanionError("E_JOB_ACTIVE", `Job ${job.id} is still ${job.status}; run ${hostCommand("status", `${job.id} --wait`)}.`);
  out(options.json ? publicJson(job) : job.jobClass === "review" ? renderReview(job) : renderJob(job), options.json);
}

async function handleCancel(raw) {
  const { options, positionals } = parseArgs(argvFrom(raw), { values: ["cwd"], booleans: ["json"] }); const root = workspaceRoot(options.cwd ? path.resolve(options.cwd) : process.cwd()); await recoverActiveJobs(root); const job = assertHostJobAccess(selectJob(root, { id: positionals[0], host: currentHost(), active: !positionals[0] }), "active");
  // Launch window: workerAuthorization is persisted before workerProcess exists.
  // Prefer the live worker nonce; fall back to the authenticated launch nonce; fail closed if neither.
  if (!terminal(job)) requestCancel(root, job.id, job.workerProcess?.nonce || job.workerAuthorization || "");
  const deadline = Date.now() + 10000; let current = readJob(root, job.id); while (!terminal(current) && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 200)); current = readJob(root, job.id); }
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
      updateJob(root, current.id, (value) => {
        value.pendingTerminal = forcedTerminal;
        value.status = "running";
        value.phase = "cleanup-blocked";
        value.completedAt = null;
        value.error = payload;
        value.summary = payload.message;
        value.progress = "Cancellation requested; process cleanup is still pending";
        if (value.jobClass === "review") {
          value.result = applyReviewPrivacy(value.result, null, "Isolated review home retained because force-cancel process cleanup could not be verified.");
        } else {
          value.result = applyTaskPrivacy(value.result, null, "Task runtime artifacts retained because force-cancel process cleanup could not be verified.");
        }
        return value;
      });
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
      updateJob(root, current.id, (value) => {
        value.pendingTerminal = forcedTerminal;
        value.status = "running";
        value.phase = "cleanup-blocked";
        value.completedAt = null;
        value.error = { code: "E_STATE", message: "Task was stopped, but transient runtime cleanup is incomplete.", details: { privacyWarning: taskCleanup.warning } };
        value.summary = value.error.message;
        value.result = applyTaskPrivacy(value.result, taskCleanup);
        return value;
      });
      throw new CompanionError("E_STATE", "Task was stopped, but transient runtime cleanup is incomplete.", { privacyWarning: taskCleanup.warning });
    }
    let cleanup = current.jobClass === "review" ? cleanupReviewEnvironment(stateDir(root), current.id) : null;
    if (cleanup) cleanup = includeGuardCleanup(root, current.id, cleanup);
    const evidence = captureTerminalEvidence(root, current, "cancelled");
    current = updateJob(root, current.id, (value) => {
      value.status = "cancelled"; value.phase = "cancelled"; value.completedAt = now(); value.error = { code: "E_CANCELLED", message: "Grok job was force-cancelled after the graceful timeout." }; value.summary = value.error.message;
      value.request = scrubStoredRequest(value.request);
      value.completionContextManifest = evidence.postContext;
      value.result = { ...(value.result || {}), hostVerification: value.result?.hostVerification || "not_run", runtimeEvidence: evidence.runtimeEvidence };
      value.lifecycleEvents = appendLifecycleEvent(value.lifecycleEvents, "blocked", value.error.message);
      // Additive/clearing privacy: success clears a stale warning; failure appends without erasing prior evidence.
      if (cleanup) value.result = applyReviewPrivacy(value.result, cleanup);
      if (taskCleanup) value.result = applyTaskPrivacy(value.result, taskCleanup);
      return value;
    });
  }
  out(options.json ? publicJson(current) : `Cancellation requested.\n${renderJob(current)}`, options.json);
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
  try { registerProviderGuard(root, marker, identity, sessionId(), "import"); }
  catch (error) { await ensureChildExit(child, identity); throw error; }
  let stdout = "", stdoutBytes = 0, stderr = "", terminationReason = null, forceTimer = null;
  const terminate = (name) => {
    try { process.kill(identity.processGroupId && process.platform !== "win32" ? -identity.processGroupId : identity.pid, name); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const beginTermination = (reason) => {
    if (terminationReason) return;
    terminationReason = reason;
    terminate("SIGTERM");
    forceTimer = setTimeout(() => { try { terminate("SIGKILL"); } catch {} }, 2000);
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
    [code, exitSignal] = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, closedBy) => resolve([exitCode, closedBy]));
    });
  } finally {
    clearTimeout(timeout);
    if (forceTimer) clearTimeout(forceTimer);
    if (signal) signal.removeEventListener("abort", onAbort);
    await ensureChildExit(child, identity);
    unregisterProviderGuard(root, marker);
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
  const internal = command === "--launch-worker" || command === "--worker";
  const grokEnvironment = process.env.GROK_COMPANION_CHILD === "1" || process.env.GROK_COMPANION_JOB_MARKER || process.env.GROK_AGENT || process.env.GROK_LEADER_SOCKET;
  let guardedWorkspace = false;
  if (!internal && ["setup", "review", "adversarial-review", "task", "transfer"].includes(command)) {
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
    const [id, cwdFlag, cwd] = raw; if (cwdFlag !== "--cwd") throw new CompanionError("E_USAGE", "Invalid worker launcher invocation.");
    const root = workspaceRoot(cwd), nonce = process.env.GROK_COMPANION_WORKER_NONCE, record = readJob(root, id);
    if (!nonce || record.workerAuthorization !== nonce) throw new CompanionError("E_RECURSION", "Unauthenticated Grok Companion launcher invocation refused.");
    if (terminal(record) || isCancelRequested(root, id, nonce)) {
      const postContext = (() => { try { return captureContextManifest(root); } catch { return null; } })();
      updateJob(root, id, (current) => {
        current.workerAuthorization = null;
        current.status = "cancelled";
        current.phase = "cancelled";
        current.completedAt = now();
        current.heartbeatAt = current.completedAt;
        current.completionContextManifest = postContext;
        current.error = { code: "E_CANCELLED", message: "Grok job was cancelled before worker launch." };
        current.summary = current.error.message;
        current.request = scrubStoredRequest(current.request);
        current.result = {
          ...(current.result || {}),
          hostVerification: "not_run",
          runtimeEvidence: buildRuntimeEvidence({
            preContext: current.request?.contextManifest || null,
            postContext,
            changedPaths: postContext && current.request?.contextManifest
              ? observeChangedPaths(current.request.contextManifest, postContext)
              : [],
            executionStatus: "cancelled"
          })
        };
        current.lifecycleEvents = appendLifecycleEvent(current.lifecycleEvents, "blocked", current.error.message);
        return current;
      });
      return;
    }
    const child = spawn(process.execPath, [SCRIPT, "--worker", id, "--cwd", root], { cwd: root, detached: true, shell: false, stdio: "ignore", env: workerEnvironment(nonce) });
    updateJob(root, id, (current) => { current.workerAuthorization = null; current.workerProcess = { pid: child.pid, startToken: processStartToken(child.pid), nonce, processGroupId: process.platform === "win32" ? null : child.pid, commandMarker: id }; current.summary = "Worker started"; return current; });
    child.unref(); return;
  }
  if (command === "--worker") {
    const [id, cwdFlag, cwd] = raw; if (cwdFlag !== "--cwd") throw new CompanionError("E_USAGE", "Invalid worker invocation.");
    const root = workspaceRoot(cwd), nonce = process.env.GROK_COMPANION_WORKER_NONCE;
    let authorized = false;
    for (let attempt = 0; attempt < 40; attempt++) { const record = readJob(root, id); if (nonce && record.workerProcess?.nonce === nonce && record.workerProcess?.pid === process.pid && record.workerProcess?.commandMarker === id) { authorized = true; break; } await new Promise((resolve) => setTimeout(resolve, 25)); }
    if (!authorized) throw new CompanionError("E_RECURSION", "Unauthenticated Grok Companion worker invocation refused.");
    await execute(root, id); return;
  }
  if (command === "setup") return handleSetup(raw);
  if (["review", "adversarial-review"].includes(command)) return handleReview(command, raw);
  if (command === "task") return handleTask(raw);
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

main().catch((error) => { const payload = redact(asErrorPayload(error)); if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify({ ok: false, error: payload }, null, 2)}\n`); else process.stderr.write(`${payload.code}: ${payload.message}\n`); process.exitCode = exitCodeFor(error); });
