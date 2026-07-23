import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildTaskEnvelope } from "../plugins/grok/scripts/lib/task-contract.mjs";
import { selectInstalledWorkerMcpFailure } from "../scripts/lib/installed-worker-mcp-failure.mjs";

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
  assert.equal(source.includes("fake-grok"), false);
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
  assert.deepEqual(
    selectInstalledWorkerMcpFailure({
      originalCode: "E_PRIVATE_STATE",
      originalStage: "completion-spawn",
      cleanupProven: true
    }, allowedStages),
    { code: "E_PRIVATE_STATE", stage: "completion-spawn" }
  );
  assert.deepEqual(
    selectInstalledWorkerMcpFailure({
      originalCode: "E_SCENARIO",
      originalStage: "completion-wait",
      cleanupProven: false
    }, allowedStages),
    { code: "E_CLEANUP", stage: "emergency-cleanup" }
  );
  assert.throws(
    () => selectInstalledWorkerMcpFailure({
      originalCode: "E_PRIVATE_STATE",
      originalStage: "unbounded-secret-stage",
      cleanupProven: true
    }, allowedStages),
    TypeError
  );

  const source = fs.readFileSync(RUNNER, "utf8");
  assert.match(source, /const QUALIFICATION_STAGES = new Set\(\[/);
  assert.match(source, /this\.stage = QUALIFICATION_STAGES\.has\(stage\) \? stage : "startup";/);
  assert.match(source, /QUALIFICATION_STAGES\.has\(error\.stage\)/);
  assert.match(source, /stage=\$\{error\.stage\}/);
  assert.doesNotMatch(source, /error\.(?:message|stack|details).*stage=/);
  assert.ok(
    source.indexOf("const originalStage =")
      < source.indexOf('enterQualificationStage("emergency-cleanup")')
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
    '"tests/installed-worker-mcp-runner.test.mjs"',
    '"tests/installed-worker-mcp-setup-boundary.test.mjs"',
    '"test:installed-worker-mcp"'
  ]) {
    assert.ok(validator.includes(required), required);
  }
  assert.match(
    validator,
    /packageJson\.scripts\?\.\["test:installed-worker-mcp"\] !== "node scripts\/test-installed-worker-mcp\.mjs"/
  );
});
