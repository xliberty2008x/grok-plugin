import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { verifyCallbackSignature256 } from "../apps/grok-review-app/src/crypto-util.mjs";
import { createCallbackClient } from "../apps/grok-review-app/src/actions/callback-client.mjs";
import {
  EXACT_GROK_CLI,
  abortBootstrapFailure,
  assertCredentialBoundary,
  loadBootstrapAbortConfig,
  loadRunnerConfig,
  parseWorkflowInputs,
  runCentralReview
} from "../apps/grok-review-app/src/actions/central-runner.mjs";
import { buildPrReviewPayload } from "../scripts/ci/lib/build-pr-review-payload.mjs";
import { collectRightSideMap } from "../scripts/ci/lib/diff-right-lines.mjs";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE_BASE = "c".repeat(40);
const NEW_HEAD = "d".repeat(40);
const RECEIPT_ID = `grr_${"8".repeat(32)}`;
const RECEIPT_ENVELOPE = Object.freeze({
  alg: "Ed25519",
  kid: "1".repeat(64),
  receipt_sha256: "2".repeat(64),
  signature: "A".repeat(86)
});

function inputs(triggerKind = "automatic") {
  return parseWorkflowInputs({
    request_id: "1001",
    installation_id: "2001",
    repository_id: "3001",
    pull_number: "17",
    trigger_kind: triggerKind,
    trigger_id: "4001",
    actor_id: "5001"
  });
}

function config() {
  return Object.freeze({
    workflowRunId: "6001",
    githubSha: "e".repeat(40),
    runtimeCommit: "e".repeat(40),
    runtimeRoot: "/trusted/runtime",
    runtimeBundleSha256: "f".repeat(64),
    nodeVersion: process.version.slice(1),
    githubAppId: "7001",
    githubAppClientId: "Iv1.test-client",
    githubAppPrivateKey: "PRIVATE APP KEY",
    workerOrigin: "https://worker.example",
    callbackSecret: "callback-secret",
    receiptPrivateKey: "PRIVATE RECEIPT KEY",
    receiptPublicKey: "PUBLIC RECEIPT KEY",
    grokAuthJson: "{\"xai\":{\"key\":\"grok-only\"}}",
    model: "grok-code-fast-1",
    modelVersion: "grok-code-fast-1",
    effort: "high",
    grokCliVersion: EXACT_GROK_CLI.version,
    grokCliSha256: EXACT_GROK_CLI.darwinArm64Sha256,
    grokPackageIntegritySha256: EXACT_GROK_CLI.packageIntegritySha256,
    grokPackageGitCommit: EXACT_GROK_CLI.packageGitCommit
  });
}

function authorityContext(headSha = HEAD) {
  return Object.freeze({
    installationId: "2001",
    repositoryId: "3001",
    owner: "octo-org",
    name: "target-repo",
    fullName: "octo-org/target-repo",
    pullNumber: "17",
    baseSha: BASE,
    headSha,
    reviewHeadSha: headSha,
    baseRef: "main",
    draft: false,
    isFork: true,
    actor: null
  });
}

function packet(headSha = HEAD) {
  const patch = [
    "diff --git a/src/app.js b/src/app.js",
    "index 1111111..2222222 100644",
    "--- a/src/app.js",
    "+++ b/src/app.js",
    "@@ -1,2 +1,2 @@",
    "-const answer = 40;",
    "+const answer = 41;",
    " export { answer };",
    ""
  ].join("\n");
  return Object.freeze({
    identity: Object.freeze({
      owner: "octo-org",
      repository: "target-repo",
      pullNumber: 17,
      baseRef: "main",
      baseTipSha: BASE,
      mergeBaseSha: MERGE_BASE,
      headSha
    }),
    patch: Object.freeze({
      encoding: "utf8",
      content: patch,
      bytes: Buffer.byteLength(patch),
      digest: "3".repeat(64),
      untrusted: true
    }),
    receipt: Object.freeze({
      patchDigest: "3".repeat(64),
      patchBytes: Buffer.byteLength(patch),
      changedFileCount: 1,
      instructions: Object.freeze({
        files: Object.freeze([
          Object.freeze({
            path: "AGENTS.md",
            mode: "100644",
            blobOid: "4".repeat(40),
            bytes: 12,
            sha256: "5".repeat(64)
          })
        ])
      })
    })
  });
}

function claim(triggerKind = "automatic") {
  return {
    result: "claimed",
    request_id: "1001",
    installation_id: "2001",
    repository_id: "3001",
    pull_number: "17",
    trigger_kind: triggerKind,
    trigger_id: "4001",
    actor_id: "5001",
    expected_head_sha: triggerKind === "automatic" ? HEAD : null,
    receipt_id: RECEIPT_ID,
    policy_version: "1",
    workflow_run_id: "6001"
  };
}

