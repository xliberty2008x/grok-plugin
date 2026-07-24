import { CompanionError } from "../scripts/lib/errors.mjs";
import {
  CODEX_MCP_EXPERIMENTAL_CAPABILITIES,
  resolveWorkerAuthority
} from "../scripts/lib/worker-authority.mjs";
import { MAX_WORKER_WAIT_MS, createWorkerService } from "../scripts/lib/worker-service.mjs";
import {
  MCP_CAPABILITY_CONTRACT_VERSION,
  ROOT_READ_PROVIDER_CAPABILITY,
  SAME_SESSION_READ_FOLLOWUP_PROVIDER_CAPABILITY,
  readValidProviderCapabilityReceipt
} from "../scripts/lib/provider-capability.mjs";
import { reconcileBrokerWorkers } from "../scripts/lib/worker-recovery.mjs";
import { codexMetadataCapabilityMatrix } from "../scripts/lib/worker-presentation.mjs";

export const MCP_SERVER_NAME = "grok-worker-broker";
export const MCP_SERVER_VERSION = MCP_CAPABILITY_CONTRACT_VERSION;

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
    workerId: { type: "string", minLength: 1, maxLength: 256 },
    sequence: { type: "integer", minimum: 0 }
  }
};

const WORKER_ID_SCHEMA = Object.freeze({ type: "string", minLength: 1, maxLength: 256 });

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

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

export const BASE_WORKER_TOOLS = deepFreeze([
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
      properties: { id: WORKER_ID_SCHEMA }
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
      properties: { id: WORKER_ID_SCHEMA, cursor: CURSOR_SCHEMA }
    },
    annotations: READ_ONLY_ANNOTATIONS
  },
  {
    name: "worker_wait",
    title: "Wait for Grok worker progress",
    description: "Wait up to 30 seconds for new lifecycle events or terminal state, draining this owned worker's durable launch outbox before authority-bound recovery maintenance.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: WORKER_ID_SCHEMA,
        cursor: CURSOR_SCHEMA,
        timeoutMs: { type: "integer", minimum: 0, maximum: MAX_WORKER_WAIT_MS }
      }
    },
    annotations: MUTATION_ANNOTATIONS
  },
  {
    name: "worker_result",
    title: "Get a Grok worker result",
    description: "Get the terminal public snapshot for a Grok worker owned by the current Codex task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: WORKER_ID_SCHEMA }
    },
    annotations: READ_ONLY_ANNOTATIONS
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
        id: WORKER_ID_SCHEMA,
        idempotencyKey: { type: "string", minLength: 8, maxLength: 256 }
      }
    },
    annotations: CANCEL_ANNOTATIONS
  }
]);

export const WORKER_SPAWN_TOOL = deepFreeze({
  name: "worker_spawn",
  title: "Spawn a read-only Grok worker",
  description: "Idempotently commit a durable read-only Grok worker job under the installed provider capability receipt. Success means durable commit, not provider startup.",
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
        enum: ["explorer"]
      }
    }
  },
  annotations: MUTATION_ANNOTATIONS
});

export const WORKER_DECIDE_HOST_ACTION_TOOL = deepFreeze({
  name: "worker_decide_host_action",
  title: "Decide a Grok worker host action",
  description: "Idempotently grant or deny the exact future read-only role admission requested by an owned terminal Grok worker.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["id", "requestId", "decision", "idempotencyKey"],
    properties: {
      id: WORKER_ID_SCHEMA,
      requestId: { type: "string", minLength: 1, maxLength: 256 },
      decision: { type: "string", enum: ["grant", "deny"] },
      idempotencyKey: { type: "string", minLength: 8, maxLength: 256 }
    }
  },
  annotations: MUTATION_ANNOTATIONS
});

export const WORKER_FOLLOWUP_TOOL = deepFreeze({
  name: "worker_followup",
  title: "Continue a Grok worker session",
  description: "Idempotently commit one grant-bound read-only continuation in the exact provider session of an owned terminal Grok worker.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["id", "grantId", "message", "idempotencyKey"],
    properties: {
      id: WORKER_ID_SCHEMA,
      grantId: { type: "string", minLength: 1, maxLength: 256 },
      message: { type: "string", minLength: 1, maxLength: 16000 },
      idempotencyKey: { type: "string", minLength: 8, maxLength: 256 }
    }
  },
  annotations: MUTATION_ANNOTATIONS
});

