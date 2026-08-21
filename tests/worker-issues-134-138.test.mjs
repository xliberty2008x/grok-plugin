import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  callWorkerTool,
  createMcpBrokerRuntime,
  handleMcpRequest,
  WORKER_FOLLOWUP_TOOL,
  WORKER_SPAWN_TOOL
} from "../plugins/grok/mcp/broker.mjs";
import {
  ORDERED_TURN_BOUNDARY_MAILBOX_PROVIDER_CAPABILITY,
  ROOT_READ_PROVIDER_CAPABILITY,
  SAME_SESSION_READ_FOLLOWUP_PROVIDER_CAPABILITY
} from "../plugins/grok/scripts/lib/provider-capability.mjs";
import { providerLaunchBindingDigest } from "../plugins/grok/scripts/lib/provider-executable-pin.mjs";
import { MCP_SANDBOX_STATE_META_CAPABILITY } from "../plugins/grok/scripts/lib/worker-authority.mjs";
import {
  attestHostTranscriptSelection,
  hostTranscriptDigest,
  parseHostTranscriptTurns
} from "../plugins/grok/scripts/lib/worker-host-transcript.mjs";
import {
  WORKER_CHANGE_NOTIFICATION_CAPABILITY,
  WORKER_CHANGE_NOTIFICATION_METHOD,
  clientAcceptsWorkerChangeNotifications,
  workerChangeNotification
} from "../plugins/grok/scripts/lib/worker-mcp-notifications.mjs";
import { resumeInterruptedWorker } from "../plugins/grok/scripts/lib/worker-mutation-followup.mjs";
import { spawnReadOnlyWorker } from "../plugins/grok/scripts/lib/worker-mutation-spawn.mjs";
import { projectWorkerHandle } from "../plugins/grok/scripts/lib/worker-protocol.mjs";
import { createWorkerService } from "../plugins/grok/scripts/lib/worker-service.mjs";
import { readJob, tryReadJob, updateJob } from "../plugins/grok/scripts/lib/state.mjs";
import { buildTaskEnvelope } from "../plugins/grok/scripts/lib/task-envelope.mjs";
import { captureContextManifest } from "../plugins/grok/scripts/lib/task-context-manifest.mjs";
import { initRepo, tempDir } from "./helpers.mjs";

const THREAD = "019f666a-6469-7cc1-9a8d-8c1adf61e103";
const TURN = "019f666e-4084-7902-8447-249f72043a37";

const SPAWN_BINDING = Object.freeze({
  schemaVersion: 1,
  pinRef: `gpin-${"1".repeat(32)}`,
  pinRecordDigest: "2".repeat(64),
  executableIdentityDigest: "3".repeat(64),
  releaseIdentityDigest: "4".repeat(64)
});
const SPAWN_RECEIPT = Object.freeze({
  capabilityDigest: "a".repeat(64),
  providerLaunchBinding: SPAWN_BINDING,
  providerLaunchBindingDigest: providerLaunchBindingDigest(SPAWN_BINDING),
  capabilities: [
    ROOT_READ_PROVIDER_CAPABILITY,
    SAME_SESSION_READ_FOLLOWUP_PROVIDER_CAPABILITY,
    ORDERED_TURN_BOUNDARY_MAILBOX_PROVIDER_CAPABILITY
  ]
});

function principal(root) {
  return {
    hostKind: "codex",
    threadId: THREAD,
    turnId: TURN,
    source: "codex-mcp-stdio",
    pluginId: "grok@grok-companion",
    root,
    mutationCapable: true
  };
}

function envFor(root) {
  const pluginData = tempDir("grok-issues-134-138-data-");
  return {
    env: {
      HOME: path.dirname(pluginData),
      GROK_COMPANION_HOST: "codex",
      GROK_COMPANION_PLUGIN_DATA: pluginData
    },
    pluginData
  };
}

function envelope(root, userRequest) {
  const manifest = captureContextManifest(root);
  return {
    envelope: buildTaskEnvelope({
      userRequest,
      objective: userRequest,
      mode: "read",
      contextManifestId: manifest.manifestId
    }),
    contextManifest: manifest
  };
}

