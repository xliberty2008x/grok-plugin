import assert from "node:assert/strict";
import test from "node:test";

import { hasGrokAncestor, processStartToken } from "../plugins/grok/scripts/lib/process-control.mjs";
import {
  PUBLIC_JOB_SUMMARY_ELLIPSIS,
  PUBLIC_JOB_SUMMARY_LIMIT,
  projectPublicJobSummary
} from "../plugins/grok/scripts/lib/public-job-summary.mjs";
import {
  publicJob,
  renderJob
} from "../plugins/grok/scripts/lib/companion-shared.mjs";
import { initRepo, runCompanion, tempDir, testEnvironment } from "./helpers.mjs";
import { installFakeGrok } from "./fake-grok.mjs";

const PROVIDER_LIFECYCLE_AVAILABLE = Boolean(processStartToken(process.pid));
const NESTED_GROK_SESSION = hasGrokAncestor();

const ISSUE_114_FULL_SUMMARY =
  "Implemented collision-safe (tenantId, idempotencyKey) caching with in-flight coalescing and failed-charge eviction; added timer-free regression tests. Only src/payment-service.mjs and test/payment-service.test.mjs were changed.";
const ISSUE_114_FIRST_SENTENCE =
  "Implemented collision-safe (tenantId, idempotencyKey) caching with in-flight coalescing and failed-charge eviction; added timer-free regression tests.";

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

