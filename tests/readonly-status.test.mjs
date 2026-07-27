import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CompanionError,
  EXIT,
  exitCodeFor,
  storageReadonlyError
} from "../plugins/grok/scripts/lib/errors.mjs";
import {
  listStatusReadonly,
  readJobStatusReadonly,
  writeJob,
  admitJob,
  readJob,
  setConfig,
  withWorkspaceAdmission,
  now,
  listJobs
} from "../plugins/grok/scripts/lib/state.mjs";
import {
  resolveWorkspaceStateReadonly,
  workspaceState,
  workspaceStateSegment
} from "../plugins/grok/scripts/lib/workspace.mjs";
import { git as runGit, initRepo, runCompanion, tempDir } from "./helpers.mjs";

function envFor(pluginData = tempDir("grok-readonly-status-")) {
  return {
    ...process.env,
    HOME: path.dirname(pluginData),
    GROK_COMPANION_HOST: "codex",
    GROK_COMPANION_HOST_SESSION_ID: "019f666a-6469-7cc1-9a8d-8c1adf61e103",
    GROK_COMPANION_PLUGIN_DATA: pluginData,
    CLAUDE_PLUGIN_DATA: pluginData
  };
}

function makeJob(id, summary, {
  status = "completed",
  sessionId = "019f666a-6469-7cc1-9a8d-8c1adf61e103"
} = {}) {
  return {
    schemaVersion: 3,
    id,
    kind: "task",
    jobClass: "task",
    write: false,
    status,
    phase: status,
    summary,
    createdAt: now(),
    updatedAt: now(),
    host: { kind: "codex", sessionId },
    lifecycleEvents: [],
    request: null,
    result: null,
    error: null
  };
}

function writeLegacyJob(env, canonicalRoot, job) {
  const stateParent = path.join(fs.realpathSync(env.GROK_COMPANION_PLUGIN_DATA), "state");
  const legacy = path.join(stateParent, workspaceStateSegment(canonicalRoot));
  const jobs = path.join(legacy, "jobs");
  fs.mkdirSync(jobs, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateParent, 0o700);
  fs.chmodSync(legacy, 0o700);
  fs.chmodSync(jobs, 0o700);
  fs.writeFileSync(
    path.join(jobs, `${job.id}.json`),
    `${JSON.stringify(job)}\n`,
    { mode: 0o600 }
  );
  return { stateParent, legacy, jobs };
}

function captureTreeFingerprint(root) {
  const records = [];
  function walk(directory, relative = "") {
    const stat = fs.lstatSync(directory);
    records.push({
      path: relative || ".",
      mode: stat.mode,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      isDir: stat.isDirectory(),
      isSymlink: stat.isSymbolicLink()
    });
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    for (const name of fs.readdirSync(directory).sort()) {
      walk(path.join(directory, name), relative ? `${relative}/${name}` : name);
    }
  }
  if (fs.existsSync(root)) walk(root);
  return records;
}

function installMutationGuards() {
  const mutations = [];
  const targets = [
    "writeFileSync",
    "appendFileSync",
    "mkdirSync",
    "chmodSync",
    "fchmodSync",
    "renameSync",
    "linkSync",
    "unlinkSync",
    "rmSync",
    "rmdirSync",
    "utimesSync",
    "futimesSync",
    "truncateSync",
    "copyFileSync"
  ];
  const originals = {};
  for (const name of targets) {
    if (typeof fs[name] !== "function") continue;
    originals[name] = fs[name];
    fs[name] = (...args) => {
      mutations.push({ name, args: args.map((value) => String(value)).slice(0, 3) });
      return originals[name](...args);
    };
  }
  // openSync with write flags counts as mutation intent
  originals.openSync = fs.openSync;
  fs.openSync = (file, flags, ...rest) => {
    const flagText = String(flags);
    if (flagText.includes("w") || flagText.includes("a") || flagText === "wx" || flags === "wx"
      || (typeof flags === "number" && (flags & fs.constants.O_WRONLY || flags & fs.constants.O_RDWR || flags & fs.constants.O_CREAT || flags & fs.constants.O_TRUNC))) {
      mutations.push({ name: "openSync", args: [String(file), flagText] });
    }
    return originals.openSync(file, flags, ...rest);
  };
  return {
    mutations,
    restore() {
      for (const [name, fn] of Object.entries(originals)) fs[name] = fn;
    }
  };
}

test("E_STORAGE_READONLY is a prerequisite exit and omits private paths", () => {
  const err = storageReadonlyError({ code: "EPERM" });
  assert.equal(err.code, "E_STORAGE_READONLY");
  assert.equal(exitCodeFor(err), EXIT.PREREQ);
  assert.equal(err.details?.capability, "EPERM");
  assert.equal(JSON.stringify(err).includes("/"), false);
  assert.match(err.message, /not writable/i);
});

