import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  appendLifecycleEvent,
  assertContextCompatible,
  assertTaskContextReady,
  buildRuntimeEvidence,
  buildTaskEnvelope,
  buildWorkerReport,
  captureContextManifest,
  composeProviderPrompt,
  composeWorkerReportRepairPrompt,
  evaluateScope,
  observeChangedPaths
} from "../plugins/grok/scripts/lib/task-contract.mjs";
import { validateReview, REVIEW_SCHEMA } from "../plugins/grok/scripts/lib/grok-provider.mjs";
import { processStartToken } from "../plugins/grok/scripts/lib/process-control.mjs";
import { STDIN_READY_MARKER } from "../plugins/grok/scripts/lib/stdin.mjs";
import {
  initRepo,
  git,
  runCompanion,
  runCodexCompanion,
  spawnNonblockingStdin,
  testEnvironment,
  waitFor,
  CODEX_COMPANION,
  ROOT,
  tempDir
} from "./helpers.mjs";
import { installFakeGrok, readFakeLog } from "./fake-grok.mjs";

/** Provider lifecycle needs process start tokens via `ps`; some sandboxes deny that. */
const PROVIDER_LIFECYCLE_AVAILABLE = Boolean(processStartToken(process.pid));

function fixture(config = {}) {
  const data = tempDir("grok-cp-data-");
  const fake = installFakeGrok(tempDir("grok-cp-fake-"), config);
  const env = testEnvironment({ fake, pluginData: data });
  // Avoid nested-companion refusal when this suite runs under a Grok rescue worker.
  delete env.GROK_COMPANION_CHILD;
  delete env.GROK_COMPANION_JOB_MARKER;
  delete env.GROK_AGENT;
  delete env.GROK_LEADER_SOCKET;
  return { fake, env, pluginData: data };
}

function parseJson(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

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

test("TaskEnvelope v1 retains structured fields with deterministic digests (plain-text default)", () => {
  const envelope = buildTaskEnvelope({
    userRequest: "implement fixture envelope",
    objective: "Ship the vertical slice",
    mode: "write",
    scope: { include: ["plugins/grok/**"], exclude: ["README.md"] },
    nonGoals: ["Do not edit README.md"],
    acceptanceCriteria: [
      { id: "AC-1", text: "Envelope retained" },
      { id: "AC-2", text: "Manifest bound" }
    ],
    requiredVerification: ["npm run check"],
    expectedReturnFormat: "worker report + human summary",
    contextManifestId: "ctx-deadbeef"
  });
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.userRequest, "implement fixture envelope");
  assert.equal(envelope.objective, "Ship the vertical slice");
  assert.equal(envelope.mode, "write");
  assert.deepEqual(envelope.scope.include, ["plugins/grok/**"]);
  assert.deepEqual(envelope.scope.exclude, ["README.md"]);
  assert.deepEqual(envelope.nonGoals, ["Do not edit README.md"]);
  assert.equal(envelope.acceptanceCriteria[0].id, "AC-1");
  assert.equal(envelope.acceptanceCriteria[1].id, "AC-2");
  assert.deepEqual(envelope.requiredVerification, ["npm run check"]);
  assert.equal(envelope.contextManifestId, "ctx-deadbeef");
  assert.match(envelope.digest, /^[a-f0-9]{64}$/);
  assert.match(envelope.envelopeId, /^env-[a-f0-9]{24}$/);
  const again = buildTaskEnvelope({
    userRequest: "implement fixture envelope",
    objective: "Ship the vertical slice",
    mode: "write",
    scope: { include: ["plugins/grok/**"], exclude: ["README.md"] },
    nonGoals: ["Do not edit README.md"],
    acceptanceCriteria: [
      { id: "AC-1", text: "Envelope retained" },
      { id: "AC-2", text: "Manifest bound" }
    ],
    requiredVerification: ["npm run check"],
    expectedReturnFormat: "worker report + human summary",
    contextManifestId: "ctx-deadbeef"
  });
  assert.equal(again.digest, envelope.digest);
  assert.equal(again.envelopeId, envelope.envelopeId);
});

test("ContextManifest captures workspace identity and E_CONTEXT_DRIFT is stable", () => {
  const root = initRepo();
  const manifest = captureContextManifest(root);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.workspaceRoot, fs.realpathSync(root));
  assert.ok(manifest.git.head);
  assert.ok(manifest.git.branch);
  assert.ok(manifest.git.trackedTreeIdentity);
  assert.ok(manifest.git.dirtyDigest);
  assert.match(manifest.digest, /^[a-f0-9]{64}$/);
  assert.match(manifest.manifestId, /^ctx-[a-f0-9]{24}$/);
  assertContextCompatible(root, manifest, { mode: "execute" });
  assertContextCompatible(root, manifest, { mode: "resume" });
  assert.throws(
    () => assertContextCompatible(root, { ...manifest, workspaceRoot: "/tmp/other-checkout" }, { mode: "resume" }),
    (error) => error?.code === "E_CONTEXT_DRIFT" && /workspaceRoot/.test(error.message)
  );
  assert.throws(
    () => assertContextCompatible(root, {
      ...manifest,
      git: { ...manifest.git, head: "0".repeat(40) }
    }, { mode: "execute" }),
    (error) => error?.code === "E_CONTEXT_DRIFT" && /head/.test(error.message)
  );
});

test("ContextManifest observes same-path content, index, and Git-metadata changes", () => {
  const root = initRepo();
  fs.writeFileSync(path.join(root, "tracked.txt"), "first dirty version\n");
  const first = captureContextManifest(root);
  fs.writeFileSync(path.join(root, "tracked.txt"), "second dirty version\n");
  const second = captureContextManifest(root);
  assert.notEqual(second.git.dirtyDigest, first.git.dirtyDigest);
  assert.ok(observeChangedPaths(first, second).includes("tracked.txt"));

  const beforeIndex = captureContextManifest(root);
  fs.writeFileSync(path.join(root, "tracked.txt"), "staged version\n");
  git(root, "add", "tracked.txt");
  const afterIndex = captureContextManifest(root);
  assert.ok(observeChangedPaths(beforeIndex, afterIndex).includes("[INDEX]"));

  const beforeMetadata = captureContextManifest(root);
  fs.appendFileSync(path.join(root, ".git", "config"), "\n[grok-companion-test]\n\tvalue = true\n");
  const afterMetadata = captureContextManifest(root);
  assert.ok(observeChangedPaths(beforeMetadata, afterMetadata).includes("[GIT_METADATA]"));

  fs.writeFileSync(path.join(root, ".gitignore"), "ignored-*.txt\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-m", "ignore fixture");
  fs.writeFileSync(path.join(root, "ignored-secret.txt"), "first ignored value\n");
  const beforeIgnored = captureContextManifest(root);
  fs.writeFileSync(path.join(root, "ignored-secret.txt"), "second ignored value\n");
  const afterIgnored = captureContextManifest(root);
  assert.notEqual(afterIgnored.git.ignoredDigest, beforeIgnored.git.ignoredDigest);
  assert.ok(observeChangedPaths(beforeIgnored, afterIgnored).includes("ignored-secret.txt"));
  assert.deepEqual(evaluateScope(observeChangedPaths(beforeIgnored, afterIgnored), { include: ["tracked.txt"] }), ["ignored-secret.txt"]);
  assert.throws(
    () => assertContextCompatible(root, beforeIgnored, { mode: "resume" }),
    (error) => error?.code === "E_CONTEXT_DRIFT" && /ignoredDigest/.test(error.message)
  );
});

