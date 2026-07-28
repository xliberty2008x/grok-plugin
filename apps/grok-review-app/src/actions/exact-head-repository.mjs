/**
 * Hostile-repository-safe private bare Git repository for exact-head PR collection.
 *
 * Security invariants:
 * - Absolute verified Git executable only; shell: false always
 * - Private branded temp dir; empty template/hooks/config homes
 * - Allowlisted child environment; no inherited Git config/trace
 * - Production remotes only as https://github.com/<owner>/<repo>.git
 * - Token is child-only env config data — never URL, argv, local config, or logs
 * - No checkout, worktree, hooks, filters, textconv, external diff, LFS, submodules
 * - Full history fetch with blob filter; exact SHA validation; single merge-base
 * - Disposal on every failure path; seal removes remotes/auth and disables lazy fetch
 */

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";

import {
  CollectorError,
  CollectorErrorCode,
  CollectorLimits,
  failCollector
} from "./collector-errors.mjs";

const COMMIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OWNER_RE = /^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/;
const REPO_RE = /^(?!-)[A-Za-z0-9._-]{1,100}$/;
const BASE_REF_RE = /^(?!\/)(?!.*(?:\/\.|\.\.|\/\/|\.lock$|@{))[A-Za-z0-9._\-/+]{1,255}(?<!\/)$/;

const GIT_CANDIDATES = Object.freeze([
  "/usr/bin/git",
  "/opt/homebrew/bin/git",
  "/usr/local/bin/git",
  "/bin/git"
]);

export const MAX_FETCHED_BLOB_OBJECT_BYTES = CollectorLimits.MAX_PATCH_BYTES;
export const MAX_FETCH_RESPONSE_BYTES = 128 * 1024 * 1024;
export const MAX_SMART_HTTP_REQUEST_BYTES = 1024 * 1024;
export const MAX_SMART_HTTP_AGGREGATE_REQUEST_BYTES = 8 * 1024 * 1024;
export const MAX_SMART_HTTP_REQUESTS = 16;
const GIT_PROBE_TIMEOUT_MS = 5_000;
const GIT_PROBE_OUTPUT_BYTES = 4 * 1024;
const MAX_GIT_STDIN_BYTES = 1024 * 1024;
const SMART_HTTP_HEADER_BYTES = 16 * 1024;
const BOUNDED_FETCH_PROOFS = new WeakSet();

class SmartHttpProxyError extends Error {
  constructor(kind) {
    super(kind);
    this.name = "SmartHttpProxyError";
    this.kind = kind;
  }
}

/**
 * @param {http.ServerResponse} response
 * @param {number} status
 */
function endProxyResponse(response, status) {
  if (response.destroyed || response.writableEnded) return;
  if (!response.headersSent) {
    response.writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "content-length": "0"
    });
  }
  response.end();
}

function endProxyResponseAndDestroy(request, response, status) {
  endProxyResponse(response, status);
  const socket = request.socket;
  const destroy = () => {
    if (!socket.destroyed) socket.destroy();
  };
  if (response.writableFinished) destroy();
  else response.once("finish", destroy);
}

/**
 * @param {http.IncomingMessage} request
 * @param {number} maxBytes
 * @param {(bytes: number) => void} accountAggregate
 * @returns {Promise<Buffer>}
 */
function readBoundedProxyRequest(request, maxBytes, accountAggregate) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, body) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(body);
    };

    request.on("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        request.pause();
        finish(new SmartHttpProxyError("request_body_limit"));
        return;
      }
      try {
        accountAggregate(buffer.length);
      } catch (error) {
        request.pause();
        finish(error);
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => finish(null, Buffer.concat(chunks, bytes)));
    request.on("aborted", () => finish(new SmartHttpProxyError("request_aborted")));
    request.on("error", () => finish(new SmartHttpProxyError("request_error")));
  });
}

/**
 * Production-only bounded reverse proxy for GitHub smart HTTP upload-pack.
 * The installation token is held only in this closure and injected into the
 * exact outbound github.com request.
 *
 * @param {{
 *   owner: string,
 *   repository: string,
 *   installationToken: string,
 *   responseByteLimit?: number,
 *   requestByteLimit?: number,
 *   aggregateRequestByteLimit?: number,
 *   requestCountLimit?: number,
 *   timeoutMs?: number,
 *   outboundRequest?: typeof https.request
 * }} options
 */
