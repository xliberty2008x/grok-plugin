import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import {
  assertContextCompatible,
  assertTaskEnvelope,
  buildTaskEnvelope,
  captureContextManifest,
  observeChangedPaths
} from "../plugins/grok/scripts/lib/task-contract.mjs";
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
const IGNORED_DEPENDENCY_COUNT = 2001;

function fixture(config = {}) {
  const pluginData = tempDir("grok-runtime-data-");
  const fake = installFakeGrok(tempDir("fake-grok-runtime-"), {
    taskText: `GROK_WORKER_REPORT: ${JSON.stringify({
      outcome: "complete",
      summary: "Fixture task completed",
      changedFiles: [],
      checksClaimed: [],
      acceptanceResults: [
        { id: "AC-01", status: "met" },
        { id: "AC-02", status: "met" }
      ],
      risks: [],
      questions: []
    })}`,
    ...config
  });
  const env = testEnvironment({ fake, pluginData });
  delete env.GROK_COMPANION_CHILD;
  delete env.GROK_COMPANION_JOB_MARKER;
  delete env.GROK_AGENT;
  delete env.GROK_LEADER_SOCKET;
  return { fake, env, pluginData };
}

function parseJson(result) {
  assert.equal(result.status, 0, `command failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function populateNodeModules(root, count = IGNORED_DEPENDENCY_COUNT) {
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  for (let index = 0; index < count; index += 1) {
    fs.writeFileSync(
      path.join(root, "node_modules", "pkg", `mod-${index}.js`),
      `export default ${index};\n`
    );
  }
}

function nodeWorkspace() {
  const root = initRepo();
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\ndist/\nsecret-output.txt\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-m", "ignore node_modules, dist, and secret-output");
  populateNodeModules(root);
  return root;
}

function disposeNodeWorkspace(root) {
  for (const relative of ["node_modules", "dist", "dist-backup", "secret-output.txt"]) {
    fs.rmSync(path.join(root, relative), { recursive: true, force: true });
  }
}

function verificationEnvelope(overrides = {}) {
  return {
    schemaVersion: 1,
    userRequest: "prepare declared verification outputs",
    objective: "Prepare declared verification outputs",
    mode: "read",
    scope: { include: ["tracked.txt"], exclude: [] },
    context: {
      workspaceState: "task_scoped",
      requiredPaths: ["tracked.txt"]
    },
    acceptanceCriteria: [
      { id: "AC-01", text: "Prepare the fixture" },
      { id: "AC-02", text: "Report the result" }
    ],
    requiredVerification: ["pnpm build:web"],
    verificationGeneratedPaths: ["dist"],
    ...overrides
  };
}

function writeDist(root, body = "console.log('built');\n") {
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "app.js"), body);
}

test("buildTaskEnvelope defaults verificationGeneratedPaths to an empty list", () => {
  const envelope = buildTaskEnvelope({
    userRequest: "inspect verification defaults",
    verificationGeneratedPaths: []
  });
  assert.deepEqual(envelope.verificationGeneratedPaths, []);
});

test("legacy v1 envelopes without verificationGeneratedPaths keep their identity", () => {
  const legacy = buildTaskEnvelope({ userRequest: "legacy envelope without generated paths" });
  assert.equal(Object.hasOwn(legacy, "verificationGeneratedPaths"), false);
  const accepted = assertTaskEnvelope(structuredClone(legacy));
  assert.equal(accepted.digest, legacy.digest);
  assert.equal(accepted.envelopeId, legacy.envelopeId);
  const declared = buildTaskEnvelope({
    userRequest: "legacy envelope without generated paths",
    verificationGeneratedPaths: ["dist"]
  });
  assert.notEqual(declared.digest, legacy.digest);
});

test("verificationGeneratedPaths are bounded before context capture", () => {
  const many = Array.from({ length: 200 }, (_, index) => `generated-${index}`);
  const envelope = buildTaskEnvelope({
    userRequest: "bound oversized generated-path lists",
    verificationGeneratedPaths: many
  });
  assert.equal(envelope.verificationGeneratedPaths.length, 64);
  assert.deepEqual(envelope.verificationGeneratedPaths, many.slice(0, 64));
});

describe("issue 94 large ignored fixtures", { concurrency: 1 }, () => {
test("declared dist is excluded from verification identity when ignored inventory exceeds 2000", (t) => {
  const root = nodeWorkspace();
  t.after(() => disposeNodeWorkspace(root));
  const before = captureContextManifest(root, { verificationGeneratedPaths: ["dist"] });
  assert.equal(before.git.ignoredEntryCount >= IGNORED_DEPENDENCY_COUNT, true);
  assert.equal(before.git.ignoredEntriesAttributable, false);
  writeDist(root);
  const after = captureContextManifest(root, { verificationGeneratedPaths: ["dist"] });
  assert.deepEqual(observeChangedPaths(before, after, { observer: "verification" }), []);
  assert.deepEqual(observeChangedPaths(before, after, { observer: "full" }), ["[IGNORED_WORKTREE]"]);
  assert.throws(
    () => assertContextCompatible(root, before),
    (error) => error?.code === "E_CONTEXT_DRIFT"
      && error.details?.reasons?.includes("ignoredDigest")
  );
});

test("undeclared dist and unexpected ignored files stay visible to verification", (t) => {
  const root = nodeWorkspace();
  t.after(() => disposeNodeWorkspace(root));
  const undeclaredBefore = captureContextManifest(root);
  writeDist(root, "undeclared\n");
  assert.deepEqual(
    observeChangedPaths(undeclaredBefore, captureContextManifest(root), { observer: "verification" }),
    ["[IGNORED_WORKTREE]"]
  );

  const declaredBefore = captureContextManifest(root, { verificationGeneratedPaths: ["dist"] });
  writeDist(root, "declared again\n");
  fs.writeFileSync(path.join(root, "secret-output.txt"), "unexpected ignored write\n");
  const mixed = observeChangedPaths(
    declaredBefore,
    captureContextManifest(root, { verificationGeneratedPaths: ["dist"] }),
    { observer: "verification" }
  );
  assert.equal(mixed.includes("secret-output.txt") || mixed.includes("[IGNORED_WORKTREE]"), true);
  assert.equal(mixed.includes("dist/app.js"), false);
});

test("declared dist does not match similarly prefixed ignored paths", (t) => {
  const root = nodeWorkspace();
  t.after(() => disposeNodeWorkspace(root));
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\ndist/\ndist-backup/\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-m", "also ignore dist-backup");
  const before = captureContextManifest(root, { verificationGeneratedPaths: ["dist"] });
  fs.mkdirSync(path.join(root, "dist-backup"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist-backup", "app.js"), "not declared\n");
  const changed = observeChangedPaths(
    before,
    captureContextManifest(root, { verificationGeneratedPaths: ["dist"] }),
    { observer: "verification" }
  );
  assert.equal(changed.includes("dist-backup/app.js") || changed.includes("[IGNORED_WORKTREE]"), true);
});

test("record-verification accepts declared dist drift and continues the same job", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, (t) => {
  const root = nodeWorkspace();
  t.after(() => disposeNodeWorkspace(root));
  const { env } = fixture();
  const job = parseJson(runCompanion(
    ["task", "--wait", "--envelope-stdin", "--json"],
    { cwd: root, env, input: JSON.stringify(verificationEnvelope()) }
  ));
  writeDist(root);
  const recorded = parseJson(runCompanion(
    ["record-verification", job.id, "--verification-stdin", "--json"],
    {
      cwd: root,
      env,
      input: JSON.stringify({
        commandOutcomes: [{ command: "pnpm build:web", status: "passed", exitCode: 0 }]
      })
    }
  ));
  assert.equal(recorded.result.hostVerification, "passed");
  assert.equal(recorded.result.verification.authority, "host_asserted");
  assert.deepEqual(recorded.result.verification.observedChangedPaths, []);
  const serialized = JSON.stringify(recorded);
  assert.equal(serialized.includes(root), false);

  const resumed = parseJson(runCompanion(
    ["task", "--wait", "--job-id", job.id, "continue after declared dist verification", "--json"],
    { cwd: root, env }
  ));
  assert.equal(resumed.resumeJobId, job.id);
});

test("record-verification rejects unexpected ignored drift beside declared dist", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, (t) => {
  const root = nodeWorkspace();
  t.after(() => disposeNodeWorkspace(root));
  const { env } = fixture();
  const job = parseJson(runCompanion(
    ["task", "--wait", "--envelope-stdin", "--json"],
    { cwd: root, env, input: JSON.stringify(verificationEnvelope()) }
  ));
  writeDist(root);
  fs.writeFileSync(path.join(root, "secret-output.txt"), "unexpected\n");
  const rejected = runCompanion(
    ["record-verification", job.id, "--verification-stdin", "--json"],
    {
      cwd: root,
      env,
      input: JSON.stringify({
        commandOutcomes: [{ command: "pnpm build:web", status: "passed", exitCode: 0 }]
      })
    }
  );
  assert.notEqual(rejected.status, 0);
  const error = JSON.parse(rejected.stdout).error;
  assert.equal(error.code, "E_SCOPE_VIOLATION");
  const paths = error.details?.paths || [];
  assert.equal(paths.includes("secret-output.txt") || paths.includes("[IGNORED_WORKTREE]"), true);
  assert.equal(JSON.stringify(error).includes(root), false);
});

test("ordinary resume still fails closed on undeclared ignored dist drift", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, (t) => {
  const root = nodeWorkspace();
  t.after(() => disposeNodeWorkspace(root));
  const { env } = fixture();
  const job = parseJson(runCompanion(
    ["task", "--wait", "--envelope-stdin", "--json"],
    { cwd: root, env, input: JSON.stringify(verificationEnvelope()) }
  ));
  writeDist(root);
  const resumed = runCompanion(
    ["task", "--wait", "--job-id", job.id, "continue without recording verification", "--json"],
    { cwd: root, env }
  );
  assert.notEqual(resumed.status, 0);
  const error = JSON.parse(resumed.stdout).error;
  assert.equal(error.code, "E_CONTEXT_DRIFT");
  assert.match(error.message, /ignoredDigest/);
  assert.equal(JSON.stringify(error).includes(root), false);
});
});
