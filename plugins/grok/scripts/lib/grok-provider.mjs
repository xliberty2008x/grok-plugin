import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AcpClient,
  isCancelledPromptStopReason,
  isSuccessfulPromptStopReason
} from "./acp-client.mjs";
import { CompanionError } from "./errors.mjs";
import {
  attestSpawnedExecutable,
  materializePinnedGrokExecutable,
  sameExecutableAttestation
} from "./executable-identity.mjs";
import {
  assertProviderLaunchBinding as assertExecutableProviderLaunchBinding,
  providerLaunchBindingDigest as digestProviderLaunchBinding,
  resolveProviderExecutablePin
} from "./provider-executable-pin.mjs";
import { redact, redactText } from "./redact.mjs";
import {
  assertCompleteDetachedOwnedIdentity,
  processGroupGone,
  processStartToken,
  signalOwnedProcess
} from "./process-control.mjs";
import {
  registerProviderGuard,
  unregisterProviderGuard
} from "./recursion-guard.mjs";
import { hostCommand, hostContext, pluginDataRoot } from "./host.mjs";
import {
  EXACT_NONCE_ID,
  SHA256_HEX,
  WORKTREE_CLEANUP_CONTROLLER_PROFILE_ID,
  WORKTREE_CLEANUP_REQUEST_ALLOWLIST,
  WORKTREE_CONTROLLER_PROFILE_ID,
  WORKTREE_CONTROLLER_REQUEST_ALLOWLIST,
  WORKTREE_INTEGRATION_CONTROLLER_PROFILE_ID,
  WORKTREE_INTEGRATION_REQUEST_ALLOWLIST,
  WORKTREE_PROVISIONING_PURPOSE,
  isWorktreeProvisioningBinding
} from "./provider-worktree-contract.mjs";
import {
  assertProviderPlatform,
  childEnvironment,
  discoverGrok,
  grokVersion,
  safeMarker
} from "./provider-core.mjs";
import {
  DEFAULT_REVIEW_REPAIR_PROMPT,
  MAX_APP_REVIEW_OUTPUT_BYTES,
  MAX_SUGGESTION_REPLACEMENT_BYTES,
  REVIEW_SCHEMA,
  extractJson,
  outputSchemaDigest,
  resolveTrustedOutputSchema,
  selectAcpPermissionOption,
  validateAppReview,
  validateReview
} from "./provider-review-contract.mjs";
import {
  cleanupReviewEnvironment,
  gatedCleanupReviewEnvironment,
  reviewEnvironment
} from "./provider-credentials.mjs";
import { assertControllerGitCheckoutSafe } from "./provider-git-controller.mjs";
import {
  taskEnvironment
} from "./provider-task-environment.mjs";
import {
  attachProviderCleanupIdentity,
  captureSpawnIdentity,
  ensureChildExit,
  providerCleanupIdentity
} from "./provider-process.mjs";
import {
  inspectIsolation,
  materializeAgentProfile,
  spawnArgs
} from "./provider-profile.mjs";
import {
  assertProviderBootstrapPromotionMessage,
  assertProviderBootstrapReadyMessage,
  authenticateBoundBootstrapGuard,
  cleanupBoundBootstrapStart,
  createProviderBootstrapLaunch,
  promoteProviderBootstrap,
  publishProviderBootstrapSpec,
  recordBoundBootstrapNoChild,
  settleWorktreeBootstrapRegistrationFailure,
  waitForProviderBootstrapReady
} from "./provider-bootstrap-client.mjs";

export {
  DEFAULT_REVIEW_REPAIR_PROMPT,
  MAX_APP_REVIEW_OUTPUT_BYTES,
  MAX_SUGGESTION_REPLACEMENT_BYTES,
  REVIEW_SCHEMA,
  WORKTREE_CLEANUP_CONTROLLER_PROFILE_ID,
  WORKTREE_CLEANUP_REQUEST_ALLOWLIST,
  WORKTREE_INTEGRATION_CONTROLLER_PROFILE_ID,
  WORKTREE_INTEGRATION_REQUEST_ALLOWLIST,
  assertControllerGitCheckoutSafe,
  assertProviderPlatform,
  childEnvironment,
  cleanupReviewEnvironment,
  discoverGrok,
  gatedCleanupReviewEnvironment,
  grokVersion,
  resolveTrustedOutputSchema,
  reviewEnvironment,
  selectAcpPermissionOption,
  taskEnvironment,
  validateAppReview,
  validateReview
};

export { processStartToken } from "./process-control.mjs";

export {
  cleanupTaskRuntimeArtifacts,
  revokeTaskCredential,
  taskCredentialEnvironment,
  workerOwnerControllerEnvironment,
  workerSessionCloseControllerEnvironment
} from "./provider-controller-environments.mjs";

export {
  inspectIsolation,
  workerOwnerControllerSpawnArgs
} from "./provider-profile.mjs";

export {
  captureSpawnIdentity,
  ensureChildExit,
  providerCleanupIdentity
} from "./provider-process.mjs";

export {
  assertProviderBootstrapPromotionMessage,
  assertProviderBootstrapReadyMessage,
  authenticateBoundBootstrapGuard,
  cleanupBoundBootstrapStart,
  createProviderBootstrapLaunch,
  promoteProviderBootstrap,
  publishProviderBootstrapSpec,
  recordBoundBootstrapNoChild,
  settleWorktreeBootstrapRegistrationFailure,
  waitForProviderBootstrapReady
} from "./provider-bootstrap-client.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function cleanupFailedProviderStart({ child, identity, root, marker, stagedProfile, client = null, guardRecord = null }) {
  let cleanupError = null;
  try { client?.close(); }
  catch (error) { cleanupError = error; }

  try {
    await ensureChildExit(child, identity);
  } catch (error) {
    // Do not unregister the guard or remove the staged profile while the owned
    // process group may still be using either one.
    throw attachProviderCleanupIdentity(error, identity);
  }

  if (guardRecord) {
    try { unregisterProviderGuard(root, marker, guardRecord); }
    catch (error) { throw attachProviderCleanupIdentity(error, identity); }
  }
  try { stagedProfile.cleanup(); }
  catch (error) { cleanupError ||= error; }
  if (cleanupError) throw attachProviderCleanupIdentity(cleanupError, identity);
}

/**
 * Wait for an ACP startup request while polling the durable job cancellation
 * source. Startup does not have a session ID yet, so there is no meaningful
 * session/cancel notification to send. Rejecting here hands control directly
 * to the caller's verified process-group teardown path.
 *
 * Attach handlers to the ACP request for its full lifetime even when
 * cancellation wins. That prevents the later transport-close rejection from
 * becoming unhandled, while the single-settlement guard keeps request and
 * cancellation completion from racing caller cleanup twice.
 */
function requestDuringProviderStartup(client, method, params, timeoutMs, cancelRequested, { pollMs = 100 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let poll = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (poll) clearTimeout(poll);
      callback(value);
    };
    const cancellationError = () => new CompanionError(
      "E_CANCELLED",
      `Grok job was cancelled during ACP ${method} startup.`
    );
    const checkCancellation = () => {
      if (settled) return;
      let cancelled;
      try { cancelled = cancelRequested(); }
      catch (error) { finish(reject, error); return; }
      if (cancelled) { finish(reject, cancellationError()); return; }
      poll = setTimeout(checkCancellation, pollMs);
    };

    try {
      if (cancelRequested()) {
        finish(reject, cancellationError());
        return;
      }
    } catch (error) {
      finish(reject, error);
      return;
    }

    let request;
    try { request = client.request(method, params, timeoutMs); }
    catch (error) { finish(reject, error); return; }
    request.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
    poll = setTimeout(checkCancellation, pollMs);
  });
}

