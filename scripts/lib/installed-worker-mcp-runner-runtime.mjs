// Installed Worker MCP qualification domain. Keep import-time behavior inert.
import { INSTALLED_WORKER_TOOL_NAMES, validateInstalledInitialize, validateInstalledToolInventory, validateInstalledToolResult } from "./installed-worker-mcp-contract.mjs";
import { CANONICAL_UUID, checkInterrupted, fail, hasExactKeys, isPlainRecord, MCP_SHUTDOWN_TIMEOUT_MS, PLUGIN_ID, PROTOCOL_VERSION, QualificationError, qualificationStage, RPC_TIMEOUT_MS, runBounded, RUNNER_VERSION, safeParseJson, sameJson, WRITE_VERTICAL_TOOL_NAMES } from "./installed-worker-mcp-runner-core.mjs";
import { spawnMcpStdioClient } from "./mcp-stdio-client.mjs";
import { canonicalPath, isPathInside } from "./plugin-inventory.mjs";
import { LIVE_RECEIPT_CAPABILITY_TOOL_IDS } from "./worker-broker-evidence.mjs";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
export function mkdirPrivate(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("E_CLEANUP");
}

export function privateLiveFixtureBase() {
  const configured = process.env.GROK_COMPANION_LIVE_FIXTURE_ROOT;
  const base = path.resolve(
    configured || path.join(os.homedir(), ".grok-companion-live-fixtures")
  );
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const resolved = fs.realpathSync(base);
  const stat = fs.lstatSync(resolved);
  const broadTemporaryRoots = [
    os.tmpdir(),
    "/tmp",
    "/private/tmp",
    process.env.TMPDIR,
    process.env.TMP,
    process.env.TEMP
  ]
    .filter((value) => typeof value === "string" && path.isAbsolute(value))
    .map((value) => {
      try {
        return fs.realpathSync(value);
      } catch {
        return path.resolve(value);
      }
    });
  if (
    resolved !== base
    || !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o077) !== 0
    || broadTemporaryRoots.some((temporary) => (
      resolved === temporary || resolved.startsWith(`${temporary}${path.sep}`)
    ))
  ) {
    fail("E_CAPABILITY");
  }
  return resolved;
}

export function buildChildEnvironment({
  codexHome,
  pluginData,
  threadId
}) {
  const env = {};
  const exact = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "GROK_BIN",
    "GROK_AUTH_PATH",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR"
  ];
  for (const key of exact) {
    if (typeof process.env[key] === "string" && process.env[key] !== "") {
      env[key] = process.env[key];
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (/^LC_[A-Z0-9_]+$/.test(key) && typeof value === "string" && value !== "") {
      env[key] = value;
    }
  }
  if (typeof process.env.LANG === "string" && process.env.LANG !== "") {
    env.LANG = process.env.LANG;
  }
  env.CODEX_HOME = codexHome;
  env.GROK_COMPANION_PLUGIN_DATA = pluginData;
  env.GROK_COMPANION_HOST = "codex";
  env.GROK_COMPANION_HOST_SESSION_ID = threadId;
  env.CODEX_THREAD_ID = threadId;
  env.NO_COLOR = "1";
  return env;
}

export function pathExecutableCandidates(name, env) {
  const pathValue = typeof env.PATH === "string" ? env.PATH : "";
  const extensions = process.platform === "win32"
    ? String(env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
        .split(";")
        .filter(Boolean)
    : [""];
  const candidates = [];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    if (!path.isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        const resolved = fs.realpathSync(candidate);
        const stat = fs.statSync(resolved);
        fs.accessSync(resolved, fs.constants.X_OK);
        if (stat.isFile() && !candidates.includes(resolved)) {
          candidates.push(resolved);
        }
      } catch {
        // A PATH entry that cannot resolve an executable is not launchable.
      }
    }
  }
  return candidates;
}

