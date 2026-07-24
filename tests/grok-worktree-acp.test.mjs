import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { CompanionError } from "../plugins/grok/scripts/lib/errors.mjs";
import {
  GrokWorktreeAcp,
  XAI_SESSION_CLOSE_WIRE,
  XAI_WORKTREE_CREATE_WIRE,
  XAI_WORKTREE_REMOVE_WIRE,
  XAI_WORKTREE_STATUS_WIRE,
  toWireExtensionMethod,
  unwrapExtensionResult
} from "../plugins/grok/scripts/lib/grok-worktree-acp.mjs";

const OPERATION_ID = "official-worktree-operation-1";
const SOURCE_PATH = "/private/tmp/official-grok-source";
const WORKTREE_PATH = "/private/tmp/official-grok-worktree";
const SOURCE_GIT_ROOT = "/private/tmp/official-grok-source";
const COMMIT = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);

class FakeAcpClient extends EventEmitter {
  constructor(onRequest) {
    super();
    this.onRequest = onRequest;
    this.calls = [];
    this.closed = false;
  }

  request(method, params, timeoutMs) {
    const call = { method, params, timeoutMs };
    this.calls.push(call);
    return this.onRequest(call, this);
  }

  closeWith(error = new CompanionError("E_PROVIDER_EXIT", "ACP provider exited.")) {
    this.closed = true;
    this.emit("closed", error);
  }
}

function nested(result) {
  return { result };
}

function creating(overrides = {}) {
  return nested({
    status: "creating",
    sessionId: OPERATION_ID,
    worktreePath: WORKTREE_PATH,
    sourceGitRoot: SOURCE_GIT_ROOT,
    ...overrides
  });
}

function exists(overrides = {}) {
  return nested({
    status: "exists",
    sessionId: OPERATION_ID,
    worktreePath: WORKTREE_PATH,
    sourceGitRoot: SOURCE_GIT_ROOT,
    commit: COMMIT,
    ...overrides
  });
}

function created(overrides = {}) {
  return {
    status: "created",
    sessionId: OPERATION_ID,
    worktreePath: WORKTREE_PATH,
    sourceGitRoot: SOURCE_GIT_ROOT,
    commit: COMMIT,
    ...overrides
  };
}

function notify(client, params, method = XAI_WORKTREE_STATUS_WIRE) {
  client.emit("notification", {
    jsonrpc: "2.0",
    method,
    params
  });
}

function createInput(overrides = {}) {
  return {
    operationId: OPERATION_ID,
    sourcePath: SOURCE_PATH,
    worktreePath: WORKTREE_PATH,
    gitRef: COMMIT,
    timeoutMs: 1000,
    ...overrides
  };
}

function assertFailureCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

test("logical x.ai methods map only to underscore-prefixed wire methods", () => {
  assert.equal(
    toWireExtensionMethod("x.ai/git/worktree/create"),
    XAI_WORKTREE_CREATE_WIRE
  );
  assert.equal(
    toWireExtensionMethod("x.ai/session/close"),
    XAI_SESSION_CLOSE_WIRE
  );
  for (const invalid of [
    "_x.ai/git/worktree/create",
    "x.ai",
    "x.ai/",
    "x.ai//git",
    "session/close",
    "",
    null
  ]) {
    assert.throws(
      () => toWireExtensionMethod(invalid),
      assertFailureCode("E_PROTOCOL")
    );
  }
});

test("nested extension envelopes fail closed on missing, extra, and inner-error branches", () => {
  assert.deepEqual(unwrapExtensionResult({ result: { ok: true } }), { ok: true });
  assert.equal(unwrapExtensionResult({ result: null, error: null }), null);

  const invalid = [
    null,
    [],
    {},
    { result: {}, extra: true },
    { result: null, error: "" },
    { result: null, error: 7 },
    { result: null, error: { code: "failed" } },
    { result: null, error: { code: "failed", message: "no", extra: true } }
  ];
  for (const envelope of invalid) {
    assert.throws(
      () => unwrapExtensionResult(envelope),
      assertFailureCode("E_PROTOCOL")
    );
  }
  assert.throws(
    () => unwrapExtensionResult({ result: null, error: "official failure" }),
    (error) => error?.code === "E_PROTOCOL" && error.message === "official failure"
  );
  assert.throws(
    () => unwrapExtensionResult({
      result: null,
      error: {
        code: "worktree_failed",
        message: "official structured failure",
        data: { safe: true }
      }
    }),
    (error) => (
      error?.code === "E_PROTOCOL"
      && error.message === "official structured failure"
      && error.details?.extensionCode === "worktree_failed"
    )
  );
});

