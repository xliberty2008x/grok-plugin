"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PROOF_SCHEMA = "grok-test-temp-contained-git-v1";
const MAX_ENTRIES = 10_000;
const MAX_CONTROL_BYTES = 1024n * 1024n;
const CONTROL_NAMES = new Set(["commondir", "gitdir"]);
const CONTAINMENT_REASON_CODES = Object.freeze({
  E_TEST_TEMP_EXTERNAL_WORKTREE: "external-worktree-link",
  E_TEST_TEMP_GIT_SCAN_BUDGET: "git-metadata-scan-truncated"
});

function containmentError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function asciiLower(value) {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}

function compareText(left, right) {
  return left < right ? -1 : (left > right ? 1 : 0);
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function exactUnsigned(value) {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (
    typeof value === "string"
    && /^(?:0|[1-9][0-9]*)$/u.test(value)
  ) {
    return BigInt(value);
  }
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new Error("Contained Git proof identity is invalid.");
}

function exactIdentity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    uid: String(stat.uid),
    nlink: String(stat.nlink),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs)
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function decodeMountPath(value) {
  return value.replace(/\\([0-7]{3})/gu, (_match, octal) => (
    String.fromCharCode(Number.parseInt(octal, 8))
  ));
}

function mountPoints() {
  if (process.platform === "linux") {
    return fs.readFileSync("/proc/self/mountinfo", "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const fields = line.split(" ");
        if (fields.length < 6) {
          throw new Error("Linux mount metadata is malformed.");
        }
        return path.resolve(decodeMountPath(fields[4]));
      })
      .sort(compareText);
  }
  return [];
}

function nestedMountPoints(root) {
  return mountPoints().filter((mountPoint) => isWithin(root, mountPoint));
}

function inspectMountBoundary(root) {
  try {
    const canonicalRoot = fs.realpathSync(path.resolve(root));
    return {
      available: true,
      nested: nestedMountPoints(canonicalRoot)
    };
  } catch {
    return {
      available: false,
      nested: [],
      reason: "mount-visibility-unavailable"
    };
  }
}

function gitConfigSemantics(contents) {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  const text = bytes.toString("utf8");
  if (
    text.includes("\u0000")
    || !Buffer.from(text, "utf8").equals(bytes)
    || /\\\r?\n/u.test(text)
  ) {
    return { safe: false, worktrees: [] };
  }
  let section = "";
  const worktrees = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"\\]*")?\s*\]$/u.exec(line);
    if (sectionMatch) {
      section = asciiLower(sectionMatch[1]);
      if (section === "include" || section === "includeif") {
        return { safe: false, worktrees: [] };
      }
      continue;
    }
    if (line.startsWith("[")) return { safe: false, worktrees: [] };
    const keyMatch = /^([A-Za-z][A-Za-z0-9.-]*)\s*=\s*(.*?)\s*$/u.exec(line);
    if (!keyMatch) {
      if (section === "core" && /^worktree(?:\s|$)/iu.test(line)) {
        return { safe: false, worktrees: [] };
      }
      continue;
    }
    const key = asciiLower(keyMatch[1]);
    if (key === "include.path" || key.startsWith("includeif.")) {
      return { safe: false, worktrees: [] };
    }
    if (section === "core" && key === "worktree") {
      const value = keyMatch[2];
      if (
        !value
        || value !== value.trim()
        || /^["']/u.test(value)
        || /[\u0000\r\n]/u.test(value)
        || !/^[A-Za-z0-9._/+-]+$/u.test(value)
      ) {
        return { safe: false, worktrees: [] };
      }
      worktrees.push(value);
    }
  }
  return { safe: true, worktrees };
}

function stableDirectory(
  target,
  expectedUid,
  expectedDev,
  expectedFsType = null
) {
  const before = fs.lstatSync(target, { bigint: true });
  if (
    !before.isDirectory()
    || before.isSymbolicLink()
    || before.uid !== expectedUid
    || before.dev !== expectedDev
  ) {
    throw new Error("Contained Git directory is unsafe.");
  }
  if (
    expectedFsType !== null
    && fs.statfsSync(target, { bigint: true }).type !== expectedFsType
  ) {
    throw new Error("Contained Git directory crossed a mount boundary.");
  }
  if (fs.realpathSync(target) !== path.resolve(target)) {
    throw new Error("Contained Git directory is physically ambiguous.");
  }
  return before;
}