export function preserveProviderAuthPath(env) {
  const candidate = typeof env.GROK_AUTH_PATH === "string"
    && env.GROK_AUTH_PATH !== ""
    ? env.GROK_AUTH_PATH
    : path.join(env.HOME, ".grok", "auth.json");
  try {
    const resolved = fs.realpathSync(path.resolve(candidate));
    const stat = fs.lstatSync(resolved);
    fs.accessSync(resolved, fs.constants.R_OK);
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || stat.size < 1
      || stat.size > 1024 * 1024
    ) {
      fail("E_CAPABILITY");
    }
    env.GROK_AUTH_PATH = resolved;
    return resolved;
  } catch (error) {
    if (error instanceof QualificationError) throw error;
    fail("E_CAPABILITY");
  }
}

export function poisonChildProviderDiscovery(env, temporaryRoot) {
  const providerAuthPath = preserveProviderAuthPath(env);
  const preserveKeys = [
    "GROK_AUTH_PATH",
    "GROK_COMPANION_PLUGIN_DATA",
    "GROK_COMPANION_HOST",
    "GROK_COMPANION_HOST_SESSION_ID",
    "CODEX_HOME",
    "CODEX_THREAD_ID",
    "TMPDIR",
    "TMP",
    "TEMP",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR"
  ];
  const preserved = Object.freeze(Object.fromEntries(
    preserveKeys
      .filter((key) => Object.hasOwn(env, key))
      .map((key) => [key, env[key]])
  ));
  const originalEntries = String(env.PATH || "")
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry));
  const safeEntries = [...new Set(originalEntries)].filter((directory) => {
    const candidateEnv = { ...env, PATH: directory };
    return pathExecutableCandidates("grok", candidateEnv).length === 0;
  });
  const filteredPath = safeEntries.join(path.delimiter);
  const poisonedHome = path.join(temporaryRoot, "provider-discovery-poison-home");
  mkdirPrivate(poisonedHome);
  if (fs.readdirSync(poisonedHome).length !== 0) fail("E_CAPABILITY");
  const poisonedGrokHome = path.join(poisonedHome, ".grok");
  const missingGrokBinary = path.join(poisonedHome, "missing-grok");
  const poisoned = {
    ...env,
    HOME: poisonedHome,
    USERPROFILE: poisonedHome,
    GROK_HOME: poisonedGrokHome,
    GROK_BIN: missingGrokBinary,
    PATH: filteredPath
  };
  if (
    pathExecutableCandidates("git", poisoned).length < 1
    || pathExecutableCandidates("grok", poisoned).length !== 0
    || fs.existsSync(missingGrokBinary)
    || fs.existsSync(poisonedGrokHome)
  ) {
    fail("E_CAPABILITY");
  }
  for (const [key, value] of Object.entries(preserved)) {
    if (poisoned[key] !== value) fail("E_CAPABILITY");
  }
  Object.assign(env, poisoned);
  return Object.freeze({
    home: poisonedHome,
    userProfile: poisonedHome,
    grokHome: poisonedGrokHome,
    missingGrokBinary,
    path: filteredPath,
    gitBinary: pathExecutableCandidates("git", env)[0],
    providerAuthPath,
    preserved
  });
}

export function assertChildProviderDiscoveryPoison(context) {
  const poison = context.discoveryPoison;
  if (!poison) return true;
  let stat;
  try {
    stat = fs.lstatSync(poison.home);
  } catch {
    fail("E_CAPABILITY");
  }
  // Runner-owned provider probes receive their exact task HOME explicitly.
  // Any state created here proves an ambient-home fallback and must fail.
  if (
    context.env.HOME !== poison.home
    || context.env.USERPROFILE !== poison.userProfile
    || context.env.GROK_HOME !== poison.grokHome
    || context.env.GROK_BIN !== poison.missingGrokBinary
    || context.env.PATH !== poison.path
    || !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o077) !== 0
    || fs.readdirSync(poison.home).length !== 0
    || fs.existsSync(poison.grokHome)
    || fs.existsSync(poison.missingGrokBinary)
    || context.env.GROK_AUTH_PATH !== poison.providerAuthPath
    || !fs.existsSync(poison.providerAuthPath)
    || pathExecutableCandidates("grok", context.env).length !== 0
    || !pathExecutableCandidates("git", context.env).includes(poison.gitBinary)
  ) {
    fail("E_CAPABILITY");
  }
  for (const [key, value] of Object.entries(poison.preserved)) {
    if (context.env[key] !== value) fail("E_CAPABILITY");
  }
  return true;
}

