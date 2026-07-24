import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import { CompanionError } from "./errors.mjs";
import {
  identityMatches,
  processStartToken,
  runSystemPs
} from "./process-control.mjs";
import {
  registerProviderGuard,
  unregisterProviderGuard
} from "./recursion-guard.mjs";

const SPEC_KEYS = new Set(["schemaVersion", "root", "marker", "owner", "binding", "binary", "args"]);
const BINDING_KEYS = new Set([
  "controlWorkspaceId",
  "executionRoot",
  "dispatchAttemptId",
  "dispatchFence",
  "providerGeneration",
  "providerSpawnIntentId"
]);
const MIN_PROVIDER_VERSION = [0, 2, 99];
const PROVIDER_SPEC_FD = 6;
const MAX_PROVIDER_SPEC_BYTES = 64 * 1024;
const MAX_PROVIDER_ARGUMENTS = 256;
const MAX_PROVIDER_ARGUMENT_BYTES = 8 * 1024;

function exactRecord(value, keys) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key))
  );
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value == null || values.has(name)) {
      throw new CompanionError("E_USAGE", "Provider bootstrap arguments are malformed.");
    }
    values.set(name, value);
  }
  const marker = values.get("--job-marker");
  const generation = Number(values.get("--provider-generation"));
  const intentId = values.get("--spawn-intent-id");
  if (values.size !== 3
    || !/^[a-zA-Z0-9._-]{1,80}$/.test(marker || "")
    || !Number.isSafeInteger(generation)
    || generation < 1
    || !/^[0-9a-f]{32}$/.test(intentId || "")) {
    throw new CompanionError("E_USAGE", "Provider bootstrap arguments are incomplete.");
  }
  return Object.freeze({ marker, generation, intentId });
}

function validateSpecification(spec, expected) {
  if (!exactRecord(spec, SPEC_KEYS)
    || spec.schemaVersion !== 1
    || !exactRecord(spec.binding, BINDING_KEYS)
    || spec.marker !== expected.marker
    || spec.binding.providerGeneration !== expected.generation
    || spec.binding.providerSpawnIntentId !== expected.intentId
    || typeof spec.root !== "string"
    || !path.isAbsolute(spec.root)
    || path.normalize(spec.root) !== spec.root
    || spec.root.length > 4_096
    || typeof spec.owner !== "string"
    || !spec.owner
    || spec.owner.length > 256
    || typeof spec.binary !== "string"
    || !path.isAbsolute(spec.binary)
    || path.normalize(spec.binary) !== spec.binary
    || spec.binary.length > 4_096
    || !Array.isArray(spec.args)
    || spec.args.length > MAX_PROVIDER_ARGUMENTS
    || spec.args.some((arg) => (
      typeof arg !== "string"
      || Buffer.byteLength(arg, "utf8") > MAX_PROVIDER_ARGUMENT_BYTES
    ))
    || !/^cws-[0-9a-f]{32}$/.test(spec.binding.controlWorkspaceId || "")
    || spec.binding.executionRoot !== spec.root
    || !/^[0-9a-f]{32}$/.test(spec.binding.dispatchAttemptId || "")
    || !Number.isSafeInteger(spec.binding.dispatchFence)
    || spec.binding.dispatchFence < 1) {
    throw new CompanionError("E_USAGE", "Provider bootstrap specification is not exactly bound.");
  }
  return spec;
}

