import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  ZERO_SKIP_MAX_SUMMARY_BYTES,
  ZERO_SKIP_MAX_VIOLATIONS,
  ZERO_SKIP_REPORTER_ID,
  ZERO_SKIP_SUMMARY_FIELDS,
  collectZeroSkipKnownSecrets,
  sanitizeZeroSkipFile,
  validateZeroSkipSummary
} from "./zero-skip-test-reporter.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPORTER = path.join(ROOT, "scripts/lib/zero-skip-test-reporter.mjs");
const NONPASS_FIELDS = Object.freeze([
  "failed",
  "cancelled",
  "skipped",
  "todo"
]);

function parseZeroSkipSummary(output, root, knownSecrets) {
  if (typeof output !== "string") return null;
  if (Buffer.byteLength(output, "utf8") > ZERO_SKIP_MAX_SUMMARY_BYTES) return null;
  const match = /^([^\r\n]+)(?:\r?\n)?$/u.exec(output);
  if (!match) return null;
  if (match[1] !== match[1].trim()) return null;

  let summary;
  try {
    summary = JSON.parse(match[1]);
  } catch {
    return null;
  }
  return validateZeroSkipSummary(summary, { root, knownSecrets }) ? summary : null;
}

function safeAggregateCounts(aggregate, summary) {
  const next = {};
  for (const field of ZERO_SKIP_SUMMARY_FIELDS) {
    if (aggregate[field] > Number.MAX_SAFE_INTEGER - summary[field]) return null;
    next[field] = aggregate[field] + summary[field];
  }
  if (nonpassCount(next) === null) return null;
  let total = 0;
  for (const field of ZERO_SKIP_SUMMARY_FIELDS) {
    if (total > Number.MAX_SAFE_INTEGER - next[field]) return null;
    total += next[field];
  }
  return next;
}

function nonpassCount(summary) {
  let total = 0;
  for (const field of NONPASS_FIELDS) {
    if (total > Number.MAX_SAFE_INTEGER - summary[field]) return null;
    total += summary[field];
  }
  return total;
}

function emptyAggregate() {
  return {
    reporter: ZERO_SKIP_REPORTER_ID,
    passed: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    violations: [],
    omittedViolations: 0
  };
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

  const aggregate = emptyAggregate();
  const knownSecrets = collectZeroSkipKnownSecrets(env);
  let failed = false;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const child = index + 1;
    let result;
    // Emit only a fixed ordinal before the blocking child call. This keeps
    // paths, environment values, and child output private while allowing a
    // bounded CI timeout to identify the last child that actually started.
    stderr.write(`Deterministic test child ${child} started.\n`);
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
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch {
      stderr.write(`Deterministic test child ${child} could not start.\n`);
      failed = true;
      continue;
    }

    // Never forward or interpolate raw child stderr, spawn error details, paths,
    // signals, or invalid stdout. Only fixed, ordinal diagnostics leave here.
    if (result?.error) {
      stderr.write(`Deterministic test child ${child} could not start.\n`);
      failed = true;
      continue;
    }
    if (result?.signal) {
      stderr.write(`Deterministic test child ${child} ended by a signal.\n`);
      failed = true;
      continue;
    }

    const summary = parseZeroSkipSummary(result?.stdout, root, knownSecrets);
    if (!summary) {
      stderr.write(`Deterministic test child ${child} emitted an invalid zero-skip summary.\n`);
      failed = true;
      continue;
    }

    const nextCounts = safeAggregateCounts(aggregate, summary);
    if (!nextCounts) {
      stderr.write(`Deterministic test child ${child} could not be aggregated safely.\n`);
      failed = true;
      continue;
    }
    Object.assign(aggregate, nextCounts);

    const fallbackFile = sanitizeZeroSkipFile(file, root, knownSecrets);
    for (const violation of summary.violations) {
      if (aggregate.violations.length >= ZERO_SKIP_MAX_VIOLATIONS) break;
      aggregate.violations.push({
        ...violation,
        file: violation.file ?? fallbackFile
      });
    }

    if (result.status !== 0
      || summary.passed === 0
      || summary.failed > 0
      || summary.cancelled > 0
      || summary.skipped > 0
      || summary.todo > 0) {
      stderr.write(`Deterministic test child ${child} failed its zero-skip gate.\n`);
      failed = true;
    }
  }

  const aggregateNonpass = nonpassCount(aggregate);
  if (aggregateNonpass === null || aggregateNonpass < aggregate.violations.length) {
    stderr.write("The deterministic test aggregate could not be represented safely.\n");
    aggregate.violations = [];
    aggregate.omittedViolations = aggregateNonpass === null ? 0 : aggregateNonpass;
    failed = true;
  } else {
    aggregate.omittedViolations = aggregateNonpass - aggregate.violations.length;
  }

  stdout.write(`${JSON.stringify(aggregate)}\n`);
  return failed ? 1 : 0;
}
