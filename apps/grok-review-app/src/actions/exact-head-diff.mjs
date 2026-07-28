/**
 * True PR merge-base diff for exact-head collection.
 *
 * Semantics: mergeBaseSha..headSha (equivalent to baseTipSha...headSha).
 * Never baseTipSha..headSha.
 *
 * - diff-tree --raw -z --no-renames (renames = delete + add)
 * - Buffer NUL-token parsing; strict ASCII metadata; fatal UTF-8 path decode
 * - Reject malformed/duplicate/absolute/dot-segment/control-NUL/oversized paths
 * - Preserve tabs/newlines/colons/spaces/Unicode/leading dashes in path bytes
 * - Stream --binary --full-index patch; incremental digest; fail closed at 8 MiB / 3000 files
 * - No partial evidence returned on overflow
 */

import crypto from "node:crypto";

import {
  CollectorError,
  CollectorErrorCode,
  CollectorLimits,
  failCollector
} from "./collector-errors.mjs";
import {
  isCommitSha,
  MAX_FETCHED_BLOB_OBJECT_BYTES
} from "./exact-head-repository.mjs";

const MODE_RE = /^[0-7]{6}$/;
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const STATUS_RE = /^[AMDTadmt]$/;
const ZERO_OID_RE = /^0+$/;
export const MAX_PATCH_SOURCE_BLOB_BYTES = CollectorLimits.MAX_PATCH_BYTES * 8;

/**
 * Fatal UTF-8 decode (no replacement characters).
 * @param {Buffer} bytes
 * @returns {string}
 */
export function decodeUtf8Fatal(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    failCollector(CollectorErrorCode.E_COLLECTOR_PATH, "Path bytes must be a Buffer.");
  }
  const text = bytes.toString("utf8");
  // Detect replacement / invalid sequences by re-encoding.
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    failCollector(CollectorErrorCode.E_COLLECTOR_PATH, "Path is not valid UTF-8.");
  }
  return text;
}

/**
 * Validate a repository-relative path decoded from NUL-safe Git output.
 * Preserves unusual characters; rejects unsafe forms.
 * @param {string} repoPath
 * @param {number} [byteLength]
 */
export function assertSafeRepoPath(repoPath, byteLength = Buffer.byteLength(repoPath, "utf8")) {
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    failCollector(CollectorErrorCode.E_COLLECTOR_PATH, "Path is empty.");
  }
  if (byteLength > CollectorLimits.MAX_PATH_BYTES) {
    failCollector(CollectorErrorCode.E_COLLECTOR_PATH, "Path exceeds size limit.", {
      pathBytes: byteLength,
      limit: CollectorLimits.MAX_PATH_BYTES
    });
  }
  if (repoPath.includes("\0")) {
    failCollector(CollectorErrorCode.E_COLLECTOR_PATH, "Path contains NUL.");
  }
  // Reject C0 controls and DEL. TAB/LF bytes are preserved by NUL-safe parsing
  // then rejected here so callers never silently truncate unusual paths.
  for (let i = 0; i < repoPath.length; i += 1) {
    const code = repoPath.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      failCollector(CollectorErrorCode.E_COLLECTOR_PATH, "Path contains control characters.");
    }
  }
  if (repoPath.startsWith("/") || repoPath.startsWith("\\")) {
    failCollector(CollectorErrorCode.E_COLLECTOR_PATH, "Path must not be absolute.");
  }
  // Windows drive / UNC
  if (/^[A-Za-z]:/.test(repoPath) || repoPath.startsWith("\\\\")) {
    failCollector(CollectorErrorCode.E_COLLECTOR_PATH, "Path must not be absolute.");
  }
  if (repoPath.includes("\\")) {
    failCollector(CollectorErrorCode.E_COLLECTOR_PATH, "Path must use forward slashes only.");
  }
  const segments = repoPath.split("/");
  if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) {
    failCollector(CollectorErrorCode.E_COLLECTOR_PATH, "Path contains empty or dot segments.");
  }
}

