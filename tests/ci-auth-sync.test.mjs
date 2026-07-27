import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  digestStatePath,
  readPrivateAuthFile,
  removeStaleCandidates,
  synchronizeAuth,
  tightenPrivateDirectory,
  validateAuthPayload
} from "../scripts/sync-grok-ci-auth.mjs";
import {
  buildLaunchAgentPlist,
  installerPaths,
  runInstaller
} from "../scripts/install-grok-ci-auth-sync.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = path.join(ROOT, "scripts", "sync-grok-ci-auth.mjs");
const VERIFIED_NODE = fs.realpathSync(process.execPath);
const SENTINEL_KEY = "ci-auth-sync-key-material";
const SENTINEL_REFRESH = "ci-auth-sync-refresh-material";

function privateTempDir(t, prefix = "grok-ci-auth-test-") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function validPayload(overrides = {}) {
  return {
    account: {
      key: SENTINEL_KEY,
      refresh_token: SENTINEL_REFRESH,
      expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      ...overrides
    }
  };
}

function writeAuth(root, payload = validPayload()) {
  const authDirectory = path.join(root, "grok-home");
  fs.mkdirSync(authDirectory, { mode: 0o700 });
  fs.chmodSync(authDirectory, 0o700);
  const authPath = path.join(authDirectory, "auth.json");
  const raw = `${JSON.stringify(payload)}\n`;
  fs.writeFileSync(authPath, raw, { mode: 0o600 });
  fs.chmodSync(authPath, 0o600);
  return { authPath, raw };
}

function makeMockGh(
  root,
  {
    exitCode = 0,
    delayMs = 0,
    echoInputToStderr = false
  } = {}
) {
  const capture = path.join(root, `gh-capture-${crypto.randomBytes(4).toString("hex")}.jsonl`);
  const executable = path.join(root, `mock-gh-${crypto.randomBytes(4).toString("hex")}`);
  const source = [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    `const capture = ${JSON.stringify(capture)};`,
    "const input = fs.readFileSync(0);",
    delayMs > 0
      ? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${delayMs});`
      : "",
    `fs.appendFileSync(capture, JSON.stringify({ argv: process.argv.slice(2), input: input.toString("utf8"), envKeys: Object.keys(process.env).sort() }) + "\\n");`,
    echoInputToStderr ? "process.stderr.write(input);" : "",
    `process.exit(${exitCode});`,
    ""
  ].join("\n");
  fs.writeFileSync(executable, source, { mode: 0o700 });
  fs.chmodSync(executable, 0o700);
  return { executable, capture };
}

function makeTrustedNodeShim(root) {
  const executable = path.join(
    root,
    `mock-node-${crypto.randomBytes(4).toString("hex")}`
  );
  const source = [
    `#!${process.execPath}`,
    'const { spawnSync } = require("node:child_process");',
    "const result = spawnSync(process.execPath, process.argv.slice(2), { stdio: \"inherit\" });",
    "process.exit(Number.isInteger(result.status) ? result.status : 1);",
    ""
  ].join("\n");
  fs.writeFileSync(executable, source, { mode: 0o700 });
  fs.chmodSync(executable, 0o700);
  return executable;
}

function baseFixture(t, mockOptions = {}) {
  const root = privateTempDir(t);
  const { authPath, raw } = writeAuth(root);
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.chmodSync(stateDir, 0o700);
  const mock = makeMockGh(root, mockOptions);
  const args = {
    repo: "owner/repository",
    ghBin: mock.executable,
    stateDir,
    authPath,
    force: false
  };
  return { root, authPath, raw, stateDir, mock, args };
}

