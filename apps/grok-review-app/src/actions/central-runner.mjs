/**
 * Deterministic central Actions orchestration for the private Grok Review App.
 *
 * All side effects are dependency-injected so the security state machine can
 * be tested without GitHub, Cloudflare, or Grok network access.
 */

import path from "node:path";
import { spawnSync } from "node:child_process";

import { TRIGGER_KIND } from "../constants.mjs";
import { encodeExternalId } from "../external-id.mjs";
import {
  canonicalDecimalId,
  canonicalHeadSha,
  isCanonicalDecimalId
} from "../ids.mjs";
import { RECEIPT_SCHEMA_VERSION, buildReceiptMarker } from "../receipt-contract.mjs";
import { buildPrReviewPayload } from "../../../../scripts/ci/lib/build-pr-review-payload.mjs";
import { collectRightSideMap } from "../../../../scripts/ci/lib/diff-right-lines.mjs";
import {
  createAppJwt,
  INSTALLATION_TOKEN_PHASE,
  mintInstallationToken,
  revokeInstallationToken
} from "./github-app-auth.mjs";
import {
  fetchAuthoritativeAppIdentity,
  fetchAuthoritativeReviewContext
} from "./github-authority.mjs";
import {
  completeCheckRun,
  createOrReconcileCheckRun
} from "./github-checks.mjs";
import { createGitHubClient } from "./github-http.mjs";
import {
  createPendingReview,
  deletePendingReview,
  reconcileReviewByReceiptMarker,
  submitPendingReview
} from "./github-reviews.mjs";
import { signReceipt } from "./receipt.mjs";
import { collectCanonicalReviewPacket } from "./review-packet.mjs";
import {
  APP_REVIEW_CONTRACT,
  attestLocalGrok,
  computeRuntimeBundleDigest,
  runIsolatedModelReview
} from "./model-review.mjs";

export const EXACT_GROK_CLI = Object.freeze({
  version: "0.2.112",
  darwinArm64Sha256: "5cf05fe670b1818561daf7566b580a5de6b81149166499d61072e49640b541a4",
  packageIntegritySha256: "49862ac444a3ca9db560cac29c96b5f2503b4b004a61ac9ac64a558842398143",
  packageGitCommit: "9bbd559437aaef77f2830978da7fcc8f59b07e33"
});

export const WORKFLOW_INPUT_FIELDS = Object.freeze([
  "request_id",
  "installation_id",
  "repository_id",
  "pull_number",
  "trigger_kind",
  "trigger_id",
  "actor_id"
]);

const SHA256_RE = /^[0-9a-f]{64}$/;
const OPAQUE_RECEIPT_ID_RE = /^grr_[0-9a-f]{32}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+:/@-]{0,127}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PRIVATE_KEY_MAX_BYTES = 64 * 1024;

export class CentralRunnerError extends Error {
  constructor(code, options = {}) {
    super(code);
    this.name = "CentralRunnerError";
    this.code = code;
    this.causeCode = options.causeCode ?? null;
  }
}

function runnerError(code, options) {
  return new CentralRunnerError(code, options);
}

function safeErrorCode(error) {
  const value = error?.code;
  return (
    typeof value === "string"
    && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
  )
    ? value
    : "central_runner_failed";
}

function requiredString(
  value,
  code,
  { min = 1, max = 128, pattern = null } = {}
) {
  if (
    typeof value !== "string"
    || value.length < min
    || value.length > max
    || /[\u0000-\u001f\u007f]/.test(value)
    || (pattern && !pattern.test(value))
  ) {
    throw runnerError(code);
  }
  return value;
}

function requiredPrivateKey(value, code) {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") < 64
    || Buffer.byteLength(value, "utf8") > PRIVATE_KEY_MAX_BYTES
    || !value.includes("-----BEGIN ")
  ) {
    throw runnerError(code);
  }
  return value;
}

function requiredJsonSecret(value, code) {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") < 2
    || Buffer.byteLength(value, "utf8") > 1024 * 1024
    || value.includes("\0")
  ) {
    throw runnerError(code);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw runnerError(code);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw runnerError(code);
  }
  return value;
}

function exactHttpsOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw runnerError("invalid_worker_origin");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || url.origin !== value.replace(/\/$/, "")
  ) {
    throw runnerError("invalid_worker_origin");
  }
  return url.origin;
}

/**
 * Workflow values remain canonical decimal strings; they are never coerced
 * through Number except the bounded pull number passed to the Git collector.
 */
export function parseWorkflowInputs(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw runnerError("invalid_workflow_inputs");
  }
  const keys = Object.keys(raw).sort();
  const expected = [...WORKFLOW_INPUT_FIELDS].sort();
  if (
    keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])
  ) {
    throw runnerError("invalid_workflow_inputs");
  }
  for (const field of WORKFLOW_INPUT_FIELDS.filter((field) => field !== "trigger_kind")) {
    if (!isCanonicalDecimalId(raw[field])) {
      throw runnerError(`invalid_${field}`);
    }
  }
  if (!Object.values(TRIGGER_KIND).includes(raw.trigger_kind)) {
    throw runnerError("invalid_trigger_kind");
  }
  const pullNumberAsNumber = Number(raw.pull_number);
  if (
    !Number.isSafeInteger(pullNumberAsNumber)
    || pullNumberAsNumber < 1
    || pullNumberAsNumber > 2_000_000_000
  ) {
    throw runnerError("invalid_pull_number");
  }
  return Object.freeze({
    requestId: raw.request_id,
    installationId: raw.installation_id,
    repositoryId: raw.repository_id,
    pullNumber: raw.pull_number,
    pullNumberAsNumber,
    triggerKind: raw.trigger_kind,
    triggerId: raw.trigger_id,
    actorId: raw.actor_id
  });
}

