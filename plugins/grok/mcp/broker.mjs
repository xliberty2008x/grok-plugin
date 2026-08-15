import crypto from "node:crypto";

import { CompanionError } from "../scripts/lib/errors.mjs";
import {
  CODEX_MCP_EXPERIMENTAL_CAPABILITIES,
  resolveWorkerAuthority
} from "../scripts/lib/worker-authority.mjs";
import { MAX_WORKER_WAIT_MS, createWorkerService } from "../scripts/lib/worker-service.mjs";
import {
  MCP_CAPABILITY_CONTRACT_VERSION,
  ORDERED_TURN_BOUNDARY_MAILBOX_PROVIDER_CAPABILITY,
  ROOT_READ_PROVIDER_CAPABILITY,
  SAME_SESSION_READ_FOLLOWUP_PROVIDER_CAPABILITY,
  readValidProviderCapabilityReceipt
} from "../scripts/lib/provider-capability.mjs";
import {
  assertProviderLaunchBinding,
  providerLaunchBindingDigest
} from "../scripts/lib/provider-executable-pin.mjs";
import { reconcileBrokerWorkers } from "../scripts/lib/worker-recovery.mjs";
import { codexMetadataCapabilityMatrix } from "../scripts/lib/worker-presentation.mjs";
import {
  EXACT_WRITE_VERTICAL_SCOPE,
  WRITE_VERTICAL_TARGET_PATH
} from "../scripts/lib/worker-worktree.mjs";

export const MCP_SERVER_NAME = "grok-worker-broker";
export const MCP_SERVER_VERSION = MCP_CAPABILITY_CONTRACT_VERSION;

/** Fail-closed supported MCP protocol versions. */
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = Object.freeze([
  "2025-11-25",
  "2025-06-18",
  "2024-11-05"
]);
export const DEFAULT_MCP_PROTOCOL_VERSION = "2025-11-25";
export const WRITE_SMOKE_ENV_VALUE = "p3-p4-target-txt-v1";
export const WRITE_SMOKE_CAPABILITY =
  "official-acp-target-txt-owner-lifecycle-v3";

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
    description: "Wait up to 30 seconds for new lifecycle events or terminal state, draining this owned worker's durable launch outbox before authority-bound recovery maintenance. Two or more ids wait for any owned worker to change and never launch a provider.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: WORKER_ID_SCHEMA,
        ids: {
          type: "array",
          minItems: 2,
          maxItems: 16,
          uniqueItems: true,
          items: WORKER_ID_SCHEMA
        },
        cursor: CURSOR_SCHEMA,
        cursors: {
          type: "array",
          minItems: 2,
          maxItems: 16,
          items: CURSOR_SCHEMA
        },
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

export const WORKER_SEND_TOOL = deepFreeze({
  name: "worker_send",
  title: "Send a Grok worker message",
  description: "Idempotently accept one ordered message for the active provider attempt. Acceptance is not delivery; terminal outcome is recorded by the provider-owned mailbox pump.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["id", "message", "idempotencyKey"],
    properties: {
      id: WORKER_ID_SCHEMA,
      message: { type: "string", minLength: 1, maxLength: 16000 },
      idempotencyKey: { type: "string", minLength: 8, maxLength: 256 }
    }
  },
  annotations: MUTATION_ANNOTATIONS
});

export const WORKER_SPAWN_WRITE_TOOL = deepFreeze({
  name: "worker_spawn_write",
  title: "Spawn the target.txt Grok write smoke",
  description: "Opt-in P3-P4 smoke only: idempotently commit one isolated implementer task scoped exactly to the existing tracked target.txt file.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["idempotencyKey", "userRequest"],
    properties: {
      idempotencyKey: { type: "string", minLength: 8, maxLength: 256 },
      userRequest: { type: "string", minLength: 1, maxLength: 16000 },
      objective: { type: "string", maxLength: 4000 }
    }
  },
  annotations: MUTATION_ANNOTATIONS
});

export const WORKER_ARTIFACT_TOOL = deepFreeze({
  name: "worker_artifact",
  title: "Read a target.txt worker artifact",
  description: "Read bounded content-addressed metadata, patch, or content for one completed owned write-smoke worker.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: WORKER_ID_SCHEMA,
      part: {
        type: "string",
        enum: ["metadata", "patch", "content"]
      }
    }
  },
  annotations: READ_ONLY_ANNOTATIONS
});