export async function openProvider({ root, profile, model = null, effort = null, stateDir, jobMarker = "probe", environment = null, knownSecrets = environment?.knownSecrets || [], cancelRequested = () => false, onEvent = () => {}, guardBinding = null, providerLaunch = null, providerExecutableBinding = null, providerExecutableEnv = process.env, strictPermissionRequests = false, testHooks = null, signalProcess = process.kill }) {
  assertProviderPlatform();
  const boundBootstrap = Boolean(guardBinding);
  const worktreeProvisioningBootstrap = isWorktreeProvisioningBinding(guardBinding);
  const setupOwnedExecutable = providerExecutableBinding == null
    ? null
    : resolveProviderExecutablePin(
        assertExecutableProviderLaunchBinding(providerExecutableBinding),
        { env: providerExecutableEnv }
      );
  if (worktreeProvisioningBootstrap
    && (
      profile?.id !== "rescue-write-v3"
      || environment?.controllerProfileId !== WORKTREE_CONTROLLER_PROFILE_ID
      || typeof environment?.controllerCwd !== "string"
      || !path.isAbsolute(environment.controllerCwd)
      || fs.realpathSync(environment.controllerCwd)
        !== environment.controllerCwd
      || environment.controllerCwd === root
      || typeof environment.stageCredential !== "function"
      || typeof environment.assertCredentialAbsent !== "function"
      || model !== null
      || effort !== null
    )) {
    throw new CompanionError(
      "E_SECURITY_PROFILE",
      "Worktree provisioning requires the private no-model controller profile."
    );
  }
  const runtimeProfile = worktreeProvisioningBootstrap
    ? Object.freeze({
        ...profile,
        id: WORKTREE_CONTROLLER_PROFILE_ID,
        sandbox: environment.sandboxProfile,
        permissionMode: "dontAsk",
        agentProfileDigest: null
      })
    : profile;
  const providerCwd = worktreeProvisioningBootstrap
    ? environment.controllerCwd
    : root;
  const durableBootstrapCallbacksPresent = !boundBootstrap || (
    typeof providerLaunch?.prepare === "function"
    && typeof providerLaunch?.noChild === "function"
    && (!worktreeProvisioningBootstrap || (
      typeof providerLaunch.registerBootstrap === "function"
      && typeof providerLaunch.settleRegistrationFailure === "function"
    ))
  );
  if (!durableBootstrapCallbacksPresent) {
    if (worktreeProvisioningBootstrap) {
      try {
        environment.revokeCredential();
        environment.assertCredentialAbsent();
      } catch (error) {
        throw new CompanionError(
          "E_STATE",
          "Incomplete worktree bootstrap authority could not revoke its controller credential.",
          { cleanupCode: error?.code || null }
        );
      }
    }
    throw new CompanionError(
      "E_STATE",
      worktreeProvisioningBootstrap
        ? "Worktree provisioning startup requires durable bootstrap registration and reconciliation callbacks."
        : "Bound provider startup requires durable spawn-intent callbacks."
    );
  }
  const discoveredBinary = setupOwnedExecutable?.binary || discoverGrok();
  let binary = discoveredBinary;
  const capturedExecutableIdentity = setupOwnedExecutable?.fileIdentity
    || (worktreeProvisioningBootstrap
      ? materializePinnedGrokExecutable(discoveredBinary, {
        directory: path.join(providerCwd, "provider-bin")
      })
      : null);
  if (capturedExecutableIdentity) {
    binary = capturedExecutableIdentity.canonicalPath;
  }
  let version = boundBootstrap ? null : grokVersion(binary);
  const safeMarker = String(jobMarker).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
  const leaderSocket = path.join(stateDir, `leader-${safeMarker}-${process.pid}-${Date.now()}.sock`);
  const stagedProfile = materializeAgentProfile(runtimeProfile, environment);
  if (worktreeProvisioningBootstrap) {
    try {
      environment.verifyGitExecutable();
      inspectIsolation(binary, providerCwd, environment);
      environment.verifyGitExecutable();
      environment.assertCredentialAbsent();
    } catch (error) {
      stagedProfile.cleanup();
      try {
        environment.revokeCredential();
        environment.assertCredentialAbsent();
      } catch (cleanupError) {
        throw new CompanionError(
          "E_STATE",
          "Controller isolation failed and its credential could not be revoked.",
          { causeCode: error?.code || null, cleanupCode: cleanupError?.code || null }
        );
      }
      throw error;
    }
  }
  let preparedLaunch = null;
  let resolvedGuardBinding = guardBinding;
  let bootstrapSpecPublication = null;
  let deferredBootstrapSpec = null;
  let provisioningActivation = null;
  let attestedExecutableIdentity =
    capturedExecutableIdentity?.attestation || null;
  let child;
  try {
    if (cancelRequested()) {
      throw new CompanionError("E_CANCELLED", "Grok job was cancelled before provider process creation.");
    }
    const providerArgs = spawnArgs({
      root: providerCwd,
      profile: runtimeProfile,
      model: worktreeProvisioningBootstrap ? null : model,
      effort: worktreeProvisioningBootstrap ? null : effort,
      leaderSocket,
      taskProfile: stagedProfile.path
    });
    const providerEnv = {
      ...(environment?.env || childEnvironment()),
      GROK_COMPANION_JOB_MARKER: safeMarker,
      GROK_DISABLE_AUTOUPDATER: "1"
    };
    if (boundBootstrap) {
      const launchIdentity = capturedExecutableIdentity?.attestation || null;
      const launchBindingDigest = setupOwnedExecutable
        ? digestProviderLaunchBinding(setupOwnedExecutable.binding)
        : null;
      const candidate = providerLaunch.prepare(Object.freeze(
        worktreeProvisioningBootstrap
          ? {
              executableIdentity: launchIdentity,
              ...(setupOwnedExecutable
                ? {
                    providerLaunchBinding: setupOwnedExecutable.binding,
                    providerLaunchBindingDigest: launchBindingDigest
                  }
                : {})
            }
          : (setupOwnedExecutable
              ? {
                  executableIdentity: launchIdentity,
                  providerLaunchBinding: setupOwnedExecutable.binding,
                  providerLaunchBindingDigest: launchBindingDigest
                }
              : {})
      ));
      if (candidate?.prepared !== true
        || candidate?.intent?.status !== "pending"
        || !EXACT_NONCE_ID.test(candidate.intent.intentId || "")
        || (worktreeProvisioningBootstrap && (
          candidate.intent.purpose !== WORKTREE_PROVISIONING_PURPOSE
          || candidate.intent.providerSpawnIntentId !== candidate.intent.intentId
          || candidate.intent.executionBindingDigest !== guardBinding.executionBindingDigest
          || !SHA256_HEX.test(candidate.intent.expectedPlannedJournalDigest || "")
          || candidate.intent.provisioningAttemptId !== guardBinding.provisioningAttemptId
          || candidate.intent.provisioningFence !== guardBinding.provisioningFence
          || candidate.intent.holderId !== guardBinding.holderId
          || !sameExecutableAttestation(
            candidate.intent.executableIdentity,
            capturedExecutableIdentity.attestation
          )
          || (setupOwnedExecutable && (
            candidate.intent.providerLaunchBindingDigest
              !== launchBindingDigest
            || digestProviderLaunchBinding(
              candidate.intent.providerLaunchBinding
            ) !== launchBindingDigest
          ))
          || candidate.intent.processIdentity !== null
      ))
        || (!worktreeProvisioningBootstrap && setupOwnedExecutable && (
          candidate.intent.providerLaunchBindingDigest !== launchBindingDigest
          || digestProviderLaunchBinding(
            candidate.intent.providerLaunchBinding
          ) !== launchBindingDigest
        ))) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Provider spawn intent was not freshly authorized for this bootstrap.");
      }
      // Only a freshly validated intent belongs to this launch attempt.
      // A replayed, foreign, or malformed pending intent must never be
      // consumed by this caller's no-child settlement path.
      preparedLaunch = candidate;
      resolvedGuardBinding = {
        ...guardBinding,
        providerSpawnIntentId: preparedLaunch.intent.intentId
      };
      await testHooks?.afterProviderIntentCommitted?.(preparedLaunch);
      const bootstrapLaunch = createProviderBootstrapLaunch({
        root: providerCwd,
        marker: safeMarker,
        owner: hostContext().sessionId,
        binding: resolvedGuardBinding,
        binary,
        executableIdentity:
          capturedExecutableIdentity?.attestation || null,
        providerLaunchBinding: setupOwnedExecutable?.binding || null,
        providerLaunchBindingDigest: setupOwnedExecutable
          ? digestProviderLaunchBinding(setupOwnedExecutable.binding)
          : null,
        args: providerArgs
      });
      child = spawn(process.execPath, bootstrapLaunch.argv, {
        cwd: providerCwd,
        env: {
          ...providerEnv,
          GROK_COMPANION_BOOTSTRAP_PLUGIN_DATA: pluginDataRoot(process.env)
        },
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"]
      });
      if (worktreeProvisioningBootstrap) {
        // Keep the child blocked on its private specification pipe until its
        // exact kernel identity has been durably installed as the fenced
        // provisioner. The bootstrap cannot register a guard or create Grok
        // before this callback succeeds.
        deferredBootstrapSpec = bootstrapLaunch.specPayload;
      } else {
        bootstrapSpecPublication = publishProviderBootstrapSpec(child, bootstrapLaunch.specPayload).then(
          () => ({ error: null }),
          (error) => ({ error })
        );
      }
      await testHooks?.afterBootstrapSpawned?.({
        child,
        preparedLaunch,
        providerCwd
      });
    } else {
      child = spawn(binary, providerArgs, {
        cwd: providerCwd,
        env: providerEnv,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"]
      });
    }
  } catch (error) {
    if (preparedLaunch && !child) {
      try {
        await recordBoundBootstrapNoChild({
          providerLaunch,
          preparedLaunch,
          worktreeProvisioning: worktreeProvisioningBootstrap,
          resolution: "spawn-not-created",
          expectedJournalDigest: preparedLaunch.intent.expectedPlannedJournalDigest || null
        });
      } catch (settlementError) {
        if (worktreeProvisioningBootstrap) {
          stagedProfile.cleanup();
          throw settlementError;
        }
      }
    }
    stagedProfile.cleanup();
    throw error;
  }
  let processIdentity;
  try { processIdentity = await captureSpawnIdentity(child); }
  catch (error) {
    if (preparedLaunch && !providerCleanupIdentity(error)) {
      try {
        await recordBoundBootstrapNoChild({
          providerLaunch,
          preparedLaunch,
          worktreeProvisioning: worktreeProvisioningBootstrap,
          resolution: worktreeProvisioningBootstrap
            ? "spawn-not-created"
            : "cleanup-proven",
          expectedJournalDigest: worktreeProvisioningBootstrap
            ? preparedLaunch.intent.expectedPlannedJournalDigest
            : null
        });
      } catch (settlementError) {
        if (worktreeProvisioningBootstrap) {
          stagedProfile.cleanup();
          throw settlementError;
        }
      }
    }
    if (!providerCleanupIdentity(error)) stagedProfile.cleanup();
    throw error;
  }
  if (!boundBootstrap && capturedExecutableIdentity) {
    try {
      attestedExecutableIdentity = attestSpawnedExecutable(
        child.pid,
        capturedExecutableIdentity
      );
    } catch (error) {
      await cleanupFailedProviderStart({
        child,
        identity: processIdentity,
        root,
        marker: safeMarker,
        stagedProfile
      });
      throw error;
    }
  }
  if (worktreeProvisioningBootstrap) {
    try {
      const activation = await providerLaunch.registerBootstrap({
        intentId: preparedLaunch.intent.intentId,
        providerSpawnIntentId: preparedLaunch.intent.intentId,
        expectedJournalDigest: preparedLaunch.intent.expectedPlannedJournalDigest,
        provisioningAttemptId: resolvedGuardBinding.provisioningAttemptId,
        provisioningFence: resolvedGuardBinding.provisioningFence,
        holderId: resolvedGuardBinding.holderId,
        executionBindingDigest: resolvedGuardBinding.executionBindingDigest,
        processIdentity
      });
      provisioningActivation = activation;
      const activatedIntent = activation?.intent;
      const activatedJournal = activation?.job?.provisioning;
      const activatedProvisioner = activatedJournal?.provisioner;
      if (activation?.activated !== true
        || typeof activation.replayed !== "boolean"
        || activatedIntent?.purpose !== WORKTREE_PROVISIONING_PURPOSE
        || activatedIntent.intentId !== preparedLaunch.intent.intentId
        || activatedIntent.providerSpawnIntentId !== preparedLaunch.intent.intentId
        || activatedIntent.executionBindingDigest !== resolvedGuardBinding.executionBindingDigest
        || activatedIntent.expectedPlannedJournalDigest
          !== preparedLaunch.intent.expectedPlannedJournalDigest
        || activatedIntent.provisioningAttemptId !== resolvedGuardBinding.provisioningAttemptId
        || activatedIntent.provisioningFence !== resolvedGuardBinding.provisioningFence
        || activatedIntent.holderId !== resolvedGuardBinding.holderId
        || !["pending", "registered"].includes(activatedIntent.status)
        || activatedIntent.processIdentity?.pid !== processIdentity.pid
        || activatedIntent.processIdentity?.startToken !== processIdentity.startToken
        || activatedIntent.processIdentity?.processGroupId !== processIdentity.processGroupId
        || activatedJournal?.state !== "provisioning"
        || activatedJournal.bindingDigest !== resolvedGuardBinding.executionBindingDigest
        || activatedJournal.attemptId !== resolvedGuardBinding.provisioningAttemptId
        || activatedJournal.fence !== resolvedGuardBinding.provisioningFence
        || activatedProvisioner?.pid !== processIdentity.pid
        || activatedProvisioner?.startToken !== processIdentity.startToken
        || activatedProvisioner?.holderId !== resolvedGuardBinding.holderId) {
        throw new CompanionError(
          "E_PROCESS_IDENTITY",
          "Worktree provisioning bootstrap identity was not durably registered."
        );
      }
      // The bootstrap remains blocked on its private specification pipe until
      // this exact PID/start-token is durable. Publishing credential bytes
      // earlier would leave an ownerless secret if the host died between HOME
      // construction and activation.
      environment.stageCredential();
      bootstrapSpecPublication = publishProviderBootstrapSpec(
        child,
        deferredBootstrapSpec
      ).then(
        () => ({ error: null }),
        (error) => ({ error })
      );
    } catch (error) {
      try {
        await cleanupBoundBootstrapStart({
          child,
          identity: processIdentity,
          root,
          marker: safeMarker,
          stagedProfile,
          guardBinding: resolvedGuardBinding
        });
        const cleanupProof = Object.freeze({
          processIdentity: Object.freeze({ ...processIdentity }),
          processGroupGone: true,
          providerGuardAbsent: true,
          observedAt: new Date().toISOString()
        });
        const registrationSettlement =
          await settleWorktreeBootstrapRegistrationFailure({
          providerLaunch,
          preparedLaunch,
          processIdentity,
          cleanupProof
        });
        if (!registrationSettlement.reconciled) {
          const details = error?.details
            && typeof error.details === "object"
            && !Array.isArray(error.details)
            ? { ...error.details }
            : {};
          details.registrationOutcome = "retained-for-durable-reconciliation";
          details.preparedIntentRetained = true;
          if (error && typeof error === "object") error.details = details;
        }
      } catch (cleanupError) {
        throw attachProviderCleanupIdentity(cleanupError, processIdentity);
      }
      throw error;
    }
  }
  let guardRecord;
  if (boundBootstrap) {
    try {
      const publication = await bootstrapSpecPublication;
      if (publication?.error) throw publication.error;
      const ready = await waitForProviderBootstrapReady(
        child,
        cancelRequested,
        resolvedGuardBinding,
        capturedExecutableIdentity?.attestation || null,
        {
          expectedProviderLaunchBinding:
            setupOwnedExecutable?.binding || null
        }
      );
      version = ready.version;
      if (capturedExecutableIdentity) {
        attestedExecutableIdentity = ready.executableIdentity
          || capturedExecutableIdentity.attestation;
      }
      guardRecord = authenticateBoundBootstrapGuard(
        root,
        safeMarker,
        processIdentity,
        resolvedGuardBinding
      );
    } catch (error) {
      try {
        await cleanupBoundBootstrapStart({
          child,
          identity: processIdentity,
          root,
          marker: safeMarker,
          stagedProfile,
          guardRecord,
          guardBinding: resolvedGuardBinding
        });
        await recordBoundBootstrapNoChild({
          providerLaunch,
          preparedLaunch,
          worktreeProvisioning: worktreeProvisioningBootstrap,
          resolution: "cleanup-proven",
          processIdentity: worktreeProvisioningBootstrap ? processIdentity : null,
          expectedJournalDigest: worktreeProvisioningBootstrap
            ? provisioningActivation?.job?.provisioning?.journalDigest || null
            : null
        });
      } catch (cleanupError) {
        throw attachProviderCleanupIdentity(cleanupError, processIdentity);
      }
      throw error;
    }
  } else {
    try {
      guardRecord = registerProviderGuard(
        root,
        safeMarker,
        processIdentity,
        hostContext().sessionId,
        "provider",
        null
      );
    }
    catch (error) {
      await cleanupFailedProviderStart({ child, identity: processIdentity, root, marker: safeMarker, stagedProfile });
      throw error;
    }
  }
  let eventError = null;
  let eventSignalError = null;
  let resolveEventFailure;
  const eventFailure = new Promise((resolve) => {
    resolveEventFailure = resolve;
  });
  const publishEventFailure = () => {
    resolveEventFailure(eventSignalError || eventError);
  };
  const permissionPolicy = (params) => {
    if (strictPermissionRequests) {
      eventError = new CompanionError(
        "E_SECURITY_PROFILE",
        "Unexpected ACP permission request under a strict provider profile."
      );
      publishEventFailure();
      return { outcome: { outcome: "cancelled" } };
    }
    if (worktreeProvisioningBootstrap) {
      return { outcome: { outcome: "cancelled" } };
    }
    const selected = selectAcpPermissionOption(params?.options, { write: runtimeProfile.id === "rescue-write-v3" });
    return selected?.optionId ? { outcome: { outcome: "selected", optionId: selected.optionId } } : { outcome: { outcome: "cancelled" } };
  };
  const emitEvent = (event) => {
    if (eventError) return;
    try { onEvent(event); }
    catch (error) {
      eventError = error;
      try {
        signalOwnedProcess(
          processIdentity.processGroupId && process.platform !== "win32"
            ? -processIdentity.processGroupId
            : child.pid,
          "SIGTERM",
          signalProcess
        );
      } catch (signalError) {
        eventSignalError = signalError;
      }
      publishEventFailure();
    }
  };
  try {
    await testHooks?.beforeDispatchPromotion?.({ processIdentity, guardRecord, preparedLaunch });
    emitEvent({
      type: "provider",
      process: processIdentity,
      version,
      ...(preparedLaunch ? { spawnIntentId: preparedLaunch.intent.intentId } : {})
    });
    if (eventError) throw eventError;
  } catch (error) {
    if (boundBootstrap) {
      await cleanupBoundBootstrapStart({
        child,
        identity: processIdentity,
        root,
        marker: safeMarker,
        stagedProfile,
        guardRecord,
        guardBinding: resolvedGuardBinding
      });
      try {
        await recordBoundBootstrapNoChild({
          providerLaunch,
          preparedLaunch,
          worktreeProvisioning: worktreeProvisioningBootstrap,
          resolution: "cleanup-proven",
          processIdentity: worktreeProvisioningBootstrap ? processIdentity : null,
          expectedJournalDigest: worktreeProvisioningBootstrap
            ? provisioningActivation?.job?.provisioning?.journalDigest || null
            : null
        });
      } catch (settlementError) {
        if (worktreeProvisioningBootstrap) {
          throw attachProviderCleanupIdentity(settlementError, processIdentity);
        }
      }
    } else {
      await cleanupFailedProviderStart({
        child,
        identity: processIdentity,
        root,
        marker: safeMarker,
        stagedProfile,
        guardRecord
      });
    }
    throw eventSignalError || eventError || error;
  }
  if (boundBootstrap) {
    try {
      await promoteProviderBootstrap(child, {
        marker: safeMarker,
        ...resolvedGuardBinding
      });
    } catch (error) {
      try {
        await cleanupBoundBootstrapStart({
          child,
          identity: processIdentity,
          root,
          marker: safeMarker,
          stagedProfile,
          guardRecord,
          guardBinding: resolvedGuardBinding
        });
        if (worktreeProvisioningBootstrap) {
          await recordBoundBootstrapNoChild({
            providerLaunch,
            preparedLaunch,
            worktreeProvisioning: true,
            resolution: "cleanup-proven",
            processIdentity,
            expectedJournalDigest:
              provisioningActivation?.job?.provisioning?.journalDigest || null
          });
        }
      } catch (cleanupError) {
        throw attachProviderCleanupIdentity(cleanupError, processIdentity);
      }
      throw error;
    }
  }
  const settleWorktreeProvisioningStartupFailure = async () => {
    if (!worktreeProvisioningBootstrap) return;
    await recordBoundBootstrapNoChild({
      providerLaunch,
      preparedLaunch,
      worktreeProvisioning: true,
      resolution: "cleanup-proven",
      processIdentity,
      expectedJournalDigest:
        provisioningActivation?.job?.provisioning?.journalDigest || null
    });
  };
  const client = new AcpClient(child, {
    timeoutMs: 30000,
    permissionPolicy,
    knownSecrets,
    ...(worktreeProvisioningBootstrap
      ? {
          outboundAllowlist: {
            requests: WORKTREE_CONTROLLER_REQUEST_ALLOWLIST,
            notifications: []
          },
          cancelPermissions: true
        }
      : {})
  });
  client.on("update", emitEvent);
  client.on("stderr", (text) => emitEvent({ type: "diagnostic", text: redactText(text, knownSecrets) }));
  let initialized;
  try {
    initialized = await requestDuringProviderStartup(
      client,
      "initialize",
      { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }, clientInfo: { name: "grok-companion", version: "0.3.0-dev.1" } },
      30000,
      cancelRequested
    );
    if (eventSignalError || eventError) throw eventSignalError || eventError;
  } catch (error) {
    await cleanupFailedProviderStart({ child, identity: processIdentity, root, marker: safeMarker, stagedProfile, client, guardRecord });
    await settleWorktreeProvisioningStartupFailure();
    throw eventSignalError || eventError || error;
  }
  if (worktreeProvisioningBootstrap) {
    try {
      environment.revokeCredential();
      environment.assertCredentialAbsent();
    } catch (error) {
      await cleanupFailedProviderStart({
        child,
        identity: processIdentity,
        root,
        marker: safeMarker,
        stagedProfile,
        client,
        guardRecord
      });
      await settleWorktreeProvisioningStartupFailure();
      throw error;
    }
  }
  if (initialized?.protocolVersion !== 1
    || (!worktreeProvisioningBootstrap
      && !initialized?.agentCapabilities?.loadSession)) {
    const error = new CompanionError("E_CAPABILITY", "Grok ACP v1 with session loading is required.");
    await cleanupFailedProviderStart({ child, identity: processIdentity, root, marker: safeMarker, stagedProfile, client, guardRecord });
    await settleWorktreeProvisioningStartupFailure();
    throw error;
  }
  if (worktreeProvisioningBootstrap) {
    return {
      binary,
      version,
      child,
      client,
      initialized,
      leaderSocket,
      process: processIdentity,
      marker: safeMarker,
      guardRecord,
      emitEvent,
      eventError: () => eventSignalError || eventError,
      eventFailure,
      cleanupAgentProfile: stagedProfile.cleanup,
      controllerCwd: providerCwd,
      controllerProfileId: runtimeProfile.id,
      executableIdentity: attestedExecutableIdentity
    };
  }
  const availableModels = initialized?._meta?.modelState?.availableModels || [];
  const selectedModel = model
    ? availableModels.find((item) => item.modelId === model)
    : availableModels.find((item) => item.modelId === initialized?._meta?.modelState?.currentModelId) || availableModels[0];
  if (model && !selectedModel) {
    const error = new CompanionError("E_CAPABILITY", `Model ${model} is not advertised by Grok.`, { available: availableModels.map((x) => x.modelId) });
    await cleanupFailedProviderStart({ child, identity: processIdentity, root, marker: safeMarker, stagedProfile, client, guardRecord });
    await settleWorktreeProvisioningStartupFailure();
    throw error;
  }
  const efforts = (selectedModel?._meta?.reasoningEfforts || []).map((item) => item.id);
  if (effort && efforts.length && !efforts.includes(effort)) {
    const error = new CompanionError("E_CAPABILITY", `Reasoning effort ${effort} is not advertised for model ${selectedModel.modelId}.`, { available: efforts });
    await cleanupFailedProviderStart({ child, identity: processIdentity, root, marker: safeMarker, stagedProfile, client, guardRecord });
    await settleWorktreeProvisioningStartupFailure();
    throw error;
  }
  return {
    binary,
    version,
    child,
    client,
    initialized,
    leaderSocket,
    process: processIdentity,
    marker: safeMarker,
    guardRecord,
    emitEvent,
    eventError: () => eventSignalError || eventError,
    eventFailure,
    cleanupAgentProfile: stagedProfile.cleanup,
    executableIdentity: attestedExecutableIdentity
  };
}