/**
 * Validate every immutable runtime/security binding before external work.
 */
export function loadRunnerConfig(env, { runtimeRoot = process.cwd() } = {}) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw runnerError("invalid_runner_environment");
  }
  const workflowRunId = canonicalDecimalId(env.GITHUB_RUN_ID);
  const githubSha = canonicalHeadSha(env.GITHUB_SHA);
  const runtimeCommit = canonicalHeadSha(env.GROK_REVIEW_RUNTIME_COMMIT);
  if (!workflowRunId) throw runnerError("invalid_workflow_run_id");
  if (!githubSha || !runtimeCommit || githubSha !== runtimeCommit) {
    throw runnerError("runtime_commit_mismatch");
  }
  if (typeof runtimeRoot !== "string" || !path.isAbsolute(runtimeRoot)) {
    throw runnerError("invalid_runtime_root");
  }
  const githubAppId = canonicalDecimalId(env.GITHUB_APP_ID);
  if (!githubAppId) throw runnerError("invalid_github_app_id");
  const nodeVersion = process.version.replace(/^v/, "");
  const expectedNodeVersion = requiredString(
    env.GROK_REVIEW_NODE_VERSION,
    "invalid_expected_node_version",
    { pattern: /^\d+\.\d+\.\d+$/ }
  );
  if (nodeVersion !== expectedNodeVersion) {
    throw runnerError("node_version_mismatch");
  }
  if (env.GROK_CLI_VERSION !== EXACT_GROK_CLI.version) {
    throw runnerError("grok_cli_version_mismatch");
  }
  const runtimeBundleSha256 = requiredString(
    env.GROK_REVIEW_RUNTIME_BUNDLE_SHA256,
    "invalid_runtime_bundle_digest",
    { max: 64, pattern: SHA256_RE }
  );
  const grokAuthJson = requiredJsonSecret(
    env.GROK_AUTH_JSON,
    "missing_grok_auth"
  );
  const callbackSecret = requiredString(
    env.RUNNER_CALLBACK_SECRET,
    "missing_callback_secret",
    { min: 32, max: 4096 }
  );

  return Object.freeze({
    workflowRunId,
    githubSha,
    runtimeCommit,
    runtimeRoot: path.resolve(runtimeRoot),
    runtimeBundleSha256,
    nodeVersion,
    githubAppId,
    githubAppClientId: requiredString(
      env.GITHUB_APP_CLIENT_ID,
      "invalid_github_app_client_id",
      { pattern: CLIENT_ID_RE }
    ),
    githubAppPrivateKey: requiredPrivateKey(
      env.GITHUB_APP_PRIVATE_KEY,
      "invalid_github_app_private_key"
    ),
    workerOrigin: exactHttpsOrigin(env.GROK_REVIEW_WORKER_ORIGIN),
    callbackSecret,
    receiptPrivateKey: requiredPrivateKey(
      env.RECEIPT_PRIVATE_KEY,
      "invalid_receipt_private_key"
    ),
    receiptPublicKey: requiredPrivateKey(
      env.RECEIPT_PUBLIC_KEY,
      "invalid_receipt_public_key"
    ),
    grokAuthJson,
    model: requiredString(env.GROK_REVIEW_MODEL || "grok-code-fast-1", "invalid_model", {
      pattern: VERSION_RE
    }),
    modelVersion: requiredString(
      env.GROK_REVIEW_MODEL_VERSION
        || env.GROK_REVIEW_MODEL
        || "grok-code-fast-1",
      "invalid_model_version",
      { pattern: VERSION_RE }
    ),
    effort: requiredString(env.GROK_REVIEW_EFFORT || "high", "invalid_effort", {
      pattern: VERSION_RE
    }),
    grokCliVersion: EXACT_GROK_CLI.version,
    grokCliSha256: EXACT_GROK_CLI.darwinArm64Sha256,
    grokPackageIntegritySha256: EXACT_GROK_CLI.packageIntegritySha256,
    grokPackageGitCommit: EXACT_GROK_CLI.packageGitCommit
  });
}

/**
 * Recover only the authenticated callback binding needed to terminalize a
 * dispatched request when full runner configuration fails before the main
 * state machine can claim it. No target identity, App credential, model
 * setting, or receipt key is accepted through this narrow bootstrap path.
 */
export function loadBootstrapAbortConfig(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw runnerError("bootstrap_abort_unavailable");
  }
  const requestId = canonicalDecimalId(env.INPUT_REQUEST_ID);
  const workflowRunId = canonicalDecimalId(env.GITHUB_RUN_ID);
  if (!requestId || !workflowRunId) {
    throw runnerError("bootstrap_abort_unavailable");
  }
  return Object.freeze({
    requestId,
    workflowRunId,
    workerOrigin: exactHttpsOrigin(env.GROK_REVIEW_WORKER_ORIGIN),
    callbackSecret: requiredString(
      env.RUNNER_CALLBACK_SECRET,
      "missing_callback_secret",
      { min: 32, max: 4096 }
    )
  });
}

