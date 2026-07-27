#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  assertPrivateDirectory,
  assertVerifiedExecutable,
  DEFAULT_MAX_SYNC_AGE_MS,
  digestStatePath,
  parseSyncArgs,
  readPrivateAuthFile,
  readDigestMetadata,
  tightenPrivateDirectory,
  validateAuthPayload
} from "./sync-grok-ci-auth.mjs";

const LABEL_PREFIX = "com.grok-companion.ci-auth-sync";
const MAX_HELPER_BYTES = 2 * 1024 * 1024;
const MAX_PLIST_BYTES = 256 * 1024;
const INSTALLATION_DIGEST_DOMAIN = "grok-companion-ci-auth-installation/v1";

function usage() {
  return [
    "Usage: node scripts/install-grok-ci-auth-sync.mjs <install|status|uninstall>",
    "  --repo OWNER/REPO",
    "  install requires --gh-bin /absolute/path/to/gh",
    "  [--node-bin /absolute/path/to/node] [--auth-path /path/to/auth.json]",
    "  [--dry-run]"
  ].join("\n");
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function repoSuffix(repo) {
  return crypto.createHash("sha256").update(repo).digest("hex").slice(0, 12);
}

function parseInstallerArgs(argv, { home = os.homedir() } = {}) {
  const command = argv[0];
  if (!["install", "status", "uninstall"].includes(command)) {
    throw new Error("A command is required.");
  }
  const args = {
    command,
    nodeBin: process.execPath,
    authPath: path.join(home, ".grok", "auth.json"),
    dryRun: false,
    home
  };
  const takeValue = (index) => {
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new Error("A required flag value is missing.");
    }
    return argv[index + 1];
  };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") args.repo = takeValue(i++);
    else if (arg === "--gh-bin") args.ghBin = takeValue(i++);
    else if (arg === "--node-bin") args.nodeBin = takeValue(i++);
    else if (arg === "--auth-path") {
      args.authPath = takeValue(i++);
      args.authPathExplicit = true;
    }
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error("An unsupported flag was provided.");
  }
  if (args.help) return args;
  const needsExecutables = command === "install";
  const probe = parseSyncArgs(
    [
      "--repo",
      args.repo || "",
      "--gh-bin",
      args.ghBin || (needsExecutables ? "" : process.execPath),
      "--state-dir",
      path.join(home, "Library", "Application Support", "Grok Companion CI Auth", "probe"),
      "--auth-path",
      args.authPath
    ],
    { home }
  );
  args.repo = probe.repo;
  args.ghBin = args.ghBin ? probe.ghBin : null;
  args.authPath = probe.authPath;
  const authRelative = path.relative(path.resolve(home), args.authPath);
  if (
    authRelative === ".."
    || authRelative.startsWith(`..${path.sep}`)
    || path.isAbsolute(authRelative)
  ) {
    throw new Error("Authentication path must remain inside the current home.");
  }
  if (needsExecutables && !path.isAbsolute(args.nodeBin)) {
    throw new Error("--node-bin must be an absolute path.");
  }
  if (needsExecutables) {
    try {
      args.nodeBin = fs.realpathSync(path.resolve(args.nodeBin));
    } catch {
      throw new Error("Node.js could not be resolved.");
    }
  }
  return args;
}

export function installerPaths(args) {
  const suffix = repoSuffix(args.repo);
  const appRoot = path.join(
    args.home,
    "Library",
    "Application Support",
    "Grok Companion CI Auth",
    suffix
  );
  const stateDir = path.join(appRoot, "state");
  const helper = path.join(appRoot, "sync-grok-ci-auth.mjs");
  const installationDigest = path.join(appRoot, "installation.sha256");
  const label = `${LABEL_PREFIX}.${suffix}`;
  const plist = path.join(args.home, "Library", "LaunchAgents", `${label}.plist`);
  return { appRoot, stateDir, helper, installationDigest, label, plist };
}

