"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const path = require("node:path");

const BYPASS_ENVIRONMENT_KEY = "GROK_PLUGIN_TEST_CHILD_HOOK_BYPASS";
const PID_REGISTRY_ENVIRONMENT_KEY = "GROK_PLUGIN_TEST_PID_REGISTRY";
const PID_REGISTRY_SECRET_ENVIRONMENT_KEY = "GROK_PLUGIN_TEST_PID_REGISTRY_SECRET";
const SUPERVISOR_PID_ENVIRONMENT_KEY = "GROK_PLUGIN_TEST_SUPERVISOR_PID";
const SUPERVISOR_AUTHORITY_SYMBOL = Symbol.for(
  "grok-plugin.testSupervisorAuthority"
);
const REMOVE_HELPER = path.resolve(__dirname, "test-temp-remove-helper.cjs");
const DIRECT_TEMP_FALLBACK_HELPER = path.resolve(
  __dirname,
  "../../tests/direct-temp-fallback-child.mjs"
);
const SUPERVISOR_HELPER = path.resolve(__dirname, "test-temp-supervisor.mjs");
const REGISTRATION_ACK_TIMEOUT_MS = 5_000;
const REGISTRATION_ACK_POLL_MS = 5;
const registrationAckWaitBuffer = new Int32Array(new SharedArrayBuffer(4));
const FORCED_ENVIRONMENT_KEYS = Object.freeze([
  PID_REGISTRY_ENVIRONMENT_KEY,
  "GROK_PLUGIN_TEST_SUPERVISOR_TOKEN",
  "GROK_PLUGIN_TEST_TEMP_ROOT",
  SUPERVISOR_PID_ENVIRONMENT_KEY,
  "NODE_OPTIONS"
]);
const FALLBACK_ENVIRONMENT_KEYS = Object.freeze([
  "TEMP",
  "TMP",
  "TMPDIR"
]);
const originalSpawnSync = childProcess.spawnSync;
const capturedForcedEnvironment = Object.freeze(
  selectedEnvironment(FORCED_ENVIRONMENT_KEYS)
);
const capturedFallbackEnvironment = Object.freeze(
  selectedEnvironment(FALLBACK_ENVIRONMENT_KEYS)
);
const capturedRegistrySecret =
  process.env[PID_REGISTRY_SECRET_ENVIRONMENT_KEY] || null;
const capturedBypass = process.env[BYPASS_ENVIRONMENT_KEY] === "1";
const capturedSupervisorEntrypoint =
  path.resolve(String(process.argv[1] || "")) === SUPERVISOR_HELPER;
delete process.env[PID_REGISTRY_SECRET_ENVIRONMENT_KEY];

function activeAuthority() {
  const rebound = globalThis[SUPERVISOR_AUTHORITY_SYMBOL];
  if (
    capturedSupervisorEntrypoint
    &&
    rebound
    && Number(rebound[SUPERVISOR_PID_ENVIRONMENT_KEY]) === process.pid
  ) {
    return rebound;
  }
  return capturedForcedEnvironment;
}

function activeRegistrySecret() {
  const rebound = globalThis[SUPERVISOR_AUTHORITY_SYMBOL];
  const supervisorSecret = rebound?.[PID_REGISTRY_SECRET_ENVIRONMENT_KEY];
  if (
    capturedSupervisorEntrypoint
    &&
    Number(rebound?.[SUPERVISOR_PID_ENVIRONMENT_KEY]) === process.pid
    && typeof supervisorSecret === "string"
  ) return supervisorSecret;
  return capturedRegistrySecret;
}

function isDirectNodeLaunch(file) {
  return path.resolve(String(file || "")) === path.resolve(process.execPath);
}

function forcedEnvironment({
  nestedSupervisor = false,
  includeRegistrySecret = false
} = {}) {
  const selected = { ...activeAuthority() };
  if (nestedSupervisor) {
    delete selected[PID_REGISTRY_ENVIRONMENT_KEY];
    delete selected.GROK_PLUGIN_TEST_TEMP_ROOT;
    delete selected[SUPERVISOR_PID_ENVIRONMENT_KEY];
  }
  const registrySecret = activeRegistrySecret();
  if (registrySecret && !nestedSupervisor && includeRegistrySecret) {
    selected[PID_REGISTRY_SECRET_ENVIRONMENT_KEY] = registrySecret;
  }
  return selected;
}

function isNestedSupervisorLaunch(file, args) {
  return (
    file === process.execPath
    && Array.isArray(args)
    && path.resolve(String(args[0] || "")) === SUPERVISOR_HELPER
  );
}

