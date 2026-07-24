#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  canonicalPath,
  createPluginInventory,
  describeInventoryDifference,
  digestInventory,
  digestRegularFile,
  isPathInside
} from "./lib/plugin-inventory.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ID = "grok@grok-companion";
const MARKETPLACE = "grok-companion";
const SOURCE_PLUGIN = path.join(ROOT, "plugins", "grok");
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const NPM_BIN = process.platform === "win32" ? "npm.cmd" : "npm";
const REPOSITORY_CHECK_TIMEOUT_MS = 20 * 60_000;

function fail(message, details = "") {
  const suffix = details.trim() ? `\n${details.trim()}` : "";
  throw new Error(`${message}${suffix}`);
}

function runChecked(command, args, { env = process.env, timeout = 180_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env,
    encoding: "utf8",
    shell: false,
    timeout,
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.error) fail(`Could not run ${command} ${args.join(" ")}.`, result.error.message);
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} exited with status ${result.status}.`,
      [result.stdout, result.stderr].filter(Boolean).join("\n")
    );
  }
  return result;
}

function parseJson(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`${label} did not return valid JSON.`, result.stdout || result.stderr);
  }
}

function step(message) {
  process.stdout.write(`${message}\n`);
}

function main() {
  if (process.argv.length !== 2) fail("Usage: npm run codex:update-local");
  if (process.platform === "win32") {
    fail("codex:update-local currently requires the POSIX nonblocking PTY gate; run it on macOS or Linux.");
  }

  canonicalPath(SOURCE_PLUGIN, "Source plugin");
  const packagePath = path.join(ROOT, "package.json");
  const marketplaceManifestPath = path.join(ROOT, ".agents", "plugins", "marketplace.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const testedSourceEntries = createPluginInventory(SOURCE_PLUGIN);
  const testedSourceDigest = digestInventory(testedSourceEntries);
  const testedPackageDigest = digestRegularFile(packagePath);
  const testedMarketplaceDigest = digestRegularFile(marketplaceManifestPath);
  const assertTestedInputsUnchanged = (phase) => {
    const currentSourceEntries = createPluginInventory(SOURCE_PLUGIN);
    const differences = describeInventoryDifference(testedSourceEntries, currentSourceEntries);
    if (differences.length > 0 || digestInventory(currentSourceEntries) !== testedSourceDigest) {
      fail(`Source plugin changed ${phase}; refusing to install untested bytes.`, differences.join("\n"));
    }
    if (
      digestRegularFile(packagePath) !== testedPackageDigest
      || digestRegularFile(marketplaceManifestPath) !== testedMarketplaceDigest
    ) {
      fail(`Package or Codex marketplace metadata changed ${phase}; refusing to install untested metadata.`);
    }
  };

  step("[1/4] Running the complete repository check...");
  // The deterministic inventory is intentionally serial and can exceed the
  // generic three-minute command timeout on supported laptops and CI hosts.
  // Allow five minutes of headroom over the proof producer's 15-minute gate.
  runChecked(NPM_BIN, ["run", "check"], { timeout: REPOSITORY_CHECK_TIMEOUT_MS });

  step("[2/4] Requiring the clean installed-Codex PTY regression...");
  runChecked(NPM_BIN, ["run", "test:installed-codex"], {
    env: { ...process.env, CODEX_INSTALL_E2E_REQUIRED: "1" }
  });
  assertTestedInputsUnchanged("while verification was running");

  step("[3/4] Verifying the local marketplace and refreshing the Codex cache...");
  const marketplacePayload = parseJson(
    runChecked(CODEX_BIN, ["plugin", "marketplace", "list", "--json"], { timeout: 30_000 }),
    "codex plugin marketplace list"
  );
  const marketplace = marketplacePayload.marketplaces?.find((entry) => entry.name === MARKETPLACE);
  if (!marketplace?.root) fail(`Codex marketplace ${MARKETPLACE} is not configured.`);
  const expectedMarketplaceRoot = canonicalPath(ROOT, "Repository root");
  const actualMarketplaceRoot = canonicalPath(marketplace.root, `Codex marketplace ${MARKETPLACE}`);
  if (actualMarketplaceRoot !== expectedMarketplaceRoot) {
    fail(
      `Codex marketplace ${MARKETPLACE} points at a different checkout.`,
      `expected: ${expectedMarketplaceRoot}\nactual:   ${actualMarketplaceRoot}`
    );
  }

  const installedPayload = parseJson(
    runChecked(CODEX_BIN, ["plugin", "add", PLUGIN_ID, "--json"], { timeout: 60_000 }),
    "codex plugin add"
  );
  if (!installedPayload.installedPath) fail("Codex did not report the installed cache path.");

  step("[4/4] Comparing the installed snapshot with the source plugin...");
  const pluginList = parseJson(
    runChecked(CODEX_BIN, ["plugin", "list", "--json"], { timeout: 30_000 }),
    "codex plugin list"
  );
  const installedRecord = pluginList.installed?.find((entry) => entry.pluginId === PLUGIN_ID);
  if (!installedRecord?.installed || !installedRecord.enabled) fail(`${PLUGIN_ID} is not installed and enabled after refresh.`);
  if (installedRecord.version !== packageJson.version) {
    fail(`Installed version ${installedRecord.version} does not match source version ${packageJson.version}.`);
  }

  const installedRoot = canonicalPath(installedPayload.installedPath, "Installed plugin cache");
  const codexHome = canonicalPath(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "Codex home");
  const expectedCacheRoot = path.join(codexHome, "plugins", "cache", MARKETPLACE, "grok");
  if (!isPathInside(expectedCacheRoot, installedRoot)) {
    fail("Codex reported an installed path outside the expected plugin cache.", installedRoot);
  }
  const installedEntries = createPluginInventory(installedPayload.installedPath);
  const differences = describeInventoryDifference(testedSourceEntries, installedEntries);
  if (differences.length > 0) {
    fail(
      "Installed Codex snapshot does not match the source plugin.",
      differences.join("\n")
    );
  }
  const installedDigest = digestInventory(installedEntries);
  if (testedSourceDigest !== installedDigest) fail("Installed snapshot digest does not match the tested source digest.");
  assertTestedInputsUnchanged("during installation");

  process.stdout.write([
    "Local Codex plugin update passed.",
    `  plugin:  ${PLUGIN_ID}`,
    `  version: ${packageJson.version}`,
    `  files:   ${testedSourceEntries.length}`,
    `  digest:  ${testedSourceDigest}`,
    `  cache:   ${installedRoot}`,
    "Start a new Codex task before testing the update. Existing tasks may retain old skill text while resolving refreshed runtime paths and must not be used for qualification."
  ].join("\n") + "\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`Local Codex plugin update failed: ${error.message}\n`);
  process.exitCode = 1;
}
