import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { processGroupAlive, processStartToken } from "../plugins/grok/scripts/lib/process-control.mjs";

import { installFakeGrok, readFakeLog } from "./fake-grok.mjs";
import {
  COMPANION,
  initRepo,
  runCompanion,
  tempDir,
  testEnvironment,
  waitFor
} from "./helpers.mjs";

function parseJson(result) {
  assert.equal(result.status, 0, `command failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function parseError(result, code) {
  assert.notEqual(result.status, 0, `command unexpectedly succeeded\nstdout: ${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, code);
  return payload.error;
}

function fixture(config = {}) {
  const fake = installFakeGrok(tempDir("fake-grok-runtime-"), config);
  const pluginData = tempDir("grok-runtime-data-");
  return { fake, pluginData, env: testEnvironment({ fake, pluginData }) };
}

test("setup validates headless isolation before enabling the stop gate", () => {
  const root = initRepo();
  const readyFixture = fixture();
  const ready = parseJson(runCompanion(["setup", "--enable-review-gate", "--json"], { cwd: root, env: readyFixture.env }));
  assert.equal(ready.ready, true);
  assert.equal(ready.grok.headlessReview.isolated, true);
  assert.equal(ready.config.stopReviewGate, true);

  const failedRoot = initRepo();
  const failedFixture = fixture({ helpText: "Usage: grok --sandbox PROFILE\n" });
  const failed = parseJson(runCompanion(["setup", "--enable-review-gate", "--json"], { cwd: failedRoot, env: failedFixture.env }));
  assert.equal(failed.ready, false);
  assert.equal(failed.grok.error.code, "E_CAPABILITY");
  assert.equal(failed.config.stopReviewGate, false);
});

function transferFixture(config = {}) {
  const root = initRepo();
  const runtime = fixture(config);
  const home = tempDir("grok-transfer-home-");
  const projects = path.join(home, ".claude", "projects", "fixture");
  fs.mkdirSync(projects, { recursive: true });
  const source = path.join(projects, "session.jsonl");
  fs.writeFileSync(source, '{"type":"user"}\n', "utf8");
  return { root, source, ...runtime, env: { ...runtime.env, HOME: home } };
}

function spawnCompanion(args, { cwd, env }) {
  const child = spawn(process.execPath, [COMPANION, ...args], {
    cwd,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, completed };
}

function persistedJobs(pluginData) {
  const state = path.join(pluginData, "state");
  if (!fs.existsSync(state)) return [];
  return fs.readdirSync(state).flatMap((workspace) => {
    const jobs = path.join(state, workspace, "jobs");
    if (!fs.existsSync(jobs)) return [];
    return fs.readdirSync(jobs).filter((name) => name.endsWith(".json")).flatMap((name) => {
      try { return [JSON.parse(fs.readFileSync(path.join(jobs, name), "utf8"))]; }
      catch { return []; }
    });
  });
}

test("runtime review validates structured output, preserves workspace integrity, and deletes provider session", () => {
  const root = initRepo();
  fs.appendFileSync(path.join(root, "tracked.txt"), "review me\n");
  const before = fs.readFileSync(path.join(root, "tracked.txt"), "utf8");
  const secret = "xai-abcdefghijklmnop";
  const { fake, env } = fixture({
    unknownSecret: secret,
    review: {
      verdict: "needs_changes",
      summary: "One fake issue.",
      findings: [
        {
          severity: "high",
          title: "Fake finding",
          body: "The fixture demonstrates deterministic rendering.",
          file: "tracked.txt",
          line: 1
        }
      ]
    }
  });

  const result = runCompanion(["review", "--wait", "--json"], { cwd: root, env });
  const job = parseJson(result);
  assert.equal(job.kind, "review");
  assert.equal(job.status, "completed");
  assert.equal(job.phase, "done");
  assert.equal(job.write, false);
  assert.equal(job.profile.transport, "headless");
  assert.equal(job.profile.agent, "explore");
  assert.equal(job.profile.sandbox, "strict");
  assert.equal(job.profile.permissionMode, "default");
  assert.equal(job.profile.subagents, false);
  assert.equal(job.result.review.verdict, "needs_changes");
  assert.equal(job.result.providerSessionDeleted, true);
  assert.equal(fs.readFileSync(path.join(root, "tracked.txt"), "utf8"), before);
  assert.equal(job.request.prompt, null);
  assert.match(job.request.promptDigest, /^[a-f0-9]{64}$/);

  const providerLog = readFakeLog(fake.logFile);
  assert.equal(providerLog.some((entry) => entry.event === "delete-session"), false);
  const reviewInvocation = providerLog.find((entry) => entry.event === "headless");
  assert.ok(reviewInvocation);
  assert.equal(reviewInvocation.args[reviewInvocation.args.indexOf("--agent") + 1], "explore");
  assert.match(reviewInvocation.args[reviewInvocation.args.indexOf("--sandbox") + 1], /^companion_[a-f0-9]{20}$/);
  assert.equal(reviewInvocation.args[reviewInvocation.args.indexOf("--permission-mode") + 1], "default");
  assert.ok(reviewInvocation.args.includes("--no-subagents"));
  assert.ok(reviewInvocation.args.includes("--json-schema"));
  assert.equal(reviewInvocation.args[reviewInvocation.args.indexOf("--tools") + 1], "todo_write");
  assert.ok(reviewInvocation.args.includes("MCPTool(*)"));
  assert.equal(providerLog.some((entry) => entry.event === "rpc"), false);
  const persistedLog = fs.readFileSync(job.logFile, "utf8");
  assert.equal(persistedLog.includes(secret), false);

  const human = runCompanion(["result", job.id], { cwd: root, env });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Verdict: needs_changes/);
  assert.match(human.stdout, /\[HIGH\] Fake finding \(tracked\.txt:1\)/);
});

test("runtime write task forwards model and effort under the write security profile", () => {
  const root = initRepo();
  const { fake, env } = fixture({ taskText: "Implemented the requested fake change and ran tests." });
  const result = runCompanion(
    ["task", "--wait", "--write", "--model", "grok-test", "--effort", "high", "implement fixture" , "--json"],
    { cwd: root, env }
  );
  const job = parseJson(result);
  assert.equal(job.kind, "task");
  assert.equal(job.status, "completed");
  assert.equal(job.write, true);
  assert.equal(job.model, "grok-test");
  assert.equal(job.effort, "high");
  assert.equal(job.profile.id, "rescue-write-v2");
  assert.equal(job.profile.transport, "acp");
  assert.equal(job.profile.agent, "build");
  assert.equal(job.profile.sandbox, "workspace");
  assert.equal(job.profile.permissionMode, "bypassPermissions");
  assert.equal(job.result.text, "Implemented the requested fake change and ran tests.");
  assert.equal(job.request.prompt, null);
  assert.match(job.request.promptDigest, /^[a-f0-9]{64}$/);
  assert.ok(job.providerProcess.pid > 0);
  assert.ok(job.grokSessionId);

  const providerLog = readFakeLog(fake.logFile);
  const invocation = providerLog.find(
    (entry) => entry.event === "argv" && entry.args.includes("agent")
  );
  assert.ok(invocation.args.includes("workspace"));
  assert.ok(invocation.args.includes("bypassPermissions"));
  assert.ok(invocation.args.includes("--always-approve"));
  assert.ok(invocation.args.includes("grok-test"));
  assert.ok(invocation.args.includes("high"));
  assert.equal(invocation.args.includes("--tools"), false);
  assert.equal(invocation.args.includes("--disallowed-tools"), false);
  assert.ok(invocation.args.includes("--agent-profile"));
  assert.equal(invocation.args.at(-1), "stdio");
  assert.equal(invocation.args.includes("explore"), false);
  assert.ok(providerLog.some((entry) => entry.event === "rpc" && entry.message.method === "session/prompt"));
  assert.equal(providerLog.some((entry) => entry.event === "headless"), false);
});

test("resume candidates preserve read/write profiles and never escalate an existing session", () => {
  const root = initRepo();
  const { fake, env } = fixture({ taskText: "Profile-specific task result." });

  const read = parseJson(runCompanion(
    ["task", "--wait", "--fresh", "read-only investigation", "--json"],
    { cwd: root, env }
  ));
  assert.equal(read.profile.id, "rescue-read-v2");
  const readCandidate = parseJson(runCompanion(["task-resume-candidate", "--json"], { cwd: root, env }));
  assert.deepEqual(readCandidate, {
    available: true,
    jobId: read.id,
    grokSessionId: read.grokSessionId,
    profileId: "rescue-read-v2"
  });

  const escalated = runCompanion(
    ["task", "--wait", "--write", "--resume", "attempt privilege escalation", "--json"],
    { cwd: root, env }
  );
  parseError(escalated, "E_NO_RESUME_CANDIDATE");

  const write = parseJson(runCompanion(
    ["task", "--wait", "--write", "--fresh", "write-profile implementation", "--json"],
    { cwd: root, env }
  ));
  assert.equal(write.profile.id, "rescue-write-v2");
  const writeCandidate = parseJson(runCompanion(["task-resume-candidate", "--write", "--json"], { cwd: root, env }));
  assert.deepEqual(writeCandidate, {
    available: true,
    jobId: write.id,
    grokSessionId: write.grokSessionId,
    profileId: "rescue-write-v2"
  });

  const resumed = parseJson(runCompanion(
    ["task", "--wait", "--write", "--resume", "continue write-profile work", "--json"],
    { cwd: root, env }
  ));
  assert.equal(resumed.grokSessionId, write.grokSessionId);
  assert.equal(resumed.request.resumeSessionId, write.grokSessionId);
  assert.ok(readFakeLog(fake.logFile).some((entry) =>
    entry.event === "rpc" && entry.message.method === "session/load" && entry.message.params.sessionId === write.grokSessionId
  ));
});

test("background task is durable across command processes and supports status, wait, and result", () => {
  const root = initRepo();
  const { env } = fixture({ taskText: "Background fake result", delayMs: 250 });
  const launch = parseJson(runCompanion(
    ["task", "--background", "background fixture", "--json"],
    { cwd: root, env }
  ));
  assert.equal(launch.status, "queued");
  assert.ok(launch.workerProcess.pid > 0);
  assert.match(launch.workerProcess.nonce, /^[a-f0-9]{32}$/);

  const waited = parseJson(runCompanion(
    ["status", launch.id, "--wait", "--timeout-ms", "10000", "--json"],
    { cwd: root, env, timeout: 15000 }
  ));
  assert.equal(waited.status, "completed");
  assert.equal(waited.result.text, "Background fake result");
  assert.equal(waited.request.prompt, null);
  assert.match(waited.request.promptDigest, /^[a-f0-9]{64}$/);

  const result = parseJson(runCompanion(["result", launch.id, "--json"], { cwd: root, env }));
  assert.equal(result.id, launch.id);
  assert.equal(result.status, "completed");

  const listing = runCompanion(["status"], { cwd: root, env });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, new RegExp(launch.id));
  assert.match(listing.stdout, /completed/);
});

