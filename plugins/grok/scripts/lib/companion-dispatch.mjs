import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CompanionError } from "./errors.mjs";
import { cleanupReviewEnvironment } from "./provider-credentials.mjs";
import { readValidProviderCapabilityReceipt } from "./provider-capability.mjs";
import { assertProviderLaunchBinding as assertExecutableProviderLaunchBinding, providerLaunchBindingDigest as digestProviderLaunchBinding } from "./provider-executable-pin.mjs";
import { admitJob, updateJob, readJob, terminal, now } from "./state.mjs";
import { resolveControlWorkspace } from "./workspace.mjs";
import { redactText, sanitizeDisplayText } from "./redact.mjs";
import { missingInvalidProviderCapabilityReceiptMessage } from "./host.mjs";
import { appendLifecycleEvent } from "./task-lifecycle.mjs";
import { scrubStoredJob } from "./task-envelope.mjs";
import { projectWorkerHandle } from "./worker-protocol.mjs";
import { createDispatchOutbox, createWorkerAuthorization, isSupportedWorkerDispatch, workerLaunchDigest } from "./worker-launch-contract.mjs";
import { launchCommittedWorker } from "./worker-runtime.mjs";
import { materializeRole } from "./worker-roles.mjs";
const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "grok-companion.mjs"
);
import { applyTaskPrivacy, providerLaunchBinding, stateDir, workerEnvironment } from "./companion-shared.mjs";

import { recoverActiveJobs } from "./companion-recovery.mjs";

function invalidProviderCapabilityError() {
  return new CompanionError(
    "E_CAPABILITY",
    missingInvalidProviderCapabilityReceiptMessage()
  );
}

function requiredProviderSpawnBinding() {
  const capabilityReceipt = readValidProviderCapabilityReceipt();
  if (!capabilityReceipt) {
    throw invalidProviderCapabilityError();
  }
  const providerLaunchBinding = assertExecutableProviderLaunchBinding(
    capabilityReceipt.providerLaunchBinding
  );
  const providerLaunchBindingDigest = digestProviderLaunchBinding(
    providerLaunchBinding
  );
  if (providerLaunchBindingDigest !== capabilityReceipt.providerLaunchBindingDigest) {
    throw invalidProviderCapabilityError();
  }
  const providerCapabilityDigest = capabilityReceipt.capabilityDigest;
  return Object.freeze({
    providerCapabilityDigest,
    providerLaunchBinding,
    providerLaunchBindingDigest
  });
}

function prepareSharedTaskDispatch(root, job) {
  const host = job.host;
  if (job.jobClass !== "task"
    || host?.kind !== "codex"
    || !host.sessionId) return null;
  // Natural Codex tasks (read and write) must pin the exact setup-owned
  // provider readiness receipt before admitJob so detached workers cannot drift
  // to an ambient Grok binary. capabilityDigest is setup/readiness provenance
  // only; implementer profile and launch authorization remain separate.
  const providerSpawnBinding = requiredProviderSpawnBinding();
  if (job.write) {
    // Direct Codex write tasks retain the established nonce launcher until they
    // have a provisioned execution binding. They still carry the exact setup
    // provider pin so their detached worker cannot fall back to ambient Grok.
    job.request = {
      ...job.request,
      spawn: {
        ...(job.request?.spawn || {}),
        ...providerSpawnBinding
      }
    };
    return null;
  }
  const principal = Object.freeze({ hostKind: host.kind, threadId: host.sessionId, pluginId: null });
  const role = materializeRole(job.write ? "implementer" : "explorer");
  const createdAt = job.createdAt || now();
  const { controlWorkspaceId, executionRoot } = resolveControlWorkspace(root);
  const requestDigest = workerLaunchDigest({
    schemaVersion: 1,
    workerId: job.id,
    host,
    write: Boolean(job.write),
    profile: job.profile,
    role,
    envelopeDigest: job.request?.envelope?.digest || null,
    contextManifestDigest: job.request?.contextManifest?.digest || null,
    resumeJobId: job.request?.resumeJobId || null,
    resumeSessionId: job.request?.resumeSessionId || null,
    providerHomeId: job.request?.providerHomeId || job.id,
    providerCapabilityDigest: providerSpawnBinding.providerCapabilityDigest,
    providerLaunchBindingDigest:
      providerSpawnBinding.providerLaunchBindingDigest
  });
  job.controlWorkspaceId = controlWorkspaceId;
  job.role = { ...role, tools: [...role.tools] };
  job.phase = "accepted";
  job.request = {
    ...job.request,
    providerPromptDigest: crypto
      .createHash("sha256")
      .update(String(job.request?.prompt || ""))
      .digest("hex"),
    roleId: role.id,
    spawn: {
      executionRoot,
      ownerThreadId: host.sessionId,
      requestDigest,
      successDefinition: "durable-job-commit",
      ownershipMode: "exact-host-session",
      ...providerSpawnBinding,
      providerLaunchPending: true,
      providerLaunchInFlight: false,
      providerLaunchOutcome: "pending",
      dispatch: createDispatchOutbox({ createdAt })
    }
  };
  job.workerAuthorization = null;
  job.workerAuthorization = createWorkerAuthorization({ job, principal, issuedAt: createdAt });
  return principal;
}

