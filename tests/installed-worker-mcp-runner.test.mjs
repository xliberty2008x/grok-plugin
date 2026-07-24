import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildTaskEnvelope } from "../plugins/grok/scripts/lib/task-contract.mjs";
import {
  classifyInstalledWorkerMcpCleanupOutcome,
  formatInstalledWorkerMcpDiagnostic,
  formatInstalledWorkerMcpFailure,
  selectInstalledWorkerMcpFailure
} from "../scripts/lib/installed-worker-mcp-failure.mjs";
import {
  decideInstalledWorkerMcpMailboxPoll
} from "../scripts/lib/installed-worker-mcp-mailbox-poll.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(ROOT, "scripts", "test-installed-worker-mcp.mjs");
const HELP = "Usage: GROK_E2E=1 GROK_INSTALLED_WORKER_MCP_E2E=1 GROK_E2E_CANCEL=1 npm run test:installed-worker-mcp\n";
const GATE_DIAGNOSTIC = "Installed Worker MCP E2E failed [E_GATE]: All installed Worker MCP live gates must equal 1.\n";
const ARGUMENT_DIAGNOSTIC = "Installed Worker MCP E2E failed [E_ARGUMENT]: Unsupported runner argument.\n";
const GATES = [
  "GROK_E2E",
  "GROK_INSTALLED_WORKER_MCP_E2E",
  "GROK_E2E_CANCEL"
];

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "grok-installed-worker-runner-test-"));
}

function isolatedEnv(root, values = {}) {
  return {
    ...process.env,
    TMPDIR: root,
    CODEX_HOME: path.join(root, "codex-home-must-not-exist"),
    GROK_COMPANION_PLUGIN_DATA: path.join(root, "plugin-data-must-not-exist"),
    npm_lifecycle_event: "test:installed-worker-mcp",
    ...Object.fromEntries(GATES.map((gate) => [gate, ""])),
    ...values
  };
}

function runRunner(root, args = [], values = {}) {
  assert.equal(
    GATES.every((gate) => values[gate] === "1"),
    false,
    "deterministic runner tests must never satisfy all live gates"
  );
  return spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: ROOT,
    env: isolatedEnv(root, values),
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  });
}

function assertNoSideEffects(root) {
  assert.deepEqual(fs.readdirSync(root), []);
}

test("installed Worker MCP runner import is inert and exposes no named authority", async (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const moduleUrl = new URL(pathToFileURL(RUNNER));
  moduleUrl.searchParams.set("inert", String(Date.now()));
  const module = await import(moduleUrl.href);
  assert.deepEqual(Object.keys(module), []);
  assert.deepEqual(
    Reflect.ownKeys(module).filter((key) => typeof key === "string"),
    []
  );
  assert.deepEqual(
    Reflect.ownKeys(module).filter((key) => typeof key === "symbol"),
    [Symbol.toStringTag]
  );
  assertNoSideEffects(root);
});

test("installed Worker MCP runner help is fixed and side-effect-free before gates", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = runRunner(root, ["--help"]);
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, HELP);
  assert.equal(result.stderr, "");
  assert.doesNotThrow(() => JSON.parse("null"));
  assert.throws(() => JSON.parse(result.stdout));
  assertNoSideEffects(root);
});

test("installed Worker MCP runner rejects unknown arguments without reflecting secrets", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const secret = `RUNNER_SECRET_${path.join(root, "private-observation.json")}`;
  const result = runRunner(root, [`--observation=${secret}`]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, ARGUMENT_DIAGNOSTIC);
  assert.equal(result.stderr.includes(secret), false);
  assert.equal(result.stderr.includes(root), false);
  assert.equal(result.stderr.includes("QualificationError"), false);
  assertNoSideEffects(root);
});

test("installed Worker MCP runner requires all three exact gates without npm bypass", (t) => {
  const roots = [];
  t.after(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });
  const cases = [
    {},
    { GROK_E2E: "1" },
    { GROK_E2E: "1", GROK_INSTALLED_WORKER_MCP_E2E: "1" },
    {
      GROK_E2E: "1",
      GROK_INSTALLED_WORKER_MCP_E2E: "1",
      GROK_E2E_CANCEL: "true"
    },
    {
      GROK_E2E: "01",
      GROK_INSTALLED_WORKER_MCP_E2E: "1",
      GROK_E2E_CANCEL: "1"
    }
  ];
  for (const values of cases) {
    const root = tempRoot();
    roots.push(root);
    const result = runRunner(root, [], values);
    assert.equal(result.status, 1, JSON.stringify(values));
    assert.equal(result.stdout, "", JSON.stringify(values));
    assert.equal(result.stderr, GATE_DIAGNOSTIC, JSON.stringify(values));
    assertNoSideEffects(root);
  }
});