/** Complete root-read continuation inventory; runtime advertisement is atomic. */
export const WORKER_TOOLS = deepFreeze([
  ...BASE_WORKER_TOOLS.slice(0, -1),
  WORKER_SPAWN_TOOL,
  WORKER_DECIDE_HOST_ACTION_TOOL,
  WORKER_FOLLOWUP_TOOL,
  BASE_WORKER_TOOLS.at(-1)
]);

const MUTATION_AUTHORITY_TOOLS = new Set([
  "worker_wait",
  "worker_spawn",
  "worker_decide_host_action",
  "worker_followup",
  "worker_cancel"
]);

const SHA256_HEX = /^[a-f0-9]{64}$/;

function validProviderCapabilityReceipt(receipt) {
  return Boolean(
    SHA256_HEX.test(receipt?.capabilityDigest || "")
    && Array.isArray(receipt?.capabilities)
    && receipt.capabilities.length === 2
    && receipt.capabilities[0] === ROOT_READ_PROVIDER_CAPABILITY
    && receipt.capabilities[1] === SAME_SESSION_READ_FOLLOWUP_PROVIDER_CAPABILITY
  );
}

export function createMcpBrokerRuntime({
  env = process.env,
  providerCapabilityReceipt = undefined
} = {}) {
  const receipt = providerCapabilityReceipt === undefined
    ? readValidProviderCapabilityReceipt({ env })
    : providerCapabilityReceipt;
  const providerCapabilityDigest = validProviderCapabilityReceipt(receipt)
    ? receipt.capabilityDigest
    : null;
  const tools = deepFreeze(providerCapabilityDigest
    ? [...WORKER_TOOLS]
    : [...BASE_WORKER_TOOLS]);
  return Object.freeze({
    tools,
    providerCapabilityDigest
  });
}

// The default server imports this module once per process, so this is a
// freeze-at-server-start capability snapshot. A refreshed setup receipt takes
// effect after reconnect/restart rather than mutating tools/list mid-session.
const DEFAULT_BROKER_RUNTIME = createMcpBrokerRuntime();

function brokerRuntime(options) {
  return options?.runtime || DEFAULT_BROKER_RUNTIME;
}

function currentProviderCapabilityDigest(runtime, options) {
  if (!SHA256_HEX.test(runtime?.providerCapabilityDigest || "")) return null;
  try {
    const readReceipt = options?.readProviderCapabilityReceipt
      || readValidProviderCapabilityReceipt;
    const receipt = readReceipt({ env: options?.env || process.env });
    return validProviderCapabilityReceipt(receipt)
      && receipt.capabilityDigest === runtime.providerCapabilityDigest
      ? receipt.capabilityDigest
      : null;
  } catch {
    return null;
  }
}

function schemaAccepts(value, schema) {
  if (!schema || typeof schema !== "object") return false;
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const properties = schema.properties || {};
    if (schema.additionalProperties === false
      && Object.keys(value).some((key) => !Object.hasOwn(properties, key))) return false;
    if ((schema.required || []).some((key) => !Object.hasOwn(value, key))) return false;
    return Object.entries(value).every(([key, entry]) => (
      Object.hasOwn(properties, key) && schemaAccepts(entry, properties[key])
    ));
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return false;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xD800 && code <= 0xDBFF) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
        index += 1;
      } else if (code >= 0xDC00 && code <= 0xDFFF) {
        return false;
      }
    }
    // JSON Schema measures string length in Unicode code points, not UTF-16
    // code units. Keep runtime admission identical to the advertised schema
    // for astral characters as well as ASCII.
    const length = Array.from(value).length;
    if (Number.isInteger(schema.minLength) && length < schema.minLength) return false;
    if (Number.isInteger(schema.maxLength) && length > schema.maxLength) return false;
  } else if (schema.type === "integer") {
    if (!Number.isSafeInteger(value)) return false;
    if (Number.isFinite(schema.minimum) && value < schema.minimum) return false;
    if (Number.isFinite(schema.maximum) && value > schema.maximum) return false;
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") return false;
  } else {
    return false;
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  return true;
}

