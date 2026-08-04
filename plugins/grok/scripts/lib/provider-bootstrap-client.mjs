import path from "node:path";
import { fileURLToPath } from "node:url";

import { CompanionError } from "./errors.mjs";
import {
  assertExecutableAttestation,
  sameExecutableAttestation
} from "./executable-identity.mjs";
import {
  assertProviderLaunchBinding as assertExecutableProviderLaunchBinding,
  providerLaunchBindingDigest as digestProviderLaunchBinding
} from "./provider-executable-pin.mjs";
import {
  assertWorkerOwnerControllerBinding,
  authenticateProviderBootstrapGuard,
  authenticateWorkerOwnerControllerBootstrapGuard,
  authenticateWorktreeProvisioningBootstrapGuard,
  loadProviderGuard,
  unregisterProviderGuard
} from "./recursion-guard.mjs";
import {
  attachProviderCleanupIdentity,
  ensureChildExit
} from "./provider-process.mjs";
import {
  EXACT_NONCE_ID,
  SHA256_HEX,
  exactRecord,
  isWorkerOwnerControllerBinding,
  isWorktreeProvisioningBinding,
  validWorktreeProvisioningBinding
} from "./provider-worktree-contract.mjs";

const PROVIDER_BOOTSTRAP = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "provider-bootstrap.mjs"
);
const PROVIDER_BOOTSTRAP_SPEC_FD = 6;
const MAX_PROVIDER_BOOTSTRAP_SPEC_BYTES = 64 * 1024;

export function createProviderBootstrapLaunch({
  root,
  marker,
  owner,
  binding,
  binary,
  executableIdentity = null,
  providerLaunchBinding = null,
  providerLaunchBindingDigest = null,
  args
}) {
  const worktreeProvisioning = isWorktreeProvisioningBinding(binding);
  const workerOwnerController = isWorkerOwnerControllerBinding(binding);
  const isolatedController = worktreeProvisioning || workerOwnerController;
  const pinnedProvider = providerLaunchBinding !== null;
  let assertedProviderLaunchBinding = null;
  if (pinnedProvider) {
    try {
      assertedProviderLaunchBinding =
        assertExecutableProviderLaunchBinding(providerLaunchBinding);
    } catch {
      assertedProviderLaunchBinding = null;
    }
  }
  const validOwnerController = workerOwnerController && (() => {
    try {
      assertWorkerOwnerControllerBinding(binding);
      return root !== binding.controlRoot && root !== binding.executionRoot;
    } catch {
      return false;
    }
  })();
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(marker || "")
    || typeof owner !== "string"
    || !owner
    || (worktreeProvisioning
      ? !validWorktreeProvisioningBinding(binding, root)
      : workerOwnerController
        ? !validOwnerController
      : (
        !Number.isSafeInteger(binding?.providerGeneration)
        || binding.providerGeneration < 1
        || !EXACT_NONCE_ID.test(binding?.providerSpawnIntentId || "")
      ))
    || ((isolatedController || pinnedProvider) && (() => {
      try {
        assertExecutableAttestation(executableIdentity);
        return false;
      } catch {
        return true;
      }
    })())
    || (pinnedProvider && (
      !assertedProviderLaunchBinding
      || providerLaunchBindingDigest
        !== digestProviderLaunchBinding(assertedProviderLaunchBinding)
      || assertedProviderLaunchBinding.executableIdentityDigest
        !== executableIdentity.identityDigest
      || (!isolatedController && (
        binding.providerLaunchBindingDigest !== providerLaunchBindingDigest
        || binding.providerExecutableIdentityDigest
          !== executableIdentity.identityDigest
      ))
    ))) {
    throw new CompanionError("E_STATE", "Provider bootstrap launch binding is malformed.");
  }
  const specPayload = `${JSON.stringify({
    schemaVersion: 1,
    root,
    marker,
    owner,
    binding,
    binary,
    ...((isolatedController || pinnedProvider) ? { executableIdentity } : {}),
    ...(pinnedProvider
      ? {
          providerLaunchBinding: assertedProviderLaunchBinding,
          providerLaunchBindingDigest
        }
      : {}),
    args
  })}\n`;
  if (Buffer.byteLength(specPayload, "utf8") > MAX_PROVIDER_BOOTSTRAP_SPEC_BYTES) {
    throw new CompanionError("E_USAGE", "Provider bootstrap specification exceeds its private channel limit.");
  }
  return Object.freeze({
    argv: Object.freeze(worktreeProvisioning
      ? [
          PROVIDER_BOOTSTRAP,
          "--job-marker", marker,
          "--bootstrap-purpose", binding.purpose,
          "--provisioning-attempt-id", binding.provisioningAttemptId,
          "--provisioning-fence", String(binding.provisioningFence),
          "--holder-id", binding.holderId,
          "--spawn-intent-id", binding.providerSpawnIntentId
        ]
      : workerOwnerController
        ? [
            PROVIDER_BOOTSTRAP,
            "--job-marker", marker,
            "--bootstrap-purpose", binding.purpose,
            "--controller-attempt-id", binding.controllerAttemptId,
            "--controller-fence", String(binding.controllerFence),
            "--holder-id", binding.holderId,
            "--spawn-intent-id", binding.providerSpawnIntentId
          ]
      : [
          PROVIDER_BOOTSTRAP,
          "--job-marker", marker,
          "--provider-generation", String(binding.providerGeneration),
          "--spawn-intent-id", binding.providerSpawnIntentId
        ]),
    specPayload
  });
}

