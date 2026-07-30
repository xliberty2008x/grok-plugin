import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
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
import {
  TEST_TEMP_FILE_PREFIX,
  TEST_TEMP_ROOT_ENV,
  TEST_TEMP_RUN_PREFIX,
  canonicalSystemTempRoot,
  createOwnedTestTempRoot,
  newTestTempOwnerToken,
  removeOwnedTestTempRoot
} from "./test-temp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPORTER = path.join(ROOT, "scripts/lib/zero-skip-test-reporter.mjs");
const SUPERVISOR = path.join(ROOT, "scripts/lib/test-temp-supervisor.mjs");
export const DETERMINISTIC_TEST_FILE_TIMEOUT_MS = 10 * 60_000;
const DETERMINISTIC_SUPERVISOR_SHUTDOWN_ALLOWANCE_MS = 30_000;
const OUTPUT_LIMIT_EXIT_CODE = 125;
const CONTAINMENT_FAILURE_EXIT_CODE = 126;
const CONTAINMENT_REASON_PATTERN =
  /(?:^|\n)grok-plugin-containment-v1:(unsupported-platform|startup-visibility|visibility-monitor-token|visibility-monitor-proc|visibility-monitor-unknown|post-close-inspection|termination-incomplete-group|termination-incomplete-owned|termination-incomplete-unknown)(?:\n|$)/u;
const WORKER_BROKER_EVIDENCE_TEST =
  "tests/worker-broker-evidence.test.mjs";
const WORKER_BROKER_EVIDENCE_PARTITION_ENV =
  "GROK_PLUGIN_WORKER_BROKER_EVIDENCE_PARTITION";
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

function elapsedMilliseconds(startedAt, now) {
  try {
    const elapsed = Math.round(now() - startedAt);
    return Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : 0;
  } catch {
    return 0;
  }
}

/** Run an exact test inventory one file at a time and aggregate zero-skip output. */
export function runDeterministicTestFiles({
  files,
  root = ROOT,
  reporter = REPORTER,
  node = process.execPath,
  env = process.env,
  run = spawnSync,
  now = () => performance.now(),
  stdout = process.stdout,
  stderr = process.stderr,
  timeoutMs = DETERMINISTIC_TEST_FILE_TIMEOUT_MS,
  tempRoot = canonicalSystemTempRoot(),
  simulateStartupVisibilityFailure = false
} = {}) {
  if (!Array.isArray(files) || !files.length) {
    stderr.write("No deterministic test files were found.\n");
    return 1;
  }

  const aggregate = emptyAggregate();
  const knownSecrets = collectZeroSkipKnownSecrets(env);
  let failed = false;
  const ownerStartToken = newTestTempOwnerToken(process.pid);
  let runRoot;
  let preserveRunRoot = false;
  try {
    runRoot = createOwnedTestTempRoot({
      base: tempRoot,
      prefix: TEST_TEMP_RUN_PREFIX,
      kind: "run",
      startToken: ownerStartToken
    });
  } catch {
    stderr.write("The deterministic test temp root could not be created safely.\n");
    stdout.write(`${JSON.stringify(aggregate)}\n`);
    return 1;
  }

  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const child = index + 1;
      let result;
      let fileRoot;
      let containmentUnproven = false;
      let startFailed = false;
      let startedAt;
      try {
        startedAt = now();
      } catch {
        startedAt = 0;
      }
      // Emit only a fixed ordinal before the blocking child call. This keeps
      // paths, environment values, and child output private while allowing a
      // bounded CI timeout to identify the last child that actually started.
      stderr.write(`Deterministic test child ${child} started.\n`);
      try {
        fileRoot = createOwnedTestTempRoot({
          base: runRoot,
          prefix: TEST_TEMP_FILE_PREFIX,
          kind: "file",
          startToken: ownerStartToken
        });
        const childEnvironment = {
          ...env,
          TMPDIR: fileRoot,
          TMP: fileRoot,
          TEMP: fileRoot,
          [TEST_TEMP_ROOT_ENV]: fileRoot
        };
        if (file === WORKER_BROKER_EVIDENCE_TEST) {
          childEnvironment[WORKER_BROKER_EVIDENCE_PARTITION_ENV] = "1";
        } else {
          delete childEnvironment[WORKER_BROKER_EVIDENCE_PARTITION_ENV];
        }
        // A deterministic runner can itself be exercised from node:test.
        // The private harness marker must not turn the supervisor into an
        // unintended nested test worker.
        delete childEnvironment.NODE_TEST_CONTEXT;
        result = run(node, [
          SUPERVISOR,
          "--timeout-ms",
          String(timeoutMs),
          ...(simulateStartupVisibilityFailure
            ? ["--simulate-startup-visibility-failure"]
            : []),
          "--",
          node,
          "--test",
          `--test-reporter=${reporter}`,
          file
        ], {
          cwd: root,
          env: childEnvironment,
          shell: false,
          encoding: "utf8",
          timeout: timeoutMs + DETERMINISTIC_SUPERVISOR_SHUTDOWN_ALLOWANCE_MS,
          killSignal: "SIGKILL",
          maxBuffer: 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch {
        startFailed = true;
        failed = true;
        continue;
      } finally {
        const elapsed = elapsedMilliseconds(startedAt, now);
        stderr.write(startFailed
          ? `Deterministic test child ${child} could not start after ${elapsed} ms.\n`
          : `Deterministic test child ${child} completed in ${elapsed} ms.\n`);
        containmentUnproven = result?.status === CONTAINMENT_FAILURE_EXIT_CODE
          || result?.error?.code === "ETIMEDOUT"
          || Boolean(result?.signal);
        if (containmentUnproven) {
          preserveRunRoot = true;
          stderr.write(`Deterministic test child ${child} containment could not be proven.\n`);
          const containmentReason = CONTAINMENT_REASON_PATTERN.exec(
            String(result?.stderr || "")
          )?.[1];
          if (containmentReason) {
            stderr.write(`Deterministic containment reason: ${containmentReason}.\n`);
          }
          failed = true;
        } else if (fileRoot) {
          try {
            if (!removeOwnedTestTempRoot(fileRoot)) {
              throw new Error("The owned file root identity was unavailable.");
            }
          } catch {
            stderr.write(`Deterministic test child ${child} temp cleanup failed.\n`);
            preserveRunRoot = true;
            failed = true;
          }
        }
      }

      // A supervisor signal, outer timeout, or explicit containment failure is
      // terminal: cleanup ownership is unproven and the fixed diagnostic above
      // is the only safe detail to expose.
      if (containmentUnproven) break;

      // Never forward or interpolate raw child stderr, spawn error details, paths,
      // signals, or invalid stdout. Only fixed, ordinal diagnostics leave here.
      if (result?.status === 124) {
        stderr.write(`Deterministic test child ${child} timed out.\n`);
        failed = true;
        continue;
      }
      if (result?.status === OUTPUT_LIMIT_EXIT_CODE) {
        stderr.write(`Deterministic test child ${child} exceeded the output limit.\n`);
        failed = true;
        continue;
      }
      if (result?.error) {
        stderr.write(`Deterministic test child ${child} could not start.\n`);
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
  } finally {
    if (preserveRunRoot) {
      stderr.write("The deterministic test run temp root was preserved for stale reaping.\n");
    } else {
      try {
        if (!removeOwnedTestTempRoot(runRoot)) {
          throw new Error("The owned run root identity was unavailable.");
        }
      } catch {
        stderr.write("The deterministic test run temp cleanup failed.\n");
        failed = true;
      }
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
