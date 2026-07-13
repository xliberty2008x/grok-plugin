import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AcpClient } from "./acp-client.mjs";
import { CompanionError } from "./errors.mjs";
import { redact, redactText } from "./redact.mjs";
import { processGroupAlive, processStartToken } from "./process-control.mjs";
import { registerProviderGuard, unregisterProviderGuard } from "./recursion-guard.mjs";

export { processStartToken } from "./process-control.mjs";

const MIN_VERSION = [0, 2, 99];
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REVIEW_SCHEMA = { type: "object", additionalProperties: false, required: ["verdict", "summary", "findings"], properties: { verdict: { enum: ["pass", "needs_changes"] }, summary: { type: "string", minLength: 1 }, findings: { type: "array", items: { type: "object", additionalProperties: false, required: ["severity", "title", "body"], properties: { severity: { enum: ["critical", "high", "medium", "low", "info"] }, title: { type: "string", minLength: 1 }, body: { type: "string", minLength: 1 }, file: { type: ["string", "null"] }, line: { type: ["integer", "null"], minimum: 1 } } } } } };
const ALLOW_ENV = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "TERM", "COLORTERM", "NO_COLOR", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ComSpec", "PATHEXT"]);

export function assertProviderPlatform() {
  if (process.platform === "win32") {
    throw new CompanionError("E_CAPABILITY", "Grok provider execution is disabled on Windows until process identity and forced-cleanup behavior are authenticated end to end. Provider-neutral validation remains available.");
  }
}

function executable(file) { try { const stat = fs.statSync(file); fs.accessSync(file, fs.constants.X_OK); return stat.isFile(); } catch { return false; } }
function which(name) { const run = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8", shell: false, timeout: 5000 }); return run.status === 0 ? String(run.stdout).split(/\r?\n/)[0].trim() : null; }

export function discoverGrok() {
  for (const candidate of [process.env.GROK_BIN, which("grok"), path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok")]) if (candidate && executable(candidate)) return fs.realpathSync(candidate);
  throw new CompanionError("E_GROK_NOT_FOUND", "Grok Build CLI was not found. Install it with `npm install -g @xai-official/grok`, then run `/grok:setup`.");
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
    ...extra
  };
}

function safeMarker(value) { return String(value).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80); }

function ensureFreshCachedCredential(source, minimumValidityMs = 45 * 60 * 1000) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(source, "utf8")); }
  catch { throw new CompanionError("E_AUTH_REQUIRED", "Grok cached authentication is unreadable. Run `grok login`, then `/grok:setup`."); }
  const expiries = Object.values(parsed || {}).flatMap((entry) => entry && typeof entry === "object" && typeof entry.key === "string" && entry.key.length >= 16 && entry.expires_at ? [Date.parse(entry.expires_at)] : []).filter(Number.isFinite);
  if (!expiries.length || Math.max(...expiries) - Date.now() >= minimumValidityMs) return;
  const refreshed = spawnSync(discoverGrok(), ["models"], { encoding: "utf8", shell: false, timeout: 30000, env: childEnvironment() });
  if (refreshed.status !== 0 || refreshed.error) throw new CompanionError("E_AUTH_REQUIRED", "Grok cached authentication could not be refreshed. Run `grok login`, then `/grok:setup`.");
  try { parsed = JSON.parse(fs.readFileSync(source, "utf8")); }
  catch { throw new CompanionError("E_AUTH_REQUIRED", "Grok cached authentication is unreadable after refresh. Run `grok login`, then `/grok:setup`."); }
  const refreshedExpiries = Object.values(parsed || {}).flatMap((entry) => entry && typeof entry === "object" && typeof entry.key === "string" && entry.key.length >= 16 && entry.expires_at ? [Date.parse(entry.expires_at)] : []).filter(Number.isFinite);
  if (refreshedExpiries.length && Math.max(...refreshedExpiries) - Date.now() < minimumValidityMs) throw new CompanionError("E_AUTH_REQUIRED", "Grok cached authentication expires too soon for an isolated job. Run `grok login`, then `/grok:setup`.");
}

