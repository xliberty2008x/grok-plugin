import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  activeVersionForPlan,
  expectedReadmeStatusForStage,
  expectedTargetVersion,
  parseSemver,
  qualificationEvidencePath,
  qualificationSourceDigest,
  releaseTagForVersion,
  validateChangelogHistoryAgainstBase,
  validateChangelogVersionHistory,
  validateQualificationEvidence,
  validateReadmeReleaseStatus,
  validateReleasePlan,
  validateRepositoryNpmConfig,
  validateReleaseScripts,
  validateReleaseTag,
  validateReleaseTagRef
} from "../scripts/lib/version-policy.mjs";
import { ROOT, tempDir } from "./helpers.mjs";

test("version taxonomy maps breaking 0.x work to the next minor line", () => {
  assert.equal(expectedTargetVersion("0.2.0", "patch"), "0.2.1");
  assert.equal(expectedTargetVersion("0.2.0", "feature"), "0.3.0");
  assert.equal(expectedTargetVersion("0.2.0", "breaking"), "0.3.0");
  assert.equal(expectedTargetVersion("1.4.2", "breaking"), "2.0.0");
  assert.equal(parseSemver("0.3.0-dev.2")?.preRelease, "dev.2");
  assert.equal(parseSemver("00.3.0"), null);
  assert.equal(parseSemver("0.3.0-dev.02"), null);
  assert.equal(parseSemver("0.3.0-rc.01"), null);
});

test("release plan drives the synchronized active development version", () => {
  const plan = JSON.parse(fs.readFileSync(`${ROOT}/release-plan.json`, "utf8"));
  const packageJson = JSON.parse(fs.readFileSync(`${ROOT}/package.json`, "utf8"));
  assert.deepEqual(validateReleasePlan(plan), []);
  assert.equal(activeVersionForPlan(plan), packageJson.version);
  assert.equal(plan.targetVersion, "0.3.0");
});

test("release plan rejects reused or under-bumped versions", () => {
  const base = {
    schemaVersion: 1,
    baseVersion: "0.2.0",
    changeClass: "breaking",
    targetVersion: "0.2.0",
    stage: "development",
    preRelease: "dev.0",
    supportedHosts: ["codex", "claude-code"],
    reasons: ["Contract changed."]
  };
  assert.match(validateReleasePlan(base).join(" "), /targetVersion must be 0\.3\.0/);
  assert.match(validateReleasePlan({ ...base, targetVersion: "0.3.0", preRelease: null }).join(" "), /requires preRelease dev\.N/);
  assert.match(validateReleasePlan({ ...base, targetVersion: "0.3.0", preRelease: "dev.02" }).join(" "), /requires preRelease dev\.N/);
});

test("plugin release tags exactly bind the active version and exclude infrastructure pins", () => {
  const plan = {
    schemaVersion: 1,
    baseVersion: "0.2.0",
    changeClass: "breaking",
    targetVersion: "0.3.0",
    stage: "development",
    preRelease: "dev.2",
    supportedHosts: ["codex", "claude-code"],
    reasons: ["Structural hardening snapshot."]
  };
  assert.equal(releaseTagForVersion("0.3.0-dev.2"), "v0.3.0-dev.2");
  assert.equal(releaseTagForVersion("invalid"), null);
  assert.equal(releaseTagForVersion("0.3.0-dev.02"), null);
  assert.deepEqual(validateReleaseTag("v0.3.0-dev.2", plan, "0.3.0-dev.2"), []);
  assert.match(validateReleaseTag("v0.3.0-dev.1", plan, "0.3.0-dev.2").join(" "), /must be v0\.3\.0-dev\.2/);
  assert.match(validateReleaseTag("grok-review-runtime-" + "a".repeat(40), plan, "0.3.0-dev.2").join(" "), /infrastructure-pin namespace/);
  assert.match(validateReleaseTag("v0.3.0-rc.1", {
    ...plan,
    stage: "release_candidate",
    preRelease: "rc.1"
  }, "0.3.0-rc.1").join(" "), /protected external release attestation/);
  assert.match(validateReleaseTag("v0.3.0", {
    ...plan,
    stage: "release",
    preRelease: null
  }, "0.3.0").join(" "), /repository-authored qualification JSON is necessary but not sufficient/);
});

