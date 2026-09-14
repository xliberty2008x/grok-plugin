import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { installFakeGrok } from "./fake-grok.mjs";
import { installPinnedFakeCompanion } from "./pinned-fake-grok.mjs";
import { initRepo, runCompanion, tempDir, testEnvironment } from "./helpers.mjs";

function setupFixture(t, config = {}) {
  const fake = installFakeGrok(tempDir(), config);
  const pluginData = tempDir();
  const env = testEnvironment({ fake, pluginData });
  for (const key of ["GROK_COMPANION_CHILD", "GROK_COMPANION_JOB_MARKER", "GROK_AGENT", "GROK_LEADER_SOCKET"]) delete env[key];
  const pinned = installPinnedFakeCompanion(fake, env);
  t.after(pinned.cleanup);
  return { cwd: initRepo(), env: pinned.env, companionScript: pinned.companionScript, pluginData };
}

test("setup failure returns nonzero with readiness JSON and validated pinned version", (t) => {
  const fixture = setupFixture(t, { helpText: "Usage: grok --sandbox PROFILE\n" });
  const result = runCompanion(["setup", "--enable-review-gate", "--json"], fixture);
  assert.equal(result.status, 3);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.grok.ready, false);
  assert.equal(payload.grok.version, "0.2.99");
  assert.equal(payload.grok.error.code, "E_CAPABILITY");
  assert.equal(payload.config.stopReviewGate, false);
  assert.equal(fs.existsSync(path.join(fixture.pluginData, "capabilities", "provider-capability-v2.json")), false);
  assert.equal(result.stdout.includes(fixture.pluginData), false);
});

test("setup extension contamination exposes a stable probe with private details omitted", (t) => {
  const fixture = setupFixture(t, { inspectValue: { hooks: [], skills: [], plugins: [{ name: "PRIVATE_PLUGIN_NAME", path: "/PRIVATE/PLUGIN/PATH" }], mcpServers: [], agents: [] } });
  const result = runCompanion(["setup", "--json"], fixture);
  assert.equal(result.status, 3);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.grok.error.details.probe, "isolated-extensions");
  assert.equal(payload.grok.version, "0.2.99");
  assert.match(payload.nextSteps.join(" "), /external.*(?:plugin|extension|MCP)/i);
  assert.doesNotMatch(result.stdout, /PRIVATE_PLUGIN_NAME|\/PRIVATE\/PLUGIN\/PATH/);
  assert.equal(result.stdout.includes(fixture.pluginData), false);
});

test("setup text failure shows known version and error without success-only fields", (t) => {
  const fixture = setupFixture(t, { helpText: "Usage: grok --sandbox PROFILE\n" });
  const result = runCompanion(["setup"], fixture);
  assert.equal(result.status, 3);
  assert.match(result.stdout, /Grok Companion: not ready/);
  assert.match(result.stdout, /Grok 0\.2\.99/);
  assert.match(result.stdout, /E_CAPABILITY/);
  assert.doesNotMatch(result.stdout, /undefined|Models:/);
  assert.equal(result.stderr, "");
});

test("setup readiness remains exit zero and publishes capability", (t) => {
  const fixture = setupFixture(t);
  const result = runCompanion(["setup", "--enable-review-gate", "--json"], fixture);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.config.stopReviewGate, true);
  assert.equal(fs.existsSync(path.join(fixture.pluginData, "capabilities", "provider-capability-v2.json")), true);
});

test("setup failure before pin validation does not invent a provider version", (t) => {
  const fixture = setupFixture(t);
  fixture.env = { ...fixture.env, HOME: fixture.pluginData, GROK_HOME: path.join(fixture.pluginData, "empty-home"), PATH: "/usr/bin:/bin", GROK_BIN: path.join(fixture.pluginData, "missing-provider") };
  const result = runCompanion(["setup", "--json"], fixture);
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(Object.hasOwn(payload.grok, "version"), false);
});


test("installed setup ignores native repository skill roots while publishing readiness", (t) => {
  const fixture = setupFixture(t, { inspectProjectSkillPaths: [".agents/skills/private/SKILL.md", ".grok/skills/private/SKILL.md"] });
  for (const relative of [".agents/skills/private/SKILL.md", ".grok/skills/private/SKILL.md"]) {
    const file = path.join(fixture.cwd, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "# Private fixture skill\n");
  }
  const result = runCompanion(["setup", "--json"], fixture);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).ready, true);
  assert.equal(fs.existsSync(path.join(fixture.pluginData, "capabilities", "provider-capability-v2.json")), true);
});