/** Read exactly one canonical, bounded specification from the inherited pipe. */
export async function readProviderBootstrapSpec(specInput, expected) {
  if (!specInput || typeof specInput[Symbol.asyncIterator] !== "function") {
    throw new CompanionError("E_PROTOCOL", "Provider bootstrap specification channel is unavailable.");
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of specInput) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_PROVIDER_SPEC_BYTES) {
        specInput.destroy?.();
        throw new CompanionError("E_PROTOCOL", "Provider bootstrap specification exceeded its limit.");
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    throw new CompanionError("E_PROTOCOL", "Provider bootstrap specification channel failed.");
  }
  const payload = Buffer.concat(chunks, size);
  const newline = payload.indexOf(0x0a);
  if (payload.length < 2 || newline !== payload.length - 1) {
    throw new CompanionError("E_PROTOCOL", "Provider bootstrap specification was missing, truncated, or contained extra data.");
  }
  let source;
  let spec;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(0, -1));
    spec = JSON.parse(source);
  } catch {
    throw new CompanionError("E_PROTOCOL", "Provider bootstrap specification is unreadable.");
  }
  if (JSON.stringify(spec) !== source) {
    throw new CompanionError("E_PROTOCOL", "Provider bootstrap specification is not canonical.");
  }
  return validateSpecification(spec, expected);
}

function inheritedSpecInput(fd = PROVIDER_SPEC_FD) {
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFIFO() && !stat.isSocket()) throw new Error("not a pipe");
    return fs.createReadStream(null, { fd, autoClose: true });
  } catch {
    throw new CompanionError("E_PROTOCOL", "Provider bootstrap specification channel is unavailable.");
  }
}

function bootstrapStateEnvironment(env) {
  const stateRoot = env.GROK_COMPANION_BOOTSTRAP_PLUGIN_DATA;
  if (!stateRoot || !path.isAbsolute(stateRoot)) {
    throw new CompanionError("E_STATE", "Provider bootstrap state authority is unavailable.");
  }
  return { ...env, GROK_COMPANION_PLUGIN_DATA: stateRoot };
}

export function providerChildEnvironment(env) {
  const child = { ...env };
  for (const key of Object.keys(child)) {
    if (key.startsWith("GROK_COMPANION_BOOTSTRAP_")) delete child[key];
  }
  delete child.GROK_COMPANION_PLUGIN_DATA;
  delete child.NODE_CHANNEL_FD;
  delete child.NODE_CHANNEL_SERIALIZATION_MODE;
  return child;
}

function groupMemberPids(processGroupId) {
  if (process.platform === "win32") return [];
  const run = runSystemPs(["-axo", "pid=,pgid="], {
    encoding: "utf8",
    timeout: 2_000,
    // The inspector must not join the provider group it is observing, or each
    // snapshot would discover its own transient `ps` child and never drain.
    detached: true
  });
  if (run.status !== 0) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Provider bootstrap could not inspect its process group.");
  }
  return String(run.stdout || "")
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      return match && Number(match[2]) === processGroupId ? [Number(match[1])] : [];
    });
}

function providerVersion(binary, env) {
  const run = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
    env
  });
  const match = `${run.stdout || ""} ${run.stderr || ""}`.match(/(\d+)\.(\d+)\.(\d+)/);
  if (run.status !== 0 || !match) {
    throw new CompanionError("E_GROK_VERSION", "Could not determine the Grok CLI version.");
  }
  const parts = match.slice(1).map(Number);
  const tooOld = parts.some((value, index) => (
    value < MIN_PROVIDER_VERSION[index]
    && parts.slice(0, index).every((prior, priorIndex) => prior === MIN_PROVIDER_VERSION[priorIndex])
  ));
  if (tooOld) throw new CompanionError("E_GROK_VERSION", `Grok ${match[0]} is too old; 0.2.99 or newer is required.`);
  return match[0];
}

