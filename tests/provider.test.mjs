import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";

import { normalizeUpdate } from "../plugins/grok/scripts/lib/acp-client.mjs";
import {
  childEnvironment,
  discoverGrok,
  grokVersion,
  openProvider,
  processStartToken,
  probe,
  cleanupReviewEnvironment,
  ensureChildExit,
  runHeadless,
  runProvider,
  runStructuredReview
} from "../plugins/grok/scripts/lib/grok-provider.mjs";
import { profileFor } from "../plugins/grok/scripts/lib/profiles.mjs";
import { hasForeignActiveProvider } from "../plugins/grok/scripts/lib/recursion-guard.mjs";
import { processGroupAlive } from "../plugins/grok/scripts/lib/process-control.mjs";
import { installFakeGrok, readFakeLog } from "./fake-grok.mjs";
import { initRepo, tempDir } from "./helpers.mjs";

async function withFake(config, callback) {
  const fixture = installFakeGrok(tempDir("fake-grok-bin-"), config);
  const previous = { binary: process.env.GROK_BIN, auth: process.env.GROK_AUTH_PATH };
  process.env.GROK_BIN = fixture.binary;
  process.env.GROK_AUTH_PATH = fixture.authPath;
  try {
    return await callback(fixture);
  } finally {
    if (previous.binary === undefined) delete process.env.GROK_BIN;
    else process.env.GROK_BIN = previous.binary;
    if (previous.auth === undefined) delete process.env.GROK_AUTH_PATH;
    else process.env.GROK_AUTH_PATH = previous.auth;
  }
}

test("normalizeUpdate maps ACP message, tool, plan, usage, and unknown updates", () => {
  assert.deepEqual(
    normalizeUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "hello" } }),
    { type: "message", text: "hello" }
  );
  assert.deepEqual(
    normalizeUpdate({ sessionUpdate: "tool_call_update", title: "Read", status: "completed" }),
    { type: "tool", name: "Read", status: "completed" }
  );
  assert.equal(normalizeUpdate({ sessionUpdate: "plan", entries: [] }).type, "plan");
  assert.equal(normalizeUpdate({ sessionUpdate: "usage_update", tokens: 4 }).type, "usage");
  assert.equal(normalizeUpdate({ sessionUpdate: "future_update", value: 1 }).type, "unknown");
});

test("Grok discovery honors GROK_BIN and enforces the minimum CLI version", async () => {
  await withFake({ version: "0.2.99" }, async (fake) => {
    assert.equal(discoverGrok(), fs.realpathSync(fake.binary));
    assert.equal(grokVersion(), "0.2.99");
  });

  await withFake({ version: "0.2.92" }, async () => {
    assert.throws(() => grokVersion(), (error) => error.code === "E_GROK_VERSION");
  });
});

test("owned process-tree cleanup refuses a forged leader start token", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  let token = null;
  for (let attempt = 0; attempt < 20 && !token; attempt += 1) {
    token = processStartToken(child.pid);
    if (!token) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(token);
  await assert.rejects(
    () => ensureChildExit(child, { pid: child.pid, processGroupId: child.pid, startToken: `${token}-forged` }, { naturalExitMs: 0 }),
    (error) => error.code === "E_PROCESS_IDENTITY"
  );
  assert.equal(processStartToken(child.pid), token);
  const closed = new Promise((resolve) => child.once("close", resolve));
  process.kill(-child.pid, "SIGKILL");
  await closed;
  assert.equal(processGroupAlive(child.pid), false);
});

