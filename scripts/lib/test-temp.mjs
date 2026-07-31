import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import gitContainment from "./test-temp-git-containment.cjs";

const { inspectContainedGitMetadata } = gitContainment;

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
const createdRootIdentities = new Map();
const REMOVE_OWNED_ROOT_HELPER = fileURLToPath(
  new URL("./test-temp-remove-helper.cjs", import.meta.url)
);
const REMOVE_DIAGNOSTIC_PATTERN =
  /(?:^|\n)grok-plugin-test-temp-remove-v1:(arguments|root-identity|mount-boundary|managed-proof|directory-inventory|entry-validation|recursive-removal|file-removal|directory-open|child-removal|root-removal):(1|42|43|44)(?=\n|$)/gu;

function ownedCleanupError(message, cleanupReason) {
  const error = new Error(message);
  error.cleanupReason = cleanupReason;
  return error;
}

function helperCleanupReason(result) {
  const diagnostics = [
    ...String(result?.stderr || "").matchAll(REMOVE_DIAGNOSTIC_PATTERN)
  ];
  if (diagnostics.length > 0) {
    const [, stage, status] = diagnostics[0];
    return `helper-${stage}-${status}`;
  }
  if (result?.error) return "helper-launch-error";
  if (result?.signal) return "helper-signal";
  if (Number.isInteger(result?.status)) return `helper-exit-${result.status}`;
  return "helper-result-unavailable";
}

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
    maxBuffer: 8 * 1024,
    env: { LC_ALL: "C", LANG: "C" }
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
    const rootStat = fs.lstatSync(root, { bigint: true });
    const manifestPath = path.join(root, TEST_TEMP_MANIFEST);
    const manifestStat = fs.lstatSync(manifestPath, { bigint: true });
    const manifestContents = fs.readFileSync(manifestPath);
    if (
      !rootStat.isDirectory()
      || rootStat.isSymbolicLink()
      || !manifestStat.isFile()
      || manifestStat.isSymbolicLink()
      || manifestStat.uid !== rootStat.uid
    ) {
      throw new Error("The created test-temp root identity is invalid.");
    }
    createdRootIdentities.set(root, Object.freeze({
      root: Object.freeze({
        dev: String(rootStat.dev),
        ino: String(rootStat.ino),
        uid: String(rootStat.uid)
      }),
      manifest: Object.freeze({
        dev: String(manifestStat.dev),
        ino: String(manifestStat.ino),
        uid: String(manifestStat.uid),
        mode: String(manifestStat.mode),
        size: String(manifestStat.size),
        digest: crypto.createHash("sha256").update(manifestContents).digest("hex")
      })
    }));
    return root;
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function sameCreatedRootIdentity(expected, stat) {
  return Boolean(
    expected
    && stat.isDirectory()
    && !stat.isSymbolicLink()
    && String(stat.dev) === expected.dev
    && String(stat.ino) === expected.ino
    && String(stat.uid) === expected.uid
  );
}

function verifyCreatedRoot(root, expected) {
  const rootStat = fs.lstatSync(root, { bigint: true });
  if (!sameCreatedRootIdentity(expected.root, rootStat)) {
    throw new Error("The test-temp root identity changed before cleanup.");
  }
  const manifestPath = path.join(root, TEST_TEMP_MANIFEST);
  const manifestStat = fs.lstatSync(manifestPath, { bigint: true });
  const manifest = expected.manifest;
  if (
    !manifestStat.isFile()
    || manifestStat.isSymbolicLink()
    || String(manifestStat.dev) !== manifest.dev
    || String(manifestStat.ino) !== manifest.ino
    || String(manifestStat.uid) !== manifest.uid
    || String(manifestStat.mode) !== manifest.mode
    || String(manifestStat.size) !== manifest.size
  ) {
    throw new Error("The test-temp owner manifest identity changed before cleanup.");
  }
  const digest = crypto
    .createHash("sha256")
    .update(fs.readFileSync(manifestPath))
    .digest("hex");
  if (digest !== manifest.digest) {
    throw new Error("The test-temp owner manifest changed before cleanup.");
  }
}

export function removeOwnedTestTempRoot(root) {
  if (!root || !path.isAbsolute(root)) return false;
  const expected = createdRootIdentities.get(root);
  if (!expected) return false;
  verifyCreatedRoot(root, expected);
  const quarantine = path.join(
    path.dirname(root),
    `.grok-plugin-owned-quarantine-${crypto.randomUUID()}`
  );
  try {
    fs.renameSync(root, quarantine);
  } catch (error) {
    throw error;
  }
  try {
    verifyCreatedRoot(quarantine, expected);
    const gitProof = inspectContainedGitMetadata({
      root: quarantine,
      originalRoot: root,
      expectedUid: expected.root.uid,
      expectedDev: expected.root.dev
    });
    if (!gitProof.available) {
      throw ownedCleanupError(
        "The test-temp root contains unproven Git metadata.",
        gitProof.reason || "git-metadata-ambiguous"
      );
    }
    const result = spawnSync(process.execPath, [
      REMOVE_OWNED_ROOT_HELPER,
      expected.root.dev,
      expected.root.ino,
      expected.root.dev,
      "managed-contained",
      "none",
      root,
      quarantine,
      expected.root.uid,
      gitProof.digest
    ], {
      cwd: quarantine,
      env: { GROK_PLUGIN_TEST_CHILD_HOOK_BYPASS: "1" },
      encoding: "utf8",
      shell: false,
      maxBuffer: 8 * 1024
    });
    if (result?.status !== 0 || result?.error || result?.signal) {
      throw ownedCleanupError(
        "The identity-pinned test-temp root could not be removed.",
        helperCleanupReason(result)
      );
    }
    try {
      fs.lstatSync(quarantine);
      throw new Error("The identity-pinned test-temp root still exists after removal.");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    createdRootIdentities.delete(root);
    return true;
  } catch (error) {
    let restored = false;
    try {
      fs.lstatSync(root);
    } catch (rootError) {
      if (rootError?.code === "ENOENT") {
        try {
          fs.renameSync(quarantine, root);
          restored = true;
        } catch {
          // Preserve the quarantined tree and report cleanup failure below.
        }
      }
    }
    if (!restored && fs.existsSync(quarantine)) {
      error.quarantinePath = quarantine;
    }
    throw error;
  }
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
