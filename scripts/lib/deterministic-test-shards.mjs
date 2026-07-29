export const DETERMINISTIC_TEST_SHARD_COUNT = 3;

// Duration-balanced with longest-processing-time assignment from the
// macOS / Node 22 lane in Actions run 30382034077 on 2026-07-28. Keep this
// manifest explicit: validation must fail when the deterministic inventory
// changes until the new file is deliberately assigned.
export const DETERMINISTIC_TEST_SHARDS = Object.freeze([
  Object.freeze([
    "tests/ci-post-grok-review.test.mjs",
    "tests/control-plane.test.mjs",
    "tests/deterministic-sharding.test.mjs",
    "tests/git-review.test.mjs",
    "tests/grok-review-app-target-collector.test.mjs",
    "tests/mcp-worker-runtime.test.mjs",
    "tests/plugin-inventory.test.mjs",
    "tests/process-control-owned-identity.test.mjs",
    "tests/provider-capability.test.mjs",
    "tests/version-policy.test.mjs",
    "tests/worker-broker-phase3-evidence.test.mjs",
    "tests/worker-execution-binding.test.mjs",
    "tests/worker-host-actions.test.mjs",
    "tests/worker-launch-outbox.test.mjs",
    "tests/worker-owner-controller.test.mjs",
    "tests/worker-protocol.test.mjs",
    "tests/worker-recovery-fence.test.mjs",
    "tests/worker-runtime-teardown.test.mjs",
    "tests/worker-safety-proofs.test.mjs",
    "tests/worker-service.test.mjs",
    "tests/worker-terminal-intent.test.mjs",
    "tests/worker-worktree.test.mjs"
  ]),
  Object.freeze([
    "tests/acp-client.test.mjs",
    "tests/grok-review-app-runner.test.mjs",
    "tests/grok-review-app-worker.test.mjs",
    "tests/hooks.test.mjs",
    "tests/installed-worker-mcp-contract.test.mjs",
    "tests/installed-worker-mcp-runner.test.mjs",
    "tests/installed-worker-mcp-session-boundary.test.mjs",
    "tests/mcp-stdio-client.test.mjs",
    "tests/provider.test.mjs",
    "tests/pty-ingress.test.mjs",
    "tests/readonly-status.test.mjs",
    "tests/state.test.mjs",
    "tests/stdin.test.mjs",
    "tests/test-temp-cleanup.test.mjs",
    "tests/worker-broker-evidence.test.mjs",
    "tests/worker-context-roles.test.mjs",
    "tests/worker-dispatch-supervisor.test.mjs",
    "tests/worker-presentation.test.mjs",
    "tests/worker-reconcile-safety.test.mjs",
    "tests/worker-session-close-environment.test.mjs"
  ]),
  Object.freeze([
    "tests/args-redaction-profiles.test.mjs",
    "tests/ci-auth-sync.test.mjs",
    "tests/codex-support.test.mjs",
    "tests/deep-research.test.mjs",
    "tests/executable-identity.test.mjs",
    "tests/grok-review-app-github.test.mjs",
    "tests/grok-worktree-acp.test.mjs",
    "tests/installed-worker-mcp-setup-boundary.test.mjs",
    "tests/mcp-worker-broker.test.mjs",
    "tests/process-control.test.mjs",
    "tests/provider-bootstrap-crash-window.test.mjs",
    "tests/provider-startup-cancel.test.mjs",
    "tests/recursion-guard.test.mjs",
    "tests/redact.test.mjs",
    "tests/runtime.test.mjs",
    "tests/windows-neutral.test.mjs",
    "tests/worker-cli-authority.test.mjs",
    "tests/worker-mailbox.test.mjs",
    "tests/worker-mutation.test.mjs",
    "tests/worker-owner-lifecycle.test.mjs",
    "tests/worker-provider-rotation-intent.test.mjs",
    "tests/worker-startup-crash-window.test.mjs"
  ])
]);

const SHARD_SPECIFICATION = /^([1-3])\/3$/u;

export function parseDeterministicShardArgument(argv = []) {
  if (!Array.isArray(argv)) throw new TypeError("Deterministic test arguments must be an array.");
  if (argv.length === 0) return null;
  if (argv.length !== 1 || typeof argv[0] !== "string") {
    throw new Error("Expected exactly one deterministic shard argument.");
  }
  const match = /^--shard=(.+)$/u.exec(argv[0]);
  if (!match || !SHARD_SPECIFICATION.test(match[1])) {
    throw new Error("The deterministic shard must be one of 1/3, 2/3, or 3/3.");
  }
  return Number(match[1][0]);
}

export function selectDeterministicTestFiles({
  inventory,
  shard,
  shards = DETERMINISTIC_TEST_SHARDS
}) {
  if (shard == null) return [...inventory];
  if (!Number.isInteger(shard) || shard < 1 || shard > DETERMINISTIC_TEST_SHARD_COUNT) {
    throw new Error("The deterministic shard ordinal is invalid.");
  }
  return [...shards[shard - 1]];
}

export function validateDeterministicTestShards({
  inventory,
  externalBoundaryTests = [],
  shards = DETERMINISTIC_TEST_SHARDS
}) {
  const errors = [];
  if (!Array.isArray(inventory) || inventory.some((file) => typeof file !== "string")) {
    return ["The deterministic test inventory must be an array of file names."];
  }
  if (!Array.isArray(shards) || shards.length !== DETERMINISTIC_TEST_SHARD_COUNT) {
    return [`The deterministic manifest must define exactly ${DETERMINISTIC_TEST_SHARD_COUNT} shards.`];
  }

  const manifestFiles = [];
  for (let index = 0; index < shards.length; index += 1) {
    const files = shards[index];
    if (!Array.isArray(files) || files.length === 0) {
      errors.push(`Deterministic shard ${index + 1} must be a nonempty array.`);
      continue;
    }
    if (files.some((file) => typeof file !== "string"
      || !/^tests\/[^/]+\.test\.mjs$/u.test(file))) {
      errors.push(`Deterministic shard ${index + 1} contains an invalid test path.`);
      continue;
    }
    if (JSON.stringify(files) !== JSON.stringify([...files].sort())) {
      errors.push(`Deterministic shard ${index + 1} must remain sorted.`);
    }
    manifestFiles.push(...files);
  }

  const uniqueManifestFiles = new Set(manifestFiles);
  if (uniqueManifestFiles.size !== manifestFiles.length) {
    errors.push("The deterministic shard manifest contains duplicate tests.");
  }

  const excluded = new Set(externalBoundaryTests.map((file) => (
    file.startsWith("tests/") ? file : `tests/${file}`
  )));
  if (manifestFiles.some((file) => excluded.has(file))) {
    errors.push("The deterministic shard manifest includes an external-boundary test.");
  }

  const inventorySet = new Set(inventory);
  if (inventorySet.size !== inventory.length) {
    errors.push("The deterministic inventory contains duplicate tests.");
  }
  const missing = inventory.filter((file) => !uniqueManifestFiles.has(file));
  const extra = [...uniqueManifestFiles].filter((file) => !inventorySet.has(file));
  if (missing.length > 0) {
    errors.push("The deterministic shard manifest is missing inventory tests.");
  }
  if (extra.length > 0) {
    errors.push("The deterministic shard manifest contains tests outside the inventory.");
  }
  return errors;
}