export function initializeFixtureRepository(root, env, {
  workloadFiles = 0,
  writeTarget = false
} = {}) {
  mkdirPrivate(root);
  runBounded("git", ["init", "--quiet"], {
    cwd: root,
    env,
    requireSilentStderr: false,
    code: "E_SCENARIO"
  });
  fs.writeFileSync(
    path.join(root, "tracked.txt"),
    "Installed Worker MCP qualification fixture.\n",
    { encoding: "utf8", mode: 0o600 }
  );
  if (writeTarget) {
    const target = path.join(root, "target.txt");
    fs.writeFileSync(target, "before\n", { encoding: "utf8", mode: 0o644 });
    fs.chmodSync(target, 0o644);
  }
  if (workloadFiles > 0) {
    const workload = path.join(root, "qualification-workload");
    mkdirPrivate(workload);
    for (let index = 0; index < workloadFiles; index += 1) {
      const marker = String(index + 1).padStart(2, "0");
      fs.writeFileSync(
        path.join(workload, `${marker}.txt`),
        `Read-only qualification marker ${marker} of ${workloadFiles}.\n`,
        { encoding: "utf8", mode: 0o600 }
      );
    }
  }
  runBounded("git", ["add", "--", "."], {
    cwd: root,
    env,
    requireSilentStderr: false,
    code: "E_SCENARIO"
  });
  runBounded("git", [
    "-c", "user.name=Worker MCP Qualification",
    "-c", "user.email=worker-mcp@example.invalid",
    "commit", "--quiet", "-m", "fixture"
  ], {
    cwd: root,
    env,
    requireSilentStderr: false,
    code: "E_SCENARIO"
  });
  const status = runBounded("git", [
    "status", "--porcelain=v1", "-z", "--untracked-files=all"
  ], {
    cwd: root,
    env,
    requireSilentStderr: false,
    code: "E_SCENARIO"
  }).stdout;
  if (status !== "") fail("E_SCENARIO");
  return status;
}