function headlessArgs({ root, promptFile, model, effort, leaderSocket, resumeSessionId, newSessionId, structured, sandboxProfile, outputSchema = null }) {
  const args = ["--cwd", root, "--agent", "explore", "--sandbox", sandboxProfile, "--permission-mode", "default", "--tools", "todo_write", "--disallowed-tools", "Agent,run_terminal_cmd,read_file,list_dir,grep,search_replace,write,web_search,web_fetch,search_tool,use_tool", "--deny", "MCPTool(*)", "--deny", "Bash(*)", "--deny", "Read(*)", "--deny", "Grep(*)", "--deny", "Edit(*)", "--deny", "Write(*)", "--deny", "WebFetch(*)", "--disable-web-search", "--no-subagents", "--no-memory", "--no-plan", "--leader-socket", leaderSocket];
  if (model) args.push("--model", model);
  if (effort) args.push("--reasoning-effort", effort);
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  else args.push("--session-id", newSessionId);
  if (structured) {
    // Trusted schema is passed as a single argv element (spawn shell:false) — never via shell interpolation.
    const schema = resolveTrustedOutputSchema(outputSchema);
    args.push("--json-schema", JSON.stringify(schema));
  } else {
    args.push("--output-format", "json");
  }
  args.push("--verbatim", "--prompt-file", promptFile);
  return args;
}

