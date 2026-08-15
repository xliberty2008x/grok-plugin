import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { publishedVerificationChangedPaths } from "../plugins/grok/scripts/lib/task-runtime-evidence.mjs";
import { processStartToken } from "../plugins/grok/scripts/lib/process-control.mjs";
import { installFakeGrok } from "./fake-grok.mjs";
import {
  git,
  initRepo,
  runCompanion,
  tempDir,
  testEnvironment
} from "./helpers.mjs";

const PROVIDER_LIFECYCLE_AVAILABLE = Boolean(processStartToken(process.pid));

function workerReport(overrides = {}) {
  return `GROK_WORKER_REPORT: ${JSON.stringify({
    outcome: "complete",
    summary: "Fixture task completed",
    changedFiles: ["src/job-runner.mjs", "test/job-runner.test.mjs"],
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

function parseJson(result) {
  assert.equal(result.status, 0, `command failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test("issue #115: empty verification window keeps the terminal runtime changed paths", () => {
  assert.deepEqual(
    publishedVerificationChangedPaths({
      runtimeObservedPaths: ["src/job-runner.mjs", "test/job-runner.test.mjs"],
      verificationWindowPaths: []
    }),
    ["src/job-runner.mjs", "test/job-runner.test.mjs"]
  );
});

test("issue #115: read-only and no-change jobs still publish an empty path list", () => {
  assert.deepEqual(
    publishedVerificationChangedPaths({
      runtimeObservedPaths: [],
      verificationWindowPaths: []
    }),
    []
  );
});

test("issue #115: host verification mutations are published with the runtime paths", () => {
  assert.deepEqual(
    publishedVerificationChangedPaths({
      runtimeObservedPaths: ["src/job-runner.mjs"],
      verificationWindowPaths: ["tracked.txt"]
    }),
    ["src/job-runner.mjs", "tracked.txt"]
  );
});

test("issue #115: passing record-verification keeps two write-job paths", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, () => {
  const root = initRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/job-runner.mjs"), "export const run = () => {};\n");
  fs.writeFileSync(path.join(root, "test/job-runner.test.mjs"), "export const probe = () => {};\n");
  git(root, "add", "src/job-runner.mjs", "test/job-runner.test.mjs");
  git(root, "commit", "-m", "job-runner fixture");

  const pluginData = tempDir("grok-plugin-data-");
  const fake = installFakeGrok(tempDir("fake-grok-runtime-"), {
    taskText: workerReport(),
    taskMutatePaths: [
      {
        path: path.join(root, "src/job-runner.mjs"),
        contents: "export const run = () => ({ ok: true });\n"
      },
      {
        path: path.join(root, "test/job-runner.test.mjs"),
        contents: "export const probe = () => ({ ok: true });\n"
      }
    ]
  });
  const env = testEnvironment({ fake, pluginData });
  delete env.GROK_COMPANION_CHILD;
  delete env.GROK_COMPANION_JOB_MARKER;
  delete env.GROK_AGENT;
  delete env.GROK_LEADER_SOCKET;

  const envelope = {
    schemaVersion: 1,
    userRequest: "update the job runner and its test",
    objective: "Bounded two-file write",
    mode: "write",
    scope: { include: ["src/job-runner.mjs", "test/job-runner.test.mjs"], exclude: [] },
    context: {
      workspaceState: "task_scoped",
      requiredPaths: ["src/job-runner.mjs", "test/job-runner.test.mjs"]
    },
    acceptanceCriteria: [
      { id: "AC-01", text: "Change the runner" },
      { id: "AC-02", text: "Change the test" }
    ],
    requiredVerification: ["node --test test/job-runner.test.mjs"]
  };
  const job = parseJson(runCompanion(
    ["task", "--wait", "--write", "--envelope-stdin", "--json"],
    { cwd: root, env, input: JSON.stringify(envelope) }
  ));
  const runtimePaths = [...(job.result?.runtimeEvidence?.observedChangedPaths || [])].sort();
  assert.deepEqual(runtimePaths, [
    "src/job-runner.mjs",
    "test/job-runner.test.mjs"
  ]);

  const recorded = parseJson(runCompanion(
    ["record-verification", job.id, "--verification-stdin", "--json"],
    {
      cwd: root,
      env,
      input: JSON.stringify({
        commandOutcomes: [{
          command: "node --test test/job-runner.test.mjs",
          status: "passed",
          exitCode: 0
        }]
      })
    }
  ));
  assert.equal(recorded.result.hostVerification, "passed");
  assert.deepEqual(
    [...(recorded.result.verification.observedChangedPaths || [])].sort(),
    runtimePaths
  );
  const checkpoint = [...(recorded.lifecycleEvents || [])]
    .reverse()
    .find((event) => event.type === "checkpoint" && /Host verification passed/.test(event.summary || ""));
  assert.ok(checkpoint, "missing host verification checkpoint");
  assert.deepEqual(
    [...(checkpoint.detail?.observedChangedPaths || [])].sort(),
    runtimePaths
  );
});