export function buildLaunchAgentPlist({
  label,
  nodeBin,
  helper,
  repo,
  authPath,
  ghBin,
  stateDir
}) {
  const programArguments = [
    nodeBin,
    helper,
    "--repo",
    repo,
    "--auth-path",
    authPath,
    "--gh-bin",
    ghBin,
    "--state-dir",
    stateDir
  ];
  const argsXml = programArguments
    .map((argument) => `      <string>${xml(argument)}</string>`)
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xml(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    argsXml,
    "  </array>",
    "  <key>WatchPaths</key>",
    "  <array>",
    `    <string>${xml(authPath)}</string>`,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>StartInterval</key>",
    "  <integer>300</integer>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "</dict>",
    "</plist>",
    ""
  ].join("\n");
}

function assertSameIdentity(left, right) {
  if (left.dev !== right.dev || left.ino !== right.ino) {
    throw new Error("Managed path changed during verification.");
  }
}

function noFollow(flags) {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
    throw new Error("No-follow file operations are unavailable.");
  }
  return flags | fs.constants.O_NOFOLLOW;
}

function verifyOwnedDirectory(directory) {
  let fd;
  try {
    const before = fs.lstatSync(directory);
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new Error("Managed path ancestor must be a real directory.");
    }
    if (before.uid !== process.getuid() || (before.mode & 0o022) !== 0) {
      throw new Error("Managed path ancestor has unsafe ownership or permissions.");
    }
    fd = fs.openSync(
      directory,
      noFollow(fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0))
    );
    const opened = fs.fstatSync(fd);
    assertSameIdentity(before, opened);
    if (
      !opened.isDirectory()
      || opened.uid !== process.getuid()
      || (opened.mode & 0o022) !== 0
    ) {
      throw new Error("Managed path ancestor failed descriptor verification.");
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function relativeComponents(home, target) {
  const resolvedHome = path.resolve(home);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedHome, resolvedTarget);
  if (
    relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error("Managed path must remain inside the current home.");
  }
  return {
    resolvedHome,
    components: relative ? relative.split(path.sep).filter(Boolean) : []
  };
}

function verifyDirectoryChain(directory, home) {
  const { resolvedHome, components } = relativeComponents(home, directory);
  let current = resolvedHome;
  verifyOwnedDirectory(current);
  for (const component of components) {
    current = path.join(current, component);
    verifyOwnedDirectory(current);
  }
}