test("task results redact provider secrets in immediate, stored, JSON, and human output", () => {
  const root = initRepo();
  const secret = "xai-abcdefghijklmnopqrstuvwxyz";
  const { env } = fixture({ taskText: `Completed safely; provider token was ${secret}.` });
  const immediate = runCompanion(["task", "--wait", "redaction fixture", "--json"], { cwd: root, env });
  const job = parseJson(immediate);
  assert.match(job.result.text, /Completed safely/);

  const jsonResult = runCompanion(["result", job.id, "--json"], { cwd: root, env });
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  const humanResult = runCompanion(["result", job.id], { cwd: root, env });
  assert.equal(humanResult.status, 0, humanResult.stderr);
  const persisted = `${fs.readFileSync(job.logFile, "utf8")}\n${fs.readFileSync(path.join(path.dirname(job.logFile), `${job.id}.json`), "utf8")}`;

  for (const output of [immediate.stdout, jsonResult.stdout, humanResult.stdout, persisted]) {
    assert.equal(output.includes(secret), false);
    assert.equal(output.includes("xai-"), false);
  }
});

test("background cancellation writes a marker, sends ACP cancel, and reaches cancelled once", async () => {
  const root = initRepo();
  const { fake, env } = fixture({ cancelMode: "wait" });
  const launch = parseJson(runCompanion(
    ["task", "--background", "wait until cancelled", "--json"],
    { cwd: root, env }
  ));

  await waitFor(() => {
    const result = runCompanion(["status", launch.id, "--json"], { cwd: root, env });
    if (result.status !== 0) return false;
    const job = JSON.parse(result.stdout);
    return job.status === "running" && job.grokSessionId ? job : false;
  });

  const cancelled = parseJson(runCompanion(["cancel", launch.id, "--json"], {
    cwd: root,
    env,
    timeout: 15000
  }));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancelled.error.code, "E_CANCELLED");
  const marker = path.join(path.dirname(cancelled.logFile), `${launch.id}.cancel`);
  assert.equal(fs.readFileSync(marker, "utf8"), `${launch.workerProcess.nonce}\n`);
  assert.ok(readFakeLog(fake.logFile).some((entry) => entry.event === "cancel"));

  const second = parseJson(runCompanion(["cancel", launch.id, "--json"], { cwd: root, env }));
  assert.equal(second.status, "cancelled");
  assert.equal(second.completedAt, cancelled.completedAt);
});

