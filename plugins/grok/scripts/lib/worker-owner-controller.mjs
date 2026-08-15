import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";

import { AcpClient } from "./acp-client.mjs";
import { CompanionError } from "./errors.mjs";
import {
  materializePinnedGrokExecutable,
  sameExecutableAttestation
} from "./executable-identity.mjs";
import {
  assertProviderLaunchBinding,
  providerLaunchBindingDigest as digestProviderLaunchBinding,
  resolveProviderExecutablePin
} from "./provider-executable-pin.mjs";
import { assertProviderPlatform, discoverGrok } from "./provider-core.mjs";
import {
  authenticateBoundBootstrapGuard,
  createProviderBootstrapLaunch,
  promoteProviderBootstrap,
  publishProviderBootstrapSpec,
  waitForProviderBootstrapReady
} from "./provider-bootstrap-client.mjs";
import {
  captureSpawnIdentity,
  ensureChildExit,
  providerCleanupIdentity
} from "./provider-process.mjs";
import {
  inspectIsolation,
  workerOwnerControllerSpawnArgs
} from "./provider-profile.mjs";
import {
  workerOwnerControllerEnvironment,
  workerSessionCloseControllerEnvironment
} from "./provider-controller-environments.mjs";
import { WORKTREE_INTEGRATION_REQUEST_ALLOWLIST } from "./provider-worktree-contract.mjs";
import { GrokWorktreeAcp } from "./grok-worktree-acp.mjs";
import { hostContext, pluginDataRoot } from "./host.mjs";
import { processGroupGone } from "./process-control.mjs";
import {
  assertWorkerOwnerControllerBinding,
  loadProviderGuard,
  unregisterProviderGuard,
  WORKTREE_CLEANUP_PURPOSE,
  WORKTREE_INTEGRATION_PURPOSE
} from "./recursion-guard.mjs";

export {
  WORKTREE_CLEANUP_PURPOSE,
  WORKTREE_INTEGRATION_PURPOSE
};

export const WORKTREE_CLOSE_REQUEST_ALLOWLIST = Object.freeze([
  "initialize",
  "authenticate",
  "session/load",
  "_x.ai/session/close"
]);

export const WORKTREE_REMOVE_REQUEST_ALLOWLIST = Object.freeze([
  "initialize",
  "_x.ai/git/worktree/remove"
]);

const EXACT_NONCE_ID = /^[0-9a-f]{32}$/;
const MAX_RECEIPTS_BYTES = 64 * 1024;
const BASE_COMMON_KEYS = new Set([
  "purpose",
  "controlWorkspaceId",
  "controlRoot",
  "executionRoot",
  "executionBindingDigest",
  "effectBindingDigest",
  "controllerAttemptId",
  "controllerFence",
  "holderId"
]);
const INTEGRATION_BASE_KEYS = new Set([
  ...BASE_COMMON_KEYS,
  "targetPath",
  "operationId"
]);
const CLEANUP_BASE_KEYS = new Set([
  ...BASE_COMMON_KEYS,
  "managedWorktreeParent",
  "sessionId",
  "providerHomeId"
]);

function isPlainRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value, keys) {
  return isPlainRecord(value)
    && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key));
}

function controllerError(message, details = undefined) {
  return new CompanionError("E_PROCESS_IDENTITY", message, details);
}

function resolveOwnerControllerExecutable({
  providerLaunchBinding,
  providerLaunchBindingDigest,
  providerExecutableEnv
}) {
  const hasBinding = providerLaunchBinding != null;
  const hasDigest = providerLaunchBindingDigest != null;
  if (!hasBinding && !hasDigest) return null;
  if (!hasBinding || !hasDigest) {
    throw controllerError(
      "Worker owner-controller provider executable binding is partial."
    );
  }
  let binding;
  try {
    binding = assertProviderLaunchBinding(providerLaunchBinding);
  } catch {
    throw controllerError(
      "Worker owner-controller provider executable binding is malformed."
    );
  }
  if (providerLaunchBindingDigest !== digestProviderLaunchBinding(binding)) {
    throw controllerError(
      "Worker owner-controller provider executable binding digest is inconsistent."
    );
  }
  let resolved;
  try {
    resolved = resolveProviderExecutablePin(binding, {
      env: providerExecutableEnv
    });
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    throw controllerError(
      "Worker owner-controller provider executable pin could not be resolved."
    );
  }
  if (resolved.binding.executableIdentityDigest
      !== resolved.executableIdentity.identityDigest
    || resolved.binding.executableIdentityDigest
      !== binding.executableIdentityDigest
    || digestProviderLaunchBinding(resolved.binding)
      !== providerLaunchBindingDigest) {
    throw controllerError(
      "Worker owner-controller provider executable pin changed during resolution."
    );
  }
  return resolved;
}

