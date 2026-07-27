#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const relative of ["scripts/validate.mjs", "scripts/test-deterministic.mjs"]) {
  const result = spawnSync(process.execPath, [path.join(ROOT, relative)], {
    cwd: ROOT,
    env: process.env,
    shell: false,
    stdio: "inherit"
  });
  if (result.error) {
    process.stderr.write("A deterministic repository gate could not start.\n");
    process.exit(1);
  }
  if (result.signal) {
    process.stderr.write(`A deterministic repository gate ended by signal ${result.signal}.\n`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(Number.isInteger(result.status) ? result.status : 1);
}
