import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";

import { generateId } from "../plugins/grok/scripts/lib/state.mjs";
import { installFakeGrok } from "./fake-grok.mjs";
import {
  COMPANION,
  initRepo,
  runCompanion,
  tempDir,
  testEnvironment,
  waitFor
} from "./helpers.mjs";

function taskReport() {
  return `GROK_WORKER_REPORT: ${JSON.stringify({
    outcome: "complete",
    summary: "ok",
    changedFiles: [],
    checksClaimed: [],
    acceptanceResults: [{ id: "AC-01", status: "met" }],
    risks: [],
    questions: []
  })}`;
}

function fixture(config = {}) {
  const fake = installFakeGrok(tempDir("fake-preprovider-rt-"), {
    taskText: taskReport(),
    ...config
  });
  const pluginData = tempDir("preprovider-rt-data-");
  const env = testEnvironment({ fake, pluginData });
  delete env.GROK_COMPANION_CHILD;
  delete env.GROK_COMPANION_JOB_MARKER;
  delete env.GROK_AGENT;
  delete env.GROK_LEADER_SOCKET;
  return { fake, pluginData, env };
}

function parseJson(result) {
  assert.equal(result.status, 0, `command failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function persistedJobs(pluginData) {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".json") && full.includes(`${path.sep}jobs${path.sep}`)) {
        out.push(JSON.parse(fs.readFileSync(full, "utf8")));
      }
    }
  };
  walk(pluginData);
  return out;
}

function persistedJob(pluginData, id) {
  const job = persistedJobs(pluginData).find((item) => item.id === id);
  assert.ok(job, `missing job ${id}`);
  return job;
}

function seedWorkspace(root, env) {
  parseJson(runCompanion(["review", "--scope", "working-tree", "--json"], { cwd: root, env }));
  const jobs = persistedJobs(env.CLAUDE_PLUGIN_DATA);
  assert.ok(jobs.length >= 1);
  return path.dirname(path.dirname(jobs[0].logFile));
}

function writeSeededJob(stateRoot, job) {
  fs.writeFileSync(
    path.join(stateRoot, "jobs", `${job.id}.json`),
    `${JSON.stringify(job, null, 2)}\n`,
    { mode: 0o600 }
  );
  fs.writeFileSync(job.logFile, "", { mode: 0o600 });
}

test("unauthenticated review worker cannot write pendingTerminal", {
  skip: process.platform === "win32",
  timeout: 20_000
}, async () => {
  const root = initRepo();
  const { env, pluginData } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const isolatedHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  const stamped = new Date(Date.now() - 60_000).toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: unauth worker",
    summary: "Running",
    write: false,
    status: "running",
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
    profile: { id: "review", transport: "headless" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: {
      prompt: "PROMPT_MUST_BE_SCRUBBED_IF_PRESENT",
      target: { mode: "working-tree", label: "fixture", base: null }
    },
    result: null,
    error: null
  });

  const worker = runCompanion(["--worker", id, "--cwd", root], {
    cwd: root,
    env: { ...env, GROK_COMPANION_WORKER_NONCE: crypto.randomBytes(16).toString("hex") },
    timeout: 15_000
  });
  assert.notEqual(worker.status, 0);
  assert.equal(persistedJob(pluginData, id).pendingTerminal, undefined);

  const recovered = await waitFor(() => {
    const result = runCompanion(["status", id, "--json"], { cwd: root, env });
    if (result.status !== 0) return false;
    const job = JSON.parse(result.stdout);
    return job.status === "failed" ? job : false;
  }, { timeoutMs: 15_000 });

  assert.equal(recovered.error.code, "E_WORKER_LOST");
  assert.match(recovered.error.message, /before provider start|re-run|replay/i);
  assert.equal(persistedJob(pluginData, id).result?.replay, false);
  assert.equal(fs.existsSync(isolatedHome), false);
  assert.equal(JSON.stringify(recovered).includes("PROMPT_MUST_BE_SCRUBBED_IF_PRESENT"), false);
});

test("authorized review worker records pre-provider failure intent", {
  skip: process.platform === "win32",
  timeout: 20_000
}, async () => {
  const root = initRepo();
  const { env, pluginData } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const nonce = crypto.randomBytes(16).toString("hex");
  const stamped = new Date().toISOString();
  // Matching launch auth, but no prompt — execute fails after provisional bind.
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: authorized pre-provider fail",
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
    workerAuthorization: nonce,
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

  const worker = runCompanion(["--worker", id, "--cwd", root], {
    cwd: root,
    env: { ...env, GROK_COMPANION_WORKER_NONCE: nonce },
    timeout: 15_000
  });
  assert.notEqual(worker.status, 0);
  const after = persistedJob(pluginData, id);
  assert.ok(after.pendingTerminal?.error?.code);
  assert.notEqual(after.pendingTerminal.error.code, "E_WORKER_LOST");
});

test("review pre-provider silent loss uses stage-aware E_WORKER_LOST", {
  skip: process.platform === "win32"
}, () => {
  const root = initRepo();
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const isolatedHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  const stamped = new Date(Date.now() - 60_000).toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: silent pre-provider loss",
    summary: "Running",
    write: false,
    status: "running",
    phase: "queued",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: null,
    createdAt: stamped,
    startedAt: null,
    updatedAt: stamped,
    completedAt: null,
    workerProcess: {
      pid: 999999991,
      startToken: "dead-worker-token",
      nonce: "n",
      processGroupId: 999999991,
      commandMarker: id
    },
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
  const recovered = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.error.code, "E_WORKER_LOST");
  assert.match(recovered.error.message, /before provider start/i);
  assert.equal(fs.existsSync(isolatedHome), false);
});

test("review worker provisionally authorizes before workerProcess is published", {
  skip: process.platform === "win32",
  timeout: 30_000
}, async () => {
  const root = initRepo();
  const { env, pluginData } = fixture({ headlessDelayMs: 60_000 });
  const stateRoot = seedWorkspace(root, env);
  fs.appendFileSync(path.join(root, "tracked.txt"), "provisional-auth\n", "utf8");
  const id = generateId("review");
  const nonce = crypto.randomBytes(16).toString("hex");
  const stamped = new Date().toISOString();
  const logFile = path.join(stateRoot, "jobs", `${id}.log`);
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: provisional auth",
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
    workerAuthorization: nonce,
    workerProcess: null,
    providerProcess: null,
    profile: { id: "review", transport: "headless" },
    model: null,
    effort: null,
    logFile,
    progress: null,
    request: {
      prompt: "review provisional",
      target: { mode: "working-tree", label: "fixture", base: null }
    },
    result: null,
    error: null
  });

  const child = spawn(process.execPath, [COMPANION, "--worker", id, "--cwd", root], {
    cwd: root,
    env: { ...env, GROK_COMPANION_WORKER_NONCE: nonce },
    detached: true,
    stdio: "ignore"
  });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const started = await waitFor(() => {
    const job = persistedJob(pluginData, id);
    return job?.startedAt ? job : false;
  }, { timeoutMs: 10_000 });
  assert.ok(started.startedAt);
  assert.ok(started.workerProcess?.startToken);
  assert.equal(started.workerAuthorization, null);
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  try { process.kill(child.pid, "SIGKILL"); } catch {}
});

test("review provisional auth rejects foreign workerProcess pid", {
  skip: process.platform === "win32",
  timeout: 20_000
}, async () => {
  const root = initRepo();
  const { env, pluginData } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const nonce = crypto.randomBytes(16).toString("hex");
  const stamped = new Date().toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: foreign pid",
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
    workerAuthorization: nonce,
    workerProcess: {
      pid: 1,
      startToken: "foreign",
      nonce,
      processGroupId: 1,
      commandMarker: id
    },
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

  const worker = runCompanion(["--worker", id, "--cwd", root], {
    cwd: root,
    env: { ...env, GROK_COMPANION_WORKER_NONCE: nonce },
    timeout: 15_000
  });
  assert.notEqual(worker.status, 0);
  const stored = persistedJob(pluginData, id);
  assert.equal(stored.startedAt, null);
  assert.equal(stored.pendingTerminal, undefined);
  assert.equal(stored.workerProcess.pid, 1);
});

test("aged unbound review without workerProcess is recovered as failed", {
  skip: process.platform === "win32"
}, () => {
  const root = initRepo();
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const stamped = new Date(Date.now() - 10_000).toISOString();
  // Authorization must already be revoked; otherwise launch is still capable.
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: orphan unbound",
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
    profile: { id: "review", transport: "headless" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: { prompt: null, target: { mode: "working-tree", label: "fixture", base: null } },
    result: null,
    error: null
  });
  const recovered = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.error.code, "E_WORKER_LOST");
  assert.match(recovered.error.message, /before provider start|re-run|replay/i);
});

test("young unbound review remains queued during launch grace", {
  skip: process.platform === "win32"
}, () => {
  const root = initRepo();
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const stamped = new Date().toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 2,
    id,
    kind: "review",
    jobClass: "review",
    title: "review: young unbound",
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
    profile: { id: "review", transport: "headless" },
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: { prompt: null, target: { mode: "working-tree", label: "fixture", base: null } },
    result: null,
    error: null
  });
  const recovered = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
  assert.equal(recovered.status, "queued");
  assert.equal(recovered.error, null);
});
