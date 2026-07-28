/**
 * Durable control-plane outbox.
 *
 * GitHub workflow dispatch and cancellation are at-least-once side effects.
 * D1 stores only opaque control IDs, leases, attempt counts, and safe error
 * codes. It never stores repository content, prompts, credentials, or model
 * output.
 */

import {
  OUTBOX_BACKOFF_BASE_MS,
  OUTBOX_BACKOFF_MAX_MS,
  OUTBOX_BATCH_SIZE,
  OUTBOX_JOB_TYPE,
  OUTBOX_LEASE_MS,
  OUTBOX_MAX_BATCHES,
  REQUEST_STATUS,
  WATCHDOG_BATCH_SIZE,
  WATCHDOG_STALE_MS
} from "./constants.mjs";
import {
  casWatchdogTerminal,
  casMarkFailedDispatch,
  claimWorkflowRunOrEnqueueOrphan,
  completeOutboxJob,
  getRequestById,
  isRetryableDispatchStatus,
  leaseOutboxJobs,
  listStaleActiveRequests,
  repairOutboxJobs,
  rescheduleOutboxJob,
  supersedePrRequestsWithOutbox
} from "./db.mjs";
import {
  cancelWorkflowRun,
  controlRepoConfig,
  dispatchWorkflow,
  fetchWorkflowRun
} from "./github.mjs";
import { logSafe } from "./http.mjs";

const SAFE_OUTBOX_ERRORS = Object.freeze({
  INTERNAL: "outbox_internal",
  MISCONFIGURED: "control_repo_misconfigured",
  DISPATCH_NETWORK: "dispatch_network",
  DISPATCH_HTTP: "dispatch_http",
  DISPATCH_RESPONSE: "dispatch_response",
  CANCEL_NETWORK: "cancel_network",
  CANCEL_HTTP: "cancel_http"
});

function iso(ms) {
  return new Date(ms).toISOString();
}

function boundedBatchSize(value) {
  if (!Number.isSafeInteger(value) || value < 1) return OUTBOX_BATCH_SIZE;
  return Math.min(value, OUTBOX_BATCH_SIZE);
}

function boundedBatchCount(value) {
  if (!Number.isSafeInteger(value) || value < 1) return OUTBOX_MAX_BATCHES;
  return Math.min(value, OUTBOX_MAX_BATCHES);
}

function leaseOwner(value, nowMs) {
  if (
    typeof value === "string"
    && value.length >= 1
    && value.length <= 128
    && /^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    return value;
  }
  const random = globalThis.crypto?.randomUUID?.();
  return `worker:${random || String(nowMs)}`;
}

export function computeOutboxBackoffMs(attemptCount) {
  const attempt = Number.isSafeInteger(attemptCount) && attemptCount > 0
    ? attemptCount
    : 1;
  const exponent = Math.min(attempt - 1, 30);
  return Math.min(
    OUTBOX_BACKOFF_BASE_MS * (2 ** exponent),
    OUTBOX_BACKOFF_MAX_MS
  );
}

function dispatchErrorCode(result) {
  if (result?.reason === "network_error") return SAFE_OUTBOX_ERRORS.DISPATCH_NETWORK;
  if (result?.reason === "http_error") return SAFE_OUTBOX_ERRORS.DISPATCH_HTTP;
  return SAFE_OUTBOX_ERRORS.DISPATCH_RESPONSE;
}

function cancelErrorCode(result) {
  if (result?.reason === "network_error") return SAFE_OUTBOX_ERRORS.CANCEL_NETWORK;
  return SAFE_OUTBOX_ERRORS.CANCEL_HTTP;
}

function controlConfigReady(config) {
  return Boolean(config.token && config.owner && config.repo && config.workflowId && config.ref);
}

async function finishJob(env, job, owner, nowMs) {
  return completeOutboxJob(env.DB, job.job_id, owner, iso(nowMs));
}

