import fs from "node:fs";
import path from "node:path";

const HOME_MARKER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

const SESSION_ISOLATION_ENV = Object.freeze({
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
  GROK_MCP_AUTO_RESTART: "false"
});

function canonicalPlainDirectory(candidate) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
    throw new TypeError("Session boundary directory must be absolute.");
  }
  const stat = fs.lstatSync(candidate, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError("Session boundary directory must be a plain directory.");
  }
  if ((stat.mode & 0o077n) !== 0n) {
    throw new TypeError("Session boundary directory must be private.");
  }
  if (
    typeof process.getuid === "function"
    && stat.uid !== BigInt(process.getuid())
  ) {
    throw new TypeError("Session boundary directory has an unexpected owner.");
  }
  return Object.freeze({
    path: fs.realpathSync(candidate),
    device: String(stat.dev),
    inode: String(stat.ino)
  });
}

function directPlainChild(parent, name) {
  const candidate = path.join(parent.path, name);
  const canonical = canonicalPlainDirectory(candidate);
  if (
    canonical.path !== candidate
    || path.dirname(canonical.path) !== parent.path
  ) {
    throw new TypeError("Session boundary directory escaped its exact parent.");
  }
  return canonical;
}

/**
 * Bind qualification-only session commands to the exact isolated provider home.
 * This function is read-only: it refuses missing, linked, or remapped directories
 * and never recreates task credentials or runtime configuration.
 */
export function bindInstalledWorkerSessionBoundary({
  stateDirectory,
  homeMarker,
  childEnvironment
}) {
  if (
    typeof homeMarker !== "string"
    || !HOME_MARKER.test(homeMarker)
    || typeof childEnvironment !== "function"
  ) {
    throw new TypeError("Invalid installed worker session boundary.");
  }

  const stateRoot = canonicalPlainDirectory(stateDirectory);
  const taskHomes = directPlainChild(stateRoot, "task-homes");
  const home = directPlainChild(taskHomes, homeMarker);
  const grokHome = directPlainChild(home, ".grok");
  const inherited = childEnvironment();
  if (!inherited || typeof inherited !== "object" || Array.isArray(inherited)) {
    throw new TypeError("Provider child environment was invalid.");
  }
  const env = {
    ...inherited,
    ...SESSION_ISOLATION_ENV,
    HOME: home.path,
    USERPROFILE: home.path,
    GROK_HOME: grokHome.path,
    GROK_FOLDER_TRUST: "1",
    NO_COLOR: "1"
  };
  delete env.GROK_AUTH_PATH;
  delete env.HOMEDRIVE;
  delete env.HOMEPATH;

  return Object.freeze({
    stateDirectory: stateRoot.path,
    homeMarker,
    home: home.path,
    grokHome: grokHome.path,
    directoryIdentity: Object.freeze({
      stateDirectory: stateRoot,
      taskHomes,
      home,
      grokHome
    }),
    authFile: path.join(grokHome.path, "auth.json"),
    env: Object.freeze(env)
  });
}
