import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { spawn } from "node:child_process";

import {
  processCommand,
  processGroupAlive,
  processStartToken,
  systemPsBinary,
  terminateOwnedProcess
} from "../plugins/grok/scripts/lib/process-control.mjs";
import { tempDir, waitFor } from "./helpers.mjs";

async function stopGroup(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  try {
    await waitFor(
      () => processStartToken(child.pid) === null && !processGroupAlive(child.pid),
      { timeoutMs: 5_000, intervalMs: 20 }
    );
  } catch {}
}

test("process identity probes ignore a PATH-prepended fake ps", {
  skip: process.platform === "win32"
}, async (t) => {
  const marker = "trusted-system-ps-regression";
  const child = spawn(process.execPath, [
    "-e",
    "setInterval(() => {}, 1000);",
    marker
  ], { detached: true, stdio: "ignore" });
  t.after(() => stopGroup(child));
  const poison = tempDir("fake-ps-path-");
  const invoked = path.join(poison, "invoked");
  const fakePs = path.join(poison, "ps");
  fs.writeFileSync(fakePs, [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(invoked)}, 'ambient ps was invoked');`,
    "process.stdout.write('forged-process-identity\\n');"
  ].join("\n"), { mode: 0o700 });
  t.after(() => fs.rmSync(poison, { recursive: true, force: true }));
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = `${poison}${path.delimiter}${previousPath || ""}`;
    const token = await waitFor(() => processStartToken(child.pid));
    assert.notEqual(token, "forged-process-identity");
    assert.match(processCommand(child.pid), new RegExp(marker));
    assert.equal(path.isAbsolute(systemPsBinary()), true);
    assert.equal(fs.existsSync(invoked), false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("owned cleanup rejects a corrupted guard PGID without signaling either process group", {
  skip: process.platform === "win32"
}, async (t) => {
  const marker = "corrupted-provider-guard-regression";
  const owned = spawn(process.execPath, [
    "-e",
    "setInterval(() => {}, 1000);",
    "agent",
    marker,
    "stdio"
  ], { detached: true, stdio: "ignore" });
  const unrelated = spawn(process.execPath, [
    "-e",
    "setInterval(() => {}, 1000);"
  ], { detached: true, stdio: "ignore" });
  t.after(async () => {
    await Promise.all([stopGroup(owned), stopGroup(unrelated)]);
  });

  const ownedStartToken = await waitFor(() => processStartToken(owned.pid));
  const unrelatedStartToken = await waitFor(() => processStartToken(unrelated.pid));
  assert.equal(processGroupAlive(owned.pid), true);
  assert.equal(processGroupAlive(unrelated.pid), true);

  const corruptedGuardIdentity = {
    pid: owned.pid,
    startToken: ownedStartToken,
    processGroupId: unrelated.pid
  };
  await assert.rejects(
    () => terminateOwnedProcess(corruptedGuardIdentity, marker, "provider", {
      termTimeoutMs: 50,
      killTimeoutMs: 50,
      pollMs: 5
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );

  assert.equal(processStartToken(owned.pid), ownedStartToken, "owned process must not be signaled");
  assert.equal(processStartToken(unrelated.pid), unrelatedStartToken, "corrupted PGID target must not be signaled");
  assert.equal(processGroupAlive(owned.pid), true);
  assert.equal(processGroupAlive(unrelated.pid), true);
});

test("owned cleanup rejects incomplete or redacted identities before signaling", {
  skip: process.platform === "win32"
}, async (t) => {
  const marker = "malformed-provider-identity-regression";
  const child = spawn(process.execPath, [
    "-e",
    "setInterval(() => {}, 1000);",
    "agent",
    marker,
    "stdio"
  ], { detached: true, stdio: "ignore" });
  t.after(() => stopGroup(child));
  const startToken = await waitFor(() => processStartToken(child.pid));

  const malformed = [
    { pid: String(child.pid), startToken, processGroupId: child.pid },
    { pid: child.pid, startToken: "", processGroupId: child.pid },
    { pid: child.pid, startToken: " [REDACTED] ", processGroupId: child.pid },
    { pid: child.pid, startToken: "x".repeat(257), processGroupId: child.pid },
    { pid: child.pid, startToken },
    { pid: child.pid, startToken, processGroupId: null }
  ];
  for (const identity of malformed) {
    await assert.rejects(
      () => terminateOwnedProcess(identity, marker, "provider"),
      (error) => error?.code === "E_PROCESS_IDENTITY"
    );
    assert.equal(processStartToken(child.pid), startToken, "malformed identity must not signal the live process");
  }
});

test("owned cleanup retains verified TERM-to-KILL escalation for a valid detached identity", {
  skip: process.platform === "win32"
}, async (t) => {
  const marker = "valid-provider-kill-escalation";
  const child = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);",
    "agent",
    marker,
    "stdio"
  ], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => stopGroup(child));
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", resolve);
  });
  const startToken = await waitFor(() => processStartToken(child.pid));
  const identity = { pid: child.pid, startToken, processGroupId: child.pid };

  assert.equal(await terminateOwnedProcess(identity, marker, "provider", {
    termTimeoutMs: 50,
    killTimeoutMs: 2_000,
    pollMs: 10
  }), true);
  await waitFor(() => !processGroupAlive(child.pid), { timeoutMs: 5_000, intervalMs: 20 });
  assert.equal(processStartToken(child.pid), null);
});