function anonymousPrompt(directory, prompt) {
  const temporary = path.join(directory, `prompt-${process.pid}-${crypto.randomBytes(8).toString("hex")}.md`);
  let fd = null;
  try {
    fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600);
    fs.unlinkSync(temporary);
    fs.writeSync(fd, String(prompt), 0, "utf8");
    return fd;
  } catch (error) {
    if (fd != null) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

export async function runHeadless({ root, profile, prompt, model, effort, stateDir, jobMarker = "review", resumeSessionId = null, structured = false, outputSchema = null, cancelRequested = () => false, onEvent = () => {}, timeoutMs = 15 * 60 * 1000, maxOutputBytes = 1024 * 1024, signalProcess = process.kill }) {
  assertProviderPlatform();
  // Validate trusted schema early (bounded + serializable) before spawning.
  const trustedSchema = structured ? resolveTrustedOutputSchema(outputSchema) : null;
  const binary = discoverGrok(), version = grokVersion(binary);
  const marker = safeMarker(jobMarker), isolation = reviewEnvironment(
    stateDir,
    marker,
    { providerExecutableBinary: binary }
  );
  const leaderSocket = path.join(stateDir, `leader-${marker}-${process.pid}-${Date.now()}.sock`);
  // Prefer anonymous fd 3 prompts locally. On CI (GitHub Actions sets CI=true), sandbox
  // re-exec cannot re-open /dev/fd/3 reliably ("Bad file descriptor"). Use a mode-0600
  // file under the isolated review home instead; it is removed with that home.
  const forceNamedPrompt = process.env.GROK_HEADLESS_PROMPT_ON_DISK === "1"
    || process.env.CI === "true"
    || process.env.GITHUB_ACTIONS === "true"
    || process.env.GROK_COMPANION_HOST === "ci";
  let promptFile;
  let promptFd = null;
  let namedPromptPath = null;
  if (forceNamedPrompt) {
    // Prefer /tmp so the strict sandbox can always open the prompt path.
    const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-ci-prompt-"));
    namedPromptPath = path.join(promptDir, "prompt.md");
    fs.writeFileSync(namedPromptPath, String(prompt), { mode: 0o600 });
    promptFile = namedPromptPath;
  } else {
    promptFile = process.platform === "linux" ? "/proc/self/fd/3" : "/dev/fd/3";
    promptFd = anonymousPrompt(isolation.home, prompt);
  }
  const newSessionId = resumeSessionId ? null : crypto.randomUUID();
  const closePromptFd = () => {
    if (promptFd != null) {
      try { fs.closeSync(promptFd); } catch { /* already closed */ }
      promptFd = null;
    }
    if (namedPromptPath) {
      try { fs.rmSync(path.dirname(namedPromptPath), { recursive: true, force: true }); } catch { /* best-effort */ }
      namedPromptPath = null;
    }
  };
  let child;
  try {
    const stdio = forceNamedPrompt
      ? ["ignore", "pipe", "pipe"]
      : ["ignore", "pipe", "pipe", promptFd];
    if (cancelRequested()) {
      throw new CompanionError("E_CANCELLED", "Grok job was cancelled before provider process creation.");
    }
    child = spawn(binary, headlessArgs({ root, promptFile, model, effort, leaderSocket, resumeSessionId, newSessionId, structured, sandboxProfile: isolation.sandboxProfile, outputSchema: trustedSchema }), { cwd: root, env: { ...isolation.env, GROK_COMPANION_JOB_MARKER: marker }, shell: false, detached: process.platform !== "win32", stdio });
  } catch (error) {
    closePromptFd();
    throw error;
  }
  let identity;
  try { identity = await captureSpawnIdentity(child); }
  catch (error) {
    closePromptFd();
    const failedIdentity = providerCleanupIdentity(error);
    if (failedIdentity) {
      try { onEvent({ type: "provider", process: failedIdentity, version }); } catch {}
    }
    const cleanup = gatedCleanupReviewEnvironment(stateDir, marker, failedIdentity);
    if (!cleanup.ok && error && typeof error === "object") {
      const details = error.details && typeof error.details === "object" && !Array.isArray(error.details) ? { ...error.details } : {};
      details.privacyWarning = [details.privacyWarning, cleanup.warning].filter(Boolean).join("; ");
      error.details = details;
    }
    throw error;
  }
  let guardRecord;
  try { guardRecord = registerProviderGuard(root, marker, identity, hostContext().sessionId); }
  catch (error) {
    closePromptFd();
    try { await ensureChildExit(child, identity); }
    catch (shutdownError) {
      try { onEvent({ type: "provider", process: identity, version }); } catch {}
      const cleanup = gatedCleanupReviewEnvironment(stateDir, marker, identity);
      const details = shutdownError?.details && typeof shutdownError.details === "object" && !Array.isArray(shutdownError.details)
        ? { ...shutdownError.details }
        : {};
      if (!cleanup.ok) details.privacyWarning = [details.privacyWarning, cleanup.warning].filter(Boolean).join("; ");
      if (shutdownError && typeof shutdownError === "object") shutdownError.details = details;
      throw attachProviderCleanupIdentity(shutdownError, identity);
    }
    cleanupReviewEnvironment(stateDir, marker);
    throw error;
  }
  let stdout = "", stdoutBytes = 0, stderr = "", terminationReason = null, forceTimer = null, eventError = null, terminationSignalError = null;
  const MAX_OUTPUT = maxOutputBytes;
  let rejectTerminationSignalFailure;
  const terminationSignalFailure = new Promise((_, reject) => {
    rejectTerminationSignalFailure = reject;
  });
  const terminate = (signal) => {
    try {
      assertCompleteDetachedOwnedIdentity(identity);
      return signalOwnedProcess(
        identity.processGroupId && process.platform !== "win32"
          ? -identity.processGroupId
          : identity.pid,
        signal,
        signalProcess
      );
    } catch (error) {
      if (!terminationSignalError) {
        terminationSignalError = error;
        rejectTerminationSignalFailure(error);
      }
      return false;
    }
  };
  const beginTermination = (reason) => {
    if (terminationReason) return;
    terminationReason = reason;
    if (!terminate("SIGTERM")) return;
    forceTimer = setTimeout(() => { terminate("SIGKILL"); }, 2000);
  };
  const emitEvent = (event) => {
    if (eventError) return;
    try { onEvent(event); }
    catch (error) { eventError = error; beginTermination("event"); }
  };
  const completion = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal])); });
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (terminationReason === "output") return;
    const bytes = Buffer.byteLength(chunk);
    if (stdoutBytes + bytes > MAX_OUTPUT) { beginTermination("output"); return; }
    stdout += chunk;
    stdoutBytes += bytes;
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-65536); emitEvent({ type: "diagnostic", text: redactText(chunk, isolation.knownSecrets) }); });
  emitEvent({ type: "provider", process: identity, version });
  emitEvent({ type: "session", sessionId: resumeSessionId || newSessionId });
  const cancelPoll = setInterval(() => { if (!terminationReason && cancelRequested()) beginTermination("cancel"); }, 100);
  const timeout = setTimeout(() => beginTermination("timeout"), timeoutMs);
  let code, signal;
  try {
    [code, signal] = await Promise.race([completion, terminationSignalFailure]);
  } catch (error) {
    if (error === terminationSignalError) throw error;
    throw new CompanionError("E_PROVIDER_EXIT", `Could not start Grok: ${error.message}`);
  } finally {
    clearInterval(cancelPoll); clearTimeout(timeout); if (forceTimer) clearTimeout(forceTimer);
    closePromptFd();
    await ensureChildExit(child, identity, { signalProcess });
    unregisterProviderGuard(root, marker, guardRecord);
  }
  if (eventError) { cleanupReviewEnvironment(stateDir, marker); throw eventError; }
  if (terminationReason === "cancel") throw new CompanionError("E_CANCELLED", "Grok job was cancelled.");
  if (terminationReason === "timeout") throw new CompanionError("E_TIMEOUT", "Grok headless review timed out.");
  if (terminationReason === "output") throw new CompanionError("E_OUTPUT_LIMIT", `Grok headless output exceeded ${MAX_OUTPUT} bytes.`);
  if (code !== 0) {
    const diagnostic = redactText(stderr || stdout, isolation.knownSecrets).slice(-8000);
    if (/login|auth|unauthori[sz]ed|401/i.test(diagnostic)) throw new CompanionError("E_AUTH_REQUIRED", `Grok authentication is required. Run \`grok login\`, then ${hostCommand("setup")}.`, { diagnostic });
    throw new CompanionError("E_PROVIDER_EXIT", `Grok headless review exited (${code ?? signal}).`, { code, signal, diagnostic });
  }
  let payload;
  try { payload = JSON.parse(stdout); } catch { throw new CompanionError("E_PROTOCOL", "Grok headless mode returned malformed JSON."); }
  const sessionId = payload.sessionId || resumeSessionId || newSessionId;
  if (!sessionId) throw new CompanionError("E_PROTOCOL", "Grok headless mode returned no session ID.");
  const expectedSessionId = resumeSessionId || newSessionId;
  if (sessionId !== expectedSessionId) throw new CompanionError("E_PROTOCOL", `Grok returned session ${sessionId} while ${expectedSessionId} was required.`);
  return { sessionId, text: redactText(String(payload.text ?? "").trim(), isolation.knownSecrets), structuredOutput: redact(payload.structuredOutput, isolation.knownSecrets), stopReason: payload.stopReason || "EndTurn", provider: { version, process: identity, isolatedHome: isolation.home }, capabilities: { transport: "headless", agent: "explore", sandbox: isolation.sandboxProfile } };
}

