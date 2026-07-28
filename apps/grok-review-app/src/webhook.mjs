/**
 * GitHub webhook admission and event routing.
 * Exact POST /github/webhooks; raw HMAC before JSON; installation/repo gates;
 * semantic request keys; transactional D1 outbox admission.
 */

import {
  ALLOWED_EVENT_ACTIONS,
  CHECK_RERUN_IDENTIFIER,
  MANUAL_REVIEW_COMMAND,
  POLICY_VERSION,
  REQUEST_STATUS,
  TRIGGER_KIND
} from "./constants.mjs";
import {
  isValidSharedSecret,
  sha256Hex,
  verifyGitHubSignature256
} from "./crypto-util.mjs";
import {
  addInstallationRepository,
  admitReviewRequestWithOutbox,
  admitDelivery,
  clearInstallationRepositories,
  deleteInstallation,
  ensureInstallationRow,
  getInstallation,
  getRequestById,
  isInstallationRepoAuthorized,
  isTerminalStatus,
  removeInstallationRepository,
  repairOutboxJobs,
  setInstallationRepositorySelection,
  supersedeInstallationRequestsWithOutbox,
  supersedePrRequestsWithOutbox,
  supersedeRepositoryRequestsWithOutbox,
  updateDeliveryStatus,
  upsertInstallation
} from "./db.mjs";
import { parseExternalId } from "./external-id.mjs";
import {
  errorResponse,
  isAllowedJsonContentType,
  logSafe,
  ok,
  readWebhookBody
} from "./http.mjs";
import {
  buildAutomaticRequestKey,
  buildCheckRerunRequestKey,
  buildManualCommentRequestKey,
  canonicalDecimalId,
  canonicalHeadSha,
  createOpaqueReceiptId,
  parseJsonPreservingIntegerIds
} from "./ids.mjs";
import { processOutbox } from "./outbox.mjs";

/**
 * @param {unknown} sender
 */
export function isBotSender(sender) {
  if (!sender || typeof sender !== "object") return false;
  const s = /** @type {Record<string, unknown>} */ (sender);
  if (s.type === "Bot") return true;
  if (s.bot === true) return true;
  if (typeof s.login === "string" && /\[bot\]$/i.test(s.login)) return true;
  return false;
}

/**
 * @param {unknown} body
 */
export function isExactManualCommand(body) {
  return typeof body === "string" && body.trim() === MANUAL_REVIEW_COMMAND;
}

/**
 * @param {string|null} eventName
 * @param {string|undefined} action
 */
export function isAllowedEventAction(eventName, action) {
  if (!eventName || typeof eventName !== "string") return false;
  const allowed = ALLOWED_EVENT_ACTIONS[eventName];
  if (!allowed) return false;
  if (typeof action !== "string") return false;
  return allowed.includes(action);
}

function parseRepositorySelection(value, fallback = "selected") {
  if (value == null) return fallback;
  return value === "all" || value === "selected" ? value : null;
}

/**
 * Validate exact webhook identity headers (present, non-empty, no whitespace-only).
 * @param {Request} request
 */
export function readWebhookIdentityHeaders(request) {
  const eventName = request.headers.get("x-github-event");
  const deliveryId = request.headers.get("x-github-delivery");
  const signature = request.headers.get("x-hub-signature-256");

  if (typeof eventName !== "string" || eventName.length === 0 || /\s/.test(eventName)) {
    return { ok: false, reason: "missing_headers" };
  }
  // Delivery IDs are UUIDs; require non-empty, no whitespace.
  if (
    typeof deliveryId !== "string"
    || deliveryId.length === 0
    || deliveryId.length > 128
    || /\s/.test(deliveryId)
  ) {
    return { ok: false, reason: "missing_headers" };
  }
  if (typeof signature !== "string" || signature.length === 0) {
    return { ok: false, reason: "missing_headers" };
  }
  return { ok: true, eventName, deliveryId, signature };
}

/**
 * @param {object} env
 * @param {{ installationId: string, repositoryId: string, pullNumber: string, exceptRequestKey?: string }} key
 */
export async function supersedeActivePrRequests(env, key) {
  return supersedePrRequestsWithOutbox(
    env.DB,
    key,
    new Date().toISOString()
  );
}

/**
 * @param {object} env
 * @param {object} params
 */
