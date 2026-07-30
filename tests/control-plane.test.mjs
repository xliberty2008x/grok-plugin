import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  appendLifecycleEvent,
  assertContextCompatible,
  assertContextManifestIntegrity,
  assertTaskContextReady,
  buildRuntimeEvidence,
  buildTaskEnvelope,
  buildWorkerReport,
  buildWorkerReportOutputSchema,
  captureContextManifest,
  composeProviderPrompt,
  composeWorkerReportRepairPrompt,
  CONTEXT_METADATA_POLICIES,
  evaluateScope,
  observeChangedPaths
} from "../plugins/grok/scripts/lib/task-contract.mjs";
import { validateReview, REVIEW_SCHEMA } from "../plugins/grok/scripts/lib/grok-provider.mjs";
import { processStartToken } from "../plugins/grok/scripts/lib/process-control.mjs";
import { STDIN_READY_MARKER } from "../plugins/grok/scripts/lib/stdin.mjs";
import {
  initRepo,
  git,
  run,
  runCompanion,
  spawnNonblockingStdin,
  testEnvironment,
  waitFor,
  ROOT,
  tempDir
} from "./helpers.mjs";
import { installFakeGrok, readFakeLog } from "./fake-grok.mjs";
import { installPinnedFakeCompanion } from "./pinned-fake-grok.mjs";
import { missingInvalidProviderCapabilityReceiptMessage } from "../plugins/grok/scripts/lib/host.mjs";

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

function canonicalizeForDigest(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalizeForDigest);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalizeForDigest(value[key])])
  );
}