/**
 * Split a Buffer on NUL bytes. Requires a trailing NUL when non-empty.
 * @param {Buffer} buffer
 * @param {string} label
 * @returns {Buffer[]}
 */
export function splitNulTokens(buffer, label = "git") {
  if (!Buffer.isBuffer(buffer)) {
    failCollector(CollectorErrorCode.E_COLLECTOR_DIFF, `${label} output must be a Buffer.`);
  }
  if (buffer.length === 0) return [];
  if (buffer[buffer.length - 1] !== 0) {
    failCollector(CollectorErrorCode.E_COLLECTOR_DIFF, `${label} output was truncated (missing NUL).`);
  }
  /** @type {Buffer[]} */
  const tokens = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] !== 0) continue;
    tokens.push(buffer.subarray(start, i));
    start = i + 1;
  }
  return tokens;
}

/**
 * Parse one raw meta line: `:<oldmode> <newmode> <oldoid> <newoid> <status>`
 * Status is a single ASCII letter under --no-renames (no score, no rename path).
 * @param {Buffer} metaBytes
 * @returns {{ oldMode: string, newMode: string, oldOid: string, newOid: string, status: string }}
 */
export function parseRawMeta(metaBytes) {
  if (!Buffer.isBuffer(metaBytes) || metaBytes.length < 5) {
    failCollector(CollectorErrorCode.E_COLLECTOR_DIFF, "Raw diff metadata is malformed.");
  }
  // Metadata must be strict ASCII.
  for (let i = 0; i < metaBytes.length; i += 1) {
    const c = metaBytes[i];
    if (c > 0x7e || c < 0x20) {
      failCollector(CollectorErrorCode.E_COLLECTOR_DIFF, "Raw diff metadata is not strict ASCII.");
    }
  }
  const meta = metaBytes.toString("latin1");
  if (!meta.startsWith(":")) {
    failCollector(CollectorErrorCode.E_COLLECTOR_DIFF, "Raw diff metadata must start with ':'.");
  }
  const parts = meta.slice(1).split(" ");
  if (parts.length !== 5) {
    failCollector(CollectorErrorCode.E_COLLECTOR_DIFF, "Raw diff metadata token count is invalid.");
  }
  const [oldMode, newMode, oldOid, newOid, status] = parts;
  if (!MODE_RE.test(oldMode) || !MODE_RE.test(newMode)) {
    failCollector(CollectorErrorCode.E_COLLECTOR_DIFF, "Raw diff modes are invalid.");
  }
  if (!OID_RE.test(oldOid) || !OID_RE.test(newOid)) {
    failCollector(CollectorErrorCode.E_COLLECTOR_DIFF, "Raw diff object ids are invalid.");
  }
  if (!STATUS_RE.test(status) || status.length !== 1) {
    failCollector(CollectorErrorCode.E_COLLECTOR_DIFF, "Raw diff status is invalid under --no-renames.");
  }
  return {
    oldMode,
    newMode,
    oldOid,
    newOid,
    status: status.toUpperCase()
  };
}

/**
 * Parse `git diff-tree --raw -z --no-renames` output into changed-file records.
 * @param {Buffer} raw
 * @returns {Array<{
 *   path: string,
 *   oldMode: string,
 *   newMode: string,
 *   oldOid: string,
 *   newOid: string,
 *   status: string
 * }>}
 */
