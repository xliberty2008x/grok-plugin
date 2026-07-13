#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const jsonOutput = args.has("--json");
const versionsOnly = args.has("--versions-only");
const allowedArgs = new Set(["--json", "--versions-only", "--help", "-h"]);
const errors = [];
const warnings = [];

if (args.has("--help") || args.has("-h")) {
  process.stdout.write("Usage: node scripts/validate.mjs [--versions-only] [--json]\n");
  process.exit(0);
}

for (const arg of args) {
  if (!allowedArgs.has(arg)) errors.push({ file: null, message: `Unknown argument: ${arg}` });
}

function absolute(relative) {
  return path.join(ROOT, relative);
}

function problem(message, file = null) {
  errors.push({ file, message });
}

function warn(message, file = null) {
  warnings.push({ file, message });
}

function requiredFile(relative) {
  const file = absolute(relative);
  if (!fs.existsSync(file)) {
    problem("Required file is missing.", relative);
    return false;
  }
  if (!fs.statSync(file).isFile()) {
    problem("Required path is not a regular file.", relative);
    return false;
  }
  return true;
}

function readText(relative, { required = true } = {}) {
  try {
    return fs.readFileSync(absolute(relative), "utf8");
  } catch (error) {
    if (required || error?.code !== "ENOENT") problem(`Could not read file: ${error.message}`, relative);
    return null;
  }
}

function readJson(relative) {
  const text = readText(relative);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    problem(`Invalid JSON: ${error.message}`, relative);
    return null;
  }
}

