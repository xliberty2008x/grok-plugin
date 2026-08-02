/** Internal Worker Broker evidence files domain. */
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
  ATOMIC_REPLACE_COMMIT_STATE,
  EVIDENCE_PATH_FIELDS,
  EVIDENCE_ROOT,
  LEDGER_LOCK_ACTION_COMPLETED,
  LEDGER_LOCK_CONSTRUCTION_GRACE_MS,
  LEDGER_LOCK_NAME,
  LEDGER_LOCK_OWNER_FILE,
  LEDGER_LOCK_RECORD_BYTES,
  LEDGER_LOCK_RELEASE_FAILURE,
  LEDGER_LOCK_TRANSITION_FILE,
  LEDGER_LOCK_WAIT_MS,
  MAX_EVIDENCE_ARRAY_ITEMS,
  MAX_EVIDENCE_DEPTH,
  MAX_EVIDENCE_RECORD_BYTES,
  MAX_EVIDENCE_STRING_CHARS,
  MAX_PHASE_SCOPE_PATHS,
  NUMBERED_PHASE_SET,
  PRIVATE_EVIDENCE_FIELD,
  PRIVATE_EVIDENCE_PATH,
  REPO_ROOT
} from "./worker-broker-evidence-core.mjs";

export function statusSatisfiesVerifiedPrerequisite(status, phase = null) {
  return status === "verified_on_draft"
    && (phase == null || NUMBERED_PHASE_SET.has(String(phase)));
}

export function statusSatisfiesPhaseReadiness(status, phase) {
  return String(phase) === "aggregate"
    ? status === "qualified"
    : statusSatisfiesVerifiedPrerequisite(status, phase);
}

export function fixedEvidenceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function protectedReviewTrustError() {
  return fixedEvidenceError(
    "E_REVIEW_TRUST_UNAVAILABLE",
    "Protected review trust is unavailable."
  );
}

export function assertProtectedHostPath(absolute, expectedType) {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    throw protectedReviewTrustError();
  }
  let chain;
  try {
    const filesystemRoot = path.parse(path.resolve(absolute)).root;
    chain = captureEvidencePathChain(filesystemRoot, path.resolve(absolute));
  } catch {
    throw protectedReviewTrustError();
  }
  const relative = path.relative(chain.canonicalRoot, chain.canonicalAbsolute);
  const componentPaths = [chain.canonicalRoot];
  let cursor = chain.canonicalRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    componentPaths.push(cursor);
  }
  const snapshots = [
    fs.lstatSync(chain.canonicalRoot, { bigint: true }),
    ...chain.snapshots
  ];
  for (const [index, stat] of snapshots.entries()) {
    if (stat.isSymbolicLink()
      || stat.uid !== 0n
      || (stat.mode & 0o022n) !== 0n) {
      throw protectedReviewTrustError();
    }
    try {
      fs.accessSync(componentPaths[index], fs.constants.W_OK);
      throw protectedReviewTrustError();
    } catch (error) {
      if (error?.code === "E_REVIEW_TRUST_UNAVAILABLE") throw error;
      if (!new Set(["EACCES", "EPERM", "EROFS"]).has(error?.code)) {
        throw protectedReviewTrustError();
      }
    }
  }
  const leaf = snapshots.at(-1);
  if ((expectedType === "file" && !leaf?.isFile())
    || (expectedType === "directory" && !leaf?.isDirectory())) {
    throw protectedReviewTrustError();
  }
  return chain;
}

export function invalidEvidencePublicationError() {
  return fixedEvidenceError(
    "E_EVIDENCE_RECORD_INVALID",
    "Evidence record is invalid or unsafe for publication."
  );
}

export function invalidLiveReceiptError() {
  return fixedEvidenceError(
    "E_LIVE_RECEIPT_INVALID",
    "Live qualification receipt is invalid or unsafe."
  );
}

export function invalidLiveQualificationPublicationError() {
  return fixedEvidenceError(
    "E_LIVE_QUALIFICATION_INVALID",
    "Live-qualified evidence is invalid or unsafe for publication."
  );
}

export function invalidLedgerUpdateError() {
  return fixedEvidenceError(
    "E_EVIDENCE_LEDGER_UPDATE_INVALID",
    "Evidence ledger update is invalid or unsafe."
  );
}

export function invalidLedgerDocumentError() {
  return fixedEvidenceError(
    "E_EVIDENCE_LEDGER_INVALID",
    "Evidence ledger is malformed, unsafe, or unreadable."
  );
}

function evidenceLedgerLockError() {
  return fixedEvidenceError(
    "E_EVIDENCE_LEDGER_LOCK",
    "Evidence ledger lock is unsafe or unavailable."
  );
}

function isPrivateEvidenceField(field) {
  const segmented = String(field)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
  return PRIVATE_EVIDENCE_FIELD.test(segmented);
}