export function parseDiffTreeRawZ(raw) {
  const tokens = splitNulTokens(raw, "diff-tree");
  if (tokens.length % 2 !== 0) {
    failCollector(CollectorErrorCode.E_COLLECTOR_DIFF, "diff-tree NUL tokens are not paired.");
  }
  /** @type {Array<{ path: string, oldMode: string, newMode: string, oldOid: string, newOid: string, status: string }>} */
  const files = [];
  /** @type {Set<string>} */
  const seen = new Set();

  for (let i = 0; i < tokens.length; i += 2) {
    if (files.length >= CollectorLimits.MAX_CHANGED_FILES) {
      failCollector(CollectorErrorCode.E_COLLECTOR_LIMIT_FILES, "Changed file count exceeds the hard limit.", {
        fileCount: files.length + 1,
        limit: CollectorLimits.MAX_CHANGED_FILES
      });
    }
    const meta = parseRawMeta(tokens[i]);
    const pathBytes = tokens[i + 1];
    if (pathBytes.length === 0) {
      failCollector(CollectorErrorCode.E_COLLECTOR_PATH, "Changed path is empty.");
    }
    if (pathBytes.length > CollectorLimits.MAX_PATH_BYTES) {
      failCollector(CollectorErrorCode.E_COLLECTOR_PATH, "Path exceeds size limit.", {
        pathBytes: pathBytes.length,
        limit: CollectorLimits.MAX_PATH_BYTES
      });
    }
    if (pathBytes.includes(0)) {
      failCollector(CollectorErrorCode.E_COLLECTOR_PATH, "Path contains NUL.");
    }
    const repoPath = decodeUtf8Fatal(pathBytes);
    assertSafeRepoPath(repoPath, pathBytes.length);
    if (seen.has(repoPath)) {
      failCollector(CollectorErrorCode.E_COLLECTOR_PATH, "Duplicate changed path.", {
        pathCount: seen.size
      });
    }
    seen.add(repoPath);
    files.push({
      path: repoPath,
      oldMode: meta.oldMode,
      newMode: meta.newMode,
      oldOid: meta.oldOid,
      newOid: meta.newOid,
      status: meta.status
    });
  }
  return files;
}

/**
 * Verify every blob needed to render the patch is already present locally and
 * bounded. GIT_NO_LAZY_FETCH is active before this probe, so missing promisor
 * objects cannot be downloaded as a side effect.
 *
 * @param {import("./exact-head-repository.mjs").ExactHeadRepository} repo
 * @param {Array<{ oldMode: string, newMode: string, oldOid: string, newOid: string }>} changedFiles
 */
async function assertPatchSourceBlobsBounded(repo, changedFiles) {
  if (repo.lazyFetchDisabled !== true) {
    failCollector(CollectorErrorCode.E_COLLECTOR_STATE, "Lazy fetch must be disabled before patch collection.");
  }

  const oids = new Set();
  const addBlob = (mode, oid) => {
    if (mode === "000000" || mode === "160000" || ZERO_OID_RE.test(oid)) return;
    oids.add(oid);
  };
  for (const file of changedFiles) {
    addBlob(file.oldMode, file.oldOid);
    addBlob(file.newMode, file.newOid);
  }
  if (oids.size === 0) return;

  const ordered = [...oids];
  const batchInput = Buffer.from(`${ordered.join("\n")}\n`, "ascii");
  const result = await repo.git([
    "cat-file",
    "--batch-check=%(objectname) %(objecttype) %(objectsize)"
  ], {
    stdin: batchInput,
    maxStdout: Math.max(1024, ordered.length * 160),
    allowFailure: false
  });
  const lines = result.stdout.toString("ascii").trimEnd().split("\n");
  if (lines.length !== ordered.length) {
    failCollector(CollectorErrorCode.E_COLLECTOR_DIFF, "Blob-bound probe returned an unexpected record count.");
  }

  let aggregateBytes = 0;
  for (let i = 0; i < ordered.length; i += 1) {
    const expectedOid = ordered[i];
    const line = lines[i];
    if (line === `${expectedOid} missing`) {
      failCollector(CollectorErrorCode.E_COLLECTOR_LIMIT_PATCH, "Patch requires a blob omitted by the bounded fetch.", {
        blobOid: expectedOid,
        limit: MAX_FETCHED_BLOB_OBJECT_BYTES
      });
    }
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) blob ([0-9]+)$/.exec(line);
    if (!match || match[1] !== expectedOid) {
      failCollector(CollectorErrorCode.E_COLLECTOR_DIFF, "Blob-bound probe returned malformed metadata.");
    }
    const size = Number.parseInt(match[2], 10);
    if (!Number.isSafeInteger(size) || size < 0) {
      failCollector(CollectorErrorCode.E_COLLECTOR_DIFF, "Blob-bound probe returned an invalid size.");
    }
    if (size > MAX_FETCHED_BLOB_OBJECT_BYTES) {
      failCollector(CollectorErrorCode.E_COLLECTOR_LIMIT_PATCH, "Patch source blob exceeds the per-object limit.", {
        blobOid: expectedOid,
        byteCount: size,
        limit: MAX_FETCHED_BLOB_OBJECT_BYTES
      });
    }
    aggregateBytes += size;
    if (aggregateBytes > MAX_PATCH_SOURCE_BLOB_BYTES) {
      failCollector(CollectorErrorCode.E_COLLECTOR_LIMIT_PATCH, "Patch source blobs exceed the aggregate byte limit.", {
        byteCount: aggregateBytes,
        limit: MAX_PATCH_SOURCE_BLOB_BYTES
      });
    }
  }
}

