import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { WORKER_TOOLS } from "../plugins/grok/mcp/broker.mjs";
import {
  CODEX_MCP_EXPERIMENTAL_CAPABILITIES,
  MCP_SANDBOX_STATE_META_CAPABILITY
} from "../plugins/grok/scripts/lib/worker-authority.mjs";
import {
  codexMetadataCapabilityMatrix
} from "../plugins/grok/scripts/lib/worker-presentation.mjs";
import {
  projectWorkerHandle,
  projectWorkerSnapshot
} from "../plugins/grok/scripts/lib/worker-protocol.mjs";
import {
  INSTALLED_WORKER_SCENARIO_IDS,
  INSTALLED_WORKER_TOOL_NAMES,
  InstalledWorkerMcpContractError,
  validateInstalledCancellationReplayScenario,
  validateInstalledCompletionScenario,
  validateInstalledInitialize,
  validateInstalledPrivateObservation,
  validateInstalledScenarioEvidence,
  validateInstalledSetup,
  validateInstalledToolInventory,
  validateInstalledToolResult,
  validateProviderCapabilityAgreement
} from "../scripts/lib/installed-worker-mcp-contract.mjs";

const DIGESTS = Object.freeze({
  setup: "a".repeat(64),
  rootRead: "b".repeat(64),
  provider: "c".repeat(64)
});
const WORKER_ID = "task-0123456789abcdef";
const ENVELOPE_ID = "env-0123456789abcdef01234567";
const MANIFEST_ID = "ctx-0123456789abcdef01234567";
const RECEIPT_ID = "cancel-0123456789abcdef01234567";
const SPAWN_REQUEST_DIGEST = "7".repeat(64);
const SPAWN_IDEMPOTENCY_KEY_DIGEST = "8".repeat(64);
const OBSERVED_AT = Date.parse("2026-07-23T10:01:00.000Z");
const HOST_SESSION_ID = "019f666a-6469-7cc1-9a8d-8c1adf61e103";
const HOST_TASK_BINDING = `host-task-${crypto
  .createHash("sha256")
  .update(`codex\0${HOST_SESSION_ID}`)
  .digest("hex")
  .slice(0, 32)}`;
const CONTROL_WORKSPACE_ID = `cws-${"1".repeat(32)}`;
const INITIALIZE_CLIENT_META = Object.freeze({
  threadId: "019f666a-6469-7cc1-9a8d-8c1adf61e103",
  plugin_id: "grok",
  "x-codex-turn-metadata": Object.freeze({
    thread_id: "019f666a-6469-7cc1-9a8d-8c1adf61e103",
    turn_id: "019f666e-4084-7902-8447-249f72043a37",
    plugin_id: "grok"
  }),
  [MCP_SANDBOX_STATE_META_CAPABILITY]: Object.freeze({
    sandboxCwd: "file:///tmp/grok-installed-worker-fixture"
  })
});
const EXPECTED_CAPABILITY_MATRIX = codexMetadataCapabilityMatrix(
  INITIALIZE_CLIENT_META
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const normalized = {};
  for (const key of Object.keys(value).sort()) normalized[key] = canonicalize(value[key]);
  return normalized;
}

function digest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function setupFixture() {
  return {
    ready: true,
    grok: {
      binary: "/opt/grok/bin/grok",
      version: "0.2.99",
      authenticated: true,
      headlessReview: {
        flags: ["--prompt-file", "--json-schema", "--tools", "--disallowed-tools", "--sandbox"],
        isolated: true,
        externalHooks: 0,
        externalSkills: 0,
        externalPlugins: 0,
        externalMcpServers: 0
      },
      acpIsolation: {
        flags: ["--agent-profile", "--no-leader", "--leader-socket"],
        isolated: true,
        sandbox: "read-only",
        permissionMode: "dontAsk",
        injectDefaultTools: false,
        allowedTools: ["todo_write"],
        agentProfileDigest: DIGESTS.setup,
        unattendedPrivilegeExpansion: false
      },
      protocolVersion: 1,
      loadSession: true,
      authMethods: [{ id: "xai", name: "xAI" }],
      models: [{ id: "grok-code-fast-1", efforts: ["low", "high"] }]
    },
    config: { stopReviewGate: false },
    disclosure: "Bounded provider disclosure.",
    nextSteps: ["Run a bounded worker."]
  };
}

function providerIdentity() {
  return {
    device: "1",
    inode: "2",
    size: 1234,
    mtimeMs: 1_753_265_000_000,
    contentDigest: DIGESTS.provider
  };
}

function capabilityFixture() {
  const stable = {
    schemaVersion: 1,
    receiptType: "grok-provider-capability",
    pluginVersion: "0.3.0-dev.1",
    mcpCapabilityContractVersion: "1.1.0",
    platform: "darwin",
    architecture: "arm64",
    providerVersion: "0.2.99",
    providerFileIdentity: providerIdentity(),
    acpProtocolVersion: 1,
    loadSession: true,
    setupProfileDigest: DIGESTS.setup,
    rootReadProfileDigest: DIGESTS.rootRead,
    capabilities: ["root-read-spawn-v1"]
  };
  const body = {
    ...stable,
    issuedAt: "2026-07-23T10:00:00.000Z",
    expiresAt: "2026-07-23T11:00:00.000Z",
    capabilityDigest: digest(stable)
  };
  return { ...body, receiptDigest: digest(body) };
}

function capabilityExpectations() {
  return {
    setup: setupFixture(),
    pluginVersion: "0.3.0-dev.1",
    mcpCapabilityContractVersion: "1.1.0",
    platform: "darwin",
    architecture: "arm64",
    providerFileIdentity: providerIdentity(),
    rootReadProfileDigest: DIGESTS.rootRead,
    observedAt: OBSERVED_AT
  };
}

function initializeFixture() {
  return {
    protocolVersion: "2025-11-25",
    capabilities: {
      tools: { listChanged: false },
      experimental: clone(CODEX_MCP_EXPERIMENTAL_CAPABILITIES)
    },
    serverInfo: { name: "grok-worker-broker", version: "1.1.0" },
    instructions: "External worker broker; host verification is not promoted.",
    _meta: {
      "grok/capability-matrix": clone(EXPECTED_CAPABILITY_MATRIX),
      "grok/capabilityDigest": capabilityFixture().capabilityDigest,
      "grok/hostVerification": "suppressed",
      "grok/supportedProtocolVersions": ["2025-11-25", "2025-06-18", "2024-11-05"],
      "grok/externalWorkerLabel": "external-grok-worker"
    }
  };
}

function initializeExpectations() {
  return {
    serverVersion: "1.1.0",
    capabilityDigest: capabilityFixture().capabilityDigest,
    experimentalCapabilities: clone(CODEX_MCP_EXPERIMENTAL_CAPABILITIES),
    capabilityMatrix: clone(EXPECTED_CAPABILITY_MATRIX)
  };
}

function contextManifestFixture() {
  return {
    schemaVersion: 1,
    manifestId: MANIFEST_ID,
    digest: "e".repeat(64),
    capturedAt: "2026-07-23T10:00:00.000Z",
    projectMarkers: ["package.json"],
    materialization: {
      state: "local_complete",
      reasons: [],
      submodules: [],
      upstreamFreshness: "not_checked"
    },
    git: {
      branch: "main",
      head: "a".repeat(40),
      dirtyDigest: "2".repeat(64),
      dirtyEntryCount: 0,
      ignoredDigest: "3".repeat(64),
      ignoredEntryCount: 0,
      trackedTreeIdentity: "4".repeat(64),
      metadataIdentity: "5".repeat(64),
      insideWorktree: true,
      linkedWorktree: false,
      sparse: false,
      shallow: false,
      upstreamRef: null,
      upstreamCommit: null,
      upstreamFreshness: "not_checked"
    }
  };
}

function taskEnvelopeFixture() {
  return {
    schemaVersion: 1,
    envelopeId: ENVELOPE_ID,
    digest: "d".repeat(64),
    userRequest: "Private provider request which the public projector must omit.",
    objective: "Inspect repository",
    mode: "read",
    scope: { include: [], exclude: [] },
    nonGoals: [],
    acceptanceCriteria: [{ id: "AC-01", text: "Complete the inspection." }],
    requiredVerification: ["node --test"],
    expectedReturnFormat: "Return a structured report.",
    context: {
      facts: [],
      constraints: [],
      expectedProjectMarkers: ["package.json"],
      requiredPaths: [],
      workspaceState: "task_scoped",
      upstreamFreshness: "not_checked"
    },
    contextManifestId: MANIFEST_ID
  };
}

