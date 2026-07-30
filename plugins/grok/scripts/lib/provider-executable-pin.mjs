import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { CompanionError } from "./errors.mjs";
import {
  OFFICIAL_GROK_RELEASES,
  assertExecutableAttestation,
  captureGrokExecutableIdentity,
  createManagedObservedAttestation,
  executableReleaseRecognition,
  materializePinnedGrokExecutable,
  sameExecutableAttestation
} from "./executable-identity.mjs";
import { pluginDataRoot } from "./host.mjs";
import { readPrivateJsonFile, writePrivateJsonFile } from "./state.mjs";

export const PROVIDER_EXECUTABLE_PIN_SCHEMA_VERSION = 1;
export const PROVIDER_LAUNCH_BINDING_SCHEMA_VERSION = 1;

const PIN_ROOT_DIRECTORY = "provider-launch";
const PIN_RECORD_DIRECTORY = "records";
const PIN_BINARY_DIRECTORY = "pins";
const ACTIVE_BINDING_FILE = "active-provider-launch-binding-v1.json";
const PIN_REF = /^gpin-[0-9a-f]{32}$/;
const PIN_RECORD_FILE = /^gpin-[0-9a-f]{32}\.json$/;
const PIN_BINARY_FILE = /^grok-[0-9a-f]{32}(?:\.exe)?$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const MAX_PIN_RECORD_BYTES = 64 * 1024;
const MAX_GROK_CONFIG_BYTES = 64 * 1024;
const MAX_VERSION_OUTPUT_BYTES = 64 * 1024;
const STABLE_SEMVER =
  /^((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))$/;
const MIN_GROK_VERSION = Object.freeze([0n, 2n, 99n]);

const LAUNCH_BINDING_KEYS = new Set([
  "schemaVersion",
  "pinRef",
  "pinRecordDigest",
  "executableIdentityDigest",
  "releaseIdentityDigest"
]);

const PIN_RECORD_KEYS = new Set([
  "schemaVersion",
  "pinRef",
  "binaryPath",
  "executableIdentity",
  "createdAt",
  "pinRecordDigest"
]);

function canonicalize(value, stack = new Set()) {
  if (value === null || typeof value !== "object") return value;
  if (stack.has(value)) {
    throw new CompanionError("E_STATE", "Provider executable pin record is cyclic.");
  }
  stack.add(value);
  let normalized;
  if (Array.isArray(value)) {
    normalized = value.map((entry) => canonicalize(entry, stack));
  } else {
    normalized = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) normalized[key] = canonicalize(value[key], stack);
    }
  }
  stack.delete(value);
  return normalized;
}

function stableDigest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function exactKeys(value, keys) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key))
  );
}

function validIsoTimestamp(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function ensurePrivateDirectory(directory, { create = false, label } = {}) {
  if (create) {
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new CompanionError("E_STATE", `Could not create the ${label}.`);
    }
  }
  try {
    const canonical = fs.realpathSync(directory);
    const stat = fs.lstatSync(canonical);
    if (canonical !== directory
      || !stat.isDirectory()
      || stat.isSymbolicLink()) {
      throw new Error("unsafe directory");
    }
    if ((stat.mode & 0o077) !== 0) fs.chmodSync(canonical, 0o700);
    return canonical;
  } catch (error) {
    if (!create && error?.code === "ENOENT") return null;
    throw new CompanionError("E_STATE", `Refusing unsafe ${label}.`);
  }
}

