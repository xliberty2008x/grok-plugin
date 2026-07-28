/**
 * D1 control-plane access.
 * All GitHub external IDs are TEXT (canonical decimal strings).
 * State transitions use compare-and-set predicates.
 */

import {
  OUTBOX_JOB_STATUS,
  OUTBOX_JOB_TYPE,
  REQUEST_STATUS,
  RETRYABLE_DISPATCH_STATUSES,
  SUPERSEDABLE_STATUSES,
  TERMINAL_STATUSES
} from "./constants.mjs";

const REQUEST_SELECT = `SELECT request_id, request_key, receipt_id,
        installation_id, repository_id, pull_number,
        trigger_kind, trigger_id, actor_id, status, delivery_id, payload_digest,
        expected_head_sha, policy_version, workflow_run_id, workflow_run_url, workflow_html_url,
        check_run_id, authorized_at, created_at, updated_at
 FROM review_requests`;

const OUTBOX_SELECT = `SELECT job_id, job_key, job_type, request_id, workflow_run_id,
        status, attempt_count, available_at, lease_owner, lease_expires_at,
        last_error_code, created_at, updated_at
 FROM outbox_jobs`;

/**
 * @param {import("@cloudflare/workers-types").D1Database} d1
 * @param {string} deliveryId
 */
export async function getDelivery(d1, deliveryId) {
  return d1
    .prepare(
      `SELECT delivery_id, event_name, payload_digest, received_at, status
       FROM webhook_deliveries WHERE delivery_id = ?`
    )
    .bind(deliveryId)
    .first();
}

/**
 * @param {import("@cloudflare/workers-types").D1Database} d1
 * @param {object} row
 */