async function retryJob(env, job, owner, nowMs, errorCode) {
  const attempt = Number(job.attempt_count || 0) + 1;
  const delay = computeOutboxBackoffMs(attempt);
  return rescheduleOutboxJob(env.DB, job.job_id, {
    leaseOwner: owner,
    availableAt: iso(nowMs + delay),
    updatedAt: iso(nowMs),
    errorCode
  });
}

async function processDispatchJob(env, job, owner, nowMs, fetchImpl) {
  const request = await getRequestById(env.DB, job.request_id);
  if (
    !request
    || request.workflow_run_id != null
    || !isRetryableDispatchStatus(request.status)
  ) {
    await finishJob(env, job, owner, nowMs);
    return "obsolete";
  }

  const config = controlRepoConfig(env);
  if (!controlConfigReady(config)) {
    await casMarkFailedDispatch(env.DB, request.request_id, iso(nowMs));
    await retryJob(env, job, owner, nowMs, SAFE_OUTBOX_ERRORS.MISCONFIGURED);
    return "retried";
  }

  const result = await dispatchWorkflow({
    token: config.token,
    owner: config.owner,
    repo: config.repo,
    workflowId: config.workflowId,
    ref: config.ref,
    inputs: {
      requestId: String(request.request_id),
      installationId: String(request.installation_id),
      repositoryId: String(request.repository_id),
      pullNumber: String(request.pull_number),
      triggerId: String(request.trigger_id),
      actorId: String(request.actor_id),
      triggerKind: request.trigger_kind
    },
    fetchImpl
  });

  if (!result.ok) {
    await casMarkFailedDispatch(env.DB, request.request_id, iso(nowMs));
    await retryJob(env, job, owner, nowMs, dispatchErrorCode(result));
    return "retried";
  }

  let claim;
  try {
    claim = await claimWorkflowRunOrEnqueueOrphan(
      env.DB,
      request.request_id,
      {
        workflowRunId: result.workflowRunId,
        workflowRunUrl: result.workflowRunUrl,
        workflowHtmlUrl: result.workflowHtmlUrl,
        updatedAt: iso(nowMs)
      }
    );
  } catch {
    // The remote side effect may already exist. Keep the dispatch job leased
    // until expiry so a later attempt can reconcile by first-claim fencing.
    await retryJob(env, job, owner, nowMs, SAFE_OUTBOX_ERRORS.INTERNAL);
    return "retried";
  }

  if (claim === "orphan_enqueued") {
    logSafe("info", "dispatch_orphan_cancel_queued", {
      request_id: String(request.request_id),
      workflow_run_id: result.workflowRunId
    });
  }
  await finishJob(env, job, owner, nowMs);
  return claim === "claimed" ? "completed" : "orphaned";
}

async function processCancelJob(env, job, owner, nowMs, fetchImpl) {
  const config = controlRepoConfig(env);
  if (!controlConfigReady(config)) {
    await retryJob(env, job, owner, nowMs, SAFE_OUTBOX_ERRORS.MISCONFIGURED);
    return "retried";
  }
  const result = await cancelWorkflowRun({
    token: config.token,
    owner: config.owner,
    repo: config.repo,
    runId: String(job.workflow_run_id),
    fetchImpl
  });
  // GitHub reports already-finished or absent runs as non-success. Both are
  // terminal for a best-effort cancellation job and safe to reconcile.
  if (result.ok || [404, 409, 422].includes(result.status)) {
    await finishJob(env, job, owner, nowMs);
    return "completed";
  }
  await retryJob(env, job, owner, nowMs, cancelErrorCode(result));
  return "retried";
}

async function processLeasedJob(env, job, owner, nowMs, fetchImpl) {
  try {
    if (job.job_type === OUTBOX_JOB_TYPE.DISPATCH) {
      return await processDispatchJob(env, job, owner, nowMs, fetchImpl);
    }
    if (job.job_type === OUTBOX_JOB_TYPE.CANCEL) {
      return await processCancelJob(env, job, owner, nowMs, fetchImpl);
    }
    await retryJob(env, job, owner, nowMs, SAFE_OUTBOX_ERRORS.INTERNAL);
    return "retried";
  } catch {
    await retryJob(env, job, owner, nowMs, SAFE_OUTBOX_ERRORS.INTERNAL);
    return "retried";
  }
}

