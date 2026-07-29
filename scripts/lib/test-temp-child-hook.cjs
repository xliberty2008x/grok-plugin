"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const path = require("node:path");

const BYPASS_ENVIRONMENT_KEY = "GROK_PLUGIN_TEST_CHILD_HOOK_BYPASS";
const PID_REGISTRY_ENVIRONMENT_KEY = "GROK_PLUGIN_TEST_PID_REGISTRY";
const FORCED_ENVIRONMENT_KEYS = Object.freeze([
  PID_REGISTRY_ENVIRONMENT_KEY,
  "GROK_PLUGIN_TEST_SUPERVISOR_TOKEN",
  "GROK_PLUGIN_TEST_TEMP_ROOT",
  "NODE_OPTIONS"
]);
const FALLBACK_ENVIRONMENT_KEYS = Object.freeze([
  "TEMP",
  "TMP",
  "TMPDIR"
]);

function linuxProcessRegistration(pid, expectedParentPid = null) {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 1) return null;
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

function appendLinuxProcessRegistration(pid, expectedParentPid = null) {
  const registry = process.env[PID_REGISTRY_ENVIRONMENT_KEY];
  const tempRoot = process.env.GROK_PLUGIN_TEST_TEMP_ROOT;
  if (
    process.platform !== "linux"
    || !path.isAbsolute(registry || "")
    || !path.isAbsolute(tempRoot || "")
    || path.dirname(registry) !== path.resolve(tempRoot)
  ) {
    return;
  }
  const registration = linuxProcessRegistration(pid, expectedParentPid);
  if (!registration) return;
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
    fs.writeSync(descriptor, `${registration}\n`, null, "utf8");
  } catch {
    // The supervisor still has process-group and environment visibility.
  } finally {
    if (Number.isInteger(descriptor)) fs.closeSync(descriptor);
  }
}

function selectedEnvironment(keys) {
  return Object.fromEntries(keys
    .filter((key) => typeof process.env[key] === "string")
    .map((key) => [key, process.env[key]]));
}

function injectObjectEnvironment(options = {}) {
  const provided = options.env || process.env;
  const fallback = Object.fromEntries(Object.entries(
    selectedEnvironment(FALLBACK_ENVIRONMENT_KEYS)
  ).filter(([key]) => typeof provided[key] !== "string"));
  return {
    ...options,
    env: {
      ...provided,
      ...fallback,
      ...selectedEnvironment(FORCED_ENVIRONMENT_KEYS)
    }
  };
}

const originalSpawn = childProcess.ChildProcess.prototype.spawn;
childProcess.ChildProcess.prototype.spawn = function spawnWithTestOwnership(options) {
  if (
    Array.isArray(options?.envPairs)
    && options.envPairs.includes(`${BYPASS_ENVIRONMENT_KEY}=1`)
  ) {
    return originalSpawn.call(this, options);
  }
  const forced = selectedEnvironment(FORCED_ENVIRONMENT_KEYS);
  const fallback = selectedEnvironment(FALLBACK_ENVIRONMENT_KEYS);
  const forcedKeys = new Set(Object.keys(forced));
  const providedKeys = new Set((options?.envPairs || [])
    .map((entry) => String(entry).split("=", 1)[0]));
  const envPairs = Array.isArray(options?.envPairs)
    ? options.envPairs.filter((entry) => !forcedKeys.has(String(entry).split("=", 1)[0]))
    : [];
  for (const [key, value] of Object.entries(fallback)) {
    if (!providedKeys.has(key)) envPairs.push(`${key}=${value}`);
  }
  for (const [key, value] of Object.entries(forced)) envPairs.push(`${key}=${value}`);
  const result = originalSpawn.call(this, { ...options, envPairs });
  appendLinuxProcessRegistration(this.pid, process.pid);
  return result;
};

const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function spawnSyncWithTestOwnership(file, args, options) {
  const hasArgs = Array.isArray(args);
  const selectedOptions = hasArgs ? options : args;
  if (selectedOptions?.env?.[BYPASS_ENVIRONMENT_KEY] === "1") {
    return hasArgs
      ? originalSpawnSync.call(this, file, args, selectedOptions)
      : originalSpawnSync.call(this, file, selectedOptions);
  }
  const injected = injectObjectEnvironment(selectedOptions);
  const result = hasArgs
    ? originalSpawnSync.call(this, file, args, injected)
    : originalSpawnSync.call(this, file, injected);
  appendLinuxProcessRegistration(result?.pid, process.pid);
  return result;
};

const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function execFileSyncWithTestOwnership(file, args, options) {
  const hasArgs = Array.isArray(args);
  const selectedOptions = hasArgs ? options : args;
  const injected = injectObjectEnvironment(selectedOptions);
  return hasArgs
    ? originalExecFileSync.call(this, file, args, injected)
    : originalExecFileSync.call(this, file, injected);
};

const originalExecSync = childProcess.execSync;
childProcess.execSync = function execSyncWithTestOwnership(command, options) {
  return originalExecSync.call(this, command, injectObjectEnvironment(options));
};

if (process.env[BYPASS_ENVIRONMENT_KEY] !== "1") {
  appendLinuxProcessRegistration(process.pid);
}

syncBuiltinESMExports();
