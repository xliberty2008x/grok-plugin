import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { processGroupAlive, processStartToken } from "../plugins/grok/scripts/lib/process-control.mjs";
import { hasForeignActiveProvider, registerProviderGuard, unregisterProviderGuard } from "../plugins/grok/scripts/lib/recursion-guard.mjs";
import { generateId } from "../plugins/grok/scripts/lib/state.mjs";

import { installFakeGrok, readFakeLog } from "./fake-grok.mjs";
import {
  COMPANION,
  initRepo,
  runCodexCompanion,
  runCompanion,
  tempDir,
  testEnvironment,
  waitFor
} from "./helpers.mjs";
import { writeCodexSessionMetadata } from "../plugins/grok/scripts/lib/host.mjs";

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
  const env = testEnvironment({ fake, pluginData });
  // Strip host companion markers so CLI under test is not refused as nested recursion
  // when this suite is itself launched from a Grok Companion rescue session.
  delete env.GROK_COMPANION_CHILD;
  delete env.GROK_COMPANION_JOB_MARKER;
  delete env.GROK_AGENT;
  delete env.GROK_LEADER_SOCKET;
  return { fake, pluginData, env };
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

test("empty review target records a skipped empty-target result without claiming session deletion", () => {
  const root = initRepo();
  const { env } = fixture();
  const result = runCompanion(["review", "--scope", "working-tree", "--json"], { cwd: root, env });
  const job = parseJson(result);
  assert.equal(job.status, "completed");
  assert.equal(job.phase, "done");
  assert.equal(job.grokSessionId, null);
  assert.equal(job.result.skipped, true);
  assert.equal(job.result.skipReason, "empty-target");
  assert.equal(job.result.providerSessionDeleted, false);
  assert.equal(job.result.review.verdict, "pass");
  assert.deepEqual(job.result.review.findings, []);

  const human = runCompanion(["result", job.id], { cwd: root, env });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Grok session: not started \(empty target\)/);
  assert.equal(human.stdout.includes("deleted after review"), false);
});

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

function seedWorkspace(root, env) {
  parseJson(runCompanion(["review", "--scope", "working-tree", "--json"], { cwd: root, env }));
  const jobs = persistedJobs(env.CLAUDE_PLUGIN_DATA);
  assert.ok(jobs.length >= 1);
  return path.dirname(path.dirname(jobs[0].logFile));
}