export function isIsoDateTime(value) {
  return typeof value === "string"
    && value.length > 0
    && Number.isFinite(Date.parse(value));
}

export function unexpectedFields(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).filter((field) => !allowed.has(field));
}

export function boundedEvidenceErrors(value, pathName = "$", depth = 0, errors = []) {
  if (depth > MAX_EVIDENCE_DEPTH) {
    errors.push(`${pathName} exceeds maximum evidence nesting depth ${MAX_EVIDENCE_DEPTH}.`);
    return errors;
  }
  if (typeof value === "string") {
    if (value.length > MAX_EVIDENCE_STRING_CHARS) {
      errors.push(`${pathName} exceeds ${MAX_EVIDENCE_STRING_CHARS} characters.`);
    }
    if (redactText(value) !== value) {
      errors.push(`${pathName} contains secret-shaped text.`);
    }
    if (PRIVATE_EVIDENCE_PATH.test(value)) {
      errors.push(`${pathName} contains a private runtime path.`);
    }
    return errors;
  }
  if (Array.isArray(value)) {
    const limit = pathName.endsWith(".source.phaseScopePaths")
      ? MAX_PHASE_SCOPE_PATHS
      : MAX_EVIDENCE_ARRAY_ITEMS;
    if (value.length > limit) {
      errors.push(`${pathName} exceeds ${limit} items.`);
    }
    value.forEach((item, index) => boundedEvidenceErrors(item, `${pathName}[${index}]`, depth + 1, errors));
    return errors;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const supportedKey = EVIDENCE_PATH_FIELDS.has(key);
      const publicKey = supportedKey ? key : "<unsupported>";
      if (!supportedKey && isPrivateEvidenceField(key)) {
        errors.push(`${pathName}.${publicKey} is a forbidden raw/private evidence field.`);
      }
      boundedEvidenceErrors(child, `${pathName}.${publicKey}`, depth + 1, errors);
    }
  }
  return errors;
}

export function rawEvidenceValueIsSafe(value, pathName = "$") {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string"
      && Buffer.byteLength(serialized) <= MAX_EVIDENCE_RECORD_BYTES
      && boundedEvidenceErrors(value, pathName).length === 0;
  } catch {
    return false;
  }
}

function unsafeEvidenceFileError() {
  const error = new Error("Evidence file is unsafe or unreadable.");
  error.code = "E_EVIDENCE_FILE_UNSAFE";
  return error;
}

export function sameFileSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function samePathIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode;
}

export function captureEvidencePathChain(root, absolute) {
  const lexicalRoot = path.resolve(root);
  const lexicalAbsolute = path.resolve(absolute);
  const relative = path.relative(lexicalRoot, lexicalAbsolute);
  if (!relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw unsafeEvidenceFileError();
  }

  const canonicalRoot = fs.realpathSync.native(lexicalRoot);
  let cursor = canonicalRoot;
  const components = relative.split(path.sep).filter(Boolean);
  const snapshots = [];
  for (const [index, component] of components.entries()) {
    cursor = path.join(cursor, component);
    const stat = fs.lstatSync(cursor, { bigint: true });
    if (stat.isSymbolicLink()) throw unsafeEvidenceFileError();
    if (index < components.length - 1 && !stat.isDirectory()) {
      throw unsafeEvidenceFileError();
    }
    snapshots.push(stat);
  }
  return { canonicalRoot, canonicalAbsolute: cursor, snapshots };
}

function captureEvidencePathExistence(root, absolute) {
  const lexicalRoot = path.resolve(root);
  const lexicalAbsolute = path.resolve(absolute);
  const relative = path.relative(lexicalRoot, lexicalAbsolute);
  if (!relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw unsafeEvidenceFileError();
  }
  let canonicalRoot;
  let rootSnapshot;
  try {
    canonicalRoot = fs.realpathSync.native(lexicalRoot);
    rootSnapshot = fs.lstatSync(canonicalRoot, { bigint: true });
  } catch {
    throw unsafeEvidenceFileError();
  }
  if (!rootSnapshot.isDirectory() || rootSnapshot.isSymbolicLink()) {
    throw unsafeEvidenceFileError();
  }
  const components = relative.split(path.sep).filter(Boolean);
  const snapshots = [rootSnapshot];
  let cursor = canonicalRoot;
  for (const [index, component] of components.entries()) {
    cursor = path.join(cursor, component);
    let stat;
    try {
      stat = fs.lstatSync(cursor, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          exists: false,
          canonicalRoot,
          missingIndex: index,
          snapshots
        };
      }
      throw unsafeEvidenceFileError();
    }
    if (stat.isSymbolicLink()
      || (index < components.length - 1 && !stat.isDirectory())) {
      throw unsafeEvidenceFileError();
    }
    snapshots.push(stat);
  }
  return {
    exists: true,
    canonicalRoot,
    missingIndex: null,
    snapshots
  };
}