export const WORKER_PREVIEW_TOOL = deepFreeze({
  name: "worker_preview",
  title: "Preview a target.txt worker integration",
  description: "Recompute an owner-authorized, non-applying preview of one exact completed target.txt artifact against the current parent checkout.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["id", "manifestDigest"],
    properties: {
      id: WORKER_ID_SCHEMA,
      manifestDigest: { type: "string", minLength: 64, maxLength: 64 }
    }
  },
  annotations: READ_ONLY_ANNOTATIONS
});

export const WORKER_INTEGRATE_TOOL = deepFreeze({
  name: "worker_integrate",
  title: "Integrate a target.txt worker artifact",
  description: "Apply one exact owned target.txt artifact through the official Grok Build worktree API, then independently verify the parent checkout.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["id", "manifestDigest", "idempotencyKey"],
    properties: {
      id: WORKER_ID_SCHEMA,
      manifestDigest: { type: "string", minLength: 64, maxLength: 64 },
      idempotencyKey: { type: "string", minLength: 8, maxLength: 256 }
    }
  },
  annotations: CANCEL_ANNOTATIONS
});

export const WORKER_VERIFY_INTEGRATION_TOOL = deepFreeze({
  name: "worker_verify_integration",
  title: "Verify a target.txt worker integration",
  description: "Recompute the current exact parent effect for one owner-authorized durable integration receipt.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["id", "manifestDigest", "integrationReceiptDigest"],
    properties: {
      id: WORKER_ID_SCHEMA,
      manifestDigest: { type: "string", minLength: 64, maxLength: 64 },
      integrationReceiptDigest: {
        type: "string",
        minLength: 64,
        maxLength: 64
      }
    }
  },
  annotations: READ_ONLY_ANNOTATIONS
});

export const WORKER_ABANDON_TOOL = deepFreeze({
  name: "worker_abandon",
  title: "Abandon a completed target.txt worker",
  description: "Idempotently retain the immutable artifact while closing and deleting the exact session and officially removing only a proven non-applied managed worktree.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["id", "manifestDigest", "idempotencyKey"],
    properties: {
      id: WORKER_ID_SCHEMA,
      manifestDigest: { type: "string", minLength: 64, maxLength: 64 },
      idempotencyKey: { type: "string", minLength: 8, maxLength: 256 }
    }
  },
  annotations: CANCEL_ANNOTATIONS
});

export const WORKER_CLEANUP_TOOL = deepFreeze({
  name: "worker_cleanup",
  title: "Clean up a terminal target.txt worker",
  description: "Close and delete the exact owned provider session and remove its managed worktree through the official Grok Build API, then prove absence. Completed workers require their exact integration receipt; exact terminal-cancelled workers derive a discard cleanup from durable state.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["id", "idempotencyKey"],
    properties: {
      id: WORKER_ID_SCHEMA,
      integrationReceiptDigest: {
        type: "string",
        minLength: 64,
        maxLength: 64
      },
      idempotencyKey: { type: "string", minLength: 8, maxLength: 256 }
    }
  },
  annotations: CANCEL_ANNOTATIONS
});

/** Complete root-read continuation + ordered mailbox inventory; advertised atomically. */
export const WORKER_TOOLS = deepFreeze([
  ...BASE_WORKER_TOOLS.slice(0, -1),
  WORKER_SPAWN_TOOL,
  WORKER_DECIDE_HOST_ACTION_TOOL,
  WORKER_FOLLOWUP_TOOL,
  WORKER_SEND_TOOL,
  BASE_WORKER_TOOLS.at(-1)
]);

/** The opt-in smoke inventory is frozen independently from the default surface. */
export const WRITE_SMOKE_WORKER_TOOLS = deepFreeze([
  ...WORKER_TOOLS.slice(0, -1),
  WORKER_SPAWN_WRITE_TOOL,
  WORKER_ARTIFACT_TOOL,
  WORKER_PREVIEW_TOOL,
  WORKER_INTEGRATE_TOOL,
  WORKER_VERIFY_INTEGRATION_TOOL,
  WORKER_ABANDON_TOOL,
  WORKER_CLEANUP_TOOL,
  WORKER_TOOLS.at(-1)
]);

const MUTATION_AUTHORITY_TOOLS = new Set([
  "worker_wait",
  "worker_spawn",
  "worker_spawn_write",
  "worker_preview",
  "worker_integrate",
  "worker_verify_integration",
  "worker_abandon",
  "worker_cleanup",
  "worker_decide_host_action",
  "worker_followup",
  "worker_send",
  "worker_cancel"
]);

const SHA256_HEX = /^[a-f0-9]{64}$/;

