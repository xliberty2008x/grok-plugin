#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { listJobs, requestCancel, terminal, removeJob, updateJob, now } from "./lib/state.mjs";
import { workspaceRoot, workspaceState } from "./lib/workspace.mjs";
import { cleanupReviewEnvironment } from "./lib/grok-provider.mjs";
import { hasGrokAncestor, identityMatches, processGroupAlive, processGroupGone, processIsZombie, processStartToken } from "./lib/process-control.mjs";
import { hasForeignActiveProvider, resolveProviderCleanupTarget, unregisterProviderGuard } from "./lib/recursion-guard.mjs";
import { pluginDataRoot, sameHostSession, writeCodexSessionMetadata } from "./lib/host.mjs";

if (process.env.GROK_COMPANION_CHILD === "1" || process.env.GROK_COMPANION_JOB_MARKER || process.env.GROK_AGENT || process.env.GROK_LEADER_SOCKET || hasGrokAncestor()) process.exit(0);

async function readInput() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try { return text.trim() ? JSON.parse(text) : {}; } catch { return {}; }
}

function shellQuote(value) { return `'${String(value).replace(/'/g, `'"'"'`)}'`; }

// Controller-owned termination after a T0 ownership snapshot.
//
// Leader classification (Unix):
//   same      — live non-zombie leader whose start token still matches
//   missing   — no live token at the recorded PID, or only a zombie
//   replaced  — live process at the recorded PID with a different start token
//
// Signal policy after ownershipEstablished:
//   same + identityMatches → may signal -processGroupId
//   missing + continuously live recorded group → may signal -processGroupId
//     (orphan descendants; kernel still binds the original PGID)
//   replaced → never signal -processGroupId; fail closed (ownership error)
//
// Portable kernels share the PID/PGID number space and expose no process-group
// generation counter. Residual TOCTOU remains between a liveness recheck and
// kill(-pgid) after full original-group exit and PGID recycle; recheck before
// TERM and before KILL, treat ESRCH / already-gone as success, and prefer
// retention over wrong-group signal or premature credential cleanup.
// Never-established ownership and crash-recovery (persisted-only) paths stay
// fail-closed elsewhere; token mismatch is never permission to clean state.
async function terminateOwned(identity, marker, kind, ownershipEstablished) {
  if (processGroupGone(identity)) return;
  if (!ownershipEstablished) {
    throw new Error(`Ownership of ${kind} process ${identity?.pid} could not be verified.`);
  }

  const token = identity?.startToken ? processStartToken(identity.pid) : null;
  const leaderSame = Boolean(
    identity?.startToken
    && token === identity.startToken
    && !processIsZombie(identity.pid)
  );
  // Live occupant with a different birth token ⇒ original PGID cannot still be
  // ours under the shared PID/PGID model; processGroupAlive would refer to a
  // recycled group. Fail closed; retain job, guard, home, and privacy evidence.
  const leaderReplaced = Boolean(token && identity?.startToken && token !== identity.startToken);

  if (leaderReplaced) {
    throw new Error(`Ownership of ${kind} process ${identity.pid} could not be verified.`);
  }
  if (leaderSame && !identityMatches(identity, marker, kind)) {
    throw new Error(`Ownership of ${kind} process ${identity.pid} could not be verified.`);
  }

  const useGroup = Boolean(identity.processGroupId && process.platform !== "win32");
  const waitGone = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (processGroupGone(identity)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return processGroupGone(identity);
  };
  // Recheck group liveness immediately before each signal. ESRCH and already-gone
  // are success; never use a positive identity.pid target when the leader is missing.
  const signalIfStillLive = (sig) => {
    if (processGroupGone(identity)) return;
    if (useGroup) {
      if (!processGroupAlive(identity.processGroupId)) return;
      try { process.kill(-identity.processGroupId, sig); } catch (error) { if (error.code !== "ESRCH") throw error; }
      return;
    }
    try { process.kill(identity.pid, sig); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };

  signalIfStillLive("SIGTERM");
  if (await waitGone(1000)) return;
  signalIfStillLive("SIGKILL");
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
  // T0: snapshot ownership on the resolved provider identity (job first, guard fallback
  // preserving identityKind) and the worker identity before any cancel/terminate races.
  const verified = new Map();
  for (const job of owned) {
    const { identity: providerIdentity, kind: providerKind } = resolveProviderCleanupTarget(root, job);
    verified.set(`${job.id}:provider`, Boolean(providerIdentity && identityMatches(providerIdentity, job.id, providerKind)));
    verified.set(`${job.id}:worker`, Boolean(job.workerProcess && identityMatches(job.workerProcess, job.id, "worker")));
  }
  // Prefer live worker nonce; fall back to the launch-window workerAuthorization; skip (fail closed) if neither.
  for (const job of owned) {
    const nonce = job.workerProcess?.nonce || job.workerAuthorization;
    if (!terminal(job) && nonce) { try { requestCancel(root, job.id, nonce); } catch {} }
  }
  const deadline = Date.now() + 4000;
  while (owned.some((job) => { try { return !terminal(listJobs(root).find((x) => x.id === job.id)); } catch { return false; } }) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  const cleanupFailures = new Map();
  await Promise.all(owned.map(async (original) => {
    const job = listJobs(root).find((candidate) => candidate.id === original.id);
    if (!job) return;
    try {
      const { identity: providerIdentity, kind: providerKind } = resolveProviderCleanupTarget(root, job);
      await Promise.all([
        terminateOwned(providerIdentity, job.id, providerKind, verified.get(`${job.id}:provider`)),
        terminateOwned(job.workerProcess, job.id, "worker", verified.get(`${job.id}:worker`))
      ]);
    } catch (error) { cleanupFailures.set(job.id, error); }
  }));
  for (const original of owned) {
    let job = listJobs(root).find((candidate) => candidate.id === original.id);
    if (!job) continue;
    // allGone must use the same resolved provider identity so a null job.providerProcess
    // never snapshots "gone" while a live guard-backed group still exists.
    const { identity: providerIdentity } = resolveProviderCleanupTarget(root, job);
    const allGone = processGroupGone(providerIdentity) && processGroupGone(job.workerProcess);
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
      else { try { updateJob(root, job.id, (value) => { value.result = { ...(value.result || {}), providerSessionDeleted: false, privacyWarning: [value.result?.privacyWarning, cleanup.warning].filter(Boolean).join("; ") }; return value; }); } catch {} }
    }
  }
}