function writeReviewCredential(source, destination, { refresh = false } = {}) {
  if (!refresh && fs.existsSync(destination)) {
    if (!fs.lstatSync(destination).isFile()) throw new CompanionError("E_STATE", "The isolated Grok credential path is not a regular file.");
    try {
      const existing = JSON.parse(fs.readFileSync(destination, "utf8"));
      const key = Object.values(existing || {}).find((entry) => entry && typeof entry === "object" && typeof entry.key === "string" && entry.key.length >= 16)?.key;
      if (key) return key;
    } catch {}
    throw new CompanionError("E_AUTH_REQUIRED", "The isolated Grok credential is unreadable. Run `grok login`, then `/grok:setup`.");
  }
  const stat = fs.statSync(source);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 2 * 1024 * 1024) throw new CompanionError("E_AUTH_REQUIRED", "Grok cached authentication is unavailable. Run `grok login`, then `/grok:setup`.");
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(source, "utf8")); }
  catch { throw new CompanionError("E_AUTH_REQUIRED", "Grok cached authentication is unreadable. Run `grok login`, then `/grok:setup`."); }
  const candidates = Object.entries(parsed || {}).filter(([, entry]) => entry && typeof entry === "object" && typeof entry.key === "string" && entry.key.length >= 16);
  const selected = candidates.sort(([, left], [, right]) => String(right.expires_at || "").localeCompare(String(left.expires_at || "")))[0];
  if (!selected) throw new CompanionError("E_AUTH_REQUIRED", "Grok cached authentication contains no usable session. Run `grok login`, then `/grok:setup`.");
  const [account, entry] = selected;
  const isolated = { key: entry.key, auth_mode: entry.auth_mode || "oauth", create_time: entry.create_time || new Date().toISOString(), user_id: "", email: "", first_name: "", last_name: "", profile_image_asset_id: "", principal_type: entry.principal_type || "", principal_id: entry.principal_id || "", team_id: entry.team_id || "", coding_data_retention_opt_out: Boolean(entry.coding_data_retention_opt_out), refresh_token: "", expires_at: entry.expires_at || "", oidc_issuer: entry.oidc_issuer || "", oidc_client_id: entry.oidc_client_id || "" };
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ [account]: isolated })}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return entry.key;
}

export function reviewEnvironment(stateDir, jobMarker, { includeCredential = true } = {}) {
  const marker = safeMarker(jobMarker), home = path.join(stateDir, "review-homes", marker), grokHome = path.join(home, ".grok");
  fs.mkdirSync(grokHome, { recursive: true, mode: 0o700 });
  const sentinel = path.join(home, "sandbox-enforcement-sentinel"), profile = `companion_${crypto.createHash("sha256").update(marker).digest("hex").slice(0, 20)}`;
  if (!fs.existsSync(sentinel)) fs.writeFileSync(sentinel, "Review sandbox enforcement sentinel.\n", { mode: 0o600, flag: "wx" });
  fs.writeFileSync(path.join(grokHome, "sandbox.toml"), `[profiles.${profile}]\nextends = "strict"\ndeny = [${JSON.stringify(sentinel)}]\n`, { mode: 0o600 });
  const authPath = process.env.GROK_AUTH_PATH || path.join(os.homedir(), ".grok", "auth.json");
  const extra = { HOME: home, USERPROFILE: home, GROK_HOME: grokHome, GROK_FOLDER_TRUST: "1" };
  const knownSecrets = [];
  if (includeCredential && fs.existsSync(authPath)) {
    ensureFreshCachedCredential(authPath);
    knownSecrets.push(writeReviewCredential(authPath, path.join(grokHome, "auth.json")));
  }
  const env = childEnvironment(extra);
  delete env.HOMEDRIVE; delete env.HOMEPATH;
  return { env, home, grokHome, sandboxProfile: profile, knownSecrets };
}

export function cleanupReviewEnvironment(stateDir, jobMarker) {
  const home = path.join(stateDir, "review-homes", safeMarker(jobMarker));
  try { fs.rmSync(home, { recursive: true, force: true }); return { ok: true }; }
  catch (error) { return { ok: false, warning: redactText(error.message) }; }
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CompanionError("E_STATE", `Refusing unsafe isolated Grok directory ${directory}.`);
  fs.chmodSync(directory, 0o700);
}

function atomicPrivateFile(file, contents) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

