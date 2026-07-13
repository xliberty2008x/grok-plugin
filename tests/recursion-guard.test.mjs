import assert from "node:assert/strict";
import fs from "node:fs";
import process from "node:process";
import test from "node:test";
import { spawn } from "node:child_process";

import { processStartToken } from "../plugins/grok/scripts/lib/process-control.mjs";
import { hasForeignActiveProvider, registerProviderGuard, unregisterProviderGuard } from "../plugins/grok/scripts/lib/recursion-guard.mjs";
import { tempDir, waitFor } from "./helpers.mjs";

test("active-provider guards distinguish the owning Claude session and remove stale providers", { skip: process.platform === "win32" }, async () => {
  const root = tempDir("grok-recursion-guard-");
  const marker = "task-0123456789abcdef01234567";
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", marker, "agent", "stdio"], {
    detached: true,
    stdio: "ignore"
  });
  let identity;
  try {
    const startToken = await waitFor(() => processStartToken(child.pid));
    identity = { pid: child.pid, startToken, processGroupId: child.pid };
    registerProviderGuard(root, marker, identity, "claude-owner");
    assert.equal(hasForeignActiveProvider(root, "claude-owner"), false);
    assert.equal(hasForeignActiveProvider(root, "different-session"), true);
    assert.equal(hasForeignActiveProvider(root, null), true);

    process.kill(-child.pid, "SIGKILL");
    await waitFor(() => processStartToken(child.pid) !== startToken);
    assert.equal(hasForeignActiveProvider(root, null), true, "unowned sandbox invocation did not fail closed on a recent guard");
    assert.equal(hasForeignActiveProvider(root, "claude-owner"), false, "owner could not clear its stale provider guard");
    assert.equal(hasForeignActiveProvider(root, null), false, "stale provider guard was not removed");
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    unregisterProviderGuard(root, marker);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
