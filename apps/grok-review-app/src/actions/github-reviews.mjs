/**
 * Native GitHub PR review lifecycle with a pending-review stale-head fence.
 * Only COMMENT reviews are submitted; APPROVE and REQUEST_CHANGES are absent.
 */

import { GITHUB_API_BASE } from "../constants.mjs";
import { RECEIPT_MARKER_PREFIX } from "../receipt-contract.mjs";
import {
  canonicalDecimalId,
  canonicalHeadSha,
  isCanonicalDecimalId
} from "../ids.mjs";

const MAX_REVIEW_BODY_BYTES = 64 * 1024;
const MAX_COMMENT_BODY_BYTES = 64 * 1024;
const MAX_INLINE_COMMENTS = 100;
const MAX_LINK_HEADER_BYTES = 8192;
const MAX_GITHUB_PAGE = 1_000_000;

function reviewError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

function safeRepoPart(value) {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= 255
    && !/[\u0000-\u001f\u007f/]/.test(value)
  );
}

function safeMarker(value) {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && value.startsWith(`<!-- ${RECEIPT_MARKER_PREFIX}`)
    && value.endsWith(" -->")
    && !/[\r\n\u0000]/.test(value)
  );
}

function validateBase(input) {
  if (
    !input
    || !input.client
    || typeof input.client.request !== "function"
    || !safeRepoPart(input.owner)
    || !safeRepoPart(input.name)
    || !isCanonicalDecimalId(input.pullNumber)
    || !isCanonicalDecimalId(input.expectedBotId)
    || canonicalHeadSha(input.headSha) !== input.headSha
  ) {
    throw reviewError("invalid_review_input");
  }
}

function repoPrefix(input) {
  return `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}`;
}

function lastPageFromLinkHeader(header, expectedPath, pullNumber) {
  if (header == null || header === "") return 1;
  if (typeof header !== "string" || header.length > MAX_LINK_HEADER_BYTES) {
    throw reviewError("invalid_review_pagination");
  }
  const links = header.split(",");
  const last = links.filter((entry) => /\brel="last"\s*$/.test(entry.trim()));
  if (last.length === 0) return 1;
  if (last.length !== 1) throw reviewError("invalid_review_pagination");
  const match = /^<([^>]+)>;\s*rel="last"\s*$/.exec(last[0].trim());
  if (!match) throw reviewError("invalid_review_pagination");
  let url;
  try {
    url = new URL(match[1]);
  } catch {
    throw reviewError("invalid_review_pagination");
  }
  const canonicalNumericPath = new RegExp(
    `^/repositories/[1-9][0-9]*/pulls/${pullNumber}/reviews$`
  );
  if (
    url.origin !== GITHUB_API_BASE
    || (url.pathname !== expectedPath && !canonicalNumericPath.test(url.pathname))
    || url.username
    || url.password
    || url.hash
    || url.searchParams.get("per_page") !== "100"
  ) {
    throw reviewError("invalid_review_pagination");
  }
  const page = url.searchParams.get("page");
  if (!/^[1-9][0-9]*$/.test(page ?? "")) throw reviewError("invalid_review_pagination");
  const number = Number(page);
  if (!Number.isSafeInteger(number) || number > MAX_GITHUB_PAGE) {
    throw reviewError("invalid_review_pagination");
  }
  return number;
}

