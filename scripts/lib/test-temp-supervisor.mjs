#!/usr/bin/env node

import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const TERM_GRACE_MS = 1_500;
const KILL_GRACE_MS = 1_500;
const TIMEOUT_EXIT_CODE = 124;
const OUTPUT_LIMIT_EXIT_CODE = 125;
const CONTAINMENT_FAILURE_EXIT_CODE = 126;
const OWNERSHIP_TOKEN_ENV = "GROK_PLUGIN_TEST_SUPERVISOR_TOKEN";
const PS_PATHS = Object.freeze(["/bin/ps", "/usr/bin/ps"]);
let provenLinuxVisibilityToken = null;

function usage() {
  return "Usage: node test-temp-supervisor.mjs --timeout-ms <ms> -- <node> <args...>\n";
}

function parseArgs(argv) {
  if (
    argv.length < 4
    || argv[0] !== "--timeout-ms"
    || !/^[1-9]\d*$/.test(argv[1])
    || argv[2] !== "--"
  ) {
    throw new Error("invalid arguments");
  }
  const timeoutMs = Number(argv[1]);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs > 24 * 60 * 60_000) {
    throw new Error("invalid timeout");
  }
  return { timeoutMs, command: argv[3], args: argv.slice(4) };
}

function signalOwnedGroup(child, signal) {
  if (!child?.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  try {
    child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function trustedPs() {
  return PS_PATHS.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) || null;
}

function privateTempIdentity() {
  const target = process.env.GROK_PLUGIN_TEST_TEMP_ROOT;
  if (!path.isAbsolute(target || "")) return null;
  try {
    const stat = fs.lstatSync(target);
    const parent = path.dirname(target);
    const parentStat = fs.lstatSync(parent);
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || !parentStat.isDirectory()
      || parentStat.isSymbolicLink()
      || fs.realpathSync(target) !== path.resolve(target)
      || !/^file-[A-Za-z0-9]{6}$/u.test(path.basename(target))
      || !/^grok-plugin-test-run-[A-Za-z0-9]{6}$/u.test(path.basename(parent))
    ) {
      return null;
    }
    return target;
  } catch {
    return null;
  }
}

function ownershipEnvironmentEntries(token, tempIdentity) {
  const entries = [`${OWNERSHIP_TOKEN_ENV}=${token}`];
  if (tempIdentity) {
    for (const key of ["TMPDIR", "TMP", "TEMP", "GROK_PLUGIN_TEST_TEMP_ROOT"]) {
      entries.push(`${key}=${tempIdentity}`);
    }
  }
  return entries;
}

export function environmentProvesOwnership(
  environment,
  entries,
  { pid, supervisorPid = process.pid } = {}
) {
  if (!Buffer.isBuffer(environment) || !Array.isArray(entries)) return false;
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === supervisorPid) return false;
  const environmentEntries = environment.toString("utf8").split("\0");
  return entries.some((marker) => environmentEntries.includes(marker));
}

function ownedProcessIds(token, tempIdentity) {
  const entries = ownershipEnvironmentEntries(token, tempIdentity);
  if (process.platform === "win32") return [];
  if (process.platform === "linux") {
    if (provenLinuxVisibilityToken !== token) {
      throw new Error("Owned-process visibility is unavailable.");
    }
    const ids = [];
    for (const entry of fs.readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
      try {
        const environment = fs.readFileSync(path.join("/proc", entry.name, "environ"));
        const pid = Number(entry.name);
        if (environmentProvesOwnership(environment, entries, { pid })) ids.push(pid);
      } catch {
        // A vanished or protected unrelated process is benign after the
        // tagged-child probe below has proved that this supervisor can inspect
        // the exact class of processes it owns.
      }
    }
    return ids;
  }
  const ps = trustedPs();
  if (!ps || typeof process.getuid !== "function") {
    throw new Error("Owned-process visibility is unavailable.");
  }
  const result = spawnSync(ps, [
    "eww",
    "-U",
    String(process.getuid()),
    "-o",
    "pid=,command="
  ], {
    env: { LC_ALL: "C" },
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
    maxBuffer: 128 * 1024 * 1024
  });
  if (result.status !== 0 || result.error || result.signal) {
    throw new Error("Owned-process visibility is unavailable.");
  }
  const escapedEntries = entries.map((entry) => entry.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  const marker = new RegExp(`(?:^|\\s)(?:${escapedEntries.join("|")})(?:\\s|$)`, "u");
  return String(result.stdout || "")
    .split(/\r?\n/u)
    .filter((line) => marker.test(line))
    .map((line) => Number(line.trim().match(/^(\d+)/u)?.[1]))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
}

async function proveLinuxOwnedProcessVisibility(token, tempIdentity) {
  if (process.platform !== "linux") return true;
  const entries = ownershipEnvironmentEntries(token, tempIdentity);
  let probe;
  try {
    probe = spawn(process.execPath, [
      "--eval",
      "setInterval(() => {}, 1000)"
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        [OWNERSHIP_TOKEN_ENV]: token,
        ...(tempIdentity ? {
          TMPDIR: tempIdentity,
          TMP: tempIdentity,
          TEMP: tempIdentity,
          GROK_PLUGIN_TEST_TEMP_ROOT: tempIdentity
        } : {})
      },
      shell: false,
      detached: false,
      stdio: "ignore"
    });
  } catch {
    return false;
  }

  let probeErrored = false;
  const probeClosed = new Promise((resolve) => {
    probe.once("close", () => resolve(true));
    probe.once("error", () => {
      probeErrored = true;
      resolve(false);
    });
  });
  let visible = false;
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline && probe.pid && !probeErrored) {
    try {
      const environment = fs.readFileSync(path.join("/proc", String(probe.pid), "environ"));
      if (environmentProvesOwnership(environment, entries, {
        pid: probe.pid,
        supervisorPid: process.pid
      })) {
        visible = true;
        break;
      }
    } catch (error) {
      if (error?.code === "ENOENT") break;
    }
    await wait(10);
  }

  try {
    probe.kill("SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") visible = false;
  }
  const closed = await Promise.race([
    probe.exitCode != null || probe.signalCode != null
      ? Promise.resolve(true)
      : probeClosed,
    wait(1_000).then(() => false)
  ]);
  return visible && closed;
}

