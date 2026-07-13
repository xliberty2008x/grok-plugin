import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  identityMatches,
  isGrokProcessCommand,
  processGroupAlive,
  processGroupGone,
  processStartToken
} from "../plugins/grok/scripts/lib/process-control.mjs";
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

test("processGroupGone stays false while the group is live even if the leader token mismatches", { skip: process.platform === "win32" }, async (t) => {
  // Locks fail-closed ordering: processGroupAlive is checked before any token comparison.
  // A live process at pid with a forged startToken must never be treated as group-gone.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore"
  });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} });
  await waitFor(() => processStartToken(child.pid));
  const liveToken = processStartToken(child.pid);
  assert.ok(liveToken);
  assert.equal(processGroupAlive(child.pid), true);

  const mismatched = {
    pid: child.pid,
    startToken: `${liveToken}-forged-mismatch`,
    processGroupId: child.pid
  };
  assert.notEqual(processStartToken(mismatched.pid), mismatched.startToken);
  assert.equal(processGroupAlive(mismatched.processGroupId), true);
  assert.equal(processGroupGone(mismatched), false, "token mismatch must not short-circuit while the group is live");

  const missingToken = {
    pid: child.pid,
    startToken: null,
    processGroupId: child.pid
  };
  assert.equal(processGroupGone(missingToken), false, "missing leader token must not report gone while the group is live");
});

test("processGroupGone stays false for a dead leader with a live same-group descendant", { skip: process.platform === "win32" }, async (t) => {
  // Preserves the orphan-descendant case: leader exit alone is not group-gone.
  const leader = spawn(process.execPath, ["-e", [
    "const {spawn}=require('node:child_process');",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
    "child.unref();",
    "console.log('ready');",
    "setTimeout(()=>process.exit(0),50);"
  ].join("")], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const processGroupId = leader.pid;
  const leaderPid = leader.pid;
  t.after(() => { try { process.kill(-processGroupId, "SIGKILL"); } catch {} });
  await new Promise((resolve, reject) => {
    leader.once("error", reject);
    leader.stdout.once("data", resolve);
  });
  const startToken = await waitFor(() => processStartToken(leaderPid));
  await waitFor(() => processStartToken(leaderPid) === null && processGroupAlive(processGroupId), { timeoutMs: 5000 });
  assert.equal(processGroupAlive(processGroupId), true);
  assert.equal(processStartToken(leaderPid), null);
  assert.equal(
    processGroupGone({ pid: leaderPid, startToken, processGroupId }),
    false,
    "dead leader with live descendants must not report group-gone"
  );
});

test("processGroupGone is true only after the recorded group is empty", { skip: process.platform === "win32" }, () => {
  // Empty group + absent leader PID: token mismatch/absence may then report gone.
  const identity = {
    pid: 999999999,
    startToken: "stale-leader-token",
    processGroupId: 999999999
  };
  assert.equal(processGroupAlive(identity.processGroupId), false);
  assert.equal(processStartToken(identity.pid), null);
  assert.equal(processGroupGone(identity), true);
  assert.equal(processGroupGone({ pid: null }), true);
  assert.equal(processGroupGone(null), true);
});
