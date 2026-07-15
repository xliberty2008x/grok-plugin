import assert from "node:assert/strict";
import test from "node:test";
import { buildPrReviewPayload } from "../scripts/ci/lib/build-pr-review-payload.mjs";
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

function sampleJob(findings) {
  return {
    id: "review-test",
    status: "completed",
    result: {
      review: {
        verdict: findings.length ? "needs_changes" : "pass",
        summary: "Summary text.",
        findings
      }
    }
  };
}

test("buildPrReviewPayload skips empty findings", () => {
  const right = new Set(["src/a.js:1"]);
  const r = buildPrReviewPayload({
    job: sampleJob([]),
    headSha: "abc123",
    rightSideLines: right
  });
  assert.equal(r.skip, true);
  assert.equal(r.reason, "no-findings");
});

test("buildPrReviewPayload skips empty-target", () => {
  const job = sampleJob([]);
  job.result.skipped = true;
  job.result.skipReason = "empty-target";
  const r = buildPrReviewPayload({
    job,
    headSha: "abc123",
    rightSideLines: new Set()
  });
  assert.equal(r.skip, true);
  assert.equal(r.reason, "empty-target");
});

test("buildPrReviewPayload places mappable findings inline and promotes others", () => {
  const right = new Set(["src/a.js:2"]);
  const r = buildPrReviewPayload({
    job: sampleJob([
      {
        severity: "high",
        title: "Bug",
        body: "Broken thing",
        file: "src/a.js",
        line: 2
      },
      {
        severity: "low",
        title: "Off",
        body: "Not in diff",
        file: "src/a.js",
        line: 99
      },
      {
        severity: "info",
        title: "General",
        body: "No location",
        file: null,
        line: null
      }
    ]),
    headSha: "deadbeef",
    rightSideLines: right
  });
  assert.equal(r.skip, false);
  assert.equal(r.payload.commit_id, "deadbeef");
  assert.equal(r.payload.event, "COMMENT");
  assert.equal(r.payload.comments.length, 1);
  assert.equal(r.payload.comments[0].path, "src/a.js");
  assert.equal(r.payload.comments[0].line, 2);
  assert.equal(r.payload.comments[0].side, "RIGHT");
  assert.match(r.payload.comments[0].body, /\[high\]/);
  assert.match(r.payload.comments[0].body, /Bug/);
  assert.match(r.payload.body, /Summary text/);
  assert.match(r.payload.body, /high:\s*1/);
  assert.match(r.payload.body, /Issues outside the diff/);
  assert.match(r.payload.body, /Off/);
  assert.match(r.payload.body, /General/);
});

test("buildPrReviewPayload throws on missing review when not skippable", () => {
  assert.throws(
    () =>
      buildPrReviewPayload({
        job: { status: "failed", result: null, error: { code: "E_AUTH_REQUIRED" } },
        headSha: "x",
        rightSideLines: new Set()
      }),
    /review/i
  );
});
