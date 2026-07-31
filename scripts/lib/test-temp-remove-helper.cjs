"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  PROOF_SCHEMA,
  gitConfigSemantics,
  inspectMountBoundary,
  inspectContainedGitMetadata,
  stablePathProof
} = require("./test-temp-git-containment.cjs");

const LINUX_O_PATH = 0o10000000;
const GIT_MARKER_MAX_BYTES = 1024n * 1024n;
const WORKTREE_REGISTRATION_MAX_ENTRIES = 4096;
const TREE_FS_TYPE_ENV = "GROK_PLUGIN_TEST_TREE_FS_TYPE";
const TREE_MOUNT_ID_ENV = "GROK_PLUGIN_TEST_TREE_MOUNT_ID";
const REMOVE_DIAGNOSTIC_PATTERN =
  /(?:^|\n)grok-plugin-test-temp-remove-v1:(arguments|root-identity|mount-boundary|managed-proof|directory-inventory|entry-validation|recursive-removal|file-removal|directory-open|child-removal|root-removal):(1|42|43|44)(?=\n|$)/gu;
let removeDiagnosticStage = "arguments";

function writeRemoveDiagnostic(stage, status) {
  try {
    fs.writeSync(
      2,
      `grok-plugin-test-temp-remove-v1:${stage}:${status}\n`,
      null,
      "utf8"
    );
  } catch {
    // Diagnostics never weaken or replace the fail-closed removal result.
  }
}

process.once("exit", (code) => {
  if (code !== 0) {
    writeRemoveDiagnostic(removeDiagnosticStage, code);
  }
});

