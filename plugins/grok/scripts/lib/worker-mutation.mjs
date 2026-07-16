/**
 * Phase 1C: idempotent spawn (read-only) and cancel with durable receipts.
 *
 * Ownership freeze (exact-thread):
 * - Ownership is exact Codex threadId equality via job.host.sessionId.
 * - Parent/subagent delegation is only accepted when host-attested metadata is
 *   present on the principal (`parentThreadId` + matching `attestedByHost`).
 * - Caller arguments never establish ancestry.
 *
 * Spawn success = durable job commit (provider launch is a separate step).
 * Cancel metric timestamps are recorded separately (request / process / terminal).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CompanionError } from "./errors.mjs";
import { sameHostSession } from "./host.mjs";
import {
  admitJob,
  generateId,
  now,
  requestCancel,
  tryReadJob,
  updateJob
} from "./state.mjs";
import { appendLifecycleEvent } from "./task-contract.mjs";
import { projectWorkerHandle, projectWorkerSnapshot } from "./worker-protocol.mjs";
import { materializeRole, assertRoleDigest } from "./worker-roles.mjs";
import { resolveControlWorkspace, workspaceState } from "./workspace.mjs";

export const SPAWN_OWNERSHIP_MODE = "exact-thread-or-host-attested-parent";
export const SPAWN_SUCCESS_DEFINITION = "durable-job-commit";
export const CANCEL_METRIC_TIMESTAMPS = Object.freeze([
  "requestAcceptedAt",
  "processGroupGoneAt",
  "terminalRecordCommittedAt"
]);

function digestKey(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function assertIdempotencyKey(key) {
  if (typeof key !== "string" || key.length < 8 || key.length > 256) {
    throw new CompanionError("E_USAGE", "idempotencyKey must be a string of length 8–256.");
  }
  if (/[\r\n\0]/.test(key)) {
    throw new CompanionError("E_USAGE", "idempotencyKey must not contain control characters.");
  }
  return key;
}

function idempotencyPath(root, kind, keyDigest, env = process.env) {
  // Same control-workspace state store as jobs (shared across linked worktrees).
  const base = workspaceState(root, env);
  const dir = path.join(base, "idempotency", kind);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${keyDigest}.json`);
}

function readIdempotency(root, kind, key, env = process.env) {
  const file = idempotencyPath(root, kind, digestKey(key), env);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new CompanionError("E_STATE", `Could not read idempotency record for ${kind}.`);
  }
}

function writeIdempotency(root, kind, key, record, env = process.env) {
  const file = idempotencyPath(root, kind, digestKey(key), env);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return record;
}

/**
 * Resolve ownership for mutation tools.
 * Exact thread match is always accepted. Host-attested parent/subagent is
 * accepted only when principal.attestedParentThreadId matches job.host.sessionId
 * and principal.attestedByHost === true (never inferred from tool args).
 */
export function assertMutationOwnership(job, principal) {
  if (!job || !principal) {
    throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
  }
  const host = { kind: "codex", sessionId: principal.threadId };
  if (sameHostSession(job, host)) return "exact-thread";
  if (
    principal.attestedByHost === true
    && typeof principal.attestedParentThreadId === "string"
    && job.host?.kind === "codex"
    && job.host?.sessionId === principal.attestedParentThreadId
  ) {
    return "host-attested-parent";
  }
  throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
}

function ownershipHost(principal) {
  return Object.freeze({ kind: "codex", sessionId: principal.threadId });
}

/**
 * Commit a durable read-only worker job. Provider launch is intentionally not performed.
 * write:true is rejected until Phase 3 enables broker write spawn after identity redesign.
 */
