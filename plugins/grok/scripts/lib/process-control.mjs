import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { CompanionError } from "./errors.mjs";

const MAX_PROCESS_START_TOKEN_LENGTH = 256;
const SYSTEM_PS_CANDIDATES = Object.freeze(["/bin/ps", "/usr/bin/ps"]);

export function assertCompleteDetachedOwnedIdentity(identity) {
  const rawStartToken = typeof identity?.startToken === "string"
    ? identity.startToken
    : "";
  const startToken = rawStartToken.trim();
  const validStartToken = (
    startToken.length > 0
    && rawStartToken.length <= MAX_PROCESS_START_TOKEN_LENGTH
    && rawStartToken === startToken
    && startToken.toUpperCase() !== "[REDACTED]"
  );
  if (
    !Number.isSafeInteger(identity?.pid)
    || identity.pid <= 0
    || !validStartToken
    || !Number.isSafeInteger(identity?.processGroupId)
    || identity.processGroupId !== identity.pid
  ) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Refusing to inspect or signal an incomplete detached process identity."
    );
  }
}

export function systemPsBinary() {
  if (process.platform === "win32") return null;
  return SYSTEM_PS_CANDIDATES.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch { return false; }
  }) || null;
}

export function runSystemPs(args, options = {}) {
  const binary = systemPsBinary();
  if (!binary) {
    return {
      status: null,
      stdout: "",
      stderr: "",
      error: new CompanionError("E_PROCESS_IDENTITY", "A trusted system ps executable is unavailable.")
    };
  }
  return spawnSync(binary, args, {
    encoding: "utf8",
    shell: false,
    timeout: 2000,
    ...options,
    // Never permit a caller to re-enable shell lookup around identity probes.
    shell: false
  });
}

function ps(args) {
  return runSystemPs(args);
}

export function processStartToken(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return null;
  if (process.platform === "win32") return null;
  const run = ps(["-o", "lstart=", "-p", String(pid)]);
  return run.status === 0 && String(run.stdout).trim() ? String(run.stdout).trim() : null;
}

export function processIsZombie(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0 || process.platform === "win32") return false;
  const run = ps(["-o", "stat=", "-p", String(pid)]);
  return run.status === 0 && /^Z/.test(String(run.stdout).trim());
}

