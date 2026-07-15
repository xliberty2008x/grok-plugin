#!/usr/bin/env node
/**
 * Post a Grok companion review job JSON as a GitHub PR COMMENT review.
 *
 * Usage:
 *   node scripts/ci/post-grok-review.mjs \
 *     --job-json <path> \
 *     --diff <path> \
 *     --owner <owner> \
 *     --repo <repo> \
 *     --pr <number> \
 *     --head-sha <sha> \
 *     [--dry-run]
 *
 * Requires GH_TOKEN or GITHUB_TOKEN in env unless --dry-run.
 * Never reads GROK_AUTH_*.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { collectRightSideLines } from "./lib/diff-right-lines.mjs";
import { buildPrReviewPayload } from "./lib/build-pr-review-payload.mjs";

function usage() {
  return `Usage: node post-grok-review.mjs --job-json <path> --diff <path> --owner <o> --repo <r> --pr <n> --head-sha <sha> [--dry-run]`;
}

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--job-json") out.jobJson = argv[++i];
    else if (a === "--diff") out.diff = argv[++i];
    else if (a === "--owner") out.owner = argv[++i];
    else if (a === "--repo") out.repo = argv[++i];
    else if (a === "--pr") out.pr = argv[++i];
    else if (a === "--head-sha") out.headSha = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}\n${usage()}`);
  }
  for (const k of ["jobJson", "diff", "owner", "repo", "pr", "headSha"]) {
    if (!out[k]) throw new Error(`Missing --${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}\n${usage()}`);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const job = JSON.parse(fs.readFileSync(path.resolve(args.jobJson), "utf8"));
  const diffText = fs.readFileSync(path.resolve(args.diff), "utf8");
  const rightSideLines = collectRightSideLines(diffText);
  const built = buildPrReviewPayload({
    job,
    headSha: args.headSha,
    rightSideLines
  });

  if (built.skip) {
    console.log(`post-grok-review: skip (${built.reason})`);
    process.exit(0);
  }

  const payloadPath = path.join(
    process.env.RUNNER_TEMP || process.env.TMPDIR || "/tmp",
    `grok-pr-review-payload-${process.pid}.json`
  );
  fs.writeFileSync(payloadPath, JSON.stringify(built.payload, null, 2), { mode: 0o600 });

  if (args.dryRun) {
    console.log(JSON.stringify({ dryRun: true, payloadPath, payload: built.payload }, null, 2));
    process.exit(0);
  }

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("post-grok-review: GH_TOKEN or GITHUB_TOKEN required");
    process.exit(2);
  }

  const endpoint = `repos/${args.owner}/${args.repo}/pulls/${args.pr}/reviews`;
  const result = spawnSync(
    "gh",
    ["api", endpoint, "-X", "POST", "--input", payloadPath],
    {
      encoding: "utf8",
      env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
      shell: false
    }
  );

  try {
    fs.unlinkSync(payloadPath);
  } catch {
    /* ignore */
  }

  if (result.status !== 0) {
    console.error(result.stderr || result.stdout || "gh api failed");
    process.exit(result.status || 1);
  }
  console.log(result.stdout.trim());
  process.exit(0);
}

try {
  main();
} catch (error) {
  console.error(`post-grok-review: ${error.message || error}`);
  process.exit(1);
}
