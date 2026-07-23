import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalPath,
  createPluginInventory,
  describeInventoryDifference,
  digestInventory,
  digestRegularFile,
  isPathInside
} from "../scripts/lib/plugin-inventory.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-plugin-inventory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, relative, contents, mode = 0o644) {
  const target = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, { mode });
  fs.chmodSync(target, mode);
  return target;
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function entry(relativePath, contents, mode = 0o644) {
  return {
    path: relativePath,
    mode,
    size: Buffer.byteLength(contents),
    sha256: sha256(contents)
  };
}

test("canonical and containment helpers handle equality, children, traversal, and sibling prefixes", (t) => {
  const root = fixture(t);
  const child = path.join(root, "child");
  const sibling = `${root}-sibling`;
  fs.mkdirSync(child);
  fs.mkdirSync(sibling);
  t.after(() => fs.rmSync(sibling, { recursive: true, force: true }));

  assert.equal(canonicalPath(root, "Fixture"), fs.realpathSync(root));
  assert.equal(isPathInside(root, root), true);
  assert.equal(isPathInside(root, child), true);
  assert.equal(isPathInside(root, path.join(root, "..safe")), true);
  assert.equal(isPathInside(root, path.join(child, "..", "child")), true);
  assert.equal(isPathInside(root, sibling), false);
  assert.equal(isPathInside(child, root), false);
  assert.throws(() => canonicalPath(path.join(root, "missing"), "Missing"), /Missing does not exist or cannot be resolved/);
  assert.throws(() => canonicalPath("", "Fixture"), /non-empty path string/);
  assert.throws(() => isPathInside(root, `${root}\0escape`), /without NUL bytes/);
});

test("inventory output and digest are deterministic POSIX-relative values", (t) => {
  const left = fixture(t);
  const right = fixture(t);
  const files = [
    ["z-last.txt", "last", 0o640],
    ["a/deep.txt", "deep", 0o755],
    ["a.txt", "top", 0o644],
    ["middle/child.txt", "child", 0o600],
    ["Z-case.txt", "binary-order", 0o644]
  ];
  for (const [relative, contents, mode] of [...files].reverse()) write(left, relative, contents, mode);
  for (const [relative, contents, mode] of files) write(right, relative, contents, mode);

  const leftInventory = createPluginInventory(left);
  const rightInventory = createPluginInventory(right);
  assert.deepEqual(leftInventory.map((item) => item.path), [
    "Z-case.txt",
    "a/deep.txt",
    "a.txt",
    "middle/child.txt",
    "z-last.txt"
  ]);
  assert.deepEqual(leftInventory, rightInventory);
  assert.equal(digestInventory(leftInventory), digestInventory([...rightInventory].reverse()));
  assert.deepEqual(describeInventoryDifference(leftInventory, rightInventory), []);
  assert.equal(Object.isFrozen(leftInventory), true);
  assert.equal(leftInventory.every(Object.isFrozen), true);
  assert.equal(digestRegularFile(path.join(left, "a.txt")), sha256("top"));
});

test("difference diagnostics identify mode, content, missing, and unexpected files", () => {
  const expected = [
    entry("content.txt", "expected"),
    entry("missing.txt", "missing"),
    entry("mode.txt", "same", 0o755),
    entry("same.txt", "same")
  ];
  const actual = [
    entry("content.txt", "actual"),
    entry("mode.txt", "same", 0o644),
    entry("same.txt", "same"),
    entry("unexpected.txt", "unexpected")
  ];

  assert.deepEqual(describeInventoryDifference(expected, actual), [
    'content mismatch: "content.txt"',
    'missing installed file: "missing.txt"',
    'mode mismatch: "mode.txt" (755 != 644)',
    'unexpected installed file: "unexpected.txt"'
  ]);
});

test("difference diagnostics have bounded count, escaped paths, and an omission marker", () => {
  const expected = Array.from({ length: 30 }, (_, index) => (
    entry(`line-${String(index).padStart(2, "0")}\nname.txt`, "expected")
  ));
  const diagnostics = describeInventoryDifference(expected, []);
  assert.equal(diagnostics.length, 20);
  assert.match(diagnostics[0], /\\n/);
  assert.doesNotMatch(diagnostics[0], /\n/);
  assert.equal(diagnostics.at(-1), "11 additional inventory differences omitted.");
  assert.ok(Buffer.byteLength(diagnostics.join("\n"), "utf8") <= 16 * 1024);
  assert.equal(Object.isFrozen(diagnostics), true);
});

