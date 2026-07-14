import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { readBoundedStdin } from "../plugins/grok/scripts/lib/stdin.mjs";

test("bounded stdin waits for delayed split input and EOF", async () => {
  const stream = new PassThrough();
  const input = readBoundedStdin({ stream, limitBytes: 32, label: "Fixture", timeoutMs: 1000 });
  setTimeout(() => stream.write("delayed "), 20);
  setTimeout(() => stream.end("input"), 40);
  assert.equal(await input, "delayed input");
});

test("bounded stdin rejects oversized input with a stable usage error", async () => {
  const stream = new PassThrough();
  const input = readBoundedStdin({ stream, limitBytes: 4, label: "Fixture", timeoutMs: 1000 });
  stream.end("12345");
  await assert.rejects(input, (error) => error?.code === "E_USAGE" && /input limit/.test(error.message));
});

test("bounded stdin turns missing EOF into a stable timeout error", async () => {
  const stream = new PassThrough();
  const input = readBoundedStdin({ stream, label: "Fixture", timeoutMs: 25 });
  await assert.rejects(input, (error) => error?.code === "E_INPUT_TIMEOUT");
  stream.destroy();
});

test("bounded stdin disables PTY echo and accepts EOT as a private frame terminator", async () => {
  const stream = new PassThrough();
  const rawModes = [];
  Object.defineProperty(stream, "isTTY", { value: true });
  stream.setRawMode = (enabled) => { rawModes.push(enabled); };
  let ready = 0;
  const input = readBoundedStdin({
    stream,
    label: "Fixture",
    timeoutMs: 1000,
    onReady: () => { ready += 1; }
  });
  stream.write(Buffer.from("{\"ok\":true}\n"));
  stream.write(Buffer.from([0x04]));
  assert.equal(await input, "{\"ok\":true}\n");
  assert.equal(ready, 1);
  assert.deepEqual(rawModes, [true, false]);
});

test("bounded stdin treats raw PTY Ctrl-C as pre-dispatch cancellation", async () => {
  const stream = new PassThrough();
  const rawModes = [];
  Object.defineProperty(stream, "isTTY", { value: true });
  stream.setRawMode = (enabled) => { rawModes.push(enabled); };
  const input = readBoundedStdin({ stream, label: "Fixture", timeoutMs: 1000 });
  stream.write(Buffer.from([0x03]));
  await assert.rejects(input, (error) => error?.code === "E_CANCELLED");
  assert.deepEqual(rawModes, [true, false]);
});

test("bounded stdin maps stream errors to stable E_INPUT_READ", async () => {
  const stream = new PassThrough();
  const input = readBoundedStdin({ stream, label: "Fixture", timeoutMs: 1000 });
  const failure = Object.assign(new Error("fixture read failed"), { code: "EIO" });
  stream.destroy(failure);
  await assert.rejects(
    input,
    (error) => error?.code === "E_INPUT_READ" && error.details?.systemCode === "EIO"
  );
});