async function createBoundedGitHubSmartHttpProxy(options) {
  const owner = options?.owner;
  const repository = options?.repository;
  let installationToken = options?.installationToken;
  if (!isValidGitHubOwner(owner) || !isValidGitHubRepositoryName(repository)) {
    failCollector(CollectorErrorCode.E_COLLECTOR_IDENTITY, "Smart HTTP proxy repository identity is invalid.");
  }
  if (
    typeof installationToken !== "string"
    || installationToken.length < 1
    || installationToken.length > 8 * 1024
    || /[\r\n\0]/.test(installationToken)
  ) {
    failCollector(CollectorErrorCode.E_COLLECTOR_CONFIG, "Installation token is invalid.");
  }

  const responseByteLimit = options.responseByteLimit ?? MAX_FETCH_RESPONSE_BYTES;
  const requestByteLimit = options.requestByteLimit ?? MAX_SMART_HTTP_REQUEST_BYTES;
  const aggregateRequestByteLimit =
    options.aggregateRequestByteLimit ?? MAX_SMART_HTTP_AGGREGATE_REQUEST_BYTES;
  const requestCountLimit = options.requestCountLimit ?? MAX_SMART_HTTP_REQUESTS;
  const timeoutMs = options.timeoutMs ?? CollectorLimits.GIT_TIMEOUT_MS;
  for (const value of [
    responseByteLimit,
    requestByteLimit,
    aggregateRequestByteLimit,
    requestCountLimit,
    timeoutMs
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      failCollector(CollectorErrorCode.E_COLLECTOR_CONFIG, "Smart HTTP proxy limit is invalid.");
    }
  }

  const outboundRequest = options.outboundRequest ?? https.request;
  if (typeof outboundRequest !== "function") {
    failCollector(CollectorErrorCode.E_COLLECTOR_CONFIG, "Smart HTTP outbound transport is invalid.");
  }
  const tokenBytes = Buffer.from(installationToken, "utf8");
  installationToken = null;

  const expectedBasePath = `/${owner}/${repository}.git`;
  const expectedGetTarget = `${expectedBasePath}/info/refs?service=git-upload-pack`;
  const expectedPostTarget = `${expectedBasePath}/git-upload-pack`;
  const sockets = new Set();
  const outboundRequests = new Set();
  const outboundResponses = new Set();
  const handlerTasks = new Set();
  let expectedHost = "";
  let closed = false;
  let closing = false;
  let closePromise = null;
  let fatalKind = null;
  let requestCount = 0;
  let aggregateRequestBytes = 0;
  let aggregateResponseBytes = 0;
  const deadline = Date.now() + timeoutMs;

  const markFatal = (kind) => {
    if (!fatalKind) fatalKind = kind;
  };
  const destroyActive = () => {
    for (const response of outboundResponses) response.destroy();
    for (const request of outboundRequests) request.destroy();
    for (const socket of sockets) socket.destroy();
  };
  const destroyActiveExcept = (keptSocket) => {
    for (const response of outboundResponses) response.destroy();
    for (const request of outboundRequests) request.destroy();
    for (const socket of sockets) {
      if (socket !== keptSocket) socket.destroy();
    }
  };
  const accountRequest = (bytes) => {
    if (aggregateRequestBytes + bytes > aggregateRequestByteLimit) {
      markFatal("aggregate_request_limit");
      throw new SmartHttpProxyError("aggregate_request_limit");
    }
    aggregateRequestBytes += bytes;
  };

  const server = http.createServer({
    maxHeaderSize: SMART_HTTP_HEADER_BYTES,
    requestTimeout: timeoutMs,
    headersTimeout: Math.min(timeoutMs, 15_000),
    keepAliveTimeout: 1_000
  }, (request, response) => {
    const task = (async () => {
      request.setTimeout(Math.max(1, deadline - Date.now()), () => {
        markFatal("request_timeout");
        request.destroy();
      });

      if (
        closed
        || closing
        || fatalKind
        || Date.now() >= deadline
      ) {
        endProxyResponseAndDestroy(request, response, 503);
        return;
      }
      if (request.headers.host !== expectedHost) {
        endProxyResponseAndDestroy(request, response, 400);
        return;
      }

      requestCount += 1;
      if (requestCount > requestCountLimit) {
        markFatal("request_count_limit");
        destroyActiveExcept(request.socket);
        endProxyResponseAndDestroy(request, response, 429);
        return;
      }

      const isGet = request.method === "GET" && request.url === expectedGetTarget;
      const isPost = request.method === "POST" && request.url === expectedPostTarget;
      if (!isGet && !isPost) {
        const exactPath = request.url === expectedGetTarget || request.url === expectedPostTarget;
        endProxyResponseAndDestroy(request, response, exactPath ? 405 : 404);
        return;
      }
      if (request.headers["transfer-encoding"] && request.headers["content-length"]) {
        endProxyResponseAndDestroy(request, response, 400);
        return;
      }
      const requestEncoding = String(request.headers["content-encoding"] || "identity")
        .trim()
        .toLowerCase();
      if (requestEncoding !== "identity") {
        endProxyResponseAndDestroy(request, response, 415);
        return;
      }
      const contentLengthHeader = request.headers["content-length"];
      if (contentLengthHeader !== undefined) {
        if (!/^(?:0|[1-9][0-9]*)$/.test(contentLengthHeader)) {
          endProxyResponseAndDestroy(request, response, 400);
          return;
        }
        const declared = Number.parseInt(contentLengthHeader, 10);
        if (!Number.isSafeInteger(declared) || declared > requestByteLimit) {
          request.pause();
          endProxyResponseAndDestroy(request, response, 413);
          return;
        }
        if (aggregateRequestBytes + declared > aggregateRequestByteLimit) {
          markFatal("aggregate_request_limit");
          request.pause();
          destroyActiveExcept(request.socket);
          endProxyResponseAndDestroy(request, response, 413);
          return;
        }
      }
      if (isGet) {
        if (
          request.headers["transfer-encoding"]
          || (contentLengthHeader !== undefined && contentLengthHeader !== "0")
        ) {
          endProxyResponseAndDestroy(request, response, 400);
          return;
        }
      } else {
        const contentType = String(request.headers["content-type"] || "")
          .split(";", 1)[0]
          .trim()
          .toLowerCase();
        if (contentType !== "application/x-git-upload-pack-request") {
          endProxyResponseAndDestroy(request, response, 415);
          return;
        }
      }

      let body;
      try {
        body = await readBoundedProxyRequest(
          request,
          isGet ? 0 : requestByteLimit,
          accountRequest
        );
      } catch (error) {
        const kind = error instanceof SmartHttpProxyError ? error.kind : "request_error";
        if (kind === "aggregate_request_limit") {
          markFatal(kind);
          destroyActiveExcept(request.socket);
        }
        if (kind.includes("limit")) {
          endProxyResponseAndDestroy(request, response, 413);
        } else {
          endProxyResponse(response, 400);
        }
        return;
      }
      if (closed || closing || fatalKind || Date.now() >= deadline) {
        endProxyResponseAndDestroy(request, response, 503);
        return;
      }

      const outboundHeaders = {
        host: "github.com",
        // GitHub smart HTTP authenticates installation tokens as the password
        // for the fixed x-access-token username.
        authorization: `Basic ${Buffer
          .from(`x-access-token:${tokenBytes.toString("utf8")}`, "utf8")
          .toString("base64")}`,
        "user-agent": "grok-review-app-fetch-guard/1",
        "accept-encoding": "identity",
        accept: isGet
          ? "application/x-git-upload-pack-advertisement"
          : "application/x-git-upload-pack-result"
      };
      if (isPost) {
        outboundHeaders["content-type"] = "application/x-git-upload-pack-request";
        outboundHeaders["content-length"] = String(body.length);
      }
      const gitProtocol = request.headers["git-protocol"];
      if (gitProtocol !== undefined) {
        if (gitProtocol !== "version=2") {
          endProxyResponseAndDestroy(request, response, 400);
          return;
        }
        outboundHeaders["git-protocol"] = "version=2";
      }

      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        let outbound;
        try {
          outbound = outboundRequest({
            protocol: "https:",
            hostname: "github.com",
            host: "github.com",
            port: 443,
            servername: "github.com",
            method: request.method,
            path: request.url,
            headers: outboundHeaders,
            rejectUnauthorized: true,
            agent: false,
            maxHeaderSize: SMART_HTTP_HEADER_BYTES
          }, (upstream) => {
            outboundResponses.add(upstream);
            upstream.once("close", () => outboundResponses.delete(upstream));

            const status = upstream.statusCode ?? 0;
            if (status >= 300 && status < 400) {
              markFatal("redirect_rejected");
              upstream.destroy();
              endProxyResponse(response, 502);
              finish();
              return;
            }
            if (status !== 200) {
              upstream.destroy();
              endProxyResponse(response, 502);
              finish();
              return;
            }
            const expectedType = isGet
              ? "application/x-git-upload-pack-advertisement"
              : "application/x-git-upload-pack-result";
            const responseType = String(upstream.headers["content-type"] || "")
              .split(";", 1)[0]
              .trim()
              .toLowerCase();
            if (responseType !== expectedType) {
              markFatal("response_type_rejected");
              upstream.destroy();
              endProxyResponse(response, 502);
              finish();
              return;
            }
            const contentEncoding = String(upstream.headers["content-encoding"] || "identity")
              .trim()
              .toLowerCase();
            if (contentEncoding !== "identity") {
              markFatal("response_encoding_rejected");
              upstream.destroy();
              endProxyResponse(response, 502);
              finish();
              return;
            }
            const upstreamLength = upstream.headers["content-length"];
            if (upstreamLength !== undefined) {
              if (!/^(?:0|[1-9][0-9]*)$/.test(upstreamLength)) {
                markFatal("response_length_invalid");
                upstream.destroy();
                endProxyResponse(response, 502);
                finish();
                return;
              }
              const declared = Number.parseInt(upstreamLength, 10);
              if (
                !Number.isSafeInteger(declared)
                || aggregateResponseBytes + declared > responseByteLimit
              ) {
                markFatal("aggregate_response_limit");
                upstream.destroy();
                endProxyResponse(response, 502);
                destroyActive();
                finish();
                return;
              }
            }

            response.writeHead(200, {
              "content-type": expectedType,
              "cache-control": "no-store"
            });
            upstream.on("data", (chunk) => {
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              if (aggregateResponseBytes + buffer.length > responseByteLimit) {
                markFatal("aggregate_response_limit");
                upstream.pause();
                upstream.destroy();
                response.destroy();
                destroyActive();
                finish();
                return;
              }
              aggregateResponseBytes += buffer.length;
              if (!response.write(buffer)) {
                upstream.pause();
                response.once("drain", () => {
                  if (!upstream.destroyed && !fatalKind) upstream.resume();
                });
              }
            });
            upstream.once("end", () => {
              if (!response.destroyed && !response.writableEnded) response.end();
              finish();
            });
            upstream.once("error", () => {
              if (!response.destroyed) response.destroy();
              finish();
            });
            response.once("close", () => {
              if (!upstream.complete) upstream.destroy();
              finish();
            });
          });
        } catch {
          markFatal("outbound_start_failed");
          endProxyResponse(response, 502);
          finish();
          return;
        }
        outboundRequests.add(outbound);
        outbound.once("close", () => outboundRequests.delete(outbound));
        outbound.once("error", () => {
          endProxyResponse(response, 502);
          finish();
        });
        outbound.setTimeout(Math.max(1, deadline - Date.now()), () => {
          markFatal("upstream_timeout");
          outbound.destroy();
        });
        outbound.end(body);
      });
    })();
    handlerTasks.add(task);
    task.then(
      () => handlerTasks.delete(task),
      () => {
        handlerTasks.delete(task);
        markFatal("proxy_handler_failed");
        endProxyResponse(response, 502);
      }
    );
  });
  server.on("error", () => markFatal("server_error"));

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.maxConnections = 4;

  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
    });
  } catch {
    tokenBytes.fill(0);
    failCollector(CollectorErrorCode.E_COLLECTOR_CONFIG, "Could not bind the trusted smart HTTP proxy.");
  }

  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
    server.close();
    tokenBytes.fill(0);
    failCollector(CollectorErrorCode.E_COLLECTOR_CONFIG, "Smart HTTP proxy did not bind exact loopback.");
  }
  expectedHost = `127.0.0.1:${address.port}`;
  const remoteUrl = `http://${expectedHost}${expectedBasePath}`;

  const close = () => {
    if (closed) return Promise.resolve();
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closing = true;
      destroyActive();
      await new Promise((resolve) => {
        server.close(() => resolve());
        setTimeout(resolve, 1_000).unref?.();
      });
      await Promise.race([
        Promise.allSettled([...handlerTasks]),
        new Promise((resolve) => setTimeout(resolve, 1_000))
      ]);
      tokenBytes.fill(0);
      closed = true;
      closing = false;
    })();
    return closePromise;
  };

  return Object.freeze({
    remoteUrl,
    close,
    snapshot() {
      return Object.freeze({
        closed,
        fatalKind,
        requestCount,
        aggregateRequestBytes,
        aggregateResponseBytes,
        responseByteLimit,
        requestByteLimit,
        aggregateRequestByteLimit,
        requestCountLimit
      });
    }
  });
}