async function admitAndQueueReview(env, params) {
  // Gate: active installation + selected repository.
  const authorized = await isInstallationRepoAuthorized(
    env.DB,
    params.installationId,
    params.repositoryId
  );
  if (!authorized) {
    logSafe("info", "unauthorized_installation_repo", {
      delivery_id: params.deliveryId
    });
    return { handled: true, result: "unauthorized" };
  }

  const now = new Date().toISOString();
  const requestRow = await admitReviewRequestWithOutbox(
    env.DB,
    {
      requestKey: params.requestKey,
      receiptId: createOpaqueReceiptId(),
      installationId: params.installationId,
      repositoryId: params.repositoryId,
      pullNumber: params.pullNumber,
      triggerKind: params.triggerKind,
      triggerId: params.triggerId,
      actorId: params.actorId,
      status: REQUEST_STATUS.PENDING_DISPATCH,
      deliveryId: params.deliveryId,
      payloadDigest: params.payloadDigest,
      expectedHeadSha: params.expectedHeadSha ?? null,
      policyVersion: params.policyVersion ?? null,
      createdAt: now,
      updatedAt: now
    }
  );

  if (!requestRow) {
    return { handled: true, result: "request_insert_failed" };
  }

  const requestId = String(requestRow.request_id);

  if (requestRow.status === REQUEST_STATUS.DISPATCHED
    || requestRow.status === REQUEST_STATUS.CLAIMED
    || requestRow.status === REQUEST_STATUS.STARTED) {
    return {
      handled: true,
      result: "already_admitted",
      requestId,
      workflowRunId: requestRow.workflow_run_id
    };
  }

  if (isTerminalStatus(requestRow.status)) {
    return {
      handled: true,
      result: "terminal",
      requestId,
      status: requestRow.status
    };
  }

  return { handled: true, result: "queued", requestId };
}

/**
 * @param {object} env
 * @param {object} payload
 * @param {string} action
 * @param {{ deliveryId: string, payloadDigest: string }} meta
 */
async function handlePullRequest(env, payload, action, meta) {
  const pr = payload.pull_request;
  if (!pr || typeof pr !== "object") {
    return { handled: true, result: "malformed" };
  }

  if (pr.draft === true) {
    logSafe("info", "skip_draft_pr", { delivery_id: meta.deliveryId, action });
    return { handled: true, result: "draft_skipped" };
  }

  const installationId = canonicalDecimalId(payload.installation?.id);
  const repositoryId = canonicalDecimalId(payload.repository?.id);
  const pullNumber = canonicalDecimalId(pr.number);
  const triggerId = canonicalDecimalId(pr.id);
  const actorId = canonicalDecimalId(payload.sender?.id ?? pr.user?.id);
  const headSha = canonicalHeadSha(pr.head?.sha);

  if (!installationId || !repositoryId || !pullNumber || !triggerId || !actorId || !headSha) {
    return { handled: true, result: "malformed_ids" };
  }

  // Automatic PR lifecycle events from bots (e.g. Dependabot) are reviewed.
  // Bot rejection applies only to manual commands and check requested_actions.

  const requestKey = buildAutomaticRequestKey({
    installationId,
    repositoryId,
    pullNumber,
    action,
    deliveryId: meta.deliveryId,
    headSha,
    policyVersion: POLICY_VERSION
  });

  return admitAndQueueReview(
    env,
    {
      deliveryId: meta.deliveryId,
      payloadDigest: meta.payloadDigest,
      requestKey,
      installationId,
      repositoryId,
      pullNumber,
      triggerKind: TRIGGER_KIND.AUTOMATIC,
      triggerId,
      actorId,
      expectedHeadSha: headSha,
      policyVersion: POLICY_VERSION
    }
  );
}

/**
 * @param {object} env
 * @param {object} payload
 * @param {{ deliveryId: string, payloadDigest: string }} meta
 */
