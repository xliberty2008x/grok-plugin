import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  initRepo,
  run,
  runPtyStdin,
  tempDir,
  waitFor,
  ROOT
} from "./helpers.mjs";
import { installFakeGrok, readFakeLog } from "./fake-grok.mjs";
import { STDIN_READY_MARKER } from "../plugins/grok/scripts/lib/stdin.mjs";

const codexProbe = run("codex", ["plugin", "--help"], { timeout: 5000 });
const CODEX_AVAILABLE = codexProbe.status === 0;
const pythonProbe = run("python3", ["--version"], { timeout: 5000 });
const PYTHON_AVAILABLE = pythonProbe.status === 0;
const CODEX_REQUIRED = process.env.CODEX_INSTALL_E2E_REQUIRED === "1"
  || process.env.npm_lifecycle_event === "test:installed-codex";

function parseSuccessful(result, label) {
  assert.equal(result.status, 0, `${label} failed:\n${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function namedArtifacts(root, names) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (names.has(entry.name)) found.push(absolute);
      if (entry.isDirectory()) visit(absolute);
    }
  };
  visit(root);
  return found;
}

test("installed Codex marketplace snapshot accepts private delayed nonblocking PTY input", {
  skip: process.platform === "win32" && !CODEX_REQUIRED
    ? "nonblocking fd regression harness is POSIX-only"
    : (!(CODEX_AVAILABLE && PYTHON_AVAILABLE) && !CODEX_REQUIRED
      ? "Codex plugin CLI or Python PTY harness is not installed"
      : false)
}, async (t) => {
  assert.notEqual(process.platform, "win32", "the required installed-Codex PTY gate currently needs macOS or Linux");
  assert.equal(CODEX_AVAILABLE, true, "Codex plugin CLI is required for the installed-artifact gate");
  assert.equal(PYTHON_AVAILABLE, true, "Python 3 is required for the installed PTY gate");
  const codexHome = tempDir("grok-installed-codex-home-");
  const isolatedHome = tempDir("grok-installed-user-home-");
  const fakeRoot = tempDir("grok-installed-fake-");
  const root = initRepo();
  t.after(() => {
    for (const directory of [codexHome, isolatedHome, fakeRoot, root]) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  const installEnv = { ...process.env, CODEX_HOME: codexHome, HOME: isolatedHome };
  parseSuccessful(
    run("codex", ["plugin", "marketplace", "add", ROOT, "--json"], { cwd: ROOT, env: installEnv, timeout: 20000 }),
    "local marketplace install"
  );
  const installed = parseSuccessful(
    run("codex", ["plugin", "add", "grok@grok-companion", "--json"], { cwd: ROOT, env: installEnv, timeout: 20000 }),
    "plugin install"
  );
  const installedRoot = fs.realpathSync(installed.installedPath);
  const wrapper = path.join(installedRoot, "scripts", "grok-codex.mjs");
  const cacheRoot = fs.realpathSync(path.join(codexHome, "plugins", "cache"));
  const cacheRelative = path.relative(cacheRoot, installedRoot);
  assert.equal(cacheRelative.startsWith("..") || path.isAbsolute(cacheRelative), false);
  assert.equal(installedRoot.startsWith(fs.realpathSync(path.join(ROOT, "plugins", "grok"))), false);

  const fake = installFakeGrok(fakeRoot, {
    requireAgentProfileUnderGrokHome: true,
    taskText: `GROK_WORKER_REPORT: ${JSON.stringify({
      outcome: "complete",
      summary: "Installed Codex ingress completed",
      changedFiles: [],
      checksClaimed: [],
      acceptanceResults: [{ id: "AC-01", status: "met" }],
      risks: [],
      questions: []
    })}`
  });
  const pluginData = path.join(codexHome, "plugins", "data", "grok-grok-companion");
  const env = {
    ...installEnv,
    GROK_BIN: fake.binary,
    GROK_AUTH_PATH: fake.authPath,
    CODEX_THREAD_ID: "installed-codex-ingress-regression",
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_HOST_SESSION_ID: "installed-codex-ingress-regression",
    GROK_COMPANION_PLUGIN_DATA: pluginData,
    GROK_TEST_PTY_OBSERVE_LOG: fake.logFile
  };
  for (const key of [
    "CLAUDE_PLUGIN_DATA",
    "CLAUDE_PROJECT_DIR",
    "CLAUDE_SESSION_ID",
    "GROK_COMPANION_CLAUDE_SESSION_ID",
    "GROK_COMPANION_CHILD",
    "GROK_COMPANION_JOB_MARKER",
    "GROK_AGENT",
    "GROK_LEADER_SOCKET"
  ]) delete env[key];

  const envelope = JSON.stringify({
    schemaVersion: 1,
    userRequest: "inspect the installed-artifact host ingress boundary",
    objective: "Accept a delayed TaskEnvelope from a nonblocking Codex host fd",
    mode: "read",
    scope: { include: [], exclude: [] },
    context: {
      facts: ["This command runs from the Codex marketplace cache."],
      constraints: ["Do not edit the fixture."],
      expectedProjectMarkers: [],
      requiredPaths: ["tracked.txt"],
      workspaceState: "task_scoped",
      upstreamFreshness: "not_checked"
    },
    nonGoals: ["Do not use the source-tree wrapper."],
    acceptanceCriteria: [{ id: "AC-01", text: "Dispatch exactly once from the installed snapshot." }],
    requiredVerification: ["git status --short"],
    expectedReturnFormat: "GROK_WORKER_REPORT JSON plus concise human summary"
  });
  const beforeStatus = run("git", ["status", "--short"], { cwd: root, env, timeout: 5000 });
  assert.equal(beforeStatus.status, 0, beforeStatus.stderr);
  const dispatch = runPtyStdin(
    wrapper,
    ["task", "--background", "--envelope-stdin", "--stdin-ready", "--fresh", "--effort", "high", "--json"],
    { cwd: root, env, input: envelope, timeout: 30000 }
  );
  assert.equal(dispatch.driver.status, 0, dispatch.driver.stderr || dispatch.driver.stdout);
  assert.ok(dispatch.result, "PTY driver did not return structured evidence");
  assert.equal(dispatch.result.ready, true, dispatch.result.stderr);
  assert.equal(dispatch.result.aliveBeforeInput, true);
  assert.equal(dispatch.result.providerStartsBeforeInput, 0);
  assert.equal(dispatch.result.writeError, null);
  assert.equal(dispatch.result.code, 0, dispatch.result.stderr || dispatch.result.stdout);
  assert.match(dispatch.result.stderr, new RegExp(STDIN_READY_MARKER));
  assert.equal(dispatch.result.ptyOutput, "", "private TaskEnvelope or terminal control data was echoed by the PTY");
  const job = JSON.parse(dispatch.result.stdout);

  const terminal = await waitFor(() => {
    const status = run(process.execPath, [wrapper, "status", job.id, "--json"], { cwd: root, env, timeout: 5000 });
    if (status.status !== 0) return null;
    const parsed = JSON.parse(status.stdout);
    return ["completed", "failed", "cancelled"].includes(parsed.status) ? parsed : null;
  }, { timeoutMs: 10000 });
  assert.equal(terminal.status, "completed");
  const providerStarts = readFakeLog(fake.logFile).filter(
    (entry) => entry.event === "argv" && entry.args.includes("agent") && entry.args.includes("stdio")
  );
  assert.equal(providerStarts.length, 1);
  const taskProfileEvidence = readFakeLog(fake.logFile).find((entry) => entry.event === "agent-profile");
  assert.ok(taskProfileEvidence?.exists, "installed provider could not read its materialized agent profile");
  assert.equal(taskProfileEvidence.insideGrokHome, true, "installed provider argv pointed back into the Codex plugin cache");
  assert.equal(taskProfileEvidence.mode, 0o600);
  assert.equal(fs.existsSync(taskProfileEvidence.path), false, "installed agent profile remained after verified provider exit");

  const verification = JSON.stringify({
    commandOutcomes: [{ command: "git status --short", status: "passed", exitCode: 0 }]
  });
  const record = runPtyStdin(
    wrapper,
    ["record-verification", job.id, "--verification-stdin", "--stdin-ready", "--json"],
    { cwd: root, env, input: verification, timeout: 30000 }
  );
  assert.equal(record.driver.status, 0, record.driver.stderr || record.driver.stdout);
  assert.equal(record.result?.ready, true, record.result?.stderr);
  assert.equal(record.result?.aliveBeforeInput, true);
  assert.equal(record.result?.providerStartsBeforeInput, 1);
  assert.equal(record.result?.writeError, null);
  assert.equal(record.result?.code, 0, record.result?.stderr || record.result?.stdout);
  assert.equal(record.result?.ptyOutput, "", "private verification record or terminal control data was echoed by the PTY");
  assert.equal(JSON.parse(record.result.stdout).result.hostVerification, "passed");

  const setup = parseSuccessful(
    run(process.execPath, [wrapper, "setup", "--json"], { cwd: root, env, timeout: 30_000 }),
    "installed setup probe"
  );
  assert.equal(setup.ready, true, JSON.stringify(setup));
  const profileEvents = readFakeLog(fake.logFile).filter((entry) => entry.event === "agent-profile");
  assert.equal(profileEvents.length, 2, "installed setup/task did not each launch one isolated ACP profile");
  const expectedDigests = new Map([
    ["rescue-read-v3", sha256(path.join(installedRoot, "provider-agents", "rescue-read.md"))],
    ["setup-probe-v2", sha256(path.join(installedRoot, "provider-agents", "setup-probe.md"))]
  ]);
  for (const evidence of profileEvents) {
    const profileId = [...expectedDigests.keys()].find((id) => path.basename(evidence.path).startsWith(`${id}-`));
    assert.ok(profileId, `unexpected installed profile path: ${evidence.path}`);
    assert.equal(evidence.sha256, expectedDigests.get(profileId), `${profileId} digest drifted while materializing`);
    assert.equal(evidence.insideGrokHome, true, `${profileId} was outside isolated GROK_HOME`);
    assert.equal(evidence.mode, 0o600, `${profileId} was not private`);
    const cacheRelativeProfile = path.relative(installedRoot, evidence.path);
    assert.equal(cacheRelativeProfile === "" || (!cacheRelativeProfile.startsWith("..") && !path.isAbsolute(cacheRelativeProfile)), false, `${profileId} argv pointed into the installed cache`);
    assert.equal(fs.existsSync(evidence.path), false, `${profileId} remained after verified provider exit`);
  }
  assert.deepEqual(
    namedArtifacts(pluginData, new Set(["auth.json", "agent-profiles"])),
    [],
    "installed provider left credential or staged-profile artifacts behind"
  );
  const afterStatus = run("git", ["status", "--short"], { cwd: root, env, timeout: 5000 });
  assert.equal(afterStatus.status, 0, afterStatus.stderr);
  assert.equal(afterStatus.stdout, beforeStatus.stdout, "installed read-only regression mutated the fixture repository");
});
