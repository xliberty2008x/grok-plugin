import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPrReviewPayload,
  sanitizePublicationProse,
  suggestionFence,
  MAX_INLINE_COMMENTS,
  MAX_INLINE_BODY_BYTES,
  MAX_REVIEW_BODY_BYTES,
  GROK_REVIEW_RECEIPT_NAMESPACE
} from "../scripts/ci/lib/build-pr-review-payload.mjs";
import {
  collectRightSideLines,
  collectRightSideMap,
  unquoteGitPath
} from "../scripts/ci/lib/diff-right-lines.mjs";
import { buildReviewChildEnv } from "../scripts/ci/lib/review-child-env.mjs";

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

test("collectRightSideMap hasLine/hasRange and handles colon/space/quoted/rename/binary", () => {
  const diff = [
    "diff --git a/src/a:b.js b/src/a:b.js",
    "--- a/src/a:b.js",
    "+++ b/src/a:b.js",
    "@@ -1,2 +1,3 @@",
    " keep",
    "-old",
    "+new1",
    "+new2",
    "diff --git \"a/path with spaces.js\" \"b/path with spaces.js\"",
    "--- \"a/path with spaces.js\"",
    "+++ \"b/path with spaces.js\"",
    "@@ -1 +1,2 @@",
    " context",
    "+added",
    "diff --git a/old-name.txt b/renamed.txt",
    "similarity index 90%",
    "rename from old-name.txt",
    "rename to renamed.txt",
    "--- a/old-name.txt",
    "+++ b/renamed.txt",
    "@@ -1 +1,2 @@",
    " line",
    "+extra",
    "diff --git a/bin.dat b/bin.dat",
    "Binary files a/bin.dat and b/bin.dat differ",
    "diff --git a/deleted.txt b/deleted.txt",
    "--- a/deleted.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-gone",
    ""
  ].join("\n");

  const map = collectRightSideMap(diff);
  assert.equal(map.hasLine("src/a:b.js", 1), true);
  assert.equal(map.hasLine("src/a:b.js", 2), true);
  assert.equal(map.hasLine("src/a:b.js", 3), true);
  assert.equal(map.hasRange("src/a:b.js", 2, 3), true);
  // Cross-hunk / missing lines fail.
  assert.equal(map.hasRange("src/a:b.js", 1, 99), false);

  assert.equal(map.hasLine("path with spaces.js", 1), true);
  assert.equal(map.hasLine("path with spaces.js", 2), true);
  assert.equal(map.hasRange("path with spaces.js", 1, 2), true);

  assert.equal(map.hasLine("renamed.txt", 1), true);
  assert.equal(map.hasLine("renamed.txt", 2), true);
  assert.equal(map.hasLine("old-name.txt", 1), false);

  assert.equal(map.hasLine("bin.dat", 1), false);
  assert.equal(map.hasLine("deleted.txt", 1), false);

  // Legacy wrapper still works and uses path:line encoding.
  const legacy = collectRightSideLines(diff);
  assert.equal(legacy.has("src/a:b.js:2"), true);
  assert.equal(legacy.has("path with spaces.js:2"), true);
  assert.equal(legacy.has("renamed.txt:2"), true);
});

test("unquoteGitPath handles C-style escapes", () => {
  assert.equal(unquoteGitPath("plain"), "plain");
  assert.equal(unquoteGitPath("\"foo bar\""), "foo bar");
  assert.equal(unquoteGitPath("\"foo\\tbar\""), "foo\tbar");
  assert.equal(
    unquoteGitPath("\"src/na\\303\\257ve-\\360\\237\\247\\240.js\""),
    "src/naïve-🧠.js"
  );
  assert.equal(unquoteGitPath("\"bad-\\377-path\""), null);
  assert.equal(unquoteGitPath("/dev/null"), null);
});

test("collectRightSideMap maps Git-octal UTF-8 paths to review file names", () => {
  const diff = [
    "diff --git \"a/src/na\\303\\257ve.js\" \"b/src/na\\303\\257ve.js\"",
    "--- \"a/src/na\\303\\257ve.js\"",
    "+++ \"b/src/na\\303\\257ve.js\"",
    "@@ -1 +1,2 @@",
    " keep",
    "+added",
    ""
  ].join("\n");
  const map = collectRightSideMap(diff);
  assert.equal(map.hasLine("src/naïve.js", 1), true);
  assert.equal(map.hasLine("src/naïve.js", 2), true);
  assert.equal(map.hasRange("src/naïve.js", 1, 2), true);
});

