import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const INSTALLED_WORKER_MCP_RUNNER = path.join(
  ROOT,
  "scripts",
  "test-installed-worker-mcp.mjs"
);
export const INSTALLED_WORKER_MCP_RUNNER_MODULES = [
  "core",
  "setup",
  "runtime",
  "observation",
  "session-read"
].map((domain) => path.join(
  ROOT,
  "scripts",
  "lib",
  `installed-worker-mcp-runner-${domain}.mjs`
));

export function readInstalledWorkerMcpRunnerSource() {
  return [
    ...INSTALLED_WORKER_MCP_RUNNER_MODULES,
    INSTALLED_WORKER_MCP_RUNNER
  ].map((file) => fs.readFileSync(file, "utf8")).join("\n");
}
