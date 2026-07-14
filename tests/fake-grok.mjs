#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);

/** True when this file is the process entrypoint (realpath-safe for macOS /var vs /private/var). */
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(THIS_FILE);
  } catch {
    return path.resolve(process.argv[1]) === THIS_FILE;
  }
}

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
  const value = config.review ?? {
    summary: "No material findings in the fake review.",
    findings: []
  };
  if (config.preserveReviewVerdict) return value;
  const { verdict: _ignored, ...providerPayload } = value;
  return providerPayload;
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
        if (config.initializeStderr) process.stderr.write(String(config.initializeStderr));
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
            options: Array.isArray(config.permissionOptions)
              ? config.permissionOptions
              : [
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

      const promptError = Array.isArray(config.promptErrors)
        ? config.promptErrors[promptNumber - 1]
        : config.promptError;
      if (promptError) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: promptError } });
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

      // Optional interim chatter before tools complete (must not contaminate final report).
      if (config.interimText) {
        update(currentSession, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: String(config.interimText) }
        });
      }

      update(currentSession, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        title: "Read fixture",
        status: "completed"
      });

      if (config.taskMutatePath && (!config.taskMutateOnPrompt || config.taskMutateOnPrompt === promptNumber)) {
        fs.writeFileSync(config.taskMutatePath, config.taskMutation || "mutated by fake Grok task\n");
      }

      let text;
      if (config.invalidReviewFirst && promptNumber === 1) text = "This is not JSON.";
      else if (/review contract|review schema|required schema|valid review JSON/i.test(prompt)) text = reviewJson(config);
      else if (Array.isArray(config.taskTexts) && config.taskTexts.length) {
        text = config.taskTexts[Math.min(promptNumber - 1, config.taskTexts.length - 1)];
      } else text = config.taskText ?? "Fake Grok task completed.";

      const midpoint = Math.max(1, Math.floor(text.length / 2));
      for (const chunk of [text.slice(0, midpoint), text.slice(midpoint)].filter(Boolean)) {
        update(currentSession, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: chunk }
        });
      }
      if (config.toolAfterFinal) {
        update(currentSession, {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-after-final",
          title: "Trailing provider bookkeeping",
          status: "completed"
        });
      }

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
  if (config.headlessLockHome && process.env.HOME) {
    // Leave an undeletable nested path so isolated-home cleanup fails after the review.
    const nest = path.join(process.env.HOME, "undeletable-cleanup");
    fs.mkdirSync(nest, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(nest, "locked"), "locked by fake Grok\n", { mode: 0o600 });
    fs.chmodSync(nest, 0o000);
  }

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
  // Prefer realpath so config/log files resolve under macOS /var → /private/var.
  let binary = path.resolve(process.argv[1]);
  try { binary = fs.realpathSync(binary); } catch {}
  const config = configFor(binary);
  // installFakeGrok writes `${argvPath}.config.json`; fall back when realpath form differs.
  const configFromArgv = !Object.keys(config).length && process.argv[1]
    ? configFor(path.resolve(process.argv[1]))
    : null;
  const effective = configFromArgv && Object.keys(configFromArgv).length ? configFromArgv : config;
  const args = process.argv.slice(2);
  appendLog(effective, { event: "argv", args });

  if (args[0] === "--version") {
    process.stdout.write(`grok ${effective.version ?? "0.2.99"}\n`);
    return;
  }

  if (args[0] === "--help") {
    process.stdout.write(effective.helpText ?? "Usage: grok [--prompt-file FILE] [--json-schema SCHEMA] [--tools TOOLS] [--disallowed-tools TOOLS] [--sandbox PROFILE]\n");
    return;
  }

  if (args[0] === "agent" && args[1] === "--help") {
    process.stdout.write("Usage: grok agent [--agent-profile PATH] [--no-leader] [--leader-socket PATH] stdio\n");
    return;
  }

  if (args[0] === "inspect" && args[1] === "--json") {
    const authFile = process.env.GROK_HOME ? path.join(process.env.GROK_HOME, "auth.json") : null;
    appendLog(effective, { event: "inspect-environment", home: process.env.HOME, grokHome: process.env.GROK_HOME, config: process.env.GROK_HOME && fs.existsSync(path.join(process.env.GROK_HOME, "config.toml")) ? fs.readFileSync(path.join(process.env.GROK_HOME, "config.toml"), "utf8") : null, authExists: Boolean(authFile && fs.existsSync(authFile)), authMode: authFile && fs.existsSync(authFile) ? fs.statSync(authFile).mode & 0o777 : null });
    let inspectValue = effective.inspectValue;
    if (!inspectValue && effective.inspectBundledSkill && process.env.GROK_HOME) {
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
    appendLog(effective, {
      event: "models",
      home: process.env.HOME || null,
      userProfile: process.env.USERPROFILE || null,
      grokHome: process.env.GROK_HOME || null
    });
    if (effective.authError) {
      process.stderr.write(effective.authError);
      process.exitCode = 1;
      return;
    }
    if (Object.hasOwn(effective, "modelsText")) {
      process.stdout.write(String(effective.modelsText));
      return;
    }
    const models = effective.models ?? [
      {
        modelId: "grok-test",
        _meta: { reasoningEfforts: [{ id: "low" }, { id: "medium" }, { id: "high" }] }
      }
    ];
    const defaultId = effective.defaultModel
      || models.find((item) => item.default || item.isDefault)?.modelId
      || models[0]?.modelId
      || "grok-test";
    process.stdout.write("You are logged in with fake auth.\n\n");
    process.stdout.write(`Default model: ${defaultId}\n\n`);
    process.stdout.write("Available models:\n");
    for (const model of models) {
      const id = model.modelId || model.id;
      if (!id) continue;
      const efforts = (model._meta?.reasoningEfforts || model.efforts || [])
        .map((item) => (typeof item === "string" ? item : item?.id))
        .filter(Boolean);
      const marker = id === defaultId ? "*" : "-";
      const defaultLabel = id === defaultId ? " (default)" : "";
      const effortLabel = efforts.length ? ` efforts=${efforts.join(",")}` : "";
      process.stdout.write(`  ${marker} ${id}${defaultLabel}${effortLabel}\n`);
    }
    return;
  }

  if (args[0] === "sessions" && args[1] === "list") {
    const store = readJson(`${binary}.sessions.json`, { sessions: [] });
    const now = Date.now();
    const visible = (store.sessions || []).filter((entry) => {
      if (!entry?.id) return false;
      if (entry.neverReady) return false;
      if (typeof entry.readyAt === "number" && entry.readyAt > now) return false;
      return true;
    });
    appendLog(effective, {
      event: "sessions-list",
      home: process.env.HOME || null,
      grokHome: process.env.GROK_HOME || null,
      count: visible.length,
      sessionIds: visible.map((entry) => entry.id)
    });
    process.stdout.write("SESSION ID                            CREATED     UPDATED     STATUS      SUMMARY\n");
    for (const entry of visible) {
      process.stdout.write(`${entry.id}  2026-07-14  2026-07-14  local  imported\n`);
    }
    return;
  }

  if (args[0] === "sessions" && args[1] === "delete") {
    appendLog(effective, { event: "delete-session", sessionId: args[2] ?? null });
    const store = readJson(`${binary}.sessions.json`, { sessions: [] });
    store.sessions = (store.sessions || []).filter((entry) => entry?.id !== args[2]);
    writeJson(`${binary}.sessions.json`, store);
    if (effective.deleteSessionFails) {
      process.stderr.write("delete failed with xai-FAKESECRET000000\n");
      process.exitCode = 1;
    }
    return;
  }

  if (args[0] === "import") {
    // Hang before alias I/O so the fixture deterministically outlives parent
    // GROK_COMPANION_TEST_IMPORT_TIMEOUT_MS until the parent signals this process.
    if (effective.importHang) {
      appendLog(effective, { event: "import-hang" });
      await new Promise(() => {
        setInterval(() => {}, 60_000);
      });
      return;
    }
    const alias = args.at(-1);
    if (effective.importAppendSourcePath) {
      fs.appendFileSync(effective.importAppendSourcePath, effective.importAppendText || "APPENDED_AFTER_TRANSFER_STARTED\n");
    }
    const input = fs.readFileSync(alias);
    appendLog(effective, {
      event: "import-input",
      alias,
      bytes: input.length,
      sha256: crypto.createHash("sha256").update(input).digest("hex"),
      sourceInArgv: args.some((arg) => arg === effective.expectedSourcePath),
      home: process.env.HOME || null,
      grokHome: process.env.GROK_HOME || null
    });
    if (effective.importSpawnStubbornDescendant) stubbornDescendant(effective, "import");
    if (effective.importStderr) process.stderr.write(String(effective.importStderr));
    let importedId = null;
    if (Object.hasOwn(effective, "importOutput")) {
      process.stdout.write(String(effective.importOutput));
      try {
        const parsed = JSON.parse(String(effective.importOutput).split(/\r?\n/).find(Boolean) || "{}");
        importedId = parsed.sessionId || parsed.session_id || parsed.grokSessionId || parsed.grok_session_id || null;
      } catch {}
    } else if (Array.isArray(effective.importRecords)) {
      for (const record of effective.importRecords) process.stdout.write(`${JSON.stringify(record)}\n`);
      for (const record of effective.importRecords) {
        importedId = record.sessionId || record.session_id || record.grokSessionId || record.grok_session_id || importedId;
      }
    } else {
      const id = effective.importSessionId ?? "12345678-1234-1234-1234-123456789abc";
      importedId = id;
      process.stdout.write(`${JSON.stringify({ sessionId: id })}\n`);
    }
    // Register imported session for readiness checks. Never store transcript content.
    if (importedId && !effective.importExitCode) {
      const store = readJson(`${binary}.sessions.json`, { sessions: [] });
      const readyDelayMs = Number(effective.importReadyAfterMs);
      const entry = {
        id: importedId,
        readyAt: Number.isFinite(readyDelayMs) && readyDelayMs > 0 ? Date.now() + readyDelayMs : Date.now(),
        neverReady: Boolean(effective.importNeverReady)
      };
      store.sessions = [...(store.sessions || []).filter((item) => item?.id !== importedId), entry];
      writeJson(`${binary}.sessions.json`, store);
      appendLog(effective, {
        event: "import-session-registered",
        sessionId: importedId,
        readyAt: entry.readyAt,
        neverReady: entry.neverReady
      });
    }
    if (effective.importPoisonAlias) {
      // Replace the private descriptor alias with a non-empty directory so post-import unlink fails.
      try { fs.unlinkSync(alias); } catch {}
      try {
        fs.mkdirSync(alias, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(alias, "poison"), "import alias cleanup must fail\n", { mode: 0o600 });
      } catch {}
    }
    if (effective.importExitCode) process.exitCode = effective.importExitCode;
    return;
  }

  if (args.includes("--single") || args.includes("--prompt-file")) {
    await serveHeadless(binary, effective, args);
    return;
  }

  if (!args.includes("agent") || !args.includes("stdio")) {
    process.stderr.write(`unexpected fake Grok arguments: ${args.join(" ")}\n`);
    process.exitCode = 2;
    return;
  }

  const profileIndex = args.indexOf("--agent-profile");
  const profilePath = profileIndex >= 0 ? args[profileIndex + 1] : null;
  const grokHome = process.env.GROK_HOME || null;
  let profileEvidence = {
    event: "agent-profile",
    path: profilePath,
    grokHome,
    exists: false,
    insideGrokHome: false,
    mode: null,
    sha256: null
  };
  if (profilePath) {
    try {
      const actualProfile = fs.realpathSync(profilePath);
      const actualHome = grokHome ? fs.realpathSync(grokHome) : null;
      const relative = actualHome ? path.relative(actualHome, actualProfile) : null;
      const bytes = fs.readFileSync(actualProfile);
      profileEvidence = {
        ...profileEvidence,
        path: actualProfile,
        grokHome: actualHome,
        exists: true,
        insideGrokHome: Boolean(actualHome && relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)),
        mode: fs.statSync(actualProfile).mode & 0o777,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex")
      };
    } catch {}
  }
  appendLog(effective, profileEvidence);
  if (effective.requireAgentProfileUnderGrokHome && (!profileEvidence.exists || !profileEvidence.insideGrokHome)) {
    process.stderr.write(`error: --agent-profile path '${profilePath || ""}': Operation not permitted (os error 1)\n`);
    process.exitCode = 1;
    return;
  }

  await serveAcp(binary, effective);
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

if (isMainModule()) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
