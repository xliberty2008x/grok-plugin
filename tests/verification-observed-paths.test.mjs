import assert from "node:assert/strict";
import test from "node:test";

import { hasGrokAncestor, processStartToken } from "../plugins/grok/scripts/lib/process-control.mjs";
import { projectVerificationObservedPaths } from "../plugins/grok/scripts/lib/task-runtime-evidence.mjs";
import { tryReadJob, updateJob } from "../plugins/grok/scripts/lib/state.mjs";
import { initRepo, runCompanion, tempDir, testEnvironment } from "./helpers.mjs";
import { installFakeGrok } from "./fake-grok.mjs";

const PROVIDER_LIFECYCLE_AVAILABLE = Boolean(processStartToken(process.pid));
const NESTED_GROK_SESSION = hasGrokAncestor();

function workerReport(overrides = {}) {
  return `GROK_WORKER_REPORT: ${JSON.stringify({
    outcome: "complete",
    summary: "Fixture task completed",
    changedFiles: [],
    checksClaimed: [],
    acceptanceResults: [
      { id: "AC-01", status: "met" },
      { id: "AC-02", status: "met" }
    ],
    risks: [],
    questions: [],
    ...overrides
  })}`;
}

function fixture(config = {}) {
  const data = tempDir("grok-vop-data-");
  const fake = installFakeGrok(tempDir("grok-vop-fake-"), config);
  const env = testEnvironment({ fake, pluginData: data });
  delete env.GROK_COMPANION_CHILD;
  delete env.GROK_COMPANION_JOB_MARKER;
  delete env.GROK_AGENT;
  delete env.GROK_LEADER_SOCKET;
  return { env, pluginData: data };
}

function parseJson(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("verification projection keeps runtime paths when the host check is clean", () => {
  assert.deepEqual(
    projectVerificationObservedPaths(
      ["src/job-runner.mjs", "test/job-runner.test.mjs"],
      []
    ),
    ["src/job-runner.mjs", "test/job-runner.test.mjs"]
  );
});

test("verification projection keeps empty paths for a no-change job", () => {
  assert.deepEqual(projectVerificationObservedPaths([], []), []);
});

test("verification projection preserves runtime order and appends host-check extras", () => {
  assert.deepEqual(
    projectVerificationObservedPaths(
      ["src/job-runner.mjs", "test/job-runner.test.mjs"],
      ["target.txt"]
    ),
    ["src/job-runner.mjs", "test/job-runner.test.mjs", "target.txt"]
  );
});

test("integration: record-verification publishes the terminal runtime paths", {
  skip: NESTED_GROK_SESSION
    ? "nested Grok ancestor refuses companion CLI (CI is the authority)"
    : !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, () => {
  const root = initRepo();
  const { env, pluginData } = fixture({ taskText: workerReport() });
  const envelope = {
    schemaVersion: 1,
    userRequest: "prepare two-file write evidence",
    objective: "Prepare two-file write evidence",
    mode: "read",
    scope: { include: ["src/job-runner.mjs", "test/job-runner.test.mjs"], exclude: [] },
    context: {
      workspaceState: "task_scoped",
      requiredPaths: ["src/job-runner.mjs", "test/job-runner.test.mjs"]
    },
    acceptanceCriteria: [
      { id: "AC-01", text: "Prepare the fixture" },
      { id: "AC-02", text: "Report the result" }
    ],
    requiredVerification: ["npm test", "git diff --check"]
  };
  const job = parseJson(runCompanion(
    ["task", "--wait", "--envelope-stdin", "--json"],
    { cwd: root, env, input: JSON.stringify(envelope) }
  ));
  const runtimePaths = ["src/job-runner.mjs", "test/job-runner.test.mjs"];
  const previousData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    updateJob(root, job.id, (current) => {
      current.result = {
        ...(current.result || {}),
        runtimeEvidence: {
          ...(current.result?.runtimeEvidence || {}),
          observedChangedPaths: runtimePaths
        }
      };
      return current;
    }, env);
    assert.deepEqual(
      tryReadJob(root, job.id, env).result.runtimeEvidence.observedChangedPaths,
      runtimePaths
    );
  } finally {
    if (previousData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousData;
  }

  const recorded = parseJson(runCompanion(
    ["record-verification", job.id, "--verification-stdin", "--json"],
    {
      cwd: root,
      env,
      input: JSON.stringify({
        commandOutcomes: [
          { command: "npm test", status: "passed", exitCode: 0 },
          { command: "git diff --check", status: "passed", exitCode: 0 }
        ]
      })
    }
  ));
  assert.equal(recorded.result.hostVerification, "passed");
  assert.deepEqual(recorded.result.runtimeEvidence.observedChangedPaths, runtimePaths);
  assert.deepEqual(recorded.result.verification.observedChangedPaths, runtimePaths);
  const checkpoint = [...recorded.lifecycleEvents].reverse().find((event) => (
    event.type === "checkpoint" && event.summary === "Host verification passed"
  ));
  assert.ok(checkpoint);
  assert.deepEqual(checkpoint.detail.observedChangedPaths, runtimePaths);
});