test("status --all --readonly --json observes control jobs without mutating the store", () => {
  const root = initRepo();
  const env = envFor();
  const controlId = "task-aaaaaaaaaaaaaaaa";
  writeJob(root, makeJob(controlId, "control-visible"), env);
  const stateDir = workspaceState(root, env);
  const pluginData = env.GROK_COMPANION_PLUGIN_DATA;
  const before = captureTreeFingerprint(pluginData);

  const guards = installMutationGuards();
  let listed;
  try {
    listed = listStatusReadonly(root, env);
  } finally {
    guards.restore();
  }
  assert.equal(listed.migrationRequired, false);
  assert.equal(listed.jobs.some((job) => job.id === controlId), true);
  assert.deepEqual(guards.mutations, [], `unexpected mutations: ${JSON.stringify(guards.mutations)}`);
  assert.deepEqual(captureTreeFingerprint(pluginData), before);

  const result = runCompanion(
    ["status", "--all", "--readonly", "--json"],
    { cwd: root, env }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(Array.isArray(payload.jobs), true);
  assert.equal(typeof payload.migrationRequired, "boolean");
  assert.equal(payload.migrationRequired, false);
  assert.equal(payload.jobs.some((job) => job.id === controlId), true);
  assert.deepEqual(captureTreeFingerprint(pluginData), before);
  assert.equal(fs.existsSync(path.join(stateDir, "jobs", `${controlId}.json`)), true);
});

test("readonly status reports migrationRequired for pending valid legacy without migrating", () => {
  const root = initRepo();
  const env = envFor();
  const controlId = "task-bbbbbbbbbbbbbbbb";
  writeJob(root, makeJob(controlId, "already-in-control"), env);
  const controlState = workspaceState(root, env);
  const stateParent = path.join(env.GROK_COMPANION_PLUGIN_DATA, "state");
  const legacy = path.join(stateParent, workspaceStateSegment(fs.realpathSync(root)));
  const legacyJobs = path.join(legacy, "jobs");
  fs.mkdirSync(legacyJobs, { recursive: true, mode: 0o700 });
  fs.chmodSync(legacy, 0o700);
  fs.chmodSync(legacyJobs, 0o700);
  const legacyId = "task-cccccccccccccccc";
  const legacyContents = `${JSON.stringify(makeJob(legacyId, "pending-legacy"))}\n`;
  fs.writeFileSync(path.join(legacyJobs, `${legacyId}.json`), legacyContents, { mode: 0o600 });

  const pluginData = env.GROK_COMPANION_PLUGIN_DATA;
  const before = captureTreeFingerprint(pluginData);
  const guards = installMutationGuards();
  let listed;
  try {
    listed = listStatusReadonly(root, env);
  } finally {
    guards.restore();
  }

  assert.equal(listed.migrationRequired, true);
  assert.equal(listed.jobs.map((job) => job.id).includes(controlId), true);
  assert.equal(listed.jobs.map((job) => job.id).includes(legacyId), false,
    "pure preflight must not virtual-union legacy into control jobs");
  assert.equal(fs.existsSync(path.join(controlState, "jobs", `${legacyId}.json`)), false);
  assert.equal(
    fs.readdirSync(controlState).some((name) => name.startsWith(".legacy-migration-v3-")),
    false,
    "readonly must not publish migration markers"
  );
  assert.deepEqual(guards.mutations, [], `unexpected mutations: ${JSON.stringify(guards.mutations)}`);
  assert.deepEqual(captureTreeFingerprint(pluginData), before);

  const result = runCompanion(
    ["status", "--all", "--readonly", "--json"],
    { cwd: root, env }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.migrationRequired, true);
  assert.equal(payload.jobs.map((job) => job.id).includes(controlId), true);
  assert.equal(payload.jobs.map((job) => job.id).includes(legacyId), false);
  assert.deepEqual(captureTreeFingerprint(pluginData), before);

  const human = runCompanion(
    ["status", "--all", "--readonly"],
    { cwd: root, env }
  );
  assert.equal(human.status, 0, human.stderr || human.stdout);
  assert.match(human.stdout, /migrationRequired: true/);
  assert.deepEqual(captureTreeFingerprint(pluginData), before);

  // Default mutating path still migrates.
  assert.equal(listJobs(root, env).some((job) => job.id === legacyId), true);
  assert.equal(fs.existsSync(path.join(controlState, "jobs", `${legacyId}.json`)), true);
});
test("readonly status fail-closed rejects malformed authoritative jobs with E_STATE", () => {
  const root = initRepo();
  const env = envFor();
  const id = "task-dddddddddddddddd";
  writeJob(root, makeJob(id, "ok"), env);
  const file = path.join(workspaceState(root, env), "jobs", `${id}.json`);
  fs.writeFileSync(file, "{\"raw\":\"MALFORMED_JSON_CANARY\"", { mode: 0o600 });

  assert.throws(
    () => listStatusReadonly(root, env),
    (error) => error?.code === "E_STATE"
      && error.message === "Authoritative job state is malformed or unsafe."
      && !error.message.includes(file)
      && !error.message.includes("CANARY")
  );

  const result = runCompanion(
    ["status", "--all", "--readonly", "--json"],
    { cwd: root, env }
  );
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "E_STATE");
  assert.equal(payload.error.message.includes(file), false);
});

test("readonly status fail-closed rejects job directory symlinks", () => {
  const root = initRepo();
  const env = envFor();
  const id = "task-eeeeeeeeeeeeeeee";
  writeJob(root, makeJob(id, "ok"), env);
  const state = workspaceState(root, env);
  const jobs = path.join(state, "jobs");
  const decoy = path.join(state, "jobs-decoy");
  fs.renameSync(jobs, decoy);
  fs.symlinkSync(decoy, jobs);

  assert.throws(
    () => listStatusReadonly(root, env),
    (error) => error?.code === "E_STATE"
      && error.message === "Authoritative job state is malformed or unsafe."
  );
});

