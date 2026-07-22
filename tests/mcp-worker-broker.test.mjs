import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  BASE_WORKER_TOOLS,
  WORKER_TOOLS,
  callWorkerTool,
  createMcpBrokerRuntime,
  handleMcpRequest
} from "../plugins/grok/mcp/broker.mjs";
import { ROOT_READ_PROVIDER_CAPABILITY } from "../plugins/grok/scripts/lib/provider-capability.mjs";
import { MCP_SANDBOX_STATE_META_CAPABILITY } from "../plugins/grok/scripts/lib/worker-authority.mjs";
import { ROOT, run, tempDir } from "./helpers.mjs";

const PRINCIPAL = Object.freeze({
  hostKind: "codex",
  threadId: "019f666a-6469-7cc1-9a8d-8c1adf61e103",
  turnId: "019f666e-4084-7902-8447-249f72043a37",
  source: "codex-mcp-stdio",
  root: ROOT
});
const BASE_RUNTIME = createMcpBrokerRuntime({ providerCapabilityReceipt: null });
const SPAWN_RECEIPT = Object.freeze({
  capabilityDigest: "a".repeat(64),
  capabilities: [ROOT_READ_PROVIDER_CAPABILITY]
});
const SPAWN_RUNTIME = createMcpBrokerRuntime({
  providerCapabilityReceipt: SPAWN_RECEIPT
});
const LIVE_SPAWN_OPTIONS = Object.freeze({
  runtime: SPAWN_RUNTIME,
  readProviderCapabilityReceipt: () => SPAWN_RECEIPT
});

test("MCP broker advertises sandbox metadata, pins protocol versions, and lists structured tools", async () => {
  const initialized = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25" }
  }, { runtime: BASE_RUNTIME });
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
  }, { runtime: BASE_RUNTIME });
  assert.equal(rejected.error.code, -32602);

  const listed = await handleMcpRequest(
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { runtime: BASE_RUNTIME }
  );
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
    "worker_list_owned",
    "worker_get",
    "worker_events_after",
    "worker_wait",
    "worker_result",
    "worker_cancel"
  ]);
  assert.deepEqual(listed.result.tools, BASE_WORKER_TOOLS);
  const full = await handleMcpRequest(
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
    { runtime: SPAWN_RUNTIME }
  );
  assert.deepEqual(full.result.tools.map((tool) => tool.name), [
    "worker_list_owned",
    "worker_get",
    "worker_events_after",
    "worker_wait",
    "worker_result",
    "worker_spawn",
    "worker_cancel"
  ]);
  assert.deepEqual(full.result.tools, WORKER_TOOLS);
  assert.equal(full.result.tools.some((tool) => ["worker_send", "worker_followup"].includes(tool.name)), false);
  assert.equal(Object.hasOwn(full.result.tools.find((tool) => tool.name === "worker_spawn").inputSchema.properties, "write"), false);
  for (const tool of listed.result.tools) {
    assert.equal(tool.annotations.idempotentHint, true);
    const schema = JSON.stringify(tool.inputSchema);
    for (const forbidden of ["root", "threadId", "sessionId", "workspace", "owner", "all"]) {
      assert.equal(schema.includes(`\"${forbidden}\"`), false);
    }
  }
  const readOnly = listed.result.tools.filter((tool) => tool.annotations.readOnlyHint);
  assert.equal(readOnly.length, 4);
  const wait = listed.result.tools.find((tool) => tool.name === "worker_wait");
  assert.equal(wait.annotations.readOnlyHint, false);
  assert.equal(wait.annotations.destructiveHint, false);
  assert.match(wait.description, /recovery maintenance/);
});

