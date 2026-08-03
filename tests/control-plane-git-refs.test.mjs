import {
  assert, crypto, fs, path, test, appendLifecycleEvent,
  assertContextCompatible, assertContextManifestIntegrity, assertTaskContextReady, buildRuntimeEvidence, buildTaskEnvelope, buildWorkerReport,
  buildWorkerReportOutputSchema, captureContextManifest, composeProviderPrompt, composeWorkerReportRepairPrompt, CONTEXT_METADATA_POLICIES, evaluateScope,
  observeChangedPaths, validateReview, REVIEW_SCHEMA, processStartToken, STDIN_READY_MARKER, initRepo,
  git, run, runCompanion, spawnNonblockingStdin, testEnvironment, waitFor,
  ROOT, tempDir, installFakeGrok, readFakeLog, installPinnedFakeCompanion, missingInvalidProviderCapabilityReceiptMessage,
  PROVIDER_LIFECYCLE_AVAILABLE, fixture, parseJson, canonicalizeForDigest, stableDigestForTest, workerReport
} from "./control-plane-test-support.mjs";

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

test("primary complete-but-unattributable identical manifests pass strict compare (issue #34)", (t) => {
  const root = initRepo();
  t.after(() => {
    const refs = git(
      root,
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads"
    ).split(/\r?\n/u).filter((ref) => ref.startsWith("refs/heads/bulk-"));
    if (refs.length === 0) return;
    const result = run("git", ["update-ref", "--stdin"], {
      cwd: root,
      input: `${refs.map((ref) => `delete ${ref}`).join("\n")}\n`
    });
    assert.equal(result.status, 0, result.stderr);
  });
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
