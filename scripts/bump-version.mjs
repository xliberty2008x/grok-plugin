#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { activeVersionForPlan, validateReleasePlan } from "./lib/version-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [nextVersion, ...flags] = process.argv.slice(2);
const dryRun = flags.includes("--dry-run");
const invalidFlags = flags.filter((flag) => flag !== "--dry-run");

if (!nextVersion || invalidFlags.length || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(nextVersion)) {
  process.stderr.write("Usage: node scripts/bump-version.mjs <semver> [--dry-run]\n");
  process.exit(2);
}

function file(relative) {
  return path.join(ROOT, relative);
}

function readJson(relative) {
  return JSON.parse(fs.readFileSync(file(relative), "utf8"));
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function atomicWrite(relative, contents) {
  const destination = file(relative);
  if (fs.readFileSync(destination, "utf8") === contents) return false;
  if (dryRun) return true;
  const temporary = `${destination}.${process.pid}.tmp`;
  const mode = fs.statSync(destination).mode & 0o777;
  fs.writeFileSync(temporary, contents, { encoding: "utf8", mode, flag: "wx" });
  fs.renameSync(temporary, destination);
  return true;
}

const packageJson = readJson("package.json");
const previousVersion = packageJson.version;
const releasePlan = readJson("release-plan.json");
const releasePlanErrors = validateReleasePlan(releasePlan);
if (releasePlanErrors.length) throw new Error(`Invalid release-plan.json: ${releasePlanErrors.join(" ")}`);
const plannedVersion = activeVersionForPlan(releasePlan);
if (nextVersion !== plannedVersion) {
  throw new Error(`Requested version ${nextVersion} does not match active release-plan version ${plannedVersion}. Update release-plan.json first.`);
}
const packageLock = readJson("package-lock.json");
const marketplace = readJson(".claude-plugin/marketplace.json");
const codexMarketplace = readJson(".agents/plugins/marketplace.json");
const pluginManifest = readJson("plugins/grok/.claude-plugin/plugin.json");
const codexPluginManifest = readJson("plugins/grok/.codex-plugin/plugin.json");

packageJson.version = nextVersion;
packageLock.version = nextVersion;
if (!packageLock.packages?.[""]) throw new Error("package-lock.json has no root package entry.");
packageLock.packages[""].version = nextVersion;
if (!marketplace.metadata) marketplace.metadata = {};
marketplace.metadata.version = nextVersion;
const marketplacePlugin = marketplace.plugins?.find((entry) => entry?.name === "grok");
if (!marketplacePlugin) throw new Error("Marketplace has no grok plugin entry.");
marketplacePlugin.version = nextVersion;
pluginManifest.version = nextVersion;
const codexMarketplacePlugin = codexMarketplace.plugins?.find((entry) => entry?.name === "grok");
if (!codexMarketplacePlugin) throw new Error("Codex marketplace has no grok plugin entry.");
codexMarketplacePlugin.version = nextVersion;
codexPluginManifest.version = nextVersion;

const changelogPath = "plugins/grok/CHANGELOG.md";
let changelog = fs.readFileSync(file(changelogPath), "utf8");
if (!new RegExp(`^## ${nextVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(changelog)) {
  const marker = "# Changelog\n";
  if (!changelog.startsWith(marker)) throw new Error("CHANGELOG.md must start with '# Changelog'.");
  changelog = `${marker}\n## ${nextVersion}\n\n- Unreleased.\n\n${changelog.slice(marker.length).replace(/^\n+/, "")}`;
}

const noticePath = "plugins/grok/NOTICE";
let notice = fs.readFileSync(file(noticePath), "utf8");
if (!/^Grok Companion for Claude Code and Codex \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\./m.test(notice)) {
  throw new Error("Plugin NOTICE has no versioned product line.");
}
notice = notice.replace(/^Grok Companion for Claude Code and Codex \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\./m, `Grok Companion for Claude Code and Codex ${nextVersion}.`);

const providerPath = "plugins/grok/scripts/lib/grok-provider.mjs";
let provider = fs.readFileSync(file(providerPath), "utf8");
const clientVersionPattern = /(clientInfo\s*:\s*\{[\s\S]{0,300}?version\s*:\s*["'])[^"']+(["'])/;
if (!clientVersionPattern.test(provider)) throw new Error("Could not find ACP clientInfo version.");
provider = provider.replace(clientVersionPattern, `$1${nextVersion}$2`);

const updates = [
  ["package.json", serializeJson(packageJson)],
  ["package-lock.json", serializeJson(packageLock)],
  [".claude-plugin/marketplace.json", serializeJson(marketplace)],
  [".agents/plugins/marketplace.json", serializeJson(codexMarketplace)],
  ["plugins/grok/.claude-plugin/plugin.json", serializeJson(pluginManifest)],
  ["plugins/grok/.codex-plugin/plugin.json", serializeJson(codexPluginManifest)],
  [changelogPath, changelog],
  [noticePath, notice],
  [providerPath, provider]
];

const changed = updates.filter(([relative, contents]) => atomicWrite(relative, contents)).map(([relative]) => relative);
process.stdout.write(`${dryRun ? "Would bump" : "Bumped"} ${previousVersion} -> ${nextVersion}.\n`);
for (const relative of changed) process.stdout.write(`${dryRun ? "would update" : "updated"}: ${relative}\n`);
if (!changed.length) process.stdout.write("No files required changes.\n");
