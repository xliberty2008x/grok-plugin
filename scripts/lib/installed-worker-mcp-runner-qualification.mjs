// Installed Worker MCP qualification domain. Keep import-time behavior inert.
import { validateInstalledScenarioEvidence, validateInstalledSetup, validateProviderCapabilityAgreement } from "./installed-worker-mcp-contract.mjs";
import { privateObservationFor, runCancellationScenario, terminateTrackedClients } from "./installed-worker-mcp-runner-cancellation-cleanup.mjs";
import { CANONICAL_UUID, enterQualificationStage, EXPECTED_EXPERIMENTAL_CAPABILITIES, fail, MAX_RECEIPT_BYTES, MAX_TERMINAL_LIFECYCLE_EVENTS, PLUGIN_ID, PROTOCOL_VERSION, QualificationError, ROOT, runBounded, runJson, safeParseJson, sameJson, SOURCE_PLUGIN } from "./installed-worker-mcp-runner-core.mjs";
import { buildChildEnvironment, captureProviderFileIdentity, importInstalled, initializeFixtureRepository, mkdirPrivate, poisonChildProviderDiscovery, privateLiveFixtureBase, recheckProviderExecutablePin } from "./installed-worker-mcp-runner-runtime.mjs";
import { runCompletionScenario } from "./installed-worker-mcp-runner-session-read.mjs";
import { cleanupSetupBoundary, createSetupBoundary, runSetupJson } from "./installed-worker-mcp-runner-setup.mjs";
import { runWriteCancellationScenario, runWriteSmokeScenario } from "./installed-worker-mcp-runner-write-scenarios.mjs";
import { runTwoWriterScenario } from "./installed-worker-mcp-runner-write-two.mjs";
import { setupCleanupRequiresObservation } from "./installed-worker-mcp-setup-boundary.mjs";
import { canonicalPath, createPluginInventory, describeInventoryDifference, digestInventory, digestRegularFile, isPathInside } from "./plugin-inventory.mjs";
import { computeInventoryDigest, computeLiveQualificationReceiptDigest, computeLiveReceiptManifestDigest, computePhaseScopeDigest, gitIdentity, isNonEvidenceTreeClean, LIVE_RECEIPT_AUTHORITY_CONFIG, LIVE_RECEIPT_AUTHORITY_SYNTHETIC, LIVE_RECEIPT_CAPABILITY_TOOL_IDS, LIVE_RECEIPT_MANIFEST, LIVE_RECEIPT_PRODUCER_ID, LIVE_RECEIPT_PRODUCER_VERSION, LIVE_RECEIPT_PROVIDER_CAPABILITIES, LIVE_RECEIPT_ROOT, LIVE_RECEIPT_SCHEMA_VERSION, validateLiveQualificationReceipt } from "./worker-broker-evidence.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
export function ensurePublicationDirectory(relativeDirectory, created) {
  const root = canonicalPath(ROOT, "Repository root");
  let current = root;
  for (const segment of relativeDirectory.split("/")) {
    if (
      !segment
      || segment === "."
      || segment === ".."
      || segment.includes("\\")
      || segment.includes("\0")
    ) {
      fail("E_RECEIPT");
    }
    const next = path.join(current, segment);
    try {
      fs.mkdirSync(next, { mode: 0o755 });
      created.push(next);
      fsyncDirectory(current);
      fsyncDirectory(next);
    } catch (error) {
      if (error?.code !== "EEXIST") fail("E_RECEIPT");
    }
    const stat = fs.lstatSync(next);
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || !isPathInside(root, fs.realpathSync(next))
    ) {
      fail("E_RECEIPT");
    }
    current = fs.realpathSync(next);
  }
  return current;
}

export function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

