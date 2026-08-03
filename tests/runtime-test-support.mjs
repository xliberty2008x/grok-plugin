import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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
import {
  assertContextCompatible,
  buildRuntimeEvidence,
  buildTaskEnvelope,
  captureContextManifest,
  evaluateScope,
  observeChangedPaths,
  scrubStoredJob
} from "../plugins/grok/scripts/lib/task-contract.mjs";
import { launchContractDigest } from "../plugins/grok/scripts/lib/worker-launch-contract.mjs";
import {
  captureTerminalEvidence,
  normalizeTerminalProcessSignalError,
  selectTaskTerminalError
} from "../plugins/grok/scripts/lib/task-terminal-evidence.mjs";
import { installFakeGrok, readFakeLog } from "./fake-grok.mjs";
import {
  installPinnedFakeCompanion
} from "./pinned-fake-grok.mjs";
import {
  CODEX_COMPANION,
  COMPANION,
  ROOT,
  git,
  initRepo,
  runCodexCompanion,
  runCompanion,
  spawnNonblockingStdin,
  tempDir,
  testEnvironment,
  waitFor
} from "./helpers.mjs";
import {
  missingInvalidProviderCapabilityReceiptMessage,
  pluginDataRoot,
  writeCodexSessionMetadata
} from "../plugins/grok/scripts/lib/host.mjs";

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

function codexTaskEnv(baseEnv, pluginData, threadId) {
  const env = {
    ...baseEnv,
    CODEX_THREAD_ID: threadId,
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_HOST_SESSION_ID: threadId,
    GROK_COMPANION_PLUGIN_DATA: pluginData
  };
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.GROK_COMPANION_CLAUDE_SESSION_ID;
  delete env.CLAUDE_SESSION_ID;
  delete env.CLAUDE_PROJECT_DIR;
  return env;
}

function agentStdioCount(logFile) {
  return readFakeLog(logFile).filter(
    (entry) => entry.event === "argv"
      && entry.args.includes("agent")
      && entry.args.includes("stdio")
  ).length;
}

function receiptPathFor(env) {
  return path.join(pluginDataRoot(env), "capabilities", "provider-capability-v2.json");
}

function pluginDataForJobs(env) {
  return env.GROK_COMPANION_PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA;
}

function canonicalReceiptAdmissionMessage(env = {}) {
  return missingInvalidProviderCapabilityReceiptMessage({
    GROK_COMPANION_HOST: "codex",
    CODEX_THREAD_ID: "codex-receipt-gate",
    ...env
  });
}

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

function injectedImportSignalEnv(env, mode, privatePath) {
  const directory = tempDir("grok-import-signal-injection-");
  const preload = path.join(directory, "signal-injection.cjs");
  const logFile = path.join(directory, "signal-events.jsonl");
  fs.writeFileSync(preload, [
    '"use strict";',
    'const fs = require("node:fs");',
    'const processModule = require("node:process");',
    "const originalKill = processModule.kill.bind(processModule);",
    "const append = (event) => fs.appendFileSync(process.env.GROK_TEST_IMPORT_SIGNAL_LOG, `${JSON.stringify(event)}\\n`);",
    'append({ type: "loaded", pid: process.pid });',
    "let injected = false;",
    "processModule.kill = (target, signal) => {",
    "  const numericTarget = Number(target);",
    '  if (!injected && signal === "SIGTERM" && Number.isSafeInteger(numericTarget) && numericTarget < 0) {',
    "    injected = true;",
    '    append({ type: "signal", target: numericTarget, signal });',
    "    const failure = () => {",
    "      const error = new Error(`signal denied for providerPid=${Math.abs(numericTarget)} at ${process.env.GROK_TEST_IMPORT_SIGNAL_PRIVATE_PATH}`);",
    '      error.code = "EPERM";',
    "      return error;",
    "    };",
    '    if (process.env.GROK_TEST_IMPORT_SIGNAL_MODE === "EPERM") throw failure();',
    '    if (process.env.GROK_TEST_IMPORT_SIGNAL_MODE === "ESRCH") {',
    '      try { originalKill(numericTarget, "SIGKILL"); } catch {}',
    '      const error = new Error("process group is already gone");',
    '      error.code = "ESRCH";',
    "      throw error;",
    "    }",
    '    if (process.env.GROK_TEST_IMPORT_SIGNAL_MODE === "THENABLE") {',
    "      return { then(resolve) { setTimeout(() => resolve(true), 25); } };",
    "    }",
    '    if (process.env.GROK_TEST_IMPORT_SIGNAL_MODE === "ASYNC_REJECT") {',
    "      return new Promise((resolve, reject) => setTimeout(() => reject(failure()), 25));",
    "    }",
    "  }",
    "  return originalKill(target, signal);",
    "};"
  ].join("\n"), { mode: 0o600 });
  return {
    env: {
      ...env,
      GROK_TEST_COMPANION_PRELOAD: preload,
      GROK_TEST_IMPORT_SIGNAL_LOG: logFile,
      GROK_TEST_IMPORT_SIGNAL_MODE: mode,
      GROK_TEST_IMPORT_SIGNAL_PRIVATE_PATH: privatePath
    },
    directory,
    preload,
    logFile
  };
}

