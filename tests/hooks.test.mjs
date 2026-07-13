import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { spawn } from "node:child_process";

import {
  cancelFile,
  generateId,
  listJobs,
  readJob,
  setConfig,
  updateJob,
  writeJob
} from "../plugins/grok/scripts/lib/state.mjs";
import { installFakeGrok, readFakeLog } from "./fake-grok.mjs";
import { identityMatches, processGroupAlive, processStartToken } from "../plugins/grok/scripts/lib/process-control.mjs";
import { workspaceState } from "../plugins/grok/scripts/lib/workspace.mjs";
import { readCodexSessionMetadata } from "../plugins/grok/scripts/lib/host.mjs";
import { COMPANION, ROOT, initRepo, run, tempDir, testEnvironment, waitFor } from "./helpers.mjs";

const SESSION_HOOK = path.join(ROOT, "plugins", "grok", "scripts", "session-lifecycle-hook.mjs");
const STOP_HOOK = path.join(ROOT, "plugins", "grok", "scripts", "stop-review-gate-hook.mjs");

function withPluginData(pluginData, action) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    return action();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
}

function hook(script, phase, event, { cwd, env, timeout = 15000 } = {}) {
  return run(process.execPath, [script, ...(phase ? [phase] : [])], {
    cwd,
    env,
    input: JSON.stringify(event),
    timeout
  });
}

function spawnHook(script, phase, event, { cwd, env }) {
  const child = spawn(process.execPath, [script, ...(phase ? [phase] : [])], {
    cwd,
    env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(event));
  const completed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, completed };
}

function record(id, session, status = "completed", overrides = {}) {
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: 1,
    id,
    kind: "task",
    jobClass: "task",
    status,
    phase: status,
    claudeSessionId: session,
    createdAt: timestamp,
    updatedAt: timestamp,
    workerProcess: null,
    ...overrides
  };
}