function validProviderCapabilityReceipt(receipt) {
  try {
    const binding = assertProviderLaunchBinding(receipt?.providerLaunchBinding);
    return Boolean(
      SHA256_HEX.test(receipt?.capabilityDigest || "")
      && receipt?.providerLaunchBindingDigest === providerLaunchBindingDigest(binding)
      && Array.isArray(receipt?.capabilities)
      && receipt.capabilities.length === 3
      && receipt.capabilities[0] === ROOT_READ_PROVIDER_CAPABILITY
      && receipt.capabilities[1] === SAME_SESSION_READ_FOLLOWUP_PROVIDER_CAPABILITY
      && receipt.capabilities[2] === ORDERED_TURN_BOUNDARY_MAILBOX_PROVIDER_CAPABILITY
    );
  } catch {
    return false;
  }
}

function writeSmokeCapabilityDigest(providerCapabilityDigest, providerLaunchBindingDigestValue) {
  if (!SHA256_HEX.test(providerCapabilityDigest || "")
    || !SHA256_HEX.test(providerLaunchBindingDigestValue || "")) return null;
  return crypto.createHash("sha256").update(JSON.stringify({
    schemaVersion: 2,
    capability: WRITE_SMOKE_CAPABILITY,
    providerCapabilityDigest,
    providerLaunchBindingDigest: providerLaunchBindingDigestValue,
    tools: [
      WORKER_SPAWN_WRITE_TOOL.name,
      WORKER_ARTIFACT_TOOL.name,
      WORKER_PREVIEW_TOOL.name,
      WORKER_INTEGRATE_TOOL.name,
      WORKER_VERIFY_INTEGRATION_TOOL.name,
      WORKER_ABANDON_TOOL.name,
      WORKER_CLEANUP_TOOL.name
    ],
    targetPath: WRITE_VERTICAL_TARGET_PATH,
    scope: EXACT_WRITE_VERTICAL_SCOPE
  })).digest("hex");
}

export function createMcpBrokerRuntime({
  env = process.env,
  providerCapabilityReceipt = undefined,
  writeSmoke = env.GROK_COMPANION_WRITE_SMOKE === WRITE_SMOKE_ENV_VALUE
} = {}) {
  const receipt = providerCapabilityReceipt === undefined
    ? readValidProviderCapabilityReceipt({ env })
    : providerCapabilityReceipt;
  const providerCapabilityDigest = validProviderCapabilityReceipt(receipt)
    ? receipt.capabilityDigest
    : null;
  const providerLaunchBinding = providerCapabilityDigest
    ? assertProviderLaunchBinding(receipt.providerLaunchBinding)
    : null;
  const providerLaunchBindingDigestValue = providerCapabilityDigest
    ? receipt.providerLaunchBindingDigest
    : null;
  const writeLifecycleCapabilityDigest = writeSmoke === true
    ? writeSmokeCapabilityDigest(providerCapabilityDigest, providerLaunchBindingDigestValue)
    : null;
  const tools = deepFreeze(providerCapabilityDigest
    ? [...(writeLifecycleCapabilityDigest
        ? WRITE_SMOKE_WORKER_TOOLS
        : WORKER_TOOLS)]
    : [...BASE_WORKER_TOOLS]);
  return Object.freeze({
    tools,
    providerCapabilityDigest,
    providerLaunchBinding,
    providerLaunchBindingDigest: providerLaunchBindingDigestValue,
    writeLifecycleCapabilityDigest
  });
}

// The default server imports this module once per process, so this is a
// freeze-at-server-start capability snapshot. A refreshed setup receipt takes
// effect after reconnect/restart rather than mutating tools/list mid-session.
const DEFAULT_BROKER_RUNTIME = createMcpBrokerRuntime();

function brokerRuntime(options) {
  return options?.runtime || DEFAULT_BROKER_RUNTIME;
}

function readLiveProviderCapabilityReceipt(options) {
  const readReceipt = options?.readProviderCapabilityReceipt
    || readValidProviderCapabilityReceipt;
  try {
    return readReceipt({ env: options?.env || process.env });
  } catch {
    return null;
  }
}

function currentProviderCapabilityDigest(runtime, options) {
  if (!SHA256_HEX.test(runtime?.providerCapabilityDigest || "")) return null;
  const receipt = readLiveProviderCapabilityReceipt(options);
  return validProviderCapabilityReceipt(receipt)
    && receipt.capabilityDigest === runtime.providerCapabilityDigest
    && receipt.providerLaunchBindingDigest === runtime.providerLaunchBindingDigest
    && providerLaunchBindingDigest(receipt.providerLaunchBinding)
      === providerLaunchBindingDigest(runtime.providerLaunchBinding)
    ? receipt.capabilityDigest
    : null;
}

