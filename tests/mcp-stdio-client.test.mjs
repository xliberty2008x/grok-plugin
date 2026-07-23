import assert from "node:assert/strict";
import { ChildProcess, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";

import {
  McpStdioClientError,
  spawnMcpStdioClient
} from "../scripts/lib/mcp-stdio-client.mjs";

const TEST_TIMEOUT_MS = 10_000;
const PROTOCOL_VERSION = "2025-11-25";
const INITIALIZE_OPTIONS = Object.freeze({
  protocolVersion: PROTOCOL_VERSION,
  clientInfo: Object.freeze({ name: "fixture-client", version: "1" }),
  capabilities: Object.freeze({})
});

function fixture(t, source, prefix = "grok-mcp-client-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const script = path.join(root, "fixture.mjs");
  fs.writeFileSync(script, source, "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, script };
}

function brokerFixture(t, {
  initializeResult = `({
    protocolVersion: frame.params.protocolVersion,
    serverInfo: { name: "fixture-server", version: "1" },
    capabilities: {}
  })`,
  onInitialized = "",
  body = ""
} = {}) {
  return fixture(t, `
    import readline from "node:readline";
    const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    let initialized = false;
    lines.on("line", async (line) => {
      const frame = JSON.parse(line);
      if (frame.method === "initialize") {
        send({ jsonrpc: "2.0", id: frame.id, result: ${initializeResult} });
        return;
      }
      if (frame.method === "notifications/initialized") {
        initialized = true;
        ${onInitialized}
        return;
      }
      ${body}
    });
  `);
}

function clientFor({ root, script }, options = {}) {
  return spawnMcpStdioClient({
    executable: process.execPath,
    argv: [script],
    cwd: root,
    env: { ...process.env, ...(options.env ?? {}) },
    rpcTimeoutMs: options.rpcTimeoutMs ?? 1_000,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 100
  });
}

function initializeClient(client, validator = (result) => (
  result.serverInfo.name === "fixture-server"
  && isRecord(result.capabilities)
)) {
  return client.initialize(INITIALIZE_OPTIONS, validator);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertClientError(error, code) {
  assert.ok(error instanceof McpStdioClientError);
  assert.equal(error.code, code);
  assert.equal(error.stack, `${error.name}: ${error.message}`);
  return true;
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for deterministic fixture state.");
}

function assertNoResources(client) {
  const diagnostics = client.diagnostics();
  assert.equal(diagnostics.pendingRequests, 0);
  assert.equal(diagnostics.activeOperations, 0);
  assert.equal(diagnostics.activeWrites, 0);
  assert.equal(diagnostics.queuedWrites, 0);
  assert.equal(diagnostics.queuedPayloadBytes, 0);
  assert.equal(diagnostics.readyWaiters, 0);
  assert.equal(diagnostics.activeTimers, 0);
  assert.equal(diagnostics.initialization.retainedClones, 0);
  assert.equal(diagnostics.stdout.bufferedBytes, 0);
}

function assertClosed(client) {
  const diagnostics = client.diagnostics();
  assert.equal(diagnostics.state, "closed");
  assert.equal(diagnostics.childExited, true);
  assert.equal(diagnostics.listenerCount, 0);
  assert.equal(diagnostics.handlesReleased, true);
  assert.equal(diagnostics.shutdownRetryable, false);
  assertNoResources(client);
}

function publicSurface(client) {
  return JSON.stringify({
    keys: Reflect.ownKeys(client),
    descriptors: Object.getOwnPropertyDescriptors(client),
    extensible: Object.isExtensible(client),
    serialized: JSON.stringify(client),
    inspected: inspect(client, { depth: 4, showHidden: true }),
    prototypeKeys: Reflect.ownKeys(Object.getPrototypeOf(client)).map(String),
    diagnostics: client.diagnostics()
  });
}

test("initialize negotiates once, acknowledges, then enables ordinary MCP calls", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const marker = "initialized.marker";
  const local = brokerFixture(t, {
    onInitialized: `fs.writeFileSync(${JSON.stringify(marker)}, "yes");`,
    body: `
      if (frame.method === "ping") {
        send({ jsonrpc: "2.0", id: frame.id, result: {} });
      } else if (Object.hasOwn(frame, "id")) {
        send({ jsonrpc: "2.0", id: frame.id, result: { method: frame.method, params: frame.params } });
      }
    `
  });
  // Add the one fixture import needed by onInitialized.
  fs.writeFileSync(local.script, fs.readFileSync(local.script, "utf8").replace(
    'import readline from "node:readline";',
    'import fs from "node:fs";\nimport readline from "node:readline";'
  ), "utf8");
  const client = clientFor(local);
  t.after(() => client.terminate());

  await assert.rejects(client.request("tools/list"), (error) => assertClientError(error, "E_MCP_NOT_INITIALIZED"));
  await assert.rejects(client.notify("notifications/test", {}), (error) => assertClientError(error, "E_MCP_NOT_INITIALIZED"));
  const result = await initializeClient(client, (server) => (
    server.serverInfo.name === "fixture-server"
    && server.capabilities !== null
  ));
  assert.equal(result.protocolVersion, PROTOCOL_VERSION);
  await waitFor(() => fs.existsSync(path.join(local.root, marker)));
  assert.deepEqual(await client.request("tools/list", {}), {
    method: "tools/list",
    params: {}
  });
  assert.deepEqual(await client.ping(), {});
  await assert.rejects(
    initializeClient(client),
    (error) => assertClientError(error, "E_MCP_LIFECYCLE")
  );
  await client.close();
  assertClosed(client);
});

test("concurrent initialize is rejected while the first negotiation can complete", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const local = fixture(t, `
    import readline from "node:readline";
    const lines = readline.createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      const frame = JSON.parse(line);
      if (frame.method !== "initialize") return;
      setTimeout(() => process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: frame.id,
        result: {
          protocolVersion: frame.params.protocolVersion,
          serverInfo: { name: "fixture-server", version: "1" },
          capabilities: {}
        }
      }) + "\\n"), 30);
    });
  `);
  const client = clientFor(local);
  const first = initializeClient(client);
  await assert.rejects(
    initializeClient(client),
    (error) => assertClientError(error, "E_MCP_LIFECYCLE")
  );
  await first;
  await client.close();
  assertClosed(client);
});

test("same-stack initialize flood admits one ready waiter and one wire frame", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const marker = "initialize-frame-count";
  const local = fixture(t, `
    import fs from "node:fs";
    import readline from "node:readline";
    const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    let initializeFrames = 0;
    lines.on("line", (line) => {
      const frame = JSON.parse(line);
      if (frame.method !== "initialize") return;
      initializeFrames += 1;
      fs.writeFileSync(${JSON.stringify(marker)}, String(initializeFrames));
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: frame.id,
        result: {
          protocolVersion: frame.params.protocolVersion,
          serverInfo: { name: "fixture-server", version: "1" },
          capabilities: {}
        }
      }) + "\\n");
    });
  `);
  const client = clientFor(local);
  t.after(() => client.terminate());

  const first = initializeClient(client);
  let getterCalls = 0;
  const hostileOptions = {};
  Object.defineProperty(hostileOptions, "protocolVersion", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return PROTOCOL_VERSION;
    }
  });
  const validFollowerOptions = Object.freeze({
    ...INITIALIZE_OPTIONS,
    _meta: Object.freeze({ padding: "x".repeat(4_096) })
  });
  const validFollowers = Array.from(
    { length: 2_048 },
    () => client.initialize(validFollowerOptions, () => true)
  );
  const hostileFollowers = Array.from(
    { length: 64 },
    () => client.initialize(hostileOptions, () => true)
  );
  const rejected = [...validFollowers, ...hostileFollowers];

  const admitted = client.diagnostics();
  assert.equal(admitted.protocolState, "initializing");
  assert.equal(admitted.readyWaiters, 1);
  assert.equal(admitted.pendingRequests, 0);
  assert.equal(admitted.activeOperations, 0);
  assert.equal(admitted.queuedPayloadBytes, 0);
  assert.equal(admitted.activeTimers, 0);
  assert.equal(admitted.initialization.clonedPayloads, 1);
  assert.equal(admitted.initialization.retainedClones, 1);
  assert.equal(getterCalls, 0);
  await Promise.all(rejected.map((promise) => assert.rejects(
    promise,
    (error) => assertClientError(error, "E_MCP_LIFECYCLE")
  )));
  assert.equal(getterCalls, 0);

  await first;
  await waitFor(() => fs.existsSync(path.join(local.root, marker)));
  assert.equal(fs.readFileSync(path.join(local.root, marker), "utf8"), "1");
  assert.equal(client.diagnostics().readyWaiters, 0);
  assert.equal(client.diagnostics().initialization.clonedPayloads, 1);
  assert.equal(client.diagnostics().initialization.retainedClones, 0);
  await client.close();
  assertClosed(client);
});