export function captureProviderFileIdentity(file) {
  const resolved = canonicalPath(file, "Provider binary");
  let descriptor;
  try {
    descriptor = fs.openSync(
      resolved,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const before = fs.fstatSync(descriptor);
    if (
      !before.isFile()
      || before.size < 1
      || before.size > 128 * 1024 * 1024
    ) {
      fail("E_CAPABILITY");
    }
    const contentDigest = crypto
      .createHash("sha256")
      .update(fs.readFileSync(descriptor))
      .digest("hex");
    const after = fs.fstatSync(descriptor);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || Math.trunc(before.mtimeMs) !== Math.trunc(after.mtimeMs)
    ) {
      fail("E_CAPABILITY");
    }
    return Object.freeze({
      path: resolved,
      device: String(before.dev),
      inode: String(before.ino),
      size: before.size,
      mtimeMs: Math.trunc(before.mtimeMs),
      contentDigest
    });
  } catch (error) {
    if (error instanceof QualificationError) throw error;
    fail("E_CAPABILITY");
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

export function recheckProviderExecutablePin(context, expectedProviderIdentity) {
  assertChildProviderDiscoveryPoison(context);
  let active;
  let capability;
  let resolved;
  try {
    active = context.providerExecutablePin.readActiveProviderLaunchBinding({
      env: context.env
    });
    capability =
      context.providerCapabilityModule.readValidProviderCapabilityReceipt({
        env: context.env
      });
    resolved = context.providerExecutablePin.resolveProviderExecutablePin(
      active,
      { env: context.env }
    );
  } catch {
    fail("E_CAPABILITY");
  }
  const currentIdentity = captureProviderFileIdentity(resolved.binary);
  if (
    !sameJson(active, context.providerLaunchBinding)
    || context.providerExecutablePin.providerLaunchBindingDigest(active)
      !== context.providerLaunchBindingDigest
    || capability?.receiptDigest
      !== context.providerCapability.receiptDigest
    || !sameJson(
      capability?.providerLaunchBinding,
      context.providerLaunchBinding
    )
    || resolved.executableIdentity.identityDigest
      !== context.providerExecutableIdentityDigest
    || resolved.executableIdentity.releaseIdentityDigest
      !== context.providerReleaseIdentityDigest
    || !sameJson(currentIdentity, expectedProviderIdentity)
  ) {
    fail("E_CAPABILITY");
  }
  return Object.freeze({
    active,
    capability,
    resolved,
    currentIdentity
  });
}

export async function importInstalled(installedRoot, relative, code = "E_INSTALL") {
  const absolute = path.join(installedRoot, ...relative.split("/"));
  if (!isPathInside(installedRoot, absolute)) fail(code);
  try {
    return await import(pathToFileURL(absolute).href);
  } catch {
    fail(code);
  }
}

export function createMetadata(threadId, fixtureRoot, observedTurnIds) {
  const turnId = crypto.randomUUID();
  if (
    !CANONICAL_UUID.test(turnId)
    || observedTurnIds.has(turnId)
  ) {
    fail("E_MCP");
  }
  observedTurnIds.add(turnId);
  return {
    threadId,
    plugin_id: PLUGIN_ID,
    "x-codex-turn-metadata": {
      thread_id: threadId,
      turn_id: turnId,
      plugin_id: PLUGIN_ID
    },
    "codex/sandbox-state-meta": {
      sandboxCwd: pathToFileURL(fixtureRoot).href
    }
  };
}

export function expectedCapabilityMatrix() {
  return {
    schemaVersion: 1,
    identity: "full",
    threadId: true,
    turnMetadata: true,
    sandboxCwd: true,
    pluginId: true,
    mutationAllowed: true,
    readAllowed: true,
    fallback: null,
    note: "Structured MCP identity complete."
  };
}

export function validateWriteSmokeInitialize(result, context) {
  if (
    !isPlainRecord(result?._meta)
    || !hasExactKeys(result._meta, new Set([
      "grok/capability-matrix",
      "grok/capabilityDigest",
      "grok/providerLaunchBindingDigest",
      "grok/writeLifecycleCapabilityDigest",
      "grok/hostVerification",
      "grok/supportedProtocolVersions",
      "grok/externalWorkerLabel"
    ]))
    || result._meta["grok/providerLaunchBindingDigest"]
      !== context.providerCapability.providerLaunchBindingDigest
    || result._meta["grok/writeLifecycleCapabilityDigest"]
      !== context.writeLifecycleCapabilityDigest
  ) {
    fail("E_MCP");
  }
  const projected = {
    ...result,
    _meta: { ...result._meta }
  };
  delete projected._meta["grok/writeLifecycleCapabilityDigest"];
  return validateInstalledInitialize(projected, {
    serverVersion: context.serverVersion,
    capabilityDigest: context.providerCapability.capabilityDigest,
    providerLaunchBindingDigest:
      context.providerCapability.providerLaunchBindingDigest,
    experimentalCapabilities: context.experimentalCapabilities,
    capabilityMatrix: expectedCapabilityMatrix()
  });
}

export async function startInstalledMcp(context) {
  assertChildProviderDiscoveryPoison(context);
  checkInterrupted(context.runner);
  const client = spawnMcpStdioClient({
    executable: process.execPath,
    argv: [path.join(context.installedRoot, "mcp", "server.mjs")],
    cwd: context.installedRoot,
    env: context.env,
    rpcTimeoutMs: context.writeSmoke ? 180_000 : RPC_TIMEOUT_MS,
    shutdownTimeoutMs: MCP_SHUTDOWN_TIMEOUT_MS
  });
  context.runner.clients.add(client);
  try {
    const initializeMeta = createMetadata(
      context.threadId,
      context.fixtureRoot,
      context.runner.turnIds
    );
    await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: {
        name: "grok-installed-worker-mcp-qualification",
        version: RUNNER_VERSION
      },
      capabilities: {
        experimental: context.experimentalCapabilities
      },
      _meta: initializeMeta
    }, (result) => context.writeSmoke
      ? validateWriteSmokeInitialize(result, context)
      : validateInstalledInitialize(result, {
          serverVersion: context.serverVersion,
          capabilityDigest: context.providerCapability.capabilityDigest,
          providerLaunchBindingDigest:
            context.providerCapability.providerLaunchBindingDigest,
          experimentalCapabilities: context.experimentalCapabilities,
          capabilityMatrix: expectedCapabilityMatrix()
        }));
    return client;
  } catch {
    try { await client.terminate(); } catch {}
    context.runner.clients.delete(client);
    fail("E_MCP");
  }
}

