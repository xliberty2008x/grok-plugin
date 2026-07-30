import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  MCP_CAPABILITY_CONTRACT_VERSION,
  ORDERED_TURN_BOUNDARY_MAILBOX_PROVIDER_CAPABILITY,
  ROOT_READ_PROVIDER_CAPABILITY,
  SAME_SESSION_READ_FOLLOWUP_PROVIDER_CAPABILITY,
  clearProviderCapabilityReceipt,
  readValidProviderCapabilityReceipt,
  writeProviderCapabilityReceipt
} from "../plugins/grok/scripts/lib/provider-capability.mjs";
import {
  captureExecutableFileIdentity
} from "../plugins/grok/scripts/lib/executable-identity.mjs";
import {
  discoverManagedRawGrokExecutable,
  providerLaunchBindingDigest,
  publishProviderExecutablePin,
  resolveProviderExecutablePin
} from "../plugins/grok/scripts/lib/provider-executable-pin.mjs";
import { installFakeGrok } from "./fake-grok.mjs";
import { ROOT, tempDir } from "./helpers.mjs";

const RECEIPT_RELATIVE_PATH = path.join(
  "capabilities",
  "provider-capability-v2.json"
);
const PINNED_PROVIDER_VERSION = "0.2.99";

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Test-only POSIX executable for capability pin/lifecycle tests.
 * Production grokVersion spawns the extensionless pin with shell:false; a
 * tiny shell script remains executable after pin copying and avoids Node 18
 * treating an extensionless JavaScript double as CommonJS.
 */
function installVersionCapableProvider(
  directory,
  version = PINNED_PROVIDER_VERSION,
  {
    buildCommit = "managed-test-build",
    channel = "stable"
  } = {}
) {
  if (process.platform === "win32") {
    throw new Error("Provider capability pin fixtures currently target POSIX runners.");
  }
  assert.equal(fs.existsSync("/bin/sh"), true, "version-capable provider requires /bin/sh");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const binary = path.join(directory, "grok");
  fs.writeFileSync(
    binary,
    [
      "#!/bin/sh",
      `if [ "$1" = "--version" ]; then`,
      `  printf '%s\\n' "grok ${version}${buildCommit ? ` (${buildCommit})` : ""}${channel ? ` [${channel}]` : ""}"`,
      "  exit 0",
      "fi",
      "exit 1",
      ""
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 }
  );
  fs.chmodSync(binary, 0o700);
  return { binary, version };
}

function donorPlatformName(platform) {
  return platform === "darwin" ? "macos" : platform;
}

function donorArchitectureName(arch) {
  if (arch === "arm64") return "aarch64";
  if (arch === "x64") return "x86_64";
  return arch;
}

function installManagedProvider(version, {
  installer = "internal",
  targetDirectory = null,
  buildCommit = "managed-test-build",
  channel = "stable"
} = {}) {
  const home = tempDir("grok-managed-home-");
  const grokHome = path.join(home, ".grok");
  const bin = path.join(grokHome, "bin");
  const managedDirectory = targetDirectory || (
    installer === "internal" ? path.join(grokHome, "downloads") : bin
  );
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  fs.mkdirSync(managedDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(grokHome, "config.toml"),
    `[cli]\ninstaller = "${installer}"\n`,
    { mode: 0o600 }
  );
  const targetName = installer === "internal"
    ? `grok-${version}-${donorPlatformName(process.platform)}-${donorArchitectureName(process.arch)}`
    : `grok-${version}`;
  const installed = installVersionCapableProvider(
    managedDirectory,
    version,
    { buildCommit, channel }
  );
  const target = path.join(managedDirectory, targetName);
  fs.renameSync(installed.binary, target);
  fs.symlinkSync(path.relative(bin, target), path.join(bin, "grok"));
  return {
    home,
    grokHome,
    active: path.join(bin, "grok"),
    target,
    env: {
      HOME: home,
      GROK_HOME: grokHome,
      PATH: "",
      PLUGIN_DATA: tempDir("grok-managed-data-"),
      GROK_COMPANION_HOST: "codex"
    }
  };
}