test("same-stack pre-initialize request and notification floods admit no work", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const local = fixture(t, "setInterval(() => {}, 1000);");
  const client = clientFor(local);
  t.after(() => client.terminate());

  let getterCalls = 0;
  const hostileParams = {};
  Object.defineProperty(hostileParams, "value", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "unsafe";
    }
  });
  const rejected = [
    client.request("fixture/preinit", hostileParams),
    client.notify("notifications/preinit", hostileParams)
  ];
  for (let index = 0; index < 1_024; index += 1) {
    rejected.push(client.request("fixture/preinit", { index }));
    rejected.push(client.notify("notifications/preinit", { index }));
  }

  assert.equal(client.diagnostics().protocolState, "uninitialized");
  assert.equal(getterCalls, 0);
  assertNoResources(client);
  await Promise.all(rejected.map((promise) => assert.rejects(
    promise,
    (error) => assertClientError(error, "E_MCP_NOT_INITIALIZED")
  )));
  assert.equal(getterCalls, 0);
  assertNoResources(client);
  await client.close();
  assertClosed(client);
});

test("synchronous initialize preflight failure rolls back its claim for same-stack retry", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const local = brokerFixture(t);
  const client = clientFor(local);
  t.after(() => client.terminate());

  let getterCalls = 0;
  const accessorOptions = { ...INITIALIZE_OPTIONS };
  Object.defineProperty(accessorOptions, "protocolVersion", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return PROTOCOL_VERSION;
    }
  });
  const accessorInvalid = client.initialize(accessorOptions, () => true);
  assert.equal(client.diagnostics().protocolState, "uninitialized");
  assert.equal(getterCalls, 0);
  assertNoResources(client);

  const proxyInvalid = client.initialize(new Proxy(INITIALIZE_OPTIONS, {
    getOwnPropertyDescriptor() {
      throw new Error("must be structuralized");
    }
  }), () => true);
  assert.equal(client.diagnostics().protocolState, "uninitialized");
  assertNoResources(client);

  const cyclicClientInfo = { name: "fixture-client", version: "1" };
  cyclicClientInfo.self = cyclicClientInfo;
  const cyclicInvalid = client.initialize({
    ...INITIALIZE_OPTIONS,
    clientInfo: cyclicClientInfo
  }, () => true);
  assert.equal(client.diagnostics().protocolState, "uninitialized");
  assertNoResources(client);

  const retry = initializeClient(client);
  assert.equal(client.diagnostics().protocolState, "initializing");
  assert.equal(client.diagnostics().readyWaiters, 1);
  await assert.rejects(
    accessorInvalid,
    (error) => assertClientError(error, "E_MCP_ARGUMENT")
  );
  await assert.rejects(
    proxyInvalid,
    (error) => assertClientError(error, "E_MCP_ARGUMENT")
  );
  await assert.rejects(
    cyclicInvalid,
    (error) => assertClientError(error, "E_MCP_ARGUMENT")
  );
  await retry;
  assert.equal(client.diagnostics().protocolState, "initialized");
  assert.equal(client.diagnostics().readyWaiters, 0);
  assert.equal(client.diagnostics().initialization.clonedPayloads, 1);
  assert.equal(client.diagnostics().initialization.retainedClones, 0);
  await client.close();
  assertClosed(client);
});

for (const shutdownMethod of ["close", "terminate"]) {
  test(`${shutdownMethod} clears the sole pre-spawn initialize waiter deterministically`, { timeout: TEST_TIMEOUT_MS }, async (t) => {
    const local = brokerFixture(t);
    const client = clientFor(local);
    t.after(() => client.terminate());

    const initializing = initializeClient(client);
    assert.equal(client.diagnostics().protocolState, "initializing");
    assert.equal(client.diagnostics().readyWaiters, 1);
    const shuttingDown = client[shutdownMethod]();
    assert.equal(client.diagnostics().protocolState, "failed");
    await assert.rejects(
      initializing,
      (error) => assertClientError(error, "E_MCP_CLOSED")
    );
    await shuttingDown;
    assert.equal(client.diagnostics().protocolState, "failed");
    assertClosed(client);
  });
}

