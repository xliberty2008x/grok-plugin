import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  assertUnchanged,
  assertWorkingTreeTargetBound,
  collectContext,
  integritySnapshot,
  listWorkingTreeChangedPaths,
  resolveTarget
} from "../plugins/grok/scripts/lib/git-review.mjs";
import { git, initRepo, runCodexCompanion, tempDir, testEnvironment } from "./helpers.mjs";
import { installFakeGrok } from "./fake-grok.mjs";

test("auto review chooses the default branch when clean and working tree when dirty", () => {
  const root = initRepo();
  assert.deepEqual(resolveTarget(root), {
    mode: "branch",
    label: "changes from main...HEAD",
    base: "main"
  });

  fs.appendFileSync(path.join(root, "tracked.txt"), "dirty\n");
  assert.deepEqual(resolveTarget(root), {
    mode: "working-tree",
    label: "staged, unstaged, and untracked working-tree changes",
    base: null
  });
});

test("explicit --base forces branch mode even with dirty local changes", () => {
  const root = initRepo();
  fs.appendFileSync(path.join(root, "tracked.txt"), "dirty\n");
  const target = resolveTarget(root, { base: "main" });
  assert.equal(target.mode, "branch");
  assert.equal(target.base, "main");
});

test("working-tree collection includes staged, unstaged, text, binary, and symlink evidence", () => {
  const root = initRepo();
  fs.appendFileSync(path.join(root, "tracked.txt"), "unstaged\n");
  fs.writeFileSync(path.join(root, "staged.txt"), "staged\n");
  git(root, "add", "staged.txt");

  const compact = collectContext(root, resolveTarget(root, { scope: "working-tree" }));
  assert.match(compact.content, /STAGED DIFF/);
  assert.match(compact.content, /staged\.txt/);
  assert.match(compact.content, /UNSTAGED DIFF/);
  assert.match(compact.content, /unstaged/);

  fs.writeFileSync(path.join(root, "untracked.txt"), "untracked text\n");
  fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  fs.symlinkSync("tracked.txt", path.join(root, "link.txt"));

  const context = collectContext(root, resolveTarget(root, { scope: "working-tree" }));
  assert.match(context.content, /STAGED DIFF/);
  assert.match(context.content, /UNSTAGED DIFF/);
  assert.match(context.content, /UNTRACKED file: untracked\.txt\nuntracked text/);
  assert.match(context.content, /UNTRACKED file: binary\.bin\n\[binary: 4 bytes, sha256 [a-f0-9]{64}\]/);
  assert.match(context.content, /UNTRACKED symlink: link\.txt\ntracked\.txt/);
});

test("large working-tree diffs are embedded for tool-free review", () => {
  const root = initRepo();
  fs.writeFileSync(path.join(root, "large.txt"), `${"x".repeat(300 * 1024)}\n`);
  git(root, "add", "large.txt");
  const context = collectContext(root, resolveTarget(root));
  assert.match(context.collectionGuidance, /Complete tool-free/);
  assert.match(context.content, /x{1000}/);
});

test("oversized tool-free review context fails explicitly", () => {
  const root = initRepo();
  fs.writeFileSync(path.join(root, "too-large.txt"), "x".repeat(9 * 1024 * 1024));
  git(root, "add", "too-large.txt");
  assert.throws(
    () => collectContext(root, resolveTarget(root)),
    (error) => error.code === "E_REVIEW_TOO_LARGE"
  );
});

test("branch names are passed literally and cannot trigger shell expansion", () => {
  const root = initRepo();
  const marker = path.join(root, "should-not-exist");
  assert.throws(
    () => resolveTarget(root, { base: `main;touch ${marker}` }),
    (error) => error.code === "E_USAGE"
  );
  assert.equal(fs.existsSync(marker), false);
});

