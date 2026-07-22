import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { runProvider } from "../plugins/grok/scripts/lib/grok-provider.mjs";
import { processGroupGone } from "../plugins/grok/scripts/lib/process-control.mjs";
import { profileFor } from "../plugins/grok/scripts/lib/profiles.mjs";
import { hasForeignActiveProvider } from "../plugins/grok/scripts/lib/recursion-guard.mjs";
import { initRepo, tempDir } from "./helpers.mjs";

const FAKE_STARTUP_PROVIDER = String.raw`#!/usr/bin/env node
import fs from "node:fs";

const config = JSON.parse(fs.readFileSync(process.argv[1] + ".config.json", "utf8"));
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("grok 0.2.99\n");
  process.exit(0);
}
if (args[0] === "models") process.exit(0);
if (args[0] === "inspect") {
  process.stdout.write(JSON.stringify({ agents: [], skills: [], hooks: [], plugins: [], mcpServers: [] }) + "\n");
  process.exit(0);
}
if (!args.includes("agent") || !args.includes("stdio")) process.exit(2);

const keepAlive = setInterval(() => {}, 1000);
const stop = () => {
  clearInterval(keepAlive);
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.stdin.setEncoding("utf8");
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const observe = (stage) => {
  if (config.stallStage !== stage) return false;
  fs.writeFileSync(config.stageFile, stage + "\n", { mode: 0o600 });
  return true;
};
const handle = (message) => {
  if (message.method === "initialize") {
    if (observe("initialize")) return;
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: "cached_token", name: "Cached token" }],
        _meta: { modelState: { availableModels: [{ modelId: "grok-test", _meta: { reasoningEfforts: [{ id: "high" }] } }] } }
      }
    });
    return;
  }
  if (message.method === "authenticate") {
    if (observe("authenticate")) return;
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "session/new") {
    if (observe("session/new")) return;
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "fake-startup-session", models: {} } });
    return;
  }
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
};
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf("\n");
    if (end < 0) break;
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (line) handle(JSON.parse(line));
  }
});
`;

function installStartupProvider(stallStage) {
  const directory = tempDir("fake-grok-startup-cancel-");
  const binary = path.join(directory, "grok-startup.mjs");
  const stageFile = path.join(directory, "stage.txt");
  const authPath = path.join(directory, "auth.json");
  fs.writeFileSync(binary, FAKE_STARTUP_PROVIDER, { mode: 0o755 });
  fs.chmodSync(binary, 0o755);
  fs.writeFileSync(`${binary}.config.json`, `${JSON.stringify({ stallStage, stageFile })}\n`, { mode: 0o600 });
  fs.writeFileSync(authPath, `${JSON.stringify({
    "https://accounts.x.ai/sign-in": {
      key: "opaque-startup-auth-secret-00000001",
      auth_mode: "oauth",
      expires_at: "2099-01-01T00:00:00Z"
    }
  })}\n`, { mode: 0o600 });
  return { binary, stageFile, authPath };
}

async function exerciseStartupCancellation(stallStage) {
  const fake = installStartupProvider(stallStage);
  const root = initRepo();
  const stateDir = tempDir("provider-startup-cancel-state-");
  const providerHomeId = `cancel-${stallStage.replace("/", "-")}`;
  const previous = { binary: process.env.GROK_BIN, auth: process.env.GROK_AUTH_PATH };
  process.env.GROK_BIN = fake.binary;
  process.env.GROK_AUTH_PATH = fake.authPath;
  let providerIdentity = null;
  let failure = null;
  const startedAt = Date.now();
  try {
    await runProvider({
      root,
      profile: profileFor("task", false),
      prompt: "must never reach the model",
      model: "grok-test",
      effort: "high",
      stateDir,
      jobMarker: providerHomeId,
      providerHomeId,
      cancelRequested: () => fs.existsSync(fake.stageFile),
      onEvent: (event) => {
        if (event.type === "provider") providerIdentity = event.process;
      }
    });
  } catch (error) {
    failure = error;
  } finally {
    if (previous.binary === undefined) delete process.env.GROK_BIN;
    else process.env.GROK_BIN = previous.binary;
    if (previous.auth === undefined) delete process.env.GROK_AUTH_PATH;
    else process.env.GROK_AUTH_PATH = previous.auth;
  }

  const elapsedMs = Date.now() - startedAt;
  assert.equal(fs.readFileSync(fake.stageFile, "utf8").trim(), stallStage);
  assert.equal(failure?.code, "E_CANCELLED");
  assert.match(failure?.message || "", new RegExp(stallStage.replace("/", "\\/")));
  assert.ok(elapsedMs < 10_000, `startup cancellation took ${elapsedMs}ms`);
  assert.ok(providerIdentity?.startToken, "provider identity was not durably emitted before cancellation");
  assert.equal(processGroupGone(providerIdentity), true, "owned provider process group remained live");
  assert.equal(hasForeignActiveProvider(root, null), false, "provider guard remained after verified cleanup");

  const grokHome = path.join(stateDir, "task-homes", providerHomeId, ".grok");
  assert.equal(fs.existsSync(path.join(grokHome, "auth.json")), false, "staged credential remained after verified cleanup");
  assert.equal(fs.existsSync(path.join(grokHome, "agent-profiles")), false, "staged agent profile remained after verified cleanup");
}

test("cancellation interrupts a stalled ACP initialize and verifies the exact provider group gone", { skip: process.platform === "win32", timeout: 12_000 }, async () => {
  await exerciseStartupCancellation("initialize");
});

test("cancellation interrupts a stalled ACP session/new and verifies the exact provider group gone", { skip: process.platform === "win32", timeout: 12_000 }, async () => {
  await exerciseStartupCancellation("session/new");
});