test("creating to created validates every progress shape and exact clean request", async () => {
  const client = new FakeAcpClient((call, activeClient) => {
    assert.equal(call.method, XAI_WORKTREE_CREATE_WIRE);
    setImmediate(() => {
      notify(activeClient, {
        status: "progress",
        sessionId: OPERATION_ID,
        message: "starting"
      });
      notify(activeClient, {
        status: "analyzing",
        sessionId: OPERATION_ID,
        message: "analyzing source"
      });
      notify(activeClient, {
        status: "sourceInfo",
        sessionId: OPERATION_ID,
        sourceCommit: COMMIT,
        sourceBranch: null,
        dirtyState: {
          stagedCount: 0,
          modifiedCount: 0,
          deletedCount: 0,
          untrackedCount: 0,
          hasPartiallyStaged: false,
          skippedDirs: []
        }
      });
      notify(activeClient, {
        status: "copyingChanges",
        sessionId: OPERATION_ID,
        phase: "modified",
        current: 0,
        total: 0,
        currentFile: null
      });
      notify(activeClient, created());
    });
    return creating();
  });
  const adapter = new GrokWorktreeAcp(client);

  const result = await adapter.create(createInput({
    label: "official-acp-pivot-e2e"
  }));

  assert.deepEqual(result, created());
  assert.deepEqual(client.calls, [{
    method: XAI_WORKTREE_CREATE_WIRE,
    params: {
      sessionId: OPERATION_ID,
      sourcePath: SOURCE_PATH,
      worktreePath: WORKTREE_PATH,
      copyMode: "clean",
      gitRef: COMMIT,
      copyIgnoredInBackground: false,
      ignoredSkipPatterns: [],
      worktreeType: "git",
      label: "official-acp-pivot-e2e"
    },
    timeoutMs: 1000
  }]);
  assert.equal(client.listenerCount("notification"), 0);
  assert.equal(client.listenerCount("closed"), 0);
});

test("immediate exists is a terminal success without a status notification", async () => {
  const client = new FakeAcpClient(() => exists());
  const adapter = new GrokWorktreeAcp(client);

  assert.deepEqual(await adapter.create(createInput()), {
    status: "exists",
    sessionId: OPERATION_ID,
    worktreePath: WORKTREE_PATH,
    sourceGitRoot: SOURCE_GIT_ROOT,
    commit: COMMIT
  });
  assert.equal(Object.hasOwn(client.calls[0].params, "label"), false);
  assert.equal(client.listenerCount("notification"), 0);
  assert.equal(client.listenerCount("closed"), 0);
});

test("notification-before-response is retained and resolves only after a valid create response", async () => {
  let notificationObserved = false;
  const client = new FakeAcpClient((_call, activeClient) => {
    notify(activeClient, created());
    notificationObserved = true;
    return creating();
  });
  const adapter = new GrokWorktreeAcp(client);

  const result = await adapter.create(createInput());
  assert.equal(notificationObserved, true);
  assert.deepEqual(result, created());
});

test("a consistent created notification followed by an exists replay response succeeds", async () => {
  const client = new FakeAcpClient((_call, activeClient) => {
    notify(activeClient, created());
    return exists();
  });
  const result = await new GrokWorktreeAcp(client).create(createInput());
  assert.deepEqual(result, created());
});

test("a raced terminal notification cannot bypass create-response validation", async () => {
  const client = new FakeAcpClient((_call, activeClient) => {
    notify(activeClient, created());
    return {
      result: {
        status: "creating",
        sessionId: OPERATION_ID,
        worktreePath: WORKTREE_PATH,
        unexpected: true
      }
    };
  });
  await assert.rejects(
    new GrokWorktreeAcp(client).create(createInput()),
    assertFailureCode("E_PROTOCOL")
  );
});

