import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { processGroupAlive, processStartToken } from "../plugins/grok/scripts/lib/process-control.mjs";
import { hasForeignActiveProvider, registerProviderGuard, unregisterProviderGuard } from "../plugins/grok/scripts/lib/recursion-guard.mjs";
import { generateId, logFile, readJob, updateJob, writeJob } from "../plugins/grok/scripts/lib/state.mjs";
import { profileFor } from "../plugins/grok/scripts/lib/profiles.mjs";
import { workspaceState } from "../plugins/grok/scripts/lib/workspace.mjs";
import { CompanionError, attachTransferCleanupEvidence, asErrorPayload } from "../plugins/grok/scripts/lib/errors.mjs";
import { redact } from "../plugins/grok/scripts/lib/redact.mjs";
import { spawnReadOnlyWorker } from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import { buildTaskEnvelope, scrubStoredJob } from "../plugins/grok/scripts/lib/task-contract.mjs";
import { launchContractDigest } from "../plugins/grok/scripts/lib/worker-launch-contract.mjs";

import { installFakeGrok, readFakeLog } from "./fake-grok.mjs";
import {
  CODEX_COMPANION,
  COMPANION,
  initRepo,
  runCodexCompanion,
  runCompanion,
  spawnNonblockingStdin,
  tempDir,
  testEnvironment,
  waitFor
} from "./helpers.mjs";
import { pluginDataRoot, writeCodexSessionMetadata } from "../plugins/grok/scripts/lib/host.mjs";

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

function taskReport(summary = "Fake Grok task completed", acceptanceIds = ["AC-01", "AC-02"]) {
  return `GROK_WORKER_REPORT: ${JSON.stringify({
    outcome: "complete",
    summary,
    changedFiles: [],
    checksClaimed: [],
    acceptanceResults: acceptanceIds.map((id) => ({ id, status: "met" })),
    risks: [],
    questions: []
  })}`;
}

function fixture(config = {}) {
  const fake = installFakeGrok(tempDir("fake-grok-runtime-"), {
    taskText: taskReport(),
    ...config
  });
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

test("a failed setup attempt revokes the previously published provider capability", () => {
  const root = initRepo();
  const readyFixture = fixture();
  const ready = parseJson(runCompanion(["setup", "--json"], { cwd: root, env: readyFixture.env }));
  assert.equal(ready.ready, true);
  const receipt = path.join(
    pluginDataRoot(readyFixture.env),
    "capabilities",
    "provider-capability-v1.json"
  );
  assert.equal(fs.existsSync(receipt), true);

  const failedFake = installFakeGrok(tempDir("fake-grok-setup-revocation-"), {
    helpText: "Usage: grok --sandbox PROFILE\n"
  });
  const failedEnv = {
    ...readyFixture.env,
    GROK_BIN: failedFake.binary,
    GROK_AUTH_PATH: failedFake.authPath
  };
  const failed = parseJson(runCompanion(["setup", "--json"], { cwd: root, env: failedEnv }));
  assert.equal(failed.ready, false);
  assert.equal(failed.grok.error.code, "E_CAPABILITY");
  assert.equal(fs.existsSync(receipt), false);
});

function transferFixture(config = {}) {
  const root = initRepo();
  const runtime = fixture(config);
  const home = tempDir("grok-transfer-home-");
  const projects = path.join(home, ".claude", "projects", "fixture");
  fs.mkdirSync(projects, { recursive: true });
  const source = path.join(projects, "session.jsonl");
  fs.writeFileSync(source, '{"type":"user"}\n', "utf8");
  return { root, source, home, ...runtime, env: { ...runtime.env, HOME: home } };
}

test("transfer helpers format model-qualified resume and parse non-isolated models text", async () => {
  const {
    formatResumeCommand,
    parseAdvertisedModels,
    selectTransferModel,
    assertTransferEffort,
    isImportedSessionReady,
    waitForImportedSession
  } = await import("../plugins/grok/scripts/lib/grok-provider.mjs");
  const { installFakeGrok, readFakeLog } = await import("./fake-grok.mjs");

  assert.equal(
    formatResumeCommand("12345678-1234-4234-8234-123456789abc", "grok-4.5"),
    "grok --model grok-4.5 --resume 12345678-1234-4234-8234-123456789abc"
  );
  assert.equal(
    formatResumeCommand("12345678-1234-4234-8234-123456789abc", "grok-4.5", "high"),
    "grok --model grok-4.5 --reasoning-effort high --resume 12345678-1234-4234-8234-123456789abc"
  );

  const models = parseAdvertisedModels(`
You are logged in with grok.com.

Default model: grok-primary

Available models:
  * grok-primary (default) efforts=low,medium,high
  - grok-secondary efforts=low
`);
  assert.deepEqual(models.map((item) => item.id), ["grok-primary", "grok-secondary"]);
  assert.deepEqual(models[0].efforts, ["low", "medium", "high"]);
  assert.equal(selectTransferModel(models).id, "grok-primary");
  assert.equal(selectTransferModel(models, "grok-secondary").id, "grok-secondary");
  assert.throws(
    () => selectTransferModel(models, "missing"),
    (error) => error?.code === "E_CAPABILITY"
  );
  assert.throws(
    () => assertTransferEffort(models[1], "high"),
    (error) => error?.code === "E_CAPABILITY" && /effort high/i.test(error.message)
  );
  assertTransferEffort(models[0], "high");

  const sessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const fake = installFakeGrok(tempDir("fake-grok-ready-"), {
    importSessionId: sessionId,
    importReadyAfterMs: 80
  });
  // Simulate a completed import registration without running transfer end-to-end.
  const storePath = `${fake.binary}.sessions.json`;
  fs.writeFileSync(storePath, JSON.stringify({
    sessions: [{ id: sessionId, readyAt: Date.now(), neverReady: true }]
  }), "utf8");
  assert.equal(isImportedSessionReady(sessionId, fake.binary), false);
  const publish = setTimeout(() => fs.writeFileSync(storePath, JSON.stringify({
    sessions: [{ id: sessionId, readyAt: Date.now(), neverReady: false }]
  }), "utf8"), 80);
  try {
    await waitForImportedSession(sessionId, {
      binary: fake.binary,
      timeoutMs: 1500,
      intervalMs: 30
    });
  } finally {
    clearTimeout(publish);
  }
  assert.equal(isImportedSessionReady(sessionId, fake.binary), true);
  const listEvents = readFakeLog(fake.logFile).filter((entry) => entry.event === "sessions-list");
  assert.ok(listEvents.length >= 2);

  fs.writeFileSync(storePath, JSON.stringify({
    sessions: [{ id: sessionId, readyAt: Date.now(), neverReady: true }]
  }), "utf8");
  await assert.rejects(
    () => waitForImportedSession(sessionId, { binary: fake.binary, timeoutMs: 120, intervalMs: 30 }),
    (error) => error?.code === "E_IMPORT_RESULT" && /not yet observable/i.test(error.message)
  );
});

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

function persistedJob(pluginData, id) {
  const value = persistedJobs(pluginData).find((job) => job.id === id);
  assert.ok(value, `missing persisted job ${id}`);
  return value;
}

function writeEnvelope(userRequest, overrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    userRequest,
    objective: userRequest,
    mode: "write",
    scope: { include: ["tracked.txt"], exclude: [] },
    context: {
      facts: [],
      constraints: [],
      expectedProjectMarkers: [],
      requiredPaths: ["tracked.txt"],
      workspaceState: "task_scoped",
      upstreamFreshness: "not_checked"
    },
    nonGoals: [],
    acceptanceCriteria: [{ id: "AC-01", text: "Complete the fixture task" }],
    requiredVerification: [],
    ...overrides
  });
}

