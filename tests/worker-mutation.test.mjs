import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertTaskEnvelope,
  buildTaskEnvelope,
  captureContextManifest
} from "../plugins/grok/scripts/lib/task-contract.mjs";
import {
  createWorkerAuthorization,
  launchContractDigest
} from "../plugins/grok/scripts/lib/worker-launch-contract.mjs";
import { projectWorkerSnapshot } from "../plugins/grok/scripts/lib/worker-protocol.mjs";
import {
  cancelWorker,
  claimWorkerDispatch,
  assertDispatchContract,
  prepareDispatchProcessSpawn,
  spawnReadOnlyWorker,
  SPAWN_SUCCESS_DEFINITION
} from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import { reconcileOwnedWorkers } from "../plugins/grok/scripts/lib/worker-reconcile.mjs";
import { createWorkerService } from "../plugins/grok/scripts/lib/worker-service.mjs";
import {
  callWorkerTool,
  createMcpBrokerRuntime,
  handleMcpRequest
} from "../plugins/grok/mcp/broker.mjs";
import { ROOT_READ_PROVIDER_CAPABILITY } from "../plugins/grok/scripts/lib/provider-capability.mjs";
import { processGroupGone, processStartToken } from "../plugins/grok/scripts/lib/process-control.mjs";
import {
  loadProviderGuard,
  registerProviderGuard,
  unregisterProviderGuard
} from "../plugins/grok/scripts/lib/recursion-guard.mjs";
import {
  cancelFile,
  generateId,
  listJobs,
  tryReadJob,
  updateJob,
  writeJob
} from "../plugins/grok/scripts/lib/state.mjs";
import {
  gitCommonDir,
  workspaceState,
  workspaceStateSegment
} from "../plugins/grok/scripts/lib/workspace.mjs";
import { initRepo, tempDir, waitFor } from "./helpers.mjs";

const THREAD = "019f666a-6469-7cc1-9a8d-8c1adf61e103";
const THREAD_B = "019f666b-1e72-74b1-b27c-9d186d7f1016";
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const MUTATION_MODULE = new URL("../plugins/grok/scripts/lib/worker-mutation.mjs", import.meta.url).href;
const TASK_CONTRACT_MODULE = new URL("../plugins/grok/scripts/lib/task-contract.mjs", import.meta.url).href;

function runIsolatedModule(source) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: TEST_DIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function lastJson(stdout) {
  const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).at(-1);
  return JSON.parse(line);
}

function principal(root, overrides = {}) {
  return {
    hostKind: "codex",
    threadId: THREAD,
    turnId: "019f666e-4084-7902-8447-249f72043a37",
    source: "codex-mcp-stdio",
    pluginId: "grok@grok-companion",
    root,
    mutationCapable: true,
    ...overrides
  };
}

function envFor(root) {
  const pluginData = tempDir("grok-mutation-data-");
  return {
    env: {
      HOME: path.dirname(pluginData),
      GROK_COMPANION_HOST: "codex",
      GROK_COMPANION_PLUGIN_DATA: pluginData
    },
    pluginData
  };
}

function cancelIdempotencyFile(root, key, env) {
  const keyDigest = crypto.createHash("sha256").update(key).digest("hex");
  return path.join(workspaceState(root, env), "idempotency", "cancel", `${keyDigest}.json`);
}

function spawnIdempotencyFile(root, key, env) {
  const keyDigest = crypto.createHash("sha256").update(key).digest("hex");
  return path.join(workspaceState(root, env), "idempotency", "spawn", `${keyDigest}.json`);
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalize(value[key])])
  );
}

function stableDigest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function spawnResponseWitnessBody(witness) {
  const { witnessId: _witnessId, ...body } = witness;
  return body;
}

function refreshSpawnWitnessId(record) {
  record.responseWitness.witnessId = `spawnw-${
    stableDigest(spawnResponseWitnessBody(record.responseWitness)).slice(0, 24)
  }`;
  return record;
}

function providerGuardFile(root, marker) {
  const scopeDigest = crypto.createHash("sha256").update(gitCommonDir(root)).digest("hex");
  const guardRoot = path.join(
    os.tmpdir(),
    `grok-companion-guards-${typeof process.getuid === "function" ? process.getuid() : "user"}`
  );
  return path.join(guardRoot, scopeDigest, `${marker}.json`);
}

test("spawn commits durable job without provider launch; retry is idempotent", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const idempotencyKey = "spawn-key-0001";
  const envelope = buildTaskEnvelope({ userRequest: "Inspect package.json", mode: "read" });
  const first = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey,
    env
  });
  assert.equal(first.replayed, false);
  assert.equal(first.spawnSuccessDefinition, SPAWN_SUCCESS_DEFINITION);
  assert.equal(first.handle.status, "queued");
  assert.equal(first.handle.externalWorkerLabel, "external-grok-worker");
  assert.equal(first.providerLaunched, false);

  const firstRecord = JSON.parse(
    fs.readFileSync(spawnIdempotencyFile(root, idempotencyKey, env), "utf8")
  );
  assert.deepEqual(Object.keys(firstRecord).sort(), [
    "committedAt",
    "controlWorkspaceId",
    "executionRoot",
    "idempotencyKeyDigest",
    "launchContractDigest",
    "owner",
    "requestDigest",
    "responseWitness",
    "schemaVersion",
    "workerId"
  ]);
  assert.equal(firstRecord.schemaVersion, 4);
  assert.deepEqual(Object.keys(firstRecord.responseWitness).sort(), [
    "eventCursorSequence",
    "handleDigest",
    "idempotencyKeyDigest",
    "projection",
    "recordedAt",
    "replayed",
    "requestDigest",
    "responseSequence",
    "schemaVersion",
    "witnessId",
    "workerId"
  ]);
  assert.equal(firstRecord.responseWitness.schemaVersion, 1);
  assert.equal(firstRecord.responseWitness.projection, "worker-handle-v1-untrusted-host");
  assert.equal(firstRecord.responseWitness.responseSequence, 1);
  assert.equal(firstRecord.responseWitness.workerId, first.handle.id);
  assert.equal(firstRecord.responseWitness.requestDigest, firstRecord.requestDigest);
  assert.equal(
    firstRecord.responseWitness.idempotencyKeyDigest,
    crypto.createHash("sha256").update(idempotencyKey).digest("hex")
  );
  assert.equal(firstRecord.responseWitness.replayed, false);
  assert.equal(firstRecord.responseWitness.handleDigest, stableDigest(first.handle));
  assert.equal(
    firstRecord.responseWitness.eventCursorSequence,
    first.handle.eventCursor.sequence
  );
  assert.equal(
    new Date(firstRecord.responseWitness.recordedAt).toISOString(),
    firstRecord.responseWitness.recordedAt
  );
  assert.equal(
    firstRecord.responseWitness.witnessId,
    `spawnw-${stableDigest(spawnResponseWitnessBody(firstRecord.responseWitness)).slice(0, 24)}`
  );

  const second = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey,
    env
  });
  assert.equal(second.replayed, true);
  assert.equal(second.handle.id, first.handle.id);
  assert.equal(second.providerLaunched, false);

  const secondRecord = JSON.parse(
    fs.readFileSync(spawnIdempotencyFile(root, idempotencyKey, env), "utf8")
  );
  assert.equal(secondRecord.schemaVersion, 4);
  assert.equal(secondRecord.responseWitness.responseSequence, 2);
  assert.equal(secondRecord.responseWitness.replayed, true);
  assert.equal(secondRecord.responseWitness.handleDigest, stableDigest(second.handle));
  assert.equal(
    secondRecord.responseWitness.eventCursorSequence,
    second.handle.eventCursor.sequence
  );
  assert.equal(
    secondRecord.responseWitness.witnessId,
    `spawnw-${stableDigest(spawnResponseWitnessBody(secondRecord.responseWitness)).slice(0, 24)}`
  );

  const job = tryReadJob(root, first.handle.id, env);
  assert.ok(job);
  assert.equal(job.host.sessionId, THREAD);
});

