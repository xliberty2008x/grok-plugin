#!/usr/bin/env node

/**
 * Single-process GitHub Actions entrypoint. Secrets are copied into a bounded
 * in-memory config and removed from process.env before any model child exists.
 */

import { createCallbackClient } from "./callback-client.mjs";
import {
  abortBootstrapFailure,
  loadBootstrapAbortConfig,
  loadRunnerConfig,
  parseWorkflowInputs,
  runCentralReview
} from "./central-runner.mjs";

const SECRET_ENV_KEYS = Object.freeze([
  "GITHUB_APP_PRIVATE_KEY",
  "RUNNER_CALLBACK_SECRET",
  "RECEIPT_PRIVATE_KEY",
  "RECEIPT_PUBLIC_KEY",
  "GROK_AUTH_JSON",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GIT_ASKPASS",
  "SSH_ASKPASS"
]);

const CONTROL_ENV_KEYS = Object.freeze([
  ...SECRET_ENV_KEYS,
  "GITHUB_APP_ID",
  "GITHUB_APP_CLIENT_ID",
  "GROK_REVIEW_WORKER_ORIGIN",
  "GROK_REVIEW_RUNTIME_COMMIT",
  "GROK_REVIEW_RUNTIME_BUNDLE_SHA256",
  "GROK_REVIEW_NODE_VERSION",
  "GROK_CLI_VERSION",
  "GROK_REVIEW_MODEL",
  "GROK_REVIEW_MODEL_VERSION",
  "GROK_REVIEW_EFFORT",
  "INPUT_REQUEST_ID",
  "INPUT_INSTALLATION_ID",
  "INPUT_REPOSITORY_ID",
  "INPUT_PULL_NUMBER",
  "INPUT_TRIGGER_KIND",
  "INPUT_TRIGGER_ID",
  "INPUT_ACTOR_ID"
]);

function inputEnvironment(env) {
  return {
    request_id: env.INPUT_REQUEST_ID,
    installation_id: env.INPUT_INSTALLATION_ID,
    repository_id: env.INPUT_REPOSITORY_ID,
    pull_number: env.INPUT_PULL_NUMBER,
    trigger_kind: env.INPUT_TRIGGER_KIND,
    trigger_id: env.INPUT_TRIGGER_ID,
    actor_id: env.INPUT_ACTOR_ID
  };
}

function publicError(error, bootstrapAbort) {
  const code = (
    typeof error?.code === "string"
    && /^[A-Za-z0-9_.:-]{1,128}$/.test(error.code)
  )
    ? error.code
    : "central_runner_failed";
  const cause = (
    typeof error?.causeCode === "string"
    && /^[A-Za-z0-9_.:-]{1,128}$/.test(error.causeCode)
  )
    ? error.causeCode
    : null;
  return { ok: false, error: code, cause, bootstrap_abort: bootstrapAbort };
}

let cancelled = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cancelled = true;
  });
}

let bootstrap = null;
try {
  const config = loadBootstrapAbortConfig(process.env);
  bootstrap = {
    config,
    callback: createCallbackClient({
      origin: config.workerOrigin,
      secret: config.callbackSecret
    })
  };
} catch {
  // If this binding is unavailable, the control-plane watchdog must reconcile
  // the bound workflow run because no authenticated runner callback is safe.
}

let centralRunnerStarted = false;
try {
  const inputs = parseWorkflowInputs(inputEnvironment(process.env));
  const config = loadRunnerConfig(process.env, {
    runtimeRoot: process.env.GITHUB_WORKSPACE || process.cwd()
  });
  const callback = bootstrap?.callback ?? createCallbackClient({
    origin: config.workerOrigin,
    secret: config.callbackSecret
  });

  for (const key of CONTROL_ENV_KEYS) delete process.env[key];

  centralRunnerStarted = true;
  const result = await runCentralReview({
    inputs,
    config,
    callback,
    cancelRequested: () => cancelled
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: result.status,
    check_id: result.checkId,
    receipt_id: result.receiptId,
    finding_count: result.findingCount,
    provider_launched: result.providerLaunched
  })}\n`);
} catch (error) {
  for (const key of CONTROL_ENV_KEYS) delete process.env[key];
  let bootstrapAbort = centralRunnerStarted ? "handled_by_runner" : "unavailable";
  if (!centralRunnerStarted && bootstrap) {
    try {
      await abortBootstrapFailure(bootstrap);
      bootstrapAbort = "sent";
    } catch {
      // Preserve the full-config failure. A failed or ambiguous callback is
      // left for the control-plane watchdog to reconcile from workflow state.
      bootstrapAbort = "failed";
    }
  }
  process.stderr.write(`${JSON.stringify(publicError(error, bootstrapAbort))}\n`);
  process.exitCode = 1;
}