function pinLayout(env, { create = false } = {}) {
  const configuredDataRoot = pluginDataRoot(env);
  if (create) {
    fs.mkdirSync(configuredDataRoot, { recursive: true, mode: 0o700 });
  }
  let resolvedDataRoot;
  try {
    resolvedDataRoot = fs.realpathSync(configuredDataRoot);
  } catch (error) {
    if (!create && error?.code === "ENOENT") return null;
    throw new CompanionError("E_STATE", "Could not resolve the private plugin data directory.");
  }
  const dataRoot = ensurePrivateDirectory(resolvedDataRoot, {
    create,
    label: "private plugin data directory"
  });
  if (!dataRoot) return null;
  const root = ensurePrivateDirectory(path.join(dataRoot, PIN_ROOT_DIRECTORY), {
    create,
    label: "provider executable pin root"
  });
  if (!root) return null;
  const records = ensurePrivateDirectory(path.join(root, PIN_RECORD_DIRECTORY), {
    create,
    label: "provider executable pin record directory"
  });
  const pins = ensurePrivateDirectory(path.join(root, PIN_BINARY_DIRECTORY), {
    create,
    label: "provider executable pin binary directory"
  });
  if (!records || !pins) return null;
  return Object.freeze({
    root,
    records,
    pins,
    activeBindingFile: path.join(root, ACTIVE_BINDING_FILE)
  });
}

function recordFileFor(layout, pinRef) {
  if (!PIN_REF.test(pinRef || "")) {
    throw new CompanionError("E_CAPABILITY", "Provider executable pin reference is malformed.");
  }
  const file = path.join(layout.records, `${pinRef}.json`);
  if (!PIN_RECORD_FILE.test(path.basename(file))) {
    throw new CompanionError("E_CAPABILITY", "Provider executable pin record path is malformed.");
  }
  return file;
}

function pinDirectoryFor(layout, pinRef) {
  if (!PIN_REF.test(pinRef || "")) {
    throw new CompanionError("E_CAPABILITY", "Provider executable pin reference is malformed.");
  }
  return path.join(layout.pins, pinRef);
}

function pinRecordWithoutDigest(record) {
  const { pinRecordDigest: _digest, ...body } = record;
  return body;
}

function publicBindingFromRecord(record) {
  return Object.freeze({
    schemaVersion: PROVIDER_LAUNCH_BINDING_SCHEMA_VERSION,
    pinRef: record.pinRef,
    pinRecordDigest: record.pinRecordDigest,
    executableIdentityDigest: record.executableIdentity.identityDigest,
    releaseIdentityDigest: record.executableIdentity.releaseIdentityDigest
  });
}

/** Fail-closed validation for the path-free, opaque public launch binding. */
export function assertProviderLaunchBinding(binding) {
  if (!exactKeys(binding, LAUNCH_BINDING_KEYS)
    || binding.schemaVersion !== PROVIDER_LAUNCH_BINDING_SCHEMA_VERSION
    || !PIN_REF.test(binding.pinRef || "")
    || !SHA256_HEX.test(binding.pinRecordDigest || "")
    || !SHA256_HEX.test(binding.executableIdentityDigest || "")
    || !SHA256_HEX.test(binding.releaseIdentityDigest || "")) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Provider launch binding is missing or malformed."
    );
  }
  return Object.freeze({ ...binding });
}

export function providerLaunchBindingDigest(binding) {
  return stableDigest(assertProviderLaunchBinding(binding));
}

