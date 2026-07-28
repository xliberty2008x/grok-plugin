/**
 * Head-only hierarchical AGENTS.md instruction collection.
 *
 * - Root AGENTS.md applies globally
 * - Each changed file gets its root-to-deepest applicable ancestor chain
 *   from the exact head tree
 * - Accept regular blob modes 100644 / 100755 only
 * - Reject symlink (120000), gitlink/tree/non-blob, invalid UTF-8, NUL content
 * - Never truncate instruction bodies
 * - Limits: 32 unique applicable files, 32 KiB each, 128 KiB raw total
 * - Receipt metadata only: path, mode, blob OID, raw bytes, SHA-256,
 *   per-changed-path applicability digest — never instruction contents
 */

import crypto from "node:crypto";

import {
  CollectorError,
  CollectorErrorCode,
  CollectorLimits,
  failCollector
} from "./collector-errors.mjs";
import { assertSafeRepoPath, decodeUtf8Fatal } from "./exact-head-diff.mjs";
import { isCommitSha, lsTreePath, readBlobOid } from "./exact-head-repository.mjs";

export const AGENTS_FILENAME = "AGENTS.md";
export const MAX_INSTRUCTION_CANDIDATE_PROBES =
  CollectorLimits.MAX_CHANGED_FILES + (CollectorLimits.MAX_INSTRUCTION_FILES * 32);
const ACCEPTED_BLOB_MODES = new Set(["100644", "100755"]);

/**
 * @param {string} changedPath
 * @returns {string[]} ancestor directory prefixes from root to parent ("" = root)
 */
export function ancestorDirsForPath(changedPath) {
  assertSafeRepoPath(changedPath);
  const segments = changedPath.split("/");
  /** @type {string[]} */
  const dirs = [""]; // root
  // Directories from shallow to deep, excluding the file's own name.
  let acc = "";
  for (let i = 0; i < segments.length - 1; i += 1) {
    acc = acc ? `${acc}/${segments[i]}` : segments[i];
    dirs.push(acc);
  }
  return dirs;
}

/**
 * Candidate AGENTS.md paths for a changed file (root → deepest), unique order.
 * @param {string} changedPath
 * @returns {string[]}
 */
export function agentsCandidatesForChangedPath(changedPath) {
  return ancestorDirsForPath(changedPath).map((dir) => (
    dir ? `${dir}/${AGENTS_FILENAME}` : AGENTS_FILENAME
  ));
}

/**
 * All unique candidate instruction paths for a set of changed files (stable order).
 * Root first, then discovered by walking changed paths in input order.
 * @param {string[]} changedPaths
 * @returns {string[]}
 */
export function discoverAgentsCandidates(changedPaths) {
  /** @type {string[]} */
  const ordered = [];
  /** @type {Set<string>} */
  const seen = new Set();
  const add = (p) => {
    if (seen.has(p)) return;
    if (ordered.length >= MAX_INSTRUCTION_CANDIDATE_PROBES) {
      failCollector(
        CollectorErrorCode.E_COLLECTOR_INSTRUCTION_LIMIT,
        "Hierarchical instruction candidate count exceeds the probe limit.",
        {
          instructionCount: ordered.length + 1,
          limit: MAX_INSTRUCTION_CANDIDATE_PROBES
        }
      );
    }
    seen.add(p);
    ordered.push(p);
  };
  add(AGENTS_FILENAME);
  for (const changed of changedPaths) {
    for (const candidate of agentsCandidatesForChangedPath(changed)) {
      add(candidate);
    }
  }
  return ordered;
}

/**
 * @param {Buffer} body
 */
function assertInstructionBody(body) {
  if (!Buffer.isBuffer(body)) {
    failCollector(CollectorErrorCode.E_COLLECTOR_INSTRUCTION, "Instruction body must be a Buffer.");
  }
  if (body.includes(0)) {
    failCollector(CollectorErrorCode.E_COLLECTOR_INSTRUCTION, "Instruction blob contains NUL.");
  }
  // Fatal UTF-8: reject invalid sequences; never truncate.
  decodeUtf8Fatal(body);
}

/**
 * @param {import("./exact-head-repository.mjs").ExactHeadRepository} repo
 * @param {string} headSha
 * @param {string} agentsPath
 * @returns {Promise<null | { path: string, mode: string, blobOid: string, bytes: number, sha256: string, content: Buffer }>}
 */
