/**
 * Hardened control-plane tests for the private Grok Review GitHub App Worker.
 * Covers TEXT IDs (incl. >2^53), exact webhook route, installation gates,
 * head/policy dedupe, CAS transitions, callback HMAC/nonce, forged pairings.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import worker, {
  OUTBOX_LEASE_MS,
  OUTBOX_BACKOFF_MAX_MS,
  CALLBACK_PATH,
  CHECK_RERUN_IDENTIFIER,
  GITHUB_API_BASE,
  GITHUB_API_VERSION,
  MANUAL_REVIEW_COMMAND,
  MAX_CALLBACK_BYTES,
  MAX_WEBHOOK_BYTES,
  POLICY_VERSION,
  REQUEST_STATUS,
  TRIGGER_KIND,
  WEBHOOK_PATH,
  addInstallationRepository,
  buildAutomaticRequestKey,
  buildDispatchInputs,
  buildManualCommentRequestKey,
  canonicalDecimalId,
  createMemoryDb,
  encodeExternalId,
  getDelivery,
  getOutboxJobByKey,
  listOutboxJobs,
  getReceiptById,
  getReceiptByRequestId,
  getRequestById,
  handleRequest,
  handleScheduled,
  hmacSha256,
  isCanonicalDecimalId,
  isInstallationRepoAuthorized,
  isValidSharedSecret,
  parseCallbackPayload,
  parseExternalId,
  parseJsonPreservingIntegerIds,
  processOutbox,
  processWorkflowWatchdog,
  computeOutboxBackoffMs,
  leaseOutboxJobs,
  supersedePrRequestsWithOutbox,
  receiptKeyId,
  signCallbackMessage,
  upsertInstallation,
  verifyGitHubSignature256
} from "../apps/grok-review-app/src/index.mjs";
import { bytesToHex as toHex } from "../apps/grok-review-app/src/crypto-util.mjs";
import { signReceipt } from "../apps/grok-review-app/src/actions/receipt.mjs";
import { RECEIPT_SCHEMA_VERSION } from "../apps/grok-review-app/src/receipt-contract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_ROOT = path.join(ROOT, "apps", "grok-review-app");
const MIGRATION_PATH = path.join(APP_ROOT, "migrations", "0001_init.sql");
const WRANGLER_PATH = path.join(APP_ROOT, "wrangler.toml");
const README_PATH = path.join(APP_ROOT, "README.md");

const WEBHOOK_SECRET = "test-webhook-secret-value-at-least-32-bytes";
const CALLBACK_SECRET = "test-callback-secret-value-at-least-32-bytes";

/** ID strictly above Number.MAX_SAFE_INTEGER (2^53). */
const HUGE_ID = "9007199254740993";
const HUGE_REPO = "9007199254740994";
const HUGE_INSTALL = "9007199254740995";

const HEAD_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const RECEIPT_KEY_PAIR = generateKeyPairSync("ed25519");
const RECEIPT_PRIVATE_KEY_PEM = RECEIPT_KEY_PAIR.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const RECEIPT_PUBLIC_KEY_PEM = RECEIPT_KEY_PAIR.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const RECEIPT_KEY_ID = await receiptKeyId(RECEIPT_PUBLIC_KEY_PEM);

/**
 * @param {object} [overrides]
 */
function makeEnv(overrides = {}) {
  return {
    DB: createMemoryDb(),
    WEBHOOK_SECRET,
    RUNNER_CALLBACK_SECRET: CALLBACK_SECRET,
    RECEIPT_PUBLIC_KEYS_JSON: JSON.stringify({
      [RECEIPT_KEY_ID]: RECEIPT_PUBLIC_KEY_PEM
    }),
    CONTROL_REPO_OWNER: "control-org",
    CONTROL_REPO_NAME: "control-repo",
    CONTROL_WORKFLOW_FILE: "grok-review.yml",
    CONTROL_REF: "main",
    CONTROL_REPO_TOKEN: "ghs_test_control_token",
    GITHUB_APP_ID: "12345",
    ...overrides
  };
}

/**
 * @param {object} env
 * @param {string} installationId
 * @param {string} repositoryId
 */
async function seedActiveInstall(env, installationId = "100", repositoryId = "500") {
  const now = new Date().toISOString();
  await upsertInstallation(env.DB, {
    installationId,
    accountId: "9",
    accountType: "Organization",
    suspended: 0,
    createdAt: now,
    updatedAt: now
  });
  await addInstallationRepository(env.DB, installationId, repositoryId);
}

/**
 * @param {Uint8Array|string} body
 * @param {string} [secret]
 */
async function signBody(body, secret = WEBHOOK_SECRET) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const mac = await hmacSha256(bytes, secret);
  return `sha256=${toHex(mac)}`;
}

/**
 * @param {object} opts
 */
async function webhookRequest(opts) {
  const body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  const headers = new Headers(opts.headers || {});
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (!headers.has("x-github-event") && opts.event) {
    headers.set("x-github-event", opts.event);
  }
  if (!headers.has("x-github-delivery") && opts.deliveryId) {
    headers.set("x-github-delivery", opts.deliveryId);
  }
  if (!headers.has("x-hub-signature-256")) {
    if (opts.signature === null) {
      // omit
    } else if (typeof opts.signature === "string") {
      headers.set("x-hub-signature-256", opts.signature);
    } else {
      headers.set("x-hub-signature-256", await signBody(body, opts.secret));
    }
  }
  return new Request(opts.url || `https://worker.example${WEBHOOK_PATH}`, {
    method: opts.method || "POST",
    headers,
    body
  });
}

/**
 * @param {object} env
 * @param {Request} request
 * @param {object} [options]
 */
async function invoke(env, request, options = {}) {
  const pending = [];
  const ctx = options.ctx || {
    waitUntil(promise) {
      pending.push(Promise.resolve(promise));
    }
  };
  const response = await handleRequest(request, env, ctx, options);
  if (options.awaitWaitUntil !== false) {
    await Promise.all(pending);
  }
  return response;
}

