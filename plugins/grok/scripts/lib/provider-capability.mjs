import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CompanionError } from "./errors.mjs";
import { assertExecutableAttestation } from "./executable-identity.mjs";
import { grokVersion } from "./provider-core.mjs";
import { pluginDataRoot } from "./host.mjs";
import { profileFor } from "./profiles.mjs";
import {
  assertProviderLaunchBinding,
  providerLaunchBindingDigest,
  resolveProviderExecutablePin
} from "./provider-executable-pin.mjs";
import { readPrivateJsonFile, writePrivateJsonFile } from "./state.mjs";

export const ROOT_READ_PROVIDER_CAPABILITY = "root-read-spawn-v1";
export const SAME_SESSION_READ_FOLLOWUP_PROVIDER_CAPABILITY =
  "same-session-read-followup-v1";
export const ORDERED_TURN_BOUNDARY_MAILBOX_PROVIDER_CAPABILITY =
  "ordered-turn-boundary-mailbox-v1";
export const PROVIDER_CAPABILITY_SCHEMA_VERSION = 2;
export const PROVIDER_CAPABILITY_TTL_MS = 12 * 60 * 60 * 1000;
export const MCP_CAPABILITY_CONTRACT_VERSION = "1.3.0";

const MAX_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLUGIN_MANIFEST = path.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json");
const SETUP_PROFILE = path.join(PLUGIN_ROOT, "provider-agents", "setup-probe.md");
const RECEIPT_DIRECTORY = "capabilities";
const RECEIPT_FILE = "provider-capability-v2.json";
const LEGACY_RECEIPT_FILE = "provider-capability-v1.json";

const RECEIPT_KEYS = new Set([
  "schemaVersion",
  "receiptType",
  "pluginVersion",
  "mcpCapabilityContractVersion",
  "platform",
  "architecture",
  "providerVersion",
  "providerLaunchBinding",
  "providerLaunchBindingDigest",
  "acpProtocolVersion",
  "loadSession",
  "setupProfileDigest",
  "rootReadProfileDigest",
  "capabilities",
  "issuedAt",
  "expiresAt",
  "capabilityDigest",
  "receiptDigest"
]);

function canonicalize(value, stack = new Set()) {
  if (value === null || typeof value !== "object") return value;
  if (stack.has(value)) throw new CompanionError("E_STATE", "Provider capability receipt is cyclic.");
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

function currentPluginVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST, "utf8"));
    if (typeof manifest.version !== "string" || !manifest.version || manifest.version.length > 128) {
      throw new Error("invalid version");
    }
    return manifest.version;
  } catch {
    throw new CompanionError("E_STATE", "Could not resolve the installed Grok plugin version.");
  }
}

function currentSetupProfileDigest() {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(SETUP_PROFILE)).digest("hex");
  } catch {
    throw new CompanionError("E_STATE", "Could not resolve the installed provider setup profile.");
  }
}

function safeCapabilityDirectory(env, { create = false } = {}) {
  const configured = pluginDataRoot(env);
  if (create) fs.mkdirSync(configured, { recursive: true, mode: 0o700 });
  let dataRoot;
  try {
    dataRoot = fs.realpathSync(configured);
  } catch (error) {
    if (!create && error?.code === "ENOENT") return null;
    throw new CompanionError("E_STATE", "Could not resolve the private plugin data directory.");
  }
  const rootStat = fs.lstatSync(dataRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new CompanionError("E_STATE", "Refusing unsafe private plugin data directory.");
  }
  if ((rootStat.mode & 0o077) !== 0) fs.chmodSync(dataRoot, 0o700);

  const directory = path.join(dataRoot, RECEIPT_DIRECTORY);
  if (create) {
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
  }
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
      throw new CompanionError("E_STATE", "Refusing unsafe provider capability directory.");
    }
    if ((stat.mode & 0o077) !== 0) fs.chmodSync(directory, 0o700);
    return directory;
  } catch (error) {
    if (!create && error?.code === "ENOENT") return null;
    if (error instanceof CompanionError) throw error;
    throw new CompanionError("E_STATE", "Could not resolve the provider capability directory.");
  }
}

function capabilityReceiptPath(env, options = {}) {
  const directory = safeCapabilityDirectory(env, options);
  return directory ? path.join(directory, RECEIPT_FILE) : null;
}

function stableCapabilityBody({
  pluginVersion,
  mcpCapabilityContractVersion,
  platform,
  architecture,
  providerVersion,
  providerLaunchBinding,
  providerLaunchBindingDigest: launchBindingDigest,
  acpProtocolVersion,
  loadSession,
  setupProfileDigest,
  rootReadProfileDigest
}) {
  return {
    schemaVersion: PROVIDER_CAPABILITY_SCHEMA_VERSION,
    receiptType: "grok-provider-capability",
    pluginVersion,
    mcpCapabilityContractVersion,
    platform,
    architecture,
    providerVersion,
    providerLaunchBinding: assertProviderLaunchBinding(providerLaunchBinding),
    providerLaunchBindingDigest: launchBindingDigest,
    acpProtocolVersion,
    loadSession,
    setupProfileDigest,
    rootReadProfileDigest,
    capabilities: [
      ROOT_READ_PROVIDER_CAPABILITY,
      SAME_SESSION_READ_FOLLOWUP_PROVIDER_CAPABILITY,
      ORDERED_TURN_BOUNDARY_MAILBOX_PROVIDER_CAPABILITY
    ]
  };
}