function releaseFor(fileIdentity, version = PINNED_PROVIDER_VERSION) {
  return Object.freeze({
    releaseSource: "official-package-pin-v1",
    packageName: "@xai-official/grok",
    packageVersion: version,
    packageGitHead: "9".repeat(40),
    packageIntegrityDigest: "3".repeat(64),
    platform: process.platform,
    arch: process.arch,
    version,
    buildCommit: "9bbd559437aa",
    channel: "stable",
    size: fileIdentity.size,
    executableDigest: fileIdentity.executableDigest
  });
}

function fixture() {
  const provider = installVersionCapableProvider(
    tempDir("grok-provider-capability-bin-")
  );
  const pluginData = tempDir("grok-provider-capability-data-");
  const env = {
    HOME: path.dirname(pluginData),
    PATH: path.dirname(provider.binary),
    PLUGIN_DATA: pluginData,
    GROK_COMPANION_HOST: "codex"
  };
  const release = releaseFor(captureExecutableFileIdentity(provider.binary));
  const pinned = publishProviderExecutablePin({
    env,
    releases: [release],
    sourceBinary: provider.binary,
    clock: () => Date.parse("2026-07-23T09:59:00.000Z")
  });
  const runtime = {
    binary: pinned.binary,
    version: release.version,
    authenticated: true,
    protocolVersion: 1,
    loadSession: true,
    acpIsolation: {
      isolated: true,
      unattendedPrivilegeExpansion: false,
      agentProfileDigest: sha256(
        path.join(ROOT, "plugins/grok/provider-agents/setup-probe.md")
      )
    }
  };
  return {
    provider,
    pluginData,
    env,
    release,
    releases: [release],
    pinned,
    runtime,
    receiptFile: path.join(pluginData, RECEIPT_RELATIVE_PATH)
  };
}

function writeReceipt(state, options = {}) {
  return writeProviderCapabilityReceipt({
    runtime: state.runtime,
    providerLaunchBinding: state.pinned.binding,
    env: state.env,
    releases: state.releases,
    ...options
  });
}

function readReceipt(state, options = {}) {
  return readValidProviderCapabilityReceipt({
    env: state.env,
    releases: state.releases,
    ...options
  });
}

test("setup discovery resolves an npm trampoline to managed raw native bytes", () => {
  const fake = installFakeGrok(tempDir("grok-provider-npm-raw-"));
  const home = tempDir("grok-provider-npm-home-");
  const grokHome = path.join(home, ".grok");
  const managedDirectory = path.join(grokHome, "bin");
  fs.mkdirSync(managedDirectory, { recursive: true, mode: 0o700 });
  const managed = path.join(managedDirectory, "grok-0.2.99");
  fs.copyFileSync(fake.binary, managed);
  fs.chmodSync(managed, 0o700);
  fs.symlinkSync("grok-0.2.99", path.join(managedDirectory, "grok"));

  const packageRoot = path.join(
    tempDir("grok-provider-npm-prefix-"),
    "node_modules",
    "@xai-official",
    "grok"
  );
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "@xai-official/grok", version: "0.2.99" })
  );
  const trampoline = path.join(packageRoot, "bin", "grok");
  fs.writeFileSync(trampoline, "#!/usr/bin/env node\nprocess.exit(91);\n", {
    mode: 0o700
  });
  fs.chmodSync(trampoline, 0o700);

  const release = releaseFor(captureExecutableFileIdentity(managed));
  const discovered = discoverManagedRawGrokExecutable({
    env: {
      HOME: home,
      GROK_HOME: grokHome,
      GROK_BIN: trampoline,
      PATH: ""
    },
    releases: [release]
  });
  assert.equal(discovered.canonicalPath, fs.realpathSync(managed));
  assert.notEqual(discovered.canonicalPath, fs.realpathSync(trampoline));
});

