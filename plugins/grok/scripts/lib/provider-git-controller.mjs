import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { CompanionError } from "./errors.mjs";
import { childEnvironment } from "./provider-core.mjs";

export function pathsOverlap(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return a === b
    || a.startsWith(`${b}${path.sep}`)
    || b.startsWith(`${a}${path.sep}`);
}

export function executableFromPath(name, pathValue = process.env.PATH) {
  if (typeof name !== "string"
    || !/^[a-zA-Z0-9._-]+$/.test(name)
    || typeof pathValue !== "string") {
    throw new CompanionError(
      "E_CAPABILITY",
      "A trusted provider executable could not be resolved."
    );
  }
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const executableDirectory = fs.realpathSync(directory);
      const commandPath = path.join(executableDirectory, name);
      const executable = fs.realpathSync(commandPath);
      const stat = fs.lstatSync(executable);
      const parentStat = fs.lstatSync(executableDirectory);
      if (stat.isFile()
        && !stat.isSymbolicLink()
        && parentStat.isDirectory()
        && !parentStat.isSymbolicLink()) {
        return Object.freeze({
          commandPath,
          executable,
          executableDirectory
        });
      }
    } catch {
      // Continue to the next canonical PATH entry.
    }
  }
  throw new CompanionError(
    "E_CAPABILITY",
    `The ${name} executable is unavailable on the trusted host PATH.`
  );
}

export function trustedGitInstallation(root, pathValue = process.env.PATH) {
  const located = executableFromPath("git", pathValue);
  const { commandPath, executable, executableDirectory } = located;
  const canonicalWorkspace = fs.realpathSync(root);
  if (pathsOverlap(executable, canonicalWorkspace)
    || pathsOverlap(executableDirectory, canonicalWorkspace)) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Refusing a repository-controlled Git executable for official provisioning."
    );
  }
  const installationCandidates = [
    "/opt/homebrew",
    "/usr/local"
  ];
  const installationRoot = installationCandidates.find((candidate) => (
    executable.startsWith(`${candidate}${path.sep}`)
  )) || path.dirname(executable);
  const canonicalInstallationRoot = fs.realpathSync(installationRoot);
  if (canonicalInstallationRoot === path.parse(canonicalInstallationRoot).root
    || pathsOverlap(canonicalInstallationRoot, canonicalWorkspace)) {
    throw new CompanionError(
      "E_CAPABILITY",
      "The Git installation root is too broad or repository-controlled."
    );
  }
  const stat = fs.statSync(executable);
  const parentStat = fs.statSync(executableDirectory);
  return Object.freeze({
    commandPath,
    executable,
    executableDirectory,
    installationRoot: canonicalInstallationRoot,
    executableDigest: crypto
      .createHash("sha256")
      .update(fs.readFileSync(executable))
      .digest("hex"),
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    parentDevice: parentStat.dev,
    parentInode: parentStat.ino
  });
}

export function recaptureTrustedGitInstallation(identity) {
  const executableDirectory = fs.realpathSync(path.dirname(identity.commandPath));
  const executable = fs.realpathSync(identity.commandPath);
  const installationRoot = fs.realpathSync(identity.installationRoot);
  const stat = fs.statSync(executable);
  const parentStat = fs.statSync(executableDirectory);
  return Object.freeze({
    commandPath: path.join(executableDirectory, path.basename(identity.commandPath)),
    executable,
    executableDirectory,
    installationRoot,
    executableDigest: crypto
      .createHash("sha256")
      .update(fs.readFileSync(executable))
      .digest("hex"),
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    parentDevice: parentStat.dev,
    parentInode: parentStat.ino
  });
}

export function sameTrustedGitInstallation(left, right) {
  return Boolean(
    left
    && right
    && left.commandPath === right.commandPath
    && left.executable === right.executable
    && left.executableDirectory === right.executableDirectory
    && left.installationRoot === right.installationRoot
    && left.executableDigest === right.executableDigest
    && left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.parentDevice === right.parentDevice
    && left.parentInode === right.parentInode
  );
}

export function canonicalGitCommonDirectory(gitInstallation, workspaceRoot) {
  const gitEnvironment = controllerGitEnvironment(gitInstallation);
  const run = spawnSync(
    gitInstallation.executable,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      shell: false,
      timeout: 10_000,
      env: gitEnvironment
    }
  );
  const value = String(run.stdout || "").trim();
  if (run.status !== 0
    || run.error
    || !value
    || !path.isAbsolute(value)
    || path.normalize(value) !== value) {
    throw new CompanionError(
      "E_CAPABILITY",
      "The exact Git common directory could not be resolved for official provisioning."
    );
  }
  const resolved = fs.realpathSync(value);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CompanionError(
      "E_CAPABILITY",
      "The exact Git common directory is unsafe."
    );
  }
  return resolved;
}

export function controllerGitEnvironment(gitInstallation) {
  const overrides = [
    ["core.hooksPath", "/dev/null"],
    ["core.fsmonitor", "false"],
    ["core.attributesFile", "/dev/null"],
    ["submodule.recurse", "false"]
  ];
  return childEnvironment({
    PATH: gitInstallation.executableDirectory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: String(overrides.length),
    ...Object.fromEntries(overrides.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value]
    ]))
  });
}