test("spawn replay projects the transaction-time job without host verification claims", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({
    userRequest: "Inspect replay projection authority",
    mode: "read"
  });
  const first = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "spawn-replay-projection-0001",
    env
  });

  updateJob(root, first.handle.id, (job) => ({
    ...job,
    summary: "Host verification passed",
    progress: "Host verification passed after durable admission"
  }), env);

  const replay = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "spawn-replay-projection-0001",
    env
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.handle.id, first.handle.id);
  assert.equal(replay.handle.eventCursor.sequence, 1);
  assert.equal(replay.handle.summary, null);
  assert.equal(replay.handle.progress, null);
  assert.equal(JSON.stringify(replay.handle).includes("Host verification passed"), false);
  const record = JSON.parse(
    fs.readFileSync(
      spawnIdempotencyFile(root, "spawn-replay-projection-0001", env),
      "utf8"
    )
  );
  assert.equal(record.responseWitness.handleDigest, stableDigest(replay.handle));
  assert.equal(
    JSON.stringify(record.responseWitness).includes("Host verification passed"),
    false
  );
});

test("spawn validates and canonically rebinds TaskEnvelope identity to trusted context", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const unbound = buildTaskEnvelope({ userRequest: "Inspect canonical task envelope", mode: "read" });
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: unbound,
    idempotencyKey: "spawn-canonical-envelope-0001",
    env
  });
  const stored = tryReadJob(root, spawned.handle.id, env);
  assert.equal(stored.request.envelope.contextManifestId, stored.request.contextManifest.manifestId);
  assert.notEqual(stored.request.envelope.digest, unbound.digest);
  assert.doesNotThrow(() => assertTaskEnvelope(stored.request.envelope));

  const forged = [
    { ...unbound, schemaVersion: 999 },
    { ...unbound, digest: "0".repeat(64) },
    { ...unbound, envelopeId: `env-${"1".repeat(24)}` },
    { ...unbound, unsupportedAuthority: true },
    { ...unbound, objective: { hidden: "not-text" } },
    { ...unbound, userRequest: "x".repeat((64 * 1024) + 1) }
  ];
  for (const [index, envelope] of forged.entries()) {
    assert.throws(
      () => spawnReadOnlyWorker({
        root,
        principal: principal(root),
        envelope,
        idempotencyKey: `spawn-forged-envelope-${String(index).padStart(4, "0")}`,
        env
      }),
      (error) => error?.code === "E_SCHEMA"
    );
  }
  assert.throws(
    () => spawnReadOnlyWorker({
      root,
      principal: principal(root),
      envelope: buildTaskEnvelope({
        userRequest: "Forged context binding",
        mode: "read",
        contextManifestId: `ctx-${"0".repeat(24)}`
      }),
      idempotencyKey: "spawn-forged-context-0001",
      env
    }),
    (error) => error?.code === "E_CONTEXT_DRIFT"
  );
  assert.equal(listJobs(root, env).length, 1);
});

test("default task text is never projected as a public objective while an explicit objective is preserved", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const canary = "CANARY_RAW_USER_REQUEST_4a88";
  const defaultSpawn = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest: canary, mode: "read" }),
    idempotencyKey: "spawn-private-default-objective-0001",
    env
  });
  const defaultJob = tryReadJob(root, defaultSpawn.handle.id, env);
  const defaultProjection = projectWorkerSnapshot(defaultJob);
  assert.equal(defaultJob.request.publicObjective, null);
  assert.equal(defaultProjection.taskContract.objective, null);
  assert.equal(JSON.stringify(defaultProjection).includes(canary), false);

  const publicObjective = "Inspect the bounded worker contract";
  const explicitSpawn = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({
      userRequest: `${canary}-private-details`,
      objective: publicObjective,
      mode: "read"
    }),
    idempotencyKey: "spawn-explicit-public-objective-0001",
    env
  });
  const explicitJob = tryReadJob(root, explicitSpawn.handle.id, env);
  const explicitProjection = projectWorkerSnapshot(explicitJob);
  assert.equal(explicitJob.request.publicObjective, publicObjective);
  assert.equal(explicitProjection.taskContract.objective, publicObjective);
  assert.equal(JSON.stringify(explicitProjection).includes(`${canary}-private-details`), false);
});

test("spawn idempotency binds the exact owner and complete request without leaking handles", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({ userRequest: "Inspect one", mode: "read" });
  const first = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "spawn-bound-request-0001",
    env
  });

  assert.throws(
    () => spawnReadOnlyWorker({
      root,
      principal: principal(root),
      envelope: buildTaskEnvelope({ userRequest: "Inspect two", mode: "read" }),
      idempotencyKey: "spawn-bound-request-0001",
      env
    }),
    (error) => error?.code === "E_IDEMPOTENCY_CONFLICT"
  );
  assert.throws(
    () => spawnReadOnlyWorker({
      root,
      principal: principal(root, { threadId: THREAD_B }),
      envelope,
      idempotencyKey: "spawn-bound-request-0001",
      env
    }),
    (error) => error?.code === "E_IDEMPOTENCY_CONFLICT"
      && !String(error.message).includes(first.handle.id)
  );
  assert.throws(
    () => spawnReadOnlyWorker({
      root,
      principal: principal(root, { hostKind: "claude-code" }),
      envelope,
      idempotencyKey: "spawn-bound-request-0001",
      env
    }),
    (error) => error?.code === "E_IDEMPOTENCY_CONFLICT"
      && !String(error.message).includes(first.handle.id)
  );
});

