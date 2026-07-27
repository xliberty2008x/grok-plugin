import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const HARD_LIMITS = Object.freeze({
  maxDepth: 32,
  maxPathBytes: 4 * 1024,
  maxFiles: 4 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntries: 8 * 1024
});
const LIMIT_NAMES = Object.freeze([
  "maxDepth",
  "maxPathBytes",
  "maxFiles",
  "maxFileBytes",
  "maxTotalBytes"
]);
const MAX_DIAGNOSTICS = 20;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
const MAX_DIAGNOSTIC_PATH_BYTES = 640;
const READ_BUFFER_BYTES = 64 * 1024;

class PluginInventoryError extends Error {}

function fail(message, cause) {
  throw new PluginInventoryError(message, cause ? { cause } : undefined);
}

function requirePath(value, label) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\0")
    || !isWellFormedText(value)
  ) {
    throw new TypeError(`${label} must be a well-formed non-empty path string without NUL bytes.`);
  }
  return value;
}

function isWellFormedText(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function compareNames(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareInventoryPaths(left, right) {
  const leftSegments = left.split("/");
  const rightSegments = right.split("/");
  const shared = Math.min(leftSegments.length, rightSegments.length);
  for (let index = 0; index < shared; index += 1) {
    const comparison = compareNames(leftSegments[index], rightSegments[index]);
    if (comparison !== 0) return comparison;
  }
  return leftSegments.length - rightSegments.length;
}

function displayPath(relativePath) {
  const rendered = JSON.stringify(relativePath);
  if (Buffer.byteLength(rendered, "utf8") <= MAX_DIAGNOSTIC_PATH_BYTES) return rendered;
  let bounded = "";
  for (const character of rendered) {
    if (Buffer.byteLength(`${bounded}${character}...`, "utf8") > MAX_DIAGNOSTIC_PATH_BYTES) break;
    bounded += character;
  }
  return `${bounded}...`;
}

function resolveLimits(options) {
  if (options === undefined) return HARD_LIMITS;
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Plugin inventory options must be an object.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(options);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !LIMIT_NAMES.includes(key)) {
      throw new TypeError(`Unknown plugin inventory option: ${String(key)}`);
    }
    if (!Object.hasOwn(descriptors[key], "value")) {
      throw new TypeError(`Plugin inventory option ${key} must be a data property.`);
    }
  }
  const limits = { ...HARD_LIMITS };
  for (const name of LIMIT_NAMES) {
    if (!Object.hasOwn(descriptors, name)) continue;
    const value = descriptors[name].value;
    const minimum = name === "maxDepth" ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum || value > HARD_LIMITS[name]) {
      throw new RangeError(
        `Plugin inventory option ${name} must be an integer from ${minimum} through ${HARD_LIMITS[name]}.`
      );
    }
    limits[name] = value;
  }
  return Object.freeze(limits);
}

function statSnapshot(stat) {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs
  });
}

function sameSnapshot(left, right) {
  return (
    left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
  );
}

function lstatSnapshot(absolutePath, relativePath) {
  try {
    const stat = fs.lstatSync(absolutePath, { bigint: true });
    return { stat, snapshot: statSnapshot(stat) };
  } catch (error) {
    fail(`Could not inspect plugin path ${displayPath(relativePath)}.`, error);
  }
}

function assertStablePath(absolutePath, relativePath, expected) {
  const current = lstatSnapshot(absolutePath, relativePath);
  if (!sameSnapshot(expected, current.snapshot)) {
    fail(`Plugin path changed while inventory was being created: ${displayPath(relativePath)}`);
  }
  return current;
}

