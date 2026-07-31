"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const LINUX_O_PATH = 0o10000000;

function sameDirectoryIdentity(stat, expected) {
  return (
    stat.dev === expected.dev
    && stat.ino === expected.ino
    && stat.isDirectory()
    && !stat.isSymbolicLink()
  );
}

function openVerifiedDirectory(entry, expected, allowPermissionRepair = true) {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW) || fs.constants.O_NOFOLLOW === 0) {
    throw new Error("Safe no-follow directory access is unavailable.");
  }
  const readFlags = fs.constants.O_RDONLY
    | (fs.constants.O_DIRECTORY || 0)
    | fs.constants.O_NOFOLLOW;
  try {
    const descriptor = fs.openSync(entry, readFlags);
    const opened = fs.fstatSync(descriptor);
    if (!sameDirectoryIdentity(opened, expected)) {
      fs.closeSync(descriptor);
      process.exit(43);
    }
    return descriptor;
  } catch (error) {
    if (error?.code !== "EACCES" && error?.code !== "EPERM") throw error;
    if (!allowPermissionRepair) throw error;
  }

  if (process.platform === "linux") {
    const descriptor = fs.openSync(
      entry,
      LINUX_O_PATH
        | (fs.constants.O_DIRECTORY || 0)
        | fs.constants.O_NOFOLLOW
    );
    const opened = fs.fstatSync(descriptor);
    if (!sameDirectoryIdentity(opened, expected)) {
      fs.closeSync(descriptor);
      process.exit(43);
    }
    // O_PATH pins the verified inode without requiring read permission.
    // chmod through that descriptor cannot follow a raced replacement path.
    fs.chmodSync(`/proc/self/fd/${descriptor}`, 0o700);
    fs.closeSync(descriptor);
    return openVerifiedDirectory(entry, expected, false);
  }

  // Linux O_PATH is the only supported way to pin a permission-locked inode
  // before changing it. Other platforms fail closed and report the residual.
  throw new Error("Safe permission repair is unavailable.");
}

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

  const descriptor = openVerifiedDirectory(entry, stat);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!sameDirectoryIdentity(opened, stat)) process.exit(43);
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