/**
 * Claim the exact workflow-bound D1 request and immediately fail it without a
 * fabricated receipt. This is used only before runCentralReview starts.
 */
export async function abortBootstrapFailure({ config, callback }) {
  if (
    !config
    || !isCanonicalDecimalId(config.requestId)
    || !isCanonicalDecimalId(config.workflowRunId)
    || !callback
    || typeof callback.claim !== "function"
    || typeof callback.abort !== "function"
  ) {
    throw runnerError("bootstrap_abort_unavailable");
  }
  const claim = await callback.claim({
    requestId: config.requestId,
    workflowRunId: config.workflowRunId
  });
  if (
    !claim
    || !["claimed", "already_claimed"].includes(claim.result)
    || claimValue(claim, "request_id") !== config.requestId
    || claimValue(claim, "workflow_run_id") !== config.workflowRunId
  ) {
    throw runnerError("bootstrap_claim_rejected");
  }
  const result = await callback.abort({
    requestId: config.requestId,
    workflowRunId: config.workflowRunId,
    status: "failed",
    checkId: null
  });
  if (
    !result
    || !["aborted", "already_aborted", "replay"].includes(result.result)
    || claimValue(result, "request_id") !== config.requestId
  ) {
    throw runnerError("bootstrap_abort_rejected");
  }
  return true;
}

function claimValue(claim, key) {
  return claim?.[key] == null ? null : String(claim[key]);
}

function assertClaimBinding(claim, inputs, config, prior = null) {
  if (
    !claim
    || typeof claim !== "object"
    || Array.isArray(claim)
    || !["claimed", "already_claimed"].includes(claim.result)
  ) {
    throw runnerError("claim_rejected");
  }
  const expected = {
    request_id: inputs.requestId,
    installation_id: inputs.installationId,
    repository_id: inputs.repositoryId,
    pull_number: inputs.pullNumber,
    trigger_kind: inputs.triggerKind,
    trigger_id: inputs.triggerId,
    actor_id: inputs.actorId,
    workflow_run_id: config.workflowRunId
  };
  for (const [key, value] of Object.entries(expected)) {
    if (claimValue(claim, key) !== value) {
      throw runnerError("claim_binding_mismatch");
    }
  }
  const expectedHeadSha = claim.expected_head_sha == null
    ? null
    : canonicalHeadSha(claim.expected_head_sha);
  if (claim.expected_head_sha != null && !expectedHeadSha) {
    throw runnerError("claim_head_invalid");
  }
  if (inputs.triggerKind === TRIGGER_KIND.AUTOMATIC && !expectedHeadSha) {
    throw runnerError("automatic_claim_head_missing");
  }
  if (
    typeof claim.receipt_id !== "string"
    || !OPAQUE_RECEIPT_ID_RE.test(claim.receipt_id)
  ) {
    throw runnerError("claim_receipt_id_invalid");
  }
  const binding = Object.freeze({
    ...expected,
    expected_head_sha: expectedHeadSha,
    receipt_id: claim.receipt_id,
    policy_version: claim.policy_version == null
      ? null
      : requiredString(claim.policy_version, "invalid_claim_policy")
  });
  if (prior && JSON.stringify(binding) !== JSON.stringify(prior)) {
    throw runnerError("claim_fence_mismatch");
  }
  return binding;
}

function assertAuthorizedBinding(response, inputs, config, prior) {
  if (
    !response
    || !["authorized", "already_authorized"].includes(response.result)
  ) {
    throw runnerError("authorization_callback_rejected");
  }
  return assertClaimBinding(
    {
      ...response,
      result: response.result === "authorized" ? "claimed" : "already_claimed"
    },
    inputs,
    config,
    prior
  );
}

function assertContext(context, inputs) {
  if (
    !context
    || context.installationId !== inputs.installationId
    || context.repositoryId !== inputs.repositoryId
    || context.pullNumber !== inputs.pullNumber
    || !canonicalHeadSha(context.baseSha)
    || !canonicalHeadSha(context.headSha)
    || typeof context.baseRef !== "string"
    || context.baseRef.length < 1
    || context.baseRef.startsWith("refs/")
  ) {
    throw runnerError("authority_context_mismatch");
  }
}

function sameReviewHead(left, right) {
  return Boolean(
    left
    && right
    && left.repositoryId === right.repositoryId
    && left.pullNumber === right.pullNumber
    && left.baseSha === right.baseSha
    && left.headSha === right.headSha
    && left.baseRef === right.baseRef
  );
}

function isSupersessionError(error) {
  return new Set([
    "invalid_state_transition",
    "workflow_binding_mismatch",
    "claim_rejected",
    "claim_fence_mismatch",
    "automatic_head_mismatch",
    "stale_review_head"
  ]).has(safeErrorCode(error));
}

