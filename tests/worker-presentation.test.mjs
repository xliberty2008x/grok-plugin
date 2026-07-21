import assert from "node:assert/strict";
import test from "node:test";

import {
  bindWorkerAlias,
  codexMetadataCapabilityMatrix,
  presentWorker,
  presentLineageTree,
  presentDegradedCapability,
  EXTERNAL_WORKER_LABEL
} from "../plugins/grok/scripts/lib/worker-presentation.mjs";
import { projectWorkerSnapshot } from "../plugins/grok/scripts/lib/worker-protocol.mjs";

function sampleJob() {
  return {
    schemaVersion: 3,
    id: "task-bbbbbbbbbbbbbbbb",
    kind: "task",
    jobClass: "task",
    write: false,
    status: "running",
    phase: "executing",
    summary: "Working",
    progress: "Step 1",
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:01.000Z",
    heartbeatAt: "2026-07-16T00:00:01.000Z",
    host: { kind: "codex", sessionId: "019f666a-6469-7cc1-9a8d-8c1adf61e103" },
    lifecycleEvents: [{ type: "task.accepted", at: "2026-07-16T00:00:00.000Z", summary: "ok", sequence: 1 }],
    profile: { id: "explorer", contractVersion: 1, agentProfileDigest: "abc" },
    request: { resumeJobId: null, envelope: null, contextManifest: null },
    result: null,
    error: null,
    latestPlan: ["Investigate"]
  };
}

test("presentation is structured-only and labels Grok as external", () => {
  const presented = presentWorker(sampleJob(), { alias: "scout" });
  assert.equal(presented.shellOutputParsed, false);
  assert.equal(presented.source, "structured-public-schema");
  assert.equal(presented.label, EXTERNAL_WORKER_LABEL);
  assert.equal(presented.isNativeHostAgent, false);
  assert.equal(presented.alias, "scout");
  assert.equal(presented.status, "running");
  assert.ok(presented.cursor);
});

test("presentation rejects attempts to spoof a Grok worker as native", () => {
  assert.throws(
    () => presentWorker(sampleJob(), { isNativeHostAgent: true }),
    (error) => error?.code === "E_POLICY"
  );
});

test("capability matrix fails closed when Codex metadata missing", () => {
  const full = codexMetadataCapabilityMatrix({
    threadId: "019f666a-6469-7cc1-9a8d-8c1adf61e103",
    "x-codex-turn-metadata": {
      thread_id: "019f666a-6469-7cc1-9a8d-8c1adf61e103",
      turn_id: "019f666e-4084-7902-8447-249f72043a37",
      plugin_id: "grok@grok-companion"
    },
    plugin_id: "grok@grok-companion",
    "codex/sandbox-state-meta": { sandboxCwd: "file:///tmp/repo" }
  });
  assert.equal(full.identity, "full");
  assert.equal(full.mutationAllowed, true);

  const missing = codexMetadataCapabilityMatrix({});
  assert.equal(missing.identity, "unavailable");
  assert.equal(missing.fallback, "fail-closed");
  const degraded = presentDegradedCapability(missing);
  assert.equal(degraded.mutationAllowed, false);
  assert.equal(degraded.shellOutputParsed, false);
});

test("aliases resist collision and spoofing", () => {
  const first = bindWorkerAlias({
    alias: "alpha",
    workerId: "task-aaaaaaaaaaaaaaaa",
    hostTaskBinding: "host-task-1"
  });
  assert.ok(first.bindingDigest);
  assert.throws(
    () => bindWorkerAlias({
      alias: "alpha",
      workerId: "task-bbbbbbbbbbbbbbbb",
      hostTaskBinding: "host-task-2",
      existing: [first]
    }),
    (error) => error?.code === "E_USAGE"
  );
});

test("lineage tree built from structured handles only", () => {
  const tree = presentLineageTree([
    { id: "task-aaaaaaaaaaaaaaaa", status: "succeeded", parentWorkerId: null },
    { id: "task-bbbbbbbbbbbbbbbb", status: "queued", parentWorkerId: "task-aaaaaaaaaaaaaaaa" }
  ]);
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].children[0].id, "task-bbbbbbbbbbbbbbbb");
  assert.equal(tree.label, EXTERNAL_WORKER_LABEL);
});

test("snapshot projection remains free of private process fields", () => {
  const snapshot = projectWorkerSnapshot({
    ...sampleJob(),
    workerProcess: { pid: 1234, startToken: "secret-token" },
    prompt: "private prompt",
    result: { hostVerification: "not_run", textDigest: "d".repeat(64), textBytes: 10 }
  });
  const text = JSON.stringify(snapshot);
  assert.equal(text.includes("secret-token"), false);
  assert.equal(text.includes("private prompt"), false);
  assert.equal(text.includes("1234"), false);
  assert.equal(snapshot.result.hostVerification, "not_run");
  assert.equal(snapshot.externalWorkerLabel, "external-grok-worker");
});

