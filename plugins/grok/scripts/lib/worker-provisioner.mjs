/**
 * Promotion-gated write-worktree provisioner.
 *
 * This is the production caller for the official Grok ACP worktree extension.
 * It deliberately performs no session/new, session/load, session/prompt, model
 * turn, worker dispatch, or parent integration. Its only successful outcome is
 * a broker-verified worktree promoted to `worktree-ready-no-dispatch`.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CompanionError } from "./errors.mjs";
import {
  ensureChildExit,
  openProvider,
  providerCleanupIdentity,
  taskEnvironment
} from "./grok-provider.mjs";
import { GrokWorktreeAcp } from "./grok-worktree-acp.mjs";
import { processGroupGone } from "./process-control.mjs";
import {
  loadProviderGuard,
  unregisterProviderGuard
} from "./recursion-guard.mjs";
import { readJob } from "./state.mjs";
import { captureContextManifest } from "./task-contract.mjs";
import {
  activateWriteProvisioningAttempt,
  assertMutationOwnership,
  assertWriteExecutionJob,
  prepareWriteProvisionerIntent,
  promoteWriteWorkerReady,
  recordOfficialWorktreeReceipt,
  recordWriteProvisionerNoChild,
  retainWriteProvisioningCleanupPending
} from "./worker-mutation.mjs";
import { assertManagedWorkerWorktree } from "./worker-worktree.mjs";
import { workspaceState } from "./workspace.mjs";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ERROR_CODE = /^E_[A-Z0-9_]{1,62}[A-Z0-9]$/;
const MAX_PROVISIONING_LEASE_MS = 300_000;
const DEFAULT_PROVISIONING_LEASE_MS = 240_000;
const DEFAULT_OFFICIAL_TIMEOUT_MS = 120_000;

function stateError(message, details = undefined) {
  throw new CompanionError("E_STATE", message, details);
}

function canonicalDuration(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new CompanionError(
      "E_USAGE",
      `${label} must be a positive bounded integer.`
    );
  }
  return value;
}

function sameProcess(left, right) {
  return Boolean(
    left
    && right
    && left.pid === right.pid
    && left.startToken === right.startToken
    && left.processGroupId === right.processGroupId
  );
}

function remainingProvisioningLeaseTimeout(
  leaseExpiresAt,
  requestedTimeoutMs,
  boundary
) {
  const expiresAt = Date.parse(leaseExpiresAt || "");
  const remainingMs = expiresAt - Date.now();
  if (!Number.isFinite(expiresAt) || remainingMs < 1) {
    throw new CompanionError(
      "E_STATE",
      `Provisioning lease expired before ${boundary}.`
    );
  }
  return Math.max(1, Math.min(requestedTimeoutMs, remainingMs));
}

function currentProvisioningDigest({
  root,
  workerId,
  executionBindingDigest,
  providerSpawnIntentId,
  processIdentity,
  plannedJournalDigest,
  env
}) {
  const verified = assertWriteExecutionJob(readJob(root, workerId, env), env);
  const intent = verified.provisioningRuntime?.intent || null;
  if (verified.binding.bindingDigest !== executionBindingDigest
    || intent?.providerSpawnIntentId !== providerSpawnIntentId) {
    stateError("Provisioner settlement no longer matches its durable intent.");
  }
  if (verified.journal.state === "planned"
    && intent.processIdentity === null
    && verified.journal.journalDigest === plannedJournalDigest) {
    return verified.journal.journalDigest;
  }
  if (verified.journal.state === "provisioning"
    && sameProcess(intent.processIdentity, processIdentity)) {
    return verified.journal.journalDigest;
  }
  if (verified.journal.state === "cleanup_pending"
    && intent.status === "registered"
    && sameProcess(intent.processIdentity, processIdentity)) {
    return verified.journal.previousJournalDigest;
  }
  if (verified.journal.state === "failed"
    && intent.status === "no-child") {
    return verified.journal.previousJournalDigest;
  }
  stateError(
    "Provisioner settlement cannot resolve one exact current journal revision."
  );
}

function boundedFailure(error) {
  const code = ERROR_CODE.test(error?.code || "")
    ? error.code
    : "E_PROVIDER_EXIT";
  return Object.freeze({
    code,
    message: "Official write-worktree provisioning did not complete safely."
  });
}

function assertSafeProvisioningHome(stateDir, home) {
  const expectedParent = path.resolve(stateDir, "task-homes");
  const resolved = path.resolve(home);
  if (path.dirname(resolved) !== expectedParent) {
    stateError("Provisioning home escaped the private task-home directory.");
  }
  try {
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      stateError("Provisioning home is not a private real directory.");
    }
  } catch (error) {
    if (error?.code === "ENOENT") return resolved;
    throw error;
  }
  return resolved;
}

function removeProvisioningHome(stateDir, environment) {
  const home = assertSafeProvisioningHome(stateDir, environment.home);
  fs.rmSync(home, { recursive: true, force: true });
  if (fs.existsSync(home)) {
    stateError("Provisioning home remained after verified provider cleanup.");
  }
}

function ensureProvisioningWorktreeParent(stateDir, expectedExecutionRoot) {
  const managedRoot = path.resolve(stateDir, "worktrees");
  const expectedParent = path.dirname(expectedExecutionRoot);
  if (path.dirname(expectedParent) !== managedRoot
    || path.basename(expectedExecutionRoot) !== "checkout") {
    stateError("Bound execution root escaped the managed worktree directory.");
  }
  try {
    fs.mkdirSync(managedRoot, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const canonicalManagedRoot = fs.realpathSync(managedRoot);
  const managedStat = fs.lstatSync(canonicalManagedRoot);
  if (canonicalManagedRoot !== managedRoot
    || !managedStat.isDirectory()
    || managedStat.isSymbolicLink()
    || (managedStat.mode & 0o077) !== 0) {
    stateError("Managed worktree root is aliased or not private.");
  }
  try {
    fs.mkdirSync(expectedParent, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const canonicalParent = fs.realpathSync(expectedParent);
  const stat = fs.lstatSync(canonicalParent);
  if (canonicalParent !== expectedParent
    || !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o077) !== 0
    || fs.readdirSync(canonicalParent).length !== 0) {
    stateError("Managed worker destination parent is aliased, shared, or nonempty.");
  }
  return canonicalParent;
}

function removeUnusedProvisioningParent(parent, expectedExecutionRoot) {
  if (path.dirname(expectedExecutionRoot) !== parent) {
    stateError("Provisioning destination cleanup lost its exact path binding.");
  }
  try {
    fs.lstatSync(expectedExecutionRoot);
    stateError("Provisioning destination child appeared during failed setup.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (fs.readdirSync(parent).length !== 0) {
    stateError("Provisioning destination parent became nonempty during failed setup.");
  }
  fs.rmdirSync(parent);
}

async function cleanupProvisioningProvider({
  provider,
  environment,
  stateDir,
  controlRoot,
  workerId,
  env
}) {
  let credentialWarning = null;
  try {
    environment.revokeCredential();
  } catch (error) {
    credentialWarning = error;
  }

  try {
    provider.client.close();
  } catch {
    // ensureChildExit below is the authoritative owned-process cleanup.
  }
  await ensureChildExit(provider.child, provider.process);

  const existingGuard = loadProviderGuard(controlRoot, workerId);
  if (existingGuard) {
    unregisterProviderGuard(
      controlRoot,
      workerId,
      provider.guardRecord,
      env
    );
  }
  if (loadProviderGuard(controlRoot, workerId) !== null) {
    stateError("Provisioning guard remained after exact process cleanup.");
  }

  provider.cleanupAgentProfile();
  removeProvisioningHome(stateDir, environment);
  if (credentialWarning && fs.existsSync(environment.home)) {
    throw credentialWarning;
  }
  if (!processGroupGone(provider.process)) {
    stateError("Provisioning process group remained after cleanup.");
  }
  return Object.freeze({
    processIdentity: Object.freeze({ ...provider.process }),
    processGroupGone: true,
    providerGuardAbsent: true,
    observedAt: new Date().toISOString()
  });
}

function exactOfficialReceipt(created) {
  return Object.freeze({
    status: created?.status,
    sessionId: created?.sessionId,
    worktreePath: created?.worktreePath,
    sourceGitRoot: typeof created?.sourceGitRoot === "string"
      ? path.resolve(created.sourceGitRoot)
      : created?.sourceGitRoot,
    commit: created?.commit
  });
}

function officialProvisioningControllerProfile(profile, environment) {
  if (profile?.id !== "rescue-write-v3") {
    stateError(
      "Official worktree provisioning requires the admitted write profile."
    );
  }
  if (environment?.controllerProfileId !== "worktree-controller-v1"
    || typeof environment?.sandboxProfile !== "string"
    || !environment.sandboxProfile
    || typeof environment?.controllerCwd !== "string"
    || !environment.controllerCwd) {
    stateError("Official worktree provisioning requires an isolated sandbox.");
  }
  return Object.freeze({
    ...profile,
    // The short-lived controller extends strict only with read access to the
    // canonical host Git installation. It never opens or loads a model
    // session; the adapter constrains the ACP effect to the broker-bound
    // source, destination, and commit.
    sandbox: environment.sandboxProfile,
    permissionMode: "dontAsk"
  });
}

function projectReadyReplay({
  verified,
  workerId,
  env
}) {
  if (verified.journal.state !== "ready") return null;
  const runtime = verified.provisioningRuntime;
  const intent = runtime?.intent;
  const receipt = runtime?.receipt;
  const cleanupProof = runtime?.cleanupProof;
  if (!intent
    || !receipt
    || !cleanupProof
    || intent.status !== "settled"
    || !processGroupGone(intent.processIdentity)
    || loadProviderGuard(verified.binding.controlRoot, workerId) !== null) {
    stateError(
      "Ready worktree replay lacks exact durable controller cleanup evidence."
    );
  }
  assertManagedWorkerWorktree({
    controlRoot: verified.binding.controlRoot,
    executionRoot: verified.binding.expectedExecutionRoot,
    baseCommit: verified.binding.baseCommit,
    workerId,
    env
  });
  return Object.freeze({
    workerId,
    operationId: intent.operationId,
    officialStatus: receipt.officialStatus,
    executionRoot: verified.binding.expectedExecutionRoot,
    bindingDigest: verified.binding.bindingDigest,
    receiptDigest: receipt.receiptDigest,
    cleanupProofDigest: cleanupProof.proofDigest,
    journalDigest: verified.journal.journalDigest,
    executableIdentity: receipt.executableIdentity,
    ready: true,
    replayed: true,
    providerLaunched: false,
    workerDispatched: false
  });
}

/**
 * Provision one freshly admitted write worker through the official ACP
 * worktree extension and promote it only to verified-worktree-ready.
 */