export async function closeMcp(context, client) {
  try {
    await client.close();
  } catch {
    try { await client.terminate(); } catch {}
    fail("E_MCP");
  } finally {
    context.runner.clients.delete(client);
  }
  const diagnostics = client.diagnostics();
  if (
    diagnostics.state !== "closed"
    || diagnostics.childExited !== true
    || diagnostics.pendingRequests !== 0
    || diagnostics.activeOperations !== 0
    || diagnostics.activeWrites !== 0
    || diagnostics.listenerCount !== 0
    || diagnostics.handlesReleased !== true
  ) {
    fail("E_MCP");
  }
}

export async function callTool(context, client, name, argumentsValue, expectedPayloadKeys) {
  checkInterrupted(context.runner);
  let result;
  try {
    result = await client.request("tools/call", {
      name,
      arguments: argumentsValue,
      _meta: createMetadata(
        context.threadId,
        context.fixtureRoot,
        context.runner.turnIds
      )
    });
  } catch {
    fail("E_MCP");
  }
  if (
    context.writeSmoke
    && ["worker_integrate", "worker_cleanup"].includes(name)
    && result?.structuredContent?.ok !== true
  ) {
    let lifecycle = null;
    try {
      const workerId = argumentsValue?.id;
      const jobFile = context.state.jobFileIfPresent(
        context.fixtureRoot,
        workerId,
        context.env
      );
      const registryFile = jobFile
        ? path.join(
            path.dirname(path.dirname(jobFile)),
            "owner-lifecycle",
            "registry.json"
          )
        : null;
      const registry = registryFile && fs.existsSync(registryFile)
        ? safeParseJson(fs.readFileSync(registryFile, "utf8"), "E_SCENARIO")
        : null;
      const record = registry?.records?.[workerId];
      const current = name === "worker_integrate"
        ? record?.integration
        : record?.cleanup;
      const projectController = (intent) => {
        if (!intent || typeof intent !== "object") return null;
        const status = ["pending", "active", "settled"].includes(intent.status)
          ? intent.status
          : null;
        const outcome = [
          "completed",
          "effect-failed",
          "cancelled",
          "startup-failed"
        ].includes(intent.outcome)
          ? intent.outcome
          : null;
        return {
          status,
          outcome,
          controllerFence:
            Number.isSafeInteger(intent.controllerFence)
            && intent.controllerFence > 0
              ? intent.controllerFence
              : null,
          processRecorded: Boolean(intent.processIdentity),
          receiptsRecorded: /^[a-f0-9]{64}$/.test(
            String(intent.receiptsDigest || "")
          ),
          cleanupProofRecorded: /^[a-f0-9]{64}$/.test(
            String(intent.cleanupProofDigest || "")
          )
        };
      };
      lifecycle = current
        ? {
            state: /^[a-z][a-z0-9-]{0,31}$/.test(
              String(current.state || "")
            )
              ? current.state
              : null,
            attempts: Number.isSafeInteger(current.attempts)
              ? current.attempts
              : null,
            closeAttempts: Number.isSafeInteger(current.closeAttempts)
              ? current.closeAttempts
              : null,
            sessionDeleteAttempts:
              Number.isSafeInteger(current.sessionDeleteAttempts)
                ? current.sessionDeleteAttempts
                : null,
            removeAttempts: Number.isSafeInteger(current.removeAttempts)
              ? current.removeAttempts
              : null,
            errorClassification: /^[a-z][a-z0-9-]{0,63}$/.test(
              String(current.error?.classification || "")
            )
              ? current.error.classification
              : null,
            errorMessageDigest: typeof current.error?.message === "string"
              ? crypto
                  .createHash("sha256")
                  .update(current.error.message)
                  .digest("hex")
              : null,
            controller: name === "worker_integrate"
              ? projectController(current.controllerIntent)
              : null,
            closeController: name === "worker_cleanup"
              ? projectController(current.closeControllerIntent)
              : null,
            removeController: name === "worker_cleanup"
              ? projectController(current.removeControllerIntent)
              : null
          }
        : null;
    } catch {
      lifecycle = { diagnosticFailed: true };
    }
    process.stderr.write(
      `Installed Worker MCP owner-lifecycle diagnostic ${JSON.stringify({
        schemaVersion: 1,
        stage: qualificationStage,
        tool: name,
        publicErrorCode: /^E_[A-Z0-9_]{1,126}$/.test(
          String(result?.structuredContent?.error?.code || "")
        )
          ? result.structuredContent.error.code
          : null,
        lifecycle
      })}\n`
    );
  }
  return validateInstalledToolResult(result, {
    outcome: "ok",
    expectedPayloadKeys
  });
}