function fixture(config = {}) {
  const data = tempDir();
  const fake = installFakeGrok(tempDir(), config);
  const env = testEnvironment({ fake, pluginData: data });
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

test("public job summary helper keeps short text unchanged", () => {
  const short = "Only src/payment-service.mjs changed.";
  assert.deepEqual(projectPublicJobSummary(short), {
    summary: short,
    truncated: false
  });
});

test("public job summary helper does not cut the issue-114 path mid-token", () => {
  assert.equal(ISSUE_114_FULL_SUMMARY.length > PUBLIC_JOB_SUMMARY_LIMIT, true);
  assert.equal(ISSUE_114_FIRST_SENTENCE.length <= PUBLIC_JOB_SUMMARY_LIMIT, true);
  const projected = projectPublicJobSummary(ISSUE_114_FULL_SUMMARY);
  assert.equal(projected.truncated, true);
  assert.equal(projected.summary.endsWith(PUBLIC_JOB_SUMMARY_ELLIPSIS), true);
  assert.equal(projected.summary.length <= PUBLIC_JOB_SUMMARY_LIMIT, true);
  assert.equal(projected.summary.endsWith("Only src/"), false);
  assert.equal(projected.summary.includes("Only src/"), false);
  assert.equal(projected.summary, `${ISSUE_114_FIRST_SENTENCE}${PUBLIC_JOB_SUMMARY_ELLIPSIS}`);
});

test("public job summary helper prefers a word boundary when no sentence fits", () => {
  const token = "src/payment-service.mjs";
  const prefix = "Changed ";
  const filler = "x".repeat(PUBLIC_JOB_SUMMARY_LIMIT - prefix.length - 4);
  const source = `${prefix}${filler} ${token} and more trailing words that overflow the budget`;
  const projected = projectPublicJobSummary(source);
  assert.equal(projected.truncated, true);
  assert.equal(projected.summary.endsWith(PUBLIC_JOB_SUMMARY_ELLIPSIS), true);
  assert.equal(projected.summary.includes(token), false);
  assert.match(projected.summary, /x+\u2026$/u);
});

test("public job summary helper never splits a unicode scalar or escape", () => {
  const emoji = "📦";
  const prefix = "Status ";
  const pad = "y".repeat(PUBLIC_JOB_SUMMARY_LIMIT - prefix.length - 1);
  const source = `${prefix}${pad}${emoji} leftover`;
  const projected = projectPublicJobSummary(source);
  assert.equal(projected.truncated, true);
  assert.equal(projected.summary.includes("\uD83C") && !projected.summary.includes("\uDFE6"), false);
  assert.equal(projected.summary.includes(emoji) || projected.summary.endsWith(PUBLIC_JOB_SUMMARY_ELLIPSIS), true);

  const escaped = `${"z".repeat(PUBLIC_JOB_SUMMARY_LIMIT - 2)}\\n more`;
  const escapedProjected = projectPublicJobSummary(escaped);
  assert.equal(escapedProjected.summary.endsWith("\\"), false);
  assert.equal(escapedProjected.summary.endsWith(PUBLIC_JOB_SUMMARY_ELLIPSIS), true);
});

test("status, result, and JSON share one truncated public summary", () => {
  const projected = projectPublicJobSummary(ISSUE_114_FULL_SUMMARY);
  const job = {
    id: "task-bbbbbbbbbbbbbbbb",
    kind: "task",
    jobClass: "task",
    write: true,
    status: "completed",
    phase: "done",
    summary: projected.summary,
    progress: "Final report ready",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    completedAt: "2026-08-15T00:00:00.000Z",
    heartbeatAt: "2026-08-15T00:00:00.000Z",
    profile: { id: "rescue-write-v3" },
    result: {
      hostVerification: "not_run",
      workerReport: {
        outcome: "complete",
        summary: ISSUE_114_FULL_SUMMARY,
        changedFiles: ["src/payment-service.mjs", "test/payment-service.test.mjs"],
        checksClaimed: [],
        acceptanceResults: [],
        risks: [],
        questions: [],
        validationIssues: []
      },
      reportRepair: {
        attempted: true,
        valid: true
      },
      providerClaims: {
        success: true,
        summary: ISSUE_114_FULL_SUMMARY
      }
    }
  };
  const snapshot = publicJob(job);
  const rendered = renderJob(job);
  assert.equal(snapshot.summary, projected.summary);
  assert.equal(snapshot.result.workerReport.summary, ISSUE_114_FULL_SUMMARY);
  assert.equal(
    rendered.includes(`Summary: ${ISSUE_114_FIRST_SENTENCE}${PUBLIC_JOB_SUMMARY_ELLIPSIS}`),
    true
  );
  assert.equal(rendered.includes(ISSUE_114_FULL_SUMMARY), true);
  assert.equal(JSON.stringify(snapshot).includes("\"summaryTruncated\""), false);
});

test("integration: report-repair result keeps a complete worker summary and a bounded public one", {
  skip: NESTED_GROK_SESSION
    ? "nested Grok ancestor refuses companion CLI (CI is the authority)"
    : !PROVIDER_LIFECYCLE_AVAILABLE && "process start tokens unavailable (ps denied in this environment)"
}, () => {
  const root = initRepo();
  const { env } = fixture({
    taskTexts: [
      JSON.stringify({ summary: "wrong provider schema", evidence: [] }),
      workerReport({
        summary: ISSUE_114_FULL_SUMMARY,
        changedFiles: []
      })
    ]
  });
  const json = parseJson(runCompanion(
    ["task", "--wait", "repair malformed final with a long summary", "--json"],
    { cwd: root, env }
  ));
  assert.equal(json.status, "completed");
  assert.equal(json.result.reportRepair.attempted, true);
  assert.equal(json.result.reportRepair.valid, true);
  assert.equal(json.result.workerReport.summary, ISSUE_114_FULL_SUMMARY);
  assert.equal(json.summary, `${ISSUE_114_FIRST_SENTENCE}${PUBLIC_JOB_SUMMARY_ELLIPSIS}`);
  assert.equal(json.summary.endsWith("Only src/"), false);

  const status = parseJson(runCompanion(["status", json.id, "--json"], { cwd: root, env }));
  assert.equal(status.summary, json.summary);
  assert.equal(status.result.workerReport.summary, ISSUE_114_FULL_SUMMARY);

  const rendered = runCompanion(["result", json.id], { cwd: root, env });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.equal(
    rendered.stdout.includes(`Summary: ${ISSUE_114_FIRST_SENTENCE}${PUBLIC_JOB_SUMMARY_ELLIPSIS}`),
    true
  );
  assert.equal(rendered.stdout.includes("Only src/payment-service.mjs"), true);
});
