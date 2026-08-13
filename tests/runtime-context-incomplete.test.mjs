import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  assertContextCompatible,
  buildRuntimeEvidence,
  captureContextManifest,
  observeChangedPaths
} from "../plugins/grok/scripts/lib/task-contract.mjs";
import { CompanionError } from "../plugins/grok/scripts/lib/errors.mjs";
import { recordExecutionFailure } from "../plugins/grok/scripts/lib/companion-task-result.mjs";
import { generateId, readJob, updateJob, writeJob } from "../plugins/grok/scripts/lib/state.mjs";
import { bindContextMetadataCompleteness } from "../plugins/grok/scripts/lib/task-context-metadata.mjs";
import { assertContextManifestIntegrity } from "../plugins/grok/scripts/lib/task-context-manifest.mjs";
import { installFakeGrok, readFakeLog } from "./fake-grok.mjs";
import {
  git,
  initRepo,
  runCompanion,
  tempDir,
  testEnvironment
} from "./helpers.mjs";
import { installOversizeGitHook } from "./worker-mutation-test-helpers.mjs";

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
  delete env.GROK_COMPANION_CHILD;
  delete env.GROK_COMPANION_JOB_MARKER;
  delete env.GROK_AGENT;
  delete env.GROK_LEADER_SOCKET;
  return { fake, pluginData, env };
}

function agentStdioCount(logFile) {
  return readFakeLog(logFile).filter((entry) => (
    entry.event === "argv"
      && entry.args.includes("agent")
      && entry.args.includes("stdio")
  )).length;
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

function writeEnvelope(userRequest) {
  return JSON.stringify({
    schemaVersion: 1,
    userRequest,
    objective: userRequest,
    mode: "write",
    scope: { include: ["tracked.txt"], exclude: [] },
    context: {
      facts: [], constraints: [], expectedProjectMarkers: [], requiredPaths: ["tracked.txt"],
      workspaceState: "task_scoped", upstreamFreshness: "not_checked"
    },
    nonGoals: [],
    acceptanceCriteria: [{ id: "AC-01", text: "Complete the fixture task" }],
    requiredVerification: []
  });
}

function rebindContextManifest(value) {
  const canonicalJson = (item) => {
    if (item == null || typeof item !== "object") return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonicalJson).join(",")}]`;
    return `{${Object.keys(item).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(item[key])}`
    )).join(",")}}`;
  };
  const body = structuredClone(value);
  delete body.manifestId;
  delete body.digest;
  const digest = crypto.createHash("sha256").update(canonicalJson(body)).digest("hex");
  return { ...body, manifestId: `ctx-${digest.slice(0, 24)}`, digest };
}

test("direct positional and structured admission reject an unresolved upstream before acceptance", () => {
  const root = initRepo();
  const { fake, env, pluginData } = fixture();
  const branch = git(root, "branch", "--show-current");
  git(root, "config", `branch.${branch}.remote`, "origin");
  git(root, "config", `branch.${branch}.merge`, "refs/heads/missing-issue55");
  const invocations = [
    { args: ["task", "--background", "--fresh", "--json", "inspect unresolved context"] },
    {
      args: ["task", "--background", "--fresh", "--write", "--envelope-stdin", "--json"],
      input: writeEnvelope("edit only tracked.txt")
    }
  ];
  for (const invocation of invocations) {
    const error = parseError(runCompanion(invocation.args, {
      cwd: root,
      env,
      ...(invocation.input ? { input: invocation.input } : {})
    }), "E_CONTEXT_INCOMPLETE");
    assert.deepEqual(Object.keys(error).sort(), ["code", "message"]);
    assert.match(error.message, /upstream/);
    assert.equal(/drifted|different checkout/i.test(error.message), false);
    assert.equal(JSON.stringify(error).includes(root), false);
    assert.equal(JSON.stringify(error).includes("missing-issue55"), false);
  }
  assert.equal(persistedJobs(pluginData).length, 0);
  assert.equal(agentStdioCount(fake.logFile), 0);
});