/**
 * Collect merge-base..head changed files and binary full-index patch evidence.
 *
 * @param {import("./exact-head-repository.mjs").ExactHeadRepository} repo
 * @param {{ baseTipSha?: string, mergeBaseSha?: string, headSha?: string }} [identity]
 * @returns {Promise<{
 *   baseTipSha: string,
 *   mergeBaseSha: string,
 *   headSha: string,
 *   changedFiles: Array<object>,
 *   patch: Buffer,
 *   patchBytes: number,
 *   patchDigest: string,
 *   pathsDigest: string
 * }>}
 */
export async function collectExactHeadDiff(repo, identity = {}) {
  if (!repo || repo.disposed) {
    failCollector(CollectorErrorCode.E_COLLECTOR_STATE, "Collector repository is not available.");
  }

  const baseTipSha = identity.baseTipSha === undefined ? repo.baseTipSha : identity.baseTipSha;
  const mergeBaseSha = identity.mergeBaseSha === undefined ? repo.mergeBaseSha : identity.mergeBaseSha;
  const headSha = identity.headSha === undefined ? repo.headSha : identity.headSha;

  if (!isCommitSha(baseTipSha) || !isCommitSha(mergeBaseSha) || !isCommitSha(headSha)) {
    failCollector(CollectorErrorCode.E_COLLECTOR_REF, "Diff identity SHAs are invalid.");
  }
  if (
    baseTipSha !== repo.baseTipSha
    || mergeBaseSha !== repo.mergeBaseSha
    || headSha !== repo.headSha
  ) {
    failCollector(CollectorErrorCode.E_COLLECTOR_REF, "Diff identity does not match the opened repository.");
  }

  // Re-bind the merge base to the exact base/head pair; ancestor-only checks
  // are insufficient because any older ancestor would otherwise be accepted.
  const boundMergeBase = await repo.git(
    ["merge-base", "--all", baseTipSha, headSha],
    { allowFailure: true, maxStdout: 4096 }
  );
  const mergeBases = boundMergeBase.stdout
    .toString("ascii")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (
    boundMergeBase.status !== 0
    || mergeBases.length !== 1
    || mergeBases[0] !== mergeBaseSha
  ) {
    failCollector(CollectorErrorCode.E_COLLECTOR_MERGE_BASE, "Merge base is not bound to the exact base/head pair.");
  }

  // Changed records: mergeBase..head via diff-tree (two trees), --no-renames.
  let rawOut;
  try {
    rawOut = await repo.git([
      "diff-tree",
      "-r",
      "--raw",
      "-z",
      "--no-renames",
      "--no-commit-id",
      mergeBaseSha,
      headSha
    ], {
      maxStdout: CollectorLimits.MAX_CHANGED_FILES * (CollectorLimits.MAX_PATH_BYTES + 128),
      allowFailure: false
    });
  } catch (error) {
    if (error instanceof CollectorError) {
      if (error.code === CollectorErrorCode.E_COLLECTOR_OVERFLOW) {
        failCollector(CollectorErrorCode.E_COLLECTOR_LIMIT_FILES, "Changed-file listing exceeded bounds.", {
          limit: CollectorLimits.MAX_CHANGED_FILES
        });
      }
      throw error;
    }
    failCollector(CollectorErrorCode.E_COLLECTOR_DIFF, "diff-tree failed closed.");
  }

  let changedFiles;
  try {
    changedFiles = parseDiffTreeRawZ(rawOut.stdout);
  } catch (error) {
    if (error instanceof CollectorError) throw error;
    failCollector(CollectorErrorCode.E_COLLECTOR_DIFF, "Failed to parse changed-file records.");
  }

  if (changedFiles.length > CollectorLimits.MAX_CHANGED_FILES) {
    failCollector(CollectorErrorCode.E_COLLECTOR_LIMIT_FILES, "Changed file count exceeds the hard limit.", {
      fileCount: changedFiles.length,
      limit: CollectorLimits.MAX_CHANGED_FILES
    });
  }

  await assertPatchSourceBlobsBounded(repo, changedFiles);

  // Stream patch with incremental hashing. Fail without returning partial evidence.
  let patchResult;
  try {
    patchResult = await repo.git([
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--no-color",
      `${mergeBaseSha}..${headSha}`
    ], {
      // Bound at the hard limit; overflow errors become LIMIT_PATCH with no partial return.
      maxStdout: CollectorLimits.MAX_PATCH_BYTES,
      allowFailure: false
    });
  } catch (error) {
    if (error instanceof CollectorError && error.code === CollectorErrorCode.E_COLLECTOR_OVERFLOW) {
      failCollector(CollectorErrorCode.E_COLLECTOR_LIMIT_PATCH, "Patch exceeds the hard byte limit.", {
        limit: CollectorLimits.MAX_PATCH_BYTES
      });
    }
    if (error instanceof CollectorError) throw error;
    failCollector(CollectorErrorCode.E_COLLECTOR_DIFF, "Patch collection failed closed.");
  }

  const patch = patchResult.stdout;
  if (patch.length > CollectorLimits.MAX_PATCH_BYTES) {
    // Defensive: should have been caught by maxStdout.
    failCollector(CollectorErrorCode.E_COLLECTOR_LIMIT_PATCH, "Patch exceeds the hard byte limit.", {
      byteCount: patch.length,
      limit: CollectorLimits.MAX_PATCH_BYTES
    });
  }

  const patchDigest = crypto.createHash("sha256").update(patch).digest("hex");
  const pathsPayload = changedFiles.map((f) => f.path);
  const pathsDigest = crypto
    .createHash("sha256")
    .update(JSON.stringify(pathsPayload))
    .digest("hex");

  // Freeze records (no mutation after return).
  const frozenFiles = Object.freeze(changedFiles.map((f) => Object.freeze({ ...f })));

  return Object.freeze({
    baseTipSha,
    mergeBaseSha,
    headSha,
    changedFiles: frozenFiles,
    patch,
    patchBytes: patch.length,
    patchDigest,
    pathsDigest
  });
}

/**
 * Build a structured RIGHT-side map seed from exact patch bytes later.
 * This module only guarantees the patch is full-index binary evidence;
 * consumers (diff-right-lines) parse RIGHT lines.
 *
 * @param {{ patch: Buffer, patchDigest: string, changedFiles: Array<{ path: string }> }} diff
 * @returns {{ patchDigest: string, filePaths: string[], patchBytes: number }}
 */
export function diffEvidenceSummary(diff) {
  return Object.freeze({
    patchDigest: diff.patchDigest,
    patchBytes: diff.patchBytes,
    filePaths: Object.freeze(diff.changedFiles.map((f) => f.path))
  });
}
