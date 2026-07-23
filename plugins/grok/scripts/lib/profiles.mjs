import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER_AGENTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../provider-agents");
const base = { contractVersion: 3, webSearch: false, subagents: false, isolatedLeader: true };
const AGENT_PROFILE_BINDINGS = Object.freeze({
  "report-repair.md": Object.freeze({
    permissionMode: "dontAsk",
    providerToolIds: Object.freeze(["GrokBuild:todo_write"])
  }),
  "rescue-read.md": Object.freeze({
    permissionMode: "dontAsk",
    providerToolIds: Object.freeze([
      "GrokBuild:read_file",
      "GrokBuild:list_dir",
      "GrokBuild:grep"
    ])
  }),
  "rescue-write.md": Object.freeze({
    permissionMode: "acceptEdits",
    providerToolIds: Object.freeze([
      "GrokBuild:read_file",
      "GrokBuild:list_dir",
      "GrokBuild:grep",
      "GrokBuild:search_replace",
      "GrokBuild:todo_write"
    ])
  })
});
const BASE_DENIED_PROVIDER_TOOL_IDS = Object.freeze([
  "GrokBuild:WebSearch",
  "GrokBuild:WebFetch",
  "GrokBuild:Agent",
  "GrokBuild:mcp__*",
  "GrokBuild:run_terminal_cmd"
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
    || typeof expected.permissionMode !== "string"
    || !Array.isArray(expected.providerToolIds)
    || expected.providerToolIds.length === 0
    || new Set(expected.providerToolIds).size !== expected.providerToolIds.length) {
    throw new Error(`Provider agent profile ${name} has no exact code-owned tool contract.`);
  }
  const lines = frontmatter.split(/\r?\n/);
  const prefix = [
    /^name: [a-z0-9][a-z0-9-]*$/,
    /^description: \S.*$/,
    /^prompt_mode: full$/,
    new RegExp(`^permission_mode: ${expected.permissionMode}$`),
    /^agents_md: false$/,
    /^injectDefaultTools: false$/,
    /^toolConfig:$/,
    /^  tools:$/
  ];
  if (lines.length !== prefix.length + expected.providerToolIds.length
    || prefix.some((pattern, index) => !pattern.test(lines[index] || ""))) {
    throw new Error(
      `Provider agent profile ${name} must use the exact canonical leading frontmatter layout.`
    );
  }
  const toolIds = lines.slice(prefix.length).map((line, index) => {
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
  const keys = ["id", "contractVersion", "transport", "agent", "sandbox", "permissionMode", "webSearch", "subagents", "isolatedLeader", "agentProfileDigest"];
  return keys.every((key) => JSON.stringify(a?.[key]) === JSON.stringify(b?.[key]))
    && JSON.stringify(a?.allowedTools) === JSON.stringify(b?.allowedTools)
    && JSON.stringify(a?.deniedTools) === JSON.stringify(b?.deniedTools)
    && JSON.stringify(a?.providerToolIds) === JSON.stringify(b?.providerToolIds)
    && JSON.stringify(a?.deniedProviderToolIds) === JSON.stringify(b?.deniedProviderToolIds);
}
