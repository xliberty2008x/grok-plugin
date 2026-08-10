import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import gitContainment from "./test-temp-git-containment.cjs";
import {
  TEST_TEMP_MANIFEST,
  TEST_TEMP_PROCESS_PREFIX,
  TEST_TEMP_RUN_PREFIX,
  canonicalSystemTempRoot,
  processStartToken,
  validateTestTempManifest
} from "./test-temp.mjs";

const {
  canonicalContainedPath,
  gitConfigSemantics,
  inspectContainedGitMetadata,
  normalizeDarwinSystemPath
} = gitContainment;

export const DEFAULT_TEST_TEMP_MAX_AGE_MS = 60 * 60_000;
export const TEST_TEMP_SIZE_SCAN_ENTRY_BUDGET = 10_000;
export const TEST_TEMP_SNAPSHOT_REFRESH_MS = 10_000;
const TEST_TEMP_WORKTREE_SCAN_TIMEOUT_MS = 120_000;
export const LEGACY_REPOSITORY_PREFIX = "grok-plugin-repo-";
// Every entry is an exact literal prefix used by tests in this repository.
// Legacy cleanup is opt-in and accepts only prefix + mkdtemp's six-character suffix.
export const LEGACY_TEST_TEMP_PREFIXES = Object.freeze([
  "controller-startup-crash-",
  "external-ledger-lock-",
  "fake-grok-bin-",
  "fake-grok-codex-host-",
  "fake-grok-mcp-poison-",
  "fake-grok-mcp-runtime-",
  "fake-grok-ready-",
  "fake-grok-ready-grouped-",
  "fake-grok-ready-official-grouped-",
  "fake-grok-ready-saturated-",
  "fake-grok-receipt-setup-fail-",
  "fake-grok-runtime-",
  "fake-grok-setup-revocation-",
  "fake-grok-startup-cancel-",
  "fake-grok-stop-",
  "fake-grok-stop-cleanup-",
  "fake-grok-stop-codex-",
  "fake-grok-stop-crash-",
  "fake-grok-transfer-effort-",
  "fake-preprovider-",
  "fake-preprovider-rt-",
  "fake-ps-path-",
  "gated-cleanup-",
  "grok-artifact-readonly-",
  "grok-cli-authority-data-",
  "grok-cli-cancel-data-",
  "grok-codex-converted-",
  "grok-codex-data-",
  "grok-codex-hook-data-",
  "grok-codex-hook-error-",
  "grok-codex-host-data-",
  "grok-codex-host-home-",
  "grok-codex-state-",
  "grok-codex-transcript-",
  "grok-codex-transcript-bounds-",
  "grok-codex-transcript-home-",
  "grok-codex-transcript-link-",
  "grok-codex-transfer-home-",
  "grok-codex-wrapper-",
  "grok-cp-data-",
  "grok-cp-fake-",
  "grok-cp-writer-",
  "grok-dispatch-contract-data-",
  "grok-embedded-victim-",
  "grok-evidence-bad-",
  "grok-executable-identity-",
  "grok-guard-alias-conflict-",
  "grok-guard-cas-",
  "grok-guard-cleanup-fence-",
  "grok-guard-generation-owner-",
  "grok-guard-stale-",
  "grok-guard-worktree-provisioning-",
  "grok-guard-write-binding-",
  "grok-hook-bin-",
  "grok-hook-child-",
  "grok-hook-data-",
  "grok-hook-data-codex-",
  "grok-hook-env-",
  "grok-hook-home-",
  "grok-host-action-data-",
  "grok-import-guard-",
  "grok-installed-codex-home-",
  "grok-installed-fake-",
  "grok-installed-user-home-",
  "grok-installed-worker-mcp-",
  "grok-installed-worker-runner-test-",
  "grok-legacy-outside-",
  "grok-mailbox-data-",
  "grok-materialization-failure-",
  "grok-materialization-parent-",
  "grok-mcp-client-",
  "grok-mcp-context-preexecute-",
  "grok-mcp-crashed-controller-",
  "grok-mcp-delayed-controller-",
  "grok-mcp-descendant-",
  "grok-mcp-no-provider-capability-",
  "grok-mcp-poison-data-",
  "grok-mcp-reflection-secret-",
  "grok-mcp-runtime-data-",
  "grok-mcp-runtime-plugin-",
  "grok-mcp-spawn-secret-",
  "grok-missing-host-data-",
  "grok-mutation-data-",
  "grok-natural-codex-",
  "grok-owner-lifecycle-data-",
  "grok-phase-scope-closure-",
  "grok-pinned-setup-plugin-",
  "grok-plugin-data-",
  "grok-plugin-e2e-",
  "grok-plugin-external-marker-",
  "grok-plugin-inventory-",
  "grok-plugin-linked-parent-",
  "grok-plugin-test-",
  "grok-primary-admission-gen1-",
  "grok-primary-admission-gen2-",
  "grok-proof-platform-",
  "grok-proof-python-control-",
  "grok-protected-docker-config-",
  "grok-protected-host-git-config-",
  "grok-protected-review-image-",
  "grok-protected-review-image-id-",
  "grok-protected-review-result-",
  "grok-protected-review-workspace-",
  "grok-provider-capability-bin-",
  "grok-provider-capability-data-",
  "grok-provider-npm-home-",
  "grok-provider-npm-prefix-",
  "grok-provider-npm-raw-",
  "grok-qualification-digest-",
  "grok-readonly-absent-parent-",
  "grok-readonly-external-",
  "grok-readonly-legacy-linked-parent-",
  "grok-readonly-linked-parent-",
  "grok-readonly-lock-owner-",
  "grok-readonly-missing-linked-parent-",
  "grok-readonly-status-",
  "grok-reconcile-safety-data-",
  "grok-recursion-guard-",
  "grok-retain-admission-lock-",
  "grok-runtime-data-",
  "grok-safety-data-",
  "grok-service-data-",
  "grok-source-pty-data-",
  "grok-source-pty-fake-",
  "grok-source-pty-no-ready-data-",
  "grok-source-pty-no-ready-fake-",
  "grok-source-stdin-negative-data-",
  "grok-source-stdin-negative-fake-",
  "grok-setup-storage-injection-",
  "grok-state-alias-",
  "grok-state-barrier-",
  "grok-state-data-",
  "grok-state-outside-",
  "grok-state-owner-publish-race-",
  "grok-state-release-race-",
  "grok-structure-policy-",
  "grok-terminal-intent-data-",
  "grok-test-cleanup-sandbox-",
  "grok-transfer-cap-home-",
  "grok-transfer-dispose-home-",
  "grok-transfer-home-",
  "grok-worker-missing-parent-",
  "grok-worker-proof-",
  "grok-worker-service-data-",
  "grok-worktree-data-",
  "grok-worktree-external-",
  "grok-worktree-victim-",
  "ledger-append-barrier-",
  "ledger-crash-reclaim-",
  "ledger-same-phase-barrier-",
  "ledger-transition-crash-",
  "live-inventory-outside-",
  "phase3-outside-",
  "phase3-receipt-",
  "phase3-symlink-",
  "preprovider-data-",
  "preprovider-rt-data-",
  "probe-gate-state-",
  "proof-ambient-authority-",
  "proof-external-target-",
  "proof-home-cleanup-",
  "proof-home-external-",
  "proof-home-forged-identity-",
  "proof-home-inaccessible-",
  "proof-home-rename-race-",
  "proof-home-replacement-marker-",
  "proof-path-poison-bin-",
  "proof-writer-barrier-",
  "provider-bootstrap-controller-cwd-",
  "provider-bootstrap-controller-evidence-",
  "provider-bootstrap-stdin-",
  "provider-bootstrap-worktree-provisioning-data-",
  "provider-bootstrap-worktree-wrapper-",
  "provider-controller-temp-state-",
  "provider-guard-cas-state-",
  "provider-pending-home-",
  "provider-pinned-refresh-state-",
  "provider-profile-cleanup-state-",
  "provider-startup-cancel-state-",
  "provider-state-",
  "provider-stop-reason-state-",
  "provider-version-descendant-",
  "provider-worktree-controller-path-state-",
  "recovery-observe-signal-",
  "review-import-external-",
  "review-promotion-harness-",
  "review-request-symlink-",
  "review-source-mirror-",
  "session-close-environment-",
  "worker-evidence-external-",
  "worker-evidence-phase-target-",
  "worker-launch-cli-data-",
  "worker-launch-cli-missing-data-",
  "worker-launch-cli-missing-provider-",
  "worker-launch-cli-provider-",
  "worker-launch-cli-tampered-data-",
  "worker-launch-cli-tampered-provider-",
  "worker-launch-outbox-data-",
  "worker-launch-outbox-linked-data-",
  "worker-launch-root-alias-",
  "worker-launch-root-alias-data-",
  "worker-launch-untrusted-root-",
  "worker-ledger-external-",
  "worker-protocol-data-",
  "worker-recovery-fence-data-",
  "worker-review-direct-import-",
  "worker-runtime-ignoring-controller-",
  "worker-runtime-teardown-data-",
  "worker-session-boundary-",
  "worker-startup-crash-",
  "worker-startup-crash-data-",
  "worker-supervisor-server-data-",
  "zero-skip-reporter-",
  // Literal temp families added on main after this cleanup branch began.
  "deep-research-cancel-fake-",
  "deep-research-cancel-state-",
  "deep-research-environment-",
  "deep-research-fake-",
  "deep-research-home-",
  "deep-research-nocmd-",
  "deep-research-pinned-fake-",
  "deep-research-pinned-plugin-",
  "deep-research-plugin-",
  "deep-research-plugin-cancel-",
  "deep-research-plugin-data-",
  "deep-research-plugin-nocmd-",
  "deep-research-poison-fake-",
  "deep-research-query-",
  "deep-research-runtime-state-",
  "deep-research-startup-failure-fake-",
  "deep-research-startup-failure-plugin-",
  "deep-research-startup-failure-state-",
  "deep-research-state-",
  "deep-research-state-nocmd-",
  "deep-research-unpinned-state-",
  "grok-empty-home-",
  "grok-force-cancel-task-cleanup-race-",
  "grok-force-cancel-terminal-race-",
  "grok-import-signal-injection-",
  "grok-issue34-real-vertical-",
  "grok-managed-data-",
  "grok-managed-escaped-",
  "grok-managed-home-",
  "grok-plugin-abs-hooks-",
  "grok-plugin-ancestor-hooks-",
  "grok-plugin-bisect-ctrl-",
  "grok-plugin-bisect-dwim-",
  "grok-plugin-bound-hooks-",
  "grok-plugin-bound-op-",
  "grok-plugin-cfg-linked-",
  "grok-plugin-ext-config-",
  "grok-plugin-ext-hooks-",
  "grok-plugin-hooks-include-",
  "grok-plugin-hooks-link-",
  "grok-plugin-hop-race-",
  "grok-plugin-lexical-sibling-",
  "grok-plugin-linked-ref-",
  "grok-plugin-merge-rr-",
  "grok-plugin-meta-symlink-",
  "grok-plugin-missing-hooks-race-",
  "grok-plugin-mode-sibling-",
  "grok-plugin-old-git-",
  "grok-plugin-op-linked-",
  "grok-plugin-ord-dir-race-",
  "grok-plugin-ordinary-hooks-",
  "grok-plugin-primary-unattr-linked-",
  "grok-plugin-private-refs-",
  "grok-plugin-race-hooks-",
  "grok-plugin-real-hooks-",
  "grok-plugin-reftable-",
  "grok-plugin-reftable-oversize-",
  "grok-plugin-rel-link-hooks-",
  "grok-plugin-remote-",
  "grok-plugin-root-race-",
  "grok-plugin-same-capture-sibling-",
  "grok-plugin-sparse-ctrl-",
  "grok-plugin-unresolved-upstream-",
  "grok-runtime-linked-ref-",
  "grok-session-end-signal-data-",
  "grok-session-end-signal-injection-",
  "grok-unmanaged-home-",
  "grok-unmanaged-provider-",
  "runner-failures-",
  // Finite template-literal expansions whose labels are checked in beside the
  "fake-grok-ready-duplicate-label-",
  "fake-grok-ready-empty-",
  "fake-grok-ready-empty-labeled-group-",
  "fake-grok-ready-header-only-",
  "fake-grok-ready-impossible-date-",
  "fake-grok-ready-malformed-",
  "fake-grok-ready-malformed-label-",
  "fake-grok-ready-official-empty-",
  "fake-grok-ready-sentinel-with-table-",
  "fake-grok-ready-stderr-only-",
  "fake-grok-ready-summary-only-",
  "fake-grok-ready-warning-row-",
  "grok-rotation-cancel-before-spawn-data-",
  "grok-rotation-foreign-fence-data-",
  "grok-rotation-foreign-intent-data-",
  "grok-rotation-guard-wins-data-",
  "grok-rotation-malformed-intent-data-",
  "grok-rotation-no-child-data-",
  "grok-rotation-pending-recovery-data-",
  "grok-rotation-registered-data-",
  "grok-rotation-unsettled-data-",
  "ledger-fresh-ownerless-",
  "ledger-old-live-owner-",
  "provider-bootstrap-cleanup-winner-data-",
  "provider-bootstrap-guard-wins-data-",
  "provider-bootstrap-late-registration-data-",
  "provider-bootstrap-term-resistant-data-",
  "provider-bootstrap-version-descendant-data-",
  "provider-bootstrap-write-binding-data-",
  "worker-supervisor-cancelled-data-",
  "worker-supervisor-capability-revalidation-data-",
  "worker-supervisor-concurrent-data-",
  "worker-supervisor-durable-binding-data-",
  "worker-supervisor-expired-data-",
  "worker-supervisor-grant-bound-data-",
  "worker-supervisor-intent-data-",
  "worker-supervisor-negative-data-",
  "worker-supervisor-process-data-",
  "worker-supervisor-restart-data-",
  "worker-supervisor-scan-safety-data-",
  "worker-supervisor-terminal-data-"
].sort());
const LSOF_CANDIDATES = Object.freeze(["/usr/sbin/lsof", "/usr/bin/lsof"]);
const PS_CANDIDATES = Object.freeze(["/bin/ps", "/usr/bin/ps"]);
const GIT_CANDIDATES = Object.freeze(["/opt/homebrew/bin/git", "/usr/bin/git"]);
const WORKTREE_PROOF_SCHEMA = "grok-worktree-registration-proof-v1";
const WORKTREE_METADATA_FILE_MAX_BYTES = 1024 * 1024;
const WORKTREE_METADATA_TOTAL_MAX_BYTES = 16 * 1024 * 1024;
const WORKTREE_GIT_EXECUTABLE_MAX_BYTES = 128 * 1024 * 1024;
const WORKTREE_GIT_EXECUTABLE_LINK_MAX_BYTES = 4 * 1024;
const WORKTREE_REGISTRATION_MAX_ENTRIES = 4096;
const WORKTREE_REGISTRATION_CONTROL_MAX_ENTRIES = 64;
const WORKTREE_DESCENDANT_GIT_SCAN_MAX_ENTRIES = 10_000;
const WORKTREE_REGISTRATION_RELEVANT_FILES = new Set([
  "commondir",
  "config.worktree",
  "gitdir",
  "locked"
]);
const WORKTREE_REGISTRATION_IGNORED_FILES = new Set([
  "AUTO_MERGE",
  "CHERRY_PICK_HEAD",
  "COMMIT_EDITMSG",
  "FETCH_HEAD",
  "HEAD",
  "ORIG_HEAD",
  "REBASE_HEAD",
  "REVERT_HEAD",
  "SQUASH_MSG",
  "codex-synced-branch.json",
  "codex-thread.json",
  "index"
]);
const WORKTREE_REGISTRATION_IGNORED_DIRECTORIES = new Set([
  "info",
  "logs",
  "rebase-apply",
  "rebase-merge",
  "refs",
  "sequencer"
]);
const WORKTREE_GIT_ENV = Object.freeze({
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C",
  LC_ALL: "C"
});
const SIX_CHARACTER_SUFFIX = /^[A-Za-z0-9]{6}$/u;
const MANAGED_PREFIX_KINDS = new Map([
  [TEST_TEMP_RUN_PREFIX, "run"],
  [TEST_TEMP_PROCESS_PREFIX, "process"]
]);
const LEGACY_PREFIX_SET = new Set(LEGACY_TEST_TEMP_PREFIXES);

