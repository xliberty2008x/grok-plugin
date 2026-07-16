/**
 * Worker Protocol v1 — provider-neutral public handle/snapshot projections and
 * durable lifecycle-event cursors.
 *
 * This module is intentionally free of MCP transport, mailbox/send/followup,
 * worktrees, UI, recursive subagents, and mid-turn steering. It projects only
 * public job evidence so the CLI and future broker adapters share one contract
 * without changing provider execution.
 */

import crypto from "node:crypto";

import { CompanionError } from "./errors.mjs";
import { redact } from "./redact.mjs";
import {
  MAX_LIFECYCLE_EVENTS,
  normalizeLifecycleEventSequences
} from "./task-contract.mjs";

/** Public protocol version for handle, snapshot, and cursor projections. */
export const WORKER_PROTOCOL_VERSION = 1;
export const WORKER_HANDLE_SCHEMA_VERSION = 1;
export const WORKER_SNAPSHOT_SCHEMA_VERSION = 1;
export const WORKER_EVENT_CURSOR_SCHEMA_VERSION = 1;

/** Re-export retention bound so adapters share one constant with append paths. */
export { MAX_LIFECYCLE_EVENTS };

const ACTIVE_WORKER_STATUSES = new Set(["queued", "running"]);
const PRIVATE_PROJECTION_FIELDS = new Set([
  "host",
  "sessionId",
  "grokSessionId",
  "claudeSessionId",
  "workerProcess",
  "providerProcess",
  "controllerProcess",
  "workerAuthorization",
  "pid",
  "processGroupId",
  "startToken",
  "nonce",
  "commandMarker",
  "workspaceRoot",
  "prompt",
  "userRequest",
  "rawProviderMessage",
  "rawProviderMessages"
]);

function omitPrivateProjectionFields(value, ancestors = new WeakSet()) {
  if (!value || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[CIRCULAR]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => omitPrivateProjectionFields(item, ancestors));
    }
    const projected = {};
    for (const [key, item] of Object.entries(value)) {
      if (PRIVATE_PROJECTION_FIELDS.has(key)) continue;
      projected[key] = omitPrivateProjectionFields(item, ancestors);
    }
    return projected;
  } finally {
    ancestors.delete(value);
  }
}

function sanitizePublicProjection(value) {
  return redact(omitPrivateProjectionFields(value));
}

/**
 * True when the worker/job is no longer admit-active.
 * Mirrors job-store terminal semantics without importing state.mjs.
 */
export function isWorkerTerminal(job) {
  return !ACTIVE_WORKER_STATUSES.has(job?.status);
}

/**
 * Project a single lifecycle event for public consumption.
 * Copies only operational fields; never invents private host/provider identity.
 */
export function projectLifecycleEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }
  const projected = {
    type: typeof event.type === "string" ? event.type : "checkpoint",
    at: event.at || null,
    summary: typeof event.summary === "string" ? event.summary : "",
    sequence: Number.isSafeInteger(event.sequence) ? event.sequence : null
  };
  if (event.detail !== undefined) projected.detail = event.detail;
  return sanitizePublicProjection(projected);
}

/**
 * Normalize and project a lifecycle event list for public snapshots.
 * Legacy unsequenced arrays receive deterministic sequences without mutating input.
 */
export function projectLifecycleEvents(events) {
  return normalizeLifecycleEventSequences(Array.isArray(events) ? events : [])
    .map((event) => projectLifecycleEvent(event))
    .filter(Boolean);
}

/**
 * Cursor-based lifecycle projection.
 *
 * @param {unknown} events stored lifecycle array (sequenced or legacy)
 * @param {number} cursor nonnegative integer; returns events with sequence > cursor
 * @param {{ terminal?: boolean }} [options]
 * @returns {{
 *   workerProtocolVersion: number,
 *   eventCursorSchemaVersion: number,
 *   events: object[],
 *   nextCursor: number,
 *   firstAvailableCursor: number,
 *   firstAvailableSequence: number | null,
 *   latestAvailableSequence: number,
 *   gap: boolean,
 *   terminal: boolean
 * }}
 */