for (const [label, initializeResult, validator] of [
  [
    "protocol mismatch",
    `({
      protocolVersion: "2024-11-05",
      serverInfo: { name: "fixture-server", version: "1" },
      capabilities: {}
    })`,
    () => true
  ],
  [
    "malformed initialize result",
    `({
      protocolVersion: frame.params.protocolVersion,
      serverInfo: { name: "fixture-server", version: "1" }
    })`,
    () => true
  ],
  [
    "runner identity rejection",
    `({
      protocolVersion: frame.params.protocolVersion,
      serverInfo: { name: "unexpected-server", version: "1" },
      capabilities: {}
    })`,
    () => false
  ]
]) {
  test(`${label} disconnects without initialized acknowledgment`, { timeout: TEST_TIMEOUT_MS }, async (t) => {
    const marker = "ack.marker";
    const local = brokerFixture(t, {
      initializeResult,
      onInitialized: `fs.writeFileSync(${JSON.stringify(marker)}, "unexpected");`,
      body: "setInterval(() => {}, 1000);"
    });
    fs.writeFileSync(local.script, fs.readFileSync(local.script, "utf8").replace(
      'import readline from "node:readline";',
      'import fs from "node:fs";\nimport readline from "node:readline";'
    ), "utf8");
    const client = clientFor(local, { shutdownTimeoutMs: 50 });
    await assert.rejects(
      client.initialize(INITIALIZE_OPTIONS, validator),
      (error) => assertClientError(error, "E_MCP_NEGOTIATION")
    );
    await client.close();
    assert.equal(fs.existsSync(path.join(local.root, marker)), false);
    assert.equal(client.diagnostics().failureCode, "E_MCP_NEGOTIATION");
    assertClosed(client);
  });
}

test("validator-triggered close cannot admit a late initialized notification", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const marker = "unexpected-ack";
  const local = brokerFixture(t, {
    onInitialized: `fs.writeFileSync(${JSON.stringify(marker)}, "unexpected");`
  });
  fs.writeFileSync(local.script, fs.readFileSync(local.script, "utf8").replace(
    'import readline from "node:readline";',
    'import fs from "node:fs";\nimport readline from "node:readline";'
  ), "utf8");
  const client = clientFor(local, { shutdownTimeoutMs: 50 });
  let closing;
  await assert.rejects(
    client.initialize(INITIALIZE_OPTIONS, () => {
      closing = client.close();
      return true;
    }),
    (error) => assertClientError(error, "E_MCP_CLOSED")
  );
  await closing;
  assert.equal(fs.existsSync(path.join(local.root, marker)), false);
  assertClosed(client);
});

test("validated server ping is answered before initialization", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const marker = "preinit-ping.json";
  const local = fixture(t, `
    import fs from "node:fs";
    import readline from "node:readline";
    const lines = readline.createInterface({ input: process.stdin });
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    send({ jsonrpc: "2.0", id: "preinit-ping", method: "ping", params: {} });
    lines.on("line", (line) => {
      const frame = JSON.parse(line);
      if (frame.id === "preinit-ping") {
        fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(frame));
      } else if (frame.method === "initialize") {
        send({
          jsonrpc: "2.0",
          id: frame.id,
          result: {
            protocolVersion: frame.params.protocolVersion,
            serverInfo: { name: "fixture-server", version: "1" },
            capabilities: {}
          }
        });
      }
    });
  `);
  const client = clientFor(local);
  await waitFor(() => fs.existsSync(path.join(local.root, marker)));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(local.root, marker), "utf8")), {
    jsonrpc: "2.0",
    id: "preinit-ping",
    result: {}
  });
  await initializeClient(client);
  await client.close();
  assertClosed(client);
});

test("pre-initialize logging notification is discarded but other notifications are fatal", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const legal = fixture(t, `
    import readline from "node:readline";
    const lines = readline.createInterface({ input: process.stdin });
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "starting" } });
    lines.on("line", (line) => {
      const frame = JSON.parse(line);
      if (frame.method === "initialize") {
        send({
          jsonrpc: "2.0",
          id: frame.id,
          result: {
            protocolVersion: frame.params.protocolVersion,
            serverInfo: { name: "fixture-server", version: "1" },
            capabilities: {}
          }
        });
      }
    });
  `);
  const legalClient = clientFor(legal);
  await initializeClient(legalClient);
  await legalClient.close();
  assertClosed(legalClient);

  const illegal = fixture(t, `
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
      params: {}
    }) + "\\n");
    setInterval(() => {}, 1000);
  `);
  const illegalClient = clientFor(illegal, { shutdownTimeoutMs: 50 });
  await waitFor(() => illegalClient.diagnostics().failureCode !== null);
  assert.equal(illegalClient.diagnostics().failureCode, "E_MCP_LIFECYCLE");
  await illegalClient.close();
  assertClosed(illegalClient);
});

test("non-logging notification during initialize is lifecycle-fatal", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const local = fixture(t, `
    import readline from "node:readline";
    const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    lines.on("line", (line) => {
      const frame = JSON.parse(line);
      if (frame.method !== "initialize") return;
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
        params: {}
      }) + "\\n");
      setInterval(() => {}, 1000);
    });
  `);
  const client = clientFor(local, { shutdownTimeoutMs: 50 });
  await assert.rejects(
    initializeClient(client),
    (error) => assertClientError(error, "E_MCP_LIFECYCLE")
  );
  assert.equal(client.diagnostics().failureCode, "E_MCP_LIFECYCLE");
  await client.close();
  assertClosed(client);
});

test("same-event notification after initialize response remains lifecycle-fatal before acknowledgement", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const local = fixture(t, `
    import readline from "node:readline";
    const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    lines.on("line", (line) => {
      const frame = JSON.parse(line);
      if (frame.method !== "initialize") return;
      const response = JSON.stringify({
        jsonrpc: "2.0",
        id: frame.id,
        result: {
          protocolVersion: frame.params.protocolVersion,
          serverInfo: { name: "fixture-server", version: "1" },
          capabilities: {}
        }
      });
      const notification = JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
        params: {}
      });
      process.stdout.write(response + "\\n" + notification + "\\n");
    });
  `);
  const client = clientFor(local, { shutdownTimeoutMs: 50 });
  await assert.rejects(
    initializeClient(client),
    (error) => assertClientError(error, "E_MCP_LIFECYCLE")
  );
  assert.equal(client.diagnostics().failureCode, "E_MCP_LIFECYCLE");
  await client.close();
  assertClosed(client);
});

