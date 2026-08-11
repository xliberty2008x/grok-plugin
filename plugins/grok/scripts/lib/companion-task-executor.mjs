import crypto from "node:crypto";
import process from "node:process";
import { CompanionError, asErrorPayload } from "./errors.mjs";
import { integritySnapshot } from "./git-review.mjs";
import { processStartToken } from "./process-control.mjs";
import { assertProviderLaunchBinding as assertExecutableProviderLaunchBinding, providerLaunchBindingDigest as digestProviderLaunchBinding } from "./provider-executable-pin.mjs";
import { updateJob, readJob, isCancelRequested, terminal, now } from "./state.mjs";
import { redact } from "./redact.mjs";
import { appendLifecycleEvent } from "./task-lifecycle.mjs";
import { assertContextCompatible, assertContextManifestIntegrity, captureContextManifest } from "./task-context-manifest.mjs";
import { bindContextMetadataCompleteness } from "./task-context-metadata.mjs";

const { captureCompleteContextManifest } = bindContextMetadataCompleteness({
  captureContextManifest,
  assertContextManifestIntegrity
});
import { composeProviderPrompt } from "./task-provider-prompt.mjs";
import { scrubStoredJob } from "./task-envelope.mjs";
import { CONTEXT_BINDING_MODE, verifyJobEffectivePrompt } from "./worker-context.mjs";
import { assertDispatchContract } from "./worker-mutation.mjs";
import { assertWorkerAuthorization, isDispatchV2, isSupportedWorkerDispatch } from "./worker-launch-contract.mjs";
import { assertExecutableWorkerBinding, touchJob } from "./companion-shared.mjs";

import { finalizeExecution } from "./companion-task-finalization.mjs";
import { recordExecutionFailure, runProviderExecution } from "./companion-task-result.mjs";