test("changelog versions are unique and strictly newest-first", () => {
  const changelog = fs.readFileSync(`${ROOT}/plugins/grok/CHANGELOG.md`, "utf8");
  assert.deepEqual(validateChangelogVersionHistory("0.3.0-dev.2", changelog), []);
  const reused = changelog.replace("## 0.3.0-dev.2", "## 0.3.0-dev.1");
  const reuseErrors = validateChangelogVersionHistory("0.3.0-dev.1", reused).join(" ");
  assert.match(reuseErrors, /must be unique/);
  assert.match(reuseErrors, /must be newer than/);
  const reordered = changelog.replace(
    "## 0.3.0-dev.2",
    "## 0.3.0-dev.0"
  );
  assert.match(validateChangelogVersionHistory("0.3.0-dev.0", reordered).join(" "), /must be newer than 0\.3\.0-dev\.1/);
  assert.match(validateChangelogVersionHistory("0.3.0-dev.02", changelog.replace(
    "## 0.3.0-dev.2",
    "## 0.3.0-dev.02"
  )).join(" "), /is not valid SemVer/);
});

test("new changelog sections preserve the previously merged suffix byte-for-byte", () => {
  const devOne = "# Changelog\n\n## 0.3.0-dev.1\n\n- Existing history.\n\n## 0.2.0\n\n- Stable history.\n";
  const devTwo = "# Changelog\n\n## 0.3.0-dev.2\n\n- New snapshot.\n\n" + devOne.slice("# Changelog\n\n".length);
  assert.deepEqual(validateChangelogHistoryAgainstBase(devTwo, devOne), []);
  assert.match(
    validateChangelogHistoryAgainstBase(devTwo.replace("Stable history", "Edited history"), devOne).join(" "),
    /byte-for-byte unchanged/
  );
  assert.match(
    validateChangelogHistoryAgainstBase(devOne.replace("Existing history", "Edited current section"), devOne).join(" "),
    /add a newer version section/
  );
  assert.match(
    validateChangelogHistoryAgainstBase(devOne, devTwo).join(" "),
    /beginning at 0\.3\.0-dev\.2/
  );
});

