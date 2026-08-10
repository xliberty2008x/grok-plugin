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
import { structuredReviewOptionsFor } from "./lib/adversarial-review.mjs";
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
import { bindContextMetadataCompleteness } from "./lib/task-context-metadata.mjs";
import { assertResumeSourceContext } from "./lib/task-resume-context.mjs";
import {
  projectWorkerDiagnosticText,
  projectWorkerHandle,
  projectWorkerError,
  projectWorkerPublicText,
  projectWorkerSnapshot
} from "./lib/worker-protocol.mjs";
import { CONTEXT_BINDING_MODE, verifyJobEffectivePrompt } from "./lib/worker-context.mjs";
import {
  recordReviewPreProviderFailure,
  reviewLostWorkerError
} from "./lib/review-preprovider-failure.mjs";
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

const { assertContextMetadataComplete, captureCompleteContextManifest } = bindContextMetadataCompleteness({ captureContextManifest, assertContextManifestIntegrity });
const SCRIPT = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(SCRIPT), "..");
const VALID_EFFORTS = new Set(["low", "medium", "high"]);
function usage() {
  return ["Usage:", "  grok-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]", "  grok-companion.mjs review|adversarial-review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]", "  grok-companion.mjs task [--wait|--background] [--write] [--resume|--fresh] [--job-id <id>] [--model <id>] [--effort low|medium|high] [--envelope-stdin [--stdin-ready] | --envelope-file <private-path> | -- <task>]", "  grok-companion.mjs deep-research [--wait|--background] [--web-only|--workspace] [--model <id>] [--effort low|medium|high] [--query-stdin [--stdin-ready]] [--json]", "  grok-companion.mjs transfer [--source <claude-or-codex-jsonl>] [--model <id>] [--effort low|medium|high] [--json]", "  grok-companion.mjs status [job-id] [--wait] [--timeout-ms <ms>] [--all] [--readonly] [--json]", "  grok-companion.mjs result [job-id] [--json]", "  grok-companion.mjs cancel [job-id] [--json]"].join("\n");
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
  if (value.commandOutcomes.length < 1 || value.commandOutcomes.length > 64) {
    throw new CompanionError("E_USAGE", "Host verification reconciliation requires between 1 and 64 command outcomes.");
  }
  const allowedCommands = new Set(required);
  const commandOutcomes = value.commandOutcomes.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new CompanionError("E_USAGE", "Each host verification outcome must be an object.");
    const unknown = Object.keys(item).filter((key) => !["command", "status", "exitCode"].includes(key));
    if (unknown.length) throw new CompanionError("E_USAGE", `Host verification outcome contains unsupported fields: ${unknown.join(", ")}.`);
    const command = item.command;
    const status = item.status;
    if (typeof command !== "string" || !command || typeof status !== "string"
      || !["passed", "failed"].includes(status) || !Number.isInteger(item.exitCode)) {
      throw new CompanionError("E_USAGE", "Each host verification outcome requires command, status passed|failed, and an integer exitCode.");
    }
    if (!allowedCommands.has(command)) {
      throw new CompanionError(
        "E_USAGE",
        `Host verification command was not declared in requiredVerification: ${sanitizeDisplayText(command).slice(0, 2 * 1024)}`
      );
    }
    return { command, status, exitCode: item.exitCode };
  });
  const byCommand = new Map(commandOutcomes.map((item) => [item.command, item]));
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