test("SessionStart exports shell-safe session, transcript, and plugin-data values", () => {
  const root = fs.realpathSync(initRepo());
  const directory = tempDir("grok-hook-env-");
  const envFile = path.join(directory, "claude-env.sh");
  fs.writeFileSync(envFile, "", { mode: 0o600 });
  const pluginData = path.join(directory, "plugin's data");
  const env = {
    ...process.env,
    CLAUDE_ENV_FILE: envFile,
    CLAUDE_PLUGIN_DATA: pluginData
  };
  const result = hook(
    SESSION_HOOK,
    "SessionStart",
    {
      cwd: root,
      session_id: "session'quoted",
      transcript_path: "/tmp/transcript's file.jsonl"
    },
    { cwd: root, env }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  const source = fs.readFileSync(envFile, "utf8");
  assert.equal(
    source,
    [
      "export GROK_COMPANION_HOST='claude-code'",
      `export GROK_COMPANION_HOST_SESSION_ID='session'"'"'quoted'`,
      `export GROK_COMPANION_CLAUDE_SESSION_ID='session'"'"'quoted'`,
      `export GROK_COMPANION_TRANSCRIPT_PATH='/tmp/transcript'"'"'s file.jsonl'`,
      `export GROK_COMPANION_PLUGIN_DATA='${pluginData.replace(/'/g, `'"'"'`)}'`,
      `export CLAUDE_PLUGIN_DATA='${pluginData.replace(/'/g, `'"'"'`)}'`,
      ""
    ].join("\n")
  );

  const evaluated = run("/bin/sh", ["-c", `. ${JSON.stringify(envFile)}; printf '%s\\n%s\\n%s\\n%s\\n%s' "$GROK_COMPANION_HOST" "$GROK_COMPANION_HOST_SESSION_ID" "$GROK_COMPANION_CLAUDE_SESSION_ID" "$GROK_COMPANION_TRANSCRIPT_PATH" "$GROK_COMPANION_PLUGIN_DATA"`]);
  assert.equal(evaluated.status, 0, evaluated.stderr);
  assert.equal(
    evaluated.stdout,
    `claude-code\nsession'quoted\nsession'quoted\n/tmp/transcript's file.jsonl\n${pluginData}`
  );
});

test("Codex SessionStart persists thread and transcript metadata without CLAUDE_ENV_FILE", () => {
  const root = fs.realpathSync(initRepo());
  const pluginData = tempDir("grok-codex-hook-data-");
  const transcript = path.join(tempDir("grok-codex-transcript-"), "rollout.jsonl");
  fs.writeFileSync(transcript, "{}\n", "utf8");
  const env = { ...process.env, PLUGIN_DATA: pluginData, CLAUDE_PLUGIN_DATA: pluginData };
  delete env.CLAUDE_ENV_FILE;
  const result = hook(
    SESSION_HOOK,
    "SessionStart",
    { cwd: root, session_id: "codex-thread-a", transcript_path: transcript, source: "startup" },
    { cwd: root, env }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(readCodexSessionMetadata(pluginData, "codex-thread-a"), {
    schemaVersion: 1,
    host: "codex",
    sessionId: "codex-thread-a",
    transcriptPath: transcript,
    cwd: root,
    updatedAt: readCodexSessionMetadata(pluginData, "codex-thread-a").updatedAt
  });
});

test("Codex SessionStart reports metadata persistence failures without exposing host details", () => {
  const root = fs.realpathSync(initRepo());
  const directory = tempDir("grok-codex-hook-error-");
  const invalidPluginData = path.join(directory, "not-a-directory");
  fs.writeFileSync(invalidPluginData, "sentinel\n", { mode: 0o600 });
  const transcript = path.join(directory, "private-rollout.jsonl");
  const sessionId = "private-codex-thread";
  fs.writeFileSync(transcript, "{}\n", { mode: 0o600 });
  const env = { ...process.env, PLUGIN_DATA: invalidPluginData };
  delete env.CLAUDE_ENV_FILE;

  const result = hook(
    SESSION_HOOK,
    "SessionStart",
    { cwd: root, session_id: sessionId, transcript_path: transcript, source: "startup" },
    { cwd: root, env }
  );

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /could not persist Codex SessionStart metadata/i);
  assert.doesNotMatch(result.stderr, new RegExp(sessionId));
  assert.doesNotMatch(result.stderr, new RegExp(path.basename(transcript)));
  assert.doesNotMatch(result.stderr, new RegExp(path.basename(invalidPluginData)));
});

test("lifecycle and stop hooks are no-ops inside a Grok child", () => {
  const root = fs.realpathSync(initRepo());
  const directory = tempDir("grok-hook-child-");
  const envFile = path.join(directory, "claude-env.sh");
  fs.writeFileSync(envFile, "sentinel\n", "utf8");
  const env = {
    ...process.env,
    GROK_COMPANION_CHILD: "1",
    CLAUDE_ENV_FILE: envFile,
    CLAUDE_PLUGIN_DATA: path.join(directory, "data")
  };
  const session = hook(SESSION_HOOK, "SessionStart", { cwd: root, session_id: "child" }, { cwd: root, env });
  const stop = hook(STOP_HOOK, null, { cwd: root, last_assistant_message: "edited files" }, { cwd: root, env });
  assert.equal(session.status, 0);
  assert.equal(stop.status, 0);
  assert.equal(session.stdout + session.stderr + stop.stdout + stop.stderr, "");
  assert.equal(fs.readFileSync(envFile, "utf8"), "sentinel\n");
});

test("SessionEnd requests cancellation and removes only jobs owned by the ending Claude session", async () => {
  const root = fs.realpathSync(initRepo());
  const pluginData = tempDir("grok-hook-data-");
  const ownedFinished = generateId("task");
  const ownedModernFinished = generateId("task");
  const ownedActive = generateId("task");
  const foreignFinished = generateId("task");
  const foreignActive = generateId("task");

  withPluginData(pluginData, () => {
    writeJob(root, record(ownedFinished, "session-a"));
    writeJob(root, record(ownedModernFinished, undefined, "completed", {
      schemaVersion: 2,
      host: { kind: "claude-code", sessionId: "session-a" }
    }));
    writeJob(root, record(ownedActive, "session-a", "running", {
      workerProcess: { nonce: "owned-worker-nonce" }
    }));
    writeJob(root, record(foreignFinished, "session-b"));
    writeJob(root, record(foreignActive, "session-b", "running", {
      workerProcess: { nonce: "foreign-worker-nonce" }
    }));
  });

  const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginData };
  const running = spawnHook(
    SESSION_HOOK,
    "SessionEnd",
    { cwd: root, session_id: "session-a" },
    { cwd: root, env }
  );

  let markerContents = null;
  await waitFor(() => withPluginData(pluginData, () => {
    const marker = cancelFile(root, ownedActive);
    if (!fs.existsSync(marker)) return false;
    markerContents = fs.readFileSync(marker, "utf8");
    return true;
  }));
  assert.equal(markerContents, "owned-worker-nonce\n");

  withPluginData(pluginData, () => updateJob(root, ownedActive, (job) => {
    job.status = "cancelled";
    job.phase = "cancelled";
    return job;
  }));

  const completed = await running.completed;
  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(completed.stdout, "");

  withPluginData(pluginData, () => {
    const remaining = listJobs(root);
    assert.deepEqual(new Set(remaining.map((job) => job.id)), new Set([foreignFinished, foreignActive]));
    assert.equal(fs.existsSync(cancelFile(root, foreignActive)), false);
    assert.throws(() => readJob(root, ownedFinished), (error) => error.code === "E_JOB_NOT_FOUND");
    assert.throws(() => readJob(root, ownedActive), (error) => error.code === "E_JOB_NOT_FOUND");
  });
});

