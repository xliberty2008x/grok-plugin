import {
  assert, crypto, fs, path, test, appendLifecycleEvent,
  assertContextCompatible, assertContextManifestIntegrity, assertTaskContextReady, buildRuntimeEvidence, buildTaskEnvelope, buildWorkerReport,
  buildWorkerReportOutputSchema, captureContextManifest, composeProviderPrompt, composeWorkerReportRepairPrompt, CONTEXT_METADATA_POLICIES, evaluateScope,
  observeChangedPaths, validateReview, REVIEW_SCHEMA, processStartToken, STDIN_READY_MARKER, initRepo,
  git, run, runCompanion, spawnNonblockingStdin, testEnvironment, waitFor,
  ROOT, tempDir, installFakeGrok, readFakeLog, installPinnedFakeCompanion, missingInvalidProviderCapabilityReceiptMessage,
  PROVIDER_LIFECYCLE_AVAILABLE, fixture, parseJson, canonicalizeForDigest, stableDigestForTest, workerReport
} from "./control-plane-test-support.mjs";

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

test("effective include.path / includeIf config changes task-relevant identity (issue #34 AC-1)", (t) => {
  const root = initRepo();
  const configPath = path.join(root, ".git", "config");
  const originalConfig = fs.readFileSync(configPath);
  t.after(() => fs.writeFileSync(configPath, originalConfig));
  const externalDir = tempDir("grok-plugin-ext-config-");
  const included = path.join(externalDir, "included.gitconfig");
  fs.writeFileSync(included, "[grok-companion-include]\n\tmarker = v1\n");

  // Absolute include.path: repository config bytes stay fixed while the external
  // included file changes effective config (Git resolves includes on list).
  fs.appendFileSync(
    configPath,
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
    configPath,
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
