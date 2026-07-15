#!/usr/bin/env node
/**
 * Stage GROK_AUTH_JSON and run trusted grok-companion review against a workspace.
 *
 * Usage:
 *   node run-trusted-review.mjs \
 *     --trusted-root <path> \
 *     --workspace <path> \
 *     --base-ref <git-ref-for-origin/base> \
 *     --out <review-job.json> \
 *     [--auth-json-env GROK_AUTH_JSON]
 *
 * Env:
 *   GROK_AUTH_JSON — raw auth.json contents (required unless GROK_AUTH_PATH already set to a file)
 *   GROK_BIN — optional path to grok binary
 *
 * Does not set or use GITHUB_TOKEN.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildReviewChildEnv } from "./lib/review-child-env.mjs";

function usage() {
  return `Usage: node run-trusted-review.mjs --trusted-root <dir> --workspace <dir> --base-ref <ref> --out <file>`;
}

function parseArgs(argv) {
  const out = { authJsonEnv: "GROK_AUTH_JSON" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--trusted-root") out.trustedRoot = path.resolve(argv[++i]);
    else if (a === "--workspace") out.workspace = path.resolve(argv[++i]);
    else if (a === "--base-ref") out.baseRef = argv[++i];
    else if (a === "--out") out.out = path.resolve(argv[++i]);
    else if (a === "--auth-json-env") out.authJsonEnv = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}\n${usage()}`);
  }
  for (const k of ["trustedRoot", "workspace", "baseRef", "out"]) {
    if (!out[k]) throw new Error(`Missing required flag\n${usage()}`);
  }
  return out;
}

function stageAuth(raw, destDir) {
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const dest = path.join(destDir, "auth.json");
  fs.writeFileSync(dest, raw, { mode: 0o600 });
  // re-apply mode for platforms that ignore writeFile mode
  fs.chmodSync(dest, 0o600);
  return dest;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const companion = path.join(
    args.trustedRoot,
    "plugins",
    "grok",
    "scripts",
    "grok-companion.mjs"
  );
  if (!fs.existsSync(companion)) {
    throw new Error(`Trusted companion not found: ${companion}`);
  }

  let authPath = process.env.GROK_AUTH_PATH || "";
  let staged = null;
  if (!authPath) {
    const raw = process.env[args.authJsonEnv];
    if (!raw || !String(raw).trim()) {
      console.error(
        `run-trusted-review: missing ${args.authJsonEnv} (or set GROK_AUTH_PATH to an existing auth file)`
      );
      process.exit(2);
    }
    const dir = path.join(process.env.RUNNER_TEMP || os.tmpdir(), `grok-ci-auth-${process.pid}`);
    staged = stageAuth(String(raw), dir);
    authPath = staged;
  } else if (!fs.existsSync(authPath)) {
    console.error(`run-trusted-review: GROK_AUTH_PATH does not exist: ${authPath}`);
    process.exit(2);
  }

  const base = args.baseRef.startsWith("origin/")
    ? args.baseRef
    : `origin/${args.baseRef}`;

  const env = buildReviewChildEnv({
    authPath,
    runId: process.env.GITHUB_RUN_ID,
    pathEnv: process.env.PATH,
    home: process.env.HOME,
    user: process.env.USER,
    logname: process.env.LOGNAME,
    tmpdir: process.env.TMPDIR,
    tmp: process.env.TMP,
    temp: process.env.TEMP,
    lang: process.env.LANG,
    runnerTemp: process.env.RUNNER_TEMP || os.tmpdir(),
    pid: process.pid,
    grokBin: process.env.GROK_BIN
  });

  fs.mkdirSync(env.CLAUDE_PLUGIN_DATA, { recursive: true, mode: 0o700 });

  const result = spawnSync(
    process.execPath,
    [
      companion,
      "review",
      "--wait",
      "--json",
      "--scope",
      "branch",
      "--base",
      base
    ],
    {
      cwd: args.workspace,
      env,
      encoding: "utf8",
      shell: false,
      maxBuffer: 32 * 1024 * 1024
    }
  );

  if (result.stdout) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, result.stdout, "utf8");
  }
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    console.error(
      `run-trusted-review: companion exited ${result.status}`
    );
    process.exit(result.status || 1);
  }

  // Validate JSON parseable and looks complete enough for poster
  let job;
  try {
    job = JSON.parse(result.stdout);
  } catch {
    console.error("run-trusted-review: companion stdout is not JSON");
    process.exit(1);
  }
  if (job?.ok === false) {
    console.error(
      `run-trusted-review: companion error ${job.error?.code || ""} ${job.error?.message || ""}`
    );
    process.exit(1);
  }
  if (job?.status && job.status !== "completed") {
    console.error(`run-trusted-review: unexpected status ${job.status}`);
    process.exit(1);
  }

  console.log(`run-trusted-review: wrote ${args.out}`);
  process.exit(0);
}

try {
  main();
} catch (error) {
  console.error(`run-trusted-review: ${error.message || error}`);
  process.exit(1);
}
