import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { splitArgs } from "./args.mjs";
import { CompanionError } from "./errors.mjs";
import { assertProviderPlatform } from "./provider-core.mjs";
import { providerLaunchBindingDigest as digestProviderLaunchBinding } from "./provider-executable-pin.mjs";
import { appendJobLog, updateJob, readJob, terminal, now, logFile } from "./state.mjs";
import { workspaceState } from "./workspace.mjs";
import { redact, sanitizeDisplayText } from "./redact.mjs";
import { STDIN_READY_MARKER } from "./stdin.mjs";
import { processGroupGone, processStartToken, terminateOwnedProcess } from "./process-control.mjs";
import { resolveProviderCleanupTarget, unregisterProviderGuard, unregisterProviderGuardInWorkspaceTransaction } from "./recursion-guard.mjs";
import { hostCommand, hostContext, jobHostContext, pluginDataRoot, sameHostSession } from "./host.mjs";
import { appendLifecycleEvent } from "./task-lifecycle.mjs";
import { scrubStoredJob } from "./task-envelope.mjs";
import { projectWorkerDiagnosticText, projectWorkerHandle, projectWorkerError, projectWorkerPublicText, projectWorkerSnapshot } from "./worker-protocol.mjs";
import { CONTEXT_BINDING_MODE } from "./worker-context.mjs";
import { assertDispatchContract, assertWorkerProviderLaunchPreparation, recordWorkerProviderRotationNoChild, recordUnsettledProviderProcess, transitionWorkerDispatch } from "./worker-mutation.mjs";
import { providerLaunchCleanupBlocked } from "./worker-reconcile.mjs";
import { isDispatchV2 } from "./worker-launch-contract.mjs";
const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "grok-companion.mjs"
);
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
export {
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
  publicJob,
  publicJson,
  readPrivateEnvelopeFile,
  recheckCancelLaunchSettlement,
  reconcileTerminalStopReason,
  recordLifecycle,
  redactProviderEvent,
  renderJob,
  renderReview,
  renderReviewSession,
  renderStatusTable,
  researchResultJson,
  resultRequiresPublicOnlyProjection,
  sessionId,
  settlePendingProviderRotationNoChild,
  stateDir,
  stdinReadySignal,
  terminateProviderCleanupTarget,
  terminateVerified,
  textEvidence,
  touchJob,
  usage,
  validateModelEffort,
  workerEnvironment
};