test("empty review target records a skipped empty-target result without claiming session deletion", () => {
  const root = initRepo();
  const { env } = fixture();
  const result = runCompanion(["review", "--scope", "working-tree", "--json"], { cwd: root, env });
  const job = parseJson(result);
  assert.equal(job.status, "completed");
  assert.equal(job.phase, "done");
  assert.equal(Object.hasOwn(job, "grokSessionId"), false);
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
  const { fake, env, pluginData } = fixture({
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
  assert.equal(job.profileId, "review-v1");
  assert.equal(job.result.review.verdict, "needs_changes");
  assert.equal(job.result.providerSessionDeleted, true);
  assert.equal(fs.readFileSync(path.join(root, "tracked.txt"), "utf8"), before);
  const stored = persistedJob(pluginData, job.id);
  assert.equal(stored.request.prompt, null);
  assert.match(stored.request.promptDigest, /^[a-f0-9]{64}$/);

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
  const persistedLog = fs.readFileSync(stored.logFile, "utf8");
  assert.equal(persistedLog.includes(secret), false);

  const human = runCompanion(["result", job.id], { cwd: root, env });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Verdict: needs_changes/);
  assert.match(human.stdout, /\[HIGH\] Fake finding \(tracked\.txt:1\)/);
});

test("runtime write task forwards model and effort under the write security profile", () => {
  const root = initRepo();
  const { fake, env, pluginData } = fixture({ taskText: taskReport("Implemented the requested fake change and ran tests.", ["AC-01"]) });
  const result = runCompanion(
    ["task", "--wait", "--write", "--model", "grok-test", "--effort", "high", "--envelope-stdin", "--json"],
    { cwd: root, env, input: writeEnvelope("implement fixture") }
  );
  const job = parseJson(result);
  const stored = persistedJob(pluginData, job.id);
  assert.equal(job.kind, "task");
  assert.equal(job.status, "completed");
  assert.equal(job.write, true);
  assert.equal(job.model, "grok-test");
  assert.equal(job.effort, "high");
  assert.equal(job.profileId, "rescue-write-v3");
  assert.equal(stored.profile.transport, "acp");
  assert.equal(stored.profile.agent, "build");
  assert.equal(stored.profile.sandbox, "strict");
  assert.equal(stored.profile.permissionMode, "acceptEdits");
  assert.match(stored.result.text, /Implemented the requested fake change and ran tests\./);
  assert.equal(stored.request.prompt, null);
  assert.match(stored.request.promptDigest, /^[a-f0-9]{64}$/);
  assert.ok(stored.providerProcess.pid > 0);
  assert.ok(stored.grokSessionId);

  const providerLog = readFakeLog(fake.logFile);
  const invocation = providerLog.find(
    (entry) => entry.event === "argv" && entry.args.includes("agent")
  );
  assert.match(invocation.args[invocation.args.indexOf("--sandbox") + 1], /^companion_[a-f0-9]{20}$/);
  assert.ok(invocation.args.includes("acceptEdits"));
  assert.equal(invocation.args.includes("--always-approve"), false);
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

test("successful task storage digests duplicate private objectives and preserves a distinct public objective", () => {
  const root = initRepo();
  const { env, pluginData } = fixture({ taskText: taskReport("Stored request privacy complete", ["AC-01"]) });
  const privateRequest = "private terminal request literal 8de43c3f";
  const expectedDigest = crypto.createHash("sha256").update(privateRequest).digest("hex");
  const launchEnvelope = buildTaskEnvelope({ userRequest: privateRequest, objective: privateRequest });
  const launchJob = {
    id: "task-launch-privacy",
    kind: "task",
    jobClass: "task",
    write: false,
    title: privateRequest,
    host: { kind: "codex", sessionId: "privacy-test-thread" },
    controlWorkspaceId: "privacy-test-workspace",
    profile: null,
    role: null,
    model: null,
    effort: null,
    request: {
      prompt: "assembled provider prompt",
      promptDigest: null,
      providerPromptDigest: crypto.createHash("sha256").update("assembled provider prompt").digest("hex"),
      publicObjective: privateRequest,
      envelope: launchEnvelope,
      spawn: {}
    }
  };
  const scrubbedLaunchJob = scrubStoredJob(launchJob);
  assert.equal(launchContractDigest(scrubbedLaunchJob), launchContractDigest(launchJob));
  assert.equal(scrubbedLaunchJob.title, `task:${expectedDigest.slice(0, 24)}`);

  const duplicate = parseJson(runCompanion(
    ["task", "--wait", "--write", "--envelope-stdin", "--json"],
    { cwd: root, env, input: writeEnvelope(privateRequest) }
  ));
  assert.equal(duplicate.status, "completed");
  const duplicateStored = persistedJob(pluginData, duplicate.id);
  assert.equal(duplicateStored.request.prompt, null);
  assert.match(duplicateStored.request.promptDigest, /^[a-f0-9]{64}$/);
  assert.equal(duplicateStored.request.envelope.userRequest, null);
  assert.equal(duplicateStored.request.envelope.userRequestDigest, expectedDigest);
  assert.equal(duplicateStored.request.envelope.objective, expectedDigest);
  assert.equal(duplicateStored.request.publicObjective, null);
  assert.equal(duplicateStored.title, `task:${expectedDigest.slice(0, 24)}`);
  assert.equal(JSON.stringify(duplicateStored).includes(privateRequest), false);

  const publicObjective = "Summarize the bounded fixture change";
  const distinct = parseJson(runCompanion(
    ["task", "--wait", "--write", "--envelope-stdin", "--json"],
    { cwd: root, env, input: writeEnvelope(privateRequest, { objective: publicObjective }) }
  ));
  assert.equal(distinct.status, "completed");
  const distinctStored = persistedJob(pluginData, distinct.id);
  assert.equal(distinctStored.request.envelope.userRequest, null);
  assert.equal(distinctStored.request.envelope.userRequestDigest, expectedDigest);
  assert.equal(distinctStored.request.envelope.objective, publicObjective);
  assert.equal(distinctStored.request.publicObjective, publicObjective);
  assert.equal(distinctStored.title, publicObjective);
  assert.equal(JSON.stringify(distinctStored).includes(privateRequest), false);
});

test("resume candidates preserve read/write profiles and never escalate an existing session", () => {
  const root = initRepo();
  const { fake, env, pluginData } = fixture({
    taskTexts: [
      taskReport("Profile-specific read result."),
      taskReport("Profile-specific write result.", ["AC-01"]),
      taskReport("Profile-specific resumed write result.", ["AC-01"])
    ]
  });

  const read = parseJson(runCompanion(
    ["task", "--wait", "--fresh", "read-only investigation", "--json"],
    { cwd: root, env }
  ));
  assert.equal(read.profileId, "rescue-read-v3");
  const readCandidate = parseJson(runCompanion(["task-resume-candidate", "--json"], { cwd: root, env }));
  assert.deepEqual(readCandidate, {
    available: true,
    jobId: read.id,
    profileId: "rescue-read-v3"
  });

  const escalated = runCompanion(
    ["task", "--wait", "--write", "--resume", "--envelope-stdin", "--json"],
    { cwd: root, env, input: writeEnvelope("attempt privilege escalation") }
  );
  parseError(escalated, "E_NO_RESUME_CANDIDATE");

  const write = parseJson(runCompanion(
    ["task", "--wait", "--write", "--fresh", "--envelope-stdin", "--json"],
    { cwd: root, env, input: writeEnvelope("write-profile implementation") }
  ));
  assert.equal(write.profileId, "rescue-write-v3");
  const storedWrite = persistedJob(pluginData, write.id);
  const writeCandidate = parseJson(runCompanion(["task-resume-candidate", "--write", "--json"], { cwd: root, env }));
  assert.deepEqual(writeCandidate, {
    available: true,
    jobId: write.id,
    profileId: "rescue-write-v3"
  });

  const resumed = parseJson(runCompanion(
    ["task", "--wait", "--write", "--resume", "--envelope-stdin", "--json"],
    { cwd: root, env, input: writeEnvelope("continue write-profile work") }
  ));
  const storedResumed = persistedJob(pluginData, resumed.id);
  assert.equal(storedResumed.grokSessionId, storedWrite.grokSessionId);
  assert.equal(storedResumed.request.resumeSessionId, storedWrite.grokSessionId);
  assert.ok(readFakeLog(fake.logFile).some((entry) =>
    entry.event === "rpc" && entry.message.method === "session/load" && entry.message.params.sessionId === storedWrite.grokSessionId
  ));
});

function seedTerminalTaskJob(root, env, { status, grokSessionId, write = false, id = generateId("task") }) {
  // Align plugin-data roots with the companion env so writeJob and task-resume-candidate
  // share the same workspace state (prefer CLAUDE_PLUGIN_DATA from the fixture).
  const keys = ["CLAUDE_PLUGIN_DATA", "GROK_COMPANION_PLUGIN_DATA", "PLUGIN_DATA"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.CLAUDE_PLUGIN_DATA = env.CLAUDE_PLUGIN_DATA;
  process.env.GROK_COMPANION_PLUGIN_DATA = env.CLAUDE_PLUGIN_DATA;
  delete process.env.PLUGIN_DATA;
  try {
    const timestamp = new Date().toISOString();
    const profile = profileFor("task", write);
    writeJob(root, {
      schemaVersion: 2,
      id,
      kind: "task",
      jobClass: "task",
      title: `seeded ${status} task`,
      summary: status,
      write,
      status,
      phase: status,
      workspaceRoot: root,
      host: {
        kind: env.GROK_COMPANION_HOST || "claude-code",
        sessionId: env.GROK_COMPANION_HOST_SESSION_ID || env.GROK_COMPANION_CLAUDE_SESSION_ID
      },
      grokSessionId,
      createdAt: timestamp,
      startedAt: timestamp,
      updatedAt: timestamp,
      completedAt: ["queued", "running"].includes(status) ? null : timestamp,
      workerProcess: null,
      providerProcess: null,
      profile,
      model: null,
      effort: null,
      logFile: logFile(root, id),
      progress: null,
      request: { prompt: null, resumeSessionId: null },
      result: status === "completed" ? { text: "seeded" } : null,
      error: status === "failed" ? { code: "E_PROVIDER_EXIT", message: "seeded failure" } : null
    });
    return id;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("resume candidates accept failed and cancelled terminal tasks with a Grok session id", () => {
  {
    // realpath so workspaceState hash matches companion's workspaceRoot resolution
    const root = fs.realpathSync(initRepo());
    const { env } = fixture();
    const failedSession = "11111111-1111-4111-8111-111111111111";
    const failedId = seedTerminalTaskJob(root, env, { status: "failed", grokSessionId: failedSession });
    const candidate = parseJson(runCompanion(["task-resume-candidate", "--json"], { cwd: root, env }));
    assert.deepEqual(candidate, {
      available: true,
      jobId: failedId,
      profileId: "rescue-read-v3"
    });
  }

  {
    const root = fs.realpathSync(initRepo());
    const { env } = fixture();
    const cancelledSession = "22222222-2222-4222-8222-222222222222";
    const cancelledId = seedTerminalTaskJob(root, env, {
      status: "cancelled",
      grokSessionId: cancelledSession
    });
    const candidate = parseJson(runCompanion(["task-resume-candidate", "--json"], { cwd: root, env }));
    assert.deepEqual(candidate, {
      available: true,
      jobId: cancelledId,
      profileId: "rescue-read-v3"
    });
  }
});

test("resume candidates reject queued and running tasks even when a Grok session id is present", () => {
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  seedTerminalTaskJob(root, env, {
    status: "queued",
    grokSessionId: "33333333-3333-4333-8333-333333333333"
  });
  seedTerminalTaskJob(root, env, {
    status: "running",
    grokSessionId: "44444444-4444-4444-8444-444444444444"
  });

  const candidate = parseJson(runCompanion(["task-resume-candidate", "--json"], { cwd: root, env }));
  assert.deepEqual(candidate, {
    available: false,
    jobId: null,
    profileId: null
  });

  const resume = runCompanion(
    ["task", "--wait", "--resume", "should not resume active work", "--json"],
    { cwd: root, env }
  );
  parseError(resume, "E_NO_RESUME_CANDIDATE");
});

test("explicit resume completes pending lineage cleanup before provider admission", () => {
  const root = fs.realpathSync(initRepo());
  const { env, pluginData } = fixture();
  const first = parseJson(runCompanion(["task", "--wait", "seed resumable cleanup lineage", "--json"], { cwd: root, env }));
  const stored = persistedJob(pluginData, first.id);
  const stateRoot = path.dirname(path.dirname(stored.logFile));
  const taskHome = path.join(stateRoot, "task-homes", stored.request.providerHomeId, ".grok");
  fs.mkdirSync(path.join(taskHome, "agent-profiles"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(taskHome, "auth.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(taskHome, "agent-profiles", "pending.md"), "profile\n", { mode: 0o600 });
  const jobFile = path.join(stateRoot, "jobs", `${first.id}.json`);
  fs.writeFileSync(jobFile, `${JSON.stringify({
    ...stored,
    result: { ...(stored.result || {}), taskRuntimeCleaned: false, privacyWarning: "cleanup pending" }
  }, null, 2)}\n`, { mode: 0o600 });

  const resumed = parseJson(runCompanion(["task", "--wait", "--job-id", first.id, "continue after cleanup", "--json"], { cwd: root, env }));
  assert.equal(resumed.resumeJobId, first.id);
  assert.equal(resumed.status, "completed");
  assert.equal(persistedJob(pluginData, first.id).result.taskRuntimeCleaned, true);
  assert.equal(fs.existsSync(path.join(taskHome, "auth.json")), false);
  assert.equal(fs.existsSync(path.join(taskHome, "agent-profiles")), false);
});

test("concurrent read-only continuations admit only one job per provider lineage", { skip: process.platform === "win32" }, async () => {
  const root = fs.realpathSync(initRepo());
  const { fake, pluginData, env } = fixture({ cancelMode: "wait" });
  const priorId = seedTerminalTaskJob(root, env, {
    status: "completed",
    grokSessionId: "55555555-5555-4555-8555-555555555555"
  });
  const args = ["task", "--background", "--job-id", priorId, "continue shared lineage", "--json"];
  const first = spawnCompanion(args, { cwd: root, env });
  const second = spawnCompanion(args, { cwd: root, env });
  const outcomes = await Promise.all([first.completed, second.completed]);
  const successes = outcomes.filter((outcome) => outcome.code === 0);
  const failures = outcomes.filter((outcome) => outcome.code !== 0);
  assert.equal(successes.length, 1, JSON.stringify(outcomes));
  assert.equal(failures.length, 1, JSON.stringify(outcomes));
  const rejected = JSON.parse(failures[0].stdout);
  assert.equal(rejected.error?.code, "E_JOB_ACTIVE");
  assert.equal(rejected.error?.details?.conflictingProviderHomeId, priorId);

  const started = JSON.parse(successes[0].stdout);
  const running = await waitFor(() => {
    const job = persistedJob(pluginData, started.id);
    return job.status === "running" && job.providerProcess?.pid ? job : false;
  }, { timeoutMs: 10_000 });
  assert.equal(running.request.providerHomeId, priorId);
  const providerStarts = await waitFor(() => {
    const starts = readFakeLog(fake.logFile).filter((entry) => entry.event === "argv" && entry.args.includes("agent") && entry.args.includes("stdio"));
    return starts.length === 1 ? starts : false;
  }, { timeoutMs: 5000 });
  assert.equal(providerStarts.length, 1, "rejected continuation launched a second provider");

  const cancelled = parseJson(runCompanion(["cancel", started.id, "--json"], { cwd: root, env, timeout: 15_000 }));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.result?.taskRuntimeCleaned, true);
  const stored = persistedJob(pluginData, started.id);
  const grokHome = path.join(path.dirname(path.dirname(stored.logFile)), "task-homes", priorId, ".grok");
  assert.equal(fs.existsSync(path.join(grokHome, "auth.json")), false);
  assert.equal(fs.existsSync(path.join(grokHome, "agent-profiles")), false);
});

test("three independent Codex read envelopes run concurrently with isolated provider profiles", { skip: process.platform === "win32" }, async () => {
  const root = fs.realpathSync(initRepo());
  const { fake, pluginData, env } = fixture({
    delayMs: 1500,
    requireAgentProfileUnderGrokHome: true
  });
  const dispatches = ["stdin", "profile", "lifecycle"].map((slice) => {
    const dispatch = spawnNonblockingStdin(
      CODEX_COMPANION,
      ["task", "--background", "--envelope-stdin", "--stdin-ready", "--fresh", "--json"],
      { cwd: root, env, timeout: 20_000 }
    );
    return { slice, dispatch };
  });

  await waitFor(
    () => dispatches.every(({ dispatch }) => dispatch.stderr.includes("GROK_COMPANION_STDIN_READY")),
    { timeoutMs: 5000 }
  );
  assert.equal(
    readFakeLog(fake.logFile).filter((entry) => entry.event === "argv" && entry.args.includes("agent") && entry.args.includes("stdio")).length,
    0,
    "a provider started before its private TaskEnvelope arrived"
  );

  for (const { slice, dispatch } of dispatches) {
    dispatch.child.stdin.end(writeEnvelope(`inspect ${slice}`, {
      mode: "read",
      scope: { include: ["tracked.txt"], exclude: [] },
      acceptanceCriteria: [
        { id: "AC-01", text: `Inspect the ${slice} slice` },
        { id: "AC-02", text: "Return a structured read-only report" }
      ]
    }));
  }
  const accepted = await Promise.all(dispatches.map(({ dispatch }) => dispatch.completed));
  assert.ok(accepted.every((outcome) => outcome.code === 0), JSON.stringify(accepted));
  const jobIds = accepted.map((outcome) => JSON.parse(outcome.stdout).id);
  assert.equal(new Set(jobIds).size, 3);

  const overlapping = await waitFor(() => {
    const jobs = jobIds.map((id) => persistedJob(pluginData, id));
    return jobs.every((job) => job.status === "running" && job.providerProcess?.pid) ? jobs : false;
  }, { timeoutMs: 10_000 });
  assert.equal(new Set(overlapping.map((job) => job.request.providerHomeId)).size, 3);

  const terminal = await waitFor(() => {
    const jobs = jobIds.map((id) => persistedJob(pluginData, id));
    return jobs.every((job) => ["completed", "failed", "cancelled"].includes(job.status)) ? jobs : false;
  }, { timeoutMs: 20_000 });
  for (const job of terminal) {
    assert.equal(job.status, "completed", JSON.stringify(job.error));
    assert.equal(job.error, null);
    assert.equal(job.result?.workerReport?.outcome, "complete");
    assert.equal(job.result?.taskRuntimeCleaned, true);
    assert.deepEqual(job.result?.runtimeEvidence?.observedChangedPaths, []);
  }

  const profiles = readFakeLog(fake.logFile).filter((entry) => entry.event === "agent-profile");
  assert.equal(profiles.length, 3);
  assert.equal(new Set(profiles.map((entry) => entry.path)).size, 3);
  for (const profile of profiles) {
    assert.equal(profile.exists, true);
    assert.equal(profile.insideGrokHome, true);
    assert.equal(profile.mode, 0o600);
    assert.equal(fs.existsSync(profile.path), false, "provider profile remained after verified job cleanup");
  }
});

test("background task is durable across command processes and supports status, wait, and result", () => {
  const root = initRepo();
  const { env, pluginData } = fixture({ taskText: taskReport("Background fake result"), delayMs: 250 });
  const launch = parseJson(runCompanion(
    ["task", "--background", "background fixture", "--json"],
    { cwd: root, env }
  ));
  assert.equal(launch.status, "queued");
  assert.equal(Object.hasOwn(launch, "workerProcess"), false);

  const waited = parseJson(runCompanion(
    ["status", launch.id, "--wait", "--timeout-ms", "10000", "--json"],
    { cwd: root, env, timeout: 15000 }
  ));
  assert.equal(waited.status, "completed");
  const stored = persistedJob(pluginData, launch.id);
  assert.match(stored.result.text, /Background fake result/);
  assert.equal(stored.request.prompt, null);
  assert.match(stored.request.promptDigest, /^[a-f0-9]{64}$/);

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
  const { env, pluginData } = fixture({ taskText: taskReport(`Completed safely; provider token was ${secret}.`) });
  const immediate = runCompanion(["task", "--wait", "redaction fixture", "--json"], { cwd: root, env });
  const job = parseJson(immediate);
  assert.match(persistedJob(pluginData, job.id).result.text, /Completed safely/);

  const jsonResult = runCompanion(["result", job.id, "--json"], { cwd: root, env });
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  const humanResult = runCompanion(["result", job.id], { cwd: root, env });
  assert.equal(humanResult.status, 0, humanResult.stderr);
  const stored = persistedJob(pluginData, job.id);
  const persisted = `${fs.readFileSync(stored.logFile, "utf8")}\n${fs.readFileSync(path.join(path.dirname(stored.logFile), `${job.id}.json`), "utf8")}`;

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

function codexBrokerFixture() {
  const runtime = fixture();
  const threadId = "codex-broker-runtime-session";
  return {
    ...runtime,
    threadId,
    env: {
      ...runtime.env,
      GROK_COMPANION_HOST: "codex",
      GROK_COMPANION_HOST_SESSION_ID: threadId,
      CODEX_THREAD_ID: threadId
    }
  };
}

function spawnPendingBrokerJob(root, { env, threadId }, idempotencyKey) {
  return spawnReadOnlyWorker({
    root,
    principal: { threadId, source: "codex" },
    envelope: buildTaskEnvelope({
      userRequest: "Inspect the repository without writing files.",
      mode: "read"
    }),
    idempotencyKey,
    env
  });
}

test("legacy CLI recovery preserves broker jobs at every unsettled launch boundary", () => {
  const root = fs.realpathSync(initRepo());
  const runtime = codexBrokerFixture();
  const spawned = spawnPendingBrokerJob(root, runtime, "runtime-pending-recovery");
  const id = spawned.handle.id;
  const old = new Date(Date.now() - 10_000).toISOString();
  updateJob(root, id, (job) => ({ ...job, createdAt: old }), runtime.env);

  const states = [
    { providerLaunchPending: true, providerLaunchInFlight: false, providerLaunchOutcome: null },
    { providerLaunchPending: false, providerLaunchInFlight: true, providerLaunchOutcome: null },
    { providerLaunchPending: false, providerLaunchInFlight: false, providerLaunchOutcome: "unknown" }
  ];
  for (const launchState of states) {
    updateJob(root, id, (job) => ({
      ...job,
      status: "queued",
      phase: "provider-launching",
      error: null,
      request: {
        ...job.request,
        spawn: { ...job.request.spawn, ...launchState }
      }
    }), runtime.env);
    const status = parseJson(runCompanion(["status", id, "--json"], {
      cwd: root,
      env: runtime.env
    }));
    assert.equal(status.status, "queued");
    assert.equal(readJob(root, id, runtime.env).error, null);
  }
});

test("legacy CLI cancel extracts the broker object authorization nonce", async () => {
  const root = fs.realpathSync(initRepo());
  const runtime = codexBrokerFixture();
  const spawned = spawnPendingBrokerJob(root, runtime, "runtime-object-nonce-cancel");
  const id = spawned.handle.id;
  const nonce = readJob(root, id, runtime.env).workerAuthorization.nonce;
  const stateRoot = workspaceState(root, runtime.env);
  const marker = path.join(stateRoot, "jobs", `${id}.cancel`);

  const canceling = spawnCompanion(["cancel", id, "--json"], { cwd: root, env: runtime.env });
  await waitFor(() => fs.existsSync(marker), { timeoutMs: 5000 });
  assert.equal(fs.readFileSync(marker, "utf8"), `${nonce}\n`);

  updateJob(root, id, (job) => ({
    ...job,
    status: "cancelled",
    phase: "cancelled",
    completedAt: new Date().toISOString(),
    error: { code: "E_CANCELLED", message: "cancelled during broker launch window" },
    summary: "cancelled during broker launch window"
  }), runtime.env);
  const completed = await canceling.completed;
  assert.equal(completed.code, 0, completed.stderr || completed.stdout);
  assert.equal(JSON.parse(completed.stdout).status, "cancelled");
});

test("CLI cancel terminalizes only cleanup-proven broker boundaries and retains ambiguous launch states", { timeout: 30_000 }, async () => {
  const root = fs.realpathSync(initRepo());
  const runtime = codexBrokerFixture();
  const stateRoot = workspaceState(root, runtime.env);
  const cases = [
    {
      name: "pending",
      launch: { providerLaunchPending: true, providerLaunchInFlight: false, providerLaunchOutcome: null },
      retained: false
    },
    {
      name: "inflight",
      launch: { providerLaunchPending: false, providerLaunchInFlight: true, providerLaunchOutcome: null },
      retained: true
    },
    {
      name: "unknown",
      launch: { providerLaunchPending: false, providerLaunchInFlight: false, providerLaunchOutcome: "unknown" },
      retained: true
    },
    {
      name: "authorization-only",
      launch: null,
      retained: true
    },
    {
      name: "not-launched",
      launch: { providerLaunchPending: false, providerLaunchInFlight: false, providerLaunchOutcome: "not-launched" },
      retained: false
    }
  ];

  for (const fixture of cases) {
    const spawned = spawnPendingBrokerJob(root, runtime, `runtime-cancel-settlement-${fixture.name}`);
    fixture.id = spawned.handle.id;
    updateJob(root, fixture.id, (job) => {
      const spawnState = { ...job.request.spawn };
      if (fixture.launch) Object.assign(spawnState, fixture.launch);
      else {
        delete spawnState.providerLaunchPending;
        delete spawnState.providerLaunchInFlight;
        delete spawnState.providerLaunchOutcome;
      }
      return {
        ...job,
        request: { ...job.request, spawn: spawnState }
      };
    }, runtime.env);
    fixture.before = readJob(root, fixture.id, runtime.env);
    fixture.nonce = fixture.before.workerAuthorization.nonce;
    fixture.runtimeFile = path.join(stateRoot, "task-homes", fixture.id, ".grok", "auth.json");
    fs.mkdirSync(path.dirname(fixture.runtimeFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(fixture.runtimeFile, `private-${fixture.name}-runtime\n`, { mode: 0o600 });
  }

  const canceling = cases.map((fixture) => ({
    fixture,
    process: spawnCompanion(["cancel", fixture.id, "--json"], { cwd: root, env: runtime.env })
  }));
  await waitFor(() => cases.every((fixture) => {
    const marker = path.join(stateRoot, "jobs", `${fixture.id}.cancel`);
    return fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === `${fixture.nonce}\n`;
  }), { timeoutMs: 5000 });

  const outcomes = await Promise.all(canceling.map(async ({ fixture, process: running }) => ({
    fixture,
    completed: await running.completed
  })));
  for (const { fixture, completed } of outcomes) {
    assert.equal(completed.code, 0, completed.stderr || completed.stdout);
    const projected = JSON.parse(completed.stdout);
    const stored = readJob(root, fixture.id, runtime.env);
    const marker = path.join(stateRoot, "jobs", `${fixture.id}.cancel`);
    assert.equal(fs.readFileSync(marker, "utf8"), `${fixture.nonce}\n`);

    if (!fixture.retained) {
      assert.equal(projected.status, "cancelled");
      assert.equal(stored.status, "cancelled");
      assert.equal(stored.result?.taskRuntimeCleaned, true);
      assert.equal(fs.existsSync(fixture.runtimeFile), false, "explicit not-launched runtime must be cleaned");
      continue;
    }

    assert.equal(projected.status, "queued");
    assert.equal(projected.phase, "cancellation-requested");
    assert.equal(stored.status, "queued");
    assert.equal(stored.phase, "cancellation-requested");
    assert.equal(stored.completedAt, null);
    assert.deepEqual(stored.request, fixture.before.request, `${fixture.name} launch state must remain intact`);
    assert.deepEqual(stored.workerAuthorization, fixture.before.workerAuthorization);
    assert.equal(
      stored.lifecycleEvents.length,
      fixture.before.lifecycleEvents.length + 1,
      `${fixture.name} must append exactly one durable cancellation event`
    );
    assert.equal(stored.lifecycleEvents.at(-1).type, "cancellation.requested");
    assert.equal(stored.error, null);
    assert.equal(stored.result?.taskRuntimeCleaned, undefined);
    assert.equal(fs.existsSync(fixture.runtimeFile), true, `${fixture.name} runtime must be retained`);
    assert.doesNotMatch(stored.error?.message || "", new RegExp(fixture.id));
    assert.doesNotMatch(stored.error?.message || "", new RegExp(fixture.nonce));
    assert.doesNotMatch(completed.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(completed.stderr, new RegExp(fixture.nonce));
  }
});

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
  assert.equal(recovered.status, "running");
  assert.equal(recovered.phase, "cleanup-blocked");
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
    workerProcess: { pid: 999999992, startToken: "dead-worker-token", nonce: workerNonce, processGroupId: 999999992, commandMarker: id },
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
    workerProcess: { pid: 999999991, startToken: "dead-worker-token", nonce: workerNonce, processGroupId: 999999991, commandMarker: id },
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
    workerProcess: { pid: 999999993, startToken: "dead-worker-token", nonce: workerNonce, processGroupId: 999999993, commandMarker: id },
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
    workerProcess: { pid: 999999990, startToken: "dead-worker-token", nonce: workerNonce, processGroupId: 999999990, commandMarker: id },
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
  assert.equal(job.status, "running", "force-cancel failure must remain recoverable rather than falsely terminal");
  assert.equal(job.phase, "cleanup-blocked");
  assert.equal(job.pendingTerminal?.status, "cancelled");
  assert.equal(job.result?.providerSessionDeleted, false);
  assert.match(job.result?.privacyWarning || "", /prior-privacy-signal/);
  assert.match(job.result?.privacyWarning || "", /force-cancel process cleanup could not be verified/);
});

test("force-cancel persists cleanup-blocked when worker termination cannot be verified", { skip: process.platform === "win32" }, async (t) => {
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("task");
  const taskHome = path.join(stateRoot, "task-homes", id, ".grok");
  fs.mkdirSync(path.join(taskHome, "agent-profiles"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(taskHome, "auth.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(taskHome, "agent-profiles", "retained.md"), "profile\n", { mode: 0o600 });
  const worker = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", id], { detached: true, stdio: "ignore" });
  t.after(() => { try { process.kill(-worker.pid, "SIGKILL"); } catch {} });
  await waitFor(() => processGroupAlive(worker.pid), { timeoutMs: 5000 });
  const workerNonce = crypto.randomBytes(16).toString("hex");
  const stamped = new Date().toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 3,
    id,
    kind: "task",
    jobClass: "task",
    title: "task: force-cancel unverifiable worker",
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
    workerProcess: { pid: worker.pid, startToken: "unverified-worker-token", nonce: workerNonce, processGroupId: worker.pid, commandMarker: id },
    providerProcess: null,
    profile: profileFor("task", false),
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: null,
    request: { prompt: null, providerHomeId: id },
    result: { privacyWarning: "prior-task-privacy" },
    error: null
  });

  const failed = runCompanion(["cancel", id, "--json"], { cwd: root, env, timeout: 20_000 });
  parseError(failed, "E_PROCESS_IDENTITY");
  const job = JSON.parse(fs.readFileSync(path.join(stateRoot, "jobs", `${id}.json`), "utf8"));
  assert.equal(job.status, "running");
  assert.equal(job.phase, "cleanup-blocked");
  assert.equal(job.pendingTerminal?.status, "cancelled");
  assert.equal(job.result?.taskRuntimeCleaned, false);
  assert.match(job.result?.privacyWarning || "", /prior-task-privacy/);
  assert.match(job.result?.privacyWarning || "", /force-cancel process cleanup could not be verified/);
  assert.equal(processGroupAlive(worker.pid), true);
  assert.equal(fs.existsSync(path.join(taskHome, "auth.json")), true);
  assert.equal(fs.existsSync(path.join(taskHome, "agent-profiles", "retained.md")), true);
});

test("background cancellation writes a marker, sends ACP cancel, and reaches cancelled once", async () => {
  const root = initRepo();
  const { fake, env, pluginData } = fixture({ cancelMode: "wait" });
  const launch = parseJson(runCompanion(
    ["task", "--background", "wait until cancelled", "--json"],
    { cwd: root, env }
  ));

  await waitFor(() => {
    const result = runCompanion(["status", launch.id, "--json"], { cwd: root, env });
    if (result.status !== 0) return false;
    const job = persistedJob(pluginData, launch.id);
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
  const stored = persistedJob(pluginData, launch.id);
  const marker = path.join(path.dirname(stored.logFile), `${launch.id}.cancel`);
  assert.equal(fs.readFileSync(marker, "utf8"), `${stored.workerProcess.nonce}\n`);
  assert.ok(readFakeLog(fake.logFile).some((entry) => entry.event === "cancel"));

  const second = parseJson(runCompanion(["cancel", launch.id, "--json"], { cwd: root, env }));
  assert.equal(second.status, "cancelled");
  assert.equal(second.completedAt, cancelled.completedAt);
});

test("worker ignores forged and missing cancellation nonces", async () => {
  for (const forged of ["wrong-worker-nonce\n", "\n"]) {
    const root = initRepo();
    const { fake, env, pluginData } = fixture({ cancelMode: "wait" });
    const launch = parseJson(runCompanion(
      ["task", "--background", "reject forged cancellation", "--json"],
      { cwd: root, env }
    ));

    const running = await waitFor(() => {
      const result = runCompanion(["status", launch.id, "--json"], { cwd: root, env });
      if (result.status !== 0) return false;
      const job = persistedJob(pluginData, launch.id);
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
    assert.equal(fs.readFileSync(marker, "utf8"), `${persistedJob(pluginData, launch.id).workerProcess.nonce}\n`);
  }
});

test("background review cancellation terminates the headless process and preserves the workspace", async () => {
  const root = initRepo();
  const tracked = path.join(root, "tracked.txt");
  fs.appendFileSync(tracked, "review cancellation fixture\n", "utf8");
  const before = fs.readFileSync(tracked, "utf8");
  const { fake, env, pluginData } = fixture({ headlessDelayMs: 60_000 });
  const launch = parseJson(runCompanion(
    ["review", "--background", "--json"],
    { cwd: root, env }
  ));

  await waitFor(() => {
    const status = runCompanion(["status", launch.id, "--json"], { cwd: root, env });
    if (status.status !== 0) return false;
    const job = persistedJob(pluginData, launch.id);
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
  const stored = persistedJob(pluginData, launch.id);
  assert.equal(fs.existsSync(path.join(path.dirname(path.dirname(stored.logFile)), "review-homes", launch.id)), false);

  const providerLog = readFakeLog(fake.logFile);
  assert.ok(providerLog.some((entry) => entry.event === "headless"));
  assert.ok(providerLog.some(
    (entry) => entry.event === "signal" && entry.signal === "SIGTERM" && entry.transport === "headless"
  ));
  assert.equal(providerLog.some((entry) => entry.event === "rpc"), false);
});

test("status recovers a background task whose worker crashes without replaying its prompt", { skip: process.platform === "win32" }, async () => {
  const root = initRepo();
  const { fake, env, pluginData } = fixture({ cancelMode: "wait" });
  const launch = parseJson(runCompanion(
    ["task", "--background", "worker crash fixture", "--json"],
    { cwd: root, env }
  ));
  const running = await waitFor(() => {
    const result = runCompanion(["status", launch.id, "--json"], { cwd: root, env });
    if (result.status !== 0) return false;
    const job = persistedJob(pluginData, launch.id);
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
  assert.equal(recovered.result?.taskRuntimeCleaned, true, "worker-crash recovery did not clean transient task artifacts");
  const stored = persistedJob(pluginData, launch.id);
  const taskHome = path.join(
    path.dirname(path.dirname(stored.logFile)),
    "task-homes",
    stored.request?.providerHomeId || stored.id,
    ".grok"
  );
  assert.equal(fs.existsSync(path.join(taskHome, "auth.json")), false, "worker-crash recovery retained the task credential");
  assert.equal(fs.existsSync(path.join(taskHome, "agent-profiles")), false, "worker-crash recovery retained the staged profile");
});

test("cleanup-blocked task recovery preserves its completed outcome and evidence status", { skip: process.platform === "win32" }, () => {
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("task");
  const taskHome = path.join(stateRoot, "task-homes", id, ".grok");
  fs.mkdirSync(path.join(taskHome, "agent-profiles"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(taskHome, "auth.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(taskHome, "agent-profiles", "staged.md"), "profile\n", { mode: 0o600 });
  const stamped = new Date(Date.now() - 60_000).toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 3,
    id,
    kind: "task",
    jobClass: "task",
    title: "task: completed cleanup retry",
    summary: "Worker completed",
    write: false,
    status: "running",
    phase: "cleanup-blocked",
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    grokSessionId: "fake-session-00000001",
    createdAt: stamped,
    startedAt: stamped,
    updatedAt: stamped,
    completedAt: null,
    heartbeatAt: stamped,
    controllerProcess: null,
    workerProcess: { pid: 999999997, startToken: "dead-worker", nonce: "n", processGroupId: 999999997, commandMarker: id },
    providerProcess: { pid: 999999996, startToken: "dead-provider", processGroupId: 999999996 },
    profile: profileFor("task", false),
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: "Task finished; runtime cleanup is still pending",
    request: { prompt: null, providerHomeId: id, contextManifest: null, envelope: null },
    result: { hostVerification: "not_run", taskRuntimeCleaned: false, privacyWarning: "cleanup pending" },
    error: { code: "E_STATE", message: "cleanup pending" },
    pendingTerminal: { status: "completed", phase: "done", completedAt: stamped, error: null, summary: "Worker completed" }
  });

  const recovered = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
  assert.equal(recovered.status, "completed", JSON.stringify(recovered));
  assert.equal(recovered.phase, "done");
  assert.equal(recovered.error, null);
  assert.equal(recovered.summary, "Worker completed");
  assert.equal(recovered.result.taskRuntimeCleaned, true);
  assert.equal(recovered.result.runtimeEvidence.executionStatus, "completed");
  assert.equal(fs.existsSync(path.join(taskHome, "auth.json")), false);
  assert.equal(fs.existsSync(path.join(taskHome, "agent-profiles")), false);
});

test("terminal task cleanup defers while an active continuation owns the same lineage", { skip: process.platform === "win32" }, () => {
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const lineage = generateId("task");
  const oldId = generateId("task");
  const activeId = generateId("task");
  const taskHome = path.join(stateRoot, "task-homes", lineage, ".grok");
  fs.mkdirSync(path.join(taskHome, "agent-profiles"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(taskHome, "auth.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(taskHome, "agent-profiles", "active.md"), "active profile\n", { mode: 0o600 });
  const stamped = new Date().toISOString();
  const common = {
    schemaVersion: 3,
    kind: "task",
    jobClass: "task",
    write: false,
    workspaceRoot: root,
    host: { kind: "claude-code", sessionId: env.GROK_COMPANION_HOST_SESSION_ID },
    profile: profileFor("task", false),
    model: null,
    effort: null,
    createdAt: stamped,
    startedAt: stamped,
    updatedAt: stamped,
    heartbeatAt: stamped,
    workerProcess: null,
    providerProcess: null,
    error: null
  };
  writeSeededJob(stateRoot, {
    ...common,
    id: oldId,
    title: "old cleanup-pending task",
    summary: "completed",
    status: "completed",
    phase: "done",
    completedAt: stamped,
    grokSessionId: "66666666-6666-4666-8666-666666666666",
    logFile: path.join(stateRoot, "jobs", `${oldId}.log`),
    progress: "done",
    request: { prompt: null, providerHomeId: lineage },
    result: { taskRuntimeCleaned: false, privacyWarning: "cleanup pending" }
  });
  writeSeededJob(stateRoot, {
    ...common,
    id: activeId,
    title: "active continuation",
    summary: "queued",
    status: "queued",
    phase: "queued",
    completedAt: null,
    grokSessionId: null,
    logFile: path.join(stateRoot, "jobs", `${activeId}.log`),
    progress: "queued",
    request: { prompt: null, providerHomeId: lineage },
    result: null
  });

  const deferred = parseJson(runCompanion(["status", oldId, "--json"], { cwd: root, env }));
  assert.equal(deferred.result.taskRuntimeCleaned, false);
  assert.equal(fs.existsSync(path.join(taskHome, "auth.json")), true);
  assert.equal(fs.existsSync(path.join(taskHome, "agent-profiles", "active.md")), true);

  writeSeededJob(stateRoot, {
    ...JSON.parse(fs.readFileSync(path.join(stateRoot, "jobs", `${activeId}.json`), "utf8")),
    status: "completed",
    phase: "done",
    completedAt: stamped,
    result: { taskRuntimeCleaned: true }
  });
  const cleaned = parseJson(runCompanion(["status", oldId, "--json"], { cwd: root, env }));
  assert.equal(cleaned.result.taskRuntimeCleaned, true);
  assert.equal(fs.existsSync(path.join(taskHome, "auth.json")), false);
  assert.equal(fs.existsSync(path.join(taskHome, "agent-profiles")), false);
});

test("cleanup-blocked recovery terminates a verified live worker before restoring completion", { skip: process.platform === "win32" }, async () => {
  const root = fs.realpathSync(initRepo());
  const { env, pluginData } = fixture({ cancelMode: "wait" });
  const launch = parseJson(runCompanion(["task", "--background", "live finalizer fixture", "--json"], { cwd: root, env }));
  const running = await waitFor(() => {
    const job = persistedJob(pluginData, launch.id);
    return job.status === "running" && job.phase === "responding" && job.workerProcess?.pid && job.providerProcess?.pid ? job : false;
  }, { timeoutMs: 10_000 });
  const stateRoot = path.dirname(path.dirname(running.logFile));
  const taskHome = path.join(stateRoot, "task-homes", running.request.providerHomeId, ".grok");
  const stamped = new Date().toISOString();
  const jobFile = path.join(stateRoot, "jobs", `${running.id}.json`);
  fs.writeFileSync(jobFile, `${JSON.stringify({
    ...running,
    status: "running",
    phase: "cleanup-blocked",
    completedAt: null,
    controllerProcess: null,
    progress: "cleanup pending",
    result: { ...(running.result || {}), hostVerification: "not_run", taskRuntimeCleaned: false },
    error: { code: "E_STATE", message: "cleanup pending" },
    pendingTerminal: { status: "completed", phase: "done", completedAt: stamped, error: null, summary: "completed" }
  }, null, 2)}\n`, { mode: 0o600 });

  const recovered = parseJson(runCompanion(["status", running.id, "--json"], { cwd: root, env, timeout: 15_000 }));
  assert.equal(recovered.status, "completed", JSON.stringify(recovered));
  assert.equal(recovered.phase, "done");
  assert.equal(recovered.error, null);
  assert.equal(recovered.result.taskRuntimeCleaned, true);
  assert.equal(processGroupAlive(running.workerProcess.processGroupId), false);
  assert.equal(fs.existsSync(path.join(taskHome, "auth.json")), false);
  assert.equal(fs.existsSync(path.join(taskHome, "agent-profiles")), false);
});

test("terminal review cleanup waits for the recorded worker group", { skip: process.platform === "win32" }, async (t) => {
  const root = fs.realpathSync(initRepo());
  const { env } = fixture();
  const stateRoot = seedWorkspace(root, env);
  const id = generateId("review");
  const reviewHome = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(reviewHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(reviewHome, "retained.txt"), "privacy\n", { mode: 0o600 });
  const worker = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", id], { detached: true, stdio: "ignore" });
  t.after(() => { try { process.kill(-worker.pid, "SIGKILL"); } catch {} });
  await waitFor(() => processGroupAlive(worker.pid), { timeoutMs: 5000 });
  const stamped = new Date().toISOString();
  writeSeededJob(stateRoot, {
    schemaVersion: 3,
    id,
    kind: "review",
    jobClass: "review",
    title: "terminal review with live worker",
    summary: "pass",
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
    heartbeatAt: stamped,
    workerProcess: { pid: worker.pid, startToken: processStartToken(worker.pid), processGroupId: worker.pid, nonce: "n", commandMarker: id },
    providerProcess: null,
    profile: profileFor("review"),
    model: null,
    effort: null,
    logFile: path.join(stateRoot, "jobs", `${id}.log`),
    progress: "done",
    request: { prompt: null, target: { mode: "working-tree", label: "fixture", base: null } },
    result: { review: { verdict: "pass", summary: "pass", findings: [] }, providerSessionDeleted: false, privacyWarning: "cleanup pending" },
    error: null
  });

  const deferred = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
  assert.equal(deferred.result.providerSessionDeleted, false);
  assert.equal(fs.existsSync(path.join(reviewHome, "retained.txt")), true);
  process.kill(-worker.pid, "SIGKILL");
  await waitFor(() => !processGroupAlive(worker.pid), { timeoutMs: 5000 });
  const cleaned = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
  assert.equal(cleaned.result.providerSessionDeleted, true);
  assert.equal(cleaned.result.privacyWarning, undefined);
  assert.equal(fs.existsSync(reviewHome), false);
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

    let completionTimer;
    let completed;
    try {
      completed = await Promise.race([
        foreground.completed,
        new Promise((_, reject) => {
          completionTimer = setTimeout(
            () => reject(new Error("Foreground caller did not observe recovered worker failure.")),
            25000
          );
        })
      ]);
    } finally {
      clearTimeout(completionTimer);
    }
    assert.equal(completed.signal, null);
    assert.notEqual(completed.code, 0, completed.stdout);
    const payload = JSON.parse(completed.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "E_WORKER_LOST");
    const recovered = persistedJob(pluginData, running.id);
    assert.equal(recovered.id, running.id);
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.phase, "failed");
    assert.equal(recovered.error.code, "E_WORKER_LOST");
    assert.ok(recovered.completedAt);
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
    const job = persistedJob(pluginData, launch.id);
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
  assert.equal(recovered.status, "running");
  assert.equal(recovered.phase, "cleanup-blocked");
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
    assert.equal(first.status, "running");
    assert.equal(first.phase, "cleanup-blocked");
    assert.equal(first.error.code, "E_PROCESS_IDENTITY");
    assert.equal(first.result.providerSessionDeleted, false);
    assert.match(first.result.privacyWarning, /prior-privacy-signal/);
    assert.match(first.result.privacyWarning, /Isolated review home retained/);
    assert.equal(fs.existsSync(isolatedHome), true);
    assert.equal(processGroupAlive(processGroupId), true);

    // Recovery 2: active cleanup must still refuse while the group remains live.
    const second = parseJson(runCompanion(["status", id, "--json"], { cwd: root, env }));
    assert.equal(second.status, "running");
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
  const home = tempDir("grok-transfer-home-");
  const projects = path.join(home, ".claude", "projects", "fixture");
  fs.mkdirSync(projects, { recursive: true });
  const source = path.join(projects, "session.jsonl");
  const originalTranscript = '{"type":"user"}\n';
  fs.writeFileSync(source, originalTranscript, "utf8");
  const { fake, env } = fixture({
    importSessionId: "12345678-1234-4234-8234-123456789abc",
    importSpawnStubbornDescendant: true,
    importAppendSourcePath: source,
    importAppendText: "APPENDED_AFTER_TRANSFER_STARTED\n"
  });
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
  assert.equal(importInput.bytes, Buffer.byteLength(originalTranscript));
  assert.equal(importInput.sha256, crypto.createHash("sha256").update(originalTranscript).digest("hex"));
  assert.match(fs.readFileSync(source, "utf8"), /APPENDED_AFTER_TRANSFER_STARTED/);
  // Same non-isolated home for models listing, import, and readiness (not setup-probe review-homes).
  const modelsLog = readFakeLog(fake.logFile).find((entry) => entry.event === "models");
  assert.ok(modelsLog);
  assert.equal(modelsLog.home, home);
  assert.equal(modelsLog.grokHome, null);
  assert.equal(importInput.home, home);
  assert.equal(importInput.grokHome, null);
  const listLog = readFakeLog(fake.logFile).find((entry) => entry.event === "sessions-list");
  assert.ok(listLog);
  assert.equal(listLog.home, home);
  assert.ok(listLog.sessionIds.includes(imported.sessionId));
  // Logs must not retain source paths or transcript bodies.
  for (const entry of readFakeLog(fake.logFile)) {
    assert.equal(JSON.stringify(entry).includes(source), false);
    assert.equal(JSON.stringify(entry).includes('"type":"user"'), false);
  }

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

test("transfer rejects unavailable model/effort before conversion or alias artifacts", () => {
  const root = fs.realpathSync(initRepo());
  const { fake, env } = fixture({ importSessionId: "12345678-1234-4234-8234-123456789abc" });
  const home = tempDir("grok-transfer-cap-home-");
  const codexHome = path.join(home, ".codex");
  const sessions = path.join(codexHome, "sessions", "2026", "07", "13");
  const pluginData = path.join(codexHome, "plugins", "data", "grok-grok-companion");
  const threadId = crypto.randomUUID();
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const source = path.join(sessions, `rollout-${threadId}.jsonl`);
  // Valid Codex transcript that would require conversion if capability checks ran later.
  const records = [
    { timestamp: "2026-07-13T10:00:00.000Z", type: "session_meta", payload: { id: threadId, cwd: root, cli_version: "0.143.0" } },
    { timestamp: "2026-07-13T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "VISIBLE_CODEX_USER_TEXT" } },
    { timestamp: "2026-07-13T10:00:02.000Z", type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "VISIBLE_CODEX_ASSISTANT_TEXT" } }
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

  function assertFailedBeforeArtifacts(result, restrictedLog = null) {
    assert.notEqual(result.status, 0, result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "E_CAPABILITY");
    assert.match(payload.error.message, /not advertised|not-a-real-model|effort high/i);
    // Ordering proof: imports dir is created only after same-home model capability succeeds.
    const previous = process.env.GROK_COMPANION_PLUGIN_DATA;
    process.env.GROK_COMPANION_PLUGIN_DATA = pluginData;
    try {
      const importsDir = path.join(workspaceState(root), "imports");
      assert.equal(fs.existsSync(importsDir), false, "must not create import/conversion artifacts before capability acceptance");
    } finally {
      if (previous === undefined) delete process.env.GROK_COMPANION_PLUGIN_DATA;
      else process.env.GROK_COMPANION_PLUGIN_DATA = previous;
    }
    assert.equal(readFakeLog(fake.logFile).some((entry) => entry.event === "import-input"), false, "import must not run");
    if (restrictedLog) {
      assert.equal(readFakeLog(restrictedLog).some((entry) => entry.event === "import-input"), false);
    }
    return payload.error;
  }

  const modelError = assertFailedBeforeArtifacts(runCodexCompanion(
    ["transfer", "--source", source, "--model", "not-a-real-model", "--json"],
    { cwd: root, env: transferEnv }
  ));
  assert.match(modelError.message, /not-a-real-model|not advertised/i);

  const restricted = installFakeGrok(tempDir("fake-grok-transfer-effort-"), {
    models: [{ modelId: "grok-test", _meta: { reasoningEfforts: [{ id: "low" }] } }],
    importSessionId: "12345678-1234-4234-8234-123456789abc"
  });
  const effortError = assertFailedBeforeArtifacts(
    runCodexCompanion(
      ["transfer", "--source", source, "--model", "grok-test", "--effort", "high", "--json"],
      { cwd: root, env: { ...transferEnv, GROK_BIN: restricted.binary, GROK_AUTH_PATH: restricted.authPath } }
    ),
    restricted.logFile
  );
  assert.match(effortError.message, /effort high|not advertised/i);

  // Successful import returns a model-qualified resume including requested effort.
  const imported = parseJson(runCodexCompanion(
    ["transfer", "--source", source, "--model", "grok-test", "--effort", "high", "--json"],
    { cwd: root, env: transferEnv }
  ));
  assert.equal(imported.model, "grok-test");
  assert.equal(imported.effort, "high");
  assert.equal(
    imported.resume,
    "grok --model grok-test --reasoning-effort high --resume 12345678-1234-4234-8234-123456789abc"
  );
});

test("transfer selects resume model from non-isolated models listing and model-qualifies resume", () => {
  const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const { root, source, env, fake } = transferFixture({
    models: [
      { modelId: "grok-secondary", _meta: { reasoningEfforts: [{ id: "low" }] } },
      { modelId: "grok-primary", default: true, _meta: { reasoningEfforts: [{ id: "low" }, { id: "high" }] } }
    ],
    defaultModel: "grok-primary",
    importSessionId: sessionId
  });
  const home = env.HOME;
  const imported = parseJson(runCompanion(["transfer", "--source", source, "--json"], { cwd: root, env }));
  assert.equal(imported.model, "grok-primary");
  assert.equal(imported.effort, null);
  assert.equal(imported.resume, `grok --model grok-primary --resume ${sessionId}`);

  const secondary = parseJson(runCompanion(
    ["transfer", "--source", source, "--model", "grok-secondary", "--effort", "low", "--json"],
    { cwd: root, env }
  ));
  assert.equal(secondary.model, "grok-secondary");
  assert.equal(secondary.effort, "low");
  assert.equal(
    secondary.resume,
    `grok --model grok-secondary --reasoning-effort low --resume ${sessionId}`
  );

  const modelsEvents = readFakeLog(fake.logFile).filter((entry) => entry.event === "models");
  assert.ok(modelsEvents.length >= 2);
  for (const event of modelsEvents) {
    assert.equal(event.home, home, "models listing must use the non-isolated HOME");
    assert.equal(event.grokHome, null, "models listing must not use an isolated GROK_HOME");
  }
  const importEvents = readFakeLog(fake.logFile).filter((entry) => entry.event === "import-input");
  assert.ok(importEvents.length >= 2);
  for (const event of importEvents) {
    assert.equal(event.home, home);
    assert.equal(event.grokHome, null);
  }
  // Transfer must not open the isolated setup-probe review home path.
  const previous = process.env.GROK_COMPANION_PLUGIN_DATA;
  process.env.GROK_COMPANION_PLUGIN_DATA = env.GROK_COMPANION_PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA;
  try {
    const reviewHomes = path.join(workspaceState(root), "review-homes");
    assert.equal(fs.existsSync(reviewHomes), false, "transfer must not create isolated setup-probe homes");
  } finally {
    if (previous === undefined) delete process.env.GROK_COMPANION_PLUGIN_DATA;
    else process.env.GROK_COMPANION_PLUGIN_DATA = previous;
  }
});

test("transfer waits for import readiness delay then succeeds", () => {
  const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const { root, source, env, fake } = transferFixture({
    importSessionId: sessionId,
    importReadyAfterMs: 150
  });
  const imported = parseJson(runCompanion(["transfer", "--source", source, "--json"], {
    cwd: root,
    env: {
      ...env,
      GROK_COMPANION_TEST_IMPORT_READY_TIMEOUT_MS: "2000",
      GROK_COMPANION_TEST_IMPORT_READY_INTERVAL_MS: "40"
    }
  }));
  assert.equal(imported.sessionId, sessionId);
  assert.equal(imported.resume, `grok --model grok-test --resume ${sessionId}`);
  const listEvents = readFakeLog(fake.logFile).filter((entry) => entry.event === "sessions-list");
  assert.ok(listEvents.length >= 2, "readiness delay should require more than one exact session-list poll");
  assert.ok(listEvents.some((entry) => entry.sessionIds.includes(sessionId)));
});

test("transfer fails closed when imported session never becomes observable", () => {
  const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const { root, source, env, fake } = transferFixture({
    importSessionId: sessionId,
    importNeverReady: true
  });
  const result = runCompanion(["transfer", "--source", source, "--json"], {
    cwd: root,
    env: {
      ...env,
      GROK_COMPANION_TEST_IMPORT_READY_TIMEOUT_MS: "250",
      GROK_COMPANION_TEST_IMPORT_READY_INTERVAL_MS: "40"
    }
  });
  const error = parseError(result, "E_IMPORT_RESULT");
  assert.match(error.message, /not yet observable for resume/i);
  assert.equal(error.details?.sessionId, sessionId);
  assert.equal(readFakeLog(fake.logFile).some((entry) => entry.event === "import-input"), true);
  const listEvents = readFakeLog(fake.logFile).filter((entry) => entry.event === "sessions-list");
  assert.ok(listEvents.length >= 1);
  assert.equal(listEvents.every((entry) => !entry.sessionIds.includes(sessionId)), true);
  // No transcript body or source path in provider logs/argv.
  for (const entry of readFakeLog(fake.logFile)) {
    assert.equal(JSON.stringify(entry).includes(source), false);
    assert.equal(JSON.stringify(entry).includes('"type":"user"'), false);
  }
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
  const result = runCompanion(["transfer", "--source", source, "--json"], { cwd: root, env });
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  if (payload.error.code === "E_PROCESS_IDENTITY") {
    // Probe teardown may fail closed when process identity is unavailable.
    return;
  }
  const error = parseError(result, "E_IMPORT_RESULT");
  assert.match(error.message, /multiple different session IDs/i);
  assert.ok(error.details?.sessionIds?.includes(first));
  assert.ok(error.details?.sessionIds?.includes(second));
});

test("execute review-finally gate retains isolated home when resolved process group remains live", { skip: process.platform === "win32" }, async (t) => {
  // Deterministic execute-finally path: resolveProviderCleanupTarget(job) + gatedCleanupReviewEnvironment
  // with a live group must retain the credential home and never claim providerSessionDeleted.
  const { gatedCleanupReviewEnvironment } = await import("../plugins/grok/scripts/lib/grok-provider.mjs");
  const { resolveProviderCleanupTarget } = await import("../plugins/grok/scripts/lib/recursion-guard.mjs");
  const root = fs.realpathSync(initRepo());
  const { pluginData, env } = fixture();
  // Seed workspace state layout used by execute finally.
  parseJson(runCompanion(["review", "--scope", "working-tree", "--json"], { cwd: root, env }));
  const jobs = persistedJobs(pluginData);
  assert.ok(jobs.length >= 1);
  const stateRoot = path.dirname(path.dirname(jobs[0].logFile));
  const id = generateId("review");
  const home = path.join(stateRoot, "review-homes", id);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, "credential"), "execute-finally-retained\n", { mode: 0o600 });

  const live = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);"
  ], { detached: true, stdio: "ignore" });
  t.after(() => { try { process.kill(-live.pid, "SIGKILL"); } catch {} });
  await waitFor(() => processGroupAlive(live.pid), { timeoutMs: 5000 });
  const job = {
    id,
    providerProcess: {
      pid: live.pid,
      startToken: processStartToken(live.pid) || "unavailable-live-token",
      processGroupId: live.pid
    }
  };
  const { identity } = resolveProviderCleanupTarget(root, job);
  const cleanup = gatedCleanupReviewEnvironment(stateRoot, id, identity);
  assert.equal(cleanup.ok, false);
  assert.match(cleanup.warning, /Isolated review home retained/i);
  assert.equal(fs.existsSync(path.join(home, "credential")), true);
  assert.equal(processGroupAlive(live.pid), true, "gate must not signal the live group");
});

test("transfer preserves imported session identity when private alias cleanup fails", () => {
  const sessionId = "12345678-1234-4234-8234-123456789abc";
  const { root, source, env } = transferFixture({
    importSessionId: sessionId,
    importPoisonAlias: true
  });
  const result = runCompanion(["transfer", "--source", source, "--json"], { cwd: root, env });
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  if (payload.error.code === "E_PROCESS_IDENTITY") {
    return;
  }
  const error = parseError(result, "E_STATE");
  assert.match(error.message, /cleanup failed/i);
  assert.match(error.message, new RegExp(sessionId));
  assert.equal(error.details?.sessionId, sessionId);
  assert.equal(error.details?.resume, `grok --model grok-test --resume ${sessionId}`);
  assert.equal(error.details?.delete, `grok sessions delete ${sessionId}`);
  assert.ok(error.details?.privacyWarning || error.details?.warning, "privacy failure must remain explicit");
  assert.match(String(error.details?.privacyWarning || error.details?.warning), /\S/);
});

test("attachTransferCleanupEvidence preserves primary probe/import codes with injected dispose/close/unlink failures", () => {
  const secret = "xai-abcdefghijklmnopqrstuvwxyz";

  // Primary probe/capability error + injected close failure: code/message stay; warning attached;
  // source-fd close alone is not residual private alias/converted evidence.
  {
    const primary = new CompanionError("E_CAPABILITY", "Model not-a-real-model is not advertised by Grok.", {
      available: ["grok-test"]
    });
    const attached = attachTransferCleanupEvidence(primary, ["injected close failure"], { privacy: false });
    assert.equal(attached.code, "E_CAPABILITY");
    assert.match(attached.message, /not-a-real-model/);
    assert.deepEqual(attached.details.available, ["grok-test"]);
    assert.equal(attached.details.warning, "injected close failure");
    assert.equal(attached.details.privacyWarning, undefined);
  }

  // Primary import failure + dispose/unlink evidence: privacyWarning required; prior details kept;
  // secrets in diagnostics/warnings are redacted in structured output.
  {
    const primary = new CompanionError(
      "E_IMPORT_RESULT",
      "Grok could not import the Claude Code transcript.",
      { diagnostic: `provider failed with ${secret}` }
    );
    const attached = attachTransferCleanupEvidence(
      primary,
      ["injected dispose failure", "injected unlink failure", `leftover path with ${secret}`],
      { privacy: true }
    );
    assert.equal(attached.code, "E_IMPORT_RESULT");
    assert.match(attached.message, /could not import/i);
    assert.match(attached.details.diagnostic, new RegExp(secret));
    assert.match(attached.details.warning, /injected dispose failure/);
    assert.match(attached.details.warning, /injected unlink failure/);
    assert.match(attached.details.warning, new RegExp(secret));
    assert.match(attached.details.privacyWarning, /injected dispose failure/);
    assert.match(attached.details.privacyWarning, /injected unlink failure/);
    // No warning lost across appends.
    assert.equal(
      attached.details.warning,
      `injected dispose failure; injected unlink failure; leftover path with ${secret}`
    );
    const redacted = redact(asErrorPayload(attached));
    assert.equal(redacted.code, "E_IMPORT_RESULT");
    assert.equal(JSON.stringify(redacted).includes(secret), false);
    assert.match(String(redacted.details.warning), /\[REDACTED\]/);
    assert.match(String(redacted.details.privacyWarning), /\[REDACTED\]/);
    assert.match(String(redacted.details.diagnostic), /\[REDACTED\]/);
  }

  // Timeout throw path + unlink: primary E_TIMEOUT preserved with privacy evidence.
  {
    const primary = new CompanionError("E_TIMEOUT", "Grok transcript import timed out.");
    const attached = attachTransferCleanupEvidence(primary, ["injected unlink failure"], { privacy: true });
    assert.equal(attached.code, "E_TIMEOUT");
    assert.match(attached.message, /timed out/i);
    assert.equal(attached.details.warning, "injected unlink failure");
    assert.equal(attached.details.privacyWarning, "injected unlink failure");
  }

  // Existing details.warning / privacyWarning are appended, never replaced.
  {
    const primary = new CompanionError("E_IMPORT_RESULT", "import failed", {
      warning: "prior-close",
      privacyWarning: "prior-privacy"
    });
    const attached = attachTransferCleanupEvidence(primary, ["new-unlink"], { privacy: true });
    assert.equal(attached.details.warning, "prior-close; new-unlink");
    assert.equal(attached.details.privacyWarning, "prior-privacy; new-unlink");
  }
});

test("transfer primary model-selection error preserves code when injected close cleanup fails", () => {
  const { root, source, env } = transferFixture();
  const result = runCompanion(
    ["transfer", "--source", source, "--model", "not-a-real-model", "--json"],
    {
      cwd: root,
      env: {
        ...env,
        GROK_COMPANION_TEST_TRANSFER_CLEANUP_FAULTS: "close"
      }
    }
  );
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "E_CAPABILITY");
  assert.match(payload.error.message, /not-a-real-model|not advertised/i);
  assert.match(String(payload.error.details?.warning || ""), /injected close failure/);
  assert.equal(payload.error.details?.privacyWarning, undefined, "source fd close alone is not residual private alias/converted evidence");
});

test("transfer primary import error preserves code when alias cleanup fails", () => {
  const secret = "xai-abcdefghijklmnopqrstuvwxyz";
  const { root, source, env } = transferFixture({
    importExitCode: 19,
    importStderr: `provider failed with ${secret}\n`,
    importPoisonAlias: true
  });
  const result = runCompanion(["transfer", "--source", source, "--json"], { cwd: root, env });
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  if (payload.error.code === "E_PROCESS_IDENTITY") {
    // Probe/import process identity failed before the nonzero-import path; still fail closed.
    return;
  }
  const error = parseError(result, "E_IMPORT_RESULT");
  assert.match(error.message, /could not import/i);
  assert.ok(error.details?.privacyWarning, "alias may remain — privacyWarning required");
  assert.match(String(error.details.privacyWarning), /\S/);
  assert.equal(JSON.stringify(error).includes(secret), false);
  assert.equal(result.stdout.includes("xai-"), false);
});

test("transfer primary import timeout preserves code when injected unlink cleanup fails", () => {
  const { root, source, env } = transferFixture({ importHang: true });
  const result = runCompanion(["transfer", "--source", source, "--json"], {
    cwd: root,
    env: {
      ...env,
      GROK_COMPANION_TEST_IMPORT_TIMEOUT_MS: "200",
      GROK_COMPANION_TEST_TRANSFER_CLEANUP_FAULTS: "unlink"
    }
  });
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  if (payload.error.code === "E_PROCESS_IDENTITY") {
    // Probe/import process identity failed closed; privacy or unlink evidence may be present.
    if (payload.error.details?.warning || payload.error.details?.privacyWarning) {
      assert.match(
        String(payload.error.details?.warning || payload.error.details?.privacyWarning),
        /injected unlink failure|Isolated review home retained/
      );
    }
    return;
  }
  const error = parseError(result, "E_TIMEOUT");
  assert.match(error.message, /timed out/i);
  assert.match(String(error.details?.warning || ""), /injected unlink failure/);
  assert.match(String(error.details?.privacyWarning || ""), /injected unlink failure/, "alias residual evidence must stay explicit");
});

test("transfer attaches cleanup evidence when importedSessionId throws after unlink fault", () => {
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const { root, source, env } = transferFixture({
    importRecords: [
      { event: "started", sessionId: first },
      { event: "completed", grok_session_id: second }
    ]
  });
  const result = runCompanion(["transfer", "--source", source, "--json"], {
    cwd: root,
    env: {
      ...env,
      GROK_COMPANION_TEST_TRANSFER_CLEANUP_FAULTS: "unlink"
    }
  });
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  if (payload.error.code === "E_PROCESS_IDENTITY") {
    return;
  }
  const error = parseError(result, "E_IMPORT_RESULT");
  assert.match(error.message, /multiple different session IDs/i);
  assert.match(String(error.details?.warning || ""), /injected unlink failure/);
  assert.match(String(error.details?.privacyWarning || ""), /injected unlink failure/, "alias residual requires privacyWarning");
  assert.ok(error.details?.sessionIds?.includes(first));
  assert.ok(error.details?.sessionIds?.includes(second));
});

test("transfer malformed NDJSON after cleanup attaches close/unlink evidence consistently", () => {
  const { root, source, env } = transferFixture({ importOutput: '{"sessionId":' });
  const result = runCompanion(["transfer", "--source", source, "--json"], {
    cwd: root,
    env: {
      ...env,
      GROK_COMPANION_TEST_TRANSFER_CLEANUP_FAULTS: "close,unlink"
    }
  });
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  if (payload.error.code === "E_PROCESS_IDENTITY") {
    return;
  }
  const error = parseError(result, "E_IMPORT_RESULT");
  assert.match(error.message, /malformed NDJSON/i);
  assert.match(String(error.details?.warning || ""), /injected close failure/);
  assert.match(String(error.details?.warning || ""), /injected unlink failure/);
  // Unlink is a private residual; privacyWarning is set. Close is included in warning text.
  assert.match(String(error.details?.privacyWarning || ""), /injected unlink failure/);
  assert.match(String(error.details?.privacyWarning || ""), /injected close failure/);
});

test("transfer success path with close-only fault is fail-closed E_STATE without privacyWarning", () => {
  const sessionId = "12345678-1234-4234-8234-123456789abc";
  const { root, source, env } = transferFixture({ importSessionId: sessionId });
  const result = runCompanion(["transfer", "--source", source, "--json"], {
    cwd: root,
    env: {
      ...env,
      GROK_COMPANION_TEST_TRANSFER_CLEANUP_FAULTS: "close"
    }
  });
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  if (payload.error.code === "E_PROCESS_IDENTITY") {
    return;
  }
  const error = parseError(result, "E_STATE");
  assert.match(error.message, /cleanup failed/i);
  assert.equal(error.details?.sessionId, sessionId);
  assert.match(String(error.details?.warning || ""), /injected close failure/);
  assert.equal(error.details?.privacyWarning, undefined, "source-FD close-only must not claim residual private alias/converted artifacts");
  assert.equal(error.details?.resume, `grok --model grok-test --resume ${sessionId}`);
  assert.equal(error.details?.delete, `grok sessions delete ${sessionId}`);
});

test("transfer codex dispose fault sets privacyWarning on success-path fail-closed E_STATE", () => {
  const sessionId = "12345678-1234-4234-8234-123456789abc";
  const root = initRepo();
  const { fake, env } = fixture({ importSessionId: sessionId });
  const home = tempDir("grok-transfer-dispose-home-");
  const codexHome = path.join(home, ".codex");
  const sessions = path.join(codexHome, "sessions", "2026", "07", "13");
  const pluginData = path.join(codexHome, "plugins", "data", "grok-grok-companion");
  const threadId = crypto.randomUUID();
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const source = path.join(sessions, `rollout-${threadId}.jsonl`);
  const records = [
    { timestamp: "2026-07-13T10:00:00.000Z", type: "session_meta", payload: { id: threadId, cwd: root, cli_version: "0.143.0" } },
    { timestamp: "2026-07-13T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "transfer dispose fixture" } },
    { timestamp: "2026-07-13T10:00:02.000Z", type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "ok" } }
  ];
  fs.writeFileSync(source, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  writeCodexSessionMetadata(pluginData, { sessionId: threadId, transcriptPath: source, cwd: root });
  const transferEnv = {
    ...env,
    HOME: home,
    CODEX_HOME: codexHome,
    CODEX_THREAD_ID: threadId,
    GROK_COMPANION_TEST_TRANSFER_CLEANUP_FAULTS: "dispose"
  };
  delete transferEnv.CLAUDE_PLUGIN_DATA;
  delete transferEnv.GROK_COMPANION_CLAUDE_SESSION_ID;
  delete transferEnv.GROK_COMPANION_HOST;
  delete transferEnv.GROK_COMPANION_HOST_SESSION_ID;
  delete transferEnv.GROK_COMPANION_PLUGIN_DATA;

  const result = runCodexCompanion(["transfer", "--source", source, "--json"], { cwd: root, env: transferEnv });
  assert.notEqual(result.status, 0, result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  if (payload.error.code === "E_PROCESS_IDENTITY") {
    return;
  }
  assert.equal(payload.error.code, "E_STATE");
  assert.match(payload.error.message, /cleanup failed/i);
  assert.equal(payload.error.details?.sessionId, sessionId);
  assert.match(String(payload.error.details?.warning || ""), /injected dispose failure/);
  assert.match(String(payload.error.details?.privacyWarning || ""), /injected dispose failure/, "converted dispose residual requires privacyWarning");
  assert.ok(fake);
});
