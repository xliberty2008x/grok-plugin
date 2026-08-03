#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { validateChangelogHistoryAgainstBase } from "./lib/version-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG = "plugins/grok/CHANGELOG.md";
const args = process.argv.slice(2);

if (args.length > 1 || args.includes("--help") || args.includes("-h")) {
  process.stderr.write("Usage: node scripts/check-release-history.mjs [base-ref]\n");
  process.exit(args.length === 1 ? 0 : 2);
}

function inferredBaseRef() {
  if (process.env.GITHUB_EVENT_NAME === "pull_request") {
    const branch = String(process.env.GITHUB_BASE_REF || "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) {
      throw new Error("Pull-request release history requires a valid GITHUB_BASE_REF.");
    }
    return `origin/${branch}`;
  }
  return "HEAD^";
}

const baseRef = args[0] || inferredBaseRef();
if (!/^[A-Za-z0-9][A-Za-z0-9._/@{}~^+-]*$/.test(baseRef)) {
  process.stderr.write(`ERROR: Invalid release-history base ref: ${baseRef || "missing"}.\n`);
  process.exit(2);
}

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  }).trimEnd();
}

let baseCommit;
let baseChangelog;
try {
  baseCommit = git(["rev-parse", "--verify", `${baseRef}^{commit}`]);
  baseChangelog = execFileSync("git", ["show", `${baseCommit}:${CHANGELOG}`], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
} catch (error) {
  const detail = String(error?.stderr || error?.message || error).trim();
  process.stderr.write(`ERROR: Could not read ${CHANGELOG} from ${baseRef}: ${detail}\n`);
  process.exit(1);
}

const currentChangelog = fs.readFileSync(path.join(ROOT, CHANGELOG), "utf8");
const errors = validateChangelogHistoryAgainstBase(currentChangelog, baseChangelog);
if (errors.length) {
  for (const error of errors) process.stderr.write(`ERROR: ${error}\n`);
  process.exit(1);
}

process.stdout.write(`Release history preserves ${CHANGELOG} from ${baseRef} (${baseCommit}).\n`);