export function publishProviderBootstrapSpec(child, specPayload, { timeoutMs = 5_000 } = {}) {
  const channel = child?.stdio?.[PROVIDER_BOOTSTRAP_SPEC_FD];
  if (!channel || typeof channel.end !== "function") {
    return Promise.reject(new CompanionError("E_PROTOCOL", "Provider bootstrap specification pipe is unavailable."));
  }
  if (channel.destroyed || channel.closed || channel.writableEnded) {
    return Promise.reject(new CompanionError("E_PROVIDER_EXIT", "Provider bootstrap specification pipe is already closed."));
  }
  if (typeof specPayload !== "string"
    || !specPayload.endsWith("\n")
    || Buffer.byteLength(specPayload, "utf8") > MAX_PROVIDER_BOOTSTRAP_SPEC_BYTES
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > 30_000) {
    return Promise.reject(new CompanionError("E_USAGE", "Provider bootstrap specification publication is invalid."));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const absorbLateError = () => {};
    channel.on("error", absorbLateError);
    channel.once("close", () => channel.off("error", absorbLateError));
    const timeout = setTimeout(() => fail(new CompanionError(
      "E_PROVIDER_TIMEOUT",
      "Provider bootstrap did not consume its private specification."
    )), timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      channel.off("error", onChannelError);
      channel.off("close", onChannelClose);
      child.off("error", onChildError);
      child.off("exit", onChildExit);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const fail = (error) => {
      try { channel.destroy(); } catch {}
      finish(reject, error);
    };
    const onChannelError = () => fail(new CompanionError(
      "E_PROVIDER_EXIT",
      "Provider bootstrap specification pipe failed."
    ));
    const onChannelClose = () => {
      if (!channel.writableFinished) {
        fail(new CompanionError("E_PROVIDER_EXIT", "Provider bootstrap specification pipe closed before publication."));
        return;
      }
      finish(resolve);
    };
    const onChildError = (error) => fail(error);
    const onChildExit = (code, signal) => fail(new CompanionError(
      "E_PROVIDER_EXIT",
      `Provider bootstrap exited before consuming its specification (${code ?? signal}).`
    ));
    channel.on("error", onChannelError);
    channel.once("close", onChannelClose);
    child.once("error", onChildError);
    child.once("exit", onChildExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      onChildExit(child.exitCode, child.signalCode);
      return;
    }
    try { channel.end(specPayload); }
    catch { onChannelError(); }
  });
}