async function startJob(root, job, background, { announce = false } = {}) {
  const sharedPrincipal = prepareSharedTaskDispatch(root, job);
  const nonce = sharedPrincipal ? null : crypto.randomBytes(16).toString("hex");
  if (!sharedPrincipal) job.workerAuthorization = nonce;
  admitJob(root, job);
  let diagnostic = "";
  let launcher = null;
  let launcherCode = -1;
  if (sharedPrincipal) {
    try {
      launchCommittedWorker({ root, workerId: job.id, principal: sharedPrincipal });
      launcherCode = 0;
    } catch (error) {
      diagnostic = sanitizeDisplayText(error.message);
    }
  } else {
    try {
      launcher = spawn(process.execPath, [SCRIPT, "--launch-worker", job.id, "--cwd", root], { cwd: root, shell: false, stdio: ["ignore", "ignore", "pipe"], env: workerEnvironment(nonce) });
      launcher.stderr?.setEncoding("utf8"); launcher.stderr?.on("data", (chunk) => { diagnostic = `${diagnostic}${chunk}`.slice(-8192); });
      launcherCode = await new Promise((resolve) => {
        launcher.once("error", (error) => { diagnostic = sanitizeDisplayText(error.message); resolve(-1); });
        launcher.once("close", resolve);
      });
    } catch (error) {
      diagnostic = sanitizeDisplayText(error.message);
    }
  }
  if (launcherCode !== 0) {
    if (job.jobClass === "task") {
      // A failed nonce launcher does not prove that no detached child crossed
      // the spawn boundary. Keep task terminal intent durable but nonterminal;
      // an exact recovery owner must prove process/runtime cleanup before final
      // workspace observation and publication.
      updateJob(root, job.id, (current) => {
        if (terminal(current)
          || isSupportedWorkerDispatch(current.request?.spawn?.dispatch)) {
          return current;
        }
        const intendedMessage =
          redactText(diagnostic) || "Could not launch the isolated Grok worker.";
        const blockedMessage =
          "Worker launch failed, but detached process and runtime cleanup are not yet proven.";
        current.status = "running";
        current.phase = "launch-unsettled";
        current.completedAt = null;
        current.pendingTerminal = {
          status: "failed",
          phase: "failed",
          completedAt: now(),
          error: {
            code: "E_WORKER_LOST",
            message: intendedMessage
          },
          summary: intendedMessage
        };
        current.error = {
          code: "E_PROCESS_IDENTITY",
          message: blockedMessage
        };
        current.summary = blockedMessage;
        current.progress =
          "Worker launch failed; exact process and runtime cleanup remain pending";
        current.result = applyTaskPrivacy(
          current.result,
          null,
          "Task runtime artifacts retained until failed-launch cleanup is proven."
        );
        current.lifecycleEvents = appendLifecycleEvent(
          current.lifecycleEvents || [],
          "blocked",
          blockedMessage
        );
        return scrubStoredJob(current);
      });
    } else {
      const cleanup = job.jobClass === "review"
        ? cleanupReviewEnvironment(stateDir(root), job.id)
        : null;
      updateJob(root, job.id, (current) => {
        Object.assign(current, scrubStoredJob(current));
        current.status = "failed";
        current.phase = "failed";
        current.completedAt = now();
        current.error = {
          code: "E_WORKER_LOST",
          message: redactText(diagnostic)
            || "Could not launch the isolated Grok worker."
        };
        current.summary = current.error.message;
        current.result = {
          ...(current.result || {}),
          hostVerification: "not_run"
        };
        current.lifecycleEvents = appendLifecycleEvent(
          current.lifecycleEvents,
          "blocked",
          current.error.message
        );
        if (cleanup) {
          current.result = {
            ...(current.result || {}),
            providerSessionDeleted: cleanup.ok
          };
          if (cleanup.warning) {
            current.result.privacyWarning = cleanup.warning;
          }
        }
        return current;
      });
    }
  }
  if (launcherCode === 0 && !background && announce) {
    const accepted = readJob(root, job.id);
    const acceptedHandle = projectWorkerHandle(accepted);
    process.stderr.write(`GROK_JOB_ACCEPTED ${JSON.stringify({
      id: acceptedHandle.id,
      status: acceptedHandle.status,
      phase: acceptedHandle.phase,
      progress: acceptedHandle.progress || acceptedHandle.summary || "Worker started"
    })}\n`);
  }
  if (background) return readJob(root, job.id);
  let finished = readJob(root, job.id);
  if (launcherCode !== 0 && !terminal(finished)) {
    throw new CompanionError(
      finished.error?.code || "E_PROCESS_IDENTITY",
      finished.error?.message
        || "Worker launch cleanup remains unproven.",
      {
        ...(finished.error?.details || {}),
        workerId: finished.id
      }
    );
  }
  let lastRecovery = 0;
  while (!terminal(finished)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (Date.now() - lastRecovery >= 500) { lastRecovery = Date.now(); await recoverActiveJobs(root); }
    finished = readJob(root, job.id);
  }
  if (finished.status === "failed" || finished.status === "cancelled") throw new CompanionError(finished.error?.code || "E_PROVIDER_EXIT", finished.error?.message || diagnostic || "Grok job failed.", finished.error?.details);
  return finished;
}

export { invalidProviderCapabilityError, requiredProviderSpawnBinding, startJob };