test("unrelated malformed and terminal notifications cannot poison an operation", async () => {
  const client = new FakeAcpClient((_call, activeClient) => {
    notify(activeClient, {
      sessionId: "another-operation",
      status: "created",
      worktreePath: 7,
      commit: null
    });
    notify(activeClient, {
      sessionId: "another-operation",
      status: "error",
      message: "another worker failed"
    });
    notify(activeClient, {
      sessionId: "another-operation",
      status: "created",
      worktreePath: 7
    }, "x.ai/git/worktree/status");
    notify(activeClient, created());
    return creating();
  });
  const adapter = new GrokWorktreeAcp(client);

  assert.deepEqual(await adapter.create(createInput()), created());
});

test("a malformed matching status notification fails closed", async (t) => {
  const cases = [
    ["missing status", {
      sessionId: OPERATION_ID
    }],
    ["unknown status", {
      sessionId: OPERATION_ID,
      status: "futureStatus"
    }],
    ["created missing commit", {
      status: "created",
      sessionId: OPERATION_ID,
      worktreePath: WORKTREE_PATH
    }],
    ["progress missing message", {
      status: "progress",
      sessionId: OPERATION_ID
    }],
    ["unexpected field", {
      ...created(),
      unexpected: true
    }],
    ["malformed source info", {
      status: "sourceInfo",
      sessionId: OPERATION_ID,
      sourceCommit: COMMIT,
      sourceBranch: null,
      dirtyState: {}
    }]
  ];

  for (const [name, status] of cases) {
    await t.test(name, async () => {
      const client = new FakeAcpClient((_call, activeClient) => {
        notify(activeClient, status);
        return creating();
      });
      const adapter = new GrokWorktreeAcp(client);
      await assert.rejects(
        adapter.create(createInput()),
        assertFailureCode("E_PROTOCOL")
      );
      assert.equal(client.listenerCount("notification"), 0);
      assert.equal(client.listenerCount("closed"), 0);
    });
  }
});

test("optional sourceGitRoot may be absent and logical status spelling is accepted", async () => {
  const client = new FakeAcpClient((_call, activeClient) => {
    notify(activeClient, {
      status: "created",
      sessionId: OPERATION_ID,
      worktreePath: WORKTREE_PATH,
      commit: COMMIT
    }, "x.ai/git/worktree/status");
    return nested({
      status: "creating",
      sessionId: OPERATION_ID,
      worktreePath: WORKTREE_PATH
    });
  });
  const result = await new GrokWorktreeAcp(client).create(createInput());
  assert.deepEqual(result, {
    status: "created",
    sessionId: OPERATION_ID,
    worktreePath: WORKTREE_PATH,
    commit: COMMIT
  });

  const existsClient = new FakeAcpClient(() => nested({
    status: "exists",
    sessionId: OPERATION_ID,
    worktreePath: WORKTREE_PATH,
    commit: COMMIT
  }));
  assert.deepEqual(
    await new GrokWorktreeAcp(existsClient).create(createInput()),
    {
      status: "exists",
      sessionId: OPERATION_ID,
      worktreePath: WORKTREE_PATH,
      commit: COMMIT
    }
  );
});

test("matching terminal path and commit must equal the requested values", async (t) => {
  const cases = [
    ["wrong path", created({ worktreePath: "/private/tmp/wrong-worktree" })],
    ["wrong commit", created({ commit: OTHER_COMMIT })]
  ];
  for (const [name, status] of cases) {
    await t.test(name, async () => {
      const client = new FakeAcpClient((_call, activeClient) => {
        notify(activeClient, status);
        return creating();
      });
      await assert.rejects(
        new GrokWorktreeAcp(client).create(createInput()),
        assertFailureCode("E_WORKTREE")
      );
    });
  }
});

test("create response identity, path, and exists commit are exact", async (t) => {
  const cases = [
    ["wrong operation", creating({ sessionId: "another-operation" })],
    ["wrong path", creating({ worktreePath: "/private/tmp/wrong-worktree" })],
    ["wrong exists commit", exists({ commit: OTHER_COMMIT })]
  ];
  for (const [name, response] of cases) {
    await t.test(name, async () => {
      const client = new FakeAcpClient(() => response);
      await assert.rejects(
        new GrokWorktreeAcp(client).create(createInput()),
        assertFailureCode("E_WORKTREE")
      );
    });
  }
});