for (const [label, resultSource, validator] of [
  [
    "malformed",
    `({
      protocolVersion: frame.params.protocolVersion,
      serverInfo: { name: "fixture-server", version: "1" }
    })`,
    () => true
  ],
  [
    "identity-rejected",
    `({
      protocolVersion: frame.params.protocolVersion,
      serverInfo: { name: "unexpected-server", version: "1" },
      capabilities: {}
    })`,
    (result) => result.serverInfo.name === "fixture-server"
  ]
]) {
  test(`${label} initialize result cannot admit a same-event notification`, { timeout: TEST_TIMEOUT_MS }, async (t) => {
    const local = fixture(t, `
      import readline from "node:readline";
      const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      lines.on("line", (line) => {
        const frame = JSON.parse(line);
        if (frame.method !== "initialize") return;
        const response = JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          result: ${resultSource}
        });
        const notification = JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
          params: {}
        });
        process.stdout.write(response + "\\n" + notification + "\\n");
      });
    `);
    const client = clientFor(local, { shutdownTimeoutMs: 50 });
    await assert.rejects(
      client.initialize(INITIALIZE_OPTIONS, validator),
      (error) => assertClientError(error, "E_MCP_LIFECYCLE")
    );
    assert.equal(client.diagnostics().failureCode, "E_MCP_LIFECYCLE");
    await client.close();
    assertClosed(client);
  });
}

test("notification read after initialized acknowledgement is allowed while its write callback is pending", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const marker = "initialized-read.marker";
  const local = fixture(t, `
    import fs from "node:fs";
    import readline from "node:readline";
    const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    lines.on("line", (line) => {
      const frame = JSON.parse(line);
      if (frame.method === "initialize") {
        send({
          jsonrpc: "2.0",
          id: frame.id,
          result: {
            protocolVersion: frame.params.protocolVersion,
            serverInfo: { name: "fixture-server", version: "1" },
            capabilities: {}
          }
        });
      } else if (frame.method === "notifications/initialized") {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
          params: {}
        }) + "\\n", () => fs.writeFileSync(${JSON.stringify(marker)}, "sent"));
      }
    });
  `);

  const originalEmit = ChildProcess.prototype.emit;
  let releaseWriteCallback;
  let restoreStreamWrite;
  ChildProcess.prototype.emit = function captureSpawn(event, ...args) {
    if (event === "spawn" && this.stdin && !restoreStreamWrite) {
      const stream = this.stdin;
      const originalWrite = stream.write;
      restoreStreamWrite = () => {
        stream.write = originalWrite;
      };
      stream.write = function holdInitializedWriteCallback(chunk, ...writeArgs) {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        if (!text.includes('"method":"notifications/initialized"')) {
          return Reflect.apply(originalWrite, this, [chunk, ...writeArgs]);
        }
        let callbackIndex = -1;
        for (let index = writeArgs.length - 1; index >= 0; index -= 1) {
          if (typeof writeArgs[index] === "function") {
            callbackIndex = index;
            break;
          }
        }
        if (callbackIndex === -1) {
          return Reflect.apply(originalWrite, this, [chunk, ...writeArgs]);
        }
        const callback = writeArgs[callbackIndex];
        const forwarded = [...writeArgs];
        forwarded[callbackIndex] = (error) => {
          let released = false;
          releaseWriteCallback = () => {
            if (released) return;
            released = true;
            callback(error);
          };
        };
        return Reflect.apply(originalWrite, this, [chunk, ...forwarded]);
      };
    }
    return Reflect.apply(originalEmit, this, [event, ...args]);
  };

  let client;
  try {
    client = clientFor(local, { rpcTimeoutMs: 4_000 });
    t.after(() => client.terminate());
    const initializing = initializeClient(client);
    initializing.catch(() => {});
    await waitFor(() => (
      fs.existsSync(path.join(local.root, marker))
      && typeof releaseWriteCallback === "function"
    ));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(client.diagnostics().protocolState, "acknowledging");
    assert.equal(client.diagnostics().failureCode, null);
    releaseWriteCallback();
    await initializing;
    assert.equal(client.diagnostics().protocolState, "initialized");
    await client.close();
    assertClosed(client);
  } finally {
    ChildProcess.prototype.emit = originalEmit;
    releaseWriteCallback?.();
    restoreStreamWrite?.();
  }
});

for (const operationKind of ["request", "notification"]) {
  test(`same-turn ${operationKind}/close rejects boundedly and releases all counters`, { timeout: TEST_TIMEOUT_MS }, async (t) => {
    const local = brokerFixture(t, {
      body: "if (Object.hasOwn(frame, 'id')) { /* intentionally hold */ }"
    });
    const client = clientFor(local, { rpcTimeoutMs: 500, shutdownTimeoutMs: 50 });
    await initializeClient(client);
    const operation = operationKind === "request"
      ? client.request("fixture/held", {})
      : client.notify("notifications/held", {});
    const firstClose = client.close();
    assert.strictEqual(firstClose, client.close());
    await assert.rejects(operation, (error) => assertClientError(error, "E_MCP_CLOSED"));
    await firstClose;
    assertClosed(client);
  });
}

test("fixed in-flight operation capacity rejects deterministically and recovers counters", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const local = brokerFixture(t, {
    body: "if (Object.hasOwn(frame, 'id')) { /* hold every ordinary request */ }"
  });
  const client = clientFor(local, { rpcTimeoutMs: 2_000, shutdownTimeoutMs: 50 });
  await initializeClient(client);
  const limit = client.diagnostics().limits.maxInFlightOperations;
  const requests = Array.from({ length: limit }, (_, index) => {
    const request = client.request("fixture/held", { index });
    request.catch(() => {});
    return request;
  });
  await waitFor(() => client.diagnostics().activeOperations === limit);
  await assert.rejects(
    client.request("fixture/overflow", {}),
    (error) => assertClientError(error, "E_MCP_CAPACITY")
  );
  assert.equal(client.diagnostics().activeOperations, limit);
  const closing = client.close();
  const settled = await Promise.allSettled(requests);
  assert.equal(settled.every((entry) => entry.status === "rejected" && entry.reason.code === "E_MCP_CLOSED"), true);
  await closing;
  assertClosed(client);
});

test("out-of-order responses stay correlated through the serialized writer", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const local = brokerFixture(t, {
    body: `
      globalThis.heldRequests ??= [];
      globalThis.heldRequests.push(frame);
      if (globalThis.heldRequests.length === 2) {
        for (const held of [globalThis.heldRequests[1], globalThis.heldRequests[0]]) {
          send({ jsonrpc: "2.0", id: held.id, result: held.params.label });
        }
      }
    `
  });
  const client = clientFor(local);
  await initializeClient(client);
  assert.deepEqual(await Promise.all([
    client.request("fixture/order", { label: "first" }),
    client.request("fixture/order", { label: "second" })
  ]), ["first", "second"]);
  await client.close();
  assertClosed(client);
});

