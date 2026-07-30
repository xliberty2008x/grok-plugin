/**
 * First-class Grok /deep-research v1 helpers and dedicated ACP runner.
 *
 * Branches before TaskEnvelope, WorkerReport repair, mailbox, rescue resume,
 * and record-verification. Does not invoke arbitrary Grok plugins.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  isCancelledPromptStopReason,
  isSuccessfulPromptStopReason
} from "./acp-client.mjs";
import { CompanionError } from "./errors.mjs";
import {
  assertProviderPlatform,
  childEnvironment,
  discoverGrok,
  ensureChildExit,
  inspectIsolation,
  openProvider,
  processStartToken
} from "./grok-provider.mjs";
import { hostCommand } from "./host.mjs";
import { integritySnapshot, assertUnchanged } from "./git-review.mjs";
import { redactText } from "./redact.mjs";
import { git } from "./workspace.mjs";
import { processGroupGone } from "./process-control.mjs";
import { captureExecutableFileIdentity } from "./executable-identity.mjs";
import { resolveProviderExecutablePin } from "./provider-executable-pin.mjs";

export const DEEP_RESEARCH_KIND = "deep-research";
export const DEEP_RESEARCH_PROFILE_ID = "deep-research-v1";
export const DEEP_RESEARCH_WORKSPACE_PROFILE_ID = "deep-research-workspace-v1";
export const DEEP_RESEARCH_QUERY_LIMIT_BYTES = 32 * 1024;
export const DEEP_RESEARCH_REPORT_LIMIT_BYTES = 512 * 1024;
export const DEEP_RESEARCH_TIMEOUT_MS = 30 * 60 * 1000;
export const DEEP_RESEARCH_MAX_ACTIVE_AGENTS = 4;
export const DEEP_RESEARCH_MAX_AGENT_LAUNCHES = 8;
export const DEEP_RESEARCH_CANCEL_GRACE_MS = 10_000;
export const DEEP_RESEARCH_COMMAND = "/deep-research";
export const DEEP_RESEARCH_STOP_COMMAND = "/workflow stop";
const DEEP_RESEARCH_ADVERTISED_COMMAND = "deep-research";
const WORKFLOW_ADVERTISED_COMMAND = "workflow";
const WORKFLOW_ADVERTISED_TOOL = "workflow";
const CAPABILITY_EVIDENCE_SOURCES = new Set([
  "session-available-commands-update",
  "same-session-commands-list"
]);
const MAX_PENDING_CAPABILITY_UPDATES = 16;
const MAX_ADVERTISED_COMMANDS = 128;
const MAX_ADVERTISED_TOOLS = 256;
const MAX_ADVERTISED_NAME_LENGTH = 256;
const MAX_CAPABILITY_SESSION_ID_LENGTH = 256;

const SNAPSHOT_EXCLUDES = new Set([
  ".git",
  ".grok",
  ".agents",
  ".claude",
  ".cursor",
  ".codex"
]);

const TERMINAL_WORKFLOW_STATES = new Set([
  "complete",
  "completed",
  "cancelled",
  "failed",
  "interrupted",
  "paused",
  "user_paused",
  "back_off_paused",
  "no_progress_paused",
  "infra_paused",
  "blocked",
  "budget_limited",
  "budget-limited"
]);

function safeMarker(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
}

function sameExecutableFileIdentity(left, right) {
  return Boolean(
    left
    && right
    && left.canonicalPath === right.canonicalPath
    && left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.executableDigest === right.executableDigest
  );
}

export function buildDeepResearchCapabilityReceipt({
  executableIdentity,
  providerVersion,
  profileDigest,
  availableCommands,
  availableTools,
  evidenceSource,
  sessionId
} = {}) {
  if (!executableIdentity?.executableDigest || typeof providerVersion !== "string") {
    throw new CompanionError("E_PROCESS_IDENTITY", "Deep-research capability receipt requires an exact provider identity.");
  }
  const commands = [...new Set((availableCommands || []).map(String))].sort();
  const tools = [...new Set((availableTools || []).map(String))].sort();
  if (!CAPABILITY_EVIDENCE_SOURCES.has(evidenceSource)
    || typeof sessionId !== "string"
    || !sessionId) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Deep-research capability receipt requires exact same-session evidence."
    );
  }
  assertDeepResearchCapability({
    commands: commands.map((name) => ({ name })),
    tools
  }, {
    evidenceSource
  });
  const body = {
    schemaVersion: 2,
    receiptType: "grok-deep-research-capability",
    providerVersion,
    executableDigest: executableIdentity.executableDigest,
    executableSize: executableIdentity.size,
    profileDigest: typeof profileDigest === "string" ? profileDigest : null,
    availableCommands: commands,
    availableTools: tools,
    evidenceSource,
    sessionBindingDigest: crypto
      .createHash("sha256")
      .update(`grok-companion:deep-research:session-binding:v1\0${sessionId}`)
      .digest("hex"),
    deepResearchCommand: commands.includes(DEEP_RESEARCH_ADVERTISED_COMMAND),
    workflowCommand: commands.includes(WORKFLOW_ADVERTISED_COMMAND),
    workflowToolAttested: tools.includes(WORKFLOW_ADVERTISED_TOOL)
  };
  const capabilityDigest = crypto
    .createHash("sha256")
    .update(JSON.stringify(body))
    .digest("hex");
  return Object.freeze({
    ...body,
    capabilityDigest,
    issuedAt: new Date().toISOString()
  });
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CompanionError("E_STATE", "Refusing unsafe deep-research directory.");
  }
  fs.chmodSync(directory, 0o700);
}

function atomicPrivateFile(file, contents) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function isValidUtf8(buffer) {
  try {
    return Buffer.from(buffer.toString("utf8"), "utf8").equals(buffer);
  } catch {
    return false;
  }
}

function isPrivateOrLocalUrl(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return false;
  if (
    text.startsWith("file:")
    || text.startsWith("unix:")
    || text.includes("localhost")
    || text.includes("127.0.0.1")
    || text.includes("[::1]")
    || text.includes("0.0.0.0")
  ) return true;
  if (/\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(text)) return true;
  if (/\b192\.168\.\d{1,3}\.\d{1,3}\b/.test(text)) return true;
  if (/\b172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}\b/.test(text)) return true;
  if (/\b169\.254\.\d{1,3}\.\d{1,3}\b/.test(text)) return true;
  return false;
}

/**
 * Parse CLI options for deep-research. Defaults: background + web-only.
 */
export function parseDeepResearchOptions(options = {}) {
  const wait = Boolean(options.wait);
  const background = Boolean(options.background) || !wait;
  if (wait && options.background) {
    throw new CompanionError("E_USAGE", "Choose --wait or --background.");
  }
  const workspace = Boolean(options.workspace);
  const webOnly = options["web-only"] === true || (!workspace && options["web-only"] !== false);
  if (workspace && options["web-only"] === true) {
    throw new CompanionError("E_USAGE", "Choose --workspace or --web-only.");
  }
  const model = typeof options.model === "string" && options.model ? options.model : null;
  const effort = typeof options.effort === "string" && options.effort ? options.effort : null;
  if (effort && !["low", "medium", "high"].includes(effort)) {
    throw new CompanionError("E_USAGE", "--effort must be low, medium, or high.");
  }
  return Object.freeze({
    background,
    wait,
    webOnly: workspace ? false : webOnly,
    workspace,
    model,
    effort
  });
}

/**
 * Private query ingress: reject NUL, empty, and >32 KiB.
 */
export function parseDeepResearchQuery(raw, {
  limitBytes = DEEP_RESEARCH_QUERY_LIMIT_BYTES
} = {}) {
  if (raw == null) {
    throw new CompanionError("E_USAGE", "Deep-research query is required on private stdin.");
  }
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "utf8");
  if (buffer.includes(0)) {
    throw new CompanionError("E_USAGE", "Deep-research query must not contain NUL bytes.");
  }
  if (buffer.byteLength > limitBytes) {
    throw new CompanionError(
      "E_USAGE",
      `Deep-research query exceeds the ${Math.ceil(limitBytes / 1024)} KiB limit.`
    );
  }
  if (!isValidUtf8(buffer)) {
    throw new CompanionError("E_USAGE", "Deep-research query must be valid UTF-8.");
  }
  const query = buffer.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!query) {
    throw new CompanionError("E_USAGE", "Deep-research query must not be empty.");
  }
  return query;
}

