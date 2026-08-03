/** Internal Worker Broker evidence toolchain domain. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { redactText } from "../../plugins/grok/scripts/lib/redact.mjs";
import {
  createPluginInventory,
  digestInventory
} from "./plugin-inventory.mjs";

import {
  REPO_ROOT,
  sha256Text,
  stableStringify
} from "./worker-broker-evidence-core.mjs";
import {
  assertProtectedHostPath,
  protectedReviewTrustError
} from "./worker-broker-evidence-files.mjs";

export function defaultQualification() {
  return {
    deterministic: "not_run",
    installedHost: "not_run",
    provider: "not_run",
    release: "not_run"
  };
}

export function recordCarriesLiveQualification(record) {
  const references = record?.liveQualificationReceipts;
  return Boolean(
    record?.qualification?.provider === "pass"
    || record?.qualification?.installedHost === "pass"
    || references?.syntheticDirectMcp
    || references?.naturalCodexHost
  );
}

export function passedGateIds(record) {
  return new Set((record?.verification || [])
    .filter((entry) => entry?.outcome === "pass" && typeof entry.gateId === "string")
    .map((entry) => entry.gateId));
}

export function hasPassedBoundary(record, boundary) {
  return (record?.verification || []).some((entry) => (
    entry?.outcome === "pass" && entry?.boundary === boundary
  ));
}

export const PROOF_TOOLCHAIN_ERROR = "E_PROOF_TOOLCHAIN";

export const PROOF_PLATFORM_ERROR = "E_PROOF_PLATFORM";

let trustedGitBindingCache = null;

let protectedReviewGitBinding = null;

function proofToolchainError() {
  const error = new Error("The proof toolchain could not be resolved or its identity changed.");
  error.code = PROOF_TOOLCHAIN_ERROR;
  return error;
}

function proofPlatformError() {
  const error = new Error("The proof producer is unavailable on this platform.");
  error.code = PROOF_PLATFORM_ERROR;
  return error;
}

function assertProofProducerPlatform() {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw proofPlatformError();
  }
}

function uniqueAbsolutePaths(candidates) {
  return [...new Set(candidates.filter((candidate) => (
    typeof candidate === "string" && path.isAbsolute(candidate)
  )))];
}

export function captureBoundFile(entryPath, { executable = false } = {}) {
  if (typeof entryPath !== "string" || !path.isAbsolute(entryPath)) {
    throw proofToolchainError();
  }
  const entry = path.resolve(entryPath);
  const entryStat = fs.lstatSync(entry);
  if (!entryStat.isFile() && !entryStat.isSymbolicLink()) throw proofToolchainError();
  const canonicalPath = fs.realpathSync(entry);
  if (!path.isAbsolute(canonicalPath)) throw proofToolchainError();
  const canonicalStat = fs.statSync(canonicalPath);
  if (!canonicalStat.isFile()) throw proofToolchainError();
  if (executable && process.platform !== "win32" && !(canonicalStat.mode & 0o111)) {
    throw proofToolchainError();
  }
  return Object.freeze({
    entryPath: entry,
    entryType: entryStat.isSymbolicLink() ? "symlink" : "file",
    linkTarget: entryStat.isSymbolicLink() ? fs.readlinkSync(entry) : null,
    canonicalPath,
    sha256: sha256Text(fs.readFileSync(canonicalPath)),
    size: canonicalStat.size,
    mode: canonicalStat.mode,
    device: String(canonicalStat.dev),
    inode: String(canonicalStat.ino),
    executable
  });
}

function sameBoundFileIdentity(left, right) {
  return Boolean(left && right
    && left.entryPath === right.entryPath
    && left.entryType === right.entryType
    && left.linkTarget === right.linkTarget
    && left.canonicalPath === right.canonicalPath
    && left.sha256 === right.sha256
    && left.size === right.size
    && left.mode === right.mode
    && left.device === right.device
    && left.inode === right.inode
    && left.executable === right.executable);
}

function assertBoundFileIdentity(binding) {
  let current;
  try {
    current = captureBoundFile(binding.entryPath, { executable: binding.executable });
  } catch {
    throw proofToolchainError();
  }
  if (!sameBoundFileIdentity(binding, current)) throw proofToolchainError();
}

function proofSystemDirectories() {
  if (process.platform === "win32") {
    return [
      "C:\\Windows\\System32",
      "C:\\Windows"
    ];
  }
  return ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
}

function proofEnvironmentPath(pathEntries = []) {
  return uniqueAbsolutePaths([...pathEntries, ...proofSystemDirectories()]).join(path.delimiter);
}

function baseProofEnvironment(pathEntries = [], proofHome = null) {
  const safe = {
    PATH: proofEnvironmentPath(pathEntries),
    LANG: "C",
    LC_ALL: "C",
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0"
  };
  if (proofHome) {
    safe.HOME = proofHome;
    safe.TMPDIR = proofHome;
    safe.TMP = proofHome;
    safe.TEMP = proofHome;
    safe.USERPROFILE = proofHome;
    safe.APPDATA = path.join(proofHome, "appdata");
    safe.LOCALAPPDATA = path.join(proofHome, "local-appdata");
    safe.NPM_CONFIG_USERCONFIG = path.join(proofHome, "user.npmrc");
    safe.NPM_CONFIG_GLOBALCONFIG = path.join(proofHome, "global.npmrc");
    safe.NPM_CONFIG_CACHE = path.join(proofHome, "npm-cache");
    safe.NPM_CONFIG_UPDATE_NOTIFIER = "false";
    safe.NPM_CONFIG_FUND = "false";
    safe.NPM_CONFIG_AUDIT = "false";
  }
  if (process.platform === "win32") {
    const systemRoot = "C:\\Windows";
    const comSpec = path.join(systemRoot, "System32", "cmd.exe");
    safe.SYSTEMROOT = systemRoot;
    safe.SystemRoot = systemRoot;
    safe.COMSPEC = comSpec;
    safe.ComSpec = comSpec;
    safe.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  }
  return safe;
}

function probeBoundExecutable(binding, args, { nodeBinding = null, pathEntries = [] } = {}) {
  assertBoundFileIdentity(binding);
  if (nodeBinding) assertBoundFileIdentity(nodeBinding);
  const command = nodeBinding ? nodeBinding.canonicalPath : binding.canonicalPath;
  const commandArgs = nodeBinding ? [binding.canonicalPath, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    env: baseProofEnvironment(pathEntries),
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return result.status === 0 && !result.error && !result.signal;
}

function trustedGitCandidates() {
  const sibling = path.join(
    path.dirname(process.execPath),
    process.platform === "win32" ? "git.exe" : "git"
  );
  if (process.platform === "win32") {
    return uniqueAbsolutePaths([
      sibling,
      "C:\\Program Files\\Git\\cmd\\git.exe",
      "C:\\Program Files\\Git\\bin\\git.exe",
      "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
      "C:\\Program Files (x86)\\Git\\bin\\git.exe"
    ]);
  }
  if (process.platform === "darwin") {
    return uniqueAbsolutePaths([
      sibling,
      "/opt/homebrew/bin/git",
      "/usr/local/bin/git",
      "/opt/local/bin/git",
      "/usr/bin/git",
      "/bin/git"
    ]);
  }
  return uniqueAbsolutePaths([
    sibling,
    "/usr/bin/git",
    "/bin/git",
    "/usr/local/bin/git",
    "/snap/bin/git",
    "/run/current-system/sw/bin/git",
    "/nix/var/nix/profiles/default/bin/git"
  ]);
}

function resolveTrustedGitBinding() {
  for (const candidate of trustedGitCandidates()) {
    try {
      const binding = captureBoundFile(candidate, { executable: true });
      if (probeBoundExecutable(binding, ["--version"], {
        pathEntries: [path.dirname(binding.canonicalPath)]
      })) return binding;
    } catch {
      // A fixed candidate is absent, unusable, or changed while probed.
    }
  }
  throw proofToolchainError();
}

function trustedGitBinding() {
  if (protectedReviewGitBinding) {
    assertBoundFileIdentity(protectedReviewGitBinding);
    return protectedReviewGitBinding;
  }
  if (trustedGitBindingCache) {
    assertBoundFileIdentity(trustedGitBindingCache);
    return trustedGitBindingCache;
  }
  trustedGitBindingCache = resolveTrustedGitBinding();
  return trustedGitBindingCache;
}

export function withProtectedReviewGitBinding(binding, action) {
  if (protectedReviewGitBinding || typeof action !== "function") {
    throw protectedReviewTrustError();
  }
  assertBoundFileIdentity(binding);
  if (typeof binding.emptyHooksPath !== "string"
    || !path.isAbsolute(binding.emptyHooksPath)) {
    throw protectedReviewTrustError();
  }
  try {
    assertProtectedHostPath(binding.emptyHooksPath, "directory");
    if (fs.readdirSync(binding.emptyHooksPath).length !== 0) {
      throw protectedReviewTrustError();
    }
  } catch {
    throw protectedReviewTrustError();
  }
  protectedReviewGitBinding = binding;
  try {
    return action();
  } finally {
    protectedReviewGitBinding = null;
  }
}

function protectedReviewGitArguments(args, cwd, binding) {
  if (!protectedReviewGitBinding || args[0] === "--version") return args;
  if (typeof cwd !== "string"
    || !path.isAbsolute(cwd)
    || typeof binding.emptyHooksPath !== "string"
    || !path.isAbsolute(binding.emptyHooksPath)) {
    throw protectedReviewTrustError();
  }
  return [
    "--no-pager",
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${binding.emptyHooksPath}`,
    "-c", `core.worktree=${cwd}`,
    "-c", "core.bare=false",
    "-c", "core.fileMode=true",
    "-c", "core.ignoreCase=false",
    "-c", "core.symlinks=true",
    "-c", "core.attributesFile=/dev/null",
    "-c", "core.excludesFile=/dev/null",
    "-c", "core.pager=cat",
    "-c", "diff.external=",
    "-c", "diff.trustExitCode=false",
    "-c", "interactive.diffFilter=",
    "-c", "submodule.recurse=false",
    "-c", "status.showUntrackedFiles=all",
    "-c", "status.submoduleSummary=false",
    ...args
  ];
}

export function execTrustedGit(args, options = {}) {
  const binding = trustedGitBinding();
  assertBoundFileIdentity(binding);
  const { env: ignoredEnvironment, ...safeOptions } = options;
  void ignoredEnvironment;
  const environment = baseProofEnvironment([path.dirname(binding.canonicalPath)]);
  if (protectedReviewGitBinding) {
    Object.assign(environment, {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_PAGER: "cat",
      PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1"
    });
  }
  return execFileSync(
    binding.canonicalPath,
    protectedReviewGitArguments(args, safeOptions.cwd, binding),
    {
    ...safeOptions,
    env: environment,
    shell: false
    }
  );
}

function resolveProofNodeBinding() {
  const binding = captureBoundFile(process.execPath, { executable: true });
  const expectedName = process.platform === "win32" ? "node.exe" : "node";
  const pathEntry = path.join(path.dirname(binding.entryPath), expectedName);
  const namedBinding = captureBoundFile(pathEntry, { executable: true });
  if (binding.canonicalPath !== namedBinding.canonicalPath
    || binding.sha256 !== namedBinding.sha256) {
    throw proofToolchainError();
  }
  if (!probeBoundExecutable(binding, ["--version"], {
    pathEntries: [path.dirname(namedBinding.entryPath)]
  })) throw proofToolchainError();
  return Object.freeze({ executable: binding, pathEntry: namedBinding });
}

function trustedPythonCandidates() {
  const sibling = path.join(
    path.dirname(process.execPath),
    process.platform === "win32" ? "python.exe" : "python3"
  );
  if (process.platform === "darwin") {
    return uniqueAbsolutePaths([
      sibling,
      "/opt/homebrew/bin/python3",
      "/usr/local/bin/python3",
      "/opt/local/bin/python3",
      "/usr/bin/python3"
    ]);
  }
  return uniqueAbsolutePaths([
    sibling,
    "/usr/bin/python3",
    "/bin/python3",
    "/usr/local/bin/python3",
    "/run/current-system/sw/bin/python3",
    "/nix/var/nix/profiles/default/bin/python3"
  ]);
}

function isShebangScript(binding) {
  try {
    const descriptor = fs.openSync(binding.canonicalPath, fs.constants.O_RDONLY);
    try {
      const prefix = Buffer.alloc(2);
      return fs.readSync(descriptor, prefix, 0, prefix.length, 0) === 2
        && prefix[0] === 0x23
        && prefix[1] === 0x21;
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return true;
  }
}

function resolveProofPythonBinding(pathEntries) {
  for (const candidate of trustedPythonCandidates()) {
    try {
      const binding = captureBoundFile(candidate, { executable: true });
      // Shell-based pyenv/asdf-style shims would add an unbound interpreter
      // behind the captured file identity. Proof production accepts only a
      // fixed native interpreter at one of the reviewed platform locations.
      if (isShebangScript(binding)) continue;
      if (probeBoundExecutable(binding, [
        "-I",
        "-S",
        "-B",
        "-c",
        "import errno,json,os,pty,subprocess,sys,threading,time"
      ], {
        // Probe under the same PATH later inherited by proof gates. The bound
        // Python itself is invoked by absolute canonical path, never via PATH.
        pathEntries
      })) return binding;
    } catch {
      // A fixed candidate is absent, unusable, lacks the POSIX PTY modules, or
      // changed while probed. Never fall back to caller-controlled PATH.
    }
  }
  throw proofToolchainError();
}

function trustedNpmLauncherCandidates(nodeBinding) {
  const nodeDirectory = path.dirname(nodeBinding.pathEntry.entryPath);
  const executableName = process.platform === "win32" ? "npm.cmd" : "npm";
  const candidates = [path.join(nodeDirectory, executableName)];
  if (process.platform === "win32") {
    candidates.push(
      "C:\\Program Files\\nodejs\\npm.cmd",
      "C:\\Program Files (x86)\\nodejs\\npm.cmd"
    );
  } else {
    candidates.push(
      "/opt/homebrew/bin/npm",
      "/usr/local/bin/npm",
      "/usr/bin/npm"
    );
  }
  return uniqueAbsolutePaths(candidates);
}

function npmCliCandidates(launcher) {
  const launcherDirectory = path.dirname(launcher.entryPath);
  const candidates = [
    launcher.canonicalPath,
    path.join(launcherDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(launcherDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(launcherDirectory, "..", "node_modules", "npm", "bin", "npm-cli.js")
  ];
  if (process.platform !== "win32") {
    candidates.push(
      "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js",
      "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
      "/usr/lib/node_modules/npm/bin/npm-cli.js"
    );
  }
  return uniqueAbsolutePaths(candidates);
}

function resolveTrustedNpmBinding(nodeBinding) {
  for (const launcherCandidate of trustedNpmLauncherCandidates(nodeBinding)) {
    let launcher;
    try {
      launcher = captureBoundFile(launcherCandidate, {
        executable: process.platform !== "win32"
      });
    } catch {
      continue;
    }
    for (const cliCandidate of npmCliCandidates(launcher)) {
      try {
        const cli = captureBoundFile(cliCandidate);
        const pathEntries = [
          path.dirname(nodeBinding.pathEntry.entryPath),
          path.dirname(launcher.entryPath)
        ];
        if (probeBoundExecutable(cli, ["--version"], {
          nodeBinding: nodeBinding.executable,
          pathEntries
        })) return Object.freeze({ launcher, cli });
      } catch {
        // Continue until a fixed launcher/CLI pair can be proven executable.
      }
    }
  }
  throw proofToolchainError();
}

export function assertProofToolchainIdentity(toolchain) {
  if (!toolchain?.node?.executable
    || !toolchain?.node?.pathEntry
    || !toolchain?.npm?.launcher
    || !toolchain?.npm?.cli
    || !toolchain?.git
    || !toolchain?.python) throw proofToolchainError();
  assertBoundFileIdentity(toolchain.node.executable);
  assertBoundFileIdentity(toolchain.node.pathEntry);
  assertBoundFileIdentity(toolchain.npm.launcher);
  assertBoundFileIdentity(toolchain.npm.cli);
  assertBoundFileIdentity(toolchain.git);
  assertBoundFileIdentity(toolchain.python);
}

export function proofToolchainDigest(toolchain) {
  assertProofToolchainIdentity(toolchain);
  const identity = (binding) => ({
    entryPath: binding.entryPath,
    entryType: binding.entryType,
    linkTarget: binding.linkTarget,
    canonicalPath: binding.canonicalPath,
    sha256: binding.sha256,
    size: binding.size,
    mode: binding.mode,
    device: binding.device,
    inode: binding.inode
  });
  return sha256Text(stableStringify({
    node: {
      executable: identity(toolchain.node.executable),
      pathEntry: identity(toolchain.node.pathEntry)
    },
    npm: {
      launcher: identity(toolchain.npm.launcher),
      cli: identity(toolchain.npm.cli)
    },
    git: identity(toolchain.git),
    python: identity(toolchain.python)
  }));
}

function proofTemporaryBase() {
  if (process.platform === "win32") return "C:\\Windows\\Temp";
  return "/tmp";
}

const PROOF_HOME_CLEANUP_ATTEMPTS = 5;

const PROOF_HOME_CLEANUP_RETRY_MS = 10;

const PROOF_HOME_DIRECTORY_HANDLES = new WeakMap();

const PROOF_HOME_CLEANUP_RESULTS = new WeakMap();

function processUidOrNull() {
  return typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
}

export function captureProofTemporaryHomeIdentity(proofHome) {
  assertProofProducerPlatform();
  const requested = path.resolve(proofHome);
  let canonical;
  try {
    canonical = fs.realpathSync.native(requested);
  } catch {
    canonical = fs.realpathSync(requested);
  }
  const absolute = path.resolve(canonical);
  const stat = fs.lstatSync(absolute, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Proof temporary home must be a real directory.");
  }
  const uid = processUidOrNull();
  if (uid != null && stat.uid !== uid) {
    throw new Error("Proof temporary home must be owned by the proof process.");
  }
  const identity = Object.freeze({
    path: absolute,
    realPath: absolute,
    dev: stat.dev,
    ino: stat.ino,
    uid
  });
  const noFollow = fs.constants.O_NOFOLLOW;
  const directory = fs.constants.O_DIRECTORY;
  if (!Number.isInteger(noFollow) || !Number.isInteger(directory)) {
    throw proofPlatformError();
  }
  const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow | directory);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!proofHomeStatMatchesIdentity(opened, identity)) {
      throw new Error("Proof temporary home identity changed while binding its directory handle.");
    }
    PROOF_HOME_DIRECTORY_HANDLES.set(identity, descriptor);
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
  return identity;
}

function proofHomeStatMatchesIdentity(stat, identity) {
  return Boolean(stat
    && !stat.isSymbolicLink()
    && stat.isDirectory()
    && stat.dev === identity.dev
    && stat.ino === identity.ino
    && (identity.uid == null || stat.uid === identity.uid));
}

function inspectProofTemporaryHomeIdentity(identity) {
  if (!identity
    || typeof identity.path !== "string"
    || identity.path !== path.resolve(identity.path)) {
    return { status: "mismatch" };
  }
  let stat;
  try {
    stat = fs.lstatSync(identity.path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing" };
    return { status: "mismatch" };
  }
  if (!proofHomeStatMatchesIdentity(stat, identity)) {
    return { status: "mismatch" };
  }
  const uid = processUidOrNull();
  if (uid != null && (identity.uid !== uid || stat.uid !== uid)) {
    return { status: "mismatch" };
  }
  let realPath;
  try {
    realPath = path.resolve(fs.realpathSync.native(identity.path));
  } catch {
    try {
      realPath = path.resolve(fs.realpathSync(identity.path));
    } catch (error) {
      if (error?.code === "ENOENT") return { status: "missing" };
      return { status: "mismatch" };
    }
  }
  if (realPath !== identity.realPath || realPath !== identity.path) {
    return { status: "mismatch" };
  }
  return { status: "match", stat };
}

export function cleanupProofTemporaryHome(identity) {
  if (identity && typeof identity === "object" && PROOF_HOME_CLEANUP_RESULTS.has(identity)) {
    return { ok: PROOF_HOME_CLEANUP_RESULTS.get(identity) };
  }
  let ok = false;
  const descriptor = identity && typeof identity === "object"
    ? PROOF_HOME_DIRECTORY_HANDLES.get(identity)
    : null;
  let descriptorClosed = false;
  let witnessDescriptor = null;
  let witnessClosed = false;
  let witnessIdentity = null;
  try {
    // The immutable fields are not an authority token. Only an identity object
    // captured by this module has the no-follow root descriptor held in the
    // private WeakMap; copied or caller-forged identities must never authorize
    // pathname deletion.
    if (descriptor == null) return { ok: false };
    const initial = inspectProofTemporaryHomeIdentity(identity);
    // A missing path before this cleanup starts is not proof of deletion: a
    // gate may have renamed the original inode and left sensitive data behind.
    if (initial.status !== "match") return { ok: false };
    if (descriptor != null) {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!proofHomeStatMatchesIdentity(opened, identity) || opened.nlink === 0n) {
        return { ok: false };
      }
      // Create the deletion witness only after every gate has exited and after
      // the bound root was revalidated. Under the documented quiescent-gate
      // boundary, its link transition distinguishes removal of this tree from
      // a stale/mismatched pathname outcome.
      const witnessPath = path.join(
        identity.path,
        `.proof-cleanup-witness-${crypto.randomBytes(16).toString("hex")}`
      );
      witnessDescriptor = fs.openSync(
        witnessPath,
        fs.constants.O_CREAT
          | fs.constants.O_EXCL
          | fs.constants.O_RDWR
          | fs.constants.O_NOFOLLOW,
        0o600
      );
      witnessIdentity = fs.fstatSync(witnessDescriptor, { bigint: true });
      const witnessAtPath = fs.lstatSync(witnessPath, { bigint: true });
      const rootAfterWitness = inspectProofTemporaryHomeIdentity(identity);
      const rootHandleAfterWitness = fs.fstatSync(descriptor, { bigint: true });
      if (!witnessIdentity.isFile()
        || witnessIdentity.isSymbolicLink()
        || witnessIdentity.dev !== identity.dev
        || witnessIdentity.nlink !== 1n
        || (identity.uid != null && witnessIdentity.uid !== identity.uid)
        || !witnessAtPath.isFile()
        || witnessAtPath.isSymbolicLink()
        || witnessAtPath.dev !== witnessIdentity.dev
        || witnessAtPath.ino !== witnessIdentity.ino
        || rootAfterWitness.status !== "match"
        || !proofHomeStatMatchesIdentity(rootHandleAfterWitness, identity)) {
        return { ok: false };
      }
    }
    // Delegate recursive unlink semantics to Node core. In particular, do not
    // chmod or manually traverse gate-controlled descendants: static symlinks
    // are unlinked as links, while inaccessible trees fail before publication.
    fs.rmSync(identity.path, {
      recursive: true,
      force: false,
      maxRetries: PROOF_HOME_CLEANUP_ATTEMPTS - 1,
      retryDelay: PROOF_HOME_CLEANUP_RETRY_MS
    });
    const after = inspectProofTemporaryHomeIdentity(identity);
    if (after.status !== "missing") return { ok: false };
    if (descriptor != null) {
      const removed = fs.fstatSync(descriptor, { bigint: true });
      const removedWitness = fs.fstatSync(witnessDescriptor, { bigint: true });
      if (!proofHomeStatMatchesIdentity(removed, identity)
        || !removedWitness.isFile()
        || removedWitness.dev !== witnessIdentity.dev
        || removedWitness.ino !== witnessIdentity.ino
        || removedWitness.nlink !== 0n) {
        return { ok: false };
      }
      fs.closeSync(witnessDescriptor);
      witnessClosed = true;
      fs.closeSync(descriptor);
      descriptorClosed = true;
      PROOF_HOME_DIRECTORY_HANDLES.delete(identity);
    }
    ok = true;
    return { ok: true };
  } catch {
    return { ok: false };
  } finally {
    if (witnessDescriptor != null && !witnessClosed) {
      try { fs.closeSync(witnessDescriptor); } catch { ok = false; }
    }
    if (descriptor != null && !descriptorClosed) {
      try { fs.closeSync(descriptor); } catch { ok = false; }
      PROOF_HOME_DIRECTORY_HANDLES.delete(identity);
    }
    if (identity && typeof identity === "object") {
      PROOF_HOME_CLEANUP_RESULTS.set(identity, ok);
    }
  }
}

export function createProofExecutionContext() {
  assertProofProducerPlatform();
  const node = resolveProofNodeBinding();
  const npm = resolveTrustedNpmBinding(node);
  const git = trustedGitBinding();
  const pathEntries = uniqueAbsolutePaths([
    path.dirname(node.pathEntry.entryPath),
    path.dirname(node.executable.canonicalPath),
    path.dirname(npm.launcher.entryPath),
    path.dirname(git.canonicalPath)
  ]);
  const python = resolveProofPythonBinding(pathEntries);
  const toolchain = Object.freeze({ node, npm, git, python });
  assertProofToolchainIdentity(toolchain);
  const digest = proofToolchainDigest(toolchain);
  const temporaryBase = proofTemporaryBase();
  const createdProofHome = fs.mkdtempSync(path.join(temporaryBase, "grok-worker-proof-"));
  if (process.platform !== "win32") fs.chmodSync(createdProofHome, 0o700);
  let homeIdentity;
  try {
    homeIdentity = captureProofTemporaryHomeIdentity(createdProofHome);
  } catch (error) {
    try {
      fs.rmSync(createdProofHome, { recursive: true, force: true, maxRetries: 2 });
    } catch {
      // The caller still receives only the bounded proof-toolchain failure.
    }
    throw error;
  }
  const proofHome = homeIdentity.path;
  const environment = Object.freeze({
    ...baseProofEnvironment(pathEntries, proofHome),
    // PTY tests consume the already captured and digested interpreter by
    // absolute canonical path. Keep its directory out of PATH so a same-name
    // executable beside Node, npm, or Git cannot shadow the validated binding.
    GROK_PROOF_PYTHON: python.canonicalPath
  });
  let cleaned = false;
  return {
    toolchain,
    environment,
    digest,
    homeIdentity,
    cleanup() {
      if (cleaned) return { ok: true };
      const result = cleanupProofTemporaryHome(homeIdentity);
      if (result.ok) cleaned = true;
      return result;
    }
  };
}

export function proofInvocation(logical, args, context) {
  assertProofToolchainIdentity(context?.toolchain);
  if (logical === "node") {
    return { command: context.toolchain.node.executable.canonicalPath, args };
  }
  if (logical === "npm") {
    return {
      command: context.toolchain.node.executable.canonicalPath,
      args: [context.toolchain.npm.cli.canonicalPath, ...args]
    };
  }
  if (logical === "git") {
    return { command: context.toolchain.git.canonicalPath, args };
  }
  throw proofToolchainError();
}

export function sanitizeProofEnvironment(source = process.env, {
  pathEntries = [path.dirname(process.execPath)],
  proofHome = null
} = {}) {
  // The caller environment is deliberately ignored. In particular, PATH,
  // HOME/npm configuration, Git overrides, and shell selection are never
  // inherited into a proof command.
  void source;
  return baseProofEnvironment(pathEntries, proofHome);
}

export function runCommandCapture(command, args, {
  cwd = REPO_ROOT,
  env = process.env,
  timeout = 120000,
  proofContext = null
} = {}) {
  const startedAt = new Date().toISOString();
  if (proofContext) assertProofToolchainIdentity(proofContext.toolchain);
  const result = spawnSync(command, args, {
    cwd,
    env: proofContext?.environment || sanitizeProofEnvironment(env),
    encoding: "utf8",
    shell: false,
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const endedAt = new Date().toISOString();
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const redactedOutput = redactText(output);
  const secretOutputDetected = redactedOutput !== output;
  let failureKind = null;
  if (secretOutputDetected) failureKind = "secret_output";
  else if (result.error?.code === "ETIMEDOUT") failureKind = "timeout";
  else if (result.error?.code === "ENOBUFS") failureKind = "output_limit";
  else if (result.error) failureKind = "spawn_error";
  else if (result.signal) failureKind = "signal";
  else if (!Number.isInteger(result.status) || result.status !== 0) failureKind = "nonzero_exit";
  return {
    startedAt,
    endedAt,
    exitCode: Number.isInteger(result.status) ? result.status : null,
    outputDigest: sha256Text(redactedOutput),
    outcome: failureKind == null ? "pass" : "fail",
    failureKind,
    secretOutputDetected
  };
}