function receiptWithoutDigest(receipt) {
  const { receiptDigest: _receiptDigest, ...body } = receipt;
  return body;
}

function validateReceiptShape(receipt) {
  if (!exactKeys(receipt, RECEIPT_KEYS)
    || receipt.schemaVersion !== PROVIDER_CAPABILITY_SCHEMA_VERSION
    || receipt.receiptType !== "grok-provider-capability"
    || typeof receipt.pluginVersion !== "string"
    || typeof receipt.mcpCapabilityContractVersion !== "string"
    || typeof receipt.platform !== "string"
    || typeof receipt.architecture !== "string"
    || typeof receipt.providerVersion !== "string"
    || !SHA256_HEX.test(receipt.providerLaunchBindingDigest || "")
    || receipt.acpProtocolVersion !== 1
    || receipt.loadSession !== true
    || !SHA256_HEX.test(receipt.setupProfileDigest || "")
    || !SHA256_HEX.test(receipt.rootReadProfileDigest || "")
    || !Array.isArray(receipt.capabilities)
    || receipt.capabilities.length !== 3
    || receipt.capabilities[0] !== ROOT_READ_PROVIDER_CAPABILITY
    || receipt.capabilities[1] !== SAME_SESSION_READ_FOLLOWUP_PROVIDER_CAPABILITY
    || receipt.capabilities[2] !== ORDERED_TURN_BOUNDARY_MAILBOX_PROVIDER_CAPABILITY
    || !validIsoTimestamp(receipt.issuedAt)
    || !validIsoTimestamp(receipt.expiresAt)
    || !SHA256_HEX.test(receipt.capabilityDigest || "")
    || !SHA256_HEX.test(receipt.receiptDigest || "")) {
    return false;
  }
  try {
    const binding = assertProviderLaunchBinding(receipt.providerLaunchBinding);
    if (providerLaunchBindingDigest(binding) !== receipt.providerLaunchBindingDigest) {
      return false;
    }
  } catch {
    return false;
  }
  const issuedAt = Date.parse(receipt.issuedAt);
  const expiresAt = Date.parse(receipt.expiresAt);
  return expiresAt > issuedAt && expiresAt - issuedAt <= MAX_RECEIPT_TTL_MS;
}

/**
 * Publish one schema-v2 capability receipt bound to a setup-owned opaque pin.
 * The pin record must already be published; failed setup leaves no active receipt.
 */
export function writeProviderCapabilityReceipt({
  runtime,
  providerLaunchBinding,
  env = process.env,
  clock = () => Date.now(),
  ttlMs = PROVIDER_CAPABILITY_TTL_MS,
  releases = undefined
} = {}) {
  const binding = assertProviderLaunchBinding(providerLaunchBinding);
  if (!runtime
    || runtime.authenticated !== true
    || runtime.protocolVersion !== 1
    || runtime.loadSession !== true
    || typeof runtime.binary !== "string"
    || typeof runtime.version !== "string"
    || !SHA256_HEX.test(runtime.acpIsolation?.agentProfileDigest || "")
    || runtime.acpIsolation?.isolated !== true
    || runtime.acpIsolation?.unattendedPrivilegeExpansion !== false
    || !Number.isSafeInteger(ttlMs)
    || ttlMs < 1
    || ttlMs > MAX_RECEIPT_TTL_MS) {
    throw new CompanionError("E_CAPABILITY", "Provider probe did not establish the required root-worker capability.");
  }
  // Fail closed for ambient-path receipts: the probe binary must be the pinned one.
  const resolved = resolveProviderExecutablePin(binding, {
    env,
    ...(releases === undefined ? {} : { releases })
  });
  if (resolved.binary !== fs.realpathSync(path.resolve(runtime.binary))
    || !assertExecutableAttestation(resolved.executableIdentity)
    || resolved.executableIdentity.identityDigest !== binding.executableIdentityDigest
    || resolved.executableIdentity.releaseIdentityDigest !== binding.releaseIdentityDigest
    || resolved.executableIdentity.version !== runtime.version) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Provider probe did not run through the setup-owned executable pin."
    );
  }
  const observedAt = clock();
  if (!Number.isFinite(observedAt)) throw new CompanionError("E_STATE", "Provider capability clock is invalid.");
  const observedVersion = grokVersion(resolved.binary);
  if (observedVersion !== runtime.version
    || observedVersion !== resolved.executableIdentity.version) {
    throw new CompanionError("E_CAPABILITY", "Provider version changed before capability publication.");
  }
  const rootReadProfileDigest = profileFor("task", false).agentProfileDigest;
  const setupProfileDigest = currentSetupProfileDigest();
  if (runtime.acpIsolation.agentProfileDigest !== setupProfileDigest) {
    throw new CompanionError("E_CAPABILITY", "Provider probe profile changed before capability publication.");
  }
  const stable = stableCapabilityBody({
    pluginVersion: currentPluginVersion(),
    mcpCapabilityContractVersion: MCP_CAPABILITY_CONTRACT_VERSION,
    platform: process.platform,
    architecture: process.arch,
    providerVersion: runtime.version,
    providerLaunchBinding: binding,
    providerLaunchBindingDigest: providerLaunchBindingDigest(binding),
    acpProtocolVersion: runtime.protocolVersion,
    loadSession: runtime.loadSession,
    setupProfileDigest,
    rootReadProfileDigest
  });
  const capabilityDigest = stableDigest(stable);
  const body = {
    ...stable,
    issuedAt: new Date(observedAt).toISOString(),
    expiresAt: new Date(observedAt + ttlMs).toISOString(),
    capabilityDigest
  };
  const receipt = Object.freeze({ ...body, receiptDigest: stableDigest(body) });
  const file = capabilityReceiptPath(env, { create: true });
  writePrivateJsonFile(file, receipt);
  return receipt;
}

