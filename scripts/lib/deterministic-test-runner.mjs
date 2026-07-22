import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPORTER = path.join(ROOT, "scripts/lib/zero-skip-test-reporter.mjs");
const SUMMARY_FIELDS = Object.freeze([
  "passed",
  "failed",
  "cancelled",
  "skipped",
  "todo"
]);

function parseZeroSkipSummary(output) {
  const text = typeof output === "string" ? output : String(output ?? "");
  const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length !== 1) return null;
  let summary;
  try {
    summary = JSON.parse(lines[0]);
  } catch {
    return null;
  }
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
  const expectedFields = ["reporter", ...SUMMARY_FIELDS].sort();
  if (JSON.stringify(Object.keys(summary).sort()) !== JSON.stringify(expectedFields)) return null;
  if (summary.reporter !== "zero-skip-v1") return null;
  if (SUMMARY_FIELDS.some((field) => !Number.isSafeInteger(summary[field]) || summary[field] < 0)) {
    return null;
  }
  return summary;
}

/** Run an exact test inventory one file at a time and aggregate zero-skip output. */
export function runDeterministicTestFiles({
  files,
  root = ROOT,
  reporter = REPORTER,
  node = process.execPath,
  env = process.env,
  run = spawnSync,
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  if (!Array.isArray(files) || !files.length) {
    stderr.write("No deterministic test files were found.\n");
    return 1;
  }

  const aggregate = Object.fromEntries(SUMMARY_FIELDS.map((field) => [field, 0]));
  let failed = false;
  for (const file of files) {
    let result;
    try {
      result = run(node, [
        "--test",
        `--test-reporter=${reporter}`,
        file
      ], {
        cwd: root,
        env,
        shell: false,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch {
      stderr.write(`The deterministic test file ${file} could not start.\n`);
      failed = true;
      continue;
    }

    if (result?.stderr) stderr.write(String(result.stderr));
    if (result?.error) {
      stderr.write(`The deterministic test file ${file} could not start.\n`);
      failed = true;
      continue;
    }
    if (result?.signal) {
      stderr.write(`The deterministic test file ${file} ended by signal ${result.signal}.\n`);
      failed = true;
      continue;
    }

    const summary = parseZeroSkipSummary(result?.stdout);
    if (!summary) {
      stderr.write(`The deterministic test file ${file} emitted an invalid zero-skip summary.\n`);
      failed = true;
      continue;
    }
    for (const field of SUMMARY_FIELDS) aggregate[field] += summary[field];

    if (result.status !== 0
      || summary.passed === 0
      || summary.failed > 0
      || summary.cancelled > 0
      || summary.skipped > 0
      || summary.todo > 0) {
      stderr.write(`The deterministic test file ${file} failed its zero-skip gate.\n`);
      failed = true;
    }
  }

  stdout.write(`${JSON.stringify({ reporter: "zero-skip-v1", ...aggregate })}\n`);
  return failed ? 1 : 0;
}