function validateBaseBinding(binding) {
  const keys = binding?.purpose === WORKTREE_INTEGRATION_PURPOSE
    ? INTEGRATION_BASE_KEYS
    : binding?.purpose === WORKTREE_CLEANUP_PURPOSE
      ? CLEANUP_BASE_KEYS
      : null;
  if (!keys || !exactKeys(binding, keys)) {
    throw controllerError(
      "Worker owner-controller base binding is not exact."
    );
  }
  const resolved = {
    ...binding,
    providerSpawnIntentId: "0".repeat(32)
  };
  assertWorkerOwnerControllerBinding(resolved);
  return Object.freeze({ ...binding });
}

function validateExecutableBoundIntent(
  candidate,
  {
    binding,
    executableIdentity,
    processIdentity,
    expectedStatus
  }
) {
  const intent = candidate?.intent;
  const processMatches = processIdentity === null
    ? intent?.processIdentity === null
    : Boolean(
        intent?.processIdentity?.pid === processIdentity.pid
        && intent.processIdentity.startToken === processIdentity.startToken
        && intent.processIdentity.processGroupId === processIdentity.processGroupId
      );
  if (!isPlainRecord(intent)
    || intent.schemaVersion !== 1
    || intent.purpose !== binding.purpose
    || !EXACT_NONCE_ID.test(intent.intentId || "")
    || intent.providerSpawnIntentId !== intent.intentId
    || intent.status !== expectedStatus
    || intent.controlWorkspaceId !== binding.controlWorkspaceId
    || intent.executionBindingDigest !== binding.executionBindingDigest
    || intent.effectBindingDigest !== binding.effectBindingDigest
    || intent.controllerAttemptId !== binding.controllerAttemptId
    || intent.controllerFence !== binding.controllerFence
    || intent.holderId !== binding.holderId
    || !sameExecutableAttestation(
      intent.executableIdentity,
      executableIdentity
    )
    || !processMatches) {
    throw controllerError(
      "Worker owner-controller durable intent is malformed or not exactly bound."
    );
  }
  return intent;
}

function validatePrepared(candidate, context) {
  if (candidate?.prepared !== true || candidate?.replayed !== false) {
    throw controllerError(
      "Worker owner-controller intent was not freshly prepared."
    );
  }
  return validateExecutableBoundIntent(candidate, {
    ...context,
    processIdentity: null,
    expectedStatus: "pending"
  });
}

function validateActivation(candidate, context) {
  if (candidate?.activated !== true
    || typeof candidate?.replayed !== "boolean") {
    throw controllerError(
      "Worker owner-controller process was not durably activated."
    );
  }
  return validateExecutableBoundIntent(candidate, {
    ...context,
    expectedStatus: "active"
  });
}

function validateSettlement(candidate, intentId) {
  const candidateIntentId = candidate?.intentId || candidate?.intent?.intentId;
  if (candidate?.settled !== true
    || typeof candidate?.replayed !== "boolean"
    || candidateIntentId !== intentId) {
    throw controllerError(
      "Worker owner-controller teardown was not durably settled."
    );
  }
  return Object.freeze({
    settled: true,
    replayed: candidate.replayed,
    intentId
  });
}