test("integrity snapshots detect repository mutations", () => {
  const root = initRepo();
  const before = integritySnapshot(root);
  assert.doesNotThrow(() => assertUnchanged(before, integritySnapshot(root)));
  fs.appendFileSync(path.join(root, "tracked.txt"), "provider mutation\n");
  assert.throws(
    () => assertUnchanged(before, integritySnapshot(root)),
    (error) => error.code === "E_REVIEW_MUTATED_WORKSPACE" && error.details.changed.includes("worktree")
  );
});

test("integrity snapshots hash complete large and binary untracked contents", () => {
  const root = initRepo();
  const file = path.join(root, "large.bin");
  const first = Buffer.alloc(32 * 1024, 0x11);
  fs.writeFileSync(file, first);
  const before = integritySnapshot(root);
  const second = Buffer.alloc(first.length, 0x22);
  fs.writeFileSync(file, second);
  const after = integritySnapshot(root);
  assert.notEqual(after.untracked, before.untracked);
});

test("working-tree collection records dirty paths and refuses dirty-empty binding", () => {
  const root = initRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/payment-service.mjs"), "export const charge = () => {};\n");
  fs.writeFileSync(path.join(root, "test/payment-service.test.mjs"), "import test from 'node:test';\n");
  git(root, "add", "src/payment-service.mjs", "test/payment-service.test.mjs");
  git(root, "commit", "-m", "payment fixture");
  fs.appendFileSync(path.join(root, "src/payment-service.mjs"), "export const retry = () => {};\n");
  fs.appendFileSync(path.join(root, "test/payment-service.test.mjs"), "test('retry', () => {});\n");

  const paths = listWorkingTreeChangedPaths(root);
  assert.deepEqual(paths.sort(), [
    "src/payment-service.mjs",
    "test/payment-service.test.mjs"
  ]);
  const context = collectContext(root, resolveTarget(root, { scope: "working-tree" }));
  assert.equal(context.empty, false);
  assert.deepEqual([...context.changedPaths].sort(), paths.sort());
  assert.doesNotThrow(() => assertWorkingTreeTargetBound(context));
  assert.throws(
    () => assertWorkingTreeTargetBound({
      target: { mode: "working-tree" },
      empty: false,
      changedPaths: []
    }),
    (error) => error.code === "E_REVIEW_TARGET"
      && /dirty/.test(error.message)
      && /zero changed paths/.test(error.message)
  );
});

test("dirty working-tree review records bound paths and cannot pass with an empty observation", (t) => {
  const root = initRepo();
  const pluginData = tempDir("grok-plugin-test-");
  const fakeRoot = tempDir("grok-plugin-test-");
  t.after(() => {
    fs.rmSync(pluginData, { recursive: true, force: true });
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  });
  fs.appendFileSync(path.join(root, "tracked.txt"), "dirty review target\n");
  fs.writeFileSync(path.join(root, "second.txt"), "second dirty file\n");
  git(root, "add", "second.txt");
  const fake = installFakeGrok(fakeRoot);
  const env = testEnvironment({ fake, pluginData });
  delete env.GROK_COMPANION_CHILD;
  delete env.GROK_COMPANION_JOB_MARKER;
  delete env.GROK_AGENT;
  delete env.GROK_LEADER_SOCKET;
  delete env.CODEX_THREAD_ID;
  const result = runCodexCompanion(
    ["review", "--wait", "--scope", "working-tree", "--json"],
    { cwd: root, env }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const job = JSON.parse(result.stdout);
  const observed = job.result?.runtimeEvidence?.observedChangedPaths || [];
  assert.ok(observed.includes("tracked.txt"), JSON.stringify(observed));
  assert.ok(observed.includes("second.txt"), JSON.stringify(observed));
  assert.notEqual(observed.length, 0);
  if (job.result?.review?.verdict === "pass") {
    assert.notEqual(observed.length, 0);
  }
});

test("invalid scopes and non-commit base refs fail deterministically", () => {
  const root = initRepo();
  assert.throws(() => resolveTarget(root, { scope: "staged" }), (error) => error.code === "E_USAGE");
  assert.throws(() => resolveTarget(root, { base: "missing" }), (error) => error.code === "E_USAGE");
});
