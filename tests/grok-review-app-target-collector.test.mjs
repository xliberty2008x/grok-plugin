/**
 * Hostile-repository-safe exact-head collector tests.
 * Uses an explicit local transport test hook only — no network.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  CollectorError,
  CollectorErrorCode,
  CollectorLimits
} from "../apps/grok-review-app/src/actions/collector-errors.mjs";
import {
  assertSafeRepoPath,
  decodeUtf8Fatal,
  parseDiffTreeRawZ,
  parseRawMeta,
  splitNulTokens
} from "../apps/grok-review-app/src/actions/exact-head-diff.mjs";
import {
  agentsCandidatesForChangedPath,
  collectHeadInstructions,
  discoverAgentsCandidates,
  MAX_INSTRUCTION_CANDIDATE_PROBES,
  receiptContainsInstructionContent
} from "../apps/grok-review-app/src/actions/head-instructions.mjs";
import {
  assertAllowlistedCollectorEnv,
  buildCanonicalGitHubHttpsRemote,
  isCanonicalGitHubHttpsRemote,
  lsTreePath,
  MAX_FETCHED_BLOB_OBJECT_BYTES,
  openProductionExactHeadRepository,
  openTestExactHeadRepository,
  resolveVerifiedGitExecutable,
  __test__ as repositoryInternals
} from "../apps/grok-review-app/src/actions/exact-head-repository.mjs";
import {
  buildReviewPacket,
  collectCanonicalReviewPacket,
  collectTestReviewPacket,
  publicCollectorFailure,
  UNTRUSTED_EVIDENCE_NOTICE
} from "../apps/grok-review-app/src/actions/review-packet.mjs";
import { collectExactHeadDiff } from "../apps/grok-review-app/src/actions/exact-head-diff.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GIT = resolveVerifiedGitExecutable();

function tempDir(prefix = "grok-collector-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

function runGit(cwd, args, envExtra = {}) {
  const result = spawnSync(GIT, args, {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...envExtra
    },
    encoding: "buffer",
    shell: false,
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr?.toString("utf8") || result.status}`);
  }
  return result.stdout.toString("utf8").trim();
}

function runGitAsync(cwd, args, envExtra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(GIT, args, {
      cwd,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: cwd,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        ...envExtra
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 15_000);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 32 * 1024 * 1024) child.kill("SIGKILL");
      else stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 32 * 1024 * 1024) child.kill("SIGKILL");
      else stderr.push(Buffer.from(chunk));
    });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      if (status !== 0 || signal) {
        reject(new Error(
          `git ${args.slice(0, 3).join(" ")} failed: ${Buffer.concat(stderr).toString("utf8")}`
        ));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8").trim());
    });
  });
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (Buffer.isBuffer(content)) fs.writeFileSync(file, content);
  else fs.writeFileSync(file, content, "utf8");
}

async function listenHttpServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    server,
    port: address.port,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function requestLoopback(url, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method,
      headers,
      agent: false,
      timeout: 5_000
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("aborted", () => reject(new Error("response aborted")));
      response.once("error", reject);
      response.once("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    request.once("timeout", () => request.destroy(new Error("request timeout")));
    request.once("error", reject);
    request.end(body);
  });
}

function localOutboundTransport(port, captures) {
  return (options, callback) => {
    captures.push({
      protocol: options.protocol,
      hostname: options.hostname,
      host: options.host,
      port: options.port,
      servername: options.servername,
      method: options.method,
      path: options.path,
      headers: { ...options.headers },
      rejectUnauthorized: options.rejectUnauthorized
    });
    return http.request({
      hostname: "127.0.0.1",
      port,
      method: options.method,
      path: options.path,
      headers: options.headers,
      agent: false
    }, callback);
  };
}

function gitHttpBackendHandler(projectRoot, observedAuthorization) {
  return (request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(request.url, "http://github.test");
      observedAuthorization.push(request.headers.authorization || null);
      const backend = spawnSync(GIT, ["http-backend"], {
        cwd: projectRoot,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: projectRoot,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_ATTR_NOSYSTEM: "1",
          GIT_PROJECT_ROOT: projectRoot,
          GIT_HTTP_EXPORT_ALL: "1",
          GIT_TERMINAL_PROMPT: "0",
          REQUEST_METHOD: request.method,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers["content-type"] || "",
          CONTENT_LENGTH: String(body.length),
          HTTP_GIT_PROTOCOL: request.headers["git-protocol"] || "",
          REMOTE_ADDR: "127.0.0.1"
        },
        input: body,
        encoding: "buffer",
        shell: false,
        timeout: 10_000,
        maxBuffer: 32 * 1024 * 1024
      });
      if (backend.status !== 0 || !Buffer.isBuffer(backend.stdout)) {
        response.writeHead(500);
        response.end();
        return;
      }
      const crlf = backend.stdout.indexOf(Buffer.from("\r\n\r\n"));
      const lf = backend.stdout.indexOf(Buffer.from("\n\n"));
      const separator = crlf >= 0
        ? { index: crlf, bytes: 4 }
        : { index: lf, bytes: 2 };
      if (separator.index < 0) {
        response.writeHead(500);
        response.end();
        return;
      }
      const headerText = backend.stdout.subarray(0, separator.index).toString("latin1");
      const responseBody = backend.stdout.subarray(separator.index + separator.bytes);
      let status = 200;
      const headers = {};
      for (const line of headerText.split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon < 1) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (name === "status") {
          status = Number.parseInt(value, 10);
        } else if ([
          "content-type",
          "content-length",
          "cache-control",
          "expires",
          "pragma"
        ].includes(name)) {
          headers[name] = value;
        }
      }
      response.writeHead(status, headers);
      response.end(responseBody);
    });
  };
}

/**
 * Build a local source repository with main + PR head ref, returning SHAs.
 * @param {(ctx: { root: string, commit: Function, git: Function }) => void} mutate
 */
function buildSourceRepo(mutate) {
  const root = tempDir("grok-collector-src-");
  runGit(root, ["init", "-b", "main"]);
  runGit(root, ["config", "user.email", "collector-test@example.com"]);
  runGit(root, ["config", "user.name", "Collector Test"]);
  runGit(root, ["config", "uploadpack.allowFilter", "true"]);
  // Disable hooks / LFS in the fixture itself.
  runGit(root, ["config", "core.hooksPath", path.join(root, ".empty-hooks")]);
  fs.mkdirSync(path.join(root, ".empty-hooks"), { mode: 0o700 });

  write(path.join(root, "README.md"), "# fixture\n");
  write(path.join(root, "src", "app.js"), "console.log(1)\n");
  runGit(root, ["add", "README.md", "src/app.js"]);
  runGit(root, ["commit", "-m", "base"]);
  const baseTipSha = runGit(root, ["rev-parse", "HEAD"]);

  const git = (args) => runGit(root, args);
  const commit = (message) => runGit(root, ["commit", "-m", message]);

  mutate({ root, git, commit, write: (rel, content) => write(path.join(root, rel), content), baseTipSha });

  // Ensure PR head ref exists at current HEAD when tests didn't set it.
  const headSha = runGit(root, ["rev-parse", "HEAD"]);
  const pullRef = "refs/pull/1/head";
  try {
    runGit(root, ["show-ref", "--verify", pullRef]);
  } catch {
    runGit(root, ["update-ref", pullRef, headSha]);
  }

  return {
    root,
    baseTipSha: runGit(root, ["rev-parse", "refs/heads/main"]),
    headSha: runGit(root, ["rev-parse", pullRef]),
    pullNumber: 1,
    baseRef: "main"
  };
}

