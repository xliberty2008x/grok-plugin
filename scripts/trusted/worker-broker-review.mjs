#!/usr/bin/env node
/**
 * Built-in-only bootstrap for a protected Phase 1 review runtime.
 *
 * Direct source-checkout invocation is intentionally non-authoritative. A
 * host-owned launcher must invoke an absolute pinned Node binary with a clean
 * environment. Before any repository-local module is evaluated, this
 * bootstrap verifies the exact root-owned, non-writable runtime bundle and its
 * fixed sibling trust descriptor.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REVIEW_DOMAIN = "grok-plugin/worker-broker/phase-1-review-attestation/v1";
const REVIEW_ALGORITHM = "Ed25519";
const CLEAN_PATH = "/usr/bin:/bin";
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_RUNTIME_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ATTESTATION_BYTES = 256 * 1024;
const MAX_EXECUTABLE_BYTES = 128 * 1024 * 1024;
const PROTECTED_GIT_PATH = "/usr/bin/git";
const EMPTY_HOOKS_RELATIVE_PATH = ".worker-broker-host-state/empty-hooks";
const SHA256 = /^[0-9a-f]{64}$/;
const RUNTIME_BUNDLE_PATHS = Object.freeze([
  "plugins/grok/scripts/lib/redact.mjs",
  "scripts/lib/plugin-inventory.mjs",
  "scripts/lib/static-esm-import-parser.mjs",
  "scripts/lib/worker-broker-evidence.mjs",
  "scripts/trusted/worker-broker-review.mjs"
]);
const DESCRIPTOR_FIELDS = Object.freeze([
  "algorithm",
  "descriptorDigest",
  "domain",
  "gitDigest",
  "issuer",
  "keyFingerprint",
  "policyDigest",
  "publicKeySpkiBase64",
  "revokedKeyFingerprints",
  "runtimeBundle",
  "runtimeBundleDigest",
  "schemaVersion"
]);
const FORBIDDEN_ENVIRONMENT = Object.freeze([
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "VSCODE_INSPECTOR_OPTIONS"
]);
const POLICY = Object.freeze({
  schemaVersion: 1,
  attestationDomain: REVIEW_DOMAIN,
  algorithm: REVIEW_ALGORITHM,
  trustSource: "fixed-root-owned-runtime-sibling",
  runtimeOwnerUid: 0,
  gitPath: PROTECTED_GIT_PATH,
  emptyHooksPath: EMPTY_HOOKS_RELATIVE_PATH,
  runtimeBundlePaths: RUNTIME_BUNDLE_PATHS,
  workspaceRole: "data-only",
  privateKeyLocation: "external-issuer-only"
});

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const POLICY_DIGEST = sha256(stableStringify(POLICY));

function trustError() {
  const error = new Error("Protected review trust is unavailable.");
  error.code = "E_REVIEW_TRUST_UNAVAILABLE";
  return error;
}

function exactObject(value, fields) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field))
  );
}

function assertCleanProcess() {
  if (process.platform === "win32"
    || typeof process.getuid !== "function"
    || process.getuid() === 0
    || process.execArgv.length !== 0
    || process.env.PATH !== CLEAN_PATH
    || FORBIDDEN_ENVIRONMENT.some((name) => Object.hasOwn(process.env, name))) {
    throw trustError();
  }
}

function assertRootOwnedNonWritable(absolute, expectedType) {
  if (!path.isAbsolute(absolute)) throw trustError();
  const resolved = path.resolve(absolute);
  const filesystemRoot = path.parse(resolved).root;
  const relative = path.relative(filesystemRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw trustError();
  }
  let cursor = filesystemRoot;
  const paths = [filesystemRoot];
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    paths.push(cursor);
  }
  let leaf;
  for (const [index, candidate] of paths.entries()) {
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch {
      throw trustError();
    }
    if (stat.isSymbolicLink()
      || stat.uid !== 0
      || (stat.mode & 0o022) !== 0
      || (index < paths.length - 1 && !stat.isDirectory())) {
      throw trustError();
    }
    try {
      fs.accessSync(candidate, fs.constants.W_OK);
      throw trustError();
    } catch (error) {
      if (error?.code === "E_REVIEW_TRUST_UNAVAILABLE") throw error;
      if (!new Set(["EACCES", "EPERM", "EROFS"]).has(error?.code)) throw trustError();
    }
    leaf = stat;
  }
  if ((expectedType === "file" && !leaf?.isFile())
    || (expectedType === "directory" && !leaf?.isDirectory())) {
    throw trustError();
  }
}

function readProtectedFile(absolute, maxBytes) {
  assertRootOwnedNonWritable(absolute, "file");
  let descriptor;
  try {
    descriptor = fs.openSync(
      absolute,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maxBytes)) {
      throw trustError();
    }
    const contents = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.mode !== after.mode
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || Buffer.byteLength(contents, "utf8") !== Number(before.size)) {
      throw trustError();
    }
    return Object.freeze({
      contents,
      identity: Object.freeze({
        dev: before.dev,
        ino: before.ino,
        mode: before.mode,
        size: before.size,
        mtimeNs: before.mtimeNs,
        ctimeNs: before.ctimeNs
      })
    });
  } catch (error) {
    if (error?.code === "E_REVIEW_TRUST_UNAVAILABLE") throw error;
    throw trustError();
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function digestProtectedBinary(absolute, maxBytes) {
  assertRootOwnedNonWritable(absolute, "file");
  let descriptor;
  try {
    descriptor = fs.openSync(
      absolute,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maxBytes)) {
      throw trustError();
    }
    const contents = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.mode !== after.mode
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || contents.byteLength !== Number(before.size)) {
      throw trustError();
    }
    return sha256(contents);
  } catch (error) {
    if (error?.code === "E_REVIEW_TRUST_UNAVAILABLE") throw error;
    throw trustError();
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function sameSnapshot(left, right) {
  return left.contents === right.contents
    && left.identity.dev === right.identity.dev
    && left.identity.ino === right.identity.ino
    && left.identity.mode === right.identity.mode
    && left.identity.size === right.identity.size
    && left.identity.mtimeNs === right.identity.mtimeNs
    && left.identity.ctimeNs === right.identity.ctimeNs;
}

function canonicalDescriptorBody(descriptor) {
  const body = structuredClone(descriptor);
  delete body.descriptorDigest;
  return stableStringify(body);
}

function validateDescriptor(descriptor) {
  if (!exactObject(descriptor, DESCRIPTOR_FIELDS)
    || descriptor.schemaVersion !== 1
    || descriptor.domain !== REVIEW_DOMAIN
    || descriptor.algorithm !== REVIEW_ALGORITHM
    || typeof descriptor.issuer !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(descriptor.issuer)
    || typeof descriptor.publicKeySpkiBase64 !== "string"
    || !SHA256.test(descriptor.keyFingerprint || "")
    || !SHA256.test(descriptor.gitDigest || "")
    || !Array.isArray(descriptor.revokedKeyFingerprints)
    || descriptor.revokedKeyFingerprints.some((value) => !SHA256.test(value || ""))
    || !Array.isArray(descriptor.runtimeBundle)
    || descriptor.runtimeBundle.length !== RUNTIME_BUNDLE_PATHS.length
    || descriptor.runtimeBundle.some((entry, index) => (
      !exactObject(entry, ["path", "digest"])
      || entry.path !== RUNTIME_BUNDLE_PATHS[index]
      || !SHA256.test(entry.digest || "")
    ))
    || descriptor.runtimeBundleDigest !== sha256(stableStringify(descriptor.runtimeBundle))
    || descriptor.policyDigest !== POLICY_DIGEST
    || descriptor.descriptorDigest !== sha256(canonicalDescriptorBody(descriptor))) {
    throw trustError();
  }
  let spki;
  let publicKey;
  try {
    spki = Buffer.from(descriptor.publicKeySpkiBase64, "base64");
    if (spki.length < 1 || spki.toString("base64") !== descriptor.publicKeySpkiBase64) {
      throw trustError();
    }
    publicKey = crypto.createPublicKey({ key: spki, type: "spki", format: "der" });
  } catch {
    throw trustError();
  }
  const canonicalSpki = publicKey.export({ type: "spki", format: "der" });
  if (publicKey.asymmetricKeyType !== "ed25519"
    || sha256(canonicalSpki) !== descriptor.keyFingerprint) {
    throw trustError();
  }
}

function parseArguments(argv) {
  const mode = argv[0];
  const allowed = mode === "promote"
    ? new Set(["--workspace", "--request"])
    : mode === "verify"
      ? new Set(["--workspace"])
      : null;
  if (!allowed || argv.length !== 1 + allowed.size * 2) throw trustError();
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag)
      || Object.hasOwn(values, flag)
      || typeof value !== "string"
      || !value
      || value.startsWith("--")) {
      throw trustError();
    }
    values[flag] = value;
  }
  if (Object.keys(values).length !== allowed.size) throw trustError();
  return Object.freeze({ mode, values: Object.freeze(values) });
}

async function readBoundedAttestation() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_ATTESTATION_BYTES) throw trustError();
    chunks.push(chunk);
  }
  if (size < 2) throw trustError();
  let attestation;
  try {
    attestation = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    throw trustError();
  }
  if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)) {
    throw trustError();
  }
  return attestation;
}

function boundedResult(result) {
  if (result?.recordDigest) {
    return {
      ok: result.ok === true,
      converged: result.converged === true,
      path: result.path || null,
      recordDigest: result.recordDigest
    };
  }
  return {
    ok: result?.ok === true,
    errors: Array.isArray(result?.errors)
      ? result.errors.slice(0, 32).map((message) => String(message).slice(0, 512))
      : []
  };
}

function boundedFailure(error) {
  const allowedCodes = new Set([
    "E_REVIEW_ATTESTATION_INVALID",
    "E_REVIEW_PROMOTION_COMMIT_UNKNOWN",
    "E_REVIEW_PROMOTION_CONFLICT",
    "E_REVIEW_PROMOTION_FORBIDDEN",
    "E_REVIEW_PROMOTION_INVALID",
    "E_REVIEW_PROMOTION_RACE",
    "E_REVIEW_REQUEST_INVALID",
    "E_REVIEW_TRUST_UNAVAILABLE"
  ]);
  const code = allowedCodes.has(error?.code)
    ? error.code
    : "E_REVIEW_TRUST_UNAVAILABLE";
  const result = { ok: false, code };
  if (code === "E_REVIEW_PROMOTION_COMMIT_UNKNOWN") {
    result.commitState = String(error?.commitState || "unknown").slice(0, 64);
    result.recoveryRequired = true;
    if (SHA256.test(error?.recordDigest || "")) result.recordDigest = error.recordDigest;
  }
  return result;
}

async function main() {
  assertCleanProcess();
  const parsed = parseArguments(process.argv.slice(2));
  const bootstrap = fileURLToPath(import.meta.url);
  const runtimeRoot = path.resolve(path.dirname(bootstrap), "../..");
  const descriptorPath = path.join(
    runtimeRoot,
    ".worker-broker-host-state/review-trust-v1.json"
  );
  const emptyHooksPath = path.join(runtimeRoot, EMPTY_HOOKS_RELATIVE_PATH);
  assertRootOwnedNonWritable(runtimeRoot, "directory");
  assertRootOwnedNonWritable(emptyHooksPath, "directory");
  if (fs.readdirSync(emptyHooksPath).length !== 0) throw trustError();
  const descriptorBefore = readProtectedFile(descriptorPath, MAX_DESCRIPTOR_BYTES);
  let descriptor;
  try {
    descriptor = JSON.parse(descriptorBefore.contents);
  } catch {
    throw trustError();
  }
  validateDescriptor(descriptor);
  if (digestProtectedBinary(PROTECTED_GIT_PATH, MAX_EXECUTABLE_BYTES)
    !== descriptor.gitDigest) {
    throw trustError();
  }

  const bundleBefore = new Map();
  for (const entry of descriptor.runtimeBundle) {
    const absolute = path.join(runtimeRoot, ...entry.path.split("/"));
    const snapshot = readProtectedFile(absolute, MAX_RUNTIME_FILE_BYTES);
    if (sha256(snapshot.contents) !== entry.digest) throw trustError();
    bundleBefore.set(entry.path, snapshot);
  }
  const descriptorAfter = readProtectedFile(descriptorPath, MAX_DESCRIPTOR_BYTES);
  if (!sameSnapshot(descriptorBefore, descriptorAfter)) throw trustError();
  for (const entry of descriptor.runtimeBundle) {
    const absolute = path.join(runtimeRoot, ...entry.path.split("/"));
    if (!sameSnapshot(bundleBefore.get(entry.path), readProtectedFile(
      absolute,
      MAX_RUNTIME_FILE_BYTES
    ))) throw trustError();
  }

  const runtimeModule = path.join(runtimeRoot, "scripts/lib/worker-broker-evidence.mjs");
  const api = await import(pathToFileURL(runtimeModule).href);
  return parsed.mode === "promote"
    ? api.promotePhaseOneFromProtectedRuntime({
      workspace: parsed.values["--workspace"],
      requestPath: parsed.values["--request"],
      attestation: await readBoundedAttestation()
    })
    : api.verifySignedLedgerFromProtectedRuntime({
      workspace: parsed.values["--workspace"]
    });
}

try {
  const result = await main();
  process.stdout.write(`${JSON.stringify(boundedResult(result), null, 2)}\n`);
  if (result?.ok !== true) process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify(boundedFailure(error), null, 2)}\n`);
  process.exitCode = 1;
}
