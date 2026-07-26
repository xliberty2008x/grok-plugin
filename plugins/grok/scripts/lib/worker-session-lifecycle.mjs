import fs from "node:fs";
import path from "node:path";

import { CompanionError } from "./errors.mjs";
import {
  captureGrokExecutableIdentity,
  sameExecutableRelease
} from "./executable-identity.mjs";
import {
  deleteSession,
  discoverGrok,
  inspectImportedSessionPresence,
  taskCredentialEnvironment
} from "./grok-provider.mjs";
import { sameHostSession } from "./host.mjs";
import { processGroupGone } from "./process-control.mjs";
import { loadProviderGuard } from "./recursion-guard.mjs";
import { jobFileIfPresent, tryReadJob } from "./state.mjs";
import {
  assertParentUnchanged,
  expectedWorkerWorktreeRoot
} from "./worker-worktree.mjs";
import { resolveControlWorkspace } from "./workspace.mjs";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sessionError(message) {
  return new CompanionError("E_INTEGRATION", message);
}

function exactCredentialAbsent(grokHome) {
  const authFile = path.join(grokHome, "auth.json");
  try {
    fs.lstatSync(authFile);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

function exactCancelledWriteCleanupJob(job, root, workerId, env) {
  const binding = job?.executionBinding;
  const dispatch = job?.request?.spawn?.dispatch;
  let control;
  try {
    control = resolveControlWorkspace(root, env);
    assertParentUnchanged(binding?.parentFingerprint, binding?.controlRoot);
  } catch {
    return false;
  }
  return job?.schemaVersion === 3
    && job.kind === "task"
    && job.jobClass === "task"
    && job.write === true
    && job.status === "cancelled"
    && job.result?.stopReason === "cancelled"
    && job.result?.taskRuntimeCleaned === true
    && job.result?.hostVerification === "not_run"
    && !Object.hasOwn(job.result || {}, "writeArtifact")
    && binding?.workerId === workerId
    && binding.controlWorkspaceId === job.controlWorkspaceId
    && binding.controlWorkspaceId === control.controlWorkspaceId
    && binding.controlRoot === control.controlRoot
    && job.request?.spawn?.executionBindingDigest === binding.bindingDigest
    && binding.expectedExecutionRoot === expectedWorkerWorktreeRoot(
      control.controlRoot,
      workerId,
      env
    )
    && job.provisioning?.state === "ready"
    && typeof job.provisioningRuntime?.intent?.operationId === "string"
    && job.provisioningRuntime.intent.operationId.length > 0
    && job.provisioningRuntime.intent.operationId.length <= 256
    && job.provisioningRuntime?.intent?.executableIdentity
    && [1, 2].includes(dispatch?.schemaVersion)
    && dispatch.state === "provider-started"
    && Number.isSafeInteger(dispatch.providerGeneration)
    && dispatch.providerGeneration > 0
    && job.request?.spawn?.providerLaunchOutcome === "launched"
    && [
      job.controllerProcess,
      job.workerProcess,
      job.providerProcess
    ].every((identity) => processGroupGone(identity))
    && loadProviderGuard(binding.controlRoot, workerId, env) === null;
}

function bindOwnedProviderSession({
  root,
  principal,
  workerId,
  providerSessionId,
  env
}) {
  const job = tryReadJob(root, workerId, env);
  const host = {
    kind: "codex",
    sessionId: principal?.threadId
  };
  if (!job || !sameHostSession(job, host)) {
    throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
  }
  const terminalEligible = job?.status === "completed"
    || exactCancelledWriteCleanupJob(job, root, workerId, env);
  if (
    job.write !== true
    || !terminalEligible
    || job.id !== workerId
    || job.request?.providerHomeId !== workerId
    || job.grokSessionId !== providerSessionId
    || !CANONICAL_UUID.test(providerSessionId || "")
  ) {
    throw sessionError("Owned provider session binding is invalid.");
  }
  const expectedExecutable =
    job.provisioningRuntime?.intent?.executableIdentity;
  const binary = discoverGrok();
  const currentExecutable = captureGrokExecutableIdentity(binary);
  if (
    !expectedExecutable
    || !sameExecutableRelease(
      expectedExecutable,
      currentExecutable.attestation
    )
  ) {
    throw new CompanionError(
      "E_CONTEXT_DRIFT",
      "The installed Grok release changed before provider-session cleanup."
    );
  }
  const jobFile = jobFileIfPresent(root, workerId, env);
  if (!jobFile) throw sessionError("Owned provider session state is unavailable.");
  const stateDirectory = path.dirname(path.dirname(jobFile));
  return Object.freeze({
    binary,
    stateDirectory,
    homeMarker: workerId,
    cwd: job.executionBinding?.controlRoot || root
  });
}

async function withOwnedSessionCredential(options, operation) {
  const binding = bindOwnedProviderSession(options);
  let credential = null;
  let primaryError = null;
  let result;
  try {
    credential = taskCredentialEnvironment(
      binding.stateDirectory,
      binding.homeMarker
    );
    result = await operation(binding, credential);
  } catch (error) {
    primaryError = error;
  } finally {
    let cleanupError = null;
    try {
      credential?.refreshCredentialHandle();
    } catch (error) {
      cleanupError = error;
    }
    try {
      credential?.revokeCredential();
    } catch (error) {
      cleanupError ||= error;
    }
    try {
      if (credential && !exactCredentialAbsent(credential.grokHome)) {
        cleanupError ||= sessionError(
          "Provider-session credential remained after the bounded operation."
        );
      }
    } catch (error) {
      cleanupError ||= error;
    }
    if (cleanupError) {
      throw new CompanionError(
        "E_STATE",
        "Provider-session credential cleanup could not be proven."
      );
    }
  }
  if (primaryError) throw primaryError;
  return result;
}

export async function inspectOwnedProviderSession({
  root,
  principal,
  workerId,
  providerSessionId,
  env = process.env
} = {}) {
  return withOwnedSessionCredential(
    { root, principal, workerId, providerSessionId, env },
    (binding, credential) => {
      const observed = inspectImportedSessionPresence(
        providerSessionId,
        binding.binary,
        credential.env,
        binding.cwd
      );
      if (observed?.ok !== true || typeof observed.present !== "boolean") {
        throw sessionError("Provider-session presence could not be observed.");
      }
      return Object.freeze({ present: observed.present });
    }
  );
}

export async function deleteOwnedProviderSession({
  root,
  principal,
  workerId,
  providerSessionId,
  env = process.env
} = {}) {
  return withOwnedSessionCredential(
    { root, principal, workerId, providerSessionId, env },
    (binding, credential) => {
      const deleted = deleteSession(
        providerSessionId,
        binding.binary,
        credential.env
      );
      return Object.freeze({
        deleted: deleted?.ok === true && deleted.removed === true
      });
    }
  );
}
