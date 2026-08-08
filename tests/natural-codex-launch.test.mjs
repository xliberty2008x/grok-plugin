import assert from "node:assert/strict";
import test from "node:test";

import {
  naturalCodexExecArgs,
  resolveNaturalCodexReasoningEffort
} from "../scripts/test-natural-codex.mjs";

test("natural Codex reasoning effort defaults to xhigh and retains a valid override", () => {
  assert.equal(resolveNaturalCodexReasoningEffort(), "xhigh");
  assert.equal(resolveNaturalCodexReasoningEffort("high"), "high");
});

test("natural Codex launch pins a model-compatible reasoning effort", () => {
  assert.deepEqual(
    naturalCodexExecArgs({
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      root: "/repo",
      schema: "/repo/schema.json",
      outputFile: "/tmp/final.json",
      prompt: "qualify"
    }),
    [
      "exec",
      "--ephemeral",
      "--dangerously-bypass-hook-trust",
      "--model", "gpt-5.5",
      "--config", 'model_reasoning_effort="xhigh"',
      "--sandbox", "danger-full-access",
      "--cd", "/repo",
      "--color", "never",
      "--output-schema", "/repo/schema.json",
      "--output-last-message", "/tmp/final.json",
      "qualify"
    ]
  );
});

test("natural Codex launch rejects reasoning-effort config injection", () => {
  assert.throws(
    () => naturalCodexExecArgs({
      model: "gpt-5.5",
      reasoningEffort: 'xhigh"\nmodel="gpt-5.6-sol',
      root: "/repo",
      schema: "/repo/schema.json",
      outputFile: "/tmp/final.json",
      prompt: "qualify"
    }),
    /reasoning effort/i
  );
});