function stableDigestForTest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalizeForDigest(value)))
    .digest("hex");
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
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.workspaceRoot, fs.realpathSync(root));
  assert.ok(manifest.git.head);
  assert.ok(manifest.git.branch);
  assert.ok(manifest.git.trackedTreeIdentity);
  assert.ok(manifest.git.dirtyDigest);
  assert.match(manifest.digest, /^[a-f0-9]{64}$/);
  assert.match(manifest.manifestId, /^ctx-[a-f0-9]{24}$/);
  assert.equal(assertContextManifestIntegrity(manifest), manifest);
  assert.equal(
    assertContextCompatible(root, manifest, { mode: "execute" }),
    manifest,
    "compatibility retains the integrity-checked stored manifest"
  );
  assertContextCompatible(root, manifest, { mode: "resume" });
  // Nested field rewrites with stale digest/id fail closed on integrity first.
  assert.throws(
    () => assertContextCompatible(root, { ...manifest, workspaceRoot: "/tmp/other-checkout" }, { mode: "resume" }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
      && /integrity|tampered|malformed/i.test(error.message)
      && !String(error.message).includes("/tmp/other-checkout")
  );
  assert.throws(
    () => assertContextCompatible(root, {
      ...manifest,
      git: { ...manifest.git, head: "0".repeat(40) }
    }, { mode: "execute" }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
      && /integrity|tampered|malformed/i.test(error.message)
  );
  assert.throws(
    () => assertContextCompatible(root, manifest, {
      mode: "execute",
      metadataPolicy: "not-a-real-policy"
    }),
    (error) => error?.code === "E_CONTEXT_DRIFT" && /metadata policy/i.test(error.message)
  );
  assert.throws(
    () => assertContextCompatible(root, manifest, {
      mode: "legacy-resume",
      metadataPolicy: CONTEXT_METADATA_POLICIES.SUPERVISORY_LINKED_WRITE
    }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
      && /legacy resume/i.test(error.message)
  );
});

test("ContextManifest capturedAt is authenticated with an explicit legacy version boundary", () => {
  const root = initRepo();
  const manifest = captureContextManifest(root);
  const tamperedAt = new Date(
    Date.parse(manifest.capturedAt) + 1_000
  ).toISOString();
  assert.throws(
    () => assertContextManifestIntegrity({
      ...manifest,
      capturedAt: tamperedAt
    }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
      && error.details?.reasons?.includes("manifestIntegrity")
  );

  // A v1 record is interpreted only under its historical representation,
  // where capturedAt was not authenticated. Relabeling a v2 record as v1
  // cannot silently preserve its identity.
  assert.throws(
    () => assertContextManifestIntegrity({
      ...manifest,
      schemaVersion: 1
    }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
  );
  const legacyBody = structuredClone(manifest);
  delete legacyBody.manifestId;
  delete legacyBody.digest;
  const legacyCapturedAt = legacyBody.capturedAt;
  delete legacyBody.capturedAt;
  legacyBody.schemaVersion = 1;
  delete legacyBody.git.taskRelevantMetadataIdentity;
  delete legacyBody.git.sharedRefIdentity;
  const legacyDigest = stableDigestForTest(legacyBody);
  const legacy = {
    ...legacyBody,
    manifestId: `ctx-${legacyDigest.slice(0, 24)}`,
    digest: legacyDigest,
    capturedAt: legacyCapturedAt
  };
  assert.equal(assertContextManifestIntegrity(legacy), legacy);
  assert.doesNotThrow(
    () => assertContextCompatible(root, legacy, { mode: "resume" })
  );
  const current = captureContextManifest(root);
  assert.equal(
    observeChangedPaths(legacy, current, { observer: "verification" })
      .includes("[GIT_METADATA]"),
    false
  );
  assert.equal(
    buildRuntimeEvidence({
      preContext: legacy,
      postContext: current,
      changedPaths: observeChangedPaths(legacy, current)
    }).sharedRefObservation.classification,
    "unchanged"
  );

  // Historical records cannot attribute safe shared-ref churn, so retain the
  // strict full metadata identity rather than inheriting v2 tolerance.
  const head = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/heads/legacy-context-drift", head);
  const afterRef = captureContextManifest(root);
  assert.ok(observeChangedPaths(legacy, afterRef).includes("[GIT_METADATA]"));
  assert.throws(
    () => assertContextCompatible(root, legacy, { mode: "resume" }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
      && /metadataIdentity/.test(error.message)
  );
});

test("issue #34 lifecycle supervisory linked-write policy tolerates only primary unrelated-ref churn", () => {
  const root = initRepo();
  const head = git(root, "rev-parse", "HEAD");
  const before = captureContextManifest(root);
  assert.equal(before.git.linkedWorktree, false);
  assert.equal(before.git.sharedRefIdentity.complete, true);
  assert.equal(before.git.sharedRefIdentity.attributable, true);

  git(root, "branch", "supervisory-unrelated", head);
  git(root, "update-ref", "refs/codex/turn-diffs/supervisory-1", head);
  const after = captureContextManifest(root);
  assert.equal(
    after.git.taskRelevantMetadataIdentity,
    before.git.taskRelevantMetadataIdentity
  );
  assert.notEqual(
    after.git.sharedRefIdentity.unrelatedRefIdentity,
    before.git.sharedRefIdentity.unrelatedRefIdentity
  );
  assert.notEqual(after.git.metadataIdentity, before.git.metadataIdentity);

  // DEFAULT primary remains strict.
  assert.throws(
    () => assertContextCompatible(root, before, { mode: "execute" }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
  );
  // SUPERVISORY tolerates only unrelated-ref / full metadataIdentity representation drift.
  assert.equal(
    assertContextCompatible(root, before, {
      mode: "execute",
      metadataPolicy: CONTEXT_METADATA_POLICIES.SUPERVISORY_LINKED_WRITE
    }),
    before
  );

  // Active branch target remains fail-closed under supervisory policy.
  const beforeBranch = captureContextManifest(root);
  fs.writeFileSync(path.join(root, "branch-move.txt"), "moved\n");
  git(root, "add", "branch-move.txt");
  git(root, "commit", "-m", "move supervisory branch");
  assert.throws(
    () => assertContextCompatible(root, beforeBranch, {
      mode: "execute",
      metadataPolicy: CONTEXT_METADATA_POLICIES.SUPERVISORY_LINKED_WRITE
    }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
  );
  git(root, "reset", "--hard", head);

  // Stored-manifest tamper with stale digest fails closed without private leakage.
  const tampered = {
    ...before,
    git: {
      ...before.git,
      taskRelevantMetadataIdentity: "0".repeat(64)
    }
  };
  assert.throws(
    () => assertContextManifestIntegrity(tampered),
    (error) => error?.code === "E_CONTEXT_DRIFT"
      && !JSON.stringify(error.details || {}).includes(root)
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

test("linked-worktree tolerates unrelated shared-ref churn without [GIT_METADATA] (issue #34)", () => {
  const root = initRepo();
  // Configure a real upstream so upstream-target changes remain task-relevant.
  const remote = tempDir("grok-plugin-remote-");
  git(root, "remote", "add", "origin", remote);
  // Simulate remote-tracking without a network fetch.
  const head = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", head);
  git(root, "branch", "--set-upstream-to=origin/main", "main");

  const linkedParent = tempDir("grok-plugin-linked-ref-");
  const linkedRoot = path.join(linkedParent, "checkout");
  git(root, "worktree", "add", "-b", "task-branch", linkedRoot);
  // Keep the linked worktree on its own branch with the same upstream.
  git(linkedRoot, "branch", "--set-upstream-to=origin/main", "task-branch");

  const before = captureContextManifest(linkedRoot);
  assert.equal(before.git.linkedWorktree, true);
  assert.match(before.git.taskRelevantMetadataIdentity, /^[a-f0-9]{64}$/);
  assert.equal(before.git.sharedRefIdentity.schemaVersion, 1);
  assert.equal(before.git.sharedRefIdentity.complete, true);
  assert.equal(before.git.sharedRefIdentity.attributable, true);

  // --- Positive: unrelated local branch, unrelated remote-tracking, turn-diffs ---
  git(root, "branch", "other-local", head);
  git(root, "update-ref", "refs/remotes/origin/feature-x", head);
  git(root, "update-ref", "refs/codex/turn-diffs/turn-1", head);
  const afterUnrelated = captureContextManifest(linkedRoot);
  assert.notEqual(
    afterUnrelated.git.sharedRefIdentity.unrelatedRefIdentity,
    before.git.sharedRefIdentity.unrelatedRefIdentity,
    "unrelated shared-ref evidence must change"
  );
  assert.equal(
    afterUnrelated.git.taskRelevantMetadataIdentity,
    before.git.taskRelevantMetadataIdentity,
    "task-relevant metadata must stay stable across unrelated ref churn"
  );
  assert.notEqual(
    afterUnrelated.git.metadataIdentity,
    before.git.metadataIdentity,
    "legacy full metadataIdentity still observes the refs tree change"
  );
  const unrelatedObserved = observeChangedPaths(before, afterUnrelated);
  assert.equal(unrelatedObserved.includes("[GIT_METADATA]"), false);
  assert.deepEqual(evaluateScope(unrelatedObserved, { include: ["tracked.txt"] }), []);
  assert.doesNotThrow(() => assertContextCompatible(linkedRoot, before, { mode: "execute" }));
  assert.doesNotThrow(() => assertContextCompatible(linkedRoot, before, { mode: "resume" }));

  const unrelatedEvidence = buildRuntimeEvidence({
    preContext: before,
    postContext: afterUnrelated,
    changedPaths: unrelatedObserved
  });
  assert.deepEqual(unrelatedEvidence.sharedRefObservation, {
    schemaVersion: 1,
    classification: "tolerated_unrelated_shared_refs",
    toleratedUnrelatedSharedRefChurn: true,
    taskRelevantMetadataDrift: false
  });
  assert.equal(JSON.stringify(unrelatedEvidence).includes(linkedRoot), false);
  assert.equal(JSON.stringify(unrelatedEvidence).includes(root), false);

  // --- Packed-vs-loose semantic equivalence for the same unrelated refs ---
  const beforePack = captureContextManifest(linkedRoot);
  git(root, "pack-refs", "--all");
  const afterPack = captureContextManifest(linkedRoot);
  assert.equal(
    afterPack.git.taskRelevantMetadataIdentity,
    beforePack.git.taskRelevantMetadataIdentity
  );
  assert.equal(
    afterPack.git.sharedRefIdentity.unrelatedRefIdentity,
    beforePack.git.sharedRefIdentity.unrelatedRefIdentity
  );
  assert.equal(observeChangedPaths(beforePack, afterPack).includes("[GIT_METADATA]"), false);

  // --- Negative: current branch target change ---
  const beforeBranch = captureContextManifest(linkedRoot);
  fs.writeFileSync(path.join(linkedRoot, "branch-move.txt"), "moved\n");
  git(linkedRoot, "add", "branch-move.txt");
  git(linkedRoot, "commit", "-m", "move task branch");
  const afterBranch = captureContextManifest(linkedRoot);
  assert.notEqual(afterBranch.git.taskRelevantMetadataIdentity, beforeBranch.git.taskRelevantMetadataIdentity);
  assert.ok(observeChangedPaths(beforeBranch, afterBranch).includes("[GIT_METADATA]")
    || observeChangedPaths(beforeBranch, afterBranch).includes("[HEAD]"));
  assert.throws(
    () => assertContextCompatible(linkedRoot, beforeBranch, { mode: "execute" }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
  );

  // Reset linked worktree back for remaining negative controls.
  git(linkedRoot, "reset", "--hard", head);
  // Restore task-branch to head (commit moved it).
  git(linkedRoot, "update-ref", "refs/heads/task-branch", head);

  // --- Negative: configured upstream ref target change ---
  const beforeUpstream = captureContextManifest(linkedRoot);
  const tree = git(root, "rev-parse", `${head}^{tree}`);
  const otherCommit = git(root, "commit-tree", tree, "-m", "upstream only");
  git(root, "update-ref", "refs/remotes/origin/main", otherCommit);
  const afterUpstream = captureContextManifest(linkedRoot);
  assert.notEqual(afterUpstream.git.taskRelevantMetadataIdentity, beforeUpstream.git.taskRelevantMetadataIdentity);
  assert.ok(observeChangedPaths(beforeUpstream, afterUpstream).includes("[GIT_METADATA]"));
  assert.equal(
    buildRuntimeEvidence({
      preContext: beforeUpstream,
      postContext: afterUpstream,
      changedPaths: observeChangedPaths(beforeUpstream, afterUpstream)
    }).sharedRefObservation.taskRelevantMetadataDrift,
    true
  );
  // Restore upstream for subsequent checks.
  git(root, "update-ref", "refs/remotes/origin/main", head);

  // --- Negative: refs/replace/** is task-relevant ---
  const beforeReplace = captureContextManifest(linkedRoot);
  git(root, "update-ref", `refs/replace/${head}`, otherCommit);
  const afterReplace = captureContextManifest(linkedRoot);
  assert.ok(observeChangedPaths(beforeReplace, afterReplace).includes("[GIT_METADATA]"));
  git(root, "update-ref", "-d", `refs/replace/${head}`);

  // --- Negative: unclassified special ref (tag) is task-relevant ---
  const beforeTag = captureContextManifest(linkedRoot);
  git(root, "update-ref", "refs/tags/release-fixture", head);
  const afterTag = captureContextManifest(linkedRoot);
  assert.ok(observeChangedPaths(beforeTag, afterTag).includes("[GIT_METADATA]"));
  git(root, "update-ref", "-d", "refs/tags/release-fixture");

  // --- Negative: shared config change remains fail-closed ---
  const beforeConfig = captureContextManifest(linkedRoot);
  fs.appendFileSync(path.join(root, ".git", "config"), "\n[grok-companion-linked]\n\tvalue = true\n");
  const afterConfig = captureContextManifest(linkedRoot);
  assert.ok(observeChangedPaths(beforeConfig, afterConfig).includes("[GIT_METADATA]"));
  assert.throws(
    () => assertContextCompatible(linkedRoot, beforeConfig, { mode: "resume" }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
      && /taskRelevantMetadataIdentity|metadataIdentity/.test(error.message)
  );

  // --- Negative: index / tracked tree remains protected ---
  const beforeIndex = captureContextManifest(linkedRoot);
  fs.writeFileSync(path.join(linkedRoot, "index-touch.txt"), "staged\n");
  git(linkedRoot, "add", "index-touch.txt");
  const afterIndex = captureContextManifest(linkedRoot);
  assert.ok(observeChangedPaths(beforeIndex, afterIndex).includes("[INDEX]"));
  git(linkedRoot, "reset", "HEAD", "--", "index-touch.txt");
  fs.unlinkSync(path.join(linkedRoot, "index-touch.txt"));

  // --- Negative: shallow semantic control remains fail-closed ---
  const beforeShallow = captureContextManifest(linkedRoot);
  fs.writeFileSync(path.join(root, ".git", "shallow"), `${head}\n`);
  const afterShallow = captureContextManifest(linkedRoot);
  assert.ok(observeChangedPaths(beforeShallow, afterShallow).includes("[GIT_METADATA]"));
  fs.unlinkSync(path.join(root, ".git", "shallow"));

  // --- Negative: worktree-local HEAD control remains fail-closed ---
  const beforeHeadMeta = captureContextManifest(linkedRoot);
  const gitDirPath = String(git(linkedRoot, "rev-parse", "--git-dir"));
  const absoluteGitDir = path.resolve(linkedRoot, gitDirPath);
  const headPath = path.join(absoluteGitDir, "HEAD");
  const originalHead = fs.readFileSync(headPath, "utf8");
  fs.writeFileSync(headPath, `ref: refs/heads/other-local\n`);
  try {
    const afterHeadMeta = captureContextManifest(linkedRoot);
    assert.ok(observeChangedPaths(beforeHeadMeta, afterHeadMeta).includes("[GIT_METADATA]")
      || observeChangedPaths(beforeHeadMeta, afterHeadMeta).includes("[HEAD]"));
  } finally {
    fs.writeFileSync(headPath, originalHead);
  }

  // --- AC-R1: MERGE_HEAD / operational state is task-relevant even with unrelated refs ---
  const beforeMerge = captureContextManifest(linkedRoot);
  fs.writeFileSync(path.join(absoluteGitDir, "MERGE_HEAD"), `${head}\n`);
  git(root, "branch", "merge-unrelated-side", head);
  const afterMerge = captureContextManifest(linkedRoot);
  assert.notEqual(
    afterMerge.git.taskRelevantMetadataIdentity,
    beforeMerge.git.taskRelevantMetadataIdentity,
    "MERGE_HEAD must change task-relevant metadata identity"
  );
  assert.ok(observeChangedPaths(beforeMerge, afterMerge).includes("[GIT_METADATA]"));
  assert.equal(
    buildRuntimeEvidence({
      preContext: beforeMerge,
      postContext: afterMerge,
      changedPaths: observeChangedPaths(beforeMerge, afterMerge)
    }).sharedRefObservation.classification,
    "task_relevant_metadata_drift"
  );
  assert.throws(
    () => assertContextCompatible(linkedRoot, beforeMerge, { mode: "execute" }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
      && /taskRelevantMetadataIdentity|metadataIdentity/.test(error.message)
  );
  fs.unlinkSync(path.join(absoluteGitDir, "MERGE_HEAD"));
  git(root, "branch", "-D", "merge-unrelated-side");

  // --- AC-R1: sequencer / rebase-merge directory state is also task-relevant ---
  const beforeSequencer = captureContextManifest(linkedRoot);
  fs.mkdirSync(path.join(absoluteGitDir, "rebase-merge"), { recursive: true });
  fs.writeFileSync(path.join(absoluteGitDir, "rebase-merge", "head-name"), "refs/heads/task-branch\n");
  fs.writeFileSync(path.join(absoluteGitDir, "REBASE_HEAD"), `${head}\n`);
  const afterSequencer = captureContextManifest(linkedRoot);
  assert.notEqual(
    afterSequencer.git.taskRelevantMetadataIdentity,
    beforeSequencer.git.taskRelevantMetadataIdentity
  );
  assert.ok(observeChangedPaths(beforeSequencer, afterSequencer).includes("[GIT_METADATA]"));
  fs.rmSync(path.join(absoluteGitDir, "rebase-merge"), { recursive: true, force: true });
  fs.unlinkSync(path.join(absoluteGitDir, "REBASE_HEAD"));
});

test("primary worktree does not tolerate unrelated shared-ref churn (issue #34 AC-R2)", () => {
  const root = initRepo();
  const head = git(root, "rev-parse", "HEAD");
  const before = captureContextManifest(root);
  assert.equal(before.git.linkedWorktree, false);
  assert.match(before.git.taskRelevantMetadataIdentity, /^[a-f0-9]{64}$/);
  assert.equal(before.git.sharedRefIdentity.complete, true);
  assert.equal(before.git.sharedRefIdentity.attributable, true);

  git(root, "branch", "primary-unrelated", head);
  git(root, "update-ref", "refs/codex/turn-diffs/primary-1", head);
  const after = captureContextManifest(root);
  assert.equal(after.git.linkedWorktree, false);
  assert.equal(
    after.git.taskRelevantMetadataIdentity,
    before.git.taskRelevantMetadataIdentity,
    "unrelated refs alone must not change task-relevant identity"
  );
  assert.notEqual(after.git.metadataIdentity, before.git.metadataIdentity);
  assert.notEqual(
    after.git.sharedRefIdentity.unrelatedRefIdentity,
    before.git.sharedRefIdentity.unrelatedRefIdentity
  );
  const observed = observeChangedPaths(before, after);
  assert.ok(observed.includes("[GIT_METADATA]"), "primary worktree must not tolerate unrelated ref churn");
  assert.throws(
    () => assertContextCompatible(root, before, { mode: "execute" }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
  );
  assert.deepEqual(
    buildRuntimeEvidence({
      preContext: before,
      postContext: after,
      changedPaths: observed
    }).sharedRefObservation,
    {
      schemaVersion: 1,
      classification: "task_relevant_metadata_drift",
      toleratedUnrelatedSharedRefChurn: false,
      taskRelevantMetadataDrift: true
    }
  );

  // Missing linkedWorktree on a claimed-valid new identity fails closed.
  const missingLinked = {
    git: {
      ...before.git,
      linkedWorktree: undefined
    }
  };
  assert.deepEqual(observeChangedPaths(missingLinked, after), ["[GIT_METADATA]"]);
  assert.equal(
    buildRuntimeEvidence({
      preContext: missingLinked,
      postContext: after,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "fail_closed"
  );

  // Mismatched linked-worktree flags fail closed even when digests match.
  const mismatchedLinked = {
    git: {
      ...before.git,
      linkedWorktree: true
    }
  };
  assert.deepEqual(observeChangedPaths(before, mismatchedLinked), ["[GIT_METADATA]"]);
  assert.equal(
    buildRuntimeEvidence({
      preContext: before,
      postContext: mismatchedLinked,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "fail_closed"
  );
});

test("effective core.hooksPath contents are task-relevant without exposing paths (issue #34 AC-R3)", () => {
  const root = initRepo();
  const externalHooks = path.join(tempDir("grok-plugin-ext-hooks-"), "hooks");
  fs.mkdirSync(externalHooks, { recursive: true });
  fs.writeFileSync(path.join(externalHooks, "pre-commit"), "#!/bin/sh\necho before\nexit 0\n", {
    mode: 0o755
  });
  git(root, "config", "core.hooksPath", externalHooks);

  const before = captureContextManifest(root);
  assert.match(before.git.taskRelevantMetadataIdentity, /^[a-f0-9]{64}$/);
  assert.equal(before.git.sharedRefIdentity.complete, true);

  fs.writeFileSync(path.join(externalHooks, "pre-commit"), "#!/bin/sh\necho after\nexit 1\n", {
    mode: 0o755
  });
  const afterContent = captureContextManifest(root);
  assert.notEqual(
    afterContent.git.taskRelevantMetadataIdentity,
    before.git.taskRelevantMetadataIdentity,
    "external hooks content changes must alter task-relevant identity"
  );
  const contentObserved = observeChangedPaths(before, afterContent);
  assert.ok(contentObserved.includes("[GIT_METADATA]"));
  assert.throws(
    () => assertContextCompatible(root, before, { mode: "resume" }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
      && /taskRelevantMetadataIdentity|metadataIdentity/.test(error.message)
  );
  const contentEvidence = buildRuntimeEvidence({
    preContext: before,
    postContext: afterContent,
    changedPaths: contentObserved
  });
  assert.equal(contentEvidence.sharedRefObservation.classification, "task_relevant_metadata_drift");
  const contentSerialized = JSON.stringify(contentEvidence);
  assert.equal(contentSerialized.includes(externalHooks), false);
  assert.equal(contentSerialized.includes(root), false);

  // Symlink retarget (different link text) under effective hooks fails closed.
  const beforeLink = captureContextManifest(root);
  const hookTargetA = path.join(path.dirname(externalHooks), "target-a");
  const hookTargetB = path.join(path.dirname(externalHooks), "target-b");
  fs.writeFileSync(hookTargetA, "#!/bin/sh\nexit 0\n");
  fs.writeFileSync(hookTargetB, "#!/bin/sh\nexit 1\n");
  fs.symlinkSync(hookTargetA, path.join(externalHooks, "pre-push"));
  const midLink = captureContextManifest(root);
  assert.ok(observeChangedPaths(beforeLink, midLink).includes("[GIT_METADATA]"));
  fs.unlinkSync(path.join(externalHooks, "pre-push"));
  fs.symlinkSync(hookTargetB, path.join(externalHooks, "pre-push"));
  const afterLink = captureContextManifest(root);
  assert.notEqual(afterLink.git.taskRelevantMetadataIdentity, midLink.git.taskRelevantMetadataIdentity);
  assert.ok(observeChangedPaths(midLink, afterLink).includes("[GIT_METADATA]"));
  assert.equal(JSON.stringify(buildRuntimeEvidence({
    preContext: midLink,
    postContext: afterLink,
    changedPaths: ["[GIT_METADATA]"]
  })).includes(hookTargetA), false);

  // AC-1: unchanged symlink path, mutated target file contents must drift.
  const sharedHookBody = path.join(path.dirname(externalHooks), "shared-hook-body");
  fs.writeFileSync(sharedHookBody, "#!/bin/sh\necho target-v1\nexit 0\n");
  fs.unlinkSync(path.join(externalHooks, "pre-push"));
  fs.symlinkSync(sharedHookBody, path.join(externalHooks, "pre-push"));
  const beforeTargetBody = captureContextManifest(root);
  fs.writeFileSync(sharedHookBody, "#!/bin/sh\necho target-v2\nexit 1\n");
  const afterTargetBody = captureContextManifest(root);
  assert.notEqual(
    afterTargetBody.git.taskRelevantMetadataIdentity,
    beforeTargetBody.git.taskRelevantMetadataIdentity,
    "mutating symlink target contents must change task-relevant identity"
  );
  assert.ok(observeChangedPaths(beforeTargetBody, afterTargetBody).includes("[GIT_METADATA]"));
  assert.equal(
    buildRuntimeEvidence({
      preContext: beforeTargetBody,
      postContext: afterTargetBody,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "task_relevant_metadata_drift"
  );
  const targetBodySerialized = JSON.stringify(buildRuntimeEvidence({
    preContext: beforeTargetBody,
    postContext: afterTargetBody,
    changedPaths: ["[GIT_METADATA]"]
  }));
  assert.equal(targetBodySerialized.includes(sharedHookBody), false);
  assert.equal(targetBodySerialized.includes(externalHooks), false);

  // Unreadable effective hooks inventory fails closed (no unrelated-ref tolerance).
  const beforeUnreadable = captureContextManifest(root);
  assert.equal(beforeUnreadable.git.sharedRefIdentity.complete, true);
  const blockedDir = path.join(externalHooks, "blocked-sub");
  fs.mkdirSync(blockedDir, { recursive: true });
  fs.writeFileSync(path.join(blockedDir, "nested-hook"), "#!/bin/sh\nexit 0\n");
  // Directory mode 000 makes readdir fail closed for the effective hooks tree.
  fs.chmodSync(blockedDir, 0o000);
  try {
    const afterUnreadable = captureContextManifest(root);
    assert.equal(afterUnreadable.git.sharedRefIdentity.complete, false);
    assert.equal(afterUnreadable.git.sharedRefIdentity.attributable, false);
    assert.ok(observeChangedPaths(beforeUnreadable, afterUnreadable).includes("[GIT_METADATA]"));
    assert.ok(observeChangedPaths(afterUnreadable, afterUnreadable).includes("[GIT_METADATA]"));
    assert.equal(
      buildRuntimeEvidence({
        preContext: afterUnreadable,
        postContext: afterUnreadable,
        changedPaths: ["[GIT_METADATA]"]
      }).sharedRefObservation.classification,
      "fail_closed"
    );
    const unreadableSerialized = JSON.stringify(buildRuntimeEvidence({
      preContext: beforeUnreadable,
      postContext: afterUnreadable,
      changedPaths: ["[GIT_METADATA]"]
    }));
    assert.equal(unreadableSerialized.includes(externalHooks), false);
    assert.equal(unreadableSerialized.includes(blockedDir), false);
  } finally {
    fs.chmodSync(blockedDir, 0o755);
  }
});

test("effective hooksPath directory symlink and cycle-safe target follow (issue #34 AC-2/AC-3)", () => {
  const root = initRepo();

  // AC-2: core.hooksPath is a symlink to a directory; mutate a file behind it.
  const realHooks = path.join(tempDir("grok-plugin-real-hooks-"), "hooks");
  const hooksLink = path.join(tempDir("grok-plugin-hooks-link-"), "hooks-link");
  fs.mkdirSync(realHooks, { recursive: true });
  fs.writeFileSync(path.join(realHooks, "pre-commit"), "#!/bin/sh\necho dirlink-v1\nexit 0\n", {
    mode: 0o755
  });
  fs.symlinkSync(realHooks, hooksLink);
  git(root, "config", "core.hooksPath", hooksLink);

  const beforeDirLink = captureContextManifest(root);
  assert.match(beforeDirLink.git.taskRelevantMetadataIdentity, /^[a-f0-9]{64}$/);
  assert.equal(beforeDirLink.git.sharedRefIdentity.complete, true);
  fs.writeFileSync(path.join(realHooks, "pre-commit"), "#!/bin/sh\necho dirlink-v2\nexit 1\n", {
    mode: 0o755
  });
  const afterDirLink = captureContextManifest(root);
  assert.notEqual(
    afterDirLink.git.taskRelevantMetadataIdentity,
    beforeDirLink.git.taskRelevantMetadataIdentity,
    "mutating a hook file behind a hooksPath directory symlink must drift"
  );
  assert.ok(observeChangedPaths(beforeDirLink, afterDirLink).includes("[GIT_METADATA]"));
  assert.throws(
    () => assertContextCompatible(root, beforeDirLink, { mode: "execute" }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
  );
  const dirLinkEvidence = buildRuntimeEvidence({
    preContext: beforeDirLink,
    postContext: afterDirLink,
    changedPaths: observeChangedPaths(beforeDirLink, afterDirLink)
  });
  assert.equal(dirLinkEvidence.sharedRefObservation.classification, "task_relevant_metadata_drift");
  const dirLinkSerialized = JSON.stringify(dirLinkEvidence);
  assert.equal(dirLinkSerialized.includes(realHooks), false);
  assert.equal(dirLinkSerialized.includes(hooksLink), false);
  assert.equal(dirLinkSerialized.includes(root), false);

  // AC-3: broken symlink target fails closed without leaking absolute paths.
  const beforeBroken = captureContextManifest(root);
  const brokenTarget = path.join(path.dirname(realHooks), "missing-hook-target");
  fs.symlinkSync(brokenTarget, path.join(realHooks, "broken-hook"));
  const afterBroken = captureContextManifest(root);
  assert.equal(afterBroken.git.sharedRefIdentity.complete, false);
  assert.ok(observeChangedPaths(beforeBroken, afterBroken).includes("[GIT_METADATA]"));
  assert.ok(observeChangedPaths(afterBroken, afterBroken).includes("[GIT_METADATA]"));
  assert.equal(
    buildRuntimeEvidence({
      preContext: afterBroken,
      postContext: afterBroken,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "fail_closed"
  );
  assert.equal(JSON.stringify(buildRuntimeEvidence({
    preContext: beforeBroken,
    postContext: afterBroken,
    changedPaths: ["[GIT_METADATA]"]
  })).includes(brokenTarget), false);
  fs.unlinkSync(path.join(realHooks, "broken-hook"));

  // AC-3: cyclic symlink chain fails closed without path leakage.
  const beforeCycle = captureContextManifest(root);
  assert.equal(beforeCycle.git.sharedRefIdentity.complete, true);
  fs.symlinkSync("cycle-b", path.join(realHooks, "cycle-a"));
  fs.symlinkSync("cycle-a", path.join(realHooks, "cycle-b"));
  const afterCycle = captureContextManifest(root);
  assert.equal(afterCycle.git.sharedRefIdentity.complete, false);
  assert.equal(afterCycle.git.sharedRefIdentity.attributable, false);
  assert.ok(observeChangedPaths(beforeCycle, afterCycle).includes("[GIT_METADATA]"));
  assert.ok(observeChangedPaths(afterCycle, afterCycle).includes("[GIT_METADATA]"));
  assert.equal(
    buildRuntimeEvidence({
      preContext: afterCycle,
      postContext: afterCycle,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "fail_closed"
  );
  const cycleSerialized = JSON.stringify(buildRuntimeEvidence({
    preContext: beforeCycle,
    postContext: afterCycle,
    changedPaths: ["[GIT_METADATA]"]
  }));
  assert.equal(cycleSerialized.includes(realHooks), false);
  assert.equal(cycleSerialized.includes("cycle-a"), false);
  assert.equal(cycleSerialized.includes("cycle-b"), false);
});

test("effective include.path / includeIf config changes task-relevant identity (issue #34 AC-1)", () => {
  const root = initRepo();
  const externalDir = tempDir("grok-plugin-ext-config-");
  const included = path.join(externalDir, "included.gitconfig");
  fs.writeFileSync(included, "[grok-companion-include]\n\tmarker = v1\n");

  // Absolute include.path: repository config bytes stay fixed while the external
  // included file changes effective config (Git resolves includes on list).
  fs.appendFileSync(
    path.join(root, ".git", "config"),
    `\n[include]\n\tpath = ${included}\n`
  );

  const before = captureContextManifest(root);
  assert.match(before.git.taskRelevantMetadataIdentity, /^[a-f0-9]{64}$/);
  assert.equal(before.git.sharedRefIdentity.complete, true);

  // Mutate only the external included file; repository config bytes stay fixed.
  fs.writeFileSync(included, "[grok-companion-include]\n\tmarker = v2-secret-token\n");
  const after = captureContextManifest(root);
  assert.notEqual(
    after.git.taskRelevantMetadataIdentity,
    before.git.taskRelevantMetadataIdentity,
    "external include.path content must change task-relevant metadata identity"
  );
  assert.ok(observeChangedPaths(before, after).includes("[GIT_METADATA]"));
  assert.throws(
    () => assertContextCompatible(root, before, { mode: "resume" }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
      && /taskRelevantMetadataIdentity|metadataIdentity/.test(error.message)
  );

  const evidence = buildRuntimeEvidence({
    preContext: before,
    postContext: after,
    changedPaths: observeChangedPaths(before, after)
  });
  assert.equal(evidence.sharedRefObservation.classification, "task_relevant_metadata_drift");
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes(included), false);
  assert.equal(serialized.includes(externalDir), false);
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes("v2-secret-token"), false);
  assert.equal(serialized.includes("grok-companion-include"), false);
  assert.equal(serialized.includes("marker"), false);

  // Multi-valued include.path also binds without path leakage.
  const secondIncluded = path.join(externalDir, "second-included.gitconfig");
  fs.writeFileSync(secondIncluded, "[grok-companion-abs]\n\tvalue = first\n");
  git(root, "config", "--local", "--add", "include.path", secondIncluded);
  const beforeSecond = captureContextManifest(root);
  fs.writeFileSync(secondIncluded, "[grok-companion-abs]\n\tvalue = second-credential\n");
  const afterSecond = captureContextManifest(root);
  assert.notEqual(
    afterSecond.git.taskRelevantMetadataIdentity,
    beforeSecond.git.taskRelevantMetadataIdentity
  );
  assert.ok(observeChangedPaths(beforeSecond, afterSecond).includes("[GIT_METADATA]"));
  const secondSerialized = JSON.stringify(buildRuntimeEvidence({
    preContext: beforeSecond,
    postContext: afterSecond,
    changedPaths: ["[GIT_METADATA]"]
  }));
  assert.equal(secondSerialized.includes(secondIncluded), false);
  assert.equal(secondSerialized.includes("second-credential"), false);

  // includeIf.gitdir condition: effective config follows when the condition matches.
  const conditionalIncluded = path.join(externalDir, "conditional.gitconfig");
  fs.writeFileSync(conditionalIncluded, "[grok-companion-cond]\n\tflag = before\n");
  // Git matches includeIf gitdir against the realpath of the repository git dir.
  const gitDirAbs = fs.realpathSync(path.resolve(root, ".git"));
  fs.appendFileSync(
    path.join(root, ".git", "config"),
    `\n[includeIf "gitdir:${gitDirAbs}"]\n\tpath = ${conditionalIncluded}\n`
  );
  const beforeCond = captureContextManifest(root);
  fs.writeFileSync(conditionalIncluded, "[grok-companion-cond]\n\tflag = after-cond-secret\n");
  const afterCond = captureContextManifest(root);
  assert.notEqual(
    afterCond.git.taskRelevantMetadataIdentity,
    beforeCond.git.taskRelevantMetadataIdentity,
    "includeIf-resolved external config must change task-relevant identity"
  );
  assert.ok(observeChangedPaths(beforeCond, afterCond).includes("[GIT_METADATA]"));
  const condSerialized = JSON.stringify(buildRuntimeEvidence({
    preContext: beforeCond,
    postContext: afterCond,
    changedPaths: ["[GIT_METADATA]"]
  }));
  assert.equal(condSerialized.includes(conditionalIncluded), false);
  assert.equal(condSerialized.includes(gitDirAbs), false);
  assert.equal(condSerialized.includes("after-cond-secret"), false);

  // Linked worktree also observes shared effective-config drift.
  const linkedParent = tempDir("grok-plugin-cfg-linked-");
  const linkedRoot = path.join(linkedParent, "checkout");
  git(root, "worktree", "add", "-b", "cfg-task", linkedRoot);
  const beforeLinked = captureContextManifest(linkedRoot);
  fs.writeFileSync(secondIncluded, "[grok-companion-abs]\n\tvalue = linked-sees-this\n");
  const afterLinked = captureContextManifest(linkedRoot);
  assert.notEqual(
    afterLinked.git.taskRelevantMetadataIdentity,
    beforeLinked.git.taskRelevantMetadataIdentity
  );
  assert.ok(observeChangedPaths(beforeLinked, afterLinked).includes("[GIT_METADATA]"));
  assert.equal(JSON.stringify(buildRuntimeEvidence({
    preContext: beforeLinked,
    postContext: afterLinked,
    changedPaths: ["[GIT_METADATA]"]
  })).includes(secondIncluded), false);
});

test("MERGE_AUTOSTASH and audited operational controls are task-relevant (issue #34 AC-2)", () => {
  const root = initRepo();
  const linkedParent = tempDir("grok-plugin-op-linked-");
  const linkedRoot = path.join(linkedParent, "checkout");
  git(root, "worktree", "add", "-b", "op-task", linkedRoot);
  const gitDirPath = String(git(linkedRoot, "rev-parse", "--git-dir"));
  const absoluteGitDir = path.resolve(linkedRoot, gitDirPath);
  const head = git(linkedRoot, "rev-parse", "HEAD");

  // CREATE MERGE_AUTOSTASH
  const beforeCreate = captureContextManifest(linkedRoot);
  fs.writeFileSync(path.join(absoluteGitDir, "MERGE_AUTOSTASH"), `${head}\n`);
  const afterCreate = captureContextManifest(linkedRoot);
  assert.notEqual(
    afterCreate.git.taskRelevantMetadataIdentity,
    beforeCreate.git.taskRelevantMetadataIdentity,
    "creating MERGE_AUTOSTASH must change task-relevant identity"
  );
  assert.ok(observeChangedPaths(beforeCreate, afterCreate).includes("[GIT_METADATA]"));
  assert.equal(
    buildRuntimeEvidence({
      preContext: beforeCreate,
      postContext: afterCreate,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "task_relevant_metadata_drift"
  );

  // CHANGE MERGE_AUTOSTASH
  const tree = git(root, "rev-parse", `${head}^{tree}`);
  const other = git(root, "commit-tree", tree, "-m", "autostash other");
  fs.writeFileSync(path.join(absoluteGitDir, "MERGE_AUTOSTASH"), `${other}\n`);
  const afterChange = captureContextManifest(linkedRoot);
  assert.notEqual(
    afterChange.git.taskRelevantMetadataIdentity,
    afterCreate.git.taskRelevantMetadataIdentity,
    "changing MERGE_AUTOSTASH must change task-relevant identity"
  );
  assert.ok(observeChangedPaths(afterCreate, afterChange).includes("[GIT_METADATA]"));

  // REMOVE MERGE_AUTOSTASH
  fs.unlinkSync(path.join(absoluteGitDir, "MERGE_AUTOSTASH"));
  const afterRemove = captureContextManifest(linkedRoot);
  assert.notEqual(
    afterRemove.git.taskRelevantMetadataIdentity,
    afterChange.git.taskRelevantMetadataIdentity,
    "removing MERGE_AUTOSTASH must change task-relevant identity"
  );
  assert.ok(observeChangedPaths(afterChange, afterRemove).includes("[GIT_METADATA]"));
  assert.equal(
    afterRemove.git.taskRelevantMetadataIdentity,
    beforeCreate.git.taskRelevantMetadataIdentity,
    "removing MERGE_AUTOSTASH restores prior operational identity"
  );

  // Audited companion control: SQUASH_MSG is also task-relevant.
  const beforeSquash = captureContextManifest(linkedRoot);
  fs.writeFileSync(path.join(absoluteGitDir, "SQUASH_MSG"), "squash in progress\n");
  const afterSquash = captureContextManifest(linkedRoot);
  assert.notEqual(afterSquash.git.taskRelevantMetadataIdentity, beforeSquash.git.taskRelevantMetadataIdentity);
  assert.ok(observeChangedPaths(beforeSquash, afterSquash).includes("[GIT_METADATA]"));
  fs.unlinkSync(path.join(absoluteGitDir, "SQUASH_MSG"));

  // Existing merge operational control still covered alongside unrelated refs.
  const beforeMerge = captureContextManifest(linkedRoot);
  fs.writeFileSync(path.join(absoluteGitDir, "MERGE_HEAD"), `${head}\n`);
  git(root, "branch", "op-unrelated", head);
  const afterMerge = captureContextManifest(linkedRoot);
  assert.notEqual(afterMerge.git.taskRelevantMetadataIdentity, beforeMerge.git.taskRelevantMetadataIdentity);
  assert.ok(observeChangedPaths(beforeMerge, afterMerge).includes("[GIT_METADATA]"));
  fs.unlinkSync(path.join(absoluteGitDir, "MERGE_HEAD"));
  git(root, "branch", "-D", "op-unrelated");
});

test("top-level optional root present/absent races fail closed; stable absence remains complete (issue #34)", () => {
  const root = initRepo();
  const linkedParent = tempDir("grok-plugin-root-race-");
  const linkedRoot = path.join(linkedParent, "checkout");
  git(root, "worktree", "add", "-b", "root-race", linkedRoot);
  const gitDirPath = String(git(linkedRoot, "rev-parse", "--git-dir"));
  const absoluteGitDir = path.resolve(linkedRoot, gitDirPath);
  const head = git(linkedRoot, "rev-parse", "HEAD");

  const mergeHeadPath = path.join(absoluteGitDir, "MERGE_HEAD");
  const rebaseHeadPath = path.join(absoluteGitDir, "REBASE_HEAD");
  const sameCanonicalPath = (left, right) => {
    try {
      return path.join(
        fs.realpathSync(path.dirname(String(left))),
        path.basename(String(left))
      ) === path.join(
        fs.realpathSync(path.dirname(String(right))),
        path.basename(String(right))
      );
    } catch {
      return false;
    }
  };

  // Stable absence of optional operational roots remains complete.
  assert.equal(fs.existsSync(mergeHeadPath), false);
  const baseline = captureContextManifest(linkedRoot);
  assert.equal(baseline.git.sharedRefIdentity.complete, true);
  assert.equal(baseline.git.sharedRefIdentity.attributable, true);
  assert.match(baseline.git.taskRelevantMetadataIdentity, /^[a-f0-9]{64}$/);
  const baselineAgain = captureContextManifest(linkedRoot);
  assert.equal(
    baselineAgain.git.taskRelevantMetadataIdentity,
    baseline.git.taskRelevantMetadataIdentity,
    "stable absent optional roots must remain deterministic and complete"
  );
  assert.equal(baselineAgain.git.sharedRefIdentity.complete, true);

  // --- AC-1: MERGE_HEAD appears while a later operational root is lstat'd ---
  // Reproduces the race where MERGE_HEAD was created after its early ENOENT and
  // before batch completion, previously publishing a complete baseline-equal identity.
  const originalLstatSync = fs.lstatSync;
  let mergeAppeared = false;
  // Private operational marker (not the public HEAD field) for leakage checks.
  const mergePrivateMarker = "merge-head-private-race-marker";
  fs.lstatSync = function lstatSyncCreateMergeHeadDuringLaterRoot(file, ...rest) {
    if (
      !mergeAppeared
      && sameCanonicalPath(file, rebaseHeadPath)
      && !fs.existsSync(mergeHeadPath)
    ) {
      mergeAppeared = true;
      fs.writeFileSync(mergeHeadPath, `${mergePrivateMarker}\n${head}\n`);
    }
    return originalLstatSync.call(this, file, ...rest);
  };
  try {
    const afterAppearRace = captureContextManifest(linkedRoot);
    assert.equal(mergeAppeared, true, "harness must create MERGE_HEAD during later root lstat");
    assert.equal(fs.existsSync(mergeHeadPath), true);
    assert.equal(afterAppearRace.git.sharedRefIdentity.complete, false);
    assert.equal(afterAppearRace.git.sharedRefIdentity.attributable, false);
    assert.ok(observeChangedPaths(baseline, afterAppearRace).includes("[GIT_METADATA]"));
    assert.equal(
      buildRuntimeEvidence({
        preContext: afterAppearRace,
        postContext: afterAppearRace,
        changedPaths: ["[GIT_METADATA]"]
      }).sharedRefObservation.classification,
      "fail_closed"
    );
    // Must not publish the stale complete baseline identity under a race.
    assert.notEqual(
      afterAppearRace.git.taskRelevantMetadataIdentity,
      baseline.git.taskRelevantMetadataIdentity
    );
    const appearEvidence = JSON.stringify(buildRuntimeEvidence({
      preContext: baseline,
      postContext: afterAppearRace,
      changedPaths: ["[GIT_METADATA]"]
    }));
    // Absolute metadata paths and private operational contents must not leak.
    // HEAD itself is an intentionally public manifest field and may appear.
    assert.equal(appearEvidence.includes(mergeHeadPath), false);
    assert.equal(appearEvidence.includes(absoluteGitDir), false);
    assert.equal(appearEvidence.includes(mergePrivateMarker), false);
  } finally {
    fs.lstatSync = originalLstatSync;
  }

  // --- AC-1: present top-level root removed while a later sibling is lstat'd ---
  try { fs.unlinkSync(mergeHeadPath); } catch { /* absent ok */ }
  fs.writeFileSync(mergeHeadPath, `${head}\n`);
  const presentBaseline = captureContextManifest(linkedRoot);
  assert.equal(presentBaseline.git.sharedRefIdentity.complete, true);
  assert.notEqual(
    presentBaseline.git.taskRelevantMetadataIdentity,
    baseline.git.taskRelevantMetadataIdentity
  );

  let mergeRemoved = false;
  fs.lstatSync = function lstatSyncRemoveMergeHeadDuringLaterRoot(file, ...rest) {
    // Fire only after MERGE_HEAD itself has been observed at least once so the
    // removal races the later batch roots, not the initial present capture.
    if (
      !mergeRemoved
      && sameCanonicalPath(file, rebaseHeadPath)
      && fs.existsSync(mergeHeadPath)
    ) {
      mergeRemoved = true;
      fs.unlinkSync(mergeHeadPath);
    }
    return originalLstatSync.call(this, file, ...rest);
  };
  try {
    const afterRemovalRace = captureContextManifest(linkedRoot);
    assert.equal(mergeRemoved, true, "harness must remove MERGE_HEAD during later root lstat");
    assert.equal(fs.existsSync(mergeHeadPath), false);
    assert.equal(afterRemovalRace.git.sharedRefIdentity.complete, false);
    assert.equal(afterRemovalRace.git.sharedRefIdentity.attributable, false);
    assert.ok(observeChangedPaths(presentBaseline, afterRemovalRace).includes("[GIT_METADATA]"));
    assert.equal(
      buildRuntimeEvidence({
        preContext: afterRemovalRace,
        postContext: afterRemovalRace,
        changedPaths: ["[GIT_METADATA]"]
      }).sharedRefObservation.classification,
      "fail_closed"
    );
  } finally {
    fs.lstatSync = originalLstatSync;
  }

  // --- AC-1: effective missing hooks root appears after absent witness ---
  try { fs.unlinkSync(mergeHeadPath); } catch { /* absent ok */ }
  const hooksParent = fs.realpathSync(tempDir("grok-plugin-missing-hooks-race-"));
  const externalHooks = path.join(hooksParent, "hooks");
  // Intentionally absent at capture start.
  assert.equal(fs.existsSync(externalHooks), false);
  git(linkedRoot, "config", "core.hooksPath", externalHooks);
  const missingHooksBaseline = captureContextManifest(linkedRoot);
  assert.equal(missingHooksBaseline.git.sharedRefIdentity.complete, true);

  // Non-mutating calibration: count exact-path lstats for the absent hooks root
  // during a full capture (includes lexical probes, missing witness, and final
  // absent-root revalidation). Inject only on that calibrated final ordinal so
  // earlier probes cannot consume a hard-coded "3rd lstat" slot.
  let calibrationHooksLstats = 0;
  fs.lstatSync = function lstatSyncCalibrateAbsentHooks(file, ...rest) {
    if (sameCanonicalPath(file, externalHooks)) {
      calibrationHooksLstats += 1;
    }
    return originalLstatSync.call(this, file, ...rest);
  };
  try {
    const calibration = captureContextManifest(linkedRoot);
    assert.equal(calibration.git.sharedRefIdentity.complete, true);
    assert.equal(fs.existsSync(externalHooks), false, "calibration must not create hooks");
  } finally {
    fs.lstatSync = originalLstatSync;
  }
  assert.ok(
    calibrationHooksLstats >= 2,
    "absent hooks path must be lstat'd at least for witness + final revalidation"
  );
  const finalAbsentRevalidationOrdinal = calibrationHooksLstats;

  let hooksCreated = false;
  let hooksLstatAttempts = 0;
  fs.lstatSync = function lstatSyncCreateHooksOnFinalRevalidation(file, ...rest) {
    if (sameCanonicalPath(file, externalHooks)) {
      hooksLstatAttempts += 1;
      // Create only on the calibrated final revalidation call so the absent
      // witness is recorded first and revalidation observes appearance.
      if (
        hooksLstatAttempts === finalAbsentRevalidationOrdinal
        && !fs.existsSync(externalHooks)
      ) {
        hooksCreated = true;
        fs.mkdirSync(externalHooks, { recursive: true });
        fs.writeFileSync(
          path.join(externalHooks, "post-appear"),
          "#!/bin/sh\nexit 0\n",
          { mode: 0o755 }
        );
      }
    }
    return originalLstatSync.call(this, file, ...rest);
  };
  try {
    const afterHooksAppear = captureContextManifest(linkedRoot);
    assert.equal(hooksCreated, true, "harness must create missing hooks on final revalidation lstat");
    assert.equal(
      hooksLstatAttempts,
      finalAbsentRevalidationOrdinal,
      "race capture must use the calibrated final absent-root lstat ordinal"
    );
    assert.equal(afterHooksAppear.git.sharedRefIdentity.complete, false);
    assert.equal(afterHooksAppear.git.sharedRefIdentity.attributable, false);
    assert.equal(
      buildRuntimeEvidence({
        preContext: afterHooksAppear,
        postContext: afterHooksAppear,
        changedPaths: ["[GIT_METADATA]"]
      }).sharedRefObservation.classification,
      "fail_closed"
    );
    const hooksEvidence = JSON.stringify(buildRuntimeEvidence({
      preContext: missingHooksBaseline,
      postContext: afterHooksAppear,
      changedPaths: ["[GIT_METADATA]"]
    }));
    assert.equal(hooksEvidence.includes(externalHooks), false);
    assert.equal(hooksEvidence.includes("post-appear"), false);
  } finally {
    fs.lstatSync = originalLstatSync;
  }

  // Cleanup hooksPath so subsequent local captures are not fail-closed.
  try { fs.rmSync(externalHooks, { recursive: true, force: true }); } catch { /* ignore */ }
  git(linkedRoot, "config", "--unset", "core.hooksPath");
});

test("bisect control inventory binds BISECT_HEAD/NAMES/FIRST_PARENT/ANCESTORS_OK (issue #34)", () => {
  const root = initRepo();
  const linkedParent = tempDir("grok-plugin-bisect-ctrl-");
  const linkedRoot = path.join(linkedParent, "checkout");
  git(root, "worktree", "add", "-b", "bisect-ctrl", linkedRoot);
  const gitDirPath = String(git(linkedRoot, "rev-parse", "--git-dir"));
  const absoluteGitDir = path.resolve(linkedRoot, gitDirPath);
  const head = git(linkedRoot, "rev-parse", "HEAD");
  const tree = git(linkedRoot, "rev-parse", `${head}^{tree}`);
  const alternateOid = git(linkedRoot, "commit-tree", tree, "-m", "bisect-control-target");

  // Audited behavior-bearing standard bisect controls (fixed inventory).
  const bisectControls = [
    "BISECT_LOG",
    "BISECT_EXPECTED_REV",
    "BISECT_START",
    "BISECT_TERMS",
    "BISECT_RUN",
    "BISECT_HEAD",
    "BISECT_NAMES",
    "BISECT_FIRST_PARENT",
    "BISECT_ANCESTORS_OK"
  ];

  const before = captureContextManifest(linkedRoot);
  assert.equal(before.git.sharedRefIdentity.complete, true);
  assert.match(before.git.taskRelevantMetadataIdentity, /^[a-f0-9]{64}$/);

  for (const name of bisectControls) {
    const controlPath = path.join(absoluteGitDir, name);
    const beforeControl = captureContextManifest(linkedRoot);
    // Git interprets BISECT_EXPECTED_REV and BISECT_HEAD as OID-bearing
    // controls. Keep those fixtures valid so this test proves stable,
    // behavior-bearing bisect drift rather than malformed-control fail-closed.
    // Other controls use private markers whose raw bodies must not leak.
    const privateMarker = `bisect-private-${name.toLowerCase()}-marker`;
    const oidBearing = name === "BISECT_EXPECTED_REV" || name === "BISECT_HEAD";
    const payload = oidBearing
      ? `${alternateOid}\n`
      : name === "BISECT_NAMES"
        ? `paths 0\n${privateMarker}\n`
        : `${privateMarker}\n`;
    fs.writeFileSync(controlPath, payload);
    const afterControl = captureContextManifest(linkedRoot);
    assert.equal(
      afterControl.git.sharedRefIdentity.complete,
      true,
      `${name} valid stable control must remain completely observable`
    );
    assert.equal(
      afterControl.git.sharedRefIdentity.attributable,
      true,
      `${name} valid stable control must remain attributable`
    );
    assert.notEqual(
      afterControl.git.taskRelevantMetadataIdentity,
      beforeControl.git.taskRelevantMetadataIdentity,
      `${name} must change task-relevant metadata identity`
    );
    const observed = observeChangedPaths(beforeControl, afterControl);
    assert.ok(
      observed.includes("[GIT_METADATA]"),
      `${name} must surface as [GIT_METADATA] context drift`
    );
    assert.equal(
      buildRuntimeEvidence({
        preContext: beforeControl,
        postContext: afterControl,
        changedPaths: observed
      }).sharedRefObservation.classification,
      "task_relevant_metadata_drift"
    );
    assert.throws(
      () => assertContextCompatible(linkedRoot, beforeControl, { mode: "execute" }),
      (error) => error?.code === "E_CONTEXT_DRIFT"
        && /taskRelevantMetadataIdentity|metadataIdentity/.test(error.message)
    );
    const evidence = JSON.stringify(buildRuntimeEvidence({
      preContext: beforeControl,
      postContext: afterControl,
      changedPaths: observed
    }));
    assert.equal(evidence.includes(controlPath), false);
    assert.equal(evidence.includes(absoluteGitDir), false);
    // Control payload markers must not leak into public runtime evidence.
    assert.equal(evidence.includes(privateMarker), false);
    assert.equal(evidence.includes(alternateOid), false);
    assert.equal(evidence.includes(name), false);
    fs.unlinkSync(controlPath);
    const afterRemove = captureContextManifest(linkedRoot);
    assert.equal(
      afterRemove.git.taskRelevantMetadataIdentity,
      beforeControl.git.taskRelevantMetadataIdentity,
      `removing ${name} must restore prior task-relevant identity`
    );
  }

  // Combined first-parent bisect-like set also drifts from clean baseline.
  for (const name of ["BISECT_HEAD", "BISECT_NAMES", "BISECT_FIRST_PARENT", "BISECT_ANCESTORS_OK"]) {
    fs.writeFileSync(
      path.join(absoluteGitDir, name),
      name === "BISECT_HEAD"
        ? `${alternateOid}\n`
        : name === "BISECT_NAMES"
          ? "paths 0\n"
          : `combined-${name}\n`
    );
  }
  const afterCombined = captureContextManifest(linkedRoot);
  assert.equal(afterCombined.git.sharedRefIdentity.complete, true);
  assert.equal(afterCombined.git.sharedRefIdentity.attributable, true);
  assert.notEqual(
    afterCombined.git.taskRelevantMetadataIdentity,
    before.git.taskRelevantMetadataIdentity
  );
  assert.ok(observeChangedPaths(before, afterCombined).includes("[GIT_METADATA]"));
  for (const name of ["BISECT_HEAD", "BISECT_NAMES", "BISECT_FIRST_PARENT", "BISECT_ANCESTORS_OK"]) {
    fs.unlinkSync(path.join(absoluteGitDir, name));
  }

  // Malformed OID-bearing root pseudorefs are not ordinary marker controls:
  // they must remain fail-closed rather than being reinterpreted as absent.
  const malformedRootMarker = "malformed-private-bisect-head";
  fs.writeFileSync(path.join(absoluteGitDir, "BISECT_HEAD"), `${malformedRootMarker}\n`);
  const malformedRoot = captureContextManifest(linkedRoot);
  assert.equal(malformedRoot.git.sharedRefIdentity.complete, false);
  assert.equal(malformedRoot.git.sharedRefIdentity.attributable, false);
  assert.equal(
    buildRuntimeEvidence({
      preContext: malformedRoot,
      postContext: malformedRoot,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "fail_closed"
  );
  assert.equal(
    JSON.stringify(buildRuntimeEvidence({
      preContext: before,
      postContext: malformedRoot,
      changedPaths: ["[GIT_METADATA]"]
    })).includes(malformedRootMarker),
    false
  );
  fs.unlinkSync(path.join(absoluteGitDir, "BISECT_HEAD"));
});

test("linked-worktree sparse-checkout pattern control changes task-relevant identity (issue #34)", () => {
  const root = initRepo();
  // Materialize two top-level paths so cone pattern a -> b is meaningful.
  fs.mkdirSync(path.join(root, "alpha-path"), { recursive: true });
  fs.mkdirSync(path.join(root, "beta-path"), { recursive: true });
  fs.writeFileSync(path.join(root, "alpha-path", "a.txt"), "alpha\n");
  fs.writeFileSync(path.join(root, "beta-path", "b.txt"), "beta\n");
  git(root, "add", "alpha-path", "beta-path");
  git(root, "commit", "-m", "sparse fixture trees");

  const linkedParent = tempDir("grok-plugin-sparse-ctrl-");
  const linkedRoot = path.join(linkedParent, "checkout");
  git(root, "worktree", "add", "-b", "sparse-ctrl", linkedRoot);
  const gitDirPath = String(git(linkedRoot, "rev-parse", "--git-dir"));
  const absoluteGitDir = path.resolve(linkedRoot, gitDirPath);
  const sparseControlPath = path.join(absoluteGitDir, "info", "sparse-checkout");

  // Initialize cone-mode sparse-checkout and set pattern "alpha-path".
  git(linkedRoot, "sparse-checkout", "init", "--cone");
  git(linkedRoot, "sparse-checkout", "set", "alpha-path");
  assert.equal(fs.existsSync(sparseControlPath), true, "effective sparse-checkout control must exist");
  const patternA = fs.readFileSync(sparseControlPath);
  const before = captureContextManifest(linkedRoot);
  assert.equal(before.git.sharedRefIdentity.complete, true);
  assert.equal(before.git.sparse, true);
  assert.match(before.git.taskRelevantMetadataIdentity, /^[a-f0-9]{64}$/);
  const beforeAgain = captureContextManifest(linkedRoot);
  assert.equal(
    beforeAgain.git.taskRelevantMetadataIdentity,
    before.git.taskRelevantMetadataIdentity,
    "stable sparse-checkout patterns must remain deterministic"
  );

  // Mutate the effective control file directly (pattern a -> b) without reapplying
  // sparse materialization, so identity drift is attributable to the control path
  // itself rather than dirty worktree path churn.
  const privatePatternMarker = "sparse-private-pattern-beta-marker";
  fs.writeFileSync(
    sparseControlPath,
    `/*\n!/*/\n/beta-path/\n# ${privatePatternMarker}\n`
  );
  assert.equal(
    fs.readFileSync(sparseControlPath).equals(patternA),
    false,
    "harness must change sparse-checkout control contents"
  );
  const after = captureContextManifest(linkedRoot);
  assert.equal(after.git.sparse, true);
  assert.notEqual(
    after.git.taskRelevantMetadataIdentity,
    before.git.taskRelevantMetadataIdentity,
    "sparse-checkout pattern change must change task-relevant metadata identity"
  );
  const observed = observeChangedPaths(before, after);
  assert.ok(
    observed.includes("[GIT_METADATA]"),
    "sparse-checkout pattern drift must surface as [GIT_METADATA]"
  );
  assert.equal(
    buildRuntimeEvidence({
      preContext: before,
      postContext: after,
      changedPaths: observed
    }).sharedRefObservation.classification,
    "task_relevant_metadata_drift"
  );
  assert.throws(
    () => assertContextCompatible(linkedRoot, before, { mode: "execute" }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
      && /taskRelevantMetadataIdentity|metadataIdentity/.test(error.message)
  );

  // Privacy: pattern markers and git-dir control paths must not leak.
  const evidence = JSON.stringify(buildRuntimeEvidence({
    preContext: before,
    postContext: after,
    changedPaths: ["[GIT_METADATA]"]
  }));
  assert.equal(evidence.includes(privatePatternMarker), false);
  assert.equal(evidence.includes(sparseControlPath), false);
  assert.equal(evidence.includes(absoluteGitDir), false);
  assert.equal(evidence.includes(linkedRoot), false);
  assert.equal(evidence.includes("sparse-checkout"), false);

  // Restore a clean pattern via git, then disable: control-state change must drift.
  git(linkedRoot, "sparse-checkout", "set", "beta-path");
  const afterSetB = captureContextManifest(linkedRoot);
  git(linkedRoot, "sparse-checkout", "disable");
  const afterDisable = captureContextManifest(linkedRoot);
  assert.notEqual(
    afterDisable.git.taskRelevantMetadataIdentity,
    afterSetB.git.taskRelevantMetadataIdentity
  );
  assert.ok(observeChangedPaths(afterSetB, afterDisable).includes("[GIT_METADATA]"));
});

test("reftable BISECT_HEAD root pseudoref changes task-relevant identity (issue #34)", () => {
  const root = tempDir("grok-plugin-reftable-");
  // Prefer a real reftable backend when Git supports it; never claim reftable
  // while silently falling back.
  const reftableInit = run("git", ["init", "-b", "main", "--ref-format=reftable"], { cwd: root });
  const usingReftable = reftableInit.status === 0;
  if (!usingReftable) {
    // Older Git without reftable: explicit files-backend coverage of the same
    // backend-aware pseudoref path via update-ref.
    git(root, "init", "-b", "main");
  }
  git(root, "config", "user.email", "tests@example.com");
  git(root, "config", "user.name", "Grok Plugin Tests");
  fs.writeFileSync(path.join(root, "tracked.txt"), "original\n", "utf8");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "initial");
  const head = git(root, "rev-parse", "HEAD");

  if (usingReftable) {
    const format = run("git", ["rev-parse", "--show-ref-format"], { cwd: root });
    assert.equal(format.status, 0, "reftable init must expose --show-ref-format");
    assert.equal(
      String(format.stdout || "").trim(),
      "reftable",
      "fixture must be a real reftable repository when reftable init succeeds"
    );
    const storage = run("git", ["config", "--get", "extensions.refStorage"], { cwd: root });
    assert.equal(String(storage.stdout || "").trim(), "reftable");
  }

  const before = captureContextManifest(root);
  assert.equal(
    before.git.sharedRefIdentity.complete,
    true,
    usingReftable
      ? "clean reftable baseline must be complete (empty loose refs/ is valid)"
      : "clean files-backend baseline must be complete"
  );
  assert.equal(before.git.sharedRefIdentity.attributable, true);
  assert.match(before.git.taskRelevantMetadataIdentity, /^[a-f0-9]{64}$/);
  const beforeAgain = captureContextManifest(root);
  assert.equal(
    beforeAgain.git.taskRelevantMetadataIdentity,
    before.git.taskRelevantMetadataIdentity,
    "stable operational state must remain deterministic"
  );

  // Prefer Git update-ref so reftable backends store the pseudoref (often without
  // a loose control file). Backend-aware Git resolution must observe either way.
  git(root, "update-ref", "BISECT_HEAD", head);
  const after = captureContextManifest(root);
  assert.notEqual(
    after.git.taskRelevantMetadataIdentity,
    before.git.taskRelevantMetadataIdentity,
    usingReftable
      ? "reftable BISECT_HEAD create must change task-relevant identity"
      : "files-backend BISECT_HEAD create must change task-relevant identity"
  );
  assert.ok(observeChangedPaths(before, after).includes("[GIT_METADATA]"));
  assert.throws(
    () => assertContextCompatible(root, before, { mode: "execute" }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
  );
  const evidence = JSON.stringify(buildRuntimeEvidence({
    preContext: before,
    postContext: after,
    changedPaths: ["[GIT_METADATA]"]
  }));
  assert.equal(evidence.includes(path.join(root, ".git", "BISECT_HEAD")), false);
  assert.equal(evidence.includes("BISECT_HEAD"), false);

  // Change target OID.
  const tree = git(root, "rev-parse", `${head}^{tree}`);
  const other = git(root, "commit-tree", tree, "-m", "bisect other");
  git(root, "update-ref", "BISECT_HEAD", other);
  const afterChange = captureContextManifest(root);
  assert.notEqual(
    afterChange.git.taskRelevantMetadataIdentity,
    after.git.taskRelevantMetadataIdentity
  );

  git(root, "update-ref", "-d", "BISECT_HEAD");
  const afterRemove = captureContextManifest(root);
  assert.equal(
    afterRemove.git.taskRelevantMetadataIdentity,
    before.git.taskRelevantMetadataIdentity,
    "removing BISECT_HEAD must restore prior task-relevant identity"
  );
});

test("broken file refs and dangling symbolic refs fail closed (issue #34)", () => {
  const root = initRepo();
  const head = git(root, "rev-parse", "HEAD");
  const before = captureContextManifest(root);
  assert.equal(before.git.sharedRefIdentity.complete, true);
  assert.equal(before.git.sharedRefIdentity.attributable, true);

  // Broken loose tag: invalid object name content that makes Git warn.
  const brokenTag = path.join(root, ".git", "refs", "tags", "broken-tag");
  fs.mkdirSync(path.dirname(brokenTag), { recursive: true });
  fs.writeFileSync(brokenTag, "not-a-valid-oid\n");
  const afterBroken = captureContextManifest(root);
  assert.equal(afterBroken.git.sharedRefIdentity.complete, false);
  assert.equal(afterBroken.git.sharedRefIdentity.attributable, false);
  assert.ok(observeChangedPaths(before, afterBroken).includes("[GIT_METADATA]"));
  assert.equal(
    buildRuntimeEvidence({
      preContext: afterBroken,
      postContext: afterBroken,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "fail_closed"
  );
  // Linked tolerance must not apply to broken inventories.
  const linkedBroken = {
    git: {
      ...afterBroken.git,
      linkedWorktree: true
    }
  };
  assert.equal(
    buildRuntimeEvidence({
      preContext: linkedBroken,
      postContext: linkedBroken,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "fail_closed"
  );
  const brokenEvidence = JSON.stringify(buildRuntimeEvidence({
    preContext: before,
    postContext: afterBroken,
    changedPaths: ["[GIT_METADATA]"]
  }));
  assert.equal(brokenEvidence.includes(brokenTag), false);
  assert.equal(brokenEvidence.includes("not-a-valid-oid"), false);
  fs.unlinkSync(brokenTag);

  // Dangling symbolic ref under refs/tags.
  const dangling = path.join(root, ".git", "refs", "tags", "dangling-sym");
  fs.writeFileSync(dangling, "ref: refs/heads/does-not-exist\n");
  const afterDangling = captureContextManifest(root);
  assert.equal(afterDangling.git.sharedRefIdentity.complete, false);
  assert.equal(afterDangling.git.sharedRefIdentity.attributable, false);
  assert.ok(observeChangedPaths(before, afterDangling).includes("[GIT_METADATA]"));
  assert.equal(
    buildRuntimeEvidence({
      preContext: afterDangling,
      postContext: afterDangling,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "fail_closed"
  );
  const danglingEvidence = JSON.stringify(buildRuntimeEvidence({
    preContext: before,
    postContext: afterDangling,
    changedPaths: ["[GIT_METADATA]"]
  }));
  assert.equal(danglingEvidence.includes(dangling), false);
  assert.equal(danglingEvidence.includes("does-not-exist"), false);
  fs.unlinkSync(dangling);

  // Arbitrary symlink node under refs/ must fail closed (not silently ignored).
  const symlinkRef = path.join(root, ".git", "refs", "tags", "symlink-plant");
  const symlinkTarget = path.join(root, ".git", "refs", "tags", "symlink-target-missing");
  fs.symlinkSync(symlinkTarget, symlinkRef);
  const afterSymlink = captureContextManifest(root);
  assert.equal(afterSymlink.git.sharedRefIdentity.complete, false);
  assert.equal(afterSymlink.git.sharedRefIdentity.attributable, false);
  assert.equal(
    buildRuntimeEvidence({
      preContext: afterSymlink,
      postContext: afterSymlink,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "fail_closed"
  );
  const symlinkEvidence = JSON.stringify(buildRuntimeEvidence({
    preContext: before,
    postContext: afterSymlink,
    changedPaths: ["[GIT_METADATA]"]
  }));
  assert.equal(symlinkEvidence.includes(symlinkRef), false);
  assert.equal(symlinkEvidence.includes(symlinkTarget), false);
  fs.unlinkSync(symlinkRef);

  // Reftable-marker-shaped content on a files backend is still broken (not ignored).
  const markerPlant = path.join(root, ".git", "refs", "tags", "fake-marker");
  fs.writeFileSync(markerPlant, "this repository uses the reftable format\n");
  const afterMarkerPlant = captureContextManifest(root);
  assert.equal(afterMarkerPlant.git.sharedRefIdentity.complete, false);
  assert.equal(afterMarkerPlant.git.sharedRefIdentity.attributable, false);
  fs.unlinkSync(markerPlant);

  // Healthy inventory restored.
  const restored = captureContextManifest(root);
  assert.equal(restored.git.sharedRefIdentity.complete, true);
  // Touch a real ref so head stays used.
  assert.equal(typeof head, "string");
});

test("linked worktree-private refs are bounded, effective, and fail closed when malformed (issue #34)", (t) => {
  const root = initRepo();
  const head = git(root, "rev-parse", "HEAD");
  const linkedParent = tempDir("grok-plugin-private-refs-");
  const linkedRoot = path.join(linkedParent, "checkout");
  git(root, "worktree", "add", "-b", "private-ref-linked", linkedRoot);
  t.after(() => {
    try {
      git(root, "worktree", "remove", "--force", linkedRoot);
    } catch {}
  });
  const linkedGitDir = git(
    linkedRoot,
    "rev-parse",
    "--path-format=absolute",
    "--git-dir"
  );

  for (const namespace of ["bisect", "worktree", "rewritten"]) {
    git(linkedRoot, "update-ref", `refs/${namespace}/valid`, head);
  }
  const baseline = captureContextManifest(linkedRoot);
  assert.equal(baseline.git.linkedWorktree, true);
  assert.equal(baseline.git.sharedRefIdentity.complete, true);
  assert.equal(baseline.git.sharedRefIdentity.attributable, true);
  for (const namespace of ["bisect", "worktree", "rewritten"]) {
    assert.ok(
      baseline.git.sharedRefIdentity.taskRelevantRefs.some(
        (entry) => entry.name === `refs/${namespace}/valid`
      )
    );
  }

  for (const namespace of ["bisect", "worktree", "rewritten"]) {
    const namespaceRoot = path.join(linkedGitDir, "refs", namespace);
    fs.mkdirSync(namespaceRoot, { recursive: true });
    for (const [label, body] of [
      ["dangling", "ref: refs/heads/does-not-exist\n"],
      ["invalid-oid", "not-a-valid-object-id\n"]
    ]) {
      const malformedPath = path.join(namespaceRoot, label);
      fs.writeFileSync(malformedPath, body, "utf8");
      const malformed = captureContextManifest(linkedRoot);
      assert.equal(malformed.git.sharedRefIdentity.complete, false);
      assert.equal(malformed.git.sharedRefIdentity.attributable, false);
      assert.ok(
        observeChangedPaths(baseline, malformed).includes("[GIT_METADATA]")
      );
      const evidence = JSON.stringify(buildRuntimeEvidence({
        preContext: baseline,
        postContext: malformed,
        changedPaths: ["[GIT_METADATA]"]
      }));
      assert.equal(evidence.includes(malformedPath), false);
      assert.equal(evidence.includes(body.trim()), false);
      fs.unlinkSync(malformedPath);
      const restored = captureContextManifest(linkedRoot);
      assert.equal(restored.git.sharedRefIdentity.complete, true);
      assert.equal(restored.git.sharedRefIdentity.attributable, true);
    }
  }
});

test("core.hooksPath ancestor symlink retarget changes task identity (issue #34)", () => {
  const root = initRepo();
  const parent = fs.realpathSync(tempDir("grok-plugin-ancestor-hooks-"));
  const realA = path.join(parent, "real-a");
  const realB = path.join(parent, "real-b");
  const linkName = path.join(parent, "link");
  fs.mkdirSync(path.join(realA, "sub"), { recursive: true });
  fs.mkdirSync(path.join(realB, "sub"), { recursive: true });
  // Identical hook tree bytes under both targets.
  const hookBody = "#!/bin/sh\necho ancestor-stable\nexit 0\n";
  fs.writeFileSync(path.join(realA, "sub", "pre-commit"), hookBody, { mode: 0o755 });
  fs.writeFileSync(path.join(realB, "sub", "pre-commit"), hookBody, { mode: 0o755 });
  fs.symlinkSync(realA, linkName);
  // Configured path: link/sub — final component is a non-symlink directory;
  // only the ancestor `link` is a symlink.
  const configured = path.join(linkName, "sub");
  assert.equal(fs.lstatSync(configured).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(linkName).isSymbolicLink(), true);
  git(root, "config", "core.hooksPath", configured);

  const before = captureContextManifest(root);
  assert.equal(before.git.sharedRefIdentity.complete, true);
  assert.match(before.git.taskRelevantMetadataIdentity, /^[a-f0-9]{64}$/);

  // Retarget ancestor symlink; hook file bytes remain identical.
  fs.unlinkSync(linkName);
  fs.symlinkSync(realB, linkName);
  const after = captureContextManifest(root);
  assert.notEqual(
    after.git.taskRelevantMetadataIdentity,
    before.git.taskRelevantMetadataIdentity,
    "ancestor symlink retarget must change task-relevant identity"
  );
  assert.ok(observeChangedPaths(before, after).includes("[GIT_METADATA]"));
  const evidence = JSON.stringify(buildRuntimeEvidence({
    preContext: before,
    postContext: after,
    changedPaths: ["[GIT_METADATA]"]
  }));
  assert.equal(evidence.includes(configured), false);
  assert.equal(evidence.includes(linkName), false);
  assert.equal(evidence.includes(realA), false);
  assert.equal(evidence.includes(realB), false);
  assert.equal(evidence.includes(parent), false);
  assert.equal(evidence.includes("ancestor-stable"), false);
});

test("semantic ref target mutation between inventories fails closed (issue #34 AC-1)", () => {
  const root = initRepo();
  const head = git(root, "rev-parse", "HEAD");
  const tree = git(root, "rev-parse", `${head}^{tree}`);
  const other = git(root, "commit-tree", tree, "-m", "alt-target");
  const raceRef = "refs/heads/semantic-race";
  git(root, "update-ref", raceRef, head);
  // Loose ref path Git materializes for update-ref (files backend).
  const raceRefPath = path.join(root, ".git", "refs", "heads", "semantic-race");
  assert.equal(fs.existsSync(raceRefPath), true, "harness requires a loose race ref file");
  const raceRefReal = fs.realpathSync(raceRefPath);

  const baseline = captureContextManifest(root);
  assert.equal(baseline.git.sharedRefIdentity.complete, true);
  assert.equal(baseline.git.sharedRefIdentity.attributable, true);
  const baselineIdentity = baseline.git.taskRelevantMetadataIdentity;
  assert.match(baselineIdentity, /^[a-f0-9]{64}$/);

  // Stable re-capture remains complete when nothing races.
  const stableAgain = captureContextManifest(root);
  assert.equal(stableAgain.git.sharedRefIdentity.complete, true);
  assert.equal(stableAgain.git.taskRelevantMetadataIdentity, baselineIdentity);

  // Inject via the shared fs module (production imports node:fs the same way).
  // Capture opens this loose path twice: (1) legacy metadata hashing before the
  // semantic inventory, then (2) the descriptor-bound loose-ref validation
  // after first for-each-ref + show-ref and before the second for-each-ref.
  // Mutate on open #2 so the first semantic inventory retains the baseline
  // target while the second exact name+target pass observes `other`.
  // (CJS spawnSync patches do not rebind ESM named imports of
  // node:child_process.)
  const originalOpenSync = fs.openSync;
  let raceOpens = 0;
  let mutated = false;
  const isRaceRefPath = (file) => {
    if (typeof file !== "string" || !file) return false;
    try {
      return fs.realpathSync(String(file)) === raceRefReal;
    } catch {
      try {
        return path.resolve(String(file)) === path.resolve(raceRefPath);
      } catch {
        return false;
      }
    }
  };
  fs.openSync = function openSyncWithSemanticRace(file, ...rest) {
    const descriptor = originalOpenSync.call(this, file, ...rest);
    if (isRaceRefPath(file)) {
      raceOpens += 1;
      if (raceOpens === 2 && !mutated) {
        mutated = true;
        // Install the alternate valid OID during bounded loose-ref validation;
        // the subsequent exact semantic inventory must disagree with the first.
        fs.writeFileSync(raceRefPath, `${other}\n`);
        assert.equal(
          String(fs.readFileSync(raceRefPath, "utf8")).trim().toLowerCase(),
          other.toLowerCase(),
          "harness must install the alternate OID on the race ref path"
        );
      }
    }
    return descriptor;
  };
  try {
    const afterRace = captureContextManifest(root);
    assert.equal(mutated, true, "harness must inject a same-name target mutation");
    assert.ok(raceOpens >= 2, `race ref must be opened at least twice during capture, got ${raceOpens}`);
    assert.equal(
      afterRace.git.sharedRefIdentity.complete,
      false,
      "mid-capture same-name target mutation must fail closed"
    );
    assert.equal(afterRace.git.sharedRefIdentity.attributable, false);
    assert.notEqual(
      afterRace.git.taskRelevantMetadataIdentity,
      baselineIdentity,
      "must not return the baseline complete identity after a raced target mutation"
    );
    assert.ok(observeChangedPaths(baseline, afterRace).includes("[GIT_METADATA]"));
    assert.equal(
      buildRuntimeEvidence({
        preContext: afterRace,
        postContext: afterRace,
        changedPaths: ["[GIT_METADATA]"]
      }).sharedRefObservation.classification,
      "fail_closed"
    );
    const evidence = JSON.stringify(buildRuntimeEvidence({
      preContext: baseline,
      postContext: afterRace,
      changedPaths: ["[GIT_METADATA]"]
    }));
    assert.equal(evidence.includes(raceRef), false);
    assert.equal(evidence.includes(other), false);
    assert.equal(evidence.includes("taskRelevantRefs"), false);
    assert.equal(evidence.includes("unrelatedRefs"), false);
  } finally {
    fs.openSync = originalOpenSync;
  }
});

test("dangling loose symref injected after the first stable scan fails closed (issue #34)", () => {
  const root = initRepo();
  const mainRefPath = path.join(root, ".git", "refs", "heads", "main");
  const mainRefReal = fs.realpathSync(mainRefPath);
  const injectedRefPath = path.join(
    root,
    ".git",
    "refs",
    "heads",
    "post-scan-dangling"
  );
  const baseline = captureContextManifest(root);
  assert.equal(baseline.git.sharedRefIdentity.complete, true);

  const originalOpenSync = fs.openSync;
  let mainRefOpens = 0;
  let injected = false;
  fs.openSync = function injectAfterFirstLooseScan(file, ...rest) {
    const descriptor = originalOpenSync.call(this, file, ...rest);
    if (typeof file === "string") {
      let candidate = null;
      try {
        candidate = fs.realpathSync(file);
      } catch {
        candidate = path.resolve(file);
      }
      if (candidate === mainRefReal) {
        mainRefOpens += 1;
        // Legacy metadata opens once; the first stable loose scan opens twice
        // (capture + final revalidation). Opening #4 begins the second scan,
        // after the second semantic Git inventory has already completed.
        if (mainRefOpens === 4 && !injected) {
          fs.writeFileSync(
            injectedRefPath,
            "ref: refs/heads/does-not-exist\n",
            "utf8"
          );
          injected = true;
        }
      }
    }
    return descriptor;
  };
  let raced;
  try {
    raced = captureContextManifest(root);
  } finally {
    fs.openSync = originalOpenSync;
    if (fs.existsSync(injectedRefPath)) fs.unlinkSync(injectedRefPath);
  }

  assert.equal(injected, true, "harness must inject after the first loose scan");
  assert.ok(mainRefOpens >= 4);
  assert.equal(raced.git.sharedRefIdentity.complete, false);
  assert.equal(raced.git.sharedRefIdentity.attributable, false);
  assert.ok(observeChangedPaths(baseline, raced).includes("[GIT_METADATA]"));
  const evidence = JSON.stringify(buildRuntimeEvidence({
    preContext: baseline,
    postContext: raced,
    changedPaths: ["[GIT_METADATA]"]
  }));
  assert.equal(evidence.includes(injectedRefPath), false);
  assert.equal(evidence.includes("does-not-exist"), false);
});

test("task-relevant symbolic refs bind both target name and resolved OID (issue #34)", () => {
  const root = initRepo();
  const head = git(root, "rev-parse", "HEAD");
  const tree = git(root, "rev-parse", `${head}^{tree}`);
  const advanced = git(root, "commit-tree", tree, "-p", head, "-m", "advanced-symbol-target");
  const targetRef = "refs/heads/symbol-target";
  const symbolicRef = "refs/notes/task-symbolic";
  git(root, "update-ref", targetRef, head);
  git(root, "symbolic-ref", symbolicRef, targetRef);

  const before = captureContextManifest(root);
  assert.equal(before.git.sharedRefIdentity.complete, true);
  assert.equal(before.git.sharedRefIdentity.attributable, true);
  const beforeEntry = before.git.sharedRefIdentity.taskRelevantRefs.find(
    (entry) => entry.name === symbolicRef
  );
  assert.equal(beforeEntry.target, targetRef);
  assert.equal(beforeEntry.resolvedOid, head);

  git(root, "update-ref", targetRef, advanced);
  const after = captureContextManifest(root);
  const afterEntry = after.git.sharedRefIdentity.taskRelevantRefs.find(
    (entry) => entry.name === symbolicRef
  );
  assert.equal(afterEntry.target, targetRef);
  assert.equal(afterEntry.resolvedOid, advanced);
  assert.notEqual(
    after.git.sharedRefIdentity.taskRelevantRefIdentity,
    before.git.sharedRefIdentity.taskRelevantRefIdentity
  );
  assert.ok(observeChangedPaths(before, after).includes("[GIT_METADATA]"));
});

test("reftable BISECT_HEAD DWIM tag ambiguity fails closed (issue #34 AC-2)", () => {
  const root = tempDir("grok-plugin-bisect-dwim-");
  const reftableInit = run("git", ["init", "-b", "main", "--ref-format=reftable"], { cwd: root });
  const usingReftable = reftableInit.status === 0;
  if (!usingReftable) {
    git(root, "init", "-b", "main");
  }
  git(root, "config", "user.email", "tests@example.com");
  git(root, "config", "user.name", "Grok Plugin Tests");
  fs.writeFileSync(path.join(root, "tracked.txt"), "original\n", "utf8");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "initial");
  const head = git(root, "rev-parse", "HEAD");

  const clean = captureContextManifest(root);
  assert.equal(clean.git.sharedRefIdentity.complete, true);
  const cleanIdentity = clean.git.taskRelevantMetadataIdentity;

  // Tag-only BISECT_HEAD must not be mistaken for the root pseudoref (DWIM).
  git(root, "update-ref", "refs/tags/BISECT_HEAD", head);
  const tagOnly = captureContextManifest(root);
  assert.equal(
    tagOnly.git.sharedRefIdentity.complete,
    true,
    "tag-only BISECT_HEAD must leave root-pseudoref inventory complete"
  );
  // Tag creation is task-relevant shared-ref drift, but operational root presence
  // must remain absent (not DWIM-present).
  assert.notEqual(tagOnly.git.taskRelevantMetadataIdentity, cleanIdentity);

  // Root create while the same-named tag exists must be observed: either the
  // operational identity changes, or ambiguity/stderr fails closed — never a
  // silent same complete operational view that hides the root.
  git(root, "update-ref", "BISECT_HEAD", head);
  const both = captureContextManifest(root);
  if (both.git.sharedRefIdentity.complete) {
    assert.notEqual(
      both.git.taskRelevantMetadataIdentity,
      tagOnly.git.taskRelevantMetadataIdentity,
      "root BISECT_HEAD create must change identity when tag already exists"
    );
  } else {
    assert.equal(both.git.sharedRefIdentity.attributable, false);
    assert.equal(
      buildRuntimeEvidence({
        preContext: both,
        postContext: both,
        changedPaths: ["[GIT_METADATA]"]
      }).sharedRefObservation.classification,
      "fail_closed"
    );
  }
  assert.ok(observeChangedPaths(tagOnly, both).includes("[GIT_METADATA]"));

  // Root removal must not leave a DWIM tag resolution that pretends root still exists.
  git(root, "update-ref", "-d", "BISECT_HEAD");
  const afterRootRemove = captureContextManifest(root);
  if (afterRootRemove.git.sharedRefIdentity.complete && both.git.sharedRefIdentity.complete) {
    assert.equal(
      afterRootRemove.git.taskRelevantMetadataIdentity,
      tagOnly.git.taskRelevantMetadataIdentity,
      "removing root BISECT_HEAD must restore the tag-only identity"
    );
  } else {
    // Ambiguous mid-state fails closed rather than silently accepting DWIM.
    assert.equal(afterRootRemove.git.sharedRefIdentity.complete, false);
  }
  assert.ok(observeChangedPaths(both, afterRootRemove).includes("[GIT_METADATA]")
    || afterRootRemove.git.sharedRefIdentity.complete === false);

  const evidence = JSON.stringify(buildRuntimeEvidence({
    preContext: tagOnly,
    postContext: both,
    changedPaths: ["[GIT_METADATA]"]
  }));
  assert.equal(evidence.includes("BISECT_HEAD"), false);
  assert.equal(evidence.includes(path.join(root, ".git")), false);
  assert.equal(usingReftable || !usingReftable, true);
});

test("old-Git root pseudoref fallback keeps BISECT_HEAD exact and rejects a tag-only namesake (issue #34)", {
  skip: process.platform === "win32"
}, () => {
  const root = initRepo();
  const head = git(root, "rev-parse", "HEAD");
  const gitDir = git(root, "rev-parse", "--absolute-git-dir");
  const realGit = run("which", ["git"]).stdout.trim();
  assert.ok(path.isAbsolute(realGit));

  const shimDir = tempDir("grok-plugin-old-git-");
  const shim = path.join(shimDir, "git");
  fs.writeFileSync(
    shim,
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"for-each-ref\" ]; then",
      "  for arg in \"$@\"; do",
      "    if [ \"$arg\" = \"--include-root-refs\" ]; then",
      "      echo \"error: unknown option 'include-root-refs'\" >&2",
      "      exit 129",
      "    fi",
      "  done",
      "fi",
      `exec ${JSON.stringify(realGit)} "$@"`,
      ""
    ].join("\n"),
    { mode: 0o755 }
  );
  fs.chmodSync(shim, 0o755);

  const priorPath = process.env.PATH;
  process.env.PATH = `${shimDir}${path.delimiter}${priorPath || ""}`;
  try {
    fs.writeFileSync(path.join(gitDir, "BISECT_HEAD"), `${head}\n`, "utf8");
    const present = captureContextManifest(root);
    const stablePresent = captureContextManifest(root);
    assert.equal(present.git.sharedRefIdentity.complete, true);
    assert.equal(present.git.sharedRefIdentity.attributable, true);
    assert.equal(
      stablePresent.git.taskRelevantMetadataIdentity,
      present.git.taskRelevantMetadataIdentity
    );

    fs.unlinkSync(path.join(gitDir, "BISECT_HEAD"));
    const createTag = run(
      realGit,
      ["update-ref", "refs/tags/BISECT_HEAD", head],
      { cwd: root }
    );
    assert.equal(createTag.status, 0, createTag.stderr);
    const tagOnly = captureContextManifest(root);
    const stableTagOnly = captureContextManifest(root);
    assert.equal(tagOnly.git.sharedRefIdentity.complete, true);
    assert.equal(tagOnly.git.sharedRefIdentity.attributable, true);
    assert.equal(
      stableTagOnly.git.taskRelevantMetadataIdentity,
      tagOnly.git.taskRelevantMetadataIdentity
    );
    assert.notEqual(
      tagOnly.git.taskRelevantMetadataIdentity,
      present.git.taskRelevantMetadataIdentity
    );
  } finally {
    if (priorPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = priorPath;
    }
  }
});

test("ordinary hooksPath ancestor swapped to symlink fails closed (issue #34 AC-3)", () => {
  const root = initRepo();
  const parent = fs.realpathSync(tempDir("grok-plugin-ordinary-hooks-"));
  const ordinary = path.join(parent, "ordinary");
  const hooksDir = path.join(ordinary, "hooks");
  const altTree = path.join(parent, "alt-tree");
  const altHooks = path.join(altTree, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(altHooks, { recursive: true });
  const hookBody = "#!/bin/sh\necho ordinary-stable\nexit 0\n";
  fs.writeFileSync(path.join(hooksDir, "pre-commit"), hookBody, { mode: 0o755 });
  fs.writeFileSync(path.join(altHooks, "pre-commit"), hookBody, { mode: 0o755 });
  assert.equal(fs.lstatSync(ordinary).isSymbolicLink(), false);
  git(root, "config", "core.hooksPath", hooksDir);

  const baseline = captureContextManifest(root);
  assert.equal(baseline.git.sharedRefIdentity.complete, true);
  assert.match(baseline.git.taskRelevantMetadataIdentity, /^[a-f0-9]{64}$/);

  // Between captures: swap ordinary ancestor to a symlink with identical hook bytes.
  fs.renameSync(ordinary, path.join(parent, "ordinary-real"));
  fs.symlinkSync(path.join(parent, "ordinary-real"), ordinary);
  const afterSwap = captureContextManifest(root);
  assert.notEqual(
    afterSwap.git.taskRelevantMetadataIdentity,
    baseline.git.taskRelevantMetadataIdentity,
    "ordinary→symlink ancestor swap must change task-relevant identity"
  );
  assert.ok(observeChangedPaths(baseline, afterSwap).includes("[GIT_METADATA]"));

  // Restore ordinary directory for mid-capture race.
  fs.unlinkSync(ordinary);
  fs.renameSync(path.join(parent, "ordinary-real"), ordinary);
  const midBaseline = captureContextManifest(root);
  assert.equal(midBaseline.git.sharedRefIdentity.complete, true);

  const hooksReal = fs.realpathSync(hooksDir);
  const originalOpenSync = fs.openSync;
  let swappedDuringCapture = false;
  fs.openSync = function openSyncWithOrdinarySwap(file, ...rest) {
    const descriptor = originalOpenSync.call(this, file, ...rest);
    // After hop capture binds ordinary ancestors, content hashing opens hook files.
    if (!swappedDuringCapture && typeof file === "string" && path.basename(String(file)) === "pre-commit") {
      try {
        const openedHooksDir = fs.realpathSync(path.dirname(String(file)));
        if (openedHooksDir === hooksReal) {
          swappedDuringCapture = true;
          // Replace ordinary directory with a symlink to an alternate tree that has
          // identical hook bytes — type change must fail closed on revalidation.
          fs.renameSync(ordinary, path.join(parent, "ordinary-real"));
          fs.symlinkSync(altTree, ordinary);
          assert.equal(fs.lstatSync(ordinary).isSymbolicLink(), true);
        }
      } catch {
        // ignore path races in the harness matcher
      }
    }
    return descriptor;
  };
  try {
    const afterRace = captureContextManifest(root);
    assert.equal(swappedDuringCapture, true, "harness must swap ordinary ancestor mid-capture");
    assert.equal(
      afterRace.git.sharedRefIdentity.complete,
      false,
      "ordinary→symlink swap during capture must fail closed"
    );
    assert.equal(afterRace.git.sharedRefIdentity.attributable, false);
    assert.ok(observeChangedPaths(midBaseline, afterRace).includes("[GIT_METADATA]"));
    assert.equal(
      buildRuntimeEvidence({
        preContext: afterRace,
        postContext: afterRace,
        changedPaths: ["[GIT_METADATA]"]
      }).sharedRefObservation.classification,
      "fail_closed"
    );
    const evidence = JSON.stringify(buildRuntimeEvidence({
      preContext: midBaseline,
      postContext: afterRace,
      changedPaths: ["[GIT_METADATA]"]
    }));
    assert.equal(evidence.includes(ordinary), false);
    assert.equal(evidence.includes(hooksDir), false);
    assert.equal(evidence.includes("ordinary-stable"), false);
  } finally {
    fs.openSync = originalOpenSync;
    try {
      if (fs.lstatSync(ordinary).isSymbolicLink()) {
        fs.unlinkSync(ordinary);
        fs.renameSync(path.join(parent, "ordinary-real"), ordinary);
      }
    } catch {
      // best-effort restore
    }
  }
});

test("lexical ancestor unrelated sibling create/change/remove keeps stable hooks identity (issue #34)", () => {
  // Host repro: absolute core.hooksPath under a temp parent; create/change/remove
  // an unrelated sibling beside the hooks directory under an ordinary lexical
  // ancestor. Captures stay complete and identity-equal — sibling nlink/mtime
  // on the ancestor must not enter cross-capture hooks identity.
  const root = initRepo();
  const parent = fs.realpathSync(tempDir("grok-plugin-lexical-sibling-"));
  const ordinary = path.join(parent, "ordinary");
  const hooksDir = path.join(ordinary, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookBody = "#!/bin/sh\necho sibling-stable\nexit 0\n";
  fs.writeFileSync(path.join(hooksDir, "pre-commit"), hookBody, { mode: 0o755 });
  git(root, "config", "core.hooksPath", hooksDir);

  const baseline = captureContextManifest(root);
  assert.equal(baseline.git.sharedRefIdentity.complete, true);
  assert.match(baseline.git.taskRelevantMetadataIdentity, /^[a-f0-9]{64}$/);
  const baselineIdentity = baseline.git.taskRelevantMetadataIdentity;

  // Create an unrelated sibling directory beside hooks under the ordinary ancestor.
  const sibling = path.join(ordinary, "unrelated-sibling");
  fs.mkdirSync(sibling);
  const afterCreate = captureContextManifest(root);
  assert.equal(afterCreate.git.sharedRefIdentity.complete, true);
  assert.equal(
    afterCreate.git.taskRelevantMetadataIdentity,
    baselineIdentity,
    "unrelated sibling create under lexical ancestor must not change hooks identity"
  );
  assert.equal(
    observeChangedPaths(baseline, afterCreate).includes("[GIT_METADATA]"),
    false,
    "unrelated sibling create must not emit GIT_METADATA"
  );

  // Mutate sibling contents (file create under sibling).
  fs.writeFileSync(path.join(sibling, "noise.txt"), "noise-v1\n", "utf8");
  const afterChange = captureContextManifest(root);
  assert.equal(afterChange.git.sharedRefIdentity.complete, true);
  assert.equal(
    afterChange.git.taskRelevantMetadataIdentity,
    baselineIdentity,
    "unrelated sibling content change under lexical ancestor must not change hooks identity"
  );
  assert.equal(
    observeChangedPaths(baseline, afterChange).includes("[GIT_METADATA]"),
    false,
    "unrelated sibling change must not emit GIT_METADATA"
  );
  assert.equal(
    observeChangedPaths(afterCreate, afterChange).includes("[GIT_METADATA]"),
    false
  );

  // Remove the unrelated sibling entirely.
  fs.rmSync(sibling, { recursive: true, force: true });
  const afterRemove = captureContextManifest(root);
  assert.equal(afterRemove.git.sharedRefIdentity.complete, true);
  assert.equal(
    afterRemove.git.taskRelevantMetadataIdentity,
    baselineIdentity,
    "unrelated sibling remove under lexical ancestor must not change hooks identity"
  );
  assert.equal(
    observeChangedPaths(baseline, afterRemove).includes("[GIT_METADATA]"),
    false,
    "unrelated sibling remove must not emit GIT_METADATA"
  );
  assert.equal(
    observeChangedPaths(afterChange, afterRemove).includes("[GIT_METADATA]"),
    false
  );

  // Stable re-capture after the full create/change/remove cycle.
  const stableAgain = captureContextManifest(root);
  assert.equal(stableAgain.git.taskRelevantMetadataIdentity, baselineIdentity);

  // Public/runtime evidence must not leak absolute paths or hook contents.
  const evidence = JSON.stringify(buildRuntimeEvidence({
    preContext: baseline,
    postContext: afterRemove,
    changedPaths: []
  }));
  assert.equal(evidence.includes(parent), false);
  assert.equal(evidence.includes(ordinary), false);
  assert.equal(evidence.includes(hooksDir), false);
  assert.equal(evidence.includes(sibling), false);
  assert.equal(evidence.includes("unrelated-sibling"), false);
  assert.equal(evidence.includes("sibling-stable"), false);
  assert.equal(evidence.includes("noise-v1"), false);
});

test("same-capture lexical ancestor unrelated sibling activity keeps complete hooks identity (issue #34)", () => {
  // Parallel four-file suite volatility: unrelated sibling nlink/mtime/ctime
  // under a lexical hooks ancestor during the same capture must not mark the
  // inventory incomplete. Inject on the second lstat of a unique ordinary
  // ancestor (revalidation), after hop capture bound stable dev/ino/mode.
  const root = initRepo();
  const parent = fs.realpathSync(tempDir("grok-plugin-same-capture-sibling-"));
  const ordinary = path.join(parent, "ordinary");
  const hooksDir = path.join(ordinary, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookBody = "#!/bin/sh\necho same-capture-stable\nexit 0\n";
  fs.writeFileSync(path.join(hooksDir, "pre-commit"), hookBody, { mode: 0o755 });
  git(root, "config", "core.hooksPath", hooksDir);

  const baseline = captureContextManifest(root);
  assert.equal(baseline.git.sharedRefIdentity.complete, true);
  assert.equal(baseline.git.sharedRefIdentity.attributable, true);
  assert.match(baseline.git.taskRelevantMetadataIdentity, /^[a-f0-9]{64}$/);
  const baselineIdentity = baseline.git.taskRelevantMetadataIdentity;

  const ordinaryResolved = path.resolve(ordinary);
  const sibling = path.join(ordinary, "same-capture-unrelated-sibling");
  const originalLstatSync = fs.lstatSync;
  let ordinaryLstatCount = 0;
  let injected = false;
  fs.lstatSync = function lstatSyncWithSameCaptureSibling(file, ...rest) {
    if (typeof file === "string" && path.resolve(file) === ordinaryResolved) {
      ordinaryLstatCount += 1;
      // Second lstat is lexical revalidation after content capture.
      if (ordinaryLstatCount === 2 && !injected) {
        injected = true;
        fs.mkdirSync(sibling, { recursive: true });
        fs.writeFileSync(path.join(sibling, "noise.txt"), "same-capture-noise\n", "utf8");
        fs.rmSync(sibling, { recursive: true, force: true });
      }
    }
    return originalLstatSync.call(this, file, ...rest);
  };
  try {
    const during = captureContextManifest(root);
    assert.equal(injected, true, "harness must inject unrelated sibling on second ordinary lstat");
    assert.ok(ordinaryLstatCount >= 2, "ordinary ancestor must be lstat'd at capture and revalidation");
    assert.equal(during.git.sharedRefIdentity.complete, true);
    assert.equal(during.git.sharedRefIdentity.attributable, true);
    assert.equal(
      during.git.taskRelevantMetadataIdentity,
      baselineIdentity,
      "same-capture unrelated sibling activity must not change task-relevant identity"
    );
    assert.equal(
      observeChangedPaths(baseline, during).includes("[GIT_METADATA]"),
      false,
      "same-capture unrelated sibling activity must not emit GIT_METADATA"
    );
    const evidence = JSON.stringify(buildRuntimeEvidence({
      preContext: baseline,
      postContext: during,
      changedPaths: []
    }));
    assert.equal(evidence.includes(ordinary), false);
    assert.equal(evidence.includes(sibling), false);
    assert.equal(evidence.includes("same-capture-unrelated-sibling"), false);
    assert.equal(evidence.includes("same-capture-noise"), false);
  } finally {
    fs.lstatSync = originalLstatSync;
    try {
      fs.rmSync(sibling, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

test("oversize reftable marker and loose ref bodies fail closed with bounded reads (issue #34 AC-4)", () => {
  const root = initRepo();
  const head = git(root, "rev-parse", "HEAD");
  const baseline = captureContextManifest(root);
  assert.equal(baseline.git.sharedRefIdentity.complete, true);

  const originalOpenSync = fs.openSync;
  const originalReadSync = fs.readSync;
  const originalReadFileSync = fs.readFileSync;
  const originalCloseSync = fs.closeSync;
  let sawNofollowOpen = false;
  let readFileSyncOnRefs = false;
  /** @type {number[]} */
  const trackedReadLengths = [];
  /** @type {{ base: string, lengths: number[] }[]} */
  const trackedReadSequences = [];
  // Realpath so /var vs /private/var open paths still match on macOS.
  const refsRoot = fs.realpathSync(path.join(root, ".git", "refs"));
  /** @type {Map<number, string>} */
  const trackedFds = new Map();
  const trackedNames = new Set([
    ".broken-bounded-body",
    ".oversize-loose-body",
    ".oversize-marker-plant",
    "heads"
  ]);
  const explicitlyTrackedPaths = new Set();

  const underRefs = (file) => {
    if (typeof file !== "string" || !file) return false;
    try {
      const resolved = fs.realpathSync(path.resolve(String(file)));
      return resolved === refsRoot || resolved.startsWith(`${refsRoot}${path.sep}`);
    } catch {
      try {
        const resolved = path.resolve(String(file));
        return resolved === refsRoot || resolved.startsWith(`${refsRoot}${path.sep}`);
      } catch {
        return false;
      }
    }
  };
  const trackBase = (file) => {
    const base = path.basename(String(file));
    return trackedNames.has(base) ? base : null;
  };
  const explicitlyTracked = (file) => {
    if (typeof file !== "string" || !file) return false;
    try {
      return explicitlyTrackedPaths.has(path.resolve(String(file)));
    } catch {
      return false;
    }
  };
  const trackedPlant = (file) => (
    trackBase(file) != null && (underRefs(file) || explicitlyTracked(file))
  );
  const assertCappedProbe = (label) => {
    const boundedSequences = trackedReadSequences.filter(
      (sequence) => sequence.lengths.includes(513)
        && sequence.lengths.every(
          (want) => Number.isSafeInteger(want) && want > 0 && want <= 513
        )
    );
    assert.ok(
      boundedSequences.length > 0,
      `${label} must use a descriptor whose reads are capped at accepted body limit + 1 (513), got ${JSON.stringify(trackedReadSequences)}`
    );
  };

  fs.openSync = function openSyncTrackNofollow(file, flags, ...rest) {
    const fd = originalOpenSync.call(this, file, flags, ...rest);
    const base = trackedPlant(file) ? trackBase(file) : null;
    if (base) {
      const sequence = { base, lengths: [] };
      trackedFds.set(fd, sequence);
      trackedReadSequences.push(sequence);
      if (typeof flags === "number") {
        const nofollow = fs.constants.O_NOFOLLOW || 0;
        if (nofollow === 0 || (flags & nofollow) === nofollow) {
          sawNofollowOpen = true;
        }
      }
    }
    return fd;
  };
  fs.readSync = function readSyncTrackBound(fd, buffer, offset, length, position) {
    // Record every readSync want for tracked plant files. Production bounded
    // validation requests at most accepted-body+1 (513) per read.
    const sequence = trackedFds.get(fd);
    if (sequence && Number.isSafeInteger(length)) {
      trackedReadLengths.push(length);
      sequence.lengths.push(length);
    }
    return originalReadSync.call(this, fd, buffer, offset, length, position);
  };
  fs.closeSync = function closeSyncForgetTracked(fd) {
    trackedFds.delete(fd);
    return originalCloseSync.call(this, fd);
  };
  fs.readFileSync = function readFileSyncGuard(file, ...rest) {
    if (underRefs(file) || explicitlyTracked(file)) {
      readFileSyncOnRefs = true;
    }
    return originalReadFileSync.call(this, file, ...rest);
  };

  try {
    // Within-bound broken loose body: production capped path probes limit+1.
    // Dot-prefixed loose candidates are ignored by Git's semantic inventory,
    // so the bounded loose-tree validator deterministically owns this read.
    const brokenLoose = path.join(refsRoot, "heads", ".broken-bounded-body");
    fs.writeFileSync(brokenLoose, `${"b".repeat(400)}\n`);
    trackedReadLengths.length = 0;
    trackedReadSequences.length = 0;
    sawNofollowOpen = false;
    const afterBroken = captureContextManifest(root);
    assert.equal(afterBroken.git.sharedRefIdentity.complete, false);
    assert.equal(readFileSyncOnRefs, false);
    assertCappedProbe("bounded loose-ref validation");
    if (fs.constants.O_NOFOLLOW) {
      assert.equal(sawNofollowOpen, true, "loose ref open must request O_NOFOLLOW when available");
    }
    fs.unlinkSync(brokenLoose);

    // Oversized loose ref body — fail closed; production still probes at most
    // accepted+1 bytes (never unbounded readFileSync of the whole body).
    readFileSyncOnRefs = false;
    trackedReadLengths.length = 0;
    trackedReadSequences.length = 0;
    sawNofollowOpen = false;
    const oversizeLoose = path.join(refsRoot, "heads", ".oversize-loose-body");
    const oversizePrivateMarker = "oversize-private-body-marker";
    const oversizeBody = `${oversizePrivateMarker}${"a".repeat(600)}\n`;
    assert.ok(Buffer.byteLength(oversizeBody, "utf8") > 512);
    fs.writeFileSync(oversizeLoose, oversizeBody);
    const afterLoose = captureContextManifest(root);
    assert.equal(afterLoose.git.sharedRefIdentity.complete, false);
    assert.equal(afterLoose.git.sharedRefIdentity.attributable, false);
    assert.ok(observeChangedPaths(baseline, afterLoose).includes("[GIT_METADATA]"));
    assert.equal(
      buildRuntimeEvidence({
        preContext: afterLoose,
        postContext: afterLoose,
        changedPaths: ["[GIT_METADATA]"]
      }).sharedRefObservation.classification,
      "fail_closed"
    );
    assert.equal(
      readFileSyncOnRefs,
      false,
      "loose ref validation must not use unbounded readFileSync under refs/"
    );
    assertCappedProbe("oversize loose ref");
    if (fs.constants.O_NOFOLLOW) {
      assert.equal(sawNofollowOpen, true);
    }
    fs.unlinkSync(oversizeLoose);

    // Reftable-shaped oversize marker plant on files backend also fails closed.
    readFileSyncOnRefs = false;
    trackedReadLengths.length = 0;
    trackedReadSequences.length = 0;
    sawNofollowOpen = false;
    const oversizeMarker = path.join(refsRoot, "tags", ".oversize-marker-plant");
    fs.mkdirSync(path.dirname(oversizeMarker), { recursive: true });
    fs.writeFileSync(oversizeMarker, `${"this repository uses the reftable format\n"}${"x".repeat(600)}`);
    const afterMarker = captureContextManifest(root);
    assert.equal(afterMarker.git.sharedRefIdentity.complete, false);
    assert.equal(readFileSyncOnRefs, false);
    assertCappedProbe("files-backend marker plant");
    fs.unlinkSync(oversizeMarker);

    // Real reftable backend: oversize refs/heads marker must fail closed with a
    // capped probe (accepted body limit + 1).
    const reftableRoot = tempDir("grok-plugin-reftable-oversize-");
    const reftableInit = run("git", ["init", "-b", "main", "--ref-format=reftable"], {
      cwd: reftableRoot
    });
    if (reftableInit.status === 0) {
      git(reftableRoot, "config", "user.email", "tests@example.com");
      git(reftableRoot, "config", "user.name", "Grok Plugin Tests");
      fs.writeFileSync(path.join(reftableRoot, "tracked.txt"), "original\n", "utf8");
      git(reftableRoot, "add", "tracked.txt");
      git(reftableRoot, "commit", "-m", "initial");
      const reftableBefore = captureContextManifest(reftableRoot);
      assert.equal(reftableBefore.git.sharedRefIdentity.complete, true);
      const commonDir = String(git(reftableRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"));
      const markerPath = path.join(commonDir, "refs", "heads");
      try { fs.rmSync(markerPath, { recursive: true, force: true }); } catch { /* ignore */ }
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, `${"z".repeat(600)}\n`);
      explicitlyTrackedPaths.add(path.resolve(markerPath));
      // Track reftable marker opens via basename "heads".
      trackedReadLengths.length = 0;
      trackedReadSequences.length = 0;
      sawNofollowOpen = false;
      readFileSyncOnRefs = false;
      const reftableAfter = captureContextManifest(reftableRoot);
      assert.equal(
        reftableAfter.git.sharedRefIdentity.complete,
        false,
        "oversize reftable compatibility marker must fail closed"
      );
      // realpath of reftable common dir may differ; still require fail-closed.
      assert.equal(reftableAfter.git.sharedRefIdentity.attributable, false);
      assert.equal(
        readFileSyncOnRefs,
        false,
        "reftable marker validation must not use unbounded readFileSync"
      );
      assertCappedProbe("oversize reftable compatibility marker");
      if (fs.constants.O_NOFOLLOW) {
        assert.equal(sawNofollowOpen, true);
      }
    }

    const evidence = JSON.stringify(buildRuntimeEvidence({
      preContext: baseline,
      postContext: afterLoose,
      changedPaths: ["[GIT_METADATA]"]
    }));
    assert.equal(evidence.includes(oversizeLoose), false);
    assert.equal(evidence.includes("oversize-loose-body"), false);
    assert.equal(evidence.includes(oversizePrivateMarker), false);
  } finally {
    fs.openSync = originalOpenSync;
    fs.readSync = originalReadSync;
    fs.readFileSync = originalReadFileSync;
    fs.closeSync = originalCloseSync;
  }
});

test("long private ref names stay distinct without self-observation false drift (issue #34 AC-5)", () => {
  const root = initRepo();
  const head = git(root, "rev-parse", "HEAD");
  // Two valid refs longer than 256 bytes that share a 256-byte prefix.
  // Nested components stay under common NAME_MAX (255) while full names exceed 256.
  const mid = "n".repeat(200);
  const leaf = "m".repeat(50);
  const nameA = `refs/heads/long/${mid}/${leaf}-alpha`;
  const nameB = `refs/heads/long/${mid}/${leaf}-bravo`;
  assert.ok(nameA.length > 256, `nameA length ${nameA.length}`);
  assert.ok(nameB.length > 256, `nameB length ${nameB.length}`);
  assert.equal(nameA.slice(0, 256), nameB.slice(0, 256));
  assert.notEqual(nameA, nameB);
  assert.ok(nameA.length <= 512);
  assert.ok(nameB.length <= 512);
  for (const part of nameA.split("/").concat(nameB.split("/"))) {
    assert.ok(part.length <= 255, `path component too long for loose refs: ${part.length}`);
  }

  git(root, "update-ref", nameA, head);
  git(root, "update-ref", nameB, head);

  const first = captureContextManifest(root);
  assert.equal(first.git.sharedRefIdentity.complete, true);
  assert.equal(first.git.sharedRefIdentity.attributable, true);
  const taskRefs = first.git.sharedRefIdentity.taskRelevantRefs || [];
  const unrelatedRefs = first.git.sharedRefIdentity.unrelatedRefs || [];
  const allRefs = [...taskRefs, ...unrelatedRefs];
  const retainedNames = allRefs.map((entry) => entry.name);
  assert.ok(retainedNames.includes(nameA), "private evidence must retain full name A");
  assert.ok(retainedNames.includes(nameB), "private evidence must retain full name B");
  assert.equal(new Set(retainedNames).size, retainedNames.length, "long names must remain distinct");

  // Unchanged worktree: second capture must not report GIT_METADATA drift.
  const second = captureContextManifest(root);
  assert.equal(second.git.sharedRefIdentity.complete, true);
  assert.equal(
    second.git.taskRelevantMetadataIdentity,
    first.git.taskRelevantMetadataIdentity
  );
  assert.equal(
    second.git.sharedRefIdentity.taskRelevantRefIdentity,
    first.git.sharedRefIdentity.taskRelevantRefIdentity
  );
  assert.equal(
    second.git.sharedRefIdentity.unrelatedRefIdentity,
    first.git.sharedRefIdentity.unrelatedRefIdentity
  );
  assert.equal(observeChangedPaths(first, second).includes("[GIT_METADATA]"), false);
  assert.doesNotThrow(() => assertContextCompatible(root, first, { mode: "execute" }));
  assert.equal(
    buildRuntimeEvidence({
      preContext: first,
      postContext: second,
      changedPaths: []
    }).sharedRefObservation.classification,
    "unchanged"
  );

  // Public runtime projection must not leak private ref arrays.
  const evidence = JSON.stringify(buildRuntimeEvidence({
    preContext: first,
    postContext: second,
    changedPaths: []
  }));
  assert.equal(evidence.includes("taskRelevantRefs"), false);
  assert.equal(evidence.includes("unrelatedRefs"), false);
  assert.equal(evidence.includes(nameA), false);
  assert.equal(evidence.includes(nameB), false);
  assert.equal(evidence.includes(`refs/heads/long/${mid}`), false);
});

test("MERGE_RR create/change/remove is task-relevant operational drift (issue #34)", () => {
  const root = initRepo();
  const linkedParent = tempDir("grok-plugin-merge-rr-");
  const linkedRoot = path.join(linkedParent, "checkout");
  git(root, "worktree", "add", "-b", "merge-rr", linkedRoot);
  const gitDirPath = String(git(linkedRoot, "rev-parse", "--git-dir"));
  const absoluteGitDir = path.resolve(linkedRoot, gitDirPath);
  const mergeRrPath = path.join(absoluteGitDir, "MERGE_RR");

  const before = captureContextManifest(linkedRoot);
  assert.equal(before.git.sharedRefIdentity.complete, true);
  fs.writeFileSync(mergeRrPath, "path 1\ntracked.txt\n");
  const afterCreate = captureContextManifest(linkedRoot);
  assert.notEqual(
    afterCreate.git.taskRelevantMetadataIdentity,
    before.git.taskRelevantMetadataIdentity,
    "creating MERGE_RR must change task-relevant identity"
  );
  assert.ok(observeChangedPaths(before, afterCreate).includes("[GIT_METADATA]"));
  assert.equal(
    buildRuntimeEvidence({
      preContext: before,
      postContext: afterCreate,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "task_relevant_metadata_drift"
  );

  fs.writeFileSync(mergeRrPath, "path 1\nother.txt\n");
  const afterChange = captureContextManifest(linkedRoot);
  assert.notEqual(
    afterChange.git.taskRelevantMetadataIdentity,
    afterCreate.git.taskRelevantMetadataIdentity
  );

  fs.unlinkSync(mergeRrPath);
  const afterRemove = captureContextManifest(linkedRoot);
  assert.equal(
    afterRemove.git.taskRelevantMetadataIdentity,
    before.git.taskRelevantMetadataIdentity
  );
  const evidence = JSON.stringify(buildRuntimeEvidence({
    preContext: before,
    postContext: afterCreate,
    changedPaths: ["[GIT_METADATA]"]
  }));
  assert.equal(evidence.includes(mergeRrPath), false);
  assert.equal(evidence.includes("MERGE_RR"), false);
  assert.equal(evidence.includes("tracked.txt"), false);
});

test("primary complete-but-unattributable identical manifests pass strict compare (issue #34)", () => {
  const root = initRepo();
  const head = git(root, "rev-parse", "HEAD");
  // Create >2000 and <=10000 refs so complete=true, attributable=false.
  const target = 2001;
  for (let index = 0; index < target; index += 1) {
    git(root, "update-ref", `refs/heads/bulk-${String(index).padStart(4, "0")}`, head);
  }
  const first = captureContextManifest(root);
  assert.equal(first.git.linkedWorktree, false);
  assert.equal(first.git.sharedRefIdentity.complete, true);
  assert.equal(first.git.sharedRefIdentity.attributable, false);
  assert.ok(first.git.sharedRefIdentity.refCount > 2000);
  assert.ok(first.git.sharedRefIdentity.refCount <= 10_000);
  const second = captureContextManifest(root);
  assert.equal(
    second.git.taskRelevantMetadataIdentity,
    first.git.taskRelevantMetadataIdentity
  );
  assert.equal(second.git.metadataIdentity, first.git.metadataIdentity);
  assert.equal(
    second.git.sharedRefIdentity.unrelatedRefIdentity,
    first.git.sharedRefIdentity.unrelatedRefIdentity
  );
  assert.equal(observeChangedPaths(first, second).includes("[GIT_METADATA]"), false);
  assert.doesNotThrow(() => assertContextCompatible(root, first, { mode: "execute" }));
  assert.doesNotThrow(() => assertContextCompatible(root, first, { mode: "resume" }));

  // Any primary ref identity drift still fails.
  git(root, "update-ref", "refs/heads/bulk-extra", head);
  const afterDrift = captureContextManifest(root);
  assert.ok(observeChangedPaths(first, afterDrift).includes("[GIT_METADATA]"));
  assert.throws(
    () => assertContextCompatible(root, first, { mode: "execute" }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
  );

  // Linked tolerance still requires attribution.
  const linkedParent = tempDir("grok-plugin-primary-unattr-linked-");
  const linkedRoot = path.join(linkedParent, "checkout");
  git(root, "worktree", "add", "-b", "unattr-linked", linkedRoot);
  const linkedManifest = captureContextManifest(linkedRoot);
  assert.equal(linkedManifest.git.linkedWorktree, true);
  assert.equal(linkedManifest.git.sharedRefIdentity.complete, true);
  assert.equal(linkedManifest.git.sharedRefIdentity.attributable, false);
  assert.equal(
    buildRuntimeEvidence({
      preContext: linkedManifest,
      postContext: linkedManifest,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "fail_closed"
  );
});

test("assume-unchanged and skip-worktree cannot hide out-of-scope tracked overwrites (issue #34)", () => {
  const root = initRepo();
  fs.writeFileSync(path.join(root, "outside.txt"), "outside-v1\n");
  git(root, "add", "outside.txt");
  git(root, "commit", "-m", "add outside");

  // --- assume-unchanged: pre-flag then overwrite must be observed ---
  git(root, "update-index", "--assume-unchanged", "outside.txt");
  const beforeAssume = captureContextManifest(root);
  assert.equal(beforeAssume.git.sharedRefIdentity.complete, true);
  fs.writeFileSync(path.join(root, "outside.txt"), "outside-SECRET-overwrite\n");
  // status / ls-files --stage alone would miss this; capture must not.
  const afterAssume = captureContextManifest(root);
  assert.notEqual(
    afterAssume.git.taskRelevantMetadataIdentity,
    beforeAssume.git.taskRelevantMetadataIdentity,
    "assume-unchanged overwrite must change task-relevant identity"
  );
  const assumeObserved = observeChangedPaths(beforeAssume, afterAssume);
  assert.ok(
    assumeObserved.length > 0,
    "assume-unchanged overwrite must surface in observeChangedPaths"
  );
  assert.throws(
    () => assertContextCompatible(root, beforeAssume, { mode: "execute" }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
  );
  const assumeEvidence = JSON.stringify(buildRuntimeEvidence({
    preContext: beforeAssume,
    postContext: afterAssume,
    changedPaths: assumeObserved
  }));
  assert.equal(assumeEvidence.includes("outside-SECRET-overwrite"), false);

  fs.unlinkSync(path.join(root, "outside.txt"));
  const absentAssume = captureContextManifest(root);
  assert.equal(
    absentAssume.git.sharedRefIdentity.complete,
    false,
    "an absent assume-unchanged path is not a legitimate sparse absence"
  );
  assert.equal(absentAssume.git.sharedRefIdentity.attributable, false);

  // Restore content and clear assume-unchanged for skip-worktree case.
  fs.writeFileSync(path.join(root, "outside.txt"), "outside-v1\n");
  git(root, "update-index", "--no-assume-unchanged", "outside.txt");

  // --- skip-worktree: pre-flag then overwrite must be observed ---
  git(root, "update-index", "--skip-worktree", "outside.txt");
  const beforeSkip = captureContextManifest(root);
  fs.writeFileSync(path.join(root, "outside.txt"), "skip-SECRET-overwrite\n");
  const afterSkip = captureContextManifest(root);
  assert.notEqual(
    afterSkip.git.taskRelevantMetadataIdentity,
    beforeSkip.git.taskRelevantMetadataIdentity,
    "skip-worktree overwrite must change task-relevant identity"
  );
  assert.ok(observeChangedPaths(beforeSkip, afterSkip).length > 0);
  const skipEvidence = JSON.stringify(buildRuntimeEvidence({
    preContext: beforeSkip,
    postContext: afterSkip,
    changedPaths: ["[GIT_METADATA]"]
  }));
  assert.equal(skipEvidence.includes("skip-SECRET-overwrite"), false);
  git(root, "update-index", "--no-skip-worktree", "outside.txt");

  if (process.platform !== "win32") {
    git(root, "config", "core.filemode", "true");
    fs.writeFileSync(path.join(root, "outside.txt"), "outside-v1\n");
    fs.chmodSync(path.join(root, "outside.txt"), 0o644);
    for (const [enable, disable] of [
      ["--assume-unchanged", "--no-assume-unchanged"],
      ["--skip-worktree", "--no-skip-worktree"]
    ]) {
      git(root, "update-index", enable, "outside.txt");
      const beforeMode = captureContextManifest(root);
      assert.equal(beforeMode.git.sharedRefIdentity.complete, true);
      fs.chmodSync(path.join(root, "outside.txt"), 0o755);
      const afterMode = captureContextManifest(root);
      assert.notEqual(
        afterMode.git.taskRelevantMetadataIdentity,
        beforeMode.git.taskRelevantMetadataIdentity,
        `${enable} must not hide a descriptor-validated worktree chmod`
      );
      assert.ok(
        observeChangedPaths(beforeMode, afterMode).includes("[GIT_METADATA]")
      );
      assert.throws(
        () => assertContextCompatible(root, beforeMode, { mode: "execute" }),
        (error) => error?.code === "E_CONTEXT_DRIFT"
      );
      fs.chmodSync(path.join(root, "outside.txt"), 0o644);
      git(root, "update-index", disable, "outside.txt");
    }
  }

  // --- Legitimate sparse-checkout still completes without fail-closed ---
  const sparseRoot = initRepo();
  fs.mkdirSync(path.join(sparseRoot, "keep"), { recursive: true });
  fs.mkdirSync(path.join(sparseRoot, "drop"), { recursive: true });
  fs.writeFileSync(path.join(sparseRoot, "keep", "k.txt"), "k\n");
  fs.writeFileSync(path.join(sparseRoot, "drop", "d.txt"), "d\n");
  git(sparseRoot, "add", "keep", "drop");
  git(sparseRoot, "commit", "-m", "sparse trees");
  git(sparseRoot, "sparse-checkout", "init", "--cone");
  git(sparseRoot, "sparse-checkout", "set", "keep");
  const sparseManifest = captureContextManifest(sparseRoot);
  assert.equal(sparseManifest.git.sparse, true);
  assert.equal(sparseManifest.git.sharedRefIdentity.complete, true);
  assert.match(sparseManifest.git.taskRelevantMetadataIdentity, /^[a-f0-9]{64}$/);
  const sparseAgain = captureContextManifest(sparseRoot);
  assert.equal(
    sparseAgain.git.taskRelevantMetadataIdentity,
    sparseManifest.git.taskRelevantMetadataIdentity
  );
});

test("flagged gitlink commit movement and dirty contents fail closed (issue #34)", () => {
  const root = initRepo();
  const submoduleRoot = path.join(root, "deps", "sub");
  fs.mkdirSync(submoduleRoot, { recursive: true });
  git(submoduleRoot, "init", "-b", "main");
  git(submoduleRoot, "config", "user.email", "tests@example.com");
  git(submoduleRoot, "config", "user.name", "Grok Plugin Tests");
  fs.writeFileSync(path.join(submoduleRoot, "nested.txt"), "nested-v1\n", "utf8");
  git(submoduleRoot, "add", "nested.txt");
  git(submoduleRoot, "commit", "-m", "nested initial");
  const nestedHead = git(submoduleRoot, "rev-parse", "HEAD");

  git(
    root,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${nestedHead},deps/sub`
  );
  git(root, "commit", "-m", "add gitlink");
  git(root, "update-index", "--assume-unchanged", "deps/sub");

  const initial = captureContextManifest(root);
  assert.equal(initial.git.sharedRefIdentity.complete, false);
  assert.equal(initial.git.sharedRefIdentity.attributable, false);
  assert.throws(
    () => assertContextCompatible(root, initial, { mode: "execute" }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
      || error?.code === "E_CONTEXT_INCOMPLETE"
  );

  fs.writeFileSync(path.join(submoduleRoot, "nested.txt"), "nested-v2\n", "utf8");
  git(submoduleRoot, "add", "nested.txt");
  git(submoduleRoot, "commit", "-m", "nested advance");
  const moved = captureContextManifest(root);
  assert.equal(moved.git.sharedRefIdentity.complete, false);
  assert.equal(moved.git.sharedRefIdentity.attributable, false);
  assert.throws(
    () => assertContextCompatible(root, moved, { mode: "execute" }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
      || error?.code === "E_CONTEXT_INCOMPLETE"
  );

  fs.writeFileSync(path.join(submoduleRoot, "nested.txt"), "nested-dirty\n", "utf8");
  const dirty = captureContextManifest(root);
  assert.equal(dirty.git.sharedRefIdentity.complete, false);
  assert.equal(dirty.git.sharedRefIdentity.attributable, false);
  assert.throws(
    () => assertContextCompatible(root, dirty, { mode: "execute" }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
      || error?.code === "E_CONTEXT_INCOMPLETE"
  );
});

test("flagged symlink retarget during read fails closed (issue #34)", {
  skip: process.platform === "win32"
}, () => {
  const root = initRepo();
  const linkPath = path.join(root, "flagged-link");
  const canonicalLinkPath = path.join(fs.realpathSync(root), "flagged-link");
  fs.symlinkSync("target-a", linkPath);
  git(root, "add", "flagged-link");
  git(root, "commit", "-m", "add flagged symlink");
  git(root, "update-index", "--assume-unchanged", "flagged-link");

  const stable = captureContextManifest(root);
  assert.equal(stable.git.sharedRefIdentity.complete, true);
  const originalReadlinkSync = fs.readlinkSync;
  let retargeted = false;
  fs.readlinkSync = function racedReadlink(candidate, ...args) {
    const result = originalReadlinkSync.call(fs, candidate, ...args);
    if (!retargeted && path.resolve(String(candidate)) === canonicalLinkPath) {
      fs.unlinkSync(candidate);
      fs.symlinkSync("target-b", candidate);
      retargeted = true;
    }
    return result;
  };
  let raced;
  try {
    raced = captureContextManifest(root);
  } finally {
    fs.readlinkSync = originalReadlinkSync;
  }
  assert.equal(retargeted, true);
  assert.equal(raced.git.sharedRefIdentity.complete, false);
  assert.equal(raced.git.sharedRefIdentity.attributable, false);
  assert.throws(
    () => assertContextCompatible(root, stable, { mode: "execute" }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
  );
});

test("operational and non-ref symlink target contents bind identity (issue #34 AC-3/AC-4)", () => {
  const root = initRepo();
  const head = git(root, "rev-parse", "HEAD");
  const external = tempDir("grok-plugin-meta-symlink-");

  // --- Non-ref: config is a symlink; mutate target without changing link text ---
  const configPath = path.join(root, ".git", "config");
  const configBody = path.join(external, "config-body");
  const originalConfig = fs.readFileSync(configPath);
  fs.writeFileSync(configBody, originalConfig);
  fs.unlinkSync(configPath);
  fs.symlinkSync(configBody, configPath);

  const beforeConfigTarget = captureContextManifest(root);
  assert.equal(beforeConfigTarget.git.sharedRefIdentity.complete, true);
  fs.appendFileSync(configBody, "\n[grok-companion-symlink-cfg]\n\tvalue = mutated\n");
  const afterConfigTarget = captureContextManifest(root);
  assert.notEqual(
    afterConfigTarget.git.taskRelevantMetadataIdentity,
    beforeConfigTarget.git.taskRelevantMetadataIdentity,
    "mutating non-ref config symlink target must change task-relevant identity"
  );
  assert.ok(observeChangedPaths(beforeConfigTarget, afterConfigTarget).includes("[GIT_METADATA]"));
  assert.equal(
    buildRuntimeEvidence({
      preContext: beforeConfigTarget,
      postContext: afterConfigTarget,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "task_relevant_metadata_drift"
  );
  assert.equal(JSON.stringify(buildRuntimeEvidence({
    preContext: beforeConfigTarget,
    postContext: afterConfigTarget,
    changedPaths: ["[GIT_METADATA]"]
  })).includes(configBody), false);

  // Restore a real config file for remaining controls.
  fs.unlinkSync(configPath);
  fs.writeFileSync(configPath, fs.readFileSync(configBody));

  // --- Operational: MERGE_HEAD is a symlink; mutate target contents ---
  const mergeTarget = path.join(external, "merge-head-body");
  fs.writeFileSync(mergeTarget, `${head}\n`);
  const gitDir = path.join(root, ".git");
  fs.symlinkSync(mergeTarget, path.join(gitDir, "MERGE_HEAD"));
  const beforeOpTarget = captureContextManifest(root);
  const tree = git(root, "rev-parse", `${head}^{tree}`);
  const other = git(root, "commit-tree", tree, "-m", "merge target other");
  fs.writeFileSync(mergeTarget, `${other}\n`);
  const afterOpTarget = captureContextManifest(root);
  assert.notEqual(
    afterOpTarget.git.taskRelevantMetadataIdentity,
    beforeOpTarget.git.taskRelevantMetadataIdentity,
    "mutating operational symlink target must change task-relevant identity"
  );
  assert.ok(observeChangedPaths(beforeOpTarget, afterOpTarget).includes("[GIT_METADATA]"));
  assert.equal(JSON.stringify(buildRuntimeEvidence({
    preContext: beforeOpTarget,
    postContext: afterOpTarget,
    changedPaths: ["[GIT_METADATA]"]
  })).includes(mergeTarget), false);
  fs.unlinkSync(path.join(gitDir, "MERGE_HEAD"));

  // --- Operational directory symlink: mutate child behind unchanged link text ---
  const realSequencer = path.join(external, "sequencer-real");
  fs.mkdirSync(realSequencer, { recursive: true });
  fs.writeFileSync(path.join(realSequencer, "todo"), "pick aaa\n");
  fs.symlinkSync(realSequencer, path.join(gitDir, "sequencer"));
  const beforeSeq = captureContextManifest(root);
  fs.writeFileSync(path.join(realSequencer, "todo"), "pick bbb\n");
  const afterSeq = captureContextManifest(root);
  assert.notEqual(
    afterSeq.git.taskRelevantMetadataIdentity,
    beforeSeq.git.taskRelevantMetadataIdentity,
    "mutating contents behind operational directory symlink must drift"
  );
  assert.ok(observeChangedPaths(beforeSeq, afterSeq).includes("[GIT_METADATA]"));
  fs.rmSync(path.join(gitDir, "sequencer"), { force: true });

  // --- AC-4: broken operational symlink fails closed without path leakage ---
  const beforeBroken = captureContextManifest(root);
  assert.equal(beforeBroken.git.sharedRefIdentity.complete, true);
  const missingTarget = path.join(external, "missing-op-target");
  fs.symlinkSync(missingTarget, path.join(gitDir, "MERGE_AUTOSTASH"));
  const afterBroken = captureContextManifest(root);
  assert.equal(afterBroken.git.sharedRefIdentity.complete, false);
  assert.equal(afterBroken.git.sharedRefIdentity.attributable, false);
  assert.ok(observeChangedPaths(beforeBroken, afterBroken).includes("[GIT_METADATA]"));
  assert.ok(observeChangedPaths(afterBroken, afterBroken).includes("[GIT_METADATA]"));
  assert.equal(
    buildRuntimeEvidence({
      preContext: afterBroken,
      postContext: afterBroken,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "fail_closed"
  );
  assert.equal(JSON.stringify(buildRuntimeEvidence({
    preContext: beforeBroken,
    postContext: afterBroken,
    changedPaths: ["[GIT_METADATA]"]
  })).includes(missingTarget), false);
  fs.unlinkSync(path.join(gitDir, "MERGE_AUTOSTASH"));

  // --- AC-4: cyclic non-ref symlink fails closed without absolute-path leakage ---
  const infoDir = path.join(root, ".git", "info");
  fs.mkdirSync(infoDir, { recursive: true });
  const excludePath = path.join(infoDir, "exclude");
  // Point exclude at a two-node cycle (relative link texts).
  if (fs.existsSync(excludePath)) fs.unlinkSync(excludePath);
  const cycleA = path.join(infoDir, "cycle-a");
  const cycleB = path.join(infoDir, "cycle-b");
  fs.symlinkSync("cycle-b", cycleA);
  fs.symlinkSync("cycle-a", cycleB);
  fs.symlinkSync("cycle-a", excludePath);
  const afterCycle = captureContextManifest(root);
  assert.equal(afterCycle.git.sharedRefIdentity.complete, false);
  assert.ok(observeChangedPaths(afterCycle, afterCycle).includes("[GIT_METADATA]"));
  assert.equal(
    buildRuntimeEvidence({
      preContext: afterCycle,
      postContext: afterCycle,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "fail_closed"
  );
  const cycleSerialized = JSON.stringify(buildRuntimeEvidence({
    preContext: beforeBroken,
    postContext: afterCycle,
    changedPaths: ["[GIT_METADATA]"]
  }));
  assert.equal(cycleSerialized.includes(infoDir), false);
  assert.equal(cycleSerialized.includes(root), false);
  // Cleanup cycle fixtures.
  fs.unlinkSync(excludePath);
  fs.unlinkSync(cycleA);
  fs.unlinkSync(cycleB);
  fs.writeFileSync(excludePath, "");
});

test("metadata hashing and directory walks enforce hard byte/entry bounds (issue #34 re-review)", () => {
  const root = initRepo();
  const externalHooks = path.join(tempDir("grok-plugin-bound-hooks-"), "hooks");
  fs.mkdirSync(externalHooks, { recursive: true });
  git(root, "config", "core.hooksPath", externalHooks);

  // Within-bound directories stay deterministic across captures.
  fs.writeFileSync(path.join(externalHooks, "zeta"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(externalHooks, "alpha"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(externalHooks, "mu"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const first = captureContextManifest(root);
  const second = captureContextManifest(root);
  assert.equal(first.git.taskRelevantMetadataIdentity, second.git.taskRelevantMetadataIdentity);
  assert.equal(first.git.sharedRefIdentity.complete, true);
  assert.equal(
    buildRuntimeEvidence({
      preContext: first,
      postContext: second,
      changedPaths: observeChangedPaths(first, second)
    }).sharedRefObservation.classification,
    "unchanged"
  );
  assert.equal(JSON.stringify(first).includes(externalHooks), false);

  // Oversized single file exceeds the shared 4 MiB metadata hash budget and fails closed.
  // Use a sparse-ish write of repeated chunks to avoid multi-megabyte string literals.
  const oversizePath = path.join(externalHooks, "oversize-hook");
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const fd = fs.openSync(oversizePath, "w", 0o755);
  try {
    // 4 MiB + 1 byte.
    for (let written = 0; written < 4 * 1024 * 1024; written += chunk.length) {
      fs.writeSync(fd, chunk);
    }
    fs.writeSync(fd, Buffer.from([0x62]));
  } finally {
    fs.closeSync(fd);
  }
  const afterOversize = captureContextManifest(root);
  assert.equal(afterOversize.git.sharedRefIdentity.complete, false);
  assert.equal(afterOversize.git.sharedRefIdentity.attributable, false);
  assert.ok(observeChangedPaths(first, afterOversize).includes("[GIT_METADATA]"));
  assert.equal(
    buildRuntimeEvidence({
      preContext: afterOversize,
      postContext: afterOversize,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "fail_closed"
  );
  assert.equal(JSON.stringify(afterOversize).includes(externalHooks), false);
  assert.equal(JSON.stringify(afterOversize).includes("oversize-hook"), false);
  fs.unlinkSync(oversizePath);

  // Hard entry bound: more than MAX_GIT_METADATA_ENTRIES (10_000) siblings fail closed
  // without requiring flaky concurrent growth races.
  const entryFlood = path.join(externalHooks, "entry-flood");
  fs.mkdirSync(entryFlood, { recursive: true });
  // Root hooks already have alpha/mu/zeta (+ directory entry). Flood with 10_000
  // children so the shared entry walk must hit the hard bound.
  for (let index = 0; index < 10_000; index += 1) {
    fs.writeFileSync(
      path.join(entryFlood, `e${String(index).padStart(5, "0")}`),
      "",
      { mode: 0o644 }
    );
  }
  const afterEntries = captureContextManifest(root);
  assert.equal(afterEntries.git.sharedRefIdentity.complete, false);
  assert.equal(afterEntries.git.sharedRefIdentity.attributable, false);
  assert.ok(observeChangedPaths(first, afterEntries).includes("[GIT_METADATA]"));
  assert.equal(
    buildRuntimeEvidence({
      preContext: afterEntries,
      postContext: afterEntries,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "fail_closed"
  );
  const entriesSerialized = JSON.stringify(buildRuntimeEvidence({
    preContext: first,
    postContext: afterEntries,
    changedPaths: ["[GIT_METADATA]"]
  }));
  assert.equal(entriesSerialized.includes(externalHooks), false);
  assert.equal(entriesSerialized.includes(entryFlood), false);
  assert.equal(entriesSerialized.includes("e00000"), false);

  // Drop the hooks flood so later operational capture is not already fail-closed.
  fs.rmSync(entryFlood, { recursive: true, force: true });
  const afterHooksCleanup = captureContextManifest(root);
  assert.equal(afterHooksCleanup.git.sharedRefIdentity.complete, true);

  // Operational walker shares the same hard entry bound (sequencer directory).
  const linkedParent = tempDir("grok-plugin-bound-op-");
  const linkedRoot = path.join(linkedParent, "checkout");
  git(root, "worktree", "add", "-b", "bound-op", linkedRoot);
  const gitDirPath = String(git(linkedRoot, "rev-parse", "--git-dir"));
  const absoluteGitDir = path.resolve(linkedRoot, gitDirPath);
  const beforeOp = captureContextManifest(linkedRoot);
  assert.equal(beforeOp.git.sharedRefIdentity.complete, true);
  const sequencer = path.join(absoluteGitDir, "sequencer");
  fs.mkdirSync(sequencer, { recursive: true });
  for (let index = 0; index < 10_000; index += 1) {
    fs.writeFileSync(path.join(sequencer, `s${String(index).padStart(5, "0")}`), "x");
  }
  const afterOp = captureContextManifest(linkedRoot);
  assert.equal(afterOp.git.sharedRefIdentity.complete, false);
  assert.ok(observeChangedPaths(beforeOp, afterOp).includes("[GIT_METADATA]"));
  assert.equal(
    buildRuntimeEvidence({
      preContext: afterOp,
      postContext: afterOp,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "fail_closed"
  );
  assert.equal(JSON.stringify(afterOp).includes(sequencer), false);
});

test("metadata hashing fails closed on path replacement and same-size mutation (issue #34 race hardening)", () => {
  const root = initRepo();
  const externalHooks = path.join(tempDir("grok-plugin-race-hooks-"), "hooks");
  fs.mkdirSync(externalHooks, { recursive: true });
  git(root, "config", "core.hooksPath", externalHooks);

  const racePath = path.join(externalHooks, "race-hook");
  const payload = "stable-content-v1\n";
  const writeRaceFile = () => {
    try {
      fs.lstatSync(racePath);
      fs.unlinkSync(racePath);
    } catch {
      // missing is fine
    }
    fs.writeFileSync(racePath, payload, { mode: 0o755 });
  };
  writeRaceFile();
  const baseline = captureContextManifest(root);
  assert.equal(baseline.git.sharedRefIdentity.complete, true);
  assert.match(baseline.git.taskRelevantMetadataIdentity, /^[a-f0-9]{64}$/);

  // Stable re-capture remains deterministic when nothing races.
  const stableAgain = captureContextManifest(root);
  assert.equal(
    stableAgain.git.taskRelevantMetadataIdentity,
    baseline.git.taskRelevantMetadataIdentity
  );
  assert.equal(stableAgain.git.sharedRefIdentity.complete, true);

  const resolvedRacePath = path.join(fs.realpathSync(externalHooks), path.basename(racePath));
  const isRacePath = (file) => {
    try {
      return path.join(
        fs.realpathSync(path.dirname(String(file))),
        path.basename(String(file))
      ) === resolvedRacePath;
    } catch {
      return false;
    }
  };
  const originalOpenSync = fs.openSync;
  const originalReadSync = fs.readSync;

  const restoreFs = () => {
    fs.openSync = originalOpenSync;
    fs.readSync = originalReadSync;
  };

  // AC-1: pre-create a distinct replacement inode, then atomically rename it over
  // the opened path. Unlink+recreate can reuse the same inode on APFS; rename of
  // a coexisting file cannot.
  writeRaceFile();
  const replacementSidecar = path.join(externalHooks, ".race-hook-replacement");
  fs.writeFileSync(replacementSidecar, `${payload.slice(0, -1)}!\n`, { mode: 0o755 });
  const originalIno = String(fs.lstatSync(racePath, { bigint: true }).ino);
  const replacementIno = String(fs.lstatSync(replacementSidecar, { bigint: true }).ino);
  assert.notEqual(
    originalIno,
    replacementIno,
    "harness requires a distinct replacement inode before rename"
  );
  let replaced = false;
  fs.openSync = function openSyncWithAtomicPathReplacement(file, ...rest) {
    const descriptor = originalOpenSync.call(this, file, ...rest);
    if (isRacePath(file) && typeof rest[0] === "number" && !replaced) {
      replaced = true;
      // Atomic replace while the production descriptor remains on the old inode.
      fs.renameSync(replacementSidecar, racePath);
      assert.equal(
        String(fs.lstatSync(racePath, { bigint: true }).ino),
        replacementIno,
        "rename must install the pre-created replacement inode"
      );
      assert.notEqual(
        String(fs.lstatSync(racePath, { bigint: true }).ino),
        originalIno
      );
    }
    return descriptor;
  };
  try {
    const afterReplace = captureContextManifest(root);
    assert.equal(afterReplace.git.sharedRefIdentity.complete, false);
    assert.equal(afterReplace.git.sharedRefIdentity.attributable, false);
    assert.ok(observeChangedPaths(baseline, afterReplace).includes("[GIT_METADATA]"));
    assert.equal(
      buildRuntimeEvidence({
        preContext: afterReplace,
        postContext: afterReplace,
        changedPaths: ["[GIT_METADATA]"]
      }).sharedRefObservation.classification,
      "fail_closed"
    );
    assert.equal(JSON.stringify(afterReplace).includes(externalHooks), false);
    assert.equal(JSON.stringify(afterReplace).includes("race-hook"), false);
    assert.equal(JSON.stringify(afterReplace).includes(".race-hook-replacement"), false);
  } finally {
    restoreFs();
  }

  // Restore a clean regular file for the next injection.
  writeRaceFile();
  const mid = captureContextManifest(root);
  assert.equal(mid.git.sharedRefIdentity.complete, true);

  // AC-2: capture the production descriptor at open, then mutate same-size content
  // exactly once from readSync immediately before the first production read so the
  // mutation lands after the before fstat and during hashing.
  const sameSizeMutant = "STABLE-CONTENT-V2\n";
  assert.equal(Buffer.byteLength(sameSizeMutant), Buffer.byteLength(payload));
  let raceDescriptor = null;
  let mutatedDuringRead = false;
  fs.openSync = function openSyncCaptureRaceDescriptor(file, ...rest) {
    const descriptor = originalOpenSync.call(this, file, ...rest);
    if (isRacePath(file) && typeof rest[0] === "number") {
      raceDescriptor = descriptor;
    }
    return descriptor;
  };
  fs.readSync = function readSyncWithDuringHashMutation(fd, ...rest) {
    if (raceDescriptor != null && fd === raceDescriptor && !mutatedDuringRead) {
      mutatedDuringRead = true;
      // Mutate via a separate writable handle on the same path/inode.
      const mutateFd = originalOpenSync.call(this, racePath, "r+");
      try {
        fs.writeSync(mutateFd, Buffer.from(sameSizeMutant), 0, sameSizeMutant.length, 0);
        fs.fsyncSync(mutateFd);
      } finally {
        fs.closeSync(mutateFd);
      }
    }
    return originalReadSync.call(this, fd, ...rest);
  };
  try {
    const afterMutation = captureContextManifest(root);
    assert.equal(mutatedDuringRead, true, "harness must inject during the first production read");
    assert.equal(afterMutation.git.sharedRefIdentity.complete, false);
    assert.equal(afterMutation.git.sharedRefIdentity.attributable, false);
    assert.ok(observeChangedPaths(mid, afterMutation).includes("[GIT_METADATA]"));
    assert.equal(
      buildRuntimeEvidence({
        preContext: afterMutation,
        postContext: afterMutation,
        changedPaths: ["[GIT_METADATA]"]
      }).sharedRefObservation.classification,
      "fail_closed"
    );
    assert.equal(JSON.stringify(afterMutation).includes(externalHooks), false);
  } finally {
    restoreFs();
  }

  // Symlink swap at the path after open also fails closed (lstat must not follow).
  writeRaceFile();
  const beforeSymlink = captureContextManifest(root);
  assert.equal(beforeSymlink.git.sharedRefIdentity.complete, true);
  const symlinkTarget = path.join(path.dirname(externalHooks), "symlink-target-hook");
  fs.writeFileSync(symlinkTarget, payload, { mode: 0o755 });
  let swapped = false;
  fs.openSync = function openSyncWithSymlinkSwap(file, ...rest) {
    const descriptor = originalOpenSync.call(this, file, ...rest);
    if (isRacePath(file) && typeof rest[0] === "number" && !swapped) {
      swapped = true;
      try {
        fs.unlinkSync(racePath);
      } catch {
        // already swapped
      }
      fs.symlinkSync(symlinkTarget, racePath);
    }
    return descriptor;
  };
  try {
    const afterSymlink = captureContextManifest(root);
    assert.equal(afterSymlink.git.sharedRefIdentity.complete, false);
    assert.equal(
      buildRuntimeEvidence({
        preContext: afterSymlink,
        postContext: afterSymlink,
        changedPaths: ["[GIT_METADATA]"]
      }).sharedRefObservation.classification,
      "fail_closed"
    );
    assert.equal(JSON.stringify(afterSymlink).includes(symlinkTarget), false);
    assert.equal(JSON.stringify(afterSymlink).includes(externalHooks), false);
  } finally {
    restoreFs();
  }
});

test("symlink hop revalidation fails closed on file/dir retarget races (issue #34 final)", () => {
  const root = initRepo();
  const externalParent = fs.realpathSync(tempDir("grok-plugin-hop-race-"));
  const externalHooks = path.join(externalParent, "hooks");
  fs.mkdirSync(externalHooks, { recursive: true });
  git(root, "config", "core.hooksPath", externalHooks);

  // Canonical parent join so macOS /var vs /private/var aliases cannot bypass
  // path-equality injection for openSync/opendirSync monkeypatches.
  const canonicalJoin = (...parts) => path.join(fs.realpathSync(parts[0]), ...parts.slice(1));
  const sameCanonicalPath = (left, right) => {
    try {
      return path.join(
        fs.realpathSync(path.dirname(String(left))),
        path.basename(String(left))
      ) === path.join(
        fs.realpathSync(path.dirname(String(right))),
        path.basename(String(right))
      );
    } catch {
      return false;
    }
  };

  // --- AC-1: file symlink retargeted after hop capture, during old-target hash ---
  const targetA = path.join(externalParent, "file-target-a");
  const targetB = path.join(externalParent, "file-target-b");
  const fileLink = path.join(externalHooks, "pre-push");
  const payloadA = "#!/bin/sh\necho hop-target-a\nexit 0\n";
  const payloadB = "#!/bin/sh\necho hop-target-b\nexit 1\n";
  fs.writeFileSync(targetA, payloadA, { mode: 0o755 });
  fs.writeFileSync(targetB, payloadB, { mode: 0o755 });
  fs.symlinkSync(targetA, fileLink);

  const beforeFile = captureContextManifest(root);
  assert.equal(beforeFile.git.sharedRefIdentity.complete, true);
  assert.match(beforeFile.git.taskRelevantMetadataIdentity, /^[a-f0-9]{64}$/);
  // Stable chain remains complete and deterministic when nothing races.
  const stableFileAgain = captureContextManifest(root);
  assert.equal(
    stableFileAgain.git.taskRelevantMetadataIdentity,
    beforeFile.git.taskRelevantMetadataIdentity
  );
  assert.equal(stableFileAgain.git.sharedRefIdentity.complete, true);

  const resolvedTargetA = canonicalJoin(externalParent, "file-target-a");
  const originalOpenSync = fs.openSync;
  let fileRetargeted = false;
  fs.openSync = function openSyncRetargetFileSymlinkHop(file, ...rest) {
    const descriptor = originalOpenSync.call(this, file, ...rest);
    if (
      sameCanonicalPath(file, resolvedTargetA)
      && typeof rest[0] === "number"
      && !fileRetargeted
    ) {
      fileRetargeted = true;
      // Atomic hop retarget while production hashes the old target inode.
      fs.unlinkSync(fileLink);
      fs.symlinkSync(targetB, fileLink);
    }
    return descriptor;
  };
  try {
    const afterFileRace = captureContextManifest(root);
    assert.equal(fileRetargeted, true, "harness must retarget file hop during open of old target");
    assert.equal(afterFileRace.git.sharedRefIdentity.complete, false);
    assert.equal(afterFileRace.git.sharedRefIdentity.attributable, false);
    assert.ok(observeChangedPaths(beforeFile, afterFileRace).includes("[GIT_METADATA]"));
    assert.equal(
      buildRuntimeEvidence({
        preContext: afterFileRace,
        postContext: afterFileRace,
        changedPaths: ["[GIT_METADATA]"]
      }).sharedRefObservation.classification,
      "fail_closed"
    );
    const fileRaceSerialized = JSON.stringify(afterFileRace);
    assert.equal(fileRaceSerialized.includes(targetA), false);
    assert.equal(fileRaceSerialized.includes(targetB), false);
    assert.equal(fileRaceSerialized.includes(fileLink), false);
    assert.equal(fileRaceSerialized.includes(externalHooks), false);
    assert.equal(fileRaceSerialized.includes(payloadA), false);
    assert.equal(fileRaceSerialized.includes(payloadB), false);
    const fileEvidence = JSON.stringify(buildRuntimeEvidence({
      preContext: beforeFile,
      postContext: afterFileRace,
      changedPaths: ["[GIT_METADATA]"]
    }));
    assert.equal(fileEvidence.includes(targetA), false);
    assert.equal(fileEvidence.includes(targetB), false);
    assert.equal(fileEvidence.includes(externalParent), false);
  } finally {
    fs.openSync = originalOpenSync;
  }

  // Restore a stable file symlink for the directory-race setup below.
  try { fs.unlinkSync(fileLink); } catch { /* missing is fine */ }
  fs.symlinkSync(targetA, fileLink);
  const midStable = captureContextManifest(root);
  assert.equal(midStable.git.sharedRefIdentity.complete, true);

  // --- AC-2: directory symlink retargeted during target traversal ---
  // Point core.hooksPath at a directory symlink; retarget the hop when the
  // resolved directory is opened for bounded listing.
  const hooksDirA = path.join(externalParent, "hooks-dir-a");
  const hooksDirB = path.join(externalParent, "hooks-dir-b");
  const hooksDirLink = path.join(externalParent, "hooks-dir-link");
  fs.mkdirSync(hooksDirA, { recursive: true });
  fs.mkdirSync(hooksDirB, { recursive: true });
  fs.writeFileSync(path.join(hooksDirA, "pre-commit"), "#!/bin/sh\necho dir-a\nexit 0\n", {
    mode: 0o755
  });
  fs.writeFileSync(path.join(hooksDirB, "pre-commit"), "#!/bin/sh\necho dir-b\nexit 1\n", {
    mode: 0o755
  });
  try { fs.unlinkSync(hooksDirLink); } catch { /* missing is fine */ }
  fs.symlinkSync(hooksDirA, hooksDirLink);
  git(root, "config", "core.hooksPath", hooksDirLink);

  const beforeDir = captureContextManifest(root);
  assert.equal(beforeDir.git.sharedRefIdentity.complete, true);
  assert.match(beforeDir.git.taskRelevantMetadataIdentity, /^[a-f0-9]{64}$/);
  const stableDirAgain = captureContextManifest(root);
  assert.equal(
    stableDirAgain.git.taskRelevantMetadataIdentity,
    beforeDir.git.taskRelevantMetadataIdentity,
    "stable directory symlink chain must keep deterministic identity"
  );

  const resolvedHooksDirA = fs.realpathSync(hooksDirA);
  const originalOpendirSync = fs.opendirSync;
  let dirRetargeted = false;
  fs.opendirSync = function opendirSyncRetargetDirSymlinkHop(dirPath, ...rest) {
    const handle = originalOpendirSync.call(this, dirPath, ...rest);
    if (sameCanonicalPath(dirPath, resolvedHooksDirA) && !dirRetargeted) {
      dirRetargeted = true;
      // Atomic hop retarget after the old directory is opened for traversal.
      fs.unlinkSync(hooksDirLink);
      fs.symlinkSync(hooksDirB, hooksDirLink);
    }
    return handle;
  };
  try {
    const afterDirRace = captureContextManifest(root);
    assert.equal(dirRetargeted, true, "harness must retarget directory hop during traversal");
    assert.equal(afterDirRace.git.sharedRefIdentity.complete, false);
    assert.equal(afterDirRace.git.sharedRefIdentity.attributable, false);
    assert.ok(observeChangedPaths(beforeDir, afterDirRace).includes("[GIT_METADATA]"));
    assert.equal(
      buildRuntimeEvidence({
        preContext: afterDirRace,
        postContext: afterDirRace,
        changedPaths: ["[GIT_METADATA]"]
      }).sharedRefObservation.classification,
      "fail_closed"
    );
    const dirRaceSerialized = JSON.stringify(afterDirRace);
    assert.equal(dirRaceSerialized.includes(hooksDirA), false);
    assert.equal(dirRaceSerialized.includes(hooksDirB), false);
    assert.equal(dirRaceSerialized.includes(hooksDirLink), false);
    assert.equal(dirRaceSerialized.includes(externalParent), false);
    assert.equal(dirRaceSerialized.includes("dir-a"), false);
    assert.equal(dirRaceSerialized.includes("dir-b"), false);
    const dirEvidence = JSON.stringify(buildRuntimeEvidence({
      preContext: beforeDir,
      postContext: afterDirRace,
      changedPaths: ["[GIT_METADATA]"]
    }));
    assert.equal(dirEvidence.includes(hooksDirA), false);
    assert.equal(dirEvidence.includes(hooksDirLink), false);
    assert.equal(dirEvidence.includes(root), false);
  } finally {
    fs.opendirSync = originalOpendirSync;
  }

  // --- AC-3/AC-4: after race cleanup, a stable multi-hop chain is complete and private ---
  try { fs.unlinkSync(hooksDirLink); } catch { /* missing is fine */ }
  fs.symlinkSync(hooksDirA, hooksDirLink);
  git(root, "config", "core.hooksPath", hooksDirLink);
  // Nested file symlink under the resolved hooks directory.
  const nestedTarget = path.join(externalParent, "nested-hook-body");
  const nestedLink = path.join(hooksDirA, "pre-push");
  fs.writeFileSync(nestedTarget, "#!/bin/sh\necho nested-stable\nexit 0\n", { mode: 0o755 });
  try { fs.unlinkSync(nestedLink); } catch { /* missing is fine */ }
  fs.symlinkSync(nestedTarget, nestedLink);
  const stableNested = captureContextManifest(root);
  assert.equal(stableNested.git.sharedRefIdentity.complete, true);
  const stableNestedAgain = captureContextManifest(root);
  assert.equal(
    stableNestedAgain.git.taskRelevantMetadataIdentity,
    stableNested.git.taskRelevantMetadataIdentity
  );
  const nestedSerialized = JSON.stringify(stableNested);
  assert.equal(nestedSerialized.includes(nestedTarget), false);
  assert.equal(nestedSerialized.includes(nestedLink), false);
  assert.equal(nestedSerialized.includes(hooksDirLink), false);
  assert.equal(nestedSerialized.includes("nested-stable"), false);
  const nestedEvidence = JSON.stringify(buildRuntimeEvidence({
    preContext: stableNested,
    postContext: stableNestedAgain,
    changedPaths: []
  }));
  assert.equal(nestedEvidence.includes(nestedTarget), false);
  assert.equal(nestedEvidence.includes(externalParent), false);
  assert.equal(nestedEvidence.includes(root), false);
});

test("ordinary non-symlink directory growth and listed-child disappearance fail closed (issue #34)", () => {
  const root = initRepo();
  const hooksParent = fs.realpathSync(tempDir("grok-plugin-ord-dir-race-"));
  const externalHooks = path.join(hooksParent, "hooks");
  fs.mkdirSync(externalHooks, { recursive: true });
  git(root, "config", "core.hooksPath", externalHooks);

  const sameCanonicalPath = (left, right) => {
    try {
      return path.join(
        fs.realpathSync(path.dirname(String(left))),
        path.basename(String(left))
      ) === path.join(
        fs.realpathSync(path.dirname(String(right))),
        path.basename(String(right))
      );
    } catch {
      return false;
    }
  };
  const resolvedHooks = fs.realpathSync(externalHooks);
  const isHooksDir = (dirPath) => {
    try {
      return fs.realpathSync(String(dirPath)) === resolvedHooks;
    } catch {
      return sameCanonicalPath(dirPath, resolvedHooks);
    }
  };

  // Stable empty ordinary hooks directory remains complete and deterministic.
  const emptyBaseline = captureContextManifest(root);
  assert.equal(emptyBaseline.git.sharedRefIdentity.complete, true);
  assert.match(emptyBaseline.git.taskRelevantMetadataIdentity, /^[a-f0-9]{64}$/);
  const emptyAgain = captureContextManifest(root);
  assert.equal(
    emptyAgain.git.taskRelevantMetadataIdentity,
    emptyBaseline.git.taskRelevantMetadataIdentity
  );
  assert.deepEqual(observeChangedPaths(emptyBaseline, emptyAgain), []);

  // --- AC-1: post-EOF directory growth on ordinary non-symlink hooks root ---
  const originalOpendirSync = fs.opendirSync;
  let growthInjected = false;
  fs.opendirSync = function opendirSyncInjectGrowthAfterEof(dirPath, ...rest) {
    const handle = originalOpendirSync.call(this, dirPath, ...rest);
    if (!isHooksDir(dirPath) || growthInjected) return handle;
    const originalReadSync = handle.readSync.bind(handle);
    let sawEof = false;
    handle.readSync = function readSyncInjectAfterEof(...args) {
      const entry = originalReadSync(...args);
      if (entry === null && !sawEof) {
        sawEof = true;
        growthInjected = true;
        // Race: new entry appears exactly after the bounded iterator hits EOF.
        fs.writeFileSync(
          path.join(externalHooks, "pre-commit"),
          "#!/bin/sh\necho raced-growth\nexit 1\n",
          { mode: 0o755 }
        );
      }
      return entry;
    };
    return handle;
  };
  try {
    const afterGrowth = captureContextManifest(root);
    assert.equal(growthInjected, true, "harness must inject directory growth after EOF");
    assert.equal(afterGrowth.git.sharedRefIdentity.complete, false);
    assert.equal(afterGrowth.git.sharedRefIdentity.attributable, false);
    assert.ok(observeChangedPaths(emptyBaseline, afterGrowth).includes("[GIT_METADATA]"));
    assert.equal(
      buildRuntimeEvidence({
        preContext: afterGrowth,
        postContext: afterGrowth,
        changedPaths: ["[GIT_METADATA]"]
      }).sharedRefObservation.classification,
      "fail_closed"
    );
    const growthEvidence = JSON.stringify(buildRuntimeEvidence({
      preContext: emptyBaseline,
      postContext: afterGrowth,
      changedPaths: ["[GIT_METADATA]"]
    }));
    assert.equal(growthEvidence.includes(externalHooks), false);
    assert.equal(growthEvidence.includes(hooksParent), false);
    assert.equal(growthEvidence.includes("raced-growth"), false);
    assert.equal(growthEvidence.includes(root), false);
  } finally {
    fs.opendirSync = originalOpendirSync;
  }

  // Clean growth artifact and confirm stable recapture sees the new entry as drift
  // (not required for fail-closed of the raced capture, but documents the gap closed).
  const growthPath = path.join(externalHooks, "pre-commit");
  try { fs.unlinkSync(growthPath); } catch { /* may already be absent */ }

  // --- AC-2: disappearance of an already-listed child fails closed ---
  const listedChild = path.join(externalHooks, "listed-hook");
  fs.writeFileSync(listedChild, "#!/bin/sh\necho listed-v1\nexit 0\n", { mode: 0o755 });
  const listedBaseline = captureContextManifest(root);
  assert.equal(listedBaseline.git.sharedRefIdentity.complete, true);

  const resolvedChild = path.join(fs.realpathSync(externalHooks), path.basename(listedChild));
  const originalLstatSync = fs.lstatSync;
  let childRemoved = false;
  fs.lstatSync = function lstatSyncRemoveListedChild(filePath, ...rest) {
    if (sameCanonicalPath(filePath, resolvedChild) && !childRemoved) {
      childRemoved = true;
      try {
        fs.unlinkSync(listedChild);
      } catch {
        // already removed
      }
    }
    return originalLstatSync.call(this, filePath, ...rest);
  };
  try {
    const afterRemoval = captureContextManifest(root);
    assert.equal(childRemoved, true, "harness must remove listed child during capture");
    assert.equal(afterRemoval.git.sharedRefIdentity.complete, false);
    assert.equal(afterRemoval.git.sharedRefIdentity.attributable, false);
    assert.ok(observeChangedPaths(listedBaseline, afterRemoval).includes("[GIT_METADATA]"));
    assert.equal(
      buildRuntimeEvidence({
        preContext: afterRemoval,
        postContext: afterRemoval,
        changedPaths: ["[GIT_METADATA]"]
      }).sharedRefObservation.classification,
      "fail_closed"
    );
    const removalEvidence = JSON.stringify(buildRuntimeEvidence({
      preContext: listedBaseline,
      postContext: afterRemoval,
      changedPaths: ["[GIT_METADATA]"]
    }));
    assert.equal(removalEvidence.includes(listedChild), false);
    assert.equal(removalEvidence.includes(externalHooks), false);
    assert.equal(removalEvidence.includes("listed-v1"), false);
  } finally {
    fs.lstatSync = originalLstatSync;
  }

  // --- Optional top-level absence remains normal (not fail-closed solely for missing) ---
  // Restore a clean hooks dir; ensure operational optional roots still allow complete=true.
  try { fs.unlinkSync(listedChild); } catch { /* absent ok */ }
  try { fs.unlinkSync(growthPath); } catch { /* absent ok */ }
  const optionalOk = captureContextManifest(root);
  assert.equal(optionalOk.git.sharedRefIdentity.complete, true);
  // MERGE_HEAD is intentionally absent; capture must not fail closed for that alone.
  assert.equal(fs.existsSync(path.join(root, ".git", "MERGE_HEAD")), false);

  // Stable ordinary directory with one child remains deterministic.
  fs.writeFileSync(listedChild, "#!/bin/sh\necho stable-child\nexit 0\n", { mode: 0o755 });
  const stableDir = captureContextManifest(root);
  assert.equal(stableDir.git.sharedRefIdentity.complete, true);
  const stableDirAgain = captureContextManifest(root);
  assert.equal(
    stableDirAgain.git.taskRelevantMetadataIdentity,
    stableDir.git.taskRelevantMetadataIdentity
  );
  const stableEvidence = JSON.stringify(buildRuntimeEvidence({
    preContext: stableDir,
    postContext: stableDirAgain,
    changedPaths: []
  }));
  assert.equal(stableEvidence.includes(externalHooks), false);
  assert.equal(stableEvidence.includes("stable-child"), false);
  assert.equal(stableEvidence.includes(root), false);
});

test("ordinary file mode at open and sibling-after-hash drift fail closed (issue #34)", () => {
  const root = initRepo();
  const hooksParent = fs.realpathSync(tempDir("grok-plugin-mode-sibling-"));
  const externalHooks = path.join(hooksParent, "hooks");
  fs.mkdirSync(externalHooks, { recursive: true });
  git(root, "config", "core.hooksPath", externalHooks);

  const sameCanonicalPath = (left, right) => {
    try {
      return path.join(
        fs.realpathSync(path.dirname(String(left))),
        path.basename(String(left))
      ) === path.join(
        fs.realpathSync(path.dirname(String(right))),
        path.basename(String(right))
      );
    } catch {
      return false;
    }
  };

  // --- AC-1: 0644 -> 0755 chmod at the bounded open boundary ---
  const modeHook = path.join(externalHooks, "mode-hook");
  fs.writeFileSync(modeHook, "#!/bin/sh\necho mode-stable\nexit 0\n", { mode: 0o644 });
  const modeBaseline = captureContextManifest(root);
  assert.equal(modeBaseline.git.sharedRefIdentity.complete, true);
  assert.match(modeBaseline.git.taskRelevantMetadataIdentity, /^[a-f0-9]{64}$/);

  const resolvedModeHook = path.join(fs.realpathSync(externalHooks), path.basename(modeHook));
  const originalOpenSync = fs.openSync;
  let modeChmodded = false;
  fs.openSync = function openSyncChmodAtOpen(file, flags, ...rest) {
    const descriptor = originalOpenSync.call(this, file, flags, ...rest);
    if (
      sameCanonicalPath(file, resolvedModeHook)
      && typeof flags === "number"
      && !modeChmodded
    ) {
      modeChmodded = true;
      fs.chmodSync(modeHook, 0o755);
    }
    return descriptor;
  };
  try {
    const afterModeRace = captureContextManifest(root);
    assert.equal(modeChmodded, true, "harness must chmod at open boundary");
    // Descriptor-validated mode binds the new identity and/or fail-closes; either
    // way the stale baseline identity must not be published as unchanged.
    assert.notEqual(
      afterModeRace.git.taskRelevantMetadataIdentity,
      modeBaseline.git.taskRelevantMetadataIdentity,
      "mode-at-open must not publish stale pre-open mode identity"
    );
    assert.ok(observeChangedPaths(modeBaseline, afterModeRace).includes("[GIT_METADATA]"));
    if (afterModeRace.git.sharedRefIdentity.complete === false) {
      assert.equal(afterModeRace.git.sharedRefIdentity.attributable, false);
      assert.equal(
        buildRuntimeEvidence({
          preContext: afterModeRace,
          postContext: afterModeRace,
          changedPaths: ["[GIT_METADATA]"]
        }).sharedRefObservation.classification,
        "fail_closed"
      );
    } else {
      // Complete with bound mode: still task-relevant drift vs baseline.
      assert.equal(
        buildRuntimeEvidence({
          preContext: modeBaseline,
          postContext: afterModeRace,
          changedPaths: ["[GIT_METADATA]"]
        }).sharedRefObservation.classification,
        "task_relevant_metadata_drift"
      );
    }
    const modeEvidence = JSON.stringify(buildRuntimeEvidence({
      preContext: modeBaseline,
      postContext: afterModeRace,
      changedPaths: ["[GIT_METADATA]"]
    }));
    assert.equal(modeEvidence.includes(modeHook), false);
    assert.equal(modeEvidence.includes(externalHooks), false);
    assert.equal(modeEvidence.includes("mode-stable"), false);
  } finally {
    fs.openSync = originalOpenSync;
  }

  // Restore a stable dual-file tree for sibling-after-hash (sorted: alpha then beta).
  try { fs.unlinkSync(modeHook); } catch { /* absent ok */ }
  const alphaHook = path.join(externalHooks, "alpha-hook");
  const betaHook = path.join(externalHooks, "beta-hook");
  const alphaBody = "#!/bin/sh\necho alpha-v1\nexit 0\n";
  const betaBody = "#!/bin/sh\necho beta-v1\nexit 0\n";
  // Force modes with chmodSync: writeFileSync mode is ignored for existing paths.
  fs.writeFileSync(alphaHook, alphaBody);
  fs.writeFileSync(betaHook, betaBody);
  fs.chmodSync(alphaHook, 0o755);
  fs.chmodSync(betaHook, 0o755);
  const siblingBaseline = captureContextManifest(root);
  assert.equal(siblingBaseline.git.sharedRefIdentity.complete, true);
  const siblingStable = captureContextManifest(root);
  assert.equal(
    siblingStable.git.taskRelevantMetadataIdentity,
    siblingBaseline.git.taskRelevantMetadataIdentity
  );

  // Production open plan for this external dual-hook tree during one
  // captureContextManifest (descriptor-bound number-flag opens only):
  //   Legacy gitMetadataIdentity walks commonDir/hooks (.git/hooks), not the
  //   external core.hooksPath tree — so it does not open alpha/beta here.
  //   Task-relevant effective-hooks walk then:
  //     1) open alpha (hash)
  //     2) open beta (hash)              <-- inject sibling drift here
  //     3) open alpha (child revalidation)
  //     4) open beta (child revalidation)
  // If a future earlier pass begins hashing the same external files once each
  // before task-relevant capture, raise EXPECTED_*_HASH_OPEN_ORDINAL so the
  // harness cannot silently fire on a stable pre-capture mutation.
  const resolvedAlpha = path.join(fs.realpathSync(externalHooks), path.basename(alphaHook));
  const resolvedBeta = path.join(fs.realpathSync(externalHooks), path.basename(betaHook));
  const EXPECTED_BETA_HASH_OPEN_ORDINAL = 1;
  const EXPECTED_ALPHA_OPENS_BEFORE_BETA_HASH = 1;

  // --- AC-2: mutate previously hashed sibling while the next sibling opens ---
  let siblingMutated = false;
  let siblingBetaOpenOrdinal = 0;
  let siblingAlphaOpenCount = 0;
  let siblingAlphaOpensAtInject = 0;
  let siblingBetaOrdinalAtInject = 0;
  fs.openSync = function openSyncMutatePriorSibling(file, flags, ...rest) {
    const descriptor = originalOpenSync.call(this, file, flags, ...rest);
    if (typeof flags !== "number") return descriptor;
    if (sameCanonicalPath(file, resolvedAlpha)) {
      siblingAlphaOpenCount += 1;
    }
    if (sameCanonicalPath(file, resolvedBeta)) {
      siblingBetaOpenOrdinal += 1;
      if (
        !siblingMutated
        && siblingBetaOpenOrdinal === EXPECTED_BETA_HASH_OPEN_ORDINAL
        && siblingAlphaOpenCount >= EXPECTED_ALPHA_OPENS_BEFORE_BETA_HASH
      ) {
        siblingMutated = true;
        siblingAlphaOpensAtInject = siblingAlphaOpenCount;
        siblingBetaOrdinalAtInject = siblingBetaOpenOrdinal;
        // Content mutation of already-hashed alpha while beta is opened.
        fs.writeFileSync(alphaHook, "#!/bin/sh\necho alpha-raced\nexit 1\n");
        fs.chmodSync(alphaHook, 0o755);
      }
    }
    return descriptor;
  };
  try {
    const afterSiblingRace = captureContextManifest(root);
    assert.equal(siblingMutated, true, "harness must mutate prior sibling during next open");
    assert.equal(
      siblingBetaOrdinalAtInject,
      EXPECTED_BETA_HASH_OPEN_ORDINAL,
      "content race must fire on the task-relevant beta hash open ordinal"
    );
    assert.equal(
      siblingAlphaOpensAtInject,
      EXPECTED_ALPHA_OPENS_BEFORE_BETA_HASH,
      "alpha must already be captured once in this traversal before beta hash inject"
    );
    assert.ok(
      siblingAlphaOpenCount >= EXPECTED_ALPHA_OPENS_BEFORE_BETA_HASH + 1,
      "alpha child revalidation must run after inject (proves mid-traversal race)"
    );
    assert.equal(afterSiblingRace.git.sharedRefIdentity.complete, false);
    assert.equal(afterSiblingRace.git.sharedRefIdentity.attributable, false);
    assert.ok(observeChangedPaths(siblingBaseline, afterSiblingRace).includes("[GIT_METADATA]"));
    assert.equal(
      buildRuntimeEvidence({
        preContext: afterSiblingRace,
        postContext: afterSiblingRace,
        changedPaths: ["[GIT_METADATA]"]
      }).sharedRefObservation.classification,
      "fail_closed"
    );
    const siblingEvidence = JSON.stringify(buildRuntimeEvidence({
      preContext: siblingBaseline,
      postContext: afterSiblingRace,
      changedPaths: ["[GIT_METADATA]"]
    }));
    assert.equal(siblingEvidence.includes(alphaHook), false);
    assert.equal(siblingEvidence.includes(betaHook), false);
    assert.equal(siblingEvidence.includes("alpha-raced"), false);
    assert.equal(siblingEvidence.includes(externalHooks), false);
  } finally {
    fs.openSync = originalOpenSync;
  }

  // Mode-only sibling-after-hash: chmod alpha while beta opens in the
  // task-relevant pass (not an earlier legacy pass / stable pre-mutation).
  fs.writeFileSync(alphaHook, alphaBody);
  fs.writeFileSync(betaHook, betaBody);
  fs.chmodSync(alphaHook, 0o644);
  fs.chmodSync(betaHook, 0o755);
  assert.equal(fs.statSync(alphaHook).mode & 0o777, 0o644, "harness requires alpha mode 0644 before race");
  assert.equal(fs.statSync(betaHook).mode & 0o777, 0o755, "harness requires beta mode 0755 before race");
  const siblingModeBaseline = captureContextManifest(root);
  assert.equal(siblingModeBaseline.git.sharedRefIdentity.complete, true);
  // Baseline must have observed 0644; a no-op chmod race would not fail closed.
  assert.equal(fs.statSync(alphaHook).mode & 0o777, 0o644);

  let siblingModeMutated = false;
  let modeBetaOpenOrdinal = 0;
  let modeAlphaOpenCount = 0;
  let modeAlphaOpensAtInject = 0;
  let modeBetaOrdinalAtInject = 0;
  fs.openSync = function openSyncChmodPriorSibling(file, flags, ...rest) {
    const descriptor = originalOpenSync.call(this, file, flags, ...rest);
    if (typeof flags !== "number") return descriptor;
    if (sameCanonicalPath(file, resolvedAlpha)) {
      modeAlphaOpenCount += 1;
    }
    if (sameCanonicalPath(file, resolvedBeta)) {
      modeBetaOpenOrdinal += 1;
      if (
        !siblingModeMutated
        && modeBetaOpenOrdinal === EXPECTED_BETA_HASH_OPEN_ORDINAL
        && modeAlphaOpenCount >= EXPECTED_ALPHA_OPENS_BEFORE_BETA_HASH
      ) {
        siblingModeMutated = true;
        modeAlphaOpensAtInject = modeAlphaOpenCount;
        modeBetaOrdinalAtInject = modeBetaOpenOrdinal;
        // Mode-only drift of already-hashed alpha during task-relevant beta hash.
        fs.chmodSync(alphaHook, 0o755);
      }
    }
    return descriptor;
  };
  try {
    const afterSiblingMode = captureContextManifest(root);
    assert.equal(siblingModeMutated, true, "harness must chmod prior sibling during task-relevant beta hash open");
    assert.equal(
      modeBetaOrdinalAtInject,
      EXPECTED_BETA_HASH_OPEN_ORDINAL,
      "mode race must fire on the task-relevant beta hash open ordinal, not an earlier pass"
    );
    assert.equal(
      modeAlphaOpensAtInject,
      EXPECTED_ALPHA_OPENS_BEFORE_BETA_HASH,
      "alpha must already be captured once in the same task-relevant traversal before inject"
    );
    assert.ok(
      modeAlphaOpenCount >= EXPECTED_ALPHA_OPENS_BEFORE_BETA_HASH + 1,
      "alpha child revalidation must run after mode inject (before capture completes)"
    );
    assert.equal(afterSiblingMode.git.sharedRefIdentity.complete, false);
    assert.equal(afterSiblingMode.git.sharedRefIdentity.attributable, false);
    assert.ok(observeChangedPaths(siblingModeBaseline, afterSiblingMode).includes("[GIT_METADATA]"));
    assert.equal(
      buildRuntimeEvidence({
        preContext: afterSiblingMode,
        postContext: afterSiblingMode,
        changedPaths: ["[GIT_METADATA]"]
      }).sharedRefObservation.classification,
      "fail_closed"
    );
    const modeSiblingEvidence = JSON.stringify(buildRuntimeEvidence({
      preContext: siblingModeBaseline,
      postContext: afterSiblingMode,
      changedPaths: ["[GIT_METADATA]"]
    }));
    assert.equal(modeSiblingEvidence.includes(alphaHook), false);
    assert.equal(modeSiblingEvidence.includes(externalHooks), false);
  } finally {
    fs.openSync = originalOpenSync;
  }

  // Symlink child hop/final-target revalidation: mutate symlink target after hash
  // while a later ordinary sibling is opened (same ordinal discipline).
  try { fs.unlinkSync(alphaHook); } catch { /* absent ok */ }
  try { fs.unlinkSync(betaHook); } catch { /* absent ok */ }
  const linkTarget = path.join(hooksParent, "link-target-body");
  const linkHook = path.join(externalHooks, "alpha-link");
  const laterHook = path.join(externalHooks, "zeta-hook");
  fs.writeFileSync(linkTarget, "#!/bin/sh\necho link-v1\nexit 0\n");
  fs.chmodSync(linkTarget, 0o755);
  try { fs.unlinkSync(linkHook); } catch { /* absent ok */ }
  fs.symlinkSync(linkTarget, linkHook);
  fs.writeFileSync(laterHook, "#!/bin/sh\necho later-v1\nexit 0\n");
  fs.chmodSync(laterHook, 0o755);
  const linkSiblingBaseline = captureContextManifest(root);
  assert.equal(linkSiblingBaseline.git.sharedRefIdentity.complete, true);
  const resolvedLinkTarget = path.join(fs.realpathSync(hooksParent), path.basename(linkTarget));
  const resolvedLater = path.join(fs.realpathSync(externalHooks), path.basename(laterHook));
  // Sorted: alpha-link (symlink→file open of target) then zeta-hook.
  // Task-relevant: open target (hash), open zeta (hash) <-- inject, then child
  // revalidation. Production revalidateMetadataSymlinkHops lstat-checks the
  // final target signature first; content mutation changes mtime/ctime and
  // fails closed without a second openSync of the target. Do not require a
  // second target open — that is the content-rehash path, not the hop path.
  const EXPECTED_LATER_HASH_OPEN_ORDINAL = 1;
  const EXPECTED_TARGET_OPENS_BEFORE_LATER_HASH = 1;
  let linkTargetMutated = false;
  let laterOpenOrdinal = 0;
  let targetOpenCount = 0;
  let targetOpensAtInject = 0;
  let laterOrdinalAtInject = 0;
  let targetLstatAfterInject = 0;
  const originalLstatSync = fs.lstatSync;
  fs.openSync = function openSyncMutateLinkTarget(file, flags, ...rest) {
    const descriptor = originalOpenSync.call(this, file, flags, ...rest);
    if (typeof flags !== "number") return descriptor;
    if (sameCanonicalPath(file, resolvedLinkTarget)) {
      targetOpenCount += 1;
    }
    if (sameCanonicalPath(file, resolvedLater)) {
      laterOpenOrdinal += 1;
      if (
        !linkTargetMutated
        && laterOpenOrdinal === EXPECTED_LATER_HASH_OPEN_ORDINAL
        && targetOpenCount >= EXPECTED_TARGET_OPENS_BEFORE_LATER_HASH
      ) {
        linkTargetMutated = true;
        targetOpensAtInject = targetOpenCount;
        laterOrdinalAtInject = laterOpenOrdinal;
        fs.writeFileSync(linkTarget, "#!/bin/sh\necho link-raced\nexit 1\n");
        fs.chmodSync(linkTarget, 0o755);
      }
    }
    return descriptor;
  };
  fs.lstatSync = function lstatSyncCountPostInjectTarget(filePath, ...rest) {
    const result = originalLstatSync.call(this, filePath, ...rest);
    if (linkTargetMutated && sameCanonicalPath(filePath, resolvedLinkTarget)) {
      targetLstatAfterInject += 1;
    }
    return result;
  };
  try {
    const afterLinkSibling = captureContextManifest(root);
    assert.equal(linkTargetMutated, true, "harness must mutate symlink target during sibling open");
    assert.equal(
      laterOrdinalAtInject,
      EXPECTED_LATER_HASH_OPEN_ORDINAL,
      "symlink-target race must fire on the task-relevant later-sibling hash open ordinal"
    );
    assert.equal(
      targetOpensAtInject,
      EXPECTED_TARGET_OPENS_BEFORE_LATER_HASH,
      "symlink target must already be captured once before later-sibling hash inject"
    );
    // Early fail-closed path: hop revalidation re-lstats finalAbsolute and
    // rejects finalSignature drift (mtime/ctime from content write) without a
    // second descriptor open of the target body.
    assert.equal(
      targetOpenCount,
      EXPECTED_TARGET_OPENS_BEFORE_LATER_HASH,
      "final-signature early fail must not require a second target openSync"
    );
    assert.ok(
      targetLstatAfterInject >= 1,
      "post-inject hop revalidation must lstat the mutated final target (signature check)"
    );
    assert.equal(afterLinkSibling.git.sharedRefIdentity.complete, false);
    assert.equal(afterLinkSibling.git.sharedRefIdentity.attributable, false);
    assert.ok(observeChangedPaths(linkSiblingBaseline, afterLinkSibling).includes("[GIT_METADATA]"));
    assert.equal(
      buildRuntimeEvidence({
        preContext: afterLinkSibling,
        postContext: afterLinkSibling,
        changedPaths: ["[GIT_METADATA]"]
      }).sharedRefObservation.classification,
      "fail_closed"
    );
    const linkEvidence = JSON.stringify(buildRuntimeEvidence({
      preContext: linkSiblingBaseline,
      postContext: afterLinkSibling,
      changedPaths: ["[GIT_METADATA]"]
    }));
    assert.equal(linkEvidence.includes(linkTarget), false);
    assert.equal(linkEvidence.includes(linkHook), false);
    assert.equal(linkEvidence.includes("link-raced"), false);
  } finally {
    fs.openSync = originalOpenSync;
    fs.lstatSync = originalLstatSync;
  }
});

test("legacy metadataIdentity bounds default hooks and refs without unbounded walks (issue #34)", () => {
  // No external core.hooksPath: legacy gitMetadataIdentity and effective hooks
  // both observe default .git/hooks; refs walk is legacy-only.
  const root = initRepo();
  const defaultHooks = path.join(root, ".git", "hooks");
  fs.mkdirSync(defaultHooks, { recursive: true });

  // Within-bound default hooks stay complete and deterministic.
  fs.writeFileSync(path.join(defaultHooks, "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const baseline = captureContextManifest(root);
  assert.equal(baseline.git.sharedRefIdentity.complete, true);
  assert.match(baseline.git.metadataIdentity, /^[a-f0-9]{64}$/);
  const baselineAgain = captureContextManifest(root);
  assert.equal(baselineAgain.git.metadataIdentity, baseline.git.metadataIdentity);
  assert.equal(
    baselineAgain.git.taskRelevantMetadataIdentity,
    baseline.git.taskRelevantMetadataIdentity
  );

  // --- Default .git/hooks entry bound: 10_000 siblings fail closed ---
  for (let index = 0; index < 10_000; index += 1) {
    fs.writeFileSync(
      path.join(defaultHooks, `h${String(index).padStart(5, "0")}`),
      "x",
      { mode: 0o644 }
    );
  }
  const afterHooksFlood = captureContextManifest(root);
  assert.equal(afterHooksFlood.git.sharedRefIdentity.complete, false);
  assert.equal(afterHooksFlood.git.sharedRefIdentity.attributable, false);
  assert.ok(observeChangedPaths(baseline, afterHooksFlood).includes("[GIT_METADATA]"));
  assert.equal(
    buildRuntimeEvidence({
      preContext: afterHooksFlood,
      postContext: afterHooksFlood,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "fail_closed"
  );
  // Legacy identity must also change under truncation/fail-closed (not hang).
  assert.notEqual(afterHooksFlood.git.metadataIdentity, baseline.git.metadataIdentity);
  const hooksFloodEvidence = JSON.stringify(buildRuntimeEvidence({
    preContext: baseline,
    postContext: afterHooksFlood,
    changedPaths: ["[GIT_METADATA]"]
  }));
  assert.equal(hooksFloodEvidence.includes(defaultHooks), false);
  assert.equal(hooksFloodEvidence.includes(root), false);
  assert.equal(hooksFloodEvidence.includes("h00000"), false);

  // Cleanup hooks flood so refs flood is the dominant bound signal.
  for (const name of fs.readdirSync(defaultHooks)) {
    if (name.startsWith("h") && name.length === 6) {
      try { fs.unlinkSync(path.join(defaultHooks, name)); } catch { /* ignore */ }
    }
  }
  // Keep a single small hook so default hooks remain observable.
  fs.writeFileSync(path.join(defaultHooks, "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const mid = captureContextManifest(root);
  assert.equal(mid.git.sharedRefIdentity.complete, true);

  // --- Default .git/refs entry bound (legacy walk of refs/) ---
  const refsHeads = path.join(root, ".git", "refs", "heads");
  fs.mkdirSync(refsHeads, { recursive: true });
  const oid = "0123456789abcdef0123456789abcdef01234567";
  for (let index = 0; index < 10_000; index += 1) {
    fs.writeFileSync(
      path.join(refsHeads, `flood-${String(index).padStart(5, "0")}`),
      `${oid}\n`
    );
  }
  const afterRefsFlood = captureContextManifest(root);
  // Task-relevant path uses for-each-ref (may still be complete if within
  // shared-ref caps), but legacy metadataIdentity must truncate/fail-closed
  // on the bounded refs walk and differ from the mid baseline.
  assert.notEqual(
    afterRefsFlood.git.metadataIdentity,
    mid.git.metadataIdentity,
    "legacy metadataIdentity must bound default refs walks"
  );
  assert.ok(observeChangedPaths(mid, afterRefsFlood).includes("[GIT_METADATA]"));
  const refsEvidence = JSON.stringify(buildRuntimeEvidence({
    preContext: mid,
    postContext: afterRefsFlood,
    changedPaths: observeChangedPaths(mid, afterRefsFlood)
  }));
  assert.equal(refsEvidence.includes(refsHeads), false);
  assert.equal(refsEvidence.includes("flood-00000"), false);
  assert.equal(refsEvidence.includes(oid), false);
  assert.equal(refsEvidence.includes(root), false);

  // --- Default hooks oversize single file: byte bound without whole-tree hang ---
  // Clean ref flood first to keep subsequent capture focused on hooks bytes.
  for (const name of fs.readdirSync(refsHeads)) {
    if (name.startsWith("flood-")) {
      try { fs.unlinkSync(path.join(refsHeads, name)); } catch { /* ignore */ }
    }
  }
  const afterRefsCleanup = captureContextManifest(root);
  assert.equal(afterRefsCleanup.git.sharedRefIdentity.complete, true);

  const oversizeDefault = path.join(defaultHooks, "oversize-default");
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const fd = fs.openSync(oversizeDefault, "w", 0o755);
  try {
    for (let written = 0; written < 4 * 1024 * 1024; written += chunk.length) {
      fs.writeSync(fd, chunk);
    }
    fs.writeSync(fd, Buffer.from([0x62]));
  } finally {
    fs.closeSync(fd);
  }
  const afterOversizeDefault = captureContextManifest(root);
  assert.equal(afterOversizeDefault.git.sharedRefIdentity.complete, false);
  assert.notEqual(afterOversizeDefault.git.metadataIdentity, afterRefsCleanup.git.metadataIdentity);
  assert.ok(observeChangedPaths(afterRefsCleanup, afterOversizeDefault).includes("[GIT_METADATA]"));
  assert.equal(
    buildRuntimeEvidence({
      preContext: afterOversizeDefault,
      postContext: afterOversizeDefault,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "fail_closed"
  );
  const oversizeEvidence = JSON.stringify(buildRuntimeEvidence({
    preContext: afterRefsCleanup,
    postContext: afterOversizeDefault,
    changedPaths: ["[GIT_METADATA]"]
  }));
  assert.equal(oversizeEvidence.includes(oversizeDefault), false);
  assert.equal(oversizeEvidence.includes(defaultHooks), false);
});

test("core.hooksPath unset/relative/absolute/include resolution stays Git-faithful (issue #34)", () => {
  // Helper: privacy is enforced on the public/runtime evidence surface, not on
  // the private ContextManifest (which intentionally retains workspaceRoot).
  const publicEvidence = (pre, post, changedPaths = ["[GIT_METADATA]"]) => JSON.stringify(
    buildRuntimeEvidence({ preContext: pre, postContext: post, changedPaths })
  );

  // --- Unset: default $GIT_DIR/hooks remains complete; public evidence private ---
  const rootUnset = initRepo();
  const unsetManifest = captureContextManifest(rootUnset);
  assert.equal(unsetManifest.git.sharedRefIdentity.complete, true);
  assert.match(unsetManifest.git.taskRelevantMetadataIdentity, /^[a-f0-9]{64}$/);
  // Private manifests carry workspaceRoot by design; public/runtime evidence must not.
  assert.equal(typeof unsetManifest.workspaceRoot, "string");
  const unsetEvidence = publicEvidence(unsetManifest, unsetManifest, []);
  assert.equal(unsetEvidence.includes(rootUnset), false);
  assert.equal(unsetEvidence.includes(".git/hooks"), false);
  assert.equal(unsetEvidence.includes(unsetManifest.workspaceRoot), false);

  // --- Relative core.hooksPath: config value may stay relative; effective is absolute ---
  const rootRel = initRepo();
  const relName = "rel-hooks-dir";
  git(rootRel, "config", "core.hooksPath", relName);
  const relConfigured = git(rootRel, "config", "--includes", "--path", "--get", "core.hooksPath");
  const relEffective = git(rootRel, "rev-parse", "--path-format=absolute", "--git-path", "hooks");
  assert.ok(path.isAbsolute(relEffective), "rev-parse --git-path hooks must be absolute");
  // Host Git keeps relative configured values; do not require --path to absolute-expand.
  assert.equal(
    path.isAbsolute(relConfigured),
    false,
    "expected relative configured core.hooksPath on this Git (host repro)"
  );
  assert.equal(relConfigured, relName);
  // Worktree-root/cwd semantics for the unresolved candidate (matches production).
  const relCandidate = path.resolve(rootRel, relConfigured);
  fs.mkdirSync(relCandidate, { recursive: true });
  fs.writeFileSync(path.join(relCandidate, "pre-commit"), "#!/bin/sh\necho rel-v1\nexit 0\n", {
    mode: 0o755
  });
  assert.equal(
    path.resolve(fs.realpathSync(relCandidate)),
    path.resolve(fs.realpathSync(relEffective)),
    "relative candidate must realpath-match authoritative effective hooks path"
  );
  const beforeRel = captureContextManifest(rootRel);
  assert.equal(beforeRel.git.sharedRefIdentity.complete, true);
  fs.writeFileSync(path.join(relCandidate, "pre-commit"), "#!/bin/sh\necho rel-v2\nexit 1\n", {
    mode: 0o755
  });
  const afterRel = captureContextManifest(rootRel);
  assert.notEqual(
    afterRel.git.taskRelevantMetadataIdentity,
    beforeRel.git.taskRelevantMetadataIdentity,
    "relative hooksPath content must bind task-relevant identity"
  );
  assert.ok(observeChangedPaths(beforeRel, afterRel).includes("[GIT_METADATA]"));
  const relEvidence = publicEvidence(beforeRel, afterRel);
  assert.equal(relEvidence.includes(relCandidate), false);
  assert.equal(relEvidence.includes(relEffective), false);
  assert.equal(relEvidence.includes(relName), false);
  assert.equal(relEvidence.includes(rootRel), false);
  assert.equal(relEvidence.includes("rel-v2"), false);

  // --- Absolute regular directory (non-symlink) still complete and private ---
  const rootAbs = initRepo();
  const absHooks = path.join(fs.realpathSync(tempDir("grok-plugin-abs-hooks-")), "hooks");
  fs.mkdirSync(absHooks, { recursive: true });
  fs.writeFileSync(path.join(absHooks, "pre-commit"), "#!/bin/sh\necho abs-v1\nexit 0\n", {
    mode: 0o755
  });
  git(rootAbs, "config", "core.hooksPath", absHooks);
  const beforeAbs = captureContextManifest(rootAbs);
  assert.equal(beforeAbs.git.sharedRefIdentity.complete, true);
  fs.writeFileSync(path.join(absHooks, "pre-commit"), "#!/bin/sh\necho abs-v2\nexit 1\n", {
    mode: 0o755
  });
  const afterAbs = captureContextManifest(rootAbs);
  assert.notEqual(afterAbs.git.taskRelevantMetadataIdentity, beforeAbs.git.taskRelevantMetadataIdentity);
  assert.ok(observeChangedPaths(beforeAbs, afterAbs).includes("[GIT_METADATA]"));
  const absEvidence = publicEvidence(beforeAbs, afterAbs);
  assert.equal(absEvidence.includes(absHooks), false);
  assert.equal(absEvidence.includes(rootAbs), false);

  // --- Include-derived core.hooksPath (absolute) ---
  const rootInc = initRepo();
  const includeDir = fs.realpathSync(tempDir("grok-plugin-hooks-include-"));
  const includedConfig = path.join(includeDir, "hooks.gitconfig");
  const includedHooks = path.join(includeDir, "included-hooks");
  fs.mkdirSync(includedHooks, { recursive: true });
  fs.writeFileSync(path.join(includedHooks, "pre-commit"), "#!/bin/sh\necho inc-v1\nexit 0\n", {
    mode: 0o755
  });
  fs.writeFileSync(
    includedConfig,
    `[core]\n\thooksPath = ${includedHooks}\n`
  );
  fs.appendFileSync(
    path.join(rootInc, ".git", "config"),
    `\n[include]\n\tpath = ${includedConfig}\n`
  );
  // Explicit includes: Git must surface the included absolute hooksPath.
  const includedConfigured = git(rootInc, "config", "--includes", "--path", "--get", "core.hooksPath");
  assert.equal(path.resolve(includedConfigured), path.resolve(includedHooks));
  const beforeInc = captureContextManifest(rootInc);
  assert.equal(beforeInc.git.sharedRefIdentity.complete, true);
  fs.writeFileSync(path.join(includedHooks, "pre-commit"), "#!/bin/sh\necho inc-v2\nexit 1\n", {
    mode: 0o755
  });
  const afterInc = captureContextManifest(rootInc);
  assert.notEqual(
    afterInc.git.taskRelevantMetadataIdentity,
    beforeInc.git.taskRelevantMetadataIdentity,
    "include-derived hooksPath content must bind task-relevant identity"
  );
  assert.ok(observeChangedPaths(beforeInc, afterInc).includes("[GIT_METADATA]"));
  const incEvidence = publicEvidence(beforeInc, afterInc);
  assert.equal(incEvidence.includes(includedHooks), false);
  assert.equal(incEvidence.includes(includedConfig), false);
  assert.equal(incEvidence.includes(includeDir), false);
  assert.equal(incEvidence.includes("inc-v2"), false);

  // --- Relative directory symlink: hop observation + retarget drift ---
  const rootRelLink = initRepo();
  const relParent = fs.realpathSync(tempDir("grok-plugin-rel-link-hooks-"));
  const relReal = path.join(relParent, "real-hooks");
  const relLinkName = "link-hooks";
  fs.mkdirSync(relReal, { recursive: true });
  fs.writeFileSync(path.join(relReal, "pre-commit"), "#!/bin/sh\necho rellink-v1\nexit 0\n", {
    mode: 0o755
  });
  git(rootRelLink, "config", "core.hooksPath", relLinkName);
  const relLinkConfigured = git(
    rootRelLink,
    "config",
    "--includes",
    "--path",
    "--get",
    "core.hooksPath"
  );
  assert.equal(path.isAbsolute(relLinkConfigured), false, "relative symlink hooksPath stays relative");
  assert.equal(relLinkConfigured, relLinkName);
  const relLinkCandidate = path.resolve(rootRelLink, relLinkConfigured);
  try { fs.rmSync(relLinkCandidate, { recursive: true, force: true }); } catch { /* absent ok */ }
  fs.symlinkSync(relReal, relLinkCandidate);
  const relLinkEffective = git(
    rootRelLink,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "hooks"
  );
  assert.ok(path.isAbsolute(relLinkEffective));
  assert.equal(
    path.resolve(fs.realpathSync(relLinkCandidate)),
    path.resolve(fs.realpathSync(relLinkEffective)),
    "relative directory-symlink candidate must realpath-match effective hooks path"
  );
  const beforeRelLink = captureContextManifest(rootRelLink);
  assert.equal(beforeRelLink.git.sharedRefIdentity.complete, true);
  // Retarget the relative symlink hop; identity must drift (link digest / target).
  fs.unlinkSync(relLinkCandidate);
  const relRealB = path.join(relParent, "real-hooks-b");
  fs.mkdirSync(relRealB, { recursive: true });
  fs.writeFileSync(path.join(relRealB, "pre-commit"), "#!/bin/sh\necho rellink-v2\nexit 1\n", {
    mode: 0o755
  });
  fs.symlinkSync(relRealB, relLinkCandidate);
  const afterRelLink = captureContextManifest(rootRelLink);
  assert.notEqual(
    afterRelLink.git.taskRelevantMetadataIdentity,
    beforeRelLink.git.taskRelevantMetadataIdentity,
    "relative directory-symlink retarget must change task-relevant identity"
  );
  assert.ok(observeChangedPaths(beforeRelLink, afterRelLink).includes("[GIT_METADATA]"));
  // Stable re-capture after retarget remains deterministic.
  const afterRelLinkAgain = captureContextManifest(rootRelLink);
  assert.equal(
    afterRelLinkAgain.git.taskRelevantMetadataIdentity,
    afterRelLink.git.taskRelevantMetadataIdentity
  );
  const relLinkEvidence = publicEvidence(beforeRelLink, afterRelLink);
  assert.equal(relLinkEvidence.includes(relReal), false);
  assert.equal(relLinkEvidence.includes(relRealB), false);
  assert.equal(relLinkEvidence.includes(relLinkCandidate), false);
  assert.equal(relLinkEvidence.includes(relLinkEffective), false);
  assert.equal(relLinkEvidence.includes(relLinkName), false);
  assert.equal(relLinkEvidence.includes(relParent), false);
  assert.equal(relLinkEvidence.includes(rootRelLink), false);
  assert.equal(relLinkEvidence.includes("rellink-v2"), false);
});

test("shared-ref identity support is fail-closed for legacy, mixed, malformed, and incomplete (issue #34)", () => {
  const root = initRepo();
  const current = captureContextManifest(root);
  assert.match(current.git.taskRelevantMetadataIdentity, /^[a-f0-9]{64}$/);

  // Pure legacy both sides: full metadataIdentity remains strict.
  const legacyBefore = {
    git: {
      head: current.git.head,
      trackedTreeIdentity: current.git.trackedTreeIdentity,
      metadataIdentity: "legacy-meta-a",
      dirtyDigest: current.git.dirtyDigest,
      dirtyEntries: [],
      ignoredDigest: current.git.ignoredDigest
    }
  };
  const legacyAfterSame = {
    git: { ...legacyBefore.git }
  };
  const legacyAfterDiff = {
    git: { ...legacyBefore.git, metadataIdentity: "legacy-meta-b" }
  };
  assert.deepEqual(observeChangedPaths(legacyBefore, legacyAfterSame), []);
  assert.deepEqual(observeChangedPaths(legacyBefore, legacyAfterDiff), ["[GIT_METADATA]"]);
  assert.equal(
    buildRuntimeEvidence({
      preContext: legacyBefore,
      postContext: legacyAfterDiff,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "legacy_metadata_drift"
  );

  // Mixed with differing legacy digests → fail closed.
  const mixedLegacy = {
    git: {
      head: current.git.head,
      trackedTreeIdentity: current.git.trackedTreeIdentity,
      metadataIdentity: `mixed-${current.git.metadataIdentity}`,
      dirtyDigest: current.git.dirtyDigest,
      dirtyEntries: [],
      ignoredDigest: current.git.ignoredDigest
    }
  };
  assert.ok(observeChangedPaths(mixedLegacy, current).includes("[GIT_METADATA]"));
  assert.equal(
    buildRuntimeEvidence({
      preContext: mixedLegacy,
      postContext: current,
      changedPaths: observeChangedPaths(mixedLegacy, current)
    }).sharedRefObservation.classification,
    "fail_closed"
  );

  // AC-F1: Mixed with equal legacy metadataIdentity still fails closed.
  const mixedSameDigest = {
    git: {
      head: current.git.head,
      trackedTreeIdentity: current.git.trackedTreeIdentity,
      metadataIdentity: current.git.metadataIdentity,
      dirtyDigest: current.git.dirtyDigest,
      dirtyEntries: [],
      ignoredDigest: current.git.ignoredDigest
    }
  };
  assert.deepEqual(observeChangedPaths(mixedSameDigest, current), ["[GIT_METADATA]"]);
  assert.deepEqual(
    buildRuntimeEvidence({
      preContext: mixedSameDigest,
      postContext: current,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation,
    {
      schemaVersion: 1,
      classification: "fail_closed",
      toleratedUnrelatedSharedRefChurn: false,
      taskRelevantMetadataDrift: true
    }
  );

  // Malformed: claims new fields but incomplete/invalid structure.
  const malformed = {
    git: {
      ...current.git,
      taskRelevantMetadataIdentity: "not-a-digest",
      sharedRefIdentity: { schemaVersion: 1 }
    }
  };
  const malformedAfter = {
    git: {
      ...malformed.git,
      metadataIdentity: `mutated-${current.git.metadataIdentity}`
    }
  };
  assert.ok(observeChangedPaths(malformed, malformedAfter).includes("[GIT_METADATA]"));
  assert.equal(
    buildRuntimeEvidence({
      preContext: malformed,
      postContext: malformedAfter,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "fail_closed"
  );

  // AC-F1: Malformed with equal legacy metadataIdentity still fails closed.
  const malformedSameDigest = {
    git: {
      ...current.git,
      taskRelevantMetadataIdentity: "not-a-digest",
      sharedRefIdentity: { schemaVersion: 1 }
    }
  };
  const malformedSameDigestAfter = {
    git: {
      ...malformedSameDigest.git
      // same metadataIdentity, same everything else
    }
  };
  assert.deepEqual(
    observeChangedPaths(malformedSameDigest, malformedSameDigestAfter),
    ["[GIT_METADATA]"]
  );
  assert.deepEqual(
    buildRuntimeEvidence({
      preContext: malformedSameDigest,
      postContext: malformedSameDigestAfter,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation,
    {
      schemaVersion: 1,
      classification: "fail_closed",
      toleratedUnrelatedSharedRefChurn: false,
      taskRelevantMetadataDrift: true
    }
  );

  // Incomplete (truncated) snapshots fail closed even when digests match.
  const incomplete = {
    git: {
      ...current.git,
      sharedRefIdentity: {
        ...current.git.sharedRefIdentity,
        complete: false,
        attributable: false,
        taskRelevantRefs: [],
        unrelatedRefs: []
      }
    }
  };
  assert.ok(observeChangedPaths(incomplete, incomplete).includes("[GIT_METADATA]"));
  assert.equal(
    buildRuntimeEvidence({
      preContext: incomplete,
      postContext: incomplete,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "fail_closed"
  );

  // AC-F2 / AC-5: primary complete-but-unattributable is strict (no linked
  // tolerance) but identical digests pass — attribution is linked-only.
  const unattributableBase = {
    git: {
      ...current.git,
      linkedWorktree: false,
      sharedRefIdentity: {
        schemaVersion: 1,
        complete: true,
        attributable: false,
        refCount: 2001,
        taskRelevantRefCount: 1,
        unrelatedRefCount: 2000,
        taskRelevantRefIdentity: current.git.sharedRefIdentity.taskRelevantRefIdentity,
        unrelatedRefIdentity: "a".repeat(64),
        taskRelevantRefs: [],
        unrelatedRefs: []
      }
    }
  };
  const unattributableUnrelatedChurn = {
    git: {
      ...unattributableBase.git,
      sharedRefIdentity: {
        ...unattributableBase.git.sharedRefIdentity,
        unrelatedRefIdentity: "b".repeat(64)
      }
    }
  };
  assert.deepEqual(
    observeChangedPaths(unattributableBase, unattributableUnrelatedChurn),
    ["[GIT_METADATA]"]
  );
  assert.deepEqual(
    buildRuntimeEvidence({
      preContext: unattributableBase,
      postContext: unattributableUnrelatedChurn,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation,
    {
      schemaVersion: 1,
      classification: "task_relevant_metadata_drift",
      toleratedUnrelatedSharedRefChurn: false,
      taskRelevantMetadataDrift: true
    }
  );
  // Primary complete-but-unattributable identical manifests pass strict compare.
  assert.equal(observeChangedPaths(unattributableBase, unattributableBase).includes("[GIT_METADATA]"), false);
  // Linked complete-but-unattributable still fails closed (no tolerance without attribution).
  const linkedUnattributable = {
    git: {
      ...unattributableBase.git,
      linkedWorktree: true
    }
  };
  assert.equal(
    buildRuntimeEvidence({
      preContext: linkedUnattributable,
      postContext: linkedUnattributable,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "fail_closed"
  );

  // Structurally impossible attributable flags remain fail-closed (malformed).
  const badAttributable = {
    git: {
      ...current.git,
      sharedRefIdentity: {
        ...current.git.sharedRefIdentity,
        attributable: true,
        complete: true,
        refCount: 1,
        taskRelevantRefCount: 1,
        unrelatedRefCount: 0,
        taskRelevantRefs: [],
        unrelatedRefs: []
      }
    }
  };
  const badAttributableAfter = {
    git: {
      ...badAttributable.git,
      metadataIdentity: `attr-${current.git.metadataIdentity}`
    }
  };
  assert.ok(observeChangedPaths(badAttributable, badAttributableAfter).includes("[GIT_METADATA]"));
  // Same-digest malformed attributable shape also fails closed.
  assert.deepEqual(
    observeChangedPaths(badAttributable, badAttributable),
    ["[GIT_METADATA]"]
  );

  // AC-F3: configured upstream without positively resolved full refs/ name
  // forces capture to mark shared-ref support incomplete/unattributable so the
  // remote cannot be classed as unrelated.
  // Plant branch.*.remote/merge without creating the remote-tracking ref so
  // @{upstream} cannot resolve while config still declares an upstream.
  const remote = tempDir("grok-plugin-unresolved-upstream-");
  git(root, "remote", "add", "origin", remote);
  git(root, "config", "branch.main.remote", "origin");
  git(root, "config", "branch.main.merge", "refs/heads/main");
  // Intentionally do not create refs/remotes/origin/main.
  const unresolvedCapture = captureContextManifest(root);
  assert.equal(unresolvedCapture.git.sharedRefIdentity.complete, false);
  assert.equal(unresolvedCapture.git.sharedRefIdentity.attributable, false);
  assert.ok(observeChangedPaths(unresolvedCapture, unresolvedCapture).includes("[GIT_METADATA]"));
  assert.equal(
    buildRuntimeEvidence({
      preContext: unresolvedCapture,
      postContext: unresolvedCapture,
      changedPaths: ["[GIT_METADATA]"]
    }).sharedRefObservation.classification,
    "fail_closed"
  );
  // Unrelated-looking remote-tracking churn must not be tolerated while support
  // is incomplete from unresolved upstream classification.
  const head = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/other", head);
  const afterUnrelatedWhileUnresolved = captureContextManifest(root);
  assert.equal(afterUnrelatedWhileUnresolved.git.sharedRefIdentity.complete, false);
  assert.ok(
    observeChangedPaths(unresolvedCapture, afterUnrelatedWhileUnresolved).includes("[GIT_METADATA]")
  );

  // Positive control: fully resolved upstream remains complete + attributable.
  git(root, "update-ref", "refs/remotes/origin/main", head);
  git(root, "branch", "--set-upstream-to=origin/main", "main");
  const resolvedUpstream = captureContextManifest(root);
  assert.ok(resolvedUpstream.git.upstreamRef);
  assert.equal(resolvedUpstream.git.sharedRefIdentity.complete, true);
  assert.equal(resolvedUpstream.git.sharedRefIdentity.attributable, true);
  assert.equal(
    observeChangedPaths(resolvedUpstream, resolvedUpstream).includes("[GIT_METADATA]"),
    false
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
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(root, "pyproject.toml"), "[project]\nname = \"fixture\"\n");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Fixture guidance\n");
  fs.writeFileSync(path.join(root, ".github", "workflows", "quality.yml"), "name: quality\n");
  git(root, "add", "pyproject.toml", "AGENTS.md", ".github/workflows/quality.yml");
  git(root, "commit", "-m", "add project markers");
  const manifest = captureContextManifest(root);
  assert.deepEqual(manifest.projectMarkers, ["pyproject.toml"]);
  const complete = buildTaskEnvelope({
    userRequest: "inspect the whole project",
    context: {
      workspaceState: "complete",
      upstreamFreshness: "not_checked",
      expectedProjectMarkers: ["pyproject.toml", "AGENTS.md", ".github/workflows/quality.yml"]
    }
  });
  assert.throws(
    () => assertTaskContextReady(complete, manifest, { structuredInput: true }),
    (error) => error?.code === "E_CONTEXT_INCOMPLETE" && /upstream-freshness-not-verified/.test(error.message)
  );

  const verifiedComplete = buildTaskEnvelope({
    userRequest: "inspect all declared project markers",
    context: {
      workspaceState: "complete",
      upstreamFreshness: "verified",
      expectedProjectMarkers: ["pyproject.toml", "AGENTS.md", ".github/workflows/quality.yml"]
    }
  });
  assert.doesNotThrow(() => assertTaskContextReady(verifiedComplete, manifest, { structuredInput: true }));

  const linkedParent = tempDir("grok-plugin-linked-parent-");
  const linkedRoot = path.join(linkedParent, "checkout");
  git(root, "worktree", "add", "-b", "linked-fixture", linkedRoot);
  const linkedManifest = captureContextManifest(linkedRoot);
  assert.deepEqual(linkedManifest.projectMarkers, ["pyproject.toml"]);
  assert.doesNotThrow(() => assertTaskContextReady(verifiedComplete, linkedManifest, { structuredInput: true }));

  const scoped = buildTaskEnvelope({
    userRequest: "inspect the available package",
    context: {
      workspaceState: "task_scoped",
      upstreamFreshness: "not_checked",
      expectedProjectMarkers: ["pyproject.toml", "AGENTS.md"],
      requiredPaths: ["tracked.txt", "pyproject.toml"]
    }
  });
  assert.doesNotThrow(() => assertTaskContextReady(scoped, manifest, { structuredInput: true }));

  const missingMarker = buildTaskEnvelope({
    userRequest: "inspect a project with a missing marker",
    context: {
      workspaceState: "task_scoped",
      expectedProjectMarkers: ["docs/missing-marker.md"],
      requiredPaths: ["tracked.txt"]
    }
  });
  assert.throws(
    () => assertTaskContextReady(missingMarker, manifest, { structuredInput: true }),
    (error) => error?.code === "E_CONTEXT_INCOMPLETE"
      && error.details?.missingMarkers?.includes("docs/missing-marker.md")
      && error.details?.reasons?.includes("missing-project-markers:docs/missing-marker.md")
      && !/Complete host preflight/.test(error.message)
  );

  for (const marker of [
    "/tmp/outside",
    "C:\\outside",
    "C:outside",
    "nested/../outside",
    "file:///etc/passwd",
    "././https://example.test/marker",
    "~/outside",
    "a".repeat(1025)
  ]) {
    assert.throws(
      () => buildTaskEnvelope({
        userRequest: "reject an unsafe project marker",
        context: { expectedProjectMarkers: [marker] }
      }),
      (error) => error?.code === "E_USAGE"
    );
  }

  fs.mkdirSync(path.join(root, "marker-links"));
  fs.symlinkSync("../AGENTS.md", path.join(root, "marker-links", "internal"));
  const externalMarker = path.join(tempDir("grok-plugin-external-marker-"), "marker.txt");
  fs.writeFileSync(externalMarker, "outside\n");
  fs.symlinkSync(externalMarker, path.join(root, "marker-links", "external"));
  const internalSymlinkMarker = buildTaskEnvelope({
    userRequest: "accept an internal project marker symlink",
    context: {
      workspaceState: "task_scoped",
      expectedProjectMarkers: ["marker-links/internal"],
      requiredPaths: ["tracked.txt"]
    }
  });
  assert.doesNotThrow(() => assertTaskContextReady(internalSymlinkMarker, manifest, { structuredInput: true }));
  const escapingSymlinkMarker = buildTaskEnvelope({
    userRequest: "reject an escaping project marker symlink",
    context: {
      workspaceState: "task_scoped",
      expectedProjectMarkers: ["marker-links/external"],
      requiredPaths: ["tracked.txt"]
    }
  });
  assert.throws(
    () => assertTaskContextReady(escapingSymlinkMarker, manifest, { structuredInput: true }),
    (error) => error?.code === "E_CONTEXT_INCOMPLETE"
      && error.details?.unsafeMarkers?.includes("marker-links/external")
      && error.details?.reasons?.includes("project-markers-escape-workspace:marker-links/external")
  );

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
      requiredPaths: ["src", "pyproject.toml"]
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

test("native Grok Build worker reports take precedence and bind a canonical digest", () => {
  const criteria = [
    { id: "AC-01", text: "First" },
    { id: "AC-02", text: "Second" }
  ];
  const native = {
    outcome: "complete",
    summary: "native report",
    changedFiles: ["target.txt"],
    checksClaimed: ["checked target.txt"],
    acceptanceResults: criteria.map(({ id }) => ({ id, status: "met" })),
    risks: [],
    questions: [],
    hostActionRequest: null
  };
  const report = buildWorkerReport({
    providerText: workerReport({ summary: "contradictory marker report" }),
    nativeStructuredOutput: native,
    acceptanceCriteria: criteria
  });
  assert.equal(report.valid, true);
  assert.equal(report.structured, true);
  assert.equal(report.summary, "native report");
  assert.equal(report.reportSource, "acp-structured");
  assert.match(report.reportDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    buildWorkerReport({
      nativeStructuredOutput: structuredClone(native),
      acceptanceCriteria: criteria
    }).reportDigest,
    report.reportDigest
  );

  const failedNative = buildWorkerReport({
    providerText: workerReport({
      summary: "valid marker must not downgrade an explicit native error",
      acceptanceResults: criteria.map(({ id }) => ({ id, status: "met" }))
    }),
    nativeStructuredOutputError: "schema mismatch",
    acceptanceCriteria: criteria
  });
  assert.equal(failedNative.valid, false);
  assert.equal(failedNative.reportSource, "acp-structured-error");
  assert.equal(failedNative.reportDigest, null);

  const schema = buildWorkerReportOutputSchema(criteria);
  assert.deepEqual(schema.required, [
    "outcome",
    "summary",
    "changedFiles",
    "checksClaimed",
    "acceptanceResults",
    "risks",
    "questions",
    "hostActionRequest"
  ]);
  assert.deepEqual(
    schema.properties.acceptanceResults.items.properties.id.enum,
    ["AC-01", "AC-02"]
  );
});

test("report repair prompt forbids tool use and is marker-bound and acceptance-complete", () => {
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

test("provider formatter and setup profiles expose only compatibility plan state", () => {
  for (const [file, name, description] of [
    [
      "report-repair.md",
      "grok-companion-report-repair",
      "No-workspace formatter for a completed Grok Companion task report."
    ],
    [
      "setup-probe.md",
      "grok-companion-setup-probe",
      "Restricted no-workspace ACP setup probe agent for Grok Companion."
    ]
  ]) {
    const text = fs.readFileSync(
      path.join(ROOT, "plugins/grok/provider-agents", file),
      "utf8"
    );
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)?.[1] || "";
    assert.equal(frontmatter, [
      `name: ${name}`,
      `description: ${description}`,
      "prompt_mode: full",
      "permission_mode: dontAsk",
      "agents_md: false",
      "injectDefaultTools: false",
      "toolConfig:",
      "  tools:",
      "    - id: GrokBuild:todo_write"
    ].join("\n"));
    assert.match(frontmatter, /^permission_mode:\s*dontAsk$/m);
    assert.match(frontmatter, /^injectDefaultTools:\s*false$/m);
    assert.deepEqual(
      [...frontmatter.matchAll(/^\s+- id:\s*(\S+)\s*$/gm)].map((match) => match[1]),
      ["GrokBuild:todo_write"]
    );
    assert.doesNotMatch(
      frontmatter,
      /GrokBuild:(?:read_file|list_dir|grep|search_replace|run_terminal_cmd|web_search|web_fetch|task|ask_user_question)/
    );
    assert.match(text, /never invoke it/i);
  }
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

test("rescue skill remediates only the exact missing capability-receipt admission error", () => {
  const rescue = fs.readFileSync(path.join(ROOT, "plugins/grok/skills/rescue/SKILL.md"), "utf8");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const companion = fs.readFileSync(path.join(ROOT, "plugins/grok/scripts/grok-companion.mjs"), "utf8");
  const hostLib = fs.readFileSync(path.join(ROOT, "plugins/grok/scripts/lib/host.mjs"), "utf8");
  const canonicalCodex = missingInvalidProviderCapabilityReceiptMessage({
    CODEX_THREAD_ID: "codex-thread"
  });
  const canonicalClaude = missingInvalidProviderCapabilityReceiptMessage({
    GROK_COMPANION_CLAUDE_SESSION_ID: "claude-session"
  });

  // AC-1: single helper source of truth; both emitters use it; skill/docs bind to canonical forms.
  assert.match(hostLib, /export function missingInvalidProviderCapabilityReceiptMessage/);
  assert.equal(companion.split("missingInvalidProviderCapabilityReceiptMessage(").length - 1, 2);
  assert.equal(companion.includes("Valid provider capability receipt is missing or invalid; run"), false);
  assert.equal(
    canonicalCodex,
    "Valid provider capability receipt is missing or invalid; run $grok:setup before admitting a Codex task."
  );
  assert.equal(
    canonicalClaude,
    "Valid provider capability receipt is missing or invalid; run /grok:setup before admitting a Codex task."
  );
  assert.ok(rescue.includes(canonicalCodex));
  assert.ok(readme.includes(canonicalCodex));
  assert.match(rescue, /missingInvalidProviderCapabilityReceiptMessage/);
  assert.match(rescue, /Recoverable exact match only/i);
  assert.match(rescue, /Do \*\*not\*\* auto-setup for arbitrary `E_CAPABILITY`/i);
  assert.match(rescue, /unsupported model, effort, platform, executable identity, provider capability drift/i);
  assert.match(rescue, /sole host-local variable is the setup command token/i);

  // AC-2: setup success → one identical bounded task retry; preserve envelope bounds.
  assert.match(rescue, /authoritative setup action \*\*at most once\*\*/i);
  assert.match(rescue, /node <resolved-grok-codex\.mjs> setup/);
  assert.match(rescue, /Setup success:[\s\S]*?identical\*\* bounded task launch \*\*exactly once\*\*/i);
  assert.match(rescue, /Preserve the original TaskEnvelope/i);
  assert.match(
    rescue,
    /same user request, objective, scope, mode, freshness facts, model, effort, acceptance criteria/i
  );
  assert.match(rescue, /process\/PTY framing, and write profile/i);
  assert.match(rescue, /Do not start a concurrent second process/i);
  assert.match(rescue, /do not re-run setup before or after this single retry/i);

  // AC-3: setup failure surfaces unchanged and stops without task retry or fallback concealment.
  assert.match(
    rescue,
    /Setup failure:[\s\S]*?surface the setup failure unchanged and \*\*stop\*\*/i
  );
  assert.match(rescue, /Do not retry the task[\s\S]*?do not conceal the failure via worker fallback/i);

  // AC-4: persistent receipt error or any non-receipt E_CAPABILITY stays terminal + fallback-eligible.
  assert.match(
    rescue,
    /Persistent receipt error after that one retry[\s\S]*?any non-receipt `E_CAPABILITY`[\s\S]*?\*\*terminal\*\* and eligible for the documented fallback policy/i
  );
  assert.match(rescue, /Do not auto-setup again; do not auto-retry again/i);

  // AC-5 / AC-6 bounds: pre-launch receipt gate; status --readonly is neither capability nor writability.
  assert.match(rescue, /fail-closed pre-launch provider capability receipt gate/i);
  assert.match(
    rescue,
    /Pure `status --readonly` is neither a capability check nor a writability check/i
  );
  assert.match(readme, /pre-launch provider capability receipt gate/i);
  assert.match(
    readme,
    /status --readonly`?\s*is neither a capability check nor a writability check/i
  );
  assert.match(readme, /any other `E_CAPABILITY` message/);
  assert.match(readme, /exact setup-recoverable message only/);
  assert.match(readme, /\*\*Sole setup-recoverable path:\*\*/i);
  assert.match(rescue, /One setup, one identical retry, no duplicate launch/i);
  assert.match(rescue, /E_STORAGE_READONLY/);
});

test("integration: Codex nonblocking stdin accepts arbitrary markers and records verification", {
  skip: process.platform === "win32" && "nonblocking fd regression harness is POSIX-only"
}, async (t) => {
  const root = initRepo();
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(root, "pyproject.toml"), "[project]\nname = \"fixture\"\n");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Fixture guidance\n");
  fs.writeFileSync(path.join(root, ".github", "workflows", "quality.yml"), "name: quality\n");
  git(root, "add", "pyproject.toml", "AGENTS.md", ".github/workflows/quality.yml");
  git(root, "commit", "-m", "add arbitrary project markers");
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
  const pinned = installPinnedFakeCompanion(fake, env);
  t.after(pinned.cleanup);
  const setup = runCompanion(["setup", "--json"], {
    cwd: root,
    env: pinned.env,
    companionScript: pinned.codexCompanionScript
  });
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  assert.equal(JSON.parse(setup.stdout).ready, true);
  const providerStartsAfterSetup = readFakeLog(fake.logFile).filter(
    (entry) => entry.event === "argv"
      && entry.args.includes("agent")
      && entry.args.includes("stdio")
  ).length;
  assert.equal(providerStartsAfterSetup, 1);

  const envelope = JSON.stringify({
    schemaVersion: 1,
    userRequest: "analyze issue #2 without editing the checkout",
    objective: "Prove Codex can dispatch after the process starts with empty nonblocking stdin",
    mode: "read",
    scope: { include: [], exclude: [] },
    context: {
      facts: ["The host writes the envelope after process creation."],
      constraints: ["Keep the checkout unchanged."],
      expectedProjectMarkers: ["pyproject.toml", "AGENTS.md", ".github/workflows/quality.yml"],
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
    pinned.codexCompanionScript,
    ["task", "--background", "--envelope-stdin", "--stdin-ready", "--fresh", "--effort", "high", "--json"],
    { cwd: root, env: pinned.env }
  );

  await waitFor(() => dispatch.stderr.includes(STDIN_READY_MARKER), { timeoutMs: 15000 });
  assert.equal(dispatch.child.exitCode, null, "dispatch exited before Codex could write the TaskEnvelope");
  const providerStartsBeforeInput = readFakeLog(fake.logFile).filter(
    (entry) => entry.event === "argv" && entry.args.includes("agent") && entry.args.includes("stdio")
  );
  assert.equal(providerStartsBeforeInput.length, providerStartsAfterSetup);
  const split = Math.floor(envelope.length / 2);
  dispatch.child.stdin.write(envelope.slice(0, split));
  await new Promise((resolve) => setTimeout(resolve, 25));
  dispatch.child.stdin.end(envelope.slice(split));
  const dispatched = await dispatch.completed;
  assert.equal(dispatched.code, 0, dispatched.stderr || dispatched.stdout);
  assert.equal(dispatched.stdinError, null);
  const job = JSON.parse(dispatched.stdout);
  assert.ok(job.id);

  const terminalStatus = runCompanion(
    ["status", job.id, "--wait", "--timeout-ms", "30000", "--json"],
    {
      cwd: root,
      env: pinned.env,
      timeout: 45_000,
      companionScript: pinned.codexCompanionScript
    }
  );
  assert.equal(terminalStatus.status, 0, terminalStatus.stderr || terminalStatus.stdout);
  const terminal = JSON.parse(terminalStatus.stdout);
  assert.equal(terminal.status, "completed");
  const providerStarts = readFakeLog(fake.logFile).filter(
    (entry) => entry.event === "argv" && entry.args.includes("agent") && entry.args.includes("stdio")
  );
  assert.equal(providerStarts.length, providerStartsAfterSetup + 1);

  const verification = JSON.stringify({
    commandOutcomes: [{ command: "git status --short", status: "passed", exitCode: 0 }]
  });
  const record = spawnNonblockingStdin(
    pinned.codexCompanionScript,
    ["record-verification", job.id, "--verification-stdin", "--stdin-ready", "--json"],
    { cwd: root, env: pinned.env }
  );
  await waitFor(() => record.stderr.includes(STDIN_READY_MARKER), { timeoutMs: 15000 });
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
  const promptRequests = readFakeLog(fake.logFile).filter(
    (entry) => entry.event === "rpc" && entry.message?.method === "session/prompt"
  );
  assert.equal(promptRequests.length, 2);
  assert.equal(
    typeof promptRequests[1].message.params?._meta?.outputSchema,
    "object"
  );
  const invocations = readFakeLog(fake.logFile).filter((entry) => entry.event === "argv" && entry.args.includes("agent"));
  assert.equal(invocations.length, 2);
  const repairProfileIndex = invocations[1].args.indexOf("--agent-profile");
  const stagedRepairProfile = invocations[1].args[repairProfileIndex + 1];
  assert.equal(fs.existsSync(stagedRepairProfile), false, "repair profile remained after verified provider exit");
  const repairProfile = fs.readFileSync(path.join(ROOT, "plugins/grok/provider-agents/report-repair.md"), "utf8");
  assert.match(repairProfile, /name: grok-companion-report-repair/);
  assert.match(repairProfile, /tools:\s*\n\s+- id: GrokBuild:todo_write/);
  assert.equal((repairProfile.match(/^\s+- id:/gm) || []).length, 1);
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
  assert.match(
    fs.readFileSync(path.join(ROOT, "plugins/grok/provider-agents/report-repair.md"), "utf8"),
    /tools:\s*\n\s+- id: GrokBuild:todo_write/
  );
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
