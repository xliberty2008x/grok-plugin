-- Private Grok Review GitHub App — D1 control-plane schema
-- GitHub external identifiers are TEXT (canonical nonzero decimal strings).
-- Control metadata only: installation, delivery, request, workflow, check, receipt digests.

PRAGMA foreign_keys = ON;

-- GitHub App installation state.
CREATE TABLE IF NOT EXISTS installations (
  installation_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT,
  account_type TEXT,
  repository_selection TEXT NOT NULL DEFAULT 'selected'
    CHECK (repository_selection IN ('all', 'selected')),
  suspended INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Repositories selected for an installation (decimal TEXT IDs).
CREATE TABLE IF NOT EXISTS installation_repositories (
  installation_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  PRIMARY KEY (installation_id, repository_id),
  FOREIGN KEY (installation_id) REFERENCES installations(installation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_installation_repositories_repo
  ON installation_repositories (repository_id);

-- Webhook delivery admission: unique delivery IDs + payload digests.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY NOT NULL,
  event_name TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_received
  ON webhook_deliveries (received_at);

-- Callback nonce replay protection (unique nonce + digest).
CREATE TABLE IF NOT EXISTS callback_nonces (
  nonce TEXT PRIMARY KEY NOT NULL,
  payload_digest TEXT NOT NULL,
  received_at TEXT NOT NULL
);

-- Review requests with semantic uniqueness and CAS-friendly state.
CREATE TABLE IF NOT EXISTS review_requests (
  request_id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_key TEXT NOT NULL,
  receipt_id TEXT NOT NULL UNIQUE,
  installation_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  pull_number TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (
    trigger_kind IN ('automatic', 'manual_comment', 'check_rerun')
  ),
  trigger_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'pending_dispatch',
      'dispatched',
      'failed_dispatch',
      'claimed',
      'started',
      'superseded',
      'completed',
      'failed',
      'cancelled'
    )
  ),
  delivery_id TEXT,
  payload_digest TEXT,
  expected_head_sha TEXT,
  policy_version TEXT,
  workflow_run_id TEXT,
  workflow_run_url TEXT,
  workflow_html_url TEXT,
  check_run_id TEXT,
  authorized_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (request_key)
);

CREATE INDEX IF NOT EXISTS idx_review_requests_active_pr
  ON review_requests (installation_id, repository_id, pull_number, status);

CREATE INDEX IF NOT EXISTS idx_review_requests_delivery
  ON review_requests (delivery_id);

CREATE INDEX IF NOT EXISTS idx_review_requests_workflow_run
  ON review_requests (workflow_run_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_requests_workflow_run_unique
  ON review_requests (workflow_run_id)
  WHERE workflow_run_id IS NOT NULL;

-- Durable control-plane side effects. Jobs contain only opaque IDs and safe
-- error codes; repository content, prompts, credentials, and model output are
-- forbidden.
CREATE TABLE IF NOT EXISTS outbox_jobs (
  job_id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_key TEXT NOT NULL UNIQUE,
  job_type TEXT NOT NULL CHECK (job_type IN ('dispatch', 'cancel')),
  request_id TEXT,
  workflow_run_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'completed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (job_type = 'dispatch' AND request_id IS NOT NULL AND workflow_run_id IS NULL)
    OR
    (job_type = 'cancel' AND workflow_run_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_outbox_jobs_ready
  ON outbox_jobs (status, available_at, lease_expires_at, job_id);

CREATE INDEX IF NOT EXISTS idx_outbox_jobs_request
  ON outbox_jobs (request_id);

-- Canonical sanitized execution evidence plus its Ed25519 envelope.
CREATE TABLE IF NOT EXISTS sanitized_receipts (
  receipt_id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  event TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'cancelled')),
  check_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  algorithm TEXT NOT NULL CHECK (algorithm = 'Ed25519'),
  key_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  receipt_digest TEXT NOT NULL,
  finding_count INTEGER NOT NULL,
  payload_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (request_id)
);

CREATE INDEX IF NOT EXISTS idx_sanitized_receipts_request
  ON sanitized_receipts (request_id);