function mockDispatchFetch(options = {}) {
  const calls = [];
  const runIdStart = options.runIdStart ?? 9000;
  let seq = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method || "GET",
      headers: init.headers || {},
      body: init.body || null,
      redirect: init.redirect
    });
    if (options.failNetwork) throw new Error("network down");
    if (String(url).includes("/dispatches")) {
      if (options.dispatchStatus && options.dispatchStatus !== 200) {
        return new Response("error", { status: options.dispatchStatus });
      }
      seq += 1;
      const workflowRunId = String(runIdStart + seq);
      return new Response(
        JSON.stringify({
          workflow_run_id: workflowRunId,
          run_url: `${GITHUB_API_BASE}/repos/control-org/control-repo/actions/runs/${workflowRunId}`,
          html_url: `https://github.com/control-org/control-repo/actions/runs/${workflowRunId}`
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (String(url).includes("/cancel")) {
      return new Response(null, { status: options.cancelStatus ?? 202 });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

function basePrPayload(overrides = {}) {
  return {
    action: "opened",
    number: "7",
    pull_request: {
      id: "7001",
      number: "7",
      draft: false,
      head: { sha: HEAD_A },
      user: { id: "42", login: "dev", type: "User" }
    },
    repository: { id: "500" },
    installation: { id: "100" },
    sender: { id: "42", login: "dev", type: "User" },
    ...overrides
  };
}

function baseCommentPayload(overrides = {}) {
  return {
    action: "created",
    comment: {
      id: "8001",
      body: MANUAL_REVIEW_COMMAND,
      user: { id: "42", login: "dev", type: "User" }
    },
    issue: {
      number: "7",
      pull_request: { url: "https://api.github.com/repos/o/r/pulls/7" }
    },
    repository: { id: "500" },
    installation: { id: "100" },
    sender: { id: "42", login: "dev", type: "User" },
    ...overrides
  };
}

/**
 * @param {object} env
 * @param {object} body
 * @param {object} [opts]
 */
async function signedCallback(env, body, opts = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const rawBytes = new TextEncoder().encode(raw);
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? `nonce-${Math.random().toString(16).slice(2)}`;
  const secret = opts.secret ?? CALLBACK_SECRET;
  const sig = opts.signature
    ?? await signCallbackMessage(rawBytes, ts, nonce, secret);
  return new Request(`https://worker.example${CALLBACK_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-grok-signature": sig,
      "x-grok-timestamp": ts,
      "x-grok-nonce": nonce,
      ...(opts.extraHeaders || {})
    },
    body: raw
  });
}

async function authorizeClaimedRequest(env, row, nonce) {
  const response = await invoke(
    env,
    await signedCallback(env, {
      event: "authorized",
      request_id: String(row.request_id),
      workflow_run_id: String(row.workflow_run_id)
    }, { nonce })
  );
  assert.equal(response.status, 200);
  assert.match((await response.json()).result, /^(authorized|already_authorized)$/);
}

function sanitizedReceiptForRequest(row, options = {}) {
  const findingCount = options.findingCount ?? 0;
  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    receipt_id: options.receiptId ?? row.receipt_id,
    request: {
      request_id: String(row.request_id),
      workflow_run_id: String(row.workflow_run_id),
      check_id: String(options.checkId ?? row.check_run_id),
      installation_id: String(row.installation_id),
      repository_id: String(row.repository_id),
      pull_number: String(row.pull_number)
    },
    trigger: {
      kind: row.trigger_kind,
      id: String(row.trigger_id),
      actor_id: String(row.actor_id)
    },
    source: {
      base_sha: "c".repeat(40),
      head_sha: options.headSha ?? row.expected_head_sha ?? HEAD_A,
      merge_base_sha: "d".repeat(40),
      diff: {
        sha256: "e".repeat(64),
        bytes: options.diffBytes ?? 100,
        files: 1
      }
    },
    instructions: options.instructions ?? [{
      path: "AGENTS.md",
      blob_sha: "f".repeat(40),
      sha256: "1".repeat(64),
      bytes: 24
    }],
    prompt: {
      version: "review-v1",
      sha256: "2".repeat(64)
    },
    output_schema: {
      version: "output-v1",
      sha256: "3".repeat(64)
    },
    runtime: {
      plugin_commit: "4".repeat(40),
      bundle_sha256: "5".repeat(64),
      node_version: "v22.17.0",
      grok_cli_version: "0.2.112",
      grok_cli_sha256: "6".repeat(64),
      grok_package_integrity_sha256: "7".repeat(64),
      grok_package_git_commit: "8".repeat(40)
    },
    model: {
      provider: "xai",
      name: "grok-code-fast",
      version: "2026-07",
      effort: "high"
    },
    execution: {
      provider_launched: options.providerLaunched ?? true,
      structured_output_valid: options.structuredOutputValid ?? true,
      duration_ms: 60_000,
      finding_count: findingCount
    },
    posting: {
      event: "COMMENT"
    },
    created_at: "2026-07-28T10:00:00.000Z"
  };
}

async function terminalCallbackBody(row, options = {}) {
  const receipt = sanitizedReceiptForRequest(row, options);
  const signed = await signReceipt({
    receipt,
    privateKeyPem: RECEIPT_PRIVATE_KEY_PEM,
    publicKeyPem: RECEIPT_PUBLIC_KEY_PEM
  });
  return {
    event: "terminal",
    request_id: String(row.request_id),
    workflow_run_id: String(row.workflow_run_id),
    status: options.status ?? "completed",
    check_id: String(options.checkId ?? row.check_run_id),
    receipt: signed.receipt,
    envelope: signed.envelope
  };
}

async function createStartedReview(env, options = {}) {
  await seedActiveInstall(env);
  const { fetchImpl } = mockDispatchFetch({ runIdStart: options.runIdStart ?? 5000 });
  const created = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload(),
      event: "pull_request",
      deliveryId: options.deliveryId ?? `d-started-${Math.random()}`
    }),
    { fetchImpl }
  );
  const { request_id: requestId } = await created.json();
  const dispatched = await getRequestById(env.DB, requestId);
  await invoke(env, await signedCallback(env, {
    event: "claim",
    request_id: String(requestId),
    workflow_run_id: dispatched.workflow_run_id
  }, { nonce: options.claimNonce ?? `started-claim-${Math.random()}` }));
  await authorizeClaimedRequest(
    env,
    await getRequestById(env.DB, requestId),
    options.authorizedNonce ?? `started-authorized-${Math.random()}`
  );
  await invoke(env, await signedCallback(env, {
    event: "started",
    request_id: String(requestId),
    workflow_run_id: dispatched.workflow_run_id,
    check_id: options.checkId ?? "990",
    started_at: "2026-07-28T10:00:00.000Z"
  }, { nonce: options.startNonce ?? `started-start-${Math.random()}` }));
  return getRequestById(env.DB, requestId);
}

// ---------------------------------------------------------------------------
// AC-7 foundation artifacts
// ---------------------------------------------------------------------------

test("migration, wrangler, and README match hardened contracts", () => {
  const migration = fs.readFileSync(MIGRATION_PATH, "utf8");
  assert.match(migration, /installation_id TEXT PRIMARY KEY/);
  assert.match(migration, /repository_id TEXT NOT NULL/);
  assert.match(migration, /callback_nonces/);
  assert.match(migration, /expected_head_sha TEXT/);
  assert.match(migration, /workflow_run_id TEXT/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS outbox_jobs/);
  assert.match(migration, /repository_selection TEXT NOT NULL/);
  assert.match(migration, /receipt_id TEXT NOT NULL UNIQUE/);
  assert.match(migration, /authorized_at TEXT/);
  assert.match(migration, /UNIQUE \(request_key\)/);
  assert.match(migration, /UNIQUE \(request_id\)/);
  // Structural column inventory — prohibited storage columns must not exist.
  const createBlocks = migration.match(/CREATE TABLE IF NOT EXISTS \w+ \([\s\S]*?\);/g) || [];
  const columnNames = [];
  for (const block of createBlocks) {
    for (const line of block.split("\n")) {
      const m = /^\s*([a-z_][a-z0-9_]*)\s+/i.exec(line);
      if (m && !/^(CREATE|PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(m[1])) {
        columnNames.push(m[1].toLowerCase());
      }
    }
  }
  for (const banned of [
    "prompt",
    "diff_text",
    "access_token",
    "model_output",
    "repository_content",
    "diff",
    "findings",
    "review_body"
  ]) {
    assert.ok(!columnNames.includes(banned), `banned column ${banned}`);
  }
  assert.doesNotMatch(migration, /\b(prompt|diff_text|access_token|model_output)\b/i);

  const wrangler = fs.readFileSync(WRANGLER_PATH, "utf8");
  assert.match(wrangler, /workers_dev = true/);
  assert.match(wrangler, /database_id = "00000000-0000-0000-0000-000000000000"/);
  for (const variable of [
    "CONTROL_REPO_OWNER",
    "CONTROL_REPO_NAME",
    "CONTROL_WORKFLOW_FILE",
    "CONTROL_REF",
    "GITHUB_APP_ID"
  ]) {
    assert.match(wrangler, new RegExp(`^${variable} = ""$`, "m"));
  }
  assert.match(wrangler, /\/github\/webhooks/);

  const readme = fs.readFileSync(README_PATH, "utf8");
  assert.match(readme, /\/github\/webhooks/);
  assert.match(readme, /Pull requests.*Read & write/i);
  assert.match(readme, /X-Grok-Signature/);
  assert.match(readme, /X-Grok-Nonce/);
});

// ---------------------------------------------------------------------------
// AC-1 identity preservation
// ---------------------------------------------------------------------------

test("IDs above 2^53 survive JSON parse and remain unchanged", () => {
  const raw = `{"installation":{"id":${HUGE_INSTALL}},"repository":{"id":${HUGE_REPO}},"n":1.5}`;
  const parsed = parseJsonPreservingIntegerIds(raw);
  assert.equal(parsed.installation.id, HUGE_INSTALL);
  assert.equal(parsed.repository.id, HUGE_REPO);
  assert.equal(typeof parsed.installation.id, "string");
  assert.equal(parsed.n, 1.5);
  assert.equal(canonicalDecimalId(parsed.installation.id), HUGE_INSTALL);
  assert.equal(isCanonicalDecimalId(HUGE_ID), true);
  assert.equal(canonicalDecimalId(Number.MAX_SAFE_INTEGER + 1), null);
});

test("end-to-end webhook preserves over-2^53 installation and repository IDs", async () => {
  const env = makeEnv();
  await seedActiveInstall(env, HUGE_INSTALL, HUGE_REPO);
  const { fetchImpl, calls } = mockDispatchFetch();
  // Body uses unquoted large integers so parser must preserve them.
  const body = JSON.stringify({
    action: "opened",
    pull_request: {
      id: "7001",
      number: "7",
      draft: false,
      head: { sha: HEAD_A },
      user: { id: "42", type: "User" }
    },
    repository: { id: HUGE_REPO },
    installation: { id: HUGE_INSTALL },
    sender: { id: "42", type: "User" }
  });
  // Force unquoted huge IDs into the raw body.
  const raw = body
    .replace(`"${HUGE_REPO}"`, HUGE_REPO)
    .replace(`"${HUGE_INSTALL}"`, HUGE_INSTALL);

  const res = await invoke(
    env,
    await webhookRequest({ body: raw, event: "pull_request", deliveryId: "d-huge" }),
    { fetchImpl }
  );
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.result, "queued");
  const row = await getRequestById(env.DB, json.request_id);
  assert.equal(row.installation_id, HUGE_INSTALL);
  assert.equal(row.repository_id, HUGE_REPO);
  const inputs = JSON.parse(calls[0].body).inputs;
  assert.equal(inputs.installation_id, HUGE_INSTALL);
  assert.equal(inputs.repository_id, HUGE_REPO);
});

// ---------------------------------------------------------------------------
// AC-2 exact route + headers + HMAC
// ---------------------------------------------------------------------------

test("only exact POST /github/webhooks is admitted; /webhook is 404", async () => {
  const env = makeEnv();
  await seedActiveInstall(env);
  const { fetchImpl } = mockDispatchFetch();
  const bad = await invoke(
    env,
    await webhookRequest({
      url: "https://worker.example/webhook",
      body: basePrPayload(),
      event: "pull_request",
      deliveryId: "d-old-route"
    }),
    { fetchImpl }
  );
  assert.equal(bad.status, 404);

  const good = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload(),
      event: "pull_request",
      deliveryId: "d-new-route"
    }),
    { fetchImpl }
  );
  assert.equal(good.status, 200);
});

test("webhook rejects non-JSON content-type, missing headers, invalid HMAC, oversized body", async () => {
  const env = makeEnv();

  const ct = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload(),
      event: "pull_request",
      deliveryId: "d-ct",
      headers: { "content-type": "text/plain" }
    })
  );
  assert.equal(ct.status, 415);

  const missing = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload(),
      event: "pull_request",
      deliveryId: "d-nosig",
      signature: null
    })
  );
  assert.equal(missing.status, 400);

  const badSig = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload(),
      event: "pull_request",
      deliveryId: "d-badsig",
      signature: `sha256=${"00".repeat(32)}`
    })
  );
  assert.equal(badSig.status, 401);
  assert.equal(await getDelivery(env.DB, "d-badsig"), null);

  const huge = "x".repeat(MAX_WEBHOOK_BYTES + 1);
  const over = await invoke(
    env,
    await webhookRequest({
      body: huge,
      event: "pull_request",
      deliveryId: "d-over",
      headers: {
        "content-type": "application/json",
        "content-length": String(huge.length)
      }
    })
  );
  assert.equal(over.status, 413);
});

test("HMAC verifies raw body before JSON", async () => {
  const body = new TextEncoder().encode('{"ok":true}');
  const good = await signBody(body);
  assert.equal(await verifyGitHubSignature256(body, good, WEBHOOK_SECRET), true);
  assert.equal(await verifyGitHubSignature256(body, good, "other"), false);
});

test("webhook and callback HMAC secrets fail closed below 32 bytes or with invalid encoding bounds", async () => {
  assert.equal(isValidSharedSecret("x".repeat(31)), false);
  assert.equal(isValidSharedSecret("x".repeat(32)), true);
  assert.equal(isValidSharedSecret("🔐".repeat(8)), true);
  assert.equal(isValidSharedSecret(`x${"\n"}${"y".repeat(40)}`), false);
  assert.equal(isValidSharedSecret("x".repeat(4096)), true);
  assert.equal(isValidSharedSecret("x".repeat(4097)), false);

  const weakWebhook = await invoke(
    makeEnv({ WEBHOOK_SECRET: "too-short" }),
    await webhookRequest({
      body: basePrPayload(),
      event: "pull_request",
      deliveryId: "d-weak-webhook"
    })
  );
  assert.equal(weakWebhook.status, 500);
  assert.equal((await weakWebhook.json()).error, "misconfigured");

  const weakCallbackEnv = makeEnv({ RUNNER_CALLBACK_SECRET: "too-short" });
  const weakCallback = await invoke(
    weakCallbackEnv,
    await signedCallback(
      weakCallbackEnv,
      { event: "claim", request_id: "1", workflow_run_id: "2" },
      { nonce: "weak-callback", secret: "too-short" }
    )
  );
  assert.equal(weakCallback.status, 500);
  assert.equal((await weakCallback.json()).error, "misconfigured");
});

// ---------------------------------------------------------------------------
// AC-3 installation/repo gate + check binding
// ---------------------------------------------------------------------------

test("PR and mention triggers require active installation and selected repository", async () => {
  const env = makeEnv();
  const { fetchImpl, calls } = mockDispatchFetch();

  // No installation → unauthorized
  let res = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload(),
      event: "pull_request",
      deliveryId: "d-no-inst"
    }),
    { fetchImpl }
  );
  assert.equal((await res.json()).result, "unauthorized");
  assert.equal(calls.length, 0);

  // Installation suspended
  await upsertInstallation(env.DB, {
    installationId: "100",
    accountId: "1",
    accountType: "User",
    suspended: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  await addInstallationRepository(env.DB, "100", "500");
  res = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload(),
      event: "pull_request",
      deliveryId: "d-susp"
    }),
    { fetchImpl }
  );
  assert.equal((await res.json()).result, "unauthorized");

  // Active + selected → ok
  await upsertInstallation(env.DB, {
    installationId: "100",
    accountId: "1",
    accountType: "User",
    suspended: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  res = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload(),
      event: "pull_request",
      deliveryId: "d-auth"
    }),
    { fetchImpl }
  );
  assert.equal((await res.json()).result, "queued");
  assert.equal(calls.length, 1);
});

test("installation_repositories cannot unsuspend a suspended installation", async () => {
  const env = makeEnv();
  const { fetchImpl } = mockDispatchFetch();
  await upsertInstallation(env.DB, {
    installationId: "100",
    accountId: "1",
    accountType: "User",
    suspended: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  const res = await invoke(
    env,
    await webhookRequest({
      body: {
        action: "added",
        installation: { id: "100", account: { id: "1", type: "User" } },
        repositories_added: [{ id: "500" }]
      },
      event: "installation_repositories",
      deliveryId: "d-repo-add"
    }),
    { fetchImpl }
  );
  assert.equal((await res.json()).result, "repos_added");
  assert.equal(env.DB.installations.get("100").suspended, 1);
  assert.equal(await isInstallationRepoAuthorized(env.DB, "100", "500"), false);
});

test("installation removal blocks subsequent dispatch", async () => {
  const env = makeEnv();
  await seedActiveInstall(env);
  const { fetchImpl, calls } = mockDispatchFetch();

  await invoke(
    env,
    await webhookRequest({
      body: { action: "deleted", installation: { id: "100" } },
      event: "installation",
      deliveryId: "d-del"
    }),
    { fetchImpl }
  );

  const res = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload(),
      event: "pull_request",
      deliveryId: "d-after-del"
    }),
    { fetchImpl }
  );
  assert.equal((await res.json()).result, "unauthorized");
  assert.equal(calls.length, 0);
});

test("all-repositories selection authorizes signed repos and all-to-selected fails closed", async () => {
  const env = makeEnv();
  const created = await invoke(
    env,
    await webhookRequest({
      body: {
        action: "created",
        installation: {
          id: "100",
          account: { id: "1", type: "User" },
          repository_selection: "all"
        },
        repositories: []
      },
      event: "installation",
      deliveryId: "d-install-all"
    }),
    { ctx: {} }
  );
  assert.equal((await created.json()).result, "installation_upserted");
  assert.equal(await isInstallationRepoAuthorized(env.DB, "100", "987"), true);

  const admitted = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload({ repository: { id: "987" } }),
      event: "pull_request",
      deliveryId: "d-all-repo-pr"
    }),
    { ctx: {} }
  );
  assert.equal((await admitted.json()).result, "queued");

  await invoke(
    env,
    await webhookRequest({
      body: {
        action: "removed",
        repository_selection: "selected",
        installation: {
          id: "100",
          account: { id: "1", type: "User" },
          repository_selection: "selected"
        },
        repositories_removed: [{ id: "987" }]
      },
      event: "installation_repositories",
      deliveryId: "d-all-to-selected"
    }),
    { ctx: {} }
  );
  assert.equal(await isInstallationRepoAuthorized(env.DB, "100", "987"), false);
  assert.equal(
    [...env.DB.requestsById.values()][0].status,
    REQUEST_STATUS.SUPERSEDED
  );

  await invoke(
    env,
    await webhookRequest({
      body: {
        action: "added",
        repository_selection: "all",
        installation: {
          id: "100",
          account: { id: "1", type: "User" },
          repository_selection: "all"
        },
        repositories_added: []
      },
      event: "installation_repositories",
      deliveryId: "d-selected-to-all"
    }),
    { ctx: {} }
  );
  assert.equal(await isInstallationRepoAuthorized(env.DB, "100", "654"), true);
});

test("selected repository removal supersedes and durably cancels active work", async () => {
  const env = makeEnv();
  await seedActiveInstall(env);
  const { fetchImpl, calls } = mockDispatchFetch({ runIdStart: 6100 });
  const admitted = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload(),
      event: "pull_request",
      deliveryId: "d-removal-active"
    }),
    { fetchImpl }
  );
  const { request_id: requestId } = await admitted.json();

  await invoke(
    env,
    await webhookRequest({
      body: {
        action: "removed",
        repository_selection: "selected",
        installation: {
          id: "100",
          account: { id: "9", type: "Organization" },
          repository_selection: "selected"
        },
        repositories_removed: [{ id: "500" }]
      },
      event: "installation_repositories",
      deliveryId: "d-removal-cancel"
    }),
    { fetchImpl }
  );
  assert.equal(
    (await getRequestById(env.DB, requestId)).status,
    REQUEST_STATUS.SUPERSEDED
  );
  assert.ok(calls.some((call) => call.url.includes("/cancel")));
});

test("check_run rejects forged repository pairing and unmapped check identity", async () => {
  const env = makeEnv();
  await seedActiveInstall(env);
  const { fetchImpl, calls } = mockDispatchFetch();

  // Seed a parent request with a mapped check id via direct DB insert path.
  const now = new Date().toISOString();
  // Create parent through a real PR dispatch, then claim+start to store check id.
  const created = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload(),
      event: "pull_request",
      deliveryId: "d-parent"
    }),
    { fetchImpl }
  );
  const { request_id: requestId } = await created.json();
  const parent = await getRequestById(env.DB, requestId);
  const workflowRunId = parent.workflow_run_id;

  await invoke(
    env,
    await signedCallback(env, {
      event: "claim",
      request_id: String(requestId),
      workflow_run_id: workflowRunId
    }, { nonce: "n-claim-1" })
  );
  await authorizeClaimedRequest(
    env,
    await getRequestById(env.DB, requestId),
    "n-authorized-1"
  );
  await invoke(
    env,
    await signedCallback(env, {
      event: "started",
      request_id: String(requestId),
      workflow_run_id: workflowRunId,
      check_id: "6001",
      started_at: "2026-03-10T00:00:00.000Z"
    }, { nonce: "n-start-1" })
  );

  const externalId = encodeExternalId({
    installationId: "100",
    repositoryId: "500",
    pullNumber: "7",
    requestId: String(requestId)
  });

  // Forged repository on payload
  const forged = await invoke(
    env,
    await webhookRequest({
      body: {
        action: "requested_action",
        requested_action: { identifier: CHECK_RERUN_IDENTIFIER },
        check_run: {
          id: "6001",
          external_id: externalId,
          app: { id: "12345" },
          pull_requests: [{ number: "999" }]
        },
        installation: { id: "100" },
        repository: { id: "999999" },
        sender: { id: "42", type: "User" }
      },
      event: "check_run",
      deliveryId: "d-forged-repo"
    }),
    { fetchImpl }
  );
  assert.equal((await forged.json()).result, "repository_mismatch");

  // Wrong check id vs D1 mapping
  const badCheck = await invoke(
    env,
    await webhookRequest({
      body: {
        action: "requested_action",
        requested_action: { identifier: CHECK_RERUN_IDENTIFIER },
        check_run: {
          id: "9999",
          external_id: externalId,
          app: { id: "12345" }
        },
        installation: { id: "100" },
        repository: { id: "500" },
        sender: { id: "42", type: "User" }
      },
      event: "check_run",
      deliveryId: "d-bad-check"
    }),
    { fetchImpl }
  );
  assert.equal((await badCheck.json()).result, "check_identity_mismatch");

  // Valid rerun
  const before = calls.length;
  const rerunPayload = {
    action: "requested_action",
    requested_action: { identifier: CHECK_RERUN_IDENTIFIER },
    check_run: {
      id: "6001",
      external_id: externalId,
      app: { id: "12345" },
      pull_requests: [{ number: "999" }]
    },
    installation: { id: "100" },
    repository: { id: "500" },
    sender: { id: "42", type: "User" }
  };
  const okRerun = await invoke(
    env,
    await webhookRequest({
      body: rerunPayload,
      event: "check_run",
      deliveryId: "d-good-rerun"
    }),
    { fetchImpl }
  );
  const firstRerunJson = await okRerun.json();
  assert.equal(firstRerunJson.result, "queued");
  assert.ok(calls.length > before);
  const dispatchCalls = calls.filter((call) => call.url.includes("/dispatches"));
  const lastInputs = JSON.parse(dispatchCalls.at(-1).body).inputs;
  assert.equal(lastInputs.trigger_kind, TRIGGER_KIND.CHECK_RERUN);
  assert.equal(lastInputs.pull_number, "7");
  const rerunRequest = [...env.DB.requestsById.values()].at(-1);
  assert.equal(rerunRequest.expected_head_sha, null);

  const secondRerun = await invoke(
    env,
    await webhookRequest({
      body: rerunPayload,
      event: "check_run",
      deliveryId: "d-good-rerun-2"
    }),
    { fetchImpl }
  );
  const secondRerunJson = await secondRerun.json();
  assert.notEqual(secondRerunJson.request_id, firstRerunJson.request_id);
  assert.equal(
    (await getRequestById(env.DB, firstRerunJson.request_id)).status,
    REQUEST_STATUS.DISPATCHED
  );
  const secondRow = await getRequestById(env.DB, secondRerunJson.request_id);
  await invoke(
    env,
    await signedCallback(env, {
      event: "claim",
      request_id: secondRerunJson.request_id,
      workflow_run_id: secondRow.workflow_run_id
    }, { nonce: "n-check-authz-claim" })
  );
  const authorized = await invoke(
    env,
    await signedCallback(env, {
      event: "authorized",
      request_id: secondRerunJson.request_id,
      workflow_run_id: secondRow.workflow_run_id
    }, { nonce: "n-check-authz" })
  );
  assert.equal((await authorized.json()).result, "authorized");
  assert.equal(
    (await getRequestById(env.DB, firstRerunJson.request_id)).status,
    REQUEST_STATUS.SUPERSEDED
  );
});

// ---------------------------------------------------------------------------
// AC-4 head/policy dedupe + manual distinctness
// ---------------------------------------------------------------------------

test("each automatic lifecycle delivery is distinct and supersedes only after live authorization", async () => {
  const env = makeEnv();
  await seedActiveInstall(env);
  const { fetchImpl, calls } = mockDispatchFetch({ runIdStart: 1000 });

  const first = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload({ action: "opened" }),
      event: "pull_request",
      deliveryId: "d-head-1"
    }),
    { fetchImpl }
  );
  const j1 = await first.json();
  assert.equal(j1.result, "queued");
  const row1 = await getRequestById(env.DB, j1.request_id);
  assert.equal(row1.expected_head_sha, HEAD_A);
  assert.equal(row1.policy_version, POLICY_VERSION);
  assert.match(row1.receipt_id, /^grr_[0-9a-f]{32}$/);
  assert.equal(
    row1.request_key,
    buildAutomaticRequestKey({
      installationId: "100",
      repositoryId: "500",
      pullNumber: "7",
      action: "opened",
      deliveryId: "d-head-1",
      headSha: HEAD_A
    })
  );

  // A distinct signed occurrence on the same head is intentionally new.
  const same = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload({ action: "reopened" }),
      event: "pull_request",
      deliveryId: "d-head-1b"
    }),
    { fetchImpl }
  );
  const jSame = await same.json();
  assert.equal(jSame.result, "queued");
  assert.notEqual(jSame.request_id, j1.request_id);
  assert.notEqual(
    (await getRequestById(env.DB, jSame.request_id)).receipt_id,
    row1.receipt_id
  );
  assert.equal(
    (await getRequestById(env.DB, jSame.request_id)).request_key,
    buildAutomaticRequestKey({
      installationId: "100",
      repositoryId: "500",
      pullNumber: "7",
      action: "reopened",
      deliveryId: "d-head-1b",
      headSha: HEAD_A
    })
  );
  // Webhook arrival order is not authority to cancel another request.
  const old = await getRequestById(env.DB, j1.request_id);
  assert.equal(old.status, REQUEST_STATUS.DISPATCHED);
  assert.equal(calls.some((c) => c.url.includes("/cancel")), false);

  const current = await getRequestById(env.DB, jSame.request_id);
  await invoke(
    env,
    await signedCallback(env, {
      event: "claim",
      request_id: jSame.request_id,
      workflow_run_id: current.workflow_run_id
    }, { nonce: "n-auto-same-claim" })
  );
  await authorizeClaimedRequest(
    env,
    await getRequestById(env.DB, jSame.request_id),
    "n-auto-same-authorized"
  );
  assert.equal(
    (await getRequestById(env.DB, j1.request_id)).status,
    REQUEST_STATUS.SUPERSEDED
  );
  await processOutbox(env, { fetchImpl });
  assert.ok(calls.some((c) => c.url.includes("/cancel")));
});

test("a delayed stale automatic webhook cannot supersede an already-authorized current head", async () => {
  const env = makeEnv();
  await seedActiveInstall(env);
  const { fetchImpl } = mockDispatchFetch({ runIdStart: 1200 });

  const currentResponse = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload({
        action: "synchronize",
        pull_request: {
          ...basePrPayload().pull_request,
          head: { sha: HEAD_B }
        }
      }),
      event: "pull_request",
      deliveryId: "d-current-head"
    }),
    { fetchImpl }
  );
  const currentId = (await currentResponse.json()).request_id;
  let current = await getRequestById(env.DB, currentId);
  await invoke(
    env,
    await signedCallback(env, {
      event: "claim",
      request_id: currentId,
      workflow_run_id: current.workflow_run_id
    }, { nonce: "n-current-claim" })
  );
  await authorizeClaimedRequest(
    env,
    await getRequestById(env.DB, currentId),
    "n-current-authorized"
  );

  const staleResponse = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload({
        action: "synchronize",
        pull_request: {
          ...basePrPayload().pull_request,
          head: { sha: HEAD_A }
        }
      }),
      event: "pull_request",
      deliveryId: "d-delayed-stale-head"
    }),
    { fetchImpl }
  );
  const staleId = (await staleResponse.json()).request_id;
  current = await getRequestById(env.DB, currentId);
  const stale = await getRequestById(env.DB, staleId);
  assert.equal(current.status, REQUEST_STATUS.CLAIMED);
  assert.equal(stale.status, REQUEST_STATUS.DISPATCHED);

  await invoke(
    env,
    await signedCallback(env, {
      event: "claim",
      request_id: staleId,
      workflow_run_id: stale.workflow_run_id
    }, { nonce: "n-stale-claim" })
  );
  const unauthorizedStart = await invoke(
    env,
    await signedCallback(env, {
      event: "started",
      request_id: staleId,
      workflow_run_id: stale.workflow_run_id,
      check_id: "120099",
      started_at: "2026-07-28T10:00:00.000Z"
    }, { nonce: "n-stale-start" })
  );
  assert.equal(unauthorizedStart.status, 409);
  assert.equal(
    (await getRequestById(env.DB, currentId)).status,
    REQUEST_STATUS.CLAIMED
  );
});

test("an older authorization callback cannot cancel a newer admitted head", async () => {
  const env = makeEnv();
  await seedActiveInstall(env);
  const { fetchImpl } = mockDispatchFetch({ runIdStart: 1300 });

  const oldResponse = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload({ action: "opened" }),
      event: "pull_request",
      deliveryId: "d-auth-race-old"
    }),
    { fetchImpl }
  );
  const oldId = (await oldResponse.json()).request_id;
  const old = await getRequestById(env.DB, oldId);
  await invoke(
    env,
    await signedCallback(env, {
      event: "claim",
      request_id: oldId,
      workflow_run_id: old.workflow_run_id
    }, { nonce: "n-auth-race-old-claim" })
  );

  const currentResponse = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload({
        action: "synchronize",
        pull_request: {
          ...basePrPayload().pull_request,
          head: { sha: HEAD_B }
        }
      }),
      event: "pull_request",
      deliveryId: "d-auth-race-current"
    }),
    { fetchImpl }
  );
  const currentId = (await currentResponse.json()).request_id;
  const current = await getRequestById(env.DB, currentId);

  // The old runner's authority fetch may have completed just before HEAD_B was
  // admitted. Its callback may authorize itself, but must not cancel HEAD_B.
  await authorizeClaimedRequest(
    env,
    await getRequestById(env.DB, oldId),
    "n-auth-race-old-authorized"
  );
  assert.equal(
    (await getRequestById(env.DB, currentId)).status,
    REQUEST_STATUS.DISPATCHED
  );
  assert.equal(
    await getOutboxJobByKey(env.DB, `cancel:${current.workflow_run_id}`),
    null
  );

  const oldRetry = await invoke(
    env,
    await signedCallback(env, {
      event: "authorized",
      request_id: oldId,
      workflow_run_id: old.workflow_run_id
    }, { nonce: "n-auth-race-old-retry" })
  );
  assert.equal((await oldRetry.json()).result, "already_authorized");

  const oldAbort = await invoke(
    env,
    await signedCallback(env, {
      event: "abort",
      request_id: oldId,
      workflow_run_id: old.workflow_run_id,
      status: "cancelled",
      check_id: null
    }, { nonce: "n-auth-race-old-abort" })
  );
  assert.equal((await oldAbort.json()).result, "aborted");

  await invoke(
    env,
    await signedCallback(env, {
      event: "claim",
      request_id: currentId,
      workflow_run_id: current.workflow_run_id
    }, { nonce: "n-auth-race-current-claim" })
  );
  await authorizeClaimedRequest(
    env,
    await getRequestById(env.DB, currentId),
    "n-auth-race-current-authorized"
  );
  assert.equal(
    (await getRequestById(env.DB, currentId)).status,
    REQUEST_STATUS.CLAIMED
  );
});

test("unvalidated manual comments remain distinct and never supersede active work", async () => {
  const env = makeEnv();
  await seedActiveInstall(env);
  const { fetchImpl, calls } = mockDispatchFetch();

  const a = await invoke(
    env,
    await webhookRequest({
      body: baseCommentPayload({ comment: { id: "8001", body: MANUAL_REVIEW_COMMAND, user: { id: "42", type: "User" } } }),
      event: "issue_comment",
      deliveryId: "d-man-1"
    }),
    { fetchImpl }
  );
  const b = await invoke(
    env,
    await webhookRequest({
      body: baseCommentPayload({ comment: { id: "8002", body: MANUAL_REVIEW_COMMAND, user: { id: "42", type: "User" } } }),
      event: "issue_comment",
      deliveryId: "d-man-2"
    }),
    { fetchImpl }
  );
  const ja = await a.json();
  const jb = await b.json();
  assert.equal(ja.result, "queued");
  assert.equal(jb.result, "queued");
  assert.notEqual(ja.request_id, jb.request_id);
  assert.equal(
    (await getRequestById(env.DB, ja.request_id)).request_key,
    buildManualCommentRequestKey({ installationId: "100", repositoryId: "500", commentId: "8001" })
  );
  assert.equal(calls.filter((call) => call.url.includes("/dispatches")).length, 2);
  assert.equal(calls.some((call) => call.url.includes("/cancel")), false);
  assert.equal(
    (await getRequestById(env.DB, ja.request_id)).status,
    REQUEST_STATUS.DISPATCHED
  );
});

test("authorized manual callback atomically supersedes peers and is idempotent", async () => {
  const env = makeEnv();
  await seedActiveInstall(env);
  const { fetchImpl } = mockDispatchFetch({ runIdStart: 7000 });
  const automatic = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload(),
      event: "pull_request",
      deliveryId: "d-authz-auto"
    }),
    { fetchImpl }
  );
  const automaticId = (await automatic.json()).request_id;
  const manual = await invoke(
    env,
    await webhookRequest({
      body: baseCommentPayload(),
      event: "issue_comment",
      deliveryId: "d-authz-manual"
    }),
    { fetchImpl }
  );
  const manualId = (await manual.json()).request_id;
  assert.equal(
    (await getRequestById(env.DB, automaticId)).status,
    REQUEST_STATUS.DISPATCHED
  );
  const manualRow = await getRequestById(env.DB, manualId);

  await invoke(
    env,
    await signedCallback(env, {
      event: "claim",
      request_id: manualId,
      workflow_run_id: manualRow.workflow_run_id
    }, { nonce: "n-authz-claim" })
  );
  const authorized = await invoke(
    env,
    await signedCallback(env, {
      event: "authorized",
      request_id: manualId,
      workflow_run_id: manualRow.workflow_run_id
    }, { nonce: "n-authz-first" })
  );
  const fence = await authorized.json();
  assert.equal(fence.result, "authorized");
  assert.equal(fence.request_id, manualId);
  assert.equal(fence.trigger_kind, TRIGGER_KIND.MANUAL_COMMENT);
  assert.equal(
    (await getRequestById(env.DB, automaticId)).status,
    REQUEST_STATUS.SUPERSEDED
  );
  assert.ok((await getRequestById(env.DB, manualId)).authorized_at);

  const replay = await invoke(
    env,
    await signedCallback(env, {
      event: "authorized",
      request_id: manualId,
      workflow_run_id: manualRow.workflow_run_id
    }, { nonce: "n-authz-second" })
  );
  assert.equal((await replay.json()).result, "already_authorized");
});

test("drafts, bots on manual/check, malformed commands, unsupported events are safe", async () => {
  const env = makeEnv();
  await seedActiveInstall(env);
  const { fetchImpl, calls } = mockDispatchFetch();

  assert.equal(
    (await (await invoke(
      env,
      await webhookRequest({
        body: basePrPayload({
          pull_request: { id: "1", number: "7", draft: true, head: { sha: HEAD_A }, user: { id: "1" } }
        }),
        event: "pull_request",
        deliveryId: "d-draft"
      }),
      { fetchImpl }
    )).json()).result,
    "draft_skipped"
  );

  // Automatic PR from bot (Dependabot) must dispatch.
  const botPr = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload({
        sender: { id: "9", login: "dependabot[bot]", type: "Bot" },
        pull_request: {
          id: "7001",
          number: "7",
          draft: false,
          head: { sha: HEAD_A },
          user: { id: "9", login: "dependabot[bot]", type: "Bot" }
        }
      }),
      event: "pull_request",
      deliveryId: "d-bot-pr"
    }),
    { fetchImpl }
  );
  assert.equal((await botPr.json()).result, "queued");

  // Manual command from bot is rejected.
  assert.equal(
    (await (await invoke(
      env,
      await webhookRequest({
        body: baseCommentPayload({
          sender: { id: "9", login: "dependabot[bot]", type: "Bot" },
          comment: { id: "1", body: MANUAL_REVIEW_COMMAND, user: { id: "9", type: "Bot" } }
        }),
        event: "issue_comment",
        deliveryId: "d-bot-cmd"
      }),
      { fetchImpl }
    )).json()).result,
    "bot_rejected"
  );

  assert.equal(
    (await (await invoke(
      env,
      await webhookRequest({
        body: baseCommentPayload({
          comment: { id: "1", body: "@grok-review review please", user: { id: "42", type: "User" } }
        }),
        event: "issue_comment",
        deliveryId: "d-cmd"
      }),
      { fetchImpl }
    )).json()).result,
    "command_ignored"
  );

  assert.equal(
    (await (await invoke(
      env,
      await webhookRequest({
        body: { action: "created", ref: "refs/heads/main" },
        event: "push",
        deliveryId: "d-push"
      }),
      { fetchImpl }
    )).json()).result,
    "event_not_allowed"
  );

  // One dispatch from bot PR only.
  assert.equal(calls.filter((c) => c.url.includes("/dispatches")).length, 1);
});

// ---------------------------------------------------------------------------
// AC-2/AC-5 delivery replay + CAS + claim election
// ---------------------------------------------------------------------------

test("same delivery digest is pure no-op; digest mismatch fails closed", async () => {
  const env = makeEnv();
  await seedActiveInstall(env);
  const { fetchImpl, calls } = mockDispatchFetch();
  const payload = basePrPayload();
  const body = JSON.stringify(payload);

  const r1 = await invoke(
    env,
    await webhookRequest({ body, event: "pull_request", deliveryId: "d-replay" }),
    { fetchImpl }
  );
  assert.equal((await r1.json()).result, "queued");

  const r2 = await invoke(
    env,
    await webhookRequest({ body, event: "pull_request", deliveryId: "d-replay" }),
    { fetchImpl }
  );
  const j2 = await r2.json();
  assert.equal(j2.replay, true);
  assert.equal(j2.result, "replay");
  assert.equal(calls.length, 1);

  const r3 = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload({ action: "synchronize" }),
      event: "pull_request",
      deliveryId: "d-replay"
    }),
    { fetchImpl }
  );
  assert.equal(r3.status, 409);
});

test("request and dispatch enqueue are atomic; admitted crash replay repairs the route", async () => {
  const env = makeEnv();
  await seedActiveInstall(env);
  const payload = basePrPayload();

  env.DB.failNextBatchAt(1);
  const crashingRequest = await webhookRequest({
    body: payload,
    event: "pull_request",
    deliveryId: "d-atomic-crash"
  });
  await assert.rejects(
    () => invoke(
      env,
      crashingRequest,
      { ctx: {} }
    ),
    /injected batch failure/
  );
  assert.equal(env.DB.requestsById.size, 0);
  assert.equal((await listOutboxJobs(env.DB)).length, 0);
  assert.equal((await getDelivery(env.DB, "d-atomic-crash")).status, "admitted");

  const recovered = await invoke(
    env,
    await webhookRequest({
      body: payload,
      event: "pull_request",
      deliveryId: "d-atomic-crash"
    }),
    { ctx: {} }
  );
  assert.equal((await recovered.json()).result, "queued");
  assert.equal(env.DB.requestsById.size, 1);
  assert.equal((await listOutboxJobs(env.DB)).length, 1);
  assert.equal((await getDelivery(env.DB, "d-atomic-crash")).status, "processed");
});

test("webhook response is not blocked on GitHub network work", async () => {
  const env = makeEnv();
  await seedActiveInstall(env);
  let resolveDispatch;
  let networkStarted = false;
  const fetchImpl = async (url) => {
    if (!String(url).includes("/dispatches")) {
      return new Response(null, { status: 202 });
    }
    networkStarted = true;
    return new Promise((resolve) => {
      resolveDispatch = resolve;
    });
  };
  let waitUntilWork;
  const response = await handleRequest(
    await webhookRequest({
      body: basePrPayload(),
      event: "pull_request",
      deliveryId: "d-sync-response"
    }),
    env,
    {
      waitUntil(promise) {
        waitUntilWork = promise;
      }
    },
    { fetchImpl, workerId: "webhook-best-effort" }
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result, "queued");
  assert.ok(waitUntilWork);

  // Let the background task reach the deliberately unresolved network call.
  while (!networkStarted) await Promise.resolve();
  const runId = "5555";
  resolveDispatch(new Response(
    JSON.stringify({
      workflow_run_id: runId,
      run_url: `${GITHUB_API_BASE}/repos/control-org/control-repo/actions/runs/${runId}`,
      html_url: `https://github.com/control-org/control-repo/actions/runs/${runId}`
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  ));
  await waitUntilWork;
  assert.equal(
    [...env.DB.requestsById.values()][0].workflow_run_id,
    runId
  );
});

test("outbox leases have one winner and recover after expiry", async () => {
  const env = makeEnv();
  await seedActiveInstall(env);
  await invoke(
    env,
    await webhookRequest({
      body: basePrPayload(),
      event: "pull_request",
      deliveryId: "d-lease"
    }),
    { ctx: {} }
  );
  const nowMs = Date.now() + 1_000;
  const now = new Date(nowMs).toISOString();
  const expires = new Date(nowMs + OUTBOX_LEASE_MS).toISOString();
  const [a, b] = await Promise.all([
    leaseOutboxJobs(env.DB, {
      now,
      leaseOwner: "lease-a",
      leaseExpiresAt: expires,
      limit: 1
    }),
    leaseOutboxJobs(env.DB, {
      now,
      leaseOwner: "lease-b",
      leaseExpiresAt: expires,
      limit: 1
    })
  ]);
  assert.equal(a.length + b.length, 1);
  assert.equal((await leaseOutboxJobs(env.DB, {
    now: new Date(nowMs + OUTBOX_LEASE_MS - 1).toISOString(),
    leaseOwner: "lease-early",
    leaseExpiresAt: new Date(nowMs + (2 * OUTBOX_LEASE_MS)).toISOString(),
    limit: 1
  })).length, 0);
  assert.equal((await leaseOutboxJobs(env.DB, {
    now: new Date(nowMs + OUTBOX_LEASE_MS + 1).toISOString(),
    leaseOwner: "lease-recovery",
    leaseExpiresAt: new Date(nowMs + (2 * OUTBOX_LEASE_MS)).toISOString(),
    limit: 1
  })).length, 1);
});

test("lost workflow claim atomically queues orphan cancellation", async () => {
  const env = makeEnv();
  await seedActiveInstall(env);
  const admitted = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload(),
      event: "pull_request",
      deliveryId: "d-orphan"
    }),
    { ctx: {} }
  );
  const { request_id: requestId } = await admitted.json();
  const requestRow = await getRequestById(env.DB, requestId);

  let resolveDispatch;
  let markDispatchStarted;
  const dispatchStarted = new Promise((resolve) => {
    markDispatchStarted = resolve;
  });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/dispatches")) {
      markDispatchStarted();
      return new Promise((resolve) => {
        resolveDispatch = resolve;
      });
    }
    return new Response(null, { status: 202 });
  };
  const nowMs = Date.now() + 1_000;
  const processing = processOutbox(env, {
    fetchImpl,
    workerId: "orphan-dispatcher",
    nowMs
  });
  await dispatchStarted;
  await supersedePrRequestsWithOutbox(env.DB, {
    installationId: requestRow.installation_id,
    repositoryId: requestRow.repository_id,
    pullNumber: requestRow.pull_number
  }, new Date(nowMs).toISOString());
  const orphanRunId = "7777";
  resolveDispatch(new Response(
    JSON.stringify({
      workflow_run_id: orphanRunId,
      run_url: `${GITHUB_API_BASE}/repos/control-org/control-repo/actions/runs/${orphanRunId}`,
      html_url: `https://github.com/control-org/control-repo/actions/runs/${orphanRunId}`
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  ));
  const firstPass = await processing;
  assert.equal(firstPass.orphaned, 1);
  const cancelJob = await getOutboxJobByKey(env.DB, `cancel:${orphanRunId}`);
  assert.equal(cancelJob.status, "pending");

  await processOutbox(env, {
    fetchImpl,
    workerId: "orphan-canceller",
    nowMs: nowMs + 1
  });
  assert.equal(
    (await getOutboxJobByKey(env.DB, `cancel:${orphanRunId}`)).status,
    "completed"
  );
  assert.ok(calls.some((url) => url.endsWith(`/actions/runs/${orphanRunId}/cancel`)));
});