test("matching error and cancelled terminal statuses retain distinct outcomes", async (t) => {
  await t.test("error", async () => {
    const client = new FakeAcpClient((_call, activeClient) => {
      setImmediate(() => notify(activeClient, {
        status: "error",
        sessionId: OPERATION_ID,
        message: "official creation failed"
      }));
      return creating();
    });
    await assert.rejects(
      new GrokWorktreeAcp(client).create(createInput()),
      (error) => (
        error?.code === "E_WORKTREE"
        && error.message === "official creation failed"
      )
    );
  });

  await t.test("cancelled", async () => {
    const client = new FakeAcpClient((_call, activeClient) => {
      setImmediate(() => notify(activeClient, {
        status: "cancelled",
        sessionId: OPERATION_ID
      }));
      return creating();
    });
    await assert.rejects(
      new GrokWorktreeAcp(client).create(createInput()),
      assertFailureCode("E_CANCELLED")
    );
  });
});

test("worktree create fails on bounded timeout and transport close", async (t) => {
  await t.test("timeout", async () => {
    const client = new FakeAcpClient(() => creating());
    const adapter = new GrokWorktreeAcp(client, { timeoutMs: 20 });
    await assert.rejects(
      adapter.create(createInput({ timeoutMs: 20 })),
      assertFailureCode("E_TIMEOUT")
    );
    assert.equal(client.listenerCount("notification"), 0);
    assert.equal(client.listenerCount("closed"), 0);
  });

  await t.test("close", async () => {
    const failure = new CompanionError("E_PROVIDER_EXIT", "provider exited");
    const client = new FakeAcpClient((_call, activeClient) => {
      setImmediate(() => activeClient.closeWith(failure));
      return creating();
    });
    await assert.rejects(
      new GrokWorktreeAcp(client).create(createInput()),
      (error) => error === failure
    );
    assert.equal(client.listenerCount("notification"), 0);
    assert.equal(client.listenerCount("closed"), 0);
  });
});

test("malformed create result envelopes and pre-response duplicate terminal events fail closed", async (t) => {
  const responses = [
    ["not nested", {
      status: "creating",
      sessionId: OPERATION_ID
    }],
    ["missing worktree path", nested({
      status: "creating",
      sessionId: OPERATION_ID,
      sourceGitRoot: SOURCE_GIT_ROOT
    })],
    ["creating has commit", creating({ commit: COMMIT })],
    ["unsupported status", creating({ status: "created" })],
    ["nested error", {
      result: null,
      error: "official request failed"
    }]
  ];
  for (const [name, response] of responses) {
    await t.test(name, async () => {
      const client = new FakeAcpClient(() => response);
      await assert.rejects(
        new GrokWorktreeAcp(client).create(createInput()),
        assertFailureCode("E_PROTOCOL")
      );
    });
  }

  await t.test("duplicate terminal", async () => {
    const client = new FakeAcpClient((_call, activeClient) => {
      notify(activeClient, created());
      notify(activeClient, created());
      return creating();
    });
    await assert.rejects(
      new GrokWorktreeAcp(client).create(createInput()),
      assertFailureCode("E_PROTOCOL")
    );
  });
});

test("close and remove use exact official wire methods and nested results", async () => {
  const client = new FakeAcpClient((call) => {
    if (call.method === XAI_SESSION_CLOSE_WIRE) {
      return nested({ success: true });
    }
    if (call.method === XAI_WORKTREE_REMOVE_WIRE) {
      if (call.params.dryRun) {
        return nested({
          removed: false,
          resolvedPath: WORKTREE_PATH
        });
      }
      return nested({
        removed: true,
        resolvedPath: WORKTREE_PATH
      });
    }
    throw new Error(`Unexpected method: ${call.method}`);
  });
  const adapter = new GrokWorktreeAcp(client);

  assert.deepEqual(
    await adapter.close({ sessionId: "provider-session-1", timeoutMs: 111 }),
    { success: true }
  );
  assert.deepEqual(
    await adapter.remove({
      worktreePath: WORKTREE_PATH,
      force: true,
      dryRun: false,
      timeoutMs: 222
    }),
    { removed: true, resolvedPath: WORKTREE_PATH }
  );
  assert.deepEqual(
    await adapter.remove({
      idOrPath: "worktree-database-id",
      force: false,
      dryRun: true,
      timeoutMs: 333
    }),
    { removed: false, resolvedPath: WORKTREE_PATH }
  );
  assert.deepEqual(client.calls, [
    {
      method: XAI_SESSION_CLOSE_WIRE,
      params: { sessionId: "provider-session-1" },
      timeoutMs: 111
    },
    {
      method: XAI_WORKTREE_REMOVE_WIRE,
      params: {
        worktreePath: WORKTREE_PATH,
        force: true,
        dryRun: false
      },
      timeoutMs: 222
    },
    {
      method: XAI_WORKTREE_REMOVE_WIRE,
      params: {
        idOrPath: "worktree-database-id",
        force: false,
        dryRun: true
      },
      timeoutMs: 333
    }
  ]);
});