export function boundedGitRun(gitInstallation, workspaceRoot, args, {
  input = undefined,
  maxBuffer = 8 * 1024 * 1024
} = {}) {
  const run = spawnSync(gitInstallation.executable, args, {
    cwd: workspaceRoot,
    encoding: null,
    shell: false,
    timeout: 10_000,
    maxBuffer,
    env: controllerGitEnvironment(gitInstallation),
    ...(input === undefined ? {} : { input })
  });
  if (run.status !== 0 || run.error || run.signal) {
    throw new CompanionError(
      "E_CAPABILITY",
      "The bounded Git checkout-safety inspection failed closed."
    );
  }
  return Buffer.isBuffer(run.stdout) ? run.stdout : Buffer.from(run.stdout || "");
}

export function splitNulRecords(buffer, label) {
  if (buffer.length === 0) return [];
  if (buffer.at(-1) !== 0) {
    throw new CompanionError("E_CAPABILITY", `${label} output was truncated.`);
  }
  const records = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    const record = buffer.subarray(start, index);
    if (record.length === 0) {
      throw new CompanionError("E_CAPABILITY", `${label} output was malformed.`);
    }
    records.push(record);
    start = index + 1;
  }
  return records;
}

export function assertControllerGitCheckoutSafe({
  gitExecutable,
  gitExecutableDirectory,
  gitInstallationRoot,
  workspaceRoot,
  baseCommit
}) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseCommit || "")) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Checkout-safety inspection requires one exact base commit."
    );
  }
  const gitInstallation = recaptureTrustedGitInstallation({
    commandPath: path.join(gitExecutableDirectory, "git"),
    executable: gitExecutable,
    executableDirectory: gitExecutableDirectory,
    installationRoot: gitInstallationRoot
  });
  if (gitInstallation.executable !== gitExecutable) {
    throw new CompanionError(
      "E_CAPABILITY",
      "The trusted Git executable changed before checkout-safety inspection."
    );
  }
  const tracked = splitNulRecords(
    boundedGitRun(
      gitInstallation,
      workspaceRoot,
      ["ls-tree", "-r", "-z", "--name-only", baseCommit]
    ),
    "git ls-tree"
  );
  if (tracked.length > 100_000) {
    throw new CompanionError(
      "E_CAPABILITY",
      "The checkout-safety file inventory exceeded its bound."
    );
  }
  if (tracked.length === 0) return Object.freeze({ trackedFiles: 0 });
  const input = Buffer.concat(
    tracked.flatMap((record) => [record, Buffer.from([0])])
  );
  const attributes = splitNulRecords(
    boundedGitRun(
      gitInstallation,
      workspaceRoot,
      [
        "check-attr",
        `--source=${baseCommit}`,
        "-z",
        "--stdin",
        "filter"
      ],
      { input }
    ),
    "git check-attr"
  );
  if (attributes.length !== tracked.length * 3) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Git filter attribute inspection returned an inexact record count."
    );
  }
  for (let index = 0; index < tracked.length; index += 1) {
    const [file, attribute, value] = attributes.slice(index * 3, index * 3 + 3);
    if (!file.equals(tracked[index])
      || attribute.toString("utf8") !== "filter"
      || !["unspecified", "unset"].includes(value.toString("utf8"))) {
      throw new CompanionError(
        "E_CAPABILITY",
        "Repository checkout attributes could execute an external Git filter."
      );
    }
  }
  return Object.freeze({ trackedFiles: tracked.length });
}

export function captureGitInfoAttributesBinding(gitCommonDir) {
  const attributesPath = path.join(gitCommonDir, "info", "attributes");
  try {
    const stat = fs.lstatSync(attributesPath);
    if (!stat.isFile()
      || stat.isSymbolicLink()
      || stat.size > 1024 * 1024) {
      throw new CompanionError(
        "E_CAPABILITY",
        "Git info attributes must be absent or one bounded regular file."
      );
    }
    return Object.freeze({
      path: attributesPath,
      state: "present",
      device: stat.dev,
      inode: stat.ino,
      size: stat.size,
      digest: crypto
        .createHash("sha256")
        .update(fs.readFileSync(attributesPath))
        .digest("hex")
    });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return Object.freeze({
      path: attributesPath,
      state: "absent"
    });
  }
}

