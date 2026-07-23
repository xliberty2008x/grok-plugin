#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  INSTALLED_WORKER_TOOL_NAMES,
  validateInstalledCancellationReplayScenario,
  validateInstalledCompletionScenario,
  validateInstalledInitialize,
  validateInstalledScenarioEvidence,
  validateInstalledSetup,
  validateInstalledToolInventory,
  validateInstalledToolResult,
  validateProviderCapabilityAgreement
} from "./lib/installed-worker-mcp-contract.mjs";
import { selectInstalledWorkerMcpFailure } from "./lib/installed-worker-mcp-failure.mjs";
import { spawnMcpStdioClient } from "./lib/mcp-stdio-client.mjs";
import {
  canonicalPath,
  createPluginInventory,
  describeInventoryDifference,
  digestInventory,
  digestRegularFile,
  isPathInside
} from "./lib/plugin-inventory.mjs";
import {
  LIVE_RECEIPT_AUTHORITY_CONFIG,
  LIVE_RECEIPT_AUTHORITY_SYNTHETIC,
  LIVE_RECEIPT_CAPABILITY_TOOL_IDS,
  LIVE_RECEIPT_MANIFEST,
  LIVE_RECEIPT_PRODUCER_ID,
  LIVE_RECEIPT_PRODUCER_VERSION,
  LIVE_RECEIPT_ROOT,
  LIVE_RECEIPT_SCHEMA_VERSION,
  computeInventoryDigest,
  computeLiveQualificationReceiptDigest,
  computeLiveReceiptManifestDigest,
  computePhaseScopeDigest,
  gitIdentity,
  isNonEvidenceTreeClean,
  validateLiveQualificationReceipt
} from "./lib/worker-broker-evidence.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PLUGIN = path.join(ROOT, "plugins", "grok");
const PLUGIN_ID = "grok@grok-companion";
const MARKETPLACE_ID = "grok-companion";
const PROTOCOL_VERSION = "2025-11-25";
const RUNNER_VERSION = "1";
const EXPECTED_EXPERIMENTAL_CAPABILITIES = Object.freeze({
  "codex/sandbox-state-meta": Object.freeze({})
});
const HELP = "Usage: GROK_E2E=1 GROK_INSTALLED_WORKER_MCP_E2E=1 GROK_E2E_CANCEL=1 npm run test:installed-worker-mcp\n";
const LIVE_GATES = Object.freeze([
  "GROK_E2E",
  "GROK_INSTALLED_WORKER_MCP_E2E",
  "GROK_E2E_CANCEL"
]);
const RPC_TIMEOUT_MS = 35_000;
const MCP_SHUTDOWN_TIMEOUT_MS = 2_000;
const SCENARIO_TIMEOUT_MS = 20 * 60_000;
const STATE_POLL_MS = 100;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const FIXED_ERRORS = Object.freeze({
  E_ARGUMENT: "Unsupported runner argument.",
  E_GATE: "All installed Worker MCP live gates must equal 1.",
  E_PLATFORM: "Installed Worker MCP qualification requires a supported POSIX host.",
  E_SOURCE: "The qualification source boundary is not clean and stable.",
  E_INSTALL: "The private Codex plugin installation could not be verified.",
  E_SETUP: "The installed provider setup could not be verified.",
  E_CAPABILITY: "The installed provider capability could not be verified.",
  E_MCP: "The installed Worker MCP protocol could not be verified.",
  E_SCENARIO: "The installed Worker MCP scenario did not satisfy its contract.",
  E_PRIVATE_STATE: "Installed private worker state did not satisfy its contract.",
  E_SESSION: "The exact qualification provider session could not be verified.",
  E_CLEANUP: "Exact qualification cleanup could not be proven.",
  E_RECEIPT: "The provisional live receipt could not be validated or published.",
  E_INTERRUPTED: "Installed Worker MCP qualification was interrupted."
});
const QUALIFICATION_STAGES = new Set([
  "startup",
  "source-boundary",
  "private-install",
  "installed-imports",
  "provider-setup",
  "provider-capability",
  "completion-mcp-surface",
  "completion-spawn",
  "completion-wait",
  "completion-result",
  "completion-cleanup",
  "completion-session-cleanup",
  "completion-contract",
  "cancellation-mcp-surface",
  "cancellation-spawn",
  "cancellation-live-provider",
  "cancellation-reconnect",
  "cancellation-replay",
  "cancellation-request",
  "cancellation-wait",
  "cancellation-result",
  "cancellation-cleanup",
  "cancellation-session-cleanup",
  "cancellation-contract",
  "global-cleanup",
  "installed-recheck",
  "evidence-binding",
  "receipt-publication",
  "emergency-cleanup"
]);
let qualificationStage = "startup";

function enterQualificationStage(stage) {
  if (!QUALIFICATION_STAGES.has(stage)) throw new Error("Unknown qualification stage.");
  qualificationStage = stage;
}

class QualificationError extends Error {
  constructor(code, stage = qualificationStage) {
    const normalized = Object.hasOwn(FIXED_ERRORS, code) ? code : "E_SCENARIO";
    super(FIXED_ERRORS[normalized]);
    this.name = "QualificationError";
    this.code = normalized;
    this.stage = QUALIFICATION_STAGES.has(stage) ? stage : "startup";
    this.stack = `${this.name}: ${this.message}`;
  }
}

function fail(code) {
  throw new QualificationError(code);
}

function checkInterrupted(state) {
  if (state.interrupted) fail("E_INTERRUPTED");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  const next = {};
  for (const key of Object.keys(value).sort()) next[key] = canonicalJson(value[key]);
  return next;
}

function sameJson(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  return isPlainRecord(value)
    && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key));
}

function boundedString(value, maximum, { nonempty = false } = {}) {
  return typeof value === "string"
    && value.length <= maximum
    && Buffer.byteLength(value, "utf8") <= maximum * 4
    && (!nonempty || value.length > 0);
}

function validStringList(value, {
  maximumItems = 200,
  maximumLength = 2000
} = {}) {
  return Array.isArray(value)
    && value.length <= maximumItems
    && value.every((item) => boundedString(item, maximumLength));
}

function safeParseJson(text, code) {
  if (
    typeof text !== "string"
    || Buffer.byteLength(text, "utf8") > MAX_COMMAND_OUTPUT_BYTES
  ) {
    fail(code);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(code);
  }
}

function runBounded(command, args, {
  cwd = ROOT,
  env = process.env,
  timeoutMs = 60_000,
  requireSilentStderr = true,
  code = "E_SCENARIO"
} = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    shell: false,
    timeout: timeoutMs,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES
  });
  if (
    result.error
    || result.status !== 0
    || result.signal
    || (requireSilentStderr && String(result.stderr || "").trim() !== "")
    || Buffer.byteLength(String(result.stdout || ""), "utf8") > MAX_COMMAND_OUTPUT_BYTES
    || Buffer.byteLength(String(result.stderr || ""), "utf8") > MAX_COMMAND_OUTPUT_BYTES
  ) {
    fail(code);
  }
  return result;
}

function runJson(command, args, options) {
  const result = runBounded(command, args, options);
  return safeParseJson(String(result.stdout || ""), options?.code || "E_SCENARIO");
}

function setupGuardDirectories(fixtureRoot, env) {
  const result = runBounded("git", ["rev-parse", "--git-common-dir"], {
    cwd: fixtureRoot,
    env,
    requireSilentStderr: false,
    code: "E_SETUP"
  });
  const reported = String(result.stdout || "").trim();
  if (!reported) fail("E_SETUP");
  let commonDirectory;
  try {
    commonDirectory = fs.realpathSync(
      path.isAbsolute(reported)
        ? reported
        : path.resolve(fixtureRoot, reported)
    );
  } catch {
    fail("E_SETUP");
  }
  const guardRoot = path.join(
    os.tmpdir(),
    `grok-companion-guards-${
      typeof process.getuid === "function" ? process.getuid() : "user"
    }`
  );
  const digest = (value) => crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex");
  return [...new Set([
    path.join(guardRoot, digest(commonDirectory)),
    path.join(guardRoot, digest(fs.realpathSync(fixtureRoot)))
  ])];
}

function createSetupBoundary({
  fixtureRoot,
  pluginData,
  env,
  threadId,
  processControl,
  guard
}) {
  const guardDirectories = setupGuardDirectories(fixtureRoot, env);
  for (const directory of guardDirectories) {
    try {
      if (fs.readdirSync(directory).length !== 0) fail("E_CLEANUP");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        if (error instanceof QualificationError) throw error;
        fail("E_CLEANUP");
      }
    }
  }
  return {
    fixtureRoot: fs.realpathSync(fixtureRoot),
    pluginData: fs.realpathSync(pluginData),
    env,
    threadId,
    processControl,
    guard,
    guardDirectories,
    commandPids: new Set(),
    identities: new Map(),
    guardRecords: new Map(),
    observedProvider: false,
    observedGuard: false,
    scanFailed: false,
    child: null,
    commandIdentity: null,
    commandPath: null,
    childExited: false,
    cleaned: false
  };
}

function validateSetupGuard(boundary, marker, record) {
  const expectedOwner = crypto
    .createHash("sha256")
    .update(boundary.threadId)
    .digest("hex");
  if (
    !hasExactKeys(record, new Set([
      "schemaVersion",
      "marker",
      "owner",
      "identityKind",
      "providerProcess",
      "createdAt"
    ]))
    || record.schemaVersion !== 1
    || record.marker !== marker
    || record.owner !== expectedOwner
    || record.identityKind !== "provider"
    || !hasExactKeys(
      record.providerProcess,
      new Set(["pid", "startToken", "processGroupId"])
    )
    || !canonicalTimestamp(record.createdAt)
  ) {
    fail("E_CLEANUP");
  }
  try {
    boundary.processControl.assertCompleteDetachedOwnedIdentity(
      record.providerProcess
    );
  } catch {
    fail("E_CLEANUP");
  }
  if (
    !boundary.processControl.processGroupGone(record.providerProcess)
    && !boundary.processControl.identityMatches(
      record.providerProcess,
      marker,
      "provider"
    )
  ) {
    fail("E_CLEANUP");
  }
}

function setupMarkerFromCommand(boundary, command) {
  if (
    typeof command !== "string"
    || !command.includes(boundary.fixtureRoot)
    || !command.includes(boundary.pluginData)
  ) {
    return null;
  }
  const matches = command.matchAll(/(?:^|[^a-zA-Z0-9._-])(setup-(\d+)-[0-9a-f]{12})(?=$|[^a-zA-Z0-9._-])/g);
  const markers = [...matches]
    .filter((match) => boundary.commandPids.has(Number(match[2])))
    .map((match) => match[1]);
  return new Set(markers).size === 1 ? markers[0] : null;
}

function scanSetupBoundary(boundary) {
  const activeGuardMarkers = new Set();
  for (const directory of boundary.guardDirectories) {
    let names;
    try {
      names = fs.readdirSync(directory);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      fail("E_CLEANUP");
    }
    for (const name of names) {
      const match = name.match(/^setup-(\d+)-([0-9a-f]{12})\.json$/);
      if (!match || !boundary.commandPids.has(Number(match[1]))) continue;
      const marker = name.slice(0, -5);
      let record;
      try {
        record = boundary.guard.loadProviderGuard(
          boundary.fixtureRoot,
          marker
        );
      } catch {
        fail("E_CLEANUP");
      }
      if (!record) fail("E_CLEANUP");
      validateSetupGuard(boundary, marker, record);
      const previous = boundary.guardRecords.get(marker);
      if (previous && !sameJson(previous, record)) fail("E_CLEANUP");
      const priorIdentity = boundary.identities.get(marker);
      if (
        priorIdentity
        && !sameJson(priorIdentity, record.providerProcess)
      ) {
        fail("E_CLEANUP");
      }
      boundary.guardRecords.set(marker, structuredClone(record));
      boundary.identities.set(
        marker,
        structuredClone(record.providerProcess)
      );
      boundary.observedGuard = true;
      boundary.observedProvider = true;
      activeGuardMarkers.add(marker);
    }
  }

  const listed = boundary.processControl.runSystemPs([
    "-axo",
    "pid=,command="
  ]);
  if (
    listed?.status !== 0
    || listed?.signal
    || listed?.error
    || Buffer.byteLength(String(listed.stdout || ""), "utf8")
      > MAX_COMMAND_OUTPUT_BYTES
  ) {
    fail("E_CLEANUP");
  }
  const liveMarkers = new Set();
  for (const line of String(listed.stdout || "").split("\n")) {
    const match = line.match(/^\s*(\d+)\s+([\s\S]+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2].trim();
    const marker = setupMarkerFromCommand(boundary, command);
    if (!marker) continue;
    const startToken = boundary.processControl.processStartToken(pid);
    if (!startToken) fail("E_CLEANUP");
    const identity = { pid, startToken, processGroupId: pid };
    try {
      boundary.processControl.assertCompleteDetachedOwnedIdentity(identity);
    } catch {
      fail("E_CLEANUP");
    }
    if (
      !boundary.processControl.identityMatches(identity, marker, "provider")
    ) {
      fail("E_CLEANUP");
    }
    const previous = boundary.identities.get(marker);
    if (previous && !sameJson(previous, identity)) fail("E_CLEANUP");
    boundary.identities.set(marker, identity);
    boundary.observedProvider = true;
    liveMarkers.add(marker);
  }
  return { activeGuardMarkers, liveMarkers };
}

async function stopSetupCommand(boundary) {
  const child = boundary?.child;
  const identity = boundary?.commandIdentity;
  if (
    !child
    || !identity
    || boundary.processControl.processGroupGone(identity)
  ) {
    return true;
  }
  const commandStillOwned = () => (
    boundary.processControl.processStartToken(identity.pid)
      === identity.startToken
    && boundary.processControl
      .processCommand(identity.pid)
      .includes(boundary.commandPath)
  );
  if (!commandStillOwned()) return false;
  const waitForExit = (timeoutMs) => new Promise((resolve) => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("close", done);
    timer = setTimeout(() => {
      child.removeListener("close", done);
      resolve(false);
    }, timeoutMs);
  });
  try { process.kill(-identity.processGroupId, "SIGTERM"); } catch {}
  if (!await waitForExit(1_000)) {
    if (!commandStillOwned()) return false;
    try { process.kill(-identity.processGroupId, "SIGKILL"); } catch {}
    await waitForExit(1_000);
  }
  boundary.childExited = child.exitCode != null || child.signalCode != null;
  return boundary.processControl.processGroupGone(identity);
}