test("worker ignores forged and missing cancellation nonces", async () => {
  for (const forged of ["wrong-worker-nonce\n", "\n"]) {
    const root = initRepo();
    const { fake, env } = fixture({ cancelMode: "wait" });
    const launch = parseJson(runCompanion(
      ["task", "--background", "reject forged cancellation", "--json"],
      { cwd: root, env }
    ));

    const running = await waitFor(() => {
      const result = runCompanion(["status", launch.id, "--json"], { cwd: root, env });
      if (result.status !== 0) return false;
      const job = JSON.parse(result.stdout);
      return job.status === "running" && job.grokSessionId ? job : false;
    });
    const marker = path.join(path.dirname(running.logFile), `${launch.id}.cancel`);
    fs.writeFileSync(marker, forged, { mode: 0o600 });

    await new Promise((resolve) => setTimeout(resolve, 350));
    const afterForgery = parseJson(runCompanion(["status", launch.id, "--json"], { cwd: root, env }));
    assert.equal(afterForgery.status, "running", `worker accepted forged marker ${JSON.stringify(forged)}`);
    assert.equal(readFakeLog(fake.logFile).some((entry) => entry.event === "cancel"), false);

    const cancelled = parseJson(runCompanion(["cancel", launch.id, "--json"], {
      cwd: root,
      env,
      timeout: 15000
    }));
    assert.equal(cancelled.status, "cancelled");
    assert.equal(fs.readFileSync(marker, "utf8"), `${launch.workerProcess.nonce}\n`);
  }
});