test("close and remove reject ambiguous inputs and malformed nested results", async (t) => {
  const unused = new FakeAcpClient(() => {
    throw new Error("request must not be dispatched");
  });
  const adapter = new GrokWorktreeAcp(unused);
  for (const input of [
    {},
    { worktreePath: WORKTREE_PATH, idOrPath: "id" },
    { worktreePath: "relative/path" },
    { idOrPath: "" },
    { idOrPath: "id", force: "yes" },
    { idOrPath: "id", dryRun: 1 }
  ]) {
    await assert.rejects(
      adapter.remove(input),
      assertFailureCode("E_PROTOCOL")
    );
  }
  assert.equal(unused.calls.length, 0);

  await t.test("malformed close result", async () => {
    const client = new FakeAcpClient(() => nested({ success: false }));
    await assert.rejects(
      new GrokWorktreeAcp(client).close({ sessionId: "provider-session-1" }),
      assertFailureCode("E_PROTOCOL")
    );
  });

  await t.test("malformed remove result", async () => {
    const client = new FakeAcpClient(() => nested({
      removed: "yes",
      resolvedPath: WORKTREE_PATH
    }));
    await assert.rejects(
      new GrokWorktreeAcp(client).remove({ worktreePath: WORKTREE_PATH }),
      assertFailureCode("E_PROTOCOL")
    );
  });

  await t.test("non-dry removal must confirm removed true", async () => {
    const client = new FakeAcpClient(() => nested({
      removed: false,
      resolvedPath: WORKTREE_PATH
    }));
    await assert.rejects(
      new GrokWorktreeAcp(client).remove({ worktreePath: WORKTREE_PATH }),
      assertFailureCode("E_WORKTREE")
    );
  });

  await t.test("dry-run removal must not report an actual removal", async () => {
    const client = new FakeAcpClient(() => nested({
      removed: true,
      resolvedPath: WORKTREE_PATH
    }));
    await assert.rejects(
      new GrokWorktreeAcp(client).remove({
        worktreePath: WORKTREE_PATH,
        dryRun: true
      }),
      assertFailureCode("E_WORKTREE")
    );
  });

  await t.test("explicit worktree path must match the resolved removal target", async () => {
    const client = new FakeAcpClient(() => nested({
      removed: true,
      resolvedPath: "/private/tmp/different-worktree"
    }));
    await assert.rejects(
      new GrokWorktreeAcp(client).remove({ worktreePath: WORKTREE_PATH }),
      assertFailureCode("E_WORKTREE")
    );
  });
});

test("constructor, create inputs, and a pre-closed client fail before dispatch", async () => {
  assert.throws(
    () => new GrokWorktreeAcp({ request() {} }),
    assertFailureCode("E_PROTOCOL")
  );

  const client = new FakeAcpClient(() => {
    throw new Error("request must not be dispatched");
  });
  const adapter = new GrokWorktreeAcp(client);
  for (const input of [
    createInput({ operationId: "" }),
    createInput({ sourcePath: "relative" }),
    createInput({ worktreePath: "relative" }),
    createInput({ gitRef: "abc123" }),
    createInput({ label: "" }),
    createInput({ timeoutMs: 0 })
  ]) {
    await assert.rejects(
      adapter.create(input),
      assertFailureCode("E_PROTOCOL")
    );
  }
  assert.equal(client.calls.length, 0);

  client.closed = true;
  await assert.rejects(
    adapter.create(createInput()),
    assertFailureCode("E_PROTOCOL")
  );
  await assert.rejects(
    adapter.close({ sessionId: "provider-session-1" }),
    assertFailureCode("E_PROTOCOL")
  );
  await assert.rejects(
    adapter.remove({ worktreePath: WORKTREE_PATH }),
    assertFailureCode("E_PROTOCOL")
  );
  assert.equal(client.calls.length, 0);
});
