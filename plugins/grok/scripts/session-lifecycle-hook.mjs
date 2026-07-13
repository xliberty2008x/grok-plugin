#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { listJobs, requestCancel, terminal, removeJob, updateJob, now } from "./lib/state.mjs";
import { workspaceRoot, workspaceState } from "./lib/workspace.mjs";
import { cleanupReviewEnvironment } from "./lib/grok-provider.mjs";
import { hasGrokAncestor, identityMatches, processGroupAlive, processIsZombie, processStartToken } from "./lib/process-control.mjs";
import { hasForeignActiveProvider, unregisterProviderGuard } from "./lib/recursion-guard.mjs";
import { pluginDataRoot, sameHostSession, writeCodexSessionMetadata } from "./lib/host.mjs";

if (process.env.GROK_COMPANION_CHILD === "1" || process.env.GROK_COMPANION_JOB_MARKER || process.env.GROK_AGENT || process.env.GROK_LEADER_SOCKET || hasGrokAncestor()) process.exit(0);

async function readInput() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try { return text.trim() ? JSON.parse(text) : {}; } catch { return {}; }
}

function shellQuote(value) { return `'${String(value).replace(/'/g, `'"'"'`)}'`; }

function groupGone(identity) {
  if (!identity?.pid) return true;
  if (identity.processGroupId && process.platform !== "win32" && processGroupAlive(identity.processGroupId)) return false;
  if (!identity.startToken) {
    try { process.kill(identity.pid, 0); return false; }
    catch (error) { return error.code === "ESRCH"; }
  }
  return processStartToken(identity.pid) !== identity.startToken || processIsZombie(identity.pid);
}

async function terminateOwned(identity, marker, kind, ownershipEstablished) {
  if (groupGone(identity)) return;
  if (!ownershipEstablished || !identityMatches(identity, marker, kind)) throw new Error(`Ownership of ${kind} process ${identity.pid} could not be verified.`);
  const target = identity.processGroupId && process.platform !== "win32" ? -identity.processGroupId : identity.pid;
  const waitGone = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (groupGone(identity)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return groupGone(identity);
  };
  try { process.kill(target, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  if (await waitGone(1000)) return;
  try { process.kill(target, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  if (!await waitGone(1000)) throw new Error(`The ${kind} process group remained active after SIGKILL.`);
}

const event = await readInput();
const phase = process.argv[2] || event.hook_event_name;
const hostSessionId = event.session_id || event.sessionId || process.env.GROK_COMPANION_HOST_SESSION_ID || process.env.GROK_COMPANION_CLAUDE_SESSION_ID || null;
const transcript = event.transcript_path || event.transcriptPath || null;
const cwd = event.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
try {
  const guardRoot = workspaceRoot(path.resolve(cwd), false);
  if (!hostSessionId && hasForeignActiveProvider(guardRoot, null)) process.exit(0);
} catch {}

if (phase === "SessionStart") {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (envFile) {
    const lines = ["export GROK_COMPANION_HOST='claude-code'"];
    if (hostSessionId) {
      lines.push(`export GROK_COMPANION_HOST_SESSION_ID=${shellQuote(hostSessionId)}`);
      lines.push(`export GROK_COMPANION_CLAUDE_SESSION_ID=${shellQuote(hostSessionId)}`);
    }
    if (transcript) lines.push(`export GROK_COMPANION_TRANSCRIPT_PATH=${shellQuote(transcript)}`);
    if (process.env.CLAUDE_PLUGIN_DATA) {
      lines.push(`export GROK_COMPANION_PLUGIN_DATA=${shellQuote(process.env.CLAUDE_PLUGIN_DATA)}`);
      lines.push(`export CLAUDE_PLUGIN_DATA=${shellQuote(process.env.CLAUDE_PLUGIN_DATA)}`);
    }
    fs.appendFileSync(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
  } else if (process.env.PLUGIN_DATA && hostSessionId && transcript) {
    try {
      writeCodexSessionMetadata(pluginDataRoot(), { sessionId: hostSessionId, transcriptPath: transcript, cwd });
    } catch {
      process.stderr.write("Grok Companion could not persist Codex SessionStart metadata; check plugin data permissions and retry in a new task.\n");
      process.exit(1);
    }
  }
  process.exit(0);
}

if (phase === "SessionEnd" && hostSessionId) {
  let root;
  try { root = workspaceRoot(path.resolve(cwd)); } catch { process.exit(0); }
  const owned = listJobs(root).filter((job) => sameHostSession(job, { kind: "claude-code", sessionId: hostSessionId }));
  const verified = new Map();
  for (const job of owned) for (const kind of ["provider", "worker"]) {
    const identity = job[`${kind}Process`];
    verified.set(`${job.id}:${kind}`, Boolean(identity && identityMatches(identity, job.id, kind)));
  }
  for (const job of owned) if (!terminal(job) && job.workerProcess?.nonce) { try { requestCancel(root, job.id, job.workerProcess.nonce); } catch {} }
  const deadline = Date.now() + 4000;
  while (owned.some((job) => { try { return !terminal(listJobs(root).find((x) => x.id === job.id)); } catch { return false; } }) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  const cleanupFailures = new Map();
  await Promise.all(owned.map(async (original) => {
    const job = listJobs(root).find((candidate) => candidate.id === original.id);
    if (!job) return;
    try {
      await Promise.all([
        terminateOwned(job.providerProcess, job.id, "provider", verified.get(`${job.id}:provider`)),
        terminateOwned(job.workerProcess, job.id, "worker", verified.get(`${job.id}:worker`))
      ]);
    } catch (error) { cleanupFailures.set(job.id, error); }
  }));
  for (const original of owned) {
    let job = listJobs(root).find((candidate) => candidate.id === original.id);
    if (!job) continue;
    const allGone = groupGone(job.providerProcess) && groupGone(job.workerProcess);
    const cleanupFailure = cleanupFailures.get(job.id);
    if (cleanupFailure || !allGone) {
      try {
        job = updateJob(root, job.id, (value) => {
          value.status = "failed";
          value.phase = "failed";
          value.completedAt = now();
          value.error = { code: "E_PROCESS_IDENTITY", message: "SessionEnd could not verify complete process-group shutdown. Inspect the recorded process identities before manual cleanup." };
          value.summary = value.error.message;
          return value;
        });
      } catch {}
      process.stderr.write(`Grok Companion retained job ${job.id}: process cleanup could not be verified.\n`);
      continue;
    }
    if (!terminal(job)) {
      job = updateJob(root, job.id, (value) => { value.status = "cancelled"; value.phase = "cancelled"; value.completedAt = now(); value.error = { code: "E_CANCELLED", message: "Cancelled when the Claude session ended." }; return value; });
    }
    if (terminal(job)) {
      try { unregisterProviderGuard(root, job.id); } catch {}
      const cleanup = job.jobClass === "review" ? cleanupReviewEnvironment(workspaceState(root), job.id) : { ok: true };
      if (cleanup.ok) { try { removeJob(root, job.id); } catch {} }
      else { try { updateJob(root, job.id, (value) => { value.result = { ...(value.result || {}), providerSessionDeleted: false, privacyWarning: cleanup.warning }; return value; }); } catch {} }
    }
  }
}
