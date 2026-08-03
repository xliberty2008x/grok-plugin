/** Issue #56 worker-mutation primitives domain. */
import crypto from "node:crypto";
import { CompanionError, asErrorPayload } from "./errors.mjs";
import { sameHostSession } from "./host.mjs";
import { processGroupGone, processStartToken } from "./process-control.mjs";

export const SPAWN_OWNERSHIP_MODE = "exact-thread-or-host-attested-parent";

export const FOLLOWUP_SPAWN_OWNERSHIP_MODE = "exact-root-owner-grant";

export const SPAWN_SUCCESS_DEFINITION = "durable-job-commit";

export function completeOwnedProcessIdentity(identity) {
  return Boolean(
    identity
    && Number.isInteger(identity.pid)
    && identity.pid > 0
    && typeof identity.startToken === "string"
    && identity.startToken.length > 0
    && identity.startToken.length <= 256
    && identity.startToken !== "[REDACTED]"
    && Object.hasOwn(identity, "processGroupId")
    && (process.platform === "win32"
      ? identity.processGroupId === null
      : identity.processGroupId === identity.pid)
  );
}

export function currentOwnedProcessIdentity(identity) {
  return completeOwnedProcessIdentity(identity)
    && processStartToken(identity.pid) === identity.startToken;
}

export function sameDispatchProcessWitness(left, right, { nonce = false, allowUnsettled = false } = {}) {
  const validWitness = (identity) => Boolean(
    identity
    && Number.isInteger(identity.pid)
    && identity.pid > 0
    && ((allowUnsettled && identity.startToken === null)
      || (typeof identity.startToken === "string"
        && identity.startToken.length > 0
        && identity.startToken.length <= 256
        && identity.startToken !== "[REDACTED]"))
    && Object.hasOwn(identity, "processGroupId")
    && (process.platform === "win32"
      ? identity.processGroupId === null
      : identity.processGroupId === identity.pid)
  );
  return validWitness(left)
    && validWitness(right)
    && left.pid === right.pid
    && left.startToken === right.startToken
    && left.processGroupId === right.processGroupId
    && left.commandMarker === right.commandMarker
    && left.dispatchAttemptId === right.dispatchAttemptId
    && left.dispatchFence === right.dispatchFence
    && left.providerGeneration === right.providerGeneration
    && (!nonce || left.nonce === right.nonce);
}

export function sameDispatchProcessIdentity(left, right, { nonce = false } = {}) {
  return sameDispatchProcessWitness(left, right, { nonce, allowUnsettled: false });
}

export const SHA256_HEX = /^[0-9a-f]{64}$/;

export function digestKey(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function canonicalize(value, stack = new Set()) {
  if (value === null || typeof value !== "object") return value;
  if (stack.has(value)) {
    throw new CompanionError("E_USAGE", "Mutation request must not contain cyclic data.");
  }
  stack.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => canonicalize(item, stack));
  } else {
    result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = canonicalize(value[key], stack);
    }
  }
  stack.delete(value);
  return result;
}

export function stableDigest(value) {
  return digestKey(JSON.stringify(canonicalize(value)));
}

export function isPlainRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function hasExactKeys(value, keys) {
  return isPlainRecord(value)
    && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key));
}

export function runSuccessfulRuntimeCleanup(runtimeCleanup, job) {
  const cleanup = typeof runtimeCleanup === "function"
    ? runtimeCleanup(job)
    : runtimeCleanup;
  if (!isPlainRecord(cleanup) || typeof cleanup.ok !== "boolean") {
    throw new CompanionError("E_STATE", "Runtime cleanup did not return a durable cleanup outcome.");
  }
  if (!cleanup.ok) {
    throw new CompanionError(
      "E_RUNTIME_CLEANUP",
      "Runtime cleanup remained incomplete; terminal publication is blocked.",
      { warning: cleanup.warning || "Runtime cleanup remained incomplete." }
    );
  }
  return cleanup;
}

export function spawnRequestOwner(principal) {
  return {
    hostKind: principal?.hostKind || "codex",
    sessionId: principal?.threadId || null
  };
}

export function assertMutationOwnership(job, principal) {
  if (!job || !principal) {
    throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
  }
  const host = { kind: principal.hostKind || "codex", sessionId: principal.threadId };
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

export function ownershipHost(principal) {
  return Object.freeze({ kind: principal.hostKind || "codex", sessionId: principal.threadId });
}

export function cancellationNonce(job) {
  if (typeof job?.workerProcess?.nonce === "string") return job.workerProcess.nonce;
  if (typeof job?.workerAuthorization === "string") return job.workerAuthorization;
  if (typeof job?.workerAuthorization?.nonce === "string") return job.workerAuthorization.nonce;
  return null;
}

export function validIsoTimestamp(value) {
  if (typeof value !== "string" || !value) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}
