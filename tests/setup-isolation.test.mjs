import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { installFakeGrok, readFakeLog } from "./fake-grok.mjs";
import { initRepo, tempDir } from "./helpers.mjs";
import { probe } from "../plugins/grok/scripts/lib/provider-sessions.mjs";

test("setup suppresses native project skills while retaining private bundled skills", async () => {
  const root = initRepo();
  const skill = path.join(root, ".agents", "skills", "private-project-skill", "SKILL.md");
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, "# Fixture skill");
  const fake = installFakeGrok(tempDir("setup-native-skills-"), {
    inspectBundledSkill: true, inspectProjectSkillPaths: [skill]
  });
  const previous = { binary: process.env.GROK_BIN, auth: process.env.GROK_AUTH_PATH };
  process.env.GROK_BIN = fake.binary;
  process.env.GROK_AUTH_PATH = fake.authPath;
  const state = tempDir("setup-native-state-");
  try {
    const result = await probe(root, state);
    assert.equal(result.headlessReview.isolated, true);
    const inspection = readFakeLog(fake.logFile).find((event) => event.event === "inspect-environment");
    assert.ok(inspection.config?.includes(JSON.stringify(fs.realpathSync(root))));
    assert.equal(fs.existsSync(inspection.home), false, "setup home must be removed after completion");
  } finally {
    for (const [key, value] of [["GROK_BIN", previous.binary], ["GROK_AUTH_PATH", previous.auth]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(path.dirname(fake.binary), { recursive: true, force: true });
  }
});

test("setup rejects a project skill symlink escaping the ignored root", async () => {
  const root = initRepo();
  const outside = tempDir("setup-external-skill-");
  const destination = path.join(outside, "PRIVATE-SKILL.md");
  fs.writeFileSync(destination, "# private fixture");
  const skill = path.join(root, ".grok", "skills", "escape", "SKILL.md");
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.symlinkSync(destination, skill);
  const fake = installFakeGrok(tempDir("setup-escape-provider-"), { inspectProjectSkillPaths: [skill] });
  const previous = { binary: process.env.GROK_BIN, auth: process.env.GROK_AUTH_PATH };
  process.env.GROK_BIN = fake.binary;
  process.env.GROK_AUTH_PATH = fake.authPath;
  const state = tempDir("setup-escape-state-");
  try {
    await assert.rejects(() => probe(root, state), (error) => {
      assert.equal(error.code, "E_CAPABILITY");
      assert.equal(error.details.probe, "isolated-extensions");
      assert.deepEqual(error.details.contamination, ["skills"]);
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE-SKILL|private-project-skill/);
      assert.equal(JSON.stringify(error).includes(outside), false);
      return true;
    });
    const inspection = readFakeLog(fake.logFile).find((event) => event.event === "inspect-environment");
    assert.equal(fs.existsSync(inspection.home), false);
  } finally {
    for (const [key, value] of [["GROK_BIN", previous.binary], ["GROK_AUTH_PATH", previous.auth]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const directory of [root, outside, state, path.dirname(fake.binary)]) fs.rmSync(directory, { recursive: true, force: true });
  }
});
