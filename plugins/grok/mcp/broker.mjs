import { CompanionError } from "../scripts/lib/errors.mjs";
import {
  CODEX_MCP_EXPERIMENTAL_CAPABILITIES,
  resolveWorkerAuthority
} from "../scripts/lib/worker-authority.mjs";
import { MAX_WORKER_WAIT_MS, createWorkerService } from "../scripts/lib/worker-service.mjs";

export const MCP_SERVER_NAME = "grok-worker-broker";
export const MCP_SERVER_VERSION = "1.0.0";

const CURSOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "workerId", "sequence"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    workerId: { type: "string" },
    sequence: { type: "integer", minimum: 0 }
  }
};

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
});

export const WORKER_TOOLS = Object.freeze([
  {
    name: "worker_list_owned",
    title: "List owned Grok workers",
    description: "List public handles for Grok workers owned by the current Codex task in this repository.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: READ_ONLY_ANNOTATIONS
  },
  {
    name: "worker_get",
    title: "Get a Grok worker",
    description: "Get the public snapshot of one Grok worker owned by the current Codex task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string" } }
    },
    annotations: READ_ONLY_ANNOTATIONS
  },
  {
    name: "worker_events_after",
    title: "Read Grok worker events",
    description: "Read lifecycle events after an optional worker-bound cursor.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string" }, cursor: CURSOR_SCHEMA }
    },
    annotations: READ_ONLY_ANNOTATIONS
  },
  {
    name: "worker_wait",
    title: "Wait for Grok worker progress",
    description: "Wait up to 30 seconds for new lifecycle events or terminal state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string" },
        cursor: CURSOR_SCHEMA,
        timeoutMs: { type: "integer", minimum: 0, maximum: MAX_WORKER_WAIT_MS }
      }
    },
    annotations: READ_ONLY_ANNOTATIONS
  },
  {
    name: "worker_result",
    title: "Get a Grok worker result",
    description: "Get the terminal public snapshot for a Grok worker owned by the current Codex task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string" } }
    },
    annotations: READ_ONLY_ANNOTATIONS
  }
]);

const TOOL_NAMES = new Set(WORKER_TOOLS.map((tool) => tool.name));
const ALLOWED_ARGUMENTS = Object.freeze({
  worker_list_owned: [],
  worker_get: ["id"],
  worker_events_after: ["id", "cursor"],
  worker_wait: ["id", "cursor", "timeoutMs"],
  worker_result: ["id"]
});

function assertArguments(name, value) {
  const args = value == null ? {} : value;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new CompanionError("E_USAGE", "Invalid worker broker request.");
  }
  const allowed = new Set(ALLOWED_ARGUMENTS[name]);
  if (Object.keys(args).some((key) => !allowed.has(key))) {
    throw new CompanionError("E_USAGE", "Invalid worker broker request.");
  }
  if (name !== "worker_list_owned" && (typeof args.id !== "string" || !args.id)) {
    throw new CompanionError("E_USAGE", "Invalid worker broker request.");
  }
  return args;
}

function publicError(error) {
  const code = [
    "E_AUTH_REQUIRED",
    "E_CAPABILITY",
    "E_JOB_NOT_FOUND",
    "E_JOB_ACTIVE",
    "E_USAGE"
  ].includes(error?.code) ? error.code : "E_BROKER";
  const messages = {
    E_AUTH_REQUIRED: "Trusted Codex task identity is unavailable.",
    E_CAPABILITY: "Trusted Codex workspace metadata is unavailable.",
    E_JOB_NOT_FOUND: "Worker was not found.",
    E_JOB_ACTIVE: "Worker result is not available yet.",
    E_USAGE: "Invalid worker broker request.",
    E_BROKER: "Worker broker request failed."
  };
  return { code, message: messages[code] };
}

function toolResult(payload, isError = false) {
  const structuredContent = isError
    ? { ok: false, error: payload }
    : { ok: true, ...payload };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    ...(isError ? { isError: true } : {})
  };
}

export async function callWorkerTool(params, options = {}) {
  const name = params?.name;
  if (!TOOL_NAMES.has(name)) {
    return toolResult({ code: "E_USAGE", message: "Invalid worker broker request." }, true);
  }
  try {
    // Authority is resolved before arguments or cursors are interpreted.
    const authority = (options.resolveAuthority || resolveWorkerAuthority)(params?._meta);
    const args = assertArguments(name, params?.arguments);
    const service = (options.createService || createWorkerService)({
      root: authority.root,
      principal: authority,
      env: options.env || process.env,
      ...(options.serviceOptions || {})
    });
    if (name === "worker_list_owned") return toolResult({ workers: service.listOwned() });
    if (name === "worker_get") return toolResult({ worker: service.get(args.id) });
    if (name === "worker_events_after") {
      return toolResult({ stream: service.eventsAfter(args.id, args.cursor ?? null) });
    }
    if (name === "worker_wait") {
      return toolResult({ stream: await service.wait(args.id, {
        cursor: args.cursor ?? null,
        timeoutMs: args.timeoutMs
      }) });
    }
    return toolResult({ worker: service.result(args.id) });
  } catch (error) {
    return toolResult(publicError(error), true);
  }
}

export async function handleMcpRequest(message, options = {}) {
  const { id, method, params } = message || {};
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2025-11-25",
        capabilities: {
          tools: { listChanged: false },
          experimental: CODEX_MCP_EXPERIMENTAL_CAPABILITIES
        },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        instructions: "Read-only task-owned Grok worker status and result broker."
      }
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: WORKER_TOOLS } };
  }
  if (method === "tools/call") {
    return { jsonrpc: "2.0", id, result: await callWorkerTool(params, options) };
  }
  if (id === undefined) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found." } };
}