test("readonly status fail-closed rejects privacy-unsafe group-readable state", () => {
  const root = initRepo();
  const env = envFor();
  const id = "task-ffffffffffffffff";
  writeJob(root, makeJob(id, "ok"), env);
  const state = workspaceState(root, env);
  fs.chmodSync(state, 0o750);

  assert.throws(
    () => resolveWorkspaceStateReadonly(root, env),
    (error) => error?.code === "E_STATE"
      && error.message === "Authoritative job state is malformed or unsafe."
  );

  // Restore privacy for cleanup safety.
  fs.chmodSync(state, 0o700);
});

test("readonly status rejects --wait and --timeout-ms combinations", () => {
  const root = initRepo();
  const env = envFor();
  writeJob(root, makeJob("task-1111111111111111", "ok"), env);

  for (const args of [
    ["status", "--readonly", "--wait", "--json"],
    ["status", "task-1111111111111111", "--readonly", "--wait", "--json"],
    ["status", "--all", "--readonly", "--timeout-ms", "1000", "--json"]
  ]) {
    const result = runCompanion(args, { cwd: root, env });
    assert.notEqual(result.status, 0, args.join(" "));
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "E_USAGE", args.join(" "));
  }
});

test("readonly CLI keeps empty, session-filtered, and explicit-job JSON shapes", () => {
  const root = initRepo();
  const absentData = path.join(tempDir("grok-readonly-absent-parent-"), "missing-plugin-data");
  const absentEnv = envFor(absentData);
  assert.equal(fs.existsSync(absentData), false);
  const empty = runCompanion(
    ["status", "--all", "--readonly", "--json"],
    { cwd: root, env: absentEnv }
  );
  assert.equal(empty.status, 0, empty.stderr || empty.stdout);
  assert.deepEqual(JSON.parse(empty.stdout), { jobs: [], migrationRequired: false });
  assert.equal(fs.existsSync(absentData), false, "pure status must not create absent plugin data");

  const env = envFor();
  const ownId = "task-bcbcbcbcbcbcbcbc";
  const otherId = "task-bdbdbdbdbdbdbdbd";
  writeJob(root, makeJob(ownId, "own-session"), env);
  writeJob(root, makeJob(otherId, "other-session", {
    sessionId: "019f666a-6469-7cc1-9a8d-8c1adf61ffff"
  }), env);

  const session = runCompanion(["status", "--readonly", "--json"], { cwd: root, env });
  assert.equal(session.status, 0, session.stderr || session.stdout);
  const sessionPayload = JSON.parse(session.stdout);
  assert.equal(Array.isArray(sessionPayload), true);
  assert.deepEqual(sessionPayload.map((job) => job.id), [ownId]);

  const explicit = runCompanion(
    ["status", ownId, "--readonly", "--json"],
    { cwd: root, env }
  );
  assert.equal(explicit.status, 0, explicit.stderr || explicit.stdout);
  const explicitPayload = JSON.parse(explicit.stdout);
  assert.equal(Array.isArray(explicitPayload), false);
  assert.equal(explicitPayload.id, ownId);
});

function isSanitizedStorageReadonly(error, code, forbiddenSubstrings = []) {
  if (!(error instanceof CompanionError)) return false;
  if (error.code !== "E_STORAGE_READONLY") return false;
  if (error.details?.capability !== code) return false;
  if (exitCodeFor(error) !== EXIT.PREREQ) return false;
  const serialized = JSON.stringify({
    code: error.code,
    message: error.message,
    details: error.details
  });
  return !error.message.includes("/")
    && forbiddenSubstrings.every((value) => !serialized.includes(String(value)));
}

test("authoritative list/read preserve E_STORAGE_READONLY from ensure instead of masking as E_STATE", () => {
  const root = initRepo();
  const env = envFor();
  const state = workspaceState(root, env);
  // Force ensure()/safeDirectory to attempt a chmod repair.
  fs.chmodSync(state, 0o755);

  for (const code of ["EPERM", "EACCES", "EROFS"]) {
    const original = fs.chmodSync;
    fs.chmodSync = () => {
      const error = new Error("simulated storage failure");
      error.code = code;
      throw error;
    };
    try {
      for (const operation of [
        () => listJobs(root, env),
        () => readJob(root, "task-8888888888888888", env)
      ]) {
        assert.throws(
          operation,
          (error) => isSanitizedStorageReadonly(error, code, [state, env.GROK_COMPANION_PLUGIN_DATA])
            && error.code !== "E_STATE",
          code
        );
      }
    } finally {
      fs.chmodSync = original;
    }
  }

  fs.chmodSync(state, 0o700);
});