async function handleIssueComment(env, payload, meta) {
  const comment = payload.comment;
  const issue = payload.issue;
  if (!comment || !issue) {
    return { handled: true, result: "malformed" };
  }

  if (!issue.pull_request) {
    return { handled: true, result: "not_pull_request" };
  }

  if (isBotSender(payload.sender) || isBotSender(comment.user)) {
    return { handled: true, result: "bot_rejected" };
  }

  if (!isExactManualCommand(comment.body)) {
    return { handled: true, result: "command_ignored" };
  }

  const installationId = canonicalDecimalId(payload.installation?.id);
  const repositoryId = canonicalDecimalId(payload.repository?.id);
  const pullNumber = canonicalDecimalId(issue.number);
  const commentId = canonicalDecimalId(comment.id);
  const actorId = canonicalDecimalId(payload.sender?.id ?? comment.user?.id);

  if (!installationId || !repositoryId || !pullNumber || !commentId || !actorId) {
    return { handled: true, result: "malformed_ids" };
  }

  // Optional head from issue payload is not always present; manual binds comment ID.
  const requestKey = buildManualCommentRequestKey({
    installationId,
    repositoryId,
    commentId
  });

  return admitAndQueueReview(
    env,
    {
      deliveryId: meta.deliveryId,
      payloadDigest: meta.payloadDigest,
      requestKey,
      installationId,
      repositoryId,
      pullNumber,
      triggerKind: TRIGGER_KIND.MANUAL_COMMENT,
      triggerId: commentId,
      actorId,
      expectedHeadSha: null,
      policyVersion: null
    }
  );
}

/**
 * @param {object} env
 * @param {object} payload
 * @param {{ deliveryId: string, payloadDigest: string }} meta
 */
async function handleCheckRun(env, payload, meta) {
  const checkRun = payload.check_run;
  const requestedAction = payload.requested_action;
  if (!checkRun || !requestedAction) {
    return { handled: true, result: "malformed" };
  }

  if (requestedAction.identifier !== CHECK_RERUN_IDENTIFIER) {
    return { handled: true, result: "foreign_action" };
  }

  const configuredAppId = canonicalDecimalId(env.GITHUB_APP_ID);
  const checkAppId = canonicalDecimalId(checkRun.app?.id);
  if (!configuredAppId || !checkAppId || configuredAppId !== checkAppId) {
    return { handled: true, result: "foreign_check" };
  }

  const parsed = parseExternalId(checkRun.external_id);
  if (!parsed) {
    return { handled: true, result: "invalid_external_id" };
  }

  const installationId = canonicalDecimalId(payload.installation?.id);
  const payloadRepositoryId = canonicalDecimalId(payload.repository?.id);
  const actorId = canonicalDecimalId(payload.sender?.id);
  const checkRunId = canonicalDecimalId(checkRun.id);

  if (!installationId || !payloadRepositoryId || !actorId || !checkRunId) {
    return { handled: true, result: "malformed_ids" };
  }

  if (parsed.installationId !== installationId) {
    return { handled: true, result: "installation_mismatch" };
  }

  // Bind to payload repository — reject forged pairings.
  if (parsed.repositoryId !== payloadRepositoryId) {
    return { handled: true, result: "repository_mismatch" };
  }

  // D1-mapped check-run identity on the parent request.
  const parent = await getRequestById(env.DB, parsed.requestId);
  if (!parent) {
    return { handled: true, result: "parent_request_missing" };
  }
  if (String(parent.installation_id) !== installationId
    || String(parent.repository_id) !== payloadRepositoryId
    || String(parent.pull_number) !== parsed.pullNumber) {
    return { handled: true, result: "parent_binding_mismatch" };
  }
  if (parent.check_run_id == null || String(parent.check_run_id) !== checkRunId) {
    return { handled: true, result: "check_identity_mismatch" };
  }

  if (isBotSender(payload.sender)) {
    return { handled: true, result: "bot_rejected" };
  }

  const requestKey = buildCheckRerunRequestKey({
    installationId,
    repositoryId: payloadRepositoryId,
    checkRunId,
    deliveryId: meta.deliveryId
  });

  return admitAndQueueReview(
    env,
    {
      deliveryId: meta.deliveryId,
      payloadDigest: meta.payloadDigest,
      requestKey,
      installationId,
      repositoryId: payloadRepositoryId,
      pullNumber: parsed.pullNumber,
      triggerKind: TRIGGER_KIND.CHECK_RERUN,
      triggerId: checkRunId,
      actorId,
      expectedHeadSha: null,
      policyVersion: null
    }
  );
}

/**
 * @param {object} env
 * @param {object} payload
 * @param {string} action
 */
