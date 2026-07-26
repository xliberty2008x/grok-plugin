import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CompanionError } from "./errors.mjs";
import {
  OFFICIAL_GROK_RELEASES,
  assertExecutableAttestation,
  captureGrokExecutableIdentity,
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
      "Provider launch binding is missing, malformed, or non-official."
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

function findNpmLauncherPackageRoot(candidate) {
  let current = path.dirname(candidate);
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = path.join(current, "package.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (parsed?.name === "@xai-official/grok") {
        return Object.freeze({
          root: current,
          version: typeof parsed.version === "string" ? parsed.version : null
        });
      }
    } catch {
      // Continue walking through npm prefix/symlink layouts.
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
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

  for (let index = 0; index < candidates.length && index < 32; index += 1) {
    const candidate = candidates[index];
    const packageRoot = findNpmLauncherPackageRoot(candidate);
    if (!packageRoot) continue;
    if (packageRoot.version) {
      pathExecutableCandidate(
        path.join(
          grokHome,
          "bin",
          platform === "win32"
            ? `grok-${packageRoot.version}.exe`
            : `grok-${packageRoot.version}`
        ),
        candidates
      );
    }
    pathExecutableCandidate(
      path.join(
        packageRoot.root,
        "..",
        `grok-${platform}-${arch}`,
        "bin",
        binaryName
      ),
      candidates
    );
  }

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
  throw new CompanionError(
    "E_GROK_NOT_FOUND",
    "Managed raw native Grok binary was not found. Install `@xai-official/grok`, then retry setup.",
    { discoveryFailures: failures.slice(0, 8) }
  );
}

function reattestPinnedBinary(binaryPath, expectedAttestation, {
  platform,
  arch,
  releases
}) {
  const captured = captureGrokExecutableIdentity(binaryPath, {
    platform,
    arch,
    releases
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
 * the discovered official release. Old immutable pins are retained so already
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
      if (resolved.executableIdentity.releaseIdentityDigest
        === discovered.attestation.releaseIdentityDigest) {
        return Object.freeze({
          binding: active,
          binary: resolved.binary,
          executableIdentity: resolved.executableIdentity,
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
  const materialized = materializePinnedGrokExecutable(discovered.canonicalPath, {
    directory: pinDirectory,
    platform,
    arch,
    releases
  });
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
  try {
    writePrivateJsonFile(recordFileFor(layout, pinRef), record);
    // Publish the path-free active reference only after the immutable record.
    writePrivateJsonFile(layout.activeBindingFile, binding);
  } catch (error) {
    removeNewPinArtifacts(layout, pinRef);
    throw error;
  }
  return Object.freeze({
    binding,
    binary: materialized.canonicalPath,
    executableIdentity: materialized.attestation,
    reused: false
  });
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
    { platform, arch, releases }
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
