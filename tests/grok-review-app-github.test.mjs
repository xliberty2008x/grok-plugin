import assert from "node:assert/strict";
import {
  createPublicKey,
  generateKeyPairSync,
  verify as verifySignature
} from "node:crypto";
import test from "node:test";

import {
  INSTALLATION_TOKEN_PERMISSIONS,
  INSTALLATION_TOKEN_PHASE,
  createAppJwt,
  mintInstallationToken,
  revokeInstallationToken
} from "../apps/grok-review-app/src/actions/github-app-auth.mjs";
import {
  fetchAuthoritativeAppIdentity,
  fetchAuthoritativeReviewContext
} from "../apps/grok-review-app/src/actions/github-authority.mjs";
import {
  GROK_REVIEW_CHECK_ACTION,
  completeCheckRun,
  createOrReconcileCheckRun
} from "../apps/grok-review-app/src/actions/github-checks.mjs";
import {
  createGitHubClient
} from "../apps/grok-review-app/src/actions/github-http.mjs";
import {
  createPendingReview,
  deletePendingReview,
  reconcileReviewByReceiptMarker,
  submitPendingReview
} from "../apps/grok-review-app/src/actions/github-reviews.mjs";
import { signReceipt } from "../apps/grok-review-app/src/actions/receipt.mjs";
import {
  RECEIPT_SCHEMA_VERSION,
  buildReceiptMarker,
  canonicalJson,
  receiptKeyId,
  validateSanitizedReceipt,
  verifyReceiptEnvelope
} from "../apps/grok-review-app/src/receipt-contract.mjs";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE_BASE = "c".repeat(40);
const DIGEST = "d".repeat(64);
const APP_ID = "12345";
const BOT_ID = "56789";

function pemPair(type, options) {
  const pair = generateKeyPairSync(type, options);
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString()
  };
}

function receiptFixture(overrides = {}) {
  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    receipt_id: "receipt-opaque-1",
    request: {
      request_id: "1",
      workflow_run_id: "2",
      check_id: "3",
      installation_id: "4",
      repository_id: "5",
      pull_number: "6"
    },
    trigger: {
      kind: "automatic",
      id: "7",
      actor_id: "8"
    },
    source: {
      base_sha: BASE,
      head_sha: HEAD,
      merge_base_sha: MERGE_BASE,
      diff: {
        sha256: DIGEST,
        bytes: 123,
        files: 2
      }
    },
    instructions: [{
      path: "AGENTS.md",
      blob_sha: "e".repeat(40),
      sha256: "f".repeat(64),
      bytes: 40
    }],
    prompt: {
      version: "review-v1",
      sha256: "1".repeat(64)
    },
    output_schema: {
      version: "review-output-v1",
      sha256: "2".repeat(64)
    },
    runtime: {
      plugin_commit: "3".repeat(40),
      bundle_sha256: "4".repeat(64),
      node_version: "v22.17.0",
      grok_cli_version: "0.2.112",
      grok_cli_sha256: "5".repeat(64),
      grok_package_integrity_sha256: "6".repeat(64),
      grok_package_git_commit: "7".repeat(40)
    },
    model: {
      provider: "xai",
      name: "grok-code-fast",
      version: "2026-07",
      effort: "high"
    },
    execution: {
      provider_launched: true,
      structured_output_valid: true,
      duration_ms: 2500,
      finding_count: 0
    },
    posting: {
      event: "COMMENT"
    },
    created_at: "2026-07-28T10:00:00.000Z",
    ...overrides
  };
}

function staticClient(routes, calls = []) {
  return {
    async request(path, options = {}) {
      calls.push({ path, ...options });
      const key = `${options.method ?? "GET"} ${path}`;
      const route = routes[key] ?? routes[path];
      if (typeof route === "function") return route(path, options);
      if (route === undefined) throw new Error(`missing route ${key}`);
      return { status: options.expectedStatus ?? 200, json: structuredClone(route) };
    }
  };
}