function makeHarness(options = {}) {
  const events = [];
  const triggerKind = options.triggerKind ?? "automatic";
  let claimCount = 0;
  let authorityCount = 0;
  let tokenCounter = 0;
  const callback = {
    async claim() {
      claimCount += 1;
      events.push(`claim:${claimCount}`);
      if (options.claimAt) return options.claimAt(claimCount);
      return { ...claim(triggerKind), result: claimCount === 1 ? "claimed" : "already_claimed" };
    },
    async authorized() {
      events.push("callback:authorized");
      if (options.authorizedAt) return options.authorizedAt();
      return { ...claim(triggerKind), result: "authorized" };
    },
    async started(value) {
      events.push("callback:started");
      assert.equal(value.checkId, "8001");
      return { result: "started", request_id: "1001" };
    },
    async abort(value) {
      events.push(`callback:abort:${value.status}:${value.checkId ?? "null"}`);
      options.onAbort?.(value);
      return { result: "aborted", request_id: "1001" };
    },
    async terminal(value) {
      events.push(`callback:terminal:${value.status}`);
      assert.ok(value.receipt);
      assert.deepEqual(value.envelope, RECEIPT_ENVELOPE);
      return {
        result: "accepted",
        receipt_id: value.receipt.receipt_id
      };
    }
  };

  const deps = {
    computeRuntimeBundleDigest({ commit }) {
      events.push(`runtime:${commit}`);
      return config().runtimeBundleSha256;
    },
    attestLocalGrok(value) {
      events.push(`grok:${value.expectedVersion}`);
      assert.equal(value.expectedSha256, EXACT_GROK_CLI.darwinArm64Sha256);
      return {
        binary: "/trusted/grok",
        version: value.expectedVersion,
        sha256: value.expectedSha256,
        size: 129_363_664,
        packageIntegritySha256: EXACT_GROK_CLI.packageIntegritySha256,
        packageGitCommit: EXACT_GROK_CLI.packageGitCommit,
        identityDigest: "6".repeat(64),
        releaseIdentityDigest: "7".repeat(64)
      };
    },
    createAppJwt() {
      events.push("jwt");
      return "app-jwt";
    },
    createGitHubClient({ token }) {
      return { token, request() { throw new Error("network_not_expected"); } };
    },
    async mintInstallationToken({ phase, repositoryId }) {
      tokenCounter += 1;
      const token = `${phase}-token-${tokenCounter}`;
      events.push(`mint:${phase}`);
      return { phase, repositoryId, token };
    },
    async revokeInstallationToken({ token }) {
      events.push(`revoke:${token.split("-token-")[0]}`);
    },
    async fetchAuthoritativeReviewContext(value) {
      authorityCount += 1;
      events.push(`authority:${authorityCount}`);
      if (options.authorityAt) return options.authorityAt(authorityCount, value);
      if (triggerKind === "automatic") {
        assert.equal(value.expectedHeadSha, HEAD);
        assert.equal(value.expectedTriggerId, "4001");
      } else {
        assert.equal(value.expectedHeadSha, null);
      }
      return authorityContext(options.manualHead ?? HEAD);
    },
    async fetchAuthoritativeAppIdentity() {
      events.push("app-identity");
      return {
        appId: "7001",
        appSlug: "grok-review",
        botId: "9001",
        botLogin: "grok-review[bot]"
      };
    },
    async createOrReconcileCheckRun(value) {
      events.push("check:create");
      assert.equal(value.headSha, options.manualHead ?? HEAD);
      return {
        id: "8001",
        status: "in_progress",
        conclusion: null,
        reconciled: false
      };
    },
    async completeCheckRun(value) {
      events.push(`check:complete:${value.conclusion}`);
      options.onComplete?.(value);
      return {
        id: value.checkId,
        status: "completed",
        conclusion: value.conclusion
      };
    },
    async collectCanonicalReviewPacket(value) {
      events.push("collect");
      assert.equal(value.installationToken.startsWith("collect-token-"), true);
      assert.equal(value.baseRef, "main");
      assert.equal(value.headSha, options.manualHead ?? HEAD);
      return packet(options.manualHead ?? HEAD);
    },
    assertCredentialBoundary(_runtimeRoot, activeTokens) {
      events.push(`credential-boundary:${activeTokens.size}`);
      assert.equal(activeTokens.size, 0);
    },
    async runIsolatedModelReview(value) {
      events.push("model");
      const keys = Object.keys(value).sort();
      assert.deepEqual(keys, [
        "cancelRequested",
        "effort",
        "expectedGrokIdentity",
        "grokAuthJson",
        "grokBinary",
        "jobMarker",
        "model",
        "packet"
      ]);
      assert.deepEqual(value.expectedGrokIdentity, {
        sha256: EXACT_GROK_CLI.darwinArm64Sha256,
        identityDigest: "6".repeat(64),
        releaseIdentityDigest: "7".repeat(64)
      });
      assert.equal("githubAppPrivateKey" in value, false);
      assert.equal("callbackSecret" in value, false);
      assert.equal("receiptPrivateKey" in value, false);
      assert.equal(JSON.stringify(value.packet).includes("collect-token"), false);
      if (options.modelError) throw options.modelError;
      return {
        providerLaunched: true,
        providerVersion: EXACT_GROK_CLI.version,
        providerProcess: {
          pid: 12345,
          startToken: "test-start-token",
          processGroupId: 12345
        },
        durationMs: 42,
        review: options.review ?? {
          verdict: "pass",
          summary: "The exact-head change is clean.",
          findings: []
        }
      };
    },
    collectRightSideMap,
    buildPrReviewPayload,
    async signReceipt({ receipt }) {
      events.push("receipt:sign");
      assert.equal(receipt.posting.event, "COMMENT");
      assert.equal(receipt.source.head_sha, options.manualHead ?? HEAD);
      assert.equal(receipt.execution.provider_launched, !options.modelError);
      return { receipt, envelope: RECEIPT_ENVELOPE };
    },
    buildReceiptMarker(receipt, envelope) {
      assert.equal(envelope, RECEIPT_ENVELOPE);
      return `<!-- grok-review-receipt:v1:${receipt.receipt_id}:${"2".repeat(64)}:Ed25519:${"1".repeat(64)}:${"A".repeat(86)} -->`;
    },
    async reconcileReviewByReceiptMarker() {
      events.push("review:reconcile");
      return null;
    },
    async createPendingReview(value) {
      events.push("review:create-pending");
      options.onPending?.(value);
      return { id: "8101", state: "PENDING", commitId: value.headSha };
    },
    async submitPendingReview(value) {
      events.push("review:submit-comment");
      assert.equal(value.reviewId, "8101");
      return { id: "8101", state: "COMMENTED", commitId: value.headSha };
    },
    async deletePendingReview(value) {
      events.push("review:delete-pending");
      assert.equal(value.reviewId, "8101");
    },
    now: (() => {
      let tick = 0;
      return () => new Date(Date.UTC(2026, 6, 28, 12, 0, tick++));
    })()
  };
  return { events, callback, deps };
}