function boundedReceipts(receipts) {
  if (!Array.isArray(receipts)) {
    throw new CompanionError(
      "E_USAGE",
      "Worker owner-controller receipts must be an array."
    );
  }
  let serialized;
  try { serialized = JSON.stringify(receipts); }
  catch {
    throw new CompanionError(
      "E_USAGE",
      "Worker owner-controller receipts are not serializable."
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECEIPTS_BYTES) {
    throw new CompanionError(
      "E_USAGE",
      "Worker owner-controller receipts exceed their durable bound."
    );
  }
  return Object.freeze(JSON.parse(serialized));
}

function assertCallbacks(callbacks) {
  if (!callbacks
    || typeof callbacks.prepare !== "function"
    || typeof callbacks.activate !== "function"
    || typeof callbacks.settle !== "function") {
    throw new CompanionError(
      "E_STATE",
      "Worker owner-controller requires durable prepare, activate, and settle callbacks."
    );
  }
  return callbacks;
}

function requestAllowlist(purpose, effect) {
  if (purpose === WORKTREE_INTEGRATION_PURPOSE && effect === "apply") {
    return WORKTREE_INTEGRATION_REQUEST_ALLOWLIST;
  }
  if (purpose === WORKTREE_CLEANUP_PURPOSE && effect === "close") {
    return WORKTREE_CLOSE_REQUEST_ALLOWLIST;
  }
  if (purpose === WORKTREE_CLEANUP_PURPOSE && effect === "remove") {
    return WORKTREE_REMOVE_REQUEST_ALLOWLIST;
  }
  throw new CompanionError(
    "E_SECURITY_PROFILE",
    "Worker owner-controller purpose and effect do not match."
  );
}

export function normalizeWorkerOwnerSessionLoadResult(result, binding) {
  if (!isPlainRecord(result)
    || (Object.hasOwn(result, "sessionId")
      && result.sessionId !== binding.sessionId)) {
    throw new CompanionError(
      "E_PROTOCOL",
      "Cleanup controller loaded a different provider session."
    );
  }
  const request = buildWorkerOwnerSessionLoadRequest(binding);
  return Object.freeze({
    sessionId: request.sessionId,
    cwd: request.cwd,
    mcpServers: request.mcpServers,
    noReplay: request._meta.noReplay,
    skipEnvrc: request._meta["x.ai/skip_envrc"],
    restoreCode: request._meta["x.ai/restore_code"],
    codeNavEnabled: request._meta.codeNavEnabled,
    autoMode: request._meta.autoMode,
    yoloMode: request._meta.yoloMode
  });
}

export function buildWorkerOwnerSessionLoadRequest(binding) {
  return Object.freeze({
    sessionId: binding.sessionId,
    // Grok Build keys its local session store by the supplied cwd. Keep the
    // original execution root while disabling every upstream load-time
    // restore/replay mode that ACP exposes.
    cwd: binding.executionRoot,
    mcpServers: Object.freeze([]),
    _meta: Object.freeze({
      noReplay: true,
      "x.ai/skip_envrc": true,
      "x.ai/restore_code": false,
      codeNavEnabled: false,
      autoMode: false,
      yoloMode: false
    })
  });
}

function cleanupProof(identity, {
  providerGuardAbsent,
  credentialAbsent,
  controllerHomeAbsent
}) {
  const proof = {
    schemaVersion: 1,
    processIdentity: identity ? Object.freeze({ ...identity }) : null,
    processGroupGone: identity ? processGroupGone(identity) : true,
    providerGuardAbsent,
    credentialAbsent,
    controllerHomeAbsent,
    observedAt: new Date().toISOString()
  };
  if (!proof.processGroupGone
    || !proof.providerGuardAbsent
    || !proof.credentialAbsent
    || !proof.controllerHomeAbsent) {
    throw controllerError(
      "Worker owner-controller teardown proof is incomplete."
    );
  }
  return Object.freeze(proof);
}

/**
 * Open one short-lived, no-model official Grok controller. The bootstrap is
 * kept blocked on its private specification pipe until `activate` has durably
 * recorded the exact PID/start-token/process-group identity.
 */
export async function openWorkerOwnerController({
  stateDir,
  controlRoot,
  executionRoot,
  homeMarker,
  profile = null,
  binding,
  gitCommonDir,
  baseCommit,
  effect,
  callbacks,
  providerLaunchBinding = null,
  providerLaunchBindingDigest = null,
  providerExecutableEnv = process.env,
  cancelRequested = () => false,
  onEvent = () => {},
  testHooks = null
} = {}) {
  assertProviderPlatform();
  const baseBinding = validateBaseBinding(binding);
  const setupOwnedExecutable = resolveOwnerControllerExecutable({
    providerLaunchBinding,
    providerLaunchBindingDigest,
    providerExecutableEnv
  });
  const durable = assertCallbacks(callbacks);
  if (profile !== null && profile?.id !== "rescue-write-v3") {
    throw new CompanionError(
      "E_SECURITY_PROFILE",
      "Worker owner-controller may only derive from the qualified write task profile."
    );
  }
  const allowlist = requestAllowlist(baseBinding.purpose, effect);
  const environment = effect === "close"
    ? workerSessionCloseControllerEnvironment(
        stateDir,
        baseBinding.providerHomeId,
        { homeMarker }
      )
    : workerOwnerControllerEnvironment(
        stateDir,
        controlRoot,
        executionRoot,
        {
          purpose: baseBinding.purpose,
          homeMarker,
          gitCommonDir,
          baseCommit,
          targetPath: baseBinding.purpose === WORKTREE_INTEGRATION_PURPOSE
            ? baseBinding.targetPath
            : null,
          managedWorktreeParent:
            baseBinding.purpose === WORKTREE_CLEANUP_PURPOSE
              ? baseBinding.managedWorktreeParent
              : null
        }
      );
  const marker = homeMarker;
  let preparedIntent = null;
  let resolvedBinding = null;
  let executableIdentity = null;
  let child = null;
  let identity = null;
  let client = null;
  let initialized = null;
  let providerPid = null;
  let shutdownResult = null;
  let shuttingDown = false;

  const settleAfterTeardown = async ({
    outcome,
    receipts = [],
    primaryError = null
  }) => {
    if (shutdownResult) return shutdownResult;
    if (shuttingDown) {
      throw controllerError(
        "Worker owner-controller teardown is already in progress."
      );
    }
    shuttingDown = true;
    let cleanupFailure = null;
    try { client?.close(); }
    catch (error) { cleanupFailure = error; }
    if (child && identity) {
      try { await ensureChildExit(child, identity); }
      catch (error) { cleanupFailure ||= error; }
    }
    if (identity && resolvedBinding && !processGroupGone(identity)) {
      cleanupFailure ||= controllerError(
        "Worker owner-controller process group remained after shutdown."
      );
    }
    const providerWriterGone = !identity || processGroupGone(identity);
    const credentialWriterIdentity = identity && providerPid
      ? Object.freeze({ ...identity, providerPid })
      : identity;
    if (providerWriterGone && resolvedBinding) {
      try {
        const loaded = loadProviderGuard(controlRoot, marker);
        if (loaded) {
          const exact = authenticateBoundBootstrapGuard(
            controlRoot,
            marker,
            identity,
            resolvedBinding
          );
          unregisterProviderGuard(controlRoot, marker, exact);
        }
      } catch (error) {
        cleanupFailure ||= error;
      }
    }
    // A live Grok process remains an authorized atomic writer to auth.json.
    // Adopt and revoke the final credential inode only after its exact process
    // group is proven gone; otherwise retain both credential and controller
    // home for fail-closed recovery.
    if (providerWriterGone) {
      try { environment.revokeCredential(credentialWriterIdentity); }
      catch (error) { cleanupFailure ||= error; }
      try { environment.assertCredentialAbsent(credentialWriterIdentity); }
      catch (error) { cleanupFailure ||= error; }
    }
    if (!cleanupFailure && providerWriterGone) {
      try { environment.cleanup(credentialWriterIdentity); }
      catch (error) { cleanupFailure ||= error; }
    }
    if (cleanupFailure) {
      throw new CompanionError(
        "E_STATE",
        "Worker owner-controller teardown could not prove complete absence.",
        {
          causeCode: primaryError?.code || null,
          cleanupCode: cleanupFailure?.code || null
        }
      );
    }
    const guardAbsent = loadProviderGuard(controlRoot, marker) === null;
    environment.assertHomeAbsent();
    const proof = cleanupProof(identity, {
      providerGuardAbsent: guardAbsent,
      credentialAbsent: true,
      controllerHomeAbsent: true
    });
    const exactReceipts = boundedReceipts(receipts);
    let settlement = null;
    if (preparedIntent) {
      const candidate = await durable.settle(Object.freeze({
        purpose: baseBinding.purpose,
        effect,
        intentId: preparedIntent.intentId,
        providerSpawnIntentId: preparedIntent.intentId,
        binding: resolvedBinding || baseBinding,
        executableIdentity,
        processIdentity: identity ? Object.freeze({ ...identity }) : null,
        outcome,
        receipts: exactReceipts,
        cleanupProof: proof
      }));
      settlement = validateSettlement(candidate, preparedIntent.intentId);
    }
    shutdownResult = Object.freeze({
      cleanupProof: proof,
      settlement
    });
    return shutdownResult;
  };

  try {
    if (cancelRequested()) {
      throw new CompanionError(
        "E_CANCELLED",
        "Worker owner-controller was cancelled before preparation."
      );
    }
    const capturedExecutable = setupOwnedExecutable?.fileIdentity
      || materializePinnedGrokExecutable(
        discoverGrok(),
        { directory: path.join(environment.controllerCwd, "provider-bin") }
      );
    executableIdentity = capturedExecutable.attestation;
    if (effect === "close") environment.verifySessionHome();
    environment.verifyGitExecutable?.();
    inspectIsolation(
      capturedExecutable.canonicalPath,
      environment.controllerCwd,
      environment
    );
    if (effect === "close") environment.verifySessionHome();
    environment.verifyGitExecutable?.();
    environment.assertCredentialAbsent();
    const prepared = await durable.prepare(Object.freeze({
      purpose: baseBinding.purpose,
      effect,
      binding: baseBinding,
      executableIdentity
    }));
    preparedIntent = validatePrepared(prepared, {
      binding: baseBinding,
      executableIdentity
    });
    resolvedBinding = Object.freeze({
      ...baseBinding,
      providerSpawnIntentId: preparedIntent.intentId
    });
    assertWorkerOwnerControllerBinding(resolvedBinding);
    await testHooks?.afterPrepared?.({
      intent: preparedIntent,
      binding: resolvedBinding
    });
    if (cancelRequested()) {
      throw new CompanionError(
        "E_CANCELLED",
        "Worker owner-controller was cancelled before process creation."
      );
    }
    const leaderSocket = path.join(
      environment.controllerCwd,
      `leader-${crypto.randomBytes(8).toString("hex")}.sock`
    );
    const providerArgs = workerOwnerControllerSpawnArgs({
      environment,
      leaderSocket
    });
    const launch = createProviderBootstrapLaunch({
      root: environment.controllerCwd,
      marker,
      owner: hostContext().sessionId,
      binding: resolvedBinding,
      binary: capturedExecutable.canonicalPath,
      executableIdentity,
      args: providerArgs
    });
    child = spawn(process.execPath, launch.argv, {
      cwd: environment.controllerCwd,
      env: {
        ...environment.env,
        GROK_COMPANION_JOB_MARKER: marker,
        GROK_COMPANION_BOOTSTRAP_PLUGIN_DATA: pluginDataRoot(process.env)
      },
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"]
    });
    await testHooks?.afterBootstrapSpawned?.({ child, binding: resolvedBinding });
    identity = await captureSpawnIdentity(child);
    const activated = await durable.activate(Object.freeze({
      purpose: baseBinding.purpose,
      effect,
      intentId: preparedIntent.intentId,
      providerSpawnIntentId: preparedIntent.intentId,
      binding: resolvedBinding,
      executableIdentity,
      processIdentity: Object.freeze({ ...identity })
    }));
    validateActivation(activated, {
      binding: baseBinding,
      executableIdentity,
      processIdentity: identity
    });
    await testHooks?.afterActivatedBeforeSpecification?.({
      processIdentity: identity,
      binding: resolvedBinding
    });
    if (effect === "close") environment.verifySessionHome();
    environment.stageCredential();
    await publishProviderBootstrapSpec(child, launch.specPayload);
    const ready = await waitForProviderBootstrapReady(
      child,
      cancelRequested,
      resolvedBinding,
      executableIdentity
    );
    if (!sameExecutableAttestation(
      ready.executableIdentity,
      executableIdentity
    )) {
      throw controllerError(
        "Worker owner-controller executable attestation changed at readiness."
      );
    }
    providerPid = ready.grokPid;
    authenticateBoundBootstrapGuard(
      controlRoot,
      marker,
      identity,
      resolvedBinding
    );
    onEvent(Object.freeze({
      type: "owner-controller",
      purpose: baseBinding.purpose,
      effect,
      process: Object.freeze({ ...identity }),
      version: ready.version
    }));
    await promoteProviderBootstrap(child, {
      marker,
      ...resolvedBinding
    });
    client = new AcpClient(child, {
      timeoutMs: 45_000,
      knownSecrets: environment.knownSecrets,
      permissionPolicy: () => ({ outcome: { outcome: "cancelled" } }),
      outboundAllowlist: {
        requests: allowlist,
        notifications: []
      },
      cancelPermissions: true
    });
    initialized = await client.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false }
        },
        clientInfo: {
          name: "grok-companion-owner-controller",
          version: "0.3.0-dev.8"
        }
      },
      30_000
    );
    if (effect === "close") {
      if (!(initialized?.authMethods || []).some(
        (method) => method?.id === "cached_token"
      )) {
        throw new CompanionError(
          "E_CAPABILITY",
          "Cleanup controller requires Grok cached-token authentication before session load."
        );
      }
      await client.request(
        "authenticate",
        {
          methodId: "cached_token",
          _meta: { headless: true }
        },
        30_000
      );
      environment.verifySessionHome();
    }
    if (effect === "close") {
      // Grok Build may atomically enrich auth.json after authenticate returns.
      // Keep the credential only inside this no-model, method-allowlisted
      // load/close controller, then revoke it after its process group is gone
      // in settleAfterTeardown. Revoking here races that upstream writer and
      // can strand an unbound replacement credential.
      environment.verifySessionHome();
    } else {
      environment.revokeCredential();
      environment.assertCredentialAbsent();
    }
    if (initialized?.protocolVersion !== 1
      || (effect === "close"
        && initialized?.agentCapabilities?.loadSession !== true)) {
      throw new CompanionError(
        "E_CAPABILITY",
        "Official Grok ACP capabilities do not satisfy the owner-controller effect."
      );
    }
  } catch (error) {
    const failedIdentity = providerCleanupIdentity(error);
    if (!identity && failedIdentity) identity = failedIdentity;
    try {
      await settleAfterTeardown({
        outcome: error?.code === "E_CANCELLED"
          ? "cancelled"
          : "startup-failed",
        receipts: [],
        primaryError: error
      });
    } catch (cleanupError) {
      throw cleanupError;
    }
    throw error;
  }

  let effectStarted = false;
  let loaded = false;
  let closed = false;
  const assertEffect = (expected) => {
    if (effect !== expected) {
      throw new CompanionError(
        "E_SECURITY_PROFILE",
        `This controller is not authorized for ${expected}.`
      );
    }
    if (effectStarted && expected !== "close") {
      throw new CompanionError(
        "E_STATE",
        "Worker owner-controller effect was already dispatched."
      );
    }
  };
  const adapter = new GrokWorktreeAcp(client, { timeoutMs: 45_000 });
  const handle = {
    purpose: baseBinding.purpose,
    effect,
    process: Object.freeze({ ...identity }),
    executableIdentity,
    initialized: Object.freeze({
      protocolVersion: initialized.protocolVersion,
      loadSession: initialized?.agentCapabilities?.loadSession === true
    }),
    async apply() {
      assertEffect("apply");
      effectStarted = true;
      environment.verifyGitExecutable();
      const receipt = await adapter.apply({
        operationId: baseBinding.operationId,
        worktreePath: baseBinding.executionRoot,
        expectedGitRoot: baseBinding.controlRoot,
        expectedPaths: ["target.txt"]
      });
      return Object.freeze({
        status: receipt.status,
        files: receipt.files,
        gitRoot: receipt.gitRoot
      });
    },
    async loadSession() {
      assertEffect("close");
      if (loaded || closed) {
        throw new CompanionError(
          "E_STATE",
          "Cleanup controller session load is not replayable in one process."
        );
      }
      effectStarted = true;
      environment.verifySessionHome();
      const request = buildWorkerOwnerSessionLoadRequest(baseBinding);
      const result = await client.request("session/load", request, 45_000);
      const receipt = normalizeWorkerOwnerSessionLoadResult(
        result,
        baseBinding
      );
      environment.verifySessionHome();
      loaded = true;
      return Object.freeze({
        ...receipt,
        sessionHomeIdentityDigest: environment.sessionHomeIdentityDigest
      });
    },
    async closeSession() {
      assertEffect("close");
      if (!loaded || closed) {
        throw new CompanionError(
          "E_STATE",
          "Cleanup controller must load the exact session once before close."
        );
      }
      const receipt = await adapter.close({
        sessionId: baseBinding.sessionId
      });
      environment.verifySessionHome();
      closed = true;
      return Object.freeze({
        sessionId: baseBinding.sessionId,
        success: receipt.success,
        sessionHomeIdentityDigest: environment.sessionHomeIdentityDigest
      });
    },
    async removeWorktree() {
      assertEffect("remove");
      effectStarted = true;
      environment.verifyGitExecutable();
      const receipt = await adapter.remove({
        worktreePath: baseBinding.executionRoot,
        force: true,
        dryRun: false
      });
      return Object.freeze({
        removed: receipt.removed,
        resolvedPath: receipt.resolvedPath
      });
    },
    async shutdown({ outcome = "completed", receipts = [] } = {}) {
      if (!["completed", "effect-failed", "cancelled"].includes(outcome)) {
        throw new CompanionError(
          "E_USAGE",
          "Worker owner-controller shutdown outcome is invalid."
        );
      }
      return settleAfterTeardown({ outcome, receipts });
    }
  };
  return Object.freeze(handle);
}

