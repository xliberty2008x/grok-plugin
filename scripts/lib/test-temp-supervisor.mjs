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
const CHILD_HOOK_BYPASS_ENV = "GROK_PLUGIN_TEST_CHILD_HOOK_BYPASS";
const PS_PATHS = Object.freeze(["/bin/ps", "/usr/bin/ps"]);
const CHILD_HOOK = fileURLToPath(new URL("./test-temp-child-hook.cjs", import.meta.url));
let provenLinuxVisibilityToken = null;
const knownLinuxOwnedProcesses = new Map();
const CONTAINMENT_DIAGNOSTIC_PREFIX = "grok-plugin-containment-v1:";
const CONTAINMENT_REASONS = new Set([
  "unsupported-platform",
  "startup-visibility",
  "visibility-monitor",
  "post-close-inspection",
  "termination-incomplete-group",
  "termination-incomplete-owned",
  "termination-incomplete-unknown"
]);

function usage() {
  return "Usage: node test-temp-supervisor.mjs --timeout-ms <ms> -- <node> <args...>\n";
}

function containmentFailure(reason) {
  const safeReason = CONTAINMENT_REASONS.has(reason) ? reason : "termination-incomplete-unknown";
  process.stderr.write(`${CONTAINMENT_DIAGNOSTIC_PREFIX}${safeReason}\n`);
  return CONTAINMENT_FAILURE_EXIT_CODE;
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

function childNodeOptions() {
  const hook = `--require=${JSON.stringify(CHILD_HOOK)}`;
  const existing = String(process.env.NODE_OPTIONS || "").trim();
  if (existing.includes(hook)) return existing;
  return existing ? `${existing} ${hook}` : hook;
}

export function linuxProcessIdentityFromStat(pid, stat) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || typeof stat !== "string") return null;
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return null;
  const fieldsAfterCommand = stat.slice(commandEnd + 1).trim().split(/\s+/u);
  const state = fieldsAfterCommand[0];
  const startTime = fieldsAfterCommand[19];
  return (
    !["Z", "X", "x"].includes(state)
    && startTime
    && /^\d+$/u.test(startTime)
  ) ? `${pid}:${startTime}` : null;
}

export function linuxProcessGroupMemberFromStat(pid, stat) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || typeof stat !== "string") return null;
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return null;
  const fieldsAfterCommand = stat.slice(commandEnd + 1).trim().split(/\s+/u);
  const state = fieldsAfterCommand[0];
  const processGroupId = Number(fieldsAfterCommand[2]);
  if (
    typeof state !== "string"
    || state.length !== 1
    || !Number.isSafeInteger(processGroupId)
    || processGroupId <= 1
  ) {
    return null;
  }
  return {
    processGroupId,
    terminal: ["Z", "X", "x"].includes(state)
  };
}

export function linuxProcessProvesLiveOwnership(
  pid,
  stat,
  environment,
  entries,
  { supervisorPid = process.pid } = {}
) {
  const member = linuxProcessGroupMemberFromStat(pid, stat);
  return member?.terminal !== true && environmentProvesOwnership(
    environment,
    entries,
    { pid, supervisorPid }
  );
}

function linuxProcessIdentity(pid) {
  try {
    const stat = fs.readFileSync(path.join("/proc", String(pid), "stat"), "utf8");
    return linuxProcessIdentityFromStat(pid, stat);
  } catch {
    return null;
  }
}

function rememberLinuxOwnedProcess(pid) {
  const identity = linuxProcessIdentity(pid);
  if (identity) knownLinuxOwnedProcesses.set(pid, identity);
}

function verifiedKnownLinuxProcessIds() {
  const verified = [];
  for (const [pid, identity] of knownLinuxOwnedProcesses) {
    const current = linuxProcessIdentity(pid);
    if (current === identity) verified.push(pid);
    else knownLinuxOwnedProcesses.delete(pid);
  }
  return verified;
}

function signalKnownLinuxOwnedProcesses(signal) {
  for (const pid of verifiedKnownLinuxProcessIds()) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error?.code === "ESRCH") knownLinuxOwnedProcesses.delete(pid);
      else throw error;
    }
  }
}