test("admission durable lock and atomic write map EPERM/EACCES/EROFS to E_STORAGE_READONLY", () => {
  const root = initRepo();
  const env = envFor();
  // Prime private state so admission reaches lock/write rather than first-time mkdir.
  workspaceState(root, env);
  const job = makeJob("task-6666666666666666", "admission-write");

  for (const code of ["EPERM", "EACCES", "EROFS"]) {
    const originalOpen = fs.openSync;
    let injected = false;
    fs.openSync = (file, flags, ...rest) => {
      const flagText = String(flags);
      const target = String(file);
      // Reach the admitted job's atomic file publication after lock ownership
      // has already been durably established.
      if (!injected
        && target.includes(`${path.sep}jobs${path.sep}${job.id}.json.`)
        && (flagText === "wx" || flagText.includes("wx"))) {
        injected = true;
        const error = new Error("simulated durable write failure");
        error.code = code;
        throw error;
      }
      return originalOpen(file, flags, ...rest);
    };
    try {
      assert.throws(
        () => admitJob(root, job, env),
        (error) => isSanitizedStorageReadonly(error, code, [env.GROK_COMPANION_PLUGIN_DATA])
          && error.code !== "E_STATE"
          && error.code !== "E_PROVIDER_EXIT",
        `admitJob open wx ${code}`
      );
      assert.equal(injected, true, `atomic job write inject path not hit for ${code}`);
    } finally {
      fs.openSync = originalOpen;
    }
  }

  for (const code of ["EPERM", "EACCES", "EROFS"]) {
    const originalMkdir = fs.mkdirSync;
    let injected = false;
    fs.mkdirSync = (target, options) => {
      if (!injected && String(target).includes(`${path.sep}locks${path.sep}`) && String(target).endsWith(".lock")) {
        injected = true;
        const error = new Error("simulated lock mkdir failure");
        error.code = code;
        throw error;
      }
      return originalMkdir(target, options);
    };
    try {
      assert.throws(
        () => admitJob(root, { ...job, id: "task-7777777777777777" }, env),
        (error) => isSanitizedStorageReadonly(error, code, [env.GROK_COMPANION_PLUGIN_DATA])
          && error.code !== "E_STATE",
        `admitJob lock mkdir ${code}`
      );
      assert.equal(injected, true, `lock inject path not hit for ${code}`);
    } finally {
      fs.mkdirSync = originalMkdir;
    }
  }
});

test("lock owner temporary cleanup maps EPERM/EACCES/EROFS to E_STORAGE_READONLY", () => {
  for (const code of ["EPERM", "EACCES", "EROFS"]) {
    const root = initRepo();
    const env = envFor();
    const originalUnlink = fs.unlinkSync;
    let injected = false;
    fs.unlinkSync = (target, ...rest) => {
      if (!injected
        && String(target).includes(`${path.sep}locks${path.sep}config.lock${path.sep}owner.json.`)
        && String(target).endsWith(".tmp")) {
        injected = true;
        const error = new Error("owner temporary cleanup canary");
        error.code = code;
        throw error;
      }
      return originalUnlink(target, ...rest);
    };
    try {
      assert.throws(
        () => setConfig(root, { ownerCleanup: code }, env),
        (error) => isSanitizedStorageReadonly(
          error,
          code,
          [env.GROK_COMPANION_PLUGIN_DATA, "canary"]
        ),
        `lock owner temporary cleanup ${code}`
      );
      assert.equal(injected, true, `owner temporary cleanup not hit for ${code}`);
    } finally {
      fs.unlinkSync = originalUnlink;
    }
  }
});

test("lock inspection during release maps EPERM/EACCES/EROFS to E_STORAGE_READONLY", () => {
  for (const code of ["EPERM", "EACCES", "EROFS"]) {
    const root = initRepo();
    const env = envFor();
    const originalLstat = fs.lstatSync;
    let releasePhase = false;
    let injected = false;
    fs.lstatSync = (target, ...rest) => {
      if (releasePhase && !injected && String(target).endsWith(".lock")) {
        injected = true;
        const error = new Error("release lock inspection canary");
        error.code = code;
        throw error;
      }
      return originalLstat(target, ...rest);
    };
    try {
      assert.throws(
        () => withWorkspaceAdmission(root, () => {
          releasePhase = true;
          return "completed";
        }, env),
        (error) => isSanitizedStorageReadonly(
          error,
          code,
          [env.GROK_COMPANION_PLUGIN_DATA, "canary"]
        ),
        `release lock inspection ${code}`
      );
      assert.equal(injected, true, `release lock inspection not hit for ${code}`);
    } finally {
      fs.lstatSync = originalLstat;
    }
  }
});

test("existing unsafe lock owner state is reported as sanitized E_STATE", () => {
  const root = initRepo();
  const env = envFor();
  const state = workspaceState(root, env);
  const lock = path.join(state, "locks", "config.lock");
  const outside = path.join(tempDir("grok-readonly-lock-owner-"), "owner.json");
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  fs.mkdirSync(lock, { mode: 0o700 });
  fs.writeFileSync(outside, "{}\n", { mode: 0o600 });
  fs.symlinkSync(outside, path.join(lock, "owner.json"));

  assert.throws(
    () => setConfig(root, { unsafeOwner: true }, env),
    (error) => error?.code === "E_STATE"
      && error.message === "Authoritative job state is malformed or unsafe."
      && !error.message.includes(state)
      && !error.message.includes(outside)
      && !error.message.includes(env.GROK_COMPANION_PLUGIN_DATA)
  );
});

test("owned lock-transition cleanup maps EPERM/EACCES/EROFS to E_STORAGE_READONLY", () => {
  for (const code of ["EPERM", "EACCES", "EROFS"]) {
    const root = initRepo();
    const env = envFor();
    workspaceState(root, env);
    const originalRename = fs.renameSync;
    const originalUnlink = fs.unlinkSync;
    let blockedRetire = false;
    let blockedCleanup = false;
    fs.renameSync = (from, to) => {
      if (!blockedRetire
        && String(from).endsWith(`${path.sep}config.lock`)
        && String(to).includes(`${path.sep}config.lock.release-`)) {
        blockedRetire = true;
        const error = new Error("simulated transition retire race");
        error.code = "EEXIST";
        throw error;
      }
      return originalRename(from, to);
    };
    fs.unlinkSync = (target, ...rest) => {
      if (!blockedCleanup
        && String(target).endsWith(`${path.sep}config.lock${path.sep}transition.json`)) {
        blockedCleanup = true;
        const error = new Error("transition cleanup canary");
        error.code = code;
        throw error;
      }
      return originalUnlink(target, ...rest);
    };
    try {
      assert.throws(
        () => setConfig(root, { transitionCleanup: code }, env),
        (error) => isSanitizedStorageReadonly(
          error,
          code,
          [env.GROK_COMPANION_PLUGIN_DATA, "canary"]
        ),
        `owned transition cleanup ${code}`
      );
      assert.equal(blockedRetire, true, `release retire path not hit for ${code}`);
      assert.equal(blockedCleanup, true, `owned transition cleanup not hit for ${code}`);
    } finally {
      fs.renameSync = originalRename;
      fs.unlinkSync = originalUnlink;
    }
  }
});

