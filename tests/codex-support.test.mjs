import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { hasYamlFrontmatter } from "../scripts/lib/frontmatter.mjs";

import {
  hostCommand,
  hostContext,
  jobHostContext,
  pluginDataRoot,
  sameHostSession
} from "../plugins/grok/scripts/lib/host.mjs";
import {
  codexTranscriptToClaude,
  createAnonymousTranscript,
  disposeConvertedTranscript,
  openTranscriptSource,
  readTranscriptSnapshot
} from "../plugins/grok/scripts/lib/transcript.mjs";
import {
  selectJob,
  writeJob
} from "../plugins/grok/scripts/lib/state.mjs";
import { initRepo, runCodexCompanion, runCompanion } from "./helpers.mjs";
import { installFakeGrok } from "./fake-grok.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "grok");
const PUBLIC_SKILLS = [
  "adversarial-review",
  "cancel",
  "rescue",
  "result",
  "review",
  "setup",
  "status",
  "transfer"
];

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function readJson(relative) {
  return JSON.parse(read(relative));
}

function frontmatter(text) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(match, "skill must start with YAML frontmatter");
  return match[1];
}

function frontmatterValue(text, name) {
  const match = frontmatter(text).match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() || null;
}

function job(id, createdAt, values) {
  return {
    schemaVersion: values.host ? 2 : 1,
    id,
    kind: "task",
    jobClass: "task",
    status: "completed",
    phase: "done",
    createdAt,
    updatedAt: createdAt,
    ...values
  };
}

test("validator frontmatter detection accepts LF, CRLF, and CR line endings", () => {
  assert.equal(hasYamlFrontmatter("---\ndescription: test\n---\nbody\n"), true);
  assert.equal(hasYamlFrontmatter("---\r\ndescription: test\r\n---\r\nbody\r\n"), true);
  assert.equal(hasYamlFrontmatter("---\rdescription: test\r---\rbody\r"), true);
  assert.equal(hasYamlFrontmatter("description: test\n---\nbody\n"), false);
  assert.equal(hasYamlFrontmatter("---\ndescription: test\nbody\n"), false);
});

test("Codex host detection honors normalized overrides and uses a Codex data fallback", () => {
  assert.deepEqual(hostContext({ CODEX_THREAD_ID: "codex-thread" }), {
    kind: "codex",
    sessionId: "codex-thread"
  });
  assert.deepEqual(hostContext({
    GROK_COMPANION_HOST: "claude",
    GROK_COMPANION_HOST_SESSION_ID: "normalized-session",
    GROK_COMPANION_CLAUDE_SESSION_ID: "legacy-session",
    CODEX_THREAD_ID: "codex-thread"
  }), {
    kind: "claude-code",
    sessionId: "normalized-session"
  });
  assert.deepEqual(hostContext({ GROK_COMPANION_CLAUDE_SESSION_ID: "legacy-session" }), {
    kind: "claude-code",
    sessionId: "legacy-session"
  });
  assert.deepEqual(hostContext({}), {
    kind: "cli",
    sessionId: null
  });
  assert.equal(hostCommand("setup", "", { CODEX_THREAD_ID: "codex-thread" }), "$grok:setup");
  assert.equal(hostCommand("status", "job-123", { CODEX_THREAD_ID: "codex-thread" }), "$grok:status job-123");
  assert.equal(hostCommand("setup", "", { GROK_COMPANION_CLAUDE_SESSION_ID: "claude-session" }), "/grok:setup");

  const home = path.join(path.sep, "tmp", "home-for-codex-test");
  const codexHome = path.join(home, "custom-codex");
  assert.equal(
    pluginDataRoot({ HOME: home, CODEX_HOME: codexHome, CODEX_THREAD_ID: "codex-thread" }),
    path.join(codexHome, "plugins", "data", "grok-grok-companion")
  );
  assert.equal(
    pluginDataRoot({
      HOME: home,
      CODEX_THREAD_ID: "codex-thread",
      PLUGIN_DATA: path.join(home, "plugin-data"),
      GROK_COMPANION_PLUGIN_DATA: path.join(home, "normalized-data")
    }),
    path.join(home, "normalized-data")
  );
});

