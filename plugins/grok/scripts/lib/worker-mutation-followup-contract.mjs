/** Issue #56 worker-mutation followup-contract domain. */
import { CompanionError, asErrorPayload } from "./errors.mjs";
import {
  generateId,
  isCancelRequested,
  now,
  readPrivateJsonFile,
  tryReadJob,
  writePrivateJsonFile,
  ensurePrivateStateDirectory,
  withWorkspaceStateTransaction
} from "./state.mjs";
import {
  assertContextCompatible,
  assertContextManifestIntegrity,
  captureContextManifest
} from "./task-context-manifest.mjs";
import {
  CONTEXT_BINDING_MODE,
  assertContextPacket,
  assertContextReceipt,
  buildContextPacket,
  buildContextReceipt,
  resolveJobProviderPrompt,
  verifyJobEffectivePrompt
} from "./worker-context.mjs";
import { profileFor, sameSecurityProfile } from "./profiles.mjs";
import { assertBrokerMutationAuthority } from "./worker-authority.mjs";
import {
  assertAdmissionGrantEligible,
  assertHostActionRequestStillBound,
  assertHostActionRecord
} from "./worker-host-actions.mjs";
import {
  SHA256_HEX,
  digestKey,
  hasExactKeys,
  stableDigest,
  validIsoTimestamp
} from "./worker-mutation-primitives.mjs";
import {
  requestDigest
} from "./worker-mutation-request-contract.mjs";

export const FOLLOWUP_ADMISSION_WITNESS_SCHEMA_VERSION = 1;

export const FOLLOWUP_ADMISSION_KIND = "granted-read-role-continuation";

export const FOLLOWUP_ADMISSION_WITNESS_KEYS = new Set([
  "schemaVersion",
  "kind",
  "childWorkerId",
  "parentWorkerId",
  "lineageWorkerId",
  "sourceRequestId",
  "sourceRequestDigest",
  "sourceDecisionId",
  "sourceDecisionDigest",
  "grantId",
  "grantDigest",
  "requestedRoleId",
  "targetRoleDigest",
  "targetRuntimeRolePolicyDigest",
  "resumeSessionDigest",
  "finalContextManifestId",
  "finalContextManifestDigest",
  "messageDigest",
  "ownerThreadDigest",
  "idempotencyKeyDigest",
  "followupRequestDigest",
  "witnessDigest"
]);

export const FOLLOWUP_IDEMPOTENCY_SCHEMA_VERSION = 1;

export const FOLLOWUP_IDEMPOTENCY_KEYS = new Set([
  "schemaVersion",
  "workerId",
  "parentWorkerId",
  "grantId",
  "ownerThreadDigest",
  "idempotencyKeyDigest",
  "followupRequestDigest",
  "committedAt",
  "recordDigest"
]);

export function followupStateError(message) {
  throw new CompanionError("E_STATE", message);
}

export function followupRequestBody({
  parentWorkerId,
  lineageWorkerId,
  grant,
  finalContextManifest,
  messageDigest,
  ownerThreadDigest,
  idempotencyKeyDigest
}) {
  return {
    schemaVersion: FOLLOWUP_ADMISSION_WITNESS_SCHEMA_VERSION,
    kind: FOLLOWUP_ADMISSION_KIND,
    parentWorkerId,
    lineageWorkerId,
    sourceRequestId: grant.sourceRequestId,
    sourceRequestDigest: grant.sourceRequestDigest,
    sourceDecisionId: grant.sourceDecisionId,
    sourceDecisionDigest: grant.sourceDecisionDigest,
    grantId: grant.grantId,
    grantDigest: grant.grantDigest,
    requestedRoleId: grant.requestedRoleId,
    targetRoleDigest: grant.targetRole.digest,
    targetRuntimeRolePolicyDigest: grant.targetRuntimeRolePolicy.digest,
    finalContextManifestId: finalContextManifest.manifestId,
    finalContextManifestDigest: finalContextManifest.digest,
    messageDigest,
    ownerThreadDigest,
    idempotencyKeyDigest
  };
}

export function followupWitnessBody(witness) {
  const { witnessDigest: _witnessDigest, ...body } = witness;
  return body;
}

