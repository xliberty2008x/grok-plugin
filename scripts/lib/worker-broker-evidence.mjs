/**
 * Worker Broker evidence inventory, capture helpers, and strict validation.
 * Pure domain functions — CLI entrypoint is scripts/worker-broker-evidence.mjs.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { redactText } from "../../plugins/grok/scripts/lib/redact.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const STATIC_ESM_IMPORT_PARSER = path.join(
  REPO_ROOT,
  "scripts/lib/static-esm-import-parser.mjs"
);
const STATIC_IMPORT_CACHE = new Map();
const MAX_STATIC_IMPORT_CACHE_ENTRIES = 1024;
const MAX_STATIC_IMPORT_BATCH_SOURCES = 512;
const MAX_STATIC_IMPORT_BATCH_BYTES = 28 * 1024 * 1024;
const MAX_STATIC_IMPORT_SOURCE_BYTES = 8 * 1024 * 1024;

export const EVIDENCE_SCHEMA_VERSION = 1;
export const ROADMAP_VERSION = "1.0";
export const ISSUE_URL = "https://github.com/xliberty2008x/grok-plugin/issues/25";
export const EVIDENCE_ROOT = "tests/e2e-results/worker-broker";
export const EVIDENCE_ONLY_PREFIXES = Object.freeze([
  `${EVIDENCE_ROOT}/`,
  "tests/e2e-results/macos-",
  "tests/e2e-results/qualification-"
]);
export const PROOF_PRODUCER_ID = "worker-broker-gate-runner";
export const PROOF_PRODUCER_VERSION = 2;
export const INDEPENDENT_REVIEW_PRODUCER_ID = "codex-native-review-runner";
export const INDEPENDENT_REVIEW_PRODUCER_VERSION = 1;
export const INDEPENDENT_REVIEW_MANIFEST_DIGEST = "82792debed04937a264e759a1812ba1e33e0417aa555f87ce13e7f5417fd6f12";
export const LIVE_RECEIPT_SCHEMA_VERSION = 1;
export const LIVE_RECEIPT_PRODUCER_ID = "worker-broker-live-receipt-runner";
export const LIVE_RECEIPT_PRODUCER_VERSION = 1;
export const LIVE_RECEIPT_AUTHORITY_SYNTHETIC = "synthetic-direct-mcp";
export const LIVE_RECEIPT_AUTHORITY_NATURAL = "natural-codex-host";
export const LIVE_RECEIPT_ROOT = `${EVIDENCE_ROOT}/live-receipts/v1`;
export const LIVE_RECEIPT_AUTHORITY_MODES = Object.freeze([
  LIVE_RECEIPT_AUTHORITY_SYNTHETIC,
  LIVE_RECEIPT_AUTHORITY_NATURAL
]);
export const LIVE_INSTALLATION_METHODS = Object.freeze([
  "codex-local-plugin-cache",
  "exact-source-plugin-install"
]);
export const LIVE_RECEIPT_CAPABILITY_TOOL_IDS = Object.freeze([
  "worker_list_owned",
  "worker_get",
  "worker_events_after",
  "worker_wait",
  "worker_result",
  "worker_spawn",
  "worker_cancel"
]);
export const LIVE_RECEIPT_NATURAL_TOOL_IDS = Object.freeze([
  "worker_list_owned",
  "worker_spawn",
  "worker_wait",
  "worker_result"
]);

function freezeLiveScenario(scenario) {
  return Object.freeze({ ...scenario });
}

// providerTerminalCount is the number of unique launched provider generations
// whose captured process group the future runner/private installed state later
// observes gone. It is never inferred from public provider-start or
// session-created events.
const LIVE_RECEIPT_SCENARIOS = Object.freeze({
  [LIVE_RECEIPT_AUTHORITY_SYNTHETIC]: Object.freeze([
    freezeLiveScenario({
      id: "authenticated-completion",
      spawnInvocationCount: 1,
      spawnReplayCount: 0,
      providerLaunchCount: 1,
      providerTerminalCount: 1,
      workerTerminalCount: 1,
      resultReadCount: 1,
      reconnectCount: 0,
      cancelInvocationCount: 0,
      cancelReplayCount: 0,
      uniqueCancelRequestCount: 0,
      cancellationEventCount: 0,
      duplicateLaunchCount: 0,
      workerHostVerification: "not_run",
      processGroupGone: true,
      taskRuntimeCleaned: true,
      runnerTemporaryArtifactsRemoved: true,
      qualificationSessionDeleted: true
    }),
    freezeLiveScenario({
      id: "mcp-restart-reconnect-cancellation",
      spawnInvocationCount: 2,
      spawnReplayCount: 1,
      providerLaunchCount: 1,
      providerTerminalCount: 1,
      workerTerminalCount: 1,
      resultReadCount: 1,
      reconnectCount: 1,
      cancelInvocationCount: 2,
      cancelReplayCount: 1,
      uniqueCancelRequestCount: 1,
      cancellationEventCount: 1,
      duplicateLaunchCount: 0,
      workerHostVerification: "not_run",
      processGroupGone: true,
      taskRuntimeCleaned: true,
      runnerTemporaryArtifactsRemoved: true,
      qualificationSessionDeleted: true
    })
  ]),
  [LIVE_RECEIPT_AUTHORITY_NATURAL]: Object.freeze([
    freezeLiveScenario({
      id: "natural-codex-installed-host",
      spawnInvocationCount: 1,
      spawnReplayCount: 0,
      providerLaunchCount: 1,
      providerTerminalCount: 1,
      workerTerminalCount: 1,
      resultReadCount: 1,
      reconnectCount: 0,
      cancelInvocationCount: 0,
      cancelReplayCount: 0,
      uniqueCancelRequestCount: 0,
      cancellationEventCount: 0,
      duplicateLaunchCount: 0,
      workerHostVerification: "not_run",
      processGroupGone: true,
      taskRuntimeCleaned: true,
      runnerTemporaryArtifactsRemoved: true,
      qualificationSessionDeleted: true
    })
  ])
});
export const LIVE_RECEIPT_SCENARIO_IDS = Object.freeze(Object.fromEntries(
  Object.entries(LIVE_RECEIPT_SCENARIOS).map(([authorityMode, scenarios]) => [
    authorityMode,
    Object.freeze(scenarios.map((scenario) => scenario.id))
  ])
));
export const LIVE_RECEIPT_AUTHORITY_CONFIG = Object.freeze({
  [LIVE_RECEIPT_AUTHORITY_SYNTHETIC]: Object.freeze({
    phase: "1",
    qualifies: Object.freeze(["provider"]),
    codexHostIdentity: false,
    observedToolIds: LIVE_RECEIPT_CAPABILITY_TOOL_IDS,
    installationMethods: LIVE_INSTALLATION_METHODS,
    scenarios: LIVE_RECEIPT_SCENARIOS[LIVE_RECEIPT_AUTHORITY_SYNTHETIC]
  }),
  [LIVE_RECEIPT_AUTHORITY_NATURAL]: Object.freeze({
    phase: "4",
    qualifies: Object.freeze(["installedHost"]),
    codexHostIdentity: true,
    observedToolIds: LIVE_RECEIPT_NATURAL_TOOL_IDS,
    installationMethods: Object.freeze(["codex-local-plugin-cache"]),
    scenarios: LIVE_RECEIPT_SCENARIOS[LIVE_RECEIPT_AUTHORITY_NATURAL]
  })
});
export const LIVE_RECEIPT_MANIFEST = Object.freeze({
  schemaVersion: LIVE_RECEIPT_SCHEMA_VERSION,
  producerId: LIVE_RECEIPT_PRODUCER_ID,
  producerVersion: LIVE_RECEIPT_PRODUCER_VERSION,
  mcpProtocolVersion: "2025-11-25",
  providerRevisionScheme: "binary-sha256-v1",
  installedEntrypoint: "mcp/server.mjs",
  authorityModes: LIVE_RECEIPT_AUTHORITY_CONFIG
});

/** Explicit phase entrypoints; repository-local static imports are derived below. */
const PHASE_SCOPE_SEEDS = freezeScopeMap({
  "0": [
    ".github/workflows/ci.yml",
    "plugins/grok/scripts/lib/redact.mjs",
    "scripts/lib/worker-broker-evidence.mjs",
    "scripts/lib/static-esm-import-parser.mjs",
    "scripts/lib/zero-skip-test-reporter.mjs",
    "scripts/check-deterministic.mjs",
    "scripts/test-deterministic.mjs",
    "scripts/worker-broker-evidence.mjs",
    "scripts/validate.mjs",
    "plugins/grok/schemas/worker-broker-evidence.schema.json",
    "plugins/grok/schemas/worker-broker-live-receipt.schema.json",
    "tests/worker-broker-evidence.test.mjs",
    "tests/helpers.mjs",
    "package.json"
  ],
  "1": [
    "plugins/grok/scripts/lib/redact.mjs",
    "plugins/grok/scripts/lib/errors.mjs",
    "plugins/grok/scripts/lib/worker-launch-contract.mjs",
    "plugins/grok/scripts/lib/host.mjs",
    "plugins/grok/scripts/lib/worker-protocol.mjs",
    "plugins/grok/scripts/lib/process-control.mjs",
    "plugins/grok/scripts/lib/provider-bootstrap.mjs",
    "plugins/grok/scripts/lib/provider-capability.mjs",
    "plugins/grok/scripts/lib/grok-provider.mjs",
    "plugins/grok/scripts/lib/worker-dispatch-supervisor.mjs",
    "plugins/grok/scripts/lib/worker-recovery.mjs",
    "plugins/grok/scripts/lib/worker-runtime.mjs",
    "plugins/grok/scripts/lib/worker-service.mjs",
    "plugins/grok/scripts/lib/worker-authority.mjs",
    "plugins/grok/scripts/lib/worker-mutation.mjs",
    "plugins/grok/scripts/lib/worker-reconcile.mjs",
    "plugins/grok/scripts/lib/recursion-guard.mjs",
    "plugins/grok/scripts/lib/worker-roles.mjs",
    "plugins/grok/scripts/lib/state.mjs",
    "plugins/grok/scripts/lib/task-contract.mjs",
    "plugins/grok/scripts/lib/workspace.mjs",
    "plugins/grok/mcp/broker.mjs",
    "plugins/grok/mcp/server.mjs",
    "plugins/grok/scripts/grok-companion.mjs",
    "plugins/grok/.codex-plugin/plugin.json",
    "plugins/grok/.mcp.json",
    "plugins/grok/provider-agents/report-repair.md",
    "plugins/grok/provider-agents/rescue-read.md",
    "plugins/grok/provider-agents/rescue-write.md",
    "plugins/grok/provider-agents/setup-probe.md",
    "plugins/grok/schemas/review-output.schema.json",
    "plugins/grok/schemas/worker-protocol.schema.json",
    "plugins/grok/schemas/worker-broker-evidence.schema.json",
    "plugins/grok/schemas/worker-broker-live-receipt.schema.json",
    "plugins/grok/skills/rescue/SKILL.md",
    "plugins/grok/skills/result/SKILL.md",
    "plugins/grok/skills/status/SKILL.md",
    "scripts/lib/zero-skip-test-reporter.mjs",
    "scripts/lib/worker-broker-evidence.mjs",
    "scripts/lib/static-esm-import-parser.mjs",
    "scripts/check-deterministic.mjs",
    "scripts/test-deterministic.mjs",
    "scripts/test-phase1-focused.mjs",
    "tests/control-plane.test.mjs",
    "tests/process-control.test.mjs",
    "tests/provider.test.mjs",
    "tests/recursion-guard.test.mjs",
    "tests/runtime.test.mjs",
    "tests/worker-mailbox.test.mjs",
    "tests/worker-protocol.test.mjs",
    "tests/worker-service.test.mjs",
    "tests/mcp-worker-broker.test.mjs",
    "tests/mcp-worker-runtime.test.mjs",
    "tests/provider-bootstrap-crash-window.test.mjs",
    "tests/provider-capability.test.mjs",
    "tests/provider-startup-cancel.test.mjs",
    "tests/worker-reconcile-safety.test.mjs",
    "tests/worker-runtime-teardown.test.mjs",
    "tests/worker-startup-crash-window.test.mjs",
    "tests/worker-launch-outbox.test.mjs",
    "tests/worker-dispatch-supervisor.test.mjs",
    "tests/worker-provider-rotation-intent.test.mjs",
    "tests/worker-recovery-fence.test.mjs",
    "tests/worker-cli-authority.test.mjs",
    "tests/worker-terminal-intent.test.mjs",
    "tests/worker-broker-evidence.test.mjs",
    "tests/process-control-owned-identity.test.mjs",
    "tests/worker-mutation.test.mjs",
    "tests/worker-safety-proofs.test.mjs",
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
    "plugins/grok/schemas/worker-broker-evidence.schema.json",
    "plugins/grok/schemas/worker-broker-live-receipt.schema.json",
    "plugins/grok/schemas/worker-protocol.schema.json",
    "scripts/lib/worker-broker-evidence.mjs",
    "tests/worker-presentation.test.mjs",
    "tests/worker-protocol.test.mjs",
    "tests/mcp-worker-broker.test.mjs",
    "tests/worker-broker-evidence.test.mjs",
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

function exactParserObject(value, keys) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
  );
}

function staticImportParserEnvironment() {
  const environment = {};
  if (process.platform === "win32") {
    for (const key of ["SYSTEMROOT", "SystemRoot", "WINDIR", "windir"]) {
      if (typeof process.env[key] === "string") environment[key] = process.env[key];
    }
  }
  return environment;
}

function rememberStaticImportSpecifiers(id, specifiers) {
  if (STATIC_IMPORT_CACHE.has(id)) STATIC_IMPORT_CACHE.delete(id);
  STATIC_IMPORT_CACHE.set(id, Object.freeze([...specifiers]));
  while (STATIC_IMPORT_CACHE.size > MAX_STATIC_IMPORT_CACHE_ENTRIES) {
    STATIC_IMPORT_CACHE.delete(STATIC_IMPORT_CACHE.keys().next().value);
  }
}

function parseStaticImportBatch(entries) {
  const input = JSON.stringify({ schemaVersion: 1, sources: entries });
  if (Buffer.byteLength(input, "utf8") > MAX_STATIC_IMPORT_BATCH_BYTES) {
    throw new Error("Static ESM parser batch exceeds its input limit.");
  }
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-vm-modules", STATIC_ESM_IMPORT_PARSER],
    {
      cwd: REPO_ROOT,
      env: staticImportParserEnvironment(),
      input,
      encoding: "utf8",
      shell: false,
      timeout: 30_000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("Static ESM dependency parsing failed.");
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error("Static ESM dependency parser returned malformed output.");
  }
  if (!exactParserObject(payload, ["schemaVersion", "results"])
    || payload.schemaVersion !== 1
    || !Array.isArray(payload.results)
    || payload.results.length !== entries.length) {
    throw new Error("Static ESM dependency parser returned malformed output.");
  }

  const expected = new Set(entries.map((entry) => entry.id));
  const observed = new Set();
  for (const entry of payload.results) {
    if (!exactParserObject(entry, ["id", "specifiers"])
      || typeof entry.id !== "string"
      || !expected.has(entry.id)
      || observed.has(entry.id)
      || !Array.isArray(entry.specifiers)
      || entry.specifiers.some((specifier) => (
        typeof specifier !== "string"
        || specifier.length > 8192
        || specifier.includes("\0")
      ))) {
      throw new Error("Static ESM dependency parser returned malformed output.");
    }
    const normalized = [...new Set(entry.specifiers)].sort();
    if (JSON.stringify(normalized) !== JSON.stringify(entry.specifiers)) {
      throw new Error("Static ESM dependency parser returned malformed output.");
    }
    observed.add(entry.id);
    rememberStaticImportSpecifiers(entry.id, normalized);
  }
  if (observed.size !== expected.size) {
    throw new Error("Static ESM dependency parser returned malformed output.");
  }
}

function parseStaticImportSources(sources) {
  if (!Array.isArray(sources)) throw new TypeError("Static ESM sources must be an array.");
  const normalized = sources.map((source) => {
    if (typeof source !== "string"
      || Buffer.byteLength(source, "utf8") > MAX_STATIC_IMPORT_SOURCE_BYTES) {
      throw new Error("Static ESM proof source is invalid or exceeds its limit.");
    }
    return { id: crypto.createHash("sha256").update(source).digest("hex"), source };
  });

  const uncached = new Map();
  for (const entry of normalized) {
    if (!STATIC_IMPORT_CACHE.has(entry.id)) uncached.set(entry.id, entry);
  }

  let batch = [];
  let batchBytes = Buffer.byteLength(JSON.stringify({ schemaVersion: 1, sources: [] }), "utf8");
  const flush = () => {
    if (!batch.length) return;
    parseStaticImportBatch(batch);
    batch = [];
    batchBytes = Buffer.byteLength(JSON.stringify({ schemaVersion: 1, sources: [] }), "utf8");
  };
  for (const entry of uncached.values()) {
    const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
    if (entryBytes >= MAX_STATIC_IMPORT_BATCH_BYTES) {
      throw new Error("Static ESM proof source cannot fit in a parser batch.");
    }
    if (batch.length >= MAX_STATIC_IMPORT_BATCH_SOURCES
      || batchBytes + entryBytes > MAX_STATIC_IMPORT_BATCH_BYTES) flush();
    batch.push(entry);
    batchBytes += entryBytes;
  }
  flush();

  return normalized.map((entry) => [...STATIC_IMPORT_CACHE.get(entry.id)]);
}

/**
 * Return non-builtin static ESM specifiers using Node's own module parser.
 *
 * The parser subprocess only constructs SourceTextModule instances; it never
 * links or evaluates the supplied source. Dynamic import, import.meta, string,
 * comment, template, regular-expression, and require forms cannot create
 * closure edges. `node:` builtins are ignored; every other static request is
 * resolved with file-URL semantics or rejected fail-closed.
 */
export function listLocalStaticImportSpecifiers(source) {
  return parseStaticImportSources([source])[0]
    .filter((specifier) => !specifier.startsWith("node:"))
    .sort();
}

function resolveLocalStaticImport(importer, specifier, root) {
  if (!(specifier.startsWith(".")
    || specifier.startsWith("/")
    || /^file:/i.test(specifier))) {
    throw new Error(`Unsupported static ESM specifier ${specifier} from ${importer}.`);
  }
  let unresolved;
  try {
    const importerUrl = pathToFileURL(path.resolve(root, importer));
    const resolvedUrl = new URL(specifier, importerUrl);
    if (resolvedUrl.protocol !== "file:") throw new Error("unsupported protocol");
    unresolved = fileURLToPath(resolvedUrl);
  } catch {
    throw new Error(`Unsupported static ESM specifier ${specifier} from ${importer}.`);
  }
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
  const relative = repositoryRelativePath(root, resolved);
  if (isEvidenceOnlyPath(relative)) {
    throw new Error(`Evidence-only paths cannot be executable static import dependencies: ${relative}.`);
  }
  return relative;
}

function localStaticImportDependencies(relatives, root) {
  const dependencies = new Map(relatives.map((relative) => [relative, []]));
  const parseable = relatives.filter((relative) => /\.(?:[cm]?js)$/i.test(relative));
  const sources = parseable.map((relative) => {
    const absolute = path.resolve(root, relative);
    repositoryRelativePath(root, absolute);
    return fs.readFileSync(absolute, "utf8");
  });
  let parsed;
  try {
    parsed = parseStaticImportSources(sources);
  } catch (error) {
    throw new Error(`Cannot parse local static imports: ${error.message}`);
  }
  for (let index = 0; index < parseable.length; index += 1) {
    const relative = parseable[index];
    dependencies.set(
      relative,
      parsed[index]
        .filter((specifier) => !specifier.startsWith("node:"))
        .map((specifier) => resolveLocalStaticImport(relative, specifier, root))
        .sort()
    );
  }
  return dependencies;
}

/**
 * Recursively close seed paths over repository-local static ESM imports.
 * Paths are normalized to repository-relative POSIX form and sorted so scope
 * manifests and their digests are deterministic across supported platforms.
 */
export function expandLocalStaticImportClosure(seedPaths, root = REPO_ROOT) {
  let pending = [...new Set(seedPaths)].sort();
  const closure = new Set();
  while (pending.length) {
    const wave = [];
    for (const candidate of pending) {
      const relative = repositoryRelativePath(root, path.resolve(root, candidate));
      if (isEvidenceOnlyPath(relative)) {
        throw new Error(`Evidence-only paths cannot seed executable phase scope: ${relative}.`);
      }
      if (closure.has(relative) || wave.includes(relative)) continue;
      if (!fs.existsSync(path.resolve(root, relative))) {
        throw new Error(`Phase scope contains missing path: ${relative}`);
      }
      closure.add(relative);
      wave.push(relative);
    }
    pending = [];
    const dependencies = localStaticImportDependencies(wave, root);
    for (const relative of wave) {
      for (const dependency of dependencies.get(relative)) {
        if (!closure.has(dependency)) pending.push(dependency);
      }
    }
    pending = [...new Set(pending)].sort();
  }
  return [...closure].sort();
}

/** Return direct local static imports omitted from an allegedly closed scope. */
export function findMissingLocalStaticImportDependencies(scopePaths, root = REPO_ROOT) {
  const declared = new Set(scopePaths);
  const missing = [];
  const dependencies = localStaticImportDependencies([...declared].sort(), root);
  for (const importer of [...declared].sort()) {
    for (const dependency of dependencies.get(importer)) {
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

function freezeGateManifest(manifest) {
  return Object.freeze(Object.fromEntries(
    Object.entries(manifest).map(([phase, gates]) => [
      phase,
      Object.freeze(gates.map((gate) => Object.freeze({
        ...gate,
        argv: Object.freeze([...gate.argv])
      })))
    ])
  ));
}

/**
 * Code-owned proof commands. CLI callers may select a supported phase, but can
 * never provide or replace an executable, argv, boundary, timeout, or outcome.
 */
export const PHASE_PROOF_GATE_MANIFEST = freezeGateManifest({
  "0": [
    {
      gateId: "repository-check",
      argv: ["node", "scripts/check-deterministic.mjs"],
      boundary: "source-provider-neutral",
      timeoutMs: 15 * 60_000
    },
    {
      gateId: "phase-0-focused-tests",
      argv: [
        "node",
        "--test",
        "--test-reporter=./scripts/lib/zero-skip-test-reporter.mjs",
        "tests/worker-broker-evidence.test.mjs"
      ],
      boundary: "focused-source-provider-neutral",
      timeoutMs: 5 * 60_000
    },
    {
      gateId: "git-diff-check",
      argv: ["git", "show", "--check", "--format=", "HEAD"],
      boundary: "source",
      timeoutMs: 60_000
    }
  ],
  "1": [
    {
      gateId: "repository-check",
      argv: ["node", "scripts/check-deterministic.mjs"],
      boundary: "source-provider-neutral",
      timeoutMs: 15 * 60_000
    },
    {
      gateId: "phase-1-focused-tests",
      argv: ["node", "scripts/test-phase1-focused.mjs"],
      boundary: "focused-source-provider-neutral",
      timeoutMs: 15 * 60_000
    },
    {
      gateId: "git-diff-check",
      argv: ["git", "show", "--check", "--format=", "HEAD"],
      boundary: "source",
      timeoutMs: 60_000
    }
  ]
});

export function computeProofManifestDigest(phase) {
  const manifest = PHASE_PROOF_GATE_MANIFEST[String(phase)];
  if (!manifest) throw new Error("No proof gate manifest exists for this phase.");
  return sha256Text(stableStringify(manifest));
}

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
  "proofProducer",
  "independentReviewReceipt",
  "qualification",
  "source",
  "installation",
  "runtime",
  "prerequisites",
  "verification",
  "scenarios",
  "liveScenarios",
  "liveQualificationReceipts",
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
const PROOF_PRODUCER_FIELDS = new Set([
  "id",
  "version",
  "manifestDigest"
]);
const INDEPENDENT_REVIEW_RECEIPT_FIELDS = new Set([
  "schemaVersion",
  "producerId",
  "producerVersion",
  "manifestDigest",
  "reviewerRuntimeDigest",
  "headCommit",
  "headTree",
  "sourceInventoryDigest",
  "phaseScopeDigest",
  "startedAt",
  "endedAt",
  "outcome",
  "unresolvedFindings",
  "receiptDigest"
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
const LIVE_QUALIFICATION_RECEIPTS_FIELDS = new Set([
  "syntheticDirectMcp",
  "naturalCodexHost"
]);
const LIVE_RECEIPT_REFERENCE_FIELDS = new Set([
  "path",
  "receiptDigest"
]);
const LIVE_RECEIPT_FIELDS = new Set([
  "schemaVersion",
  "producerId",
  "producerVersion",
  "manifestDigest",
  "authorityMode",
  "phase",
  "pluginVersion",
  "headCommit",
  "headTree",
  "sourceInventoryDigest",
  "phaseScopeDigest",
  "repositoryBeforeDigest",
  "repositoryAfterDigest",
  "sourcePluginInventoryDigest",
  "installedPluginInventoryDigest",
  "installedFileCount",
  "installedEntrypointDigest",
  "providerCapabilityDigest",
  "observedToolIds",
  "providerBinaryDigest",
  "providerVersion",
  "providerRevision",
  "mcpProtocolVersion",
  "codexBinaryDigest",
  "codexVersion",
  "codexModel",
  "hostTaskDigest",
  "installationMethod",
  "scenarios",
  "outcome",
  "startedAt",
  "endedAt",
  "receiptDigest"
]);
const LIVE_RECEIPT_SCENARIO_FIELDS = new Set([
  "id",
  "spawnInvocationCount",
  "spawnReplayCount",
  "providerLaunchCount",
  "providerTerminalCount",
  "workerTerminalCount",
  "resultReadCount",
  "reconnectCount",
  "cancelInvocationCount",
  "cancelReplayCount",
  "uniqueCancelRequestCount",
  "cancellationEventCount",
  "duplicateLaunchCount",
  "workerHostVerification",
  "processGroupGone",
  "taskRuntimeCleaned",
  "runnerTemporaryArtifactsRemoved",
  "qualificationSessionDeleted"
]);
const LIVE_RECEIPT_SCENARIO_COUNT_FIELDS = new Set([
  "spawnInvocationCount",
  "spawnReplayCount",
  "providerLaunchCount",
  "providerTerminalCount",
  "workerTerminalCount",
  "resultReadCount",
  "reconnectCount",
  "cancelInvocationCount",
  "cancelReplayCount",
  "uniqueCancelRequestCount",
  "cancellationEventCount",
  "duplicateLaunchCount"
]);
const LIVE_RECEIPT_SCENARIO_BOOLEAN_FIELDS = new Set([
  "processGroupGone",
  "taskRuntimeCleaned",
  "runnerTemporaryArtifactsRemoved",
  "qualificationSessionDeleted"
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
  ...PROOF_PRODUCER_FIELDS,
  ...INDEPENDENT_REVIEW_RECEIPT_FIELDS,
  ...SOURCE_FIELDS,
  ...INSTALLATION_FIELDS,
  ...RUNTIME_FIELDS,
  ...SCENARIO_FIELDS,
  ...LIVE_SCENARIO_FIELDS,
  ...LIVE_QUALIFICATION_RECEIPTS_FIELDS,
  ...LIVE_RECEIPT_REFERENCE_FIELDS,
  ...LIVE_RECEIPT_FIELDS,
  ...LIVE_RECEIPT_SCENARIO_FIELDS,
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

export function statusSatisfiesVerifiedPrerequisite(status, phase = null) {
  if (!VERIFIED_STATUS_SET.has(status)) return false;
  // Phase 1 promotion is deliberately unavailable until a separately
  // protected issuer can sign a review attestation and the broker can verify
  // that signature. The reserved structural receipt is caller-computable and
  // therefore cannot satisfy a downstream prerequisite.
  return String(phase ?? "") !== "1";
}

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

function invalidLiveReceiptError() {
  return fixedEvidenceError(
    "E_LIVE_RECEIPT_INVALID",
    "Live qualification receipt is invalid or unsafe."
  );
}

function invalidLiveQualificationPublicationError() {
  return fixedEvidenceError(
    "E_LIVE_QUALIFICATION_INVALID",
    "Live-qualified evidence is invalid or unsafe for publication."
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

function captureEvidencePathExistence(root, absolute) {
  const lexicalRoot = path.resolve(root);
  const lexicalAbsolute = path.resolve(absolute);
  const relative = path.relative(lexicalRoot, lexicalAbsolute);
  if (!relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw unsafeEvidenceFileError();
  }
  let canonicalRoot;
  let rootSnapshot;
  try {
    canonicalRoot = fs.realpathSync.native(lexicalRoot);
    rootSnapshot = fs.lstatSync(canonicalRoot, { bigint: true });
  } catch {
    throw unsafeEvidenceFileError();
  }
  if (!rootSnapshot.isDirectory() || rootSnapshot.isSymbolicLink()) {
    throw unsafeEvidenceFileError();
  }
  const components = relative.split(path.sep).filter(Boolean);
  const snapshots = [rootSnapshot];
  let cursor = canonicalRoot;
  for (const [index, component] of components.entries()) {
    cursor = path.join(cursor, component);
    let stat;
    try {
      stat = fs.lstatSync(cursor, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          exists: false,
          canonicalRoot,
          missingIndex: index,
          snapshots
        };
      }
      throw unsafeEvidenceFileError();
    }
    if (stat.isSymbolicLink()
      || (index < components.length - 1 && !stat.isDirectory())) {
      throw unsafeEvidenceFileError();
    }
    snapshots.push(stat);
  }
  return {
    exists: true,
    canonicalRoot,
    missingIndex: null,
    snapshots
  };
}

function evidencePathIsStablyAbsent(root, absolute) {
  const before = captureEvidencePathExistence(root, absolute);
  if (before.exists) return false;
  const after = captureEvidencePathExistence(root, absolute);
  if (after.exists
    || before.canonicalRoot !== after.canonicalRoot
    || before.missingIndex !== after.missingIndex
    || before.snapshots.length !== after.snapshots.length
    || !after.snapshots.every((stat, index) => (
      sameFileSnapshot(stat, before.snapshots[index])
    ))) {
    throw unsafeEvidenceFileError();
  }
  return true;
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

function recordCarriesLiveQualification(record) {
  const references = record?.liveQualificationReceipts;
  return Boolean(
    record?.qualification?.provider === "pass"
    || record?.qualification?.installedHost === "pass"
    || references?.syntheticDirectMcp
    || references?.naturalCodexHost
  );
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

const PROOF_TOOLCHAIN_ERROR = "E_PROOF_TOOLCHAIN";
const PROOF_PLATFORM_ERROR = "E_PROOF_PLATFORM";
let trustedGitBindingCache = null;

function proofToolchainError() {
  const error = new Error("The proof toolchain could not be resolved or its identity changed.");
  error.code = PROOF_TOOLCHAIN_ERROR;
  return error;
}

function proofPlatformError() {
  const error = new Error("The proof producer is unavailable on this platform.");
  error.code = PROOF_PLATFORM_ERROR;
  return error;
}

function assertProofProducerPlatform() {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw proofPlatformError();
  }
}

function uniqueAbsolutePaths(candidates) {
  return [...new Set(candidates.filter((candidate) => (
    typeof candidate === "string" && path.isAbsolute(candidate)
  )))];
}

function captureBoundFile(entryPath, { executable = false } = {}) {
  if (typeof entryPath !== "string" || !path.isAbsolute(entryPath)) {
    throw proofToolchainError();
  }
  const entry = path.resolve(entryPath);
  const entryStat = fs.lstatSync(entry);
  if (!entryStat.isFile() && !entryStat.isSymbolicLink()) throw proofToolchainError();
  const canonicalPath = fs.realpathSync(entry);
  if (!path.isAbsolute(canonicalPath)) throw proofToolchainError();
  const canonicalStat = fs.statSync(canonicalPath);
  if (!canonicalStat.isFile()) throw proofToolchainError();
  if (executable && process.platform !== "win32" && !(canonicalStat.mode & 0o111)) {
    throw proofToolchainError();
  }
  return Object.freeze({
    entryPath: entry,
    entryType: entryStat.isSymbolicLink() ? "symlink" : "file",
    linkTarget: entryStat.isSymbolicLink() ? fs.readlinkSync(entry) : null,
    canonicalPath,
    sha256: sha256Text(fs.readFileSync(canonicalPath)),
    size: canonicalStat.size,
    mode: canonicalStat.mode,
    device: String(canonicalStat.dev),
    inode: String(canonicalStat.ino),
    executable
  });
}

function sameBoundFileIdentity(left, right) {
  return Boolean(left && right
    && left.entryPath === right.entryPath
    && left.entryType === right.entryType
    && left.linkTarget === right.linkTarget
    && left.canonicalPath === right.canonicalPath
    && left.sha256 === right.sha256
    && left.size === right.size
    && left.mode === right.mode
    && left.device === right.device
    && left.inode === right.inode
    && left.executable === right.executable);
}

function assertBoundFileIdentity(binding) {
  let current;
  try {
    current = captureBoundFile(binding.entryPath, { executable: binding.executable });
  } catch {
    throw proofToolchainError();
  }
  if (!sameBoundFileIdentity(binding, current)) throw proofToolchainError();
}

function proofSystemDirectories() {
  if (process.platform === "win32") {
    return [
      "C:\\Windows\\System32",
      "C:\\Windows"
    ];
  }
  return ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
}

function proofEnvironmentPath(pathEntries = []) {
  return uniqueAbsolutePaths([...pathEntries, ...proofSystemDirectories()]).join(path.delimiter);
}

function baseProofEnvironment(pathEntries = [], proofHome = null) {
  const safe = {
    PATH: proofEnvironmentPath(pathEntries),
    LANG: "C",
    LC_ALL: "C",
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0"
  };
  if (proofHome) {
    safe.HOME = proofHome;
    safe.TMPDIR = proofHome;
    safe.TMP = proofHome;
    safe.TEMP = proofHome;
    safe.USERPROFILE = proofHome;
    safe.APPDATA = path.join(proofHome, "appdata");
    safe.LOCALAPPDATA = path.join(proofHome, "local-appdata");
    safe.NPM_CONFIG_USERCONFIG = path.join(proofHome, "user.npmrc");
    safe.NPM_CONFIG_GLOBALCONFIG = path.join(proofHome, "global.npmrc");
    safe.NPM_CONFIG_CACHE = path.join(proofHome, "npm-cache");
    safe.NPM_CONFIG_UPDATE_NOTIFIER = "false";
    safe.NPM_CONFIG_FUND = "false";
    safe.NPM_CONFIG_AUDIT = "false";
  }
  if (process.platform === "win32") {
    const systemRoot = "C:\\Windows";
    const comSpec = path.join(systemRoot, "System32", "cmd.exe");
    safe.SYSTEMROOT = systemRoot;
    safe.SystemRoot = systemRoot;
    safe.COMSPEC = comSpec;
    safe.ComSpec = comSpec;
    safe.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  }
  return safe;
}

function probeBoundExecutable(binding, args, { nodeBinding = null, pathEntries = [] } = {}) {
  assertBoundFileIdentity(binding);
  if (nodeBinding) assertBoundFileIdentity(nodeBinding);
  const command = nodeBinding ? nodeBinding.canonicalPath : binding.canonicalPath;
  const commandArgs = nodeBinding ? [binding.canonicalPath, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    env: baseProofEnvironment(pathEntries),
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return result.status === 0 && !result.error && !result.signal;
}

function trustedGitCandidates() {
  const sibling = path.join(
    path.dirname(process.execPath),
    process.platform === "win32" ? "git.exe" : "git"
  );
  if (process.platform === "win32") {
    return uniqueAbsolutePaths([
      sibling,
      "C:\\Program Files\\Git\\cmd\\git.exe",
      "C:\\Program Files\\Git\\bin\\git.exe",
      "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
      "C:\\Program Files (x86)\\Git\\bin\\git.exe"
    ]);
  }
  if (process.platform === "darwin") {
    return uniqueAbsolutePaths([
      sibling,
      "/opt/homebrew/bin/git",
      "/usr/local/bin/git",
      "/opt/local/bin/git",
      "/usr/bin/git",
      "/bin/git"
    ]);
  }
  return uniqueAbsolutePaths([
    sibling,
    "/usr/bin/git",
    "/bin/git",
    "/usr/local/bin/git",
    "/snap/bin/git",
    "/run/current-system/sw/bin/git",
    "/nix/var/nix/profiles/default/bin/git"
  ]);
}

function resolveTrustedGitBinding() {
  for (const candidate of trustedGitCandidates()) {
    try {
      const binding = captureBoundFile(candidate, { executable: true });
      if (probeBoundExecutable(binding, ["--version"], {
        pathEntries: [path.dirname(binding.canonicalPath)]
      })) return binding;
    } catch {
      // A fixed candidate is absent, unusable, or changed while probed.
    }
  }
  throw proofToolchainError();
}

function trustedGitBinding() {
  if (trustedGitBindingCache) {
    assertBoundFileIdentity(trustedGitBindingCache);
    return trustedGitBindingCache;
  }
  trustedGitBindingCache = resolveTrustedGitBinding();
  return trustedGitBindingCache;
}

function execTrustedGit(args, options = {}) {
  const binding = trustedGitBinding();
  assertBoundFileIdentity(binding);
  const { env: ignoredEnvironment, ...safeOptions } = options;
  void ignoredEnvironment;
  return execFileSync(binding.canonicalPath, args, {
    ...safeOptions,
    env: baseProofEnvironment([path.dirname(binding.canonicalPath)]),
    shell: false
  });
}

function resolveProofNodeBinding() {
  const binding = captureBoundFile(process.execPath, { executable: true });
  const expectedName = process.platform === "win32" ? "node.exe" : "node";
  const pathEntry = path.join(path.dirname(binding.entryPath), expectedName);
  const namedBinding = captureBoundFile(pathEntry, { executable: true });
  if (binding.canonicalPath !== namedBinding.canonicalPath
    || binding.sha256 !== namedBinding.sha256) {
    throw proofToolchainError();
  }
  if (!probeBoundExecutable(binding, ["--version"], {
    pathEntries: [path.dirname(namedBinding.entryPath)]
  })) throw proofToolchainError();
  return Object.freeze({ executable: binding, pathEntry: namedBinding });
}

function trustedPythonCandidates() {
  const sibling = path.join(
    path.dirname(process.execPath),
    process.platform === "win32" ? "python.exe" : "python3"
  );
  if (process.platform === "darwin") {
    return uniqueAbsolutePaths([
      sibling,
      "/opt/homebrew/bin/python3",
      "/usr/local/bin/python3",
      "/opt/local/bin/python3",
      "/usr/bin/python3"
    ]);
  }
  return uniqueAbsolutePaths([
    sibling,
    "/usr/bin/python3",
    "/bin/python3",
    "/usr/local/bin/python3",
    "/run/current-system/sw/bin/python3",
    "/nix/var/nix/profiles/default/bin/python3"
  ]);
}

function isShebangScript(binding) {
  try {
    const descriptor = fs.openSync(binding.canonicalPath, fs.constants.O_RDONLY);
    try {
      const prefix = Buffer.alloc(2);
      return fs.readSync(descriptor, prefix, 0, prefix.length, 0) === 2
        && prefix[0] === 0x23
        && prefix[1] === 0x21;
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return true;
  }
}

function resolveProofPythonBinding(pathEntries) {
  for (const candidate of trustedPythonCandidates()) {
    try {
      const binding = captureBoundFile(candidate, { executable: true });
      // Shell-based pyenv/asdf-style shims would add an unbound interpreter
      // behind the captured file identity. Proof production accepts only a
      // fixed native interpreter at one of the reviewed platform locations.
      if (isShebangScript(binding)) continue;
      if (probeBoundExecutable(binding, [
        "-I",
        "-S",
        "-B",
        "-c",
        "import errno,json,os,pty,subprocess,sys,threading,time"
      ], {
        // Probe under the same PATH later inherited by proof gates. The bound
        // Python itself is invoked by absolute canonical path, never via PATH.
        pathEntries
      })) return binding;
    } catch {
      // A fixed candidate is absent, unusable, lacks the POSIX PTY modules, or
      // changed while probed. Never fall back to caller-controlled PATH.
    }
  }
  throw proofToolchainError();
}

function trustedNpmLauncherCandidates(nodeBinding) {
  const nodeDirectory = path.dirname(nodeBinding.pathEntry.entryPath);
  const executableName = process.platform === "win32" ? "npm.cmd" : "npm";
  const candidates = [path.join(nodeDirectory, executableName)];
  if (process.platform === "win32") {
    candidates.push(
      "C:\\Program Files\\nodejs\\npm.cmd",
      "C:\\Program Files (x86)\\nodejs\\npm.cmd"
    );
  } else {
    candidates.push(
      "/opt/homebrew/bin/npm",
      "/usr/local/bin/npm",
      "/usr/bin/npm"
    );
  }
  return uniqueAbsolutePaths(candidates);
}

function npmCliCandidates(launcher) {
  const launcherDirectory = path.dirname(launcher.entryPath);
  const candidates = [
    launcher.canonicalPath,
    path.join(launcherDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(launcherDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(launcherDirectory, "..", "node_modules", "npm", "bin", "npm-cli.js")
  ];
  if (process.platform !== "win32") {
    candidates.push(
      "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js",
      "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
      "/usr/lib/node_modules/npm/bin/npm-cli.js"
    );
  }
  return uniqueAbsolutePaths(candidates);
}

function resolveTrustedNpmBinding(nodeBinding) {
  for (const launcherCandidate of trustedNpmLauncherCandidates(nodeBinding)) {
    let launcher;
    try {
      launcher = captureBoundFile(launcherCandidate, {
        executable: process.platform !== "win32"
      });
    } catch {
      continue;
    }
    for (const cliCandidate of npmCliCandidates(launcher)) {
      try {
        const cli = captureBoundFile(cliCandidate);
        const pathEntries = [
          path.dirname(nodeBinding.pathEntry.entryPath),
          path.dirname(launcher.entryPath)
        ];
        if (probeBoundExecutable(cli, ["--version"], {
          nodeBinding: nodeBinding.executable,
          pathEntries
        })) return Object.freeze({ launcher, cli });
      } catch {
        // Continue until a fixed launcher/CLI pair can be proven executable.
      }
    }
  }
  throw proofToolchainError();
}

function assertProofToolchainIdentity(toolchain) {
  if (!toolchain?.node?.executable
    || !toolchain?.node?.pathEntry
    || !toolchain?.npm?.launcher
    || !toolchain?.npm?.cli
    || !toolchain?.git
    || !toolchain?.python) throw proofToolchainError();
  assertBoundFileIdentity(toolchain.node.executable);
  assertBoundFileIdentity(toolchain.node.pathEntry);
  assertBoundFileIdentity(toolchain.npm.launcher);
  assertBoundFileIdentity(toolchain.npm.cli);
  assertBoundFileIdentity(toolchain.git);
  assertBoundFileIdentity(toolchain.python);
}

function proofToolchainDigest(toolchain) {
  assertProofToolchainIdentity(toolchain);
  const identity = (binding) => ({
    entryPath: binding.entryPath,
    entryType: binding.entryType,
    linkTarget: binding.linkTarget,
    canonicalPath: binding.canonicalPath,
    sha256: binding.sha256,
    size: binding.size,
    mode: binding.mode,
    device: binding.device,
    inode: binding.inode
  });
  return sha256Text(stableStringify({
    node: {
      executable: identity(toolchain.node.executable),
      pathEntry: identity(toolchain.node.pathEntry)
    },
    npm: {
      launcher: identity(toolchain.npm.launcher),
      cli: identity(toolchain.npm.cli)
    },
    git: identity(toolchain.git),
    python: identity(toolchain.python)
  }));
}

function proofTemporaryBase() {
  if (process.platform === "win32") return "C:\\Windows\\Temp";
  return "/tmp";
}

const PROOF_HOME_CLEANUP_ATTEMPTS = 5;
const PROOF_HOME_CLEANUP_RETRY_MS = 10;
const PROOF_HOME_DIRECTORY_HANDLES = new WeakMap();
const PROOF_HOME_CLEANUP_RESULTS = new WeakMap();

function processUidOrNull() {
  return typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
}

/**
 * Capture immutable identity of a newly created proof temporary home.
 * Callers must only cleanup the exact directory this identity describes.
 */
export function captureProofTemporaryHomeIdentity(proofHome) {
  assertProofProducerPlatform();
  const requested = path.resolve(proofHome);
  let canonical;
  try {
    canonical = fs.realpathSync.native(requested);
  } catch {
    canonical = fs.realpathSync(requested);
  }
  const absolute = path.resolve(canonical);
  const stat = fs.lstatSync(absolute, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Proof temporary home must be a real directory.");
  }
  const uid = processUidOrNull();
  if (uid != null && stat.uid !== uid) {
    throw new Error("Proof temporary home must be owned by the proof process.");
  }
  const identity = Object.freeze({
    path: absolute,
    realPath: absolute,
    dev: stat.dev,
    ino: stat.ino,
    uid
  });
  const noFollow = fs.constants.O_NOFOLLOW;
  const directory = fs.constants.O_DIRECTORY;
  if (!Number.isInteger(noFollow) || !Number.isInteger(directory)) {
    throw proofPlatformError();
  }
  const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow | directory);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!proofHomeStatMatchesIdentity(opened, identity)) {
      throw new Error("Proof temporary home identity changed while binding its directory handle.");
    }
    PROOF_HOME_DIRECTORY_HANDLES.set(identity, descriptor);
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
  return identity;
}

function proofHomeStatMatchesIdentity(stat, identity) {
  return Boolean(stat
    && !stat.isSymbolicLink()
    && stat.isDirectory()
    && stat.dev === identity.dev
    && stat.ino === identity.ino
    && (identity.uid == null || stat.uid === identity.uid));
}

/**
 * Re-validate that `identity.path` still names the original owned directory.
 * Returns "missing" when already gone (idempotent success), "match" when safe
 * to remove, and "mismatch" for replacement/ownership/type failures.
 */
function inspectProofTemporaryHomeIdentity(identity) {
  if (!identity
    || typeof identity.path !== "string"
    || identity.path !== path.resolve(identity.path)) {
    return { status: "mismatch" };
  }
  let stat;
  try {
    stat = fs.lstatSync(identity.path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing" };
    return { status: "mismatch" };
  }
  if (!proofHomeStatMatchesIdentity(stat, identity)) {
    return { status: "mismatch" };
  }
  const uid = processUidOrNull();
  if (uid != null && (identity.uid !== uid || stat.uid !== uid)) {
    return { status: "mismatch" };
  }
  let realPath;
  try {
    realPath = path.resolve(fs.realpathSync.native(identity.path));
  } catch {
    try {
      realPath = path.resolve(fs.realpathSync(identity.path));
    } catch (error) {
      if (error?.code === "ENOENT") return { status: "missing" };
      return { status: "mismatch" };
    }
  }
  if (realPath !== identity.realPath || realPath !== identity.path) {
    return { status: "mismatch" };
  }
  return { status: "match", stat };
}

/**
 * Fail-closed, idempotent removal of a quiescent proof temporary home.
 *
 * This is an integrity check for reviewed code-owned gates, not a same-user
 * sandbox. Every gate and descendant must be quiescent before cleanup begins,
 * and no other publisher-UID process may race the proof tree. Enforcing that
 * stronger hostile-code boundary requires a separately privileged supervisor.
 * Never throws: unproven cleanup returns `{ ok: false }` with no path/error.
 */
export function cleanupProofTemporaryHome(identity) {
  if (identity && typeof identity === "object" && PROOF_HOME_CLEANUP_RESULTS.has(identity)) {
    return { ok: PROOF_HOME_CLEANUP_RESULTS.get(identity) };
  }
  let ok = false;
  const descriptor = identity && typeof identity === "object"
    ? PROOF_HOME_DIRECTORY_HANDLES.get(identity)
    : null;
  let descriptorClosed = false;
  let witnessDescriptor = null;
  let witnessClosed = false;
  let witnessIdentity = null;
  try {
    // The immutable fields are not an authority token. Only an identity object
    // captured by this module has the no-follow root descriptor held in the
    // private WeakMap; copied or caller-forged identities must never authorize
    // pathname deletion.
    if (descriptor == null) return { ok: false };
    const initial = inspectProofTemporaryHomeIdentity(identity);
    // A missing path before this cleanup starts is not proof of deletion: a
    // gate may have renamed the original inode and left sensitive data behind.
    if (initial.status !== "match") return { ok: false };
    if (descriptor != null) {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!proofHomeStatMatchesIdentity(opened, identity) || opened.nlink === 0n) {
        return { ok: false };
      }
      // Create the deletion witness only after every gate has exited and after
      // the bound root was revalidated. Under the documented quiescent-gate
      // boundary, its link transition distinguishes removal of this tree from
      // a stale/mismatched pathname outcome.
      const witnessPath = path.join(
        identity.path,
        `.proof-cleanup-witness-${crypto.randomBytes(16).toString("hex")}`
      );
      witnessDescriptor = fs.openSync(
        witnessPath,
        fs.constants.O_CREAT
          | fs.constants.O_EXCL
          | fs.constants.O_RDWR
          | fs.constants.O_NOFOLLOW,
        0o600
      );
      witnessIdentity = fs.fstatSync(witnessDescriptor, { bigint: true });
      const witnessAtPath = fs.lstatSync(witnessPath, { bigint: true });
      const rootAfterWitness = inspectProofTemporaryHomeIdentity(identity);
      const rootHandleAfterWitness = fs.fstatSync(descriptor, { bigint: true });
      if (!witnessIdentity.isFile()
        || witnessIdentity.isSymbolicLink()
        || witnessIdentity.dev !== identity.dev
        || witnessIdentity.nlink !== 1n
        || (identity.uid != null && witnessIdentity.uid !== identity.uid)
        || !witnessAtPath.isFile()
        || witnessAtPath.isSymbolicLink()
        || witnessAtPath.dev !== witnessIdentity.dev
        || witnessAtPath.ino !== witnessIdentity.ino
        || rootAfterWitness.status !== "match"
        || !proofHomeStatMatchesIdentity(rootHandleAfterWitness, identity)) {
        return { ok: false };
      }
    }
    // Delegate recursive unlink semantics to Node core. In particular, do not
    // chmod or manually traverse gate-controlled descendants: static symlinks
    // are unlinked as links, while inaccessible trees fail before publication.
    fs.rmSync(identity.path, {
      recursive: true,
      force: false,
      maxRetries: PROOF_HOME_CLEANUP_ATTEMPTS - 1,
      retryDelay: PROOF_HOME_CLEANUP_RETRY_MS
    });
    const after = inspectProofTemporaryHomeIdentity(identity);
    if (after.status !== "missing") return { ok: false };
    if (descriptor != null) {
      const removed = fs.fstatSync(descriptor, { bigint: true });
      const removedWitness = fs.fstatSync(witnessDescriptor, { bigint: true });
      if (!proofHomeStatMatchesIdentity(removed, identity)
        || !removedWitness.isFile()
        || removedWitness.dev !== witnessIdentity.dev
        || removedWitness.ino !== witnessIdentity.ino
        || removedWitness.nlink !== 0n) {
        return { ok: false };
      }
      fs.closeSync(witnessDescriptor);
      witnessClosed = true;
      fs.closeSync(descriptor);
      descriptorClosed = true;
      PROOF_HOME_DIRECTORY_HANDLES.delete(identity);
    }
    ok = true;
    return { ok: true };
  } catch {
    return { ok: false };
  } finally {
    if (witnessDescriptor != null && !witnessClosed) {
      try { fs.closeSync(witnessDescriptor); } catch { ok = false; }
    }
    if (descriptor != null && !descriptorClosed) {
      try { fs.closeSync(descriptor); } catch { ok = false; }
      PROOF_HOME_DIRECTORY_HANDLES.delete(identity);
    }
    if (identity && typeof identity === "object") {
      PROOF_HOME_CLEANUP_RESULTS.set(identity, ok);
    }
  }
}

function createProofExecutionContext() {
  assertProofProducerPlatform();
  const node = resolveProofNodeBinding();
  const npm = resolveTrustedNpmBinding(node);
  const git = trustedGitBinding();
  const pathEntries = uniqueAbsolutePaths([
    path.dirname(node.pathEntry.entryPath),
    path.dirname(node.executable.canonicalPath),
    path.dirname(npm.launcher.entryPath),
    path.dirname(git.canonicalPath)
  ]);
  const python = resolveProofPythonBinding(pathEntries);
  const toolchain = Object.freeze({ node, npm, git, python });
  assertProofToolchainIdentity(toolchain);
  const digest = proofToolchainDigest(toolchain);
  const temporaryBase = proofTemporaryBase();
  const createdProofHome = fs.mkdtempSync(path.join(temporaryBase, "grok-worker-proof-"));
  if (process.platform !== "win32") fs.chmodSync(createdProofHome, 0o700);
  let homeIdentity;
  try {
    homeIdentity = captureProofTemporaryHomeIdentity(createdProofHome);
  } catch (error) {
    try {
      fs.rmSync(createdProofHome, { recursive: true, force: true, maxRetries: 2 });
    } catch {
      // The caller still receives only the bounded proof-toolchain failure.
    }
    throw error;
  }
  const proofHome = homeIdentity.path;
  const environment = Object.freeze({
    ...baseProofEnvironment(pathEntries, proofHome),
    // PTY tests consume the already captured and digested interpreter by
    // absolute canonical path. Keep its directory out of PATH so a same-name
    // executable beside Node, npm, or Git cannot shadow the validated binding.
    GROK_PROOF_PYTHON: python.canonicalPath
  });
  let cleaned = false;
  return {
    toolchain,
    environment,
    digest,
    homeIdentity,
    cleanup() {
      if (cleaned) return { ok: true };
      const result = cleanupProofTemporaryHome(homeIdentity);
      if (result.ok) cleaned = true;
      return result;
    }
  };
}

function proofInvocation(logical, args, context) {
  assertProofToolchainIdentity(context?.toolchain);
  if (logical === "node") {
    return { command: context.toolchain.node.executable.canonicalPath, args };
  }
  if (logical === "npm") {
    return {
      command: context.toolchain.node.executable.canonicalPath,
      args: [context.toolchain.npm.cli.canonicalPath, ...args]
    };
  }
  if (logical === "git") {
    return { command: context.toolchain.git.canonicalPath, args };
  }
  throw proofToolchainError();
}

export function isEvidenceOnlyPath(relative) {
  const normalized = String(relative || "").replace(/\\/g, "/");
  return EVIDENCE_ONLY_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

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

const MAX_LIVE_PLUGIN_FILES = 4096;
const MAX_LIVE_PLUGIN_DIRECTORIES = 512;
const MAX_LIVE_PLUGIN_DEPTH = 32;
const MAX_LIVE_PLUGIN_DIRECTORY_ENTRIES = 4096;
const MAX_LIVE_PLUGIN_FILE_BYTES = 128 * 1024 * 1024;
const MAX_LIVE_PLUGIN_TOTAL_BYTES = 512 * 1024 * 1024;

function readBoundedLiveDirectory(directory) {
  const entries = [];
  let handle;
  let failure = null;
  try {
    handle = fs.opendirSync(directory);
    while (true) {
      const entry = handle.readSync();
      if (entry === null) break;
      if (entries.length >= MAX_LIVE_PLUGIN_DIRECTORY_ENTRIES) {
        throw invalidLiveReceiptError();
      }
      entries.push(entry);
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
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Capture the portable plugin-tree inventory used by the installed-cache
 * updater. No absolute path, inode, device, timestamp, or file content leaves
 * this function; only the deterministic inventory digest/count are retained.
 */
function captureLivePluginInventory(pluginRoot) {
  const lexicalRoot = path.resolve(pluginRoot);
  let rootStat;
  let canonicalRoot;
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

  const entries = [];
  let totalBytes = 0;
  let directoryCount = 0;
  let pluginVersion = null;
  let installedEntrypointDigest = null;
  const contained = (candidate) => {
    const relative = path.relative(canonicalRoot, candidate);
    return relative === ""
      || (relative !== ".."
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative));
  };
  const visit = (directory, prefix = "", depth = 0) => {
    if (depth > MAX_LIVE_PLUGIN_DEPTH
      || directoryCount >= MAX_LIVE_PLUGIN_DIRECTORIES
      || !contained(directory)) {
      throw invalidLiveReceiptError();
    }
    directoryCount += 1;
    let directoryBefore;
    let canonicalDirectory;
    let children;
    try {
      directoryBefore = fs.lstatSync(directory, { bigint: true });
      canonicalDirectory = fs.realpathSync.native(directory);
      if (!directoryBefore.isDirectory()
        || directoryBefore.isSymbolicLink()
        || canonicalDirectory !== directory
        || !contained(canonicalDirectory)) {
        throw invalidLiveReceiptError();
      }
      children = readBoundedLiveDirectory(directory);
    } catch {
      throw invalidLiveReceiptError();
    }
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      let pathBefore;
      let canonical;
      try {
        pathBefore = fs.lstatSync(absolute, { bigint: true });
        canonical = fs.realpathSync.native(absolute);
      } catch {
        throw invalidLiveReceiptError();
      }
      if (pathBefore.isSymbolicLink()
        || canonical !== absolute
        || !contained(canonical)) {
        throw invalidLiveReceiptError();
      }
      if (pathBefore.isDirectory()) {
        visit(absolute, relative, depth + 1);
        continue;
      }
      if (!pathBefore.isFile() || entries.length >= MAX_LIVE_PLUGIN_FILES) {
        throw invalidLiveReceiptError();
      }
      const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
      let descriptor;
      try {
        descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow);
        const before = fs.fstatSync(descriptor, { bigint: true });
        if (!before.isFile()
          || before.size < 0n
          || before.size > BigInt(MAX_LIVE_PLUGIN_FILE_BYTES)
          || !sameFileSnapshot(pathBefore, before)) {
          throw invalidLiveReceiptError();
        }
        const bytes = fs.readFileSync(descriptor);
        const after = fs.fstatSync(descriptor, { bigint: true });
        const pathAfter = fs.lstatSync(absolute, { bigint: true });
        if (BigInt(bytes.byteLength) !== before.size
          || !sameFileSnapshot(before, after)
          || !sameFileSnapshot(pathBefore, pathAfter)
          || fs.realpathSync.native(absolute) !== absolute) {
          throw invalidLiveReceiptError();
        }
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_LIVE_PLUGIN_TOTAL_BYTES) throw invalidLiveReceiptError();
        const digest = crypto.createHash("sha256").update(bytes).digest("hex");
        entries.push({
          path: relative,
          mode: Number(before.mode & 0o777n),
          size: bytes.byteLength,
          sha256: digest
        });
        if (relative === ".codex-plugin/plugin.json") {
          const manifest = JSON.parse(bytes.toString("utf8"));
          if (typeof manifest?.version !== "string"
            || !LIVE_RECEIPT_RUNTIME_ID.test(manifest.version)) {
            throw invalidLiveReceiptError();
          }
          pluginVersion = manifest.version;
        }
        if (relative === LIVE_RECEIPT_MANIFEST.installedEntrypoint) {
          installedEntrypointDigest = digest;
        }
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
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
  visit(canonicalRoot);
  if (!entries.length || pluginVersion === null || installedEntrypointDigest === null) {
    throw invalidLiveReceiptError();
  }
  const rootAfter = fs.lstatSync(lexicalRoot, { bigint: true });
  if (!sameFileSnapshot(rootStat, rootAfter)
    || fs.realpathSync.native(lexicalRoot) !== canonicalRoot) {
    throw invalidLiveReceiptError();
  }
  return Object.freeze({
    fileCount: entries.length,
    digest: sha256Text(JSON.stringify(entries)),
    pluginVersion,
    installedEntrypointDigest
  });
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
    const status = execTrustedGit(["status", "--porcelain=v1", "-z"], {
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

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function computeRecordDigest(record) {
  return sha256Text(canonicalRecordBody(record));
}

export function computeIndependentReviewReceiptDigest(receipt) {
  const body = structuredClone(receipt);
  delete body.receiptDigest;
  return sha256Text(stableStringify(body));
}

export function computeLiveReceiptManifestDigest() {
  return sha256Text(stableStringify(LIVE_RECEIPT_MANIFEST));
}

export function computeLiveQualificationReceiptDigest(receipt) {
  const body = structuredClone(receipt);
  delete body.receiptDigest;
  return sha256Text(stableStringify(body));
}

export function attachIndependentReviewReceiptDigest(receipt) {
  const next = { ...receipt };
  delete next.receiptDigest;
  next.receiptDigest = computeIndependentReviewReceiptDigest(next);
  return next;
}

export function attachRecordDigest(record) {
  const next = { ...record };
  delete next.recordDigest;
  next.recordDigest = computeRecordDigest(next);
  return next;
}

const LIVE_RECEIPT_RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/;

function isCanonicalIsoDateTime(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function liveReceiptRelativePath(receipt) {
  return [
    LIVE_RECEIPT_ROOT,
    receipt.authorityMode,
    `${receipt.sourceInventoryDigest.slice(0, 16)}-${receipt.receiptDigest.slice(0, 16)}.json`
  ].join("/");
}

function fixedLiveReceiptScenarioProjection(scenarios) {
  return scenarios.map((scenario) => ({
    id: scenario.id,
    spawnInvocationCount: scenario.spawnInvocationCount,
    spawnReplayCount: scenario.spawnReplayCount,
    providerLaunchCount: scenario.providerLaunchCount,
    providerTerminalCount: scenario.providerTerminalCount,
    workerTerminalCount: scenario.workerTerminalCount,
    resultReadCount: scenario.resultReadCount,
    reconnectCount: scenario.reconnectCount,
    cancelInvocationCount: scenario.cancelInvocationCount,
    cancelReplayCount: scenario.cancelReplayCount,
    uniqueCancelRequestCount: scenario.uniqueCancelRequestCount,
    cancellationEventCount: scenario.cancellationEventCount,
    duplicateLaunchCount: scenario.duplicateLaunchCount,
    workerHostVerification: scenario.workerHostVerification,
    processGroupGone: scenario.processGroupGone,
    taskRuntimeCleaned: scenario.taskRuntimeCleaned,
    runnerTemporaryArtifactsRemoved: scenario.runnerTemporaryArtifactsRemoved,
    qualificationSessionDeleted: scenario.qualificationSessionDeleted
  }));
}

/**
 * Validate one bounded live receipt for offline repository review. This is
 * structural and source-bound integrity validation only: without a protected
 * signature or external anchor it cannot distinguish manually authored JSON
 * from runner output. No supported mint/publication API exists in this module.
 *
 * A future fixed runner must derive the cache root from verified Codex install
 * output, the stable provider capability from the setup receipt and tools/list,
 * binary identities from the files it actually launches, and natural task
 * identity from trusted Codex host events. Invocation/replay counts must come
 * from the runner and private installed state, not public provider-start or
 * session-created events. It must keep observation and private publication end
 * to end.
 */
export function validateLiveQualificationReceipt(receipt, options = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { ok: false, errors: ["Live receipt must be a JSON object."] };
  }

  let serialized;
  try {
    serialized = JSON.stringify(receipt);
  } catch {
    return { ok: false, errors: ["Live receipt is not serializable."] };
  }
  if (Buffer.byteLength(serialized) > MAX_EVIDENCE_RECORD_BYTES) {
    fail(`Live receipt exceeds ${MAX_EVIDENCE_RECORD_BYTES} serialized bytes.`);
  }
  for (const message of boundedEvidenceErrors(receipt, "$receipt")) fail(message);
  if (!exactFields(receipt, LIVE_RECEIPT_FIELDS)) {
    fail("Live receipt fields do not match the fixed v1 manifest.");
  }

  if (receipt.schemaVersion !== LIVE_RECEIPT_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${LIVE_RECEIPT_SCHEMA_VERSION}.`);
  }
  if (receipt.producerId !== LIVE_RECEIPT_PRODUCER_ID
    || receipt.producerVersion !== LIVE_RECEIPT_PRODUCER_VERSION) {
    fail("Live receipt producer identity is invalid.");
  }
  if (receipt.manifestDigest !== computeLiveReceiptManifestDigest()) {
    fail("Live receipt manifestDigest does not match the code-owned manifest.");
  }

  const config = LIVE_RECEIPT_AUTHORITY_CONFIG[receipt.authorityMode];
  if (!config) {
    fail("Live receipt authorityMode is invalid.");
  } else {
    if (receipt.phase !== config.phase) {
      fail("Live receipt phase does not match its authority mode.");
    }
    if (!config.installationMethods.includes(receipt.installationMethod)) {
      fail("Live receipt installationMethod is not allowed for its authority mode.");
    }
  }

  if (typeof receipt.pluginVersion !== "string"
    || !LIVE_RECEIPT_RUNTIME_ID.test(receipt.pluginVersion)) {
    fail("Live receipt pluginVersion is invalid.");
  }
  for (const field of ["headCommit", "headTree"]) {
    if (!/^[0-9a-f]{40}$/.test(receipt[field] || "")) {
      fail(`Live receipt ${field} must be a full 40-char SHA.`);
    }
  }
  for (const field of [
    "sourceInventoryDigest",
    "phaseScopeDigest",
    "repositoryBeforeDigest",
    "repositoryAfterDigest",
    "sourcePluginInventoryDigest",
    "installedPluginInventoryDigest",
    "installedEntrypointDigest",
    "providerCapabilityDigest",
    "providerBinaryDigest"
  ]) {
    if (!SHA256.test(receipt[field] || "")) {
      fail(`Live receipt ${field} must be sha256 hex.`);
    }
  }
  if (receipt.repositoryBeforeDigest !== receipt.sourceInventoryDigest
    || receipt.repositoryAfterDigest !== receipt.sourceInventoryDigest) {
    fail("Live receipt repository before/after digests must equal the bound source inventory.");
  }
  if (receipt.sourcePluginInventoryDigest !== receipt.installedPluginInventoryDigest) {
    fail("Live receipt source and installed plugin inventory digests differ.");
  }
  if (!Number.isInteger(receipt.installedFileCount)
    || receipt.installedFileCount < 1
    || receipt.installedFileCount > MAX_LIVE_PLUGIN_FILES) {
    fail("Live receipt installedFileCount is invalid.");
  }
  if (config
    && JSON.stringify(receipt.observedToolIds)
      !== JSON.stringify(config.observedToolIds)) {
    fail("Live receipt observedToolIds do not match the exact authority-specific operation manifest.");
  }
  for (const field of ["providerVersion", "providerRevision"]) {
    if (typeof receipt[field] !== "string"
      || !LIVE_RECEIPT_RUNTIME_ID.test(receipt[field])) {
      fail(`Live receipt ${field} is invalid.`);
    }
  }
  if (receipt.providerRevision
    !== `binary-sha256-${receipt.providerBinaryDigest}`) {
    fail("Live receipt providerRevision does not match its provider binary digest.");
  }
  if (receipt.mcpProtocolVersion !== LIVE_RECEIPT_MANIFEST.mcpProtocolVersion) {
    fail("Live receipt mcpProtocolVersion does not match the code-owned manifest.");
  }
  if (config?.codexHostIdentity) {
    if (!SHA256.test(receipt.codexBinaryDigest || "")) {
      fail("Natural live receipt codexBinaryDigest must be sha256 hex.");
    }
    if (typeof receipt.codexVersion !== "string"
      || !LIVE_RECEIPT_RUNTIME_ID.test(receipt.codexVersion)) {
      fail("Natural live receipt codexVersion is invalid.");
    }
    if (receipt.codexModel !== null
      && (typeof receipt.codexModel !== "string"
        || !LIVE_RECEIPT_RUNTIME_ID.test(receipt.codexModel))) {
      fail("Natural live receipt codexModel must be null or a bounded runtime identity.");
    }
    if (!SHA256.test(receipt.hostTaskDigest || "")) {
      fail("Natural live receipt hostTaskDigest must be sha256 hex.");
    }
  } else if (receipt.codexBinaryDigest !== null
    || receipt.codexVersion !== null
    || receipt.codexModel !== null
    || receipt.hostTaskDigest !== null) {
    fail("Synthetic direct-MCP authority cannot contain or claim Codex host identity.");
  }

  if (!Array.isArray(receipt.scenarios)) {
    fail("Live receipt scenarios must be an array.");
  } else {
    for (const [index, scenario] of receipt.scenarios.entries()) {
      if (!exactFields(scenario, LIVE_RECEIPT_SCENARIO_FIELDS)) {
        fail(`Live receipt scenarios[${index}] fields are invalid.`);
        continue;
      }
      if (typeof scenario.id !== "string" || !scenario.id) {
        fail(`Live receipt scenarios[${index}].id is invalid.`);
      }
      for (const field of LIVE_RECEIPT_SCENARIO_COUNT_FIELDS) {
        if (!Number.isInteger(scenario[field])
          || scenario[field] < 0
          || scenario[field] > 8) {
          fail(`Live receipt scenarios[${index}].${field} is invalid.`);
        }
      }
      for (const field of LIVE_RECEIPT_SCENARIO_BOOLEAN_FIELDS) {
        if (typeof scenario[field] !== "boolean") {
          fail(`Live receipt scenarios[${index}].${field} must be boolean.`);
        }
      }
      if (scenario.workerHostVerification !== "not_run") {
        fail(`Live receipt scenarios[${index}].workerHostVerification must be not_run.`);
      }
    }
    if (config && stableStringify(fixedLiveReceiptScenarioProjection(receipt.scenarios))
      !== stableStringify(config.scenarios)) {
      fail("Live receipt scenario order, lifecycle counts, or cleanup outcomes do not match the authority manifest.");
    }
  }
  if (receipt.outcome !== "pass") fail("Live receipt outcome must be pass.");
  for (const field of ["startedAt", "endedAt"]) {
    if (!isCanonicalIsoDateTime(receipt[field])) {
      fail(`Live receipt ${field} must be a canonical date-time.`);
    }
  }
  if (isCanonicalIsoDateTime(receipt.startedAt)
    && isCanonicalIsoDateTime(receipt.endedAt)
    && Date.parse(receipt.endedAt) < Date.parse(receipt.startedAt)) {
    fail("Live receipt endedAt precedes startedAt.");
  }
  if (!SHA256.test(receipt.receiptDigest || "")
    || receipt.receiptDigest !== computeLiveQualificationReceiptDigest(receipt)) {
    fail("Live receipt receiptDigest does not match its canonical body.");
  }

  if (options.strict && options.root) {
    let sourceDigestMatches = false;
    try {
      const identity = gitIdentity(options.root);
      const sourceDigest = computeInventoryDigest(options.root, { includeEvidence: false });
      sourceDigestMatches = sourceDigest === receipt.sourceInventoryDigest;
      if (!sourceDigestMatches) {
        fail("Live receipt sourceInventoryDigest is stale.");
      }
      if (!isNonEvidenceTreeClean(options.root)) {
        fail("Live receipt replay requires a clean non-evidence source tree.");
      }
      if (receipt.headCommit !== identity.headCommit && !sourceDigestMatches) {
        fail("Live receipt headCommit does not match current source.");
      }
      if (receipt.headTree !== identity.headTree && !sourceDigestMatches) {
        fail("Live receipt headTree does not match current source.");
      }
      if (config
        && computePhaseScopeDigest(config.phase, options.root) !== receipt.phaseScopeDigest) {
        fail("Live receipt phaseScopeDigest is stale.");
      }
      const sourcePlugin = captureLivePluginInventory(path.join(options.root, "plugins/grok"));
      if (sourcePlugin.digest !== receipt.sourcePluginInventoryDigest
        || sourcePlugin.fileCount !== receipt.installedFileCount) {
        fail("Live receipt source plugin inventory no longer matches its installed-artifact binding.");
      }
      if (sourcePlugin.pluginVersion !== receipt.pluginVersion) {
        fail("Live receipt pluginVersion is stale.");
      }
      if (sourcePlugin.installedEntrypointDigest !== receipt.installedEntrypointDigest) {
        fail("Live receipt installed entrypoint does not match current source.");
      }
    } catch {
      fail("Live receipt current source identity could not be verified.");
    }
  }

  return { ok: errors.length === 0, errors };
}

function loadLiveReceiptReference(reference, authorityMode, root) {
  if (!exactFields(reference, LIVE_RECEIPT_REFERENCE_FIELDS)
    || typeof reference.path !== "string"
    || !SHA256.test(reference.receiptDigest || "")) {
    throw invalidLiveQualificationPublicationError();
  }
  const prefix = `${LIVE_RECEIPT_ROOT}/${authorityMode}/`;
  if (!reference.path.startsWith(prefix)
    || reference.path.includes("\\")
    || reference.path.split("/").includes("..")) {
    throw invalidLiveQualificationPublicationError();
  }
  let receipt;
  try {
    const absolute = path.join(root, ...reference.path.split("/"));
    receipt = JSON.parse(readBoundedEvidenceFile(root, absolute));
  } catch {
    throw invalidLiveQualificationPublicationError();
  }
  const validation = validateLiveQualificationReceipt(receipt, { strict: true, root });
  if (!validation.ok
    || receipt.authorityMode !== authorityMode
    || receipt.receiptDigest !== reference.receiptDigest
    || liveReceiptRelativePath(receipt) !== reference.path) {
    throw invalidLiveQualificationPublicationError();
  }
  return receipt;
}

function receiptMatchesRecordSource(receipt, record) {
  return Boolean(receipt
    && record?.source
    && receipt.headCommit === record.source.headCommit
    && receipt.headTree === record.source.headTree
    && receipt.sourceInventoryDigest === record.source.sourceInventoryDigest);
}

function receiptsShareRuntimeIdentity(left, right) {
  return [
    "headCommit",
    "headTree",
    "sourceInventoryDigest",
    "pluginVersion",
    "sourcePluginInventoryDigest",
    "installedPluginInventoryDigest",
    "installedFileCount",
    "installedEntrypointDigest",
    "providerCapabilityDigest",
    "providerBinaryDigest",
    "providerVersion",
    "providerRevision",
    "mcpProtocolVersion"
  ].every((field) => left?.[field] === right?.[field]);
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

  const hasProofProducer = Object.hasOwn(record, "proofProducer");
  const proofProducer = record.proofProducer;
  let proofProducerValid = false;
  if (hasProofProducer) {
    if (!proofProducer || typeof proofProducer !== "object" || Array.isArray(proofProducer)) {
      fail("proofProducer must be an object when present.");
    } else {
      if (unexpectedFields(proofProducer, PROOF_PRODUCER_FIELDS).length) {
        fail("proofProducer contains unsupported fields.");
      }
      if (proofProducer.id !== PROOF_PRODUCER_ID) {
        fail("proofProducer.id is invalid.");
      }
      if (proofProducer.version !== PROOF_PRODUCER_VERSION) {
        fail("proofProducer.version is invalid.");
      }
      let expectedManifestDigest = null;
      try {
        expectedManifestDigest = computeProofManifestDigest(phase);
      } catch {
        fail(`No proof-producing gate manifest exists for phase ${phase}.`);
      }
      if (!SHA256.test(proofProducer.manifestDigest || "")) {
        fail("proofProducer.manifestDigest must be sha256 hex.");
      } else if (expectedManifestDigest && proofProducer.manifestDigest !== expectedManifestDigest) {
        fail("proofProducer.manifestDigest does not match the code-owned gate manifest.");
      }
      proofProducerValid = Boolean(
        proofProducer.id === PROOF_PRODUCER_ID
        && proofProducer.version === PROOF_PRODUCER_VERSION
        && expectedManifestDigest
        && proofProducer.manifestDigest === expectedManifestDigest
      );
    }
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

  const hasLiveQualificationReceipts = Object.hasOwn(record, "liveQualificationReceipts");
  const liveQualificationReceipts = record.liveQualificationReceipts;
  if (hasLiveQualificationReceipts) {
    if (!exactFields(liveQualificationReceipts, LIVE_QUALIFICATION_RECEIPTS_FIELDS)) {
      fail("liveQualificationReceipts must contain the exact synthetic and natural receipt slots.");
    } else {
      for (const field of LIVE_QUALIFICATION_RECEIPTS_FIELDS) {
        const reference = liveQualificationReceipts[field];
        if (reference !== null
          && !exactFields(reference, LIVE_RECEIPT_REFERENCE_FIELDS)) {
          fail(`liveQualificationReceipts.${field} must be null or an exact receipt reference.`);
          continue;
        }
        if (reference !== null) {
          if (typeof reference.path !== "string" || !reference.path) {
            fail(`liveQualificationReceipts.${field}.path is required.`);
          }
          if (!SHA256.test(reference.receiptDigest || "")) {
            fail(`liveQualificationReceipts.${field}.receiptDigest must be sha256 hex.`);
          }
        }
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

  const hasIndependentReviewReceipt = Object.hasOwn(record, "independentReviewReceipt");
  const independentReviewReceipt = record.independentReviewReceipt;
  if (hasIndependentReviewReceipt) {
    if (phase !== "1") {
      fail("independentReviewReceipt is supported only for Phase 1 evidence.");
    }
    if (!VERIFIED_STATUS_SET.has(record.status)
      || record.authorities?.independentValidation !== "pass") {
      fail("independentReviewReceipt requires a verified Phase 1 status and independentValidation=pass.");
    }
    if (!independentReviewReceipt
      || typeof independentReviewReceipt !== "object"
      || Array.isArray(independentReviewReceipt)) {
      fail("independentReviewReceipt must be an object when present.");
    } else {
      if (unexpectedFields(
        independentReviewReceipt,
        INDEPENDENT_REVIEW_RECEIPT_FIELDS
      ).length) {
        fail("independentReviewReceipt contains unsupported fields.");
      }
      if (independentReviewReceipt.schemaVersion !== 1) {
        fail("independentReviewReceipt.schemaVersion is invalid.");
      }
      if (independentReviewReceipt.producerId !== INDEPENDENT_REVIEW_PRODUCER_ID
        || independentReviewReceipt.producerVersion !== INDEPENDENT_REVIEW_PRODUCER_VERSION) {
        fail("independentReviewReceipt producer identity is invalid.");
      }
      for (const field of ["manifestDigest", "reviewerRuntimeDigest", "sourceInventoryDigest", "phaseScopeDigest"]) {
        if (!SHA256.test(independentReviewReceipt[field] || "")) {
          fail(`independentReviewReceipt.${field} must be sha256 hex.`);
        }
      }
      if (independentReviewReceipt.manifestDigest !== INDEPENDENT_REVIEW_MANIFEST_DIGEST) {
        fail("independentReviewReceipt.manifestDigest does not match the code-owned review manifest.");
      }
      for (const field of ["headCommit", "headTree"]) {
        if (!/^[0-9a-f]{40}$/.test(independentReviewReceipt[field] || "")) {
          fail(`independentReviewReceipt.${field} must be a full 40-char SHA.`);
        }
      }
      for (const field of ["startedAt", "endedAt"]) {
        if (!isIsoDateTime(independentReviewReceipt[field])) {
          fail(`independentReviewReceipt.${field} must be a valid date-time.`);
        }
      }
      if (isIsoDateTime(independentReviewReceipt.startedAt)
        && isIsoDateTime(independentReviewReceipt.endedAt)
        && Date.parse(independentReviewReceipt.endedAt) < Date.parse(independentReviewReceipt.startedAt)) {
        fail("independentReviewReceipt.endedAt precedes startedAt.");
      }
      if (independentReviewReceipt.outcome !== "pass"
        || independentReviewReceipt.unresolvedFindings !== 0) {
        fail("independentReviewReceipt must record pass with zero unresolved findings.");
      }
      if (!SHA256.test(independentReviewReceipt.receiptDigest || "")
        || independentReviewReceipt.receiptDigest
          !== computeIndependentReviewReceiptDigest(independentReviewReceipt)) {
        fail("independentReviewReceipt.receiptDigest does not match its canonical body.");
      }
      const sourceMatches = Boolean(source
        && independentReviewReceipt.headCommit === source.headCommit
        && independentReviewReceipt.headTree === source.headTree
        && independentReviewReceipt.sourceInventoryDigest === source.sourceInventoryDigest
        && independentReviewReceipt.phaseScopeDigest === source.phaseScopeDigest);
      if (!sourceMatches) {
        fail("independentReviewReceipt does not match the exact record source identity.");
      }
    }
    fail("independentReviewReceipt is reserved but unauthenticated; signed issuer verification is required.");
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

  if (proofProducerValid) {
    if (!proofProducedStatusIsCurrent(record)) {
      fail("proofProducer-backed evidence has an unsupported phase or status.");
    }
    const manifest = PHASE_PROOF_GATE_MANIFEST[phase] || [];
    if ((record.verification || []).length !== manifest.length) {
      fail("proofProducer-backed evidence requires exactly the code-owned gate manifest.");
    }
    for (const gate of manifest) {
      const entry = (record.verification || []).find((candidate) => candidate?.gateId === gate.gateId);
      if (!entry) continue;
      if (entry.command != null || JSON.stringify(entry.argv) !== JSON.stringify(gate.argv)) {
        fail(`Gate ${gate.gateId} argv does not match the code-owned proof manifest.`);
      }
      if (entry.boundary !== gate.boundary) {
        fail(`Gate ${gate.gateId} boundary does not match the code-owned proof manifest.`);
      }
    }
    if (source?.cleanTreeAtVerification !== true) {
      fail("proofProducer-backed evidence requires source.cleanTreeAtVerification=true.");
    }
    if (record.evidenceSystemQualification !== true) {
      fail("proofProducer-backed evidence requires evidenceSystemQualification=true.");
    }
    if (qualification?.deterministic !== "pass") {
      fail("proofProducer-backed evidence requires qualification.deterministic=pass.");
    }
    for (const [index, entry] of (record.verification || []).entries()) {
      if (entry?.outcome !== "pass") {
        fail(`Proof-produced evidence cannot include verification[${index}] with a non-passing outcome.`);
      }
    }
    for (const [index, scenario] of (record.scenarios || []).entries()) {
      if (scenario?.outcome !== "pass") {
        fail(`Proof-produced evidence cannot include scenarios[${index}] with a non-passing outcome.`);
      }
    }
  }

  if (VERIFIED_STATUS_SET.has(record.status)) {
    if (!proofProducerValid) {
      fail(`${record.status} requires exact broker-owned proofProducer provenance.`);
    }
    if (phase === "1") {
      fail(`${record.status} Phase 1 evidence requires signed issuer-verified independent review proof.`);
    }
  }

  const providerPassRequested = qualification?.provider === "pass";
  const installedHostPassRequested = qualification?.installedHost === "pass";
  const hasSyntheticReference = Boolean(
    exactFields(liveQualificationReceipts, LIVE_QUALIFICATION_RECEIPTS_FIELDS)
    && liveQualificationReceipts.syntheticDirectMcp !== null
  );
  const hasNaturalReference = Boolean(
    exactFields(liveQualificationReceipts, LIVE_QUALIFICATION_RECEIPTS_FIELDS)
    && liveQualificationReceipts.naturalCodexHost !== null
  );
  const hasAnyLiveReference = hasSyntheticReference || hasNaturalReference;
  let syntheticReceipt = null;
  let naturalReceipt = null;

  if (providerPassRequested || installedHostPassRequested || hasAnyLiveReference) {
    if (record.status !== "implemented_unverified") {
      fail("Live receipt/pass records must remain implemented_unverified.");
    }
    if (record.provisionalSupportingRecord !== true) {
      fail("Live receipt/pass records must be provisionalSupportingRecord=true.");
    }
    if (record.releaseQualification !== false
      || qualification?.release === "pass") {
      fail("Live receipt/pass records cannot claim release qualification.");
    }
    if (record.authorities?.hostVerification !== "not_run") {
      fail("Live receipt/pass records must preserve hostVerification=not_run.");
    }
    if (providerPassRequested && !hasSyntheticReference) {
      fail("Provider qualification requires a synthetic-direct-mcp receipt reference.");
    }
    if (!providerPassRequested && hasSyntheticReference) {
      fail("Synthetic live receipt linkage is forbidden without provider qualification pass.");
    }
    if (installedHostPassRequested && (!hasNaturalReference || !hasSyntheticReference)) {
      fail("Installed-host qualification requires both natural-host and synthetic provider receipts.");
    }
    if (!installedHostPassRequested && hasNaturalReference) {
      fail("Natural live receipt linkage is forbidden without installedHost qualification pass.");
    }
    if (providerPassRequested && !["1", "4"].includes(phase)) {
      fail("Provider live qualification may link only to Phase 1 or Phase 4.");
    }
    if (installedHostPassRequested
      && (phase !== "4" || !providerPassRequested)) {
      fail("Natural installed-host qualification may link only to Phase 4 with provider pass.");
    }
    if (phase === "1" && installedHostPassRequested) {
      fail("Synthetic Phase 1 evidence cannot claim natural installed-host authority.");
    }
    if (!(options.strict && options.root)) {
      fail("Live qualification pass/linkage requires strict offline receipt replay.");
    } else {
      try {
        if (hasSyntheticReference) {
          syntheticReceipt = loadLiveReceiptReference(
            liveQualificationReceipts.syntheticDirectMcp,
            LIVE_RECEIPT_AUTHORITY_SYNTHETIC,
            options.root
          );
        }
        if (hasNaturalReference) {
          naturalReceipt = loadLiveReceiptReference(
            liveQualificationReceipts.naturalCodexHost,
            LIVE_RECEIPT_AUTHORITY_NATURAL,
            options.root
          );
        }
      } catch {
        fail("Live qualification receipt reference is missing, unsafe, stale, or invalid.");
      }

      for (const receipt of [syntheticReceipt, naturalReceipt].filter(Boolean)) {
        if (!receiptMatchesRecordSource(receipt, record)) {
          fail("Live qualification receipt does not match the exact record source identity.");
        }
      }
      if (phase === "1"
        && syntheticReceipt
        && syntheticReceipt.phaseScopeDigest !== source?.phaseScopeDigest) {
        fail("Phase 1 live receipt does not match the record phase scope.");
      }
      if (phase === "4"
        && naturalReceipt
        && naturalReceipt.phaseScopeDigest !== source?.phaseScopeDigest) {
        fail("Phase 4 natural-host receipt does not match the record phase scope.");
      }
      if (syntheticReceipt
        && naturalReceipt
        && !receiptsShareRuntimeIdentity(syntheticReceipt, naturalReceipt)) {
        fail("Synthetic and natural live receipts do not bind the same source, install, capability, and provider.");
      }

      const installationReceipt = naturalReceipt || syntheticReceipt;
      if (installationReceipt) {
        if (installation?.method !== installationReceipt.installationMethod
          || installation?.sourcePluginInventoryDigest
            !== installationReceipt.sourcePluginInventoryDigest
          || installation?.installedPluginInventoryDigest
            !== installationReceipt.installedPluginInventoryDigest
          || installation?.installedFileCount !== installationReceipt.installedFileCount
          || installation?.sourceAndInstalledInventoriesEqual !== true
          || installation?.sourcePluginInventoryDigest
            !== installation?.installedPluginInventoryDigest) {
          fail("Evidence installation fields do not directly match the live receipt's equal inventories.");
        }
        if (record.runtime?.grokBuild !== installationReceipt.providerVersion
          || record.runtime?.grokBuildRevision !== installationReceipt.providerRevision
          || record.runtime?.mcpProtocolVersion
            !== installationReceipt.mcpProtocolVersion) {
          fail("Evidence provider runtime identity does not match the live receipt.");
        }
        if (naturalReceipt
          && ![
            record.runtime?.codexStandalone,
            record.runtime?.codexDesktopBundled
          ].includes(naturalReceipt.codexVersion)) {
          fail("Evidence Codex host version does not match the natural-host receipt.");
        }
      }

      const expectedLiveScenarios = [
        ...(syntheticReceipt
          ? LIVE_RECEIPT_SCENARIO_IDS[LIVE_RECEIPT_AUTHORITY_SYNTHETIC].map((id) => ({
            id,
            boundary: "provider-live",
            outcome: "pass"
          }))
          : []),
        ...(naturalReceipt
          ? LIVE_RECEIPT_SCENARIO_IDS[LIVE_RECEIPT_AUTHORITY_NATURAL].map((id) => ({
            id,
            boundary: "installed-host",
            outcome: "pass"
          }))
          : [])
      ];
      const actualLiveScenarios = Array.isArray(record.liveScenarios)
        ? record.liveScenarios.map((scenario) => ({
          id: scenario?.id,
          boundary: scenario?.boundary,
          outcome: scenario?.outcome,
          boundedNarrativeOnly: ["runtime", "expected", "actual"].every((field) => (
            scenario?.[field] == null
          ))
        }))
        : [];
      if (JSON.stringify(actualLiveScenarios.map((scenario) => ({
        id: scenario.id,
        boundary: scenario.boundary,
        outcome: scenario.outcome
      }))) !== JSON.stringify(expectedLiveScenarios)
        || actualLiveScenarios.some((scenario) => !scenario.boundedNarrativeOnly)) {
        fail("Evidence liveScenarios do not exactly match the linked bounded receipt scenarios.");
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
      || installation?.sourcePluginInventoryDigest
        !== installation?.installedPluginInventoryDigest
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

    if (VERIFIED_STATUS_SET.has(record.status)
      || (record.status === "implemented_unverified" && proofProducerValid)) {
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
  independentReviewReceipt = null,
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
    ...(independentReviewReceipt ? { independentReviewReceipt } : {}),
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

const PROOF_PUBLICATION_AUTHORITY = Symbol("proof-publication-authority");

function prepareEvidenceRecordForPublication(record, authority = null) {
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
  if ((VERIFIED_STATUS_SET.has(body.status)
    || Object.hasOwn(body, "proofProducer")
    || Object.hasOwn(body, "independentReviewReceipt"))
    && authority !== PROOF_PUBLICATION_AUTHORITY) {
    throw invalidEvidencePublicationError();
  }
  const hasLivePass = body.qualification?.provider === "pass"
    || body.qualification?.installedHost === "pass";
  if (hasLivePass || Object.hasOwn(body, "liveQualificationReceipts")) {
    throw invalidEvidencePublicationError();
  }
  return body;
}

function writeEvidenceRecordInternal(record, root, authority = null) {
  // Publication validation is deliberately complete before ensureEvidenceDirectory
  // can create even the evidence root. Invalid/private caller data leaves no files.
  const body = prepareEvidenceRecordForPublication(record, authority);
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

export function writeEvidenceRecord(record, root = REPO_ROOT) {
  return writeEvidenceRecordInternal(record, root, null);
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
      // Legacy/concurrency callers may reserve a ledger path before the record
      // exists. Genuinely absent paths retain that compatibility, but existing
      // bytes of any kind must parse and match the entry exactly; malformed,
      // unsafe, mismatched, provisional, or live-supporting records fail closed.
      const incomingRecord = loadCanonicalCutoverRecord(
        incoming,
        root,
        { allowMissing: true }
      );
      if (incomingRecord
        && (incomingRecord.provisionalSupportingRecord === true
          || recordCarriesLiveQualification(incomingRecord))) {
        throw invalidLedgerUpdateError();
      }
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

function loadCanonicalCutoverRecord(entry, root, { allowMissing = false } = {}) {
  if (!ledgerEntryShapeIsValid(entry) || !normalizedLedgerEvidencePath(entry.path)) {
    throw invalidLedgerDocumentError();
  }
  let absolute;
  try {
    absolute = path.resolve(root, entry.path);
    const evidenceRoot = path.resolve(root, EVIDENCE_ROOT);
    if (!absolute.startsWith(`${evidenceRoot}${path.sep}`)) {
      throw invalidLedgerDocumentError();
    }
    if (allowMissing && evidencePathIsStablyAbsent(root, absolute)) return null;
  } catch {
    throw invalidLedgerDocumentError();
  }
  let record;
  try {
    record = JSON.parse(readBoundedEvidenceFile(root, absolute));
  } catch {
    throw invalidLedgerDocumentError();
  }
  if (!record || typeof record !== "object" || Array.isArray(record)
    || !rawEvidenceValueIsSafe(record, "$record")
    || boundedEvidenceErrors(record, "$record").length
    || !SHA256.test(record.recordDigest || "")
    || record.recordDigest !== computeRecordDigest(record)
    || entry.phase !== record.phase
    || entry.slice !== record.slice
    || entry.status !== record.status
    || entry.recordDigest !== record.recordDigest
    || entry.sourceCommit !== record.source?.headCommit
    || entry.recordedAt !== record.recordedAt) {
    throw invalidLedgerDocumentError();
  }
  return record;
}

function invalidateAllCurrentLedgerEntriesUnderLock(root, loaded = null) {
  let document = loaded;
  if (!document) {
    try {
      document = loadLedgerDocument(root);
    } catch {
      throw invalidLedgerDocumentError();
    }
  }
  if (!ledgerDocumentShapeIsValid(document.ledger)) throw invalidLedgerDocumentError();
  for (const entry of document.ledger.entries) loadCanonicalCutoverRecord(entry, root);
  const entries = document.ledger.entries.map((entry) => ({
    ...cloneLedgerEntry(entry),
    currency: entry.currency === "current" ? "invalidated" : entry.currency
  }));
  if (!document.ledger.entries.some((entry) => entry.currency === "current")) return;
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
    atomicReplaceEvidenceFile(root, file, `${JSON.stringify(next, null, 2)}\n`, document.expected);
  } catch {
    throw invalidLedgerDocumentError();
  }
  const strict = verifyLedger(root, { strict: true });
  if (!strict.ok) throw invalidLedgerDocumentError();
}

function invalidateAllCurrentLedgerEntries(root) {
  return withEvidenceLedgerLock(root, () => invalidateAllCurrentLedgerEntriesUnderLock(root));
}

function prerequisiteSnapshotFromInspected(phase, inspected, root) {
  const snapshots = [];
  for (const prerequisitePhase of PHASE_PREREQUISITES[String(phase)] || []) {
    const candidates = inspected.filter(({ entry }) => (
      entry.currency === "current" && entry.phase === prerequisitePhase
    ));
    if (candidates.length !== 1) return null;
    const { record } = candidates[0];
    const validation = validateEvidenceRecord(record, {
      strict: true,
      root,
      requireEvidenceSystem: true
    });
    if (!validation.ok
      || !statusSatisfiesVerifiedPrerequisite(record.status, record.phase)) return null;
    const requiredGateIds = PHASE_MANDATORY_GATE_IDS[prerequisitePhase] || [];
    const passed = passedGateIds(record);
    if (requiredGateIds.some((gateId) => !passed.has(gateId))) return null;
    snapshots.push({
      phase: prerequisitePhase,
      recordDigest: record.recordDigest,
      gateIds: [...requiredGateIds]
    });
  }
  return snapshots;
}

function captureProofPrerequisites(phase, root) {
  const expected = PHASE_PREREQUISITES[String(phase)] || [];
  if (expected.length === 0) return [];
  const strict = verifyLedger(root, { strict: true });
  if (!strict.ok) return null;
  let loaded;
  try {
    loaded = loadLedgerDocument(root);
  } catch {
    return null;
  }
  if (!ledgerDocumentShapeIsValid(loaded.ledger)) return null;
  let inspected;
  try {
    inspected = loaded.ledger.entries.map((entry) => ({
      entry: cloneLedgerEntry(entry),
      record: loadCanonicalCutoverRecord(entry, root)
    }));
  } catch {
    return null;
  }
  return prerequisiteSnapshotFromInspected(phase, inspected, root);
}

function sameProofPrerequisites(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && JSON.stringify(left) === JSON.stringify(right);
}

function proofRecordMatchesPrerequisites(record, prerequisites) {
  return sameProofPrerequisites(record?.prerequisites, prerequisites);
}

/**
 * Return whether a current phase must yield when `replacementPhase` receives a
 * new proof identity. Phase prerequisites form a directed dependency graph;
 * replacing one node therefore supersedes both that node and every current
 * downstream claim, while unrelated current claims remain authoritative.
 *
 * Superseded records become historical, not invalidated: their immutable body
 * remains a truthful proof of the older dependency chain. The entire cutover
 * is applied in the same atomic ledger replacement as the new current record,
 * so strict readers can never observe a new prerequisite beside a dependent
 * that still names the old prerequisite digest.
 */
function phaseIsSupersededByReplacement(candidatePhase, replacementPhase, visited = new Set()) {
  const candidate = String(candidatePhase);
  const replacement = String(replacementPhase);
  if (candidate === replacement) return true;
  if (visited.has(candidate)) return false;
  visited.add(candidate);
  return (PHASE_PREREQUISITES[candidate] || []).some((prerequisite) => (
    String(prerequisite) === replacement
    || phaseIsSupersededByReplacement(prerequisite, replacement, visited)
  ));
}

function proofProducedStatusIsCurrent(record) {
  const phase = String(record?.phase ?? "");
  if (phase === "0") return record?.status === "verified_on_draft";
  if (phase === "1") {
    return record?.status === "implemented_unverified"
      || VERIFIED_STATUS_SET.has(record?.status);
  }
  return false;
}

function priorProofProducedRecordIsSafelySupersedable(record) {
  const producer = record?.proofProducer;
  const version = producer?.version;
  return Boolean(
    producer
    && typeof producer === "object"
    && !Array.isArray(producer)
    && unexpectedFields(producer, PROOF_PRODUCER_FIELDS).length === 0
    && producer.id === PROOF_PRODUCER_ID
    && Number.isInteger(version)
    && version >= 1
    && version < PROOF_PRODUCER_VERSION
    && SHA256.test(producer.manifestDigest || "")
    && ((record.phase === "0" && record.status === "verified_on_draft")
      || (record.phase === "1" && (
        record.status === "implemented_unverified"
        || VERIFIED_STATUS_SET.has(record.status)
      )))
  );
}

function supersedeCurrentProofChainEntry(entry, replacementPhase) {
  const next = cloneLedgerEntry(entry);
  if (next.currency === "current"
    && phaseIsSupersededByReplacement(next.phase, replacementPhase)) {
    next.currency = "historical";
  }
  return next;
}

/**
 * Publish the first proof-produced Phase 0 baseline. Existing immutable files
 * are retained. Only canonical pre-runner verified claims may be invalidated;
 * mixed or caller-captured current state aborts the cutover.
 */
function publishPhaseZeroProofRecord(record, root, expectedSource, toolchain) {
  if (record?.phase !== "0" || record?.status !== "verified_on_draft") {
    throw invalidEvidencePublicationError();
  }
  const validation = validateEvidenceRecord(record, {
    strict: true,
    root,
    requireEvidenceSystem: true
  });
  if (!validation.ok) throw invalidEvidencePublicationError();
  const immediatelyBeforeRecord = captureProofSourceSnapshot("0", root, toolchain);
  if (!sameProofSourceSnapshot(expectedSource, immediatelyBeforeRecord)
    || !proofRecordMatchesSnapshot(record, expectedSource)) {
    throw invalidEvidencePublicationError();
  }

  const relative = writeEvidenceRecordInternal(record, root, PROOF_PUBLICATION_AUTHORITY);
  withEvidenceLedgerLock(root, () => {
    const immediatelyBeforeLedger = captureProofSourceSnapshot("0", root, toolchain);
    if (!sameProofSourceSnapshot(expectedSource, immediatelyBeforeLedger)
      || !proofRecordMatchesSnapshot(record, expectedSource)) {
      throw invalidEvidencePublicationError();
    }

    let loaded;
    try {
      loaded = loadLedgerDocument(root);
    } catch {
      throw invalidLedgerDocumentError();
    }
    if (!ledgerDocumentShapeIsValid(loaded.ledger)) throw invalidLedgerDocumentError();

    const inspected = loaded.ledger.entries.map((entry) => ({
      entry: cloneLedgerEntry(entry),
      record: loadCanonicalCutoverRecord(entry, root)
    }));
    const current = inspected.filter(({ entry }) => entry.currency === "current");
    const legacyCurrent = current.filter(({ record: existing }) => (
      !Object.hasOwn(existing, "proofProducer") && VERIFIED_STATUS_SET.has(existing.status)
    ));
    const runnerCurrent = current.filter(({ record: existing }) => (
      Object.hasOwn(existing, "proofProducer")
      && existing.proofProducer?.version === PROOF_PRODUCER_VERSION
    ));
    const priorRunnerCurrent = current.filter(({ record: existing }) => (
      Object.hasOwn(existing, "proofProducer")
      && priorProofProducedRecordIsSafelySupersedable(existing)
    ));
    const malformedRunnerCurrent = current.filter(({ record: existing }) => (
      Object.hasOwn(existing, "proofProducer")
      && existing.proofProducer?.version !== PROOF_PRODUCER_VERSION
      && !priorProofProducedRecordIsSafelySupersedable(existing)
    ));
    const unsupportedCurrent = current.filter(({ record: existing }) => (
      !Object.hasOwn(existing, "proofProducer") && !VERIFIED_STATUS_SET.has(existing.status)
    ));
    if (unsupportedCurrent.length
      || malformedRunnerCurrent.length
      || (legacyCurrent.length && (runnerCurrent.length || priorRunnerCurrent.length))) {
      throw invalidLedgerDocumentError();
    }
    for (const { record: existing } of runnerCurrent) {
      const existingValidation = validateEvidenceRecord(existing, {
        strict: true,
        root,
        requireEvidenceSystem: true
      });
      if (!proofProducedStatusIsCurrent(existing) || !existingValidation.ok) {
        throw invalidLedgerDocumentError();
      }
    }

    const entries = inspected.map(({ entry, record: existing }) => {
      const next = cloneLedgerEntry(entry);
      if (next.currency !== "current") return next;
      if (legacyCurrent.length && !Object.hasOwn(existing, "proofProducer")) {
        next.currency = "invalidated";
      } else if (!legacyCurrent.length) {
        return supersedeCurrentProofChainEntry(next, "0");
      }
      return next;
    });
    entries.push({
      phase: record.phase,
      slice: record.slice,
      status: record.status,
      path: relative,
      recordDigest: record.recordDigest,
      sourceCommit: record.source.headCommit,
      currency: "current",
      recordedAt: record.recordedAt
    });
    const next = {
      schemaVersion: 1,
      roadmapVersion: ROADMAP_VERSION,
      issue: ISSUE_URL,
      updatedAt: new Date().toISOString(),
      entries
    };
    if (!ledgerDocumentShapeIsValid(next)) throw invalidLedgerUpdateError();
    const file = path.join(root, EVIDENCE_ROOT, "ledger.json");
    const serializedNext = `${JSON.stringify(next, null, 2)}\n`;
    try {
      atomicReplaceEvidenceFile(root, file, serializedNext, loaded.expected);
    } catch {
      throw invalidLedgerDocumentError();
    }

    let published;
    try {
      published = loadLedgerDocument(root);
    } catch {
      throw invalidLedgerDocumentError();
    }
    if (published.expected.contents !== serializedNext) throw invalidLedgerDocumentError();
    let afterLedger;
    let afterStrict;
    let finalInsideLock;
    try {
      afterLedger = captureProofSourceSnapshot("0", root, toolchain);
      afterStrict = verifyLedger(root, { strict: true });
      finalInsideLock = captureProofSourceSnapshot("0", root, toolchain);
    } catch {
      afterStrict = { ok: false };
    }
    if (!sameProofSourceSnapshot(expectedSource, afterLedger)
      || !afterStrict.ok
      || !sameProofSourceSnapshot(expectedSource, finalInsideLock)) {
      invalidateAllCurrentLedgerEntriesUnderLock(root, published);
      throw invalidEvidencePublicationError();
    }
  });

  let afterRelease;
  let strictAfterRelease;
  let finalAfterRelease;
  try {
    afterRelease = captureProofSourceSnapshot("0", root, toolchain);
    strictAfterRelease = verifyLedger(root, { strict: true });
    finalAfterRelease = captureProofSourceSnapshot("0", root, toolchain);
  } catch {
    strictAfterRelease = { ok: false };
  }
  if (!sameProofSourceSnapshot(expectedSource, afterRelease)
    || !strictAfterRelease.ok
    || !sameProofSourceSnapshot(expectedSource, finalAfterRelease)) {
    invalidateAllCurrentLedgerEntries(root);
    throw invalidEvidencePublicationError();
  }
  return relative;
}

/**
 * Publish a proof-produced dependent phase while preserving its current
 * prerequisite records. The prerequisite identity is captured before gate
 * execution and rechecked under the ledger lock, so evidence-only races cannot
 * silently retarget a proof to a different dependency.
 */
function publishDependentPhaseProofRecord(
  record,
  root,
  expectedSource,
  expectedPrerequisites,
  toolchain
) {
  const phase = String(record?.phase ?? "");
  if (phase === "0"
    || !PHASE_PROOF_GATE_MANIFEST[phase]
    || record?.status !== "implemented_unverified"
    || !proofRecordMatchesPrerequisites(record, expectedPrerequisites)) {
    throw invalidEvidencePublicationError();
  }
  const validation = validateEvidenceRecord(record, {
    strict: true,
    root,
    requireEvidenceSystem: true
  });
  if (!validation.ok) throw invalidEvidencePublicationError();
  const immediatelyBeforeRecord = captureProofSourceSnapshot(phase, root, toolchain);
  const immediatelyBeforePrerequisites = captureProofPrerequisites(phase, root);
  if (!sameProofSourceSnapshot(expectedSource, immediatelyBeforeRecord)
    || !sameProofPrerequisites(expectedPrerequisites, immediatelyBeforePrerequisites)
    || !proofRecordMatchesSnapshot(record, expectedSource)) {
    throw invalidEvidencePublicationError();
  }

  const relative = writeEvidenceRecordInternal(record, root, PROOF_PUBLICATION_AUTHORITY);
  withEvidenceLedgerLock(root, () => {
    const immediatelyBeforeLedger = captureProofSourceSnapshot(phase, root, toolchain);
    if (!sameProofSourceSnapshot(expectedSource, immediatelyBeforeLedger)
      || !proofRecordMatchesSnapshot(record, expectedSource)) {
      throw invalidEvidencePublicationError();
    }

    let loaded;
    try {
      loaded = loadLedgerDocument(root);
    } catch {
      throw invalidLedgerDocumentError();
    }
    if (!ledgerDocumentShapeIsValid(loaded.ledger)) throw invalidLedgerDocumentError();

    let inspected;
    try {
      inspected = loaded.ledger.entries.map((entry) => ({
        entry: cloneLedgerEntry(entry),
        record: loadCanonicalCutoverRecord(entry, root)
      }));
    } catch {
      throw invalidLedgerDocumentError();
    }
    const lockedPrerequisites = prerequisiteSnapshotFromInspected(phase, inspected, root);
    if (!sameProofPrerequisites(expectedPrerequisites, lockedPrerequisites)) {
      throw invalidLedgerDocumentError();
    }

    const entries = inspected.map(({ entry }) => (
      supersedeCurrentProofChainEntry(entry, phase)
    ));
    entries.push({
      phase: record.phase,
      slice: record.slice,
      status: record.status,
      path: relative,
      recordDigest: record.recordDigest,
      sourceCommit: record.source.headCommit,
      currency: "current",
      recordedAt: record.recordedAt
    });
    const next = {
      schemaVersion: 1,
      roadmapVersion: ROADMAP_VERSION,
      issue: ISSUE_URL,
      updatedAt: new Date().toISOString(),
      entries
    };
    if (!ledgerDocumentShapeIsValid(next)) throw invalidLedgerUpdateError();
    const file = path.join(root, EVIDENCE_ROOT, "ledger.json");
    const serializedNext = `${JSON.stringify(next, null, 2)}\n`;
    try {
      atomicReplaceEvidenceFile(root, file, serializedNext, loaded.expected);
    } catch {
      throw invalidLedgerDocumentError();
    }

    let published;
    try {
      published = loadLedgerDocument(root);
    } catch {
      throw invalidLedgerDocumentError();
    }
    if (published.expected.contents !== serializedNext) throw invalidLedgerDocumentError();
    let afterLedger;
    let afterStrict;
    let afterPrerequisites;
    let finalInsideLock;
    try {
      afterLedger = captureProofSourceSnapshot(phase, root, toolchain);
      afterStrict = verifyLedger(root, { strict: true });
      afterPrerequisites = captureProofPrerequisites(phase, root);
      finalInsideLock = captureProofSourceSnapshot(phase, root, toolchain);
    } catch {
      afterStrict = { ok: false };
    }
    if (!sameProofSourceSnapshot(expectedSource, afterLedger)
      || !afterStrict.ok
      || !sameProofPrerequisites(expectedPrerequisites, afterPrerequisites)
      || !sameProofSourceSnapshot(expectedSource, finalInsideLock)) {
      invalidateAllCurrentLedgerEntriesUnderLock(root, published);
      throw invalidEvidencePublicationError();
    }
  });

  let afterRelease;
  let strictAfterRelease;
  let prerequisitesAfterRelease;
  let finalAfterRelease;
  try {
    afterRelease = captureProofSourceSnapshot(phase, root, toolchain);
    strictAfterRelease = verifyLedger(root, { strict: true });
    prerequisitesAfterRelease = captureProofPrerequisites(phase, root);
    finalAfterRelease = captureProofSourceSnapshot(phase, root, toolchain);
  } catch {
    strictAfterRelease = { ok: false };
  }
  if (!sameProofSourceSnapshot(expectedSource, afterRelease)
    || !strictAfterRelease.ok
    || !sameProofPrerequisites(expectedPrerequisites, prerequisitesAfterRelease)
    || !sameProofSourceSnapshot(expectedSource, finalAfterRelease)) {
    invalidateAllCurrentLedgerEntries(root);
    throw invalidEvidencePublicationError();
  }
  return relative;
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
    const provisionalCurrent = entry.currency === "current"
      && (record.provisionalSupportingRecord === true
        || recordCarriesLiveQualification(record));
    if (provisionalCurrent) {
      errors.push(`Ledger entry ${index}: provisional/live supporting records cannot be current evidence.`);
    }
    if (entry.currency === "current") {
      if (rawSafetyErrors.length === 0 && !provisionalCurrent) {
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
      if (!VERIFIED_STATUS_SET.has(record.status)
        && !(record.status === "implemented_unverified"
          && Object.hasOwn(record, "proofProducer"))) continue;
      for (const [prerequisiteIndex, prerequisite] of (record.prerequisites || []).entries()) {
        const dependency = currentByPhase.get(String(prerequisite.phase));
        if (!dependency?.record) {
          errors.push(`Ledger entry ${index}: prerequisite ${prerequisiteIndex} has no current record.`);
          continue;
        }
        if (dependency.record.recordDigest !== prerequisite.recordDigest) {
          errors.push(`Ledger entry ${index}: prerequisite ${prerequisiteIndex} digest is stale or mismatched.`);
        }
        if (!statusSatisfiesVerifiedPrerequisite(
          dependency.record.status,
          dependency.record.phase
        )) {
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

export function verifyPhase(phase, root = REPO_ROOT, {
  strict = true,
  requireVerified = false
} = {}) {
  const phaseId = String(phase);
  const ledgerResult = verifyLedger(root, { strict });
  const ledger = ledgerResult.ledger;
  const current = [...(ledger.entries || [])]
    .reverse()
    .find((entry) => String(entry.phase) === phaseId && entry.currency === "current") || null;
  const integrityErrors = [...ledgerResult.errors];
  let record = null;

  if (ledgerResult.ok && !current) {
    integrityErrors.push(`No current ledger entry for phase ${phaseId}.`);
  } else if (ledgerResult.ok) {
    const absolute = path.join(root, current.path);
    try {
      record = JSON.parse(readBoundedEvidenceFile(root, absolute));
    } catch {
      integrityErrors.push("Current evidence file is unreadable, unsafe, or oversized.");
    }
    if (record) {
      const recordResult = validateEvidenceRecord(record, { strict, root });
      integrityErrors.push(...recordResult.errors);
    }
  }

  const integrityOk = integrityErrors.length === 0;
  const verified = Boolean(
    integrityOk
    && record
    && statusSatisfiesVerifiedPrerequisite(record.status, record.phase)
  );
  const readinessErrors = [];
  if (requireVerified && !verified) {
    if (!current) {
      readinessErrors.push(`Verified readiness requires one current evidence record for phase ${phaseId}.`);
    } else if (!integrityOk) {
      readinessErrors.push(
        `Verified readiness for phase ${phaseId} requires the current exact record to pass integrity validation.`
      );
    } else {
      readinessErrors.push(
        `Verified readiness requires phase ${phaseId} current status verified_on_draft or qualified; found ${record.status}.`
      );
    }
  }

  return {
    ok: integrityOk && readinessErrors.length === 0,
    integrityOk,
    errors: [...integrityErrors, ...readinessErrors],
    readinessErrors,
    phase: phaseId,
    slice: current?.slice ?? null,
    status: current?.status ?? null,
    recordDigest: current?.recordDigest ?? null,
    sourceCommit: current?.sourceCommit ?? null,
    verified,
    readinessRequired: Boolean(requireVerified),
    readinessReady: verified
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

export function sanitizeProofEnvironment(source = process.env, {
  pathEntries = [path.dirname(process.execPath)],
  proofHome = null
} = {}) {
  // The caller environment is deliberately ignored. In particular, PATH,
  // HOME/npm configuration, Git overrides, and shell selection are never
  // inherited into a proof command.
  void source;
  return baseProofEnvironment(pathEntries, proofHome);
}

/**
 * Bounded command observation for code-owned proof gates. It deliberately
 * returns no raw output and cannot publish evidence by itself.
 */
export function runCommandCapture(command, args, {
  cwd = REPO_ROOT,
  env = process.env,
  timeout = 120000,
  proofContext = null
} = {}) {
  const startedAt = new Date().toISOString();
  if (proofContext) assertProofToolchainIdentity(proofContext.toolchain);
  const result = spawnSync(command, args, {
    cwd,
    env: proofContext?.environment || sanitizeProofEnvironment(env),
    encoding: "utf8",
    shell: false,
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const endedAt = new Date().toISOString();
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const redactedOutput = redactText(output);
  const secretOutputDetected = redactedOutput !== output;
  let failureKind = null;
  if (secretOutputDetected) failureKind = "secret_output";
  else if (result.error?.code === "ETIMEDOUT") failureKind = "timeout";
  else if (result.error?.code === "ENOBUFS") failureKind = "output_limit";
  else if (result.error) failureKind = "spawn_error";
  else if (result.signal) failureKind = "signal";
  else if (!Number.isInteger(result.status) || result.status !== 0) failureKind = "nonzero_exit";
  return {
    startedAt,
    endedAt,
    exitCode: Number.isInteger(result.status) ? result.status : null,
    outputDigest: sha256Text(redactedOutput),
    outcome: failureKind == null ? "pass" : "fail",
    failureKind,
    secretOutputDetected
  };
}

function captureProofSourceSnapshot(phase, root, toolchain) {
  const toolchainDigest = proofToolchainDigest(toolchain);
  const identity = gitIdentity(root);
  return {
    ...identity,
    sourceInventoryDigest: computeInventoryDigest(root, { includeEvidence: false }),
    phaseScopeDigest: computePhaseScopeDigest(phase, root),
    phaseScopeFileIdentityDigest: proofScopeFileIdentityDigest(phase, root),
    toolchainDigest
  };
}

function proofScopeFileIdentityDigest(phase, root) {
  const scope = PHASE_SCOPE[String(phase)];
  if (!scope?.length) throw new Error("Proof phase scope is unavailable.");
  const realRoot = fs.realpathSync(root);
  const identities = scope.map((relative) => {
    const expected = path.resolve(realRoot, relative);
    const actual = fs.realpathSync(path.resolve(root, relative));
    if (actual !== expected) {
      throw new Error(`Proof phase scope path resolves through a symlink: ${relative}`);
    }
    const stat = fs.lstatSync(actual, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Proof phase scope path is not a regular file: ${relative}`);
    }
    return {
      path: relative,
      dev: String(stat.dev),
      ino: String(stat.ino),
      mode: String(stat.mode),
      size: String(stat.size),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs)
    };
  });
  return sha256Text(stableStringify(identities));
}

function sameProofSourceSnapshot(left, right) {
  return Boolean(left && right
    && left.headCommit === right.headCommit
    && left.headTree === right.headTree
    && left.cleanTreeAtVerification === true
    && right.cleanTreeAtVerification === true
    && left.sourceInventoryDigest === right.sourceInventoryDigest
    && left.phaseScopeDigest === right.phaseScopeDigest
    && left.phaseScopeFileIdentityDigest === right.phaseScopeFileIdentityDigest
    && left.toolchainDigest === right.toolchainDigest);
}

function proofFailure(code, extras = {}) {
  return { ok: false, code, ...extras };
}

function proofFailureForError(error, fallback) {
  if (error?.code === PROOF_TOOLCHAIN_ERROR || error?.code === PROOF_PLATFORM_ERROR) {
    return proofFailure(error.code);
  }
  return proofFailure(fallback);
}

function proofRecordMatchesSnapshot(record, snapshot) {
  return Boolean(record?.source
    && record.source.headCommit === snapshot.headCommit
    && record.source.headTree === snapshot.headTree
    && record.source.cleanTreeAtVerification === true
    && record.source.sourceInventoryDigest === snapshot.sourceInventoryDigest
    && record.source.phaseScopeDigest === snapshot.phaseScopeDigest);
}

export function proveWorkerBrokerPhase(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || unexpectedFields(options, new Set(["phase", "slice", "root", "write"])).length) {
    return proofFailure("E_PROOF_ARGUMENT");
  }
  const {
    phase: requestedPhase = "0",
    slice,
    root = REPO_ROOT,
    write = false
  } = options;
  const phase = String(requestedPhase);
  const validSlug = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slice || "");
  const supportedSelection = (phase === "0" && validSlug)
    || (phase === "1" && slice === "worker-api");
  if (!supportedSelection || typeof root !== "string" || !root || typeof write !== "boolean") {
    return proofFailure("E_PROOF_ARGUMENT");
  }
  let proofContext;
  try {
    proofContext = createProofExecutionContext();
  } catch (error) {
    return proofFailureForError(error, PROOF_TOOLCHAIN_ERROR);
  }
  let result;
  try {
    result = proveWorkerBrokerPhaseWithContext({ phase, slice, root, write }, proofContext);
  } catch (error) {
    result = proofFailureForError(error, "E_PROOF_SOURCE");
  }
  // Always finish temporary-home cleanup before returning. Cleanup is idempotent
  // when the success path already cleaned before publication. Never let a raw
  // cleanup exception escape or overwrite a structured result with a throw.
  let cleaned;
  try {
    cleaned = proofContext.cleanup();
  } catch {
    cleaned = { ok: false };
  }
  if (!cleaned?.ok) return proofFailure("E_PROOF_CLEANUP");
  return result;
}

function proveWorkerBrokerPhaseWithContext({ phase, slice, root, write }, proofContext) {
  const manifest = PHASE_PROOF_GATE_MANIFEST[phase];
  let initial;
  try {
    initial = captureProofSourceSnapshot(phase, root, proofContext.toolchain);
  } catch (error) {
    return proofFailureForError(error, "E_PROOF_SOURCE");
  }
  if (initial.cleanTreeAtVerification !== true) return proofFailure("E_PROOF_SOURCE_DIRTY");
  const initialPrerequisites = captureProofPrerequisites(phase, root);
  if (initialPrerequisites == null) return proofFailure("E_PROOF_PREREQUISITE");

  const verification = [];
  for (const gate of manifest) {
    let beforeGate;
    try {
      beforeGate = captureProofSourceSnapshot(phase, root, proofContext.toolchain);
    } catch (error) {
      return proofFailureForError(error, "E_PROOF_SOURCE");
    }
    if (!sameProofSourceSnapshot(initial, beforeGate)) {
      return proofFailure("E_PROOF_SOURCE_DRIFT");
    }
    const [logicalExecutable, ...args] = gate.argv;
    let observed;
    try {
      const invocation = proofInvocation(logicalExecutable, args, proofContext);
      observed = runCommandCapture(invocation.command, invocation.args, {
        cwd: root,
        timeout: gate.timeoutMs,
        proofContext
      });
      assertProofToolchainIdentity(proofContext.toolchain);
    } catch (error) {
      return proofFailureForError(error, PROOF_TOOLCHAIN_ERROR);
    }
    if (observed.outcome !== "pass" || observed.exitCode !== 0) {
      return proofFailure("E_PROOF_GATE", {
        gateId: gate.gateId,
        failureKind: observed.failureKind,
        outputDigest: observed.outputDigest
      });
    }
    verification.push({
      gateId: gate.gateId,
      argv: [...gate.argv],
      boundary: gate.boundary,
      outcome: "pass",
      startedAt: observed.startedAt,
      endedAt: observed.endedAt,
      exitCode: 0,
      outputDigest: observed.outputDigest,
      assertions: [
        "code-owned manifest gate exited successfully",
        "output was bounded and redacted before digest"
      ]
    });
  }

  let afterGates;
  try {
    afterGates = captureProofSourceSnapshot(phase, root, proofContext.toolchain);
  } catch (error) {
    return proofFailureForError(error, "E_PROOF_SOURCE");
  }
  if (!sameProofSourceSnapshot(initial, afterGates)) return proofFailure("E_PROOF_SOURCE_DRIFT");
  const afterGatePrerequisites = captureProofPrerequisites(phase, root);
  if (afterGatePrerequisites == null) return proofFailure("E_PROOF_PREREQUISITE");
  if (!sameProofPrerequisites(initialPrerequisites, afterGatePrerequisites)) {
    return proofFailure("E_PROOF_PREREQUISITE_DRIFT");
  }

  let record = buildEvidenceRecord({
    root,
    phase,
    slice,
    status: phase === "1" ? "implemented_unverified" : "verified_on_draft",
    prerequisites: initialPrerequisites,
    verification,
    scenarios: [{
      id: `phase-${phase}-proof-runner`,
      boundary: "deterministic",
      expected: phase === "0"
        ? "all fixed Phase 0 gates pass on one stable clean source identity"
        : `all fixed Phase ${phase} gates pass on one stable clean source and prerequisite identity`,
      actual: "all fixed gates passed and source identity remained stable",
      outcome: "pass"
    }],
    liveScenarios: [],
    evidenceSystemQualification: true,
    provisionalSupportingRecord: false,
    releaseQualification: false,
    qualification: {
      deterministic: "pass",
      installedHost: "not_run",
      provider: "not_run",
      release: "not_run"
    },
    authorities: {
      workerClaims: "none",
      runtimeObservations: `broker-owned bounded Phase ${phase} gate runner`,
      hostVerification: "not_run",
      independentValidation: "not_run"
    },
    limits: {
      residualRisks: [
        "Installed-host and authenticated-provider qualification remain unproven.",
        "The local producer assumes reviewed gates and all descendants are quiescent; hostile same-UID races and data retained through open descriptors require a separately privileged supervisor."
      ],
      unsupportedPlatforms: [
        "windows-proof-producer-cleanup",
        "windows-provider-execution",
        "linux-provider-unqualified"
      ],
      invalidationTriggers: [
        "source inventory change outside evidence-only paths",
        "phase-scope path change",
        "proof gate manifest change",
        "dirty tree when cleanTreeAtVerification claimed"
      ],
      supersededBy: null,
      liveQualificationGaps: [
        "installed natural host proof not run",
        "authenticated Grok provider proof not run"
      ]
    }
  });
  record = attachRecordDigest({
    ...record,
    proofProducer: {
      id: PROOF_PRODUCER_ID,
      version: PROOF_PRODUCER_VERSION,
      manifestDigest: computeProofManifestDigest(phase)
    }
  });

  let beforePublication;
  try {
    beforePublication = captureProofSourceSnapshot(phase, root, proofContext.toolchain);
  } catch (error) {
    return proofFailureForError(error, "E_PROOF_SOURCE");
  }
  if (!sameProofSourceSnapshot(initial, beforePublication)
    || !proofRecordMatchesSnapshot(record, initial)) {
    return proofFailure("E_PROOF_SOURCE_DRIFT");
  }
  const beforePublicationPrerequisites = captureProofPrerequisites(phase, root);
  if (beforePublicationPrerequisites == null) return proofFailure("E_PROOF_PREREQUISITE");
  if (!sameProofPrerequisites(initialPrerequisites, beforePublicationPrerequisites)
    || !proofRecordMatchesPrerequisites(record, initialPrerequisites)) {
    return proofFailure("E_PROOF_PREREQUISITE_DRIFT");
  }
  const validated = validateEvidenceRecord(record, { strict: true, root, requireEvidenceSystem: true });
  if (!validated.ok) return proofFailure("E_PROOF_RECORD");

  // Temporary-home cleanup must complete before any ledger/record publication so
  // an unproven cleanup cannot leave ENOTEMPTY debris after a published claim.
  let cleaned;
  try {
    cleaned = proofContext.cleanup();
  } catch {
    cleaned = { ok: false };
  }
  if (!cleaned?.ok) return proofFailure("E_PROOF_CLEANUP");

  if (!write) {
    return {
      ok: true,
      phase,
      slice,
      status: record.status,
      manifestDigest: record.proofProducer.manifestDigest,
      gateIds: verification.map((entry) => entry.gateId),
      record
    };
  }
  try {
    const path = phase === "0"
      ? publishPhaseZeroProofRecord(record, root, initial, proofContext.toolchain)
      : publishDependentPhaseProofRecord(
        record,
        root,
        initial,
        initialPrerequisites,
        proofContext.toolchain
      );
    return {
      ok: true,
      phase,
      slice,
      status: record.status,
      path,
      recordDigest: record.recordDigest,
      sourceCommit: record.source.headCommit,
      manifestDigest: record.proofProducer.manifestDigest,
      gateIds: verification.map((entry) => entry.gateId),
      record
    };
  } catch {
    return proofFailure("E_PROOF_PUBLICATION");
  }
}

/** Backwards-compatible Phase 0 entrypoint retained for existing callers. */
export function provePhaseZero(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || (options.phase != null && String(options.phase) !== "0")) {
    return proofFailure("E_PROOF_ARGUMENT");
  }
  return proveWorkerBrokerPhase({ ...options, phase: "0" });
}

export { REPO_ROOT, sha256Text };