function walk(relative) {
  const root = absolute(relative);
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        files.push(file);
      } else if (entry.isDirectory()) {
        visit(file);
      } else if (entry.isFile()) {
        files.push(file);
      }
    }
  };
  visit(root);
  return files;
}

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function versionChecks() {
  const packageJson = readJson("package.json");
  const packageLock = readJson("package-lock.json");
  const marketplace = readJson(".claude-plugin/marketplace.json");
  const pluginManifest = readJson("plugins/grok/.claude-plugin/plugin.json");
  if (!packageJson || !packageLock || !marketplace || !pluginManifest) return;

  const version = packageJson.version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version))) {
    problem("package.json version is not a supported SemVer value.", "package.json");
    return;
  }

  const pluginEntry = Array.isArray(marketplace.plugins)
    ? marketplace.plugins.find((entry) => entry?.name === "grok")
    : null;
  const values = [
    ["package-lock.json top-level version", packageLock.version],
    ["package-lock.json root package version", packageLock.packages?.[""]?.version],
    ["marketplace metadata version", marketplace.metadata?.version],
    ["marketplace grok plugin version", pluginEntry?.version],
    ["plugin manifest version", pluginManifest.version]
  ];
  for (const [label, value] of values) {
    if (value !== version) problem(`${label} (${value ?? "missing"}) does not match package version ${version}.`);
  }

  const changelog = readText("plugins/grok/CHANGELOG.md");
  if (changelog != null && !new RegExp(`^## ${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(changelog)) {
    problem(`Changelog has no release heading for ${version}.`, "plugins/grok/CHANGELOG.md");
  }

  const pluginNotice = readText("plugins/grok/NOTICE");
  if (pluginNotice != null && !pluginNotice.includes(`Grok Companion for Claude Code ${version}`)) {
    problem(`Plugin NOTICE does not identify release ${version}.`, "plugins/grok/NOTICE");
  }

  const provider = readText("plugins/grok/scripts/lib/grok-provider.mjs");
  const clientVersion = provider?.match(/clientInfo\s*:\s*\{[\s\S]{0,300}?version\s*:\s*["']([^"']+)["']/)?.[1];
  if (clientVersion !== version) {
    problem(`ACP clientInfo version (${clientVersion ?? "missing"}) does not match package version ${version}.`, "plugins/grok/scripts/lib/grok-provider.mjs");
  }
}

versionChecks();

if (!versionsOnly) {
  const required = [
    ".gitignore",
    ".npmignore",
    "LICENSE",
    "NOTICE",
    "README.md",
    "SPEC.md",
    "PLAN.md",
    "UPSTREAM.md",
    "package.json",
    "package-lock.json",
    ".claude-plugin/marketplace.json",
    ".github/workflows/ci.yml",
    "scripts/validate.mjs",
    "scripts/bump-version.mjs",
    "tests/live-grok.test.mjs",
    "tests/e2e-results/macos-0.2.99-2026-07-13.json",
    "tests/windows-neutral.test.mjs",
    "plugins/grok/.claude-plugin/plugin.json",
    "plugins/grok/CHANGELOG.md",
    "plugins/grok/LICENSE",
    "plugins/grok/NOTICE",
    "plugins/grok/agents/grok-rescue.md",
    "plugins/grok/provider-agents/rescue-read.md",
    "plugins/grok/provider-agents/rescue-write.md",
    "plugins/grok/hooks/hooks.json",
    "plugins/grok/prompts/review.md",
    "plugins/grok/prompts/adversarial-review.md",
    "plugins/grok/prompts/stop-review-gate.md",
    "plugins/grok/schemas/review-output.schema.json",
    "plugins/grok/scripts/grok-companion.mjs",
    "plugins/grok/scripts/session-lifecycle-hook.mjs",
    "plugins/grok/scripts/stop-review-gate-hook.mjs",
    "plugins/grok/scripts/lib/process-control.mjs",
    "plugins/grok/scripts/lib/recursion-guard.mjs",
    "plugins/grok/skills/grok-cli-runtime/SKILL.md",
    "plugins/grok/skills/grok-result-handling/SKILL.md",
    "plugins/grok/skills/grok-prompting/SKILL.md"
  ];
  const commandNames = ["setup", "review", "adversarial-review", "rescue", "transfer", "status", "result", "cancel"];
  for (const name of commandNames) required.push(`plugins/grok/commands/${name}.md`);
  for (const file of required) requiredFile(file);

  const packageJson = readJson("package.json");
  if (packageJson) {
    if (packageJson.private !== true) problem("The implementation package must remain private.", "package.json");
    if (packageJson.type !== "module") problem("The package must use ESM (`type: module`).", "package.json");
    if (packageJson.license !== "Apache-2.0") problem("Package license must be Apache-2.0.", "package.json");
    if (packageJson.engines?.node !== ">=18.18") problem("Node engine must remain >=18.18.", "package.json");
    for (const script of ["test", "test:e2e", "validate", "version:check", "version:bump", "check"]) {
      if (!packageJson.scripts?.[script]) problem(`Missing npm script: ${script}.`, "package.json");
    }
  }

  const marketplace = readJson(".claude-plugin/marketplace.json");
  const pluginManifest = readJson("plugins/grok/.claude-plugin/plugin.json");
  if (marketplace) {
    if (marketplace.name !== "grok-companion") problem("Marketplace name must be grok-companion.", ".claude-plugin/marketplace.json");
    if (!Array.isArray(marketplace.plugins)) problem("Marketplace plugins must be an array.", ".claude-plugin/marketplace.json");
    const entries = Array.isArray(marketplace.plugins) ? marketplace.plugins.filter((entry) => entry?.name === "grok") : [];
    if (entries.length !== 1) problem("Marketplace must contain exactly one grok plugin entry.", ".claude-plugin/marketplace.json");
    const source = entries[0]?.source;
    if (source !== "./plugins/grok") problem("The grok plugin source must be ./plugins/grok.", ".claude-plugin/marketplace.json");
    if (source) {
      const resolved = path.resolve(ROOT, source);
      const pluginRoot = path.resolve(ROOT, "plugins/grok");
      if (resolved !== pluginRoot) problem("Marketplace source resolves outside the expected plugin directory.", ".claude-plugin/marketplace.json");
    }
  }
  if (pluginManifest?.name !== "grok") problem("Plugin manifest name must be grok.", "plugins/grok/.claude-plugin/plugin.json");

  const hooks = readJson("plugins/grok/hooks/hooks.json");
  if (hooks) {
    for (const event of ["SessionStart", "SessionEnd", "Stop"]) {
      const definitions = hooks.hooks?.[event];
      if (!Array.isArray(definitions) || definitions.length === 0) {
        problem(`Hook event ${event} is missing.`, "plugins/grok/hooks/hooks.json");
        continue;
      }
      for (const group of definitions) {
        for (const hook of group?.hooks ?? []) {
          if (hook.type !== "command" || typeof hook.command !== "string") {
            problem(`${event} must contain command hooks only.`, "plugins/grok/hooks/hooks.json");
            continue;
          }
          const target = hook.command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([^"\s]+)/)?.[1];
          if (!target) problem(`${event} command does not use CLAUDE_PLUGIN_ROOT/scripts.`, "plugins/grok/hooks/hooks.json");
          else requiredFile(`plugins/grok/scripts/${target}`);
          if (!Number.isFinite(hook.timeout) || hook.timeout <= 0 || hook.timeout > 900) {
            problem(`${event} timeout must be between 1 and 900 seconds.`, "plugins/grok/hooks/hooks.json");
          }
        }
      }
    }
  }

  const schema = readJson("plugins/grok/schemas/review-output.schema.json");
  if (schema) {
    if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") problem("Review schema must use JSON Schema 2020-12.", "plugins/grok/schemas/review-output.schema.json");
    for (const field of ["verdict", "summary", "findings"]) {
      if (!schema.required?.includes(field) || !schema.properties?.[field]) problem(`Review schema is missing required field ${field}.`, "plugins/grok/schemas/review-output.schema.json");
    }
  }

  const macosEvidence = readJson("tests/e2e-results/macos-0.2.99-2026-07-13.json");
  if (macosEvidence) {
    if (macosEvidence.schemaVersion !== 1 || macosEvidence.date !== "2026-07-13") problem("macOS E2E evidence has invalid identity metadata.", "tests/e2e-results/macos-0.2.99-2026-07-13.json");
    if (macosEvidence.platform?.name !== "macOS" || macosEvidence.runtime?.grokBuild !== "0.2.99") problem("macOS E2E evidence must identify macOS and Grok Build 0.2.99.", "tests/e2e-results/macos-0.2.99-2026-07-13.json");
    if (macosEvidence.suite?.outcome !== "pass" || macosEvidence.suite?.tests !== 10 || macosEvidence.suite?.passed !== 10 || macosEvidence.suite?.failed !== 0) problem("macOS E2E evidence must record the complete 10/10 passing suite.", "tests/e2e-results/macos-0.2.99-2026-07-13.json");
    if (!Array.isArray(macosEvidence.cases) || macosEvidence.cases.length !== 10 || macosEvidence.cases.some((entry) => entry?.outcome !== "pass")) problem("macOS E2E evidence must list ten passing cases.", "tests/e2e-results/macos-0.2.99-2026-07-13.json");
  }

  for (const name of commandNames) {
    const file = `plugins/grok/commands/${name}.md`;
    const text = readText(file, { required: false });
    if (text == null) continue;
    if (!text.startsWith("---\n") || text.indexOf("\n---\n", 4) < 0) problem("Command file must start with YAML frontmatter.", file);
    if (!/^description:\s*\S+/m.test(text)) problem("Command frontmatter must include a description.", file);
    if (!/modified|adapted/i.test(text) || !/openai\/codex-plugin-cc/i.test(text)) {
      problem("Adapted command must carry a prominent modification notice naming openai/codex-plugin-cc.", file);
    }
  }

  const agent = readText("plugins/grok/agents/grok-rescue.md", { required: false });
  if (agent != null) {
    if (!agent.startsWith("---\n") || agent.indexOf("\n---\n", 4) < 0) problem("Agent file must start with YAML frontmatter.", "plugins/grok/agents/grok-rescue.md");
    if (!/modified|adapted/i.test(agent) || !/openai\/codex-plugin-cc/i.test(agent)) problem("Adapted agent must carry a prominent upstream modification notice.", "plugins/grok/agents/grok-rescue.md");
  }

  const rootLicense = readText("LICENSE");
  const pluginLicense = readText("plugins/grok/LICENSE");
  if (rootLicense != null && !rootLicense.includes("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION")) problem("Root LICENSE is not a complete Apache-2.0 license text.", "LICENSE");
  if (pluginLicense != null && !pluginLicense.includes("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION")) problem("Plugin distribution must include the complete Apache-2.0 license text.", "plugins/grok/LICENSE");

  const expectedCommit = "db52e28f4d9ded852ab3942cea316258ae4ef346";
  const rootNotice = readText("NOTICE");
  const pluginNotice = readText("plugins/grok/NOTICE");
  const upstream = readText("UPSTREAM.md");
  for (const [file, text] of [["NOTICE", rootNotice], ["plugins/grok/NOTICE", pluginNotice], ["UPSTREAM.md", upstream]]) {
    if (text != null && (!/openai(?:'s|\/)\s*codex-plugin-cc/i.test(text) || !text.includes("1.0.6") || !text.includes(expectedCommit))) {
      problem("Upstream provenance must name repository, version 1.0.6, and the pinned commit.", file);
    }
  }
  for (const [file, text] of [["NOTICE", rootNotice], ["plugins/grok/NOTICE", pluginNotice]]) {
    if (text != null && (!/independent/i.test(text) || !/not (?:affiliated|endorsed)/i.test(text))) problem("NOTICE must contain the community non-affiliation statement.", file);
  }

  const implementationFiles = [
    ...walk("plugins/grok/commands"),
    ...walk("plugins/grok/agents"),
    ...walk("plugins/grok/provider-agents"),
    ...walk("plugins/grok/skills"),
    ...walk("plugins/grok/hooks"),
    ...walk("plugins/grok/prompts"),
    ...walk("plugins/grok/scripts"),
    absolute(".claude-plugin/marketplace.json"),
    absolute("plugins/grok/.claude-plugin/plugin.json")
  ].filter((file) => fs.existsSync(file) && fs.statSync(file).isFile());
  const stalePatterns = [
    [/\/codex:/i, "Codex slash-command namespace"],
    [/\bcodex-companion\b/i, "Codex companion identifier"],
    [/\bCODEX_PLUGIN_[A-Z0-9_]+\b/, "Codex environment identifier"],
    [/\bOPENAI_API_KEY\b/, "OpenAI credential identifier"],
    [/\bgpt-\d/i, "OpenAI model identifier"]
  ];
  for (const file of implementationFiles) {
    let text = fs.readFileSync(file, "utf8");
    text = text.replace(/<!--[\s\S]*?-->/g, "");
    for (const [pattern, label] of stalePatterns) if (pattern.test(text)) problem(`Stale provider identifier found: ${label}.`, relative(file));
  }

  for (const file of walk("plugins/grok")) {
    if (fs.lstatSync(file).isSymbolicLink()) problem("Plugin packages must not contain symlinks.", relative(file));
  }

  const forbiddenNames = /(^|\/)(?:\.env(?:\..+)?|[^/]+\.(?:pem|key|p12|pfx)|credentials(?:\.json)?|state)(?:$|\/)/i;
  for (const file of walk(".")) {
    const name = relative(file);
    if (name.startsWith(".git/")) continue;
    if (/(^|\/)\.env\.example$/i.test(name)) continue;
    if (forbiddenNames.test(name)) problem("Potential secret or runtime-state file would be included in the repository.", name);
  }

  const moduleFiles = [...walk("scripts"), ...walk("tests"), ...walk("plugins/grok/scripts")].filter((file) => file.endsWith(".mjs"));
  for (const file of moduleFiles) {
    try {
      execFileSync(process.execPath, ["--check", file], { cwd: ROOT, stdio: "pipe" });
    } catch (error) {
      const detail = String(error?.stderr || error?.message || "syntax check failed").trim();
      problem(`JavaScript syntax check failed: ${detail}`, relative(file));
    }
  }

  const workflow = readText(".github/workflows/ci.yml", { required: false });
  if (workflow != null) {
    if (!/permissions:\s*\n\s+contents:\s*read/m.test(workflow)) problem("CI must declare read-only contents permission.", ".github/workflows/ci.yml");
    if (/GROK_E2E\s*[:=]\s*["']?1/i.test(workflow) || /test:e2e/.test(workflow)) problem("Default CI must not run quota-consuming Grok E2E tests.", ".github/workflows/ci.yml");
  }
}

const result = { ok: errors.length === 0, errors, warnings };
if (jsonOutput) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  for (const entry of errors) process.stderr.write(`ERROR${entry.file ? ` [${entry.file}]` : ""}: ${entry.message}\n`);
  for (const entry of warnings) process.stderr.write(`WARN${entry.file ? ` [${entry.file}]` : ""}: ${entry.message}\n`);
  if (result.ok) process.stdout.write(`Validation passed${versionsOnly ? " (versions only)" : ""}.\n`);
  else process.stderr.write(`Validation failed with ${errors.length} error(s).\n`);
}
if (!result.ok) process.exitCode = 1;
