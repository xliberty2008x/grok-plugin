/**
 * Worker Broker evidence inventory, capture helpers, and strict validation.
 * Pure domain functions — CLI entrypoint is scripts/worker-broker-evidence.mjs.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { redactText } from "../../plugins/grok/scripts/lib/redact.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const EVIDENCE_SCHEMA_VERSION = 1;
export const ROADMAP_VERSION = "1.0";
export const ISSUE_URL = "https://github.com/xliberty2008x/grok-plugin/issues/25";
export const EVIDENCE_ROOT = "tests/e2e-results/worker-broker";
export const EVIDENCE_ONLY_PREFIXES = Object.freeze([
  `${EVIDENCE_ROOT}/`,
  "tests/e2e-results/macos-",
  "tests/e2e-results/qualification-"
]);

/** Explicit phase entrypoints; repository-local static imports are derived below. */
const PHASE_SCOPE_SEEDS = freezeScopeMap({
  "0": [
    "plugins/grok/scripts/lib/redact.mjs",
    "scripts/lib/worker-broker-evidence.mjs",
    "scripts/worker-broker-evidence.mjs",
    "scripts/validate.mjs",
    "plugins/grok/schemas/worker-broker-evidence.schema.json",
    "tests/worker-broker-evidence.test.mjs",
    "tests/helpers.mjs",
    "package.json"
  ],
  "1": [
    "plugins/grok/scripts/lib/redact.mjs",
    "plugins/grok/scripts/lib/errors.mjs",
    "plugins/grok/scripts/lib/host.mjs",
    "plugins/grok/scripts/lib/worker-protocol.mjs",
    "plugins/grok/scripts/lib/worker-service.mjs",
    "plugins/grok/scripts/lib/worker-authority.mjs",
    "plugins/grok/scripts/lib/worker-mutation.mjs",
    "plugins/grok/scripts/lib/worker-reconcile.mjs",
    "plugins/grok/scripts/lib/worker-roles.mjs",
    "plugins/grok/scripts/lib/state.mjs",
    "plugins/grok/scripts/lib/task-contract.mjs",
    "plugins/grok/scripts/lib/workspace.mjs",
    "plugins/grok/mcp/broker.mjs",
    "plugins/grok/mcp/server.mjs",
    "plugins/grok/schemas/worker-protocol.schema.json",
    "tests/worker-protocol.test.mjs",
    "tests/worker-service.test.mjs",
    "tests/mcp-worker-broker.test.mjs",
    "tests/worker-mutation.test.mjs",
    "tests/state.test.mjs",
    "tests/args-redaction-profiles.test.mjs",
    "tests/redact.test.mjs",
    "tests/helpers.mjs"
  ],
  "2": [
    "plugins/grok/scripts/lib/redact.mjs",
    "plugins/grok/scripts/lib/errors.mjs",
    "plugins/grok/scripts/lib/host.mjs",
    "plugins/grok/scripts/lib/worker-mailbox.mjs",
    "plugins/grok/scripts/lib/worker-roles.mjs",
    "plugins/grok/scripts/lib/worker-context.mjs",
    "plugins/grok/scripts/lib/worker-mutation.mjs",
    "plugins/grok/scripts/lib/worker-service.mjs",
    "plugins/grok/scripts/lib/worker-protocol.mjs",
    "plugins/grok/scripts/lib/state.mjs",
    "plugins/grok/scripts/lib/task-contract.mjs",
    "plugins/grok/scripts/lib/workspace.mjs",
    "plugins/grok/mcp/broker.mjs",
    "tests/worker-mailbox.test.mjs",
    "tests/worker-context-roles.test.mjs",
    "tests/args-redaction-profiles.test.mjs",
    "tests/redact.test.mjs",
    "tests/helpers.mjs"
  ],
  "3": [
    "plugins/grok/scripts/lib/errors.mjs",
    "plugins/grok/scripts/lib/host.mjs",
    "plugins/grok/scripts/lib/workspace.mjs",
    "plugins/grok/scripts/lib/worker-worktree.mjs",
    "plugins/grok/scripts/lib/worker-mutation.mjs",
    "plugins/grok/scripts/lib/state.mjs",
    "plugins/grok/scripts/lib/task-contract.mjs",
    "plugins/grok/scripts/lib/worker-protocol.mjs",
    "tests/state.test.mjs",
    "tests/worker-worktree.test.mjs",
    "tests/worker-safety-proofs.test.mjs",
    "tests/helpers.mjs"
  ],
  "4": [
    "plugins/grok/scripts/lib/redact.mjs",
    "plugins/grok/scripts/lib/errors.mjs",
    "plugins/grok/scripts/lib/task-contract.mjs",
    "plugins/grok/scripts/lib/worker-presentation.mjs",
    "plugins/grok/scripts/lib/worker-protocol.mjs",
    "plugins/grok/mcp/broker.mjs",
    "plugins/grok/schemas/worker-protocol.schema.json",
    "tests/worker-presentation.test.mjs",
    "tests/worker-protocol.test.mjs",
    "tests/mcp-worker-broker.test.mjs",
    "tests/args-redaction-profiles.test.mjs",
    "tests/redact.test.mjs",
    "tests/helpers.mjs"
  ],
  "5": [
    "plugins/grok/scripts/lib/redact.mjs",
    "plugins/grok/scripts/lib/errors.mjs",
    "plugins/grok/scripts/lib/host.mjs",
    "tests/worker-safety-proofs.test.mjs",
    "plugins/grok/scripts/lib/worker-mutation.mjs",
    "plugins/grok/scripts/lib/worker-reconcile.mjs",
    "plugins/grok/scripts/lib/worker-mailbox.mjs",
    "plugins/grok/scripts/lib/worker-worktree.mjs",
    "plugins/grok/scripts/lib/worker-protocol.mjs",
    "plugins/grok/scripts/lib/worker-service.mjs",
    "plugins/grok/scripts/lib/state.mjs",
    "plugins/grok/scripts/lib/task-contract.mjs",
    "plugins/grok/scripts/lib/workspace.mjs",
    "tests/worker-mutation.test.mjs",
    "tests/worker-mailbox.test.mjs",
    "tests/worker-worktree.test.mjs",
    "tests/state.test.mjs",
    "scripts/lib/worker-broker-evidence.mjs",
    "tests/args-redaction-profiles.test.mjs",
    "tests/redact.test.mjs",
    "tests/helpers.mjs"
  ]
});

const STATIC_IMPORT_PATTERNS = Object.freeze([
  /(?:^|[;\r\n])\s*import\s+(?:[^"'`;]*?\s+from\s+)?(["'])([^"']+)\1/gm,
  /(?:^|[;\r\n])\s*export\s+[^"'`;]*?\s+from\s+(["'])([^"']+)\1/gm
]);

function freezeScopeMap(scope) {
  return Object.freeze(Object.fromEntries(
    Object.entries(scope).map(([phase, paths]) => [phase, Object.freeze([...paths])])
  ));
}

function repositoryRelativePath(root, absolute) {
  const relative = path.relative(root, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Phase scope path escapes repository root: ${absolute}`);
  }
  return relative.split(path.sep).join("/");
}

function maskCommentsAndTemplates(source) {
  let masked = "";
  let state = "code";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      if (char === "\n" || char === "\r") {
        state = "code";
        masked += char;
      } else {
        masked += " ";
      }
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        masked += "  ";
        index += 1;
        state = "code";
      } else {
        masked += char === "\n" || char === "\r" ? char : " ";
      }
      continue;
    }
    if (state === "template") {
      if (char === "\\") {
        masked += " ";
        if (index + 1 < source.length) {
          masked += source[index + 1] === "\n" || source[index + 1] === "\r"
            ? source[index + 1]
            : " ";
          index += 1;
        }
      } else if (char === "`") {
        masked += " ";
        state = "code";
      } else {
        masked += char === "\n" || char === "\r" ? char : " ";
      }
      continue;
    }
    if (state === "single-quote" || state === "double-quote") {
      masked += char;
      if (char === "\\" && index + 1 < source.length) {
        masked += source[index + 1];
        index += 1;
      } else if ((state === "single-quote" && char === "'")
        || (state === "double-quote" && char === '"')) {
        state = "code";
      }
      continue;
    }
    if (char === "/" && next === "/") {
      masked += "  ";
      index += 1;
      state = "line-comment";
    } else if (char === "/" && next === "*") {
      masked += "  ";
      index += 1;
      state = "block-comment";
    } else if (char === "`") {
      masked += " ";
      state = "template";
    } else if (char === "'") {
      masked += char;
      state = "single-quote";
    } else if (char === '"') {
      masked += char;
      state = "double-quote";
    } else {
      masked += char;
    }
  }
  return masked;
}

/**
 * Return relative static ESM specifiers under one deterministic parsing policy.
 *
 * Recognized declarations are `import "./x"`, `import ... from "./x"`, and
 * `export ... from "./x"` at a statement boundary. Bare/package imports,
 * `node:` imports, `require()`, and dynamic `import()` are deliberately outside
 * this source-digest dependency policy.
 */
export function listLocalStaticImportSpecifiers(source) {
  const specifiers = new Set();
  const parseableSource = maskCommentsAndTemplates(source);
  for (const pattern of STATIC_IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of parseableSource.matchAll(pattern)) {
      const specifier = match[2];
      if (specifier?.startsWith(".")) specifiers.add(specifier);
    }
  }
  return [...specifiers].sort();
}