const FORBIDDEN_ENV_PREFIXES = Object.freeze([
  "GIT_",
  "GH_",
  "GITHUB_",
  "XDG_",
  "NPM_",
  "NODE_"
]);

const FORBIDDEN_ENV_KEYS = Object.freeze(new Set([
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "PATH",
  "SHELL",
  "TERM",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "LESS",
  "MORE",
  "BROWSER",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GPG_AGENT_INFO",
  "ASKPASS",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "http_proxy",
  "https_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy"
]));

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isCommitSha(value) {
  return typeof value === "string" && COMMIT_SHA_RE.test(value);
}

/**
 * Opaque host-side proof: only a repository whose production fetch completed
 * through the bounded smart-HTTP guard can satisfy this check.
 * @param {object} binding
 */
export function hasBoundedFetchTransportProof(binding) {
  return Boolean(
    binding
    && binding.aggregateFetchTransportBounded === true
    && BOUNDED_FETCH_PROOFS.has(binding)
  );
}

/**
 * @param {string} owner
 * @returns {boolean}
 */
export function isValidGitHubOwner(owner) {
  return typeof owner === "string"
    && owner.length >= 1
    && owner.length <= CollectorLimits.MAX_OWNER_LENGTH
    && OWNER_RE.test(owner);
}

/**
 * @param {string} repository
 * @returns {boolean}
 */
export function isValidGitHubRepositoryName(repository) {
  if (typeof repository !== "string") return false;
  if (repository.length < 1 || repository.length > CollectorLimits.MAX_REPOSITORY_LENGTH) return false;
  if (repository === "." || repository === "..") return false;
  if (repository.toLowerCase().endsWith(".git")) return false;
  return REPO_RE.test(repository);
}

/**
 * Production-only canonical remote. Rejects every non-GitHub HTTPS form.
 * @param {string} owner
 * @param {string} repository
 * @returns {string}
 */
export function buildCanonicalGitHubHttpsRemote(owner, repository) {
  if (!isValidGitHubOwner(owner) || !isValidGitHubRepositoryName(repository)) {
    failCollector(
      CollectorErrorCode.E_COLLECTOR_REMOTE,
      "Repository identity is not a validated GitHub owner/name pair.",
      { owner: typeof owner === "string" ? owner.slice(0, 64) : null, repository: typeof repository === "string" ? repository.slice(0, 64) : null }
    );
  }
  return `https://github.com/${owner}/${repository}.git`;
}

/**
 * @param {string} remote
 * @returns {boolean}
 */
export function isCanonicalGitHubHttpsRemote(remote) {
  if (typeof remote !== "string") return false;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\.git$/.exec(remote);
  if (!match) return false;
  return isValidGitHubOwner(match[1]) && isValidGitHubRepositoryName(match[2]);
}

/**
 * Resolve an absolute, executable Git binary. Prefer an explicit absolute path.
 * @param {string|null|undefined} explicit
 * @returns {string}
 */
export function resolveVerifiedGitExecutable(explicit = undefined) {
  const hasExplicit = explicit != null;
  if (hasExplicit && (typeof explicit !== "string" || explicit.length === 0)) {
    failCollector(
      CollectorErrorCode.E_COLLECTOR_GIT_EXECUTABLE,
      "An explicit Git executable must be a non-empty absolute path."
    );
  }
  const candidates = hasExplicit ? [explicit] : [...GIT_CANDIDATES];

  for (const candidate of candidates) {
    try {
      if (typeof candidate !== "string" || !path.isAbsolute(candidate) || candidate.includes("\0")) {
        continue;
      }
      if (candidate.includes("..")) continue;
      const normalized = path.normalize(candidate);
      // Resolve symlinks to a real executable path; spawn the realpath only.
      const real = fs.realpathSync(normalized);
      if (!path.isAbsolute(real) || real.includes("\0")) continue;
      const realStat = fs.statSync(real);
      if (!realStat.isFile()) continue;
      fs.accessSync(real, fs.constants.X_OK);
      const probe = spawnSync(real, ["--version"], {
        env: {
          PATH: "/usr/bin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_ATTR_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          LANG: "C",
          LC_ALL: "C"
        },
        shell: false,
        windowsHide: true,
        timeout: GIT_PROBE_TIMEOUT_MS,
        killSignal: "SIGKILL",
        encoding: "buffer",
        maxBuffer: GIT_PROBE_OUTPUT_BYTES
      });
      if (probe.error || probe.signal || probe.status !== 0) continue;
      if (!Buffer.isBuffer(probe.stdout) || probe.stdout.length > GIT_PROBE_OUTPUT_BYTES) continue;
      if (!Buffer.isBuffer(probe.stderr) || probe.stderr.length > GIT_PROBE_OUTPUT_BYTES) continue;
      if (!/^git version [0-9]+(?:\.[0-9]+)+/u.test(probe.stdout.toString("utf8").trim())) continue;
      return real;
    } catch {
      // try next
    }
  }
  failCollector(
    CollectorErrorCode.E_COLLECTOR_GIT_EXECUTABLE,
    "An absolute verified Git executable is unavailable."
  );
}

/**
 * @param {string} directory
 */
function assertPrivateDirectory(directory) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    failCollector(CollectorErrorCode.E_COLLECTOR_CONFIG, "Private collector directory is missing.");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    failCollector(CollectorErrorCode.E_COLLECTOR_CONFIG, "Private collector path is not a safe directory.");
  }
  const real = fs.realpathSync(directory);
  if (real !== directory && path.resolve(directory) !== real) {
    // Accept only when realpath equals the normalized absolute path we created.
    if (fs.realpathSync(path.resolve(directory)) !== real) {
      failCollector(CollectorErrorCode.E_COLLECTOR_CONFIG, "Private collector directory resolved unsafely.");
    }
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    try {
      fs.chmodSync(directory, 0o700);
    } catch {
      failCollector(CollectorErrorCode.E_COLLECTOR_CONFIG, "Private collector directory mode is unsafe.");
    }
  }
}

/**
 * @param {string} root
 * @returns {{ home: string, template: string, hooks: string, configGlobal: string, xdgConfig: string, emptyFile: string }}
 */
