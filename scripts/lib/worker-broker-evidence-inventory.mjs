/** Internal Worker Broker evidence inventory domain. */
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
  EVIDENCE_ONLY_PREFIXES,
  LIVE_RECEIPT_RUNTIME_ID,
  LIVE_RECEIPT_MANIFEST,
  PHASE_SCOPE,
  REPO_ROOT,
  sha256File,
  sha256Text,
  stableStringify,
  isEvidenceOnlyPath
} from "./worker-broker-evidence-core.mjs";
import {
  invalidLiveReceiptError,
  sameFileSnapshot
} from "./worker-broker-evidence-files.mjs";
import {
  execTrustedGit
} from "./worker-broker-evidence-toolchain.mjs";

export function listSourceInventory(root = REPO_ROOT, { includeEvidence = false } = {}) {
  const output = execTrustedGit(["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024
  });
  return [...new Set(output.toString("utf8").split("\0").filter(Boolean))]
    .filter((relative) => includeEvidence || !isEvidenceOnlyPath(relative))
    .sort();
}

export function phaseScopePaths(phase, root = REPO_ROOT) {
  const phaseId = String(phase);
  if (phaseId === "aggregate") {
    return listSourceInventory(root, { includeEvidence: false });
  }
  return [...(PHASE_SCOPE[phaseId] || [])];
}

function listGitIndexIdentity(root) {
  const output = execTrustedGit(["ls-files", "-s", "-z"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024
  });
  const byPath = new Map();
  for (const token of output.toString("utf8").split("\0").filter(Boolean)) {
    const tab = token.indexOf("\t");
    if (tab < 0) continue;
    const [mode, objectId, stageText] = token.slice(0, tab).split(/\s+/);
    const relative = token.slice(tab + 1);
    if (!mode || !/^[0-9a-f]{40,64}$/i.test(objectId || "") || !/^\d+$/.test(stageText || "")) {
      throw new Error(`Cannot parse Git index identity for ${relative}.`);
    }
    const identities = byPath.get(relative) || [];
    identities.push({ mode, objectId: objectId.toLowerCase(), stage: Number(stageText) });
    byPath.set(relative, identities);
  }
  for (const identities of byPath.values()) {
    identities.sort((left, right) => left.stage - right.stage
      || left.mode.localeCompare(right.mode)
      || left.objectId.localeCompare(right.objectId));
  }
  return byPath;
}

export function computeInventoryDigest(root = REPO_ROOT, { includeEvidence = false, paths = null } = {}) {
  const files = paths
    ? [...paths].sort()
    : listSourceInventory(root, { includeEvidence });
  const indexIdentity = listGitIndexIdentity(root);
  const inventory = files.map((relative) => {
    const absolute = path.join(root, ...relative.split("/"));
    const gitIndex = indexIdentity.get(relative) || [];
    if (!fs.existsSync(absolute)) {
      return { path: relative, type: "missing", sha256: "0".repeat(64), gitIndex };
    }
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      return {
        path: relative,
        type: "symlink",
        sha256: sha256Text(fs.readlinkSync(absolute)),
        gitIndex
      };
    }
    if (stat.isDirectory()) {
      // A tracked directory is a Git submodule/gitlink. Bind its index object
      // identity instead of reducing every gitlink to the same `dir` digest.
      return { path: relative, type: "directory", sha256: sha256Text("dir"), gitIndex };
    }
    return {
      path: relative,
      type: "file",
      sha256: sha256File(absolute),
      size: stat.size,
      executable: Boolean(stat.mode & 0o111),
      gitIndex
    };
  });
  return sha256Text(JSON.stringify(inventory));
}

export const MAX_LIVE_PLUGIN_FILES = 4096;

const MAX_LIVE_PLUGIN_DIRECTORIES = 512;

const MAX_LIVE_PLUGIN_DEPTH = 32;

const MAX_LIVE_PLUGIN_DIRECTORY_ENTRIES = 4096;

const LIVE_PLUGIN_INVENTORY_LIMITS = Object.freeze({
  maxDepth: MAX_LIVE_PLUGIN_DEPTH,
  maxPathBytes: 4 * 1024,
  maxFiles: MAX_LIVE_PLUGIN_FILES,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024
});