export function stageDeepResearchQuery(stateDir, jobId, query) {
  const parsed = parseDeepResearchQuery(query);
  const directory = path.join(stateDir, "research-queries");
  privateDirectory(directory);
  atomicPrivateFile(
    path.join(directory, `${safeMarker(jobId)}.txt`),
    Buffer.from(parsed, "utf8")
  );
  return Object.freeze({
    digest: crypto.createHash("sha256").update(parsed).digest("hex"),
    bytes: Buffer.byteLength(parsed)
  });
}

export function consumeDeepResearchQuery(stateDir, jobId, expectedDigest) {
  const directory = path.join(stateDir, "research-queries");
  const file = path.join(directory, `${safeMarker(jobId)}.txt`);
  let descriptor;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new CompanionError("E_SECURITY_PROFILE", "Deep-research query staging file is unsafe.");
    }
    if (stat.size > DEEP_RESEARCH_QUERY_LIMIT_BYTES) {
      throw new CompanionError("E_USAGE", "Deep-research query exceeds the 32 KiB limit.");
    }
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const query = parseDeepResearchQuery(fs.readFileSync(descriptor));
    const digest = crypto.createHash("sha256").update(query).digest("hex");
    if (typeof expectedDigest !== "string" || digest !== expectedDigest) {
      throw new CompanionError("E_SECURITY_PROFILE", "Deep-research query digest mismatch.");
    }
    fs.unlinkSync(file);
    return query;
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

/**
 * Upstream slash text is exactly `/deep-research <query>`.
 * Wrapper flags (--background/--web-only/--workspace/--model/--effort) affect
 * only companion/provider behavior and MUST NOT be forwarded upstream.
 */
export function buildDeepResearchSlashCommand(query) {
  const text = String(query ?? "").trim();
  if (!text) {
    throw new CompanionError("E_USAGE", "Deep-research slash command requires a non-empty query.");
  }
  return `${DEEP_RESEARCH_COMMAND} ${text}`;
}

/**
 * Exact cancellation slash text for a bound workflow run.
 */
export function buildWorkflowStopSlashCommand(runId) {
  if (typeof runId !== "string" || !runId || runId.includes("\0") || runId.includes("..") || /\s/.test(runId)) {
    throw new CompanionError("E_PROTOCOL", "Deep-research stop requires an exact bound run ID.");
  }
  return `${DEEP_RESEARCH_STOP_COMMAND} ${runId}`;
}

/**
 * Extract advertised command names from session-scoped payloads
 * (available_commands_update or x.ai/commands/list results).
 */
export function extractAvailableCommandNames(source) {
  if (!source) return [];
  const bags = [];
  if (Array.isArray(source)) bags.push(source);
  else if (typeof source === "object") {
    for (const key of [
      "availableCommands",
      "commands",
      "available_commands",
      "commandList"
    ]) {
      if (Array.isArray(source[key])) bags.push(source[key]);
    }
    if (source.update && typeof source.update === "object") {
      bags.push(...extractAvailableCommandNames(source.update).map((name) => ({ name })));
    }
    if (source._meta && typeof source._meta === "object") {
      bags.push(...extractAvailableCommandNames(source._meta).map((name) => ({ name })));
    }
    if (Array.isArray(source.result?.availableCommands)) bags.push(source.result.availableCommands);
    if (Array.isArray(source.result?.commands)) bags.push(source.result.commands);
  }
  const names = [];
  for (const bag of bags) {
    for (const item of bag) {
      if (typeof item === "string" && item) names.push(item);
      else if (item && typeof item === "object") {
        const name = item.name || item.command || item.id || "";
        if (name) names.push(String(name));
      }
    }
  }
  return [...new Set(names)];
}

export function isAvailableCommandsUpdate(update) {
  if (!update || typeof update !== "object") return false;
  return update.sessionUpdate === "available_commands_update";
}

function compactCapabilityAdvertisement(commands, tools) {
  if ((Array.isArray(commands) && commands.length > MAX_ADVERTISED_COMMANDS)
    || (Array.isArray(tools) && tools.length > MAX_ADVERTISED_TOOLS)) {
    throw new CompanionError(
      "E_PROTOCOL",
      "Deep-research capability advertisement exceeds bounded entry limits."
    );
  }
  const compactCommands = Array.isArray(commands)
    ? commands.map((item) => {
        const name = item && typeof item === "object" && !Array.isArray(item)
          ? item.name
          : null;
        if (typeof name === "string" && name.length > MAX_ADVERTISED_NAME_LENGTH) {
          throw new CompanionError(
            "E_PROTOCOL",
            "Deep-research advertised command name exceeds the bounded limit."
          );
        }
        return { name };
      })
    : null;
  const compactTools = Array.isArray(tools)
    ? tools.map((item) => {
        if (typeof item === "string" && item.length > MAX_ADVERTISED_NAME_LENGTH) {
          throw new CompanionError(
            "E_PROTOCOL",
            "Deep-research advertised tool name exceeds the bounded limit."
          );
        }
        return typeof item === "string" ? item : null;
      })
    : null;
  return Object.freeze({
    commands: compactCommands,
    tools: compactTools
  });
}

/**
 * Require one paired, live advertisement containing exact command and tool
 * names. The caller owns the same-session transport binding; this function
 * deliberately does not merge split payloads or inspect initialize data.
 */
export function assertDeepResearchCapability(advertisement, {
  evidenceSource = null
} = {}) {
  const missing = [];
  const commands = advertisement?.commands;
  const tools = advertisement?.tools;
  const commandsMalformed = !Array.isArray(commands)
    || commands.length === 0
    || commands.some((item) => (
      !item
      || typeof item !== "object"
      || Array.isArray(item)
      || !Object.hasOwn(item, "name")
      || typeof item.name !== "string"
      || !item.name
      || item.name.trim() !== item.name
    ));
  const toolsMalformed = !Array.isArray(tools)
    || tools.length === 0
    || tools.some((item) => (
      typeof item !== "string"
      || !item
      || item.trim() !== item
    ));
  const commandNames = commandsMalformed
    ? []
    : [...new Set(commands.map((item) => item.name))];
  const toolNames = toolsMalformed
    ? []
    : [...new Set(tools)];
  const hasDeepResearchCommand = commandNames.includes(
    DEEP_RESEARCH_ADVERTISED_COMMAND
  );
  if (!hasDeepResearchCommand) missing.push("command:/deep-research");
  const hasWorkflowCommand = commandNames.includes(
    WORKFLOW_ADVERTISED_COMMAND
  );
  if (!hasWorkflowCommand) missing.push("command:/workflow");
  const hasWorkflow = toolNames.includes(WORKFLOW_ADVERTISED_TOOL);
  if (!hasWorkflow) missing.push("tool:workflow");
  const evidenceSourceValid = CAPABILITY_EVIDENCE_SOURCES.has(evidenceSource);
  if (!evidenceSourceValid) missing.push("evidence:same-session");

  if (missing.length) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Installed Grok does not advertise the exact live deep-research command and workflow tool required for this feature.",
      {
        missing,
        malformed: {
          commands: commandsMalformed,
          tools: toolsMalformed
        },
        available: commandNames.slice(0, 32),
        availableTools: toolNames.slice(0, 64)
      }
    );
  }
  return Object.freeze({
    deepResearchCommand: true,
    workflowCommand: true,
    workflowTool: true,
    availableCommands: commandNames,
    availableTools: toolNames,
    evidenceSource
  });
}

/**
 * Create a workflow run binder that accepts only one unseen deep-research run
 * and only monotonically increasing revisions for that run.
 */