async function cleanupSetupBoundary(boundary, {
  terminate = false,
  requireObservation = false
} = {}) {
  if (!boundary) return true;
  let clean = true;
  if (terminate && !await stopSetupCommand(boundary)) clean = false;
  for (let pass = 0; pass < 4; pass += 1) {
    try {
      scanSetupBoundary(boundary);
    } catch {
      clean = false;
      break;
    }
    for (const [marker, identity] of boundary.identities) {
      try {
        if (
          terminate
          && !boundary.processControl.processGroupGone(identity)
        ) {
          await boundary.processControl.terminateOwnedProcess(
            identity,
            marker,
            "provider"
          );
        }
      } catch {
        clean = false;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, STATE_POLL_MS));
  }
  for (const [marker, record] of boundary.guardRecords) {
    const identity = boundary.identities.get(marker);
    try {
      if (
        !identity
        || !boundary.processControl.processGroupGone(identity)
      ) {
        clean = false;
        continue;
      }
      const current = boundary.guard.loadProviderGuard(
        boundary.fixtureRoot,
        marker
      );
      if (current) {
        if (!sameJson(current, record)) {
          clean = false;
          continue;
        }
        boundary.guard.unregisterProviderGuard(
          boundary.fixtureRoot,
          marker,
          record,
          boundary.env
        );
      }
      if (
        boundary.guard.loadProviderGuard(boundary.fixtureRoot, marker)
          !== null
      ) {
        clean = false;
      }
    } catch {
      clean = false;
    }
  }
  let finalScan = null;
  try {
    finalScan = scanSetupBoundary(boundary);
  } catch {
    clean = false;
  }
  if (
    finalScan?.activeGuardMarkers.size
    || finalScan?.liveMarkers.size
    || [...boundary.identities.values()].some(
      (identity) => !boundary.processControl.processGroupGone(identity)
    )
    || (
      boundary.commandIdentity
      && !boundary.processControl.processGroupGone(boundary.commandIdentity)
    )
    || (requireObservation && (
      !boundary.observedProvider
      || !boundary.observedGuard
    ))
  ) {
    clean = false;
  }
  boundary.cleaned = clean;
  return clean;
}