function assertLivePluginDirectoryBudgets(pluginRoot) {
  const lexicalRoot = path.resolve(pluginRoot);
  let canonicalRoot;
  let rootStat;
  try {
    rootStat = fs.lstatSync(lexicalRoot, { bigint: true });
    canonicalRoot = fs.realpathSync.native(lexicalRoot);
  } catch {
    throw invalidLiveReceiptError();
  }
  if (!rootStat.isDirectory()
    || rootStat.isSymbolicLink()
    || canonicalRoot !== lexicalRoot) {
    throw invalidLiveReceiptError();
  }

  let directoryCount = 0;
  const contained = (candidate) => {
    const relative = path.relative(canonicalRoot, candidate);
    return relative === ""
      || (relative !== ".."
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative));
  };
  const visit = (directory, depth) => {
    if (depth > MAX_LIVE_PLUGIN_DEPTH
      || directoryCount >= MAX_LIVE_PLUGIN_DIRECTORIES
      || !contained(directory)) {
      throw invalidLiveReceiptError();
    }
    directoryCount += 1;

    let directoryBefore;
    let canonicalDirectory;
    try {
      directoryBefore = fs.lstatSync(directory, { bigint: true });
      canonicalDirectory = fs.realpathSync.native(directory);
    } catch {
      throw invalidLiveReceiptError();
    }
    if (!directoryBefore.isDirectory()
      || directoryBefore.isSymbolicLink()
      || canonicalDirectory !== directory
      || !contained(canonicalDirectory)) {
      throw invalidLiveReceiptError();
    }

    const children = [];
    let handle;
    let failure = null;
    try {
      handle = fs.opendirSync(directory);
      while (true) {
        const child = handle.readSync();
        if (child === null) break;
        if (children.length >= MAX_LIVE_PLUGIN_DIRECTORY_ENTRIES) {
          throw invalidLiveReceiptError();
        }
        children.push(child);
      }
    } catch {
      failure = invalidLiveReceiptError();
    } finally {
      if (handle) {
        try {
          handle.closeSync();
        } catch {
          failure = invalidLiveReceiptError();
        }
      }
    }
    if (failure) throw failure;

    for (const child of children) {
      if (typeof child.name !== "string"
        || child.name.length === 0
        || child.name === "."
        || child.name === ".."
        || child.name.includes("/")
        || child.name.includes("\\")
        || child.name.includes("\0")) {
        throw invalidLiveReceiptError();
      }
      const absolute = path.join(directory, child.name);
      let childStat;
      let canonicalChild;
      try {
        childStat = fs.lstatSync(absolute, { bigint: true });
        canonicalChild = fs.realpathSync.native(absolute);
      } catch {
        throw invalidLiveReceiptError();
      }
      if (childStat.isSymbolicLink()
        || canonicalChild !== absolute
        || !contained(canonicalChild)) {
        throw invalidLiveReceiptError();
      }
      if (childStat.isDirectory()) {
        visit(absolute, depth + 1);
      } else if (!childStat.isFile()) {
        throw invalidLiveReceiptError();
      }
    }

    let directoryAfter;
    try {
      directoryAfter = fs.lstatSync(directory, { bigint: true });
      if (!sameFileSnapshot(directoryBefore, directoryAfter)
        || fs.realpathSync.native(directory) !== canonicalDirectory) {
        throw invalidLiveReceiptError();
      }
    } catch (error) {
      if (error?.code === "E_LIVE_RECEIPT_INVALID") throw error;
      throw invalidLiveReceiptError();
    }
  };

  visit(canonicalRoot, 0);
  let rootAfter;
  try {
    rootAfter = fs.lstatSync(lexicalRoot, { bigint: true });
  } catch {
    throw invalidLiveReceiptError();
  }
  if (!sameFileSnapshot(rootStat, rootAfter)
    || fs.realpathSync.native(lexicalRoot) !== canonicalRoot) {
    throw invalidLiveReceiptError();
  }
}