export async function callWriteSmokeWait(
  context,
  client,
  workerId,
  cursor,
  timeoutMs
) {
  checkInterrupted(context.runner);
  let result;
  try {
    result = await client.request("tools/call", {
      name: "worker_wait",
      arguments: {
        id: workerId,
        ...(cursor ? { cursor } : {}),
        timeoutMs
      },
      _meta: createMetadata(
        context.threadId,
        context.fixtureRoot,
        context.runner.turnIds
      )
    });
  } catch {
    fail("E_MCP");
  }
  const publicErrorCode = result?.structuredContent?.error?.code;
  if (/^E_[A-Z0-9_]{1,126}$/.test(String(publicErrorCode || ""))) {
    process.stderr.write(
      `Installed Worker MCP write-smoke diagnostic ${JSON.stringify({
        schemaVersion: 1,
        stage: "write-smoke-wait",
        publicErrorCode
      })}\n`
    );
    fail("E_SCENARIO");
  }
  return validateInstalledToolResult(result, {
    outcome: "ok",
    expectedPayloadKeys: ["stream"]
  });
}

export async function callWriteSmokeResult(context, client, workerId) {
  checkInterrupted(context.runner);
  let result;
  try {
    result = await client.request("tools/call", {
      name: "worker_result",
      arguments: { id: workerId },
      _meta: createMetadata(
        context.threadId,
        context.fixtureRoot,
        context.runner.turnIds
      )
    });
  } catch {
    fail("E_MCP");
  }
  const structured = result?.structuredContent;
  const worker = structured?.worker;
  const publicErrorCode = structured?.error?.code;
  const status = /^[a-z][a-z0-9-]{0,31}$/.test(String(worker?.status || ""))
    ? worker.status
    : null;
  const phase = /^[a-z][a-z0-9-]{0,63}$/.test(String(worker?.phase || ""))
    ? worker.phase
    : null;
  const workerErrorCode = /^E_[A-Z0-9_]{1,126}$/.test(
    String(worker?.error?.code || "")
  )
    ? worker.error.code
    : null;
  if (
    /^E_[A-Z0-9_]{1,126}$/.test(String(publicErrorCode || ""))
    || structured?.ok !== true
    || status !== "completed"
    || !Object.hasOwn(structured || {}, "artifact")
  ) {
    let privateJob = null;
    try {
      privateJob = context.state.tryReadJob(
        context.fixtureRoot,
        workerId,
        context.env
      );
    } catch {
      privateJob = null;
    }
    const privateDispatch = privateJob?.request?.spawn?.dispatch;
    const privateErrorMessage = typeof privateJob?.error?.message === "string"
      ? privateJob.error.message
      : null;
    let executionObservation = null;
    try {
      const executionRoot = privateJob?.executionBinding?.expectedExecutionRoot;
      const baseCommit = privateJob?.executionBinding?.baseCommit;
      const expectedRoot = context.workerWorktree.expectedWorkerWorktreeRoot(
        context.fixtureRoot,
        workerId,
        context.env
      );
      if (
        typeof executionRoot === "string"
        && executionRoot === expectedRoot
        && typeof baseCommit === "string"
        && fs.existsSync(executionRoot)
      ) {
        const statusBytes = runBounded(
          "git",
          ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
          {
            cwd: executionRoot,
            env: context.env,
            requireSilentStderr: false,
            code: "E_SCENARIO"
          }
        ).stdout;
        const changedBytes = runBounded(
          "git",
          [
            "diff",
            "--name-status",
            "-z",
            "--no-renames",
            baseCommit,
            "--"
          ],
          {
            cwd: executionRoot,
            env: context.env,
            requireSilentStderr: false,
            code: "E_SCENARIO"
          }
        ).stdout;
        const untrackedBytes = runBounded(
          "git",
          ["ls-files", "--others", "--exclude-standard", "-z"],
          {
            cwd: executionRoot,
            env: context.env,
            requireSilentStderr: false,
            code: "E_SCENARIO"
          }
        ).stdout;
        const targetFile = path.join(executionRoot, "target.txt");
        const target = fs.lstatSync(targetFile);
        const targetContent = fs.readFileSync(targetFile);
        let parentUnchanged = false;
        try {
          context.workerWorktree.assertParentUnchanged(
            privateJob.executionBinding.parentFingerprint,
            context.fixtureRoot
          );
          parentUnchanged = true;
        } catch {}
        executionObservation = {
          parentUnchanged,
          statusBytes: Buffer.byteLength(statusBytes),
          statusDigest: crypto
            .createHash("sha256")
            .update(statusBytes)
            .digest("hex"),
          changedBytes: Buffer.byteLength(changedBytes),
          changedDigest: crypto
            .createHash("sha256")
            .update(changedBytes)
            .digest("hex"),
          untrackedBytes: Buffer.byteLength(untrackedBytes),
          targetRegular: target.isFile() && !target.isSymbolicLink(),
          targetMode: target.mode & 0o7777,
          targetBytes: targetContent.length,
          targetContentDigest: crypto
            .createHash("sha256")
            .update(targetContent)
            .digest("hex"),
          targetExactExpected: targetContent.equals(Buffer.from("after\n"))
        };
      }
    } catch {
      executionObservation = { diagnosticFailed: true };
    }
    process.stderr.write(
      `Installed Worker MCP write-smoke diagnostic ${JSON.stringify({
        schemaVersion: 1,
        stage: "write-smoke-result",
        publicErrorCode: /^E_[A-Z0-9_]{1,126}$/.test(
          String(publicErrorCode || "")
        )
          ? publicErrorCode
          : null,
        workerStatus: status,
        workerPhase: phase,
        workerErrorCode,
        artifactPresent: Object.hasOwn(structured || {}, "artifact"),
        privateStateReadable: privateJob !== null,
        providerLaunchOutcome: /^[a-z][a-z0-9-]{0,31}$/.test(
          String(privateJob?.request?.spawn?.providerLaunchOutcome || "")
        )
          ? privateJob.request.spawn.providerLaunchOutcome
          : null,
        providerLaunchBindingPresent:
          privateJob?.request?.spawn?.providerLaunchBinding != null,
        providerLaunchBindingDigest:
          /^[a-f0-9]{64}$/.test(
            String(
              privateJob?.request?.spawn?.providerLaunchBindingDigest || ""
            )
          )
            ? privateJob.request.spawn.providerLaunchBindingDigest
            : null,
        executionProviderLaunchBindingDigest:
          /^[a-f0-9]{64}$/.test(
            String(
              privateJob?.executionBinding?.providerLaunchBindingDigest || ""
            )
          )
            ? privateJob.executionBinding.providerLaunchBindingDigest
            : null,
        dispatchState: /^[a-z][a-z0-9-]{0,31}$/.test(
          String(privateDispatch?.state || "")
        )
          ? privateDispatch.state
          : null,
        providerGeneration: Number.isSafeInteger(
          privateDispatch?.providerGeneration
        )
          ? privateDispatch.providerGeneration
          : null,
        controllerProcessPresent: privateJob?.controllerProcess != null,
        workerProcessPresent: privateJob?.workerProcess != null,
        providerProcessPresent: privateJob?.providerProcess != null,
        providerSessionPresent:
          typeof privateJob?.grokSessionId === "string",
        taskRuntimeCleaned:
          privateJob?.result?.taskRuntimeCleaned === true,
        stopReason: /^[a-z][a-z0-9-]{0,63}$/.test(
          String(privateJob?.result?.stopReason || "")
        )
          ? privateJob.result.stopReason
          : null,
        workerReportValid:
          privateJob?.result?.workerReport?.valid === true,
        workerReportOutcome: ["complete", "partial", "blocked"].includes(
          privateJob?.result?.workerReport?.outcome
        )
          ? privateJob.result.workerReport.outcome
          : null,
        privateErrorMessageDigest: privateErrorMessage
          ? crypto.createHash("sha256").update(privateErrorMessage).digest("hex")
          : null,
        executionObservation,
        lifecycleEventTypes: Array.isArray(privateJob?.lifecycleEvents)
          ? privateJob.lifecycleEvents
              .slice(-8)
              .map((event) => String(event?.type || "").slice(0, 64))
          : []
      })}\n`
    );
    fail("E_SCENARIO");
  }
  return validateInstalledToolResult(result, {
    outcome: "ok",
    expectedPayloadKeys: ["worker", "artifact"]
  });
}