test("owned transition inspection maps EPERM/EACCES/EROFS to E_STORAGE_READONLY", () => {
  for (const code of ["EPERM", "EACCES", "EROFS"]) {
    const root = initRepo();
    const env = envFor();
    workspaceState(root, env);
    const originalRename = fs.renameSync;
    const originalOpen = fs.openSync;
    let blockedRetire = false;
    let blockedInspection = false;
    fs.renameSync = (from, to) => {
      if (!blockedRetire
        && String(from).endsWith(`${path.sep}config.lock`)
        && String(to).includes(`${path.sep}config.lock.release-`)) {
        blockedRetire = true;
        const error = new Error("simulated transition retire race");
        error.code = "EEXIST";
        throw error;
      }
      return originalRename(from, to);
    };
    fs.openSync = (target, flags, ...rest) => {
      if (blockedRetire
        && !blockedInspection
        && String(target).endsWith(`${path.sep}config.lock${path.sep}transition.json`)) {
        blockedInspection = true;
        const error = new Error("transition inspection canary");
        error.code = code;
        throw error;
      }
      return originalOpen(target, flags, ...rest);
    };
    try {
      assert.throws(
        () => setConfig(root, { transitionInspection: code }, env),
        (error) => isSanitizedStorageReadonly(
          error,
          code,
          [env.GROK_COMPANION_PLUGIN_DATA, "canary"]
        ),
        `owned transition inspection ${code}`
      );
      assert.equal(blockedRetire, true, `release retire path not hit for ${code}`);
      assert.equal(blockedInspection, true, `owned transition inspection not hit for ${code}`);
    } finally {
      fs.renameSync = originalRename;
      fs.openSync = originalOpen;
    }
  }
});

test("owned transition cleanup fails closed on malformed transition state", () => {
  const root = initRepo();
  const env = envFor();
  workspaceState(root, env);
  const originalRename = fs.renameSync;
  let blockedRetire = false;
  fs.renameSync = (from, to) => {
    if (!blockedRetire
      && String(from).endsWith(`${path.sep}config.lock`)
      && String(to).includes(`${path.sep}config.lock.release-`)) {
      blockedRetire = true;
      fs.writeFileSync(path.join(String(from), "transition.json"), "{malformed\n", { mode: 0o600 });
      const error = new Error("simulated transition retire race");
      error.code = "EEXIST";
      throw error;
    }
    return originalRename(from, to);
  };
  try {
    assert.throws(
      () => setConfig(root, { malformedTransition: true }, env),
      (error) => error?.code === "E_STATE"
        && error.message === "Could not inspect state-lock transition record."
        && !error.message.includes(env.GROK_COMPANION_PLUGIN_DATA)
    );
    assert.equal(blockedRetire, true, "release retire path not hit");
  } finally {
    fs.renameSync = originalRename;
  }
});

test("primary admission errors survive simultaneous lock-transition cleanup failures", () => {
  const root = initRepo();
  const env = envFor();
  workspaceState(root, env);
  const sentinel = new CompanionError("E_STATE", "primary action sentinel");
  const originalRename = fs.renameSync;
  const originalUnlink = fs.unlinkSync;
  let blockedRetire = false;
  let blockedCleanup = false;
  fs.renameSync = (from, to) => {
    if (!blockedRetire
      && String(from).endsWith(".lock")
      && String(to).includes(".lock.release-")) {
      blockedRetire = true;
      const error = new Error("simulated transition retire race");
      error.code = "EEXIST";
      throw error;
    }
    return originalRename(from, to);
  };
  fs.unlinkSync = (target, ...rest) => {
    if (!blockedCleanup && String(target).endsWith(`${path.sep}transition.json`)) {
      blockedCleanup = true;
      const error = new Error("transition cleanup canary");
      error.code = "EROFS";
      throw error;
    }
    return originalUnlink(target, ...rest);
  };
  try {
    assert.throws(
      () => withWorkspaceAdmission(root, () => {
        throw sentinel;
      }, env),
      (error) => error === sentinel
        && error.code === "E_STATE"
        && error.code !== "E_STORAGE_READONLY"
    );
    assert.equal(blockedRetire, true, "release retire path not hit");
    assert.equal(blockedCleanup, true, "owned transition cleanup not hit");
  } finally {
    fs.renameSync = originalRename;
    fs.unlinkSync = originalUnlink;
  }
});

