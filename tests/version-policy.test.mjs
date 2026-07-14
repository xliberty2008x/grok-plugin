import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  activeVersionForPlan,
  expectedReadmeStatusForStage,
  expectedTargetVersion,
  qualificationEvidencePath,
  qualificationSourceDigest,
  validateQualificationEvidence,
  validateReadmeReleaseStatus,
  validateReleasePlan
} from "../scripts/lib/version-policy.mjs";
import { ROOT, tempDir } from "./helpers.mjs";

test("version taxonomy maps breaking 0.x work to the next minor line", () => {
  assert.equal(expectedTargetVersion("0.2.0", "patch"), "0.2.1");
  assert.equal(expectedTargetVersion("0.2.0", "feature"), "0.3.0");
  assert.equal(expectedTargetVersion("0.2.0", "breaking"), "0.3.0");
  assert.equal(expectedTargetVersion("1.4.2", "breaking"), "2.0.0");
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