export function assertProviderBootstrapReadyMessage(
  message,
  binding,
  expectedExecutableIdentity = null,
  expectedProviderLaunchBinding = null
) {
  const worktreeProvisioning = isWorktreeProvisioningBinding(binding);
  const workerOwnerController = isWorkerOwnerControllerBinding(binding);
  const writeExecution = !worktreeProvisioning
    && !workerOwnerController
    && Object.hasOwn(binding || {}, "executionBindingDigest");
  const pinnedProvider = expectedProviderLaunchBinding !== null;
  let assertedProviderLaunchBinding = null;
  if (pinnedProvider) {
    try {
      assertedProviderLaunchBinding = assertExecutableProviderLaunchBinding(
        expectedProviderLaunchBinding
      );
    } catch {
      assertedProviderLaunchBinding = null;
    }
  }
  const keys = new Set([
    "type",
    "grokPid",
    "version",
    ...(worktreeProvisioning
      ? [
          "purpose",
          "executionBindingDigest",
          "provisioningAttemptId",
          "provisioningFence",
          "holderId",
          "providerSpawnIntentId",
          "executableIdentity",
          ...(pinnedProvider
            ? [
                "providerLaunchBindingDigest",
                "providerExecutableIdentityDigest"
              ]
            : [])
        ]
      : workerOwnerController
        ? [
            "purpose",
            "executionBindingDigest",
            "effectBindingDigest",
            "controllerAttemptId",
            "controllerFence",
            "holderId",
            "providerSpawnIntentId",
            "executableIdentity"
          ]
      : [
          ...(writeExecution ? ["executionBindingDigest"] : []),
          ...(pinnedProvider
            ? [
                "providerLaunchBindingDigest",
                "providerExecutableIdentityDigest"
              ]
            : [])
        ])
  ]);
  const valid = exactRecord(message, keys)
    && message.type === "provider-ready"
    && Number.isInteger(message.grokPid)
    && message.grokPid > 0
    && /^\d+\.\d+\.\d+$/.test(message.version || "")
    && (!pinnedProvider || (
      assertedProviderLaunchBinding
      && sameExecutableAttestation(
        message.executableIdentity || expectedExecutableIdentity,
        expectedExecutableIdentity
      )
      && message.providerLaunchBindingDigest
        === digestProviderLaunchBinding(assertedProviderLaunchBinding)
      && message.providerExecutableIdentityDigest
        === assertedProviderLaunchBinding.executableIdentityDigest
      && message.providerExecutableIdentityDigest
        === expectedExecutableIdentity?.identityDigest
    ))
    && (worktreeProvisioning
      ? (
        validWorktreeProvisioningBinding(binding)
        && message.purpose === binding.purpose
        && message.executionBindingDigest === binding.executionBindingDigest
        && message.provisioningAttemptId === binding.provisioningAttemptId
        && message.provisioningFence === binding.provisioningFence
        && message.holderId === binding.holderId
        && message.providerSpawnIntentId === binding.providerSpawnIntentId
        && sameExecutableAttestation(
          message.executableIdentity,
          expectedExecutableIdentity
        )
      )
      : workerOwnerController
        ? (() => {
            try {
              assertWorkerOwnerControllerBinding(binding);
            } catch {
              return false;
            }
            return message.purpose === binding.purpose
              && message.executionBindingDigest === binding.executionBindingDigest
              && message.effectBindingDigest === binding.effectBindingDigest
              && message.controllerAttemptId === binding.controllerAttemptId
              && message.controllerFence === binding.controllerFence
              && message.holderId === binding.holderId
              && message.providerSpawnIntentId === binding.providerSpawnIntentId
              && sameExecutableAttestation(
                message.executableIdentity,
                expectedExecutableIdentity
              );
          })()
      : (
        !writeExecution
        || (
          SHA256_HEX.test(binding.executionBindingDigest || "")
          && message.executionBindingDigest === binding.executionBindingDigest
        )
      ));
  if (!valid) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Provider bootstrap readiness was not exactly bound."
    );
  }
  return message;
}

