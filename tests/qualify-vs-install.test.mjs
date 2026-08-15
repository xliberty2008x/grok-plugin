import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runLocalCodexInstall } from "../scripts/lib/local-codex-install.mjs";
import {
  acquireQualifyLock,
  qualificationLockPath,
  releaseQualifyLock,
  runLocalQualify
} from "../scripts/lib/local-qualify.mjs";
import {
  assertReceiptMatchesIdentity,
  buildQualificationReceipt,
  collectInstallIdentity,
  readQualificationReceipt,
  writeQualificationReceiptAtomic
} from "../scripts/lib/qualification-receipt.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "grok-plugin-test-"));
}

function fakeHost() {
  return new EventEmitter();
}

function mockSpawn({ status = 0, stdout = "ok\n", hangMs = 0 } = {}) {
  return (command, args) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.command = command;
    child.args = args;
    if (hangMs > 0) {
      return child;
    }
    queueMicrotask(() => {
      child.stdout.end(stdout);
      child.stderr.end("");
      child.emit("close", status, null);
    });
    return child;
  };
}

function fakeCodexRun({ marketplaceRoot, installedPath, version }) {
  return (command, args, extra) => {
    assert.equal(extra.timeout === 45 * 60_000, false, "install must not use the 45-minute suite timeout");
    assert.match(command, /codex/);
    assert.equal(args.includes("check"), false);
    assert.equal(args.includes("test:deterministic"), false);
    const joined = args.join(" ");
    if (joined.includes("marketplace list")) {
      return {
        status: 0,
        stdout: JSON.stringify({
          marketplaces: [{ name: "grok-companion", root: marketplaceRoot }]
        }),
        stderr: "",
        error: null
      };
    }
    if (joined.includes("plugin add")) {
      return {
        status: 0,
        stdout: JSON.stringify({ installedPath }),
        stderr: "",
        error: null
      };
    }
    if (joined.includes("plugin list")) {
      return {
        status: 0,
        stdout: JSON.stringify({
          installed: [{
            pluginId: "grok@grok-companion",
            installed: true,
            enabled: true,
            version
          }]
        }),
        stderr: "",
        error: null
      };
    }
    throw new Error(`unexpected command ${command} ${joined}`);
  };
}

test("missing receipt fails quickly and never runs npm check", () => {
  const receiptPath = path.join(tempDir(), "missing.json");
  const spawned = [];
  assert.throws(
    () => runLocalCodexInstall({
      root: ROOT,
      receiptPath,
      allowWindows: true,
      write() {},
      run(command, args, extra) {
        spawned.push([command, ...args].join(" "));
        return { status: 0, stdout: "{}", stderr: "", error: null, extra };
      }
    }),
    /No qualification receipt/
  );
  assert.deepEqual(spawned, []);
});

test("mismatched receipt is rejected without installing", () => {
  const identity = collectInstallIdentity(ROOT);
  const receipt = buildQualificationReceipt({
    ...identity,
    sourceDigest: "ab".repeat(32)
  });
  const receiptPath = path.join(tempDir(), "receipt.json");
  writeQualificationReceiptAtomic(receiptPath, receipt);
  const spawned = [];
  assert.throws(
    () => runLocalCodexInstall({
      root: ROOT,
      receiptPath,
      allowWindows: true,
      write() {},
      run(command, args) {
        spawned.push([command, ...args].join(" "));
        return { status: 0, stdout: "{}", stderr: "", error: null };
      }
    }),
    /does not match the current plugin inventory/
  );
  assert.deepEqual(spawned, []);
});

