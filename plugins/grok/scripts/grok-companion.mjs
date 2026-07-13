#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { splitArgs, parseArgs } from "./lib/args.mjs";
import { CompanionError, asErrorPayload, exitCodeFor } from "./lib/errors.mjs";
import { collectContext, resolveTarget, integritySnapshot, assertUnchanged } from "./lib/git-review.mjs";
import { assertProviderPlatform, childEnvironment, cleanupReviewEnvironment, discoverGrok, ensureChildExit, probe, runProvider, runStructuredReview, grokVersion, processStartToken } from "./lib/grok-provider.mjs";
import { profileFor, sameSecurityProfile } from "./lib/profiles.mjs";
import { config, setConfig, generateId, writeJob, updateJob, listJobs, readJob, selectJob, requestCancel, isCancelRequested, terminal, now, retain, logFile } from "./lib/state.mjs";
import { workspaceRoot, workspaceState } from "./lib/workspace.mjs";
import { redact, redactText } from "./lib/redact.mjs";
import { hasGrokAncestor, identityMatches, processGroupAlive, processGroupGone, processIsZombie } from "./lib/process-control.mjs";
import { hasForeignActiveProvider, registerProviderGuard, resolveProviderCleanupTarget, unregisterProviderGuard } from "./lib/recursion-guard.mjs";
import { hostCommand, hostContext, pluginDataRoot, readCodexSessionMetadata, sameHostSession } from "./lib/host.mjs";
import { codexTranscriptToClaude, createAnonymousTranscript, disposeConvertedTranscript, openTranscriptSource, readTranscriptSnapshot } from "./lib/transcript.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(SCRIPT), "..");
const VALID_EFFORTS = new Set(["low", "medium", "high"]);

function usage() {
  return ["Usage:", "  grok-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]", "  grok-companion.mjs review|adversarial-review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]", "  grok-companion.mjs task [--wait|--background] [--write] [--resume|--fresh] [--model <id>] [--effort low|medium|high] <task>", "  grok-companion.mjs transfer [--source <claude-or-codex-jsonl>] [--json]", "  grok-companion.mjs status [job-id] [--wait] [--timeout-ms <ms>] [--all] [--json]", "  grok-companion.mjs result [job-id] [--json]", "  grok-companion.mjs cancel [job-id] [--json]"].join("\n");
}

function argvFrom(raw) { return raw.length === 1 && /\s/.test(raw[0]) ? splitArgs(raw[0]) : raw; }
function out(value, json = false) { process.stdout.write(`${json ? JSON.stringify(value, null, 2) : value}\n`); }
function currentHost() { return hostContext(); }
function sessionId() { return currentHost().sessionId; }
function stateDir(root) { return workspaceState(root); }
function loadTemplate(name, values) {
  const text = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", `${name}.md`), "utf8");
  return text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
}
function appendLog(root, id, entry) { fs.appendFileSync(logFile(root, id), `${JSON.stringify({ at: now(), ...entry })}\n`, { mode: 0o600 }); }
function validateModelEffort(options) { if (options.effort && !VALID_EFFORTS.has(options.effort)) throw new CompanionError("E_USAGE", "--effort must be low, medium, or high."); }