export function spawnReadOnlyWorker({
  root,
  principal,
  envelope,
  contextManifest = null,
  idempotencyKey,
  roleId = "explorer",
  write = false,
  env = process.env,
  allowWriteSpawn = false,
  providerLaunch = null
} = {}) {
  assertIdempotencyKey(idempotencyKey);
  if (!principal?.threadId) {
    throw new CompanionError("E_AUTH_REQUIRED", "Trusted Codex task identity is unavailable.");
  }
  if (write && !allowWriteSpawn) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Broker write spawn is disabled until Phase 3 control-workspace identity and worktrees are enabled."
    );
  }
  if (!envelope || typeof envelope !== "object") {
    throw new CompanionError("E_USAGE", "TaskEnvelope is required for spawn.");
  }
  if (envelope.mode === "write" && !allowWriteSpawn) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Broker write spawn is disabled until Phase 3 control-workspace identity and worktrees are enabled."
    );
  }

  const existing = readIdempotency(root, "spawn", idempotencyKey, env);
  if (existing) {
    if (existing.requestDigest !== requestDigest({ envelope, contextManifest, roleId, write })) {
      throw new CompanionError(
        "E_IDEMPOTENCY_CONFLICT",
        "idempotencyKey was reused with a different spawn request."
      );
    }
    const job = tryReadJob(root, existing.workerId, env);
    if (job) {
      return {
        handle: projectWorkerHandle(job),
        replayed: true,
        spawnSuccessDefinition: SPAWN_SUCCESS_DEFINITION,
        providerLaunched: false
      };
    }
    // Durable commit record exists but job missing — still surface prior commit.
    return {
      handle: existing.handle || { id: existing.workerId },
      replayed: true,
      spawnSuccessDefinition: SPAWN_SUCCESS_DEFINITION,
      providerLaunched: false
    };
  }

  const role = materializeRole(roleId);
  if (write && !role.write) {
    throw new CompanionError("E_ROLE", `Role ${roleId} cannot perform write work.`);
  }
  assertRoleDigest(role);

  const id = generateId("task");
  const createdAt = now();
  let controlWorkspaceId = null;
  try {
    controlWorkspaceId = resolveControlWorkspace(root, env).controlWorkspaceId;
  } catch {
    controlWorkspaceId = null;
  }

  const job = {
    schemaVersion: 3,
    id,
    kind: "task",
    jobClass: "task",
    write: Boolean(write),
    status: "queued",
    phase: "accepted",
    summary: "Spawn committed",
    progress: "Durable job record committed; provider not started by broker spawn.",
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    completedAt: null,
    heartbeatAt: createdAt,
    host: ownershipHost(principal),
    profile: {
      id: role.id,
      contractVersion: role.schemaVersion,
      agentProfileDigest: role.digest
    },
    role: {
      id: role.id,
      digest: role.digest,
      write: role.write
    },
    model: null,
    effort: null,
    controlWorkspaceId,
    request: {
      envelope,
      contextManifest,
      publicObjective: envelope.objective || null,
      roleId: role.id,
      spawn: {
        idempotencyKeyDigest: digestKey(idempotencyKey),
        successDefinition: SPAWN_SUCCESS_DEFINITION,
        ownershipMode: SPAWN_OWNERSHIP_MODE,
        providerLaunchPending: true
      }
    },
    lifecycleEvents: appendLifecycleEvent(
      [],
      "task.accepted",
      "Durable spawn commit accepted by worker broker.",
      {
        spawnSuccessDefinition: SPAWN_SUCCESS_DEFINITION,
        write: Boolean(write)
      }
    ),
    result: null,
    error: null,
    workerAuthorization: {
      nonce: crypto.randomBytes(16).toString("hex")
    }
  };

  // Atomic admit under workspace admission lock = durable commit.
  // admitJob already serializes on workspace-admission; do not nest the same lock.
  const committed = admitJob(root, job, env);

  const handle = projectWorkerHandle(committed);
  writeIdempotency(root, "spawn", idempotencyKey, {
    workerId: committed.id,
    requestDigest: requestDigest({ envelope, contextManifest, roleId, write }),
    handle,
    committedAt: createdAt
  }, env);

  // Optional provider launch hook (tests inject; production may attach later).
  // Never auto-replays: only called once on first commit path.
  let providerLaunched = false;
  if (typeof providerLaunch === "function") {
    providerLaunch({ job: committed, root, principal });
    providerLaunched = true;
  }

  return {
    handle,
    replayed: false,
    spawnSuccessDefinition: SPAWN_SUCCESS_DEFINITION,
    providerLaunched
  };
}

function requestDigest({ envelope, contextManifest, roleId, write }) {
  return digestKey(JSON.stringify({
    envelopeId: envelope?.envelopeId || envelope?.digest || null,
    envelopeDigest: envelope?.digest || null,
    contextDigest: contextManifest?.digest || null,
    roleId,
    write: Boolean(write)
  }));
}

/**
 * Idempotent cancel: immutable receipt, exactly one cancellation-request lifecycle event.
 */