export function assertCredentialBoundary(runtimeRoot, activeTokens) {
  if (activeTokens.size !== 0) {
    throw runnerError("installation_token_active_before_model");
  }
  for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "GIT_ASKPASS", "SSH_ASKPASS"]) {
    if (process.env[key]) throw runnerError("github_credential_present_before_model");
  }
  const config = spawnSync(
    "git",
    [
      "-C",
      runtimeRoot,
      "config",
      "--local",
      "--get-regexp",
      "^(http\\..*\\.extraheader|credential\\..*)$"
    ],
    {
      encoding: "utf8",
      shell: false,
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: "C",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0"
      }
    }
  );
  if (config.status === 0 && config.stdout.trim()) {
    throw runnerError("checkout_credential_present_before_model");
  }
  if (![0, 1].includes(config.status)) {
    throw runnerError("checkout_credential_check_failed");
  }
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  createAppJwt,
  createGitHubClient,
  mintInstallationToken,
  revokeInstallationToken,
  fetchAuthoritativeAppIdentity,
  fetchAuthoritativeReviewContext,
  createOrReconcileCheckRun,
  completeCheckRun,
  collectCanonicalReviewPacket,
  runIsolatedModelReview,
  collectRightSideMap,
  buildPrReviewPayload,
  signReceipt,
  buildReceiptMarker,
  reconcileReviewByReceiptMarker,
  createPendingReview,
  submitPendingReview,
  deletePendingReview,
  computeRuntimeBundleDigest,
  attestLocalGrok,
  assertCredentialBoundary,
  now: () => new Date(),
  createCallbackClient: null
});

function resolvedDependencies(overrides) {
  const deps = { ...DEFAULT_DEPENDENCIES, ...(overrides || {}) };
  const required = [
    "createAppJwt",
    "createGitHubClient",
    "mintInstallationToken",
    "revokeInstallationToken",
    "fetchAuthoritativeAppIdentity",
    "fetchAuthoritativeReviewContext",
    "createOrReconcileCheckRun",
    "completeCheckRun",
    "collectCanonicalReviewPacket",
    "runIsolatedModelReview",
    "collectRightSideMap",
    "buildPrReviewPayload",
    "signReceipt",
    "buildReceiptMarker",
    "reconcileReviewByReceiptMarker",
    "createPendingReview",
    "submitPendingReview",
    "deletePendingReview",
    "computeRuntimeBundleDigest",
    "attestLocalGrok",
    "assertCredentialBoundary",
    "now"
  ];
  if (required.some((name) => typeof deps[name] !== "function")) {
    throw runnerError("invalid_runner_dependencies");
  }
  return deps;
}

async function usingPhaseToken(state, phase, operation) {
  let minted;
  let phaseAppClient = null;
  let primary = null;
  try {
    const appJwt = state.deps.createAppJwt({
      clientId: state.config.githubAppClientId,
      privateKeyPem: state.config.githubAppPrivateKey
    });
    phaseAppClient = state.deps.createGitHubClient({ token: appJwt });
    state.appClient = phaseAppClient;
    minted = await state.deps.mintInstallationToken({
      appClient: phaseAppClient,
      installationId: state.inputs.installationId,
      repositoryId: state.inputs.repositoryId,
      phase
    });
    if (
      !minted
      || minted.phase !== phase
      || minted.repositoryId !== state.inputs.repositoryId
      || typeof minted.token !== "string"
    ) {
      throw runnerError("installation_token_binding_mismatch");
    }
    state.activeTokens.add(minted.token);
    const client = state.deps.createGitHubClient({ token: minted.token });
    return await operation(client, minted);
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    if (minted?.token) {
      try {
        await state.deps.revokeInstallationToken({ token: minted.token });
        state.activeTokens.delete(minted.token);
      } catch (revokeError) {
        if (!primary) throw revokeError;
      }
    }
    if (state.appClient === phaseAppClient) state.appClient = null;
  }
}

async function claimFence(state) {
  const claim = await state.callback.claim({
    requestId: state.inputs.requestId,
    workflowRunId: state.config.workflowRunId
  });
  return assertClaimBinding(
    claim,
    state.inputs,
    state.config,
    state.claimBinding
  );
}

async function fetchAuthority(state, repoClient) {
  const context = await state.deps.fetchAuthoritativeReviewContext({
    appClient: state.appClient,
    repoClient,
    installationId: state.inputs.installationId,
    repositoryId: state.inputs.repositoryId,
    pullNumber: state.inputs.pullNumber,
    triggerKind: state.inputs.triggerKind,
    expectedTriggerId: state.inputs.triggerId,
    actorId: state.inputs.actorId,
    expectedHeadSha: state.inputs.triggerKind === TRIGGER_KIND.AUTOMATIC
      ? state.claimBinding.expected_head_sha
      : null,
    expectedAppId: state.config.githubAppId
  });
  assertContext(context, state.inputs);
  return context;
}

