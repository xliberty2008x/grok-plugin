import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER_AGENTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../provider-agents");
const base = { contractVersion: 2, webSearch: false, subagents: false, isolatedLeader: true };

function agentProfileDigest(name) {
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(PROVIDER_AGENTS, name))).digest("hex");
}

export function profileFor(kind, write = false) {
  const reviewBase = { ...base, transport: "headless", agent: "explore" };
  const taskBase = { ...base, transport: "acp", agent: "build" };
  const reviewTools = ["todo_write"];
  const denied = ["WebSearch", "WebFetch", "Agent", "mcp__*"];
  if (kind === "review") return { ...reviewBase, id: "review-v1", sandbox: "strict", permissionMode: "default", allowedTools: reviewTools, deniedTools: denied };
  if (kind === "adversarial-review") return { ...reviewBase, id: "adversarial-review-v1", sandbox: "strict", permissionMode: "default", allowedTools: reviewTools, deniedTools: denied };
  if (kind === "stop-review") return { ...reviewBase, id: "stop-review-v1", sandbox: "strict", permissionMode: "default", allowedTools: reviewTools, deniedTools: denied };
  return { ...taskBase, id: write ? "rescue-write-v2" : "rescue-read-v2", sandbox: write ? "workspace" : "read-only", permissionMode: write ? "bypassPermissions" : "dontAsk", agentProfileDigest: agentProfileDigest(write ? "rescue-write.md" : "rescue-read.md"), allowedTools: write ? ["read_file", "list_dir", "grep", "run_terminal_cmd", "search_replace", "todo_write", "kill_task", "get_task_output"] : ["read_file", "list_dir", "grep"], deniedTools: denied };
}

export function sameSecurityProfile(a, b) {
  const keys = ["id", "contractVersion", "transport", "agent", "sandbox", "permissionMode", "webSearch", "subagents", "isolatedLeader", "agentProfileDigest"];
  return keys.every((key) => JSON.stringify(a?.[key]) === JSON.stringify(b?.[key])) && JSON.stringify(a?.allowedTools) === JSON.stringify(b?.allowedTools) && JSON.stringify(a?.deniedTools) === JSON.stringify(b?.deniedTools);
}
