/**
 * Worker Broker evidence inventory, capture helpers, and strict validation.
 * Pure domain functions — CLI entrypoint is scripts/worker-broker-evidence.mjs.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const EVIDENCE_SCHEMA_VERSION = 1;
export const ROADMAP_VERSION = "1.0";
export const ISSUE_URL = "https://github.com/xliberty2008x/grok-plugin/issues/25";
export const EVIDENCE_ROOT = "tests/e2e-results/worker-broker";
export const EVIDENCE_ONLY_PREFIXES = Object.freeze([
  `${EVIDENCE_ROOT}/`,
  "tests/e2e-results/macos-",
  "tests/e2e-results/qualification-"
]);

/** Paths that participate in phase-scope digests (source that invalidates proof). */
export const PHASE_SCOPE = Object.freeze({
  "0": [
    "scripts/lib/worker-broker-evidence.mjs",
    "scripts/worker-broker-evidence.mjs",
    "plugins/grok/schemas/worker-broker-evidence.schema.json",
    "tests/worker-broker-evidence.test.mjs",
    "package.json"
  ],
  "1": [
    "plugins/grok/scripts/lib/worker-protocol.mjs",
    "plugins/grok/scripts/lib/worker-service.mjs",
    "plugins/grok/scripts/lib/worker-authority.mjs",
    "plugins/grok/scripts/lib/worker-mutation.mjs",
    "plugins/grok/scripts/lib/worker-reconcile.mjs",
    "plugins/grok/scripts/lib/state.mjs",
    "plugins/grok/scripts/lib/task-contract.mjs",
    "plugins/grok/mcp/broker.mjs",
    "plugins/grok/mcp/server.mjs",
    "plugins/grok/schemas/worker-protocol.schema.json",
    "tests/worker-protocol.test.mjs",
    "tests/worker-service.test.mjs",
    "tests/mcp-worker-broker.test.mjs",
    "tests/worker-mutation.test.mjs"
  ],
  "2": [
    "plugins/grok/scripts/lib/worker-mailbox.mjs",
    "plugins/grok/scripts/lib/worker-roles.mjs",
    "plugins/grok/scripts/lib/worker-context.mjs",
    "tests/worker-mailbox.test.mjs",
    "tests/worker-roles.test.mjs"
  ],
  "3": [
    "plugins/grok/scripts/lib/workspace.mjs",
    "plugins/grok/scripts/lib/worker-worktree.mjs",
    "plugins/grok/scripts/lib/worker-artifacts.mjs",
    "tests/worker-worktree.test.mjs"
  ],
  "4": [
    "plugins/grok/scripts/lib/worker-presentation.mjs",
    "tests/worker-presentation.test.mjs"
  ],
  "5": [
    "tests/worker-safety-proofs.test.mjs",
    "scripts/lib/worker-broker-evidence.mjs"
  ]
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const STATUS_SET = new Set([
  "not_started",
  "implemented_unverified",
  "verified_on_draft",
  "qualified",
  "blocked",
  "deferred",
  "historical"
]);

const OUTCOME_SET = new Set(["pass", "fail", "skip", "not_run"]);

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function sha256File(absolute) {
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    return sha256Text(fs.readlinkSync(absolute));
  }
  return sha256Text(fs.readFileSync(absolute));
}

export function isEvidenceOnlyPath(relative) {
  const normalized = String(relative || "").replace(/\\/g, "/");
  return EVIDENCE_ONLY_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function listSourceInventory(root = REPO_ROOT, { includeEvidence = false } = {}) {
  const output = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024
  });
  return [...new Set(output.toString("utf8").split("\0").filter(Boolean))]
    .filter((relative) => includeEvidence || !isEvidenceOnlyPath(relative))
    .sort();
}