function providerCapabilityAdmissionError(runtime, options) {
  const frozen = SHA256_HEX.test(runtime?.providerCapabilityDigest || "");
  const receipt = readLiveProviderCapabilityReceipt(options);
  const liveValid = validProviderCapabilityReceipt(receipt);
  if (frozen && liveValid && receipt.capabilityDigest !== runtime.providerCapabilityDigest) {
    return {
      code: "E_CAPABILITY",
      message: "The MCP broker's frozen provider capability receipt is stale. Reconnect or restart the MCP server after setup so advertised worker tools can use the current receipt.",
      details: { reason: "stale_frozen_receipt" }
    };
  }
  if (frozen && !liveValid) {
    return {
      code: "E_CAPABILITY",
      message: "The MCP broker advertised worker tools from a setup receipt that is no longer valid. Run setup, then reconnect or restart the MCP server.",
      details: { reason: "receipt_unavailable" }
    };
  }
  return {
    code: "E_CAPABILITY",
    message: "Required worker broker capability is unavailable."
  };
}

function currentWriteLifecycleCapabilityDigest(runtime, options) {
  if (!SHA256_HEX.test(runtime?.writeLifecycleCapabilityDigest || "")) return null;
  const env = options?.env || process.env;
  if (env.GROK_COMPANION_WRITE_SMOKE !== WRITE_SMOKE_ENV_VALUE) return null;
  const providerDigest = currentProviderCapabilityDigest(runtime, options);
  const current = writeSmokeCapabilityDigest(
    providerDigest,
    runtime.providerLaunchBindingDigest
  );
  return current === runtime.writeLifecycleCapabilityDigest ? current : null;
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
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) return false;
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) return false;
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) return false;
    if (schema.uniqueItems) {
      const seen = new Set(value.map((item) => JSON.stringify(item)));
      if (seen.size !== value.length) return false;
    }
    return value.every((item) => schemaAccepts(item, schema.items || {}));
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
    "E_PROCESS_IDENTITY",
    "E_SCOPE_VIOLATION",
    "E_CONTEXT_DRIFT",
    "E_DELIVERY",
    "E_ROLE",
    "E_WORKTREE",
    "E_INTEGRATION",
    "E_OUTPUT_LIMIT",
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
    E_PROCESS_IDENTITY: "Process ownership verification failed.",
    E_SCOPE_VIOLATION: "Scope violation.",
    E_CONTEXT_DRIFT: "Context or profile drift detected.",
    E_DELIVERY: "Mailbox delivery error.",
    E_ROLE: "Worker role error.",
    E_WORKTREE: "Worktree error.",
    E_INTEGRATION: "Integration validation failed.",
    E_OUTPUT_LIMIT: "Worker artifact exceeds the bounded output limit.",
    E_POLICY: "Policy violation.",
    E_BROKER: "Worker broker request failed."
  };
  const projected = { code, message: messages[code] };
  const integrationClassifications = new Set([
    "unchanged",
    "exact-effect",
    "drift",
    "blocked",
    "apply-ambiguous"
  ]);
  if (code === "E_INTEGRATION"
    && integrationClassifications.has(error?.details?.classification)) {
    projected.details = {
      classification: error.details.classification
    };
  }
  return projected;
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
    return [
      "worker_spawn",
      "worker_spawn_write",
      "worker_artifact",
      "worker_preview",
      "worker_integrate",
      "worker_verify_integration",
      "worker_abandon",
      "worker_cleanup",
      "worker_decide_host_action",
      "worker_followup",
      "worker_send"
    ].includes(name)
      ? toolResult({ code: "E_CAPABILITY", message: "Required worker broker capability is unavailable." }, true)
      : toolResult({ code: "E_USAGE", message: "Invalid worker broker request." }, true);
  }
  // tools/list is frozen for the MCP process lifetime, but provider readiness
  // is not. Revalidate immediately before any new admission and again inside
  // the service so expiry, setup revocation, or binary/profile drift fail closed.
  if (["worker_spawn", "worker_decide_host_action", "worker_followup", "worker_send"].includes(name)
    && currentProviderCapabilityDigest(runtime, options) === null) {
    return toolResult(providerCapabilityAdmissionError(runtime, options), true);
  }
  if ([
    "worker_spawn_write",
    "worker_artifact",
    "worker_preview",
    "worker_integrate",
    "worker_verify_integration"
  ].includes(name)
    && currentWriteLifecycleCapabilityDigest(runtime, options) === null) {
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
      allowWriteSpawn: currentWriteLifecycleCapabilityDigest(runtime, options) !== null,
      enableWriteVerticalDispatch: currentWriteLifecycleCapabilityDigest(runtime, options) !== null,
      writeLifecycleCapabilityDigest: runtime.writeLifecycleCapabilityDigest,
      validateWriteLifecycleCapability: () => (
        currentWriteLifecycleCapabilityDigest(runtime, options)
      ),
      providerCapabilityDigest: runtime.providerCapabilityDigest,
      providerLaunchBinding: runtime.providerLaunchBinding,
      providerLaunchBindingDigest: runtime.providerLaunchBindingDigest,
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
      if (Array.isArray(args.ids) === Boolean(args.id)) {
        throw new CompanionError("E_USAGE", "Use exactly one of id or ids.");
      }
      if (Array.isArray(args.ids)) {
        if (args.cursor !== undefined) {
          throw new CompanionError("E_USAGE", "ids uses cursors, not cursor.");
        }
        return toolResult(await service.waitAny(args.ids, {
          cursors: args.cursors ?? null,
          timeoutMs: args.timeoutMs
        }));
      }
      if (args.cursors !== undefined) {
        throw new CompanionError("E_USAGE", "cursor is required for a single-worker wait.");
      }
      return toolResult({ stream: await service.wait(args.id, {
        cursor: args.cursor ?? null,
        timeoutMs: args.timeoutMs
      }) });
    }
    if (name === "worker_result") {
      const worker = service.result(args.id);
      const artifact = service.artifactMetadata(args.id);
      return toolResult({
        worker,
        ...(artifact ? { artifact } : {})
      });
    }
    if (name === "worker_artifact") {
      return toolResult({
        artifact: service.artifact(args.id, { part: args.part || "metadata" })
      });
    }
    if (name === "worker_preview") {
      return toolResult({
        preview: await service.preview({
          id: args.id,
          manifestDigest: args.manifestDigest
        })
      });
    }
    if (name === "worker_integrate") {
      const integrated = await service.integrate({
        id: args.id,
        manifestDigest: args.manifestDigest,
        idempotencyKey: args.idempotencyKey
      });
      return toolResult({
        receipt: integrated.receipt,
        replayed: integrated.replayed
      });
    }
    if (name === "worker_verify_integration") {
      return toolResult({
        verification: await service.verifyIntegration({
          id: args.id,
          manifestDigest: args.manifestDigest,
          integrationReceiptDigest: args.integrationReceiptDigest
        })
      });
    }
    if (name === "worker_abandon") {
      const abandoned = await service.abandon({
        id: args.id,
        manifestDigest: args.manifestDigest,
        idempotencyKey: args.idempotencyKey
      });
      return toolResult({
        receipt: abandoned.receipt,
        replayed: abandoned.replayed
      });
    }
    if (name === "worker_cleanup") {
      const cleaned = await service.cleanup({
        id: args.id,
        integrationReceiptDigest: args.integrationReceiptDigest,
        idempotencyKey: args.idempotencyKey
      });
      return toolResult({
        receipt: cleaned.receipt,
        replayed: cleaned.replayed
      });
    }
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
    if (name === "worker_spawn_write") {
      const spawned = service.spawnWriteVertical({
        userRequest: args.userRequest,
        objective: args.objective,
        idempotencyKey: args.idempotencyKey
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
    if (name === "worker_send") {
      const sent = service.send({
        id: args.id,
        message: args.message,
        idempotencyKey: args.idempotencyKey
      });
      return toolResult({
        message: sent.receipt,
        replayed: sent.replayed
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
          instructions: "Task-owned Grok worker broker (structured list/get/events/wait/result/cancel, plus read-only spawn, exact grant-bound same-session follow-up, and ordered active-worker send only when advertised). Grok workers are external, not native host subagents. Accepted mailbox messages are not reported as delivered until the provider-owned pump records a terminal outcome. Host verification is not trusted or promoted by this MCP surface.",
          _meta: {
            "grok/capability-matrix": capability,
            "grok/capabilityDigest": runtime.providerCapabilityDigest,
            "grok/providerLaunchBindingDigest": runtime.providerLaunchBindingDigest,
            ...(runtime.writeLifecycleCapabilityDigest
              ? {
                  "grok/writeLifecycleCapabilityDigest":
                    runtime.writeLifecycleCapabilityDigest
                }
              : {}),
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
