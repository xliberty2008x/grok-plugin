#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { hasYamlFrontmatter } from "./lib/frontmatter.mjs";
import { activeVersionForPlan, qualificationEvidencePath, qualificationSourceDigest, validateQualificationEvidence, validateReadmeReleaseStatus, validateReleasePlan } from "./lib/version-policy.mjs";

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
  const codexMarketplace = readJson(".agents/plugins/marketplace.json");
  const pluginManifest = readJson("plugins/grok/.claude-plugin/plugin.json");
  const codexPluginManifest = readJson("plugins/grok/.codex-plugin/plugin.json");
  const releasePlan = readJson("release-plan.json");
  if (!packageJson || !packageLock || !marketplace || !codexMarketplace || !pluginManifest || !codexPluginManifest || !releasePlan) return;

  const version = packageJson.version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version))) {
    problem("package.json version is not a supported SemVer value.", "package.json");
    return;
  }

  const pluginEntry = Array.isArray(marketplace.plugins)
    ? marketplace.plugins.find((entry) => entry?.name === "grok")
    : null;
  const codexPluginEntry = Array.isArray(codexMarketplace.plugins)
    ? codexMarketplace.plugins.find((entry) => entry?.name === "grok")
    : null;
  const values = [
    ["package-lock.json top-level version", packageLock.version],
    ["package-lock.json root package version", packageLock.packages?.[""]?.version],
    ["marketplace metadata version", marketplace.metadata?.version],
    ["marketplace grok plugin version", pluginEntry?.version],
    ["Claude plugin manifest version", pluginManifest.version],
    ["Codex marketplace grok plugin version", codexPluginEntry?.version],
    ["Codex plugin manifest version", codexPluginManifest.version]
  ];
  for (const [label, value] of values) {
    if (value !== version) problem(`${label} (${value ?? "missing"}) does not match package version ${version}.`);
  }

  for (const message of validateReleasePlan(releasePlan)) problem(message, "release-plan.json");
  const plannedVersion = activeVersionForPlan(releasePlan);
  if (plannedVersion !== version) {
    problem(`Active release-plan version (${plannedVersion ?? "invalid"}) does not match package version ${version}.`, "release-plan.json");
  }

  const changelog = readText("plugins/grok/CHANGELOG.md");
  const firstChangelogVersion = changelog?.match(/^##\s+([^\s]+)\s*$/m)?.[1] || null;
  if (changelog != null && firstChangelogVersion !== version) {
    problem(`First changelog version (${firstChangelogVersion ?? "missing"}) must match active package version ${version}.`, "plugins/grok/CHANGELOG.md");
  }
  if (changelog != null && !new RegExp(`^## ${releasePlan.baseVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(changelog)) {
    problem(`Changelog must retain stable base version ${releasePlan.baseVersion} as immutable history.`, "plugins/grok/CHANGELOG.md");
  }

  const readme = readText("README.md");
  if (readme != null) for (const message of validateReadmeReleaseStatus(readme, releasePlan, version)) problem(message, "README.md");
  if (readme != null) {
    const requiredCurrentContract = [
      "TaskEnvelope",
      "ContextManifest",
      "contract version **3**",
      "record-verification",
      "npm run test:pty-ingress",
      "npm run test:installed-codex",
      "npm run test:natural-codex",
      "npm run codex:update-local"
    ];
    for (const term of requiredCurrentContract) {
      if (!readme.includes(term)) problem(`README is missing current contract/install evidence: ${term}.`, "README.md");
    }
    if (!/historical[\s\S]{0,220}(?:does not|doesn't|do not) qualify/i.test(readme)) {
      problem("README must state that historical evidence does not qualify the current hardening worktree.", "README.md");
    }
    const staleCurrentClaims = [
      "rescue-read-v2",
      "rescue-write-v2",
      "security-contract version **2**",
      "GrokBuild:run_terminal_cmd",
      "GrokBuild:kill_task",
      "GrokBuild:get_task_output",
      "v0.2.0"
    ];
    for (const claim of staleCurrentClaims) {
      if (readme.includes(claim)) problem(`README contains a stale current-contract claim: ${claim}.`, "README.md");
    }
  }

  if (releasePlan.stage !== "development") {
    const evidenceFile = qualificationEvidencePath(releasePlan.targetVersion);
    const evidence = readJson(evidenceFile);
    let current = {};
    try {
      current = {
        sourceDigest: qualificationSourceDigest(ROOT)
      };
    } catch (error) {
      problem(`Could not resolve the current qualification source digest: ${error.message}`, evidenceFile);
    }
    if (evidence) for (const message of validateQualificationEvidence(releasePlan, evidence, current)) problem(message, evidenceFile);
  }

  for (const file of ["SPEC.md", "PLAN.md"]) {
    const text = readText(file);
    const target = text?.match(/^Target release:\s*`([^`]+)`\s*$/m)?.[1] || null;
    if (target !== releasePlan.targetVersion) {
      problem(`Target release (${target ?? "missing"}) must match release-plan target ${releasePlan.targetVersion}.`, file);
    }
  }

  const pluginNotice = readText("plugins/grok/NOTICE");
  if (pluginNotice != null && !pluginNotice.includes(`Grok Companion for Claude Code and Codex ${version}`)) {
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
    "CONTRIBUTING.md",
    "README.md",
    "SPEC.md",
    "PLAN.md",
    "WORKER_BROKER_PLAN.md",
    "UPSTREAM.md",
    "package.json",
    "package-lock.json",
    "release-plan.json",
    ".claude-plugin/marketplace.json",
    ".agents/plugins/marketplace.json",
    ".github/workflows/ci.yml",
    "scripts/validate.mjs",
    "scripts/bump-version.mjs",
    "scripts/update-local-codex.mjs",
    "scripts/test-natural-codex.mjs",
    "tests/live-grok.test.mjs",
    "tests/installed-codex.test.mjs",
    "tests/natural-codex-output.schema.json",
    "tests/worker-broker-evidence.test.mjs",
    "tests/worker-protocol.test.mjs",
    "tests/nonblocking-stdin-child.mjs",
    "tests/pty-ingress.test.mjs",
    "tests/pty-stdin-driver.py",
    "tests/stdin.test.mjs",
    "tests/e2e-results/macos-0.2.99-2026-07-13.json",
    "tests/e2e-results/worker-broker/phase-1-readonly-dcb78b8.json",
    "tests/windows-neutral.test.mjs",
    "plugins/grok/.claude-plugin/plugin.json",
    "plugins/grok/.codex-plugin/plugin.json",
    "plugins/grok/.mcp.json",
    "plugins/grok/CHANGELOG.md",
    "plugins/grok/LICENSE",
    "plugins/grok/NOTICE",
    "plugins/grok/agents/grok-rescue.md",
    "plugins/grok/provider-agents/rescue-read.md",
    "plugins/grok/provider-agents/rescue-write.md",
    "plugins/grok/provider-agents/report-repair.md",
    "plugins/grok/provider-agents/setup-probe.md",
    "plugins/grok/hooks/hooks.json",
    "plugins/grok/hooks/claude-hooks.json",
    "plugins/grok/prompts/review.md",
    "plugins/grok/prompts/adversarial-review.md",
    "plugins/grok/prompts/stop-review-gate.md",
    "plugins/grok/schemas/review-output.schema.json",
    "plugins/grok/schemas/worker-broker-evidence.schema.json",
    "plugins/grok/schemas/worker-protocol.schema.json",
    "plugins/grok/scripts/grok-companion.mjs",
    "plugins/grok/scripts/grok-codex.mjs",
    "plugins/grok/mcp/broker.mjs",
    "plugins/grok/mcp/server.mjs",
    "plugins/grok/scripts/session-lifecycle-hook.mjs",
    "plugins/grok/scripts/stop-review-gate-hook.mjs",
    "plugins/grok/scripts/lib/process-control.mjs",
    "plugins/grok/scripts/lib/recursion-guard.mjs",
    "plugins/grok/scripts/lib/host.mjs",
    "plugins/grok/scripts/lib/stdin.mjs",
    "plugins/grok/scripts/lib/task-contract.mjs",
    "plugins/grok/scripts/lib/transcript.mjs",
    "plugins/grok/skills/grok-cli-runtime/SKILL.md",
    "plugins/grok/skills/grok-result-handling/SKILL.md",
    "plugins/grok/skills/grok-prompting/SKILL.md"
  ];
  const commandNames = ["setup", "review", "adversarial-review", "rescue", "transfer", "status", "result", "cancel"];
  for (const name of commandNames) required.push(`plugins/grok/commands/${name}.md`);
  for (const name of commandNames) required.push(`plugins/grok/skills/${name}/SKILL.md`);
  for (const file of required) requiredFile(file);

  const packageJson = readJson("package.json");
  if (packageJson) {
    if (packageJson.private !== true) problem("The implementation package must remain private.", "package.json");
    if (packageJson.type !== "module") problem("The package must use ESM (`type: module`).", "package.json");
    if (packageJson.license !== "Apache-2.0") problem("Package license must be Apache-2.0.", "package.json");
    if (packageJson.engines?.node !== ">=18.18") problem("Node engine must remain >=18.18.", "package.json");
    for (const script of ["test", "test:e2e", "test:pty-ingress", "test:installed-codex", "codex:update-local", "validate", "version:check", "version:bump", "check"]) {
      if (!packageJson.scripts?.[script]) problem(`Missing npm script: ${script}.`, "package.json");
    }
    if (packageJson.scripts?.["test:pty-ingress"] !== "node --test tests/pty-ingress.test.mjs") {
      problem("test:pty-ingress must execute the dedicated nonblocking PTY regression directly.", "package.json");
    }
    if (packageJson.scripts?.["test:installed-codex"] !== "node --test tests/installed-codex.test.mjs") {
      problem("test:installed-codex must execute the installed Codex gate directly.", "package.json");
    }
    if (packageJson.scripts?.["test:deterministic"] !== "node scripts/test-deterministic.mjs") {
      problem("test:deterministic must execute the zero-skip deterministic runner directly.", "package.json");
    }
    if (packageJson.scripts?.check !== "npm run validate && npm run test:deterministic") {
      problem("check must run validation and the zero-skip deterministic suite.", "package.json");
    }
    if (packageJson.scripts?.["codex:update-local"] !== "node scripts/update-local-codex.mjs") {
      problem("codex:update-local must execute the verified local-cache updater directly.", "package.json");
    }
  }

  const contributing = readText("CONTRIBUTING.md", { required: false });
  if (contributing != null && (!/Versioning convention and change taxonomy/i.test(contributing)
    || !/version already present on the base branch[\s\S]{0,80}MUST NOT be reused/i.test(contributing)
    || !/release-plan\.json/.test(contributing)
    || !["runtime_ingress", "host_orchestration", "artifact_install", "provider_transport", "worker_execution", "host_verification"].every((boundary) => contributing.includes(`\`${boundary}\``))
    || !/Evidence may no longer|Do not promote evidence across boundaries/i.test(contributing)
    || !/npm run test:installed-codex/.test(contributing)
    || !/npm run codex:update-local/.test(contributing)
    || !/CODEX_PLUGIN_RUNNER_ENABLED/.test(contributing))) {
    problem("CONTRIBUTING.md must define version governance, boundary-scoped evidence, and the installed-Codex gate.", "CONTRIBUTING.md");
  }

  const specification = readText("SPEC.md", { required: false });
  if (specification != null && (!/Boundary-scoped evidence/.test(specification)
    || !/reader-ready handshake/.test(specification)
    || !/PTY/.test(specification)
    || !/host_orchestration/.test(specification))) {
    problem("SPEC.md must preserve the runtime-ingress, PTY, and host-orchestration qualification boundaries.", "SPEC.md");
  }

  const marketplace = readJson(".claude-plugin/marketplace.json");
  const codexMarketplace = readJson(".agents/plugins/marketplace.json");
  const pluginManifest = readJson("plugins/grok/.claude-plugin/plugin.json");
  const codexPluginManifest = readJson("plugins/grok/.codex-plugin/plugin.json");
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
  if (
    !Array.isArray(pluginManifest?.hooks)
    || pluginManifest.hooks.length !== 2
    || pluginManifest.hooks[0] !== "./hooks/hooks.json"
    || pluginManifest.hooks[1] !== "./hooks/claude-hooks.json"
  ) {
    problem("Claude plugin manifest must load the shared and Claude-only hooks files.", "plugins/grok/.claude-plugin/plugin.json");
  }
  if (codexMarketplace) {
    if (codexMarketplace.name !== "grok-companion") problem("Codex marketplace name must be grok-companion.", ".agents/plugins/marketplace.json");
    const entries = Array.isArray(codexMarketplace.plugins) ? codexMarketplace.plugins.filter((entry) => entry?.name === "grok") : [];
    if (entries.length !== 1) problem("Codex marketplace must contain exactly one grok plugin entry.", ".agents/plugins/marketplace.json");
    const entry = entries[0];
    if (entry?.source?.source !== "local" || entry?.source?.path !== "./plugins/grok") problem("Codex marketplace must use the local ./plugins/grok source.", ".agents/plugins/marketplace.json");
    if (entry?.policy?.installation !== "AVAILABLE" || entry?.policy?.authentication !== "ON_INSTALL") problem("Codex marketplace policy must use AVAILABLE and ON_INSTALL.", ".agents/plugins/marketplace.json");
  }
  if (codexPluginManifest?.name !== "grok") problem("Codex plugin manifest name must be grok.", "plugins/grok/.codex-plugin/plugin.json");
  if (codexPluginManifest?.skills !== "./skills/") problem("Codex plugin manifest must expose ./skills/.", "plugins/grok/.codex-plugin/plugin.json");
  if (codexPluginManifest?.mcpServers !== "./.mcp.json") problem("Codex plugin manifest must expose the bundled MCP config.", "plugins/grok/.codex-plugin/plugin.json");

  const hooks = readJson("plugins/grok/hooks/hooks.json");
  if (hooks) {
    for (const event of ["SessionStart", "Stop"]) {
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
    if (hooks.hooks?.SessionEnd) problem("Default hooks must not declare unsupported Codex SessionEnd.", "plugins/grok/hooks/hooks.json");
  }
  const claudeHooks = readJson("plugins/grok/hooks/claude-hooks.json");
  if (claudeHooks) {
    if (!Array.isArray(claudeHooks.hooks?.SessionEnd) || claudeHooks.hooks.SessionEnd.length !== 1) problem("Claude supplemental hooks must declare exactly one SessionEnd group.", "plugins/grok/hooks/claude-hooks.json");
    for (const event of Object.keys(claudeHooks.hooks || {})) if (event !== "SessionEnd") problem("Claude supplemental hooks may contain only SessionEnd.", "plugins/grok/hooks/claude-hooks.json");
  }

  const schema = readJson("plugins/grok/schemas/review-output.schema.json");
  if (schema) {
    if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") problem("Review schema must use JSON Schema 2020-12.", "plugins/grok/schemas/review-output.schema.json");
    // summary + findings are the complete provider contract; verdict is runtime-derived only.
    for (const field of ["summary", "findings"]) {
      if (!schema.required?.includes(field) || !schema.properties?.[field]) problem(`Review schema is missing required field ${field}.`, "plugins/grok/schemas/review-output.schema.json");
    }
    if (schema.properties?.verdict || schema.required?.includes("verdict")) problem("Review schema must not accept a model-controlled verdict; runtime derives it from findings.", "plugins/grok/schemas/review-output.schema.json");
  }

  const workerEvidenceSchema = readJson("plugins/grok/schemas/worker-broker-evidence.schema.json");
  if (workerEvidenceSchema) {
    const file = "plugins/grok/schemas/worker-broker-evidence.schema.json";
    if (workerEvidenceSchema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
      problem("Worker Broker evidence schema must use JSON Schema 2020-12.", file);
    }
    for (const field of ["phase", "status", "qualification", "source", "verification", "recordDigest"]) {
      if (!workerEvidenceSchema.required?.includes(field) || !workerEvidenceSchema.properties?.[field]) {
        problem(`Worker Broker evidence schema is missing required field ${field}.`, file);
      }
    }
    const proofRule = (workerEvidenceSchema.allOf || []).find((rule) => (
      rule?.then?.required?.includes("proofProducer")
    ));
    const proofStatuses = proofRule?.if?.properties?.status?.enum || [];
    for (const status of ["verified_on_draft", "qualified"]) {
      if (!proofStatuses.includes(status)) {
        problem(`Worker Broker evidence schema must require proofProducer for ${status}.`, file);
      }
    }
    const proofProducer = workerEvidenceSchema.properties?.proofProducer;
    if (proofProducer?.additionalProperties !== false
      || proofProducer?.properties?.id?.const !== "worker-broker-gate-runner"
      || proofProducer?.properties?.version?.const !== 2
      || !proofProducer?.required?.includes("manifestDigest")) {
      problem("Worker Broker evidence schema must bind exact gate-runner provenance.", file);
    }
    const reviewReceipt = workerEvidenceSchema.properties?.independentReviewReceipt;
    const phaseOnePromotionProhibition = (workerEvidenceSchema.allOf || []).find((rule) => (
      rule?.not?.properties?.phase?.const === "1"
      && rule?.not?.required?.includes("phase")
      && rule?.not?.required?.includes("status")
      && ["verified_on_draft", "qualified"].every((status) => (
        rule?.not?.properties?.status?.enum?.includes(status)
      ))
    ));
    if (reviewReceipt?.additionalProperties !== false
      || reviewReceipt?.properties?.producerId?.const !== "codex-native-review-runner"
      || reviewReceipt?.properties?.producerVersion?.const !== 1
      || reviewReceipt?.properties?.outcome?.const !== "pass"
      || reviewReceipt?.properties?.unresolvedFindings?.const !== 0
      || !reviewReceipt?.required?.includes("receiptDigest")
      || !phaseOnePromotionProhibition) {
      problem("Worker Broker Phase 1 evidence schema must forbid unauthenticated verified promotion.", file);
    }
    if (workerEvidenceSchema.properties?.scenarios?.items?.properties?.measurements?.additionalProperties !== false) {
      problem("Worker Broker scenario measurements must be a bounded allowlist.", file);
    }
  }

  const workerProtocolSchema = readJson("plugins/grok/schemas/worker-protocol.schema.json");
  if (workerProtocolSchema) {
    const file = "plugins/grok/schemas/worker-protocol.schema.json";
    if (workerProtocolSchema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
      problem("Worker Protocol schema must use JSON Schema 2020-12.", file);
    }
    for (const definition of ["WorkerHandle", "WorkerSnapshot", "WorkerEvent", "WorkerEventPage", "WorkerResult", "WorkerError"]) {
      if (!workerProtocolSchema.$defs?.[definition]) {
        problem(`Worker Protocol schema is missing ${definition}.`, file);
      }
    }
  }

  const macosEvidence = readJson("tests/e2e-results/macos-0.2.99-2026-07-13.json");
  if (macosEvidence) {
    if (macosEvidence.schemaVersion !== 1 || macosEvidence.date !== "2026-07-13") problem("macOS E2E evidence has invalid identity metadata.", "tests/e2e-results/macos-0.2.99-2026-07-13.json");
    if (macosEvidence.platform?.name !== "macOS" || macosEvidence.runtime?.grokBuild !== "0.2.99") problem("macOS E2E evidence must identify macOS and Grok Build 0.2.99.", "tests/e2e-results/macos-0.2.99-2026-07-13.json");
    if (macosEvidence.suite?.outcome !== "pass" || macosEvidence.suite?.tests !== 10 || macosEvidence.suite?.passed !== 10 || macosEvidence.suite?.failed !== 0) problem("macOS E2E evidence must record the complete 10/10 passing suite.", "tests/e2e-results/macos-0.2.99-2026-07-13.json");
    if (!Array.isArray(macosEvidence.cases) || macosEvidence.cases.length !== 10 || macosEvidence.cases.some((entry) => entry?.outcome !== "pass")) problem("macOS E2E evidence must list ten passing cases.", "tests/e2e-results/macos-0.2.99-2026-07-13.json");
    if (macosEvidence.runtime?.profileContractVersion !== 3 || !macosEvidence.sourceCommit || !macosEvidence.sourceTreeDigest) {
      warn("Historical profile-v2 evidence has no current source-digest binding and does not qualify the profile-v3 hardening worktree; rerun authenticated E2E before release claims.", "tests/e2e-results/macos-0.2.99-2026-07-13.json");
    }
  }

  for (const name of commandNames) {
    const file = `plugins/grok/commands/${name}.md`;
    const text = readText(file, { required: false });
    if (text == null) continue;
    if (!hasYamlFrontmatter(text)) problem("Command file must start with YAML frontmatter.", file);
    if (!/^description:\s*\S+/m.test(text)) problem("Command frontmatter must include a description.", file);
    if (!/modified|adapted/i.test(text) || !/openai\/codex-plugin-cc/i.test(text)) {
      problem("Adapted command must carry a prominent modification notice naming openai/codex-plugin-cc.", file);
    }
  }
  for (const name of commandNames) {
    const file = `plugins/grok/skills/${name}/SKILL.md`;
    const text = readText(file, { required: false });
    if (text == null) continue;
    if (!new RegExp(`name:\\s*${name}\\b`).test(text)) problem(`Codex skill name must be ${name}.`, file);
    if (!text.includes("../../scripts/grok-codex.mjs")) problem("Codex skill must resolve the bundled Codex runtime relative to SKILL.md.", file);
    if (/CLAUDE_PLUGIN_ROOT|\/grok:/.test(text)) problem("Codex skill contains a Claude-only invocation path.", file);
    if (!/^user-invocable:\s*false$/m.test(text)) problem("Codex facade must be hidden from Claude Code's duplicate user command discovery.", file);
    const metadataFile = `plugins/grok/skills/${name}/agents/openai.yaml`;
    const metadata = readText(metadataFile);
    if (metadata != null) {
      if (!metadata.includes(`$grok:${name}`)) problem("Codex skill metadata default prompt must name its qualified skill.", metadataFile);
      if (!/^\s*allow_implicit_invocation:\s*true$/m.test(metadata)) problem("Public Codex skill must permit implicit invocation.", metadataFile);
    }
  }
  for (const name of ["grok-cli-runtime", "grok-prompting", "grok-result-handling"]) {
    const metadataFile = `plugins/grok/skills/${name}/agents/openai.yaml`;
    const metadata = readText(metadataFile);
    if (metadata != null && !/^\s*allow_implicit_invocation:\s*false$/m.test(metadata)) {
      problem("Claude-internal skill must not be injected implicitly into Codex.", metadataFile);
    }
  }

  const agent = readText("plugins/grok/agents/grok-rescue.md", { required: false });
  if (agent != null) {
    if (!hasYamlFrontmatter(agent)) problem("Agent file must start with YAML frontmatter.", "plugins/grok/agents/grok-rescue.md");
    if (!/modified|adapted/i.test(agent) || !/openai\/codex-plugin-cc/i.test(agent)) problem("Adapted agent must carry a prominent upstream modification notice.", "plugins/grok/agents/grok-rescue.md");
  }

  const reportRepairFile = "plugins/grok/provider-agents/report-repair.md";
  const reportRepair = readText(reportRepairFile, { required: false });
  if (reportRepair != null) {
    const frontmatter = reportRepair.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || "";
    if (!frontmatter) problem("Report-repair profile must start with YAML frontmatter.", reportRepairFile);
    if (!/^permission_mode:\s*dontAsk\s*$/m.test(frontmatter)) problem("Report-repair profile must deny interactive permission escalation.", reportRepairFile);
    if (!/^injectDefaultTools:\s*false\s*$/m.test(frontmatter)) problem("Report-repair profile must disable default tools.", reportRepairFile);
    if (!/^toolConfig:\s*\r?\n\s+tools:\s*\[\s*\]\s*$/m.test(frontmatter)) problem("Report-repair profile must declare an empty tool list.", reportRepairFile);
    if (/GrokBuild:[A-Za-z_]/.test(frontmatter)) problem("Report-repair profile must not name any Grok tool.", reportRepairFile);
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
    ...walk("plugins/grok/mcp"),
    ...walk("plugins/grok/scripts"),
    absolute(".claude-plugin/marketplace.json"),
    absolute(".agents/plugins/marketplace.json"),
    absolute("plugins/grok/.claude-plugin/plugin.json"),
    absolute("plugins/grok/.codex-plugin/plugin.json"),
    absolute("plugins/grok/.mcp.json")
  ].filter((file) => fs.existsSync(file) && fs.statSync(file).isFile());
  const stalePatterns = [
    [/\/codex:/i, "Codex slash-command namespace"],
    [/\bcodex-companion\b/i, "Codex companion identifier"],
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

  const moduleFiles = [
    ...walk("scripts"),
    ...walk("tests"),
    ...walk("plugins/grok/scripts"),
    ...walk("plugins/grok/mcp")
  ].filter((file) => file.endsWith(".mjs"));
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
    if (!/npm run test:pty-ingress/.test(workflow)) problem("CI must expose the source nonblocking PTY regression as a named gate.", ".github/workflows/ci.yml");
    if (!/npm run test:deterministic/.test(workflow)) problem("Linux/macOS CI must run the deterministic zero-skip suite.", ".github/workflows/ci.yml");
    if (!/CODEX_PLUGIN_RUNNER_ENABLED/.test(workflow) || !/npm run test:installed-codex/.test(workflow)) {
      problem("CI must define the opt-in Codex-equipped installed-snapshot gate.", ".github/workflows/ci.yml");
    }
    if (!/github\.event_name == 'workflow_dispatch'/.test(workflow)
      || !/github\.event_name == 'push'\s*&&\s*github\.ref == 'refs\/heads\/main'/.test(workflow)) {
      problem("The self-hosted installed-Codex gate must be restricted to trusted main pushes or explicit workflow dispatch.", ".github/workflows/ci.yml");
    }
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
