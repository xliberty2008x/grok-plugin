import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const COMPANION = path.join(ROOT, "plugins", "grok", "scripts", "grok-companion.mjs");
export const CODEX_COMPANION = path.join(ROOT, "plugins", "grok", "scripts", "grok-codex.mjs");

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

export function runCompanion(args, { cwd, env, timeout = 20000 } = {}) {
  return run(process.execPath, [COMPANION, ...args], { cwd, env, timeout });
}

export function runCodexCompanion(args, { cwd, env, timeout = 20000 } = {}) {
  return run(process.execPath, [CODEX_COMPANION, ...args], { cwd, env, timeout });
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