test("collectRightSideMap trusts +++ for unquoted paths containing b-slash text", () => {
  const map = collectRightSideMap([
    "diff --git a/dir b/name.js b/dir b/name.js",
    "index 1111111..2222222 100644",
    "--- a/dir b/name.js",
    "+++ b/dir b/name.js",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    ""
  ].join("\n"));
  assert.equal(map.hasLine("dir b/name.js", 1), true);
  assert.equal(map.hasLine("name.js", 1), false);
});

test("collectRightSideMap rejects multi-line ranges that span distinct hunks", () => {
  const diff = [
    "diff --git a/multi.js b/multi.js",
    "--- a/multi.js",
    "+++ b/multi.js",
    "@@ -1,2 +1,2 @@",
    " a",
    "-b",
    "+B",
    "@@ -10,2 +10,2 @@",
    " c",
    "-d",
    "+D",
    ""
  ].join("\n");
  const map = collectRightSideMap(diff);
  assert.equal(map.hasLine("multi.js", 1), true);
  assert.equal(map.hasLine("multi.js", 2), true);
  assert.equal(map.hasLine("multi.js", 10), true);
  assert.equal(map.hasLine("multi.js", 11), true);
  assert.equal(map.hasRange("multi.js", 1, 2), true);
  assert.equal(map.hasRange("multi.js", 10, 11), true);
  assert.equal(map.hasRange("multi.js", 2, 10), false);
});

function sampleJob(findings, summary = "Summary text.") {
  return {
    id: "review-test",
    status: "completed",
    result: {
      review: {
        verdict: findings.length ? "needs_changes" : "pass",
        summary,
        findings
      }
    }
  };
}