function writeTranscript(turns) {
  const file = path.join(tempDir("grok-host-transcript-"), "session.jsonl");
  const lines = [
    JSON.stringify({ type: "session_meta", payload: { id: THREAD } })
  ];
  for (const turn of turns) {
    lines.push(JSON.stringify({
      type: "event_msg",
      payload: {
        type: turn.role === "user" ? "user_message" : "agent_message",
        message: turn.text,
        ...(turn.role === "assistant" ? { phase: "final_answer" } : {})
      }
    }));
  }
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

test("spawn schema rejects non-hex contextDigest and matches name pattern", () => {
  assert.equal(WORKER_SPAWN_TOOL.inputSchema.properties.contextDigest.pattern, "^[a-f0-9]{64}$");
  assert.equal(WORKER_SPAWN_TOOL.inputSchema.properties.name.pattern, "^[\\w .:@/+\\-]{1,64}$");
  assert.deepEqual(WORKER_FOLLOWUP_TOOL.inputSchema.required, ["id", "message", "idempotencyKey"]);
});

test("MCP tools/call worker_spawn does not invoke launchWorker", async () => {
  let launches = 0;
  const started = Date.now();
  const result = await callWorkerTool({
    name: "worker_spawn",
    arguments: {
      idempotencyKey: "mcp-admit-no-launch-0001",
      userRequest: "Admit without provider start"
    }
  }, {
    runtime: createMcpBrokerRuntime({ providerCapabilityReceipt: SPAWN_RECEIPT }),
    readProviderCapabilityReceipt: () => SPAWN_RECEIPT,
    resolveAuthority: () => principal(initRepo()),
    serviceOptions: {
      launchWorker() {
        launches += 1;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
        return { providerLaunchState: "started", providerLaunched: true };
      }
    }
  });
  assert.equal(result.isError, undefined);
  assert.equal(launches, 0);
  assert.ok(Date.now() - started < 5_000);
  assert.equal(result.structuredContent.providerLaunchState, "pending");
});

test("MCP worker_spawn returns at durable admission without calling launchWorker", async () => {
  const root = initRepo();
  const { env } = envFor(root);
  let launches = 0;
  const service = createWorkerService({
    root,
    principal: principal(root),
    env,
    deferProviderLaunch: true,
    launchWorker() {
      launches += 1;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
      return { providerLaunchState: "started", providerLaunched: true };
    }
  });
  const started = Date.now();
  const spawned = service.spawn({
    userRequest: "Admit without waiting for the provider",
    idempotencyKey: "admit-no-launch-0001"
  });
  const elapsed = Date.now() - started;
  assert.equal(launches, 0);
  assert.ok(elapsed < 5_000, `spawn held the caller for ${elapsed}ms`);
  assert.equal(spawned.providerLaunched, false);
  assert.equal(spawned.providerLaunchState, "pending");
  const listed = service.listOwned();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, spawned.handle.id);
});

test("spawn idempotency includes name parent and context fields", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const { envelope: task, contextManifest } = envelope(root, "Same task text");
  const first = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: task,
    contextManifest,
    idempotencyKey: "spawn-orch-0001",
    env,
    publicSpawn: { name: "alpha", contextMode: null, inheritTurns: null, contextDigest: null, parentId: null }
  });
  const replay = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: task,
    contextManifest,
    idempotencyKey: "spawn-orch-0001",
    env,
    publicSpawn: { name: "alpha", contextMode: null, inheritTurns: null, contextDigest: null, parentId: null }
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.handle.id, first.handle.id);
  assert.throws(
    () => spawnReadOnlyWorker({
      root,
      principal: principal(root),
      envelope: task,
      contextManifest,
      idempotencyKey: "spawn-orch-0001",
      env,
      publicSpawn: { name: "beta", contextMode: null, inheritTurns: null, contextDigest: null, parentId: null }
    }),
    (error) => error.code === "E_IDEMPOTENCY_CONFLICT"
  );
  assert.equal(serviceCount(root, env), 1);
});

function serviceCount(root, env) {
  return createWorkerService({
    root,
    principal: principal(root),
    env,
    launchWorker: () => ({ providerLaunchState: "pending", providerLaunched: false })
  }).listOwned().length;
}