export function normalizeFollowupAdmissionWitness(witness) {
  if (!hasExactKeys(witness, FOLLOWUP_ADMISSION_WITNESS_KEYS)
    || witness.schemaVersion !== FOLLOWUP_ADMISSION_WITNESS_SCHEMA_VERSION
    || witness.kind !== FOLLOWUP_ADMISSION_KIND
    || !/^task-[a-f0-9]{16,64}$/.test(witness.childWorkerId || "")
    || !/^task-[a-f0-9]{16,64}$/.test(witness.parentWorkerId || "")
    || !/^task-[a-f0-9]{16,64}$/.test(witness.lineageWorkerId || "")
    || !/^har-[a-f0-9]{24}$/.test(witness.sourceRequestId || "")
    || !/^had-[a-f0-9]{24}$/.test(witness.sourceDecisionId || "")
    || !/^hag-[a-f0-9]{24}$/.test(witness.grantId || "")
    || !["reviewer", "security", "test"].includes(witness.requestedRoleId)
    || !/^ctx-[a-f0-9]{24}$/.test(witness.finalContextManifestId || "")
    || [
      "sourceRequestDigest",
      "sourceDecisionDigest",
      "grantDigest",
      "targetRoleDigest",
      "targetRuntimeRolePolicyDigest",
      "resumeSessionDigest",
      "finalContextManifestDigest",
      "messageDigest",
      "ownerThreadDigest",
      "idempotencyKeyDigest",
      "followupRequestDigest",
      "witnessDigest"
    ].some((key) => !SHA256_HEX.test(witness[key] || ""))) {
    followupStateError("Follow-up admission witness is malformed.");
  }
  if (witness.witnessDigest !== stableDigest(followupWitnessBody(witness))) {
    followupStateError("Follow-up admission witness digest is invalid.");
  }
  return Object.freeze({ ...witness });
}

export function messageDigestFromEnvelope(envelope) {
  if (typeof envelope?.userRequest === "string") return digestKey(envelope.userRequest);
  if (envelope?.userRequest === null && SHA256_HEX.test(envelope.userRequestDigest || "")) {
    return envelope.userRequestDigest;
  }
  followupStateError("Follow-up worker request text binding is malformed.");
}

export function terminalFollowupParent(parent) {
  return Boolean(
    parent
    && ["completed", "failed", "cancelled"].includes(parent.status)
    && typeof parent.grokSessionId === "string"
    && parent.grokSessionId.length > 0
    && parent.grokSessionId.length <= 256
    && !/[\r\n\0]/.test(parent.grokSessionId)
    && parent.result?.taskRuntimeCleaned === true
  );
}

export function interruptedFollowupParent(parent) {
  return Boolean(
    parent
    && parent.status === "interrupted"
    && typeof parent.grokSessionId === "string"
    && parent.grokSessionId.length > 0
    && parent.grokSessionId.length <= 256
    && !/[\r\n\0]/.test(parent.grokSessionId)
    && parent.result?.interrupt?.sessionPreserved === true
  );
}