export function clearProviderCapabilityReceipt({ env = process.env } = {}) {
  const file = capabilityReceiptPath(env);
  if (!file) return false;
  const legacyFile = path.join(path.dirname(file), LEGACY_RECEIPT_FILE);
  let removed = false;
  for (const candidate of [file, legacyFile]) {
    try {
      fs.unlinkSync(candidate);
      removed = true;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new CompanionError("E_STATE", "Could not invalidate the provider capability receipt.");
      }
    }
  }
  if (removed && process.platform !== "win32") {
    try {
      let directoryDescriptor;
      try {
        directoryDescriptor = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
        fs.fsyncSync(directoryDescriptor);
      } finally {
        if (directoryDescriptor != null) fs.closeSync(directoryDescriptor);
      }
    } catch (error) {
      throw new CompanionError("E_STATE", "Could not durably invalidate the provider capability receipt.");
    }
  }
  return removed;
}

/**
 * Read and revalidate one private provider capability receipt. Schema v1 and
 * any missing, tampered, or mismatched pin binding is rejected.
 */
export function readValidProviderCapabilityReceipt({
  env = process.env,
  clock = () => Date.now(),
  pluginVersion = currentPluginVersion(),
  mcpCapabilityContractVersion = MCP_CAPABILITY_CONTRACT_VERSION,
  platform = process.platform,
  architecture = process.arch,
  setupProfileDigest = currentSetupProfileDigest(),
  rootReadProfileDigest = profileFor("task", false).agentProfileDigest,
  resolvePin = resolveProviderExecutablePin,
  releases = undefined
} = {}) {
  try {
    const file = capabilityReceiptPath(env);
    if (!file) return null;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 64 * 1024) {
      return null;
    }
    const receipt = readPrivateJsonFile(file, {
      missing: null,
      maxBytes: 64 * 1024,
      label: "provider capability receipt"
    });
    // v1 receipts cannot authorize Worker Broker admission.
    if (receipt?.schemaVersion !== PROVIDER_CAPABILITY_SCHEMA_VERSION) return null;
    if (!validateReceiptShape(receipt)
      || receipt.receiptDigest !== stableDigest(receiptWithoutDigest(receipt))
      || receipt.pluginVersion !== pluginVersion
      || receipt.mcpCapabilityContractVersion !== mcpCapabilityContractVersion
      || receipt.platform !== platform
      || receipt.architecture !== architecture
      || receipt.setupProfileDigest !== setupProfileDigest
      || receipt.rootReadProfileDigest !== rootReadProfileDigest
      || Date.parse(receipt.expiresAt) <= clock()) {
      return null;
    }
    const resolved = resolvePin(receipt.providerLaunchBinding, {
      env,
      platform,
      arch: architecture,
      ...(releases === undefined ? {} : { releases })
    });
    if (resolved.executableIdentity.identityDigest
      !== receipt.providerLaunchBinding.executableIdentityDigest
      || resolved.executableIdentity.releaseIdentityDigest
        !== receipt.providerLaunchBinding.releaseIdentityDigest
      || resolved.executableIdentity.version !== receipt.providerVersion) {
      return null;
    }
    const stable = stableCapabilityBody({
      pluginVersion,
      mcpCapabilityContractVersion,
      platform,
      architecture,
      providerVersion: receipt.providerVersion,
      providerLaunchBinding: receipt.providerLaunchBinding,
      providerLaunchBindingDigest: receipt.providerLaunchBindingDigest,
      acpProtocolVersion: receipt.acpProtocolVersion,
      loadSession: receipt.loadSession,
      setupProfileDigest: receipt.setupProfileDigest,
      rootReadProfileDigest
    });
    if (stableDigest(stable) !== receipt.capabilityDigest
      || providerLaunchBindingDigest(receipt.providerLaunchBinding)
        !== receipt.providerLaunchBindingDigest) {
      return null;
    }
    return Object.freeze(receipt);
  } catch {
    return null;
  }
}
