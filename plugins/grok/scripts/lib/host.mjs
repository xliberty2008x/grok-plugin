import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOST_ENV = "GROK_COMPANION_HOST";
const HOST_SESSION_ENV = "GROK_COMPANION_HOST_SESSION_ID";
const LEGACY_CLAUDE_SESSION_ENV = "GROK_COMPANION_CLAUDE_SESSION_ID";
const PLUGIN_DATA_ENV = "GROK_COMPANION_PLUGIN_DATA";

function normalizeHostKind(value) {
  if (value === "codex") return "codex";
  if (value === "claude" || value === "claude-code") return "claude-code";
  if (value === "cli") return "cli";
  return null;
}

export function hostContext(env = process.env) {
  const explicitKind = normalizeHostKind(env[HOST_ENV]);
  const sessionId = env[HOST_SESSION_ENV] || env[LEGACY_CLAUDE_SESSION_ENV] || env.CODEX_THREAD_ID || null;
  const kind = explicitKind
    || (env.CODEX_THREAD_ID ? "codex" : null)
    || (env[LEGACY_CLAUDE_SESSION_ENV] || env.CLAUDE_PROJECT_DIR || env.CLAUDE_PLUGIN_DATA ? "claude-code" : null)
    || "cli";
  return { kind, sessionId };
}

export function jobHostContext(job) {
  if (job?.host && typeof job.host === "object") {
    const kind = normalizeHostKind(job.host.kind) || "cli";
    const sessionId = typeof job.host.sessionId === "string" && job.host.sessionId ? job.host.sessionId : null;
    return { kind, sessionId };
  }
  return {
    kind: "claude-code",
    sessionId: typeof job?.claudeSessionId === "string" && job.claudeSessionId ? job.claudeSessionId : null
  };
}

export function sameHostSession(job, current) {
  const recorded = jobHostContext(job);
  return Boolean(
    current?.sessionId
    && recorded.sessionId
    && recorded.kind === current.kind
    && recorded.sessionId === current.sessionId
  );
}

export function pluginDataRoot(env = process.env) {
  if (env[PLUGIN_DATA_ENV]) return path.resolve(env[PLUGIN_DATA_ENV]);
  if (env.PLUGIN_DATA) return path.resolve(env.PLUGIN_DATA);
  if (env.CLAUDE_PLUGIN_DATA) return path.resolve(env.CLAUDE_PLUGIN_DATA);
  const current = hostContext(env);
  if (current.kind === "codex") {
    const codexHome = path.resolve(env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex"));
    return path.join(codexHome, "plugins", "data", "grok-grok-companion");
  }
  return path.join(env.HOME || os.homedir(), ".claude", "plugins", "data", "grok");
}

function sessionMetadataPath(dataRoot, sessionId) {
  const digest = crypto.createHash("sha256").update(String(sessionId)).digest("hex");
  return path.join(dataRoot, "host-sessions", `${digest}.json`);
}

function atomicJson(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}

export function writeCodexSessionMetadata(dataRoot, { sessionId, transcriptPath, cwd }) {
  if (!sessionId || !transcriptPath) return null;
  const record = {
    schemaVersion: 1,
    host: "codex",
    sessionId,
    transcriptPath,
    cwd: cwd || null,
    updatedAt: new Date().toISOString()
  };
  const file = sessionMetadataPath(dataRoot, sessionId);
  atomicJson(file, record);
  return file;
}

export function readCodexSessionMetadata(dataRoot, sessionId) {
  if (!sessionId) return null;
  try {
    const value = JSON.parse(fs.readFileSync(sessionMetadataPath(dataRoot, sessionId), "utf8"));
    if (value?.host !== "codex" || value.sessionId !== sessionId || typeof value.transcriptPath !== "string") return null;
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return null;
  }
}

export function hostCommand(command, args = "", env = process.env) {
  const suffix = args ? ` ${args}` : "";
  return hostContext(env).kind === "codex" ? `$grok:${command}${suffix}` : `/grok:${command}${suffix}`;
}

export const HOST_ENVIRONMENT_KEYS = Object.freeze([
  HOST_ENV,
  HOST_SESSION_ENV,
  LEGACY_CLAUDE_SESSION_ENV,
  PLUGIN_DATA_ENV,
  "CODEX_THREAD_ID",
  "CODEX_HOME",
  "PLUGIN_DATA",
  "CLAUDE_PLUGIN_DATA"
]);
