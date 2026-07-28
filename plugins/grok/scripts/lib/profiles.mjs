import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER_AGENTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../provider-agents");
const base = { contractVersion: 3, webSearch: false, subagents: false, isolatedLeader: true };
const WRITE_COMPLETION_REQUIREMENT = Object.freeze({
  tool: "search_replace",
  reminder: "A write task requires a real workspace edit. Continue the requested implementation and call search_replace before finishing.",
  recovery: Object.freeze({
    maxRetries: 1,
    baseDelayMs: 100,
    maxDelayMs: 100
  })
});
const AGENT_PROFILE_BINDINGS = Object.freeze({
  "report-repair.md": Object.freeze({
    promptMode: "full",
    permissionMode: "dontAsk",
    providerToolIds: Object.freeze(["GrokBuild:todo_write"])
  }),
  "rescue-read.md": Object.freeze({
    promptMode: "full",
    permissionMode: "dontAsk",
    providerToolIds: Object.freeze([
      "GrokBuild:read_file",
      "GrokBuild:list_dir",
      "GrokBuild:grep"
    ])
  }),
  "rescue-write.md": Object.freeze({
    promptMode: "extend",
    permissionMode: "acceptEdits",
    completionRequirement: WRITE_COMPLETION_REQUIREMENT,
    providerToolIds: Object.freeze([
      "GrokBuild:read_file",
      "GrokBuild:list_dir",
      "GrokBuild:grep",
      "GrokBuild:search_replace",
      "GrokBuild:todo_write"
    ])
  }),
  "deep-research.md": Object.freeze({
    promptMode: "full",
    permissionMode: "dontAsk",
    providerToolIds: Object.freeze([
      "GrokBuild:web_search",
      "GrokBuild:task",
      "GrokBuild:get_task_output",
      "GrokBuild:kill_task"
    ])
  }),
  "deep-research-workspace.md": Object.freeze({
    promptMode: "full",
    permissionMode: "dontAsk",
    providerToolIds: Object.freeze([
      "GrokBuild:web_search",
      "GrokBuild:task",
      "GrokBuild:get_task_output",
      "GrokBuild:kill_task",
      "GrokBuild:read_file",
      "GrokBuild:list_dir",
      "GrokBuild:grep"
    ])
  })
});
const BASE_DENIED_PROVIDER_TOOL_IDS = Object.freeze([
  "GrokBuild:web_search",
  "GrokBuild:web_fetch",
  "GrokBuild:task",
  "GrokBuild:mcp__*",
  "GrokBuild:run_terminal_cmd"
]);
const RESEARCH_DENIED_PROVIDER_TOOL_IDS = Object.freeze([
  "GrokBuild:web_fetch",
  "GrokBuild:mcp__*",
  "GrokBuild:run_terminal_cmd",
  "GrokBuild:search_replace",
  "GrokBuild:todo_write"
]);
const RESEARCH_WEB_ONLY_DENIED_PROVIDER_TOOL_IDS = Object.freeze([
  ...RESEARCH_DENIED_PROVIDER_TOOL_IDS,
  "GrokBuild:read_file",
  "GrokBuild:list_dir",
  "GrokBuild:grep"
]);

function leadingFrontmatter(text, name) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) {
    throw new Error(`Provider agent profile ${name} must start with one closed frontmatter block.`);
  }
  return match[1];
}

export function assertProviderAgentProfileContract(contents, expected, name = "provider-agent.md") {
  const text = Buffer.isBuffer(contents) ? contents.toString("utf8") : String(contents);
  const frontmatter = leadingFrontmatter(text, name);
  if (!expected
    || !["extend", "full"].includes(expected.promptMode)
    || typeof expected.permissionMode !== "string"
    || (expected.completionRequirement !== undefined
      && (!expected.completionRequirement
        || typeof expected.completionRequirement.tool !== "string"
        || typeof expected.completionRequirement.reminder !== "string"
        || !Number.isInteger(expected.completionRequirement.recovery?.maxRetries)
        || !Number.isInteger(expected.completionRequirement.recovery?.baseDelayMs)
        || !Number.isInteger(expected.completionRequirement.recovery?.maxDelayMs)))
    || !Array.isArray(expected.providerToolIds)
    || expected.providerToolIds.length === 0
    || new Set(expected.providerToolIds).size !== expected.providerToolIds.length) {
    throw new Error(`Provider agent profile ${name} has no exact code-owned tool contract.`);
  }
  const lines = frontmatter.split(/\r?\n/);
  const header = [
    /^name: [a-z0-9][a-z0-9-]*$/,
    /^description: \S.*$/,
    new RegExp(`^prompt_mode: ${expected.promptMode}$`),
    new RegExp(`^permission_mode: ${expected.permissionMode}$`),
    /^agents_md: false$/,
    /^injectDefaultTools: false$/
  ];
  const completion = expected.completionRequirement
    ? [
        "completionRequirement:",
        `  tool: ${expected.completionRequirement.tool}`,
        "  reminder: >-",
        `    ${expected.completionRequirement.reminder}`,
        "  recovery:",
        `    maxRetries: ${expected.completionRequirement.recovery.maxRetries}`,
        `    baseDelayMs: ${expected.completionRequirement.recovery.baseDelayMs}`,
        `    maxDelayMs: ${expected.completionRequirement.recovery.maxDelayMs}`
      ]
    : [];
  const toolConfig = ["toolConfig:", "  tools:"];
  const prefixLength = header.length + completion.length + toolConfig.length;
  if (lines.length !== prefixLength + expected.providerToolIds.length
    || header.some((pattern, index) => !pattern.test(lines[index] || ""))
    || completion.some((line, index) => lines[header.length + index] !== line)
    || toolConfig.some(
      (line, index) => lines[header.length + completion.length + index] !== line
    )) {
    throw new Error(
      `Provider agent profile ${name} must use the exact canonical leading frontmatter layout.`
    );
  }
  const toolIds = lines.slice(prefixLength).map((line, index) => {
    const match = /^    - id: ([A-Za-z][A-Za-z0-9_.-]*:[A-Za-z0-9][A-Za-z0-9_.*-]*)$/.exec(line);
    if (!match || match[1] !== expected.providerToolIds[index]) {
      throw new Error(`Provider agent profile ${name} no longer matches its code-owned tool contract.`);
    }
    return match[1];
  });
  if (new Set(toolIds).size !== toolIds.length) {
    throw new Error(`Provider agent profile ${name} contains duplicate provider tool ids.`);
  }
  return Object.freeze([...toolIds]);
}