function writeSeededJob(stateRoot, job) {
  fs.writeFileSync(path.join(stateRoot, "jobs", `${job.id}.json`), `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(job.logFile, "", { mode: 0o600 });
}

test("cancel during worker launch window uses workerAuthorization when workerProcess is null", async () => {
  // Launch window: startJob persists workerAuthorization before workerProcess exists.
  // requestCancel must use that authenticated nonce rather than throwing E_PROCESS_IDENTITY.
  const root = fs.realpathSync(initRepo());
  const { pluginData, env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("task");
  const authNonce = crypto.randomBytes(16).toString("hex");
  const stamped = new Date().toISOString();
  const jobPath = path.join(stateRoot, "jobs", `${id}.json`);
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "task",
    jobClass: "task",
    title: "task: launch-window cancel fixture",
    summary: "Queued",
    write: false,
    status: "queued",
    phase: "queued",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: null,
    updatedAt: stamped,
    completedAt: null,
    workerAuthorization: authNonce,
    workerProcess: null,
    providerProcess: null,
    profile: { id: "rescue-read-v2", transport: "acp" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: { prompt: null, promptDigest: "abc" },
    result: null,
    error: null
  });

  const canceling = spawnCompanion(["cancel", id, "--json"], { cwd: root, env });
  const marker = path.join(stateRoot, "jobs", `${id}.cancel`);
  await waitFor(() => fs.existsSync(marker), { timeoutMs: 5000 });
  assert.equal(fs.readFileSync(marker, "utf8"), `${authNonce}\n`);

  // End the graceful wait early: the launch-window worker never started.
  // Write the job file directly so we do not depend on process.env plugin-data routing.
  const current = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  current.status = "cancelled";
  current.phase = "cancelled";
  current.completedAt = new Date().toISOString();
  current.error = { code: "E_CANCELLED", message: "cancelled during launch window" };
  current.summary = current.error.message;
  current.updatedAt = current.completedAt;
  fs.writeFileSync(jobPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });

  const completed = await canceling.completed;
  assert.equal(completed.code, 0, completed.stderr || completed.stdout);
  const cancelled = JSON.parse(completed.stdout);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(fs.readFileSync(marker, "utf8"), `${authNonce}\n`);
});

test("cancel fails closed when neither workerProcess nonce nor workerAuthorization exists", () => {
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("task");
  const stamped = new Date().toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "task",
    jobClass: "task",
    title: "task: missing-nonce cancel fixture",
    summary: "Queued",
    write: false,
    status: "queued",
    phase: "queued",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: null,
    updatedAt: stamped,
    completedAt: null,
    workerAuthorization: null,
    workerProcess: null,
    providerProcess: null,
    profile: { id: "rescue-read-v2", transport: "acp" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: { prompt: null },
    result: null,
    error: null
  });

  const failed = runCompanion(["cancel", id, "--json"], { cwd: root, env });
  parseError(failed, "E_PROCESS_IDENTITY");
  assert.equal(fs.existsSync(path.join(stateRoot, "jobs", `${id}.cancel`)), false);
});

test("lost-worker recovery uses provider guard when providerProcess is missing and group is gone", { skip: process.platform === "win32" }, () => {
  // Guard-created / providerProcess-missing window: job never recorded providerProcess, but
  // registerProviderGuard persisted an identity that is already gone. Recovery must load the
  // guard, verify the group is gone, then unregister and clean the isolated home.
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const isolatedHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(isolatedHome, "marker"), "guard-window\n", { mode: 0o600 });

  const deadIdentity = { pid: 999999998, startToken: "dead-provider-token", processGroupId: 999999998 };
  const stamped = new Date(Date.now() - 60_000).toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: guard-only provider cleanup",
    summary: "Running",
    write: false,
    status: "running",
    phase: "prompting",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: stamped,
    updatedAt: stamped,
    completedAt: null,
    workerProcess: { pid: 999999999, startToken: "dead-worker-token", nonce: "n", processGroupId: 999999999, commandMarker: id },
    providerProcess: null,
    profile: { id: "review", transport: "headless" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: { prompt: null, target: { mode: "working-tree", label: "fixture", base: null } },
    result: { privacyWarning: "prior-privacy-signal" },
    error: null
  });
  registerProviderGuard(root, id, deadIdentity, env.GROK_COMPANION_HOST_SESSION_ID);

  try {
    const recovered = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.error.code, "E_WORKER_LOST");
    assert.equal(hasForeignActiveProvider(root, null), false, "guard must be removed after verified teardown");
    assert.equal(fs.existsSync(isolatedHome), false, "isolated home must be removed after verified teardown");
    assert.equal(recovered.result?.providerSessionDeleted, true);
  } finally {
    try { unregisterProviderGuard(root, id); } catch {}
  }
});

test("lost-worker recovery preserves guard and home when guard identity is live/unverifiable", { skip: process.platform === "win32" }, async (t) => {
  // Same window, but the guard points at a live process group. Without the guard fallback the
  // old path treated null providerProcess as "nothing to terminate" and unregistered/cleaned.
  // Fail closed: retain guard, home, and privacy evidence with E_PROCESS_IDENTITY.
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const isolatedHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(isolatedHome, "retained.txt"), "privacy-evidence\n", { mode: 0o600 });

  const provider = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);"
  ], { detached: true, stdio: "ignore" });
  t.after(() => {
    try { process.kill(-provider.pid, "SIGKILL"); } catch {}
    try { unregisterProviderGuard(root, id); } catch {}
  });
  await waitFor(() => processGroupAlive(provider.pid), { timeoutMs: 5000 });
  // Synthetic token: live group cannot be verified for ownership → terminate must fail closed.
  const identity = { pid: provider.pid, startToken: "unverified-live-provider-token", processGroupId: provider.pid };

  const stamped = new Date(Date.now() - 60_000).toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: unverifiable guard-only provider",
    summary: "Running",
    write: false,
    status: "running",
    phase: "prompting",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: stamped,
    updatedAt: stamped,
    completedAt: null,
    workerProcess: { pid: 999999999, startToken: "dead-worker-token", nonce: "n", processGroupId: 999999999, commandMarker: id },
    providerProcess: null,
    profile: { id: "review", transport: "headless" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: { prompt: null, target: { mode: "working-tree", label: "fixture", base: null } },
    result: { privacyWarning: "prior-privacy-signal" },
    error: null
  });
  registerProviderGuard(root, id, identity, env.GROK_COMPANION_HOST_SESSION_ID);
  assert.equal(processGroupAlive(provider.pid), true);

  const recovered = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.error.code, "E_PROCESS_IDENTITY");
  assert.equal(processGroupAlive(provider.pid), true, "must not tear down an unverifiable live process group");
  assert.equal(hasForeignActiveProvider(root, null), true, "guard must be retained");
  assert.equal(fs.existsSync(path.join(isolatedHome, "retained.txt")), true, "isolated home must be retained");
  assert.equal(recovered.result?.providerSessionDeleted, false);
  assert.match(recovered.result?.privacyWarning || "", /prior-privacy-signal/);
  assert.match(recovered.result?.privacyWarning || "", /Isolated review home retained/);
});

test("force-cancel uses provider guard when providerProcess is missing", { skip: process.platform === "win32" }, async (t) => {
  // Force-cancel path after graceful timeout: providerProcess never recorded, guard has a dead
  // identity (verified gone). Cancel must still load the guard, unregister, and clean the home.
  // Queued+young avoids recoverActiveJobs stealing the job before the force path runs.
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const isolatedHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(isolatedHome, "marker"), "force-cancel-guard\n", { mode: 0o600 });
  const workerNonce = crypto.randomBytes(16).toString("hex");
  const deadIdentity = { pid: 999999997, startToken: "dead-provider-token", processGroupId: 999999997 };
  const stamped = new Date().toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: force-cancel guard-only provider",
    summary: "Queued",
    write: false,
    status: "queued",
    phase: "queued",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: null,
    updatedAt: stamped,
    completedAt: null,
    workerAuthorization: workerNonce,
    workerProcess: null,
    providerProcess: null,
    profile: { id: "review", transport: "headless" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: { prompt: null, target: { mode: "working-tree", label: "fixture", base: null } },
    result: null,
    error: null
  });
  registerProviderGuard(root, id, deadIdentity, env.GROK_COMPANION_HOST_SESSION_ID);
  t.after(() => { try { unregisterProviderGuard(root, id); } catch {} });

  const cancelled = parseJson(runCompanion(["cancel", id, "--json"], {
    cwd: root,
    env,
    timeout: 20000
  }));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.error.code, "E_CANCELLED");
  assert.match(cancelled.error.message, /force-cancelled/i);
  assert.equal(fs.readFileSync(path.join(stateRoot, "jobs", `${id}.cancel`), "utf8"), `${workerNonce}\n`);
  assert.equal(hasForeignActiveProvider(root, null), false, "guard must be removed after force-cancel teardown");
  assert.equal(fs.existsSync(isolatedHome), false, "isolated home must be removed after force-cancel teardown");
  assert.equal(cancelled.result?.providerSessionDeleted, true);
});

test("force-cancel successful home cleanup clears prior privacy warning", { skip: process.platform === "win32" }, async (t) => {
  // Force-cancel path must use applyReviewPrivacy: a successful later cleanup clears a stale
  // privacyWarning rather than leaving it on the cancelled job.
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const isolatedHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(isolatedHome, "marker"), "force-cancel-clear\n", { mode: 0o600 });
  const workerNonce = crypto.randomBytes(16).toString("hex");
  const deadIdentity = { pid: 999999995, startToken: "dead-provider-token", processGroupId: 999999995 };
  const stamped = new Date().toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: force-cancel privacy clear",
    summary: "Queued",
    write: false,
    status: "queued",
    phase: "queued",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: null,
    updatedAt: stamped,
    completedAt: null,
    workerAuthorization: workerNonce,
    workerProcess: null,
    providerProcess: null,
    profile: { id: "review", transport: "headless" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: { prompt: null, target: { mode: "working-tree", label: "fixture", base: null } },
    result: {
      review: { verdict: "pass", summary: "fixture", findings: [] },
      providerSessionDeleted: false,
      privacyWarning: "earlier-cleanup-failed"
    },
    error: null
  });
  registerProviderGuard(root, id, deadIdentity, env.GROK_COMPANION_HOST_SESSION_ID);
  t.after(() => { try { unregisterProviderGuard(root, id); } catch {} });

  const cancelled = parseJson(runCompanion(["cancel", id, "--json"], {
    cwd: root,
    env,
    timeout: 20000
  }));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.error.code, "E_CANCELLED");
  assert.match(cancelled.error.message, /force-cancelled/i);
  assert.equal(fs.existsSync(isolatedHome), false, "isolated home must be removed after successful force-cancel cleanup");
  assert.equal(cancelled.result?.providerSessionDeleted, true);
  assert.equal(cancelled.result?.privacyWarning, undefined, "successful cleanup must clear stale privacyWarning");
  assert.equal(cancelled.result?.review?.verdict, "pass", "prior review evidence must remain");
});

test("force-cancel failed home cleanup appends privacyWarning without erasing prior evidence", { skip: process.platform === "win32" }, async (t) => {
  // Force-cancel path must use applyReviewPrivacy: failed home cleanup appends a warning and
  // keeps prior privacy evidence rather than replacing the result object wholesale.
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const isolatedHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  const nest = path.join(isolatedHome, "undeletable-cleanup");
  fs.mkdirSync(nest, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(nest, "locked"), "locked\n", { mode: 0o600 });
  fs.chmodSync(nest, 0o000);
  const workerNonce = crypto.randomBytes(16).toString("hex");
  const deadIdentity = { pid: 999999994, startToken: "dead-provider-token", processGroupId: 999999994 };
  const stamped = new Date().toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: force-cancel privacy append",
    summary: "Queued",
    write: false,
    status: "queued",
    phase: "queued",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: null,
    updatedAt: stamped,
    completedAt: null,
    workerAuthorization: workerNonce,
    workerProcess: null,
    providerProcess: null,
    profile: { id: "review", transport: "headless" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: { prompt: null, target: { mode: "working-tree", label: "fixture", base: null } },
    result: {
      review: { verdict: "pass", summary: "fixture", findings: [] },
      providerSessionDeleted: false,
      privacyWarning: "prior-privacy-signal"
    },
    error: null
  });
  registerProviderGuard(root, id, deadIdentity, env.GROK_COMPANION_HOST_SESSION_ID);
  t.after(() => {
    try { unregisterProviderGuard(root, id); } catch {}
    try { fs.chmodSync(nest, 0o700); } catch {}
    try { fs.rmSync(isolatedHome, { recursive: true, force: true }); } catch {}
  });

  try {
    const cancelled = parseJson(runCompanion(["cancel", id, "--json"], {
      cwd: root,
      env,
      timeout: 20000
    }));
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.error.code, "E_CANCELLED");
    assert.match(cancelled.error.message, /force-cancelled/i);
    assert.equal(fs.existsSync(isolatedHome), true, "failed cleanup must retain the isolated review home");
    assert.equal(cancelled.result?.providerSessionDeleted, false);
    assert.match(cancelled.result?.privacyWarning || "", /^prior-privacy-signal; /);
    assert.ok((cancelled.result?.privacyWarning || "").length > "prior-privacy-signal; ".length);
    assert.equal(cancelled.result?.review?.verdict, "pass", "prior review evidence must remain");
  } finally {
    try { fs.chmodSync(nest, 0o700); } catch {}
  }
});

test("force-cancel preserves guard and home when guard identity is live/unverifiable", { skip: process.platform === "win32" }, async (t) => {
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const isolatedHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(isolatedHome, "retained.txt"), "force-cancel-privacy\n", { mode: 0o600 });
  const workerNonce = crypto.randomBytes(16).toString("hex");

  const provider = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);"
  ], { detached: true, stdio: "ignore" });
  t.after(() => {
    try { process.kill(-provider.pid, "SIGKILL"); } catch {}
    try { unregisterProviderGuard(root, id); } catch {}
  });
  await waitFor(() => processGroupAlive(provider.pid), { timeoutMs: 5000 });
  const identity = { pid: provider.pid, startToken: "unverified-live-provider-token", processGroupId: provider.pid };
  const stamped = new Date().toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: force-cancel live guard-only provider",
    summary: "Queued",
    write: false,
    status: "queued",
    phase: "queued",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: null,
    updatedAt: stamped,
    completedAt: null,
    workerAuthorization: workerNonce,
    workerProcess: null,
    providerProcess: null,
    profile: { id: "review", transport: "headless" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: { prompt: null, target: { mode: "working-tree", label: "fixture", base: null } },
    result: { privacyWarning: "prior-privacy-signal" },
    error: null
  });
  registerProviderGuard(root, id, identity, env.GROK_COMPANION_HOST_SESSION_ID);

  const failed = runCompanion(["cancel", id, "--json"], { cwd: root, env, timeout: 20000 });
  parseError(failed, "E_PROCESS_IDENTITY");
  assert.equal(fs.readFileSync(path.join(stateRoot, "jobs", `${id}.cancel`), "utf8"), `${workerNonce}\n`);
  assert.equal(processGroupAlive(provider.pid), true, "must not tear down an unverifiable live process group");
  assert.equal(hasForeignActiveProvider(root, null), true, "guard must be retained after force-cancel failure");
  assert.equal(fs.existsSync(path.join(isolatedHome, "retained.txt")), true, "isolated home must be retained");
  const job = JSON.parse(fs.readFileSync(path.join(stateRoot, "jobs", `${id}.json`), "utf8"));
  assert.equal(job.status, "queued", "force-cancel must not mark cancelled when provider cleanup fails closed");
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

test("lost-worker recovery retains privacy evidence when provider terminate cannot verify cleanup", { skip: process.platform === "win32" }, () => {
  const root = initRepo();
  const { pluginData, env } = fixture();
  // Seed workspace state by creating one empty-target job first.
  parseJson(runCompanion(["review", "--scope", "working-tree", "--json"], { cwd: root, env }));
  const jobs = persistedJobs(pluginData);
  assert.ok(jobs.length >= 1);
  const stateRoot = path.dirname(path.dirname(jobs[0].logFile));
  const id = `review-${crypto.randomBytes(12).toString("hex")}`;
  const isolatedHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(isolatedHome, "marker"), "retained\n", { mode: 0o600 });
  const stamped = new Date(Date.now() - 60_000).toISOString();
  const job = {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: retained privacy fixture",
    summary: "Running",
    write: false,
    status: "running",
    phase: "prompting",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: stamped,
    updatedAt: stamped,
    completedAt: null,
    workerProcess: { pid: 999999999, startToken: "dead-worker-token", nonce: "n", processGroupId: 999999999, commandMarker: id },
    providerProcess: { pid: 1, startToken: null, processGroupId: null },
    profile: { id: "review", transport: "headless" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: { prompt: null, target: { mode: "working-tree", label: "fixture", base: null } },
    result: { privacyWarning: "prior-privacy-signal" },
    error: null
  };
  fs.writeFileSync(path.join(stateRoot, "jobs", `${id}.json`), `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(job.logFile, "", { mode: 0o600 });

  const recovered = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.result.providerSessionDeleted, false);
  assert.match(recovered.result.privacyWarning, /prior-privacy-signal/);
  assert.match(recovered.result.privacyWarning, /Isolated review home retained/);
  assert.equal(fs.existsSync(isolatedHome), true);
});