function validateInlineComment(comment) {
  if (!comment || typeof comment !== "object" || Array.isArray(comment)) {
    throw reviewError("invalid_review_comment");
  }
  const keys = Object.keys(comment);
  const allowed = new Set(["path", "line", "side", "start_line", "start_side", "body"]);
  if (keys.some((key) => !allowed.has(key))) throw reviewError("invalid_review_comment");
  if (
    typeof comment.path !== "string"
    || comment.path.length < 1
    || comment.path.length > 4096
    || utf8Bytes(comment.path) > 4096
    || comment.path.startsWith("/")
    || /[\u0000-\u001f\u007f]/.test(comment.path)
    || !Number.isSafeInteger(comment.line)
    || comment.line < 1
    || comment.side !== "RIGHT"
    || typeof comment.body !== "string"
    || comment.body.length < 1
    || utf8Bytes(comment.body) > MAX_COMMENT_BODY_BYTES
    || comment.body.includes(RECEIPT_MARKER_PREFIX)
  ) {
    throw reviewError("invalid_review_comment");
  }
  if (comment.start_line != null) {
    if (
      !Number.isSafeInteger(comment.start_line)
      || comment.start_line < 1
      || comment.start_line > comment.line
      || comment.start_side !== "RIGHT"
    ) {
      throw reviewError("invalid_review_comment_range");
    }
  } else if (comment.start_side != null) {
    throw reviewError("invalid_review_comment_range");
  }
  return { ...comment };
}

/**
 * @param {unknown} value
 * @param {{
 *   reviewId?: string|null, expectedBotId: string, headSha: string,
 *   receiptMarker: string, allowedStates: string[]
 * }} binding
 */
export function validateReviewIdentity(value, binding) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw reviewError("invalid_review_response");
  }
  const id = canonicalDecimalId(value.id);
  if (!id) throw reviewError("invalid_review_id");
  if (binding.reviewId != null && id !== binding.reviewId) {
    throw reviewError("review_id_mismatch");
  }
  if (canonicalDecimalId(value.user?.id) !== binding.expectedBotId || value.user?.type !== "Bot") {
    throw reviewError("review_bot_mismatch");
  }
  if (canonicalHeadSha(value.commit_id) !== binding.headSha) {
    throw reviewError("review_commit_mismatch");
  }
  if (!binding.allowedStates.includes(value.state)) {
    throw reviewError("review_state_mismatch");
  }
  if (
    typeof value.body !== "string"
    || !value.body.includes(binding.receiptMarker)
    || value.body.split(RECEIPT_MARKER_PREFIX).length !== 2
  ) {
    throw reviewError("review_receipt_marker_mismatch");
  }
  return Object.freeze({
    id,
    state: value.state,
    commitId: value.commit_id,
    url: typeof value.html_url === "string" ? value.html_url : null
  });
}

/**
 * List at most three pages and return the sole exact App-bot/head/marker match.
 * @param {{
 *   client: { request: Function }, owner: string, name: string,
 *   pullNumber: string, expectedBotId: string, headSha: string,
 *   receiptMarker: string, allowedStates?: string[]
 * }} input
 */
export async function reconcileReviewByReceiptMarker(input) {
  validateBase(input);
  if (!safeMarker(input.receiptMarker)) throw reviewError("invalid_receipt_marker");
  const allowedStates = input.allowedStates ?? ["PENDING", "COMMENTED"];
  if (
    !Array.isArray(allowedStates)
    || allowedStates.length < 1
    || allowedStates.some((state) => !["PENDING", "COMMENTED"].includes(state))
  ) {
    throw reviewError("invalid_review_states");
  }
  const matches = [];
  const reviewPath = `${repoPrefix(input)}/pulls/${input.pullNumber}/reviews`;
  const scanPage = async (page) => {
    const response = await input.client.request(
      `${reviewPath}?per_page=100&page=${page}`,
      { expectedStatus: 200 }
    );
    if (!Array.isArray(response.json)) throw reviewError("invalid_review_list_response");
    for (const review of response.json) {
      if (
        canonicalDecimalId(review?.user?.id) === input.expectedBotId
        && review?.user?.type === "Bot"
        && canonicalHeadSha(review?.commit_id) === input.headSha
        && allowedStates.includes(review?.state)
        && typeof review?.body === "string"
        && review.body.includes(input.receiptMarker)
      ) {
        matches.push(review);
      }
    }
    return response;
  };
  const first = await scanPage(1);
  const lastPage = lastPageFromLinkHeader(
    first.headers?.get?.("link") ?? null,
    reviewPath,
    input.pullNumber
  );
  const pages = new Set();
  if (lastPage > 1) pages.add(Math.max(2, lastPage - 1));
  if (lastPage > 1) pages.add(lastPage);
  for (const page of pages) {
    await scanPage(page);
  }
  if (matches.length > 1) throw reviewError("ambiguous_review_reconciliation");
  if (matches.length === 0) return null;
  return validateReviewIdentity(matches[0], {
    expectedBotId: input.expectedBotId,
    headSha: input.headSha,
    receiptMarker: input.receiptMarker,
    allowedStates
  });
}