function captures(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function digestFiles(stateDir) {
  return fs.readdirSync(stateDir).filter((name) => name.endsWith(".sha256"));
}

function launchctlController() {
  let loaded = false;
  let failNextBootstrap = false;
  const calls = [];
  const runner = (args) => {
    calls.push([...args]);
    if (args[0] === "print") return loaded;
    if (args[0] === "bootout") {
      loaded = false;
      return true;
    }
    if (args[0] === "bootstrap") {
      if (failNextBootstrap) {
        failNextBootstrap = false;
        return false;
      }
      loaded = true;
      return true;
    }
    return false;
  };
  return {
    runner,
    calls,
    get loaded() { return loaded; },
    setLoaded(value) { loaded = value; },
    failBootstrapOnce() { failNextBootstrap = true; }
  };
}

function installerFixture(t, mockOptions = {}) {
  const home = privateTempDir(t, "grok-ci-auth-installer-");
  const { authPath } = writeAuth(home);
  const gh = makeMockGh(home, mockOptions);
  const nodeBin = makeTrustedNodeShim(home);
  const args = {
    command: "install",
    repo: "owner/repository",
    ghBin: gh.executable,
    nodeBin,
    authPath,
    home,
    dryRun: false
  };
  return {
    home,
    gh,
    args,
    paths: installerPaths(args),
    launch: launchctlController()
  };
}

function runHelper(args, env = process.env) {
  const child = spawn(
    process.execPath,
    [
      HELPER,
      "--repo",
      args.repo,
      "--gh-bin",
      args.ghBin,
      "--state-dir",
      args.stateDir,
      "--auth-path",
      args.authPath
    ],
    {
      env,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("auth validation requires key, refresh token, and fresh expiry on the same entry", () => {
  assert.doesNotThrow(() => validateAuthPayload(Buffer.from(JSON.stringify(validPayload()))));
  assert.throws(() => validateAuthPayload(Buffer.from("{")), /valid JSON/);
  assert.throws(
    () => validateAuthPayload(Buffer.from(JSON.stringify({
      first: {
        key: SENTINEL_KEY,
        expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
      },
      second: {
        refresh_token: SENTINEL_REFRESH,
        expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
      }
    }))),
    /no sufficiently fresh/
  );
  assert.throws(
    () => validateAuthPayload(Buffer.from(JSON.stringify(validPayload({
      expires_at: new Date(Date.now() + 44 * 60 * 1000).toISOString()
    })))),
    /no sufficiently fresh/
  );
});

test("auth reader rejects group-readable files and symlinks", (t) => {
  const root = privateTempDir(t);
  const first = writeAuth(root);
  const parent = path.dirname(first.authPath);
  fs.chmodSync(parent, 0o755);
  assert.throws(() => readPrivateAuthFile(first.authPath), /group or other/);
  fs.chmodSync(parent, 0o700);
  fs.chmodSync(first.authPath, 0o640);
  assert.throws(() => readPrivateAuthFile(first.authPath), /group or other/);
  fs.chmodSync(first.authPath, 0o600);
  const link = path.join(path.dirname(first.authPath), "linked-auth.json");
  fs.symlinkSync(first.authPath, link);
  assert.throws(() => readPrivateAuthFile(link), /safely/);
});

test("sync sends exact JSON only on stdin with fixed gh args and a redacted env", (t) => {
  const fixture = baseFixture(t);
  const result = synchronizeAuth(fixture.args, {
    sourceEnv: {
      ...process.env,
      GH_TOKEN: "forbidden-gh-token",
      GITHUB_TOKEN: "forbidden-github-token",
      XAI_API_KEY: "forbidden-xai-key",
      GROK_AUTH_JSON: "forbidden-auth-json",
      GH_CONFIG_DIR: "/forbidden/gh-config",
      XDG_CONFIG_HOME: "/forbidden/xdg-config"
    }
  });
  assert.equal(result.status, "uploaded");
  const [capture] = captures(fixture.mock.capture);
  assert.deepEqual(capture.argv, [
    "secret",
    "set",
    "GROK_AUTH_JSON",
    "--app",
    "actions",
    "--repo",
    "github.com/owner/repository"
  ]);
  assert.equal(capture.input, fixture.raw);
  for (const key of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "XAI_API_KEY",
    "GROK_AUTH_JSON",
    "GH_CONFIG_DIR",
    "XDG_CONFIG_HOME"
  ]) {
    assert.equal(capture.envKeys.includes(key), false);
  }
  const [stateFile] = digestFiles(fixture.stateDir);
  assert.match(fs.readFileSync(path.join(fixture.stateDir, stateFile), "utf8").trim(), /^[0-9a-f]{64}$/);
  assert.equal(
    fs.readFileSync(path.join(fixture.stateDir, stateFile), "utf8").includes(SENTINEL_KEY),
    false
  );
});

test("installer directory hardening changes only a verified owned real directory", (t) => {
  const root = privateTempDir(t);
  const directory = path.join(root, "grok-home");
  fs.mkdirSync(directory, { mode: 0o755 });
  fs.chmodSync(directory, 0o755);
  tightenPrivateDirectory(directory, "Authentication directory");
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  const link = path.join(root, "linked-home");
  fs.symlinkSync(directory, link);
  assert.throws(
    () => tightenPrivateDirectory(link, "Authentication directory"),
    /real directory/
  );
});

test("digest suppresses duplicates, force bypasses no-op, and age self-heals", (t) => {
  const fixture = baseFixture(t);
  assert.equal(synchronizeAuth(fixture.args).status, "uploaded");
  assert.equal(synchronizeAuth(fixture.args).status, "unchanged");
  assert.equal(captures(fixture.mock.capture).length, 1);
  assert.equal(
    synchronizeAuth({ ...fixture.args, force: true }).status,
    "uploaded"
  );
  assert.equal(captures(fixture.mock.capture).length, 2);
  const [stateName] = digestFiles(fixture.stateDir);
  const stateFile = path.join(fixture.stateDir, stateName);
  const digestOnly = fs.readFileSync(stateFile, "utf8");
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  fs.utimesSync(stateFile, old, old);
  assert.equal(synchronizeAuth(fixture.args).status, "uploaded");
  assert.equal(captures(fixture.mock.capture).length, 3);
  assert.equal(fs.readFileSync(stateFile, "utf8"), digestOnly);
});

test("timeout and nonzero gh exits never advance digest state", (t) => {
  const timeoutFixture = baseFixture(t, { delayMs: 250 });
  assert.throws(
    () => synchronizeAuth(timeoutFixture.args, { uploadTimeoutMs: 40 }),
    /timed out/
  );
  assert.deepEqual(digestFiles(timeoutFixture.stateDir), []);

  const failureFixture = baseFixture(t, { exitCode: 19 });
  assert.throws(() => synchronizeAuth(failureFixture.args), /upload failed/);
  assert.deepEqual(digestFiles(failureFixture.stateDir), []);
});

test("child stderr and helper diagnostics never echo credential material", async (t) => {
  const fixture = baseFixture(t, { exitCode: 7, echoInputToStderr: true });
  const result = await runHelper(fixture.args, {
    ...process.env,
    GROK_AUTH_JSON: fixture.raw,
    GH_TOKEN: SENTINEL_KEY
  });
  assert.equal(result.code, 1);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(SENTINEL_KEY));
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(SENTINEL_REFRESH));
  assert.match(result.stderr, /E_UPLOAD/);
});

test("simultaneous helpers serialize upload and the follower observes digest state", async (t) => {
  const fixture = baseFixture(t, { delayMs: 200 });
  const [first, second] = await Promise.all([
    runHelper(fixture.args),
    runHelper(fixture.args)
  ]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(captures(fixture.mock.capture).length, 1);
  assert.match(first.stdout + second.stdout, /already current/);
});

test("stale cleanup retains a sleeping live owner and reclaims dead, invalid, or hard-TTL owners", (t) => {
  const root = privateTempDir(t);
  const lockDirectory = path.join(root, "lock-candidates");
  fs.mkdirSync(lockDirectory, { mode: 0o700 });
  const liveNonce = "a".repeat(32);
  const deadNonce = "b".repeat(32);
  const hardNonce = "c".repeat(32);
  const successorNonce = "d".repeat(32);
  const live = path.join(lockDirectory, `choosing-${liveNonce}.json`);
  const dead = path.join(lockDirectory, `choosing-${deadNonce}.json`);
  const hard = path.join(lockDirectory, `choosing-${hardNonce}.json`);
  const invalid = path.join(lockDirectory, `choosing-${"e".repeat(32)}.json`);
  const successor = path.join(
    lockDirectory,
    `ticket-0000000000000001-${successorNonce}.json`
  );
  const writeCandidate = (file, payload) => {
    fs.writeFileSync(file, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  };
  const now = Date.now();
  writeCandidate(live, {
    nonce: liveNonce,
    pid: process.pid,
    uid: process.getuid(),
    startedAt: now - 3 * 60_000,
    phase: "choosing"
  });
  writeCandidate(dead, {
    nonce: deadNonce,
    pid: 99_999_999,
    uid: process.getuid(),
    startedAt: now - 3 * 60_000,
    phase: "choosing"
  });
  writeCandidate(hard, {
    nonce: hardNonce,
    pid: process.pid,
    uid: process.getuid(),
    startedAt: now - 25 * 60 * 60_000,
    phase: "choosing"
  });
  fs.writeFileSync(invalid, "{invalid\n", { mode: 0o600 });
  writeCandidate(successor, {
    nonce: successorNonce,
    pid: process.pid,
    uid: process.getuid(),
    startedAt: now,
    phase: "ticket",
    ticket: 1
  });
  const staleTime = new Date(now - 3 * 60_000);
  const hardTime = new Date(now - 25 * 60 * 60_000);
  for (const file of [live, dead, invalid]) fs.utimesSync(file, staleTime, staleTime);
  fs.utimesSync(hard, hardTime, hardTime);
  const removed = removeStaleCandidates(lockDirectory, {
    now,
    staleAfterMs: 2 * 60_000,
    hardStaleAfterMs: 24 * 60 * 60_000
  });
  assert.deepEqual(
    new Set(removed),
    new Set([path.basename(dead), path.basename(hard), path.basename(invalid)])
  );
  assert.equal(fs.existsSync(live), true);
  assert.equal(fs.existsSync(dead), false);
  assert.equal(fs.existsSync(hard), false);
  assert.equal(fs.existsSync(successor), true);
});

test("lock-directory symlink is rejected without mutating its target", (t) => {
  const fixture = baseFixture(t);
  const target = path.join(fixture.root, "lock-target");
  fs.mkdirSync(target, { mode: 0o755 });
  fs.chmodSync(target, 0o755);
  fs.writeFileSync(path.join(target, "marker"), "unchanged\n");
  fs.symlinkSync(target, path.join(fixture.stateDir, "lock-candidates"));
  assert.throws(() => synchronizeAuth(fixture.args), /real directory/);
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  assert.equal(fs.readFileSync(path.join(target, "marker"), "utf8"), "unchanged\n");
});

test("LaunchAgent plist is argument-only, watches auth, and dry-run writes nothing", (t) => {
  const home = privateTempDir(t, "grok-ci-auth-installer-");
  const gh = makeMockGh(home);
  const args = {
    command: "install",
    repo: "owner/repository",
    ghBin: gh.executable,
    nodeBin: VERIFIED_NODE,
    authPath: path.join(home, ".grok", "auth.json"),
    home,
    dryRun: true
  };
  const paths = installerPaths(args);
  const plist = buildLaunchAgentPlist({
    ...paths,
    nodeBin: args.nodeBin,
    repo: args.repo,
    authPath: args.authPath,
    ghBin: args.ghBin
  });
  assert.match(plist, /<key>ProgramArguments<\/key>/);
  assert.match(plist, /<key>WatchPaths<\/key>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
  assert.doesNotMatch(plist, /Program\b(?!Arguments)/);
  assert.doesNotMatch(plist, /refresh_token|ci-auth-sync-refresh-material/);
  const result = runInstaller(args, { platform: "darwin" });
  assert.equal(result.command, "install");
  assert.equal(result.plistContents, plist);
  assert.equal(fs.existsSync(paths.appRoot), false);
  assert.equal(fs.existsSync(paths.plist), false);
});

test("install executes the copied helper with force on first install and reinstall", (t) => {
  const fixture = installerFixture(t);
  const options = {
    platform: "darwin",
    launchctlRunner: fixture.launch.runner
  };
  const first = runInstaller(fixture.args, options);
  assert.equal(first.status, "installed-synchronized");
  assert.equal(captures(fixture.gh.capture).length, 1);
  assert.equal(fixture.launch.loaded, true);
  const second = runInstaller(fixture.args, options);
  assert.equal(second.status, "installed-synchronized");
  assert.equal(captures(fixture.gh.capture).length, 2);
  assert.equal(fixture.launch.loaded, true);
});

test("failed one-shot leaves an armed agent with explicit pending status", (t) => {
  const fixture = installerFixture(t, { exitCode: 9 });
  const result = runInstaller(fixture.args, {
    platform: "darwin",
    launchctlRunner: fixture.launch.runner
  });
  assert.equal(result.status, "installed-pending-sync");
  assert.equal(result.health, "loaded");
  assert.equal(result.sync, "pending");
  assert.equal(fixture.launch.loaded, true);
});

test("installer rejects symlink ancestors and source helpers without target mutation", (t) => {
  const fixture = installerFixture(t);
  const libraryTarget = path.join(fixture.home, "library-target");
  fs.mkdirSync(libraryTarget, { mode: 0o755 });
  fs.chmodSync(libraryTarget, 0o755);
  fs.symlinkSync(libraryTarget, path.join(fixture.home, "Library"));
  assert.throws(
    () => runInstaller(fixture.args, {
      platform: "darwin",
      launchctlRunner: fixture.launch.runner,
      initialSyncRunner: () => true
    }),
    /real directory/
  );
  assert.equal(fs.statSync(libraryTarget).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(libraryTarget), []);

  fs.unlinkSync(path.join(fixture.home, "Library"));
  const sourceTarget = path.join(fixture.home, "source-target.mjs");
  const sourceLink = path.join(fixture.home, "source-link.mjs");
  fs.writeFileSync(sourceTarget, "// safe target\n", { mode: 0o600 });
  fs.symlinkSync(sourceTarget, sourceLink);
  assert.throws(
    () => runInstaller(fixture.args, {
      platform: "darwin",
      sourceHelper: sourceLink,
      launchctlRunner: fixture.launch.runner,
      initialSyncRunner: () => true
    }),
    /real regular file/
  );
  assert.equal(fs.readFileSync(sourceTarget, "utf8"), "// safe target\n");
  assert.equal(fs.existsSync(fixture.paths.helper), false);
  assert.equal(fs.existsSync(fixture.paths.plist), false);
});

test("custom auth parent must already be private and is never chmodded", (t) => {
  const fixture = installerFixture(t);
  const customDirectory = path.join(fixture.home, "Documents");
  fs.mkdirSync(customDirectory, { mode: 0o755 });
  fs.chmodSync(customDirectory, 0o755);
  const customAuthPath = path.join(customDirectory, "auth.json");
  fs.writeFileSync(customAuthPath, JSON.stringify(validPayload()), {
    mode: 0o600
  });
  const customArgs = {
    ...fixture.args,
    authPath: customAuthPath,
    authPathExplicit: true
  };
  assert.throws(
    () => runInstaller(customArgs, {
      platform: "darwin",
      launchctlRunner: fixture.launch.runner,
      initialSyncRunner: () => true
    }),
    /group or other access/
  );
  assert.equal(fs.statSync(customDirectory).mode & 0o777, 0o755);
  assert.equal(fs.existsSync(fixture.paths.helper), false);
});

test("bootstrap failure restores and reloads the prior safe installation", (t) => {
  const fixture = installerFixture(t);
  const oldSource = path.join(fixture.home, "old-helper.mjs");
  const newSource = path.join(fixture.home, "new-helper.mjs");
  fs.writeFileSync(oldSource, "// old helper\n", { mode: 0o600 });
  fs.writeFileSync(newSource, "// new helper\n", { mode: 0o600 });
  const common = {
    platform: "darwin",
    launchctlRunner: fixture.launch.runner,
    initialSyncRunner: () => true
  };
  runInstaller(fixture.args, { ...common, sourceHelper: oldSource });
  const priorHelper = fs.readFileSync(fixture.paths.helper, "utf8");
  const priorPlist = fs.readFileSync(fixture.paths.plist, "utf8");
  const priorInstallationDigest = fs.readFileSync(
    fixture.paths.installationDigest,
    "utf8"
  );
  fixture.launch.failBootstrapOnce();
  assert.throws(
    () => runInstaller(fixture.args, { ...common, sourceHelper: newSource }),
    /prior installation restored/
  );
  assert.equal(fs.readFileSync(fixture.paths.helper, "utf8"), priorHelper);
  assert.equal(fs.readFileSync(fixture.paths.plist, "utf8"), priorPlist);
  assert.equal(
    fs.readFileSync(fixture.paths.installationDigest, "utf8"),
    priorInstallationDigest
  );
  assert.equal(fixture.launch.loaded, true);
});

test("partial replacement write restores the prior loaded installation", (t) => {
  const fixture = installerFixture(t);
  const common = {
    platform: "darwin",
    launchctlRunner: fixture.launch.runner,
    initialSyncRunner: () => true
  };
  runInstaller(fixture.args, common);
  const priorHelper = fs.readFileSync(fixture.paths.helper);
  const priorPlist = fs.readFileSync(fixture.paths.plist);
  const priorDigest = fs.readFileSync(fixture.paths.installationDigest);
  let writes = 0;
  const failSecondWrite = (file, contents, mode) => {
    writes += 1;
    if (writes === 2) throw new Error("injected plist write failure");
    fs.writeFileSync(file, contents, { mode });
    fs.chmodSync(file, mode);
  };
  assert.throws(
    () => runInstaller(fixture.args, {
      ...common,
      fileWriter: failSecondWrite
    }),
    /prior installation restored/
  );
  assert.deepEqual(fs.readFileSync(fixture.paths.helper), priorHelper);
  assert.deepEqual(fs.readFileSync(fixture.paths.plist), priorPlist);
  assert.deepEqual(
    fs.readFileSync(fixture.paths.installationDigest),
    priorDigest
  );
  assert.equal(fixture.launch.loaded, true);
});

test("status distinguishes loaded/current, degraded, and absent health", (t) => {
  const fixture = installerFixture(t);
  runInstaller(fixture.args, {
    platform: "darwin",
    launchctlRunner: fixture.launch.runner,
    initialSyncRunner: () => true
  });
  const stateFile = digestStatePath(fixture.paths.stateDir, fixture.args.repo);
  const currentAuth = fs.readFileSync(fixture.args.authPath);
  const currentDigest = crypto.createHash("sha256").update(currentAuth).digest("hex");
  fs.writeFileSync(stateFile, `${currentDigest}\n`, { mode: 0o600 });
  const statusArgs = { ...fixture.args, command: "status", ghBin: null };
  const loaded = runInstaller(statusArgs, {
    platform: "darwin",
    launchctlRunner: fixture.launch.runner
  });
  assert.equal(loaded.health, "loaded");
  assert.equal(loaded.sync, "current");

  const installedHelper = fs.readFileSync(fixture.paths.helper);
  fs.appendFileSync(fixture.paths.helper, "\n// tampered\n");
  fs.chmodSync(fixture.paths.helper, 0o600);
  const tamperedHelper = runInstaller(statusArgs, {
    platform: "darwin",
    launchctlRunner: fixture.launch.runner
  });
  assert.equal(tamperedHelper.health, "degraded");
  fs.writeFileSync(fixture.paths.helper, installedHelper, { mode: 0o600 });

  const installedPlist = fs.readFileSync(fixture.paths.plist);
  fs.appendFileSync(fixture.paths.plist, "\n<!-- tampered -->\n");
  fs.chmodSync(fixture.paths.plist, 0o600);
  const tamperedPlist = runInstaller(statusArgs, {
    platform: "darwin",
    launchctlRunner: fixture.launch.runner
  });
  assert.equal(tamperedPlist.health, "degraded");
  fs.writeFileSync(fixture.paths.plist, installedPlist, { mode: 0o600 });

  fs.writeFileSync(stateFile, `${"a".repeat(64)}\n`, { mode: 0o600 });
  const mismatched = runInstaller(statusArgs, {
    platform: "darwin",
    launchctlRunner: fixture.launch.runner
  });
  assert.equal(mismatched.sync, "pending");
  fs.writeFileSync(stateFile, `${currentDigest}\n`, { mode: 0o600 });

  fs.chmodSync(fixture.paths.stateDir, 0o755);
  const exposedState = runInstaller(statusArgs, {
    platform: "darwin",
    launchctlRunner: fixture.launch.runner
  });
  assert.equal(exposedState.sync, "pending");
  fs.chmodSync(fixture.paths.stateDir, 0o700);

  fs.writeFileSync(
    fixture.args.authPath,
    `${JSON.stringify(validPayload({
      expires_at: new Date(Date.now() - 60_000).toISOString()
    }))}\n`,
    { mode: 0o600 }
  );
  const expired = runInstaller(statusArgs, {
    platform: "darwin",
    launchctlRunner: fixture.launch.runner
  });
  assert.equal(expired.sync, "pending");
  fs.writeFileSync(fixture.args.authPath, currentAuth, { mode: 0o600 });

  fs.chmodSync(fixture.paths.helper, 0o644);
  const exposed = runInstaller(statusArgs, {
    platform: "darwin",
    launchctlRunner: fixture.launch.runner
  });
  assert.equal(exposed.health, "degraded");
  fs.chmodSync(fixture.paths.helper, 0o600);

  fixture.launch.setLoaded(false);
  const degraded = runInstaller(statusArgs, {
    platform: "darwin",
    launchctlRunner: fixture.launch.runner
  });
  assert.equal(degraded.health, "degraded");
  assert.equal(degraded.sync, "current");

  fs.unlinkSync(fixture.paths.helper);
  fs.unlinkSync(fixture.paths.plist);
  fs.unlinkSync(fixture.paths.installationDigest);
  const absent = runInstaller(statusArgs, {
    platform: "darwin",
    launchctlRunner: fixture.launch.runner
  });
  assert.equal(absent.health, "absent");
  assert.equal(absent.sync, "current");
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  fs.utimesSync(stateFile, old, old);
  const pending = runInstaller(statusArgs, {
    platform: "darwin",
    launchctlRunner: fixture.launch.runner
  });
  assert.equal(pending.health, "absent");
  assert.equal(pending.sync, "pending");
});