export function resolveParentAdmission(parent, {
  root,
  principal = null,
  grantId,
  child = null,
  verifyCurrentContext = true
} = {}) {
  if (principal) {
    assertBrokerMutationAuthority(principal, {
      root,
      exactThreadId: parent?.host?.sessionId ?? null
    });
  }
  if (!terminalFollowupParent(parent) && !interruptedFollowupParent(parent)) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Follow-up requires a terminal parent with an exact provider session and completed task-runtime cleanup."
    );
  }
  if (parent.host?.kind !== "codex"
    || typeof parent.host.sessionId !== "string"
    || (child && (
      child.host?.kind !== parent.host.kind
      || child.host?.sessionId !== parent.host.sessionId
    ))) {
    throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
  }
  const record = assertHostActionRecord(parent.hostAction);
  if (!record
    || record.decision?.decision !== "grant"
    || record.grant?.grantId !== grantId
    || record.grant.sourceWorkerId !== parent.id
    || record.grant.sourceRequestId !== record.request.requestId
    || record.grant.sourceRequestDigest !== record.request.requestDigest
    || record.grant.sourceDecisionId !== record.decision.decisionId
    || record.grant.sourceDecisionDigest !== record.decision.decisionDigest) {
    throw new CompanionError("E_CAPABILITY", "Worker does not own the requested durable role-admission grant.");
  }

  assertHostActionRequestStillBound(parent, record.request, {
    providerSessionId: parent.grokSessionId
  });

  const targetProfile = profileFor("task", false);
  if (!sameSecurityProfile(parent.profile, targetProfile)) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Follow-up cannot resume a provider session across different security profiles."
    );
  }
  const parentRequestContext = assertContextManifestIntegrity(
    parent.request?.contextManifest
  );
  assertContextPacket(parent.request?.contextPacket, {
    envelope: parent.request?.envelope
  });
  assertContextReceipt(parent.request?.contextReceipt, {
    contextPacket: parent.request.contextPacket,
    rolePolicy: parent.request.runtimeRolePolicy,
    contextManifest: parentRequestContext,
    lineageWorkerId: parent.request?.followup ? parent.id : parent.request.providerHomeId,
    effectivePromptDigest: parent.request.providerPromptDigest
  });
  const grant = assertAdmissionGrantEligible(record.grant, {
    sourceWorkerId: parent.id,
    sourceRequestId: record.request.requestId,
    sourceRequestDigest: record.request.requestDigest,
    sourceDecisionId: record.decision.decisionId,
    sourceDecisionDigest: record.decision.decisionDigest,
    grantId: record.grant.grantId,
    grantDigest: record.grant.grantDigest,
    lineageWorkerId: parent.request.providerHomeId,
    resumeJobId: parent.request.resumeJobId ?? null,
    parentRole: parent.role,
    parentRuntimeRolePolicy: parent.request.runtimeRolePolicy,
    parentProfile: parent.profile,
    parentContextManifest: parentRequestContext,
    parentContextReceipt: parent.request.contextReceipt,
    providerPromptDigest: parent.request.providerPromptDigest,
    targetProfile
  });
  const availableFinalContexts = [
    parent.verificationContextManifest,
    parent.completionContextManifest
  ].filter(Boolean).map((manifest) => assertContextManifestIntegrity(manifest));
  const childContext = child?.request?.contextManifest
    ? assertContextManifestIntegrity(child.request.contextManifest)
    : null;
  const finalContextManifest = childContext
    ? availableFinalContexts.find((candidate) => (
        candidate.manifestId === childContext.manifestId
        && candidate.digest === childContext.digest
      )) || null
    : availableFinalContexts[0] || null;
  if (!finalContextManifest) {
    throw new CompanionError(
      "E_CONTEXT_DRIFT",
      "Follow-up parent has no final completion or verification context."
    );
  }
  if (verifyCurrentContext) {
    assertContextCompatible(root, finalContextManifest, { mode: "resume" });
  }
  return Object.freeze({
    record,
    grant,
    targetProfile,
    finalContextManifest,
    lineageWorkerId: parent.request.providerHomeId,
    resumeSessionId: parent.grokSessionId
  });
}

export function buildFollowupAdmissionWitness({
  childWorkerId,
  parent,
  admission,
  messageDigest,
  ownerThreadDigest,
  idempotencyKeyDigest,
  followupRequestDigest
}) {
  const body = {
    ...followupRequestBody({
      parentWorkerId: parent.id,
      lineageWorkerId: admission.lineageWorkerId,
      grant: admission.grant,
      finalContextManifest: admission.finalContextManifest,
      messageDigest,
      ownerThreadDigest,
      idempotencyKeyDigest
    }),
    childWorkerId,
    resumeSessionDigest: digestKey(admission.resumeSessionId),
    followupRequestDigest
  };
  return normalizeFollowupAdmissionWitness({
    ...body,
    witnessDigest: stableDigest(body)
  });
}

