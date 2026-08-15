#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runLocalQualify } from "./lib/local-qualify.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  if (process.argv.length !== 2) {
    throw new Error("Usage: npm run qualify");
  }
  await runLocalQualify({ root: ROOT });
} catch (error) {
  process.stderr.write(`Local qualification failed: ${error.message}\n`);
  process.exitCode = 1;
}