function validatePrivatePinRecord(record, layout) {
  if (!exactKeys(record, PIN_RECORD_KEYS)
    || record.schemaVersion !== PROVIDER_EXECUTABLE_PIN_SCHEMA_VERSION
    || !PIN_REF.test(record.pinRef || "")
    || typeof record.binaryPath !== "string"
    || !path.isAbsolute(record.binaryPath)
    || path.normalize(record.binaryPath) !== record.binaryPath
    || !validIsoTimestamp(record.createdAt)
    || !SHA256_HEX.test(record.pinRecordDigest || "")
    || record.pinRecordDigest !== stableDigest(pinRecordWithoutDigest(record))) {
    throw new CompanionError("E_STATE", "Provider executable pin record is malformed.");
  }
  assertExecutableAttestation(record.executableIdentity);
  const expectedDirectory = pinDirectoryFor(layout, record.pinRef);
  if (path.dirname(record.binaryPath) !== expectedDirectory
    || !PIN_BINARY_FILE.test(path.basename(record.binaryPath))) {
    throw new CompanionError("E_STATE", "Provider executable pin record escaped its private directory.");
  }
  try {
    const directoryStat = fs.lstatSync(expectedDirectory);
    const binaryStat = fs.lstatSync(record.binaryPath);
    if (!directoryStat.isDirectory()
      || directoryStat.isSymbolicLink()
      || fs.realpathSync(expectedDirectory) !== expectedDirectory
      || (directoryStat.mode & 0o077) !== 0
      || !binaryStat.isFile()
      || binaryStat.isSymbolicLink()
      || fs.realpathSync(record.binaryPath) !== record.binaryPath
      || (binaryStat.mode & 0o077) !== 0
      || (binaryStat.mode & 0o111) === 0) {
      throw new Error("unsafe pin");
    }
  } catch {
    throw new CompanionError("E_STATE", "Provider executable pin is missing or unsafe.");
  }
  return Object.freeze({ ...record });
}

function pathExecutableCandidate(value, candidates) {
  if (typeof value !== "string" || !value) return;
  try {
    const canonical = fs.realpathSync(path.resolve(value));
    const stat = fs.statSync(canonical);
    fs.accessSync(canonical, fs.constants.X_OK);
    if (stat.isFile() && !candidates.includes(canonical)) candidates.push(canonical);
  } catch {
    // Discovery is fail-closed after all bounded candidates are inspected.
  }
}

function executableOnPath(name, env, platform) {
  const pathValue = typeof env.PATH === "string" ? env.PATH : "";
  if (!pathValue) return [];
  const extensions = platform === "win32"
    ? String(env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
        .split(";")
        .filter(Boolean)
    : [""];
  const matches = [];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.resolve(directory, `${name}${extension}`);
      if (fs.existsSync(candidate)) matches.push(candidate);
    }
  }
  return matches;
}

function grokInstaller(grokHome) {
  const configFile = path.join(grokHome, "config.toml");
  let source;
  let before;
  let after;
  try {
    before = fs.lstatSync(configFile);
    if (!before.isFile()
      || before.isSymbolicLink()
      || before.size < 1
      || before.size > MAX_GROK_CONFIG_BYTES
      || (before.mode & 0o022) !== 0
      || (typeof process.getuid === "function" && before.uid !== process.getuid())
      || fs.realpathSync(configFile) !== configFile) {
      throw new Error("unsafe config");
    }
    source = fs.readFileSync(configFile, "utf8");
    after = fs.lstatSync(configFile);
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.mode !== after.mode
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs) {
      throw new Error("config changed");
    }
  } catch {
    throw new CompanionError(
      "E_GROK_SOURCE",
      "The active Grok installation has no bounded canonical cli.installer setting."
    );
  }
  let inCli = false;
  let installer = null;
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*\[cli\]\s*(?:#.*)?$/.test(line)) {
      inCli = true;
      continue;
    }
    if (/^\s*\[[^\]]+\]/.test(line)) {
      inCli = false;
      continue;
    }
    if (!inCli) continue;
    const match = line.match(/^\s*installer\s*=\s*"(internal|npm)"\s*(?:#.*)?$/);
    if (!match) continue;
    if (installer !== null) {
      throw new CompanionError(
        "E_GROK_SOURCE",
        "The active Grok installation has an ambiguous cli.installer setting."
      );
    }
    installer = match[1];
  }
  if (!installer) {
    throw new CompanionError(
      "E_GROK_SOURCE",
      "The active Grok installation does not declare cli.installer."
    );
  }
  return Object.freeze({
    installer,
    contentDigest: stableDigest({ source }),
    identityDigest: stableDigest({
      device: String(after.dev),
      inode: String(after.ino),
      mode: after.mode,
      size: after.size,
      mtimeMs: after.mtimeMs
    })
  });
}