test("inventory enforces depth, path, file-count, per-file, and total-byte limits", (t) => {
  const depthRoot = fixture(t);
  write(depthRoot, "one/two.txt", "x");
  assert.throws(
    () => createPluginInventory(depthRoot, { maxDepth: 1 }),
    /exceeds the 1-level depth limit/
  );

  const pathRoot = fixture(t);
  write(pathRoot, "four.txt", "x");
  assert.throws(
    () => createPluginInventory(pathRoot, { maxPathBytes: 4 }),
    /exceeds the 4-byte relative-path limit/
  );

  const countRoot = fixture(t);
  write(countRoot, "a.txt", "");
  write(countRoot, "b.txt", "");
  assert.throws(
    () => createPluginInventory(countRoot, { maxFiles: 1 }),
    /exceeds the 1-file limit/
  );

  const fileRoot = fixture(t);
  write(fileRoot, "large.txt", "abc");
  assert.throws(
    () => createPluginInventory(fileRoot, { maxFileBytes: 2 }),
    /exceeds the 2-byte per-file limit/
  );

  const totalRoot = fixture(t);
  write(totalRoot, "a.txt", "ab");
  write(totalRoot, "b.txt", "cd");
  assert.throws(
    () => createPluginInventory(totalRoot, { maxTotalBytes: 3 }),
    /exceeds the 3-byte total-file limit/
  );

  assert.throws(
    () => createPluginInventory(totalRoot, { maxFiles: Number.MAX_SAFE_INTEGER }),
    /must be an integer/
  );
  assert.throws(
    () => createPluginInventory(totalRoot, { unbounded: true }),
    /Unknown plugin inventory option/
  );
});

test("inventory rejects symbolic links and special filesystem entries", (t) => {
  const symlinkRoot = fixture(t);
  const target = write(symlinkRoot, "target.txt", "target");
  const link = path.join(symlinkRoot, "link.txt");
  let realSymlink = true;
  try {
    fs.symlinkSync(target, link, "file");
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    realSymlink = false;
    write(symlinkRoot, "link.txt", "simulated");
  }

  if (realSymlink) {
    assert.throws(() => createPluginInventory(symlinkRoot), /must not contain symbolic links/);
  } else {
    const canonicalLink = canonicalPath(link);
    const originalLstat = fs.lstatSync;
    fs.lstatSync = function patchedLstat(candidate, options) {
      const stat = originalLstat.call(this, candidate, options);
      if (path.resolve(String(candidate)) !== canonicalLink) return stat;
      return {
        ...stat,
        isSymbolicLink: () => true,
        isDirectory: () => false,
        isFile: () => false
      };
    };
    try {
      assert.throws(() => createPluginInventory(symlinkRoot), /must not contain symbolic links/);
    } finally {
      fs.lstatSync = originalLstat;
    }
  }

  const specialRoot = fixture(t);
  const special = write(specialRoot, "special.bin", "simulated");
  const canonicalSpecial = canonicalPath(special);
  const originalLstat = fs.lstatSync;
  fs.lstatSync = function patchedLstat(candidate, options) {
    const stat = originalLstat.call(this, candidate, options);
    if (path.resolve(String(candidate)) !== canonicalSpecial) return stat;
    return {
      ...stat,
      isSymbolicLink: () => false,
      isDirectory: () => false,
      isFile: () => false
    };
  };
  try {
    assert.throws(
      () => createPluginInventory(specialRoot),
      /only regular files and directories/
    );
  } finally {
    fs.lstatSync = originalLstat;
  }
});

