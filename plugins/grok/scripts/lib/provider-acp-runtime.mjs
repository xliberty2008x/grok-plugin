import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { AcpClient } from "./acp-client.mjs";
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
import { redactText } from "./redact.mjs";
import { signalOwnedProcess } from "./process-control.mjs";
import {
  registerProviderGuard,
  unregisterProviderGuard
} from "./recursion-guard.mjs";
import { hostContext, pluginDataRoot } from "./host.mjs";
import {
  authenticateBoundBootstrapGuard,
  cleanupBoundBootstrapStart,
  createProviderBootstrapLaunch,
  promoteProviderBootstrap,
  publishProviderBootstrapSpec,
  recordBoundBootstrapNoChild,
  settleWorktreeBootstrapRegistrationFailure,
  waitForProviderBootstrapReady
} from "./provider-bootstrap-client.mjs";
import {
  assertProviderPlatform,
  childEnvironment,
  discoverGrok,
  grokVersion
} from "./provider-core.mjs";
import {
  captureSpawnIdentity,
  attachProviderCleanupIdentity,
  ensureChildExit,
  providerCleanupIdentity
} from "./provider-process.mjs";
import {
  inspectIsolation,
  materializeAgentProfile,
  spawnArgs
} from "./provider-profile.mjs";
import { selectAcpPermissionOption } from "./provider-review-contract.mjs";
import {
  EXACT_NONCE_ID,
  SHA256_HEX,
  WORKTREE_CONTROLLER_REQUEST_ALLOWLIST,
  WORKTREE_CONTROLLER_PROFILE_ID,
  WORKTREE_PROVISIONING_PURPOSE,
  isWorktreeProvisioningBinding
} from "./provider-worktree-contract.mjs";

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
export function requestDuringProviderStartup(client, method, params, timeoutMs, cancelRequested, { pollMs = 100 } = {}) {
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

/**
 * Repository-relative path check shared by review validators.
 * @param {unknown} file
 * @returns {boolean}
 */

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

function prepareProviderOpenContext({
  root,
  profile,
  model,
  effort,
  stateDir,
  jobMarker,
  environment,
  knownSecrets,
  cancelRequested,
  onEvent,
  guardBinding,
  providerLaunch,
  providerExecutableBinding,
  providerExecutableEnv,
  strictPermissionRequests,
  testHooks,
  signalProcess
}) {
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
  const version = boundBootstrap ? null : grokVersion(binary);
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
  return {
    root,
    model,
    effort,
    environment,
    knownSecrets,
    cancelRequested,
    onEvent,
    guardBinding,
    providerLaunch,
    strictPermissionRequests,
    testHooks,
    signalProcess,
    boundBootstrap,
    worktreeProvisioningBootstrap,
    setupOwnedExecutable,
    runtimeProfile,
    providerCwd,
    binary,
    capturedExecutableIdentity,
    version,
    safeMarker,
    leaderSocket,
    stagedProfile,
    preparedLaunch: null,
    resolvedGuardBinding: guardBinding,
    bootstrapSpecPublication: null,
    deferredBootstrapSpec: null,
    provisioningActivation: null,
    attestedExecutableIdentity: capturedExecutableIdentity?.attestation || null,
    child: null,
    processIdentity: null,
    guardRecord: null
  };
}

async function spawnProviderForOpen(context) {
  const {
    root,
    model,
    effort,
    environment,
    cancelRequested,
    guardBinding,
    providerLaunch,
    testHooks,
    boundBootstrap,
    worktreeProvisioningBootstrap,
    setupOwnedExecutable,
    runtimeProfile,
    providerCwd,
    binary,
    capturedExecutableIdentity,
    safeMarker,
    leaderSocket,
    stagedProfile
  } = context;
  let preparedLaunch = null;
  let resolvedGuardBinding = guardBinding;
  let bootstrapSpecPublication = null;
  let deferredBootstrapSpec = null;
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
  Object.assign(context, {
    preparedLaunch,
    resolvedGuardBinding,
    bootstrapSpecPublication,
    deferredBootstrapSpec,
    child
  });
}

async function captureProviderSpawnIdentity(context) {
  const {
    child,
    preparedLaunch,
    providerLaunch,
    worktreeProvisioningBootstrap,
    stagedProfile,
    boundBootstrap,
    capturedExecutableIdentity,
    root,
    safeMarker
  } = context;
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
  context.processIdentity = processIdentity;
  if (!boundBootstrap && capturedExecutableIdentity) {
    try {
      context.attestedExecutableIdentity = attestSpawnedExecutable(
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
}

async function registerWorktreeProviderBootstrap(context) {
  if (!context.worktreeProvisioningBootstrap) return;
  const {
    providerLaunch,
    preparedLaunch,
    resolvedGuardBinding,
    processIdentity,
    environment,
    child,
    deferredBootstrapSpec,
    root,
    safeMarker,
    stagedProfile
  } = context;
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
    context.provisioningActivation = activation;
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
    context.bootstrapSpecPublication = publishProviderBootstrapSpec(
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

async function authenticateProviderGuard(context) {
  const {
    boundBootstrap,
    bootstrapSpecPublication,
    child,
    cancelRequested,
    resolvedGuardBinding,
    capturedExecutableIdentity,
    setupOwnedExecutable,
    root,
    safeMarker,
    processIdentity,
    stagedProfile,
    providerLaunch,
    preparedLaunch,
    worktreeProvisioningBootstrap,
    provisioningActivation
  } = context;
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
      context.version = ready.version;
      if (capturedExecutableIdentity) {
        context.attestedExecutableIdentity = ready.executableIdentity
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
  context.guardRecord = guardRecord;
}

function createProviderEventRuntime(context) {
  const {
    strictPermissionRequests,
    worktreeProvisioningBootstrap,
    runtimeProfile,
    onEvent,
    processIdentity,
    child,
    signalProcess
  } = context;
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
  return {
    permissionPolicy,
    emitEvent,
    eventFailure,
    error: () => eventSignalError || eventError,
    eventError: () => eventError,
    signalError: () => eventSignalError
  };
}

async function publishAndPromoteProvider(context, eventRuntime) {
  const {
    testHooks,
    processIdentity,
    guardRecord,
    preparedLaunch,
    version,
    boundBootstrap,
    child,
    root,
    safeMarker,
    stagedProfile,
    resolvedGuardBinding,
    providerLaunch,
    worktreeProvisioningBootstrap,
    provisioningActivation
  } = context;
  try {
    await testHooks?.beforeDispatchPromotion?.({ processIdentity, guardRecord, preparedLaunch });
    eventRuntime.emitEvent({
      type: "provider",
      process: processIdentity,
      version,
      ...(preparedLaunch ? { spawnIntentId: preparedLaunch.intent.intentId } : {})
    });
    if (eventRuntime.eventError()) throw eventRuntime.eventError();
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
    throw eventRuntime.signalError() || eventRuntime.eventError() || error;
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
}

async function initializeProviderClient(context, eventRuntime) {
  const {
    worktreeProvisioningBootstrap,
    providerLaunch,
    preparedLaunch,
    processIdentity,
    provisioningActivation,
    child,
    knownSecrets,
    cancelRequested,
    environment,
    root,
    safeMarker,
    stagedProfile,
    guardRecord,
    binary,
    version,
    leaderSocket,
    providerCwd,
    runtimeProfile,
    attestedExecutableIdentity,
    model,
    effort
  } = context;
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
    permissionPolicy: eventRuntime.permissionPolicy,
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
  client.on("update", eventRuntime.emitEvent);
  client.on("stderr", (text) => eventRuntime.emitEvent({ type: "diagnostic", text: redactText(text, knownSecrets) }));
  let initialized;
  try {
    initialized = await requestDuringProviderStartup(
      client,
      "initialize",
      { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }, clientInfo: { name: "grok-companion", version: "0.3.0-dev.7" } },
      30000,
      cancelRequested
    );
    if (eventRuntime.error()) throw eventRuntime.error();
  } catch (error) {
    await cleanupFailedProviderStart({ child, identity: processIdentity, root, marker: safeMarker, stagedProfile, client, guardRecord });
    await settleWorktreeProvisioningStartupFailure();
    throw eventRuntime.error() || error;
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
  const provider = {
    binary,
    version,
    child,
    client,
    initialized,
    leaderSocket,
    process: processIdentity,
    marker: safeMarker,
    guardRecord,
    emitEvent: eventRuntime.emitEvent,
    eventError: eventRuntime.error,
    eventFailure: eventRuntime.eventFailure,
    cleanupAgentProfile: stagedProfile.cleanup,
    executableIdentity: attestedExecutableIdentity
  };
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
      emitEvent: eventRuntime.emitEvent,
      eventError: eventRuntime.error,
      eventFailure: eventRuntime.eventFailure,
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
  return provider;
}


export async function openProvider({ root, profile, model = null, effort = null, stateDir, jobMarker = "probe", environment = null, knownSecrets = environment?.knownSecrets || [], cancelRequested = () => false, onEvent = () => {}, guardBinding = null, providerLaunch = null, providerExecutableBinding = null, providerExecutableEnv = process.env, strictPermissionRequests = false, testHooks = null, signalProcess = process.kill }) {
  const context = prepareProviderOpenContext({
    root,
    profile,
    model,
    effort,
    stateDir,
    jobMarker,
    environment,
    knownSecrets,
    cancelRequested,
    onEvent,
    guardBinding,
    providerLaunch,
    providerExecutableBinding,
    providerExecutableEnv,
    strictPermissionRequests,
    testHooks,
    signalProcess
  });
  await spawnProviderForOpen(context);
  await captureProviderSpawnIdentity(context);
  await registerWorktreeProviderBootstrap(context);
  await authenticateProviderGuard(context);
  const eventRuntime = createProviderEventRuntime(context);
  await publishAndPromoteProvider(context, eventRuntime);
  return await initializeProviderClient(context, eventRuntime);
}