export function assertNoGitObjectAlternates(gitCommonDir) {
  if (typeof process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES === "string"
    && process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES.length > 0) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Git alternate object directories are not authorized for official provisioning."
    );
  }
  const alternatesPath = path.join(
    gitCommonDir,
    "objects",
    "info",
    "alternates"
  );
  try {
    const stat = fs.lstatSync(alternatesPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 0) {
      throw new CompanionError(
        "E_CAPABILITY",
        "Git object alternates are not authorized for official provisioning."
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function sameGitInfoAttributesBinding(left, right) {
  return Boolean(
    left
    && right
    && left.path === right.path
    && left.state === right.state
    && (left.state === "absent"
      || (
        left.device === right.device
        && left.inode === right.inode
        && left.size === right.size
        && left.digest === right.digest
      ))
  );
}

export function ensureGitWorktreesMetadataRoot(gitCommonDir) {
  const metadataRoot = path.join(gitCommonDir, "worktrees");
  try {
    fs.mkdirSync(metadataRoot, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const resolved = fs.realpathSync(metadataRoot);
  const stat = fs.lstatSync(resolved);
  if (resolved !== metadataRoot
    || !stat.isDirectory()
    || stat.isSymbolicLink()) {
    throw new CompanionError(
      "E_CAPABILITY",
      "The exact Git worktree metadata directory is unsafe."
    );
  }
  return resolved;
}

export function canonicalProvisioningDestination({
  parent,
  expectedRoot,
  stateDir
}) {
  if (typeof parent !== "string"
    || typeof expectedRoot !== "string"
    || !path.isAbsolute(parent)
    || !path.isAbsolute(expectedRoot)
    || path.normalize(parent) !== parent
    || path.normalize(expectedRoot) !== expectedRoot) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Official provisioning requires one exact private destination parent and child."
    );
  }
  const canonicalStateDir = fs.realpathSync(stateDir);
  const canonicalParent = fs.realpathSync(parent);
  const parentStat = fs.lstatSync(canonicalParent);
  const resolvedRoot = path.resolve(expectedRoot);
  const relativeParent = path.relative(canonicalStateDir, canonicalParent);
  if (canonicalParent !== parent
    || !relativeParent
    || relativeParent.startsWith("..")
    || path.isAbsolute(relativeParent)
    || canonicalParent === path.resolve(stateDir, "worktrees")
    || path.dirname(resolvedRoot) !== canonicalParent
    || resolvedRoot === canonicalParent
    || !parentStat.isDirectory()
    || parentStat.isSymbolicLink()
    || (parentStat.mode & 0o077) !== 0
    || fs.readdirSync(canonicalParent).length !== 0) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Official provisioning destination parent is shared, aliased, nonempty, or not private."
    );
  }
  try {
    fs.lstatSync(resolvedRoot);
    throw new CompanionError(
      "E_CAPABILITY",
      "Official provisioning destination child must not exist before create."
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return Object.freeze({
    parent: canonicalParent,
    expectedRoot: resolvedRoot
  });
}

export function canonicalExistingRoot(value) {
  try { return fs.realpathSync(value); }
  catch { return path.resolve(value); }
}

export function broadTemporaryRoots() {
  return [...new Set([
    os.tmpdir(),
    "/tmp",
    "/private/tmp",
    process.env.TMPDIR,
    process.env.TMP,
    process.env.TEMP
  ]
    .filter((value) => typeof value === "string" && path.isAbsolute(value))
    .map(canonicalExistingRoot))];
}

export function assertControllerAuthorityOutsideBroadTemp({
  controlRoot,
  gitCommonDir,
  stateDir,
  destinationParent
}) {
  const temporaryRoots = broadTemporaryRoots();
  for (const [label, authorityRoot] of [
    ["control source", controlRoot],
    ["Git common directory", gitCommonDir],
    ["shared controller state", stateDir],
    ["destination parent", destinationParent]
  ]) {
    const canonical = canonicalExistingRoot(authorityRoot);
    if (temporaryRoots.some((temporaryRoot) => (
      canonical === temporaryRoot
      || canonical.startsWith(`${temporaryRoot}${path.sep}`)
    ))) {
      throw new CompanionError(
        "E_CAPABILITY",
        `The ${label} overlaps a broad strict-sandbox temporary write grant.`
      );
    }
  }
}

export function assertControllerGitSeparation({
  gitInstallation,
  controlRoot,
  stateDir,
  home,
  destinationRoot
}) {
  const temporaryRoots = [
    os.tmpdir(),
    process.env.TMPDIR,
    process.env.TMP,
    process.env.TEMP
  ].filter((value) => typeof value === "string" && path.isAbsolute(value));
  const forbidden = [
    controlRoot,
    stateDir,
    home,
    destinationRoot,
    ...temporaryRoots
  ].map(canonicalExistingRoot);
  for (const trustedPath of [
    gitInstallation.executable,
    gitInstallation.executableDirectory,
    gitInstallation.installationRoot
  ]) {
    if (forbidden.some((candidate) => pathsOverlap(trustedPath, candidate))) {
      throw new CompanionError(
        "E_CAPABILITY",
        "The trusted Git installation overlaps controller-owned or temporary state."
      );
    }
  }
}
export function protectedGitPaths(root) {
  const run = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { cwd: root, encoding: "utf8", shell: false, timeout: 10000 });
  const values = run.status === 0 ? String(run.stdout || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean) : [];
  const dotGit = path.join(fs.realpathSync(root), ".git");
  return [...new Set([dotGit, ...values.map((item) => path.resolve(root, item))])];
}