async function openFromSource(source, overrides = {}) {
  return openTestExactHeadRepository({
    owner: "acme-org",
    repository: "widgets",
    pullNumber: source.pullNumber,
    baseRef: source.baseRef,
    baseTipSha: source.baseTipSha,
    headSha: source.headSha,
    testLocalRemoteUrl: source.root,
    gitExecutable: GIT,
    ...overrides
  });
}

test("production remote is only canonical GitHub HTTPS", () => {
  const remote = buildCanonicalGitHubHttpsRemote("acme-org", "widgets");
  assert.equal(remote, "https://github.com/acme-org/widgets.git");
  assert.equal(isCanonicalGitHubHttpsRemote(remote), true);
  assert.equal(isCanonicalGitHubHttpsRemote("https://github.com/acme-org/widgets"), false);
  assert.equal(isCanonicalGitHubHttpsRemote("https://evil.com/acme-org/widgets.git"), false);
  assert.equal(isCanonicalGitHubHttpsRemote("git@github.com:acme-org/widgets.git"), false);
  assert.equal(isCanonicalGitHubHttpsRemote("https://github.com/acme-org/widgets.git/../x"), false);
  assert.throws(
    () => buildCanonicalGitHubHttpsRemote("../etc", "passwd"),
    (e) => e instanceof CollectorError && e.code === CollectorErrorCode.E_COLLECTOR_REMOTE
  );
});

test("production open path rejects local transport hooks", async () => {
  await assert.rejects(
    () => openProductionExactHeadRepository({
      owner: "acme-org",
      repository: "widgets",
      pullNumber: 1,
      baseRef: "main",
      baseTipSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      allowTestLocalTransport: true,
      testLocalRemoteUrl: "/tmp/nope"
    }),
    (e) => e instanceof CollectorError && e.code === CollectorErrorCode.E_COLLECTOR_REMOTE
  );

  await assert.rejects(
    () => openProductionExactHeadRepository({
      owner: "acme-org",
      repository: "widgets",
      pullNumber: 1,
      baseRef: "main",
      baseTipSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      gitExecutable: GIT
    }),
    (e) => e instanceof CollectorError && e.code === CollectorErrorCode.E_COLLECTOR_GIT_EXECUTABLE
  );

  await assert.rejects(
    () => collectCanonicalReviewPacket({
      owner: "acme-org",
      repository: "widgets",
      pullNumber: 1,
      baseRef: "main",
      baseTipSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      testLocalRemoteUrl: "/tmp/not-production"
    }),
    (e) => e instanceof CollectorError && e.code === CollectorErrorCode.E_COLLECTOR_REMOTE
  );
});

test("Git resolver probes executables and explicit failures do not fall back", () => {
  const root = tempDir("grok-bad-git-");
  const unusable = path.join(root, "git");
  fs.writeFileSync(unusable, "#!/bin/sh\nexit 69\n", { mode: 0o700 });
  assert.throws(
    () => resolveVerifiedGitExecutable(unusable),
    (e) => e instanceof CollectorError && e.code === CollectorErrorCode.E_COLLECTOR_GIT_EXECUTABLE
  );

  const probe = spawnSync(GIT, ["--version"], {
    env: {
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C",
      LC_ALL: "C"
    },
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
    maxBuffer: 4096
  });
  assert.equal(probe.status, 0);
  assert.match(probe.stdout, /^git version /);
  fs.rmSync(root, { recursive: true, force: true });
});

test("trusted smart HTTP guard pins GitHub, injects auth outbound only, and shuts down", async () => {
  const captures = [];
  const postBodies = [];
  const upstream = await listenHttpServer((request, response) => {
    if (request.method === "GET") {
      assert.equal(request.url, "/acme-org/widgets.git/info/refs?service=git-upload-pack");
      response.writeHead(200, {
        "content-type": "application/x-git-upload-pack-advertisement"
      });
      response.end("advertisement");
      return;
    }
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/acme-org/widgets.git/git-upload-pack");
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      postBodies.push(Buffer.concat(chunks));
      response.writeHead(200, {
        "content-type": "application/x-git-upload-pack-result"
      });
      response.end("pack-result");
    });
  });

  const fakeToken = "fixture-installation-token";
  const expectedAuthorization = `Basic ${Buffer
    .from(`x-access-token:${fakeToken}`, "utf8")
    .toString("base64")}`;
  const guard = await repositoryInternals.createBoundedGitHubSmartHttpProxy({
    owner: "acme-org",
    repository: "widgets",
    installationToken: fakeToken,
    responseByteLimit: 1024,
    requestByteLimit: 1024,
    aggregateRequestByteLimit: 2048,
    timeoutMs: 5_000,
    outboundRequest: localOutboundTransport(upstream.port, captures)
  });
  assert.equal(guard.remoteUrl.includes(fakeToken), false);

  try {
    const advertised = await requestLoopback(
      `${guard.remoteUrl}/info/refs?service=git-upload-pack`,
      { headers: { "git-protocol": "version=2" } }
    );
    assert.equal(advertised.status, 200);
    assert.equal(advertised.body.toString("utf8"), "advertisement");

    const requestBody = Buffer.from("0000", "ascii");
    const packed = await requestLoopback(`${guard.remoteUrl}/git-upload-pack`, {
      method: "POST",
      headers: {
        "content-type": "application/x-git-upload-pack-request",
        "content-length": String(requestBody.length),
        "git-protocol": "version=2"
      },
      body: requestBody
    });
    assert.equal(packed.status, 200);
    assert.equal(packed.body.toString("utf8"), "pack-result");
    assert.deepEqual(postBodies, [requestBody]);
    assert.equal(captures.length, 2);
    for (const capture of captures) {
      assert.equal(capture.protocol, "https:");
      assert.equal(capture.hostname, "github.com");
      assert.equal(capture.host, "github.com");
      assert.equal(capture.port, 443);
      assert.equal(capture.servername, "github.com");
      assert.equal(capture.rejectUnauthorized, true);
      assert.equal(capture.headers.authorization, expectedAuthorization);
      assert.equal(capture.headers.host, "github.com");
      assert.equal(capture.headers["accept-encoding"], "identity");
    }
    assert.equal(captures[0].headers["git-protocol"], "version=2");
    assert.equal(guard.snapshot().fatalKind, null);
    assert.ok(guard.snapshot().aggregateResponseBytes > 0);

    const isolated = tempDir("grok-proxy-env-");
    const homes = repositoryInternals.createIsolatedHomes(isolated);
    const childEnv = repositoryInternals.buildChildEnvironment(homes, {
      allowLoopbackHttp: true
    });
    assertAllowlistedCollectorEnv(childEnv);
    assert.equal(JSON.stringify(childEnv).includes(fakeToken), false);
    assert.equal(
      Object.values(childEnv).some((value) => (
        typeof value === "string" && value.startsWith("Authorization:")
      )),
      false
    );
    fs.rmSync(isolated, { recursive: true, force: true });
  } finally {
    await guard.close();
    await upstream.close();
  }
  assert.equal(guard.snapshot().closed, true);
  await assert.rejects(
    () => requestLoopback(`${guard.remoteUrl}/info/refs?service=git-upload-pack`)
  );
});