function createIsolatedHomes(root) {
  const home = path.join(root, "home");
  const template = path.join(root, "template");
  const hooks = path.join(root, "hooks");
  const configGlobal = path.join(root, "gitconfig-global");
  const xdgConfig = path.join(root, "xdg-config");
  const xdgGit = path.join(xdgConfig, "git");
  fs.mkdirSync(home, { recursive: false, mode: 0o700 });
  fs.mkdirSync(template, { recursive: false, mode: 0o700 });
  fs.mkdirSync(hooks, { recursive: false, mode: 0o700 });
  fs.mkdirSync(xdgConfig, { recursive: false, mode: 0o700 });
  fs.mkdirSync(xdgGit, { recursive: false, mode: 0o700 });
  // Empty global config file (not a directory).
  fs.writeFileSync(configGlobal, "", { mode: 0o600, flag: "wx" });
  const emptyFile = path.join(root, "empty");
  fs.writeFileSync(emptyFile, "", { mode: 0o600, flag: "wx" });
  return { home, template, hooks, configGlobal, xdgConfig, emptyFile };
}

/**
 * @param {object} homes
 * @param {{ allowFileProtocol?: boolean, allowLoopbackHttp?: boolean }} options
 * @returns {NodeJS.ProcessEnv}
 */
function buildChildEnvironment(
  homes,
  { allowFileProtocol = false, allowLoopbackHttp = false } = {}
) {
  /** @type {Array<[string, string]>} */
  const configPairs = [
    ["core.hooksPath", homes.hooks],
    ["core.bare", "true"],
    ["core.fsmonitor", "false"],
    ["core.fsmonitorHook", ""],
    ["core.attributesFile", homes.emptyFile],
    ["core.excludesFile", homes.emptyFile],
    ["core.pager", "cat"],
    ["core.editor", "true"],
    ["core.sshCommand", "true"],
    ["core.untrackedCache", "false"],
    ["core.autocrlf", "false"],
    ["core.safecrlf", "false"],
    ["core.fileMode", "true"],
    ["core.symlinks", "true"],
    ["core.ignoreCase", "false"],
    ["core.replaceRefs", "false"],
    ["diff.external", ""],
    ["diff.renames", "false"],
    ["diff.mnemonicPrefix", "false"],
    ["diff.noprefix", "false"],
    ["diff.orderFile", homes.emptyFile],
    ["diff.wsErrorHighlight", ""],
    ["interactive.diffFilter", ""],
    ["merge.renames", "false"],
    ["merge.tool", ""],
    ["mergetool.prompt", "false"],
    ["submodule.recurse", "false"],
    ["fetch.recurseSubmodules", "false"],
    ["fetch.parallel", "1"],
    ["fetch.negotiationAlgorithm", "consecutive"],
    ["transfer.fsckObjects", "1"],
    ["fetch.fsckObjects", "1"],
    ["receive.fsckObjects", "1"],
    ["gc.auto", "0"],
    ["gc.autoDetach", "false"],
    ["credential.helper", ""],
    ["credential.useHttpPath", "false"],
    ["http.followRedirects", "false"],
    ["http.emptyAuth", "true"],
    ["http.sslVerify", "true"],
    ["protocol.allow", "never"],
    ["protocol.https.allow", "always"],
    ["protocol.http.allow", allowLoopbackHttp ? "always" : "never"],
    ["protocol.git.allow", "never"],
    ["protocol.ssh.allow", "never"],
    ["protocol.ext.allow", "never"],
    ["protocol.file.allow", allowFileProtocol ? "always" : "never"],
    ["lfs.url", ""],
    ["filter.lfs.smudge", ""],
    ["filter.lfs.clean", ""],
    ["filter.lfs.process", ""],
    ["filter.lfs.required", "false"]
  ];

  /** @type {NodeJS.ProcessEnv} */
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: homes.home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: homes.configGlobal,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: homes.template,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "true",
    GIT_CONFIG_COUNT: String(configPairs.length),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_PAGER: "cat",
    PAGER: "cat",
    EDITOR: "true",
    VISUAL: "true",
    LANG: "C",
    LC_ALL: "C",
    XDG_CONFIG_HOME: homes.xdgConfig,
    XDG_CACHE_HOME: path.join(homes.home, "cache"),
    XDG_DATA_HOME: path.join(homes.home, "data")
  };

  for (let i = 0; i < configPairs.length; i += 1) {
    env[`GIT_CONFIG_KEY_${i}`] = configPairs[i][0];
    env[`GIT_CONFIG_VALUE_${i}`] = configPairs[i][1];
  }

  // Scrub any accidental inheritance if caller merges later.
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_TRACE") || key === "GIT_CURL_VERBOSE") {
      delete env[key];
    }
  }

  return env;
}

/**
 * Trusted -c overrides passed on argv (no secrets).
 * @param {{ hooks: string, emptyFile: string }} homes
 * @param {{ allowFileProtocol?: boolean, allowLoopbackHttp?: boolean, noLazyFetch?: boolean }} options
 * @returns {string[]}
 */
function trustedConfigArgs(
  homes,
  { allowFileProtocol = false, allowLoopbackHttp = false, noLazyFetch = false } = {}
) {
  const pairs = [
    ["core.hooksPath", homes.hooks],
    ["core.fsmonitor", "false"],
    ["core.attributesFile", homes.emptyFile],
    ["core.excludesFile", homes.emptyFile],
    ["core.pager", "cat"],
    ["core.editor", "true"],
    ["core.sshCommand", "true"],
    ["core.replaceRefs", "false"],
    ["diff.external", ""],
    ["diff.renames", "false"],
    ["interactive.diffFilter", ""],
    ["submodule.recurse", "false"],
    ["fetch.recurseSubmodules", "false"],
    ["protocol.allow", "never"],
    ["protocol.https.allow", "always"],
    ["protocol.http.allow", allowLoopbackHttp ? "always" : "never"],
    ["protocol.file.allow", allowFileProtocol ? "always" : "never"],
    ["protocol.ssh.allow", "never"],
    ["protocol.git.allow", "never"],
    ["protocol.ext.allow", "never"],
    ["credential.helper", ""],
    ["gc.auto", "0"]
  ];
  if (noLazyFetch) {
    pairs.push(["extensions.partialClone", "origin"]);
  }
  /** @type {string[]} */
  const args = ["--no-pager"];
  for (const [key, value] of pairs) {
    args.push("-c", `${key}=${value}`);
  }
  return args;
}

/**
 * @param {Buffer} buffer
 * @param {number} max
 * @returns {Buffer}
 */
function truncateBuffer(buffer, max) {
  if (buffer.length <= max) return buffer;
  return buffer.subarray(0, max);
}

/**
 * Kill a process group best-effort (POSIX). Never throws.
 * @param {import("node:child_process").ChildProcessWithoutNullStreams} child
 */
function killProcessGroup(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      child.kill("SIGKILL");
      return;
    }
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
}

/**
 * Bounded Git invocation with process-group cleanup on overflow/timeout.
 * @param {object} binding
 * @param {string[]} gitArgs
 * @param {{ maxStdout?: number, maxStderr?: number, timeoutMs?: number, allowFailure?: boolean, encoding?: "buffer"|"utf8" }} [options]
 * @returns {Promise<{ status: number|null, stdout: Buffer, stderr: Buffer, signal: NodeJS.Signals|null }>}
 */