export async function insertDelivery(d1, row) {
  try {
    const result = await d1
      .prepare(
        `INSERT INTO webhook_deliveries
          (delivery_id, event_name, payload_digest, received_at, status)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(row.deliveryId, row.eventName, row.payloadDigest, row.receivedAt, row.status)
      .run();
    return result?.success !== false;
  } catch (error) {
    const message = String(error?.message || error);
    if (/unique|constraint|already exists/i.test(message)) return false;
    throw error;
  }
}

/**
 * @param {import("@cloudflare/workers-types").D1Database} d1
 * @param {string} deliveryId
 * @param {string} status
 */
export async function updateDeliveryStatus(d1, deliveryId, status) {
  await d1
    .prepare(`UPDATE webhook_deliveries SET status = ? WHERE delivery_id = ?`)
    .bind(status, deliveryId)
    .run();
}

/**
 * @param {import("@cloudflare/workers-types").D1Database} d1
 * @param {{ deliveryId: string, eventName: string, payloadDigest: string, receivedAt: string }} input
 */
export async function admitDelivery(d1, input) {
  const existing = await getDelivery(d1, input.deliveryId);
  if (existing) {
    if (existing.payload_digest !== input.payloadDigest) {
      return { outcome: "mismatch", delivery: existing };
    }
    return { outcome: "replay", delivery: existing };
  }

  const inserted = await insertDelivery(d1, {
    deliveryId: input.deliveryId,
    eventName: input.eventName,
    payloadDigest: input.payloadDigest,
    receivedAt: input.receivedAt,
    status: "admitted"
  });

  if (!inserted) {
    const raced = await getDelivery(d1, input.deliveryId);
    if (!raced) return { outcome: "mismatch", delivery: null };
    if (raced.payload_digest !== input.payloadDigest) {
      return { outcome: "mismatch", delivery: raced };
    }
    return { outcome: "replay", delivery: raced };
  }

  return {
    outcome: "new",
    delivery: {
      delivery_id: input.deliveryId,
      event_name: input.eventName,
      payload_digest: input.payloadDigest,
      received_at: input.receivedAt,
      status: "admitted"
    }
  };
}

/**
 * @param {import("@cloudflare/workers-types").D1Database} d1
 * @param {string} installationId
 */
export async function getInstallation(d1, installationId) {
  return d1
    .prepare(
      `SELECT installation_id, account_id, account_type, repository_selection,
              suspended, created_at, updated_at
       FROM installations WHERE installation_id = ?`
    )
    .bind(installationId)
    .first();
}

/**
 * Active = row exists and suspended = 0.
 * @param {import("@cloudflare/workers-types").D1Database} d1
 * @param {string} installationId
 * @param {string} repositoryId
 */
export async function isInstallationRepoAuthorized(d1, installationId, repositoryId) {
  const installation = await getInstallation(d1, installationId);
  if (!installation) return false;
  if (Number(installation.suspended) !== 0) return false;
  if (installation.repository_selection === "all") return true;
  if (installation.repository_selection !== "selected") return false;
  const repo = await d1
    .prepare(
      `SELECT installation_id, repository_id FROM installation_repositories
       WHERE installation_id = ? AND repository_id = ?`
    )
    .bind(installationId, repositoryId)
    .first();
  return Boolean(repo);
}

/**
 * @param {import("@cloudflare/workers-types").D1Database} d1
 * @param {object} row
 */
export async function upsertInstallation(d1, row) {
  await d1
    .prepare(
      `INSERT INTO installations (
         installation_id, account_id, account_type, repository_selection,
         suspended, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(installation_id) DO UPDATE SET
         account_id = excluded.account_id,
         account_type = excluded.account_type,
         repository_selection = excluded.repository_selection,
         suspended = excluded.suspended,
         updated_at = excluded.updated_at`
    )
    .bind(
      row.installationId,
      row.accountId,
      row.accountType,
      row.repositorySelection === "all" ? "all" : "selected",
      row.suspended,
      row.createdAt,
      row.updatedAt
    )
    .run();
}

/**
 * Insert installation only if missing. Never changes suspended on existing rows.
 * Used by reordered installation_repositories events.
 * @param {import("@cloudflare/workers-types").D1Database} d1
 * @param {object} row
 */
export async function ensureInstallationRow(d1, row) {
  await d1
    .prepare(
      `INSERT INTO installations (
         installation_id, account_id, account_type, repository_selection,
         suspended, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(installation_id) DO NOTHING`
    )
    .bind(
      row.installationId,
      row.accountId,
      row.accountType,
      row.repositorySelection === "all" ? "all" : "selected",
      row.suspended,
      row.createdAt,
      row.updatedAt
    )
    .run();
}

/**
 * CAS: set suspended only when row exists.
 * @param {import("@cloudflare/workers-types").D1Database} d1
 * @param {string} installationId
 * @param {number} suspended
 * @param {string} updatedAt
 */
export async function setInstallationSuspended(d1, installationId, suspended, updatedAt) {
  const result = await d1
    .prepare(
      `UPDATE installations SET suspended = ?, updated_at = ?
       WHERE installation_id = ?`
    )
    .bind(suspended, updatedAt, installationId)
    .run();
  return (result?.meta?.changes ?? 0) > 0;
}

export async function setInstallationRepositorySelection(
  d1,
  installationId,
  repositorySelection,
  updatedAt
) {
  const result = await d1
    .prepare(
      `UPDATE installations
       SET repository_selection = ?, updated_at = ?
       WHERE installation_id = ?`
    )
    .bind(repositorySelection, updatedAt, installationId)
    .run();
  return (result?.meta?.changes ?? 0) > 0;
}

/**
 * @param {import("@cloudflare/workers-types").D1Database} d1
 * @param {string} installationId
 */
export async function deleteInstallation(d1, installationId) {
  await d1
    .prepare(`DELETE FROM installation_repositories WHERE installation_id = ?`)
    .bind(installationId)
    .run();
  await d1
    .prepare(`DELETE FROM installations WHERE installation_id = ?`)
    .bind(installationId)
    .run();
}

/**
 * @param {import("@cloudflare/workers-types").D1Database} d1
 * @param {string} installationId
 * @param {string} repositoryId
 */
export async function addInstallationRepository(d1, installationId, repositoryId) {
  await d1
    .prepare(
      `INSERT OR IGNORE INTO installation_repositories (installation_id, repository_id)
       VALUES (?, ?)`
    )
    .bind(installationId, repositoryId)
    .run();
}

/**
 * @param {import("@cloudflare/workers-types").D1Database} d1
 * @param {string} installationId
 * @param {string} repositoryId
 */
export async function removeInstallationRepository(d1, installationId, repositoryId) {
  await d1
    .prepare(
      `DELETE FROM installation_repositories
       WHERE installation_id = ? AND repository_id = ?`
    )
    .bind(installationId, repositoryId)
    .run();
}

export async function clearInstallationRepositories(d1, installationId) {
  await d1
    .prepare(`DELETE FROM installation_repositories WHERE installation_id = ?`)
    .bind(installationId)
    .run();
}

/**
 * @param {import("@cloudflare/workers-types").D1Database} d1
 * @param {string} requestKey
 */
export async function getRequestByKey(d1, requestKey) {
  return d1
    .prepare(`${REQUEST_SELECT} WHERE request_key = ?`)
    .bind(requestKey)
    .first();
}

/**
 * @param {import("@cloudflare/workers-types").D1Database} d1
 * @param {string|number} requestId
 */
export async function getRequestById(d1, requestId) {
  return d1
    .prepare(`${REQUEST_SELECT} WHERE request_id = ?`)
    .bind(String(requestId))
    .first();
}

/**
 * @param {import("@cloudflare/workers-types").D1Database} d1
 * @param {object} row
 */
export async function insertReviewRequest(d1, row) {
  try {
    const result = await d1
      .prepare(
        `INSERT INTO review_requests (
           request_key, receipt_id, installation_id, repository_id, pull_number,
           trigger_kind, trigger_id, actor_id, status, delivery_id, payload_digest,
         expected_head_sha, policy_version,
         workflow_run_id, workflow_run_url, workflow_html_url, check_run_id, authorized_at,
         created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`
      )
      .bind(
        row.requestKey,
        row.receiptId,
        row.installationId,
        row.repositoryId,
        row.pullNumber,
        row.triggerKind,
        row.triggerId,
        row.actorId,
        row.status,
        row.deliveryId ?? null,
        row.payloadDigest ?? null,
        row.expectedHeadSha ?? null,
        row.policyVersion ?? null,
        row.createdAt,
        row.updatedAt
      )
      .run();

    const lastId = result?.meta?.last_row_id;
    if (lastId != null && String(lastId) !== "" && String(lastId) !== "0") {
      return getRequestById(d1, String(lastId));
    }
    return getRequestByKey(d1, row.requestKey);
  } catch (error) {
    const message = String(error?.message || error);
    if (/unique|constraint/i.test(message)) {
      return getRequestByKey(d1, row.requestKey);
    }
    throw error;
  }
}

function prepareReviewRequestInsert(d1, row) {
  return d1
    .prepare(
      `INSERT OR IGNORE INTO review_requests (
         request_key, receipt_id, installation_id, repository_id, pull_number,
         trigger_kind, trigger_id, actor_id, status, delivery_id, payload_digest,
         expected_head_sha, policy_version,
         workflow_run_id, workflow_run_url, workflow_html_url, check_run_id, authorized_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`
    )
    .bind(
      row.requestKey,
      row.receiptId,
      row.installationId,
      row.repositoryId,
      row.pullNumber,
      row.triggerKind,
      row.triggerId,
      row.actorId,
      row.status,
      row.deliveryId ?? null,
      row.payloadDigest ?? null,
      row.expectedHeadSha ?? null,
      row.policyVersion ?? null,
      row.createdAt,
      row.updatedAt
    );
}

function prepareDispatchOutboxForRequestKey(d1, requestKey, now) {
  const placeholders = RETRYABLE_DISPATCH_STATUSES.map(() => "?").join(", ");
  return d1
    .prepare(
      `INSERT OR IGNORE INTO outbox_jobs (
         job_key, job_type, request_id, workflow_run_id, status, attempt_count,
         available_at, lease_owner, lease_expires_at, last_error_code,
         created_at, updated_at
       )
       SELECT 'dispatch:' || request_key, ?, CAST(request_id AS TEXT), NULL, ?, 0,
              ?, NULL, NULL, NULL, ?, ?
       FROM review_requests
       WHERE request_key = ?
         AND status IN (${placeholders})
         AND workflow_run_id IS NULL`
    )
    .bind(
      OUTBOX_JOB_TYPE.DISPATCH,
      OUTBOX_JOB_STATUS.PENDING,
      now,
      now,
      now,
      requestKey,
      ...RETRYABLE_DISPATCH_STATUSES
    );
}

function prepareSupersessionStatements(d1, whereSql, whereParams, now) {
  const placeholders = SUPERSEDABLE_STATUSES.map(() => "?").join(", ");
  const cancel = d1
    .prepare(
      `INSERT OR IGNORE INTO outbox_jobs (
         job_key, job_type, request_id, workflow_run_id, status, attempt_count,
         available_at, lease_owner, lease_expires_at, last_error_code,
         created_at, updated_at
       )
       SELECT 'cancel:' || workflow_run_id, ?, CAST(request_id AS TEXT),
              workflow_run_id, ?, 0, ?, NULL, NULL, NULL, ?, ?
       FROM review_requests
       WHERE ${whereSql}
         AND status IN (${placeholders})
         AND workflow_run_id IS NOT NULL`
    )
    .bind(
      OUTBOX_JOB_TYPE.CANCEL,
      OUTBOX_JOB_STATUS.PENDING,
      now,
      now,
      now,
      ...whereParams,
      ...SUPERSEDABLE_STATUSES
    );
  const update = d1
    .prepare(
      `UPDATE review_requests
       SET status = ?, updated_at = ?
       WHERE ${whereSql}
         AND status IN (${placeholders})`
    )
    .bind(
      REQUEST_STATUS.SUPERSEDED,
      now,
      ...whereParams,
      ...SUPERSEDABLE_STATUSES
    );
  return [cancel, update];
}

/**
 * Atomically insert one semantic request and enqueue its dispatch. Admission
 * never supersedes PR work; only the later live-authorized callback may do so.
 * D1 batch statements commit as one transaction.
 */
export async function admitReviewRequestWithOutbox(d1, row) {
  const statements = [
    prepareReviewRequestInsert(d1, row),
    prepareDispatchOutboxForRequestKey(d1, row.requestKey, row.createdAt)
  ];
  await d1.batch(statements);
  return getRequestByKey(d1, row.requestKey);
}

/**
 * Atomically supersede active PR requests and queue cancellation for every
 * already-known workflow run.
 */
export async function supersedePrRequestsWithOutbox(d1, key, updatedAt) {
  const where = key.exceptRequestKey
    ? `installation_id = ? AND repository_id = ? AND pull_number = ? AND request_key <> ?`
    : `installation_id = ? AND repository_id = ? AND pull_number = ?`;
  const params = key.exceptRequestKey
    ? [key.installationId, key.repositoryId, key.pullNumber, key.exceptRequestKey]
    : [key.installationId, key.repositoryId, key.pullNumber];
  const results = await d1.batch(
    prepareSupersessionStatements(d1, where, params, updatedAt)
  );
  return results?.[1]?.meta?.changes ?? 0;
}

export async function supersedeInstallationRequestsWithOutbox(d1, installationId, updatedAt) {
  const results = await d1.batch(
    prepareSupersessionStatements(
      d1,
      "installation_id = ?",
      [installationId],
      updatedAt
    )
  );
  return results?.[1]?.meta?.changes ?? 0;
}

export async function supersedeRepositoryRequestsWithOutbox(
  d1,
  installationId,
  repositoryId,
  updatedAt
) {
  const results = await d1.batch(
    prepareSupersessionStatements(
      d1,
      "installation_id = ? AND repository_id = ?",
      [installationId, repositoryId],
      updatedAt
    )
  );
  return results?.[1]?.meta?.changes ?? 0;
}

/**
 * After the runner has re-fetched and live-authorized the exact PR context,
 * atomically record the one-shot authorization and supersede only lower
 * request IDs for the PR. A request that becomes stale between its authority
 * fetch and this callback can therefore never cancel newer admitted work.
 * Unsigned workflow inputs and webhook arrival order never receive authority.
 */
export async function authorizeReviewRequestWithOutbox(
  d1,
  requestId,
  workflowRunId,
  authorizedAt
) {
  const rid = String(requestId);
  const authorize = d1
    .prepare(
      `UPDATE review_requests
       SET authorized_at = ?, updated_at = ?
       WHERE request_id = ?
         AND workflow_run_id = ?
         AND status = ?
         AND authorized_at IS NULL
         AND trigger_kind IN (?, ?, ?)`
    )
    .bind(
      authorizedAt,
      authorizedAt,
      rid,
      workflowRunId,
      REQUEST_STATUS.CLAIMED,
      "automatic",
      "manual_comment",
      "check_rerun"
    );
  const placeholders = SUPERSEDABLE_STATUSES.map(() => "?").join(", ");
  const cancel = d1
    .prepare(
      `INSERT OR IGNORE INTO outbox_jobs (
         job_key, job_type, request_id, workflow_run_id, status, attempt_count,
         available_at, lease_owner, lease_expires_at, last_error_code,
         created_at, updated_at
       )
       SELECT 'cancel:' || target.workflow_run_id, ?, CAST(target.request_id AS TEXT),
              target.workflow_run_id, ?, 0, ?, NULL, NULL, NULL, ?, ?
       FROM review_requests target
       JOIN review_requests current ON current.request_id = ?
       WHERE current.workflow_run_id = ?
         AND current.status = ?
         AND current.authorized_at = ?
         AND target.installation_id = current.installation_id
         AND target.repository_id = current.repository_id
         AND target.pull_number = current.pull_number
         AND target.request_id < current.request_id
         AND target.status IN (${placeholders})
         AND target.workflow_run_id IS NOT NULL`
    )
    .bind(
      OUTBOX_JOB_TYPE.CANCEL,
      OUTBOX_JOB_STATUS.PENDING,
      authorizedAt,
      authorizedAt,
      authorizedAt,
      rid,
      workflowRunId,
      REQUEST_STATUS.CLAIMED,
      authorizedAt,
      ...SUPERSEDABLE_STATUSES
    );
  const supersede = d1
    .prepare(
      `UPDATE review_requests
       SET status = ?, updated_at = ?
       WHERE request_id < ?
         AND status IN (${placeholders})
         AND EXISTS (
           SELECT 1 FROM review_requests current
           WHERE current.request_id = ?
             AND current.workflow_run_id = ?
             AND current.status = ?
             AND current.authorized_at = ?
             AND current.installation_id = review_requests.installation_id
             AND current.repository_id = review_requests.repository_id
             AND current.pull_number = review_requests.pull_number
         )`
    )
    .bind(
      REQUEST_STATUS.SUPERSEDED,
      authorizedAt,
      rid,
      ...SUPERSEDABLE_STATUSES,
      rid,
      workflowRunId,
      REQUEST_STATUS.CLAIMED,
      authorizedAt
    );
  const results = await d1.batch([authorize, cancel, supersede]);
  return {
    authorized: (results?.[0]?.meta?.changes ?? 0) > 0,
    superseded: results?.[2]?.meta?.changes ?? 0
  };
}

/**
 * @param {import("@cloudflare/workers-types").D1Database} d1
 * @param {{ installationId: string, repositoryId: string, pullNumber: string }} key
 */
export async function listSupersedableRequestsForPr(d1, key) {
  const placeholders = SUPERSEDABLE_STATUSES.map(() => "?").join(", ");
  const result = await d1
    .prepare(
      `${REQUEST_SELECT}
       WHERE installation_id = ?
         AND repository_id = ?
         AND pull_number = ?
         AND status IN (${placeholders})
       ORDER BY request_id ASC`
    )
    .bind(key.installationId, key.repositoryId, key.pullNumber, ...SUPERSEDABLE_STATUSES)
    .all();
  return result?.results ?? [];
}

/**
 * CAS supersede — only if still supersedable.
 * @returns {Promise<boolean>} whether a row was updated
 */
export async function casMarkRequestSuperseded(d1, requestId, updatedAt) {
  const placeholders = SUPERSEDABLE_STATUSES.map(() => "?").join(", ");
  const result = await d1
    .prepare(
      `UPDATE review_requests
       SET status = ?, updated_at = ?
       WHERE request_id = ? AND status IN (${placeholders})`
    )
    .bind(REQUEST_STATUS.SUPERSEDED, updatedAt, String(requestId), ...SUPERSEDABLE_STATUSES)
    .run();
  return (result?.meta?.changes ?? 0) > 0;
}

/**
 * First-claim wins for workflow_run_id.
 * Only transitions from retryable dispatch statuses with NULL workflow_run_id.
 * Does not revive superseded/terminal rows.
 * @returns {Promise<boolean>}
 */
export async function casClaimWorkflowRun(d1, requestId, data) {
  const placeholders = RETRYABLE_DISPATCH_STATUSES.map(() => "?").join(", ");
  const result = await d1
    .prepare(
      `UPDATE review_requests
       SET status = ?, workflow_run_id = ?, workflow_run_url = ?, workflow_html_url = ?, updated_at = ?
       WHERE request_id = ?
         AND status IN (${placeholders})
         AND workflow_run_id IS NULL`
    )
    .bind(
      REQUEST_STATUS.DISPATCHED,
      data.workflowRunId,
      data.workflowRunUrl,
      data.workflowHtmlUrl,
      data.updatedAt,
      String(requestId),
      ...RETRYABLE_DISPATCH_STATUSES
    )
    .run();
  return (result?.meta?.changes ?? 0) > 0;
}

/**
 * Atomically claim the first workflow run for a request or enqueue cancellation
 * for the returned orphan run when another claim/state already won.
 */
export async function claimWorkflowRunOrEnqueueOrphan(d1, requestId, data) {
  const placeholders = RETRYABLE_DISPATCH_STATUSES.map(() => "?").join(", ");
  const update = d1
    .prepare(
      `UPDATE review_requests
       SET status = ?, workflow_run_id = ?, workflow_run_url = ?, workflow_html_url = ?, updated_at = ?
       WHERE request_id = ?
         AND status IN (${placeholders})
         AND workflow_run_id IS NULL`
    )
    .bind(
      REQUEST_STATUS.DISPATCHED,
      data.workflowRunId,
      data.workflowRunUrl,
      data.workflowHtmlUrl,
      data.updatedAt,
      String(requestId),
      ...RETRYABLE_DISPATCH_STATUSES
    );
  const cancel = d1
    .prepare(
      `INSERT OR IGNORE INTO outbox_jobs (
         job_key, job_type, request_id, workflow_run_id, status, attempt_count,
         available_at, lease_owner, lease_expires_at, last_error_code,
         created_at, updated_at
       )
       SELECT 'cancel:' || ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM review_requests
         WHERE request_id = ? AND workflow_run_id = ?
       )`
    )
    .bind(
      data.workflowRunId,
      OUTBOX_JOB_TYPE.CANCEL,
      String(requestId),
      data.workflowRunId,
      OUTBOX_JOB_STATUS.PENDING,
      data.updatedAt,
      data.updatedAt,
      data.updatedAt,
      String(requestId),
      data.workflowRunId
    );
  const results = await d1.batch([update, cancel]);
  if ((results?.[0]?.meta?.changes ?? 0) > 0) return "claimed";
  if ((results?.[1]?.meta?.changes ?? 0) > 0) return "orphan_enqueued";
  return "already_claimed";
}

/**
 * CAS failed_dispatch only from retryable statuses.
 * @returns {Promise<boolean>}
 */
export async function casMarkFailedDispatch(d1, requestId, updatedAt) {
  const placeholders = RETRYABLE_DISPATCH_STATUSES.map(() => "?").join(", ");
  const result = await d1
    .prepare(
      `UPDATE review_requests
       SET status = ?, updated_at = ?
       WHERE request_id = ? AND status IN (${placeholders})`
    )
    .bind(REQUEST_STATUS.FAILED_DISPATCH, updatedAt, String(requestId), ...RETRYABLE_DISPATCH_STATUSES)
    .run();
  return (result?.meta?.changes ?? 0) > 0;
}

/**
 * Executor claim: dispatched → claimed with matching workflow_run_id.
 * @returns {Promise<boolean>}
 */
export async function casClaimExecutor(d1, requestId, workflowRunId, updatedAt) {
  const result = await d1
    .prepare(
      `UPDATE review_requests
       SET status = ?, updated_at = ?
       WHERE request_id = ?
         AND status = ?
         AND workflow_run_id = ?`
    )
    .bind(
      REQUEST_STATUS.CLAIMED,
      updatedAt,
      String(requestId),
      REQUEST_STATUS.DISPATCHED,
      workflowRunId
    )
    .run();
  return (result?.meta?.changes ?? 0) > 0;
}

/**
 * claimed → started; may bind check_run_id once.
 * @returns {Promise<boolean>}
 */
export async function casMarkStarted(d1, requestId, workflowRunId, checkRunId, updatedAt) {
  const result = await d1
    .prepare(
      `UPDATE review_requests
       SET status = ?,
           check_run_id = COALESCE(check_run_id, ?),
           updated_at = ?
       WHERE request_id = ?
         AND status = ?
         AND workflow_run_id = ?
         AND authorized_at IS NOT NULL
         AND (check_run_id IS NULL OR check_run_id = ?)`
    )
    .bind(
      REQUEST_STATUS.STARTED,
      checkRunId,
      updatedAt,
      String(requestId),
      REQUEST_STATUS.CLAIMED,
      workflowRunId,
      checkRunId
    )
    .run();
  return (result?.meta?.changes ?? 0) > 0;
}

/**
 * One-way terminal from claimed|started only, with workflow binding.
 * Prefer casCommitTerminalWithReceipt for atomic receipt pairing.
 * @returns {Promise<boolean>}
 */
export async function casMarkTerminal(d1, requestId, data) {
  const result = await d1
    .prepare(
      `UPDATE review_requests
       SET status = ?,
           check_run_id = COALESCE(check_run_id, ?),
           updated_at = ?
       WHERE request_id = ?
         AND status IN (?, ?)
         AND workflow_run_id = ?
         AND authorized_at IS NOT NULL
         AND (check_run_id IS NULL OR check_run_id = ? OR ? IS NULL)`
    )
    .bind(
      data.status,
      data.checkRunId ?? null,
      data.updatedAt,
      String(requestId),
      REQUEST_STATUS.CLAIMED,
      REQUEST_STATUS.STARTED,
      data.workflowRunId,
      data.checkRunId ?? null,
      data.checkRunId ?? null
    )
    .run();
  return (result?.meta?.changes ?? 0) > 0;
}

/**
 * Receipt-free early terminalization. Only a claimed request with no check or
 * a started request with the exact already-bound check may abort.
 */
export async function casAbortRequest(d1, requestId, data) {
  const result = await d1
    .prepare(
      `UPDATE review_requests
       SET status = ?, updated_at = ?
       WHERE request_id = ?
         AND workflow_run_id = ?
         AND (
           (status = ? AND check_run_id IS NULL AND ? IS NULL)
           OR
           (status = ? AND check_run_id = ? AND ? IS NOT NULL)
         )`
    )
    .bind(
      data.status,
      data.updatedAt,
      String(requestId),
      data.workflowRunId,
      REQUEST_STATUS.CLAIMED,
      data.checkRunId ?? null,
      REQUEST_STATUS.STARTED,
      data.checkRunId ?? null,
      data.checkRunId ?? null
    )
    .run();
  return (result?.meta?.changes ?? 0) > 0;
}

/**
 * Restore missing durable work. Also supersedes requests whose installation or
 * selected-repository authorization disappeared between lifecycle events.
 */
export async function repairOutboxJobs(d1, updatedAt) {
  const supersedable = SUPERSEDABLE_STATUSES.map(() => "?").join(", ");
  const retryable = RETRYABLE_DISPATCH_STATUSES.map(() => "?").join(", ");

  const cancelUnauthorized = d1
    .prepare(
      `INSERT OR IGNORE INTO outbox_jobs (
         job_key, job_type, request_id, workflow_run_id, status, attempt_count,
         available_at, lease_owner, lease_expires_at, last_error_code,
         created_at, updated_at
       )
       SELECT 'cancel:' || r.workflow_run_id, ?, CAST(r.request_id AS TEXT),
              r.workflow_run_id, ?, 0, ?, NULL, NULL, NULL, ?, ?
       FROM review_requests r
       LEFT JOIN installations i
         ON i.installation_id = r.installation_id
       LEFT JOIN installation_repositories ir
         ON ir.installation_id = r.installation_id
        AND ir.repository_id = r.repository_id
       WHERE r.status IN (${supersedable})
         AND r.workflow_run_id IS NOT NULL
         AND (
           i.installation_id IS NULL
           OR i.suspended <> 0
           OR (
             i.repository_selection <> 'all'
             AND ir.repository_id IS NULL
           )
         )`
    )
    .bind(
      OUTBOX_JOB_TYPE.CANCEL,
      OUTBOX_JOB_STATUS.PENDING,
      updatedAt,
      updatedAt,
      updatedAt,
      ...SUPERSEDABLE_STATUSES
    );

  const supersedeUnauthorized = d1
    .prepare(
      `UPDATE review_requests
       SET status = ?, updated_at = ?
       WHERE status IN (${supersedable})
         AND NOT EXISTS (
           SELECT 1
           FROM installations i
           LEFT JOIN installation_repositories ir
             ON ir.installation_id = i.installation_id
            AND ir.repository_id = review_requests.repository_id
           WHERE i.installation_id = review_requests.installation_id
             AND i.suspended = 0
             AND (
               i.repository_selection = 'all'
               OR ir.repository_id IS NOT NULL
             )
         )`
    )
    .bind(
      REQUEST_STATUS.SUPERSEDED,
      updatedAt,
      ...SUPERSEDABLE_STATUSES
    );

  const dispatchMissing = d1
    .prepare(
      `INSERT OR IGNORE INTO outbox_jobs (
         job_key, job_type, request_id, workflow_run_id, status, attempt_count,
         available_at, lease_owner, lease_expires_at, last_error_code,
         created_at, updated_at
       )
       SELECT 'dispatch:' || r.request_key, ?, CAST(r.request_id AS TEXT),
              NULL, ?, 0, ?, NULL, NULL, NULL, ?, ?
       FROM review_requests r
       JOIN installations i
         ON i.installation_id = r.installation_id AND i.suspended = 0
       LEFT JOIN installation_repositories ir
         ON ir.installation_id = r.installation_id
        AND ir.repository_id = r.repository_id
       WHERE r.status IN (${retryable})
         AND r.workflow_run_id IS NULL
         AND (
           i.repository_selection = 'all'
           OR ir.repository_id IS NOT NULL
         )`
    )
    .bind(
      OUTBOX_JOB_TYPE.DISPATCH,
      OUTBOX_JOB_STATUS.PENDING,
      updatedAt,
      updatedAt,
      updatedAt,
      ...RETRYABLE_DISPATCH_STATUSES
    );

  const cancelSuperseded = d1
    .prepare(
      `INSERT OR IGNORE INTO outbox_jobs (
         job_key, job_type, request_id, workflow_run_id, status, attempt_count,
         available_at, lease_owner, lease_expires_at, last_error_code,
         created_at, updated_at
       )
       SELECT 'cancel:' || workflow_run_id, ?, CAST(request_id AS TEXT),
              workflow_run_id, ?, 0, ?, NULL, NULL, NULL, ?, ?
       FROM review_requests
       WHERE status = ? AND workflow_run_id IS NOT NULL`
    )
    .bind(
      OUTBOX_JOB_TYPE.CANCEL,
      OUTBOX_JOB_STATUS.PENDING,
      updatedAt,
      updatedAt,
      updatedAt,
      REQUEST_STATUS.SUPERSEDED
    );

  const results = await d1.batch([
    cancelUnauthorized,
    supersedeUnauthorized,
    dispatchMissing,
    cancelSuperseded
  ]);
  return results.reduce(
    (total, result) => total + (result?.meta?.changes ?? 0),
    0
  );
}

export async function getOutboxJobByKey(d1, jobKey) {
  return d1
    .prepare(`${OUTBOX_SELECT} WHERE job_key = ?`)
    .bind(jobKey)
    .first();
}

export async function getOutboxJobById(d1, jobId) {
  return d1
    .prepare(`${OUTBOX_SELECT} WHERE job_id = ?`)
    .bind(String(jobId))
    .first();
}

export async function listOutboxJobs(d1) {
  const result = await d1
    .prepare(`${OUTBOX_SELECT} ORDER BY job_id ASC`)
    .all();
  return result?.results ?? [];
}

export async function listStaleActiveRequests(d1, updatedBefore, limit) {
  const result = await d1
    .prepare(
      `${REQUEST_SELECT}
       WHERE status IN (?, ?, ?)
         AND workflow_run_id IS NOT NULL
         AND updated_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM sanitized_receipts sr
           WHERE sr.request_id = CAST(review_requests.request_id AS TEXT)
         )
       ORDER BY request_id ASC
       LIMIT ?`
    )
    .bind(
      REQUEST_STATUS.DISPATCHED,
      REQUEST_STATUS.CLAIMED,
      REQUEST_STATUS.STARTED,
      updatedBefore,
      limit
    )
    .all();
  return result?.results ?? [];
}

/**
 * Host-authoritative terminalization after GitHub confirms the exact workflow
 * run is completed and no signed receipt exists.
 */
export async function casWatchdogTerminal(d1, requestId, data) {
  const result = await d1
    .prepare(
      `UPDATE review_requests
       SET status = ?, updated_at = ?
       WHERE request_id = ?
         AND workflow_run_id = ?
         AND status IN (?, ?, ?)
         AND NOT EXISTS (
           SELECT 1 FROM sanitized_receipts sr
           WHERE sr.request_id = CAST(review_requests.request_id AS TEXT)
         )`
    )
    .bind(
      data.status,
      data.updatedAt,
      String(requestId),
      data.workflowRunId,
      REQUEST_STATUS.DISPATCHED,
      REQUEST_STATUS.CLAIMED,
      REQUEST_STATUS.STARTED
    )
    .run();
  return (result?.meta?.changes ?? 0) > 0;
}

export async function leaseOutboxJobs(d1, input) {
  const candidates = await d1
    .prepare(
      `${OUTBOX_SELECT}
       WHERE (
         (status = ? AND available_at <= ?)
         OR
         (status = ? AND lease_expires_at <= ?)
       )
       ORDER BY job_id ASC
       LIMIT ?`
    )
    .bind(
      OUTBOX_JOB_STATUS.PENDING,
      input.now,
      OUTBOX_JOB_STATUS.LEASED,
      input.now,
      input.limit
    )
    .all();
  const leased = [];
  for (const candidate of candidates?.results ?? []) {
    const result = await d1
      .prepare(
        `UPDATE outbox_jobs
         SET status = ?, lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE job_id = ?
           AND (
             (status = ? AND available_at <= ?)
             OR
             (status = ? AND lease_expires_at <= ?)
           )`
      )
      .bind(
        OUTBOX_JOB_STATUS.LEASED,
        input.leaseOwner,
        input.leaseExpiresAt,
        input.now,
        String(candidate.job_id),
        OUTBOX_JOB_STATUS.PENDING,
        input.now,
        OUTBOX_JOB_STATUS.LEASED,
        input.now
      )
      .run();
    if ((result?.meta?.changes ?? 0) > 0) {
      const row = await getOutboxJobById(d1, candidate.job_id);
      if (row) leased.push(row);
    }
  }
  return leased;
}

export async function completeOutboxJob(d1, jobId, leaseOwner, updatedAt) {
  const result = await d1
    .prepare(
      `UPDATE outbox_jobs
       SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
           last_error_code = NULL, updated_at = ?
       WHERE job_id = ? AND status = ? AND lease_owner = ?`
    )
    .bind(
      OUTBOX_JOB_STATUS.COMPLETED,
      updatedAt,
      String(jobId),
      OUTBOX_JOB_STATUS.LEASED,
      leaseOwner
    )
    .run();
  return (result?.meta?.changes ?? 0) > 0;
}

export async function rescheduleOutboxJob(d1, jobId, input) {
  const result = await d1
    .prepare(
      `UPDATE outbox_jobs
       SET status = ?, attempt_count = attempt_count + 1,
           available_at = ?, lease_owner = NULL, lease_expires_at = NULL,
           last_error_code = ?, updated_at = ?
       WHERE job_id = ? AND status = ? AND lease_owner = ?`
    )
    .bind(
      OUTBOX_JOB_STATUS.PENDING,
      input.availableAt,
      input.errorCode,
      input.updatedAt,
      String(jobId),
      OUTBOX_JOB_STATUS.LEASED,
      input.leaseOwner
    )
    .run();
  return (result?.meta?.changes ?? 0) > 0;
}

export async function enqueueCancelOutboxJob(d1, input) {
  const result = await d1
    .prepare(
      `INSERT OR IGNORE INTO outbox_jobs (
         job_key, job_type, request_id, workflow_run_id, status, attempt_count,
         available_at, lease_owner, lease_expires_at, last_error_code,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, ?, ?)`
    )
    .bind(
      `cancel:${input.workflowRunId}`,
      OUTBOX_JOB_TYPE.CANCEL,
      input.requestId ?? null,
      input.workflowRunId,
      OUTBOX_JOB_STATUS.PENDING,
      input.createdAt,
      input.createdAt,
      input.createdAt
    )
    .run();
  return (result?.meta?.changes ?? 0) > 0;
}

/**
 * Atomic terminal transition + receipt insert in one D1 batch.
 * Receipt INSERT is gated by a SELECT on CAS-eligible request rows so a
 * superseded/terminal row cannot gain a receipt. UNIQUE(request_id) enforces
 * one receipt per request.
 *
 * @returns {Promise<"committed"|"not_eligible"|"conflict">}
 */
export async function casCommitTerminalWithReceipt(d1, requestId, data, receipt) {
  const rid = String(requestId);
  const insertStmt = d1
    .prepare(
      `INSERT INTO sanitized_receipts (
         receipt_id, request_id, workflow_run_id, event, status, check_id,
         receipt_json, algorithm, key_id, signature, receipt_digest,
         finding_count, payload_digest, created_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM review_requests
       WHERE request_id = ?
         AND status IN (?, ?)
         AND workflow_run_id = ?
         AND authorized_at IS NOT NULL
         AND (check_run_id IS NULL OR check_run_id = ? OR ? IS NULL)`
    )
    .bind(
      receipt.receiptId,
      rid,
      receipt.workflowRunId,
      receipt.event,
      receipt.status,
      receipt.checkId,
      receipt.receiptJson,
      receipt.algorithm,
      receipt.keyId,
      receipt.signature,
      receipt.receiptDigest,
      receipt.findingCount,
      receipt.payloadDigest,
      receipt.createdAt,
      rid,
      REQUEST_STATUS.CLAIMED,
      REQUEST_STATUS.STARTED,
      data.workflowRunId,
      data.checkRunId ?? null,
      data.checkRunId ?? null
    );

  const updateStmt = d1
    .prepare(
      `UPDATE review_requests
       SET status = ?,
           check_run_id = COALESCE(check_run_id, ?),
           updated_at = ?
       WHERE request_id = ?
         AND status IN (?, ?)
         AND workflow_run_id = ?
         AND authorized_at IS NOT NULL
         AND (check_run_id IS NULL OR check_run_id = ? OR ? IS NULL)`
    )
    .bind(
      data.status,
      data.checkRunId ?? null,
      data.updatedAt,
      rid,
      REQUEST_STATUS.CLAIMED,
      REQUEST_STATUS.STARTED,
      data.workflowRunId,
      data.checkRunId ?? null,
      data.checkRunId ?? null
    );

  try {
    const results = await d1.batch([insertStmt, updateStmt]);
    const insertChanges = results?.[0]?.meta?.changes ?? 0;
    const updateChanges = results?.[1]?.meta?.changes ?? 0;
    if (insertChanges > 0 && updateChanges > 0) {
      return "committed";
    }
    // Neither wrote — request was not eligible (superseded/terminal/wrong binding).
    if (insertChanges === 0 && updateChanges === 0) {
      return "not_eligible";
    }
    // Partial write should not happen in a real D1 transaction; treat as conflict.
    return "conflict";
  } catch (error) {
    const message = String(error?.message || error);
    if (/unique|constraint/i.test(message)) {
      return "conflict";
    }
    throw error;
  }
}

/**
 * @param {string|null|undefined} status
 */
export function isRetryableDispatchStatus(status) {
  return RETRYABLE_DISPATCH_STATUSES.includes(/** @type {string} */ (status));
}

/**
 * @param {string|null|undefined} status
 */
export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(/** @type {string} */ (status));
}

/**
 * Insert callback nonce. Returns mismatch if nonce exists with different digest.
 * @param {import("@cloudflare/workers-types").D1Database} d1
 * @param {{ nonce: string, payloadDigest: string, receivedAt: string }} row
 * @returns {Promise<"new"|"replay"|"mismatch">}
 */
export async function admitCallbackNonce(d1, row) {
  const existing = await d1
    .prepare(
      `SELECT nonce, payload_digest, received_at FROM callback_nonces WHERE nonce = ?`
    )
    .bind(row.nonce)
    .first();
  if (existing) {
    if (existing.payload_digest !== row.payloadDigest) return "mismatch";
    return "replay";
  }
  try {
    await d1
      .prepare(
        `INSERT INTO callback_nonces (nonce, payload_digest, received_at)
         VALUES (?, ?, ?)`
      )
      .bind(row.nonce, row.payloadDigest, row.receivedAt)
      .run();
    return "new";
  } catch (error) {
    const message = String(error?.message || error);
    if (/unique|constraint/i.test(message)) {
      const raced = await d1
        .prepare(
          `SELECT nonce, payload_digest FROM callback_nonces WHERE nonce = ?`
        )
        .bind(row.nonce)
        .first();
      if (!raced) return "mismatch";
      if (raced.payload_digest !== row.payloadDigest) return "mismatch";
      return "replay";
    }
    throw error;
  }
}

/**
 * @param {import("@cloudflare/workers-types").D1Database} d1
 * @param {object} row
 */
export async function insertSanitizedReceipt(d1, row) {
  await d1
    .prepare(
      `INSERT INTO sanitized_receipts (
         receipt_id, request_id, workflow_run_id, event, status, check_id,
         receipt_json, algorithm, key_id, signature, receipt_digest,
         finding_count, payload_digest, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.receiptId,
      String(row.requestId),
      row.workflowRunId,
      row.event,
      row.status,
      row.checkId,
      row.receiptJson,
      row.algorithm,
      row.keyId,
      row.signature,
      row.receiptDigest,
      row.findingCount,
      row.payloadDigest,
      row.createdAt
    )
    .run();
}

/**
 * @param {import("@cloudflare/workers-types").D1Database} d1
 * @param {string} receiptId
 */
export async function getReceiptById(d1, receiptId) {
  return d1
    .prepare(
      `SELECT receipt_id, request_id, workflow_run_id, event, status, check_id,
              receipt_json, algorithm, key_id, signature, receipt_digest,
              finding_count, payload_digest, created_at
       FROM sanitized_receipts WHERE receipt_id = ?`
    )
    .bind(receiptId)
    .first();
}

/**
 * @param {import("@cloudflare/workers-types").D1Database} d1
 * @param {string|number} requestId
 */
export async function getReceiptByRequestId(d1, requestId) {
  return d1
    .prepare(
      `SELECT receipt_id, request_id, workflow_run_id, event, status, check_id,
              receipt_json, algorithm, key_id, signature, receipt_digest,
              finding_count, payload_digest, created_at
       FROM sanitized_receipts WHERE request_id = ?`
    )
    .bind(String(requestId))
    .first();
}