test("installed Worker MCP runner owns fixed metadata, installed imports, and private publication", () => {
  const source = fs.readFileSync(RUNNER, "utf8");
  const recordKeySource = source.match(
    /const SPAWN_IDEMPOTENCY_RECORD_KEYS = new Set\(\[([\s\S]*?)\]\);/
  )?.[1] || "";
  const witnessKeySource = source.match(
    /const SPAWN_RESPONSE_WITNESS_KEYS = new Set\(\[([\s\S]*?)\]\);/
  )?.[1] || "";
  const stringLiterals = (value) => [...value.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(stringLiterals(recordKeySource), [
    "schemaVersion",
    "workerId",
    "owner",
    "controlWorkspaceId",
    "executionRoot",
    "requestDigest",
    "launchContractDigest",
    "idempotencyKeyDigest",
    "committedAt",
    "responseWitness"
  ]);
  assert.deepEqual(stringLiterals(witnessKeySource), [
    "schemaVersion",
    "witnessId",
    "projection",
    "responseSequence",
    "workerId",
    "requestDigest",
    "idempotencyKeyDigest",
    "replayed",
    "handleDigest",
    "eventCursorSequence",
    "recordedAt"
  ]);
  assert.match(
    source,
    /const SPAWN_RESPONSE_WITNESS_PROJECTION =\s*"worker-handle-v1-untrusted-host";/
  );
  const defaultAcceptanceIds = buildTaskEnvelope({
    userRequest: "Deterministic installed Worker MCP contract probe."
  }).acceptanceCriteria.map((criterion) => criterion.id);
  assert.deepEqual(defaultAcceptanceIds, ["AC-01", "AC-02"]);
  const expectedAcceptanceResults = defaultAcceptanceIds.map((id) => ({
    id,
    status: "met"
  }));
  const escapedAcceptanceResults = JSON
    .stringify(expectedAcceptanceResults)
    .replaceAll('"', '\\"');
  assert.ok(
    source.includes(
      `\\"acceptanceResults\\":${escapedAcceptanceResults}`
    ),
    "fixed first-try report must cover every production default acceptance ID"
  );
  for (const { id, status } of expectedAcceptanceResults) {
    assert.ok(
      source.includes(`Object.freeze({ id: "${id}", status: "${status}" })`),
      `${id} exact expected result`
    );
  }
  for (const gate of GATES) assert.ok(source.includes(`"${gate}"`), gate);
  assert.match(source, /const PROTOCOL_VERSION = "2025-11-25";/);
  assert.match(source, /const PLUGIN_ID = "grok@grok-companion";/);
  assert.match(source, /turn_id: turnId/);
  assert.match(source, /crypto\.randomUUID\(\)/);
  assert.match(source, /sandboxCwd: pathToFileURL\(fixtureRoot\)\.href/);
  assert.match(source, /import \{ spawnMcpStdioClient \} from "\.\/lib\/mcp-stdio-client\.mjs";/);
  assert.match(source, /async function importInstalled\(installedRoot, relative/);
  for (const relative of [
    "scripts/lib/provider-capability.mjs",
    "scripts/lib/state.mjs",
    "scripts/lib/process-control.mjs",
    "scripts/lib/recursion-guard.mjs",
    "scripts/lib/worker-mutation.mjs",
    "scripts/lib/worker-launch-contract.mjs",
    "scripts/lib/grok-provider.mjs",
    "scripts/lib/worker-protocol.mjs",
    "scripts/lib/worker-mailbox-state.mjs",
    "mcp/broker.mjs"
  ]) {
    assert.ok(source.includes(`"${relative}"`), relative);
  }
  assert.equal(source.includes("../plugins/grok/mcp/broker.mjs"), false);
  assert.equal(source.includes("../plugins/grok/scripts/lib/state.mjs"), false);
  assert.equal(
    source.includes("../plugins/grok/scripts/lib/worker-protocol.mjs"),
    false
  );
  assert.equal(
    source.includes("../plugins/grok/scripts/lib/worker-mailbox-state.mjs"),
    false
  );
  assert.match(
    source,
    /message\.messageId\s*!==\s*tracker\.mailboxPublicReceipts\[index\]\?\.messageId/
  );
  assert.match(
    source,
    /attempt\.finalReportDigest !== terminalJob\.result\?\.textDigest/
  );
  assert.match(
    source,
    /terminalJob\.result\?\.mailboxEvidence\?\.selectedSequence !== 2/
  );
  assert.equal(source.includes("fake-grok"), false);
  assert.equal(source.includes("baseEnvironment"), false);
  assert.match(source, /sessions: new Map\(\)/);
  assert.match(
    source,
    /lineageWorkerId: job\?\.request\?\.providerHomeId,/
  );
  assert.doesNotMatch(source, /providerHomeId \|\| job(?:\?\.)?\.id/);
  assert.match(
    source,
    /request\?\.contextBindingMode !== "context-receipt-v1"/
  );
  assert.match(source, /request\?\.providerHomeId !== job\?\.id/);
  assert.match(source, /validateContextReceiptProjection\(worker, job\)/);
  assert.match(
    source,
    /bindInstalledWorkerSessionBoundary\(\{[\s\S]*?childEnvironment: context\.provider\.childEnvironment[\s\S]*?\}\)/
  );
  assert.match(
    source,
    /context\.provider\.taskCredentialEnvironment\([\s\S]*?\["models"\][\s\S]*?context\.provider\.parseAdvertisedModels\(/
  );
  assert.match(
    source,
    /try \{\s*authenticatedModels = runBounded\([\s\S]*?\["models"\][\s\S]*?\} finally \{\s*refreshSessionCredentialHandle\(environment\);\s*\}/
  );
  assert.match(source, /runInstalledWorkerSessionCredentialTransaction\(\{/);
  assert.match(
    source,
    /context\.provider\.taskCredentialEnvironment\([\s\S]*?catch \(error\) \{[\s\S]*?if \(environment\) \{[\s\S]*?environment\.revokeCredential\(\)[\s\S]*?if \(error instanceof QualificationError\) throw error;\s*fail\("E_SESSION"\);/
  );
  assert.match(source, /deleteAcknowledged: tracker\.sessionDeleteAcknowledged === true/);
  assert.match(
    source,
    /if \(deleted\?\.ok !== true \|\| deleted\.removed !== true\) fail\("E_SESSION"\);/
  );
  assert.match(source, /tracker\.sessionDeleteAcknowledged = true/);
  assert.match(
    source,
    /finally \{\s*if \(deleted\?\.ok === true && deleted\.removed === true\) \{\s*tracker\.sessionDeleteAcknowledged = true;\s*\}\s*refreshSessionCredentialHandle\(environment\);\s*\}/
  );
  assert.match(source, /"session-cleanup-credential-revoked"/);
  const credentialRevocation = source.slice(
    source.indexOf("function revokeSessionCredential("),
    source.indexOf("function assertSessionCredentialAbsent(")
  );
  assert.match(credentialRevocation, /environment\?\.revokeCredential\(\)/);
  assert.doesNotMatch(credentialRevocation, /revokeTaskCredential/);
  assert.match(
    source,
    /deleteAndProveSessionAbsent\(context, tracker, \{\s*updateStage: false,\s*timeoutMs: 30_000\s*\}\)/
  );
  const presenceTransaction = source.slice(
    source.indexOf("async function waitForSessionPresence("),
    source.indexOf("async function deleteAndProveSessionAbsent(")
  );
  assert.match(presenceTransaction, /mode: "observe"/);
  assert.match(
    presenceTransaction,
    /"session-presence"[\s\S]*?runSessionCredentialTransaction[\s\S]*?"session-cleanup-credential-revoked"/
  );
  const deletionTransaction = source.slice(
    source.indexOf("async function deleteAndProveSessionAbsent("),
    source.indexOf("function proveTerminalCleanup(")
  );
  assert.ok(
    deletionTransaction.indexOf("tracker.sessionDeleteAcknowledged = true")
      < deletionTransaction.indexOf("proveAbsent:"),
    "delete acknowledgement must be durable in memory before absence proof"
  );
  const cancellationScenario = source.slice(
    source.indexOf("async function runCancellationScenario("),
    source.indexOf("function privateObservationFor(")
  );
  assert.equal(
    cancellationScenario.match(/waitForSessionPresence\(context, tracker\)/g)?.length,
    1
  );
  assert.equal(
    cancellationScenario.match(/deleteAndProveSessionAbsent\(context, tracker\)/g)?.length,
    1
  );
  assert.ok(
    cancellationScenario.indexOf("waitForSessionPresence(context, tracker)")
      < cancellationScenario.indexOf('enterQualificationStage("cancellation-reconnect")')
  );
  assert.ok(
    cancellationScenario.indexOf('enterQualificationStage("cancellation-cleanup-report")')
      < cancellationScenario.indexOf("deleteAndProveSessionAbsent(context, tracker)")
  );
  assert.match(
    source,
    /sameJson\(sessionBoundaryIdentity\(tracker\.sessionBoundary\), identity\)/
  );
  assert.match(
    source,
    /sameJson\(sessionBoundaryIdentity\(registered\.binding\), identity\)/
  );
  assert.doesNotMatch(
    source,
    /inspectImportedSessionPresence\([\s\S]{0,160}context\.env/
  );
  assert.doesNotMatch(
    source,
    /deleteSession\([\s\S]{0,160}context\.env/
  );
  for (const forbidden of [
    "--receipt",
    "--evidence",
    "GROK_WORKER_OBSERVATION_JSON",
    "callerObservation",
    "updateLedger(",
    "writeEvidenceRecord(",
    "buildEvidenceRecord("
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.match(source, /argv\.length !== 0/);
  assert.match(source, /fs\.constants\.O_EXCL/);
  assert.match(source, /fs\.constants\.O_NOFOLLOW/);
  assert.ok(
    source.match(/validateLiveQualificationReceipt\(/g)?.length >= 2,
    "receipt must be strictly validated before and after publication"
  );
  assert.match(source, /validateInstalledScenarioEvidence\(/);
  assert.match(
    source,
    /mailboxState = await importInstalled\(\s*installedRoot,\s*"scripts\/lib\/worker-mailbox-state\.mjs"\s*\)/
  );
  assert.match(source, /async function waitForInstalledMailboxOpen\(/);
  assert.match(source, /function snapshotInstalledMailboxProof\(/);
  assert.match(
    source,
    /context\.mailboxState\.assertNoRetainedBodies\([\s\S]*?context\.env\s*\)/
  );
  assert.match(
    source,
    /context\.mailboxState\.verifyChainExtension\(/,
    "runner must validate the installed helper's private body-free chain"
  );
  const completionScenario = source.slice(
    source.indexOf("async function runCompletionScenario("),
    source.indexOf("async function runCancellationScenario(")
  );
  assert.equal(
    completionScenario.match(/"worker_send"/g)?.length,
    3,
    "completion must call worker_send twice and replay one exact send"
  );
  assert.ok(
    completionScenario.indexOf('"completion-mailbox-open"')
      < completionScenario.indexOf('"completion-send-first"')
  );
  assert.ok(
    completionScenario.indexOf('"completion-send-first"')
      < completionScenario.indexOf('"completion-send-second"')
  );
  assert.ok(
    completionScenario.indexOf('"completion-send-second"')
      < completionScenario.indexOf('"completion-send-replay"')
  );
  assert.ok(
    completionScenario.indexOf('"completion-send-replay"')
      < completionScenario.indexOf('"completion-wait"')
  );
  assert.ok(
    completionScenario.indexOf("snapshotInstalledMailboxProof(")
      < completionScenario.indexOf("deleteAndProveSessionAbsent(context, tracker)")
  );
  assert.match(source, /mailboxMessageCountAfterReplay = afterReplayMessages\.length/);
  assert.match(source, /providerGenerationCount: 1/);
  assert.match(source, /providerSessionCount: 1/);
  assert.match(source, /promptCount: 3/);
  assert.match(source, /deliveredCount: 2/);
  assert.match(source, /deliveryUnknownCount: 0/);
  assert.match(source, /rejectedCount: 0/);
  assert.match(source, /finalReportSequence: 2/);
  assert.match(source, /replayPromptDelta: 0/);
  assert.match(source, /retainedBodyCount: 0/);
  assert.match(source, /closed: true/);
  assert.match(source, /observedProviderCapabilities: capability\.capabilities/);
  assert.match(source, /schemaVersion: LIVE_RECEIPT_SCHEMA_VERSION/);
  assert.match(source, /producerVersion: LIVE_RECEIPT_PRODUCER_VERSION/);
  assert.match(source, /LIVE_RECEIPT_ROOT/);
  assert.match(source, /installedWorkerBinding: \{/);
  assert.match(source, /observedPublicWorkerDigests: \[/);
  assert.match(
    source,
    /context\.workerProtocol\.projectWorkerHandle\(laterJob, \{\s*trustHostAuthority: false\s*\}\)/
  );
  assert.equal(source.includes("sameJson(publicWorker, laterHandle)"), false);
  assert.match(
    source,
    /context\.workerProtocol\.projectWorkerSnapshot\(job, \{\s*detail: true,\s*trustHostAuthority: false\s*\}\)/
  );
  assert.match(source, /if \(!sameJson\(publicWorker, expected\)\) fail\("E_PRIVATE_STATE"\);/);
  assert.match(
    source,
    /context\.mutation\.getSpawnIdempotencyRecord\(\s*context\.fixtureRoot,\s*spawnKey,\s*context\.env\s*\)/
  );
  assert.match(source, /record\.schemaVersion !== 4/);
  assert.match(
    source,
    /record\.launchContractDigest !== expectedLaunchContractDigest/
  );
  assert.match(
    source,
    /context\.launchContract\.launchContractDigest\(job\)/
  );
  assert.match(source, /record\?\.responseWitness/);
  assert.match(source, /witness\.projection !== SPAWN_RESPONSE_WITNESS_PROJECTION/);
  assert.match(source, /witness\.responseSequence !== \(replayed \? 2 : 1\)/);
  assert.match(source, /witness\.replayed !== replayed/);
  assert.match(source, /const handleDigest = publicWorkerDigest\(publicWorker\);/);
  assert.match(source, /witness\.handleDigest !== handleDigest/);
  assert.match(
    source,
    /witness\.eventCursorSequence !== publicWorker\.eventCursor\.sequence/
  );
  assert.match(source, /witness\.witnessId !== expectedWitnessId/);
  assert.match(source, /observedSpawnResponseWitnesses: \[\]/);
  assert.match(
    source,
    /observedSpawnResponseWitnesses: tracker\.observedSpawnResponseWitnesses\s*\.map/
  );
  assert.match(source, /initialSpawnHandle: null/);
  assert.match(source, /publicWorker\.status !== "queued"/);
  assert.match(source, /publicWorker\.phase !== "accepted"/);
  assert.match(source, /publicWorker\.summary !== "Spawn committed"/);
  assert.ok(
    source.includes(
      "Durable job record committed; provider not started by broker spawn."
    )
  );
  assert.match(source, /publicWorker\.eventCursor\.sequence !== 1/);
  assert.match(source, /publicWorker\.status !== "running"/);
  assert.match(source, /!ACTIVE_REPLAY_PHASES\.has\(publicWorker\.phase\)/);
  assert.match(
    source,
    /publicWorker\.eventCursor\.sequence\s*<= tracker\.initialSpawnHandle\.eventCursor\.sequence/
  );
  for (const bindingField of [
    "createdAt",
    "model",
    "effort"
  ]) {
    assert.ok(
      source.includes(`${bindingField}: tracker.privateBinding?.${bindingField}`),
      bindingField
    );
  }
  assert.match(
    source,
    /securityProfile: structuredClone\(\s*tracker\.privateBinding\?\.securityProfile\s*\)/
  );
  assert.match(source, /profileId: job\.profile\?\.id/);
  assert.match(source, /securityProfile\.id !== "rescue-read-v3"/);
  assert.match(source, /binding\.securityProfile\.contractVersion !== 3/);
  assert.match(
    source,
    /binding\.securityProfile\.agentProfileDigest \|\| ""/
  );
  assert.match(source, /validateIntermediateWorkerSnapshot\(/);
  assert.match(source, /validateTerminalWorkerSnapshot\(/);
  assert.match(source, /assertTerminalEventHistory\(/);
  assert.match(source, /projectWorkerSnapshot\(terminalJob, \{/);
  assert.match(source, /validateInstalledTerminalEventHistory\(\{/);
  assert.match(source, /projectedEvents: projected\.lifecycleEvents/);
  assert.match(source, /projectedCursor: projected\.eventCursor/);
  assert.doesNotMatch(source, /publicEvents\.length !== privateEvents\.length/);
  assert.match(source, /eventCursorSchemaVersion !== 1/);
  assert.match(source, /\{ wait: true, cursor: currentCursor \}/);
  assert.match(source, /stream\.timedOut !== \(/);
  assert.match(source, /assertDispatchContract\(job\)/);
  assert.match(source, /assertDurableSpawnRequestBinding\(job, context\.env\)/);
  assert.match(source, /const setupJson = await runSetupJson\(/);
  assert.match(source, /captureSetupCommandIdentityWithPolling\(\{/);
  assert.match(source, /decideSetupScanObservationDisposition\(\{/);
  assert.match(source, /if \(!record\) continue;/);
  assert.match(source, /setupCleanupRequiresObservation\(setupJson\)/);
  assert.match(source, /commandObservationIdentity = Object\.freeze\(\{/);
  assert.match(source, /unownedSetupCommandGroupGone\(\{/);
  assert.match(source, /setup = validateInstalledSetup\(setupJson\);/);
  assert.doesNotMatch(
    source,
    /publicWorker\.createdAt !== publicWorker\.updatedAt/
  );
  assert.match(
    source,
    /publicWorker\.createdAt !== publicWorker\.heartbeatAt/
  );
  assert.match(source, /catch \{\s*fail\("E_SETUP"\);\s*\}/);
  assert.match(
    source,
    /if \(!identity\) \{\s*if \(boundary\.commandObservationIdentity\)/
  );
  assert.match(source, /return boundary\.childExited === true/);
  for (const stage of [
    "provider-setup-command",
    "provider-setup-cleanup",
    "provider-setup-contract"
  ]) {
    assert.match(source, new RegExp(`enterQualificationStage\\("${stage}"\\)`));
  }
  assert.ok(
    source.indexOf('enterQualificationStage("provider-setup-command")')
      < source.indexOf("const setupJson = await runSetupJson(")
  );
  assert.ok(
    source.indexOf('enterQualificationStage("provider-setup-cleanup")')
      > source.indexOf("const setupJson = await runSetupJson(")
  );
  assert.ok(
    source.indexOf('enterQualificationStage("provider-setup-contract")')
      > source.indexOf("cleanupSetupBoundary(")
  );
  assert.match(source, /detached: true/);
  assert.match(source, /commandIdentity/);
  assert.match(source, /cleanupSetupBoundary\(/);
  assert.match(source, /stableClosureScans >= 2/);
  assert.match(
    source,
    /const finalInstalledEntries = createPluginInventory\(installedRoot\)/
  );
  assert.match(
    source,
    /finalInstalledEntrypointDigest !== installedEntrypointDigest/
  );
  assert.match(source, /!sameJson\(finalProviderIdentity, providerIdentity\)/);
  assert.match(source, /reopened\.dev !== publishedIdentity\.dev/);
  assert.match(source, /fs\.readFileSync\(descriptor, "utf8"\)/);
  assert.match(source, /\{ workloadFiles: 32 \}/);
});

test("installed Worker MCP runner preserves original stages and lets cleanup failure override", () => {
  const allowedStages = new Set([
    "completion-spawn",
    "completion-wait",
    "emergency-cleanup"
  ]);
  assert.equal(classifyInstalledWorkerMcpCleanupOutcome(true), "proven");
  assert.equal(
    classifyInstalledWorkerMcpCleanupOutcome(false),
    "proof-returned-false"
  );
  for (const malformed of [null, 0, 1, "true", {}, []]) {
    assert.equal(
      classifyInstalledWorkerMcpCleanupOutcome(malformed),
      "invalid-cleanup-result"
    );
  }
  assert.deepEqual(
    selectInstalledWorkerMcpFailure({
      originalCode: "E_PRIVATE_STATE",
      originalStage: "completion-spawn",
      cleanupOutcome: "proven"
    }, allowedStages),
    {
      code: "E_PRIVATE_STATE",
      stage: "completion-spawn",
      diagnostic: null
    }
  );
  const cleanupFailure = selectInstalledWorkerMcpFailure({
    originalCode: "E_SCENARIO",
    originalStage: "completion-wait",
    cleanupOutcome: "proof-returned-false"
  }, allowedStages);
  assert.deepEqual(
    cleanupFailure,
    {
      code: "E_CLEANUP",
      stage: "emergency-cleanup",
      diagnostic: {
        cleanupOutcome: "proof-returned-false",
        originalCode: "E_SCENARIO",
        originalStage: "completion-wait"
      }
    }
  );
  assert.equal(
    formatInstalledWorkerMcpDiagnostic(
      cleanupFailure.diagnostic,
      allowedStages
    ),
    "Installed Worker MCP E2E diagnostic "
      + "{\"cleanupOutcome\":\"proof-returned-false\","
      + "\"originalCode\":\"E_SCENARIO\","
      + "\"originalStage\":\"completion-wait\"}\n"
  );
  assert.deepEqual(
    selectInstalledWorkerMcpFailure({
      originalCode: "E_PRIVATE_STATE",
      originalStage: "completion-wait",
      cleanupOutcome: "cleanup-threw"
    }, allowedStages),
    {
      code: "E_CLEANUP",
      stage: "emergency-cleanup",
      diagnostic: {
        cleanupOutcome: "cleanup-threw",
        originalCode: "E_PRIVATE_STATE",
        originalStage: "completion-wait"
      }
    }
  );
  assert.throws(
    () => selectInstalledWorkerMcpFailure({
      originalCode: "E_PRIVATE_STATE",
      originalStage: "unbounded-secret-stage",
      cleanupOutcome: "proven"
    }, allowedStages),
    TypeError
  );
  assert.throws(
    () => selectInstalledWorkerMcpFailure({
      originalCode: "E_PRIVATE_STATE",
      originalStage: "completion-spawn",
      cleanupOutcome: "unbounded-cleanup-reason"
    }, allowedStages),
    TypeError
  );
  assert.throws(
    () => selectInstalledWorkerMcpFailure({
      originalCode: "E_PRIVATE_STATE",
      originalStage: "completion-spawn",
      cleanupOutcome: "proven",
      details: "must-not-pass"
    }, allowedStages),
    TypeError
  );
  assert.throws(
    () => selectInstalledWorkerMcpFailure({
      originalCode: "E_UNBOUNDED_CODE",
      originalStage: "completion-spawn",
      cleanupOutcome: "proven"
    }, allowedStages),
    TypeError
  );
  assert.throws(
    () => formatInstalledWorkerMcpDiagnostic({
      cleanupOutcome: "proof-returned-false",
      originalCode: "E_PRIVATE_STATE",
      originalStage: "completion-spawn\nsecret"
    }, allowedStages),
    TypeError
  );
  const renderedCleanupFailure = formatInstalledWorkerMcpFailure(
    cleanupFailure,
    allowedStages
  );
  assert.equal(
    renderedCleanupFailure,
    "Installed Worker MCP E2E failed "
      + "[E_CLEANUP; stage=emergency-cleanup]: "
      + "Exact qualification cleanup could not be proven.\n"
      + "Installed Worker MCP E2E diagnostic "
      + "{\"cleanupOutcome\":\"proof-returned-false\","
      + "\"originalCode\":\"E_SCENARIO\","
      + "\"originalStage\":\"completion-wait\"}\n"
  );
  assert.doesNotMatch(renderedCleanupFailure, /canary-secret/);
  assert.throws(
    () => formatInstalledWorkerMcpFailure({
      ...cleanupFailure,
      details: "canary-secret"
    }, allowedStages),
    TypeError
  );

  const source = fs.readFileSync(RUNNER, "utf8");
  assert.match(source, /const QUALIFICATION_STAGES = new Set\(\[/);
  assert.match(source, /this\.stage = QUALIFICATION_STAGES\.has\(stage\) \? stage : "startup";/);
  assert.doesNotMatch(source, /error\.(?:message|stack|details).*stage=/);
  assert.doesNotMatch(
    source,
    /formatInstalledWorkerMcpDiagnostic\(\s*error\.(?:message|stack|details)\b/
  );
  assert.match(
    source,
    /process\.stderr\.write\(\s*formatInstalledWorkerMcpFailure\(/
  );
  const mainCatch = source.slice(source.indexOf("if (IS_MAIN) {"));
  assert.equal(
    (mainCatch.match(/process\.stderr\.write\(/g) || []).length,
    1
  );
  assert.doesNotMatch(
    mainCatch,
    /error\.(?:message|stack|cause|details)\b/
  );
  assert.ok(
    source.indexOf("const originalStage =")
      < source.indexOf('enterQualificationStage("emergency-cleanup")')
  );
});

test("installed Worker MCP mailbox polling tolerates valid pre-provider state", () => {
  for (const workerStatus of ["queued", "running"]) {
    for (const mailboxState of [null, "preparing"]) {
      assert.equal(
        decideInstalledWorkerMcpMailboxPoll({
          workerStatus,
          mailboxState
        }),
        "wait"
      );
    }
  }
  assert.equal(
    decideInstalledWorkerMcpMailboxPoll({
      workerStatus: "running",
      mailboxState: "open"
    }),
    "observe-live-provider"
  );
  for (const workerStatus of ["completed", "failed", "cancelled"]) {
    for (const mailboxState of [null, "preparing", "open"]) {
      assert.equal(
        decideInstalledWorkerMcpMailboxPoll({
          workerStatus,
          mailboxState
        }),
        "terminal-before-open"
      );
    }
  }
  assert.throws(
    () => decideInstalledWorkerMcpMailboxPoll({
      workerStatus: "queued",
      mailboxState: "open"
    }),
    TypeError
  );
  assert.throws(
    () => decideInstalledWorkerMcpMailboxPoll({
      workerStatus: "running",
      mailboxState: "closed"
    }),
    TypeError
  );

  const source = fs.readFileSync(RUNNER, "utf8");
  const start = source.indexOf(
    "async function waitForInstalledMailboxOpen(context, tracker) {"
  );
  const end = source.indexOf(
    "\nfunction snapshotInstalledMailboxProof(",
    start
  );
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  const waitingReadIndex = body.indexOf(
    "const waitingJob = readPrivateJob(context, tracker);"
  );
  const resolveIndex = body.indexOf(
    "context.mailboxState.resolveOpenMailbox("
  );
  const decisionIndex = body.indexOf(
    "decision = decideInstalledWorkerMcpMailboxPoll({"
  );
  const terminalIndex = body.indexOf(
    'if (decision === "terminal-before-open")'
  );
  const acceptIndex = body.indexOf(
    'if (decision === "observe-live-provider")'
  );
  const strictReadIndex = body.indexOf(
    "const job = readPrivateJob(context, tracker, {"
  );
  const strictIndex = body.indexOf(
    "requireLiveProvider: true",
    strictReadIndex
  );
  assert.ok(waitingReadIndex >= 0);
  assert.ok(resolveIndex >= 0);
  assert.ok(waitingReadIndex < resolveIndex);
  assert.ok(resolveIndex < decisionIndex);
  assert.ok(decisionIndex < terminalIndex);
  assert.ok(terminalIndex < acceptIndex);
  assert.ok(acceptIndex < strictReadIndex);
  assert.ok(strictReadIndex < strictIndex);
  assert.match(
    body.slice(strictReadIndex),
    /observePrivateJob\(context, tracker, job, \{\s*requireLiveProvider: true/
  );
});

test("installed Worker MCP terminal results converge after private cleanup", () => {
  const source = fs.readFileSync(RUNNER, "utf8");
  const observerStart = source.indexOf(
    "function observeTerminalResultWorker(tracker, worker, historyWindowStage) {"
  );
  const observerEnd = source.indexOf("\nconst SNAPSHOT_KEYS", observerStart);
  assert.ok(observerStart >= 0 && observerEnd > observerStart);
  const observer = source.slice(observerStart, observerEnd);
  assert.ok(
    observer.indexOf("observePublicWorker(tracker, worker);")
      < observer.indexOf(
        "sameJson(trackedEvents, worker.lifecycleEvents)"
      )
  );
  assert.match(
    observer,
    /trackedEvents\.length > worker\.lifecycleEvents\.length/
  );
  assert.match(
    observer,
    /trackedEvents\.slice\(-worker\.lifecycleEvents\.length\)/
  );
  assert.match(observer, /enterQualificationStage\(historyWindowStage\);/);

  for (const [functionName, prefix, status, historyWindowStage] of [
    [
      "runCompletionScenario",
      "completion",
      "completed",
      "completion-result-history-window"
    ],
    [
      "runCancellationScenario",
      "cancellation",
      "cancelled",
      "cancellation-result-history-window"
    ]
  ]) {
    const start = source.indexOf(`async function ${functionName}(`);
    const end = source.indexOf("\nasync function ", start + 1);
    const body = source.slice(start, end < 0 ? source.length : end);
    const waitIndex = body.indexOf(
      `enterQualificationStage("${prefix}-wait")`
    );
    const cleanupIndex = body.indexOf(
      `enterQualificationStage("${prefix}-cleanup-private")`
    );
    const proofIndex = body.indexOf(
      `await proveTerminalCleanup(context, tracker, "${status}")`
    );
    const resultIndex = body.indexOf(
      `enterQualificationStage("${prefix}-result")`
    );
    const callIndex = body.indexOf('"worker_result"', resultIndex);
    const observeIndex = body.indexOf(
      "observeTerminalResultWorker(",
      callIndex
    );
    const historyWindowStageIndex = body.indexOf(
      `"${historyWindowStage}"`,
      observeIndex
    );
    const closeIndex = body.indexOf(
      "await closeMcp(context, client);",
      observeIndex
    );
    assert.ok(waitIndex >= 0);
    assert.ok(waitIndex < cleanupIndex);
    assert.ok(cleanupIndex < proofIndex);
    assert.ok(proofIndex < resultIndex);
    assert.ok(resultIndex < callIndex);
    assert.ok(callIndex < observeIndex);
    assert.ok(observeIndex < historyWindowStageIndex);
    assert.ok(historyWindowStageIndex < closeIndex);
    assert.ok(observeIndex < closeIndex);
    assert.equal(
      (body.match(/tracker\.calls\.result \+= 1;/g) || []).length,
      1
    );
  }
});

test("installed Worker MCP cleanup waits for exact process closure and proves durable cancellation markers", () => {
  const source = fs.readFileSync(RUNNER, "utf8");
  assert.match(
    source,
    /const TERMINAL_PROCESS_CLOSURE_TIMEOUT_MS = 30_000;/
  );
  assert.match(
    source,
    /async function waitForTerminalProcessClosure\([\s\S]*?stableScans >= 2[\s\S]*?setTimeout\(resolve, STATE_POLL_MS\)/
  );
  assert.match(
    source,
    /job = await waitForTerminalProcessClosure\(context, tracker, expectedStatus\);/
  );
  assert.match(
    source,
    /await proveTerminalCleanup\(context, tracker, "completed"\)/
  );
  assert.match(
    source,
    /await proveTerminalCleanup\(context, tracker, "cancelled"\)/
  );
  assert.match(source, /const markerName = `\$\{job\.id\}\.cancel`;/);
  assert.match(source, /name\.startsWith\(`\$\{markerName\}\.`\)/);
  assert.match(
    source,
    /const nonce = context\.mutation\.cancellationNonce\(job\);/
  );
  assert.match(source, /nonce !== workerNonce/);
  assert.match(source, /\(opened\.mode & 0o777\) !== 0o600/);
  assert.match(
    source,
    /opened\.size !== Buffer\.byteLength\(`\$\{nonce\}\\n`\)/
  );
  assert.match(
    source,
    /fs\.readFileSync\(descriptor, "utf8"\) !== `\$\{nonce\}\\n`/
  );
  assert.match(
    source,
    /if \(expectedStatus !== "cancelled"\) \{[\s\S]*?fs\.lstatSync\(marker\);[\s\S]*?error\?\.code !== "ENOENT"/
  );
});

test("package and repository validator pin the installed Worker MCP runner wiring", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8")
  );
  assert.equal(
    packageJson.scripts["test:installed-worker-mcp"],
    "node scripts/test-installed-worker-mcp.mjs"
  );
  const validator = fs.readFileSync(
    path.join(ROOT, "scripts", "validate.mjs"),
    "utf8"
  );
  for (const required of [
    '"scripts/test-installed-worker-mcp.mjs"',
    '"scripts/lib/installed-worker-mcp-setup-boundary.mjs"',
    '"scripts/lib/installed-worker-mcp-session-boundary.mjs"',
    '"tests/installed-worker-mcp-runner.test.mjs"',
    '"tests/installed-worker-mcp-setup-boundary.test.mjs"',
    '"tests/installed-worker-mcp-session-boundary.test.mjs"',
    '"test:installed-worker-mcp"'
  ]) {
    assert.ok(validator.includes(required), required);
  }
  assert.match(
    validator,
    /packageJson\.scripts\?\.\["test:installed-worker-mcp"\] !== "node scripts\/test-installed-worker-mcp\.mjs"/
  );
});
