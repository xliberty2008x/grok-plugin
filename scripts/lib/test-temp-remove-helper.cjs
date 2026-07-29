"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const [expectedDev, expectedIno] = process.argv.slice(2);
const original = fs.lstatSync(".");
if (
  !original.isDirectory()
  || original.isSymbolicLink()
  || String(original.dev) !== expectedDev
  || String(original.ino) !== expectedIno
) {
  process.exit(42);
}

for (const entry of fs.readdirSync(".")) {
  const stat = fs.lstatSync(entry);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fs.unlinkSync(entry);
    continue;
  }

  fs.chmodSync(entry, 0o700);
  const writable = fs.lstatSync(entry);
  if (
    writable.dev !== stat.dev
    || writable.ino !== stat.ino
    || !writable.isDirectory()
    || writable.isSymbolicLink()
  ) {
    process.exit(43);
  }
  const descriptor = fs.openSync(
    entry,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || !opened.isDirectory()) {
      process.exit(43);
    }
    fs.fchmodSync(descriptor, 0o700);
  } finally {
    fs.closeSync(descriptor);
  }

  const result = spawnSync(process.execPath, [
    __filename,
    String(stat.dev),
    String(stat.ino)
  ], {
    cwd: entry,
    env: { GROK_PLUGIN_TEST_CHILD_HOOK_BYPASS: "1" },
    encoding: "utf8",
    shell: false,
    maxBuffer: 8 * 1024
  });
  if (result.status !== 0 || result.error || result.signal) {
    process.exit(result.status === 42 || result.status === 43 ? result.status : 44);
  }
}

const basename = path.basename(process.cwd());
process.chdir("..");
const emptied = fs.lstatSync(basename);
if (
  !emptied.isDirectory()
  || emptied.isSymbolicLink()
  || String(emptied.dev) !== expectedDev
  || String(emptied.ino) !== expectedIno
) {
  process.exit(43);
}
fs.rmdirSync(basename);