test("background review cancellation terminates the headless process and preserves the workspace", async () => {
  const root = initRepo();
  const tracked = path.join(root, "tracked.txt");
  fs.appendFileSync(tracked, "review cancellation fixture\n", "utf8");
  const before = fs.readFileSync(tracked, "utf8");
  const { fake, env } = fixture({ headlessDelayMs: 60_000 });
  const launch = parseJson(runCompanion(
    ["review", "--background", "--json"],
    { cwd: root, env }
  ));

  await waitFor(() => {
    const status = runCompanion(["status", launch.id, "--json"], { cwd: root, env });
    if (status.status !== 0) return false;
    const job = JSON.parse(status.stdout);
    const headlessStarted = readFakeLog(fake.logFile).some((entry) => entry.event === "headless");
    return job.status === "running" && job.providerProcess?.pid && headlessStarted ? job : false;
  });

  const cancelled = parseJson(runCompanion(["cancel", launch.id, "--json"], {
    cwd: root,
    env,
    timeout: 15000
  }));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancelled.error.code, "E_CANCELLED");
  assert.equal(fs.readFileSync(tracked, "utf8"), before);
  assert.equal(fs.existsSync(path.join(path.dirname(path.dirname(cancelled.logFile)), "review-homes", launch.id)), false);

  const providerLog = readFakeLog(fake.logFile);
  assert.ok(providerLog.some((entry) => entry.event === "headless"));
  assert.ok(providerLog.some(
    (entry) => entry.event === "signal" && entry.signal === "SIGTERM" && entry.transport === "headless"
  ));
  assert.equal(providerLog.some((entry) => entry.event === "rpc"), false);
});

test("status recovers a background task whose worker crashes without replaying its prompt", { skip: process.platform === "win32" }, async () => {
  const root = initRepo();
  const { fake, env } = fixture({ cancelMode: "wait" });
  const launch = parseJson(runCompanion(
    ["task", "--background", "worker crash fixture", "--json"],
    { cwd: root, env }
  ));
  const running = await waitFor(() => {
    const result = runCompanion(["status", launch.id, "--json"], { cwd: root, env });
    if (result.status !== 0) return false;
    const job = JSON.parse(result.stdout);
    return job.status === "running" && job.providerProcess?.pid ? job : false;
  });

  process.kill(running.workerProcess.pid, "SIGKILL");
  const recovered = await waitFor(() => {
    const result = runCompanion(["status", launch.id, "--json"], { cwd: root, env });
    if (result.status !== 0) return false;
    const job = JSON.parse(result.stdout);
    return job.status === "failed" ? job : false;
  }, { timeoutMs: 15000 });
  assert.equal(recovered.error.code, "E_WORKER_LOST");
  assert.match(recovered.error.message, /prompt was not replayed/i);
  assert.ok(readFakeLog(fake.logFile).filter((entry) => entry.event === "prompt").length <= 1, "crashed background prompt was replayed");
});