test("SessionEnd verifies whole process-group shutdown before removing a terminal job", { skip: process.platform === "win32" }, async (t) => {
  const root = fs.realpathSync(initRepo());
  const pluginData = tempDir("grok-hook-data-");
  const id = generateId("task");
  const child = spawn(process.execPath, [
    "-e",
    "const {spawn}=require('node:child_process'); process.on('SIGTERM',()=>{}); spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'}); console.log('ready'); setInterval(()=>{},1000);",
    "agent",
    id,
    "stdio"
  ], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", resolve);
  });
  const identity = { pid: child.pid, startToken: processStartToken(child.pid), processGroupId: child.pid };
  assert.equal(identityMatches(identity, id, "provider"), true);
  withPluginData(pluginData, () => writeJob(root, record(id, "session-a", "completed", { providerProcess: identity })));

  const running = spawnHook(SESSION_HOOK, "SessionEnd", { cwd: root, session_id: "session-a" }, { cwd: root, env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData } });
  const completed = await running.completed;
  assert.equal(completed.code, 0, completed.stderr);
  await waitFor(() => !processGroupAlive(child.pid));
  withPluginData(pluginData, () => assert.throws(() => readJob(root, id), (error) => error.code === "E_JOB_NOT_FOUND"));
});

test("disabled stop gate does not invoke Grok and only reports active work", () => {
  const root = fs.realpathSync(initRepo());
  const pluginData = tempDir("grok-hook-data-");
  const active = generateId("task");
  withPluginData(pluginData, () => writeJob(root, record(active, "session-a", "running")));
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginData };
  const result = hook(
    STOP_HOOK,
    null,
    { cwd: root, session_id: "session-a", last_assistant_message: "edited files" },
    { cwd: root, env }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /1 job\(s\) still active/);
});

