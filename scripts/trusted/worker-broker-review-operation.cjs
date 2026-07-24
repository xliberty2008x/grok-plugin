#!/usr/bin/env node
"use strict";

/**
 * Main-only process boundary for protected Worker Broker review operations.
 *
 * This module deliberately exports nothing. The verified ESM bootstrap starts
 * it as a fresh process, and it in turn starts the evidence runtime as another
 * fresh direct-main ESM process. The final engine-owned `import.meta.main`
 * boundary and private evidence-runtime functions—not `require.main` alone—
 * prevent caller-controlled module imports from reaching proof execution or
 * evidence publication through a library API.
 */

const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");
const { spawnSync } = require("node:child_process");

const CLEAN_PATH = "/usr/bin:/bin";
const MAX_STDIN_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const CHILD_MARKER = "worker-broker-review-operation-v1";
const FORBIDDEN_ENVIRONMENT = Object.freeze([
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "VSCODE_INSPECTOR_OPTIONS"
]);

function trustFailure() {
  process.stdout.write(
    `${JSON.stringify({ ok: false, code: "E_REVIEW_TRUST_UNAVAILABLE" }, null, 2)}\n`
  );
  process.exitCode = 1;
}

function exactArguments(argv) {
  const mode = argv[0];
  const allowed = mode === "promote"
    ? new Set(["--workspace", "--request"])
    : new Set(["verify", "prove-phase-2", "verify-phase-2"]).has(mode)
      ? new Set(["--workspace"])
      : null;
  if (!allowed || argv.length !== 1 + allowed.size * 2) return false;
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag)
      || seen.has(flag)
      || typeof value !== "string"
      || !value
      || value.startsWith("--")) {
      return false;
    }
    seen.add(flag);
  }
  return seen.size === allowed.size;
}

function cleanProcess() {
  return process.platform !== "win32"
    && typeof process.getuid === "function"
    && process.getuid() !== 0
    && process.execArgv.length === 0
    && process.env.PATH === CLEAN_PATH
    && !FORBIDDEN_ENVIRONMENT.some((name) => Object.hasOwn(process.env, name));
}

function readBoundedStdin() {
  const input = fs.readFileSync(0);
  if (input.byteLength > MAX_STDIN_BYTES) throw new Error("stdin exceeds bound");
  return input;
}

function main() {
  if (!cleanProcess() || !exactArguments(process.argv.slice(2))) {
    trustFailure();
    return;
  }
  let input;
  try {
    input = readBoundedStdin();
  } catch {
    trustFailure();
    return;
  }
  const runtime = path.resolve(
    __dirname,
    "../lib/worker-broker-evidence.mjs"
  );
  const result = spawnSync(
    process.execPath,
    [runtime, ...process.argv.slice(2)],
    {
      cwd: path.resolve(__dirname, "../.."),
      env: {
        PATH: CLEAN_PATH,
        LANG: "C",
        LC_ALL: "C",
        TZ: "UTC",
        GROK_PROTECTED_OPERATION_CHILD: CHILD_MARKER
      },
      input,
      encoding: "utf8",
      shell: false,
      timeout: 35 * 60_000,
      maxBuffer: MAX_OUTPUT_BYTES
    }
  );
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  if (result.error
    || result.signal
    || !new Set([0, 1]).has(result.status)
    || stderr !== ""
    || Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
    trustFailure();
    return;
  }
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    trustFailure();
    return;
  }
  if (!payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || payload.ok !== (result.status === 0)) {
    trustFailure();
    return;
  }
  process.stdout.write(stdout);
  process.exitCode = result.status;
}

if (require.main === module) {
  try {
    main();
  } catch {
    trustFailure();
  }
}

Object.freeze(module.exports);
