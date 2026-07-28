/**
 * App-owned GitHub Check Run lifecycle. Check identity is bound to exact App,
 * head, name, and external_id before an existing run is reused or completed.
 */

import {
  CHECK_RERUN_IDENTIFIER,
  GITHUB_API_BASE
} from "../constants.mjs";
import {
  canonicalDecimalId,
  canonicalHeadSha,
  isCanonicalDecimalId
} from "../ids.mjs";

export const GROK_REVIEW_CHECK_NAME = "Grok review";
export const GROK_REVIEW_CHECK_ACTION = Object.freeze({
  label: "Re-run Grok review",
  description: "Review the current PR head again",
  identifier: CHECK_RERUN_IDENTIFIER
});

const ALLOWED_CONCLUSIONS = new Set(["neutral", "cancelled", "failure"]);
const MAX_LINK_HEADER_BYTES = 8192;
const MAX_GITHUB_PAGE = 1_000_000;

function checkError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeRepoPart(value) {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= 255
    && !/[\u0000-\u001f\u007f/]/.test(value)
  );
}

function safeExternalId(value) {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= 255
    && /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function safeIso(value) {
  return (
    typeof value === "string"
    && value.length <= 64
    && !Number.isNaN(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value
  );
}

function validateBaseInput(input) {
  if (
    !input
    || !input.client
    || typeof input.client.request !== "function"
    || !safeRepoPart(input.owner)
    || !safeRepoPart(input.name)
    || !isCanonicalDecimalId(input.expectedAppId)
    || !canonicalHeadSha(input.headSha)
    || canonicalHeadSha(input.headSha) !== input.headSha
    || !safeExternalId(input.externalId)
  ) {
    throw checkError("invalid_check_input");
  }
}

/**
 * @param {unknown} value
 * @param {{ expectedAppId: string, headSha: string, externalId: string, checkId?: string|null }} binding
 */
export function validateCheckRunIdentity(value, binding) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw checkError("invalid_check_response");
  }
  const id = canonicalDecimalId(value.id);
  if (!id) throw checkError("invalid_check_id");
  if (binding.checkId != null && id !== binding.checkId) {
    throw checkError("check_id_mismatch");
  }
  if (value.name !== GROK_REVIEW_CHECK_NAME) throw checkError("check_name_mismatch");
  if (value.external_id !== binding.externalId) throw checkError("check_external_id_mismatch");
  if (canonicalHeadSha(value.head_sha) !== binding.headSha) {
    throw checkError("check_head_mismatch");
  }
  if (canonicalDecimalId(value.app?.id) !== binding.expectedAppId) {
    throw checkError("check_app_mismatch");
  }
  return Object.freeze({
    id,
    status: typeof value.status === "string" ? value.status : null,
    conclusion: typeof value.conclusion === "string" ? value.conclusion : null,
    url: typeof value.html_url === "string" ? value.html_url : null
  });
}

function repoPrefix(input) {
  return `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}`;
}

function lastPageFromLinkHeader(header, expectedPath, headSha) {
  if (header == null || header === "") return 1;
  if (typeof header !== "string" || header.length > MAX_LINK_HEADER_BYTES) {
    throw checkError("invalid_check_pagination");
  }
  const last = header
    .split(",")
    .filter((entry) => /\brel="last"\s*$/.test(entry.trim()));
  if (last.length === 0) return 1;
  if (last.length !== 1) throw checkError("invalid_check_pagination");
  const match = /^<([^>]+)>;\s*rel="last"\s*$/.exec(last[0].trim());
  if (!match) throw checkError("invalid_check_pagination");
  let url;
  try {
    url = new URL(match[1]);
  } catch {
    throw checkError("invalid_check_pagination");
  }
  const canonicalNumericPath = new RegExp(
    `^/repositories/[1-9][0-9]*/commits/${headSha}/check-runs$`
  );
  if (
    url.origin !== GITHUB_API_BASE
    || (url.pathname !== expectedPath && !canonicalNumericPath.test(url.pathname))
    || url.username
    || url.password
    || url.hash
    || url.searchParams.get("per_page") !== "100"
    || url.searchParams.get("filter") !== "all"
    || url.searchParams.get("check_name") !== GROK_REVIEW_CHECK_NAME
  ) {
    throw checkError("invalid_check_pagination");
  }
  const page = url.searchParams.get("page");
  if (!/^[1-9][0-9]*$/.test(page ?? "")) throw checkError("invalid_check_pagination");
  const number = Number(page);
  if (!Number.isSafeInteger(number) || number > MAX_GITHUB_PAGE) {
    throw checkError("invalid_check_pagination");
  }
  return number;
}

/**
 * Find exactly one prior App-owned check for the exact request binding.
 * @param {object} input
 */