test("a foreground caller returns the recovered worker-crash failure", { skip: process.platform === "win32" }, async () => {
  const root = initRepo();
  const { fake, pluginData, env } = fixture({ cancelMode: "wait" });
  const foreground = spawnCompanion(
    ["task", "--wait", "foreground worker crash fixture", "--json"],
    { cwd: root, env }
  );

  try {
    const running = await waitFor(() => {
      const job = persistedJobs(pluginData)[0];
      return job?.status === "running" && job.providerProcess?.pid ? job : false;
    }, { timeoutMs: 10000 });
    process.kill(running.workerProcess.pid, "SIGKILL");

    const recovered = await waitFor(() => {
      const status = runCompanion(["status", running.id, "--json"], { cwd: root, env });
      if (status.status !== 0) return false;
      const job = JSON.parse(status.stdout);
      return job.status === "failed" ? job : false;
    }, { timeoutMs: 15000 });
    assert.equal(recovered.error.code, "E_WORKER_LOST");

    const completed = await Promise.race([
      foreground.completed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Foreground caller did not observe recovered worker failure.")), 10000))
    ]);
    assert.notEqual(completed.code, 0, completed.stdout);
    const error = JSON.parse(completed.stdout).error;
    assert.equal(error.code, "E_WORKER_LOST");
    assert.ok(readFakeLog(fake.logFile).filter((entry) => entry.event === "prompt").length <= 1, "crashed foreground prompt was replayed");
  } finally {
    if (foreground.child.exitCode == null && foreground.child.signalCode == null) foreground.child.kill("SIGKILL");
  }
});

test("lost-worker recovery terminates headless review and removes its isolated home", { skip: process.platform === "win32" }, async () => {
  const root = initRepo();
  fs.appendFileSync(path.join(root, "tracked.txt"), "review worker crash fixture\n", "utf8");
  const { pluginData, env } = fixture({ headlessDelayMs: 60_000 });
  const launch = parseJson(runCompanion(
    ["review", "--background", "--json"],
    { cwd: root, env }
  ));
  const running = await waitFor(() => {
    const result = runCompanion(["status", launch.id, "--json"], { cwd: root, env });
    if (result.status !== 0) return false;
    const job = JSON.parse(result.stdout);
    return job.status === "running" && job.providerProcess?.pid ? job : false;
  });
  const isolatedHome = path.join(path.dirname(path.dirname(running.logFile)), "review-homes", launch.id);
  assert.equal(fs.existsSync(isolatedHome), true);

  try {
    process.kill(running.workerProcess.pid, "SIGKILL");
    const recovered = await waitFor(() => {
      const result = runCompanion(["status", launch.id, "--json"], { cwd: root, env });
      if (result.status !== 0) return false;
      const job = JSON.parse(result.stdout);
      return job.status === "failed" ? job : false;
    }, { timeoutMs: 15000 });
    assert.equal(recovered.error.code, "E_WORKER_LOST");
    assert.equal(fs.existsSync(isolatedHome), false);
  } finally {
    try { process.kill(-running.providerProcess.processGroupId, "SIGKILL"); } catch {}
    fs.rmSync(path.join(pluginData, "state"), { recursive: true, force: true });
  }
});

test("runtime rejects conflicting execution flags and nested companion invocation", () => {
  const root = initRepo();
  const { env } = fixture();
  const conflict = runCompanion(
    ["task", "--wait", "--background", "conflict", "--json"],
    { cwd: root, env }
  );
  assert.equal(conflict.status, 2);
  assert.equal(JSON.parse(conflict.stdout).error.code, "E_USAGE");

  const nested = runCompanion(["task", "nested", "--json"], {
    cwd: root,
    env: { ...env, GROK_COMPANION_CHILD: "1" }
  });
  assert.equal(nested.status, 7);
  assert.equal(JSON.parse(nested.stdout).error.code, "E_RECURSION");

  const markerOnly = runCompanion(["setup", "--json"], {
    cwd: root,
    env: { ...env, GROK_COMPANION_JOB_MARKER: "forged-provider-context" }
  });
  assert.equal(markerOnly.status, 7);
  assert.equal(JSON.parse(markerOnly.stdout).error.code, "E_RECURSION");
});