function readDirectoryNames(absolutePath, relativePath, state) {
  let directory;
  const names = [];
  let readError;
  try {
    directory = fs.opendirSync(absolutePath);
    while (true) {
      const entry = directory.readSync();
      if (entry === null) break;
      state.entries += 1;
      if (state.entries > HARD_LIMITS.maxEntries) {
        fail(`Plugin tree exceeds the ${HARD_LIMITS.maxEntries}-entry traversal limit.`);
      }
      if (
        typeof entry.name !== "string"
        || entry.name.length === 0
        || entry.name === "."
        || entry.name === ".."
        || entry.name.includes("/")
        || entry.name.includes("\\")
        || entry.name.includes("\0")
        || !isWellFormedText(entry.name)
      ) {
        fail(`Plugin directory contains an invalid entry name below ${displayPath(relativePath)}.`);
      }
      names.push(entry.name);
    }
  } catch (error) {
    readError = error;
  } finally {
    if (directory) {
      try {
        directory.closeSync();
      } catch (error) {
        readError ??= error;
      }
    }
  }
  if (readError) {
    if (readError instanceof PluginInventoryError) throw readError;
    fail(`Could not read plugin directory ${displayPath(relativePath)}.`, readError);
  }
  return names.sort(compareNames);
}

function hashStableFile(absolutePath, relativePath, initial, limits, state) {
  const stat = initial.stat;
  if (!stat.isFile()) {
    fail(`Plugin trees may contain only regular files and directories: ${displayPath(relativePath)}`);
  }
  if (stat.size > BigInt(limits.maxFileBytes)) {
    fail(`Plugin file exceeds the ${limits.maxFileBytes}-byte per-file limit: ${displayPath(relativePath)}`);
  }
  if (BigInt(state.totalBytes) + stat.size > BigInt(limits.maxTotalBytes)) {
    fail(`Plugin tree exceeds the ${limits.maxTotalBytes}-byte total-file limit.`);
  }

  const expectedBytes = Number(stat.size);
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(READ_BUFFER_BYTES, Math.max(1, expectedBytes + 1)));
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const nonBlock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  let descriptor;
  let bytesRead = 0;
  let failure;
  try {
    descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | noFollow | nonBlock);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameSnapshot(initial.snapshot, statSnapshot(opened))) {
      fail(`Plugin file changed before it could be read: ${displayPath(relativePath)}`);
    }
    while (true) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      bytesRead += count;
      if (bytesRead > expectedBytes) {
        fail(`Plugin file changed while it was being read: ${displayPath(relativePath)}`);
      }
      hash.update(buffer.subarray(0, count));
    }
    if (bytesRead !== expectedBytes) {
      fail(`Plugin file changed while it was being read: ${displayPath(relativePath)}`);
    }
    const completed = fs.fstatSync(descriptor, { bigint: true });
    if (!sameSnapshot(initial.snapshot, statSnapshot(completed))) {
      fail(`Plugin file changed while it was being read: ${displayPath(relativePath)}`);
    }
  } catch (error) {
    failure = error;
  } finally {
    buffer.fill(0);
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (failure) {
    if (failure instanceof PluginInventoryError) throw failure;
    fail(`Could not read plugin file ${displayPath(relativePath)}.`, failure);
  }
  assertStablePath(absolutePath, relativePath, initial.snapshot);
  state.totalBytes += expectedBytes;
  return Object.freeze({
    path: relativePath,
    mode: Number(stat.mode & 0o777n),
    size: expectedBytes,
    sha256: hash.digest("hex")
  });
}

function validateRelativePath(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\0")
    || value.includes("\\")
    || !isWellFormedText(value)
    || value.startsWith("/")
    || path.posix.normalize(value) !== value
    || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    || Buffer.byteLength(value, "utf8") > HARD_LIMITS.maxPathBytes
  ) {
    throw new TypeError("Inventory entries must have canonical bounded POSIX relative paths.");
  }
  return value;
}

