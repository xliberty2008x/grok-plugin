import assert from "node:assert/strict";
import test from "node:test";

import * as taskContract from "../plugins/grok/scripts/lib/task-contract.mjs";
import * as taskContextManifest from "../plugins/grok/scripts/lib/task-context-manifest.mjs";
import * as taskContextPolicy from "../plugins/grok/scripts/lib/task-context-policy.mjs";
import * as taskContextWorktree from "../plugins/grok/scripts/lib/task-context-worktree.mjs";
import * as taskEnvelope from "../plugins/grok/scripts/lib/task-envelope.mjs";
import * as taskLifecycle from "../plugins/grok/scripts/lib/task-lifecycle.mjs";
import * as taskPrimitives from "../plugins/grok/scripts/lib/task-contract-primitives.mjs";
import * as taskProviderPrompt from "../plugins/grok/scripts/lib/task-provider-prompt.mjs";
import * as taskRuntimeEvidence from "../plugins/grok/scripts/lib/task-runtime-evidence.mjs";
import * as taskScope from "../plugins/grok/scripts/lib/task-scope.mjs";
import * as workerReportContract from "../plugins/grok/scripts/lib/worker-report-contract.mjs";

const TASK_CONTRACT_EXPORTS = Object.freeze([
  "CONTEXT_MANIFEST_VERSION",
  "CONTEXT_METADATA_POLICIES",
  "LIFECYCLE_EVENT_TYPES",
  "MAX_LIFECYCLE_EVENTS",
  "TASK_ENVELOPE_VERSION",
  "WORKER_REPORT_VERSION",
  "appendLifecycleEvent",
  "assertContextCompatible",
  "assertContextManifestIntegrity",
  "assertTaskContextReady",
  "assertTaskEnvelope",
  "bindTaskEnvelopeContext",
  "boundPathEvidence",
  "buildRuntimeEvidence",
  "buildTaskEnvelope",
  "buildWorkerReport",
  "buildWorkerReportOutputSchema",
  "captureContextManifest",
  "composeProviderPrompt",
  "composeWorkerReportRepairPrompt",
  "evaluateScope",
  "isVerificationCacheIgnoredPath",
  "normalizeLifecycleEventSequences",
  "observeChangedPaths",
  "parseTaskEnvelopeInput",
  "scrubStoredJob",
  "scrubStoredRequest"
]);

test("task-contract remains an exact explicit compatibility facade", () => {
  assert.deepEqual(Object.keys(taskContract).sort(), TASK_CONTRACT_EXPORTS);
  const sources = [
    [taskScope, ["evaluateScope"]],
    [taskLifecycle, [
      "LIFECYCLE_EVENT_TYPES",
      "MAX_LIFECYCLE_EVENTS",
      "appendLifecycleEvent",
      "normalizeLifecycleEventSequences"
    ]],
    [taskEnvelope, [
      "TASK_ENVELOPE_VERSION",
      "assertTaskEnvelope",
      "bindTaskEnvelopeContext",
      "buildTaskEnvelope",
      "parseTaskEnvelopeInput",
      "scrubStoredJob",
      "scrubStoredRequest"
    ]],
    [taskPrimitives, ["boundPathEvidence"]],
    [workerReportContract, [
      "WORKER_REPORT_VERSION",
      "buildWorkerReport",
      "buildWorkerReportOutputSchema",
      "composeWorkerReportRepairPrompt"
    ]],
    [taskContextPolicy, [
      "CONTEXT_MANIFEST_VERSION",
      "CONTEXT_METADATA_POLICIES"
    ]],
    [taskContextManifest, [
      "assertContextCompatible",
      "assertContextManifestIntegrity",
      "assertTaskContextReady",
      "captureContextManifest"
    ]],
    [taskContextWorktree, ["isVerificationCacheIgnoredPath"]],
    [taskRuntimeEvidence, ["buildRuntimeEvidence", "observeChangedPaths"]],
    [taskProviderPrompt, ["composeProviderPrompt"]]
  ];
  const checked = [];
  for (const [source, names] of sources) {
    for (const name of names) {
      assert.equal(taskContract[name], source[name], `${name} must be a direct leaf binding`);
      checked.push(name);
    }
  }
  assert.deepEqual(checked.sort(), TASK_CONTRACT_EXPORTS);
  assert.equal(Object.hasOwn(taskContract, "default"), false);
});

