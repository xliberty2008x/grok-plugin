/**
 * Outbound GitHub Actions control-plane calls.
 * Fixed api.github.com endpoints, pinned API version, bounded timeout, no URL following.
 * Dispatches only canonical decimal ID strings + trigger_kind enum.
 */

import {
  FETCH_TIMEOUT_MS,
  GITHUB_API_BASE,
  GITHUB_API_VERSION,
  TRIGGER_KIND
} from "./constants.mjs";
import {
  isCanonicalDecimalId,
  parseJsonPreservingIntegerIds
} from "./ids.mjs";
import { logSafe } from "./http.mjs";

const ALLOWED_TRIGGER_KINDS = new Set(Object.values(TRIGGER_KIND));

/**
 * Immutable workflow_dispatch ref: tag name only (GitHub rejects raw SHAs).
 * Format: grok-review-runtime-<40 lowercase hex commit SHA>.
 * Must point at the same commit as GROK_REVIEW_RUNTIME_COMMIT.
 */
const CONTROL_RUNTIME_REF_RE = /^grok-review-runtime-[0-9a-f]{40}$/;

/**
 * @param {unknown} ref
 * @returns {boolean}
 */
export function isValidControlRuntimeRef(ref) {
  return typeof ref === "string" && CONTROL_RUNTIME_REF_RE.test(ref);
}

/**
 * Build workflow_dispatch inputs: decimal ID strings + enum only.
 * @param {{
 *   requestId: string,
 *   installationId: string,
 *   repositoryId: string,
 *   pullNumber: string,
 *   triggerId: string,
 *   actorId: string,
 *   triggerKind: string
 * }} input
 */
export function buildDispatchInputs(input) {
  if (!isCanonicalDecimalId(input.requestId)) return { ok: false, reason: "invalid_request_id" };
  if (!isCanonicalDecimalId(input.installationId)) return { ok: false, reason: "invalid_installation_id" };
  if (!isCanonicalDecimalId(input.repositoryId)) return { ok: false, reason: "invalid_repository_id" };
  if (!isCanonicalDecimalId(input.pullNumber)) return { ok: false, reason: "invalid_pull_number" };
  if (!isCanonicalDecimalId(input.triggerId)) return { ok: false, reason: "invalid_trigger_id" };
  if (!isCanonicalDecimalId(input.actorId)) return { ok: false, reason: "invalid_actor_id" };
  if (!ALLOWED_TRIGGER_KINDS.has(input.triggerKind)) {
    return { ok: false, reason: "invalid_trigger_kind" };
  }

  return {
    ok: true,
    inputs: {
      request_id: input.requestId,
      installation_id: input.installationId,
      repository_id: input.repositoryId,
      pull_number: input.pullNumber,
      trigger_id: input.triggerId,
      actor_id: input.actorId,
      trigger_kind: input.triggerKind
    }
  };
}

/**
 * @param {{ owner: string, repo: string, workflowId: string }} cfg
 */
export function buildDispatchUrl(cfg) {
  const owner = encodeURIComponent(cfg.owner);
  const repo = encodeURIComponent(cfg.repo);
  const workflowId = encodeURIComponent(cfg.workflowId);
  return `${GITHUB_API_BASE}/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`;
}

/**
 * @param {{ owner: string, repo: string, runId: string }} cfg
 */
export function buildCancelUrl(cfg) {
  const owner = encodeURIComponent(cfg.owner);
  const repo = encodeURIComponent(cfg.repo);
  const runId = encodeURIComponent(cfg.runId);
  return `${GITHUB_API_BASE}/repos/${owner}/${repo}/actions/runs/${runId}/cancel`;
}

export function buildRunUrl(cfg) {
  const owner = encodeURIComponent(cfg.owner);
  const repo = encodeURIComponent(cfg.repo);
  const runId = encodeURIComponent(cfg.runId);
  return `${GITHUB_API_BASE}/repos/${owner}/${repo}/actions/runs/${runId}`;
}

/**
 * @param {string} token
 */
function githubHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-github-api-version": GITHUB_API_VERSION,
    "user-agent": "grok-review-app"
  };
}

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} [timeoutMs]
 */
