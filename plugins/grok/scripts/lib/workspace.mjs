import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CompanionError } from "./errors.mjs";

export function git(cwd, args, { allowFailure = false, encoding = "utf8", maxBuffer = 8 * 1024 * 1024 } = {}) {
  const run = spawnSync("git", args, { cwd, encoding, maxBuffer, shell: false });
  if (run.error || (!allowFailure && run.status !== 0)) throw new CompanionError("E_GIT_REQUIRED", `Git command failed: git ${args.join(" ")}`, { stderr: String(run.stderr ?? "").trim() });
  return run;
}

export function workspaceRoot(cwd = process.cwd(), required = true) {
  const real = fs.realpathSync(cwd);
  const run = git(real, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (run.status !== 0) {
    if (required) throw new CompanionError("E_GIT_REQUIRED", "Run this command inside a Git repository.");
    return real;
  }
  return fs.realpathSync(String(run.stdout).trim());
}

export function workspaceState(root) {
  const pluginData = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), ".claude", "plugins", "data", "grok");
  const hash = crypto.createHash("sha256").update(root).digest("hex").slice(0, 16);
  const slug = path.basename(root).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40) || "workspace";
  return path.join(pluginData, "state", `${slug}-${hash}`);
}

export function assertSafeJobId(id) {
  if (!/^(review|adversarial-review|task|stop-review)-[a-f0-9]{16,64}$/.test(String(id))) throw new CompanionError("E_USAGE", "Invalid job ID.");
  return id;
}
