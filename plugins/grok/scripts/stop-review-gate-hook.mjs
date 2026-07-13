#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { config, generateId, listJobs, logFile, now, removeJob, terminal, updateJob, writeJob } from "./lib/state.mjs";
import { workspaceRoot, workspaceState } from "./lib/workspace.mjs";
import { profileFor } from "./lib/profiles.mjs";
import { runProvider, cleanupReviewEnvironment, discoverGrok, grokVersion, assertProviderPlatform } from "./lib/grok-provider.mjs";
import { collectContext, resolveTarget, integritySnapshot, assertUnchanged } from "./lib/git-review.mjs";
import { redactText } from "./lib/redact.mjs";
import { hasGrokAncestor, processStartToken } from "./lib/process-control.mjs";
import { hasForeignActiveProvider } from "./lib/recursion-guard.mjs";

if (process.env.GROK_COMPANION_CHILD === "1" || process.env.GROK_COMPANION_JOB_MARKER || process.env.GROK_AGENT || process.env.GROK_LEADER_SOCKET || hasGrokAncestor()) process.exit(0);

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let event = {};
try { event = raw.trim() ? JSON.parse(raw) : {}; } catch {}
const cwd = event.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
let root;
try { root = workspaceRoot(path.resolve(cwd)); } catch { process.exit(0); }
if (hasForeignActiveProvider(root, event.session_id || event.sessionId || process.env.GROK_COMPANION_CLAUDE_SESSION_ID || null)) process.exit(0);
const active = listJobs(root).filter((job) => !terminal(job));
if (active.length) process.stderr.write(`Grok Companion: ${active.length} job(s) still active.\n`);
if (!config(root).stopReviewGate) {
  process.exit(0);
}

try { assertProviderPlatform(); grokVersion(discoverGrok()); }
catch (error) { process.stderr.write(`Grok Companion stop gate unavailable: ${error.message} Run /grok:setup.\n`); process.exit(0); }

const previous = String(event.last_assistant_message || event.lastAssistantMessage || event.assistant_message || "").slice(-256 * 1024);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = fs.readFileSync(path.join(rootDir, "prompts", "stop-review-gate.md"), "utf8");
const jobMarker = generateId("stop-review");
const reviewProfile = profileFor("stop-review");
let response = null;
let providerFailure = null;
let jobWritten = false;
let providerText = "";
try {
  const target = resolveTarget(root, { scope: "auto" });
  const context = collectContext(root, target);
  const values = { TARGET_LABEL: context.target.label, REVIEW_INPUT: context.content, PREVIOUS_MESSAGE: previous };
  const prompt = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
  const before = integritySnapshot(root);
  const timestamp = now();
  writeJob(root, {
    schemaVersion: 1,
    id: jobMarker,
    kind: "stop-review",
    jobClass: "review",
    title: `stop review: ${context.target.label}`,
    summary: "Running stop-time review",
    write: false,
    status: "running",
    phase: "starting",
    workspaceRoot: root,
    claudeSessionId: event.session_id || event.sessionId || process.env.GROK_COMPANION_CLAUDE_SESSION_ID || null,
    grokSessionId: null,
    createdAt: timestamp,
    startedAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    workerProcess: null,
    controllerProcess: { pid: process.pid, startToken: processStartToken(process.pid) },
    providerProcess: null,
    profile: reviewProfile,
    model: null,
    effort: null,
    logFile: logFile(root, jobMarker),
    progress: null,
    request: { prompt: null, promptDigest: crypto.createHash("sha256").update(prompt).digest("hex"), target },
    result: null,
    error: null
  });
  jobWritten = true;
  const onEvent = (providerEvent) => {
    if (providerEvent.type === "provider") updateJob(root, jobMarker, (job) => { job.providerProcess = providerEvent.process; job.profile.grokVersion = providerEvent.version; job.phase = "creating-session"; return job; });
    else if (providerEvent.type === "session") updateJob(root, jobMarker, (job) => { job.grokSessionId = providerEvent.sessionId; job.phase = "prompting"; return job; });
  };
  const result = await runProvider({ root, profile: reviewProfile, prompt, stateDir: workspaceState(root), jobMarker, timeoutMs: 14 * 60 * 1000, onEvent });
  providerText = result.text;
  assertUnchanged(before, integritySnapshot(root));
  const first = result.text.split(/\r?\n/).find((line) => line.trim())?.trim() || "";
  if (!first.startsWith("ALLOW:")) {
    const reason = first.startsWith("BLOCK:") ? first.slice(6).trim() : "Grok returned malformed stop-gate output. Run /grok:review --wait, address findings, then retry.";
    response = { decision: "block", reason: redactText(reason) };
  }
} catch (error) {
  providerFailure = error;
  response = { decision: "block", reason: `Grok stop review failed: ${redactText(error.message)}. Run /grok:setup and retry.` };
} finally {
  const cleanup = cleanupReviewEnvironment(workspaceState(root), jobMarker);
  if (!cleanup.ok) response = { decision: "block", reason: `Grok stop review could not remove its isolated credential environment: ${cleanup.warning}.` };
  if (jobWritten) {
    try {
      updateJob(root, jobMarker, (job) => {
        job.status = providerFailure || !cleanup.ok ? "failed" : "completed";
        job.phase = job.status === "completed" ? "done" : "failed";
        job.completedAt = now();
        job.summary = response?.reason || "Stop review allowed completion.";
        job.result = { decision: response?.decision || "allow", text: redactText(providerText), providerSessionDeleted: cleanup.ok };
        if (cleanup.warning) job.result.privacyWarning = cleanup.warning;
        if (providerFailure) job.error = { code: providerFailure.code || "E_PROVIDER_EXIT", message: redactText(providerFailure.message) };
        return job;
      });
      if (cleanup.ok) removeJob(root, jobMarker);
    } catch {}
  }
}
if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
