#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { readValidProviderCapabilityReceipt } from "../plugins/grok/scripts/lib/provider-capability.mjs";
import { providerLaunchBindingDigest } from "../plugins/grok/scripts/lib/provider-executable-pin.mjs";
import { assertDispatchContract } from "../plugins/grok/scripts/lib/worker-mutation-dispatch-contract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const MODEL = process.env.CODEX_E2E_MODEL || "gpt-5.5";
const SCHEMA = path.join(ROOT, "tests", "natural-codex-output.schema.json");
const CODEX_HOME = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
const DATA_ROOT = path.join(CODEX_HOME, "plugins", "data", "grok-grok-companion");
const SHA256_HEX = /^[a-f0-9]{64}$/;

function fail(message, details = "") {
  throw new Error(`${message}${details.trim() ? `\n${details.trim()}` : ""}`);
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== "string" || !value) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

/**
 * Accept only a clean generation-1 provider lifecycle, or exactly one production
 * authorized same-session generation-1-to-2 structured-report repair.
 * Fail closed on any broader retry/rotation shape.
 */
function assertNaturalProviderLifecycle(job) {
  try {
    assertDispatchContract(job);
  } catch (error) {
    fail(
      "Persisted natural task failed production dispatch contract validation.",
      error?.message || String(error)
    );
  }

  const spawn = job.request?.spawn;
  const dispatch = spawn?.dispatch;
  if (dispatch?.schemaVersion !== 2) {
    fail("Persisted natural task did not use dispatch-v2.");
  }

  const providerProcess = job.providerProcess;
  const providerSpawnIntent = spawn?.providerSpawnIntent;
  const providerRotationIntent = spawn?.providerRotationIntent;
  const reportRepair = job.result?.reportRepair;
  const generation = dispatch.providerGeneration;

  const boundProviderProcess = providerProcess != null
    && providerProcess.commandMarker === job.id
    && providerProcess.dispatchAttemptId === dispatch.attemptId
    && providerProcess.dispatchFence === dispatch.fence
    && Number.isSafeInteger(providerProcess.providerGeneration);

  const boundSpawnIntent = providerSpawnIntent != null
    && providerSpawnIntent.attemptId === dispatch.attemptId
    && providerSpawnIntent.dispatchFence === dispatch.fence;

  const generationOneProof = generation === 1
    && dispatch.nextProviderGeneration === null
    && dispatch.providerRotationCount == null
    && dispatch.providerRotatedAt == null
    && dispatch.providerRotationAuthorizedAt == null
    && providerRotationIntent == null
    && reportRepair == null
    && boundSpawnIntent
    && providerSpawnIntent.status === "registered"
    && providerSpawnIntent.providerGeneration === 1
    && boundProviderProcess
    && providerProcess.providerGeneration === 1;

  const boundRotationIntent = providerRotationIntent != null
    && providerRotationIntent.attemptId === dispatch.attemptId
    && providerRotationIntent.dispatchFence === dispatch.fence;

  const initialResponse = reportRepair?.initialResponse;
  const generationTwoProof = generation === 2
    && dispatch.nextProviderGeneration === null
    && dispatch.providerRotationCount === 1
    && isCanonicalIsoTimestamp(dispatch.providerRotationAuthorizedAt)
    && isCanonicalIsoTimestamp(dispatch.providerRotatedAt)
    && boundRotationIntent
    && providerRotationIntent.status === "registered"
    && providerRotationIntent.baseProviderGeneration === 1
    && providerRotationIntent.targetProviderGeneration === 2
    && boundSpawnIntent
    && providerSpawnIntent.status === "registered"
    && providerSpawnIntent.providerGeneration === 2
    && providerSpawnIntent.intentId === providerRotationIntent.intentId
    && reportRepair?.attempted === true
    && reportRepair.valid === true
    && Number.isSafeInteger(initialResponse?.bytes)
    && initialResponse.bytes > 0
    && typeof initialResponse?.digest === "string"
    && SHA256_HEX.test(initialResponse.digest)
    && Array.isArray(reportRepair.validationIssues)
    && reportRepair.validationIssues.length === 0
    && boundProviderProcess
    && providerProcess.providerGeneration === 2;

  if (!generationOneProof && !generationTwoProof) {
    fail(
      "Persisted natural task did not prove a clean generation-1 provider lifecycle or one exact authorized generation-1-to-2 report repair.",
      JSON.stringify({
        providerGeneration: generation ?? null,
        nextProviderGeneration: dispatch.nextProviderGeneration ?? null,
        providerRotationCount: dispatch.providerRotationCount ?? null,
        providerRotationAuthorizedAt: dispatch.providerRotationAuthorizedAt ?? null,
        providerRotatedAt: dispatch.providerRotatedAt ?? null,
        rotationIntentStatus: providerRotationIntent?.status ?? null,
        rotationBase: providerRotationIntent?.baseProviderGeneration ?? null,
        rotationTarget: providerRotationIntent?.targetProviderGeneration ?? null,
        spawnStatus: providerSpawnIntent?.status ?? null,
        spawnGeneration: providerSpawnIntent?.providerGeneration ?? null,
        processGeneration: providerProcess?.providerGeneration ?? null,
        reportRepair: reportRepair
          ? {
              attempted: reportRepair.attempted === true,
              valid: reportRepair.valid === true,
              initialResponseBytes: initialResponse?.bytes ?? null,
              initialResponseDigest: typeof initialResponse?.digest === "string"
                ? initialResponse.digest
                : null,
              validationIssueCount: Array.isArray(reportRepair.validationIssues)
                ? reportRepair.validationIssues.length
                : null
            }
          : null
      })
    );
  }

  return generation;
}