function normalizedInventory(entries) {
  if (!Array.isArray(entries) || entries.length > HARD_LIMITS.maxFiles) {
    throw new TypeError(`Inventory must be an array with at most ${HARD_LIMITS.maxFiles} entries.`);
  }
  const normalized = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("Inventory entries must be objects.");
    }
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    if (
      Reflect.ownKeys(descriptors).some((key) => (
        typeof key !== "string"
        || !["path", "mode", "size", "sha256"].includes(key)
        || !Object.hasOwn(descriptors[key], "value")
      ))
    ) {
      throw new TypeError("Inventory entries must contain only data properties.");
    }
    for (const required of ["path", "mode", "size", "sha256"]) {
      if (!Object.hasOwn(descriptors, required)) {
        throw new TypeError(`Inventory entry is missing ${required}.`);
      }
    }
    const relativePath = validateRelativePath(descriptors.path.value);
    const mode = descriptors.mode.value;
    const size = descriptors.size.value;
    const sha256 = descriptors.sha256.value;
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
      throw new TypeError(`Inventory mode is invalid for ${displayPath(relativePath)}.`);
    }
    if (!Number.isSafeInteger(size) || size < 0 || size > HARD_LIMITS.maxFileBytes) {
      throw new TypeError(`Inventory size is invalid for ${displayPath(relativePath)}.`);
    }
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new TypeError(`Inventory digest is invalid for ${displayPath(relativePath)}.`);
    }
    totalBytes += size;
    if (totalBytes > HARD_LIMITS.maxTotalBytes) {
      throw new TypeError(`Inventory exceeds the ${HARD_LIMITS.maxTotalBytes}-byte total-file limit.`);
    }
    normalized.push(Object.freeze({ path: relativePath, mode, size, sha256 }));
  }
  normalized.sort((left, right) => compareInventoryPaths(left.path, right.path));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].path === normalized[index].path) {
      throw new TypeError(`Inventory contains a duplicate path: ${displayPath(normalized[index].path)}`);
    }
  }
  return Object.freeze(normalized);
}

export function canonicalPath(existingPath, label = "Path") {
  requirePath(existingPath, label);
  try {
    return fs.realpathSync(existingPath);
  } catch (error) {
    fail(`${label} does not exist or cannot be resolved: ${existingPath}`, error);
  }
}

export function isPathInside(parentPath, candidatePath) {
  const parent = path.resolve(requirePath(parentPath, "Parent path"));
  const candidate = path.resolve(requirePath(candidatePath, "Candidate path"));
  const relative = path.relative(parent, candidate);
  return (
    relative === ""
    || (
      relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    )
  );
}