export async function provisionWriteWorkerWorktree({
  root,
  principal,
  workerId,
  env = process.env,
  leaseMs = DEFAULT_PROVISIONING_LEASE_MS,
  timeoutMs = DEFAULT_OFFICIAL_TIMEOUT_MS
} = {}) {
  canonicalDuration(leaseMs, "leaseMs", MAX_PROVISIONING_LEASE_MS);
  canonicalDuration(timeoutMs, "timeoutMs", 15 * 60_000);
  const durableJob = readJob(root, workerId, env);
  assertMutationOwnership(durableJob, principal);
  const initial = assertWriteExecutionJob(durableJob, env);
  const readyReplay = projectReadyReplay({
    verified: initial,
    workerId,
    env
  });
  if (readyReplay) return readyReplay;
  if (initial.journal.state !== "planned"
    || initial.provisioningRuntime !== null) {
    stateError(
      "This provisioner slice requires one fresh planned write-worker intent."
    );
  }

  const controlRoot = initial.binding.controlRoot;
  const executionBindingDigest = initial.binding.bindingDigest;
  const plannedJournalDigest = initial.journal.journalDigest;
  const attemptId = crypto.randomBytes(16).toString("hex");
  const holderId = crypto.randomBytes(16).toString("hex");
  const fence = initial.journal.fence + 1;
  const stateDir = workspaceState(controlRoot, env);
  const provisioningHomeId = `${workerId}-provision`;
  const provisioningWorktreeParent = ensureProvisioningWorktreeParent(
    stateDir,
    initial.binding.expectedExecutionRoot
  );
  let environment;
  try {
    environment = taskEnvironment(
      stateDir,
      controlRoot,
      initial.profile,
      provisioningHomeId,
      {
        worktreeProvisioningController: true,
        worktreeProvisioningDestinationParent: provisioningWorktreeParent,
        worktreeProvisioningExpectedRoot:
          initial.binding.expectedExecutionRoot,
        worktreeProvisioningGitCommonDir: initial.binding.gitCommonDir,
        worktreeProvisioningBaseCommit: initial.binding.baseCommit
      }
    );
  } catch (error) {
    try {
      removeUnusedProvisioningParent(
        provisioningWorktreeParent,
        initial.binding.expectedExecutionRoot
      );
    } catch (cleanupError) {
      throw new CompanionError(
        "E_STATE",
        "Failed controller construction left its private destination parent.",
        {
          causeCode: error?.code || null,
          cleanupCode: cleanupError?.code || null
        }
      );
    }
    throw error;
  }
  const controllerProfile = officialProvisioningControllerProfile(
    initial.profile,
    environment
  );

  const mutationBase = Object.freeze({
    root: controlRoot,
    principal,
    workerId,
    executionBindingDigest,
    attemptId,
    fence,
    holderId,
    env
  });
  let prepared = null;
  let activation = null;
  let provider = null;
  let cleanupProof = null;

  const providerLaunch = {
    prepare(details = {}) {
      const result = prepareWriteProvisionerIntent({
        ...mutationBase,
        expectedJournalDigest: plannedJournalDigest,
        executableIdentity: details.executableIdentity
      });
      if (result.prepared) prepared = result;
      return result;
    },
    registerBootstrap(details) {
      const provisioningAt = new Date().toISOString();
      const leaseExpiresAt = new Date(
        Date.parse(provisioningAt) + leaseMs
      ).toISOString();
      const result = activateWriteProvisioningAttempt({
        ...mutationBase,
        expectedJournalDigest: details.expectedJournalDigest,
        providerSpawnIntentId: details.providerSpawnIntentId,
        processIdentity: details.processIdentity,
        provisioningAt,
        leaseExpiresAt
      });
      activation = result;
      return result;
    },
    settleRegistrationFailure(details) {
      if (!prepared?.intent
        || details?.intentId !== prepared.intent.intentId
        || details?.providerSpawnIntentId !== prepared.intent.intentId
        || details?.expectedPlannedJournalDigest !== plannedJournalDigest) {
        stateError(
          "Bootstrap registration cleanup no longer matches its prepared intent."
        );
      }
      const verified = assertWriteExecutionJob(
        readJob(controlRoot, workerId, env),
        env
      );
      const intent = verified.provisioningRuntime?.intent || null;
      if (verified.binding.bindingDigest !== executionBindingDigest
        || intent?.providerSpawnIntentId !== prepared.intent.intentId
        || intent.provisioningAttemptId !== attemptId
        || intent.provisioningFence !== fence
        || intent.holderId !== holderId) {
        stateError(
          "Bootstrap registration cleanup crossed its durable provisioning fence."
        );
      }

      let expectedJournalDigest;
      let resolution;
      if (verified.journal.state === "planned"
        && verified.journal.journalDigest === plannedJournalDigest
        && intent.status === "pending"
        && intent.processIdentity === null) {
        expectedJournalDigest = plannedJournalDigest;
        resolution = "preactivation-cleanup-proven";
      } else if (verified.journal.state === "provisioning"
        && verified.journal.previousJournalDigest === plannedJournalDigest
        && intent.status === "pending"
        && sameProcess(intent.processIdentity, details.processIdentity)) {
        expectedJournalDigest = verified.journal.journalDigest;
        resolution = "cleanup-proven";
      } else if (verified.journal.state === "failed"
        && intent.status === "no-child"
        && intent.resolution === "preactivation-cleanup-proven"
        && intent.processIdentity === null) {
        expectedJournalDigest = verified.journal.previousJournalDigest;
        resolution = intent.resolution;
      } else if (verified.journal.state === "failed"
        && intent.status === "no-child"
        && intent.resolution === "cleanup-proven"
        && sameProcess(intent.processIdentity, details.processIdentity)) {
        expectedJournalDigest =
          verified.provisioningRuntime.runtime.activatedJournalDigest;
        resolution = intent.resolution;
      } else {
        stateError(
          "Bootstrap registration cleanup cannot reconcile the current durable state."
        );
      }

      const settlement = recordWriteProvisionerNoChild({
        ...mutationBase,
        expectedJournalDigest,
        providerSpawnIntentId: prepared.intent.intentId,
        resolution,
        processIdentity: details.processIdentity,
        cleanupProof: details.cleanupProof
      });
      const settledIntent =
        settlement.job?.provisioningRuntime?.intent || null;
      if ((!settlement.settled && !settlement.replayed)
        || settlement.job?.status !== "failed"
        || settlement.job?.provisioning?.state !== "failed"
        || settledIntent?.status !== "no-child"
        || settledIntent.providerSpawnIntentId !== prepared.intent.intentId
        || settledIntent.resolution !== resolution) {
        stateError(
          "Bootstrap registration cleanup was not durably reconciled."
        );
      }
      return Object.freeze({
        reconciled: true,
        settlement
      });
    },
    noChild(details) {
      const providerSpawnIntentId = details.providerSpawnIntentId
        || details.intentId;
      const expectedJournalDigest = SHA256_HEX.test(
        details.expectedJournalDigest || ""
      )
        ? details.expectedJournalDigest
        : currentProvisioningDigest({
            root: controlRoot,
            workerId,
            executionBindingDigest,
            providerSpawnIntentId,
            processIdentity: details.processIdentity,
            plannedJournalDigest,
            env
          });
      const verified = assertWriteExecutionJob(
        readJob(controlRoot, workerId, env),
        env
      );
      const intent = verified.provisioningRuntime?.intent || null;
      if (["provisioning", "cleanup_pending"].includes(
        verified.journal.state
      ) && intent?.status === "registered") {
        return retainWriteProvisioningCleanupPending({
          ...mutationBase,
          expectedJournalDigest,
          providerSpawnIntentId,
          processIdentity: details.processIdentity,
          cleanupProof: details.cleanupProof
        });
      }
      return recordWriteProvisionerNoChild({
        ...mutationBase,
        expectedJournalDigest,
        providerSpawnIntentId,
        resolution: details.resolution,
        processIdentity: details.processIdentity,
        cleanupProof: details.cleanupProof
      });
    }
  };

  try {
    environment.verifyGitExecutable();
    provider = await openProvider({
      root: controlRoot,
      profile: controllerProfile,
      stateDir,
      jobMarker: workerId,
      environment,
      guardBinding: {
        purpose: "worktree-provisioning",
        controlWorkspaceId: initial.binding.controlWorkspaceId,
        controlRoot,
        expectedExecutionRoot: initial.binding.expectedExecutionRoot,
        executionBindingDigest,
        provisioningAttemptId: attemptId,
        provisioningFence: fence,
        holderId
      },
      providerLaunch
    });
    if (!prepared?.intent || !activation?.job?.provisioning?.journalDigest) {
      stateError("Provisioner bootstrap did not retain its durable activation.");
    }
    const assertRegisteredController = () => {
      const registered = assertWriteExecutionJob(
        readJob(controlRoot, workerId, env),
        env
      );
      const registeredIntent =
        registered.provisioningRuntime?.intent || null;
      if (registered.journal.state !== "provisioning"
        || registered.journal.journalDigest
          !== activation.job.provisioning.journalDigest
        || registeredIntent?.status !== "registered"
        || registeredIntent.providerSpawnIntentId
          !== prepared.intent.providerSpawnIntentId
        || !sameProcess(registeredIntent.processIdentity, provider.process)) {
        stateError(
          "Official create requires the exact durably registered controller."
        );
      }
      return registered;
    };
    assertRegisteredController();

    const acp = new GrokWorktreeAcp(provider.client, { timeoutMs });
    environment.verifyGitExecutable();
    const beforeCreate = assertRegisteredController();
    const createTimeoutMs = remainingProvisioningLeaseTimeout(
      beforeCreate.journal.leaseExpiresAt,
      timeoutMs,
      "official worktree create"
    );
    const created = await acp.create({
      operationId: prepared.intent.operationId,
      sourcePath: controlRoot,
      worktreePath: initial.binding.expectedExecutionRoot,
      gitRef: initial.binding.baseCommit,
      label: workerId,
      timeoutMs: createTimeoutMs
    });
    const receipt = recordOfficialWorktreeReceipt({
      ...mutationBase,
      expectedJournalDigest: activation.job.provisioning.journalDigest,
      providerSpawnIntentId: prepared.intent.providerSpawnIntentId,
      officialReceipt: exactOfficialReceipt(created),
      executableIdentity: provider.executableIdentity
    });

    const closeTimeoutMs = remainingProvisioningLeaseTimeout(
      receipt.job.provisioning.leaseExpiresAt,
      timeoutMs,
      "official worktree session close"
    );
    await acp.close({
      sessionId: prepared.intent.operationId,
      timeoutMs: closeTimeoutMs
    });
    if (receipt.receipt.officialStatus !== "created") {
      throw new CompanionError(
        "E_WORKTREE",
        "A fresh write-worker provisioner cannot promote an existing worktree."
      );
    }
    cleanupProof = await cleanupProvisioningProvider({
      provider,
      environment,
      stateDir,
      controlRoot,
      workerId,
      env
    });
    provider = null;

    const executionContextManifest = captureContextManifest(
      initial.binding.expectedExecutionRoot
    );
    const promoted = promoteWriteWorkerReady({
      ...mutationBase,
      expectedJournalDigest: activation.job.provisioning.journalDigest,
      providerSpawnIntentId: prepared.intent.providerSpawnIntentId,
      executionContextManifest,
      cleanupProof
    });
    return Object.freeze({
      workerId,
      operationId: prepared.intent.operationId,
      officialStatus: receipt.receipt.officialStatus,
      executionRoot: initial.binding.expectedExecutionRoot,
      bindingDigest: executionBindingDigest,
      receiptDigest: receipt.receipt.receiptDigest,
      cleanupProofDigest:
        promoted.job.provisioningRuntime.cleanupProof.proofDigest,
      journalDigest: promoted.job.provisioning.journalDigest,
      controllerGitExecutableDigest: environment.gitExecutableDigest,
      controllerGitInstallationRootDigest: crypto
        .createHash("sha256")
        .update(environment.gitInstallationRoot)
        .digest("hex"),
      executableIdentity: receipt.receipt.executableIdentity,
      ready: promoted.job.provisioning.state === "ready",
      replayed: false,
      providerLaunched: true,
      workerDispatched: false
    });
  } catch (error) {
    if (provider) {
      try {
        cleanupProof = await cleanupProvisioningProvider({
          provider,
          environment,
          stateDir,
          controlRoot,
          workerId,
          env
        });
        provider = null;
      } catch (cleanupError) {
        const identity = providerCleanupIdentity(cleanupError)
          || provider?.process
          || null;
        if (!identity || processGroupGone(identity)) {
          try { removeProvisioningHome(stateDir, environment); } catch {}
        }
        throw cleanupError;
      }
    }

    let current = null;
    try {
      current = assertWriteExecutionJob(
        readJob(controlRoot, workerId, env),
        env
      );
    } catch {
      // Preserve the primary error; a corrupt durable record must not be
      // rewritten by this cleanup path.
    }
    if (cleanupProof && current?.journal.state === "provisioning") {
      const currentIntent = current.provisioningRuntime.intent;
      if (currentIntent.status === "registered") {
        // Once the official controller registered, controller cleanup proves
        // only that its process, guard, credential, profile, and private home
        // are gone. It does not prove that the external worktree effect is
        // absent, including when create() rejected before returning a receipt.
        // Retain a recoverable cleanup-pending record for exact path and raw
        // Git-registration reconciliation instead of publishing false failure.
        retainWriteProvisioningCleanupPending({
          ...mutationBase,
          expectedJournalDigest: current.journal.journalDigest,
          providerSpawnIntentId: currentIntent.providerSpawnIntentId,
          processIdentity: currentIntent.processIdentity,
          cleanupProof
        });
      } else {
        recordWriteProvisionerNoChild({
          ...mutationBase,
          expectedJournalDigest: current.journal.journalDigest,
          providerSpawnIntentId: currentIntent.providerSpawnIntentId,
          resolution: "cleanup-proven",
          processIdentity: currentIntent.processIdentity,
          cleanupProof,
          error: boundedFailure(error)
        });
      }
    } else if (!provider) {
      const retainedIdentity = providerCleanupIdentity(error);
      try {
        environment.revokeCredential();
        if (!retainedIdentity || processGroupGone(retainedIdentity)) {
          removeProvisioningHome(stateDir, environment);
        }
      } catch {
        // openProvider owns any process-identity failure and retains unsafe
        // artifacts. Do not mask its authoritative error.
      }
    }
    throw error;
  }
}