async function loadAgentsAtPath(repo, headSha, agentsPath) {
  assertSafeRepoPath(agentsPath);
  const entry = await lsTreePath(repo, headSha, agentsPath);
  if (!entry) return null;

  if (entry.type !== "blob") {
    failCollector(CollectorErrorCode.E_COLLECTOR_INSTRUCTION, "AGENTS.md path is not a blob.", {
      objectType: entry.type,
      mode: entry.mode
    });
  }
  if (entry.mode === "120000") {
    failCollector(CollectorErrorCode.E_COLLECTOR_INSTRUCTION, "AGENTS.md symlink is rejected.", {
      mode: entry.mode
    });
  }
  if (entry.mode === "160000") {
    failCollector(CollectorErrorCode.E_COLLECTOR_INSTRUCTION, "AGENTS.md gitlink is rejected.", {
      mode: entry.mode
    });
  }
  if (!ACCEPTED_BLOB_MODES.has(entry.mode)) {
    failCollector(CollectorErrorCode.E_COLLECTOR_INSTRUCTION, "AGENTS.md mode is not an accepted regular blob.", {
      mode: entry.mode
    });
  }
  if (!isCommitSha(entry.oid) && !/^[0-9a-f]{64}$/.test(entry.oid)) {
    failCollector(CollectorErrorCode.E_COLLECTOR_INSTRUCTION, "AGENTS.md blob OID is invalid.", {
      blobOid: entry.oid
    });
  }

  // Enforce per-file size before reading full content when possible via cat-file -s
  // (readBlobOid also bounds). Never truncate — fail if over limit.
  let content;
  try {
    content = await readBlobOid(
      repo,
      entry.oid,
      CollectorLimits.MAX_INSTRUCTION_FILE_BYTES
    );
  } catch (error) {
    if (error instanceof CollectorError
      && (error.code === CollectorErrorCode.E_COLLECTOR_OVERFLOW
        || error.code === CollectorErrorCode.E_COLLECTOR_INSTRUCTION_LIMIT)) {
      failCollector(CollectorErrorCode.E_COLLECTOR_INSTRUCTION_LIMIT, "Instruction file exceeds per-file byte limit.", {
        blobOid: entry.oid,
        limit: CollectorLimits.MAX_INSTRUCTION_FILE_BYTES
      });
    }
    throw error;
  }
  if (content.length > CollectorLimits.MAX_INSTRUCTION_FILE_BYTES) {
    failCollector(CollectorErrorCode.E_COLLECTOR_INSTRUCTION_LIMIT, "Instruction file exceeds per-file byte limit.", {
      byteCount: content.length,
      limit: CollectorLimits.MAX_INSTRUCTION_FILE_BYTES
    });
  }
  assertInstructionBody(content);

  const sha256 = crypto.createHash("sha256").update(content).digest("hex");
  return {
    path: agentsPath,
    mode: entry.mode,
    blobOid: entry.oid,
    bytes: content.length,
    sha256,
    content
  };
}

/**
 * Collect hierarchical head-only AGENTS.md instructions for changed paths.
 *
 * @param {import("./exact-head-repository.mjs").ExactHeadRepository} repo
 * @param {{ headSha?: string }} identity
 * @param {Array<{ path: string }>|string[]} changedFiles
 * @returns {Promise<{
 *   files: Array<{ path: string, mode: string, blobOid: string, bytes: number, sha256: string, content: Buffer }>,
 *   applicability: Array<{ changedPath: string, instructionPaths: string[], applicabilityDigest: string }>,
 *   receipt: {
 *     files: Array<{ path: string, mode: string, blobOid: string, bytes: number, sha256: string }>,
 *     applicability: Array<{ changedPath: string, instructionPaths: string[], applicabilityDigest: string }>,
 *     totalBytes: number,
 *     fileCount: number
 *   }
 * }>}
 */