export async function runProvider({ root, profile, prompt, model, effort, stateDir, jobMarker = "job", providerHomeId = null, resumeSessionId = null, cancelRequested = () => false, onEvent = () => {}, guardBinding = null, providerLaunch = null, providerExecutableBinding = null, providerExecutableEnv = process.env, primaryTurnController = null, mailboxController = null, outputSchema = null, testHooks = null, timeoutMs = undefined, signalProcess = process.kill }) {
  if (profile.transport === "headless") {
    if (providerExecutableBinding !== null) {
      throw new CompanionError(
        "E_CAPABILITY",
        "Durably bound worker launches require the attested ACP bootstrap transport."
      );
    }
    if (outputSchema != null) {
      throw new CompanionError(
        "E_CAPABILITY",
        "Task structured output requires the ACP provider transport."
      );
    }
    return runHeadless({ root, profile, prompt, model, effort, stateDir, jobMarker, resumeSessionId, cancelRequested, onEvent, signalProcess, ...(timeoutMs == null ? {} : { timeoutMs }) });
  }
  const boundOutputSchemaDigest = outputSchemaDigest(outputSchema);
  const resolvedExecutablePin = providerExecutableBinding === null
    ? null
    : resolveProviderExecutablePin(
        assertExecutableProviderLaunchBinding(providerExecutableBinding),
        { env: providerExecutableEnv }
      );
  const environment = /^rescue-(read|write|report)-v3$/.test(profile.id || "")
    ? taskEnvironment(
        stateDir,
        root,
        profile,
        providerHomeId || jobMarker,
        {
          providerExecutableBinary:
            resolvedExecutablePin?.binary || null
        }
      )
    : null;
  const effectiveProfile = environment?.sandboxProfile ? { ...profile, sandbox: environment.sandboxProfile } : profile;
  const boundProviderLaunch = providerLaunch
    && typeof providerLaunch.prepare === "function"
    && typeof providerLaunch.noChild === "function" ? {
    prepare: (details = {}) => providerLaunch.prepare(Object.freeze({
      ...details,
      promptDigest: crypto.createHash("sha256").update(String(prompt || "")).digest("hex"),
      profileId: effectiveProfile.id,
      profileContractVersion: effectiveProfile.contractVersion,
      agentProfileDigest: effectiveProfile.agentProfileDigest,
      outputSchemaDigest: boundOutputSchemaDigest
    })),
    noChild: (details) => providerLaunch.noChild(details)
  } : providerLaunch;
  try {
    if (environment) {
      inspectIsolation(
        resolvedExecutablePin?.binary || discoverGrok(),
        root,
        environment
      );
    }
  } catch (error) {
    try { environment?.revokeCredential(); }
    catch (cleanupError) {
      const details = error?.details && typeof error.details === "object" && !Array.isArray(error.details) ? { ...error.details } : {};
      details.privacyWarning = [details.privacyWarning, `credential: ${redactText(cleanupError?.message || String(cleanupError), environment?.knownSecrets || []).slice(0, 500)}`].filter(Boolean).join("; ");
      if (error && typeof error === "object") error.details = details;
    }
    throw error;
  }
  let provider;
  try {
    provider = await openProvider({
      root,
      profile: effectiveProfile,
      model,
      effort,
      stateDir,
      jobMarker,
      environment,
      cancelRequested,
      onEvent,
      guardBinding,
      providerLaunch: boundProviderLaunch,
      providerExecutableBinding:
        resolvedExecutablePin?.binding || providerExecutableBinding,
      providerExecutableEnv,
      testHooks,
      signalProcess
    });
  } catch (error) {
    const failedIdentity = providerCleanupIdentity(error);
    if (failedIdentity) {
      try { onEvent({ type: "provider", process: failedIdentity, version: null }); }
      catch (eventError) {
        const details = error?.details && typeof error.details === "object" && !Array.isArray(error.details) ? { ...error.details } : {};
        details.cleanupWarning = [details.cleanupWarning, `provider identity persistence: ${redactText(eventError?.message || String(eventError)).slice(0, 500)}`].filter(Boolean).join("; ");
        if (error && typeof error === "object") error.details = details;
      }
    }
    // A startup failure with only a PID/PGID witness is deliberately
    // observation-only. The detached group may still be reading its staged
    // credential/profile, so retain both until recovery observes it gone.
    if (!failedIdentity || processGroupGone(failedIdentity)) {
      try { environment?.revokeCredential(); }
      catch (cleanupError) {
        const details = error?.details && typeof error.details === "object" && !Array.isArray(error.details) ? { ...error.details } : {};
        details.privacyWarning = [details.privacyWarning, `credential: ${redactText(cleanupError?.message || String(cleanupError), environment?.knownSecrets || []).slice(0, 500)}`].filter(Boolean).join("; ");
        if (error && typeof error === "object") error.details = details;
      }
    }
    throw error;
  }
  let sessionId = null;
  let poll;
  let killTimer;
  let cancelled = false;
  let outputError = null;
  let outputBytes = 0;
  let primaryTurnAdmission = null;
  let mailboxAttempt = null;
  let mailboxClosed = false;
  let terminationSignalError = null;
  let rejectTerminationSignalFailure;
  const terminationSignalFailure = new Promise((_, reject) => {
    rejectTerminationSignalFailure = reject;
  });
  const signalProvider = (signal) => {
    try {
      assertCompleteDetachedOwnedIdentity(provider.process);
      return signalOwnedProcess(
        provider.process.processGroupId
          ? -provider.process.processGroupId
          : provider.child.pid,
        signal,
        signalProcess
      );
    } catch (error) {
      if (!terminationSignalError) {
        terminationSignalError = error;
        rejectTerminationSignalFailure(error);
      }
      return false;
    }
  };
  const scheduleProviderTermination = () => {
    if (killTimer || terminationSignalError) return;
    killTimer = setTimeout(() => {
      killTimer = null;
      signalProvider("SIGTERM");
    }, 5000);
  };
  const awaitProviderOperation = (operation) => (
    Promise.race([
      operation,
      terminationSignalFailure,
      provider.eventFailure.then((error) => {
        throw error;
      })
    ])
  );
  try {
    if ((provider.initialized.authMethods || []).some((method) => method?.id === "cached_token")) {
      await awaitProviderOperation(
        requestDuringProviderStartup(
          provider.client,
          "authenticate",
          { methodId: "cached_token", _meta: { headless: true } },
          30000,
          cancelRequested
        )
      );
    }
    const session = resumeSessionId
      ? await awaitProviderOperation(
          requestDuringProviderStartup(
            provider.client,
            "session/load",
            { sessionId: resumeSessionId, cwd: root, mcpServers: [] },
            45000,
            cancelRequested
          )
        )
      : await awaitProviderOperation(
          requestDuringProviderStartup(
            provider.client,
            "session/new",
            { cwd: root, mcpServers: [] },
            45000,
            cancelRequested
          )
        );
    sessionId = session?.sessionId || resumeSessionId;
    if (!sessionId) throw new CompanionError("E_PROTOCOL", "Grok did not return a session ID.");
    if (resumeSessionId && sessionId !== resumeSessionId) throw new CompanionError("E_PROTOCOL", `Grok loaded session ${sessionId} while ${resumeSessionId} was required.`);
    provider.emitEvent({ type: "session", sessionId, models: session?.models });
    if (provider.eventError()) throw provider.eventError();
    // Session creation is authenticated before any model tool can run. Remove the
    // reusable bearer credential before session/prompt exposes workspace tools.
    environment?.revokeCredential();
    if (mailboxController) {
      if (typeof mailboxController.open !== "function") {
        throw new CompanionError(
          "E_CAPABILITY",
          "Attempt-bound mailbox pumping is available only on the primary provider generation."
        );
      }
      mailboxAttempt = await awaitProviderOperation(
        mailboxController.open({
          sessionId,
          providerProcess: provider.process,
          providerCapabilities: provider.initialized
        })
      );
      if (provider.eventError()) throw provider.eventError();
    }
    if (primaryTurnController) {
      if (typeof primaryTurnController.admit !== "function"
        || typeof primaryTurnController.consume !== "function") {
        throw new CompanionError(
          "E_CAPABILITY",
          "Primary provider turns require an exact durable admission controller."
        );
      }
      primaryTurnAdmission = primaryTurnController.admit({
        sessionId,
        providerProcess: provider.process,
        prompt
      });
      if (!primaryTurnAdmission
        || typeof primaryTurnAdmission !== "object"
        || typeof primaryTurnAdmission.then === "function") {
        throw new CompanionError(
          "E_STATE",
          "Primary provider turn admission must be committed synchronously."
        );
      }
      await testHooks?.afterPrimaryTurnAdmitted?.({
        admission: primaryTurnAdmission,
        sessionId,
        providerProcess: provider.process
      });
    }
    // Separate interim chatter (messages before/between tool/plan activity) from the final answer.
    let currentTurn = null;
    const beginTurn = () => {
      const turn = {
        allMessageText: "",
        finalText: "",
        interimText: ""
      };
      currentTurn = turn;
      return {
        text: () => {
          const marker = turn.allMessageText.lastIndexOf("GROK_WORKER_REPORT:");
          return (marker >= 0
            ? turn.allMessageText.slice(marker)
            : turn.finalText).trim();
        },
        interimText: () => {
          const marker = turn.allMessageText.lastIndexOf("GROK_WORKER_REPORT:");
          return (marker >= 0
            ? turn.allMessageText.slice(0, marker)
            : turn.interimText).trim();
        }
      };
    };
    const listener = (event) => {
      if (event.type === "message") {
        const chunk = event.text || "";
        outputBytes += Buffer.byteLength(chunk, "utf8");
        if (outputBytes > 512 * 1024) {
          if (!outputError) {
            outputError = new CompanionError("E_OUTPUT_LIMIT", "Grok provider message output exceeded the 512 KiB job limit.", { limitBytes: 512 * 1024 });
            provider.client.notify("session/cancel", { sessionId });
            scheduleProviderTermination();
          }
          return;
        }
        if (currentTurn) {
          currentTurn.allMessageText += chunk;
          currentTurn.finalText += chunk;
        }
        return;
      }
      if (event.type === "tool" || event.type === "plan") {
        if (currentTurn?.finalText) {
          currentTurn.interimText += currentTurn.finalText;
          currentTurn.finalText = "";
        }
      }
    };
    provider.client.on("update", listener);
    poll = setInterval(() => {
      if (!cancelled && cancelRequested()) {
        cancelled = true;
        provider.client.notify("session/cancel", { sessionId });
        scheduleProviderTermination();
      }
    }, 100);
    let result;
    let structuredOutput;
    let structuredOutputError;
    const primaryCollector = beginTurn();
    try {
      if (primaryTurnController) {
        const consumed = primaryTurnController.consume({
          admission: primaryTurnAdmission,
          sessionId,
          providerProcess: provider.process,
          prompt
        });
        if (!consumed
          || typeof consumed !== "object"
          || typeof consumed.then === "function") {
          throw new CompanionError(
            "E_STATE",
            "Primary provider turn admission must be consumed synchronously."
          );
        }
      }
      const promptResponse = await awaitProviderOperation(
        provider.client.promptTurn({
          sessionId,
          prompt: [{ type: "text", text: prompt }],
          outputSchema,
          timeoutMs: timeoutMs ?? 30 * 60 * 1000
        })
      );
      result = promptResponse.result;
      if (Object.hasOwn(promptResponse, "structuredOutput")) {
        structuredOutput = promptResponse.structuredOutput;
      }
      if (Object.hasOwn(promptResponse, "structuredOutputError")) {
        structuredOutputError = promptResponse.structuredOutputError;
      }
    }
    catch (error) {
      if (provider.eventError()) throw provider.eventError();
      if (error === terminationSignalError) throw error;
      if (outputError) throw outputError;
      if (cancelled) throw new CompanionError("E_CANCELLED", "Grok job was cancelled.");
      throw error;
    }
    if (provider.eventError()) throw provider.eventError();
    if (outputError) throw outputError;
    if (cancelled
      || cancelRequested()
      || isCancelledPromptStopReason(result?.stopReason)) {
      throw new CompanionError("E_CANCELLED", "Grok job was cancelled.");
    }
    if (!isSuccessfulPromptStopReason(result?.stopReason)) {
      throw new CompanionError(
        "E_PROTOCOL",
        "Grok prompt did not end at a successful ACP turn boundary."
      );
    }
    const secrets = environment?.knownSecrets || [];
    let resolvedFinal = primaryCollector.text();
    let resolvedInterim = primaryCollector.interimText();
    let selectedSequence = 0;
    let mailboxEvidence = null;
    if (mailboxController) {
      await awaitProviderOperation(mailboxController.recordPrimary({
        attempt: mailboxAttempt,
        prompt,
        stopReason: result?.stopReason || "end_turn"
      }));
      if (provider.eventError()) throw provider.eventError();
      const drained = await awaitProviderOperation(mailboxController.drain({
        attempt: mailboxAttempt,
        client: provider.client,
        sessionId,
        collectTurnText: beginTurn,
        timeoutMs: timeoutMs ?? 30 * 60 * 1000,
        cancelRequested
      }));
      if (provider.eventError()) throw provider.eventError();
      if (cancelled || cancelRequested()) {
        throw new CompanionError(
          "E_CANCELLED",
          "Grok job was cancelled after mailbox drain."
        );
      }
      mailboxClosed = drained?.closed === true;
      const deliveredTurns = Array.isArray(drained?.turns)
        ? drained.turns.filter((turn) => turn?.outcome === "delivered")
        : [];
      if (drained?.deliveryUnknown === true) {
        // Never reuse an earlier report when the last attempted turn is
        // ambiguous. The controller will fail the provider-success claim.
        resolvedFinal = "";
        resolvedInterim = "";
        selectedSequence = drained?.attempt?.lastCompletedSequence ?? selectedSequence;
        structuredOutput = undefined;
        structuredOutputError = undefined;
      } else if (deliveredTurns.length) {
        const selected = deliveredTurns.at(-1);
        selectedSequence = selected.sequence;
        resolvedFinal = String(selected.text || "").trim();
        resolvedInterim = "";
        structuredOutput = Object.hasOwn(selected, "structuredOutput")
          ? selected.structuredOutput
          : undefined;
        structuredOutputError = Object.hasOwn(selected, "structuredOutputError")
          ? selected.structuredOutputError
          : undefined;
      }
      mailboxEvidence = {
        schemaVersion: 1,
        attemptId: mailboxAttempt.dispatchAttemptId,
        communicationChainDigest: drained?.attempt?.communicationChainDigest || null,
        lastCompletedSequence: drained?.attempt?.lastCompletedSequence ?? null,
        selectedSequence,
        acceptedCount: drained?.attempt?.acceptedCount ?? 0,
        acceptedBytes: drained?.attempt?.acceptedBytes ?? 0,
        deliveryUnknown: drained?.deliveryUnknown === true,
        closed: mailboxClosed,
        bodiesRetained: Boolean(drained?.bodiesRetained)
      };
    }
    if (provider.eventError()) throw provider.eventError();
    clearInterval(poll); poll = null; provider.client.off("update", listener);
    return {
      sessionId,
      text: redactText(resolvedFinal, secrets),
      interimText: redactText(resolvedInterim, secrets),
      stopReason: result?.stopReason || "end_turn",
      provider: { version: provider.version, process: provider.process },
      capabilities: provider.initialized,
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      ...(structuredOutputError !== undefined ? { structuredOutputError } : {}),
      ...(mailboxEvidence ? { mailboxEvidence } : {})
    };
  } catch (error) {
    if (mailboxController && mailboxAttempt && !mailboxClosed) {
      try {
        await mailboxController.interrupt({
          attempt: mailboxAttempt,
          reason: error?.code === "E_CANCELLED"
            ? "provider-cancelled"
            : "provider-interrupted"
        });
      } catch (mailboxError) {
        const details = error?.details && typeof error.details === "object"
          && !Array.isArray(error.details)
          ? { ...error.details }
          : {};
        details.mailboxWarning = redactText(mailboxError?.message || String(mailboxError)).slice(0, 500);
        if (error && typeof error === "object") error.details = details;
      }
    }
    if (provider.eventError()) throw provider.eventError();
    if (/auth|login|unauthori[sz]ed|no auth method/i.test(`${error?.message || ""} ${error?.details?.data || ""}`)) throw new CompanionError("E_AUTH_REQUIRED", `Grok authentication is unavailable or expired. Run \`grok login\`, then ${hostCommand("setup")}.`);
    throw error;
  } finally {
    if (poll) clearInterval(poll);
    if (killTimer) clearTimeout(killTimer);
    const cleanupWarnings = [];
    const noteCleanupFailure = (label, error) => {
      cleanupWarnings.push(`${label}: ${redactText(error?.message || String(error), environment?.knownSecrets || []).slice(0, 500)}`);
    };
    try { environment?.revokeCredential(); }
    catch (error) { noteCleanupFailure("credential", error); }
    try { provider.client.close(); }
    catch (error) { noteCleanupFailure("ACP client", error); }

    try {
      await ensureChildExit(provider.child, provider.process, { signalProcess });
    } catch (error) {
      if (cleanupWarnings.length && error && typeof error === "object") {
        const details = error.details && typeof error.details === "object" && !Array.isArray(error.details)
          ? { ...error.details }
          : {};
        details.privacyWarning = [details.privacyWarning, ...cleanupWarnings].filter(Boolean).join("; ");
        error.details = details;
      }
      // The provider may still be using the guard/profile. Retain both until a
      // later status/cancel recovery proves the complete process group is gone.
      throw error;
    }

    let guardRemoved = false;
    try {
      unregisterProviderGuard(root, provider.marker, provider.guardRecord);
      guardRemoved = true;
    } catch (error) {
      noteCleanupFailure("provider guard", error);
    }
    // An exact guard mismatch means another provider generation may own the
    // marker. Its process can still be reading the staged profile, so preserve
    // that profile for host recovery rather than unlinking it under ambiguity.
    if (guardRemoved) {
      try { provider.cleanupAgentProfile?.(); }
      catch (error) { noteCleanupFailure("agent profile", error); }
    }
    if (cleanupWarnings.length) {
      throw new CompanionError("E_STATE", "Grok provider exited, but transient task runtime cleanup was incomplete.", {
        privacyWarning: cleanupWarnings.join("; ")
      });
    }
  }
}