function prepareExecution(root, id, { dispatchAttemptId = null, dispatchFence = null } = {}) {
const exactBrokerWorkerIdentity = (identity) => Boolean(
  identity?.pid === process.pid
  && identity.startToken === processStartToken(process.pid)
  && identity.nonce === process.env.GROK_COMPANION_WORKER_NONCE
  && identity.commandMarker === id
  && identity.dispatchAttemptId === dispatchAttemptId
  && (identity.dispatchFence ?? null) === (dispatchFence ?? null)
  && (process.platform === "win32"
    ? identity.processGroupId === null
    : identity.processGroupId === process.pid)
);
let job = readJob(root, id);
let providerGeneration = null;
if (dispatchAttemptId) {
  const dispatch = job.request?.spawn?.dispatch;
  const workerIdentity = job.workerProcess;
  assertDispatchContract(job);
  providerGeneration = (Number.isSafeInteger(dispatch?.providerGeneration)
    ? dispatch.providerGeneration
    : 0) + 1;
  if (terminal(job)
    || !isSupportedWorkerDispatch(dispatch)
    || dispatch.attemptId !== dispatchAttemptId
    || (isDispatchV2(dispatch) && dispatch.fence !== dispatchFence)
    || dispatch.state !== "worker-started"
    || !exactBrokerWorkerIdentity(workerIdentity)) {
    throw new CompanionError("E_RECURSION", "Unauthenticated or stale broker worker invocation refused.");
  }
}
const receiptBacked = job.request?.contextBindingMode === CONTEXT_BINDING_MODE;
let providerExecutableBinding = null;
if (Object.hasOwn(job.request?.spawn || {}, "providerLaunchBinding")
  || Object.hasOwn(
    job.request?.spawn || {},
    "providerLaunchBindingDigest"
  )) {
  providerExecutableBinding = assertExecutableProviderLaunchBinding(
    job.request.spawn.providerLaunchBinding
  );
  if (job.request.spawn.providerLaunchBindingDigest
    !== digestProviderLaunchBinding(providerExecutableBinding)) {
    throw new CompanionError(
      "E_AUTH_REQUIRED",
      "Worker provider executable binding changed after admission."
    );
  }
}
// Broker jobs carry a durable admission witness. Exact legacy CLI dispatches
// do not; keep their existing dispatch contract while refusing any partial
// or deleted broker context binding as a legacy downgrade.
assertExecutableWorkerBinding(job, { dispatchAttemptId });
let prompt = receiptBacked
  ? verifyJobEffectivePrompt(job, {
    root,
    contextManifest: job.request?.contextManifest || null,
    composeLegacyProviderPrompt: composeProviderPrompt
  }).prompt
  : job.request?.prompt;
if (!prompt && job.request?.envelope) {
  prompt = composeProviderPrompt(job.request.envelope, {
    root,
    contextManifest: job.request?.contextManifest || null
  });
}
if (!prompt) throw new CompanionError("E_STATE", "Queued job has no prompt.");
if (dispatchAttemptId && isDispatchV2(job.request?.spawn?.dispatch)) {
  const observedPromptDigest = crypto.createHash("sha256").update(prompt).digest("hex");
  if (job.request?.providerPromptDigest !== observedPromptDigest) {
    throw new CompanionError("E_AUTH_REQUIRED", "Provider prompt no longer matches the authorized launch contract.");
  }
}

// Keep the accepted manifest available for failure evidence; exact validation happens
// inside the terminal-state guard below so drift is persisted on the job.
let preContext = job.request?.contextManifest || captureCompleteContextManifest(root, { contextPhase: "execute" });
updateJob(root, id, (current) => {
  if (terminal(current)) {
    throw new CompanionError("E_STATE", "A terminal worker cannot be restarted.");
  }
  if (dispatchAttemptId) {
    const dispatch = current.request?.spawn?.dispatch;
    const identity = current.workerProcess;
    assertDispatchContract(current);
    if (!isSupportedWorkerDispatch(dispatch)
      || dispatch.attemptId !== dispatchAttemptId
      || (isDispatchV2(dispatch) && dispatch.fence !== dispatchFence)
      || dispatch.state !== "worker-started"
      || !exactBrokerWorkerIdentity(identity)) {
      throw new CompanionError("E_RECURSION", "Broker worker authorization changed before execution.");
    }
    if (isDispatchV2(dispatch)
      && current.request?.providerPromptDigest
        !== crypto.createHash("sha256").update(prompt).digest("hex")) {
      throw new CompanionError("E_AUTH_REQUIRED", "Provider prompt changed before launch-contract consumption.");
    }
  }
  const promptDigest = crypto.createHash("sha256").update(prompt).digest("hex");
  const consumedLaunchContractDigest = dispatchAttemptId
    && isDispatchV2(current.request?.spawn?.dispatch)
    ? assertWorkerAuthorization(current, { allowLegacy: false }).launchContractDigest
    : null;
  current.status = "running";
  current.phase = "starting";
  current.startedAt = now();
  current.summary = "Starting Grok";
  current.progress = "Starting Grok";
  current.heartbeatAt = now();
  const startingRequest = {
    ...current.request,
    prompt: null,
    promptDigest,
    contextManifest: current.request?.contextManifest || preContext,
    ...(consumedLaunchContractDigest ? {
      spawn: {
        ...current.request?.spawn,
        consumedLaunchContractDigest,
        launchContractConsumedAt: now()
      }
    } : {})
  };
  // Receipt-backed jobs must retain the literal TaskEnvelope request through
  // the second, immediately-pre-spawn reconstruction check. Scrub it as soon
  // as the exact provider process is durably promoted below.
  if (receiptBacked) {
    current.request = startingRequest;
  } else {
    Object.assign(current, scrubStoredJob({
      ...current,
      request: startingRequest
    }));
  }
  if (consumedLaunchContractDigest) current.workerAuthorization = null;
  if (!dispatchAttemptId) {
    current.workerProcess = {
      ...(current.workerProcess || {}),
      pid: process.pid,
      startToken: processStartToken(process.pid),
      nonce: process.env.GROK_COMPANION_WORKER_NONCE || current.workerProcess?.nonce || crypto.randomBytes(16).toString("hex"),
      processGroupId: current.workerProcess?.processGroupId ?? (process.platform === "win32" ? null : process.pid),
      commandMarker: id
    };
  }
  current.lifecycleEvents = appendLifecycleEvent(current.lifecycleEvents, "checkpoint", "Worker starting provider execution");
  return current;
});
job = readJob(root, id);
if (dispatchAttemptId && isDispatchV2(job.request?.spawn?.dispatch)) {
  assertDispatchContract(job);
  if (!/^[0-9a-f]{64}$/.test(job.request?.spawn?.consumedLaunchContractDigest || "")
    || !job.request?.spawn?.launchContractConsumedAt) {
    throw new CompanionError("E_AUTH_REQUIRED", "Worker launch contract consumption was not durably recorded.");
  }
}
const before = job.jobClass === "review" ? integritySnapshot(root) : null;
  return {
    root, id, dispatchAttemptId, dispatchFence, exactBrokerWorkerIdentity,
    job, providerGeneration, receiptBacked, providerExecutableBinding,
    prompt, preContext, before
  };
}