export function createWorkflowBinder({
  expectedName = "deep-research",
  expectedObjective = null
} = {}) {
  const state = {
    armed: false,
    runId: null,
    revision: -1,
    status: null,
    activeAgents: null,
    activeAgentsObserved: false,
    agentLaunches: 0,
    reportedAgentLaunches: 0,
    toolAgentLaunches: 0,
    phases: [],
    currentPhase: null,
    elapsedMs: 0,
    agentsUsed: 0,
    agentBudget: null,
    usageIncomplete: false,
    pauseMessage: null,
    cancelAcceptedRevision: null,
    reportStatus: null,
    settled: false
  };

  function observeAgentActivity(update) {
    const activeValue = update?.activeAgents
      ?? update?.active_agents
      ?? update?.agentsActive
      ?? update?.workflow?.activeAgents;
    const active = Number(activeValue);
    if (activeValue != null && Number.isFinite(active) && active >= 0) {
      if (active > DEEP_RESEARCH_MAX_ACTIVE_AGENTS) {
        throw new CompanionError(
          "E_SECURITY_PROFILE",
          `Deep-research exceeded the maximum of ${DEEP_RESEARCH_MAX_ACTIVE_AGENTS} active agents.`
        );
      }
      state.activeAgents = active;
      state.activeAgentsObserved = true;
    }
    const launches = Number(
      update?.agentLaunches
      ?? update?.agent_launches
      ?? update?.workflow?.agentLaunches
      ?? state.agentLaunches
    );
    if (Number.isFinite(launches) && launches >= 0) {
      if (launches > DEEP_RESEARCH_MAX_AGENT_LAUNCHES) {
        throw new CompanionError(
          "E_SECURITY_PROFILE",
          `Deep-research exceeded the maximum of ${DEEP_RESEARCH_MAX_AGENT_LAUNCHES} agent launches.`
        );
      }
      state.reportedAgentLaunches = Math.max(state.reportedAgentLaunches, launches);
      state.agentLaunches = Math.max(
        state.reportedAgentLaunches,
        state.toolAgentLaunches
      );
    }
    if (Array.isArray(update?.phases)) state.phases = update.phases;
    if (typeof update?.currentPhase === "string") state.currentPhase = update.currentPhase;
    if (Number.isFinite(update?.elapsedMs) && update.elapsedMs >= 0) state.elapsedMs = update.elapsedMs;
    if (Number.isFinite(update?.agentsUsed) && update.agentsUsed >= 0) state.agentsUsed = update.agentsUsed;
    if (Number.isFinite(update?.agentBudget) && update.agentBudget >= 0) {
      state.agentBudget = update.agentBudget;
    }
    if (typeof update?.usageIncomplete === "boolean") {
      state.usageIncomplete = update.usageIncomplete;
    }
    if (typeof update?.pauseMessage === "string") state.pauseMessage = update.pauseMessage;
  }

  return {
    get state() {
      return Object.freeze({ ...state });
    },
    arm() {
      state.armed = true;
      return Object.freeze({ ...state });
    },
    noteAgentLaunch() {
      state.toolAgentLaunches += 1;
      state.agentLaunches = Math.max(
        state.reportedAgentLaunches,
        state.toolAgentLaunches
      );
      if (state.agentLaunches > DEEP_RESEARCH_MAX_AGENT_LAUNCHES) {
        throw new CompanionError(
          "E_SECURITY_PROFILE",
          `Deep-research exceeded the maximum of ${DEEP_RESEARCH_MAX_AGENT_LAUNCHES} agent launches.`
        );
      }
      return Object.freeze({ ...state });
    },
    applyUpdate(rawUpdate) {
      const update = normalizeWorkflowUpdate(rawUpdate);
      if (!update) return null;
      if (update.kind && update.kind !== "deep-research" && update.kind !== "workflow") {
        // Ignore unrelated workflow families.
        if (update.kind !== DEEP_RESEARCH_KIND) return null;
      }
      if (!state.runId) {
        if (!state.armed || !update.runId) return null;
        if (!Number.isSafeInteger(update.revision) || update.revision < 0) return null;
        if (update.name !== expectedName) return null;
        if (expectedObjective !== null && update.objective !== expectedObjective) return null;
        observeAgentActivity(update);
        state.runId = update.runId;
        state.revision = update.revision;
        state.status = update.status || "running";
        state.reportStatus = update.reportStatus;
        if (state.status === "cancelled") state.cancelAcceptedRevision = state.revision;
        state.settled = state.status === "cancelled"
          ? false
          : isSettledWorkflowStatus(state.status) && update.activeAgents === 0;
        return Object.freeze({ ...state, accepted: true, bound: true });
      }
      if (update.runId && update.runId !== state.runId) {
        return Object.freeze({ ...state, accepted: false, bound: true, ignored: "foreign-run" });
      }
      if (!Number.isSafeInteger(update.revision) || update.revision <= state.revision) {
        return Object.freeze({ ...state, accepted: false, bound: true, ignored: "stale-revision" });
      }
      observeAgentActivity(update);
      state.revision = update.revision;
      if (update.status) state.status = update.status;
      if (update.reportStatus) state.reportStatus = update.reportStatus;
      if (state.status === "cancelled" && state.cancelAcceptedRevision === null) {
        state.cancelAcceptedRevision = state.revision;
        state.settled = false;
      } else {
        state.settled = isSettledWorkflowStatus(state.status)
          && update.activeAgents === 0
          && (state.status !== "cancelled" || state.revision > state.cancelAcceptedRevision);
      }
      return Object.freeze({ ...state, accepted: true, bound: true });
    }
  };
}

export function normalizeWorkflowUpdate(value) {
  if (!value || typeof value !== "object") return null;
  // Prefer x.ai/session_notification workflow_updated style payloads.
  const candidates = [
    value.params?.update?.workflow_updated,
    value.params?.workflow_updated,
    value.update?.workflow_updated,
    value.workflow_updated,
    value,
    value.update,
    value.params,
    value.params?.update,
    value.workflow,
    value.payload,
    value._meta,
    value._meta?.workflow_updated,
    value._meta?.workflow
  ].filter((item) => item && typeof item === "object");

  for (const candidate of candidates) {
    const runId = candidate.runId
      || candidate.run_id
      || candidate.workflowRunId
      || candidate.workflow_run_id
      || candidate.id
      || null;
    const status = candidate.status
      || candidate.state
      || candidate.phase
      || candidate.outcome
      || null;
    const revision = Number(
      candidate.revision
      ?? candidate.rev
      ?? candidate.version
      ?? candidate.sequence
      ?? candidate.seq
    );
    const kind = candidate.kind
      || candidate.workflowKind
      || candidate.workflow_kind
      || candidate.type
      || null;
    const looksLikeWorkflow = Boolean(
      runId
      || status
      || Number.isFinite(revision)
      || /workflow/i.test(String(kind || ""))
      || candidate.workflow_updated
      || candidate.sessionUpdate === "workflow_updated"
      || value.method === "x.ai/session_notification"
    );
    if (!looksLikeWorkflow) continue;
    return Object.freeze({
      runId: typeof runId === "string" && runId ? runId : null,
      status: typeof status === "string" && status ? status.toLowerCase() : null,
      revision: Number.isFinite(revision) ? revision : null,
      kind: typeof kind === "string" ? kind : null,
      activeAgents: Array.isArray(candidate.activeAgents ?? candidate.active_agents)
        ? (candidate.activeAgents ?? candidate.active_agents).length
        : Number.isFinite(Number(candidate.activeAgents ?? candidate.active_agents))
          ? Number(candidate.activeAgents ?? candidate.active_agents)
          : null,
      agentLaunches: Number.isFinite(Number(
        candidate.agentLaunches
        ?? candidate.agent_launches
        ?? candidate.agentsUsed
        ?? candidate.agents_used
      ))
        ? Number(
            candidate.agentLaunches
            ?? candidate.agent_launches
            ?? candidate.agentsUsed
            ?? candidate.agents_used
          )
        : null,
      phases: Array.isArray(candidate.phases) ? candidate.phases : [],
      currentPhase: typeof (candidate.currentPhase ?? candidate.current_phase) === "string"
        ? (candidate.currentPhase ?? candidate.current_phase)
        : null,
      elapsedMs: Number.isFinite(Number(candidate.elapsedMs ?? candidate.elapsed_ms))
        ? Number(candidate.elapsedMs ?? candidate.elapsed_ms)
        : null,
      agentsUsed: Number.isFinite(Number(candidate.agentsUsed ?? candidate.agents_used))
        ? Number(candidate.agentsUsed ?? candidate.agents_used)
        : null,
      agentBudget: Number.isFinite(Number(candidate.agentBudget ?? candidate.agent_budget))
        ? Number(candidate.agentBudget ?? candidate.agent_budget)
        : null,
      usageIncomplete: typeof (candidate.usageIncomplete ?? candidate.agent_usage_incomplete) === "boolean"
        ? (candidate.usageIncomplete ?? candidate.agent_usage_incomplete)
        : null,
      pauseMessage: typeof (candidate.pauseMessage ?? candidate.pause_message) === "string"
        ? (candidate.pauseMessage ?? candidate.pause_message)
        : null,
      name: typeof (candidate.name ?? candidate.workflow_name) === "string"
        ? (candidate.name ?? candidate.workflow_name)
        : null,
      objective: typeof candidate.objective === "string" ? candidate.objective : null,
      reportStatus: ["verified", "partial"].includes(String(
        candidate.reportStatus
        ?? candidate.report_status
        ?? candidate.verificationStatus
        ?? candidate.verification_status
        ?? candidate.assessment
        ?? ""
      ).toLowerCase())
        ? String(
            candidate.reportStatus
            ?? candidate.report_status
            ?? candidate.verificationStatus
            ?? candidate.verification_status
            ?? candidate.assessment
          ).toLowerCase()
        : null
    });
  }
  return null;
}

