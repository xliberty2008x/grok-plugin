/**
 * Re-fetch and bind all GitHub authority used by a review run. Webhook/D1
 * fields are hints until these App-authenticated reads agree.
 */

import { TRIGGER_KIND } from "../constants.mjs";
import {
  canonicalDecimalId,
  canonicalHeadSha,
  isCanonicalDecimalId
} from "../ids.mjs";

function authorityError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function boundedName(value, max = 255) {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= max
    && !/[\u0000-\u001f\u007f/]/.test(value)
  );
}

function safeBranchRef(value) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 255
    || /[\u0000-\u0020\u007f~^:?*[\]\\]/.test(value)
    || value.startsWith("/")
    || value.endsWith("/")
    || value.startsWith(".")
    || value.endsWith(".")
    || value.includes("..")
    || value.includes("@{")
    || value.includes("//")
  ) {
    return false;
  }
  return value.split("/").every(
    (part) => part.length > 0 && part !== "." && part !== ".." && !part.endsWith(".lock")
  );
}

function exactId(value, expected, code) {
  const id = canonicalDecimalId(value);
  if (!id || id !== expected) throw authorityError(code);
  return id;
}

function acceptedPermission(json, actorId) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  if (json.user != null) {
    const embeddedId = canonicalDecimalId(json.user?.id);
    if (!embeddedId || embeddedId !== actorId || json.user?.type !== "User") {
      return null;
    }
  }
  const permission = json.permission;
  const roleName = json.role_name;
  if (permission === "admin") {
    return "admin";
  }
  if (permission === "write" || permission === "maintain") {
    return roleName === "maintain" || permission === "maintain" ? "maintain" : "write";
  }
  return null;
}

/**
 * Resolve the immutable App identity and its generated bot account without a
 * configured login or conflating the App ID with the bot user ID.
 *
 * @param {{
 *   appClient: { request: Function },
 *   repoClient: { request: Function },
 *   expectedAppId: string
 * }} input
 */
export async function fetchAuthoritativeAppIdentity(input) {
  if (
    !input
    || !input.appClient
    || typeof input.appClient.request !== "function"
    || !input.repoClient
    || typeof input.repoClient.request !== "function"
    || !isCanonicalDecimalId(input.expectedAppId)
  ) {
    throw authorityError("invalid_app_identity_input");
  }
  const appResponse = await input.appClient.request("/app", { expectedStatus: 200 });
  const app = appResponse.json;
  if (!app || typeof app !== "object" || Array.isArray(app)) {
    throw authorityError("invalid_app_identity");
  }
  exactId(app.id, input.expectedAppId, "app_identity_mismatch");
  if (
    typeof app.slug !== "string"
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/.test(app.slug)
  ) {
    throw authorityError("invalid_app_slug");
  }
  const botLogin = `${app.slug}[bot]`;
  const botResponse = await input.repoClient.request(
    `/users/${encodeURIComponent(botLogin)}`,
    { expectedStatus: 200 }
  );
  const bot = botResponse.json;
  const botId = canonicalDecimalId(bot?.id);
  if (!botId || bot?.type !== "Bot" || bot?.login !== botLogin) {
    throw authorityError("app_bot_identity_mismatch");
  }
  return Object.freeze({
    appId: input.expectedAppId,
    appSlug: app.slug,
    botId,
    botLogin
  });
}

/**
 * @param {{
 *   appClient: { request: Function },
 *   repoClient: { request: Function },
 *   installationId: string,
 *   repositoryId: string,
 *   pullNumber: string,
 *   triggerKind: "automatic"|"manual_comment"|"check_rerun",
 *   expectedTriggerId?: string|null,
 *   actorId: string,
 *   expectedHeadSha?: string|null,
 *   expectedAppId?: string|null
 * }} input
 */
