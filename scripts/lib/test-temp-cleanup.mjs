import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  TEST_TEMP_PROCESS_PREFIX,
  TEST_TEMP_RUN_PREFIX,
  canonicalSystemTempRoot,
  processStartToken,
  readTestTempManifest
} from "./test-temp.mjs";

export const DEFAULT_TEST_TEMP_MAX_AGE_MS = 60 * 60_000;
export const TEST_TEMP_SIZE_SCAN_ENTRY_BUDGET = 10_000;
export const TEST_TEMP_SNAPSHOT_REFRESH_MS = 10_000;
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
  "fake-ps-path-",
  "gated-cleanup-",
  "grok-artifact-readonly-",
  "grok-bad-git-",
  "grok-ci-auth-installer-",
  "grok-ci-auth-test-",
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
  "grok-collector-parent-",
  "grok-collector-src-",
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
  "grok-hostile-home-",
  "grok-http-backend-",
  "grok-http-fetch-",
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
  "grok-proxy-env-",
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
  "grok-runner-credential-test-",
  "grok-runtime-data-",
  "grok-safety-data-",
  "grok-service-data-",
  "grok-source-pty-data-",
  "grok-source-pty-fake-",
  "grok-source-pty-no-ready-data-",
  "grok-source-pty-no-ready-fake-",
  "grok-source-stdin-negative-data-",
  "grok-source-stdin-negative-fake-",
  "grok-state-alias-",
  "grok-state-barrier-",
  "grok-state-data-",
  "grok-state-outside-",
  "grok-state-owner-publish-race-",
  "grok-state-release-race-",
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
  "deep-research-fake-",
  "deep-research-home-",
  "deep-research-nocmd-",
  "deep-research-plugin-",
  "deep-research-plugin-cancel-",
  "deep-research-plugin-data-",
  "deep-research-plugin-nocmd-",
  "deep-research-query-",
  "deep-research-runtime-state-",
  "deep-research-state-",
  "deep-research-state-nocmd-",
  "grok-issue34-real-vertical-",
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
  "runner-failures-",
  // Finite template-literal expansions whose labels are checked in beside the
  // allocating helper calls.
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
const GIT_CANDIDATES = Object.freeze(["/usr/bin/git", "/opt/homebrew/bin/git"]);
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
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    uid: stat.uid,
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

const REMOVE_INVENTORIED_ROOT_HELPER = fileURLToPath(
  new URL("./test-temp-remove-helper.cjs", import.meta.url)
);