function readStableLiveInventoryFile(pluginRoot, expectedEntry) {
  const absolute = path.join(pluginRoot, ...expectedEntry.path.split("/"));
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  const nonBlock = Number.isInteger(fs.constants.O_NONBLOCK) ? fs.constants.O_NONBLOCK : 0;
  let descriptor;
  let bytes;
  let extra;
  let failure = null;
  try {
    const pathBefore = fs.lstatSync(absolute, { bigint: true });
    if (!pathBefore.isFile()
      || pathBefore.isSymbolicLink()
      || fs.realpathSync.native(absolute) !== absolute
      || Number(pathBefore.size) !== expectedEntry.size
      || Number(pathBefore.mode & 0o777n) !== expectedEntry.mode) {
      throw invalidLiveReceiptError();
    }
    descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow | nonBlock);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFileSnapshot(pathBefore, opened)) {
      throw invalidLiveReceiptError();
    }
    bytes = Buffer.alloc(expectedEntry.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    extra = Buffer.allocUnsafe(1);
    const extraBytes = fs.readSync(descriptor, extra, 0, 1, null);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(absolute, { bigint: true });
    if (offset !== expectedEntry.size
      || extraBytes !== 0
      || !sameFileSnapshot(opened, after)
      || !sameFileSnapshot(pathBefore, pathAfter)
      || fs.realpathSync.native(absolute) !== absolute
      || crypto.createHash("sha256").update(bytes).digest("hex") !== expectedEntry.sha256) {
      throw invalidLiveReceiptError();
    }
  } catch {
    failure = invalidLiveReceiptError();
  } finally {
    if (extra) extra.fill(0);
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        failure = invalidLiveReceiptError();
      }
    }
  }
  if (failure || !bytes) {
    if (bytes) bytes.fill(0);
    throw invalidLiveReceiptError();
  }
  return bytes;
}

export function captureLivePluginInventory(pluginRoot) {
  const lexicalRoot = path.resolve(pluginRoot);
  let entries;
  let pluginVersion;
  try {
    // Retain the live receipt's historical per-directory and directory-count
    // ceilings around the shared helper's stricter portable file/path/byte
    // limits. Running the structural guard on both sides closes the gap where
    // a tree could grow after the first budget check.
    assertLivePluginDirectoryBudgets(lexicalRoot);
    entries = createPluginInventory(lexicalRoot, LIVE_PLUGIN_INVENTORY_LIMITS);
    assertLivePluginDirectoryBudgets(lexicalRoot);

    const manifestEntry = entries.find(
      (entry) => entry.path === ".codex-plugin/plugin.json"
    );
    const installedEntrypoint = entries.find(
      (entry) => entry.path === LIVE_RECEIPT_MANIFEST.installedEntrypoint
    );
    if (!entries.length || !manifestEntry || !installedEntrypoint) {
      throw invalidLiveReceiptError();
    }
    const manifestBytes = readStableLiveInventoryFile(lexicalRoot, manifestEntry);
    try {
      const manifest = JSON.parse(manifestBytes.toString("utf8"));
      if (typeof manifest?.version !== "string"
        || !LIVE_RECEIPT_RUNTIME_ID.test(manifest.version)) {
        throw invalidLiveReceiptError();
      }
      pluginVersion = manifest.version;
    } finally {
      manifestBytes.fill(0);
    }
    return Object.freeze({
      fileCount: entries.length,
      digest: digestInventory(entries),
      pluginVersion,
      installedEntrypointDigest: installedEntrypoint.sha256
    });
  } catch {
    throw invalidLiveReceiptError();
  }
}

export function computePhaseScopeDigest(phase, root = REPO_ROOT) {
  const scope = phaseScopePaths(phase, root);
  const missing = scope.filter((relative) => !fs.existsSync(path.join(root, relative)));
  if (missing.length) {
    throw new Error(`Phase ${phase} scope contains missing paths: ${missing.join(", ")}`);
  }
  return computeInventoryDigest(root, { paths: scope });
}

