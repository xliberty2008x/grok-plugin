import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildTaskEnvelope } from "../plugins/grok/scripts/lib/task-contract.mjs";
import { projectWorkerSnapshot } from "../plugins/grok/scripts/lib/worker-protocol.mjs";
import {
  cancelWorker,
  spawnReadOnlyWorker,
  SPAWN_SUCCESS_DEFINITION
} from "../plugins/grok/scripts/lib/worker-mutation.mjs";
import { reconcileOwnedWorkers } from "../plugins/grok/scripts/lib/worker-reconcile.mjs";
import { createWorkerService } from "../plugins/grok/scripts/lib/worker-service.mjs";
import { callWorkerTool, handleMcpRequest } from "../plugins/grok/mcp/broker.mjs";
import {
  cancelFile,
  listJobs,
  tryReadJob,
  updateJob
} from "../plugins/grok/scripts/lib/state.mjs";
import { workspaceState, workspaceStateSegment } from "../plugins/grok/scripts/lib/workspace.mjs";
import { initRepo, tempDir } from "./helpers.mjs";

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

test("spawn commits durable job without provider launch; retry is idempotent", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({ userRequest: "Inspect package.json", mode: "read" });
  let launches = 0;
  const first = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "spawn-key-0001",
    env,
    providerLaunch: () => { launches += 1; return { providerLaunched: true }; }
  });
  assert.equal(first.replayed, false);
  assert.equal(first.spawnSuccessDefinition, SPAWN_SUCCESS_DEFINITION);
  assert.equal(first.handle.status, "queued");
  assert.equal(first.handle.externalWorkerLabel, "external-grok-worker");
  assert.equal(launches, 1);

  const second = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "spawn-key-0001",
    env,
    providerLaunch: () => { launches += 1; return { providerLaunched: true }; }
  });
  assert.equal(second.replayed, true);
  assert.equal(second.handle.id, first.handle.id);
  assert.equal(launches, 1, "provider launch must not re-run on idempotent retry");

  const job = tryReadJob(root, first.handle.id, env);
  assert.ok(job);
  assert.equal(job.host.sessionId, THREAD);
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
});

test("spawn and cancel are cross-process idempotent under the workspace transaction", async () => {
  const root = initRepo();
  const { env } = envFor(root);
  const markerDir = tempDir("grok-spawn-launch-marker-");
  const launchMarker = path.join(markerDir, "launches.log");
  const source = `
    import fs from "node:fs";
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
      idempotencyKey: "spawn-cross-process-0001",
      providerLaunch: () => {
        fs.appendFileSync(${JSON.stringify(launchMarker)}, "launch\\n");
        return { providerLaunched: false };
      }
    });
    console.log(JSON.stringify(result));
  `;
  const spawnRuns = await Promise.all([runIsolatedModule(source), runIsolatedModule(source)]);
  for (const run of spawnRuns) assert.equal(run.code, 0, run.stderr);
  const spawnResults = spawnRuns.map((run) => lastJson(run.stdout));
  assert.equal(spawnResults[0].handle.id, spawnResults[1].handle.id);
  assert.deepEqual(spawnResults.map((result) => result.replayed).sort(), [false, true]);
  assert.equal(fs.readFileSync(launchMarker, "utf8").trim().split(/\r?\n/).length, 1);
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
  assert.equal(job.status, "cancelled");
  assert.equal(job.result.hostVerification, "not_run");
  assert.equal(job.result.taskRuntimeCleaned, true);
  assert.equal(job.request.spawn.providerLaunchPending, false);
  assert.equal(job.request.spawn.providerLaunchInFlight, false);
  assert.equal(job.request.spawn.providerLaunchOutcome, "not-launched");
});

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

test("running cancellation stays nonterminal without explicit process-group confirmation", () => {
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

  const confirmed = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: "cancel-running-confirmed-0001",
    env,
    signalProcess: () => ({ processGroupGone: true })
  });
  assert.ok(confirmed.receipt.processGroupGoneAt);
  assert.ok(confirmed.receipt.terminalRecordCommittedAt);
  assert.equal(tryReadJob(root, spawned.handle.id, env).status, "cancelled");
});