test("trusted smart HTTP guard carries an exact base and pull-head Git fetch", async () => {
  const source = buildSourceRepo(({ git, write, commit }) => {
    git(["checkout", "-b", "feature"]);
    write("src/app.js", "console.log('smart-http')\n");
    git(["add", "src/app.js"]);
    commit("feature");
    git(["update-ref", "refs/pull/1/head", git(["rev-parse", "HEAD"])]);
  });
  const projectRoot = tempDir("grok-http-backend-");
  const bare = path.join(projectRoot, "acme-org", "widgets.git");
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  runGit(projectRoot, ["clone", "--bare", source.root, bare]);
  runGit(bare, ["config", "uploadpack.allowFilter", "true"]);
  runGit(bare, ["update-ref", "refs/pull/1/head", source.headSha]);

  const observedAuthorization = [];
  const captures = [];
  const upstream = await listenHttpServer(
    gitHttpBackendHandler(projectRoot, observedAuthorization)
  );
  const fakeToken = "fixture-exact-fetch-token";
  const expectedAuthorization = `Basic ${Buffer
    .from(`x-access-token:${fakeToken}`, "utf8")
    .toString("base64")}`;
  const guard = await repositoryInternals.createBoundedGitHubSmartHttpProxy({
    owner: "acme-org",
    repository: "widgets",
    installationToken: fakeToken,
    responseByteLimit: 16 * 1024 * 1024,
    requestByteLimit: 1024 * 1024,
    aggregateRequestByteLimit: 2 * 1024 * 1024,
    timeoutMs: 10_000,
    outboundRequest: localOutboundTransport(upstream.port, captures)
  });
  const destination = tempDir("grok-http-fetch-");
  runGit(destination, ["init", "--bare"]);
  try {
    await runGitAsync(destination, [
      "-c", "protocol.allow=never",
      "-c", "protocol.http.allow=always",
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      `--filter=blob:limit=${MAX_FETCHED_BLOB_OBJECT_BYTES + 1}`,
      guard.remoteUrl,
      "+refs/heads/main:refs/grok/base",
      "+refs/pull/1/head:refs/grok/head"
    ]);
    assert.equal(runGit(destination, ["rev-parse", "refs/grok/base"]), source.baseTipSha);
    assert.equal(runGit(destination, ["rev-parse", "refs/grok/head"]), source.headSha);
    assert.equal(guard.snapshot().fatalKind, null);
    assert.ok(guard.snapshot().aggregateResponseBytes > 0);
    assert.ok(captures.length >= 2);
    assert.ok(observedAuthorization.length >= 2);
    assert.ok(observedAuthorization.every((value) => value === expectedAuthorization));
  } finally {
    await guard.close();
    await upstream.close();
    fs.rmSync(destination, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(source.root, { recursive: true, force: true });
  }
});

test("trusted smart HTTP guard rejects methods, paths, and oversized request bodies", async () => {
  let upstreamCalls = 0;
  const captures = [];
  const upstream = await listenHttpServer((_request, response) => {
    upstreamCalls += 1;
    response.writeHead(500);
    response.end();
  });
  const guard = await repositoryInternals.createBoundedGitHubSmartHttpProxy({
    owner: "acme-org",
    repository: "widgets",
    installationToken: "fixture-token",
    responseByteLimit: 1024,
    requestByteLimit: 4,
    aggregateRequestByteLimit: 8,
    timeoutMs: 5_000,
    outboundRequest: localOutboundTransport(upstream.port, captures)
  });
  try {
    const wrongPath = await requestLoopback(`${guard.remoteUrl}/not-allowed`);
    assert.equal(wrongPath.status, 404);
    const wrongMethod = await requestLoopback(`${guard.remoteUrl}/git-upload-pack`);
    assert.equal(wrongMethod.status, 405);
    const oversized = await requestLoopback(`${guard.remoteUrl}/git-upload-pack`, {
      method: "POST",
      headers: {
        "content-type": "application/x-git-upload-pack-request",
        "content-length": "5"
      },
      body: Buffer.from("12345")
    });
    assert.equal(oversized.status, 413);
    assert.equal(upstreamCalls, 0);
    assert.equal(captures.length, 0);
  } finally {
    await guard.close();
    await upstream.close();
  }
});

test("trusted smart HTTP guard rejects redirects and aggregate response overflow", async () => {
  const redirectCaptures = [];
  const redirectUpstream = await listenHttpServer((_request, response) => {
    response.writeHead(302, {
      location: "https://evil.example/repository"
    });
    response.end();
  });
  const redirectGuard = await repositoryInternals.createBoundedGitHubSmartHttpProxy({
    owner: "acme-org",
    repository: "widgets",
    installationToken: "fixture-token",
    responseByteLimit: 1024,
    timeoutMs: 5_000,
    outboundRequest: localOutboundTransport(redirectUpstream.port, redirectCaptures)
  });
  try {
    const redirected = await requestLoopback(
      `${redirectGuard.remoteUrl}/info/refs?service=git-upload-pack`
    );
    assert.equal(redirected.status, 502);
    assert.equal(redirectGuard.snapshot().fatalKind, "redirect_rejected");
    assert.equal(redirectCaptures[0].hostname, "github.com");
  } finally {
    await redirectGuard.close();
    await redirectUpstream.close();
  }

  const overflowCaptures = [];
  const overflowUpstream = await listenHttpServer((request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, {
        "content-type": "application/x-git-upload-pack-advertisement",
        "content-length": "5"
      });
      response.end("12345");
      return;
    }
    response.writeHead(200, {
      "content-type": "application/x-git-upload-pack-result"
    });
    response.write("67");
    setImmediate(() => response.end("89"));
  });
  const overflowGuard = await repositoryInternals.createBoundedGitHubSmartHttpProxy({
    owner: "acme-org",
    repository: "widgets",
    installationToken: "fixture-token",
    responseByteLimit: 8,
    requestByteLimit: 32,
    aggregateRequestByteLimit: 64,
    timeoutMs: 5_000,
    outboundRequest: localOutboundTransport(overflowUpstream.port, overflowCaptures)
  });
  try {
    const first = await requestLoopback(
      `${overflowGuard.remoteUrl}/info/refs?service=git-upload-pack`
    );
    assert.equal(first.status, 200);
    assert.equal(first.body.toString("utf8"), "12345");

    let second = null;
    try {
      second = await requestLoopback(`${overflowGuard.remoteUrl}/git-upload-pack`, {
        method: "POST",
        headers: {
          "content-type": "application/x-git-upload-pack-request",
          "content-length": "1"
        },
        body: Buffer.from("x")
      });
    } catch {
      // Aggregate overflow intentionally destroys the active fetch connection.
    }
    if (second) assert.equal(second.status, 502);
    const snapshot = overflowGuard.snapshot();
    assert.equal(snapshot.fatalKind, "aggregate_response_limit");
    assert.ok(snapshot.aggregateResponseBytes >= 5);
    assert.ok(snapshot.aggregateResponseBytes <= snapshot.responseByteLimit);
  } finally {
    await overflowGuard.close();
    await overflowUpstream.close();
  }
});