test("abandoned-transition witness cleanup maps EPERM/EACCES/EROFS to E_STORAGE_READONLY", () => {
  for (const code of ["EPERM", "EACCES", "EROFS"]) {
    const root = initRepo();
    const env = envFor();
    const state = workspaceState(root, env);
    const lock = path.join(state, "locks", "config.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
    fs.mkdirSync(lock, { mode: 0o700 });
    const stat = fs.lstatSync(lock);
    const identity = { dev: String(stat.dev), ino: String(stat.ino) };
    const deadPid = 99_999_999;
    fs.writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify({
      schemaVersion: 2,
      token: "a".repeat(32),
      pid: deadPid,
      startToken: "dead-owner",
      directory: identity
    })}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(lock, "transition.json"), `${JSON.stringify({
      schemaVersion: 1,
      kind: "reclaim",
      token: "b".repeat(32),
      pid: deadPid,
      startToken: "dead-transition",
      target: identity
    })}\n`, { mode: 0o600 });

    const originalUnlink = fs.unlinkSync;
    let blockedCleanup = false;
    fs.unlinkSync = (target, ...rest) => {
      if (!blockedCleanup && path.basename(String(target)).startsWith(".transition-stale-")) {
        blockedCleanup = true;
        const error = new Error("witness cleanup canary");
        error.code = code;
        throw error;
      }
      return originalUnlink(target, ...rest);
    };
    try {
      assert.throws(
        () => setConfig(root, { witnessCleanup: code }, env),
        (error) => isSanitizedStorageReadonly(
          error,
          code,
          [state, env.GROK_COMPANION_PLUGIN_DATA, "canary"]
        ),
        `abandoned transition witness cleanup ${code}`
      );
      assert.equal(blockedCleanup, true, `witness cleanup not hit for ${code}`);
    } finally {
      fs.unlinkSync = originalUnlink;
    }
  }
});

test("primary abandoned-transition errors survive simultaneous witness cleanup failure", () => {
  const root = initRepo();
  const env = envFor();
  const state = workspaceState(root, env);
  const lock = path.join(state, "locks", "config.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  fs.mkdirSync(lock, { mode: 0o700 });
  const stat = fs.lstatSync(lock);
  const identity = { dev: String(stat.dev), ino: String(stat.ino) };
  const deadPid = 99_999_999;
  fs.writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify({
    schemaVersion: 2,
    token: "c".repeat(32),
    pid: deadPid,
    startToken: "dead-owner",
    directory: identity
  })}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(lock, "transition.json"), `${JSON.stringify({
    schemaVersion: 1,
    kind: "reclaim",
    token: "d".repeat(32),
    pid: deadPid,
    startToken: "dead-transition",
    target: identity
  })}\n`, { mode: 0o600 });

  const sentinel = new CompanionError("E_STATE", "primary transition sentinel");
  const originalUnlink = fs.unlinkSync;
  let blockedTransition = false;
  let blockedWitness = false;
  fs.unlinkSync = (target, ...rest) => {
    if (!blockedTransition && String(target).endsWith(`${path.sep}transition.json`)) {
      blockedTransition = true;
      throw sentinel;
    }
    if (!blockedWitness && path.basename(String(target)).startsWith(".transition-stale-")) {
      blockedWitness = true;
      const error = new Error("witness cleanup canary");
      error.code = "EROFS";
      throw error;
    }
    return originalUnlink(target, ...rest);
  };
  try {
    assert.throws(
      () => setConfig(root, { witnessPrimary: true }, env),
      (error) => error === sentinel
        && error.code === "E_STATE"
        && error.code !== "E_STORAGE_READONLY"
    );
    assert.equal(blockedTransition, true, "primary transition unlink not hit");
    assert.equal(blockedWitness, true, "witness cleanup not hit");
  } finally {
    fs.unlinkSync = originalUnlink;
  }
});

test("default authoritative listing still sanitizes non-capability unsafe-state errors", () => {
  const root = initRepo();
  const env = envFor();
  writeJob(root, makeJob("task-9999999999999999", "unsafe-dir"), env);
  const state = workspaceState(root, env);
  const jobs = path.join(state, "jobs");
  const decoy = path.join(state, "jobs-decoy");
  fs.renameSync(jobs, decoy);
  fs.symlinkSync(decoy, jobs);

  assert.throws(
    () => listJobs(root, env),
    (error) => error?.code === "E_STATE"
      && error.message === "Authoritative job state is malformed or unsafe."
      && !error.message.includes(state)
      && !error.message.includes(env.GROK_COMPANION_PLUGIN_DATA)
  );

  assert.throws(
    () => admitJob(
      root,
      makeJob("task-9898989898989898", "unsafe-admission"),
      env
    ),
    (error) => error?.code === "E_STATE"
      && error.message === "Authoritative job state is malformed or unsafe."
      && !error.message.includes(state)
      && !error.message.includes(env.GROK_COMPANION_PLUGIN_DATA)
  );
});

test("readonly discovery treats traversal capability failures as sanitized E_STATE, not absence", () => {
  const root = initRepo();
  const env = envFor();
  writeJob(root, makeJob("task-abababababababab", "traversal"), env);
  const state = workspaceState(root, env);
  const stateParent = path.dirname(state);

  const originalLstat = fs.lstatSync;
  fs.lstatSync = (target, ...rest) => {
    if (String(target) === stateParent) {
      const error = new Error("private traversal canary");
      error.code = "EACCES";
      throw error;
    }
    return originalLstat(target, ...rest);
  };
  try {
    assert.throws(
      () => resolveWorkspaceStateReadonly(root, env),
      (error) => error?.code === "E_STATE"
        && error.message === "Authoritative job state is malformed or unsafe."
        && !error.message.includes(stateParent)
        && !error.message.includes("canary")
    );
  } finally {
    fs.lstatSync = originalLstat;
  }

  const originalRealpath = fs.realpathSync;
  fs.realpathSync = (target, ...rest) => {
    if (String(target) === path.join(state, "jobs")) {
      const error = new Error("jobs traversal canary");
      error.code = "EACCES";
      throw error;
    }
    return originalRealpath(target, ...rest);
  };
  try {
    assert.throws(
      () => listStatusReadonly(root, env),
      (error) => error?.code === "E_STATE"
        && error.message === "Authoritative job state is malformed or unsafe."
        && !error.message.includes(state)
        && !error.message.includes("canary")
    );
  } finally {
    fs.realpathSync = originalRealpath;
  }
});

