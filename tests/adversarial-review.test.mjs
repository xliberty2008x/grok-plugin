import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ADVERSARIAL_NO_FINDINGS_PREFIX,
  ADVERSARIAL_REVIEW_REPAIR_PROMPT,
  structuredReviewOptionsFor,
  validateAdversarialReview
} from "../plugins/grok/scripts/lib/adversarial-review.mjs";
import {
  cleanupReviewEnvironment,
  DEFAULT_REVIEW_REPAIR_PROMPT,
  runStructuredReview,
  validateReview
} from "../plugins/grok/scripts/lib/grok-provider.mjs";
import { profileFor } from "../plugins/grok/scripts/lib/profiles.mjs";
import { installFakeGrok, readFakeLog } from "./fake-grok.mjs";
import { initRepo, runCompanion, tempDir, testEnvironment } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROMPTS = path.join(ROOT, "plugins", "grok", "prompts");

const PLAN_ONLY = {
  summary: "I will review the architecture for failure modes and tradeoffs next.",
  findings: []
};

const SUBSTANTIVE_PASS = {
  summary: `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: Isolation and same-session repair failure paths under malformed provider output. Assessment: The fail-closed path holds; residual observability risk is non-blocking. Decision: ship.`,
  findings: []
};

const PRIVATE_SENTINEL = "provider-private-sentinel-42";
const SENTINEL_PLAN_ONLY = {
  summary: `Inspecting the provider transport before reporting ${PRIVATE_SENTINEL}.`,
  findings: []
};

const FINDINGS_BEARING = {
  summary: "Dominant risk is silent incomplete completion; not ready to ship.",
  findings: [{
    severity: "high",
    title: "Plan-only zero findings become pass",
    body: "Empty findings with progress-only summary must not finalize as pass."
  }]
};

async function withFake(config, callback) {
  const fixture = installFakeGrok(tempDir("fake-grok-bin-"), config);
  const previous = { binary: process.env.GROK_BIN, auth: process.env.GROK_AUTH_PATH };
  process.env.GROK_BIN = fixture.binary;
  process.env.GROK_AUTH_PATH = fixture.authPath;
  try {
    return await callback(fixture);
  } finally {
    if (previous.binary === undefined) delete process.env.GROK_BIN;
    else process.env.GROK_BIN = previous.binary;
    if (previous.auth === undefined) delete process.env.GROK_AUTH_PATH;
    else process.env.GROK_AUTH_PATH = previous.auth;
  }
}

test("AC-01: plan/progress-only zero findings is adversarial E_SCHEMA and never pass", () => {
  for (const summary of [
    "I will review the remaining modules for failure modes.",
    "I'll inspect the design tradeoffs next.",
    "I need to challenge the sandbox assumptions.",
    "I am reviewing the retry path.",
    "Inspecting the provider transport contract.",
    "Reviewing isolation guarantees now.",
    "Searching for residual risks in the diff.",
    "Locating incomplete cleanup paths."
  ]) {
    assert.throws(
      () => validateAdversarialReview({ summary, findings: [] }),
      (error) => error?.code === "E_SCHEMA"
        && error?.details?.reason === "plan-progress-only"
        && !String(error?.message || "").includes(summary)
        && error?.details?.hint
        && !JSON.stringify(error.details).includes(summary)
    );
  }
  // Canonical validator still derives pass — specialization must reject first.
  assert.equal(validateReview(PLAN_ONLY).verdict, "pass");
  assert.throws(
    () => validateAdversarialReview(PLAN_ONLY),
    (error) => error?.code === "E_SCHEMA" && error?.details?.reason === "plan-progress-only"
  );
});

