import { CompanionError } from "../scripts/lib/errors.mjs";
import {
  CODEX_MCP_EXPERIMENTAL_CAPABILITIES,
  resolveWorkerAuthority
} from "../scripts/lib/worker-authority.mjs";
import { MAX_WORKER_WAIT_MS, createWorkerService } from "../scripts/lib/worker-service.mjs";
import { codexMetadataCapabilityMatrix } from "../scripts/lib/worker-presentation.mjs";

export const MCP_SERVER_NAME = "grok-worker-broker";
export const MCP_SERVER_VERSION = "1.1.0";

/** Fail-closed supported MCP protocol versions. */
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = Object.freeze([
  "2025-11-25",
  "2025-06-18",
  "2024-11-05"
]);
export const DEFAULT_MCP_PROTOCOL_VERSION = "2025-11-25";

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

const MUTATION_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
});

const CANCEL_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
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
  },
  {
    name: "worker_spawn",
    title: "Spawn a read-only Grok worker",
    description: "Idempotently commit a durable read-only Grok worker job. Success means durable commit, not provider startup. Write spawn is rejected until Phase 3.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["idempotencyKey", "userRequest"],
      properties: {
        idempotencyKey: { type: "string", minLength: 8, maxLength: 256 },
        userRequest: { type: "string", minLength: 1, maxLength: 16000 },
        objective: { type: "string", maxLength: 4000 },
        roleId: {
          type: "string",
          enum: ["explorer", "implementer", "reviewer", "security", "test"]
        },
        write: { type: "boolean", description: "Must be false until Phase 3 worktrees enable broker write spawn." }
      }
    },
    annotations: MUTATION_ANNOTATIONS
  },
  {
    name: "worker_cancel",
    title: "Cancel a Grok worker",
    description: "Idempotently request cancellation. Returns an immutable receipt; exactly one cancellation-request event is recorded.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id", "idempotencyKey"],
      properties: {
        id: { type: "string" },
        idempotencyKey: { type: "string", minLength: 8, maxLength: 256 }
      }
    },
    annotations: CANCEL_ANNOTATIONS
  },
  {
    name: "worker_send",
    title: "Send a message to an active Grok worker",
    description: "Durable mailbox send with explicit delivery outcome (delivered, rejected, or delivery_unknown).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id", "message", "idempotencyKey"],
      properties: {
        id: { type: "string" },
        message: { type: "string", minLength: 1, maxLength: 16000 },
        idempotencyKey: { type: "string", minLength: 8, maxLength: 256 }
      }
    },
    annotations: MUTATION_ANNOTATIONS
  },
  {
    name: "worker_followup",
    title: "Follow up a terminal Grok worker",
    description: "Lineage-preserving follow-up spawn for a terminal or idle worker.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id", "message", "idempotencyKey"],
      properties: {
        id: { type: "string" },
        message: { type: "string", minLength: 1, maxLength: 16000 },
        idempotencyKey: { type: "string", minLength: 8, maxLength: 256 }
      }
    },
    annotations: MUTATION_ANNOTATIONS
  }
]);

