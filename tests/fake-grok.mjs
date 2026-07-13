#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function configFor(binary) {
  return readJson(`${binary}.config.json`, {});
}

function appendLog(config, entry) {
  if (!config.logFile) return;
  fs.appendFileSync(config.logFile, `${JSON.stringify(entry)}\n`, "utf8");
}

function nextPromptNumber(binary) {
  const file = `${binary}.counter.json`;
  const state = readJson(file, { prompts: 0 });
  state.prompts += 1;
  writeJson(file, state);
  return state.prompts;
}

function reviewValue(config) {
  return config.review ?? {
    verdict: "pass",
    summary: "No material findings in the fake review.",
    findings: []
  };
}

function reviewJson(config) {
  return JSON.stringify(reviewValue(config));
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function update(sessionId, value) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: value }
  });
}

function capabilities(config) {
  const models = config.models ?? [
    {
      modelId: "grok-test",
      _meta: { reasoningEfforts: [{ id: "low" }, { id: "medium" }, { id: "high" }] }
    }
  ];
  return {
    protocolVersion: config.protocolVersion ?? 1,
    agentCapabilities: {
      loadSession: config.loadSession ?? true
    },
    authMethods: config.authMethods ?? [{ id: "local", name: "Local test auth" }],
    _meta: { modelState: { availableModels: models } }
  };
}

async function serveAcp(binary, config) {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  let currentSession = null;
  let heldPrompt = null;

  const handle = (message) => {
    appendLog(config, { event: "rpc", message });

    if (message.method === "initialize") {
      if (config.malformedInitialize) {
        process.stdout.write("{not-json}\n");
        return;
      }
      if (config.exitOnInitialize) {
        process.exit(config.exitCode ?? 23);
      }
      send({ jsonrpc: "2.0", id: message.id, result: capabilities(config) });
      if (config.permissionRequest) {
        send({
          jsonrpc: "2.0",
          id: "fake-permission-request",
          method: "session/request_permission",
          params: {
            sessionId: "fake-session-00000001",
            options: [
              { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
              { optionId: "reject-once", kind: "reject_once", name: "Reject once" }
            ]
          }
        });
      }
      if (config.stderr) process.stderr.write(config.stderr);
      return;
    }

    if (message.method === "session/new") {
      currentSession = config.sessionId ?? "fake-session-00000001";
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: currentSession, models: {} } });
      return;
    }

    if (message.method === "session/load") {
      currentSession = message.params?.sessionId;
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: currentSession, models: {} } });
      return;
    }

    if (message.method === "session/prompt") {
      const promptNumber = nextPromptNumber(binary);
      const prompt = message.params?.prompt?.map((item) => item.text ?? "").join("") ?? "";
      appendLog(config, { event: "prompt", promptNumber, prompt, sessionId: currentSession });

      if (config.promptError) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: config.promptError } });
        return;
      }

      if (config.cancelMode === "wait") {
        heldPrompt = { id: message.id, sessionId: currentSession };
        update(currentSession, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Waiting for cancellation" }
        });
        return;
      }

      update(currentSession, { sessionUpdate: "plan", entries: [{ content: "Inspect fixture" }] });
      update(currentSession, {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Read fixture",
        status: "in_progress"
      });
      update(currentSession, { sessionUpdate: "usage_update", tokens: 12 });
      update(currentSession, { sessionUpdate: "future_event", secret: config.unknownSecret ?? "safe" });

      let text;
      if (config.invalidReviewFirst && promptNumber === 1) text = "This is not JSON.";
      else if (/review contract|review schema|required schema|valid review JSON/i.test(prompt)) text = reviewJson(config);
      else text = config.taskText ?? "Fake Grok task completed.";

      const midpoint = Math.max(1, Math.floor(text.length / 2));
      for (const chunk of [text.slice(0, midpoint), text.slice(midpoint)].filter(Boolean)) {
        update(currentSession, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: chunk }
        });
      }
      update(currentSession, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        title: "Read fixture",
        status: "completed"
      });

      const finish = () => send({
        jsonrpc: "2.0",
        id: message.id,
        result: { stopReason: config.stopReason ?? "end_turn" }
      });
      if (config.delayMs) setTimeout(finish, config.delayMs);
      else finish();
      return;
    }

    if (message.method === "session/cancel") {
      appendLog(config, { event: "cancel", sessionId: message.params?.sessionId });
      if (heldPrompt && config.cancelMode === "wait") {
        send({
          jsonrpc: "2.0",
          id: heldPrompt.id,
          result: { stopReason: "cancelled" }
        });
        heldPrompt = null;
      }
      return;
    }

    if (message.id != null) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } });
    }
  };

  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      handle(JSON.parse(line));
    }
  });
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