function trustedExecutable(candidates) {
  return candidates.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) || null;
}

function bigintIdentity(stat, { semantic = false } = {}) {
  const identity = {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    uid: String(stat.uid),
    nlink: String(stat.nlink),
    size: String(stat.size)
  };
  if (!semantic) {
    identity.mtimeNs = String(stat.mtimeNs);
    identity.ctimeNs = String(stat.ctimeNs);
  }
  return identity;
}

function sameBigintIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function semanticDirectoryIdentity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    uid: String(stat.uid)
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableDirectory(target, expectedUid) {
  const stat = fs.lstatSync(target, { bigint: true });
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.uid !== BigInt(expectedUid)
    || (stat.mode & 0o022n) !== 0n
  ) {
    throw new Error("Unsafe worktree metadata directory.");
  }
  const resolved = path.resolve(target);
  if (fs.realpathSync(resolved) !== resolved) {
    throw new Error("Worktree metadata directory is not canonical.");
  }
  return stat;
}

function unstableWorktreeMetadata(message) {
  const error = new Error(message);
  error.code = "E_WORKTREE_METADATA_CHANGED";
  return error;
}

function stableFileOnce(
  target,
  expectedUid,
  budget,
  {
    maxBytes = WORKTREE_METADATA_FILE_MAX_BYTES,
    allowMultipleLinks = false,
    allowRootOwner = false
  } = {}
) {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
    throw new Error("No-follow metadata reads are unavailable.");
  }
  const before = fs.lstatSync(target, { bigint: true });
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || (before.uid !== BigInt(expectedUid) && !(allowRootOwner && before.uid === 0n))
    || (!allowMultipleLinks && before.nlink !== 1n)
    || (allowMultipleLinks && before.nlink < 1n)
    || before.size < 0n
    || before.size > BigInt(maxBytes)
    || (before.mode & 0o022n) !== 0n
  ) {
    throw new Error("Unsafe worktree metadata file.");
  }
  let descriptor;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const openedBefore = fs.fstatSync(descriptor, { bigint: true });
    if (!sameBigintIdentity(bigintIdentity(before), bigintIdentity(openedBefore))) {
      throw unstableWorktreeMetadata("Worktree metadata changed before it was opened.");
    }
    const contents = fs.readFileSync(descriptor);
    if (contents.length !== Number(openedBefore.size)) {
      throw unstableWorktreeMetadata(
        "Worktree metadata length changed while it was read."
      );
    }
    if (budget) {
      budget.remaining -= contents.length;
      if (budget.remaining < 0) throw new Error("Worktree metadata budget exceeded.");
    }
    const contentDigest = sha256(contents);
    const openedAfter = fs.fstatSync(descriptor, { bigint: true });
    const after = fs.lstatSync(target, { bigint: true });
    if (
      !sameBigintIdentity(bigintIdentity(openedBefore), bigintIdentity(openedAfter))
      || !sameBigintIdentity(bigintIdentity(openedAfter), bigintIdentity(after))
    ) {
      throw unstableWorktreeMetadata("Worktree metadata changed while it was read.");
    }
    return {
      contents,
      digest: contentDigest,
      identity: bigintIdentity(openedAfter),
      semanticIdentity: bigintIdentity(openedAfter, { semantic: true })
    };
  } finally {
    if (Number.isInteger(descriptor)) fs.closeSync(descriptor);
  }
}

function stableFile(target, expectedUid, budget, options = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return stableFileOnce(target, expectedUid, budget, options);
    } catch (error) {
      if (error?.code !== "E_WORKTREE_METADATA_CHANGED" || attempt === 1) {
        throw error;
      }
    }
  }
  throw new Error("Worktree metadata did not stabilize.");
}

