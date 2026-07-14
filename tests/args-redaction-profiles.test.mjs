import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, splitArgs } from "../plugins/grok/scripts/lib/args.mjs";
import { profileFor, sameSecurityProfile } from "../plugins/grok/scripts/lib/profiles.mjs";
import { redact, redactText } from "../plugins/grok/scripts/lib/redact.mjs";

test("splitArgs preserves quoted values and literal escaped whitespace", () => {
  assert.deepEqual(
    splitArgs(`--model grok-test --effort high "two words" 'three words' four\\ five`),
    ["--model", "grok-test", "--effort", "high", "two words", "three words", "four five"]
  );
});

test("splitArgs rejects unterminated quoting and escaping", () => {
  for (const raw of [`"unterminated`, "trailing\\"]) {
    assert.throws(() => splitArgs(raw), (error) => error.code === "E_USAGE");
  }
});

test("parseArgs separates declared options from positional task text", () => {
  assert.deepEqual(
    parseArgs(["--write", "--model=grok-test", "--effort", "high", "fix", "it"], {
      values: ["model", "effort"],
      booleans: ["write"]
    }),
    {
      options: { write: true, model: "grok-test", effort: "high" },
      positionals: ["fix", "it"]
    }
  );
});

test("parseArgs rejects unknown, malformed, and valueless options", () => {
  assert.throws(
    () => parseArgs(["--unknown"], { booleans: ["write"] }),
    (error) => error.code === "E_USAGE" && /Unknown option/.test(error.message)
  );
  assert.throws(
    () => parseArgs(["--write=false"], { booleans: ["write"] }),
    (error) => error.code === "E_USAGE" && /does not accept/.test(error.message)
  );
  assert.throws(
    () => parseArgs(["--model", "--write"], { values: ["model"], booleans: ["write"] }),
    (error) => error.code === "E_USAGE" && /requires a value/.test(error.message)
  );
});

test("redactText removes known provider secret patterns and exact sentinels", () => {
  const sentinel = "repo-private-value";
  const input = [
    "Authorization: Bearer bearer-value-123",
    "xai-abcdefghijklmnopqrstuvwxyz",
    "sk-abcdefghijklmnop",
    "sbp_abcdefghijklmnop",
    "eyJheader.payload.signature",
    sentinel
  ].join(" ");
  const output = redactText(input, [sentinel]);
  for (const secret of ["bearer-value-123", "xai-", "sk-", "sbp_", "eyJheader", sentinel]) {
    assert.equal(output.includes(secret), false, `redacted output retained ${secret}`);
  }
  assert.match(output, /Bearer \[REDACTED\]/);
});

test("recursive redaction masks secret-shaped keys and handles circular input", () => {
  const value = {
    authorization: "Bearer secret",
    nested: {
      api_key: "xai-abcdefghijklmnop",
      safe: "visible"
    },
    list: [{ refreshToken: "token-value" }]
  };
  value.self = value;
  assert.deepEqual(redact(value), {
    authorization: "[REDACTED]",
    nested: { api_key: "[REDACTED]", safe: "visible" },
    list: [{ refreshToken: "[REDACTED]" }],
    self: "[CIRCULAR]"
  });
});

test("redaction duplicates shared acyclic values without corrupting their type", () => {
  const shared = [];
  const value = redact({
    reportRepair: { validationIssues: shared },
    workerReport: { validationIssues: shared },
    providerClaims: { changedFiles: shared }
  });
  assert.deepEqual(value, {
    reportRepair: { validationIssues: [] },
    workerReport: { validationIssues: [] },
    providerClaims: { changedFiles: [] }
  });
  assert.equal(Array.isArray(value.workerReport.validationIssues), true);
});

test("execution profiles keep reviews immutable and grant writes only to write rescue", () => {
  const review = profileFor("review");
  assert.equal(review.transport, "headless");
  assert.equal(review.agent, "explore");
  assert.equal(review.sandbox, "strict");
  assert.equal(review.permissionMode, "default");
  assert.equal(review.subagents, false);
  assert.deepEqual(review.allowedTools, ["todo_write"]);
  assert.ok(review.deniedTools.includes("mcp__*"));
  assert.ok(review.deniedTools.includes("Agent"));

  const readTask = profileFor("task", false);
  assert.equal(readTask.transport, "acp");
  assert.equal(readTask.agent, "build");
  assert.equal(readTask.sandbox, "strict");
  assert.match(readTask.agentProfileDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(readTask.allowedTools, ["read_file", "list_dir", "grep"]);
  assert.ok(!readTask.allowedTools.includes("write"));

  const writeTask = profileFor("task", true);
  assert.equal(writeTask.sandbox, "strict");
  assert.equal(writeTask.permissionMode, "acceptEdits");
  assert.match(writeTask.agentProfileDigest, /^[a-f0-9]{64}$/);
  assert.equal(writeTask.allowedTools.includes("run_terminal_cmd"), false);
  assert.ok(writeTask.allowedTools.includes("search_replace"));

  const reportRepair = profileFor("report-repair");
  assert.equal(reportRepair.id, "rescue-report-v3");
  assert.equal(reportRepair.permissionMode, "dontAsk");
  assert.match(reportRepair.agentProfileDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(reportRepair.allowedTools, []);
  for (const denied of ["Bash", "Edit", "Write"]) assert.ok(reportRepair.deniedTools.includes(denied));
});

test("security-profile comparison ignores diagnostics but rejects privilege changes", () => {
  const left = { ...profileFor("task", false), grokVersion: "0.2.99" };
  const diagnosticOnly = { ...left, grokVersion: "0.2.99" };
  assert.equal(sameSecurityProfile(left, diagnosticOnly), true);
  assert.equal(sameSecurityProfile(left, profileFor("task", true)), false);
  assert.equal(sameSecurityProfile(left, { ...left, webSearch: true }), false);
  assert.equal(sameSecurityProfile(left, { ...left, agentProfileDigest: "0".repeat(64) }), false);
});