function buildReceipt({
  state,
  packet,
  checkId,
  modelResult,
  createdAt,
  structuredOutputValid
}) {
  const receiptId = state.claimBinding.receipt_id;
  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    receipt_id: receiptId,
    request: {
      request_id: state.inputs.requestId,
      workflow_run_id: state.config.workflowRunId,
      check_id: checkId,
      installation_id: state.inputs.installationId,
      repository_id: state.inputs.repositoryId,
      pull_number: state.inputs.pullNumber
    },
    trigger: {
      kind: state.inputs.triggerKind,
      id: state.inputs.triggerId,
      actor_id: state.inputs.actorId
    },
    source: {
      base_sha: packet.identity.baseTipSha,
      head_sha: packet.identity.headSha,
      merge_base_sha: packet.identity.mergeBaseSha,
      diff: {
        sha256: packet.receipt.patchDigest,
        bytes: packet.receipt.patchBytes,
        files: packet.receipt.changedFileCount
      }
    },
    instructions: packet.receipt.instructions.files.map((instruction) => ({
      path: instruction.path,
      blob_sha: instruction.blobOid,
      sha256: instruction.sha256,
      bytes: instruction.bytes
    })),
    prompt: {
      version: APP_REVIEW_CONTRACT.promptVersion,
      sha256: APP_REVIEW_CONTRACT.promptSha256
    },
    output_schema: {
      version: APP_REVIEW_CONTRACT.outputSchemaVersion,
      sha256: APP_REVIEW_CONTRACT.outputSchemaSha256
    },
    runtime: {
      plugin_commit: state.config.runtimeCommit,
      bundle_sha256: state.config.runtimeBundleSha256,
      node_version: state.config.nodeVersion,
      grok_cli_version: state.runtimeAttestation.version,
      grok_cli_sha256: state.runtimeAttestation.sha256,
      grok_package_integrity_sha256:
        state.runtimeAttestation.packageIntegritySha256,
      grok_package_git_commit: state.runtimeAttestation.packageGitCommit
    },
    model: {
      provider: "xai",
      name: state.config.model,
      version: state.config.modelVersion,
      effort: state.config.effort
    },
    execution: {
      provider_launched: modelResult?.providerLaunched === true,
      structured_output_valid: structuredOutputValid === true,
      duration_ms: Number.isSafeInteger(modelResult?.durationMs)
        ? Math.max(0, modelResult.durationMs)
        : 0,
      finding_count: Array.isArray(modelResult?.review?.findings)
        ? modelResult.review.findings.length
        : 0
    },
    posting: { event: "COMMENT" },
    created_at: createdAt
  };
}

async function signExecutionReceipt(state, packet, modelResult, structuredOutputValid) {
  const createdAt = state.deps.now().toISOString();
  const receipt = buildReceipt({
    state,
    packet,
    checkId: state.check.id,
    modelResult,
    createdAt,
    structuredOutputValid
  });
  return state.deps.signReceipt({
    receipt,
    privateKeyPem: state.config.receiptPrivateKey,
    publicKeyPem: state.config.receiptPublicKey
  });
}

function ensureReceiptMarker(state) {
  if (state.receiptMarker) return state.receiptMarker;
  if (!state.signedReceipt) return null;
  state.receiptMarker = state.deps.buildReceiptMarker(
    state.signedReceipt.receipt,
    state.signedReceipt.envelope
  );
  return state.receiptMarker;
}

function assertStartedCallbackResponse(response, state) {
  if (
    !response
    || !["started", "already_started"].includes(response.result)
    || claimValue(response, "request_id") !== state.inputs.requestId
  ) {
    throw runnerError("started_callback_rejected");
  }
}

function assertTerminalCallbackResponse(response, state) {
  if (
    !response
    || !["accepted", "replay"].includes(response.result)
    || response.receipt_id !== state.signedReceipt?.receipt?.receipt_id
  ) {
    throw runnerError("terminal_callback_rejected");
  }
}

async function createOrRecoverPending(state, client, payload, marker, botId) {
  let existing = await state.deps.reconcileReviewByReceiptMarker({
    client,
    owner: state.context.owner,
    name: state.context.name,
    pullNumber: state.inputs.pullNumber,
    expectedBotId: botId,
    headSha: state.context.headSha,
    receiptMarker: marker,
    allowedStates: ["PENDING", "COMMENTED"]
  });
  if (existing) return existing;
  try {
    return await state.deps.createPendingReview({
      client,
      owner: state.context.owner,
      name: state.context.name,
      pullNumber: state.inputs.pullNumber,
      expectedBotId: botId,
      headSha: state.context.headSha,
      receiptMarker: marker,
      body: payload.body,
      comments: payload.comments
    });
  } catch (error) {
    existing = await state.deps.reconcileReviewByReceiptMarker({
      client,
      owner: state.context.owner,
      name: state.context.name,
      pullNumber: state.inputs.pullNumber,
      expectedBotId: botId,
      headSha: state.context.headSha,
      receiptMarker: marker,
      allowedStates: ["PENDING", "COMMENTED"]
    });
    if (!existing) throw error;
    return existing;
  }
}

async function submitOrRecover(state, client, pending, marker, botId) {
  try {
    return await state.deps.submitPendingReview({
      client,
      owner: state.context.owner,
      name: state.context.name,
      pullNumber: state.inputs.pullNumber,
      expectedBotId: botId,
      headSha: state.context.headSha,
      receiptMarker: marker,
      reviewId: pending.id
    });
  } catch (error) {
    const reconciled = await state.deps.reconcileReviewByReceiptMarker({
      client,
      owner: state.context.owner,
      name: state.context.name,
      pullNumber: state.inputs.pullNumber,
      expectedBotId: botId,
      headSha: state.context.headSha,
      receiptMarker: marker,
      allowedStates: ["COMMENTED"]
    });
    if (!reconciled || reconciled.id !== pending.id) throw error;
    return reconciled;
  }
}

