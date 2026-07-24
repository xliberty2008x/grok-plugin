import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  childEnvironment,
  deleteSession,
  inspectImportedSessionPresence,
  taskCredentialEnvironment
} from "../plugins/grok/scripts/lib/grok-provider.mjs";
import {
  InstalledWorkerSessionTransactionError,
  bindInstalledWorkerSessionBoundary,
  runInstalledWorkerSessionCredentialTransaction
} from "../scripts/lib/installed-worker-mcp-session-boundary.mjs";
import { installFakeGrok, readFakeLog } from "./fake-grok.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-session-boundary-"));
  const stateDirectory = path.join(root, "state");
  const homeMarker = "task-0123456789abcdef01234567";
  const home = path.join(stateDirectory, "task-homes", homeMarker);
  const grokHome = path.join(home, ".grok");
  fs.mkdirSync(grokHome, { recursive: true, mode: 0o700 });
  return { root, stateDirectory, homeMarker, home, grokHome };
}

function providerEnvironment() {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/wrong-home",
    GROK_HOME: "/wrong-grok-home",
    GROK_AUTH_PATH: "/external/auth.json",
    GROK_SUBAGENTS: "1"
  };
}

test("installed worker session boundary binds the exact existing task home", (t) => {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const binding = bindInstalledWorkerSessionBoundary({
    stateDirectory: value.stateDirectory,
    homeMarker: value.homeMarker,
    childEnvironment: providerEnvironment
  });
  assert.equal(binding.stateDirectory, fs.realpathSync(value.stateDirectory));
  assert.equal(binding.home, fs.realpathSync(value.home));
  assert.equal(binding.grokHome, fs.realpathSync(value.grokHome));
  assert.equal(binding.authFile, path.join(binding.grokHome, "auth.json"));
  assert.match(binding.directoryIdentity.home.device, /^\d+$/);
  assert.match(binding.directoryIdentity.home.inode, /^\d+$/);
  assert.equal(binding.env.HOME, binding.home);
  assert.equal(binding.env.USERPROFILE, binding.home);
  assert.equal(binding.env.GROK_HOME, binding.grokHome);
  assert.equal(binding.env.GROK_FOLDER_TRUST, "1");
  assert.equal(binding.env.GROK_SUBAGENTS, "0");
  assert.equal(binding.env.GROK_CODEX_SESSIONS_ENABLED, "false");
  assert.equal(Object.hasOwn(binding.env, "GROK_AUTH_PATH"), false);
  assert.equal(Object.isFrozen(binding), true);
  assert.equal(Object.isFrozen(binding.env), true);
});

test("installed worker session boundary rejects missing and unsafe homes", (t) => {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const bind = (overrides = {}) => bindInstalledWorkerSessionBoundary({
    stateDirectory: value.stateDirectory,
    homeMarker: value.homeMarker,
    childEnvironment: providerEnvironment,
    ...overrides
  });
  assert.throws(() => bind({ homeMarker: "../escape" }), TypeError);
  assert.throws(() => bind({ homeMarker: "." }), TypeError);
  assert.throws(() => bind({ homeMarker: "missing-home" }), /ENOENT/);

  fs.rmSync(value.grokHome, { recursive: true, force: true });
  fs.symlinkSync(value.stateDirectory, value.grokHome, "dir");
  assert.throws(() => bind(), /plain directory/);
});

test("installed worker session boundary rejects an invalid environment factory", (t) => {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  assert.throws(
    () => bindInstalledWorkerSessionBoundary({
      stateDirectory: value.stateDirectory,
      homeMarker: value.homeMarker,
      childEnvironment: () => null
    }),
    /environment/
  );
});