function lifecycleEvents(status, cancellation) {
  const events = [{
    type: "task.accepted",
    at: "2026-07-23T10:00:00.000Z",
    summary: "Accepted",
    sequence: 1,
    detail: {
      spawnSuccessDefinition: "durable-job-commit",
      write: false
    }
  }];
  if (status === "running") {
    events.push({
      type: "activity.started",
      at: "2026-07-23T10:01:30.000Z",
      summary: "Provider started",
      sequence: 2,
      detail: { mode: "read" }
    });
  } else if (status === "completed") {
    events.push({
      type: "activity.started",
      at: "2026-07-23T10:01:30.000Z",
      summary: "Provider started",
      sequence: 2,
      detail: { mode: "read" }
    }, {
      type: "final.report",
      at: "2026-07-23T10:02:20.000Z",
      summary: "Done",
      sequence: 3,
      detail: { outcome: "complete", structured: true }
    }, {
      type: "checkpoint",
      at: "2026-07-23T10:03:00.000Z",
      summary: "Task runtime cleanup completed",
      sequence: 4
    });
  } else if (cancellation) {
    events.push(
      {
        type: "activity.started",
        at: "2026-07-23T10:01:30.000Z",
        summary: "Provider started",
        sequence: 2,
        detail: { mode: "read" }
      },
      {
        type: "checkpoint",
        at: "2026-07-23T10:01:35.000Z",
        summary: "Session created",
        sequence: 3,
        detail: { state: "accepted" }
      },
      {
        type: "activity.started",
        at: "2026-07-23T10:01:40.000Z",
        summary: "Prompt delivered",
        sequence: 4,
        detail: { eventType: "message" }
      },
      {
        type: "plan.updated",
        at: "2026-07-23T10:01:45.000Z",
        summary: "Plan received",
        sequence: 5,
        detail: { plan: ["Inspect"] }
      },
      {
        type: "checkpoint",
        at: "2026-07-23T10:01:50.000Z",
        summary: "Provider active",
        sequence: 6,
        detail: { status: "running" }
      },
      {
        type: "cancellation.requested",
        at: "2026-07-23T10:02:00.000Z",
        summary: "Cancellation requested",
        sequence: 7,
        detail: { requestAcceptedAt: "2026-07-23T10:02:00.000Z" }
      },
      {
        type: "blocked",
        at: "2026-07-23T10:03:00.000Z",
        summary: "Task runtime cleanup completed",
        sequence: 8
      }
    );
  }
  return events;
}

function completionResult() {
  return {
    hostVerification: "not_run",
    taskRuntimeCleaned: true,
    stopReason: "EndTurn",
    textBytes: 10,
    textDigest: "6".repeat(64),
    textTruncated: false,
    interim: {
      bytes: 0,
      digest: crypto.createHash("sha256").update("").digest("hex")
    },
    workerReport: {
      schemaVersion: 1,
      structured: true,
      valid: true,
      outcome: "complete",
      summary: "Done",
      changedFiles: [],
      checksClaimed: ["node --test"],
      acceptanceResults: [{ id: "AC-01", status: "met" }],
      risks: [],
      questions: [],
      validationIssues: []
    },
    providerClaims: {
      success: true,
      outcome: "complete",
      summary: "Done",
      changedFiles: [],
      checksClaimed: ["node --test"],
      observedFileAgreement: true
    }
  };
}

function privateJob(status, { cancellation = false } = {}) {
  const phase = status === "queued"
    ? "accepted"
    : status === "running"
      ? "prompting"
      : status === "completed"
        ? "done"
        : "cancelled";
  const terminal = ["completed", "cancelled"].includes(status);
  return {
    schemaVersion: 3,
    id: WORKER_ID,
    kind: "task",
    jobClass: "task",
    write: false,
    summary: terminal ? (cancellation ? "Cancelled" : "Done") : "Spawn committed",
    progress: terminal
      ? "Terminal record committed."
      : "Durable job record committed; provider not started by broker spawn.",
    createdAt: "2026-07-23T10:00:00.000Z",
    updatedAt: terminal
      ? "2026-07-23T10:03:00.000Z"
      : status === "running"
        ? "2026-07-23T10:01:30.000Z"
        : "2026-07-23T10:00:00.000Z",
    startedAt: status === "queued" ? null : "2026-07-23T10:01:30.000Z",
    completedAt: terminal
      ? cancellation
        ? "2026-07-23T10:02:30.000Z"
        : "2026-07-23T10:02:15.000Z"
      : null,
    heartbeatAt: terminal
      ? "2026-07-23T10:03:00.000Z"
      : status === "running"
        ? "2026-07-23T10:01:30.000Z"
        : "2026-07-23T10:00:00.000Z",
    host: {
      kind: "codex",
      sessionId: HOST_SESSION_ID
    },
    profile: {
      id: "rescue-read-v3",
      contractVersion: 3,
      agentProfileDigest: DIGESTS.rootRead
    },
    role: { id: "explorer" },
    model: null,
    effort: null,
    controlWorkspaceId: CONTROL_WORKSPACE_ID,
    status,
    phase,
    request: {
      envelope: taskEnvelopeFixture(),
      contextManifest: contextManifestFixture(),
      publicObjective: "Inspect repository",
      resumeJobId: null
    },
    latestPlan: ["Inspect"],
    lifecycleEvents: lifecycleEvents(status, cancellation),
    result: status === "completed"
      ? completionResult()
      : cancellation
        ? {
            hostVerification: "not_run",
            taskRuntimeCleaned: true,
            stopReason: "cancelled",
            cancellation: {
              requestAcceptedAt: "2026-07-23T10:02:00.000Z",
              processGroupGoneAt: null,
              terminalRecordCommittedAt: null,
              receiptId: RECEIPT_ID,
              ownerThreadId: "private",
              requestDigest: "private"
            }
          }
        : null,
    error: cancellation
      ? { code: "E_CANCELLED", message: "Cancelled." }
      : null
  };
}

function worker(status, { cancellation = false } = {}) {
  const job = privateJob(status, { cancellation });
  return ["queued", "running"].includes(status)
    ? projectWorkerHandle(job, { trustHostAuthority: false })
    : projectWorkerSnapshot(job, { trustHostAuthority: false });
}

function spawnFixture({ replayed = false } = {}) {
  return {
    ok: true,
    worker: worker(replayed ? "running" : "queued"),
    replayed,
    spawnSuccessDefinition: "durable-job-commit",
    providerLaunchState: replayed ? "started" : "pending",
    providerLaunched: replayed
  };
}

function spawnResponseWitness(workerValue, {
  responseSequence,
  replayed,
  recordedAt
}) {
  const body = {
    schemaVersion: 1,
    projection: "worker-handle-v1-untrusted-host",
    responseSequence,
    workerId: workerValue.id,
    requestDigest: SPAWN_REQUEST_DIGEST,
    idempotencyKeyDigest: SPAWN_IDEMPOTENCY_KEY_DIGEST,
    replayed,
    handleDigest: digest(workerValue),
    eventCursorSequence: workerValue.eventCursor.sequence,
    recordedAt
  };
  return {
    ...body,
    witnessId: `spawnw-${digest(body).slice(0, 24)}`
  };
}

function refreshSpawnResponseWitnessId(witness) {
  const { witnessId: ignoredWitnessId, ...body } = witness;
  witness.witnessId = `spawnw-${digest(body).slice(0, 24)}`;
  return witness;
}

function cancelFixture({ replayed = false } = {}) {
  return {
    ok: true,
    receipt: {
      receiptId: RECEIPT_ID,
      workerId: WORKER_ID,
      status: "accepted",
      requestAcceptedAt: "2026-07-23T10:02:00.000Z",
      processGroupGoneAt: null,
      terminalRecordCommittedAt: null,
      idempotencyKeyDigest: "1".repeat(64),
      cancellationRequestSequence: 7
    },
    replayed
  };
}

function toolResult(structuredContent, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    ...(isError ? { isError: true } : {})
  };
}

function completionBundle() {
  return {
    spawn: spawnFixture(),
    terminalResult: { ok: true, worker: worker("completed", { terminal: true }) }
  };
}

function cancellationBundle() {
  return {
    spawn: spawnFixture(),
    spawnReplay: spawnFixture({ replayed: true }),
    cancel: cancelFixture(),
    cancelReplay: cancelFixture({ replayed: true }),
    terminalResult: {
      ok: true,
      worker: worker("cancelled", { terminal: true, cancellation: true })
    }
  };
}