test("scope matching preserves glob semantics, include/exclude priority, and order", () => {
  assert.deepEqual(taskScope.evaluateScope(
    [
      "src/top.js",
      "src/nested/deep.js",
      "src/generated/skip.js",
      "test1.js",
      "test12.js",
      "docs/readme.md"
    ],
    {
      include: ["src/**/*.js", "test?.js"],
      exclude: ["src/**/skip.js"]
    }
  ), ["src/generated/skip.js", "test12.js", "docs/readme.md"]);

  assert.deepEqual(
    taskScope.evaluateScope(["root.js", "nested/file.js"], { include: ["*.js"] }),
    ["nested/file.js"]
  );
  assert.deepEqual(
    taskScope.evaluateScope(["root.js", "nested/file.js"], { include: ["**"] }),
    []
  );
  assert.deepEqual(
    taskScope.evaluateScope(["src/top.js", "src/nested/deep.js"], { include: ["src/**/*.js"] }),
    []
  );
});

test("scope matching normalizes matching paths without rewriting retained evidence", () => {
  assert.deepEqual(taskScope.evaluateScope(
    ["src\\windows.js", "./src/relative.js", "outside.js"],
    { include: ["./src\\**\\*.js"] }
  ), ["outside.js"]);

  assert.deepEqual(taskScope.evaluateScope(
    ["z.txt", "./src/a.js", "z.txt", "[CHANGED_PATHS_OVERFLOW]", "", "./src/a.js"],
    { include: ["src/**"] }
  ), ["z.txt", "[CHANGED_PATHS_OVERFLOW]", ""]);
});

test("scope rules retain trimming, sanitization, clipping, and the 64-rule bound", () => {
  assert.deepEqual(
    taskScope.evaluateScope(["src/a.js"], { include: ["  \u001b[31msrc/*.js  "] }),
    []
  );

  const clippedPattern = `${"a".repeat(2048)}…`;
  assert.deepEqual(
    taskScope.evaluateScope([clippedPattern], { include: ["a".repeat(2049)] }),
    []
  );

  const boundedRules = Array.from({ length: 64 }, (_, index) => `allowed-${index}.js`);
  assert.deepEqual(
    taskScope.evaluateScope(["ignored-65th.js"], {
      include: [...boundedRules, "ignored-65th.js"]
    }),
    ["ignored-65th.js"]
  );
});

test("lifecycle normalization is monotonic and does not mutate its input", () => {
  const events = [
    { type: "checkpoint", summary: "one", sequence: 4 },
    { type: "checkpoint", summary: "two", sequence: 3 },
    { type: "checkpoint", summary: "three" },
    { type: "checkpoint", summary: "four", sequence: 10 }
  ];
  const before = structuredClone(events);
  const normalized = taskLifecycle.normalizeLifecycleEventSequences(events);

  assert.deepEqual(normalized.map((event) => event.sequence), [4, 5, 6, 10]);
  assert.deepEqual(events, before);
  assert.notEqual(normalized[0], events[0]);
});

test("lifecycle append redacts, bounds, retains 128 events, and leaves input immutable", () => {
  const original = [{
    type: "checkpoint",
    at: "2026-07-31T00:00:00.000Z",
    summary: "existing",
    sequence: 1
  }];
  const before = structuredClone(original);
  const syntheticSensitiveValue = ["redaction", "fixture"].join("-");
  const appended = taskLifecycle.appendLifecycleEvent(
    original,
    "checkpoint",
    `xai-${"s".repeat(20)} ${"x".repeat(600)}`,
    {
      password: syntheticSensitiveValue,
      nested: { apiKey: syntheticSensitiveValue },
      note: "y".repeat(1200)
    }
  );

  assert.deepEqual(original, before);
  assert.equal(appended.length, 2);
  assert.equal(appended[1].sequence, 2);
  assert.match(appended[1].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(appended[1].summary.includes("xai-"), false);
  assert.equal(appended[1].summary.length, 501);
  assert.equal(appended[1].summary.endsWith("…"), true);
  assert.equal(appended[1].detail.password, "[REDACTED]");
  assert.equal(appended[1].detail.nested.apiKey, "[REDACTED]");
  assert.equal(appended[1].detail.note.length, 1001);
  assert.equal(appended[1].detail.note.endsWith("…"), true);

  let retained = [];
  for (let index = 1; index <= taskLifecycle.MAX_LIFECYCLE_EVENTS + 1; index += 1) {
    retained = taskLifecycle.appendLifecycleEvent(retained, "checkpoint", `event ${index}`);
  }
  assert.equal(retained.length, 128);
  assert.equal(retained[0].sequence, 2);
  assert.equal(retained.at(-1).sequence, 129);
});

test("lifecycle append rejects unknown event types with the stable state error", () => {
  assert.throws(
    () => taskLifecycle.appendLifecycleEvent([], "secret.thought", "not public"),
    (error) => error?.code === "E_STATE"
      && error?.message === "Unknown lifecycle event type secret.thought."
  );
});