export function taskEnvironment(stateDir, root, profile) {
  if (!profile?.id || !/^rescue-(read|write)-v2$/.test(profile.id)) throw new CompanionError("E_STATE", "A qualified isolated task profile is required.");
  const home = path.join(stateDir, "task-homes", profile.id), grokHome = path.join(home, ".grok");
  privateDirectory(home);
  privateDirectory(grokHome);
  atomicPrivateFile(path.join(grokHome, "config.toml"), `[skills]\nignore = [${JSON.stringify(fs.realpathSync(root))}]\n\n[subagents]\nenabled = false\n\n[features]\nlsp_tools = false\n`);
  const authPath = process.env.GROK_AUTH_PATH || path.join(os.homedir(), ".grok", "auth.json");
  if (!fs.existsSync(authPath)) throw new CompanionError("E_AUTH_REQUIRED", "Grok cached authentication is unavailable. Run `grok login`, then `/grok:setup`.");
  ensureFreshCachedCredential(authPath);
  const knownSecrets = [writeReviewCredential(authPath, path.join(grokHome, "auth.json"), { refresh: true })];
  const env = childEnvironment({
    HOME: home,
    USERPROFILE: home,
    GROK_HOME: grokHome,
    GROK_FOLDER_TRUST: "1",
    GROK_SUBAGENTS: "0",
    GROK_MEMORY: "0",
    GROK_WEB_FETCH: "0",
    GROK_LSP_TOOLS: "0"
  });
  delete env.HOMEDRIVE;
  delete env.HOMEPATH;
  return { env, home, grokHome, knownSecrets };
}

function inspectIsolation(binary, root, environment) {
  const inspect = spawnSync(binary, ["inspect", "--json"], { cwd: root, encoding: "utf8", shell: false, timeout: 30000, env: environment.env });
  if (inspect.status !== 0 || inspect.error) throw new CompanionError("E_CAPABILITY", "Grok could not validate the isolated provider environment.", { diagnostic: redactText(inspect.error?.message || inspect.stderr || inspect.stdout, environment.knownSecrets).slice(-2000) });
  let value;
  try { value = JSON.parse(inspect.stdout); }
  catch { throw new CompanionError("E_CAPABILITY", "Grok inspect returned malformed JSON for the isolated provider environment."); }
  const nonBuiltinAgents = (value.agents || []).filter((agent) => agent?.source?.type !== "builtin");
  const bundledSkillRoots = [
    path.join(environment.grokHome, "skills"),
    path.join(environment.grokHome, "bundled", "skills")
  ];
  const externalSkills = (value.skills || []).filter((skill) => {
    if (skill?.source?.type === "builtin") return false;
    if (skill?.source?.type !== "bundled" || typeof skill.source.path !== "string") return true;
    try {
      const actual = fs.realpathSync(skill.source.path);
      return !bundledSkillRoots.some((candidate) => {
        try {
          const rootPath = fs.realpathSync(candidate);
          return actual === rootPath || actual.startsWith(`${rootPath}${path.sep}`);
        } catch { return false; }
      });
    } catch { return true; }
  });
  if ((value.hooks || []).length || externalSkills.length || (value.plugins || []).length || (value.mcpServers || []).length || nonBuiltinAgents.length) {
    throw new CompanionError("E_CAPABILITY", "The isolated provider environment loaded external hooks, skills, plugins, MCP servers, or agents.");
  }
  return value;
}

function spawnArgs({ root, profile, model, effort, leaderSocket }) {
  const readTask = profile.id === "rescue-read-v2";
  const taskProfile = readTask
    ? path.join(PLUGIN_ROOT, "provider-agents", "rescue-read.md")
    : profile.id === "rescue-write-v2"
      ? path.join(PLUGIN_ROOT, "provider-agents", "rescue-write.md")
      : null;
  if (taskProfile) {
    const actualDigest = crypto.createHash("sha256").update(fs.readFileSync(taskProfile)).digest("hex");
    if (!profile.agentProfileDigest || profile.agentProfileDigest !== actualDigest) throw new CompanionError("E_SECURITY_PROFILE", "The checked-in Grok agent profile changed; start a fresh rescue task under the current security contract.");
  }
  const args = ["--cwd", root, "--sandbox", profile.sandbox, "--permission-mode", profile.permissionMode, "--deny", "WebFetch", "--deny", "MCPTool", "--disable-web-search", "--no-subagents", "--no-memory", "--no-plan"];
  if (readTask) args.push("--deny", "Bash", "--deny", "Edit", "--deny", "Write");
  if (profile.permissionMode === "bypassPermissions") args.push("--always-approve");
  args.push("agent", "--no-leader", "--leader-socket", leaderSocket);
  if (taskProfile) args.push("--agent-profile", taskProfile);
  if (model) args.push("--model", model);
  if (effort) args.push("--reasoning-effort", effort);
  args.push("stdio");
  return args;
}