test("readonly linked-worktree discovery treats traversal capability failures as sanitized E_STATE", () => {
  const root = initRepo();
  const env = envFor();
  writeJob(root, makeJob("task-bcbcbcbcbcbcbcbc", "linked-traversal"), env);
  const parent = tempDir("grok-readonly-linked-parent-");
  const linked = path.join(parent, "linked");
  runGit(root, "worktree", "add", "--detach", linked, "HEAD");
  const canonicalLinked = fs.realpathSync(linked);

  const originalRealpath = fs.realpathSync;
  fs.realpathSync = (target, ...rest) => {
    if (String(target) === canonicalLinked) {
      const error = new Error("linked traversal canary");
      error.code = "EACCES";
      throw error;
    }
    return originalRealpath(target, ...rest);
  };
  try {
    assert.throws(
      () => resolveWorkspaceStateReadonly(root, env),
      (error) => error?.code === "E_STATE"
        && error.message === "Authoritative job state is malformed or unsafe."
        && !error.message.includes(canonicalLinked)
        && !error.message.includes("canary")
    );
  } finally {
    fs.realpathSync = originalRealpath;
    runGit(root, "worktree", "remove", "--force", linked);
  }
});

test("readonly linked-worktree discovery fails closed for a missing registered worktree", () => {
  const root = initRepo();
  const env = envFor();
  writeJob(root, makeJob("task-cdcdcdcdcdcdcdcd", "control"), env);
  const controlState = workspaceState(root, env);
  const stateParent = path.dirname(controlState);
  const parent = tempDir("grok-readonly-missing-linked-parent-");
  const linked = path.join(parent, "linked");
  runGit(root, "worktree", "add", "--detach", linked, "HEAD");
  const canonicalLinked = fs.realpathSync(linked);
  const legacy = path.join(stateParent, workspaceStateSegment(canonicalLinked));
  const legacyJobs = path.join(legacy, "jobs");
  fs.mkdirSync(legacyJobs, { recursive: true, mode: 0o700 });
  fs.chmodSync(legacy, 0o700);
  fs.chmodSync(legacyJobs, 0o700);
  const legacyId = "task-cececececececece";
  fs.writeFileSync(
    path.join(legacyJobs, `${legacyId}.json`),
    `${JSON.stringify(makeJob(legacyId, "missing-linked-legacy"))}\n`,
    { mode: 0o600 }
  );
  fs.rmSync(linked, { recursive: true, force: true });

  try {
    assert.throws(
      () => resolveWorkspaceStateReadonly(root, env),
      (error) => error?.code === "E_STATE"
        && error.message === "Authoritative job state is malformed or unsafe."
        && !error.message.includes(canonicalLinked)
        && !error.message.includes(legacy)
    );
  } finally {
    runGit(root, "worktree", "prune");
  }
});

test("readonly legacy-only discovery includes every registered worktree before control cutover", () => {
  const root = initRepo();
  const env = envFor();
  const parent = tempDir("grok-readonly-legacy-linked-parent-");
  const linked = path.join(parent, "linked");
  runGit(root, "worktree", "add", "--detach", linked, "HEAD");
  const canonicalLinked = fs.realpathSync(linked);
  const linkedId = "task-cfcfcfcfcfcfcfcf";
  const { legacy } = writeLegacyJob(
    env,
    canonicalLinked,
    makeJob(linkedId, "linked-only-before-control")
  );

  try {
    const resolved = resolveWorkspaceStateReadonly(root, env);
    assert.equal(resolved.base, legacy);
    assert.deepEqual(resolved.bases, [legacy]);
    assert.equal(resolved.migrationRequired, true);

    const listed = listStatusReadonly(root, env);
    assert.deepEqual(listed.jobs.map((job) => job.id), [linkedId]);
    assert.equal(listed.migrationRequired, true);
    const selected = readJobStatusReadonly(root, linkedId, env);
    assert.equal(selected.job.summary, "linked-only-before-control");
    assert.equal(selected.migrationRequired, true);
  } finally {
    runGit(root, "worktree", "remove", "--force", linked);
  }
});

test("legacy migration temporary cleanup maps EPERM/EACCES/EROFS to E_STORAGE_READONLY", () => {
  for (const phase of ["entry", "marker"]) {
    for (const code of ["EPERM", "EACCES", "EROFS"]) {
      const root = initRepo();
      const env = envFor();
      const id = phase === "entry"
        ? "task-d0d0d0d0d0d0d0d0"
        : "task-d1d1d1d1d1d1d1d1";
      writeLegacyJob(
        env,
        fs.realpathSync(root),
        makeJob(id, `${phase}-cleanup-${code}`)
      );
      const originalUnlink = fs.unlinkSync;
      let injected = false;
      fs.unlinkSync = (target, ...rest) => {
        const value = String(target);
        const matches = phase === "entry"
          ? value.endsWith(".migrate")
          : path.basename(value).startsWith(".legacy-migration-v3-") && value.endsWith(".tmp");
        if (!injected && matches) {
          injected = true;
          const error = new Error(`${phase} temporary cleanup canary`);
          error.code = code;
          throw error;
        }
        return originalUnlink(target, ...rest);
      };
      try {
        assert.throws(
          () => workspaceState(root, env),
          (error) => isSanitizedStorageReadonly(
            error,
            code,
            [env.GROK_COMPANION_PLUGIN_DATA, "canary"]
          ),
          `${phase} migration temporary cleanup ${code}`
        );
        assert.equal(injected, true, `${phase} temporary cleanup not hit for ${code}`);
      } finally {
        fs.unlinkSync = originalUnlink;
      }
    }
  }
});