test("failed dispatch uses capped backoff and scheduled retry of the same durable job", async () => {
  const env = makeEnv();
  await seedActiveInstall(env);
  let mode = "fail";
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/dispatches")) {
      if (mode === "fail") return new Response("nope", { status: 500 });
      return new Response(
        JSON.stringify({
          workflow_run_id: "4242",
          run_url: `${GITHUB_API_BASE}/repos/control-org/control-repo/actions/runs/4242`,
          html_url: "https://github.com/control-org/control-repo/actions/runs/4242"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(null, { status: 202 });
  };

  const payload = basePrPayload();
  const res1 = await invoke(
    env,
    await webhookRequest({ body: payload, event: "pull_request", deliveryId: "d-fail-1" }),
    { fetchImpl }
  );
  const j1 = await res1.json();
  assert.equal(j1.result, "queued");
  assert.equal((await getRequestById(env.DB, j1.request_id)).status, REQUEST_STATUS.FAILED_DISPATCH);

  mode = "ok";
  const jobs = await listOutboxJobs(env.DB);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "pending");
  assert.equal(jobs[0].attempt_count, 1);
  assert.equal(jobs[0].last_error_code, "dispatch_http");
  assert.equal(computeOutboxBackoffMs(1), 1_000);
  assert.equal(computeOutboxBackoffMs(99), OUTBOX_BACKOFF_MAX_MS);
  let scheduledWork;
  handleScheduled(env, {
    waitUntil(promise) {
      scheduledWork = promise;
    }
  }, {
    fetchImpl,
    workerId: "scheduled-retry",
    nowMs: Date.parse(jobs[0].available_at)
  });
  assert.equal(typeof worker.scheduled, "function");
  await scheduledWork;
  assert.equal((await getRequestById(env.DB, j1.request_id)).workflow_run_id, "4242");
});

test("watchdog terminalizes only an exact completed control run and fences late receipts", async () => {
  const env = makeEnv();
  const started = await createStartedReview(env, {
    deliveryId: "d-watchdog",
    checkId: "992",
    claimNonce: "watchdog-claim",
    startNonce: "watchdog-start"
  });
  env.DB.requestsById.get(String(started.request_id)).updated_at =
    "2026-07-01T00:00:00.000Z";
  const fetchImpl = async (url, init) => {
    assert.equal(init.method, "GET");
    assert.ok(String(url).endsWith(`/actions/runs/${started.workflow_run_id}`));
    return new Response(JSON.stringify({
      id: started.workflow_run_id,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "failure",
      path: ".github/workflows/grok-review.yml@refs/heads/main",
      repository: {
        name: "control-repo",
        owner: { login: "control-org" }
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const mismatched = await processWorkflowWatchdog(env, {
    fetchImpl: async () => new Response(JSON.stringify({
      id: started.workflow_run_id,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "failure",
      path: ".github/workflows/other.yml@refs/heads/main",
      repository: {
        name: "control-repo",
        owner: { login: "control-org" }
      }
    }), { status: 200, headers: { "content-type": "application/json" } }),
    nowMs: Date.parse("2026-07-28T12:00:00.000Z")
  });
  assert.equal(mismatched.errors, 1);
  assert.equal(
    (await getRequestById(env.DB, started.request_id)).status,
    REQUEST_STATUS.STARTED
  );
  const stats = await processWorkflowWatchdog(env, {
    fetchImpl,
    nowMs: Date.parse("2026-07-28T12:00:00.000Z")
  });
  assert.equal(stats.terminalized, 1);
  assert.equal(
    (await getRequestById(env.DB, started.request_id)).status,
    REQUEST_STATUS.FAILED
  );
  assert.equal(await getReceiptByRequestId(env.DB, started.request_id), null);

  const late = await invoke(
    env,
    await signedCallback(env, await terminalCallbackBody(started, {
      checkId: "992"
    }), { nonce: "watchdog-late-terminal" })
  );
  assert.equal(late.status, 409);
  assert.equal(await getReceiptByRequestId(env.DB, started.request_id), null);
});

test("CAS does not revive superseded request after ambiguous dispatch", async () => {
  const env = makeEnv();
  await seedActiveInstall(env);
  const { fetchImpl } = mockDispatchFetch({ runIdStart: 2000 });

  const first = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload(),
      event: "pull_request",
      deliveryId: "d-cas-1"
    }),
    { fetchImpl }
  );
  const j1 = await first.json();

  // Supersede only after the new head's runner authorizes it.
  const second = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload({
        action: "synchronize",
        pull_request: {
          id: "7009",
          number: "7",
          draft: false,
          head: { sha: HEAD_B },
          user: { id: "42", type: "User" }
        }
      }),
      event: "pull_request",
      deliveryId: "d-cas-2"
    }),
    { fetchImpl }
  );
  const j2 = await second.json();
  const row2 = await getRequestById(env.DB, j2.request_id);
  await invoke(
    env,
    await signedCallback(env, {
      event: "claim",
      request_id: j2.request_id,
      workflow_run_id: row2.workflow_run_id
    }, { nonce: "n-cas-new-claim" })
  );
  await authorizeClaimedRequest(
    env,
    await getRequestById(env.DB, j2.request_id),
    "n-cas-new-authorized"
  );

  const old = await getRequestById(env.DB, j1.request_id);
  assert.equal(old.status, REQUEST_STATUS.SUPERSEDED);

  // Direct CAS claim must fail on superseded
  const claimed = await env.DB
    .prepare(
      `UPDATE review_requests
       SET status = ?, workflow_run_id = ?, workflow_run_url = ?, workflow_html_url = ?, updated_at = ?
       WHERE request_id = ?
         AND status IN (?, ?)
         AND workflow_run_id IS NULL`
    )
    .bind(
      REQUEST_STATUS.DISPATCHED,
      "99999",
      null,
      null,
      new Date().toISOString(),
      String(j1.request_id),
      REQUEST_STATUS.PENDING_DISPATCH,
      REQUEST_STATUS.FAILED_DISPATCH
    )
    .run();
  assert.equal(claimed.meta.changes, 0);
  assert.equal((await getRequestById(env.DB, j1.request_id)).status, REQUEST_STATUS.SUPERSEDED);
});

