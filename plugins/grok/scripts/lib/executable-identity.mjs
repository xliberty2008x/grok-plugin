import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { CompanionError } from "./errors.mjs";

const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const BUILD_COMMIT = /^[a-zA-Z0-9._-]{1,128}$/;
const CHANNEL = /^[a-zA-Z0-9._-]{1,64}$/;
const PACKAGE_NAME = /^@[a-z0-9._-]+\/[a-z0-9._-]+$/;
const PACKAGE_GIT_HEAD = /^[a-f0-9]{40}$/;
const PLATFORM = /^[a-z0-9._-]{1,32}$/;
const ARCH = /^[a-z0-9._-]{1,32}$/;
const RELEASE_SOURCE = "official-package-pin-v1";
const EXECUTABLE_ATTESTATION_KEYS = new Set([
  "schemaVersion",
  "identityDigest",
  "fileIdentityDigest",
  "pathDigest",
  "releaseIdentityDigest",
  "releaseSource",
  "packageName",
  "packageVersion",
  "packageGitHead",
  "packageIntegrityDigest",
  "platform",
  "arch",
  "version",
  "buildCommit",
  "channel",
  "size",
  "executableDigest"
]);

export const OFFICIAL_GROK_RELEASES = Object.freeze([
  Object.freeze({
    releaseSource: RELEASE_SOURCE,
    packageName: "@xai-official/grok",
    packageVersion: "0.2.111",
    packageGitHead: "94172f2aa4e5e2d2b39bc77b9c0b7306facd0160",
    packageIntegrityDigest:
      "78c7eb33add9066c4930aada0f61d09615bbcb2ed437dfd23b53ee049cc5f54b",
    platform: "darwin",
    arch: "arm64",
    version: "0.2.111",
    buildCommit: "94172f2aa4e5",
    channel: "stable",
    size: 128_899_632,
    executableDigest:
      "e1fafdfffe14f339460befaf194360e8f90bfd02efe8a4f24cfa1c7aea657ffe"
  })
]);

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalize(value[key])])
  );
}

function stableDigest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function exactRecord(value, keys) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key))
  );
}

function safeNumber(value, label) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      `Grok executable ${label} is outside the supported range.`
    );
  }
  return Number(value);
}

function statIdentity(stat) {
  return Object.freeze({
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    mode: safeNumber(stat.mode, "mode"),
    size: safeNumber(stat.size, "size"),
    mtimeMs: safeNumber(stat.mtimeMs, "mtime")
  });
}

function sameStatIdentity(left, right) {
  return left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function hashDescriptor(descriptor, size) {
  const digest = crypto.createHash("sha256");
  const chunk = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, Math.max(1, size)));
  let position = 0;
  while (position < size) {
    const length = fs.readSync(
      descriptor,
      chunk,
      0,
      Math.min(chunk.length, size - position),
      position
    );
    if (length < 1) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Grok executable became unreadable while its identity was captured."
      );
    }
    digest.update(chunk.subarray(0, length));
    position += length;
  }
  return digest.digest("hex");
}

function captureOpenFile(file, {
  noFollow = true,
  requireExecutable = true
} = {}) {
  let descriptor;
  try {
    const flags = fs.constants.O_RDONLY
      | (noFollow ? (fs.constants.O_NOFOLLOW || 0) : 0)
      | (fs.constants.O_CLOEXEC || 0);
    descriptor = fs.openSync(file, flags);
    const stat = fs.fstatSync(descriptor, { bigint: true });
    const identity = statIdentity(stat);
    if (!stat.isFile()
      || identity.size < 1
      || identity.size > MAX_EXECUTABLE_BYTES
      || (requireExecutable && (identity.mode & 0o111) === 0)) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Grok executable is not a bounded regular executable file."
      );
    }
    return Object.freeze({
      ...identity,
      executableDigest: hashDescriptor(descriptor, identity.size)
    });
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Grok executable identity could not be captured."
    );
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

/**
 * Capture one canonical, no-follow regular executable. The returned path is
 * private launch material; callers must persist only `attestation`.
 */