export function isSettledWorkflowStatus(status) {
  return TERMINAL_WORKFLOW_STATES.has(String(status || "").toLowerCase());
}

/**
 * Map terminal workflow status + artifact validity to job outcome or stable error.
 * Never auto-resumes or replays.
 */
export function mapDeepResearchTerminal({ status, report = null, cancelled = false } = {}) {
  const normalized = String(status || "").toLowerCase();
  if (cancelled || normalized === "cancelled") {
    return Object.freeze({
      jobStatus: "cancelled",
      error: { code: "E_CANCELLED", message: "Deep-research was cancelled." },
      replay: false,
      resume: false
    });
  }
  if (
    normalized === "paused"
    || normalized === "user_paused"
    || normalized === "back_off_paused"
    || normalized === "no_progress_paused"
    || normalized === "infra_paused"
    || normalized === "blocked"
    || normalized === "budget_limited"
    || normalized === "budget-limited"
  ) {
    return Object.freeze({
      jobStatus: "failed",
      error: {
        code: "E_RESEARCH_PAUSED",
        message: "Deep-research paused, blocked, or hit a budget limit; automatic resume is not supported."
      },
      replay: false,
      resume: false
    });
  }
  if (normalized === "failed" || normalized === "interrupted") {
    return Object.freeze({
      jobStatus: "failed",
      error: {
        code: "E_WORKFLOW_INCOMPLETE",
        message: "Deep-research workflow failed or was interrupted before a complete report."
      },
      replay: false,
      resume: false
    });
  }
  if (normalized === "complete" || normalized === "completed") {
    if (report?.valid) {
      return Object.freeze({
        jobStatus: "completed",
        error: null,
        researchStatus: report.status || report.assessment || "verified",
        replay: false,
        resume: false
      });
    }
    return Object.freeze({
      jobStatus: "failed",
      error: {
        code: "E_WORKFLOW_INCOMPLETE",
        message: "Deep-research completed without a valid report artifact."
      },
      replay: false,
      resume: false
    });
  }
  return Object.freeze({
    jobStatus: "failed",
    error: {
      code: "E_WORKFLOW_INCOMPLETE",
      message: `Deep-research ended in unexpected workflow status ${normalized || "unknown"}.`
    },
    replay: false,
    resume: false
  });
}

/**
 * Resolve the exact bound report:
 *   <GROK_HOME>/sessions/<percent-encoded-cwd>/<sessionId>/workflows/<runId>/scratch/report.md
 * Fail closed on missing/ambiguous cwd/session binding, path escape, or symlinks.
 * Never falls back to an unbound GROK_HOME/workflows path.
 */
export function researchReportRelativePath(providerCwd, sessionId, runId) {
  let resolvedCwd = path.resolve(providerCwd);
  try { resolvedCwd = fs.realpathSync(resolvedCwd); } catch { /* validation happens in collector */ }
  const cwdKey = encodeURIComponent(resolvedCwd);
  return path.posix.join("sessions", cwdKey, sessionId, "workflows", runId, "scratch", "report.md");
}

export function collectResearchReport({
  grokHome,
  providerCwd,
  sessionId,
  runId,
  maxBytes = DEEP_RESEARCH_REPORT_LIMIT_BYTES
} = {}) {
  if (typeof runId !== "string" || !runId || runId.includes("\0") || runId.includes("..") || runId.includes("/") || runId.includes("\\")) {
    throw new CompanionError("E_SCHEMA", "Deep-research run ID is invalid for report collection.");
  }
  if (typeof sessionId !== "string" || !sessionId || sessionId.includes("\0") || sessionId.includes("..") || sessionId.includes("/") || sessionId.includes("\\")) {
    throw new CompanionError("E_SCHEMA", "Deep-research report collection requires the exact bound ACP session ID.");
  }
  if (typeof grokHome !== "string" || !path.isAbsolute(grokHome)) {
    throw new CompanionError("E_STATE", "Deep-research report collection requires an isolated GROK_HOME.");
  }
  if (typeof providerCwd !== "string" || !path.isAbsolute(providerCwd)) {
    throw new CompanionError("E_STATE", "Deep-research report collection requires the exact provider cwd.");
  }
  let homeReal;
  let providerCwdReal;
  try {
    homeReal = fs.realpathSync(grokHome);
    providerCwdReal = fs.realpathSync(providerCwd);
  } catch {
    throw new CompanionError("E_STATE", "Deep-research GROK_HOME or provider cwd is not resolvable.");
  }
  const sessionsRoot = path.join(homeReal, "sessions");
  const cwdKey = encodeURIComponent(providerCwdReal);
  const sessionDir = path.join(sessionsRoot, cwdKey, sessionId);
  let sessionReal;
  try {
    const sessionStat = fs.lstatSync(sessionDir);
    if (sessionStat.isSymbolicLink() || !sessionStat.isDirectory()) {
      throw new CompanionError("E_SECURITY_PROFILE", "Deep-research session directory must be a non-symlink directory.");
    }
    sessionReal = fs.realpathSync(sessionDir);
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    if (error?.code === "ENOENT") {
      return Object.freeze({
        valid: false,
        path: researchReportRelativePath(providerCwdReal, sessionId, runId),
        bytes: 0,
        sha256: null,
        markdown: null,
        sourceCount: 0,
        coverageNotes: ["Bound session directory missing for report collection."],
        status: "partial",
        hostVerification: "not_run"
      });
    }
    throw new CompanionError("E_SCHEMA", "Deep-research session directory is unsafe.");
  }
  const sessionRelative = path.relative(homeReal, sessionReal);
  if (
    !sessionRelative
    || sessionRelative.startsWith("..")
    || path.isAbsolute(sessionRelative)
    || sessionRelative.split(path.sep)[0] !== "sessions"
    || sessionRelative.split(path.sep)[1] !== cwdKey
  ) {
    throw new CompanionError("E_SECURITY_PROFILE", "Deep-research session directory escapes its bound GROK_HOME cwd namespace.");
  }

  const relative = researchReportRelativePath(providerCwdReal, sessionId, runId);
  const candidate = path.resolve(sessionReal, "workflows", runId, "scratch", "report.md");
  const relativeToSession = path.relative(sessionReal, candidate);
  const relativeToHome = path.relative(homeReal, candidate);
  if (
    !relativeToSession
    || relativeToSession.startsWith("..")
    || path.isAbsolute(relativeToSession)
    || !relativeToHome
    || relativeToHome.startsWith("..")
    || path.isAbsolute(relativeToHome)
  ) {
    throw new CompanionError("E_SECURITY_PROFILE", "Deep-research report path escapes the bound session directory.");
  }

  let descriptor;
  try {
    // Refuse any symlink in the path components under the session directory.
    let cursor = sessionReal;
    for (const part of ["workflows", runId, "scratch", "report.md"]) {
      cursor = path.join(cursor, part);
      const partStat = fs.lstatSync(cursor);
      if (partStat.isSymbolicLink()) {
        throw new CompanionError("E_SECURITY_PROFILE", "Deep-research report path must not contain symlinks.");
      }
    }
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new CompanionError("E_SCHEMA", "Deep-research report must be a regular file.");
    }
    const pathStat = fs.lstatSync(candidate);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw new CompanionError("E_SECURITY_PROFILE", "Deep-research report path must not be a symlink.");
    }
    if (stat.size > maxBytes) {
      throw new CompanionError(
        "E_OUTPUT_LIMIT",
        `Deep-research report exceeds the ${Math.ceil(maxBytes / 1024)} KiB limit.`,
        { limitBytes: maxBytes }
      );
    }
    const buffer = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== buffer.length) {
      throw new CompanionError("E_SCHEMA", "Deep-research report changed while being read.");
    }
    if (!isValidUtf8(buffer)) {
      throw new CompanionError("E_SCHEMA", "Deep-research report must be valid UTF-8.");
    }
    const text = buffer.toString("utf8");
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    return Object.freeze({
      valid: true,
      path: relative,
      bytes: buffer.byteLength,
      sha256,
      markdown: text,
      sourceCount: countReportSources(text),
      coverageNotes: extractCoverageNotes(text),
      // The report body is untrusted data and cannot self-attest verification.
      // A verified result is accepted only from an explicit provider workflow field.
      status: "partial",
      hostVerification: "not_run",
      sessionId,
      runId
    });
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    if (error?.code === "ENOENT") {
      return Object.freeze({
        valid: false,
        path: relative,
        bytes: 0,
        sha256: null,
        markdown: null,
        sourceCount: 0,
        coverageNotes: ["Report artifact missing."],
        status: "partial",
        hostVerification: "not_run",
        sessionId,
        runId
      });
    }
    throw new CompanionError(
      "E_SCHEMA",
      `Deep-research report could not be collected: ${error?.message || String(error)}`
    );
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function countReportSources(text) {
  const urls = text.match(/https?:\/\/[^\s)\]>]+/gi) || [];
  const citations = text.match(/\[[0-9]{1,3}\]/g) || [];
  return Math.max(urls.length, citations.length);
}