function syncBypassAuthorized(file, args, options) {
  if (options?.env?.[BYPASS_ENVIRONMENT_KEY] !== "1") return false;
  return (
    file === process.execPath
    && Array.isArray(args)
    && (
      (
        args.length === 3
        && path.resolve(String(args[0] || "")) === REMOVE_HELPER
      )
      || (
        args.length === 1
        && path.resolve(String(args[0] || "")) === DIRECT_TEMP_FALLBACK_HELPER
      )
    )
  );
}

function rejectDetachedSync(file, options) {
  if (options?.detached !== true) return;
  if (
    (file === "/bin/ps" || file === "/usr/bin/ps")
    && options.shell !== true
    && Number.isFinite(options.timeout)
    && options.timeout <= 2_000
  ) {
    return;
  }
  const error = new Error("Detached synchronous children are not safely containable.");
  error.code = "E_TEST_TEMP_DETACHED_SYNC";
  throw error;
}

function processRegistration(pid, expectedParentPid = null) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  if (process.platform === "darwin") {
    const result = originalSpawnSync("/bin/ps", [
      "-p",
      String(pid),
      "-o",
      "ppid=,state=,lstart="
    ], {
      env: { LC_ALL: "C", [BYPASS_ENVIRONMENT_KEY]: "1" },
      encoding: "utf8",
      shell: false,
      timeout: 1_000,
      maxBuffer: 8 * 1024
    });
    const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(String(result.stdout || ""));
    const parentPid = Number(match?.[1]);
    const state = match?.[2];
    const startToken = match?.[3];
    if (
      result.status !== 0
      || result.error
      || result.signal
      || state?.includes("Z")
      || !startToken
      || (
        Number.isSafeInteger(expectedParentPid)
        && parentPid !== expectedParentPid
      )
    ) {
      return null;
    }
    return `${pid}:m${Buffer.from(startToken, "utf8").toString("hex")}`;
  }
  if (process.platform !== "linux") return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/u);
    const state = fields[0];
    const parentPid = Number(fields[1]);
    const startTime = fields[19];
    if (
      ["Z", "X", "x"].includes(state)
      || !startTime
      || !/^\d+$/u.test(startTime)
      || (
        Number.isSafeInteger(expectedParentPid)
        && parentPid !== expectedParentPid
      )
    ) {
      return null;
    }
    return `${pid}:${startTime}`;
  } catch {
    return null;
  }
}

function waitForRegistrationAcknowledgement(registry, registration, registrySecret) {
  if (capturedSupervisorEntrypoint) return;
  const expected = `ack:${registration}:${crypto
    .createHmac("sha256", registrySecret)
    .update(`ack:${registration}`)
    .digest("hex")}`;
  const deadline = Date.now() + REGISTRATION_ACK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const contents = fs.readFileSync(registry, "utf8");
      if (contents.split("\n").includes(expected)) return;
    } catch {
      // The supervisor will fail containment if the registry becomes unreadable.
    }
    Atomics.wait(
      registrationAckWaitBuffer,
      0,
      0,
      REGISTRATION_ACK_POLL_MS
    );
  }
  const error = new Error("The test supervisor did not acknowledge child ownership.");
  error.code = "E_TEST_TEMP_REGISTRATION_ACK";
  throw error;
}

function appendProcessRegistration(pid, expectedParentPid = null) {
  const authority = activeAuthority();
  const registry = authority[PID_REGISTRY_ENVIRONMENT_KEY];
  const tempRoot = authority.GROK_PLUGIN_TEST_TEMP_ROOT;
  if (
    (process.platform !== "linux" && process.platform !== "darwin")
    || !path.isAbsolute(registry || "")
    || !path.isAbsolute(tempRoot || "")
    || path.dirname(registry) !== path.resolve(tempRoot)
  ) {
    return;
  }
  const registration = processRegistration(pid, expectedParentPid);
  const registrySecret = activeRegistrySecret();
  if (!registration || !registrySecret) return;
  const signature = crypto
    .createHmac("sha256", registrySecret)
    .update(registration)
    .digest("hex");
  let descriptor;
  try {
    const before = fs.lstatSync(registry);
    if (!before.isFile() || before.isSymbolicLink()) return;
    descriptor = fs.openSync(
      registry,
      fs.constants.O_WRONLY
        | fs.constants.O_APPEND
        | fs.constants.O_NOFOLLOW
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) {
      return;
    }
    fs.writeSync(descriptor, `${registration}:${signature}\n`, null, "utf8");
  } catch {
    // The supervisor still has process-group and environment visibility.
  } finally {
    if (Number.isInteger(descriptor)) fs.closeSync(descriptor);
  }
  waitForRegistrationAcknowledgement(registry, registration, registrySecret);
}