export function computeInventoryDigest(root = REPO_ROOT, { includeEvidence = false, paths = null } = {}) {
  const files = paths
    ? [...paths].sort()
    : listSourceInventory(root, { includeEvidence });
  const inventory = files.map((relative) => {
    const absolute = path.join(root, ...relative.split("/"));
    if (!fs.existsSync(absolute)) {
      return { path: relative, type: "missing", sha256: "0".repeat(64) };
    }
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      return {
        path: relative,
        type: "symlink",
        sha256: sha256Text(fs.readlinkSync(absolute))
      };
    }
    if (stat.isDirectory()) {
      return { path: relative, type: "directory", sha256: sha256Text("dir") };
    }
    return {
      path: relative,
      type: "file",
      sha256: sha256File(absolute),
      size: stat.size
    };
  });
  return sha256Text(JSON.stringify(inventory));
}

export function computePhaseScopeDigest(phase, root = REPO_ROOT) {
  const scope = PHASE_SCOPE[String(phase)] || [];
  const existing = scope.filter((relative) => fs.existsSync(path.join(root, relative)));
  return computeInventoryDigest(root, { paths: existing });
}

export function gitIdentity(root = REPO_ROOT) {
  const headCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const headTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  const cleanTreeAtVerification = status.trim().length === 0;
  return { headCommit, headTree, cleanTreeAtVerification };
}