function semverAtLeastFloor(version) {
  const match = String(version || "").match(STABLE_SEMVER);
  if (!match) {
    throw new CompanionError(
      "E_GROK_VERSION",
      "The active managed Grok filename does not contain a stable semantic version."
    );
  }
  const parts = match.slice(1).map(BigInt);
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] > MIN_GROK_VERSION[index]) return version;
    if (parts[index] < MIN_GROK_VERSION[index]) {
      throw new CompanionError(
        "E_GROK_VERSION",
        `Grok ${version} is too old; 0.2.99 or newer is required.`
      );
    }
  }
  return version;
}

function donorPlatformName(platform) {
  if (platform === "darwin") return "macos";
  return platform;
}

function donorArchitectureName(arch) {
  if (arch === "arm64") return "aarch64";
  if (arch === "x64") return "x86_64";
  return arch;
}

function managedDirectoryIdentity(directory, label) {
  try {
    const canonical = fs.realpathSync(directory);
    const stat = fs.lstatSync(canonical);
    const currentUid = typeof process.getuid === "function"
      ? process.getuid()
      : null;
    if (canonical !== directory
      || !stat.isDirectory()
      || stat.isSymbolicLink()
      || (stat.mode & 0o022) !== 0
      || (currentUid !== null && stat.uid !== currentUid)) {
      throw new Error("unsafe managed directory");
    }
    return stableDigest({
      device: String(stat.dev),
      inode: String(stat.ino),
      mode: stat.mode,
      uid: currentUid === null ? null : stat.uid,
      mtimeMs: stat.mtimeMs
    });
  } catch {
    throw new CompanionError(
      "E_GROK_SOURCE",
      `The active Grok ${label} has unsafe ownership, permissions, or indirection.`
    );
  }
}