test("workflow inputs preserve decimal strings and reject ambiguous shape", () => {
  assert.equal(inputs().repositoryId, "3001");
  assert.equal(inputs().pullNumberAsNumber, 17);
  assert.throws(
    () => parseWorkflowInputs({
      request_id: "1",
      installation_id: "2",
      repository_id: "3",
      pull_number: "1.0",
      trigger_kind: "automatic",
      trigger_id: "4",
      actor_id: "5"
    }),
    /invalid_pull_number/
  );
  assert.throws(
    () => parseWorkflowInputs({
      request_id: "1",
      installation_id: "2",
      repository_id: "3",
      pull_number: "1",
      trigger_kind: "automatic",
      trigger_id: "4",
      actor_id: "5",
      extra: "6"
    }),
    /invalid_workflow_inputs/
  );
});

test("runtime configuration hard-gates exact commit, Node, and CLI version", () => {
  const env = {
    GITHUB_RUN_ID: "6001",
    GITHUB_SHA: "e".repeat(40),
    GROK_REVIEW_RUNTIME_COMMIT: "e".repeat(40),
    GITHUB_APP_ID: "7001",
    GITHUB_APP_CLIENT_ID: "Iv1.test-client",
    GITHUB_APP_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${"A".repeat(80)}\n-----END PRIVATE KEY-----`,
    GROK_REVIEW_WORKER_ORIGIN: "https://worker.example",
    RUNNER_CALLBACK_SECRET: "x".repeat(32),
    RECEIPT_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${"B".repeat(80)}\n-----END PRIVATE KEY-----`,
    RECEIPT_PUBLIC_KEY: `-----BEGIN PUBLIC KEY-----\n${"C".repeat(80)}\n-----END PUBLIC KEY-----`,
    GROK_AUTH_JSON: "{}",
    GROK_REVIEW_MODEL: "grok-code-fast-1",
    GROK_REVIEW_MODEL_VERSION: "grok-code-fast-1",
    GROK_REVIEW_EFFORT: "high",
    GROK_REVIEW_NODE_VERSION: process.version.slice(1),
    GROK_REVIEW_RUNTIME_BUNDLE_SHA256: "f".repeat(64),
    GROK_CLI_VERSION: EXACT_GROK_CLI.version
  };
  assert.equal(loadRunnerConfig(env, { runtimeRoot: "/trusted/runtime" }).githubAppId, "7001");
  const defaults = { ...env };
  delete defaults.GROK_REVIEW_MODEL;
  delete defaults.GROK_REVIEW_MODEL_VERSION;
  delete defaults.GROK_REVIEW_EFFORT;
  assert.deepEqual(
    {
      model: loadRunnerConfig(defaults, { runtimeRoot: "/trusted/runtime" }).model,
      effort: loadRunnerConfig(defaults, { runtimeRoot: "/trusted/runtime" }).effort
    },
    { model: "grok-code-fast-1", effort: "high" }
  );
  assert.throws(
    () => loadRunnerConfig(
      { ...env, GROK_REVIEW_RUNTIME_COMMIT: "9".repeat(40) },
      { runtimeRoot: "/trusted/runtime" }
    ),
    /runtime_commit_mismatch/
  );
  assert.throws(
    () => loadRunnerConfig(
      { ...env, GROK_CLI_VERSION: "0.2.113" },
      { runtimeRoot: "/trusted/runtime" }
    ),
    /grok_cli_version_mismatch/
  );
});