export function removeInventoriedTestTempRoot(
  root,
  expectedIdentity,
  { run = spawnSync } = {}
) {
  if (!root || !path.isAbsolute(root) || !expectedIdentity) return false;
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
    const result = run(process.execPath, [
      REMOVE_INVENTORIED_ROOT_HELPER,
      String(expectedIdentity.dev),
      String(expectedIdentity.ino)
    ], {
      cwd: quarantine,
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
          // The quarantined tree is preserved and reported below.
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
      shell: false,
      timeout: 10_000,
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

function worktreeReason(candidate, snapshot) {
  if (!snapshot.available) return "worktree-visibility-unavailable";
  if (snapshot.paths.some((worktree) => isWithin(candidate, worktree))) {
    return "registered-worktree";
  }
  const gitDirectory = path.join(candidate, ".git");
  try {
    const gitMarker = fs.lstatSync(gitDirectory);
    if (gitMarker.isFile() || gitMarker.isSymbolicLink()) return "external-worktree-link";
    if (!gitMarker.isDirectory()) return "git-metadata-ambiguous";
  } catch (error) {
    if (error?.code !== "ENOENT") return "git-metadata-ambiguous";
    return null;
  }
  try {
    const linkedWorktrees = fs.lstatSync(path.join(gitDirectory, "worktrees"));
    if (linkedWorktrees.isDirectory() && !linkedWorktrees.isSymbolicLink()) {
      return "git-worktree-metadata";
    }
    return "git-metadata-ambiguous";
  } catch (error) {
    if (error?.code !== "ENOENT") return "git-metadata-ambiguous";
  }
  return null;
}

function candidateRecord({
  root,
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
    stat = fs.lstatSync(candidate);
  } catch {
    return null;
  }
  const identity = stableIdentity(stat);
  if (!stat.isDirectory() || stat.isSymbolicLink()) reasons.push("not-real-directory");
  if (stat.uid !== expectedUid) reasons.push("owner-mismatch");
  if (nowMs - stat.mtimeMs < olderThanMs) reasons.push("too-recent");

  const manifest = family.kind === "managed" ? readTestTempManifest(candidate) : null;
  if (family.kind === "managed" && !manifest) reasons.push("invalid-owner-manifest");
  if (manifest && manifest.kind !== family.manifestKind) reasons.push("manifest-kind-mismatch");
  const owner = ownerActivity(manifest, tokenForPid);
  if (!owner.known) reasons.push("owner-identity-unavailable");
  if (owner.active) reasons.push("active-owner");
  if (activeReferences.has(candidate)) reasons.push("active-process-reference");
  const gitReason = worktreeReason(candidate, worktrees);
  if (gitReason) reasons.push(gitReason);

  const size = treeSize(candidate, sizeBudget);
  return {
    path: candidate,
    name: entry.name,
    prefix: family.prefix,
    family: family.kind,
    uid: stat.uid,
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    ageMs: Math.max(0, nowMs - stat.mtimeMs),
    sizeBytes: size.bytes,
    sizeTruncated: size.truncated,
    active: owner.active || activeReferences.has(candidate),
    registeredWorktree: gitReason === "registered-worktree",
    identity,
    manifest,
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
  worktreeProvider = () => captureRegisteredWorktrees(repoRoot),
  tokenForPid = processStartToken,
  beforeDelete = null,
  removeRoot = removeInventoriedTestTempRoot,
  sizeScanEntryBudget = TEST_TEMP_SIZE_SCAN_ENTRY_BUDGET,
  snapshotRefreshMs = TEST_TEMP_SNAPSHOT_REFRESH_MS,
  clock = Date.now
} = {}) {
  const root = canonicalRoot(tempRoot);
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
  const worktrees = worktreeProvider();
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
    let finalWorktrees = worktreeProvider();
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
        finalWorktrees = worktreeProvider();
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
        current = fs.lstatSync(record.path);
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
      const finalGitReason = worktreeReason(record.path, finalWorktrees);
      if (finalGitReason) {
        record.eligible = false;
        record.reasons.push(finalGitReason);
        continue;
      }
      const owner = ownerActivity(record.manifest, tokenForPid);
      if (!owner.known || owner.active) {
        record.eligible = false;
        record.reasons.push(owner.active ? "active-owner" : "owner-identity-unavailable");
        continue;
      }
      try {
        if (!removeRoot(record.path, record.identity)) {
          record.eligible = false;
          record.reasons.push("candidate-disappeared");
          continue;
        }
        record.removed = true;
        removed += 1;
        if (Number.isSafeInteger(record.sizeBytes)) reclaimedBytes += record.sizeBytes;
      } catch (error) {
        record.eligible = false;
        record.reasons.push(
          error?.code === "E_TEST_TEMP_IDENTITY_CHANGED"
            ? "identity-changed"
            : "remove-failed"
        );
        if (typeof error?.quarantinePath === "string") {
          record.quarantinePath = error.quarantinePath;
        }
      }
    }
  }

  return {
    root,
    mode: apply ? "apply" : "dry-run",
    aborted: false,
    reason: null,
    olderThanMs,
    legacy,
    sizeScanTruncated: candidates.some((candidate) => candidate.sizeTruncated),
    candidates,
    removed,
    reclaimedBytes
  };
}