export function captureExecutableFileIdentity(binary) {
  let canonicalPath;
  try {
    canonicalPath = fs.realpathSync(path.resolve(binary));
  } catch {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Grok executable path could not be canonicalized."
    );
  }
  const before = fs.lstatSync(canonicalPath, { bigint: true });
  const beforeIdentity = statIdentity(before);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Canonical Grok executable is not a no-follow regular file."
    );
  }
  const captured = captureOpenFile(canonicalPath);
  const after = fs.lstatSync(canonicalPath, { bigint: true });
  const afterIdentity = statIdentity(after);
  if (!after.isFile()
    || after.isSymbolicLink()
    || !sameStatIdentity(beforeIdentity, captured)
    || !sameStatIdentity(captured, afterIdentity)) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Grok executable changed while its identity was captured."
    );
  }
  try {
    fs.accessSync(canonicalPath, fs.constants.X_OK);
  } catch {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Canonical Grok executable is not executable."
    );
  }
  return Object.freeze({
    canonicalPath,
    ...captured
  });
}

function releaseIdentityBody(release) {
  return {
    releaseSource: release.releaseSource,
    packageName: release.packageName,
    packageVersion: release.packageVersion,
    packageGitHead: release.packageGitHead,
    packageIntegrityDigest: release.packageIntegrityDigest,
    platform: release.platform,
    arch: release.arch,
    version: release.version,
    buildCommit: release.buildCommit,
    channel: release.channel,
    size: release.size,
    executableDigest: release.executableDigest
  };
}

function assertReleaseIdentity(release) {
  const body = releaseIdentityBody(release || {});
  if (body.releaseSource !== RELEASE_SOURCE
    || !PACKAGE_NAME.test(body.packageName || "")
    || !VERSION.test(body.packageVersion || "")
    || !PACKAGE_GIT_HEAD.test(body.packageGitHead || "")
    || !SHA256_HEX.test(body.packageIntegrityDigest || "")
    || !PLATFORM.test(body.platform || "")
    || !ARCH.test(body.arch || "")
    || !VERSION.test(body.version || "")
    || !BUILD_COMMIT.test(body.buildCommit || "")
    || !CHANNEL.test(body.channel || "")
    || !Number.isSafeInteger(body.size)
    || body.size < 1
    || body.size > MAX_EXECUTABLE_BYTES
    || !SHA256_HEX.test(body.executableDigest || "")) {
    throw new CompanionError(
      "E_GROK_VERSION",
      "Grok executable is not bound to a supported official package release."
    );
  }
  return Object.freeze(body);
}

function findOfficialRelease(fileIdentity, {
  platform = process.platform,
  arch = process.arch,
  releases = OFFICIAL_GROK_RELEASES
} = {}) {
  if (!Array.isArray(releases)) {
    throw new CompanionError(
      "E_GROK_VERSION",
      "Official Grok package release policy is unavailable."
    );
  }
  const matches = releases
    .map(assertReleaseIdentity)
    .filter((release) => (
      release.platform === platform
      && release.arch === arch
      && release.size === fileIdentity.size
      && release.executableDigest === fileIdentity.executableDigest
    ));
  if (matches.length !== 1) {
    throw new CompanionError(
      "E_GROK_VERSION",
      "Grok executable bytes do not match one supported official package pin."
    );
  }
  return matches[0];
}

function attestationWithoutIdentityDigest(attestation) {
  const { identityDigest: _identityDigest, ...body } = attestation;
  return body;
}

export function assertExecutableAttestation(attestation) {
  if (!exactRecord(attestation, EXECUTABLE_ATTESTATION_KEYS)
    || attestation.schemaVersion !== 1
    || !SHA256_HEX.test(attestation.identityDigest || "")
    || !SHA256_HEX.test(attestation.fileIdentityDigest || "")
    || !SHA256_HEX.test(attestation.pathDigest || "")
    || !SHA256_HEX.test(attestation.releaseIdentityDigest || "")
    || attestation.releaseSource !== RELEASE_SOURCE
    || !PACKAGE_NAME.test(attestation.packageName || "")
    || !VERSION.test(attestation.packageVersion || "")
    || !PACKAGE_GIT_HEAD.test(attestation.packageGitHead || "")
    || !SHA256_HEX.test(attestation.packageIntegrityDigest || "")
    || !PLATFORM.test(attestation.platform || "")
    || !ARCH.test(attestation.arch || "")
    || !VERSION.test(attestation.version || "")
    || !BUILD_COMMIT.test(attestation.buildCommit || "")
    || !CHANNEL.test(attestation.channel || "")
    || !Number.isSafeInteger(attestation.size)
    || attestation.size < 1
    || attestation.size > MAX_EXECUTABLE_BYTES
    || !SHA256_HEX.test(attestation.executableDigest || "")
    || attestation.releaseIdentityDigest !== stableDigest({
      releaseSource: attestation.releaseSource,
      packageName: attestation.packageName,
      packageVersion: attestation.packageVersion,
      packageGitHead: attestation.packageGitHead,
      packageIntegrityDigest: attestation.packageIntegrityDigest,
      platform: attestation.platform,
      arch: attestation.arch,
      version: attestation.version,
      buildCommit: attestation.buildCommit,
      channel: attestation.channel,
      size: attestation.size,
      executableDigest: attestation.executableDigest
    })
    || attestation.identityDigest !== stableDigest(
      attestationWithoutIdentityDigest(attestation)
    )) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Grok executable attestation is malformed or internally inconsistent."
    );
  }
  return attestation;
}