test("aggregate queued payload capacity is fixed and serialized writes cleanly saturate", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const marker = "paused.marker";
  const local = brokerFixture(t, {
    onInitialized: `
      fs.writeFileSync(${JSON.stringify(marker)}, "yes");
      lines.close();
      process.stdin.pause();
      setInterval(() => {}, 1000);
    `
  });
  fs.writeFileSync(local.script, fs.readFileSync(local.script, "utf8").replace(
    'import readline from "node:readline";',
    'import fs from "node:fs";\nimport readline from "node:readline";'
  ), "utf8");
  const client = clientFor(local, { rpcTimeoutMs: 1_000, shutdownTimeoutMs: 50 });
  await initializeClient(client);
  await waitFor(() => fs.existsSync(path.join(local.root, marker)));
  const payload = { value: "x".repeat(3 * 1024 * 1024) };
  const first = client.notify("notifications/large-one", payload);
  const second = client.notify("notifications/large-two", payload);
  first.catch(() => {});
  second.catch(() => {});
  await waitFor(() => client.diagnostics().queuedPayloadBytes > 5 * 1024 * 1024);
  assert.equal(client.diagnostics().activeWrites, 1);
  assert.equal(client.diagnostics().queuedWrites, 1);
  await assert.rejects(
    client.notify("notifications/large-three", payload),
    (error) => assertClientError(error, "E_MCP_CAPACITY")
  );
  const closing = client.close();
  const settled = await Promise.allSettled([first, second]);
  assert.equal(settled.every((entry) => entry.status === "rejected" && entry.reason.code === "E_MCP_CLOSED"), true);
  await closing;
  assertClosed(client);
});

test("bounded preflight rejects hostile shapes without invoking getters or admitting work", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const local = brokerFixture(t, {
    body: `if (Object.hasOwn(frame, "id")) send({ jsonrpc: "2.0", id: frame.id, result: {} });`
  });
  const client = clientFor(local);
  await initializeClient(client);
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "secret", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must-not-run";
    }
  });
  const cycle = {};
  cycle.self = cycle;
  let deep = {};
  for (let index = 0; index < 40; index += 1) deep = { next: deep };
  const sparse = [];
  sparse.length = 20_000;

  for (const params of [accessor, cycle, deep, sparse, 7, undefined]) {
    await assert.rejects(
      client.request("fixture/preflight", params),
      (error) => assertClientError(error, "E_MCP_ARGUMENT")
    );
  }
  await assert.rejects(
    client.request("fixture/preflight", { huge: "x".repeat(4 * 1024 * 1024 + 1) }),
    (error) => assertClientError(error, "E_MCP_FRAME_TOO_LARGE")
  );
  assert.equal(getterCalls, 0);
  assertNoResources(client);
  await client.close();
  assertClosed(client);
});

test("reserved rpc.* methods and non-object present params are rejected outbound", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const local = brokerFixture(t);
  const client = clientFor(local);
  await initializeClient(client);
  for (const operation of [
    client.request("rpc.internal", {}),
    client.notify("rpc.internal", {}),
    client.request("initialize", {}),
    client.notify("initialize", {}),
    client.request("notifications/initialized", {}),
    client.notify("notifications/initialized", {}),
    client.request("fixture/bad", "text"),
    client.notify("fixture/bad", null),
    client.request("fixture/bad", undefined)
  ]) {
    await assert.rejects(operation, (error) => assertClientError(error, "E_MCP_ARGUMENT"));
  }
  await assert.rejects(
    client.request("x".repeat(1_025), {}),
    (error) => assertClientError(error, "E_MCP_ARGUMENT")
  );
  await assert.rejects(
    client.notify("x".repeat(1_025), {}),
    (error) => assertClientError(error, "E_MCP_ARGUMENT")
  );
  assertNoResources(client);
  await client.close();
  assertClosed(client);
});

test("inbound ping receives prompt same-id empty result through the bounded writer", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const marker = "ping-response.json";
  const local = brokerFixture(t, {
    onInitialized: `send({ jsonrpc: "2.0", id: "server-ping-1", method: "ping", params: {} });`,
    body: `
      if (frame.id === "server-ping-1" && Object.hasOwn(frame, "result")) {
        fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(frame));
      }
    `
  });
  fs.writeFileSync(local.script, fs.readFileSync(local.script, "utf8").replace(
    'import readline from "node:readline";',
    'import fs from "node:fs";\nimport readline from "node:readline";'
  ), "utf8");
  const client = clientFor(local);
  await initializeClient(client);
  await waitFor(() => fs.existsSync(path.join(local.root, marker)));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(local.root, marker), "utf8")), {
    jsonrpc: "2.0",
    id: "server-ping-1",
    result: {}
  });
  assertNoResources(client);
  await client.close();
  assertClosed(client);
});

for (const [label, frameExpression, expectedCode] of [
  [
    "reserved notification method",
    `({ jsonrpc: "2.0", method: "rpc.internal", params: {} })`,
    "E_MCP_INVALID_FRAME"
  ],
  [
    "primitive notification params",
    `({ jsonrpc: "2.0", method: "notifications/test", params: 7 })`,
    "E_MCP_INVALID_FRAME"
  ],
  [
    "primitive ping params",
    `({ jsonrpc: "2.0", id: "ping-bad", method: "ping", params: "bad" })`,
    "E_MCP_INVALID_FRAME"
  ],
  [
    "unsupported server request",
    `({ jsonrpc: "2.0", id: "server-1", method: "sampling/createMessage", params: {} })`,
    "E_MCP_SERVER_REQUEST"
  ]
]) {
  test(`inbound ${label} is fatal and structural`, { timeout: TEST_TIMEOUT_MS }, async (t) => {
    const local = brokerFixture(t, {
      onInitialized: `send(${frameExpression});`,
      body: "setInterval(() => {}, 1000);"
    });
    const client = clientFor(local, { shutdownTimeoutMs: 50 });
    await initializeClient(client);
    await waitFor(() => client.diagnostics().failureCode !== null);
    assert.equal(client.diagnostics().failureCode, expectedCode);
    await client.close();
    assertClosed(client);
  });
}