test("session presence and deletion are isolated by the bound GROK_HOME", (t) => {
  const value = fixture();
  const baseHome = path.join(value.root, "base-home");
  const baseGrokHome = path.join(baseHome, ".grok");
  fs.mkdirSync(baseGrokHome, { recursive: true, mode: 0o700 });
  const fake = installFakeGrok(path.join(value.root, "fake-grok"), {
    sessionsStoreByGrokHome: true
  });
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const sessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  fs.writeFileSync(
    path.join(value.grokHome, "sessions.json"),
    JSON.stringify({ sessions: [{ id: sessionId }] }),
    { mode: 0o600 }
  );
  fs.writeFileSync(
    path.join(baseGrokHome, "sessions.json"),
    JSON.stringify({ sessions: [] }),
    { mode: 0o600 }
  );

  const binding = bindInstalledWorkerSessionBoundary({
    stateDirectory: value.stateDirectory,
    homeMarker: value.homeMarker,
    childEnvironment
  });
  const baseEnv = childEnvironment({
    HOME: baseHome,
    USERPROFILE: baseHome,
    GROK_HOME: baseGrokHome
  });
  assert.deepEqual(
    inspectImportedSessionPresence(sessionId, fake.binary, baseEnv, value.root),
    { ok: true, present: false }
  );
  assert.deepEqual(
    inspectImportedSessionPresence(sessionId, fake.binary, binding.env, value.root),
    { ok: true, present: true }
  );
  assert.deepEqual(deleteSession(sessionId, fake.binary, binding.env), {
    ok: true,
    removed: true,
    warning: null
  });
  assert.deepEqual(
    inspectImportedSessionPresence(sessionId, fake.binary, binding.env, value.root),
    { ok: true, present: false }
  );
  const noOpDeletion = deleteSession(sessionId, fake.binary, binding.env);
  assert.equal(noOpDeletion.ok, false);
  assert.equal(noOpDeletion.removed, false);
  assert.match(noOpDeletion.warning, /^No session found with id /);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(baseGrokHome, "sessions.json"), "utf8")),
    { sessions: [] }
  );
  const sessionEvents = readFakeLog(fake.logFile)
    .filter((entry) => ["sessions-list", "delete-session"].includes(entry.event));
  assert.ok(sessionEvents.some((entry) => entry.grokHome === baseGrokHome));
  assert.ok(sessionEvents.some((entry) => entry.event === "delete-session"));
  assert.ok(
    sessionEvents
      .filter((entry) => entry.event === "delete-session")
      .every((entry) => entry.grokHome === binding.grokHome)
  );
});

test("credential-only session transaction authenticates, deletes exactly, proves absence twice, then revokes", async (t) => {
  const value = fixture();
  const fake = installFakeGrok(path.join(value.root, "fake-grok"), {
    sessionsStoreByGrokHome: true
  });
  const previousAuthPath = process.env.GROK_AUTH_PATH;
  process.env.GROK_AUTH_PATH = fake.authPath;
  t.after(() => {
    if (previousAuthPath === undefined) delete process.env.GROK_AUTH_PATH;
    else process.env.GROK_AUTH_PATH = previousAuthPath;
    fs.rmSync(value.root, { recursive: true, force: true });
  });
  const sessionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const configFile = path.join(value.grokHome, "config.toml");
  const sandboxFile = path.join(value.grokHome, "sandbox.toml");
  fs.writeFileSync(configFile, "original-config\n", { mode: 0o600 });
  fs.writeFileSync(sandboxFile, "original-sandbox\n", { mode: 0o600 });
  fs.writeFileSync(
    path.join(value.grokHome, "sessions.json"),
    JSON.stringify({ sessions: [{ id: sessionId }] }),
    { mode: 0o600 }
  );
  const binding = bindInstalledWorkerSessionBoundary({
    stateDirectory: value.stateDirectory,
    homeMarker: value.homeMarker,
    childEnvironment
  });
  const order = [];
  let acknowledged = false;
  const result = await runInstalledWorkerSessionCredentialTransaction({
    mode: "delete",
    stageCredential() {
      order.push("stage");
      return taskCredentialEnvironment(binding.stateDirectory, value.homeMarker);
    },
    authenticate() {
      order.push("models");
      const run = spawnSync(fake.binary, ["models"], {
        cwd: value.root,
        env: binding.env,
        encoding: "utf8",
        shell: false
      });
      assert.equal(run.status, 0);
      assert.equal(run.stderr, "");
    },
    provePresent() {
      order.push("present");
      assert.deepEqual(
        inspectImportedSessionPresence(
          sessionId,
          fake.binary,
          binding.env,
          value.root
        ),
        { ok: true, present: true }
      );
    },
    deleteExact() {
      order.push("delete");
      const deletion = deleteSession(sessionId, fake.binary, binding.env);
      return deletion.ok === true && deletion.removed === true;
    },
    onDeleteAcknowledged() {
      acknowledged = true;
    },
    proveAbsent() {
      for (const label of ["absent-1", "absent-2"]) {
        order.push(label);
        assert.deepEqual(
          inspectImportedSessionPresence(
            sessionId,
            fake.binary,
            binding.env,
            value.root
          ),
          { ok: true, present: false }
        );
      }
    },
    beforeCredentialRevocation() {
      order.push("before-revoke");
    },
    revokeCredential(environment) {
      order.push("revoke");
      environment.revokeCredential();
    },
    assertCredentialAbsent() {
      order.push("credential-absent");
      assert.equal(fs.existsSync(binding.authFile), false);
    }
  });
  assert.deepEqual(result, { deleteAcknowledged: true });
  assert.equal(acknowledged, true);
  assert.deepEqual(order, [
    "stage",
    "models",
    "present",
    "delete",
    "absent-1",
    "absent-2",
    "before-revoke",
    "revoke",
    "credential-absent"
  ]);
  assert.equal(fs.readFileSync(configFile, "utf8"), "original-config\n");
  assert.equal(fs.readFileSync(sandboxFile, "utf8"), "original-sandbox\n");
  const commands = readFakeLog(fake.logFile)
    .filter((entry) => ["models", "sessions-list", "delete-session"]
      .includes(entry.event));
  assert.deepEqual(commands.map((entry) => entry.event), [
    "models",
    "sessions-list",
    "delete-session",
    "sessions-list",
    "sessions-list"
  ]);
  assert.ok(commands.every((entry) => entry.home === binding.home));
  assert.ok(commands.every((entry) => entry.grokHome === binding.grokHome));
  assert.ok(commands.every((entry) => entry.authExists === true));
});

