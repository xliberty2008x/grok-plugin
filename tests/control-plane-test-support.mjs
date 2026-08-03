import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  appendLifecycleEvent,
  assertContextCompatible,
  assertContextManifestIntegrity,
  assertTaskContextReady,
  buildRuntimeEvidence,
  buildTaskEnvelope,
  buildWorkerReport,
  buildWorkerReportOutputSchema,
  captureContextManifest,
  composeProviderPrompt,
  composeWorkerReportRepairPrompt,
  CONTEXT_METADATA_POLICIES,
  evaluateScope,
  observeChangedPaths
} from "../plugins/grok/scripts/lib/task-contract.mjs";
import { validateReview, REVIEW_SCHEMA } from "../plugins/grok/scripts/lib/grok-provider.mjs";
import { processStartToken } from "../plugins/grok/scripts/lib/process-control.mjs";
import { STDIN_READY_MARKER } from "../plugins/grok/scripts/lib/stdin.mjs";
import {
  initRepo,
  git,
  run,
  runCompanion,
  spawnNonblockingStdin,
  testEnvironment,
  waitFor,
  ROOT,
  tempDir
} from "./helpers.mjs";
import { installFakeGrok, readFakeLog } from "./fake-grok.mjs";
import { installPinnedFakeCompanion } from "./pinned-fake-grok.mjs";
import { missingInvalidProviderCapabilityReceiptMessage } from "../plugins/grok/scripts/lib/host.mjs";

const PROVIDER_LIFECYCLE_AVAILABLE = Boolean(processStartToken(process.pid));

function fixture(config = {}) {
  const data = tempDir("grok-cp-data-");
  const fake = installFakeGrok(tempDir("grok-cp-fake-"), config);
  const env = testEnvironment({ fake, pluginData: data });
  // Avoid nested-companion refusal when this suite runs under a Grok rescue worker.
  delete env.GROK_COMPANION_CHILD;
  delete env.GROK_COMPANION_JOB_MARKER;
  delete env.GROK_AGENT;
  delete env.GROK_LEADER_SOCKET;
  return { fake, env, pluginData: data };
}

function parseJson(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function canonicalizeForDigest(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalizeForDigest);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalizeForDigest(value[key])])
  );
}

function stableDigestForTest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalizeForDigest(value)))
    .digest("hex");
}

function workerReport(overrides = {}) {
  return `GROK_WORKER_REPORT: ${JSON.stringify({
    outcome: "complete",
    summary: "Fixture task completed",
    changedFiles: [],
    checksClaimed: [],
    acceptanceResults: [
      { id: "AC-01", status: "met" },
      { id: "AC-02", status: "met" }
    ],
    risks: [],
    questions: [],
    ...overrides
  })}`;
}

export {
  assert, crypto, fs, path, test, appendLifecycleEvent,
  assertContextCompatible, assertContextManifestIntegrity, assertTaskContextReady, buildRuntimeEvidence, buildTaskEnvelope, buildWorkerReport,
  buildWorkerReportOutputSchema, captureContextManifest, composeProviderPrompt, composeWorkerReportRepairPrompt, CONTEXT_METADATA_POLICIES, evaluateScope,
  observeChangedPaths, validateReview, REVIEW_SCHEMA, processStartToken, STDIN_READY_MARKER, initRepo,
  git, run, runCompanion, spawnNonblockingStdin, testEnvironment, waitFor,
  ROOT, tempDir, installFakeGrok, readFakeLog, installPinnedFakeCompanion, missingInvalidProviderCapabilityReceiptMessage,
  PROVIDER_LIFECYCLE_AVAILABLE, fixture, parseJson, canonicalizeForDigest, stableDigestForTest, workerReport
};
