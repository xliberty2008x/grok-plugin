import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

function ps(args) {
  return spawnSync("ps", args, {
    encoding: "utf8",
    shell: false,
    timeout: 2000
  });
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
  if (kind === "provider") {
    return /(?:^|\s)agent(?:\s+[^\r\n]*)?\s+stdio(?:\s|$)/.test(command) || command.includes("--prompt-file") || command.includes("--single");
  }
  if (kind === "import") {
    // Live `grok import --json` transfer processes are registered as import-kind providers.
    return /(?:^|\s)import(?:\s|$)/.test(command) && /(?:^|\s)--json(?:\s|$)/.test(command);
  }
  if (kind === "worker") {
    return command.includes("grok-companion.mjs") && command.includes("--worker");
  }
  return false;
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