test("comparable task-relevant ref drift outranks other incomplete metadata", () => {
  const root = initRepo();
  const before = captureContextManifest(root);
  const head = git(root, "rev-parse", "HEAD");
  const replaceRef = `refs/replace/${head}`;
  const hook = installOversizeGitHook(root, "comparable-ref-drift");
  try {
    git(root, "update-ref", replaceRef, head);
    const after = captureContextManifest(root);
    assert.equal(after.git.taskRelevantMetadataObservation.components.refs, "complete");
    assert.equal(after.git.taskRelevantMetadataObservation.components.hooks, "incomplete");
    assert.notEqual(
      before.git.sharedRefIdentity.taskRelevantRefIdentity,
      after.git.sharedRefIdentity.taskRelevantRefIdentity
    );
    const changed = observeChangedPaths(before, after);
    assert.equal(changed.includes("[GIT_METADATA]"), true);
    assert.equal(changed.includes("[GIT_METADATA_INCOMPLETE]"), true);
    const evidence = buildRuntimeEvidence({
      preContext: before,
      postContext: after,
      changedPaths: changed
    });
    assert.deepEqual(evidence.sharedRefObservation, {
      schemaVersion: 1,
      classification: "task_relevant_metadata_drift",
      toleratedUnrelatedSharedRefChurn: false,
      taskRelevantMetadataDrift: true
    });
    assert.equal(evidence.metadataCompletenessObservation.complete, false);
    assert.ok(evidence.metadataCompletenessObservation.metadataComponents.includes("hooks"));
    assert.throws(
      () => assertContextCompatible(root, before),
      (error) => error?.code === "E_CONTEXT_DRIFT"
        && error.details?.reasons?.includes("taskRelevantMetadataIdentity")
    );
  } finally {
    git(root, "update-ref", "-d", replaceRef);
    fs.unlinkSync(hook);
  }
});

test("comparable primary unrelated-ref drift remains strict during incompleteness", () => {
  const root = initRepo();
  const before = captureContextManifest(root);
  const head = git(root, "rev-parse", "HEAD");
  const unrelatedRef = "refs/heads/issue55-unrelated-incomplete";
  const hook = installOversizeGitHook(root, "comparable-unrelated-ref-drift");
  try {
    git(root, "update-ref", unrelatedRef, head);
    const after = captureContextManifest(root);
    assert.equal(after.git.taskRelevantMetadataObservation.components.refs, "complete");
    assert.equal(
      before.git.sharedRefIdentity.taskRelevantRefIdentity,
      after.git.sharedRefIdentity.taskRelevantRefIdentity
    );
    assert.notEqual(
      before.git.sharedRefIdentity.unrelatedRefIdentity,
      after.git.sharedRefIdentity.unrelatedRefIdentity
    );
    const changed = observeChangedPaths(before, after);
    assert.equal(changed.includes("[GIT_METADATA]"), true);
    assert.equal(changed.includes("[GIT_METADATA_INCOMPLETE]"), true);
    assert.throws(
      () => assertContextCompatible(root, before),
      (error) => error?.code === "E_CONTEXT_DRIFT"
    );
  } finally {
    git(root, "update-ref", "-d", unrelatedRef);
    fs.unlinkSync(hook);
  }
});