function extractCoverageNotes(text) {
  const notes = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (/coverage|limitation|partial|unable|missing/i.test(line)) {
      notes.push(line.trim().slice(0, 240));
    }
    if (notes.length >= 8) break;
  }
  return notes;
}

/**
 * Attest WebFetch allow_local=false from inspect/config evidence.
 * Returns { ok, reducedCoverage, note }.
 */
export function attestWebFetchAllowLocalFalse({
  inspect = null,
  configText = null
} = {}) {
  const config = typeof configText === "string" ? configText : "";
  const configAttests = /allow_local\s*=\s*false/i.test(config)
    || /allowLocal\s*[:=]\s*false/i.test(config);
  const inspectTools = [
    ...(Array.isArray(inspect?.tools) ? inspect.tools : []),
    ...(Array.isArray(inspect?.webFetch) ? [inspect.webFetch] : []),
    inspect?.features?.webFetch,
    inspect?.config?.webFetch
  ].filter(Boolean);
  const inspectAttests = inspectTools.some((item) => {
    if (item === false) return false;
    if (typeof item === "object") {
      if (item.allow_local === false || item.allowLocal === false) return true;
      if (item.config?.allow_local === false || item.config?.allowLocal === false) return true;
    }
    return false;
  });
  if (configAttests && inspectAttests) {
    return Object.freeze({
      ok: true,
      reducedCoverage: false,
      note: "WebFetch allow_local=false attested."
    });
  }
  return Object.freeze({
    ok: false,
    reducedCoverage: true,
    note: "WebFetch allow_local=false could not be attested; fetch disabled with reduced coverage."
  });
}

export function isUnexpectedDeepResearchPermission(params) {
  if (!params || typeof params !== "object") return true;
  const serialized = JSON.stringify(params).toLowerCase();
  if (isPrivateOrLocalUrl(serialized)) return true;
  // dontAsk research must not surface host permission prompts.
  return true;
}

export function noteAgentLaunchFromToolEvent(update, seen, noteLaunch) {
  if (!(seen instanceof Set) || typeof noteLaunch !== "function") {
    throw new CompanionError("E_STATE", "Agent launch accounting requires a Set and callback.");
  }
  const toolName = String(update?.name || "").trim().toLowerCase();
  if (
    update?.type !== "tool"
    || !["task", "grokbuild:task"].includes(toolName)
  ) {
    return false;
  }
  const toolCallId = typeof update.toolCallId === "string" && update.toolCallId
    ? update.toolCallId
    : null;
  if (toolCallId) {
    if (seen.has(toolCallId)) return false;
    seen.add(toolCallId);
    noteLaunch();
    return true;
  }
  if (update.event === "tool_call") {
    noteLaunch();
    return true;
  }
  return false;
}

/**
 * Empty private cwd for web-only research.
 */
export function createWebOnlyCwd(stateDir, jobId) {
  const cwd = path.join(stateDir, "research-homes", safeMarker(jobId), "cwd-web-only");
  privateDirectory(path.dirname(cwd));
  privateDirectory(cwd);
  return cwd;
}

/**
 * Tracked-files-only read-only snapshot of the real checkout.
 * Excludes untracked/ignored files, symlinks, and sensitive roots.
 * Never mutates the original workspace.
 */
export function createWorkspaceSnapshot(workspaceRoot, stateDir, jobId) {
  const before = integritySnapshot(workspaceRoot);
  const snapshotRoot = path.join(
    stateDir,
    "research-homes",
    safeMarker(jobId),
    "cwd-workspace-snapshot"
  );
  privateDirectory(path.dirname(snapshotRoot));
  if (fs.existsSync(snapshotRoot)) {
    removeResearchTree(snapshotRoot);
  }
  privateDirectory(snapshotRoot);

  const listed = git(workspaceRoot, ["ls-files", "-z"], { allowFailure: false });
  const files = String(listed.stdout || "").split("\0").filter(Boolean);
  let copied = 0;
  for (const relative of files) {
    const normalized = relative.replace(/\\/g, "/");
    const top = normalized.split("/")[0];
    if (SNAPSHOT_EXCLUDES.has(top)) continue;
    if (normalized.split("/").some((part) => SNAPSHOT_EXCLUDES.has(part))) continue;
    const source = path.join(workspaceRoot, relative);
    let stat;
    try {
      stat = fs.lstatSync(source);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    const destination = path.join(snapshotRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, 0o400);
    copied += 1;
  }
  // Freeze directories after copy.
  freezeTreeReadOnly(snapshotRoot);
  const after = integritySnapshot(workspaceRoot);
  assertUnchanged(before, after);
  return Object.freeze({
    cwd: snapshotRoot,
    fileCount: copied,
    workspaceUnchanged: true,
    before,
    after
  });
}

function freezeTreeReadOnly(root) {
  const walk = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        try { fs.chmodSync(full, 0o500); } catch { /* best effort */ }
      } else if (entry.isFile()) {
        try { fs.chmodSync(full, 0o400); } catch { /* best effort */ }
      }
    }
  };
  walk(root);
  try { fs.chmodSync(root, 0o500); } catch { /* best effort */ }
}

/** Thaw a frozen snapshot tree so recursive removal cannot fail ENOTEMPTY on RO dirs. */
export function thawTreeWritable(root) {
  if (!root || !fs.existsSync(root)) return;
  const walk = (directory) => {
    try { fs.chmodSync(directory, 0o700); } catch { /* best effort */ }
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try { fs.chmodSync(full, 0o600); } catch { /* best effort */ }
      }
    }
  };
  walk(root);
}

export function removeResearchTree(root) {
  if (!root || !fs.existsSync(root)) return;
  thawTreeWritable(root);
  fs.rmSync(root, { recursive: true, force: true });
}

export function proveWorkspaceUnchanged(workspaceRoot, before) {
  const after = integritySnapshot(workspaceRoot);
  assertUnchanged(before, after);
  return after;
}

/**
 * Isolated deep-research provider environment.
 * Enables public web + built-in subagents; disables shell/writes/MCP/memory/plan/plugins.
 */
export function researchEnvironment(stateDir, jobMarker, {
  providerExecutableBinary = null,
  webFetchAllowLocal = false
} = {}) {
  assertProviderPlatform();
  const lineage = safeMarker(jobMarker);
  const home = path.join(stateDir, "research-homes", lineage);
  const grokHome = path.join(home, ".grok");
  privateDirectory(home);
  privateDirectory(grokHome);

  atomicPrivateFile(
    path.join(grokHome, "config.toml"),
    [
      "[skills]",
      `ignore = [${JSON.stringify(home)}]`,
      "",
      "[subagents]",
      "enabled = true",
      "",
      "[workflows]",
      "enabled = true",
      "",
      "[features]",
      "lsp_tools = false",
      "",
      "[tools.web_fetch]",
      `allow_local = ${webFetchAllowLocal ? "true" : "false"}`,
      "",
      "[plugins]",
      "enabled = []",
      "",
      "[hooks]",
      "enabled = false",
      "",
      "[memory]",
      "enabled = false",
      "",
      "[plan]",
      "enabled = false",
      ""
    ].join("\n")
  );

  const sandboxProfile = `companion_research_${crypto.createHash("sha256").update(lineage).digest("hex").slice(0, 20)}`;
  // Network permitted for public web research; filesystem remains strict-derived.
  atomicPrivateFile(
    path.join(grokHome, "sandbox.toml"),
    [
      `[profiles.${sandboxProfile}]`,
      'extends = "strict"',
      "restrict_network = false",
      ""
    ].join("\n")
  );

  const authPath = process.env.GROK_AUTH_PATH || path.join(os.homedir(), ".grok", "auth.json");
  if (!fs.existsSync(authPath)) {
    throw new CompanionError(
      "E_AUTH_REQUIRED",
      `Grok cached authentication is unavailable. Run \`grok login\`, then ${hostCommand("setup")}.`
    );
  }
  const authDestination = path.join(grokHome, "auth.json");
  const authContents = fs.readFileSync(authPath);
  atomicPrivateFile(authDestination, authContents);
  let knownSecrets = [];
  try {
    const parsed = JSON.parse(authContents.toString("utf8"));
    const key = Object.values(parsed || {}).find((entry) => (
      entry && typeof entry === "object" && typeof entry.key === "string" && entry.key.length >= 16
    ))?.key;
    if (key) knownSecrets = [key];
  } catch {
    knownSecrets = [];
  }

  const env = childEnvironment({
    HOME: home,
    USERPROFILE: home,
    GROK_HOME: grokHome,
    GROK_FOLDER_TRUST: "1",
    GROK_SUBAGENTS: "1",
    GROK_WORKFLOWS: "1",
    GROK_MEMORY: "0",
    GROK_WEB_FETCH: "0",
    GROK_LSP_TOOLS: "0"
  });
  delete env.HOMEDRIVE;
  delete env.HOMEPATH;
  delete env.GROK_AUTH_PATH;

  let revoked = false;
  return {
    env,
    home,
    grokHome,
    knownSecrets,
    sandboxProfile,
    configText: fs.readFileSync(path.join(grokHome, "config.toml"), "utf8"),
    revokeCredential() {
      if (revoked) return;
      try { fs.unlinkSync(authDestination); } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      revoked = true;
    }
  };
}