export function processGroupAlive(processGroupId) {
  if (process.platform === "win32" || !Number.isInteger(Number(processGroupId)) || Number(processGroupId) <= 0) return false;
  try {
    process.kill(-Number(processGroupId), 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

// True only when the complete owned process tree is verified gone.
// Ordering is fail-closed and inviolable: while processGroupAlive(pgid) is true,
// never report gone merely because the leader start token is missing or different.
// Token / ESRCH / zombie checks run only after the recorded group is empty.
// Absent identity is treated as gone so null records and empty-target cleanup
// still proceed. Windows is never "gone" (unsupported process identity).
// Token mismatch is never permission to clean credentials or remove guards.
export function processGroupGone(identity) {
  if (!identity?.pid) return true;
  if (process.platform === "win32") return false;
  // Live recorded group ⇒ not gone, regardless of leader PID reuse or token state.
  if (identity.processGroupId && processGroupAlive(identity.processGroupId)) return false;
  if (!identity.startToken) {
    try {
      process.kill(identity.pid, 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  }
  const current = processStartToken(identity.pid);
  if (current == null) {
    try {
      process.kill(identity.pid, 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  }
  return current !== identity.startToken || processIsZombie(identity.pid);
}

export function processCommand(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0 || process.platform === "win32") return "";
  const run = ps(["-o", "command=", "-p", String(pid)]);
  return run.status === 0 ? String(run.stdout).trim() : "";
}

export function isGrokProcessCommand(command) {
  const tokens = String(command).match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const values = tokens.map((raw) => {
    const token = raw.replace(/^["']|["']$/g, "");
    const normalized = token.replaceAll("\\", "/").toLowerCase();
    return { name: path.posix.basename(normalized), normalized };
  });
  const executable = values[0];
  if (executable && (executable.name === "grok" || executable.name === "grok.exe" || /^grok-\d+\.\d+\.\d+(?:-|$)/.test(executable.name))) return true;
  return values.some(({ normalized }) => normalized.includes("/.grok/bin/grok") || normalized.includes("/node_modules/@xai-official/grok/"));
}

function ancestorHasCompanionMarker(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0 || process.platform === "win32") return false;
  try {
    if (process.platform === "linux") {
      const entries = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      return entries.some((entry) => entry === "GROK_COMPANION_CHILD=1" || entry.startsWith("GROK_COMPANION_JOB_MARKER="));
    }
    const run = ps(["eww", "-p", String(pid), "-o", "command="]);
    const environment = String(run.stdout);
    return run.status === 0 && /(?:^|\s)GROK_COMPANION_CHILD=1(?:\s|$)|(?:^|\s)GROK_COMPANION_JOB_MARKER=\S+/.test(environment);
  } catch {
    return false;
  }
}

export function identityMatches(identity, marker, kind) {
  if (process.platform === "win32" || !identity?.pid || !identity.startToken) return false;
  if (processStartToken(identity.pid) !== identity.startToken) return false;
  if (processIsZombie(identity.pid)) return false;
  const command = processCommand(identity.pid);
  if (!command || !command.includes(String(marker))) return false;
  if (kind === "provider-bootstrap") {
    const escapedMarker = String(marker).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return /(?:^|\/)provider-bootstrap\.mjs(?:\s|$)/.test(command)
      && new RegExp(`(?:^|\\s)--job-marker\\s+${escapedMarker}(?:\\s|$)`).test(command)
      && /(?:^|\s)--provider-generation\s+[1-9]\d*(?:\s|$)/.test(command)
      && /(?:^|\s)--spawn-intent-id\s+[0-9a-f]{32}(?:\s|$)/.test(command);
  }
  if (kind === "provider") {
    return /(?:^|\s)agent(?:\s+[^\r\n]*)?\s+stdio(?:\s|$)/.test(command)
      || command.includes("--prompt-file")
      || command.includes("--single")
      || identityMatches(identity, marker, "provider-bootstrap");
  }
  if (kind === "import") {
    // Live `grok import --json` transfer processes are registered as import-kind providers.
    return /(?:^|\s)import(?:\s|$)/.test(command) && /(?:^|\s)--json(?:\s|$)/.test(command);
  }
  if (kind === "worker") {
    return command.includes("grok-companion.mjs") && command.includes("--worker");
  }
  if (kind === "controller") {
    return command.includes("grok-companion.mjs") && command.includes("--launch-worker");
  }
  return false;
}

/**
 * Terminate only a process whose birth token, command marker, and process kind
 * still prove ownership. The complete process group must be gone before this
 * function reports success.
 */
export async function terminateOwnedProcess(identity, marker, kind, {
  termTimeoutMs = 2_000,
  killTimeoutMs = 1_500,
  pollMs = 50
} = {}) {
  if (!identity) return false;
  if (process.platform === "win32") {
    throw new CompanionError(
      "E_CAPABILITY",
      "Owned process cleanup is unavailable on this platform."
    );
  }
  // Validate the complete detached identity before even probing group
  // liveness. In particular, a corrupted guard must never redirect a probe or
  // signal from the recorded leader PID to an unrelated process group.
  assertCompleteDetachedOwnedIdentity(identity);
  if (processGroupGone(identity)) return false;
  const current = processStartToken(identity.pid);
  const groupAlive = Boolean(identity.processGroupId && processGroupAlive(identity.processGroupId));
  if (!current) {
    if (groupAlive) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "The recorded process leader exited while its process group remained active."
      );
    }
    return false;
  }
  if (current !== identity.startToken || !identityMatches(identity, marker, kind)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Refusing to signal an unverified owned process.");
  }

  const target = identity.processGroupId ? -identity.processGroupId : identity.pid;
  const signal = (name) => {
    try { process.kill(target, name); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const stillAlive = () => (
    processStartToken(identity.pid) === identity.startToken
    || Boolean(identity.processGroupId && processGroupAlive(identity.processGroupId))
  );
  const waitGone = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!stillAlive()) return true;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return !stillAlive();
  };

  signal("SIGTERM");
  if (await waitGone(termTimeoutMs)) return true;
  signal("SIGKILL");
  if (!await waitGone(killTimeoutMs)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Verified owned process cleanup did not complete.");
  }
  return true;
}

export function hasGrokAncestor(pid = process.ppid) {
  if (process.platform === "win32") return false;
  const visited = new Set();
  let current = Number(pid);
  for (let depth = 0; depth < 16 && current > 1 && !visited.has(current); depth += 1) {
    visited.add(current);
    if (ancestorHasCompanionMarker(current)) return true;
    const run = ps(["-o", "ppid=", "-o", "command=", "-p", String(current)]);
    if (run.status !== 0) return false;
    const line = String(run.stdout).trim();
    const match = line.match(/^(\d+)\s+([\s\S]+)$/);
    if (!match) return false;
    const command = match[2].trim();
    if (isGrokProcessCommand(command)) return true;
    current = Number(match[1]);
  }
  return false;
}
