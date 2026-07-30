import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import process from "node:process";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  AcpClient,
  classifyPromptStopReason,
  isCancelledPromptStopReason,
  isSuccessfulPromptStopReason,
  isValidJsonRpcNotification,
  validatePromptResponse
} from "../plugins/grok/scripts/lib/acp-client.mjs";
import { signalOwnedProcess } from "../plugins/grok/scripts/lib/process-control.mjs";

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

test("ACP native structured output is request-bound, validated, and downgrade-safe", async (t) => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["outcome"],
    properties: {
      outcome: { type: "string", enum: ["complete"] }
    }
  };

  await t.test("value", async () => {
    const child = new FakeChild();
    const writes = [];
    child.stdin.on("data", (chunk) => writes.push(String(chunk)));
    const client = new AcpClient(child, {
      timeoutMs: 1000,
      knownSecrets: ["secret-value"]
    });
    const pending = client.promptTurn({
      sessionId: "session-native",
      prompt: [{ type: "text", text: "one turn" }],
      outputSchema: schema
    });
    assert.deepEqual(JSON.parse(writes.join("").trim()).params, {
      sessionId: "session-native",
      prompt: [{ type: "text", text: "one turn" }],
      _meta: { outputSchema: schema }
    });
    child.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        stopReason: "end_turn",
        _meta: {
          structuredOutput: {
            outcome: "complete",
            note: "secret-value"
          }
        }
      }
    })}\n`);
    const response = await pending;
    assert.deepEqual(response.structuredOutput, {
      outcome: "complete",
      note: "[REDACTED]"
    });
  });

  await t.test("explicit validation error blocks text fallback", async () => {
    const child = new FakeChild();
    const client = new AcpClient(child, { timeoutMs: 1000 });
    const pending = client.promptTurn({
      sessionId: "session-error",
      prompt: [{ type: "text", text: "one turn" }],
      outputSchema: schema
    });
    child.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        stopReason: "end_turn",
        _meta: { structuredOutputError: "schema mismatch" }
      }
    })}\n`);
    const response = await pending;
    assert.equal(
      response.structuredOutputError,
      "Grok Build could not produce schema-valid structured output."
    );
    assert.equal(Object.hasOwn(response, "structuredOutput"), false);
  });

  await t.test("absent native keys preserve compatibility", async () => {
    const child = new FakeChild();
    const client = new AcpClient(child, { timeoutMs: 1000 });
    const pending = client.promptTurn({
      sessionId: "session-compat",
      prompt: [{ type: "text", text: "one turn" }],
      outputSchema: schema
    });
    child.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { stopReason: "end_turn", _meta: { modelId: "grok-test" } }
    })}\n`);
    const response = await pending;
    assert.equal(Object.hasOwn(response, "structuredOutput"), false);
    assert.equal(Object.hasOwn(response, "structuredOutputError"), false);
  });

  await t.test("malformed or contradictory metadata fails closed", async () => {
    for (const meta of [
      null,
      [],
      {
        structuredOutput: { outcome: "complete" },
        structuredOutputError: "contradictory"
      }
    ]) {
      const child = new FakeChild();
      const client = new AcpClient(child, { timeoutMs: 1000 });
      const pending = client.promptTurn({
        sessionId: "session-malformed",
        prompt: [{ type: "text", text: "one turn" }],
        outputSchema: schema
      });
      child.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { stopReason: "end_turn", _meta: meta }
      })}\n`);
      await assert.rejects(
        pending,
        (error) => error?.code === "E_PROTOCOL"
      );
    }
  });
});