/**
 * Create a PENDING review on an exact commit. comments may be empty so a clean
 * diff still produces a visible COMMENT summary after submission.
 *
 * @param {{
 *   client: { request: Function }, owner: string, name: string,
 *   pullNumber: string, expectedBotId: string, headSha: string,
 *   receiptMarker: string, body: string, comments?: object[]
 * }} input
 */
export async function createPendingReview(input) {
  validateBase(input);
  if (
    !safeMarker(input.receiptMarker)
    || typeof input.body !== "string"
    || input.body.length < 1
    || utf8Bytes(input.body) > MAX_REVIEW_BODY_BYTES
    || !input.body.includes(input.receiptMarker)
    || input.body.split(RECEIPT_MARKER_PREFIX).length !== 2
  ) {
    throw reviewError("invalid_review_body");
  }
  const comments = input.comments ?? [];
  if (!Array.isArray(comments) || comments.length > MAX_INLINE_COMMENTS) {
    throw reviewError("invalid_review_comments");
  }
  const validatedComments = comments.map(validateInlineComment);
  const response = await input.client.request(
    `${repoPrefix(input)}/pulls/${input.pullNumber}/reviews`,
    {
      method: "POST",
      expectedStatus: 200,
      body: JSON.stringify({
        commit_id: input.headSha,
        body: input.body,
        comments: validatedComments
      })
    }
  );
  return validateReviewIdentity(response.json, {
    expectedBotId: input.expectedBotId,
    headSha: input.headSha,
    receiptMarker: input.receiptMarker,
    allowedStates: ["PENDING"]
  });
}

/**
 * Submit one known PENDING review as COMMENT.
 * @param {object} input
 */
export async function submitPendingReview(input) {
  validateBase(input);
  if (!isCanonicalDecimalId(input.reviewId) || !safeMarker(input.receiptMarker)) {
    throw reviewError("invalid_review_submission");
  }
  const response = await input.client.request(
    `${repoPrefix(input)}/pulls/${input.pullNumber}/reviews/${input.reviewId}/events`,
    {
      method: "POST",
      expectedStatus: 200,
      body: JSON.stringify({ event: "COMMENT" })
    }
  );
  return validateReviewIdentity(response.json, {
    reviewId: input.reviewId,
    expectedBotId: input.expectedBotId,
    headSha: input.headSha,
    receiptMarker: input.receiptMarker,
    allowedStates: ["COMMENTED"]
  });
}

/**
 * Delete one exact stale PENDING review before it becomes visible.
 * @param {object} input
 */
export async function deletePendingReview(input) {
  validateBase(input);
  if (!isCanonicalDecimalId(input.reviewId) || !safeMarker(input.receiptMarker)) {
    throw reviewError("invalid_review_deletion");
  }
  const current = await input.client.request(
    `${repoPrefix(input)}/pulls/${input.pullNumber}/reviews/${input.reviewId}`,
    { expectedStatus: 200 }
  );
  validateReviewIdentity(current.json, {
    reviewId: input.reviewId,
    expectedBotId: input.expectedBotId,
    headSha: input.headSha,
    receiptMarker: input.receiptMarker,
    allowedStates: ["PENDING"]
  });
  await input.client.request(
    `${repoPrefix(input)}/pulls/${input.pullNumber}/reviews/${input.reviewId}`,
    { method: "DELETE", expectedStatus: 204 }
  );
}