test("Codex wrapper without host markers falls through to cli identity", () => {
  const root = initRepo();
  const fake = installFakeGrok(tempDir("fake-grok-codex-host-"));
  const pluginData = tempDir("grok-codex-host-data-");
  const env = {
    ...process.env,
    GROK_BIN: fake.binary,
    GROK_AUTH_PATH: fake.authPath,
    GROK_COMPANION_PLUGIN_DATA: pluginData,
    HOME: tempDir("grok-codex-host-home-")
  };
  for (const key of [
    "CODEX_THREAD_ID",
    "GROK_COMPANION_HOST",
    "GROK_COMPANION_HOST_SESSION_ID",
    "GROK_COMPANION_CLAUDE_SESSION_ID",
    "CLAUDE_PLUGIN_DATA",
    "CLAUDE_PROJECT_DIR",
    "PLUGIN_DATA"
  ]) {
    delete env[key];
  }

  const result = runCodexCompanion(["review", "--scope", "working-tree", "--json"], { cwd: root, env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const job = JSON.parse(result.stdout);
  assert.equal(job.host.kind, "cli");
  assert.equal(job.host.sessionId, null);
  assert.equal(job.result.skipped, true);
  assert.equal(job.result.skipReason, "empty-target");
});

test("legacy Claude and schema-2 host records remain isolated by host kind and session", (t) => {
  const legacy = { claudeSessionId: "shared-session" };
  const modernClaude = { host: { kind: "claude-code", sessionId: "claude-session" } };
  const modernCodex = { host: { kind: "codex", sessionId: "shared-session" } };

  assert.deepEqual(jobHostContext(legacy), { kind: "claude-code", sessionId: "shared-session" });
  assert.equal(sameHostSession(legacy, { kind: "claude-code", sessionId: "shared-session" }), true);
  assert.equal(sameHostSession(legacy, { kind: "codex", sessionId: "shared-session" }), false);
  assert.equal(sameHostSession(modernCodex, { kind: "codex", sessionId: "shared-session" }), true);
  assert.equal(sameHostSession(modernCodex, { kind: "codex", sessionId: "other-session" }), false);
  assert.equal(sameHostSession(modernClaude, { kind: "claude-code", sessionId: null }), false);

  const root = tempDir("grok-codex-state-");
  const data = tempDir("grok-codex-data-");
  const previous = process.env.GROK_COMPANION_PLUGIN_DATA;
  process.env.GROK_COMPANION_PLUGIN_DATA = data;
  t.after(() => {
    if (previous === undefined) delete process.env.GROK_COMPANION_PLUGIN_DATA;
    else process.env.GROK_COMPANION_PLUGIN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });

  writeJob(root, job("task-111111111111111111111111", "2026-01-01T00:00:00.000Z", legacy));
  writeJob(root, job("task-222222222222222222222222", "2026-01-02T00:00:00.000Z", modernClaude));
  writeJob(root, job("task-333333333333333333333333", "2026-01-03T00:00:00.000Z", modernCodex));

  assert.equal(selectJob(root, {
    host: { kind: "codex", sessionId: "shared-session" },
    finished: true
  }).id, "task-333333333333333333333333");
  assert.equal(selectJob(root, {
    host: { kind: "claude-code", sessionId: "shared-session" },
    finished: true
  }).id, "task-111111111111111111111111");
  assert.equal(selectJob(root, {
    host: { kind: "claude-code", sessionId: "claude-session" },
    finished: true
  }).id, "task-222222222222222222222222");
  assert.throws(
    () => selectJob(root, { host: { kind: "codex", sessionId: null }, finished: true }),
    (error) => error?.code === "E_JOB_NOT_FOUND" && /host session identity/i.test(error.message)
  );
  assert.equal(selectJob(root, {
    host: { kind: "codex", sessionId: null },
    finished: true,
    allSessions: true
  }).id, "task-333333333333333333333333");
});

test("implicit status, result, and cancel fail closed without a host session", (t) => {
  const root = fs.realpathSync(initRepo());
  const data = tempDir("grok-missing-host-data-");
  const id = "task-444444444444444444444444";
  const previous = process.env.GROK_COMPANION_PLUGIN_DATA;
  process.env.GROK_COMPANION_PLUGIN_DATA = data;
  writeJob(root, job(id, "2026-01-04T00:00:00.000Z", {
    host: { kind: "codex", sessionId: "recorded-codex-session" },
    summary: "Completed fixture",
    result: { text: "Completed fixture" }
  }));
  t.after(() => {
    if (previous === undefined) delete process.env.GROK_COMPANION_PLUGIN_DATA;
    else process.env.GROK_COMPANION_PLUGIN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });

  const env = {
    ...process.env,
    GROK_COMPANION_HOST: "cli",
    GROK_COMPANION_PLUGIN_DATA: data
  };
  for (const key of [
    "GROK_COMPANION_HOST_SESSION_ID",
    "GROK_COMPANION_CLAUDE_SESSION_ID",
    "CODEX_THREAD_ID",
    "CLAUDE_PROJECT_DIR"
  ]) delete env[key];

  for (const command of ["status", "result", "cancel"]) {
    const invocation = runCompanion([command, "--json"], { cwd: root, env });
    assert.notEqual(invocation.status, 0, `${command} unexpectedly selected a cross-session job`);
    const payload = JSON.parse(invocation.stdout);
    assert.equal(payload.error.code, "E_JOB_NOT_FOUND");
    assert.match(payload.error.message, /host session identity/i);
  }

  const all = runCompanion(["status", "--all", "--json"], { cwd: root, env });
  assert.equal(all.status, 0, all.stderr);
  assert.deepEqual(JSON.parse(all.stdout).map((item) => item.id), [id]);

  for (const command of ["status", "result", "cancel"]) {
    const invocation = runCompanion([command, id, "--json"], { cwd: root, env });
    assert.equal(invocation.status, 0, `${command} rejected an explicit repo-scoped ID: ${invocation.stderr || invocation.stdout}`);
    assert.equal(JSON.parse(invocation.stdout).id, id);
  }
});

test("Codex transcript conversion keeps only user-visible user and assistant messages", () => {
  const records = [
    { type: "session_meta", timestamp: "2026-07-13T10:00:00.000Z", payload: { id: "019f0000-0000-7000-8000-000000000001" } },
    { type: "turn_context", timestamp: "2026-07-13T10:00:00.100Z", payload: { model: "gpt-codex-test", developer: "developer-secret" } },
    { type: "response_item", timestamp: "2026-07-13T10:00:00.200Z", payload: { type: "message", role: "developer", content: [{ type: "text", text: "developer-secret" }] } },
    { type: "event_msg", timestamp: "2026-07-13T10:00:01.000Z", payload: { type: "user_message", message: "visible user request" } },
    { type: "event_msg", timestamp: "2026-07-13T10:00:01.100Z", payload: { type: "agent_reasoning", text: "private-reasoning-secret" } },
    { type: "response_item", timestamp: "2026-07-13T10:00:01.200Z", payload: { type: "function_call_output", output: "private-tool-secret" } },
    { type: "event_msg", timestamp: "2026-07-13T10:00:02.000Z", payload: { type: "agent_message", phase: "commentary", message: "visible assistant update" } },
    { type: "event_msg", timestamp: "2026-07-13T10:00:02.100Z", payload: { type: "agent_message", phase: "analysis", message: "private-analysis-secret" } },
    { type: "event_msg", timestamp: "2026-07-13T10:00:03.000Z", payload: { type: "agent_message", phase: "final_answer", message: "visible assistant result" } }
  ];
  const converted = codexTranscriptToClaude(
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    { cwd: "/workspace/repository" }
  );
  const messages = converted.trim().split("\n").map((line) => JSON.parse(line));

  assert.deepEqual(messages.map((message) => message.type), ["user", "assistant", "assistant"]);
  assert.equal(messages[0].message.content, "visible user request");
  assert.equal(messages[1].message.content[0].text, "visible assistant update");
  assert.equal(messages[2].message.content[0].text, "visible assistant result");
  assert.equal(messages[1].message.model, "gpt-codex-test");
  assert.equal(messages[0].parentUuid, null);
  assert.equal(messages[1].parentUuid, messages[0].uuid);
  assert.equal(messages[2].parentUuid, messages[1].uuid);
  for (const excluded of [
    "developer-secret",
    "private-reasoning-secret",
    "private-tool-secret",
    "private-analysis-secret"
  ]) assert.equal(converted.includes(excluded), false, `converted transcript leaked ${excluded}`);
});

test("transcript source accepts canonical Codex sessions and rejects outside paths", (t) => {
  const home = tempDir("grok-codex-transcript-home-");
  const codexHome = path.join(home, ".codex");
  const sessions = path.join(codexHome, "sessions", "2026", "07", "13");
  fs.mkdirSync(sessions, { recursive: true });
  const source = path.join(sessions, "rollout-codex.jsonl");
  fs.writeFileSync(source, '{"type":"session_meta"}\n', { mode: 0o600 });
  const outside = path.join(home, "outside.jsonl");
  fs.writeFileSync(outside, "{}\n", { mode: 0o600 });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const opened = openTranscriptSource(source, { HOME: home, CODEX_HOME: codexHome });
  try {
    assert.equal(opened.real, fs.realpathSync(source));
    assert.equal(opened.format, "codex");
    assert.equal(opened.size, fs.statSync(source).size);
  } finally {
    fs.closeSync(opened.fd);
  }
  assert.throws(
    () => openTranscriptSource(outside, { HOME: home, CODEX_HOME: codexHome }),
    (error) => error?.code === "E_IMPORT_SOURCE"
  );
});

test("Codex transcript snapshots stay descriptor-bound and reject truncation or growth", (t) => {
  const home = tempDir("grok-codex-transcript-bounds-");
  const codexHome = path.join(home, ".codex");
  const sessions = path.join(codexHome, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const source = path.join(sessions, "rollout.jsonl");
  const moved = path.join(sessions, "moved.jsonl");
  const original = '{"type":"session_meta","payload":{"id":"bounded"}}\n';
  fs.writeFileSync(source, original, { mode: 0o600 });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const renamed = openTranscriptSource(source, { HOME: home, CODEX_HOME: codexHome });
  try {
    fs.renameSync(source, moved);
    assert.equal(readTranscriptSnapshot(renamed), original, "snapshot reader reopened the stale source path");
  } finally {
    fs.closeSync(renamed.fd);
  }

  fs.renameSync(moved, source);
  const truncated = openTranscriptSource(source, { HOME: home, CODEX_HOME: codexHome });
  try {
    fs.truncateSync(source, Buffer.byteLength(original) - 1);
    assert.throws(
      () => readTranscriptSnapshot(truncated),
      (error) => error?.code === "E_IMPORT_SOURCE" && /ended before/i.test(error.message)
    );
  } finally {
    fs.closeSync(truncated.fd);
  }

  fs.writeFileSync(source, original, { mode: 0o600 });
  const grown = openTranscriptSource(source, { HOME: home, CODEX_HOME: codexHome });
  try {
    fs.appendFileSync(source, '{"type":"event_msg"}\n');
    assert.throws(
      () => readTranscriptSnapshot(grown),
      (error) => error?.code === "E_IMPORT_SOURCE" && /changed|grew/i.test(error.message)
    );
  } finally {
    fs.closeSync(grown.fd);
  }
});

test("converted transcript descriptors are anonymous when supported and securely disposed", (t) => {
  const directory = tempDir("grok-codex-converted-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const secret = "privacy-filtered transcript\n";
  const converted = createAnonymousTranscript(secret, directory);
  const buffer = Buffer.alloc(Buffer.byteLength(secret));
  assert.equal(fs.readSync(converted.fd, buffer, 0, buffer.length, 0), buffer.length);
  assert.equal(buffer.toString("utf8"), secret);
  if (process.platform !== "win32") assert.equal(converted.file, null);

  const cleanup = disposeConvertedTranscript(converted);
  assert.equal(cleanup.ok, true, cleanup.warning || "converted transcript cleanup failed");
  if (converted.file) assert.equal(fs.existsSync(converted.file), false);
  assert.throws(() => fs.fstatSync(converted.fd), (error) => error?.code === "EBADF");
});

test("transcript source rejects symlinks inside the Codex sessions directory", { skip: process.platform === "win32" }, (t) => {
  const home = tempDir("grok-codex-transcript-link-");
  const codexHome = path.join(home, ".codex");
  const sessions = path.join(codexHome, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const source = path.join(sessions, "source.jsonl");
  const link = path.join(sessions, "linked.jsonl");
  fs.writeFileSync(source, "{}\n", { mode: 0o600 });
  fs.symlinkSync(source, link);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  assert.throws(
    () => openTranscriptSource(link, { HOME: home, CODEX_HOME: codexHome }),
    (error) => error?.code === "E_IMPORT_SOURCE" && /symlink/i.test(error.message)
  );
});

test("Codex manifest, marketplace, public skills, hooks, and wrapper form one installable contract", (t) => {
  const packageJson = readJson("package.json");
  const manifest = readJson("plugins/grok/.codex-plugin/plugin.json");
  const marketplace = readJson(".agents/plugins/marketplace.json");
  const claudeManifest = readJson("plugins/grok/.claude-plugin/plugin.json");
  const defaultHooks = readJson("plugins/grok/hooks/hooks.json");
  const claudeHooks = readJson("plugins/grok/hooks/claude-hooks.json");

  assert.equal(manifest.name, "grok");
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.hooks, undefined, "Codex manifest must use default hook discovery");
  assert.equal(manifest.interface.displayName, "Grok Companion");
  assert.deepEqual(new Set(manifest.interface.capabilities), new Set(["Interactive", "Read", "Write"]));

  assert.equal(marketplace.name, "grok-companion");
  assert.equal(marketplace.interface.displayName, "Grok Companion");
  assert.equal(marketplace.plugins.length, 1);
  assert.deepEqual(marketplace.plugins[0].source, { source: "local", path: "./plugins/grok" });
  assert.deepEqual(marketplace.plugins[0].policy, { installation: "AVAILABLE", authentication: "ON_INSTALL" });
  assert.equal(marketplace.plugins[0].version, packageJson.version);

  const skillDirectories = fs.readdirSync(path.join(PLUGIN_ROOT, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const name of PUBLIC_SKILLS) assert.ok(skillDirectories.includes(name), `missing public Codex skill ${name}`);

  for (const name of PUBLIC_SKILLS) {
    const contents = read(`plugins/grok/skills/${name}/SKILL.md`);
    assert.equal(frontmatterValue(contents, "name"), name);
    assert.ok(frontmatterValue(contents, "description"));
    assert.equal(frontmatterValue(contents, "user-invocable"), "false", "Claude must hide the duplicate Codex facade");
    assert.match(contents, /\.\.\/\.\.\/scripts\/grok-codex\.mjs/);
    assert.match(contents, /exactly one process/i);
    assert.doesNotMatch(contents, /\$\{CLAUDE_PLUGIN_ROOT\}/);
    const metadata = read(`plugins/grok/skills/${name}/agents/openai.yaml`);
    assert.match(metadata, new RegExp(`default_prompt: "[^"]*\\$grok:${name}\\b`));
    assert.match(metadata, /allow_implicit_invocation:\s*true/);
  }
  for (const name of ["grok-cli-runtime", "grok-prompting", "grok-result-handling"]) {
    assert.match(read(`plugins/grok/skills/${name}/agents/openai.yaml`), /allow_implicit_invocation:\s*false/);
  }
  assert.match(read("plugins/grok/skills/rescue/SKILL.md"), /never spawn a host subagent/i);

  assert.deepEqual(Object.keys(defaultHooks.hooks).sort(), ["SessionStart", "Stop"]);
  assert.deepEqual(Object.keys(claudeHooks.hooks), ["SessionEnd"]);
  assert.deepEqual(claudeManifest.hooks, ["./hooks/hooks.json", "./hooks/claude-hooks.json"]);
  assert.match(defaultHooks.hooks.SessionStart[0].hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/session-lifecycle-hook\.mjs/);
  assert.match(defaultHooks.hooks.Stop[0].hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/stop-review-gate-hook\.mjs/);

  const wrapper = read("plugins/grok/scripts/grok-codex.mjs");
  // Source contract: only set host when unset (preserve explicit), claim codex only under CODEX_THREAD_ID,
  // and never default to "codex" via ||= / ternary fallthrough. No-host → cli is covered by the runtime test above.
  assert.match(wrapper, /if\s*\(\s*!process\.env\.GROK_COMPANION_HOST\s*\)\s*\{/);
  assert.match(wrapper, /if\s*\(\s*process\.env\.CODEX_THREAD_ID\s*\)\s*process\.env\.GROK_COMPANION_HOST\s*=\s*"codex"\s*;/);
  assert.match(wrapper, /GROK_COMPANION_CLAUDE_SESSION_ID[\s\S]*process\.env\.GROK_COMPANION_HOST\s*=\s*"claude-code"/);
  assert.doesNotMatch(wrapper, /GROK_COMPANION_HOST\s*\|\|=/);
  assert.doesNotMatch(wrapper, /:\s*"codex"\s*;?\s*$/m);
  assert.match(wrapper, /GROK_COMPANION_HOST_SESSION_ID\s*\|\|=\s*process\.env\.CODEX_THREAD_ID/);
  assert.match(wrapper, /GROK_COMPANION_PLUGIN_DATA\s*\|\|=/);
  assert.match(wrapper, /await import\("\.\/grok-companion\.mjs"\)/);

  const codexHome = tempDir("grok-codex-wrapper-");
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const helpEnv = {
    ...process.env,
    CODEX_HOME: codexHome,
    CODEX_THREAD_ID: "codex-wrapper-test",
    GROK_COMPANION_PLUGIN_DATA: path.join(codexHome, "plugin-data")
  };
  // Avoid nested-companion refusal when this suite runs under a Grok rescue worker.
  delete helpEnv.GROK_COMPANION_CHILD;
  delete helpEnv.GROK_COMPANION_JOB_MARKER;
  delete helpEnv.GROK_AGENT;
  delete helpEnv.GROK_LEADER_SOCKET;
  const run = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "scripts", "grok-codex.mjs"), "help"], {
    cwd: ROOT,
    encoding: "utf8",
    shell: false,
    env: helpEnv
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^Usage:/);
  assert.match(run.stdout, /transfer \[--source <claude-or-codex-jsonl>\] \[--model <id>\] \[--effort low\|medium\|high\] \[--json\]/);
  assert.doesNotMatch(run.stdout, /task-resume-candidate/);
});