export function runTrustedGit(binding, gitArgs, options = {}) {
  if (!binding || binding.disposed || binding.disposalFailed) {
    return Promise.reject(new CollectorError(
      CollectorErrorCode.E_COLLECTOR_STATE,
      "Collector repository is not available."
    ));
  }
  if (!Array.isArray(gitArgs) || gitArgs.some((a) => typeof a !== "string")) {
    return Promise.reject(new CollectorError(
      CollectorErrorCode.E_COLLECTOR_GIT,
      "Git argument vector is invalid."
    ));
  }

  const maxStdout = options.maxStdout ?? CollectorLimits.MAX_STDOUT_DEFAULT_BYTES;
  const maxStderr = options.maxStderr ?? CollectorLimits.MAX_STDERR_BYTES;
  const timeoutMs = options.timeoutMs ?? CollectorLimits.GIT_TIMEOUT_MS;
  const allowFailure = options.allowFailure === true;
  const stdin = options.stdin == null
    ? null
    : (Buffer.isBuffer(options.stdin) ? options.stdin : Buffer.from(String(options.stdin), "utf8"));
  if (stdin && stdin.length > MAX_GIT_STDIN_BYTES) {
    return Promise.reject(new CollectorError(
      CollectorErrorCode.E_COLLECTOR_OVERFLOW,
      "Git stdin exceeded the bounded input limit.",
      { byteCount: stdin.length, limit: MAX_GIT_STDIN_BYTES }
    ));
  }

  const prefix = trustedConfigArgs(binding.homes, {
    allowFileProtocol: binding.allowFileProtocol === true,
    allowLoopbackHttp: binding.allowLoopbackHttp === true,
    noLazyFetch: binding.sealed === true || binding.lazyFetchDisabled === true
  });
  const args = [...prefix, ...gitArgs];

  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const stdoutChunks = [];
    /** @type {Buffer[]} */
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflowed = false;
    let settled = false;

    const env = { ...binding.env };
    if (binding.sealed || binding.lazyFetchDisabled) {
      env.GIT_NO_LAZY_FETCH = "1";
    }

    let child;
    try {
      child = spawn(binding.gitExecutable, args, {
        cwd: binding.barePath,
        env,
        shell: false,
        windowsHide: true,
        // Detached so we can signal the whole process group on overflow.
        detached: process.platform !== "win32",
        stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"]
      });
    } catch (error) {
      reject(new CollectorError(
        CollectorErrorCode.E_COLLECTOR_GIT,
        "Failed to spawn the verified Git executable."
      ));
      return;
    }

    const timer = setTimeout(() => {
      overflowed = true;
      killProcessGroup(child);
    }, timeoutMs);

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };

    child.stdout.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buf.length;
      if (stdoutBytes > maxStdout) {
        overflowed = true;
        killProcessGroup(child);
        return;
      }
      stdoutChunks.push(buf);
    });
    child.stderr.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += buf.length;
      if (stderrBytes > maxStderr) {
        // Bound stderr retention but keep reading until kill.
        if (stderrBytes - buf.length < maxStderr) {
          stderrChunks.push(truncateBuffer(buf, maxStderr - (stderrBytes - buf.length)));
        }
        overflowed = true;
        killProcessGroup(child);
        return;
      }
      stderrChunks.push(buf);
    });

    child.on("error", () => {
      finish(new CollectorError(
        CollectorErrorCode.E_COLLECTOR_GIT,
        "Git process failed to start."
      ));
    });

    if (stdin) {
      child.stdin.on("error", () => {
        // A child that exits before consuming bounded stdin is handled by close.
      });
      child.stdin.end(stdin);
    }

    child.on("close", (status, signal) => {
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      if (overflowed) {
        finish(new CollectorError(
          CollectorErrorCode.E_COLLECTOR_OVERFLOW,
          "Git command exceeded bounded runtime or output limits."
        ));
        return;
      }
      if (!allowFailure && (status !== 0 || signal)) {
        finish(new CollectorError(
          CollectorErrorCode.E_COLLECTOR_GIT,
          "Git command failed closed.",
          {
            status: status == null ? null : status,
            kind: gitArgs.slice(0, 2).join(" ")
          }
        ));
        return;
      }
      finish(null, { status, stdout, stderr, signal });
    });
  });
}

/**
 * Recursive private directory removal.
 * @param {string} target
 */
function rmPrivateTree(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
}

/**
 * @typedef {object} ExactHeadRepository
 * @property {string} gitExecutable
 * @property {string} barePath
 * @property {string} workspaceRoot
 * @property {boolean} disposed
 * @property {boolean} disposalFailed
 * @property {boolean} sealed
 * @property {boolean} lazyFetchDisabled
 * @property {number} blobFilterLimitBytes
 * @property {boolean} allowFileProtocol
 * @property {boolean} allowLoopbackHttp
 * @property {boolean} aggregateFetchTransportBounded
 * @property {null|{ close: () => Promise<void>, snapshot: () => object }} transportGuard
 * @property {NodeJS.ProcessEnv} env
 * @property {object} homes
 * @property {string} baseTipSha
 * @property {string} headSha
 * @property {string} mergeBaseSha
 * @property {string} owner
 * @property {string} repository
 * @property {number} pullNumber
 * @property {(args: string[], options?: object) => Promise<{ status: number|null, stdout: Buffer, stderr: Buffer, signal: NodeJS.Signals|null }>} git
 * @property {() => Promise<void>} seal
 * @property {() => Promise<void>} dispose
 */

/**
 * Open a private bare repository, fetch exact base/head refs, validate SHAs,
 * and compute a single merge-base. Disposal is registered for every failure.
 *
 * Production path constructs only canonical GitHub HTTPS remotes.
 * @param {{
 *   owner: string,
 *   repository: string,
 *   pullNumber: number,
 *   baseRef: string,
 *   baseTipSha: string,
 *   headSha: string,
 *   installationToken?: string|null,
 *   tempRoot?: string|null
 * }} input
 * @param {{ testLocalRemoteUrl?: string|null, gitExecutable?: string|null }} [testOnly]
 * @returns {Promise<ExactHeadRepository>}
 */