function managedInstallation({
  grokHome,
  platform,
  arch
}) {
  let canonicalHome;
  try {
    canonicalHome = fs.realpathSync(path.resolve(grokHome));
  } catch {
    return null;
  }
  const binaryName = platform === "win32" ? "grok.exe" : "grok";
  const binDirectory = path.join(canonicalHome, "bin");
  const activePath = path.join(binDirectory, binaryName);
  let target;
  let linkIdentity;
  let rawTarget;
  let link;
  try {
    link = fs.lstatSync(activePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new CompanionError(
      "E_GROK_SOURCE",
      "The active Grok managed link could not be inspected."
    );
  }
  const homeIdentity = managedDirectoryIdentity(
    canonicalHome,
    "managed home"
  );
  const binIdentity = managedDirectoryIdentity(
    binDirectory,
    "managed bin directory"
  );
  if (!link.isSymbolicLink()) {
    throw new CompanionError(
      "E_GROK_SOURCE",
      "The active Grok path is not a managed symbolic link."
    );
  }
  const currentUid = typeof process.getuid === "function"
    ? process.getuid()
    : null;
  if (currentUid !== null && link.uid !== currentUid) {
    throw new CompanionError(
      "E_GROK_SOURCE",
      "The active Grok managed link is not owned by the current user."
    );
  }
  try {
    rawTarget = fs.readlinkSync(activePath);
    target = fs.realpathSync(activePath);
    const afterLink = fs.lstatSync(activePath);
    if (link.dev !== afterLink.dev
      || link.ino !== afterLink.ino
      || link.mode !== afterLink.mode
      || link.size !== afterLink.size
      || link.mtimeMs !== afterLink.mtimeMs
      || rawTarget !== fs.readlinkSync(activePath)) {
      throw new Error("managed link changed");
    }
    linkIdentity = stableDigest({
      device: String(afterLink.dev),
      inode: String(afterLink.ino),
      mode: afterLink.mode,
      size: afterLink.size,
      mtimeMs: afterLink.mtimeMs,
      rawTarget
    });
  } catch {
    throw new CompanionError(
      "E_GROK_SOURCE",
      "The active Grok managed link is stale or unstable."
    );
  }
  const installerRecord = grokInstaller(canonicalHome);
  const { installer } = installerRecord;
  const targetName = path.basename(target);
  let versionText;
  let expectedDirectory;
  if (installer === "internal") {
    const suffix = `-${donorPlatformName(platform)}-${donorArchitectureName(arch)}`;
    if (!targetName.startsWith("grok-") || !targetName.endsWith(suffix)) {
      throw new CompanionError(
        "E_GROK_VERSION",
        "The active internal Grok target has a malformed versioned filename."
      );
    }
    versionText = targetName.slice("grok-".length, -suffix.length);
    expectedDirectory = path.join(canonicalHome, "downloads");
  } else {
    const suffix = platform === "win32" ? ".exe" : "";
    if (!targetName.startsWith("grok-") || !targetName.endsWith(suffix)) {
      throw new CompanionError(
        "E_GROK_VERSION",
        "The active npm Grok target has a malformed versioned filename."
      );
    }
    versionText = targetName.slice("grok-".length, suffix ? -suffix.length : undefined);
    expectedDirectory = path.join(canonicalHome, "bin");
  }
  const version = semverAtLeastFloor(versionText);
  let canonicalDirectory;
  try {
    canonicalDirectory = fs.realpathSync(expectedDirectory);
  } catch {
    throw new CompanionError(
      "E_GROK_SOURCE",
      "The active Grok target is outside its declared installer layout."
    );
  }
  const targetDirectoryIdentity = managedDirectoryIdentity(
    expectedDirectory,
    "managed target directory"
  );
  if (path.dirname(target) !== canonicalDirectory) {
    throw new CompanionError(
      "E_GROK_SOURCE",
      "The active Grok target escaped its declared installer layout."
    );
  }
  let targetStat;
  try {
    targetStat = fs.lstatSync(target);
    fs.accessSync(target, fs.constants.X_OK);
  } catch {
    throw new CompanionError(
      "E_GROK_SOURCE",
      "The active managed Grok target is missing or unreadable."
    );
  }
  if (!targetStat.isFile()
    || targetStat.isSymbolicLink()
    || (targetStat.mode & 0o111) === 0
    || (targetStat.mode & 0o022) !== 0
    || (currentUid !== null && targetStat.uid !== currentUid)) {
    throw new CompanionError(
      "E_GROK_SOURCE",
      "The active managed Grok target has unsafe ownership or permissions."
    );
  }
  const targetIdentity = stableDigest({
    device: String(targetStat.dev),
    inode: String(targetStat.ino),
    mode: targetStat.mode,
    uid: currentUid === null ? null : targetStat.uid,
    size: targetStat.size,
    mtimeMs: targetStat.mtimeMs
  });
  return Object.freeze({
    canonicalPath: target,
    release: Object.freeze({
      releaseRecognition: "managed-observed",
      releaseSource: "managed-observed-v1",
      sourceProvenanceDigest: stableDigest({
        schemaVersion: 1,
        installer,
        configDigest: installerRecord.contentDigest,
        targetName,
        platform,
        arch,
        version
      }),
      platform,
      arch,
      version,
      buildCommit: "unobserved",
      channel: "stable"
    }),
    observationDigest: stableDigest({
      homeIdentity,
      binIdentity,
      targetDirectoryIdentity,
      targetIdentity,
      installerIdentityDigest: installerRecord.identityDigest,
      installerContentDigest: installerRecord.contentDigest,
      linkIdentity,
      target
    })
  });
}

/**
 * Discover the managed raw native Grok binary without executing an npm shim.
 * GROK_BIN/PATH/GROK_HOME are setup-only discovery inputs.
 */
export function discoverManagedRawGrokExecutable({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  releases = OFFICIAL_GROK_RELEASES,
  sourceBinary = null
} = {}) {
  const binaryName = platform === "win32" ? "grok.exe" : "grok";
  const home = env.HOME || os.homedir();
  const grokHome = env.GROK_HOME || path.join(home, ".grok");
  const candidates = [];
  pathExecutableCandidate(sourceBinary, candidates);
  pathExecutableCandidate(env.GROK_BIN, candidates);
  for (const candidate of executableOnPath("grok", env, platform)) {
    pathExecutableCandidate(candidate, candidates);
  }
  pathExecutableCandidate(path.join(grokHome, "bin", binaryName), candidates);

  const failures = [];
  for (const candidate of candidates.slice(0, 32)) {
    try {
      return captureGrokExecutableIdentity(candidate, {
        platform,
        arch,
        releases
      });
    } catch (error) {
      failures.push(error?.code || "E_PROCESS_IDENTITY");
    }
  }
  const managed = managedInstallation({ grokHome, platform, arch });
  if (managed) {
    const captured = captureGrokExecutableIdentity(managed.canonicalPath, {
      platform,
      arch,
      releases,
      managedRelease: managed.release
    });
    let afterManaged;
    try {
      afterManaged = managedInstallation({ grokHome, platform, arch });
    } catch {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "The active managed Grok source changed while it was captured."
      );
    }
    if (!afterManaged
      || afterManaged.canonicalPath !== managed.canonicalPath
      || afterManaged.observationDigest !== managed.observationDigest
      || afterManaged.release.sourceProvenanceDigest
        !== managed.release.sourceProvenanceDigest) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "The active managed Grok source changed while it was captured."
      );
    }
    return captured;
  }
  if (candidates.length) {
    throw new CompanionError(
      "E_GROK_SOURCE",
      "Found Grok executable candidates, but none are a known digest or the active managed installation.",
      { discoveryFailures: failures.slice(0, 8) }
    );
  }
  throw new CompanionError(
    "E_GROK_NOT_FOUND",
    "Grok executable was not found. Install `@xai-official/grok`, then retry setup.",
    { discoveryFailures: failures.slice(0, 8) }
  );
}

