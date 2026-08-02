import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const CHANGE_CLASSES = new Set(["patch", "feature", "breaking"]);
const STAGES = new Set(["development", "release_candidate", "release"]);

export function parseSemver(value) {
  const match = String(value || "").match(SEMVER);
  if (!match) return null;
  if (match[4]?.split(".").some((identifier) => /^\d+$/.test(identifier) && !/^(?:0|[1-9]\d*)$/.test(identifier))) {
    return null;
  }
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

export function releaseTagForVersion(version) {
  return parseSemver(version) ? `v${version}` : null;
}

export function validateReleaseTag(tag, plan, activeVersion) {
  const errors = [];
  const plannedVersion = activeVersionForPlan(plan);
  if (plannedVersion !== activeVersion) {
    errors.push(`Active release-plan version (${plannedVersion ?? "invalid"}) must match package version ${activeVersion ?? "missing"} before tagging.`);
  }
  const expectedTag = releaseTagForVersion(activeVersion);
  if (expectedTag == null) {
    errors.push("Plugin release tags require a valid active SemVer package version.");
  } else if (tag !== expectedTag) {
    errors.push(`Plugin release tag must be ${expectedTag}; received ${tag || "missing"}.`);
  }
  if (String(tag || "").startsWith("grok-review-runtime-")) {
    errors.push("grok-review-runtime-<commit> is the separate infrastructure-pin namespace, not a plugin release tag.");
  }
  if (plan?.stage !== "development") {
    errors.push("RC and stable tags require a protected external release attestation bound to the exact version, source commit, source digest, both supported hosts, and authoritative receipt digests; repository-authored qualification JSON is necessary but not sufficient.");
  }
  return errors;
}

export function validateReleaseTagRef(root, tag, mainRef) {
  const errors = [];
  const runGit = (args, description, { trim = true } = {}) => {
    try {
      const output = execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"]
      });
      return trim ? output.trim() : output;
    } catch (error) {
      const detail = String(error?.stderr || error?.stdout || error?.message || error).trim();
      errors.push(`${description}: ${detail || "unknown git failure"}`);
      return null;
    }
  };

  const status = runGit(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    "Could not inspect release-tag worktree cleanliness",
    { trim: false }
  );
  if (status != null && status.length !== 0) {
    errors.push("Release-tag object validation requires a clean tracked and untracked working tree so validated files are exactly the tagged HEAD payload.");
  }
  const trackedFlags = runGit(
    ["ls-files", "-v", "-z"],
    "Could not inspect release-tag index visibility flags",
    { trim: false }
  );
  const hiddenTrackedPath = trackedFlags?.split("\0").filter(Boolean).some((entry) => {
    const flag = entry[0] || "";
    return flag === "S" || flag !== flag.toUpperCase();
  });
  if (hiddenTrackedPath) {
    errors.push("Release-tag object validation forbids skip-worktree and assume-unchanged index flags because they can hide payload drift from Git status.");
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._/@{}~^+-]*$/.test(String(mainRef || ""))) {
    errors.push(`Release tag main ref is invalid: ${mainRef || "missing"}.`);
    return errors;
  }

  const tagRef = `refs/tags/${tag}`;
  const tagType = runGit(["cat-file", "-t", tagRef], `Could not inspect ${tagRef}`);
  if (tagType != null && tagType !== "tag") {
    errors.push(`${tagRef} must be an annotated tag object; found ${tagType || "missing"}.`);
  }
  const tagCommit = runGit(["rev-parse", "--verify", `${tagRef}^{commit}`], `Could not dereference ${tagRef}`);
  const headCommit = runGit(["rev-parse", "--verify", "HEAD^{commit}"], "Could not resolve HEAD");
  const mainCommit = runGit(["rev-parse", "--verify", `${mainRef}^{commit}`], `Could not resolve ${mainRef}`);
  if (tagCommit && headCommit && tagCommit !== headCommit) {
    errors.push(`${tagRef} targets ${tagCommit}, but the checked-out HEAD is ${headCommit}.`);
  }
  if (tagCommit && mainCommit && tagCommit !== mainCommit) {
    errors.push(`${tagRef} targets ${tagCommit}, but ${mainRef} is ${mainCommit}.`);
  }
  return errors;
}

