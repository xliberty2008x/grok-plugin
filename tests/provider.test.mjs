import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { normalizeUpdate } from "../plugins/grok/scripts/lib/acp-client.mjs";
import {
  captureSpawnIdentity,
  childEnvironment,
  discoverGrok,
  grokVersion,
  openProvider,
  providerCleanupIdentity,
  processStartToken,
  probe,
  cleanupReviewEnvironment,
  gatedCleanupReviewEnvironment,
  ensureChildExit,
  runHeadless,
  runProvider,
  runStructuredReview,
  REVIEW_SCHEMA,
  selectAcpPermissionOption,
  validateReview
} from "../plugins/grok/scripts/lib/grok-provider.mjs";
import { profileFor } from "../plugins/grok/scripts/lib/profiles.mjs";
import { hasForeignActiveProvider, loadProviderGuard, registerProviderGuard, unregisterProviderGuard } from "../plugins/grok/scripts/lib/recursion-guard.mjs";
import { processGroupAlive, processGroupGone } from "../plugins/grok/scripts/lib/process-control.mjs";
import { CompanionError } from "../plugins/grok/scripts/lib/errors.mjs";
import { installFakeGrok, readFakeLog } from "./fake-grok.mjs";
import { initRepo, tempDir, waitFor } from "./helpers.mjs";

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