test("host transcript modes materialize distinct turns and reject a bogus digest", () => {
  const older = "OLDER_TURN_MARKER_91ab";
  const recent = "RECENT_TURN_MARKER_c3de";
  const transcriptPath = writeTranscript([
    { role: "user", text: older },
    { role: "assistant", text: "ack older" },
    { role: "user", text: recent },
    { role: "assistant", text: "ack recent" }
  ]);
  const parsed = parseHostTranscriptTurns(fs.readFileSync(transcriptPath, "utf8"));
  const allDigest = hostTranscriptDigest(parsed);
  const recentDigest = hostTranscriptDigest(parsed.filter((turn) => turn.role === "user").slice(-1));
  const env = { GROK_COMPANION_TRANSCRIPT_PATH: transcriptPath };
  const none = attestHostTranscriptSelection({
    principal: { threadId: THREAD },
    publicSpawn: { contextMode: "none" },
    env
  });
  assert.equal(none.facts.length, 0);
  const recentSel = attestHostTranscriptSelection({
    principal: { threadId: THREAD },
    publicSpawn: { contextMode: "recent", inheritTurns: 1, contextDigest: recentDigest },
    env
  });
  assert.equal(recentSel.facts.length, 1);
  assert.match(recentSel.facts[0], new RegExp(recent));
  assert.doesNotMatch(recentSel.facts[0], new RegExp(older));
  const allSel = attestHostTranscriptSelection({
    principal: { threadId: THREAD },
    publicSpawn: { contextMode: "all", inheritTurns: null, contextDigest: allDigest },
    env
  });
  assert.ok(allSel.facts.some((fact) => fact.includes(older)));
  assert.ok(allSel.facts.some((fact) => fact.includes(recent)));
  assert.throws(
    () => attestHostTranscriptSelection({
      principal: { threadId: THREAD },
      publicSpawn: { contextMode: "all", contextDigest: "0".repeat(64) },
      env
    }),
    (error) => error.code === "E_CONTEXT_DRIFT"
  );
});

test("spawn binds verified recent host turns into the provider prompt", () => {
  const root = initRepo();
  const { env, pluginData } = envFor(root);
  const marker = "HOST_TURN_VISIBLE_7f21";
  const transcriptPath = writeTranscript([
    { role: "user", text: marker },
    { role: "assistant", text: "noted" }
  ]);
  env.GROK_COMPANION_TRANSCRIPT_PATH = transcriptPath;
  const parsed = parseHostTranscriptTurns(fs.readFileSync(transcriptPath, "utf8"));
  const digest = hostTranscriptDigest(parsed.filter((turn) => turn.role === "user").slice(-1));
  const { envelope: task, contextManifest } = envelope(root, "Do not restate the marker");
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: task,
    contextManifest,
    idempotencyKey: "spawn-transcript-0001",
    env,
    publicSpawn: {
      contextMode: "recent",
      inheritTurns: 1,
      contextDigest: digest,
      name: null,
      parentId: null
    }
  });
  const job = tryReadJob(root, spawned.handle.id, env);
  assert.ok(job.request.contextPacket.facts.some((fact) => fact.includes(marker)));
  assert.equal(job.request.contextInheritance.digest, digest);
  const publicHandle = projectWorkerHandle(job, { trustHostAuthority: false });
  assert.equal(publicHandle.status, "queued");
  assert.equal(JSON.stringify(publicHandle).includes(marker), false);
  void pluginData;
});

