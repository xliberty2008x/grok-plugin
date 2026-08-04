import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  captureExecutableFileIdentity
} from "../plugins/grok/scripts/lib/executable-identity.mjs";
import {
  publishProviderExecutablePin
} from "../plugins/grok/scripts/lib/provider-executable-pin.mjs";
import { ROOT, tempDir } from "./helpers.mjs";

const OFFICIAL_RELEASE_LIST_MARKER =
  "export const OFFICIAL_GROK_RELEASES = Object.freeze([\n";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function fakeOfficialRelease(fileIdentity) {
  return Object.freeze({
    releaseSource: "official-package-pin-v1",
    packageName: "@xai-official/grok",
    packageVersion: "0.2.99",
    packageGitHead: "9".repeat(40),
    packageIntegrityDigest: "3".repeat(64),
    platform: process.platform,
    arch: process.arch,
    version: "0.2.99",
    buildCommit: "9bbd559437aa",
    channel: "stable",
    size: fileIdentity.size,
    executableDigest: fileIdentity.executableDigest
  });
}

export function installPinnedFakeCompanion(
  fake,
  env,
  { installedPluginRoot = null } = {}
) {
  assert.equal(
    fs.existsSync("/bin/bash"),
    true,
    "pinned fake-provider setup fixtures require /bin/bash"
  );
  const providerShell = fs.realpathSync("/bin/bash");
  const wrapper = path.join(path.dirname(fake.binary), "fake-grok-provider.sh");
  fs.writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      "child=",
      "forward_term() {",
      '  if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null || true; fi',
      "}",
      "trap forward_term TERM INT HUP",
      `${shellQuote(process.execPath)} ${shellQuote(fake.binary)} "$@" <&0 >&1 2>&2 &`,
      "child=$!",
      'wait "$child"',
      "status=$?",
      'while kill -0 "$child" 2>/dev/null; do',
      '  wait "$child"',
      "  status=$?",
      "done",
      "trap - TERM INT HUP",
      'exit "$status"',
      ""
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 }
  );

  const release = fakeOfficialRelease(
    captureExecutableFileIdentity(providerShell)
  );
  const pinnedEnv = {
    ...env,
    GROK_BIN: providerShell,
    GROK_AUTH_PATH: fake.authPath
  };
  publishProviderExecutablePin({
    env: pinnedEnv,
    releases: [release],
    sourceBinary: providerShell
  });

  const copyRoot = installedPluginRoot == null
    ? tempDir("grok-pinned-setup-plugin-")
    : null;
  const pluginRoot = installedPluginRoot == null
    ? path.join(copyRoot, "grok")
    : fs.realpathSync(installedPluginRoot);
  if (installedPluginRoot == null) {
    fs.cpSync(path.join(ROOT, "plugins", "grok"), pluginRoot, {
      recursive: true
    });
  } else {
    assert.notEqual(
      pluginRoot,
      fs.realpathSync(path.join(ROOT, "plugins", "grok")),
      "the installed fake-provider fixture must never patch the source plugin"
    );
  }

  const executableIdentityFile = path.join(
    pluginRoot,
    "scripts",
    "lib",
    "executable-identity.mjs"
  );
  const executableIdentitySource = fs.readFileSync(
    executableIdentityFile,
    "utf8"
  );
  assert.equal(
    executableIdentitySource.split(OFFICIAL_RELEASE_LIST_MARKER).length,
    2,
    "setup fixture must patch one exact official release list"
  );
  fs.writeFileSync(
    executableIdentityFile,
    executableIdentitySource.replace(
      OFFICIAL_RELEASE_LIST_MARKER,
      `${OFFICIAL_RELEASE_LIST_MARKER}  Object.freeze(${JSON.stringify(release)}),\n`
    ),
    "utf8"
  );

  const providerFile = path.join(
    pluginRoot,
    "scripts",
    "lib",
    "grok-provider.mjs"
  );
  let providerSource = fs.readFileSync(providerFile, "utf8");
  const providerCoreFile = path.join(
    pluginRoot,
    "scripts",
    "lib",
    "provider-core.mjs"
  );
  let providerCoreSource = fs.readFileSync(providerCoreFile, "utf8");
  const wrapperLiteral = JSON.stringify(wrapper);
  const versionNeedle = 'spawnSync(binary, ["--version"],';
  assert.equal(
    providerCoreSource.split(versionNeedle).length - 1,
    1,
    `setup fixture provider command inventory drifted: provider-core.mjs:${versionNeedle}`
  );
  providerCoreSource = providerCoreSource.replace(
    versionNeedle,
    `spawnSync(binary, [${wrapperLiteral}, "--version"],`
  );
  const replacements = [
    [
      'spawnSync(binary, ["inspect", "--json"],',
      `spawnSync(binary, [${wrapperLiteral}, "inspect", "--json"],`
    ],
    [
      'const args = ["--cwd", root,',
      `const args = [${wrapperLiteral}, "--cwd", root,`
    ],
    [
      'spawnSync(binary, ["--help"],',
      `spawnSync(binary, [${wrapperLiteral}, "--help"],`
    ],
    [
      'spawnSync(binary, ["agent", "--help"],',
      `spawnSync(binary, [${wrapperLiteral}, "agent", "--help"],`
    ],
    [
      'spawnSync(binary, ["models"],',
      `spawnSync(binary, [${wrapperLiteral}, "models"],`
    ]
  ];
  for (const [needle, replacement] of replacements) {
    const expectedOccurrences = needle === 'const args = ["--cwd", root,'
      ? 2
      : 1;
    assert.equal(
      providerSource.split(needle).length - 1,
      expectedOccurrences,
      `setup fixture provider command inventory drifted: ${needle}`
    );
    providerSource = providerSource.replaceAll(needle, replacement);
  }
  fs.writeFileSync(providerCoreFile, providerCoreSource, "utf8");
  fs.writeFileSync(providerFile, providerSource, "utf8");

  return Object.freeze({
    pluginRoot,
    companionScript: path.join(
      pluginRoot,
      "scripts",
      "grok-companion.mjs"
    ),
    codexCompanionScript: path.join(
      pluginRoot,
      "scripts",
      "grok-codex.mjs"
    ),
    env: pinnedEnv,
    cleanup() {
      if (copyRoot) {
        fs.rmSync(copyRoot, { recursive: true, force: true, maxRetries: 3 });
      }
    }
  });
}