function privateObservation(scenarioId) {
  const cancellation = scenarioId === "mcp-restart-reconnect-cancellation";
  const count = cancellation ? 3 : 2;
  const publicEvidence = cancellation ? cancellationBundle() : completionBundle();
  const publicWorkers = cancellation
    ? [
        publicEvidence.spawn.worker,
        publicEvidence.spawnReplay.worker,
        publicEvidence.terminalResult.worker
      ]
    : [publicEvidence.spawn.worker, publicEvidence.terminalResult.worker];
  const activeWorkers = publicWorkers.slice(0, -1);
  return {
    scenarioId,
    installedWorkerBinding: {
      workerId: WORKER_ID,
      createdAt: "2026-07-23T10:00:00.000Z",
      model: null,
      effort: null,
      securityProfile: {
        id: "rescue-read-v3",
        contractVersion: 3,
        agentProfileDigest: DIGESTS.rootRead
      },
      taskEnvelopeId: ENVELOPE_ID,
      taskEnvelopeDigest: "d".repeat(64),
      contextManifestId: MANIFEST_ID,
      contextDigest: "e".repeat(64),
      workspaceSnapshotDigest: "e".repeat(64),
      controlWorkspaceId: CONTROL_WORKSPACE_ID,
      hostTaskBinding: HOST_TASK_BINDING
    },
    observedPublicWorkerDigests: publicWorkers.map((workerValue) => (
      digest(workerValue)
    )),
    observedSpawnResponseWitnesses: activeWorkers.map(
      (workerValue, index) => spawnResponseWitness(workerValue, {
        responseSequence: index + 1,
        replayed: index === 1,
        recordedAt: index === 0
          ? "2026-07-23T10:00:00.100Z"
          : "2026-07-23T10:01:30.100Z"
      })
    ),
    observedWorkerIds: Array(count).fill(WORKER_ID),
    observedTaskEnvelopeIds: Array(count).fill(ENVELOPE_ID),
    observedContextManifestIds: Array(count).fill(MANIFEST_ID),
    observedProviderGenerations: Array(cancellation ? 2 : 1).fill(1),
    observedProviderWorkerIds: Array(cancellation ? 2 : 1).fill(WORKER_ID),
    observedCancellationReceiptIds: cancellation ? [RECEIPT_ID, RECEIPT_ID] : [],
    spawnInvocationCount: cancellation ? 2 : 1,
    spawnReplayCount: cancellation ? 1 : 0,
    providerLaunchCount: 1,
    providerTerminalCount: 1,
    workerTerminalCount: 1,
    resultReadCount: 1,
    reconnectCount: cancellation ? 1 : 0,
    cancelInvocationCount: cancellation ? 2 : 0,
    cancelReplayCount: cancellation ? 1 : 0,
    uniqueCancelRequestCount: cancellation ? 1 : 0,
    cancellationEventCount: cancellation ? 1 : 0,
    duplicateLaunchCount: 0,
    workerHostVerification: "not_run",
    processGroupGone: true,
    taskRuntimeCleaned: true,
    providerGuardAbsent: true,
    runnerTemporaryArtifactsRemoved: true,
    qualificationSessionDeleted: true
  };
}

function assertContractError(code) {
  return (error) => {
    assert.ok(error instanceof InstalledWorkerMcpContractError);
    assert.equal(error.code, code);
    assert.equal(error.stack, `${error.name}: ${error.message}`);
    return true;
  };
}

test("installed setup requires semantic readiness, not a successful process exit", () => {
  const ready = validateInstalledSetup(setupFixture());
  assert.equal(ready.ready, true);
  assert.equal(ready.grok.acpIsolation.permissionMode, "dontAsk");

  const notReady = setupFixture();
  notReady.ready = false;
  assert.throws(
    () => validateInstalledSetup(notReady),
    assertContractError("E_LIVE_SETUP")
  );

  for (const mutate of [
    (value) => { value.grok.authenticated = false; },
    (value) => { value.grok.protocolVersion = 2; },
    (value) => { value.grok.loadSession = false; },
    (value) => { value.grok.acpIsolation.sandbox = "workspace-write"; },
    (value) => { value.grok.acpIsolation.permissionMode = "ask"; },
    (value) => { value.grok.acpIsolation.injectDefaultTools = true; },
    (value) => { value.grok.acpIsolation.allowedTools = []; },
    (value) => { value.grok.acpIsolation.allowedTools = ["todo_write", "read_file"]; },
    (value) => { value.grok.acpIsolation.unattendedPrivilegeExpansion = true; },
    (value) => { value.grok.binary = "relative/grok"; },
    (value) => { value.grok.version = "unbounded-version"; }
  ]) {
    const drift = setupFixture();
    mutate(drift);
    assert.throws(
      () => validateInstalledSetup(drift),
      assertContractError("E_LIVE_SETUP")
    );
  }
});

test("hostile setup input rejects accessors, cycles, non-JSON values, and oversize text", () => {
  let getterCalls = 0;
  const accessor = setupFixture();
  Object.defineProperty(accessor, "ready", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return true;
    }
  });
  assert.throws(
    () => validateInstalledSetup(accessor),
    assertContractError("E_LIVE_SETUP")
  );
  assert.equal(getterCalls, 0);

  const cyclic = setupFixture();
  cyclic.config.cycle = cyclic;
  assert.throws(
    () => validateInstalledSetup(cyclic),
    assertContractError("E_LIVE_SETUP")
  );

  const oversized = setupFixture();
  oversized.disclosure = "x".repeat((1024 * 1024) + 1);
  assert.throws(
    () => validateInstalledSetup(oversized),
    assertContractError("E_LIVE_SETUP")
  );

  const nonJson = setupFixture();
  nonJson.config.invalid = 1n;
  assert.throws(
    () => validateInstalledSetup(nonJson),
    assertContractError("E_LIVE_SETUP")
  );
});

test("capability receipt is cryptographically bound to setup and installed identity", () => {
  const receipt = validateProviderCapabilityAgreement(
    capabilityFixture(),
    capabilityExpectations()
  );
  assert.equal(receipt.capabilities[0], "root-read-spawn-v1");
  assert.equal(receipt.providerVersion, setupFixture().grok.version);
});

test("capability agreement fails on every identity, profile, protocol, and digest drift", () => {
  const cases = [
    (receipt) => { receipt.pluginVersion = "0.3.0-drift"; },
    (receipt) => { receipt.mcpCapabilityContractVersion = "9.9.9"; },
    (receipt) => { receipt.providerVersion = "9.9.9"; },
    (receipt) => { receipt.acpProtocolVersion = 2; },
    (receipt) => { receipt.loadSession = false; },
    (receipt) => { receipt.setupProfileDigest = "9".repeat(64); },
    (receipt) => { receipt.rootReadProfileDigest = "8".repeat(64); },
    (receipt) => { receipt.providerFileIdentity.inode = "999"; },
    (receipt) => { receipt.capabilityDigest = "7".repeat(64); },
    (receipt) => { receipt.receiptDigest = "6".repeat(64); }
  ];
  for (const mutate of cases) {
    const receipt = capabilityFixture();
    mutate(receipt);
    assert.throws(
      () => validateProviderCapabilityAgreement(receipt, capabilityExpectations()),
      assertContractError("E_LIVE_CAPABILITY")
    );
  }

  const expired = capabilityExpectations();
  expired.observedAt = Date.parse("2026-07-23T11:00:00.000Z");
  assert.throws(
    () => validateProviderCapabilityAgreement(capabilityFixture(), expired),
    assertContractError("E_LIVE_CAPABILITY")
  );
});

test("initialize binds protocol, server identity, capability digest, and suppressed host authority", () => {
  assert.equal(
    validateInstalledInitialize(initializeFixture(), initializeExpectations()),
    true
  );

  for (const mutate of [
    (value) => { value.protocolVersion = "2025-06-18"; },
    (value) => { value.serverInfo.name = "lookalike-broker"; },
    (value) => { value.serverInfo.version = "1.0.0"; },
    (value) => { value._meta["grok/capabilityDigest"] = "0".repeat(64); },
    (value) => { value._meta["grok/hostVerification"] = "passed"; },
    (value) => { value.capabilities.tools.listChanged = true; },
    (value) => {
      value.capabilities.experimental = {
        "io.modelcontextprotocol/sandbox-state": { version: "1" }
      };
    },
    (value) => { value._meta["grok/capability-matrix"] = {}; }
  ]) {
    const result = initializeFixture();
    mutate(result);
    assert.throws(
      () => validateInstalledInitialize(result, initializeExpectations()),
      assertContractError("E_LIVE_INITIALIZE")
    );
  }
});

test("tool inventory requires exact installed WORKER_TOOLS equality and fixed order", () => {
  const expected = clone(WORKER_TOOLS);
  const validated = validateInstalledToolInventory({ tools: clone(expected) }, expected);
  assert.deepEqual(validated.map((tool) => tool.name), INSTALLED_WORKER_TOOL_NAMES);

  const reordered = clone(expected);
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  assert.throws(
    () => validateInstalledToolInventory({ tools: reordered }, expected),
    assertContractError("E_LIVE_TOOLS")
  );

  const schemaDrift = clone(expected);
  schemaDrift[5].inputSchema.properties.write = { type: "boolean" };
  assert.throws(
    () => validateInstalledToolInventory({ tools: schemaDrift }, expected),
    assertContractError("E_LIVE_TOOLS")
  );

  const expectedDrift = clone(expected);
  expectedDrift[0].description = "drift";
  assert.throws(
    () => validateInstalledToolInventory({ tools: clone(expected) }, expectedDrift),
    assertContractError("E_LIVE_TOOLS")
  );
});