test("matching receipt installs without running the repository suite", () => {
  const identity = collectInstallIdentity(ROOT);
  const receipt = buildQualificationReceipt(identity);
  const receiptPath = path.join(tempDir(), "receipt.json");
  writeQualificationReceiptAtomic(receiptPath, receipt);
  const workspace = tempDir();
  const installedPath = path.join(
    workspace,
    "plugins",
    "cache",
    "grok-companion",
    "grok",
    identity.version
  );
  fs.mkdirSync(installedPath, { recursive: true });
  const result = runLocalCodexInstall({
    root: ROOT,
    receiptPath,
    allowWindows: true,
    write() {},
    codexBin: "codex",
    codexHome: workspace,
    run: fakeCodexRun({
      marketplaceRoot: ROOT,
      installedPath,
      version: identity.version
    }),
    createInstalledInventory() {
      return identity.sourceEntries;
    }
  });
  assert.equal(result.receipt.source_digest, identity.sourceDigest);
  assert.equal(result.spawned.some((entry) => entry.includes("run check")), false);
  assert.equal(result.spawned.some((entry) => entry.includes("test:deterministic")), false);
  assert.ok(result.spawned.some((entry) => entry.includes("plugin add")));
});

test("qualify writes a receipt bound to the current inventory after a streamed check", async () => {
  const workspace = tempDir();
  const receiptPath = path.join(workspace, "receipt.json");
  const seen = [];
  const result = await runLocalQualify({
    root: ROOT,
    lockRoot: workspace,
    receiptPath,
    timeoutMs: 5_000,
    npmBin: "npm",
    checkArgs: ["run", "check"],
    spawn: mockSpawn({ stdout: "validation ok\n" }),
    process: fakeHost(),
    write(text) {
      seen.push(text);
    }
  });
  const onDisk = readQualificationReceipt(receiptPath);
  assertReceiptMatchesIdentity(onDisk, collectInstallIdentity(ROOT));
  assert.equal(result.receipt.source_digest, onDisk.source_digest);
  assert.match(seen.join(""), /phase: repository-check/);
  assert.match(seen.join(""), /validation ok/);
});

test("qualify timeout kills the child and writes no receipt", async () => {
  const workspace = tempDir();
  const receiptPath = path.join(workspace, "receipt.json");
  const child = mockSpawn({ hangMs: 60_000 })("node", ["-e", "1"]);
  const killed = [];
  await assert.rejects(
    () => runLocalQualify({
      root: ROOT,
      lockRoot: workspace,
      receiptPath,
      timeoutMs: 20,
      spawn() {
        return child;
      },
      process: fakeHost(),
      kill(pid, signal) {
        killed.push({ pid, signal });
        if (signal === "SIGTERM") {
          queueMicrotask(() => child.emit("close", null, "SIGTERM"));
        }
      },
      write() {}
    }),
    /timed out during phase repository-check/
  );
  assert.equal(fs.existsSync(receiptPath), false);
  assert.ok(killed.some((entry) => entry.signal === "SIGTERM"));
});

test("timeout never writes a receipt even if the child later exits 0", async () => {
  const workspace = tempDir();
  const receiptPath = path.join(workspace, "receipt.json");
  const child = mockSpawn({ hangMs: 60_000 })("node", ["-e", "1"]);
  await assert.rejects(
    () => runLocalQualify({
      root: ROOT,
      lockRoot: workspace,
      receiptPath,
      timeoutMs: 20,
      killGraceMs: 20,
      spawn() {
        return child;
      },
      process: fakeHost(),
      kill(_pid, signal) {
        if (signal === "SIGTERM") {
          queueMicrotask(() => child.emit("close", 0, null));
        }
      },
      write() {}
    }),
    /timed out during phase repository-check/
  );
  assert.equal(fs.existsSync(receiptPath), false);
});

test("package or marketplace drift during qualify writes no receipt", async () => {
  const workspace = tempDir();
  const receiptPath = path.join(workspace, "receipt.json");
  const first = collectInstallIdentity(ROOT);
  let calls = 0;
  await assert.rejects(
    () => runLocalQualify({
      root: ROOT,
      lockRoot: workspace,
      receiptPath,
      timeoutMs: 5_000,
      spawn: mockSpawn({ stdout: "ok\n" }),
      process: fakeHost(),
      write() {},
      collectIdentity() {
        calls += 1;
        if (calls === 1) return first;
        return { ...first, packageDigest: "cd".repeat(32) };
      }
    }),
    /package metadata, or marketplace digest changed/
  );
  assert.equal(fs.existsSync(receiptPath), false);
});

