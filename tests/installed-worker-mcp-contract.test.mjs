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
const OBSERVED_AT = Date.parse("2026-07-23T10:01:00.000Z");
const HOST_TASK_BINDING = `host-task-${"f".repeat(32)}`;
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

function worker(status, {
  terminal = false,
  cancellation = false,
  hostVerification = "not_run"
} = {}) {
  const phase = status === "queued"
    ? "accepted"
    : status === "running"
      ? "prompting"
      : status === "completed"
        ? "done"
        : "cancelled";
  return {
    id: WORKER_ID,
    kind: "task",
    jobClass: "task",
    write: false,
    parentWorkerId: null,
    lineageWorkerId: WORKER_ID,
    taskEnvelopeId: ENVELOPE_ID,
    taskEnvelopeDigest: "d".repeat(64),
    contextManifestId: MANIFEST_ID,
    contextDigest: "e".repeat(64),
    workspaceSnapshotDigest: "e".repeat(64),
    hostTaskBinding: HOST_TASK_BINDING,
    controlWorkspaceId: CONTROL_WORKSPACE_ID,
    roleId: "explorer",
    externalWorkerLabel: "external-grok-worker",
    status,
    phase,
    terminal,
    startedAt: status === "queued" ? null : "2026-07-23T10:01:30.000Z",
    completedAt: terminal ? "2026-07-23T10:03:00.000Z" : null,
    lifecycleEvents: cancellation
      ? [{ sequence: 7, type: "cancellation.requested" }]
      : [{ sequence: 7, type: "completed" }],
    result: terminal ? {
      hostVerification,
      taskRuntimeCleaned: true,
      ...(cancellation ? {
        stopReason: "cancelled",
        cancellation: {
          requestAcceptedAt: "2026-07-23T10:02:00.000Z",
          processGroupGoneAt: null,
          terminalRecordCommittedAt: null,
          receiptId: RECEIPT_ID
        }
      } : {})
    } : null
  };
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
  return {
    scenarioId,
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

test("non-replayed spawn accepts only the exact production race matrix", () => {
  const allowed = [
    (value) => {
      value.spawn.worker.status = "queued";
      value.spawn.worker.phase = "accepted";
      value.spawn.worker.startedAt = null;
    },
    (value) => {
      value.spawn.worker.status = "queued";
      value.spawn.worker.phase = "provider-launching";
      value.spawn.worker.startedAt = null;
    },
    (value) => {
      value.spawn.worker.status = "running";
      value.spawn.worker.phase = "starting";
      value.spawn.worker.startedAt = "2026-07-23T10:01:30.000Z";
    }
  ];
  for (const configure of allowed) {
    const evidence = completionBundle();
    configure(evidence);
    assert.doesNotThrow(() => validateInstalledCompletionScenario(evidence));
  }

  const rejected = [
    (value) => {
      value.spawn.worker.status = "failed";
      value.spawn.worker.phase = "failed";
    },
    (value) => {
      value.spawn.worker.status = "running";
      value.spawn.worker.phase = "cleanup-blocked";
      value.spawn.worker.startedAt = "2026-07-23T10:01:30.000Z";
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
});

test("private completion observation requires exact counts, immutable ids, and cleanup proof", () => {
  const valid = validateInstalledPrivateObservation(
    privateObservation("authenticated-completion")
  );
  assert.equal(valid.providerLaunchCount, 1);

  for (const mutate of [
    (value) => { value.providerLaunchCount = 2; },
    (value) => { value.observedProviderGenerations = [1, 2]; },
    (value) => { value.observedWorkerIds[1] = "task-ffffffffffffffff"; },
    (value) => { value.observedContextManifestIds[1] = "ctx-drift"; },
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
  unrelated.observedWorkerIds = Array(2).fill("task-ffffffffffffffff");
  unrelated.observedProviderWorkerIds = ["task-ffffffffffffffff"];
  unrelated.observedTaskEnvelopeIds = Array(2).fill(
    `env-${"f".repeat(24)}`
  );
  unrelated.observedContextManifestIds = Array(2).fill(
    `ctx-${"f".repeat(24)}`
  );
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
  assert.doesNotThrow(
    () => validateInstalledPrivateObservation(providerBindingDrift)
  );
  assert.throws(
    () => validateInstalledScenarioEvidence(
      cancellationBundle(),
      providerBindingDrift
    ),
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