function run(command, args, { timeout = 60_000 } = {}) {
  return spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
    shell: false,
    timeout,
    maxBuffer: 32 * 1024 * 1024
  });
}

function checked(command, args, options) {
  const result = run(command, args, options);
  if (result.error) fail(`Could not run ${command} ${args.join(" ")}.`, result.error.message);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} exited with status ${result.status}.`, `${result.stdout || ""}\n${result.stderr || ""}`);
  return result;
}

function findJobFile(directory, name) {
  if (!fs.existsSync(directory)) return null;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isFile() && entry.name === name) return candidate;
    if (entry.isDirectory()) {
      const found = findJobFile(candidate, name);
      if (found) return found;
    }
  }
  return null;
}

function main() {
  if (process.argv.length !== 2) fail("Usage: npm run test:natural-codex");
  if (process.platform !== "darwin") fail("The natural Codex + real Grok qualification gate currently requires the authenticated macOS runner.");

  const before = checked("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grok-natural-codex-"));
  const outputFile = path.join(temporary, "codex-final.json");
  const prompt = [
    "This is a natural installed-plugin end-to-end qualification run.",
    "Use the installed $grok:rescue skill in read mode as the only delegated worker; do not substitute a native subagent or another provider if it fails.",
    "Ask Grok to inspect plugins/grok/scripts/lib/stdin.mjs and tests/pty-ingress.test.mjs and explain how GitHub issue #2's delayed nonblocking PTY EAGAIN failure is prevented.",
    "Do not edit files. Require the host to verify `git status --short`, record that verification through the plugin, fetch the final Grok result, and retain the exact Grok job ID.",
    "Return the schema object: jobId is the persisted Grok task ID, workerOutcome is complete only when the Grok worker completed, hostVerification is passed only when the plugin record says passed, and issue2Prevented is true only when the worker directly explained the implemented delayed-reader fix."
  ].join("\n");

  try {
    checked(CODEX_BIN, [
      "exec",
      "--ephemeral",
      "--dangerously-bypass-hook-trust",
      "--model", MODEL,
      "--sandbox", "danger-full-access",
      "--cd", ROOT,
      "--color", "never",
      "--output-schema", SCHEMA,
      "--output-last-message", outputFile,
      prompt
    ], { timeout: 20 * 60_000 });

    if (!fs.existsSync(outputFile)) fail("Codex did not write its schema-constrained final result.");
    let reported;
    try { reported = JSON.parse(fs.readFileSync(outputFile, "utf8")); }
    catch (error) { fail("Codex final result was not valid JSON.", error.message); }
    if (!/^task-[a-f0-9]{24}$/.test(String(reported.jobId || ""))) fail("Codex did not return a valid Grok task ID.");
    if (reported.workerOutcome !== "complete" || reported.hostVerification !== "passed" || reported.issue2Prevented !== true) {
      fail("Codex did not report the required natural host outcome.", JSON.stringify(reported));
    }

    const jobFile = findJobFile(DATA_ROOT, `${reported.jobId}.json`);
    if (!jobFile) fail(`Persisted Grok job ${reported.jobId} was not found beneath ${DATA_ROOT}.`);
    const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    if (job.id !== reported.jobId || job.status !== "completed" || job.phase !== "done") fail("Persisted Grok job did not complete successfully.", JSON.stringify({ id: job.id, status: job.status, phase: job.phase, error: job.error }));
    if (job.profile?.id !== "rescue-read-v3") fail(`Natural task used unexpected profile ${job.profile?.id || "missing"}.`);
    if (!/^\d+\.\d+\.\d+/.test(String(job.profile?.grokVersion || ""))) fail("Persisted natural task did not record a real Grok version.");
    if (job.result?.workerReport?.outcome !== "complete") fail("Persisted worker report was not complete.");
    if (job.result?.workerReport?.valid !== true
      || job.result?.workerReport?.structured !== true
      || job.result?.workerReport?.reportSource !== "acp-structured") {
      fail("Persisted natural task did not use valid native ACP structured output.");
    }
    if (job.result?.hostVerification !== "passed") fail("Persisted host verification was not passed.");
    if (job.result?.taskRuntimeCleaned !== true) fail("Persisted task did not prove transient runtime cleanup.");
    if (job.error) fail("Persisted natural task contains an error.", JSON.stringify(job.error));
    const capability = readValidProviderCapabilityReceipt({
      env: {
        ...process.env,
        GROK_COMPANION_HOST: "codex",
        GROK_COMPANION_PLUGIN_DATA: DATA_ROOT
      }
    });
    if (!capability) fail("The natural task did not leave one valid setup provider capability.");
    const spawn = job.request?.spawn;
    let observedProviderLaunchBindingDigest = null;
    try {
      observedProviderLaunchBindingDigest = providerLaunchBindingDigest(
        spawn?.providerLaunchBinding
      );
    } catch {}
    if (spawn?.providerCapabilityDigest !== capability.capabilityDigest
      || spawn?.providerLaunchBindingDigest
        !== capability.providerLaunchBindingDigest
      || observedProviderLaunchBindingDigest
        !== capability.providerLaunchBindingDigest
      || JSON.stringify(spawn.providerLaunchBinding)
        !== JSON.stringify(capability.providerLaunchBinding)) {
      fail("Persisted natural task was not bound to the exact valid setup provider pin.");
    }
    const acceptedProviderGeneration = assertNaturalProviderLifecycle(job);

    const stateRoot = path.dirname(path.dirname(jobFile));
    const grokHome = path.join(stateRoot, "task-homes", job.request?.providerHomeId || job.id, ".grok");
    for (const relative of ["auth.json", "agent-profiles"]) {
      if (fs.existsSync(path.join(grokHome, relative))) fail(`Natural task retained transient artifact ${relative}.`);
    }
    const after = checked("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout;
    if (after !== before) fail("Natural read-only Codex/Grok run changed the repository.", `before=${JSON.stringify(before)}\nafter=${JSON.stringify(after)}`);

    const codexVersion = checked(CODEX_BIN, ["--version"]).stdout.trim();
    process.stdout.write(`${JSON.stringify({
      passed: true,
      jobId: job.id,
      workerOutcome: job.result.workerReport.outcome,
      hostVerification: job.result.hostVerification,
      taskRuntimeCleaned: job.result.taskRuntimeCleaned,
      profileId: job.profile.id,
      reportSource: job.result.workerReport.reportSource,
      providerGeneration: acceptedProviderGeneration,
      providerCapabilityDigest: spawn.providerCapabilityDigest,
      providerLaunchBindingDigest: spawn.providerLaunchBindingDigest,
      codexVersion,
      grokVersion: job.profile.grokVersion || null,
      model: MODEL
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    process.stderr.write(`Natural Codex/Grok E2E failed: ${error.message}
`);
    process.exitCode = 1;
  }
}
