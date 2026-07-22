#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runDeterministicTestFiles } from "./lib/deterministic-test-runner.mjs";

export { runDeterministicTestFiles };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_ROOT = path.join(ROOT, "tests");
export const EXTERNAL_BOUNDARY_TESTS = Object.freeze([
  "installed-codex.test.mjs",
  "live-grok.test.mjs"
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

function main() {
  return runDeterministicTestFiles({ files: listDeterministicTestFiles() });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
