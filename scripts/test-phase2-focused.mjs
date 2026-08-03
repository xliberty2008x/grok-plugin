#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  runDeterministicTestFiles,
  runDeterministicTestFilesCli
} from "./lib/deterministic-test-runner.mjs";
import {
  WORKER_MUTATION_SEMANTIC_TEST_FILES
} from "./lib/worker-mutation-test-inventory.mjs";

/** Fixed Phase 2 proof inventory; callers cannot add, remove, or reorder tests. */
export const PHASE2_FOCUSED_TEST_FILES = Object.freeze([
  "tests/acp-client.test.mjs",
  "tests/provider-capability.test.mjs",
  "tests/provider.test.mjs",
  "tests/state.test.mjs",
  "tests/worker-context-roles.test.mjs",
  "tests/worker-host-actions.test.mjs",
  "tests/worker-mailbox.test.mjs",
  ...WORKER_MUTATION_SEMANTIC_TEST_FILES,
  "tests/worker-protocol.test.mjs",
  "tests/worker-service.test.mjs",
  "tests/worker-dispatch-supervisor.test.mjs",
  "tests/worker-terminal-intent.test.mjs",
  "tests/worker-recovery-fence.test.mjs",
  "tests/worker-provider-rotation-intent.test.mjs",
  "tests/mcp-worker-broker.test.mjs",
  "tests/mcp-worker-runtime.test.mjs",
  "tests/installed-worker-mcp-contract.test.mjs",
  "tests/installed-worker-mcp-runner.test.mjs"
]);

export function runPhaseTwoFocusedTests(options = {}) {
  return runDeterministicTestFiles({
    ...options,
    files: PHASE2_FOCUSED_TEST_FILES
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runDeterministicTestFilesCli({
    files: PHASE2_FOCUSED_TEST_FILES
  });
}