function optionalStableFile(target, expectedUid, budget, options = {}) {
  try {
    return stableFile(target, expectedUid, budget, options);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function decodeMetadataFile(file) {
  if (!file?.contents) throw new Error("Worktree metadata contents are unavailable.");
  const text = file.contents.toString("utf8");
  if (text.includes("\u0000") || !Buffer.from(text, "utf8").equals(file.contents)) {
    throw new Error("Worktree metadata text is invalid.");
  }
  return text;
}

function exactControlLine(file) {
  const text = decodeMetadataFile(file);
  let line = text;
  if (line.endsWith("\r\n")) line = line.slice(0, -2);
  else if (line.endsWith("\n")) line = line.slice(0, -1);
  if (
    !line
    || /[\r\n]/u.test(line)
    || line !== line.trim()
  ) {
    throw new Error("Git control metadata must contain one exact line.");
  }
  return line;
}

function rejectConfigIncludes(file) {
  if (!file) return;
  const text = decodeMetadataFile(file);
  if (
    /^\s*\[\s*include(?:if)?(?:\s|\])/imu.test(text)
    || /^\s*include(?:if)?\s*\./imu.test(text)
  ) {
    throw new Error("Included Git configuration is unsupported for cleanup proofing.");
  }
}

function resolveControlPath(base, value) {
  if (!value || value.includes("\u0000") || /[\r\n]/u.test(value)) {
    throw new Error("Invalid Git control-directory path.");
  }
  const lexicalTarget = path.resolve(base, value);
  const rawTarget = path.isAbsolute(value)
    ? value
    : `${base}${base.endsWith(path.sep) ? "" : path.sep}${value}`;
  if (fs.realpathSync.native(rawTarget) !== lexicalTarget) {
    throw new Error("Git control-directory path is physically ambiguous.");
  }
  return lexicalTarget;
}

function resolveControlDirectory(base, value) {
  return resolveControlPath(base, value);
}

function relevantFileProof(file) {
  return file
    ? {
        digest: file.digest,
        identity: file.semanticIdentity
      }
    : null;
}

function generationFileProof(file) {
  return file ? file.identity : null;
}

function boundedDirectoryNames(target, maximum) {
  const directory = fs.opendirSync(target);
  const names = [];
  try {
    while (true) {
      const entry = directory.readSync();
      if (!entry) break;
      if (names.length >= maximum) {
        throw new Error("Worktree metadata directory exceeds its entry budget.");
      }
      names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return names.sort();
}

function captureRelativeRegistrationGitDir(
  registrationDirectory,
  gitdirFile,
  expectedUid,
  budget
) {
  const value = exactControlLine(gitdirFile);
  if (path.isAbsolute(value)) return null;
  const canonicalTarget = resolveControlPath(registrationDirectory, value);
  const parentPath = path.dirname(canonicalTarget);
  const parentBefore = stableDirectory(parentPath, expectedUid);
  const targetFile = stableFile(canonicalTarget, expectedUid, budget);
  const marker = exactControlLine(targetFile);
  if (!/^gitdir: [^\r\n]+$/u.test(marker)) {
    throw new Error("Relative worktree registration target is not a linked gitfile.");
  }
  const parentAfter = stableDirectory(parentPath, expectedUid);
  if (!sameBigintIdentity(
    bigintIdentity(parentBefore),
    bigintIdentity(parentAfter)
  )) {
    throw unstableWorktreeMetadata(
      "Relative worktree registration target changed while it was captured."
    );
  }
  return {
    semantic: {
      lexicalPath: canonicalTarget,
      parent: {
        identity: semanticDirectoryIdentity(parentAfter),
        path: parentPath
      },
      target: {
        file: relevantFileProof(targetFile),
        path: canonicalTarget
      }
    },
    generation: {
      parent: bigintIdentity(parentAfter),
      target: generationFileProof(targetFile)
    }
  };
}

function registrationIgnoredEntryIsKnown(name, stat) {
  if (stat.isDirectory()) return WORKTREE_REGISTRATION_IGNORED_DIRECTORIES.has(name);
  if (!stat.isFile()) return false;
  return WORKTREE_REGISTRATION_IGNORED_FILES.has(name)
    || /^(?:BISECT|MERGE)_[A-Z0-9_]+$/u.test(name)
    || /^sharedindex\.[a-fA-F0-9]{40,64}$/u.test(name);
}

function captureRegistrationDirectory(target, name, expectedUid, budget) {
  const directoryBefore = stableDirectory(target, expectedUid);
  const entries = boundedDirectoryNames(
    target,
    WORKTREE_REGISTRATION_CONTROL_MAX_ENTRIES
  );
  const files = {};
  for (const entry of entries) {
    const entryPath = path.join(target, entry);
    const stat = fs.lstatSync(entryPath, { bigint: true });
    if (stat.isSymbolicLink() || stat.uid !== BigInt(expectedUid)) {
      throw new Error("Unsafe worktree registration control entry.");
    }
    if (entry.endsWith(".lock")) {
      throw new Error("Worktree registration mutation is in progress.");
    }
    if (WORKTREE_REGISTRATION_RELEVANT_FILES.has(entry)) {
      if (!stat.isFile()) throw new Error("Invalid worktree registration control file.");
      files[entry] = stableFile(entryPath, expectedUid, budget);
      if (entry === "config.worktree") rejectConfigIncludes(files[entry]);
      continue;
    }
    if (!registrationIgnoredEntryIsKnown(entry, stat)) {
      throw new Error("Unexpected worktree registration control entry.");
    }
  }
  if (!files.gitdir || !files.commondir) {
    throw new Error("Incomplete worktree registration metadata.");
  }
  const relativeGitDir = captureRelativeRegistrationGitDir(
    target,
    files.gitdir,
    expectedUid,
    budget
  );
  const directoryAfter = stableDirectory(target, expectedUid);
  if (!sameBigintIdentity(bigintIdentity(directoryBefore), bigintIdentity(directoryAfter))) {
    throw new Error("Worktree registration changed while it was captured.");
  }
  return {
    name,
    identity: semanticDirectoryIdentity(directoryAfter),
    commondir: relevantFileProof(files.commondir),
    configWorktree: relevantFileProof(files["config.worktree"]),
    gitdir: relevantFileProof(files.gitdir),
    relativeGitDir: relativeGitDir?.semantic ?? null,
    locked: relevantFileProof(files.locked),
    generation: {
      identity: bigintIdentity(directoryAfter),
      commondir: generationFileProof(files.commondir),
      configWorktree: generationFileProof(files["config.worktree"]),
      gitdir: generationFileProof(files.gitdir),
      relativeGitDir: relativeGitDir?.generation ?? null,
      locked: generationFileProof(files.locked)
    }
  };
}

function stableExecutableDirectory(target, expectedUid) {
  const stat = fs.lstatSync(target, { bigint: true });
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.uid !== BigInt(expectedUid) && stat.uid !== 0n)
    || (stat.mode & 0o022n) !== 0n
  ) {
    throw new Error("Unsafe Git executable directory.");
  }
  const resolved = path.resolve(target);
  if (fs.realpathSync(resolved) !== resolved) {
    throw new Error("Git executable directory is not canonical.");
  }
  return stat;
}

function stableExecutableLink(target, expectedUid) {
  const before = fs.lstatSync(target, { bigint: true });
  if (
    !before.isSymbolicLink()
    || (before.uid !== BigInt(expectedUid) && before.uid !== 0n)
    || before.nlink < 1n
    || before.size < 1n
    || before.size > BigInt(WORKTREE_GIT_EXECUTABLE_LINK_MAX_BYTES)
  ) {
    throw new Error("Unsafe Git executable symlink.");
  }
  const rawTarget = fs.readlinkSync(target, { encoding: "buffer" });
  if (
    !Buffer.isBuffer(rawTarget)
    || rawTarget.length !== Number(before.size)
    || rawTarget.includes(0)
  ) {
    throw new Error("Invalid Git executable symlink.");
  }
  const linkTarget = rawTarget.toString("utf8");
  if (
    !linkTarget
    || /[\r\n]/u.test(linkTarget)
    || !Buffer.from(linkTarget, "utf8").equals(rawTarget)
  ) {
    throw new Error("Invalid Git executable symlink text.");
  }
  const after = fs.lstatSync(target, { bigint: true });
  if (!sameBigintIdentity(bigintIdentity(before), bigintIdentity(after))) {
    throw new Error("Git executable symlink changed while it was read.");
  }
  return {
    identity: bigintIdentity(after),
    linkTarget,
    semanticIdentity: bigintIdentity(after, { semantic: true })
  };
}

function selectGitExecutable(candidates, expectedUid) {
  for (const candidate of candidates) {
    try {
      const authority = fs.lstatSync(candidate, { bigint: true });
      let link = null;
      let executablePath = candidate;
      if (authority.isSymbolicLink()) {
        link = stableExecutableLink(candidate, expectedUid);
        executablePath = fs.realpathSync(candidate);
      } else if (!authority.isFile()) {
        continue;
      }
      if (!path.isAbsolute(executablePath) || fs.realpathSync(executablePath) !== executablePath) {
        throw new Error("Git executable target is not canonical.");
      }
      const executableParent = path.dirname(executablePath);
      const parent = stableExecutableDirectory(executableParent, expectedUid);
      const file = stableFile(executablePath, expectedUid, null, {
        allowMultipleLinks: true,
        allowRootOwner: true,
        maxBytes: WORKTREE_GIT_EXECUTABLE_MAX_BYTES
      });
      if ((BigInt(file.identity.mode) & 0o111n) === 0n) continue;
      return {
        path: executablePath,
        proof: {
          authorityPath: candidate,
          link: link
            ? {
                identity: link.semanticIdentity,
                target: link.linkTarget
              }
            : null,
          parent: {
            identity: semanticDirectoryIdentity(parent),
            path: executableParent
          },
          target: {
            digest: file.digest,
            identity: file.semanticIdentity,
            path: executablePath
          }
        },
        generation: {
          link: link?.identity ?? null,
          parent: bigintIdentity(parent),
          target: file.identity
        }
      };
    } catch {
    }
  }
  throw new Error("A trusted Git executable is unavailable.");
}

function captureWorktreeMetadataProofPass(repoRoot, {
  expectedUid,
  gitCandidates
}) {
  const budget = { remaining: WORKTREE_METADATA_TOTAL_MAX_BYTES };
  const canonicalRepoRoot = fs.realpathSync(path.resolve(repoRoot));
  if (canonicalRepoRoot !== path.resolve(canonicalRepoRoot)) {
    throw new Error("Repository root is not canonical.");
  }
  const rootBefore = stableDirectory(canonicalRepoRoot, expectedUid);
  const markerPath = path.join(canonicalRepoRoot, ".git");
  const markerStat = fs.lstatSync(markerPath, { bigint: true });
  let activeGitDir;
  let markerGeneration;
  let markerProof;
  if (markerStat.isDirectory() && !markerStat.isSymbolicLink()) {
    activeGitDir = markerPath;
    const markerDirectory = stableDirectory(markerPath, expectedUid);
    markerProof = {
      kind: "directory",
      identity: semanticDirectoryIdentity(markerDirectory)
    };
    markerGeneration = bigintIdentity(markerDirectory);
  } else if (markerStat.isFile() && !markerStat.isSymbolicLink()) {
    const markerFile = stableFile(markerPath, expectedUid, budget);
    const markerText = exactControlLine(markerFile);
    const match = /^gitdir: ([^\r\n]+)$/u.exec(markerText);
    if (!match || match[1] !== match[1].trim()) {
      throw new Error("Invalid linked-worktree gitfile.");
    }
    activeGitDir = resolveControlDirectory(canonicalRepoRoot, match[1]);
    markerProof = {
      kind: "file",
      file: relevantFileProof(markerFile)
    };
    markerGeneration = generationFileProof(markerFile);
  } else {
    throw new Error("Unsupported or bare repository layout.");
  }
  const activeBefore = stableDirectory(activeGitDir, expectedUid);
  const commonLink = optionalStableFile(
    path.join(activeGitDir, "commondir"),
    expectedUid,
    budget
  );
  const commonDir = commonLink
    ? resolveControlDirectory(activeGitDir, exactControlLine(commonLink))
    : activeGitDir;
  const commonBefore = stableDirectory(commonDir, expectedUid);

  for (const lockPath of [
    path.join(commonDir, "config.lock"),
    path.join(activeGitDir, "config.worktree.lock")
  ]) {
    try {
      fs.lstatSync(lockPath);
      throw new Error("Git configuration mutation is in progress.");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const commonConfig = stableFile(path.join(commonDir, "config"), expectedUid, budget);
  const activeWorktreeConfig = optionalStableFile(
    path.join(activeGitDir, "config.worktree"),
    expectedUid,
    budget
  );
  rejectConfigIncludes(commonConfig);
  rejectConfigIncludes(activeWorktreeConfig);

  const registrationsRoot = path.join(commonDir, "worktrees");
  let registrationsRootProof = null;
  let registrationsRootGeneration = null;
  const registrations = [];
  let registrationsBefore = null;
  try {
    registrationsBefore = stableDirectory(registrationsRoot, expectedUid);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (registrationsBefore) {
    const names = boundedDirectoryNames(
      registrationsRoot,
      WORKTREE_REGISTRATION_MAX_ENTRIES
    );
    for (const name of names) {
      registrations.push(captureRegistrationDirectory(
        path.join(registrationsRoot, name),
        name,
        expectedUid,
        budget
      ));
    }
    const registrationsAfter = stableDirectory(registrationsRoot, expectedUid);
    if (!sameBigintIdentity(
      bigintIdentity(registrationsBefore),
      bigintIdentity(registrationsAfter)
    )) {
      throw new Error("Worktree registrations changed while they were captured.");
    }
    registrationsRootProof = semanticDirectoryIdentity(registrationsAfter);
    registrationsRootGeneration = bigintIdentity(registrationsAfter);
  }

  const activeAfter = stableDirectory(activeGitDir, expectedUid);
  const commonAfter = stableDirectory(commonDir, expectedUid);
  const rootAfter = stableDirectory(canonicalRepoRoot, expectedUid);
  if (
    !sameBigintIdentity(bigintIdentity(rootBefore), bigintIdentity(rootAfter))
    || !sameBigintIdentity(bigintIdentity(activeBefore), bigintIdentity(activeAfter))
    || !sameBigintIdentity(bigintIdentity(commonBefore), bigintIdentity(commonAfter))
  ) {
    throw new Error("Git metadata changed while the proof was captured.");
  }
  const gitExecutable = selectGitExecutable(gitCandidates, expectedUid);
  const semantic = {
    schema: WORKTREE_PROOF_SCHEMA,
    repoRoot: {
      path: canonicalRepoRoot,
      identity: semanticDirectoryIdentity(rootAfter)
    },
    marker: markerProof,
    activeGitDir: {
      path: activeGitDir,
      identity: semanticDirectoryIdentity(activeAfter),
      commondir: relevantFileProof(commonLink),
      configWorktree: relevantFileProof(activeWorktreeConfig)
    },
    commonDir: {
      path: commonDir,
      identity: semanticDirectoryIdentity(commonAfter),
      config: relevantFileProof(commonConfig),
      worktrees: registrationsRootProof
    },
    registrations: registrations.map((registration) => ({
      name: registration.name,
      identity: registration.identity,
      commondir: registration.commondir,
      configWorktree: registration.configWorktree,
      gitdir: registration.gitdir,
      relativeGitDir: registration.relativeGitDir,
      locked: registration.locked
    })),
    gitExecutable: gitExecutable.proof
  };
  const generation = {
    schema: WORKTREE_PROOF_SCHEMA,
    repoRoot: bigintIdentity(rootAfter),
    marker: markerGeneration,
    activeGitDir: {
      identity: bigintIdentity(activeAfter),
      commondir: generationFileProof(commonLink),
      configWorktree: generationFileProof(activeWorktreeConfig)
    },
    commonDir: {
      identity: bigintIdentity(commonAfter),
      config: generationFileProof(commonConfig),
      worktrees: registrationsRootGeneration
    },
    registrations: registrations.map((registration) => ({
      name: registration.name,
      ...registration.generation
    })),
    gitExecutable: gitExecutable.generation
  };
  return {
    canonicalRepoRoot,
    digest: sha256(JSON.stringify(semantic)),
    generationDigest: sha256(JSON.stringify(generation)),
    gitExecutable: gitExecutable.path
  };
}

function captureWorktreeMetadataProof(repoRoot, options) {
  const first = captureWorktreeMetadataProofPass(repoRoot, options);
  const second = captureWorktreeMetadataProofPass(repoRoot, options);
  if (
    !sameDigest(first.digest, second.digest)
    || !sameDigest(first.generationDigest, second.generationDigest)
  ) {
    throw new Error("Git metadata changed across the stable proof boundary.");
  }
  return second;
}

function canonicalRegisteredPath(value) {
  let cursor = path.resolve(value);
  const missingSuffix = [];
  while (true) {
    try {
      return path.join(fs.realpathSync(cursor), ...missingSuffix);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      let missing = false;
      try {
        const stat = fs.lstatSync(cursor);
        if (stat.isSymbolicLink()) {
          throw new Error("Registered worktree path has a dangling symlink.");
        }
      } catch (lstatError) {
        if (lstatError?.code !== "ENOENT") throw lstatError;
        missing = true;
      }
      if (!missing) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missingSuffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function registeredPathAliases(value) {
  const aliases = new Set([
    path.resolve(value),
    canonicalRegisteredPath(value)
  ]);
  for (const alias of [...aliases]) {
    if (alias.startsWith(`/private${path.sep}`)) aliases.add(alias.slice("/private".length));
    if (
      process.platform === "darwin"
      && (alias.startsWith(`${path.sep}tmp${path.sep}`) || alias.startsWith(`${path.sep}var${path.sep}`))
    ) {
      aliases.add(`/private${alias}`);
    }
  }
  return [...aliases];
}

function materializeRegisteredPathAliasesOnce(rawPaths) {
  return [...new Set(rawPaths.flatMap((value) => registeredPathAliases(value)))].sort();
}

function materializeRegisteredPathAliases(rawPaths) {
  const first = materializeRegisteredPathAliasesOnce(rawPaths);
  const second = materializeRegisteredPathAliasesOnce(rawPaths);
  if (!sameDigest(sha256(JSON.stringify(first)), sha256(JSON.stringify(second)))) {
    throw new Error("Registered worktree path aliases changed while they were captured.");
  }
  return second;
}

function materializeRegisteredPathSnapshot(rawPaths, canonicalRepoRoot) {
  const paths = materializeRegisteredPathAliases(rawPaths);
  if (rawPaths.length === 0 || !paths.includes(canonicalRepoRoot)) {
    throw new Error("Git did not report the active repository worktree.");
  }
  return paths;
}

function parseRegisteredWorktreeOutput(stdout, canonicalRepoRoot) {
  const rawPaths = [];
  let inRecord = false;
  for (const line of String(stdout || "").split(/\r?\n/u)) {
    if (line === "") {
      inRecord = false;
      continue;
    }
    if (line.startsWith("worktree ")) {
      const value = line.slice("worktree ".length);
      if (
        !path.isAbsolute(value)
        || value.includes("\u0000")
        || path.normalize(value) !== value
      ) {
        throw new Error("Git returned an invalid worktree path.");
      }
      rawPaths.push(value);
      inRecord = true;
      continue;
    }
    if (!inRecord || !(
      /^(?:HEAD [a-fA-F0-9]{40,64}|branch \S+|bare|detached|locked(?: .*)?|prunable(?: .*)?)$/u.test(line)
    )) {
      throw new Error("Git returned invalid worktree porcelain output.");
    }
  }
  const normalized = [...new Set(rawPaths)].sort();
  materializeRegisteredPathSnapshot(normalized, canonicalRepoRoot);
  return normalized;
}

function enumerateRegisteredWorktrees(proof, run) {
  const result = run(proof.gitExecutable, ["worktree", "list", "--porcelain"], {
    cwd: proof.canonicalRepoRoot,
    encoding: "utf8",
    env: { ...WORKTREE_GIT_ENV },
    shell: false,
    timeout: TEST_TEMP_WORKTREE_SCAN_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result?.status !== 0 || result?.error || result?.signal) {
    throw new Error("Git worktree enumeration failed.");
  }
  return parseRegisteredWorktreeOutput(result.stdout, proof.canonicalRepoRoot);
}

export function createRegisteredWorktreeProvider(repoRoot, {
  run = spawnSync,
  expectedUid = typeof process.getuid === "function" ? process.getuid() : null,
  gitCandidates = GIT_CANDIDATES
} = {}) {
  let cached = null;
  return function registeredWorktrees() {
    if (!Number.isSafeInteger(expectedUid) || expectedUid < 0) {
      cached = null;
      return { available: false, paths: [], reason: "owner-visibility-unavailable" };
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let before;
      try {
        before = captureWorktreeMetadataProof(repoRoot, {
          expectedUid,
          gitCandidates
        });
      } catch {
        if (attempt === 0) continue;
        cached = null;
        return { available: false, paths: [], reason: "worktree-metadata-unavailable" };
      }
      if (cached && sameDigest(before.digest, cached.metadataDigest)) {
        const expectedBinding = sha256(
          `${WORKTREE_PROOF_SCHEMA}\u0000${before.digest}\u0000${cached.rawPathsDigest}`
        );
        if (sameDigest(expectedBinding, cached.bindingDigest)) {
          try {
            return {
              available: true,
              paths: materializeRegisteredPathSnapshot(
                cached.rawPaths,
                before.canonicalRepoRoot
              )
            };
          } catch {
            return {
              available: false,
              paths: [],
              reason: "worktree-path-alias-unavailable"
            };
          }
        }
        cached = null;
      }
      let rawPaths;
      try {
        rawPaths = enumerateRegisteredWorktrees(before, run);
      } catch {
        cached = null;
        return { available: false, paths: [], reason: "git-worktree-list-failed" };
      }
      let after;
      try {
        after = captureWorktreeMetadataProof(repoRoot, {
          expectedUid,
          gitCandidates
        });
      } catch {
        if (attempt === 0) continue;
        cached = null;
        return { available: false, paths: [], reason: "worktree-metadata-unstable" };
      }
      if (
        !sameDigest(before.digest, after.digest)
        || !sameDigest(before.generationDigest, after.generationDigest)
      ) {
        if (attempt === 0) continue;
        cached = null;
        return { available: false, paths: [], reason: "worktree-metadata-unstable" };
      }
      const rawPathsDigest = sha256(JSON.stringify(rawPaths));
      let paths;
      try {
        paths = materializeRegisteredPathSnapshot(rawPaths, after.canonicalRepoRoot);
      } catch {
        cached = null;
        return {
          available: false,
          paths: [],
          reason: "worktree-path-alias-unavailable"
        };
      }
      cached = Object.freeze({
        bindingDigest: sha256(
          `${WORKTREE_PROOF_SCHEMA}\u0000${after.digest}\u0000${rawPathsDigest}`
        ),
        metadataDigest: after.digest,
        rawPaths: Object.freeze([...rawPaths]),
        rawPathsDigest
      });
      return { available: true, paths };
    }
    cached = null;
    return { available: false, paths: [], reason: "worktree-metadata-unstable" };
  };
}

function canonicalRoot(root) {
  if (!path.isAbsolute(root)) throw new Error("Temp root must be absolute.");
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Temp root must be a real directory.");
  }
  const real = fs.realpathSync(root);
  if (real !== path.resolve(root)) throw new Error("Temp root must already be canonical.");
  return real;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function classifyName(name, legacy) {
  if (name.length <= 6 || !SIX_CHARACTER_SUFFIX.test(name.slice(-6))) return null;
  const prefix = name.slice(0, -6);
  const manifestKind = MANAGED_PREFIX_KINDS.get(prefix);
  if (manifestKind) return { prefix, kind: "managed", manifestKind };
  if (!legacy) return null;
  if (prefix === LEGACY_REPOSITORY_PREFIX) {
    return { prefix: LEGACY_REPOSITORY_PREFIX, kind: "legacy-repository" };
  }
  if (LEGACY_PREFIX_SET.has(prefix)) return { prefix, kind: "legacy" };
  return null;
}

function stableIdentity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    uid: String(stat.uid),
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
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameRelocatedIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

const TEST_TEMP_MANIFEST_MAX_BYTES = 4 * 1024;

function manifestIdentity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    uid: String(stat.uid),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs)
  };
}

function sameManifestIdentity(left, right) {
  return Boolean(
    left
    && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
  );
}

function sameDigest(left, right) {
  if (
    typeof left !== "string"
    || typeof right !== "string"
    || !/^[a-f0-9]{64}$/u.test(left)
    || !/^[a-f0-9]{64}$/u.test(right)
  ) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function readStableOwnerManifest(root, expectedUid) {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) return null;
  const manifestPath = path.join(root, TEST_TEMP_MANIFEST);
  const exactExpectedUid = BigInt(expectedUid);
  let descriptor;
  try {
    const directoryBefore = fs.lstatSync(root, { bigint: true });
    const pathBefore = fs.lstatSync(manifestPath, { bigint: true });
    if (
      !directoryBefore.isDirectory()
      || directoryBefore.isSymbolicLink()
      || directoryBefore.uid !== exactExpectedUid
      || !pathBefore.isFile()
      || pathBefore.isSymbolicLink()
      || pathBefore.uid !== exactExpectedUid
      || (pathBefore.mode & 0o777n) !== 0o600n
      || pathBefore.size < 0n
      || pathBefore.size > BigInt(TEST_TEMP_MANIFEST_MAX_BYTES)
    ) {
      return null;
    }
    descriptor = fs.openSync(
      manifestPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    const openedBefore = fs.fstatSync(descriptor, { bigint: true });
    if (
      !openedBefore.isFile()
      || openedBefore.isSymbolicLink()
      || openedBefore.uid !== exactExpectedUid
      || (openedBefore.mode & 0o777n) !== 0o600n
      || openedBefore.size < 0n
      || openedBefore.size > BigInt(TEST_TEMP_MANIFEST_MAX_BYTES)
      || !sameManifestIdentity(
        manifestIdentity(pathBefore),
        manifestIdentity(openedBefore)
      )
    ) {
      return null;
    }
    const contents = fs.readFileSync(descriptor);
    const openedAfter = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(manifestPath, { bigint: true });
    const directoryAfter = fs.lstatSync(root, { bigint: true });
    if (
      BigInt(contents.length) !== openedAfter.size
      || !sameManifestIdentity(
        manifestIdentity(openedBefore),
        manifestIdentity(openedAfter)
      )
      || !sameManifestIdentity(
        manifestIdentity(openedAfter),
        manifestIdentity(pathAfter)
      )
      || directoryBefore.dev !== directoryAfter.dev
      || directoryBefore.ino !== directoryAfter.ino
      || directoryBefore.mode !== directoryAfter.mode
      || directoryBefore.uid !== directoryAfter.uid
    ) {
      return null;
    }
    const value = validateTestTempManifest(JSON.parse(contents.toString("utf8")));
    if (!value) return null;
    return {
      value,
      identity: manifestIdentity(openedAfter),
      digest: createHash("sha256").update(contents).digest("hex")
    };
  } catch {
    return null;
  } finally {
    if (Number.isInteger(descriptor)) fs.closeSync(descriptor);
  }
}

function sameOwnerManifestSnapshot(left, right) {
  return Boolean(
    left
    && right
    && sameManifestIdentity(left.identity, right.identity)
    && sameDigest(left.digest, right.digest)
  );
}

function exactIdentityArgument(value) {
  if (typeof value === "bigint") {
    return value >= 0n ? String(value) : null;
  }
  if (
    typeof value === "string"
    && /^(?:0|[1-9][0-9]*)$/u.test(value)
  ) {
    return value;
  }
  return null;
}

const REMOVE_INVENTORIED_ROOT_HELPER = fileURLToPath(
  new URL("./test-temp-remove-helper.cjs", import.meta.url)
);

export function removeInventoriedTestTempRoot(
  root,
  expectedIdentity,
  {
    run = spawnSync,
    afterQuarantine = null,
    gitContainment = null
  } = {}
) {
  if (!root || !path.isAbsolute(root) || !expectedIdentity) return false;
  const expectedDev = exactIdentityArgument(expectedIdentity.dev);
  const expectedIno = exactIdentityArgument(expectedIdentity.ino);
  if (!expectedDev || !expectedIno) {
    const error = new Error("The cleanup candidate identity is not exact.");
    error.code = "E_TEST_TEMP_IDENTITY_CHANGED";
    throw error;
  }
  let canonicalOriginalRoot;
  try {
    canonicalOriginalRoot = canonicalContainedPath(root);
  } catch {
    const error = new Error("The cleanup candidate path is not canonical.");
    error.code = "E_TEST_TEMP_IDENTITY_CHANGED";
    throw error;
  }
  const quarantine = path.join(
    path.dirname(root),
    `.grok-plugin-cleanup-quarantine-${randomUUID()}`
  );
  try {
    fs.renameSync(root, quarantine);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }

  try {
    const canonicalQuarantine = canonicalContainedPath(quarantine);
    if (afterQuarantine) {
      afterQuarantine(quarantine, {
        canonicalOriginalRoot,
        canonicalQuarantine
      });
    }
    const managedContainment = gitContainment
      && gitContainment.originalRoot === root
      && Number.isSafeInteger(gitContainment.expectedUid)
      && gitContainment.expectedUid >= 0
      && /^[a-f0-9]{64}$/u.test(gitContainment.digest || "");
    const helperArguments = [
      REMOVE_INVENTORIED_ROOT_HELPER,
      expectedDev,
      expectedIno,
      expectedDev,
      managedContainment ? "managed-contained" : "guarded",
      "none"
    ];
    if (managedContainment) {
      helperArguments.push(
        canonicalOriginalRoot,
        canonicalQuarantine,
        String(gitContainment.expectedUid),
        gitContainment.digest
      );
    }
    const result = run(process.execPath, helperArguments, {
      cwd: canonicalQuarantine,
      env: { GROK_PLUGIN_TEST_CHILD_HOOK_BYPASS: "1" },
      encoding: "utf8",
      shell: false,
      maxBuffer: 8 * 1024
    });
    if (result?.status === 42 || result?.status === 43) {
      const mismatch = new Error("The cleanup candidate identity changed before removal.");
      mismatch.code = "E_TEST_TEMP_IDENTITY_CHANGED";
      throw mismatch;
    }
    if (result?.status !== 0 || result?.error || result?.signal) {
      throw new Error("The verified cleanup candidate could not be removed.");
    }
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
        }
      }
    }
    if (!restored && fs.existsSync(quarantine)) error.quarantinePath = quarantine;
    throw error;
  }
}

function treeSize(root, budget) {
  let total = 0;
  let truncated = false;
  const visit = (target) => {
    if (budget.remaining <= 0) {
      truncated = true;
      return;
    }
    budget.remaining -= 1;
    const stat = fs.lstatSync(target);
    total += stat.size;
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    for (const entry of fs.readdirSync(target)) {
      if (budget.remaining <= 0) {
        truncated = true;
        break;
      }
      visit(path.join(target, entry));
    }
  };
  try {
    visit(root);
    return { bytes: truncated ? null : total, truncated };
  } catch {
    return { bytes: null, truncated: true };
  }
}

export function captureOpenPathSnapshot({ run = spawnSync } = {}) {
  if (process.platform === "win32") {
    return { available: false, paths: [], commands: [], reason: "unsupported-platform" };
  }
  const lsof = trustedExecutable(LSOF_CANDIDATES);
  const ps = trustedExecutable(PS_CANDIDATES);
  if (!lsof || !ps) {
    return {
      available: false,
      paths: [],
      commands: [],
      reason: !lsof ? "lsof-unavailable" : "ps-unavailable"
    };
  }
  const lsofResult = run(lsof, ["-w", "-F", "pn"], {
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
    maxBuffer: 128 * 1024 * 1024
  });
  if (lsofResult?.status !== 0 || lsofResult?.error || lsofResult?.signal) {
    return { available: false, paths: [], commands: [], reason: "lsof-failed" };
  }
  const psResult = run(ps, ["-axo", "command="], {
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
    maxBuffer: 128 * 1024 * 1024
  });
  if (psResult?.status !== 0 || psResult?.error || psResult?.signal) {
    return { available: false, paths: [], commands: [], reason: "ps-failed" };
  }
  const paths = [];
  for (const line of String(lsofResult.stdout || "").split(/\r?\n/u)) {
    if (!line.startsWith("n/")) continue;
    const value = line.slice(1).replace(/ \(deleted\)$/u, "");
    if (path.isAbsolute(value)) paths.push(path.resolve(value));
  }
  const commands = String(psResult.stdout || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return { available: true, paths, commands };
}

export function captureRegisteredWorktrees(repoRoot, { run = spawnSync } = {}) {
  let sawExecutable = false;
  for (const binary of GIT_CANDIDATES) {
    try {
      fs.accessSync(binary, fs.constants.X_OK);
      sawExecutable = true;
    } catch {
      continue;
    }
    const result = run(binary, ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...WORKTREE_GIT_ENV },
      shell: false,
      timeout: TEST_TEMP_WORKTREE_SCAN_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024
    });
    if (result?.status !== 0 || result?.error || result?.signal) continue;
    const paths = String(result.stdout || "")
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => path.resolve(line.slice("worktree ".length)));
    return { available: true, paths };
  }
  return {
    available: false,
    paths: [],
    reason: sawExecutable ? "git-worktree-list-failed" : "git-unavailable"
  };
}

function ownerActivity(manifest, tokenForPid = processStartToken) {
  if (!manifest) return { active: false, known: true };
  let current;
  try {
    current = tokenForPid(manifest.pid);
  } catch {
    return { active: false, known: false };
  }
  if (current === manifest.startToken) return { active: true, known: true };
  if (current && !manifest.startToken.startsWith("opaque:")) {
    return { active: false, known: true };
  }
  try {
    process.kill(manifest.pid, 0);
    return { active: false, known: false };
  } catch (error) {
    return error?.code === "ESRCH"
      ? { active: false, known: true }
      : { active: false, known: false };
  }
}

function rootPathAliases(root) {
  const aliases = [root];
  if (root.startsWith(`/private${path.sep}`)) aliases.push(root.slice("/private".length));
  return aliases;
}

function activeReferencesForRoot(root, snapshot) {
  const active = new Set();
  const aliases = rootPathAliases(root);
  for (const openPath of snapshot.paths) {
    for (const alias of aliases) {
      if (!isWithin(alias, openPath)) continue;
      const relative = path.relative(alias, openPath);
      const directChild = relative.split(path.sep)[0];
      if (directChild && directChild !== "..") active.add(path.join(root, directChild));
    }
  }
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const pattern = new RegExp(`${escaped}${path.sep}([A-Za-z0-9._-]+)`, "gu");
    for (const command of snapshot.commands) {
      for (const match of command.matchAll(pattern)) {
        active.add(path.join(root, match[1]));
      }
    }
  }
  return active;
}

function asciiCaseEqual(left, right) {
  return left.length === right.length && left.toLowerCase() === right;
}

function optionalNoFollowStat(target) {
  try {
    return fs.lstatSync(target, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function safeGitMarkerFile(stat, expectedDevice) {
  return Boolean(
    stat
    && stat.dev === expectedDevice
    && stat.isFile()
    && !stat.isSymbolicLink()
    && stat.size >= 0n
    && stat.size <= BigInt(WORKTREE_METADATA_FILE_MAX_BYTES)
  );
}

function safeGitMarkerDirectory(stat, expectedDevice) {
  return Boolean(
    stat
    && stat.dev === expectedDevice
    && stat.isDirectory()
    && !stat.isSymbolicLink()
  );
}

function gitConfigurationReason(gitDirectory, expectedDevice, expectedUid) {
  for (const name of ["config", "config.worktree"]) {
    const target = path.join(gitDirectory, name);
    let file;
    try {
      file = optionalStableFile(target, expectedUid, null);
    } catch {
      return "git-metadata-ambiguous";
    }
    if (!file) continue;
    const stat = optionalNoFollowStat(target);
    if (!safeGitMarkerFile(stat, expectedDevice)) {
      return "git-metadata-ambiguous";
    }
    const semantics = gitConfigSemantics(file.contents);
    if (!semantics.safe) return "git-metadata-ambiguous";
    if (semantics.worktrees.length > 0) return "external-worktree-link";
  }
  return null;
}

function linkedWorktreeMetadataReason(
  gitDirectory,
  expectedDevice,
  expectedUid
) {
  try {
    const before = fs.lstatSync(gitDirectory, { bigint: true });
    if (!safeGitMarkerDirectory(before, expectedDevice)) {
      return "git-metadata-ambiguous";
    }
    const configReason = gitConfigurationReason(
      gitDirectory,
      expectedDevice,
      expectedUid
    );
    if (configReason) return configReason;
    for (const control of ["commondir", "gitdir"]) {
      const stat = optionalNoFollowStat(path.join(gitDirectory, control));
      if (!stat) continue;
      return safeGitMarkerFile(stat, expectedDevice)
        ? "external-worktree-link"
        : "git-metadata-ambiguous";
    }
    const modules = optionalNoFollowStat(path.join(gitDirectory, "modules"));
    if (modules) return "git-metadata-ambiguous";
    const linkedWorktrees = optionalNoFollowStat(path.join(gitDirectory, "worktrees"));
    if (linkedWorktrees) {
      return safeGitMarkerDirectory(linkedWorktrees, expectedDevice)
        ? "git-worktree-metadata"
        : "git-metadata-ambiguous";
    }
    const after = fs.lstatSync(gitDirectory, { bigint: true });
    return sameBigintIdentity(bigintIdentity(before), bigintIdentity(after))
      ? null
      : "git-metadata-ambiguous";
  } catch {
    return "git-metadata-ambiguous";
  }
}

function gitCommonDirectoryShapeReason(commonDirectory, expectedDevice) {
  try {
    const head = optionalNoFollowStat(path.join(commonDirectory, "HEAD"));
    const config = optionalNoFollowStat(path.join(commonDirectory, "config"));
    const objects = optionalNoFollowStat(path.join(commonDirectory, "objects"));
    const refs = optionalNoFollowStat(path.join(commonDirectory, "refs"));
    const reftable = optionalNoFollowStat(path.join(commonDirectory, "reftable"));
    if (
      safeGitMarkerFile(head, expectedDevice)
      && safeGitMarkerFile(config, expectedDevice)
      && safeGitMarkerDirectory(objects, expectedDevice)
      && (
        safeGitMarkerDirectory(refs, expectedDevice)
        || safeGitMarkerDirectory(reftable, expectedDevice)
      )
    ) {
      return "git-worktree-metadata";
    }
    return null;
  } catch {
    return "git-metadata-ambiguous";
  }
}

function worktreeRegistrationDirectoryReason(
  worktreesDirectory,
  expectedDevice,
  expectedUid
) {
  let names;
  let worktreesBefore;
  try {
    worktreesBefore = fs.lstatSync(worktreesDirectory, { bigint: true });
    if (!safeGitMarkerDirectory(worktreesBefore, expectedDevice)) {
      return "git-metadata-ambiguous";
    }
    names = boundedDirectoryNames(
      worktreesDirectory,
      WORKTREE_REGISTRATION_MAX_ENTRIES
    );
  } catch {
    return "git-metadata-ambiguous";
  }
  for (const name of names) {
    const registration = path.join(worktreesDirectory, name);
    let registrationStat;
    let registrationAfter;
    let gitdir;
    let commondir;
    try {
      registrationStat = fs.lstatSync(registration, { bigint: true });
      if (!safeGitMarkerDirectory(registrationStat, expectedDevice)) continue;
      gitdir = optionalNoFollowStat(path.join(registration, "gitdir"));
      commondir = optionalNoFollowStat(path.join(registration, "commondir"));
      registrationAfter = fs.lstatSync(registration, { bigint: true });
    } catch {
      return "git-metadata-ambiguous";
    }
    if (
      !sameBigintIdentity(
        bigintIdentity(registrationStat),
        bigintIdentity(registrationAfter)
      )
    ) {
      return "git-metadata-ambiguous";
    }
    if (!gitdir && !commondir) continue;
    const configReason = gitConfigurationReason(
      registration,
      expectedDevice,
      expectedUid
    );
    if (configReason) return configReason;
    if (
      safeGitMarkerFile(gitdir, expectedDevice)
      && safeGitMarkerFile(commondir, expectedDevice)
    ) {
      return "git-worktree-metadata";
    }
    return "git-metadata-ambiguous";
  }
  try {
    const worktreesAfter = fs.lstatSync(worktreesDirectory, { bigint: true });
    if (
      !sameBigintIdentity(
        bigintIdentity(worktreesBefore),
        bigintIdentity(worktreesAfter)
      )
    ) {
      return "git-metadata-ambiguous";
    }
  } catch {
    return "git-metadata-ambiguous";
  }
  return null;
}

function nestedWorktreesMetadataReason(
  worktreesDirectory,
  worktreesStat,
  expectedDevice,
  expectedUid
) {
  if (!safeGitMarkerDirectory(worktreesStat, expectedDevice)) {
    return "git-metadata-ambiguous";
  }
  const commonReason = gitCommonDirectoryShapeReason(
    path.dirname(worktreesDirectory),
    expectedDevice
  );
  if (commonReason) return commonReason;
  return worktreeRegistrationDirectoryReason(
    worktreesDirectory,
    expectedDevice,
    expectedUid
  );
}

function descendantGitMetadataReason(candidate, expectedUid) {
  let rootStat;
  try {
    rootStat = fs.lstatSync(candidate, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return "git-metadata-ambiguous";
    }
  } catch (error) {
    return error?.code === "ENOENT" ? null : "git-metadata-ambiguous";
  }
  const expectedDevice = rootStat.dev;
  const stack = [candidate];
  let remaining = WORKTREE_DESCENDANT_GIT_SCAN_MAX_ENTRIES;
  while (stack.length > 0) {
    const current = stack.pop();
    let directory;
    let directoryBefore;
    const commonShapeEntries = new Map();
    try {
      directoryBefore = fs.lstatSync(current, { bigint: true });
      if (
        !safeGitMarkerDirectory(directoryBefore, expectedDevice)
      ) {
        return directoryBefore.dev === expectedDevice
          ? "git-metadata-ambiguous"
          : "cross-device-descendant";
      }
      directory = fs.opendirSync(current);
      while (true) {
        const entry = directory.readSync();
        if (!entry) break;
        if (remaining <= 0) return "git-metadata-scan-truncated";
        remaining -= 1;
        const entryPath = path.join(current, entry.name);
        let stat;
        try {
          stat = fs.lstatSync(entryPath, { bigint: true });
        } catch {
          return "git-metadata-ambiguous";
        }
        if (stat.dev !== expectedDevice) return "cross-device-descendant";
        const foldedName = entry.name.toLowerCase();
        if (["head", "config", "objects", "refs", "reftable"].includes(foldedName)) {
          if (commonShapeEntries.has(foldedName)) {
            return "git-metadata-ambiguous";
          }
          commonShapeEntries.set(foldedName, stat);
        }
        if (asciiCaseEqual(entry.name, ".git")) {
          if (stat.isFile() || stat.isSymbolicLink()) {
            return "external-worktree-link";
          }
          if (!stat.isDirectory()) return "git-metadata-ambiguous";
          const reason = linkedWorktreeMetadataReason(
            entryPath,
            expectedDevice,
            expectedUid
          );
          if (reason) return reason;
          continue;
        }
        if (asciiCaseEqual(entry.name, "worktrees")) {
          const reason = nestedWorktreesMetadataReason(
            entryPath,
            stat,
            expectedDevice,
            expectedUid
          );
          if (reason) return reason;
        }
        if (stat.isDirectory() && !stat.isSymbolicLink()) stack.push(entryPath);
      }
      if (
        safeGitMarkerFile(commonShapeEntries.get("head"), expectedDevice)
        && safeGitMarkerFile(commonShapeEntries.get("config"), expectedDevice)
        && safeGitMarkerDirectory(commonShapeEntries.get("objects"), expectedDevice)
        && (
          safeGitMarkerDirectory(commonShapeEntries.get("refs"), expectedDevice)
          || safeGitMarkerDirectory(commonShapeEntries.get("reftable"), expectedDevice)
        )
      ) {
        const reason = gitConfigurationReason(
          current,
          expectedDevice,
          expectedUid
        );
        if (reason) return reason;
      }
    } catch {
      return "git-metadata-ambiguous";
    } finally {
      try {
        directory?.closeSync();
      } catch {
        return "git-metadata-ambiguous";
      }
    }
    try {
      const directoryAfter = fs.lstatSync(current, { bigint: true });
      if (
        !sameBigintIdentity(
          bigintIdentity(directoryBefore),
          bigintIdentity(directoryAfter)
        )
      ) {
        return "git-metadata-ambiguous";
      }
    } catch {
      return "git-metadata-ambiguous";
    }
  }
  return null;
}

function registeredWorktreeReason(candidate, snapshot) {
  if (!snapshot.available) return "worktree-visibility-unavailable";
  if (snapshot.paths.some((worktree) => (
    isWithin(candidate, worktree)
    || isWithin(worktree, candidate)
  ))) {
    return "registered-worktree";
  }
  return null;
}

function worktreeReason(candidate, snapshot, expectedUid) {
  const registrationReason = registeredWorktreeReason(candidate, snapshot);
  if (registrationReason) return registrationReason;
  const gitDirectory = path.join(candidate, ".git");
  try {
    const gitMarker = fs.lstatSync(gitDirectory, { bigint: true });
    if (gitMarker.isFile() || gitMarker.isSymbolicLink()) return "external-worktree-link";
    if (!gitMarker.isDirectory()) return "git-metadata-ambiguous";
    const gitDirectoryStat = fs.lstatSync(gitDirectory, { bigint: true });
    const reason = linkedWorktreeMetadataReason(
      gitDirectory,
      gitDirectoryStat.dev,
      expectedUid
    );
    if (reason) return reason;
  } catch (error) {
    if (error?.code !== "ENOENT") return "git-metadata-ambiguous";
  }
  return descendantGitMetadataReason(candidate, expectedUid);
}

function managedWorktreeInspection(
  candidate,
  snapshot,
  { expectedUid, originalRoot = candidate } = {}
) {
  const registrationReason = registeredWorktreeReason(candidate, snapshot);
  if (registrationReason) {
    return { reason: registrationReason, containment: null };
  }
  const containment = inspectContainedGitMetadata({
    root: candidate,
    originalRoot,
    expectedUid
  });
  return containment.available
    ? { reason: null, containment }
    : {
        reason: containment.reason || "git-metadata-ambiguous",
        containment: null
      };
}

function candidateRecord({
  root,
  rootDevice,
  entry,
  family,
  expectedUid,
  olderThanMs,
  nowMs,
  activeReferences,
  worktrees,
  tokenForPid,
  sizeBudget
}) {
  const candidate = path.join(root, entry.name);
  const reasons = [];
  let stat;
  try {
    stat = fs.lstatSync(candidate, { bigint: true });
  } catch {
    return null;
  }
  const mtimeMs = Number(stat.mtimeNs / 1_000_000n);
  if (!Number.isSafeInteger(mtimeMs)) {
    throw new Error("Cleanup candidate modification time is not representable.");
  }
  const exactExpectedUid = BigInt(expectedUid);
  const identity = stableIdentity(stat);
  if (!stat.isDirectory() || stat.isSymbolicLink()) reasons.push("not-real-directory");
  if (stat.dev !== rootDevice) reasons.push("cross-device-candidate");
  if (stat.uid !== exactExpectedUid) reasons.push("owner-mismatch");
  if (nowMs - mtimeMs < olderThanMs) reasons.push("too-recent");

  const inspectable = stat.isDirectory()
    && !stat.isSymbolicLink()
    && stat.dev === rootDevice
    && stat.uid === exactExpectedUid;
  const manifestSnapshot = family.kind === "managed" && inspectable
    ? readStableOwnerManifest(candidate, expectedUid)
    : null;
  const manifest = manifestSnapshot?.value ?? null;
  if (family.kind === "managed" && !manifest) reasons.push("invalid-owner-manifest");
  if (manifest && manifest.kind !== family.manifestKind) reasons.push("manifest-kind-mismatch");
  const owner = ownerActivity(manifest, tokenForPid);
  if (!owner.known) reasons.push("owner-identity-unavailable");
  if (owner.active) reasons.push("active-owner");
  if (activeReferences.has(candidate)) reasons.push("active-process-reference");
  const gitInspection = family.kind === "managed" && inspectable
    ? managedWorktreeInspection(candidate, worktrees, { expectedUid })
    : null;
  const gitReason = inspectable
    ? (
        family.kind === "managed"
          ? gitInspection.reason
          : worktreeReason(candidate, worktrees, expectedUid)
      )
    : null;
  if (gitReason) reasons.push(gitReason);

  const size = inspectable && gitReason !== "cross-device-descendant"
    ? treeSize(candidate, sizeBudget)
    : { bytes: null, truncated: true };
  return {
    path: candidate,
    name: entry.name,
    prefix: family.prefix,
    family: family.kind,
    uid: Number(stat.uid),
    dev: String(stat.dev),
    ino: String(stat.ino),
    mtimeMs,
    ageMs: Math.max(0, nowMs - mtimeMs),
    sizeBytes: size.bytes,
    sizeTruncated: size.truncated,
    active: owner.active || activeReferences.has(candidate),
    registeredWorktree: gitReason === "registered-worktree",
    identity,
    manifest,
    manifestSnapshot,
    gitContainmentDigest: gitInspection?.containment?.digest ?? null,
    eligible: reasons.length === 0,
    reasons
  };
}

export function cleanupTestTemp({
  tempRoot = canonicalSystemTempRoot(),
  repoRoot = process.cwd(),
  apply = false,
  legacy = false,
  olderThanMs = DEFAULT_TEST_TEMP_MAX_AGE_MS,
  nowMs = Date.now(),
  expectedUid = typeof process.getuid === "function" ? process.getuid() : null,
  openPathsProvider = captureOpenPathSnapshot,
  worktreeProvider = null,
  tokenForPid = processStartToken,
  beforeDelete = null,
  removeRoot = removeInventoriedTestTempRoot,
  sizeScanEntryBudget = TEST_TEMP_SIZE_SCAN_ENTRY_BUDGET,
  snapshotRefreshMs = TEST_TEMP_SNAPSHOT_REFRESH_MS,
  clock = Date.now
} = {}) {
  const root = canonicalRoot(tempRoot);
  const rootDevice = fs.lstatSync(root, { bigint: true }).dev;
  if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0) {
    throw new Error("Cleanup age must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error("Cleanup time is invalid.");
  if (!Number.isSafeInteger(sizeScanEntryBudget) || sizeScanEntryBudget < 0) {
    throw new Error("Cleanup size-scan budget must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(snapshotRefreshMs) || snapshotRefreshMs < 0) {
    throw new Error("Cleanup snapshot refresh must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(expectedUid) || expectedUid < 0) {
    return {
      root,
      mode: apply ? "apply" : "dry-run",
      aborted: true,
      reason: "owner-visibility-unavailable",
      candidates: [],
      removed: 0,
      reclaimedBytes: 0
    };
  }
  const registeredWorktrees = worktreeProvider
    ?? createRegisteredWorktreeProvider(repoRoot, { expectedUid });

  const openSnapshot = openPathsProvider();
  if (
    !openSnapshot?.available
    || !Array.isArray(openSnapshot.paths)
    || !Array.isArray(openSnapshot.commands)
  ) {
    return {
      root,
      mode: apply ? "apply" : "dry-run",
      aborted: true,
      reason: "active-process-visibility-unavailable",
      candidates: [],
      removed: 0,
      reclaimedBytes: 0
    };
  }
  const worktrees = registeredWorktrees();
  if (!worktrees?.available || !Array.isArray(worktrees.paths)) {
    return {
      root,
      mode: apply ? "apply" : "dry-run",
      aborted: true,
      reason: "worktree-visibility-unavailable",
      candidates: [],
      removed: 0,
      reclaimedBytes: 0
    };
  }
  const candidates = [];
  const sizeBudget = { remaining: sizeScanEntryBudget };
  const activeReferences = activeReferencesForRoot(root, openSnapshot);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const family = classifyName(entry.name, legacy);
    if (!family) continue;
    const record = candidateRecord({
      root,
      rootDevice,
      entry,
      family,
      expectedUid,
      olderThanMs,
      nowMs,
      activeReferences,
      worktrees,
      tokenForPid,
      sizeBudget
    });
    if (record) candidates.push(record);
  }
  candidates.sort((left, right) => left.path.localeCompare(right.path));

  let removed = 0;
  let reclaimedBytes = 0;
  let abortReason = null;
  if (apply) {
    let finalOpenSnapshot = openPathsProvider();
    if (
      !finalOpenSnapshot?.available
      || !Array.isArray(finalOpenSnapshot.paths)
      || !Array.isArray(finalOpenSnapshot.commands)
    ) {
      return {
        root,
        mode: "apply",
        aborted: true,
        reason: "active-process-visibility-unavailable",
        candidates,
        removed,
        reclaimedBytes
      };
    }
    let finalActiveReferences = activeReferencesForRoot(root, finalOpenSnapshot);
    let finalWorktrees = registeredWorktrees();
    if (!finalWorktrees?.available || !Array.isArray(finalWorktrees.paths)) {
      return {
        root,
        mode: "apply",
        aborted: true,
        reason: "worktree-visibility-unavailable",
        candidates,
        removed,
        reclaimedBytes
      };
    }
    let snapshotAt = clock();
    for (const record of candidates) {
      if (!record.eligible) continue;
      if (clock() - snapshotAt >= snapshotRefreshMs) {
        finalOpenSnapshot = openPathsProvider();
        if (
          !finalOpenSnapshot?.available
          || !Array.isArray(finalOpenSnapshot.paths)
          || !Array.isArray(finalOpenSnapshot.commands)
        ) {
          return {
            root,
            mode: "apply",
            aborted: true,
            reason: "active-process-visibility-unavailable",
            candidates,
            removed,
            reclaimedBytes
          };
        }
        finalWorktrees = registeredWorktrees();
        if (!finalWorktrees?.available || !Array.isArray(finalWorktrees.paths)) {
          return {
            root,
            mode: "apply",
            aborted: true,
            reason: "worktree-visibility-unavailable",
            candidates,
            removed,
            reclaimedBytes
          };
        }
        finalActiveReferences = activeReferencesForRoot(root, finalOpenSnapshot);
        snapshotAt = clock();
      }
      if (beforeDelete) beforeDelete(record);
      let current;
      try {
        current = fs.lstatSync(record.path, { bigint: true });
      } catch {
        record.eligible = false;
        record.reasons.push("candidate-disappeared");
        continue;
      }
      if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(record.identity, stableIdentity(current))) {
        record.eligible = false;
        record.reasons.push("identity-changed");
        continue;
      }
      if (finalActiveReferences.has(record.path)) {
        record.eligible = false;
        record.reasons.push("active-process-reference");
        continue;
      }
      const finalGitInspection = record.family === "managed"
        ? managedWorktreeInspection(record.path, finalWorktrees, { expectedUid })
        : null;
      const finalGitReason = record.family === "managed"
        ? finalGitInspection.reason
        : worktreeReason(record.path, finalWorktrees, expectedUid);
      if (finalGitReason) {
        record.eligible = false;
        record.reasons.push(finalGitReason);
        continue;
      }
      if (
        record.family === "managed"
        && finalGitInspection.containment.digest !== record.gitContainmentDigest
      ) {
        record.eligible = false;
        record.reasons.push("git-metadata-ambiguous");
        continue;
      }
      const owner = ownerActivity(record.manifest, tokenForPid);
      if (!owner.known || owner.active) {
        record.eligible = false;
        record.reasons.push(owner.active ? "active-owner" : "owner-identity-unavailable");
        continue;
      }
      try {
        if (!removeRoot(record.path, record.identity, {
          gitContainment: record.family === "managed"
            ? {
                digest: record.gitContainmentDigest,
                expectedUid,
                originalRoot: record.path
              }
            : null,
          afterQuarantine(quarantine, canonicalRoots = null) {
            const canonicalQuarantine = canonicalRoots?.canonicalQuarantine
              ?? canonicalContainedPath(quarantine);
            const canonicalOriginalRoot = canonicalRoots?.canonicalOriginalRoot
              ?? normalizeDarwinSystemPath(record.path);
            let quarantinedRoot;
            try {
              quarantinedRoot = fs.lstatSync(quarantine, { bigint: true });
            } catch {
              const error = new Error(
                "The quarantined cleanup candidate identity is unavailable."
              );
              error.code = "E_TEST_TEMP_IDENTITY_CHANGED";
              throw error;
            }
            if (
              !quarantinedRoot.isDirectory()
              || quarantinedRoot.isSymbolicLink()
              || !sameRelocatedIdentity(
                record.identity,
                stableIdentity(quarantinedRoot)
              )
            ) {
              const error = new Error(
                "The quarantined cleanup candidate identity changed."
              );
              error.code = "E_TEST_TEMP_IDENTITY_CHANGED";
              throw error;
            }
            const postRenameOpenSnapshot = openPathsProvider();
            if (
              !postRenameOpenSnapshot?.available
              || !Array.isArray(postRenameOpenSnapshot.paths)
              || !Array.isArray(postRenameOpenSnapshot.commands)
            ) {
              const error = new Error(
                "Active-process visibility was lost after quarantine."
              );
              error.code = "E_TEST_TEMP_VISIBILITY_AFTER_QUARANTINE";
              throw error;
            }
            const activeAfterRename = activeReferencesForRoot(
              root,
              postRenameOpenSnapshot
            );
            if (
              activeAfterRename.has(record.path)
              || activeAfterRename.has(quarantine)
            ) {
              const error = new Error(
                "The cleanup candidate became active after quarantine."
              );
              error.code = "E_TEST_TEMP_ACTIVE_AFTER_QUARANTINE";
              throw error;
            }
            const postRenameWorktrees = registeredWorktrees();
            if (
              !postRenameWorktrees?.available
              || !Array.isArray(postRenameWorktrees.paths)
            ) {
              const error = new Error(
                "Worktree visibility was lost after quarantine."
              );
              error.code = "E_TEST_TEMP_WORKTREE_VISIBILITY_AFTER_QUARANTINE";
              throw error;
            }
            const originalRegistrationReason = registeredWorktreeReason(
              record.path,
              postRenameWorktrees
            );
            const quarantineRegistrationReason = registeredWorktreeReason(
              quarantine,
              postRenameWorktrees
            );
            const quarantinedGitInspection = record.family === "managed"
              ? managedWorktreeInspection(canonicalQuarantine, postRenameWorktrees, {
                  expectedUid,
                  originalRoot: canonicalOriginalRoot
                })
              : null;
            const postRenameGitReason = record.family === "managed"
              ? (
                  originalRegistrationReason
                  || quarantineRegistrationReason
                  || quarantinedGitInspection.reason
                )
              : (
                  worktreeReason(
                    record.path,
                    postRenameWorktrees,
                    expectedUid
                  )
                  || worktreeReason(
                    quarantine,
                    postRenameWorktrees,
                    expectedUid
                  )
                );
            if (postRenameGitReason) {
              const error = new Error(
                "The cleanup candidate became a registered worktree after quarantine."
              );
              error.code = "E_TEST_TEMP_WORKTREE_AFTER_QUARANTINE";
              throw error;
            }
            if (
              record.family === "managed"
              && (
                !quarantinedGitInspection.containment
                || quarantinedGitInspection.containment.digest
                  !== record.gitContainmentDigest
              )
            ) {
              const error = new Error(
                "The cleanup candidate Git-containment proof changed."
              );
              error.code = "E_TEST_TEMP_GIT_CONTAINMENT_AFTER_QUARANTINE";
              throw error;
            }
            if (record.family === "managed") {
              const freshManifest = readStableOwnerManifest(
                quarantine,
                expectedUid
              );
              if (!freshManifest) {
                const error = new Error(
                  "The cleanup candidate owner manifest became invalid."
                );
                error.code = "E_TEST_TEMP_MANIFEST_INVALID_AFTER_QUARANTINE";
                throw error;
              }
              const freshOwner = ownerActivity(
                freshManifest.value,
                tokenForPid
              );
              if (!sameOwnerManifestSnapshot(
                record.manifestSnapshot,
                freshManifest
              )) {
                const error = new Error(
                  "The cleanup candidate owner manifest changed."
                );
                error.code = "E_TEST_TEMP_MANIFEST_CHANGED";
                throw error;
              }
              if (!freshOwner.known || freshOwner.active) {
                const error = new Error(
                  "The cleanup candidate owner identity is not stale."
                );
                error.code = freshOwner.active
                  ? "E_TEST_TEMP_OWNER_ACTIVE_AFTER_QUARANTINE"
                  : "E_TEST_TEMP_OWNER_UNKNOWN_AFTER_QUARANTINE";
                throw error;
              }
            }
          }
        })) {
          record.eligible = false;
          record.reasons.push("candidate-disappeared");
          continue;
        }
        record.removed = true;
        removed += 1;
        if (Number.isSafeInteger(record.sizeBytes)) reclaimedBytes += record.sizeBytes;
      } catch (error) {
        record.eligible = false;
        if (error?.code === "E_TEST_TEMP_IDENTITY_CHANGED") {
          record.reasons.push("identity-changed");
        } else if (
          error?.code === "E_TEST_TEMP_MANIFEST_CHANGED"
          || error?.code === "E_TEST_TEMP_MANIFEST_INVALID_AFTER_QUARANTINE"
        ) {
          record.reasons.push("owner-manifest-changed");
        } else if (error?.code === "E_TEST_TEMP_OWNER_ACTIVE_AFTER_QUARANTINE") {
          record.reasons.push("active-owner");
        } else if (error?.code === "E_TEST_TEMP_OWNER_UNKNOWN_AFTER_QUARANTINE") {
          record.reasons.push("owner-identity-unavailable");
        } else if (error?.code === "E_TEST_TEMP_ACTIVE_AFTER_QUARANTINE") {
          record.reasons.push("active-process-reference");
        } else if (error?.code === "E_TEST_TEMP_WORKTREE_AFTER_QUARANTINE") {
          record.reasons.push("registered-worktree");
        } else if (
          error?.code === "E_TEST_TEMP_GIT_CONTAINMENT_AFTER_QUARANTINE"
        ) {
          record.reasons.push("git-metadata-ambiguous");
        } else {
          record.reasons.push("remove-failed");
        }
        if (typeof error?.quarantinePath === "string") {
          record.quarantinePath = error.quarantinePath;
        }
        if (error?.code === "E_TEST_TEMP_VISIBILITY_AFTER_QUARANTINE") {
          abortReason = "active-process-visibility-unavailable";
          break;
        }
        if (error?.code === "E_TEST_TEMP_WORKTREE_VISIBILITY_AFTER_QUARANTINE") {
          abortReason = "worktree-visibility-unavailable";
          break;
        }
      }
    }
  }

  return {
    root,
    mode: apply ? "apply" : "dry-run",
    aborted: abortReason !== null,
    reason: abortReason,
    olderThanMs,
    legacy,
    sizeScanTruncated: candidates.some((candidate) => candidate.sizeTruncated),
    candidates,
    removed,
    reclaimedBytes
  };
}
