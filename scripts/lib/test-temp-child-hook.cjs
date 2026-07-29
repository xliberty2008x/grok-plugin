"use strict";

const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");

const BYPASS_ENVIRONMENT_KEY = "GROK_PLUGIN_TEST_CHILD_HOOK_BYPASS";
const FORCED_ENVIRONMENT_KEYS = Object.freeze([
  "GROK_PLUGIN_TEST_SUPERVISOR_TOKEN",
  "NODE_OPTIONS"
]);
const FALLBACK_ENVIRONMENT_KEYS = Object.freeze([
  "TEMP",
  "TMP",
  "TMPDIR"
]);

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
  return originalSpawn.call(this, { ...options, envPairs });
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
  return hasArgs
    ? originalSpawnSync.call(this, file, args, injected)
    : originalSpawnSync.call(this, file, injected);
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

syncBuiltinESMExports();
