import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const COMPANION = path.join(ROOT, "plugins", "grok", "scripts", "grok-companion.mjs");
export const CODEX_COMPANION = path.join(ROOT, "plugins", "grok", "scripts", "grok-codex.mjs");
export const NONBLOCKING_STDIN_CHILD = path.join(ROOT, "tests", "nonblocking-stdin-child.mjs");
export const PTY_STDIN_DRIVER = path.join(ROOT, "tests", "pty-stdin-driver.py");
const PTY_PYTHON_FLAGS = Object.freeze(["-I", "-S", "-B"]);

function ptyPythonCommand(env = process.env) {
  const bound = env?.GROK_PROOF_PYTHON;
  return typeof bound === "string" && path.isAbsolute(bound) ? bound : "python3";
}

function withoutProofPythonControl(env = process.env) {
  const forwarded = { ...(env || {}) };
  delete forwarded.GROK_PROOF_PYTHON;
  return forwarded;
}

export function tempDir(prefix = "grok-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function run(command, args = [], options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    input: options.input,
    timeout: options.timeout ?? 15000,
    shell: false,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024
  });
}

export function git(cwd, ...args) {
  const result = run("git", args, { cwd });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

export function initRepo() {
  const root = tempDir("grok-plugin-repo-");
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "tests@example.com");
  git(root, "config", "user.name", "Grok Plugin Tests");
  fs.writeFileSync(path.join(root, "tracked.txt"), "original\n", "utf8");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "initial");
  return root;
}

export function testEnvironment({ fake, pluginData = tempDir("grok-plugin-data-"), sessionId = "claude-test-session", extra = {} }) {
  return {
    ...process.env,
    GROK_BIN: fake.binary,
    GROK_AUTH_PATH: fake.authPath,
    CLAUDE_PLUGIN_DATA: pluginData,
    GROK_COMPANION_HOST: "claude-code",
    GROK_COMPANION_HOST_SESSION_ID: sessionId,
    GROK_COMPANION_CLAUDE_SESSION_ID: sessionId,
    ...extra
  };
}

export function runCompanion(args, { cwd, env, timeout = 20000, input } = {}) {
  return run(process.execPath, [COMPANION, ...args], { cwd, env, timeout, input });
}

export function runCodexCompanion(args, { cwd, env, timeout = 20000, input } = {}) {
  return run(process.execPath, [CODEX_COMPANION, ...args], { cwd, env, timeout, input });
}

export function spawnNonblockingStdin(target, args, { cwd, env, timeout = 20000 } = {}) {
  const child = spawn(process.execPath, [NONBLOCKING_STDIN_CHILD, target, ...args], {
    cwd,
    env: env ?? process.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let stdinError = null;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.on("error", (error) => { stdinError = error; });

  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out waiting for nonblocking stdin child after ${timeout} ms.`));
    }, timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, stdinError });
    });
  });
  return {
    child,
    completed,
    get stdout() { return stdout; },
    get stderr() { return stderr; }
  };
}

export function runPtyStdin(target, args, { cwd, env, input, timeout = 30000 } = {}) {
  const sourceEnvironment = env ?? process.env;
  const result = run(ptyPythonCommand(sourceEnvironment), [
    ...PTY_PYTHON_FLAGS,
    PTY_STDIN_DRIVER,
    process.execPath,
    target,
    ...args
  ], {
    cwd,
    // The absolute interpreter selector is proof-runner control data, not part
    // of the product runtime contract inherited by the PTY driver or target.
    env: withoutProofPythonControl(sourceEnvironment),
    input,
    timeout
  });
  if (result.status !== 0) return { driver: result, result: null };
  try {
    return { driver: result, result: JSON.parse(result.stdout) };
  } catch {
    return { driver: result, result: null };
  }
}

export function ptyPythonAvailable({ env = process.env, timeout = 5_000 } = {}) {
  const sourceEnvironment = env ?? process.env;
  const result = run(ptyPythonCommand(sourceEnvironment), [
    ...PTY_PYTHON_FLAGS,
    "-c",
    "import pty"
  ], {
    env: withoutProofPythonControl(sourceEnvironment),
    timeout
  });
  return result.status === 0 && !result.error && !result.signal;
}

export async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}