function signalOwnedProcesses(token, tempIdentity, signal) {
  for (const pid of ownedProcessIds(token, tempIdentity)) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processGroupAlive(child) {
  if (!child?.pid) return false;
  if (process.platform === "win32") return child.exitCode == null && child.signalCode == null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function ownedProcessesAlive(child, token, tempIdentity) {
  return processGroupAlive(child) || ownedProcessIds(token, tempIdentity).length > 0;
}

async function waitForOwnedProcessesGone(child, token, tempIdentity, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!ownedProcessesAlive(child, token, tempIdentity)) return true;
    await wait(25);
  }
  return !ownedProcessesAlive(child, token, tempIdentity);
}

async function terminate(child, token, tempIdentity) {
  try {
    signalOwnedGroup(child, "SIGTERM");
    signalOwnedProcesses(token, tempIdentity, "SIGTERM");
    if (await waitForOwnedProcessesGone(child, token, tempIdentity, TERM_GRACE_MS)) return true;
    signalOwnedGroup(child, "SIGKILL");
    signalOwnedProcesses(token, tempIdentity, "SIGKILL");
    return await waitForOwnedProcessesGone(child, token, tempIdentity, KILL_GRACE_MS);
  } catch {
    return false;
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch {
    process.stderr.write(usage());
    return 2;
  }

  const ownershipToken = randomUUID();
  const tempIdentity = privateTempIdentity();
  if (!await proveLinuxOwnedProcessVisibility(ownershipToken, tempIdentity)) {
    return CONTAINMENT_FAILURE_EXIT_CODE;
  }
  if (process.platform === "linux") {
    provenLinuxVisibilityToken = ownershipToken;
  }
  try {
    ownedProcessIds(ownershipToken, tempIdentity);
  } catch {
    return CONTAINMENT_FAILURE_EXIT_CODE;
  }

  let child;
  try {
    child = spawn(parsed.command, parsed.args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GROK_PLUGIN_TEST_SUPERVISOR_PID: String(process.pid),
        [OWNERSHIP_TOKEN_ENV]: ownershipToken
      },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return 1;
  }

  const chunks = [];
  let outputBytes = 0;
  let overflow = false;
  let resolveOverflow;
  const overflowed = new Promise((resolve) => {
    resolveOverflow = resolve;
  });
  child.stdout.on("data", (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes <= MAX_OUTPUT_BYTES) chunks.push(chunk);
    else if (!overflow) {
      overflow = true;
      resolveOverflow("overflow");
    }
  });

  let closeResult;
  const closed = new Promise((resolve) => {
    child.once("error", () => resolve({ code: null, signal: null, error: true }));
    child.once("close", (code, signal) => resolve({ code, signal, error: false }));
  }).then((result) => {
    closeResult = result;
    return result;
  });

  let interrupted = false;
  let resolveInterrupt;
  const interruptedSignal = new Promise((resolve) => {
    resolveInterrupt = resolve;
  });
  const interrupt = () => {
    if (interrupted) return;
    interrupted = true;
    resolveInterrupt("interrupt");
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  const outcome = await Promise.race([
    closed.then(() => "closed"),
    wait(parsed.timeoutMs).then(() => "timeout"),
    overflowed,
    interruptedSignal
  ]);
  let contained = true;
  if (outcome === "timeout" || outcome === "overflow" || outcome === "interrupt") {
    contained = await terminate(child, ownershipToken, tempIdentity);
  } else {
    try {
      if (ownedProcessesAlive(child, ownershipToken, tempIdentity)) {
    // A test file can exit while an unref'ed or detached descendant remains.
        // Reap only processes that retain the random token or private temp root.
        contained = await terminate(child, ownershipToken, tempIdentity);
      }
    } catch {
      contained = false;
    }
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);

  if (!overflow && chunks.length) fs.writeSync(process.stdout.fd, Buffer.concat(chunks));
  if (!contained) return CONTAINMENT_FAILURE_EXIT_CODE;
  if (overflow) return OUTPUT_LIMIT_EXIT_CODE;
  if (outcome === "timeout") return TIMEOUT_EXIT_CODE;
  if (interrupted) return 130;
  if (closeResult?.error || closeResult?.signal) return 1;
  return Number.isInteger(closeResult?.code) ? closeResult.code : 1;
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
