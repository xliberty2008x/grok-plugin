/** Internal Worker Broker evidence core domain. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { redactText } from "../../plugins/grok/scripts/lib/redact.mjs";
import {
  createPluginInventory,
  digestInventory
} from "./plugin-inventory.mjs";
import {
  WORKER_MUTATION_SEMANTIC_TEST_FILES
} from "./worker-mutation-test-inventory.mjs";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const STATIC_ESM_IMPORT_PARSER = path.join(
  REPO_ROOT,
  "scripts/lib/static-esm-import-parser.mjs"
);

const STATIC_IMPORT_CACHE = new Map();

const MAX_STATIC_IMPORT_CACHE_ENTRIES = 1024;

const MAX_STATIC_IMPORT_BATCH_SOURCES = 512;

const MAX_STATIC_IMPORT_BATCH_BYTES = 28 * 1024 * 1024;

const MAX_STATIC_IMPORT_SOURCE_BYTES = 8 * 1024 * 1024;

const PINNED_EXTERNAL_STATIC_IMPORTS = Object.freeze({
  acorn: Object.freeze({
    version: "8.15.0",
    resolved: "https://registry.npmjs.org/acorn/-/acorn-8.15.0.tgz",
    integrity: "sha512-NZyJarBfL7nWwIq+FDL6Zp/yHEhePMNnnJ0y3qfieCrmNvYct8uvtiV41UvlSe6apAfk0fY1FbWx+NwfmpvtTg==",
    manifests: Object.freeze(["package-lock.json", "package.json"])
  })
});

export const EVIDENCE_SCHEMA_VERSION = 1;

export const ROADMAP_VERSION = "1.0";

export const ISSUE_URL = "https://github.com/xliberty2008x/grok-plugin/issues/25";

export const EVIDENCE_ROOT = "tests/e2e-results/worker-broker";

export const EVIDENCE_ONLY_PREFIXES = Object.freeze([
  `${EVIDENCE_ROOT}/`,
  "tests/e2e-results/macos-",
  "tests/e2e-results/qualification-"
]);

export const LIVE_RECEIPT_RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/;

export const PROOF_PRODUCER_ID = "worker-broker-gate-runner";

export const PROOF_PRODUCER_VERSION = 5;

export const PHASE_TWO_SLICE = "mailbox-context-roles";

export const PHASE_THREE_SLICE = "execution-lease-artifact-integration";

export const PRIOR_PROOF_MANIFEST_DIGESTS = Object.freeze({
  1: Object.freeze({
    "0": "66426cce37e08f4041ed272bfe6c9400298b9f05e1494b5ebd47747e1f43de8a",
    "1": "b2fa2be3c0f70da875c7fdc268694bbd0c97c3e087ae5aabe3c995c675dab74a"
  }),
  2: Object.freeze({
    "0": "66426cce37e08f4041ed272bfe6c9400298b9f05e1494b5ebd47747e1f43de8a",
    "1": "b2fa2be3c0f70da875c7fdc268694bbd0c97c3e087ae5aabe3c995c675dab74a"
  }),
  3: Object.freeze({
    "0": "66426cce37e08f4041ed272bfe6c9400298b9f05e1494b5ebd47747e1f43de8a",
    "1": "b2fa2be3c0f70da875c7fdc268694bbd0c97c3e087ae5aabe3c995c675dab74a"
  }),
  4: Object.freeze({
    "0": "66426cce37e08f4041ed272bfe6c9400298b9f05e1494b5ebd47747e1f43de8a",
    "1": "b2fa2be3c0f70da875c7fdc268694bbd0c97c3e087ae5aabe3c995c675dab74a",
    "2": "a88795f9f48d632451eed5d7dfd1b7fe482638fc83386128d3f70490f33dac22",
    "3": "07e859d5018265f708ba4a9a580357efa31780ec539959125e9e88e82a58d138",
    "4": "392b9d52fef83af8a93f552099bf8b9092b724ce0aab6cf5e3a79be28ba68504",
    "5": "7d59277624f3319aa49f5091816fb143c951e00b96c6ba3b595ebb1ba526acb7"
  })
});

export const INDEPENDENT_REVIEW_PRODUCER_ID = "codex-native-review-runner";

export const INDEPENDENT_REVIEW_PRODUCER_VERSION = 1;

export const INDEPENDENT_REVIEW_MANIFEST_DIGEST = "82792debed04937a264e759a1812ba1e33e0417aa555f87ce13e7f5417fd6f12";

export const REVIEW_REQUEST_SCHEMA_VERSION = 1;

export const REVIEW_REQUEST_PRODUCER_ID = "worker-broker-review-request-runner";

export const REVIEW_REQUEST_PRODUCER_VERSION = 1;

export const REVIEW_REQUEST_DOMAIN = "grok-plugin/worker-broker/phase-1-review-request/v1";

export const REVIEW_REQUEST_ROOT = `${EVIDENCE_ROOT}/review-requests/v1`;

export const REVIEW_ATTESTATION_SCHEMA_VERSION = 1;

export const REVIEW_ATTESTATION_DOMAIN = "grok-plugin/worker-broker/phase-1-review-attestation/v1";

export const REVIEW_ATTESTATION_ALGORITHM = "Ed25519";

export const REVIEW_ATTESTATION_ROOT = `${EVIDENCE_ROOT}/review-attestations/v1`;

export const SIGNED_REVIEW_RECEIPT_SCHEMA_VERSION = 2;

export const SIGNED_REVIEW_RECEIPT_PRODUCER_ID = "worker-broker-protected-review-promoter";

export const SIGNED_REVIEW_RECEIPT_PRODUCER_VERSION = 1;

export const SIGNED_REVIEW_MANIFEST = Object.freeze({
  schemaVersion: 2,
  phase: "1",
  requiredOutcome: "pass",
  unresolvedFindings: 0,
  requiredBindings: Object.freeze([
    "review-request",
    "nonce",
    "source-commit",
    "source-tree",
    "source-inventory",
    "phase-scope",
    "diff-base",
    "diff-patch",
    "diff-paths",
    "phase-1-proof",
    "phase-0-prerequisite",
    "reviewer-runtime"
  ])
});

export const SIGNED_REVIEW_MANIFEST_DIGEST = sha256Text(stableStringify(SIGNED_REVIEW_MANIFEST));

export const LIVE_RECEIPT_SCHEMA_VERSION = 2;

export const LIVE_RECEIPT_PRODUCER_ID = "worker-broker-live-receipt-runner";

export const LIVE_RECEIPT_PRODUCER_VERSION = 2;

export const LIVE_RECEIPT_AUTHORITY_SYNTHETIC = "synthetic-direct-mcp";

export const LIVE_RECEIPT_AUTHORITY_NATURAL = "natural-codex-host";

export const LIVE_RECEIPT_ROOT = `${EVIDENCE_ROOT}/live-receipts/v2`;

export const LIVE_RECEIPT_AUTHORITY_MODES = Object.freeze([
  LIVE_RECEIPT_AUTHORITY_SYNTHETIC,
  LIVE_RECEIPT_AUTHORITY_NATURAL
]);

export const LIVE_INSTALLATION_METHODS = Object.freeze([
  "codex-local-plugin-cache",
  "exact-source-plugin-install"
]);

export const LIVE_RECEIPT_CAPABILITY_TOOL_IDS = Object.freeze([
  "worker_list_owned",
  "worker_get",
  "worker_events_after",
  "worker_wait",
  "worker_result",
  "worker_spawn",
  "worker_decide_host_action",
  "worker_followup",
  "worker_send",
  "worker_cancel"
]);

export const LIVE_RECEIPT_PROVIDER_CAPABILITIES = Object.freeze([
  "root-read-spawn-v1",
  "same-session-read-followup-v1",
  "ordered-turn-boundary-mailbox-v1"
]);

export const LIVE_RECEIPT_NATURAL_TOOL_IDS = Object.freeze([
  "worker_list_owned",
  "worker_spawn",
  "worker_wait",
  "worker_result"
]);

function freezeLiveScenario(scenario) {
  return Object.freeze({ ...scenario });
}

const LIVE_RECEIPT_SCENARIOS = Object.freeze({
  [LIVE_RECEIPT_AUTHORITY_SYNTHETIC]: Object.freeze([
    freezeLiveScenario({
      id: "authenticated-completion",
      spawnInvocationCount: 1,
      spawnReplayCount: 0,
      providerLaunchCount: 1,
      providerTerminalCount: 1,
      workerTerminalCount: 1,
      resultReadCount: 1,
      reconnectCount: 0,
      cancelInvocationCount: 0,
      cancelReplayCount: 0,
      uniqueCancelRequestCount: 0,
      cancellationEventCount: 0,
      duplicateLaunchCount: 0,
      mailbox: Object.freeze({
        providerGenerationCount: 1,
        providerSessionCount: 1,
        promptCount: 3,
        sendInvocationCount: 3,
        sendReplayCount: 1,
        acceptedCount: 2,
        deliveredCount: 2,
        deliveryUnknownCount: 0,
        rejectedCount: 0,
        finalReportSequence: 2,
        replayPromptDelta: 0,
        retainedBodyCount: 0,
        closed: true
      }),
      workerHostVerification: "not_run",
      processGroupGone: true,
      taskRuntimeCleaned: true,
      runnerTemporaryArtifactsRemoved: true,
      qualificationSessionDeleted: true
    }),
    freezeLiveScenario({
      id: "mcp-restart-reconnect-cancellation",
      spawnInvocationCount: 2,
      spawnReplayCount: 1,
      providerLaunchCount: 1,
      providerTerminalCount: 1,
      workerTerminalCount: 1,
      resultReadCount: 1,
      reconnectCount: 1,
      cancelInvocationCount: 2,
      cancelReplayCount: 1,
      uniqueCancelRequestCount: 1,
      cancellationEventCount: 1,
      duplicateLaunchCount: 0,
      mailbox: null,
      workerHostVerification: "not_run",
      processGroupGone: true,
      taskRuntimeCleaned: true,
      runnerTemporaryArtifactsRemoved: true,
      qualificationSessionDeleted: true
    })
  ]),
  [LIVE_RECEIPT_AUTHORITY_NATURAL]: Object.freeze([
    freezeLiveScenario({
      id: "natural-codex-installed-host",
      spawnInvocationCount: 1,
      spawnReplayCount: 0,
      providerLaunchCount: 1,
      providerTerminalCount: 1,
      workerTerminalCount: 1,
      resultReadCount: 1,
      reconnectCount: 0,
      cancelInvocationCount: 0,
      cancelReplayCount: 0,
      uniqueCancelRequestCount: 0,
      cancellationEventCount: 0,
      duplicateLaunchCount: 0,
      mailbox: null,
      workerHostVerification: "not_run",
      processGroupGone: true,
      taskRuntimeCleaned: true,
      runnerTemporaryArtifactsRemoved: true,
      qualificationSessionDeleted: true
    })
  ])
});

export const LIVE_RECEIPT_SCENARIO_IDS = Object.freeze(Object.fromEntries(
  Object.entries(LIVE_RECEIPT_SCENARIOS).map(([authorityMode, scenarios]) => [
    authorityMode,
    Object.freeze(scenarios.map((scenario) => scenario.id))
  ])
));

export const LIVE_RECEIPT_AUTHORITY_CONFIG = Object.freeze({
  [LIVE_RECEIPT_AUTHORITY_SYNTHETIC]: Object.freeze({
    phase: "1",
    qualifies: Object.freeze(["provider"]),
    codexHostIdentity: false,
    observedProviderCapabilities: LIVE_RECEIPT_PROVIDER_CAPABILITIES,
    observedToolIds: LIVE_RECEIPT_CAPABILITY_TOOL_IDS,
    installationMethods: LIVE_INSTALLATION_METHODS,
    scenarios: LIVE_RECEIPT_SCENARIOS[LIVE_RECEIPT_AUTHORITY_SYNTHETIC]
  }),
  [LIVE_RECEIPT_AUTHORITY_NATURAL]: Object.freeze({
    phase: "4",
    qualifies: Object.freeze(["installedHost"]),
    codexHostIdentity: true,
    observedProviderCapabilities: LIVE_RECEIPT_PROVIDER_CAPABILITIES,
    observedToolIds: LIVE_RECEIPT_NATURAL_TOOL_IDS,
    installationMethods: Object.freeze(["codex-local-plugin-cache"]),
    scenarios: LIVE_RECEIPT_SCENARIOS[LIVE_RECEIPT_AUTHORITY_NATURAL]
  })
});

export const LIVE_RECEIPT_MANIFEST = Object.freeze({
  schemaVersion: LIVE_RECEIPT_SCHEMA_VERSION,
  producerId: LIVE_RECEIPT_PRODUCER_ID,
  producerVersion: LIVE_RECEIPT_PRODUCER_VERSION,
  mcpProtocolVersion: "2025-11-25",
  providerRevisionScheme: "binary-sha256-v1",
  installedEntrypoint: "mcp/server.mjs",
  authorityModes: LIVE_RECEIPT_AUTHORITY_CONFIG
});

const PHASE_SCOPE_SEEDS = freezeScopeMap({
  "0": [
    ".github/workflows/ci.yml",
    "plugins/grok/scripts/lib/redact.mjs",
    "scripts/lib/worker-broker-phase3-evidence.mjs",
    "scripts/lib/worker-broker-evidence.mjs",
    "scripts/lib/static-esm-import-parser.mjs",
    "scripts/trusted/worker-broker-review-operation.cjs",
    "scripts/trusted/worker-broker-review.mjs",
    "scripts/lib/zero-skip-test-reporter.mjs",
    "scripts/check-deterministic.mjs",
    "scripts/test-deterministic.mjs",
    "scripts/worker-broker-evidence.mjs",
    "scripts/worker-broker-phase3-evidence.mjs",
    "scripts/validate.mjs",
    "plugins/grok/schemas/worker-broker-evidence.schema.json",
    "plugins/grok/schemas/worker-broker-live-receipt.schema.json",
    "plugins/grok/schemas/worker-broker-review-request.schema.json",
    "plugins/grok/schemas/worker-broker-review-attestation.schema.json",
    "tests/worker-broker-evidence.test.mjs",
    "tests/worker-broker-evidence-structure.test.mjs",
    "tests/worker-mutation-boundaries.test.mjs",
    ...WORKER_MUTATION_SEMANTIC_TEST_FILES,
    "tests/worker-broker-phase3-evidence.test.mjs",
    "tests/worker-broker-protected-review.test.mjs",
    "tests/helpers.mjs",
    "package.json"
  ],
  "1": [
    "plugins/grok/scripts/lib/redact.mjs",
    "plugins/grok/scripts/lib/errors.mjs",
    "plugins/grok/scripts/lib/worker-launch-contract.mjs",
    "plugins/grok/scripts/lib/host.mjs",
    "plugins/grok/scripts/lib/worker-protocol.mjs",
    "plugins/grok/scripts/lib/process-control.mjs",
    "plugins/grok/scripts/lib/provider-bootstrap.mjs",
    "plugins/grok/scripts/lib/provider-capability.mjs",
    "plugins/grok/scripts/lib/grok-provider.mjs",
    "plugins/grok/scripts/lib/worker-dispatch-supervisor.mjs",
    "plugins/grok/scripts/lib/worker-recovery.mjs",
    "plugins/grok/scripts/lib/worker-runtime.mjs",
    "plugins/grok/scripts/lib/worker-service.mjs",
    "plugins/grok/scripts/lib/worker-authority.mjs",
    "plugins/grok/scripts/lib/worker-mutation.mjs",
    "plugins/grok/scripts/lib/worker-reconcile.mjs",
    "plugins/grok/scripts/lib/recursion-guard.mjs",
    "plugins/grok/scripts/lib/worker-roles.mjs",
    "plugins/grok/scripts/lib/state.mjs",
    "plugins/grok/scripts/lib/task-contract.mjs",
    "plugins/grok/scripts/lib/workspace.mjs",
    "plugins/grok/mcp/broker.mjs",
    "plugins/grok/mcp/server.mjs",
    "plugins/grok/scripts/grok-companion.mjs",
    "plugins/grok/.codex-plugin/plugin.json",
    "plugins/grok/.mcp.json",
    "plugins/grok/provider-agents/report-repair.md",
    "plugins/grok/provider-agents/rescue-read.md",
    "plugins/grok/provider-agents/rescue-write.md",
    "plugins/grok/provider-agents/setup-probe.md",
    "plugins/grok/schemas/review-output.schema.json",
    "plugins/grok/schemas/worker-protocol.schema.json",
    "plugins/grok/schemas/worker-broker-evidence.schema.json",
    "plugins/grok/schemas/worker-broker-live-receipt.schema.json",
    "plugins/grok/schemas/worker-broker-review-request.schema.json",
    "plugins/grok/schemas/worker-broker-review-attestation.schema.json",
    "plugins/grok/skills/rescue/SKILL.md",
    "plugins/grok/skills/result/SKILL.md",
    "plugins/grok/skills/status/SKILL.md",
    "scripts/lib/zero-skip-test-reporter.mjs",
    "scripts/lib/worker-broker-evidence.mjs",
    "scripts/lib/static-esm-import-parser.mjs",
    "scripts/trusted/worker-broker-review-operation.cjs",
    "scripts/trusted/worker-broker-review.mjs",
    "scripts/check-deterministic.mjs",
    "scripts/test-deterministic.mjs",
    "scripts/test-installed-worker-mcp.mjs",
    "scripts/test-phase1-focused.mjs",
    "scripts/validate.mjs",
    "package.json",
    "tests/control-plane-context-manifest.test.mjs",
    "tests/control-plane-git-refs.test.mjs",
    "tests/control-plane-lifecycle.test.mjs",
    "tests/control-plane-metadata-races.test.mjs",
    "tests/control-plane-worker-contracts.test.mjs",
    "tests/process-control.test.mjs",
    "tests/provider.test.mjs",
    "tests/recursion-guard.test.mjs",
    "tests/runtime-admission.test.mjs",
    "tests/runtime-cancellation.test.mjs",
    "tests/runtime-recovery.test.mjs",
    "tests/runtime-task-lifecycle.test.mjs",
    "tests/runtime-transfer.test.mjs",
    "tests/worker-mailbox.test.mjs",
    "tests/worker-protocol.test.mjs",
    "tests/worker-service.test.mjs",
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
    "tests/worker-broker-evidence.test.mjs",
    "tests/worker-broker-evidence-structure.test.mjs",
    "tests/worker-broker-protected-review.test.mjs",
    "tests/process-control-owned-identity.test.mjs",
    "tests/worker-mutation-boundaries.test.mjs",
    ...WORKER_MUTATION_SEMANTIC_TEST_FILES,
    "tests/worker-safety-proofs.test.mjs",
    "tests/state.test.mjs",
    "tests/args-redaction-profiles.test.mjs",
    "tests/redact.test.mjs",
    "tests/helpers.mjs"
  ],
  "2": [
    "plugins/grok/.codex-plugin/plugin.json",
    "plugins/grok/.mcp.json",
    "plugins/grok/mcp/broker.mjs",
    "plugins/grok/mcp/server.mjs",
    "plugins/grok/provider-agents/report-repair.md",
    "plugins/grok/provider-agents/rescue-read.md",
    "plugins/grok/provider-agents/rescue-write.md",
    "plugins/grok/provider-agents/setup-probe.md",
    "plugins/grok/schemas/review-output.schema.json",
    "plugins/grok/schemas/worker-broker-evidence.schema.json",
    "plugins/grok/schemas/worker-broker-live-receipt.schema.json",
    "plugins/grok/schemas/worker-broker-review-attestation.schema.json",
    "plugins/grok/schemas/worker-broker-review-request.schema.json",
    "plugins/grok/schemas/worker-protocol.schema.json",
    "plugins/grok/scripts/lib/redact.mjs",
    "plugins/grok/scripts/lib/errors.mjs",
    "plugins/grok/scripts/lib/host.mjs",
    "plugins/grok/scripts/lib/provider-capability.mjs",
    "plugins/grok/scripts/lib/grok-provider.mjs",
    "plugins/grok/scripts/lib/worker-authority.mjs",
    "plugins/grok/scripts/lib/worker-dispatch-supervisor.mjs",
    "plugins/grok/scripts/lib/worker-mailbox.mjs",
    "plugins/grok/scripts/lib/worker-roles.mjs",
    "plugins/grok/scripts/lib/worker-context.mjs",
    "plugins/grok/scripts/lib/worker-mutation.mjs",
    "plugins/grok/scripts/lib/worker-runtime.mjs",
    "plugins/grok/scripts/lib/worker-service.mjs",
    "plugins/grok/scripts/lib/worker-protocol.mjs",
    "plugins/grok/scripts/lib/state.mjs",
    "plugins/grok/scripts/lib/task-contract.mjs",
    "plugins/grok/scripts/lib/workspace.mjs",
    "scripts/check-deterministic.mjs",
    "scripts/lib/static-esm-import-parser.mjs",
    "scripts/lib/worker-broker-evidence.mjs",
    "scripts/test-installed-worker-mcp.mjs",
    "scripts/test-phase2-focused.mjs",
    "scripts/trusted/worker-broker-review-operation.cjs",
    "scripts/trusted/worker-broker-review.mjs",
    "scripts/validate.mjs",
    "package.json",
    "tests/acp-client.test.mjs",
    "tests/installed-worker-mcp-contract.test.mjs",
    "tests/installed-worker-mcp-runner.test.mjs",
    "tests/mcp-worker-broker.test.mjs",
    "tests/mcp-worker-runtime.test.mjs",
    "tests/provider-capability.test.mjs",
    "tests/provider.test.mjs",
    "tests/state.test.mjs",
    "tests/worker-context-roles.test.mjs",
    "tests/worker-dispatch-supervisor.test.mjs",
    "tests/worker-host-actions.test.mjs",
    "tests/worker-mailbox.test.mjs",
    ...WORKER_MUTATION_SEMANTIC_TEST_FILES,
    "tests/worker-protocol.test.mjs",
    "tests/worker-provider-rotation-intent.test.mjs",
    "tests/worker-recovery-fence.test.mjs",
    "tests/worker-service.test.mjs",
    "tests/worker-terminal-intent.test.mjs",
    "tests/worker-broker-evidence.test.mjs",
    "tests/worker-broker-evidence-structure.test.mjs",
    "tests/worker-broker-protected-review.test.mjs",
    "tests/helpers.mjs"
  ],
  "3": [
    "plugins/grok/mcp/broker.mjs",
    "plugins/grok/scripts/grok-companion.mjs",
    "plugins/grok/scripts/lib/acp-client.mjs",
    "plugins/grok/scripts/lib/errors.mjs",
    "plugins/grok/scripts/lib/executable-identity.mjs",
    "plugins/grok/scripts/lib/grok-provider.mjs",
    "plugins/grok/scripts/lib/grok-worktree-acp.mjs",
    "plugins/grok/scripts/lib/host.mjs",
    "plugins/grok/scripts/lib/provider-bootstrap.mjs",
    "plugins/grok/scripts/lib/provider-capability.mjs",
    "plugins/grok/scripts/lib/provider-executable-pin.mjs",
    "plugins/grok/scripts/lib/recursion-guard.mjs",
    "plugins/grok/scripts/lib/workspace.mjs",
    "plugins/grok/scripts/lib/worker-dispatch-supervisor.mjs",
    "plugins/grok/scripts/lib/worker-execution-binding.mjs",
    "plugins/grok/scripts/lib/worker-launch-contract.mjs",
    "plugins/grok/scripts/lib/worker-mutation.mjs",
    "plugins/grok/scripts/lib/worker-owner-controller.mjs",
    "plugins/grok/scripts/lib/worker-owner-lifecycle.mjs",
    "plugins/grok/scripts/lib/worker-provisioner.mjs",
    "plugins/grok/scripts/lib/worker-recovery.mjs",
    "plugins/grok/scripts/lib/worker-runtime.mjs",
    "plugins/grok/scripts/lib/worker-service.mjs",
    "plugins/grok/scripts/lib/worker-session-lifecycle.mjs",
    "plugins/grok/scripts/lib/worker-worktree.mjs",
    "plugins/grok/scripts/lib/state.mjs",
    "plugins/grok/scripts/lib/task-contract.mjs",
    "plugins/grok/scripts/lib/worker-protocol.mjs",
    "scripts/lib/installed-worker-mcp-contract.mjs",
    "scripts/lib/worker-broker-phase3-evidence.mjs",
    "scripts/live-worker-provisioner-probe.mjs",
    "scripts/test-installed-worker-mcp.mjs",
    "scripts/test-phase3-focused.mjs",
    "scripts/trusted/worker-broker-review-operation.cjs",
    "scripts/trusted/worker-broker-review.mjs",
    "scripts/worker-broker-phase3-evidence.mjs",
    "tests/acp-client.test.mjs",
    "tests/grok-worktree-acp.test.mjs",
    "tests/installed-worker-mcp-contract.test.mjs",
    "tests/installed-worker-mcp-runner.test.mjs",
    "tests/mcp-worker-broker.test.mjs",
    "tests/mcp-worker-runtime.test.mjs",
    "tests/provider-bootstrap-crash-window.test.mjs",
    "tests/provider-capability.test.mjs",
    "tests/provider.test.mjs",
    "tests/recursion-guard.test.mjs",
    "tests/state.test.mjs",
    "tests/worker-broker-evidence.test.mjs",
    "tests/worker-broker-evidence-structure.test.mjs",
    "tests/worker-broker-phase3-evidence.test.mjs",
    "tests/worker-broker-protected-review.test.mjs",
    "tests/worker-dispatch-supervisor.test.mjs",
    "tests/worker-execution-binding.test.mjs",
    "tests/worker-launch-outbox.test.mjs",
    ...WORKER_MUTATION_SEMANTIC_TEST_FILES,
    "tests/worker-owner-controller.test.mjs",
    "tests/worker-owner-lifecycle.test.mjs",
    "tests/worker-protocol.test.mjs",
    "tests/worker-service.test.mjs",
    "tests/worker-session-close-environment.test.mjs",
    "tests/worker-worktree.test.mjs",
    "tests/worker-safety-proofs.test.mjs",
    "tests/helpers.mjs"
  ],
  "4": [
    "plugins/grok/scripts/lib/redact.mjs",
    "plugins/grok/scripts/lib/errors.mjs",
    "plugins/grok/scripts/lib/task-contract.mjs",
    "plugins/grok/scripts/lib/worker-presentation.mjs",
    "plugins/grok/scripts/lib/worker-protocol.mjs",
    "plugins/grok/mcp/broker.mjs",
    "plugins/grok/schemas/worker-broker-evidence.schema.json",
    "plugins/grok/schemas/worker-broker-live-receipt.schema.json",
    "plugins/grok/schemas/worker-broker-review-request.schema.json",
    "plugins/grok/schemas/worker-broker-review-attestation.schema.json",
    "plugins/grok/schemas/worker-protocol.schema.json",
    "scripts/lib/worker-broker-evidence.mjs",
    "tests/worker-presentation.test.mjs",
    "tests/worker-protocol.test.mjs",
    "tests/mcp-worker-broker.test.mjs",
    "tests/worker-broker-evidence.test.mjs",
    "tests/worker-broker-evidence-structure.test.mjs",
    "tests/args-redaction-profiles.test.mjs",
    "tests/redact.test.mjs",
    "tests/helpers.mjs"
  ],
  "5": [
    "plugins/grok/scripts/lib/redact.mjs",
    "plugins/grok/scripts/lib/errors.mjs",
    "plugins/grok/scripts/lib/host.mjs",
    "tests/worker-safety-proofs.test.mjs",
    "plugins/grok/scripts/lib/worker-mutation.mjs",
    "plugins/grok/scripts/lib/worker-reconcile.mjs",
    "plugins/grok/scripts/lib/worker-mailbox.mjs",
    "plugins/grok/scripts/lib/worker-worktree.mjs",
    "plugins/grok/scripts/lib/worker-protocol.mjs",
    "plugins/grok/scripts/lib/worker-service.mjs",
    "plugins/grok/scripts/lib/state.mjs",
    "plugins/grok/scripts/lib/task-contract.mjs",
    "plugins/grok/scripts/lib/workspace.mjs",
    ...WORKER_MUTATION_SEMANTIC_TEST_FILES,
    "tests/worker-mailbox.test.mjs",
    "tests/worker-worktree.test.mjs",
    "tests/state.test.mjs",
    "scripts/lib/worker-broker-evidence.mjs",
    "tests/args-redaction-profiles.test.mjs",
    "tests/redact.test.mjs",
    "tests/helpers.mjs"
  ]
});

function freezeScopeMap(scope) {
  return Object.freeze(Object.fromEntries(
    Object.entries(scope).map(([phase, paths]) => [phase, Object.freeze([...paths])])
  ));
}

function repositoryRelativePath(root, absolute) {
  const relative = path.relative(root, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Phase scope path escapes repository root: ${absolute}`);
  }
  return relative.split(path.sep).join("/");
}

function exactParserObject(value, keys) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
  );
}

function staticImportParserEnvironment() {
  const environment = {};
  if (process.platform === "win32") {
    for (const key of ["SYSTEMROOT", "SystemRoot", "WINDIR", "windir"]) {
      if (typeof process.env[key] === "string") environment[key] = process.env[key];
    }
  }
  return environment;
}

function rememberStaticImportSpecifiers(id, specifiers) {
  if (STATIC_IMPORT_CACHE.has(id)) STATIC_IMPORT_CACHE.delete(id);
  STATIC_IMPORT_CACHE.set(id, Object.freeze([...specifiers]));
  while (STATIC_IMPORT_CACHE.size > MAX_STATIC_IMPORT_CACHE_ENTRIES) {
    STATIC_IMPORT_CACHE.delete(STATIC_IMPORT_CACHE.keys().next().value);
  }
}

function parseStaticImportBatch(entries) {
  const input = JSON.stringify({ schemaVersion: 1, sources: entries });
  if (Buffer.byteLength(input, "utf8") > MAX_STATIC_IMPORT_BATCH_BYTES) {
    throw new Error("Static ESM parser batch exceeds its input limit.");
  }
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-vm-modules", STATIC_ESM_IMPORT_PARSER],
    {
      cwd: REPO_ROOT,
      env: staticImportParserEnvironment(),
      input,
      encoding: "utf8",
      shell: false,
      timeout: 30_000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("Static ESM dependency parsing failed.");
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error("Static ESM dependency parser returned malformed output.");
  }
  if (!exactParserObject(payload, ["schemaVersion", "results"])
    || payload.schemaVersion !== 1
    || !Array.isArray(payload.results)
    || payload.results.length !== entries.length) {
    throw new Error("Static ESM dependency parser returned malformed output.");
  }

  const expected = new Set(entries.map((entry) => entry.id));
  const observed = new Set();
  for (const entry of payload.results) {
    if (!exactParserObject(entry, ["id", "specifiers"])
      || typeof entry.id !== "string"
      || !expected.has(entry.id)
      || observed.has(entry.id)
      || !Array.isArray(entry.specifiers)
      || entry.specifiers.some((specifier) => (
        typeof specifier !== "string"
        || specifier.length > 8192
        || specifier.includes("\0")
      ))) {
      throw new Error("Static ESM dependency parser returned malformed output.");
    }
    const normalized = [...new Set(entry.specifiers)].sort();
    if (JSON.stringify(normalized) !== JSON.stringify(entry.specifiers)) {
      throw new Error("Static ESM dependency parser returned malformed output.");
    }
    observed.add(entry.id);
    rememberStaticImportSpecifiers(entry.id, normalized);
  }
  if (observed.size !== expected.size) {
    throw new Error("Static ESM dependency parser returned malformed output.");
  }
}

function parseStaticImportSources(sources) {
  if (!Array.isArray(sources)) throw new TypeError("Static ESM sources must be an array.");
  const normalized = sources.map((source) => {
    if (typeof source !== "string"
      || Buffer.byteLength(source, "utf8") > MAX_STATIC_IMPORT_SOURCE_BYTES) {
      throw new Error("Static ESM proof source is invalid or exceeds its limit.");
    }
    return { id: crypto.createHash("sha256").update(source).digest("hex"), source };
  });

  const uncached = new Map();
  for (const entry of normalized) {
    if (!STATIC_IMPORT_CACHE.has(entry.id)) uncached.set(entry.id, entry);
  }

  let batch = [];
  let batchBytes = Buffer.byteLength(JSON.stringify({ schemaVersion: 1, sources: [] }), "utf8");
  const flush = () => {
    if (!batch.length) return;
    parseStaticImportBatch(batch);
    batch = [];
    batchBytes = Buffer.byteLength(JSON.stringify({ schemaVersion: 1, sources: [] }), "utf8");
  };
  for (const entry of uncached.values()) {
    const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
    if (entryBytes >= MAX_STATIC_IMPORT_BATCH_BYTES) {
      throw new Error("Static ESM proof source cannot fit in a parser batch.");
    }
    if (batch.length >= MAX_STATIC_IMPORT_BATCH_SOURCES
      || batchBytes + entryBytes > MAX_STATIC_IMPORT_BATCH_BYTES) flush();
    batch.push(entry);
    batchBytes += entryBytes;
  }
  flush();

  return normalized.map((entry) => [...STATIC_IMPORT_CACHE.get(entry.id)]);
}

export function listLocalStaticImportSpecifiers(source) {
  return parseStaticImportSources([source])[0]
    .filter((specifier) => !specifier.startsWith("node:"))
    .sort();
}

function resolveLocalStaticImport(importer, specifier, root) {
  if (!(specifier.startsWith(".")
    || specifier.startsWith("/")
    || /^file:/i.test(specifier))) {
    throw new Error(`Unsupported static ESM specifier ${specifier} from ${importer}.`);
  }
  let unresolved;
  try {
    const importerUrl = pathToFileURL(path.resolve(root, importer));
    const resolvedUrl = new URL(specifier, importerUrl);
    if (resolvedUrl.protocol !== "file:") throw new Error("unsupported protocol");
    unresolved = fileURLToPath(resolvedUrl);
  } catch {
    throw new Error(`Unsupported static ESM specifier ${specifier} from ${importer}.`);
  }
  repositoryRelativePath(root, unresolved);
  const candidates = [
    unresolved,
    `${unresolved}.mjs`,
    `${unresolved}.js`,
    `${unresolved}.cjs`,
    `${unresolved}.json`,
    path.join(unresolved, "index.mjs"),
    path.join(unresolved, "index.js"),
    path.join(unresolved, "index.cjs"),
    path.join(unresolved, "index.json")
  ];
  const resolved = candidates.find((candidate) => {
    try {
      return fs.lstatSync(candidate).isFile() || fs.lstatSync(candidate).isSymbolicLink();
    } catch {
      return false;
    }
  });
  if (!resolved) {
    throw new Error(`Cannot resolve local static import ${specifier} from ${importer}.`);
  }
  const relative = repositoryRelativePath(root, resolved);
  if (isEvidenceOnlyPath(relative)) {
    throw new Error(`Evidence-only paths cannot be executable static import dependencies: ${relative}.`);
  }
  return relative;
}

function resolvePinnedExternalStaticImport(specifier, root) {
  const binding = PINNED_EXTERNAL_STATIC_IMPORTS[specifier];
  if (!binding) return null;

  let packageJson;
  let packageLock;
  try {
    packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  } catch {
    throw new Error(`Pinned external static ESM dependency ${specifier} has unreadable manifests.`);
  }
  const rootLock = packageLock?.packages?.[""];
  const installedLock = packageLock?.packages?.[`node_modules/${specifier}`];
  if (packageJson?.devDependencies?.[specifier] !== binding.version
    || rootLock?.devDependencies?.[specifier] !== binding.version
    || installedLock?.version !== binding.version
    || installedLock?.resolved !== binding.resolved
    || installedLock?.integrity !== binding.integrity
    || installedLock?.dev !== true) {
    throw new Error(`Pinned external static ESM dependency ${specifier} does not match its exact lock binding.`);
  }
  for (const relative of binding.manifests) {
    let stat;
    try {
      stat = fs.lstatSync(path.join(root, relative));
    } catch {
      throw new Error(`Pinned external static ESM dependency ${specifier} has unreadable manifests.`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Pinned external static ESM dependency ${specifier} has unsafe manifests.`);
    }
  }
  return [...binding.manifests];
}

function resolveStaticImportDependencies(importer, specifier, root) {
  const external = resolvePinnedExternalStaticImport(specifier, root);
  if (external) return external;
  return [resolveLocalStaticImport(importer, specifier, root)];
}

function localStaticImportDependencies(relatives, root) {
  const dependencies = new Map(relatives.map((relative) => [relative, []]));
  const parseable = relatives.filter((relative) => /\.(?:[cm]?js)$/i.test(relative));
  const sources = parseable.map((relative) => {
    const absolute = path.resolve(root, relative);
    repositoryRelativePath(root, absolute);
    return fs.readFileSync(absolute, "utf8");
  });
  let parsed;
  try {
    parsed = parseStaticImportSources(sources);
  } catch (error) {
    throw new Error(`Cannot parse local static imports: ${error.message}`);
  }
  for (let index = 0; index < parseable.length; index += 1) {
    const relative = parseable[index];
    dependencies.set(
      relative,
      [...new Set(parsed[index]
        .filter((specifier) => !specifier.startsWith("node:"))
        .flatMap((specifier) => (
          resolveStaticImportDependencies(relative, specifier, root)
        )))].sort()
    );
  }
  return dependencies;
}

export function expandLocalStaticImportClosure(seedPaths, root = REPO_ROOT) {
  let pending = [...new Set(seedPaths)].sort();
  const closure = new Set();
  while (pending.length) {
    const wave = [];
    for (const candidate of pending) {
      const relative = repositoryRelativePath(root, path.resolve(root, candidate));
      if (isEvidenceOnlyPath(relative)) {
        throw new Error(`Evidence-only paths cannot seed executable phase scope: ${relative}.`);
      }
      if (closure.has(relative) || wave.includes(relative)) continue;
      if (!fs.existsSync(path.resolve(root, relative))) {
        throw new Error(`Phase scope contains missing path: ${relative}`);
      }
      closure.add(relative);
      wave.push(relative);
    }
    pending = [];
    const dependencies = localStaticImportDependencies(wave, root);
    for (const relative of wave) {
      for (const dependency of dependencies.get(relative)) {
        if (!closure.has(dependency)) pending.push(dependency);
      }
    }
    pending = [...new Set(pending)].sort();
  }
  return [...closure].sort();
}

export function findMissingLocalStaticImportDependencies(scopePaths, root = REPO_ROOT) {
  const declared = new Set(scopePaths);
  const missing = [];
  const dependencies = localStaticImportDependencies([...declared].sort(), root);
  for (const importer of [...declared].sort()) {
    for (const dependency of dependencies.get(importer)) {
      if (!declared.has(dependency)) missing.push({ importer, dependency });
    }
  }
  return missing.sort((left, right) => (
    left.importer.localeCompare(right.importer)
    || left.dependency.localeCompare(right.dependency)
  ));
}

export const PHASE_SCOPE = freezeScopeMap(Object.fromEntries(
  Object.entries(PHASE_SCOPE_SEEDS).map(([phase, seeds]) => [
    phase,
    expandLocalStaticImportClosure(seeds, REPO_ROOT)
  ])
));

export const PHASE_MANDATORY_GATE_IDS = Object.freeze({
  "0": Object.freeze(["repository-check", "phase-0-focused-tests", "git-diff-check"]),
  "1": Object.freeze(["repository-check", "phase-1-focused-tests", "git-diff-check"]),
  "2": Object.freeze(["repository-check", "phase-2-focused-tests", "git-diff-check"]),
  "3": Object.freeze(["repository-check", "phase-3-focused-tests", "git-diff-check"]),
  "4": Object.freeze(["repository-check", "phase-4-focused-tests", "git-diff-check"]),
  "5": Object.freeze(["repository-check", "phase-5-focused-tests", "git-diff-check"]),
  aggregate: Object.freeze(["repository-check", "aggregate-qualification", "git-diff-check"])
});

function freezeGateManifest(manifest) {
  return Object.freeze(Object.fromEntries(
    Object.entries(manifest).map(([phase, gates]) => [
      phase,
      Object.freeze(gates.map((gate) => Object.freeze({
        ...gate,
        argv: Object.freeze([...gate.argv])
      })))
    ])
  ));
}

export const PHASE_PROOF_GATE_MANIFEST = freezeGateManifest({
  "0": [
    {
      gateId: "repository-check",
      argv: ["node", "scripts/check-deterministic.mjs"],
      boundary: "source-provider-neutral",
      timeoutMs: 25 * 60_000
    },
    {
      gateId: "phase-0-focused-tests",
      argv: [
        "node",
        "--test",
        "--test-reporter=./scripts/lib/zero-skip-test-reporter.mjs",
        "tests/worker-broker-evidence.test.mjs"
      ],
      boundary: "focused-source-provider-neutral",
      timeoutMs: 5 * 60_000
    },
    {
      gateId: "git-diff-check",
      argv: ["git", "show", "--check", "--format=", "HEAD"],
      boundary: "source",
      timeoutMs: 60_000
    }
  ],
  "1": [
    {
      gateId: "repository-check",
      argv: ["node", "scripts/check-deterministic.mjs"],
      boundary: "source-provider-neutral",
      timeoutMs: 25 * 60_000
    },
    {
      gateId: "phase-1-focused-tests",
      argv: ["node", "scripts/test-phase1-focused.mjs"],
      boundary: "focused-source-provider-neutral",
      timeoutMs: 15 * 60_000
    },
    {
      gateId: "git-diff-check",
      argv: ["git", "show", "--check", "--format=", "HEAD"],
      boundary: "source",
      timeoutMs: 60_000
    }
  ],
  "2": [
    {
      gateId: "repository-check",
      argv: ["node", "scripts/check-deterministic.mjs"],
      boundary: "source-provider-neutral",
      timeoutMs: 25 * 60_000
    },
    {
      gateId: "phase-2-focused-tests",
      argv: ["node", "scripts/test-phase2-focused.mjs"],
      boundary: "focused-source-provider-neutral",
      timeoutMs: 15 * 60_000
    },
    {
      gateId: "git-diff-check",
      argv: ["git", "show", "--check", "--format=", "HEAD"],
      boundary: "source",
      timeoutMs: 60_000
    }
  ],
  "3": [
    {
      gateId: "repository-check",
      argv: ["node", "scripts/check-deterministic.mjs"],
      boundary: "source-provider-neutral",
      timeoutMs: 25 * 60_000
    },
    {
      gateId: "phase-3-focused-tests",
      argv: ["node", "scripts/test-phase3-focused.mjs"],
      boundary: "focused-source-provider-neutral",
      timeoutMs: 15 * 60_000
    },
    {
      gateId: "git-diff-check",
      argv: ["git", "show", "--check", "--format=", "HEAD"],
      boundary: "source",
      timeoutMs: 60_000
    }
  ],
  "4": [
    {
      gateId: "repository-check",
      argv: ["node", "scripts/check-deterministic.mjs"],
      boundary: "source-provider-neutral",
      timeoutMs: 25 * 60_000
    },
    {
      gateId: "phase-4-focused-tests",
      argv: [
        "node",
        "--test",
        "--test-reporter=./scripts/lib/zero-skip-test-reporter.mjs",
        "tests/worker-presentation.test.mjs",
        "tests/mcp-worker-broker.test.mjs"
      ],
      boundary: "focused-source-provider-neutral",
      timeoutMs: 5 * 60_000
    },
    {
      gateId: "git-diff-check",
      argv: ["git", "show", "--check", "--format=", "HEAD"],
      boundary: "source",
      timeoutMs: 60_000
    }
  ],
  "5": [
    {
      gateId: "repository-check",
      argv: ["node", "scripts/check-deterministic.mjs"],
      boundary: "source-provider-neutral",
      timeoutMs: 25 * 60_000
    },
    {
      gateId: "phase-5-focused-tests",
      argv: [
        "node",
        "--test",
        "--test-reporter=./scripts/lib/zero-skip-test-reporter.mjs",
        "tests/worker-safety-proofs.test.mjs",
        ...WORKER_MUTATION_SEMANTIC_TEST_FILES
      ],
      boundary: "focused-source-provider-neutral",
      timeoutMs: 10 * 60_000
    },
    {
      gateId: "git-diff-check",
      argv: ["git", "show", "--check", "--format=", "HEAD"],
      boundary: "source",
      timeoutMs: 60_000
    }
  ],
  aggregate: [
    {
      gateId: "repository-check",
      argv: ["node", "scripts/check-deterministic.mjs"],
      boundary: "source-provider-neutral",
      timeoutMs: 25 * 60_000
    },
    {
      gateId: "aggregate-qualification",
      argv: [
        "node",
        "scripts/worker-broker-evidence.mjs",
        "verify",
        "--all",
        "--strict"
      ],
      boundary: "release",
      timeoutMs: 5 * 60_000
    },
    {
      gateId: "git-diff-check",
      argv: ["git", "show", "--check", "--format=", "HEAD"],
      boundary: "source",
      timeoutMs: 60_000
    }
  ]
});

export function computeProofManifestDigest(phase) {
  const manifest = PHASE_PROOF_GATE_MANIFEST[String(phase)];
  if (!manifest) throw new Error("No proof gate manifest exists for this phase.");
  return sha256Text(stableStringify(manifest));
}

export const PHASE_PREREQUISITES = Object.freeze({
  "0": Object.freeze([]),
  "1": Object.freeze(["0"]),
  "2": Object.freeze(["0", "1"]),
  "3": Object.freeze(["0", "1"]),
  "4": Object.freeze(["0", "1", "2", "3"]),
  "5": Object.freeze(["0", "1", "2", "3", "4"]),
  aggregate: Object.freeze(["0", "1", "2", "3", "4", "5"])
});

export function isEvidenceOnlyPath(relative) {
  const normalized = String(relative || "").replace(/\\/g, "/");
  return EVIDENCE_ONLY_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function proofProducedStatusIsCurrent(record) {
  const phase = String(record?.phase ?? "");
  if (NUMBERED_PHASE_SET.has(phase)) {
    return record?.status === "implemented_unverified"
      || record?.status === "verified_on_draft";
  }
  return phase === "aggregate" && record?.status === "qualified";
}

export const QUALIFICATION_BOUNDARIES = Object.freeze([
  "deterministic",
  "installedHost",
  "provider",
  "release"
]);

export const RECORD_TOP_LEVEL_FIELDS = new Set([
  "schemaVersion",
  "roadmapVersion",
  "recordType",
  "issue",
  "pullRequest",
  "phase",
  "slice",
  "status",
  "recordedAt",
  "releaseQualification",
  "evidenceSystemQualification",
  "provisionalSupportingRecord",
  "proofProducer",
  "independentReviewReceipt",
  "qualification",
  "source",
  "installation",
  "runtime",
  "prerequisites",
  "verification",
  "scenarios",
  "liveScenarios",
  "liveQualificationReceipts",
  "ci",
  "authorities",
  "limits",
  "recordDigest"
]);

export const VERIFICATION_FIELDS = new Set([
  "gateId",
  "command",
  "argv",
  "boundary",
  "outcome",
  "startedAt",
  "endedAt",
  "exitCode",
  "testsPassed",
  "testsSkipped",
  "testsFailed",
  "outputDigest",
  "assertions",
  "skipMeaning"
]);

export const PROOF_PRODUCER_FIELDS = new Set([
  "id",
  "version",
  "manifestDigest"
]);

export const INDEPENDENT_REVIEW_RECEIPT_V1_FIELDS = new Set([
  "schemaVersion",
  "producerId",
  "producerVersion",
  "manifestDigest",
  "reviewerRuntimeDigest",
  "headCommit",
  "headTree",
  "sourceInventoryDigest",
  "phaseScopeDigest",
  "startedAt",
  "endedAt",
  "outcome",
  "unresolvedFindings",
  "receiptDigest"
]);

export const SIGNED_REVIEW_REFERENCE_FIELDS = new Set(["path", "digest"]);

export const INDEPENDENT_REVIEW_RECEIPT_V2_FIELDS = new Set([
  "schemaVersion",
  "producerId",
  "producerVersion",
  "reviewRequest",
  "attestation",
  "issuer",
  "keyFingerprint",
  "receiptDigest"
]);

export const REVIEW_REQUEST_FIELDS = new Set([
  "schemaVersion",
  "domain",
  "producerId",
  "producerVersion",
  "manifestDigest",
  "phase",
  "createdAt",
  "expiresAt",
  "nonce",
  "source",
  "diff",
  "proof",
  "prerequisite",
  "requestDigest"
]);

export const REVIEW_REQUEST_SOURCE_FIELDS = new Set([
  "headCommit",
  "headTree",
  "sourceInventoryDigest",
  "phaseScopeDigest",
  "phaseScopePaths"
]);

export const REVIEW_REQUEST_DIFF_FIELDS = new Set([
  "baseCommit",
  "headCommit",
  "patchDigest",
  "pathsDigest",
  "paths"
]);

export const REVIEW_REQUEST_PROOF_FIELDS = new Set([
  "path",
  "recordDigest",
  "producerManifestDigest",
  "gateIds"
]);

export const REVIEW_REQUEST_PREREQUISITE_FIELDS = new Set([
  "phase",
  "path",
  "recordDigest",
  "gateIds"
]);

export const REVIEW_ATTESTATION_FIELDS = new Set([
  "schemaVersion",
  "domain",
  "issuer",
  "keyFingerprint",
  "algorithm",
  "requestPath",
  "requestDigest",
  "nonce",
  "manifestDigest",
  "reviewerRuntimeDigest",
  "headCommit",
  "headTree",
  "sourceInventoryDigest",
  "phaseScopeDigest",
  "diffBaseCommit",
  "diffPatchDigest",
  "diffPathsDigest",
  "proofRecordDigest",
  "prerequisiteRecordDigest",
  "startedAt",
  "endedAt",
  "outcome",
  "unresolvedFindings",
  "signature",
  "attestationDigest"
]);

export const SOURCE_FIELDS = new Set([
  "pluginVersion",
  "foundationCommit",
  "headCommit",
  "headTree",
  "sourceInventoryDigest",
  "phaseScopeDigest",
  "cleanTreeAtVerification",
  "phaseScopePaths"
]);

export const INSTALLATION_FIELDS = new Set([
  "method",
  "sourcePluginInventoryDigest",
  "installedPluginInventoryDigest",
  "installedFileCount",
  "sourceAndInstalledInventoriesEqual",
  "privateInstallPathRecorded"
]);

export const RUNTIME_FIELDS = new Set([
  "platform",
  "architecture",
  "node",
  "git",
  "codexStandalone",
  "codexDesktopBundled",
  "grokBuild",
  "grokBuildRevision",
  "mcpProtocolVersion"
]);

export const SCENARIO_FIELDS = new Set([
  "id",
  "boundary",
  "expected",
  "actual",
  "outcome",
  "measurements",
  "negative"
]);

export const NUMERIC_MEASUREMENT_FIELDS = new Set([
  "durationMs",
  "spawnLatencyMs",
  "terminalVisibilityMs",
  "cancellationRequestToProcessGroupGoneMs",
  "cancellationRequestToTerminalRecordMs",
  "workerCount",
  "messageCount",
  "deliveredCount",
  "rejectedCount",
  "deliveryUnknownCount",
  "duplicateDeliveryCount",
  "providerLaunchCount",
  "artifactCount",
  "changedFileCount",
  "parentMutationCount",
  "assertionCount",
  "testsPassed",
  "testsFailed",
  "testsSkipped",
  "retryCount",
  "conflictCount",
  "gapCount",
  "bytes"
]);

export const BOOLEAN_MEASUREMENT_FIELDS = new Set([
  "parentUnchanged",
  "workspaceIsolated",
  "terminalObserved",
  "processGroupGone"
]);

export const MEASUREMENT_FIELDS = new Set([
  ...NUMERIC_MEASUREMENT_FIELDS,
  ...BOOLEAN_MEASUREMENT_FIELDS
]);

export const LIVE_SCENARIO_FIELDS = new Set([
  "id",
  "boundary",
  "runtime",
  "expected",
  "actual",
  "outcome"
]);

export const LIVE_QUALIFICATION_RECEIPTS_FIELDS = new Set([
  "syntheticDirectMcp",
  "naturalCodexHost"
]);

export const LIVE_RECEIPT_REFERENCE_FIELDS = new Set([
  "path",
  "receiptDigest"
]);

export const LIVE_RECEIPT_FIELDS = new Set([
  "schemaVersion",
  "producerId",
  "producerVersion",
  "manifestDigest",
  "authorityMode",
  "phase",
  "pluginVersion",
  "headCommit",
  "headTree",
  "sourceInventoryDigest",
  "phaseScopeDigest",
  "repositoryBeforeDigest",
  "repositoryAfterDigest",
  "sourcePluginInventoryDigest",
  "installedPluginInventoryDigest",
  "installedFileCount",
  "installedEntrypointDigest",
  "providerCapabilityDigest",
  "observedProviderCapabilities",
  "observedToolIds",
  "providerBinaryDigest",
  "providerVersion",
  "providerRevision",
  "mcpProtocolVersion",
  "codexBinaryDigest",
  "codexVersion",
  "codexModel",
  "hostTaskDigest",
  "installationMethod",
  "scenarios",
  "outcome",
  "startedAt",
  "endedAt",
  "receiptDigest"
]);

export const LIVE_RECEIPT_SCENARIO_FIELDS = new Set([
  "id",
  "spawnInvocationCount",
  "spawnReplayCount",
  "providerLaunchCount",
  "providerTerminalCount",
  "workerTerminalCount",
  "resultReadCount",
  "reconnectCount",
  "cancelInvocationCount",
  "cancelReplayCount",
  "uniqueCancelRequestCount",
  "cancellationEventCount",
  "duplicateLaunchCount",
  "mailbox",
  "workerHostVerification",
  "processGroupGone",
  "taskRuntimeCleaned",
  "runnerTemporaryArtifactsRemoved",
  "qualificationSessionDeleted"
]);

export const LIVE_RECEIPT_SCENARIO_COUNT_FIELDS = new Set([
  "spawnInvocationCount",
  "spawnReplayCount",
  "providerLaunchCount",
  "providerTerminalCount",
  "workerTerminalCount",
  "resultReadCount",
  "reconnectCount",
  "cancelInvocationCount",
  "cancelReplayCount",
  "uniqueCancelRequestCount",
  "cancellationEventCount",
  "duplicateLaunchCount"
]);

export const LIVE_RECEIPT_MAILBOX_FIELDS = new Set([
  "providerGenerationCount",
  "providerSessionCount",
  "promptCount",
  "sendInvocationCount",
  "sendReplayCount",
  "acceptedCount",
  "deliveredCount",
  "deliveryUnknownCount",
  "rejectedCount",
  "finalReportSequence",
  "replayPromptDelta",
  "retainedBodyCount",
  "closed"
]);

export const LIVE_RECEIPT_SCENARIO_BOOLEAN_FIELDS = new Set([
  "processGroupGone",
  "taskRuntimeCleaned",
  "runnerTemporaryArtifactsRemoved",
  "qualificationSessionDeleted"
]);

export const AUTHORITIES_FIELDS = new Set([
  "workerClaims",
  "runtimeObservations",
  "hostVerification",
  "independentValidation"
]);

export const LIMITS_FIELDS = new Set([
  "residualRisks",
  "unsupportedPlatforms",
  "invalidationTriggers",
  "supersededBy",
  "liveQualificationGaps"
]);

export const CI_FIELDS = new Set(["workflowUrl", "runId", "attempt", "jobs"]);

export const CI_JOB_FIELDS = new Set(["name", "result"]);

export const LEDGER_FIELDS = new Set([
  "schemaVersion",
  "roadmapVersion",
  "issue",
  "updatedAt",
  "entries"
]);

export const LEDGER_ENTRY_FIELDS = new Set([
  "phase",
  "slice",
  "status",
  "path",
  "recordDigest",
  "sourceCommit",
  "currency",
  "recordedAt"
]);

export const EVIDENCE_PATH_FIELDS = new Set([
  ...RECORD_TOP_LEVEL_FIELDS,
  ...VERIFICATION_FIELDS,
  ...PROOF_PRODUCER_FIELDS,
  ...INDEPENDENT_REVIEW_RECEIPT_V1_FIELDS,
  ...INDEPENDENT_REVIEW_RECEIPT_V2_FIELDS,
  ...SIGNED_REVIEW_REFERENCE_FIELDS,
  ...REVIEW_REQUEST_FIELDS,
  ...REVIEW_REQUEST_SOURCE_FIELDS,
  ...REVIEW_REQUEST_DIFF_FIELDS,
  ...REVIEW_REQUEST_PROOF_FIELDS,
  ...REVIEW_REQUEST_PREREQUISITE_FIELDS,
  ...REVIEW_ATTESTATION_FIELDS,
  ...SOURCE_FIELDS,
  ...INSTALLATION_FIELDS,
  ...RUNTIME_FIELDS,
  ...SCENARIO_FIELDS,
  ...LIVE_SCENARIO_FIELDS,
  ...LIVE_QUALIFICATION_RECEIPTS_FIELDS,
  ...LIVE_RECEIPT_REFERENCE_FIELDS,
  ...LIVE_RECEIPT_FIELDS,
  ...LIVE_RECEIPT_SCENARIO_FIELDS,
  ...AUTHORITIES_FIELDS,
  ...LIMITS_FIELDS,
  ...CI_FIELDS,
  ...CI_JOB_FIELDS,
  ...LEDGER_FIELDS,
  ...LEDGER_ENTRY_FIELDS,
  ...QUALIFICATION_BOUNDARIES,
  ...MEASUREMENT_FIELDS,
  "phase",
  "recordDigest",
  "gateIds"
]);

export const STATUS_SET = new Set([
  "not_started",
  "implemented_unverified",
  "verified_on_draft",
  "qualified",
  "blocked",
  "deferred",
  "historical"
]);

export const OUTCOME_SET = new Set(["pass", "fail", "skip", "not_run"]);

export const VERIFIED_STATUS_SET = new Set(["verified_on_draft", "qualified"]);

export const NUMBERED_PHASES = Object.freeze(["0", "1", "2", "3", "4", "5"]);

export const NUMBERED_PHASE_SET = new Set(NUMBERED_PHASES);

export const SHA256 = /^[0-9a-f]{64}$/;

export const MAX_EVIDENCE_RECORD_BYTES = 256 * 1024;

export const MAX_EVIDENCE_STRING_CHARS = 4096;

export const MAX_EVIDENCE_ARRAY_ITEMS = 128;

export const MAX_PHASE_SCOPE_PATHS = 512;

export const MAX_EVIDENCE_DEPTH = 10;

export const PROTECTED_REVIEW_TRUST_FILE = ".worker-broker-host-state/review-trust-v1.json";

export const PROTECTED_REVIEW_TRUST_MAX_BYTES = 64 * 1024;

export const PROTECTED_REVIEW_MODULE_MAX_BYTES = 2 * 1024 * 1024;

export const PROTECTED_REVIEW_GIT_PATH = "/usr/bin/git";

export const PROTECTED_REVIEW_EMPTY_HOOKS_PATH = ".worker-broker-host-state/empty-hooks";

const PROTECTED_REVIEW_OPERATION_PATH =
  "scripts/trusted/worker-broker-review-operation.cjs";

export const PROTECTED_REVIEW_RUNTIME_BUNDLE_PATHS = Object.freeze([
  "package-lock.json",
  "package.json",
  "plugins/grok/scripts/lib/redact.mjs",
  "scripts/lib/plugin-inventory.mjs",
  "scripts/lib/static-esm-import-parser.mjs",
  "scripts/lib/worker-broker-evidence-authority.mjs",
  "scripts/lib/worker-broker-evidence-core.mjs",
  "scripts/lib/worker-broker-evidence-files.mjs",
  "scripts/lib/worker-broker-evidence-inventory.mjs",
  "scripts/lib/worker-broker-evidence-ledger.mjs",
  "scripts/lib/worker-broker-evidence-proof.mjs",
  "scripts/lib/worker-broker-evidence-protected-trust.mjs",
  "scripts/lib/worker-broker-evidence-record.mjs",
  "scripts/lib/worker-broker-evidence-review.mjs",
  "scripts/lib/worker-broker-evidence-toolchain.mjs",
  "scripts/lib/worker-broker-evidence-verification.mjs",
  "scripts/lib/worker-mutation-test-inventory.mjs",
  "scripts/trusted/worker-broker-review-operation.cjs",
  "scripts/trusted/worker-broker-review.mjs"
]);

export const PROTECTED_REVIEW_TRUST_FIELDS = new Set([
  "schemaVersion",
  "domain",
  "issuer",
  "algorithm",
  "publicKeySpkiBase64",
  "keyFingerprint",
  "revokedKeyFingerprints",
  "gitDigest",
  "runtimeBundle",
  "runtimeBundleDigest",
  "policyDigest",
  "descriptorDigest"
]);

export const PROTECTED_REVIEW_RUNTIME_BUNDLE_ENTRY_FIELDS = new Set(["path", "digest"]);

const PROTECTED_REVIEW_POLICY = Object.freeze({
  schemaVersion: 1,
  attestationDomain: REVIEW_ATTESTATION_DOMAIN,
  algorithm: REVIEW_ATTESTATION_ALGORITHM,
  trustSource: "fixed-root-owned-runtime-sibling",
  runtimeOwnerUid: 0,
  gitPath: PROTECTED_REVIEW_GIT_PATH,
  emptyHooksPath: PROTECTED_REVIEW_EMPTY_HOOKS_PATH,
  runtimeBundlePaths: PROTECTED_REVIEW_RUNTIME_BUNDLE_PATHS,
  operationPath: PROTECTED_REVIEW_OPERATION_PATH,
  workspaceRole: "data-only",
  privateKeyLocation: "external-issuer-only"
});

export const PROTECTED_REVIEW_POLICY_DIGEST = sha256Text(
  stableStringify(PROTECTED_REVIEW_POLICY)
);

export const LEDGER_LOCK_NAME = ".ledger.lock";

export const LEDGER_LOCK_OWNER_FILE = "owner.json";

export const LEDGER_LOCK_TRANSITION_FILE = "transition.json";

export const LEDGER_LOCK_WAIT_MS = 5_000;

export const LEDGER_LOCK_CONSTRUCTION_GRACE_MS = 30_000;

export const LEDGER_LOCK_RECORD_BYTES = 4 * 1024;

export const ATOMIC_REPLACE_COMMIT_STATE = Symbol("atomic-replace-commit-state");

export const LEDGER_LOCK_RELEASE_FAILURE = Symbol("ledger-lock-release-failure");

export const LEDGER_LOCK_ACTION_COMPLETED = Symbol("ledger-lock-action-completed");

export const LEDGER_CURRENCIES = new Set(["current", "historical", "invalidated"]);

export const PRIVATE_EVIDENCE_PATH = /(?:^|[\s"'(=])(?:file:\/\/(?:localhost)?)?(?:\/(?:private\/)?tmp(?:\/|\b)|\/(?:private\/)?var\/folders(?:\/|\b)|\/root(?:\/|\b)|~\/|\/(?:Users|home)\/[^\s"'`;,)\]}]+|[A-Za-z]:[\\/]Users[\\/][^\s"'`;,)\]}]+)/i;

export const PRIVATE_EVIDENCE_FIELD = /(?:^|_)(?:raw|private|authorization|api_key|access_token|refresh_token|tokens?|password|passwd|pwd|secret|credential|cookie)(?:_|$)/;

export function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function sha256File(absolute) {
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    return sha256Text(fs.readlinkSync(absolute));
  }
  return sha256Text(fs.readFileSync(absolute));
}

export function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