export function parsePorcelainV1ZChanges(status) {
  if (typeof status !== "string") return null;
  if (status.length === 0) return [];
  if (!status.endsWith("\0")) return null;

  const tokens = status.split("\0");
  tokens.pop();
  const changes = [];
  const indexCodes = new Set([" ", "M", "T", "A", "D", "R", "C", "U"]);
  // Porcelain v1 uses lowercase `m` and `?` in the worktree column for
  // submodule content and untracked-content changes.
  const worktreeCodes = new Set([...indexCodes, "m", "?"]);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length < 4 || token[2] !== " ") return null;

    const indexCode = token[0];
    const worktreeCode = token[1];
    const currentPath = token.slice(3);
    if (!currentPath) return null;

    const untracked = indexCode === "?" && worktreeCode === "?";
    const ignored = indexCode === "!" && worktreeCode === "!";
    if (!untracked && !ignored) {
      if (!indexCodes.has(indexCode) || !worktreeCodes.has(worktreeCode)) return null;
      if (indexCode === " " && worktreeCode === " ") return null;
    }

    const renamedOrCopied = !untracked && !ignored
      && (indexCode === "R" || indexCode === "C" || worktreeCode === "R" || worktreeCode === "C");
    if (!renamedOrCopied) {
      changes.push({ indexCode, worktreeCode, paths: [currentPath] });
      continue;
    }

    // With `-z`, Git reverses the human-readable rename order: the first
    // token contains `XY <destination>` and the following raw token is the
    // source path. The source token has no XY prefix and must not be sliced.
    const sourcePath = tokens[index + 1];
    if (!sourcePath) return null;
    index += 1;
    changes.push({ indexCode, worktreeCode, paths: [currentPath, sourcePath] });
  }

  return changes;
}

function readVisibleGitIndex(root) {
  return execTrustedGit(["ls-files", "-s", "-v", "-z"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024
  });
}

function isSupportedVisibleGitIndex(raw) {
  if (!Buffer.isBuffer(raw)) return false;
  if (raw.length === 0) return true;
  if (raw[raw.length - 1] !== 0) return false;

  const paths = new Set();
  for (let offset = 0; offset < raw.length;) {
    const end = raw.indexOf(0, offset);
    if (end < 0 || end === offset) return false;
    const entry = raw.subarray(offset, end);
    const tab = entry.indexOf(9);
    if (tab < 0 || tab === entry.length - 1) return false;
    const header = entry.subarray(0, tab).toString("ascii");
    const match = /^H (100644|100755|120000|160000) ([0-9a-f]{40}|[0-9a-f]{64}) 0$/.exec(header);
    if (!match || /^0+$/.test(match[2])) return false;

    // Keep paths opaque: only duplicate identity matters, and no private path
    // ever enters an error or result projection.
    const pathIdentity = entry.subarray(tab + 1).toString("base64");
    if (paths.has(pathIdentity)) return false;
    paths.add(pathIdentity);
    offset = end + 1;
  }
  return true;
}

export function isNonEvidenceTreeClean(root = REPO_ROOT) {
  try {
    // Bracket status capture with the exact visible index identity. `-v`
    // lower-cases assume-unchanged tags and emits `S` for skip-worktree; the
    // strict parser above accepts only ordinary stage-0 `H` entries. It also
    // rejects unmerged stages, intent-to-add zero identities, unsupported
    // modes/tags, malformed records, and index changes during the capture.
    const indexBefore = readVisibleGitIndex(root);
    if (!isSupportedVisibleGitIndex(indexBefore)) return false;
    const status = execTrustedGit([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=all",
      "--no-renames"
    ], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024
    });
    const indexAfter = readVisibleGitIndex(root);
    if (!isSupportedVisibleGitIndex(indexAfter) || !indexBefore.equals(indexAfter)) return false;
    const changes = parsePorcelainV1ZChanges(status);
    return changes !== null
      && changes.every((change) => change.paths.every((relative) => isEvidenceOnlyPath(relative)));
  } catch {
    return false;
  }
}

export function gitIdentity(root = REPO_ROOT) {
  const headCommit = execTrustedGit(["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const headTree = execTrustedGit(["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
  const cleanTreeAtVerification = isNonEvidenceTreeClean(root);
  return {
    headCommit,
    headTree,
    cleanTreeAtVerification
  };
}

export function runtimeSnapshot() {
  let git = "unknown";
  try {
    git = execTrustedGit(["--version"], { encoding: "utf8" }).trim().replace(/^git version\s+/i, "");
  } catch {
    /* keep unknown */
  }
  return {
    platform: process.platform === "darwin" ? "macOS" : process.platform,
    architecture: process.arch,
    node: process.versions.node,
    git,
    codexStandalone: null,
    codexDesktopBundled: null,
    grokBuild: null,
    grokBuildRevision: null,
    mcpProtocolVersion: "2025-11-25"
  };
}

export function canonicalRecordBody(record) {
  const clone = structuredClone(record);
  delete clone.recordDigest;
  return stableStringify(clone);
}
