import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  admitJob,
  cancelFile,
  config,
  ensurePrivateStateDirectory,
  generateId,
  isCancelRequested,
  listJobs,
  listJobsReadonly,
  readJob,
  requestCancel,
  retain,
  selectJob,
  setConfig,
  tryReadJob,
  updateJob,
  withWorkspaceStateTransaction,
  writeJob
} from "../plugins/grok/scripts/lib/state.mjs";
import { workspaceState } from "../plugins/grok/scripts/lib/workspace.mjs";
import { initRepo, tempDir } from "./helpers.mjs";

const STATE_MODULE_URL = new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url).href;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForPath(file, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}.`);
    await delay(10);
  }
}

function runStateChild(source, args, env) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const completion = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`State child timed out. stdout=${stdout} stderr=${stderr}`));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`State child exited ${code ?? signal}. stdout=${stdout} stderr=${stderr}`));
    });
  });
  completion.catch(() => {});
  return { child, completion };
}

function job(id, overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    kind: "task",
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    claudeSessionId: "session-a",
    unknownFutureField: { preserved: true },
    ...overrides
  };
}

function isGenericAuthoritativeStateError(error, forbidden = []) {
  return error?.code === "E_STATE"
    && error.message === "Authoritative job state is malformed or unsafe."
    && forbidden.every((value) => !error.message.includes(String(value)))
    && error.details === undefined;
}

test("configuration uses isolated workspace state and atomic private files", () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  const pluginData = tempDir("grok-state-data-");
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    const root = initRepo();
    assert.deepEqual(config(root), {
      schemaVersion: 1,
      stopReviewGate: false,
      disclosureAccepted: false
    });
    const updated = setConfig(root, { stopReviewGate: true, disclosureAccepted: true });
    assert.equal(updated.stopReviewGate, true);
    assert.equal(updated.disclosureAccepted, true);

    const stateRoot = workspaceState(root);
    assert.ok(stateRoot.startsWith(fs.realpathSync(pluginData)));
    const configFile = `${stateRoot}/config.json`;
    assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(stateRoot).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("workspace state refuses symlinked state and lock directories", () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  const pluginData = tempDir("grok-state-data-");
  const outside = tempDir("grok-state-outside-");
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    fs.symlinkSync(outside, `${pluginData}/state`, "dir");
    const root = initRepo();
    assert.throws(
      () => config(root),
      (error) => error?.code === "E_STATE" && /unsafe plugin state directory/.test(error.message)
    );
    fs.unlinkSync(`${pluginData}/state`);

    const stateRoot = workspaceState(root);
    config(root);
    fs.symlinkSync(outside, `${stateRoot}/idempotency`, "dir");
    assert.throws(
      () => ensurePrivateStateDirectory(root, ["idempotency", "spawn"]),
      (error) => error?.code === "E_STATE" && /unsafe plugin state directory/.test(error.message)
    );
    fs.unlinkSync(`${stateRoot}/idempotency`);
    fs.rmSync(`${stateRoot}/locks`, { recursive: true });
    fs.symlinkSync(outside, `${stateRoot}/locks`, "dir");
    assert.throws(
      () => setConfig(root, { disclosureAccepted: true }),
      (error) => error?.code === "E_STATE" && /unsafe plugin state directory/.test(error.message)
    );
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("workspace state transaction exposes unlocked admission and serialized job updates", () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tempDir("grok-state-data-");
  try {
    const root = initRepo();
    const id = generateId("task");
    const committed = withWorkspaceStateTransaction(root, (transaction) => {
      transaction.admitJob(job(id, { status: "queued", write: false }));
      return transaction.updateJob(id, (current) => ({ ...current, summary: "transactional" }));
    });
    assert.equal(committed.id, id);
    assert.equal(readJob(root, id).summary, "transactional");
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("cross-process contender does not reclaim the mkdir-to-owner construction window", async () => {
  const pluginData = tempDir("grok-state-data-");
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginData };
  const root = initRepo();
  config(root, env);
  const lock = path.join(workspaceState(root, env), "locks", "config.lock");
  fs.mkdirSync(lock, { mode: 0o700 });
  const originalIdentity = fs.lstatSync(lock).ino;

  const source = `
    import { setConfig } from ${JSON.stringify(STATE_MODULE_URL)};
    setConfig(process.argv[1], { constructionContender: true }, process.env);
  `;
  const running = runStateChild(source, [root], env);
  try {
    await delay(400);
    assert.equal(fs.lstatSync(lock).ino, originalIdentity, "contender stole a lock still inside its construction grace");
    fs.rmSync(lock, { recursive: true });
    await running.completion;
    assert.equal(config(root, env).constructionContender, true);
  } finally {
    if (running.child.exitCode == null && running.child.signalCode == null) running.child.kill("SIGKILL");
  }
});

test("a dead provisional owner is reclaimed before the ownerless construction grace expires", () => {
  const pluginData = tempDir("grok-state-data-");
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginData };
  const root = initRepo();
  config(root, env);
  const locks = path.join(workspaceState(root, env), "locks");
  const lock = path.join(locks, "config.lock");
  fs.mkdirSync(lock, { mode: 0o700 });
  const stat = fs.lstatSync(lock);
  const identity = { dev: String(stat.dev), ino: String(stat.ino) };
  const deadPid = 99_999_999;
  fs.writeFileSync(
    path.join(lock, `owner.json.${deadPid}.${"a".repeat(12)}.tmp`),
    `${JSON.stringify({
      schemaVersion: 2,
      token: "b".repeat(32),
      pid: deadPid,
      startToken: "dead-provisional-owner",
      directory: identity
    })}\n`,
    { mode: 0o600 }
  );

  assert.equal(setConfig(root, { recoveredProvisionalOwner: true }, env).recoveredProvisionalOwner, true);
  assert.equal(fs.existsSync(lock), false);
});

test("a delayed owner publisher cannot overwrite an owned successor generation", async () => {
  const pluginData = tempDir("grok-state-data-");
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginData };
  const root = initRepo();
  config(root, env);
  const signals = tempDir("grok-state-owner-publish-race-");
  const constructorReady = path.join(signals, "constructor-ready");
  const resumeConstructor = path.join(signals, "resume-constructor");
  const successorReady = path.join(signals, "successor-ready");
  const releaseSuccessor = path.join(signals, "release-successor");

  const delayedConstructorSource = `
    import fs from "node:fs";
    const originalOpen = fs.openSync;
    let delayed = false;
    fs.openSync = (file, flags, ...rest) => {
      if (!delayed && flags === "wx" && String(file).includes("owner.json.") && String(file).endsWith(".tmp")) {
        delayed = true;
        fs.writeFileSync(process.argv[2], "ready\\n", { mode: 0o600 });
        while (!fs.existsSync(process.argv[3])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return originalOpen(file, flags, ...rest);
    };
    const { setConfig } = await import(${JSON.stringify(STATE_MODULE_URL)});
    setConfig(process.argv[1], { delayedConstructorCommitted: true }, process.env);
  `;
  const delayedConstructor = runStateChild(
    delayedConstructorSource,
    [root, constructorReady, resumeConstructor],
    env
  );

  let successor;
  try {
    await waitForPath(constructorReady);
    const locks = path.join(workspaceState(root, env), "locks");
    const lock = path.join(locks, "config.lock");
    const abandonedIdentity = fs.lstatSync(lock).ino;
    assert.equal(fs.existsSync(path.join(lock, "owner.json")), false);
    const abandonedAt = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, abandonedAt, abandonedAt);

    const successorSource = `
      import fs from "node:fs";
      const originalRename = fs.renameSync;
      let held = false;
      fs.renameSync = (from, to) => {
        if (!held && String(to).endsWith("/config.json")) {
          held = true;
          fs.writeFileSync(process.argv[2], "ready\\n", { mode: 0o600 });
          while (!fs.existsSync(process.argv[3])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        return originalRename(from, to);
      };
      const { setConfig } = await import(${JSON.stringify(STATE_MODULE_URL)});
      setConfig(process.argv[1], { successorCommitted: true }, process.env);
    `;
    successor = runStateChild(successorSource, [root, successorReady, releaseSuccessor], env);
    await waitForPath(successorReady);

    const successorIdentity = fs.lstatSync(lock).ino;
    assert.notEqual(successorIdentity, abandonedIdentity);
    const successorOwner = fs.readFileSync(path.join(lock, "owner.json"), "utf8");

    fs.writeFileSync(resumeConstructor, "resume\n", { mode: 0o600 });
    await delay(350);
    assert.equal(
      fs.readFileSync(path.join(lock, "owner.json"), "utf8"),
      successorOwner,
      "delayed constructor overwrote the successor owner"
    );
    assert.equal(delayedConstructor.child.exitCode, null, "delayed constructor bypassed the live successor");

    fs.writeFileSync(releaseSuccessor, "release\n", { mode: 0o600 });
    await Promise.all([successor.completion, delayedConstructor.completion]);
    assert.deepEqual(
      {
        delayedConstructorCommitted: config(root, env).delayedConstructorCommitted,
        successorCommitted: config(root, env).successorCommitted
      },
      { delayedConstructorCommitted: true, successorCommitted: true }
    );
    assert.equal(fs.existsSync(lock), false, "canonical lock leaked after both constructors completed");
    assert.deepEqual(fs.readdirSync(locks).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    for (const running of [successor, delayedConstructor]) {
      if (running?.child.exitCode == null && running?.child.signalCode == null) running.child.kill("SIGKILL");
    }
  }
});

test("genuinely abandoned ownerless lock is frozen and recovered", () => {
  const pluginData = tempDir("grok-state-data-");
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginData };
  const root = initRepo();
  config(root, env);
  const locks = path.join(workspaceState(root, env), "locks");
  const lock = path.join(locks, "config.lock");
  fs.mkdirSync(lock, { mode: 0o700 });
  const stat = fs.lstatSync(lock);
  const oldFingerprint = crypto
    .createHash("sha256")
    .update(`${stat.dev}:${stat.ino}:ownerless`)
    .digest("hex")
    .slice(0, 24);
  fs.mkdirSync(`${lock}.stale-${oldFingerprint}`, { mode: 0o700 });
  const abandonedAt = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, abandonedAt, abandonedAt);

  assert.equal(setConfig(root, { recoveredOwnerlessLock: true }, env).recoveredOwnerlessLock, true);
  assert.equal(fs.existsSync(lock), false);
  const retired = fs.readdirSync(locks).find((name) => (
    name.startsWith(`config.lock.stale-${oldFingerprint}-`)
  ));
  assert.ok(retired, "stale generation did not leave its compare-and-swap witness");
  assert.equal(fs.statSync(path.join(locks, retired)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(locks, retired, "transition.json")).mode & 0o777, 0o600);
});

test("a foreign transition never authorizes reclaiming its lock generation", async () => {
  const pluginData = tempDir("grok-state-data-");
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginData };
  const root = initRepo();
  config(root, env);
  const locks = path.join(workspaceState(root, env), "locks");
  const lock = path.join(locks, "config.lock");
  fs.mkdirSync(lock, { mode: 0o700 });
  const stat = fs.lstatSync(lock);
  const identity = { dev: String(stat.dev), ino: String(stat.ino) };
  fs.writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify({
    schemaVersion: 2,
    token: "a".repeat(32),
    pid: 99_999_999,
    startToken: "dead-process",
    directory: identity
  })}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(lock, "transition.json"), `${JSON.stringify({
    schemaVersion: 1,
    kind: "reclaim",
    token: "b".repeat(32),
    pid: process.pid,
    target: identity
  })}\n`, { mode: 0o600 });

  const source = `
    import { setConfig } from ${JSON.stringify(STATE_MODULE_URL)};
    setConfig(process.argv[1], { recoveredAfterForeignTransition: true }, process.env);
  `;
  const running = runStateChild(source, [root], env);
  try {
    await delay(350);
    assert.equal(fs.lstatSync(lock).ino, stat.ino, "reclaimer used a transition it did not own");
    assert.equal(
      fs.readdirSync(locks).some((name) => name.startsWith("config.lock.stale-")),
      false,
      "foreign transition was incorrectly treated as a reclaim witness"
    );
    fs.unlinkSync(path.join(lock, "transition.json"));
    await running.completion;
    assert.equal(config(root, env).recoveredAfterForeignTransition, true);
  } finally {
    if (running.child.exitCode == null && running.child.signalCode == null) running.child.kill("SIGKILL");
  }
});

test("cross-process stale reclaimers serialize without deleting a successor", async () => {
  const pluginData = tempDir("grok-state-data-");
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginData };
  const root = initRepo();
  config(root, env);
  const locks = path.join(workspaceState(root, env), "locks");
  const lock = path.join(locks, "config.lock");
  fs.mkdirSync(lock, { mode: 0o700 });
  const stat = fs.lstatSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify({
    schemaVersion: 2,
    token: "a".repeat(32),
    pid: 99999999,
    startToken: "dead-process",
    directory: { dev: String(stat.dev), ino: String(stat.ino) }
  })}\n`, { mode: 0o600 });

  const barrier = path.join(tempDir("grok-state-barrier-"), "start");
  const source = `
    import fs from "node:fs";
    import { setConfig } from ${JSON.stringify(STATE_MODULE_URL)};
    while (!fs.existsSync(process.argv[3])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    setConfig(process.argv[1], { [process.argv[2]]: true }, process.env);
  `;
  const first = runStateChild(source, [root, "reclaimerOne", barrier], env);
  const second = runStateChild(source, [root, "reclaimerTwo", barrier], env);
  try {
    await delay(50);
    fs.writeFileSync(barrier, "go\n", { mode: 0o600 });
    await Promise.all([first.completion, second.completion]);
    const stored = config(root, env);
    assert.equal(stored.reclaimerOne, true);
    assert.equal(stored.reclaimerTwo, true);
    assert.equal(fs.existsSync(lock), false);
    assert.equal(fs.readdirSync(locks).filter((name) => name.startsWith("config.lock.stale-")).length, 1);
  } finally {
    for (const running of [first, second]) {
      if (running.child.exitCode == null && running.child.signalCode == null) running.child.kill("SIGKILL");
    }
  }
});

test("an old owner finally block cannot remove a replacement lock generation", async () => {
  const pluginData = tempDir("grok-state-data-");
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginData };
  const root = initRepo();
  const signals = tempDir("grok-state-release-race-");
  const ready = path.join(signals, "ready");
  const release = path.join(signals, "release");
  const source = `
    import fs from "node:fs";
    import { withWorkspaceStateTransaction } from ${JSON.stringify(STATE_MODULE_URL)};
    withWorkspaceStateTransaction(process.argv[1], () => {
      fs.writeFileSync(process.argv[2], "ready\\n", { mode: 0o600 });
      while (!fs.existsSync(process.argv[3])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }, process.env);
  `;
  const running = runStateChild(source, [root, ready, release], env);
  try {
    await waitForPath(ready);
    const locks = path.join(workspaceState(root, env), "locks");
    const activeName = fs.readdirSync(locks).find((name) => name.endsWith(".lock"));
    assert.ok(activeName);
    const lock = path.join(locks, activeName);
    const displaced = `${lock}.displaced`;
    fs.renameSync(lock, displaced);
    fs.mkdirSync(lock, { mode: 0o700 });
    const replacementStat = fs.lstatSync(lock);
    const replacementToken = "b".repeat(32);
    fs.writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify({
      schemaVersion: 2,
      token: replacementToken,
      pid: process.pid,
      startToken: null,
      directory: { dev: String(replacementStat.dev), ino: String(replacementStat.ino) }
    })}\n`, { mode: 0o600 });

    fs.writeFileSync(release, "release\n", { mode: 0o600 });
    await running.completion;
    assert.equal(fs.existsSync(lock), true, "old owner removed its successor's live lock");
    assert.equal(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).token, replacementToken);
    fs.rmSync(lock, { recursive: true });
    fs.rmSync(displaced, { recursive: true });
  } finally {
    if (running.child.exitCode == null && running.child.signalCode == null) running.child.kill("SIGKILL");
  }
});

test("job IDs are random, path-safe, and records preserve unknown fields", () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tempDir("grok-state-data-");
  try {
    const root = initRepo();
    const first = generateId("task");
    const second = generateId("task");
    assert.match(first, /^task-[a-f0-9]{24}$/);
    assert.notEqual(first, second);

    writeJob(root, job(first));
    updateJob(root, first, (current) => {
      current.summary = "updated";
      return current;
    });
    const stored = readJob(root, first);
    assert.equal(stored.summary, "updated");
    assert.deepEqual(stored.unknownFutureField, { preserved: true });
    assert.equal(fs.statSync(`${workspaceState(root)}/jobs/${first}.json`).mode & 0o777, 0o600);

    assert.throws(
      () => readJob(root, "../../outside"),
      (error) => error.code === "E_USAGE"
    );
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("authoritative job reads and admission fail closed while readonly views hide corruption", () => {
  const scenarios = [
    {
      name: "malformed-json",
      contents: () => "{\"raw\":\"MALFORMED_JSON_CANARY\"",
      validFileName: true
    },
    {
      name: "non-object",
      contents: () => "[\"NON_OBJECT_CANARY\"]\n",
      validFileName: true
    },
    {
      name: "id-mismatch",
      contents: ({ otherId }) => `${JSON.stringify(job(otherId, { status: "running", write: false }))}\n`,
      validFileName: true
    },
    {
      name: "unknown-status",
      contents: ({ id }) => `${JSON.stringify(job(id, {
        status: "UNKNOWN_STATUS_CANARY",
        write: false
      }))}\n`,
      validFileName: true
    },
    {
      name: "unsafe-filename",
      contents: ({ id }) => `${JSON.stringify(job(id, { status: "running", write: false }))}\n`,
      validFileName: false
    }
  ];

  for (const scenario of scenarios) {
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: tempDir("grok-state-data-") };
    const root = initRepo();
    config(root, env);
    const id = generateId("task");
    const otherId = generateId("task");
    const fileName = scenario.validFileName ? `${id}.json` : "UNSAFE_FILENAME_CANARY.json";
    const file = path.join(workspaceState(root, env), "jobs", fileName);
    fs.writeFileSync(file, scenario.contents({ id, otherId }), { mode: 0o600 });
    const forbidden = [root, id, otherId, "CANARY", fileName];

    assert.throws(
      () => listJobs(root, env),
      (error) => isGenericAuthoritativeStateError(error, forbidden),
      scenario.name
    );
    assert.throws(
      () => withWorkspaceStateTransaction(root, (transaction) => transaction.listJobs(), env),
      (error) => isGenericAuthoritativeStateError(error, forbidden),
      `${scenario.name} transaction list`
    );
    assert.throws(
      () => admitJob(root, job(generateId("task"), { status: "queued", write: false }), env),
      (error) => isGenericAuthoritativeStateError(error, forbidden),
      `${scenario.name} admission`
    );
    if (scenario.validFileName) {
      assert.throws(
        () => readJob(root, id, env),
        (error) => isGenericAuthoritativeStateError(error, forbidden),
        `${scenario.name} direct read`
      );
      assert.throws(
        () => withWorkspaceStateTransaction(root, (transaction) => transaction.tryReadJob(id), env),
        (error) => isGenericAuthoritativeStateError(error, forbidden),
        `${scenario.name} transaction try-read`
      );
    }
    assert.equal(tryReadJob(root, id, env), null, `${scenario.name} readonly try-read`);
    assert.deepEqual(listJobsReadonly(root, env), [], `${scenario.name} readonly list`);
  }
});

test("authoritative kind and class relationships cannot bypass the lineage cleanup fence", () => {
  const scenarios = [
    {
      name: "unknown-class",
      overrides: { jobClass: "FUTURE_CLASS_CANARY" }
    },
    {
      name: "mismatched-class",
      overrides: { jobClass: "review" }
    },
    {
      name: "id-kind-mismatch",
      overrides: { kind: "review", jobClass: "review" }
    },
    {
      name: "unknown-kind",
      overrides: { kind: "FUTURE_KIND_CANARY", jobClass: "task" }
    }
  ];

  for (const scenario of scenarios) {
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: tempDir("grok-state-data-") };
    const root = initRepo();
    config(root, env);
    const id = generateId("task");
    const requestedId = generateId("task");
    const lineage = `LINEAGE_CANARY_${scenario.name}`;
    const stored = job(id, {
      status: "completed",
      jobClass: "task",
      write: false,
      request: { providerHomeId: lineage },
      result: { taskRuntimeCleaned: false },
      ...scenario.overrides
    });
    fs.writeFileSync(
      path.join(workspaceState(root, env), "jobs", `${id}.json`),
      `${JSON.stringify(stored)}\n`,
      { mode: 0o600 }
    );
    const forbidden = [root, id, requestedId, lineage, "CANARY"];

    assert.throws(
      () => admitJob(root, job(requestedId, {
        status: "queued",
        jobClass: "task",
        write: false,
        request: { providerHomeId: lineage }
      }), env),
      (error) => isGenericAuthoritativeStateError(error, forbidden),
      scenario.name
    );
    assert.throws(
      () => readJob(root, id, env),
      (error) => isGenericAuthoritativeStateError(error, forbidden),
      `${scenario.name} strict read`
    );
    assert.equal(tryReadJob(root, id, env), null, `${scenario.name} readonly read`);
    assert.deepEqual(listJobsReadonly(root, env), [], `${scenario.name} readonly list`);
  }
});

test("legacy job classes normalize across reads, cleanup fences, retention, and persistence", () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tempDir("grok-state-data-");
  try {
    const root = initRepo();
    config(root);
    const taskId = generateId("task");
    const reviewId = generateId("review");
    const writtenId = generateId("task");
    const lineage = "legacy-cleanup-pending-lineage";
    const jobsDirectory = path.join(workspaceState(root), "jobs");
    const seedLegacy = (record) => {
      delete record.jobClass;
      fs.writeFileSync(
        path.join(jobsDirectory, `${record.id}.json`),
        `${JSON.stringify(record)}\n`,
        { mode: 0o600 }
      );
    };

    seedLegacy(job(taskId, {
      schemaVersion: 1,
      status: "completed",
      request: { providerHomeId: lineage },
      result: { taskRuntimeCleaned: false }
    }));
    seedLegacy(job(reviewId, {
      schemaVersion: 2,
      kind: "review",
      status: "failed",
      result: {
        providerSessionDeleted: false,
        privacyWarning: "Legacy review home retained"
      }
    }));

    assert.equal(readJob(root, taskId).jobClass, "task");
    assert.equal(tryReadJob(root, reviewId).jobClass, "review");
    assert.deepEqual(
      Object.fromEntries(listJobs(root).map((record) => [record.id, record.jobClass])),
      { [taskId]: "task", [reviewId]: "review" }
    );
    assert.deepEqual(
      Object.fromEntries(listJobsReadonly(root).map((record) => [record.id, record.jobClass])),
      { [taskId]: "task", [reviewId]: "review" }
    );
    assert.equal(
      Object.hasOwn(JSON.parse(fs.readFileSync(path.join(jobsDirectory, `${taskId}.json`), "utf8")), "jobClass"),
      false,
      "read normalization must not rewrite an authoritative record outside its lock"
    );

    const legacyWrite = job(writtenId, { createdAt: "2026-01-02T00:00:00.000Z" });
    delete legacyWrite.jobClass;
    const written = writeJob(root, legacyWrite);
    assert.equal(written.jobClass, "task");
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(jobsDirectory, `${writtenId}.json`), "utf8")).jobClass,
      "task"
    );

    retain(root, 0);
    const retainedIds = new Set(listJobs(root).map((record) => record.id));
    assert.equal(retainedIds.has(taskId), true, "legacy cleanup-pending task must not be pruned");
    assert.equal(retainedIds.has(reviewId), true, "legacy cleanup-pending review must not be pruned");
    assert.equal(retainedIds.has(writtenId), false, "ordinary terminal record remains eligible for pruning");

    const blockedId = generateId("task");
    assert.throws(
      () => admitJob(root, job(blockedId, {
        status: "queued",
        write: false,
        request: { providerHomeId: lineage }
      })),
      (error) => error?.code === "E_JOB_ACTIVE"
        && error.details?.conflictingJobId === taskId
        && error.details?.conflictingProviderHomeId === lineage
    );

    const updated = updateJob(root, taskId, (current) => ({
      ...current,
      result: { ...current.result, taskRuntimeCleaned: true }
    }));
    assert.equal(updated.jobClass, "task");
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(jobsDirectory, `${taskId}.json`), "utf8")).jobClass,
      "task"
    );

    const admittedId = generateId("task");
    const legacyAdmission = job(admittedId, {
      status: "queued",
      write: false,
      request: { providerHomeId: lineage }
    });
    delete legacyAdmission.jobClass;
    const admitted = admitJob(root, legacyAdmission);
    assert.equal(admitted.jobClass, "task");
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(jobsDirectory, `${admittedId}.json`), "utf8")).jobClass,
      "task"
    );
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("authoritative writes validate core state and preserve conservative schema-v1 admission", () => {
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: tempDir("grok-state-data-") };
  const root = initRepo();
  const legacyId = generateId("task");
  const legacy = job(legacyId, { status: "running" });
  delete legacy.write;
  delete legacy.jobClass;
  assert.doesNotThrow(() => admitJob(root, legacy, env));
  assert.throws(
    () => admitJob(root, job(generateId("task"), { status: "queued", write: false }), env),
    (error) => error?.code === "E_JOB_ACTIVE"
      && error.details?.conflictingJobId === legacyId
      && error.details?.conflictingWrite === true
  );
  updateJob(root, legacyId, (current) => ({ ...current, status: "completed" }), env);
  assert.doesNotThrow(() => admitJob(
    root,
    job(generateId("task"), { status: "queued", write: false }),
    env
  ));

  const badWriteId = generateId("task");
  assert.throws(
    () => writeJob(root, job(badWriteId, { write: "false" }), env),
    (error) => isGenericAuthoritativeStateError(error, [badWriteId])
  );
  assert.equal(tryReadJob(root, badWriteId, env), null);

  const schema3Id = generateId("task");
  const schema3 = job(schema3Id, { schemaVersion: 3, jobClass: "task" });
  delete schema3.write;
  assert.throws(
    () => writeJob(root, schema3, env),
    (error) => isGenericAuthoritativeStateError(error, [schema3Id])
  );
  assert.equal(tryReadJob(root, schema3Id, env), null);

  const stableId = generateId("task");
  writeJob(root, job(stableId), env);
  assert.throws(
    () => updateJob(root, stableId, (current) => ({ ...current, status: "UPDATE_STATUS_CANARY" }), env),
    (error) => isGenericAuthoritativeStateError(error, [stableId, "UPDATE_STATUS_CANARY"])
  );
  assert.equal(readJob(root, stableId, env).status, "completed");
  const mismatchedId = generateId("task");
  assert.throws(
    () => updateJob(root, stableId, (current) => ({ ...current, id: mismatchedId }), env),
    (error) => isGenericAuthoritativeStateError(error, [stableId, mismatchedId])
  );
  assert.equal(readJob(root, stableId, env).id, stableId);

  for (const overrides of [
    { jobClass: "FUTURE_CLASS_CANARY" },
    { jobClass: "review" },
    { kind: "review", jobClass: "review" },
    { kind: "FUTURE_KIND_CANARY", jobClass: "task" }
  ]) {
    const invalidId = generateId("task");
    assert.throws(
      () => writeJob(root, job(invalidId, { write: false, ...overrides }), env),
      (error) => isGenericAuthoritativeStateError(error, [invalidId, "CANARY"])
    );
    assert.equal(tryReadJob(root, invalidId, env), null);
  }

  const classifiedId = generateId("task");
  writeJob(root, job(classifiedId, { jobClass: "task", write: false }), env);
  for (const mutation of [
    { jobClass: "FUTURE_CLASS_CANARY" },
    { jobClass: "review" },
    { kind: "review", jobClass: "review" }
  ]) {
    assert.throws(
      () => updateJob(root, classifiedId, (current) => ({ ...current, ...mutation }), env),
      (error) => isGenericAuthoritativeStateError(error, [classifiedId, "CANARY"])
    );
    const unchanged = readJob(root, classifiedId, env);
    assert.equal(unchanged.kind, "task");
    assert.equal(unchanged.jobClass, "task");
  }
});

test("workspace admission gives write jobs an exclusive lease", () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tempDir("grok-state-data-");
  try {
    const root = initRepo();
    const writer = job(generateId("task"), { status: "running", write: true });
    admitJob(root, writer);
    assert.throws(
      () => admitJob(root, job(generateId("task"), { status: "queued", write: false })),
      (error) => error?.code === "E_JOB_ACTIVE" && error.details?.conflictingJobId === writer.id
    );
    assert.throws(
      () => admitJob(root, job(generateId("task"), { status: "queued", write: true })),
      (error) => error?.code === "E_JOB_ACTIVE"
    );
    updateJob(root, writer.id, (current) => ({ ...current, status: "completed" }));
    assert.doesNotThrow(() => admitJob(root, job(generateId("task"), { status: "queued", write: false })));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("workspace admission serializes continuations that share one provider lineage", () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tempDir("grok-state-data-");
  try {
    const root = initRepo();
    const first = job(generateId("task"), {
      jobClass: "task",
      status: "running",
      write: false,
      request: { providerHomeId: "shared-lineage" }
    });
    admitJob(root, first);
    assert.throws(
      () => admitJob(root, job(generateId("task"), {
        jobClass: "task",
        status: "queued",
        write: false,
        request: { providerHomeId: "shared-lineage" }
      })),
      (error) => error?.code === "E_JOB_ACTIVE"
        && error.details?.conflictingJobId === first.id
        && error.details?.conflictingProviderHomeId === "shared-lineage"
    );
    assert.doesNotThrow(() => admitJob(root, job(generateId("task"), {
      jobClass: "task",
      status: "queued",
      write: false,
      request: { providerHomeId: "independent-lineage" }
    })));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("workspace admission blocks a lineage until terminal task cleanup is complete", () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tempDir("grok-state-data-");
  try {
    const root = initRepo();
    const pending = job(generateId("task"), {
      jobClass: "task",
      status: "completed",
      request: { providerHomeId: "cleanup-pending-lineage" },
      result: { taskRuntimeCleaned: false }
    });
    writeJob(root, pending);
    assert.throws(
      () => admitJob(root, job(generateId("task"), {
        jobClass: "task",
        status: "queued",
        request: { providerHomeId: "cleanup-pending-lineage" }
      })),
      (error) => error?.code === "E_JOB_ACTIVE"
        && error.details?.conflictingJobId === pending.id
        && error.details?.conflictingProviderHomeId === "cleanup-pending-lineage"
    );
    updateJob(root, pending.id, (current) => ({
      ...current,
      result: { ...current.result, taskRuntimeCleaned: true }
    }));
    assert.doesNotThrow(() => admitJob(root, job(generateId("task"), {
      jobClass: "task",
      status: "queued",
      request: { providerHomeId: "cleanup-pending-lineage" }
    })));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("job selection scopes implicit choices by Claude session and status", () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tempDir("grok-state-data-");
  try {
    const root = initRepo();
    const ids = [generateId("task"), generateId("task"), generateId("task")];
    writeJob(root, job(ids[0], { createdAt: "2026-01-03T00:00:00.000Z", status: "running", claudeSessionId: "session-a" }));
    writeJob(root, job(ids[1], { createdAt: "2026-01-02T00:00:00.000Z", status: "completed", claudeSessionId: "session-a" }));
    writeJob(root, job(ids[2], { createdAt: "2026-01-04T00:00:00.000Z", status: "completed", claudeSessionId: "session-b" }));

    assert.equal(selectJob(root, { claudeSessionId: "session-a", active: true }).id, ids[0]);
    assert.equal(selectJob(root, { claudeSessionId: "session-a", finished: true }).id, ids[1]);
    assert.equal(selectJob(root, { id: ids[2], claudeSessionId: "session-a" }).id, ids[2]);
    assert.equal(listJobs(root)[0].id, ids[2]);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("cancellation markers are private and retention keeps active plus newest terminal jobs", () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tempDir("grok-state-data-");
  try {
    const root = initRepo();
    const activeId = generateId("task");
    writeJob(root, job(activeId, { status: "running", createdAt: "2026-01-05T00:00:00.000Z" }));
    assert.throws(
      () => requestCancel(root, activeId),
      (error) => error.code === "E_PROCESS_IDENTITY" && /nonce/i.test(error.message)
    );
    assert.equal(fs.existsSync(cancelFile(root, activeId)), false);

    requestCancel(root, activeId, "nonce-value");
    assert.equal(isCancelRequested(root, activeId, "nonce-value"), true);
    assert.equal(isCancelRequested(root, activeId, "wrong-nonce"), false);
    assert.equal(isCancelRequested(root, activeId, ""), false);
    assert.equal(isCancelRequested(root, activeId), false);
    assert.equal(fs.readFileSync(cancelFile(root, activeId), "utf8"), "nonce-value\n");
    assert.equal(fs.statSync(cancelFile(root, activeId)).mode & 0o777, 0o600);

    requestCancel(root, activeId, "replacement-nonce");
    assert.equal(isCancelRequested(root, activeId, "nonce-value"), false);
    assert.equal(isCancelRequested(root, activeId, "replacement-nonce"), true);
    assert.equal(fs.readFileSync(cancelFile(root, activeId), "utf8"), "replacement-nonce\n");
    assert.equal(fs.statSync(cancelFile(root, activeId)).mode & 0o777, 0o600);
    assert.deepEqual(
      fs.readdirSync(path.dirname(cancelFile(root, activeId))).filter((name) => name.startsWith(`${activeId}.cancel.`)),
      [],
      "atomic cancellation publication left a temporary marker"
    );

    const terminalIds = [];
    for (let index = 0; index < 4; index += 1) {
      const id = generateId("task");
      terminalIds.push(id);
      writeJob(root, job(id, { createdAt: `2026-01-0${4 - index}T00:00:00.000Z` }));
    }
    retain(root, 3);
    const retained = listJobs(root);
    assert.equal(retained.length, 3);
    assert.ok(retained.some((item) => item.id === activeId));
    assert.deepEqual(
      retained.filter((item) => item.status === "completed").map((item) => item.id),
      terminalIds.slice(0, 2)
    );
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("retain never prunes unclean review or task jobs while empty-target skips stay eligible", () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tempDir("grok-state-data-");
  try {
    const root = initRepo();
    const uncleanId = generateId("review");
    const uncleanTaskId = generateId("task");
    const emptyTargetId = generateId("review");
    const normalId = generateId("task");

    // Unclean review: providerSessionDeleted false and not empty-target → permanent retention.
    writeJob(root, job(uncleanId, {
      kind: "review",
      jobClass: "review",
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      result: {
        review: { verdict: "pass", summary: "fixture", findings: [] },
        providerSessionDeleted: false,
        privacyWarning: "Isolated review home retained"
      }
    }));
    writeJob(root, job(uncleanTaskId, {
      jobClass: "task",
      status: "failed",
      createdAt: "2026-01-01T12:00:00.000Z",
      result: {
        taskRuntimeCleaned: false,
        privacyWarning: "Task runtime artifacts retained"
      }
    }));
    // Empty-target skip uses the same providerSessionDeleted flag but remains eligible for prune.
    writeJob(root, job(emptyTargetId, {
      kind: "review",
      jobClass: "review",
      status: "completed",
      createdAt: "2026-01-02T00:00:00.000Z",
      result: {
        review: { verdict: "pass", summary: "No changes in the selected review target.", findings: [] },
        providerSessionDeleted: false,
        skipped: true,
        skipReason: "empty-target"
      }
    }));
    writeJob(root, job(normalId, {
      status: "completed",
      createdAt: "2026-01-03T00:00:00.000Z"
    }));

    // Keep one terminal slot: newest eligible terminal job survives; unclean is never eligible.
    retain(root, 1);
    const retained = listJobs(root);
    const retainedIds = new Set(retained.map((item) => item.id));
    assert.equal(retainedIds.has(uncleanId), true, "unclean review with providerSessionDeleted false must never be pruned");
    assert.equal(retainedIds.has(uncleanTaskId), true, "unclean task with taskRuntimeCleaned false must never be pruned");
    assert.equal(retainedIds.has(normalId), true, "newest normal terminal job fills the retention limit");
    assert.equal(retainedIds.has(emptyTargetId), false, "empty-target skip remains eligible for normal terminal pruning");
    assert.equal(retained.length, 3);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});