test("worker_wait requires mutation authority before recovery-capable service creation", async () => {
  let serviceCreated = false;
  const withoutPluginId = {
    threadId: PRINCIPAL.threadId,
    "x-codex-turn-metadata": {
      thread_id: PRINCIPAL.threadId,
      turn_id: PRINCIPAL.turnId
    },
    [MCP_SANDBOX_STATE_META_CAPABILITY]: {
      sandboxCwd: pathToFileURL(ROOT).href
    }
  };
  const rejected = await callWorkerTool({
    name: "worker_wait",
    arguments: { id: "task-aaaaaaaaaaaaaaaa", timeoutMs: 0 },
    _meta: withoutPluginId
  }, {
    runtime: BASE_RUNTIME,
    createService() {
      serviceCreated = true;
      throw new Error("must not run");
    }
  });
  assert.equal(rejected.isError, true);
  assert.deepEqual(rejected.structuredContent.error, {
    code: "E_AUTH_REQUIRED",
    message: "Trusted Codex task identity is unavailable."
  });
  assert.equal(serviceCreated, false);
});

test("frozen broker runtime cannot be widened and hidden operations never reach service", async () => {
  assert.equal(Object.hasOwn(SPAWN_RUNTIME, "toolNames"), false);
  assert.equal(Object.hasOwn(SPAWN_RUNTIME, "toolByName"), false);
  assert.throws(() => SPAWN_RUNTIME.tools.push({ name: "worker_send" }), TypeError);
  assert.throws(() => {
    SPAWN_RUNTIME.tools[0].inputSchema.properties.root = { type: "string" };
  }, TypeError);

  for (const name of ["worker_send", "worker_followup", "worker_spawn"]) {
    let serviceCreated = false;
    const runtime = name === "worker_spawn" ? BASE_RUNTIME : SPAWN_RUNTIME;
    const result = await callWorkerTool({ name, arguments: {} }, {
      runtime,
      resolveAuthority() {
        throw new Error("hidden calls must fail before authority resolution");
      },
      createService() {
        serviceCreated = true;
        throw new Error("hidden calls must fail before service creation");
      }
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, name === "worker_spawn" ? "E_CAPABILITY" : "E_USAGE");
    assert.equal(serviceCreated, false);
  }
});

test("spawn revalidates the live receipt before authority or service admission", async () => {
  const unavailable = [
    ["expired", null],
    ["cleared", null],
    ["binary-drift", null],
    ["digest-drift", { ...SPAWN_RECEIPT, capabilityDigest: "b".repeat(64) }]
  ];
  for (const [label, currentReceipt] of unavailable) {
    let authorityResolved = false;
    let serviceCreated = false;
    const result = await callWorkerTool({
      name: "worker_spawn",
      arguments: {
        idempotencyKey: `live-receipt-${label}-0001`,
        userRequest: "Must not be admitted"
      }
    }, {
      runtime: SPAWN_RUNTIME,
      readProviderCapabilityReceipt: () => currentReceipt,
      resolveAuthority() {
        authorityResolved = true;
        return PRINCIPAL;
      },
      createService() {
        serviceCreated = true;
        throw new Error("invalid live receipt must not reach service");
      }
    });
    assert.equal(result.isError, true, label);
    assert.equal(result.structuredContent.error.code, "E_CAPABILITY", label);
    assert.equal(authorityResolved, false, label);
    assert.equal(serviceCreated, false, label);
  }
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

test("MCP calls enforce the advertised input schemas without Boolean coercion", async () => {
  const invalid = [
    { name: "worker_list_owned", arguments: { extra: true } },
    { name: "worker_get", arguments: { id: "" } },
    {
      name: "worker_wait",
      arguments: {
        id: "task-aaaaaaaaaaaaaaaa",
        cursor: { schemaVersion: 1, workerId: "task-aaaaaaaaaaaaaaaa", sequence: 0, extra: true }
      }
    },
    { name: "worker_wait", arguments: { id: "task-aaaaaaaaaaaaaaaa", timeoutMs: 1.5 } },
    { name: "worker_wait", arguments: { id: "task-aaaaaaaaaaaaaaaa", timeoutMs: 30_001 } },
    {
      name: "worker_spawn",
      arguments: { idempotencyKey: "schema-0001", userRequest: "valid", objective: {} }
    },
    {
      name: "worker_spawn",
      arguments: { idempotencyKey: "schema-0002", userRequest: "valid", write: "false" }
    },
    {
      name: "worker_spawn",
      arguments: { idempotencyKey: "short", userRequest: "valid" }
    },
    {
      name: "worker_spawn",
      arguments: { idempotencyKey: "schema-0003", userRequest: "valid", roleId: "root" }
    },
    {
      name: "worker_spawn",
      arguments: { idempotencyKey: "schema-0005", userRequest: "valid", roleId: "reviewer" }
    },
    {
      name: "worker_send",
      arguments: { id: "task-aaaaaaaaaaaaaaaa", idempotencyKey: "schema-0004", message: "" }
    }
  ];
  for (const request of invalid) {
    let serviceCreated = false;
    const result = await callWorkerTool(request, {
      ...LIVE_SPAWN_OPTIONS,
      resolveAuthority: () => PRINCIPAL,
      createService() {
        serviceCreated = true;
        throw new Error("invalid input must not reach the service");
      }
    });
    assert.equal(result.isError, true, JSON.stringify(request));
    assert.equal(result.structuredContent.error.code, "E_USAGE", JSON.stringify(request));
    assert.equal(serviceCreated, false, JSON.stringify(request));
  }

  let observed = null;
  let serviceConfiguration = null;
  const valid = await callWorkerTool({
    name: "worker_spawn",
    arguments: {
      idempotencyKey: "schema-valid-0001",
      userRequest: "valid request",
      objective: "public objective",
      roleId: "explorer"
    }
  }, {
    ...LIVE_SPAWN_OPTIONS,
    resolveAuthority: () => PRINCIPAL,
    createService: (configuration) => {
      serviceConfiguration = configuration;
      return {
        spawn(options) {
          observed = options;
          return {
            handle: { id: "task-aaaaaaaaaaaaaaaa" },
            replayed: false,
            spawnSuccessDefinition: "durable_commit",
            providerLaunchState: "pending",
            providerLaunched: false
          };
        }
      };
    }
  });
  assert.equal(valid.isError, undefined);
  assert.equal(observed.write, false);
  assert.equal(observed.objective, "public objective");
  assert.equal(serviceConfiguration.allowWriteSpawn, false);
  assert.equal(serviceConfiguration.allowUnboundDispatch, false);
  assert.equal(serviceConfiguration.providerCapabilityDigest, "a".repeat(64));
  assert.equal(serviceConfiguration.validateProviderCapability(), "a".repeat(64));

  const unicodeRequest = "😀".repeat(10_000);
  const unicodeValid = await callWorkerTool({
    name: "worker_spawn",
    arguments: {
      idempotencyKey: "schema-unicode-0001",
      userRequest: unicodeRequest
    }
  }, {
    ...LIVE_SPAWN_OPTIONS,
    resolveAuthority: () => PRINCIPAL,
    createService: () => ({
      spawn(options) {
        observed = options;
        return {
          handle: { id: "task-bbbbbbbbbbbbbbbb" },
          replayed: false,
          spawnSuccessDefinition: "durable_commit",
          providerLaunchState: "pending",
          providerLaunched: false
        };
      }
    })
  });
  assert.equal(unicodeValid.isError, undefined);
  assert.equal(observed.userRequest, unicodeRequest);
});

test("MCP broker routes owned reads and allowlists errors without private details", async () => {
  const options = {
    runtime: BASE_RUNTIME,
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
  const serverEnv = {
    ...process.env,
    GROK_COMPANION_HOST: "codex",
    PLUGIN_DATA: tempDir("grok-mcp-no-provider-capability-")
  };
  delete serverEnv.GROK_COMPANION_PLUGIN_DATA;
  delete serverEnv.CLAUDE_PLUGIN_DATA;
  const executed = run(process.execPath, [path.join(ROOT, "plugins/grok/mcp/server.mjs")], {
    cwd: path.join(ROOT, "plugins/grok"),
    input: request,
    env: serverEnv
  });
  assert.equal(executed.status, 0, executed.stderr);
  const replies = executed.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(replies[0].result.serverInfo.name, "grok-worker-broker");
  assert.deepEqual(replies[1].result.tools.map((tool) => tool.name), BASE_WORKER_TOOLS.map((tool) => tool.name));
});