for (const [label, responseSource] of [
  [
    "over-depth JSON",
    `
      const nested = "[".repeat(33) + "0" + "]".repeat(33);
      process.stdout.write(
        '{"jsonrpc":"2.0","id":' + frame.id + ',"result":' + nested + '}\\n'
      );
    `
  ],
  [
    "over-node JSON",
    `
      const values = "0,".repeat(16_384) + "0";
      process.stdout.write(
        '{"jsonrpc":"2.0","id":' + frame.id + ',"result":[' + values + ']}\\n'
      );
    `
  ]
]) {
  test(`inbound lexical preflight rejects ${label} before parsing`, { timeout: TEST_TIMEOUT_MS }, async (t) => {
    const local = brokerFixture(t, {
      body: `${responseSource} setInterval(() => {}, 1000);`
    });
    const client = clientFor(local, { shutdownTimeoutMs: 50 });
    await initializeClient(client);
    await assert.rejects(
      client.request("fixture/lexical-limit", {}),
      (error) => assertClientError(error, "E_MCP_INVALID_FRAME")
    );
    assert.equal(client.diagnostics().failureCode, "E_MCP_INVALID_FRAME");
    await client.close();
    assertClosed(client);
  });
}

test("inbound lexical preflight ignores brackets and escaped quotes inside strings", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const stringValue = `${"{}[]".repeat(256)}\\"quoted\\"\\\\tail`;
  const local = brokerFixture(t, {
    body: `send({ jsonrpc: "2.0", id: frame.id, result: ${JSON.stringify(stringValue)} });`
  });
  const client = clientFor(local);
  await initializeClient(client);
  assert.equal(await client.request("fixture/string-braces", {}), stringValue);
  await client.close();
  assertClosed(client);
});

for (const [label, body, expectedCode] of [
  [
    "malformed JSON",
    `process.stdout.write("{not-json}\\n"); setInterval(() => {}, 1000);`,
    "E_MCP_MALFORMED_JSON"
  ],
  [
    "invalid UTF-8",
    `process.stdout.write(Buffer.from([0xff, 0x0a])); setInterval(() => {}, 1000);`,
    "E_MCP_INVALID_FRAME"
  ],
  [
    "oversized unterminated frame",
    `process.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1, 0x61)); setInterval(() => {}, 1000);`,
    "E_MCP_FRAME_TOO_LARGE"
  ],
  [
    "unknown response identifier",
    `send({ jsonrpc: "2.0", id: 999, result: {} }); setInterval(() => {}, 1000);`,
    "E_MCP_UNKNOWN_RESPONSE"
  ]
]) {
  test(`${label} fails the connection structurally`, { timeout: TEST_TIMEOUT_MS }, async (t) => {
    const local = brokerFixture(t, { body });
    const client = clientFor(local, { shutdownTimeoutMs: 50 });
    await initializeClient(client);
    await assert.rejects(
      client.request("fixture/frame-fault", {}),
      (error) => assertClientError(error, expectedCode)
    );
    await client.close();
    assert.equal(client.diagnostics().failureCode, expectedCode);
    assertClosed(client);
  });
}

test("duplicate response identifier rejects every still-pending operation", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const local = brokerFixture(t, {
    body: `
      if (globalThis.firstResponseId === undefined) {
        globalThis.firstResponseId = frame.id;
        send({ jsonrpc: "2.0", id: frame.id, result: "first" });
      } else {
        send({ jsonrpc: "2.0", id: globalThis.firstResponseId, result: "duplicate" });
      }
    `
  });
  const client = clientFor(local, { shutdownTimeoutMs: 50 });
  await initializeClient(client);
  assert.equal(await client.request("fixture/first", {}), "first");
  await assert.rejects(
    client.request("fixture/pending", {}),
    (error) => assertClientError(error, "E_MCP_DUPLICATE_RESPONSE")
  );
  await client.close();
  assert.equal(client.diagnostics().failureCode, "E_MCP_DUPLICATE_RESPONSE");
  assertClosed(client);
});

for (const [label, body, expectedCode] of [
  [
    "premature stdout end",
    `process.stdout.end(); setInterval(() => {}, 1000);`,
    "E_MCP_STDOUT_END"
  ],
  [
    "premature child exit while a descendant holds stdout",
    `
      const { spawn } = await import("node:child_process");
      spawn(process.execPath, ["-e", "setTimeout(() => {}, 150)"], {
        stdio: ["ignore", process.stdout, "ignore"]
      });
      process.exit(0);
    `,
    "E_MCP_PROCESS_EXIT"
  ],
  [
    "malformed frame before stdout end and exit",
    `
      process.stdout.write("{malformed}\\n", () => {
        process.stdout.end(() => process.exit(0));
      });
    `,
    "E_MCP_MALFORMED_JSON"
  ]
]) {
  test(`${label} preserves the first structural failure`, { timeout: TEST_TIMEOUT_MS }, async (t) => {
    const local = brokerFixture(t, { body });
    const client = clientFor(local, { shutdownTimeoutMs: 200 });
    await initializeClient(client);
    await assert.rejects(
      client.request("fixture/lifecycle-fault", {}),
      (error) => assertClientError(error, expectedCode)
    );
    await client.close();
    assert.equal(client.diagnostics().failureCode, expectedCode);
    assertClosed(client);
  });
}

test("request timeout is connection-fatal and rejects every correlated operation", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const local = brokerFixture(t, {
    body: "if (Object.hasOwn(frame, 'id')) { /* hold */ }"
  });
  const client = clientFor(local, { rpcTimeoutMs: 200, shutdownTimeoutMs: 50 });
  await initializeClient(client);
  const first = client.request("fixture/timeout-one", {});
  const second = client.request("fixture/timeout-two", {});
  first.catch(() => {});
  second.catch(() => {});
  const settled = await Promise.allSettled([first, second]);
  assert.equal(settled.every((entry) => entry.status === "rejected" && entry.reason.code === "E_MCP_TIMEOUT"), true);
  await client.close();
  assert.equal(client.diagnostics().failureCode, "E_MCP_TIMEOUT");
  assertClosed(client);
});

test("blocked notification write times out fatally with one bounded operation", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const marker = "notify-paused.marker";
  const local = brokerFixture(t, {
    onInitialized: `
      fs.writeFileSync(${JSON.stringify(marker)}, "yes");
      lines.close();
      process.stdin.pause();
      setInterval(() => {}, 1000);
    `
  });
  fs.writeFileSync(local.script, fs.readFileSync(local.script, "utf8").replace(
    'import readline from "node:readline";',
    'import fs from "node:fs";\nimport readline from "node:readline";'
  ), "utf8");
  const client = clientFor(local, { rpcTimeoutMs: 200, shutdownTimeoutMs: 50 });
  await initializeClient(client);
  await waitFor(() => fs.existsSync(path.join(local.root, marker)));
  const notification = client.notify("notifications/blocked", {
    payload: "x".repeat(3 * 1024 * 1024)
  });
  await waitFor(() => client.diagnostics().activeOperations === 1);
  assert.equal(client.diagnostics().activeTimers, 1);
  await assert.rejects(
    notification,
    (error) => assertClientError(error, "E_MCP_TIMEOUT")
  );
  await client.close();
  assert.equal(client.diagnostics().failureCode, "E_MCP_TIMEOUT");
  assertClosed(client);
});

