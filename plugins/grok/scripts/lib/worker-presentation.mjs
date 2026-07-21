/**
 * Phase 4: structured host-facing presentation from public schemas only.
 * Never parses shell/provider prose for status or actions.
 */
import crypto from "node:crypto";

import { CompanionError } from "./errors.mjs";
import { sanitizeDisplayText } from "./redact.mjs";
import {
  normalizeWorkerSnapshot,
  projectWorkerSnapshot
} from "./worker-protocol.mjs";

export const PRESENTATION_SCHEMA_VERSION = 1;
export const EXTERNAL_WORKER_LABEL = "external-grok-worker";
export const NATIVE_HOST_LABEL = "native-host-agent";

const WORKER_ID_PATTERN = /^(?:review|adversarial-review|task|stop-review)-[a-f0-9]{16,64}$/;
const PUBLIC_STATUS = new Set(["queued", "running", "completed", "succeeded", "failed", "cancelled", "unknown"]);

function displayText(value, max = 2000) {
  return sanitizeDisplayText(typeof value === "string" ? value : "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "")
    .replace(/[\u0080-\u009F]/g, "")
    .replace(/(?:file:\/\/)?\/(?:private\/)?tmp(?:\/[^\s"'`;,\)\]}]*)?/g, "[PRIVATE_PATH]")
    .replace(/(?:file:\/\/)?\/(?:private\/)?var\/folders(?:\/[^\s"'`;,\)\]}]*)?/g, "[PRIVATE_PATH]")
    .replace(/(?:file:\/\/)?\/(?:Users|home)\/[^/\s"'`]+(?:\/[^\s"'`;,\)\]}]*)?/g, "[PRIVATE_PATH]")
    .replace(/(?:file:\/\/)?\/root(?:\/[^\s"'`;,\)\]}]*)?/g, "[PRIVATE_PATH]")
    .replace(/~\/(?:[^\s"'`;,\)\]}]*)?/g, "[PRIVATE_PATH]")
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s"'`]+(?:\\[^\s"'`;,\)\]}]*)?/g, "[PRIVATE_PATH]")
    .slice(0, max);
}

function publicWorkerId(value) {
  return typeof value === "string" && WORKER_ID_PATTERN.test(value) ? value : null;
}

function publicAlias(value) {
  if (typeof value !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value)) return null;
  return displayText(value, 64);
}

function publicStatus(value) {
  return typeof value === "string" && PUBLIC_STATUS.has(value) ? displayText(value, 128) : "unknown";
}

/**
 * Capability matrix for Codex MCP metadata drift.
 */
export function codexMetadataCapabilityMatrix(meta = {}) {
  const hasThreadId = typeof meta.threadId === "string";
  const hasTurn = meta["x-codex-turn-metadata"]
    && typeof meta["x-codex-turn-metadata"] === "object";
  const hasSandbox = meta["codex/sandbox-state-meta"]
    && typeof meta["codex/sandbox-state-meta"]?.sandboxCwd === "string";
  const hasPluginId = meta.plugin_id != null
    || meta["x-codex-turn-metadata"]?.plugin_id != null;

  const full = hasThreadId && hasTurn && hasSandbox;
  return Object.freeze({
    schemaVersion: 1,
    identity: full ? "full" : hasThreadId ? "degraded" : "unavailable",
    threadId: hasThreadId,
    turnMetadata: Boolean(hasTurn),
    sandboxCwd: Boolean(hasSandbox),
    pluginId: Boolean(hasPluginId),
    mutationAllowed: full && hasPluginId,
    readAllowed: full,
    fallback: full
      ? null
      : hasThreadId
        ? "cli-skill-compatibility-facade"
        : "fail-closed",
    note: full
      ? "Structured MCP identity complete."
      : "Missing Codex metadata; fail closed or use documented CLI facade."
  });
}

function aliasDigest(alias, workerId, hostTaskBinding) {
  return crypto.createHash("sha256")
    .update([alias, workerId, hostTaskBinding || ""].join("\0"))
    .digest("hex")
    .slice(0, 24);
}

/**
 * Persistable alias with collision/spoofing protection.
 * Aliases are bound to workerId + hostTaskBinding; cannot be stolen by another worker.
 */
export function bindWorkerAlias({ alias, workerId, hostTaskBinding, existing = [] } = {}) {
  if (typeof alias !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(alias)) {
    throw new CompanionError("E_USAGE", "Alias must be a short alphanumeric token.");
  }
  if (!workerId) throw new CompanionError("E_USAGE", "workerId is required for alias binding.");
  for (const entry of existing) {
    if (entry.alias === alias && entry.workerId !== workerId) {
      throw new CompanionError("E_USAGE", `Alias ${alias} is already bound to another worker.`);
    }
    if (entry.workerId === workerId && entry.alias !== alias) {
      // Allow rename only when digest matches prior binding family — simple policy: one alias per worker.
      throw new CompanionError("E_USAGE", "Worker already has a different alias.");
    }
  }
  return Object.freeze({
    alias,
    workerId,
    hostTaskBinding: hostTaskBinding || null,
    bindingDigest: aliasDigest(alias, workerId, hostTaskBinding),
    createdAt: new Date().toISOString()
  });
}

/**
 * Build a structured presentation record from a public snapshot/handle only.
 */
export function presentWorker(jobOrSnapshot, {
  alias = null,
  isNativeHostAgent = false
} = {}) {
  if (isNativeHostAgent) {
    throw new CompanionError(
      "E_POLICY",
      "External Grok workers cannot be presented as native host agents."
    );
  }
  // Accept raw jobs (project) or purportedly-public snapshots (re-project).
  // Version flags are descriptive metadata, not a validation capability. This
  // presentation boundary never treats caller-supplied host-verification fields
  // as authoritative, including when a forged snapshot omits its version flags
  // to resemble a private job record.
  const snapshot = jobOrSnapshot?.workerProtocolVersion
    && jobOrSnapshot?.snapshotSchemaVersion
    ? normalizeWorkerSnapshot(jobOrSnapshot)
    : projectWorkerSnapshot(jobOrSnapshot, { trustHostAuthority: false });

  return Object.freeze({
    schemaVersion: PRESENTATION_SCHEMA_VERSION,
    source: "structured-public-schema",
    shellOutputParsed: false,
    label: EXTERNAL_WORKER_LABEL,
    isNativeHostAgent: false,
    alias: publicAlias(alias),
    id: snapshot.id,
    phase: snapshot.phase,
    status: snapshot.status,
    plan: Array.isArray(snapshot.latestPlan) ? snapshot.latestPlan : [],
    heartbeatAt: snapshot.heartbeatAt,
    cursor: snapshot.eventCursor || null,
    summary: snapshot.summary,
    progress: snapshot.progress,
    terminal: snapshot.terminal,
    result: snapshot.result,
    error: snapshot.error,
    lineage: {
      parentWorkerId: snapshot.parentWorkerId || null,
      lineageWorkerId: snapshot.lineageWorkerId || null,
      hostTaskBinding: snapshot.hostTaskBinding || null
    },
    controlWorkspaceId: snapshot.controlWorkspaceId || null,
    roleId: snapshot.roleId || snapshot.securityProfile?.id || null
  });
}

/**
 * Build a lineage tree from structured handles only.
 */
export function presentLineageTree(handles = []) {
  const byId = new Map();
  for (const handle of handles) {
    const id = publicWorkerId(handle?.id);
    if (!id) continue;
    byId.set(id, {
      id,
      alias: publicAlias(handle.alias),
      status: publicStatus(handle.status),
      label: EXTERNAL_WORKER_LABEL,
      parentWorkerId: publicWorkerId(handle.parentWorkerId),
      children: []
    });
  }
  const roots = [];
  for (const node of byId.values()) {
    if (node.parentWorkerId && byId.has(node.parentWorkerId)) {
      byId.get(node.parentWorkerId).children.push(node);
    } else {
      roots.push(node);
    }
  }
  return Object.freeze({
    schemaVersion: PRESENTATION_SCHEMA_VERSION,
    label: EXTERNAL_WORKER_LABEL,
    roots
  });
}

/**
 * Degraded capability presentation — bounded honest state, no invented success.
 */
export function presentDegradedCapability(matrix) {
  return Object.freeze({
    schemaVersion: PRESENTATION_SCHEMA_VERSION,
    degraded: true,
    identity: matrix?.identity || "unavailable",
    fallback: matrix?.fallback || "fail-closed",
    mutationAllowed: false,
    readAllowed: Boolean(matrix?.readAllowed),
    message: matrix?.identity === "unavailable"
      ? "Trusted Codex task identity is unavailable."
      : "Codex metadata incomplete; using documented compatibility fallback.",
    shellOutputParsed: false
  });
}