/**
 * Repair missing jobs, lease one bounded batch, and process it. The options
 * make scheduling, competition, and backoff deterministic in tests.
 */
export async function processOutbox(env, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const now = iso(nowMs);
  const owner = leaseOwner(options.workerId, nowMs);
  await repairOutboxJobs(env.DB, now);
  const leased = await leaseOutboxJobs(env.DB, {
    now,
    leaseOwner: owner,
    leaseExpiresAt: iso(nowMs + OUTBOX_LEASE_MS),
    limit: boundedBatchSize(options.batchSize)
  });
  const stats = {
    leased: leased.length,
    completed: 0,
    retried: 0,
    obsolete: 0,
    orphaned: 0
  };
  for (const job of leased) {
    const result = await processLeasedJob(
      env,
      job,
      owner,
      nowMs,
      options.fetchImpl
    );
    if (Object.prototype.hasOwnProperty.call(stats, result)) {
      stats[result] += 1;
    }
  }
  return stats;
}

/**
 * Deterministically drain up to a bounded number of batches.
 */
export async function drainOutbox(env, options = {}) {
  const maxBatches = boundedBatchCount(options.maxBatches);
  const total = {
    batches: 0,
    leased: 0,
    completed: 0,
    retried: 0,
    obsolete: 0,
    orphaned: 0
  };
  for (let i = 0; i < maxBatches; i += 1) {
    const result = await processOutbox(env, options);
    total.batches += 1;
    for (const key of ["leased", "completed", "retried", "obsolete", "orphaned"]) {
      total[key] += result[key];
    }
    if (result.leased === 0 || result.retried > 0) break;
  }
  return total;
}

/**
 * Reconcile workflows that died before any callback. Age selects candidates;
 * only an exact, bound GitHub `status=completed` response authorizes a state
 * transition.
 */
export async function processWorkflowWatchdog(env, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const staleMs = Number.isFinite(options.staleMs) && Number(options.staleMs) >= WATCHDOG_STALE_MS
    ? Number(options.staleMs)
    : WATCHDOG_STALE_MS;
  const config = controlRepoConfig(env);
  const stats = { scanned: 0, terminalized: 0, stillRunning: 0, errors: 0 };
  if (!controlConfigReady(config)) {
    stats.errors = 1;
    return stats;
  }
  const rows = await listStaleActiveRequests(
    env.DB,
    iso(nowMs - staleMs),
    WATCHDOG_BATCH_SIZE
  );
  for (const row of rows) {
    stats.scanned += 1;
    const run = await fetchWorkflowRun({
      token: config.token,
      owner: config.owner,
      repo: config.repo,
      workflowId: config.workflowId,
      runId: String(row.workflow_run_id),
      fetchImpl: options.fetchImpl
    });
    if (!run.ok) {
      stats.errors += 1;
      continue;
    }
    if (run.status !== "completed") {
      stats.stillRunning += 1;
      continue;
    }
    const status = run.conclusion === "cancelled"
      ? REQUEST_STATUS.CANCELLED
      : REQUEST_STATUS.FAILED;
    if (await casWatchdogTerminal(env.DB, row.request_id, {
      status,
      workflowRunId: String(row.workflow_run_id),
      updatedAt: iso(nowMs)
    })) {
      stats.terminalized += 1;
    }
  }
  return stats;
}

export async function runScheduledMaintenance(env, options = {}) {
  const outbox = await drainOutbox(env, options);
  const watchdog = await processWorkflowWatchdog(env, options);
  return { outbox, watchdog };
}

/**
 * Lifecycle helper retained for explicit repair/admin calls.
 */
export async function supersedePrAndQueueCancellation(env, key, nowMs = Date.now()) {
  return supersedePrRequestsWithOutbox(env.DB, key, iso(nowMs));
}

export { SAFE_OUTBOX_ERRORS };
