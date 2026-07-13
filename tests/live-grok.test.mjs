import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { childEnvironment } from "../plugins/grok/scripts/lib/grok-provider.mjs";

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION = path.join(REPOSITORY, "plugins", "grok", "scripts", "grok-companion.mjs");
const STOP_HOOK = path.join(REPOSITORY, "plugins", "grok", "scripts", "stop-review-gate-hook.mjs");
const LIVE_ENABLED = process.env.GROK_E2E === "1" || process.env.npm_lifecycle_event === "test:e2e";
const CANCELLATION_ENABLED = process.env.GROK_E2E_CANCEL === "1";
const KEEP_FIXTURE = process.env.GROK_E2E_KEEP === "1";
const CLAUDE_SESSION = `live-grok-${crypto.randomBytes(8).toString("hex")}`;

function run(executable, args, { cwd, env = process.env, input, timeout = 60_000 } = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
    timeout
  });
  if (result.error) throw result.error;
  return result;
}

function git(cwd, args) {
  const result = run("git", args, { cwd });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout;
}

function companion(env, cwd, args, timeout = 10 * 60_000) {
  const result = run(process.execPath, [COMPANION, ...args, "--json", "--cwd", cwd], {
    cwd,
    env,
    timeout
  });
  assert.equal(
    result.status,
    0,
    `Companion command failed (${result.status}):\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    assert.fail(`Companion returned invalid JSON: ${error.message}\n${result.stdout}`);
  }
}

function fileEntries(root) {
  const entries = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (directory === root && entry.name === ".git") continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const stat = fs.lstatSync(absolute);
      if (entry.isSymbolicLink()) {
        entries.push([relative, "symlink", stat.mode, fs.readlinkSync(absolute)]);
      } else if (entry.isDirectory()) {
        entries.push([`${relative}/`, "directory", stat.mode, null]);
        visit(absolute);
      } else if (entry.isFile()) {
        entries.push([relative, "file", stat.mode, crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")]);
      }
    }
  };
  visit(root);
  return entries.sort((a, b) => a[0].localeCompare(b[0]));
}

function repositorySnapshot(root) {
  return {
    head: git(root, ["rev-parse", "HEAD"]).trim(),
    status: git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    staged: crypto.createHash("sha256").update(git(root, ["diff", "--binary", "--cached"])).digest("hex"),
    worktree: crypto.createHash("sha256").update(git(root, ["diff", "--binary"])).digest("hex"),
    files: fileEntries(root)
  };
}

function selectionArgs() {
  const args = [];
  if (process.env.GROK_E2E_MODEL) args.push("--model", process.env.GROK_E2E_MODEL);
  if (process.env.GROK_E2E_EFFORT) args.push("--effort", process.env.GROK_E2E_EFFORT);
  return args;
}

function claudeTranscript(root, sessionId, phrase) {
  const userId = crypto.randomUUID();
  const assistantId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  return [
    {
      parentUuid: null,
      isSidechain: false,
      userType: "external",
      cwd: root,
      sessionId,
      version: "2.1.0",
      gitBranch: "main",
      type: "user",
      message: { role: "user", content: `Remember this exact phrase for later: ${phrase}` },
      uuid: userId,
      timestamp
    },
    {
      parentUuid: userId,
      isSidechain: false,
      userType: "external",
      cwd: root,
      sessionId,
      version: "2.1.0",
      gitBranch: "main",
      type: "assistant",
      message: {
        id: `msg_${assistantId.replaceAll("-", "")}`,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: `I will remember: ${phrase}` }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      requestId: `req_${crypto.randomUUID().replaceAll("-", "")}`,
      uuid: assistantId,
      timestamp: new Date(Date.parse(timestamp) + 1).toISOString()
    }
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

async function waitForJob(env, root, id, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let job = null;
  while (Date.now() < deadline) {
    job = companion(env, root, ["status", id], 30_000);
    if (predicate(job)) return job;
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return job;
}

test("authenticated Grok end-to-end flow", { skip: !LIVE_ENABLED, timeout: 40 * 60_000 }, async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grok-plugin-e2e-"));
  const root = path.join(temporary, "repository");
  const pluginData = path.join(temporary, "plugin-data");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(pluginData, { recursive: true });
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginData,
    GROK_COMPANION_CLAUDE_SESSION_ID: CLAUDE_SESSION
  };
  const grokChildEnv = childEnvironment();
  const providerSessions = new Set();
  let grokBinary = null;
  let transcriptDirectory = null;

  t.diagnostic("This opt-in suite invokes the authenticated Grok CLI and may consume quota.");
  t.diagnostic(`Fixture: ${temporary}`);
  t.after(() => {
    const cleanupFailures = [];
    if (grokBinary) {
      for (const sessionId of providerSessions) {
        try {
          const cleanup = run(grokBinary, ["sessions", "delete", sessionId], {
            cwd: root,
            env: grokChildEnv,
            timeout: 30_000
          });
          if (cleanup.status !== 0) cleanupFailures.push(`${sessionId}: ${cleanup.stderr || cleanup.stdout}`);
        } catch (error) {
          cleanupFailures.push(`${sessionId}: ${error.message}`);
        }
      }
    }
    if (transcriptDirectory) fs.rmSync(transcriptDirectory, { recursive: true, force: true, maxRetries: 3 });
    if (!KEEP_FIXTURE) fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
    assert.deepEqual(cleanupFailures, [], `Provider session cleanup failed:\n${cleanupFailures.join("\n")}`);
  });

  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Grok Companion E2E"]);
  git(root, ["config", "user.email", "grok-companion-e2e@example.invalid"]);
  const readToken = `LIVE_GROK_READ_${crypto.randomBytes(8).toString("hex")}`;
  fs.writeFileSync(path.join(root, "app.mjs"), "export function add(a, b) {\n  return a + b;\n}\n", "utf8");
  fs.writeFileSync(path.join(root, "README.md"), "# Isolated Grok E2E fixture\n", "utf8");
  fs.writeFileSync(path.join(root, "READ_ONLY_TOKEN.txt"), `${readToken}\n`, "utf8");
  git(root, ["add", "app.mjs", "README.md", "READ_ONLY_TOKEN.txt"]);
  git(root, ["commit", "-m", "baseline"]);

  await t.test("setup initializes ACP", () => {
    const setup = companion(env, root, ["setup"], 90_000);
    assert.equal(setup.ready, true, JSON.stringify(setup));
    assert.equal(setup.grok.protocolVersion, 1);
    assert.equal(setup.grok.loadSession, true);
    assert.equal(setup.grok.acpIsolation?.isolated, true);
    assert.match(setup.grok.version, /^\d+\.\d+\.\d+/);
    assert.ok(path.isAbsolute(setup.grok.binary));
    grokBinary = setup.grok.binary;
  });

  await t.test("read-only review preserves every fixture file", () => {
    fs.appendFileSync(path.join(root, "app.mjs"), "\n// Review-only E2E change.\n", "utf8");
    const before = repositorySnapshot(root);
    const job = companion(env, root, ["review", "--wait", "--scope", "working-tree"], 12 * 60_000);
    assert.equal(job.status, "completed", JSON.stringify(job.error));
    assert.ok(job.result?.review);
    assert.ok(["pass", "needs_changes"].includes(job.result.review.verdict));
    assert.equal(job.result.providerSessionDeleted, true, job.result.privacyWarning || "review session was not deleted");
    assert.deepEqual(repositorySnapshot(root), before, "read-only review changed the fixture repository");
    git(root, ["add", "app.mjs"]);
    git(root, ["commit", "-m", "review fixture"]);
  });

  await t.test("isolated read-only ACP task reads the repository without changing it", () => {
    const before = repositorySnapshot(root);
    const task = companion(
      env,
      root,
      [
        "task",
        "--wait",
        "--fresh",
        ...selectionArgs(),
        "Read READ_ONLY_TOKEN.txt and reply with the exact token it contains. Do not edit files or run shell commands."
      ],
      8 * 60_000
    );
    assert.equal(task.status, "completed", JSON.stringify(task.error));
    assert.equal(task.profile?.id, "rescue-read-v2");
    assert.ok(task.grokSessionId, "read-only task did not record a Grok session ID");
    assert.match(task.result?.text || "", new RegExp(readToken), "read-only task did not return the repository token");
    assert.deepEqual(repositorySnapshot(root), before, "isolated read-only ACP task changed the fixture repository");
  });

  await t.test("stop-time review gate runs against a clean repository without mutation", () => {
    const enabled = companion(env, root, ["setup", "--enable-review-gate"], 90_000);
    assert.equal(enabled.ready, true, JSON.stringify(enabled));
    assert.equal(enabled.config.stopReviewGate, true);
    const before = repositorySnapshot(root);
    const hook = run(process.execPath, [STOP_HOOK], {
      cwd: root,
      env,
      timeout: 16 * 60_000,
      input: JSON.stringify({
        cwd: root,
        session_id: CLAUDE_SESSION,
        last_assistant_message: "No repository edits were requested; the status-only response is complete."
      })
    });
    assert.equal(hook.status, 0, `Stop hook failed:\n${hook.stderr || hook.stdout}`);
    assert.equal(hook.stdout, "", `Clean stop review unexpectedly blocked:\n${hook.stdout}`);
    assert.deepEqual(repositorySnapshot(root), before, "stop-time review changed the fixture repository");
  });

  const createToken = `LIVE_GROK_CREATE_${crypto.randomBytes(8).toString("hex")}`;
  let firstTask;
  await t.test("write task creates only the requested sentinel", () => {
    const before = repositorySnapshot(root);
    firstTask = companion(
      env,
      root,
      [
        "task",
        "--wait",
        "--write",
        "--fresh",
        ...selectionArgs(),
        `Create a file named E2E_SENTINEL.txt containing exactly ${createToken} followed by a newline. Do not modify any other file.`
      ],
      12 * 60_000
    );
    assert.equal(firstTask.status, "completed", JSON.stringify(firstTask.error));
    assert.ok(firstTask.grokSessionId, "write task did not record a Grok session ID");
    assert.equal(firstTask.profile?.id, "rescue-write-v2");
    assert.equal(fs.readFileSync(path.join(root, "E2E_SENTINEL.txt"), "utf8"), `${createToken}\n`);
    const after = repositorySnapshot(root);
    assert.deepEqual(
      after.files.filter(([name]) => name !== "E2E_SENTINEL.txt"),
      before.files,
      "write task changed files other than the requested sentinel"
    );
  });

  await t.test("resume loads the same Grok session", () => {
    const resumeToken = `LIVE_GROK_RESUME_${crypto.randomBytes(8).toString("hex")}`;
    const before = repositorySnapshot(root);
    const resumed = companion(
      env,
      root,
      [
        "task",
        "--wait",
        "--write",
        "--resume",
        ...selectionArgs(),
        `Append exactly ${resumeToken} followed by a newline to E2E_SENTINEL.txt. Do not modify any other file.`
      ],
      12 * 60_000
    );
    assert.equal(resumed.status, "completed", JSON.stringify(resumed.error));
    assert.equal(resumed.grokSessionId, firstTask.grokSessionId, "resume created a different Grok session");
    assert.equal(fs.readFileSync(path.join(root, "E2E_SENTINEL.txt"), "utf8"), `${createToken}\n${resumeToken}\n`);
    const after = repositorySnapshot(root);
    assert.deepEqual(
      after.files.filter(([name]) => name !== "E2E_SENTINEL.txt"),
      before.files.filter(([name]) => name !== "E2E_SENTINEL.txt"),
      "resumed task changed files other than the requested sentinel"
    );
  });

  await t.test("nested companion invocation from a Grok task is refused", () => {
    const before = repositorySnapshot(root);
    const command = [
      "/usr/bin/env",
      "-u GROK_COMPANION_CHILD",
      "-u GROK_COMPANION_JOB_MARKER",
      "-u GROK_AGENT",
      "-u GROK_LEADER_SOCKET",
      process.execPath,
      COMPANION,
      "setup --json --cwd",
      root,
      "2>&1"
    ].join(" ");
    const task = companion(
      env,
      root,
      [
        "task",
        "--wait",
        "--write",
        "--fresh",
        ...selectionArgs(),
        `Use the terminal tool to run the command on the next line exactly once, then return its complete output verbatim. Do not modify any files.\n${command}`
      ],
      8 * 60_000
    );
    assert.equal(task.status, "completed", JSON.stringify(task.error));
    assert.ok(task.grokSessionId, "recursion test did not record a Grok session ID");
    assert.match(task.result?.text || "", /E_RECURSION|Nested Grok Companion invocation refused/i);
    assert.deepEqual(repositorySnapshot(root), before, "recursion refusal task changed the fixture repository");
  });

  await t.test("transfer imports Claude JSONL and resumes it directly with Grok", () => {
    assert.ok(grokBinary, "setup did not record the Grok executable");
    const projects = path.join(env.HOME || os.homedir(), ".claude", "projects");
    fs.mkdirSync(projects, { recursive: true, mode: 0o700 });
    // Keep the real HOME so cached Grok authentication remains available, but
    // isolate the synthetic transcript in a uniquely owned directory.
    transcriptDirectory = fs.mkdtempSync(path.join(projects, "grok-plugin-e2e-"));
    const sourceSessionId = crypto.randomUUID();
    const phrase = `LIVE_GROK_IMPORT_${crypto.randomBytes(8).toString("hex")}`;
    const source = path.join(transcriptDirectory, `${sourceSessionId}.jsonl`);
    fs.writeFileSync(source, claudeTranscript(root, sourceSessionId, phrase), { encoding: "utf8", mode: 0o600 });

    const imported = companion(env, root, ["transfer", "--source", source, ...selectionArgs()], 3 * 60_000);
    assert.ok(imported.sessionId, JSON.stringify(imported));
    assert.ok(imported.model, JSON.stringify(imported));
    assert.equal(imported.resume, `grok --model ${imported.model}${imported.effort ? ` --reasoning-effort ${imported.effort}` : ""} --resume ${imported.sessionId}`);
    providerSessions.add(imported.sessionId);

    const resumeArgs = ["--cwd", root, "--model", imported.model];
    if (imported.effort) resumeArgs.push("--reasoning-effort", imported.effort);
    resumeArgs.push(
      "--output-format", "plain",
      "--resume", imported.sessionId,
      "-p", "What exact phrase did the user ask you to remember? Reply with only that phrase."
    );
    const resumed = run(
      grokBinary,
      resumeArgs,
      {
        cwd: root,
        env: grokChildEnv,
        timeout: 8 * 60_000
      }
    );
    assert.equal(resumed.status, 0, `Direct Grok resume failed:\n${resumed.stderr || resumed.stdout}`);
    assert.match(resumed.stdout, new RegExp(phrase), "resumed Grok session did not preserve imported Claude context");

    const deleted = run(grokBinary, ["sessions", "delete", imported.sessionId], {
      cwd: root,
      env: grokChildEnv,
      timeout: 30_000
    });
    assert.equal(deleted.status, 0, `Could not delete imported Grok session:\n${deleted.stderr || deleted.stdout}`);
    providerSessions.delete(imported.sessionId);
  });

  await t.test("background task can be cancelled", { skip: !CANCELLATION_ENABLED }, async () => {
    const before = repositorySnapshot(root);
    const started = companion(env, root, [
      "task",
      "--background",
      "--write",
      "--fresh",
      "Use a shell tool to run this exact command and wait for it: node -e \"setTimeout(() => {}, 120000)\". Do not edit any files and do not answer before the command ends."
    ], 60_000);
    const running = await waitForJob(env, root, started.id, (job) => job.status === "running" && Boolean(job.grokSessionId), 90_000);
    assert.equal(running?.status, "running", `job became ${running?.status ?? "unavailable"} before cancellation`);
    const requested = companion(env, root, ["cancel", started.id], 30_000);
    const terminal = ["cancelled", "completed", "failed"].includes(requested.status)
      ? requested
      : await waitForJob(env, root, started.id, (job) => job.status === "cancelled", 30_000);
    assert.equal(terminal?.status, "cancelled", JSON.stringify(terminal?.error ?? terminal));
    assert.deepEqual(repositorySnapshot(root), before, "cancellation fixture changed during the task");
  });
});