test("post-provider metadata incompleteness is typed before final cleanup", (t) => {
  const root = fs.realpathSync(initRepo());
  const transientHook = path.join(root, ".git", "hooks", "issue55-transient-post-provider");
  t.after(() => { if (fs.existsSync(transientHook)) fs.unlinkSync(transientHook); });
  const { fake, env, pluginData } = fixture({
    taskMutatePath: transientHook,
    taskMutation: "a".repeat((4 * 1024 * 1024) + 1)
  });
  const error = parseError(runCompanion(
    ["task", "--wait", "--fresh", "--json", "exercise transient terminal context"],
    { cwd: root, env }
  ), "E_CONTEXT_INCOMPLETE");
  assert.deepEqual(Object.keys(error).sort(), ["code", "message"]);
  assert.match(error.message, /hooks/);
  assert.equal(JSON.stringify(error).includes(root), false);
  assert.equal(fs.existsSync(transientHook), true);
  assert.equal(agentStdioCount(fake.logFile), 1);
  const [job] = persistedJobs(pluginData);
  assert.equal(job.status, "failed");
  assert.equal(job.phase, "context-rejected");
  assert.equal(job.error.code, "E_CONTEXT_INCOMPLETE");
  assert.deepEqual(job.error.details, {
    contextPhase: "terminal",
    metadataComponents: ["hooks"]
  });
  assert.deepEqual(job.result.runtimeEvidence.scopeViolations, []);
});

test("implicit resume rejects an incomplete old-v2 completion context before provider launch", () => {
  const root = fs.realpathSync(initRepo());
  const { fake, env, pluginData } = fixture({ taskText: taskReport("Seed implicit resume context.") });
  const completed = parseJson(runCompanion(
    ["task", "--wait", "--fresh", "seed implicit resume", "--json"],
    { cwd: root, env }
  ));
  const stored = persistedJob(pluginData, completed.id);
  const oldV2Body = structuredClone(stored.completionContextManifest);
  delete oldV2Body.git.taskRelevantMetadataObservation;
  const oldV2Incomplete = rebindContextManifest({
    ...oldV2Body,
    git: {
      ...oldV2Body.git,
      sharedRefIdentity: {
        ...oldV2Body.git.sharedRefIdentity,
        complete: false,
        attributable: false,
        taskRelevantRefs: [],
        unrelatedRefs: []
      }
    }
  });
  updateJob(root, completed.id, (current) => ({
    ...current,
    completionContextManifest: oldV2Incomplete
  }), env);
  const providerStarts = agentStdioCount(fake.logFile);
  const jobCount = persistedJobs(pluginData).length;
  const error = parseError(runCompanion(
    ["task", "--wait", "--resume", "continue implicit resume", "--json"],
    { cwd: root, env }
  ), "E_CONTEXT_INCOMPLETE");
  assert.deepEqual(Object.keys(error).sort(), ["code", "message"]);
  assert.match(error.message, /gitMetadata/);
  assert.equal(agentStdioCount(fake.logFile), providerStarts);
  assert.equal(persistedJobs(pluginData).length, jobCount);
});

test("failure finalization records ordinary context when complete terminal capture cannot", () => {
  const root = fs.realpathSync(initRepo());
  const pluginData = tempDir("grok-runtime-data-");
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginData };
  const id = generateId("task");
  const preContext = captureContextManifest(root);
  writeJob(root, {
    schemaVersion: 1,
    id,
    kind: "task",
    status: "running",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z"
  }, env);
  const hook = installOversizeGitHook(root, "failure-ordinary-capture");
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    const { captureCompleteContextManifest } = bindContextMetadataCompleteness({
      captureContextManifest,
      assertContextManifestIntegrity
    });
    assert.throws(
      () => captureCompleteContextManifest(root, { contextPhase: "terminal" }),
      (error) => error?.code === "E_CONTEXT_INCOMPLETE"
    );
    recordExecutionFailure({
      root,
      id,
      preContext,
      dispatchAttemptId: null,
      exactBrokerWorkerIdentity: () => false,
      terminalIntentFor: () => null,
      terminalIntentPatch: () => ({})
    }, new CompanionError("E_PROVIDER", "provider failed after admission"));
    const job = readJob(root, id, env);
    assert.equal(job.error.code, "E_PROVIDER");
    assert.ok(job.completionContextManifest);
    assert.equal(
      job.completionContextManifest.git?.taskRelevantMetadataObservation?.components?.hooks,
      "incomplete"
    );
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
    fs.unlinkSync(hook);
  }
});
