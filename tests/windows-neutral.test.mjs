import assert from "node:assert/strict";
import test from "node:test";

import { normalizeUpdate } from "../plugins/grok/scripts/lib/acp-client.mjs";
import { parseArgs } from "../plugins/grok/scripts/lib/args.mjs";
import { CompanionError, exitCodeFor } from "../plugins/grok/scripts/lib/errors.mjs";
import { assertProviderPlatform, ensureChildExit } from "../plugins/grok/scripts/lib/grok-provider.mjs";
import { profileFor, sameSecurityProfile } from "../plugins/grok/scripts/lib/profiles.mjs";
import { redactText } from "../plugins/grok/scripts/lib/redact.mjs";

async function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true, enumerable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (original) Object.defineProperty(process, "platform", original);
    else delete process.platform;
  }
}

test("provider-neutral argument and redaction contracts", () => {
  assert.deepEqual(
    parseArgs(["--write", "--model", "grok-test", "fix", "it"], {
      values: ["model"],
      booleans: ["write"]
    }),
    { options: { write: true, model: "grok-test" }, positionals: ["fix", "it"] }
  );
  assert.equal(redactText("Authorization: Bearer secret-value").includes("secret-value"), false);
  assert.equal(exitCodeFor(new CompanionError("E_USAGE", "bad input")), 2);
});

test("provider-neutral profiles preserve the read/write boundary", () => {
  const review = profileFor("review");
  const write = profileFor("task", true);
  const normalizedReviewTools = review.allowedTools.map((tool) => tool.toLowerCase());
  const normalizedWriteTools = write.allowedTools.map((tool) => tool.toLowerCase());
  assert.equal(review.sandbox, "strict");
  assert.equal(normalizedReviewTools.includes("write"), false);
  assert.equal(write.sandbox, "strict");
  assert.equal(normalizedWriteTools.includes("run_terminal_cmd"), false);
  assert.equal(normalizedWriteTools.includes("search_replace"), true);
  assert.equal(sameSecurityProfile(review, write), false);
});

test("provider-neutral ACP event normalization does not require a Grok executable", () => {
  assert.deepEqual(
    normalizeUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } }),
    { type: "message", text: "hello" }
  );
  assert.equal(normalizeUpdate({ sessionUpdate: "usage_update", tokens: 10 }).type, "usage");
  assert.equal(normalizeUpdate({ futureEvent: true }).type, "unknown");
});

test("Windows provider platform guard reports E_CAPABILITY rather than process identity", async () => {
  assert.throws(
    () => assertProviderPlatform("win32"),
    (error) => error instanceof CompanionError && error.code === "E_CAPABILITY" && /Windows/i.test(error.message)
  );
  assert.doesNotThrow(() => assertProviderPlatform("darwin"));
  assert.doesNotThrow(() => assertProviderPlatform("linux"));

  await withPlatform("win32", async () => {
    await assert.rejects(
      () => ensureChildExit({ pid: 1 }, { pid: 1, startToken: null, processGroupId: null }),
      (error) => error instanceof CompanionError && error.code === "E_CAPABILITY" && error.code !== "E_PROCESS_IDENTITY"
    );
  });
});