export function createExecutableAttestation(fileIdentity, releaseIdentity) {
  const release = assertReleaseIdentity(releaseIdentity);
  if (release.size !== fileIdentity.size
    || release.executableDigest !== fileIdentity.executableDigest) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Official package release does not match the captured executable bytes."
    );
  }
  const attestation = {
    schemaVersion: 1,
    identityDigest: null,
    fileIdentityDigest: stableDigest({
      device: fileIdentity.device,
      inode: fileIdentity.inode,
      mode: fileIdentity.mode,
      size: fileIdentity.size,
      executableDigest: fileIdentity.executableDigest
    }),
    pathDigest: stableDigest({ canonicalPath: fileIdentity.canonicalPath }),
    releaseIdentityDigest: stableDigest(release),
    ...release,
    size: fileIdentity.size,
    executableDigest: fileIdentity.executableDigest
  };
  attestation.identityDigest = stableDigest(
    attestationWithoutIdentityDigest(attestation)
  );
  assertExecutableAttestation(attestation);
  return Object.freeze(attestation);
}

function sameFileIdentity(left, right) {
  return left.canonicalPath === right.canonicalPath
    && sameStatIdentity(left, right)
    && left.executableDigest === right.executableDigest;
}

export function sameExecutableAttestation(left, right) {
  try {
    assertExecutableAttestation(left);
    assertExecutableAttestation(right);
  } catch {
    return false;
  }
  return left.identityDigest === right.identityDigest
    && stableDigest(left) === stableDigest(right);
}

/** Bind exact bytes to one code-owned official package release pin. */
export function captureGrokExecutableIdentity(binary, {
  platform = process.platform,
  arch = process.arch,
  releases = OFFICIAL_GROK_RELEASES
} = {}) {
  const before = captureExecutableFileIdentity(binary);
  const release = findOfficialRelease(before, { platform, arch, releases });
  const after = captureExecutableFileIdentity(before.canonicalPath);
  if (!sameFileIdentity(before, after)) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Grok executable changed during official package attestation."
    );
  }
  return Object.freeze({
    ...after,
    attestation: createExecutableAttestation(after, release)
  });
}

/**
 * Copy the pinned official bytes into a private broker-owned launch path.
 * The destination is rehashed after the copy; the mutable discovery path is
 * never executed by the worktree controller.
 */
export function materializePinnedGrokExecutable(binary, {
  directory,
  platform = process.platform,
  arch = process.arch,
  releases = OFFICIAL_GROK_RELEASES
} = {}) {
  if (typeof directory !== "string"
    || !path.isAbsolute(directory)
    || path.normalize(directory) !== directory) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Pinned Grok launch directory is malformed."
    );
  }
  let temporary = null;
  let destination = null;
  let published = false;
  try {
    fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
    const canonicalDirectory = fs.realpathSync(directory);
    const directoryStat = fs.lstatSync(canonicalDirectory);
    if (canonicalDirectory !== directory
      || !directoryStat.isDirectory()
      || directoryStat.isSymbolicLink()
      || (directoryStat.mode & 0o077) !== 0) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Pinned Grok launch directory is not a private real directory."
      );
    }

    const source = captureGrokExecutableIdentity(binary, {
      platform,
      arch,
      releases
    });
    const nonce = crypto.randomBytes(16).toString("hex");
    temporary = path.join(directory, `.grok-${nonce}.tmp`);
    destination = path.join(directory, `grok-${nonce}`);
    fs.copyFileSync(
      source.canonicalPath,
      temporary,
      fs.constants.COPYFILE_EXCL
    );
    fs.chmodSync(temporary, 0o500);
    const copied = captureGrokExecutableIdentity(temporary, {
      platform,
      arch,
      releases
    });
    if (copied.executableDigest !== source.executableDigest
      || copied.size !== source.size) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Private Grok launch copy changed from its official package pin."
      );
    }
    fs.renameSync(temporary, destination);
    published = true;
    const materialized = captureGrokExecutableIdentity(destination, {
      platform,
      arch,
      releases
    });
    if (materialized.executableDigest !== source.executableDigest
      || materialized.size !== source.size) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Published Grok launch copy changed from its official package pin."
      );
    }
    return materialized;
  } catch (error) {
    const candidate = published ? destination : temporary;
    if (candidate !== null) {
      try { fs.rmSync(candidate, { force: true }); } catch {}
    }
    try { fs.rmdirSync(directory); } catch {}
    throw error;
  }
}