test("spawn orphan recovery writes an authentic replay response witness without duplicating the job", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({ userRequest: "Recover orphaned spawn response", mode: "read" });
  const idempotencyKey = "spawn-orphan-witness-0001";
  const first = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey,
    env
  });
  fs.rmSync(spawnIdempotencyFile(root, idempotencyKey, env));

  const recovered = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey,
    env
  });
  assert.equal(recovered.replayed, true);
  assert.equal(recovered.handle.id, first.handle.id);
  const record = JSON.parse(
    fs.readFileSync(spawnIdempotencyFile(root, idempotencyKey, env), "utf8")
  );
  assert.equal(record.schemaVersion, 4);
  assert.equal(record.responseWitness.responseSequence, 1);
  assert.equal(record.responseWitness.replayed, true);
  assert.equal(record.responseWitness.handleDigest, stableDigest(recovered.handle));
  assert.equal(
    record.responseWitness.witnessId,
    `spawnw-${stableDigest(spawnResponseWitnessBody(record.responseWitness)).slice(0, 24)}`
  );
  assert.equal(listJobs(root, env).length, 1);
});

test("spawn idempotency requires one unique durable digest owner with and without its adjacent record", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const idempotencyKey = "spawn-unique-digest-owner-0001";
  const envelope = buildTaskEnvelope({ userRequest: "Inspect duplicate ownership", mode: "read" });
  const first = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey,
    env
  });
  const original = tryReadJob(root, first.handle.id, env);
  const duplicateCreatedAt = new Date(Date.parse(original.createdAt) + 1).toISOString();
  const duplicate = {
    ...structuredClone(original),
    id: generateId("task"),
    createdAt: duplicateCreatedAt,
    updatedAt: duplicateCreatedAt,
    heartbeatAt: duplicateCreatedAt,
    workerAuthorization: null
  };
  duplicate.workerAuthorization = createWorkerAuthorization({
    job: duplicate,
    principal: principal(root),
    issuedAt: duplicateCreatedAt
  });
  writeJob(root, duplicate, env);

  const replay = () => spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey,
    env
  });
  assert.throws(
    replay,
    (error) => error?.code === "E_STATE"
      && !String(error.message).includes(first.handle.id)
      && !String(error.message).includes(duplicate.id)
  );

  fs.rmSync(spawnIdempotencyFile(root, idempotencyKey, env));
  assert.throws(
    replay,
    (error) => error?.code === "E_STATE"
      && !String(error.message).includes(first.handle.id)
      && !String(error.message).includes(duplicate.id)
  );
  assert.equal(listJobs(root, env).length, 2);
});

test("spawn idempotency replay cross-checks its durable job binding", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({ userRequest: "Inspect durable binding", mode: "read" });
  const idempotencyKey = "spawn-durable-binding-0001";
  const first = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey,
    env
  });
  const file = spawnIdempotencyFile(root, idempotencyKey, env);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(record.schemaVersion, 4);
  record.committedAt = new Date(Date.parse(record.committedAt) + 1000).toISOString();
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });

  assert.throws(
    () => spawnReadOnlyWorker({
      root,
      principal: principal(root),
      envelope,
      idempotencyKey,
      env
    }),
    (error) => error?.code === "E_STATE"
      && !String(error.message).includes(first.handle.id)
  );
  assert.equal(listJobs(root, env).length, 1);
});

test("spawn idempotency migrates an exact legacy schema 3 record on replay", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({ userRequest: "Migrate legacy spawn witness", mode: "read" });
  const idempotencyKey = "spawn-legacy-witness-0001";
  const first = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey,
    env
  });
  const file = spawnIdempotencyFile(root, idempotencyKey, env);
  const current = JSON.parse(fs.readFileSync(file, "utf8"));
  const { responseWitness: _responseWitness, ...legacy } = current;
  legacy.schemaVersion = 3;
  fs.writeFileSync(file, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

  const replay = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey,
    env
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.handle.id, first.handle.id);
  const migrated = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(migrated.schemaVersion, 4);
  assert.equal(migrated.responseWitness.responseSequence, 1);
  assert.equal(migrated.responseWitness.replayed, true);
  assert.equal(migrated.responseWitness.handleDigest, stableDigest(replay.handle));
  assert.equal(
    migrated.responseWitness.eventCursorSequence,
    replay.handle.eventCursor.sequence
  );
  assert.equal(listJobs(root, env).length, 1);
});

test("spawn idempotency fails closed on corrupt response-witness fields, identity, and digest", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({ userRequest: "Reject corrupt spawn witness", mode: "read" });
  const idempotencyKey = "spawn-corrupt-witness-0001";
  const first = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey,
    env
  });
  const file = spawnIdempotencyFile(root, idempotencyKey, env);
  const original = JSON.parse(fs.readFileSync(file, "utf8"));
  const corruptions = [
    (record) => { record.responseWitness.unsupportedAuthority = true; },
    (record) => { record.responseWitness.projection = "worker-handle-v1-host-trusted"; },
    (record) => { record.responseWitness.responseSequence = 0; },
    (record) => { record.responseWitness.workerId = `task-${"0".repeat(16)}`; },
    (record) => { record.responseWitness.requestDigest = "0".repeat(64); },
    (record) => { record.responseWitness.idempotencyKeyDigest = "0".repeat(64); },
    (record) => { record.responseWitness.replayed = "false"; },
    (record) => { record.responseWitness.handleDigest = "0".repeat(64); },
    (record) => { record.responseWitness.eventCursorSequence = -1; },
    (record) => { record.responseWitness.recordedAt = "2026-07-23T00:00:00Z"; },
    (record) => { record.responseWitness.witnessId = `spawnw-${"0".repeat(24)}`; }
  ];

  for (const corrupt of corruptions) {
    const record = structuredClone(original);
    corrupt(record);
    fs.writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    assert.throws(
      () => spawnReadOnlyWorker({
        root,
        principal: principal(root),
        envelope,
        idempotencyKey,
        env
      }),
      (error) => error?.code === "E_STATE"
        && !String(error.message).includes(first.handle.id)
    );
    assert.equal(listJobs(root, env).length, 1);
  }
});

