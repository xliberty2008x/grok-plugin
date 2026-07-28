/**
 * Minimal in-memory D1-compatible driver for deterministic Node tests.
 * Supports SQL shapes issued by the hardened db.mjs.
 */

function normalizeSql(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

function clone(row) {
  return row ? { ...row } : null;
}

function cloneMap(map) {
  return new Map([...map].map(([key, value]) => [key, clone(value)]));
}

function isAuthorized(db, row) {
  const installation = db.installations.get(row.installation_id);
  return Boolean(
    installation
    && Number(installation.suspended) === 0
    && (
      installation.repository_selection === "all"
      || (
        installation.repository_selection === "selected"
        && db.installationRepos.has(`${row.installation_id}:${row.repository_id}`)
      )
    )
  );
}

function insertOutboxRow(db, row) {
  if (db.outboxByKey.has(row.job_key)) {
    return { success: true, meta: { changes: 0 } };
  }
  const jobId = String(db.nextOutboxId++);
  const stored = {
    job_id: jobId,
    job_key: row.job_key,
    job_type: row.job_type,
    request_id: row.request_id == null ? null : String(row.request_id),
    workflow_run_id: row.workflow_run_id == null ? null : String(row.workflow_run_id),
    status: row.status,
    attempt_count: Number(row.attempt_count || 0),
    available_at: row.available_at,
    lease_owner: row.lease_owner ?? null,
    lease_expires_at: row.lease_expires_at ?? null,
    last_error_code: row.last_error_code ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
  db.outboxById.set(jobId, stored);
  db.outboxByKey.set(stored.job_key, stored);
  return { success: true, meta: { changes: 1, last_row_id: Number(jobId) } };
}

function scopedRequests(db, sql, params) {
  let offset = 0;
  let rows = [...db.requestsById.values()];
  if (sql.includes("installation_id = ?")) {
    const installationId = params[offset++];
    rows = rows.filter((row) => row.installation_id === installationId);
  }
  if (sql.includes("repository_id = ?")) {
    const repositoryId = params[offset++];
    rows = rows.filter((row) => row.repository_id === repositoryId);
  }
  if (sql.includes("pull_number = ?")) {
    const pullNumber = params[offset++];
    rows = rows.filter((row) => row.pull_number === pullNumber);
  }
  if (sql.includes("request_key <> ?")) {
    const requestKey = params[offset++];
    rows = rows.filter((row) => row.request_key !== requestKey);
  }
  return { rows, consumed: offset };
}

class MemoryStatement {
  /**
   * @param {MemoryD1} db
   * @param {string} sql
   */
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async first() {
    const rows = await this._rows();
    return rows[0] ?? null;
  }

  async all() {
    return { results: await this._rows(), success: true };
  }

  async run() {
    return this._run();
  }

  async _rows() {
    const sql = normalizeSql(this.sql);
    const p = this.params;

    if (sql.includes("FROM webhook_deliveries WHERE delivery_id = ?")) {
      const row = this.db.deliveries.get(p[0]);
      return row ? [clone(row)] : [];
    }
    if (sql.includes("FROM review_requests WHERE request_key = ?")) {
      const row = this.db.requestsByKey.get(p[0]);
      return row ? [clone(row)] : [];
    }
    if (sql.includes("FROM review_requests WHERE request_id = ?")) {
      const row = this.db.requestsById.get(String(p[0]));
      return row ? [clone(row)] : [];
    }
    if (
      sql.includes("FROM review_requests")
      && sql.includes("updated_at <= ?")
      && sql.includes("NOT EXISTS")
      && sql.includes("sanitized_receipts")
    ) {
      const allowed = new Set(p.slice(0, 3));
      return [...this.db.requestsById.values()]
        .filter((row) => {
          if (
            !allowed.has(row.status)
            || row.workflow_run_id == null
            || row.updated_at > p[3]
          ) {
            return false;
          }
          for (const receipt of this.db.receipts.values()) {
            if (String(receipt.request_id) === String(row.request_id)) return false;
          }
          return true;
        })
        .sort((a, b) => Number(a.request_id) - Number(b.request_id))
        .slice(0, Number(p[4]))
        .map((row) => clone(row));
    }
    if (sql.includes("FROM review_requests") && sql.includes("status IN")) {
      const installationId = p[0];
      const repositoryId = p[1];
      const pullNumber = p[2];
      const statuses = new Set(p.slice(3));
      return [...this.db.requestsById.values()]
        .filter(
          (r) =>
            r.installation_id === installationId
            && r.repository_id === repositoryId
            && r.pull_number === pullNumber
            && statuses.has(r.status)
        )
        .sort((a, b) => Number(a.request_id) - Number(b.request_id))
        .map((r) => clone(r));
    }
    if (sql.includes("FROM sanitized_receipts WHERE receipt_id = ?")) {
      const row = this.db.receipts.get(p[0]);
      return row ? [clone(row)] : [];
    }
    if (sql.includes("FROM sanitized_receipts WHERE request_id = ?")) {
      const rid = String(p[0]);
      for (const row of this.db.receipts.values()) {
        if (String(row.request_id) === rid) return [clone(row)];
      }
      return [];
    }
    if (sql.includes("FROM installations WHERE installation_id = ?")) {
      const row = this.db.installations.get(p[0]);
      return row ? [clone(row)] : [];
    }
    if (sql.includes("FROM installation_repositories") && sql.includes("repository_id = ?")) {
      const key = `${p[0]}:${p[1]}`;
      const row = this.db.installationRepos.get(key);
      return row ? [clone(row)] : [];
    }
    if (sql.includes("FROM callback_nonces WHERE nonce = ?")) {
      const row = this.db.nonces.get(p[0]);
      return row ? [clone(row)] : [];
    }
    if (sql.includes("FROM outbox_jobs WHERE job_key = ?")) {
      const row = this.db.outboxByKey.get(p[0]);
      return row ? [clone(row)] : [];
    }
    if (sql.includes("FROM outbox_jobs WHERE job_id = ?")) {
      const row = this.db.outboxById.get(String(p[0]));
      return row ? [clone(row)] : [];
    }
    if (
      sql.includes("FROM outbox_jobs")
      && sql.includes("ORDER BY job_id ASC")
      && sql.includes("LIMIT ?")
    ) {
      const [pending, pendingAt, leased, leaseAt, limit] = p;
      return [...this.db.outboxById.values()]
        .filter(
          (row) =>
            (row.status === pending && row.available_at <= pendingAt)
            || (
              row.status === leased
              && row.lease_expires_at != null
              && row.lease_expires_at <= leaseAt
            )
        )
        .sort((a, b) => Number(a.job_id) - Number(b.job_id))
        .slice(0, Number(limit))
        .map((row) => clone(row));
    }
    if (sql.includes("FROM outbox_jobs") && sql.includes("ORDER BY job_id ASC")) {
      return [...this.db.outboxById.values()]
        .sort((a, b) => Number(a.job_id) - Number(b.job_id))
        .map((row) => clone(row));
    }
    return [];
  }

  async _run() {
    const sql = normalizeSql(this.sql);
    const p = this.params;

    if (sql.startsWith("INSERT INTO webhook_deliveries")) {
      if (this.db.deliveries.has(p[0])) {
        throw new Error("UNIQUE constraint failed: webhook_deliveries.delivery_id");
      }
      this.db.deliveries.set(p[0], {
        delivery_id: p[0],
        event_name: p[1],
        payload_digest: p[2],
        received_at: p[3],
        status: p[4]
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (sql.startsWith("UPDATE webhook_deliveries SET status = ?")) {
      const row = this.db.deliveries.get(p[1]);
      if (row) row.status = p[0];
      return { success: true, meta: { changes: row ? 1 : 0 } };
    }

    if (
      sql.startsWith("INSERT INTO review_requests")
      || sql.startsWith("INSERT OR IGNORE INTO review_requests")
    ) {
      if (this.db.requestsByKey.has(p[0])) {
        if (sql.startsWith("INSERT OR IGNORE")) {
          return { success: true, meta: { changes: 0 } };
        }
        throw new Error("UNIQUE constraint failed: review_requests.request_key");
      }
      for (const existing of this.db.requestsById.values()) {
        if (existing.receipt_id === p[1]) {
          if (sql.startsWith("INSERT OR IGNORE")) {
            return { success: true, meta: { changes: 0 } };
          }
          throw new Error("UNIQUE constraint failed: review_requests.receipt_id");
        }
      }
      const requestId = String(this.db.nextRequestId++);
      const row = {
        request_id: requestId,
        request_key: p[0],
        receipt_id: p[1],
        installation_id: p[2],
        repository_id: p[3],
        pull_number: p[4],
        trigger_kind: p[5],
        trigger_id: p[6],
        actor_id: p[7],
        status: p[8],
        delivery_id: p[9],
        payload_digest: p[10],
        expected_head_sha: p[11],
        policy_version: p[12],
        workflow_run_id: null,
        workflow_run_url: null,
        workflow_html_url: null,
        check_run_id: null,
        authorized_at: null,
        created_at: p[13],
        updated_at: p[14]
      };
      this.db.requestsById.set(requestId, row);
      this.db.requestsByKey.set(p[0], row);
      return { success: true, meta: { changes: 1, last_row_id: Number(requestId) } };
    }

    if (
      sql.startsWith("INSERT OR IGNORE INTO outbox_jobs")
      && sql.includes(") VALUES (")
    ) {
      return insertOutboxRow(this.db, {
        job_key: p[0],
        job_type: p[1],
        request_id: p[2],
        workflow_run_id: p[3],
        status: p[4],
        attempt_count: 0,
        available_at: p[5],
        created_at: p[6],
        updated_at: p[7]
      });
    }

    // First workflow-run claim lost: atomically queue its orphan cancellation.
    if (
      sql.startsWith("INSERT OR IGNORE INTO outbox_jobs")
      && sql.includes("SELECT 'cancel:' || ?")
      && sql.includes("WHERE NOT EXISTS")
    ) {
      const bound = this.db.requestsById.get(String(p[8]));
      if (bound && bound.workflow_run_id === p[9]) {
        return { success: true, meta: { changes: 0 } };
      }
      return insertOutboxRow(this.db, {
        job_key: `cancel:${p[0]}`,
        job_type: p[1],
        request_id: p[2],
        workflow_run_id: p[3],
        status: p[4],
        attempt_count: 0,
        available_at: p[5],
        created_at: p[6],
        updated_at: p[7]
      });
    }

    // A live-authorized request supersedes other PR work.
    if (
      sql.startsWith("INSERT OR IGNORE INTO outbox_jobs")
      && sql.includes("SELECT 'cancel:' || target.workflow_run_id")
    ) {
      const current = this.db.requestsById.get(String(p[5]));
      if (
        !current
        || current.workflow_run_id !== p[6]
        || current.status !== p[7]
        || current.authorized_at !== p[8]
      ) {
        return { success: true, meta: { changes: 0 } };
      }
      const allowed = new Set(p.slice(9));
      let changes = 0;
      for (const row of this.db.requestsById.values()) {
        if (
          BigInt(row.request_id) < BigInt(current.request_id)
          && row.installation_id === current.installation_id
          && row.repository_id === current.repository_id
          && row.pull_number === current.pull_number
          && allowed.has(row.status)
          && row.workflow_run_id != null
        ) {
          changes += insertOutboxRow(this.db, {
            job_key: `cancel:${row.workflow_run_id}`,
            job_type: p[0],
            request_id: row.request_id,
            workflow_run_id: row.workflow_run_id,
            status: p[1],
            attempt_count: 0,
            available_at: p[2],
            created_at: p[3],
            updated_at: p[4]
          }).meta.changes;
        }
      }
      return { success: true, meta: { changes } };
    }

    // Admission-time dispatch job for one request key.
    if (
      sql.startsWith("INSERT OR IGNORE INTO outbox_jobs")
      && sql.includes("SELECT 'dispatch:' || request_key")
    ) {
      const row = this.db.requestsByKey.get(p[5]);
      const allowed = new Set(p.slice(6));
      if (!row || !allowed.has(row.status) || row.workflow_run_id != null) {
        return { success: true, meta: { changes: 0 } };
      }
      return insertOutboxRow(this.db, {
        job_key: `dispatch:${row.request_key}`,
        job_type: p[0],
        request_id: row.request_id,
        workflow_run_id: null,
        status: p[1],
        attempt_count: 0,
        available_at: p[2],
        created_at: p[3],
        updated_at: p[4]
      });
    }

    // Scheduled repair of missing dispatch jobs for still-authorized requests.
    if (
      sql.startsWith("INSERT OR IGNORE INTO outbox_jobs")
      && sql.includes("SELECT 'dispatch:' || r.request_key")
    ) {
      const allowed = new Set(p.slice(5));
      let changes = 0;
      for (const row of this.db.requestsById.values()) {
        if (
          allowed.has(row.status)
          && row.workflow_run_id == null
          && isAuthorized(this.db, row)
        ) {
          changes += insertOutboxRow(this.db, {
            job_key: `dispatch:${row.request_key}`,
            job_type: p[0],
            request_id: row.request_id,
            workflow_run_id: null,
            status: p[1],
            attempt_count: 0,
            available_at: p[2],
            created_at: p[3],
            updated_at: p[4]
          }).meta.changes;
        }
      }
      return { success: true, meta: { changes } };
    }

    // Scheduled repair: queue cancellation before superseding unauthorized work.
    if (
      sql.startsWith("INSERT OR IGNORE INTO outbox_jobs")
      && sql.includes("SELECT 'cancel:' || r.workflow_run_id")
    ) {
      const allowed = new Set(p.slice(5));
      let changes = 0;
      for (const row of this.db.requestsById.values()) {
        if (
          allowed.has(row.status)
          && row.workflow_run_id != null
          && !isAuthorized(this.db, row)
        ) {
          changes += insertOutboxRow(this.db, {
            job_key: `cancel:${row.workflow_run_id}`,
            job_type: p[0],
            request_id: row.request_id,
            workflow_run_id: row.workflow_run_id,
            status: p[1],
            attempt_count: 0,
            available_at: p[2],
            created_at: p[3],
            updated_at: p[4]
          }).meta.changes;
        }
      }
      return { success: true, meta: { changes } };
    }

    // Scheduled repair of a missing cancellation for an already-superseded row.
    if (
      sql.startsWith("INSERT OR IGNORE INTO outbox_jobs")
      && sql.includes("SELECT 'cancel:' || workflow_run_id")
      && sql.includes("WHERE status = ?")
      && !sql.includes("status IN")
    ) {
      let changes = 0;
      for (const row of this.db.requestsById.values()) {
        if (row.status === p[5] && row.workflow_run_id != null) {
          changes += insertOutboxRow(this.db, {
            job_key: `cancel:${row.workflow_run_id}`,
            job_type: p[0],
            request_id: row.request_id,
            workflow_run_id: row.workflow_run_id,
            status: p[1],
            attempt_count: 0,
            available_at: p[2],
            created_at: p[3],
            updated_at: p[4]
          }).meta.changes;
        }
      }
      return { success: true, meta: { changes } };
    }

    // Transactional supersession cancellation jobs for a fixed request scope.
    if (
      sql.startsWith("INSERT OR IGNORE INTO outbox_jobs")
      && sql.includes("SELECT 'cancel:' || workflow_run_id")
      && sql.includes("status IN")
    ) {
      const scope = scopedRequests(this.db, sql, p.slice(5));
      const allowed = new Set(p.slice(5 + scope.consumed));
      let changes = 0;
      for (const row of scope.rows) {
        if (allowed.has(row.status) && row.workflow_run_id != null) {
          changes += insertOutboxRow(this.db, {
            job_key: `cancel:${row.workflow_run_id}`,
            job_type: p[0],
            request_id: row.request_id,
            workflow_run_id: row.workflow_run_id,
            status: p[1],
            attempt_count: 0,
            available_at: p[2],
            created_at: p[3],
            updated_at: p[4]
          }).meta.changes;
        }
      }
      return { success: true, meta: { changes } };
    }

    // CAS claim workflow run
    if (
      sql.startsWith("UPDATE review_requests")
      && sql.includes("workflow_run_id = ?")
      && sql.includes("workflow_run_id IS NULL")
    ) {
      const requestId = String(p[5]);
      const allowed = new Set(p.slice(6));
      const row = this.db.requestsById.get(requestId);
      let changes = 0;
      if (row && allowed.has(row.status) && row.workflow_run_id == null) {
        row.status = p[0];
        row.workflow_run_id = p[1];
        row.workflow_run_url = p[2];
        row.workflow_html_url = p[3];
        row.updated_at = p[4];
        changes = 1;
      }
      return { success: true, meta: { changes } };
    }

    // One-shot live authorization after authoritative PR validation.
    if (
      sql.startsWith("UPDATE review_requests")
      && sql.includes("SET authorized_at = ?")
    ) {
      const row = this.db.requestsById.get(String(p[2]));
      let changes = 0;
      if (
        row
        && row.workflow_run_id === p[3]
        && row.status === p[4]
        && row.authorized_at == null
        && [p[5], p[6], p[7]].includes(row.trigger_kind)
      ) {
        row.authorized_at = p[0];
        row.updated_at = p[1];
        changes = 1;
      }
      return { success: true, meta: { changes } };
    }

    // Supersede peers after the current request was authorized.
    if (
      sql.startsWith("UPDATE review_requests")
      && sql.includes("WHERE request_id < ?")
      && sql.includes("current.authorized_at = ?")
    ) {
      const statusCount = 5;
      const currentId = String(p[3 + statusCount]);
      const current = this.db.requestsById.get(currentId);
      const allowed = new Set(p.slice(3, 3 + statusCount));
      let changes = 0;
      if (
        current
        && current.workflow_run_id === p[4 + statusCount]
        && current.status === p[5 + statusCount]
        && current.authorized_at === p[6 + statusCount]
      ) {
        for (const row of this.db.requestsById.values()) {
          if (
            BigInt(row.request_id) < BigInt(String(p[2]))
            && row.installation_id === current.installation_id
            && row.repository_id === current.repository_id
            && row.pull_number === current.pull_number
            && allowed.has(row.status)
          ) {
            row.status = p[0];
            row.updated_at = p[1];
            changes += 1;
          }
        }
      }
      return { success: true, meta: { changes } };
    }

    // Repair-time supersession for requests that lost installation/repo auth.
    if (
      sql.startsWith("UPDATE review_requests")
      && sql.includes("NOT EXISTS")
      && sql.includes("FROM installations i")
    ) {
      const allowed = new Set(p.slice(2));
      let changes = 0;
      for (const row of this.db.requestsById.values()) {
        if (allowed.has(row.status) && !isAuthorized(this.db, row)) {
          row.status = p[0];
          row.updated_at = p[1];
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }

    // Transactional supersession for a fixed installation/repository/PR scope.
    if (
      sql.startsWith("UPDATE review_requests")
      && sql.includes("SET status = ?, updated_at = ?")
      && sql.includes("status IN")
      && sql.includes("installation_id = ?")
      && !sql.includes("request_id = ?")
    ) {
      const scope = scopedRequests(this.db, sql, p.slice(2));
      const allowed = new Set(p.slice(2 + scope.consumed));
      let changes = 0;
      for (const row of scope.rows) {
        if (allowed.has(row.status)) {
          row.status = p[0];
          row.updated_at = p[1];
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }

    // Receipt-free abort state fence.
    if (
      sql.startsWith("UPDATE review_requests")
      && sql.includes("check_run_id IS NULL AND ? IS NULL")
      && sql.includes("check_run_id = ? AND ? IS NOT NULL")
    ) {
      const row = this.db.requestsById.get(String(p[2]));
      let changes = 0;
      const claimedEligible =
        row?.status === p[4]
        && row?.check_run_id == null
        && p[5] == null;
      const startedEligible =
        row?.status === p[6]
        && row?.check_run_id === p[7]
        && p[8] != null;
      if (
        row
        && row.workflow_run_id === p[3]
        && (claimedEligible || startedEligible)
      ) {
        row.status = p[0];
        row.updated_at = p[1];
        changes = 1;
      }
      return { success: true, meta: { changes } };
    }

    // CAS mark started (claimed → started); not terminal (no status IN).
    if (
      sql.startsWith("UPDATE review_requests")
      && sql.includes("COALESCE(check_run_id, ?)")
      && sql.includes("AND status = ?")
      && !sql.includes("status IN")
    ) {
      const row = this.db.requestsById.get(String(p[3]));
      let changes = 0;
      if (
        row
        && row.status === p[4]
        && row.workflow_run_id === p[5]
        && row.authorized_at != null
        && (row.check_run_id == null || row.check_run_id === p[6])
      ) {
        row.status = p[0];
        if (row.check_run_id == null) row.check_run_id = p[1];
        row.updated_at = p[2];
        changes = 1;
      }
      return { success: true, meta: { changes } };
    }

    // CAS terminal (claimed|started → completed|failed|cancelled)
    if (
      sql.startsWith("UPDATE review_requests")
      && sql.includes("COALESCE(check_run_id, ?)")
      && sql.includes("status IN (?, ?)")
      && sql.includes("workflow_run_id = ?")
    ) {
      const row = this.db.requestsById.get(String(p[3]));
      let changes = 0;
      const checkParam = p[1];
      if (
        row
        && (row.status === p[4] || row.status === p[5])
        && row.workflow_run_id === p[6]
        && row.authorized_at != null
        && (row.check_run_id == null || checkParam == null || row.check_run_id === p[7])
      ) {
        row.status = p[0];
        if (row.check_run_id == null && checkParam != null) row.check_run_id = checkParam;
        row.updated_at = p[2];
        changes = 1;
      }
      return { success: true, meta: { changes } };
    }

    // CAS claim executor (dispatched → claimed)
    if (
      sql.startsWith("UPDATE review_requests")
      && sql.includes("SET status = ?, updated_at = ?")
      && sql.includes("AND status = ?")
      && sql.includes("AND workflow_run_id = ?")
      && !sql.includes("check_run_id")
    ) {
      const row = this.db.requestsById.get(String(p[2]));
      let changes = 0;
      if (row && row.status === p[3] && row.workflow_run_id === p[4]) {
        row.status = p[0];
        row.updated_at = p[1];
        changes = 1;
      }
      return { success: true, meta: { changes } };
    }

    // CAS supersede / failed_dispatch with status IN
    if (
      sql.startsWith("UPDATE review_requests")
      && sql.includes("NOT EXISTS")
      && sql.includes("sanitized_receipts")
      && sql.includes("workflow_run_id = ?")
    ) {
      const row = this.db.requestsById.get(String(p[2]));
      const allowed = new Set(p.slice(4));
      let hasReceipt = false;
      for (const receipt of this.db.receipts.values()) {
        if (String(receipt.request_id) === String(p[2])) hasReceipt = true;
      }
      let changes = 0;
      if (
        row
        && row.workflow_run_id === p[3]
        && allowed.has(row.status)
        && !hasReceipt
      ) {
        row.status = p[0];
        row.updated_at = p[1];
        changes = 1;
      }
      return { success: true, meta: { changes } };
    }

    // CAS supersede / failed_dispatch with status IN
    if (
      sql.startsWith("UPDATE review_requests")
      && sql.includes("SET status = ?, updated_at = ?")
      && sql.includes("status IN")
    ) {
      const row = this.db.requestsById.get(String(p[2]));
      const allowed = new Set(p.slice(3));
      let changes = 0;
      if (row && allowed.has(row.status)) {
        row.status = p[0];
        row.updated_at = p[1];
        changes = 1;
      }
      return { success: true, meta: { changes } };
    }

    // CAS lease acquisition, including expired-lease recovery.
    if (
      sql.startsWith("UPDATE outbox_jobs")
      && sql.includes("SET status = ?, lease_owner = ?")
      && sql.includes("lease_expires_at <= ?")
    ) {
      const row = this.db.outboxById.get(String(p[4]));
      let changes = 0;
      if (
        row
        && (
          (row.status === p[5] && row.available_at <= p[6])
          || (
            row.status === p[7]
            && row.lease_expires_at != null
            && row.lease_expires_at <= p[8]
          )
        )
      ) {
        row.status = p[0];
        row.lease_owner = p[1];
        row.lease_expires_at = p[2];
        row.updated_at = p[3];
        changes = 1;
      }
      return { success: true, meta: { changes } };
    }

    if (
      sql.startsWith("UPDATE outbox_jobs")
      && sql.includes("lease_owner = NULL")
      && sql.includes("last_error_code = NULL")
    ) {
      const row = this.db.outboxById.get(String(p[2]));
      let changes = 0;
      if (row && row.status === p[3] && row.lease_owner === p[4]) {
        row.status = p[0];
        row.lease_owner = null;
        row.lease_expires_at = null;
        row.last_error_code = null;
        row.updated_at = p[1];
        changes = 1;
      }
      return { success: true, meta: { changes } };
    }

    if (
      sql.startsWith("UPDATE outbox_jobs")
      && sql.includes("attempt_count = attempt_count + 1")
    ) {
      const row = this.db.outboxById.get(String(p[4]));
      let changes = 0;
      if (row && row.status === p[5] && row.lease_owner === p[6]) {
        row.status = p[0];
        row.attempt_count += 1;
        row.available_at = p[1];
        row.lease_owner = null;
        row.lease_expires_at = null;
        row.last_error_code = p[2];
        row.updated_at = p[3];
        changes = 1;
      }
      return { success: true, meta: { changes } };
    }

    if (sql.startsWith("INSERT INTO installations") && sql.includes("DO NOTHING")) {
      if (!this.db.installations.has(p[0])) {
        this.db.installations.set(p[0], {
          installation_id: p[0],
          account_id: p[1],
          account_type: p[2],
          repository_selection: p[3],
          suspended: p[4],
          created_at: p[5],
          updated_at: p[6]
        });
      }
      return { success: true, meta: { changes: 1 } };
    }

    if (sql.startsWith("INSERT INTO installations")) {
      const existing = this.db.installations.get(p[0]);
      this.db.installations.set(p[0], {
        installation_id: p[0],
        account_id: p[1],
        account_type: p[2],
        repository_selection: p[3],
        suspended: p[4],
        created_at: existing?.created_at ?? p[5],
        updated_at: p[6]
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (sql.startsWith("UPDATE installations SET suspended = ?")) {
      const row = this.db.installations.get(p[2]);
      let changes = 0;
      if (row) {
        row.suspended = p[0];
        row.updated_at = p[1];
        changes = 1;
      }
      return { success: true, meta: { changes } };
    }

    if (sql.startsWith("UPDATE installations SET repository_selection = ?")) {
      const row = this.db.installations.get(p[2]);
      let changes = 0;
      if (row) {
        row.repository_selection = p[0];
        row.updated_at = p[1];
        changes = 1;
      }
      return { success: true, meta: { changes } };
    }

    if (sql.startsWith("DELETE FROM installations WHERE installation_id = ?")) {
      const ok = this.db.installations.delete(p[0]);
      return { success: true, meta: { changes: ok ? 1 : 0 } };
    }

    if (
      sql.startsWith("DELETE FROM installation_repositories WHERE installation_id = ? AND repository_id = ?")
    ) {
      const ok = this.db.installationRepos.delete(`${p[0]}:${p[1]}`);
      return { success: true, meta: { changes: ok ? 1 : 0 } };
    }

    if (sql.startsWith("DELETE FROM installation_repositories WHERE installation_id = ?")) {
      let changes = 0;
      for (const key of [...this.db.installationRepos.keys()]) {
        if (key.startsWith(`${p[0]}:`)) {
          this.db.installationRepos.delete(key);
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }

    if (
      sql.startsWith("INSERT OR IGNORE INTO installation_repositories")
      || sql.startsWith("INSERT INTO installation_repositories")
    ) {
      const key = `${p[0]}:${p[1]}`;
      if (!this.db.installationRepos.has(key)) {
        this.db.installationRepos.set(key, {
          installation_id: p[0],
          repository_id: p[1]
        });
      }
      return { success: true, meta: { changes: 1 } };
    }

    if (sql.startsWith("INSERT INTO callback_nonces")) {
      if (this.db.nonces.has(p[0])) {
        throw new Error("UNIQUE constraint failed: callback_nonces.nonce");
      }
      this.db.nonces.set(p[0], {
        nonce: p[0],
        payload_digest: p[1],
        received_at: p[2]
      });
      return { success: true, meta: { changes: 1 } };
    }

    // Atomic terminal receipt: INSERT ... SELECT from review_requests (CAS gate).
    if (
      sql.startsWith("INSERT INTO sanitized_receipts")
      && sql.includes("SELECT")
      && sql.includes("FROM review_requests")
    ) {
      // Params: receipt fields (0-13), then WHERE: requestId, claimed,
      // started, workflow, check, check.
      const requestId = String(p[14]);
      const statusA = p[15];
      const statusB = p[16];
      const workflowRunId = p[17];
      const checkMatch = p[18];
      const checkNullOk = p[19];
      const row = this.db.requestsById.get(requestId);
      const eligible = Boolean(
        row
        && (row.status === statusA || row.status === statusB)
        && row.workflow_run_id === workflowRunId
        && row.authorized_at != null
        && (row.check_run_id == null || checkNullOk == null || row.check_run_id === checkMatch)
      );
      if (!eligible) {
        return { success: true, meta: { changes: 0 } };
      }
      if (this.db.receipts.has(p[0])) {
        throw new Error("UNIQUE constraint failed: sanitized_receipts.receipt_id");
      }
      for (const existing of this.db.receipts.values()) {
        if (String(existing.request_id) === requestId) {
          throw new Error("UNIQUE constraint failed: sanitized_receipts.request_id");
        }
      }
      this.db.receipts.set(p[0], {
        receipt_id: p[0],
        request_id: String(p[1]),
        workflow_run_id: p[2],
        event: p[3],
        status: p[4],
        check_id: p[5],
        receipt_json: p[6],
        algorithm: p[7],
        key_id: p[8],
        signature: p[9],
        receipt_digest: p[10],
        finding_count: p[11],
        payload_digest: p[12],
        created_at: p[13]
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (sql.startsWith("INSERT INTO sanitized_receipts")) {
      if (this.db.receipts.has(p[0])) {
        throw new Error("UNIQUE constraint failed: sanitized_receipts.receipt_id");
      }
      const requestId = String(p[1]);
      for (const existing of this.db.receipts.values()) {
        if (String(existing.request_id) === requestId) {
          throw new Error("UNIQUE constraint failed: sanitized_receipts.request_id");
        }
      }
      this.db.receipts.set(p[0], {
        receipt_id: p[0],
        request_id: requestId,
        workflow_run_id: p[2],
        event: p[3],
        status: p[4],
        check_id: p[5],
        receipt_json: p[6],
        algorithm: p[7],
        key_id: p[8],
        signature: p[9],
        receipt_digest: p[10],
        finding_count: p[11],
        payload_digest: p[12],
        created_at: p[13]
      });
      return { success: true, meta: { changes: 1 } };
    }

    throw new Error(`memory-db: unsupported SQL: ${sql}`);
  }
}

export class MemoryD1 {
  constructor() {
    this.deliveries = new Map();
    this.requestsById = new Map();
    this.requestsByKey = new Map();
    this.installations = new Map();
    this.installationRepos = new Map();
    this.receipts = new Map();
    this.nonces = new Map();
    this.outboxById = new Map();
    this.outboxByKey = new Map();
    this.nextRequestId = 1;
    this.nextOutboxId = 1;
    this.failBatchIndex = null;
  }

  prepare(sql) {
    return new MemoryStatement(this, sql);
  }

  async batch(statements) {
    const snapshot = {
      deliveries: cloneMap(this.deliveries),
      requestsById: cloneMap(this.requestsById),
      requestsByKey: null,
      installations: cloneMap(this.installations),
      installationRepos: cloneMap(this.installationRepos),
      receipts: cloneMap(this.receipts),
      nonces: cloneMap(this.nonces),
      outboxById: cloneMap(this.outboxById),
      outboxByKey: null,
      nextRequestId: this.nextRequestId,
      nextOutboxId: this.nextOutboxId
    };
    snapshot.requestsByKey = new Map(
      [...this.requestsByKey.keys()].map((key) => [
        key,
        snapshot.requestsById.get(String(this.requestsByKey.get(key).request_id))
      ])
    );
    snapshot.outboxByKey = new Map(
      [...this.outboxByKey.keys()].map((key) => [
        key,
        snapshot.outboxById.get(String(this.outboxByKey.get(key).job_id))
      ])
    );

    const failAt = this.failBatchIndex;
    this.failBatchIndex = null;
    const out = [];
    try {
      for (let index = 0; index < statements.length; index += 1) {
        if (failAt === index) throw new Error("memory-db: injected batch failure");
        out.push(await statements[index].run());
      }
      return out;
    } catch (error) {
      this.deliveries = snapshot.deliveries;
      this.requestsById = snapshot.requestsById;
      this.requestsByKey = snapshot.requestsByKey;
      this.installations = snapshot.installations;
      this.installationRepos = snapshot.installationRepos;
      this.receipts = snapshot.receipts;
      this.nonces = snapshot.nonces;
      this.outboxById = snapshot.outboxById;
      this.outboxByKey = snapshot.outboxByKey;
      this.nextRequestId = snapshot.nextRequestId;
      this.nextOutboxId = snapshot.nextOutboxId;
      throw error;
    }
  }

  failNextBatchAt(index) {
    this.failBatchIndex = index;
  }
}

export function createMemoryDb() {
  return new MemoryD1();
}
