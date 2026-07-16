import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { CompanionError } from "./errors.mjs";
import { workspaceRoot } from "./workspace.mjs";

export const MCP_SANDBOX_STATE_META_CAPABILITY = "codex/sandbox-state-meta";
export const CODEX_MCP_EXPERIMENTAL_CAPABILITIES = Object.freeze({
  [MCP_SANDBOX_STATE_META_CAPABILITY]: Object.freeze({})
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GROK_PLUGIN_ID = /^grok(?:@[a-zA-Z0-9][a-zA-Z0-9._-]{0,127})?$/;

function authFailure() {
  return new CompanionError("E_AUTH_REQUIRED", "Trusted Codex task identity is unavailable.");
}

function capabilityFailure() {
  return new CompanionError("E_CAPABILITY", "Trusted Codex workspace metadata is unavailable.");
}

export function isCanonicalUuid(value) {
  return typeof value === "string" && UUID.test(value);
}

/**
 * Resolve a private broker principal from host-injected per-call MCP metadata.
 * Tool arguments and process environment are intentionally not authority inputs.
 */
/**
 * Plugin-ID requirement freeze for mutation-capable calls.
 * Reads may proceed without plugin_id for backward compatibility with proven
 * Codex identity; mutation tools require a valid grok plugin id.
 */
export const MUTATION_REQUIRES_PLUGIN_ID = true;

export function resolveWorkerAuthority(meta, { mutation = false } = {}) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw authFailure();
  const threadId = meta.threadId;
  const turn = meta["x-codex-turn-metadata"];
  if (!isCanonicalUuid(threadId)
    || !turn
    || typeof turn !== "object"
    || Array.isArray(turn)
    || turn.thread_id !== threadId) {
    throw authFailure();
  }
  const turnId = isCanonicalUuid(turn.turn_id) ? turn.turn_id : null;
  const pluginId = meta.plugin_id ?? turn.plugin_id ?? null;
  if (pluginId != null && !GROK_PLUGIN_ID.test(String(pluginId))) {
    throw authFailure();
  }
  if (meta.plugin_id != null && turn.plugin_id != null && meta.plugin_id !== turn.plugin_id) {
    throw authFailure();
  }
  if (mutation && MUTATION_REQUIRES_PLUGIN_ID) {
    if (pluginId == null || !GROK_PLUGIN_ID.test(String(pluginId))) {
      throw authFailure();
    }
  }

  // Host-attested parent/subagent ownership — never inferred from tool arguments.
  const attestedByHost = meta.attestedByHost === true
    || turn.attested_by_host === true;
  const attestedParentThreadId = isCanonicalUuid(meta.attestedParentThreadId)
    ? meta.attestedParentThreadId
    : (isCanonicalUuid(turn.attested_parent_thread_id) ? turn.attested_parent_thread_id : null);

  const sandbox = meta[MCP_SANDBOX_STATE_META_CAPABILITY];
  const sandboxCwd = sandbox?.sandboxCwd;
  if (typeof sandboxCwd !== "string") throw capabilityFailure();
  let cwd;
  try {
    const url = new URL(sandboxCwd);
    if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) {
      throw capabilityFailure();
    }
    cwd = fs.realpathSync(fileURLToPath(url));
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    throw capabilityFailure();
  }

  let root;
  try {
    root = workspaceRoot(cwd, true);
  } catch {
    throw capabilityFailure();
  }
  return Object.freeze({
    hostKind: "codex",
    threadId,
    turnId,
    source: "codex-mcp-stdio",
    pluginId,
    root,
    attestedByHost: Boolean(attestedByHost && attestedParentThreadId),
    attestedParentThreadId: attestedByHost ? attestedParentThreadId : null,
    mutationCapable: Boolean(pluginId && GROK_PLUGIN_ID.test(String(pluginId)))
  });
}