test("spawn response witness rejects noncausal time and sequence overflow before rewriting", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({ userRequest: "Bound spawn witness chronology", mode: "read" });
  const idempotencyKey = "spawn-witness-chronology-0001";
  const first = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey,
    env
  });
  const file = spawnIdempotencyFile(root, idempotencyKey, env);
  const original = JSON.parse(fs.readFileSync(file, "utf8"));
  const cases = [
    (record) => {
      record.responseWitness.recordedAt = new Date(
        Date.parse(record.committedAt) - 1
      ).toISOString();
      refreshSpawnWitnessId(record);
    },
    (record) => {
      record.responseWitness.recordedAt = new Date(Date.now() + 86_400_000).toISOString();
      refreshSpawnWitnessId(record);
    },
    (record) => {
      record.responseWitness.responseSequence = Number.MAX_SAFE_INTEGER;
      record.responseWitness.replayed = true;
      refreshSpawnWitnessId(record);
    }
  ];

  for (const mutate of cases) {
    const corrupt = structuredClone(original);
    mutate(corrupt);
    fs.writeFileSync(file, `${JSON.stringify(corrupt)}\n`, { mode: 0o600 });
    assert.throws(
      () => spawnReadOnlyWorker({
        root,
        principal: principal(root),
        envelope,
        idempotencyKey,
        env
      }),
      (error) => error?.code === "E_STATE"
        && !String(error.message).includes(first.handle.id)
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), corrupt);
    assert.equal(listJobs(root, env).length, 1);
  }
});

test("spawn idempotency replay rejects a launch-contract-corrupted durable job without a handle", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({
    userRequest: "Inspect the launch-contract binding",
    mode: "read"
  });
  const idempotencyKey = "spawn-launch-contract-corruption-0001";
  const first = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey,
    env
  });
  const record = JSON.parse(fs.readFileSync(spawnIdempotencyFile(root, idempotencyKey, env), "utf8"));
  const admitted = tryReadJob(root, first.handle.id, env);
  assert.match(record.launchContractDigest, /^[0-9a-f]{64}$/);
  assert.equal(record.launchContractDigest, launchContractDigest(admitted));

  updateJob(root, first.handle.id, (job) => ({
    ...job,
    request: {
      ...job.request,
      envelope: {
        ...job.request.envelope,
        objective: "Tampered objective after durable admission"
      }
    }
  }), env);
  const corrupted = tryReadJob(root, first.handle.id, env);
  assert.notEqual(record.launchContractDigest, launchContractDigest(corrupted));

  let replayResult;
  let replayError;
  try {
    replayResult = spawnReadOnlyWorker({
      root,
      principal: principal(root),
      envelope,
      idempotencyKey,
      env
    });
  } catch (error) {
    replayError = error;
  }
  assert.equal(replayResult, undefined, "corrupt replay returned a worker handle");
  assert.equal(replayError?.code, "E_STATE");
  assert.equal(String(replayError?.message).includes(first.handle.id), false);
  assert.equal(listJobs(root, env).length, 1);
});

test("spawn and cancel are cross-process idempotent under the workspace transaction", async () => {
  const root = initRepo();
  const { env } = envFor(root);
  const source = `
    import { spawnReadOnlyWorker } from ${JSON.stringify(MUTATION_MODULE)};
    import { buildTaskEnvelope } from ${JSON.stringify(TASK_CONTRACT_MODULE)};
    const root = ${JSON.stringify(root)};
    const env = ${JSON.stringify(env)};
    const principal = ${JSON.stringify(principal(root))};
    const result = spawnReadOnlyWorker({
      root,
      env,
      principal,
      envelope: buildTaskEnvelope({ userRequest: "Concurrent spawn", mode: "read" }),
      idempotencyKey: "spawn-cross-process-0001"
    });
    console.log(JSON.stringify(result));
  `;
  const spawnRuns = await Promise.all([runIsolatedModule(source), runIsolatedModule(source)]);
  for (const run of spawnRuns) assert.equal(run.code, 0, run.stderr);
  const spawnResults = spawnRuns.map((run) => lastJson(run.stdout));
  assert.equal(spawnResults[0].handle.id, spawnResults[1].handle.id);
  assert.deepEqual(spawnResults.map((result) => result.replayed).sort(), [false, true]);
  assert.equal(listJobs(root, env).length, 1);

  const workerId = spawnResults[0].handle.id;
  const cancelSource = `
    import { cancelWorker } from ${JSON.stringify(MUTATION_MODULE)};
    const result = cancelWorker({
      root: ${JSON.stringify(root)},
      env: ${JSON.stringify(env)},
      principal: ${JSON.stringify(principal(root))},
      workerId: ${JSON.stringify(workerId)},
      idempotencyKey: "cancel-cross-process-0001"
    });
    console.log(JSON.stringify(result));
  `;
  const cancelRuns = await Promise.all([runIsolatedModule(cancelSource), runIsolatedModule(cancelSource)]);
  for (const run of cancelRuns) assert.equal(run.code, 0, run.stderr);
  const cancelResults = cancelRuns.map((run) => lastJson(run.stdout));
  assert.equal(cancelResults[0].receipt.receiptId, cancelResults[1].receipt.receiptId);
  assert.deepEqual(cancelResults.map((result) => result.replayed).sort(), [false, true]);
  const cancelled = tryReadJob(root, workerId, env);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.lifecycleEvents.filter((event) => event.type === "cancellation.requested").length, 1);
});

test("write spawn is rejected until allowWriteSpawn is enabled", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({ userRequest: "Edit file", mode: "write" });
  assert.throws(
    () => spawnReadOnlyWorker({
      root,
      principal: principal(root),
      envelope,
      idempotencyKey: "spawn-write-0001",
      write: true,
      env
    }),
    (error) => error?.code === "E_CAPABILITY"
  );
});

test("spawn binds role capability, envelope mode, and job write flag", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const readEnvelope = buildTaskEnvelope({ userRequest: "Inspect", mode: "read" });
  const writeEnvelope = buildTaskEnvelope({ userRequest: "Edit", mode: "write" });

  assert.throws(
    () => spawnReadOnlyWorker({
      root,
      principal: principal(root),
      envelope: readEnvelope,
      idempotencyKey: "spawn-role-write-on-read-0001",
      roleId: "implementer",
      env
    }),
    (error) => error?.code === "E_ROLE"
  );
  assert.throws(
    () => spawnReadOnlyWorker({
      root,
      principal: principal(root),
      envelope: writeEnvelope,
      idempotencyKey: "spawn-role-read-on-write-0001",
      roleId: "explorer",
      write: true,
      allowWriteSpawn: true,
      env
    }),
    (error) => error?.code === "E_ROLE"
  );
  assert.throws(
    () => spawnReadOnlyWorker({
      root,
      principal: principal(root),
      envelope: writeEnvelope,
      idempotencyKey: "spawn-mode-mismatch-0001",
      roleId: "explorer",
      allowWriteSpawn: true,
      env
    }),
    (error) => error?.code === "E_ROLE"
  );
});