test("structured tool results require exact mirrored success and error envelopes", () => {
  const success = toolResult({ ok: true, workers: [] });
  assert.deepEqual(
    clone(validateInstalledToolResult(success, {
      outcome: "ok",
      expectedPayloadKeys: ["workers"],
      expectedStructuredContent: { ok: true, workers: [] }
    })),
    { ok: true, workers: [] }
  );

  const unauthorized = toolResult({
    ok: false,
    error: {
      code: "E_AUTH_REQUIRED",
      message: "Trusted Codex task identity is unavailable."
    }
  }, true);
  assert.equal(
    validateInstalledToolResult(unauthorized, {
      outcome: "error",
      expectedErrorCode: "E_AUTH_REQUIRED"
    }).error.code,
    "E_AUTH_REQUIRED"
  );

  const textDrift = clone(success);
  textDrift.content[0].text = JSON.stringify({ ok: true, workers: ["forged"] });
  assert.throws(
    () => validateInstalledToolResult(textDrift, {
      outcome: "ok",
      expectedPayloadKeys: ["workers"]
    }),
    assertContractError("E_LIVE_TOOL_RESULT")
  );

  const shapeDrift = clone(unauthorized);
  shapeDrift.structuredContent.error.detail = "hidden";
  shapeDrift.content[0].text = JSON.stringify(shapeDrift.structuredContent);
  assert.throws(
    () => validateInstalledToolResult(shapeDrift, {
      outcome: "error",
      expectedErrorCode: "E_AUTH_REQUIRED"
    }),
    assertContractError("E_LIVE_TOOL_RESULT")
  );
});

test("tool result rejects provider attempts to promote host verification", () => {
  const promoted = toolResult({
    ok: true,
    worker: { result: { hostVerification: "passed" } }
  });
  assert.throws(
    () => validateInstalledToolResult(promoted, {
      outcome: "ok",
      expectedPayloadKeys: ["worker"]
    }),
    assertContractError("E_LIVE_TOOL_RESULT")
  );
});

test("completion scenario binds the terminal public worker and suppresses host claims", () => {
  const valid = validateInstalledCompletionScenario(completionBundle());
  assert.equal(valid.terminalResult.worker.status, "completed");

  const identityDrift = completionBundle();
  identityDrift.terminalResult.worker.contextManifestId = "ctx-drift";
  assert.throws(
    () => validateInstalledCompletionScenario(identityDrift),
    assertContractError("E_LIVE_COMPLETION")
  );

  const identicallyMissing = completionBundle();
  delete identicallyMissing.spawn.worker.taskEnvelopeId;
  delete identicallyMissing.terminalResult.worker.taskEnvelopeId;
  assert.throws(
    () => validateInstalledCompletionScenario(identicallyMissing),
    assertContractError("E_LIVE_COMPLETION")
  );

  const identicallyNull = completionBundle();
  identicallyNull.spawn.worker.controlWorkspaceId = null;
  identicallyNull.terminalResult.worker.controlWorkspaceId = null;
  assert.throws(
    () => validateInstalledCompletionScenario(identicallyNull),
    assertContractError("E_LIVE_COMPLETION")
  );

  const semanticDrifts = [
    (value) => {
      value.spawn.worker.kind = "review";
      value.terminalResult.worker.kind = "review";
    },
    (value) => {
      value.spawn.worker.jobClass = "review";
      value.terminalResult.worker.jobClass = "review";
    },
    (value) => {
      value.spawn.worker.write = true;
      value.terminalResult.worker.write = true;
    },
    (value) => {
      value.spawn.worker.lineageWorkerId = "task-ffffffffffffffff";
      value.terminalResult.worker.lineageWorkerId = "task-ffffffffffffffff";
    },
    (value) => {
      value.spawn.worker.parentWorkerId = "task-ffffffffffffffff";
      value.terminalResult.worker.parentWorkerId = "task-ffffffffffffffff";
    },
    (value) => {
      value.terminalResult.worker.securityProfile.agentProfileDigest =
        "f".repeat(64);
    },
    (value) => {
      value.terminalResult.worker.model = "grok-code-fast-1";
    },
    (value) => {
      value.terminalResult.worker.effort = "high";
    },
    (value) => {
      value.terminalResult.worker.createdAt = "2026-07-23T09:59:59.000Z";
    },
    (value) => {
      value.spawn.worker.status = "cancelled";
      value.spawn.worker.phase = "cancelled";
    }
  ];
  for (const mutate of semanticDrifts) {
    const drift = completionBundle();
    mutate(drift);
    assert.throws(
      () => validateInstalledCompletionScenario(drift),
      assertContractError("E_LIVE_COMPLETION")
    );
  }

  const hostDrift = completionBundle();
  hostDrift.terminalResult.worker.result.hostVerification = "passed";
  assert.throws(
    () => validateInstalledCompletionScenario(hostDrift),
    assertContractError("E_LIVE_COMPLETION")
  );

  const cleanupDrift = completionBundle();
  cleanupDrift.terminalResult.worker.result.taskRuntimeCleaned = false;
  assert.throws(
    () => validateInstalledCompletionScenario(cleanupDrift),
    assertContractError("E_LIVE_COMPLETION")
  );
});

test("spawn accepts the actual public handle and rejects every shape or identity escape", () => {
  const actual = completionBundle();
  assert.equal(actual.spawn.worker.workerProtocolVersion, 1);
  assert.equal(actual.spawn.worker.handleSchemaVersion, 1);
  assert.deepEqual(actual.spawn.worker.eventCursor, {
    schemaVersion: 1,
    workerId: WORKER_ID,
    sequence: 1
  });
  assert.deepEqual(actual.spawn.worker.securityProfile, {
    id: "rescue-read-v3",
    contractVersion: 3,
    agentProfileDigest: DIGESTS.rootRead
  });
  assert.doesNotThrow(() => validateInstalledCompletionScenario(actual));

  const mutations = [
    (value) => { value.spawn.worker.providerProcess = { pid: 42 }; },
    (value) => { value.spawn.worker.nonce = "private"; },
    (value) => {
      value.spawn.worker.host = { kind: "codex", sessionId: HOST_SESSION_ID };
    },
    (value) => { value.spawn.worker.futurePublicField = true; },
    (value) => {
      value.spawn.worker.summary = "Read /private/tmp/provider-session.json";
    },
    (value) => { value.spawn.worker.workerProtocolVersion = 2; },
    (value) => { value.spawn.worker.handleSchemaVersion = 2; },
    (value) => { value.spawn.worker.eventCursor.schemaVersion = 2; },
    (value) => {
      value.spawn.worker.eventCursor.workerId = "task-ffffffffffffffff";
    },
    (value) => { value.spawn.worker.eventCursor.sequence = -1; },
    (value) => { value.spawn.worker.eventCursor.sequence = 0; },
    (value) => { value.spawn.worker.eventCursor.sequence = 1.5; },
    (value) => { value.spawn.worker.eventCursor.sequence = 999; },
    (value) => {
      value.spawn.worker.phase = "provider-launching";
      value.spawn.worker.eventCursor.sequence = 2;
    },
    (value) => { value.spawn.worker.eventCursor.nonce = "private"; },
    (value) => { value.spawn.worker.securityProfile.id = "rescue-write-v3"; },
    (value) => { value.spawn.worker.securityProfile.contractVersion = 2; },
    (value) => {
      value.spawn.worker.securityProfile.agentProfileDigest = "not-a-digest";
    },
    (value) => { value.spawn.worker.securityProfile.host = "private"; },
    (value) => { value.spawn.worker.profileId = null; },
    (value) => { value.spawn.worker.externalWorkerLabel = "native-worker"; }
  ];
  for (const mutate of mutations) {
    const evidence = completionBundle();
    mutate(evidence);
    assert.throws(
      () => validateInstalledCompletionScenario(evidence),
      assertContractError("E_LIVE_COMPLETION")
    );
  }

  const equalTerminalCursor = completionBundle();
  equalTerminalCursor.spawn.worker = worker("running");
  equalTerminalCursor.spawn.worker.phase = "starting";
  equalTerminalCursor.spawn.worker.eventCursor.sequence =
    equalTerminalCursor.terminalResult.worker.eventCursor.sequence;
  assert.throws(
    () => validateInstalledCompletionScenario(equalTerminalCursor),
    assertContractError("E_LIVE_COMPLETION")
  );
});

test("public evidence rejects local paths after every punctuation and in nested values", () => {
  const pathEscapes = [
    "secret=/private/tmp/provider.json",
    "secret:/Users/alice/provider.json",
    "secret,/home/alice/provider.json",
    "secret;/root/provider.json",
    "{\"path\":\"/opt/grok/private.json\"}",
    "source=~/provider.json",
    "source=file:///etc/passwd",
    "source=C:\\Users\\alice\\provider.json",
    "source=\\\\server\\share\\provider.json",
    "source=//server/share/provider.json"
  ];
  for (const escaped of pathEscapes) {
    const handleEvidence = completionBundle();
    handleEvidence.spawn.worker.summary = escaped;
    assert.throws(
      () => validateInstalledCompletionScenario(handleEvidence),
      assertContractError("E_LIVE_COMPLETION")
    );

    const nestedEvidence = completionBundle();
    nestedEvidence.terminalResult.worker.result.workerReport.risks = [escaped];
    assert.throws(
      () => validateInstalledCompletionScenario(nestedEvidence),
      assertContractError("E_LIVE_COMPLETION")
    );
  }
});