export function cleanupResearchRuntimeArtifacts(stateDir, homeMarker, identities = []) {
  const recorded = (Array.isArray(identities) ? identities : [identities]).filter(Boolean);
  if (recorded.some((identity) => !processGroupGone(identity))) {
    return {
      ok: false,
      warning: "Research runtime artifacts retained because process cleanup could not be verified."
    };
  }
  const home = path.join(stateDir, "research-homes", safeMarker(homeMarker));
  const stagedQuery = path.join(stateDir, "research-queries", `${safeMarker(homeMarker)}.txt`);
  try {
    // Snapshot subtrees are frozen read-only; thaw before recursive delete.
    removeResearchTree(home);
    try { fs.unlinkSync(stagedQuery); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      warning: redactText(error?.message || String(error)).slice(0, 500)
    };
  }
}

export function applyResearchPrivacy(result, cleanup, retentionNote = null) {
  const next = { ...(result || {}) };
  if (cleanup) {
    next.researchRuntimeCleaned = cleanup.ok;
    if (cleanup.warning) {
      next.privacyWarning = [next.privacyWarning, cleanup.warning].filter(Boolean).join("; ");
    } else if (cleanup.ok) {
      delete next.privacyWarning;
    }
    return next;
  }
  if (retentionNote) {
    next.researchRuntimeCleaned = false;
    next.privacyWarning = [...new Set([next.privacyWarning, retentionNote].filter(Boolean))].join("; ");
  }
  return next;
}

/**
 * Dedicated deep-research ACP runner.
 * session/prompt is launch acknowledgement only; terminal state comes from workflow updates.
 */