test("cancel is idempotent with exactly one cancellation-request event", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({ userRequest: "Long task", mode: "read" });
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "spawn-cancel-0001",
    env
  });
  const runtimeAuth = path.join(
    workspaceState(root, env),
    "task-homes",
    spawned.handle.id,
    ".grok",
    "auth.json"
  );
  fs.mkdirSync(path.dirname(runtimeAuth), { recursive: true, mode: 0o700 });
  fs.writeFileSync(runtimeAuth, "transient-auth\n", { mode: 0o600 });
  const first = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: "cancel-key-0001",
    env
  });
  assert.equal(first.replayed, false);
  assert.equal(first.receipt.workerId, spawned.handle.id);
  assert.ok(first.receipt.requestAcceptedAt);

  const second = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: "cancel-key-0001",
    env
  });
  assert.equal(second.replayed, true);
  assert.equal(second.receipt.receiptId, first.receipt.receiptId);

  assert.throws(
    () => cancelWorker({
      root,
      principal: principal(root, { threadId: THREAD_B }),
      workerId: spawned.handle.id,
      idempotencyKey: "cancel-key-0001",
      env
    }),
    (error) => error?.code === "E_IDEMPOTENCY_CONFLICT"
      && !String(error.message).includes(first.receipt.receiptId)
  );

  const job = tryReadJob(root, spawned.handle.id, env);
  const cancelEvents = (job.lifecycleEvents || []).filter((event) => event.type === "cancellation.requested");
  assert.equal(cancelEvents.length, 1);
  assert.equal(
    cancelEvents[0].detail.requestAcceptedAt,
    first.receipt.requestAcceptedAt
  );
  assert.equal(
    cancelEvents[0].sequence,
    first.receipt.cancellationRequestSequence
  );
  assert.ok(
    Date.parse(cancelEvents[0].at) >= Date.parse(first.receipt.requestAcceptedAt)
  );
  assert.equal(job.status, "cancelled");
  assert.equal(job.result.hostVerification, "not_run");
  assert.equal(job.result.taskRuntimeCleaned, true);
  assert.equal(fs.existsSync(runtimeAuth), false);
  assert.equal(job.request.spawn.providerLaunchPending, false);
  assert.equal(job.request.spawn.providerLaunchInFlight, false);
  assert.equal(job.request.spawn.providerLaunchOutcome, "not-launched");
  assert.equal(job.workerAuthorization, null);
  assert.equal(job.request.spawn.dispatch.state, "failed");
  assert.equal(job.request.spawn.dispatch.lease, null);
  assert.equal(job.request.spawn.dispatch.nextProviderGeneration, null);
  assert.equal(job.request.spawn.dispatch.failedAt, first.receipt.terminalRecordCommittedAt);
  assert.equal(job.request.spawn.dispatch.updatedAt, first.receipt.terminalRecordCommittedAt);
  assert.doesNotThrow(() => assertDispatchContract(job));

  const spawnReplay = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "spawn-cancel-0001",
    env
  });
  assert.equal(spawnReplay.replayed, true);
  assert.equal(spawnReplay.handle.status, "cancelled");
  const replayedJob = tryReadJob(root, spawned.handle.id, env);
  assert.equal(replayedJob.workerAuthorization, null);
  assert.equal(replayedJob.request.spawn.dispatch.state, "failed");
  assert.doesNotThrow(() => assertDispatchContract(replayedJob));
});

test("queued cancellation never terminalizes a claimed dispatch with a pending spawn intent", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest: "Cancel after a durable controller claim", mode: "read" }),
    idempotencyKey: "spawn-cancel-claimed-intent-0001",
    env
  });
  const workerId = spawned.handle.id;
  const claim = claimWorkerDispatch({ root, principal: principal(root), workerId, env });
  const intent = prepareDispatchProcessSpawn({
    root,
    workerId,
    attemptId: claim.attemptId,
    processKind: "controller",
    nonce: claim.nonce,
    fence: claim.fence,
    env
  });
  assert.equal(intent.prepared, true);

  const runtimeAuth = path.join(
    workspaceState(root, env),
    "task-homes",
    workerId,
    ".grok",
    "auth.json"
  );
  fs.mkdirSync(path.dirname(runtimeAuth), { recursive: true, mode: 0o700 });
  fs.writeFileSync(runtimeAuth, "transient-auth\n", { mode: 0o600 });
  updateJob(root, workerId, (job) => ({
    ...job,
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        // Reproduce stale public launch flags without changing the authoritative
        // claimed dispatch, lease, or pending spawn boundary.
        providerLaunchPending: true,
        providerLaunchInFlight: false,
        providerLaunchOutcome: "pending"
      }
    }
  }), env);

  cancelWorker({
    root,
    principal: principal(root),
    workerId,
    idempotencyKey: "cancel-claimed-intent-0001",
    env
  });

  const job = tryReadJob(root, workerId, env);
  assert.equal(job.status, "queued");
  assert.equal(job.phase, "cancellation-requested");
  assert.equal(job.request.spawn.dispatch.state, "claimed");
  assert.ok(job.request.spawn.dispatch.lease);
  assert.equal(job.request.spawn.controllerSpawnIntent.status, "pending");
  assert.ok(job.workerAuthorization);
  assert.equal(fs.existsSync(runtimeAuth), true);
});