export function publishReceipt(receipt) {
  const validation = validateLiveQualificationReceipt(receipt, {
    strict: true,
    root: ROOT
  });
  if (!validation.ok) fail("E_RECEIPT");
  const relativeDirectory = [
    LIVE_RECEIPT_ROOT,
    LIVE_RECEIPT_AUTHORITY_SYNTHETIC
  ].join("/");
  const fileName = [
    receipt.sourceInventoryDigest.slice(0, 16),
    receipt.receiptDigest.slice(0, 16)
  ].join("-") + ".json";
  const created = [];
  let publishedFile = null;
  let descriptor;
  let fileCreated = false;
  let publishedIdentity = null;
  try {
    const directory = ensurePublicationDirectory(relativeDirectory, created);
    publishedFile = path.join(directory, fileName);
    if (!isPathInside(ROOT, publishedFile)) fail("E_RECEIPT");
    descriptor = fs.openSync(
      publishedFile,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600
    );
    fileCreated = true;
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) fail("E_RECEIPT");
    publishedIdentity = { dev: opened.dev, ino: opened.ino };
    const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
    const buffer = Buffer.from(serialized, "utf8");
    if (buffer.length > MAX_RECEIPT_BYTES) fail("E_RECEIPT");
    let offset = 0;
    while (offset < buffer.length) {
      const written = fs.writeSync(
        descriptor,
        buffer,
        offset,
        buffer.length - offset
      );
      if (!Number.isSafeInteger(written) || written <= 0) fail("E_RECEIPT");
      offset += written;
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fsyncDirectory(directory);

    descriptor = fs.openSync(
      publishedFile,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const reopened = fs.fstatSync(descriptor);
    const stat = fs.lstatSync(publishedFile);
    if (
      !reopened.isFile()
      || reopened.dev !== publishedIdentity.dev
      || reopened.ino !== publishedIdentity.ino
      || !stat.isFile()
      || stat.isSymbolicLink()
      || stat.size !== buffer.length
      || stat.dev !== publishedIdentity.dev
      || stat.ino !== publishedIdentity.ino
      || !isPathInside(ROOT, fs.realpathSync(publishedFile))
    ) {
      fail("E_RECEIPT");
    }
    const reread = fs.readFileSync(descriptor, "utf8");
    fs.closeSync(descriptor);
    descriptor = null;
    if (reread !== serialized) fail("E_RECEIPT");
    const parsed = safeParseJson(reread, "E_RECEIPT");
    if (!sameJson(parsed, receipt)) fail("E_RECEIPT");
    const post = validateLiveQualificationReceipt(parsed, {
      strict: true,
      root: ROOT
    });
    if (!post.ok || parsed.receiptDigest !== receipt.receiptDigest) {
      fail("E_RECEIPT");
    }
    const finalStat = fs.lstatSync(publishedFile);
    if (
      !finalStat.isFile()
      || finalStat.isSymbolicLink()
      || finalStat.dev !== publishedIdentity.dev
      || finalStat.ino !== publishedIdentity.ino
    ) {
      fail("E_RECEIPT");
    }
  } catch (error) {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (publishedFile && fileCreated) {
      try {
        const current = fs.lstatSync(publishedFile);
        if (
          current.isFile()
          && !current.isSymbolicLink()
          && current.dev === publishedIdentity?.dev
          && current.ino === publishedIdentity?.ino
        ) {
          fs.unlinkSync(publishedFile);
          fsyncDirectory(path.dirname(publishedFile));
        }
      } catch {}
    }
    for (const directory of created.reverse()) {
      try {
        fs.rmdirSync(directory);
        fsyncDirectory(path.dirname(directory));
      } catch {}
    }
    if (error instanceof QualificationError) throw error;
    fail("E_RECEIPT");
  }
}

export function buildReceipt({
  startedAt,
  endedAt,
  sourceIdentity,
  sourceDigest,
  phaseScopeDigest,
  pluginVersion,
  sourcePluginDigest,
  installedPluginDigest,
  installedFileCount,
  installedEntrypointDigest,
  providerCapabilityDigest,
  observedProviderCapabilities,
  providerBinaryDigest,
  providerVersion
}) {
  const config = LIVE_RECEIPT_AUTHORITY_CONFIG[LIVE_RECEIPT_AUTHORITY_SYNTHETIC];
  const receipt = {
    schemaVersion: LIVE_RECEIPT_SCHEMA_VERSION,
    producerId: LIVE_RECEIPT_PRODUCER_ID,
    producerVersion: LIVE_RECEIPT_PRODUCER_VERSION,
    manifestDigest: computeLiveReceiptManifestDigest(),
    authorityMode: LIVE_RECEIPT_AUTHORITY_SYNTHETIC,
    phase: config.phase,
    pluginVersion,
    headCommit: sourceIdentity.headCommit,
    headTree: sourceIdentity.headTree,
    sourceInventoryDigest: sourceDigest,
    phaseScopeDigest,
    repositoryBeforeDigest: sourceDigest,
    repositoryAfterDigest: sourceDigest,
    sourcePluginInventoryDigest: sourcePluginDigest,
    installedPluginInventoryDigest: installedPluginDigest,
    installedFileCount,
    installedEntrypointDigest,
    providerCapabilityDigest,
    observedProviderCapabilities: [...observedProviderCapabilities],
    observedToolIds: [...LIVE_RECEIPT_CAPABILITY_TOOL_IDS],
    providerBinaryDigest,
    providerVersion,
    providerRevision: `binary-sha256-${providerBinaryDigest}`,
    mcpProtocolVersion: LIVE_RECEIPT_MANIFEST.mcpProtocolVersion,
    codexBinaryDigest: null,
    codexVersion: null,
    codexModel: null,
    hostTaskDigest: null,
    installationMethod: "codex-local-plugin-cache",
    scenarios: config.scenarios.map((scenario) => ({ ...scenario })),
    outcome: "pass",
    startedAt,
    endedAt
  };
  receipt.receiptDigest = computeLiveQualificationReceiptDigest(receipt);
  return receipt;
}

async function importInstalledQualificationModules(installedRoot) {
  const providerCapability = await importInstalled(
    installedRoot,
    "scripts/lib/provider-capability.mjs"
  );
  const providerExecutablePin = await importInstalled(
    installedRoot,
    "scripts/lib/provider-executable-pin.mjs"
  );
  const state = await importInstalled(installedRoot, "scripts/lib/state.mjs");
  const processControl = await importInstalled(
    installedRoot,
    "scripts/lib/process-control.mjs"
  );
  const guard = await importInstalled(
    installedRoot,
    "scripts/lib/recursion-guard.mjs"
  );
  const mutation = await importInstalled(
    installedRoot,
    "scripts/lib/worker-mutation.mjs"
  );
  const launchContract = await importInstalled(
    installedRoot,
    "scripts/lib/worker-launch-contract.mjs"
  );
  const provider = await importInstalled(
    installedRoot,
    "scripts/lib/grok-provider.mjs"
  );
  const profiles = await importInstalled(
    installedRoot,
    "scripts/lib/profiles.mjs"
  );
  const authority = await importInstalled(
    installedRoot,
    "scripts/lib/worker-authority.mjs"
  );
  const workerProtocol = await importInstalled(
    installedRoot,
    "scripts/lib/worker-protocol.mjs"
  );
  const workerWorktree = await importInstalled(
    installedRoot,
    "scripts/lib/worker-worktree.mjs"
  );
  const workerSessionLifecycle = await importInstalled(
    installedRoot,
    "scripts/lib/worker-session-lifecycle.mjs"
  );
  if (workerProtocol.MAX_LIFECYCLE_EVENTS !== MAX_TERMINAL_LIFECYCLE_EVENTS) {
    fail("E_INSTALL");
  }
  const mailboxState = await importInstalled(
    installedRoot,
    "scripts/lib/worker-mailbox-state.mjs"
  );
  const broker = await importInstalled(installedRoot, "mcp/broker.mjs");
  return {
    providerCapability,
    providerExecutablePin,
    state,
    processControl,
    guard,
    mutation,
    launchContract,
    provider,
    profiles,
    authority,
    workerProtocol,
    workerWorktree,
    workerSessionLifecycle,
    mailboxState,
    broker
  };
}

async function runWriteQualification(options) {
  const {
    runner, twoWriter, env, broker, capability, baseContext, pluginData,
    writeSmokeFixture, writeCancelFixture, twoWriterFixture, sourceIdentity,
    sourceDigest, sourcePluginDigest, installedPluginDigest,
    installedEntrypointDigest, providerIdentity, providerLaunchBinding,
    providerLaunchBindingDigest, resolvedProviderPin, installedRoot,
    installedEntries
  } = options;
  env.GROK_COMPANION_WRITE_SMOKE = broker.WRITE_SMOKE_ENV_VALUE;
  const runtime = broker.createMcpBrokerRuntime({
    env,
    providerCapabilityReceipt: capability
  });
  if (
    runtime.writeLifecycleCapabilityDigest == null
    || !/^[a-f0-9]{64}$/.test(runtime.writeLifecycleCapabilityDigest)
    || !sameJson(runtime.tools, broker.WRITE_SMOKE_WORKER_TOOLS)
  ) {
    fail("E_CAPABILITY");
  }
  baseContext.writeSmoke = true;
  baseContext.writeLifecycleCapabilityDigest =
    runtime.writeLifecycleCapabilityDigest;
  baseContext.pluginData = pluginData;
  const evidence = twoWriter
    ? await runTwoWriterScenario(baseContext, twoWriterFixture)
    : await runWriteSmokeScenario(baseContext, writeSmokeFixture);
  const cancellationEvidence = twoWriter
    ? null
    : await runWriteCancellationScenario(baseContext, writeCancelFixture);
  const pinnedEvidence = Object.freeze({
    ...evidence,
    ...(twoWriter ? {} : {
      activeWriteCancellationProven: true,
      writeCancellation: cancellationEvidence
    }),
    sourceHeadCommit: sourceIdentity.headCommit,
    sourceHeadTree: sourceIdentity.headTree,
    sourceInventoryDigest: sourceDigest,
    sourcePluginInventoryDigest: sourcePluginDigest,
    installedPluginInventoryDigest: installedPluginDigest,
    installedEntrypointDigest,
    providerVersion: capability.providerVersion,
    providerBinaryDigest: providerIdentity.contentDigest,
    providerCapabilityDigest: capability.capabilityDigest,
    providerPinRef: providerLaunchBinding.pinRef,
    providerLaunchBindingDigest,
    providerExecutableIdentityDigest:
      resolvedProviderPin.executableIdentity.identityDigest,
    providerReleaseIdentityDigest:
      resolvedProviderPin.executableIdentity.releaseIdentityDigest,
    ambientProviderDiscoveryPoisoned: true,
    writeLifecycleCapabilityDigest: runtime.writeLifecycleCapabilityDigest
  });
  if (!(await terminateTrackedClients(runner))) fail("E_CLEANUP");
  recheckProviderExecutablePin(baseContext, providerIdentity);
  const finalInstalledEntries = createPluginInventory(installedRoot);
  if (
    describeInventoryDifference(installedEntries, finalInstalledEntries).length
      !== 0
    || digestInventory(finalInstalledEntries) !== installedPluginDigest
    || digestRegularFile(path.join(installedRoot, "mcp", "server.mjs"))
      !== installedEntrypointDigest
  ) {
    fail("E_INSTALL");
  }
  const finalSourceIdentity = gitIdentity(ROOT);
  if (
    !isNonEvidenceTreeClean(ROOT)
    || finalSourceIdentity.cleanTreeAtVerification !== true
    || finalSourceIdentity.headCommit !== sourceIdentity.headCommit
    || finalSourceIdentity.headTree !== sourceIdentity.headTree
    || computeInventoryDigest(ROOT, { includeEvidence: false }) !== sourceDigest
    || digestInventory(createPluginInventory(SOURCE_PLUGIN)) !== sourcePluginDigest
  ) {
    fail("E_SOURCE");
  }
  fs.rmSync(runner.temporaryRoot, { recursive: true, force: true });
  if (fs.existsSync(runner.temporaryRoot)) fail("E_CLEANUP");
  runner.temporaryRemoved = true;
  return pinnedEvidence;
}

async function finishReadQualification(options) {
  const {
    runner, baseContext, completionFixture, cancellationFixture, processControl,
    installedRoot, installedEntries, installedPluginDigest, sourceEntries,
    sourcePluginDigest, installedEntrypointDigest, providerIdentity,
    sourceIdentity, sourceDigest, phaseScopeDigest, packageJson, capability,
    startedAt
  } = options;
  const completion = await runCompletionScenario(baseContext, completionFixture);
  const cancellation = await runCancellationScenario(
    baseContext,
    cancellationFixture
  );

  enterQualificationStage("global-cleanup");
  if (!(await terminateTrackedClients(runner))) fail("E_CLEANUP");
  for (const { tracker } of [completion, cancellation]) {
    if (
      tracker.processIdentities.size !== 3
      || [...tracker.processIdentities.values()]
        .some((identity) => !processControl.processGroupGone(identity))
    ) {
      fail("E_CLEANUP");
    }
  }
  enterQualificationStage("installed-recheck");
  const finalInstalledEntries = createPluginInventory(installedRoot);
  const finalInstalledDigest = digestInventory(finalInstalledEntries);
  const finalInstalledEntrypointDigest = digestRegularFile(
    path.join(installedRoot, "mcp", "server.mjs")
  );
  const finalProviderIdentity = recheckProviderExecutablePin(
    baseContext,
    providerIdentity
  ).currentIdentity;
  if (
    describeInventoryDifference(installedEntries, finalInstalledEntries).length
      !== 0
    || describeInventoryDifference(sourceEntries, finalInstalledEntries).length
      !== 0
    || finalInstalledDigest !== installedPluginDigest
    || finalInstalledDigest !== sourcePluginDigest
    || finalInstalledEntries.length !== installedEntries.length
    || finalInstalledEntrypointDigest !== installedEntrypointDigest
    || !sameJson(finalProviderIdentity, providerIdentity)
  ) {
    fail("E_INSTALL");
  }
  fs.rmSync(runner.temporaryRoot, { recursive: true, force: true });
  if (fs.existsSync(runner.temporaryRoot)) fail("E_CLEANUP");
  runner.temporaryRemoved = true;

  enterQualificationStage("evidence-binding");
  for (const completed of [completion, cancellation]) {
    completed.tracker.context = completed.context;
    const observation = privateObservationFor(completed.tracker, true);
    validateInstalledScenarioEvidence(completed.publicEvidence, observation);
  }

  const finalSourceIdentity = gitIdentity(ROOT);
  if (
    !isNonEvidenceTreeClean(ROOT)
    || finalSourceIdentity.cleanTreeAtVerification !== true
    || finalSourceIdentity.headCommit !== sourceIdentity.headCommit
    || finalSourceIdentity.headTree !== sourceIdentity.headTree
    || computeInventoryDigest(ROOT, { includeEvidence: false }) !== sourceDigest
    || computePhaseScopeDigest("1", ROOT) !== phaseScopeDigest
    || digestInventory(createPluginInventory(SOURCE_PLUGIN)) !== sourcePluginDigest
  ) {
    fail("E_SOURCE");
  }
  const endedAt = new Date().toISOString();
  const receipt = buildReceipt({
    startedAt,
    endedAt,
    sourceIdentity,
    sourceDigest,
    phaseScopeDigest,
    pluginVersion: packageJson.version,
    sourcePluginDigest,
    installedPluginDigest,
    installedFileCount: installedEntries.length,
    installedEntrypointDigest,
    providerCapabilityDigest: capability.capabilityDigest,
    observedProviderCapabilities: capability.capabilities,
    providerBinaryDigest: providerIdentity.contentDigest,
    providerVersion: capability.providerVersion
  });
  enterQualificationStage("receipt-publication");
  publishReceipt(receipt);
}

export async function qualify(
  runner,
  { writeSmoke = false, twoWriter = false } = {}
) {
  const writeLifecycle = writeSmoke || twoWriter;
  enterQualificationStage("source-boundary");
  const startedAt = new Date().toISOString();
  if (!isNonEvidenceTreeClean(ROOT)) fail("E_SOURCE");
  const sourceIdentity = gitIdentity(ROOT);
  if (sourceIdentity.cleanTreeAtVerification !== true) fail("E_SOURCE");
  const sourceDigest = computeInventoryDigest(ROOT, { includeEvidence: false });
  const phaseScopeDigest = computePhaseScopeDigest("1", ROOT);
  const sourceEntries = createPluginInventory(SOURCE_PLUGIN);
  const sourcePluginDigest = digestInventory(sourceEntries);
  const packageJson = safeParseJson(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
    "E_SOURCE"
  );
  const pluginManifest = safeParseJson(
    fs.readFileSync(path.join(SOURCE_PLUGIN, ".codex-plugin", "plugin.json"), "utf8"),
    "E_SOURCE"
  );
  if (
    typeof packageJson.version !== "string"
    || packageJson.version !== pluginManifest.version
  ) {
    fail("E_SOURCE");
  }

  const runnerBase = writeLifecycle ? privateLiveFixtureBase() : os.tmpdir();
  runner.temporaryRoot = fs.mkdtempSync(
    path.join(runnerBase, "grok-installed-worker-mcp-")
  );
  fs.chmodSync(runner.temporaryRoot, 0o700);
  const codexHome = path.join(runner.temporaryRoot, "codex-home");
  const pluginData = path.join(runner.temporaryRoot, "plugin-data");
  const setupFixture = path.join(runner.temporaryRoot, "setup-fixture");
  const completionFixture = path.join(runner.temporaryRoot, "completion-fixture");
  const cancellationFixture = path.join(runner.temporaryRoot, "cancellation-fixture");
  const writeSmokeFixture = path.join(runner.temporaryRoot, "write-smoke-fixture");
  const writeCancelFixture = path.join(runner.temporaryRoot, "write-cancel-fixture");
  const twoWriterFixture = path.join(runner.temporaryRoot, "two-writer-fixture");
  mkdirPrivate(codexHome);
  mkdirPrivate(pluginData);
  const threadId = crypto.randomUUID();
  if (!CANONICAL_UUID.test(threadId)) fail("E_MCP");
  const env = buildChildEnvironment({ codexHome, pluginData, threadId });
  initializeFixtureRepository(setupFixture, env);

  enterQualificationStage("private-install");
  const codexBinary = process.env.CODEX_BIN || "codex";
  runJson(codexBinary, ["plugin", "marketplace", "add", ROOT, "--json"], {
    cwd: ROOT,
    env,
    timeoutMs: 60_000,
    code: "E_INSTALL"
  });
  const installedPayload = runJson(
    codexBinary,
    ["plugin", "add", PLUGIN_ID, "--json"],
    {
      cwd: ROOT,
      env,
      timeoutMs: 60_000,
      code: "E_INSTALL"
    }
  );
  if (typeof installedPayload.installedPath !== "string") fail("E_INSTALL");
  const installedRoot = canonicalPath(
    installedPayload.installedPath,
    "Installed plugin root"
  );
  const cacheRoot = canonicalPath(
    path.join(codexHome, "plugins", "cache"),
    "Private Codex plugin cache"
  );
  if (
    !isPathInside(cacheRoot, installedRoot)
    || isPathInside(SOURCE_PLUGIN, installedRoot)
  ) {
    fail("E_INSTALL");
  }
  const listedPlugins = runJson(codexBinary, ["plugin", "list", "--json"], {
    cwd: ROOT,
    env,
    timeoutMs: 30_000,
    code: "E_INSTALL"
  });
  const installedRecord = listedPlugins.installed?.filter(
    (entry) => entry?.pluginId === PLUGIN_ID
  );
  if (
    !Array.isArray(installedRecord)
    || installedRecord.length !== 1
    || installedRecord[0].installed !== true
    || installedRecord[0].enabled !== true
    || installedRecord[0].version !== packageJson.version
  ) {
    fail("E_INSTALL");
  }
  const installedEntries = createPluginInventory(installedRoot);
  const installedPluginDigest = digestInventory(installedEntries);
  if (
    describeInventoryDifference(sourceEntries, installedEntries).length !== 0
    || installedPluginDigest !== sourcePluginDigest
  ) {
    fail("E_INSTALL");
  }
  const installedEntrypointDigest = digestRegularFile(
    path.join(installedRoot, "mcp", "server.mjs")
  );
  const sourceEntrypoint = sourceEntries.find(
    (entry) => entry.path === "mcp/server.mjs"
  );
  if (
    !sourceEntrypoint
    || sourceEntrypoint.sha256 !== installedEntrypointDigest
  ) {
    fail("E_INSTALL");
  }

  enterQualificationStage("installed-imports");
  const {
    providerCapability, providerExecutablePin, state, processControl, guard,
    mutation, launchContract, provider, profiles, authority, workerProtocol,
    workerWorktree, workerSessionLifecycle, mailboxState, broker
  } = await importInstalledQualificationModules(installedRoot);

  enterQualificationStage("provider-setup");
  runner.setupBoundary = createSetupBoundary({
    fixtureRoot: setupFixture,
    pluginData,
    env,
    threadId,
    processControl,
    guard
  });
  enterQualificationStage("provider-setup-command");
  const setupJson = await runSetupJson(
    process.execPath,
    [path.join(installedRoot, "scripts", "grok-codex.mjs"), "setup", "--json"],
    {
      cwd: setupFixture,
      env,
      timeoutMs: 120_000,
      boundary: runner.setupBoundary,
      runner
    }
  );
  enterQualificationStage("provider-setup-cleanup");
  if (!await cleanupSetupBoundary(
    runner.setupBoundary,
    {
      terminate: false,
      requireObservation: setupCleanupRequiresObservation(setupJson)
    }
  )) {
    fail("E_CLEANUP");
  }
  enterQualificationStage("provider-setup-contract");
  let setup;
  try {
    setup = validateInstalledSetup(setupJson);
  } catch {
    fail("E_SETUP");
  }
  const setupFixtureStatus = runBounded("git", [
    "status", "--porcelain=v1", "-z", "--untracked-files=all"
  ], {
    cwd: setupFixture,
    env,
    requireSilentStderr: false,
    code: "E_SETUP"
  }).stdout;
  if (setupFixtureStatus !== "") fail("E_SETUP");

  enterQualificationStage("provider-discovery-poison");
  const discoveryPoison = poisonChildProviderDiscovery(env, runner.temporaryRoot);
  enterQualificationStage("provider-capability");
  const providerLaunchBinding =
    providerExecutablePin.readActiveProviderLaunchBinding({ env });
  if (!providerLaunchBinding) fail("E_CAPABILITY");
  const providerLaunchBindingDigest =
    providerExecutablePin.providerLaunchBindingDigest(providerLaunchBinding);
  const capability = providerCapability.readValidProviderCapabilityReceipt({ env });
  if (!capability) fail("E_CAPABILITY");
  let resolvedProviderPin;
  try {
    resolvedProviderPin = providerExecutablePin.resolveProviderExecutablePin(
      providerLaunchBinding,
      { env }
    );
  } catch {
    fail("E_CAPABILITY");
  }
  const providerIdentity = captureProviderFileIdentity(
    resolvedProviderPin.binary
  );
  validateProviderCapabilityAgreement(capability, {
    setup,
    pluginVersion: packageJson.version,
    mcpCapabilityContractVersion: providerCapability.MCP_CAPABILITY_CONTRACT_VERSION,
    platform: process.platform,
    architecture: process.arch,
    providerLaunchBinding,
    providerLaunchBindingDigest,
    rootReadProfileDigest: profiles.profileFor("task", false).agentProfileDigest,
    observedAt: Date.now()
  });
  if (
    Object.hasOwn(setup.grok, "binary")
    || JSON.stringify(setup).includes(providerIdentity.path)
    || JSON.stringify(capability).includes(providerIdentity.path)
    || Object.hasOwn(capability, "providerFileIdentity")
    || setup.grok.version !== resolvedProviderPin.executableIdentity.version
    || providerIdentity.contentDigest
      !== resolvedProviderPin.executableIdentity.executableDigest
    || providerLaunchBinding.executableIdentityDigest
      !== resolvedProviderPin.executableIdentity.identityDigest
    || providerLaunchBinding.releaseIdentityDigest
      !== resolvedProviderPin.executableIdentity.releaseIdentityDigest
    || capability.providerLaunchBindingDigest !== providerLaunchBindingDigest
    || !sameJson(capability.providerLaunchBinding, providerLaunchBinding)
    || capability.capabilities?.length !== 3
    || !sameJson(capability.capabilities, LIVE_RECEIPT_PROVIDER_CAPABILITIES)
    || capability.capabilities[0]
      !== providerCapability.ROOT_READ_PROVIDER_CAPABILITY
    || capability.capabilities[1]
      !== providerCapability.SAME_SESSION_READ_FOLLOWUP_PROVIDER_CAPABILITY
    || capability.capabilities[2]
      !== providerCapability.ORDERED_TURN_BOUNDARY_MAILBOX_PROVIDER_CAPABILITY
    || broker.DEFAULT_MCP_PROTOCOL_VERSION !== PROTOCOL_VERSION
    || broker.MCP_SERVER_NAME !== "grok-worker-broker"
    || broker.MCP_SERVER_VERSION
      !== providerCapability.MCP_CAPABILITY_CONTRACT_VERSION
    || !sameJson(
      broker.MCP_SERVER_EXPERIMENTAL_CAPABILITIES,
      EXPECTED_EXPERIMENTAL_CAPABILITIES
    )
  ) {
    fail("E_CAPABILITY");
  }

  runner.provider = provider;
  runner.providerBinary = providerIdentity.path;
  const baseContext = {
    runner,
    env,
    discoveryPoison,
    threadId,
    installedRoot,
    providerCapability: capability,
    providerCapabilityModule: providerCapability,
    providerExecutablePin,
    providerLaunchBinding,
    providerLaunchBindingDigest,
    providerExecutableIdentityDigest:
      resolvedProviderPin.executableIdentity.identityDigest,
    providerReleaseIdentityDigest:
      resolvedProviderPin.executableIdentity.releaseIdentityDigest,
    providerBinary: providerIdentity.path,
    state,
    processControl,
    guard,
    mutation,
    launchContract,
    provider,
    workerProtocol,
    workerWorktree,
    workerSessionLifecycle,
    mailboxState,
    workerTools: writeLifecycle
      ? broker.WRITE_SMOKE_WORKER_TOOLS
      : broker.WORKER_TOOLS,
    defaultWorkerTools: broker.WORKER_TOOLS,
    serverVersion: broker.MCP_SERVER_VERSION,
    experimentalCapabilities: EXPECTED_EXPERIMENTAL_CAPABILITIES
  };
  if (writeLifecycle) {
    return await runWriteQualification({
      runner, twoWriter, env, broker, capability, baseContext, pluginData,
      writeSmokeFixture, writeCancelFixture, twoWriterFixture, sourceIdentity,
      sourceDigest, sourcePluginDigest, installedPluginDigest,
      installedEntrypointDigest, providerIdentity, providerLaunchBinding,
      providerLaunchBindingDigest, resolvedProviderPin, installedRoot,
      installedEntries
    });
  }
  await finishReadQualification({
    runner, baseContext, completionFixture, cancellationFixture, processControl,
    installedRoot, installedEntries, installedPluginDigest, sourceEntries,
    sourcePluginDigest, installedEntrypointDigest, providerIdentity,
    sourceIdentity, sourceDigest, phaseScopeDigest, packageJson, capability,
    startedAt
  });
}