test("enabled stop gate allows clean output and passes the previous Claude message", () => {
  const root = fs.realpathSync(initRepo());
  const fake = installFakeGrok(tempDir("fake-grok-stop-"), { taskText: "ALLOW: work is complete" });
  const pluginData = tempDir("grok-hook-data-");
  withPluginData(pluginData, () => setConfig(root, { stopReviewGate: true }));
  const env = testEnvironment({ fake, pluginData });
  const previous = "Implemented the parser and ran its tests.";
  const result = hook(STOP_HOOK, null, { cwd: root, last_assistant_message: previous }, { cwd: root, env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  const log = readFakeLog(fake.logFile);
  const invocation = log.find((entry) => entry.event === "headless" && entry.prompt.includes(previous));
  assert.ok(invocation);
  assert.equal(invocation.args[invocation.args.indexOf("--agent") + 1], "explore");
  assert.match(invocation.args[invocation.args.indexOf("--sandbox") + 1], /^companion_[a-f0-9]{20}$/);
  assert.equal(invocation.args[invocation.args.indexOf("--permission-mode") + 1], "default");
  assert.equal(invocation.args[invocation.args.indexOf("--tools") + 1], "todo_write");
  assert.ok(invocation.args.includes("MCPTool(*)"));
  assert.ok(invocation.args.includes("--no-subagents"));
  assert.ok(invocation.args.includes("--output-format"));
  assert.equal(invocation.args.includes("stdio"), false);
  assert.equal(log.some((entry) => entry.event === "rpc"), false);
  assert.equal(log.some((entry) => entry.event === "delete-session"), false);
});

test("enabled stop gate emits Claude block JSON for BLOCK output", () => {
  const root = fs.realpathSync(initRepo());
  const fake = installFakeGrok(tempDir("fake-grok-stop-"), { taskText: "BLOCK: add the missing regression test\nmore detail" });
  const pluginData = tempDir("grok-hook-data-");
  withPluginData(pluginData, () => setConfig(root, { stopReviewGate: true }));
  const result = hook(
    STOP_HOOK,
    null,
    { cwd: root, last_assistant_message: "Implemented without tests." },
    { cwd: root, env: testEnvironment({ fake, pluginData }) }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    decision: "block",
    reason: "add the missing regression test"
  });
  const log = readFakeLog(fake.logFile);
  assert.ok(log.some((entry) => entry.event === "headless"));
  assert.equal(log.some((entry) => entry.event === "rpc"), false);
});

test("enabled stop gate preserves primary BLOCK reason when isolated-home cleanup also fails", { skip: process.platform === "win32" }, () => {
  const root = fs.realpathSync(initRepo());
  const fake = installFakeGrok(tempDir("fake-grok-stop-cleanup-"), {
    taskText: "BLOCK: add the missing regression test",
    headlessLockHome: true
  });
  const pluginData = tempDir("grok-hook-data-");
  withPluginData(pluginData, () => setConfig(root, { stopReviewGate: true }));
  const result = hook(
    STOP_HOOK,
    null,
    { cwd: root, last_assistant_message: "Implemented without tests." },
    { cwd: root, env: testEnvironment({ fake, pluginData }) }
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /add the missing regression test/);
  assert.match(payload.reason, /Isolated credential environment cleanup failed/i);
  // Primary BLOCK text must remain, not be replaced by cleanup-only wording.
  assert.doesNotMatch(payload.reason, /^Grok stop review could not remove its isolated credential environment/);

  // Best-effort unlock of any retained review homes so the temp tree can be removed later.
  const homes = path.join(workspaceState(root), "review-homes");
  if (fs.existsSync(homes)) {
    for (const name of fs.readdirSync(homes)) {
      const nest = path.join(homes, name, "undeletable-cleanup");
      try { fs.chmodSync(nest, 0o700); } catch {}
    }
    try { fs.rmSync(homes, { recursive: true, force: true }); } catch {}
  }
});

test("a crashed stop hook honors explicit host context and is recovered without retaining its provider or isolated home", async (t) => {
  const root = fs.realpathSync(initRepo());
  const fake = installFakeGrok(tempDir("fake-grok-stop-crash-"), { taskText: "ALLOW: complete", headlessDelayMs: 60_000 });
  const pluginData = tempDir("grok-hook-data-");
  withPluginData(pluginData, () => setConfig(root, { stopReviewGate: true }));
  const env = {
    ...testEnvironment({ fake, pluginData, sessionId: "stop-crash-session" }),
    GROK_COMPANION_HOST: "claude-code",
    PLUGIN_ROOT: "/codex-style/plugin-root"
  };
  const running = spawnHook(
    STOP_HOOK,
    null,
    { cwd: root, session_id: "stop-crash-session", last_assistant_message: "Complete." },
    { cwd: root, env }
  );

  let active = null;
  t.after(() => {
    if (active?.providerProcess && processStartToken(active.providerProcess.pid) === active.providerProcess.startToken) {
      try { process.kill(-active.providerProcess.processGroupId, "SIGKILL"); } catch {}
    }
    withPluginData(pluginData, () => fs.rmSync(path.join(workspaceState(root), "review-homes", active?.id || "missing"), { recursive: true, force: true }));
  });
  active = await waitFor(() => {
    const job = withPluginData(pluginData, () => listJobs(root).find((candidate) => candidate.kind === "stop-review" && candidate.providerProcess?.startToken));
    return job || null;
  });
  assert.deepEqual(active.host, { kind: "claude-code", sessionId: "stop-crash-session" });
  running.child.kill("SIGKILL");
  const killed = await running.completed;
  assert.equal(killed.signal, "SIGKILL");
  assert.equal(processStartToken(active.providerProcess.pid), active.providerProcess.startToken, "fixture provider exited before recovery");

  const recovered = run(process.execPath, [COMPANION, "status", "--all", "--json", "--cwd", root], {
    cwd: root,
    env,
    timeout: 15_000
  });
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  const job = JSON.parse(recovered.stdout).find((candidate) => candidate.id === active.id);
  assert.equal(job.status, "failed");
  assert.equal(job.error.code, "E_WORKER_LOST");
  assert.notEqual(processStartToken(active.providerProcess.pid), active.providerProcess.startToken, "recovery left the stop-review provider alive");
  assert.equal(withPluginData(pluginData, () => fs.existsSync(path.join(workspaceState(root), "review-homes", active.id))), false, "recovery retained the isolated review home");
});

test("enabled stop gate detects repository mutation and reports active jobs", () => {
  const root = fs.realpathSync(initRepo());
  const tracked = path.join(root, "tracked.txt");
  const fake = installFakeGrok(tempDir("fake-grok-stop-"), { taskText: "ALLOW: complete", headlessMutatePath: tracked });
  const pluginData = tempDir("grok-hook-data-");
  const active = generateId("task");
  withPluginData(pluginData, () => {
    setConfig(root, { stopReviewGate: true });
    writeJob(root, record(active, "session-a", "running"));
  });
  const result = hook(
    STOP_HOOK,
    null,
    { cwd: root, last_assistant_message: "Implemented the change." },
    { cwd: root, env: testEnvironment({ fake, pluginData }) }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /1 job\(s\) still active/);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /changed repository state/i);
});

