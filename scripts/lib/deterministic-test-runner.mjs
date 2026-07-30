import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
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
const TEST_PRE_COMMAND_DIAGNOSTIC =
  "grok-plugin-test-pre-command-v1:ready";
const MAX_TEST_PRE_COMMAND_DELAY_MS = 60_000;
const CONTAINMENT_REASON_PATTERN =
  /(?:^|\n)grok-plugin-containment-v1:(unsupported-platform|startup-visibility|visibility-monitor-token|visibility-monitor-proc|visibility-monitor-unknown|post-close-inspection|termination-incomplete-group|termination-incomplete-owned|termination-incomplete-unknown)(?:\n|$)/u;
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

/**
 * Async CLI orchestration owns the exact supervisor ChildProcess. This lets a
 * signal sent only to the CLI reach the supervisor while preserving the
 * synchronous API used by direct and injected callers.
 */
export async function runDeterministicTestFilesCli({
  files,
  root = ROOT,
  reporter = REPORTER,
  node = process.execPath,
  env = process.env,
  now = () => performance.now(),
  stdout = process.stdout,
  stderr = process.stderr,
  timeoutMs = DETERMINISTIC_TEST_FILE_TIMEOUT_MS,
  tempRoot = canonicalSystemTempRoot(),
  spawnProcess = spawn,
  simulateStartupVisibilityFailure = false,
  testPreCommandDelayMs = 0,
  onTestSupervisorPreCommandReady = null
} = {}) {
  if (!Array.isArray(files) || !files.length) {
    stderr.write("No deterministic test files were found.\n");
    return 1;
  }
  if (typeof spawnProcess !== "function") {
    stderr.write("The deterministic supervisor launcher is invalid.\n");
    return 1;
  }
  if (
    !Number.isSafeInteger(testPreCommandDelayMs)
    || testPreCommandDelayMs < 0
    || testPreCommandDelayMs > MAX_TEST_PRE_COMMAND_DELAY_MS
    || (
      onTestSupervisorPreCommandReady !== null
      && typeof onTestSupervisorPreCommandReady !== "function"
    )
    || (
      onTestSupervisorPreCommandReady !== null
      && testPreCommandDelayMs === 0
    )
  ) {
    stderr.write("The deterministic test-only supervisor delay is invalid.\n");
    return 1;
  }

  const aggregate = emptyAggregate();
  const knownSecrets = collectZeroSkipKnownSecrets(env);
  let failed = false;
  let interrupted = false;
  let interruptionReported = false;
  let activeSupervisor = null;
  const forwardSignal = (signal) => {
    interrupted = true;
    const supervisor = activeSupervisor;
    if (!supervisor || supervisor.exitCode !== null || supervisor.signalCode !== null) return;
    try {
      supervisor.kill(signal);
    } catch (error) {
      if (error?.code !== "ESRCH") {
        stderr.write("The deterministic CLI signal could not be forwarded safely.\n");
        failed = true;
      }
    }
  };
  const onInterrupt = () => forwardSignal("SIGINT");
  const onTerminate = () => forwardSignal("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);

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
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    stderr.write("The deterministic test temp root could not be created safely.\n");
    stdout.write(`${JSON.stringify(aggregate)}\n`);
    return 1;
  }

  try {
    for (let index = 0; index < files.length && !interrupted; index += 1) {
      const file = files[index];
      const childOrdinal = index + 1;
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
      stderr.write(`Deterministic test child ${childOrdinal} started.\n`);
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
        delete childEnvironment.NODE_TEST_CONTEXT;
        const childArguments = [
          SUPERVISOR,
          "--timeout-ms",
          String(timeoutMs),
          ...(simulateStartupVisibilityFailure
            ? ["--simulate-startup-visibility-failure"]
            : []),
          ...(testPreCommandDelayMs > 0
            ? [
                "--test-delay-before-command-ms",
                String(testPreCommandDelayMs)
              ]
            : []),
          "--",
          node,
          "--test",
          `--test-reporter=${reporter}`,
          file
        ];
        let supervisor;
        try {
          supervisor = spawnProcess(node, childArguments, {
            cwd: root,
            env: childEnvironment,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"]
          });
        } catch {
          startFailed = true;
          failed = true;
          continue;
        }
        activeSupervisor = supervisor;
        const stdoutChunks = [];
        const stderrChunks = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let outputOverflow = false;
        let outerTimedOut = false;
        let spawnError = false;
        let spawnErrorWithPid = false;
        let testPreCommandObserved = false;
        let testPreCommandDiagnosticBuffer = "";
        const collect = (chunks, chunk, previousBytes) => {
          const nextBytes = previousBytes + chunk.length;
          if (nextBytes <= 1024 * 1024) chunks.push(chunk);
          else if (!outputOverflow) {
            outputOverflow = true;
            try { supervisor.kill("SIGKILL"); } catch {}
          }
          return nextBytes;
        };
        supervisor.stdout.on("data", (chunk) => {
          stdoutBytes = collect(stdoutChunks, chunk, stdoutBytes);
        });
        supervisor.stderr.on("data", (chunk) => {
          stderrBytes = collect(stderrChunks, chunk, stderrBytes);
          if (
            testPreCommandDelayMs > 0
            && !testPreCommandObserved
          ) {
            const diagnosticText =
              testPreCommandDiagnosticBuffer + chunk.toString("utf8");
            testPreCommandDiagnosticBuffer = diagnosticText.slice(
              -(TEST_PRE_COMMAND_DIAGNOSTIC.length + 2)
            );
            if (diagnosticText.includes(TEST_PRE_COMMAND_DIAGNOSTIC)) {
              testPreCommandObserved = true;
              if (onTestSupervisorPreCommandReady) {
                try {
                  onTestSupervisorPreCommandReady(Object.freeze({
                    supervisorPid: supervisor.pid
                  }));
                } catch {
                  failed = true;
                  try { supervisor.kill("SIGTERM"); } catch {}
                }
              }
            }
          }
        });
        let watchdog;
        const closeResult = await new Promise((resolve) => {
          let settled = false;
          const finish = (code, signal) => {
            if (settled) return;
            settled = true;
            activeSupervisor = null;
            resolve({ code, signal });
          };
          supervisor.once("error", () => {
            spawnError = true;
            spawnErrorWithPid = Number.isSafeInteger(supervisor.pid)
              && supervisor.pid > 0;
            finish(null, null);
          });
          supervisor.once("close", (code, signal) => {
            finish(code, signal);
          });
          watchdog = setTimeout(() => {
            outerTimedOut = true;
            try { supervisor.kill("SIGKILL"); } catch {}
            // The exact child was signalled after the supervisor already
            // exceeded its teardown allowance. Do not depend on a subsequent
            // close event: return fail-closed and preserve the owned run root.
            finish(null, null);
          }, timeoutMs + DETERMINISTIC_SUPERVISOR_SHUTDOWN_ALLOWANCE_MS);
        });
        clearTimeout(watchdog);
        activeSupervisor = null;
        result = {
          status: closeResult.code,
          signal: closeResult.signal,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          error: outerTimedOut
            ? { code: "ETIMEDOUT" }
            : outputOverflow
              ? { code: "ENOBUFS" }
              : spawnErrorWithPid
                ? { code: "E_TEST_TEMP_CONTAINMENT" }
              : spawnError
                ? { code: "E_TEST_TEMP_START" }
                : null
        };
      } catch {
        startFailed = true;
        failed = true;
        continue;
      } finally {
        activeSupervisor = null;
        const elapsed = elapsedMilliseconds(startedAt, now);
        stderr.write(startFailed
          ? `Deterministic test child ${childOrdinal} could not start after ${elapsed} ms.\n`
          : `Deterministic test child ${childOrdinal} completed in ${elapsed} ms.\n`);
        containmentUnproven = result?.status === CONTAINMENT_FAILURE_EXIT_CODE
          || result?.error?.code === "ETIMEDOUT"
          || result?.error?.code === "ENOBUFS"
          || result?.error?.code === "E_TEST_TEMP_CONTAINMENT"
          || Boolean(result?.signal);
        if (containmentUnproven) {
          preserveRunRoot = true;
          stderr.write(`Deterministic test child ${childOrdinal} containment could not be proven.\n`);
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
            stderr.write(`Deterministic test child ${childOrdinal} temp cleanup failed.\n`);
            preserveRunRoot = true;
            failed = true;
          }
        }
      }

      if (containmentUnproven) break;
      if (result?.status === 130 || interrupted) {
        interrupted = true;
        interruptionReported = true;
        stderr.write("The deterministic test run was interrupted.\n");
        failed = true;
        break;
      }
      if (result?.status === 124) {
        stderr.write(`Deterministic test child ${childOrdinal} timed out.\n`);
        failed = true;
        continue;
      }
      if (result?.status === OUTPUT_LIMIT_EXIT_CODE) {
        stderr.write(`Deterministic test child ${childOrdinal} exceeded the output limit.\n`);
        failed = true;
        continue;
      }
      if (result?.error) {
        stderr.write(`Deterministic test child ${childOrdinal} could not start.\n`);
        failed = true;
        continue;
      }

      const summary = parseZeroSkipSummary(result?.stdout, root, knownSecrets);
      if (!summary) {
        stderr.write(`Deterministic test child ${childOrdinal} emitted an invalid zero-skip summary.\n`);
        failed = true;
        continue;
      }
      const nextCounts = safeAggregateCounts(aggregate, summary);
      if (!nextCounts) {
        stderr.write(`Deterministic test child ${childOrdinal} could not be aggregated safely.\n`);
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
        stderr.write(`Deterministic test child ${childOrdinal} failed its zero-skip gate.\n`);
        failed = true;
      }
    }
  } finally {
    activeSupervisor = null;
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
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    if (interrupted && !interruptionReported) {
      stderr.write("The deterministic test run was interrupted.\n");
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

/**
 * Run an exact test inventory synchronously for programmatic callers and
 * injected test doubles. Do not use this API as a process entrypoint:
 * spawnSync prevents JavaScript signal forwarding while the child is active.
 * Every shipped CLI entrypoint uses runDeterministicTestFilesCli instead.
 */
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
  let interrupted = false;
  let interruptionReported = false;
  const recordInterruption = () => {
    interrupted = true;
  };
  process.on("SIGINT", recordInterruption);
  process.on("SIGTERM", recordInterruption);
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
    process.removeListener("SIGINT", recordInterruption);
    process.removeListener("SIGTERM", recordInterruption);
    stderr.write("The deterministic test temp root could not be created safely.\n");
    stdout.write(`${JSON.stringify(aggregate)}\n`);
    return 1;
  }

  try {
    for (let index = 0; index < files.length && !interrupted; index += 1) {
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
      if (result?.status === 130 || interrupted) {
        interrupted = true;
        interruptionReported = true;
        stderr.write("The deterministic test run was interrupted.\n");
        failed = true;
        break;
      }

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
    process.removeListener("SIGINT", recordInterruption);
    process.removeListener("SIGTERM", recordInterruption);
    if (interrupted && !interruptionReported) {
      stderr.write("The deterministic test run was interrupted.\n");
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