function asciiCaseEqual(left, right) {
  return left.length === right.length && left.toLowerCase() === right;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function optionalNoFollowStat(target) {
  try {
    return fs.lstatSync(target, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function onTreeDevice(stat, expectedTreeDev) {
  return stat.dev === expectedTreeDev;
}

function safeMarkerFile(stat, expectedTreeDev) {
  return Boolean(
    stat
    && onTreeDevice(stat, expectedTreeDev)
    && stat.isFile()
    && !stat.isSymbolicLink()
    && stat.size >= 0n
    && stat.size <= GIT_MARKER_MAX_BYTES
  );
}

function safeMarkerDirectory(stat, expectedTreeDev) {
  return Boolean(
    stat
    && onTreeDevice(stat, expectedTreeDev)
    && stat.isDirectory()
    && !stat.isSymbolicLink()
  );
}

function stableMarkerContents(target, expectedTreeDev, expectedUid) {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
    throw new Error("No-follow Git config reads are unavailable.");
  }
  const before = fs.lstatSync(target, { bigint: true });
  if (
    !safeMarkerFile(before, expectedTreeDev)
    || before.uid !== expectedUid
    || before.nlink !== 1n
    || (before.mode & 0o022n) !== 0n
  ) {
    throw new Error("Git config identity is unsafe.");
  }
  let descriptor;
  try {
    descriptor = fs.openSync(
      target,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    const openedBefore = fs.fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== openedBefore.dev
      || before.ino !== openedBefore.ino
      || before.mode !== openedBefore.mode
      || before.uid !== openedBefore.uid
      || before.nlink !== openedBefore.nlink
      || before.size !== openedBefore.size
      || before.mtimeNs !== openedBefore.mtimeNs
      || before.ctimeNs !== openedBefore.ctimeNs
    ) {
      throw new Error("Git config changed before it was opened.");
    }
    const contents = fs.readFileSync(descriptor);
    const openedAfter = fs.fstatSync(descriptor, { bigint: true });
    const after = fs.lstatSync(target, { bigint: true });
    if (
      BigInt(contents.length) !== openedAfter.size
      || openedBefore.dev !== openedAfter.dev
      || openedBefore.ino !== openedAfter.ino
      || openedBefore.mode !== openedAfter.mode
      || openedBefore.uid !== openedAfter.uid
      || openedBefore.size !== openedAfter.size
      || openedBefore.mtimeNs !== openedAfter.mtimeNs
      || openedBefore.ctimeNs !== openedAfter.ctimeNs
      || openedAfter.dev !== after.dev
      || openedAfter.ino !== after.ino
      || openedAfter.mode !== after.mode
      || openedAfter.uid !== after.uid
      || openedAfter.size !== after.size
      || openedAfter.mtimeNs !== after.mtimeNs
      || openedAfter.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("Git config changed while it was read.");
    }
    return contents;
  } finally {
    if (Number.isInteger(descriptor)) fs.closeSync(descriptor);
  }
}

function dangerousConfigFile(target, expectedTreeDev, expectedUid) {
  try {
    const semantics = gitConfigSemantics(
      stableMarkerContents(target, expectedTreeDev, expectedUid)
    );
    return !semantics.safe || semantics.worktrees.length > 0;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return true;
  }
}

function dangerousGitConfigs(target, expectedTreeDev, expectedUid) {
  return ["config", "config.worktree"].some((name) => (
    dangerousConfigFile(
      path.join(target, name),
      expectedTreeDev,
      expectedUid
    )
  ));
}

function dangerousDotGitDirectory(target, expectedTreeDev, expectedUid) {
  for (const control of ["commondir", "gitdir", "modules", "worktrees"]) {
    if (optionalNoFollowStat(path.join(target, control))) return true;
  }
  return dangerousGitConfigs(target, expectedTreeDev, expectedUid);
}

function dangerousRegistrationDirectory(target, expectedTreeDev, expectedUid) {
  return Boolean(
    optionalNoFollowStat(path.join(target, "gitdir"))
    || optionalNoFollowStat(path.join(target, "commondir"))
    || dangerousGitConfigs(target, expectedTreeDev, expectedUid)
  );
}

function gitCommonDirectoryShape(target, expectedTreeDev) {
  const head = optionalNoFollowStat(path.join(target, "HEAD"));
  const config = optionalNoFollowStat(path.join(target, "config"));
  const objects = optionalNoFollowStat(path.join(target, "objects"));
  const refs = optionalNoFollowStat(path.join(target, "refs"));
  const reftable = optionalNoFollowStat(path.join(target, "reftable"));
  return safeMarkerFile(head, expectedTreeDev)
    && safeMarkerFile(config, expectedTreeDev)
    && safeMarkerDirectory(objects, expectedTreeDev)
    && (
      safeMarkerDirectory(refs, expectedTreeDev)
      || safeMarkerDirectory(reftable, expectedTreeDev)
    );
}

function worktreesContainRegistrationControls(
  target,
  expectedTreeDev,
  expectedUid
) {
  const entries = fs.readdirSync(target);
  if (entries.length > WORKTREE_REGISTRATION_MAX_ENTRIES) return true;
  for (const entry of entries) {
    const registration = path.join(target, entry);
    const registrationStat = fs.lstatSync(registration, { bigint: true });
    if (!safeMarkerDirectory(registrationStat, expectedTreeDev)) continue;
    const gitdir = optionalNoFollowStat(path.join(registration, "gitdir"));
    const commondir = optionalNoFollowStat(path.join(registration, "commondir"));
    if (
      !gitdir
      && !commondir
      && !dangerousGitConfigs(registration, expectedTreeDev, expectedUid)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function dangerousWorktreesDirectory(
  target,
  parent,
  expectedTreeDev,
  expectedUid
) {
  return dangerousGitConfigs(parent, expectedTreeDev, expectedUid)
    || gitCommonDirectoryShape(parent, expectedTreeDev)
    || worktreesContainRegistrationControls(
      target,
      expectedTreeDev,
      expectedUid
    );
}

function sameDirectoryIdentity(stat, expected) {
  return (
    stat.dev === expected.dev
    && stat.ino === expected.ino
    && stat.isDirectory()
    && !stat.isSymbolicLink()
  );
}

function sameExactIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function commonGitShapeFromEntries(entries, expectedTreeDev) {
  const selected = new Map();
  for (const value of entries) {
    const folded = value.entry.toLowerCase();
    if (!["head", "config", "objects", "refs", "reftable"].includes(folded)) {
      continue;
    }
    if (selected.has(folded)) return { ambiguous: true, present: false };
    selected.set(folded, value.stat);
  }
  return {
    ambiguous: false,
    present: safeMarkerFile(selected.get("head"), expectedTreeDev)
      && safeMarkerFile(selected.get("config"), expectedTreeDev)
      && safeMarkerDirectory(selected.get("objects"), expectedTreeDev)
      && (
        safeMarkerDirectory(selected.get("refs"), expectedTreeDev)
        || safeMarkerDirectory(selected.get("reftable"), expectedTreeDev)
      )
  };
}

function sameProofIdentity(left, right) {
  return Boolean(
    left
    && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
  );
}

function linuxMountId(descriptor) {
  if (process.platform !== "linux") return null;
  const contents = fs.readFileSync(
    `/proc/self/fdinfo/${descriptor}`,
    "utf8"
  );
  const matches = [...contents.matchAll(/^mnt_id:\s+([0-9]+)$/gmu)];
  if (matches.length !== 1) {
    throw new Error("Linux mount identity is unavailable.");
  }
  return matches[0][1];
}

function assertDescriptorMount(descriptor, expectedMountId) {
  if (
    process.platform === "linux"
    && linuxMountId(descriptor) !== expectedMountId
  ) {
    process.exit(43);
  }
}

function openVerifiedDirectory(
  entry,
  expected,
  expectedMountId,
  allowPermissionRepair = true
) {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW) || fs.constants.O_NOFOLLOW === 0) {
    throw new Error("Safe no-follow directory access is unavailable.");
  }
  const readFlags = fs.constants.O_RDONLY
    | (fs.constants.O_DIRECTORY || 0)
    | fs.constants.O_NOFOLLOW;
  try {
    const descriptor = fs.openSync(entry, readFlags);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameDirectoryIdentity(opened, expected)) {
      fs.closeSync(descriptor);
      process.exit(43);
    }
    assertDescriptorMount(descriptor, expectedMountId);
    return { descriptor, repaired: false };
  } catch (error) {
    if (error?.code !== "EACCES" && error?.code !== "EPERM") throw error;
    if (!allowPermissionRepair) throw error;
  }

  if (process.platform === "linux") {
    const descriptor = fs.openSync(
      entry,
      LINUX_O_PATH
        | (fs.constants.O_DIRECTORY || 0)
        | fs.constants.O_NOFOLLOW
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameDirectoryIdentity(opened, expected)) {
      fs.closeSync(descriptor);
      process.exit(43);
    }
    assertDescriptorMount(descriptor, expectedMountId);
    // O_PATH pins the verified inode without requiring read permission.
    // chmod through that descriptor cannot follow a raced replacement path.
    let reopenedDescriptor;
    try {
      fs.chmodSync(`/proc/self/fd/${descriptor}`, 0o700);
      reopenedDescriptor = fs.openSync(entry, readFlags);
      const reopened = fs.fstatSync(reopenedDescriptor, { bigint: true });
      if (
        !sameDirectoryIdentity(reopened, expected)
        || linuxMountId(reopenedDescriptor) !== expectedMountId
      ) {
        throw new Error("Repaired directory identity changed before reopening.");
      }
    } catch (error) {
      if (Number.isInteger(reopenedDescriptor)) {
        fs.closeSync(reopenedDescriptor);
      }
      let restoreError = null;
      try {
        fs.chmodSync(
          `/proc/self/fd/${descriptor}`,
          Number(expected.mode & 0o7777n)
        );
      } catch (caught) {
        restoreError = caught;
      } finally {
        fs.closeSync(descriptor);
      }
      if (restoreError) throw restoreError;
      throw error;
    }
    fs.closeSync(descriptor);
    return { descriptor: reopenedDescriptor, repaired: true };
  }

  // Linux O_PATH is the only supported way to pin a permission-locked inode
  // before changing it. Other platforms fail closed and report the residual.
  throw new Error("Safe permission repair is unavailable.");
}

function restoreDirectoryMode(entry, expected, expectedMountId) {
  const reopened = openVerifiedDirectory(
    entry,
    expected,
    expectedMountId,
    false
  );
  try {
    fs.fchmodSync(
      reopened.descriptor,
      Number(expected.mode & 0o7777n)
    );
  } finally {
    fs.closeSync(reopened.descriptor);
  }
}

const [
  rawExpectedDev,
  rawExpectedIno,
  rawExpectedTreeDev = rawExpectedDev,
  cleanupMode = "guarded",
  gitContext = "none",
  originalManagedRoot = "",
  managedRoot = "",
  rawExpectedUid = "",
  expectedGitDigest = ""
] = process.argv.slice(2);
if (
  !/^(?:0|[1-9][0-9]*)$/u.test(rawExpectedDev || "")
  || !/^(?:0|[1-9][0-9]*)$/u.test(rawExpectedIno || "")
  || !/^(?:0|[1-9][0-9]*)$/u.test(rawExpectedTreeDev || "")
  || !["guarded", "managed-contained"].includes(cleanupMode)
  || !["none", "dotgit", "modules", "registration", "worktrees"].includes(
    gitContext
  )
  || (
    cleanupMode === "managed-contained"
    && (
      !path.isAbsolute(originalManagedRoot)
      || !path.isAbsolute(managedRoot)
      || !/^(?:0|[1-9][0-9]*)$/u.test(rawExpectedUid)
      || !/^[a-f0-9]{64}$/u.test(expectedGitDigest)
    )
  )
) {
  process.exit(42);
}
const expectedDev = BigInt(rawExpectedDev);
const expectedIno = BigInt(rawExpectedIno);
const expectedTreeDev = BigInt(rawExpectedTreeDev);
const expectedUid = cleanupMode === "managed-contained"
  ? BigInt(rawExpectedUid)
  : null;
removeDiagnosticStage = "root-identity";
const original = fs.lstatSync(".", { bigint: true });
if (
  !original.isDirectory()
  || original.isSymbolicLink()
  || original.dev !== expectedDev
  || original.ino !== expectedIno
  || original.dev !== expectedTreeDev
) {
  process.exit(42);
}
const ownerUid = original.uid;
removeDiagnosticStage = "mount-boundary";
const currentFsType = fs.statfsSync(".", { bigint: true }).type;
const inheritedFsType = process.env[TREE_FS_TYPE_ENV];
if (
  inheritedFsType !== undefined
  && !/^-?[0-9]+$/u.test(inheritedFsType)
) {
  process.exit(43);
}
const expectedFsType = inheritedFsType === undefined
  ? currentFsType
  : BigInt(inheritedFsType);
if (currentFsType !== expectedFsType) process.exit(43);
let expectedMountId = null;
if (process.platform === "linux") {
  const inheritedMountId = process.env[TREE_MOUNT_ID_ENV];
  if (
    inheritedMountId !== undefined
    && !/^(?:0|[1-9][0-9]*)$/u.test(inheritedMountId)
  ) {
    process.exit(43);
  }
  const descriptor = fs.openSync(
    ".",
    fs.constants.O_RDONLY
      | (fs.constants.O_DIRECTORY || 0)
      | fs.constants.O_NOFOLLOW
  );
  try {
    const currentMountId = linuxMountId(descriptor);
    expectedMountId = inheritedMountId ?? currentMountId;
    if (currentMountId !== expectedMountId) process.exit(43);
  } finally {
    fs.closeSync(descriptor);
  }
}
const mountBoundary = inspectMountBoundary(fs.realpathSync("."));
if (!mountBoundary.available || mountBoundary.nested.length > 0) {
  process.exit(43);
}

let managedProof = null;
if (cleanupMode === "managed-contained") {
  removeDiagnosticStage = "managed-proof";
  const canonicalManagedRoot = path.resolve(managedRoot);
  const currentDirectory = fs.realpathSync(".");
  if (!isWithin(canonicalManagedRoot, currentDirectory)) process.exit(43);
  if (currentDirectory === canonicalManagedRoot) {
    const inspection = inspectContainedGitMetadata({
      root: canonicalManagedRoot,
      originalRoot: originalManagedRoot,
      expectedUid,
      expectedDev: expectedTreeDev
    });
    if (
      !inspection.available
      || inspection.digest !== expectedGitDigest
      || inspection.proof?.schema !== PROOF_SCHEMA
    ) {
      process.exit(43);
    }
    managedProof = inspection.proof;
  } else {
    try {
      const supplied = JSON.parse(fs.readFileSync(0, "utf8"));
      if (
        supplied?.schema !== PROOF_SCHEMA
        || !supplied.controls
        || !supplied.directories
        || !supplied.restricted
        || Array.isArray(supplied.controls)
        || Array.isArray(supplied.directories)
        || Array.isArray(supplied.restricted)
      ) {
        process.exit(43);
      }
      managedProof = supplied;
    } catch {
      process.exit(43);
    }
  }
}

function managedRelative(target) {
  const root = path.resolve(managedRoot);
  const resolved = path.resolve(target);
  if (!isWithin(root, resolved)) process.exit(43);
  return path.relative(root, resolved);
}

function expectedManagedProof(target) {
  if (!managedProof) return null;
  const relative = managedRelative(target);
  for (const values of [
    managedProof.controls,
    managedProof.directories,
    managedProof.restricted
  ]) {
    if (Object.hasOwn(values, relative)) return values[relative];
  }
  return null;
}

function validateManagedProof(target, required = false) {
  if (!managedProof) return;
  const expected = expectedManagedProof(target);
  if (!expected) {
    if (required) process.exit(43);
    return;
  }
  let current;
  try {
    current = stablePathProof(target, expectedUid, expectedTreeDev);
  } catch {
    process.exit(43);
  }
  if (
    !sameProofIdentity(current.identity, expected.identity)
    || (
      Object.hasOwn(expected, "digest")
      && current.digest !== expected.digest
    )
  ) {
    process.exit(43);
  }
}

function managedEntryRequiresProof(entry, stat) {
  if (cleanupMode !== "managed-contained") return false;
  if (asciiCaseEqual(entry, ".git")) return true;
  if (
    gitContext === "registration"
    && ["gitdir", "commondir"].some((name) => asciiCaseEqual(entry, name))
  ) {
    return true;
  }
  if (
    (
      gitContext === "dotgit"
      || gitContext === "modules"
    )
    && [
      "config",
      "config.worktree",
      "gitdir",
      "commondir",
      "modules",
      "worktrees"
    ].some(
      (name) => asciiCaseEqual(entry, name)
    )
  ) {
    return true;
  }
  return Boolean(stat && expectedManagedProof(entry));
}

function childManagedProof(entry) {
  if (!managedProof) return null;
  const relative = managedRelative(entry);
  const prefix = relative ? `${relative}${path.sep}` : "";
  const select = (values) => Object.fromEntries(
    Object.entries(values).filter(([name]) => (
      name === relative || name.startsWith(prefix)
    ))
  );
  return {
    schema: PROOF_SCHEMA,
    controls: select(managedProof.controls),
    directories: select(managedProof.directories),
    restricted: select(managedProof.restricted)
  };
}

function expandRestrictedManagedProof() {
  if (!managedProof || cleanupMode !== "managed-contained") return;
  const relative = managedRelative(".");
  if (!Object.hasOwn(managedProof.restricted, relative)) return;
  const inspection = inspectContainedGitMetadata({
    root: managedRoot,
    originalRoot: originalManagedRoot,
    scanRoot: fs.realpathSync("."),
    expectedUid,
    expectedDev: expectedTreeDev
  });
  if (!inspection.available || inspection.proof?.schema !== PROOF_SCHEMA) {
    process.exit(43);
  }
  const nextRestricted = { ...managedProof.restricted };
  delete nextRestricted[relative];
  managedProof = {
    schema: PROOF_SCHEMA,
    controls: {
      ...managedProof.controls,
      ...inspection.proof.controls
    },
    directories: {
      ...managedProof.directories,
      ...inspection.proof.directories
    },
    restricted: {
      ...nextRestricted,
      ...inspection.proof.restricted
    }
  };
}

function childGitContext(entry) {
  if (asciiCaseEqual(entry, ".git")) return "dotgit";
  if (asciiCaseEqual(entry, "worktrees")) return "worktrees";
  if (gitContext === "worktrees") return "registration";
  if (
    gitContext === "modules"
    || (gitContext === "dotgit" && asciiCaseEqual(entry, "modules"))
  ) {
    return "modules";
  }
  return "none";
}

expandRestrictedManagedProof();
removeDiagnosticStage = "directory-inventory";

if (
  cleanupMode === "guarded"
  && gitContext === "dotgit"
  && dangerousDotGitDirectory(".", expectedTreeDev, ownerUid)
) {
  process.exit(43);
}
if (
  cleanupMode === "guarded"
  &&
  gitContext === "registration"
  && dangerousRegistrationDirectory(".", expectedTreeDev, ownerUid)
) {
  process.exit(43);
}
if (
  cleanupMode === "guarded"
  &&
  gitContext === "worktrees"
  && dangerousWorktreesDirectory(
    ".",
    "..",
    expectedTreeDev,
    ownerUid
  )
) {
  process.exit(43);
}

const entryNames = fs.readdirSync(".");
if (cleanupMode === "managed-contained") {
  entryNames.sort((left, right) => {
    const leftRestricted = Object.keys(
      childManagedProof(left).restricted
    ).length > 0;
    const rightRestricted = Object.keys(
      childManagedProof(right).restricted
    ).length > 0;
    if (leftRestricted !== rightRestricted) return leftRestricted ? -1 : 1;
    return left < right ? -1 : (left > right ? 1 : 0);
  });
}
removeDiagnosticStage = "entry-validation";
const entries = entryNames.map((entry) => {
  const stat = fs.lstatSync(entry, { bigint: true });
  if (!onTreeDevice(stat, expectedTreeDev)) process.exit(43);
  if (
    stat.isDirectory()
    && !stat.isSymbolicLink()
    && fs.statfsSync(entry, { bigint: true }).type !== expectedFsType
  ) {
    process.exit(43);
  }
  validateManagedProof(entry, managedEntryRequiresProof(entry, stat));
  if (cleanupMode === "guarded" && asciiCaseEqual(entry, ".git")) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) process.exit(43);
    if (dangerousDotGitDirectory(
      entry,
      expectedTreeDev,
      ownerUid
    )) {
      process.exit(43);
    }
  }
  if (
    cleanupMode === "guarded"
    && gitContext === "registration"
    && (
      asciiCaseEqual(entry, "gitdir")
      || asciiCaseEqual(entry, "commondir")
    )
  ) {
    process.exit(43);
  }
  if (
    cleanupMode === "guarded"
    && gitContext === "dotgit"
    && ["commondir", "gitdir", "modules", "worktrees"].some(
      (control) => asciiCaseEqual(entry, control)
    )
  ) {
    process.exit(43);
  }
  if (
    cleanupMode === "guarded"
    && (gitContext === "dotgit" || gitContext === "registration")
    && ["config", "config.worktree"].some(
      (control) => asciiCaseEqual(entry, control)
    )
    && dangerousConfigFile(entry, expectedTreeDev, ownerUid)
  ) {
    process.exit(43);
  }
  if (
    cleanupMode === "guarded"
    && asciiCaseEqual(entry, "worktrees")
    && (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || dangerousWorktreesDirectory(
        entry,
        ".",
        expectedTreeDev,
        ownerUid
      )
    )
  ) {
    process.exit(43);
  }
  return { entry, stat };
});
{
  const mountBoundary = inspectMountBoundary(fs.realpathSync("."));
  if (!mountBoundary.available || mountBoundary.nested.length > 0) process.exit(43);
}
const commonGitShape = commonGitShapeFromEntries(entries, expectedTreeDev);
const registrationControlInventory = gitContext === "registration"
  ? entries.filter(({ entry }) => (
    asciiCaseEqual(entry, "gitdir")
    || asciiCaseEqual(entry, "commondir")
  ))
  : [];
const registrationControlsPresent = registrationControlInventory.length > 0;
function revalidateRegistrationControls() {
  if (gitContext !== "registration") return;
  let currentNames;
  try {
    currentNames = fs.readdirSync(".")
      .filter((entry) => (
        asciiCaseEqual(entry, "gitdir")
        || asciiCaseEqual(entry, "commondir")
      ))
      .sort();
  } catch {
    process.exit(43);
  }
  const inventoriedNames = registrationControlInventory
    .map(({ entry }) => entry)
    .sort();
  if (
    currentNames.length !== inventoriedNames.length
    || currentNames.some((entry, index) => entry !== inventoriedNames[index])
  ) {
    process.exit(43);
  }
  for (const { entry, stat } of registrationControlInventory) {
    let current;
    try {
      current = fs.lstatSync(entry, { bigint: true });
    } catch {
      process.exit(43);
    }
    if (!sameExactIdentity(stat, current)) process.exit(43);
    validateManagedProof(entry, cleanupMode === "managed-contained");
  }
}
const directoryAfterInventory = fs.lstatSync(".", { bigint: true });
if (
  commonGitShape.ambiguous
  || !sameExactIdentity(original, directoryAfterInventory)
) {
  process.exit(43);
}
if (commonGitShape.present) {
  if (cleanupMode === "managed-contained") {
    validateManagedProof(path.resolve("config"), true);
  } else if (dangerousGitConfigs(".", expectedTreeDev, ownerUid)) {
    process.exit(43);
  }
}
if (cleanupMode === "managed-contained" && registrationControlsPresent) {
  for (const { entry } of entries) {
    if (
      ["config", "config.worktree"].some(
        (control) => asciiCaseEqual(entry, control)
      )
    ) {
      validateManagedProof(entry, true);
    }
  }
}

removeDiagnosticStage = "recursive-removal";
for (const { entry, stat } of entries) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    removeDiagnosticStage = "file-removal";
    const current = fs.lstatSync(entry, { bigint: true });
    if (
      !onTreeDevice(current, expectedTreeDev)
      || current.dev !== stat.dev
      || current.ino !== stat.ino
      || current.isDirectory()
    ) {
      process.exit(43);
    }
    validateManagedProof(entry, managedEntryRequiresProof(entry, current));
    const isConfig = ["config", "config.worktree"].some(
      (control) => asciiCaseEqual(entry, control)
    );
    if (
      (commonGitShape.present || registrationControlsPresent)
      && isConfig
    ) {
      if (cleanupMode === "managed-contained") {
        validateManagedProof(entry, true);
      } else if (dangerousConfigFile(entry, expectedTreeDev, ownerUid)) {
        process.exit(43);
      }
    }
    if (
      cleanupMode === "guarded"
      && (gitContext === "dotgit" || gitContext === "registration")
      && ["config", "config.worktree"].some(
        (control) => asciiCaseEqual(entry, control)
      )
      && dangerousConfigFile(entry, expectedTreeDev, ownerUid)
    ) {
      process.exit(43);
    }
    if (isConfig) revalidateRegistrationControls();
    fs.unlinkSync(entry);
    continue;
  }

  removeDiagnosticStage = "directory-open";
  const openedDirectory = openVerifiedDirectory(
    entry,
    stat,
    expectedMountId
  );
  const descriptor = openedDirectory.descriptor;
  if (
    cleanupMode === "managed-contained"
    && openedDirectory.repaired
    && !Object.hasOwn(
      managedProof.restricted,
      managedRelative(entry)
    )
  ) {
    try {
      fs.fchmodSync(descriptor, Number(stat.mode & 0o7777n));
    } finally {
      fs.closeSync(descriptor);
    }
    process.exit(43);
  }
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameDirectoryIdentity(opened, stat)) process.exit(43);
    const desiredMode = stat.mode | 0o700n;
    if (desiredMode !== stat.mode) {
      fs.fchmodSync(descriptor, Number(desiredMode & 0o7777n));
      openedDirectory.modeChanged = true;
    }
  } finally {
    fs.closeSync(descriptor);
  }

  let result;
  try {
    removeDiagnosticStage = "child-removal";
    result = spawnSync(process.execPath, [
      __filename,
      String(stat.dev),
      String(stat.ino),
      String(expectedTreeDev),
      cleanupMode,
      childGitContext(entry),
      originalManagedRoot,
      managedRoot,
      rawExpectedUid,
      expectedGitDigest
    ], {
      cwd: entry,
      env: {
        GROK_PLUGIN_TEST_CHILD_HOOK_BYPASS: "1",
        [TREE_FS_TYPE_ENV]: String(expectedFsType),
        ...(expectedMountId === null
          ? {}
          : { [TREE_MOUNT_ID_ENV]: expectedMountId })
      },
      encoding: "utf8",
      shell: false,
      maxBuffer: 8 * 1024,
      input: cleanupMode === "managed-contained"
        ? JSON.stringify(childManagedProof(entry))
        : undefined
    });
  } catch (error) {
    if (openedDirectory.repaired || openedDirectory.modeChanged) {
      try {
        restoreDirectoryMode(entry, stat, expectedMountId);
      } catch {
        process.exit(43);
      }
    }
    throw error;
  }
  if (result.status !== 0 || result.error || result.signal) {
    const nestedDiagnostics = [
      ...String(result.stderr || "").matchAll(REMOVE_DIAGNOSTIC_PATTERN)
    ];
    if (nestedDiagnostics.length > 0) {
      writeRemoveDiagnostic(
        nestedDiagnostics[0][1],
        nestedDiagnostics[0][2]
      );
    }
    if (openedDirectory.repaired || openedDirectory.modeChanged) {
      try {
        const current = fs.lstatSync(entry, { bigint: true });
        if (
          current.dev !== stat.dev
          || current.ino !== stat.ino
          || !current.isDirectory()
          || current.isSymbolicLink()
        ) {
          process.exit(43);
        }
        restoreDirectoryMode(entry, stat, expectedMountId);
      } catch {
        process.exit(43);
      }
    }
    process.exit(result.status === 42 || result.status === 43 ? result.status : 44);
  }
}

removeDiagnosticStage = "root-removal";
const basename = path.basename(process.cwd());
process.chdir("..");
const emptied = fs.lstatSync(basename, { bigint: true });
if (
  !emptied.isDirectory()
  || emptied.isSymbolicLink()
  || emptied.dev !== expectedDev
  || emptied.ino !== expectedIno
) {
  process.exit(43);
}
fs.rmdirSync(basename);