export function assertProviderBootstrapPromotionMessage(message, binding) {
  const worktreeProvisioning = isWorktreeProvisioningBinding(binding);
  const workerOwnerController = isWorkerOwnerControllerBinding(binding);
  const writeExecution = !worktreeProvisioning
    && !workerOwnerController
    && Object.hasOwn(binding || {}, "executionBindingDigest");
  const pinnedProvider = !worktreeProvisioning
    && !workerOwnerController
    && Object.hasOwn(binding || {}, "providerLaunchBindingDigest");
  const keys = new Set([
    "type",
    "marker",
    ...(worktreeProvisioning
      ? [
          "purpose",
          "executionBindingDigest",
          "provisioningAttemptId",
          "provisioningFence",
          "holderId",
          "providerSpawnIntentId"
        ]
      : workerOwnerController
        ? [
            "purpose",
            "executionBindingDigest",
            "effectBindingDigest",
            "controllerAttemptId",
            "controllerFence",
            "holderId",
            "providerSpawnIntentId"
          ]
      : [
          "providerGeneration",
          "providerSpawnIntentId",
          ...(writeExecution ? ["executionBindingDigest"] : []),
          ...(pinnedProvider
            ? [
                "providerLaunchBindingDigest",
                "providerExecutableIdentityDigest"
              ]
            : [])
        ])
  ]);
  const valid = exactRecord(message, keys)
    && message.type === "provider-promoted"
    && message.marker === binding?.marker
    && (worktreeProvisioning
      ? (
        validWorktreeProvisioningBinding(
          Object.fromEntries(
            Object.entries(binding).filter(([key]) => key !== "marker")
          )
        )
        && message.purpose === binding.purpose
        && message.executionBindingDigest === binding.executionBindingDigest
        && message.provisioningAttemptId === binding.provisioningAttemptId
        && message.provisioningFence === binding.provisioningFence
        && message.holderId === binding.holderId
        && message.providerSpawnIntentId === binding.providerSpawnIntentId
      )
      : workerOwnerController
        ? (() => {
            const withoutMarker = Object.fromEntries(
              Object.entries(binding || {}).filter(([key]) => key !== "marker")
            );
            try {
              assertWorkerOwnerControllerBinding(withoutMarker);
            } catch {
              return false;
            }
            return message.purpose === binding.purpose
              && message.executionBindingDigest === binding.executionBindingDigest
              && message.effectBindingDigest === binding.effectBindingDigest
              && message.controllerAttemptId === binding.controllerAttemptId
              && message.controllerFence === binding.controllerFence
              && message.holderId === binding.holderId
              && message.providerSpawnIntentId === binding.providerSpawnIntentId;
          })()
      : (
        message.providerGeneration === binding?.providerGeneration
        && message.providerSpawnIntentId === binding?.providerSpawnIntentId
        && (!pinnedProvider || (
          message.providerLaunchBindingDigest
            === binding.providerLaunchBindingDigest
          && message.providerExecutableIdentityDigest
            === binding.providerExecutableIdentityDigest
        ))
        && (!writeExecution || (
          SHA256_HEX.test(binding.executionBindingDigest || "")
          && message.executionBindingDigest === binding.executionBindingDigest
        ))
      ));
  if (!valid) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Provider bootstrap promotion acknowledgement was not exactly bound."
    );
  }
  return message;
}

