import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { identityMatches, isGrokProcessCommand, processStartToken } from "../plugins/grok/scripts/lib/process-control.mjs";
import { waitFor } from "./helpers.mjs";

test("Grok ancestor classification recognizes official CLI launch forms", () => {
  for (const command of [
    "/Users/example/.grok/bin/grok agent stdio",
    "/Users/example/.grok/downloads/grok-0.2.99-macos-aarch64 agent stdio",
    "grok --prompt-file /tmp/prompt.md --single",
    "C:\\Users\\example\\AppData\\Roaming\\npm\\node_modules\\@xai-official\\grok\\dist\\cli.js agent stdio"
  ]) {
    assert.equal(isGrokProcessCommand(command), true, command);
  }
});

test("Grok ancestor classification rejects unrelated commands", () => {
  for (const command of [
    "/usr/bin/node /workspace/grok-companion.mjs setup",
    "/bin/sh -c echo grok",
    "/usr/bin/python /workspace/grok_review.py"
  ]) {
    assert.equal(isGrokProcessCommand(command), false, command);
  }
});

test("import identity kind matches live grok import --json process commands", { skip: process.platform === "win32" }, async () => {
  const marker = "transfer-import-identity-marker";
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "import", "--json", marker], {
    detached: true,
    stdio: "ignore"
  });
  try {
    const startToken = await waitFor(() => processStartToken(child.pid));
    const identity = { pid: child.pid, startToken, processGroupId: child.pid };
    assert.equal(identityMatches(identity, marker, "import"), true);
    assert.equal(identityMatches(identity, marker, "provider"), false, "import processes must not match the ACP/headless provider matcher");
    assert.equal(identityMatches(identity, "wrong-marker", "import"), false);
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
});

test("ancestor marker survives a child unsetting its own companion environment", { skip: process.platform === "win32" }, () => {
  const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugins/grok/scripts/lib/process-control.mjs");
  const childSource = `import { hasGrokAncestor } from ${JSON.stringify(pathToFileURL(modulePath).href)}; process.stdout.write(String(hasGrokAncestor()));`;
  const parentSource = [
    `const { spawnSync } = require("node:child_process");`,
    `const env = { ...process.env };`,
    `delete env.GROK_COMPANION_CHILD;`,
    `delete env.GROK_COMPANION_JOB_MARKER;`,
    `const child = spawnSync(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(childSource)}], { env, encoding: "utf8" });`,
    `process.stdout.write(child.stdout);`,
    `process.stderr.write(child.stderr);`,
    `process.exitCode = child.status ?? 1;`
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", parentSource], {
    encoding: "utf8",
    env: { ...process.env, GROK_COMPANION_JOB_MARKER: "ancestor-test" }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "true");
});