export async function reconcileCheckRun(input) {
  validateBaseInput(input);
  const matches = [];
  const checkPath = `${repoPrefix(input)}/commits/${input.headSha}/check-runs`;
  const scanPage = async (page) => {
    const response = await input.client.request(
      `${checkPath}?check_name=${encodeURIComponent(GROK_REVIEW_CHECK_NAME)}&filter=all&per_page=100&page=${page}`,
      { expectedStatus: 200 }
    );
    const runs = Array.isArray(response.json?.check_runs)
      ? response.json.check_runs
      : null;
    if (!runs) throw checkError("invalid_check_list_response");
    for (const run of runs) {
      if (
        run?.name === GROK_REVIEW_CHECK_NAME
        && run?.external_id === input.externalId
        && canonicalHeadSha(run?.head_sha) === input.headSha
        && canonicalDecimalId(run?.app?.id) === input.expectedAppId
      ) {
        matches.push(run);
      }
    }
    return response;
  };
  const first = await scanPage(1);
  const lastPage = lastPageFromLinkHeader(
    first.headers?.get?.("link") ?? null,
    checkPath,
    input.headSha
  );
  const pages = new Set();
  if (lastPage > 1) pages.add(Math.max(2, lastPage - 1));
  if (lastPage > 1) pages.add(lastPage);
  for (const page of pages) {
    await scanPage(page);
  }
  if (matches.length > 1) throw checkError("ambiguous_check_reconciliation");
  if (matches.length === 0) return null;
  return validateCheckRunIdentity(matches[0], {
    expectedAppId: input.expectedAppId,
    headSha: input.headSha,
    externalId: input.externalId
  });
}

/**
 * Reuse a single exact match or create one in-progress check.
 * @param {{
 *   client: { request: Function }, owner: string, name: string,
 *   expectedAppId: string, headSha: string, externalId: string,
 *   startedAt: string, title?: string, summary?: string
 * }} input
 */
export async function createOrReconcileCheckRun(input) {
  validateBaseInput(input);
  if (!safeIso(input.startedAt)) throw checkError("invalid_check_started_at");
  const existing = await reconcileCheckRun(input);
  if (existing) return Object.freeze({ ...existing, reconciled: true });

  const title = input.title ?? "Grok review started";
  const summary = input.summary ?? "Reviewing the exact pull request head.";
  if (
    typeof title !== "string"
    || title.length < 1
    || title.length > 255
    || typeof summary !== "string"
    || summary.length < 1
    || summary.length > 65_535
  ) {
    throw checkError("invalid_check_output");
  }
  const response = await input.client.request(
    `${repoPrefix(input)}/check-runs`,
    {
      method: "POST",
      expectedStatus: 201,
      body: JSON.stringify({
        name: GROK_REVIEW_CHECK_NAME,
        head_sha: input.headSha,
        status: "in_progress",
        started_at: input.startedAt,
        external_id: input.externalId,
        output: { title, summary },
        actions: [GROK_REVIEW_CHECK_ACTION]
      })
    }
  );
  const created = validateCheckRunIdentity(response.json, {
    expectedAppId: input.expectedAppId,
    headSha: input.headSha,
    externalId: input.externalId
  });
  if (created.status !== "in_progress") throw checkError("check_status_mismatch");
  return Object.freeze({ ...created, reconciled: false });
}

/**
 * Complete one known exact check. Reviews are deliberately non-gating:
 * successful review execution concludes neutral.
 *
 * @param {{
 *   client: { request: Function }, owner: string, name: string,
 *   expectedAppId: string, headSha: string, externalId: string,
 *   checkId: string, conclusion: "neutral"|"cancelled"|"failure",
 *   completedAt: string, title: string, summary: string
 * }} input
 */
export async function completeCheckRun(input) {
  validateBaseInput(input);
  if (
    !isCanonicalDecimalId(input.checkId)
    || !ALLOWED_CONCLUSIONS.has(input.conclusion)
    || !safeIso(input.completedAt)
    || typeof input.title !== "string"
    || input.title.length < 1
    || input.title.length > 255
    || typeof input.summary !== "string"
    || input.summary.length < 1
    || input.summary.length > 65_535
  ) {
    throw checkError("invalid_check_completion");
  }
  const response = await input.client.request(
    `${repoPrefix(input)}/check-runs/${input.checkId}`,
    {
      method: "PATCH",
      expectedStatus: 200,
      body: JSON.stringify({
        name: GROK_REVIEW_CHECK_NAME,
        status: "completed",
        conclusion: input.conclusion,
        completed_at: input.completedAt,
        output: {
          title: input.title,
          summary: input.summary
        },
        actions: [GROK_REVIEW_CHECK_ACTION]
      })
    }
  );
  const completed = validateCheckRunIdentity(response.json, {
    expectedAppId: input.expectedAppId,
    headSha: input.headSha,
    externalId: input.externalId,
    checkId: input.checkId
  });
  if (completed.status !== "completed" || completed.conclusion !== input.conclusion) {
    throw checkError("check_completion_mismatch");
  }
  return completed;
}