export async function runDeepResearch({
  root,
  profile,
  query,
  options = {},
  stateDir,
  jobMarker = "deep-research",
  model = null,
  effort = null,
  cancelRequested = () => false,
  onEvent = () => {},
  timeoutMs = DEEP_RESEARCH_TIMEOUT_MS,
  testHooks = null,
  providerExecutableBinding = null,
  providerExecutableEnv = process.env
} = {}) {
  assertProviderPlatform();
  const allowedProfileIds = new Set(["deep-research-v1", "deep-research-workspace-v1"]);
  if (!allowedProfileIds.has(profile?.id)) {
    throw new CompanionError(
      "E_SECURITY_PROFILE",
      "Deep-research requires deep-research-v1 or deep-research-workspace-v1."
    );
  }
  const parsedOptions = parseDeepResearchOptions(options);
  if (parsedOptions.workspace && profile.id !== "deep-research-workspace-v1") {
    throw new CompanionError(
      "E_SECURITY_PROFILE",
      "Workspace deep-research requires the deep-research-workspace-v1 profile."
    );
  }
  if (!parsedOptions.workspace && profile.id !== "deep-research-v1") {
    throw new CompanionError(
      "E_SECURITY_PROFILE",
      "Web-only deep-research requires the deep-research-v1 profile."
    );
  }
  const allowUnpinnedTestProvider =
    testHooks?.allowUnpinnedProvider === true;
  if (providerExecutableBinding == null && !allowUnpinnedTestProvider) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Deep-research requires the exact setup-pinned Grok executable."
    );
  }
  const workspaceBefore = parsedOptions.workspace ? integritySnapshot(root) : null;
  const pinnedProvider = providerExecutableBinding == null
    ? null
    : resolveProviderExecutablePin(
        providerExecutableBinding,
        { env: providerExecutableEnv }
      );
  const providerBinary = pinnedProvider?.binary || discoverGrok();
  const providerExecutableBefore = captureExecutableFileIdentity(providerBinary);
  const environment = researchEnvironment(stateDir, jobMarker, {
    providerExecutableBinary: providerBinary
  });
  let providerCwd;
  let snapshotMeta = null;
  if (parsedOptions.workspace) {
    snapshotMeta = createWorkspaceSnapshot(root, stateDir, jobMarker);
    providerCwd = snapshotMeta.cwd;
  } else {
    providerCwd = createWebOnlyCwd(stateDir, jobMarker);
  }

  const effectiveProfile = {
    ...profile,
    sandbox: environment.sandboxProfile
  };

  let provider;
  let securityError = null;
  try {
    // Fail closed if the isolated home loaded external hooks/skills/plugins/MCP/user agents.
    inspectIsolation(providerBinary, providerCwd, environment);
    provider = await openProvider({
      root: providerCwd,
      profile: effectiveProfile,
      model: model || parsedOptions.model,
      effort: effort || parsedOptions.effort,
      stateDir,
      jobMarker,
      environment,
      cancelRequested,
      onEvent: (event) => {
        if (event?.type === "permission" || event?.permission) {
          securityError = new CompanionError(
            "E_SECURITY_PROFILE",
            "Unexpected ACP permission request during deep-research."
          );
        }
        onEvent(event);
      },
      strictPermissionRequests: true,
      providerExecutableBinding,
      providerExecutableEnv,
      testHooks
    });
  } catch (error) {
    try { environment.revokeCredential(); } catch { /* best effort */ }
    if (error && typeof error === "object") {
      const details = error.details
        && typeof error.details === "object"
        && !Array.isArray(error.details)
        ? error.details
        : {};
      error.details = {
        ...details,
        replay: false,
        resume: false
      };
    }
    throw error;
  }

  const binder = createWorkflowBinder({
    expectedName: "deep-research",
    expectedObjective: query
  });
  let sessionId = null;
  let poll = null;
  let killTimer = null;
  let cancelled = false;
  let stopSent = false;
  let thrownError = null;
  const startedAt = Date.now();
  let capability = null;
  let lastCapabilityError = null;
  const pendingCapabilityUpdates = [];
  const countedAgentToolCalls = new Set();

  const failSecurity = (message) => {
    securityError = new CompanionError("E_SECURITY_PROFILE", message);
  };
  provider.client.on("permission", () => {
    failSecurity("Unexpected ACP permission request during deep-research.");
  });

  try {
    let inspect = null;
    try {
      const inspectRun = spawnSync(provider.binary, ["inspect", "--json"], {
        cwd: providerCwd,
        encoding: "utf8",
        shell: false,
        timeout: 30000,
        env: environment.env
      });
      if (inspectRun.status === 0) {
        try { inspect = JSON.parse(inspectRun.stdout); } catch { inspect = null; }
      }
    } catch {
      inspect = null;
    }

    const inspectedWebFetchAttestation = attestWebFetchAllowLocalFalse({
      inspect,
      configText: environment.configText
    });
    const webFetchEnabled = Array.isArray(profile.providerToolIds)
      && profile.providerToolIds.includes("GrokBuild:web_fetch");
    const webFetchAttestation = webFetchEnabled
      ? inspectedWebFetchAttestation
      : Object.freeze({
          ok: false,
          reducedCoverage: true,
          note: "WebFetch is disabled until allow_local=false is independently attested."
        });
    const fetchReducedCoverage = !webFetchAttestation.ok;
    if (fetchReducedCoverage) {
      onEvent({
        type: "diagnostic",
        text: webFetchAttestation.note
      });
    }

    if ((provider.initialized.authMethods || []).some((method) => method?.id === "cached_token")) {
      await provider.client.request(
        "authenticate",
        { methodId: "cached_token", _meta: { headless: true } },
        30000
      );
    }

    const acceptCapabilityAdvertisement = (
      advertisement,
      evidenceSource
    ) => {
      if (capability) return true;
      try {
        capability = assertDeepResearchCapability(advertisement, {
          evidenceSource
        });
        onEvent({
          type: "available-commands",
          commands: capability.availableCommands,
          tools: capability.availableTools,
          source: capability.evidenceSource
        });
        return true;
      } catch (error) {
        if (error?.code !== "E_CAPABILITY") throw error;
        lastCapabilityError = error;
        return false;
      }
    };

    const considerCapabilityUpdate = (notification) => {
      if (notification?.method !== "session/update") return false;
      const notificationSessionId = notification.params?.sessionId;
      const update = notification.params?.update;
      if (!isAvailableCommandsUpdate(update)) return false;
      if (typeof notificationSessionId !== "string"
        || !notificationSessionId
        || notificationSessionId.length > MAX_CAPABILITY_SESSION_ID_LENGTH) {
        throw new CompanionError(
          "E_PROTOCOL",
          "Deep-research capability update has an invalid session binding."
        );
      }
      const candidate = Object.freeze({
        sessionId: notificationSessionId,
        advertisement: compactCapabilityAdvertisement(
          update.availableCommands,
          update._meta?.tools
        )
      });
      if (!sessionId) {
        if (pendingCapabilityUpdates.length >= MAX_PENDING_CAPABILITY_UPDATES) {
          throw new CompanionError(
            "E_PROTOCOL",
            "Deep-research received too many capability updates before session binding."
          );
        }
        pendingCapabilityUpdates.push(candidate);
        return false;
      }
      if (notificationSessionId !== sessionId) return false;
      return acceptCapabilityAdvertisement(
        candidate.advertisement,
        "session-available-commands-update"
      );
    };

    const handleNotification = (notification) => {
      try {
        if (notification?.method === "session/request_permission") {
          failSecurity("Unexpected ACP permission request during deep-research.");
          return;
        }
        if (notification?.method === "session/update") {
          const update = notification.params?.update || notification.params;
          considerCapabilityUpdate(notification);
          const toolEvent = String(update?.sessionUpdate || update?.type || "");
          if (toolEvent.includes("tool_call")) {
            noteAgentLaunchFromToolEvent({
              type: "tool",
              name: update?.title || update?.toolCallId || "",
              event: toolEvent,
              toolCallId: typeof update?.toolCallId === "string"
                ? update.toolCallId
                : null
            }, countedAgentToolCalls, () => binder.noteAgentLaunch());
          }
        }
        if (notification?.method === "x.ai/session_notification"
          || notification?.method === "session/update"
          || notification?.params) {
          const applied = binder.applyUpdate(notification);
          if (applied?.accepted) {
            onEvent({
              type: "workflow",
              runId: applied.runId,
              revision: applied.revision,
              status: applied.status,
              phases: applied.phases,
              currentPhase: applied.currentPhase,
              elapsedMs: applied.elapsedMs,
              agentsUsed: applied.agentsUsed,
              agentBudget: applied.agentBudget,
              usageIncomplete: applied.usageIncomplete,
              activeAgents: applied.activeAgents,
              agentLaunches: applied.agentLaunches,
              pauseMessage: applied.pauseMessage
            });
          }
        }
      } catch (error) {
        securityError = error instanceof CompanionError
          ? error
          : new CompanionError("E_PROTOCOL", error?.message || String(error));
      }
    };

    const handleUpdate = (update) => {
      try {
        const raw = update?.value || update;
        const applied = binder.applyUpdate(raw);
        if (applied?.accepted) {
          onEvent({
            type: "workflow",
            runId: applied.runId,
            revision: applied.revision,
            status: applied.status,
            phases: applied.phases,
            currentPhase: applied.currentPhase,
            elapsedMs: applied.elapsedMs,
            agentsUsed: applied.agentsUsed,
            agentBudget: applied.agentBudget,
            usageIncomplete: applied.usageIncomplete,
            activeAgents: applied.activeAgents,
            agentLaunches: applied.agentLaunches,
            pauseMessage: applied.pauseMessage
          });
        }
      } catch (error) {
        securityError = error instanceof CompanionError
          ? error
          : new CompanionError("E_PROTOCOL", error?.message || String(error));
      }
    };

    // Register listeners before session/new so session-scoped
    // available_commands_update cannot race past the capability gate.
    provider.client.on("notification", handleNotification);
    provider.client.on("update", handleUpdate);
    const session = await provider.client.request(
      "session/new",
      { cwd: providerCwd, mcpServers: [] },
      45000
    );
    sessionId = session?.sessionId;
    if (!sessionId) {
      throw new CompanionError("E_PROTOCOL", "Grok did not return a deep-research session ID.");
    }
    environment.revokeCredential();
    onEvent({ type: "session", sessionId, models: session?.models });

    // A same-session notification can arrive in the same stdout chunk as the
    // session/new response and therefore before this async continuation.
    for (const candidate of pendingCapabilityUpdates.splice(0)) {
      if (candidate.sessionId !== sessionId) continue;
      acceptCapabilityAdvertisement(
        candidate.advertisement,
        "session-available-commands-update"
      );
    }
    if (securityError) throw securityError;

    // Wait briefly for one paired, session-scoped
    // available_commands_update, then pull the same session's paired catalog.
    const commandWaitDeadline = Date.now() + (testHooks?.commandWaitMs ?? 1500);
    while (!capability && Date.now() < commandWaitDeadline) {
      if (securityError) throw securityError;
      if (cancelRequested()) {
        throw new CompanionError("E_CANCELLED", "Deep-research was cancelled before capability gate.");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (testHooks?.afterSessionWait) await testHooks.afterSessionWait({ sessionId });
    }
    if (!capability) {
      let listed;
      try {
        listed = await provider.client.request(
          "x.ai/commands/list",
          { sessionId },
          15000
        );
      } catch (error) {
        if (!capability) {
          throw new CompanionError(
            "E_CAPABILITY",
            "Deep-research could not obtain paired capability evidence for the newly-created session.",
            {
              cause: error?.code || null,
              priorMissing: lastCapabilityError?.details?.missing || []
            }
          );
        }
      }
      if (!capability) {
        acceptCapabilityAdvertisement(
          compactCapabilityAdvertisement(listed?.commands, listed?.tools),
          "same-session-commands-list"
        );
      }
    }

    if (!capability) throw lastCapabilityError || new CompanionError(
      "E_CAPABILITY",
      "Deep-research did not receive one paired command and tool advertisement for the newly-created session."
    );

    // Capability is established only after session creation and one exact,
    // paired same-session advertisement. initialize/inspect are not evidence.
    const providerExecutableAfter = captureExecutableFileIdentity(provider.binary);
    if (!sameExecutableFileIdentity(providerExecutableBefore, providerExecutableAfter)) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "The Grok executable changed while deep-research capability was being established."
      );
    }
    const capabilityReceipt = buildDeepResearchCapabilityReceipt({
      executableIdentity: providerExecutableAfter,
      providerVersion: provider.version,
      profileDigest: profile.agentProfileDigest,
      availableCommands: capability.availableCommands,
      availableTools: capability.availableTools,
      evidenceSource: capability.evidenceSource,
      sessionId
    });

    // Exact upstream slash — wrapper flags never forwarded.
    const slash = buildDeepResearchSlashCommand(query);
    if (securityError) throw securityError;
    if (provider.eventError()) throw provider.eventError();
    // Ignore all workflow notifications observed before this launch boundary.
    binder.arm();
    // Launch acknowledgement only — not terminal completion.
    const promptResponse = await provider.client.promptTurn({
      sessionId,
      prompt: [{ type: "text", text: slash }],
      timeoutMs: Math.min(timeoutMs, 5 * 60 * 1000)
    });
    if (securityError) throw securityError;
    if (provider.eventError()) throw provider.eventError();
    if (cancelRequested() || isCancelledPromptStopReason(promptResponse.result?.stopReason)) {
      throw new CompanionError("E_CANCELLED", "Deep-research was cancelled during launch.");
    }
    if (!isSuccessfulPromptStopReason(promptResponse.result?.stopReason)) {
      throw new CompanionError(
        "E_PROTOCOL",
        "Deep-research launch prompt did not end at a successful ACP turn boundary."
      );
    }
    onEvent({
      type: "launch-ack",
      stopReason: promptResponse.result?.stopReason || "end_turn",
      sessionId,
      slash
    });

    poll = setInterval(() => {
      if (securityError) return;
      if (!cancelled && cancelRequested()) {
        cancelled = true;
        requestWorkflowStop(provider, sessionId, binder.state.runId);
        stopSent = Boolean(binder.state.runId);
        killTimer = setTimeout(() => {
          try {
            process.kill(
              provider.process.processGroupId ? -provider.process.processGroupId : provider.child.pid,
              "SIGTERM"
            );
          } catch { /* best effort */ }
        }, DEEP_RESEARCH_CANCEL_GRACE_MS);
      }
      if (Date.now() - startedAt > timeoutMs && !binder.state.settled) {
        securityError = new CompanionError(
          "E_TIMEOUT",
          "Deep-research exceeded the 30-minute timeout."
        );
        try {
          provider.client.notify("session/cancel", { sessionId });
        } catch { /* best effort */ }
      }
    }, 100);

    // Remain alive until terminal workflow state (or cancel/timeout/security).
    const deadline = startedAt + timeoutMs;
    while (!binder.state.settled) {
      if (securityError) throw securityError;
      if (provider.eventError()) throw provider.eventError();
      if (cancelled) {
        // Wait for settled cleanup after /workflow stop with exact run ID.
        if (binder.state.runId && !stopSent) {
          requestWorkflowStop(provider, sessionId, binder.state.runId);
          stopSent = true;
        }
        const cancelDeadline = Date.now() + DEEP_RESEARCH_CANCEL_GRACE_MS;
        while (
          Date.now() < cancelDeadline
          && !binder.state.settled
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (testHooks?.forceSettledAfterCancel) {
            binder.applyUpdate({
              runId: binder.state.runId,
              revision: (binder.state.revision || 0) + 1,
              status: "cancelled",
              activeAgents: 0
            });
          }
        }
        break;
      }
      if (Date.now() > deadline) {
        throw new CompanionError("E_TIMEOUT", "Deep-research exceeded the 30-minute timeout.");
      }
      if (testHooks?.injectWorkflowUpdate) {
        const injected = testHooks.injectWorkflowUpdate(binder.state);
        if (injected) binder.applyUpdate(injected);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    if (securityError) throw securityError;

    let report = null;
    if (sessionId && binder.state.runId && (binder.state.status === "complete" || binder.state.status === "completed")) {
      report = collectResearchReport({
        grokHome: environment.grokHome,
        providerCwd,
        sessionId,
        runId: binder.state.runId
      });
      report = Object.freeze({
        ...report,
        status: binder.state.reportStatus === "verified" ? "verified" : "partial"
      });
      if (fetchReducedCoverage && report) {
        report = Object.freeze({
          ...report,
          coverageNotes: [
            ...(report.coverageNotes || []),
            webFetchAttestation.note
          ]
        });
      }
    } else if (sessionId && binder.state.runId) {
      try {
        report = collectResearchReport({
          grokHome: environment.grokHome,
          providerCwd,
          sessionId,
          runId: binder.state.runId
        });
      } catch {
        report = null;
      }
    }

    const mapped = mapDeepResearchTerminal({
      status: cancelled ? "cancelled" : binder.state.status,
      report,
      cancelled
    });

    if (workspaceBefore) {
      proveWorkspaceUnchanged(root, workspaceBefore);
    }

    if (mapped.error) {
      const error = new CompanionError(mapped.error.code, mapped.error.message);
      error.details = {
        ...(error.details || {}),
        workflow: binder.state,
        researchReport: report,
        replay: false,
        resume: false
      };
      throw error;
    }

    return {
      sessionId,
      stopReason: "workflow_complete",
      provider: { version: provider.version, process: provider.process },
      capabilities: provider.initialized,
      capabilityReceipt,
      workflow: binder.state,
      researchReport: report,
      hostVerification: "not_run",
      workspaceSnapshot: snapshotMeta
        ? {
            fileCount: snapshotMeta.fileCount,
            workspaceUnchanged: true
          }
        : { webOnly: true },
      webFetchAttestation,
      text: report?.markdown || "",
      replay: false,
      resume: false
    };
  } catch (error) {
    if (provider && sessionId && binder.state.runId && !binder.state.settled) {
      requestWorkflowStop(provider, sessionId, binder.state.runId);
      const settleDeadline = Date.now() + DEEP_RESEARCH_CANCEL_GRACE_MS;
      while (
        Date.now() < settleDeadline
        && !binder.state.settled
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (workspaceBefore) {
      try { proveWorkspaceUnchanged(root, workspaceBefore); }
      catch (workspaceError) {
        if (error instanceof CompanionError) {
          error.details = {
            ...(error.details || {}),
            workspaceWarning: workspaceError.message
          };
        }
      }
    }
    if (/auth|login|unauthori[sz]ed|no auth method/i.test(`${error?.message || ""}`)) {
      const authError = new CompanionError(
        "E_AUTH_REQUIRED",
        `Grok authentication is unavailable or expired. Run \`grok login\`, then ${hostCommand("setup")}.`
      );
      authError.details = { replay: false, resume: false };
      thrownError = authError;
      throw authError;
    }
    const outgoing = securityError || provider?.eventError?.() || error;
    if (outgoing && typeof outgoing === "object") {
      outgoing.details = {
        ...(outgoing.details || {}),
        replay: false,
        resume: false
      };
    }
    thrownError = outgoing;
    throw outgoing;
  } finally {
    if (poll) clearInterval(poll);
    if (killTimer) clearTimeout(killTimer);
    try { environment.revokeCredential(); } catch { /* best effort */ }
    try { provider?.client?.close(); } catch { /* best effort */ }
    let providerCleanupError = null;
    try {
      if (provider?.child) {
        await ensureChildExit(provider.child, provider.process);
      }
    } catch (error) {
      providerCleanupError = error;
    }
    try { provider?.cleanupAgentProfile?.(); } catch { /* best effort */ }
    if (providerCleanupError) {
      if (thrownError && typeof thrownError === "object") {
        thrownError.details = {
          ...(thrownError.details || {}),
          providerCleanupError: redactText(
            providerCleanupError?.message || String(providerCleanupError)
          ).slice(0, 500)
        };
      } else {
        throw providerCleanupError;
      }
    }
  }
}

function requestWorkflowStop(provider, sessionId, runId) {
  if (!provider?.client || !sessionId) return;
  if (!runId) {
    try {
      provider.client.notify("session/cancel", { sessionId });
    } catch { /* best effort */ }
    return;
  }
  // Exact bound run ID only — never a guessed or latest run.
  let stopPrompt;
  try {
    stopPrompt = buildWorkflowStopSlashCommand(runId);
  } catch {
    try { provider.client.notify("session/cancel", { sessionId }); } catch { /* best effort */ }
    return;
  }
  try {
    // Fire-and-forget stop; settlement is observed via workflow updates.
    provider.client.promptTurn({
      sessionId,
      prompt: [{ type: "text", text: stopPrompt }],
      timeoutMs: 30_000
    }).catch(() => {
      try { provider.client.notify("session/cancel", { sessionId }); } catch { /* best effort */ }
    });
  } catch {
    try { provider.client.notify("session/cancel", { sessionId }); } catch { /* best effort */ }
  }
}

export function publicResearchReport(report) {
  if (!report || typeof report !== "object") return null;
  const markdown = typeof report.markdown === "string"
    ? report.markdown
    : typeof report.text === "string"
      ? report.text
      : null;
  const publicArtifactPath = typeof report.runId === "string"
    ? `workflows/${safeMarker(report.runId)}/scratch/report.md`
    : null;
  return Object.freeze({
    schemaVersion: 1,
    valid: Boolean(report.valid),
    path: publicArtifactPath,
    bytes: Number.isSafeInteger(report.bytes) ? report.bytes : 0,
    sha256: typeof report.sha256 === "string" ? report.sha256 : null,
    sourceCount: Number.isSafeInteger(report.sourceCount) ? report.sourceCount : 0,
    coverageNotes: Array.isArray(report.coverageNotes)
      ? report.coverageNotes.map((item) => String(item).slice(0, 500)).slice(0, 16)
      : [],
    status: ["verified", "partial"].includes(report.status || report.assessment)
      ? (report.status || report.assessment)
      : "partial",
    hostVerification: "not_run",
    // Full report body stays private; public projection exposes metadata only.
    textPreview: markdown
      ? markdown.slice(0, 500)
      : null
  });
}

export { processStartToken };
