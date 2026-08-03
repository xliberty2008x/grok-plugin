import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./args.mjs";
import { CompanionError } from "./errors.mjs";
import { profileFor } from "./profiles.mjs";
import { workspaceRoot } from "./workspace.mjs";
import { hasGrokAncestor } from "./process-control.mjs";
import { hasForeignActiveProvider } from "./recursion-guard.mjs";
const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "grok-companion.mjs"
);
const PLUGIN_ROOT = path.resolve(path.dirname(SCRIPT), "..");
const VALID_EFFORTS = new Set(["low", "medium", "high"]);
import { argvFrom, out, sessionId, usage } from "./companion-shared.mjs";

import { handleDeepResearch } from "./companion-research.mjs";
import { handleRecordVerification, handleReview, handleSetup, handleTask, resumeCandidate } from "./companion-handlers.mjs";
import { handleCancel, handleResult, handleStatus } from "./companion-status.mjs";
import { handleTransfer } from "./companion-transfer.mjs";
import { handleInternalCommand } from "./companion-worker-launcher.mjs";

function assertInvocationAllowed(command, raw) {
const internal = command === "--launch-worker"
  || command === "--worker"
  || command === "--launch-deep-research"
  || command === "--deep-research-worker";
const grokEnvironment = process.env.GROK_COMPANION_CHILD === "1" || process.env.GROK_COMPANION_JOB_MARKER || process.env.GROK_AGENT || process.env.GROK_LEADER_SOCKET;
let guardedWorkspace = false;
if (!internal && ["setup", "review", "adversarial-review", "task", "deep-research", "transfer"].includes(command)) {
  const invocationArgs = command === "task" ? raw : argvFrom(raw);
  const cwdIndex = invocationArgs.indexOf("--cwd");
  const candidates = [process.cwd(), cwdIndex >= 0 && invocationArgs[cwdIndex + 1]].filter(Boolean);
  guardedWorkspace = candidates.some((candidate) => {
    try { return hasForeignActiveProvider(workspaceRoot(path.resolve(candidate), false), sessionId()); }
    catch { return false; }
  });
}
if (grokEnvironment || (!internal && hasGrokAncestor()) || guardedWorkspace) throw new CompanionError("E_RECURSION", "Nested Grok Companion invocation refused.");
}

function dispatchPublicCommand(command, raw) {
if (command === "setup") return handleSetup(raw);
if (["review", "adversarial-review"].includes(command)) return handleReview(command, raw);
if (command === "task") return handleTask(raw);
if (command === "deep-research") return handleDeepResearch(raw);
if (command === "task-resume-candidate") {
  const { options } = parseArgs(argvFrom(raw), { values: ["cwd"], booleans: ["write", "json"] });
  const root = workspaceRoot(options.cwd ? path.resolve(options.cwd) : process.cwd());
  const candidate = resumeCandidate(root, profileFor("task", Boolean(options.write)));
  out({ available: Boolean(candidate), jobId: candidate?.id || null, profileId: candidate?.profile?.id || null }, true);
  return;
}
if (command === "record-verification") return handleRecordVerification(raw);
if (command === "status") return handleStatus(raw);
if (command === "result") return handleResult(raw);
if (command === "cancel") return handleCancel(raw);
if (command === "transfer") return handleTransfer(raw);
throw new CompanionError("E_USAGE", `Unknown command ${command}.\n${usage()}`);
}

async function main() {
  const [command, ...raw] = process.argv.slice(2);
  assertInvocationAllowed(command, raw);
if (!command || ["help", "--help", "-h"].includes(command)) { out(usage()); return; }
  if (["--launch-worker", "--worker", "--launch-deep-research", "--deep-research-worker"].includes(command)) {
    return handleInternalCommand(command, raw);
  }
  return dispatchPublicCommand(command, raw);
}

export { main };