test("future active managed Grok pins as schema v2 and raw/symlink observations agree", () => {
  const managed = installManagedProvider("0.2.114");
  const viaLink = discoverManagedRawGrokExecutable({
    env: { ...managed.env, GROK_BIN: managed.active },
    releases: []
  });
  const viaRaw = discoverManagedRawGrokExecutable({
    env: { ...managed.env, GROK_BIN: managed.target },
    releases: []
  });
  assert.equal(viaLink.attestation.schemaVersion, 2);
  assert.equal(viaLink.attestation.releaseRecognition, "managed-observed");
  assert.equal(
    viaLink.attestation.releaseIdentityDigest,
    viaRaw.attestation.releaseIdentityDigest
  );

  const pinned = publishProviderExecutablePin({
    env: managed.env,
    releases: [],
    sourceBinary: managed.target
  });
  assert.equal(pinned.releaseRecognition, "managed-observed");
  assert.equal(pinned.executableIdentity.schemaVersion, 2);
  assert.equal(pinned.executableIdentity.buildCommit, "managed-test-build");
  const resolved = resolveProviderExecutablePin(pinned.binding, {
    env: managed.env,
    releases: []
  });
  assert.equal(
    resolved.executableIdentity.sourceProvenanceDigest,
    viaRaw.attestation.sourceProvenanceDigest
  );
  assert.equal(
    resolved.executableIdentity.executableDigest,
    viaRaw.attestation.executableDigest
  );
  const reused = publishProviderExecutablePin({
    env: managed.env,
    releases: [],
    sourceBinary: managed.active
  });
  assert.equal(reused.reused, true);
  assert.equal(
    reused.executableIdentity.identityDigest,
    pinned.executableIdentity.identityDigest
  );
  const runtime = {
    binary: pinned.binary,
    version: "0.2.114",
    authenticated: true,
    protocolVersion: 1,
    loadSession: true,
    acpIsolation: {
      isolated: true,
      unattendedPrivilegeExpansion: false,
      agentProfileDigest: sha256(
        path.join(ROOT, "plugins/grok/provider-agents/setup-probe.md")
      )
    }
  };
  const observedAt = Date.parse("2026-07-30T10:00:00.000Z");
  const receipt = writeProviderCapabilityReceipt({
    runtime,
    providerLaunchBinding: pinned.binding,
    env: managed.env,
    releases: [],
    clock: () => observedAt
  });
  assert.equal(receipt.providerVersion, "0.2.114");
  assert.ok(readValidProviderCapabilityReceipt({
    env: managed.env,
    releases: [],
    clock: () => observedAt + 1
  }));
});

test("future npm-managed Grok and unbounded stable SemVer components pin as schema v2", () => {
  for (const [version, installer] of [
    ["0.2.115", "npm"],
    ["9999999999.2.114", "internal"]
  ]) {
    const managed = installManagedProvider(version, { installer });
    const discovered = discoverManagedRawGrokExecutable({
      env: managed.env,
      releases: []
    });
    assert.equal(discovered.attestation.schemaVersion, 2);
    assert.equal(discovered.attestation.releaseRecognition, "managed-observed");
    assert.equal(discovered.attestation.version, version);
    assert.equal(discovered.canonicalPath, fs.realpathSync(managed.target));

    const pinned = publishProviderExecutablePin({
      env: managed.env,
      releases: [],
      sourceBinary: managed.active
    });
    assert.equal(pinned.releaseRecognition, "managed-observed");
    assert.equal(pinned.executableIdentity.version, version);
    assert.equal(pinned.executableIdentity.buildCommit, "managed-test-build");
    assert.equal(
      resolveProviderExecutablePin(pinned.binding, {
        env: managed.env,
        releases: []
      }).executableIdentity.identityDigest,
      pinned.executableIdentity.identityDigest
    );
  }
});