test("terminal worker_result accepts the production snapshot and rejects private data recursively", () => {
  const actual = completionBundle();
  const snapshot = actual.terminalResult.worker;
  assert.equal(snapshot.workerProtocolVersion, 1);
  assert.equal(snapshot.snapshotSchemaVersion, 1);
  assert.equal(snapshot.schemaVersion, 3);
  assert.equal(snapshot.result.workerReport.outcome, "complete");
  assert.equal(snapshot.result.providerClaims.observedFileAgreement, true);
  assert.equal(snapshot.result.hostVerification, "not_run");
  assert.doesNotThrow(() => validateInstalledCompletionScenario(actual));

  const mutations = [
    (value) => {
      value.terminalResult.worker.providerProcess = { pid: 42 };
    },
    (value) => { value.terminalResult.worker.host = { sessionId: "private" }; },
    (value) => { value.terminalResult.worker.nonce = "private"; },
    (value) => { value.terminalResult.worker.snapshotSchemaVersion = 2; },
    (value) => { value.terminalResult.worker.schemaVersion = 4; },
    (value) => {
      value.terminalResult.worker.eventCursor.sequence = -1;
    },
    (value) => {
      value.terminalResult.worker.securityProfile.agentProfileDigest = "0";
    },
    (value) => {
      value.terminalResult.worker.result.providerProcess = { pid: 42 };
    },
    (value) => {
      value.terminalResult.worker.result.workerReport.rawProviderMessage = "private";
    },
    (value) => {
      value.terminalResult.worker.result.workerReport.changedFiles = [
        "/private/tmp/secret.txt"
      ];
    },
    (value) => {
      value.terminalResult.worker.result.workerReport.summary =
        "Provider output at /Users/alice/private.txt";
    },
    (value) => {
      value.terminalResult.worker.taskContract.context.prompt = "raw prompt";
    },
    (value) => {
      value.terminalResult.worker.context.materialization.workspaceRoot =
        "/private/tmp/workspace";
    },
    (value) => {
      value.terminalResult.worker.lifecycleEvents[0].detail.rawProviderMessages = [];
    },
    (value) => {
      value.terminalResult.worker.lifecycleEvents[0].detail.futureField = true;
    },
    (value) => {
      value.terminalResult.worker.lifecycleEvents[0].detail.write = true;
    },
    (value) => {
      value.terminalResult.worker.result.hostVerification = "passed";
    },
    (value) => {
      value.terminalResult.worker.result.runtimeEvidence = {
        hostVerification: "passed"
      };
    },
    (value) => {
      value.terminalResult.worker.result.workerReport.changedFiles = [
        "../outside.txt"
      ];
    }
  ];
  for (const mutate of mutations) {
    const evidence = completionBundle();
    mutate(evidence);
    assert.throws(
      () => validateInstalledCompletionScenario(evidence),
      assertContractError("E_LIVE_COMPLETION")
    );
  }
});

test("worker and lifecycle chronology is state-aware and keeps later cleanup checkpoints", () => {
  const positive = completionBundle();
  const completed = positive.terminalResult.worker;
  const cleanup = completed.lifecycleEvents.at(-1);
  assert.equal(cleanup.type, "checkpoint");
  assert.ok(Date.parse(cleanup.at) > Date.parse(completed.completedAt));
  assert.ok(Date.parse(cleanup.at) <= Date.parse(completed.updatedAt));
  assert.doesNotThrow(() => validateInstalledCompletionScenario(positive));

  const finalReportAtIntent = completionBundle();
  finalReportAtIntent.terminalResult.worker.lifecycleEvents
    .find((event) => event.type === "final.report")
    .at = finalReportAtIntent.terminalResult.worker.completedAt;
  assert.doesNotThrow(
    () => validateInstalledCompletionScenario(finalReportAtIntent)
  );

  const mutations = [
    (value) => {
      value.spawn.worker.createdAt = "2026-07-23T10:00:01.000Z";
    },
    (value) => {
      value.spawn.worker.heartbeatAt = "2026-07-23T10:00:01.000Z";
    },
    (value) => {
      value.spawn.worker.heartbeatAt = "2030-01-01T00:00:00.000Z";
      value.spawn.worker.updatedAt = "2030-01-01T00:00:00.000Z";
    },
    (value) => {
      value.spawn.worker = worker("running");
      value.spawn.worker.startedAt = "2026-07-23T09:59:59.000Z";
    },
    (value) => {
      value.spawn.worker = worker("running");
      value.spawn.worker.phase = "starting";
      value.spawn.worker.startedAt = "2026-07-23T10:01:20.000Z";
    },
    (value) => {
      value.terminalResult.worker.startedAt = "2026-07-23T09:59:59.000Z";
    },
    (value) => {
      value.terminalResult.worker.completedAt = "2026-07-23T10:01:00.000Z";
    },
    (value) => {
      value.terminalResult.worker.heartbeatAt = "2026-07-23T10:02:00.000Z";
    },
    (value) => {
      value.terminalResult.worker.updatedAt = "2026-07-23T10:02:59.000Z";
    },
    (value) => {
      value.terminalResult.worker.lifecycleEvents[0].sequence = 2;
    },
    (value) => {
      value.terminalResult.worker.lifecycleEvents[0].type = "checkpoint";
    },
    (value) => {
      const events = value.terminalResult.worker.lifecycleEvents;
      const duplicate = clone(events[0]);
      duplicate.at = "2026-07-23T10:00:30.000Z";
      value.terminalResult.worker.lifecycleEvents = [
        events[0],
        duplicate,
        ...events.slice(1)
      ].map((event, index) => ({ ...event, sequence: index + 1 }));
      value.terminalResult.worker.eventCursor.sequence =
        value.terminalResult.worker.lifecycleEvents.length;
    },
    (value) => {
      delete value.terminalResult.worker.lifecycleEvents[0].detail;
    },
    (value) => {
      delete value.terminalResult.worker.lifecycleEvents[0].detail.write;
    },
    (value) => {
      value.terminalResult.worker.lifecycleEvents[0].detail
        .spawnSuccessDefinition = "provider-start";
    },
    (value) => {
      value.terminalResult.worker.lifecycleEvents[0].detail.mode = "read";
    },
    (value) => {
      const event = value.terminalResult.worker.lifecycleEvents[1];
      event.type = "cancellation.requested";
      event.detail = { requestAcceptedAt: event.at };
    },
    (value) => {
      value.terminalResult.worker.lifecycleEvents[0].at =
        "2026-07-23T09:59:59.000Z";
    },
    (value) => {
      value.terminalResult.worker.lifecycleEvents[0].at =
        "2026-07-23T10:01:31.000Z";
    },
    (value) => {
      value.terminalResult.worker.lifecycleEvents[2].at =
        "2026-07-23T10:01:20.000Z";
    },
    (value) => {
      value.terminalResult.worker.lifecycleEvents
        .find((event) => event.type === "final.report")
        .at = "2026-07-23T10:02:10.000Z";
    },
    (value) => {
      value.terminalResult.worker.lifecycleEvents.at(-1).at =
        "2026-07-23T10:03:01.000Z";
    },
    (value) => {
      value.terminalResult.worker.lifecycleEvents.at(-1).type =
        "activity.started";
    },
    (value) => {
      const event = value.terminalResult.worker.lifecycleEvents.at(-1);
      event.at = "2026-07-23T10:02:25.000Z";
      event.type = "activity.started";
    },
    (value) => {
      const event = value.terminalResult.worker.lifecycleEvents.at(-1);
      event.at = "2026-07-23T10:02:25.000Z";
      event.type = "plan.updated";
      event.detail = { plan: ["Late plan"] };
    },
    (value) => {
      const event = value.terminalResult.worker.lifecycleEvents.at(-1);
      event.at = "2026-07-23T10:02:25.000Z";
      event.type = "final.report";
      event.detail = { outcome: "complete", structured: true };
    },
    (value) => {
      const event = value.terminalResult.worker.lifecycleEvents.at(-1);
      event.at = "2026-07-23T10:02:25.000Z";
      event.type = "cancellation.requested";
      event.detail = { requestAcceptedAt: event.at };
    },
    (value) => {
      value.terminalResult.worker.lifecycleEvents[1].at =
        "2026-07-23T10:01:00.000Z";
      value.terminalResult.worker.lifecycleEvents[2].at =
        "2026-07-23T10:01:10.000Z";
    },
    (value) => {
      value.terminalResult.worker.lifecycleEvents[2].at =
        "2026-07-23T10:03:01.000Z";
    },
    (value) => {
      value.terminalResult.worker.lifecycleEvents[2].detail.outcome = "partial";
    },
    (value) => {
      value.terminalResult.worker.lifecycleEvents[2].detail.structured = false;
    }
  ];
  for (const mutate of mutations) {
    const evidence = completionBundle();
    mutate(evidence);
    assert.throws(
      () => validateInstalledCompletionScenario(evidence),
      assertContractError("E_LIVE_COMPLETION")
    );
  }
});

