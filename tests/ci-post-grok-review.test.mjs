import assert from "node:assert/strict";
import test from "node:test";
import { collectRightSideLines } from "../scripts/ci/lib/diff-right-lines.mjs";

test("collectRightSideLines records added and context lines on RIGHT side", () => {
  const diff = [
    "diff --git a/src/a.js b/src/a.js",
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -1,3 +1,4 @@",
    " line1",
    "-old",
    "+new",
    " line3",
    ""
  ].join("\n");
  const set = collectRightSideLines(diff);
  assert.equal(set.has("src/a.js:1"), true); // context line1 → new line 1
  assert.equal(set.has("src/a.js:2"), true); // +new → new line 2
  assert.equal(set.has("src/a.js:3"), true); // context line3 → new line 3
  assert.equal(set.has("src/a.js:99"), false);
});

test("collectRightSideLines skips pure deletions and /dev/null new files headers correctly", () => {
  const diff = [
    "diff --git a/gone.txt b/gone.txt",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "diff --git a/new.txt b/new.txt",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1,2 @@",
    "+hello",
    "+world",
    ""
  ].join("\n");
  const set = collectRightSideLines(diff);
  assert.equal(set.has("gone.txt:1"), false);
  assert.equal(set.has("new.txt:1"), true);
  assert.equal(set.has("new.txt:2"), true);
});

test("collectRightSideLines ignores No newline metadata", () => {
  const diff = [
    "diff --git a/f b/f",
    "--- a/f",
    "+++ b/f",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "\\ No newline at end of file",
    ""
  ].join("\n");
  const set = collectRightSideLines(diff);
  assert.equal(set.has("f:1"), true);
  assert.equal(set.size, 1);
});