/**
 * Run a structured review with optional App-specific trusted schema, validator,
 * and repair prompt. Defaults preserve the generic REVIEW_SCHEMA / validateReview
 * / DEFAULT_REVIEW_REPAIR_PROMPT contract for existing Worker Protocol consumers.
 *
 * @param {object} options
 * @param {object} [options.outputSchema] Explicit trusted JSON Schema (bounded, serializable).
 * @param {(value: unknown) => object} [options.validator] Post-parse validator (default validateReview).
 * @param {string} [options.repairPrompt] Same-session repair prompt (default generic).
 */
export async function runStructuredReview(options) {
  const {
    outputSchema = null,
    validator = null,
    repairPrompt = null,
    ...rest
  } = options && typeof options === "object" ? options : {};
  const trustedSchema = resolveTrustedOutputSchema(outputSchema);
  const validate = typeof validator === "function" ? validator : validateReview;
  const repairText = typeof repairPrompt === "string" && repairPrompt.trim()
    ? repairPrompt
    : DEFAULT_REVIEW_REPAIR_PROMPT;
  const execute = (values) => {
    const payload = { ...values, outputSchema: trustedSchema };
    return values.profile?.transport === "headless"
      ? runHeadless({ ...payload, structured: true })
      : runProvider(payload);
  };
  let run = await execute(rest), parsed = run.structuredOutput ?? extractJson(run.text);
  try { return { ...run, review: validate(parsed) }; }
  catch (firstError) {
    const repair = await execute({
      ...rest,
      resumeSessionId: run.sessionId,
      prompt: repairText
    });
    parsed = repair.structuredOutput ?? extractJson(repair.text);
    try {
      return { ...repair, review: validate(parsed) };
    } catch (repairError) {
      const details = {
        ...(repairError?.details && typeof repairError.details === "object" ? repairError.details : {}),
        firstError: firstError?.code || null,
        repairAttempted: true,
        attempts: 2,
        jobId: rest.jobMarker || null
      };
      throw new CompanionError(
        repairError?.code || "E_SCHEMA",
        repairError?.message || "Grok review repair still did not match the required schema.",
        details
      );
    }
  }
}