test("completion binds every acceptance criterion and provider claim to the report", () => {
  const mutations = [
    (value) => {
      value.terminalResult.worker.taskContract.acceptanceCriteria = [];
      value.terminalResult.worker.result.workerReport.acceptanceResults = [];
    },
    (value) => {
      value.terminalResult.worker.result.workerReport.acceptanceResults = [];
    },
    (value) => {
      value.terminalResult.worker.result.workerReport.acceptanceResults = [
        { id: "AC-01", status: "met" },
        { id: "AC-01", status: "met" }
      ];
    },
    (value) => {
      value.terminalResult.worker.result.workerReport.acceptanceResults[0].id =
        "AC-02";
    },
    (value) => {
      value.terminalResult.worker.result.workerReport.acceptanceResults[0].status =
        "unmet";
    },
    (value) => {
      value.terminalResult.worker.taskContract.acceptanceCriteria.push({
        id: "AC-01",
        text: "Duplicate criterion."
      });
    },
    (value) => {
      value.terminalResult.worker.result.providerClaims.summary = "Drift";
    },
    (value) => {
      value.terminalResult.worker.result.workerReport.checksClaimed = [
        "node --test",
        "npm test"
      ];
      value.terminalResult.worker.result.providerClaims.checksClaimed = [
        "npm test",
        "node --test"
      ];
    },
    (value) => {
      value.terminalResult.worker.result.providerClaims.changedFiles = [
        "tracked.txt"
      ];
    }
  ];
  for (const mutate of mutations) {
    const evidence = completionBundle();
    mutate(evidence);
    assert.throws(
      () => validateInstalledCompletionScenario(evidence),
      assertContractError("E_LIVE_COMPLETION")
    );
  }
});

test("non-replayed spawn accepts only the committed initial handle", () => {
  assert.doesNotThrow(
    () => validateInstalledCompletionScenario(completionBundle())
  );
  const rejected = [
    (value) => {
      value.spawn.worker.status = "failed";
      value.spawn.worker.phase = "failed";
    },
    (value) => {
      value.spawn.worker.phase = "provider-launching";
    },
    (value) => {
      value.spawn.worker = worker("running");
      value.spawn.worker.phase = "starting";
    },
    (value) => { value.spawn.worker.terminal = true; },
    (value) => {
      value.spawn.worker.completedAt = "2026-07-23T10:02:00.000Z";
    },
    (value) => {
      value.spawn.worker.status = "queued";
      value.spawn.worker.phase = "accepted";
      value.spawn.worker.startedAt = "2026-07-23T10:01:30.000Z";
    },
    (value) => {
      value.spawn.worker.status = "running";
      value.spawn.worker.phase = "starting";
      value.spawn.worker.startedAt = null;
    },
    (value) => {
      value.spawn.worker.status = "queued";
      value.spawn.worker.phase = "starting";
      value.spawn.worker.startedAt = null;
    },
    (value) => {
      value.spawn.worker.status = "running";
      value.spawn.worker.phase = "accepted";
      value.spawn.worker.startedAt = "2026-07-23T10:01:30.000Z";
    },
    (value) => {
      value.spawn.worker.summary = "Provider launch started";
    },
    (value) => {
      value.spawn.worker.progress = "Provider is starting.";
    },
    (value) => {
      value.spawn.worker.eventCursor.sequence = 2;
    },
    (value) => {
      value.spawn.worker.updatedAt = "2026-07-23T10:00:01.000Z";
      value.spawn.worker.heartbeatAt = "2026-07-23T10:00:01.000Z";
    },
    (value) => {
      value.spawn.worker.model = "grok-code-fast-1";
    },
    (value) => {
      value.spawn.worker.effort = "high";
    }
  ];
  for (const mutate of rejected) {
    const evidence = completionBundle();
    mutate(evidence);
    assert.throws(
      () => validateInstalledCompletionScenario(evidence),
      assertContractError("E_LIVE_COMPLETION")
    );
  }
});

test("cancellation replay preserves immutable admission receipt and one public event", () => {
  const valid = validateInstalledCancellationReplayScenario(cancellationBundle());
  assert.equal(valid.cancel.replayed, false);
  assert.equal(valid.cancelReplay.replayed, true);
  assert.equal(valid.cancel.receipt.processGroupGoneAt, null);
  assert.ok(
    Date.parse(valid.terminalResult.worker.lifecycleEvents.at(-1).at)
      > Date.parse(valid.terminalResult.worker.completedAt)
  );
  assert.deepEqual(clone(valid.terminalResult.worker.error), {
    workerProtocolVersion: 1,
    errorSchemaVersion: 1,
    code: "E_CANCELLED",
    message: "Cancelled."
  });

  const receiptDrift = cancellationBundle();
  receiptDrift.cancelReplay.receipt.receiptId = "cancel-ffffffffffffffffffffffff";
  assert.throws(
    () => validateInstalledCancellationReplayScenario(receiptDrift),
    assertContractError("E_LIVE_CANCELLATION")
  );

  const mutableReceipt = cancellationBundle();
  mutableReceipt.cancel.receipt.processGroupGoneAt = "2026-07-23T10:03:00.000Z";
  assert.throws(
    () => validateInstalledCancellationReplayScenario(mutableReceipt),
    assertContractError("E_LIVE_CANCELLATION")
  );

  const duplicateEvent = cancellationBundle();
  duplicateEvent.terminalResult.worker.lifecycleEvents.push({
    sequence: 8,
    type: "cancellation.requested"
  });
  assert.throws(
    () => validateInstalledCancellationReplayScenario(duplicateEvent),
    assertContractError("E_LIVE_CANCELLATION")
  );

  const sequenceDrift = cancellationBundle();
  sequenceDrift.terminalResult.worker.lifecycleEvents[0].sequence = 8;
  assert.throws(
    () => validateInstalledCancellationReplayScenario(sequenceDrift),
    assertContractError("E_LIVE_CANCELLATION")
  );

  const preterminalCancelled = cancellationBundle();
  preterminalCancelled.terminalResult.worker.terminal = false;
  assert.throws(
    () => validateInstalledCancellationReplayScenario(preterminalCancelled),
    assertContractError("E_LIVE_CANCELLATION")
  );

  const replayReview = cancellationBundle();
  replayReview.spawnReplay.worker.kind = "review";
  assert.throws(
    () => validateInstalledCancellationReplayScenario(replayReview),
    assertContractError("E_LIVE_CANCELLATION")
  );

  const replayCursorInversion = cancellationBundle();
  replayCursorInversion.spawnReplay.worker.eventCursor.sequence = 0;
  assert.throws(
    () => validateInstalledCancellationReplayScenario(replayCursorInversion),
    assertContractError("E_LIVE_CANCELLATION")
  );

  const replayAtCancellationCursor = cancellationBundle();
  replayAtCancellationCursor.spawnReplay.worker.eventCursor.sequence =
    replayAtCancellationCursor.cancel.receipt.cancellationRequestSequence;
  assert.throws(
    () => validateInstalledCancellationReplayScenario(
      replayAtCancellationCursor
    ),
    assertContractError("E_LIVE_CANCELLATION")
  );

  const replayAtTerminalCursor = cancellationBundle();
  replayAtTerminalCursor.spawnReplay.worker.eventCursor.sequence =
    replayAtTerminalCursor.terminalResult.worker.eventCursor.sequence;
  assert.throws(
    () => validateInstalledCancellationReplayScenario(replayAtTerminalCursor),
    assertContractError("E_LIVE_CANCELLATION")
  );

  const replayAfterTerminalTime = cancellationBundle();
  replayAfterTerminalTime.spawnReplay.worker.heartbeatAt =
    "2030-01-01T00:00:00.000Z";
  replayAfterTerminalTime.spawnReplay.worker.updatedAt =
    "2030-01-01T00:00:00.000Z";
  assert.throws(
    () => validateInstalledCancellationReplayScenario(replayAfterTerminalTime),
    assertContractError("E_LIVE_CANCELLATION")
  );

  const replayStartedAtDrift = cancellationBundle();
  replayStartedAtDrift.spawnReplay.worker.startedAt =
    "2026-07-23T10:01:20.000Z";
  assert.throws(
    () => validateInstalledCancellationReplayScenario(replayStartedAtDrift),
    assertContractError("E_LIVE_CANCELLATION")
  );

  for (const mutate of [
    (value) => { value.terminalResult.worker.error = null; },
    (value) => { value.terminalResult.worker.error.code = "E_TIMEOUT"; },
    (value) => {
      value.terminalResult.worker.error.details = { nonce: "private" };
    },
    (value) => {
      value.terminalResult.worker.result.cancellation.providerProcess = {
        pid: 42
      };
    },
    (value) => {
      value.terminalResult.worker.result.workerReport = {
        rawProviderMessage: "private"
      };
    },
    (value) => {
      const event = value.terminalResult.worker.lifecycleEvents[2];
      event.type = "final.report";
      event.detail = { outcome: "complete", structured: true };
    },
    (value) => {
      const event = value.terminalResult.worker.lifecycleEvents.at(-1);
      event.at = "2026-07-23T10:02:15.000Z";
      event.type = "activity.started";
    },
    (value) => {
      const event = value.terminalResult.worker.lifecycleEvents.at(-1);
      event.at = "2026-07-23T10:02:15.000Z";
      event.type = "plan.updated";
      event.detail = { plan: ["Late plan"] };
    },
    (value) => {
      value.terminalResult.worker.lifecycleEvents[2].sequence += 1;
    },
    (value) => {
      value.terminalResult.worker.lifecycleEvents
        .find((event) => event.type === "cancellation.requested")
        .detail.requestAcceptedAt = "2026-07-23T10:02:01.000Z";
    },
    (value) => {
      const acceptedAt = "2026-07-23T10:02:31.000Z";
      value.cancel.receipt.requestAcceptedAt = acceptedAt;
      value.cancelReplay.receipt.requestAcceptedAt = acceptedAt;
      value.terminalResult.worker.result.cancellation.requestAcceptedAt =
        acceptedAt;
      const event = value.terminalResult.worker.lifecycleEvents
        .find((entry) => entry.type === "cancellation.requested");
      event.at = acceptedAt;
      event.detail.requestAcceptedAt = acceptedAt;
    },
    (value) => {
      const acceptedAt = "2026-07-23T10:01:00.000Z";
      const events = value.terminalResult.worker.lifecycleEvents;
      const cancellationEvent = events[6];
      cancellationEvent.at = acceptedAt;
      cancellationEvent.detail.requestAcceptedAt = acceptedAt;
      value.terminalResult.worker.lifecycleEvents = [
        events[0],
        cancellationEvent,
        ...events.slice(1, 6),
        events[7]
      ].map((event, index) => ({ ...event, sequence: index + 1 }));
      value.cancel.receipt.requestAcceptedAt = acceptedAt;
      value.cancelReplay.receipt.requestAcceptedAt = acceptedAt;
      value.cancel.receipt.cancellationRequestSequence = 2;
      value.cancelReplay.receipt.cancellationRequestSequence = 2;
      value.terminalResult.worker.result.cancellation.requestAcceptedAt =
        acceptedAt;
    }
  ]) {
    const drift = cancellationBundle();
    mutate(drift);
    assert.throws(
      () => validateInstalledCancellationReplayScenario(drift),
      assertContractError("E_LIVE_CANCELLATION")
    );
  }
});