test("bound provider startup refuses an already-pending intent without spawning a bootstrap", async () => {
  await withFake({}, async () => {
    const root = initRepo();
    const home = tempDir("provider-pending-home-");
    const grokHome = path.join(home, ".grok");
    let bootstrapSpawns = 0;
    let noChildPublications = 0;
    await assert.rejects(
      () => openProvider({
        root,
        profile: profileFor("task", false),
        stateDir: tempDir("provider-state-"),
        jobMarker: "task-aabbccddeeff0011",
        environment: {
          grokHome,
          env: childEnvironment({ HOME: home, USERPROFILE: home, GROK_HOME: grokHome }),
          knownSecrets: []
        },
        guardBinding: {
          controlWorkspaceId: "control-workspace-placeholder",
          executionRoot: root,
          dispatchAttemptId: "b".repeat(32),
          dispatchFence: 1,
          providerGeneration: 1
        },
        providerLaunch: {
          prepare: () => ({
            prepared: false,
            reason: "already-pending",
            intent: {
              status: "pending",
              intentId: "c".repeat(32),
              providerGeneration: 1
            }
          }),
          noChild: () => { noChildPublications += 1; }
        },
        testHooks: {
          afterBootstrapSpawned: () => { bootstrapSpawns += 1; }
        }
      }),
      (error) => error?.code === "E_PROCESS_IDENTITY"
    );
    assert.equal(bootstrapSpawns, 0);
    assert.equal(noChildPublications, 0, "a foreign pending intent must not be settled by this caller");
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

test("spawn identity acquisition stops untracked providers and preserves live-group cleanup identity", async () => {
  const signals = [];
  let failure;
  try {
    await captureSpawnIdentity({ pid: 424242 }, {
      timeoutMs: 0,
      shutdownTimeoutMs: 0,
      readStartToken: () => null,
      isGroupAlive: () => true,
      signalGroup: (_pid, signal) => signals.push(signal)
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, "E_PROCESS_IDENTITY");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(providerCleanupIdentity(failure), {
    pid: 424242,
    startToken: null,
    processGroupId: 424242
  });

  let stoppedFailure;
  try {
    await captureSpawnIdentity({ pid: 434343 }, {
      timeoutMs: 0,
      shutdownTimeoutMs: 0,
      readStartToken: () => null,
      isGroupAlive: () => false,
      signalGroup: () => {}
    });
  } catch (error) {
    stoppedFailure = error;
  }
  assert.equal(stoppedFailure?.code, "E_PROCESS_IDENTITY");
  assert.equal(providerCleanupIdentity(stoppedFailure), null, "stopped provider should not retain cleanup identity");
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
  await withFake({}, async (fake) => {
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
    assert.equal(result.acpIsolation.isolated, true);
    assert.equal(result.acpIsolation.sandbox, "read-only");
    assert.equal(result.acpIsolation.permissionMode, "dontAsk");
    assert.equal(result.acpIsolation.injectDefaultTools, false);
    assert.equal(result.acpIsolation.unattendedPrivilegeExpansion, false);
    assert.match(result.acpIsolation.agentProfileDigest, /^[a-f0-9]{64}$/);

    const invocation = readFakeLog(fake.logFile).find((entry) => entry.event === "argv" && entry.args.includes("agent") && entry.args.includes("stdio"));
    assert.ok(invocation, "setup probe did not launch ACP stdio");
    assert.equal(invocation.args[invocation.args.indexOf("--sandbox") + 1], "read-only");
    assert.equal(invocation.args[invocation.args.indexOf("--permission-mode") + 1], "dontAsk");
    assert.equal(invocation.args.includes("--always-approve"), false, "setup probe must not expand unattended privileges");
    const profileIndex = invocation.args.indexOf("--agent-profile");
    assert.ok(profileIndex >= 0, "setup probe must use a digest-pinned --agent-profile");
    const profileEvidence = readFakeLog(fake.logFile).find((entry) => entry.event === "agent-profile");
    assert.ok(profileEvidence?.exists, "setup probe profile was not readable by the provider");
    assert.equal(profileEvidence.insideGrokHome, true, "setup probe profile must be materialized inside isolated GROK_HOME");
    assert.equal(profileEvidence.mode, 0o600);
    assert.match(path.basename(profileEvidence.path), /^setup-probe-v2-[a-f0-9]{64}-[a-f0-9]{16}\.md$/);
    assert.equal(profileEvidence.sha256, result.acpIsolation.agentProfileDigest);
    assert.equal(fs.existsSync(profileEvidence.path), false, "setup profile remained after verified provider exit");
    for (const rule of ["Bash", "Edit", "Write", "MCPTool", "WebFetch"]) assert.ok(invocation.args.includes(rule), `setup probe missing deny ${rule}`);
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
      assert.deepEqual(invocation.args.slice(0, 2), ["--cwd", root]);
      assert.match(invocation.args[invocation.args.indexOf("--sandbox") + 1], /^companion_[a-f0-9]{20}$/);
      assert.equal(invocation.args[invocation.args.indexOf("--permission-mode") + 1], "dontAsk");
      assert.ok(invocation.args.includes("--disable-web-search"));
      assert.ok(invocation.args.includes("--no-subagents"));
      assert.equal(invocation.args.includes("--tools"), false);
      assert.equal(invocation.args.includes("--disallowed-tools"), false);
      for (const rule of ["Bash", "Edit", "Write", "MCPTool", "WebFetch"]) assert.ok(invocation.args.includes(rule), `missing deny ${rule}`);
      assert.ok(invocation.args.includes("--no-leader"));
      const agentIndex = invocation.args.indexOf("agent"), profileIndex = invocation.args.indexOf("--agent-profile");
      assert.ok(agentIndex >= 0 && profileIndex > agentIndex);
      const profileEvidence = providerLog.find((entry) => entry.event === "agent-profile");
      assert.equal(profileEvidence?.insideGrokHome, true, "task profile must be materialized inside isolated GROK_HOME");
      assert.equal(profileEvidence?.mode, 0o600);
      assert.equal(path.basename(profileEvidence?.path || ""), path.basename(invocation.args[profileIndex + 1]));
      assert.equal(profileEvidence?.sha256, profileFor("task", false).agentProfileDigest);
      assert.equal(fs.existsSync(profileEvidence.path), false, "task profile remained after verified provider exit");
      const agentProfile = fs.readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugins/grok/provider-agents/rescue-read.md"),
        "utf8"
      );
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
      () => runProvider({
        root,
        profile: profileFor("task", false),
        prompt: "inspect",
        model: "missing-model",
        stateDir: tempDir("provider-state-")
      }),
      (error) => error.code === "E_CAPABILITY" && error.details.available.includes("grok-test")
    );
  });

  await withFake({ models: [{ modelId: "grok-test", _meta: { reasoningEfforts: [{ id: "low" }] } }] }, async () => {
    const root = initRepo();
    await assert.rejects(
      () => runProvider({ root, profile: profileFor("task", false), prompt: "inspect", model: "grok-test", effort: "high", stateDir: tempDir("provider-state-") }),
      (error) => error.code === "E_CAPABILITY" && error.details.available.includes("low")
    );
  });
});

test("materialized task profile is removed after provider initialization failure", async () => {
  const secret = "opaque-provider-diagnostic-secret";
  await withFake({
    authSecret: secret,
    exitOnInitialize: true,
    exitCode: 23,
    initializeStderr: `authentication denied for ${secret}\n`
  }, async (fake) => {
    const root = initRepo();
    await assert.rejects(
      () => runProvider({
        root,
        profile: profileFor("task", false),
        prompt: "inspect",
        stateDir: tempDir("provider-profile-cleanup-state-")
      }),
      (error) => {
        assert.equal(error?.code, "E_PROVIDER_EXIT");
        assert.equal(error?.details?.code, 23);
        assert.match(String(error?.details?.stderr || ""), /authentication denied/);
        assert.equal(JSON.stringify(error?.details).includes(secret), false);
        assert.ok(String(error?.details?.stderr || "").length <= 32_768);
        return true;
      }
    );
    const profileEvidence = readFakeLog(fake.logFile).find((entry) => entry.event === "agent-profile");
    assert.ok(profileEvidence?.exists, "provider never observed the staged profile");
    assert.equal(profileEvidence.insideGrokHome, true);
    assert.equal(fs.existsSync(profileEvidence.path), false, "staged profile remained after initialization failure");
  });
});

test("direct ACP startup fails closed without an isolated GROK_HOME", async () => {
  await withFake({}, async () => {
    const root = initRepo();
    await assert.rejects(
      () => openProvider({ root, profile: profileFor("task", false), stateDir: tempDir("provider-state-") }),
      (error) => error?.code === "E_SECURITY_PROFILE" && /isolated GROK_HOME/.test(error.message)
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

test("selectAcpPermissionOption uses exact allow-once / reject semantics and ignores misleading labels", () => {
  const reordered = [
    { optionId: "allow-always", kind: "allow_always", name: "Allow once" },
    { optionId: "allow-session", kind: "allow_session", name: "Allow once for this turn" },
    { optionId: "reject-once", kind: "reject_once", name: "Allow write forever" },
    { optionId: "allow-once", kind: "allow_once", name: "Reject once" }
  ];
  assert.equal(selectAcpPermissionOption(reordered, { write: true })?.optionId, "allow-once");
  assert.equal(selectAcpPermissionOption(reordered, { write: false })?.optionId, "reject-once");

  // Write must never fall back to allow-always/session when allow-once is absent.
  const persistentOnly = [
    { optionId: "allow-always", kind: "allow_always", name: "Allow once" },
    { optionId: "allow-session", kind: "allow_session", name: "Allow once now" },
    { optionId: "reject-once", kind: "reject_once", name: "Reject once" }
  ];
  assert.equal(selectAcpPermissionOption(persistentOnly, { write: true }), null);
  assert.equal(selectAcpPermissionOption(persistentOnly, { write: false })?.optionId, "reject-once");

  // Read-only never grants even when allow-once is first with a reject-like label.
  const grantFirst = [
    { optionId: "allow-once", kind: "allow_once", name: "Reject once" },
    { optionId: "allow-always", kind: "allow_always", name: "Deny" },
    { optionId: "reject-once", kind: "reject_once", name: "Allow once" }
  ];
  assert.equal(selectAcpPermissionOption(grantFirst, { write: false })?.optionId, "reject-once");
  assert.equal(selectAcpPermissionOption(grantFirst, { write: true })?.optionId, "allow-once");

  // Narrow legacy underscore/hyphen compatibility only — still never allow-always.
  assert.equal(
    selectAcpPermissionOption([{ optionId: "allow_once", kind: "allow-once", name: "Allow always" }], { write: true })?.optionId,
    "allow_once"
  );
  assert.equal(
    selectAcpPermissionOption([{ optionId: "reject_once", kind: "reject-once", name: "Allow once" }], { write: false })?.optionId,
    "reject_once"
  );
});

test("selectAcpPermissionOption rejects conflicting kind/optionId pairs on exact and legacy paths", () => {
  // Write must never select a persistent grant when kind says allow_once.
  assert.equal(
    selectAcpPermissionOption([{ optionId: "allow-always", kind: "allow_once", name: "Allow once" }], { write: true }),
    null
  );
  assert.equal(
    selectAcpPermissionOption([{ optionId: "allow-session", kind: "allow_once", name: "Allow once" }], { write: true }),
    null
  );
  // Legacy underscore optionId with always/session kind.
  assert.equal(
    selectAcpPermissionOption([{ optionId: "allow_once", kind: "allow_always", name: "Allow once" }], { write: true }),
    null
  );
  // Write still accepts UUID optionId with exact allow_once kind.
  assert.equal(
    selectAcpPermissionOption([{ optionId: "opt-uuid-allow", kind: "allow_once", name: "Allow once" }], { write: true })?.optionId,
    "opt-uuid-allow"
  );

  // Read-only must never return an allow optionId even when kind is reject/deny.
  assert.equal(
    selectAcpPermissionOption([{ optionId: "allow-once", kind: "reject_once", name: "Reject once" }], { write: false }),
    null
  );
  assert.equal(
    selectAcpPermissionOption([{ optionId: "allow-once", kind: "deny", name: "Deny" }], { write: false }),
    null
  );
  // Read-only still selects a coherent reject option when a conflicting allow is present.
  assert.equal(
    selectAcpPermissionOption([
      { optionId: "allow-once", kind: "reject_once", name: "Reject once" },
      { optionId: "reject-once", kind: "reject_once", name: "Reject" }
    ], { write: false })?.optionId,
    "reject-once"
  );
});

test("ACP permission hardening selects only allow-once for write and never grants read-only", async (t) => {
  // Deterministic pure coverage of selection is above. Integration path exercises the ACP
  // permissionPolicy wiring; restricted sandboxes that cannot form process identity must
  // skip explicitly rather than silently pass.
  const misleadingOptions = [
    { optionId: "allow-always", kind: "allow_always", name: "Allow once" },
    { optionId: "allow-session", kind: "allow_session", name: "Allow once" },
    { optionId: "allow-once", kind: "allow_once", name: "Allow for the whole session" },
    { optionId: "reject-once", kind: "reject_once", name: "Allow write tools" }
  ];

  const runOrSkipIdentity = async (fn) => {
    try {
      await fn();
    } catch (error) {
      if (error?.code === "E_PROCESS_IDENTITY") {
        t.skip("process identity unavailable in this environment (E_PROCESS_IDENTITY)");
        return;
      }
      throw error;
    }
  };

  await runOrSkipIdentity(async () => {
    await withFake({ permissionRequest: true, permissionOptions: misleadingOptions }, async (fake) => {
      const root = initRepo();
      await runProvider({ root, profile: profileFor("task", true), prompt: "implement", stateDir: tempDir("provider-state-") });
      const response = readFakeLog(fake.logFile).find((entry) => entry.event === "rpc" && entry.message.id === "fake-permission-request" && entry.message.result);
      assert.equal(response.message.result.outcome.optionId, "allow-once");
    });
  });

  await runOrSkipIdentity(async () => {
    await withFake({ permissionRequest: true, permissionOptions: misleadingOptions }, async (fake) => {
      const root = initRepo();
      await runProvider({ root, profile: profileFor("task", false), prompt: "inspect", stateDir: tempDir("provider-state-") });
      const response = readFakeLog(fake.logFile).find((entry) => entry.event === "rpc" && entry.message.id === "fake-permission-request" && entry.message.result);
      assert.equal(response.message.result.outcome.optionId, "reject-once");
    });
  });

  // Read-only cancels rather than granting when only allow options are offered.
  await runOrSkipIdentity(async () => {
    await withFake({
      permissionRequest: true,
      permissionOptions: [
        { optionId: "allow-always", kind: "allow_always", name: "Reject once" },
        { optionId: "allow-once", kind: "allow_once", name: "Deny" },
        { optionId: "allow-session", kind: "allow_session", name: "Reject" }
      ]
    }, async (fake) => {
      const root = initRepo();
      await runProvider({ root, profile: profileFor("task", false), prompt: "inspect", stateDir: tempDir("provider-state-") });
      const response = readFakeLog(fake.logFile).find((entry) => entry.event === "rpc" && entry.message.id === "fake-permission-request" && entry.message.result);
      assert.equal(response.message.result.outcome.outcome, "cancelled");
    });
  });
});

test("gatedCleanupReviewEnvironment retains home while process group is live and cleans when gone", { skip: process.platform === "win32" }, async (t) => {
  const state = tempDir("gated-cleanup-");
  const marker = "review-gate-live";
  const home = path.join(state, "review-homes", marker);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, "credential"), "isolated\n", { mode: 0o600 });

  const child = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);"
  ], { detached: true, stdio: "ignore" });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} });
  await waitFor(() => processGroupAlive(child.pid), { timeoutMs: 5000 });
  // processStartToken may be unavailable in restricted sandboxes; processGroupAlive is enough
  // for the gate (live group ⇒ not gone regardless of token).
  const identity = {
    pid: child.pid,
    startToken: processStartToken(child.pid) || "unavailable-start-token",
    processGroupId: child.pid
  };
  assert.equal(processGroupGone(identity), false);

  // Live group: must not delete the isolated credential home.
  const retained = gatedCleanupReviewEnvironment(state, marker, identity);
  assert.equal(retained.ok, false);
  assert.match(retained.warning, /process cleanup could not be verified/i);
  assert.equal(fs.existsSync(path.join(home, "credential")), true);

  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  await waitFor(() => processGroupGone(identity), { timeoutMs: 5000 });
  const cleaned = gatedCleanupReviewEnvironment(state, marker, identity);
  assert.equal(cleaned.ok, true);
  assert.equal(fs.existsSync(home), false);

  // Absent identity is fail-open (nothing to verify).
  const marker2 = "review-gate-absent";
  const home2 = path.join(state, "review-homes", marker2);
  fs.mkdirSync(home2, { recursive: true, mode: 0o700 });
  assert.equal(gatedCleanupReviewEnvironment(state, marker2, null).ok, true);
  assert.equal(fs.existsSync(home2), false);
});

test("setup probe path retains isolated home when process-group shutdown fails", { skip: process.platform === "win32" }, async (t) => {
  // Mirrors probe finally: ensureChildExit identity failure leaves the group live; gated cleanup
  // must retain the home, keep the guard, and surface privacy evidence without claiming deletion.
  await withFake({}, async () => {
    const root = initRepo();
    const state = tempDir("probe-gate-state-");
    const marker = "setup-probe-live-gate";
    const home = path.join(state, "review-homes", marker);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, "auth.json"), "{\"token\":\"x\"}\n", { mode: 0o600 });

    const child = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);"
    ], { detached: true, stdio: "ignore" });
    t.after(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      try { unregisterProviderGuard(root, marker); } catch {}
    });
    await waitFor(() => processGroupAlive(child.pid), { timeoutMs: 5000 });
    const startToken = processStartToken(child.pid) || "unavailable-start-token";
    const identity = { pid: child.pid, startToken, processGroupId: child.pid };
    registerProviderGuard(root, marker, identity, "probe-session");

    // Forged start token: ensureChildExit refuses to signal and leaves the group live when a token
    // is available. When tokens are unavailable, still exercise the gated cleanup retain path.
    if (processStartToken(child.pid)) {
      await assert.rejects(
        () => ensureChildExit(child, { ...identity, startToken: `${startToken}|forged` }, { naturalExitMs: 0 }),
        (error) => error instanceof CompanionError && error.code === "E_PROCESS_IDENTITY"
      );
    }
    assert.equal(processGroupAlive(child.pid), true);
    assert.equal(processGroupGone(identity), false);

    const cleanup = gatedCleanupReviewEnvironment(state, marker, identity);
    assert.equal(cleanup.ok, false);
    assert.match(cleanup.warning, /Isolated review home retained/i);
    assert.equal(fs.existsSync(path.join(home, "auth.json")), true);
    assert.equal(hasForeignActiveProvider(root, "other-session"), true, "guard must remain after unverifiable shutdown");
  });
});