test("session transaction rejects delete no-op and always revokes", async () => {
  const order = [];
  let acknowledged = false;
  await assert.rejects(
    () => runInstalledWorkerSessionCredentialTransaction({
      mode: "delete",
      stageCredential() {
        order.push("stage");
        return { id: "credential" };
      },
      authenticate() { order.push("models"); },
      provePresent() { order.push("present"); },
      deleteExact() {
        order.push("delete-no-op");
        return false;
      },
      onDeleteAcknowledged() { acknowledged = true; },
      proveAbsent() { order.push("unexpected-absence"); },
      revokeCredential() { order.push("revoke"); },
      assertCredentialAbsent() { order.push("credential-absent"); }
    }),
    (error) => (
      error instanceof InstalledWorkerSessionTransactionError
      && error.kind === "session"
    )
  );
  assert.equal(acknowledged, false);
  assert.deepEqual(order, [
    "stage",
    "models",
    "present",
    "delete-no-op",
    "revoke",
    "credential-absent"
  ]);
});

test("acknowledged delete recovery proves absence without a second presence or delete", async () => {
  let acknowledged = false;
  let revoked = 0;
  const common = {
    mode: "delete",
    stageCredential: () => ({}),
    authenticate: () => {},
    provePresent: () => {},
    deleteExact: () => true,
    onDeleteAcknowledged: () => { acknowledged = true; },
    revokeCredential: () => { revoked += 1; },
    assertCredentialAbsent: () => {}
  };
  await assert.rejects(
    () => runInstalledWorkerSessionCredentialTransaction({
      ...common,
      proveAbsent() { throw new Error("transient absence failure"); }
    }),
    /transient absence failure/
  );
  assert.equal(acknowledged, true);
  assert.equal(revoked, 1);

  let presentCalls = 0;
  let deleteCalls = 0;
  const recovered = await runInstalledWorkerSessionCredentialTransaction({
    ...common,
    deleteAcknowledged: true,
    provePresent() { presentCalls += 1; },
    deleteExact() { deleteCalls += 1; return true; },
    proveAbsent() {},
    onDeleteAcknowledged() { throw new Error("must not be called"); }
  });
  assert.deepEqual(recovered, { deleteAcknowledged: true });
  assert.equal(presentCalls, 0);
  assert.equal(deleteCalls, 0);
  assert.equal(revoked, 2);
});