export async function fetchAuthoritativeReviewContext(input) {
  if (
    !input
    || !isCanonicalDecimalId(input.installationId)
    || !isCanonicalDecimalId(input.repositoryId)
    || !isCanonicalDecimalId(input.pullNumber)
    || !isCanonicalDecimalId(input.actorId)
    || !Object.values(TRIGGER_KIND).includes(input.triggerKind)
    || !input.appClient
    || typeof input.appClient.request !== "function"
    || !input.repoClient
    || typeof input.repoClient.request !== "function"
  ) {
    throw authorityError("invalid_authority_input");
  }
  if (input.expectedAppId != null && !isCanonicalDecimalId(input.expectedAppId)) {
    throw authorityError("invalid_expected_app_id");
  }
  if (input.expectedTriggerId != null && !isCanonicalDecimalId(input.expectedTriggerId)) {
    throw authorityError("invalid_expected_trigger_id");
  }

  const installationResponse = await input.appClient.request(
    `/app/installations/${input.installationId}`,
    { expectedStatus: 200 }
  );
  const installation = installationResponse.json;
  if (!installation || typeof installation !== "object" || Array.isArray(installation)) {
    throw authorityError("invalid_installation_identity");
  }
  exactId(installation.id, input.installationId, "installation_identity_mismatch");
  if (input.expectedAppId != null) {
    exactId(installation.app_id, input.expectedAppId, "installation_app_mismatch");
  }
  if (installation.suspended_at != null) {
    throw authorityError("installation_suspended");
  }
  const targetId = canonicalDecimalId(installation.target_id);
  if (!targetId || !["Organization", "User"].includes(installation.target_type)) {
    throw authorityError("invalid_installation_target");
  }

  const repositoryResponse = await input.repoClient.request(
    `/repositories/${input.repositoryId}`,
    { expectedStatus: 200 }
  );
  const repository = repositoryResponse.json;
  if (!repository || typeof repository !== "object" || Array.isArray(repository)) {
    throw authorityError("invalid_repository_identity");
  }
  exactId(repository.id, input.repositoryId, "repository_identity_mismatch");
  if (
    !boundedName(repository.name)
    || !boundedName(repository.owner?.login)
    || repository.disabled === true
  ) {
    throw authorityError("invalid_repository_identity");
  }
  exactId(repository.owner?.id, targetId, "installation_repository_owner_mismatch");
  if (
    repository.owner?.type !== installation.target_type
    || !["Organization", "User"].includes(repository.owner?.type)
  ) {
    throw authorityError("installation_repository_owner_type_mismatch");
  }
  const owner = repository.owner.login;
  const name = repository.name;
  if (
    typeof repository.full_name !== "string"
    || repository.full_name !== `${owner}/${name}`
  ) {
    throw authorityError("repository_name_mismatch");
  }

  const ownerPart = encodeURIComponent(owner);
  const namePart = encodeURIComponent(name);
  const pullResponse = await input.repoClient.request(
    `/repos/${ownerPart}/${namePart}/pulls/${input.pullNumber}`,
    { expectedStatus: 200 }
  );
  const pull = pullResponse.json;
  if (!pull || typeof pull !== "object" || Array.isArray(pull)) {
    throw authorityError("invalid_pull_request");
  }
  exactId(pull.number, input.pullNumber, "pull_number_mismatch");
  exactId(pull.base?.repo?.id, input.repositoryId, "pull_base_repository_mismatch");
  if (pull.state !== "open") throw authorityError("pull_request_not_open");
  const baseSha = canonicalHeadSha(pull.base?.sha);
  const headSha = canonicalHeadSha(pull.head?.sha);
  const baseRef = pull.base?.ref;
  if (!baseSha || !headSha || !safeBranchRef(baseRef)) {
    throw authorityError("invalid_pull_head");
  }

  const isManual = (
    input.triggerKind === TRIGGER_KIND.MANUAL_COMMENT
    || input.triggerKind === TRIGGER_KIND.CHECK_RERUN
  );
  if (input.triggerKind === TRIGGER_KIND.AUTOMATIC) {
    if (input.expectedTriggerId != null) {
      exactId(pull.id, input.expectedTriggerId, "automatic_trigger_mismatch");
    }
    const expectedHead = canonicalHeadSha(input.expectedHeadSha);
    if (!expectedHead) throw authorityError("automatic_expected_head_missing");
    if (pull.draft === true) throw authorityError("automatic_draft_rejected");
    if (headSha !== expectedHead) throw authorityError("automatic_head_mismatch");
  } else if (!isManual) {
    throw authorityError("invalid_trigger_kind");
  }

  let actor = null;
  let permission = null;
  if (isManual) {
    const actorResponse = await input.repoClient.request(
      `/user/${input.actorId}`,
      { expectedStatus: 200 }
    );
    actor = actorResponse.json;
    if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
      throw authorityError("invalid_actor_identity");
    }
    exactId(actor.id, input.actorId, "actor_identity_mismatch");
    if (actor.type !== "User" || !boundedName(actor.login)) {
      throw authorityError("actor_type_rejected");
    }

    const permissionResponse = await input.repoClient.request(
      `/repos/${ownerPart}/${namePart}/collaborators/${encodeURIComponent(actor.login)}/permission`,
      { expectedStatus: 200 }
    );
    permission = acceptedPermission(permissionResponse.json, input.actorId);
    if (!permission) throw authorityError("actor_permission_rejected");
  }

  const headRepositoryId = canonicalDecimalId(pull.head?.repo?.id);
  const isFork = headRepositoryId == null || headRepositoryId !== input.repositoryId;

  return Object.freeze({
    installationId: input.installationId,
    installationTargetId: targetId,
    repositoryId: input.repositoryId,
    owner,
    name,
    fullName: `${owner}/${name}`,
    pullNumber: input.pullNumber,
    baseSha,
    baseRef,
    headSha,
    reviewHeadSha: headSha,
    pullRef: `refs/pull/${input.pullNumber}/head`,
    draft: pull.draft === true,
    isFork,
    headRepositoryId,
    triggerId: input.expectedTriggerId ?? null,
    actor: actor
      ? Object.freeze({
        id: input.actorId,
        login: actor.login,
        permission
      })
      : null
  });
}

export const authorizeReviewRequest = fetchAuthoritativeReviewContext;