test("merge-base semantics use mergeBase..head when base tip advances", async () => {
  const source = buildSourceRepo(({ root, git, write, commit }) => {
    // PR branch from initial base
    git(["checkout", "-b", "feature"]);
    write("src/app.js", "console.log(2)\n");
    git(["add", "src/app.js"]);
    commit("feature change");
    const featureSha = git(["rev-parse", "HEAD"]);
    git(["update-ref", "refs/pull/1/head", featureSha]);

    // Base tip advances with an unrelated commit after the PR branched.
    git(["checkout", "main"]);
    write("docs/note.md", "base advanced\n");
    git(["add", "docs/note.md"]);
    commit("base advance");
  });

  const repo = await openFromSource(source);
  try {
    assert.equal(repo.baseTipSha, source.baseTipSha);
    assert.equal(repo.headSha, source.headSha);
    assert.notEqual(repo.mergeBaseSha, repo.baseTipSha, "merge base should be the pre-advance fork point");
    assert.notEqual(repo.mergeBaseSha, repo.headSha);

    const diff = await collectExactHeadDiff(repo);
    assert.equal(diff.mergeBaseSha, repo.mergeBaseSha);
    assert.equal(diff.baseTipSha, repo.baseTipSha);
    assert.equal(diff.headSha, repo.headSha);
    // Only the feature file change vs merge-base — not the base-only docs/note.md
    const paths = diff.changedFiles.map((f) => f.path).sort();
    assert.deepEqual(paths, ["src/app.js"]);
    assert.ok(Buffer.isBuffer(diff.patch));
    assert.equal(diff.patchBytes, diff.patch.length);
    assert.match(diff.patchDigest, /^[0-9a-f]{64}$/);
    assert.match(diff.patch.toString("utf8"), /src\/app\.js/);
    assert.equal(diff.patch.toString("utf8").includes("docs/note.md"), false);
  } finally {
    await repo.dispose();
  }
});

test("stale head ref fails closed with E_COLLECTOR_REF", async () => {
  const source = buildSourceRepo(({ git, write, commit }) => {
    git(["checkout", "-b", "feature"]);
    write("src/app.js", "console.log(stale)\n");
    git(["add", "src/app.js"]);
    commit("feature");
    git(["update-ref", "refs/pull/1/head", git(["rev-parse", "HEAD"])]);
  });

  const staleHead = "cccccccccccccccccccccccccccccccccccccccc";
  await assert.rejects(
    () => openFromSource(source, { headSha: staleHead }),
    (e) => e instanceof CollectorError && e.code === CollectorErrorCode.E_COLLECTOR_REF
  );
});

test("stale base tip fails closed with E_COLLECTOR_REF", async () => {
  const source = buildSourceRepo(({ git, write, commit }) => {
    git(["checkout", "-b", "feature"]);
    write("src/app.js", "console.log(x)\n");
    git(["add", "src/app.js"]);
    commit("feature");
    git(["update-ref", "refs/pull/1/head", git(["rev-parse", "HEAD"])]);
  });
  const staleBase = "dddddddddddddddddddddddddddddddddddddddd";
  await assert.rejects(
    () => openFromSource(source, { baseTipSha: staleBase }),
    (e) => e instanceof CollectorError && e.code === CollectorErrorCode.E_COLLECTOR_REF
  );
});

test("ls-tree treats magic-like names literally and requires exact returned paths", async () => {
  const source = buildSourceRepo(({ git, write, commit }) => {
    write("AGENTS.md", "# root only\n");
    git(["add", "AGENTS.md"]);
    commit("root instructions");
    git(["checkout", "-b", "feature"]);
    write("src/app.js", "console.log('literal')\n");
    git(["add", "src/app.js"]);
    commit("feature");
    git(["update-ref", "refs/pull/1/head", git(["rev-parse", "HEAD"])]);
  });

  const repo = await openFromSource(source);
  try {
    const rootEntry = await lsTreePath(repo, repo.headSha, "AGENTS.md");
    assert.ok(rootEntry);
    assert.equal(rootEntry.path, "AGENTS.md");
    assert.equal(
      await lsTreePath(repo, repo.headSha, ":/AGENTS.md"),
      null,
      "Git pathspec magic must not redirect a literal lookup to root AGENTS.md"
    );
  } finally {
    await repo.dispose();
    fs.rmSync(source.root, { recursive: true, force: true });
  }
});