test("successful later review re-cleanup clears prior privacy warning", () => {
  const root = initRepo();
  const { pluginData, env } = fixture();
  parseJson(runCompanion(["review", "--scope", "working-tree", "--json"], { cwd: root, env }));
  const jobs = persistedJobs(pluginData);
  assert.ok(jobs.length >= 1);
  const stateRoot = path.dirname(path.dirname(jobs[0].logFile));
  const id = `review-${crypto.randomBytes(12).toString("hex")}`;
  const isolatedHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(isolatedHome, "marker"), "to-remove\n", { mode: 0o600 });
  const stamped = new Date().toISOString();
  const job = {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: recleanup fixture",
    summary: "pass: fixture",
    write: false,
    status: "completed",
    phase: "done",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: stamped,
    updatedAt: stamped,
    completedAt: stamped,
    workerProcess: null,
    providerProcess: null,
    profile: { id: "review", transport: "headless" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: { prompt: null, target: { mode: "working-tree", label: "fixture", base: null } },
    result: {
      review: { verdict: "pass", summary: "fixture", findings: [] },
      providerSessionDeleted: false,
      privacyWarning: "earlier-cleanup-failed"
    },
    error: null
  };
  fs.writeFileSync(path.join(stateRoot, "jobs", `${id}.json`), `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(job.logFile, "", { mode: 0o600 });

  const cleaned = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
  assert.equal(cleaned.status, "completed");
  assert.equal(cleaned.result.providerSessionDeleted, true);
  assert.equal(cleaned.result.privacyWarning, undefined);
  assert.equal(fs.existsSync(isolatedHome), false);
});

test("terminal re-cleanup retains privacy until the full provider process group is gone", { skip: process.platform === "win32" }, async () => {
  const root = initRepo();
  const { pluginData, env } = fixture();
  parseJson(runCompanion(["review", "--scope", "working-tree", "--json"], { cwd: root, env }));
  const jobs = persistedJobs(pluginData);
  assert.ok(jobs.length >= 1);
  const stateRoot = path.dirname(path.dirname(jobs[0].logFile));
  const id = `review-${crypto.randomBytes(12).toString("hex")}`;
  const isolatedHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(isolatedHome, "marker"), "group-retained\n", { mode: 0o600 });

  // Detached leader starts a same-group descendant then exits → live group, no live leader.
  const leader = spawn(process.execPath, ["-e", [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: false, stdio: 'ignore' });",
    "child.unref();",
    "setTimeout(() => process.exit(0), 100);"
  ].join("")], { detached: true, stdio: "ignore" });
  leader.unref();
  const processGroupId = leader.pid;
  const leaderPid = leader.pid;
  try {
    await waitFor(() => processStartToken(leaderPid) === null && processGroupAlive(processGroupId), { timeoutMs: 5000 });
    assert.equal(processGroupAlive(processGroupId), true);
    assert.equal(processStartToken(leaderPid), null);

    const stamped = new Date(Date.now() - 60_000).toISOString();
    const job = {
      schemaVersion: 2,
      id,
      kind: "review",
      jobClass: "review",
      title: "review: live-group recleanup fixture",
      summary: "Running",
      write: false,
      status: "running",
      phase: "prompting",
      workspaceRoot: root,
      host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
      grokSessionId: null,
      createdAt: stamped,
      startedAt: stamped,
      updatedAt: stamped,
      completedAt: null,
      workerProcess: { pid: 999999999, startToken: "dead-worker-token", nonce: "n", processGroupId: 999999999, commandMarker: id },
      providerProcess: { pid: leaderPid, startToken: "dead-leader-token", processGroupId },
      profile: { id: "review", transport: "headless" },
      model: null,
      effort: null,
      logFile: path.join(stateRoot, "jobs", `${id}.log`),
      progress: null,
      request: { prompt: null, target: { mode: "working-tree", label: "fixture", base: null } },
      result: { privacyWarning: "prior-privacy-signal" },
      error: null
    };
    fs.writeFileSync(path.join(stateRoot, "jobs", `${id}.json`), `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(job.logFile, "", { mode: 0o600 });

    // Recovery 1: lost worker + dead leader with live group → fail closed privacy retention.
    const first = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
    assert.equal(first.status, "failed");
    assert.equal(first.error.code, "E_PROCESS_IDENTITY");
    assert.equal(first.result.providerSessionDeleted, false);
    assert.match(first.result.privacyWarning, /prior-privacy-signal/);
    assert.match(first.result.privacyWarning, /Isolated review home retained/);
    assert.equal(fs.existsSync(isolatedHome), true);
    assert.equal(processGroupAlive(processGroupId), true);

    // Recovery 2: terminal re-cleanup must still refuse while the group remains live.
    const second = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
    assert.equal(second.status, "failed");
    assert.equal(second.result.providerSessionDeleted, false);
    assert.match(second.result.privacyWarning, /prior-privacy-signal/);
    assert.match(second.result.privacyWarning, /Isolated review home retained/);
    assert.equal(fs.existsSync(isolatedHome), true);
    assert.equal(processGroupAlive(processGroupId), true);

    // After the full owned group is gone, a later recovery cleans and clears as intended.
    try { process.kill(-processGroupId, "SIGKILL"); } catch {}
    await waitFor(() => !processGroupAlive(processGroupId), { timeoutMs: 5000 });

    const cleaned = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
    assert.equal(cleaned.status, "failed");
    assert.equal(cleaned.result.providerSessionDeleted, true);
    assert.equal(cleaned.result.privacyWarning, undefined);
    assert.equal(fs.existsSync(isolatedHome), false);
  } finally {
    try { process.kill(-processGroupId, "SIGKILL"); } catch {}
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

test("Codex wrapper imports the captured current transcript through a privacy-filtered descriptor", () => {
  const root = fs.realpathSync(initRepo());
  const { fake, env } = fixture({ importSessionId: "12345678-1234-4234-8234-123456789abc" });
  const home = tempDir("grok-codex-transfer-home-");
  const codexHome = path.join(home, ".codex");
  const sessions = path.join(codexHome, "sessions", "2026", "07", "13");
  const pluginData = path.join(codexHome, "plugins", "data", "grok-grok-companion");
  const threadId = crypto.randomUUID();
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const source = path.join(sessions, `rollout-${threadId}.jsonl`);
  const records = [
    { timestamp: "2026-07-13T10:00:00.000Z", type: "session_meta", payload: { id: threadId, cwd: root, cli_version: "0.143.0" } },
    { timestamp: "2026-07-13T10:00:01.000Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "HIDDEN_DEVELOPER_TEXT" }] } },
    { timestamp: "2026-07-13T10:00:02.000Z", type: "event_msg", payload: { type: "user_message", message: "VISIBLE_CODEX_USER_TEXT" } },
    { timestamp: "2026-07-13T10:00:03.000Z", type: "response_item", payload: { type: "reasoning", summary: [{ text: "HIDDEN_REASONING_TEXT" }] } },
    { timestamp: "2026-07-13T10:00:04.000Z", type: "response_item", payload: { type: "function_call_output", output: "HIDDEN_TOOL_TEXT" } },
    { timestamp: "2026-07-13T10:00:05.000Z", type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "VISIBLE_CODEX_ASSISTANT_TEXT" } }
  ];
  fs.writeFileSync(source, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  writeCodexSessionMetadata(pluginData, { sessionId: threadId, transcriptPath: source, cwd: root });

  const transferEnv = {
    ...env,
    HOME: home,
    CODEX_HOME: codexHome,
    CODEX_THREAD_ID: threadId
  };
  delete transferEnv.CLAUDE_PLUGIN_DATA;
  delete transferEnv.GROK_COMPANION_CLAUDE_SESSION_ID;
  delete transferEnv.GROK_COMPANION_HOST;
  delete transferEnv.GROK_COMPANION_HOST_SESSION_ID;
  delete transferEnv.GROK_COMPANION_PLUGIN_DATA;

  const imported = parseJson(runCodexCompanion(["transfer", "--json"], { cwd: root, env: transferEnv }));
  assert.equal(imported.source, fs.realpathSync(source));
  assert.equal(imported.sourceFormat, "codex");
  assert.equal(imported.sessionId, "12345678-1234-4234-8234-123456789abc");
  const invocation = readFakeLog(fake.logFile).find((entry) => entry.event === "argv" && entry.args[0] === "import");
  assert.equal(invocation.args.includes(source), false);
  const importedInput = readFakeLog(fake.logFile).find((entry) => entry.event === "import-input");
  assert.ok(importedInput.bytes > 0);
  assert.notEqual(importedInput.bytes, fs.statSync(source).size, "raw Codex transcript was forwarded without filtering");
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

test("transfer preserves imported session identity when private alias cleanup fails", () => {
  const sessionId = "12345678-1234-4234-8234-123456789abc";
  const { root, source, env } = transferFixture({
    importSessionId: sessionId,
    importPoisonAlias: true
  });
  const result = runCompanion(["transfer", "--source", source, "--json"], { cwd: root, env });
  const error = parseError(result, "E_STATE");
  assert.match(error.message, /cleanup failed/i);
  assert.match(error.message, new RegExp(sessionId));
  assert.equal(error.details?.sessionId, sessionId);
  assert.equal(error.details?.resume, `grok --model grok-test --resume ${sessionId}`);
  assert.equal(error.details?.delete, `grok sessions delete ${sessionId}`);
  assert.ok(error.details?.privacyWarning || error.details?.warning, "privacy failure must remain explicit");
  assert.match(String(error.details?.privacyWarning || error.details?.warning), /\S/);
});