test("AC-04: empty-findings adversarial pass requires prefix plus substantive rationale", () => {
  assert.throws(
    () => validateAdversarialReview({
      summary: "Looks fine overall after a quick scan.",
      findings: []
    }),
    (error) => error?.code === "E_SCHEMA"
      && error?.details?.reason === "missing-no-findings-prefix"
  );
  assert.throws(
    () => validateAdversarialReview({
      summary: `${ADVERSARIAL_NO_FINDINGS_PREFIX} ok`,
      findings: []
    }),
    (error) => error?.code === "E_SCHEMA"
      && error?.details?.reason === "missing-completed-assessment-format"
  );
  for (const summary of [
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} I will finish the remaining architecture challenges next.`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} I have begun reviewing the remaining modules and will report later.`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} The next step is to inspect retry paths before deciding readiness.`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} This sentence has sufficient letters but offers no assessment at all.`
  ]) {
    assert.throws(
      () => validateAdversarialReview({ summary, findings: [] }),
      (error) => error?.code === "E_SCHEMA"
    );
  }
  for (const summary of [
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Assessment: The approach holds after challenge. Challenged: Retry isolation boundaries. Decision: ship.`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: Retry isolation boundaries are covered. Assessment: The approach holds after challenge. Decision: ship. trailing`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: Retry isolation boundaries are covered. Assessment: The approach holds after challenge. Decision: Ship.`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: Retry isolation boundaries are covered. Assessment: The approach holds after challenge. Assessment: Duplicate marker is invalid. Decision: ship.`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: The prior assessment reached Decision: no-ship. because isolation ownership remains unproven. Assessment: The unresolved ownership defect remains material and blocks a safe release today. Decision: ship.`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: We will inspect isolation and cleanup paths before assessing readiness. Assessment: The review is still underway and a completed conclusion will follow after further analysis. Decision: ship.`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: We’ll inspect isolation and cleanup paths before assessing readiness. Assessment: The review remains unfinished and a completed conclusion comes only after further analysis. Decision: ship.`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: I’m reviewing isolation and cleanup paths before assessing readiness. Assessment: The assessment has not finished and the final conclusion comes after further analysis. Decision: ship.`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: We should inspect isolation and cleanup paths before assessing readiness. Assessment: This remains only a preliminary review and the final conclusion comes after further analysis. Decision: ship.`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: Need to inspect isolation and cleanup paths before assessing readiness. Assessment: Analysis is not finished and the final conclusion comes after further investigation. Decision: ship.`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: I will now inspect isolation and cleanup paths before assessing readiness. Assessment: A final conclusion awaits further investigation and is not supplied in this response. Decision: ship.`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: pending pending pending pending. Assessment: pending pending pending pending. Decision: ship.`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: <what was challenged and why today>. Assessment: <why it holds or residual non-blocking risk>. Decision: ship.`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: pending 1000 2000 3000 4000. Assessment: pending 5000 6000 7000 8000. Decision: ship.`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: alpha alpha beta beta gamma gamma delta delta. Assessment: epsilon epsilon zeta zeta theta theta kappa kappa. Decision: ship.`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: alpha alpha- alpha-- alpha--- alpha----. Assessment: beta beta- beta-- beta--- beta----. Decision: ship.`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: a b c d e 1000 2000 3000. Assessment: f g h i j 4000 5000 6000. Decision: ship.`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: Isolation boundaries are correctly preserved across every retry Assessment: The ownership token is verified before cleanup and no residual material risk remains Decision: ship.`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: too short. Assessment: The approach holds after complete failure-path analysis. Decision: ship.`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: Retry isolation boundaries under malformed output. Assessment: too short. Decision: ship.`
  ]) {
    assert.throws(
      () => validateAdversarialReview({ summary, findings: [] }),
      (error) => error?.code === "E_SCHEMA"
    );
  }
  assert.throws(
    () => validateAdversarialReview({
      summary: `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: I plan to inspect the retry isolation paths tomorrow. Assessment: The approach currently appears acceptable but review is unfinished. Decision: ship.`,
      findings: []
    }),
    (error) => error?.details?.reason === "plan-progress-segment"
  );
  const ok = validateAdversarialReview(SUBSTANTIVE_PASS);
  assert.equal(ok.verdict, "pass");
  assert.match(ok.summary, /^No material findings:/);
  const futureBehavior = validateAdversarialReview({
    summary: `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: Crash recovery and cancellation boundaries across provider restarts. Assessment: The guard will preserve ownership because the persisted token is checked before cleanup. Decision: ship.`,
    findings: []
  });
  assert.equal(futureBehavior.verdict, "pass");
  const firstPersonFutureBehavior = validateAdversarialReview({
    summary: `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: Ownership preservation across cleanup and retry transitions under provider restarts. Assessment: We will preserve exact ownership because persisted tokens are checked before cleanup. Decision: ship.`,
    findings: []
  });
  assert.equal(firstPersonFutureBehavior.verdict, "pass");
  const technicalNotation = validateAdversarialReview({
    summary: `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: Result<T> propagation through retry and cleanup ownership boundaries. Assessment: Map<String, Job> state remains consistent because token checks precede deletion. Decision: ship.`,
    findings: []
  });
  assert.equal(technicalNotation.verdict, "pass");
  const completedGerund = validateAdversarialReview({
    summary: `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: Reviewing the provider lifecycle revealed no session leakage or unsafe cleanup. Assessment: The completed analysis found ownership checks preserved across retries. Decision: ship.`,
    findings: []
  });
  assert.equal(completedGerund.verdict, "pass");
});