export function createPluginInventory(rootPath, options) {
  const root = path.resolve(requirePath(rootPath, "Plugin root"));
  const limits = resolveLimits(options);
  const rootInitial = lstatSnapshot(root, ".");
  if (rootInitial.stat.isSymbolicLink()) fail("Plugin root must not be a symbolic link.");
  if (!rootInitial.stat.isDirectory()) fail("Plugin root must be a directory.");
  const canonicalRoot = canonicalPath(root, "Plugin root");
  const canonicalInitial = lstatSnapshot(canonicalRoot, ".");
  if (!sameSnapshot(rootInitial.snapshot, canonicalInitial.snapshot)) {
    fail("Plugin root changed while inventory was being created.");
  }

  const state = {
    entries: 0,
    files: 0,
    totalBytes: 0,
    snapshots: [{
      absolutePath: canonicalRoot,
      relativePath: ".",
      snapshot: canonicalInitial.snapshot
    }]
  };
  const inventory = [];
  const visit = (directory, relativeDirectory, depth, expected) => {
    if (!isPathInside(canonicalRoot, directory)) {
      fail(`Plugin traversal escaped its canonical root below ${displayPath(relativeDirectory || ".")}.`);
    }
    const current = assertStablePath(directory, relativeDirectory || ".", expected);
    if (current.stat.isSymbolicLink()) {
      fail(`Plugin trees must not contain symbolic links: ${displayPath(relativeDirectory || ".")}`);
    }
    if (!current.stat.isDirectory()) {
      fail(`Plugin trees may contain only regular files and directories: ${displayPath(relativeDirectory || ".")}`);
    }
    const names = readDirectoryNames(directory, relativeDirectory || ".", state);
    for (const name of names) {
      const childDepth = depth + 1;
      if (childDepth > limits.maxDepth) {
        fail(`Plugin tree exceeds the ${limits.maxDepth}-level depth limit below ${displayPath(relativeDirectory || ".")}.`);
      }
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (Buffer.byteLength(relative, "utf8") > limits.maxPathBytes) {
        fail(`Plugin path exceeds the ${limits.maxPathBytes}-byte relative-path limit.`);
      }
      const absolute = path.join(directory, name);
      const initial = lstatSnapshot(absolute, relative);
      if (initial.stat.isSymbolicLink()) {
        fail(`Plugin trees must not contain symbolic links: ${displayPath(relative)}`);
      }
      if (initial.stat.isDirectory()) {
        state.snapshots.push({
          absolutePath: absolute,
          relativePath: relative,
          snapshot: initial.snapshot
        });
        visit(absolute, relative, childDepth, initial.snapshot);
        continue;
      }
      if (!initial.stat.isFile()) {
        fail(`Plugin trees may contain only regular files and directories: ${displayPath(relative)}`);
      }
      state.files += 1;
      if (state.files > limits.maxFiles) {
        fail(`Plugin tree exceeds the ${limits.maxFiles}-file limit.`);
      }
      inventory.push(hashStableFile(absolute, relative, initial, limits, state));
      state.snapshots.push({
        absolutePath: absolute,
        relativePath: relative,
        snapshot: initial.snapshot
      });
    }
    assertStablePath(directory, relativeDirectory || ".", expected);
  };
  visit(canonicalRoot, "", 0, canonicalInitial.snapshot);
  for (const retained of state.snapshots) {
    assertStablePath(retained.absolutePath, retained.relativePath, retained.snapshot);
  }
  inventory.sort((left, right) => compareInventoryPaths(left.path, right.path));
  return Object.freeze(inventory);
}

export function digestInventory(entries) {
  const normalized = normalizedInventory(entries);
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function digestRegularFile(filePath) {
  const absolute = path.resolve(requirePath(filePath, "File"));
  const initial = lstatSnapshot(absolute, path.basename(absolute));
  const state = { totalBytes: 0 };
  return hashStableFile(
    absolute,
    path.basename(absolute),
    initial,
    HARD_LIMITS,
    state
  ).sha256;
}

export function describeInventoryDifference(expectedEntries, actualEntries) {
  const expected = normalizedInventory(expectedEntries);
  const actual = normalizedInventory(actualEntries);
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...expectedByPath.keys(), ...actualByPath.keys()])].sort(compareInventoryPaths);
  const diagnostics = [];
  let differenceCount = 0;
  let diagnosticBytes = 0;
  for (const relativePath of paths) {
    const left = expectedByPath.get(relativePath);
    const right = actualByPath.get(relativePath);
    let message = null;
    if (!left) {
      message = `unexpected installed file: ${displayPath(relativePath)}`;
    } else if (!right) {
      message = `missing installed file: ${displayPath(relativePath)}`;
    } else if (left.mode !== right.mode) {
      message = `mode mismatch: ${displayPath(relativePath)} (${left.mode.toString(8)} != ${right.mode.toString(8)})`;
    } else if (left.size !== right.size || left.sha256 !== right.sha256) {
      message = `content mismatch: ${displayPath(relativePath)}`;
    }
    if (message === null) continue;
    differenceCount += 1;
    const bytes = Buffer.byteLength(message, "utf8");
    if (
      diagnostics.length < MAX_DIAGNOSTICS - 1
      && diagnosticBytes + bytes <= MAX_DIAGNOSTIC_BYTES - 128
    ) {
      diagnostics.push(message);
      diagnosticBytes += bytes;
    }
  }
  const omitted = differenceCount - diagnostics.length;
  if (omitted > 0) diagnostics.push(`${omitted} additional inventory difference${omitted === 1 ? "" : "s"} omitted.`);
  return Object.freeze(diagnostics);
}