test("inventory fails closed when a file changes between inspection and open", (t) => {
  const root = fixture(t);
  const victim = write(root, "victim.txt", "original");
  const canonicalVictim = canonicalPath(victim);
  const originalOpen = fs.openSync;
  let replaced = false;
  fs.openSync = function patchedOpen(candidate, ...args) {
    if (!replaced && path.resolve(String(candidate)) === canonicalVictim) {
      replaced = true;
      fs.renameSync(victim, `${victim}.old`);
      fs.writeFileSync(victim, "replacement", "utf8");
    }
    return originalOpen.call(this, candidate, ...args);
  };
  try {
    assert.throws(
      () => createPluginInventory(root),
      /changed before it could be read/
    );
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(replaced, true);
});

test("a regular file swapped to a special file before open is rejected without blocking", (t) => {
  const root = fixture(t);
  const child = path.join(root, "special-file-race.mjs");
  const inventoryModule = new URL("../scripts/lib/plugin-inventory.mjs", import.meta.url).href;
  fs.writeFileSync(child, `
    import fs from "node:fs";
    import path from "node:path";
    import { spawnSync } from "node:child_process";
    import { createPluginInventory } from ${JSON.stringify(inventoryModule)};

    const root = process.argv[2];
    const victim = path.join(root, "victim.txt");
    fs.writeFileSync(victim, "regular", "utf8");
    const originalOpen = fs.openSync;
    const originalFstat = fs.fstatSync;
    let swapped = false;
    let simulatedSpecialDescriptor;
    fs.openSync = function patchedOpen(candidate, ...args) {
      if (!swapped && path.basename(String(candidate)) === "victim.txt") {
        swapped = true;
        if (process.platform === "win32") {
          simulatedSpecialDescriptor = originalOpen.call(this, candidate, ...args);
          return simulatedSpecialDescriptor;
        }
        fs.unlinkSync(candidate);
        const fifo = spawnSync("mkfifo", [String(candidate)], {
          encoding: "utf8",
          shell: false,
          timeout: 500
        });
        if (fifo.error || fifo.status !== 0) throw new Error("Could not create FIFO fixture.");
      }
      return originalOpen.call(this, candidate, ...args);
    };
    fs.fstatSync = function patchedFstat(descriptor, options) {
      const stat = originalFstat.call(this, descriptor, options);
      if (descriptor !== simulatedSpecialDescriptor) return stat;
      return {
        ...stat,
        isFile: () => false
      };
    };
    try {
      createPluginInventory(root);
      process.stderr.write("Inventory admitted a special-file race.\\n");
      process.exitCode = 2;
    } catch (error) {
      if (!/changed before it could be read/.test(error.message)) {
        process.stderr.write("Unexpected inventory rejection.\\n");
        process.exitCode = 3;
      } else {
        process.stdout.write("special-file-race-rejected\\n");
      }
    } finally {
      fs.fstatSync = originalFstat;
      fs.openSync = originalOpen;
    }
  `, "utf8");

  const result = spawnSync(process.execPath, [child, root], {
    encoding: "utf8",
    shell: false,
    timeout: 1_500
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "special-file-race-rejected\n");
});

test("inventory revalidates files after traversal to reject a mixed-time snapshot", (t) => {
  const root = fixture(t);
  const first = write(root, "a-first.txt", "original");
  const second = write(root, "z-second.txt", "second");
  const canonicalFirst = canonicalPath(first);
  const canonicalSecond = canonicalPath(second);
  const originalOpen = fs.openSync;
  let mutated = false;
  fs.openSync = function patchedOpen(candidate, ...args) {
    if (!mutated && path.resolve(String(candidate)) === canonicalSecond) {
      mutated = true;
      fs.writeFileSync(canonicalFirst, "modified", "utf8");
    }
    return originalOpen.call(this, candidate, ...args);
  };
  try {
    assert.throws(
      () => createPluginInventory(root),
      /changed while inventory was being created/
    );
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(mutated, true);
});

test("inventory wraps read failures without admitting a partial result", (t) => {
  const root = fixture(t);
  const victim = write(root, "victim.txt", "unreadable");
  const canonicalVictim = canonicalPath(victim);
  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  let victimDescriptor;
  fs.openSync = function patchedOpen(candidate, ...args) {
    const descriptor = originalOpen.call(this, candidate, ...args);
    if (path.resolve(String(candidate)) === canonicalVictim) victimDescriptor = descriptor;
    return descriptor;
  };
  fs.readSync = function patchedRead(descriptor, ...args) {
    if (descriptor === victimDescriptor) {
      const error = new Error("simulated read failure");
      error.code = "EIO";
      throw error;
    }
    return originalRead.call(this, descriptor, ...args);
  };
  try {
    assert.throws(
      () => createPluginInventory(root),
      (error) => {
        assert.match(error.message, /Could not read plugin file "victim.txt"/);
        assert.equal(error.cause?.code, "EIO");
        return true;
      }
    );
  } finally {
    fs.readSync = originalRead;
    fs.openSync = originalOpen;
  }
});

test("inventory and digest validators reject accessors, duplicates, and malformed entries", (t) => {
  const root = fixture(t);
  write(root, "file.txt", "content");
  let getterCalls = 0;
  const hostileOptions = {};
  Object.defineProperty(hostileOptions, "maxFiles", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return Number.MAX_SAFE_INTEGER;
    }
  });
  assert.throws(() => createPluginInventory(root, hostileOptions), /must be a data property/);
  assert.equal(getterCalls, 0);

  const valid = entry("file.txt", "content");
  assert.throws(() => digestInventory([valid, valid]), /duplicate path/);
  assert.throws(
    () => digestInventory([{ ...valid, path: "../escape.txt" }]),
    /canonical bounded POSIX relative paths/
  );
  assert.throws(
    () => digestInventory([{ ...valid, path: "ambiguous\\path.txt" }]),
    /canonical bounded POSIX relative paths/
  );
  assert.throws(
    () => digestInventory([{ ...valid, path: `ill-formed-${String.fromCharCode(0xd800)}.txt` }]),
    /canonical bounded POSIX relative paths/
  );
  assert.throws(
    () => digestInventory([{ ...valid, sha256: "not-a-digest" }]),
    /digest is invalid/
  );
  const hostileEntry = { ...valid };
  Object.defineProperty(hostileEntry, "size", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return valid.size;
    }
  });
  assert.throws(() => digestInventory([hostileEntry]), /only data properties/);
  assert.equal(getterCalls, 0);
});