function reattestPinnedBinary(binaryPath, expectedAttestation, {
  platform,
  arch
}) {
  const captured = captureGrokExecutableIdentity(binaryPath, {
    platform,
    arch,
    expectedAttestation
  });
  if (!sameExecutableAttestation(captured.attestation, expectedAttestation)) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Pinned Grok executable no longer matches its exact durable identity."
    );
  }
  return captured;
}

function removeNewPinArtifacts(layout, pinRef) {
  try { fs.rmSync(recordFileFor(layout, pinRef), { force: true }); } catch {}
  try {
    fs.rmSync(pinDirectoryFor(layout, pinRef), { recursive: true, force: true });
  } catch {}
}

function managedVersionEnvironment(env) {
  const allowed = [
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "PATH",
    "SystemRoot",
    "ComSpec",
    "PATHEXT"
  ];
  const child = {};
  for (const key of allowed) {
    if (typeof env[key] === "string") child[key] = env[key];
  }
  child.GROK_COMPANION_CHILD = "1";
  return child;
}

function finalizeManagedPinnedAttestation(materialized, env) {
  if (materialized.attestation.schemaVersion !== 2) return materialized;
  const run = spawnSync(materialized.canonicalPath, ["--version"], {
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
    maxBuffer: MAX_VERSION_OUTPUT_BYTES,
    env: managedVersionEnvironment(env)
  });
  const output = `${run.stdout || ""} ${run.stderr || ""}`.trim();
  const versionMatch = output.match(
    /(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=$|\s)/
  );
  if (run.status !== 0
    || run.error
    || !versionMatch
    || versionMatch[1] !== materialized.attestation.version) {
    throw new CompanionError(
      "E_GROK_VERSION",
      "The private managed Grok copy did not report its filename-bound stable version."
    );
  }
  const buildMatch = output.match(/\(([a-zA-Z0-9._-]{1,128})\)/);
  const channelMatch = output.match(/\[([a-zA-Z0-9._-]{1,64})\]/);
  if (!buildMatch || channelMatch?.[1] !== "stable") {
    throw new CompanionError(
      "E_GROK_VERSION",
      "The private managed Grok copy did not report a build identity on the stable channel."
    );
  }
  const channel = channelMatch[1];
  const prior = materialized.attestation;
  const attestation = createManagedObservedAttestation(materialized, {
    releaseRecognition: prior.releaseRecognition,
    releaseSource: prior.releaseSource,
    sourceProvenanceDigest: prior.sourceProvenanceDigest,
    platform: prior.platform,
    arch: prior.arch,
    version: prior.version,
    buildCommit: buildMatch[1],
    channel,
    size: prior.size,
    executableDigest: prior.executableDigest
  });
  return Object.freeze({
    ...materialized,
    attestation
  });
}

