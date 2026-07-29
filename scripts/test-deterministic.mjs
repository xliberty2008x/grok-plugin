#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runDeterministicTestFiles } from "./lib/deterministic-test-runner.mjs";
import {
  DETERMINISTIC_TEST_SHARDS,
  parseDeterministicShardArgument,
  selectDeterministicTestFiles,
  validateDeterministicTestShards
} from "./lib/deterministic-test-shards.mjs";

export { runDeterministicTestFiles };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_ROOT = path.join(ROOT, "tests");
export const EXTERNAL_BOUNDARY_TESTS = Object.freeze([
  "installed-codex.test.mjs",
  "live-grok.test.mjs",
  "worker-broker-protected-review.test.mjs"
]);

export function listDeterministicTestFiles(testRoot = TEST_ROOT) {
  const excluded = new Set(EXTERNAL_BOUNDARY_TESTS);
  return fs.readdirSync(testRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile()
      && entry.name.endsWith(".test.mjs")
      && !excluded.has(entry.name))
    .map((entry) => `tests/${entry.name}`)
    .sort();
}

export function main(argv = process.argv.slice(2)) {
  let shard;
  try {
    shard = parseDeterministicShardArgument(argv);
  } catch {
    process.stderr.write(
      "Usage: node scripts/test-deterministic.mjs [--shard=1/3|--shard=2/3|--shard=3/3]\n"
    );
    return 1;
  }

  const inventory = listDeterministicTestFiles();
  const manifestErrors = validateDeterministicTestShards({
    inventory,
    externalBoundaryTests: EXTERNAL_BOUNDARY_TESTS,
    shards: DETERMINISTIC_TEST_SHARDS
  });
  if (manifestErrors.length > 0) {
    process.stderr.write("The deterministic shard manifest does not match the test inventory.\n");
    for (const message of manifestErrors) {
      process.stderr.write(`${message}\n`);
    }
    return 1;
  }
  return runDeterministicTestFiles({
    files: selectDeterministicTestFiles({
      inventory,
      shard,
      shards: DETERMINISTIC_TEST_SHARDS
    })
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
