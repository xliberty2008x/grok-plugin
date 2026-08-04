import assert from "node:assert/strict";
import test from "node:test";

import { projectWorkerSnapshot } from "../plugins/grok/scripts/lib/worker-protocol.mjs";
import { validInstalledPublicError } from "../scripts/lib/installed-context-incomplete-contract.mjs";
import {
  InstalledWorkerMcpContractError,
  validateInstalledContextIncompleteTerminalProjection
} from "../scripts/lib/installed-worker-mcp-contract.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));

function contextIncompleteTerminalProjection() {
  const worker = projectWorkerSnapshot({
    id: `task-${"a".repeat(16)}`,
    kind: "task",
    jobClass: "task",
    write: false,
    status: "failed",
    phase: "context-rejected",
    summary: "Context rejected",
    progress: "Terminal record committed.",
    createdAt: "2026-07-23T10:00:00.000Z",
    startedAt: "2026-07-23T10:01:30.000Z",
    updatedAt: "2026-07-23T10:03:00.000Z",
    completedAt: "2026-07-23T10:02:15.000Z",
    heartbeatAt: "2026-07-23T10:03:00.000Z",
    host: { kind: "codex", sessionId: "01900000-0000-7000-8000-000000000000" },
    request: {},
    latestPlan: [],
    lifecycleEvents: [],
    result: { hostVerification: "not_run", taskRuntimeCleaned: true },
    error: {
      code: "E_CONTEXT_INCOMPLETE",
      message: "Git execution context could not be observed completely at /private/tmp/secret for providerPid=410029.",
      details: {
        contextPhase: "terminal",
        metadataComponents: ["refs", "refs", "contextCapture"],
        privatePath: "/private/tmp/secret",
        providerPid: 410029
      }
    }
  }, { trustHostAuthority: false });
  return {
    status: worker.status,
    phase: worker.phase,
    terminal: worker.terminal,
    error: worker.error
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

test("installed contract reaches strict context-incomplete v2 terminal projection", () => {
  const projection = contextIncompleteTerminalProjection();
  assert.deepEqual(projection, {
    status: "failed",
    phase: "context-rejected",
    terminal: true,
    error: {
      workerProtocolVersion: 1,
      errorSchemaVersion: 2,
      code: "E_CONTEXT_INCOMPLETE",
      message: "Git execution context could not be observed completely at [PRIVATE_PATH] for providerPid=[REDACTED].",
      details: {
        contextPhase: "terminal",
        metadataComponents: ["refs", "contextCapture"]
      }
    }
  });
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes("/private/tmp/secret"), false);
  assert.equal(serialized.includes("410029"), false);
  assert.deepEqual(clone(validateInstalledContextIncompleteTerminalProjection(projection)), projection);
  assert.equal(validInstalledPublicError(projection.error, "cancelled", {
    validPublicText: (value) => typeof value === "string"
  }), false);

  const mutations = [
    (value) => { value.extra = true; },
    (value) => { value.status = "cancelled"; },
    (value) => { value.phase = "failed"; },
    (value) => { value.terminal = false; },
    (value) => { value.error.errorSchemaVersion = 1; },
    (value) => { delete value.error.details; },
    (value) => { value.error.details.extra = true; },
    (value) => { value.error.details.contextPhase = "cleanup"; },
    (value) => { value.error.details.metadataComponents = []; },
    (value) => { value.error.details.metadataComponents = ["refs", "refs"]; },
    (value) => { value.error.details.metadataComponents = ["privateComponent"]; },
    (value) => {
      value.error.details.metadataComponents = [
        "nonRef", "operational", "hooks", "config", "indexFlags", "refs",
        "upstream", "gitMetadata", "contextCapture", "refs"
      ];
    },
    (value) => { value.error.privatePath = "/private/tmp/secret"; },
    (value) => { value.error.message = "failed at /private/tmp/secret"; }
  ];
  for (const mutate of mutations) {
    const drift = clone(projection);
    mutate(drift);
    assert.throws(
      () => validateInstalledContextIncompleteTerminalProjection(drift),
      assertContractError("E_LIVE_PRIVATE_STATE")
    );
  }
});