test("a second qualify fails while the exclusive lock is held", async () => {
  const workspace = tempDir();
  const lockPath = acquireQualifyLock(workspace);
  try {
    await assert.rejects(
      () => runLocalQualify({
        root: ROOT,
        lockRoot: workspace,
        receiptPath: path.join(workspace, "receipt.json"),
        spawn: mockSpawn(),
        process: fakeHost(),
        write() {}
      }),
      /already running/
    );
  } finally {
    releaseQualifyLock(lockPath);
  }
});

test("successful qualify does not wait for the leftover timeout", async () => {
  const workspace = tempDir();
  const receiptPath = path.join(workspace, "receipt.json");
  const started = Date.now();
  await runLocalQualify({
    root: ROOT,
    lockRoot: workspace,
    receiptPath,
    timeoutMs: 30_000,
    spawn: mockSpawn({ stdout: "ok\n" }),
    process: fakeHost(),
    write() {}
  });
  assert.ok(Date.now() - started < 5_000);
  assert.equal(fs.existsSync(receiptPath), true);
});

test("EPERM on a lock owner is treated as already running", () => {
  const workspace = tempDir();
  const lockPath = qualificationLockPath(workspace);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, "4242\n");
  assert.throws(
    () => acquireQualifyLock(workspace, {
      kill() {
        const error = new Error("denied");
        error.code = "EPERM";
        throw error;
      }
    }),
    /already running/
  );
});

test("a live child pid in a stale parent lock blocks retry", () => {
  const workspace = tempDir();
  const lockPath = qualificationLockPath(workspace);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `999999999\n${process.pid}\n`);
  assert.throws(
    () => acquireQualifyLock(workspace),
    /already running/
  );
});

test("releaseQualifyLock does not delete a lock owned by another pid", () => {
  const workspace = tempDir();
  const lockPath = qualificationLockPath(workspace);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, "999999999\n");
  releaseQualifyLock(lockPath);
  assert.equal(fs.existsSync(lockPath), true);
});

test("SIGINT during qualify writes no receipt even if the child exits 0", async () => {
  const workspace = tempDir();
  const receiptPath = path.join(workspace, "receipt.json");
  const host = fakeHost();
  const child = mockSpawn({ hangMs: 60_000 })("node", ["-e", "1"]);
  const pending = runLocalQualify({
    root: ROOT,
    lockRoot: workspace,
    receiptPath,
    timeoutMs: 2_000,
    process: host,
    spawn() {
      return child;
    },
    kill(_pid, signal) {
      if (signal === "SIGINT" || signal === "SIGTERM" || signal === "SIGKILL") {
        queueMicrotask(() => child.emit("close", signal === "SIGINT" ? 0 : 1, signal));
      }
    },
    write() {}
  });
  setImmediate(() => host.emit("SIGINT"));
  await assert.rejects(() => pending, /interrupted/);
  assert.equal(fs.existsSync(receiptPath), false);
});

test("qualify failure keeps only a bounded log tail", async () => {
  const workspace = tempDir();
  const receiptPath = path.join(workspace, "receipt.json");
  const huge = `${"x".repeat(80 * 1024)}\n`;
  await assert.rejects(
    () => runLocalQualify({
      root: ROOT,
      lockRoot: workspace,
      receiptPath,
      timeoutMs: 5_000,
      spawn: mockSpawn({ status: 1, stdout: huge }),
      process: fakeHost(),
      write() {}
    }),
    (error) => {
      assert.match(error.message, /exited with status 1/);
      assert.ok(error.message.length < 70 * 1024);
      return true;
    }
  );
  assert.equal(fs.existsSync(receiptPath), false);
});