async function waitForDescendantsToDrain(processGroupId, {
  signal = null,
  pollMs = 25
} = {}) {
  let phase = signal ? "SIGTERM" : null;
  let deadline = Date.now() + 1_500;
  let phaseSignalled = false;
  for (;;) {
    const descendants = groupMemberPids(processGroupId).filter((pid) => pid !== process.pid);
    if (descendants.length === 0) return;
    if (phase && !phaseSignalled) {
      // The authenticated bootstrap owns the entire detached group. Signal
      // that stable kernel identity, never PIDs from a racy process snapshot.
      // SIGTERM is handled by this bootstrap. SIGKILL deliberately kills the
      // whole group, leaving its exact guard for parent/recovery cleanup.
      try { process.kill(-processGroupId, phase); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
      phaseSignalled = true;
    }
    if (phase) {
      if (Date.now() >= deadline && phase === "SIGTERM") {
        phase = "SIGKILL";
        deadline = Date.now() + 1_500;
        phaseSignalled = false;
      }
      // SIGKILL terminates this bootstrap too; execution intentionally stops
      // before it can claim cleanup or remove the durable guard.
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    const spawned = () => { cleanup(); resolve(); };
    const failed = (error) => { cleanup(); reject(error); };
    const cleanup = () => {
      child.off("spawn", spawned);
      child.off("error", failed);
    };
    child.once("spawn", spawned);
    child.once("error", failed);
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function writeReadyMessage(message, fd = 3) {
  fs.writeSync(fd, `${JSON.stringify(message)}\n`);
}

function writePromotionAck(message, fd = 5) {
  fs.writeSync(fd, `${JSON.stringify(message)}\n`);
}

/**
 * Intent-bound bootstrap entry point. Test hooks are dependency-injected and
 * are never sourced from task input, CLI flags, or the ambient environment.
 */
export async function runProviderBootstrap({
  argv = process.argv.slice(2),
  env = process.env,
  specInput = null,
  input = process.stdin,
  output = process.stdout,
  diagnostic = process.stderr,
  controlInput = null,
  spawnProvider = spawn,
  readStartToken = processStartToken,
  platform = process.platform,
  ready = writeReadyMessage,
  promotionAck = writePromotionAck,
  testHooks = null
} = {}) {
  if (platform === "win32") {
    throw new CompanionError("E_CAPABILITY", "Provider bootstrap is unsupported on Windows.");
  }
  const expected = parseArguments(argv);
  const spec = await readProviderBootstrapSpec(specInput, expected);
  const stateEnv = bootstrapStateEnvironment(env);
  const startToken = readStartToken(process.pid);
  const providerProcess = {
    pid: process.pid,
    startToken,
    processGroupId: process.pid
  };
  if (!startToken
    || !identityMatches(providerProcess, spec.marker, "provider-bootstrap")
    || !groupMemberPids(process.pid).includes(process.pid)) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Provider bootstrap is not the authenticated process-group leader.");
  }

  let guardRecord = null;
  let child = null;
  let readyPublished = false;
  let promoted = false;
  let shuttingDown = false;
  let shutdownDrain = null;
  let controlFailure = null;
  let controlBuffer = "";
  const startShutdownDrain = () => {
    if (shutdownDrain) return shutdownDrain;
    shutdownDrain = waitForDescendantsToDrain(process.pid, { signal: "SIGTERM" }).then(
      () => ({ error: null }),
      (error) => ({ error })
    );
    return shutdownDrain;
  };
  const awaitShutdownDrain = async () => {
    const outcome = await startShutdownDrain();
    if (outcome?.error) throw outcome.error;
  };
  const requestShutdown = () => {
    shuttingDown = true;
    try { child?.kill("SIGTERM"); } catch {}
    startShutdownDrain();
  };
  const signalHandlers = new Map();
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    const handler = () => requestShutdown();
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  input.once("end", requestShutdown);
  input.once("error", requestShutdown);
  const failControl = (error) => {
    if (controlFailure) return;
    controlFailure = error instanceof CompanionError
      ? error
      : new CompanionError("E_PROCESS_IDENTITY", "Provider promotion acknowledgement failed.");
    requestShutdown();
  };
  const onControlData = (chunk) => {
    if (promoted || controlFailure) return;
    controlBuffer += String(chunk);
    if (Buffer.byteLength(controlBuffer, "utf8") > 4_096) {
      failControl(new CompanionError("E_PROTOCOL", "Provider bootstrap promotion control exceeded its limit."));
      return;
    }
    const newline = controlBuffer.indexOf("\n");
    if (newline < 0) return;
    const command = controlBuffer.slice(0, newline);
    const trailing = controlBuffer.slice(newline + 1);
    if (command !== "promoted" || trailing.trim()) {
      failControl(new CompanionError("E_PROTOCOL", "Provider bootstrap promotion control was malformed."));
      return;
    }
    promoted = true;
    try {
      promotionAck({
        type: "provider-promoted",
        marker: spec.marker,
        providerGeneration: spec.binding.providerGeneration,
        providerSpawnIntentId: spec.binding.providerSpawnIntentId
      });
    } catch (error) {
      failControl(error);
    }
  };
  const onControlEnd = () => {
    if (!promoted) failControl(new CompanionError(
      "E_PROVIDER_EXIT",
      "Provider bootstrap promotion control closed before acknowledgement."
    ));
  };
  const onControlError = (error) => failControl(error);
  controlInput?.on("data", onControlData);
  controlInput?.once("end", onControlEnd);
  controlInput?.once("error", onControlError);

  try {
    await testHooks?.beforeGuardRegistration?.({ spec, providerProcess });
    guardRecord = registerProviderGuard(
      spec.root,
      spec.marker,
      providerProcess,
      spec.owner,
      "provider",
      spec.binding,
      stateEnv
    );
    await testHooks?.afterGuardRegistered?.({ spec, providerProcess, guardRecord });
    if (shuttingDown) {
      throw new CompanionError("E_CANCELLED", "Provider bootstrap lost its parent before Grok creation.");
    }

    const grokEnvironment = providerChildEnvironment(env);
    const version = providerVersion(spec.binary, grokEnvironment);
    child = spawnProvider(spec.binary, spec.args, {
      cwd: spec.root,
      env: grokEnvironment,
      shell: false,
      detached: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const childOutcome = waitForExit(child).then(
      (exit) => ({ exit, error: null }),
      (error) => ({ exit: null, error })
    );
    await waitForSpawn(child);
    await testHooks?.afterGrokSpawnedBeforeReady?.({ spec, providerProcess, child });
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new CompanionError("E_PROVIDER_EXIT", "Grok exited before provider bootstrap readiness.");
    }
    if (shuttingDown) {
      throw new CompanionError("E_CANCELLED", "Provider bootstrap lost its parent before readiness.");
    }
    input.pipe(child.stdin);
    child.stdout.pipe(output);
    child.stderr.pipe(diagnostic);
    ready({ type: "provider-ready", grokPid: child.pid, version });
    readyPublished = true;

    const outcome = await childOutcome;
    if (outcome.error) throw outcome.error;
    const exit = outcome.exit;
    await awaitShutdownDrain();
    if (controlFailure) throw controlFailure;
    if (promoted) {
      unregisterProviderGuard(spec.root, spec.marker, guardRecord, stateEnv);
      guardRecord = null;
    }
    return exit;
  } catch (error) {
    requestShutdown();
    await awaitShutdownDrain();
    if (guardRecord && promoted) {
      try { unregisterProviderGuard(spec.root, spec.marker, guardRecord, stateEnv); }
      catch { /* Keep the exact guard for host recovery on ambiguity. */ }
      guardRecord = null;
    }
    if (!readyPublished) {
      try {
        ready({
          type: "provider-error",
          code: error?.code || "E_PROVIDER_EXIT",
          message: String(error?.message || error)
        });
      } catch {}
    }
    throw error;
  } finally {
    input.unpipe?.(child?.stdin);
    input.off("end", requestShutdown);
    input.off("error", requestShutdown);
    controlInput?.off("data", onControlData);
    controlInput?.off("end", onControlEnd);
    controlInput?.off("error", onControlError);
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  }
}

async function main() {
  try {
    const controlInput = fs.createReadStream(null, { fd: 4, autoClose: false });
    const specInput = inheritedSpecInput();
    const exit = await runProviderBootstrap({ controlInput, specInput });
    process.exitCode = Number.isInteger(exit.code) ? exit.code : 1;
  } catch {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