function stableControlFile(target, expectedUid, expectedDev) {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
    throw new Error("No-follow Git control reads are unavailable.");
  }
  const before = fs.lstatSync(target, { bigint: true });
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.uid !== expectedUid
    || before.dev !== expectedDev
    || before.nlink !== 1n
    || before.size < 0n
    || before.size > MAX_CONTROL_BYTES
    || (before.mode & 0o022n) !== 0n
  ) {
    throw new Error("Contained Git control file is unsafe.");
  }
  let descriptor;
  try {
    descriptor = fs.openSync(
      target,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    const openedBefore = fs.fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(exactIdentity(before), exactIdentity(openedBefore))) {
      throw new Error("Contained Git control changed before it was opened.");
    }
    const contents = fs.readFileSync(descriptor);
    const openedAfter = fs.fstatSync(descriptor, { bigint: true });
    const after = fs.lstatSync(target, { bigint: true });
    if (
      BigInt(contents.length) !== openedAfter.size
      || !sameIdentity(exactIdentity(openedBefore), exactIdentity(openedAfter))
      || !sameIdentity(exactIdentity(openedAfter), exactIdentity(after))
    ) {
      throw new Error("Contained Git control changed while it was read.");
    }
    return {
      contents,
      digest: sha256(contents),
      identity: exactIdentity(openedAfter)
    };
  } finally {
    if (Number.isInteger(descriptor)) fs.closeSync(descriptor);
  }
}

function exactLine(file) {
  const text = file.contents.toString("utf8");
  if (
    text.includes("\u0000")
    || !Buffer.from(text, "utf8").equals(file.contents)
  ) {
    throw new Error("Contained Git control text is invalid.");
  }
  let line = text;
  if (line.endsWith("\r\n")) line = line.slice(0, -2);
  else if (line.endsWith("\n")) line = line.slice(0, -1);
  if (!line || /[\r\n]/u.test(line) || line !== line.trim()) {
    throw new Error("Contained Git control must contain one exact line.");
  }
  return line;
}