for (const guardCase of [
  { label: "live provider guard", corrupt: false },
  { label: "corrupt provider guard", corrupt: true }
]) {
  test(`queued cancel retains private runtime artifacts with a ${guardCase.label}`, {
    skip: process.platform === "win32"
  }, async (t) => {
    const root = initRepo();
    const { env } = envFor(root);
    const spawned = spawnReadOnlyWorker({
      root,
      principal: principal(root),
      envelope: buildTaskEnvelope({ userRequest: `Guarded cancellation: ${guardCase.label}`, mode: "read" }),
      idempotencyKey: `spawn-guarded-cancel-${guardCase.corrupt ? "corrupt" : "live"}-0001`,
      env
    });
    const workerId = spawned.handle.id;
    const grokHome = path.join(workspaceState(root, env), "task-homes", workerId, ".grok");
    const runtimeAuth = path.join(grokHome, "auth.json");
    const agentProfile = path.join(grokHome, "agent-profiles", "audit-profile.md");
    fs.mkdirSync(path.dirname(agentProfile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(runtimeAuth, "transient-auth\n", { mode: 0o600 });
    fs.writeFileSync(agentProfile, "private-profile\n", { mode: 0o600 });

    const provider = spawnProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", workerId, "agent", "stdio"],
      { detached: true, stdio: "ignore" }
    );
    let providerIdentity = null;
    t.after(async () => {
      try { unregisterProviderGuard(root, workerId); } catch {}
      try { process.kill(-provider.pid, "SIGKILL"); } catch {}
      if (providerIdentity) {
        try {
          await waitFor(() => processGroupGone(providerIdentity), { timeoutMs: 5_000, intervalMs: 25 });
        } catch {}
      }
    });
    providerIdentity = {
      pid: provider.pid,
      startToken: await waitFor(() => processStartToken(provider.pid), {
        timeoutMs: 5_000,
        intervalMs: 25
      }),
      processGroupId: provider.pid
    };
    registerProviderGuard(root, workerId, providerIdentity, THREAD);
    const guardFile = providerGuardFile(root, workerId);
    if (guardCase.corrupt) fs.writeFileSync(guardFile, "{malformed-provider-guard", { mode: 0o600 });

    const cancellation = cancelWorker({
      root,
      principal: principal(root),
      workerId,
      idempotencyKey: `cancel-guarded-${guardCase.corrupt ? "corrupt" : "live"}-0001`,
      env
    });
    const job = tryReadJob(root, workerId, env);

    assert.equal(cancellation.receipt.status, "accepted");
    assert.equal(cancellation.receipt.processGroupGoneAt, null);
    assert.equal(cancellation.receipt.terminalRecordCommittedAt, null);
    assert.equal(["completed", "failed", "cancelled"].includes(job.status), false);
    assert.equal(job.status, "queued");
    assert.equal(job.phase, "cancellation-requested");
    assert.equal(job.result.taskRuntimeCleaned, false);
    assert.equal(fs.readFileSync(runtimeAuth, "utf8"), "transient-auth\n");
    assert.equal(fs.readFileSync(agentProfile, "utf8"), "private-profile\n");
    assert.equal(fs.existsSync(guardFile), true);
    if (guardCase.corrupt) {
      assert.equal(fs.readFileSync(guardFile, "utf8"), "{malformed-provider-guard");
    } else {
      assert.equal(loadProviderGuard(root, workerId)?.providerProcess?.pid, provider.pid);
    }
    assert.equal(processStartToken(provider.pid), providerIdentity.startToken);
    assert.equal(processGroupGone(providerIdentity), false);
  });
}

test("terminal cancellation recovers the exact receipt after adjacent idempotency publication loss", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest: "Already complete", mode: "read" }),
    idempotencyKey: "spawn-terminal-cancel-0001",
    env
  });
  const completedAt = new Date().toISOString();
  updateJob(root, spawned.handle.id, (job) => ({
    ...job,
    status: "completed",
    phase: "completed",
    completedAt,
    result: { hostVerification: "not_run" }
  }), env);

  const first = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: "cancel-terminal-crash-0001",
    env
  });
  assert.equal(first.receipt.status, "already_terminal");
  assert.equal(first.receipt.terminalRecordCommittedAt, completedAt);

  // Simulate the prior single-record layout, then a crash after the terminal
  // job update but before its adjacent idempotency file became durable.
  updateJob(root, spawned.handle.id, (job) => {
    const legacyResult = { ...job.result };
    delete legacyResult.cancellationReceiptsByKey;
    return { ...job, result: legacyResult };
  }, env);
  fs.rmSync(path.join(workspaceState(root, env), "idempotency", "cancel"), {
    recursive: true,
    force: true
  });
  const recovered = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: "cancel-terminal-crash-0001",
    env
  });
  assert.equal(recovered.replayed, true);
  assert.deepEqual(recovered.receipt, first.receipt);
});

test("unknown authoritative status fails cancellation and reconciliation closed", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest: "Corrupt status fixture", mode: "read" }),
    idempotencyKey: "spawn-unknown-state-0001",
    env
  });
  const file = path.join(workspaceState(root, env), "jobs", `${spawned.handle.id}.json`);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.status = "UNKNOWN_AUTHORITATIVE_STATUS_CANARY";
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
  const genericStateFailure = (error) => error?.code === "E_STATE"
    && error.message === "Authoritative job state is malformed or unsafe."
    && !error.message.includes(spawned.handle.id)
    && !error.message.includes(root)
    && !error.message.includes("CANARY")
    && !error.message.includes("already_terminal")
    && error.details === undefined;

  assert.equal(tryReadJob(root, spawned.handle.id, env), null);
  assert.throws(() => cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: "cancel-unknown-state-0001",
    env
  }), genericStateFailure);
  assert.throws(() => reconcileOwnedWorkers({
    root,
    principal: principal(root),
    trusted: true,
    processAlive: () => false,
    env
  }), genericStateFailure);
});

test("distinct cancellation keys retain exact crash recovery and binding independently", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest: "Cancel with interleaved keys", mode: "read" }),
    idempotencyKey: "spawn-interleaved-cancel-0001",
    env
  });
  const keyA = "cancel-interleaved-key-A";
  const keyB = "cancel-interleaved-key-B";
  const firstA = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: keyA,
    env
  });
  fs.rmSync(cancelIdempotencyFile(root, keyA, env));

  const firstB = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: keyB,
    env
  });
  fs.rmSync(cancelIdempotencyFile(root, keyB, env));

  const afterBoth = tryReadJob(root, spawned.handle.id, env);
  assert.equal(Object.keys(afterBoth.result.cancellationReceiptsByKey).length, 2);
  const snapshot = projectWorkerSnapshot(afterBoth);
  assert.equal(Object.hasOwn(snapshot.result, "cancellationReceiptsByKey"), false);
  assert.equal(JSON.stringify(snapshot).includes(THREAD), false);

  const recoveredA = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: keyA,
    env
  });
  const recoveredB = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: keyB,
    env
  });
  assert.equal(recoveredA.replayed, true);
  assert.equal(recoveredB.replayed, true);
  assert.deepEqual(recoveredA.receipt, firstA.receipt);
  assert.deepEqual(recoveredB.receipt, firstB.receipt);

  // Removing the adjacent mappings again must not permit either cross-worker
  // or cross-owner reuse of a key whose job-side recovery is still durable.
  fs.rmSync(cancelIdempotencyFile(root, keyA, env));
  fs.rmSync(cancelIdempotencyFile(root, keyB, env));
  const other = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest: "Different cancellation target", mode: "read" }),
    idempotencyKey: "spawn-interleaved-other-0001",
    env
  });
  assert.throws(
    () => cancelWorker({
      root,
      principal: principal(root),
      workerId: other.handle.id,
      idempotencyKey: keyA,
      env
    }),
    (error) => error?.code === "E_IDEMPOTENCY_CONFLICT"
      && !String(error.message).includes(spawned.handle.id)
  );
  assert.throws(
    () => cancelWorker({
      root,
      principal: principal(root, { threadId: THREAD_B }),
      workerId: spawned.handle.id,
      idempotencyKey: keyB,
      env
    }),
    (error) => error?.code === "E_IDEMPOTENCY_CONFLICT"
      && !String(error.message).includes(THREAD)
  );
});