async function publishReview(state, payload, marker) {
  return usingPhaseToken(state, INSTALLATION_TOKEN_PHASE.POST, async (client) => {
    const preContext = await fetchAuthority(state, client);
    if (!sameReviewHead(preContext, state.context)) {
      throw runnerError("stale_review_head");
    }
    const currentIdentity = await state.deps.fetchAuthoritativeAppIdentity({
      appClient: state.appClient,
      repoClient: client,
      expectedAppId: state.config.githubAppId
    });
    if (currentIdentity.botId !== state.appIdentity.botId) {
      throw runnerError("app_bot_identity_changed");
    }

    // D1 supersession fence immediately before pending review creation.
    await claimFence(state);
    const pending = await createOrRecoverPending(
      state,
      client,
      payload,
      marker,
      currentIdentity.botId
    );
    if (pending.state === "COMMENTED") {
      let postContext = null;
      let automaticDrift = false;
      try {
        postContext = await fetchAuthority(state, client);
      } catch (error) {
        if (safeErrorCode(error) === "automatic_head_mismatch") {
          automaticDrift = true;
        } else {
          throw error;
        }
      }
      return {
        review: pending,
        staleAfterSubmit:
          automaticDrift || !sameReviewHead(postContext, state.context),
        reconciled: true
      };
    }

    let liveContext;
    try {
      // Re-fence as close as possible to the irreversible COMMENT submission,
      // then re-fetch the live exact head.
      await claimFence(state);
      liveContext = await fetchAuthority(state, client);
      if (!sameReviewHead(liveContext, state.context)) {
        throw runnerError("stale_review_head");
      }
    } catch (error) {
      try {
        await state.deps.deletePendingReview({
          client,
          owner: state.context.owner,
          name: state.context.name,
          pullNumber: state.inputs.pullNumber,
          expectedBotId: currentIdentity.botId,
          headSha: state.context.headSha,
          receiptMarker: marker,
          reviewId: pending.id
        });
      } catch {
        // Preserve the primary fence/head error. The known pending review is
        // still not visible; a later exact receipt reconciliation can recover.
      }
      throw error;
    }

    const submitted = await submitOrRecover(
      state,
      client,
      pending,
      marker,
      currentIdentity.botId
    );
    let postContext = null;
    let automaticDrift = false;
    try {
      postContext = await fetchAuthority(state, client);
    } catch (error) {
      if (safeErrorCode(error) === "automatic_head_mismatch") {
        automaticDrift = true;
      } else {
        throw error;
      }
    }
    return {
      review: submitted,
      staleAfterSubmit:
        automaticDrift || !sameReviewHead(postContext, state.context),
      reconciled: false
    };
  });
}

async function completeKnownCheck(state, conclusion, title, summary) {
  const marker = ensureReceiptMarker(state);
  const receiptSummary = marker
    ? [
      summary,
      "",
      `Receipt: \`${state.signedReceipt.receipt.receipt_id}\``,
      "",
      marker
    ].join("\n")
    : summary;
  return usingPhaseToken(state, INSTALLATION_TOKEN_PHASE.CHECK, (client) => (
    state.deps.completeCheckRun({
      client,
      owner: state.context.owner,
      name: state.context.name,
      expectedAppId: state.config.githubAppId,
      headSha: state.context.headSha,
      externalId: state.externalId,
      checkId: state.check.id,
      conclusion,
      completedAt: state.deps.now().toISOString(),
      title,
      summary: receiptSummary
    })
  ));
}

async function abortWithoutReceipt(state, status) {
  if (!state.claimBinding || state.signedReceipt) return false;
  const checkCandidates = state.check
    ? state.startedRecorded
      ? [state.check.id]
      : [state.check.id, null]
    : [null];
  let lastError = null;
  for (const checkId of checkCandidates) {
    try {
      const response = await state.callback.abort({
        requestId: state.inputs.requestId,
        workflowRunId: state.config.workflowRunId,
        status,
        checkId
      });
      if (
        !response
        || !["aborted", "already_aborted", "replay"].includes(response.result)
        || claimValue(response, "request_id") !== state.inputs.requestId
      ) {
        throw runnerError("abort_callback_rejected");
      }
      return true;
    } catch (error) {
      lastError = error;
      // Only the started-callback ambiguity permits trying the alternate
      // claimed/no-check binding. Never broaden another semantic failure.
      if (
        checkId == null
        || state.startedRecorded
        || error?.status !== 409
      ) {
        break;
      }
    }
  }
  throw lastError ?? runnerError("abort_callback_rejected");
}

/**
 * @param {{
 *   inputs: ReturnType<typeof parseWorkflowInputs>,
 *   config: ReturnType<typeof loadRunnerConfig>,
 *   callback: {
 *     claim: Function, authorized: Function, started: Function,
 *     abort: Function, terminal: Function
 *   }
 * }} input
 * @param {Partial<typeof DEFAULT_DEPENDENCIES>} [overrides]
 */