function sameDiscoveredRelease(discovered, pinned) {
  if (discovered.schemaVersion !== pinned.schemaVersion) return false;
  if (discovered.schemaVersion === 1) {
    return discovered.releaseIdentityDigest === pinned.releaseIdentityDigest;
  }
  return discovered.releaseRecognition === pinned.releaseRecognition
    && discovered.releaseSource === pinned.releaseSource
    && discovered.sourceProvenanceDigest === pinned.sourceProvenanceDigest
    && discovered.platform === pinned.platform
    && discovered.arch === pinned.arch
    && discovered.version === pinned.version
    && discovered.channel === pinned.channel
    && discovered.size === pinned.size
    && discovered.executableDigest === pinned.executableDigest;
}

function readPinRecord(layout, pinRef) {
  const record = readPrivateJsonFile(recordFileFor(layout, pinRef), {
    missing: null,
    maxBytes: MAX_PIN_RECORD_BYTES,
    label: "provider executable pin"
  });
  if (!record) {
    throw new CompanionError("E_CAPABILITY", "Provider executable pin is missing; run setup.");
  }
  return validatePrivatePinRecord(record, layout);
}

function readActiveBinding(layout) {
  const binding = readPrivateJsonFile(layout.activeBindingFile, {
    missing: null,
    maxBytes: MAX_PIN_RECORD_BYTES,
    label: "active provider launch binding"
  });
  return binding ? assertProviderLaunchBinding(binding) : null;
}

/**
 * Setup-owned publication. A valid active pin is reused only when it matches
 * the discovered release identity. Old immutable pins are retained so already
 * admitted jobs remain launchable after a later setup rotation.
 */
export function publishProviderExecutablePin({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  releases = OFFICIAL_GROK_RELEASES,
  sourceBinary = null,
  clock = () => Date.now()
} = {}) {
  const layout = pinLayout(env, { create: true });
  const discovered = discoverManagedRawGrokExecutable({
    env,
    platform,
    arch,
    releases,
    sourceBinary
  });
  let active = null;
  try {
    active = readActiveBinding(layout);
    if (active) {
      const resolved = resolveProviderExecutablePin(active, {
        env,
        platform,
        arch,
        releases
      });
      if (sameDiscoveredRelease(
        discovered.attestation,
        resolved.executableIdentity
      )) {
        return Object.freeze({
          binding: active,
          binary: resolved.binary,
          executableIdentity: resolved.executableIdentity,
          releaseRecognition: executableReleaseRecognition(
            resolved.executableIdentity
          ),
          reused: true
        });
      }
    }
  } catch {
    active = null;
  }

  const observedAt = Number(clock());
  if (!Number.isFinite(observedAt)) {
    throw new CompanionError("E_STATE", "Provider executable pin clock is invalid.");
  }
  const pinRef = `gpin-${crypto.randomBytes(16).toString("hex")}`;
  const pinDirectory = pinDirectoryFor(layout, pinRef);
  try {
    const copied = materializePinnedGrokExecutable(discovered.canonicalPath, {
      directory: pinDirectory,
      platform,
      arch,
      releases,
      sourceIdentity: discovered
    });
    const materialized = finalizeManagedPinnedAttestation(copied, env);
    const body = {
      schemaVersion: PROVIDER_EXECUTABLE_PIN_SCHEMA_VERSION,
      pinRef,
      binaryPath: materialized.canonicalPath,
      executableIdentity: materialized.attestation,
      createdAt: new Date(observedAt).toISOString()
    };
    const record = Object.freeze({
      ...body,
      pinRecordDigest: stableDigest(body)
    });
    const binding = publicBindingFromRecord(record);
    writePrivateJsonFile(recordFileFor(layout, pinRef), record);
    // Publish the path-free active reference only after the immutable record.
    writePrivateJsonFile(layout.activeBindingFile, binding);
    return Object.freeze({
      binding,
      binary: materialized.canonicalPath,
      executableIdentity: materialized.attestation,
      releaseRecognition: executableReleaseRecognition(
        materialized.attestation
      ),
      reused: false
    });
  } catch (error) {
    removeNewPinArtifacts(layout, pinRef);
    throw error;
  }
}