async function handleInstallation(env, payload, action) {
  const installationId = canonicalDecimalId(payload.installation?.id);
  if (!installationId) {
    return { handled: true, result: "malformed" };
  }
  const now = new Date().toISOString();
  const accountId = canonicalDecimalId(payload.installation?.account?.id);
  const accountType =
    typeof payload.installation?.account?.type === "string"
      ? payload.installation.account.type
      : null;
  const existing = await getInstallation(env.DB, installationId);
  const repositorySelection = parseRepositorySelection(
    payload.installation?.repository_selection,
    existing?.repository_selection ?? "selected"
  );
  if (!repositorySelection) {
    return { handled: true, result: "invalid_repository_selection" };
  }

  if (action === "deleted") {
    await supersedeInstallationRequestsWithOutbox(env.DB, installationId, now);
    await deleteInstallation(env.DB, installationId);
    return { handled: true, result: "installation_deleted" };
  }

  if (action === "suspend") {
    await upsertInstallation(env.DB, {
      installationId,
      accountId,
      accountType,
      repositorySelection,
      suspended: 1,
      createdAt: now,
      updatedAt: now
    });
    await supersedeInstallationRequestsWithOutbox(env.DB, installationId, now);
    return { handled: true, result: "installation_suspended" };
  }

  if (action === "unsuspend" || action === "created" || action === "new_permissions_accepted") {
    await upsertInstallation(env.DB, {
      installationId,
      accountId,
      accountType,
      repositorySelection,
      suspended: 0,
      createdAt: now,
      updatedAt: now
    });

    if (
      repositorySelection === "selected"
      && (action === "created" || existing?.repository_selection === "all")
    ) {
      await clearInstallationRepositories(env.DB, installationId);
    }
    const repos = Array.isArray(payload.repositories) ? payload.repositories : [];
    for (const repo of repos) {
      const repositoryId = canonicalDecimalId(repo?.id);
      if (repositoryId) {
        await addInstallationRepository(env.DB, installationId, repositoryId);
      }
    }
    if (existing?.repository_selection === "all" && repositorySelection === "selected") {
      await repairOutboxJobs(env.DB, now);
    }
    return { handled: true, result: "installation_upserted" };
  }

  return { handled: true, result: "ignored" };
}

/**
 * Repository add/remove must never unsuspend a suspended installation.
 * @param {object} env
 * @param {object} payload
 * @param {string} action
 */
async function handleInstallationRepositories(env, payload, action) {
  const installationId = canonicalDecimalId(payload.installation?.id);
  if (!installationId) {
    return { handled: true, result: "malformed" };
  }

  const now = new Date().toISOString();
  const accountId = canonicalDecimalId(payload.installation?.account?.id);
  const accountType =
    typeof payload.installation?.account?.type === "string"
      ? payload.installation.account.type
      : null;
  const existing = await getInstallation(env.DB, installationId);
  const repositorySelection = parseRepositorySelection(
    payload.repository_selection ?? payload.installation?.repository_selection,
    existing?.repository_selection ?? "selected"
  );
  if (!repositorySelection) {
    return { handled: true, result: "invalid_repository_selection" };
  }

  // Insert-only with suspended=1 if missing. Never flip suspended to 0 here.
  await ensureInstallationRow(env.DB, {
    installationId,
    accountId,
    accountType,
    repositorySelection,
    suspended: 1,
    createdAt: now,
    updatedAt: now
  });

  if (existing && existing.repository_selection !== repositorySelection) {
    if (existing.repository_selection === "all" && repositorySelection === "selected") {
      await clearInstallationRepositories(env.DB, installationId);
    }
    await setInstallationRepositorySelection(
      env.DB,
      installationId,
      repositorySelection,
      now
    );
  }

  if (action === "added") {
    const added = Array.isArray(payload.repositories_added) ? payload.repositories_added : [];
    for (const repo of added) {
      const repositoryId = canonicalDecimalId(repo?.id);
      if (repositoryId && repositorySelection === "selected") {
        await addInstallationRepository(env.DB, installationId, repositoryId);
      }
    }
    if (existing?.repository_selection === "all" && repositorySelection === "selected") {
      await repairOutboxJobs(env.DB, now);
    }
    return { handled: true, result: "repos_added" };
  }

  if (action === "removed") {
    const removed = Array.isArray(payload.repositories_removed)
      ? payload.repositories_removed
      : [];
    for (const repo of removed) {
      const repositoryId = canonicalDecimalId(repo?.id);
      if (repositoryId && repositorySelection === "selected") {
        await removeInstallationRepository(env.DB, installationId, repositoryId);
        await supersedeRepositoryRequestsWithOutbox(
          env.DB,
          installationId,
          repositoryId,
          now
        );
      }
    }
    if (existing?.repository_selection === "all" && repositorySelection === "selected") {
      await repairOutboxJobs(env.DB, now);
    }
    return { handled: true, result: "repos_removed" };
  }

  return { handled: true, result: "ignored" };
}