test("cancel uses the live worker-process nonce after launch authorization handoff", () => {
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

  const cancelled = cancelWorker({
    root,
    principal: principal(root),
    workerId: spawned.handle.id,
    idempotencyKey: "cancel-attached-worker-0001",
    env,
    signalProcess: () => ({ processGroupGone: true })
  });
  assert.ok(cancelled.receipt.terminalRecordCommittedAt);
  assert.equal(fs.readFileSync(cancelFile(root, spawned.handle.id, env), "utf8").trim(), liveNonce);
  assert.equal(tryReadJob(root, spawned.handle.id, env).status, "cancelled");
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

test("reconciler never replays prompts and marks lost processes", () => {
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
    && item.reason === "provider-launch-unsettled"
  )));
  assert.equal(tryReadJob(root, spawned.handle.id, env).status, "queued");

  updateJob(root, spawned.handle.id, (job) => ({
    ...job,
    status: "running",
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
  const alive = reconcileOwnedWorkers({
    root,
    principal: principal(root),
    trusted: true,
    processAlive: () => true,
    env
  });
  assert.ok(alive.results.some((item) => (
    item.workerId === spawned.handle.id
    && item.action === "none"
    && item.reason === "process-alive"
  )));
  assert.equal(tryReadJob(root, spawned.handle.id, env).status, "running");

  const result = reconcileOwnedWorkers({
    root,
    principal: principal(root),
    trusted: true,
    processAlive: () => false,
    env
  });
  assert.equal(result.replayedPrompt, false);
  assert.ok(result.results.some((item) => item.workerId === spawned.handle.id && item.action === "marked-lost"));
  const job = tryReadJob(root, spawned.handle.id, env);
  assert.equal(job.status, "failed");
  assert.equal(job.result.runtimeEvidence.reconciler.replayedPrompt, false);
  assert.equal(job.result.hostVerification, "not_run");
});

test("spawn with throw after commit still left job on disk (two-step simulation)", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({ userRequest: "Two process", mode: "read" });
  const first = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "spawn-two-proc-0001",
    env
  });
  // Simulate broker restart: new service reads same env/state.
  const service = createWorkerService({
    root,
    principal: principal(root),
    env
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
  const options = {
    resolveAuthority: () => auth,
    env,
    createService: () => createWorkerService({ root, principal: auth, env })
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
  assert.equal(writeRejected.structuredContent.error.code, "E_CAPABILITY");

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

// Fix crash-path test: spawn should commit even if we don't call providerLaunch
test("provider launch failure after durable commit does not delete the job", () => {
  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({ userRequest: "Launch fail", mode: "read" });
  let threw = false;
  try {
    spawnReadOnlyWorker({
      root,
      principal: principal(root),
      envelope,
      idempotencyKey: "spawn-launch-fail-0001",
      env,
      providerLaunch: () => {
        throw new Error("provider boom");
      }
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, true);
  // Idempotency record may or may not exist depending on order — job must exist if commit-before-launch.
  // Our implementation writes idempotency then launches; if launch throws, job+idempotency remain.
  const replay = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "spawn-launch-fail-0001",
    env
  });
  assert.equal(replay.replayed, true);
  assert.ok(tryReadJob(root, replay.handle.id, env));
});

test("provider launch truth requires an explicit positive hook outcome", () => {
  const root = initRepo();
  const { env } = envFor(root);
  let invoked = 0;
  const envelope = buildTaskEnvelope({ userRequest: "Ambiguous launch outcome", mode: "read" });
  assert.throws(
    () => spawnReadOnlyWorker({
      root,
      principal: principal(root),
      envelope,
      idempotencyKey: "spawn-launch-ambiguous-0001",
      env,
      providerLaunch: () => { invoked += 1; }
    }),
    (error) => error?.code === "E_CAPABILITY"
  );
  assert.equal(invoked, 1);
  const replay = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "spawn-launch-ambiguous-0001",
    env
  });
  assert.equal(replay.replayed, true);
  const current = tryReadJob(root, replay.handle.id, env);
  assert.equal(current.request.spawn.providerLaunchInFlight, true);
  assert.equal(current.request.spawn.providerLaunchOutcome, "unknown");
  assert.equal(current.request.spawn.providerLaunchCompletedAt, null);
});

test("provider launch rejects async and thenable adapters without losing launch ambiguity", async () => {
  const asyncRoot = initRepo();
  const asyncEnv = envFor(asyncRoot).env;
  assert.throws(
    () => spawnReadOnlyWorker({
      root: asyncRoot,
      principal: principal(asyncRoot),
      envelope: buildTaskEnvelope({ userRequest: "Async adapter", mode: "read" }),
      idempotencyKey: "spawn-launch-async-0001",
      env: asyncEnv,
      providerLaunch: async () => ({ providerLaunched: true })
    }),
    (error) => error?.code === "E_CAPABILITY"
  );
  assert.equal(listJobs(asyncRoot, asyncEnv).length, 0, "declared async adapters fail before commit");

  const root = initRepo();
  const { env } = envFor(root);
  const envelope = buildTaskEnvelope({ userRequest: "Thenable adapter", mode: "read" });
  let launchedLater = false;
  assert.throws(
    () => spawnReadOnlyWorker({
      root,
      principal: principal(root),
      envelope,
      idempotencyKey: "spawn-launch-thenable-0001",
      env,
      providerLaunch: () => new Promise((resolve) => {
        setTimeout(() => {
          launchedLater = true;
          resolve({ providerLaunched: true });
        }, 20);
      })
    }),
    (error) => error?.code === "E_CAPABILITY"
  );
  const replay = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope,
    idempotencyKey: "spawn-launch-thenable-0001",
    env
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(launchedLater, true);
  const current = tryReadJob(root, replay.handle.id, env);
  assert.equal(current.request.spawn.providerLaunchOutcome, "unknown");
  assert.equal(current.request.spawn.providerLaunchInFlight, true);
  assert.equal(current.request.spawn.providerLaunchCompletedAt, null);
});

test("provider launch hook observes a cancel marker created in the commit-to-launch window", () => {
  const root = initRepo();
  const { env } = envFor(root);
  let markerObserved = false;
  let processStarted = false;
  let immutableReceipt = null;
  const spawned = spawnReadOnlyWorker({
    root,
    principal: principal(root),
    envelope: buildTaskEnvelope({ userRequest: "Cancel launch window", mode: "read" }),
    idempotencyKey: "spawn-launch-window-0001",
    env,
    providerLaunch: ({ job, cancelRequested }) => {
      immutableReceipt = cancelWorker({
        root,
        principal: principal(root),
        workerId: job.id,
        idempotencyKey: "cancel-launch-window-0001",
        env
      }).receipt;
      markerObserved = cancelRequested();
      if (!markerObserved) {
        processStarted = true;
        return { providerLaunched: true };
      }
      return { providerLaunched: false };
    }
  });
  assert.equal(spawned.providerLaunched, false);
  assert.equal(spawned.handle.status, "cancelled");
  assert.equal(spawned.handle.phase, "cancelled");
  assert.equal(markerObserved, true);
  assert.equal(processStarted, false);
  const current = tryReadJob(root, spawned.handle.id, env);
  assert.equal(current.status, "cancelled");
  assert.equal(current.phase, "cancelled");
  assert.equal(current.request.spawn.providerLaunchInFlight, false);
  assert.equal(current.request.spawn.providerLaunchOutcome, "not-launched");
  assert.ok(current.completedAt);
  assert.equal(current.result.taskRuntimeCleaned, true);
  assert.equal(current.result.cancellation.terminalRecordCommittedAt, null);
  const storedReceipt = current.result.cancellationReceiptsByKey[
    immutableReceipt.idempotencyKeyDigest
  ].receipt;
  assert.deepEqual(storedReceipt, immutableReceipt);
});