export async function runCentralReview(input, overrides = {}) {
  const deps = resolvedDependencies(overrides);
  const state = {
    deps,
    inputs: input?.inputs,
    config: input?.config,
    callback: input?.callback,
    activeTokens: new Set(),
    appClient: null,
    claimBinding: null,
    context: null,
    appIdentity: null,
    check: null,
    externalId: null,
    packet: null,
    modelResult: null,
    signedReceipt: null,
    receiptMarker: null,
    runtimeAttestation: null,
    startedRecorded: false
  };
  if (
    !state.inputs
    || !state.config
    || !state.callback
    || typeof state.callback.claim !== "function"
    || typeof state.callback.authorized !== "function"
    || typeof state.callback.started !== "function"
    || typeof state.callback.abort !== "function"
    || typeof state.callback.terminal !== "function"
  ) {
    throw runnerError("invalid_central_runner_input");
  }

  let terminalStatus = "failed";
  let checkConclusion = "failure";
  let outcome = null;
  try {
    const initialClaim = await state.callback.claim({
      requestId: state.inputs.requestId,
      workflowRunId: state.config.workflowRunId
    });
    state.claimBinding = assertClaimBinding(
      initialClaim,
      state.inputs,
      state.config
    );

    // After claim election, hard-attest the exact trusted runtime before any
    // GitHub authority or target-repository access.
    const bundleDigest = await deps.computeRuntimeBundleDigest({
      runtimeRoot: state.config.runtimeRoot,
      commit: state.config.runtimeCommit
    });
    if (bundleDigest !== state.config.runtimeBundleSha256) {
      throw runnerError("runtime_bundle_digest_mismatch");
    }
    state.runtimeAttestation = deps.attestLocalGrok({
      expectedVersion: state.config.grokCliVersion,
      expectedSha256: state.config.grokCliSha256
    });
    if (
      state.runtimeAttestation?.version !== state.config.grokCliVersion
      || state.runtimeAttestation?.sha256 !== state.config.grokCliSha256
      || state.runtimeAttestation?.packageIntegritySha256
        !== state.config.grokPackageIntegritySha256
      || state.runtimeAttestation?.packageGitCommit
        !== state.config.grokPackageGitCommit
      || typeof state.runtimeAttestation?.binary !== "string"
      || !path.isAbsolute(state.runtimeAttestation.binary)
      || !Number.isSafeInteger(state.runtimeAttestation?.size)
      || state.runtimeAttestation.size < 1
      || !SHA256_RE.test(state.runtimeAttestation?.identityDigest || "")
      || !SHA256_RE.test(state.runtimeAttestation?.releaseIdentityDigest || "")
    ) {
      throw runnerError("grok_executable_attestation_mismatch");
    }

    await usingPhaseToken(
      state,
      INSTALLATION_TOKEN_PHASE.AUTHORITY,
      async (client) => {
        state.context = await fetchAuthority(state, client);
        state.appIdentity = await deps.fetchAuthoritativeAppIdentity({
          appClient: state.appClient,
          repoClient: client,
          expectedAppId: state.config.githubAppId
        });
      }
    );

    const authorized = await state.callback.authorized({
      requestId: state.inputs.requestId,
      workflowRunId: state.config.workflowRunId
    });
    state.claimBinding = assertAuthorizedBinding(
      authorized,
      state.inputs,
      state.config,
      state.claimBinding
    );
    // Supersession is earned only after live authority (and, for automatic
    // runs, exact expected-head) validation. Re-fence before Check creation.
    await claimFence(state);

    state.externalId = encodeExternalId({
      installationId: state.inputs.installationId,
      repositoryId: state.inputs.repositoryId,
      pullNumber: state.inputs.pullNumber,
      requestId: state.inputs.requestId
    });
    const startedAt = deps.now().toISOString();
    await usingPhaseToken(
      state,
      INSTALLATION_TOKEN_PHASE.CHECK,
      async (client) => {
        state.check = await deps.createOrReconcileCheckRun({
          client,
          owner: state.context.owner,
          name: state.context.name,
          expectedAppId: state.config.githubAppId,
          headSha: state.context.headSha,
          externalId: state.externalId,
          startedAt,
          title: "Grok review started",
          summary: `Reviewing exact head ${state.context.headSha.slice(0, 12)}.`
        });
        const startedResponse = await state.callback.started({
          requestId: state.inputs.requestId,
          workflowRunId: state.config.workflowRunId,
          checkId: state.check.id,
          startedAt
        });
        assertStartedCallbackResponse(startedResponse, state);
        state.startedRecorded = true;
      }
    );

    state.packet = await usingPhaseToken(
      state,
      INSTALLATION_TOKEN_PHASE.COLLECT,
      (_client, token) => deps.collectCanonicalReviewPacket({
        owner: state.context.owner,
        repository: state.context.name,
        pullNumber: state.inputs.pullNumberAsNumber,
        baseRef: state.context.baseRef,
        baseTipSha: state.context.baseSha,
        headSha: state.context.headSha,
        installationToken: token.token
      })
    );
    if (
      state.packet.identity.headSha !== state.context.headSha
      || state.packet.identity.baseTipSha !== state.context.baseSha
    ) {
      throw runnerError("collector_identity_mismatch");
    }

    deps.assertCredentialBoundary(
      state.config.runtimeRoot,
      state.activeTokens
    );
    try {
      state.modelResult = await deps.runIsolatedModelReview({
        packet: state.packet,
        grokAuthJson: state.config.grokAuthJson,
        grokBinary: state.runtimeAttestation.binary,
        expectedGrokIdentity: {
          sha256: state.runtimeAttestation.sha256,
          identityDigest: state.runtimeAttestation.identityDigest,
          releaseIdentityDigest: state.runtimeAttestation.releaseIdentityDigest
        },
        model: state.config.model,
        effort: state.config.effort,
        jobMarker: `app-${state.inputs.requestId}`,
        cancelRequested: input.cancelRequested
      });
    } catch (error) {
      state.modelResult = {
        providerLaunched: error?.providerLaunched === true,
        providerVersion: error?.providerVersion ?? null,
        durationMs: Number.isSafeInteger(error?.providerDurationMs)
          ? Math.max(0, error.providerDurationMs)
          : 0,
        review: null
      };
      throw error;
    }
    if (
      state.modelResult?.providerLaunched !== true
      || state.modelResult.providerVersion !== state.config.grokCliVersion
      || !Number.isSafeInteger(state.modelResult.providerProcess?.pid)
      || state.modelResult.providerProcess.pid < 1
      || typeof state.modelResult.providerProcess?.startToken !== "string"
      || state.modelResult.providerProcess.startToken.length < 1
      || !Number.isSafeInteger(
        state.modelResult.providerProcess?.processGroupId
      )
      || !state.modelResult.review
      || !Array.isArray(state.modelResult.review.findings)
    ) {
      throw runnerError("model_execution_evidence_invalid");
    }

    state.signedReceipt = await signExecutionReceipt(
      state,
      state.packet,
      state.modelResult,
      true
    );
    const marker = ensureReceiptMarker(state);
    const rightSideMap = state.packet.patch.encoding === "utf8"
      ? deps.collectRightSideMap(state.packet.patch.content)
      : deps.collectRightSideMap("");
    const mapped = deps.buildPrReviewPayload({
      job: { result: { review: state.modelResult.review } },
      headSha: state.context.headSha,
      rightSideMap,
      hostReceiptMarker: marker
    });
    if (mapped.skip || mapped.payload?.event !== "COMMENT") {
      throw runnerError("review_payload_invalid");
    }
    if (input.cancelRequested?.()) throw runnerError("E_CANCELLED");

    let publication;
    try {
      publication = await publishReview(state, mapped.payload, marker);
    } catch (error) {
      if (isSupersessionError(error)) {
        terminalStatus = "cancelled";
        checkConclusion = "cancelled";
        outcome = {
          status: "cancelled",
          reason: "superseded_before_submit",
          review: null
        };
      } else {
        throw error;
      }
    }
    if (!outcome) {
      if (publication.staleAfterSubmit) {
        terminalStatus = "cancelled";
        checkConclusion = "cancelled";
        outcome = {
          status: "cancelled",
          reason: "head_changed_after_submit",
          review: publication.review
        };
      } else {
        terminalStatus = "completed";
        checkConclusion = "neutral";
        outcome = {
          status: "completed",
          reason: null,
          review: publication.review
        };
      }
    }

    await completeKnownCheck(
      state,
      checkConclusion,
      checkConclusion === "neutral"
        ? "Grok review completed"
        : "Grok review superseded",
      checkConclusion === "neutral"
        ? `Posted an informational COMMENT review with ${state.modelResult.review.findings.length} finding(s).`
        : "The pull request head changed; this run is non-gating and was marked cancelled."
    );
    const terminalResponse = await state.callback.terminal({
      requestId: state.inputs.requestId,
      workflowRunId: state.config.workflowRunId,
      status: terminalStatus,
      checkId: state.check.id,
      receipt: state.signedReceipt.receipt,
      envelope: state.signedReceipt.envelope
    });
    assertTerminalCallbackResponse(terminalResponse, state);
    return Object.freeze({
      ...outcome,
      checkId: state.check.id,
      receiptId: state.signedReceipt.receipt.receipt_id,
      findingCount: state.modelResult.review.findings.length,
      providerLaunched: true
    });
  } catch (error) {
    const code = safeErrorCode(error);
    const cancelled = isSupersessionError(error) || code === "E_CANCELLED";
    terminalStatus = cancelled ? "cancelled" : "failed";

    // If collection succeeded but model/signing did not, produce an honest
    // signed failure receipt (provider/structured flags remain false).
    if (!state.signedReceipt && state.packet && state.check) {
      try {
        state.signedReceipt = await signExecutionReceipt(
          state,
          state.packet,
          state.modelResult,
          false
        );
        ensureReceiptMarker(state);
      } catch {
        // Preserve primary failure.
      }
    }
    if (state.context && state.check) {
      try {
        await completeKnownCheck(
          state,
          cancelled ? "cancelled" : "failure",
          cancelled ? "Grok review superseded" : "Grok review failed",
          `The central review run stopped with sanitized error code: ${code}.`
        );
      } catch {
        // Preserve primary failure.
      }
    }
    if (state.signedReceipt && state.check) {
      try {
        const terminalResponse = await state.callback.terminal({
          requestId: state.inputs.requestId,
          workflowRunId: state.config.workflowRunId,
          status: terminalStatus,
          checkId: state.check.id,
          receipt: state.signedReceipt.receipt,
          envelope: state.signedReceipt.envelope
        });
        assertTerminalCallbackResponse(terminalResponse, state);
      } catch {
        // Preserve primary failure.
      }
    } else if (!state.signedReceipt) {
      try {
        await abortWithoutReceipt(state, terminalStatus);
      } catch {
        // Preserve primary failure. The Worker retains a claimed/started row
        // for operator reconciliation rather than accepting fabricated source.
      }
    }
    throw runnerError(
      cancelled ? "central_runner_cancelled" : "central_runner_failed",
      { causeCode: code }
    );
  } finally {
    if (state.activeTokens.size !== 0) {
      throw runnerError("installation_token_revocation_unverified");
    }
  }
}