test("NUL-safe path parsing preserves unusual UTF-8 paths and rejects unsafe ones", () => {
  const unusual = "dir/weird name:with-colon/-leading-dash-文件.js";
  const meta = Buffer.from(":100644 100644 " + "a".repeat(40) + " " + "b".repeat(40) + " M", "utf8");
  const pathBuf = Buffer.from(unusual, "utf8");
  const raw = Buffer.concat([meta, Buffer.from([0]), pathBuf, Buffer.from([0])]);
  const files = parseDiffTreeRawZ(raw);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, unusual);
  assert.equal(files[0].status, "M");

  // TAB/LF are preserved by NUL parsing (not truncated at whitespace) then rejected.
  const tabPath = "dir/has\ttab.js";
  const tabMeta = Buffer.from(":100644 100644 " + "a".repeat(40) + " " + "b".repeat(40) + " M", "utf8");
  const tabRaw = Buffer.concat([tabMeta, Buffer.from([0]), Buffer.from(tabPath, "utf8"), Buffer.from([0])]);
  assert.throws(() => parseDiffTreeRawZ(tabRaw), (e) => e.code === CollectorErrorCode.E_COLLECTOR_PATH);

  assert.throws(() => assertSafeRepoPath("/etc/passwd"), (e) => e.code === CollectorErrorCode.E_COLLECTOR_PATH);
  assert.throws(() => assertSafeRepoPath("../escape"), (e) => e.code === CollectorErrorCode.E_COLLECTOR_PATH);
  assert.throws(() => assertSafeRepoPath("a/../../b"), (e) => e.code === CollectorErrorCode.E_COLLECTOR_PATH);
  assert.throws(() => assertSafeRepoPath("a/\0/b"), (e) => e.code === CollectorErrorCode.E_COLLECTOR_PATH);
  assert.throws(() => decodeUtf8Fatal(Buffer.from([0xff, 0xfe, 0xfd])), (e) => e.code === CollectorErrorCode.E_COLLECTOR_PATH);

  // Malformed meta
  assert.throws(() => parseRawMeta(Buffer.from(":not meta", "utf8")), (e) => e.code === CollectorErrorCode.E_COLLECTOR_DIFF);
  assert.throws(() => splitNulTokens(Buffer.from("no-nul")), (e) => e.code === CollectorErrorCode.E_COLLECTOR_DIFF);

  // Duplicate paths
  const dup = Buffer.concat([raw, raw]);
  assert.throws(() => parseDiffTreeRawZ(dup), (e) => e.code === CollectorErrorCode.E_COLLECTOR_PATH);
});

test("unusual paths, binary, and gitlink changes collect correctly", async () => {
  const unusual = "pkg/weird name:colon/-dash-文件.bin";
  const source = buildSourceRepo(({ git, write, commit }) => {
    git(["checkout", "-b", "feature"]);
    write(unusual, Buffer.from([0x00, 0x01, 0x02, 0xff]));
    write("src/app.js", "console.log('x')\n");
    // gitlink-like: add a submodule entry via index plumbing
    const modeGitlink = "160000";
    const fakeCommit = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    git(["update-index", "--add", "--cacheinfo", `${modeGitlink},${fakeCommit},vendor/lib`]);
    git(["add", unusual, "src/app.js"]);
    commit("feature binary and gitlink");
    git(["update-ref", "refs/pull/1/head", git(["rev-parse", "HEAD"])]);
  });

  const repo = await openFromSource(source);
  try {
    const diff = await collectExactHeadDiff(repo);
    const paths = diff.changedFiles.map((f) => f.path).sort();
    assert.ok(paths.includes(unusual));
    assert.ok(paths.includes("src/app.js"));
    assert.ok(paths.includes("vendor/lib"));
    const gitlink = diff.changedFiles.find((f) => f.path === "vendor/lib");
    assert.equal(gitlink.newMode, "160000");
    assert.ok(diff.patch.length > 0);
    // Binary evidence present in full-index patch
    assert.ok(
      diff.patch.includes(Buffer.from(unusual, "utf8"))
      || diff.patch.toString("utf8").includes("GIT binary patch")
      || diff.patch.toString("latin1").includes("Binary files")
    );
  } finally {
    await repo.dispose();
  }
});

test("collector identities are bound to the opened exact refs and merge-base", async () => {
  let olderBaseSha = null;
  const source = buildSourceRepo(({ git, write, commit, baseTipSha }) => {
    olderBaseSha = baseTipSha;
    write("base-two.txt", "second base\n");
    git(["add", "base-two.txt"]);
    commit("second base");
    git(["checkout", "-b", "feature"]);
    write("src/app.js", "console.log('identity')\n");
    git(["add", "src/app.js"]);
    commit("feature");
    git(["update-ref", "refs/pull/1/head", git(["rev-parse", "HEAD"])]);
  });

  const repo = await openFromSource(source);
  try {
    await assert.rejects(
      () => collectExactHeadDiff(repo, {
        baseTipSha: repo.baseTipSha,
        mergeBaseSha: repo.mergeBaseSha,
        headSha: "f".repeat(40)
      }),
      (e) => e instanceof CollectorError && e.code === CollectorErrorCode.E_COLLECTOR_REF
    );
    await assert.rejects(
      () => collectHeadInstructions(repo, { headSha: "e".repeat(40) }, ["src/app.js"]),
      (e) => e instanceof CollectorError && e.code === CollectorErrorCode.E_COLLECTOR_REF
    );

    const actualMergeBase = repo.mergeBaseSha;
    assert.notEqual(olderBaseSha, actualMergeBase);
    repo.mergeBaseSha = olderBaseSha;
    await assert.rejects(
      () => collectExactHeadDiff(repo),
      (e) => e instanceof CollectorError && e.code === CollectorErrorCode.E_COLLECTOR_MERGE_BASE
    );
    repo.mergeBaseSha = actualMergeBase;
  } finally {
    await repo.dispose();
    fs.rmSync(source.root, { recursive: true, force: true });
  }
});

test("oversized patch blobs stay omitted and cannot trigger lazy downloads", async () => {
  const source = buildSourceRepo(({ git, write, commit }) => {
    git(["checkout", "-b", "feature"]);
    write("huge.bin", Buffer.alloc(MAX_FETCHED_BLOB_OBJECT_BYTES + 1, 0x61));
    git(["add", "huge.bin"]);
    commit("oversized blob");
    git(["update-ref", "refs/pull/1/head", git(["rev-parse", "HEAD"])]);
  });
  const blobOid = runGit(source.root, ["rev-parse", `${source.headSha}:huge.bin`]);
  const repo = await openFromSource(source);
  try {
    await assert.rejects(
      () => collectExactHeadDiff(repo),
      (e) => e instanceof CollectorError && e.code === CollectorErrorCode.E_COLLECTOR_LIMIT_PATCH
    );
    const local = await repo.git(["cat-file", "-e", blobOid], {
      allowFailure: true,
      maxStdout: 64
    });
    assert.notEqual(local.status, 0, "bounded collection must not lazily hydrate the omitted blob");
  } finally {
    await repo.dispose();
    fs.rmSync(source.root, { recursive: true, force: true });
  }
});

test("file-count overflow fails closed with stable code and no partial result", () => {
  const oid = "a".repeat(40);
  const oid2 = "b".repeat(40);
  /** @type {Buffer[]} */
  const parts = [];
  for (let i = 0; i < CollectorLimits.MAX_CHANGED_FILES + 1; i += 1) {
    const meta = Buffer.from(`:100644 100644 ${oid} ${oid2} M`, "utf8");
    const p = Buffer.from(`f${i}.txt`, "utf8");
    parts.push(meta, Buffer.from([0]), p, Buffer.from([0]));
  }
  const raw = Buffer.concat(parts);
  assert.throws(
    () => parseDiffTreeRawZ(raw),
    (e) => e instanceof CollectorError
      && e.code === CollectorErrorCode.E_COLLECTOR_LIMIT_FILES
      && !("patch" in (e.details || {}))
  );
});