test("private completion observation requires exact counts, immutable ids, and cleanup proof", () => {
  const valid = validateInstalledPrivateObservation(
    privateObservation("authenticated-completion")
  );
  assert.equal(valid.providerLaunchCount, 1);

  for (const mutate of [
    (value) => { value.providerLaunchCount = 2; },
    (value) => { value.observedPublicWorkerDigests[0] = "not-a-digest"; },
    (value) => { value.observedPublicWorkerDigests.pop(); },
    (value) => { value.observedProviderGenerations = [1, 2]; },
    (value) => { value.observedWorkerIds[1] = "task-ffffffffffffffff"; },
    (value) => { value.observedContextManifestIds[1] = "ctx-drift"; },
    (value) => { delete value.installedWorkerBinding.createdAt; },
    (value) => { value.installedWorkerBinding.createdAt = "not-a-time"; },
    (value) => { value.installedWorkerBinding.model = 42; },
    (value) => {
      value.installedWorkerBinding.effort = "path=/private/tmp/effort";
    },
    (value) => {
      value.installedWorkerBinding.securityProfile.id = "rescue-write-v3";
    },
    (value) => {
      value.installedWorkerBinding.securityProfile.contractVersion = 2;
    },
    (value) => {
      value.installedWorkerBinding.securityProfile.agentProfileDigest = "0";
    },
    (value) => {
      value.installedWorkerBinding.securityProfile.nonce = "private";
    },
    (value) => { delete value.installedWorkerBinding.hostTaskBinding; },
    (value) => { value.installedWorkerBinding.extra = true; },
    (value) => {
      value.installedWorkerBinding.workspaceSnapshotDigest = "f".repeat(64);
    },
    (value) => {
      value.installedWorkerBinding.taskEnvelopeDigest = "not-a-digest";
    },
    (value) => { value.workerHostVerification = "passed"; },
    (value) => { value.processGroupGone = false; },
    (value) => { value.taskRuntimeCleaned = false; },
    (value) => { value.providerGuardAbsent = false; },
    (value) => { value.qualificationSessionDeleted = false; }
  ]) {
    const drift = privateObservation("authenticated-completion");
    mutate(drift);
    assert.throws(
      () => validateInstalledPrivateObservation(drift),
      assertContractError("E_LIVE_PRIVATE_STATE")
    );
  }
});

test("spawn response witnesses fail closed on shape, identity, and digest drift", () => {
  const completionMutations = [
    (value) => {
      value.observedSpawnResponseWitnesses.pop();
    },
    (value) => {
      value.observedSpawnResponseWitnesses.push(
        clone(value.observedSpawnResponseWitnesses[0])
      );
    },
    (value) => {
      delete value.observedSpawnResponseWitnesses[0].witnessId;
    },
    (value) => {
      value.observedSpawnResponseWitnesses[0].extra = true;
    },
    (value) => {
      value.observedSpawnResponseWitnesses[0].schemaVersion = 2;
      refreshSpawnResponseWitnessId(value.observedSpawnResponseWitnesses[0]);
    },
    (value) => {
      value.observedSpawnResponseWitnesses[0].witnessId =
        `spawnw-${"f".repeat(24)}`;
    },
    (value) => {
      value.observedSpawnResponseWitnesses[0].projection =
        "worker-snapshot-v1";
      refreshSpawnResponseWitnessId(value.observedSpawnResponseWitnesses[0]);
    },
    (value) => {
      value.observedSpawnResponseWitnesses[0].responseSequence = 2;
      refreshSpawnResponseWitnessId(value.observedSpawnResponseWitnesses[0]);
    },
    (value) => {
      value.observedSpawnResponseWitnesses[0].workerId =
        "task-ffffffffffffffff";
      refreshSpawnResponseWitnessId(value.observedSpawnResponseWitnesses[0]);
    },
    (value) => {
      value.observedSpawnResponseWitnesses[0].requestDigest = "not-a-digest";
      refreshSpawnResponseWitnessId(value.observedSpawnResponseWitnesses[0]);
    },
    (value) => {
      value.observedSpawnResponseWitnesses[0].idempotencyKeyDigest =
        "not-a-digest";
      refreshSpawnResponseWitnessId(value.observedSpawnResponseWitnesses[0]);
    },
    (value) => {
      value.observedSpawnResponseWitnesses[0].replayed = true;
      refreshSpawnResponseWitnessId(value.observedSpawnResponseWitnesses[0]);
    },
    (value) => {
      value.observedSpawnResponseWitnesses[0].handleDigest = "f".repeat(64);
      refreshSpawnResponseWitnessId(value.observedSpawnResponseWitnesses[0]);
    },
    (value) => {
      value.observedSpawnResponseWitnesses[0].eventCursorSequence = 2;
      refreshSpawnResponseWitnessId(value.observedSpawnResponseWitnesses[0]);
    },
    (value) => {
      value.observedSpawnResponseWitnesses[0].recordedAt = "not-a-time";
      refreshSpawnResponseWitnessId(value.observedSpawnResponseWitnesses[0]);
    }
  ];
  for (const mutate of completionMutations) {
    const drift = privateObservation("authenticated-completion");
    mutate(drift);
    assert.throws(
      () => validateInstalledPrivateObservation(drift),
      assertContractError("E_LIVE_PRIVATE_STATE")
    );
  }

  const cancellationMutations = [
    (value) => {
      value.observedSpawnResponseWitnesses[1].requestDigest = "f".repeat(64);
      refreshSpawnResponseWitnessId(value.observedSpawnResponseWitnesses[1]);
    },
    (value) => {
      value.observedSpawnResponseWitnesses[1].idempotencyKeyDigest =
        "f".repeat(64);
      refreshSpawnResponseWitnessId(value.observedSpawnResponseWitnesses[1]);
    },
    (value) => {
      value.observedSpawnResponseWitnesses[1].eventCursorSequence = 1;
      refreshSpawnResponseWitnessId(value.observedSpawnResponseWitnesses[1]);
    },
    (value) => {
      value.observedSpawnResponseWitnesses[1].recordedAt =
        "2026-07-23T09:59:59.000Z";
      refreshSpawnResponseWitnessId(value.observedSpawnResponseWitnesses[1]);
    },
    (value) => {
      value.observedSpawnResponseWitnesses.reverse();
    }
  ];
  for (const mutate of cancellationMutations) {
    const drift = privateObservation("mcp-restart-reconnect-cancellation");
    mutate(drift);
    assert.throws(
      () => validateInstalledPrivateObservation(drift),
      assertContractError("E_LIVE_PRIVATE_STATE")
    );
  }
});