test("managed discovery rejects arbitrary, escaped, prerelease, old, and malformed versions", () => {
  const arbitrary = installVersionCapableProvider(
    tempDir("grok-unmanaged-provider-"),
    "0.2.114"
  );
  assert.throws(
    () => discoverManagedRawGrokExecutable({
      env: {
        HOME: tempDir("grok-unmanaged-home-"),
        GROK_BIN: arbitrary.binary,
        PATH: ""
      },
      releases: []
    }),
    (error) => error?.code === "E_GROK_SOURCE"
  );

  const escapedDirectory = tempDir("grok-managed-escaped-");
  const escaped = installManagedProvider("0.2.114", {
    targetDirectory: escapedDirectory
  });
  fs.symlinkSync(
    escapedDirectory,
    path.join(escaped.grokHome, "downloads")
  );
  assert.throws(
    () => discoverManagedRawGrokExecutable({
      env: escaped.env,
      releases: []
    }),
    (error) => error?.code === "E_GROK_SOURCE"
  );

  const stale = installManagedProvider("0.2.114");
  fs.unlinkSync(stale.target);
  assert.throws(
    () => discoverManagedRawGrokExecutable({
      env: stale.env,
      releases: []
    }),
    (error) => error?.code === "E_GROK_SOURCE"
  );

  for (const version of [
    "0.2.98",
    "0.2.114-alpha",
    "00.2.114"
  ]) {
    const invalid = installManagedProvider(version);
    assert.throws(
      () => discoverManagedRawGrokExecutable({
        env: invalid.env,
        releases: []
      }),
      (error) => error?.code === "E_GROK_VERSION",
      version
    );
  }
});

