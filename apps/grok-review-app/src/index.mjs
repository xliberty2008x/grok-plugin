/**
 * Private Grok Review GitHub App — Cloudflare Worker entrypoint.
 *
 * Routes:
 *   GET  /healthz                 — liveness
 *   POST /github/webhooks         — GitHub webhooks (HMAC + allowlist)
 *   POST /internal/callback       — runner state callbacks (HMAC + nonce)
 *
 * Control-plane only: no target diffs, model execution, or review posting.
 */

import { CALLBACK_PATH, WEBHOOK_PATH } from "./constants.mjs";
import { handleCallback } from "./callback.mjs";
import { errorResponse, jsonResponse } from "./http.mjs";
import { runScheduledMaintenance } from "./outbox.mjs";
import { handleWebhook } from "./webhook.mjs";

/**
 * Normalize path: strip trailing slashes except root; no query.
 * @param {string} pathname
 */
export function normalizePath(pathname) {
  if (pathname === "/" || pathname === "") return "/";
  return pathname.replace(/\/+$/, "") || "/";
}

/**
 * @param {Request} request
 * @param {object} env
 * @param {ExecutionContext} [ctx]
 * @param {{ fetchImpl?: typeof fetch, nowMs?: number }} [options]
 * @returns {Promise<Response>}
 */
export async function handleRequest(request, env, ctx, options = {}) {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);

  if (request.method === "GET" && (path === "/healthz" || path === "/health")) {
    return jsonResponse(200, { ok: true, service: "grok-review-app" });
  }

  // Exact route only — reject /webhook and other aliases.
  if (path === WEBHOOK_PATH) {
    return handleWebhook(request, env, { ...options, ctx });
  }

  if (path === CALLBACK_PATH) {
    return handleCallback(request, env, options);
  }

  return errorResponse(404, "not_found");
}

/**
 * Deterministic scheduled entrypoint used by Cloudflare cron and tests.
 */
export function handleScheduled(env, ctx, options = {}) {
  const work = runScheduledMaintenance(env, options);
  ctx.waitUntil(work);
}

export default {
  /**
   * @param {Request} request
   * @param {object} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },

  /**
   * Durable retry path for missed, failed, or expired-lease outbox jobs.
   * @param {ScheduledController} controller
   * @param {object} env
   * @param {ExecutionContext} ctx
   */
  async scheduled(controller, env, ctx) {
    handleScheduled(env, ctx);
  }
};

export { handleWebhook, handleCallback };
export {
  verifyGitHubSignature256,
  verifyCallbackSignature256,
  buildCallbackMacMessage,
  signCallbackMessage,
  timingSafeEqualString,
  isValidSharedSecret,
  SHARED_SECRET_MIN_BYTES,
  SHARED_SECRET_MAX_BYTES,
  sha256Hex,
  hmacSha256
} from "./crypto-util.mjs";
export {
  buildDispatchInputs,
  buildDispatchUrl,
  buildCancelUrl,
  buildRunUrl,
  dispatchWorkflow,
  cancelWorkflowRun,
  fetchWorkflowRun,
  parseWorkflowRunId
} from "./github.mjs";
export {
  isBotSender,
  isExactManualCommand,
  isAllowedEventAction,
  routeWebhookEvent,
  supersedeActivePrRequests,
  readWebhookIdentityHeaders
} from "./webhook.mjs";
export {
  parseCallbackPayload,
  readCallbackAuthHeaders,
  buildClaimResponse
} from "./callback.mjs";
export {
  encodeExternalId,
  parseExternalId
} from "./external-id.mjs";
export {
  canonicalDecimalId,
  isCanonicalDecimalId,
  parseJsonPreservingIntegerIds,
  canonicalHeadSha,
  createOpaqueReceiptId,
  buildAutomaticRequestKey,
  buildManualCommentRequestKey,
  buildCheckRerunRequestKey
} from "./ids.mjs";
export {
  createMemoryDb
} from "./memory-db.mjs";
export {
  RECEIPT_SCHEMA_VERSION,
  RECEIPT_SIGNATURE_ALGORITHM,
  RECEIPT_MARKER_PREFIX,
  validateSanitizedReceipt,
  canonicalJson,
  computeReceiptDigest,
  receiptKeyId,
  parseReceiptPublicKeys,
  verifyReceiptEnvelope,
  buildReceiptMarker
} from "./receipt-contract.mjs";
export {
  computeOutboxBackoffMs,
  processOutbox,
  drainOutbox,
  processWorkflowWatchdog,
  runScheduledMaintenance,
  supersedePrAndQueueCancellation,
  SAFE_OUTBOX_ERRORS
} from "./outbox.mjs";
export {
  upsertInstallation,
  addInstallationRepository,
  clearInstallationRepositories,
  isInstallationRepoAuthorized,
  getRequestById,
  getRequestByKey,
  getDelivery,
  getReceiptById,
  getReceiptByRequestId,
  getOutboxJobById,
  getOutboxJobByKey,
  listOutboxJobs,
  listStaleActiveRequests,
  leaseOutboxJobs,
  repairOutboxJobs,
  rescheduleOutboxJob,
  completeOutboxJob,
  enqueueCancelOutboxJob,
  admitReviewRequestWithOutbox,
  claimWorkflowRunOrEnqueueOrphan,
  casAbortRequest,
  casWatchdogTerminal,
  authorizeReviewRequestWithOutbox,
  setInstallationRepositorySelection,
  supersedePrRequestsWithOutbox,
  supersedeInstallationRequestsWithOutbox,
  supersedeRepositoryRequestsWithOutbox,
  casClaimWorkflowRun,
  casMarkRequestSuperseded,
  casMarkFailedDispatch,
  casCommitTerminalWithReceipt
} from "./db.mjs";
export * from "./constants.mjs";
