import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  AcpClient,
  classifyPromptStopReason,
  isCancelledPromptStopReason,
  isSuccessfulPromptStopReason,
  validatePromptResponse
} from "../plugins/grok/scripts/lib/acp-client.mjs";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.pid = 991_001;
    this.killed = false;
  }

  kill() {
    this.killed = true;
    return true;
  }
}

function promptResponse(id = 1, stopReason = "end_turn") {
  return { jsonrpc: "2.0", id, result: { stopReason } };
}

test("ACP v1 prompt stop reasons have one exact validity and outcome classification", () => {
  const expected = new Map([
    ["end_turn", { successful: true, cancelled: false, refusal: false }],
    ["max_tokens", { successful: true, cancelled: false, refusal: false }],
    ["max_turn_requests", { successful: true, cancelled: false, refusal: false }],
    ["cancelled", { successful: false, cancelled: true, refusal: false }],
    ["refusal", { successful: false, cancelled: false, refusal: true }],
    ["EndTurn", { successful: true, cancelled: false, refusal: false }],
    ["MaxTokens", { successful: true, cancelled: false, refusal: false }],
    ["MaxTurnRequests", { successful: true, cancelled: false, refusal: false }],
    ["Cancelled", { successful: false, cancelled: true, refusal: false }],
    ["Refusal", { successful: false, cancelled: false, refusal: true }]
  ]);
  for (const [stopReason, outcome] of expected) {
    assert.doesNotThrow(() => validatePromptResponse({ stopReason }), stopReason);
    assert.deepEqual(classifyPromptStopReason(stopReason), {
      valid: true,
      ...outcome
    }, stopReason);
    assert.equal(isSuccessfulPromptStopReason(stopReason), outcome.successful, stopReason);
    assert.equal(isCancelledPromptStopReason(stopReason), outcome.cancelled, stopReason);
  }
  assert.throws(
    () => validatePromptResponse({ stopReason: "completed" }),
    (error) => error?.code === "E_PROTOCOL"
  );
  assert.deepEqual(classifyPromptStopReason("completed"), {
    valid: false,
    successful: false,
    cancelled: false,
    refusal: false
  });
});

test("a later same-batch duplicate, wrong-type, or unmatched response poisons the pending turn", async (t) => {
  const cases = [
    ["duplicate", promptResponse(1)],
    ["wrong-type", promptResponse("1")],
    ["unmatched", promptResponse(999)]
  ];
  for (const [name, poison] of cases) {
    await t.test(name, async () => {
      const child = new FakeChild();
      const client = new AcpClient(child, { timeoutMs: 1000 });
      const pending = client.promptTurn({
        sessionId: "session-1",
        prompt: [{ type: "text", text: "one turn" }]
      });
      child.stdout.write(
        `${JSON.stringify(promptResponse(1))}\n${JSON.stringify(poison)}\n`
      );
      await assert.rejects(
        pending,
        (error) => error?.code === "E_PROTOCOL"
      );
      assert.equal(client.closed, true);
      assert.equal(client.transportError?.code, "E_PROTOCOL");
    });
  }
});

test("a clean single ACP response settles only after its stdout batch is complete", async () => {
  const child = new FakeChild();
  const client = new AcpClient(child, { timeoutMs: 1000 });
  const pending = client.promptTurn({
    sessionId: "session-1",
    prompt: [{ type: "text", text: "one turn" }]
  });
  child.stdout.write(`${JSON.stringify(promptResponse(1, "max_turn_requests"))}\n`);
  assert.deepEqual(await pending, {
    id: 1,
    result: { stopReason: "max_turn_requests" }
  });
  assert.equal(client.transportError, null);
});

test("asynchronous ACP stdin EPIPE closes dispatch, notify, and close paths without an unhandled error", async (t) => {
  for (const operation of ["dispatch", "notify", "close"]) {
    await t.test(operation, async () => {
      const child = new FakeChild();
      const client = new AcpClient(child, { timeoutMs: 1000 });
      const closed = once(client, "closed");
      let pending = null;
      if (operation === "dispatch") pending = client.request("initialize", {});
      if (operation === "notify") client.notify("session/cancel", { sessionId: "session-1" });
      if (operation === "close") client.close();
      setImmediate(() => {
        const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
        child.stdin.emit("error", error);
      });
      const [error] = await closed;
      assert.equal(error?.code, "E_PROTOCOL");
      assert.equal(client.transportError?.details?.code, "EPIPE");
      if (pending) {
        await assert.rejects(
          pending,
          (failure) => failure?.code === "E_PROTOCOL"
        );
      }
    });
  }
});