test("cancellation recovery history fails closed at its bound without pruning old receipts", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest: "Bound cancellation recovery", mode: "read" }),
    idempotencyKey: "spawn-cancel-bound-0001",
    env
  });
  updateJob(root, spawned.handle.id, (job) => ({
    ...job,
    status: "completed",
    phase: "completed",
    completedAt: new Date().toISOString(),
    result: { hostVerification: "not_run", taskRuntimeCleaned: true }
  }), env);

  const receipts = [];
  for (let index = 0; index < 32; index += 1) {
    receipts.push(cancelWorker({
      root,
      principal: principal(root),
      workerId: spawned.handle.id,
      idempotencyKey: `cancel-bounded-${String(index).padStart(4, "0")}`,
      env
    }).receipt);
  }
  assert.throws(
    () => cancelWorker({
      root,
      principal: principal(root),
      workerId: spawned.handle.id,
      idempotencyKey: "cancel-bounded-overflow",
      env
    }),
    (error) => error?.code === "E_STATE"
  );
  const firstKey = "cancel-bounded-0000";
  fs.rmSync(cancelIdempotencyFile(root, firstKey, env));
  const recovered = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: firstKey,
    env
  });
  assert.deepEqual(recovered.receipt, receipts[0]);
  assert.equal(
    Object.keys(tryReadJob(root, spawned.handle.id, env).result.cancellationReceiptsByKey).length,
    32
  );
});

test("running cancellation stays nonterminal even when a caller claims process-group exit", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest: "Running worker", mode: "read" }),
    idempotencyKey: "spawn-running-cancel-0001",
    env
  });
  updateJob(root, spawned.handle.id, (job) => ({
    ...job,
    status: "running",
    request: {
      ...job.request,
      spawn: { ...job.request.spawn, providerLaunchPending: false }
    }
  }), env);

  const accepted = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: "cancel-running-no-confirm-0001",
    env
  });
  assert.equal(accepted.receipt.processGroupGoneAt, null);
  assert.equal(accepted.receipt.terminalRecordCommittedAt, null);
  assert.equal(tryReadJob(root, spawned.handle.id, env).status, "running");
  assert.equal(fs.readFileSync(cancelFile(root, spawned.handle.id, env), "utf8").trim().length > 0, true);

  let obsoleteSignals = 0;
  const repeated = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: "cancel-running-confirmed-0001",
    env,
    signalProcess: () => {
      obsoleteSignals += 1;
      return { processGroupGone: true };
    }
  });
  assert.equal(obsoleteSignals, 0);
  assert.equal(repeated.receipt.processGroupGoneAt, null);
  assert.equal(repeated.receipt.terminalRecordCommittedAt, null);
  assert.equal(tryReadJob(root, spawned.handle.id, env).status, "running");
});

test("cancel uses the live worker-process nonce without caller-driven terminalization", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest: "Attached worker", mode: "read" }),
    idempotencyKey: "spawn-attached-cancel-0001",
    env
  });
  const liveNonce = "c".repeat(32);
  updateJob(root, spawned.handle.id, (job) => ({
    ...job,
    status: "running",
    workerAuthorization: null,
    workerProcess: { pid: process.pid, nonce: liveNonce },
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        providerLaunchPending: false,
        providerLaunchInFlight: false,
        providerLaunchOutcome: "launched"
      }
    }
  }), env);

  let obsoleteSignals = 0;
  const cancelled = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: "cancel-attached-worker-0001",
    env,
    signalProcess: () => {
      obsoleteSignals += 1;
      return { processGroupGone: true };
    }
  });
  assert.equal(obsoleteSignals, 0);
  assert.equal(cancelled.receipt.terminalRecordCommittedAt, null);
  assert.equal(fs.readFileSync(cancelFile(root, spawned.handle.id, env), "utf8").trim(), liveNonce);
  assert.equal(tryReadJob(root, spawned.handle.id, env).status, "running");
});

test("cancel marker publication failure is propagated without a false terminal record", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest: "Marker failure", mode: "read" }),
    idempotencyKey: "spawn-marker-failure-0001",
    env
  });
  updateJob(root, spawned.handle.id, (job) => ({
    ...job,
    status: "running",
    request: {
      ...job.request,
      spawn: { ...job.request.spawn, providerLaunchPending: false }
    }
  }), env);
  fs.mkdirSync(cancelFile(root, spawned.handle.id, env));

  assert.throws(() => cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: "cancel-marker-failure-0001",
    env
  }));
  const current = tryReadJob(root, spawned.handle.id, env);
  assert.equal(current.status, "running");
  assert.equal(current.lifecycleEvents.some((event) => event.type === "cancellation.requested"), false);
  assert.equal(current.result?.cancellation, undefined);
});

test("foreign worker id is observationally equivalent to missing id on cancel", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({ userRequest: "Owned", mode: "read" });
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "spawn-foreign-0001",
    env
  });
  const foreign = principal(root, { threadId: THREAD_B });
  assert.throws(
    () => cancelWorker({
      root,
      principal: foreign,
      workerId: spawned.handle.id,
      idempotencyKey: "cancel-foreign-0001",
      env
    }),
    (error) => error?.code === "E_JOB_NOT_FOUND"
  );
  assert.throws(
    () => cancelWorker({
      root,
      principal: principal(root),
      workerId: "task-ffffffffffffffffffffffffffffffff",
      idempotencyKey: "cancel-missing-0001",
      env
    }),
    (error) => error?.code === "E_JOB_NOT_FOUND"
  );
});