function optionalStat(target) {
  try {
    return fs.lstatSync(target, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function boundedNames(target, budget) {
  const directory = fs.opendirSync(target);
  const names = [];
  try {
    while (true) {
      const entry = directory.readSync();
      if (!entry) break;
      budget.remaining -= 1;
      if (budget.remaining < 0) {
        throw containmentError(
          "E_TEST_TEMP_GIT_SCAN_BUDGET",
          "Contained Git scan exceeded its entry budget."
        );
      }
      names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return names.sort();
}

function caseEntries(target, names) {
  const selected = new Map();
  for (const name of names) {
    const folded = asciiLower(name);
    if (![
      ".git",
      "commondir",
      "config",
      "config.worktree",
      "gitdir",
      "modules",
      "worktrees"
    ].includes(folded)) {
      continue;
    }
    if (selected.has(folded)) {
      throw new Error("Case-ambiguous Git controls are unsupported.");
    }
    selected.set(folded, path.join(target, name));
  }
  return selected;
}

function inspectContainedGitMetadata({
  root,
  originalRoot = root,
  scanRoot = root,
  expectedUid,
  expectedDev
}) {
  try {
    const currentRoot = path.resolve(root);
    const priorRoot = path.resolve(originalRoot);
    const currentScanRoot = path.resolve(scanRoot);
    if (
      !path.isAbsolute(root)
      || !path.isAbsolute(originalRoot)
      || !path.isAbsolute(scanRoot)
      || fs.realpathSync(currentRoot) !== currentRoot
      || fs.realpathSync(currentScanRoot) !== currentScanRoot
      || !isWithin(currentRoot, currentScanRoot)
    ) {
      throw new Error("Contained Git root is not canonical.");
    }
    if (currentRoot !== priorRoot) {
      try {
        fs.lstatSync(priorRoot, { bigint: true });
        throw new Error("Original managed root still exists during quarantine.");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    const mountsBefore = nestedMountPoints(currentRoot);
    if (mountsBefore.length > 0) {
      throw new Error("Managed root contains a nested mountpoint.");
    }
    const uid = exactUnsigned(expectedUid);
    const rootNoFollow = fs.lstatSync(currentRoot, { bigint: true });
    const dev = expectedDev === undefined
      ? rootNoFollow.dev
      : exactUnsigned(expectedDev);
    const fsType = fs.statfsSync(currentRoot, { bigint: true }).type;
    const rootStat = stableDirectory(
      currentRoot,
      uid,
      dev,
      fsType
    );
    const containedDirectory = (target) => stableDirectory(
      target,
      uid,
      dev,
      fsType
    );
    const budget = { remaining: MAX_ENTRIES };
    const controls = new Map();
    const directories = new Map();
    const restricted = new Map();
    const endpoints = [];

    const relative = (target) => path.relative(currentRoot, target);
    const recordDirectory = (target, stat) => {
      directories.set(relative(target), exactIdentity(stat));
    };
    const readControl = (target) => {
      const file = stableControlFile(target, uid, dev);
      controls.set(relative(target), {
        digest: file.digest,
        identity: file.identity
      });
      return file;
    };
    const resolveEndpoint = (base, rawValue, kind) => {
      if (
        !rawValue
        || rawValue.includes("\u0000")
        || /[\r\n]/u.test(rawValue)
      ) {
        throw new Error("Contained Git endpoint is invalid.");
      }
      let target;
      let physicalTarget;
      if (path.isAbsolute(rawValue)) {
        if (path.normalize(rawValue) !== rawValue) {
          throw new Error("Contained Git absolute endpoint is non-normal.");
        }
        if (isWithin(currentRoot, rawValue)) {
          target = rawValue;
        } else if (currentRoot !== priorRoot && isWithin(priorRoot, rawValue)) {
          target = path.join(currentRoot, path.relative(priorRoot, rawValue));
        } else {
          throw containmentError(
            "E_TEST_TEMP_EXTERNAL_WORKTREE",
            "Git endpoint escapes the managed root."
          );
        }
        physicalTarget = target;
      } else {
        target = path.resolve(base, rawValue);
        physicalTarget = `${base}${base.endsWith(path.sep) ? "" : path.sep}${rawValue}`;
      }
      if (!isWithin(currentRoot, target)) {
        throw containmentError(
          "E_TEST_TEMP_EXTERNAL_WORKTREE",
          "Git endpoint escapes the managed root."
        );
      }
      const canonical = fs.realpathSync.native(physicalTarget);
      if (canonical !== target) {
        throw new Error("Contained Git endpoint is physically ambiguous.");
      }
      const stat = fs.lstatSync(target, { bigint: true });
      if (
        stat.dev !== dev
        || stat.uid !== uid
        || fs.statfsSync(target, { bigint: true }).type !== fsType
        || stat.isSymbolicLink()
        || (kind === "directory" && !stat.isDirectory())
        || (kind === "file" && !stat.isFile())
      ) {
        throw new Error("Contained Git endpoint has an unsafe identity.");
      }
      endpoints.push({
        from: relative(base),
        kind,
        to: relative(target)
      });
      return target;
    };
    const validateConfigs = (gitDirectory, entries) => {
      for (const name of ["config", "config.worktree"]) {
        const selected = entries.get(name);
        if (!selected) continue;
        const config = readControl(selected);
        const semantics = gitConfigSemantics(config.contents);
        if (!semantics.safe) {
          throw new Error("Git configuration semantics are unproven.");
        }
        for (const worktree of semantics.worktrees) {
          resolveEndpoint(gitDirectory, worktree, "directory");
        }
      }
    };
    const controlPath = (directory, entries, name) => entries.get(name) || null;

    const validateRegistration = (registration, commonDirectory) => {
      const registrationBefore = containedDirectory(registration);
      recordDirectory(registration, registrationBefore);
      const names = boundedNames(registration, budget);
      const entries = caseEntries(registration, names);
      validateConfigs(registration, entries);
      const gitdirPath = controlPath(registration, entries, "gitdir");
      const commondirPath = controlPath(registration, entries, "commondir");
      if (!gitdirPath || !commondirPath) {
        throw new Error("Worktree registration controls are incomplete.");
      }
      const marker = resolveEndpoint(
        registration,
        exactLine(readControl(gitdirPath)),
        "file"
      );
      const resolvedCommon = resolveEndpoint(
        registration,
        exactLine(readControl(commondirPath)),
        "directory"
      );
      if (resolvedCommon !== commonDirectory) {
        throw new Error("Worktree registration common directory is inconsistent.");
      }
      const markerLine = exactLine(readControl(marker));
      const match = /^gitdir: ([^\r\n]+)$/u.exec(markerLine);
      if (
        !match
        || resolveEndpoint(path.dirname(marker), match[1], "directory") !== registration
      ) {
        throw new Error("Worktree registration does not match its checkout marker.");
      }
      const registrationAfter = containedDirectory(registration);
      if (
        !sameIdentity(
          exactIdentity(registrationBefore),
          exactIdentity(registrationAfter)
        )
      ) {
        throw new Error("Worktree registration changed during containment proof.");
      }
    };

    const commonShape = (target, entries) => {
      const head = optionalStat(entries.get("head") || path.join(target, "HEAD"));
      const config = optionalStat(entries.get("config") || path.join(target, "config"));
      const objects = optionalStat(entries.get("objects") || path.join(target, "objects"));
      const refs = optionalStat(entries.get("refs") || path.join(target, "refs"));
      const reftable = optionalStat(entries.get("reftable") || path.join(target, "reftable"));
      return Boolean(
        head?.isFile()
        && !head.isSymbolicLink()
        && config?.isFile()
        && !config.isSymbolicLink()
        && objects?.isDirectory()
        && !objects.isSymbolicLink()
        && (
          (refs?.isDirectory() && !refs.isSymbolicLink())
          || (reftable?.isDirectory() && !reftable.isSymbolicLink())
        )
      );
    };

    const validateWorktrees = (worktrees, names) => {
      const worktreesStat = containedDirectory(worktrees);
      const commonDirectory = path.dirname(worktrees);
      const registrations = [];
      for (const name of names) {
        const registration = path.join(worktrees, name);
        const stat = optionalStat(registration);
        if (!stat) continue;
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error("Worktree registration entry is not a real directory.");
        }
        const childNames = boundedNames(registration, budget);
        const childEntries = caseEntries(registration, childNames);
        if (childEntries.has("gitdir") || childEntries.has("commondir")) {
          registrations.push(registration);
        }
      }
      const commonNames = boundedNames(commonDirectory, budget);
      const commonEntries = new Map(
        commonNames.map((name) => [asciiLower(name), path.join(commonDirectory, name)])
      );
      const commonControls = caseEntries(commonDirectory, commonNames);
      if (registrations.length === 0 && !commonShape(commonDirectory, commonEntries)) {
        return;
      }
      recordDirectory(worktrees, worktreesStat);
      validateConfigs(commonDirectory, commonControls);
      for (const registration of registrations) {
        validateRegistration(registration, commonDirectory);
      }
    };

    const validateGitDirectory = (gitDirectory, entries, stat) => {
      recordDirectory(gitDirectory, stat);
      validateConfigs(gitDirectory, entries);
      for (const name of CONTROL_NAMES) {
        const selected = entries.get(name);
        if (!selected) continue;
        resolveEndpoint(
          gitDirectory,
          exactLine(readControl(selected)),
          name === "commondir" ? "directory" : "file"
        );
      }
      for (const name of ["modules", "worktrees"]) {
        const selected = entries.get(name);
        if (!selected) continue;
        const selectedStat = containedDirectory(selected);
        recordDirectory(selected, selectedStat);
      }
    };

    const validateGitFile = (marker) => {
      const markerLine = exactLine(readControl(marker));
      const match = /^gitdir: ([^\r\n]+)$/u.exec(markerLine);
      if (!match) throw new Error("Linked-worktree marker is invalid.");
      const gitDirectory = resolveEndpoint(
        path.dirname(marker),
        match[1],
        "directory"
      );
      const names = boundedNames(gitDirectory, budget);
      const entries = caseEntries(gitDirectory, names);
      const gitDirectoryStat = containedDirectory(gitDirectory);
      recordDirectory(gitDirectory, gitDirectoryStat);
      validateConfigs(gitDirectory, entries);
      const commondir = entries.get("commondir");
      if (commondir) {
        resolveEndpoint(
          gitDirectory,
          exactLine(readControl(commondir)),
          "directory"
        );
      }
      const gitdir = entries.get("gitdir");
      if (gitdir) {
        const backpointer = resolveEndpoint(
          gitDirectory,
          exactLine(readControl(gitdir)),
          "file"
        );
        if (backpointer !== marker) {
          throw new Error("Linked-worktree backpointer is inconsistent.");
        }
      }
    };

    const stack = [{
      current: currentScanRoot,
      inModules: false
    }];
    while (stack.length > 0) {
      const { current, inModules } = stack.pop();
      const before = containedDirectory(current);
      let names;
      try {
        names = boundedNames(current, budget);
      } catch (error) {
        if (error?.code !== "EACCES" && error?.code !== "EPERM") throw error;
        const after = containedDirectory(current);
        if (!sameIdentity(exactIdentity(before), exactIdentity(after))) {
          throw new Error("Restricted directory changed during proof.");
        }
        restricted.set(relative(current), exactIdentity(after));
        continue;
      }
      const entries = caseEntries(current, names);
      const isGitDirectory = asciiLower(path.basename(current)) === ".git";
      const foldedNames = new Set(names.map(asciiLower));
      const hasCommonGitShape = (
        foldedNames.has("head")
        && foldedNames.has("config")
        && foldedNames.has("objects")
        && (
          foldedNames.has("refs")
          || foldedNames.has("reftable")
        )
      );
      if (
        isGitDirectory
        || hasCommonGitShape
        || (
          inModules
          && (
            entries.has("config")
            || entries.has("config.worktree")
            || entries.has("commondir")
            || entries.has("gitdir")
            || entries.has("modules")
            || entries.has("worktrees")
          )
        )
      ) {
        validateGitDirectory(current, entries, before);
      }
      const worktrees = entries.get("worktrees");
      if (worktrees) {
        const stat = fs.lstatSync(worktrees, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error("Git worktrees metadata is not a real directory.");
        }
        validateWorktrees(worktrees, boundedNames(worktrees, budget));
      }
      for (const name of names) {
        const entry = path.join(current, name);
        const stat = fs.lstatSync(entry, { bigint: true });
        if (stat.dev !== dev || stat.uid !== uid) {
          throw new Error("Contained Git scan crossed an ownership boundary.");
        }
        if (asciiLower(name) === ".git") {
          if (stat.isSymbolicLink()) {
            throw new Error("Symlinked Git markers are unsupported.");
          }
          if (stat.isFile()) {
            validateGitFile(entry);
            continue;
          }
          if (!stat.isDirectory()) {
            throw new Error("Git marker has an unsupported type.");
          }
        }
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          stack.push({
            current: entry,
            inModules: inModules || (
              isGitDirectory && asciiLower(name) === "modules"
            )
          });
        }
      }
      const after = containedDirectory(current);
      if (!sameIdentity(exactIdentity(before), exactIdentity(after))) {
        throw new Error("Contained Git directory changed during proof.");
      }
    }

    const mountsAfter = nestedMountPoints(currentRoot);
    if (
      mountsAfter.length > 0
      || JSON.stringify(mountsAfter) !== JSON.stringify(mountsBefore)
    ) {
      throw new Error("Managed-root mount metadata changed during proof.");
    }

    const sortedObject = (map) => Object.fromEntries(
      [...map.entries()].sort(([left], [right]) => compareText(left, right))
    );
    endpoints.sort((left, right) => compareText(
      JSON.stringify(left),
      JSON.stringify(right)
    ));
    const proof = {
      schema: PROOF_SCHEMA,
      controls: sortedObject(controls),
      directories: sortedObject(directories),
      restricted: sortedObject(restricted),
      endpoints
    };
    return {
      available: true,
      digest: sha256(JSON.stringify(proof)),
      proof
    };
  } catch (error) {
    return {
      available: false,
      digest: null,
      proof: null,
      reason: CONTAINMENT_REASON_CODES[error?.code]
        || "git-metadata-ambiguous"
    };
  }
}

function stablePathProof(target, expectedUid, expectedDev) {
  const uid = exactUnsigned(expectedUid);
  const dev = exactUnsigned(expectedDev);
  const stat = fs.lstatSync(target, { bigint: true });
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    if (stat.uid !== uid || stat.dev !== dev) {
      throw new Error("Managed Git directory identity changed.");
    }
    return { identity: exactIdentity(stat) };
  }
  const file = stableControlFile(target, uid, dev);
  return { digest: file.digest, identity: file.identity };
}

module.exports = {
  PROOF_SCHEMA,
  gitConfigSemantics,
  inspectMountBoundary,
  inspectContainedGitMetadata,
  stablePathProof
};
