import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  assertExecutableAttestation,
  attestSpawnedExecutable,
  captureExecutableFileIdentity,
  captureGrokExecutableIdentity,
  createExecutableAttestation,
  materializePinnedGrokExecutable,
  sameExecutableAttestation
} from "../plugins/grok/scripts/lib/executable-identity.mjs";

function executableFixture(t, body = "#!/bin/sh\nexit 0\n") {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "grok-executable-identity-")
  );
  const binary = path.join(directory, "grok");
  fs.writeFileSync(binary, body, { mode: 0o700 });
  fs.chmodSync(binary, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return binary;
}

function releaseFor(fileIdentity, overrides = {}) {
  return {
    releaseSource: "official-package-pin-v1",
    packageName: "@xai-official/grok",
    packageVersion: "0.2.112",
    packageGitHead: "9".repeat(40),
    packageIntegrityDigest: "3".repeat(64),
    platform: process.platform,
    arch: process.arch,
    version: "0.2.112",
    buildCommit: "9bbd559437aa",
    channel: "stable",
    size: fileIdentity.size,
    executableDigest: fileIdentity.executableDigest,
    ...overrides
  };
}

test("Grok executable identity binds exact bytes to one official package pin", (t) => {
  const binary = executableFixture(t);
  const fileIdentity = captureExecutableFileIdentity(binary);
  const captured = captureGrokExecutableIdentity(binary, {
    releases: [releaseFor(fileIdentity)]
  });
  const attestation = assertExecutableAttestation(captured.attestation);

  assert.equal(attestation.version, "0.2.112");
  assert.equal(attestation.buildCommit, "9bbd559437aa");
  assert.equal(attestation.channel, "stable");
  assert.equal(attestation.packageName, "@xai-official/grok");
  assert.equal(attestation.packageVersion, "0.2.112");
  assert.equal(attestation.size, fs.statSync(binary).size);
  assert.match(attestation.executableDigest, /^[a-f0-9]{64}$/);
  assert.match(attestation.identityDigest, /^[a-f0-9]{64}$/);
  for (const privateField of [
    "canonicalPath",
    "device",
    "inode",
    "mode",
    "mtimeMs"
  ]) {
    assert.equal(Object.hasOwn(attestation, privateField), false);
  }
});

test("same-size in-place replacement is rejected by the official package pin", (t) => {
  const initial = "#!/bin/sh\nexit 0\n";
  const replacement = "#!/bin/sh\nexit 1\n";
  assert.equal(Buffer.byteLength(initial), Buffer.byteLength(replacement));
  const binary = executableFixture(t, initial);
  const pinned = captureExecutableFileIdentity(binary);

  fs.writeFileSync(binary, replacement, { mode: 0o700 });
  fs.chmodSync(binary, 0o700);
  assert.throws(
    () => captureGrokExecutableIdentity(binary, {
      releases: [releaseFor(pinned)]
    }),
    (error) => error?.code === "E_GROK_VERSION"
  );
});

test("atomic path replacement is rejected by the official package pin", (t) => {
  const initial = "#!/bin/sh\nexit 0\n";
  const replacement = "#!/bin/sh\nexit 1\n";
  const binary = executableFixture(t, initial);
  const pinned = captureExecutableFileIdentity(binary);
  const replacementPath = path.join(path.dirname(binary), "replacement");
  fs.writeFileSync(replacementPath, replacement, { mode: 0o700 });
  fs.chmodSync(replacementPath, 0o700);
  fs.renameSync(replacementPath, binary);

  assert.throws(
    () => captureGrokExecutableIdentity(binary, {
      releases: [releaseFor(pinned)]
    }),
    (error) => error?.code === "E_GROK_VERSION"
  );
});

test("unknown executable bytes are rejected without executing the discovery path", (t) => {
  const binary = executableFixture(t);
  assert.throws(
    () => captureGrokExecutableIdentity(binary),
    (error) => error?.code === "E_GROK_VERSION"
  );
});

test("private materialization copies pinned bytes without executing the source", (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(
    path.join(os.tmpdir(), "grok-materialization-parent-")
  ));
  const marker = path.join(directory, "executed");
  const binary = executableFixture(
    t,
    `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\n`
  );
  const pinned = captureExecutableFileIdentity(binary);
  const launchDirectory = path.join(directory, "provider-bin");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const materialized = materializePinnedGrokExecutable(binary, {
    directory: launchDirectory,
    releases: [releaseFor(pinned)]
  });

  assert.equal(fs.existsSync(marker), false);
  assert.equal(path.dirname(materialized.canonicalPath), launchDirectory);
  assert.equal(materialized.executableDigest, pinned.executableDigest);
  assert.equal(materialized.size, pinned.size);
  assert.equal(fs.statSync(launchDirectory).mode & 0o077, 0);
  assert.equal(fs.statSync(materialized.canonicalPath).mode & 0o777, 0o500);
});

test("private materialization removes its launch directory when pinning fails", (t) => {
  const parent = fs.realpathSync(fs.mkdtempSync(
    path.join(os.tmpdir(), "grok-materialization-failure-")
  ));
  const binary = executableFixture(t);
  const launchDirectory = path.join(parent, "provider-bin");
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));

  assert.throws(
    () => materializePinnedGrokExecutable(binary, {
      directory: launchDirectory,
      releases: []
    }),
    (error) => error?.code === "E_GROK_VERSION"
  );
  assert.equal(fs.existsSync(launchDirectory), false);
});

test("spawned executable attestation proves the current kernel mapping", () => {
  const fileIdentity = captureExecutableFileIdentity(process.execPath);
  const attestation = createExecutableAttestation(
    fileIdentity,
    releaseFor(fileIdentity)
  );
  const expected = {
    ...fileIdentity,
    attestation
  };

  if (process.platform === "darwin" || process.platform === "linux") {
    assert.equal(attestSpawnedExecutable(process.pid, expected), attestation);
  } else {
    assert.throws(
      () => attestSpawnedExecutable(process.pid, expected),
      (error) => error?.code === "E_CAPABILITY"
    );
  }
});

test("spawned executable and durable attestation mismatches fail closed", (t) => {
  const otherBinary = executableFixture(t);
  const otherIdentity = captureExecutableFileIdentity(otherBinary);
  const otherAttestation = createExecutableAttestation(
    otherIdentity,
    releaseFor(otherIdentity)
  );

  if (process.platform === "darwin" || process.platform === "linux") {
    assert.throws(
      () => attestSpawnedExecutable(process.pid, {
        ...otherIdentity,
        attestation: otherAttestation
      }),
      (error) => error?.code === "E_PROCESS_IDENTITY"
    );
  }
  assert.equal(sameExecutableAttestation(
    otherAttestation,
    { ...otherAttestation, version: "0.2.111" }
  ), false);
});
