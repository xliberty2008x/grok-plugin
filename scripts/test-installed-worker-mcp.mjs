#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { classifyInstalledWorkerMcpCleanupOutcome, formatInstalledWorkerMcpFailure, selectInstalledWorkerMcpFailure } from "./lib/installed-worker-mcp-failure.mjs";
import { HELP, LIVE_GATES, QualificationError, QUALIFICATION_STAGES, TWO_WRITER_HELP, WRITE_SMOKE_HELP, enterQualificationStage, fail, qualificationStage } from "./lib/installed-worker-mcp-runner-core.mjs";
import { emergencyCleanup } from "./lib/installed-worker-mcp-runner-cancellation-cleanup.mjs";
import { qualify } from "./lib/installed-worker-mcp-runner-qualification.mjs";
import "./lib/installed-worker-mcp-runner-setup.mjs";
import "./lib/installed-worker-mcp-runner-runtime.mjs";
import "./lib/installed-worker-mcp-runner-observation.mjs";
import "./lib/installed-worker-mcp-runner-session-read.mjs";
import "./lib/installed-worker-mcp-runner-write-two.mjs";
import "./lib/installed-worker-mcp-runner-write-scenarios.mjs";
async function main() {
  const argv = process.argv.slice(2);
  if (
    argv.length === 2
    && ["--write-smoke", "--two-writer"].includes(argv[0])
    && (argv[1] === "--help" || argv[1] === "-h")
  ) {
    process.stdout.write(
      argv[0] === "--two-writer" ? TWO_WRITER_HELP : WRITE_SMOKE_HELP
    );
    return;
  }
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(HELP);
    return;
  }
  const writeSmoke = argv.length === 1 && argv[0] === "--write-smoke";
  const twoWriter = argv.length === 1 && argv[0] === "--two-writer";
  if (argv.length !== 0 && !writeSmoke && !twoWriter) fail("E_ARGUMENT");
  if (LIVE_GATES.some((name) => process.env[name] !== "1")) fail("E_GATE");
  if (
    (writeSmoke || twoWriter)
    && process.env.GROK_WORKER_WRITE_E2E !== "1"
  ) {
    fail("E_GATE");
  }
  if (
    twoWriter
    && process.env.GROK_WORKER_TWO_WRITER_E2E !== "1"
  ) {
    fail("E_GATE");
  }
  if (process.platform === "win32") fail("E_PLATFORM");

  const runner = {
    interrupted: false,
    temporaryRoot: null,
    temporaryRemoved: false,
    provider: null,
    providerBinary: null,
    setupBoundary: null,
    clients: new Set(),
    sessions: new Map(),
    turnIds: new Set(),
    trackers: [],
    writeSmoke: null
  };
  const interrupt = () => { runner.interrupted = true; };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const evidence = await qualify(runner, { writeSmoke, twoWriter });
    if (writeSmoke || twoWriter) {
      process.stdout.write(`${JSON.stringify(evidence)}\n`);
    } else {
      process.stdout.write(
        "Installed Worker MCP E2E passed; one provisional synthetic direct-MCP receipt was published.\n"
      );
    }
  } catch (error) {
    const originalCode = error instanceof QualificationError
      ? error.code
      : "E_SCENARIO";
    const originalStage = error instanceof QualificationError
      ? error.stage
      : qualificationStage;
    enterQualificationStage("emergency-cleanup");
    let cleanupOutcome = "proof-returned-false";
    try {
      cleanupOutcome = classifyInstalledWorkerMcpCleanupOutcome(
        await emergencyCleanup(runner)
      );
    } catch {
      cleanupOutcome = "cleanup-threw";
    }
    const selected = selectInstalledWorkerMcpFailure({
      originalCode,
      originalStage,
      cleanupOutcome
    }, QUALIFICATION_STAGES);
    throw new QualificationError(
      selected.code,
      selected.stage,
      selected.diagnostic
    );
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

const IS_MAIN = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_MAIN) {
  main().catch((error) => {
    process.stderr.write(
      formatInstalledWorkerMcpFailure(
        error instanceof QualificationError
          ? {
              code: error.code,
              stage: error.stage,
              diagnostic: error.diagnostic
            }
          : {
              code: "E_SCENARIO",
              stage: "startup",
              diagnostic: null
            },
        QUALIFICATION_STAGES
      )
    );
    process.exitCode = 1;
  });
}