test("fixed GitHub client pins host/version, preserves huge IDs, and rejects alternate origins", async () => {
  const calls = [];
  const client = createGitHubClient({
    token: "ghs_test",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response('{"id":9007199254740993}', {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  const response = await client.request("/repositories/9007199254740993", {
    expectedStatus: 200
  });
  assert.equal(response.json.id, "9007199254740993");
  assert.equal(calls[0].url, "https://api.github.com/repositories/9007199254740993");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers["x-github-api-version"], "2026-03-10");
  assert.equal(calls[0].init.headers.authorization, "Bearer ghs_test");
  await assert.rejects(
    () => client.request("//evil.example/repos/o/r"),
    /invalid_github_api_path/
  );
  await assert.rejects(
    () => client.request("https://evil.example/repos/o/r"),
    /invalid_github_api_path/
  );
});

test("GitHub App JWT uses RS256 client ID claims and rejects malformed or non-RSA keys", () => {
  const rsa = pemPair("rsa", { modulusLength: 2048 });
  const nowMs = 1_800_000_000_000;
  const jwt = createAppJwt({
    clientId: "Iv1.client-id",
    privateKeyPem: rsa.privateKeyPem,
    nowMs
  });
  const [encodedHeader, encodedPayload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(encodedHeader, "base64url")), {
    alg: "RS256",
    typ: "JWT"
  });
  assert.deepEqual(JSON.parse(Buffer.from(encodedPayload, "base64url")), {
    iat: Math.floor(nowMs / 1000) - 60,
    exp: Math.floor(nowMs / 1000) + 540,
    iss: "Iv1.client-id"
  });
  assert.equal(
    verifySignature(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      createPublicKey(rsa.publicKeyPem),
      Buffer.from(signature, "base64url")
    ),
    true
  );
  const ed = pemPair("ed25519");
  assert.throws(
    () => createAppJwt({ clientId: "Iv1.x", privateKeyPem: ed.privateKeyPem, nowMs }),
    /invalid_github_app_private_key_type/
  );
  assert.throws(
    () => createAppJwt({ clientId: "Iv1.x", privateKeyPem: "not pem", nowMs }),
    /invalid_github_app_private_key/
  );
});

test("installation token request keeps >2^53 repository ID raw and enforces phase permissions", async () => {
  const calls = [];
  const nowMs = Date.parse("2026-07-28T10:00:00.000Z");
  const repositoryId = "9007199254740993";
  const token = await mintInstallationToken({
    appClient: staticClient({
      "POST /app/installations/9007199254740995/access_tokens": {
        token: "ghs_exact_repo",
        expires_at: "2026-07-28T11:00:00.000Z",
        repository_selection: "selected",
        permissions: {
          ...INSTALLATION_TOKEN_PERMISSIONS.collect,
          metadata: "read"
        },
        repositories: [{ id: repositoryId }]
      }
    }, calls),
    installationId: "9007199254740995",
    repositoryId,
    phase: INSTALLATION_TOKEN_PHASE.COLLECT,
    nowMs
  });
  assert.equal(token.repositoryId, repositoryId);
  assert.equal(
    calls[0].body,
    `{"repository_ids":[${repositoryId}],"permissions":{"contents":"read","pull_requests":"read"}}`
  );
  assert.ok(!calls[0].body.includes(`"${repositoryId}"`));
});

test("installation token rejects wrong/multiple repositories and extra permissions", async () => {
  const base = {
    token: "ghs_exact_repo",
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    repository_selection: "selected",
    permissions: { pull_requests: "write", metadata: "read" },
    repositories: [{ id: "5" }]
  };
  const mint = (json) => mintInstallationToken({
    appClient: staticClient({
      "POST /app/installations/4/access_tokens": json
    }),
    installationId: "4",
    repositoryId: "5",
    phase: INSTALLATION_TOKEN_PHASE.POST
  });
  await assert.rejects(
    () => mint({ ...base, repositories: [{ id: "9" }] }),
    /installation_token_repository_mismatch/
  );
  await assert.rejects(
    () => mint({ ...base, repositories: [{ id: "5" }, { id: "6" }] }),
    /installation_token_repository_count_mismatch/
  );
  await assert.rejects(
    () => mint({ ...base, permissions: { ...base.permissions, checks: "write" } }),
    /installation_token_permissions_mismatch/
  );
});

test("installation token revocation uses only the token-scoped fixed endpoint", async () => {
  const calls = [];
  await revokeInstallationToken({
    token: "ghs_revoke_me",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/installation/token");
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers.authorization, "Bearer ghs_revoke_me");
});

function authorityRoutes(overrides = {}) {
  return {
    "GET /app/installations/4": {
      id: "4",
      app_id: APP_ID,
      target_id: "99",
      target_type: "Organization",
      suspended_at: null
    },
    "GET /repositories/5": {
      id: "5",
      name: "repo",
      full_name: "owner/repo",
      owner: { id: "99", login: "owner", type: "Organization" },
      disabled: false
    },
    "GET /repos/owner/repo/pulls/6": {
      number: "6",
      id: "7",
      state: "open",
      draft: false,
      base: { sha: BASE, ref: "main", repo: { id: "5" } },
      head: { sha: HEAD, repo: { id: "55" } }
    },
    "GET /user/8": {
      id: "8",
      login: "developer",
      type: "User"
    },
    "GET /repos/owner/repo/collaborators/developer/permission": {
      permission: "write",
      role_name: "maintain",
      user: { id: "8", type: "User" }
    },
    ...overrides
  };
}

test("authority permits fork PRs, fences automatic heads, and snapshots manual current head", async () => {
  const routes = authorityRoutes();
  const appClient = staticClient(routes);
  const repoClient = staticClient(routes);
  const automatic = await fetchAuthoritativeReviewContext({
    appClient,
    repoClient,
    installationId: "4",
    repositoryId: "5",
    pullNumber: "6",
    triggerKind: "automatic",
    actorId: "8",
    expectedHeadSha: HEAD,
    expectedTriggerId: "7",
    expectedAppId: APP_ID
  });
  assert.equal(automatic.isFork, true);
  assert.equal(automatic.pullRef, "refs/pull/6/head");
  assert.equal(automatic.baseRef, "main");
  assert.equal(automatic.actor, null);

  const manual = await fetchAuthoritativeReviewContext({
    appClient,
    repoClient,
    installationId: "4",
    repositoryId: "5",
    pullNumber: "6",
    triggerKind: "manual_comment",
    actorId: "8",
    expectedHeadSha: null,
    expectedAppId: APP_ID
  });
  assert.equal(manual.reviewHeadSha, HEAD);
  assert.equal(manual.actor.permission, "maintain");

  const customRoleRoutes = authorityRoutes({
    "GET /repos/owner/repo/collaborators/developer/permission": {
      permission: "write",
      role_name: "security-engineer",
      user: { id: "8", type: "User" }
    }
  });
  const customRole = await fetchAuthoritativeReviewContext({
    appClient: staticClient(customRoleRoutes),
    repoClient: staticClient(customRoleRoutes),
    installationId: "4",
    repositoryId: "5",
    pullNumber: "6",
    triggerKind: "manual_comment",
    actorId: "8",
    expectedHeadSha: null,
    expectedAppId: APP_ID
  });
  assert.equal(customRole.actor.permission, "write");

  await assert.rejects(
    () => fetchAuthoritativeReviewContext({
      appClient,
      repoClient,
      installationId: "4",
      repositoryId: "5",
      pullNumber: "6",
      triggerKind: "automatic",
      actorId: "8",
      expectedHeadSha: "9".repeat(40),
      expectedAppId: APP_ID
    }),
    /automatic_head_mismatch/
  );
});

test("authority rejects suspended/forged identities, bots, and read access", async () => {
  const baseInput = {
    installationId: "4",
    repositoryId: "5",
    pullNumber: "6",
    triggerKind: "manual_comment",
    actorId: "8",
    expectedAppId: APP_ID
  };
  for (const [routeOverride, expected] of [
    [{
      "GET /app/installations/4": {
        id: "4",
        app_id: APP_ID,
        target_id: "99",
        target_type: "Organization",
        suspended_at: "2026-07-28T00:00:00Z"
      }
    }, /installation_suspended/],
    [{ "GET /repositories/5": { ...authorityRoutes()["GET /repositories/5"], id: "6" } }, /repository_identity_mismatch/],
    [{ "GET /user/8": { id: "8", login: "bot", type: "Bot" } }, /actor_type_rejected/],
    [{
      "GET /repos/owner/repo/collaborators/developer/permission": {
        permission: "read",
        role_name: "read",
        user: { id: "8", type: "User" }
      }
    }, /actor_permission_rejected/]
  ]) {
    const routes = authorityRoutes(routeOverride);
    await assert.rejects(
      () => fetchAuthoritativeReviewContext({
        ...baseInput,
        appClient: staticClient(routes),
        repoClient: staticClient(routes)
      }),
      expected
    );
  }
});

test("App identity resolves bot account from authoritative slug without conflating IDs", async () => {
  const routes = {
    "GET /app": { id: APP_ID, slug: "grok-review" },
    "GET /users/grok-review%5Bbot%5D": {
      id: BOT_ID,
      login: "grok-review[bot]",
      type: "Bot"
    }
  };
  const identity = await fetchAuthoritativeAppIdentity({
    appClient: staticClient(routes),
    repoClient: staticClient(routes),
    expectedAppId: APP_ID
  });
  assert.equal(identity.appId, APP_ID);
  assert.equal(identity.botId, BOT_ID);
  assert.notEqual(identity.botId, identity.appId);
});

test("check creation/reconciliation binds exact App/head/external_id and exact action", async () => {
  const calls = [];
  const externalId = "grv1:4:5:6:1";
  const routes = {
    [`GET /repos/owner/repo/commits/${HEAD}/check-runs?check_name=Grok%20review&filter=all&per_page=100&page=1`]: {
      total_count: "0",
      check_runs: []
    },
    "POST /repos/owner/repo/check-runs": (_path, options) => {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.actions, [GROK_REVIEW_CHECK_ACTION]);
      assert.equal(body.head_sha, HEAD);
      assert.equal(body.external_id, externalId);
      return {
        status: 201,
        json: {
          id: "300",
          name: "Grok review",
          external_id: externalId,
          head_sha: HEAD,
          status: "in_progress",
          conclusion: null,
          app: { id: APP_ID }
        }
      };
    },
    "PATCH /repos/owner/repo/check-runs/300": (_path, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.conclusion, "neutral");
      assert.deepEqual(body.actions, [GROK_REVIEW_CHECK_ACTION]);
      return {
        status: 200,
        json: {
          id: "300",
          name: "Grok review",
          external_id: externalId,
          head_sha: HEAD,
          status: "completed",
          conclusion: "neutral",
          app: { id: APP_ID }
        }
      };
    }
  };
  const client = staticClient(routes, calls);
  const check = await createOrReconcileCheckRun({
    client,
    owner: "owner",
    name: "repo",
    expectedAppId: APP_ID,
    headSha: HEAD,
    externalId,
    startedAt: "2026-07-28T10:00:00.000Z"
  });
  assert.equal(check.id, "300");
  assert.equal(check.reconciled, false);
  const completed = await completeCheckRun({
    client,
    owner: "owner",
    name: "repo",
    expectedAppId: APP_ID,
    headSha: HEAD,
    externalId,
    checkId: "300",
    conclusion: "neutral",
    completedAt: "2026-07-28T10:01:00.000Z",
    title: "Grok review complete",
    summary: "No findings."
  });
  assert.equal(completed.conclusion, "neutral");
});

test("check reconciliation reuses one exact App check and rejects duplicate exact matches", async () => {
  const externalId = "grv1:4:5:6:2";
  const exact = (id) => ({
    id,
    name: "Grok review",
    external_id: externalId,
    head_sha: HEAD,
    status: "in_progress",
    conclusion: null,
    app: { id: APP_ID }
  });
  const path = `GET /repos/owner/repo/commits/${HEAD}/check-runs?check_name=Grok%20review&filter=all&per_page=100&page=1`;
  const reused = await createOrReconcileCheckRun({
    client: staticClient({ [path]: { check_runs: [exact("301")] } }),
    owner: "owner",
    name: "repo",
    expectedAppId: APP_ID,
    headSha: HEAD,
    externalId,
    startedAt: "2026-07-28T10:00:00.000Z"
  });
  assert.equal(reused.id, "301");
  assert.equal(reused.reconciled, true);

  await assert.rejects(
    () => createOrReconcileCheckRun({
      client: staticClient({ [path]: { check_runs: [exact("301"), exact("302")] } }),
      owner: "owner",
      name: "repo",
      expectedAppId: APP_ID,
      headSha: HEAD,
      externalId,
      startedAt: "2026-07-28T10:00:00.000Z"
    }),
    /ambiguous_check_reconciliation/
  );
});

test("check reconciliation scans validated newest-edge pages beyond the first 300 runs", async () => {
  const externalId = "grv1:4:5:6:3";
  const basePath = `/repos/owner/repo/commits/${HEAD}/check-runs`;
  const query = (page) => `${basePath}?check_name=Grok%20review&filter=all&per_page=100&page=${page}`;
  const exact = {
    id: "399",
    name: "Grok review",
    external_id: externalId,
    head_sha: HEAD,
    status: "in_progress",
    conclusion: null,
    app: { id: APP_ID }
  };
  const client = staticClient({
    [`GET ${query(1)}`]: () => ({
      status: 200,
      json: { check_runs: [] },
      headers: new Headers({
        link: `<https://api.github.com${query(2)}>; rel="next", <https://api.github.com/repositories/5/commits/${HEAD}/check-runs?check_name=Grok%20review&filter=all&per_page=100&page=4>; rel="last"`
      })
    }),
    [`GET ${query(3)}`]: { check_runs: [] },
    [`GET ${query(4)}`]: { check_runs: [exact] }
  });
  const reconciled = await createOrReconcileCheckRun({
    client,
    owner: "owner",
    name: "repo",
    expectedAppId: APP_ID,
    headSha: HEAD,
    externalId,
    startedAt: "2026-07-28T10:00:00.000Z"
  });
  assert.equal(reconciled.id, "399");
  assert.equal(reconciled.reconciled, true);
});

test("zero-finding review is created pending, submitted only as COMMENT, and stale pending deletes", async () => {
  const receiptKeys = pemPair("ed25519");
  const signed = await signReceipt({
    receipt: receiptFixture(),
    ...receiptKeys
  });
  const marker = buildReceiptMarker(signed.receipt, signed.envelope);
  const body = `No findings on this exact head.\n\n${marker}`;
  const calls = [];
  const reviewBase = {
    id: "700",
    user: { id: BOT_ID, type: "Bot" },
    commit_id: HEAD,
    body
  };
  const routes = {
    "POST /repos/owner/repo/pulls/6/reviews": (_path, options) => {
      const request = JSON.parse(options.body);
      assert.equal(Object.prototype.hasOwnProperty.call(request, "event"), false);
      assert.deepEqual(request.comments, []);
      return { status: 200, json: { ...reviewBase, state: "PENDING" } };
    },
    "POST /repos/owner/repo/pulls/6/reviews/700/events": (_path, options) => {
      assert.deepEqual(JSON.parse(options.body), { event: "COMMENT" });
      return { status: 200, json: { ...reviewBase, state: "COMMENTED" } };
    },
    "GET /repos/owner/repo/pulls/6/reviews/700": {
      ...reviewBase,
      state: "PENDING"
    },
    "DELETE /repos/owner/repo/pulls/6/reviews/700": () => ({
      status: 204,
      json: null
    })
  };
  const binding = {
    client: staticClient(routes, calls),
    owner: "owner",
    name: "repo",
    pullNumber: "6",
    expectedBotId: BOT_ID,
    headSha: HEAD,
    receiptMarker: marker
  };
  const pending = await createPendingReview({ ...binding, body, comments: [] });
  assert.equal(pending.state, "PENDING");
  const submitted = await submitPendingReview({ ...binding, reviewId: pending.id });
  assert.equal(submitted.state, "COMMENTED");
  await deletePendingReview({ ...binding, reviewId: pending.id });
  assert.ok(calls.some((call) => call.method === "DELETE"));

  await assert.rejects(
    () => createPendingReview({
      ...binding,
      body: `${body}\n${marker}`,
      comments: []
    }),
    /invalid_review_body/
  );
  await assert.rejects(
    () => createPendingReview({
      ...binding,
      body,
      comments: [{
        path: "src/index.mjs",
        line: 1,
        side: "RIGHT",
        body: `finding ${marker}`
      }]
    }),
    /invalid_review_comment/
  );
});

test("review reconciliation is bounded and rejects ambiguous exact markers", async () => {
  const keys = pemPair("ed25519");
  const signed = await signReceipt({ receipt: receiptFixture(), ...keys });
  const marker = buildReceiptMarker(signed.receipt, signed.envelope);
  const review = (id) => ({
    id,
    user: { id: BOT_ID, type: "Bot" },
    commit_id: HEAD,
    body: `summary\n${marker}`,
    state: "PENDING"
  });
  const client = staticClient({
    "GET /repos/owner/repo/pulls/6/reviews?per_page=100&page=1": [
      review("1"),
      review("2")
    ]
  });
  await assert.rejects(
    () => reconcileReviewByReceiptMarker({
      client,
      owner: "owner",
      name: "repo",
      pullNumber: "6",
      expectedBotId: BOT_ID,
      headSha: HEAD,
      receiptMarker: marker
    }),
    /ambiguous_review_reconciliation/
  );
});

test("review reconciliation follows a validated last-page link beyond 300 reviews", async () => {
  const keys = pemPair("ed25519");
  const signed = await signReceipt({ receipt: receiptFixture(), ...keys });
  const marker = buildReceiptMarker(signed.receipt, signed.envelope);
  const basePath = "/repos/owner/repo/pulls/6/reviews";
  const exact = {
    id: "401",
    user: { id: BOT_ID, type: "Bot" },
    commit_id: HEAD,
    body: `summary\n${marker}`,
    state: "PENDING"
  };
  const client = staticClient({
    [`GET ${basePath}?per_page=100&page=1`]: () => ({
      status: 200,
      json: [],
      headers: new Headers({
        link: `<https://api.github.com${basePath}?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/5/pulls/6/reviews?per_page=100&page=4>; rel="last"`
      })
    }),
    [`GET ${basePath}?per_page=100&page=3`]: [],
    [`GET ${basePath}?per_page=100&page=4`]: [exact]
  });
  const reconciled = await reconcileReviewByReceiptMarker({
    client,
    owner: "owner",
    name: "repo",
    pullNumber: "6",
    expectedBotId: BOT_ID,
    headSha: HEAD,
    receiptMarker: marker
  });
  assert.equal(reconciled.id, "401");
});

test("review reconciliation rejects a cross-origin last-page link", async () => {
  const keys = pemPair("ed25519");
  const signed = await signReceipt({ receipt: receiptFixture(), ...keys });
  const marker = buildReceiptMarker(signed.receipt, signed.envelope);
  const client = staticClient({
    "GET /repos/owner/repo/pulls/6/reviews?per_page=100&page=1": () => ({
      status: 200,
      json: [],
      headers: new Headers({
        link: '<https://evil.example/repos/owner/repo/pulls/6/reviews?per_page=100&page=4>; rel="last"'
      })
    })
  });
  await assert.rejects(
    () => reconcileReviewByReceiptMarker({
      client,
      owner: "owner",
      name: "repo",
      pullNumber: "6",
      expectedBotId: BOT_ID,
      headSha: HEAD,
      receiptMarker: marker
    }),
    /invalid_review_pagination/
  );
});

test("receipt canonical signing verifies rotation and rejects tamper, wrong type, and forbidden content", async () => {
  const first = pemPair("ed25519");
  const second = pemPair("ed25519");
  const receipt = receiptFixture();
  const signed = await signReceipt({ receipt, ...first });
  const firstKid = await receiptKeyId(first.publicKeyPem);
  const secondKid = await receiptKeyId(second.publicKeyPem);
  assert.equal(signed.envelope.kid, firstKid);
  assert.equal(
    canonicalJson({ z: 1, a: { y: 2, x: 3 } }),
    '{"a":{"x":3,"y":2},"z":1}'
  );
  const verified = await verifyReceiptEnvelope(
    signed.receipt,
    signed.envelope,
    JSON.stringify({
      [secondKid]: second.publicKeyPem,
      [firstKid]: first.publicKeyPem
    })
  );
  assert.equal(verified.ok, true);
  assert.equal(
    (await verifyReceiptEnvelope(
      {
        ...signed.receipt,
        execution: { ...signed.receipt.execution, finding_count: 1 }
      },
      signed.envelope,
      JSON.stringify({ [firstKid]: first.publicKeyPem })
    )).reason,
    "receipt_digest_mismatch"
  );
  const forbidden = receiptFixture({
    model: {
      ...receipt.model,
      model_output: "secret source"
    }
  });
  assert.equal(validateSanitizedReceipt(forbidden).reason, "forbidden_receipt_content");
  const rsa = pemPair("rsa", { modulusLength: 2048 });
  await assert.rejects(
    () => signReceipt({
      receipt,
      privateKeyPem: rsa.privateKeyPem,
      publicKeyPem: rsa.publicKeyPem
    }),
    /invalid_receipt_private_key_type/
  );
  const marker = buildReceiptMarker(signed.receipt, signed.envelope);
  assert.match(marker, new RegExp(firstKid));
  assert.ok(
    marker.includes(Buffer.from(signed.envelope.signature, "base64url").toString("base64"))
  );
  assert.ok(!marker.slice(4, -3).includes("--"));
});

test("receipt limits exactly match collector bounds", () => {
  assert.equal(
    validateSanitizedReceipt(receiptFixture({
      source: {
        ...receiptFixture().source,
        diff: { sha256: DIGEST, bytes: 8 * 1024 * 1024, files: 3000 }
      }
    })).ok,
    true
  );
  assert.equal(
    validateSanitizedReceipt(receiptFixture({
      source: {
        ...receiptFixture().source,
        diff: { sha256: DIGEST, bytes: 8 * 1024 * 1024 + 1, files: 3000 }
      }
    })).ok,
    false
  );
  assert.equal(
    validateSanitizedReceipt(receiptFixture({
      execution: {
        ...receiptFixture().execution,
        finding_count: 200
      }
    })).ok,
    true
  );
  assert.equal(
    validateSanitizedReceipt(receiptFixture({
      execution: {
        ...receiptFixture().execution,
        finding_count: 201
      }
    })).ok,
    false
  );
});
