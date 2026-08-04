import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { CompanionError } from "./errors.mjs";
import { hostCommand } from "./host.mjs";

const MIN_VERSION = [0, 2, 99];
const ALLOW_ENV = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "TERM", "COLORTERM", "NO_COLOR", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ComSpec", "PATHEXT"]);
/** Hard-gate for every provider execution entry. Prefer this over process-identity errors on unsupported platforms. */
export function assertProviderPlatform(platform = process.platform) {
  if (platform === "win32") {
    throw new CompanionError("E_CAPABILITY", "Grok provider execution is disabled on Windows until process identity and forced-cleanup behavior are authenticated end to end. Provider-neutral validation remains available.");
  }
}

function executable(file) { try { const stat = fs.statSync(file); fs.accessSync(file, fs.constants.X_OK); return stat.isFile(); } catch { return false; } }
function which(name) { const run = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8", shell: false, timeout: 5000 }); return run.status === 0 ? String(run.stdout).split(/\r?\n/)[0].trim() : null; }

export function discoverGrok() {
  for (const candidate of [process.env.GROK_BIN, which("grok"), path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok")]) if (candidate && executable(candidate)) return fs.realpathSync(candidate);
  throw new CompanionError("E_GROK_NOT_FOUND", `Grok Build CLI was not found. Install it with \`npm install -g @xai-official/grok\`, then run ${hostCommand("setup")}.`);
}

export function grokVersion(binary = discoverGrok()) {
  const run = spawnSync(binary, ["--version"], { encoding: "utf8", shell: false, timeout: 10000, env: childEnvironment() });
  const match = `${run.stdout || ""} ${run.stderr || ""}`.match(/(\d+)\.(\d+)\.(\d+)/);
  if (run.status !== 0 || !match) throw new CompanionError("E_GROK_VERSION", "Could not determine the Grok CLI version.");
  const parts = match.slice(1).map(Number);
  if (parts.some((v, i) => v < MIN_VERSION[i] && parts.slice(0, i).every((x, j) => x === MIN_VERSION[j]))) throw new CompanionError("E_GROK_VERSION", `Grok ${match[0]} is too old; 0.2.99 or newer is required.`);
  return match[0];
}

export function childEnvironment(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if ((ALLOW_ENV.has(key) || key.startsWith("LC_")) && value != null) env[key] = value;
  return {
    ...env,
    GROK_COMPANION_CHILD: "1",
    GROK_CLAUDE_MCPS_ENABLED: "false",
    GROK_CLAUDE_SKILLS_ENABLED: "false",
    GROK_CLAUDE_RULES_ENABLED: "false",
    GROK_CLAUDE_AGENTS_ENABLED: "false",
    GROK_CLAUDE_HOOKS_ENABLED: "false",
    GROK_CLAUDE_SESSIONS_ENABLED: "false",
    GROK_CURSOR_MCPS_ENABLED: "false",
    GROK_CURSOR_SKILLS_ENABLED: "false",
    GROK_CURSOR_RULES_ENABLED: "false",
    GROK_CURSOR_AGENTS_ENABLED: "false",
    GROK_CURSOR_HOOKS_ENABLED: "false",
    GROK_CURSOR_SESSIONS_ENABLED: "false",
    GROK_CODEX_MCPS_ENABLED: "false",
    GROK_CODEX_SKILLS_ENABLED: "false",
    GROK_CODEX_RULES_ENABLED: "false",
    GROK_CODEX_AGENTS_ENABLED: "false",
    GROK_CODEX_HOOKS_ENABLED: "false",
    GROK_CODEX_SESSIONS_ENABLED: "false",
    GROK_SUBAGENTS: "0",
    GROK_MEMORY: "0",
    GROK_WEB_FETCH: "0",
    GROK_LSP_TOOLS: "0",
    GROK_WORKSPACE_TOOL_DEFS_ENABLED: "0",
    GROK_MANAGED_MCPS_ENABLED: "false",
    GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: "false",
    GROK_MCP_AUTO_RESTART: "false",
    ...extra,
    // Official Grok treats this as the central managed-agent update gate.
    // Keep it last so no caller-provided environment can re-enable updates.
    GROK_DISABLE_AUTOUPDATER: "1"
  };
}

export function safeMarker(value) { return String(value).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80); }