function assertArguments(runtime, name, value) {
  const args = value == null ? {} : value;
  const schema = runtime.tools.find((tool) => tool.name === name)?.inputSchema;
  if (!schemaAccepts(args, schema)) {
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
    E_CAPABILITY: "Required worker broker capability is unavailable.",
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
  const runtime = brokerRuntime(options);
  if (!runtime.tools.some((tool) => tool.name === name)) {
    return ["worker_spawn", "worker_decide_host_action", "worker_followup"].includes(name)
      ? toolResult({ code: "E_CAPABILITY", message: "Required worker broker capability is unavailable." }, true)
      : toolResult({ code: "E_USAGE", message: "Invalid worker broker request." }, true);
  }
  // tools/list is frozen for the MCP process lifetime, but provider readiness
  // is not. Revalidate immediately before any new admission and again inside
  // the service so expiry, setup revocation, or binary/profile drift fail closed.
  if (["worker_spawn", "worker_decide_host_action", "worker_followup"].includes(name)
    && currentProviderCapabilityDigest(runtime, options) === null) {
    return toolResult({
      code: "E_CAPABILITY",
      message: "Required worker broker capability is unavailable."
    }, true);
  }
  try {
    // Authority is resolved before arguments or cursors are interpreted.
    const mutation = MUTATION_AUTHORITY_TOOLS.has(name);
    const authority = (options.resolveAuthority || ((meta) => resolveWorkerAuthority(meta, { mutation })))(params?._meta);
    const args = assertArguments(runtime, name, params?.arguments);
    const reconcileWorkers = options.reconcileWorkers || reconcileBrokerWorkers;
    const service = (options.createService || createWorkerService)({
      root: authority.root,
      principal: authority,
      env: options.env || process.env,
      ...(options.serviceOptions || {}),
      allowWriteSpawn: false,
      providerCapabilityDigest: runtime.providerCapabilityDigest,
      validateProviderCapability: () => currentProviderCapabilityDigest(runtime, options),
      allowUnboundDispatch: false,
      maintain: () => reconcileWorkers({
        root: authority.root,
        principal: authority,
        env: options.env || process.env
      })
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
        write: false
      });
      return toolResult({
        worker: spawned.handle,
        replayed: spawned.replayed,
        spawnSuccessDefinition: spawned.spawnSuccessDefinition,
        providerLaunchState: spawned.providerLaunchState,
        providerLaunched: spawned.providerLaunched
      });
    }
    if (name === "worker_decide_host_action") {
      const decided = service.decideRoleAdmission({
        id: args.id,
        requestId: args.requestId,
        decision: args.decision,
        idempotencyKey: args.idempotencyKey
      });
      return toolResult({
        decision: {
          workerId: decided.workerId,
          requestId: decided.requestId,
          requestedRoleId: decided.requestedRoleId,
          decision: decided.decision,
          decidedAt: decided.decidedAt,
          application: decided.application,
          applied: decided.applied,
          grant: decided.grant
            ? {
                grantId: decided.grant.grantId,
                requestedRoleId: decided.grant.requestedRoleId,
                application: decided.grant.application,
                applied: decided.grant.applied,
                consumable: decided.grant.consumable
              }
            : null,
          replayed: decided.replayed
        }
      });
    }
    if (name === "worker_followup") {
      const followed = service.followup({
        id: args.id,
        grantId: args.grantId,
        message: args.message,
        idempotencyKey: args.idempotencyKey
      });
      return toolResult({
        worker: followed.handle,
        replayed: followed.replayed,
        spawnSuccessDefinition: followed.spawnSuccessDefinition,
        providerLaunchState: followed.providerLaunchState,
        providerLaunched: followed.providerLaunched
      });
    }
    if (name === "worker_cancel") {
      const cancelled = service.cancel({
        id: args.id,
        idempotencyKey: args.idempotencyKey
      });
      return toolResult({ receipt: cancelled.receipt, replayed: cancelled.replayed });
    }
    return toolResult({ code: "E_USAGE", message: "Invalid worker broker request." }, true);
  } catch (error) {
    return toolResult(publicError(error), true);
  }
}

export async function handleMcpRequest(message, options = {}) {
  const { id, method, params } = message || {};
  const runtime = brokerRuntime(options);
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
          instructions: "Task-owned Grok worker broker (structured list/get/events/wait/result/cancel, plus read-only spawn and exact grant-bound same-session follow-up only when advertised). Grok workers are external, not native host subagents. Host verification is not trusted or promoted by this MCP surface.",
          _meta: {
            "grok/capability-matrix": capability,
            "grok/capabilityDigest": runtime.providerCapabilityDigest,
            "grok/hostVerification": "suppressed",
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
    return { jsonrpc: "2.0", id, result: { tools: runtime.tools } };
  }
  if (method === "tools/call") {
    return { jsonrpc: "2.0", id, result: await callWorkerTool(params, { ...options, runtime }) };
  }
  if (id === undefined) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found." } };
}