test("ACP outbound allowlist rejects session methods and notifications before writing bytes", async () => {
  const child = new FakeChild();
  const writes = [];
  child.stdin.on("data", (chunk) => writes.push(Buffer.from(chunk)));
  const client = new AcpClient(child, {
    timeoutMs: 1000,
    outboundAllowlist: {
      requests: [
        "initialize",
        "_x.ai/git/worktree/create",
        "_x.ai/session/close"
      ],
      notifications: []
    }
  });

  await assert.rejects(
    client.request("session/new", {}),
    (error) => error?.code === "E_CAPABILITY"
  );
  await assert.rejects(
    client.promptTurn({
      sessionId: "forbidden-session",
      prompt: [{ type: "text", text: "forbidden" }]
    }),
    (error) => error?.code === "E_CAPABILITY"
  );
  const reserved = client.reserveRequestId();
  await assert.rejects(
    client.dispatchReserved(reserved, "session/load", {}),
    (error) => error?.code === "E_CAPABILITY"
  );
  assert.throws(
    () => client.notify("session/cancel", { sessionId: "forbidden-session" }),
    (error) => error?.code === "E_CAPABILITY"
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(Buffer.concat(writes).length, 0);
});

test("controller ACP mode always cancels permission requests", async () => {
  const child = new FakeChild();
  const writes = [];
  child.stdin.on("data", (chunk) => writes.push(String(chunk)));
  const client = new AcpClient(child, {
    timeoutMs: 1000,
    permissionPolicy: () => ({
      outcome: { outcome: "selected", optionId: "allow-always" }
    }),
    cancelPermissions: true,
    outboundAllowlist: {
      requests: ["initialize"],
      notifications: []
    }
  });
  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: "controller-permission",
    method: "session/request_permission",
    params: {
      options: [{ optionId: "allow-always", kind: "allow_always" }]
    }
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(writes.join("").trim()), {
    jsonrpc: "2.0",
    id: "controller-permission",
    result: { outcome: { outcome: "cancelled" } }
  });
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

test("ACP close is transport-only and leaves bounded signal outcomes to the authoritative owner", async () => {
  const privatePath = "/private/acp-close-secret/provider.sock";
  const unhandled = [];
  const uncaught = [];
  const onUnhandled = (error) => unhandled.push(error);
  const onUncaught = (error) => uncaught.push(error);
  process.on("unhandledRejection", onUnhandled);
  process.on("uncaughtException", onUncaught);

  const cases = [
    {
      name: "EPERM",
      signal() {
        const failure = new Error(
          `signal denied for pid=991001 at ${privatePath}`
        );
        failure.code = "EPERM";
        throw failure;
      }
    },
    {
      name: "ESRCH",
      signal() {
        const failure = new Error("process is already gone");
        failure.code = "ESRCH";
        throw failure;
      }
    },
    {
      name: "async",
      signal() {
        const failure = new Error(
          `late signal failure at ${privatePath}`
        );
        failure.code = "EPERM";
        return Promise.reject(failure);
      }
    }
  ].map((entry) => {
    const child = new FakeChild();
    let signalCalls = 0;
    child.kill = (...args) => {
      signalCalls += 1;
      return entry.signal(...args);
    };
    const client = new AcpClient(child, { timeoutMs: 1000 });
    client.close();
    return {
      ...entry,
      child,
      client,
      signalCalls: () => signalCalls
    };
  });

  try {
    // This crosses the former delayed-kill boundary. ACP must never call the
    // child signal callback; only the owner with exact identity may do so.
    await new Promise((resolve) => setTimeout(resolve, 600));
    for (const entry of cases) {
      assert.equal(entry.child.stdin.writableEnded, true, entry.name);
      assert.equal(entry.signalCalls(), 0, entry.name);
      assert.equal(entry.client.closed, false, entry.name);
    }

    let permissionFailure = null;
    try {
      signalOwnedProcess(
        -cases[0].child.pid,
        "SIGTERM",
        (_target, signal) => cases[0].child.kill(signal)
      );
    } catch (error) {
      permissionFailure = error;
    }
    assert.equal(permissionFailure?.code, "E_PROCESS_IDENTITY");
    assert.equal(
      permissionFailure?.details?.secondaryDiagnostic?.code,
      "EPERM"
    );
    assert.equal(permissionFailure.message.includes("EPERM"), false);
    assert.equal(
      permissionFailure.details.secondaryDiagnostic.message.includes(
        privatePath
      ),
      false
    );
    assert.equal(
      permissionFailure.details.secondaryDiagnostic.message.includes(
        "991001"
      ),
      false
    );

    assert.equal(
      signalOwnedProcess(
        -cases[1].child.pid,
        "SIGTERM",
        (_target, signal) => cases[1].child.kill(signal)
      ),
      false
    );

    let asyncFailure = null;
    try {
      signalOwnedProcess(
        -cases[2].child.pid,
        "SIGTERM",
        (_target, signal) => cases[2].child.kill(signal)
      );
    } catch (error) {
      asyncFailure = error;
    }
    assert.equal(asyncFailure?.code, "E_PROCESS_IDENTITY");
    assert.equal(
      asyncFailure?.details?.secondaryDiagnostic?.code,
      "E_ASYNC_SIGNAL"
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.deepEqual(uncaught, []);

    for (const entry of cases) {
      assert.equal(entry.signalCalls(), 1, entry.name);
      entry.child.emit("exit", 0, null);
      assert.equal(entry.client.closed, true, entry.name);
    }
  } finally {
    process.off("unhandledRejection", onUnhandled);
    process.off("uncaughtException", onUncaught);
  }
});

test("validated ACP notifications preserve update and unknown event behavior", () => {
  const child = new FakeChild();
  const client = new AcpClient(child, {
    timeoutMs: 1000,
    knownSecrets: ["xai-live-notification-secret"]
  });
  const notifications = [];
  const updates = [];
  const unknown = [];
  const order = [];
  client.on("notification", (message) => {
    notifications.push(message);
    order.push(`notification:${message.method}`);
  });
  client.on("update", (update) => {
    updates.push(update);
    order.push("update");
  });
  client.on("unknown", (message) => {
    unknown.push(message);
    order.push(`unknown:${message.method}`);
  });

  const extension = {
    jsonrpc: "2.0",
    method: "_x.ai/git/worktree/status",
    params: {
      sessionId: "operation-1",
      status: "progress",
      message: "safe",
      apiKey: "xai-live-notification-secret"
    }
  };
  const update = {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { text: "hello" }
      }
    }
  };
  child.stdout.write(`${JSON.stringify(extension)}\n${JSON.stringify(update)}\n`);

  assert.deepEqual(notifications, [
    {
      ...extension,
      params: {
        ...extension.params,
        apiKey: "[REDACTED]"
      }
    },
    update
  ]);
  assert.deepEqual(unknown, [{
    ...extension,
    params: {
      ...extension.params,
      apiKey: "[REDACTED]"
    }
  }]);
  assert.deepEqual(updates, [{ type: "message", text: "hello" }]);
  assert.deepEqual(order, [
    "notification:_x.ai/git/worktree/status",
    "unknown:_x.ai/git/worktree/status",
    "notification:session/update",
    "update"
  ]);
  assert.equal(client.closed, false);
});

test("ACP notification validation rejects malformed envelopes before publication", async (t) => {
  const cases = [
    ["wrong version", {
      jsonrpc: "1.0",
      method: "_x.ai/git/worktree/status",
      params: {}
    }],
    ["id-bearing", {
      jsonrpc: "2.0",
      id: null,
      method: "_x.ai/git/worktree/status",
      params: {}
    }],
    ["response-shaped", {
      jsonrpc: "2.0",
      method: "_x.ai/git/worktree/status",
      result: {},
      params: {}
    }],
    ["extra field", {
      jsonrpc: "2.0",
      method: "_x.ai/git/worktree/status",
      params: {},
      extra: true
    }],
    ["primitive params", {
      jsonrpc: "2.0",
      method: "_x.ai/git/worktree/status",
      params: 7
    }]
  ];

  for (const [name, message] of cases) {
    await t.test(name, async () => {
      const child = new FakeChild();
      const client = new AcpClient(child, { timeoutMs: 1000 });
      const published = [];
      client.on("notification", (value) => published.push(value));
      client.on("unknown", (value) => published.push(value));
      const closed = once(client, "closed");
      child.stdout.write(`${JSON.stringify(message)}\n`);
      const [error] = await closed;
      assert.equal(error?.code, "E_PROTOCOL");
      assert.deepEqual(published, []);
      assert.equal(client.closed, true);
    });
  }
});

test("JSON-RPC notification validator accepts only id-less structured notification frames", () => {
  assert.equal(isValidJsonRpcNotification({
    jsonrpc: "2.0",
    method: "notifications/no-params"
  }), true);
  assert.equal(isValidJsonRpcNotification({
    jsonrpc: "2.0",
    method: "notifications/array",
    params: []
  }), true);
  assert.equal(isValidJsonRpcNotification({
    jsonrpc: "2.0",
    method: "notifications/null",
    params: null
  }), false);
});
