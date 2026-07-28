/**
 * GitHub App authentication and exact-repository installation token minting.
 * All GitHub numeric identifiers remain canonical decimal strings.
 */

import {
  createPrivateKey,
  sign as nodeSign
} from "node:crypto";

import { isCanonicalDecimalId } from "../ids.mjs";
import { createGitHubClient } from "./github-http.mjs";

export const INSTALLATION_TOKEN_PHASE = Object.freeze({
  AUTHORITY: "authority",
  COLLECT: "collect",
  CHECK: "check",
  POST: "post"
});

export const INSTALLATION_TOKEN_PERMISSIONS = Object.freeze({
  [INSTALLATION_TOKEN_PHASE.AUTHORITY]: Object.freeze({
    pull_requests: "read"
  }),
  [INSTALLATION_TOKEN_PHASE.COLLECT]: Object.freeze({
    contents: "read",
    pull_requests: "read"
  }),
  [INSTALLATION_TOKEN_PHASE.CHECK]: Object.freeze({
    checks: "write"
  }),
  [INSTALLATION_TOKEN_PHASE.POST]: Object.freeze({
    pull_requests: "write"
  })
});

const CLIENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOKEN_RE = /^[^\u0000-\u0020\u007f]{1,4096}$/;
const ISO_MAX_LENGTH = 64;

function authError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function assertRsaPrivateKey(privateKeyPem) {
  if (typeof privateKeyPem !== "string" || privateKeyPem.length > 64 * 1024) {
    throw authError("invalid_github_app_private_key");
  }
  let key;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    throw authError("invalid_github_app_private_key");
  }
  if (key.type !== "private" || key.asymmetricKeyType !== "rsa") {
    throw authError("invalid_github_app_private_key_type");
  }
  const details = key.asymmetricKeyDetails;
  if (details?.modulusLength != null && details.modulusLength < 2048) {
    throw authError("github_app_rsa_key_too_small");
  }
  return key;
}

/**
 * Create the short-lived RS256 bearer used only to mint installation tokens.
 * @param {{ clientId: string, privateKeyPem: string, nowMs?: number }} input
 */
export function createAppJwt(input) {
  if (!input || typeof input.clientId !== "string" || !CLIENT_ID_RE.test(input.clientId)) {
    throw authError("invalid_github_app_client_id");
  }
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw authError("invalid_github_app_jwt_time");
  }
  const key = assertRsaPrivateKey(input.privateKeyPem);
  const now = Math.floor(nowMs / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + 540,
    iss: input.clientId
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  let signature;
  try {
    signature = nodeSign(
      "RSA-SHA256",
      Buffer.from(signingInput, "ascii"),
      key
    ).toString("base64url");
  } catch {
    throw authError("github_app_jwt_sign_failed");
  }
  return `${signingInput}.${signature}`;
}

function exactPermissions(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const expectedKeys = Object.keys(expected);
  for (const key of expectedKeys) {
    if (value[key] !== expected[key]) return false;
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(expected, key)) continue;
    // GitHub grants metadata:read implicitly for installation tokens.
    if (key === "metadata" && value[key] === "read") continue;
    return false;
  }
  return true;
}

function validateTokenResponse(json, input, nowMs) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw authError("invalid_installation_token_response");
  }
  if (typeof json.token !== "string" || !TOKEN_RE.test(json.token)) {
    throw authError("invalid_installation_token");
  }
  if (
    typeof json.expires_at !== "string"
    || json.expires_at.length > ISO_MAX_LENGTH
    || Number.isNaN(Date.parse(json.expires_at))
  ) {
    throw authError("invalid_installation_token_expiry");
  }
  const expiryMs = Date.parse(json.expires_at);
  if (expiryMs <= nowMs + 30_000 || expiryMs > nowMs + 2 * 60 * 60 * 1000) {
    throw authError("invalid_installation_token_expiry");
  }
  if (json.repository_selection !== "selected") {
    throw authError("invalid_installation_repository_selection");
  }
  if (!exactPermissions(json.permissions, input.permissions)) {
    throw authError("installation_token_permissions_mismatch");
  }
  if (!Array.isArray(json.repositories) || json.repositories.length !== 1) {
    throw authError("installation_token_repository_count_mismatch");
  }
  const returnedId = json.repositories[0]?.id;
  if (!isCanonicalDecimalId(returnedId) || returnedId !== input.repositoryId) {
    throw authError("installation_token_repository_mismatch");
  }
  return Object.freeze({
    token: json.token,
    expiresAt: json.expires_at,
    repositoryId: input.repositoryId,
    permissions: Object.freeze({ ...input.permissions }),
    phase: input.phase
  });
}

/**
 * Mint one short-lived token narrowed to exactly one repository and one fixed
 * phase permission set. repository_ids is emitted as a raw JSON integer so an
 * ID above 2^53 is not rounded by JavaScript.
 *
 * @param {{
 *   appClient: ReturnType<typeof createGitHubClient>,
 *   installationId: string,
 *   repositoryId: string,
 *   phase: "authority"|"collect"|"check"|"post",
 *   nowMs?: number
 * }} input
 */
export async function mintInstallationToken(input) {
  if (
    !input
    || !isCanonicalDecimalId(input.installationId)
    || !isCanonicalDecimalId(input.repositoryId)
  ) {
    throw authError("invalid_installation_token_ids");
  }
  const permissions = INSTALLATION_TOKEN_PERMISSIONS[input.phase];
  if (!permissions) throw authError("invalid_installation_token_phase");
  if (!input.appClient || typeof input.appClient.request !== "function") {
    throw authError("invalid_github_app_client");
  }
  const body = `{"repository_ids":[${input.repositoryId}],"permissions":${JSON.stringify(permissions)}}`;
  const response = await input.appClient.request(
    `/app/installations/${input.installationId}/access_tokens`,
    {
      method: "POST",
      body,
      expectedStatus: 201
    }
  );
  return validateTokenResponse(
    response.json,
    {
      repositoryId: input.repositoryId,
      permissions,
      phase: input.phase
    },
    input.nowMs ?? Date.now()
  );
}

/**
 * Revoke the current installation token. The token itself is never returned or
 * included in an error message.
 * @param {{ token: string, fetchImpl?: typeof fetch, timeoutMs?: number }} input
 */
export async function revokeInstallationToken(input) {
  if (!input || typeof input.token !== "string" || !TOKEN_RE.test(input.token)) {
    throw authError("invalid_installation_token");
  }
  const client = createGitHubClient({
    token: input.token,
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs
  });
  await client.request("/installation/token", {
    method: "DELETE",
    expectedStatus: 204
  });
}