function workerEnvironment(nonce) {
  const env = {};
  const allowed = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "TERM", "COLORTERM", "NO_COLOR", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ComSpec", "PATHEXT"]);
  for (const [key, value] of Object.entries(process.env)) if ((allowed.has(key) || key.startsWith("LC_")) && value != null) env[key] = value;
  const host = currentHost();
  env.GROK_COMPANION_HOST = host.kind;
  if (host.sessionId) env.GROK_COMPANION_HOST_SESSION_ID = host.sessionId;
  env.GROK_COMPANION_PLUGIN_DATA = pluginDataRoot();
  if (process.env.GROK_BIN) env.GROK_BIN = process.env.GROK_BIN;
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
    next.privacyWarning = [next.privacyWarning, retentionNote].filter(Boolean).join("; ");
  }
  return next;
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
  for (const job of listJobs(root).filter((candidate) => terminal(candidate) && candidate.jobClass === "review" && candidate.result?.providerSessionDeleted === false && candidate.result?.skipReason !== "empty-target")) {
    // Fail closed: require the complete owned provider process group to be gone
    // (not merely a dead leader). Mirrors SessionEnd processGroupGone semantics.
    // Use guard identity when providerProcess was never recorded on the job.
    const { identity: providerIdentity } = resolveProviderCleanupTarget(root, job);
    if (!processGroupGone(providerIdentity)) continue;
    try { unregisterProviderGuard(root, job.id); } catch {}
    const cleanup = cleanupReviewEnvironment(stateDir(root), job.id);
    updateJob(root, job.id, (current) => {
      current.result = applyReviewPrivacy(current.result, cleanup);
      return current;
    });
  }
  for (const job of listJobs(root).filter((candidate) => !terminal(candidate))) {
    if (job.status === "queued" && Date.now() - Date.parse(job.createdAt) < 5000) continue;
    const controllerTokenMatches = Boolean(job.controllerProcess?.pid && job.controllerProcess.startToken && processStartToken(job.controllerProcess.pid) === job.controllerProcess.startToken);
    if (controllerTokenMatches && !processIsZombie(job.controllerProcess.pid)) continue;
    if (job.workerProcess?.pid && identityMatches(job.workerProcess, job.id, "worker")) continue;
    const workerTokenMatches = Boolean(job.workerProcess?.pid && job.workerProcess.startToken && processStartToken(job.workerProcess.pid) === job.workerProcess.startToken);
    const workerMayStillBeStarting = workerTokenMatches && !processIsZombie(job.workerProcess.pid);
    if (workerMayStillBeStarting && Date.now() - Date.parse(job.updatedAt || job.startedAt || job.createdAt) < 1500) continue;
    let cleanupError = null;
    try { await terminateProviderCleanupTarget(root, job); } catch (error) { cleanupError = error; }
    if (!cleanupError) try { unregisterProviderGuard(root, job.id); } catch {}
    const cleanup = !cleanupError && job.jobClass === "review" ? cleanupReviewEnvironment(stateDir(root), job.id) : null;
    updateJob(root, job.id, (current) => {
      // The worker can finish between the liveness check above and this locked
      // update. Never turn that freshly completed record into E_WORKER_LOST.
      if (terminal(current)) return current;
      const prompt = current.request?.prompt;
      if (typeof prompt === "string") current.request = { ...current.request, prompt: null, promptDigest: crypto.createHash("sha256").update(prompt).digest("hex") };
      current.status = "failed";
      current.phase = "failed";
      current.completedAt = now();
      current.error = cleanupError ? redact(asErrorPayload(cleanupError)) : { code: "E_WORKER_LOST", message: "The background worker disappeared; the prompt was not replayed." };
      current.summary = current.error.message;
      if (cleanup) {
        current.result = applyReviewPrivacy(current.result, cleanup);
      } else if (current.jobClass === "review" && cleanupError) {
        // Process termination failed: isolated home was not safely removed; keep additive privacy evidence.
        current.result = applyReviewPrivacy(current.result, null, "Isolated review home retained because process cleanup could not be verified.");
      }
      return current;
    });
  }
}