export function evidencePathIsStablyAbsent(root, absolute) {
  const before = captureEvidencePathExistence(root, absolute);
  if (before.exists) return false;
  const after = captureEvidencePathExistence(root, absolute);
  if (after.exists
    || before.canonicalRoot !== after.canonicalRoot
    || before.missingIndex !== after.missingIndex
    || before.snapshots.length !== after.snapshots.length
    || !after.snapshots.every((stat, index) => (
      sameFileSnapshot(stat, before.snapshots[index])
    ))) {
    throw unsafeEvidenceFileError();
  }
  return true;
}

export function readBoundedEvidenceFileSnapshot(root, absolute, maxBytes = MAX_EVIDENCE_RECORD_BYTES) {
  const before = captureEvidencePathChain(root, absolute);
  const beforeFile = before.snapshots.at(-1);
  if (!beforeFile?.isFile() || beforeFile.size > BigInt(maxBytes)) {
    throw unsafeEvidenceFileError();
  }

  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  let descriptor;
  try {
    descriptor = fs.openSync(before.canonicalAbsolute, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()
      || opened.size > BigInt(maxBytes)
      || !sameFileSnapshot(beforeFile, opened)) {
      throw unsafeEvidenceFileError();
    }
    const content = fs.readFileSync(descriptor);
    const afterOpen = fs.fstatSync(descriptor, { bigint: true });
    const after = captureEvidencePathChain(root, absolute);
    if (content.byteLength > maxBytes
      || after.canonicalRoot !== before.canonicalRoot
      || after.snapshots.length !== before.snapshots.length
      || !after.snapshots.every((stat, index) => sameFileSnapshot(stat, before.snapshots[index]))
      || !sameFileSnapshot(opened, afterOpen)) {
      throw unsafeEvidenceFileError();
    }
    return {
      contents: content.toString("utf8"),
      fileSnapshot: afterOpen,
      pathChain: after
    };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function readBoundedEvidenceFile(root, absolute, maxBytes = MAX_EVIDENCE_RECORD_BYTES) {
  return readBoundedEvidenceFileSnapshot(root, absolute, maxBytes).contents;
}

function samePathChain(left, right) {
  return left.canonicalRoot === right.canonicalRoot
    && left.canonicalAbsolute === right.canonicalAbsolute
    && left.snapshots.length === right.snapshots.length
    && right.snapshots.every((stat, index) => samePathIdentity(stat, left.snapshots[index]));
}

export function ensureEvidenceDirectory(root, directory) {
  const lexicalRoot = path.resolve(root);
  const lexicalDirectory = path.resolve(directory);
  const relative = path.relative(lexicalRoot, lexicalDirectory);
  if (!relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw unsafeEvidenceFileError();
  }
  let cursor = fs.realpathSync.native(lexicalRoot);
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try {
      fs.mkdirSync(cursor, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafeEvidenceFileError();
  }
  return captureEvidencePathChain(root, directory);
}

function assertExpectedEvidenceDestination(root, file, expected) {
  if (expected.exists) {
    const observed = readBoundedEvidenceFileSnapshot(root, file);
    if (observed.contents !== expected.contents
      || !sameFileSnapshot(observed.fileSnapshot, expected.fileSnapshot)) {
      throw unsafeEvidenceFileError();
    }
    return observed.fileSnapshot;
  }
  try {
    fs.lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  throw unsafeEvidenceFileError();
}

export function atomicReplaceEvidenceFile(root, file, contents, expected) {
  const directory = path.dirname(file);
  const directoryBefore = ensureEvidenceDirectory(root, directory);
  const temporary = path.join(
    directoryBefore.canonicalAbsolute,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  let descriptor;
  let renamed = false;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    assertExpectedEvidenceDestination(root, file, expected);
    const directoryAfter = captureEvidencePathChain(root, directory);
    if (!samePathChain(directoryBefore, directoryAfter)) throw unsafeEvidenceFileError();
    assertExpectedEvidenceDestination(root, file, expected);

    fs.renameSync(temporary, path.join(directoryAfter.canonicalAbsolute, path.basename(file)));
    renamed = true;
    if (process.platform !== "win32") {
      const directoryDescriptor = fs.openSync(directoryAfter.canonicalAbsolute, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
    let commitState = "unknown";
    try {
      const observed = readBoundedEvidenceFileSnapshot(root, file);
      if (observed.contents === contents) {
        commitState = "committed";
      } else if (expected.exists
        && observed.contents === expected.contents
        && sameFileSnapshot(observed.fileSnapshot, expected.fileSnapshot)) {
        commitState = "not_committed";
      }
    } catch (readError) {
      if (!expected.exists && readError?.code === "ENOENT") {
        commitState = "not_committed";
      }
    }
    if (!renamed && commitState === "committed" && contents !== expected.contents) {
      commitState = "unknown";
    }
    try {
      Object.defineProperty(error, ATOMIC_REPLACE_COMMIT_STATE, {
        configurable: false,
        enumerable: false,
        value: commitState,
        writable: false
      });
    } catch {}
    throw error;
  }
}

export function publishImmutableEvidenceFile(root, file, contents) {
  const directory = path.dirname(file);
  const directoryBefore = ensureEvidenceDirectory(root, directory);
  const temporary = path.join(
    directoryBefore.canonicalAbsolute,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  let descriptor;
  let temporarySnapshot;
  let destination = null;
  let published = false;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    temporarySnapshot = fs.fstatSync(descriptor, { bigint: true });
    fs.closeSync(descriptor);
    descriptor = undefined;

    const directoryAfter = captureEvidencePathChain(root, directory);
    if (!samePathChain(directoryBefore, directoryAfter)) throw unsafeEvidenceFileError();
    destination = path.join(directoryAfter.canonicalAbsolute, path.basename(file));

    // link(2) publishes without replacement: an existing regular file,
    // directory, or symlink all cause EEXIST and are never followed.
    fs.linkSync(temporary, destination);
    published = true;
    const publishedSnapshot = fs.lstatSync(destination, { bigint: true });
    if (!publishedSnapshot.isFile()
      || !samePathIdentity(temporarySnapshot, publishedSnapshot)
      || temporarySnapshot.size !== publishedSnapshot.size
      || temporarySnapshot.mtimeNs !== publishedSnapshot.mtimeNs) {
      throw unsafeEvidenceFileError();
    }
    const directoryFinal = captureEvidencePathChain(root, directory);
    if (!samePathChain(directoryBefore, directoryFinal)) throw unsafeEvidenceFileError();

    fs.unlinkSync(temporary);
    if (process.platform !== "win32") {
      const directoryDescriptor = fs.openSync(directoryFinal.canonicalAbsolute, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (published && destination && temporarySnapshot) {
      try {
        const publishedSnapshot = fs.lstatSync(destination, { bigint: true });
        if (samePathIdentity(temporarySnapshot, publishedSnapshot)) fs.unlinkSync(destination);
      } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

export function publishImmutableEvidenceArtifact({
  root = REPO_ROOT,
  relative,
  contents
} = {}) {
  if (typeof root !== "string"
    || !root
    || typeof relative !== "string"
    || !relative
    || typeof contents !== "string"
    || Buffer.byteLength(contents, "utf8") > MAX_EVIDENCE_RECORD_BYTES
    || !contents.endsWith("\n")
    || path.posix.normalize(relative) !== relative
    || relative.startsWith("/")
    || relative.includes("\\")
    || !relative.startsWith(`${EVIDENCE_ROOT}/`)) {
    throw unsafeEvidenceFileError();
  }
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw unsafeEvidenceFileError();
  }
  if (!rawEvidenceValueIsSafe(parsed)
    || `${JSON.stringify(parsed, null, 2)}\n` !== contents) {
    throw unsafeEvidenceFileError();
  }

  const file = path.resolve(root, ...relative.split("/"));
  const expected = path.join(path.resolve(root), ...relative.split("/"));
  if (file !== expected) throw unsafeEvidenceFileError();
  const directory = path.dirname(file);
  ensureEvidenceDirectory(root, directory);

  let existing;
  try {
    existing = readBoundedEvidenceFile(root, file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw unsafeEvidenceFileError();
  }
  if (existing !== undefined) {
    if (existing !== contents) throw unsafeEvidenceFileError();
    return relative;
  }

  try {
    publishImmutableEvidenceFile(root, file, contents);
  } catch (error) {
    if (error?.code === "EEXIST") {
      try {
        if (readBoundedEvidenceFile(root, file) === contents) return relative;
      } catch {}
    }
    throw unsafeEvidenceFileError();
  }
  return relative;
}

function fsyncEvidenceDirectory(directory) {
  if (process.platform === "win32") return;
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function ledgerLockDirectoryIdentity(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function sameLedgerLockDirectory(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function sameLedgerLockFile(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

export function exactFields(value, fields) {
  return Boolean(value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === fields.size
    && Object.keys(value).every((field) => fields.has(field)));
}

function ledgerLockFingerprint(identity, ownerToken = "ownerless") {
  return crypto
    .createHash("sha256")
    .update(`${identity.dev}:${identity.ino}:${ownerToken ?? "ownerless"}`)
    .digest("hex")
    .slice(0, 24);
}

function sleepSynchronously(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function readLedgerLockFileSnapshot(root, file) {
  const before = captureEvidencePathChain(root, file);
  const beforeFile = before.snapshots.at(-1);
  if (!beforeFile?.isFile() || beforeFile.size > BigInt(LEDGER_LOCK_RECORD_BYTES)) {
    throw evidenceLedgerLockError();
  }
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  let descriptor;
  try {
    descriptor = fs.openSync(before.canonicalAbsolute, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()
      || opened.size > BigInt(LEDGER_LOCK_RECORD_BYTES)
      || !sameFileSnapshot(beforeFile, opened)) throw evidenceLedgerLockError();
    const content = fs.readFileSync(descriptor);
    const afterOpen = fs.fstatSync(descriptor, { bigint: true });
    const after = captureEvidencePathChain(root, file);
    // Sibling lock generations legitimately change the evidence-directory
    // timestamps. Bind component identities and the opened file itself instead
    // of treating unrelated parent-directory metadata churn as record mutation.
    if (content.byteLength > LEDGER_LOCK_RECORD_BYTES
      || !samePathChain(before, after)
      || !sameFileSnapshot(opened, afterOpen)) throw evidenceLedgerLockError();
    return {
      contents: content.toString("utf8"),
      fileSnapshot: afterOpen
    };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function inspectLedgerLockJson(root, file) {
  let loaded;
  try {
    loaded = readLedgerLockFileSnapshot(root, file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw evidenceLedgerLockError();
  }
  try {
    return {
      value: JSON.parse(loaded.contents),
      contents: loaded.contents,
      identity: ledgerLockDirectoryIdentity(loaded.fileSnapshot),
      mtimeMs: Number(loaded.fileSnapshot.mtimeMs)
    };
  } catch {
    throw evidenceLedgerLockError();
  }
}

function validateLedgerLockOwner(record, directoryIdentity) {
  const fields = new Set(["schemaVersion", "token", "pid", "directory"]);
  const directoryFields = new Set(["dev", "ino"]);
  if (!exactFields(record, fields)
    || record.schemaVersion !== 1
    || typeof record.token !== "string"
    || !/^[a-f0-9]{64}$/.test(record.token)
    || !Number.isInteger(record.pid)
    || record.pid <= 0
    || !exactFields(record.directory, directoryFields)
    || typeof record.directory.dev !== "string"
    || typeof record.directory.ino !== "string"
    || !sameLedgerLockDirectory(record.directory, directoryIdentity)) {
    throw evidenceLedgerLockError();
  }
  return record;
}

function validateLedgerLockTransition(record) {
  const fields = new Set([
    "schemaVersion",
    "kind",
    "token",
    "pid",
    "target",
    "ownerToken"
  ]);
  const targetFields = new Set(["dev", "ino"]);
  if (!exactFields(record, fields)
    || record.schemaVersion !== 1
    || !["reclaim", "release"].includes(record.kind)
    || typeof record.token !== "string"
    || !/^[a-f0-9]{64}$/.test(record.token)
    || !Number.isInteger(record.pid)
    || record.pid <= 0
    || !exactFields(record.target, targetFields)
    || typeof record.target.dev !== "string"
    || typeof record.target.ino !== "string"
    || (record.ownerToken !== null
      && (typeof record.ownerToken !== "string" || !/^[a-f0-9]{64}$/.test(record.ownerToken)))) {
    throw evidenceLedgerLockError();
  }
  return record;
}

function assertSafeLedgerLockDirectoryEntries(lock) {
  let names;
  try {
    names = fs.readdirSync(lock);
  } catch {
    throw evidenceLedgerLockError();
  }
  const temporary = /^\.(?:owner|transition)\.json\.\d+\.[a-f0-9]{16}\.tmp$/;
  const witness = /^\.transition-(?:stale|owned)-[a-f0-9]{64}$/;
  for (const name of names) {
    if (name === LEDGER_LOCK_OWNER_FILE || name === LEDGER_LOCK_TRANSITION_FILE) continue;
    if (!temporary.test(name) && !witness.test(name)) throw evidenceLedgerLockError();
    try {
      const stat = fs.lstatSync(path.join(lock, name));
      if (stat.isSymbolicLink() || !stat.isFile()) throw evidenceLedgerLockError();
    } catch (error) {
      if (error?.code !== "ENOENT") throw evidenceLedgerLockError();
    }
  }
}

function currentLedgerLockDirectoryIdentity(lock) {
  let stat;
  try {
    stat = fs.lstatSync(lock, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw evidenceLedgerLockError();
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw evidenceLedgerLockError();
  return {
    identity: ledgerLockDirectoryIdentity(stat),
    mtimeMs: Number(stat.mtimeMs),
    stat
  };
}

function ledgerLockGenerationChanged(lock, expectedIdentity) {
  const current = currentLedgerLockDirectoryIdentity(lock);
  return !current || !sameLedgerLockDirectory(current.identity, expectedIdentity);
}

function inspectEvidenceLedgerLock(root, lock) {
  const initial = currentLedgerLockDirectoryIdentity(lock);
  if (!initial) return null;
  let loadedOwner;
  try {
    assertSafeLedgerLockDirectoryEntries(lock);
    loadedOwner = inspectLedgerLockJson(root, path.join(lock, LEDGER_LOCK_OWNER_FILE));
  } catch (error) {
    if (ledgerLockGenerationChanged(lock, initial.identity)) return null;
    throw error?.code === "E_EVIDENCE_LEDGER_LOCK" ? error : evidenceLedgerLockError();
  }
  if (ledgerLockGenerationChanged(lock, initial.identity)) return null;
  let owner = null;
  if (loadedOwner) {
    try {
      owner = validateLedgerLockOwner(loadedOwner.value, initial.identity);
    } catch (error) {
      if (ledgerLockGenerationChanged(lock, initial.identity)) return null;
      throw error;
    }
  }
  return {
    identity: initial.identity,
    mtimeMs: initial.mtimeMs,
    owner,
    ownerToken: owner?.token ?? null,
    ownerFingerprint: loadedOwner
      ? crypto.createHash("sha256").update(loadedOwner.contents).digest("hex")
      : null
  };
}

function inspectEvidenceLedgerTransition(root, lock) {
  const initial = currentLedgerLockDirectoryIdentity(lock);
  if (!initial) return null;
  let loaded;
  try {
    loaded = inspectLedgerLockJson(root, path.join(lock, LEDGER_LOCK_TRANSITION_FILE));
  } catch (error) {
    if (ledgerLockGenerationChanged(lock, initial.identity)) return null;
    throw error?.code === "E_EVIDENCE_LEDGER_LOCK" ? error : evidenceLedgerLockError();
  }
  if (ledgerLockGenerationChanged(lock, initial.identity)) return null;
  if (!loaded) return null;
  let transition;
  try {
    transition = validateLedgerLockTransition(loaded.value);
  } catch (error) {
    if (ledgerLockGenerationChanged(lock, initial.identity)) return null;
    throw error;
  }
  return {
    ...transition,
    identity: loaded.identity,
    mtimeMs: loaded.mtimeMs
  };
}

function sameLedgerLockTransition(left, right) {
  return Boolean(left
    && right
    && left.kind === right.kind
    && left.token === right.token
    && left.pid === right.pid
    && left.ownerToken === right.ownerToken
    && sameLedgerLockDirectory(left.target, right.target)
    && sameLedgerLockFile(left.identity, right.identity));
}

function ledgerLockTransitionBindsSnapshot(transition, snapshot) {
  return Boolean(transition
    && snapshot
    && transition.ownerToken === snapshot.ownerToken
    && sameLedgerLockDirectory(transition.target, snapshot.identity));
}

function ledgerLockOwnerIsDead(owner) {
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return null;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    if (error?.code === "EPERM") return false;
    return null;
  }
}

function evidenceLedgerLockIsReclaimable(snapshot, now = Date.now()) {
  if (!snapshot) return false;
  if (snapshot.owner) return ledgerLockOwnerIsDead(snapshot.owner) === true;
  return now - snapshot.mtimeMs >= LEDGER_LOCK_CONSTRUCTION_GRACE_MS;
}

function evidenceLedgerTransitionIsAbandoned(transition) {
  return ledgerLockOwnerIsDead(transition) === true;
}

function publishExclusiveLedgerLockJson(root, file, value) {
  const directory = path.dirname(file);
  const directoryBefore = captureEvidencePathChain(root, directory);
  const temporary = path.join(
    directoryBefore.canonicalAbsolute,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  const contents = `${JSON.stringify(value)}\n`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    const temporarySnapshot = fs.fstatSync(descriptor, { bigint: true });
    fs.closeSync(descriptor);
    descriptor = undefined;

    const directoryAfter = captureEvidencePathChain(root, directory);
    if (!samePathChain(directoryBefore, directoryAfter)) throw evidenceLedgerLockError();
    const destination = path.join(directoryAfter.canonicalAbsolute, path.basename(file));
    fs.linkSync(temporary, destination);
    const destinationSnapshot = fs.lstatSync(destination, { bigint: true });
    if (!destinationSnapshot.isFile()
      || !samePathIdentity(temporarySnapshot, destinationSnapshot)
      || temporarySnapshot.size !== destinationSnapshot.size) {
      throw evidenceLedgerLockError();
    }
    fs.unlinkSync(temporary);
    fsyncEvidenceDirectory(directoryAfter.canonicalAbsolute);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function sameLedgerLockOwnerGeneration(snapshot, generation, { allowMissingOwner = false } = {}) {
  if (!snapshot || !sameLedgerLockDirectory(snapshot.identity, generation.identity)) return false;
  if (snapshot.ownerToken === generation.ownerToken
    && snapshot.ownerFingerprint === generation.ownerFingerprint) return true;
  return allowMissingOwner
    && generation.ownerToken === null
    && snapshot.owner === null
    && snapshot.ownerFingerprint === null;
}

function clearAbandonedLedgerTransition(root, lock, expected) {
  if (!expected || !evidenceLedgerTransitionIsAbandoned(expected)) return false;
  const transitionFile = path.join(lock, LEDGER_LOCK_TRANSITION_FILE);
  const witness = path.join(lock, `.transition-stale-${expected.token}`);
  try {
    fs.linkSync(transitionFile, witness);
  } catch (error) {
    if (["EEXIST", "ENOENT"].includes(error?.code)) return false;
    throw evidenceLedgerLockError();
  }
  try {
    const pinned = inspectLedgerLockJson(root, witness);
    const current = inspectEvidenceLedgerTransition(root, lock);
    const pinnedTransition = pinned
      ? { ...validateLedgerLockTransition(pinned.value), identity: pinned.identity, mtimeMs: pinned.mtimeMs }
      : null;
    if (!sameLedgerLockTransition(pinnedTransition, expected)
      || !sameLedgerLockTransition(current, expected)
      || !evidenceLedgerTransitionIsAbandoned(pinnedTransition)) return false;
    fs.unlinkSync(transitionFile);
    fsyncEvidenceDirectory(lock);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  } finally {
    try { fs.unlinkSync(witness); } catch {}
  }
}

function removeOwnedLedgerTransition(root, lock, generation, transition) {
  const transitionFile = path.join(lock, LEDGER_LOCK_TRANSITION_FILE);
  const witness = path.join(lock, `.transition-owned-${transition.token}`);
  try {
    const currentLock = inspectEvidenceLedgerLock(root, lock);
    if (!sameLedgerLockOwnerGeneration(currentLock, generation, { allowMissingOwner: true })) return;
    fs.linkSync(transitionFile, witness);
    const pinned = inspectLedgerLockJson(root, witness);
    const current = inspectEvidenceLedgerTransition(root, lock);
    const pinnedTransition = pinned
      ? { ...validateLedgerLockTransition(pinned.value), identity: pinned.identity, mtimeMs: pinned.mtimeMs }
      : null;
    if (!sameLedgerLockTransition(pinnedTransition, transition)
      || !sameLedgerLockTransition(current, transition)) return;
    fs.unlinkSync(transitionFile);
    fsyncEvidenceDirectory(lock);
  } catch (error) {
    if (!["ENOENT", "EEXIST"].includes(error?.code)) throw evidenceLedgerLockError();
  } finally {
    try { fs.unlinkSync(witness); } catch {}
  }
}

function ownsEvidenceLedgerTransition(root, lock, generation, expected) {
  const currentLock = inspectEvidenceLedgerLock(root, lock);
  const currentTransition = inspectEvidenceLedgerTransition(root, lock);
  return Boolean(sameLedgerLockOwnerGeneration(
    currentLock,
    generation,
    { allowMissingOwner: generation.ownerToken === null }
  )
    && currentTransition
    && currentTransition.ownerToken === generation.ownerToken
    && sameLedgerLockDirectory(currentTransition.target, generation.identity)
    && sameLedgerLockTransition(currentTransition, expected));
}

function claimEvidenceLedgerTransition(root, lock, generation, kind) {
  const transition = {
    schemaVersion: 1,
    kind,
    token: crypto.randomBytes(32).toString("hex"),
    pid: process.pid,
    target: generation.identity,
    ownerToken: generation.ownerToken
  };
  const transitionFile = path.join(lock, LEDGER_LOCK_TRANSITION_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = inspectEvidenceLedgerLock(root, lock);
    if (!sameLedgerLockOwnerGeneration(
      current,
      generation,
      { allowMissingOwner: generation.ownerToken === null }
    )) return null;
    try {
      publishExclusiveLedgerLockJson(root, transitionFile, transition);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error?.code !== "EEXIST") throw evidenceLedgerLockError();
      const existing = inspectEvidenceLedgerTransition(root, lock);
      if (existing && !ledgerLockTransitionBindsSnapshot(existing, current)) {
        throw evidenceLedgerLockError();
      }
      if (attempt === 0 && existing && clearAbandonedLedgerTransition(root, lock, existing)) continue;
      return null;
    }
    const claimed = inspectEvidenceLedgerTransition(root, lock);
    if (claimed && ownsEvidenceLedgerTransition(root, lock, generation, claimed)) return claimed;
    if (claimed) removeOwnedLedgerTransition(root, lock, generation, claimed);
    return null;
  }
  return null;
}

function retireEvidenceLedgerLockGeneration(root, lock, generation, kind) {
  const transition = claimEvidenceLedgerTransition(root, lock, generation, kind);
  if (!transition) return false;
  let renamed = false;
  try {
    const current = inspectEvidenceLedgerLock(root, lock);
    if (!sameLedgerLockOwnerGeneration(
      current,
      generation,
      { allowMissingOwner: generation.ownerToken === null }
    )
      || (kind === "reclaim" && !evidenceLedgerLockIsReclaimable(generation))
      || !ownsEvidenceLedgerTransition(root, lock, generation, transition)) return false;

    const retired = `${lock}.retired-${kind}-${ledgerLockFingerprint(
      generation.identity,
      generation.ownerToken
    )}-${transition.token}`;
    fs.renameSync(lock, retired);
    renamed = true;
    const frozen = inspectEvidenceLedgerLock(root, retired);
    const frozenTransition = inspectEvidenceLedgerTransition(root, retired);
    if (!sameLedgerLockOwnerGeneration(
      frozen,
      generation,
      { allowMissingOwner: generation.ownerToken === null }
    )
      || !sameLedgerLockTransition(frozenTransition, transition)) {
      throw evidenceLedgerLockError();
    }
    fs.rmSync(retired, { recursive: true, force: true });
    fsyncEvidenceDirectory(path.dirname(lock));
    return true;
  } catch (error) {
    if (["EEXIST", "ENOTEMPTY", "ENOENT"].includes(error?.code)) return false;
    if (error?.code === "E_EVIDENCE_LEDGER_LOCK") throw error;
    throw evidenceLedgerLockError();
  } finally {
    if (!renamed) removeOwnedLedgerTransition(root, lock, generation, transition);
  }
}

function acquireEvidenceLedgerLock(root) {
  const evidenceDirectory = path.join(root, EVIDENCE_ROOT);
  try {
    ensureEvidenceDirectory(root, evidenceDirectory);
  } catch {
    throw evidenceLedgerLockError();
  }
  const lock = path.join(evidenceDirectory, LEDGER_LOCK_NAME);
  const deadline = Date.now() + LEDGER_LOCK_WAIT_MS;
  for (;;) {
    let created = false;
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw evidenceLedgerLockError();
    }
    if (created) {
      const stat = fs.lstatSync(lock, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw evidenceLedgerLockError();
      const ownerToken = crypto.randomBytes(32).toString("hex");
      let generation = {
        identity: ledgerLockDirectoryIdentity(stat),
        ownerToken: null,
        ownerFingerprint: null,
        owner: null,
        mtimeMs: Number(stat.mtimeMs)
      };
      try {
        publishExclusiveLedgerLockJson(root, path.join(lock, LEDGER_LOCK_OWNER_FILE), {
          schemaVersion: 1,
          token: ownerToken,
          pid: process.pid,
          directory: generation.identity
        });
        const published = inspectEvidenceLedgerLock(root, lock);
        if (!published
          || !sameLedgerLockDirectory(published.identity, generation.identity)
          || published.ownerToken !== ownerToken
          || inspectEvidenceLedgerTransition(root, lock)) {
          throw evidenceLedgerLockError();
        }
        generation = published;
        return { root, lock, generation };
      } catch (error) {
        try {
          retireEvidenceLedgerLockGeneration(root, lock, generation, "release");
        } catch {}
        if (error?.code === "E_EVIDENCE_LEDGER_LOCK") throw error;
        throw evidenceLedgerLockError();
      }
    }

    const existing = inspectEvidenceLedgerLock(root, lock);
    if (!existing) continue;
    const transition = inspectEvidenceLedgerTransition(root, lock);
    if (transition) {
      if (!ledgerLockTransitionBindsSnapshot(transition, existing)) {
        throw evidenceLedgerLockError();
      }
      if (clearAbandonedLedgerTransition(root, lock, transition)) continue;
    } else if (evidenceLedgerLockIsReclaimable(existing)
      && retireEvidenceLedgerLockGeneration(root, lock, existing, "reclaim")) {
      continue;
    }
    if (Date.now() >= deadline) throw evidenceLedgerLockError();
    sleepSynchronously(10);
  }
}

function releaseEvidenceLedgerLock(lease) {
  const deadline = Date.now() + LEDGER_LOCK_WAIT_MS;
  for (;;) {
    const current = inspectEvidenceLedgerLock(lease.root, lease.lock);
    if (!current
      || !sameLedgerLockOwnerGeneration(current, lease.generation)) return;
    if (retireEvidenceLedgerLockGeneration(
      lease.root,
      lease.lock,
      lease.generation,
      "release"
    )) return;
    if (Date.now() >= deadline) throw evidenceLedgerLockError();
    sleepSynchronously(10);
  }
}

export function withEvidenceLedgerLock(root, action) {
  const lease = acquireEvidenceLedgerLock(root);
  let result;
  let actionError;
  try {
    result = action();
  } catch (error) {
    actionError = error;
  }
  let releaseError;
  try {
    releaseEvidenceLedgerLock(lease);
  } catch (error) {
    releaseError = error;
  }
  if (actionError) {
    if (releaseError) {
      try {
        Object.defineProperty(actionError, LEDGER_LOCK_RELEASE_FAILURE, {
          configurable: false,
          enumerable: false,
          value: releaseError,
          writable: false
        });
      } catch {}
    }
    throw actionError;
  }
  if (releaseError) {
    try {
      Object.defineProperty(releaseError, LEDGER_LOCK_ACTION_COMPLETED, {
        configurable: false,
        enumerable: false,
        value: true,
        writable: false
      });
    } catch {}
    throw releaseError;
  }
  return result;
}