async function openExactHeadRepositoryInternal(input, testOnly = {}) {
  const owner = input?.owner;
  const repository = input?.repository;
  const pullNumber = input?.pullNumber;
  const baseRef = input?.baseRef;
  const baseTipSha = input?.baseTipSha;
  const headSha = input?.headSha;
  const testLocalRemoteUrl = testOnly.testLocalRemoteUrl ?? null;
  let installationToken = input?.installationToken ?? null;

  if (!isValidGitHubOwner(owner) || !isValidGitHubRepositoryName(repository)) {
    failCollector(CollectorErrorCode.E_COLLECTOR_IDENTITY, "Owner or repository identity is invalid.");
  }
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1 || pullNumber > 2_000_000_000) {
    failCollector(CollectorErrorCode.E_COLLECTOR_IDENTITY, "Pull request number is invalid.", {
      pullNumber: Number.isFinite(pullNumber) ? Number(pullNumber) : null
    });
  }
  if (typeof baseRef !== "string" || !BASE_REF_RE.test(baseRef) || baseRef.startsWith("refs/")) {
    failCollector(CollectorErrorCode.E_COLLECTOR_REF, "Base branch ref is invalid.");
  }
  if (!isCommitSha(baseTipSha) || !isCommitSha(headSha)) {
    failCollector(CollectorErrorCode.E_COLLECTOR_REF, "Base tip or head SHA is not a commit object id.");
  }

  let remoteUrl;
  let allowFileProtocol = false;
  let allowLoopbackHttp = false;
  if (typeof testLocalRemoteUrl === "string" && testLocalRemoteUrl.length > 0) {
    // Explicit test hook only — never a production escape hatch for arbitrary dirs.
    if (!(testLocalRemoteUrl.startsWith("file:") || path.isAbsolute(testLocalRemoteUrl))) {
      failCollector(
        CollectorErrorCode.E_COLLECTOR_REMOTE,
        "Test local transport must be an absolute path or file: URL."
      );
    }
    remoteUrl = testLocalRemoteUrl;
    allowFileProtocol = true;
  } else {
    if (testLocalRemoteUrl) {
      failCollector(
        CollectorErrorCode.E_COLLECTOR_REMOTE,
        "Local transport is disabled on the production open path."
      );
    }
    const canonicalRemote = buildCanonicalGitHubHttpsRemote(owner, repository);
    if (!isCanonicalGitHubHttpsRemote(canonicalRemote)) {
      failCollector(CollectorErrorCode.E_COLLECTOR_REMOTE, "Remote is not the canonical GitHub HTTPS form.");
    }
    if (
      typeof installationToken !== "string"
      || installationToken.length < 1
      || installationToken.length > 8 * 1024
      || /[\r\n\0]/.test(installationToken)
    ) {
      failCollector(CollectorErrorCode.E_COLLECTOR_CONFIG, "Installation token is invalid.");
    }
    // Git itself is allowed to contact only an internally-created loopback
    // smart-HTTP guard. The guard pins the sole outbound target to github.com.
    remoteUrl = null;
    allowLoopbackHttp = true;
  }

  const gitExecutable = resolveVerifiedGitExecutable(testOnly.gitExecutable);

  const parentTmp = typeof input?.tempRoot === "string" && path.isAbsolute(input.tempRoot)
    ? input.tempRoot
    : os.tmpdir();
  let workspaceRoot;
  try {
    workspaceRoot = fs.mkdtempSync(path.join(parentTmp, "grok-review-exact-head-"));
    fs.chmodSync(workspaceRoot, 0o700);
  } catch {
    failCollector(CollectorErrorCode.E_COLLECTOR_CONFIG, "Could not create a private collector workspace.");
  }

  /** @type {ExactHeadRepository|null} */
  let binding = null;
  const disposeEarly = async () => {
    if (binding) {
      await binding.dispose();
      return;
    }
    try {
      rmPrivateTree(workspaceRoot);
    } catch {
      failCollector(CollectorErrorCode.E_COLLECTOR_DISPOSAL, "Partial collector workspace disposal failed.");
    }
  };

  try {
    assertPrivateDirectory(workspaceRoot);
    const homes = createIsolatedHomes(workspaceRoot);
    const barePath = path.join(workspaceRoot, "repo.git");
    fs.mkdirSync(barePath, { recursive: false, mode: 0o700 });

    const env = buildChildEnvironment(homes, {
      allowFileProtocol,
      allowLoopbackHttp
    });

    binding = {
      gitExecutable,
      barePath,
      workspaceRoot,
      disposed: false,
      disposalFailed: false,
      sealed: false,
      lazyFetchDisabled: false,
      blobFilterLimitBytes: MAX_FETCHED_BLOB_OBJECT_BYTES,
      allowFileProtocol,
      allowLoopbackHttp,
      aggregateFetchTransportBounded: false,
      transportGuard: null,
      env,
      homes,
      baseTipSha,
      headSha,
      mergeBaseSha: "",
      owner,
      repository,
      pullNumber,
      async git(gitArgs, options) {
        return runTrustedGit(binding, gitArgs, options);
      },
      async seal() {
        return sealExactHeadRepository(binding);
      },
      async dispose() {
        return disposeExactHeadRepository(binding);
      }
    };

    // Initialize bare repository with empty template (no sample hooks).
    // cwd is already barePath; init in-place so hooks/template stay empty.
    await binding.git(["init", "--bare", "--template", homes.template], {
      maxStdout: 64 * 1024
    });

    if (allowLoopbackHttp) {
      binding.transportGuard = await createBoundedGitHubSmartHttpProxy({
        owner,
        repository,
        installationToken
      });
      installationToken = null;
      remoteUrl = binding.transportGuard.remoteUrl;
    }

    // Ensure origin is only the test file URL or internally-created loopback
    // URL. The installation token is never in Git URL, argv, env, or config.
    await binding.git(["remote", "add", "origin", remoteUrl]);

    // Full history, blob filter, no tags, no refmap, no submodules.
    // Fetch authoritative base branch ref and pull head into private refs.
    const baseDst = "refs/grok/base";
    const headDst = "refs/grok/head";
    const fetchRefspecs = [
      `+refs/heads/${baseRef}:${baseDst}`,
      `+refs/pull/${pullNumber}/head:${headDst}`
    ];

    let fetchError = null;
    try {
      await binding.git([
        "-c", "fetch.refmap=",
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        `--filter=blob:limit=${MAX_FETCHED_BLOB_OBJECT_BYTES + 1}`,
        "--update-head-ok",
        "origin",
        ...fetchRefspecs
      ], {
        maxStdout: 1024 * 1024,
        timeoutMs: CollectorLimits.GIT_TIMEOUT_MS
      });
    } catch (error) {
      fetchError = error;
    } finally {
      if (binding.transportGuard) {
        const guard = binding.transportGuard;
        await guard.close();
        const snapshot = guard.snapshot();
        binding.transportGuard = null;
        binding.aggregateFetchTransportBounded =
          fetchError == null
          && snapshot.closed === true
          && snapshot.fatalKind == null
          && snapshot.aggregateResponseBytes <= snapshot.responseByteLimit;
      }
    }
    if (fetchError) {
      if (fetchError instanceof CollectorError && fetchError.code === CollectorErrorCode.E_COLLECTOR_OVERFLOW) {
        throw fetchError;
      }
      failCollector(CollectorErrorCode.E_COLLECTOR_FETCH, "Exact-head fetch failed closed.");
    }
    if (allowLoopbackHttp && binding.aggregateFetchTransportBounded !== true) {
      failCollector(CollectorErrorCode.E_COLLECTOR_FETCH, "Bounded smart HTTP fetch did not complete safely.");
    }
    if (binding.aggregateFetchTransportBounded === true) {
      BOUNDED_FETCH_PROOFS.add(binding);
    }

    // The bounded fetch is the only operation allowed to contact the promisor
    // remote for object material. Every later tree/diff/blob read is local-only.
    binding.lazyFetchDisabled = true;
    binding.env.GIT_NO_LAZY_FETCH = "1";

    const readRef = async (refName) => {
      const result = await binding.git(["rev-parse", "--verify", `${refName}^{commit}`], {
        maxStdout: 512
      });
      const sha = result.stdout.toString("utf8").trim();
      if (!isCommitSha(sha)) {
        failCollector(CollectorErrorCode.E_COLLECTOR_REF, "Fetched ref is not a commit SHA.", {
          refName
        });
      }
      return sha;
    };

    const fetchedBase = await readRef(baseDst);
    const fetchedHead = await readRef(headDst);

    if (fetchedBase !== baseTipSha) {
      failCollector(CollectorErrorCode.E_COLLECTOR_REF, "Fetched base tip does not match the exact API SHA.", {
        expectedSha: baseTipSha,
        actualSha: fetchedBase,
        refName: baseDst
      });
    }
    if (fetchedHead !== headSha) {
      failCollector(CollectorErrorCode.E_COLLECTOR_REF, "Fetched head does not match the exact API SHA.", {
        expectedSha: headSha,
        actualSha: fetchedHead,
        refName: headDst
      });
    }

    // Exactly one merge base (full history was fetched; no depth limit).
    const mb = await binding.git(["merge-base", baseTipSha, headSha], {
      maxStdout: 512,
      allowFailure: true
    });
    if (mb.status !== 0) {
      failCollector(CollectorErrorCode.E_COLLECTOR_MERGE_BASE, "Could not compute a merge base for base tip and head.");
    }
    const mergeBases = mb.stdout.toString("utf8").trim().split(/\s+/).filter(Boolean);
    if (mergeBases.length !== 1 || !isCommitSha(mergeBases[0])) {
      failCollector(CollectorErrorCode.E_COLLECTOR_MERGE_BASE, "Expected exactly one merge-base commit.");
    }
    // Confirm uniqueness with --all
    const mbAll = await binding.git(["merge-base", "--all", baseTipSha, headSha], {
      maxStdout: 4096
    });
    const allBases = mbAll.stdout.toString("utf8").trim().split(/\n/).map((s) => s.trim()).filter(Boolean);
    if (allBases.length !== 1 || allBases[0] !== mergeBases[0]) {
      failCollector(CollectorErrorCode.E_COLLECTOR_MERGE_BASE, "Ambiguous merge bases; refusing multi-base PR graphs.");
    }

    binding.baseTipSha = baseTipSha;
    binding.headSha = headSha;
    binding.mergeBaseSha = mergeBases[0];
    return binding;
  } catch (error) {
    await disposeEarly();
    if (error instanceof CollectorError) throw error;
    failCollector(CollectorErrorCode.E_COLLECTOR_CONFIG, "Exact-head repository open failed closed.");
  }
}