/**
 * @param {object} env
 * @param {string} eventName
 * @param {object} payload
 * @param {{ deliveryId: string, payloadDigest: string }} meta
 */
export async function routeWebhookEvent(env, eventName, payload, meta) {
  const action = typeof payload?.action === "string" ? payload.action : undefined;
  if (!isAllowedEventAction(eventName, action)) {
    return { handled: true, result: "event_not_allowed" };
  }

  switch (eventName) {
    case "pull_request":
      return handlePullRequest(env, payload, action, meta);
    case "issue_comment":
      return handleIssueComment(env, payload, meta);
    case "check_run":
      return handleCheckRun(env, payload, meta);
    case "installation":
      return handleInstallation(env, payload, action);
    case "installation_repositories":
      return handleInstallationRepositories(env, payload, action);
    default:
      return { handled: true, result: "event_not_allowed" };
  }
}

/**
 * Full webhook HTTP handler for exact POST /github/webhooks.
 * @param {Request} request
 * @param {object} env
 * @param {{ fetchImpl?: typeof fetch }} [options]
 */
export async function handleWebhook(request, env, options = {}) {
  if (request.method !== "POST") {
    return errorResponse(405, "method_not_allowed");
  }

  if (!isAllowedJsonContentType(request.headers.get("content-type"))) {
    return errorResponse(415, "unsupported_media_type");
  }

  const secret = env.WEBHOOK_SECRET;
  if (!isValidSharedSecret(secret)) {
    logSafe("error", "webhook_secret_invalid", {});
    return errorResponse(500, "misconfigured");
  }

  const headers = readWebhookIdentityHeaders(request);
  if (!headers.ok) {
    return errorResponse(400, headers.reason);
  }

  const bodyResult = await readWebhookBody(request);
  if (!bodyResult.ok) {
    if (bodyResult.reason === "payload_too_large") {
      return errorResponse(413, "payload_too_large");
    }
    return errorResponse(400, "invalid_body");
  }

  const rawBody = bodyResult.bytes;
  const valid = await verifyGitHubSignature256(rawBody, headers.signature, secret);
  if (!valid) {
    logSafe("error", "webhook_signature_invalid", {});
    return errorResponse(401, "invalid_signature");
  }

  const { eventName, deliveryId } = headers;

  if (!Object.prototype.hasOwnProperty.call(ALLOWED_EVENT_ACTIONS, eventName)) {
    logSafe("info", "event_ignored", { event: eventName, delivery_id: deliveryId });
    return ok({ result: "event_not_allowed" });
  }

  let payload;
  try {
    const text = new TextDecoder().decode(rawBody);
    payload = parseJsonPreservingIntegerIds(text);
  } catch {
    return errorResponse(400, "invalid_json");
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return errorResponse(400, "invalid_json");
  }

  const payloadDigest = await sha256Hex(rawBody);
  const receivedAt = new Date().toISOString();

  const admission = await admitDelivery(env.DB, {
    deliveryId,
    eventName,
    payloadDigest,
    receivedAt
  });

  if (admission.outcome === "mismatch") {
    logSafe("error", "delivery_digest_mismatch", { delivery_id: deliveryId });
    return errorResponse(409, "delivery_digest_mismatch");
  }

  // A fully processed delivery is a pure no-op. An admitted-but-unprocessed
  // delivery resumes the idempotent D1 route after a Worker crash.
  if (admission.outcome === "replay" && admission.delivery?.status === "processed") {
    logSafe("info", "webhook_replay_noop", {
      delivery_id: deliveryId,
      event: eventName
    });
    return ok({ result: "replay", replay: true });
  }

  const meta = { deliveryId, payloadDigest };
  const routeResult = await routeWebhookEvent(
    env,
    eventName,
    payload,
    meta,
  );

  await updateDeliveryStatus(env.DB, deliveryId, "processed");

  logSafe("info", "webhook_processed", {
    delivery_id: deliveryId,
    event: eventName,
    result: routeResult?.result ?? "ok"
  });

  if (typeof options.ctx?.waitUntil === "function") {
    options.ctx.waitUntil(
      processOutbox(env, {
        fetchImpl: options.fetchImpl,
        workerId: options.workerId
      }).catch(() => {
        logSafe("error", "outbox_best_effort_failed", {});
      })
    );
  }

  return ok({
    result: routeResult?.result ?? "ok",
    request_id: routeResult?.requestId ?? null,
    replay: false
  });
}

// Re-export for tests that seed authorization state.
export { getInstallation, isInstallationRepoAuthorized };