async function terminateVerified(identity, marker, kind) {
  if (!identity) return false;
  // Defense in depth: unsupported platforms must surface E_CAPABILITY before identity failures.
  assertProviderPlatform();
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

function baseRecord({ id, kind, root, profile, title, request, write, model, effort }) {
  const timestamp = now();
  return { schemaVersion: 2, id, kind, jobClass: kind.includes("review") ? "review" : "task", title, summary: "Queued", write, status: "queued", phase: "queued", workspaceRoot: root, host: currentHost(), grokSessionId: null, createdAt: timestamp, startedAt: null, updatedAt: timestamp, completedAt: null, workerProcess: null, providerProcess: null, profile, model: model || null, effort: effort || null, logFile: logFile(root, id), progress: null, request, result: null, error: null };
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
  const lines = [`Job: ${job.id}`, `Kind: ${job.kind}`, `Status: ${job.status}`, `Phase: ${job.phase}`, `Summary: ${job.summary || "-"}`];
  if (job.grokSessionId) lines.push(`Grok session: ${job.grokSessionId}`, `Resume through this host: ${hostCommand("rescue", "--resume <next task>")}`);
  if (job.result?.text) lines.push("", job.result.text);
  if (job.error) lines.push("", `${job.error.code}: ${job.error.message}`);
  return lines.join("\n");
}

function eventUpdater(root, id) {
  let last = 0;
  return (event) => {
    const safeEvent = redact(event);
    appendLog(root, id, safeEvent.type === "diagnostic" ? { type: "diagnostic", text: redactText(safeEvent.text) } : safeEvent);
    if (safeEvent.type === "provider") updateJob(root, id, (job) => { job.providerProcess = safeEvent.process; job.profile.grokVersion = safeEvent.version; job.phase = "creating-session"; return job; });
    else if (safeEvent.type === "session") updateJob(root, id, (job) => { job.grokSessionId = safeEvent.sessionId; job.phase = "prompting"; job.progress = "Grok session created"; return job; });
    else if (Date.now() - last > 500 && ["tool", "plan", "message"].includes(safeEvent.type)) { last = Date.now(); updateJob(root, id, (job) => { job.progress = safeEvent.type === "tool" ? `${safeEvent.status}: ${safeEvent.name}` : safeEvent.type; return job; }); }
  };
}

async function execute(root, id) {
  let job = readJob(root, id);
  const prompt = job.request?.prompt;
  if (!prompt) throw new CompanionError("E_STATE", "Queued job has no prompt.");
  updateJob(root, id, (current) => { current.status = "running"; current.phase = "starting"; current.startedAt = now(); current.summary = "Starting Grok"; current.request = { ...current.request, prompt: null, promptDigest: crypto.createHash("sha256").update(prompt).digest("hex") }; current.workerProcess = { ...(current.workerProcess || {}), pid: process.pid, startToken: processStartToken(process.pid), nonce: process.env.GROK_COMPANION_WORKER_NONCE || current.workerProcess?.nonce || crypto.randomBytes(16).toString("hex"), processGroupId: current.workerProcess?.processGroupId ?? (process.platform === "win32" ? null : process.pid), commandMarker: id }; return current; });
  const before = job.jobClass === "review" ? integritySnapshot(root) : null;
  let terminalError = null;
  try {
    const workerNonce = process.env.GROK_COMPANION_WORKER_NONCE;
    const common = { root, profile: job.profile, prompt, model: job.model, effort: job.effort, stateDir: stateDir(root), jobMarker: id, resumeSessionId: job.request?.resumeSessionId || null, cancelRequested: () => isCancelRequested(root, id, workerNonce), onEvent: eventUpdater(root, id) };
    const result = job.jobClass === "review" && job.kind !== "stop-review" ? await runStructuredReview(common) : await runProvider(common);
    if (before) assertUnchanged(before, integritySnapshot(root));
    const safeResult = redact(job.jobClass === "review" && result.review ? { review: result.review, stopReason: result.stopReason } : { text: result.text, stopReason: result.stopReason });
    updateJob(root, id, (current) => { current.phase = "finalizing"; current.grokSessionId = result.sessionId; current.providerProcess = result.provider?.process || null; current.profile.grokVersion = result.provider?.version || null; current.result = safeResult; current.summary = safeResult.review ? `${safeResult.review.verdict}: ${safeResult.review.summary}` : (safeResult.text.split(/\r?\n/).find(Boolean) || "Completed").slice(0, 160); return current; });
  } catch (error) {
    terminalError = error;
    updateJob(root, id, (current) => { current.phase = "finalizing"; current.error = redact(asErrorPayload(error)); current.summary = redactText(error.message); return current; });
  } finally {
    if (job.jobClass === "review") {
      const cleanup = cleanupReviewEnvironment(stateDir(root), id);
      updateJob(root, id, (value) => { value.result = { ...(value.result || {}), providerSessionDeleted: cleanup.ok }; if (cleanup.warning) value.result.privacyWarning = cleanup.warning; return value; });
    }
    updateJob(root, id, (current) => {
      current.status = terminalError ? (terminalError.code === "E_CANCELLED" ? "cancelled" : "failed") : "completed";
      current.phase = current.status === "completed" ? "done" : current.status;
      current.completedAt = now();
      return current;
    });
    retain(root);
  }
  if (terminalError) throw terminalError;
  return readJob(root, id);
}

async function startJob(root, job, background) {
  const nonce = crypto.randomBytes(16).toString("hex");
  job.workerAuthorization = nonce;
  writeJob(root, job);
  const launcher = spawn(process.execPath, [SCRIPT, "--launch-worker", job.id, "--cwd", root], { cwd: root, shell: false, stdio: ["ignore", "ignore", "pipe"], env: workerEnvironment(nonce) });
  let diagnostic = "";
  launcher.stderr?.setEncoding("utf8"); launcher.stderr?.on("data", (chunk) => { diagnostic = `${diagnostic}${chunk}`.slice(-8192); });
  const launcherCode = await new Promise((resolve, reject) => { launcher.once("error", reject); launcher.once("close", resolve); });
  if (launcherCode !== 0) {
    const cleanup = job.jobClass === "review" ? cleanupReviewEnvironment(stateDir(root), job.id) : null;
    updateJob(root, job.id, (current) => {
      const prompt = current.request?.prompt;
      if (typeof prompt === "string") current.request = { ...current.request, prompt: null, promptDigest: crypto.createHash("sha256").update(prompt).digest("hex") };
      current.status = "failed"; current.phase = "failed"; current.completedAt = now(); current.error = { code: "E_WORKER_LOST", message: redactText(diagnostic) || "Could not launch the isolated Grok worker." }; current.summary = current.error.message;
      if (cleanup) { current.result = { ...(current.result || {}), providerSessionDeleted: cleanup.ok }; if (cleanup.warning) current.result.privacyWarning = cleanup.warning; }
      return current;
    });
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
  const result = { ready: !runtime.error, grok: runtime, config: config(root), disclosure: "Grok/xAI may process task prompts, selected repository content, command output, and imported Claude Code or privacy-filtered Codex transcript context. ACP task sessions and a sanitized cached access credential remain in isolated read/write homes under this workspace's private plugin state; imported sessions remain under ~/.grok/sessions. Each headless review uses a private per-job home and removes it on completion or verified crash recovery.", nextSteps };
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
    out(options.json ? job : renderReview(job), options.json);
    return;
  }
  const finished = await startJob(root, job, Boolean(options.background));
  out(options.json ? finished : options.background ? `Grok ${kind} started in the background.\nJob: ${id}\nCheck: ${hostCommand("status", id)}` : renderReview(finished), options.json);
}

function resumeCandidate(root, profile) {
  const host = currentHost();
  if (!host.sessionId) return null;
  return listJobs(root).find((job) => job.kind === "task" && job.status === "completed" && job.grokSessionId && sameHostSession(job, host) && sameSecurityProfile(job.profile, profile));
}

async function handleTask(raw) {
  const { options, positionals } = parseArgs(argvFrom(raw), { values: ["model", "effort", "cwd"], booleans: ["wait", "background", "write", "resume", "fresh", "json"] });
  if (options.resume && options.fresh) throw new CompanionError("E_USAGE", "Choose --resume or --fresh.");
  if (options.wait && options.background) throw new CompanionError("E_USAGE", "Choose --wait or --background.");
  validateModelEffort(options);
  const promptText = positionals.join(" ").trim(); if (!promptText) throw new CompanionError("E_USAGE", "Provide a task for Grok.");
  const root = workspaceRoot(options.cwd ? path.resolve(options.cwd) : process.cwd());
  const profile = profileFor("task", Boolean(options.write));
  const candidate = options.resume ? resumeCandidate(root, profile) : null;
  if (options.resume && !candidate) throw new CompanionError("E_NO_RESUME_CANDIDATE", "No resumable Grok task with the same security profile exists in this host session.");
  const prompt = `${promptText}\n\nGrok Companion constraints: do not invoke Grok Companion recursively; do not spawn subagents or use web tools; stay within ${root}; report exactly what you changed and tested.`;
  const id = generateId("task"), job = baseRecord({ id, kind: "task", root, profile, title: promptText.slice(0, 100), request: { prompt, resumeSessionId: candidate?.grokSessionId || null }, write: Boolean(options.write), model: options.model, effort: options.effort });
  const finished = await startJob(root, job, Boolean(options.background));
  out(options.json ? finished : options.background ? `Grok task started in the background.\nJob: ${id}\nCheck: ${hostCommand("status", id)}` : renderJob(finished), options.json);
}

async function handleStatus(raw) {
  const { options, positionals } = parseArgs(argvFrom(raw), { values: ["timeout-ms", "cwd"], booleans: ["wait", "all", "json"] });
  if (positionals.length > 1) throw new CompanionError("E_USAGE", "Status accepts at most one job ID.");
  const root = workspaceRoot(options.cwd ? path.resolve(options.cwd) : process.cwd()); await recoverActiveJobs(root);
  if (positionals[0] && options.wait) {
    const requested = Number(options["timeout-ms"] || 240000);
    if (!Number.isFinite(requested) || requested < 0) throw new CompanionError("E_USAGE", "--timeout-ms must be a non-negative number.");
    const timeout = Math.min(requested, 900000), start = Date.now();
    while (!terminal(readJob(root, positionals[0])) && Date.now() - start < timeout) { await new Promise((r) => setTimeout(r, 250)); await recoverActiveJobs(root); }
  }
  const host = currentHost();
  let value;
  if (positionals[0]) value = readJob(root, positionals[0]);
  else if (options.all) value = listJobs(root);
  else {
    if (!host.sessionId) throw new CompanionError("E_JOB_NOT_FOUND", "Current host session identity is unavailable; provide an explicit job ID or pass --all.");
    value = listJobs(root).filter((job) => sameHostSession(job, host));
  }
  if (options.json) out(value, true); else if (Array.isArray(value)) out(["| Job | Kind | Status | Phase | Summary |", "|---|---|---|---|---|", ...value.map((j) => `| ${j.id} | ${j.kind} | ${j.status} | ${j.phase} | ${(j.summary || "").replace(/\|/g, "\\|")} |`)].join("\n")); else out(renderJob(value));
}

async function handleResult(raw) {
  const { options, positionals } = parseArgs(argvFrom(raw), { values: ["cwd"], booleans: ["json"] }); const root = workspaceRoot(options.cwd ? path.resolve(options.cwd) : process.cwd()); await recoverActiveJobs(root); const job = selectJob(root, { id: positionals[0], host: currentHost(), finished: !positionals[0] });
  if (!terminal(job)) throw new CompanionError("E_JOB_ACTIVE", `Job ${job.id} is still ${job.status}; run ${hostCommand("status", `${job.id} --wait`)}.`);
  out(options.json ? job : job.jobClass === "review" ? renderReview(job) : renderJob(job), options.json);
}

async function handleCancel(raw) {
  const { options, positionals } = parseArgs(argvFrom(raw), { values: ["cwd"], booleans: ["json"] }); const root = workspaceRoot(options.cwd ? path.resolve(options.cwd) : process.cwd()); await recoverActiveJobs(root); const job = selectJob(root, { id: positionals[0], host: currentHost(), active: !positionals[0] });
  // Launch window: workerAuthorization is persisted before workerProcess exists.
  // Prefer the live worker nonce; fall back to the authenticated launch nonce; fail closed if neither.
  if (!terminal(job)) requestCancel(root, job.id, job.workerProcess?.nonce || job.workerAuthorization || "");
  const deadline = Date.now() + 10000; let current = readJob(root, job.id); while (!terminal(current) && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 200)); current = readJob(root, job.id); }
  if (!terminal(current)) {
    await terminateProviderCleanupTarget(root, current);
    try { unregisterProviderGuard(root, current.id); } catch {}
    await terminateVerified(current.workerProcess, current.id, "worker");
    const cleanup = current.jobClass === "review" ? cleanupReviewEnvironment(stateDir(root), current.id) : null;
    current = updateJob(root, current.id, (value) => {
      value.status = "cancelled"; value.phase = "cancelled"; value.completedAt = now(); value.error = { code: "E_CANCELLED", message: "Grok job was force-cancelled after the graceful timeout." }; value.summary = value.error.message;
      // Additive/clearing privacy: success clears a stale warning; failure appends without erasing prior evidence.
      if (cleanup) value.result = applyReviewPrivacy(value.result, cleanup);
      return value;
    });
  }
  out(options.json ? current : `Cancellation requested.\n${renderJob(current)}`, options.json);
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
  if (ids.size > 1) throw new CompanionError("E_IMPORT_RESULT", "Grok import returned multiple different session IDs.");
  return ids.values().next().value || null;
}