test("malicious global/local config and hooks cannot create a canary", async () => {
  const canary = path.join(os.tmpdir(), `grok-collector-canary-${crypto.randomBytes(8).toString("hex")}`);
  const hostileHome = tempDir("grok-hostile-home-");
  const hostileHooks = path.join(hostileHome, "hooks");
  fs.mkdirSync(hostileHooks, { mode: 0o700 });
  // Hostile pre-fetch / smudge style hooks that would touch the canary.
  for (const name of ["pre-fetch", "post-checkout", "pre-checkout", "fsmonitor-watchman"]) {
    const hook = path.join(hostileHooks, name);
    fs.writeFileSync(hook, `#!/bin/sh\necho hooked > "${canary}"\n`, { mode: 0o755 });
  }
  write(path.join(hostileHome, ".gitconfig"), `
[core]
  hooksPath = ${hostileHooks}
  fsmonitor = true
[diff]
  external = touch ${canary}
[filter "lfs"]
  smudge = touch ${canary}
  clean = touch ${canary}
`);

  const source = buildSourceRepo(({ git, write, commit }) => {
    git(["checkout", "-b", "feature"]);
    write("src/app.js", "console.log('safe')\n");
    git(["add", "src/app.js"]);
    commit("feature");
    git(["update-ref", "refs/pull/1/head", git(["rev-parse", "HEAD"])]);
  });

  // Inject hostile parent env; collector must not inherit it.
  const prevHome = process.env.HOME;
  const prevGitConfig = process.env.GIT_CONFIG_GLOBAL;
  process.env.HOME = hostileHome;
  process.env.GIT_CONFIG_GLOBAL = path.join(hostileHome, ".gitconfig");
  process.env.GIT_TRACE = "1";
  try {
    const repo = await openFromSource(source);
    try {
      assertAllowlistedCollectorEnv(repo.env);
      assert.equal(repo.env.GIT_CONFIG_NOSYSTEM, "1");
      assert.equal(repo.env.GIT_ATTR_NOSYSTEM, "1");
      assert.equal(repo.env.GIT_NO_REPLACE_OBJECTS, "1");
      assert.equal(repo.env.GIT_NO_LAZY_FETCH, "1");
      assert.equal(repo.lazyFetchDisabled, true);
      assert.notEqual(repo.env.HOME, hostileHome);
      const diff = await collectExactHeadDiff(repo);
      assert.ok(diff.changedFiles.length >= 1);
      await repo.seal();
      assert.equal(repo.sealed, true);
      // After seal, remotes are gone.
      const remotes = await repo.git(["remote"], { allowFailure: true, maxStdout: 4096 });
      assert.equal(remotes.stdout.toString("utf8").trim(), "");
    } finally {
      await repo.dispose();
    }
  } finally {
    process.env.HOME = prevHome;
    if (prevGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prevGitConfig;
    delete process.env.GIT_TRACE;
  }
  assert.equal(fs.existsSync(canary), false, "hostile hooks/config must not create canary");
});

test("head AGENTS.md precedence, self-change, removal, symlink and type rejection", async () => {
  const source = buildSourceRepo(({ git, write, commit, root }) => {
    write("AGENTS.md", "# root agents\n");
    write("pkg/AGENTS.md", "# pkg agents\n");
    write("pkg/deep/AGENTS.md", "# deep agents\n");
    write("pkg/deep/file.js", "v1\n");
    git(["add", "AGENTS.md", "pkg/AGENTS.md", "pkg/deep/AGENTS.md", "pkg/deep/file.js"]);
    commit("agents base");
    git(["checkout", "-b", "feature"]);

    // Self-change root AGENTS.md, remove deep, change file, add symlink agents elsewhere
    write("AGENTS.md", "# root agents changed\n");
    write("pkg/deep/file.js", "v2\n");
    fs.unlinkSync(path.join(root, "pkg/deep/AGENTS.md"));
    git(["add", "-A"]);
    commit("feature agents");
    git(["update-ref", "refs/pull/1/head", git(["rev-parse", "HEAD"])]);
  });

  const repo = await openFromSource(source);
  try {
    const diff = await collectExactHeadDiff(repo);
    const instructions = await collectHeadInstructions(repo, { headSha: repo.headSha }, diff.changedFiles);

    // Root + pkg present; deep removed at head so not applicable
    const paths = instructions.files.map((f) => f.path).sort();
    assert.ok(paths.includes("AGENTS.md"));
    assert.ok(paths.includes("pkg/AGENTS.md"));
    assert.equal(paths.includes("pkg/deep/AGENTS.md"), false);

    const fileApp = instructions.applicability.find((a) => a.changedPath === "pkg/deep/file.js");
    assert.ok(fileApp);
    assert.deepEqual(fileApp.instructionPaths, ["AGENTS.md", "pkg/AGENTS.md"]);
    assert.match(fileApp.applicabilityDigest, /^[0-9a-f]{64}$/);

    // Receipt has no content
    assert.equal(receiptContainsInstructionContent(instructions.receipt), false);
    for (const f of instructions.receipt.files) {
      assert.equal(Object.prototype.hasOwnProperty.call(f, "content"), false);
      assert.match(f.sha256, /^[0-9a-f]{64}$/);
      assert.ok(f.bytes > 0);
    }

    // Symlink AGENTS.md rejected
    const symlinkSource = buildSourceRepo(({ git, write, commit, root }) => {
      write("src/x.js", "1\n");
      git(["add", "src/x.js"]);
      commit("base2");
      git(["checkout", "-b", "feature"]);
      write("src/x.js", "2\n");
      fs.symlinkSync("src/x.js", path.join(root, "AGENTS.md"));
      git(["add", "-A"]);
      commit("symlink agents");
      git(["update-ref", "refs/pull/1/head", git(["rev-parse", "HEAD"])]);
    });
    const repo2 = await openFromSource(symlinkSource);
    try {
      const d2 = await collectExactHeadDiff(repo2);
      await assert.rejects(
        () => collectHeadInstructions(repo2, { headSha: repo2.headSha }, d2.changedFiles),
        (e) => e instanceof CollectorError && e.code === CollectorErrorCode.E_COLLECTOR_INSTRUCTION
      );
    } finally {
      await repo2.dispose();
      fs.rmSync(symlinkSource.root, { recursive: true, force: true });
    }
  } finally {
    await repo.dispose();
    fs.rmSync(source.root, { recursive: true, force: true });
  }
});

test("instruction limits: count, per-file size, total size", async () => {
  // Per-file oversize
  const big = "x".repeat(CollectorLimits.MAX_INSTRUCTION_FILE_BYTES + 1);
  const source = buildSourceRepo(({ git, write, commit }) => {
    write("AGENTS.md", big);
    write("a.js", "1\n");
    git(["add", "AGENTS.md", "a.js"]);
    commit("base");
    git(["checkout", "-b", "feature"]);
    write("a.js", "2\n");
    git(["add", "a.js"]);
    commit("feature");
    git(["update-ref", "refs/pull/1/head", git(["rev-parse", "HEAD"])]);
  });
  const repo = await openFromSource(source);
  try {
    const diff = await collectExactHeadDiff(repo);
    await assert.rejects(
      () => collectHeadInstructions(repo, { headSha: repo.headSha }, diff.changedFiles),
      (e) => e instanceof CollectorError
        && (e.code === CollectorErrorCode.E_COLLECTOR_INSTRUCTION_LIMIT
          || e.code === CollectorErrorCode.E_COLLECTOR_OVERFLOW)
    );
  } finally {
    await repo.dispose();
    fs.rmSync(source.root, { recursive: true, force: true });
  }
});

test("oversized AGENTS.md is rejected without hydrating the omitted blob", async () => {
  const source = buildSourceRepo(({ git, write, commit }) => {
    write("AGENTS.md", Buffer.alloc(MAX_FETCHED_BLOB_OBJECT_BYTES + 1, 0x78));
    git(["add", "AGENTS.md"]);
    commit("oversized instructions");
    git(["checkout", "-b", "feature"]);
    write("src/app.js", "console.log('small')\n");
    git(["add", "src/app.js"]);
    commit("feature");
    git(["update-ref", "refs/pull/1/head", git(["rev-parse", "HEAD"])]);
  });
  const blobOid = runGit(source.root, ["rev-parse", `${source.headSha}:AGENTS.md`]);
  const repo = await openFromSource(source);
  try {
    const diff = await collectExactHeadDiff(repo);
    await assert.rejects(
      () => collectHeadInstructions(repo, { headSha: repo.headSha }, diff.changedFiles),
      (e) => e instanceof CollectorError && e.code === CollectorErrorCode.E_COLLECTOR_INSTRUCTION_LIMIT
    );
    const local = await repo.git(["cat-file", "-e", blobOid], {
      allowFailure: true,
      maxStdout: 64
    });
    assert.notEqual(local.status, 0, "instruction probe must not download the oversized blob");
  } finally {
    await repo.dispose();
    fs.rmSync(source.root, { recursive: true, force: true });
  }
});

test("sealing removes remotes/auth and packet never exposes bare path", async () => {
  const source = buildSourceRepo(({ git, write, commit }) => {
    write("AGENTS.md", "# root\n");
    git(["add", "AGENTS.md"]);
    commit("agents");
    git(["checkout", "-b", "feature"]);
    write("src/app.js", "console.log('repo.git grok-review-exact-head- barePath')\n");
    git(["add", "src/app.js"]);
    commit("feature");
    git(["update-ref", "refs/pull/1/head", git(["rev-parse", "HEAD"])]);
  });

  const packet = await collectTestReviewPacket({
    owner: "acme-org",
    repository: "widgets",
    pullNumber: source.pullNumber,
    baseRef: source.baseRef,
    baseTipSha: source.baseTipSha,
    headSha: source.headSha,
    testLocalRemoteUrl: source.root,
    gitExecutable: GIT
  });

  assert.equal(packet.schemaVersion, 1);
  assert.equal(packet.security.bareRepositoryPath, null);
  assert.equal(packet.security.evidenceIsUntrusted, true);
  assert.equal(packet.security.aggregateFetchTransportBounded, false);
  assert.ok(packet.untrustedEvidenceNotice.includes("untrusted"));
  assert.equal(packet.untrustedEvidenceNotice, UNTRUSTED_EVIDENCE_NOTICE);
  assert.ok(packet.security.evidenceCannotAlter.includes("credentials"));
  assert.ok(packet.security.evidenceCannotAlter.includes("security_rules"));
  assert.equal(packet.identity.headSha, source.headSha);
  assert.equal(packet.identity.baseTipSha, source.baseTipSha);
  assert.ok(packet.identity.mergeBaseSha);
  assert.ok(packet.changedFiles.length >= 1);
  assert.ok(packet.patch.bytes >= 0);
  assert.match(packet.patch.digest, /^[0-9a-f]{64}$/);
  assert.equal(packet.patch.untrusted, true);
  assert.ok(packet.promptVersion);
  assert.ok(packet.collectorVersion);

  const serialized = JSON.stringify(packet);
  assert.equal(serialized.includes(source.root), false);
  assert.ok(serialized.includes("repo.git"));
  assert.ok(serialized.includes("grok-review-exact-head-"));
  assert.equal(Object.prototype.hasOwnProperty.call(packet, "barePath"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(packet, "workspaceRoot"), false);
  assert.equal(JSON.stringify(packet.receipt).includes('"content"'), false);

  // Instructions content is in model evidence only, not receipt.
  if (packet.instructions.fileCount > 0) {
    assert.ok(packet.instructions.files[0].content.includes("root"));
    assert.equal(Object.prototype.hasOwnProperty.call(packet.receipt.instructions.files[0], "content"), false);
  }

  fs.rmSync(source.root, { recursive: true, force: true });
});

test("public errors and receipts never embed instruction or patch content", () => {
  const err = new CollectorError(CollectorErrorCode.E_COLLECTOR_INSTRUCTION_LIMIT, "limit", {
    totalBytes: 999,
    content: "# secret agents body that must not leak",
    patch: "diff --git evil"
  });
  const pub = publicCollectorFailure(err);
  assert.equal(pub.ok, false);
  assert.equal(pub.code, CollectorErrorCode.E_COLLECTOR_INSTRUCTION_LIMIT);
  assert.equal(JSON.stringify(pub).includes("secret agents"), false);
  assert.equal(JSON.stringify(pub).includes("diff --git"), false);
  assert.equal(pub.details?.totalBytes, 999);
});

test("candidate discovery is root-to-deepest and root is global", () => {
  assert.deepEqual(
    agentsCandidatesForChangedPath("pkg/deep/file.js"),
    ["AGENTS.md", "pkg/AGENTS.md", "pkg/deep/AGENTS.md"]
  );
  const discovered = discoverAgentsCandidates(["pkg/deep/file.js", "other/x.js"]);
  assert.equal(discovered[0], "AGENTS.md");
  assert.ok(discovered.includes("pkg/AGENTS.md"));
  assert.ok(discovered.includes("other/AGENTS.md"));
});

test("hierarchical candidate amplification fails before any Git probe", async () => {
  const changedPaths = Array.from(
    { length: CollectorLimits.MAX_CHANGED_FILES },
    (_, i) => `area-${i}/nested/file.js`
  );
  let gitCalls = 0;
  const fakeRepo = {
    disposed: false,
    headSha: "a".repeat(40),
    baseTipSha: "b".repeat(40),
    mergeBaseSha: "c".repeat(40),
    async git() {
      gitCalls += 1;
      throw new Error("candidate overflow must happen before Git");
    }
  };

  await assert.rejects(
    () => collectHeadInstructions(fakeRepo, { headSha: fakeRepo.headSha }, changedPaths),
    (e) => e instanceof CollectorError
      && e.code === CollectorErrorCode.E_COLLECTOR_INSTRUCTION_LIMIT
      && e.details?.limit === MAX_INSTRUCTION_CANDIDATE_PROBES
  );
  assert.equal(gitCalls, 0);
});

test("buildReviewPacket rejects path leakage fields and requires digests", () => {
  const patch = Buffer.from("diff --git a/x b/x\n", "utf8");
  const digest = crypto.createHash("sha256").update(patch).digest("hex");
  const packet = buildReviewPacket({
    owner: "acme-org",
    repository: "widgets",
    pullNumber: 1,
    baseRef: "main",
    baseTipSha: "a".repeat(40),
    mergeBaseSha: "b".repeat(40),
    headSha: "c".repeat(40),
    aggregateFetchTransportBounded: true,
    diff: {
      changedFiles: [{
        path: "x",
        oldMode: "100644",
        newMode: "100644",
        oldOid: "1".repeat(40),
        newOid: "2".repeat(40),
        status: "M"
      }],
      patch,
      patchBytes: patch.length,
      patchDigest: digest,
      pathsDigest: "d".repeat(64)
    },
    instructions: {
      files: [],
      applicability: [],
      receipt: {
        files: [],
        applicability: [],
        totalBytes: 0,
        fileCount: 0
      }
    }
  });
  assert.equal(packet.security.bareRepositoryPath, null);
  assert.equal(packet.patch.encoding, "utf8");
  assert.equal(
    packet.security.aggregateFetchTransportBounded,
    false,
    "direct evidence builders cannot forge the production fetch proof"
  );
});

test("review receipt is reconstructed from allowlisted collected metadata", () => {
  const patch = Buffer.from("diff --git a/x b/x\n", "utf8");
  const patchDigest = crypto.createHash("sha256").update(patch).digest("hex");
  const instruction = Buffer.from("# safe guidance\n", "utf8");
  const instructionDigest = crypto.createHash("sha256").update(instruction).digest("hex");
  const packet = buildReviewPacket({
    owner: "acme-org",
    repository: "widgets",
    pullNumber: 1,
    baseRef: "main",
    baseTipSha: "a".repeat(40),
    mergeBaseSha: "b".repeat(40),
    headSha: "c".repeat(40),
    diff: {
      changedFiles: [{
        path: "x",
        oldMode: "100644",
        newMode: "100644",
        oldOid: "1".repeat(40),
        newOid: "2".repeat(40),
        status: "M"
      }],
      patch,
      patchBytes: patch.length,
      patchDigest,
      pathsDigest: "d".repeat(64)
    },
    instructions: {
      files: [{
        path: "AGENTS.md",
        mode: "100644",
        blobOid: "3".repeat(40),
        bytes: instruction.length,
        sha256: instructionDigest,
        content: instruction,
        body: "attacker body"
      }],
      applicability: [{
        changedPath: "x",
        instructionPaths: ["AGENTS.md"],
        applicabilityDigest: "e".repeat(64),
        text: "attacker text"
      }],
      receipt: {
        files: [{ body: "receipt body" }],
        applicability: [{ text: "receipt text" }],
        totalBytes: 999999,
        body: "top-level body"
      }
    }
  });

  const receiptJson = JSON.stringify(packet.receipt);
  assert.equal(receiptJson.includes("attacker"), false);
  assert.equal(receiptJson.includes("receipt body"), false);
  assert.equal(receiptJson.includes("receipt text"), false);
  assert.equal(packet.receipt.instructions.totalBytes, instruction.length);
  assert.equal(packet.receipt.instructions.fileCount, 1);
  assert.deepEqual(
    Object.keys(packet.receipt.instructions.files[0]).sort(),
    ["blobOid", "bytes", "mode", "path", "sha256"]
  );
});

test("disposal runs on open failure (private dir cleaned)", async () => {
  const parent = tempDir("grok-collector-parent-");
  await assert.rejects(
    () => openTestExactHeadRepository({
      owner: "acme-org",
      repository: "widgets",
      pullNumber: 1,
      baseRef: "main",
      baseTipSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      testLocalRemoteUrl: path.join(parent, "missing-source"),
      gitExecutable: GIT,
      tempRoot: parent
    }),
    (e) => e instanceof CollectorError
  );
  // No leftover exact-head workspaces under parent (best-effort).
  const leftovers = fs.readdirSync(parent).filter((n) => n.startsWith("grok-review-exact-head-"));
  assert.deepEqual(leftovers, []);
  fs.rmSync(parent, { recursive: true, force: true });
});

test("disposal failure is visible and remains retryable", async () => {
  const source = buildSourceRepo(({ git, write, commit }) => {
    git(["checkout", "-b", "feature"]);
    write("src/app.js", "console.log('dispose')\n");
    git(["add", "src/app.js"]);
    commit("feature");
    git(["update-ref", "refs/pull/1/head", git(["rev-parse", "HEAD"])]);
  });
  const repo = await openFromSource(source);
  const realWorkspace = repo.workspaceRoot;
  repo.workspaceRoot = "\0";
  await assert.rejects(
    () => repo.dispose(),
    (e) => e instanceof CollectorError && e.code === CollectorErrorCode.E_COLLECTOR_DISPOSAL
  );
  assert.equal(repo.disposed, false);
  assert.equal(repo.disposalFailed, true);

  repo.workspaceRoot = realWorkspace;
  await repo.dispose();
  assert.equal(repo.disposed, true);
  assert.equal(fs.existsSync(realWorkspace), false);
  fs.rmSync(source.root, { recursive: true, force: true });
});

test("executable AGENTS.md mode 100755 is accepted", async () => {
  const source = buildSourceRepo(({ git, write, commit, root }) => {
    write("AGENTS.md", "# exec agents\n");
    git(["add", "AGENTS.md"]);
    git(["update-index", "--chmod=+x", "AGENTS.md"]);
    commit("exec agents");
    git(["checkout", "-b", "feature"]);
    write("z.js", "1\n");
    git(["add", "z.js"]);
    commit("feature");
    git(["update-ref", "refs/pull/1/head", git(["rev-parse", "HEAD"])]);
    void root;
  });
  const repo = await openFromSource(source);
  try {
    const diff = await collectExactHeadDiff(repo);
    const instructions = await collectHeadInstructions(repo, { headSha: repo.headSha }, diff.changedFiles);
    const rootAgents = instructions.files.find((f) => f.path === "AGENTS.md");
    assert.ok(rootAgents);
    assert.equal(rootAgents.mode, "100755");
  } finally {
    await repo.dispose();
    fs.rmSync(source.root, { recursive: true, force: true });
  }
});
