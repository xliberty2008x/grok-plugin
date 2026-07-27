import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  workerSessionCloseControllerEnvironment,
  WORKTREE_CLEANUP_CONTROLLER_PROFILE_ID
} from "../plugins/grok/scripts/lib/grok-provider.mjs";
import { tempDir } from "./helpers.mjs";

function goneWriterIdentity(providerPid = 2_147_483_646) {
  return Object.freeze({
    pid: 2_147_483_647,
    startToken: "verified-gone-test-controller",
    processGroupId: 2_147_483_647,
    providerPid
  });
}

function createFixture(t) {
  const stateDir = fs.realpathSync(tempDir("session-close-environment-"));
  fs.chmodSync(stateDir, 0o700);
  const providerHomeId = "provider-lineage-0123456789abcdef";
  const homeMarker = "session-close-controller-0123456789abcdef";
  const taskHomes = path.join(stateDir, "task-homes");
  const lineageHome = path.join(taskHomes, providerHomeId);
  const grokHome = path.join(lineageHome, ".grok");
  const sessions = path.join(grokHome, "sessions");
  fs.mkdirSync(sessions, { recursive: true, mode: 0o755 });
  fs.chmodSync(taskHomes, 0o700);
  fs.chmodSync(lineageHome, 0o700);
  fs.chmodSync(grokHome, 0o700);
  fs.chmodSync(sessions, 0o755);
  const configFile = path.join(grokHome, "config.toml");
  const sandboxFile = path.join(grokHome, "sandbox.toml");
  const sessionFile = path.join(sessions, "provider-session.jsonl");
  fs.writeFileSync(configFile, "[features]\nlsp_tools = false\n", {
    mode: 0o600
  });
  fs.writeFileSync(
    sandboxFile,
    "[profiles.existing_task]\nextends = \"workspace-write\"\n",
    { mode: 0o600 }
  );
  fs.writeFileSync(sessionFile, "{\"session\":\"preserve-me\"}\n", {
    mode: 0o600
  });
  const authPath = path.join(stateDir, "cached-auth.json");
  const secret = "session-close-secret-0123456789";
  fs.writeFileSync(
    authPath,
    `${JSON.stringify({
      test: {
        key: secret,
        auth_mode: "oauth",
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString()
      }
    })}\n`,
    { mode: 0o600 }
  );
  const previousAuthPath = process.env.GROK_AUTH_PATH;
  process.env.GROK_AUTH_PATH = authPath;
  t.after(() => {
    if (previousAuthPath === undefined) delete process.env.GROK_AUTH_PATH;
    else process.env.GROK_AUTH_PATH = previousAuthPath;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  return {
    stateDir,
    providerHomeId,
    homeMarker,
    taskHomes,
    lineageHome,
    grokHome,
    sessions,
    configFile,
    sandboxFile,
    sessionFile,
    secret
  };
}

test("session-close controller uses a fresh HOME and the exact preserved lineage GROK_HOME", (t) => {
  const fixture = createFixture(t);
  const configBefore = {
    contents: fs.readFileSync(fixture.configFile, "utf8"),
    inode: fs.lstatSync(fixture.configFile).ino
  };
  const sandboxBefore = {
    contents: fs.readFileSync(fixture.sandboxFile, "utf8"),
    inode: fs.lstatSync(fixture.sandboxFile).ino
  };
  const environment = workerSessionCloseControllerEnvironment(
    fixture.stateDir,
    fixture.providerHomeId,
    { homeMarker: fixture.homeMarker }
  );
  const authFile = path.join(fixture.grokHome, "auth.json");

  assert.equal(
    environment.home,
    path.join(fixture.taskHomes, fixture.homeMarker)
  );
  assert.notEqual(environment.home, fixture.lineageHome);
  assert.equal(
    environment.controllerCwd,
    path.join(environment.home, "controller-cwd")
  );
  assert.equal(fs.lstatSync(environment.home).mode & 0o777, 0o700);
  assert.equal(fs.lstatSync(environment.controllerCwd).mode & 0o777, 0o700);
  assert.equal(environment.grokHome, fixture.grokHome);
  assert.equal(environment.env.HOME, environment.home);
  assert.equal(environment.env.USERPROFILE, environment.home);
  assert.equal(environment.env.GROK_HOME, fixture.grokHome);
  assert.equal(environment.env.GROK_WORKSPACE_TOOL_DEFS_ENABLED, "0");
  assert.equal(environment.sandboxProfile, "strict");
  assert.equal(
    environment.profileId,
    WORKTREE_CLEANUP_CONTROLLER_PROFILE_ID
  );
  assert.equal(fs.existsSync(path.join(environment.home, ".grok")), false);
  assert.equal(fs.existsSync(authFile), false);
  assert.deepEqual(environment.knownSecrets, []);
  assert.match(environment.sessionHomeIdentityDigest, /^[0-9a-f]{64}$/);
  assert.equal(
    environment.verifySessionHome(),
    environment.sessionHomeIdentityDigest
  );
  assert.equal(environment.sessionHomeIdentities, undefined);

  environment.stageCredential();
  assert.equal(fs.existsSync(authFile), true);
  assert.equal(fs.lstatSync(authFile).mode & 0o777, 0o600);
  assert.deepEqual(environment.knownSecrets, [fixture.secret]);

  const rotated = `${authFile}.rotated`;
  fs.copyFileSync(authFile, rotated);
  fs.chmodSync(rotated, 0o600);
  fs.renameSync(rotated, authFile);
  const writerIdentity = goneWriterIdentity();
  environment.revokeCredential(writerIdentity);
  environment.assertCredentialAbsent();

  assert.equal(fs.lstatSync(fixture.configFile).ino, configBefore.inode);
  assert.equal(
    fs.readFileSync(fixture.configFile, "utf8"),
    configBefore.contents
  );
  assert.equal(fs.lstatSync(fixture.sandboxFile).ino, sandboxBefore.inode);
  assert.equal(
    fs.readFileSync(fixture.sandboxFile, "utf8"),
    sandboxBefore.contents
  );

  assert.equal(environment.cleanup(writerIdentity), true);
  environment.assertHomeAbsent();
  assert.equal(fs.existsSync(environment.home), false);
  assert.equal(fs.existsSync(fixture.lineageHome), true);
  assert.equal(fs.existsSync(fixture.grokHome), true);
  assert.equal(fs.existsSync(fixture.sessions), true);
  assert.equal(
    fs.readFileSync(fixture.sessionFile, "utf8"),
    "{\"session\":\"preserve-me\"}\n"
  );
  assert.equal(
    environment.verifySessionHome(),
    environment.sessionHomeIdentityDigest
  );
});

test("session-close controller removes only the exact provider auth temp and preserves auth.json.lock", (t) => {
  const fixture = createFixture(t);
  const environment = workerSessionCloseControllerEnvironment(
    fixture.stateDir,
    fixture.providerHomeId,
    { homeMarker: fixture.homeMarker }
  );
  const writerIdentity = goneWriterIdentity();
  const authFile = path.join(fixture.grokHome, "auth.json");
  const temporary = `${authFile}.${writerIdentity.providerPid}.tmp`;
  const lockFile = `${authFile}.lock`;
  environment.stageCredential();
  fs.writeFileSync(temporary, "temporary-secret\n", { mode: 0o600 });
  fs.writeFileSync(lockFile, "preserve-lock\n", { mode: 0o600 });
  const observedTemporary = fs.openSync(temporary, "r");

  environment.revokeCredential(writerIdentity);

  assert.equal(fs.readFileSync(observedTemporary).length, 0);
  fs.closeSync(observedTemporary);
  assert.equal(fs.existsSync(authFile), false);
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(fs.readFileSync(lockFile, "utf8"), "preserve-lock\n");
  assert.equal(environment.cleanup(writerIdentity), true);
});

test("session-close controller fails closed on a symlinked provider auth temp", (t) => {
  const fixture = createFixture(t);
  const environment = workerSessionCloseControllerEnvironment(
    fixture.stateDir,
    fixture.providerHomeId,
    { homeMarker: fixture.homeMarker }
  );
  const writerIdentity = goneWriterIdentity();
  const authFile = path.join(fixture.grokHome, "auth.json");
  const temporary = `${authFile}.${writerIdentity.providerPid}.tmp`;
  const target = path.join(fixture.stateDir, "outside-secret");
  environment.stageCredential();
  fs.writeFileSync(target, "outside-secret\n", { mode: 0o600 });
  fs.symlinkSync(target, temporary);

  assert.throws(
    () => environment.revokeCredential(writerIdentity),
    (error) => error?.code === "E_STATE"
      && /temporary file is unsafe/.test(error.message)
  );
  assert.equal(fs.existsSync(authFile), true);
  assert.equal(fs.readFileSync(target, "utf8"), "outside-secret\n");
  assert.equal(fs.lstatSync(temporary).isSymbolicLink(), true);

  fs.unlinkSync(temporary);
  environment.revokeCredential(writerIdentity);
  assert.equal(environment.cleanup(writerIdentity), true);
});

test("session-close controller fails closed on a hard-linked replacement auth temp", (t) => {
  const fixture = createFixture(t);
  const environment = workerSessionCloseControllerEnvironment(
    fixture.stateDir,
    fixture.providerHomeId,
    { homeMarker: fixture.homeMarker }
  );
  const writerIdentity = goneWriterIdentity();
  const authFile = path.join(fixture.grokHome, "auth.json");
  const temporary = `${authFile}.${writerIdentity.providerPid}.tmp`;
  const replacement = path.join(fixture.stateDir, "replacement-secret");
  environment.stageCredential();
  fs.writeFileSync(replacement, "replacement-secret\n", { mode: 0o600 });
  fs.linkSync(replacement, temporary);

  assert.throws(
    () => environment.revokeCredential(writerIdentity),
    (error) => error?.code === "E_STATE"
      && /temporary file is unsafe/.test(error.message)
  );
  assert.equal(fs.existsSync(authFile), true);
  assert.equal(
    fs.readFileSync(replacement, "utf8"),
    "replacement-secret\n"
  );

  fs.unlinkSync(temporary);
  environment.revokeCredential(writerIdentity);
  assert.equal(environment.cleanup(writerIdentity), true);
});

test("session-close controller rejects a foreign provider auth temp without deleting it", (t) => {
  const fixture = createFixture(t);
  const environment = workerSessionCloseControllerEnvironment(
    fixture.stateDir,
    fixture.providerHomeId,
    { homeMarker: fixture.homeMarker }
  );
  const writerIdentity = goneWriterIdentity();
  const authFile = path.join(fixture.grokHome, "auth.json");
  const foreign = `${authFile}.${writerIdentity.providerPid - 1}.tmp`;
  environment.stageCredential();
  fs.writeFileSync(foreign, "foreign-secret\n", { mode: 0o600 });

  assert.throws(
    () => environment.revokeCredential(writerIdentity),
    (error) => error?.code === "E_STATE"
      && /foreign credential temporary file/.test(error.message)
  );
  assert.equal(fs.existsSync(authFile), true);
  assert.equal(fs.readFileSync(foreign, "utf8"), "foreign-secret\n");

  fs.unlinkSync(foreign);
  environment.revokeCredential(writerIdentity);
  assert.equal(environment.cleanup(writerIdentity), true);
});

test("session-close controller rejects a pre-existing lineage credential without deleting it", (t) => {
  const fixture = createFixture(t);
  const authFile = path.join(fixture.grokHome, "auth.json");
  fs.writeFileSync(authFile, "pre-existing-credential\n", { mode: 0o600 });

  assert.throws(
    () => workerSessionCloseControllerEnvironment(
      fixture.stateDir,
      fixture.providerHomeId,
      { homeMarker: fixture.homeMarker }
    ),
    (error) => error?.code === "E_STATE"
      && /credential already exists/.test(error.message)
  );
  assert.equal(
    fs.existsSync(path.join(fixture.taskHomes, fixture.homeMarker)),
    false
  );
  assert.equal(
    fs.readFileSync(authFile, "utf8"),
    "pre-existing-credential\n"
  );
});

test("session-close controller rejects an aliased provider sessions root", (t) => {
  const fixture = createFixture(t);
  const externalSessions = path.join(fixture.stateDir, "external-sessions");
  fs.mkdirSync(externalSessions, { mode: 0o700 });
  fs.rmSync(fixture.sessions, { recursive: true, force: true });
  fs.symlinkSync(externalSessions, fixture.sessions, "dir");

  assert.throws(
    () => workerSessionCloseControllerEnvironment(
      fixture.stateDir,
      fixture.providerHomeId,
      { homeMarker: fixture.homeMarker }
    ),
    (error) => error?.code === "E_STATE"
      && /session directory is unsafe/.test(error.message)
  );
  assert.equal(
    fs.existsSync(path.join(fixture.taskHomes, fixture.homeMarker)),
    false
  );
});

test("session-close controller detects provider session-root replacement before close", (t) => {
  const fixture = createFixture(t);
  const environment = workerSessionCloseControllerEnvironment(
    fixture.stateDir,
    fixture.providerHomeId,
    { homeMarker: fixture.homeMarker }
  );
  const originalSessions = `${fixture.sessions}.original`;
  fs.renameSync(fixture.sessions, originalSessions);
  fs.mkdirSync(fixture.sessions, { mode: 0o755 });

  assert.throws(
    () => environment.verifySessionHome(),
    (error) => error?.code === "E_STATE"
      && /session home identity changed/.test(error.message)
  );
  assert.throws(
    () => environment.cleanup(null),
    (error) => error?.code === "E_STATE"
      && /session home identity changed/.test(error.message)
  );
  assert.equal(
    fs.existsSync(environment.home),
    true,
    "ephemeral home must be retained when lineage identity is ambiguous"
  );

  fs.rmSync(fixture.sessions, { recursive: true, force: true });
  fs.renameSync(originalSessions, fixture.sessions);
  assert.equal(
    environment.verifySessionHome(),
    environment.sessionHomeIdentityDigest
  );
  assert.equal(environment.cleanup(null), true);
  assert.equal(fs.existsSync(environment.home), false);
});