function verifyExistingDirectoryPrefix(directory, home) {
  const { resolvedHome, components } = relativeComponents(home, directory);
  let current = resolvedHome;
  verifyOwnedDirectory(current);
  for (const component of components) {
    current = path.join(current, component);
    try {
      verifyOwnedDirectory(current);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

function ensureDirectoryChain(directory, home) {
  const { resolvedHome, components } = relativeComponents(home, directory);
  let current = resolvedHome;
  verifyOwnedDirectory(current);
  for (const component of components) {
    current = path.join(current, component);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    verifyOwnedDirectory(current);
  }
}

function ensurePrivateManagedDirectory(directory, home) {
  ensureDirectoryChain(directory, home);
  tightenPrivateDirectory(directory, "Installer directory");
}

function readVerifiedFile(
  file,
  maximumBytes,
  { allowMissing = false, requirePrivate = false } = {}
) {
  let fd;
  try {
    let before;
    try {
      before = fs.lstatSync(file);
    } catch (error) {
      if (allowMissing && error?.code === "ENOENT") return null;
      throw error;
    }
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new Error("Managed file must be a real regular file.");
    }
    if (
      before.uid !== process.getuid()
      || (before.mode & 0o022) !== 0
      || (requirePrivate && (before.mode & 0o077) !== 0)
      || before.size <= 0
      || before.size > maximumBytes
    ) {
      throw new Error("Managed file has unsafe ownership, permissions, or size.");
    }
    fd = fs.openSync(file, noFollow(fs.constants.O_RDONLY));
    const opened = fs.fstatSync(fd);
    assertSameIdentity(before, opened);
    const contents = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    assertSameIdentity(opened, after);
    if (
      opened.size !== after.size
      || opened.mtimeMs !== after.mtimeMs
      || opened.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("Managed file changed during reading.");
    }
    const current = fs.lstatSync(file);
    assertSameIdentity(opened, current);
    return { contents, mode: opened.mode & 0o777 };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function atomicWrite(file, contents, mode = 0o600) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  let fd;
  try {
    fd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      mode
    );
    fs.writeFileSync(fd, contents);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function expectedInstallationDigest(helperContents, plistContents) {
  return crypto
    .createHash("sha256")
    .update(INSTALLATION_DIGEST_DOMAIN)
    .update("\0")
    .update(helperContents)
    .update("\0")
    .update(plistContents)
    .digest("hex");
}

function launchctl(args, { allowFailure = false, home = os.homedir() } = {}) {
  const result = spawnSync("/bin/launchctl", args, {
    env: {
      HOME: home,
      USER: process.env.USER || "",
      LOGNAME: process.env.LOGNAME || ""
    },
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error("launchctl operation failed.");
  }
  return !result.error && result.status === 0;
}

function callLaunchctl(runner, args, options = {}) {
  const result = runner(args, options);
  if (!options.allowFailure && result !== true) {
    throw new Error("launchctl operation failed.");
  }
  return result === true;
}

function bootout(runner, label, home) {
  return callLaunchctl(
    runner,
    ["bootout", `gui/${process.getuid()}/${label}`],
    { allowFailure: true, home }
  );
}

function removeKnownFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Refusing to remove an unexpected installer path.");
    }
    fs.unlinkSync(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function restoreSnapshot(file, snapshot, writer = atomicWrite) {
  if (snapshot) writer(file, snapshot.contents, snapshot.mode);
  else removeKnownFile(file);
}

function runCopiedHelper({
  nodeBin,
  helper,
  repo,
  authPath,
  ghBin,
  stateDir,
  home
}) {
  const result = spawnSync(
    nodeBin,
    [
      helper,
      "--repo",
      repo,
      "--auth-path",
      authPath,
      "--gh-bin",
      ghBin,
      "--state-dir",
      stateDir,
      "--force"
    ],
    {
      env: {
        HOME: home,
        USER: process.env.USER || "",
        LOGNAME: process.env.LOGNAME || "",
        TMPDIR: process.env.TMPDIR || os.tmpdir(),
        LANG: process.env.LANG || ""
      },
      encoding: "buffer",
      shell: false,
      timeout: 90_000,
      maxBuffer: 1024 * 1024
    }
  );
  return !result.error && result.status === 0;
}

function safeStatus(paths, args, runner, now, sourceHelper) {
  let helper = null;
  let plist = null;
  let installationDigest = null;
  let source = null;
  let unsafe = false;
  try {
    const helperParent = verifyExistingDirectoryPrefix(
      path.dirname(paths.helper),
      args.home
    );
    const plistParent = verifyExistingDirectoryPrefix(
      path.dirname(paths.plist),
      args.home
    );
    if (helperParent) {
      helper = readVerifiedFile(paths.helper, MAX_HELPER_BYTES, {
        allowMissing: true,
        requirePrivate: true
      });
      installationDigest = readVerifiedFile(paths.installationDigest, 128, {
        allowMissing: true,
        requirePrivate: true
      });
    }
    if (plistParent) {
      plist = readVerifiedFile(paths.plist, MAX_PLIST_BYTES, {
        allowMissing: true,
        requirePrivate: true
      });
    }
    source = readVerifiedFile(sourceHelper, MAX_HELPER_BYTES);
  } catch {
    unsafe = true;
  }
  const loaded = callLaunchctl(
    runner,
    ["print", `gui/${process.getuid()}/${paths.label}`],
    { allowFailure: true, home: args.home }
  );
  let health;
  const expectedDigest = helper && plist
    ? expectedInstallationDigest(helper.contents, plist.contents)
    : null;
  const recordedDigest = installationDigest
    ? installationDigest.contents.toString("utf8").trim()
    : null;
  const integrityCurrent = Boolean(
    helper
    && plist
    && source
    && helper.contents.equals(source.contents)
    && /^[0-9a-f]{64}$/.test(recordedDigest || "")
    && recordedDigest === expectedDigest
  );
  if (!unsafe && !helper && !plist && !installationDigest && !loaded) {
    health = "absent";
  } else if (!unsafe && integrityCurrent && loaded) {
    health = "loaded";
  } else {
    health = "degraded";
  }

  let sync = "pending";
  try {
    if (verifyExistingDirectoryPrefix(paths.stateDir, args.home)) {
      assertPrivateDirectory(paths.stateDir, "State directory");
      const metadata = readDigestMetadata(
        digestStatePath(paths.stateDir, args.repo)
      );
      const rawAuth = readPrivateAuthFile(args.authPath);
      validateAuthPayload(rawAuth, { now });
      const currentDigest = crypto
        .createHash("sha256")
        .update(rawAuth)
        .digest("hex");
      if (
        metadata
        && metadata.digest === currentDigest
        && metadata.mtimeMs <= now + 1000
        && Math.max(0, now - metadata.mtimeMs) < DEFAULT_MAX_SYNC_AGE_MS
      ) {
        sync = "current";
      }
    }
  } catch {
    sync = "pending";
  }
  return { health, sync, loaded, ...paths };
}

export function runInstaller(
  args,
  {
    platform = process.platform,
    sourceHelper = fileURLToPath(
      new URL("./sync-grok-ci-auth.mjs", import.meta.url)
    ),
    launchctlRunner = launchctl,
    initialSyncRunner = runCopiedHelper,
    fileWriter = atomicWrite,
    now = null
  } = {}
) {
  if (platform !== "darwin") {
    throw new Error("LaunchAgent installation is supported only on macOS.");
  }
  const paths = installerPaths(args);
  const plistContents = args.command === "install"
    ? buildLaunchAgentPlist({
      ...paths,
      nodeBin: args.nodeBin,
      repo: args.repo,
      authPath: args.authPath,
      ghBin: args.ghBin
    })
    : null;
  if (args.dryRun) {
    return {
      command: args.command,
      label: paths.label,
      plist: paths.plist,
      helper: paths.helper,
      stateDir: paths.stateDir,
      plistContents
    };
  }

  if (args.command === "install") {
    assertVerifiedExecutable(args.nodeBin, "Node.js");
    assertVerifiedExecutable(args.ghBin, "GitHub CLI");
    const authDirectory = path.dirname(args.authPath);
    verifyDirectoryChain(authDirectory, args.home);
    const defaultAuthPath = path.join(args.home, ".grok", "auth.json");
    const customAuthPath = args.authPathExplicit === true
      || path.resolve(args.authPath) !== path.resolve(defaultAuthPath);
    if (customAuthPath) {
      assertPrivateDirectory(authDirectory, "Authentication directory");
    } else {
      tightenPrivateDirectory(authDirectory, "Authentication directory");
    }
    const applicationBase = path.dirname(paths.appRoot);
    ensurePrivateManagedDirectory(applicationBase, args.home);
    ensurePrivateManagedDirectory(paths.appRoot, args.home);
    ensurePrivateManagedDirectory(paths.stateDir, args.home);
    ensureDirectoryChain(path.dirname(paths.plist), args.home);

    const source = readVerifiedFile(sourceHelper, MAX_HELPER_BYTES);
    const previousHelper = readVerifiedFile(paths.helper, MAX_HELPER_BYTES, {
      allowMissing: true,
      requirePrivate: true
    });
    const previousPlist = readVerifiedFile(paths.plist, MAX_PLIST_BYTES, {
      allowMissing: true,
      requirePrivate: true
    });
    const previousInstallationDigest = readVerifiedFile(
      paths.installationDigest,
      128,
      {
        allowMissing: true,
        requirePrivate: true
      }
    );
    const previouslyLoaded = callLaunchctl(
      launchctlRunner,
      ["print", `gui/${process.getuid()}/${paths.label}`],
      { allowFailure: true, home: args.home }
    );

    try {
      fileWriter(paths.helper, source.contents, 0o600);
      fileWriter(paths.plist, plistContents, 0o600);
      fileWriter(
        paths.installationDigest,
        `${expectedInstallationDigest(source.contents, plistContents)}\n`,
        0o600
      );
    } catch {
      bootout(launchctlRunner, paths.label, args.home);
      restoreSnapshot(paths.helper, previousHelper, fileWriter);
      restoreSnapshot(paths.plist, previousPlist, fileWriter);
      restoreSnapshot(
        paths.installationDigest,
        previousInstallationDigest,
        fileWriter
      );
      if (previouslyLoaded && previousPlist && previousHelper) {
        callLaunchctl(
          launchctlRunner,
          ["bootstrap", `gui/${process.getuid()}`, paths.plist],
          { home: args.home }
        );
      }
      throw new Error("Installation failed; prior installation restored.");
    }

    let synchronized = false;
    try {
      synchronized = initialSyncRunner({
        nodeBin: args.nodeBin,
        helper: paths.helper,
        repo: args.repo,
        authPath: args.authPath,
        ghBin: args.ghBin,
        stateDir: paths.stateDir,
        home: args.home,
        force: true
      }) === true;
    } catch {
      synchronized = false;
    }

    bootout(launchctlRunner, paths.label, args.home);
    try {
      callLaunchctl(
        launchctlRunner,
        ["bootstrap", `gui/${process.getuid()}`, paths.plist],
        { home: args.home }
      );
    } catch {
      bootout(launchctlRunner, paths.label, args.home);
      restoreSnapshot(paths.helper, previousHelper, fileWriter);
      restoreSnapshot(paths.plist, previousPlist, fileWriter);
      restoreSnapshot(
        paths.installationDigest,
        previousInstallationDigest,
        fileWriter
      );
      if (previouslyLoaded && previousPlist && previousHelper) {
        callLaunchctl(
          launchctlRunner,
          ["bootstrap", `gui/${process.getuid()}`, paths.plist],
          { home: args.home }
        );
      }
      throw new Error("LaunchAgent bootstrap failed; prior installation restored.");
    }
    return {
      status: synchronized
        ? "installed-synchronized"
        : "installed-pending-sync",
      health: "loaded",
      sync: synchronized ? "current" : "pending",
      ...paths
    };
  }

  if (args.command === "status") {
    return safeStatus(
      paths,
      args,
      launchctlRunner,
      now ?? Date.now(),
      sourceHelper
    );
  }

  const plistParent = verifyExistingDirectoryPrefix(
    path.dirname(paths.plist),
    args.home
  );
  const helperParent = verifyExistingDirectoryPrefix(
    path.dirname(paths.helper),
    args.home
  );
  bootout(launchctlRunner, paths.label, args.home);
  if (plistParent) removeKnownFile(paths.plist);
  if (helperParent) {
    removeKnownFile(paths.helper);
    removeKnownFile(paths.installationDigest);
  }
  return { status: "uninstalled", ...paths };
}

function main() {
  try {
    if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const args = parseInstallerArgs(process.argv.slice(2));
    const result = runInstaller(args);
    if (args.dryRun) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (args.command === "status") {
      process.stdout.write(
        `install-grok-ci-auth-sync: health=${result.health}; sync=${result.sync}; state=${result.stateDir}.\n`
      );
    } else if (result.status === "installed-pending-sync") {
      process.stderr.write(
        "install-grok-ci-auth-sync: installed-pending-sync; watcher armed and will retry.\n"
      );
      process.exitCode = 2;
    } else {
      process.stdout.write(`install-grok-ci-auth-sync: ${result.status}.\n`);
    }
  } catch (error) {
    process.stderr.write(
      `install-grok-ci-auth-sync: ${error?.message || "Installer operation failed."}\n`
    );
    process.exitCode = 1;
  }
}

let invokedPath = "";
try {
  invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
} catch {
  invokedPath = "";
}
if (invokedPath === fs.realpathSync(fileURLToPath(import.meta.url))) main();