async function waitForKnownLinuxProcessesGone(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (verifiedKnownLinuxProcessIds().length === 0) return true;
    await wait(25);
  }
  return verifiedKnownLinuxProcessIds().length === 0;
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
      const pid = Number(entry.name);
      try {
        const stat = fs.readFileSync(path.join("/proc", entry.name, "stat"), "utf8");
        const member = linuxProcessGroupMemberFromStat(pid, stat);
        if (member?.terminal) {
          knownLinuxOwnedProcesses.delete(pid);
          continue;
        }
        const environment = fs.readFileSync(path.join("/proc", entry.name, "environ"));
        if (linuxProcessProvesLiveOwnership(pid, stat, environment, entries)) {
          rememberLinuxOwnedProcess(pid);
          ids.push(pid);
        }
      } catch (error) {
        if (error?.code === "ENOENT") {
          knownLinuxOwnedProcesses.delete(pid);
          continue;
        }
        const knownIdentity = knownLinuxOwnedProcesses.get(pid);
        if (knownIdentity) {
          const currentIdentity = linuxProcessIdentity(pid);
          if (currentIdentity === knownIdentity) {
            throw new Error("Owned-process visibility became unavailable.");
          }
          knownLinuxOwnedProcesses.delete(pid);
        }
        // A vanished or protected unrelated process is benign after the
        // tagged detached-child probe below has proved that this supervisor can
        // inspect both direct and reparented processes that it owns.
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
    env: { LC_ALL: "C", [CHILD_HOOK_BYPASS_ENV]: "1" },
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
      [
        "const { spawn } = require('node:child_process');",
        "const orphan = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], {",
        "  detached: true, env: process.env, shell: false, stdio: 'ignore'",
        "});",
        "orphan.unref();",
        "process.stdout.write(String(orphan.pid) + '\\n');",
        "setTimeout(() => process.exit(0), 250);"
      ].join("\n")
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
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return false;
  }

  const stdout = [];
  probe.stdout.on("data", (chunk) => stdout.push(chunk));
  let probeErrored = false;
  const probeClosed = new Promise((resolve) => {
    probe.once("close", () => resolve(true));
    probe.once("error", () => {
      probeErrored = true;
      resolve(false);
    });
  });
  let directVisible = false;
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline && probe.pid && !probeErrored) {
    try {
      const environment = fs.readFileSync(path.join("/proc", String(probe.pid), "environ"));
      if (environmentProvesOwnership(environment, entries, {
        pid: probe.pid,
        supervisorPid: process.pid
      })) {
        directVisible = true;
        break;
      }
    } catch (error) {
      if (error?.code === "ENOENT") break;
    }
    await wait(10);
  }

  const closed = await Promise.race([
    probe.exitCode != null || probe.signalCode != null
      ? Promise.resolve(true)
      : probeClosed,
    wait(1_000).then(() => false)
  ]);
  if (!closed) {
    try {
      probe.kill("SIGKILL");
    } catch {
      // The failed visibility proof remains authoritative.
    }
  }

  const orphanPid = Number(Buffer.concat(stdout).toString("utf8").trim());
  const cleanupPids = new Set();
  if (Number.isSafeInteger(orphanPid) && orphanPid > 1) cleanupPids.add(orphanPid);
  for (const entry of fs.readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      const environment = fs.readFileSync(path.join("/proc", entry.name, "environ"));
      if (environmentProvesOwnership(environment, entries, { pid })) cleanupPids.add(pid);
    } catch {
      // The proof will fail; cleanup below still handles every PID already known.
    }
  }
  let orphanVisible = false;
  if (closed && cleanupPids.has(orphanPid)) {
    try {
      const environment = fs.readFileSync(path.join("/proc", String(orphanPid), "environ"));
      orphanVisible = environmentProvesOwnership(environment, entries, {
        pid: orphanPid,
        supervisorPid: process.pid
      });
      if (orphanVisible) rememberLinuxOwnedProcess(orphanPid);
    } catch {
      orphanVisible = false;
    }
  }
  for (const pid of cleanupPids) {
    rememberLinuxOwnedProcess(pid);
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") orphanVisible = false;
    }
  }
  if (!await waitForKnownLinuxProcessesGone(1_000)) orphanVisible = false;
  return directVisible && closed && orphanVisible;
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
  if (process.platform === "linux") {
    let kernelReportsGroup = true;
    try {
      process.kill(-child.pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      if (error?.code !== "EPERM") throw error;
    }
    let sawMember = false;
    for (const entry of fs.readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
      try {
        const pid = Number(entry.name);
        const stat = fs.readFileSync(path.join("/proc", entry.name, "stat"), "utf8");
        const member = linuxProcessGroupMemberFromStat(pid, stat);
        if (member?.processGroupId !== child.pid) continue;
        sawMember = true;
        if (!member.terminal) return true;
      } catch {
        // A vanished or unrelated protected process is resolved by the final
        // kernel group check below.
      }
    }
    if (sawMember) return false;
    try {
      process.kill(-child.pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") kernelReportsGroup = false;
      else if (error?.code !== "EPERM") throw error;
    }
    return kernelReportsGroup;
  }
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
    if (process.platform === "linux") {
      try {
        signalKnownLinuxOwnedProcesses("SIGKILL");
        await waitForKnownLinuxProcessesGone(KILL_GRACE_MS);
      } catch {
        // Containment remains unproven and the caller returns 126.
      }
    }
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
  // A supervisor can itself run beneath another supervisor. Rebind the
  // preloaded child hook to this supervisor's ownership identity before it
  // launches visibility probes or the actual test command.
  process.env.GROK_PLUGIN_TEST_SUPERVISOR_PID = String(process.pid);
  process.env[OWNERSHIP_TOKEN_ENV] = ownershipToken;
  process.env.NODE_OPTIONS = childNodeOptions();
  // Node does not expose Windows Job Objects. A PID/PPID snapshot is not a
  // sufficient containment boundary after an intermediate process exits, so
  // fail closed instead of launching an uncontained deterministic test.
  if (process.platform === "win32") return containmentFailure("unsupported-platform");
  if (!await proveLinuxOwnedProcessVisibility(ownershipToken, tempIdentity)) {
    return containmentFailure("startup-visibility");
  }
  if (process.platform === "linux") {
    provenLinuxVisibilityToken = ownershipToken;
  }
  try {
    ownedProcessIds(ownershipToken, tempIdentity);
  } catch {
    return containmentFailure("startup-visibility");
  }

  let child;
  try {
    child = spawn(parsed.command, parsed.args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GROK_PLUGIN_TEST_SUPERVISOR_PID: String(process.pid),
        [OWNERSHIP_TOKEN_ENV]: ownershipToken,
        NODE_OPTIONS: childNodeOptions()
      },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return 1;
  }
  if (process.platform === "linux" && child.pid) {
    rememberLinuxOwnedProcess(child.pid);
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
  let resolveContainmentFailure;
  let containmentReason = null;
  const containmentFailed = new Promise((resolve) => {
    resolveContainmentFailure = resolve;
  });
  let containmentMonitor = null;
  if (process.platform === "linux") {
    containmentMonitor = setInterval(() => {
      try {
        ownedProcessIds(ownershipToken, tempIdentity);
      } catch {
        containmentReason = "visibility-monitor";
        resolveContainmentFailure("containment-failure");
      }
    }, 25);
    containmentMonitor.unref();
  }
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
    interruptedSignal,
    containmentFailed
  ]);
  let contained = true;
  if (
    outcome === "timeout"
    || outcome === "overflow"
    || outcome === "interrupt"
    || outcome === "containment-failure"
  ) {
    contained = await terminate(child, ownershipToken, tempIdentity);
  } else {
    try {
      const groupAlive = processGroupAlive(child);
      const ownedAlive = ownedProcessIds(ownershipToken, tempIdentity).length > 0;
      if (groupAlive || ownedAlive) {
        containmentReason = groupAlive
          ? "termination-incomplete-group"
          : "termination-incomplete-owned";
        // A test file can exit while an unref'ed or detached descendant remains.
        // Reap only processes that retain the random token or private temp root.
        contained = await terminate(child, ownershipToken, tempIdentity);
      }
    } catch {
      containmentReason = "post-close-inspection";
      contained = false;
    }
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  if (containmentMonitor) clearInterval(containmentMonitor);

  if (!overflow && chunks.length) fs.writeSync(process.stdout.fd, Buffer.concat(chunks));
  if (!contained) return containmentFailure(containmentReason);
  if (outcome === "containment-failure") return containmentFailure("visibility-monitor");
  if (overflow) return OUTPUT_LIMIT_EXIT_CODE;
  if (outcome === "timeout") return TIMEOUT_EXIT_CODE;
  if (interrupted) return 130;
  if (closeResult?.error || closeResult?.signal) return 1;
  return Number.isInteger(closeResult?.code) ? closeResult.code : 1;
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