test("pre-run configuration failure can claim and abort the exact bound workflow", async () => {
  const bootstrap = loadBootstrapAbortConfig({
    INPUT_REQUEST_ID: "1001",
    GITHUB_RUN_ID: "6001",
    GROK_REVIEW_WORKER_ORIGIN: "https://worker.example",
    RUNNER_CALLBACK_SECRET: "x".repeat(32),
    // Full configuration is intentionally absent and must not be needed.
    GROK_CLI_VERSION: "wrong"
  });
  const calls = [];
  const result = await abortBootstrapFailure({
    config: bootstrap,
    callback: {
      async claim(value) {
        calls.push(["claim", value]);
        return {
          result: "claimed",
          request_id: "1001",
          workflow_run_id: "6001"
        };
      },
      async abort(value) {
        calls.push(["abort", value]);
        return { result: "aborted", request_id: "1001" };
      }
    }
  });
  assert.equal(result, true);
  assert.deepEqual(calls, [
    ["claim", { requestId: "1001", workflowRunId: "6001" }],
    ["abort", {
      requestId: "1001",
      workflowRunId: "6001",
      status: "failed",
      checkId: null
    }]
  ]);
  assert.throws(
    () => loadBootstrapAbortConfig({
      INPUT_REQUEST_ID: "01001",
      GITHUB_RUN_ID: "6001",
      GROK_REVIEW_WORKER_ORIGIN: "https://worker.example",
      RUNNER_CALLBACK_SECRET: "x".repeat(32)
    }),
    /bootstrap_abort_unavailable/
  );
});