export async function verifyMcpSurface(context, client, { negative = false } = {}) {
  if (negative) {
    let denied;
    try {
      denied = await client.request("tools/call", {
        name: "worker_list_owned",
        arguments: {}
      });
    } catch {
      fail("E_MCP");
    }
    validateInstalledToolResult(denied, {
      outcome: "error",
      expectedErrorCode: "E_AUTH_REQUIRED"
    });
  }
  let listed;
  try {
    listed = await client.request("tools/list", {
      _meta: createMetadata(
        context.threadId,
        context.fixtureRoot,
        context.runner.turnIds
      )
    });
  } catch {
    fail("E_MCP");
  }
  if (context.writeSmoke) {
    if (
      !isPlainRecord(listed)
      || !hasExactKeys(listed, new Set(["tools"]))
      || !Array.isArray(listed.tools)
      || !sameJson(listed.tools, context.workerTools)
      || !sameJson(
        listed.tools.map((tool) => tool?.name),
        context.workerTools.map((tool) => tool.name)
      )
    ) {
      fail("E_MCP");
    }
    const projected = {
      tools: listed.tools.filter((tool) => (
        !WRITE_VERTICAL_TOOL_NAMES.has(tool?.name)
      ))
    };
    validateInstalledToolInventory(projected, context.defaultWorkerTools);
    return;
  }
  validateInstalledToolInventory(listed, context.workerTools);
  if (
    !sameJson(context.workerTools.map((tool) => tool.name), INSTALLED_WORKER_TOOL_NAMES)
    || !sameJson(INSTALLED_WORKER_TOOL_NAMES, LIVE_RECEIPT_CAPABILITY_TOOL_IDS)
  ) {
    fail("E_MCP");
  }
}
