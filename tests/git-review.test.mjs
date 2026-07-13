import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  assertUnchanged,
  collectContext,
  integritySnapshot,
  resolveTarget
} from "../plugins/grok/scripts/lib/git-review.mjs";
import { git, initRepo } from "./helpers.mjs";

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

test("invalid scopes and non-commit base refs fail deterministically", () => {
  const root = initRepo();
  assert.throws(() => resolveTarget(root, { scope: "staged" }), (error) => error.code === "E_USAGE");
  assert.throws(() => resolveTarget(root, { base: "missing" }), (error) => error.code === "E_USAGE");
});