export function deleteSession(sessionId, binary = null, env = null) {
  if (!sessionId) return { ok: true, removed: false, warning: null };
  const run = spawnSync(
    binary || discoverGrok(),
    ["sessions", "delete", sessionId],
    {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      shell: false,
      env: env || childEnvironment()
    }
  );
  const stdout = String(run.stdout || "");
  const stderr = String(run.stderr || "");
  const acknowledged = (
    run.status === 0
    && !run.error
    && !run.signal
    && stderr === ""
    && (stdout === `Deleted session ${sessionId}\n`
      || stdout === `Deleted session ${sessionId}\r\n`)
  );
  return {
    ok: acknowledged,
    removed: acknowledged,
    warning: acknowledged ? null : redactText(stderr || stdout)
  };
}

function shellWord(value) {
  const text = String(value);
  return /^[a-zA-Z0-9_./:+-]+$/.test(text) ? text : `'${text.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Executable resume argv for an imported Grok session.
 * Model is required: legacy placeholder models on import otherwise resume empty.
 */
export function formatResumeCommand(sessionId, model, effort = null) {
  if (!sessionId) throw new CompanionError("E_IMPORT_RESULT", "Cannot format a resume command without a Grok session ID.");
  if (!model) throw new CompanionError("E_CAPABILITY", "Cannot format a resume command without an advertised Grok model.");
  const parts = ["grok", "--model", model];
  if (effort) parts.push("--reasoning-effort", effort);
  parts.push("--resume", sessionId);
  return parts.map(shellWord).join(" ");
}

/**
 * Parse `grok models` text from the non-isolated CLI home used by import/resume.
 * Optional trailing `efforts=a,b` is recognized when a provider prints it (tests);
 * production Grok text may omit efforts, in which case advertised effort checks are skipped.
 */
export function parseAdvertisedModels(text) {
  const models = [];
  let defaultId = null;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const defaultMatch = line.match(/^Default model:\s+(\S+)\s*$/i);
    if (defaultMatch) {
      defaultId = defaultMatch[1];
      continue;
    }
    const modelMatch = line.match(/^[*-]\s+(\S+)(?:\s+\(default\))?(?:\s+efforts=([A-Za-z0-9_,-]+))?\s*$/i);
    if (!modelMatch) continue;
    const id = modelMatch[1];
    const efforts = modelMatch[2]
      ? modelMatch[2].split(",").map((item) => item.trim()).filter(Boolean)
      : [];
    if (!models.some((item) => item.id === id)) models.push({ id, efforts });
    if (/\(default\)/i.test(line)) defaultId = id;
  }
  if (defaultId) {
    const index = models.findIndex((item) => item.id === defaultId);
    if (index > 0) {
      const [preferred] = models.splice(index, 1);
      models.unshift(preferred);
    } else if (index < 0) {
      models.unshift({ id: defaultId, efforts: [] });
    }
  }
  return models;
}

/**
 * List models advertised by the same non-isolated Grok home used for import and resume.
 * Does not open an isolated setup-probe ACP home.
 */
export function listAdvertisedModels(binary = null, env = null) {
  assertProviderPlatform();
  const resolved = binary || discoverGrok();
  const run = spawnSync(resolved, ["models"], {
    encoding: "utf8",
    shell: false,
    timeout: 30000,
    env: env || childEnvironment()
  });
  if (run.status !== 0) {
    throw new CompanionError(
      "E_AUTH_REQUIRED",
      `Grok authentication is unavailable or expired. Run \`grok login\`, then retry ${hostCommand("setup")}.`,
      { diagnostic: redactText(run.stderr || run.stdout).slice(-2000) }
    );
  }
  const models = parseAdvertisedModels(`${run.stdout || ""}\n${run.stderr || ""}`);
  if (!models.length) {
    throw new CompanionError("E_CAPABILITY", "Grok did not advertise a model that can resume the imported session.");
  }
  return models;
}

export function selectTransferModel(models, requestedModel = null) {
  const list = Array.isArray(models) ? models : [];
  if (!list.length) {
    throw new CompanionError("E_CAPABILITY", "Grok did not advertise a model that can resume the imported session.");
  }
  if (requestedModel) {
    const selected = list.find((item) => item.id === requestedModel);
    if (!selected) {
      throw new CompanionError("E_CAPABILITY", `Model ${requestedModel} is not advertised by Grok.`, {
        available: list.map((item) => item.id)
      });
    }
    return selected;
  }
  return list[0];
}

export function assertTransferEffort(selected, effort = null) {
  if (!effort) return;
  const efforts = Array.isArray(selected?.efforts) ? selected.efforts : [];
  if (efforts.length && !efforts.includes(effort)) {
    throw new CompanionError("E_CAPABILITY", `Reasoning effort ${effort} is not advertised for model ${selected.id}.`, {
      available: efforts
    });
  }
}

/**
 * Observe whether one exact session ID appears in a successful non-isolated
 * Grok session list. `ok:false` preserves list failure separately from a
 * successful absence proof. Only provider metadata is requested or retained.
 */
export function inspectImportedSessionPresence(sessionId, binary = null, env = null, cwd = null) {
  const canonicalSessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const canonicalDate = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
    const parsed = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed)
      && new Date(parsed).toISOString().slice(0, 10) === value;
  };
  if (typeof sessionId !== "string"
    || !canonicalSessionId.test(sessionId)) {
    return Object.freeze({ ok: false, present: false });
  }
  const resolved = binary || discoverGrok();
  const run = spawnSync(resolved, ["sessions", "list", "-n", "200"], {
    cwd: cwd || process.cwd(),
    encoding: "utf8",
    shell: false,
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    env: env || childEnvironment()
  });
  if (run.status !== 0 || run.error || String(run.stderr || "").trim() !== "") {
    return Object.freeze({ ok: false, present: false });
  }
  const lines = String(run.stdout || "").split(/\r?\n/);
  const nonemptyLines = lines.map((line) => line.trim()).filter(Boolean);
  if (
    nonemptyLines.length === 1
    && nonemptyLines[0] === "No sessions found."
  ) {
    return Object.freeze({ ok: true, present: false });
  }
  const observed = new Set();
  let present = false;
  let headers = 0;
  let inTable = false;
  let expectingHeader = false;
  let tableHasSummary = false;
  let currentGroupLabel = null;
  let currentTableRows = 0;
  const observedGroupLabels = new Set();
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") continue;
    const columns = line.split(/\s+/);
    const header = (
      (columns.length === 5 || columns.length === 6)
      && columns[0] === "SESSION"
      && columns[1] === "ID"
      && columns[2] === "CREATED"
      && columns[3] === "UPDATED"
      && columns[4] === "STATUS"
      && (columns.length === 5 || columns[5] === "SUMMARY")
    );
    if (header) {
      if (inTable && !expectingHeader) {
        return Object.freeze({ ok: false, present: false });
      }
      headers += 1;
      inTable = true;
      expectingHeader = false;
      tableHasSummary = columns.length === 6;
      currentTableRows = 0;
      continue;
    }
    if (
      /^\([^()\r\n]{1,256}\)$/.test(line)
      || /^Label: [^\r\n]{1,256}$/.test(line)
    ) {
      if (
        expectingHeader
        || (inTable && currentGroupLabel === null)
        || (currentGroupLabel !== null && currentTableRows === 0)
        || observedGroupLabels.has(line)
      ) {
        return Object.freeze({ ok: false, present: false });
      }
      observedGroupLabels.add(line);
      currentGroupLabel = line;
      inTable = false;
      expectingHeader = true;
      continue;
    }
    if (!inTable || expectingHeader) {
      return Object.freeze({ ok: false, present: false });
    }
    const id = columns[0];
    const normalizedId = typeof id === "string" ? id.toLowerCase() : "";
    const minimumColumns = tableHasSummary ? 5 : 4;
    if ((tableHasSummary ? columns.length < minimumColumns : columns.length !== minimumColumns)
      || !canonicalSessionId.test(id || "")
      || !canonicalDate(columns[1])
      || !canonicalDate(columns[2])
      || !/^[A-Za-z][A-Za-z0-9._:+-]{0,63}$/.test(columns[3] || "")
      || observed.has(normalizedId)) {
      return Object.freeze({ ok: false, present: false });
    }
    observed.add(normalizedId);
    currentTableRows += 1;
    if (normalizedId === sessionId.toLowerCase()) present = true;
  }
  if (
    headers === 0
    || expectingHeader
    || currentTableRows === 0
  ) {
    return Object.freeze({ ok: false, present: false });
  }
  if (!present && observed.size >= 200) {
    return Object.freeze({ ok: false, present: false });
  }
  return Object.freeze({ ok: true, present });
}