test("presentation re-sanitizes forged versioned snapshots", () => {
  const canary = [
    "post",
    "gresql",
    "://",
    "worker",
    ":",
    "hunter2",
    "@",
    "db.example.test",
    "/app"
  ].join("");
  const structuralCanary = "RAW_PROTOCOL_CANARY_1f84";
  const forged = {
    ...projectWorkerSnapshot(sampleJob()),
    latestPlan: [`Connect with ${canary}`],
    lifecycleEvents: [{
      type: "checkpoint",
      at: "2026-07-16T00:00:00.000Z",
      summary: "Safe",
      sequence: 1,
      detail: { state: "accepted", nested: { raw: structuralCanary } }
    }],
    taskContract: {
      schemaVersion: 1,
      mode: "read",
      context: { rawDiagnostics: structuralCanary },
      rawPrompt: structuralCanary
    },
    context: { workspaceRoot: structuralCanary, rawDiagnostics: structuralCanary },
    result: {
      workerProtocolVersion: 1,
      resultSchemaVersion: 1,
      hostVerification: "passed",
      workerReport: { summary: canary },
      verification: {
        outcome: "passed",
        authority: "host_asserted",
        recordedAt: "2026-07-16T00:00:00.000Z",
        observedChangedPaths: []
      },
      providerProcess: { pid: 1234 }
    },
    workerAuthorization: canary
  };
  const presented = presentWorker(forged);
  const serialized = JSON.stringify(presented);
  assert.equal(serialized.includes(canary), false);
  assert.equal(serialized.includes(structuralCanary), false);
  assert.equal(serialized.includes("workerAuthorization"), false);
  assert.equal(serialized.includes("providerProcess"), false);
  assert.equal(presented.source, "structured-public-schema");
  assert.equal(presented.result.hostVerification, "not_run");
  assert.equal(Object.hasOwn(presented.result, "verification"), false);
});

test("presentation does not trust authority when forged snapshots omit version flags", () => {
  const canary = "UNVERSIONED_AUTHORITY_CANARY_52aa";
  const forged = {
    ...sampleJob(),
    result: {
      hostVerification: "passed",
      runtimeEvidence: {
        hostVerification: "passed",
        commandOutcomes: [],
        rawDiagnostics: canary
      },
      verification: {
        outcome: "passed",
        authority: "host_asserted",
        recordedAt: "2026-07-16T00:00:00.000Z",
        observedChangedPaths: [],
        rawDiagnostics: canary
      }
    }
  };

  const presented = presentWorker(forged);
  assert.equal(presented.result.hostVerification, "not_run");
  assert.equal(presented.result.runtimeEvidence.hostVerification, "not_run");
  assert.equal(Object.hasOwn(presented.result, "verification"), false);
  assert.equal(JSON.stringify(presented).includes(canary), false);
});

test("presentation strips display controls and rejects forged lineage fields", () => {
  const canary = "PRESENTATION_RAW_CANARY_7f92";
  const privatePath = "/home/alice/private/notes.txt";
  const runtimePath = "/private/var/folders/aa/bb/T/grok-worker/private.txt";
  const forged = {
    ...projectWorkerSnapshot(sampleJob()),
    summary: `\u001b[31mWorking\u0007\u009B31m\u202E A\rOVER ${privatePath} ${runtimePath}`,
    result: {
      workerProtocolVersion: 1,
      resultSchemaVersion: 1,
      hostVerification: "not_run",
      providerClaims: {
        success: false,
        outcome: "partial",
        summary: "Safe",
        changedFiles: [],
        checksClaimed: [],
        observedFileAgreement: false,
        rawDiagnostics: canary
      }
    }
  };
  const presented = presentWorker(forged, { alias: `bad\u202E${canary}` });
  const serialized = JSON.stringify(presented);
  for (const forbidden of ["\u001b", "\u0007", "\u009B", "\u202E", "\r", privatePath, runtimePath, canary]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(presented.alias, null);
  assert.equal(presented.summary.includes("[PRIVATE_PATH]"), true);

  const tree = presentLineageTree([
    { id: "task-aaaaaaaaaaaaaaaa", status: `running\u202E${canary}`, alias: `bad\u202E${canary}` },
    { id: "not-a-worker", status: canary }
  ]);
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].alias, null);
  assert.equal(JSON.stringify(tree).includes("\u202E"), false);
  assert.equal(JSON.stringify(tree).includes("not-a-worker"), false);
});