function createTerminalIntentController(execution) {
  const { dispatchAttemptId, dispatchFence, exactBrokerWorkerIdentity } = execution;
let brokerTerminalIntent = null;
const terminalIntentFor = (error = null, summary = null) => {
  if (!dispatchAttemptId) return null;
  if (brokerTerminalIntent) return brokerTerminalIntent;
  const status = error
    ? (error.code === "E_CANCELLED" ? "cancelled" : "failed")
    : "completed";
  const payload = error ? redact(asErrorPayload(error)) : null;
  brokerTerminalIntent = Object.freeze({
    status,
    phase: status === "completed" ? "done" : status,
    completedAt: now(),
    error: payload,
    summary: summary || payload?.message || null
  });
  return brokerTerminalIntent;
};
const terminalIntentPatch = (current, intendedTerminal) => {
  if (!intendedTerminal || !dispatchAttemptId) return {};
  const dispatch = current.request?.spawn?.dispatch;
  if (!isSupportedWorkerDispatch(dispatch)
    || dispatch.attemptId !== dispatchAttemptId
    || (isDispatchV2(dispatch) && dispatch.fence !== dispatchFence)
    || dispatch.state !== "provider-started"
    || !exactBrokerWorkerIdentity(current.workerProcess)) return {};
  if (current.pendingTerminal
    && JSON.stringify(current.pendingTerminal) !== JSON.stringify(intendedTerminal)) {
    throw new CompanionError("E_STATE", "Durable worker terminal intent changed before finalization.");
  }
  return { pendingTerminal: intendedTerminal };
};
  return {
    terminalIntentFor,
    terminalIntentPatch,
    resetTerminalIntent: () => { brokerTerminalIntent = null; }
  };
}

async function execute(root, id, { dispatchAttemptId = null, dispatchFence = null } = {}) {
  const execution = prepareExecution(root, id, { dispatchAttemptId, dispatchFence });
  Object.assign(execution, createTerminalIntentController(execution), {
    terminalError: null,
    brokerPreProviderFailure: false,
    heartbeatTimer: null
  });
  try {
    execution.preContext = execution.job.request?.contextManifest
      ? assertContextCompatible(root, execution.job.request.contextManifest, { mode: "execute" })
      : captureCompleteContextManifest(root, { contextPhase: "execute" });
    const workerNonce = process.env.GROK_COMPANION_WORKER_NONCE;
    if (isCancelRequested(root, id, workerNonce)) {
      throw new CompanionError("E_CANCELLED", "Grok job was cancelled before provider execution.");
    }
    execution.heartbeatTimer = setInterval(() => {
      try {
        updateJob(root, id, (current) => terminal(current) ? current : touchJob(current));
      } catch {}
    }, 1000);
    execution.heartbeatTimer.unref?.();
    await runProviderExecution(execution, workerNonce);
  } catch (error) {
    execution.terminalError = error;
    execution.brokerPreProviderFailure = recordExecutionFailure(execution, error);
  } finally {
    if (execution.heartbeatTimer) clearInterval(execution.heartbeatTimer);
    const finalized = finalizeExecution(execution);
    if (finalized !== undefined) return finalized;
  }
  if (execution.terminalError) throw execution.terminalError;
  return readJob(root, id);
}

export { execute };