function resolveLocalStaticImport(importer, specifier, root) {
  const cleanSpecifier = specifier.split(/[?#]/, 1)[0];
  const unresolved = path.resolve(root, path.dirname(importer), cleanSpecifier);
  repositoryRelativePath(root, unresolved);
  const candidates = [
    unresolved,
    `${unresolved}.mjs`,
    `${unresolved}.js`,
    `${unresolved}.cjs`,
    `${unresolved}.json`,
    path.join(unresolved, "index.mjs"),
    path.join(unresolved, "index.js"),
    path.join(unresolved, "index.cjs"),
    path.join(unresolved, "index.json")
  ];
  const resolved = candidates.find((candidate) => {
    try {
      return fs.lstatSync(candidate).isFile() || fs.lstatSync(candidate).isSymbolicLink();
    } catch {
      return false;
    }
  });
  if (!resolved) {
    throw new Error(`Cannot resolve local static import ${specifier} from ${importer}.`);
  }
  return repositoryRelativePath(root, resolved);
}

function directLocalStaticImportDependencies(relative, root) {
  if (!/\.(?:[cm]?js)$/i.test(relative)) return [];
  const absolute = path.resolve(root, relative);
  repositoryRelativePath(root, absolute);
  const source = fs.readFileSync(absolute, "utf8");
  return listLocalStaticImportSpecifiers(source)
    .map((specifier) => resolveLocalStaticImport(relative, specifier, root))
    .sort();
}

/**
 * Recursively close seed paths over repository-local static ESM imports.
 * Paths are normalized to repository-relative POSIX form and sorted so scope
 * manifests and their digests are deterministic across supported platforms.
 */
export function expandLocalStaticImportClosure(seedPaths, root = REPO_ROOT) {
  const pending = [...new Set(seedPaths)].sort();
  const closure = new Set();
  while (pending.length) {
    const candidate = pending.shift();
    const relative = repositoryRelativePath(root, path.resolve(root, candidate));
    if (closure.has(relative)) continue;
    if (!fs.existsSync(path.resolve(root, relative))) {
      throw new Error(`Phase scope contains missing path: ${relative}`);
    }
    closure.add(relative);
    for (const dependency of directLocalStaticImportDependencies(relative, root)) {
      if (!closure.has(dependency)) pending.push(dependency);
    }
    pending.sort();
  }
  return [...closure].sort();
}

/** Return direct local static imports omitted from an allegedly closed scope. */
export function findMissingLocalStaticImportDependencies(scopePaths, root = REPO_ROOT) {
  const declared = new Set(scopePaths);
  const missing = [];
  for (const importer of [...declared].sort()) {
    for (const dependency of directLocalStaticImportDependencies(importer, root)) {
      if (!declared.has(dependency)) missing.push({ importer, dependency });
    }
  }
  return missing.sort((left, right) => (
    left.importer.localeCompare(right.importer)
    || left.dependency.localeCompare(right.dependency)
  ));
}

/** Paths that participate in phase-scope digests (source that invalidates proof). */
export const PHASE_SCOPE = freezeScopeMap(Object.fromEntries(
  Object.entries(PHASE_SCOPE_SEEDS).map(([phase, seeds]) => [
    phase,
    expandLocalStaticImportClosure(seeds, REPO_ROOT)
  ])
));

/**
 * Stable gate identifiers required before a phase may claim deterministic
 * verification. Evidence producers may add gates, but they may not substitute
 * prose command labels for these phase contracts.
 */
export const PHASE_MANDATORY_GATE_IDS = Object.freeze({
  "0": Object.freeze(["repository-check", "phase-0-focused-tests", "git-diff-check"]),
  "1": Object.freeze(["repository-check", "phase-1-focused-tests", "git-diff-check"]),
  "2": Object.freeze(["repository-check", "phase-2-focused-tests", "git-diff-check"]),
  "3": Object.freeze(["repository-check", "phase-3-focused-tests", "git-diff-check"]),
  "4": Object.freeze(["repository-check", "phase-4-focused-tests", "git-diff-check"]),
  "5": Object.freeze(["repository-check", "phase-5-focused-tests", "git-diff-check"]),
  aggregate: Object.freeze(["repository-check", "aggregate-qualification", "git-diff-check"])
});

/** Phase dependency closure required for current verified evidence. */
export const PHASE_PREREQUISITES = Object.freeze({
  "0": Object.freeze([]),
  "1": Object.freeze(["0"]),
  "2": Object.freeze(["0", "1"]),
  "3": Object.freeze(["0", "1"]),
  "4": Object.freeze(["0", "1", "2", "3"]),
  "5": Object.freeze(["0", "1", "2", "3", "4"]),
  aggregate: Object.freeze(["0", "1", "2", "3", "4", "5"])
});

export const QUALIFICATION_BOUNDARIES = Object.freeze([
  "deterministic",
  "installedHost",
  "provider",
  "release"
]);

const RECORD_TOP_LEVEL_FIELDS = new Set([
  "schemaVersion",
  "roadmapVersion",
  "recordType",
  "issue",
  "pullRequest",
  "phase",
  "slice",
  "status",
  "recordedAt",
  "releaseQualification",
  "evidenceSystemQualification",
  "provisionalSupportingRecord",
  "qualification",
  "source",
  "installation",
  "runtime",
  "prerequisites",
  "verification",
  "scenarios",
  "liveScenarios",
  "ci",
  "authorities",
  "limits",
  "recordDigest"
]);

const VERIFICATION_FIELDS = new Set([
  "gateId",
  "command",
  "argv",
  "boundary",
  "outcome",
  "startedAt",
  "endedAt",
  "exitCode",
  "testsPassed",
  "testsSkipped",
  "testsFailed",
  "outputDigest",
  "assertions",
  "skipMeaning"
]);

const SOURCE_FIELDS = new Set([
  "pluginVersion",
  "foundationCommit",
  "headCommit",
  "headTree",
  "sourceInventoryDigest",
  "phaseScopeDigest",
  "cleanTreeAtVerification",
  "phaseScopePaths"
]);
const INSTALLATION_FIELDS = new Set([
  "method",
  "sourcePluginInventoryDigest",
  "installedPluginInventoryDigest",
  "installedFileCount",
  "sourceAndInstalledInventoriesEqual",
  "privateInstallPathRecorded"
]);
const RUNTIME_FIELDS = new Set([
  "platform",
  "architecture",
  "node",
  "git",
  "codexStandalone",
  "codexDesktopBundled",
  "grokBuild",
  "grokBuildRevision",
  "mcpProtocolVersion"
]);
const SCENARIO_FIELDS = new Set([
  "id",
  "boundary",
  "expected",
  "actual",
  "outcome",
  "measurements",
  "negative"
]);
const NUMERIC_MEASUREMENT_FIELDS = new Set([
  "durationMs",
  "spawnLatencyMs",
  "terminalVisibilityMs",
  "cancellationRequestToProcessGroupGoneMs",
  "cancellationRequestToTerminalRecordMs",
  "workerCount",
  "messageCount",
  "deliveredCount",
  "rejectedCount",
  "deliveryUnknownCount",
  "duplicateDeliveryCount",
  "providerLaunchCount",
  "artifactCount",
  "changedFileCount",
  "parentMutationCount",
  "assertionCount",
  "testsPassed",
  "testsFailed",
  "testsSkipped",
  "retryCount",
  "conflictCount",
  "gapCount",
  "bytes"
]);
const BOOLEAN_MEASUREMENT_FIELDS = new Set([
  "parentUnchanged",
  "workspaceIsolated",
  "terminalObserved",
  "processGroupGone"
]);
const MEASUREMENT_FIELDS = new Set([
  ...NUMERIC_MEASUREMENT_FIELDS,
  ...BOOLEAN_MEASUREMENT_FIELDS
]);
const LIVE_SCENARIO_FIELDS = new Set([
  "id",
  "boundary",
  "runtime",
  "expected",
  "actual",
  "outcome"
]);
const AUTHORITIES_FIELDS = new Set([
  "workerClaims",
  "runtimeObservations",
  "hostVerification",
  "independentValidation"
]);
const LIMITS_FIELDS = new Set([
  "residualRisks",
  "unsupportedPlatforms",
  "invalidationTriggers",
  "supersededBy",
  "liveQualificationGaps"
]);
const CI_FIELDS = new Set(["workflowUrl", "runId", "attempt", "jobs"]);
const CI_JOB_FIELDS = new Set(["name", "result"]);
const LEDGER_FIELDS = new Set([
  "schemaVersion",
  "roadmapVersion",
  "issue",
  "updatedAt",
  "entries"
]);
const LEDGER_ENTRY_FIELDS = new Set([
  "phase",
  "slice",
  "status",
  "path",
  "recordDigest",
  "sourceCommit",
  "currency",
  "recordedAt"
]);
const EVIDENCE_PATH_FIELDS = new Set([
  ...RECORD_TOP_LEVEL_FIELDS,
  ...VERIFICATION_FIELDS,
  ...SOURCE_FIELDS,
  ...INSTALLATION_FIELDS,
  ...RUNTIME_FIELDS,
  ...SCENARIO_FIELDS,
  ...LIVE_SCENARIO_FIELDS,
  ...AUTHORITIES_FIELDS,
  ...LIMITS_FIELDS,
  ...CI_FIELDS,
  ...CI_JOB_FIELDS,
  ...LEDGER_FIELDS,
  ...LEDGER_ENTRY_FIELDS,
  ...QUALIFICATION_BOUNDARIES,
  ...MEASUREMENT_FIELDS,
  "phase",
  "recordDigest",
  "gateIds"
]);

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
const VERIFIED_STATUS_SET = new Set(["verified_on_draft", "qualified"]);
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_EVIDENCE_RECORD_BYTES = 256 * 1024;
const MAX_EVIDENCE_STRING_CHARS = 4096;
const MAX_EVIDENCE_ARRAY_ITEMS = 128;
const MAX_EVIDENCE_DEPTH = 10;
const LEDGER_LOCK_NAME = ".ledger.lock";
const LEDGER_LOCK_OWNER_FILE = "owner.json";
const LEDGER_LOCK_TRANSITION_FILE = "transition.json";
const LEDGER_LOCK_WAIT_MS = 5_000;
const LEDGER_LOCK_CONSTRUCTION_GRACE_MS = 30_000;
const LEDGER_LOCK_RECORD_BYTES = 4 * 1024;
const LEDGER_CURRENCIES = new Set(["current", "historical", "invalidated"]);
const PRIVATE_EVIDENCE_PATH = /(?:^|[\s"'(=])(?:file:\/\/(?:localhost)?)?(?:\/(?:private\/)?tmp(?:\/|\b)|\/(?:private\/)?var\/folders(?:\/|\b)|\/root(?:\/|\b)|~\/|\/(?:Users|home)\/[^\s"'`;,)\]}]+|[A-Za-z]:[\\/]Users[\\/][^\s"'`;,)\]}]+)/i;
const PRIVATE_EVIDENCE_FIELD = /(?:^|_)(?:raw|private|authorization|api_key|access_token|refresh_token|tokens?|password|passwd|pwd|secret|credential|cookie)(?:_|$)/;

function fixedEvidenceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function invalidEvidencePublicationError() {
  return fixedEvidenceError(
    "E_EVIDENCE_RECORD_INVALID",
    "Evidence record is invalid or unsafe for publication."
  );
}

function invalidLedgerUpdateError() {
  return fixedEvidenceError(
    "E_EVIDENCE_LEDGER_UPDATE_INVALID",
    "Evidence ledger update is invalid or unsafe."
  );
}

function invalidLedgerDocumentError() {
  return fixedEvidenceError(
    "E_EVIDENCE_LEDGER_INVALID",
    "Evidence ledger is malformed, unsafe, or unreadable."
  );
}

function evidenceLedgerLockError() {
  return fixedEvidenceError(
    "E_EVIDENCE_LEDGER_LOCK",
    "Evidence ledger lock is unsafe or unavailable."
  );
}

function isPrivateEvidenceField(field) {
  const segmented = String(field)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
  return PRIVATE_EVIDENCE_FIELD.test(segmented);
}

function isIsoDateTime(value) {
  return typeof value === "string"
    && value.length > 0
    && Number.isFinite(Date.parse(value));
}

function unexpectedFields(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).filter((field) => !allowed.has(field));
}

function boundedEvidenceErrors(value, pathName = "$", depth = 0, errors = []) {
  if (depth > MAX_EVIDENCE_DEPTH) {
    errors.push(`${pathName} exceeds maximum evidence nesting depth ${MAX_EVIDENCE_DEPTH}.`);
    return errors;
  }
  if (typeof value === "string") {
    if (value.length > MAX_EVIDENCE_STRING_CHARS) {
      errors.push(`${pathName} exceeds ${MAX_EVIDENCE_STRING_CHARS} characters.`);
    }
    if (redactText(value) !== value) {
      errors.push(`${pathName} contains secret-shaped text.`);
    }
    if (PRIVATE_EVIDENCE_PATH.test(value)) {
      errors.push(`${pathName} contains a private runtime path.`);
    }
    return errors;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_EVIDENCE_ARRAY_ITEMS) {
      errors.push(`${pathName} exceeds ${MAX_EVIDENCE_ARRAY_ITEMS} items.`);
    }
    value.forEach((item, index) => boundedEvidenceErrors(item, `${pathName}[${index}]`, depth + 1, errors));
    return errors;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const supportedKey = EVIDENCE_PATH_FIELDS.has(key);
      const publicKey = supportedKey ? key : "<unsupported>";
      if (!supportedKey && isPrivateEvidenceField(key)) {
        errors.push(`${pathName}.${publicKey} is a forbidden raw/private evidence field.`);
      }
      boundedEvidenceErrors(child, `${pathName}.${publicKey}`, depth + 1, errors);
    }
  }
  return errors;
}

function rawEvidenceValueIsSafe(value, pathName = "$") {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string"
      && Buffer.byteLength(serialized) <= MAX_EVIDENCE_RECORD_BYTES
      && boundedEvidenceErrors(value, pathName).length === 0;
  } catch {
    return false;
  }
}

function unsafeEvidenceFileError() {
  const error = new Error("Evidence file is unsafe or unreadable.");
  error.code = "E_EVIDENCE_FILE_UNSAFE";
  return error;
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function samePathIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode;
}

function captureEvidencePathChain(root, absolute) {
  const lexicalRoot = path.resolve(root);
  const lexicalAbsolute = path.resolve(absolute);
  const relative = path.relative(lexicalRoot, lexicalAbsolute);
  if (!relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw unsafeEvidenceFileError();
  }

  const canonicalRoot = fs.realpathSync.native(lexicalRoot);
  let cursor = canonicalRoot;
  const components = relative.split(path.sep).filter(Boolean);
  const snapshots = [];
  for (const [index, component] of components.entries()) {
    cursor = path.join(cursor, component);
    const stat = fs.lstatSync(cursor, { bigint: true });
    if (stat.isSymbolicLink()) throw unsafeEvidenceFileError();
    if (index < components.length - 1 && !stat.isDirectory()) {
      throw unsafeEvidenceFileError();
    }
    snapshots.push(stat);
  }
  return { canonicalRoot, canonicalAbsolute: cursor, snapshots };
}

/**
 * Read a repository-local evidence file without following any path-component
 * symlink. The path chain and opened file identity must remain stable for the
 * complete bounded read, so replacements race fail closed.
 */
function readBoundedEvidenceFileSnapshot(root, absolute, maxBytes = MAX_EVIDENCE_RECORD_BYTES) {
  const before = captureEvidencePathChain(root, absolute);
  const beforeFile = before.snapshots.at(-1);
  if (!beforeFile?.isFile() || beforeFile.size > BigInt(maxBytes)) {
    throw unsafeEvidenceFileError();
  }

  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  let descriptor;
  try {
    descriptor = fs.openSync(before.canonicalAbsolute, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()
      || opened.size > BigInt(maxBytes)
      || !sameFileSnapshot(beforeFile, opened)) {
      throw unsafeEvidenceFileError();
    }
    const content = fs.readFileSync(descriptor);
    const afterOpen = fs.fstatSync(descriptor, { bigint: true });
    const after = captureEvidencePathChain(root, absolute);
    if (content.byteLength > maxBytes
      || after.canonicalRoot !== before.canonicalRoot
      || after.snapshots.length !== before.snapshots.length
      || !after.snapshots.every((stat, index) => sameFileSnapshot(stat, before.snapshots[index]))
      || !sameFileSnapshot(opened, afterOpen)) {
      throw unsafeEvidenceFileError();
    }
    return {
      contents: content.toString("utf8"),
      fileSnapshot: afterOpen,
      pathChain: after
    };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readBoundedEvidenceFile(root, absolute, maxBytes = MAX_EVIDENCE_RECORD_BYTES) {
  return readBoundedEvidenceFileSnapshot(root, absolute, maxBytes).contents;
}

function samePathChain(left, right) {
  return left.canonicalRoot === right.canonicalRoot
    && left.canonicalAbsolute === right.canonicalAbsolute
    && left.snapshots.length === right.snapshots.length
    && right.snapshots.every((stat, index) => samePathIdentity(stat, left.snapshots[index]));
}

function ensureEvidenceDirectory(root, directory) {
  const lexicalRoot = path.resolve(root);
  const lexicalDirectory = path.resolve(directory);
  const relative = path.relative(lexicalRoot, lexicalDirectory);
  if (!relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw unsafeEvidenceFileError();
  }
  let cursor = fs.realpathSync.native(lexicalRoot);
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try {
      fs.mkdirSync(cursor, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafeEvidenceFileError();
  }
  return captureEvidencePathChain(root, directory);
}

function assertExpectedEvidenceDestination(root, file, expected) {
  if (expected.exists) {
    const observed = readBoundedEvidenceFileSnapshot(root, file);
    if (observed.contents !== expected.contents
      || !sameFileSnapshot(observed.fileSnapshot, expected.fileSnapshot)) {
      throw unsafeEvidenceFileError();
    }
    return observed.fileSnapshot;
  }
  try {
    fs.lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  throw unsafeEvidenceFileError();
}

function atomicReplaceEvidenceFile(root, file, contents, expected) {
  const directory = path.dirname(file);
  const directoryBefore = ensureEvidenceDirectory(root, directory);
  const temporary = path.join(
    directoryBefore.canonicalAbsolute,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    assertExpectedEvidenceDestination(root, file, expected);
    const directoryAfter = captureEvidencePathChain(root, directory);
    if (!samePathChain(directoryBefore, directoryAfter)) throw unsafeEvidenceFileError();
    assertExpectedEvidenceDestination(root, file, expected);

    fs.renameSync(temporary, path.join(directoryAfter.canonicalAbsolute, path.basename(file)));
    if (process.platform !== "win32") {
      const directoryDescriptor = fs.openSync(directoryAfter.canonicalAbsolute, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function publishImmutableEvidenceFile(root, file, contents) {
  const directory = path.dirname(file);
  const directoryBefore = ensureEvidenceDirectory(root, directory);
  const temporary = path.join(
    directoryBefore.canonicalAbsolute,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  let descriptor;
  let temporarySnapshot;
  let destination = null;
  let published = false;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    temporarySnapshot = fs.fstatSync(descriptor, { bigint: true });
    fs.closeSync(descriptor);
    descriptor = undefined;

    const directoryAfter = captureEvidencePathChain(root, directory);
    if (!samePathChain(directoryBefore, directoryAfter)) throw unsafeEvidenceFileError();
    destination = path.join(directoryAfter.canonicalAbsolute, path.basename(file));

    // link(2) publishes without replacement: an existing regular file,
    // directory, or symlink all cause EEXIST and are never followed.
    fs.linkSync(temporary, destination);
    published = true;
    const publishedSnapshot = fs.lstatSync(destination, { bigint: true });
    if (!publishedSnapshot.isFile()
      || !samePathIdentity(temporarySnapshot, publishedSnapshot)
      || temporarySnapshot.size !== publishedSnapshot.size
      || temporarySnapshot.mtimeNs !== publishedSnapshot.mtimeNs) {
      throw unsafeEvidenceFileError();
    }
    const directoryFinal = captureEvidencePathChain(root, directory);
    if (!samePathChain(directoryBefore, directoryFinal)) throw unsafeEvidenceFileError();

    fs.unlinkSync(temporary);
    if (process.platform !== "win32") {
      const directoryDescriptor = fs.openSync(directoryFinal.canonicalAbsolute, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (published && destination && temporarySnapshot) {
      try {
        const publishedSnapshot = fs.lstatSync(destination, { bigint: true });
        if (samePathIdentity(temporarySnapshot, publishedSnapshot)) fs.unlinkSync(destination);
      } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function fsyncEvidenceDirectory(directory) {
  if (process.platform === "win32") return;
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function ledgerLockDirectoryIdentity(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function sameLedgerLockDirectory(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function sameLedgerLockFile(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function exactFields(value, fields) {
  return Boolean(value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === fields.size
    && Object.keys(value).every((field) => fields.has(field)));
}

function ledgerLockFingerprint(identity, ownerToken = "ownerless") {
  return crypto
    .createHash("sha256")
    .update(`${identity.dev}:${identity.ino}:${ownerToken ?? "ownerless"}`)
    .digest("hex")
    .slice(0, 24);
}

function sleepSynchronously(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function readLedgerLockFileSnapshot(root, file) {
  const before = captureEvidencePathChain(root, file);
  const beforeFile = before.snapshots.at(-1);
  if (!beforeFile?.isFile() || beforeFile.size > BigInt(LEDGER_LOCK_RECORD_BYTES)) {
    throw evidenceLedgerLockError();
  }
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  let descriptor;
  try {
    descriptor = fs.openSync(before.canonicalAbsolute, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()
      || opened.size > BigInt(LEDGER_LOCK_RECORD_BYTES)
      || !sameFileSnapshot(beforeFile, opened)) throw evidenceLedgerLockError();
    const content = fs.readFileSync(descriptor);
    const afterOpen = fs.fstatSync(descriptor, { bigint: true });
    const after = captureEvidencePathChain(root, file);
    // Sibling lock generations legitimately change the evidence-directory
    // timestamps. Bind component identities and the opened file itself instead
    // of treating unrelated parent-directory metadata churn as record mutation.
    if (content.byteLength > LEDGER_LOCK_RECORD_BYTES
      || !samePathChain(before, after)
      || !sameFileSnapshot(opened, afterOpen)) throw evidenceLedgerLockError();
    return {
      contents: content.toString("utf8"),
      fileSnapshot: afterOpen
    };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function inspectLedgerLockJson(root, file) {
  let loaded;
  try {
    loaded = readLedgerLockFileSnapshot(root, file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw evidenceLedgerLockError();
  }
  try {
    return {
      value: JSON.parse(loaded.contents),
      contents: loaded.contents,
      identity: ledgerLockDirectoryIdentity(loaded.fileSnapshot),
      mtimeMs: Number(loaded.fileSnapshot.mtimeMs)
    };
  } catch {
    throw evidenceLedgerLockError();
  }
}

function validateLedgerLockOwner(record, directoryIdentity) {
  const fields = new Set(["schemaVersion", "token", "pid", "directory"]);
  const directoryFields = new Set(["dev", "ino"]);
  if (!exactFields(record, fields)
    || record.schemaVersion !== 1
    || typeof record.token !== "string"
    || !/^[a-f0-9]{64}$/.test(record.token)
    || !Number.isInteger(record.pid)
    || record.pid <= 0
    || !exactFields(record.directory, directoryFields)
    || typeof record.directory.dev !== "string"
    || typeof record.directory.ino !== "string"
    || !sameLedgerLockDirectory(record.directory, directoryIdentity)) {
    throw evidenceLedgerLockError();
  }
  return record;
}

function validateLedgerLockTransition(record) {
  const fields = new Set([
    "schemaVersion",
    "kind",
    "token",
    "pid",
    "target",
    "ownerToken"
  ]);
  const targetFields = new Set(["dev", "ino"]);
  if (!exactFields(record, fields)
    || record.schemaVersion !== 1
    || !["reclaim", "release"].includes(record.kind)
    || typeof record.token !== "string"
    || !/^[a-f0-9]{64}$/.test(record.token)
    || !Number.isInteger(record.pid)
    || record.pid <= 0
    || !exactFields(record.target, targetFields)
    || typeof record.target.dev !== "string"
    || typeof record.target.ino !== "string"
    || (record.ownerToken !== null
      && (typeof record.ownerToken !== "string" || !/^[a-f0-9]{64}$/.test(record.ownerToken)))) {
    throw evidenceLedgerLockError();
  }
  return record;
}

function assertSafeLedgerLockDirectoryEntries(lock) {
  let names;
  try {
    names = fs.readdirSync(lock);
  } catch {
    throw evidenceLedgerLockError();
  }
  const temporary = /^\.(?:owner|transition)\.json\.\d+\.[a-f0-9]{16}\.tmp$/;
  const witness = /^\.transition-(?:stale|owned)-[a-f0-9]{64}$/;
  for (const name of names) {
    if (name === LEDGER_LOCK_OWNER_FILE || name === LEDGER_LOCK_TRANSITION_FILE) continue;
    if (!temporary.test(name) && !witness.test(name)) throw evidenceLedgerLockError();
    try {
      const stat = fs.lstatSync(path.join(lock, name));
      if (stat.isSymbolicLink() || !stat.isFile()) throw evidenceLedgerLockError();
    } catch (error) {
      if (error?.code !== "ENOENT") throw evidenceLedgerLockError();
    }
  }
}

function currentLedgerLockDirectoryIdentity(lock) {
  let stat;
  try {
    stat = fs.lstatSync(lock, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw evidenceLedgerLockError();
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw evidenceLedgerLockError();
  return {
    identity: ledgerLockDirectoryIdentity(stat),
    mtimeMs: Number(stat.mtimeMs),
    stat
  };
}

function ledgerLockGenerationChanged(lock, expectedIdentity) {
  const current = currentLedgerLockDirectoryIdentity(lock);
  return !current || !sameLedgerLockDirectory(current.identity, expectedIdentity);
}

function inspectEvidenceLedgerLock(root, lock) {
  const initial = currentLedgerLockDirectoryIdentity(lock);
  if (!initial) return null;
  let loadedOwner;
  try {
    assertSafeLedgerLockDirectoryEntries(lock);
    loadedOwner = inspectLedgerLockJson(root, path.join(lock, LEDGER_LOCK_OWNER_FILE));
  } catch (error) {
    if (ledgerLockGenerationChanged(lock, initial.identity)) return null;
    throw error?.code === "E_EVIDENCE_LEDGER_LOCK" ? error : evidenceLedgerLockError();
  }
  if (ledgerLockGenerationChanged(lock, initial.identity)) return null;
  let owner = null;
  if (loadedOwner) {
    try {
      owner = validateLedgerLockOwner(loadedOwner.value, initial.identity);
    } catch (error) {
      if (ledgerLockGenerationChanged(lock, initial.identity)) return null;
      throw error;
    }
  }
  return {
    identity: initial.identity,
    mtimeMs: initial.mtimeMs,
    owner,
    ownerToken: owner?.token ?? null,
    ownerFingerprint: loadedOwner
      ? crypto.createHash("sha256").update(loadedOwner.contents).digest("hex")
      : null
  };
}

function inspectEvidenceLedgerTransition(root, lock) {
  const initial = currentLedgerLockDirectoryIdentity(lock);
  if (!initial) return null;
  let loaded;
  try {
    loaded = inspectLedgerLockJson(root, path.join(lock, LEDGER_LOCK_TRANSITION_FILE));
  } catch (error) {
    if (ledgerLockGenerationChanged(lock, initial.identity)) return null;
    throw error?.code === "E_EVIDENCE_LEDGER_LOCK" ? error : evidenceLedgerLockError();
  }
  if (ledgerLockGenerationChanged(lock, initial.identity)) return null;
  if (!loaded) return null;
  let transition;
  try {
    transition = validateLedgerLockTransition(loaded.value);
  } catch (error) {
    if (ledgerLockGenerationChanged(lock, initial.identity)) return null;
    throw error;
  }
  return {
    ...transition,
    identity: loaded.identity,
    mtimeMs: loaded.mtimeMs
  };
}

function sameLedgerLockTransition(left, right) {
  return Boolean(left
    && right
    && left.kind === right.kind
    && left.token === right.token
    && left.pid === right.pid
    && left.ownerToken === right.ownerToken
    && sameLedgerLockDirectory(left.target, right.target)
    && sameLedgerLockFile(left.identity, right.identity));
}

function ledgerLockTransitionBindsSnapshot(transition, snapshot) {
  return Boolean(transition
    && snapshot
    && transition.ownerToken === snapshot.ownerToken
    && sameLedgerLockDirectory(transition.target, snapshot.identity));
}

function ledgerLockOwnerIsDead(owner) {
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return null;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    if (error?.code === "EPERM") return false;
    return null;
  }
}

function evidenceLedgerLockIsReclaimable(snapshot, now = Date.now()) {
  if (!snapshot) return false;
  if (snapshot.owner) return ledgerLockOwnerIsDead(snapshot.owner) === true;
  return now - snapshot.mtimeMs >= LEDGER_LOCK_CONSTRUCTION_GRACE_MS;
}

function evidenceLedgerTransitionIsAbandoned(transition) {
  return ledgerLockOwnerIsDead(transition) === true;
}

function publishExclusiveLedgerLockJson(root, file, value) {
  const directory = path.dirname(file);
  const directoryBefore = captureEvidencePathChain(root, directory);
  const temporary = path.join(
    directoryBefore.canonicalAbsolute,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  const contents = `${JSON.stringify(value)}\n`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    const temporarySnapshot = fs.fstatSync(descriptor, { bigint: true });
    fs.closeSync(descriptor);
    descriptor = undefined;

    const directoryAfter = captureEvidencePathChain(root, directory);
    if (!samePathChain(directoryBefore, directoryAfter)) throw evidenceLedgerLockError();
    const destination = path.join(directoryAfter.canonicalAbsolute, path.basename(file));
    fs.linkSync(temporary, destination);
    const destinationSnapshot = fs.lstatSync(destination, { bigint: true });
    if (!destinationSnapshot.isFile()
      || !samePathIdentity(temporarySnapshot, destinationSnapshot)
      || temporarySnapshot.size !== destinationSnapshot.size) {
      throw evidenceLedgerLockError();
    }
    fs.unlinkSync(temporary);
    fsyncEvidenceDirectory(directoryAfter.canonicalAbsolute);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function sameLedgerLockOwnerGeneration(snapshot, generation, { allowMissingOwner = false } = {}) {
  if (!snapshot || !sameLedgerLockDirectory(snapshot.identity, generation.identity)) return false;
  if (snapshot.ownerToken === generation.ownerToken
    && snapshot.ownerFingerprint === generation.ownerFingerprint) return true;
  return allowMissingOwner
    && generation.ownerToken === null
    && snapshot.owner === null
    && snapshot.ownerFingerprint === null;
}

function clearAbandonedLedgerTransition(root, lock, expected) {
  if (!expected || !evidenceLedgerTransitionIsAbandoned(expected)) return false;
  const transitionFile = path.join(lock, LEDGER_LOCK_TRANSITION_FILE);
  const witness = path.join(lock, `.transition-stale-${expected.token}`);
  try {
    fs.linkSync(transitionFile, witness);
  } catch (error) {
    if (["EEXIST", "ENOENT"].includes(error?.code)) return false;
    throw evidenceLedgerLockError();
  }
  try {
    const pinned = inspectLedgerLockJson(root, witness);
    const current = inspectEvidenceLedgerTransition(root, lock);
    const pinnedTransition = pinned
      ? { ...validateLedgerLockTransition(pinned.value), identity: pinned.identity, mtimeMs: pinned.mtimeMs }
      : null;
    if (!sameLedgerLockTransition(pinnedTransition, expected)
      || !sameLedgerLockTransition(current, expected)
      || !evidenceLedgerTransitionIsAbandoned(pinnedTransition)) return false;
    fs.unlinkSync(transitionFile);
    fsyncEvidenceDirectory(lock);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  } finally {
    try { fs.unlinkSync(witness); } catch {}
  }
}

function removeOwnedLedgerTransition(root, lock, generation, transition) {
  const transitionFile = path.join(lock, LEDGER_LOCK_TRANSITION_FILE);
  const witness = path.join(lock, `.transition-owned-${transition.token}`);
  try {
    const currentLock = inspectEvidenceLedgerLock(root, lock);
    if (!sameLedgerLockOwnerGeneration(currentLock, generation, { allowMissingOwner: true })) return;
    fs.linkSync(transitionFile, witness);
    const pinned = inspectLedgerLockJson(root, witness);
    const current = inspectEvidenceLedgerTransition(root, lock);
    const pinnedTransition = pinned
      ? { ...validateLedgerLockTransition(pinned.value), identity: pinned.identity, mtimeMs: pinned.mtimeMs }
      : null;
    if (!sameLedgerLockTransition(pinnedTransition, transition)
      || !sameLedgerLockTransition(current, transition)) return;
    fs.unlinkSync(transitionFile);
    fsyncEvidenceDirectory(lock);
  } catch (error) {
    if (!["ENOENT", "EEXIST"].includes(error?.code)) throw evidenceLedgerLockError();
  } finally {
    try { fs.unlinkSync(witness); } catch {}
  }
}

function ownsEvidenceLedgerTransition(root, lock, generation, expected) {
  const currentLock = inspectEvidenceLedgerLock(root, lock);
  const currentTransition = inspectEvidenceLedgerTransition(root, lock);
  return Boolean(sameLedgerLockOwnerGeneration(
    currentLock,
    generation,
    { allowMissingOwner: generation.ownerToken === null }
  )
    && currentTransition
    && currentTransition.ownerToken === generation.ownerToken
    && sameLedgerLockDirectory(currentTransition.target, generation.identity)
    && sameLedgerLockTransition(currentTransition, expected));
}

function claimEvidenceLedgerTransition(root, lock, generation, kind) {
  const transition = {
    schemaVersion: 1,
    kind,
    token: crypto.randomBytes(32).toString("hex"),
    pid: process.pid,
    target: generation.identity,
    ownerToken: generation.ownerToken
  };
  const transitionFile = path.join(lock, LEDGER_LOCK_TRANSITION_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = inspectEvidenceLedgerLock(root, lock);
    if (!sameLedgerLockOwnerGeneration(
      current,
      generation,
      { allowMissingOwner: generation.ownerToken === null }
    )) return null;
    try {
      publishExclusiveLedgerLockJson(root, transitionFile, transition);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error?.code !== "EEXIST") throw evidenceLedgerLockError();
      const existing = inspectEvidenceLedgerTransition(root, lock);
      if (existing && !ledgerLockTransitionBindsSnapshot(existing, current)) {
        throw evidenceLedgerLockError();
      }
      if (attempt === 0 && existing && clearAbandonedLedgerTransition(root, lock, existing)) continue;
      return null;
    }
    const claimed = inspectEvidenceLedgerTransition(root, lock);
    if (claimed && ownsEvidenceLedgerTransition(root, lock, generation, claimed)) return claimed;
    if (claimed) removeOwnedLedgerTransition(root, lock, generation, claimed);
    return null;
  }
  return null;
}

function retireEvidenceLedgerLockGeneration(root, lock, generation, kind) {
  const transition = claimEvidenceLedgerTransition(root, lock, generation, kind);
  if (!transition) return false;
  let renamed = false;
  try {
    const current = inspectEvidenceLedgerLock(root, lock);
    if (!sameLedgerLockOwnerGeneration(
      current,
      generation,
      { allowMissingOwner: generation.ownerToken === null }
    )
      || (kind === "reclaim" && !evidenceLedgerLockIsReclaimable(generation))
      || !ownsEvidenceLedgerTransition(root, lock, generation, transition)) return false;

    const retired = `${lock}.retired-${kind}-${ledgerLockFingerprint(
      generation.identity,
      generation.ownerToken
    )}-${transition.token}`;
    fs.renameSync(lock, retired);
    renamed = true;
    const frozen = inspectEvidenceLedgerLock(root, retired);
    const frozenTransition = inspectEvidenceLedgerTransition(root, retired);
    if (!sameLedgerLockOwnerGeneration(
      frozen,
      generation,
      { allowMissingOwner: generation.ownerToken === null }
    )
      || !sameLedgerLockTransition(frozenTransition, transition)) {
      throw evidenceLedgerLockError();
    }
    fs.rmSync(retired, { recursive: true, force: true });
    fsyncEvidenceDirectory(path.dirname(lock));
    return true;
  } catch (error) {
    if (["EEXIST", "ENOTEMPTY", "ENOENT"].includes(error?.code)) return false;
    if (error?.code === "E_EVIDENCE_LEDGER_LOCK") throw error;
    throw evidenceLedgerLockError();
  } finally {
    if (!renamed) removeOwnedLedgerTransition(root, lock, generation, transition);
  }
}

function acquireEvidenceLedgerLock(root) {
  const evidenceDirectory = path.join(root, EVIDENCE_ROOT);
  try {
    ensureEvidenceDirectory(root, evidenceDirectory);
  } catch {
    throw evidenceLedgerLockError();
  }
  const lock = path.join(evidenceDirectory, LEDGER_LOCK_NAME);
  const deadline = Date.now() + LEDGER_LOCK_WAIT_MS;
  for (;;) {
    let created = false;
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw evidenceLedgerLockError();
    }
    if (created) {
      const stat = fs.lstatSync(lock, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw evidenceLedgerLockError();
      const ownerToken = crypto.randomBytes(32).toString("hex");
      let generation = {
        identity: ledgerLockDirectoryIdentity(stat),
        ownerToken: null,
        ownerFingerprint: null,
        owner: null,
        mtimeMs: Number(stat.mtimeMs)
      };
      try {
        publishExclusiveLedgerLockJson(root, path.join(lock, LEDGER_LOCK_OWNER_FILE), {
          schemaVersion: 1,
          token: ownerToken,
          pid: process.pid,
          directory: generation.identity
        });
        const published = inspectEvidenceLedgerLock(root, lock);
        if (!published
          || !sameLedgerLockDirectory(published.identity, generation.identity)
          || published.ownerToken !== ownerToken
          || inspectEvidenceLedgerTransition(root, lock)) {
          throw evidenceLedgerLockError();
        }
        generation = published;
        return { root, lock, generation };
      } catch (error) {
        try {
          retireEvidenceLedgerLockGeneration(root, lock, generation, "release");
        } catch {}
        if (error?.code === "E_EVIDENCE_LEDGER_LOCK") throw error;
        throw evidenceLedgerLockError();
      }
    }

    const existing = inspectEvidenceLedgerLock(root, lock);
    if (!existing) continue;
    const transition = inspectEvidenceLedgerTransition(root, lock);
    if (transition) {
      if (!ledgerLockTransitionBindsSnapshot(transition, existing)) {
        throw evidenceLedgerLockError();
      }
      if (clearAbandonedLedgerTransition(root, lock, transition)) continue;
    } else if (evidenceLedgerLockIsReclaimable(existing)
      && retireEvidenceLedgerLockGeneration(root, lock, existing, "reclaim")) {
      continue;
    }
    if (Date.now() >= deadline) throw evidenceLedgerLockError();
    sleepSynchronously(10);
  }
}

function releaseEvidenceLedgerLock(lease) {
  const deadline = Date.now() + LEDGER_LOCK_WAIT_MS;
  for (;;) {
    const current = inspectEvidenceLedgerLock(lease.root, lease.lock);
    if (!current
      || !sameLedgerLockOwnerGeneration(current, lease.generation)) return;
    if (retireEvidenceLedgerLockGeneration(
      lease.root,
      lease.lock,
      lease.generation,
      "release"
    )) return;
    if (Date.now() >= deadline) throw evidenceLedgerLockError();
    sleepSynchronously(10);
  }
}

function withEvidenceLedgerLock(root, action) {
  const lease = acquireEvidenceLedgerLock(root);
  try {
    return action();
  } finally {
    releaseEvidenceLedgerLock(lease);
  }
}

function defaultQualification() {
  return {
    deterministic: "not_run",
    installedHost: "not_run",
    provider: "not_run",
    release: "not_run"
  };
}

function passedGateIds(record) {
  return new Set((record?.verification || [])
    .filter((entry) => entry?.outcome === "pass" && typeof entry.gateId === "string")
    .map((entry) => entry.gateId));
}

function hasPassedBoundary(record, boundary) {
  return (record?.verification || []).some((entry) => (
    entry?.outcome === "pass" && entry?.boundary === boundary
  ));
}

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

function listGitIndexIdentity(root) {
  const output = execFileSync("git", ["ls-files", "-s", "-z"], {
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

export function computePhaseScopeDigest(phase, root = REPO_ROOT) {
  const scope = PHASE_SCOPE[String(phase)] || [];
  const missing = scope.filter((relative) => !fs.existsSync(path.join(root, relative)));
  if (missing.length) {
    throw new Error(`Phase ${phase} scope contains missing paths: ${missing.join(", ")}`);
  }
  return computeInventoryDigest(root, { paths: scope });
}

/**
 * Working-tree dirtiness for evidence purposes: evidence-only paths may be dirty
 * without invalidating a clean-tree claim (they are excluded from source digests).
 */
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
  return execFileSync("git", ["ls-files", "-s", "-v", "-z"], {
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
    const status = execFileSync("git", ["status", "--porcelain=v1", "-z"], {
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
  const headCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const headTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
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

  const serializedBytes = Buffer.byteLength(JSON.stringify(record));
  if (serializedBytes > MAX_EVIDENCE_RECORD_BYTES) {
    fail(`Record exceeds ${MAX_EVIDENCE_RECORD_BYTES} serialized bytes.`);
  }
  for (const message of boundedEvidenceErrors(record)) fail(message);

  if (unexpectedFields(record, RECORD_TOP_LEVEL_FIELDS).length) {
    fail("Record contains unsupported top-level fields. Raw/private evidence is forbidden.");
  }

  if (record.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${EVIDENCE_SCHEMA_VERSION}.`);
  }
  if (record.roadmapVersion !== ROADMAP_VERSION) {
    fail(`roadmapVersion must be ${ROADMAP_VERSION}.`);
  }
  if (record.issue !== ISSUE_URL) fail("issue URL must match #25.");
  if (record.pullRequest != null && typeof record.pullRequest !== "string") {
    fail("pullRequest must be null or string.");
  }
  if (!["worker-broker-slice", "worker-broker-aggregate"].includes(record.recordType)) {
    fail("recordType is invalid.");
  }
  if (typeof record.phase !== "string"
    || !["0", "1", "2", "3", "4", "5", "aggregate"].includes(record.phase)) {
    fail("phase is invalid.");
  }
  if (typeof record.slice !== "string" || !record.slice) fail("slice is required.");
  if (!STATUS_SET.has(record.status)) fail("status is invalid.");
  if (VERIFIED_STATUS_SET.has(record.status)) {
    fail(
      "Verified status promotion is disabled until a broker-owned proof-producing runner "
      + "can attest executed gates; caller-authored timestamps and digests are not proof."
    );
  }
  if (!isIsoDateTime(record.recordedAt)) fail("recordedAt must be a valid date-time.");
  const phase = String(record.phase ?? "");
  if ((phase === "aggregate") !== (record.recordType === "worker-broker-aggregate")) {
    fail("recordType must be worker-broker-aggregate if and only if phase is aggregate.");
  }
  if (typeof record.releaseQualification !== "boolean") {
    fail("releaseQualification must be boolean.");
  }
  if (typeof record.evidenceSystemQualification !== "boolean") {
    fail("evidenceSystemQualification must be boolean.");
  }
  if (typeof record.provisionalSupportingRecord !== "boolean") {
    fail("provisionalSupportingRecord must be boolean.");
  }

  const qualification = record.qualification;
  if (!qualification || typeof qualification !== "object" || Array.isArray(qualification)) {
    fail("qualification is required and must separate deterministic, installedHost, provider, and release boundaries.");
  } else {
    const allowed = new Set(QUALIFICATION_BOUNDARIES);
    if (unexpectedFields(qualification, allowed).length) {
      fail("qualification contains unsupported fields.");
    }
    for (const boundary of QUALIFICATION_BOUNDARIES) {
      if (!OUTCOME_SET.has(qualification[boundary])) {
        fail(`qualification.${boundary} must be pass, fail, skip, or not_run.`);
      }
    }
  }

  const source = record.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    fail("source is required.");
  } else {
    if (unexpectedFields(source, SOURCE_FIELDS).length) {
      fail("source contains unsupported fields.");
    }
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
    if (typeof source.pluginVersion !== "string" || !source.pluginVersion) {
      fail("source.pluginVersion must be a nonempty string.");
    }
    if (source.foundationCommit != null && typeof source.foundationCommit !== "string") {
      fail("source.foundationCommit must be null or string.");
    }
    if (!Array.isArray(source.phaseScopePaths)
      || source.phaseScopePaths.some((relative) => typeof relative !== "string" || !relative)) {
      fail("source.phaseScopePaths must contain only nonempty strings.");
    } else {
      const expectedScope = PHASE_SCOPE[phase] || [];
      if (JSON.stringify(source.phaseScopePaths) !== JSON.stringify(expectedScope)) {
        fail("source.phaseScopePaths does not match the derived phase scope.");
      }
    }
  }

  const installation = record.installation;
  if (!installation || typeof installation !== "object" || Array.isArray(installation)) {
    fail("installation is required.");
  } else {
    if (unexpectedFields(installation, INSTALLATION_FIELDS).length) {
      fail("installation contains unsupported fields.");
    }
    if (typeof installation.method !== "string" || !installation.method) {
      fail("installation.method is required.");
    }
    if (typeof installation.privateInstallPathRecorded !== "boolean") {
      fail("installation.privateInstallPathRecorded must be boolean.");
    } else if (installation.privateInstallPathRecorded) {
      fail("installation.privateInstallPathRecorded must be false.");
    }
    for (const field of ["sourcePluginInventoryDigest", "installedPluginInventoryDigest"]) {
      if (installation[field] != null && !SHA256.test(installation[field])) {
        fail(`installation.${field} must be null or sha256 hex.`);
      }
    }
    if (installation.installedFileCount != null
      && (!Number.isInteger(installation.installedFileCount) || installation.installedFileCount < 0)) {
      fail("installation.installedFileCount must be null or a nonnegative integer.");
    }
    if (installation.sourceAndInstalledInventoriesEqual != null
      && typeof installation.sourceAndInstalledInventoriesEqual !== "boolean") {
      fail("installation.sourceAndInstalledInventoriesEqual must be null or boolean.");
    }
  }

  if (!record.runtime || typeof record.runtime !== "object" || Array.isArray(record.runtime)) {
    fail("runtime is required.");
  } else {
    if (unexpectedFields(record.runtime, RUNTIME_FIELDS).length) {
      fail("runtime contains unsupported fields.");
    }
    for (const field of ["platform", "architecture", "node", "git"]) {
      if (typeof record.runtime[field] !== "string" || !record.runtime[field]) {
        fail(`runtime.${field} must be a nonempty string.`);
      }
    }
    for (const field of [
      "codexStandalone",
      "codexDesktopBundled",
      "grokBuild",
      "grokBuildRevision",
      "mcpProtocolVersion"
    ]) {
      if (record.runtime[field] != null && typeof record.runtime[field] !== "string") {
        fail(`runtime.${field} must be null or string.`);
      }
    }
  }

  if (!Array.isArray(record.prerequisites)) {
    fail("prerequisites must be an array.");
  } else {
    const seenPrerequisites = new Set();
    for (const [index, prerequisite] of record.prerequisites.entries()) {
      if (!prerequisite || typeof prerequisite !== "object" || Array.isArray(prerequisite)) {
        fail(`prerequisites[${index}] must be an object.`);
        continue;
      }
      if (unexpectedFields(prerequisite, new Set(["phase", "recordDigest", "gateIds"])).length) {
        fail(`prerequisites[${index}] contains unsupported fields.`);
      }
      const prerequisitePhase = prerequisite.phase;
      if (typeof prerequisitePhase !== "string"
        || !Object.hasOwn(PHASE_MANDATORY_GATE_IDS, prerequisitePhase)) {
        fail(`prerequisites[${index}].phase is invalid.`);
      }
      if (seenPrerequisites.has(prerequisitePhase)) {
        fail("prerequisites contains a duplicate phase.");
      }
      seenPrerequisites.add(prerequisitePhase);
      if (!SHA256.test(prerequisite.recordDigest || "")) {
        fail(`prerequisites[${index}].recordDigest must be sha256 hex.`);
      }
      if (!Array.isArray(prerequisite.gateIds) || prerequisite.gateIds.length < 1
        || prerequisite.gateIds.some((gateId) => typeof gateId !== "string" || !gateId)) {
        fail(`prerequisites[${index}].gateIds must contain stable gate IDs.`);
      }
    }
  }

  if (!Array.isArray(record.verification) || record.verification.length < 1) {
    fail("verification must contain at least one command record.");
  } else {
    const seenGates = new Set();
    for (const [index, entry] of record.verification.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        fail(`verification[${index}] must be an object.`);
        continue;
      }
      if (unexpectedFields(entry, VERIFICATION_FIELDS).length) {
        fail(`verification[${index}] contains forbidden fields; store only bounded digests and assertions.`);
      }
      if (typeof entry.gateId !== "string" || !entry.gateId) {
        fail(`verification[${index}].gateId is required.`);
      } else if (seenGates.has(entry.gateId)) {
        fail(`verification[${index}].gateId is duplicated.`);
      } else {
        seenGates.add(entry.gateId);
      }
      const hasCommand = typeof entry.command === "string" && entry.command.trim().length > 0;
      const hasArgv = Array.isArray(entry.argv)
        && entry.argv.length > 0
        && entry.argv.every((value) => typeof value === "string" && value.length > 0);
      if (hasCommand === hasArgv) {
        fail(`verification[${index}] must contain exactly one of exact command or argv.`);
      }
      if (entry.command != null && typeof entry.command !== "string") {
        fail(`verification[${index}].command must be a string when present.`);
      }
      if (entry.argv != null && (!Array.isArray(entry.argv)
        || entry.argv.length < 1
        || entry.argv.some((value) => typeof value !== "string" || !value))) {
        fail(`verification[${index}].argv must contain only nonempty strings.`);
      }
      if (!entry.boundary || typeof entry.boundary !== "string") {
        fail(`verification[${index}].boundary is required.`);
      }
      for (const field of ["testsPassed", "testsSkipped", "testsFailed"]) {
        if (entry[field] != null && (!Number.isInteger(entry[field]) || entry[field] < 0)) {
          fail(`verification[${index}].${field} must be null or a nonnegative integer.`);
        }
      }
      if (entry.assertions != null && (!Array.isArray(entry.assertions)
        || entry.assertions.some((assertion) => typeof assertion !== "string"))) {
        fail(`verification[${index}].assertions must contain only strings.`);
      }
      for (const field of ["startedAt", "endedAt"]) {
        if (entry[field] != null && typeof entry[field] !== "string") {
          fail(`verification[${index}].${field} must be null or string.`);
        }
      }
      if (entry.exitCode != null && !Number.isInteger(entry.exitCode)) {
        fail(`verification[${index}].exitCode must be null or an integer.`);
      }
      if (entry.outputDigest != null && !SHA256.test(entry.outputDigest)) {
        fail(`verification[${index}].outputDigest must be null or sha256 hex.`);
      }
      if (entry.skipMeaning != null && typeof entry.skipMeaning !== "string") {
        fail(`verification[${index}].skipMeaning must be null or string.`);
      }
      if (!OUTCOME_SET.has(entry.outcome)) {
        fail(`verification[${index}].outcome is invalid.`);
        continue;
      }
      if (entry.outcome === "pass" || entry.outcome === "fail") {
        if (!isIsoDateTime(entry.startedAt)) {
          fail(`verification[${index}].startedAt is required for ${entry.outcome}.`);
        }
        if (!isIsoDateTime(entry.endedAt)) {
          fail(`verification[${index}].endedAt is required for ${entry.outcome}.`);
        }
        if (isIsoDateTime(entry.startedAt) && isIsoDateTime(entry.endedAt)
          && Date.parse(entry.endedAt) < Date.parse(entry.startedAt)) {
          fail(`verification[${index}].endedAt precedes startedAt.`);
        }
        if (!Number.isInteger(entry.exitCode)) {
          fail(`verification[${index}].exitCode is required for ${entry.outcome}.`);
        } else if (entry.outcome === "pass" && entry.exitCode !== 0) {
          fail(`verification[${index}] pass requires exitCode=0.`);
        } else if (entry.outcome === "fail" && entry.exitCode === 0) {
          fail(`verification[${index}] fail requires a nonzero exitCode.`);
        }
        if (!SHA256.test(entry.outputDigest || "")) {
          fail(`verification[${index}].outputDigest is required for ${entry.outcome}.`);
        }
      } else if (typeof entry.skipMeaning !== "string" || !entry.skipMeaning.trim()) {
        fail(`verification[${index}].skipMeaning is required for ${entry.outcome}.`);
      }
    }
  }

  for (const collection of ["scenarios", "liveScenarios"]) {
    if (!Array.isArray(record[collection])) {
      fail(`${collection} must be an array.`);
      continue;
    }
    for (const [index, scenario] of record[collection].entries()) {
      if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) {
        fail(`${collection}[${index}] must be an object.`);
        continue;
      }
      const fields = collection === "scenarios" ? SCENARIO_FIELDS : LIVE_SCENARIO_FIELDS;
      if (unexpectedFields(scenario, fields).length) {
        fail(`${collection}[${index}] contains unsupported fields.`);
      }
      if (!OUTCOME_SET.has(scenario.outcome)) {
        fail(`${collection}[${index}].outcome is invalid.`);
      }
      if (typeof scenario.id !== "string" || !scenario.id) {
        fail(`${collection}[${index}].id is required.`);
      }
      if (collection === "scenarios") {
        if (scenario.boundary != null && typeof scenario.boundary !== "string") {
          fail(`scenarios[${index}].boundary must be null or string.`);
        }
        if (typeof scenario.expected !== "string" || typeof scenario.actual !== "string") {
          fail(`scenarios[${index}] requires expected and actual strings.`);
        }
        if (scenario.measurements != null) {
          if (typeof scenario.measurements !== "object" || Array.isArray(scenario.measurements)) {
            fail(`scenarios[${index}].measurements must be an object.`);
          } else {
            if (unexpectedFields(scenario.measurements, MEASUREMENT_FIELDS).length) {
              fail(`scenarios[${index}].measurements contains unsupported metrics.`);
            }
            for (const [field, value] of Object.entries(scenario.measurements)) {
              if (NUMERIC_MEASUREMENT_FIELDS.has(field)
                && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
                fail(`scenarios[${index}].measurements.${field} must be a nonnegative finite number.`);
              }
              if (BOOLEAN_MEASUREMENT_FIELDS.has(field) && typeof value !== "boolean") {
                fail(`scenarios[${index}].measurements.${field} must be boolean.`);
              }
            }
          }
        }
        if (scenario.negative != null && typeof scenario.negative !== "boolean") {
          fail(`scenarios[${index}].negative must be boolean.`);
        }
      } else {
        if (typeof scenario.boundary !== "string" || !scenario.boundary) {
          fail(`liveScenarios[${index}].boundary is required.`);
        }
        for (const field of ["runtime", "expected", "actual"]) {
          if (scenario[field] != null && typeof scenario[field] !== "string") {
            fail(`liveScenarios[${index}].${field} must be null or string.`);
          }
        }
      }
    }
  }

  if (!record.authorities || typeof record.authorities !== "object" || Array.isArray(record.authorities)) {
    fail("authorities is required.");
  } else {
    if (unexpectedFields(record.authorities, AUTHORITIES_FIELDS).length) {
      fail("authorities contains unsupported fields.");
    }
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

  if (!record.limits || typeof record.limits !== "object" || Array.isArray(record.limits)) {
    fail("limits is required.");
  } else {
    if (unexpectedFields(record.limits, LIMITS_FIELDS).length) {
      fail("limits contains unsupported fields.");
    }
    for (const field of ["residualRisks", "unsupportedPlatforms", "invalidationTriggers"]) {
      if (!Array.isArray(record.limits[field])
        || record.limits[field].some((item) => typeof item !== "string")) {
        fail(`limits.${field} must contain only strings.`);
      }
    }
    if (record.limits.liveQualificationGaps != null
      && (!Array.isArray(record.limits.liveQualificationGaps)
        || record.limits.liveQualificationGaps.some((item) => typeof item !== "string"))) {
      fail("limits.liveQualificationGaps must contain only strings.");
    }
    if (record.limits.supersededBy != null && typeof record.limits.supersededBy !== "string") {
      fail("limits.supersededBy must be null or string.");
    }
  }

  if (record.ci != null) {
    if (typeof record.ci !== "object" || Array.isArray(record.ci)) {
      fail("ci must be null or an object.");
    } else {
      if (unexpectedFields(record.ci, CI_FIELDS).length) {
        fail("ci contains unsupported fields.");
      }
      if (record.ci.workflowUrl != null && typeof record.ci.workflowUrl !== "string") {
        fail("ci.workflowUrl must be null or string.");
      }
      if (record.ci.runId != null && typeof record.ci.runId !== "string") {
        fail("ci.runId must be null or string.");
      }
      if (record.ci.attempt != null && !Number.isInteger(record.ci.attempt)) {
        fail("ci.attempt must be null or integer.");
      }
      if (record.ci.jobs != null && !Array.isArray(record.ci.jobs)) {
        fail("ci.jobs must be an array.");
      }
      for (const [index, job] of (record.ci.jobs || []).entries()) {
        if (!job || typeof job !== "object" || Array.isArray(job)) {
          fail(`ci.jobs[${index}] must be an object.`);
          continue;
        }
        if (unexpectedFields(job, CI_JOB_FIELDS).length) {
          fail(`ci.jobs[${index}] contains unsupported fields.`);
        }
        if (typeof job.name !== "string" || !job.name) fail(`ci.jobs[${index}].name is required.`);
        if (!["success", "failure", "skipped", "cancelled"].includes(job.result)) {
          fail(`ci.jobs[${index}].result is invalid.`);
        }
      }
    }
  }

  if (typeof record.recordDigest !== "string" || !SHA256.test(record.recordDigest)) {
    fail("recordDigest is required and must be sha256 hex.");
  } else {
    const expected = computeRecordDigest(record);
    if (record.recordDigest !== expected) {
      fail("recordDigest does not match canonical body.");
    }
  }

  const requiredGates = PHASE_MANDATORY_GATE_IDS[phase] || [];
  const passGates = passedGateIds(record);
  if (qualification?.deterministic === "pass") {
    for (const gateId of requiredGates) {
      if (!passGates.has(gateId)) fail(`Missing passing mandatory gate ${gateId} for phase ${phase}.`);
    }
  }

  if (VERIFIED_STATUS_SET.has(record.status)) {
    if (source?.cleanTreeAtVerification !== true) {
      fail(`${record.status} requires source.cleanTreeAtVerification=true.`);
    }
    if (record.evidenceSystemQualification !== true) {
      fail(`${record.status} requires evidenceSystemQualification=true.`);
    }
    if (qualification?.deterministic !== "pass") {
      fail(`${record.status} requires qualification.deterministic=pass.`);
    }
    for (const [index, entry] of (record.verification || []).entries()) {
      if (entry?.outcome !== "pass") {
        fail(`Verified evidence cannot include verification[${index}] with a non-passing outcome.`);
      }
    }
    for (const [index, scenario] of (record.scenarios || []).entries()) {
      if (scenario?.outcome !== "pass") {
        fail(`Verified evidence cannot include scenarios[${index}] with a non-passing outcome.`);
      }
    }
  }

  if (record.status === "qualified") {
    if (qualification?.installedHost !== "pass" || qualification?.provider !== "pass") {
      fail("qualified requires installedHost and provider qualification to pass.");
    }
    if (!record.liveScenarios?.length
      || record.liveScenarios.some((scenario) => scenario?.outcome !== "pass")) {
      fail("qualified requires at least one passing live scenario and no skipped live scenarios.");
    }
  }

  if (record.status === "qualified"
    && (record.recordType === "worker-broker-aggregate" || phase === "aggregate")
    && qualification?.release !== "pass") {
    fail("qualified aggregate evidence requires qualification.release=pass.");
  }

  if (qualification?.installedHost === "pass") {
    if (!hasPassedBoundary(record, "installed-host")) {
      fail("installedHost qualification requires a passing installed-host command gate.");
    }
    if (!SHA256.test(installation?.sourcePluginInventoryDigest || "")
      || !SHA256.test(installation?.installedPluginInventoryDigest || "")
      || installation?.sourceAndInstalledInventoriesEqual !== true
      || !Number.isInteger(installation?.installedFileCount)
      || installation.installedFileCount < 1) {
      fail("installedHost qualification requires matching source/install digests and a positive file count.");
    }
  }

  if (qualification?.provider === "pass") {
    if (!hasPassedBoundary(record, "provider-live")) {
      fail("provider qualification requires a passing provider-live command gate.");
    }
    if (!record.runtime?.grokBuild || !record.runtime?.grokBuildRevision) {
      fail("provider qualification requires Grok version and revision identity.");
    }
  }

  if (qualification?.release === "pass") {
    if (record.releaseQualification !== true) {
      fail("qualification.release=pass requires releaseQualification=true.");
    }
    if (record.recordType !== "worker-broker-aggregate" || phase !== "aggregate") {
      fail("release qualification requires an aggregate evidence record.");
    }
    if (!hasPassedBoundary(record, "release")) {
      fail("release qualification requires a passing release command gate.");
    }
    if (!record.ci?.jobs?.length || record.ci.jobs.some((job) => job?.result !== "success")) {
      fail("release qualification requires a nonempty all-success CI job matrix.");
    }
  } else if (record.releaseQualification === true) {
    fail("releaseQualification=true requires qualification.release=pass.");
  }

  // Strict mode: bind to current non-evidence source identity when requested.
  // Evidence-only commits may advance HEAD/tree without invalidating records whose
  // sourceInventoryDigest and phaseScopeDigest still match (plan §6.4).
  if (options.strict && options.root) {
    const identity = gitIdentity(options.root);
    if (source?.cleanTreeAtVerification === true && !isNonEvidenceTreeClean(options.root)) {
      fail("Record claims clean tree but non-evidence working tree is dirty.");
    }
    const currentSourceDigest = computeInventoryDigest(options.root, { includeEvidence: false });
    const sourceDigestMatches = source?.sourceInventoryDigest
      && source.sourceInventoryDigest === currentSourceDigest;
    if (source?.sourceInventoryDigest && !sourceDigestMatches) {
      fail("sourceInventoryDigest is stale relative to current non-evidence source inventory.");
    }
    if (source?.phaseScopeDigest && record.phase != null && record.phase !== "aggregate") {
      try {
        const currentPhase = computePhaseScopeDigest(record.phase, options.root);
        if (source.phaseScopeDigest !== currentPhase) {
          fail(`phaseScopeDigest for phase ${record.phase} is stale.`);
        }
      } catch (error) {
        fail(`phaseScopeDigest for phase ${record.phase} cannot be computed: ${error.message}`);
      }
    }
    // headCommit/headTree must match HEAD, unless only evidence-only identity drifted
    // (source digests still match the current non-evidence inventory).
    if (source?.headCommit && source.headCommit !== identity.headCommit) {
      if (!sourceDigestMatches) {
        fail(`Record headCommit ${source.headCommit} does not match current HEAD ${identity.headCommit}.`);
      }
    }
    if (source?.headTree && source.headTree !== identity.headTree) {
      if (!sourceDigestMatches) {
        fail(`Record headTree ${source.headTree} does not match current tree ${identity.headTree}.`);
      }
    }

    if (VERIFIED_STATUS_SET.has(record.status)) {
      const expectedPrerequisites = PHASE_PREREQUISITES[phase] || [];
      const actualPrerequisites = new Set((record.prerequisites || []).map((item) => String(item.phase)));
      for (const prerequisitePhase of expectedPrerequisites) {
        if (!actualPrerequisites.has(prerequisitePhase)) {
          fail(`Missing prerequisite evidence digest for phase ${prerequisitePhase}.`);
        }
      }
      for (const prerequisitePhase of actualPrerequisites) {
        if (!expectedPrerequisites.includes(prerequisitePhase)) {
          fail(`Unexpected prerequisite phase ${prerequisitePhase} for phase ${phase}.`);
        }
      }
    }
  }

  if (options.rejectProvisional && record.provisionalSupportingRecord === true) {
    fail("Provisional supporting records cannot satisfy strict qualification.");
  }

  if (options.requireEvidenceSystem && record.evidenceSystemQualification !== true) {
    fail("evidenceSystemQualification must be true for this gate.");
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

  return { ok: errors.length === 0, errors };
}

export function buildEvidenceRecord({
  phase,
  slice,
  status = "implemented_unverified",
  root = REPO_ROOT,
  verification = [],
  scenarios = [],
  liveScenarios = [],
  installation = null,
  authorities = null,
  limits = null,
  pullRequest = "https://github.com/xliberty2008x/grok-plugin/pull/26",
  pluginVersion = null,
  evidenceSystemQualification = false,
  provisionalSupportingRecord = false,
  releaseQualification = false,
  qualification = null,
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
    qualification: qualification || defaultQualification(),
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

function prepareEvidenceRecordForPublication(record) {
  if (!rawEvidenceValueIsSafe(record, "$record")) throw invalidEvidencePublicationError();
  const suppliedDigest = Object.hasOwn(record, "recordDigest");
  let body;
  try {
    const detached = structuredClone(record);
    if (suppliedDigest) {
      if (!Object.hasOwn(detached, "recordDigest")
        || typeof detached.recordDigest !== "string"
        || !SHA256.test(detached.recordDigest)
        || detached.recordDigest !== computeRecordDigest(detached)) {
        throw invalidEvidencePublicationError();
      }
      body = detached;
    } else {
      body = attachRecordDigest(detached);
    }
  } catch (error) {
    if (error?.code === "E_EVIDENCE_RECORD_INVALID") throw error;
    throw invalidEvidencePublicationError();
  }
  const validated = validateEvidenceRecord(body, { strict: false });
  if (!validated.ok) throw invalidEvidencePublicationError();
  return body;
}

export function writeEvidenceRecord(record, root = REPO_ROOT) {
  // Publication validation is deliberately complete before ensureEvidenceDirectory
  // can create even the evidence root. Invalid/private caller data leaves no files.
  const body = prepareEvidenceRecordForPublication(record);
  const phase = body.phase;
  const declaredSourceDigest = body.source?.sourceInventoryDigest;
  const sourceDigest = declaredSourceDigest == null ? body.recordDigest : declaredSourceDigest;
  if (typeof sourceDigest !== "string"
    || typeof body.recordDigest !== "string"
    || !SHA256.test(sourceDigest)
    || !SHA256.test(body.recordDigest)) {
    throw invalidEvidencePublicationError();
  }
  const dir = path.join(root, EVIDENCE_ROOT, phase === "aggregate" ? "aggregate" : `phase-${phase}`);
  const file = path.join(
    dir,
    `${sourceDigest.slice(0, 16)}-${body.recordDigest.slice(0, 12)}.json`
  );
  const relativeFile = path.relative(root, file).split(path.sep).join("/");
  const serialized = `${JSON.stringify(body, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_EVIDENCE_RECORD_BYTES) {
    throw invalidEvidencePublicationError();
  }
  ensureEvidenceDirectory(root, dir);
  let existing;
  try {
    existing = readBoundedEvidenceFile(root, file);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error("Refusing an unsafe existing immutable evidence record.");
    }
  }
  if (existing !== undefined) {
    if (existing !== serialized) {
      throw new Error(`Refusing to overwrite immutable evidence record ${relativeFile}.`);
    }
    return relativeFile;
  }
  try {
    publishImmutableEvidenceFile(root, file, serialized);
  } catch (error) {
    if (error?.code === "EEXIST") {
      try {
        if (readBoundedEvidenceFile(root, file) === serialized) return relativeFile;
      } catch {}
      throw new Error("Refusing to replace a raced immutable evidence destination.");
    }
    throw error;
  }
  return relativeFile;
}

function emptyLedger() {
  return {
    schemaVersion: 1,
    roadmapVersion: ROADMAP_VERSION,
    issue: ISSUE_URL,
    updatedAt: null,
    entries: []
  };
}

function loadLedgerDocument(root = REPO_ROOT) {
  const file = path.join(root, EVIDENCE_ROOT, "ledger.json");
  try {
    const loaded = readBoundedEvidenceFileSnapshot(root, file);
    return {
      ledger: JSON.parse(loaded.contents),
      expected: {
        exists: true,
        contents: loaded.contents,
        fileSnapshot: loaded.fileSnapshot
      }
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        ledger: emptyLedger(),
        expected: { exists: false, contents: null, fileSnapshot: null }
      };
    }
    throw error;
  }
}

export function loadLedger(root = REPO_ROOT) {
  return loadLedgerDocument(root).ledger;
}

function safeLedgerString(value) {
  if (typeof value !== "string") return null;
  if (value.length > MAX_EVIDENCE_STRING_CHARS
    || redactText(value) !== value
    || PRIVATE_EVIDENCE_PATH.test(value)) return "[REDACTED]";
  return value;
}

function projectLedgerForOutput(ledger) {
  const entries = Array.isArray(ledger?.entries)
    ? ledger.entries.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      return {
        phase: safeLedgerString(entry.phase),
        slice: safeLedgerString(entry.slice),
        status: safeLedgerString(entry.status),
        path: safeLedgerString(entry.path),
        recordDigest: safeLedgerString(entry.recordDigest),
        sourceCommit: safeLedgerString(entry.sourceCommit),
        currency: safeLedgerString(entry.currency),
        recordedAt: safeLedgerString(entry.recordedAt)
      };
    })
    : [];
  return {
    schemaVersion: Number.isInteger(ledger?.schemaVersion) ? ledger.schemaVersion : null,
    roadmapVersion: safeLedgerString(ledger?.roadmapVersion),
    issue: safeLedgerString(ledger?.issue),
    updatedAt: safeLedgerString(ledger?.updatedAt),
    entries
  };
}

function normalizedLedgerEvidencePath(value) {
  if (typeof value !== "string"
    || !value
    || value.includes("\0")
    || value.includes("\\")
    || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || !value.startsWith(`${EVIDENCE_ROOT}/`)) return false;
  const relative = path.posix.relative(EVIDENCE_ROOT, value);
  return Boolean(relative
    && relative !== "."
    && relative !== ".."
    && !relative.startsWith("../")
    && !path.posix.isAbsolute(relative));
}

function ledgerEntryShapeIsValid(entry) {
  return exactFields(entry, LEDGER_ENTRY_FIELDS)
    && typeof entry.phase === "string"
    && Object.hasOwn(PHASE_MANDATORY_GATE_IDS, entry.phase)
    && typeof entry.slice === "string"
    && entry.slice.length > 0
    && STATUS_SET.has(entry.status)
    && normalizedLedgerEvidencePath(entry.path)
    && typeof entry.recordDigest === "string"
    && SHA256.test(entry.recordDigest)
    && typeof entry.sourceCommit === "string"
    && /^[0-9a-f]{40}$/.test(entry.sourceCommit)
    && LEDGER_CURRENCIES.has(entry.currency)
    && isIsoDateTime(entry.recordedAt);
}

function ledgerDocumentShapeIsValid(ledger) {
  if (!rawEvidenceValueIsSafe(ledger, "$ledger")
    || !exactFields(ledger, LEDGER_FIELDS)
    || ledger.schemaVersion !== 1
    || ledger.roadmapVersion !== ROADMAP_VERSION
    || ledger.issue !== ISSUE_URL
    || !Array.isArray(ledger.entries)
    || ledger.entries.length > MAX_EVIDENCE_ARRAY_ITEMS
    || !ledger.entries.every(ledgerEntryShapeIsValid)) return false;
  if (ledger.entries.length === 0) {
    if (ledger.updatedAt !== null) return false;
  } else if (!isIsoDateTime(ledger.updatedAt)) {
    return false;
  }
  const currentPhases = new Set();
  const currentPhaseSlices = new Set();
  for (const entry of ledger.entries) {
    if (entry.currency !== "current") continue;
    const phaseSlice = `${entry.phase}\0${entry.slice}`;
    if (currentPhases.has(entry.phase) || currentPhaseSlices.has(phaseSlice)) return false;
    currentPhases.add(entry.phase);
    currentPhaseSlices.add(phaseSlice);
  }
  return true;
}

function prepareIncomingLedgerEntry(entry) {
  if (!rawEvidenceValueIsSafe(entry, "$entry")
    || !entry
    || typeof entry !== "object"
    || Array.isArray(entry)
    || unexpectedFields(entry, LEDGER_ENTRY_FIELDS).length) {
    throw invalidLedgerUpdateError();
  }
  let detached;
  try {
    detached = structuredClone(entry);
  } catch {
    throw invalidLedgerUpdateError();
  }
  const next = {
    phase: detached.phase,
    slice: detached.slice,
    status: detached.status,
    path: detached.path,
    recordDigest: detached.recordDigest,
    sourceCommit: detached.sourceCommit,
    currency: detached.currency ?? "current",
    recordedAt: detached.recordedAt ?? new Date().toISOString()
  };
  if (!ledgerEntryShapeIsValid(next)) throw invalidLedgerUpdateError();
  return next;
}

function cloneLedgerEntry(entry) {
  return {
    phase: entry.phase,
    slice: entry.slice,
    status: entry.status,
    path: entry.path,
    recordDigest: entry.recordDigest,
    sourceCommit: entry.sourceCommit,
    currency: entry.currency,
    recordedAt: entry.recordedAt
  };
}

export function updateLedger(entry, root = REPO_ROOT) {
  // Incoming caller data is checked before lock acquisition can create the
  // evidence directory. The complete read/validate/mutate/replace transaction
  // is then serialized by the repository-local evidence lock.
  const incoming = prepareIncomingLedgerEntry(entry);
  return withEvidenceLedgerLock(root, () => {
    let loaded;
    try {
      loaded = loadLedgerDocument(root);
    } catch {
      throw invalidLedgerDocumentError();
    }
    if (!ledgerDocumentShapeIsValid(loaded.ledger)) throw invalidLedgerDocumentError();
    const entries = loaded.ledger.entries.map(cloneLedgerEntry);
    if (incoming.currency === "current") {
      for (const existing of entries) {
        if (existing.phase === incoming.phase && existing.currency === "current") {
          existing.currency = "historical";
        }
      }
    }
    entries.push(cloneLedgerEntry(incoming));
    const next = {
      schemaVersion: 1,
      roadmapVersion: ROADMAP_VERSION,
      issue: ISSUE_URL,
      updatedAt: new Date().toISOString(),
      entries
    };
    if (!ledgerDocumentShapeIsValid(next)) throw invalidLedgerUpdateError();
    const file = path.join(root, EVIDENCE_ROOT, "ledger.json");
    try {
      atomicReplaceEvidenceFile(root, file, `${JSON.stringify(next, null, 2)}\n`, loaded.expected);
    } catch {
      throw invalidLedgerDocumentError();
    }
    return next;
  });
}

export function verifyLedger(root = REPO_ROOT, {
  strict = false,
  requireComplete = false
} = {}) {
  const effectiveStrict = Boolean(strict || requireComplete);
  let ledger;
  try {
    ledger = loadLedger(root);
  } catch {
    return {
      ok: false,
      errors: ["Ledger is unreadable, unsafe, or exceeds the evidence size bound."],
      ledger: projectLedgerForOutput(null),
      readinessRequired: Boolean(requireComplete),
      readinessReady: false
    };
  }
  const publicLedger = projectLedgerForOutput(ledger);
  const errors = [];
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
    return { ok: false, errors: ["Ledger must be a JSON object."], ledger: publicLedger };
  }
  if (unexpectedFields(ledger, LEDGER_FIELDS).length) {
    errors.push("Ledger contains unsupported top-level fields.");
  }
  // Validate the raw ledger so redaction never turns a forbidden secret/path into
  // an accepted value. boundedEvidenceErrors masks unsupported key names, while
  // the returned ledger remains the allowlisted public projection above.
  for (const message of boundedEvidenceErrors(ledger, "$ledger")) errors.push(message);
  if (ledger.schemaVersion !== 1) errors.push("Ledger schemaVersion must be 1.");
  if (ledger.roadmapVersion !== ROADMAP_VERSION) {
    errors.push(`Ledger roadmapVersion must be ${ROADMAP_VERSION}.`);
  }
  if (ledger.issue !== ISSUE_URL) errors.push("Ledger issue URL must match #25.");
  if (!isIsoDateTime(ledger.updatedAt)) errors.push("Ledger updatedAt must be a valid date-time.");
  if (!Array.isArray(ledger.entries) || !ledger.entries.length) {
    errors.push("Ledger entries must be a nonempty array.");
    return { ok: false, errors, ledger: publicLedger };
  }
  if (ledger.entries.length > MAX_EVIDENCE_ARRAY_ITEMS) {
    errors.push(`Ledger exceeds ${MAX_EVIDENCE_ARRAY_ITEMS} entries.`);
  }
  const currentByPhase = new Map();
  const currentByPhaseSlice = new Set();
  const loaded = [];
  for (const [index, entry] of ledger.entries.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`Ledger entry ${index} must be an object.`);
      continue;
    }
    if (unexpectedFields(entry, LEDGER_ENTRY_FIELDS).length) {
      errors.push(`Ledger entry ${index} contains unsupported fields.`);
    }
    for (const field of [
      "phase",
      "slice",
      "status",
      "path",
      "recordDigest",
      "sourceCommit",
      "currency",
      "recordedAt"
    ]) {
      if (entry[field] === undefined || entry[field] === null || entry[field] === "") {
        errors.push(`Ledger entry ${index} is missing ${field}.`);
      }
    }
    if (typeof entry.phase !== "string"
      || !Object.hasOwn(PHASE_MANDATORY_GATE_IDS, entry.phase)) {
      errors.push(`Ledger entry ${index} has an invalid phase.`);
    }
    for (const field of ["slice", "path"]) {
      if (typeof entry[field] !== "string" || !entry[field]) {
        errors.push(`Ledger entry ${index} has an invalid ${field}.`);
      }
    }
    if (typeof entry.status !== "string" || !STATUS_SET.has(entry.status)) {
      errors.push(`Ledger entry ${index} has invalid status.`);
    }
    if (!['current', 'historical', 'invalidated'].includes(entry.currency)) {
      errors.push(`Ledger entry ${index} has invalid currency.`);
    }
    if (!SHA256.test(entry.recordDigest || "")) {
      errors.push(`Ledger entry ${index} recordDigest must be sha256 hex.`);
    }
    if (!/^[0-9a-f]{40}$/.test(entry.sourceCommit || "")) {
      errors.push(`Ledger entry ${index} sourceCommit must be a full 40-char SHA.`);
    }
    if (!isIsoDateTime(entry.recordedAt)) {
      errors.push(`Ledger entry ${index} recordedAt must be a valid date-time.`);
    }
    if (entry.currency === "current") {
      const phase = String(entry.phase);
      const phaseSlice = `${phase}\0${entry.slice}`;
      if (currentByPhase.has(phase)) {
        errors.push(`Ledger entry ${index} duplicates a current phase.`);
      } else {
        currentByPhase.set(phase, { entry, record: null });
      }
      if (currentByPhaseSlice.has(phaseSlice)) {
        errors.push(`Ledger entry ${index} duplicates a current phase/slice pair.`);
      }
      currentByPhaseSlice.add(phaseSlice);
    }
    if (typeof entry.path !== "string" || !entry.path) {
      errors.push(`Ledger entry ${index} is missing a usable path.`);
      continue;
    }
    const normalizedPath = String(entry.path).replace(/\\/g, "/");
    if (path.isAbsolute(entry.path)
      || normalizedPath.includes("../")
      || !normalizedPath.startsWith(`${EVIDENCE_ROOT}/`)) {
      errors.push(`Ledger entry ${index} has an unsafe evidence path.`);
      continue;
    }
    const absolute = path.resolve(root, entry.path);
    const evidenceRoot = path.resolve(root, EVIDENCE_ROOT);
    if (!absolute.startsWith(`${evidenceRoot}${path.sep}`)) {
      errors.push(`Ledger entry ${index} escapes the evidence root.`);
      continue;
    }
    let record;
    try {
      record = JSON.parse(readBoundedEvidenceFile(root, absolute));
    } catch {
      errors.push(`Ledger entry ${index} references an unreadable, unsafe, or oversized evidence file.`);
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      errors.push(`Ledger entry ${index} evidence record must be a JSON object.`);
      continue;
    }
    const rawSafetyErrors = boundedEvidenceErrors(record, "$record");
    if (rawSafetyErrors.length) {
      errors.push(...rawSafetyErrors.map((message) => `Ledger entry ${index}: ${message}`));
    }
    let currentRecordValidated = false;
    if (entry.currency === "current") {
      if (rawSafetyErrors.length === 0) {
        const result = validateEvidenceRecord(record, {
          strict: effectiveStrict,
          root,
          rejectProvisional: effectiveStrict && entry.status === "qualified"
        });
        if (!result.ok) {
          errors.push(...result.errors.map((message) => `Ledger entry ${index}: ${message}`));
        } else {
          currentRecordValidated = true;
        }
      }
    } else if (!SHA256.test(record.recordDigest || "")) {
      errors.push(`Ledger entry ${index}: historical recordDigest must be sha256 hex.`);
    } else if (rawSafetyErrors.length === 0 && record.recordDigest !== computeRecordDigest(record)) {
      errors.push(`Ledger entry ${index}: historical recordDigest does not match canonical body.`);
    }
    if (entry.phase !== record.phase) {
      errors.push(`Ledger entry ${index}: ledger phase does not match record phase.`);
    }
    if (entry.slice !== record.slice) {
      errors.push(`Ledger entry ${index}: ledger slice does not match record slice.`);
    }
    if (entry.status !== record.status) {
      errors.push(`Ledger entry ${index}: ledger status does not match record status.`);
    }
    if (entry.sourceCommit !== record.source?.headCommit) {
      errors.push(`Ledger entry ${index}: ledger sourceCommit does not match record source.headCommit.`);
    }
    if (entry.recordedAt !== record.recordedAt) {
      errors.push(`Ledger entry ${index}: ledger recordedAt does not match record recordedAt.`);
    }
    if (entry.recordDigest !== record.recordDigest) {
      errors.push(`Ledger entry ${index}: ledger recordDigest mismatch.`);
    }
    if (entry.currency === "current"
      && currentRecordValidated
      && currentByPhase.has(String(entry.phase))) {
      currentByPhase.get(String(entry.phase)).record = record;
      loaded.push({ index, entry, record });
    }
  }

  if (effectiveStrict) {
    for (const { index, entry, record } of loaded.filter((item) => item.entry.currency === "current")) {
      if (!VERIFIED_STATUS_SET.has(record.status)) continue;
      for (const [prerequisiteIndex, prerequisite] of (record.prerequisites || []).entries()) {
        const dependency = currentByPhase.get(String(prerequisite.phase));
        if (!dependency?.record) {
          errors.push(`Ledger entry ${index}: prerequisite ${prerequisiteIndex} has no current record.`);
          continue;
        }
        if (dependency.record.recordDigest !== prerequisite.recordDigest) {
          errors.push(`Ledger entry ${index}: prerequisite ${prerequisiteIndex} digest is stale or mismatched.`);
        }
        if (!VERIFIED_STATUS_SET.has(dependency.record.status)) {
          errors.push(`Ledger entry ${index}: prerequisite ${prerequisiteIndex} is not verified.`);
        }
        if (record.status === "qualified" && dependency.record.status !== "qualified") {
          errors.push(`Ledger entry ${index}: qualified evidence requires a qualified prerequisite.`);
        }
        const dependencyPassGates = passedGateIds(dependency.record);
        const requiredDependencyGates = PHASE_MANDATORY_GATE_IDS[String(prerequisite.phase)] || [];
        for (const gateId of requiredDependencyGates) {
          if (!prerequisite.gateIds?.includes(gateId)) {
            errors.push(`Ledger entry ${index}: prerequisite ${prerequisiteIndex} omits a mandatory gate.`);
          }
        }
        for (const gateId of prerequisite.gateIds || []) {
          if (!dependencyPassGates.has(gateId)) {
            errors.push(`Ledger entry ${index}: prerequisite ${prerequisiteIndex} references a gate not passed by its record.`);
          }
        }
      }
    }
  }
  if (requireComplete) {
    const requiredPhases = ["0", "1", "2", "3", "4", "5", "aggregate"];
    for (const phase of requiredPhases) {
      const current = currentByPhase.get(phase);
      if (!current?.record) {
        errors.push(`Release readiness requires one current evidence record for phase ${phase}.`);
        continue;
      }
      if (current.record.status !== "qualified") {
        errors.push(`Release readiness requires phase ${phase} status qualified.`);
      }
    }
    const aggregate = currentByPhase.get("aggregate")?.record;
    if (aggregate) {
      if (aggregate.qualification?.release !== "pass" || aggregate.releaseQualification !== true) {
        errors.push("Release readiness requires aggregate release qualification to pass.");
      }
      if (!aggregate.ci?.jobs?.length || aggregate.ci.jobs.some((job) => job?.result !== "success")) {
        errors.push("Release readiness requires a nonempty all-success aggregate CI matrix.");
      }
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    ledger: publicLedger,
    readinessRequired: Boolean(requireComplete),
    readinessReady: Boolean(requireComplete && errors.length === 0)
  };
}

export function verifyPhase(phase, root = REPO_ROOT, { strict = true } = {}) {
  const ledgerResult = verifyLedger(root, { strict });
  const ledger = ledgerResult.ledger;
  if (!ledgerResult.ok) {
    return { ok: false, errors: ledgerResult.errors };
  }
  const current = [...(ledger.entries || [])]
    .reverse()
    .find((entry) => String(entry.phase) === String(phase) && entry.currency === "current");
  if (!current) {
    return { ok: false, errors: [`No current ledger entry for phase ${phase}.`] };
  }
  const absolute = path.join(root, current.path);
  let record;
  try {
    record = JSON.parse(readBoundedEvidenceFile(root, absolute));
  } catch {
    return { ok: false, errors: ["Current evidence file is unreadable, unsafe, or oversized."] };
  }
  const recordResult = validateEvidenceRecord(record, { strict, root });
  return {
    ok: recordResult.ok,
    errors: recordResult.errors
  };
}

export function evidenceStatus(root = REPO_ROOT, { strict = false } = {}) {
  const verification = verifyLedger(root, { strict });
  const ledger = verification.ledger;
  const byPhase = {};
  for (const entry of ledger.entries || []) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.currency !== "current") continue;
    byPhase[entry.phase] = entry;
  }
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