test("credential boundary actually queries local Git config and fails closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-runner-credential-test-"));
  const prior = new Map();
  try {
    for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "GIT_ASKPASS", "SSH_ASKPASS"]) {
      prior.set(key, process.env[key]);
      delete process.env[key];
    }
    assert.equal(
      spawnSync("git", ["init", "--quiet", root], {
        encoding: "utf8",
        shell: false
      }).status,
      0
    );
    assert.equal(
      spawnSync(
        "git",
        [
          "-C",
          root,
          "config",
          "--local",
          "http.https://github.com/.extraheader",
          "AUTHORIZATION: basic test-credential"
        ],
        { encoding: "utf8", shell: false }
      ).status,
      0
    );
    assert.throws(
      () => assertCredentialBoundary(root, new Set()),
      /checkout_credential_present_before_model/
    );
  } finally {
    for (const [key, value] of prior) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("automatic zero-finding review uses strict token phases and posts COMMENT", async () => {
  let pending;
  let completion;
  const harness = makeHarness({
    onPending(value) {
      pending = value;
    },
    onComplete(value) {
      completion = value;
    }
  });
  const result = await runCentralReview({
    inputs: inputs(),
    config: config(),
    callback: harness.callback,
    cancelRequested: () => false
  }, harness.deps);

  assert.equal(result.status, "completed");
  assert.equal(result.findingCount, 0);
  assert.equal(result.providerLaunched, true);
  assert.match(pending.body, /The exact-head change is clean/);
  assert.deepEqual(pending.comments, []);
  assert.match(completion.summary, new RegExp(`Receipt: \\\`${RECEIPT_ID}\\\``));
  assert.equal(
    completion.summary.match(/<!-- grok-review-receipt:v1:/g)?.length,
    1
  );
  assert.equal(
    pending.body.match(/<!-- grok-review-receipt:v1:[^>]+ -->/)?.[0],
    completion.summary.match(/<!-- grok-review-receipt:v1:[^>]+ -->/)?.[0]
  );
  assert.deepEqual(
    harness.events.filter((event) => event.startsWith("mint:")),
    ["mint:authority", "mint:check", "mint:collect", "mint:post", "mint:check"]
  );
  assert.equal(
    harness.events.filter((event) => event === "jwt").length,
    5,
    "every installation-token phase must use a fresh App JWT"
  );
  assert.ok(
    harness.events.lastIndexOf("jwt") > harness.events.indexOf("model"),
    "post/final-check App JWTs must be minted after the model"
  );
  assert.deepEqual(
    harness.events.filter((event) => event.startsWith("revoke:")),
    ["revoke:authority", "revoke:check", "revoke:collect", "revoke:post", "revoke:check"]
  );
  assert.ok(
    harness.events.indexOf("revoke:collect")
      < harness.events.indexOf("model")
  );
  assert.ok(
    harness.events.indexOf("authority:1")
      < harness.events.indexOf("callback:authorized")
  );
  assert.ok(
    harness.events.indexOf("callback:authorized")
      < harness.events.indexOf("claim:2")
  );
  assert.ok(
    harness.events.indexOf("claim:2")
      < harness.events.indexOf("check:create")
  );
  assert.ok(harness.events.includes("check:complete:neutral"));
  assert.ok(harness.events.includes("callback:terminal:completed"));
});

test("code-owned executable attestation must bind package identity before GitHub access", async () => {
  const harness = makeHarness();
  harness.deps.attestLocalGrok = () => ({
    binary: "/trusted/grok",
    version: EXACT_GROK_CLI.version,
    sha256: EXACT_GROK_CLI.darwinArm64Sha256,
    size: 129_363_664,
    packageIntegritySha256: "0".repeat(64),
    packageGitCommit: EXACT_GROK_CLI.packageGitCommit
  });
  await assert.rejects(
    runCentralReview({
      inputs: inputs(),
      config: config(),
      callback: harness.callback
    }, harness.deps),
    (error) => (
      error.code === "central_runner_failed"
      && error.causeCode === "grok_executable_attestation_mismatch"
    )
  );
  assert.equal(
    harness.events.some((event) => event.startsWith("mint:")),
    false
  );
  assert.ok(harness.events.includes("callback:abort:failed:null"));
});

test("model isolation never executes the mutable discovered Grok path", () => {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
  );
  const source = fs.readFileSync(
    path.join(
      root,
      "apps",
      "grok-review-app",
      "src",
      "actions",
      "model-review.mjs"
    ),
    "utf8"
  );
  assert.doesNotMatch(source, /\bgrokVersion\s*\(/);
  assert.match(source, /grok_source_identity_changed/);
  assert.match(source, /sameExecutableRelease\(source\.attestation, pinned\.attestation\)/);
  assert.ok(
    source.indexOf("grok_materialized_release_mismatch")
      < source.indexOf("authPath = stageAuth")
  );
});

test("validated same-hunk suggestion becomes a native GitHub suggestion", async () => {
  let pending;
  const harness = makeHarness({
    review: {
      verdict: "needs_changes",
      summary: "One exact bug is present.",
      findings: [{
        severity: "high",
        title: "Wrong answer",
        body: "This must be 42.",
        file: "src/app.js",
        line: 1,
        suggestion: {
          startLine: 1,
          endLine: 1,
          replacement: "const answer = 42;"
        }
      }]
    },
    onPending(value) {
      pending = value;
    }
  });
  const result = await runCentralReview({
    inputs: inputs(),
    config: config(),
    callback: harness.callback
  }, harness.deps);
  assert.equal(result.findingCount, 1);
  assert.equal(pending.comments.length, 1);
  assert.equal(pending.comments[0].path, "src/app.js");
  assert.match(pending.comments[0].body, /```suggestion\nconst answer = 42;\n```/);
});

test("manual review snapshots and collects the live current head", async () => {
  const harness = makeHarness({
    triggerKind: "manual_comment",
    manualHead: NEW_HEAD
  });
  const result = await runCentralReview({
    inputs: inputs("manual_comment"),
    config: config(),
    callback: harness.callback
  }, harness.deps);
  assert.equal(result.status, "completed");
  assert.ok(harness.events.includes("collect"));
  assert.ok(
    harness.events.indexOf("authority:1")
      < harness.events.indexOf("callback:authorized")
  );
  assert.ok(
    harness.events.indexOf("callback:authorized")
      < harness.events.indexOf("claim:2")
  );
  assert.ok(
    harness.events.indexOf("claim:2")
      < harness.events.indexOf("check:create")
  );
});

test("unauthorized manual caller stops before check, collection, and Grok", async () => {
  const denied = new Error("actor_permission_rejected");
  denied.code = "actor_permission_rejected";
  const harness = makeHarness({
    triggerKind: "manual_comment",
    authorityAt() {
      throw denied;
    }
  });
  await assert.rejects(
    runCentralReview({
      inputs: inputs("manual_comment"),
      config: config(),
      callback: harness.callback
    }, harness.deps),
    (error) => (
      error.code === "central_runner_failed"
      && error.causeCode === "actor_permission_rejected"
    )
  );
  assert.equal(harness.events.includes("model"), false);
  assert.equal(harness.events.includes("check:create"), false);
  assert.equal(harness.events.includes("collect"), false);
  assert.equal(harness.events.includes("callback:authorized"), false);
  assert.deepEqual(
    harness.events.filter((event) => event.startsWith("mint:")),
    ["mint:authority"]
  );
  assert.ok(harness.events.includes("callback:abort:failed:null"));
});

test("manual authorization supersession fence fails before Check and Grok", async () => {
  const harness = makeHarness({
    triggerKind: "manual_comment",
    authorizedAt() {
      const error = new Error("invalid_state_transition");
      error.code = "invalid_state_transition";
      throw error;
    }
  });
  await assert.rejects(
    runCentralReview({
      inputs: inputs("manual_comment"),
      config: config(),
      callback: harness.callback
    }, harness.deps),
    (error) => (
      error.code === "central_runner_cancelled"
      && error.causeCode === "invalid_state_transition"
    )
  );
  assert.ok(harness.events.includes("callback:authorized"));
  assert.equal(harness.events.includes("check:create"), false);
  assert.equal(harness.events.includes("collect"), false);
  assert.equal(harness.events.includes("model"), false);
  assert.ok(harness.events.includes("callback:abort:cancelled:null"));
});

test("stale automatic expected head never reaches authorization", async () => {
  const stale = new Error("automatic_head_mismatch");
  stale.code = "automatic_head_mismatch";
  const harness = makeHarness({
    authorityAt() {
      throw stale;
    }
  });
  await assert.rejects(
    runCentralReview({
      inputs: inputs(),
      config: config(),
      callback: harness.callback
    }, harness.deps),
    (error) => (
      error.code === "central_runner_cancelled"
      && error.causeCode === "automatic_head_mismatch"
    )
  );
  assert.equal(harness.events.includes("callback:authorized"), false);
  assert.equal(harness.events.includes("check:create"), false);
  assert.equal(harness.events.includes("collect"), false);
  assert.equal(harness.events.includes("model"), false);
  assert.ok(harness.events.includes("callback:abort:cancelled:null"));
});

test("automatic authorization fence rejection stops before Check and Grok", async () => {
  const harness = makeHarness({
    authorizedAt() {
      const error = new Error("invalid_state_transition");
      error.code = "invalid_state_transition";
      throw error;
    }
  });
  await assert.rejects(
    runCentralReview({
      inputs: inputs(),
      config: config(),
      callback: harness.callback
    }, harness.deps),
    (error) => (
      error.code === "central_runner_cancelled"
      && error.causeCode === "invalid_state_transition"
    )
  );
  assert.ok(harness.events.includes("callback:authorized"));
  assert.equal(harness.events.includes("check:create"), false);
  assert.equal(harness.events.includes("collect"), false);
  assert.equal(harness.events.includes("model"), false);
  assert.ok(harness.events.includes("callback:abort:cancelled:null"));
});

test("persisted opaque receipt identity cannot drift across claim fences", async () => {
  const harness = makeHarness({
    claimAt(count) {
      return {
        ...claim(),
        result: count === 1 ? "claimed" : "already_claimed",
        receipt_id: count < 3 ? RECEIPT_ID : `grr_${"9".repeat(32)}`
      };
    }
  });
  const result = await runCentralReview({
    inputs: inputs(),
    config: config(),
    callback: harness.callback
  }, harness.deps);
  assert.equal(result.status, "cancelled");
  assert.equal(result.reason, "superseded_before_submit");
  assert.equal(harness.events.includes("review:create-pending"), false);
});

test("supersession fence before COMMENT deletes the known pending review", async () => {
  const stale = new Error("invalid_state_transition");
  stale.code = "invalid_state_transition";
  let completion;
  const harness = makeHarness({
    claimAt(count) {
      if (count === 4) throw stale;
      return { ...claim(), result: count === 1 ? "claimed" : "already_claimed" };
    },
    onComplete(value) {
      completion = value;
    }
  });
  const result = await runCentralReview({
    inputs: inputs(),
    config: config(),
    callback: harness.callback
  }, harness.deps);
  assert.equal(result.status, "cancelled");
  assert.equal(result.reason, "superseded_before_submit");
  assert.ok(harness.events.includes("review:delete-pending"));
  assert.equal(harness.events.includes("review:submit-comment"), false);
  assert.ok(harness.events.includes("check:complete:cancelled"));
  assert.ok(harness.events.includes("callback:terminal:cancelled"));
  assert.equal(
    completion.summary.match(/<!-- grok-review-receipt:v1:/g)?.length,
    1
  );
});

test("head drift after COMMENT is visible as a cancelled superseded run", async () => {
  const drift = new Error("automatic_head_mismatch");
  drift.code = "automatic_head_mismatch";
  const harness = makeHarness({
    authorityAt(count) {
      if (count === 4) throw drift;
      return authorityContext();
    }
  });
  const result = await runCentralReview({
    inputs: inputs(),
    config: config(),
    callback: harness.callback
  }, harness.deps);
  assert.equal(result.status, "cancelled");
  assert.equal(result.reason, "head_changed_after_submit");
  assert.ok(harness.events.includes("review:submit-comment"));
  assert.ok(harness.events.includes("check:complete:cancelled"));
});

test("model/schema failure completes the known check and sends a signed failed terminal", async () => {
  const schemaError = new Error("E_SCHEMA");
  schemaError.code = "E_SCHEMA";
  let completion;
  const harness = makeHarness({
    modelError: schemaError,
    onComplete(value) {
      completion = value;
    }
  });
  await assert.rejects(
    runCentralReview({
      inputs: inputs(),
      config: config(),
      callback: harness.callback
    }, harness.deps),
    (error) => (
      error.code === "central_runner_failed"
      && error.causeCode === "E_SCHEMA"
    )
  );
  assert.ok(harness.events.includes("check:complete:failure"));
  assert.ok(harness.events.includes("callback:terminal:failed"));
  assert.ok(harness.events.includes("receipt:sign"));
  assert.match(completion.summary, new RegExp(`Receipt: \\\`${RECEIPT_ID}\\\``));
  assert.equal(
    completion.summary.match(/<!-- grok-review-receipt:v1:/g)?.length,
    1
  );
});

test("collection failure completes the check but never fabricates source receipt fields", async () => {
  const collectorError = new Error("E_COLLECTOR_FETCH");
  collectorError.code = "E_COLLECTOR_FETCH";
  let completion;
  const harness = makeHarness({
    onComplete(value) {
      completion = value;
    }
  });
  harness.deps.collectCanonicalReviewPacket = async () => {
    harness.events.push("collect");
    throw collectorError;
  };
  await assert.rejects(
    runCentralReview({
      inputs: inputs(),
      config: config(),
      callback: harness.callback
    }, harness.deps),
    (error) => (
      error.code === "central_runner_failed"
      && error.causeCode === "E_COLLECTOR_FETCH"
    )
  );
  assert.ok(harness.events.includes("check:complete:failure"));
  assert.equal(harness.events.includes("receipt:sign"), false);
  assert.equal(
    harness.events.some((event) => event.startsWith("callback:terminal:")),
    false
  );
  assert.ok(harness.events.includes("callback:abort:failed:8001"));
  assert.doesNotMatch(completion.summary, /grok-review-receipt:v1:/);
  assert.doesNotMatch(completion.summary, /Receipt:/);
});

test("callback client binds timestamp, nonce, and exact body in the HMAC", async () => {
  const secret = "s".repeat(32);
  let observed = null;
  const client = createCallbackClient({
    origin: "https://worker.example",
    secret,
    nowMs: () => 1_800_000_000_000,
    nonce: () => "nonce-fixed",
    async fetchImpl(url, init) {
      observed = { url, init };
      const bytes = new TextEncoder().encode(init.body);
      assert.equal(
        await verifyCallbackSignature256(
          bytes,
          init.headers["x-grok-timestamp"],
          init.headers["x-grok-nonce"],
          init.headers["x-grok-signature"],
          secret
        ),
        true
      );
      return new Response(JSON.stringify(claim()), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  const response = await client.claim({
    requestId: "1001",
    workflowRunId: "6001"
  });
  assert.equal(response.request_id, "1001");
  assert.equal(observed.url, "https://worker.example/internal/callback");
  assert.equal(observed.init.redirect, "manual");
  await client.authorized({
    requestId: "1001",
    workflowRunId: "6001"
  });
  assert.deepEqual(JSON.parse(observed.init.body), {
    event: "authorized",
    request_id: "1001",
    workflow_run_id: "6001"
  });
  await client.terminal({
    requestId: "1001",
    workflowRunId: "6001",
    status: "failed",
    checkId: "8001",
    receipt: { receipt_id: "r" },
    envelope: { alg: "Ed25519" }
  });
  const terminalBody = JSON.parse(observed.init.body);
  assert.equal("finished_at" in terminalBody, false);
  assert.deepEqual(
    Object.keys(terminalBody).sort(),
    [
      "check_id",
      "envelope",
      "event",
      "receipt",
      "request_id",
      "status",
      "workflow_run_id"
    ]
  );
  await client.abort({
    requestId: "1001",
    workflowRunId: "6001",
    status: "failed",
    checkId: null
  });
  assert.deepEqual(JSON.parse(observed.init.body), {
    event: "abort",
    request_id: "1001",
    workflow_run_id: "6001",
    status: "failed",
    check_id: null
  });
});

test("callback retries transient ambiguity with the same body and new nonce only", async () => {
  const bodies = [];
  const nonces = [];
  let attempt = 0;
  const client = createCallbackClient({
    origin: "https://worker.example",
    secret: "r".repeat(32),
    nowMs: () => 1_800_000_000_000,
    nonce: () => `nonce-${++attempt}`,
    async fetchImpl(_url, init) {
      bodies.push(init.body);
      nonces.push(init.headers["x-grok-nonce"]);
      if (attempt === 1) throw new TypeError("ambiguous network failure");
      return new Response(JSON.stringify(claim()), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  const response = await client.claim({
    requestId: "1001",
    workflowRunId: "6001"
  });
  assert.equal(response.request_id, "1001");
  assert.deepEqual(nonces, ["nonce-1", "nonce-2"]);
  assert.equal(bodies[0], bodies[1]);

  let semanticAttempts = 0;
  const semanticClient = createCallbackClient({
    origin: "https://worker.example",
    secret: "r".repeat(32),
    nonce: () => "semantic-nonce",
    async fetchImpl() {
      semanticAttempts += 1;
      return new Response(JSON.stringify({ error: "invalid_state_transition" }), {
        status: 409,
        headers: { "content-type": "application/json" }
      });
    }
  });
  await assert.rejects(
    semanticClient.claim({ requestId: "1001", workflowRunId: "6001" }),
    /invalid_state_transition/
  );
  assert.equal(semanticAttempts, 1);
});

test("workflow is dispatch-only, least-privilege, exact-action pinned, and non-artifact", () => {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
  );
  const workflow = fs.readFileSync(
    path.join(root, ".github", "workflows", "grok-review-app-worker.yml"),
    "utf8"
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /actions\/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5/);
  assert.match(workflow, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /group: grok-review-request-\$\{\{ inputs\.request_id \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(
    workflow,
    /group:\s*grok-review-\$\{\{ inputs\.repository_id \}\}-\$\{\{ inputs\.pull_number \}\}/
  );
  assert.match(workflow, /@xai-official\/grok@0\.2\.112/);
  assert.match(workflow, /git status --porcelain=v1 --untracked-files=all/);
  for (const name of [
    "vars.GROK_REVIEW_APP_ID",
    "vars.GROK_REVIEW_APP_CLIENT_ID",
    "vars.GROK_REVIEW_WORKER_URL",
    "vars.GROK_REVIEW_RUNTIME_COMMIT",
    "vars.GROK_REVIEW_RUNTIME_BUNDLE_SHA256",
    "vars.GROK_CLI_VERSION",
    "vars.RECEIPT_SIGNING_PUBLIC_KEY",
    "secrets.GROK_REVIEW_APP_PRIVATE_KEY",
    "secrets.GROK_AUTH_JSON",
    "secrets.RUNNER_CALLBACK_SECRET",
    "secrets.RECEIPT_SIGNING_PRIVATE_KEY"
  ]) {
    assert.match(workflow, new RegExp(name.replaceAll(".", "\\.")));
  }
  assert.doesNotMatch(workflow, /upload-artifact/);
  assert.doesNotMatch(workflow, /actions\/checkout@v\d/);
});