export function projectLifecycleEventsAfterCursor(events, cursor = 0, options = {}) {
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new CompanionError(
      "E_USAGE",
      "Lifecycle event cursor must be a nonnegative integer."
    );
  }
  const normalized = normalizeLifecycleEventSequences(Array.isArray(events) ? events : []);
  const firstAvailableSequence = normalized.length ? normalized[0].sequence : null;
  const latestAvailableSequence = normalized.length ? normalized.at(-1).sequence : 0;
  // Reject an unusable future cursor. If it were accepted, later events would
  // remain invisible until their sequence surpassed the bad value.
  if (cursor > latestAvailableSequence) {
    throw new CompanionError(
      "E_USAGE",
      "Lifecycle event cursor exceeds the latest available sequence.",
      { cursor, latestAvailableSequence }
    );
  }
  // Usable replay cursor for the oldest retained event: events after this cursor
  // begin at firstAvailableSequence. Empty buffers expose cursor 0.
  const firstAvailableCursor = firstAvailableSequence == null
    ? 0
    : Math.max(0, firstAvailableSequence - 1);
  // Retention gap: client asked for events after `cursor`, but at least one
  // intermediate sequence was dropped before the first retained entry.
  const gap = firstAvailableSequence != null && firstAvailableSequence > cursor + 1;
  const selected = normalized
    .filter((event) => event.sequence > cursor)
    .map((event) => projectLifecycleEvent(event))
    .filter(Boolean);
  // When already current (no new events), nextCursor stays at the supplied cursor.
  const nextCursor = selected.length
    ? selected[selected.length - 1].sequence
    : cursor;
  return {
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    eventCursorSchemaVersion: WORKER_EVENT_CURSOR_SCHEMA_VERSION,
    events: selected,
    nextCursor,
    firstAvailableCursor,
    firstAvailableSequence,
    latestAvailableSequence,
    gap,
    terminal: Boolean(options.terminal)
  };
}

function opaqueHostTaskBinding(job) {
  const kind = typeof job?.host?.kind === "string" ? job.host.kind : null;
  const sessionId = typeof job?.host?.sessionId === "string" ? job.host.sessionId : null;
  if (!kind || !sessionId) return null;
  // Stable correlation metadata for one host task. This public digest is never
  // an authorization capability; private host/session checks remain authoritative.
  const digest = crypto.createHash("sha256")
    .update([kind, sessionId].join("\0"))
    .digest("hex");
  return `host-task-${digest.slice(0, 32)}`;
}

function workerEventCursor(workerId, sequence) {
  return {
    schemaVersion: WORKER_EVENT_CURSOR_SCHEMA_VERSION,
    workerId,
    sequence
  };
}

function parseWorkerEventCursor(job, cursor) {
  if (cursor == null) return 0;
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
    throw new CompanionError("E_USAGE", "Worker event cursor must be a structured cursor token.");
  }
  if (cursor.schemaVersion !== WORKER_EVENT_CURSOR_SCHEMA_VERSION
    || cursor.workerId !== job?.id
    || !Number.isSafeInteger(cursor.sequence)
    || cursor.sequence < 0) {
    throw new CompanionError(
      "E_USAGE",
      "Worker event cursor does not belong to this worker stream."
    );
  }
  return cursor.sequence;
}