/**
 * Revoke only the active setup reference. Immutable historical pins are not
 * garbage-collected here because durable jobs may still reference them.
 */
export function clearProviderExecutablePin({ env = process.env } = {}) {
  const layout = pinLayout(env);
  if (!layout) return false;
  try {
    fs.unlinkSync(layout.activeBindingFile);
    if (process.platform !== "win32") {
      let descriptor;
      try {
        descriptor = fs.openSync(layout.root, fs.constants.O_RDONLY);
        fs.fsyncSync(descriptor);
      } finally {
        if (descriptor != null) fs.closeSync(descriptor);
      }
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new CompanionError("E_STATE", "Could not invalidate the active provider executable pin.");
  }
}

/**
 * Resolve one opaque binding and re-attest the exact private binary. This path
 * never consults GROK_BIN, PATH, GROK_HOME, or any other discovery input.
 */
export function resolveProviderExecutablePin(binding, {
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  releases = OFFICIAL_GROK_RELEASES
} = {}) {
  const expected = assertProviderLaunchBinding(binding);
  const layout = pinLayout(env);
  if (!layout) {
    throw new CompanionError("E_CAPABILITY", "Provider executable pin is missing; run setup.");
  }
  let record;
  try {
    record = readPinRecord(layout, expected.pinRef);
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    throw new CompanionError(
      "E_CAPABILITY",
      "Provider executable pin is missing, tampered, or unreadable."
    );
  }
  if (record.pinRecordDigest !== expected.pinRecordDigest
    || record.executableIdentity.identityDigest !== expected.executableIdentityDigest
    || record.executableIdentity.releaseIdentityDigest !== expected.releaseIdentityDigest) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Provider executable pin does not match the durable launch binding."
    );
  }
  const reattested = reattestPinnedBinary(
    record.binaryPath,
    record.executableIdentity,
    { platform, arch }
  );
  if (reattested.attestation.identityDigest !== expected.executableIdentityDigest
    || reattested.attestation.releaseIdentityDigest !== expected.releaseIdentityDigest) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Provider executable pin re-attestation failed before launch."
    );
  }
  return Object.freeze({
    binding: expected,
    binary: reattested.canonicalPath,
    executableIdentity: reattested.attestation,
    fileIdentity: reattested
  });
}

/** Read the active path-free binding without ambient executable discovery. */
export function readActiveProviderLaunchBinding({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  releases = OFFICIAL_GROK_RELEASES
} = {}) {
  try {
    const layout = pinLayout(env);
    if (!layout) return null;
    const binding = readActiveBinding(layout);
    if (!binding) return null;
    resolveProviderExecutablePin(binding, { env, platform, arch, releases });
    return binding;
  } catch {
    return null;
  }
}