function extractJson(text) {
  const trimmed = String(text).trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) try { return JSON.parse(fenced[1]); } catch {}
  const start = trimmed.indexOf("{"), end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
  return null;
}

export function validateReview(value) {
  const rootKeys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
  const ok = value && rootKeys.every((key) => ["verdict", "summary", "findings"].includes(key)) && ["pass", "needs_changes"].includes(value.verdict) && typeof value.summary === "string" && value.summary.trim() && Array.isArray(value.findings) && value.findings.every((f) => f && typeof f === "object" && !Array.isArray(f) && Object.keys(f).every((key) => ["severity", "title", "body", "file", "line"].includes(key)) && ["critical", "high", "medium", "low", "info"].includes(f.severity) && typeof f.title === "string" && f.title.trim() && typeof f.body === "string" && f.body.trim() && (f.file === undefined || f.file === null || typeof f.file === "string") && (f.line === undefined || f.line === null || Number.isInteger(f.line) && f.line >= 1));
  if (!ok) throw new CompanionError("E_SCHEMA", "Grok review output did not match the required schema.");
  return value;
}

export async function openProvider({ root, profile, model = null, effort = null, stateDir, jobMarker = "probe", environment = null, knownSecrets = environment?.knownSecrets || [], onEvent = () => {} }) {
  assertProviderPlatform();
  const binary = discoverGrok(), version = grokVersion(binary);
  const safeMarker = String(jobMarker).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
  const leaderSocket = path.join(stateDir, `leader-${safeMarker}-${process.pid}-${Date.now()}.sock`);
  const child = spawn(binary, spawnArgs({ root, profile, model, effort, leaderSocket }), { cwd: root, env: { ...(environment?.env || childEnvironment()), GROK_COMPANION_JOB_MARKER: safeMarker }, shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  const processIdentity = { pid: child.pid, startToken: processStartToken(child.pid), processGroupId: process.platform === "win32" ? null : child.pid };
  try { registerProviderGuard(root, safeMarker, processIdentity, process.env.GROK_COMPANION_CLAUDE_SESSION_ID); }
  catch (error) { await ensureChildExit(child, processIdentity); throw error; }
  const permissionPolicy = (params) => {
    const options = Array.isArray(params?.options) ? params.options : [];
    const writing = profile.id === "rescue-write-v2";
    const pattern = writing ? /allow.*once|once.*allow/i : /reject|deny/i;
    const selected = options.find((option) => pattern.test(`${option?.kind || ""} ${option?.name || ""} ${option?.optionId || ""}`));
    return selected?.optionId ? { outcome: { outcome: "selected", optionId: selected.optionId } } : { outcome: { outcome: "cancelled" } };
  };
  const client = new AcpClient(child, { timeoutMs: 30000, permissionPolicy, knownSecrets });
  let eventError = null;
  const emitEvent = (event) => {
    if (eventError) return;
    try { onEvent(event); }
    catch (error) {
      eventError = error;
      try { process.kill(processIdentity.processGroupId && process.platform !== "win32" ? -processIdentity.processGroupId : child.pid, "SIGTERM"); } catch {}
    }
  };
  client.on("update", emitEvent);
  client.on("stderr", (text) => emitEvent({ type: "diagnostic", text: redactText(text, knownSecrets) }));
  emitEvent({ type: "provider", process: processIdentity, version });
  let initialized;
  try {
    if (eventError) throw eventError;
    initialized = await client.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }, clientInfo: { name: "grok-companion", version: "0.1.0" } });
    if (eventError) throw eventError;
  } catch (error) {
    client.close(); await ensureChildExit(child, processIdentity); unregisterProviderGuard(root, safeMarker); throw eventError || error;
  }
  if (initialized?.protocolVersion !== 1 || !initialized?.agentCapabilities?.loadSession) { client.close(); await ensureChildExit(child, processIdentity); unregisterProviderGuard(root, safeMarker); throw new CompanionError("E_CAPABILITY", "Grok ACP v1 with session loading is required."); }
  const availableModels = initialized?._meta?.modelState?.availableModels || [];
  const selectedModel = model
    ? availableModels.find((item) => item.modelId === model)
    : availableModels.find((item) => item.modelId === initialized?._meta?.modelState?.currentModelId) || availableModels[0];
  if (model && !selectedModel) { client.close(); await ensureChildExit(child, processIdentity); unregisterProviderGuard(root, safeMarker); throw new CompanionError("E_CAPABILITY", `Model ${model} is not advertised by Grok.`, { available: availableModels.map((x) => x.modelId) }); }
  const efforts = (selectedModel?._meta?.reasoningEfforts || []).map((item) => item.id);
  if (effort && efforts.length && !efforts.includes(effort)) { client.close(); await ensureChildExit(child, processIdentity); unregisterProviderGuard(root, safeMarker); throw new CompanionError("E_CAPABILITY", `Reasoning effort ${effort} is not advertised for model ${selectedModel.modelId}.`, { available: efforts }); }
  return { binary, version, child, client, initialized, leaderSocket, process: processIdentity, marker: safeMarker, emitEvent, eventError: () => eventError };
}