async function runSetupJson(command, args, {
  cwd,
  env,
  timeoutMs,
  boundary,
  runner
}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let abortCode = null;
    let settled = false;
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    boundary.child = child;
    boundary.commandPath = path.resolve(command);
    if (Number.isSafeInteger(child.pid) && child.pid > 0) {
      boundary.commandPids.add(child.pid);
      const startToken = boundary.processControl.processStartToken(child.pid);
      const commandText = boundary.processControl.processCommand(child.pid);
      const identity = {
        pid: child.pid,
        startToken,
        processGroupId: child.pid
      };
      try {
        boundary.processControl.assertCompleteDetachedOwnedIdentity(identity);
      } catch {
        abortCode = "E_CLEANUP";
      }
      if (
        !commandText.includes(boundary.commandPath)
        || !commandText.includes("setup")
        || !commandText.includes("--json")
      ) {
        abortCode = "E_CLEANUP";
      }
      boundary.commandIdentity = identity;
    } else {
      abortCode = "E_SETUP";
    }
    const abort = (code) => {
      abortCode ||= code;
      const identity = boundary.commandIdentity;
      try {
        if (
          identity
          && boundary.processControl.processStartToken(identity.pid)
            === identity.startToken
          && boundary.processControl
            .processCommand(identity.pid)
            .includes(boundary.commandPath)
        ) {
          process.kill(-identity.processGroupId, "SIGTERM");
        } else {
          child.kill("SIGTERM");
        }
      } catch {}
    };
    const collect = (kind, chunk) => {
      if (kind === "stdout") stdout += String(chunk);
      else stderr += String(chunk);
      if (
        Buffer.byteLength(stdout, "utf8") > MAX_COMMAND_OUTPUT_BYTES
        || Buffer.byteLength(stderr, "utf8") > MAX_COMMAND_OUTPUT_BYTES
      ) {
        abort("E_SETUP");
      }
    };
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.on("error", () => abort("E_SETUP"));
    const poll = setInterval(() => {
      if (runner.interrupted) abort("E_INTERRUPTED");
      try {
        scanSetupBoundary(boundary);
      } catch {
        boundary.scanFailed = true;
        abort("E_CLEANUP");
      }
    }, 25);
    const timeout = setTimeout(() => abort("E_SETUP"), timeoutMs);
    const hardTimeout = setTimeout(() => {
      if (settled) return;
      try {
        if (
          boundary.commandIdentity
          && boundary.processControl.processStartToken(
            boundary.commandIdentity.pid
          ) === boundary.commandIdentity.startToken
        ) {
          process.kill(
            -boundary.commandIdentity.processGroupId,
            "SIGKILL"
          );
        }
      } catch {}
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      reject(new QualificationError(abortCode || "E_SETUP"));
    }, timeoutMs + 2_000);
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      clearTimeout(hardTimeout);
      boundary.childExited = true;
      try {
        scanSetupBoundary(boundary);
      } catch {
        boundary.scanFailed = true;
        abortCode ||= "E_CLEANUP";
      }
      if (
        abortCode
        || code !== 0
        || signal
        || String(stderr).trim() !== ""
      ) {
        reject(new QualificationError(abortCode || "E_SETUP"));
        return;
      }
      try {
        resolve(safeParseJson(stdout, "E_SETUP"));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function mkdirPrivate(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("E_CLEANUP");
}

function buildChildEnvironment({
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

function initializeFixtureRepository(root, env, { workloadFiles = 0 } = {}) {
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

function captureProviderFileIdentity(file) {
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

async function importInstalled(installedRoot, relative, code = "E_INSTALL") {
  const absolute = path.join(installedRoot, ...relative.split("/"));
  if (!isPathInside(installedRoot, absolute)) fail(code);
  try {
    return await import(pathToFileURL(absolute).href);
  } catch {
    fail(code);
  }
}

function createMetadata(threadId, fixtureRoot, observedTurnIds) {
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

function expectedCapabilityMatrix() {
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

async function startInstalledMcp(context) {
  checkInterrupted(context.runner);
  const client = spawnMcpStdioClient({
    executable: process.execPath,
    argv: [path.join(context.installedRoot, "mcp", "server.mjs")],
    cwd: context.installedRoot,
    env: context.env,
    rpcTimeoutMs: RPC_TIMEOUT_MS,
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
    }, (result) => validateInstalledInitialize(result, {
      serverVersion: context.serverVersion,
      capabilityDigest: context.providerCapability.capabilityDigest,
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

async function closeMcp(context, client) {
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

async function callTool(context, client, name, argumentsValue, expectedPayloadKeys) {
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
  return validateInstalledToolResult(result, {
    outcome: "ok",
    expectedPayloadKeys
  });
}

async function verifyMcpSurface(context, client, { negative = false } = {}) {
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
  validateInstalledToolInventory(listed, context.workerTools);
  if (
    !sameJson(context.workerTools.map((tool) => tool.name), INSTALLED_WORKER_TOOL_NAMES)
    || !sameJson(INSTALLED_WORKER_TOOL_NAMES, LIVE_RECEIPT_CAPABILITY_TOOL_IDS)
  ) {
    fail("E_MCP");
  }
}

const PUBLIC_EVENT_TYPES = new Set([
  "task.accepted",
  "plan.updated",
  "activity.started",
  "activity.completed",
  "checkpoint",
  "blocked",
  "final.report",
  "cancellation.requested"
]);
const EVENT_KEYS = new Set([
  "workerProtocolVersion",
  "eventSchemaVersion",
  "type",
  "at",
  "summary",
  "sequence"
]);
const EVENT_DETAIL_KEYS = new Set([
  "envelopeId",
  "resumeJobId",
  "spawnSuccessDefinition",
  "requestAcceptedAt",
  "reconciler",
  "messageId",
  "contentDigest",
  "parentWorkerId",
  "version",
  "name",
  "status",
  "mode",
  "state",
  "eventType",
  "verdict",
  "outcome",
  "hostVerification",
  "authority",
  "write",
  "replayedPrompt",
  "structured",
  "exitCode",
  "findings",
  "commands",
  "plan",
  "questions",
  "validationIssues",
  "observedChangedPaths"
]);
const CURSOR_KEYS = new Set(["schemaVersion", "workerId", "sequence"]);
const STREAM_KEYS = new Set([
  "workerProtocolVersion",
  "eventCursorSchemaVersion",
  "events",
  "nextCursor",
  "firstAvailableCursor",
  "firstAvailableSequence",
  "latestAvailableSequence",
  "gap",
  "terminal",
  "workerId",
  "latestAvailableCursor"
]);

function validateLifecycleDetail(detail) {
  if (
    !isPlainRecord(detail)
    || Object.keys(detail).length < 1
    || Object.keys(detail).length > EVENT_DETAIL_KEYS.size
    || Object.keys(detail).some((key) => !EVENT_DETAIL_KEYS.has(key))
    || Buffer.byteLength(JSON.stringify(detail), "utf8") > 64 * 1024
  ) {
    fail("E_PRIVATE_STATE");
  }
  const textLimits = {
    envelopeId: 256,
    resumeJobId: 256,
    spawnSuccessDefinition: 1000,
    requestAcceptedAt: 64,
    reconciler: 128,
    messageId: 256,
    contentDigest: 256,
    parentWorkerId: 256,
    version: 128,
    name: 300,
    status: 80
  };
  for (const [key, limit] of Object.entries(textLimits)) {
    if (Object.hasOwn(detail, key) && !boundedString(detail[key], limit)) {
      fail("E_PRIVATE_STATE");
    }
  }
  if (
    Object.hasOwn(detail, "requestAcceptedAt")
    && !canonicalTimestamp(detail.requestAcceptedAt)
  ) {
    fail("E_PRIVATE_STATE");
  }
  const enums = {
    mode: new Set(["read", "write"]),
    state: new Set(["accepted", "pending", "delivered", "delivery_unknown", "rejected"]),
    eventType: new Set(["tool", "plan", "message"]),
    verdict: new Set(["pass", "needs_changes"]),
    outcome: new Set(["complete", "partial", "blocked"]),
    hostVerification: new Set(["not_run", "passed", "failed", "skipped"]),
    authority: new Set(["host_asserted"])
  };
  for (const [key, allowed] of Object.entries(enums)) {
    if (Object.hasOwn(detail, key) && !allowed.has(detail[key])) {
      fail("E_PRIVATE_STATE");
    }
  }
  for (const key of ["write", "replayedPrompt", "structured"]) {
    if (Object.hasOwn(detail, key) && typeof detail[key] !== "boolean") {
      fail("E_PRIVATE_STATE");
    }
  }
  for (const key of ["exitCode", "findings", "commands"]) {
    if (
      Object.hasOwn(detail, key)
      && (
        !Number.isSafeInteger(detail[key])
        || (key !== "exitCode" && detail[key] < 0)
      )
    ) {
      fail("E_PRIVATE_STATE");
    }
  }
  for (const [key, maximumItems, maximumLength] of [
    ["plan", 20, 500],
    ["questions", 64, 2000],
    ["validationIssues", 200, 2000],
    ["observedChangedPaths", 200, 2000]
  ]) {
    if (
      Object.hasOwn(detail, key)
      && !validStringList(detail[key], { maximumItems, maximumLength })
    ) {
      fail("E_PRIVATE_STATE");
    }
  }
}

function validateLifecycleEvent(event) {
  const expectedKeys = new Set(EVENT_KEYS);
  if (Object.hasOwn(event || {}, "detail")) expectedKeys.add("detail");
  if (
    !hasExactKeys(event, expectedKeys)
    || event.workerProtocolVersion !== 1
    || event.eventSchemaVersion !== 1
    || !PUBLIC_EVENT_TYPES.has(event.type)
    || !canonicalTimestamp(event.at)
    || !boundedString(event.summary, 2000, { nonempty: true })
    || !Number.isSafeInteger(event.sequence)
    || event.sequence < 1
  ) {
    fail("E_PRIVATE_STATE");
  }
  if (Object.hasOwn(event, "detail")) validateLifecycleDetail(event.detail);
}

function validateCursor(cursor, expectedWorkerId) {
  if (
    !hasExactKeys(cursor, CURSOR_KEYS)
    || cursor.schemaVersion !== 1
    || cursor.workerId !== expectedWorkerId
    || !Number.isSafeInteger(cursor.sequence)
    || cursor.sequence < 0
  ) {
    fail("E_PRIVATE_STATE");
  }
  return cursor.sequence;
}

function orderedEventObserver() {
  const events = new Map();
  let maximum = 0;
  return {
    observe(values) {
      if (!Array.isArray(values)) fail("E_PRIVATE_STATE");
      let previous = 0;
      for (const event of values) {
        validateLifecycleEvent(event);
        const sequence = event?.sequence;
        if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence <= previous) {
          fail("E_PRIVATE_STATE");
        }
        previous = sequence;
        const serialized = JSON.stringify(canonicalJson(event));
        if (events.has(sequence) && events.get(sequence) !== serialized) {
          fail("E_PRIVATE_STATE");
        }
        if (!events.has(sequence)) {
          if (sequence <= maximum) fail("E_PRIVATE_STATE");
          events.set(sequence, serialized);
          maximum = sequence;
        }
      }
    },
    snapshot() {
      return [...events.entries()].map(([sequence, serialized]) => ({
        sequence,
        value: JSON.parse(serialized)
      }));
    },
    values() {
      return [...events.values()].map((serialized) => JSON.parse(serialized));
    },
    maximum() {
      return maximum;
    }
  };
}

function observeStream(
  observer,
  stream,
  expectedWorkerId,
  { wait = false, cursor = null } = {}
) {
  const expectedKeys = new Set(STREAM_KEYS);
  if (wait) expectedKeys.add("timedOut");
  const requestedSequence = cursor == null
    ? 0
    : validateCursor(cursor, expectedWorkerId);
  if (
    !hasExactKeys(stream, expectedKeys)
    || stream.workerProtocolVersion !== 1
    || stream.eventCursorSchemaVersion !== 1
    || stream.workerId !== expectedWorkerId
    || stream.gap !== false
    || typeof stream.terminal !== "boolean"
    || (wait && typeof stream.timedOut !== "boolean")
    || (wait && stream.terminal && stream.timedOut)
    || (
      stream.firstAvailableSequence !== null
      && (
        !Number.isSafeInteger(stream.firstAvailableSequence)
        || stream.firstAvailableSequence < 1
      )
    )
    || !Number.isSafeInteger(stream.latestAvailableSequence)
    || stream.latestAvailableSequence < 0
    || (
      stream.firstAvailableSequence === null
        ? stream.latestAvailableSequence !== 0
        : stream.firstAvailableSequence > stream.latestAvailableSequence
    )
  ) {
    fail("E_PRIVATE_STATE");
  }
  const nextSequence = validateCursor(stream.nextCursor, expectedWorkerId);
  const firstCursorSequence = validateCursor(
    stream.firstAvailableCursor,
    expectedWorkerId
  );
  const latestCursorSequence = validateCursor(
    stream.latestAvailableCursor,
    expectedWorkerId
  );
  if (
    firstCursorSequence !== (
      stream.firstAvailableSequence === null
        ? 0
        : Math.max(0, stream.firstAvailableSequence - 1)
    )
    || latestCursorSequence !== stream.latestAvailableSequence
    || requestedSequence > stream.latestAvailableSequence
    || !Array.isArray(stream.events)
  ) {
    fail("E_PRIVATE_STATE");
  }
  if (
    wait
    && stream.timedOut !== (
      stream.terminal === false
      && stream.events.length === 0
    )
  ) {
    fail("E_PRIVATE_STATE");
  }
  let prior = requestedSequence;
  for (const event of stream.events) {
    validateLifecycleEvent(event);
    if (
      event.sequence !== prior + 1
      || event.sequence > stream.latestAvailableSequence
    ) {
      fail("E_PRIVATE_STATE");
    }
    prior = event.sequence;
  }
  if (
    nextSequence !== prior
    || (
      stream.events.length === 0
      && stream.latestAvailableSequence !== requestedSequence
    )
    || (
      stream.events.length > 0
      && prior !== stream.latestAvailableSequence
    )
  ) {
    fail("E_PRIVATE_STATE");
  }
  observer.observe(stream.events);
  return stream.nextCursor;
}

function hostTaskBindingFor(job) {
  return `host-task-${crypto
    .createHash("sha256")
    .update([job?.host?.kind, job?.host?.sessionId].join("\0"))
    .digest("hex")
    .slice(0, 32)}`;
}

function immutablePrivateBinding(job) {
  return {
    workerId: job?.id,
    createdAt: job?.createdAt,
    model: job?.model ?? null,
    effort: job?.effort ?? null,
    securityProfile: {
      id: job?.profile?.id,
      contractVersion: job?.profile?.contractVersion,
      agentProfileDigest: job?.profile?.agentProfileDigest
    },
    taskEnvelopeId: job?.request?.envelope?.envelopeId,
    taskEnvelopeDigest: job?.request?.envelope?.digest,
    contextManifestId: job?.request?.contextManifest?.manifestId,
    contextDigest: job?.request?.contextManifest?.digest,
    workspaceSnapshotDigest: job?.request?.contextManifest?.digest,
    controlWorkspaceId: job?.controlWorkspaceId,
    hostTaskBinding: hostTaskBindingFor(job),
    ownerThreadId: job?.request?.spawn?.ownerThreadId,
    requestDigest: job?.request?.spawn?.requestDigest,
    idempotencyKeyDigest: job?.request?.spawn?.idempotencyKeyDigest,
    providerCapabilityDigest: job?.request?.spawn?.providerCapabilityDigest
  };
}

function observeIdentity(tracker, kind, identity, processModule, workerId) {
  if (identity == null) return;
  try {
    processModule.assertCompleteDetachedOwnedIdentity(identity);
  } catch {
    fail("E_PRIVATE_STATE");
  }
  if (
    identity.commandMarker !== workerId
    || identity.processGroupId !== identity.pid
  ) {
    fail("E_PRIVATE_STATE");
  }
  if (kind === "provider") {
    if (identity.providerGeneration !== 1) fail("E_PRIVATE_STATE");
  }
  const existing = tracker.processIdentities.get(kind);
  if (existing && !sameJson(existing, identity)) fail("E_PRIVATE_STATE");
  if (!existing) tracker.processIdentities.set(kind, structuredClone(identity));
}

function canonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function observeProviderDispatchEvidence(tracker, job) {
  const spawn = job.request?.spawn;
  const dispatch = spawn?.dispatch;
  if (dispatch?.state !== "provider-started") return;
  const providerIntent = spawn?.providerSpawnIntent;
  if (
    dispatch.providerGeneration !== 1
    || dispatch.nextProviderGeneration !== null
    || !canonicalTimestamp(dispatch.providerStartedAt)
    || !canonicalTimestamp(dispatch.controllerStartedAt)
    || !canonicalTimestamp(dispatch.workerStartedAt)
    || Object.hasOwn(dispatch, "providerRotationCount")
    || Object.hasOwn(dispatch, "providerRotatedAt")
    || Object.hasOwn(dispatch, "providerRotationAuthorizedAt")
    || spawn.providerRotationIntent != null
    || providerIntent?.providerGeneration !== 1
    || providerIntent?.status !== "registered"
    || job.providerProcess?.providerGeneration !== 1
    || spawn.providerLaunchPending !== false
    || spawn.providerLaunchInFlight !== false
    || spawn.providerLaunchOutcome !== "launched"
  ) {
    fail("E_PRIVATE_STATE");
  }
  for (const identity of [
    job.controllerProcess,
    job.workerProcess,
    job.providerProcess
  ]) {
    if (
      identity?.dispatchAttemptId !== dispatch.attemptId
      || identity?.dispatchFence !== dispatch.fence
    ) {
      fail("E_PRIVATE_STATE");
    }
  }
  tracker.providerStartEvidence.add([
    dispatch.providerGeneration,
    dispatch.providerStartedAt,
    job.providerProcess.pid,
    job.providerProcess.startToken
  ].join(":"));
  if (tracker.providerStartEvidence.size !== 1) fail("E_PRIVATE_STATE");
}

function observePrivateJob(context, tracker, job, {
  requireLiveProvider = false,
  recordProviderObservation = false
} = {}) {
  if (!job || job.id !== tracker.workerId) fail("E_PRIVATE_STATE");
  try {
    context.mutation.assertDispatchContract(job);
    context.mutation.assertDurableSpawnRequestBinding(job, context.env);
  } catch {
    fail("E_PRIVATE_STATE");
  }
  let executionRoot;
  try {
    executionRoot = fs.realpathSync(context.fixtureRoot);
  } catch {
    fail("E_PRIVATE_STATE");
  }
  const expectedSpawnKeyDigest = tracker.spawnIdempotencyKey
    ? crypto.createHash("sha256").update(tracker.spawnIdempotencyKey).digest("hex")
    : null;
  if (
    job.host?.kind !== "codex"
    || job.host?.sessionId !== context.threadId
    || job.request?.spawn?.ownerThreadId !== context.threadId
    || job.request?.spawn?.executionRoot !== executionRoot
    || job.request?.spawn?.providerCapabilityDigest
      !== context.providerCapability.capabilityDigest
    || job.request?.roleId !== "explorer"
    || job.role?.id !== "explorer"
    || job.write !== false
    || (
      expectedSpawnKeyDigest !== null
      && job.request?.spawn?.idempotencyKeyDigest !== expectedSpawnKeyDigest
    )
  ) {
    fail("E_PRIVATE_STATE");
  }
  const binding = immutablePrivateBinding(job);
  if (
    !canonicalTimestamp(binding.createdAt)
    || !nullableBounded(binding.model, 256)
    || !nullableBounded(binding.effort, 128)
    || !hasExactKeys(
      binding.securityProfile,
      new Set(["id", "contractVersion", "agentProfileDigest"])
    )
    || binding.securityProfile.id !== "rescue-read-v3"
    || binding.securityProfile.contractVersion !== 3
    || !/^[0-9a-f]{64}$/.test(
      binding.securityProfile.agentProfileDigest || ""
    )
  ) {
    fail("E_PRIVATE_STATE");
  }
  if (tracker.privateBinding && !sameJson(tracker.privateBinding, binding)) {
    fail("E_PRIVATE_STATE");
  }
  tracker.privateBinding ||= structuredClone(binding);
  tracker.latestJob = job;
  observeIdentity(tracker, "controller", job.controllerProcess, context.processControl, job.id);
  observeIdentity(tracker, "worker", job.workerProcess, context.processControl, job.id);
  observeIdentity(tracker, "provider", job.providerProcess, context.processControl, job.id);
  observeProviderDispatchEvidence(tracker, job);
  if (job.grokSessionId != null) {
    if (!CANONICAL_UUID.test(job.grokSessionId)) fail("E_PRIVATE_STATE");
    if (tracker.sessionId && tracker.sessionId !== job.grokSessionId) {
      fail("E_PRIVATE_STATE");
    }
    tracker.sessionId = job.grokSessionId;
    context.runner.sessions.add(job.grokSessionId);
  }
  if (job.providerProcess) {
    const generation = job.providerProcess.providerGeneration;
    if (generation !== 1) fail("E_PRIVATE_STATE");
    tracker.providerGeneration = generation;
    if (recordProviderObservation) {
      tracker.observedProviderGenerations.push(generation);
      tracker.observedProviderWorkerIds.push(job.id);
    }
  }
  if (requireLiveProvider) {
    const requiredKinds = ["controller", "worker", "provider"];
    if (requiredKinds.some((kind) => !tracker.processIdentities.has(kind))) {
      fail("E_PRIVATE_STATE");
    }
    if (
      context.processControl.processGroupGone(tracker.processIdentities.get("worker"))
      || context.processControl.processGroupGone(tracker.processIdentities.get("provider"))
    ) {
      fail("E_PRIVATE_STATE");
    }
    let guard;
    try {
      guard = context.guard.loadProviderGuard(context.fixtureRoot, job.id);
      context.guard.assertProviderGuardForJob(
        context.fixtureRoot,
        job,
        guard,
        { expectedGeneration: 1 }
      );
    } catch {
      fail("E_PRIVATE_STATE");
    }
    if (
      !guard
      || !context.guard.sameGuardProcessIdentity(
        guard.providerProcess,
        job.providerProcess
      )
    ) {
      fail("E_PRIVATE_STATE");
    }
    tracker.authenticatedGuard = structuredClone(guard);
  }
  return job;
}

function readPrivateJob(context, tracker, options = {}) {
  let job;
  try {
    job = context.state.tryReadJob(
      context.fixtureRoot,
      tracker.workerId,
      context.env
    );
  } catch {
    fail("E_PRIVATE_STATE");
  }
  return observePrivateJob(context, tracker, job, options);
}

async function pollPrivateJob(context, tracker, predicate, {
  timeoutMs = 60_000,
  requireLiveProvider = false,
  recordProviderObservation = false
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    checkInterrupted(context.runner);
    let job = null;
    try {
      job = context.state.tryReadJob(
        context.fixtureRoot,
        tracker.workerId,
        context.env
      );
      if (job && predicate(job)) {
        return observePrivateJob(context, tracker, job, {
          requireLiveProvider,
          recordProviderObservation
        });
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, STATE_POLL_MS));
  }
  fail("E_PRIVATE_STATE");
}

function observePublicWorker(tracker, worker) {
  if (!worker || worker.id !== tracker.workerId) fail("E_SCENARIO");
  tracker.publicWorkers.push(structuredClone(worker));
  if (Array.isArray(worker.lifecycleEvents)) {
    tracker.events.observe(worker.lifecycleEvents);
  }
}

const SNAPSHOT_KEYS = new Set([
  "workerProtocolVersion",
  "snapshotSchemaVersion",
  "schemaVersion",
  "id",
  "kind",
  "jobClass",
  "write",
  "status",
  "phase",
  "summary",
  "progress",
  "createdAt",
  "startedAt",
  "updatedAt",
  "completedAt",
  "heartbeatAt",
  "profileId",
  "model",
  "effort",
  "parentWorkerId",
  "lineageWorkerId",
  "eventCursor",
  "taskEnvelopeId",
  "taskEnvelopeDigest",
  "contextManifestId",
  "contextDigest",
  "workspaceSnapshotDigest",
  "hostTaskBinding",
  "securityProfile",
  "latestPlan",
  "lifecycleEvents",
  "taskContract",
  "context",
  "resumeJobId",
  "result",
  "error",
  "controlWorkspaceId",
  "roleId",
  "externalWorkerLabel",
  "awaitingHostAction",
  "terminal"
]);
const HANDLE_KEYS = new Set([
  "workerProtocolVersion",
  "handleSchemaVersion",
  "id",
  "kind",
  "jobClass",
  "write",
  "status",
  "phase",
  "summary",
  "progress",
  "createdAt",
  "startedAt",
  "updatedAt",
  "completedAt",
  "heartbeatAt",
  "profileId",
  "model",
  "effort",
  "parentWorkerId",
  "lineageWorkerId",
  "eventCursor",
  "taskEnvelopeId",
  "taskEnvelopeDigest",
  "contextManifestId",
  "contextDigest",
  "workspaceSnapshotDigest",
  "hostTaskBinding",
  "securityProfile",
  "controlWorkspaceId",
  "roleId",
  "externalWorkerLabel",
  "terminal"
]);
const ACTIVE_REPLAY_PHASES = new Set([
  "starting",
  "creating-session",
  "prompting",
  "planning",
  "executing",
  "responding",
  "finalizing"
]);
const SPAWN_IDEMPOTENCY_RECORD_KEYS = new Set([
  "schemaVersion",
  "workerId",
  "owner",
  "controlWorkspaceId",
  "executionRoot",
  "requestDigest",
  "launchContractDigest",
  "idempotencyKeyDigest",
  "committedAt",
  "responseWitness"
]);
const SPAWN_RESPONSE_WITNESS_KEYS = new Set([
  "schemaVersion",
  "witnessId",
  "projection",
  "responseSequence",
  "workerId",
  "requestDigest",
  "idempotencyKeyDigest",
  "replayed",
  "handleDigest",
  "eventCursorSequence",
  "recordedAt"
]);
const SPAWN_RESPONSE_WITNESS_PROJECTION =
  "worker-handle-v1-untrusted-host";
const TASK_CONTRACT_KEYS = new Set([
  "schemaVersion",
  "envelopeId",
  "digest",
  "objective",
  "mode",
  "scope",
  "nonGoals",
  "acceptanceCriteria",
  "requiredVerification",
  "expectedReturnFormat",
  "context",
  "contextManifestId"
]);
const TASK_CONTEXT_KEYS = new Set([
  "facts",
  "constraints",
  "expectedProjectMarkers",
  "requiredPaths",
  "workspaceState",
  "upstreamFreshness"
]);
const CONTEXT_KEYS = new Set([
  "schemaVersion",
  "manifestId",
  "digest",
  "capturedAt",
  "branch",
  "head",
  "dirtyDigest",
  "dirtyEntryCount",
  "ignoredDigest",
  "ignoredEntryCount",
  "trackedTreeIdentity",
  "metadataIdentity",
  "insideWorktree",
  "linkedWorktree",
  "sparse",
  "shallow",
  "upstreamRef",
  "upstreamCommit",
  "upstreamFreshness",
  "projectMarkers",
  "materialization"
]);

function nullableBounded(value, maximum) {
  return value === null || boundedString(value, maximum);
}

function validatePublicLifecycleHistory(events, expectedWorkerId, eventCursor) {
  if (!Array.isArray(events) || events.length < 1 || events.length > 128) {
    fail("E_PRIVATE_STATE");
  }
  let prior = 0;
  for (const event of events) {
    validateLifecycleEvent(event);
    if (event.sequence !== prior + 1) fail("E_PRIVATE_STATE");
    prior = event.sequence;
  }
  if (validateCursor(eventCursor, expectedWorkerId) !== prior) {
    fail("E_PRIVATE_STATE");
  }
}

function validateTaskContractProjection(worker, job) {
  const contract = worker.taskContract;
  const envelope = job.request?.envelope;
  if (
    !hasExactKeys(contract, TASK_CONTRACT_KEYS)
    || !Number.isSafeInteger(contract.schemaVersion)
    || contract.schemaVersion < 1
    || contract.envelopeId !== envelope?.envelopeId
    || contract.digest !== envelope?.digest
    || contract.contextManifestId !== envelope?.contextManifestId
    || contract.objective !== job.request?.publicObjective
    || contract.mode !== "read"
    || !hasExactKeys(contract.scope, new Set(["include", "exclude"]))
    || !validStringList(contract.scope.include, { maximumItems: 64 })
    || !validStringList(contract.scope.exclude, { maximumItems: 64 })
    || !validStringList(contract.nonGoals, { maximumItems: 64 })
    || !validStringList(contract.requiredVerification, { maximumItems: 64 })
    || !nullableBounded(contract.expectedReturnFormat, 2000)
    || !Array.isArray(contract.acceptanceCriteria)
    || contract.acceptanceCriteria.length > 64
    || contract.acceptanceCriteria.some((criterion) => (
      !hasExactKeys(criterion, new Set(["id", "text"]))
      || !boundedString(criterion.id, 80, { nonempty: true })
      || !boundedString(criterion.text, 2000, { nonempty: true })
    ))
    || !hasExactKeys(contract.context, TASK_CONTEXT_KEYS)
    || !validStringList(contract.context.facts, { maximumItems: 64 })
    || !validStringList(contract.context.constraints, { maximumItems: 64 })
    || !validStringList(contract.context.expectedProjectMarkers, { maximumItems: 32 })
    || !validStringList(contract.context.requiredPaths, { maximumItems: 64 })
    || !new Set(["complete", "task_scoped", "unknown"])
      .has(contract.context.workspaceState)
    || contract.context.upstreamFreshness !== "not_checked"
  ) {
    fail("E_PRIVATE_STATE");
  }
}

function validateContextProjection(worker, job) {
  const context = worker.context;
  const manifest = job.request?.contextManifest;
  if (
    !hasExactKeys(context, CONTEXT_KEYS)
    || !Number.isSafeInteger(context.schemaVersion)
    || context.schemaVersion < 1
    || context.manifestId !== manifest?.manifestId
    || context.digest !== manifest?.digest
    || !canonicalTimestamp(context.capturedAt)
    || !nullableBounded(context.branch, 256)
    || !nullableBounded(context.head, 256)
    || !nullableBounded(context.dirtyDigest, 256)
    || !Number.isSafeInteger(context.dirtyEntryCount)
    || context.dirtyEntryCount < 0
    || !nullableBounded(context.ignoredDigest, 256)
    || !Number.isSafeInteger(context.ignoredEntryCount)
    || context.ignoredEntryCount < 0
    || !nullableBounded(context.trackedTreeIdentity, 256)
    || !nullableBounded(context.metadataIdentity, 256)
    || !nullableBounded(context.upstreamRef, 256)
    || !nullableBounded(context.upstreamCommit, 256)
    || ["insideWorktree", "linkedWorktree", "sparse", "shallow"]
      .some((key) => typeof context[key] !== "boolean")
    || context.upstreamFreshness !== "not_checked"
    || !validStringList(context.projectMarkers, { maximumItems: 32 })
    || !hasExactKeys(
      context.materialization,
      new Set(["state", "reasons", "submodules", "upstreamFreshness"])
    )
    || !new Set(["local_complete", "partial", "unknown"])
      .has(context.materialization.state)
    || !validStringList(context.materialization.reasons, { maximumItems: 64 })
    || !validStringList(context.materialization.submodules, { maximumItems: 100 })
    || context.materialization.upstreamFreshness !== "not_checked"
  ) {
    fail("E_PRIVATE_STATE");
  }
}

function validateIntermediateWorkerSnapshot(worker, tracker, job) {
  const binding = immutablePrivateBinding(job);
  if (
    !hasExactKeys(worker, SNAPSHOT_KEYS)
    || worker.workerProtocolVersion !== 1
    || worker.snapshotSchemaVersion !== 1
    || !Number.isSafeInteger(worker.schemaVersion)
    || worker.schemaVersion < 1
    || worker.id !== tracker.workerId
    || worker.id !== job.id
    || worker.kind !== "task"
    || worker.jobClass !== "task"
    || worker.write !== false
    || !new Set(["queued", "running"]).has(worker.status)
    || worker.terminal !== false
    || !boundedString(worker.phase, 128, { nonempty: true })
    || !nullableBounded(worker.summary, 2000)
    || !nullableBounded(worker.progress, 2000)
    || !canonicalTimestamp(worker.createdAt)
    || !canonicalTimestamp(worker.updatedAt)
    || !nullableBounded(worker.startedAt, 64)
    || (worker.startedAt !== null && !canonicalTimestamp(worker.startedAt))
    || worker.completedAt !== null
    || !nullableBounded(worker.heartbeatAt, 64)
    || (worker.heartbeatAt !== null && !canonicalTimestamp(worker.heartbeatAt))
    || worker.profileId !== "rescue-read-v3"
    || !nullableBounded(worker.model, 256)
    || !nullableBounded(worker.effort, 128)
    || worker.parentWorkerId !== null
    || worker.lineageWorkerId !== job.id
    || worker.taskEnvelopeId !== binding.taskEnvelopeId
    || worker.taskEnvelopeDigest !== binding.taskEnvelopeDigest
    || worker.contextManifestId !== binding.contextManifestId
    || worker.contextDigest !== binding.contextDigest
    || worker.workspaceSnapshotDigest !== binding.workspaceSnapshotDigest
    || worker.hostTaskBinding !== binding.hostTaskBinding
    || !hasExactKeys(
      worker.securityProfile,
      new Set(["id", "contractVersion", "agentProfileDigest"])
    )
    || worker.securityProfile.id !== job.profile?.id
    || worker.securityProfile.contractVersion !== job.profile?.contractVersion
    || worker.securityProfile.agentProfileDigest !== job.profile?.agentProfileDigest
    || !validStringList(worker.latestPlan, { maximumItems: 128 })
    || worker.resumeJobId !== null
    || worker.result !== null
    || worker.error !== null
    || worker.controlWorkspaceId !== binding.controlWorkspaceId
    || worker.roleId !== "explorer"
    || worker.externalWorkerLabel !== "external-grok-worker"
    || worker.awaitingHostAction !== null
  ) {
    fail("E_PRIVATE_STATE");
  }
  validatePublicLifecycleHistory(
    worker.lifecycleEvents,
    tracker.workerId,
    worker.eventCursor
  );
  validateTaskContractProjection(worker, job);
  validateContextProjection(worker, job);
}

const PUBLIC_RESULT_KEYS = new Set([
  "workerProtocolVersion",
  "resultSchemaVersion",
  "review",
  "workerReport",
  "reportRepair",
  "providerClaims",
  "runtimeEvidence",
  "verification",
  "textBytes",
  "textDigest",
  "textTruncated",
  "interim",
  "hostVerification",
  "stopReason",
  "cancellation",
  "skipped",
  "skipReason",
  "providerSessionDeleted",
  "taskRuntimeCleaned",
  "privacyWarning"
]);
const WORKER_REPORT_KEYS = new Set([
  "schemaVersion",
  "structured",
  "valid",
  "outcome",
  "summary",
  "changedFiles",
  "checksClaimed",
  "acceptanceResults",
  "risks",
  "questions",
  "validationIssues"
]);
const EXPECTED_REPORT_SUMMARY = "Installed Worker MCP fixture inspected.";
const EXPECTED_ACCEPTANCE_RESULTS = Object.freeze([
  Object.freeze({ id: "AC-01", status: "met" }),
  Object.freeze({ id: "AC-02", status: "met" })
]);

function validateExactCompletionReport(worker, job) {
  const report = worker.result?.workerReport;
  const providerClaims = worker.result?.providerClaims;
  const expectedReport = {
    schemaVersion: 1,
    structured: true,
    valid: true,
    outcome: "complete",
    summary: EXPECTED_REPORT_SUMMARY,
    changedFiles: [],
    checksClaimed: [],
    acceptanceResults: EXPECTED_ACCEPTANCE_RESULTS,
    risks: [],
    questions: [],
    validationIssues: []
  };
  const expectedClaims = {
    success: true,
    outcome: "complete",
    summary: EXPECTED_REPORT_SUMMARY,
    changedFiles: [],
    checksClaimed: [],
    observedFileAgreement: true
  };
  if (
    !hasExactKeys(report, WORKER_REPORT_KEYS)
    || !sameJson(report, expectedReport)
    || !sameJson(providerClaims, expectedClaims)
    || job.result?.workerReport?.schemaVersion !== 1
    || job.result?.workerReport?.structured !== true
    || job.result?.workerReport?.valid !== true
    || job.result?.workerReport?.outcome !== "complete"
    || job.result?.workerReport?.summary !== EXPECTED_REPORT_SUMMARY
    || !sameJson(job.result?.workerReport?.changedFiles, [])
    || !sameJson(job.result?.workerReport?.checksClaimed, [])
    || !sameJson(
      job.result?.workerReport?.acceptanceResults,
      EXPECTED_ACCEPTANCE_RESULTS
    )
    || !sameJson(job.result?.workerReport?.risks, [])
    || !sameJson(job.result?.workerReport?.questions, [])
    || !sameJson(job.result?.workerReport?.validationIssues, [])
    || job.result?.reportRepair != null
  ) {
    fail("E_PRIVATE_STATE");
  }
}

function validatePublicResultProjection(result, tracker, job, expectedStatus) {
  if (
    !isPlainRecord(result)
    || Object.keys(result).some((key) => !PUBLIC_RESULT_KEYS.has(key))
    || result.workerProtocolVersion !== 1
    || result.resultSchemaVersion !== 1
    || result.hostVerification !== "not_run"
    || result.taskRuntimeCleaned !== true
    || Object.hasOwn(result, "review")
    || Object.hasOwn(result, "runtimeEvidence")
    || Object.hasOwn(result, "verification")
    || Object.hasOwn(result, "providerSessionDeleted")
    || Object.hasOwn(result, "privacyWarning")
    || Object.hasOwn(result, "skipped")
    || Object.hasOwn(result, "skipReason")
  ) {
    fail("E_PRIVATE_STATE");
  }
  if (Object.hasOwn(result, "textDigest")) {
    if (
      !/^[0-9a-f]{64}$/.test(result.textDigest)
      || !Number.isSafeInteger(result.textBytes)
      || result.textBytes < 0
      || typeof result.textTruncated !== "boolean"
    ) {
      fail("E_PRIVATE_STATE");
    }
  } else if (
    Object.hasOwn(result, "textBytes")
    || Object.hasOwn(result, "textTruncated")
  ) {
    fail("E_PRIVATE_STATE");
  }
  if (Object.hasOwn(result, "interim")) {
    if (
      !hasExactKeys(result.interim, new Set(["bytes", "digest"]))
      || !Number.isSafeInteger(result.interim.bytes)
      || result.interim.bytes < 0
      || !/^[0-9a-f]{64}$/.test(result.interim.digest || "")
    ) {
      fail("E_PRIVATE_STATE");
    }
  }
  if (expectedStatus === "completed") {
    if (
      Object.hasOwn(result, "cancellation")
      || Object.hasOwn(result, "reportRepair")
      || result.stopReason === "cancelled"
    ) {
      fail("E_PRIVATE_STATE");
    }
    validateExactCompletionReport({ result }, job);
    return;
  }
  if (
    result.stopReason !== "cancelled"
    || Object.hasOwn(result, "workerReport")
    || Object.hasOwn(result, "providerClaims")
    || Object.hasOwn(result, "reportRepair")
    || !hasExactKeys(result.cancellation, new Set([
      "requestAcceptedAt",
      "processGroupGoneAt",
      "terminalRecordCommittedAt",
      "receiptId"
    ]))
    || !canonicalTimestamp(result.cancellation.requestAcceptedAt)
    || result.cancellation.processGroupGoneAt !== null
    || result.cancellation.terminalRecordCommittedAt !== null
    || result.cancellation.receiptId
      !== tracker.observedCancellationReceiptIds[0]
  ) {
    fail("E_PRIVATE_STATE");
  }
}

function validateTerminalWorkerSnapshot(worker, tracker, job, expectedStatus) {
  const binding = immutablePrivateBinding(job);
  const expectedPhase = expectedStatus === "completed" ? "done" : "cancelled";
  if (
    !hasExactKeys(worker, SNAPSHOT_KEYS)
    || worker.workerProtocolVersion !== 1
    || worker.snapshotSchemaVersion !== 1
    || !Number.isSafeInteger(worker.schemaVersion)
    || worker.schemaVersion < 1
    || worker.id !== tracker.workerId
    || worker.id !== job.id
    || worker.kind !== "task"
    || worker.jobClass !== "task"
    || worker.write !== false
    || worker.status !== expectedStatus
    || worker.phase !== expectedPhase
    || worker.terminal !== true
    || !canonicalTimestamp(worker.createdAt)
    || !canonicalTimestamp(worker.startedAt)
    || !canonicalTimestamp(worker.updatedAt)
    || !canonicalTimestamp(worker.completedAt)
    || Date.parse(worker.completedAt) < Date.parse(worker.startedAt)
    || !nullableBounded(worker.heartbeatAt, 64)
    || (worker.heartbeatAt !== null && !canonicalTimestamp(worker.heartbeatAt))
    || !nullableBounded(worker.summary, 2000)
    || !nullableBounded(worker.progress, 2000)
    || worker.profileId !== "rescue-read-v3"
    || !nullableBounded(worker.model, 256)
    || !nullableBounded(worker.effort, 128)
    || worker.parentWorkerId !== null
    || worker.lineageWorkerId !== job.id
    || worker.taskEnvelopeId !== binding.taskEnvelopeId
    || worker.taskEnvelopeDigest !== binding.taskEnvelopeDigest
    || worker.contextManifestId !== binding.contextManifestId
    || worker.contextDigest !== binding.contextDigest
    || worker.workspaceSnapshotDigest !== binding.workspaceSnapshotDigest
    || worker.hostTaskBinding !== binding.hostTaskBinding
    || !hasExactKeys(
      worker.securityProfile,
      new Set(["id", "contractVersion", "agentProfileDigest"])
    )
    || worker.securityProfile.id !== job.profile?.id
    || worker.securityProfile.contractVersion !== job.profile?.contractVersion
    || worker.securityProfile.agentProfileDigest !== job.profile?.agentProfileDigest
    || !validStringList(worker.latestPlan, { maximumItems: 128 })
    || worker.resumeJobId !== null
    || worker.controlWorkspaceId !== binding.controlWorkspaceId
    || worker.roleId !== "explorer"
    || worker.externalWorkerLabel !== "external-grok-worker"
    || worker.awaitingHostAction !== null
  ) {
    fail("E_PRIVATE_STATE");
  }
  validatePublicLifecycleHistory(
    worker.lifecycleEvents,
    tracker.workerId,
    worker.eventCursor
  );
  validateTaskContractProjection(worker, job);
  validateContextProjection(worker, job);
  validatePublicResultProjection(worker.result, tracker, job, expectedStatus);
  if (expectedStatus === "completed") {
    if (worker.error !== null) fail("E_PRIVATE_STATE");
  } else if (
    !hasExactKeys(worker.error, new Set([
      "workerProtocolVersion",
      "errorSchemaVersion",
      "code",
      "message"
    ]))
    || worker.error.workerProtocolVersion !== 1
    || worker.error.errorSchemaVersion !== 1
    || worker.error.code !== "E_CANCELLED"
    || !boundedString(worker.error.message, 2000, { nonempty: true })
  ) {
    fail("E_PRIVATE_STATE");
  }
}

function assertTerminalEventHistory(tracker, publicEvents, privateEvents) {
  if (
    !Array.isArray(publicEvents)
    || !Array.isArray(privateEvents)
    || !sameJson(tracker.events.values(), publicEvents)
    || publicEvents.length !== privateEvents.length
  ) {
    fail("E_PRIVATE_STATE");
  }
  for (let index = 0; index < publicEvents.length; index += 1) {
    const observed = publicEvents[index];
    const stored = privateEvents[index];
    if (
      observed.sequence !== stored?.sequence
      || observed.type !== stored?.type
      || observed.at !== stored?.at
      || observed.summary !== stored?.summary
      || (
        Object.hasOwn(observed, "detail")
        && Object.entries(observed.detail).some(
          ([key, value]) => !sameJson(value, stored?.detail?.[key])
        )
      )
    ) {
      fail("E_PRIVATE_STATE");
    }
  }
}

function assertPublicPrivateBinding(worker, job) {
  if (!worker || !job) fail("E_PRIVATE_STATE");
  const expected = {
    id: job.id,
    kind: job.kind,
    jobClass: job.jobClass,
    write: Boolean(job.write),
    createdAt: job.createdAt,
    model: job.model ?? null,
    effort: job.effort ?? null,
    profileId: job.profile?.id,
    securityProfile: {
      id: job.profile?.id,
      contractVersion: job.profile?.contractVersion,
      agentProfileDigest: job.profile?.agentProfileDigest
    },
    parentWorkerId: job.request?.resumeJobId || null,
    lineageWorkerId: job.request?.providerHomeId || job.id,
    taskEnvelopeId: job.request?.envelope?.envelopeId,
    taskEnvelopeDigest: job.request?.envelope?.digest,
    contextManifestId: job.request?.contextManifest?.manifestId,
    contextDigest: job.request?.contextManifest?.digest,
    workspaceSnapshotDigest: job.request?.contextManifest?.digest,
    hostTaskBinding: hostTaskBindingFor(job),
    controlWorkspaceId: job.controlWorkspaceId,
    roleId: job.role?.id,
    externalWorkerLabel: "external-grok-worker"
  };
  const observed = Object.fromEntries(
    Object.keys(expected).map((key) => [key, worker[key]])
  );
  if (!sameJson(observed, expected)) fail("E_PRIVATE_STATE");
}

function publicWorkerDigest(worker) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalJson(worker)))
    .digest("hex");
}

function validateActiveSpawnHandle(
  context,
  tracker,
  publicWorker,
  laterJob,
  { replayed }
) {
  let laterHandle;
  try {
    laterHandle = context.workerProtocol.projectWorkerHandle(laterJob, {
      trustHostAuthority: false
    });
  } catch {
    fail("E_PRIVATE_STATE");
  }
  assertPublicPrivateBinding(publicWorker, laterJob);
  if (
    !hasExactKeys(publicWorker, HANDLE_KEYS)
    || publicWorker.workerProtocolVersion !== 1
    || publicWorker.handleSchemaVersion !== 1
    || publicWorker.terminal !== false
    || publicWorker.completedAt !== null
    || !canonicalTimestamp(publicWorker.createdAt)
    || !canonicalTimestamp(publicWorker.updatedAt)
    || !canonicalTimestamp(publicWorker.heartbeatAt)
    || Date.parse(publicWorker.updatedAt) < Date.parse(publicWorker.createdAt)
    || Date.parse(publicWorker.heartbeatAt) < Date.parse(publicWorker.createdAt)
    || publicWorker.createdAt !== laterHandle.createdAt
    || Date.parse(publicWorker.updatedAt) > Date.parse(laterHandle.updatedAt)
    || Date.parse(publicWorker.heartbeatAt) > Date.parse(laterHandle.heartbeatAt)
    || publicWorker.eventCursor.sequence > laterHandle.eventCursor.sequence
  ) {
    fail("E_PRIVATE_STATE");
  }
  if (!replayed) {
    if (
      publicWorker.status !== "queued"
      || publicWorker.phase !== "accepted"
      || publicWorker.summary !== "Spawn committed"
      || publicWorker.progress
        !== "Durable job record committed; provider not started by broker spawn."
      || publicWorker.startedAt !== null
      || publicWorker.model !== null
      || publicWorker.effort !== null
      || publicWorker.eventCursor.sequence !== 1
      || publicWorker.createdAt !== publicWorker.updatedAt
      || publicWorker.createdAt !== publicWorker.heartbeatAt
      || tracker.initialSpawnHandle !== null
    ) {
      fail("E_PRIVATE_STATE");
    }
    tracker.initialSpawnHandle = structuredClone(publicWorker);
    return;
  }
  if (
    !tracker.initialSpawnHandle
    || publicWorker.status !== "running"
    || !ACTIVE_REPLAY_PHASES.has(publicWorker.phase)
    || !canonicalTimestamp(publicWorker.startedAt)
    || publicWorker.startedAt !== laterHandle.startedAt
    || publicWorker.eventCursor.sequence
      <= tracker.initialSpawnHandle.eventCursor.sequence
  ) {
    fail("E_PRIVATE_STATE");
  }
}

function validateSpawnResponseWitness(
  context,
  tracker,
  publicWorker,
  job,
  spawnKey,
  { replayed }
) {
  const keyDigest = crypto
    .createHash("sha256")
    .update(spawnKey)
    .digest("hex");
  let record;
  let expectedLaunchContractDigest;
  try {
    record = context.mutation.getSpawnIdempotencyRecord(
      context.fixtureRoot,
      spawnKey,
      context.env
    );
    expectedLaunchContractDigest =
      context.launchContract.launchContractDigest(job);
  } catch {
    fail("E_PRIVATE_STATE");
  }
  const witness = record?.responseWitness;
  const handleDigest = publicWorkerDigest(publicWorker);
  if (
    !hasExactKeys(record, SPAWN_IDEMPOTENCY_RECORD_KEYS)
    || record.schemaVersion !== 4
    || record.workerId !== job.id
    || !hasExactKeys(record.owner, new Set(["hostKind", "sessionId"]))
    || record.owner.hostKind !== job.host?.kind
    || record.owner.sessionId !== job.host?.sessionId
    || record.controlWorkspaceId !== job.controlWorkspaceId
    || record.executionRoot !== job.request?.spawn?.executionRoot
    || record.requestDigest !== job.request?.spawn?.requestDigest
    || record.launchContractDigest !== expectedLaunchContractDigest
    || record.idempotencyKeyDigest !== keyDigest
    || record.idempotencyKeyDigest
      !== job.request?.spawn?.idempotencyKeyDigest
    || record.committedAt !== job.createdAt
    || !hasExactKeys(witness, SPAWN_RESPONSE_WITNESS_KEYS)
    || witness.schemaVersion !== 1
    || !/^spawnw-[0-9a-f]{24}$/.test(witness.witnessId || "")
    || witness.projection !== SPAWN_RESPONSE_WITNESS_PROJECTION
    || witness.responseSequence !== (replayed ? 2 : 1)
    || witness.workerId !== job.id
    || witness.workerId !== publicWorker.id
    || witness.requestDigest !== record.requestDigest
    || witness.idempotencyKeyDigest !== keyDigest
    || witness.replayed !== replayed
    || witness.handleDigest !== handleDigest
    || witness.eventCursorSequence !== publicWorker.eventCursor.sequence
    || !canonicalTimestamp(witness.recordedAt)
    || Date.parse(witness.recordedAt) < Date.parse(publicWorker.updatedAt)
  ) {
    fail("E_PRIVATE_STATE");
  }
  const { witnessId: ignoredWitnessId, ...witnessBody } = witness;
  const expectedWitnessId = `spawnw-${crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalJson(witnessBody)))
    .digest("hex")
    .slice(0, 24)}`;
  if (witness.witnessId !== expectedWitnessId) fail("E_PRIVATE_STATE");
  const previous = tracker.observedSpawnResponseWitnesses.at(-1);
  if (
    previous
    && (
      witness.responseSequence !== previous.responseSequence + 1
      || witness.requestDigest !== previous.requestDigest
      || witness.idempotencyKeyDigest !== previous.idempotencyKeyDigest
      || witness.eventCursorSequence <= previous.eventCursorSequence
      || Date.parse(witness.recordedAt) < Date.parse(previous.recordedAt)
    )
  ) {
    fail("E_PRIVATE_STATE");
  }
  tracker.observedSpawnResponseWitnesses.push(structuredClone(witness));
  return handleDigest;
}

function recordPrivateIdentityObservation(
  context,
  tracker,
  job,
  publicWorker,
  {
    terminal = false,
    spawnKey = null,
    replayed = null
  } = {}
) {
  const values = [
    job?.id,
    job?.request?.envelope?.envelopeId,
    job?.request?.contextManifest?.manifestId
  ];
  if (values.some((value) => typeof value !== "string" || value === "")) {
    fail("E_PRIVATE_STATE");
  }
  tracker.observedWorkerIds.push(values[0]);
  tracker.observedTaskEnvelopeIds.push(values[1]);
  tracker.observedContextManifestIds.push(values[2]);
  let digest;
  if (terminal) {
    let expected;
    try {
      expected = context.workerProtocol.projectWorkerSnapshot(job, {
        detail: true,
        trustHostAuthority: false
      });
    } catch {
      fail("E_PRIVATE_STATE");
    }
    if (!sameJson(publicWorker, expected)) fail("E_PRIVATE_STATE");
    digest = publicWorkerDigest(publicWorker);
  } else {
    if (
      typeof spawnKey !== "string"
      || typeof replayed !== "boolean"
    ) {
      fail("E_PRIVATE_STATE");
    }
    validateActiveSpawnHandle(
      context,
      tracker,
      publicWorker,
      job,
      { replayed }
    );
    digest = validateSpawnResponseWitness(
      context,
      tracker,
      publicWorker,
      job,
      spawnKey,
      { replayed }
    );
  }
  if (!/^[0-9a-f]{64}$/.test(digest)) fail("E_PRIVATE_STATE");
  tracker.observedPublicWorkerDigests.push(digest);
}

function createTracker(scenarioId, fixtureStatus) {
  return {
    scenarioId,
    fixtureStatus,
    workerId: null,
    privateBinding: null,
    spawnIdempotencyKey: null,
    cancelIdempotencyKey: null,
    latestJob: null,
    sessionId: null,
    providerGeneration: null,
    providerStartEvidence: new Set(),
    authenticatedGuard: null,
    processIdentities: new Map(),
    observedWorkerIds: [],
    observedPublicWorkerDigests: [],
    observedSpawnResponseWitnesses: [],
    initialSpawnHandle: null,
    observedTaskEnvelopeIds: [],
    observedContextManifestIds: [],
    observedProviderGenerations: [],
    observedProviderWorkerIds: [],
    observedCancellationReceiptIds: [],
    publicWorkers: [],
    events: orderedEventObserver(),
    calls: {
      spawn: 0,
      spawnReplay: 0,
      result: 0,
      reconnect: 0,
      cancel: 0,
      cancelReplay: 0
    },
    sessionPresent: false,
    sessionDeleted: false,
    providerGuardAbsent: false
  };
}

async function waitForTerminal(context, client, tracker, cursor) {
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS;
  let currentCursor = cursor;
  while (Date.now() < deadline) {
    checkInterrupted(context.runner);
    const page = await callTool(
      context,
      client,
      "worker_wait",
      {
        id: tracker.workerId,
        ...(currentCursor ? { cursor: currentCursor } : {}),
        timeoutMs: 30_000
      },
      ["stream"]
    );
    currentCursor = observeStream(
      tracker.events,
      page.stream,
      tracker.workerId,
      { wait: true, cursor: currentCursor }
    );
    readPrivateJob(context, tracker);
    if (page.stream.terminal === true) return currentCursor;
  }
  fail("E_SCENARIO");
}

async function waitForSessionPresence(context, tracker) {
  const deadline = Date.now() + 60_000;
  while (Date.now() <= deadline) {
    checkInterrupted(context.runner);
    const observed = context.provider.inspectImportedSessionPresence(
      tracker.sessionId,
      context.providerBinary,
      context.env,
      context.fixtureRoot
    );
    if (observed?.ok === true && observed.present === true) {
      tracker.sessionPresent = true;
      return;
    }
    if (observed?.ok !== true) fail("E_SESSION");
    await new Promise((resolve) => setTimeout(resolve, STATE_POLL_MS));
  }
  fail("E_SESSION");
}

async function deleteAndProveSessionAbsent(context, tracker) {
  if (!tracker.sessionPresent || !CANONICAL_UUID.test(tracker.sessionId || "")) {
    fail("E_SESSION");
  }
  const deleted = context.provider.deleteSession(
    tracker.sessionId,
    context.providerBinary,
    context.env
  );
  if (deleted?.ok !== true) fail("E_SESSION");
  const deadline = Date.now() + 60_000;
  while (Date.now() <= deadline) {
    checkInterrupted(context.runner);
    const observed = context.provider.inspectImportedSessionPresence(
      tracker.sessionId,
      context.providerBinary,
      context.env,
      context.fixtureRoot
    );
    if (observed?.ok !== true) fail("E_SESSION");
    if (observed.present === false) {
      tracker.sessionDeleted = true;
      context.runner.sessions.delete(tracker.sessionId);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, STATE_POLL_MS));
  }
  fail("E_SESSION");
}

function proveTerminalCleanup(context, tracker, expectedStatus) {
  const job = readPrivateJob(context, tracker, {
    recordProviderObservation: tracker.observedProviderGenerations.length === 0
  });
  if (
    job.status !== expectedStatus
    || job.result?.hostVerification !== "not_run"
    || job.result?.taskRuntimeCleaned !== true
  ) {
    fail("E_CLEANUP");
  }
  if (tracker.processIdentities.size !== 3) fail("E_CLEANUP");
  const distinctIdentities = new Set(
    [...tracker.processIdentities.values()].map((identity) => (
      `${identity.pid}\0${identity.startToken}\0${identity.processGroupId}`
    ))
  );
  if (distinctIdentities.size !== 3) fail("E_CLEANUP");
  for (const identity of tracker.processIdentities.values()) {
    if (!context.processControl.processGroupGone(identity)) fail("E_CLEANUP");
  }
  let guard;
  try {
    guard = context.guard.loadProviderGuard(context.fixtureRoot, tracker.workerId);
  } catch {
    fail("E_CLEANUP");
  }
  if (guard !== null) fail("E_CLEANUP");
  tracker.providerGuardAbsent = true;
  const jobFile = context.state.jobFileIfPresent(
    context.fixtureRoot,
    tracker.workerId,
    context.env
  );
  if (!jobFile) fail("E_CLEANUP");
  const stateDirectory = path.dirname(path.dirname(jobFile));
  const homeMarker = job.request?.providerHomeId || job.id;
  const transient = [
    path.join(stateDirectory, "task-homes", homeMarker, ".grok", "auth.json"),
    path.join(stateDirectory, "task-homes", homeMarker, ".grok", "agent-profiles"),
    path.join(path.dirname(jobFile), `${job.id}.cancel`)
  ];
  if (transient.some((candidate) => fs.existsSync(candidate))) fail("E_CLEANUP");
  let stateNames;
  try {
    stateNames = fs.readdirSync(stateDirectory);
  } catch {
    fail("E_CLEANUP");
  }
  if (stateNames.some((name) => name.startsWith(`leader-${job.id}-`))) {
    fail("E_CLEANUP");
  }
  const afterFixtureStatus = runBounded("git", [
    "status", "--porcelain=v1", "-z", "--untracked-files=all"
  ], {
    cwd: context.fixtureRoot,
    env: context.env,
    requireSilentStderr: false,
    code: "E_CLEANUP"
  }).stdout;
  if (afterFixtureStatus !== tracker.fixtureStatus) fail("E_CLEANUP");
  return job;
}

function scenarioPrompt(label, { activeWindow = false } = {}) {
  const instructions = [
    `Inspect tracked.txt for the ${label} installed Worker MCP qualification.`,
    "Do not edit files and do not invoke another agent.",
    ...(activeWindow ? [
      "Before finishing, use the read-only tools to inspect every numbered file under qualification-workload in ascending order.",
      "Account for all 32 markers; do not return the final report before that bounded inspection is complete."
    ] : []),
    "Your first response must complete the task without a repair attempt.",
    "End that first response with this exact final line:",
    "GROK_WORKER_REPORT: {\"outcome\":\"complete\",\"summary\":\"Installed Worker MCP fixture inspected.\",\"changedFiles\":[],\"checksClaimed\":[],\"acceptanceResults\":[{\"id\":\"AC-01\",\"status\":\"met\"},{\"id\":\"AC-02\",\"status\":\"met\"}],\"risks\":[],\"questions\":[]}"
  ];
  return instructions.join(" ");
}

async function beginScenario(
  context,
  tracker,
  client,
  key,
  label,
  { activeWindow = false } = {}
) {
  const empty = await callTool(
    context,
    client,
    "worker_list_owned",
    {},
    ["workers"]
  );
  if (!Array.isArray(empty.workers) || empty.workers.length !== 0) {
    fail("E_SCENARIO");
  }
  const spawnArguments = Object.freeze({
    idempotencyKey: key,
    userRequest: scenarioPrompt(label, { activeWindow }),
    objective: `Complete the ${label} installed Worker MCP qualification.`,
    roleId: "explorer"
  });
  tracker.spawnIdempotencyKey = key;
  const spawn = await callTool(
    context,
    client,
    "worker_spawn",
    spawnArguments,
    [
      "worker",
      "replayed",
      "spawnSuccessDefinition",
      "providerLaunchState",
      "providerLaunched"
    ]
  );
  tracker.calls.spawn += 1;
  tracker.workerId = spawn.worker?.id;
  if (!tracker.workerId) fail("E_SCENARIO");
  observePublicWorker(tracker, spawn.worker);
  const spawnedJob = readPrivateJob(context, tracker);
  assertPublicPrivateBinding(spawn.worker, spawnedJob);
  recordPrivateIdentityObservation(
    context,
    tracker,
    spawnedJob,
    spawn.worker,
    { spawnKey: key, replayed: false }
  );

  const got = await callTool(
    context,
    client,
    "worker_get",
    { id: tracker.workerId },
    ["worker"]
  );
  if (got.worker.id !== tracker.workerId) fail("E_SCENARIO");
  const gotJob = readPrivateJob(context, tracker);
  validateIntermediateWorkerSnapshot(got.worker, tracker, gotJob);
  tracker.events.observe(got.worker.lifecycleEvents);
  assertPublicPrivateBinding(got.worker, gotJob);

  const events = await callTool(
    context,
    client,
    "worker_events_after",
    { id: tracker.workerId },
    ["stream"]
  );
  const cursor = observeStream(
    tracker.events,
    events.stream,
    tracker.workerId,
    { wait: false, cursor: null }
  );
  readPrivateJob(context, tracker);
  return { spawnArguments, spawn, cursor };
}

async function runCompletionScenario(baseContext, fixtureRoot) {
  const context = { ...baseContext, fixtureRoot };
  const fixtureStatus = initializeFixtureRepository(fixtureRoot, context.env);
  const tracker = createTracker("authenticated-completion", fixtureStatus);
  context.runner.trackers.push({ context, tracker });
  enterQualificationStage("completion-mcp-surface");
  let client = await startInstalledMcp(context);
  await verifyMcpSurface(context, client, { negative: true });
  enterQualificationStage("completion-spawn");
  const started = await beginScenario(
    context,
    tracker,
    client,
    `installed-completion-${crypto.randomUUID()}`,
    "authenticated completion"
  );
  enterQualificationStage("completion-wait");
  await waitForTerminal(context, client, tracker, started.cursor);
  enterQualificationStage("completion-result");
  const result = await callTool(
    context,
    client,
    "worker_result",
    { id: tracker.workerId },
    ["worker"]
  );
  tracker.calls.result += 1;
  if (!sameJson(tracker.events.values(), result.worker?.lifecycleEvents)) {
    fail("E_PRIVATE_STATE");
  }
  observePublicWorker(tracker, result.worker);
  await closeMcp(context, client);
  client = null;

  enterQualificationStage("completion-cleanup");
  const terminalJob = proveTerminalCleanup(context, tracker, "completed");
  validateTerminalWorkerSnapshot(
    result.worker,
    tracker,
    terminalJob,
    "completed"
  );
  assertTerminalEventHistory(
    tracker,
    result.worker.lifecycleEvents,
    terminalJob.lifecycleEvents
  );
  assertPublicPrivateBinding(result.worker, terminalJob);
  recordPrivateIdentityObservation(
    context,
    tracker,
    terminalJob,
    result.worker,
    { terminal: true }
  );
  if (
    terminalJob.result?.workerReport?.valid !== true
    || terminalJob.result?.workerReport?.outcome !== "complete"
    || terminalJob.result?.reportRepair != null
  ) {
    fail("E_SCENARIO");
  }
  enterQualificationStage("completion-session-cleanup");
  if (!tracker.sessionId) fail("E_SESSION");
  await waitForSessionPresence(context, tracker);
  await deleteAndProveSessionAbsent(context, tracker);

  const publicEvidence = {
    spawn: started.spawn,
    terminalResult: result
  };
  enterQualificationStage("completion-contract");
  validateInstalledCompletionScenario(publicEvidence);
  return { context, tracker, publicEvidence };
}

async function runCancellationScenario(baseContext, fixtureRoot) {
  const context = { ...baseContext, fixtureRoot };
  const fixtureStatus = initializeFixtureRepository(
    fixtureRoot,
    context.env,
    { workloadFiles: 32 }
  );
  const tracker = createTracker("mcp-restart-reconnect-cancellation", fixtureStatus);
  context.runner.trackers.push({ context, tracker });
  enterQualificationStage("cancellation-mcp-surface");
  let client = await startInstalledMcp(context);
  await verifyMcpSurface(context, client);
  enterQualificationStage("cancellation-spawn");
  const started = await beginScenario(
    context,
    tracker,
    client,
    `installed-cancel-spawn-${crypto.randomUUID()}`,
    "restart and cancellation",
    { activeWindow: true }
  );
  enterQualificationStage("cancellation-live-provider");
  await pollPrivateJob(
    context,
    tracker,
    (job) => (
      CANONICAL_UUID.test(job?.grokSessionId || "")
      && job?.providerProcess?.providerGeneration === 1
      && job?.controllerProcess?.pid > 0
      && job?.workerProcess?.pid > 0
    ),
    {
      timeoutMs: 120_000,
      requireLiveProvider: true,
      recordProviderObservation: true
    }
  );
  await waitForSessionPresence(context, tracker);

  enterQualificationStage("cancellation-reconnect");
  await closeMcp(context, client);
  tracker.calls.reconnect += 1;
  client = await startInstalledMcp(context);
  await verifyMcpSurface(context, client);
  enterQualificationStage("cancellation-replay");
  const replay = await callTool(
    context,
    client,
    "worker_spawn",
    started.spawnArguments,
    [
      "worker",
      "replayed",
      "spawnSuccessDefinition",
      "providerLaunchState",
      "providerLaunched"
    ]
  );
  tracker.calls.spawnReplay += 1;
  observePublicWorker(tracker, replay.worker);
  const replayJob = readPrivateJob(context, tracker, {
    requireLiveProvider: true,
    recordProviderObservation: true
  });
  assertPublicPrivateBinding(replay.worker, replayJob);
  recordPrivateIdentityObservation(
    context,
    tracker,
    replayJob,
    replay.worker,
    {
      spawnKey: tracker.spawnIdempotencyKey,
      replayed: true
    }
  );
  if (
    replay.worker.id !== tracker.workerId
    || replayJob.request?.spawn?.dispatch?.providerGeneration !== 1
  ) {
    fail("E_SCENARIO");
  }

  enterQualificationStage("cancellation-request");
  const cancelKey = `installed-cancel-request-${crypto.randomUUID()}`;
  tracker.cancelIdempotencyKey = cancelKey;
  const cancel = await callTool(
    context,
    client,
    "worker_cancel",
    { id: tracker.workerId, idempotencyKey: cancelKey },
    ["receipt", "replayed"]
  );
  tracker.calls.cancel += 1;
  tracker.observedCancellationReceiptIds.push(cancel.receipt?.receiptId);
  const cancelReplay = await callTool(
    context,
    client,
    "worker_cancel",
    { id: tracker.workerId, idempotencyKey: cancelKey },
    ["receipt", "replayed"]
  );
  tracker.calls.cancelReplay += 1;
  tracker.observedCancellationReceiptIds.push(cancelReplay.receipt?.receiptId);
  if (
    !sameJson(cancel.receipt, cancelReplay.receipt)
    || cancel.replayed !== false
    || cancelReplay.replayed !== true
    || cancel.receipt?.idempotencyKeyDigest
      !== crypto.createHash("sha256").update(cancelKey).digest("hex")
  ) {
    fail("E_SCENARIO");
  }

  enterQualificationStage("cancellation-wait");
  await waitForTerminal(context, client, tracker, started.cursor);
  enterQualificationStage("cancellation-result");
  const result = await callTool(
    context,
    client,
    "worker_result",
    { id: tracker.workerId },
    ["worker"]
  );
  tracker.calls.result += 1;
  if (!sameJson(tracker.events.values(), result.worker?.lifecycleEvents)) {
    fail("E_PRIVATE_STATE");
  }
  observePublicWorker(tracker, result.worker);
  await closeMcp(context, client);
  client = null;

  enterQualificationStage("cancellation-cleanup");
  const terminalJob = proveTerminalCleanup(context, tracker, "cancelled");
  validateTerminalWorkerSnapshot(
    result.worker,
    tracker,
    terminalJob,
    "cancelled"
  );
  assertTerminalEventHistory(
    tracker,
    result.worker.lifecycleEvents,
    terminalJob.lifecycleEvents
  );
  assertPublicPrivateBinding(result.worker, terminalJob);
  recordPrivateIdentityObservation(
    context,
    tracker,
    terminalJob,
    result.worker,
    { terminal: true }
  );
  const cancellationEvents = (terminalJob.lifecycleEvents || [])
    .filter((event) => event?.type === "cancellation.requested");
  if (
    terminalJob.result?.stopReason !== "cancelled"
    || cancellationEvents.length !== 1
    || terminalJob.request?.spawn?.dispatch?.providerGeneration !== 1
  ) {
    fail("E_SCENARIO");
  }
  enterQualificationStage("cancellation-session-cleanup");
  await deleteAndProveSessionAbsent(context, tracker);

  const publicEvidence = {
    spawn: started.spawn,
    spawnReplay: replay,
    cancel,
    cancelReplay,
    terminalResult: result
  };
  enterQualificationStage("cancellation-contract");
  validateInstalledCancellationReplayScenario(publicEvidence);
  return { context, tracker, publicEvidence };
}

function privateObservationFor(tracker, temporaryRemoved) {
  const generationCount = tracker.scenarioId === "authenticated-completion" ? 1 : 2;
  const evidenceCount = tracker.scenarioId === "authenticated-completion" ? 2 : 3;
  const witnessCount = tracker.scenarioId === "authenticated-completion" ? 1 : 2;
  if (
    tracker.observedProviderGenerations.length < generationCount
    || tracker.observedProviderWorkerIds.length
      !== tracker.observedProviderGenerations.length
    || tracker.observedPublicWorkerDigests.length !== evidenceCount
    || tracker.observedPublicWorkerDigests.some(
      (digest) => !/^[0-9a-f]{64}$/.test(digest)
    )
    || tracker.observedSpawnResponseWitnesses.length !== witnessCount
  ) {
    fail("E_PRIVATE_STATE");
  }
  const providerIdentity = tracker.processIdentities.get("provider");
  const providerLaunchCount = tracker.providerStartEvidence.size;
  const providerTerminalCount = providerIdentity
    && tracker.context.processControl.processGroupGone(providerIdentity) ? 1 : 0;
  return {
    scenarioId: tracker.scenarioId,
    observedPublicWorkerDigests: [
      ...tracker.observedPublicWorkerDigests
    ],
    observedSpawnResponseWitnesses: tracker.observedSpawnResponseWitnesses
      .map((witness) => structuredClone(witness)),
    installedWorkerBinding: {
      workerId: tracker.privateBinding?.workerId,
      createdAt: tracker.privateBinding?.createdAt,
      model: tracker.privateBinding?.model,
      effort: tracker.privateBinding?.effort,
      securityProfile: structuredClone(
        tracker.privateBinding?.securityProfile
      ),
      taskEnvelopeId: tracker.privateBinding?.taskEnvelopeId,
      taskEnvelopeDigest: tracker.privateBinding?.taskEnvelopeDigest,
      contextManifestId: tracker.privateBinding?.contextManifestId,
      contextDigest: tracker.privateBinding?.contextDigest,
      workspaceSnapshotDigest: tracker.privateBinding?.workspaceSnapshotDigest,
      controlWorkspaceId: tracker.privateBinding?.controlWorkspaceId,
      hostTaskBinding: tracker.privateBinding?.hostTaskBinding
    },
    observedWorkerIds: [...tracker.observedWorkerIds],
    observedTaskEnvelopeIds: [...tracker.observedTaskEnvelopeIds],
    observedContextManifestIds: [...tracker.observedContextManifestIds],
    observedProviderGenerations: [...tracker.observedProviderGenerations],
    observedProviderWorkerIds: [...tracker.observedProviderWorkerIds],
    observedCancellationReceiptIds: [...tracker.observedCancellationReceiptIds],
    spawnInvocationCount: tracker.calls.spawn + tracker.calls.spawnReplay,
    spawnReplayCount: tracker.calls.spawnReplay,
    providerLaunchCount,
    providerTerminalCount,
    workerTerminalCount: tracker.latestJob
      && ["completed", "cancelled"].includes(tracker.latestJob.status) ? 1 : 0,
    resultReadCount: tracker.calls.result,
    reconnectCount: tracker.calls.reconnect,
    cancelInvocationCount: tracker.calls.cancel + tracker.calls.cancelReplay,
    cancelReplayCount: tracker.calls.cancelReplay,
    uniqueCancelRequestCount: tracker.calls.cancel > 0 ? 1 : 0,
    cancellationEventCount: (tracker.latestJob?.lifecycleEvents || [])
      .filter((event) => event?.type === "cancellation.requested").length,
    duplicateLaunchCount: Math.max(0, providerLaunchCount - 1),
    workerHostVerification: "not_run",
    processGroupGone: Boolean(tracker.context)
      && [...tracker.processIdentities.values()]
        .every((identity) => tracker.context.processControl.processGroupGone(identity)),
    taskRuntimeCleaned: tracker.latestJob?.result?.taskRuntimeCleaned === true,
    providerGuardAbsent: tracker.providerGuardAbsent,
    runnerTemporaryArtifactsRemoved: temporaryRemoved,
    qualificationSessionDeleted: tracker.sessionDeleted
  };
}

async function terminateTrackedClients(runner) {
  let ok = true;
  for (const client of [...runner.clients]) {
    try {
      await client.terminate();
    } catch {
      ok = false;
    } finally {
      runner.clients.delete(client);
    }
  }
  return ok;
}

async function emergencyCleanup(runner) {
  let clean = await terminateTrackedClients(runner);
  if (
    runner.setupBoundary
    && !await cleanupSetupBoundary(
      runner.setupBoundary,
      { terminate: true, requireObservation: false }
    )
  ) {
    clean = false;
  }
  if (runner.temporaryRemoved === true) {
    return clean && runner.sessions.size === 0;
  }
  for (const entry of [...runner.trackers].reverse()) {
    const { context, tracker } = entry;
    let latest = null;
    if (typeof tracker.workerId !== "string") {
      try {
        const candidates = context.state.listJobsReadonly(
          context.fixtureRoot,
          context.env
        ).filter((job) => (
          job?.host?.kind === "codex"
          && job?.host?.sessionId === context.threadId
        ));
        if (candidates.length === 1) tracker.workerId = candidates[0].id;
        else if (candidates.length > 1) clean = false;
      } catch {
        clean = false;
      }
    }
    if (typeof tracker.workerId !== "string") continue;

    const owned = new Map();
    for (const [kind, identity] of tracker.processIdentities) {
      owned.set(`${kind}:${identity.pid}:${identity.startToken}`, {
        kind,
        identity: structuredClone(identity)
      });
    }
    const collectLatest = () => {
      try {
        latest = context.state.tryReadJob(
          context.fixtureRoot,
          tracker.workerId,
          context.env
        );
      } catch {
        clean = false;
        return;
      }
      if (!latest) return;
      if (latest.grokSessionId != null) {
        if (CANONICAL_UUID.test(latest.grokSessionId)) {
          runner.sessions.add(latest.grokSessionId);
        } else {
          clean = false;
        }
      }
      for (const [kind, field] of [
        ["controller", "controllerProcess"],
        ["worker", "workerProcess"],
        ["provider", "providerProcess"]
      ]) {
        const identity = latest[field];
        if (!identity) continue;
        try {
          context.processControl.assertCompleteDetachedOwnedIdentity(identity);
          if (identity.commandMarker !== tracker.workerId) {
            clean = false;
            continue;
          }
          owned.set(`${kind}:${identity.pid}:${identity.startToken}`, {
            kind,
            identity: structuredClone(identity)
          });
        } catch {
          clean = false;
        }
      }
    };
    const discoverDetachedWorkerProcesses = () => {
      let listed;
      try {
        listed = context.processControl.runSystemPs([
          "-axo",
          "pid=,command="
        ]);
      } catch {
        clean = false;
        return;
      }
      if (
        listed?.status !== 0
        || listed?.signal
        || listed?.error
        || Buffer.byteLength(String(listed.stdout || ""), "utf8")
          > MAX_COMMAND_OUTPUT_BYTES
      ) {
        clean = false;
        return;
      }
      for (const line of String(listed.stdout || "").split("\n")) {
        const match = line.match(/^\s*(\d+)\s+([\s\S]+)$/);
        if (!match || !match[2].includes(tracker.workerId)) continue;
        const pid = Number(match[1]);
        const startToken = context.processControl.processStartToken(pid);
        if (!startToken) continue;
        const identity = { pid, startToken, processGroupId: pid };
        let kind = null;
        try {
          context.processControl.assertCompleteDetachedOwnedIdentity(identity);
          if (
            context.processControl.identityMatches(
              identity,
              tracker.workerId,
              "controller"
            )
          ) {
            kind = "controller";
          } else if (
            context.processControl.identityMatches(
              identity,
              tracker.workerId,
              "worker"
            )
          ) {
            kind = "worker";
          } else if (
            context.processControl.identityMatches(
              identity,
              tracker.workerId,
              "provider-bootstrap"
            )
          ) {
            kind = "provider-bootstrap";
          } else if (
            context.processControl.identityMatches(
              identity,
              tracker.workerId,
              "provider"
            )
          ) {
            kind = "provider";
          }
        } catch {
          clean = false;
          continue;
        }
        if (!kind) continue;
        owned.set(`${kind}:${identity.pid}:${identity.startToken}`, {
          kind,
          identity
        });
      }
    };
    const collectAuthenticatedGuard = () => {
      let record;
      try {
        record = context.guard.loadProviderGuard(
          context.fixtureRoot,
          tracker.workerId
        );
      } catch {
        clean = false;
        return null;
      }
      if (!record) return null;
      if (!latest) {
        clean = false;
        return null;
      }
      let authenticated;
      try {
        authenticated = context.guard.assertProviderGuardForJob(
          context.fixtureRoot,
          latest,
          record,
          { expectedGeneration: record.providerGeneration }
        );
        context.processControl.assertCompleteDetachedOwnedIdentity(
          authenticated.providerProcess
        );
      } catch {
        clean = false;
        return null;
      }
      if (
        tracker.authenticatedGuard
        && !sameJson(tracker.authenticatedGuard, authenticated)
      ) {
        clean = false;
        return null;
      }
      const identity = structuredClone(authenticated.providerProcess);
      owned.set(`provider:${identity.pid}:${identity.startToken}`, {
        kind: "provider",
        identity
      });
      return authenticated;
    };
    const terminateCollected = async () => {
      for (const markerKind of [
        "controller",
        "worker",
        "provider-bootstrap",
        "provider"
      ]) {
        for (const ownedProcess of owned.values()) {
          if (ownedProcess.kind !== markerKind) continue;
          const { identity } = ownedProcess;
          try {
            if (!context.processControl.processGroupGone(identity)) {
              await context.processControl.terminateOwnedProcess(
                identity,
                tracker.workerId,
                markerKind
              );
            }
            if (!context.processControl.processGroupGone(identity)) clean = false;
          } catch {
            clean = false;
          }
        }
      }
    };
    let stableClosureScans = 0;
    let previousClosureSignature = null;
    for (let pass = 0; pass < 20; pass += 1) {
      collectLatest();
      discoverDetachedWorkerProcesses();
      collectAuthenticatedGuard();
      await terminateCollected();
      collectLatest();
      discoverDetachedWorkerProcesses();
      let authenticated = collectAuthenticatedGuard();
      await terminateCollected();

      const producerGroupsGone = [...owned.values()]
        .filter(({ kind }) => kind === "controller" || kind === "worker")
        .every(({ identity }) => (
          context.processControl.processGroupGone(identity)
        ));
      const allGroupsGone = [...owned.values()].every(({ identity }) => (
        context.processControl.processGroupGone(identity)
      ));
      if (authenticated && producerGroupsGone && allGroupsGone) {
        try {
          const current = context.guard.loadProviderGuard(
            context.fixtureRoot,
            tracker.workerId
          );
          if (!current || !sameJson(current, authenticated)) {
            clean = false;
          } else {
            context.guard.unregisterProviderGuard(
              context.fixtureRoot,
              tracker.workerId,
              authenticated,
              context.env
            );
            authenticated = null;
          }
        } catch {
          clean = false;
        }
      }
      let residualGuard = null;
      try {
        residualGuard = context.guard.loadProviderGuard(
          context.fixtureRoot,
          tracker.workerId
        );
      } catch {
        clean = false;
      }
      const closureSignature = JSON.stringify(canonicalJson({
        jobProcesses: {
          controller: latest?.controllerProcess || null,
          worker: latest?.workerProcess || null,
          provider: latest?.providerProcess || null
        },
        sessionId: latest?.grokSessionId || null,
        residualGuard,
        owned: [...owned.values()]
          .map(({ kind, identity }) => ({ kind, identity }))
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      }));
      if (producerGroupsGone && allGroupsGone && residualGuard === null) {
        stableClosureScans = closureSignature === previousClosureSignature
          ? stableClosureScans + 1
          : 1;
      } else {
        stableClosureScans = 0;
      }
      previousClosureSignature = closureSignature;
      if (stableClosureScans >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, STATE_POLL_MS));
    }
    if (
      stableClosureScans < 2
      || [...owned.values()].some(
        ({ identity }) => !context.processControl.processGroupGone(identity)
      )
    ) {
      clean = false;
    }
  }
  if (runner.provider && runner.providerBinary) {
    for (const sessionId of [...runner.sessions]) {
      try {
        let observed = runner.provider.inspectImportedSessionPresence(
          sessionId,
          runner.providerBinary,
          runner.baseEnvironment,
          ROOT
        );
        if (observed?.ok !== true) {
          clean = false;
          continue;
        }
        if (observed.present === true) {
          const deletion = runner.provider.deleteSession(
            sessionId,
            runner.providerBinary,
            runner.baseEnvironment
          );
          if (deletion?.ok !== true) {
            clean = false;
            continue;
          }
        }
        const deadline = Date.now() + 30_000;
        while (observed.present !== false && Date.now() <= deadline) {
          await new Promise((resolve) => setTimeout(resolve, STATE_POLL_MS));
          observed = runner.provider.inspectImportedSessionPresence(
            sessionId,
            runner.providerBinary,
            runner.baseEnvironment,
            ROOT
          );
          if (observed?.ok !== true) {
            clean = false;
            break;
          }
        }
        if (observed?.ok === true && observed.present === false) {
          runner.sessions.delete(sessionId);
        } else {
          clean = false;
        }
      } catch {
        clean = false;
      }
    }
  } else if (runner.sessions.size > 0) {
    clean = false;
  }
  if (runner.temporaryRoot && fs.existsSync(runner.temporaryRoot)) {
    if (clean) {
      try {
        fs.rmSync(runner.temporaryRoot, { recursive: true, force: true });
      } catch {
        clean = false;
      }
    }
  }
  return clean && (!runner.temporaryRoot || !fs.existsSync(runner.temporaryRoot));
}

function ensurePublicationDirectory(relativeDirectory, created) {
  const root = canonicalPath(ROOT, "Repository root");
  let current = root;
  for (const segment of relativeDirectory.split("/")) {
    if (
      !segment
      || segment === "."
      || segment === ".."
      || segment.includes("\\")
      || segment.includes("\0")
    ) {
      fail("E_RECEIPT");
    }
    const next = path.join(current, segment);
    try {
      fs.mkdirSync(next, { mode: 0o755 });
      created.push(next);
      fsyncDirectory(current);
      fsyncDirectory(next);
    } catch (error) {
      if (error?.code !== "EEXIST") fail("E_RECEIPT");
    }
    const stat = fs.lstatSync(next);
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || !isPathInside(root, fs.realpathSync(next))
    ) {
      fail("E_RECEIPT");
    }
    current = fs.realpathSync(next);
  }
  return current;
}

function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function publishReceipt(receipt) {
  const validation = validateLiveQualificationReceipt(receipt, {
    strict: true,
    root: ROOT
  });
  if (!validation.ok) fail("E_RECEIPT");
  const relativeDirectory = [
    LIVE_RECEIPT_ROOT,
    LIVE_RECEIPT_AUTHORITY_SYNTHETIC
  ].join("/");
  const fileName = [
    receipt.sourceInventoryDigest.slice(0, 16),
    receipt.receiptDigest.slice(0, 16)
  ].join("-") + ".json";
  const created = [];
  let publishedFile = null;
  let descriptor;
  let fileCreated = false;
  let publishedIdentity = null;
  try {
    const directory = ensurePublicationDirectory(relativeDirectory, created);
    publishedFile = path.join(directory, fileName);
    if (!isPathInside(ROOT, publishedFile)) fail("E_RECEIPT");
    descriptor = fs.openSync(
      publishedFile,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600
    );
    fileCreated = true;
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) fail("E_RECEIPT");
    publishedIdentity = { dev: opened.dev, ino: opened.ino };
    const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
    const buffer = Buffer.from(serialized, "utf8");
    if (buffer.length > MAX_RECEIPT_BYTES) fail("E_RECEIPT");
    let offset = 0;
    while (offset < buffer.length) {
      const written = fs.writeSync(
        descriptor,
        buffer,
        offset,
        buffer.length - offset
      );
      if (!Number.isSafeInteger(written) || written <= 0) fail("E_RECEIPT");
      offset += written;
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fsyncDirectory(directory);

    descriptor = fs.openSync(
      publishedFile,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const reopened = fs.fstatSync(descriptor);
    const stat = fs.lstatSync(publishedFile);
    if (
      !reopened.isFile()
      || reopened.dev !== publishedIdentity.dev
      || reopened.ino !== publishedIdentity.ino
      || !stat.isFile()
      || stat.isSymbolicLink()
      || stat.size !== buffer.length
      || stat.dev !== publishedIdentity.dev
      || stat.ino !== publishedIdentity.ino
      || !isPathInside(ROOT, fs.realpathSync(publishedFile))
    ) {
      fail("E_RECEIPT");
    }
    const reread = fs.readFileSync(descriptor, "utf8");
    fs.closeSync(descriptor);
    descriptor = null;
    if (reread !== serialized) fail("E_RECEIPT");
    const parsed = safeParseJson(reread, "E_RECEIPT");
    if (!sameJson(parsed, receipt)) fail("E_RECEIPT");
    const post = validateLiveQualificationReceipt(parsed, {
      strict: true,
      root: ROOT
    });
    if (!post.ok || parsed.receiptDigest !== receipt.receiptDigest) {
      fail("E_RECEIPT");
    }
    const finalStat = fs.lstatSync(publishedFile);
    if (
      !finalStat.isFile()
      || finalStat.isSymbolicLink()
      || finalStat.dev !== publishedIdentity.dev
      || finalStat.ino !== publishedIdentity.ino
    ) {
      fail("E_RECEIPT");
    }
  } catch (error) {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (publishedFile && fileCreated) {
      try {
        const current = fs.lstatSync(publishedFile);
        if (
          current.isFile()
          && !current.isSymbolicLink()
          && current.dev === publishedIdentity?.dev
          && current.ino === publishedIdentity?.ino
        ) {
          fs.unlinkSync(publishedFile);
          fsyncDirectory(path.dirname(publishedFile));
        }
      } catch {}
    }
    for (const directory of created.reverse()) {
      try {
        fs.rmdirSync(directory);
        fsyncDirectory(path.dirname(directory));
      } catch {}
    }
    if (error instanceof QualificationError) throw error;
    fail("E_RECEIPT");
  }
}

function buildReceipt({
  startedAt,
  endedAt,
  sourceIdentity,
  sourceDigest,
  phaseScopeDigest,
  pluginVersion,
  sourcePluginDigest,
  installedPluginDigest,
  installedFileCount,
  installedEntrypointDigest,
  providerCapabilityDigest,
  providerBinaryDigest,
  providerVersion
}) {
  const config = LIVE_RECEIPT_AUTHORITY_CONFIG[LIVE_RECEIPT_AUTHORITY_SYNTHETIC];
  const receipt = {
    schemaVersion: LIVE_RECEIPT_SCHEMA_VERSION,
    producerId: LIVE_RECEIPT_PRODUCER_ID,
    producerVersion: LIVE_RECEIPT_PRODUCER_VERSION,
    manifestDigest: computeLiveReceiptManifestDigest(),
    authorityMode: LIVE_RECEIPT_AUTHORITY_SYNTHETIC,
    phase: config.phase,
    pluginVersion,
    headCommit: sourceIdentity.headCommit,
    headTree: sourceIdentity.headTree,
    sourceInventoryDigest: sourceDigest,
    phaseScopeDigest,
    repositoryBeforeDigest: sourceDigest,
    repositoryAfterDigest: sourceDigest,
    sourcePluginInventoryDigest: sourcePluginDigest,
    installedPluginInventoryDigest: installedPluginDigest,
    installedFileCount,
    installedEntrypointDigest,
    providerCapabilityDigest,
    observedToolIds: [...LIVE_RECEIPT_CAPABILITY_TOOL_IDS],
    providerBinaryDigest,
    providerVersion,
    providerRevision: `binary-sha256-${providerBinaryDigest}`,
    mcpProtocolVersion: LIVE_RECEIPT_MANIFEST.mcpProtocolVersion,
    codexBinaryDigest: null,
    codexVersion: null,
    codexModel: null,
    hostTaskDigest: null,
    installationMethod: "codex-local-plugin-cache",
    scenarios: config.scenarios.map((scenario) => ({ ...scenario })),
    outcome: "pass",
    startedAt,
    endedAt
  };
  receipt.receiptDigest = computeLiveQualificationReceiptDigest(receipt);
  return receipt;
}

async function qualify(runner) {
  enterQualificationStage("source-boundary");
  const startedAt = new Date().toISOString();
  if (!isNonEvidenceTreeClean(ROOT)) fail("E_SOURCE");
  const sourceIdentity = gitIdentity(ROOT);
  if (sourceIdentity.cleanTreeAtVerification !== true) fail("E_SOURCE");
  const sourceDigest = computeInventoryDigest(ROOT, { includeEvidence: false });
  const phaseScopeDigest = computePhaseScopeDigest("1", ROOT);
  const sourceEntries = createPluginInventory(SOURCE_PLUGIN);
  const sourcePluginDigest = digestInventory(sourceEntries);
  const packageJson = safeParseJson(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
    "E_SOURCE"
  );
  const pluginManifest = safeParseJson(
    fs.readFileSync(path.join(SOURCE_PLUGIN, ".codex-plugin", "plugin.json"), "utf8"),
    "E_SOURCE"
  );
  if (
    typeof packageJson.version !== "string"
    || packageJson.version !== pluginManifest.version
  ) {
    fail("E_SOURCE");
  }

  runner.temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "grok-installed-worker-mcp-")
  );
  fs.chmodSync(runner.temporaryRoot, 0o700);
  const codexHome = path.join(runner.temporaryRoot, "codex-home");
  const pluginData = path.join(runner.temporaryRoot, "plugin-data");
  const setupFixture = path.join(runner.temporaryRoot, "setup-fixture");
  const completionFixture = path.join(runner.temporaryRoot, "completion-fixture");
  const cancellationFixture = path.join(runner.temporaryRoot, "cancellation-fixture");
  mkdirPrivate(codexHome);
  mkdirPrivate(pluginData);
  const threadId = crypto.randomUUID();
  if (!CANONICAL_UUID.test(threadId)) fail("E_MCP");
  const env = buildChildEnvironment({ codexHome, pluginData, threadId });
  runner.baseEnvironment = env;
  initializeFixtureRepository(setupFixture, env);

  enterQualificationStage("private-install");
  const codexBinary = process.env.CODEX_BIN || "codex";
  runJson(codexBinary, ["plugin", "marketplace", "add", ROOT, "--json"], {
    cwd: ROOT,
    env,
    timeoutMs: 60_000,
    code: "E_INSTALL"
  });
  const installedPayload = runJson(
    codexBinary,
    ["plugin", "add", PLUGIN_ID, "--json"],
    {
      cwd: ROOT,
      env,
      timeoutMs: 60_000,
      code: "E_INSTALL"
    }
  );
  if (typeof installedPayload.installedPath !== "string") fail("E_INSTALL");
  const installedRoot = canonicalPath(
    installedPayload.installedPath,
    "Installed plugin root"
  );
  const cacheRoot = canonicalPath(
    path.join(codexHome, "plugins", "cache"),
    "Private Codex plugin cache"
  );
  if (
    !isPathInside(cacheRoot, installedRoot)
    || isPathInside(SOURCE_PLUGIN, installedRoot)
  ) {
    fail("E_INSTALL");
  }
  const listedPlugins = runJson(codexBinary, ["plugin", "list", "--json"], {
    cwd: ROOT,
    env,
    timeoutMs: 30_000,
    code: "E_INSTALL"
  });
  const installedRecord = listedPlugins.installed?.filter(
    (entry) => entry?.pluginId === PLUGIN_ID
  );
  if (
    !Array.isArray(installedRecord)
    || installedRecord.length !== 1
    || installedRecord[0].installed !== true
    || installedRecord[0].enabled !== true
    || installedRecord[0].version !== packageJson.version
  ) {
    fail("E_INSTALL");
  }
  const installedEntries = createPluginInventory(installedRoot);
  const installedPluginDigest = digestInventory(installedEntries);
  if (
    describeInventoryDifference(sourceEntries, installedEntries).length !== 0
    || installedPluginDigest !== sourcePluginDigest
  ) {
    fail("E_INSTALL");
  }
  const installedEntrypointDigest = digestRegularFile(
    path.join(installedRoot, "mcp", "server.mjs")
  );
  const sourceEntrypoint = sourceEntries.find(
    (entry) => entry.path === "mcp/server.mjs"
  );
  if (
    !sourceEntrypoint
    || sourceEntrypoint.sha256 !== installedEntrypointDigest
  ) {
    fail("E_INSTALL");
  }

  enterQualificationStage("installed-imports");
  const providerCapability = await importInstalled(
    installedRoot,
    "scripts/lib/provider-capability.mjs"
  );
  const state = await importInstalled(installedRoot, "scripts/lib/state.mjs");
  const processControl = await importInstalled(
    installedRoot,
    "scripts/lib/process-control.mjs"
  );
  const guard = await importInstalled(
    installedRoot,
    "scripts/lib/recursion-guard.mjs"
  );
  const mutation = await importInstalled(
    installedRoot,
    "scripts/lib/worker-mutation.mjs"
  );
  const launchContract = await importInstalled(
    installedRoot,
    "scripts/lib/worker-launch-contract.mjs"
  );
  const provider = await importInstalled(
    installedRoot,
    "scripts/lib/grok-provider.mjs"
  );
  const profiles = await importInstalled(
    installedRoot,
    "scripts/lib/profiles.mjs"
  );
  const authority = await importInstalled(
    installedRoot,
    "scripts/lib/worker-authority.mjs"
  );
  const workerProtocol = await importInstalled(
    installedRoot,
    "scripts/lib/worker-protocol.mjs"
  );
  const broker = await importInstalled(installedRoot, "mcp/broker.mjs");

  enterQualificationStage("provider-setup");
  runner.setupBoundary = createSetupBoundary({
    fixtureRoot: setupFixture,
    pluginData,
    env,
    threadId,
    processControl,
    guard
  });
  const setupJson = await runSetupJson(
    process.execPath,
    [path.join(installedRoot, "scripts", "grok-codex.mjs"), "setup", "--json"],
    {
      cwd: setupFixture,
      env,
      timeoutMs: 120_000,
      boundary: runner.setupBoundary,
      runner
    }
  );
  if (!await cleanupSetupBoundary(
    runner.setupBoundary,
    { terminate: false, requireObservation: true }
  )) {
    fail("E_CLEANUP");
  }
  const setup = validateInstalledSetup(setupJson);
  const setupFixtureStatus = runBounded("git", [
    "status", "--porcelain=v1", "-z", "--untracked-files=all"
  ], {
    cwd: setupFixture,
    env,
    requireSilentStderr: false,
    code: "E_SETUP"
  }).stdout;
  if (setupFixtureStatus !== "") fail("E_SETUP");
  const providerIdentity = captureProviderFileIdentity(setup.grok.binary);
  enterQualificationStage("provider-capability");
  const capability = providerCapability.readValidProviderCapabilityReceipt({ env });
  if (!capability) fail("E_CAPABILITY");
  validateProviderCapabilityAgreement(capability, {
    setup,
    pluginVersion: packageJson.version,
    mcpCapabilityContractVersion: providerCapability.MCP_CAPABILITY_CONTRACT_VERSION,
    platform: process.platform,
    architecture: process.arch,
    providerFileIdentity: {
      device: providerIdentity.device,
      inode: providerIdentity.inode,
      size: providerIdentity.size,
      mtimeMs: providerIdentity.mtimeMs,
      contentDigest: providerIdentity.contentDigest
    },
    rootReadProfileDigest: profiles.profileFor("task", false).agentProfileDigest,
    observedAt: Date.now()
  });
  if (
    capability.capabilities?.length !== 1
    || capability.capabilities[0]
      !== providerCapability.ROOT_READ_PROVIDER_CAPABILITY
    || broker.DEFAULT_MCP_PROTOCOL_VERSION !== PROTOCOL_VERSION
    || broker.MCP_SERVER_NAME !== "grok-worker-broker"
    || broker.MCP_SERVER_VERSION
      !== providerCapability.MCP_CAPABILITY_CONTRACT_VERSION
    || !sameJson(
      authority.CODEX_MCP_EXPERIMENTAL_CAPABILITIES,
      EXPECTED_EXPERIMENTAL_CAPABILITIES
    )
  ) {
    fail("E_CAPABILITY");
  }

  runner.provider = provider;
  runner.providerBinary = providerIdentity.path;
  const baseContext = {
    runner,
    env,
    threadId,
    installedRoot,
    providerCapability: capability,
    providerBinary: providerIdentity.path,
    state,
    processControl,
    guard,
    mutation,
    launchContract,
    provider,
    workerProtocol,
    workerTools: broker.WORKER_TOOLS,
    serverVersion: broker.MCP_SERVER_VERSION,
    experimentalCapabilities: EXPECTED_EXPERIMENTAL_CAPABILITIES
  };
  const completion = await runCompletionScenario(baseContext, completionFixture);
  const cancellation = await runCancellationScenario(
    baseContext,
    cancellationFixture
  );

  enterQualificationStage("global-cleanup");
  if (!(await terminateTrackedClients(runner))) fail("E_CLEANUP");
  for (const { tracker } of [completion, cancellation]) {
    if (
      tracker.processIdentities.size !== 3
      || [...tracker.processIdentities.values()]
        .some((identity) => !processControl.processGroupGone(identity))
    ) {
      fail("E_CLEANUP");
    }
  }
  enterQualificationStage("installed-recheck");
  const finalInstalledEntries = createPluginInventory(installedRoot);
  const finalInstalledDigest = digestInventory(finalInstalledEntries);
  const finalInstalledEntrypointDigest = digestRegularFile(
    path.join(installedRoot, "mcp", "server.mjs")
  );
  const finalProviderIdentity = captureProviderFileIdentity(
    providerIdentity.path
  );
  if (
    describeInventoryDifference(installedEntries, finalInstalledEntries).length
      !== 0
    || describeInventoryDifference(sourceEntries, finalInstalledEntries).length
      !== 0
    || finalInstalledDigest !== installedPluginDigest
    || finalInstalledDigest !== sourcePluginDigest
    || finalInstalledEntries.length !== installedEntries.length
    || finalInstalledEntrypointDigest !== installedEntrypointDigest
    || !sameJson(finalProviderIdentity, providerIdentity)
  ) {
    fail("E_INSTALL");
  }
  fs.rmSync(runner.temporaryRoot, { recursive: true, force: true });
  if (fs.existsSync(runner.temporaryRoot)) fail("E_CLEANUP");
  runner.temporaryRemoved = true;

  enterQualificationStage("evidence-binding");
  for (const completed of [completion, cancellation]) {
    completed.tracker.context = completed.context;
    const observation = privateObservationFor(completed.tracker, true);
    validateInstalledScenarioEvidence(completed.publicEvidence, observation);
  }

  const finalSourceIdentity = gitIdentity(ROOT);
  if (
    !isNonEvidenceTreeClean(ROOT)
    || finalSourceIdentity.cleanTreeAtVerification !== true
    || finalSourceIdentity.headCommit !== sourceIdentity.headCommit
    || finalSourceIdentity.headTree !== sourceIdentity.headTree
    || computeInventoryDigest(ROOT, { includeEvidence: false }) !== sourceDigest
    || computePhaseScopeDigest("1", ROOT) !== phaseScopeDigest
    || digestInventory(createPluginInventory(SOURCE_PLUGIN)) !== sourcePluginDigest
  ) {
    fail("E_SOURCE");
  }
  const endedAt = new Date().toISOString();
  const receipt = buildReceipt({
    startedAt,
    endedAt,
    sourceIdentity,
    sourceDigest,
    phaseScopeDigest,
    pluginVersion: packageJson.version,
    sourcePluginDigest,
    installedPluginDigest,
    installedFileCount: installedEntries.length,
    installedEntrypointDigest,
    providerCapabilityDigest: capability.capabilityDigest,
    providerBinaryDigest: providerIdentity.contentDigest,
    providerVersion: capability.providerVersion
  });
  enterQualificationStage("receipt-publication");
  publishReceipt(receipt);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (argv.length !== 0) fail("E_ARGUMENT");
  if (LIVE_GATES.some((name) => process.env[name] !== "1")) fail("E_GATE");
  if (process.platform === "win32") fail("E_PLATFORM");

  const runner = {
    interrupted: false,
    temporaryRoot: null,
    temporaryRemoved: false,
    baseEnvironment: null,
    provider: null,
    providerBinary: null,
    setupBoundary: null,
    clients: new Set(),
    sessions: new Set(),
    turnIds: new Set(),
    trackers: []
  };
  const interrupt = () => { runner.interrupted = true; };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    await qualify(runner);
    process.stdout.write(
      "Installed Worker MCP E2E passed; one provisional synthetic direct-MCP receipt was published.\n"
    );
  } catch (error) {
    const originalCode = error instanceof QualificationError
      ? error.code
      : "E_SCENARIO";
    const originalStage = error instanceof QualificationError
      ? error.stage
      : qualificationStage;
    enterQualificationStage("emergency-cleanup");
    let cleanupProven = false;
    try {
      cleanupProven = await emergencyCleanup(runner);
    } catch {}
    const selected = selectInstalledWorkerMcpFailure({
      originalCode,
      originalStage,
      cleanupProven
    }, QUALIFICATION_STAGES);
    throw new QualificationError(selected.code, selected.stage);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

const IS_MAIN = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_MAIN) {
  main().catch((error) => {
    const code = error instanceof QualificationError ? error.code : "E_SCENARIO";
    const stage = error instanceof QualificationError
      && error.stage !== "startup"
      && QUALIFICATION_STAGES.has(error.stage)
        ? `; stage=${error.stage}`
        : "";
    process.stderr.write(
      `Installed Worker MCP E2E failed [${code}${stage}]: ${FIXED_ERRORS[code] || FIXED_ERRORS.E_SCENARIO}\n`
    );
    process.exitCode = 1;
  });
}