function stubbornDescendant(config, transport) {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});setInterval(()=>{},1000)"], {
    detached: false,
    stdio: "ignore"
  });
  child.unref();
  appendLog(config, { event: "descendant", transport, pid: child.pid, processGroupId: process.pid });
  return child;
}

async function serveHeadless(binary, config, args) {
  const promptNumber = nextPromptNumber(binary);
  const promptFile = optionValue(args, "--prompt-file");
  const prompt = promptFile ? fs.readFileSync(promptFile, "utf8") : optionValue(args, "--single") ?? "";
  const resumeSessionId = optionValue(args, "--resume");
  const structured = args.includes("--json-schema");
  const sessionId = config.headlessSessionId || resumeSessionId || optionValue(args, "--session-id") || "fake-headless-session-00000001";
  appendLog(config, { event: "headless", promptNumber, prompt, sessionId, structured, args });
  appendLog(config, { event: "prompt", promptNumber, prompt, sessionId, transport: "headless" });
  if (config.headlessSpawnStubbornDescendant) stubbornDescendant(config, "headless");

  if (config.headlessStderr) process.stderr.write(config.headlessStderr);
  if (config.headlessExitCode) {
    process.stderr.write(config.headlessError ?? "headless failure\n");
    process.exitCode = config.headlessExitCode;
    return;
  }

  if (config.headlessIgnoreSigterm) process.once("SIGTERM", () => appendLog(config, { event: "signal", signal: "SIGTERM", transport: "headless" }));
  if (config.headlessStdoutBytes) process.stdout.write("x".repeat(config.headlessStdoutBytes));
  if (config.headlessMutatePath) fs.appendFileSync(config.headlessMutatePath, config.headlessMutation || "mutated by fake Grok\n");

  if (config.headlessDelayMs) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, config.headlessDelayMs);
      if (config.headlessIgnoreSigterm) return;
      process.once("SIGTERM", () => {
        appendLog(config, { event: "signal", signal: "SIGTERM", transport: "headless" });
        clearTimeout(timer);
        process.exit(143);
      });
    });
  }

  if (config.malformedHeadless) {
    process.stdout.write("{not-json}\n");
    return;
  }

  let text = config.taskText ?? "Fake Grok headless run completed.";
  let structuredOutput;
  if (structured) {
    if (config.invalidReviewFirst && promptNumber === 1) {
      text = "This is not valid review JSON.";
      structuredOutput = { invalid: true };
    } else {
      structuredOutput = reviewValue(config);
      text = config.reviewText ?? "Structured review complete.";
    }
  }

  process.stdout.write(`${JSON.stringify({
    sessionId,
    text,
    ...(structured ? { structuredOutput } : {}),
    stopReason: config.stopReason ?? "EndTurn"
  })}\n`);
}