test("legacy reconciler never replays prompts and delegates Worker Dispatch v1 recovery", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({ userRequest: "Reconcile me", mode: "read" });
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "spawn-reconcile-0001",
    env
  });
  assert.throws(
    () => reconcileOwnedWorkers({
      root,
      principal: principal(root),
      trusted: true,
      replayPrompt: () => {}
    }),
    (error) => error?.code === "E_POLICY"
  );
  assert.throws(
    () => reconcileOwnedWorkers({
      root,
      principal: principal(root),
      trusted: false
    }),
    (error) => error?.code === "E_AUTH_REQUIRED"
  );
  const pending = reconcileOwnedWorkers({
    root,
    principal: principal(root),
    trusted: true,
    processAlive: () => false,
    env
  });
  assert.equal(pending.replayedPrompt, false);
  assert.ok(pending.results.some((item) => (
    item.workerId === spawned.handle.id
    && item.action === "none"
    && item.reason === "dispatch-pending-recoverable"
  )));
  assert.equal(tryReadJob(root, spawned.handle.id, env).status, "queued");

  const dispatchAttemptId = "a".repeat(32);
  updateJob(root, spawned.handle.id, (job) => ({
    ...job,
    status: "running",
    workerAuthorization: null,
    providerProcess: {
      pid: 12345,
      startToken: "provider-token",
      processGroupId: process.platform === "win32" ? null : 12345,
      commandMarker: job.id,
      dispatchAttemptId
    },
    request: {
      ...job.request,
      spawn: {
        ...job.request.spawn,
        providerLaunchPending: false,
        providerLaunchInFlight: false,
        providerLaunchOutcome: "launched",
        dispatch: {
          ...job.request.spawn.dispatch,
          state: "provider-started",
          attemptId: dispatchAttemptId,
          updatedAt: new Date().toISOString()
        }
      }
    }
  }), env);
  let legacyLivenessCalls = 0;
  const alive = reconcileOwnedWorkers({
    root,
    principal: principal(root),
    trusted: true,
    processAlive: () => {
      legacyLivenessCalls += 1;
      return true;
    },
    env
  });
  assert.ok(alive.results.some((item) => (
    item.workerId === spawned.handle.id
    && item.action === "none"
    && item.reason === "authoritative-broker-recovery-required"
  )));
  assert.equal(legacyLivenessCalls, 0);
  assert.equal(tryReadJob(root, spawned.handle.id, env).status, "running");

  const result = reconcileOwnedWorkers({
    root,
    principal: principal(root),
    trusted: true,
    processAlive: () => false,
    env
  });
  assert.equal(result.replayedPrompt, false);
  assert.ok(result.results.some((item) => (
    item.workerId === spawned.handle.id
    && item.action === "none"
    && item.reason === "authoritative-broker-recovery-required"
  )));
  const job = tryReadJob(root, spawned.handle.id, env);
  assert.equal(job.status, "running");
  assert.equal(job.completedAt, null);
  assert.equal(job.result, null);
});

test("service restart replays an unchanged spawn despite a fresh context capture timestamp", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const stableManifest = captureContextManifest(root);
  let captures = 0;
  const captureContext = () => ({
    ...stableManifest,
    capturedAt: new Date(Date.parse(stableManifest.capturedAt) + (++captures * 1000)).toISOString()
  });
  const launchWorker = () => ({ providerLaunchState: "pending", providerLaunched: false });
  const firstService = createWorkerService({
    root,
    principal: principal(root),
    env,
    launchWorker,
    captureContext
  });
  const first = firstService.spawn({
    userRequest: "Two process",
    idempotencyKey: "spawn-two-proc-0001"
  });
  // Simulate broker restart: new service reads same env/state.
  const service = createWorkerService({
    root,
    principal: principal(root),
    env,
    launchWorker,
    captureContext
  });
  const snapshot = service.get(first.handle.id);
  assert.equal(snapshot.id, first.handle.id);
  assert.equal(snapshot.lifecycleEvents.length >= 1, true);
  // Idempotent spawn after restart returns same worker.
  const replay = service.spawn({
    userRequest: "Two process",
    idempotencyKey: "spawn-two-proc-0001"
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.handle.id, first.handle.id);
});

test("MCP worker_spawn and worker_cancel drive real service functions", async () => {
  const root = initRepo();
  const { env } = envFor(root);
  const auth = principal(root);
  const providerCapabilityReceipt = {
    capabilityDigest: "d".repeat(64),
    capabilities: [ROOT_READ_PROVIDER_CAPABILITY]
  };
  const runtime = createMcpBrokerRuntime({
    providerCapabilityReceipt
  });
  const options = {
    runtime,
    readProviderCapabilityReceipt: () => providerCapabilityReceipt,
    resolveAuthority: () => auth,
    env,
    createService: () => createWorkerService({
      root,
      principal: auth,
      env,
      launchWorker: () => ({ providerLaunchState: "pending", providerLaunched: false })
    })
  };
  const spawned = await callWorkerTool({
    name: "worker_spawn",
    arguments: {
      idempotencyKey: "mcp-spawn-00000001",
      userRequest: "List top-level files"
    }
  }, options);
  assert.equal(spawned.structuredContent.ok, true);
  assert.equal(spawned.structuredContent.providerLaunched, false);
  assert.ok(spawned.structuredContent.worker.id);
  assert.equal(tryReadJob(root, spawned.structuredContent.worker.id, env).write, false);

  const again = await callWorkerTool({
    name: "worker_spawn",
    arguments: {
      idempotencyKey: "mcp-spawn-00000001",
      userRequest: "List top-level files"
    }
  }, options);
  assert.equal(again.structuredContent.replayed, true);
  assert.equal(again.structuredContent.worker.id, spawned.structuredContent.worker.id);

  const writeRejected = await callWorkerTool({
    name: "worker_spawn",
    arguments: {
      idempotencyKey: "mcp-spawn-write-0001",
      userRequest: "Edit something",
      write: true
    }
  }, options);
  assert.equal(writeRejected.isError, true);
  assert.equal(writeRejected.structuredContent.error.code, "E_USAGE");

  const cancelled = await callWorkerTool({
    name: "worker_cancel",
    arguments: {
      id: spawned.structuredContent.worker.id,
      idempotencyKey: "mcp-cancel-00000001"
    }
  }, options);
  assert.equal(cancelled.structuredContent.ok, true);
  assert.ok(cancelled.structuredContent.receipt.receiptId);

  const cancelAgain = await callWorkerTool({
    name: "worker_cancel",
    arguments: {
      id: spawned.structuredContent.worker.id,
      idempotencyKey: "mcp-cancel-00000001"
    }
  }, options);
  assert.equal(cancelAgain.structuredContent.replayed, true);

  const listed = await callWorkerTool({ name: "worker_list_owned", arguments: {} }, options);
  assert.ok(listed.structuredContent.workers.some((worker) => worker.id === spawned.structuredContent.worker.id));
});

test("low-level spawn rejects a second provider launch lifecycle before durable commit", () => {
  const root = initRepo();
  const { env } = envFor(root);
  assert.throws(
    () => spawnReadOnlyWorker({
        root,
        principal: principal(root),
        envelope: buildTaskEnvelope({ userRequest: "Reject split launch", mode: "read" }),
        idempotencyKey: "spawn-split-launch-0001",
        env,
        providerLaunch: () => ({ providerLaunched: true })
      }),
    (error) => error?.code === "E_CAPABILITY"
  );
  assert.equal(listJobs(root, env).length, 0);
});
