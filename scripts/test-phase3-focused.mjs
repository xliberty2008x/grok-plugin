#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runDeterministicTestFiles } from "./lib/deterministic-test-runner.mjs";

/**
 * Fixed Phase 3 proof inventory. It covers execution binding, managed-root
 * leases, official worktree/session ownership, immutable artifacts, explicit
 * integration/verification/abandon/cleanup, MCP projection, and the live
 * receipt contract. Provider execution remains an external gate.
 */
export const PHASE3_FOCUSED_TEST_FILES = Object.freeze([
  "tests/acp-client.test.mjs",
  "tests/grok-worktree-acp.test.mjs",
  "tests/provider-bootstrap-crash-window.test.mjs",
  "tests/provider-capability.test.mjs",
  "tests/provider.test.mjs",
  "tests/recursion-guard.test.mjs",
  "tests/state.test.mjs",
  "tests/worker-dispatch-supervisor.test.mjs",
  "tests/worker-execution-binding.test.mjs",
  "tests/worker-launch-outbox.test.mjs",
  "tests/worker-mutation.test.mjs",
  "tests/worker-owner-controller.test.mjs",
  "tests/worker-owner-lifecycle.test.mjs",
  "tests/worker-protocol.test.mjs",
  "tests/worker-service.test.mjs",
  "tests/worker-session-close-environment.test.mjs",
  "tests/worker-worktree.test.mjs",
  "tests/mcp-worker-broker.test.mjs",
  "tests/mcp-worker-runtime.test.mjs",
  "tests/installed-worker-mcp-contract.test.mjs",
  "tests/installed-worker-mcp-runner.test.mjs",
  "tests/worker-broker-phase3-evidence.test.mjs"
]);

export function runPhaseThreeFocusedTests(options = {}) {
  return runDeterministicTestFiles({
    ...options,
    files: PHASE3_FOCUSED_TEST_FILES
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = runPhaseThreeFocusedTests();
}