function agentProfileBinding(name) {
  const expected = AGENT_PROFILE_BINDINGS[name];
  if (!expected) throw new Error(`Unsupported provider agent profile ${name}.`);
  const contents = fs.readFileSync(path.join(PROVIDER_AGENTS, name));
  const toolIds = assertProviderAgentProfileContract(contents, expected, name);
  return {
    agentProfileDigest: crypto.createHash("sha256").update(contents).digest("hex"),
    promptMode: expected.promptMode,
    ...(expected.completionRequirement
      ? { completionRequirement: expected.completionRequirement }
      : {}),
    providerToolIds: [...toolIds]
  };
}

export function profileFor(kind, write = false) {
  const reviewBase = { ...base, transport: "headless", agent: "explore" };
  const taskBase = { ...base, transport: "acp", agent: "build" };
  const reviewTools = ["todo_write"];
  const denied = ["WebSearch", "WebFetch", "Agent", "mcp__*"];
  if (kind === "review") return { ...reviewBase, id: "review-v1", sandbox: "strict", permissionMode: "default", allowedTools: reviewTools, deniedTools: denied };
  if (kind === "adversarial-review") return { ...reviewBase, id: "adversarial-review-v1", sandbox: "strict", permissionMode: "default", allowedTools: reviewTools, deniedTools: denied };
  if (kind === "stop-review") return { ...reviewBase, id: "stop-review-v1", sandbox: "strict", permissionMode: "default", allowedTools: reviewTools, deniedTools: denied };
  if (kind === "report-repair") return {
    ...taskBase,
    id: "rescue-report-v3",
    sandbox: "strict",
    permissionMode: "dontAsk",
    ...agentProfileBinding("report-repair.md"),
    allowedTools: ["todo_write"],
    deniedTools: [...denied, "Bash", "Edit", "Write"],
    deniedProviderToolIds: [
      ...BASE_DENIED_PROVIDER_TOOL_IDS,
      "GrokBuild:read_file",
      "GrokBuild:list_dir",
      "GrokBuild:grep",
      "GrokBuild:search_replace"
    ]
  };
  if (kind === "deep-research" || kind === "deep-research-workspace") {
    const workspace = kind === "deep-research-workspace";
    const binding = agentProfileBinding(
      workspace ? "deep-research-workspace.md" : "deep-research.md"
    );
    return {
      ...taskBase,
      id: workspace ? "deep-research-workspace-v1" : "deep-research-v1",
      sandbox: "strict",
      permissionMode: "dontAsk",
      webSearch: true,
      subagents: true,
      ...binding,
      allowedTools: workspace
        ? ["WebSearch", "Agent", "read_file", "list_dir", "grep"]
        : ["WebSearch", "Agent"],
      deniedTools: workspace
        ? ["Bash", "Edit", "Write", "WebFetch", "mcp__*", "search_replace", "todo_write"]
        : ["Bash", "Edit", "Write", "WebFetch", "mcp__*", "read_file", "list_dir", "grep", "search_replace", "todo_write"],
      deniedProviderToolIds: workspace
        ? [...RESEARCH_DENIED_PROVIDER_TOOL_IDS]
        : [...RESEARCH_WEB_ONLY_DENIED_PROVIDER_TOOL_IDS],
      maxActiveAgents: 4,
      maxAgentLaunches: 8,
      researchTimeoutMs: 30 * 60 * 1000,
      workspaceMode: workspace
    };
  }
  const binding = agentProfileBinding(write ? "rescue-write.md" : "rescue-read.md");
  return {
    ...taskBase,
    id: write ? "rescue-write-v3" : "rescue-read-v3",
    sandbox: "strict",
    permissionMode: write ? "acceptEdits" : "dontAsk",
    ...binding,
    allowedTools: write ? ["read_file", "list_dir", "grep", "search_replace", "todo_write"] : ["read_file", "list_dir", "grep"],
    deniedTools: [...denied, "Bash"],
    deniedProviderToolIds: [
      ...BASE_DENIED_PROVIDER_TOOL_IDS,
      ...(write
        ? []
        : ["GrokBuild:search_replace", "GrokBuild:todo_write"])
    ]
  };
}

export function sameSecurityProfile(a, b) {
  const keys = ["id", "contractVersion", "transport", "agent", "sandbox", "permissionMode", "promptMode", "completionRequirement", "webSearch", "subagents", "isolatedLeader", "agentProfileDigest"];
  return keys.every((key) => JSON.stringify(a?.[key]) === JSON.stringify(b?.[key]))
    && JSON.stringify(a?.allowedTools) === JSON.stringify(b?.allowedTools)
    && JSON.stringify(a?.deniedTools) === JSON.stringify(b?.deniedTools)
    && JSON.stringify(a?.providerToolIds) === JSON.stringify(b?.providerToolIds)
    && JSON.stringify(a?.deniedProviderToolIds) === JSON.stringify(b?.deniedProviderToolIds);
}