test("delete acknowledgement survives a post-delete credential refresh failure", async () => {
  let acknowledged = false;
  let revoked = 0;
  await assert.rejects(
    () => runInstalledWorkerSessionCredentialTransaction({
      mode: "delete",
      stageCredential: () => ({}),
      authenticate: () => {},
      provePresent: () => {},
      deleteExact() {
        acknowledged = true;
        throw new Error("credential refresh failed after exact delete ack");
      },
      onDeleteAcknowledged: () => {
        throw new Error("helper acknowledgement is intentionally bypassed");
      },
      proveAbsent: () => {},
      revokeCredential: () => { revoked += 1; },
      assertCredentialAbsent: () => {}
    }),
    /credential refresh failed after exact delete ack/
  );
  assert.equal(acknowledged, true);
  assert.equal(revoked, 1);

  let presenceCalls = 0;
  let deleteCalls = 0;
  await runInstalledWorkerSessionCredentialTransaction({
    mode: "delete",
    deleteAcknowledged: acknowledged,
    stageCredential: () => ({}),
    authenticate: () => {},
    provePresent: () => { presenceCalls += 1; },
    deleteExact: () => { deleteCalls += 1; return true; },
    onDeleteAcknowledged: () => {},
    proveAbsent: () => {},
    revokeCredential: () => { revoked += 1; },
    assertCredentialAbsent: () => {}
  });
  assert.equal(presenceCalls, 0);
  assert.equal(deleteCalls, 0);
  assert.equal(revoked, 2);
});

test("credential cleanup failure overrides a primary session failure", async () => {
  await assert.rejects(
    () => runInstalledWorkerSessionCredentialTransaction({
      mode: "observe",
      stageCredential: () => ({}),
      authenticate() { throw new Error("authentication failed"); },
      provePresent: () => {},
      revokeCredential() { throw new Error("revoke failed"); },
      assertCredentialAbsent: () => {}
    }),
    (error) => (
      error instanceof InstalledWorkerSessionTransactionError
      && error.kind === "cleanup"
    )
  );
});

test("models, presence, and absence failures revoke without false acknowledgement", async () => {
  for (const failurePoint of ["models", "presence", "absence"]) {
    const order = [];
    let acknowledged = false;
    await assert.rejects(
      () => runInstalledWorkerSessionCredentialTransaction({
        mode: failurePoint === "absence" ? "delete" : "observe",
        deleteAcknowledged: failurePoint === "absence",
        stageCredential() {
          order.push("stage");
          return {};
        },
        authenticate() {
          order.push("models");
          if (failurePoint === "models") throw new Error("models failed");
        },
        provePresent() {
          order.push("present");
          if (failurePoint === "presence") throw new Error("presence failed");
        },
        deleteExact() {
          order.push("delete");
          return true;
        },
        onDeleteAcknowledged() { acknowledged = true; },
        proveAbsent() {
          order.push("absence");
          if (failurePoint === "absence") throw new Error("absence failed");
        },
        revokeCredential() { order.push("revoke"); },
        assertCredentialAbsent() { order.push("credential-absent"); }
      }),
      new RegExp(`${failurePoint} failed`)
    );
    assert.equal(acknowledged, false, failurePoint);
    assert.deepEqual(order.slice(-2), ["revoke", "credential-absent"]);
    if (failurePoint !== "absence") {
      assert.equal(order.includes("delete"), false, failurePoint);
    }
  }
});

test("already-absent without delete acknowledgement remains fail-closed", async () => {
  let deleteCalls = 0;
  let revoked = false;
  await assert.rejects(
    () => runInstalledWorkerSessionCredentialTransaction({
      mode: "delete",
      stageCredential: () => ({}),
      authenticate: () => {},
      provePresent() { throw new Error("session already absent"); },
      deleteExact() { deleteCalls += 1; return true; },
      onDeleteAcknowledged: () => {},
      proveAbsent: () => {},
      revokeCredential() { revoked = true; },
      assertCredentialAbsent: () => {}
    }),
    /session already absent/
  );
  assert.equal(deleteCalls, 0);
  assert.equal(revoked, true);
});