function transferGuardDirectories(root) {
  const guardRoot = path.join(
    os.tmpdir(),
    `grok-companion-guards-${typeof process.getuid === "function" ? process.getuid() : "user"}`
  );
  const common = fs.realpathSync(
    git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")
  );
  return [...new Set([common, fs.realpathSync(root)].map((scope) => (
    path.join(guardRoot, crypto.createHash("sha256").update(scope).digest("hex"))
  )))];
}

function assertTransferRuntimeArtifactsGone(root, env) {
  const imports = path.join(workspaceState(root, env), "imports");
  assert.deepEqual(
    fs.existsSync(imports) ? fs.readdirSync(imports) : [],
    [],
    "transfer left a descriptor alias or converted transcript artifact"
  );
  for (const directory of transferGuardDirectories(root)) {
    assert.deepEqual(
      fs.existsSync(directory)
        ? fs.readdirSync(directory).filter((name) => name.endsWith(".json"))
        : [],
      [],
      "transfer left a canonical or legacy provider guard"
    );
  }
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

export {
  assert, crypto, fs, os, path, test,
  spawn, processGroupAlive, processStartToken, hasForeignActiveProvider, registerProviderGuard, unregisterProviderGuard,
  generateId, logFile, readJob, updateJob, writeJob, profileFor,
  workspaceState, CompanionError, attachTransferCleanupEvidence, asErrorPayload, redact, spawnReadOnlyWorker,
  assertContextCompatible, buildRuntimeEvidence, buildTaskEnvelope, captureContextManifest, evaluateScope, observeChangedPaths,
  scrubStoredJob, launchContractDigest, captureTerminalEvidence, normalizeTerminalProcessSignalError, selectTaskTerminalError, installFakeGrok,
  readFakeLog, installPinnedFakeCompanion, CODEX_COMPANION, COMPANION, ROOT, git,
  initRepo, runCodexCompanion, runCompanion, spawnNonblockingStdin, tempDir, testEnvironment,
  waitFor, missingInvalidProviderCapabilityReceiptMessage, pluginDataRoot, writeCodexSessionMetadata, parseJson, parseError,
  taskReport, fixture, codexTaskEnv, agentStdioCount, receiptPathFor, pluginDataForJobs,
  canonicalReceiptAdmissionMessage, transferFixture, injectedImportSignalEnv, transferGuardDirectories, assertTransferRuntimeArtifactsGone, spawnCompanion,
  persistedJobs, persistedJob, writeEnvelope, seedTerminalTaskJob, seedWorkspace, writeSeededJob,
  codexBrokerFixture, spawnPendingBrokerJob
};