export async function ensureChildExit(child, identity, { naturalExitMs = 750 } = {}) {
  if (!identity?.pid || child.pid !== identity.pid || !identity.startToken) throw new CompanionError("E_PROCESS_IDENTITY", "Refusing to clean up an unverified Grok process tree.", { pid: identity?.pid || child.pid || null });
  if (process.platform !== "win32" && identity.processGroupId !== identity.pid) throw new CompanionError("E_PROCESS_IDENTITY", "Refusing to clean up a Grok process outside its owned process group.", { pid: identity.pid, processGroupId: identity.processGroupId });
  const initialToken = processStartToken(identity.pid);
  if (initialToken && initialToken !== identity.startToken) throw new CompanionError("E_PROCESS_IDENTITY", `Refusing to signal unverified Grok process ${identity.pid}.`, { pid: identity.pid });
  const alive = () => processStartToken(identity.pid) === identity.startToken || (identity.processGroupId && processGroupAlive(identity.processGroupId));
  const waitGone = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!alive()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !alive();
  };
  const signal = (name) => {
    try { process.kill(identity.processGroupId && process.platform !== "win32" ? -identity.processGroupId : identity.pid, name); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  if (await waitGone(naturalExitMs)) return;
  signal("SIGTERM");
  if (await waitGone(1500)) return;
  signal("SIGKILL");
  if (!await waitGone(1500)) throw new CompanionError("E_PROCESS_IDENTITY", `Verified Grok process group ${identity.processGroupId || identity.pid} did not exit after SIGKILL.`, { pid: identity.pid, processGroupId: identity.processGroupId || null });
}

function headlessArgs({ root, promptFile, model, effort, leaderSocket, resumeSessionId, newSessionId, structured, sandboxProfile }) {
  const args = ["--cwd", root, "--agent", "explore", "--sandbox", sandboxProfile, "--permission-mode", "default", "--tools", "todo_write", "--disallowed-tools", "Agent,run_terminal_cmd,read_file,list_dir,grep,search_replace,write,web_search,web_fetch,search_tool,use_tool", "--deny", "MCPTool(*)", "--deny", "Bash(*)", "--deny", "Read(*)", "--deny", "Grep(*)", "--deny", "Edit(*)", "--deny", "Write(*)", "--deny", "WebFetch(*)", "--disable-web-search", "--no-subagents", "--no-memory", "--no-plan", "--leader-socket", leaderSocket];
  if (model) args.push("--model", model);
  if (effort) args.push("--reasoning-effort", effort);
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  else args.push("--session-id", newSessionId);
  if (structured) args.push("--json-schema", JSON.stringify(REVIEW_SCHEMA));
  else args.push("--output-format", "json");
  args.push("--verbatim", "--prompt-file", promptFile);
  return args;
}

function anonymousPrompt(directory, prompt) {
  const temporary = path.join(directory, `prompt-${process.pid}-${crypto.randomBytes(8).toString("hex")}.md`);
  let fd = null;
  try {
    fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600);
    fs.unlinkSync(temporary);
    fs.writeSync(fd, String(prompt), 0, "utf8");
    return fd;
  } catch (error) {
    if (fd != null) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

export async function runHeadless({ root, profile, prompt, model, effort, stateDir, jobMarker = "review", resumeSessionId = null, structured = false, cancelRequested = () => false, onEvent = () => {}, timeoutMs = 15 * 60 * 1000, maxOutputBytes = 32 * 1024 * 1024 }) {
  assertProviderPlatform();
  const binary = discoverGrok(), version = grokVersion(binary);
  const marker = safeMarker(jobMarker), isolation = reviewEnvironment(stateDir, marker);
  const leaderSocket = path.join(stateDir, `leader-${marker}-${process.pid}-${Date.now()}.sock`);
  const promptFile = process.platform === "linux" ? "/proc/self/fd/3" : "/dev/fd/3";
  const promptFd = anonymousPrompt(isolation.home, prompt);
  const newSessionId = resumeSessionId ? null : crypto.randomUUID();
  let child;
  try {
    child = spawn(binary, headlessArgs({ root, promptFile, model, effort, leaderSocket, resumeSessionId, newSessionId, structured, sandboxProfile: isolation.sandboxProfile }), { cwd: root, env: { ...isolation.env, GROK_COMPANION_JOB_MARKER: marker }, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe", promptFd] });
  } finally {
    fs.closeSync(promptFd);
  }
  const identity = { pid: child.pid, startToken: processStartToken(child.pid), processGroupId: process.platform === "win32" ? null : child.pid };
  try { registerProviderGuard(root, marker, identity, process.env.GROK_COMPANION_CLAUDE_SESSION_ID); }
  catch (error) { await ensureChildExit(child, identity); cleanupReviewEnvironment(stateDir, marker); throw error; }
  let stdout = "", stdoutBytes = 0, stderr = "", terminationReason = null, forceTimer = null, eventError = null;
  const MAX_OUTPUT = maxOutputBytes;
  const terminate = (signal) => { try { process.kill(identity.processGroupId && process.platform !== "win32" ? -identity.processGroupId : child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; } };
  const beginTermination = (reason) => {
    if (terminationReason) return;
    terminationReason = reason;
    terminate("SIGTERM");
    forceTimer = setTimeout(() => { try { terminate("SIGKILL"); } catch {} }, 2000);
  };
  const emitEvent = (event) => {
    if (eventError) return;
    try { onEvent(event); }
    catch (error) { eventError = error; beginTermination("event"); }
  };
  const completion = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal])); });
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (terminationReason === "output") return;
    const bytes = Buffer.byteLength(chunk);
    if (stdoutBytes + bytes > MAX_OUTPUT) { beginTermination("output"); return; }
    stdout += chunk;
    stdoutBytes += bytes;
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-65536); emitEvent({ type: "diagnostic", text: redactText(chunk, isolation.knownSecrets) }); });
  emitEvent({ type: "provider", process: identity, version });
  emitEvent({ type: "session", sessionId: resumeSessionId || newSessionId });
  const cancelPoll = setInterval(() => { if (!terminationReason && cancelRequested()) beginTermination("cancel"); }, 100);
  const timeout = setTimeout(() => beginTermination("timeout"), timeoutMs);
  let code, signal;
  try {
    [code, signal] = await completion;
  } catch (error) {
    throw new CompanionError("E_PROVIDER_EXIT", `Could not start Grok: ${error.message}`);
  } finally {
    clearInterval(cancelPoll); clearTimeout(timeout); if (forceTimer) clearTimeout(forceTimer);
    await ensureChildExit(child, identity);
    unregisterProviderGuard(root, marker);
  }
  if (eventError) { cleanupReviewEnvironment(stateDir, marker); throw eventError; }
  if (terminationReason === "cancel") throw new CompanionError("E_CANCELLED", "Grok job was cancelled.");
  if (terminationReason === "timeout") throw new CompanionError("E_TIMEOUT", "Grok headless review timed out.");
  if (terminationReason === "output") throw new CompanionError("E_OUTPUT_LIMIT", `Grok headless output exceeded ${MAX_OUTPUT} bytes.`);
  if (code !== 0) {
    const diagnostic = redactText(stderr || stdout, isolation.knownSecrets).slice(-8000);
    if (/login|auth|unauthori[sz]ed|401/i.test(diagnostic)) throw new CompanionError("E_AUTH_REQUIRED", "Grok authentication is required. Run `grok login`, then `/grok:setup`.", { diagnostic });
    throw new CompanionError("E_PROVIDER_EXIT", `Grok headless review exited (${code ?? signal}).`, { code, signal, diagnostic });
  }
  let payload;
  try { payload = JSON.parse(stdout); } catch { throw new CompanionError("E_PROTOCOL", "Grok headless mode returned malformed JSON."); }
  const sessionId = payload.sessionId || resumeSessionId || newSessionId;
  if (!sessionId) throw new CompanionError("E_PROTOCOL", "Grok headless mode returned no session ID.");
  const expectedSessionId = resumeSessionId || newSessionId;
  if (sessionId !== expectedSessionId) throw new CompanionError("E_PROTOCOL", `Grok returned session ${sessionId} while ${expectedSessionId} was required.`);
  return { sessionId, text: redactText(String(payload.text ?? "").trim(), isolation.knownSecrets), structuredOutput: redact(payload.structuredOutput, isolation.knownSecrets), stopReason: payload.stopReason || "EndTurn", provider: { version, process: identity, isolatedHome: isolation.home }, capabilities: { transport: "headless", agent: "explore", sandbox: isolation.sandboxProfile } };
}

