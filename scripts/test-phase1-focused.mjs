#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runDeterministicTestFiles } from "./lib/deterministic-test-runner.mjs";

/** Fixed Phase 1 proof inventory; callers cannot add, remove, or reorder tests. */
export const PHASE1_FOCUSED_TEST_FILES = Object.freeze([
  "tests/control-plane.test.mjs",
  "tests/process-control.test.mjs",
  "tests/provider.test.mjs",
  "tests/recursion-guard.test.mjs",
  "tests/runtime.test.mjs",
  "tests/worker-protocol.test.mjs",
  "tests/worker-service.test.mjs",
  "tests/worker-mailbox.test.mjs",
  "tests/mcp-worker-broker.test.mjs",
  "tests/mcp-worker-runtime.test.mjs",
  "tests/installed-worker-mcp-contract.test.mjs",
  "tests/installed-worker-mcp-runner.test.mjs",
  "tests/provider-bootstrap-crash-window.test.mjs",
  "tests/provider-capability.test.mjs",
  "tests/provider-startup-cancel.test.mjs",
  "tests/worker-reconcile-safety.test.mjs",
  "tests/worker-runtime-teardown.test.mjs",
  "tests/worker-startup-crash-window.test.mjs",
  "tests/worker-launch-outbox.test.mjs",
  "tests/worker-dispatch-supervisor.test.mjs",
  "tests/worker-provider-rotation-intent.test.mjs",
  "tests/worker-recovery-fence.test.mjs",
  "tests/worker-cli-authority.test.mjs",
  "tests/worker-terminal-intent.test.mjs",
  "tests/process-control-owned-identity.test.mjs",
  "tests/worker-mutation.test.mjs",
  "tests/worker-safety-proofs.test.mjs"
]);

export function runPhaseOneFocusedTests(options = {}) {
  return runDeterministicTestFiles({
    ...options,
    files: PHASE1_FOCUSED_TEST_FILES
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = runPhaseOneFocusedTests();
}
