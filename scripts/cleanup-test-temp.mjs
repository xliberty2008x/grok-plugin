#!/usr/bin/env node

import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_TEST_TEMP_MAX_AGE_MS,
  cleanupTestTemp
} from "./lib/test-temp-cleanup.mjs";

function usage() {
  return [
    "Usage: node scripts/cleanup-test-temp.mjs [--apply] [--legacy] [--older-than <duration>]",
    "",
    "Defaults to a dry run over manifest-backed test roots older than 1h.",
    "--legacy also admits exact checked-in legacy test prefixes.",
    "Durations use ms, s, m, h, or d (for example: 90m).",
    ""
  ].join("\n");
}

function durationMs(raw) {
  const match = /^([0-9]+)(ms|s|m|h|d)$/u.exec(String(raw));
  if (!match) throw new Error("Invalid --older-than duration.");
  const factors = { ms: 1, s: 1_000, m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 };
  const value = Number(match[1]) * factors[match[2]];
  if (!Number.isSafeInteger(value)) throw new Error("Invalid --older-than duration.");
  return value;
}

export function parseCleanupArgs(argv) {
  let apply = false;
  let legacy = false;
  let olderThanMs = DEFAULT_TEST_TEMP_MAX_AGE_MS;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") apply = true;
    else if (arg === "--legacy") legacy = true;
    else if (arg === "--older-than") {
      if (index + 1 >= argv.length) throw new Error("--older-than requires a duration.");
      olderThanMs = durationMs(argv[index += 1]);
    } else if (arg.startsWith("--older-than=")) {
      olderThanMs = durationMs(arg.slice("--older-than=".length));
    } else if (arg === "--help" || arg === "-h") {
      return { help: true, apply, legacy, olderThanMs };
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { help: false, apply, legacy, olderThanMs };
}

function main() {
  let options;
  try {
    options = parseCleanupArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }
  const result = cleanupTestTemp(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.aborted) return 2;
  if (options.apply && result.candidates.some((candidate) => candidate.eligible && !candidate.removed)) {
    return 1;
  }
  return 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invoked && invoked === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