test("known-version managed digest mismatch fails process identity", () => {
  const managed = installManagedProvider("0.2.114");
  const fileIdentity = captureExecutableFileIdentity(managed.target);
  const mismatched = releaseFor({
    ...fileIdentity,
    executableDigest: "f".repeat(64)
  }, "0.2.114");
  assert.throws(
    () => discoverManagedRawGrokExecutable({
      env: managed.env,
      releases: [mismatched]
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
  );
});

test("managed discovery rejects unsafe layout permissions and source races", () => {
  const unsafe = installManagedProvider("0.2.114");
  const unsafeBin = path.dirname(unsafe.active);
  fs.chmodSync(unsafeBin, 0o777);
  assert.throws(
    () => discoverManagedRawGrokExecutable({
      env: unsafe.env,
      releases: []
    }),
    (error) => error?.code === "E_GROK_SOURCE"
  );
  fs.chmodSync(unsafeBin, 0o700);

  const raced = installManagedProvider("0.2.114");
  const targetDirectory = path.dirname(raced.target);
  const replacement = installVersionCapableProvider(
    targetDirectory,
    "0.2.115"
  );
  const replacementTarget = path.join(
    targetDirectory,
    `grok-0.2.115-${donorPlatformName(process.platform)}-${donorArchitectureName(process.arch)}`
  );
  fs.renameSync(replacement.binary, replacementTarget);
  const originalReadSync = fs.readSync;
  let executableReads = 0;
  fs.readSync = (...args) => {
    const result = originalReadSync(...args);
    executableReads += 1;
    if (executableReads === 2) {
      fs.unlinkSync(raced.active);
      fs.symlinkSync(
        path.relative(path.dirname(raced.active), replacementTarget),
        raced.active
      );
    }
    return result;
  };
  try {
    assert.throws(
      () => discoverManagedRawGrokExecutable({
        env: raced.env,
        releases: []
      }),
      (error) => error?.code === "E_PROCESS_IDENTITY"
    );
  } finally {
    fs.readSync = originalReadSync;
  }

  const dangling = installManagedProvider("0.2.114");
  const originalReadlinkSync = fs.readlinkSync;
  let managedLinkReads = 0;
  fs.readlinkSync = (...args) => {
    const result = originalReadlinkSync(...args);
    managedLinkReads += 1;
    if (managedLinkReads === 3) fs.unlinkSync(dangling.target);
    return result;
  };
  try {
    assert.throws(
      () => discoverManagedRawGrokExecutable({
        env: dangling.env,
        releases: []
      }),
      (error) => error?.code === "E_PROCESS_IDENTITY"
    );
  } finally {
    fs.readlinkSync = originalReadlinkSync;
  }
});

test("managed pin requires an observed build identity and stable channel", () => {
  for (const metadata of [
    { buildCommit: null, channel: "stable" },
    { buildCommit: "managed-test-build", channel: null },
    { buildCommit: "managed-test-build", channel: "alpha" }
  ]) {
    const managed = installManagedProvider("0.2.114", metadata);
    assert.throws(
      () => publishProviderExecutablePin({
        env: managed.env,
        releases: [],
        sourceBinary: managed.active
      }),
      (error) => error?.code === "E_GROK_VERSION"
    );
    assert.equal(
      fs.existsSync(path.join(managed.env.PLUGIN_DATA, "provider-launch", "records")),
      true
    );
    assert.deepEqual(
      fs.readdirSync(
        path.join(managed.env.PLUGIN_DATA, "provider-launch", "records")
      ),
      []
    );
    assert.deepEqual(
      fs.readdirSync(
        path.join(managed.env.PLUGIN_DATA, "provider-launch", "pins")
      ),
      []
    );
  }
});

test("an existing Grok home without an active candidate is not found", () => {
  const home = tempDir("grok-empty-home-");
  const grokHome = path.join(home, ".grok");
  fs.mkdirSync(grokHome, { mode: 0o700 });
  assert.throws(
    () => discoverManagedRawGrokExecutable({
      env: {
        HOME: home,
        GROK_HOME: grokHome,
        PATH: ""
      },
      releases: []
    }),
    (error) => error?.code === "E_GROK_NOT_FOUND"
  );
});

test("provider capability v2 is path-free, pin-bound, tamper-evident, and durably clearable", (t) => {
  const state = fixture();
  const issuedAt = Date.parse("2026-07-23T10:00:00.000Z");
  const receipt = writeReceipt(state, { clock: () => issuedAt });

  assert.equal(receipt.schemaVersion, 2);
  assert.deepEqual(receipt.capabilities, [
    ROOT_READ_PROVIDER_CAPABILITY,
    SAME_SESSION_READ_FOLLOWUP_PROVIDER_CAPABILITY,
    ORDERED_TURN_BOUNDARY_MAILBOX_PROVIDER_CAPABILITY
  ]);
  assert.equal(
    receipt.providerLaunchBindingDigest,
    providerLaunchBindingDigest(receipt.providerLaunchBinding)
  );
  assert.equal(receipt.mcpCapabilityContractVersion, MCP_CAPABILITY_CONTRACT_VERSION);
  assert.equal(fs.lstatSync(state.receiptFile).mode & 0o077, 0);
  const serialized = fs.readFileSync(state.receiptFile, "utf8");
  for (const forbidden of [
    state.provider.binary,
    state.pinned.binary,
    "binaryPath",
    "auth",
    "credential",
    "prompt",
    "models"
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(Object.keys(receipt.providerLaunchBinding).sort(), [
    "executableIdentityDigest",
    "pinRecordDigest",
    "pinRef",
    "releaseIdentityDigest",
    "schemaVersion"
  ]);

  assert.equal(
    readReceipt(state, { clock: () => issuedAt + 1000 })?.capabilityDigest,
    receipt.capabilityDigest
  );

  const stored = JSON.parse(serialized);
  stored.providerLaunchBindingDigest = "f".repeat(64);
  fs.writeFileSync(state.receiptFile, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
  assert.equal(readReceipt(state, { clock: () => issuedAt + 1000 }), null);

  writeReceipt(state, { clock: () => issuedAt });
  let directoryFsyncObserved = process.platform === "win32";
  const originalFsync = fs.fsyncSync;
  fs.fsyncSync = (descriptor) => {
    if (fs.fstatSync(descriptor).isDirectory()) directoryFsyncObserved = true;
    return originalFsync(descriptor);
  };
  t.after(() => { fs.fsyncSync = originalFsync; });
  assert.equal(clearProviderCapabilityReceipt({ env: state.env }), true);
  assert.equal(fs.existsSync(state.receiptFile), false);
  assert.equal(readReceipt(state, { clock: () => issuedAt + 1000 }), null);
  assert.equal(directoryFsyncObserved, true);
  assert.equal(clearProviderCapabilityReceipt({ env: state.env }), false);
});

test("provider capability v2 fails closed on expiry, v1, and bound identity drift", () => {
  const state = fixture();
  const issuedAt = Date.parse("2026-07-23T10:00:00.000Z");
  const receipt = writeReceipt(state, {
    clock: () => issuedAt,
    ttlMs: 60_000
  });
  const validOptions = { clock: () => issuedAt + 1000 };
  assert.ok(readReceipt(state, validOptions));

  const driftCases = [
    { clock: () => issuedAt + 60_000 },
    { pluginVersion: "0.3.0-drift" },
    { mcpCapabilityContractVersion: "999.0.0" },
    { platform: `${process.platform}-drift` },
    { architecture: `${process.arch}-drift` },
    { setupProfileDigest: "a".repeat(64) },
    { rootReadProfileDigest: "b".repeat(64) },
    {
      resolvePin: (binding, options) => {
        const resolved = resolveProviderExecutablePin(binding, options);
        return {
          ...resolved,
          executableIdentity: {
            ...resolved.executableIdentity,
            version: "9.9.9"
          }
        };
      }
    }
  ];
  for (const drift of driftCases) {
    assert.equal(
      readReceipt(state, { ...validOptions, ...drift }),
      null,
      JSON.stringify(Object.keys(drift))
    );
  }

  const stored = JSON.parse(fs.readFileSync(state.receiptFile, "utf8"));
  stored.schemaVersion = 1;
  fs.writeFileSync(state.receiptFile, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
  assert.equal(readReceipt(state, validOptions), null);
  assert.equal(receipt.mcpCapabilityContractVersion, MCP_CAPABILITY_CONTRACT_VERSION);
});

test("historical schema-v1 pin replay does not require its release-table row", () => {
  const state = fixture();
  const resolved = resolveProviderExecutablePin(state.pinned.binding, {
    env: state.env,
    releases: []
  });
  assert.equal(resolved.executableIdentity.schemaVersion, 1);
  assert.equal(
    resolved.executableIdentity.identityDigest,
    state.pinned.executableIdentity.identityDigest
  );
});

test("provider capability rejects reordered, duplicated, and extra capability entries", () => {
  const state = fixture();
  const issuedAt = Date.parse("2026-07-23T10:00:00.000Z");
  const cases = [
    [ROOT_READ_PROVIDER_CAPABILITY],
    [
      SAME_SESSION_READ_FOLLOWUP_PROVIDER_CAPABILITY,
      ORDERED_TURN_BOUNDARY_MAILBOX_PROVIDER_CAPABILITY,
      ROOT_READ_PROVIDER_CAPABILITY
    ],
    [
      ROOT_READ_PROVIDER_CAPABILITY,
      SAME_SESSION_READ_FOLLOWUP_PROVIDER_CAPABILITY,
      ORDERED_TURN_BOUNDARY_MAILBOX_PROVIDER_CAPABILITY,
      ORDERED_TURN_BOUNDARY_MAILBOX_PROVIDER_CAPABILITY
    ],
    [
      ROOT_READ_PROVIDER_CAPABILITY,
      SAME_SESSION_READ_FOLLOWUP_PROVIDER_CAPABILITY,
      ORDERED_TURN_BOUNDARY_MAILBOX_PROVIDER_CAPABILITY,
      "unexpected-provider-capability"
    ]
  ];
  for (const capabilities of cases) {
    writeReceipt(state, { clock: () => issuedAt });
    const stored = JSON.parse(fs.readFileSync(state.receiptFile, "utf8"));
    stored.capabilities = capabilities;
    fs.writeFileSync(state.receiptFile, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
    assert.equal(
      readReceipt(state, { clock: () => issuedAt + 1000 }),
      null,
      JSON.stringify(capabilities)
    );
  }
});

test("pinned file replacement invalidates both binding resolution and capability", () => {
  const state = fixture();
  const observedAt = Date.now();
  writeReceipt(state, { clock: () => observedAt });
  assert.ok(readReceipt(state, { clock: () => observedAt + 1 }));
  fs.chmodSync(state.pinned.binary, 0o700);
  fs.appendFileSync(state.pinned.binary, "\n// provider identity drift\n");
  assert.equal(readReceipt(state, { clock: () => observedAt + 2 }), null);
  assert.throws(
    () => resolveProviderExecutablePin(state.pinned.binding, {
      env: state.env,
      releases: state.releases
    }),
    (error) => ["E_STATE", "E_PROCESS_IDENTITY", "E_GROK_VERSION"].includes(error?.code)
  );
});