test("primary stage identity survives the final revocation stage", async () => {
  const primary = Object.assign(new Error("staging failed"), {
    code: "E_SESSION",
    stage: "completion-session-presence"
  });
  let currentStage = primary.stage;
  let revoked = false;
  await assert.rejects(
    () => runInstalledWorkerSessionCredentialTransaction({
      mode: "observe",
      stageCredential() { throw primary; },
      authenticate: () => {},
      provePresent: () => {},
      beforeCredentialRevocation() {
        currentStage = "completion-session-cleanup-credential-revoked";
      },
      revokeCredential() { revoked = true; },
      assertCredentialAbsent: () => {}
    }),
    (error) => error === primary
      && error.stage === "completion-session-presence"
  );
  assert.equal(currentStage, "completion-session-cleanup-credential-revoked");
  assert.equal(revoked, true);
});

test("credential fd neutralizes the original after grok-home rename without touching replacement", (t) => {
  const value = fixture();
  const fake = installFakeGrok(path.join(value.root, "fake-grok"));
  const previousAuthPath = process.env.GROK_AUTH_PATH;
  process.env.GROK_AUTH_PATH = fake.authPath;
  t.after(() => {
    if (previousAuthPath === undefined) delete process.env.GROK_AUTH_PATH;
    else process.env.GROK_AUTH_PATH = previousAuthPath;
    fs.rmSync(value.root, { recursive: true, force: true });
  });
  const binding = bindInstalledWorkerSessionBoundary({
    stateDirectory: value.stateDirectory,
    homeMarker: value.homeMarker,
    childEnvironment
  });
  const environment = taskCredentialEnvironment(
    binding.stateDirectory,
    value.homeMarker
  );
  const movedGrokHome = `${binding.grokHome}.moved`;
  fs.renameSync(binding.grokHome, movedGrokHome);
  fs.mkdirSync(binding.grokHome, { mode: 0o700 });
  const replacementAuth = path.join(binding.grokHome, "auth.json");
  fs.writeFileSync(replacementAuth, "replacement-sentinel\n", { mode: 0o600 });

  assert.throws(() => environment.revokeCredential());
  assert.equal(
    fs.statSync(path.join(movedGrokHome, "auth.json")).size,
    0
  );
  assert.equal(
    fs.readFileSync(replacementAuth, "utf8"),
    "replacement-sentinel\n"
  );
});

test("post-stage boundary failure neutralizes credential before handoff", (t) => {
  const value = fixture();
  const fake = installFakeGrok(path.join(value.root, "fake-grok"));
  const previousAuthPath = process.env.GROK_AUTH_PATH;
  process.env.GROK_AUTH_PATH = fake.authPath;
  t.after(() => {
    if (previousAuthPath === undefined) delete process.env.GROK_AUTH_PATH;
    else process.env.GROK_AUTH_PATH = previousAuthPath;
    fs.rmSync(value.root, { recursive: true, force: true });
  });
  const binding = bindInstalledWorkerSessionBoundary({
    stateDirectory: value.stateDirectory,
    homeMarker: value.homeMarker,
    childEnvironment
  });
  let staged = null;
  const movedGrokHome = `${binding.grokHome}.handoff`;
  assert.throws(() => {
    try {
      staged = taskCredentialEnvironment(
        binding.stateDirectory,
        value.homeMarker
      );
      fs.renameSync(binding.grokHome, movedGrokHome);
      fs.mkdirSync(binding.grokHome, { mode: 0o700 });
      const rebound = bindInstalledWorkerSessionBoundary({
        stateDirectory: binding.stateDirectory,
        homeMarker: value.homeMarker,
        childEnvironment
      });
      if (
        rebound.directoryIdentity.grokHome.device
          !== binding.directoryIdentity.grokHome.device
        || rebound.directoryIdentity.grokHome.inode
          !== binding.directoryIdentity.grokHome.inode
      ) {
        throw new Error("session boundary changed before handoff");
      }
    } catch (error) {
      if (staged) staged.revokeCredential();
      throw error;
    }
  });
  assert.equal(
    fs.statSync(path.join(movedGrokHome, "auth.json")).size,
    0
  );
});