export async function boundedFetch(url, init, timeoutMs = FETCH_TIMEOUT_MS) {
  if (typeof url !== "string" || !url.startsWith(`${GITHUB_API_BASE}/`)) {
    throw new Error("refusing non-fixed github api url");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      redirect: "manual",
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse workflow_run_id from dispatch response without Number coercion loss.
 * @param {unknown} value
 * @returns {string|null}
 */
export function parseWorkflowRunId(value) {
  if (typeof value === "string") {
    return isCanonicalDecimalId(value) ? value : null;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) {
      return null;
    }
    const s = String(value);
    return isCanonicalDecimalId(s) ? s : null;
  }
  return null;
}

/**
 * @param {object} opts
 */
export async function dispatchWorkflow(opts) {
  const built = buildDispatchInputs(opts.inputs);
  if (!built.ok) {
    return { ok: false, reason: built.reason };
  }
  // Fail closed before any GitHub call: reject main, branches, raw SHAs,
  // missing/malformed tags. Only the immutable runtime tag form is accepted.
  if (!isValidControlRuntimeRef(opts.ref)) {
    return { ok: false, reason: "invalid_control_ref" };
  }

  const url = buildDispatchUrl({
    owner: opts.owner,
    repo: opts.repo,
    workflowId: opts.workflowId
  });

  const body = JSON.stringify({
    ref: opts.ref,
    inputs: built.inputs
  });

  const fetchFn = opts.fetchImpl
    ? (u, init) => opts.fetchImpl(u, { ...init, redirect: "manual" })
    : boundedFetch;

  let response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: githubHeaders(opts.token),
      body,
      redirect: "manual"
    });
  } catch {
    logSafe("error", "workflow_dispatch_network_error", {
      request_id: opts.inputs.requestId
    });
    return { ok: false, reason: "network_error" };
  }

  if (response.status !== 200) {
    logSafe("error", "workflow_dispatch_http_error", {
      request_id: opts.inputs.requestId,
      status: response.status
    });
    return { ok: false, reason: "http_error", status: response.status };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  const workflowRunId = parseWorkflowRunId(payload?.workflow_run_id);
  if (!workflowRunId) {
    return { ok: false, reason: "missing_workflow_run_id" };
  }

  // API 2026-03-10 returns run_url (not generic url). Accept only fixed api.github.com hosts.
  const workflowRunUrl =
    typeof payload?.run_url === "string" && payload.run_url.startsWith(`${GITHUB_API_BASE}/`)
      ? payload.run_url
      : null;
  const workflowHtmlUrl =
    typeof payload?.html_url === "string" && payload.html_url.startsWith("https://github.com/")
      ? payload.html_url
      : null;

  return {
    ok: true,
    workflowRunId,
    workflowRunUrl,
    workflowHtmlUrl
  };
}

/**
 * @param {object} opts
 */
export async function cancelWorkflowRun(opts) {
  if (!isCanonicalDecimalId(opts.runId)) {
    return { ok: false, reason: "invalid_run_id" };
  }

  const url = buildCancelUrl({
    owner: opts.owner,
    repo: opts.repo,
    runId: opts.runId
  });

  const fetchFn = opts.fetchImpl
    ? (u, init) => opts.fetchImpl(u, { ...init, redirect: "manual" })
    : boundedFetch;

  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: githubHeaders(opts.token),
      body: "{}",
      redirect: "manual"
    });
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, status: response.status };
    }
    logSafe("error", "workflow_cancel_http_error", {
      run_id: opts.runId,
      status: response.status
    });
    return { ok: false, status: response.status, reason: "http_error" };
  } catch {
    logSafe("error", "workflow_cancel_network_error", { run_id: opts.runId });
    return { ok: false, reason: "network_error" };
  }
}

function expectedWorkflowPath(workflowId) {
  if (typeof workflowId !== "string" || workflowId.length < 1 || workflowId.length > 255) {
    return null;
  }
  if (/^[A-Za-z0-9._-]+\.ya?ml$/.test(workflowId)) {
    return `.github/workflows/${workflowId}`;
  }
  if (/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(workflowId)) {
    return workflowId;
  }
  return null;
}

async function readBoundedRunJson(response) {
  const limit = 256 * 1024;
  const reader = response.body?.getReader?.();
  if (!reader) return null;
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return parseJsonPreservingIntegerIds(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
  } catch {
    return null;
  }
}

/**
 * Fetch and bind one exact control-repository Actions run. No target repository
 * identity or content is accepted from this response.
 */
export async function fetchWorkflowRun(opts) {
  if (!isCanonicalDecimalId(opts.runId)) {
    return { ok: false, reason: "invalid_run_id" };
  }
  const workflowPath = expectedWorkflowPath(opts.workflowId);
  if (!workflowPath) return { ok: false, reason: "invalid_workflow_path" };
  const url = buildRunUrl(opts);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const fetchFn = opts.fetchImpl ?? fetch;
  try {
    const response = await fetchFn(url, {
      method: "GET",
      headers: githubHeaders(opts.token),
      redirect: "manual",
      signal: controller.signal
    });
    if (response.status !== 200) {
      return { ok: false, reason: "http_error", status: response.status };
    }
    const payload = await readBoundedRunJson(response);
    const responseRunId = parseWorkflowRunId(payload?.id);
    const owner = payload?.repository?.owner?.login;
    const repo = payload?.repository?.name;
    const path = typeof payload?.path === "string"
      ? payload.path.split("@", 1)[0]
      : null;
    if (
      responseRunId !== opts.runId
      || typeof owner !== "string"
      || typeof repo !== "string"
      || owner.toLowerCase() !== String(opts.owner).toLowerCase()
      || repo.toLowerCase() !== String(opts.repo).toLowerCase()
      || payload?.event !== "workflow_dispatch"
      || path !== workflowPath
      || typeof payload?.status !== "string"
      || (
        payload.status === "completed"
        && typeof payload?.conclusion !== "string"
      )
    ) {
      return { ok: false, reason: "run_binding_mismatch" };
    }
    return {
      ok: true,
      runId: responseRunId,
      status: payload.status,
      conclusion: payload.conclusion ?? null
    };
  } catch {
    return { ok: false, reason: "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} env
 */
export function controlRepoConfig(env) {
  return {
    owner: String(env.CONTROL_REPO_OWNER || ""),
    repo: String(env.CONTROL_REPO_NAME || ""),
    workflowId: String(env.CONTROL_WORKFLOW_FILE || "grok-review.yml"),
    // No branch fallback: CONTROL_REF must be the immutable runtime tag.
    ref: String(env.CONTROL_REF || ""),
    token: String(env.CONTROL_REPO_TOKEN || "")
  };
}
