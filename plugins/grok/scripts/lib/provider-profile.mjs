import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { CompanionError } from "./errors.mjs";
import { redactText } from "./redact.mjs";
import {
  atomicPrivateFile,
  privateDirectory
} from "./provider-credentials.mjs";
import { safeMarker } from "./provider-core.mjs";
import {
  WORKTREE_CLEANUP_CONTROLLER_PROFILE_ID,
  WORKTREE_CONTROLLER_PROFILE_ID,
  WORKTREE_INTEGRATION_CONTROLLER_PROFILE_ID
} from "./provider-worktree-contract.mjs";

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

export function inspectIsolation(binary, root, environment) {
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

export function checkedInAgentProfile(profile) {
  if (profile?.id === "rescue-read-v3") return path.join(PLUGIN_ROOT, "provider-agents", "rescue-read.md");
  if (profile?.id === "rescue-write-v3") return path.join(PLUGIN_ROOT, "provider-agents", "rescue-write.md");
  if (profile?.id === "rescue-report-v3") return path.join(PLUGIN_ROOT, "provider-agents", "report-repair.md");
  if (profile?.id === "setup-probe-v2") return path.join(PLUGIN_ROOT, "provider-agents", "setup-probe.md");
  if (profile?.id === "deep-research-v1") return path.join(PLUGIN_ROOT, "provider-agents", "deep-research.md");
  if (profile?.id === "deep-research-workspace-v1") {
    return path.join(PLUGIN_ROOT, "provider-agents", "deep-research-workspace.md");
  }
  return null;
}

/**
 * Verify the packaged profile, then materialize it inside the isolated Grok
 * home. Grok's own filesystem boundary may reject Codex's plugin cache even
 * though the host process can read it, so provider argv must not point back to
 * the installation tree.
 */
export function materializeAgentProfile(profile, environment) {
  const source = checkedInAgentProfile(profile);
  if (!source) return { path: null, cleanup() {} };
  const contents = fs.readFileSync(source);
  const expectedDigest = profile.agentProfileDigest;
  const actualDigest = crypto.createHash("sha256").update(contents).digest("hex");
  if (!expectedDigest || expectedDigest !== actualDigest) {
    const label = profile.id === "setup-probe-v2"
      ? "setup probe"
      : (profile.id === "deep-research-v1" || profile.id === "deep-research-workspace-v1")
        ? "deep-research job"
        : "rescue task";
    throw new CompanionError("E_SECURITY_PROFILE", `The checked-in Grok agent profile changed; start a fresh ${label} under the current security contract.`);
  }
  if (!environment?.grokHome) {
    throw new CompanionError("E_SECURITY_PROFILE", "A checked-in Grok agent profile requires an isolated GROK_HOME; refusing to expose a source or plugin-cache path to the provider.");
  }

  privateDirectory(environment.grokHome);
  const directory = path.join(environment.grokHome, "agent-profiles");
  privateDirectory(directory);
  const destination = path.join(directory, `${safeMarker(profile.id)}-${expectedDigest}-${crypto.randomBytes(8).toString("hex")}.md`);
  try {
    atomicPrivateFile(destination, contents);
    const stat = fs.lstatSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new CompanionError("E_SECURITY_PROFILE", "The isolated Grok agent profile is not a private regular file.");
    }
    const materializedDigest = crypto.createHash("sha256").update(fs.readFileSync(destination)).digest("hex");
    if (materializedDigest !== expectedDigest) {
      throw new CompanionError("E_SECURITY_PROFILE", "The isolated Grok agent profile does not match the checked-in security contract.");
    }
  } catch (error) {
    try { fs.unlinkSync(destination); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") throw cleanupError; }
    throw error;
  }
  let cleaned = false;
  return {
    path: destination,
    cleanup() {
      if (cleaned) return;
      try { fs.unlinkSync(destination); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      try { fs.rmdirSync(directory); }
      catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; }
      cleaned = true;
    }
  };
}
export function spawnArgs({ root, profile, model, effort, leaderSocket, taskProfile = null }) {
  const readOnlyProfile = profile.id === "rescue-read-v3" || profile.id === "rescue-report-v3" || profile.id === "setup-probe-v2";
  const deepResearchProfile = profile.id === "deep-research-v1"
    || profile.id === "deep-research-workspace-v1";
  const deepResearchWorkspace = profile.id === "deep-research-workspace-v1";
  const args = ["--cwd", root, "--sandbox", profile.sandbox, "--permission-mode", profile.permissionMode, "--deny", "WebFetch", "--deny", "MCPTool", "--disable-web-search", "--no-subagents", "--no-memory", "--no-plan"];
  if (deepResearchProfile) {
    // Preserve the long-standing base inventory above for fixture pinning,
    // then replace its network/subagent denials with the research-only set.
    args.length = 6;
    const researchTools = profile.providerToolIds.map((toolId) => {
      if (typeof toolId !== "string" || !toolId.startsWith("GrokBuild:")) {
        throw new CompanionError(
          "E_SECURITY_PROFILE",
          "Deep-research provider tools must use exact GrokBuild tool identifiers."
        );
      }
      return toolId.slice("GrokBuild:".length);
    });
    args.push(
      "--tools", researchTools.join(","),
      "--deny", "WebFetch",
      "--deny", "MCPTool",
      "--deny", "Bash",
      "--deny", "Edit",
      "--deny", "Write",
      "--no-memory",
      "--no-plan"
    );
  }
  if (profile.id === WORKTREE_CONTROLLER_PROFILE_ID
    || profile.id === WORKTREE_INTEGRATION_CONTROLLER_PROFILE_ID
    || profile.id === WORKTREE_CLEANUP_CONTROLLER_PROFILE_ID) {
    args.push(
      "--deny", "Bash",
      "--deny", "Edit",
      "--deny", "Write",
      "--deny", "Read",
      "--deny", "Grep",
      "--deny", "WebSearch"
    );
  } else if (deepResearchProfile) {
    // Web-only must not expose repository read tools; workspace mode may read
    // only the temporary tracked snapshot (cwd), never write or shell.
    if (!deepResearchWorkspace) {
      args.push("--deny", "Read", "--deny", "Grep");
    }
  } else if (readOnlyProfile) args.push("--deny", "Bash", "--deny", "Edit", "--deny", "Write");
  else if (profile.id === "rescue-write-v3") args.push("--deny", "Bash");
  // Setup probe uses permissionMode dontAsk, so it never receives unattended --always-approve expansion.
  if (profile.permissionMode === "bypassPermissions") args.push("--always-approve");
  args.push("agent", "--no-leader", "--leader-socket", leaderSocket);
  if (taskProfile) args.push("--agent-profile", taskProfile);
  if (model) args.push("--model", model);
  if (effort) args.push("--reasoning-effort", effort);
  args.push("stdio");
  return args;
}

export function workerOwnerControllerSpawnArgs({
  environment,
  leaderSocket
} = {}) {
  if (!environment
    || ![
      WORKTREE_INTEGRATION_CONTROLLER_PROFILE_ID,
      WORKTREE_CLEANUP_CONTROLLER_PROFILE_ID
    ].includes(environment.profileId)
    || typeof environment.controllerCwd !== "string"
    || !path.isAbsolute(environment.controllerCwd)
    || typeof environment.sandboxProfile !== "string"
    || !environment.sandboxProfile
    || typeof leaderSocket !== "string"
    || !path.isAbsolute(leaderSocket)) {
    throw new CompanionError(
      "E_SECURITY_PROFILE",
      "Worker owner-controller runtime profile is malformed."
    );
  }
  return Object.freeze(spawnArgs({
    root: environment.controllerCwd,
    profile: {
      id: environment.profileId,
      sandbox: environment.sandboxProfile,
      permissionMode: "dontAsk"
    },
    model: null,
    effort: null,
    leaderSocket,
    taskProfile: null
  }));
}