function projectWorkerIdentityMetadata(job) {
  const envelope = job.request?.envelope || null;
  const manifest = job.request?.contextManifest || null;
  const lifecycleEvents = normalizeLifecycleEventSequences(
    Array.isArray(job.lifecycleEvents) ? job.lifecycleEvents : []
  );
  return {
    parentWorkerId: job.request?.resumeJobId || null,
    lineageWorkerId: job.request?.providerHomeId || job.id || null,
    eventCursor: workerEventCursor(
      job.id,
      lifecycleEvents.length ? lifecycleEvents.at(-1).sequence : 0
    ),
    taskEnvelopeId: envelope?.envelopeId || null,
    taskEnvelopeDigest: envelope?.digest || null,
    contextManifestId: manifest?.manifestId || envelope?.contextManifestId || null,
    contextDigest: manifest?.digest || null,
    workspaceSnapshotDigest: manifest?.digest || null,
    hostTaskBinding: opaqueHostTaskBinding(job),
    securityProfile: {
      id: job.profile?.id || null,
      contractVersion: job.profile?.contractVersion || null,
      agentProfileDigest: job.profile?.agentProfileDigest || null
    }
  };
}

/**
 * Cursor projection bound to a job record (includes terminal state).
 * Public broker callers use structured tokens so an in-range cursor from another
 * worker cannot silently skip this worker's events.
 */
export function projectWorkerLifecycleCursor(job, cursor = null) {
  if (!job || typeof job !== "object") {
    throw new CompanionError("E_STATE", "Worker cursor projection requires a job record.");
  }
  const sequence = parseWorkerEventCursor(job, cursor);
  const projected = projectLifecycleEventsAfterCursor(job.lifecycleEvents, sequence, {
    terminal: isWorkerTerminal(job)
  });
  return {
    ...projected,
    workerId: job.id,
    nextCursor: workerEventCursor(job.id, projected.nextCursor),
    firstAvailableCursor: workerEventCursor(job.id, projected.firstAvailableCursor),
    latestAvailableCursor: workerEventCursor(job.id, projected.latestAvailableSequence)
  };
}

/**
 * Lightweight public worker handle — identity and liveness without detail payload.
 * Omits prompts, raw host identity, provider session IDs, process identity, and credentials.
 */
export function projectWorkerHandle(job) {
  if (!job || typeof job !== "object") {
    throw new CompanionError("E_STATE", "Worker handle projection requires a job record.");
  }
  return sanitizePublicProjection({
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    handleSchemaVersion: WORKER_HANDLE_SCHEMA_VERSION,
    id: job.id,
    kind: job.kind,
    jobClass: job.jobClass,
    write: Boolean(job.write),
    status: job.status,
    phase: job.phase,
    summary: job.summary || null,
    progress: job.progress || null,
    createdAt: job.createdAt || null,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null,
    completedAt: job.completedAt || null,
    heartbeatAt: job.heartbeatAt || null,
    profileId: job.profile?.id || null,
    model: job.model || null,
    effort: job.effort || null,
    ...projectWorkerIdentityMetadata(job),
    controlWorkspaceId: job.controlWorkspaceId || null,
    roleId: job.role?.id || job.profile?.id || null,
    externalWorkerLabel: "external-grok-worker",
    terminal: isWorkerTerminal(job)
  });
}

/**
 * Build the public result object shared by CLI status/result JSON and future brokers.
 * Never includes raw provider text, prompts, or private process fields.
 */
function projectPublicResult(job, { detail = true } = {}) {
  if (!detail || !job.result) return null;
  return sanitizePublicProjection({
    ...(job.result.review ? { review: job.result.review } : {}),
    ...(job.result.workerReport ? { workerReport: job.result.workerReport } : {}),
    ...(job.result.reportRepair ? { reportRepair: job.result.reportRepair } : {}),
    ...(job.result.providerClaims ? { providerClaims: job.result.providerClaims } : {}),
    ...(job.result.runtimeEvidence ? { runtimeEvidence: job.result.runtimeEvidence } : {}),
    ...(job.result.verification ? { verification: job.result.verification } : {}),
    ...(job.result.textDigest ? {
      textBytes: job.result.textBytes || 0,
      textDigest: job.result.textDigest,
      textTruncated: Boolean(job.result.textTruncated)
    } : {}),
    ...(job.result.interim ? { interim: job.result.interim } : {}),
    hostVerification: job.result.hostVerification || "not_run",
    ...(job.result.stopReason ? { stopReason: job.result.stopReason } : {}),
    ...(job.result.skipped ? { skipped: true, skipReason: job.result.skipReason || null } : {}),
    ...(job.result.providerSessionDeleted != null ? { providerSessionDeleted: job.result.providerSessionDeleted } : {}),
    ...(job.result.taskRuntimeCleaned != null ? { taskRuntimeCleaned: job.result.taskRuntimeCleaned } : {}),
    ...(job.result.privacyWarning ? { privacyWarning: job.result.privacyWarning } : {})
  });
}