test("ACP cleanup retains the staged agent profile when exact guard deletion loses an ABA race", async () => {
  await withFake({}, async () => {
    const root = initRepo();
    const state = tempDir("provider-guard-cas-state-");
    const marker = "task-provider-guard-cas-01234567";
    const profiles = path.join(state, "task-homes", marker, ".grok", "agent-profiles");
    let replacement = null;
    try {
      await assert.rejects(
        () => runProvider({
          root,
          profile: profileFor("task", false),
          prompt: "inspect",
          stateDir: state,
          jobMarker: marker,
          onEvent(event) {
            if (event.type !== "provider" || replacement) return;
            replacement = registerProviderGuard(root, marker, {
              ...event.process,
              startToken: `${event.process.startToken}|replacement`
            }, "replacement-owner");
          }
        }),
        (error) => error?.code === "E_STATE"
          && /provider guard/i.test(error?.details?.privacyWarning || "")
      );
      assert.ok(replacement, "test did not publish the ABA replacement guard");
      assert.deepEqual(loadProviderGuard(root, marker), replacement);
      assert.ok(
        fs.readdirSync(profiles).some((name) => name.endsWith(".md")),
        "staged agent profile was deleted after exact guard cleanup failed"
      );
    } finally {
      try { unregisterProviderGuard(root, marker, replacement); } catch {}
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(state, { recursive: true, force: true });
    }
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
    assert.equal(inspection.home, path.join(state, "task-homes", "job"));
    assert.equal(inspection.grokHome, path.join(inspection.home, ".grok"));
    assert.ok(inspection.config.includes(fs.realpathSync(root)));
    assert.equal(inspection.authExists, true);
    assert.equal(inspection.authMode, 0o600);
    assert.equal(fs.existsSync(path.join(inspection.grokHome, "auth.json")), false, "task credential remained after ACP session creation");
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

test("task homes are isolated per lineage and credentials are revoked before every prompt", async () => {
  await withFake({}, async (fake) => {
    const root = initRepo();
    const state = tempDir("provider-state-");
    const profile = profileFor("task", false);
    await runProvider({ root, profile, prompt: "first", stateDir: state, jobMarker: "job-a", providerHomeId: "lineage-a" });
    await runProvider({ root, profile, prompt: "second", stateDir: state, jobMarker: "job-b", providerHomeId: "lineage-b" });
    await runProvider({
      root,
      profile,
      prompt: "resume first",
      stateDir: state,
      jobMarker: "job-c",
      providerHomeId: "lineage-a",
      resumeSessionId: "fake-session-00000001"
    });

    const inspections = readFakeLog(fake.logFile).filter((entry) => entry.event === "inspect-environment" && entry.config?.includes("[skills]"));
    assert.equal(inspections.length, 3);
    assert.equal(inspections[0].home, path.join(state, "task-homes", "lineage-a"));
    assert.equal(inspections[1].home, path.join(state, "task-homes", "lineage-b"));
    assert.equal(inspections[2].home, inspections[0].home);
    assert.notEqual(inspections[0].home, inspections[1].home);
    for (const inspection of inspections) {
      assert.equal(inspection.authExists, true, "provider could not authenticate session creation/load");
      assert.equal(fs.existsSync(path.join(inspection.grokHome, "auth.json")), false, "credential survived into prompt execution");
    }
  });
});

test("review validation derives verdict solely from findings and rejects model verdicts", () => {
  assert.throws(
    () => validateReview({ verdict: "needs_changes", summary: "No defects.", findings: [] }),
    (error) => error?.code === "E_SCHEMA"
  );
  assert.throws(
    () => validateReview({
      verdict: "pass",
      summary: "One defect.",
      findings: [{ severity: "low", title: "Unexpected", body: "A real finding." }]
    }),
    (error) => error?.code === "E_SCHEMA"
  );
  assert.equal(validateReview({ summary: "No defects found.", findings: [] }).verdict, "pass");
  assert.equal(
    validateReview({
      summary: "Issue found.",
      findings: [{ severity: "high", title: "Bug", body: "Broken." }]
    }).verdict,
    "needs_changes"
  );
  assert.throws(
    () => validateReview({ summary: "", findings: [] }),
    (error) => error?.code === "E_SCHEMA" && Boolean(error?.details?.hint)
  );
});

test("runtime review schema stays in the provider-supported subset without conditional allOf", () => {
  assert.equal(Object.hasOwn(REVIEW_SCHEMA, "allOf"), false);
  assert.equal(Object.hasOwn(REVIEW_SCHEMA, "if"), false);
  assert.equal(Object.hasOwn(REVIEW_SCHEMA, "then"), false);
  assert.equal(REVIEW_SCHEMA.type, "object");
  assert.deepEqual(REVIEW_SCHEMA.required, ["summary", "findings"]);
  assert.match(REVIEW_SCHEMA.properties.findings.description, /derived by the runtime/i);
  assert.equal(Object.hasOwn(REVIEW_SCHEMA.properties, "verdict"), false);
  // Serialized form passed to --json-schema must remain free of conditional keywords.
  const serialized = JSON.stringify(REVIEW_SCHEMA);
  assert.equal(serialized.includes('"allOf"'), false);
  assert.equal(serialized.includes('"if"'), false);
  assert.equal(serialized.includes('"then"'), false);
});

test("review and adversarial-review prompts encode findings-derived pass and needs_changes rules", () => {
  const promptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugins/grok/prompts");
  const review = fs.readFileSync(path.join(promptsDir, "review.md"), "utf8");
  const adversarial = fs.readFileSync(path.join(promptsDir, "adversarial-review.md"), "utf8");
  for (const text of [review, adversarial]) {
    assert.match(text, /Leave `findings` empty when there are no/);
    assert.match(text, /runtime derives pass from zero findings/i);
  }
});

test("isolated headless reviews redact opaque cached credentials from diagnostics and results", async () => {
  const secret = "opaque-review-credential-value-123456";
  await withFake({ authSecret: secret, headlessStderr: `diagnostic ${secret}\n`, review: { verdict: "needs_changes", summary: secret, findings: [{ severity: "high", title: "Secret finding", body: secret }] } }, async () => {
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
    await assert.rejects(
      () => runHeadless({ root, profile: profileFor("review"), prompt: "review", stateDir: state, jobMarker: marker, timeoutMs: 600 }),
      (error) => error.code === "E_TIMEOUT"
    );
    assert.equal(cleanupReviewEnvironment(state, marker).ok, true);
  });

  await withFake({ headlessStdoutBytes: 2048, headlessDelayMs: 60_000, headlessIgnoreSigterm: true }, async (fake) => {
    const root = initRepo(), state = tempDir("provider-state-"), marker = "review-output-test";
    const started = Date.now();
    await assert.rejects(
      () => runHeadless({ root, profile: profileFor("review"), prompt: "review", stateDir: state, jobMarker: marker, timeoutMs: 10_000, maxOutputBytes: 1024 }),
      (error) => error.code === "E_OUTPUT_LIMIT"
    );
    assert.ok(Date.now() - started >= 1800);
    assert.equal(
      readFakeLog(fake.logFile).filter((entry) => entry.event === "signal" && entry.signal === "SIGTERM" && entry.transport === "headless").length,
      1
    );
    assert.equal(cleanupReviewEnvironment(state, marker).ok, true);
  });
});

test("headless cleanup kills a TERM-resistant same-group descendant after the leader exits", async () => {
  await withFake({ headlessDelayMs: 60_000, headlessSpawnStubbornDescendant: true }, async (fake) => {
    const root = initRepo(), state = tempDir("provider-state-");
    let providerIdentity = null, cancelRequested = false, waitError = null;
    const rejected = assert.rejects(
      runHeadless({
        root,
        profile: profileFor("review"),
        prompt: "review",
        stateDir: state,
        jobMarker: "review-descendant-test",
        timeoutMs: 10_000,
        cancelRequested: () => cancelRequested,
        onEvent(event) { if (event.type === "provider") providerIdentity = event.process; }
      }),
      (error) => error.code === "E_CANCELLED"
    );
    let descendant;
    try {
      descendant = await waitFor(
        () => readFakeLog(fake.logFile).find((entry) => entry.event === "descendant" && entry.transport === "headless"),
        { timeoutMs: 5_000, intervalMs: 25 }
      );
    } catch (error) {
      waitError = error;
    }
    const cancellationStarted = Date.now();
    cancelRequested = true;
    await rejected;
    if (waitError) throw waitError;
    assert.ok(Date.now() - cancellationStarted >= 2000);
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
      () => runProvider({
        root,
        profile: profileFor("task", false),
        prompt: "inspect",
        stateDir: tempDir("provider-state-")
      }),
      (error) => error.code === "E_PROVIDER_EXIT" && error.details.code === 19
    );
  });
});