export function runtimeSnapshot() {
  let git = "unknown";
  try {
    git = execFileSync("git", ["--version"], { encoding: "utf8" }).trim().replace(/^git version\s+/i, "");
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

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function computeRecordDigest(record) {
  return sha256Text(canonicalRecordBody(record));
}

export function attachRecordDigest(record) {
  const next = { ...record };
  delete next.recordDigest;
  next.recordDigest = computeRecordDigest(next);
  return next;
}

/**
 * Lightweight structural validator (no external JSON Schema dependency).
 * Returns { ok, errors[] }.
 */
export function validateEvidenceRecord(record, options = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, errors: ["Record must be a JSON object."] };
  }

  if (record.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${EVIDENCE_SCHEMA_VERSION}.`);
  }
  if (record.roadmapVersion !== ROADMAP_VERSION) {
    fail(`roadmapVersion must be ${ROADMAP_VERSION}.`);
  }
  if (record.issue !== ISSUE_URL) fail("issue URL must match #25.");
  if (!["worker-broker-slice", "worker-broker-aggregate"].includes(record.recordType)) {
    fail("recordType is invalid.");
  }
  if (!["0", "1", "2", "3", "4", "5", "aggregate"].includes(String(record.phase))) {
    fail("phase is invalid.");
  }
  if (typeof record.slice !== "string" || !record.slice) fail("slice is required.");
  if (!STATUS_SET.has(record.status)) fail(`status ${record.status} is invalid.`);
  if (typeof record.recordedAt !== "string" || !record.recordedAt) fail("recordedAt is required.");

  const source = record.source;
  if (!source || typeof source !== "object") {
    fail("source is required.");
  } else {
    for (const field of [
      "pluginVersion",
      "headCommit",
      "headTree",
      "sourceInventoryDigest",
      "phaseScopeDigest",
      "cleanTreeAtVerification"
    ]) {
      if (source[field] === undefined || source[field] === null || source[field] === "") {
        fail(`source.${field} is required.`);
      }
    }
    if (source.headCommit && !/^[0-9a-f]{40}$/.test(source.headCommit)) {
      fail("source.headCommit must be a full 40-char SHA.");
    }
    if (source.headTree && !/^[0-9a-f]{40}$/.test(source.headTree)) {
      fail("source.headTree must be a full 40-char SHA.");
    }
    if (source.sourceInventoryDigest && !/^[0-9a-f]{64}$/.test(source.sourceInventoryDigest)) {
      fail("source.sourceInventoryDigest must be sha256 hex.");
    }
    if (source.phaseScopeDigest && !/^[0-9a-f]{64}$/.test(source.phaseScopeDigest)) {
      fail("source.phaseScopeDigest must be sha256 hex.");
    }
    if (source.cleanTreeAtVerification !== true && source.cleanTreeAtVerification !== false) {
      fail("source.cleanTreeAtVerification must be boolean.");
    }
  }

  if (!record.runtime || typeof record.runtime !== "object") {
    fail("runtime is required.");
  } else {
    for (const field of ["platform", "architecture", "node", "git"]) {
      if (!record.runtime[field]) fail(`runtime.${field} is required.`);
    }
  }

  if (!Array.isArray(record.verification) || record.verification.length < 1) {
    fail("verification must contain at least one command record.");
  } else {
    for (const [index, entry] of record.verification.entries()) {
      if (!entry?.command) fail(`verification[${index}].command is required.`);
      if (!entry?.boundary) fail(`verification[${index}].boundary is required.`);
      if (!OUTCOME_SET.has(entry?.outcome)) fail(`verification[${index}].outcome is invalid.`);
    }
  }

  if (!record.authorities || typeof record.authorities !== "object") {
    fail("authorities is required.");
  } else {
    for (const field of [
      "workerClaims",
      "runtimeObservations",
      "hostVerification",
      "independentValidation"
    ]) {
      if (typeof record.authorities[field] !== "string") {
        fail(`authorities.${field} is required.`);
      }
    }
  }

  if (!record.limits || typeof record.limits !== "object") {
    fail("limits is required.");
  } else {
    for (const field of ["residualRisks", "unsupportedPlatforms", "invalidationTriggers"]) {
      if (!Array.isArray(record.limits[field])) fail(`limits.${field} must be an array.`);
    }
  }

  // Strict mode: bind to current tree when requested.
  if (options.strict && options.root) {
    const identity = gitIdentity(options.root);
    if (source?.cleanTreeAtVerification === true && !identity.cleanTreeAtVerification) {
      fail("Record claims clean tree but working tree is dirty.");
    }
    if (source?.headCommit && source.headCommit !== identity.headCommit) {
      fail(`Record headCommit ${source.headCommit} does not match current HEAD ${identity.headCommit}.`);
    }
    if (source?.headTree && source.headTree !== identity.headTree) {
      fail(`Record headTree ${source.headTree} does not match current tree ${identity.headTree}.`);
    }
    const currentSourceDigest = computeInventoryDigest(options.root, { includeEvidence: false });
    if (source?.sourceInventoryDigest && source.sourceInventoryDigest !== currentSourceDigest) {
      fail("sourceInventoryDigest is stale relative to current non-evidence source inventory.");
    }
    if (source?.phaseScopeDigest && record.phase != null && record.phase !== "aggregate") {
      const currentPhase = computePhaseScopeDigest(record.phase, options.root);
      if (source.phaseScopeDigest !== currentPhase) {
        fail(`phaseScopeDigest for phase ${record.phase} is stale.`);
      }
    }
  }

  if (options.rejectProvisional && record.provisionalSupportingRecord === true) {
    fail("Provisional supporting records cannot satisfy strict qualification.");
  }

  if (options.requireEvidenceSystem && record.evidenceSystemQualification !== true) {
    fail("evidenceSystemQualification must be true for this gate.");
  }

  if (record.recordDigest) {
    const expected = computeRecordDigest(record);
    if (record.recordDigest !== expected) {
      fail("recordDigest does not match canonical body.");
    }
  }

  // Historical promotion guard: qualified status cannot be claimed with dirty/stale flags.
  if (record.status === "qualified") {
    if (source?.cleanTreeAtVerification !== true) {
      fail("qualified records require cleanTreeAtVerification=true.");
    }
    if (record.provisionalSupportingRecord === true) {
      fail("qualified records cannot be provisionalSupportingRecord.");
    }
  }

  // Reject missing phase field already handled; reject empty verification pass-only claims with fail outcomes.
  if (record.status === "verified_on_draft" || record.status === "qualified") {
    const failed = (record.verification || []).filter((entry) => entry.outcome === "fail");
    if (failed.length) {
      fail("verified/qualified records cannot include failed verification commands.");
    }
  }

  return { ok: errors.length === 0, errors };
}

export function buildEvidenceRecord({
  phase,
  slice,
  status = "verified_on_draft",
  root = REPO_ROOT,
  verification = [],
  scenarios = [],
  liveScenarios = [],
  installation = null,
  authorities = null,
  limits = null,
  pullRequest = "https://github.com/xliberty2008x/grok-plugin/pull/26",
  pluginVersion = null,
  evidenceSystemQualification = true,
  provisionalSupportingRecord = false,
  releaseQualification = false,
  runtime = null,
  prerequisites = [],
  ci = null
} = {}) {
  const identity = gitIdentity(root);
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const sourceInventoryDigest = computeInventoryDigest(root, { includeEvidence: false });
  const phaseScopeDigest = computePhaseScopeDigest(phase, root);
  const record = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    roadmapVersion: ROADMAP_VERSION,
    recordType: phase === "aggregate" ? "worker-broker-aggregate" : "worker-broker-slice",
    issue: ISSUE_URL,
    pullRequest,
    phase: String(phase),
    slice,
    status,
    recordedAt: new Date().toISOString(),
    releaseQualification,
    evidenceSystemQualification,
    provisionalSupportingRecord,
    source: {
      pluginVersion: pluginVersion || packageJson.version,
      foundationCommit: null,
      headCommit: identity.headCommit,
      headTree: identity.headTree,
      sourceInventoryDigest,
      phaseScopeDigest,
      cleanTreeAtVerification: identity.cleanTreeAtVerification,
      phaseScopePaths: PHASE_SCOPE[String(phase)] || []
    },
    installation: installation || {
      method: "source-tree",
      sourcePluginInventoryDigest: null,
      installedPluginInventoryDigest: null,
      installedFileCount: null,
      sourceAndInstalledInventoriesEqual: null,
      privateInstallPathRecorded: false
    },
    runtime: runtime || runtimeSnapshot(),
    prerequisites,
    verification,
    scenarios,
    liveScenarios,
    ci,
    authorities: authorities || {
      workerClaims: "none",
      runtimeObservations: "deterministic node:test and inventory digests",
      hostVerification: "not_run",
      independentValidation: "not_run"
    },
    limits: limits || {
      residualRisks: [],
      unsupportedPlatforms: ["windows-provider-execution", "linux-provider-unqualified"],
      invalidationTriggers: [
        "source inventory change outside evidence-only paths",
        "phase-scope path change",
        "dirty tree when cleanTreeAtVerification claimed"
      ],
      supersededBy: null,
      liveQualificationGaps: []
    }
  };
  return attachRecordDigest(record);
}

export function writeEvidenceRecord(record, root = REPO_ROOT) {
  const phase = String(record.phase);
  const dir = path.join(root, EVIDENCE_ROOT, phase === "aggregate" ? "aggregate" : `phase-${phase}`);
  fs.mkdirSync(dir, { recursive: true });
  const digest = record.source?.sourceInventoryDigest || computeRecordDigest(record);
  const file = path.join(dir, `${digest.slice(0, 16)}.json`);
  const body = attachRecordDigest(record);
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return path.relative(root, file);
}

export function loadLedger(root = REPO_ROOT) {
  const file = path.join(root, EVIDENCE_ROOT, "ledger.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        schemaVersion: 1,
        roadmapVersion: ROADMAP_VERSION,
        issue: ISSUE_URL,
        updatedAt: null,
        entries: []
      };
    }
    throw error;
  }
}

export function updateLedger(entry, root = REPO_ROOT) {
  const ledger = loadLedger(root);
  const entries = Array.isArray(ledger.entries) ? [...ledger.entries] : [];
  const phase = String(entry.phase);
  for (const existing of entries) {
    if (existing.phase === phase && existing.currency === "current") {
      existing.currency = "historical";
    }
  }
  entries.push({
    phase,
    slice: entry.slice,
    status: entry.status,
    path: entry.path,
    recordDigest: entry.recordDigest,
    sourceCommit: entry.sourceCommit,
    currency: entry.currency || "current",
    recordedAt: entry.recordedAt || new Date().toISOString()
  });
  const next = {
    schemaVersion: 1,
    roadmapVersion: ROADMAP_VERSION,
    issue: ISSUE_URL,
    updatedAt: new Date().toISOString(),
    entries
  };
  const file = path.join(root, EVIDENCE_ROOT, "ledger.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function verifyLedger(root = REPO_ROOT, { strict = false } = {}) {
  const ledger = loadLedger(root);
  const errors = [];
  if (!ledger.entries?.length) {
    return { ok: false, errors: ["Ledger has no entries."], ledger };
  }
  for (const entry of ledger.entries) {
    if (!entry.path) {
      errors.push(`Ledger entry for phase ${entry.phase} is missing path.`);
      continue;
    }
    const absolute = path.join(root, entry.path);
    if (!fs.existsSync(absolute)) {
      errors.push(`Missing evidence file ${entry.path}.`);
      continue;
    }
    let record;
    try {
      record = JSON.parse(fs.readFileSync(absolute, "utf8"));
    } catch {
      errors.push(`Unreadable evidence file ${entry.path}.`);
      continue;
    }
    const result = validateEvidenceRecord(record, {
      strict: strict && entry.currency === "current",
      root,
      rejectProvisional: strict && entry.currency === "current" && entry.status === "qualified"
    });
    if (!result.ok) {
      errors.push(...result.errors.map((message) => `${entry.path}: ${message}`));
    }
    if (entry.recordDigest && record.recordDigest && entry.recordDigest !== record.recordDigest) {
      errors.push(`${entry.path}: ledger recordDigest mismatch.`);
    }
  }
  return { ok: errors.length === 0, errors, ledger };
}

export function verifyPhase(phase, root = REPO_ROOT, { strict = true } = {}) {
  const ledger = loadLedger(root);
  const current = [...(ledger.entries || [])]
    .reverse()
    .find((entry) => String(entry.phase) === String(phase) && entry.currency === "current");
  if (!current) {
    return { ok: false, errors: [`No current ledger entry for phase ${phase}.`] };
  }
  const absolute = path.join(root, current.path);
  if (!fs.existsSync(absolute)) {
    return { ok: false, errors: [`Missing evidence file ${current.path}.`] };
  }
  const record = JSON.parse(fs.readFileSync(absolute, "utf8"));
  return validateEvidenceRecord(record, { strict, root });
}

export function evidenceStatus(root = REPO_ROOT, { strict = false } = {}) {
  const ledger = loadLedger(root);
  const byPhase = {};
  for (const entry of ledger.entries || []) {
    if (entry.currency !== "current") continue;
    byPhase[entry.phase] = entry;
  }
  const verification = verifyLedger(root, { strict });
  return {
    ok: verification.ok,
    errors: verification.errors,
    phases: byPhase,
    ledger
  };
}

/** Prove evidence-only path exclusion from source digests. */
export function digestsIgnoreEvidenceOnly(root = REPO_ROOT) {
  const without = computeInventoryDigest(root, { includeEvidence: false });
  const withEvidence = computeInventoryDigest(root, { includeEvidence: true });
  return {
    sourceDigest: without,
    fullDigest: withEvidence,
    evidenceOnlyExcluded: without !== withEvidence || listSourceInventory(root, { includeEvidence: true })
      .some((relative) => isEvidenceOnlyPath(relative))
  };
}

export function runCommandCapture(command, args, { cwd = REPO_ROOT, env = process.env, timeout = 120000 } = {}) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    shell: false,
    timeout,
    maxBuffer: 16 * 1024 * 1024
  });
  const endedAt = new Date().toISOString();
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  return {
    command: [command, ...args].join(" "),
    exitCode: result.status,
    startedAt,
    endedAt,
    outputDigest: sha256Text(output),
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    signal: result.signal || null
  };
}

export { REPO_ROOT, sha256Text };