test("childEnvironment strips project and provider secrets while retaining runtime essentials", () => {
  const keys = ["XAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "CLAUDE_PLUGIN_DATA", "GROK_BIN", "GROK_COMPANION_CLAUDE_SESSION_ID"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.XAI_API_KEY = "xai-abcdefghijklmnop";
    process.env.AWS_SECRET_ACCESS_KEY = "cloud-secret";
    process.env.CLAUDE_PLUGIN_DATA = "/secret/plugin/data";
    process.env.GROK_BIN = "/secret/fake";
    process.env.GROK_COMPANION_CLAUDE_SESSION_ID = "private-host-session";
    const env = childEnvironment();
    assert.equal(env.GROK_COMPANION_CHILD, "1");
    assert.equal(env.PATH, process.env.PATH);
    for (const key of keys) assert.equal(key in env, false, `${key} leaked to Grok child`);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("probe negotiates ACP v1, session loading, auth methods, models, and efforts", async () => {
  await withFake({}, async () => {
    const root = initRepo();
    const result = await probe(root, tempDir("provider-state-"));
    assert.equal(result.version, "0.2.99");
    assert.equal(result.protocolVersion, 1);
    assert.equal(result.loadSession, true);
    assert.equal(result.headlessReview.isolated, true);
    assert.ok(result.headlessReview.flags.includes("--prompt-file"));
    assert.deepEqual(result.authMethods, [{ id: "local", name: "Local test auth" }]);
    assert.deepEqual(result.models, [{ id: "grok-test", efforts: ["low", "medium", "high"] }]);
    assert.equal(hasForeignActiveProvider(root, null), false, "setup probe retained an active-provider guard");
  });
});

test("runProvider creates a session, streams normalized events, and preserves literal profile arguments", async () => {
  await withFake(
    { taskText: "Provider result", unknownSecret: "xai-abcdefghijklmnop" },
    async (fake) => {
      const root = initRepo();
      const events = [];
      const result = await runProvider({
        root,
        profile: profileFor("task", false),
        prompt: "inspect only",
        model: "grok-test",
        effort: "high",
        stateDir: tempDir("provider-state-"),
        onEvent: (event) => events.push(event)
      });

      assert.equal(result.sessionId, "fake-session-00000001");
      assert.equal(result.text, "Provider result");
      assert.equal(result.stopReason, "end_turn");
      assert.equal(result.capabilities.protocolVersion, 1);
      for (const type of ["session", "message", "plan", "tool", "usage", "unknown"]) {
        assert.ok(events.some((event) => event.type === type), `missing ${type} event`);
      }
      assert.equal(JSON.stringify(events).includes("xai-abcdefghijklmnop"), false);

      const providerLog = readFakeLog(fake.logFile);
      const invocation = providerLog.find(
        (entry) => entry.event === "argv" && entry.args.includes("agent")
      );
      assert.ok(invocation);
      assert.deepEqual(invocation.args.slice(0, 6), [
        "--cwd",
        root,
        "--sandbox",
        "read-only",
        "--permission-mode",
        "dontAsk"
      ]);
      assert.ok(invocation.args.includes("--disable-web-search"));
      assert.ok(invocation.args.includes("--no-subagents"));
      assert.equal(invocation.args.includes("--tools"), false);
      assert.equal(invocation.args.includes("--disallowed-tools"), false);
      for (const rule of ["Bash", "Edit", "Write", "MCPTool", "WebFetch"]) assert.ok(invocation.args.includes(rule), `missing deny ${rule}`);
      assert.ok(invocation.args.includes("--no-leader"));
      const agentIndex = invocation.args.indexOf("agent"), profileIndex = invocation.args.indexOf("--agent-profile");
      assert.ok(agentIndex >= 0 && profileIndex > agentIndex);
      const agentProfile = fs.readFileSync(invocation.args[profileIndex + 1], "utf8");
      assert.match(agentProfile, /injectDefaultTools: false/);
      for (const allowed of ["GrokBuild:read_file", "GrokBuild:list_dir", "GrokBuild:grep"]) assert.match(agentProfile, new RegExp(`- id: ${allowed}`));
      for (const forbidden of ["GrokBuild:run_terminal_cmd", "GrokBuild:search_replace", "GrokBuild:task", "web_search", "image_gen"]) assert.equal(agentProfile.includes(forbidden), false);
      assert.ok(invocation.args.includes("--model"));
      assert.ok(invocation.args.includes("grok-test"));
      assert.ok(invocation.args.includes("--reasoning-effort"));
      assert.ok(invocation.args.includes("high"));
      assert.equal(invocation.args.at(-1), "stdio");
      assert.equal(invocation.args.includes("explore"), false);
      assert.ok(providerLog.some((entry) => entry.event === "rpc" && entry.message.method === "initialize"));
      assert.ok(providerLog.some((entry) => entry.event === "rpc" && entry.message.method === "session/new"));
      assert.ok(providerLog.some((entry) => entry.event === "rpc" && entry.message.method === "session/prompt"));
      assert.equal(providerLog.some((entry) => entry.event === "headless"), false);
    }
  );
});

test("runProvider loads an existing session and rejects unadvertised models", async () => {
  await withFake({}, async (fake) => {
    const root = initRepo();
    const result = await runProvider({
      root,
      profile: profileFor("task", false),
      prompt: "continue",
      stateDir: tempDir("provider-state-"),
      resumeSessionId: "existing-session"
    });
    assert.equal(result.sessionId, "existing-session");
    const load = readFakeLog(fake.logFile).find(
      (entry) => entry.event === "rpc" && entry.message.method === "session/load"
    );
    assert.equal(load.message.params.sessionId, "existing-session");
  });

  await withFake({}, async () => {
    const root = initRepo();
    await assert.rejects(
      () => openProvider({
        root,
        profile: profileFor("task", false),
        model: "missing-model",
        stateDir: tempDir("provider-state-")
      }),
      (error) => error.code === "E_CAPABILITY" && error.details.available.includes("grok-test")
    );
  });

  await withFake({ models: [{ modelId: "grok-test", _meta: { reasoningEfforts: [{ id: "low" }] } }] }, async () => {
    const root = initRepo();
    await assert.rejects(
      () => openProvider({ root, profile: profileFor("task", false), model: "grok-test", effort: "high", stateDir: tempDir("provider-state-") }),
      (error) => error.code === "E_CAPABILITY" && error.details.available.includes("low")
    );
  });
});

test("ACP permission requests are answered without deadlock under the selected security profile", async () => {
  await withFake({ permissionRequest: true }, async (fake) => {
    const root = initRepo();
    await runProvider({ root, profile: profileFor("task", false), prompt: "inspect", stateDir: tempDir("provider-state-") });
    const response = readFakeLog(fake.logFile).find((entry) => entry.event === "rpc" && entry.message.id === "fake-permission-request" && entry.message.result);
    assert.equal(response.message.result.outcome.optionId, "reject-once");
  });

  await withFake({ permissionRequest: true }, async (fake) => {
    const root = initRepo();
    await runProvider({ root, profile: profileFor("task", true), prompt: "implement", stateDir: tempDir("provider-state-") });
    const response = readFakeLog(fake.logFile).find((entry) => entry.event === "rpc" && entry.message.id === "fake-permission-request" && entry.message.result);
    assert.equal(response.message.result.outcome.optionId, "allow-once");
  });
});

test("isolated ACP homes reject external discovery and redact opaque copied credentials", async () => {
  const secret = "opaque-provider-credential-value-123456";
  await withFake({ authSecret: secret, stderr: `diagnostic ${secret}\n`, unknownSecret: secret, taskText: `result ${secret}` }, async (fake) => {
    const root = initRepo(), state = tempDir("provider-state-"), events = [];
    const result = await runProvider({ root, profile: profileFor("task", false), prompt: "inspect", stateDir: state, onEvent: (event) => events.push(event) });
    assert.equal(JSON.stringify({ result, events }).includes(secret), false);
    const inspection = readFakeLog(fake.logFile).find((entry) => entry.event === "inspect-environment" && entry.config?.includes("[skills]"));
    assert.ok(inspection);
    assert.ok(inspection.home.startsWith(path.join(state, "task-homes", "rescue-read-v2")));
    assert.equal(inspection.grokHome, path.join(inspection.home, ".grok"));
    assert.ok(inspection.config.includes(fs.realpathSync(root)));
    assert.equal(fs.statSync(path.join(inspection.grokHome, "auth.json")).mode & 0o777, 0o600);
  });

  await withFake({ inspectValue: { hooks: [{ event: "SessionStart" }], skills: [], plugins: [], mcpServers: [], agents: [] } }, async () => {
    await assert.rejects(
      () => runProvider({ root: initRepo(), profile: profileFor("task", false), prompt: "inspect", stateDir: tempDir("provider-state-") }),
      (error) => error.code === "E_CAPABILITY" && /external hooks/.test(error.message)
    );
  });

  await withFake({ inspectBundledSkill: true }, async () => {
    const result = await runProvider({ root: initRepo(), profile: profileFor("task", false), prompt: "inspect", stateDir: tempDir("provider-state-") });
    assert.equal(result.sessionId, "fake-session-00000001");
  });

  await withFake({ inspectValue: { hooks: [], skills: [{ name: "external", source: { type: "user", path: "/tmp/external/SKILL.md" } }], plugins: [], mcpServers: [], agents: [] } }, async () => {
    await assert.rejects(
      () => runProvider({ root: initRepo(), profile: profileFor("task", false), prompt: "inspect", stateDir: tempDir("provider-state-") }),
      (error) => error.code === "E_CAPABILITY" && /external hooks/.test(error.message)
    );
  });
});

test("isolated headless reviews redact opaque cached credentials from diagnostics and results", async () => {
  const secret = "opaque-review-credential-value-123456";
  await withFake({ authSecret: secret, headlessStderr: `diagnostic ${secret}\n`, review: { verdict: "needs_changes", summary: secret, findings: [] } }, async () => {
    const root = initRepo(), state = tempDir("provider-state-"), events = [];
    const result = await runStructuredReview({ root, profile: profileFor("review"), prompt: "review contract", stateDir: state, jobMarker: "review-secret-test", onEvent: (event) => events.push(event) });
    assert.equal(JSON.stringify({ result, events }).includes(secret), false);
    assert.equal(result.review.summary, "[REDACTED]");
    assert.equal(cleanupReviewEnvironment(state, "review-secret-test").ok, true);
  });
});

test("provider event callback failures terminate ACP and headless children", async () => {
  await withFake({ delayMs: 60_000 }, async () => {
    const root = initRepo(), state = tempDir("provider-state-");
    let identity = null;
    await assert.rejects(
      () => runProvider({
        root,
        profile: profileFor("task", false),
        prompt: "inspect",
        stateDir: state,
        jobMarker: "task-callback-failure",
        onEvent(event) {
          if (event.type === "provider") {
            identity = event.process;
            throw new Error("simulated state callback failure");
          }
        }
      }),
      /simulated state callback failure/
    );
    assert.ok(identity);
    assert.notEqual(processStartToken(identity.pid), identity.startToken, "ACP provider survived its callback failure");
  });

  await withFake({ headlessDelayMs: 60_000 }, async () => {
    const root = initRepo(), state = tempDir("provider-state-"), marker = "review-callback-failure";
    let identity = null;
    await assert.rejects(
      () => runHeadless({
        root,
        profile: profileFor("review"),
        prompt: "review",
        stateDir: state,
        jobMarker: marker,
        onEvent(event) {
          if (event.type === "provider") {
            identity = event.process;
            throw new Error("simulated state callback failure");
          }
        }
      }),
      /simulated state callback failure/
    );
    assert.ok(identity);
    assert.notEqual(processStartToken(identity.pid), identity.startToken, "headless provider survived its callback failure");
    assert.equal(fs.existsSync(path.join(state, "review-homes", marker)), false, "callback failure retained the isolated review home");
  });
});

test("headless timeout and output overflow escalate once to a forced exit", async () => {
  await withFake({ headlessDelayMs: 60_000, headlessIgnoreSigterm: true }, async () => {
    const root = initRepo(), state = tempDir("provider-state-"), marker = "review-timeout-test";
    const started = Date.now();
    await assert.rejects(
      () => runHeadless({ root, profile: profileFor("review"), prompt: "review", stateDir: state, jobMarker: marker, timeoutMs: 600 }),
      (error) => error.code === "E_TIMEOUT"
    );
    assert.ok(Date.now() - started >= 2000 && Date.now() - started < 5000);
    assert.equal(cleanupReviewEnvironment(state, marker).ok, true);
  });

  await withFake({ headlessStdoutBytes: 2048, headlessDelayMs: 60_000, headlessIgnoreSigterm: true }, async () => {
    const root = initRepo(), state = tempDir("provider-state-"), marker = "review-output-test";
    const started = Date.now();
    await assert.rejects(
      () => runHeadless({ root, profile: profileFor("review"), prompt: "review", stateDir: state, jobMarker: marker, timeoutMs: 10_000, maxOutputBytes: 1024 }),
      (error) => error.code === "E_OUTPUT_LIMIT"
    );
    assert.ok(Date.now() - started >= 2000 && Date.now() - started < 5000);
    assert.equal(cleanupReviewEnvironment(state, marker).ok, true);
  });
});

test("headless cleanup kills a TERM-resistant same-group descendant after the leader exits", async () => {
  await withFake({ headlessDelayMs: 60_000, headlessSpawnStubbornDescendant: true }, async (fake) => {
    const root = initRepo(), state = tempDir("provider-state-");
    let providerIdentity = null;
    await assert.rejects(
      () => runHeadless({ root, profile: profileFor("review"), prompt: "review", stateDir: state, jobMarker: "review-descendant-test", timeoutMs: 400, onEvent(event) { if (event.type === "provider") providerIdentity = event.process; } }),
      (error) => error.code === "E_TIMEOUT"
    );
    const descendant = readFakeLog(fake.logFile).find((entry) => entry.event === "descendant" && entry.transport === "headless");
    assert.ok(descendant?.pid);
    assert.ok(providerIdentity?.processGroupId);
    assert.equal(processStartToken(descendant.pid), null);
    assert.equal(processGroupAlive(providerIdentity.processGroupId), false);
    assert.equal(hasForeignActiveProvider(root, null), false);
  });
});

test("structured review uses headless explore and performs one same-session repair", async () => {
  await withFake({ invalidReviewFirst: true }, async (fake) => {
    const root = initRepo();
    const result = await runStructuredReview({
      root,
      profile: profileFor("review"),
      prompt: "Grok Companion review contract v1: return review schema JSON",
      stateDir: tempDir("provider-state-")
    });
    assert.equal(result.review.verdict, "pass");
    assert.match(result.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(result.capabilities.transport, "headless");
    assert.equal(result.capabilities.agent, "explore");
    assert.match(result.capabilities.sandbox, /^companion_[a-f0-9]{20}$/);
    const entries = readFakeLog(fake.logFile);
    const reviews = entries.filter((entry) => entry.event === "headless");
    assert.equal(reviews.length, 2);
    assert.ok(reviews.every((entry) => entry.structured));
    assert.equal(entries.some((entry) => entry.event === "rpc"), false);

    const firstArgs = reviews[0].args;
    assert.equal(firstArgs[firstArgs.indexOf("--agent") + 1], "explore");
    assert.match(firstArgs[firstArgs.indexOf("--sandbox") + 1], /^companion_[a-f0-9]{20}$/);
    assert.equal(firstArgs[firstArgs.indexOf("--permission-mode") + 1], "default");
    assert.equal(firstArgs[firstArgs.indexOf("--tools") + 1], "todo_write");
    assert.ok(firstArgs.includes("MCPTool(*)"));
    assert.ok(firstArgs.includes("--no-subagents"));
    assert.ok(firstArgs.includes("--json-schema"));
    assert.ok(firstArgs.includes("--prompt-file"));
    assert.equal(firstArgs.includes("stdio"), false);

    const secondArgs = reviews[1].args;
    assert.equal(secondArgs[secondArgs.indexOf("--resume") + 1], result.sessionId);
  });
});

test("ACP process exit during initialization is surfaced as a provider error", async () => {
  await withFake({ exitOnInitialize: true, exitCode: 19 }, async () => {
    const root = initRepo();
    await assert.rejects(
      () => openProvider({
        root,
        profile: profileFor("task", false),
        stateDir: tempDir("provider-state-")
      }),
      (error) => error.code === "E_PROVIDER_EXIT" && error.details.code === 19
    );
  });
});