function selectedEnvironment(keys) {
  return Object.fromEntries(keys
    .filter((key) => typeof process.env[key] === "string")
    .map((key) => [key, process.env[key]]));
}

function injectObjectEnvironment(
  options = {},
  { nestedSupervisor = false, file = null } = {}
) {
  const provided = options.env || process.env;
  const fallback = Object.fromEntries(Object.entries(
    capturedFallbackEnvironment
  ).filter(([key]) => typeof provided[key] !== "string"));
  const environment = {
    ...provided,
    ...fallback,
    ...forcedEnvironment({
      nestedSupervisor,
      includeRegistrySecret: isDirectNodeLaunch(file)
    })
  };
  if (nestedSupervisor || !isDirectNodeLaunch(file)) {
    delete environment[PID_REGISTRY_SECRET_ENVIRONMENT_KEY];
  }
  if (nestedSupervisor) {
    delete environment[PID_REGISTRY_ENVIRONMENT_KEY];
    delete environment[SUPERVISOR_PID_ENVIRONMENT_KEY];
  }
  return {
    ...options,
    env: environment
  };
}

function environmentPairKey(entry) {
  const text = String(entry);
  const separator = text.indexOf("=");
  return separator === -1 ? text : text.slice(0, separator);
}

const originalSpawn = childProcess.ChildProcess.prototype.spawn;
childProcess.ChildProcess.prototype.spawn = function spawnWithTestOwnership(options) {
  const forced = forcedEnvironment({
    includeRegistrySecret: isDirectNodeLaunch(options?.file)
  });
  const fallback = capturedFallbackEnvironment;
  const forcedKeys = new Set([
    ...Object.keys(forced),
    PID_REGISTRY_SECRET_ENVIRONMENT_KEY
  ]);
  const providedKeys = new Set((options?.envPairs || [])
    .map(environmentPairKey));
  const envPairs = Array.isArray(options?.envPairs)
    ? options.envPairs.filter((entry) => !forcedKeys.has(environmentPairKey(entry)))
    : [];
  for (const [key, value] of Object.entries(fallback)) {
    if (!providedKeys.has(key)) envPairs.push(`${key}=${value}`);
  }
  for (const [key, value] of Object.entries(forced)) envPairs.push(`${key}=${value}`);
  const result = originalSpawn.call(this, { ...options, envPairs });
  if (process.platform === "linux" || process.platform === "darwin") {
    appendProcessRegistration(this.pid, process.pid);
  }
  return result;
};

childProcess.spawnSync = function spawnSyncWithTestOwnership(file, args, options) {
  const hasArgs = Array.isArray(args);
  const selectedOptions = hasArgs ? options : args;
  if (syncBypassAuthorized(file, hasArgs ? args : [], selectedOptions)) {
    return hasArgs
      ? originalSpawnSync.call(this, file, args, selectedOptions)
      : originalSpawnSync.call(this, file, selectedOptions);
  }
  rejectDetachedSync(file, selectedOptions);
  const injected = injectObjectEnvironment(selectedOptions, {
    nestedSupervisor: isNestedSupervisorLaunch(file, hasArgs ? args : []),
    file
  });
  const result = hasArgs
    ? originalSpawnSync.call(this, file, args, injected)
    : originalSpawnSync.call(this, file, injected);
  appendProcessRegistration(result?.pid, process.pid);
  return result;
};

const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function execFileSyncWithTestOwnership(file, args, options) {
  const hasArgs = Array.isArray(args);
  const selectedOptions = hasArgs ? options : args;
  rejectDetachedSync(file, selectedOptions);
  const injected = injectObjectEnvironment(selectedOptions, { file });
  return hasArgs
    ? originalExecFileSync.call(this, file, args, injected)
    : originalExecFileSync.call(this, file, injected);
};

const originalExecSync = childProcess.execSync;
childProcess.execSync = function execSyncWithTestOwnership(command, options) {
  rejectDetachedSync(null, options);
  return originalExecSync.call(this, command, injectObjectEnvironment(options));
};

if (
  process.platform === "linux"
  && !capturedBypass
) {
  appendProcessRegistration(process.pid);
}

syncBuiltinESMExports();
