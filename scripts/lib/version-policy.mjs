import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?$/;
const CHANGE_CLASSES = new Set(["patch", "feature", "breaking"]);
const STAGES = new Set(["development", "release_candidate", "release"]);

export function parseSemver(value) {
  const match = String(value || "").match(SEMVER);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    preRelease: match[4] || null
  };
}

export function expectedTargetVersion(baseVersion, changeClass) {
  const base = parseSemver(baseVersion);
  if (!base || base.preRelease) throw new Error("baseVersion must be a stable SemVer value.");
  if (!CHANGE_CLASSES.has(changeClass)) throw new Error(`Unsupported changeClass: ${changeClass}`);
  if (changeClass === "patch") return `${base.major}.${base.minor}.${base.patch + 1}`;
  if (changeClass === "feature" || base.major === 0) return `${base.major}.${base.minor + 1}.0`;
  return `${base.major + 1}.0.0`;
}

export function activeVersionForPlan(plan) {
  if (!plan || plan.stage === "release") return plan?.targetVersion || null;
  return plan.preRelease ? `${plan.targetVersion}-${plan.preRelease}` : null;
}

export function expectedReadmeStatusForStage(stage) {
  if (stage === "development") return "Development hardening prerelease; unqualified and not release-ready or stable";
  if (stage === "release_candidate") return "Release candidate; unqualified and not release-ready or stable";
  if (stage === "release") return "Stable release";
  return null;
}