export async function runProvider({ root, profile, prompt, model, effort, stateDir, jobMarker = "job", resumeSessionId = null, cancelRequested = () => false, onEvent = () => {}, timeoutMs = undefined }) {
  if (profile.transport === "headless") return runHeadless({ root, profile, prompt, model, effort, stateDir, jobMarker, resumeSessionId, cancelRequested, onEvent, ...(timeoutMs == null ? {} : { timeoutMs }) });
  const environment = /^rescue-(read|write)-v2$/.test(profile.id || "") ? taskEnvironment(stateDir, root, profile) : null;
  if (environment) inspectIsolation(discoverGrok(), root, environment);
  const provider = await openProvider({ root, profile, model, effort, stateDir, jobMarker, environment, onEvent });
  let sessionId = null, text = "", poll, killTimer, cancelled = false;
  try {
    if ((provider.initialized.authMethods || []).some((method) => method?.id === "cached_token")) {
      await provider.client.request("authenticate", { methodId: "cached_token", _meta: { headless: true } }, 30000);
    }
    const session = resumeSessionId ? await provider.client.request("session/load", { sessionId: resumeSessionId, cwd: root, mcpServers: [] }, 45000) : await provider.client.request("session/new", { cwd: root, mcpServers: [] }, 45000);
    sessionId = session?.sessionId || resumeSessionId;
    if (!sessionId) throw new CompanionError("E_PROTOCOL", "Grok did not return a session ID.");
    if (resumeSessionId && sessionId !== resumeSessionId) throw new CompanionError("E_PROTOCOL", `Grok loaded session ${sessionId} while ${resumeSessionId} was required.`);
    provider.emitEvent({ type: "session", sessionId, models: session?.models });
    if (provider.eventError()) throw provider.eventError();
    const listener = (event) => { if (event.type === "message") text += event.text; };
    provider.client.on("update", listener);
    poll = setInterval(() => { if (!cancelled && cancelRequested()) { cancelled = true; provider.client.notify("session/cancel", { sessionId }); killTimer = setTimeout(() => { try { process.kill(provider.process.processGroupId ? -provider.process.processGroupId : provider.child.pid, "SIGTERM"); } catch {} }, 5000); } }, 100);
    let result;
    try { result = await provider.client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] }, timeoutMs ?? 30 * 60 * 1000); }
    catch (error) { if (cancelled) throw new CompanionError("E_CANCELLED", "Grok job was cancelled."); throw provider.eventError() || error; }
    if (provider.eventError()) throw provider.eventError();
    clearInterval(poll); poll = null; provider.client.off("update", listener);
    if (cancelled || result?.stopReason === "cancelled") throw new CompanionError("E_CANCELLED", "Grok job was cancelled.");
    return { sessionId, text: redactText(text.trim(), environment?.knownSecrets || []), stopReason: result?.stopReason || "end_turn", provider: { version: provider.version, process: provider.process }, capabilities: provider.initialized };
  } catch (error) {
    if (/auth|login|unauthori[sz]ed|no auth method/i.test(`${error?.message || ""} ${error?.details?.data || ""}`)) throw new CompanionError("E_AUTH_REQUIRED", "Grok authentication is unavailable or expired. Run `grok login`, then `/grok:setup`.");
    throw provider.eventError() || error;
  } finally {
    if (poll) clearInterval(poll);
    if (killTimer) clearTimeout(killTimer);
    provider.client.close();
    await ensureChildExit(provider.child, provider.process);
    unregisterProviderGuard(root, provider.marker);
  }
}