test("strict JSON-RPC errors redact peer text and malformed error shape is fatal", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const secret = "secret-remote-error-text";
  const local = brokerFixture(t, {
    body: `
      if (frame.method === "fixture/valid-error") {
        process.stderr.write(${JSON.stringify(secret)});
        send({ jsonrpc: "2.0", id: frame.id, error: { code: -32001, message: ${JSON.stringify(secret)} } });
      } else {
        send({ jsonrpc: "2.0", id: frame.id, error: { code: "-32001", message: "bad" } });
      }
    `
  });
  const client = clientFor(local, { shutdownTimeoutMs: 50 });
  await initializeClient(client);
  let captured;
  await assert.rejects(client.request("fixture/valid-error", {}), (error) => {
    captured = error;
    return assertClientError(error, "E_MCP_REMOTE_ERROR");
  });
  assert.equal(JSON.stringify(captured).includes(secret), false);
  assert.equal(client.diagnostics().stderr.retainedBytes, 0);
  await assert.rejects(
    client.request("fixture/malformed-error", {}),
    (error) => assertClientError(error, "E_MCP_INVALID_FRAME")
  );
  await client.close();
  assertClosed(client);
});

for (const [label, responseExpression] of [
  [
    "missing message",
    `({ jsonrpc: "2.0", id: frame.id, error: { code: -32001 } })`
  ],
  [
    "non-string message",
    `({ jsonrpc: "2.0", id: frame.id, error: { code: -32001, message: 7 } })`
  ],
  [
    "oversized message",
    `({ jsonrpc: "2.0", id: frame.id, error: { code: -32001, message: "x".repeat(64 * 1024 + 1) } })`
  ],
  [
    "extra error field",
    `({ jsonrpc: "2.0", id: frame.id, error: { code: -32001, message: "bad", extra: true } })`
  ],
  [
    "result and error together",
    `({ jsonrpc: "2.0", id: frame.id, result: null, error: { code: -32001, message: "bad" } })`
  ]
]) {
  test(`strict error parser rejects ${label}`, { timeout: TEST_TIMEOUT_MS }, async (t) => {
    const local = brokerFixture(t, {
      body: `send(${responseExpression}); setInterval(() => {}, 1000);`
    });
    const client = clientFor(local, { shutdownTimeoutMs: 50 });
    await initializeClient(client);
    await assert.rejects(
      client.request("fixture/error-shape", {}),
      (error) => assertClientError(error, "E_MCP_INVALID_FRAME")
    );
    await client.close();
    assertClosed(client);
  });
}

test("fragmented inbound response reuses one fixed-capacity accumulator", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const fragmented = `fragment-${"{}[]".repeat(512)}-\\"-\\\\-tail`;
  const local = brokerFixture(t, {
    body: `
      const response = Buffer.from(JSON.stringify({
        jsonrpc: "2.0",
        id: frame.id,
        result: ${JSON.stringify(fragmented)}
      }) + "\\n");
      for (let offset = 0; offset < response.length; offset += 16) {
        process.stdout.write(response.subarray(offset, offset + 16));
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    `
  });
  const client = clientFor(local, { rpcTimeoutMs: 4_000 });
  await initializeClient(client);
  assert.equal(await client.request("fixture/fragmented", {}), fragmented);
  const diagnostics = client.diagnostics();
  assert.equal(diagnostics.stdout.accumulatorAllocations, 1);
  assert.equal(
    diagnostics.stdout.accumulatorCapacityBytes,
    diagnostics.limits.maxFrameBytes
  );
  assert.equal(diagnostics.stdout.bufferedBytes, 0);
  assert.ok(diagnostics.stdout.peakBufferedBytes >= Buffer.byteLength(fragmented));
  assert.ok(diagnostics.stdout.dataEvents >= 16);
  assertNoResources(client);
  await client.close();
  assert.equal(client.diagnostics().stdout.accumulatorCapacityBytes, 0);
  assertClosed(client);
});

test("split UTF-8, CRLF, and an exact 4 MiB response preserve bounded framing", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const local = brokerFixture(t, {
    body: `
      if (frame.method === "fixture/split") {
        const response = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: "€" }), "utf8");
        const euro = Buffer.from("€", "utf8");
        const split = response.indexOf(euro);
        process.stdout.write(response.subarray(0, split + 1));
        await new Promise((resolve) => setTimeout(resolve, 10));
        process.stdout.write(response.subarray(split + 1, split + 2));
        await new Promise((resolve) => setTimeout(resolve, 10));
        process.stdout.write(response.subarray(split + 2));
        process.stdout.write("\\r\\n");
      } else {
        const prefix = Buffer.from('{"jsonrpc":"2.0","id":' + frame.id + ',"result":"');
        const suffix = Buffer.from('"}');
        const fill = Buffer.alloc(4 * 1024 * 1024 - prefix.length - suffix.length, 0x78);
        process.stdout.write(Buffer.concat([prefix, fill, suffix]));
        process.stdout.write("\\n");
      }
    `
  });
  const client = clientFor(local, { rpcTimeoutMs: 4_000, shutdownTimeoutMs: 200 });
  await initializeClient(client);
  assert.equal(await client.request("fixture/split", {}), "€");
  const exact = await client.request("fixture/exact", {});
  const framingBytes = Buffer.byteLength('{"jsonrpc":"2.0","id":3,"result":""}');
  assert.equal(Buffer.byteLength(exact), 4 * 1024 * 1024 - framingBytes);
  await client.close();
  assertClosed(client);
});

test("terminal shutdown failure releases transport and permits a fresh exact-child retry", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const local = brokerFixture(t, {
    onInitialized: "setInterval(() => {}, 1000);"
  });
  const client = clientFor(local, { shutdownTimeoutMs: 30 });
  await initializeClient(client);
  const originalKill = ChildProcess.prototype.kill;
  let firstClose;
  try {
    ChildProcess.prototype.kill = function blockedKill() {
      return false;
    };
    firstClose = client.close();
    assert.strictEqual(firstClose, client.close());
    await assert.rejects(firstClose, (error) => assertClientError(error, "E_MCP_TERMINATION"));
  } finally {
    ChildProcess.prototype.kill = originalKill;
  }
  const failed = client.diagnostics();
  assert.equal(failed.state, "shutdown_failed");
  assert.equal(failed.shutdownRetryable, true);
  assert.equal(failed.handlesReleased, true);
  assert.equal(failed.listenerCount, 0);
  assertNoResources(client);

  const retry = client.terminate();
  assert.notStrictEqual(retry, firstClose);
  await retry;
  assertClosed(client);
});