test("private reconnect/cancel observation requires one generation and one replayed receipt", () => {
  const valid = validateInstalledPrivateObservation(
    privateObservation("mcp-restart-reconnect-cancellation")
  );
  assert.equal(valid.reconnectCount, 1);
  assert.deepEqual(valid.observedProviderGenerations, [1, 1]);

  const receiptDrift = privateObservation("mcp-restart-reconnect-cancellation");
  receiptDrift.observedCancellationReceiptIds[1] = "cancel-ffffffffffffffffffffffff";
  assert.throws(
    () => validateInstalledPrivateObservation(receiptDrift),
    assertContractError("E_LIVE_PRIVATE_STATE")
  );

  const replayDrift = privateObservation("mcp-restart-reconnect-cancellation");
  replayDrift.cancelReplayCount = 0;
  assert.throws(
    () => validateInstalledPrivateObservation(replayDrift),
    assertContractError("E_LIVE_PRIVATE_STATE")
  );

  const publicDigestCountDrift = privateObservation(
    "mcp-restart-reconnect-cancellation"
  );
  publicDigestCountDrift.observedPublicWorkerDigests.pop();
  assert.throws(
    () => validateInstalledPrivateObservation(publicDigestCountDrift),
    assertContractError("E_LIVE_PRIVATE_STATE")
  );
});

test("integrated witness binding rejects forged replay response fields", () => {
  const publicEvidence = cancellationBundle();
  const privateEvidence = privateObservation(
    "mcp-restart-reconnect-cancellation"
  );
  publicEvidence.spawnReplay.worker.summary = "Forged replay response";
  publicEvidence.spawnReplay.worker.progress = "Forged active progress.";
  assert.doesNotThrow(
    () => validateInstalledCancellationReplayScenario(publicEvidence)
  );
  assert.doesNotThrow(
    () => validateInstalledPrivateObservation(privateEvidence)
  );
  assert.throws(
    () => validateInstalledScenarioEvidence(publicEvidence, privateEvidence),
    assertContractError("E_LIVE_PRIVATE_STATE")
  );
});

test("integrated validator cross-binds every private identity to public scenario evidence", () => {
  assert.equal(validateInstalledScenarioEvidence(
    completionBundle(),
    privateObservation("authenticated-completion")
  ), true);
  assert.equal(validateInstalledScenarioEvidence(
    cancellationBundle(),
    privateObservation("mcp-restart-reconnect-cancellation")
  ), true);

  const unrelated = privateObservation("authenticated-completion");
  unrelated.installedWorkerBinding.workerId = "task-ffffffffffffffff";
  unrelated.installedWorkerBinding.taskEnvelopeId = `env-${"f".repeat(24)}`;
  unrelated.installedWorkerBinding.contextManifestId = `ctx-${"f".repeat(24)}`;
  unrelated.observedWorkerIds = Array(2).fill("task-ffffffffffffffff");
  unrelated.observedProviderWorkerIds = ["task-ffffffffffffffff"];
  unrelated.observedTaskEnvelopeIds = Array(2).fill(
    `env-${"f".repeat(24)}`
  );
  unrelated.observedContextManifestIds = Array(2).fill(
    `ctx-${"f".repeat(24)}`
  );
  for (const witness of unrelated.observedSpawnResponseWitnesses) {
    witness.workerId = "task-ffffffffffffffff";
    refreshSpawnResponseWitnessId(witness);
  }
  assert.doesNotThrow(() => validateInstalledPrivateObservation(unrelated));
  assert.throws(
    () => validateInstalledScenarioEvidence(completionBundle(), unrelated),
    assertContractError("E_LIVE_PRIVATE_STATE")
  );

  const providerBindingDrift = privateObservation(
    "mcp-restart-reconnect-cancellation"
  );
  providerBindingDrift.observedProviderWorkerIds = Array(2).fill(
    "task-ffffffffffffffff"
  );
  assert.throws(
    () => validateInstalledPrivateObservation(providerBindingDrift),
    assertContractError("E_LIVE_PRIVATE_STATE")
  );

  const receiptBindingDrift = privateObservation(
    "mcp-restart-reconnect-cancellation"
  );
  receiptBindingDrift.observedCancellationReceiptIds = Array(2).fill(
    `cancel-${"f".repeat(24)}`
  );
  assert.doesNotThrow(
    () => validateInstalledPrivateObservation(receiptBindingDrift)
  );
  assert.throws(
    () => validateInstalledScenarioEvidence(
      cancellationBundle(),
      receiptBindingDrift
    ),
    assertContractError("E_LIVE_PRIVATE_STATE")
  );

  assert.throws(
    () => validateInstalledScenarioEvidence(
      cancellationBundle(),
      privateObservation("authenticated-completion")
    ),
    assertContractError("E_LIVE_COMPLETION")
  );

  for (const scenarioId of INSTALLED_WORKER_SCENARIO_IDS) {
    const publicEvidence = scenarioId === "authenticated-completion"
      ? completionBundle()
      : cancellationBundle();
    const reorderedDigests = privateObservation(scenarioId);
    reorderedDigests.observedPublicWorkerDigests.reverse();
    for (
      const [index, witness] of
        reorderedDigests.observedSpawnResponseWitnesses.entries()
    ) {
      witness.handleDigest = reorderedDigests.observedPublicWorkerDigests[index];
      refreshSpawnResponseWitnessId(witness);
    }
    assert.doesNotThrow(
      () => validateInstalledPrivateObservation(reorderedDigests)
    );
    assert.throws(
      () => validateInstalledScenarioEvidence(
        publicEvidence,
        reorderedDigests
      ),
      assertContractError("E_LIVE_PRIVATE_STATE")
    );
  }
});

test("integrated validator binds terminal task and context content to private digests", () => {
  for (const mutate of [
    (value) => {
      value.terminalResult.worker.taskContract.objective =
        "Forged public objective.";
    },
    (value) => {
      value.terminalResult.worker.context.branch = "forged-branch";
    }
  ]) {
    const publicEvidence = completionBundle();
    const privateEvidence = privateObservation("authenticated-completion");
    mutate(publicEvidence);
    assert.doesNotThrow(
      () => validateInstalledCompletionScenario(publicEvidence)
    );
    assert.throws(
      () => validateInstalledScenarioEvidence(
        publicEvidence,
        privateEvidence
      ),
      assertContractError("E_LIVE_PRIVATE_STATE")
    );
  }
});

test("integrated validator rejects consistently forged public binding fields", () => {
  const cases = [
    {
      publicEvidence: completionBundle(),
      privateEvidence: privateObservation("authenticated-completion"),
      validatePublic: validateInstalledCompletionScenario,
      workers(value) {
        return [value.spawn.worker, value.terminalResult.worker];
      }
    },
    {
      publicEvidence: cancellationBundle(),
      privateEvidence: privateObservation(
        "mcp-restart-reconnect-cancellation"
      ),
      validatePublic: validateInstalledCancellationReplayScenario,
      workers(value) {
        return [
          value.spawn.worker,
          value.spawnReplay.worker,
          value.terminalResult.worker
        ];
      }
    }
    ];
  for (const entry of cases) {
    for (const publicWorker of entry.workers(entry.publicEvidence)) {
      publicWorker.securityProfile.agentProfileDigest = "a".repeat(64);
      publicWorker.taskEnvelopeDigest = "a".repeat(64);
      publicWorker.contextDigest = "b".repeat(64);
      publicWorker.workspaceSnapshotDigest = "b".repeat(64);
      publicWorker.controlWorkspaceId = `cws-${"f".repeat(32)}`;
      publicWorker.hostTaskBinding = `host-task-${"f".repeat(32)}`;
      if (publicWorker.taskContract) {
        publicWorker.taskContract.digest = publicWorker.taskEnvelopeDigest;
      }
      if (publicWorker.context) {
        publicWorker.context.digest = publicWorker.contextDigest;
      }
    }
    assert.doesNotThrow(() => entry.validatePublic(entry.publicEvidence));
    assert.doesNotThrow(
      () => validateInstalledPrivateObservation(entry.privateEvidence)
    );
    assert.throws(
      () => validateInstalledScenarioEvidence(
        entry.publicEvidence,
        entry.privateEvidence
      ),
      assertContractError("E_LIVE_PRIVATE_STATE")
    );
  }
});

test("contract exposes validation only and no live receipt authority", async () => {
  const contract = await import("../scripts/lib/installed-worker-mcp-contract.mjs");
  assert.deepEqual(INSTALLED_WORKER_SCENARIO_IDS, [
    "authenticated-completion",
    "mcp-restart-reconnect-cancellation"
  ]);
  for (const name of Object.keys(contract)) {
    assert.equal(/(?:build|mint|publish|link).*receipt/i.test(name), false, name);
  }
});