function projectPublicError(error) {
  if (!error || typeof error !== "object") return null;
  return sanitizePublicProjection({
    code: error.code || "E_PROVIDER_EXIT",
    message: error.code === "E_PROCESS_IDENTITY"
      ? "Process ownership verification failed."
      : error.message || "Worker failed.",
    ...(error.details === undefined ? {} : { details: error.details })
  });
}

/**
 * Full public worker snapshot — the single contract for CLI public JSON and brokers.
 * Compatible with the historical publicJob shape; adds explicit protocol versioning
 * and projects lifecycle events with durable sequences.
 *
 * Excludes: prompt text, host identity, provider session IDs, process identities,
 * credentials, hidden context, and raw provider messages.
 */
export function projectWorkerSnapshot(job, { detail = true } = {}) {
  if (!job || typeof job !== "object") {
    throw new CompanionError("E_STATE", "Worker snapshot projection requires a job record.");
  }
  const envelope = job.request?.envelope || null;
  const manifest = job.request?.contextManifest || null;
  return sanitizePublicProjection({
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    snapshotSchemaVersion: WORKER_SNAPSHOT_SCHEMA_VERSION,
    schemaVersion: job.schemaVersion,
    id: job.id,
    kind: job.kind,
    jobClass: job.jobClass,
    write: Boolean(job.write),
    status: job.status,
    phase: job.phase,
    summary: job.summary || null,
    progress: job.progress || null,
    createdAt: job.createdAt || null,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null,
    completedAt: job.completedAt || null,
    heartbeatAt: job.heartbeatAt || null,
    profileId: job.profile?.id || null,
    model: job.model || null,
    effort: job.effort || null,
    ...projectWorkerIdentityMetadata(job),
    latestPlan: detail ? job.latestPlan || [] : [],
    lifecycleEvents: detail ? projectLifecycleEvents(job.lifecycleEvents) : [],
    taskContract: detail && envelope ? {
      schemaVersion: envelope.schemaVersion,
      envelopeId: envelope.envelopeId,
      digest: envelope.digest,
      // Positional/default envelopes use literal task text as the objective. Keep that raw
      // prompt private; expose only the separately recorded control-plane objective.
      objective: job.request?.publicObjective || null,
      mode: envelope.mode,
      scope: envelope.scope,
      nonGoals: envelope.nonGoals,
      acceptanceCriteria: envelope.acceptanceCriteria,
      requiredVerification: envelope.requiredVerification,
      expectedReturnFormat: envelope.expectedReturnFormat,
      context: envelope.context,
      contextManifestId: envelope.contextManifestId
    } : null,
    context: detail && manifest ? {
      manifestId: manifest.manifestId,
      digest: manifest.digest,
      branch: manifest.git?.branch || null,
      head: manifest.git?.head || null,
      dirtyDigest: manifest.git?.dirtyDigest || null,
      dirtyEntryCount: manifest.git?.dirtyEntryCount || 0,
      projectMarkers: manifest.projectMarkers || [],
      materialization: manifest.materialization || null
    } : null,
    resumeJobId: job.request?.resumeJobId || null,
    result: projectPublicResult(job, { detail }),
    error: projectPublicError(job.error),
    controlWorkspaceId: job.controlWorkspaceId || null,
    roleId: job.role?.id || job.profile?.id || null,
    externalWorkerLabel: "external-grok-worker",
    awaitingHostAction: job.awaitingHostAction || null,
    terminal: isWorkerTerminal(job)
  });
}