/**
 * Backward-compatible readiness predicate. Qualification code must use
 * inspectImportedSessionPresence so list failure is not mistaken for absence.
 */
export function isImportedSessionReady(sessionId, binary = null, env = null, cwd = null) {
  const observation = inspectImportedSessionPresence(sessionId, binary, env, cwd);
  return observation.ok && observation.present;
}

/**
 * Fail closed until the exact imported session is observable for resume.
 * Bounded polling accounts for Grok import persistence races.
 */
export async function waitForImportedSession(sessionId, {
  binary = null,
  env = null,
  cwd = null,
  signal = null,
  timeoutMs = null,
  intervalMs = null
} = {}) {
  assertProviderPlatform();
  if (!sessionId) throw new CompanionError("E_IMPORT_RESULT", "Grok import returned no usable session ID.");
  const testTimeout = Number(process.env.GROK_COMPANION_TEST_IMPORT_READY_TIMEOUT_MS);
  const testInterval = Number(process.env.GROK_COMPANION_TEST_IMPORT_READY_INTERVAL_MS);
  const limitMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : (Number.isFinite(testTimeout) && testTimeout > 0 ? testTimeout : 10_000);
  const stepMs = Number.isFinite(intervalMs) && intervalMs > 0
    ? intervalMs
    : (Number.isFinite(testInterval) && testInterval > 0 ? testInterval : 100);
  const resolved = binary || discoverGrok();
  const deadline = Date.now() + limitMs;
  while (true) {
    if (signal?.aborted) throw new CompanionError("E_CANCELLED", "Grok transcript import was cancelled while waiting for session readiness.");
    if (isImportedSessionReady(sessionId, resolved, env, cwd)) return true;
    if (Date.now() >= deadline) {
      throw new CompanionError(
        "E_IMPORT_RESULT",
        `Grok import reported session ${sessionId}, but the session is not yet observable for resume.`,
        { sessionId }
      );
    }
    const remaining = deadline - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(stepMs, Math.max(0, remaining))));
  }
}

export async function probe(root, stateDir, {
  providerExecutableBinding = null,
  providerExecutableEnv = process.env
} = {}) {
  assertProviderPlatform();
  const pinned = providerExecutableBinding == null
    ? null
    : resolveProviderExecutablePin(
        assertExecutableProviderLaunchBinding(providerExecutableBinding),
        { env: providerExecutableEnv }
      );
  const binary = pinned?.binary || discoverGrok();
  grokVersion(binary);
  const help = spawnSync(binary, ["--help"], { encoding: "utf8", shell: false, timeout: 15000, env: childEnvironment() });
  const helpText = `${help.stdout || ""}\n${help.stderr || ""}`;
  const requiredFlags = ["--prompt-file", "--json-schema", "--tools", "--disallowed-tools", "--sandbox"];
  const missingFlags = requiredFlags.filter((flag) => !helpText.includes(flag));
  if (help.status !== 0 || missingFlags.length) throw new CompanionError("E_CAPABILITY", "Grok does not advertise the required headless review flags.", { missing: missingFlags });
  const agentHelp = spawnSync(binary, ["agent", "--help"], { encoding: "utf8", shell: false, timeout: 15000, env: childEnvironment() });
  const agentHelpText = `${agentHelp.stdout || ""}\n${agentHelp.stderr || ""}`;
  const requiredAgentFlags = ["--agent-profile", "--no-leader", "--leader-socket"];
  const missingAgentFlags = requiredAgentFlags.filter((flag) => !agentHelpText.includes(flag));
  if (agentHelp.status !== 0 || missingAgentFlags.length) throw new CompanionError("E_CAPABILITY", "Grok does not advertise the required isolated ACP agent flags.", { missing: missingAgentFlags });
  const auth = spawnSync(binary, ["models"], { encoding: "utf8", shell: false, timeout: 30000, env: childEnvironment() });
  if (auth.status !== 0) throw new CompanionError("E_AUTH_REQUIRED", `Grok authentication is unavailable or expired. Run \`grok login\`, then retry ${hostCommand("setup")}.`, { diagnostic: redactText(auth.stderr || auth.stdout).slice(-2000) });
  const marker = `setup-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const isolation = reviewEnvironment(
    stateDir,
    marker,
    { providerExecutableBinary: binary }
  );
  let provider = null;
  let failedProviderProcess = null;
  let primaryError = null;
  try {
    inspectIsolation(binary, root, isolation);
    const agentProfilePath = path.join(PLUGIN_ROOT, "provider-agents", "setup-probe.md");
    const agentProfile = fs.readFileSync(agentProfilePath, "utf8");
    if (!/^injectDefaultTools:\s*false\s*$/m.test(agentProfile)) throw new CompanionError("E_SECURITY_PROFILE", "The checked-in setup probe agent profile must set injectDefaultTools: false.");
    if (!/^permission_mode:\s*dontAsk\s*$/m.test(agentProfile)) throw new CompanionError("E_SECURITY_PROFILE", "The checked-in setup probe agent profile must use permission_mode dontAsk without unattended privilege expansion.");
    const agentProfileDigest = crypto.createHash("sha256").update(agentProfile).digest("hex");
    const profile = {
      id: "setup-probe-v2",
      contractVersion: 2,
      transport: "acp",
      sandbox: "read-only",
      permissionMode: "dontAsk",
      webSearch: false,
      subagents: false,
      isolatedLeader: true,
      agentProfileDigest,
      allowedTools: ["todo_write"],
      deniedTools: ["WebSearch", "WebFetch", "Agent", "mcp__*", "Bash", "Edit", "Write"]
    };
    provider = await openProvider({
      root,
      profile,
      stateDir,
      jobMarker: marker,
      environment: isolation,
      providerExecutableBinding,
      providerExecutableEnv
    });
    return {
      binary: provider.binary,
      version: provider.version,
      authenticated: true,
      headlessReview: { flags: requiredFlags, isolated: true, externalHooks: 0, externalSkills: 0, externalPlugins: 0, externalMcpServers: 0 },
      acpIsolation: {
        flags: requiredAgentFlags,
        isolated: true,
        sandbox: profile.sandbox,
        permissionMode: profile.permissionMode,
        injectDefaultTools: false,
        allowedTools: [...profile.allowedTools],
        agentProfileDigest,
        unattendedPrivilegeExpansion: false
      },
      protocolVersion: provider.initialized.protocolVersion,
      loadSession: Boolean(provider.initialized.agentCapabilities?.loadSession),
      authMethods: (provider.initialized.authMethods || []).map((x) => ({ id: x.id, name: x.name })),
      models: (provider.initialized?._meta?.modelState?.availableModels || []).map((x) => ({ id: x.modelId, efforts: (x._meta?.reasoningEfforts || []).map((e) => e.id) }))
    };
  } catch (error) {
    primaryError = error;
    failedProviderProcess = providerCleanupIdentity(error);
    throw error;
  } finally {
    let shutdownError = null;
    let retainProfileForGuard = false;
    if (provider) {
      provider.client.close();
      try {
        await ensureChildExit(provider.child, provider.process);
        try {
          unregisterProviderGuard(root, provider.marker, provider.guardRecord);
        } catch (error) {
          retainProfileForGuard = true;
          throw error;
        }
        provider.cleanupAgentProfile?.();
      } catch (error) {
        shutdownError = error;
      }
    }
    // Never delete the isolated credential home while the recorded process group remains live
    // or shutdown is unverifiable. Preserve the guard (unregister only after verified exit)
    // and keep the primary shutdown error when present.
    const cleanupIdentity = provider?.process || failedProviderProcess;
    const cleanup = retainProfileForGuard
      ? {
          ok: false,
          warning: "Isolated review home retained because exact provider guard cleanup failed."
        }
      : gatedCleanupReviewEnvironment(stateDir, marker, cleanupIdentity);
    if (!cleanup.ok) {
      const surfacedError = shutdownError || primaryError;
      if (surfacedError) {
        const details = surfacedError.details && typeof surfacedError.details === "object" && !Array.isArray(surfacedError.details)
          ? { ...surfacedError.details }
          : {};
        details.privacyWarning = [details.privacyWarning, cleanup.warning].filter(Boolean).join("; ");
        surfacedError.details = details;
        throw surfacedError;
      }
      if (cleanupIdentity && !processGroupGone(cleanupIdentity)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Could not verify complete process-group shutdown for the setup review-isolation probe.", {
          pid: cleanupIdentity.pid,
          processGroupId: cleanupIdentity.processGroupId ?? null,
          privacyWarning: cleanup.warning
        });
      }
      throw new CompanionError("E_STATE", "Could not remove the setup review-isolation probe.", { warning: cleanup.warning });
    }
    if (shutdownError) throw shutdownError;
  }
}