function shellWord(value) {
  const text = String(value);
  return /^[a-zA-Z0-9_./:+-]+$/.test(text) ? text : `'${text.replaceAll("'", `'"'"'`)}'`;
}

async function runImportProcess({ binary, root, transcriptFd, alias, leaderSocket, marker, signal, timeoutMs = 120000, maxOutputBytes = 8 * 1024 * 1024 }) {
  // Hard-gate before spawn / identity: Windows must report E_CAPABILITY, not E_PROCESS_IDENTITY.
  assertProviderPlatform();
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
  let importAlias = null, run, importFd = opened.fd, convertedFile = null;
  const cleanupWarnings = [];
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const binary = discoverGrok(); grokVersion(binary);
    const importDir = path.join(stateDir(root), "imports");
    fs.mkdirSync(importDir, { recursive: true, mode: 0o700 });
    if (opened.format === "codex") {
      const converted = codexTranscriptToClaude(readTranscriptSnapshot(opened), { cwd: root });
      const anonymous = createAnonymousTranscript(converted, importDir);
      importFd = anonymous.fd;
      convertedFile = anonymous.file;
    }
    importAlias = path.join(importDir, `import-${crypto.randomBytes(12).toString("hex")}.jsonl`);
    const runtime = await probe(root, stateDir(root));
    const selected = options.model ? runtime.models.find((item) => item.id === options.model) : runtime.models[0];
    if (!selected) throw new CompanionError("E_CAPABILITY", options.model ? `Model ${options.model} is not advertised by Grok.` : "Grok did not advertise a model that can resume the imported session.", { available: runtime.models.map((item) => item.id) });
    if (options.effort && selected.efforts.length && !selected.efforts.includes(options.effort)) throw new CompanionError("E_CAPABILITY", `Reasoning effort ${options.effort} is not advertised for model ${selected.id}.`, { available: selected.efforts });
    const inheritedFd = process.platform === "linux" ? "/proc/self/fd/3" : "/dev/fd/3";
    fs.symlinkSync(inheritedFd, importAlias);
    const marker = `transfer-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
    const leaderSocket = path.join(stateDir(root), `leader-${marker}.sock`);
    run = await runImportProcess({ binary, root, transcriptFd: importFd, alias: importAlias, leaderSocket, marker, signal: controller.signal });
    run.selectedModel = selected.id;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    if (importFd !== opened.fd) {
      const cleanup = disposeConvertedTranscript({ fd: importFd, file: convertedFile });
      if (!cleanup.ok) cleanupWarnings.push(cleanup.warning);
    }
    try { fs.closeSync(opened.fd); } catch (error) { cleanupWarnings.push(error.message); }
    if (importAlias) try { fs.unlinkSync(importAlias); } catch (error) { if (error.code !== "ENOENT") cleanupWarnings.push(error.message); }
  }
  if (!run) {
    if (cleanupWarnings.length) throw new CompanionError("E_STATE", "Could not completely remove the private transcript transfer artifacts.", { warning: cleanupWarnings.join("; ") });
    throw new CompanionError("E_IMPORT_RESULT", "Grok transcript import did not complete.");
  }
  if (run.status !== 0) {
    if (cleanupWarnings.length) throw new CompanionError("E_IMPORT_RESULT", `Grok could not import the ${opened.format === "codex" ? "Codex" : "Claude Code"} transcript.`, { diagnostic: redactText(run.stderr || run.stdout), privacyWarning: cleanupWarnings.join("; ") });
    throw new CompanionError("E_IMPORT_RESULT", `Grok could not import the ${opened.format === "codex" ? "Codex" : "Claude Code"} transcript.`, { diagnostic: redactText(run.stderr || run.stdout) });
  }
  const id = importedSessionId(run.stdout); if (!id) throw new CompanionError("E_IMPORT_RESULT", "Grok import succeeded but returned no usable session ID.", cleanupWarnings.length ? { privacyWarning: cleanupWarnings.join("; ") } : undefined);
  const resumeParts = ["grok", "--model", run.selectedModel];
  if (options.effort) resumeParts.push("--reasoning-effort", options.effort);
  resumeParts.push("--resume", id);
  const deleteParts = ["grok", "sessions", "delete", id];
  const label = opened.format === "codex" ? "Codex" : "Claude Code";
  const result = {
    sessionId: id,
    source: opened.real,
    sourceFormat: opened.format,
    model: run.selectedModel,
    effort: options.effort || null,
    resume: resumeParts.map(shellWord).join(" "),
    delete: deleteParts.map(shellWord).join(" ")
  };
  if (cleanupWarnings.length) {
    // Privacy contract fails closed: successful import with residual private transfer artifacts
    // must not exit 0. Session resume/delete details are returned in error.details so the
    // imported provider session is not orphaned while leftover private descriptors stay explicit.
    throw new CompanionError(
      "E_STATE",
      `Imported ${label} transcript into Grok session ${id}, but private alias or descriptor cleanup failed. Resume with \`${result.resume}\` or delete with \`${result.delete}\`, then remove leftover transfer artifacts.`,
      {
        warning: cleanupWarnings.join("; "),
        privacyWarning: cleanupWarnings.join("; "),
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
    const invocationArgs = argvFrom(raw);
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
    out({ available: Boolean(candidate), jobId: candidate?.id || null, grokSessionId: candidate?.grokSessionId || null, profileId: candidate?.profile?.id || null }, true);
    return;
  }
  if (command === "status") return handleStatus(raw);
  if (command === "result") return handleResult(raw);
  if (command === "cancel") return handleCancel(raw);
  if (command === "transfer") return handleTransfer(raw);
  throw new CompanionError("E_USAGE", `Unknown command ${command}.\n${usage()}`);
}

main().catch((error) => { const payload = redact(asErrorPayload(error)); if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify({ ok: false, error: payload }, null, 2)}\n`); else process.stderr.write(`${payload.code}: ${payload.message}\n`); process.exitCode = exitCodeFor(error); });