/**
 * Hydrate specific blob OIDs through the promisor remote (pre-seal only).
 * @param {ExactHeadRepository} binding
 * @param {string[]} blobOids
 */
export async function hydrateBlobs(binding, blobOids) {
  if (!binding || binding.disposed) {
    failCollector(CollectorErrorCode.E_COLLECTOR_STATE, "Collector repository is not available.");
  }
  if (binding.sealed || binding.lazyFetchDisabled) {
    failCollector(CollectorErrorCode.E_COLLECTOR_SEAL, "Lazy blob hydration is disabled.");
  }
  const unique = [...new Set(blobOids.filter((oid) => isCommitSha(oid) || /^[0-9a-f]{64}$/.test(oid)))];
  for (const oid of unique) {
    // cat-file forces promisor materialization while origin still exists.
    const probe = await binding.git(["cat-file", "-t", oid], {
      maxStdout: 64,
      allowFailure: true
    });
    if (probe.status !== 0 || probe.stdout.toString("utf8").trim() !== "blob") {
      failCollector(CollectorErrorCode.E_COLLECTOR_GIT, "Required blob could not be hydrated.", {
        blobOid: oid
      });
    }
  }
}

/**
 * Read a blob by exact OID without filters/textconv. Pre- or post-seal when local.
 * @param {ExactHeadRepository} binding
 * @param {string} blobOid
 * @param {number} [maxBytes]
 * @returns {Promise<Buffer>}
 */
export async function readBlobOid(binding, blobOid, maxBytes = CollectorLimits.MAX_BLOB_HYDRATE_BYTES) {
  if (!binding || binding.disposed) {
    failCollector(CollectorErrorCode.E_COLLECTOR_STATE, "Collector repository is not available.");
  }
  if (!isCommitSha(blobOid) && !/^[0-9a-f]{64}$/.test(blobOid || "")) {
    failCollector(CollectorErrorCode.E_COLLECTOR_GIT, "Blob OID is invalid.");
  }
  const type = await binding.git(["cat-file", "-t", blobOid], {
    maxStdout: 64,
    allowFailure: true
  });
  if (type.status !== 0 || type.stdout.toString("utf8").trim() !== "blob") {
    if (binding.lazyFetchDisabled && binding.blobFilterLimitBytes > maxBytes) {
      failCollector(CollectorErrorCode.E_COLLECTOR_OVERFLOW, "Blob was omitted by the bounded fetch filter.", {
        blobOid,
        limit: maxBytes
      });
    }
    failCollector(CollectorErrorCode.E_COLLECTOR_GIT, "Object is not a readable blob.", {
      blobOid,
      objectType: type.stdout.toString("utf8").trim().slice(0, 32) || null
    });
  }
  const sizeResult = await binding.git(["cat-file", "-s", blobOid], {
    maxStdout: 64
  });
  const size = Number.parseInt(sizeResult.stdout.toString("utf8").trim(), 10);
  if (!Number.isSafeInteger(size) || size < 0) {
    failCollector(CollectorErrorCode.E_COLLECTOR_GIT, "Blob size is invalid.", { blobOid });
  }
  if (size > maxBytes) {
    failCollector(CollectorErrorCode.E_COLLECTOR_OVERFLOW, "Blob exceeds bounded read limit.", {
      blobOid,
      byteCount: size,
      limit: maxBytes
    });
  }
  const body = await binding.git(["cat-file", "blob", blobOid], {
    maxStdout: maxBytes
  });
  if (body.stdout.length !== size) {
    failCollector(CollectorErrorCode.E_COLLECTOR_GIT, "Blob byte length mismatch.", {
      blobOid,
      byteCount: body.stdout.length
    });
  }
  return body.stdout;
}

/**
 * @param {ExactHeadRepository} binding
 * @param {string} treeish
 * @param {string} repoPath UTF-8 path relative to repo root
 * @returns {Promise<{ mode: string, type: string, oid: string, path: string }|null>}
 */
export async function lsTreePath(binding, treeish, repoPath) {
  if (!binding || binding.disposed) {
    failCollector(CollectorErrorCode.E_COLLECTOR_STATE, "Collector repository is not available.");
  }
  if (!isCommitSha(treeish) && !/^[0-9a-f]{64}$/.test(treeish || "")) {
    failCollector(CollectorErrorCode.E_COLLECTOR_GIT, "Tree-ish is invalid.");
  }
  if (
    typeof repoPath !== "string"
    || repoPath.length < 1
    || Buffer.byteLength(repoPath, "utf8") > CollectorLimits.MAX_PATH_BYTES
    || repoPath.includes("\0")
  ) {
    failCollector(CollectorErrorCode.E_COLLECTOR_PATH, "Tree path is invalid or exceeds its byte limit.");
  }
  // Literal pathspec semantics are mandatory: a repository may contain names
  // that begin with Git pathspec magic such as `:/`.
  const result = await binding.git([
    "--literal-pathspecs",
    "ls-tree",
    "-z",
    "--full-tree",
    treeish,
    "--",
    repoPath
  ], {
    maxStdout: 16 * 1024,
    allowFailure: true
  });
  if (result.status !== 0) {
    failCollector(CollectorErrorCode.E_COLLECTOR_GIT, "ls-tree failed closed.", {
      status: result.status
    });
  }
  if (result.stdout.length === 0) return null;
  // Format: <mode> SP <type> SP <oid> TAB <path> NUL
  const raw = result.stdout;
  if (raw[raw.length - 1] !== 0 || raw.indexOf(0) !== raw.length - 1) {
    failCollector(CollectorErrorCode.E_COLLECTOR_GIT, "ls-tree must return exactly one NUL record.");
  }
  const record = raw.subarray(0, raw.length - 1);
  const tab = record.indexOf(0x09);
  if (tab < 0) {
    failCollector(CollectorErrorCode.E_COLLECTOR_GIT, "ls-tree output was malformed.");
  }
  const meta = record.subarray(0, tab).toString("latin1");
  const pathBytes = record.subarray(tab + 1);
  const parts = meta.split(" ");
  if (parts.length !== 3) {
    failCollector(CollectorErrorCode.E_COLLECTOR_GIT, "ls-tree metadata was malformed.");
  }
  const [mode, type, oid] = parts;
  if (!/^[0-7]{6}$/.test(mode) || !/^(blob|tree|commit)$/.test(type) || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(oid)) {
    failCollector(CollectorErrorCode.E_COLLECTOR_GIT, "ls-tree entry failed validation.");
  }
  let decodedPath;
  try {
    decodedPath = new TextDecoder("utf-8", { fatal: true }).decode(pathBytes);
  } catch {
    failCollector(CollectorErrorCode.E_COLLECTOR_GIT, "ls-tree path is not valid UTF-8.");
  }
  if (decodedPath !== repoPath) {
    failCollector(CollectorErrorCode.E_COLLECTOR_GIT, "ls-tree returned a different path than requested.");
  }
  return {
    mode,
    type,
    oid,
    path: decodedPath
  };
}

/**
 * Remove remotes and auth surface; disable lazy fetch. Leaves only local objects.
 * @param {ExactHeadRepository} binding
 */