test("outer client exits while the deliberately un-signaled descendant survives", { timeout: TEST_TIMEOUT_MS }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mcp-descendant-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = path.join(root, "server.mjs");
  const outer = path.join(root, "outer.mjs");
  const pidFile = path.join(root, "descendant.pid");
  fs.writeFileSync(server, `
    import { spawn } from "node:child_process";
    import fs from "node:fs";
    process.stdin.once("data", () => {
      const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: ["ignore", process.stdout, "ignore"]
      });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));
      process.exit(0);
    });
  `, "utf8");
  fs.writeFileSync(outer, `
    import { spawnMcpStdioClient } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/mcp-stdio-client.mjs")).href)};
    const client = spawnMcpStdioClient({
      executable: process.execPath,
      argv: [${JSON.stringify(server)}],
      cwd: ${JSON.stringify(root)},
      env: { ...process.env },
      rpcTimeoutMs: 200,
      shutdownTimeoutMs: 50
    });
    try {
      await client.initialize(${JSON.stringify(INITIALIZE_OPTIONS)}, () => true);
    } catch (error) {
      if (error?.code !== "E_MCP_PROCESS_EXIT" && error?.code !== "E_MCP_STDOUT_END") throw error;
    }
    await client.close();
    process.stdout.write(JSON.stringify(client.diagnostics()) + "\\n");
  `, "utf8");

  let executed;
  let descendantPid;
  try {
    executed = spawnSync(process.execPath, [outer], {
      cwd: root,
      env: { ...process.env },
      encoding: "utf8",
      timeout: 1_500,
      maxBuffer: 1024 * 1024,
      shell: false
    });
    descendantPid = Number.parseInt(fs.readFileSync(pidFile, "utf8"), 10);
    assert.doesNotThrow(() => process.kill(descendantPid, 0));
  } finally {
    if (Number.isInteger(descendantPid) && descendantPid > 0) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // The separately owned fixture descendant may already have exited.
      }
    }
  }
  assert.equal(executed.error, undefined, executed.error?.message);
  assert.equal(executed.status, 0, executed.stderr);
  const diagnostics = JSON.parse(executed.stdout.trim());
  assert.equal(diagnostics.handlesReleased, true);
  assert.equal(diagnostics.listenerCount, 0);
  assert.equal(diagnostics.activeTimers, 0);
});

test("reflection exposes no executable, argv, env, stderr, or partial frame state", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const secret = "reflection-secret-value";
  const local = fixture(t, `
    import fs from "node:fs";
    process.stderr.write(${JSON.stringify(secret)});
    process.stdout.write(${JSON.stringify(`{"partial":"${secret}`)});
    fs.writeFileSync("started", "yes");
    setInterval(() => {}, 1000);
  `, "grok-mcp-reflection-secret-");
  const client = spawnMcpStdioClient({
    executable: process.execPath,
    argv: [local.script, secret],
    cwd: local.root,
    env: { ...process.env, REFLECTION_SECRET: secret },
    rpcTimeoutMs: 100,
    shutdownTimeoutMs: 50
  });
  await waitFor(() => fs.existsSync(path.join(local.root, "started")));
  assert.deepEqual(Reflect.ownKeys(client), []);
  assert.equal(Object.isExtensible(client), false);
  assert.equal(publicSurface(client).includes(secret), false);
  await client.terminate();
  assert.equal(publicSurface(client).includes(secret), false);
  assertClosed(client);
});

test("invalid construction and spawn errors remain structural and path-free", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  assert.throws(
    () => spawnMcpStdioClient({ executable: process.execPath }),
    (error) => assertClientError(error, "E_MCP_ARGUMENT")
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mcp-spawn-secret-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const secretPath = path.join(root, "secret-missing-executable");
  const client = spawnMcpStdioClient({
    executable: secretPath,
    argv: [],
    cwd: root,
    env: { SECRET: "secret-env" },
    rpcTimeoutMs: 100,
    shutdownTimeoutMs: 50
  });
  let captured;
  const initializing = client.initialize(INITIALIZE_OPTIONS, () => true);
  assert.equal(client.diagnostics().protocolState, "initializing");
  assert.equal(client.diagnostics().readyWaiters, 1);
  await assert.rejects(initializing, (error) => {
    captured = error;
    return assertClientError(error, "E_MCP_SPAWN");
  });
  assert.equal(client.diagnostics().protocolState, "failed");
  assert.equal(client.diagnostics().readyWaiters, 0);
  assertNoResources(client);
  await client.close();
  assert.equal(JSON.stringify(captured).includes(secretPath), false);
  assert.equal(JSON.stringify(captured).includes("secret-env"), false);
  assertClosed(client);
});

test("constructor admission bounds argv, env, paths, and accessors before cloning", () => {
  const base = {
    executable: process.execPath,
    argv: [],
    cwd: process.cwd(),
    env: { SAFE: "yes" }
  };
  assert.throws(
    () => spawnMcpStdioClient({ ...base, argv: Array.from({ length: 257 }, () => "x") }),
    (error) => assertClientError(error, "E_MCP_ARGUMENT")
  );
  assert.throws(
    () => spawnMcpStdioClient({ ...base, executable: "x".repeat(16 * 1024 + 1) }),
    (error) => assertClientError(error, "E_MCP_ARGUMENT")
  );
  assert.throws(
    () => spawnMcpStdioClient({ ...base, env: Object.create({ inherited: "unsafe" }) }),
    (error) => assertClientError(error, "E_MCP_ARGUMENT")
  );
  assert.throws(
    () => spawnMcpStdioClient({
      ...base,
      env: Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`KEY_${index}`, "x"]))
    }),
    (error) => assertClientError(error, "E_MCP_ARGUMENT")
  );
  assert.throws(
    () => spawnMcpStdioClient({ ...base, env: { HUGE: "x".repeat(64 * 1024 + 1) } }),
    (error) => assertClientError(error, "E_MCP_ARGUMENT")
  );

  let getterCalls = 0;
  const accessorOptions = {
    executable: process.execPath,
    argv: [],
    cwd: process.cwd()
  };
  Object.defineProperty(accessorOptions, "env", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return { UNSAFE: "value" };
    }
  });
  assert.throws(
    () => spawnMcpStdioClient(accessorOptions),
    (error) => assertClientError(error, "E_MCP_ARGUMENT")
  );
  assert.equal(getterCalls, 0);
});
