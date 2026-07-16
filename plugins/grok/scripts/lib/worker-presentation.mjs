/**
 * Phase 4: structured host-facing presentation from public schemas only.
 * Never parses shell/provider prose for status or actions.
 */
import crypto from "node:crypto";

import { CompanionError } from "./errors.mjs";
import {
  projectWorkerHandle,
  projectWorkerSnapshot
} from "./worker-protocol.mjs";

export const PRESENTATION_SCHEMA_VERSION = 1;
export const EXTERNAL_WORKER_LABEL = "external-grok-worker";
export const NATIVE_HOST_LABEL = "native-host-agent";

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
  // Accept raw jobs (project) or already-public snapshots.
  const snapshot = jobOrSnapshot?.workerProtocolVersion
    && jobOrSnapshot?.snapshotSchemaVersion
    ? jobOrSnapshot
    : projectWorkerSnapshot(jobOrSnapshot);

  const handle = jobOrSnapshot?.handleSchemaVersion
    ? jobOrSnapshot
    : projectWorkerHandle(
      // Minimal job-like for handle when only snapshot given
      jobOrSnapshot?.id && !jobOrSnapshot.workerAuthorization
        ? {
          id: snapshot.id,
          kind: snapshot.kind,
          jobClass: snapshot.jobClass,
          write: snapshot.write,
          status: snapshot.status,
          phase: snapshot.phase,
          summary: snapshot.summary,
          progress: snapshot.progress,
          createdAt: snapshot.createdAt,
          startedAt: snapshot.startedAt,
          updatedAt: snapshot.updatedAt,
          completedAt: snapshot.completedAt,
          heartbeatAt: snapshot.heartbeatAt,
          profile: snapshot.securityProfile
            ? {
              id: snapshot.securityProfile.id,
              contractVersion: snapshot.securityProfile.contractVersion,
              agentProfileDigest: snapshot.securityProfile.agentProfileDigest
            }
            : null,
          model: snapshot.model,
          effort: snapshot.effort,
          request: {
            resumeJobId: snapshot.resumeJobId,
            envelope: snapshot.taskContract,
            contextManifest: snapshot.context
          },
          lifecycleEvents: snapshot.lifecycleEvents,
          host: null,
          result: snapshot.result,
          error: snapshot.error
        }
        : jobOrSnapshot
    );

  return Object.freeze({
    schemaVersion: PRESENTATION_SCHEMA_VERSION,
    source: "structured-public-schema",
    shellOutputParsed: false,
    label: isNativeHostAgent ? NATIVE_HOST_LABEL : EXTERNAL_WORKER_LABEL,
    isNativeHostAgent: Boolean(isNativeHostAgent),
    alias: alias || null,
    id: snapshot.id,
    phase: snapshot.phase,
    status: snapshot.status,
    plan: Array.isArray(snapshot.latestPlan) ? snapshot.latestPlan : [],
    heartbeatAt: snapshot.heartbeatAt,
    cursor: snapshot.eventCursor || handle.eventCursor || null,
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
    byId.set(handle.id, {
      id: handle.id,
      alias: handle.alias || null,
      status: handle.status,
      label: EXTERNAL_WORKER_LABEL,
      parentWorkerId: handle.parentWorkerId || null,
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