export async function collectHeadInstructions(repo, identity, changedFiles) {
  if (!repo || repo.disposed) {
    failCollector(CollectorErrorCode.E_COLLECTOR_STATE, "Collector repository is not available.");
  }
  const headSha = identity?.headSha || repo.headSha;
  if (!isCommitSha(headSha)) {
    failCollector(CollectorErrorCode.E_COLLECTOR_REF, "Head SHA is invalid for instruction collection.");
  }
  for (const key of ["baseTipSha", "mergeBaseSha", "headSha"]) {
    if (
      identity?.[key] !== undefined
      && identity[key] !== repo[key]
    ) {
      failCollector(CollectorErrorCode.E_COLLECTOR_REF, "Instruction identity does not match the opened repository.", {
        expectedSha: repo[key],
        actualSha: identity[key]
      });
    }
  }

  if (!Array.isArray(changedFiles) || changedFiles.length > CollectorLimits.MAX_CHANGED_FILES) {
    failCollector(CollectorErrorCode.E_COLLECTOR_LIMIT_FILES, "Instruction changed-file count exceeds the hard limit.", {
      fileCount: Array.isArray(changedFiles) ? changedFiles.length : null,
      limit: CollectorLimits.MAX_CHANGED_FILES
    });
  }
  const changedPaths = changedFiles.map((entry) => (
    typeof entry === "string" ? entry : entry.path
  ));
  for (const p of changedPaths) assertSafeRepoPath(p);

  const candidates = discoverAgentsCandidates(changedPaths);

  // Probe candidates and load unique present files.
  /** @type {Map<string, { path: string, mode: string, blobOid: string, bytes: number, sha256: string, content: Buffer }>} */
  const loaded = new Map();
  /** @type {string[]} */
  const loadOrder = [];

  // First pass: resolve which candidates exist and collect blob OIDs for hydrate.
  /** @type {Array<{ path: string, oid: string, mode: string }>} */
  const present = [];
  for (const candidate of candidates) {
    const entry = await lsTreePath(repo, headSha, candidate);
    if (!entry) continue;
    if (entry.type !== "blob") {
      failCollector(CollectorErrorCode.E_COLLECTOR_INSTRUCTION, "AGENTS.md path is not a blob.", {
        objectType: entry.type,
        mode: entry.mode
      });
    }
    if (entry.mode === "120000") {
      failCollector(CollectorErrorCode.E_COLLECTOR_INSTRUCTION, "AGENTS.md symlink is rejected.", {
        mode: entry.mode
      });
    }
    if (entry.mode === "160000" || !ACCEPTED_BLOB_MODES.has(entry.mode)) {
      failCollector(CollectorErrorCode.E_COLLECTOR_INSTRUCTION, "AGENTS.md type/mode is rejected.", {
        mode: entry.mode,
        objectType: entry.type
      });
    }
    present.push({ path: candidate, oid: entry.oid, mode: entry.mode });
  }

  if (present.length > CollectorLimits.MAX_INSTRUCTION_FILES) {
    failCollector(CollectorErrorCode.E_COLLECTOR_INSTRUCTION_LIMIT, "Unique instruction file count exceeds limit.", {
      instructionCount: present.length,
      limit: CollectorLimits.MAX_INSTRUCTION_FILES
    });
  }

  let totalBytes = 0;
  for (const item of present) {
    if (loaded.has(item.path)) continue;
    if (loadOrder.length >= CollectorLimits.MAX_INSTRUCTION_FILES) {
      failCollector(CollectorErrorCode.E_COLLECTOR_INSTRUCTION_LIMIT, "Unique instruction file count exceeds limit.", {
        instructionCount: loadOrder.length + 1,
        limit: CollectorLimits.MAX_INSTRUCTION_FILES
      });
    }
    const file = await loadAgentsAtPath(repo, headSha, item.path);
    if (!file) {
      failCollector(CollectorErrorCode.E_COLLECTOR_INSTRUCTION, "Instruction blob disappeared during load.");
    }
    totalBytes += file.bytes;
    if (totalBytes > CollectorLimits.MAX_INSTRUCTION_TOTAL_BYTES) {
      failCollector(CollectorErrorCode.E_COLLECTOR_INSTRUCTION_LIMIT, "Instruction total raw bytes exceed limit.", {
        totalBytes,
        limit: CollectorLimits.MAX_INSTRUCTION_TOTAL_BYTES
      });
    }
    loaded.set(file.path, file);
    loadOrder.push(file.path);
  }

  // Per-changed-path applicability: root → deepest present ancestors.
  /** @type {Array<{ changedPath: string, instructionPaths: string[], applicabilityDigest: string }>} */
  const applicability = [];
  for (const changedPath of changedPaths) {
    const chain = agentsCandidatesForChangedPath(changedPath).filter((p) => loaded.has(p));
    const applicabilityDigest = crypto
      .createHash("sha256")
      .update(JSON.stringify({
        changedPath,
        instructions: chain.map((p) => {
          const f = loaded.get(p);
          return {
            path: f.path,
            mode: f.mode,
            blobOid: f.blobOid,
            bytes: f.bytes,
            sha256: f.sha256
          };
        })
      }))
      .digest("hex");
    applicability.push(Object.freeze({
      changedPath,
      instructionPaths: Object.freeze([...chain]),
      applicabilityDigest
    }));
  }

  const files = Object.freeze(loadOrder.map((p) => {
    const f = loaded.get(p);
    return Object.freeze({
      path: f.path,
      mode: f.mode,
      blobOid: f.blobOid,
      bytes: f.bytes,
      sha256: f.sha256,
      content: f.content
    });
  }));

  // Receipt: metadata only — never instruction contents.
  const receipt = Object.freeze({
    files: Object.freeze(files.map((f) => Object.freeze({
      path: f.path,
      mode: f.mode,
      blobOid: f.blobOid,
      bytes: f.bytes,
      sha256: f.sha256
    }))),
    applicability: Object.freeze(applicability.map((a) => Object.freeze({
      changedPath: a.changedPath,
      instructionPaths: a.instructionPaths,
      applicabilityDigest: a.applicabilityDigest
    }))),
    totalBytes,
    fileCount: files.length
  });

  return Object.freeze({
    files,
    applicability: Object.freeze(applicability),
    receipt
  });
}

/**
 * Ensure a receipt or error projection never carries instruction body text.
 * @param {unknown} value
 * @returns {boolean}
 */
export function receiptContainsInstructionContent(value) {
  if (!value || typeof value !== "object") return false;
  const json = JSON.stringify(value);
  // Heuristic for tests: receipt objects must not include a "content" field.
  return /"content"\s*:/.test(json);
}