test("enabled stop gate blocks malformed output and provider failure with actionable reasons", () => {
  for (const scenario of [
    {
      config: { taskText: "not an allow/block decision" },
      expected: /malformed stop-gate output/
    },
    {
      config: { headlessExitCode: 1, headlessError: "authentication expired\n" },
      expected: /Grok stop review failed: Grok authentication is required/
    }
  ]) {
    const root = fs.realpathSync(initRepo());
    const fake = installFakeGrok(tempDir("fake-grok-stop-"), scenario.config);
    const pluginData = tempDir("grok-hook-data-");
    withPluginData(pluginData, () => setConfig(root, { stopReviewGate: true }));
    const result = hook(
      STOP_HOOK,
      null,
      { cwd: root, last_assistant_message: "Edited code." },
      { cwd: root, env: testEnvironment({ fake, pluginData }) }
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.decision, "block");
    assert.match(payload.reason, scenario.expected);
  }
});

test("enabled stop gate fails open with setup guidance when Grok is missing", () => {
  const root = fs.realpathSync(initRepo());
  const pluginData = tempDir("grok-hook-data-");
  withPluginData(pluginData, () => setConfig(root, { stopReviewGate: true }));

  const isolatedHome = tempDir("grok-hook-home-");
  const isolatedBin = tempDir("grok-hook-bin-");
  const gitName = process.platform === "win32" ? "git.exe" : "git";
  const resolvedGit = String(process.env.PATH ?? "")
    .split(path.delimiter)
    .map((directory) => path.join(directory, gitName))
    .find((candidate) => {
      try { return fs.statSync(candidate).isFile(); } catch { return false; }
    });
  assert.ok(resolvedGit, "test runner PATH must contain git");
  fs.symlinkSync(resolvedGit, path.join(isolatedBin, "git"));
  const env = {
    ...process.env,
    HOME: isolatedHome,
    PATH: isolatedBin,
    GROK_BIN: path.join(isolatedBin, "missing-grok"),
    CLAUDE_PLUGIN_DATA: pluginData
  };
  const result = hook(
    STOP_HOOK,
    null,
    { cwd: root, last_assistant_message: "Edited code." },
    { cwd: root, env }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /stop gate unavailable/);
  assert.match(result.stderr, /Run \/grok:setup/);
});