export function waitForProviderBootstrapReady(
  child,
  cancelRequested,
  binding,
  expectedExecutableIdentity,
  {
  timeoutMs = 10_000,
  pollMs = 50,
  expectedProviderLaunchBinding = null
  } = {}
) {
  const readiness = child?.stdio?.[3];
  if (!readiness) {
    return Promise.reject(new CompanionError("E_PROTOCOL", "Provider bootstrap readiness channel is unavailable."));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    let poll = null;
    const timeout = setTimeout(() => finish(reject, new CompanionError(
      "E_PROVIDER_TIMEOUT",
      "Provider bootstrap did not publish readiness before timeout."
    )), timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      if (poll) clearTimeout(poll);
      readiness.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onError = (error) => finish(reject, error);
    const onExit = (code, signal) => finish(reject, new CompanionError(
      "E_PROVIDER_EXIT",
      `Provider bootstrap exited before readiness (${code ?? signal}).`
    ));
    const onData = (chunk) => {
      buffer += String(chunk);
      if (Buffer.byteLength(buffer, "utf8") > 16 * 1024) {
        finish(reject, new CompanionError("E_PROTOCOL", "Provider bootstrap readiness exceeded its limit."));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      if (buffer.slice(newline + 1).trim()) {
        finish(reject, new CompanionError("E_PROTOCOL", "Provider bootstrap readiness contained extra data."));
        return;
      }
      let message;
      try { message = JSON.parse(buffer.slice(0, newline)); }
      catch {
        finish(reject, new CompanionError("E_PROTOCOL", "Provider bootstrap readiness was malformed."));
        return;
      }
      if (message?.type === "provider-ready" && Number.isInteger(message.grokPid)) {
        try {
          finish(resolve, assertProviderBootstrapReadyMessage(
            message,
            binding,
            expectedExecutableIdentity,
            expectedProviderLaunchBinding
          ));
        }
        catch (error) { finish(reject, error); }
        return;
      }
      finish(reject, new CompanionError(
        message?.code || "E_PROVIDER_EXIT",
        message?.message || "Provider bootstrap rejected provider startup."
      ));
    };
    const checkCancellation = () => {
      if (settled) return;
      try {
        if (cancelRequested()) {
          finish(reject, new CompanionError("E_CANCELLED", "Grok job was cancelled during provider bootstrap."));
          return;
        }
      } catch (error) {
        finish(reject, error);
        return;
      }
      poll = setTimeout(checkCancellation, pollMs);
    };
    readiness.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    poll = setTimeout(checkCancellation, pollMs);
  });
}

export function promoteProviderBootstrap(child, binding, { timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const control = child?.stdio?.[4];
    const acknowledgement = child?.stdio?.[5];
    if (!control || !acknowledgement) {
      reject(new CompanionError("E_PROCESS_IDENTITY", "Provider bootstrap promotion pipes are unavailable."));
      return;
    }
    let settled = false;
    let buffer = "";
    // Retain passive error listeners for each pipe's remaining lifetime. The
    // exact handshake listener below still fails closed while admission is in
    // flight, and a late EPIPE can never become an uncaught process error.
    const absorbControlError = () => {};
    const absorbAcknowledgementError = () => {};
    control.on("error", absorbControlError);
    acknowledgement.on("error", absorbAcknowledgementError);
    control.once("close", () => control.off("error", absorbControlError));
    acknowledgement.once("close", () => acknowledgement.off("error", absorbAcknowledgementError));
    const timeout = setTimeout(() => finish(reject, new CompanionError(
      "E_PROVIDER_TIMEOUT",
      "Provider bootstrap did not acknowledge durable dispatch promotion."
    )), timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      control.off("error", onControlError);
      acknowledgement.off("data", onData);
      acknowledgement.off("error", onAcknowledgementError);
      acknowledgement.off("end", onAcknowledgementClosed);
      acknowledgement.off("close", onAcknowledgementClosed);
      child.off("error", onChildError);
      child.off("exit", onChildExit);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onControlError = () => finish(reject, new CompanionError(
      "E_PROVIDER_EXIT",
      "Provider bootstrap promotion control closed before acknowledgement."
    ));
    const onAcknowledgementError = () => finish(reject, new CompanionError(
      "E_PROVIDER_EXIT",
      "Provider bootstrap promotion acknowledgement pipe failed."
    ));
    const onAcknowledgementClosed = () => finish(reject, new CompanionError(
      "E_PROVIDER_EXIT",
      "Provider bootstrap closed before promotion acknowledgement."
    ));
    const onChildError = (error) => finish(reject, error);
    const onChildExit = (code, signal) => finish(reject, new CompanionError(
      "E_PROVIDER_EXIT",
      `Provider bootstrap exited before promotion acknowledgement (${code ?? signal}).`
    ));
    const onData = (chunk) => {
      buffer += String(chunk);
      if (Buffer.byteLength(buffer, "utf8") > 16 * 1024) {
        finish(reject, new CompanionError("E_PROTOCOL", "Provider bootstrap promotion acknowledgement exceeded its limit."));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      if (buffer.slice(newline + 1).trim()) {
        finish(reject, new CompanionError(
          "E_PROTOCOL",
          "Provider bootstrap promotion acknowledgement contained extra data."
        ));
        return;
      }
      let message;
      try { message = JSON.parse(buffer.slice(0, newline)); }
      catch {
        finish(reject, new CompanionError("E_PROTOCOL", "Provider bootstrap promotion acknowledgement was malformed."));
        return;
      }
      try { finish(resolve, assertProviderBootstrapPromotionMessage(message, binding)); }
      catch (error) { finish(reject, error); }
    };
    control.on("error", onControlError);
    acknowledgement.on("data", onData);
    acknowledgement.on("error", onAcknowledgementError);
    acknowledgement.once("end", onAcknowledgementClosed);
    acknowledgement.once("close", onAcknowledgementClosed);
    child.once("error", onChildError);
    child.once("exit", onChildExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      onChildExit(child.exitCode, child.signalCode);
      return;
    }
    if (acknowledgement.readableEnded || acknowledgement.destroyed || acknowledgement.closed) {
      onAcknowledgementClosed();
      return;
    }
    try { control.end("promoted\n"); }
    catch { onControlError(); }
  });
}

export function authenticateBoundBootstrapGuard(
  root,
  marker,
  identity,
  binding,
  env = process.env
) {
  return isWorktreeProvisioningBinding(binding)
    ? authenticateWorktreeProvisioningBootstrapGuard(
        root,
        marker,
        identity,
        binding,
        env
      )
    : isWorkerOwnerControllerBinding(binding)
      ? authenticateWorkerOwnerControllerBootstrapGuard(
          root,
          marker,
          identity,
          binding,
          env
        )
    : authenticateProviderBootstrapGuard(root, marker, identity, binding, env);
}

export async function recordBoundBootstrapNoChild({
  providerLaunch,
  preparedLaunch,
  worktreeProvisioning,
  resolution,
  processIdentity = null,
  expectedJournalDigest = null
}) {
  const intentId = preparedLaunch?.intent?.intentId;
  if (!worktreeProvisioning) {
    return providerLaunch.noChild({ intentId, resolution });
  }
  const observedAt = new Date().toISOString();
  const cleanupProof = processIdentity
    ? {
        processIdentity,
        processGroupGone: true,
        providerGuardAbsent: true,
        observedAt
      }
    : null;
  const settlement = await providerLaunch.noChild({
    intentId,
    providerSpawnIntentId: intentId,
    expectedJournalDigest,
    resolution,
    processIdentity,
    cleanupProof
  });
  const job = settlement?.job;
  const durableIntent = job?.provisioningRuntime?.intent;
  const durableProof = job?.provisioningRuntime?.cleanupProof;
  const cleanupBound = processIdentity
    ? (
        durableProof?.processGroupGone === true
        && durableProof?.providerGuardAbsent === true
        && durableProof.processIdentity?.pid === processIdentity.pid
        && durableProof.processIdentity?.startToken === processIdentity.startToken
        && durableProof.processIdentity?.processGroupId === processIdentity.processGroupId
      )
    : durableProof === null;
  const terminalSettled = typeof settlement?.settled === "boolean"
    && typeof settlement?.replayed === "boolean"
    && (settlement.settled || settlement.replayed)
    && job?.status === "failed"
    && job?.provisioning?.state === "failed"
    && durableIntent?.intentId === intentId
    && durableIntent?.providerSpawnIntentId === intentId
    && durableIntent?.status === "no-child"
    && durableIntent?.resolution === resolution
    && cleanupBound;
  const cleanupPendingSettled = Boolean(
    processIdentity
    && typeof settlement?.retained === "boolean"
    && typeof settlement?.replayed === "boolean"
    && (settlement.retained || settlement.replayed)
    && job?.status === "queued"
    && job?.provisioning?.state === "cleanup_pending"
    && job.provisioning.previousJournalDigest === expectedJournalDigest
    && durableIntent?.intentId === intentId
    && durableIntent?.providerSpawnIntentId === intentId
    && durableIntent?.status === "registered"
    && durableIntent?.resolution === null
    && cleanupBound
  );
  if (!terminalSettled && !cleanupPendingSettled) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Worktree provisioning no-child outcome was not durably cleanup-bound."
    );
  }
  return settlement;
}

