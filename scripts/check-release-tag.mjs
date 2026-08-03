#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  activeVersionForPlan,
  qualificationEvidencePath,
  qualificationSourceDigest,
  validateQualificationEvidence,
  validateReleasePlan,
  validateReleaseTag,
  validateReleaseTagRef
} from "./lib/version-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const environmentTag = process.env.GITHUB_REF_TYPE === "tag"
  ? process.env.GITHUB_REF_NAME
  : null;
let tag = null;
let requireRef = false;
let mainRef = null;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--require-ref") {
    requireRef = true;
  } else if (arg === "--main-ref") {
    mainRef = args[index + 1] || null;
    index += 1;
  } else if (!arg.startsWith("-") && tag == null) {
    tag = arg;
  } else {
    process.stderr.write(`ERROR: Unknown release-tag argument: ${arg}.\n`);
    process.stderr.write("Usage: node scripts/check-release-tag.mjs <tag> [--require-ref --main-ref <ref>]\n");
    process.exit(2);
  }
}
tag ||= environmentTag;

if (!tag || (requireRef && !mainRef) || (!requireRef && mainRef)) {
  process.stderr.write("Usage: node scripts/check-release-tag.mjs <tag> [--require-ref --main-ref <ref>]\n");
  process.exit(2);
}

function readJson(relative, { optional = false } = {}) {
  const absolute = path.join(ROOT, relative);
  if (optional && !fs.existsSync(absolute)) return null;
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

const initialRefErrors = requireRef
  ? validateReleaseTagRef(ROOT, tag, mainRef)
  : [];

const versionCheck = spawnSync(process.execPath, [
  path.join(ROOT, "scripts", "validate.mjs"),
  "--versions-only"
], {
  cwd: ROOT,
  encoding: "utf8",
  env: {
    ...process.env,
    GITHUB_REF_TYPE: "branch",
    GITHUB_REF_NAME: ""
  }
});
if (versionCheck.status !== 0) {
  process.stderr.write(versionCheck.stdout || "");
  process.stderr.write(versionCheck.stderr || "");
  process.exit(versionCheck.status ?? 1);
}

const packageJson = readJson("package.json");
const releasePlan = readJson("release-plan.json");
const activeVersion = packageJson.version;
const errors = [
  ...initialRefErrors,
  ...validateReleasePlan(releasePlan),
  ...validateReleaseTag(tag, releasePlan, activeVersion)
];

if (releasePlan.stage !== "development") {
  const evidencePath = qualificationEvidencePath(releasePlan.targetVersion);
  const evidence = readJson(evidencePath, { optional: true });
  let sourceDigest = null;
  try {
    sourceDigest = qualificationSourceDigest(ROOT);
  } catch (error) {
    errors.push(`Could not resolve the current qualification source digest: ${error.message}`);
  }
  errors.push(...validateQualificationEvidence(releasePlan, evidence, { sourceDigest }));
}

if (activeVersionForPlan(releasePlan) !== activeVersion) {
  errors.push(`Package version ${activeVersion} is not the active release-plan version.`);
}

if (requireRef) {
  errors.push(...validateReleaseTagRef(ROOT, tag, mainRef));
}

if (errors.length) {
  for (const error of [...new Set(errors)]) process.stderr.write(`ERROR: ${error}\n`);
  process.exit(1);
}

process.stdout.write(`Release tag ${tag} matches ${activeVersion} (${releasePlan.stage})${requireRef ? ` and is annotated on exact ${mainRef}` : ""}.\n`);