async function main() {
  const binary = path.resolve(process.argv[1]);
  const config = configFor(binary);
  const args = process.argv.slice(2);
  appendLog(config, { event: "argv", args });

  if (args[0] === "--version") {
    process.stdout.write(`grok ${config.version ?? "0.2.99"}\n`);
    return;
  }

  if (args[0] === "--help") {
    process.stdout.write(config.helpText ?? "Usage: grok [--prompt-file FILE] [--json-schema SCHEMA] [--tools TOOLS] [--disallowed-tools TOOLS] [--sandbox PROFILE]\n");
    return;
  }

  if (args[0] === "agent" && args[1] === "--help") {
    process.stdout.write("Usage: grok agent [--agent-profile PATH] [--no-leader] [--leader-socket PATH] stdio\n");
    return;
  }

  if (args[0] === "inspect" && args[1] === "--json") {
    appendLog(config, { event: "inspect-environment", home: process.env.HOME, grokHome: process.env.GROK_HOME, config: process.env.GROK_HOME && fs.existsSync(path.join(process.env.GROK_HOME, "config.toml")) ? fs.readFileSync(path.join(process.env.GROK_HOME, "config.toml"), "utf8") : null });
    let inspectValue = config.inspectValue;
    if (!inspectValue && config.inspectBundledSkill && process.env.GROK_HOME) {
      const skills = [
        ["bundled-test", path.join(process.env.GROK_HOME, "skills", "bundled-test", "SKILL.md")],
        ["downloaded-test", path.join(process.env.GROK_HOME, "bundled", "skills", "downloaded-test", "SKILL.md")]
      ];
      for (const [, skill] of skills) {
        fs.mkdirSync(path.dirname(skill), { recursive: true, mode: 0o700 });
        fs.writeFileSync(skill, "# Bundled test skill\n", { mode: 0o600 });
      }
      inspectValue = { hooks: [], skills: skills.map(([name, skill]) => ({ name, source: { type: "bundled", path: skill } })), plugins: [], mcpServers: [], agents: [{ name: "explore", source: { type: "builtin" } }] };
    }
    process.stdout.write(`${JSON.stringify(inspectValue ?? { hooks: [], skills: [], plugins: [], mcpServers: [], agents: [{ name: "explore", source: { type: "builtin" } }] })}\n`);
    return;
  }

  if (args[0] === "models") {
    if (config.authError) { process.stderr.write(config.authError); process.exitCode = 1; }
    else process.stdout.write("You are logged in with fake auth.\n");
    return;
  }

  if (args[0] === "sessions" && args[1] === "delete") {
    appendLog(config, { event: "delete-session", sessionId: args[2] ?? null });
    if (config.deleteSessionFails) {
      process.stderr.write("delete failed with xai-FAKESECRET000000\n");
      process.exitCode = 1;
    }
    return;
  }

  if (args[0] === "import") {
    const alias = args.at(-1);
    const input = fs.readFileSync(alias);
    appendLog(config, { event: "import-input", alias, bytes: input.length, sha256: crypto.createHash("sha256").update(input).digest("hex"), sourceInArgv: args.some((arg) => arg === config.expectedSourcePath) });
    if (config.importSpawnStubbornDescendant) stubbornDescendant(config, "import");
    if (config.importStderr) process.stderr.write(String(config.importStderr));
    if (Object.hasOwn(config, "importOutput")) {
      process.stdout.write(String(config.importOutput));
    } else if (Array.isArray(config.importRecords)) {
      for (const record of config.importRecords) process.stdout.write(`${JSON.stringify(record)}\n`);
    } else {
      const id = config.importSessionId ?? "12345678-1234-1234-1234-123456789abc";
      process.stdout.write(`${JSON.stringify({ sessionId: id })}\n`);
    }
    if (config.importExitCode) process.exitCode = config.importExitCode;
    return;
  }

  if (args.includes("--single") || args.includes("--prompt-file")) {
    await serveHeadless(binary, config, args);
    return;
  }

  if (!args.includes("agent") || !args.includes("stdio")) {
    process.stderr.write(`unexpected fake Grok arguments: ${args.join(" ")}\n`);
    process.exitCode = 2;
    return;
  }

  await serveAcp(binary, config);
}

export function installFakeGrok(directory, config = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const binary = path.join(directory, process.platform === "win32" ? "grok.cmd" : "grok.mjs");
  if (process.platform === "win32") {
    throw new Error("The deterministic fake currently targets POSIX test runners.");
  }
  fs.copyFileSync(THIS_FILE, binary);
  fs.chmodSync(binary, 0o755);
  const complete = {
    ...config,
    logFile: config.logFile ?? path.join(directory, "fake-grok.jsonl")
  };
  const authPath = path.join(directory, "auth.json");
  writeJson(authPath, {
    "https://accounts.x.ai/sign-in": {
      key: config.authSecret ?? "opaque-fake-auth-secret-00000001",
      auth_mode: "oauth",
      expires_at: "2099-01-01T00:00:00Z"
    }
  });
  fs.chmodSync(authPath, 0o600);
  writeJson(`${binary}.config.json`, complete);
  return { binary, logFile: complete.logFile, configFile: `${binary}.config.json`, authPath };
}

export function readFakeLog(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

if (path.resolve(process.argv[1] ?? "") === THIS_FILE) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