export async function settleWorktreeBootstrapRegistrationFailure({
  providerLaunch,
  preparedLaunch,
  processIdentity,
  cleanupProof
}) {
  if (typeof providerLaunch?.settleRegistrationFailure !== "function") {
    return Object.freeze({
      reconciled: false,
      retainedPreparedIntent: true
    });
  }
  const outcome = await providerLaunch.settleRegistrationFailure({
    intentId: preparedLaunch.intent.intentId,
    providerSpawnIntentId: preparedLaunch.intent.intentId,
    expectedPlannedJournalDigest:
      preparedLaunch.intent.expectedPlannedJournalDigest,
    processIdentity,
    cleanupProof
  });
  if (outcome?.reconciled !== true) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Worktree bootstrap registration failure was not durably reconciled."
    );
  }
  return outcome;
}

export async function cleanupBoundBootstrapStart({
  child,
  identity,
  root,
  marker,
  stagedProfile,
  guardRecord = null,
  guardBinding,
  env = process.env
}) {
  await ensureChildExit(child, identity);
  let exactGuard = guardRecord;
  if (!exactGuard) {
    try {
      const loaded = loadProviderGuard(root, marker);
      exactGuard = loaded
        ? authenticateBoundBootstrapGuard(root, marker, identity, guardBinding, env)
        : null;
    }
    catch (error) { throw attachProviderCleanupIdentity(error, identity); }
  }
  if (exactGuard) {
    try { unregisterProviderGuard(root, marker, exactGuard, env); }
    catch (error) { throw attachProviderCleanupIdentity(error, identity); }
  }
  stagedProfile.cleanup();
}
