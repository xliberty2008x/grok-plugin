import {
  assert, crypto, fs, path, test, appendLifecycleEvent,
  assertContextCompatible, assertContextManifestIntegrity, assertTaskContextReady, buildRuntimeEvidence, buildTaskEnvelope, buildWorkerReport,
  buildWorkerReportOutputSchema, captureContextManifest, composeProviderPrompt, composeWorkerReportRepairPrompt, CONTEXT_METADATA_POLICIES, evaluateScope,
  observeChangedPaths, validateReview, REVIEW_SCHEMA, processStartToken, STDIN_READY_MARKER, initRepo,
  git, run, runCompanion, spawnNonblockingStdin, testEnvironment, waitFor,
  ROOT, tempDir, installFakeGrok, readFakeLog, installPinnedFakeCompanion, missingInvalidProviderCapabilityReceiptMessage,
  PROVIDER_LIFECYCLE_AVAILABLE, fixture, parseJson, canonicalizeForDigest, stableDigestForTest, workerReport
} from "./control-plane-test-support.mjs";

test("metadata hashing and directory walks enforce hard byte/entry bounds (issue #34 re-review)", (t) => {
  const root = initRepo();
  const externalHooks = path.join(tempDir("grok-plugin-bound-hooks-"), "hooks");
  fs.mkdirSync(externalHooks, { recursive: true });
  git(root, "config", "core.hooksPath", externalHooks);
  const captureWithSyntheticEntryOverflow = (
    captureRoot,
    targetDirectory,
    prefix
  ) => {
    const sentinelName = `${prefix}-sentinel`;
    fs.writeFileSync(path.join(targetDirectory, sentinelName), "");
    const sentinel = fs.readdirSync(
      targetDirectory,
      { withFileTypes: true }
    ).find((entry) => entry.name === sentinelName);
    assert.ok(sentinel?.isFile());
    const canonicalTarget = fs.realpathSync(targetDirectory);
    const originalOpendirSync = fs.opendirSync;
    fs.opendirSync = function syntheticOverflowOpendirSync(directory, ...args) {
      const handle = originalOpendirSync.call(fs, directory, ...args);
      let canonicalDirectory;
      try {
        canonicalDirectory = fs.realpathSync(String(directory));
      } catch {
        return handle;
      }
      if (canonicalDirectory !== canonicalTarget) return handle;
      let index = 0;
      return {
        readSync() {
          if (index > 10_000) return null;
          index += 1;
          return sentinel;
        },
        closeSync: handle.closeSync.bind(handle)
      };
    };
    try {
      return captureContextManifest(captureRoot);
    } finally {
      fs.opendirSync = originalOpendirSync;
    }
  };

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

  // Hard entry bound: a bounded synthetic reader presents more than
  // MAX_GIT_METADATA_ENTRIES (10_000) siblings without materializing an
  // unreapable on-disk tree if this test process is killed.
  const entryFlood = path.join(externalHooks, "entry-flood");
  fs.mkdirSync(entryFlood, { recursive: true });
  const afterEntries = captureWithSyntheticEntryOverflow(
    root,
    entryFlood,
    "e"
  );
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
  assert.equal(entriesSerialized.includes("e-sentinel"), false);

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
  t.after(() => fs.rmSync(sequencer, { recursive: true, force: true }));
  fs.mkdirSync(sequencer, { recursive: true });
  const afterOp = captureWithSyntheticEntryOverflow(
    linkedRoot,
    sequencer,
    "s"
  );
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

test("core.hooksPath unset/relative/absolute/include resolution stays Git-faithful (issue #34)", (t) => {
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
  const rootIncConfig = path.join(rootInc, ".git", "config");
  const originalRootIncConfig = fs.readFileSync(rootIncConfig);
  t.after(() => fs.writeFileSync(rootIncConfig, originalRootIncConfig));
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
    rootIncConfig,
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