test("transfer imports only regular Claude JSONL files beneath the canonical projects directory", () => {
  const root = initRepo();
  const { fake, env } = fixture({ importSessionId: "12345678-1234-4234-8234-123456789abc", importSpawnStubbornDescendant: true });
  const home = tempDir("grok-transfer-home-");
  const projects = path.join(home, ".claude", "projects", "fixture");
  fs.mkdirSync(projects, { recursive: true });
  const source = path.join(projects, "session.jsonl");
  fs.writeFileSync(source, '{"type":"user"}\n', "utf8");
  const transferEnv = { ...env, HOME: home };

  const imported = parseJson(runCompanion(["transfer", "--source", source, "--json"], { cwd: root, env: transferEnv }));
  assert.equal(imported.sessionId, "12345678-1234-4234-8234-123456789abc");
  assert.equal(imported.model, "grok-test");
  assert.equal(imported.resume, "grok --model grok-test --resume 12345678-1234-4234-8234-123456789abc");
  const importInvocation = readFakeLog(fake.logFile).find((entry) => entry.event === "argv" && entry.args[0] === "import");
  const importPath = importInvocation.args.at(-1);
  assert.match(path.basename(importPath), /^import-[a-f0-9]{24}\.jsonl$/);
  assert.equal(importInvocation.args.includes(source), false, "transfer exposed the source transcript path to Grok");
  assert.equal(fs.existsSync(importPath), false, "transfer left its descriptor alias behind");
  const importInput = readFakeLog(fake.logFile).find((entry) => entry.event === "import-input");
  assert.equal(importInput.bytes, fs.statSync(source).size);
  assert.equal(importInput.sha256, crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex"));
  const descendant = readFakeLog(fake.logFile).find((entry) => entry.event === "descendant" && entry.transport === "import");
  assert.ok(descendant?.pid);
  assert.equal(processStartToken(descendant.pid), null);
  assert.equal(processGroupAlive(descendant.processGroupId), false);

  const outside = path.join(home, "outside.jsonl");
  fs.writeFileSync(outside, "{}\n", "utf8");
  const escaped = runCompanion(["transfer", "--source", outside, "--json"], { cwd: root, env: transferEnv });
  assert.equal(escaped.status, 5);
  assert.equal(JSON.parse(escaped.stdout).error.code, "E_IMPORT_SOURCE");

  const link = path.join(projects, "linked.jsonl");
  fs.symlinkSync(source, link);
  const symlinked = runCompanion(["transfer", "--source", link, "--json"], { cwd: root, env: transferEnv });
  assert.equal(symlinked.status, 5);
  assert.equal(JSON.parse(symlinked.stdout).error.code, "E_IMPORT_SOURCE");
});

test("transfer rejects malformed UUIDs, malformed NDJSON, and nonzero import exits", () => {
  {
    const { root, source, env } = transferFixture({ importSessionId: "not-a-session-uuid" });
    const error = parseError(
      runCompanion(["transfer", "--source", source, "--json"], { cwd: root, env }),
      "E_IMPORT_RESULT"
    );
    assert.match(error.message, /no usable session ID/i);
  }

  {
    const { root, source, env } = transferFixture({ importOutput: '{"sessionId":' });
    const error = parseError(
      runCompanion(["transfer", "--source", source, "--json"], { cwd: root, env }),
      "E_IMPORT_RESULT"
    );
    assert.match(error.message, /malformed NDJSON/i);
  }

  {
    const secret = "xai-abcdefghijklmnopqrstuvwxyz";
    const { root, source, env } = transferFixture({
      importExitCode: 19,
      importStderr: `provider failed with ${secret}\n`
    });
    const result = runCompanion(["transfer", "--source", source, "--json"], { cwd: root, env });
    const error = parseError(result, "E_IMPORT_RESULT");
    assert.match(error.message, /could not import/i);
    assert.equal(JSON.stringify(error).includes(secret), false);
    assert.equal(result.stdout.includes("xai-"), false);
  }
});

test("transfer rejects multiple different session IDs from NDJSON", () => {
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const { root, source, env } = transferFixture({
    importRecords: [
      { event: "started", sessionId: first },
      { event: "completed", grok_session_id: second }
    ]
  });
  const error = parseError(runCompanion(
    ["transfer", "--source", source, "--json"],
    { cwd: root, env }
  ), "E_IMPORT_RESULT");
  assert.match(error.message, /multiple different session IDs/i);
});
