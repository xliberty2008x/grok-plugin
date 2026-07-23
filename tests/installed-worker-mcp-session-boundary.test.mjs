import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  childEnvironment,
  deleteSession,
  inspectImportedSessionPresence
} from "../plugins/grok/scripts/lib/grok-provider.mjs";
import {
  bindInstalledWorkerSessionBoundary
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
  assert.equal(deleteSession(sessionId, fake.binary, binding.env).ok, true);
  assert.deepEqual(
    inspectImportedSessionPresence(sessionId, fake.binary, binding.env, value.root),
    { ok: true, present: false }
  );
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