function captureProcExecutable(pid, expected) {
  const procPath = `/proc/${pid}/exe`;
  let target;
  try {
    target = fs.readlinkSync(procPath);
  } catch {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Linux could not resolve the spawned Grok executable mapping."
    );
  }
  if (target.endsWith(" (deleted)")) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Spawned Grok executable was replaced or deleted."
    );
  }
  let canonicalTarget;
  try { canonicalTarget = fs.realpathSync(target); }
  catch {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Spawned Grok executable target is no longer canonical."
    );
  }
  const mapped = captureOpenFile(procPath, { noFollow: false });
  if (canonicalTarget !== expected.canonicalPath
    || !sameStatIdentity(mapped, expected)
    || mapped.executableDigest !== expected.executableDigest) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Linux spawned a different Grok executable than the durable intent."
    );
  }
}

function parseFirstDarwinTextMapping(output) {
  const lines = String(output || "").split(/\r?\n/);
  let record = null;
  for (const line of lines) {
    if (line === "ftxt") {
      if (record) break;
      record = {};
      continue;
    }
    if (!record || line.length < 2) continue;
    const field = line[0];
    const value = line.slice(1);
    if (field === "D") record.device = value;
    else if (field === "i") record.inode = value;
    else if (field === "s") record.size = value;
    else if (field === "n") record.name = value;
  }
  return record;
}

function canonicalDevice(value) {
  try { return BigInt(value).toString(); }
  catch {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "macOS returned an invalid executable device identity."
    );
  }
}

function captureDarwinExecutable(pid, expected, runLsof) {
  const run = runLsof(
    "/usr/sbin/lsof",
    ["-a", "-p", String(pid), "-d", "txt", "-FpfnDsi"],
    {
      encoding: "utf8",
      shell: false,
      timeout: 5_000,
      maxBuffer: 64 * 1024
    }
  );
  if (run?.status !== 0 || run?.error) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "macOS could not inspect the spawned Grok text mapping."
    );
  }
  const mapping = parseFirstDarwinTextMapping(run.stdout);
  const reopened = captureExecutableFileIdentity(expected.canonicalPath);
  if (!mapping
    || canonicalDevice(mapping.device) !== expected.device
    || mapping.inode !== expected.inode
    || mapping.size !== String(expected.size)
    || mapping.name !== expected.canonicalPath
    || !sameFileIdentity(reopened, expected)) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "macOS spawned a different Grok text mapping than the durable intent."
    );
  }
}

/**
 * Prove the kernel executable mapping after spawn. Only macOS and Linux have
 * a supported fail-closed implementation for this production boundary.
 */
export function attestSpawnedExecutable(pid, expected, {
  platform = process.platform,
  runLsof = spawnSync
} = {}) {
  if (!Number.isInteger(pid) || pid < 1
    || !expected
    || typeof expected.canonicalPath !== "string"
    || !sameExecutableAttestation(
      expected.attestation,
      createExecutableAttestation(expected, {
        releaseSource: expected.attestation?.releaseSource,
        packageName: expected.attestation?.packageName,
        packageVersion: expected.attestation?.packageVersion,
        packageGitHead: expected.attestation?.packageGitHead,
        packageIntegrityDigest:
          expected.attestation?.packageIntegrityDigest,
        platform: expected.attestation?.platform,
        arch: expected.attestation?.arch,
        version: expected.attestation?.version,
        buildCommit: expected.attestation?.buildCommit,
        channel: expected.attestation?.channel,
        size: expected.attestation?.size,
        executableDigest: expected.attestation?.executableDigest
      })
    )) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Spawned Grok executable attestation request is malformed."
    );
  }
  if (platform === "linux") captureProcExecutable(pid, expected);
  else if (platform === "darwin") {
    captureDarwinExecutable(pid, expected, runLsof);
  } else {
    throw new CompanionError(
      "E_CAPABILITY",
      "Spawned Grok executable attestation is unsupported on this platform."
    );
  }
  return expected.attestation;
}
