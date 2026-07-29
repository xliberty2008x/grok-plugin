import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export const TEST_TEMP_MANIFEST = ".grok-test-temp-owner.json";
export const TEST_TEMP_SCHEMA_VERSION = 1;
export const TEST_TEMP_RUN_PREFIX = "grok-plugin-test-run-";
export const TEST_TEMP_FILE_PREFIX = "file-";
export const TEST_TEMP_PROCESS_PREFIX = "grok-plugin-test-process-";
export const TEST_TEMP_ROOT_ENV = "GROK_PLUGIN_TEST_TEMP_ROOT";

const SYSTEM_PS_CANDIDATES = Object.freeze(["/bin/ps", "/usr/bin/ps"]);
const MANAGED_KINDS = Object.freeze(new Set(["run", "file", "process"]));
let processFixtureRoot = null;
let processCleanupRegistered = false;

function systemPsBinary() {
  if (process.platform === "win32") return null;
  return SYSTEM_PS_CANDIDATES.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) || null;
}

export function processStartToken(pid, { run = spawnSync } = {}) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return null;
  const binary = systemPsBinary();
  if (!binary) return null;
  const result = run(binary, ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    shell: false,
    timeout: 2_000,
    maxBuffer: 8 * 1024
  });
  const token = result?.status === 0 ? String(result.stdout || "").trim() : "";
  return token && token.length <= 256 ? token : null;
}

export function newTestTempOwnerToken(pid = process.pid) {
  return processStartToken(pid) || `opaque:${crypto.randomBytes(16).toString("hex")}`;
}

function normalizedOwner({ kind, pid = process.pid, startToken = newTestTempOwnerToken(pid), createdAt = new Date().toISOString() }) {
  if (!MANAGED_KINDS.has(kind)) throw new Error("Unsupported test-temp owner kind.");
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Test-temp owner PID is invalid.");
  if (typeof startToken !== "string" || !startToken.trim() || startToken.length > 256) {
    throw new Error("A process start token is required for test-temp ownership.");
  }
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error("Test-temp creation time is invalid.");
  }
  return {
    schemaVersion: TEST_TEMP_SCHEMA_VERSION,
    kind,
    pid,
    startToken,
    createdAt
  };
}

export function validateTestTempManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([
    "createdAt",
    "kind",
    "pid",
    "schemaVersion",
    "startToken"
  ])) return null;
  if (value.schemaVersion !== TEST_TEMP_SCHEMA_VERSION || !MANAGED_KINDS.has(value.kind)) return null;
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
  if (
    typeof value.startToken !== "string"
    || value.startToken !== value.startToken.trim()
    || !value.startToken
    || value.startToken.length > 256
  ) return null;
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return null;
  return { ...value };
}

export function readTestTempManifest(root) {
  try {
    const manifestPath = path.join(root, TEST_TEMP_MANIFEST);
    const stat = fs.lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const value = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return validateTestTempManifest(value);
  } catch {
    return null;
  }
}

function assertRealDirectory(directory) {
  if (!path.isAbsolute(directory)) throw new Error("Test-temp base must be absolute.");
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Test-temp base must be a real directory.");
  }
  const real = fs.realpathSync(directory);
  if (real !== path.resolve(directory)) {
    throw new Error("Test-temp base must already be canonical.");
  }
  return real;
}

export function canonicalSystemTempRoot() {
  const configured = path.resolve(os.tmpdir());
  const real = fs.realpathSync(configured);
  return assertRealDirectory(real);
}

export function createOwnedTestTempRoot({
  base = canonicalSystemTempRoot(),
  prefix,
  kind,
  pid = process.pid,
  startToken = newTestTempOwnerToken(pid),
  createdAt
}) {
  const canonicalBase = assertRealDirectory(base);
  if (typeof prefix !== "string" || !/^[A-Za-z0-9._-]+-$/.test(prefix)) {
    throw new Error("Test-temp prefix is invalid.");
  }
  const owner = normalizedOwner({ kind, pid, startToken, createdAt });
  const root = fs.mkdtempSync(path.join(canonicalBase, prefix));
  try {
    fs.writeFileSync(
      path.join(root, TEST_TEMP_MANIFEST),
      `${JSON.stringify(owner)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
    return root;
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function makeTreeWritable(root) {
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return;
  try {
    fs.chmodSync(root, 0o700);
  } catch {
    // fs.rmSync below remains authoritative and reports any residual failure.
  }
  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) makeTreeWritable(path.join(root, entry));
}

export function removeOwnedTestTempRoot(root) {
  if (!root || !path.isAbsolute(root)) return false;
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Refusing to remove a non-directory test-temp root.");
  }
  makeTreeWritable(root);
  fs.rmSync(root, { recursive: true, force: true });
  return true;
}

function managedFileRootFromEnvironment() {
  const configured = process.env[TEST_TEMP_ROOT_ENV];
  if (typeof configured !== "string" || !path.isAbsolute(configured)) return null;
  try {
    const root = assertRealDirectory(configured);
    const manifest = readTestTempManifest(root);
    return manifest?.kind === "file" ? root : null;
  } catch {
    return null;
  }
}

function ensureProcessFixtureRoot() {
  const managed = managedFileRootFromEnvironment();
  if (managed) return managed;
  if (processFixtureRoot && fs.existsSync(processFixtureRoot)) return processFixtureRoot;
  processFixtureRoot = createOwnedTestTempRoot({
    prefix: TEST_TEMP_PROCESS_PREFIX,
    kind: "process"
  });
  if (!processCleanupRegistered) {
    processCleanupRegistered = true;
    process.once("exit", () => {
      try {
        removeOwnedTestTempRoot(processFixtureRoot);
      } catch {
        // Exit cleanup is best effort; stale manifest-backed roots are reaped later.
      }
    });
  }
  return processFixtureRoot;
}

export function createTestFixtureDirectory(prefix) {
  if (typeof prefix !== "string" || !/^[A-Za-z0-9._-]+-$/.test(prefix)) {
    throw new Error("Test fixture prefix is invalid.");
  }
  return fs.mkdtempSync(path.join(ensureProcessFixtureRoot(), prefix));
}
