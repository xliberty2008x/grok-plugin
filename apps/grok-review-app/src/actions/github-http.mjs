/**
 * Fixed-origin, bounded GitHub REST client for the central Actions runner.
 * It never logs tokens, request bodies, or response bodies.
 */

import {
  FETCH_TIMEOUT_MS,
  GITHUB_API_BASE,
  GITHUB_API_VERSION
} from "../constants.mjs";
import { parseJsonPreservingIntegerIds } from "../ids.mjs";

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const TOKEN_RE = /^[^\u0000-\u0020\u007f]{1,4096}$/;

export class GitHubApiError extends Error {
  constructor(code, options = {}) {
    super(code);
    this.name = "GitHubApiError";
    this.code = code;
    this.status = options.status ?? null;
    this.requestId = options.requestId ?? null;
  }
}

function apiError(code, options) {
  return new GitHubApiError(code, options);
}

function assertGitHubPath(path) {
  if (
    typeof path !== "string"
    || path.length < 2
    || path.length > 4096
    || !path.startsWith("/")
    || path.startsWith("//")
    || path.includes("\\")
    || path.includes("://")
    || /[\u0000-\u001f\u007f]/.test(path)
  ) {
    throw apiError("invalid_github_api_path");
  }
  const url = new URL(path, `${GITHUB_API_BASE}/`);
  if (url.origin !== GITHUB_API_BASE || url.username || url.password || url.hash) {
    throw apiError("invalid_github_api_path");
  }
  return url;
}

function normalizeExpectedStatus(value) {
  if (value == null) return null;
  const values = Array.isArray(value) ? value : [value];
  if (
    values.length === 0
    || values.some((status) => !Number.isInteger(status) || status < 100 || status > 599)
  ) {
    throw apiError("invalid_expected_status");
  }
  return new Set(values);
}

async function readBoundedResponse(response, maxBytes) {
  const declared = response.headers.get("content-length");
  if (declared && /^(0|[1-9][0-9]*)$/.test(declared)) {
    try {
      if (BigInt(declared) > BigInt(maxBytes)) {
        throw apiError("github_response_too_large", {
          status: response.status,
          requestId: response.headers.get("x-github-request-id")
        });
      }
    } catch (error) {
      if (error instanceof GitHubApiError) throw error;
    }
  }

  const reader = response.body?.getReader?.();
  if (!reader) return new Uint8Array(0);
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancellation failure; no response data is surfaced.
      }
      throw apiError("github_response_too_large", {
        status: response.status,
        requestId: response.headers.get("x-github-request-id")
      });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function bodyBytes(body) {
  if (body == null) return null;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  throw apiError("invalid_github_request_body");
}

/**
 * @param {{
 *   token: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   maxResponseBytes?: number,
 *   userAgent?: string
 * }} options
 */
export function createGitHubClient(options) {
  if (!options || typeof options.token !== "string" || !TOKEN_RE.test(options.token)) {
    throw apiError("invalid_github_token");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  if (typeof fetchImpl !== "function") throw apiError("invalid_github_fetch");
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const userAgent = options.userAgent ?? "grok-review-app";
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > 60_000
    || !Number.isSafeInteger(maxResponseBytes)
    || maxResponseBytes < 1
    || maxResponseBytes > 16 * 1024 * 1024
    || typeof userAgent !== "string"
    || userAgent.length < 1
    || userAgent.length > 128
    || /[\u0000-\u001f\u007f]/.test(userAgent)
  ) {
    throw apiError("invalid_github_client_options");
  }

  return Object.freeze({
    /**
     * @param {string} path
     * @param {{
     *   method?: string,
     *   body?: string|Uint8Array|null,
     *   accept?: string,
     *   expectedStatus?: number|number[],
     *   signal?: AbortSignal
     * }} [requestOptions]
     */
    async request(path, requestOptions = {}) {
      const url = assertGitHubPath(path);
      const method = requestOptions.method ?? "GET";
      if (!/^(GET|POST|PATCH|PUT|DELETE)$/.test(method)) {
        throw apiError("invalid_github_method");
      }
      const bytes = bodyBytes(requestOptions.body);
      if (bytes && bytes.byteLength > MAX_REQUEST_BYTES) {
        throw apiError("github_request_too_large");
      }
      const expected = normalizeExpectedStatus(requestOptions.expectedStatus);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let abortListener = null;
      if (requestOptions.signal) {
        if (requestOptions.signal.aborted) controller.abort();
        abortListener = () => controller.abort();
        requestOptions.signal.addEventListener("abort", abortListener, { once: true });
      }

      let response;
      let responseBytes;
      try {
        response = await fetchImpl(url.toString(), {
          method,
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: requestOptions.accept ?? "application/vnd.github+json",
            authorization: `Bearer ${options.token}`,
            "content-type": "application/json",
            "user-agent": userAgent,
            "x-github-api-version": GITHUB_API_VERSION
          },
          body: bytes ?? undefined
        });
        responseBytes = await readBoundedResponse(response, maxResponseBytes);
      } catch (error) {
        if (error instanceof GitHubApiError) throw error;
        throw apiError(controller.signal.aborted ? "github_request_timeout" : "github_network_error");
      } finally {
        clearTimeout(timer);
        if (abortListener) {
          requestOptions.signal.removeEventListener("abort", abortListener);
        }
      }

      const requestId = response.headers.get("x-github-request-id");
      if (
        response.status >= 300
        && response.status < 400
      ) {
        throw apiError("github_redirect_rejected", { status: response.status, requestId });
      }
      if (expected ? !expected.has(response.status) : !response.ok) {
        throw apiError(`github_http_${response.status}`, {
          status: response.status,
          requestId
        });
      }

      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(responseBytes);
      } catch {
        throw apiError("github_invalid_utf8", { status: response.status, requestId });
      }
      let json = null;
      if (text.length > 0) {
        try {
          json = parseJsonPreservingIntegerIds(text);
        } catch {
          throw apiError("github_invalid_json", { status: response.status, requestId });
        }
      }
      return Object.freeze({
        status: response.status,
        headers: response.headers,
        json,
        requestId
      });
    }
  });
}