test("PR #89: whole-segment placeholders reject without banning technical or operational prose", () => {
  for (const summary of [
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: Pending writes are drained before ownership release during shutdown. Assessment: Ownership checks remain exact because cleanup waits for the drain to finish. Decision: ship.`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: Isolation boundaries across retry and cleanup ownership transitions. Assessment: Unknown residual risk remains non-blocking after isolation analysis. Decision: ship.`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: Post-release monitoring across isolation and ownership boundaries. Assessment: A residual risk report will be provided via metrics and does not block release. Decision: ship.`
  ]) {
    assert.equal(validateAdversarialReview({ summary, findings: [] }).verdict, "pass");
  }

  for (const summary of [
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: pending pending pending pending. Assessment: The approach holds after complete failure-path analysis of isolation. Decision: ship.`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: Retry isolation boundaries under malformed provider output paths. Assessment: pending 1000 2000 3000 4000. Decision: ship.`,
    `${ADVERSARIAL_NO_FINDINGS_PREFIX} Challenged: todo tbd pending unknown placeholder. Assessment: The approach holds after complete failure-path analysis of isolation. Decision: ship.`
  ]) {
    assert.throws(
      () => validateAdversarialReview({ summary, findings: [] }),
      (error) => error?.code === "E_SCHEMA"
        && String(error?.details?.reason || "").startsWith("insubstantive-")
    );
  }
});

test("AC-05: findings-bearing adversarial payloads stay needs_changes without the prefix", () => {
  const result = validateAdversarialReview(FINDINGS_BEARING);
  assert.equal(result.verdict, "needs_changes");
  assert.equal(result.findings.length, 1);
  assert.equal(result.summary.startsWith(ADVERSARIAL_NO_FINDINGS_PREFIX), false);
  assert.deepEqual(
    result.findings[0].title,
    validateReview(FINDINGS_BEARING).findings[0].title
  );
  const planLikeWithFinding = {
    ...FINDINGS_BEARING,
    summary: "I will report the dominant risk, which is already captured below."
  };
  assert.deepEqual(
    validateAdversarialReview(planLikeWithFinding),
    validateReview(planLikeWithFinding)
  );
});

test("AC-06: ordinary review options stay generic and accept legacy zero-finding summaries", async () => {
  const common = Object.freeze({
    root: "/tmp/example",
    profile: profileFor("review"),
    prompt: "review",
    stateDir: "/tmp/state"
  });
  assert.equal(structuredReviewOptionsFor("review", common), common);
  assert.equal(structuredReviewOptionsFor("stop-review", common), common);
  const adversarial = structuredReviewOptionsFor("adversarial-review", common);
  assert.notEqual(adversarial, common);
  assert.equal(adversarial.validator, validateAdversarialReview);
  assert.equal(adversarial.repairPrompt, ADVERSARIAL_REVIEW_REPAIR_PROMPT);
  assert.equal(adversarial.root, common.root);
  assert.match(DEFAULT_REVIEW_REPAIR_PROMPT, /summary and findings/);

  const ordinaryZero = validateReview({
    summary: "No defects found in the selected target.",
    findings: []
  });
  assert.equal(ordinaryZero.verdict, "pass");

  await withFake({
    review: { summary: "No defects found in the selected target.", findings: [] }
  }, async (fake) => {
    const root = initRepo();
    const stateDir = tempDir("provider-state-");
    const result = await runStructuredReview({
      root,
      profile: profileFor("review"),
      prompt: "Grok Companion review contract v1: return review schema JSON",
      stateDir,
      jobMarker: "review-ordinary-zero"
    });
    assert.equal(result.review.verdict, "pass");
    assert.equal(result.review.summary, "No defects found in the selected target.");
    const reviews = readFakeLog(fake.logFile).filter((entry) => entry.event === "headless");
    assert.equal(reviews.length, 1);
    assert.equal(cleanupReviewEnvironment(stateDir, "review-ordinary-zero").ok, true);
  });

  await withFake({
    review: { summary: "No defects found in the selected target.", findings: [] }
  }, async (fake) => {
    const root = initRepo();
    fs.appendFileSync(path.join(root, "tracked.txt"), "ordinary review control\n");
    const pluginData = tempDir("grok-plugin-data-");
    const env = testEnvironment({ fake, pluginData, sessionId: "ordinary-review-control" });
    delete env.GROK_COMPANION_CHILD;
    delete env.GROK_COMPANION_JOB_MARKER;
    delete env.GROK_AGENT;
    delete env.GROK_LEADER_SOCKET;
    const finished = runCompanion(["review", "--wait", "--json", "--scope", "working-tree"], {
      cwd: root,
      env,
      timeout: 60_000
    });
    assert.equal(finished.status, 0, finished.stderr || finished.stdout);
    const job = JSON.parse(finished.stdout);
    assert.equal(job.kind, "review");
    assert.equal(job.status, "completed");
    assert.equal(job.result.review.verdict, "pass");
    assert.equal(job.result.review.summary, "No defects found in the selected target.");
    const reviews = readFakeLog(fake.logFile).filter((entry) => entry.event === "headless");
    assert.equal(reviews.length, 1);
  });
});

test("AC-02: plan-only first adversarial response repairs once to a substantive pass", async () => {
  await withFake({
    reviewSequence: [PLAN_ONLY, SUBSTANTIVE_PASS]
  }, async (fake) => {
    const root = initRepo();
    const stateDir = tempDir("provider-state-");
    const common = {
      root,
      profile: profileFor("adversarial-review"),
      prompt: "Grok Companion adversarial review contract v1: return review schema JSON",
      stateDir,
      jobMarker: "adversarial-repair-once"
    };
    const result = await runStructuredReview(
      structuredReviewOptionsFor("adversarial-review", common)
    );
    assert.equal(result.review.verdict, "pass");
    assert.match(result.review.summary, /^No material findings:/);
    const reviews = readFakeLog(fake.logFile).filter((entry) => entry.event === "headless");
    assert.equal(reviews.length, 2);
    assert.equal(reviews[1].prompt, ADVERSARIAL_REVIEW_REPAIR_PROMPT);
    assert.equal(reviews[1].args[reviews[1].args.indexOf("--resume") + 1], result.sessionId);
    assert.equal(cleanupReviewEnvironment(stateDir, "adversarial-repair-once").ok, true);
  });
});

test("AC-03: plan-only first and repair fail E_SCHEMA without terminal pass and still clean up", async () => {
  await withFake({
    reviewSequence: [SENTINEL_PLAN_ONLY, SENTINEL_PLAN_ONLY]
  }, async (fake) => {
    const root = initRepo();
    const stateDir = tempDir("provider-state-");
    const marker = "adversarial-double-fail";
    await assert.rejects(
      () => runStructuredReview(structuredReviewOptionsFor("adversarial-review", {
        root,
        profile: profileFor("adversarial-review"),
        prompt: "Grok Companion adversarial review contract v1: return review schema JSON",
        stateDir,
        jobMarker: marker
      })),
      (error) => error?.code === "E_SCHEMA"
        && error?.details?.repairAttempted === true
        && error?.details?.attempts === 2
        && error?.details?.reason === "plan-progress-only"
        && !JSON.stringify(error).includes(PRIVATE_SENTINEL)
    );
    const reviews = readFakeLog(fake.logFile).filter((entry) => entry.event === "headless");
    assert.equal(reviews.length, 2);
    assert.equal(cleanupReviewEnvironment(stateDir, marker).ok, true);
  });
});

test("AC-07: companion foreground adversarial path uses the semantic rule end-to-end", async () => {
  await withFake({
    reviewSequence: [PLAN_ONLY, SUBSTANTIVE_PASS]
  }, async (fake) => {
    const root = initRepo();
    fs.appendFileSync(path.join(root, "tracked.txt"), "adversarial focus change\n");
    const pluginData = tempDir("grok-plugin-data-");
    const env = testEnvironment({ fake, pluginData, sessionId: "adversarial-fg-session" });
    delete env.GROK_COMPANION_CHILD;
    delete env.GROK_COMPANION_JOB_MARKER;
    delete env.GROK_AGENT;
    delete env.GROK_LEADER_SOCKET;
    const finished = runCompanion(["adversarial-review", "--wait", "--json", "--scope", "working-tree"], {
      cwd: root,
      env,
      timeout: 60_000
    });
    assert.equal(finished.status, 0, finished.stderr || finished.stdout);
    const job = JSON.parse(finished.stdout);
    assert.equal(job.kind, "adversarial-review");
    assert.equal(job.status, "completed");
    assert.equal(job.result.review.verdict, "pass");
    assert.match(job.result.review.summary, /^No material findings:/);
    assert.equal(job.progress, "Review finalized");
    assert.equal(job.result.providerSessionDeleted, true);
    const reviews = readFakeLog(fake.logFile).filter((entry) => entry.event === "headless");
    assert.equal(reviews.length, 2);
    assert.equal(reviews[1].prompt, ADVERSARIAL_REVIEW_REPAIR_PROMPT);
  });
});

test("AC-07 background/status-result: double plan-only never publishes pass and cleans up", async () => {
  await withFake({
    reviewSequence: [SENTINEL_PLAN_ONLY, SENTINEL_PLAN_ONLY]
  }, async (fake) => {
    const root = initRepo();
    fs.appendFileSync(path.join(root, "tracked.txt"), "background adversarial change\n");
    const pluginData = tempDir("grok-plugin-data-");
    const env = testEnvironment({ fake, pluginData, sessionId: "adversarial-bg-session" });
    delete env.GROK_COMPANION_CHILD;
    delete env.GROK_COMPANION_JOB_MARKER;
    delete env.GROK_AGENT;
    delete env.GROK_LEADER_SOCKET;
    const started = runCompanion(["adversarial-review", "--background", "--json", "--scope", "working-tree"], {
      cwd: root,
      env
    });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const handle = JSON.parse(started.stdout);
    assert.equal(handle.kind, "adversarial-review");
    assert.ok(handle.id);

    const status = runCompanion(
      ["status", handle.id, "--wait", "--timeout-ms", "30000", "--json"],
      { cwd: root, env, timeout: 45_000 }
    );
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const terminal = JSON.parse(status.stdout);
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.error?.code, "E_SCHEMA");
    assert.equal(terminal.result?.review, undefined);
    assert.doesNotMatch(JSON.stringify(terminal), /"verdict"\s*:\s*"pass"/);
    assert.doesNotMatch(JSON.stringify(terminal), new RegExp(PRIVATE_SENTINEL));
    assert.doesNotMatch(String(terminal.progress || ""), /Review finalized/i);
    // Isolated review home cleanup still runs on semantic failure.
    assert.equal(terminal.result?.providerSessionDeleted, true);

    const result = runCompanion(["result", handle.id, "--json"], { cwd: root, env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "failed");
    assert.equal(payload.error?.code, "E_SCHEMA");
    assert.equal(payload.result?.review, undefined);
    assert.doesNotMatch(JSON.stringify(payload), /"verdict"\s*:\s*"pass"/);
    assert.doesNotMatch(JSON.stringify(payload), new RegExp(PRIVATE_SENTINEL));

    const reviews = readFakeLog(fake.logFile).filter((entry) => entry.event === "headless");
    assert.equal(reviews.length, 2);
  });
});

test("AC-08: adversarial prompt and donor evidence encode the completion contract", () => {
  const adversarial = fs.readFileSync(path.join(PROMPTS, "adversarial-review.md"), "utf8");
  assert.match(adversarial, /Leave `findings` empty when there are no/);
  assert.match(adversarial, /runtime derives pass from zero findings/i);
  assert.match(adversarial, /No material findings:/);
  assert.match(adversarial, /Challenged:.*Assessment:.*Decision: ship\./s);
  assert.match(adversarial, /ship\s*\/\s*no-ship/i);
  assert.match(adversarial, /I will|I'll|I need to|I am reviewing|Inspecting|Reviewing|Searching|Locating/);

  const donor = fs.readFileSync(
    path.join(ROOT, "docs", "issues", "4-adversarial-review-donor-evidence.md"),
    "utf8"
  );
  assert.match(donor, /db52e28f4d9ded852ab3942cea316258ae4ef346/);
  assert.match(donor, /47348d13ec4508dcfe440e34c6d511bb02998fb2/);
  assert.match(donor, /e5478eff1e4050558e12e1328b85e6616632efb6/);
  assert.match(donor, /No material findings:/);
  assert.match(donor, /Challenged: \.\.\. Assessment: \.\.\. Decision: ship\./);
  assert.match(donor, /Rejected/);
});

test("selector does not mutate ordinary common options object", () => {
  const common = { root: "r", prompt: "p", stateDir: "s" };
  const copy = { ...common };
  const out = structuredReviewOptionsFor("review", common);
  assert.equal(out, common);
  assert.deepEqual(common, copy);
  const adv = structuredReviewOptionsFor("adversarial-review", common);
  assert.equal(common.validator, undefined);
  assert.equal(adv.validator, validateAdversarialReview);
});