export function validateReadmeReleaseStatus(readme, plan, activeVersion) {
  const errors = [];
  const text = String(readme || "");
  const documentedVersion = text.match(/^\|\s*\*\*Version\*\*\s*\|\s*`([^`]+)`\s*\|\s*$/m)?.[1] || null;
  if (documentedVersion !== activeVersion) {
    errors.push(`README current version (${documentedVersion ?? "missing"}) must match active package version ${activeVersion}.`);
  }
  const documentedStatus = text.match(/^\|\s*\*\*Status\*\*\s*\|\s*(.*?)\s*\|\s*$/m)?.[1] || null;
  const expectedStatus = expectedReadmeStatusForStage(plan?.stage);
  if (!expectedStatus || documentedStatus !== expectedStatus) {
    errors.push(`README status (${documentedStatus ?? "missing"}) must be ${expectedStatus ?? "valid for the release stage"}.`);
  }
  return errors;
}

export function qualificationEvidencePath(targetVersion) {
  return `tests/e2e-results/qualification-${targetVersion}.json`;
}

function qualificationRecord(relative) {
  return /^tests\/e2e-results\/qualification-[^/]+\.json$/.test(relative);
}

export function qualificationSourceDigest(root) {
  const output = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024
  });
  const files = [...new Set(output.toString("utf8").split("\0").filter(Boolean))]
    .filter((relative) => !qualificationRecord(relative))
    .sort();
  const inventory = files.map((relative) => {
    const absolute = path.join(root, ...relative.split("/"));
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(absolute);
      return { path: relative, type: "symlink", sha256: crypto.createHash("sha256").update(target).digest("hex") };
    }
    if (!stat.isFile()) throw new Error(`Qualification source contains unsupported path type: ${relative}`);
    return {
      path: relative,
      type: "file",
      sha256: crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")
    };
  });
  return crypto.createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
}

export function validateQualificationEvidence(plan, evidence, current = {}) {
  if (plan?.stage === "development") return [];
  const errors = [];
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return ["RC/release promotion requires one machine-readable qualification evidence object."];
  }
  if (evidence.schemaVersion !== 1) errors.push("Qualification evidence schemaVersion must be 1.");
  if (evidence.targetVersion !== plan?.targetVersion) errors.push(`Qualification evidence targetVersion must be ${plan?.targetVersion}.`);
  if (!/^[a-f0-9]{40}$/i.test(String(evidence.sourceCommit || ""))) errors.push("Qualification evidence requires a 40-hex sourceCommit for provenance.");
  if (!/^[a-f0-9]{64}$/i.test(String(evidence.sourceDigest || ""))) errors.push("Qualification evidence requires a 64-hex sourceDigest.");
  if (current.sourceDigest && evidence.sourceDigest !== current.sourceDigest) {
    errors.push(`Qualification evidence sourceDigest ${evidence.sourceDigest || "missing"} does not match the current qualification source ${current.sourceDigest}.`);
  }
  if (!Number.isFinite(Date.parse(evidence.recordedAt || ""))) errors.push("Qualification evidence requires an ISO recordedAt timestamp.");
  const rcBoundaries = ["runtime_ingress", "artifact_install", "provider_transport", "worker_execution"];
  const releaseBoundaries = [...rcBoundaries, "host_orchestration", "host_verification"];
  const supportedHosts = Array.isArray(plan?.supportedHosts) ? plan.supportedHosts : [];
  for (const host of supportedHosts) {
    const hostEvidence = evidence.hosts?.[host];
    if (!hostEvidence || typeof hostEvidence !== "object" || Array.isArray(hostEvidence)) {
      errors.push(`Qualification evidence requires a ${host} host record.`);
      continue;
    }
    if (!/^[a-f0-9]{64}$/i.test(String(hostEvidence.installedArtifactDigest || ""))) {
      errors.push(`${host} qualification requires a 64-hex installedArtifactDigest.`);
    }
    for (const field of ["os", "nodeVersion", "hostVersion", "grokVersion"]) {
      if (typeof hostEvidence[field] !== "string" || !hostEvidence[field].trim()) errors.push(`${host} qualification requires ${field}.`);
    }
    if (typeof hostEvidence.authenticatedProvider !== "boolean") errors.push(`${host} qualification requires authenticatedProvider boolean.`);
    if (typeof hostEvidence.naturalHostFlow !== "boolean") errors.push(`${host} qualification requires naturalHostFlow boolean.`);
    for (const boundary of plan?.stage === "release" ? releaseBoundaries : rcBoundaries) {
      if (hostEvidence.boundaries?.[boundary] !== "passed") errors.push(`${host} qualification boundary ${boundary} must be passed for ${plan?.stage}.`);
    }
    if (plan?.stage === "release" && hostEvidence.authenticatedProvider !== true) {
      errors.push(`${host} release qualification requires an authenticated provider run.`);
    }
    if (plan?.stage === "release" && hostEvidence.naturalHostFlow !== true) {
      errors.push(`${host} release qualification requires an installed natural host flow.`);
    }
  }
  return errors;
}

export function validateReleasePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return ["Release plan must be one JSON object."];
  if (plan.schemaVersion !== 1) errors.push("schemaVersion must be 1.");

  const base = parseSemver(plan.baseVersion);
  if (!base || base.preRelease) errors.push("baseVersion must be a stable SemVer value.");
  if (!CHANGE_CLASSES.has(plan.changeClass)) errors.push("changeClass must be patch, feature, or breaking.");
  const target = parseSemver(plan.targetVersion);
  if (!target || target.preRelease) errors.push("targetVersion must be a stable SemVer value.");

  if (base && !base.preRelease && CHANGE_CLASSES.has(plan.changeClass) && target && !target.preRelease) {
    const expected = expectedTargetVersion(plan.baseVersion, plan.changeClass);
    if (plan.targetVersion !== expected) {
      errors.push(`targetVersion must be ${expected} for ${plan.changeClass} changes from ${plan.baseVersion}.`);
    }
  }

  if (!STAGES.has(plan.stage)) errors.push("stage must be development, release_candidate, or release.");
  if (plan.stage === "development" && !/^dev\.\d+$/.test(String(plan.preRelease || ""))) {
    errors.push("development stage requires preRelease dev.N.");
  }
  if (plan.stage === "release_candidate" && !/^rc\.\d+$/.test(String(plan.preRelease || ""))) {
    errors.push("release_candidate stage requires preRelease rc.N.");
  }
  if (plan.stage === "release" && plan.preRelease != null) {
    errors.push("release stage must omit preRelease.");
  }
  if (!Array.isArray(plan.supportedHosts)
    || plan.supportedHosts.length !== 2
    || !plan.supportedHosts.includes("codex")
    || !plan.supportedHosts.includes("claude-code")
    || new Set(plan.supportedHosts).size !== plan.supportedHosts.length) {
    errors.push("supportedHosts must list codex and claude-code exactly once for this dual-host package.");
  }
  if (!Array.isArray(plan.reasons) || plan.reasons.length === 0
    || plan.reasons.some((reason) => typeof reason !== "string" || !reason.trim() || reason.length > 500)) {
    errors.push("reasons must contain one or more non-empty strings of at most 500 characters.");
  }
  return errors;
}