const TOOL_NAMES = new Set(WORKER_TOOLS.map((tool) => tool.name));
const MUTATION_TOOLS = new Set([
  "worker_spawn",
  "worker_cancel",
  "worker_send",
  "worker_followup"
]);
const ALLOWED_ARGUMENTS = Object.freeze({
  worker_list_owned: [],
  worker_get: ["id"],
  worker_events_after: ["id", "cursor"],
  worker_wait: ["id", "cursor", "timeoutMs"],
  worker_result: ["id"],
  worker_spawn: ["idempotencyKey", "userRequest", "objective", "roleId", "write"],
  worker_cancel: ["id", "idempotencyKey"],
  worker_send: ["id", "message", "idempotencyKey"],
  worker_followup: ["id", "message", "idempotencyKey"]
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
  if (name !== "worker_list_owned" && name !== "worker_spawn") {
    if (typeof args.id !== "string" || !args.id) {
      throw new CompanionError("E_USAGE", "Invalid worker broker request.");
    }
  }
  if (MUTATION_TOOLS.has(name)) {
    if (typeof args.idempotencyKey !== "string" || !args.idempotencyKey) {
      throw new CompanionError("E_USAGE", "Invalid worker broker request.");
    }
  }
  if (name === "worker_spawn" && (typeof args.userRequest !== "string" || !args.userRequest)) {
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
    "E_USAGE",
    "E_CANCELLED",
    "E_IDEMPOTENCY_CONFLICT",
    "E_SCOPE_VIOLATION",
    "E_CONTEXT_DRIFT",
    "E_DELIVERY",
    "E_ROLE",
    "E_WORKTREE",
    "E_INTEGRATION",
    "E_POLICY"
  ].includes(error?.code) ? error.code : "E_BROKER";
  const messages = {
    E_AUTH_REQUIRED: "Trusted Codex task identity is unavailable.",
    E_CAPABILITY: "Trusted Codex workspace metadata is unavailable.",
    E_JOB_NOT_FOUND: "Worker was not found.",
    E_JOB_ACTIVE: "Worker result is not available yet.",
    E_USAGE: "Invalid worker broker request.",
    E_CANCELLED: "Worker was cancelled.",
    E_IDEMPOTENCY_CONFLICT: "Idempotency key conflict.",
    E_SCOPE_VIOLATION: "Scope violation.",
    E_CONTEXT_DRIFT: "Context or profile drift detected.",
    E_DELIVERY: "Mailbox delivery error.",
    E_ROLE: "Worker role error.",
    E_WORKTREE: "Worktree error.",
    E_INTEGRATION: "Integration validation failed.",
    E_POLICY: "Policy violation.",
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

export function negotiateMcpProtocolVersion(requested) {
  if (requested == null || requested === "") {
    return DEFAULT_MCP_PROTOCOL_VERSION;
  }
  if (!SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(requested)) {
    throw new CompanionError(
      "E_CAPABILITY",
      `Unsupported MCP protocol version ${requested}.`
    );
  }
  return requested;
}

export async function callWorkerTool(params, options = {}) {
  const name = params?.name;
  if (!TOOL_NAMES.has(name)) {
    return toolResult({ code: "E_USAGE", message: "Invalid worker broker request." }, true);
  }
  try {
    // Authority is resolved before arguments or cursors are interpreted.
    const mutation = MUTATION_TOOLS.has(name);
    const authority = (options.resolveAuthority || ((meta) => resolveWorkerAuthority(meta, { mutation })))(params?._meta);
    const args = assertArguments(name, params?.arguments);
    const service = (options.createService || createWorkerService)({
      root: authority.root,
      principal: authority,
      env: options.env || process.env,
      allowWriteSpawn: Boolean(options.allowWriteSpawn),
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
    if (name === "worker_result") return toolResult({ worker: service.result(args.id) });
    if (name === "worker_spawn") {
      const spawned = service.spawn({
        userRequest: args.userRequest,
        objective: args.objective,
        idempotencyKey: args.idempotencyKey,
        roleId: args.roleId || "explorer",
        write: Boolean(args.write)
      });
      return toolResult({
        worker: spawned.handle,
        replayed: spawned.replayed,
        spawnSuccessDefinition: spawned.spawnSuccessDefinition,
        providerLaunched: spawned.providerLaunched
      });
    }
    if (name === "worker_cancel") {
      const cancelled = service.cancel({
        id: args.id,
        idempotencyKey: args.idempotencyKey
      });
      return toolResult({ receipt: cancelled.receipt, replayed: cancelled.replayed });
    }
    if (name === "worker_send") {
      const sent = service.send({
        id: args.id,
        message: args.message,
        idempotencyKey: args.idempotencyKey
      });
      return toolResult({ receipt: sent.receipt, replayed: sent.replayed });
    }
    if (name === "worker_followup") {
      const followed = service.followup({
        id: args.id,
        message: args.message,
        idempotencyKey: args.idempotencyKey
      });
      return toolResult({ worker: followed.handle, replayed: followed.replayed });
    }
    return toolResult({ code: "E_USAGE", message: "Invalid worker broker request." }, true);
  } catch (error) {
    return toolResult(publicError(error), true);
  }
}

export async function handleMcpRequest(message, options = {}) {
  const { id, method, params } = message || {};
  if (method === "initialize") {
    try {
      const protocolVersion = negotiateMcpProtocolVersion(params?.protocolVersion);
      const capability = codexMetadataCapabilityMatrix(params?._meta || {});
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false },
            experimental: CODEX_MCP_EXPERIMENTAL_CAPABILITIES
          },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
          instructions: "Task-owned Grok worker broker (structured spawn/list/get/wait/result/cancel/send/followup). Grok workers are external, not native host subagents.",
          _meta: {
            "grok/capability-matrix": capability,
            "grok/supportedProtocolVersions": SUPPORTED_MCP_PROTOCOL_VERSIONS,
            "grok/externalWorkerLabel": "external-grok-worker"
          }
        }
      };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: publicError(error).message,
          data: publicError(error)
        }
      };
    }
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