async function runOneEffect(input, invoke) {
  const controller = await openWorkerOwnerController(input);
  const receipts = [];
  try {
    await invoke(controller, receipts);
    const teardown = await controller.shutdown({
      outcome: "completed",
      receipts
    });
    return Object.freeze({
      receipts: Object.freeze(receipts),
      ...teardown
    });
  } catch (error) {
    try {
      await controller.shutdown({
        outcome: error?.code === "E_CANCELLED"
          ? "cancelled"
          : "effect-failed",
        receipts
      });
    } catch (cleanupError) {
      throw cleanupError;
    }
    throw error;
  }
}

export function runIntegrationEffect(input) {
  return runOneEffect(
    { ...input, effect: "apply" },
    async (controller, receipts) => {
      receipts.push(await controller.apply());
    }
  );
}

export function runCloseEffect(input) {
  return runOneEffect(
    { ...input, effect: "close" },
    async (controller, receipts) => {
      let stage = "load";
      try {
        receipts.push(await controller.loadSession());
        stage = "close";
        receipts.push(await controller.closeSession());
      } catch (error) {
        const details = error?.details
          && typeof error.details === "object"
          && !Array.isArray(error.details)
          ? { ...error.details }
          : {};
        details.ownerControllerStage = stage;
        if (error && typeof error === "object") error.details = details;
        throw error;
      }
    }
  );
}

export function runRemoveEffect(input) {
  return runOneEffect(
    { ...input, effect: "remove" },
    async (controller, receipts) => {
      receipts.push(await controller.removeWorktree());
    }
  );
}