test("legacy-only readonly state must be valid and quiescent before migrationRequired", () => {
  const createLegacyOnly = (job) => {
    const root = initRepo();
    const env = envFor();
    const stateParent = path.join(env.GROK_COMPANION_PLUGIN_DATA, "state");
    const legacy = path.join(stateParent, workspaceStateSegment(fs.realpathSync(root)));
    const jobs = path.join(legacy, "jobs");
    fs.mkdirSync(jobs, { recursive: true, mode: 0o700 });
    fs.chmodSync(stateParent, 0o700);
    fs.chmodSync(legacy, 0o700);
    fs.chmodSync(jobs, 0o700);
    fs.writeFileSync(
      path.join(jobs, `${job.id}.json`),
      `${JSON.stringify(job)}\n`,
      { mode: 0o600 }
    );
    return { root, env, legacy };
  };

  const valid = createLegacyOnly(makeJob("task-acacacacacacacac", "legacy-terminal"));
  const resolved = resolveWorkspaceStateReadonly(valid.root, valid.env);
  assert.equal(resolved.base, fs.realpathSync(valid.legacy));
  assert.equal(resolved.migrationRequired, true);

  const active = createLegacyOnly(makeJob(
    "task-adadadadadadadad",
    "legacy-active",
    { status: "running" }
  ));
  assert.throws(
    () => resolveWorkspaceStateReadonly(active.root, active.env),
    (error) => error?.code === "E_STATE"
      && error.message === "Authoritative job state is malformed or unsafe."
      && !error.message.includes(active.legacy)
  );

  const unsafe = createLegacyOnly(makeJob("task-aeaeaeaeaeaeaeae", "legacy-unsafe"));
  const external = tempDir("grok-readonly-external-");
  fs.symlinkSync(external, path.join(unsafe.legacy, "nested-escape"));
  assert.throws(
    () => resolveWorkspaceStateReadonly(unsafe.root, unsafe.env),
    (error) => error?.code === "E_STATE"
      && error.message === "Authoritative job state is malformed or unsafe."
      && !error.message.includes(unsafe.legacy)
      && !error.message.includes(external)
  );
});

test("default status path keeps array JSON shape and still migrates late legacy", () => {
  const root = initRepo();
  const env = envFor();
  const controlId = "task-2222222222222222";
  writeJob(root, makeJob(controlId, "control"), env);
  const controlState = workspaceState(root, env);
  const stateParent = path.join(env.GROK_COMPANION_PLUGIN_DATA, "state");
  const legacy = path.join(stateParent, workspaceStateSegment(fs.realpathSync(root)));
  const legacyJobs = path.join(legacy, "jobs");
  fs.mkdirSync(legacyJobs, { recursive: true, mode: 0o700 });
  fs.chmodSync(legacy, 0o700);
  fs.chmodSync(legacyJobs, 0o700);
  const legacyId = "task-3333333333333333";
  fs.writeFileSync(
    path.join(legacyJobs, `${legacyId}.json`),
    `${JSON.stringify(makeJob(legacyId, "late-legacy"))}\n`,
    { mode: 0o600 }
  );

  const result = runCompanion(["status", "--all", "--json"], { cwd: root, env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(Array.isArray(payload), true, "default status --all --json remains a bare array");
  assert.equal(payload.some((job) => job.id === controlId), true);
  assert.equal(payload.some((job) => job.id === legacyId), true);
  assert.equal(fs.existsSync(path.join(controlState, "jobs", `${legacyId}.json`)), true);
});

test("readJobStatusReadonly returns a single validated job without migration", () => {
  const root = initRepo();
  const env = envFor();
  const id = "task-4444444444444444";
  writeJob(root, makeJob(id, "single"), env);
  const controlState = workspaceState(root, env);
  const stateParent = path.join(env.GROK_COMPANION_PLUGIN_DATA, "state");
  const legacy = path.join(stateParent, workspaceStateSegment(fs.realpathSync(root)));
  const legacyJobs = path.join(legacy, "jobs");
  fs.mkdirSync(legacyJobs, { recursive: true, mode: 0o700 });
  fs.chmodSync(legacy, 0o700);
  fs.chmodSync(legacyJobs, 0o700);
  const legacyId = "task-5555555555555555";
  fs.writeFileSync(
    path.join(legacyJobs, `${legacyId}.json`),
    `${JSON.stringify(makeJob(legacyId, "legacy-only"))}\n`,
    { mode: 0o600 }
  );
  const markerBefore = fs.readdirSync(controlState)
    .filter((name) => name.startsWith(".legacy-migration-v3-")).length;

  const { job, migrationRequired } = readJobStatusReadonly(root, id, env);
  assert.equal(job.summary, "single");
  assert.equal(migrationRequired, true);
  assert.equal(fs.existsSync(path.join(controlState, "jobs", `${legacyId}.json`)), false);
  assert.equal(
    fs.readdirSync(controlState).filter((name) => name.startsWith(".legacy-migration-v3-")).length,
    markerBefore
  );
});