export function cancelWorker({
  root,
  principal,
  workerId,
  idempotencyKey,
  env = process.env,
  signalProcess = null
} = {}) {
  assertIdempotencyKey(idempotencyKey);
  if (!principal?.threadId) {
    throw new CompanionError("E_AUTH_REQUIRED", "Trusted Codex task identity is unavailable.");
  }
  if (!workerId) {
    throw new CompanionError("E_USAGE", "workerId is required.");
  }

  const existing = readIdempotency(root, "cancel", idempotencyKey, env);
  if (existing) {
    if (existing.workerId !== workerId) {
      throw new CompanionError(
        "E_IDEMPOTENCY_CONFLICT",
        "idempotencyKey was reused for a different worker."
      );
    }
    return {
      receipt: existing.receipt,
      replayed: true
    };
  }

  const job = tryReadJob(root, workerId, env);
  if (!job) {
    // Foreign and nonexistent are observationally equivalent.
    throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
  }
  assertMutationOwnership(job, principal);

  const requestAcceptedAt = now();
  let cancellationRequestSequence = null;
  let status = "accepted";
  let processGroupGoneAt = null;
  let terminalRecordCommittedAt = null;

  if (job.status !== "queued" && job.status !== "running") {
    status = "already_terminal";
    terminalRecordCommittedAt = job.completedAt || requestAcceptedAt;
  } else {
    const nonce = job.workerAuthorization?.nonce;
    if (nonce) {
      try {
        requestCancel(root, workerId, nonce, env);
      } catch {
        // Marker write failure still records the request event once.
      }
    }

    const updated = updateJob(root, workerId, (current) => {
      const events = Array.isArray(current.lifecycleEvents) ? current.lifecycleEvents : [];
      const already = events.some((event) => event.type === "cancellation.requested");
      let nextEvents = events;
      if (!already) {
        nextEvents = appendLifecycleEvent(
          events,
          "cancellation.requested",
          "Cancellation request accepted by worker broker.",
          { requestAcceptedAt }
        );
        cancellationRequestSequence = nextEvents.at(-1)?.sequence ?? null;
      } else {
        cancellationRequestSequence = events.find((event) => event.type === "cancellation.requested")?.sequence
          ?? null;
        status = "already_cancelled";
      }

      // Optional process signal — never replays prompts.
      if (typeof signalProcess === "function" && status === "accepted") {
        try {
          signalProcess(current);
          processGroupGoneAt = now();
        } catch {
          processGroupGoneAt = null;
        }
      }

      const terminal = {
        ...current,
        status: "cancelled",
        phase: "cancelled",
        summary: "Cancelled",
        progress: "Cancellation request accepted.",
        completedAt: now(),
        lifecycleEvents: nextEvents,
        result: {
          ...(current.result || {}),
          hostVerification: current.result?.hostVerification || "not_run",
          stopReason: "cancelled",
          cancellation: {
            requestAcceptedAt,
            processGroupGoneAt,
            terminalRecordCommittedAt: now(),
            receiptId: null
          }
        }
      };
      terminalRecordCommittedAt = terminal.completedAt;
      return terminal;
    }, env);

    // Count cancellation.requested events — must be exactly one.
    const count = (updated.lifecycleEvents || [])
      .filter((event) => event.type === "cancellation.requested").length;
    if (count !== 1) {
      throw new CompanionError(
        "E_STATE",
        `Expected exactly one cancellation-request event, found ${count}.`
      );
    }
    cancellationRequestSequence = (updated.lifecycleEvents || [])
      .find((event) => event.type === "cancellation.requested")?.sequence ?? cancellationRequestSequence;
  }

  const receiptId = `cancel-${digestKey(`${workerId}:${idempotencyKey}`).slice(0, 24)}`;
  const receipt = Object.freeze({
    receiptId,
    workerId,
    status,
    requestAcceptedAt,
    processGroupGoneAt,
    terminalRecordCommittedAt,
    idempotencyKeyDigest: digestKey(idempotencyKey),
    cancellationRequestSequence
  });

  // Stamp receipt id onto job when we transitioned it.
  if (status === "accepted" || status === "already_cancelled") {
    try {
      updateJob(root, workerId, (current) => ({
        ...current,
        result: {
          ...(current.result || {}),
          hostVerification: current.result?.hostVerification || "not_run",
          cancellation: {
            ...(current.result?.cancellation || {}),
            receiptId,
            requestAcceptedAt,
            processGroupGoneAt,
            terminalRecordCommittedAt
          }
        }
      }), env);
    } catch {
      /* best-effort stamp */
    }
  }

  writeIdempotency(root, "cancel", idempotencyKey, {
    workerId,
    receipt,
    committedAt: requestAcceptedAt
  }, env);

  return { receipt, replayed: false };
}

export function projectCancellationReceipt(receipt) {
  if (!receipt) return null;
  return {
    receiptId: receipt.receiptId,
    workerId: receipt.workerId,
    status: receipt.status,
    requestAcceptedAt: receipt.requestAcceptedAt,
    idempotencyKeyDigest: receipt.idempotencyKeyDigest || null,
    cancellationRequestSequence: receipt.cancellationRequestSequence ?? null
  };
}

export function getSpawnIdempotencyRecord(root, key, env = process.env) {
  return readIdempotency(root, "spawn", key, env);
}