export function validateReleaseScripts(scripts) {
  const expected = {
    "release:history:check": "node scripts/check-release-history.mjs",
    "release:tag:check": "node scripts/check-release-tag.mjs"
  };
  const errors = [];
  for (const [name, command] of Object.entries(expected)) {
    if (scripts?.[name] !== command) {
      errors.push(`${name} must execute ${command} directly.`);
    }
  }
  return errors;
}

export function validateRepositoryNpmConfig(npmrc) {
  if (npmrc == null) return [];
  const unsafe = String(npmrc)
    .split(/\r?\n/u)
    .some((line) => !/^\s*[#;]/u.test(line) && /^\s*script[-_]shell\s*=/iu.test(line));
  return unsafe
    ? ["Repository .npmrc must not set script-shell; authoritative release gates invoke Node entrypoints directly."]
    : [];
}

function comparePrerelease(left, right) {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const count = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < count; index += 1) {
    if (leftParts[index] == null) return -1;
    if (rightParts[index] == null) return 1;
    const leftNumeric = /^\d+$/.test(leftParts[index]);
    const rightNumeric = /^\d+$/.test(rightParts[index]);
    if (leftNumeric && rightNumeric) {
      const difference = Number(leftParts[index]) - Number(rightParts[index]);
      if (difference !== 0) return difference;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return 0;
}

function compareParsedSemver(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    const difference = left[key] - right[key];
    if (difference !== 0) return difference;
  }
  return comparePrerelease(left.preRelease, right.preRelease);
}

function changelogVersionEntries(changelog) {
  const entries = [];
  const pattern = /^##\s+([^\s]+)\s*$/gmu;
  for (let match = pattern.exec(String(changelog || "")); match; match = pattern.exec(String(changelog || ""))) {
    entries.push({ version: match[1], index: match.index });
  }
  return entries;
}

export function validateChangelogVersionHistory(activeVersion, changelog) {
  const errors = [];
  const entries = changelogVersionEntries(changelog);
  if (entries.length === 0) return ["Changelog must contain at least one version heading."];
  if (entries[0].version !== activeVersion) {
    errors.push(`First changelog version (${entries[0].version}) must match active package version ${activeVersion}.`);
  }
  const seen = new Set();
  let newer = null;
  for (const entry of entries) {
    const parsed = parseSemver(entry.version);
    if (!parsed) {
      errors.push(`Changelog version heading ${entry.version} is not valid SemVer.`);
      newer = null;
      continue;
    }
    if (seen.has(entry.version)) errors.push(`Changelog version heading ${entry.version} must be unique.`);
    seen.add(entry.version);
    if (newer && compareParsedSemver(newer.parsed, parsed) <= 0) {
      errors.push(`Changelog versions must be strictly newest-first; ${newer.version} must be newer than ${entry.version}.`);
    }
    newer = { version: entry.version, parsed };
  }
  return errors;
}

export function validateChangelogHistoryAgainstBase(currentChangelog, baseChangelog) {
  const current = String(currentChangelog || "");
  const base = String(baseChangelog || "");
  const currentEntries = changelogVersionEntries(current);
  const baseEntries = changelogVersionEntries(base);
  if (currentEntries.length === 0 || baseEntries.length === 0) {
    return ["Current and base changelogs must each contain a version heading."];
  }
  if (currentEntries[0].version === baseEntries[0].version) {
    return current === base
      ? []
      : [`Published changelog version ${baseEntries[0].version} must remain byte-for-byte unchanged; add a newer version section instead.`];
  }
  const baseSuffix = base.slice(baseEntries[0].index);
  if (!current.endsWith(baseSuffix)) {
    return [`Previously merged changelog history beginning at ${baseEntries[0].version} must remain byte-for-byte unchanged.`];
  }
  return [];
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
  if (plan.stage === "development" && !/^dev\.(?:0|[1-9]\d*)$/.test(String(plan.preRelease || ""))) {
    errors.push("development stage requires preRelease dev.N.");
  }
  if (plan.stage === "release_candidate" && !/^rc\.(?:0|[1-9]\d*)$/.test(String(plan.preRelease || ""))) {
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