export async function runStructuredReview(options) {
  const execute = (values) => values.profile?.transport === "headless" ? runHeadless({ ...values, structured: true }) : runProvider(values);
  let run = await execute(options), parsed = run.structuredOutput ?? extractJson(run.text);
  try { return { ...run, review: validateReview(parsed) }; }
  catch (firstError) {
    const repair = await execute({ ...options, resumeSessionId: run.sessionId, prompt: "Your previous response was not valid review JSON. Return only one JSON object matching the required schema, preserving your findings." });
    parsed = repair.structuredOutput ?? extractJson(repair.text);
    return { ...repair, review: validateReview(parsed) };
  }
}

export function deleteSession(sessionId, binary = null, env = null) {
  if (!sessionId) return { ok: true };
  const run = spawnSync(binary || discoverGrok(), ["sessions", "delete", sessionId], { encoding: "utf8", timeout: 10000, shell: false, env: env || childEnvironment() });
  return { ok: run.status === 0, warning: run.status === 0 ? null : redactText(run.stderr || run.stdout) };
}

export async function probe(root, stateDir) {
  assertProviderPlatform();
  const binary = discoverGrok();
  grokVersion(binary);
  const help = spawnSync(binary, ["--help"], { encoding: "utf8", shell: false, timeout: 15000, env: childEnvironment() });
  const helpText = `${help.stdout || ""}\n${help.stderr || ""}`;
  const requiredFlags = ["--prompt-file", "--json-schema", "--tools", "--disallowed-tools", "--sandbox"];
  const missingFlags = requiredFlags.filter((flag) => !helpText.includes(flag));
  if (help.status !== 0 || missingFlags.length) throw new CompanionError("E_CAPABILITY", "Grok does not advertise the required headless review flags.", { missing: missingFlags });
  const agentHelp = spawnSync(binary, ["agent", "--help"], { encoding: "utf8", shell: false, timeout: 15000, env: childEnvironment() });
  const agentHelpText = `${agentHelp.stdout || ""}\n${agentHelp.stderr || ""}`;
  const requiredAgentFlags = ["--agent-profile", "--no-leader", "--leader-socket"];
  const missingAgentFlags = requiredAgentFlags.filter((flag) => !agentHelpText.includes(flag));
  if (agentHelp.status !== 0 || missingAgentFlags.length) throw new CompanionError("E_CAPABILITY", "Grok does not advertise the required isolated ACP agent flags.", { missing: missingAgentFlags });
  const auth = spawnSync(binary, ["models"], { encoding: "utf8", shell: false, timeout: 30000, env: childEnvironment() });
  if (auth.status !== 0) throw new CompanionError("E_AUTH_REQUIRED", "Grok authentication is unavailable or expired. Run `grok login`, then retry `/grok:setup`.", { diagnostic: redactText(auth.stderr || auth.stdout).slice(-2000) });
  const marker = `setup-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const isolation = reviewEnvironment(stateDir, marker);
  let provider = null;
  try {
    inspectIsolation(binary, root, isolation);
    const profile = { id: "setup-probe-v1", sandbox: "read-only", permissionMode: "dontAsk" };
    provider = await openProvider({ root, profile, stateDir, jobMarker: marker, environment: isolation });
    return { binary: provider.binary, version: provider.version, authenticated: true, headlessReview: { flags: requiredFlags, isolated: true, externalHooks: 0, externalSkills: 0, externalPlugins: 0, externalMcpServers: 0 }, acpIsolation: { flags: requiredAgentFlags, isolated: true }, protocolVersion: provider.initialized.protocolVersion, loadSession: Boolean(provider.initialized.agentCapabilities?.loadSession), authMethods: (provider.initialized.authMethods || []).map((x) => ({ id: x.id, name: x.name })), models: (provider.initialized?._meta?.modelState?.availableModels || []).map((x) => ({ id: x.modelId, efforts: (x._meta?.reasoningEfforts || []).map((e) => e.id) })) };
  } finally {
    let shutdownError = null;
    if (provider) {
      provider.client.close();
      try {
        await ensureChildExit(provider.child, provider.process);
        unregisterProviderGuard(root, provider.marker);
      } catch (error) {
        shutdownError = error;
      }
    }
    const cleanup = cleanupReviewEnvironment(stateDir, marker);
    if (!cleanup.ok) throw new CompanionError("E_STATE", "Could not remove the setup review-isolation probe.", { warning: cleanup.warning });
    if (shutdownError) throw shutdownError;
  }
}
