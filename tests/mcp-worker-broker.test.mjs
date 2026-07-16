import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  WORKER_TOOLS,
  callWorkerTool,
  handleMcpRequest
} from "../plugins/grok/mcp/broker.mjs";
import { MCP_SANDBOX_STATE_META_CAPABILITY } from "../plugins/grok/scripts/lib/worker-authority.mjs";
import { ROOT, run } from "./helpers.mjs";

const PRINCIPAL = Object.freeze({
  hostKind: "codex",
  threadId: "019f666a-6469-7cc1-9a8d-8c1adf61e103",
  turnId: "019f666e-4084-7902-8447-249f72043a37",
  source: "codex-mcp-stdio",
  root: ROOT
});

test("MCP broker advertises sandbox metadata, pins protocol versions, and lists structured tools", async () => {
  const initialized = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25" }
  });
  assert.ok(initialized.result.capabilities.experimental[MCP_SANDBOX_STATE_META_CAPABILITY]);
  assert.equal(initialized.result.capabilities.tools.listChanged, false);
  assert.equal(initialized.result.protocolVersion, "2025-11-25");
  assert.ok(initialized.result._meta["grok/supportedProtocolVersions"].includes("2025-11-25"));
  assert.equal(initialized.result._meta["grok/externalWorkerLabel"], "external-grok-worker");

  const rejected = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 9,
    method: "initialize",
    params: { protocolVersion: "2099-01-01" }
  });
  assert.equal(rejected.error.code, -32602);

  const listed = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(listed.result.tools.length, WORKER_TOOLS.length);
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), WORKER_TOOLS.map((tool) => tool.name));
  for (const tool of listed.result.tools) {
    assert.equal(tool.annotations.idempotentHint, true);
    const schema = JSON.stringify(tool.inputSchema);
    for (const forbidden of ["root", "threadId", "sessionId", "workspace", "owner", "all"]) {
      assert.equal(schema.includes(`\"${forbidden}\"`), false);
    }
  }
  const readOnly = listed.result.tools.filter((tool) => tool.annotations.readOnlyHint);
  assert.equal(readOnly.length, 5);
});

test("MCP calls fail closed without metadata and reject identity or root spoof arguments", async () => {
  let serviceCreated = false;
  const missing = await callWorkerTool({ name: "worker_list_owned", arguments: {} }, {
    createService() {
      serviceCreated = true;
      throw new Error("must not run");
    }
  });
  assert.equal(missing.isError, true);
  assert.deepEqual(missing.structuredContent.error, {
    code: "E_AUTH_REQUIRED",
    message: "Trusted Codex task identity is unavailable."
  });
  assert.equal(serviceCreated, false);

  let authorityResolved = 0;
  const spoofed = await callWorkerTool({
    name: "worker_list_owned",
    arguments: { root: "/tmp/foreign", threadId: PRINCIPAL.threadId }
  }, {
    resolveAuthority() {
      authorityResolved += 1;
      return PRINCIPAL;
    },
    createService() {
      serviceCreated = true;
      throw new Error("must not run");
    }
  });
  assert.equal(authorityResolved, 1, "authority must be resolved before arguments are interpreted");
  assert.equal(serviceCreated, false);
  assert.equal(spoofed.structuredContent.error.code, "E_USAGE");
});

test("MCP broker routes owned reads and allowlists errors without private details", async () => {
  const options = {
    resolveAuthority: () => PRINCIPAL,
    createService: () => ({
      listOwned: () => [{ id: "task-aaaaaaaaaaaaaaaa" }],
      get: (id) => ({ id }),
      eventsAfter: (id, cursor) => ({ workerId: id, nextCursor: cursor }),
      wait: async (id) => ({ workerId: id, timedOut: true }),
      result() {
        const error = new Error("Leaked /private/repository xai-secret");
        error.code = "E_JOB_NOT_FOUND";
        throw error;
      }
    })
  };
  const listed = await callWorkerTool({ name: "worker_list_owned", arguments: {} }, options);
  assert.deepEqual(listed.structuredContent.workers, [{ id: "task-aaaaaaaaaaaaaaaa" }]);
  const got = await callWorkerTool({
    name: "worker_get",
    arguments: { id: "task-aaaaaaaaaaaaaaaa" }
  }, options);
  assert.equal(got.structuredContent.worker.id, "task-aaaaaaaaaaaaaaaa");
  const failed = await callWorkerTool({
    name: "worker_result",
    arguments: { id: "task-bbbbbbbbbbbbbbbb" }
  }, options);
  assert.equal(failed.isError, true);
  assert.deepEqual(failed.structuredContent.error, {
    code: "E_JOB_NOT_FOUND",
    message: "Worker was not found."
  });
  assert.equal(JSON.stringify(failed).includes("/private/repository"), false);
  assert.equal(JSON.stringify(failed).includes("xai-secret"), false);
});

test("bundled STDIO server and Codex plugin manifests form one MCP contract", () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, "plugins/grok/.codex-plugin/plugin.json"), "utf8"));
  const mcp = JSON.parse(fs.readFileSync(path.join(ROOT, "plugins/grok/.mcp.json"), "utf8"));
  assert.equal(plugin.mcpServers, "./.mcp.json");
  assert.deepEqual(mcp.mcpServers.grok_workers, {
    cwd: ".",
    command: "node",
    args: ["./mcp/server.mjs"],
    env: { GROK_COMPANION_HOST: "codex" }
  });

  const request = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })
  ].join("\n") + "\n";
  const executed = run(process.execPath, [path.join(ROOT, "plugins/grok/mcp/server.mjs")], {
    cwd: path.join(ROOT, "plugins/grok"),
    input: request
  });
  assert.equal(executed.status, 0, executed.stderr);
  const replies = executed.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(replies[0].result.serverInfo.name, "grok-worker-broker");
  assert.equal(replies[1].result.tools.length, WORKER_TOOLS.length);
});