test("annotated release-tag refs bind a clean working tree to exact HEAD and main", () => {
  const root = tempDir("grok-release-tag-ref-");
  const commit = (message) => execFileSync("git", [
    "-c", "user.name=Test",
    "-c", "user.email=test@example.invalid",
    "commit", "-qam", message
  ], { cwd: root });
  fs.writeFileSync(path.join(root, "payload.txt"), "one\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  commit("one");
  execFileSync("git", ["branch", "audit/main"], { cwd: root });
  execFileSync("git", [
    "-c", "user.name=Test",
    "-c", "user.email=test@example.invalid",
    "tag", "-a", "v0.3.0-dev.2", "-m", "snapshot"
  ], { cwd: root });
  assert.deepEqual(validateReleaseTagRef(root, "v0.3.0-dev.2", "audit/main"), []);

  fs.writeFileSync(path.join(root, "payload.txt"), "dirty\n");
  assert.match(validateReleaseTagRef(root, "v0.3.0-dev.2", "audit/main").join(" "), /requires a clean tracked and untracked working tree/);
  fs.writeFileSync(path.join(root, "payload.txt"), "one\n");
  fs.writeFileSync(path.join(root, "untracked.txt"), "dirty\n");
  assert.match(validateReleaseTagRef(root, "v0.3.0-dev.2", "audit/main").join(" "), /requires a clean tracked and untracked working tree/);
  fs.unlinkSync(path.join(root, "untracked.txt"));

  execFileSync("git", ["update-index", "--assume-unchanged", "payload.txt"], { cwd: root });
  fs.writeFileSync(path.join(root, "payload.txt"), "hidden dirty\n");
  assert.match(validateReleaseTagRef(root, "v0.3.0-dev.2", "audit/main").join(" "), /forbids skip-worktree and assume-unchanged/);
  execFileSync("git", ["update-index", "--no-assume-unchanged", "payload.txt"], { cwd: root });
  fs.writeFileSync(path.join(root, "payload.txt"), "one\n");
  execFileSync("git", ["update-index", "--skip-worktree", "payload.txt"], { cwd: root });
  fs.writeFileSync(path.join(root, "payload.txt"), "hidden dirty again\n");
  assert.match(validateReleaseTagRef(root, "v0.3.0-dev.2", "audit/main").join(" "), /forbids skip-worktree and assume-unchanged/);
  execFileSync("git", ["update-index", "--no-skip-worktree", "payload.txt"], { cwd: root });
  fs.writeFileSync(path.join(root, "payload.txt"), "one\n");

  execFileSync("git", ["tag", "-d", "v0.3.0-dev.2"], { cwd: root });
  execFileSync("git", ["tag", "v0.3.0-dev.2"], { cwd: root });
  assert.match(validateReleaseTagRef(root, "v0.3.0-dev.2", "audit/main").join(" "), /must be an annotated tag object/);
  execFileSync("git", ["tag", "-d", "v0.3.0-dev.2"], { cwd: root });
  execFileSync("git", [
    "-c", "user.name=Test",
    "-c", "user.email=test@example.invalid",
    "tag", "-a", "v0.3.0-dev.2", "-m", "snapshot"
  ], { cwd: root });

  fs.writeFileSync(path.join(root, "payload.txt"), "two\n");
  commit("two");
  const targetMismatch = validateReleaseTagRef(root, "v0.3.0-dev.2", "HEAD").join(" ");
  assert.match(targetMismatch, /checked-out HEAD/);
  assert.match(targetMismatch, /but HEAD is/);

  execFileSync("git", [
    "-c", "user.name=Test",
    "-c", "user.email=test@example.invalid",
    "tag", "-a", "v0.3.0-dev.3", "-m", "next snapshot"
  ], { cwd: root });
  assert.match(validateReleaseTagRef(root, "v0.3.0-dev.3", "audit/main").join(" "), /but audit\/main is/);
});

test("release workflow npm scripts cannot be redirected", () => {
  const scripts = JSON.parse(fs.readFileSync(`${ROOT}/package.json`, "utf8")).scripts;
  assert.deepEqual(validateReleaseScripts(scripts), []);
  assert.match(validateReleaseScripts({
    ...scripts,
    "release:history:check": "node -e true"
  }).join(" "), /release:history:check must execute node scripts\/check-release-history\.mjs directly/);
  assert.match(validateReleaseScripts({
    ...scripts,
    "release:tag:check": "node -e true"
  }).join(" "), /release:tag:check must execute node scripts\/check-release-tag\.mjs directly/);
  assert.deepEqual(validateRepositoryNpmConfig(null), []);
  assert.deepEqual(validateRepositoryNpmConfig("# script-shell=/usr/bin/true\nregistry=https://registry.npmjs.org/\n"), []);
  assert.match(validateRepositoryNpmConfig("script-shell=/usr/bin/true\n").join(" "), /must not set script-shell/);
  assert.match(validateRepositoryNpmConfig("SCRIPT_SHELL = .\/scripts\/wrapper.sh\n").join(" "), /must not set script-shell/);
});

test("version bump and tag helpers remain aligned with extracted runtime clients", () => {
  const packageJson = JSON.parse(fs.readFileSync(`${ROOT}/package.json`, "utf8"));
  const dryRun = execFileSync(process.execPath, [
    `${ROOT}/scripts/bump-version.mjs`,
    packageJson.version,
    "--dry-run"
  ], { cwd: ROOT, encoding: "utf8" });
  assert.match(dryRun, /No files required changes\./);

  const tag = `v${packageJson.version}`;
  const tagCheck = execFileSync(process.execPath, [
    `${ROOT}/scripts/check-release-tag.mjs`,
    tag
  ], { cwd: ROOT, encoding: "utf8" });
  assert.match(tagCheck, new RegExp(`Release tag ${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} matches`));
  const historyCheck = execFileSync(process.execPath, [
    `${ROOT}/scripts/check-release-history.mjs`,
    "HEAD"
  ], { cwd: ROOT, encoding: "utf8" });
  assert.match(historyCheck, /Release history preserves/);
  assert.throws(() => execFileSync(process.execPath, [
    `${ROOT}/scripts/check-release-tag.mjs`,
    "v9.9.9"
  ], { cwd: ROOT, encoding: "utf8", stdio: "pipe" }));
});

test("README status follows development, release-candidate, and stable stages", () => {
  const cases = [
    ["development", "0.3.0-dev.2", "Development hardening prerelease; unqualified and not release-ready or stable"],
    ["release_candidate", "0.3.0-rc.1", "Release candidate; unqualified and not release-ready or stable"],
    ["release", "0.3.0", "Stable release"]
  ];
  for (const [stage, version, status] of cases) {
    const readme = `| **Version** | \`${version}\` |\n| **Status** | ${status} |\n`;
    assert.equal(expectedReadmeStatusForStage(stage), status);
    assert.deepEqual(validateReadmeReleaseStatus(readme, { stage }, version), []);
  }
  const stale = "| **Version** | `0.3.0-rc.1` |\n| **Status** | Development hardening prerelease; unqualified and not release-ready or stable |\n";
  assert.match(validateReadmeReleaseStatus(stale, { stage: "release_candidate" }, "0.3.0-rc.1").join(" "), /Release candidate/);
});

test("RC and release promotion require current dual-host machine-readable qualification evidence", () => {
  const sourceDigest = "b".repeat(64);
  const host = {
    installedArtifactDigest: "c".repeat(64),
    os: "macOS 26.5",
    nodeVersion: "22.0.0",
    hostVersion: "0.143.0",
    grokVersion: "0.2.101",
    authenticatedProvider: false,
    naturalHostFlow: false,
    boundaries: {
      runtime_ingress: "passed",
      artifact_install: "passed",
      provider_transport: "passed",
      worker_execution: "passed"
    }
  };
  const base = {
    schemaVersion: 1,
    targetVersion: "0.3.0",
    sourceCommit: "a".repeat(40),
    sourceDigest,
    recordedAt: "2026-07-14T12:00:00.000Z",
    hosts: { codex: host, "claude-code": host }
  };
  const rcPlan = { stage: "release_candidate", targetVersion: "0.3.0", supportedHosts: ["codex", "claude-code"] };
  assert.equal(qualificationEvidencePath("0.3.0"), "tests/e2e-results/qualification-0.3.0.json");
  assert.match(validateQualificationEvidence(rcPlan, null).join(" "), /requires one machine-readable/);
  assert.deepEqual(validateQualificationEvidence(rcPlan, base, { sourceDigest }), []);
  assert.match(validateQualificationEvidence(rcPlan, { ...base, sourceDigest: "d".repeat(64) }, { sourceDigest }).join(" "), /does not match the current qualification source/);
  assert.match(validateQualificationEvidence(rcPlan, { ...base, hosts: { codex: host } }, { sourceDigest }).join(" "), /claude-code host record/);

  const releasePlan = { stage: "release", targetVersion: "0.3.0", supportedHosts: ["codex", "claude-code"] };
  const releaseErrors = validateQualificationEvidence(releasePlan, base, { sourceDigest }).join(" ");
  assert.match(releaseErrors, /host_orchestration/);
  assert.match(releaseErrors, /authenticated provider/);
  assert.match(releaseErrors, /natural host flow/);
  const qualifiedHost = {
    ...host,
    authenticatedProvider: true,
    naturalHostFlow: true,
    boundaries: { ...host.boundaries, host_orchestration: "passed", host_verification: "passed" }
  };
  const qualified = {
    ...base,
    hosts: { codex: qualifiedHost, "claude-code": qualifiedHost }
  };
  assert.deepEqual(validateQualificationEvidence(releasePlan, qualified, { sourceDigest }), []);
});

test("qualification source digest survives its evidence commit but detects later source changes", () => {
  const root = tempDir("grok-qualification-digest-");
  fs.mkdirSync(path.join(root, "tests", "e2e-results"), { recursive: true });
  fs.writeFileSync(path.join(root, "source.mjs"), "export const value = 1;\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "source"], { cwd: root });
  const qualified = qualificationSourceDigest(root);

  fs.writeFileSync(path.join(root, "tests", "e2e-results", "qualification-0.3.0.json"), "{}\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "record evidence"], { cwd: root });
  assert.equal(qualificationSourceDigest(root), qualified);

  fs.writeFileSync(path.join(root, "source.mjs"), "export const value = 2;\n");
  assert.notEqual(qualificationSourceDigest(root), qualified);
});