function primaryTurnAdmissionTestHooks() {
  const directory = process.env.GROK_COMPANION_TEST_PRIMARY_TURN_BARRIER_DIR;
  if (!directory) return null;
  if (!path.isAbsolute(directory)) {
    throw new CompanionError(
      "E_USAGE",
      "The primary-turn test barrier directory must be absolute."
    );
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return Object.freeze({
    afterPrimaryTurnAdmitted: async ({ admission }) => {
      const generation = admission?.providerGeneration;
      if (![1, 2].includes(generation)) {
        throw new CompanionError(
          "E_STATE",
          "The primary-turn test barrier observed an invalid provider generation."
        );
      }
      const ready = path.join(directory, `generation-${generation}.admitted`);
      const release = path.join(directory, `generation-${generation}.release`);
      fs.writeFileSync(ready, `${admission.admissionId}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
      const deadline = Date.now() + 30_000;
      while (!fs.existsSync(release)) {
        if (Date.now() >= deadline) {
          throw new CompanionError(
            "E_TIMEOUT",
            "Timed out waiting for the primary-turn test barrier release."
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  });
}
/** Public job JSON shares Worker Protocol v1 snapshot projection with future brokers. */
function publicJob(job, options = {}) {
  return projectWorkerSnapshot(job, options);
}
function publicJson(value, options = {}) { return Array.isArray(value) ? value.map((job) => publicJob(job, options)) : publicJob(value, options); }

const TRANSFER_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function projectTransferCliError(error) {
  const projected = projectWorkerError(error);
  if (!projected
    || !["E_IMPORT_RESULT", "E_STATE"].includes(error?.code)
    || projected.code !== error.code
    || !error.details
    || typeof error.details !== "object"
    || Array.isArray(error.details)) {
    return projected;
  }
  const details = { ...(projected.details || {}) };
  const sessionId = typeof error.details.sessionId === "string"
    && TRANSFER_SESSION_ID_PATTERN.test(error.details.sessionId)
    ? error.details.sessionId
    : null;
  if (sessionId) {
    details.sessionId = sessionId;
    const resumeSuffix = ` --resume ${sessionId}`;
    const resume = typeof error.details.resume === "string"
      && error.details.resume.length <= 512
      && error.details.resume.endsWith(resumeSuffix)
      ? error.details.resume.slice(0, -resumeSuffix.length)
      : null;
    if (resume
      && /^grok --model [A-Za-z0-9._:/-]{1,128}(?: --reasoning-effort [A-Za-z0-9._-]{1,64})?$/.test(resume)) {
      details.resume = projectWorkerPublicText(
        `${resume}${resumeSuffix}`,
        { maxBytes: 512 }
      );
    }
    const deleteCommand = `grok sessions delete ${sessionId}`;
    if (error.details.delete === deleteCommand) {
      details.delete = deleteCommand;
    }
  }
  if (Array.isArray(error.details.sessionIds)) {
    const sessionIds = [...new Set(error.details.sessionIds)]
      .filter((value) => (
        typeof value === "string"
        && TRANSFER_SESSION_ID_PATTERN.test(value)
      ))
      .slice(0, 64);
    if (sessionIds.length) details.sessionIds = sessionIds;
  }
  return {
    ...projected,
    ...(Object.keys(details).length ? { details } : {})
  };
}

function researchResultJson(job) {
  const projected = publicJob(job);
  const markdown = job?.result?.researchReport?.markdown || job?.result?.researchReport?.text || null;
  if (job?.jobClass !== "research"
    || typeof markdown !== "string"
    || resultRequiresPublicOnlyProjection(job, projected)) {
    return projected;
  }
  const publicMarkdown = projectWorkerDiagnosticText(markdown, {
    job,
    maxBytes: 512 * 1024
  });
  return {
    ...projected,
    result: {
      ...(projected.result || {}),
      researchReport: {
        ...(projected.result?.researchReport || {}),
        markdown: publicMarkdown
      }
    }
  };
}
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
function redactProviderEvent(event) {
  const safe = redact(event);
  // Provider process identity is created by the local broker, not by model
  // output. Preserve its OS birth token only when the live PID still proves the
  // same token; generic redaction must continue to mask untrusted `startToken`
  // fields everywhere else.
  const identity = event?.type === "provider" ? event.process : null;
  if (
    safe?.process
    && Number.isInteger(identity?.pid)
    && typeof identity.startToken === "string"
    && identity.startToken.length <= 256
    && processStartToken(identity.pid) === identity.startToken
  ) {
    safe.process.startToken = identity.startToken;
  }
  return safe;
}
function validateModelEffort(options) { if (options.effort && !VALID_EFFORTS.has(options.effort)) throw new CompanionError("E_USAGE", "--effort must be low, medium, or high."); }

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

function exactProviderRotationIntentStatus({ root, workerId, attemptId, fence, intentId }) {
  const current = readJob(root, workerId);
  assertDispatchContract(current);
  const dispatch = current.request?.spawn?.dispatch;
  const intent = current.request?.spawn?.providerRotationIntent;
  if (!isDispatchV2(dispatch)
    || dispatch.attemptId !== attemptId
    || dispatch.fence !== fence
    || intent?.intentId !== intentId
    || intent.attemptId !== attemptId
    || intent.dispatchFence !== fence) {
    throw new CompanionError(
      "E_STATE",
      "Provider rotation intent changed before report-repair settlement."
    );
  }
  return intent.status;
}

function settlePendingProviderRotationNoChild({ root, workerId, attemptId, fence, intentId }) {
  const status = exactProviderRotationIntentStatus({
    root,
    workerId,
    attemptId,
    fence,
    intentId
  });
  if (status === "registered" || status === "no-child") return;
  if (status !== "pending") {
    throw new CompanionError("E_STATE", "Provider rotation intent is not safely settleable.");
  }

  try {
    recordWorkerProviderRotationNoChild({
      root,
      workerId,
      attemptId,
      fence,
      intentId,
      resolution: "cleanup-proven"
    });
  } catch (settlementError) {
    // A provider event can durably register generation 2 between the read above
    // and no-child settlement. Preserve the original provider/cancellation
    // error only for that exact intent; every other race fails closed.
    try {
      const latestStatus = exactProviderRotationIntentStatus({
        root,
        workerId,
        attemptId,
        fence,
        intentId
      });
      if (latestStatus === "registered" || latestStatus === "no-child") return;
    } catch {
      // The settlement error remains the authoritative fail-closed result.
    }
    throw settlementError;
  }
}

function workerEnvironment(nonce, dispatchAttemptId = null, dispatchFence = null) {
  const env = {};
  const allowed = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "TERM", "COLORTERM", "NO_COLOR", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ComSpec", "PATHEXT"]);
  for (const [key, value] of Object.entries(process.env)) if ((allowed.has(key) || key.startsWith("LC_")) && value != null) env[key] = value;
  const host = currentHost();
  // Preserve CI host flag: normalizeHostKind("ci") is null and would otherwise collapse to
  // claude-code when CLAUDE_PLUGIN_DATA is set, dropping GROK_HEADLESS_PROMPT_ON_DISK consumers.
  env.GROK_COMPANION_HOST = process.env.GROK_COMPANION_HOST === "ci" ? "ci" : host.kind;
  if (host.sessionId) env.GROK_COMPANION_HOST_SESSION_ID = host.sessionId;
  else if (process.env.GROK_COMPANION_HOST_SESSION_ID) env.GROK_COMPANION_HOST_SESSION_ID = process.env.GROK_COMPANION_HOST_SESSION_ID;
  env.GROK_COMPANION_PLUGIN_DATA = pluginDataRoot();
  // The trusted detached worker must be able to locate a configured credential so it can
  // sanitize/copy it into the isolated task home. Provider children still receive only GROK_HOME.
  if (process.env.GROK_AUTH_PATH) env.GROK_AUTH_PATH = process.env.GROK_AUTH_PATH;
  // CI headless reviews need on-disk prompts (sandbox re-exec cannot open /dev/fd/3).
  if (process.env.GROK_HEADLESS_PROMPT_ON_DISK) env.GROK_HEADLESS_PROMPT_ON_DISK = process.env.GROK_HEADLESS_PROMPT_ON_DISK;
  if (process.env.CI) env.CI = process.env.CI;
  if (process.env.GITHUB_ACTIONS) env.GITHUB_ACTIONS = process.env.GITHUB_ACTIONS;
  // This barrier is deliberately absent from trustedWorkerEnvironment's
  // allowlist. Tests can inject it only into the already-authorized controller
  // spawn wrapper to exercise the admit/consume cancellation boundary.
  if (process.env.GROK_COMPANION_TEST_PRIMARY_TURN_BARRIER_DIR) {
    env.GROK_COMPANION_TEST_PRIMARY_TURN_BARRIER_DIR =
      process.env.GROK_COMPANION_TEST_PRIMARY_TURN_BARRIER_DIR;
  }
  env.GROK_COMPANION_WORKER_NONCE = nonce;
  if (dispatchAttemptId) env.GROK_COMPANION_DISPATCH_ATTEMPT = dispatchAttemptId;
  if (Number.isSafeInteger(dispatchFence) && dispatchFence > 0) {
    env.GROK_COMPANION_DISPATCH_FENCE = String(dispatchFence);
  }
  env.GROK_DISABLE_AUTOUPDATER = "1";
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

function reconcileTerminalStopReason(result, status) {
  const next = { ...(result || {}) };
  if (status !== "cancelled" && next.stopReason === "cancelled") {
    delete next.stopReason;
  }
  return next;
}

function recheckCancelLaunchSettlement(root, id) {
  let retained = false;
  const job = updateJob(root, id, (current) => {
    if (terminal(current) || !providerLaunchCleanupBlocked(current)) return current;
    retained = true;
    const reason = "Cancellation is durable, but provider launch settlement is incomplete.";
    current.status = "running";
    current.phase = "launch-unsettled";
    current.completedAt = null;
    current.progress = "Cancellation requested; provider launch settlement is still pending";
    current.summary = reason;
    current.error = { code: "E_STATE", message: reason };
    current.result = current.jobClass === "review"
      ? applyReviewPrivacy(
        current.result,
        null,
        "Isolated review home retained because provider launch settlement is incomplete."
      )
      : applyTaskPrivacy(
        current.result,
        null,
        "Task runtime artifacts retained because provider launch settlement is incomplete."
      );
    return current;
  });
  return { job, retained };
}

function includeGuardCleanup(root, id, cleanup, { inWorkspaceTransaction = false } = {}) {
  if (!cleanup?.ok) return cleanup;
  try {
    if (inWorkspaceTransaction) {
      unregisterProviderGuardInWorkspaceTransaction(root, id);
    } else {
      unregisterProviderGuard(root, id);
    }
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

async function recoverActiveJobs(root) {
  const dispatchV1 = (candidate) => (
    isSupportedWorkerDispatch(candidate?.request?.spawn?.dispatch)
  );
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
  for (const job of listJobs(root).filter((candidate) => !dispatchV1(candidate) && terminal(candidate) && candidate.jobClass === "review" && candidate.result?.providerSessionDeleted === false && candidate.result?.skipReason !== "empty-target")) {
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
  // Terminal research records: research-only privacy/cleanup (never TaskEnvelope).
  for (const job of listJobs(root).filter((candidate) => (
    !dispatchV1(candidate)
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
  // Re-clean terminal task records produced by older runtimes or a cleanup
  // failure after provider exit. If either recorded group still lives, move the
  // record back to cleanup-blocked so the active recovery path can terminate it.
  for (const job of listJobs(root).filter((candidate) => !dispatchV1(candidate) && terminal(candidate) && candidate.jobClass === "task" && candidate.result?.taskRuntimeCleaned !== true)) {
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
        current.phase = ["E_CONTEXT_DRIFT", "E_CONTEXT_INCOMPLETE"].includes(selectedError?.code)
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
  for (const job of listJobs(root).filter((candidate) => !dispatchV1(candidate) && !terminal(candidate))) {
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
      const interruptedError = current.jobClass === "research"
        ? {
            code: "E_WORKFLOW_INCOMPLETE",
            message: "The deep-research workflow was interrupted when its worker disappeared; it was not replayed."
          }
        : current.jobClass === "review"
          ? reviewLostWorkerError(current)
          : {
              code: "E_WORKER_LOST",
              message: "The background worker disappeared; the prompt was not replayed."
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
            ["E_CONTEXT_DRIFT", "E_CONTEXT_INCOMPLETE"].includes(taskError.code)
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

async function terminateVerified(identity, marker, kind) {
  // Defense in depth: retain the provider-level platform classification while
  // sharing the exact identity/termination implementation with broker recovery.
  assertProviderPlatform();
  return terminateOwnedProcess(identity, marker, kind);
}

function baseRecord({ id, kind, root, profile, title, request, write, model, effort, lifecycleEvents = null }) {
  const timestamp = now();
  return {
    schemaVersion: 3,
    id,
    kind,
    jobClass: kind === "deep-research" ? "research" : kind.includes("review") ? "review" : "task",
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
  const sessionLabel = projectWorkerDiagnosticText(job?.grokSessionId, {
    job,
    maxBytes: 256
  });
  if (sessionLabel.trim()) {
    return `Grok session: ${sessionLabel}${job.result?.providerSessionDeleted ? " (deleted after review)" : ""}`;
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
  const projected = publicJob(job);
  const review = projected.result?.review;
  if (!review) return renderJob(job);
  const lines = [
    `Grok ${projected.kind} ${projected.id}`,
    `Verdict: ${review.verdict}`,
    "",
    review.summary
  ];
  for (const f of review.findings) lines.push("", `[${f.severity.toUpperCase()}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}`, f.body);
  lines.push("", renderReviewSession(job));
  return lines.join("\n");
}

const HUMAN_PUBLIC_ONLY_ERROR_CODES = new Set([
  "E_CONTEXT_DRIFT",
  "E_CONTEXT_INCOMPLETE",
  "E_SCOPE_VIOLATION",
  "E_PROCESS_IDENTITY"
]);

function resultRequiresPublicOnlyProjection(job, projected) {
  const publicErrors = [
    projectWorkerError(job?.pendingTerminal?.error),
    projectWorkerError(job?.error)
  ].filter(Boolean);
  if (publicErrors.some((error) => HUMAN_PUBLIC_ONLY_ERROR_CODES.has(error.code))) {
    return true;
  }
  const storedWarning = job?.result?.privacyWarning;
  return typeof storedWarning === "string"
    && storedWarning !== projected?.result?.privacyWarning;
}

function renderJob(job, { includeResearchReport = false } = {}) {
  const projected = publicJob(job);
  const result = projected.result;
  const publicOnlyResult = resultRequiresPublicOnlyProjection(job, projected);
  const sessionLabel = projectWorkerDiagnosticText(job?.grokSessionId, {
    job,
    maxBytes: 256
  });
  const lines = [
    `Job: ${projected.id}`,
    `Kind: ${projected.kind}`,
    `Status: ${projected.status}`,
    `Phase: ${projected.phase}`,
    `Summary: ${projected.summary || "-"}`
  ];
  if (projected.progress) lines.push(`Progress: ${projected.progress}`);
  if (projected.heartbeatAt) lines.push(`Heartbeat: ${projected.heartbeatAt}`);
  if (projected.createdAt) lines.push(`Created: ${projected.createdAt}`);
  if (projected.updatedAt) lines.push(`Updated: ${projected.updatedAt}`);
  if (sessionLabel.trim()) {
    lines.push(`Grok session: ${sessionLabel}`);
    if (projected.jobClass !== "research") {
      lines.push(`Resume through this host: ${hostCommand("rescue", `--resume --job-id ${projected.id} <next task>`)}`);
    }
  }
  if (result?.workerReport) {
    const report = result.workerReport;
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
    if (result.hostVerification) lines.push(`Host verification: ${result.hostVerification}`);
    if (result.runtimeEvidence?.observedChangedPaths?.length) {
      lines.push(`Runtime-observed paths: ${result.runtimeEvidence.observedChangedPaths.join(", ")}`);
    }
  } else if (projected.jobClass === "research" && result?.researchReport) {
    const report = result.researchReport;
    lines.push(
      `Workflow: ${result.workflow?.runId || "-"} (${result.workflow?.status || "-"})`,
      `Report status: ${report.status || "partial"}`,
      `Sources: ${report.sourceCount ?? 0}`,
      `Host verification: ${result.hostVerification || "not_run"}`
    );
    if (report.coverageNotes?.length) {
      lines.push("Coverage notes:", ...report.coverageNotes.map((item) => `- ${item}`));
    }
    const fullResearchReport =
      job.result?.researchReport?.markdown
      || job.result?.researchReport?.text
      || null;
    if (includeResearchReport
      && !publicOnlyResult
      && typeof fullResearchReport === "string") {
      lines.push(
        "",
        "[Untrusted provider research report]",
        projectWorkerDiagnosticText(fullResearchReport, {
          job,
          maxBytes: 512 * 1024
        })
      );
    } else if (includeResearchReport && report.textPreview) {
      lines.push(
        "",
        "[Untrusted provider research report]",
        report.textPreview
      );
    }
  } else if (!publicOnlyResult && typeof job.result?.text === "string") {
    lines.push("", projectWorkerDiagnosticText(job.result.text, {
      job,
      maxBytes: 512 * 1024
    }));
  }
  if (projected.error) {
    lines.push("", `${projected.error.code}: ${projected.error.message}`);
  }
  return lines.join("\n");
}

function renderStatusTable(jobs) {
  const handles = jobs.map((job) => projectWorkerHandle(job));
  return [
    "| Job | Kind | Status | Phase | Progress | Heartbeat |",
    "|---|---|---|---|---|---|",
    ...handles.map((handle) => (
      `| ${handle.id} | ${handle.kind} | ${handle.status} | ${handle.phase} | ${
        String(handle.progress || handle.summary || "").replace(/\|/g, "\\|")
      } | ${handle.heartbeatAt || handle.updatedAt || "-"} |`
    ))
  ];
}

function eventUpdater(root, id, dispatchAttemptId = null, providerGeneration = null, dispatchFence = null) {
  let lastMessageUpdate = 0;
  return (event) => {
    const trustedProviderProcess = event?.type === "provider" && event.process
      ? {
          pid: event.process.pid,
          startToken: event.process.startToken,
          processGroupId: event.process.processGroupId
        }
      : null;
    const trustedProviderSpawnIntentId = event?.type === "provider"
      && /^[0-9a-f]{32}$/.test(event.spawnIntentId || "")
      ? event.spawnIntentId
      : undefined;
    const safeEvent = boundedLogEvent(redactProviderEvent(event));
    appendLog(root, id, safeEvent);
    if (safeEvent.type === "provider") {
      const providerProcess = dispatchAttemptId ? {
        ...trustedProviderProcess,
        commandMarker: id,
        dispatchAttemptId,
        dispatchFence,
        providerGeneration
      } : trustedProviderProcess;
      if (dispatchAttemptId) {
        let transitioned;
        try {
          transitioned = transitionWorkerDispatch({
            root,
            workerId: id,
            attemptId: dispatchAttemptId,
            fence: dispatchFence,
            state: "provider-started",
            providerProcess,
            spawnIntentId: trustedProviderSpawnIntentId
          });
        } catch (error) {
          if (error?.code !== "E_PROCESS_IDENTITY" || providerProcess?.startToken !== null) throw error;
          recordUnsettledProviderProcess({
            root,
            workerId: id,
            attemptId: dispatchAttemptId,
            providerProcess
          });
          return;
        }
        if (terminal(transitioned)
          || transitioned.request?.spawn?.dispatch?.attemptId !== dispatchAttemptId
          || transitioned.request?.spawn?.dispatch?.state !== "provider-started") {
          throw new CompanionError(
            "E_STATE",
            "Provider promotion did not durably land on the exact active dispatch."
          );
        }
      }
      updateJob(root, id, (job) => {
        if (terminal(job)
          || (dispatchAttemptId && (
            job.request?.spawn?.dispatch?.attemptId !== dispatchAttemptId
            || job.request?.spawn?.dispatch?.state !== "provider-started"
          ))) return job;
        const promoted = touchJob(job, {
          providerProcess,
          profile: { ...job.profile, grokVersion: safeEvent.version },
          phase: "creating-session",
          progress: "Provider process started",
          lifecycleEvents: appendLifecycleEvent(job.lifecycleEvents, "activity.started", "Provider process started", {
            version: safeEvent.version || null
          })
        });
        return promoted.request?.contextBindingMode === CONTEXT_BINDING_MODE
          ? scrubStoredJob(promoted)
          : promoted;
      });
    } else if (safeEvent.type === "session") {
      updateJob(root, id, (job) => {
        if (terminal(job)
          || (dispatchAttemptId && job.request?.spawn?.dispatch?.attemptId !== dispatchAttemptId)) return job;
        return touchJob(job, {
          grokSessionId: safeEvent.sessionId,
          phase: "prompting",
          progress: "Grok session created",
          lifecycleEvents: appendLifecycleEvent(job.lifecycleEvents, "checkpoint", "Grok session created")
        });
      });
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
        if (terminal(job)
          || (dispatchAttemptId && job.request?.spawn?.dispatch?.attemptId !== dispatchAttemptId)) return job;
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

function providerOutputSchemaDigest(outputSchema) {
  if (outputSchema == null) return null;
  let serialized;
  try {
    serialized = JSON.stringify(outputSchema);
  } catch {
    throw new CompanionError(
      "E_PROTOCOL",
      "Provider output schema is not serializable JSON."
    );
  }
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

function providerLaunchBinding(profile, prompt, outputSchema = null) {
  return Object.freeze({
    promptDigest: crypto.createHash("sha256").update(String(prompt || "")).digest("hex"),
    profileId: profile?.id || null,
    profileContractVersion: profile?.contractVersion ?? null,
    agentProfileDigest: profile?.agentProfileDigest || null,
    outputSchemaDigest: providerOutputSchemaDigest(outputSchema)
  });
}

function assertPromptProviderLaunchBinding(
  observed,
  expected,
  expectedExecutableBinding = null
) {
  const promptKeys = [
    "promptDigest",
    "profileId",
    "profileContractVersion",
    "agentProfileDigest",
    "outputSchemaDigest"
  ];
  const executableKeys = expectedExecutableBinding
    ? [
        "executableIdentity",
        "providerLaunchBinding",
        "providerLaunchBindingDigest"
      ]
    : [];
  const keys = [...promptKeys, ...executableKeys];
  if (!observed
    || typeof observed !== "object"
    || Array.isArray(observed)
    || Object.keys(observed).length !== keys.length
    || Object.keys(observed).some((key) => !keys.includes(key))
    || promptKeys.some((key) => observed[key] !== expected?.[key])
    || (expectedExecutableBinding && (
      digestProviderLaunchBinding(observed.providerLaunchBinding)
        !== digestProviderLaunchBinding(expectedExecutableBinding)
      || observed.providerLaunchBindingDigest
        !== digestProviderLaunchBinding(expectedExecutableBinding)
      || observed.executableIdentity?.identityDigest
        !== expectedExecutableBinding.executableIdentityDigest
    ))) {
    throw new CompanionError(
      "E_AUTH_REQUIRED",
      "Provider launch prompt or security profile changed before process preparation."
    );
  }
  return observed;
}

function assertExecutableWorkerBinding(job, {
  dispatchAttemptId = null,
  dispatchFence = null,
  providerGeneration = null
} = {}) {
  const spawn = job?.request?.spawn;
  const hasBrokerBindingWitness = (
    job?.request?.contextBindingMode === CONTEXT_BINDING_MODE
    || Object.prototype.hasOwnProperty.call(spawn || {}, "contextBindingDigest")
    || Object.prototype.hasOwnProperty.call(spawn || {}, "idempotencyKeyDigest")
  );
  if (hasBrokerBindingWitness) {
    return assertWorkerProviderLaunchPreparation(job, {
      dispatchAttemptId,
      dispatchFence,
      providerGeneration
    });
  }
  if (dispatchAttemptId) {
    return assertDispatchContract(job);
  }
  return job;
}

async function execute(root, id, { dispatchAttemptId = null, dispatchFence = null } = {}) {
  const exactBrokerWorkerIdentity = (identity) => Boolean(
    identity?.pid === process.pid
    && identity.startToken === processStartToken(process.pid)
    && identity.nonce === process.env.GROK_COMPANION_WORKER_NONCE
    && identity.commandMarker === id
    && identity.dispatchAttemptId === dispatchAttemptId
    && (identity.dispatchFence ?? null) === (dispatchFence ?? null)
    && (process.platform === "win32"
      ? identity.processGroupId === null
      : identity.processGroupId === process.pid)
  );
  let job = readJob(root, id);
  let providerGeneration = null;
  if (dispatchAttemptId) {
    const dispatch = job.request?.spawn?.dispatch;
    const workerIdentity = job.workerProcess;
    assertDispatchContract(job);
    providerGeneration = (Number.isSafeInteger(dispatch?.providerGeneration)
      ? dispatch.providerGeneration
      : 0) + 1;
    if (terminal(job)
      || !isSupportedWorkerDispatch(dispatch)
      || dispatch.attemptId !== dispatchAttemptId
      || (isDispatchV2(dispatch) && dispatch.fence !== dispatchFence)
      || dispatch.state !== "worker-started"
      || !exactBrokerWorkerIdentity(workerIdentity)) {
      throw new CompanionError("E_RECURSION", "Unauthenticated or stale broker worker invocation refused.");
    }
  }
  const receiptBacked = job.request?.contextBindingMode === CONTEXT_BINDING_MODE;
  let providerExecutableBinding = null;
  if (Object.hasOwn(job.request?.spawn || {}, "providerLaunchBinding")
    || Object.hasOwn(
      job.request?.spawn || {},
      "providerLaunchBindingDigest"
    )) {
    providerExecutableBinding = assertExecutableProviderLaunchBinding(
      job.request.spawn.providerLaunchBinding
    );
    if (job.request.spawn.providerLaunchBindingDigest
      !== digestProviderLaunchBinding(providerExecutableBinding)) {
      throw new CompanionError(
        "E_AUTH_REQUIRED",
        "Worker provider executable binding changed after admission."
      );
    }
  }
  // Broker jobs carry a durable admission witness. Exact legacy CLI dispatches
  // do not; keep their existing dispatch contract while refusing any partial
  // or deleted broker context binding as a legacy downgrade.
  assertExecutableWorkerBinding(job, { dispatchAttemptId });
  let prompt = receiptBacked
    ? verifyJobEffectivePrompt(job, {
      root,
      contextManifest: job.request?.contextManifest || null,
      composeLegacyProviderPrompt: composeProviderPrompt
    }).prompt
    : job.request?.prompt;
  if (!prompt && job.request?.envelope) {
    prompt = composeProviderPrompt(job.request.envelope, {
      root,
      contextManifest: job.request?.contextManifest || null
    });
  }
  if (!prompt) throw new CompanionError("E_STATE", "Queued job has no prompt.");
  if (dispatchAttemptId && isDispatchV2(job.request?.spawn?.dispatch)) {
    const observedPromptDigest = crypto.createHash("sha256").update(prompt).digest("hex");
    if (job.request?.providerPromptDigest !== observedPromptDigest) {
      throw new CompanionError("E_AUTH_REQUIRED", "Provider prompt no longer matches the authorized launch contract.");
    }
  }

  // Keep the accepted manifest available for failure evidence; exact validation happens
  // inside the terminal-state guard below so drift is persisted on the job.
  let preContext = job.request?.contextManifest || captureCompleteContextManifest(root, { contextPhase: "execute" });
  updateJob(root, id, (current) => {
    if (terminal(current)) {
      throw new CompanionError("E_STATE", "A terminal worker cannot be restarted.");
    }
    if (dispatchAttemptId) {
      const dispatch = current.request?.spawn?.dispatch;
      const identity = current.workerProcess;
      assertDispatchContract(current);
      if (!isSupportedWorkerDispatch(dispatch)
        || dispatch.attemptId !== dispatchAttemptId
        || (isDispatchV2(dispatch) && dispatch.fence !== dispatchFence)
        || dispatch.state !== "worker-started"
        || !exactBrokerWorkerIdentity(identity)) {
        throw new CompanionError("E_RECURSION", "Broker worker authorization changed before execution.");
      }
      if (isDispatchV2(dispatch)
        && current.request?.providerPromptDigest
          !== crypto.createHash("sha256").update(prompt).digest("hex")) {
        throw new CompanionError("E_AUTH_REQUIRED", "Provider prompt changed before launch-contract consumption.");
      }
    }
    const promptDigest = crypto.createHash("sha256").update(prompt).digest("hex");
    const consumedLaunchContractDigest = dispatchAttemptId
      && isDispatchV2(current.request?.spawn?.dispatch)
      ? assertWorkerAuthorization(current, { allowLegacy: false }).launchContractDigest
      : null;
    current.status = "running";
    current.phase = "starting";
    current.startedAt = now();
    current.summary = "Starting Grok";
    current.progress = "Starting Grok";
    current.heartbeatAt = now();
    const startingRequest = {
      ...current.request,
      prompt: null,
      promptDigest,
      contextManifest: current.request?.contextManifest || preContext,
      ...(consumedLaunchContractDigest ? {
        spawn: {
          ...current.request?.spawn,
          consumedLaunchContractDigest,
          launchContractConsumedAt: now()
        }
      } : {})
    };
    // Receipt-backed jobs must retain the literal TaskEnvelope request through
    // the second, immediately-pre-spawn reconstruction check. Scrub it as soon
    // as the exact provider process is durably promoted below.
    if (receiptBacked) {
      current.request = startingRequest;
    } else {
      Object.assign(current, scrubStoredJob({
        ...current,
        request: startingRequest
      }));
    }
    if (consumedLaunchContractDigest) current.workerAuthorization = null;
    if (!dispatchAttemptId) {
      current.workerProcess = {
        ...(current.workerProcess || {}),
        pid: process.pid,
        startToken: processStartToken(process.pid),
        nonce: process.env.GROK_COMPANION_WORKER_NONCE || current.workerProcess?.nonce || crypto.randomBytes(16).toString("hex"),
        processGroupId: current.workerProcess?.processGroupId ?? (process.platform === "win32" ? null : process.pid),
        commandMarker: id
      };
    }
    current.lifecycleEvents = appendLifecycleEvent(current.lifecycleEvents, "checkpoint", "Worker starting provider execution");
    return current;
  });
  job = readJob(root, id);
  if (dispatchAttemptId && isDispatchV2(job.request?.spawn?.dispatch)) {
    assertDispatchContract(job);
    if (!/^[0-9a-f]{64}$/.test(job.request?.spawn?.consumedLaunchContractDigest || "")
      || !job.request?.spawn?.launchContractConsumedAt) {
      throw new CompanionError("E_AUTH_REQUIRED", "Worker launch contract consumption was not durably recorded.");
    }
  }
  const before = job.jobClass === "review" ? integritySnapshot(root) : null;
  let terminalError = null;
  let brokerPreProviderFailure = false;
  let brokerTerminalIntent = null;
  const terminalIntentFor = (error = null, summary = null) => {
    if (!dispatchAttemptId) return null;
    if (brokerTerminalIntent) return brokerTerminalIntent;
    const status = error
      ? (error.code === "E_CANCELLED" ? "cancelled" : "failed")
      : "completed";
    const payload = error ? redact(asErrorPayload(error)) : null;
    brokerTerminalIntent = Object.freeze({
      status,
      phase: status === "completed" ? "done" : status,
      completedAt: now(),
      error: payload,
      summary: summary || payload?.message || null
    });
    return brokerTerminalIntent;
  };
  const terminalIntentPatch = (current, intendedTerminal) => {
    if (!intendedTerminal || !dispatchAttemptId) return {};
    const dispatch = current.request?.spawn?.dispatch;
    if (!isSupportedWorkerDispatch(dispatch)
      || dispatch.attemptId !== dispatchAttemptId
      || (isDispatchV2(dispatch) && dispatch.fence !== dispatchFence)
      || dispatch.state !== "provider-started"
      || !exactBrokerWorkerIdentity(current.workerProcess)) return {};
    if (current.pendingTerminal
      && JSON.stringify(current.pendingTerminal) !== JSON.stringify(intendedTerminal)) {
      throw new CompanionError("E_STATE", "Durable worker terminal intent changed before finalization.");
    }
    return { pendingTerminal: intendedTerminal };
  };
  let heartbeatTimer = null;
  try {
    preContext = job.request?.contextManifest
      ? assertContextCompatible(root, job.request.contextManifest, { mode: "execute" })
      : captureCompleteContextManifest(root, { contextPhase: "execute" });
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
    // A generation-2 repair is authorized durably before runProvider starts.
    // Keep the corresponding handoff process-local and single-use so an
    // unrelated pre-existing pending intent can never admit another bootstrap.
    let providerLaunchAuthorization = null;
    const envelope = job.request?.envelope || null;
    const workerReportOutputSchema = job.jobClass === "task"
      ? buildWorkerReportOutputSchema(envelope?.acceptanceCriteria || [])
      : null;
    let expectedProviderLaunchBinding = providerLaunchBinding(
      job.profile,
      prompt,
      workerReportOutputSchema
    );
    const mailboxCapabilityDigest = job.request?.spawn?.providerCapabilityDigest;
    const mailboxEligible = Boolean(
      job.jobClass === "task"
      && receiptBacked
      && dispatchAttemptId
      && providerGeneration === 1
      && /^[a-f0-9]{64}$/.test(mailboxCapabilityDigest || "")
    );
    const primaryTurnEligible = Boolean(
      job.jobClass === "task"
      && receiptBacked
      && dispatchAttemptId
      && isDispatchV2(job.request?.spawn?.dispatch)
      && [1, 2].includes(providerGeneration)
    );
    const primaryTurnProcessBinding = (identity, { provider = false } = {}) => ({
      pid: identity?.pid ?? null,
      startToken: identity?.startToken ?? null,
      processGroupId: identity?.processGroupId ?? null,
      commandMarker: identity?.commandMarker ?? null,
      dispatchAttemptId: identity?.dispatchAttemptId ?? null,
      dispatchFence: identity?.dispatchFence ?? null,
      ...(provider
        ? { providerGeneration: identity?.providerGeneration ?? null }
        : { nonce: identity?.nonce ?? null })
    });
    const assertPrimaryTurnAuthority = (current, {
      sessionId: expectedSessionId,
      providerProcess: expectedProviderProcess,
      prompt: effectivePrompt
    }) => {
      if (!current || terminal(current)) {
        throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
      }
      assertDispatchContract(current);
      const dispatch = current.request?.spawn?.dispatch;
      const effectivePromptDigest = mailboxContentDigest(effectivePrompt);
      if (!isDispatchV2(dispatch)
        || dispatch.state !== "provider-started"
        || dispatch.attemptId !== dispatchAttemptId
        || dispatch.fence !== dispatchFence
        || dispatch.providerGeneration !== providerGeneration
        || !exactBrokerWorkerIdentity(current.workerProcess)
        || !expectedProviderLaunchBinding
        || effectivePromptDigest !== expectedProviderLaunchBinding.promptDigest
        || typeof expectedSessionId !== "string"
        || !expectedSessionId
        || current.grokSessionId !== expectedSessionId) {
        throw new CompanionError(
          "E_PROCESS_IDENTITY",
          "Primary turn authority changed before provider dispatch."
        );
      }
      if (providerExecutableBinding
        && (current.request?.spawn?.providerLaunchBindingDigest
            !== job.request?.spawn?.providerLaunchBindingDigest
          || current.request?.spawn?.providerLaunchBinding
            ?.executableIdentityDigest
            !== providerExecutableBinding.executableIdentityDigest)) {
        throw new CompanionError(
          "E_PROCESS_IDENTITY",
          "Primary turn provider executable binding changed before dispatch."
        );
      }
      const durableProvider = current.providerProcess;
      if (!durableProvider
        || durableProvider.commandMarker !== id
        || durableProvider.dispatchAttemptId !== dispatchAttemptId
        || durableProvider.dispatchFence !== dispatchFence
        || durableProvider.providerGeneration !== providerGeneration
        || !Number.isInteger(durableProvider.pid)
        || typeof durableProvider.startToken !== "string"
        || !durableProvider.startToken
        || durableProvider.pid !== expectedProviderProcess?.pid
        || durableProvider.startToken !== expectedProviderProcess?.startToken
        || durableProvider.processGroupId !== expectedProviderProcess?.processGroupId) {
        throw new CompanionError(
          "E_PROCESS_IDENTITY",
          "Primary turn provider identity changed before dispatch."
        );
      }
      return {
        current,
        effectivePromptDigest,
        workerProcess: primaryTurnProcessBinding(current.workerProcess),
        providerProcess: primaryTurnProcessBinding(durableProvider, { provider: true })
      };
    };
    const primaryTurnController = primaryTurnEligible
      ? Object.freeze({
          admit: ({
            sessionId: providerSessionId,
            providerProcess,
            prompt: effectivePrompt
          }) => withWorkspaceStateTransaction(root, (transaction) => {
            if (transaction.isCancelRequested(id, workerNonce)) {
              throw new CompanionError(
                "E_CANCELLED",
                "Grok job was cancelled before primary turn admission."
              );
            }
            const generationKey = String(providerGeneration);
            const updated = transaction.updateJob(id, (current) => {
              const authority = assertPrimaryTurnAuthority(current, {
                sessionId: providerSessionId,
                providerProcess,
                prompt: effectivePrompt
              });
              const existing = current.request?.spawn?.primaryTurnAdmissions;
              if (existing != null && (
                typeof existing !== "object"
                || Array.isArray(existing)
                || Object.keys(existing).some((key) => !["1", "2"].includes(key))
              )) {
                throw new CompanionError(
                  "E_STATE",
                  "Primary turn admission state is malformed."
                );
              }
              if (existing?.[generationKey]) {
                throw new CompanionError(
                  "E_STATE",
                  "Primary provider turn was already admitted and cannot be replayed."
                );
              }
              const admittedAt = now();
              const admission = {
                schemaVersion: 1,
                status: "admitted",
                admissionId: crypto.randomBytes(16).toString("hex"),
                dispatchAttemptId,
                dispatchFence,
                providerGeneration,
                workerProcess: authority.workerProcess,
                providerProcess: authority.providerProcess,
                providerSessionId,
                promptDigest: authority.effectivePromptDigest,
                ...(providerExecutableBinding
                  ? {
                      providerLaunchBindingDigest:
                        job.request.spawn.providerLaunchBindingDigest,
                      providerExecutableIdentityDigest:
                        providerExecutableBinding.executableIdentityDigest
                    }
                  : {}),
                admittedAt,
                consumedAt: null
              };
              return {
                ...current,
                request: {
                  ...current.request,
                  spawn: {
                    ...current.request?.spawn,
                    primaryTurnAdmissions: {
                      ...(existing || {}),
                      [generationKey]: admission
                    }
                  }
                },
                updatedAt: admittedAt
              };
            });
            return Object.freeze({
              ...updated.request.spawn.primaryTurnAdmissions[generationKey]
            });
          }),
          consume: ({
            admission,
            sessionId: providerSessionId,
            providerProcess,
            prompt: effectivePrompt
          }) => withWorkspaceStateTransaction(root, (transaction) => {
            if (transaction.isCancelRequested(id, workerNonce)) {
              throw new CompanionError(
                "E_CANCELLED",
                "Grok job was cancelled before primary turn consumption."
              );
            }
            const generationKey = String(providerGeneration);
            const updated = transaction.updateJob(id, (current) => {
              assertPrimaryTurnAuthority(current, {
                sessionId: providerSessionId,
                providerProcess,
                prompt: effectivePrompt
              });
              const stored = current.request?.spawn?.primaryTurnAdmissions?.[generationKey];
              if (!stored
                || stored.schemaVersion !== 1
                || stored.status !== "admitted"
                || stored.providerGeneration !== providerGeneration
                || stored.dispatchAttemptId !== dispatchAttemptId
                || stored.dispatchFence !== dispatchFence
                || mailboxStableDigest(stored) !== mailboxStableDigest(admission)) {
                throw new CompanionError(
                  "E_PROCESS_IDENTITY",
                  "Primary turn admission changed before exact consumption."
                );
              }
              const consumedAt = now();
              return {
                ...current,
                request: {
                  ...current.request,
                  spawn: {
                    ...current.request?.spawn,
                    primaryTurnAdmissions: {
                      ...current.request.spawn.primaryTurnAdmissions,
                      [generationKey]: {
                        ...stored,
                        status: "consumed",
                        consumedAt
                      }
                    }
                  }
                },
                updatedAt: consumedAt
              };
            });
            return Object.freeze({
              ...updated.request.spawn.primaryTurnAdmissions[generationKey]
            });
          })
        })
      : null;
    const mailboxAuthority = (transaction, {
      sessionId: expectedSessionId = null,
      providerProcess: expectedProviderProcess = null
    } = {}) => {
      const current = transaction.tryReadJob(id);
      if (!current || terminal(current)) {
        throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
      }
      assertDispatchContract(current);
      const dispatch = current.request?.spawn?.dispatch;
      if (!isDispatchV2(dispatch)
        || dispatch.state !== "provider-started"
        || dispatch.attemptId !== dispatchAttemptId
        || dispatch.fence !== dispatchFence
        || dispatch.providerGeneration !== 1
        || !exactBrokerWorkerIdentity(current.workerProcess)
        || current.request?.spawn?.providerCapabilityDigest !== mailboxCapabilityDigest) {
        throw new CompanionError(
          "E_PROCESS_IDENTITY",
          "Mailbox authority changed from the exact primary provider attempt."
        );
      }
      const durableProvider = current.providerProcess;
      if (!durableProvider
        || durableProvider.commandMarker !== id
        || durableProvider.dispatchAttemptId !== dispatchAttemptId
        || durableProvider.dispatchFence !== dispatchFence
        || durableProvider.providerGeneration !== 1
        || !Number.isInteger(durableProvider.pid)
        || typeof durableProvider.startToken !== "string"
        || !durableProvider.startToken) {
        throw new CompanionError(
          "E_PROCESS_IDENTITY",
          "Mailbox provider identity is incomplete."
        );
      }
      if (expectedProviderProcess && (
        durableProvider.pid !== expectedProviderProcess.pid
        || durableProvider.startToken !== expectedProviderProcess.startToken
        || durableProvider.processGroupId !== expectedProviderProcess.processGroupId
      )) {
        throw new CompanionError(
          "E_PROCESS_IDENTITY",
          "Mailbox provider identity changed before opening."
        );
      }
      if (expectedSessionId !== null && current.grokSessionId !== expectedSessionId) {
        throw new CompanionError(
          "E_PROCESS_IDENTITY",
          "Mailbox provider session changed before opening."
        );
      }
      if (!current.request?.contextReceipt
        || !/^[a-f0-9]{64}$/.test(current.request?.runtimeRolePolicy?.digest || "")) {
        throw new CompanionError(
          "E_CONTEXT_DRIFT",
          "Mailbox context receipt or role policy is unavailable."
        );
      }
      return current;
    };
    const reportRepairMailboxAuthority = (transaction, {
      sessionId: expectedSessionId
    }) => {
      const current = transaction.tryReadJob(id);
      if (!current || terminal(current)) {
        throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
      }
      assertDispatchContract(current);
      const dispatch = current.request?.spawn?.dispatch;
      if (!isDispatchV2(dispatch)
        || dispatch.state !== "provider-started"
        || dispatch.attemptId !== dispatchAttemptId
        || dispatch.fence !== dispatchFence
        || providerGeneration !== 2
        || dispatch.providerGeneration !== 2
        || dispatch.nextProviderGeneration !== null
        || dispatch.providerRotationCount !== 1
        || !dispatch.providerRotatedAt
        || !exactBrokerWorkerIdentity(current.workerProcess)
        || current.request?.spawn?.providerCapabilityDigest !== mailboxCapabilityDigest) {
        throw new CompanionError(
          "E_PROCESS_IDENTITY",
          "Report-repair authority changed from the exact provider rotation."
        );
      }
      const durableProvider = current.providerProcess;
      if (!durableProvider
        || durableProvider.commandMarker !== id
        || durableProvider.dispatchAttemptId !== dispatchAttemptId
        || durableProvider.dispatchFence !== dispatchFence
        || durableProvider.providerGeneration !== 2
        || !Number.isInteger(durableProvider.pid)
        || typeof durableProvider.startToken !== "string"
        || !durableProvider.startToken
        || typeof expectedSessionId !== "string"
        || !expectedSessionId
        || current.grokSessionId !== expectedSessionId) {
        throw new CompanionError(
          "E_PROCESS_IDENTITY",
          "Report-repair provider identity or session is incomplete."
        );
      }
      const attempt = readAttemptMailbox(root, id, dispatchAttemptId);
      if (!attempt
        || attempt.state !== "closed"
        || attempt.dispatchFence !== dispatchFence
        || attempt.providerGeneration !== 1
        || attempt.workerProcessDigest !== mailboxStableDigest(current.workerProcess)
        || attempt.providerSessionDigest !== mailboxStableDigest({
          providerSessionId: expectedSessionId
        })
        || attempt.providerCapabilityDigest !== mailboxCapabilityDigest
        || attempt.contextReceiptDigest
          !== mailboxStableDigest(current.request?.contextReceipt)
        || attempt.rolePolicyDigest
          !== current.request?.runtimeRolePolicy?.digest) {
        throw new CompanionError(
          "E_PROCESS_IDENTITY",
          "Closed mailbox binding changed before report-repair selection."
        );
      }
      assertNoRetainedBodies(root, id, dispatchAttemptId);
      return current;
    };
    const mailboxController = mailboxEligible
      ? Object.freeze({
          open: ({ sessionId: providerSessionId, providerProcess, providerCapabilities }) => (
            withWorkspaceStateTransaction(root, (transaction) => {
              if (providerCapabilities?.protocolVersion !== 1
                || providerCapabilities?.agentCapabilities?.loadSession !== true) {
                throw new CompanionError(
                  "E_CAPABILITY",
                  "Provider did not retain the required ACP mailbox capability."
                );
              }
              const current = mailboxAuthority(transaction, {
                sessionId: providerSessionId,
                providerProcess
              });
              return openAttemptMailbox(root, {
                workerId: id,
                dispatchAttemptId,
                dispatchFence,
                workerProcessDigest: mailboxStableDigest(current.workerProcess),
                providerProcessDigest: mailboxStableDigest(current.providerProcess),
                providerGeneration: 1,
                providerSessionDigest: mailboxStableDigest({
                  providerSessionId
                }),
                providerCapabilityDigest: mailboxCapabilityDigest,
                contextReceiptDigest: mailboxStableDigest(current.request.contextReceipt),
                rolePolicyDigest: current.request.runtimeRolePolicy.digest
              });
            })
          ),
          recordPrimary: ({ attempt, prompt: effectivePrompt }) => (
            withWorkspaceStateTransaction(root, (transaction) => {
              const current = mailboxAuthority(transaction);
              const promptDigest = mailboxContentDigest(effectivePrompt);
              if (current.request?.providerPromptDigest !== promptDigest
                || attempt?.dispatchAttemptId !== dispatchAttemptId) {
                throw new CompanionError(
                  "E_AUTH_REQUIRED",
                  "Primary mailbox turn no longer matches the authorized prompt."
                );
              }
              return recordPrimaryTurn(root, id, dispatchAttemptId, {
                contentDigest: promptDigest,
                composedPromptDigest: promptDigest,
                pumpOwnerDigest: attempt.pumpOwnerDigest
              });
            })
          ),
          drain: async ({
            attempt,
            client,
            sessionId: providerSessionId,
            collectTurnText,
            timeoutMs,
            cancelRequested
          }) => {
            const drained = await drainWorkerMailbox({
              root,
              workerId: id,
              attemptId: dispatchAttemptId,
              client,
              sessionId: providerSessionId,
              composePrompt: ({ message, sequence }) => composeMailboxTurnPrompt(message, {
                sequence,
                workerId: id
              }),
              collectTurnText,
              outputSchema: workerReportOutputSchema,
              timeoutMs,
              cancelRequested,
              validateAuthority: (transaction) => {
                const current = mailboxAuthority(transaction, {
                  sessionId: providerSessionId
                });
                const currentAttempt = readAttemptMailbox(
                  root,
                  id,
                  dispatchAttemptId
                );
                if (!currentAttempt
                  || currentAttempt.pumpOwnerDigest !== attempt.pumpOwnerDigest
                  || currentAttempt.workerProcessDigest
                    !== mailboxStableDigest(current.workerProcess)
                  || currentAttempt.providerProcessDigest
                    !== mailboxStableDigest(current.providerProcess)) {
                  throw new CompanionError(
                    "E_PROCESS_IDENTITY",
                    "Mailbox attempt binding changed while pumping."
                  );
                }
              }
            });
            return {
              ...drained,
              bodiesRetained: !assertNoRetainedBodies(
                root,
                id,
                dispatchAttemptId
              )
            };
          },
          interrupt: ({ attempt, reason }) => withWorkspaceStateTransaction(
            root,
            (transaction) => {
              mailboxAuthority(transaction);
              const currentAttempt = readAttemptMailbox(root, id, dispatchAttemptId);
              if (!currentAttempt
                || currentAttempt.pumpOwnerDigest !== attempt.pumpOwnerDigest) {
                throw new CompanionError(
                  "E_PROCESS_IDENTITY",
                  "Mailbox attempt changed before interruption settlement."
                );
              }
              return settleInterruptedAttempt(
                root,
                id,
                dispatchAttemptId,
                { reason }
              );
            }
          ),
          selectReport: ({ sequence, valid, reportDigest }) => (
            withWorkspaceStateTransaction(root, (transaction) => {
              mailboxAuthority(transaction);
              return selectFinalReportSequence(root, id, dispatchAttemptId, {
                sequence,
                valid,
                reportDigest
              });
            })
          ),
          selectRepairedReport: ({
            sequence,
            reportDigest,
            sessionId: providerSessionId
          }) => (
            withWorkspaceStateTransaction(root, (transaction) => {
              reportRepairMailboxAuthority(transaction, {
                sessionId: providerSessionId
              });
              return selectFinalReportSequence(root, id, dispatchAttemptId, {
                sequence,
                valid: true,
                reportDigest
              });
            })
          )
        })
      : null;
    const primaryTurnTestHooks = primaryTurnEligible
      ? primaryTurnAdmissionTestHooks()
      : null;
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
      ...(dispatchAttemptId ? {
        guardBinding: createProviderGuardBindingForJob(job, {
          dispatchAttemptId,
          dispatchFence,
          providerGeneration
        }),
        providerLaunch: {
          prepare: (observedLaunchBinding) => {
            const latest = readJob(root, id);
            assertExecutableWorkerBinding(latest, {
              dispatchAttemptId,
              dispatchFence,
              providerGeneration
            });
            assertPromptProviderLaunchBinding(
              observedLaunchBinding,
              expectedProviderLaunchBinding,
              providerExecutableBinding
            );
            if (providerGeneration === 1
              && latest.request?.contextBindingMode === CONTEXT_BINDING_MODE) {
              const verified = verifyJobEffectivePrompt(latest, {
                root,
                contextManifest: latest.request?.contextManifest || null,
                composeLegacyProviderPrompt: composeProviderPrompt
              });
              if (verified.digest !== observedLaunchBinding.promptDigest
                || verified.prompt !== prompt) {
                throw new CompanionError(
                  "E_AUTH_REQUIRED",
                  "Provider prompt changed before provider launch preparation."
                );
              }
            }
            const authorization = providerLaunchAuthorization;
            providerLaunchAuthorization = null;
            const candidate = prepareWorkerProviderSpawn({
              root,
              workerId: id,
              attemptId: dispatchAttemptId,
              fence: dispatchFence,
              providerGeneration
            });
            if (candidate?.prepared === true) return candidate;
            if (authorization
              && candidate?.reason === "already-pending"
              && candidate?.intent?.status === "pending"
              && candidate.intent.intentId === authorization.intentId
              && candidate.intent.providerGeneration === authorization.providerGeneration) {
              return Object.freeze({
                ...candidate,
                prepared: true,
                reason: "preauthorized-rotation"
              });
            }
            return candidate;
          },
          noChild: ({ intentId, resolution }) => recordWorkerProviderSpawnNoChild({
            root,
            workerId: id,
            attemptId: dispatchAttemptId,
            fence: dispatchFence,
            providerGeneration,
            intentId,
            resolution
          })
        }
      } : {}),
      ...(providerExecutableBinding
        ? {
            providerExecutableBinding,
            providerExecutableEnv: process.env
          }
        : {}),
      ...(primaryTurnController ? { primaryTurnController } : {}),
      ...(mailboxController ? { mailboxController } : {}),
      ...(workerReportOutputSchema
        ? { outputSchema: workerReportOutputSchema }
        : {}),
      ...(primaryTurnTestHooks ? { testHooks: primaryTurnTestHooks } : {}),
      onEvent: eventUpdater(root, id, dispatchAttemptId, providerGeneration, dispatchFence)
    };
    let result = job.jobClass === "review" && job.kind !== "stop-review"
      ? await runStructuredReview(structuredReviewOptionsFor(job.kind, common))
      : await runProvider(common);
    if (before) assertUnchanged(before, integritySnapshot(root));
    let workerReport = null;
    let reportRepair = null;
    let reportRepairError = null;
    if (job.jobClass !== "review") {
      workerReport = buildWorkerReport({
        providerText: result.text || "",
        ...(Object.hasOwn(result, "structuredOutput")
          ? { nativeStructuredOutput: result.structuredOutput }
          : {}),
        ...(Object.hasOwn(result, "structuredOutputError")
          ? { nativeStructuredOutputError: result.structuredOutputError }
          : {}),
        acceptanceCriteria: envelope?.acceptanceCriteria || []
      });
      if (result.mailboxEvidence) {
        const reportDigest = workerReport.valid
          ? (workerReport.reportSource === "acp-structured"
              ? workerReport.reportDigest
              : boundedProviderText(result.text || "").textDigest)
          : null;
        const selected = mailboxController.selectReport({
          sequence: result.mailboxEvidence.selectedSequence,
          valid: workerReport.valid,
          reportDigest
        });
        result = {
          ...result,
          mailboxEvidence: {
            ...result.mailboxEvidence,
            finalReportSequence: selected.finalReportSequence,
            finalReportDigest: selected.finalReportDigest,
            communicationChainDigest: selected.communicationChainDigest
          }
        };
      }
      if (!workerReport.valid && result.sessionId) {
        const initialResponse = textEvidence(result.text || "");
        recordLifecycle(root, id, "checkpoint", "Requesting one same-session report-format repair", {
          validationIssues: workerReport.validationIssues
        });
        let providerRotationIntentId = null;
        try {
          if (dispatchAttemptId) {
            const rotationAuthorization = authorizeWorkerProviderRotation({
              root,
              workerId: id,
              attemptId: dispatchAttemptId,
              workerProcess: job.workerProcess
            });
            providerGeneration = rotationAuthorization.providerGeneration;
            providerRotationIntentId = rotationAuthorization.intentId;
            providerLaunchAuthorization = Object.freeze({
              intentId: rotationAuthorization.intentId,
              providerGeneration: rotationAuthorization.providerGeneration
            });
          }
          const repairProfile = profileFor("report-repair");
          const repairPrompt = composeWorkerReportRepairPrompt(envelope, workerReport);
          expectedProviderLaunchBinding = providerLaunchBinding(
            repairProfile,
            repairPrompt,
            workerReportOutputSchema
          );
          const repaired = await runProvider({
            ...common,
            profile: repairProfile,
            prompt: repairPrompt,
            outputSchema: workerReportOutputSchema,
            resumeSessionId: result.sessionId,
            mailboxController: null,
            ...(dispatchAttemptId ? {
              guardBinding: {
                ...common.guardBinding,
                providerGeneration
              },
              onEvent: eventUpdater(root, id, dispatchAttemptId, providerGeneration, dispatchFence)
            } : {})
          });
          const repairedReport = buildWorkerReport({
            providerText: repaired.text || "",
            ...(Object.hasOwn(repaired, "structuredOutput")
              ? { nativeStructuredOutput: repaired.structuredOutput }
              : {}),
            ...(Object.hasOwn(repaired, "structuredOutputError")
              ? { nativeStructuredOutputError: repaired.structuredOutputError }
              : {}),
            acceptanceCriteria: envelope?.acceptanceCriteria || []
          });
          reportRepair = {
            attempted: true,
            valid: repairedReport.valid,
            initialResponse,
            validationIssues: repairedReport.validationIssues
          };
          if (repairedReport.valid) {
            const priorMailboxEvidence = result.mailboxEvidence || null;
            const repairedMailboxSelection = priorMailboxEvidence
              ? mailboxController.selectRepairedReport({
                  sequence: priorMailboxEvidence.selectedSequence,
                  reportDigest: repairedReport.reportSource === "acp-structured"
                    ? repairedReport.reportDigest
                    : boundedProviderText(repaired.text || "").textDigest,
                  sessionId: repaired.sessionId
                })
              : null;
            result = {
              ...repaired,
              ...(priorMailboxEvidence
                ? {
                    mailboxEvidence: {
                      ...priorMailboxEvidence,
                      finalReportSequence: repairedMailboxSelection.finalReportSequence,
                      finalReportDigest: repairedMailboxSelection.finalReportDigest,
                      communicationChainDigest:
                        repairedMailboxSelection.communicationChainDigest
                    }
                  }
                : {})
            };
            workerReport = repairedReport;
          }
        } catch (repairError) {
          if (dispatchAttemptId
            && providerRotationIntentId
            && providerCleanupIdentity(repairError) == null) {
            settlePendingProviderRotationNoChild({
              root,
              workerId: id,
              attemptId: dispatchAttemptId,
              fence: dispatchFence,
              intentId: providerRotationIntentId
            });
          }
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
    const postContext = captureCompleteContextManifest(root, { contextPhase: "terminal" });
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
      updateJob(root, id, (current) => terminal(current) ? current : touchJob(current, {
        phase: "finalizing",
        completionContextManifest: postContext,
        grokSessionId: result.sessionId,
        providerProcess: current.providerProcess || result.provider?.process || null,
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
      const mailboxLifecycleValid = !result.mailboxEvidence || (
        result.mailboxEvidence.deliveryUnknown === false
        && result.mailboxEvidence.closed === true
        && result.mailboxEvidence.bodiesRetained === false
      );
      const selectedReportDigest = workerReport.reportSource === "acp-structured"
        ? workerReport.reportDigest
        : storedText.textDigest;
      const mailboxFinalReportBound = !result.mailboxEvidence || (
        Number.isSafeInteger(result.mailboxEvidence.selectedSequence)
        && result.mailboxEvidence.selectedSequence
          === result.mailboxEvidence.lastCompletedSequence
        && result.mailboxEvidence.finalReportSequence
          === result.mailboxEvidence.lastCompletedSequence
        && result.mailboxEvidence.finalReportDigest === selectedReportDigest
      );
      // Provider success is a claim only; hostVerification stays not_run.
      const safeResult = redact({
        ...storedText,
        interim: textEvidence(result.interimText || ""),
        ...(result.mailboxEvidence
          ? { mailboxEvidence: result.mailboxEvidence }
          : {}),
        ...(reportRepair ? { reportRepair } : {}),
        stopReason: result.stopReason,
        workerReport,
        providerClaims: {
          success: workerReport.valid
            && workerReport.outcome === "complete"
            && workerReport.acceptanceResults.every((entry) => entry.status === "met")
            && observedFileAgreement
            && mailboxLifecycleValid
            && mailboxFinalReportBound,
          outcome: workerReport.outcome,
          summary: workerReport.summary,
          changedFiles: workerReport.changedFiles,
          checksClaimed: workerReport.checksClaimed,
          observedFileAgreement
        },
        hostVerification: "not_run",
        runtimeEvidence
      });
      let finalTaskError = null;
      if (scopeViolations.length) {
        finalTaskError = new CompanionError(
          "E_SCOPE_VIOLATION",
          `Grok changed paths outside the delegated scope: ${scopeViolationEvidence.join(", ")}. Host review is required; changes were not rolled back.`,
          { paths: scopeViolationEvidence }
        );
      } else if (!mailboxLifecycleValid) {
        finalTaskError = new CompanionError(
          "E_DELIVERY",
          "Ordered mailbox delivery could not be proven complete without ambiguity."
        );
      } else if (reportRepairError) {
        finalTaskError = reportRepairError;
      } else if (!workerReport.valid) {
        finalTaskError = new CompanionError(
          "E_SCHEMA",
          "Grok did not return a valid final worker report after one same-session format-repair attempt.",
          {
            repairAttempted: Boolean(reportRepair?.attempted),
            attempts: reportRepair?.attempted ? 2 : 1,
            validationIssues: workerReport.validationIssues
          }
        );
      } else if (!mailboxFinalReportBound) {
        finalTaskError = new CompanionError(
          "E_STATE",
          "The final worker report is not bound to the last completed mailbox turn."
        );
      } else if (reportRepair?.valid
        && result.mailboxEvidence
        && workerReport.hostActionRequest) {
        finalTaskError = new CompanionError(
          "E_CAPABILITY",
          "Host actions cannot be requested by a report-format repair generation."
        );
      } else if (workerReport.hostActionRequest?.requestedRoleId === "implementer") {
        finalTaskError = new CompanionError(
          "E_CAPABILITY",
          "Implementer admission is disabled until Phase 3 isolated execution is available."
        );
      }
      const intendedTerminal = terminalIntentFor(finalTaskError, finalTaskError?.message || workerReport.summary);
      try {
        updateJob(root, id, (current) => {
          if (terminal(current)) return current;
          const withHostAction = !finalTaskError && workerReport.hostActionRequest
            ? attachHostActionRequestToJob(current, {
              providerRequest: workerReport.hostActionRequest,
              dispatchAttemptId,
              dispatchFence,
              providerGeneration,
              providerSessionId: result.sessionId,
              communicationChainDigest:
                safeResult.mailboxEvidence?.communicationChainDigest ?? null,
              finalReportDigest:
                safeResult.mailboxEvidence?.finalReportDigest ?? null
            })
            : current;
          return touchJob(withHostAction, {
            phase: "finalizing",
            completionContextManifest: postContext,
            grokSessionId: result.sessionId,
            providerProcess: withHostAction.providerProcess || result.provider?.process || null,
            profile: { ...withHostAction.profile, grokVersion: result.provider?.version || null },
            result: safeResult,
            summary: workerReport.summary.slice(0, 160),
            progress: "Final report ready",
            ...terminalIntentPatch(withHostAction, intendedTerminal),
            lifecycleEvents: appendLifecycleEvent(
              workerReport.outcome === "blocked"
                ? appendLifecycleEvent(withHostAction.lifecycleEvents, "blocked", workerReport.summary, { questions: workerReport.questions })
                : withHostAction.lifecycleEvents,
              "final.report",
              "Worker report ready",
              { outcome: workerReport.outcome, structured: workerReport.structured, hostVerification: "not_run" }
            )
          });
        });
      } catch (finalizationError) {
        // A late binding failure must not inherit an already-cached successful
        // terminal intent.
        brokerTerminalIntent = null;
        throw finalizationError;
      }
      if (finalTaskError) throw finalTaskError;
    }
  } catch (error) {
    terminalError = error;
    const intendedTerminal = terminalIntentFor(error, redactText(error.message));
    const failedProviderProcess = providerCleanupIdentity(error);
    const mailboxFailureEvidence = (() => {
      if (!dispatchAttemptId) return null;
      try {
        const attempt = readAttemptMailbox(root, id, dispatchAttemptId);
        if (!attempt) return null;
        return {
          schemaVersion: 1,
          attemptId: dispatchAttemptId,
          communicationChainDigest: attempt.communicationChainDigest,
          lastCompletedSequence: attempt.lastCompletedSequence,
          finalReportSequence: attempt.finalReportSequence,
          finalReportDigest: attempt.finalReportDigest,
          acceptedCount: attempt.acceptedCount,
          acceptedBytes: attempt.acceptedBytes,
          deliveryUnknown: attempt.deliveryUnknownSequence !== null,
          closed: attempt.state === "closed",
          bodiesRetained: (() => {
            try {
              assertNoRetainedBodies(root, id, dispatchAttemptId);
              return false;
            } catch {
              return true;
            }
          })()
        };
      } catch {
        return null;
      }
    })();
    const postContext = (() => {
      try { return captureContextManifest(root); } catch { return null; }
    })();
    updateJob(root, id, (current) => {
      if (terminal(current)) return current;
      const providerProcess = current.providerProcess || (
        !dispatchAttemptId || (typeof failedProviderProcess?.startToken === "string" && failedProviderProcess.startToken)
          ? failedProviderProcess || null
          : null
      );
      return touchJob(current, {
        phase: "finalizing",
        providerProcess,
        error: redact(asErrorPayload(error)),
        summary: redactText(error.message),
        progress: ["E_CONTEXT_DRIFT", "E_CONTEXT_INCOMPLETE"].includes(error.code) ? "Blocked: context unavailable" : "Finalizing failure",
        ...terminalIntentPatch(current, intendedTerminal),
        result: {
          ...(current.result || {}),
          ...(mailboxFailureEvidence
            ? { mailboxEvidence: mailboxFailureEvidence }
            : {}),
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
          ["E_CONTEXT_DRIFT", "E_CONTEXT_INCOMPLETE", "E_CANCELLED"].includes(error.code) ? "blocked" : "checkpoint",
          redactText(error.message)
        )
      });
    });
    if (dispatchAttemptId) {
      const current = readJob(root, id);
      brokerPreProviderFailure = !terminal(current)
        && current.request?.spawn?.dispatch?.attemptId === dispatchAttemptId
        && current.request?.spawn?.dispatch?.state === "worker-started"
        && exactBrokerWorkerIdentity(current.workerProcess);
    }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
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
    } else if (!dispatchAttemptId || brokerPreProviderFailure) {
      const latest = readJob(root, id);
      const { identity } = resolveProviderCleanupTarget(root, latest);
      taskCleanup = cleanupTaskRuntimeArtifacts(
        stateDir(root),
        latest.request?.providerHomeId || id,
        [identity].filter(Boolean)
      );
      taskCleanup = includeGuardCleanup(root, id, taskCleanup);
      if (!brokerPreProviderFailure) {
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
      if (terminalError) throw terminalError;
      return readJob(root, id);
    }
    if (brokerPreProviderFailure) {
      const current = readJob(root, id);
      const intendedStatus = terminalError?.code === "E_CANCELLED" ? "cancelled" : "failed";
      settlePreProviderWorkerFinalization({
        root,
        workerId: id,
        attemptId: dispatchAttemptId,
        workerProcess: current.workerProcess,
        intendedTerminal: {
          status: intendedStatus,
          phase: intendedStatus,
          completedAt: now(),
          error: current.error || redact(asErrorPayload(terminalError)),
          summary: current.summary || redactText(terminalError?.message || "Worker failed before provider startup")
        },
        runtimeCleanup: taskCleanup || {
          ok: false,
          warning: "Task runtime cleanup outcome is unavailable."
        }
      });
      retain(root);
      if (terminalError) throw terminalError;
      return readJob(root, id);
    }
    if (dispatchAttemptId) {
      // Failed/unsettled broker generations are owned by authoritative
      // recovery. Never fall through to the legacy task cleanup/finalization
      // path, which has no generation binding.
      retain(root);
      if (terminalError) throw terminalError;
      return readJob(root, id);
    }
    updateJob(root, id, (current) => {
      if (terminal(current)) return current;
      const pending = current.pendingTerminal || null;
      const intendedStatus = pending?.status
        || (terminalError
          ? (terminalError.code === "E_CANCELLED" ? "cancelled" : "failed")
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
            pending ? pending.error || null : current.error || terminalError,
            current.error || terminalError
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
            terminalError = selectedError;
          } else {
            current.error = null;
            if (pending?.summary) current.summary = pending.summary;
            terminalError = null;
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
  if (terminalError) throw terminalError;
  return readJob(root, id);
}

function invalidProviderCapabilityError() {
  return new CompanionError(
    "E_CAPABILITY",
    missingInvalidProviderCapabilityReceiptMessage()
  );
}

function requiredProviderSpawnBinding() {
  const capabilityReceipt = readValidProviderCapabilityReceipt();
  if (!capabilityReceipt) {
    throw invalidProviderCapabilityError();
  }
  const providerLaunchBinding = assertExecutableProviderLaunchBinding(
    capabilityReceipt.providerLaunchBinding
  );
  const providerLaunchBindingDigest = digestProviderLaunchBinding(
    providerLaunchBinding
  );
  if (providerLaunchBindingDigest !== capabilityReceipt.providerLaunchBindingDigest) {
    throw invalidProviderCapabilityError();
  }
  const providerCapabilityDigest = capabilityReceipt.capabilityDigest;
  return Object.freeze({
    providerCapabilityDigest,
    providerLaunchBinding,
    providerLaunchBindingDigest
  });
}

function prepareSharedTaskDispatch(root, job) {
  const host = job.host;
  if (job.jobClass !== "task"
    || host?.kind !== "codex"
    || !host.sessionId) return null;
  // Natural Codex tasks (read and write) must pin the exact setup-owned
  // provider readiness receipt before admitJob so detached workers cannot drift
  // to an ambient Grok binary. capabilityDigest is setup/readiness provenance
  // only; implementer profile and launch authorization remain separate.
  const providerSpawnBinding = requiredProviderSpawnBinding();
  if (job.write) {
    // Direct Codex write tasks retain the established nonce launcher until they
    // have a provisioned execution binding. They still carry the exact setup
    // provider pin so their detached worker cannot fall back to ambient Grok.
    job.request = {
      ...job.request,
      spawn: {
        ...(job.request?.spawn || {}),
        ...providerSpawnBinding
      }
    };
    return null;
  }
  const principal = Object.freeze({ hostKind: host.kind, threadId: host.sessionId, pluginId: null });
  const role = materializeRole(job.write ? "implementer" : "explorer");
  const createdAt = job.createdAt || now();
  const { controlWorkspaceId, executionRoot } = resolveControlWorkspace(root);
  const requestDigest = workerLaunchDigest({
    schemaVersion: 1,
    workerId: job.id,
    host,
    write: Boolean(job.write),
    profile: job.profile,
    role,
    envelopeDigest: job.request?.envelope?.digest || null,
    contextManifestDigest: job.request?.contextManifest?.digest || null,
    resumeJobId: job.request?.resumeJobId || null,
    resumeSessionId: job.request?.resumeSessionId || null,
    providerHomeId: job.request?.providerHomeId || job.id,
    providerCapabilityDigest: providerSpawnBinding.providerCapabilityDigest,
    providerLaunchBindingDigest:
      providerSpawnBinding.providerLaunchBindingDigest
  });
  job.controlWorkspaceId = controlWorkspaceId;
  job.role = { ...role, tools: [...role.tools] };
  job.phase = "accepted";
  job.request = {
    ...job.request,
    providerPromptDigest: crypto
      .createHash("sha256")
      .update(String(job.request?.prompt || ""))
      .digest("hex"),
    roleId: role.id,
    spawn: {
      executionRoot,
      ownerThreadId: host.sessionId,
      requestDigest,
      successDefinition: "durable-job-commit",
      ownershipMode: "exact-host-session",
      ...providerSpawnBinding,
      providerLaunchPending: true,
      providerLaunchInFlight: false,
      providerLaunchOutcome: "pending",
      dispatch: createDispatchOutbox({ createdAt })
    }
  };
  job.workerAuthorization = null;
  job.workerAuthorization = createWorkerAuthorization({ job, principal, issuedAt: createdAt });
  return principal;
}

async function startJob(root, job, background, { announce = false } = {}) {
  const sharedPrincipal = prepareSharedTaskDispatch(root, job);
  const nonce = sharedPrincipal ? null : crypto.randomBytes(16).toString("hex");
  if (!sharedPrincipal) job.workerAuthorization = nonce;
  admitJob(root, job);
  let diagnostic = "";
  let launcher = null;
  let launcherCode = -1;
  if (sharedPrincipal) {
    try {
      launchCommittedWorker({ root, workerId: job.id, principal: sharedPrincipal });
      launcherCode = 0;
    } catch (error) {
      diagnostic = sanitizeDisplayText(error.message);
    }
  } else {
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
  }
  if (launcherCode !== 0) {
    if (job.jobClass === "task") {
      // A failed nonce launcher does not prove that no detached child crossed
      // the spawn boundary. Keep task terminal intent durable but nonterminal;
      // an exact recovery owner must prove process/runtime cleanup before final
      // workspace observation and publication.
      updateJob(root, job.id, (current) => {
        if (terminal(current)
          || isSupportedWorkerDispatch(current.request?.spawn?.dispatch)) {
          return current;
        }
        const intendedMessage =
          redactText(diagnostic) || "Could not launch the isolated Grok worker.";
        const blockedMessage =
          "Worker launch failed, but detached process and runtime cleanup are not yet proven.";
        current.status = "running";
        current.phase = "launch-unsettled";
        current.completedAt = null;
        current.pendingTerminal = {
          status: "failed",
          phase: "failed",
          completedAt: now(),
          error: {
            code: "E_WORKER_LOST",
            message: intendedMessage
          },
          summary: intendedMessage
        };
        current.error = {
          code: "E_PROCESS_IDENTITY",
          message: blockedMessage
        };
        current.summary = blockedMessage;
        current.progress =
          "Worker launch failed; exact process and runtime cleanup remain pending";
        current.result = applyTaskPrivacy(
          current.result,
          null,
          "Task runtime artifacts retained until failed-launch cleanup is proven."
        );
        current.lifecycleEvents = appendLifecycleEvent(
          current.lifecycleEvents || [],
          "blocked",
          blockedMessage
        );
        return scrubStoredJob(current);
      });
    } else {
      const cleanup = job.jobClass === "review"
        ? cleanupReviewEnvironment(stateDir(root), job.id)
        : null;
      updateJob(root, job.id, (current) => {
        Object.assign(current, scrubStoredJob(current));
        current.status = "failed";
        current.phase = "failed";
        current.completedAt = now();
        current.error = {
          code: "E_WORKER_LOST",
          message: redactText(diagnostic)
            || "Could not launch the isolated Grok worker."
        };
        current.summary = current.error.message;
        current.result = {
          ...(current.result || {}),
          hostVerification: "not_run"
        };
        current.lifecycleEvents = appendLifecycleEvent(
          current.lifecycleEvents,
          "blocked",
          current.error.message
        );
        if (cleanup) {
          current.result = {
            ...(current.result || {}),
            providerSessionDeleted: cleanup.ok
          };
          if (cleanup.warning) {
            current.result.privacyWarning = cleanup.warning;
          }
        }
        return current;
      });
    }
  }
  if (launcherCode === 0 && !background && announce) {
    const accepted = readJob(root, job.id);
    const acceptedHandle = projectWorkerHandle(accepted);
    process.stderr.write(`GROK_JOB_ACCEPTED ${JSON.stringify({
      id: acceptedHandle.id,
      status: acceptedHandle.status,
      phase: acceptedHandle.phase,
      progress: acceptedHandle.progress || acceptedHandle.summary || "Worker started"
    })}\n`);
  }
  if (background) return readJob(root, job.id);
  let finished = readJob(root, job.id);
  if (launcherCode !== 0 && !terminal(finished)) {
    throw new CompanionError(
      finished.error?.code || "E_PROCESS_IDENTITY",
      finished.error?.message
        || "Worker launch cleanup remains unproven.",
      {
        ...(finished.error?.details || {}),
        workerId: finished.id
      }
    );
  }
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
  try {
    // A setup attempt revokes any older readiness assertion before probing.
    // A crash or failed probe therefore cannot leave stale spawn capability.
    clearProviderCapabilityReceipt();
    const pinned = publishProviderExecutablePin();
    const probed = await probe(root, stateDir(root), {
      providerExecutableBinding: pinned.binding
    });
    writeProviderCapabilityReceipt({
      runtime: probed,
      providerLaunchBinding: pinned.binding
    });
    // The setup response is public; the private pin path stays internal.
    const { binary: _privatePinnedBinary, ...publicRuntime } = probed;
    runtime = {
      ...publicRuntime,
      releaseRecognition: pinned.releaseRecognition
    };
  } catch (error) {
    try { clearProviderCapabilityReceipt(); } catch {}
    runtime = { ready: false, error: asErrorPayload(error) };
  }
  if (options["enable-review-gate"] && !runtime.error) setConfig(root, { stopReviewGate: true });
  const storageReadonlyNextStep = currentHost().kind === "codex"
    ? `If this setup was started from managed Codex without the one-time command approval requested by ${hostCommand("setup")}, retry through that approval; it is command-scoped unsandboxed execution, not an exact-path grant. If the approved setup still fails, verify that the user-owned plugin data directory is on writable media and supports private mode 0700 directories and 0600 files.`
    : "Verify that the user-owned plugin data directory is on writable media and supports private mode 0700 directories and 0600 files.";
  const nextSteps = !runtime.error
    ? [`Run ${hostCommand("review", "--wait")} or ${hostCommand("rescue", "<task>")}.`]
    : runtime.error.code === "E_GROK_NOT_FOUND"
      ? ["Install with `npm install -g @xai-official/grok`, then retry."]
      : runtime.error.code === "E_AUTH_REQUIRED"
        ? ["Authenticate with `grok login`, then retry."]
        : runtime.error.code === "E_GROK_SOURCE"
          ? ["Use the active Grok-managed installation; arbitrary unfamiliar `GROK_BIN` or `PATH` executables are not accepted."]
          : runtime.error.code === "E_GROK_VERSION"
            ? ["Activate a stable Grok version 0.2.99 or newer; malformed and prerelease versions are not admitted."]
            : runtime.error.code === "E_PROCESS_IDENTITY"
              ? ["Restore the active managed link and executable bytes to a stable state, then retry setup."]
              : runtime.error.code === "E_CAPABILITY"
                ? ["The exact pinned Grok binary is present but did not satisfy a required runtime capability; review the reported probe failure."]
                : runtime.error.code === "E_STORAGE_READONLY"
                  ? [storageReadonlyNextStep]
                  : ["Review the reported prerequisite or platform limitation before retrying."];
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
    return assertResumeSourceContext(root, prior);
  }
  // Legacy compatibility path: implicit same-session candidate without --job-id.
  const candidate = resumeCandidate(root, profile);
  if (!candidate) throw new CompanionError("E_NO_RESUME_CANDIDATE", "No resumable Grok task with the same security profile exists in this host session.");
  return assertResumeSourceContext(root, candidate);
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
    const completionContextManifest = assertContextManifestIntegrity(
      job.completionContextManifest
    );
    if (job.verificationContextManifest) {
      assertContextManifestIntegrity(job.verificationContextManifest);
      throw new CompanionError("E_STATE", `Job ${job.id} already has a host verification baseline; record verification once per job.`);
    }
    assertContextMetadataComplete(completionContextManifest, {
      contextPhase: "resume"
    });
    const activeWriter = listJobs(root).find((candidate) => candidate.id !== job.id && !terminal(candidate) && candidate.write);
    if (activeWriter) throw new CompanionError("E_JOB_ACTIVE", `Cannot record verification while writer ${activeWriter.id} is active.`);
    const record = parseVerificationRecord(input, job.request?.envelope?.requiredVerification || []);
    // Store the full exact current snapshot for continuation binding, but compare
    // completion→current with the verification-only ignored observer so standard
    // pytest/Python cache drift from host checks is not treated as out-of-scope.
    const verificationContextManifest = captureCompleteContextManifest(root, {
      contextPhase: "resume"
    });
    const observedChangedPaths = observeChangedPaths(
      completionContextManifest,
      verificationContextManifest,
      { observer: "verification" }
    );
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

  const contextManifest = captureCompleteContextManifest(root, {
    contextPhase: "admission"
  });
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
  const finishedHandle = projectWorkerHandle(finished);
  out(
    options.json
      ? publicJson(finished)
      : options.background
        ? `Grok task started in the background.\nJob: ${finishedHandle.id}\nPhase: ${finishedHandle.phase || "unknown"}\nProgress: ${finishedHandle.progress || finishedHandle.summary || "Task accepted"}\nCheck: ${hostCommand("status", finishedHandle.id)}`
        : renderJob(finished),
    options.json
  );
}

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
      value.phase = ["E_CONTEXT_DRIFT", "E_CONTEXT_INCOMPLETE"].includes(selectedError?.code)
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
        // Exit without terminalizing this still-live controller. The trusted
        // reconciler observes the durable cancel marker after group exit.
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
          const finalPhase = ["E_CONTEXT_DRIFT", "E_CONTEXT_INCOMPLETE"].includes(selectedError?.code)
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
            completedAt: ["E_CONTEXT_DRIFT", "E_CONTEXT_INCOMPLETE"].includes(selectedError?.code)
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
    if (!authorized) {
      const authError = new CompanionError(
        "E_RECURSION",
        "Unauthenticated Grok Companion worker invocation refused."
      );
      try {
        const record = readJob(root, id);
        if (record.jobClass === "review") {
          recordReviewPreProviderFailure({ root, jobId: id, error: authError });
        }
      } catch { /* best-effort diagnostics */ }
      throw authError;
    }
    try {
      await execute(root, id, { dispatchAttemptId, dispatchFence: authorizedFence });
    } catch (error) {
      try {
        const record = readJob(root, id);
        if (
          record.jobClass === "review"
          && !terminal(record)
          && !record.providerProcess
          && record.startedAt == null
        ) {
          recordReviewPreProviderFailure({ root, jobId: id, error });
        }
      } catch { /* best-effort */ }
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