export function assertFollowupAdmissionBinding(job, {
  root = job?.request?.spawn?.executionRoot,
  env = process.env,
  verifyCurrentContext = true
} = {}) {
  const witness = normalizeFollowupAdmissionWitness(job?.request?.followup);
  if (witness.childWorkerId !== job.id
    || witness.parentWorkerId !== job.request?.resumeJobId
    || witness.lineageWorkerId !== job.request?.providerHomeId
    || witness.requestedRoleId !== job.request?.roleId
    || witness.targetRoleDigest !== job.role?.digest
    || witness.targetRuntimeRolePolicyDigest !== job.request?.runtimeRolePolicy?.digest
    || witness.resumeSessionDigest !== digestKey(job.request?.resumeSessionId || "")
    || witness.finalContextManifestId !== job.request?.contextManifest?.manifestId
    || witness.finalContextManifestDigest !== job.request?.contextManifest?.digest
    || witness.messageDigest !== messageDigestFromEnvelope(job.request?.envelope)
    || witness.ownerThreadDigest !== digestKey(job.host?.sessionId || "")
    || witness.idempotencyKeyDigest !== job.request?.spawn?.idempotencyKeyDigest) {
    followupStateError("Follow-up admission witness no longer matches its child worker.");
  }
  const parent = tryReadJob(root, witness.parentWorkerId, env);
  if (!parent) followupStateError("Follow-up admission parent is missing.");
  const admission = resolveParentAdmission(parent, {
    root,
    grantId: witness.grantId,
    child: job,
    verifyCurrentContext
  });
  const expectedRequestBody = followupRequestBody({
    parentWorkerId: parent.id,
    lineageWorkerId: admission.lineageWorkerId,
    grant: admission.grant,
    finalContextManifest: admission.finalContextManifest,
    messageDigest: witness.messageDigest,
    ownerThreadDigest: witness.ownerThreadDigest,
    idempotencyKeyDigest: witness.idempotencyKeyDigest
  });
  if (witness.followupRequestDigest !== stableDigest(expectedRequestBody)
    || witness.sourceRequestId !== admission.grant.sourceRequestId
    || witness.sourceRequestDigest !== admission.grant.sourceRequestDigest
    || witness.sourceDecisionId !== admission.grant.sourceDecisionId
    || witness.sourceDecisionDigest !== admission.grant.sourceDecisionDigest
    || witness.grantDigest !== admission.grant.grantDigest) {
    followupStateError("Follow-up admission grant or request binding drifted.");
  }
  return witness;
}

export function followupIdempotencyBody(record) {
  const { recordDigest: _recordDigest, ...body } = record;
  return body;
}

export function normalizeFollowupIdempotencyRecord(record, { keyDigest }) {
  if (!hasExactKeys(record, FOLLOWUP_IDEMPOTENCY_KEYS)
    || record.schemaVersion !== FOLLOWUP_IDEMPOTENCY_SCHEMA_VERSION
    || !/^task-[a-f0-9]{16,64}$/.test(record.workerId || "")
    || !/^task-[a-f0-9]{16,64}$/.test(record.parentWorkerId || "")
    || !/^hag-[a-f0-9]{24}$/.test(record.grantId || "")
    || record.idempotencyKeyDigest !== keyDigest
    || !validIsoTimestamp(record.committedAt)
    || ["ownerThreadDigest", "followupRequestDigest", "recordDigest"]
      .some((key) => !SHA256_HEX.test(record[key] || ""))
    || record.recordDigest !== stableDigest(followupIdempotencyBody(record))) {
    followupStateError("Follow-up idempotency record is malformed.");
  }
  return Object.freeze({ ...record });
}

export function followupIdempotencyRecord(job) {
  const witness = normalizeFollowupAdmissionWitness(job.request?.followup);
  const body = {
    schemaVersion: FOLLOWUP_IDEMPOTENCY_SCHEMA_VERSION,
    workerId: job.id,
    parentWorkerId: witness.parentWorkerId,
    grantId: witness.grantId,
    ownerThreadDigest: witness.ownerThreadDigest,
    idempotencyKeyDigest: witness.idempotencyKeyDigest,
    followupRequestDigest: witness.followupRequestDigest,
    committedAt: job.createdAt
  };
  return normalizeFollowupIdempotencyRecord({
    ...body,
    recordDigest: stableDigest(body)
  }, { keyDigest: witness.idempotencyKeyDigest });
}