test("verification observer tolerates only pytest/Python cache ignored drift", () => {
  const root = initRepo();
  fs.writeFileSync(
    path.join(root, ".gitignore"),
    ".pytest_cache/\n__pycache__/\n.pytest_cache-copy/\n__pycache__-copy/\nbuild-output.txt\n"
  );
  git(root, "add", ".gitignore");
  git(root, "commit", "-m", "ignore cache and build output");

  const before = captureContextManifest(root);
  assert.match(before.git.verificationIgnoredDigest, /^[a-f0-9]{64}$/);
  assert.equal(before.git.verificationIgnoredEntryCount, 0);

  fs.mkdirSync(path.join(root, ".pytest_cache", "v"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pytest_cache", "v", "cache"), "nodeids\n");
  fs.mkdirSync(path.join(root, "pkg", "__pycache__"), { recursive: true });
  fs.writeFileSync(path.join(root, "pkg", "__pycache__", "mod.cpython-311.pyc"), "bytecode");
  const afterCache = captureContextManifest(root);

  assert.notEqual(afterCache.git.ignoredDigest, before.git.ignoredDigest);
  assert.equal(afterCache.git.verificationIgnoredDigest, before.git.verificationIgnoredDigest);
  const fullObserved = observeChangedPaths(before, afterCache);
  assert.deepEqual(fullObserved.sort(), [
    ".pytest_cache/v/cache",
    "pkg/__pycache__/mod.cpython-311.pyc"
  ]);
  assert.deepEqual(observeChangedPaths(before, afterCache, { observer: "verification" }), []);

  fs.mkdirSync(path.join(root, ".pytest_cache-copy"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pytest_cache-copy", "evidence.txt"), "not pytest cache\n");
  fs.mkdirSync(path.join(root, "pkg", "__pycache__-copy"), { recursive: true });
  fs.writeFileSync(path.join(root, "pkg", "__pycache__-copy", "evidence.pyc"), "not pycache\n");
  fs.writeFileSync(path.join(root, "build-output.txt"), "meaningful ignored write\n");
  const afterMeaningful = captureContextManifest(root);
  assert.notEqual(afterMeaningful.git.verificationIgnoredDigest, before.git.verificationIgnoredDigest);
  assert.deepEqual(observeChangedPaths(before, afterMeaningful, { observer: "verification" }).sort(), [
    ".pytest_cache-copy/evidence.txt",
    "build-output.txt",
    "pkg/__pycache__-copy/evidence.pyc"
  ]);
});

test("verification observer falls back fail-closed without verification-only identity", () => {
  const legacyBefore = {
    git: {
      dirtyDigest: "dirty",
      dirtyEntries: [],
      ignoredDigest: "ignored-before",
      ignoredEntriesAttributable: false,
      head: "head",
      trackedTreeIdentity: "tree",
      metadataIdentity: "metadata"
    }
  };
  const current = {
    git: {
      dirtyDigest: "dirty",
      dirtyEntries: [],
      ignoredDigest: "ignored-after",
      ignoredEntriesAttributable: false,
      verificationIgnoredDigest: "verification-same",
      verificationIgnoredEntriesAttributable: true,
      verificationIgnoredEntries: [],
      head: "head",
      trackedTreeIdentity: "tree",
      metadataIdentity: "metadata"
    }
  };
  assert.deepEqual(
    observeChangedPaths(legacyBefore, current, { observer: "verification" }),
    ["[IGNORED_WORKTREE]"]
  );

  const malformedBefore = {
    git: {
      ...legacyBefore.git,
      verificationIgnoredDigest: "not-a-sha256",
      verificationIgnoredEntryCount: 0,
      verificationIgnoredEntriesAttributable: true,
      verificationIgnoredEntries: [],
      verificationIgnoredInventoryComplete: true
    }
  };
  const malformedAfter = {
    git: {
      ...malformedBefore.git,
      ignoredDigest: "ignored-after"
    }
  };
  assert.deepEqual(
    observeChangedPaths(malformedBefore, malformedAfter, { observer: "verification" }),
    ["[IGNORED_WORKTREE]"]
  );

  const attributableBefore = {
    git: {
      dirtyDigest: "dirty",
      dirtyEntries: [],
      ignoredDigest: "ignored-a",
      ignoredEntriesAttributable: true,
      ignoredEntries: [{ path: "secret.bin", fingerprint: "fp-a" }],
      verificationIgnoredDigest: "verification-stable",
      verificationIgnoredEntryCount: 1,
      verificationIgnoredEntriesAttributable: true,
      verificationIgnoredEntries: [{ path: "secret.bin", fingerprint: "verify-fp" }],
      // Deliberately omit verificationIgnoredInventoryComplete. A partially
      // populated new identity must fall back to the full ignored observer.
      head: "head",
      trackedTreeIdentity: "tree",
      metadataIdentity: "metadata"
    }
  };
  const attributableAfter = {
    git: {
      ...attributableBefore.git,
      ignoredDigest: "ignored-b",
      ignoredEntries: [{ path: "secret.bin", fingerprint: "fp-b" }],
      verificationIgnoredDigest: "verification-stable"
    }
  };
  assert.deepEqual(
    observeChangedPaths(attributableBefore, attributableAfter, { observer: "verification" }),
    ["secret.bin"]
  );

  const impossibleBefore = {
    git: {
      ...attributableBefore.git,
      verificationIgnoredDigest: "0".repeat(64),
      verificationIgnoredEntryCount: 0,
      verificationIgnoredEntriesAttributable: false,
      verificationIgnoredEntries: [],
      verificationIgnoredInventoryComplete: true
    }
  };
  const impossibleAfter = {
    git: {
      ...impossibleBefore.git,
      ignoredDigest: "ignored-b",
      ignoredEntries: [{ path: "secret.bin", fingerprint: "fp-b" }]
    }
  };
  assert.deepEqual(
    observeChangedPaths(impossibleBefore, impossibleAfter, { observer: "verification" }),
    ["secret.bin"]
  );
});

test("verification observer retains [IGNORED_WORKTREE] when non-cache ignored drift is not attributable", () => {
  const before = {
    git: {
      dirtyDigest: "dirty",
      dirtyEntries: [],
      ignoredDigest: "full-a",
      ignoredEntriesAttributable: false,
      verificationIgnoredDigest: "verify-a",
      verificationIgnoredEntryCount: 2001,
      verificationIgnoredEntriesAttributable: false,
      verificationIgnoredEntries: [],
      verificationIgnoredInventoryComplete: true,
      head: "head",
      trackedTreeIdentity: "tree",
      metadataIdentity: "metadata"
    }
  };
  const after = {
    git: {
      ...before.git,
      ignoredDigest: "full-b",
      verificationIgnoredDigest: "verify-b"
    }
  };
  assert.deepEqual(observeChangedPaths(before, after), ["[IGNORED_WORKTREE]"]);
  assert.deepEqual(observeChangedPaths(before, after, { observer: "verification" }), ["[IGNORED_WORKTREE]"]);
});

test("changed-path overflow remains a fail-closed scope violation", () => {
  const entries = Array.from({ length: 201 }, (_, index) => ({
    status: " M",
    path: index === 200 ? "outside/escape.js" : `src/file-${String(index).padStart(3, "0")}.js`,
    fileKind: "file",
    fileMode: 0o100644,
    worktreeHash: `before-${index}`
  }));
  const before = {
    git: {
      dirtyDigest: "before",
      dirtyEntries: entries,
      ignoredDigest: "ignored",
      head: "head",
      trackedTreeIdentity: "tree",
      metadataIdentity: "metadata"
    }
  };
  const after = {
    git: {
      ...before.git,
      dirtyDigest: "after",
      dirtyEntries: entries.map((entry, index) => ({ ...entry, worktreeHash: `after-${index}` }))
    }
  };
  const observed = observeChangedPaths(before, after);
  assert.equal(observed.length, 201);
  assert.deepEqual(evaluateScope(observed, { include: ["src/**"], exclude: [] }), ["outside/escape.js"]);
  assert.deepEqual(
    evaluateScope(observed.map((item) => item === "outside/escape.js" ? "src/file-200.js" : item), { include: ["src/**"], exclude: [] }),
    []
  );
  const evidence = buildRuntimeEvidence({ changedPaths: observed });
  assert.equal(evidence.observedChangedPaths.length, 200);
  assert.equal(evidence.observedChangedPaths[0], "[CHANGED_PATHS_OVERFLOW]");
});

test("structured context readiness fails closed for unverified whole-project work", () => {
  const root = initRepo();
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  const manifest = captureContextManifest(root);
  const complete = buildTaskEnvelope({
    userRequest: "inspect the whole project",
    context: {
      workspaceState: "complete",
      upstreamFreshness: "not_checked",
      expectedProjectMarkers: ["package.json"]
    }
  });
  assert.throws(
    () => assertTaskContextReady(complete, manifest, { structuredInput: true }),
    (error) => error?.code === "E_CONTEXT_INCOMPLETE" && /upstream-freshness-not-verified/.test(error.message)
  );

  const scoped = buildTaskEnvelope({
    userRequest: "inspect the available package",
    context: {
      workspaceState: "task_scoped",
      upstreamFreshness: "not_checked",
      expectedProjectMarkers: ["package.json"],
      requiredPaths: ["tracked.txt", "package.json"]
    }
  });
  assert.doesNotThrow(() => assertTaskContextReady(scoped, manifest, { structuredInput: true }));
  const emptySlice = buildTaskEnvelope({
    userRequest: "inspect an unspecified checkout slice",
    context: { workspaceState: "task_scoped", upstreamFreshness: "not_checked" }
  });
  assert.throws(
    () => assertTaskContextReady(emptySlice, manifest, { structuredInput: true }),
    (error) => error?.code === "E_CONTEXT_INCOMPLETE"
      && error.details?.reasons?.includes("task-scoped-inventory-missing")
  );
  const missingSlice = buildTaskEnvelope({
    userRequest: "inspect source that is not checked out",
    context: {
      workspaceState: "task_scoped",
      upstreamFreshness: "not_checked",
      requiredPaths: ["src", "package.json"]
    }
  });
  assert.throws(
    () => assertTaskContextReady(missingSlice, manifest, { structuredInput: true }),
    (error) => error?.code === "E_CONTEXT_INCOMPLETE"
      && error.details?.missingPaths?.includes("src")
      && /missing-required-paths:src/.test(error.message)
  );
  assert.throws(
    () => buildTaskEnvelope({
      userRequest: "unsafe inventory",
      context: { workspaceState: "task_scoped", requiredPaths: ["../outside"] }
    }),
    (error) => error?.code === "E_USAGE"
  );
  assert.deepEqual(evaluateScope(["index.js", "src/index.js"], { include: ["**/*.js"] }), []);
});

test("lifecycle events are bounded typed operational evidence only", () => {
  let events = [];
  events = appendLifecycleEvent(events, "task.accepted", "Task accepted", { envelopeId: "env-1" });
  events = appendLifecycleEvent(events, "plan.updated", "Plan updated");
  events = appendLifecycleEvent(events, "activity.started", "tool: read");
  events = appendLifecycleEvent(events, "activity.completed", "tool: read");
  events = appendLifecycleEvent(events, "checkpoint", "Grok session created");
  events = appendLifecycleEvent(events, "blocked", "Waiting on input");
  events = appendLifecycleEvent(events, "final.report", "Worker report ready");
  assert.equal(events.length, 7);
  assert.ok(events.every((event) => event.at && event.type && event.summary));
  assert.throws(() => appendLifecycleEvent(events, "secret.thought", "nope"), (error) => error?.code === "E_STATE");
});

test("interim text never contaminates structured final worker report", () => {
  const interim = "INTERIM_SHOULD_NOT_ENTER_WORKER_REPORT";
  const finalText = workerReport({
    summary: "FINAL_ANSWER_ONLY_FOR_REPORT",
    acceptanceResults: [{ id: "AC-01", status: "met" }]
  });
  const report = buildWorkerReport({
    providerText: finalText,
    acceptanceCriteria: [{ id: "AC-01", text: "Done" }]
  });
  assert.equal(report.summary.includes(interim), false);
  assert.match(report.summary, /FINAL_ANSWER_ONLY_FOR_REPORT/);
  assert.equal(JSON.stringify(report).includes(interim), false);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.outcome, "complete");
});

test("worker reports require the final marker and exact acceptance IDs", () => {
  const criteria = [
    { id: "AC-01", text: "First" },
    { id: "AC-02", text: "Second" }
  ];
  const unmarked = buildWorkerReport({
    providerText: JSON.stringify({
      outcome: "complete",
      summary: "looks structured",
      changedFiles: [],
      checksClaimed: [],
      acceptanceResults: criteria.map((item) => ({ id: item.id, status: "met" })),
      risks: [],
      questions: []
    }),
    acceptanceCriteria: criteria
  });
  assert.equal(unmarked.valid, false);
  assert.ok(unmarked.validationIssues.some((item) => /required GROK_WORKER_REPORT marker/.test(item)));

  const invalid = buildWorkerReport({
    providerText: workerReport({
      acceptanceResults: [
        { id: "AC-01", status: "met" },
        { id: "AC-01", status: "met" },
        { id: "AC-99", status: "met" }
      ]
    }),
    acceptanceCriteria: criteria
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.validationIssues.some((item) => /Duplicate acceptance result AC-01/.test(item)));
  assert.ok(invalid.validationIssues.some((item) => /Unknown acceptance criterion AC-99/.test(item)));
  assert.ok(invalid.validationIssues.some((item) => /Missing acceptance result AC-02/.test(item)));
});

test("report repair prompt is no-tool, marker-bound, and acceptance-complete", () => {
  const envelope = buildTaskEnvelope({
    userRequest: "repair fixture",
    acceptanceCriteria: [
      { id: "AC-01", text: "First" },
      { id: "AC-02", text: "Second" }
    ]
  });
  const invalid = buildWorkerReport({ providerText: "not a report", acceptanceCriteria: envelope.acceptanceCriteria });
  const prompt = composeWorkerReportRepairPrompt(envelope, invalid);
  assert.match(prompt, /Report-format repair only/);
  assert.match(prompt, /Do not call tools/);
  assert.match(prompt, /GROK_WORKER_REPORT:/);
  assert.match(prompt, /AC-01/);
  assert.match(prompt, /AC-02/);
});

test("provider success claims leave hostVerification not_run in runtime evidence", () => {
  const root = initRepo();
  const pre = captureContextManifest(root);
  fs.writeFileSync(path.join(root, "extra.txt"), "x\n");
  const post = captureContextManifest(root);
  const evidence = buildRuntimeEvidence({
    preContext: pre,
    postContext: post,
    changedPaths: observeChangedPaths(pre, post),
    executionStatus: "completed"
  });
  assert.equal(evidence.hostVerification, "not_run");
  assert.equal(evidence.executionStatus, "completed");
  assert.ok(evidence.observedChangedPaths.some((item) => item.includes("extra.txt")));
  const report = buildWorkerReport({
    providerText: JSON.stringify({
      outcome: "complete",
      summary: "Provider claims all checks passed",
      checksClaimed: ["npm test"],
      changedFiles: ["extra.txt"]
    })
  });
  assert.deepEqual(report.checksClaimed, ["npm test"]);
  // Runtime evidence remains independent of provider claims.
  assert.equal(evidence.hostVerification, "not_run");
});

test("review verdict is derived solely from validated findings", () => {
  assert.equal(validateReview({ summary: "clean", findings: [] }).verdict, "pass");
  assert.throws(
    () => validateReview({
      verdict: "pass",
      summary: "bad",
      findings: [{ severity: "high", title: "x", body: "y" }]
    }),
    (error) => error?.code === "E_SCHEMA"
  );
  assert.throws(
    () => validateReview({
      verdict: "needs_changes",
      summary: "ok",
      findings: []
    }),
    (error) => error?.code === "E_SCHEMA"
  );
  assert.deepEqual(REVIEW_SCHEMA.required, ["summary", "findings"]);
});

test("schema failure diagnostics are actionable, bounded, and redacted", () => {
  const secret = "xai-controlplanediagnosticsecret";
  try {
    validateReview({ summary: secret, findings: "nope" });
    assert.fail("expected schema failure");
  } catch (error) {
    assert.equal(error.code, "E_SCHEMA");
    assert.ok(error.details?.hint);
    assert.equal(error.details.findingsShapeOk, false);
    assert.equal(JSON.stringify(error.details).includes(secret), false);
    if (error.details.redactedSnippet) {
      assert.equal(error.details.redactedSnippet.includes(secret), false);
      assert.ok(error.details.redactedSnippet.length <= 400);
    }
  }
});

test("composeProviderPrompt keeps task text out of argv and binds envelope fields", () => {
  const root = initRepo();
  const manifest = captureContextManifest(root);
  const envelope = buildTaskEnvelope({
    userRequest: "literal user request",
    mode: "read",
    contextManifestId: manifest.manifestId
  });
  const prompt = composeProviderPrompt(envelope, { root });
  assert.match(prompt, /literal user request/);
  assert.match(prompt, /Acceptance criteria/);
  assert.match(prompt, new RegExp(manifest.manifestId));
  assert.match(prompt, /Grok Companion constraints/);
});

test("Codex control-plane skill contracts describe host authority and explicit job IDs", () => {
  const rescue = fs.readFileSync(path.join(ROOT, "plugins/grok/skills/rescue/SKILL.md"), "utf8");
  const status = fs.readFileSync(path.join(ROOT, "plugins/grok/skills/status/SKILL.md"), "utf8");
  const result = fs.readFileSync(path.join(ROOT, "plugins/grok/skills/result/SKILL.md"), "utf8");
  assert.match(rescue, /--job-id/);
  assert.match(rescue, /host verification/i);
  assert.match(rescue, /substitute a different worker unless the active fallback policy permits it/i);
  assert.match(rescue, /authoritative verification/i);
  assert.match(rescue, /record-verification/);
  assert.match(rescue, /command\/status\/exit-code/i);
  assert.match(rescue, /commandOutcomes/);
  assert.match(rescue, /passed\|failed|passed" or "failed/i);
  assert.match(rescue, /64 KiB|64\s*KiB/i);
  assert.match(rescue, /at most 64|≤64|64 outcomes/i);
  assert.match(rescue, /fix-and-reverify loop/i);
  assert.match(rescue, /same failure repeats/i);
  assert.match(rescue, /write_stdin/);
  assert.match(rescue, /session ID/i);
  assert.match(rescue, /EOT|frame terminator/i);
  assert.match(rescue, /--stdin-ready/);
  assert.match(rescue, new RegExp(STDIN_READY_MARKER));
  assert.match(rescue, /disables PTY echo/i);
  assert.match(status, /heartbeat|progress/i);
  assert.match(status, /job ID/i);
  assert.match(result, /hostVerification/);
  assert.match(result, /worker report/i);
  assert.match(result, /not_run/);
});

test("integration: Codex nonblocking stdin waits for delayed TaskEnvelope and verification records", {
  skip: process.platform === "win32" && "nonblocking fd regression harness is POSIX-only"
}, async () => {
  const root = initRepo();
  const { env: fixtureEnv, fake, pluginData } = fixture({
    taskText: workerReport({
      summary: "Delayed Codex ingress completed",
      acceptanceResults: [{ id: "AC-01", status: "met" }]
    })
  });
  const env = {
    ...fixtureEnv,
    CODEX_THREAD_ID: "codex-delayed-stdin-regression",
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_HOST_SESSION_ID: "codex-delayed-stdin-regression",
    GROK_COMPANION_PLUGIN_DATA: pluginData
  };
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.GROK_COMPANION_CLAUDE_SESSION_ID;
  delete env.CLAUDE_SESSION_ID;
  delete env.CLAUDE_PROJECT_DIR;

  const envelope = JSON.stringify({
    schemaVersion: 1,
    userRequest: "analyze issue #2 without editing the checkout",
    objective: "Prove Codex can dispatch after the process starts with empty nonblocking stdin",
    mode: "read",
    scope: { include: [], exclude: [] },
    context: {
      facts: ["The host writes the envelope after process creation."],
      constraints: ["Keep the checkout unchanged."],
      expectedProjectMarkers: [],
      requiredPaths: ["tracked.txt"],
      workspaceState: "task_scoped",
      upstreamFreshness: "not_checked"
    },
    nonGoals: ["Do not edit files."],
    acceptanceCriteria: [{ id: "AC-01", text: "Receive the complete delayed envelope." }],
    requiredVerification: ["git status --short"],
    expectedReturnFormat: "GROK_WORKER_REPORT JSON plus concise human summary"
  });
  const dispatch = spawnNonblockingStdin(
    CODEX_COMPANION,
    ["task", "--background", "--envelope-stdin", "--stdin-ready", "--fresh", "--effort", "high", "--json"],
    { cwd: root, env }
  );

  await waitFor(() => dispatch.stderr.includes(STDIN_READY_MARKER), { timeoutMs: 5000 });
  assert.equal(dispatch.child.exitCode, null, "dispatch exited before Codex could write the TaskEnvelope");
  const providerStartsBeforeInput = readFakeLog(fake.logFile).filter(
    (entry) => entry.event === "argv" && entry.args.includes("agent") && entry.args.includes("stdio")
  );
  assert.equal(providerStartsBeforeInput.length, 0);
  const split = Math.floor(envelope.length / 2);
  dispatch.child.stdin.write(envelope.slice(0, split));
  await new Promise((resolve) => setTimeout(resolve, 25));
  dispatch.child.stdin.end(envelope.slice(split));
  const dispatched = await dispatch.completed;
  assert.equal(dispatched.code, 0, dispatched.stderr || dispatched.stdout);
  assert.equal(dispatched.stdinError, null);
  const job = JSON.parse(dispatched.stdout);
  assert.ok(job.id);

  const terminal = await waitFor(() => {
    const result = runCodexCompanion(["status", job.id, "--json"], { cwd: root, env });
    if (result.status !== 0) return null;
    const status = JSON.parse(result.stdout);
    return ["completed", "failed", "cancelled"].includes(status.status) ? status : null;
  }, { timeoutMs: 10000 });
  assert.equal(terminal.status, "completed");
  const providerStarts = readFakeLog(fake.logFile).filter(
    (entry) => entry.event === "argv" && entry.args.includes("agent") && entry.args.includes("stdio")
  );
  assert.equal(providerStarts.length, 1);

  const verification = JSON.stringify({
    commandOutcomes: [{ command: "git status --short", status: "passed", exitCode: 0 }]
  });
  const record = spawnNonblockingStdin(
    CODEX_COMPANION,
    ["record-verification", job.id, "--verification-stdin", "--stdin-ready", "--json"],
    { cwd: root, env }
  );
  await waitFor(() => record.stderr.includes(STDIN_READY_MARKER), { timeoutMs: 5000 });
  assert.equal(record.child.exitCode, null, "verification command exited before Codex could write stdin");
  const verificationSplit = Math.floor(verification.length / 2);
  record.child.stdin.write(verification.slice(0, verificationSplit));
  await new Promise((resolve) => setTimeout(resolve, 25));
  record.child.stdin.end(verification.slice(verificationSplit));
  const recorded = await record.completed;
  assert.equal(recorded.code, 0, recorded.stderr || recorded.stdout);
  assert.equal(JSON.parse(recorded.stdout).result.hostVerification, "passed");
});

test("integration: delayed provider exposes job ID and meaningful progress", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, async () => {
  const root = initRepo();
  const { env } = fixture({ taskText: workerReport({ summary: "Slow final answer" }), delayMs: 1500 });
  const started = parseJson(runCompanion(
    ["task", "--background", "long running observability fixture", "--json"],
    { cwd: root, env }
  ));
  assert.ok(started.id);
  assert.ok(["queued", "running"].includes(started.status) || started.progress);

  const mid = await waitFor(() => {
    const status = runCompanion(["status", started.id, "--json"], { cwd: root, env });
    if (status.status !== 0) return null;
    const job = JSON.parse(status.stdout);
    if (job.progress && job.progress !== "Task accepted" && job.progress !== "Queued" && job.progress !== "Worker started") return job;
    if (job.lifecycleEvents?.some((event) => ["plan.updated", "activity.started", "checkpoint"].includes(event.type))) return job;
    return null;
  }, { timeoutMs: 5000 });

  assert.equal(mid.id, started.id);
  assert.ok(mid.progress);
  assert.ok(mid.heartbeatAt || mid.updatedAt);

  const finished = await waitFor(() => {
    const status = runCompanion(["status", started.id, "--json"], { cwd: root, env });
    if (status.status !== 0) return null;
    const job = JSON.parse(status.stdout);
    return job.status === "completed" ? job : null;
  }, { timeoutMs: 10000 });
  assert.equal(finished.status, "completed");
  assert.ok(finished.taskContract);
  assert.ok(finished.context);
  assert.equal(finished.result.hostVerification, "not_run");
  assert.ok(finished.lifecycleEvents.some((event) => event.type === "final.report"));
});

test("integration: structured task text stays off argv and public JSON omits private runtime identity", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, () => {
  const root = initRepo();
  const canary = "ARGV_CANARY_SHOULD_ONLY_REACH_PROVIDER_PROMPT_7f93";
  const { env, fake } = fixture({
    taskText: workerReport({
      summary: "Structured ingress completed",
      acceptanceResults: [{ id: "AC-01", status: "met" }]
    })
  });
  const envelope = {
    schemaVersion: 1,
    userRequest: canary,
    objective: "Verify structured ingress",
    mode: "read",
    scope: { include: [], exclude: [] },
    context: { workspaceState: "task_scoped", upstreamFreshness: "not_checked", requiredPaths: ["tracked.txt"] },
    acceptanceCriteria: [{ id: "AC-01", text: "Provider received the task through stdin" }],
    requiredVerification: [],
    expectedReturnFormat: "GROK_WORKER_REPORT JSON"
  };
  const result = runCompanion(
    ["task", "--wait", "--envelope-stdin", "--json"],
    { cwd: root, env, input: JSON.stringify(envelope) }
  );
  const job = parseJson(result);
  const providerArgv = readFakeLog(fake.logFile).filter((entry) => entry.event === "argv");
  assert.ok(providerArgv.length > 0);
  assert.equal(providerArgv.some((entry) => JSON.stringify(entry.args).includes(canary)), false);
  for (const privateField of ["userRequest", "workerProcess", "providerProcess", "workerAuthorization", "grokSessionId"]) {
    assert.equal(result.stdout.includes(`\"${privateField}\"`), false, `${privateField} leaked through public JSON`);
  }
  assert.equal(result.stdout.includes(canary), false, "literal task input leaked through public JSON");
  assert.equal(result.stdout.includes("fake-session-00000001"), false, "provider session ID leaked through lifecycle detail");
  assert.equal(job.result.workerReport.valid, true);
  assert.equal(job.result.hostVerification, "not_run");
});

test("integration: malformed task report gets one same-session format repair", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, () => {
  const root = initRepo();
  const repairedText = workerReport({ summary: "Repair succeeded" });
  const { env, fake } = fixture({
    taskTexts: [JSON.stringify({ summary: "wrong provider schema", evidence: [] }), repairedText]
  });
  const job = parseJson(runCompanion(["task", "--wait", "repair malformed final", "--json"], { cwd: root, env }));
  assert.equal(job.status, "completed");
  assert.equal(job.result.workerReport.valid, true);
  assert.equal(job.result.workerReport.summary, "Repair succeeded");
  assert.equal(job.result.reportRepair.attempted, true);
  assert.equal(job.result.reportRepair.valid, true);
  assert.equal(Array.isArray(job.result.workerReport.validationIssues), true);
  assert.equal(Array.isArray(job.result.providerClaims.changedFiles), true);
  const rendered = runCompanion(["result", job.id], { cwd: root, env });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /Outcome: complete/);
  assert.match(rendered.stdout, /Repair succeeded/);
  const prompts = readFakeLog(fake.logFile).filter((entry) => entry.event === "prompt");
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].sessionId, prompts[0].sessionId);
  assert.match(prompts[1].prompt, /Report-format repair only/);
  const invocations = readFakeLog(fake.logFile).filter((entry) => entry.event === "argv" && entry.args.includes("agent"));
  assert.equal(invocations.length, 2);
  const repairProfileIndex = invocations[1].args.indexOf("--agent-profile");
  const stagedRepairProfile = invocations[1].args[repairProfileIndex + 1];
  assert.equal(fs.existsSync(stagedRepairProfile), false, "repair profile remained after verified provider exit");
  const repairProfile = fs.readFileSync(path.join(ROOT, "plugins/grok/provider-agents/report-repair.md"), "utf8");
  assert.match(repairProfile, /name: grok-companion-report-repair/);
  assert.match(repairProfile, /tools:\s*\[\]/);
  assert.equal(repairProfile.includes("GrokBuild:search_replace"), false);
});

test("integration: two invalid task reports fail with E_SCHEMA and retain bounded repair evidence", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, async () => {
  const root = initRepo();
  const { env, fake } = fixture({ taskTexts: ["not a worker report", "still not a worker report"] });
  const started = parseJson(runCompanion(
    ["task", "--background", "exercise invalid report failure", "--json"],
    { cwd: root, env }
  ));
  const failed = await waitFor(() => {
    const status = runCompanion(["status", started.id, "--json"], { cwd: root, env });
    if (status.status !== 0) return null;
    const job = JSON.parse(status.stdout);
    return job.status === "failed" ? job : null;
  }, { timeoutMs: 10000 });
  assert.equal(failed.error.code, "E_SCHEMA");
  assert.equal(failed.result.workerReport.valid, false);
  assert.equal(failed.result.providerClaims.success, false);
  assert.equal(failed.result.reportRepair.attempted, true);
  assert.equal(failed.result.reportRepair.valid, false);
  assert.ok(failed.result.reportRepair.initialResponse.bytes > 0);
  const invocations = readFakeLog(fake.logFile).filter((entry) => entry.event === "argv" && entry.args.includes("agent"));
  assert.equal(invocations.length, 2);
  const repairProfileIndex = invocations[1].args.indexOf("--agent-profile");
  assert.equal(fs.existsSync(invocations[1].args[repairProfileIndex + 1]), false, "failed repair retained its staged profile");
  assert.match(fs.readFileSync(path.join(ROOT, "plugins/grok/provider-agents/report-repair.md"), "utf8"), /tools:\s*\[\]/);
});

test("integration: report-repair transport failures preserve their operational error code", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, async () => {
  const root = initRepo();
  const { env } = fixture({
    taskTexts: ["not a worker report"],
    promptErrors: [null, "authentication expired"]
  });
  const started = parseJson(runCompanion(
    ["task", "--background", "exercise report repair auth failure", "--json"],
    { cwd: root, env }
  ));
  const failed = await waitFor(() => {
    const status = runCompanion(["status", started.id, "--json"], { cwd: root, env });
    if (status.status !== 0) return null;
    const job = JSON.parse(status.stdout);
    return job.status === "failed" ? job : null;
  }, { timeoutMs: 10000 });
  assert.equal(failed.error.code, "E_AUTH_REQUIRED");
  assert.equal(failed.result.workerReport.valid, false);
  assert.equal(failed.result.reportRepair.attempted, true);
  assert.equal(failed.result.reportRepair.valid, false);
  assert.equal(failed.result.reportRepair.error.code, "E_AUTH_REQUIRED");
});

test("integration: recorded host verification creates one scoped host-asserted continuation baseline", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, () => {
  const root = initRepo();
  const { env } = fixture({ taskText: workerReport() });
  const envelope = {
    schemaVersion: 1,
    userRequest: "prepare the fixture for host verification",
    objective: "Prepare verification fixture",
    mode: "read",
    scope: { include: ["tracked.txt"], exclude: [] },
    context: { workspaceState: "task_scoped", requiredPaths: ["tracked.txt"] },
    acceptanceCriteria: [
      { id: "AC-01", text: "Prepare the fixture" },
      { id: "AC-02", text: "Report the result" }
    ],
    requiredVerification: ["node verify-fixture.mjs"]
  };
  const job = parseJson(runCompanion(
    ["task", "--wait", "--envelope-stdin", "--json"],
    { cwd: root, env, input: JSON.stringify(envelope) }
  ));
  fs.writeFileSync(path.join(root, "tracked.txt"), "verification-created state\n");

  const premature = runCompanion(
    ["task", "--wait", "--job-id", job.id, "continue before verification record", "--json"],
    { cwd: root, env }
  );
  assert.notEqual(premature.status, 0);
  assert.match(premature.stdout, /E_CONTEXT_DRIFT/);

  const recorded = parseJson(runCompanion(
    ["record-verification", job.id, "--verification-stdin", "--json"],
    {
      cwd: root,
      env,
      input: JSON.stringify({
        commandOutcomes: [{ command: "node verify-fixture.mjs", status: "failed", exitCode: 1 }]
      })
    }
  ));
  assert.equal(recorded.result.hostVerification, "failed");
  assert.equal(recorded.result.verification.authority, "host_asserted");
  assert.deepEqual(recorded.result.verification.observedChangedPaths, ["tracked.txt"]);

  const duplicate = runCompanion(
    ["record-verification", job.id, "--verification-stdin", "--json"],
    {
      cwd: root,
      env,
      input: JSON.stringify({
        commandOutcomes: [{ command: "node verify-fixture.mjs", status: "failed", exitCode: 1 }]
      })
    }
  );
  assert.notEqual(duplicate.status, 0);
  assert.equal(JSON.parse(duplicate.stdout).error.code, "E_STATE");

  const resumed = parseJson(runCompanion(
    ["task", "--wait", "--job-id", job.id, "fix the recorded verification failure", "--json"],
    { cwd: root, env }
  ));
  assert.equal(resumed.resumeJobId, job.id);
});

test("integration: host verification rejects empty declarations and outcomes", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, () => {
  const root = initRepo();
  const { env } = fixture({ taskText: workerReport() });
  const envelope = {
    schemaVersion: 1,
    userRequest: "complete without declared host checks",
    objective: "No host checks",
    mode: "read",
    scope: { include: [], exclude: [] },
    context: { workspaceState: "task_scoped", requiredPaths: ["tracked.txt"] },
    acceptanceCriteria: [
      { id: "AC-01", text: "Complete the task" },
      { id: "AC-02", text: "Report the result" }
    ],
    requiredVerification: []
  };
  const job = parseJson(runCompanion(
    ["task", "--wait", "--envelope-stdin", "--json"],
    { cwd: root, env, input: JSON.stringify(envelope) }
  ));
  const rejected = runCompanion(
    ["record-verification", job.id, "--verification-stdin", "--json"],
    { cwd: root, env, input: JSON.stringify({ commandOutcomes: [] }) }
  );
  assert.notEqual(rejected.status, 0);
  assert.equal(JSON.parse(rejected.stdout).error.code, "E_USAGE");
});

test("integration: record-verification accepts pytest/Python cache drift and continues", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, () => {
  const root = initRepo();
  fs.writeFileSync(path.join(root, ".gitignore"), ".pytest_cache/\n__pycache__/\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-m", "ignore pytest and pycache");
  const { env } = fixture({ taskText: workerReport() });
  const envelope = {
    schemaVersion: 1,
    userRequest: "prepare cache-tolerant verification",
    objective: "Prepare cache-tolerant verification",
    mode: "read",
    scope: { include: ["tracked.txt"], exclude: [] },
    context: { workspaceState: "task_scoped", requiredPaths: ["tracked.txt"] },
    acceptanceCriteria: [
      { id: "AC-01", text: "Prepare the fixture" },
      { id: "AC-02", text: "Report the result" }
    ],
    requiredVerification: ["node verify-fixture.mjs", "npm run check"]
  };
  const job = parseJson(runCompanion(
    ["task", "--wait", "--envelope-stdin", "--json"],
    { cwd: root, env, input: JSON.stringify(envelope) }
  ));

  fs.mkdirSync(path.join(root, ".pytest_cache", "v"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pytest_cache", "v", "cache"), "nodeids\n");
  fs.mkdirSync(path.join(root, "src", "__pycache__"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "__pycache__", "mod.cpython-311.pyc"), "pyc");

  const recorded = parseJson(runCompanion(
    ["record-verification", job.id, "--verification-stdin", "--json"],
    {
      cwd: root,
      env,
      input: JSON.stringify({
        commandOutcomes: [
          { command: "node verify-fixture.mjs", status: "passed", exitCode: 0 },
          { command: "npm run check", status: "passed", exitCode: 0 }
        ]
      })
    }
  ));
  assert.equal(recorded.result.hostVerification, "passed");
  assert.equal(recorded.result.verification.authority, "host_asserted");
  assert.deepEqual(recorded.result.verification.observedChangedPaths, []);
  assert.deepEqual(recorded.result.runtimeEvidence.commandOutcomes, [
    { command: "node verify-fixture.mjs", status: "passed", exitCode: 0 },
    { command: "npm run check", status: "passed", exitCode: 0 }
  ]);

  const resumed = parseJson(runCompanion(
    ["task", "--wait", "--job-id", job.id, "continue after cache-only verification", "--json"],
    { cwd: root, env }
  ));
  assert.equal(resumed.resumeJobId, job.id);
});

test("integration: record-verification rejects cache drift mixed with meaningful ignored writes", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, () => {
  const root = initRepo();
  fs.writeFileSync(path.join(root, ".gitignore"), ".pytest_cache/\n__pycache__/\nsecret-output.txt\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-m", "ignore cache and secret output");
  const { env } = fixture({ taskText: workerReport() });
  const envelope = {
    schemaVersion: 1,
    userRequest: "prepare mixed ignored verification",
    objective: "Prepare mixed ignored verification",
    mode: "read",
    scope: { include: ["tracked.txt"], exclude: [] },
    context: { workspaceState: "task_scoped", requiredPaths: ["tracked.txt"] },
    acceptanceCriteria: [
      { id: "AC-01", text: "Prepare the fixture" },
      { id: "AC-02", text: "Report the result" }
    ],
    requiredVerification: ["node verify-fixture.mjs"]
  };
  const job = parseJson(runCompanion(
    ["task", "--wait", "--envelope-stdin", "--json"],
    { cwd: root, env, input: JSON.stringify(envelope) }
  ));

  fs.mkdirSync(path.join(root, ".pytest_cache"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pytest_cache", "CACHEDIR.TAG"), "tag\n");
  fs.writeFileSync(path.join(root, "secret-output.txt"), "out-of-scope ignored write\n");

  const rejected = runCompanion(
    ["record-verification", job.id, "--verification-stdin", "--json"],
    {
      cwd: root,
      env,
      input: JSON.stringify({
        commandOutcomes: [{ command: "node verify-fixture.mjs", status: "passed", exitCode: 0 }]
      })
    }
  );
  assert.notEqual(rejected.status, 0);
  const error = JSON.parse(rejected.stdout).error;
  assert.equal(error.code, "E_SCOPE_VIOLATION");
  assert.deepEqual(error.details.paths, ["secret-output.txt"]);
});

test("integration: commandOutcomes contract accepts complete/partial records and rejects invalid shapes", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, () => {
  const root = initRepo();
  const requiredVerification = ["node verify-fixture.mjs", "npm run check"];
  const baseEnvelope = {
    schemaVersion: 1,
    userRequest: "exercise verification contract",
    objective: "Exercise verification contract",
    mode: "read",
    scope: { include: ["tracked.txt"], exclude: [] },
    context: { workspaceState: "task_scoped", requiredPaths: ["tracked.txt"] },
    acceptanceCriteria: [
      { id: "AC-01", text: "Prepare the fixture" },
      { id: "AC-02", text: "Report the result" }
    ],
    requiredVerification
  };

  const rejectCase = (label, input, setup = {}) => {
    const { env } = fixture({ taskText: workerReport() });
    const job = parseJson(runCompanion(
      ["task", "--wait", "--envelope-stdin", "--json"],
      { cwd: root, env, input: JSON.stringify({ ...baseEnvelope, ...setup.envelope }) }
    ));
    const rejected = runCompanion(
      ["record-verification", job.id, "--verification-stdin", "--json"],
      { cwd: root, env, input: JSON.stringify(input) }
    );
    assert.notEqual(rejected.status, 0, label);
    assert.equal(JSON.parse(rejected.stdout).error.code, "E_USAGE", label);
  };

  rejectCase("missing status", {
    commandOutcomes: [{ command: "node verify-fixture.mjs", exitCode: 0 }]
  });
  rejectCase("non-declared command", {
    commandOutcomes: [{ command: "node not-declared.mjs", status: "passed", exitCode: 0 }]
  });
  rejectCase("incomplete passing record", {
    commandOutcomes: [{ command: "node verify-fixture.mjs", status: "passed", exitCode: 0 }]
  });
  rejectCase("duplicate command", {
    commandOutcomes: [
      { command: "node verify-fixture.mjs", status: "passed", exitCode: 0 },
      { command: "node verify-fixture.mjs", status: "passed", exitCode: 0 }
    ]
  });
  rejectCase("unsupported output field", {
    commandOutcomes: [{
      command: "node verify-fixture.mjs",
      status: "passed",
      exitCode: 0,
      output: "should not be recorded"
    }]
  });
  rejectCase("unsupported root field", {
    commandOutcomes: [{ command: "npm run check", status: "failed", exitCode: 1 }],
    summary: "not part of the contract"
  });
  rejectCase("more than 64 outcomes", {
    commandOutcomes: Array.from({ length: 65 }, () => ({
      command: "node verify-fixture.mjs",
      status: "failed",
      exitCode: 1
    }))
  });

  {
    const { env } = fixture({ taskText: workerReport() });
    const job = parseJson(runCompanion(
      ["task", "--wait", "--envelope-stdin", "--json"],
      { cwd: root, env, input: JSON.stringify(baseEnvelope) }
    ));
    const partial = parseJson(runCompanion(
      ["record-verification", job.id, "--verification-stdin", "--json"],
      {
        cwd: root,
        env,
        input: JSON.stringify({
          commandOutcomes: [{ command: "npm run check", status: "failed", exitCode: 1 }]
        })
      }
    ));
    assert.equal(partial.result.hostVerification, "failed");
    assert.equal(partial.result.verification.authority, "host_asserted");
    assert.deepEqual(partial.result.runtimeEvidence.commandOutcomes, [
      { command: "npm run check", status: "failed", exitCode: 1 }
    ]);
  }

  {
    const { env } = fixture({ taskText: workerReport() });
    const job = parseJson(runCompanion(
      ["task", "--wait", "--envelope-stdin", "--json"],
      { cwd: root, env, input: JSON.stringify(baseEnvelope) }
    ));
    const complete = parseJson(runCompanion(
      ["record-verification", job.id, "--verification-stdin", "--json"],
      {
        cwd: root,
        env,
        input: JSON.stringify({
          commandOutcomes: [
            { command: "node verify-fixture.mjs", status: "passed", exitCode: 0 },
            { command: "npm run check", status: "passed", exitCode: 0 }
          ]
        })
      }
    ));
    assert.equal(complete.result.hostVerification, "passed");
    assert.deepEqual(complete.result.runtimeEvidence.commandOutcomes, [
      { command: "node verify-fixture.mjs", status: "passed", exitCode: 0 },
      { command: "npm run check", status: "passed", exitCode: 0 }
    ]);
  }
});

test("integration: host verification cannot rebase a lineage while a writer is active", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, async () => {
  const root = initRepo();
  const { env, pluginData } = fixture({ taskText: workerReport() });
  const priorEnvelope = {
    schemaVersion: 1,
    userRequest: "prepare a verification checkpoint",
    objective: "Prepare verification checkpoint",
    mode: "read",
    scope: { include: [], exclude: [] },
    context: { workspaceState: "task_scoped", requiredPaths: ["tracked.txt"] },
    acceptanceCriteria: [
      { id: "AC-01", text: "Complete the task" },
      { id: "AC-02", text: "Report the result" }
    ],
    requiredVerification: ["node verify-fixture.mjs"]
  };
  const prior = parseJson(runCompanion(
    ["task", "--wait", "--envelope-stdin", "--json"],
    { cwd: root, env, input: JSON.stringify(priorEnvelope) }
  ));

  const blockingFake = installFakeGrok(tempDir("grok-cp-writer-"), { cancelMode: "wait" });
  const writerEnv = testEnvironment({ fake: blockingFake, pluginData });
  delete writerEnv.GROK_COMPANION_CHILD;
  delete writerEnv.GROK_COMPANION_JOB_MARKER;
  delete writerEnv.GROK_AGENT;
  delete writerEnv.GROK_LEADER_SOCKET;
  const writerEnvelope = {
    schemaVersion: 1,
    userRequest: "hold the writer lease",
    objective: "Hold writer lease",
    mode: "write",
    scope: { include: ["tracked.txt"], exclude: [] },
    context: { workspaceState: "task_scoped", requiredPaths: ["tracked.txt"] },
    acceptanceCriteria: [{ id: "AC-01", text: "Wait until cancelled" }],
    requiredVerification: []
  };
  const writer = parseJson(runCompanion(
    ["task", "--background", "--write", "--envelope-stdin", "--json"],
    { cwd: root, env: writerEnv, input: JSON.stringify(writerEnvelope) }
  ));

  const rejected = runCompanion(
    ["record-verification", prior.id, "--verification-stdin", "--json"],
    {
      cwd: root,
      env,
      input: JSON.stringify({
        commandOutcomes: [{ command: "node verify-fixture.mjs", status: "passed", exitCode: 0 }]
      })
    }
  );
  assert.notEqual(rejected.status, 0);
  assert.equal(JSON.parse(rejected.stdout).error.code, "E_JOB_ACTIVE");

  parseJson(runCompanion(["cancel", writer.id, "--json"], { cwd: root, env: writerEnv }));
  await waitFor(() => {
    const status = runCompanion(["status", writer.id, "--json"], { cwd: root, env: writerEnv });
    if (status.status !== 0) return null;
    return ["cancelled", "failed"].includes(JSON.parse(status.stdout).status);
  }, { timeoutMs: 10000 });
});

test("integration: ignored out-of-scope task writes fail with E_SCOPE_VIOLATION", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, () => {
  const root = initRepo();
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored-output.txt\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-m", "ignore generated output");
  const ignored = path.join(root, "ignored-output.txt");
  fs.writeFileSync(ignored, "original ignored value\n");
  const { env } = fixture({
    taskText: workerReport({ acceptanceResults: [{ id: "AC-01", status: "met" }] }),
    taskMutatePath: ignored,
    taskMutation: "changed outside delegated scope\n"
  });
  const envelope = {
    schemaVersion: 1,
    userRequest: "edit only tracked.txt",
    objective: "Bounded ignored-scope fixture",
    mode: "write",
    scope: { include: ["tracked.txt"], exclude: [] },
    context: { workspaceState: "task_scoped", requiredPaths: ["tracked.txt"] },
    acceptanceCriteria: [{ id: "AC-01", text: "Only tracked.txt may change" }],
    requiredVerification: []
  };
  const result = runCompanion(
    ["task", "--wait", "--write", "--envelope-stdin", "--json"],
    { cwd: root, env, input: JSON.stringify(envelope) }
  );
  assert.notEqual(result.status, 0);
  const error = JSON.parse(result.stdout).error;
  assert.equal(error.code, "E_SCOPE_VIOLATION");
  assert.deepEqual(error.details.paths, ["ignored-output.txt"]);
});

test("integration: interim/final separation, resume by job ID, context drift", {
  skip: !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, async () => {
  const root = initRepo();
  const interim = "INTERIM_SHOULD_NOT_ENTER_WORKER_REPORT";
  const finalText = workerReport({ summary: "FINAL_ANSWER_ONLY_FOR_REPORT" });
  const { env, pluginData } = fixture({ interimText: interim, taskText: finalText, toolAfterFinal: true });
  const job = parseJson(runCompanion(["task", "--wait", "separate interim final", "--json"], { cwd: root, env }));
  assert.equal(job.result.workerReport.summary, "FINAL_ANSWER_ONLY_FOR_REPORT");
  assert.equal(job.result.interim.bytes, Buffer.byteLength(interim));
  assert.equal(JSON.stringify(job.result.workerReport).includes(interim), false);
  assert.equal(job.result.hostVerification, "not_run");
  assert.equal(job.taskContract.objective, null);
  assert.equal(JSON.stringify(job).includes("separate interim final"), false);

  const resumed = parseJson(runCompanion(
    ["task", "--wait", "--job-id", job.id, "continue from explicit job", "--json"],
    { cwd: root, env }
  ));
  assert.equal(resumed.resumeJobId, job.id);

  const hostlessEnv = { ...env };
  delete hostlessEnv.GROK_COMPANION_HOST_SESSION_ID;
  delete hostlessEnv.GROK_COMPANION_CLAUDE_SESSION_ID;
  delete hostlessEnv.CLAUDE_SESSION_ID;
  const hostlessResume = runCompanion(
    ["task", "--wait", "--job-id", job.id, "hostless caller must not resume", "--json"],
    { cwd: root, env: hostlessEnv }
  );
  assert.notEqual(hostlessResume.status, 0, hostlessResume.stdout);
  assert.match(hostlessResume.stdout, /E_JOB_NOT_FOUND/);

  const { readJob, writeJob } = await import("../plugins/grok/scripts/lib/state.mjs");
  const previousData = process.env.CLAUDE_PLUGIN_DATA;
  const previousHost = process.env.GROK_COMPANION_HOST;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  process.env.GROK_COMPANION_HOST = "claude-code";
  try {
    const forged = readJob(fs.realpathSync(root), job.id);
    forged.completionContextManifest = {
      ...forged.completionContextManifest,
      workspaceRoot: "/tmp/definitely-not-this-workspace"
    };
    writeJob(root, forged);
  } finally {
    if (previousData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousData;
    if (previousHost === undefined) delete process.env.GROK_COMPANION_HOST;
    else process.env.GROK_COMPANION_HOST = previousHost;
  }

  const drift = runCompanion(
    ["task", "--wait", "--job-id", job.id, "should fail drift", "--json"],
    { cwd: root, env }
  );
  assert.notEqual(drift.status, 0, drift.stdout);
  assert.match(`${drift.stderr}\n${drift.stdout}`, /E_CONTEXT_DRIFT/);
});