async function sealExactHeadRepository(binding) {
  if (!binding || binding.disposed) {
    failCollector(CollectorErrorCode.E_COLLECTOR_STATE, "Collector repository is not available.");
  }
  if (binding.sealed) return;

  try {
    // List remotes and remove all.
    const remotes = await binding.git(["remote"], {
      maxStdout: 16 * 1024,
      allowFailure: true
    });
    const names = remotes.stdout.toString("utf8").split(/\n/).map((s) => s.trim()).filter(Boolean);
    for (const name of names) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
        failCollector(CollectorErrorCode.E_COLLECTOR_SEAL, "Remote name is unsafe during seal.");
      }
      await binding.git(["remote", "remove", name], { allowFailure: true, maxStdout: 1024 });
    }

    // Scrub any persisted config keys that could reintroduce auth or remotes.
    const scrubKeys = [
      "http.extraHeader",
      "http.cookieFile",
      "credential.helper",
      "remote.origin.url",
      "remote.origin.promisor",
      "remote.origin.partialclonefilter",
      "core.sshCommand"
    ];
    for (const key of scrubKeys) {
      await binding.git(["config", "--unset-all", key], { allowFailure: true, maxStdout: 1024 });
    }

    // Ensure no remotes remain.
    const after = await binding.git(["remote"], { maxStdout: 4096, allowFailure: true });
    if (after.stdout.toString("utf8").trim().length > 0) {
      failCollector(CollectorErrorCode.E_COLLECTOR_SEAL, "Remotes remained after seal.");
    }

    // Drop token from live child environment so later reads cannot use it.
    if (binding.env) {
      const count = Number.parseInt(String(binding.env.GIT_CONFIG_COUNT || "0"), 10);
      if (Number.isSafeInteger(count) && count > 0) {
        /** @type {Array<[string, string]>} */
        const kept = [];
        for (let i = 0; i < count; i += 1) {
          const k = binding.env[`GIT_CONFIG_KEY_${i}`];
          const v = binding.env[`GIT_CONFIG_VALUE_${i}`];
          if (typeof k !== "string" || typeof v !== "string") continue;
          if (k === "http.extraHeader" || k.startsWith("credential.")) continue;
          kept.push([k, v]);
        }
        for (let i = 0; i < count; i += 1) {
          delete binding.env[`GIT_CONFIG_KEY_${i}`];
          delete binding.env[`GIT_CONFIG_VALUE_${i}`];
        }
        binding.env.GIT_CONFIG_COUNT = String(kept.length);
        for (let i = 0; i < kept.length; i += 1) {
          binding.env[`GIT_CONFIG_KEY_${i}`] = kept[i][0];
          binding.env[`GIT_CONFIG_VALUE_${i}`] = kept[i][1];
        }
      }
      binding.env.GIT_NO_LAZY_FETCH = "1";
    }

    binding.sealed = true;
  } catch (error) {
    if (error instanceof CollectorError) throw error;
    failCollector(CollectorErrorCode.E_COLLECTOR_SEAL, "Repository seal failed closed.");
  }
}

/**
 * @param {ExactHeadRepository} binding
 */
async function disposeExactHeadRepository(binding) {
  if (!binding || binding.disposed) return;
  binding.sealed = true;
  binding.lazyFetchDisabled = true;
  try {
    if (binding.transportGuard) {
      await binding.transportGuard.close();
      binding.transportGuard = null;
    }
    // Best-effort wipe of env token material.
    if (binding.env) {
      for (const key of Object.keys(binding.env)) {
        if (key.startsWith("GIT_CONFIG_VALUE_") || key.startsWith("GIT_CONFIG_KEY_")) {
          binding.env[key] = "";
          delete binding.env[key];
        }
      }
    }
    rmPrivateTree(binding.workspaceRoot);
    binding.disposed = true;
    binding.disposalFailed = false;
  } catch {
    try {
      rmPrivateTree(binding.workspaceRoot);
    } catch {
      binding.disposalFailed = true;
      failCollector(CollectorErrorCode.E_COLLECTOR_DISPOSAL, "Private collector workspace disposal failed.");
    }
    binding.disposed = true;
    binding.disposalFailed = false;
  }
}

/**
 * Production open path: rejects every non-GitHub HTTPS remote and any test transport.
 * @param {object} input
 */
export async function openProductionExactHeadRepository(input) {
  if (
    Object.prototype.hasOwnProperty.call(input || {}, "allowTestLocalTransport")
    || Object.prototype.hasOwnProperty.call(input || {}, "testLocalRemoteUrl")
  ) {
    failCollector(
      CollectorErrorCode.E_COLLECTOR_REMOTE,
      "Production open path rejects local transport hooks."
    );
  }
  if (Object.prototype.hasOwnProperty.call(input || {}, "gitExecutable")) {
    failCollector(
      CollectorErrorCode.E_COLLECTOR_GIT_EXECUTABLE,
      "Production open path does not accept a Git executable override."
    );
  }
  return openExactHeadRepositoryInternal(input);
}

/**
 * Explicit local-transport entry used only by collector fixtures.
 * @param {object} input
 */
export async function openTestExactHeadRepository(input) {
  const testLocalRemoteUrl = input?.testLocalRemoteUrl;
  if (typeof testLocalRemoteUrl !== "string" || testLocalRemoteUrl.length < 1) {
    failCollector(CollectorErrorCode.E_COLLECTOR_REMOTE, "Test collector requires an explicit local remote.");
  }
  return openExactHeadRepositoryInternal(input, {
    testLocalRemoteUrl,
    gitExecutable: input?.gitExecutable
  });
}

/**
 * Assert the child environment does not inherit hostile Git configuration.
 * Used by security tests.
 * @param {NodeJS.ProcessEnv} env
 */
export function assertAllowlistedCollectorEnv(env) {
  if (!env || typeof env !== "object") {
    failCollector(CollectorErrorCode.E_COLLECTOR_CONFIG, "Collector environment is missing.");
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_TRACE") || key === "GIT_CURL_VERBOSE" || key === "GIT_SSH" || key === "GIT_SSH_COMMAND") {
      failCollector(CollectorErrorCode.E_COLLECTOR_CONFIG, "Forbidden Git environment key present.");
    }
  }
  // Must not inherit ambient HOME/config from the parent process identity.
  if (typeof env.HOME !== "string" || env.HOME.length < 2) {
    failCollector(CollectorErrorCode.E_COLLECTOR_CONFIG, "Collector HOME isolation is missing.");
  }
  if (env.GIT_CONFIG_NOSYSTEM !== "1" || env.GIT_ATTR_NOSYSTEM !== "1" || env.GIT_NO_REPLACE_OBJECTS !== "1") {
    failCollector(CollectorErrorCode.E_COLLECTOR_CONFIG, "Required fail-closed Git environment flags missing.");
  }
  if (env.GIT_TERMINAL_PROMPT !== "0") {
    failCollector(CollectorErrorCode.E_COLLECTOR_CONFIG, "GIT_TERMINAL_PROMPT must be disabled.");
  }
  // The installation token belongs only to the trusted outbound proxy and
  // must never enter the Git child environment under any name or config key.
  if (env.GITHUB_TOKEN || env.GH_TOKEN || env.INSTALLATION_TOKEN) {
    failCollector(CollectorErrorCode.E_COLLECTOR_CONFIG, "Token must not appear as a named secret environment key.");
  }
  const configCount = Number.parseInt(String(env.GIT_CONFIG_COUNT || "0"), 10);
  for (let i = 0; Number.isSafeInteger(configCount) && i < configCount; i += 1) {
    const key = env[`GIT_CONFIG_KEY_${i}`];
    const value = env[`GIT_CONFIG_VALUE_${i}`];
    if (
      key === "http.extraHeader"
      || (typeof value === "string" && /^Authorization:/iu.test(value))
    ) {
      failCollector(CollectorErrorCode.E_COLLECTOR_CONFIG, "Token-bearing Git config is forbidden.");
    }
  }
  void FORBIDDEN_ENV_KEYS;
}

export const __test__ = Object.freeze({
  buildChildEnvironment,
  createBoundedGitHubSmartHttpProxy,
  trustedConfigArgs,
  createIsolatedHomes,
  FORBIDDEN_ENV_KEYS,
  FORBIDDEN_ENV_PREFIXES
});