test("credential fd neutralizes replaced auth inode without unlinking replacement", (t) => {
  const value = fixture();
  const fake = installFakeGrok(path.join(value.root, "fake-grok"));
  const previousAuthPath = process.env.GROK_AUTH_PATH;
  process.env.GROK_AUTH_PATH = fake.authPath;
  t.after(() => {
    if (previousAuthPath === undefined) delete process.env.GROK_AUTH_PATH;
    else process.env.GROK_AUTH_PATH = previousAuthPath;
    fs.rmSync(value.root, { recursive: true, force: true });
  });
  const binding = bindInstalledWorkerSessionBoundary({
    stateDirectory: value.stateDirectory,
    homeMarker: value.homeMarker,
    childEnvironment
  });
  const environment = taskCredentialEnvironment(
    binding.stateDirectory,
    value.homeMarker
  );
  const originalAuth = `${binding.authFile}.moved`;
  fs.renameSync(binding.authFile, originalAuth);
  fs.writeFileSync(binding.authFile, "replacement-sentinel\n", { mode: 0o600 });

  assert.throws(() => environment.revokeCredential());
  assert.equal(fs.statSync(originalAuth).size, 0);
  assert.equal(
    fs.readFileSync(binding.authFile, "utf8"),
    "replacement-sentinel\n"
  );
});

test("credential handle refresh retires a provider-rotated auth inode", (t) => {
  const value = fixture();
  const fake = installFakeGrok(path.join(value.root, "fake-grok"));
  const previousAuthPath = process.env.GROK_AUTH_PATH;
  process.env.GROK_AUTH_PATH = fake.authPath;
  t.after(() => {
    if (previousAuthPath === undefined) delete process.env.GROK_AUTH_PATH;
    else process.env.GROK_AUTH_PATH = previousAuthPath;
    fs.rmSync(value.root, { recursive: true, force: true });
  });
  const binding = bindInstalledWorkerSessionBoundary({
    stateDirectory: value.stateDirectory,
    homeMarker: value.homeMarker,
    childEnvironment
  });
  const environment = taskCredentialEnvironment(
    binding.stateDirectory,
    value.homeMarker
  );
  const originalAuth = `${binding.authFile}.rotated`;
  fs.renameSync(binding.authFile, originalAuth);
  fs.copyFileSync(fake.authPath, binding.authFile);
  fs.chmodSync(binding.authFile, 0o600);

  environment.refreshCredentialHandle();
  assert.equal(fs.statSync(originalAuth).size, 0);
  environment.revokeCredential();
  assert.equal(fs.existsSync(binding.authFile), false);
  environment.revokeCredential();
});

test("failed provider command still adopts and revokes a rotated credential", (t) => {
  const value = fixture();
  const fake = installFakeGrok(path.join(value.root, "fake-grok"));
  const previousAuthPath = process.env.GROK_AUTH_PATH;
  process.env.GROK_AUTH_PATH = fake.authPath;
  t.after(() => {
    if (previousAuthPath === undefined) delete process.env.GROK_AUTH_PATH;
    else process.env.GROK_AUTH_PATH = previousAuthPath;
    fs.rmSync(value.root, { recursive: true, force: true });
  });
  const binding = bindInstalledWorkerSessionBoundary({
    stateDirectory: value.stateDirectory,
    homeMarker: value.homeMarker,
    childEnvironment
  });
  const environment = taskCredentialEnvironment(
    binding.stateDirectory,
    value.homeMarker
  );
  const originalAuth = `${binding.authFile}.failed-command`;

  assert.throws(() => {
    try {
      fs.renameSync(binding.authFile, originalAuth);
      fs.copyFileSync(fake.authPath, binding.authFile);
      fs.chmodSync(binding.authFile, 0o600);
      throw new Error("models failed after credential rotation");
    } finally {
      environment.refreshCredentialHandle();
    }
  }, /models failed after credential rotation/);
  assert.equal(fs.statSync(originalAuth).size, 0);
  environment.revokeCredential();
  assert.equal(fs.existsSync(binding.authFile), false);
});