test("dispatch inputs are decimal strings + trigger_kind only", () => {
  const built = buildDispatchInputs({
    requestId: "1",
    installationId: HUGE_INSTALL,
    repositoryId: "3",
    pullNumber: "4",
    triggerId: "5",
    actorId: "6",
    triggerKind: TRIGGER_KIND.AUTOMATIC
  });
  assert.equal(built.ok, true);
  assert.equal(built.inputs.installation_id, HUGE_INSTALL);
  assert.equal(Object.keys(built.inputs).length, 7);
});

// ---------------------------------------------------------------------------
// AC-6 callback HMAC, nonce, schemas, binding
// ---------------------------------------------------------------------------

test("callback rejects unauthenticated, skewed, header mutation, and forged payloads", async () => {
  const env = makeEnv();
  await seedActiveInstall(env);
  const { fetchImpl } = mockDispatchFetch();
  const created = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload(),
      event: "pull_request",
      deliveryId: "d-cb-base"
    }),
    { fetchImpl }
  );
  const { request_id: requestId } = await created.json();
  const wf = (await getRequestById(env.DB, requestId)).workflow_run_id;
  const claimBody = { event: "claim", request_id: String(requestId), workflow_run_id: wf };
  const raw = JSON.stringify(claimBody);
  const rawBytes = new TextEncoder().encode(raw);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = "mac-bind-1";
  const goodSig = await signCallbackMessage(rawBytes, ts, nonce, CALLBACK_SECRET);

  const noAuth = await invoke(
    env,
    new Request(`https://worker.example${CALLBACK_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw
    })
  );
  assert.equal(noAuth.status, 401);

  // Captured body signature must not accept a mutated timestamp/nonce (MAC binds both).
  const mutatedTsReq = new Request(`https://worker.example${CALLBACK_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-grok-signature": goodSig,
      "x-grok-timestamp": String(Number(ts) - 1),
      "x-grok-nonce": nonce
    },
    body: raw
  });
  assert.equal((await invoke(env, mutatedTsReq)).status, 401);

  const mutatedNonceReq = new Request(`https://worker.example${CALLBACK_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-grok-signature": goodSig,
      "x-grok-timestamp": ts,
      "x-grok-nonce": "other-nonce"
    },
    body: raw
  });
  assert.equal((await invoke(env, mutatedNonceReq)).status, 401);

  const skew = await invoke(
    env,
    await signedCallback(env, claimBody, {
      timestamp: Math.floor(Date.now() / 1000) - 10_000,
      nonce: "skew-1"
    })
  );
  assert.equal(skew.status, 400);

  const badBind = await invoke(
    env,
    await signedCallback(env, {
      event: "claim",
      request_id: String(requestId),
      workflow_run_id: "111111"
    }, { nonce: "bad-bind" })
  );
  assert.equal(badBind.status, 409);
});

test("abort terminalizes only claimed/no-check or started/exact-check without a receipt", async () => {
  const env = makeEnv();
  await seedActiveInstall(env);
  const { fetchImpl } = mockDispatchFetch({ runIdStart: 8100 });
  const first = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload(),
      event: "pull_request",
      deliveryId: "d-abort-1"
    }),
    { fetchImpl }
  );
  const firstId = (await first.json()).request_id;
  const firstRow = await getRequestById(env.DB, firstId);
  await invoke(env, await signedCallback(env, {
    event: "claim",
    request_id: firstId,
    workflow_run_id: firstRow.workflow_run_id
  }, { nonce: "n-abort-claim" }));
  const aborted = await invoke(env, await signedCallback(env, {
    event: "abort",
    request_id: firstId,
    workflow_run_id: firstRow.workflow_run_id,
    status: "failed",
    check_id: null
  }, { nonce: "n-abort-first" }));
  assert.equal((await aborted.json()).result, "aborted");
  assert.equal((await getRequestById(env.DB, firstId)).status, REQUEST_STATUS.FAILED);
  assert.equal(await getReceiptByRequestId(env.DB, firstId), null);

  const idempotent = await invoke(env, await signedCallback(env, {
    event: "abort",
    request_id: firstId,
    workflow_run_id: firstRow.workflow_run_id,
    status: "failed",
    check_id: null
  }, { nonce: "n-abort-retry" }));
  assert.equal((await idempotent.json()).result, "already_aborted");

  const second = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload({
        action: "synchronize",
        pull_request: {
          ...basePrPayload().pull_request,
          id: "7002",
          head: { sha: HEAD_B }
        }
      }),
      event: "pull_request",
      deliveryId: "d-abort-2"
    }),
    { fetchImpl }
  );
  const secondId = (await second.json()).request_id;
  const secondRow = await getRequestById(env.DB, secondId);
  await invoke(env, await signedCallback(env, {
    event: "claim",
    request_id: secondId,
    workflow_run_id: secondRow.workflow_run_id
  }, { nonce: "n-abort-claim-2" }));
  await authorizeClaimedRequest(
    env,
    await getRequestById(env.DB, secondId),
    "n-abort-authorized-2"
  );
  await invoke(env, await signedCallback(env, {
    event: "started",
    request_id: secondId,
    workflow_run_id: secondRow.workflow_run_id,
    check_id: "9191",
    started_at: "2026-03-10T00:00:00.000Z"
  }, { nonce: "n-abort-started" }));
  const wrong = await invoke(env, await signedCallback(env, {
    event: "abort",
    request_id: secondId,
    workflow_run_id: secondRow.workflow_run_id,
    status: "cancelled",
    check_id: null
  }, { nonce: "n-abort-wrong" }));
  assert.equal(wrong.status, 409);
  const exact = await invoke(env, await signedCallback(env, {
    event: "abort",
    request_id: secondId,
    workflow_run_id: secondRow.workflow_run_id,
    status: "cancelled",
    check_id: "9191"
  }, { nonce: "n-abort-exact" }));
  assert.equal((await exact.json()).result, "aborted");
  assert.equal((await getRequestById(env.DB, secondId)).status, REQUEST_STATUS.CANCELLED);
  assert.equal(await getReceiptByRequestId(env.DB, secondId), null);
  assert.equal(parseCallbackPayload({
    event: "abort",
    request_id: secondId,
    workflow_run_id: secondRow.workflow_run_id,
    status: "failed",
    check_id: "9191",
    error_code: "secret"
  }).ok, false);
});

test("callback claim exposes sanitized exact-head identity; terminal is atomic", async () => {
  const env = makeEnv();
  await seedActiveInstall(env);
  const { fetchImpl } = mockDispatchFetch({ runIdStart: 3000 });
  const created = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload(),
      event: "pull_request",
      deliveryId: "d-cb-flow"
    }),
    { fetchImpl }
  );
  const { request_id: requestId } = await created.json();
  const parent = await getRequestById(env.DB, requestId);
  const wf = parent.workflow_run_id;
  assert.match(parent.workflow_run_url, new RegExp(`^${GITHUB_API_BASE}/`));

  const claimBody = { event: "claim", request_id: String(requestId), workflow_run_id: wf };
  const claimRes = await invoke(env, await signedCallback(env, claimBody, { nonce: "flow-claim" }));
  assert.equal(claimRes.status, 200);
  const claimJson = await claimRes.json();
  assert.equal(claimJson.result, "claimed");
  assert.equal(claimJson.request_id, String(requestId));
  assert.equal(claimJson.receipt_id, parent.receipt_id);
  assert.match(claimJson.receipt_id, /^grr_[0-9a-f]{32}$/);
  assert.equal(claimJson.installation_id, "100");
  assert.equal(claimJson.repository_id, "500");
  assert.equal(claimJson.pull_number, "7");
  assert.equal(claimJson.trigger_kind, TRIGGER_KIND.AUTOMATIC);
  assert.equal(claimJson.trigger_id, "7001");
  assert.equal(claimJson.actor_id, "42");
  assert.equal(claimJson.expected_head_sha, HEAD_A);
  assert.equal(claimJson.policy_version, POLICY_VERSION);
  assert.equal(claimJson.workflow_run_id, wf);
  assert.equal((await getRequestById(env.DB, requestId)).status, REQUEST_STATUS.CLAIMED);

  // Idempotent already_claimed returns the same identity fields.
  const again = await invoke(env, await signedCallback(env, claimBody, { nonce: "flow-claim-2" }));
  const againJson = await again.json();
  assert.equal(againJson.result, "already_claimed");
  assert.equal(againJson.expected_head_sha, HEAD_A);
  assert.equal(againJson.policy_version, POLICY_VERSION);
  assert.equal(againJson.receipt_id, parent.receipt_id);

  // Same nonce + same body → replay
  const claimReplay = await invoke(env, await signedCallback(env, claimBody, { nonce: "flow-claim" }));
  assert.equal((await claimReplay.json()).result, "replay");

  // Same nonce + different body → mismatch
  const claimMismatch = await invoke(
    env,
    await signedCallback(
      env,
      { event: "claim", request_id: String(requestId), workflow_run_id: "1" },
      { nonce: "flow-claim" }
    )
  );
  assert.equal(claimMismatch.status, 409);

  await authorizeClaimedRequest(
    env,
    await getRequestById(env.DB, requestId),
    "flow-authorized"
  );
  const startRes = await invoke(
    env,
    await signedCallback(
      env,
      {
        event: "started",
        request_id: String(requestId),
        workflow_run_id: wf,
        check_id: "777",
        started_at: "2026-03-10T00:00:00.000Z"
      },
      { nonce: "flow-start" }
    )
  );
  assert.equal(startRes.status, 200);
  assert.equal((await getRequestById(env.DB, requestId)).status, REQUEST_STATUS.STARTED);
  assert.equal((await getRequestById(env.DB, requestId)).check_run_id, "777");

  const reverse = await invoke(
    env,
    await signedCallback(env, claimBody, { nonce: "flow-reverse" })
  );
  const reverseJson = await reverse.json();
  assert.ok(
    reverse.status === 200 && reverseJson.result === "already_claimed"
      || reverse.status === 409
  );
  assert.equal((await getRequestById(env.DB, requestId)).status, REQUEST_STATUS.STARTED);

  const startedRow = await getRequestById(env.DB, requestId);
  const terminalBody = await terminalCallbackBody(startedRow, {
    checkId: "777",
    findingCount: 2
  });
  const term = await invoke(env, await signedCallback(env, terminalBody, { nonce: "flow-term" }));
  assert.equal(term.status, 200);
  assert.equal((await getRequestById(env.DB, requestId)).status, REQUEST_STATUS.COMPLETED);
  const receipt = await getReceiptById(env.DB, startedRow.receipt_id);
  assert.equal(receipt.check_id, "777");
  assert.equal(receipt.finding_count, 2);
  assert.equal(receipt.algorithm, "Ed25519");
  assert.equal(receipt.key_id, RECEIPT_KEY_ID);
  assert.deepEqual(JSON.parse(receipt.receipt_json), terminalBody.receipt);
  assert.equal(receipt.review, undefined);
  assert.equal(receipt.findings, undefined);

  // Same-content terminal replay (new nonce) is idempotent via UNIQUE(request_id)+digest.
  const termReplay = await invoke(
    env,
    await signedCallback(env, terminalBody, { nonce: "flow-term-2" })
  );
  assert.equal((await termReplay.json()).result, "replay");

  // Different content for same request conflicts.
  const termConflict = await invoke(
    env,
    await signedCallback(env, await terminalCallbackBody(startedRow, {
      checkId: "777",
      findingCount: 9
    }), { nonce: "flow-term-3" })
  );
  assert.equal(termConflict.status, 409);
});

test("callback accepts the maximum sanitized instruction receipt and rejects over-limit bodies", async () => {
  const env = makeEnv();
  await seedActiveInstall(env);
  const { fetchImpl } = mockDispatchFetch({ runIdStart: 3500 });
  const created = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload(),
      event: "pull_request",
      deliveryId: "d-max-receipt"
    }),
    { fetchImpl }
  );
  const { request_id: requestId } = await created.json();
  const dispatched = await getRequestById(env.DB, requestId);
  await invoke(env, await signedCallback(env, {
    event: "claim",
    request_id: String(requestId),
    workflow_run_id: dispatched.workflow_run_id
  }, { nonce: "max-claim" }));
  await authorizeClaimedRequest(
    env,
    await getRequestById(env.DB, requestId),
    "max-authorized"
  );
  await invoke(env, await signedCallback(env, {
    event: "started",
    request_id: String(requestId),
    workflow_run_id: dispatched.workflow_run_id,
    check_id: "779",
    started_at: "2026-07-28T10:00:00.000Z"
  }, { nonce: "max-start" }));
  const started = await getRequestById(env.DB, requestId);
  const instructions = Array.from({ length: 32 }, (_, index) => ({
    path: `nested-${index}/${"x".repeat(3900 - String(index).length)}/AGENTS.md`,
    blob_sha: (index % 10).toString().repeat(40),
    sha256: (index % 10).toString().repeat(64),
    bytes: 4096
  }));
  // Avoid all-zero SHA, which the receipt contract still treats as a valid Git
  // object identity but is less representative for this boundary fixture.
  instructions[0].blob_sha = "a".repeat(40);
  instructions[0].sha256 = "a".repeat(64);
  const terminalBody = await terminalCallbackBody(started, {
    checkId: "779",
    instructions
  });
  const encodedLength = new TextEncoder().encode(JSON.stringify(terminalBody)).byteLength;
  assert.ok(encodedLength > 120 * 1024);
  assert.ok(encodedLength < MAX_CALLBACK_BYTES);
  const accepted = await invoke(
    env,
    await signedCallback(env, terminalBody, { nonce: "max-terminal" })
  );
  assert.equal(accepted.status, 200);

  const oversized = JSON.stringify({
    event: "claim",
    request_id: "1",
    workflow_run_id: "2",
    padding: "x".repeat(MAX_CALLBACK_BYTES)
  });
  const rejected = await invoke(
    makeEnv(),
    await signedCallback(makeEnv(), oversized, { nonce: "over-limit" })
  );
  assert.equal(rejected.status, 413);
});

test("Worker verifies receipt signature and exact D1 bindings before terminal state", async () => {
  const env = makeEnv();
  const started = await createStartedReview(env, {
    deliveryId: "d-receipt-binding",
    checkId: "991",
    claimNonce: "binding-claim",
    startNonce: "binding-start"
  });
  const wrongHead = await terminalCallbackBody(started, {
    checkId: "991",
    headSha: HEAD_B
  });
  const headResponse = await invoke(
    env,
    await signedCallback(env, wrongHead, { nonce: "binding-wrong-head" })
  );
  assert.equal(headResponse.status, 409);
  assert.equal((await headResponse.json()).error, "receipt_binding_mismatch");

  const valid = await terminalCallbackBody(started, {
    checkId: "991"
  });
  const tampered = structuredClone(valid);
  tampered.receipt.request.repository_id = "999";
  const tamperedResponse = await invoke(
    env,
    await signedCallback(env, tampered, { nonce: "binding-tampered" })
  );
  assert.equal(tamperedResponse.status, 400);
  assert.equal((await tamperedResponse.json()).error, "receipt_digest_mismatch");

  const unsigned = {
    event: "terminal",
    request_id: String(started.request_id),
    workflow_run_id: String(started.workflow_run_id),
    status: "completed",
    check_id: "991",
    receipt: valid.receipt
  };
  const unsignedResponse = await invoke(
    env,
    await signedCallback(env, unsigned, { nonce: "binding-unsigned" })
  );
  assert.equal(unsignedResponse.status, 400);
  assert.equal((await unsignedResponse.json()).error, "unexpected_field");

  const accepted = await invoke(
    env,
    await signedCallback(env, valid, { nonce: "binding-valid" })
  );
  assert.equal(accepted.status, 200);
  assert.equal((await getRequestById(env.DB, started.request_id)).status, REQUEST_STATUS.COMPLETED);
});

test("late terminal callback cannot revive superseded request", async () => {
  const env = makeEnv();
  await seedActiveInstall(env);
  const { fetchImpl } = mockDispatchFetch({ runIdStart: 4000 });

  const first = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload(),
      event: "pull_request",
      deliveryId: "d-late-1"
    }),
    { fetchImpl }
  );
  const j1 = await first.json();
  const row1 = await getRequestById(env.DB, j1.request_id);
  const wf1 = row1.workflow_run_id;

  await invoke(
    env,
    await signedCallback(env, {
      event: "claim",
      request_id: String(j1.request_id),
      workflow_run_id: wf1
    }, { nonce: "late-claim" })
  );
  await authorizeClaimedRequest(
    env,
    await getRequestById(env.DB, j1.request_id),
    "late-authorized"
  );
  await invoke(
    env,
    await signedCallback(env, {
      event: "started",
      request_id: String(j1.request_id),
      workflow_run_id: wf1,
      check_id: "888",
      started_at: "2026-03-10T00:00:00.000Z"
    }, { nonce: "late-start" })
  );

  // The newer head supersedes the in-flight request only after the runner
  // authoritatively validates and authorizes that exact head.
  const second = await invoke(
    env,
    await webhookRequest({
      body: basePrPayload({
        action: "synchronize",
        pull_request: {
          id: "7010",
          number: "7",
          draft: false,
          head: { sha: HEAD_B },
          user: { id: "42", type: "User" }
        }
      }),
      event: "pull_request",
      deliveryId: "d-late-2"
    }),
    { fetchImpl }
  );
  assert.equal(
    (await getRequestById(env.DB, j1.request_id)).status,
    REQUEST_STATUS.STARTED
  );
  const j2 = await second.json();
  const row2 = await getRequestById(env.DB, j2.request_id);
  await invoke(
    env,
    await signedCallback(env, {
      event: "claim",
      request_id: j2.request_id,
      workflow_run_id: row2.workflow_run_id
    }, { nonce: "late-new-claim" })
  );
  await authorizeClaimedRequest(
    env,
    await getRequestById(env.DB, j2.request_id),
    "late-new-authorized"
  );
  assert.equal((await getRequestById(env.DB, j1.request_id)).status, REQUEST_STATUS.SUPERSEDED);

  const lateRow = await getRequestById(env.DB, j1.request_id);
  const lateTerm = await invoke(
    env,
    await signedCallback(env, await terminalCallbackBody(lateRow, {
      checkId: "888",
      findingCount: 0
    }), { nonce: "late-term" })
  );
  assert.equal(lateTerm.status, 409);
  assert.equal((await getRequestById(env.DB, j1.request_id)).status, REQUEST_STATUS.SUPERSEDED);
  assert.equal(await getReceiptById(env.DB, lateRow.receipt_id), null);
});

test("callback parse rejects unsigned legacy terminal payloads and unexpected keys", () => {
  assert.equal(
    parseCallbackPayload({
      event: "claim",
      request_id: "1",
      workflow_run_id: "2",
      findings: []
    }).reason,
    "unexpected_field"
  );
  assert.equal(
    parseCallbackPayload({
      event: "claim",
      request_id: "1",
      workflow_run_id: "2",
      extra: true
    }).reason,
    "unexpected_field"
  );
  assert.equal(
    parseCallbackPayload({
      event: "terminal",
      request_id: "1",
      workflow_run_id: "2",
      status: "completed",
      check_id: "3",
      diff: "@@"
    }).reason,
    "unexpected_field"
  );
  assert.equal(
    parseCallbackPayload({
      event: "terminal",
      request_id: "1",
      workflow_run_id: "2",
      status: "completed",
      check_id: "3",
      receipt: sanitizedReceiptForRequest({
        request_id: "1",
        workflow_run_id: "2",
        check_run_id: "3",
        installation_id: "4",
        repository_id: "5",
        pull_number: "6",
        trigger_kind: "automatic",
        trigger_id: "7",
        actor_id: "8",
        expected_head_sha: HEAD_A
      })
    }).reason,
    "unexpected_field"
  );
});

test("external_id and dispatch URL contracts", () => {
  const encoded = encodeExternalId({
    installationId: HUGE_INSTALL,
    repositoryId: "2",
    pullNumber: "3",
    requestId: "4"
  });
  assert.equal(encoded, `grv1:${HUGE_INSTALL}:2:3:4`);
  assert.deepEqual(parseExternalId(encoded), {
    installationId: HUGE_INSTALL,
    repositoryId: "2",
    pullNumber: "3",
    requestId: "4"
  });
});

test("healthz and unknown routes", async () => {
  const env = makeEnv();
  const health = await invoke(env, new Request("https://worker.example/healthz"));
  assert.equal(health.status, 200);
  assert.equal((await invoke(env, new Request("https://worker.example/nope"))).status, 404);
});