test("interrupted workers project public interrupted and resume without a grant", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const { envelope: task, contextManifest } = envelope(root, "Original prompt must not replay");
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: task,
    contextManifest,
    idempotencyKey: "spawn-interrupt-0001",
    env
  });
  updateJob(root, spawned.handle.id, (job) => ({
    ...job,
    status: "interrupted",
    phase: "interrupted",
    grokSessionId: "sess-preserved-interrupt",
    result: {
      ...(job.result || {}),
      interrupt: {
        sessionPreserved: true,
        receipt: {
          receiptId: "interrupt-test",
          workerId: job.id,
          status: "accepted",
          sessionPreserved: true
        }
      }
    }
  }), env);
  const privateInterrupted = readJob(root, spawned.handle.id, env);
  assert.equal(privateInterrupted.status, "interrupted");
  assert.equal(privateInterrupted.result?.interrupt?.sessionPreserved, true);
  const projected = projectWorkerHandle(privateInterrupted, {
    trustHostAuthority: false
  });
  assert.equal(projected.status, "interrupted");
  assert.equal(projected.terminal, false);
  const resumed = resumeInterruptedWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    message: "Continue from the interrupt",
    idempotencyKey: "resume-interrupt-0001",
    env
  });
  assert.equal(resumed.handle.id, spawned.handle.id);
  assert.equal(resumed.replayed, false);
  const replay = resumeInterruptedWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    message: "Continue from the interrupt",
    idempotencyKey: "resume-interrupt-0001",
    env
  });
  assert.equal(replay.replayed, true);
  const job = tryReadJob(root, spawned.handle.id, env);
  assert.equal(job.request.envelope.userRequest, "Continue from the interrupt");
  assert.notEqual(job.request.envelope.userRequest, "Original prompt must not replay");
});

test("MCP wait emits a bounded notification when an owned worker becomes terminal", async () => {
  const marker = "SECRET_TRANSCRIPT_SHOULD_NOT_NOTIFY";
  const handle = {
    id: "task-aaaaaaaaaaaaaaaa",
    status: "queued",
    phase: "accepted",
    terminal: false,
    updatedAt: "2026-08-21T00:00:00.000Z",
    summary: marker
  };
  const notification = workerChangeNotification(handle);
  assert.equal(notification.method, WORKER_CHANGE_NOTIFICATION_METHOD);
  assert.equal(notification.params.workerId, handle.id);
  assert.equal(notification.params.terminal, false);
  assert.equal(JSON.stringify(notification.params).includes(marker), false);
  assert.equal(
    clientAcceptsWorkerChangeNotifications({
      capabilities: { experimental: { [WORKER_CHANGE_NOTIFICATION_CAPABILITY]: {} } }
    }),
    true
  );
  assert.equal(clientAcceptsWorkerChangeNotifications({ capabilities: {} }), false);

  const root = initRepo();
  const { env } = envFor(root);
  const notes = [];
  const options = {
    runtime: createMcpBrokerRuntime({ providerCapabilityReceipt: SPAWN_RECEIPT }),
    readProviderCapabilityReceipt: () => SPAWN_RECEIPT,
    resolveAuthority: () => principal(root),
    env,
    emitNotification: (note) => notes.push(note)
  };
  const spawned = await callWorkerTool({
    name: "worker_spawn",
    arguments: {
      idempotencyKey: "notify-wait-terminal-0001",
      userRequest: marker
    }
  }, options);
  assert.equal(spawned.isError, undefined);
  const workerId = spawned.structuredContent.worker.id;
  assert.ok(notes.some((note) => (
    note.method === WORKER_CHANGE_NOTIFICATION_METHOD
    && note.params.workerId === workerId
    && note.params.terminal !== true
  )));

  const cancelled = await callWorkerTool({
    name: "worker_cancel",
    arguments: {
      id: workerId,
      idempotencyKey: "notify-wait-terminal-cancel-0001"
    }
  }, options);
  assert.equal(cancelled.structuredContent.ok, true);
  notes.length = 0;
  const waited = await callWorkerTool({
    name: "worker_wait",
    arguments: { id: workerId, timeoutMs: 0 }
  }, options);
  assert.equal(waited.isError, undefined);
  assert.equal(waited.structuredContent.stream.terminal, true);
  const terminalNotes = notes.filter((note) => note.method === WORKER_CHANGE_NOTIFICATION_METHOD);
  assert.ok(terminalNotes.length >= 1);
  assert.equal(terminalNotes[0].params.workerId, workerId);
  assert.equal(terminalNotes[0].params.terminal, true);
  assert.ok(["cancelled", "failed", "completed"].includes(terminalNotes[0].params.status));
  assert.equal(JSON.stringify(terminalNotes[0].params).includes(marker), false);
});

test("initialize records client notification support on the session", async () => {
  const session = { notifyWorkers: false };
  await handleMcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: { experimental: { [WORKER_CHANGE_NOTIFICATION_CAPABILITY]: {} } },
      clientInfo: { name: "test", version: "0" }
    }
  }, { session });
  assert.equal(session.notifyWorkers, true);
});