test("buildPrReviewPayload posts COMMENT with summary for zero findings", () => {
  const right = new Set(["src/a.js:1"]);
  const r = buildPrReviewPayload({
    job: sampleJob([]),
    headSha: "abc123",
    rightSideLines: right
  });
  assert.equal(r.skip, false);
  assert.equal(r.payload.event, "COMMENT");
  assert.equal(r.payload.commit_id, "abc123");
  assert.equal(r.payload.comments.length, 0);
  assert.match(r.payload.body, /Summary text/);
  assert.match(r.payload.body, /critical:\s*0/);
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

test("buildPrReviewPayload supports safe single and multiline suggestions", () => {
  const diff = [
    "diff --git a/src/a.js b/src/a.js",
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -1,4 +1,4 @@",
    " line1",
    "-old2",
    "-old3",
    "+new2",
    "+new3",
    " line4",
    ""
  ].join("\n");
  const map = collectRightSideMap(diff);
  const r = buildPrReviewPayload({
    job: sampleJob([
      {
        severity: "high",
        title: "Multi fix",
        body: "Replace the pair.",
        file: "src/a.js",
        line: 3,
        suggestion: {
          startLine: 2,
          endLine: 3,
          replacement: "fixed2();\nfixed3();\n"
        }
      },
      {
        severity: "low",
        title: "Single fix",
        body: "One line.",
        file: "src/a.js",
        line: 1,
        suggestion: {
          startLine: 1,
          endLine: 1,
          replacement: "line1-fixed\n"
        }
      }
    ]),
    headSha: "cafebabe",
    rightSideMap: map
  });
  assert.equal(r.skip, false);
  assert.equal(r.payload.event, "COMMENT");
  assert.equal(r.payload.comments.length, 2);
  const multi = r.payload.comments[0];
  assert.equal(multi.path, "src/a.js");
  assert.equal(multi.line, 3);
  assert.equal(multi.start_line, 2);
  assert.equal(multi.start_side, "RIGHT");
  assert.equal(multi.side, "RIGHT");
  assert.match(multi.body, /```suggestion\nfixed2\(\);\nfixed3\(\);\n```/);
  const single = r.payload.comments[1];
  assert.equal(single.line, 1);
  assert.equal(single.start_line, undefined);
  assert.match(single.body, /```suggestion\nline1-fixed\n```/);
});
test("buildPrReviewPayload promotes unmappable suggestions as ordinary findings", () => {
  const map = collectRightSideMap([
    "diff --git a/src/a.js b/src/a.js",
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    ""
  ].join("\n"));
  const r = buildPrReviewPayload({
    job: sampleJob([
      {
        severity: "high",
        title: "Bad range",
        body: "Not in one hunk.",
        file: "src/a.js",
        line: 1,
        suggestion: {
          startLine: 1,
          endLine: 5,
          replacement: "nope\n"
        }
      }
    ]),
    headSha: "abc",
    rightSideMap: map
  });
  assert.equal(r.payload.comments.length, 1);
  assert.equal(r.payload.comments[0].line, 1);
  assert.equal(r.payload.comments[0].start_line, undefined);
  assert.equal(r.payload.comments[0].body.includes("```suggestion"), false);
  assert.match(r.payload.comments[0].body, /Bad range/);
});

test("suggestion fence grows beyond replacement backtick runs", () => {
  assert.equal(suggestionFence("plain"), "```");
  assert.equal(suggestionFence("has ``` inside"), "````");
  assert.equal(suggestionFence("```` ticks"), "`````");
});

test("sanitizePublicationProse neutralizes mentions, controls, bidi, HTML, and receipt namespace", () => {
  const raw = [
    "Hello @octocat and @org/team-not",
    "see <script>alert(1)</script> and <div class='grok-review-receipt'>spoof</div>",
    `reserved ${GROK_REVIEW_RECEIPT_NAMESPACE} text`,
    "bidi\u202Eoverride\u202C",
    "ctrl\u0007bell"
  ].join("\n");
  const cleaned = sanitizePublicationProse(raw);
  assert.equal(cleaned.includes("@octocat"), false);
  assert.match(cleaned, /@\u200Boctocat/);
  assert.equal(cleaned.includes("<script>"), false);
  assert.equal(cleaned.includes("<div"), false);
  assert.equal(cleaned.toLowerCase().includes(GROK_REVIEW_RECEIPT_NAMESPACE), false);
  assert.match(cleaned, /grok-review\u200B-receipt/i);
  assert.equal(cleaned.includes("\u202E"), false);
  assert.equal(cleaned.includes("\u0007"), false);
});

test("publication sanitizer leaves valid suggestion replacement unchanged and omits when it would alter", () => {
  const map = collectRightSideMap([
    "diff --git a/src/a.js b/src/a.js",
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -1 +1,2 @@",
    " keep",
    "+x",
    ""
  ].join("\n"));

  const cleanReplacement = "const x = 1;\n";
  const clean = buildPrReviewPayload({
    job: sampleJob([{
      severity: "high",
      title: "Clean",
      body: "Ok @mention in body only",
      file: "src/a.js",
      line: 2,
      suggestion: { startLine: 2, endLine: 2, replacement: cleanReplacement }
    }]),
    headSha: "sha",
    rightSideMap: map
  });
  assert.match(clean.payload.comments[0].body, /```suggestion\nconst x = 1;\n```/);
  assert.equal(clean.payload.comments[0].body.includes(cleanReplacement), true);
  // Body prose still neutralized.
  assert.match(clean.payload.comments[0].body, /@\u200Bmention/);

  const toxic = buildPrReviewPayload({
    job: sampleJob([{
      severity: "high",
      title: "Toxic replacement",
      body: "Finding retained.",
      file: "src/a.js",
      line: 2,
      suggestion: { startLine: 2, endLine: 2, replacement: "ping @admin\n" }
    }]),
    headSha: "sha",
    rightSideMap: map
  });
  // Suggestion omitted; ordinary finding kept on the mappable line.
  assert.equal(toxic.payload.comments.length, 1);
  assert.equal(toxic.payload.comments[0].body.includes("```suggestion"), false);
  assert.match(toxic.payload.comments[0].body, /Finding retained/);
  assert.equal(toxic.payload.comments[0].body.includes("ping @admin"), false);

  const secretLike = buildPrReviewPayload({
    job: sampleJob([{
      severity: "critical",
      title: "Do not publish credential text",
      body: "Finding retained without an exact suggestion.",
      file: "src/a.js",
      line: 2,
      suggestion: {
        startLine: 2,
        endLine: 2,
        replacement: "const apiKey = \"sk-proj-abcdefghijklmnop\";\n"
      }
    }]),
    headSha: "sha",
    rightSideMap: map
  });
  assert.equal(secretLike.payload.comments.length, 1);
  assert.equal(
    secretLike.payload.comments[0].body.includes("```suggestion"),
    false
  );
  assert.equal(
    secretLike.payload.comments[0].body.includes("sk-proj-abcdefghijklmnop"),
    false
  );
});

test("host receipt marker is appended only from explicit host input", () => {
  const r = buildPrReviewPayload({
    job: sampleJob([]),
    headSha: "abc",
    rightSideLines: new Set(),
    hostReceiptMarker: `<!-- ${GROK_REVIEW_RECEIPT_NAMESPACE}:host-only -->`
  });
  assert.match(r.payload.body, new RegExp(`${GROK_REVIEW_RECEIPT_NAMESPACE}:host-only`));

  const modelAttempt = buildPrReviewPayload({
    job: sampleJob([], `Model tried ${GROK_REVIEW_RECEIPT_NAMESPACE} forgery`),
    headSha: "abc",
    rightSideLines: new Set()
  });
  assert.equal(modelAttempt.payload.body.toLowerCase().includes(GROK_REVIEW_RECEIPT_NAMESPACE), false);
  assert.equal(modelAttempt.payload.body.includes("host-only"), false);
});

test("payload bounds fail visibly without dropping findings", () => {
  const map = collectRightSideMap([
    "diff --git a/src/a.js b/src/a.js",
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -1 +1,60 @@",
    ...Array.from({ length: 60 }, (_, i) => `+line${i + 1}`),
    ""
  ].join("\n"));

  const tooMany = Array.from({ length: MAX_INLINE_COMMENTS + 1 }, (_, i) => ({
    severity: "low",
    title: `F${i}`,
    body: "x",
    file: "src/a.js",
    line: i + 1
  }));
  assert.throws(
    () => buildPrReviewPayload({
      job: sampleJob(tooMany),
      headSha: "sha",
      rightSideMap: map
    }),
    /inline comments/i
  );

  const hugeBody = "Z".repeat(MAX_INLINE_BODY_BYTES + 1);
  assert.throws(
    () => buildPrReviewPayload({
      job: sampleJob([{
        severity: "high",
        title: "Huge",
        body: hugeBody,
        file: "src/a.js",
        line: 1
      }]),
      headSha: "sha",
      rightSideMap: map
    }),
    /Inline comment body/i
  );

  const hugeSummary = "S".repeat(MAX_REVIEW_BODY_BYTES + 1);
  assert.throws(
    () => buildPrReviewPayload({
      job: sampleJob([], hugeSummary),
      headSha: "sha",
      rightSideMap: map
    }),
    /Review body/i
  );
});

test("buildPrReviewPayload footer attributes Superpowers-style Companion review", () => {
  const right = new Set(["src/a.js:1"]);
  const r = buildPrReviewPayload({
    job: sampleJob([
      {
        severity: "high",
        title: "Missing check",
        body: "Add a guard.",
        file: "src/a.js",
        line: 1
      }
    ]),
    headSha: "abc123",
    rightSideLines: right
  });
  assert.equal(r.skip, false);
  assert.match(r.payload.body, /Superpowers-style/i);
  assert.match(r.payload.body, /Companion/i);
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

test("buildReviewChildEnv sets auth path and session, omits GitHub/auth JSON secrets", () => {
  const env = buildReviewChildEnv({
    authPath: "/tmp/grok-ci-auth/auth.json",
    runId: "12345",
    pathEnv: "/usr/bin",
    home: "/home/runner",
    user: "runner",
    logname: "runner",
    tmpdir: "/tmp",
    runnerTemp: "/runner/temp",
    pid: 99,
    grokBin: "/usr/local/bin/grok"
  });

  assert.equal(env.GROK_AUTH_PATH, "/tmp/grok-ci-auth/auth.json");
  assert.equal(env.GROK_COMPANION_HOST, "ci");
  assert.equal(env.GROK_HEADLESS_PROMPT_ON_DISK, "1");
  assert.equal(env.GROK_COMPANION_HOST_SESSION_ID, "12345");
  assert.equal(env.CLAUDE_PLUGIN_DATA, "/runner/temp/grok-ci-plugin-data-99");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/runner");
  assert.equal(env.GROK_BIN, "/usr/local/bin/grok");

  assert.equal(Object.hasOwn(env, "GITHUB_TOKEN"), false);
  assert.equal(Object.hasOwn(env, "GH_TOKEN"), false);
  assert.equal(Object.hasOwn(env, "GROK_AUTH_JSON"), false);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GROK_AUTH_JSON, undefined);
});

test("buildReviewChildEnv does not leak parent secrets even if caller only passes allowlisted fields", () => {
  // Simulates isolation: parent process may have tokens, but builder never copies them.
  const polluted = {
    GITHUB_TOKEN: "ghs_should_not_appear",
    GH_TOKEN: "ghs_also_not",
    GROK_AUTH_JSON: '{"secret":true}',
    PATH: "/bin",
    HOME: "/home/x"
  };
  const env = buildReviewChildEnv({
    authPath: "/secure/auth.json",
    pathEnv: polluted.PATH,
    home: polluted.HOME,
    runnerTemp: "/tmp",
    pid: 1,
    runId: "run-1"
  });
  for (const key of Object.keys(env)) {
    assert.notEqual(key, "GITHUB_TOKEN");
    assert.notEqual(key, "GH_TOKEN");
    assert.notEqual(key, "GROK_AUTH_JSON");
  }
  assert.ok(!JSON.stringify(env).includes("ghs_should_not_appear"));
  assert.ok(!JSON.stringify(env).includes("ghs_also_not"));
  assert.ok(!JSON.stringify(env).includes('{"secret":true}'));
});

test("buildReviewChildEnv requires authPath", () => {
  assert.throws(() => buildReviewChildEnv({ authPath: "" }), /authPath/);
  assert.throws(() => buildReviewChildEnv({}), /authPath/);
});
