import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import test from "node:test";

import {
  EXECUTION_BINDING_SCHEMA_VERSION,
  EXECUTION_PROVISIONING_SCHEMA_VERSION,
  assertExecutionBinding,
  assertProvisioningJournal,
  createExecutionBinding,
  createProvisioningJournal,
  createPublicExecutionProjection,
  reclaimProvisioningJournal,
  transitionProvisioningJournal
} from "../plugins/grok/scripts/lib/worker-execution-binding.mjs";

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : stableStringify(value))
    .digest("hex");
}

function clone(value) {
  return structuredClone(value);
}

function redigestJournal(journal) {
  journal.journalDigest = sha256(Object.fromEntries(
    Object.entries(journal).filter(([key]) => key !== "journalDigest")
  ));
  return journal;
}

function assertStateError(action) {
  assert.throws(action, (error) => error?.code === "E_STATE");
}

const TIMES = Object.freeze({
  binding: "2026-07-24T12:00:00.000Z",
  planned: "2026-07-24T12:00:01.000Z",
  provisioning: "2026-07-24T12:00:02.000Z",
  lease: "2026-07-24T12:00:32.000Z",
  ready: "2026-07-24T12:00:03.000Z",
  cleanup: "2026-07-24T12:00:04.000Z",
  cleaned: "2026-07-24T12:00:05.000Z",
  failed: "2026-07-24T12:00:06.000Z"
});

const CANCELLATION_NONCE = "c".repeat(32);
const ATTEMPT_ID = "a".repeat(32);
const HOLDER_ID = "b".repeat(32);

function parentFingerprint({
  head = "1".repeat(40),
  tree = "2".repeat(40),
  clean = true,
  status = ""
} = {}) {
  const core = {
    fingerprintVersion: 1,
    head,
    tree,
    clean,
    statusDigest: sha256(status),
    indexDigest: sha256("index"),
    indexSecurityDigest: sha256("index-security"),
    worktreeDigest: sha256("worktree"),
    worktreeEntryCount: 12,
    status
  };
  return {
    ...core,
    fingerprintDigest: sha256(core)
  };
}

function bindingInput(overrides = {}) {
  const workerId = "task-0123456789abcdef01234567";
  const controlRoot = path.resolve("execution-binding-fixture", "control");
  return {
    workerId,
    controlWorkspaceId: `cws-${"3".repeat(32)}`,
    controlRoot,
    gitCommonDir: path.join(controlRoot, ".git"),
    baseCommit: "1".repeat(40),
    baseTree: "2".repeat(40),
    parentFingerprint: parentFingerprint(),
    expectedExecutionRoot: path.resolve(
      "execution-binding-fixture",
      "state",
      "worktrees",
      `${workerId}-0123456789ab`
    ),
    scope: {
      include: ["plugins/grok/**", "tests/**"],
      exclude: ["node_modules/**"]
    },
    envelopeDigest: sha256("envelope"),
    roleDigest: sha256("role"),
    profileDigest: sha256("profile"),
    runtimeRolePolicyDigest: sha256("runtime-role-policy"),
    admissionContextManifestId: `ctx-${"4".repeat(24)}`,
    admissionContextManifestDigest: sha256("admission-context"),
    providerCapabilityDigest: sha256("provider-capability"),
    ownerDigest: sha256("opaque-owner"),
    cancellationNonce: CANCELLATION_NONCE,
    createdAt: TIMES.binding,
    ...overrides
  };
}

function bindingFixture(overrides = {}) {
  return createExecutionBinding(bindingInput(overrides));
}

function plannedFixture(binding = bindingFixture()) {
  return createProvisioningJournal({
    binding,
    cancellationNonce: CANCELLATION_NONCE,
    createdAt: TIMES.planned
  });
}

function transitionRequest(journal, patch) {
  if (patch.state === journal.state) return { ...patch };
  const request = {
    expectedCurrentJournalDigest: journal.journalDigest,
    ...patch
  };
  if (journal.state === "provisioning") {
    if (!Object.hasOwn(request, "actorAttemptId")) {
      request.actorAttemptId = journal.attemptId;
    }
    if (!Object.hasOwn(request, "actorFence")) {
      request.actorFence = journal.fence;
    }
    if (!Object.hasOwn(request, "actorHolderId")) {
      request.actorHolderId = journal.provisioner.holderId;
    }
  }
  return request;
}

function transition(binding, journal, patch) {
  return transitionProvisioningJournal(binding, journal, transitionRequest(journal, patch));
}

function provisioningFixture(binding = bindingFixture(), journal = plannedFixture(binding)) {
  return transition(binding, journal, {
    state: "provisioning",
    attemptId: ATTEMPT_ID,
    fence: 1,
    provisioner: {
      pid: 42,
      startToken: "process-birth-token",
      holderId: HOLDER_ID
    },
    leaseExpiresAt: TIMES.lease,
    provisioningAt: TIMES.provisioning
  });
}

function readyPatch() {
  return {
    state: "ready",
    readyAt: TIMES.ready,
    executionContextManifestId: `ctx-${"5".repeat(24)}`,
    executionContextManifestDigest: sha256("execution-context")
  };
}

test("builders create exact immutable digest-bound binding and planned journal", () => {
  const binding = bindingFixture();
  assert.equal(binding.schemaVersion, EXECUTION_BINDING_SCHEMA_VERSION);
  assert.match(binding.bindingId, /^exec-[a-f0-9]{24}$/);
  assert.equal(binding.controlRootDigest, sha256(binding.controlRoot));
  assert.equal(binding.gitCommonDirDigest, sha256(binding.gitCommonDir));
  assert.equal(binding.parentFingerprintDigest, sha256(binding.parentFingerprint));
  assert.equal(binding.expectedExecutionRootDigest, sha256(binding.expectedExecutionRoot));
  assert.equal(binding.scopeDigest, sha256(binding.scope));
  assert.equal(binding.cancellationNonceDigest, sha256(CANCELLATION_NONCE));
  assert.equal("cancellationNonce" in binding, false);
  assert.equal("owner" in binding, false);
  assert.equal(Object.isFrozen(binding), true);
  assert.equal(Object.isFrozen(binding.parentFingerprint), true);
  assert.equal(Object.isFrozen(binding.scope.include), true);
  assert.equal(assertExecutionBinding(binding), binding);

  const journal = plannedFixture(binding);
  assert.equal(journal.schemaVersion, EXECUTION_PROVISIONING_SCHEMA_VERSION);
  assert.equal(journal.bindingDigest, binding.bindingDigest);
  assert.equal(journal.state, "planned");
  assert.equal(journal.journalRevision, 0);
  assert.equal(journal.previousJournalDigest, null);
  assert.equal(journal.attemptId, null);
  assert.equal(journal.fence, 0);
  assert.equal(journal.cleanupProvisioner, null);
  assert.equal(journal.plannedAt, TIMES.planned);
  assert.equal(journal.journalDigest, sha256(Object.fromEntries(
    Object.entries(journal).filter(([key]) => key !== "journalDigest")
  )));
  assert.equal(Object.isFrozen(journal), true);
  assert.equal(assertProvisioningJournal(binding, journal), journal);
});

test("happy provisioning sequence reaches ready with exact execution context", () => {
  const binding = bindingFixture();
  const planned = plannedFixture(binding);
  const provisioning = provisioningFixture(binding, planned);
  assert.equal(provisioning.state, "provisioning");
  assert.equal(provisioning.journalRevision, 1);
  assert.equal(provisioning.previousJournalDigest, planned.journalDigest);
  assert.equal(provisioning.fence, 1);
  assert.deepEqual(provisioning.provisioner, {
    pid: 42,
    startToken: "process-birth-token",
    holderId: HOLDER_ID
  });
  assert.equal(provisioning.cleanupProvisioner, null);

  const ready = transition(binding, provisioning, readyPatch());
  assert.equal(ready.state, "ready");
  assert.equal(ready.provisioner, null);
  assert.equal(ready.cleanupProvisioner, null);
  assert.equal(ready.leaseExpiresAt, null);
  assert.equal(ready.attemptId, ATTEMPT_ID);
  assert.equal(ready.fence, 1);
  assert.equal(ready.journalRevision, 2);
  assert.equal(ready.previousJournalDigest, provisioning.journalDigest);
  assert.match(ready.executionContextManifestId, /^ctx-[a-f0-9]{24}$/);
  assert.equal(assertProvisioningJournal(binding, ready), ready);
  assert.equal(transitionProvisioningJournal(binding, ready, { state: "ready" }), ready);
  assertStateError(() => transition(binding, provisioning, {
    ...readyPatch(),
    readyAt: "2026-07-24T12:00:32.001Z"
  }));
});

test("planned cancellation can clean without creating a provisioning attempt", () => {
  const binding = bindingFixture();
  const planned = plannedFixture(binding);
  const cleanupPending = transition(binding, planned, {
    state: "cleanup_pending",
    cleanupPendingAt: TIMES.cleanup
  });
  assert.equal(cleanupPending.attemptId, null);
  assert.equal(cleanupPending.fence, 0);
  assert.equal(cleanupPending.cleanupProvisioner, null);
  const cleaned = transition(binding, cleanupPending, {
    state: "cleaned",
    cleanedAt: TIMES.cleaned
  });
  assert.equal(cleaned.state, "cleaned");
  assert.equal(cleaned.provisioningAt, null);
  assert.equal(assertProvisioningJournal(binding, cleaned), cleaned);
  for (const patch of [
    {
      state: "cleanup_pending",
      attemptId: ATTEMPT_ID,
      fence: 1,
      provisioningAt: TIMES.provisioning,
      cleanupPendingAt: TIMES.cleanup
    },
    {
      state: "failed",
      attemptId: ATTEMPT_ID,
      fence: 1,
      provisioningAt: TIMES.provisioning,
      failedAt: TIMES.failed,
      error: { code: "E_WORKTREE", message: "Provisioning failed." }
    }
  ]) {
    assertStateError(() => transition(binding, planned, patch));
  }
});

test("provisioning cancellation retains attempt evidence through cleanup", () => {
  const binding = bindingFixture();
  const provisioning = provisioningFixture(binding);
  const cleanupPending = transition(binding, provisioning, {
    state: "cleanup_pending",
    cleanupPendingAt: TIMES.cleanup
  });
  assert.equal(cleanupPending.attemptId, ATTEMPT_ID);
  assert.equal(cleanupPending.provisioningAt, TIMES.provisioning);
  assert.deepEqual(cleanupPending.cleanupProvisioner, provisioning.provisioner);
  assert.equal(cleanupPending.provisioner, null);
  assert.equal(cleanupPending.leaseExpiresAt, null);
  assert.equal(Object.isFrozen(cleanupPending.cleanupProvisioner), true);
  const cleaned = transition(binding, cleanupPending, {
    state: "cleaned",
    cleanedAt: TIMES.cleaned
  });
  assert.equal(cleaned.attemptId, ATTEMPT_ID);
  assert.equal(cleaned.fence, 1);
  assert.deepEqual(cleaned.cleanupProvisioner, provisioning.provisioner);
  const failed = transition(binding, cleanupPending, {
    state: "failed",
    failedAt: TIMES.failed,
    error: { code: "E_CLEANUP", message: "Provisioner cleanup failed closed." }
  });
  assert.deepEqual(failed.cleanupProvisioner, provisioning.provisioner);
});

test("cleanup-pending reissue archives the prior attempt before a fresh fenced activation", () => {
  const binding = bindingFixture();
  const provisioning = provisioningFixture(binding);
  const cleanupPending = transition(binding, provisioning, {
    state: "cleanup_pending",
    cleanupPendingAt: TIMES.cleanup
  });
  const nextAttemptId = "d".repeat(32);
  const nextHolderId = "e".repeat(32);
  const archiveDigest = sha256("prior-attempt-archive");
  const reissuePlannedAt = "2026-07-24T12:00:04.500Z";
  const reissue = transition(binding, cleanupPending, {
    state: "reissue_planned",
    attemptId: nextAttemptId,
    fence: 2,
    reissuePlannedAt,
    priorAttemptArchiveDigest: archiveDigest
  });

  assert.equal(reissue.state, "reissue_planned");
  assert.equal(reissue.previousJournalDigest, cleanupPending.journalDigest);
  assert.equal(reissue.attemptId, nextAttemptId);
  assert.equal(reissue.fence, 2);
  assert.equal(reissue.provisioner, null);
  assert.equal(reissue.cleanupProvisioner, null);
  assert.equal(reissue.provisioningAt, null);
  assert.equal(reissue.cleanupPendingAt, null);
  assert.equal(reissue.reissuePlannedAt, reissuePlannedAt);
  assert.equal(reissue.priorAttemptArchiveDigest, archiveDigest);
  assert.equal(assertProvisioningJournal(binding, reissue), reissue);

  const reauthorized = transition(binding, reissue, {
    state: "reissue_planned",
    expectedCurrentJournalDigest: reissue.journalDigest
  });
  assert.equal(reauthorized.state, "reissue_planned");
  assert.equal(reauthorized.journalRevision, reissue.journalRevision + 1);
  assert.equal(reauthorized.previousJournalDigest, reissue.journalDigest);
  assert.equal(reauthorized.attemptId, reissue.attemptId);
  assert.equal(reauthorized.fence, reissue.fence);
  assert.equal(reauthorized.reissuePlannedAt, reissue.reissuePlannedAt);
  assert.equal(
    reauthorized.priorAttemptArchiveDigest,
    reissue.priorAttemptArchiveDigest
  );

  const activated = transition(binding, reauthorized, {
    state: "provisioning",
    actorAttemptId: nextAttemptId,
    actorFence: 2,
    provisioner: {
      pid: 84,
      startToken: "fresh-process-birth-token",
      holderId: nextHolderId
    },
    leaseExpiresAt: "2026-07-24T12:00:35.000Z",
    provisioningAt: "2026-07-24T12:00:05.000Z"
  });
  assert.equal(activated.state, "provisioning");
  assert.equal(activated.attemptId, nextAttemptId);
  assert.equal(activated.fence, 2);
  assert.equal(activated.previousJournalDigest, reauthorized.journalDigest);
  assert.equal(activated.reissuePlannedAt, reissuePlannedAt);
  assert.equal(activated.priorAttemptArchiveDigest, archiveDigest);
  assert.equal(assertProvisioningJournal(binding, activated), activated);

  for (const field of [
    "reissuePlannedAt",
    "priorAttemptArchiveDigest"
  ]) {
    const noncanonical = clone(activated);
    noncanonical[field] = undefined;
    redigestJournal(noncanonical);
    assertStateError(() => assertProvisioningJournal(binding, noncanonical));
  }

  assertStateError(() => transition(binding, cleanupPending, {
    state: "provisioning",
    attemptId: nextAttemptId,
    fence: 2,
    provisioner: {
      pid: 84,
      startToken: "fresh-process-birth-token",
      holderId: nextHolderId
    },
    leaseExpiresAt: "2026-07-24T12:00:35.000Z",
    provisioningAt: "2026-07-24T12:00:05.000Z"
  }));
  assertStateError(() => transition(binding, reauthorized, {
    state: "provisioning",
    actorAttemptId: ATTEMPT_ID,
    actorFence: 1,
    provisioner: {
      pid: 84,
      startToken: "fresh-process-birth-token",
      holderId: nextHolderId
    },
    leaseExpiresAt: "2026-07-24T12:00:35.000Z",
    provisioningAt: "2026-07-24T12:00:05.000Z"
  }));
});

test("host adoption returns cleanup-pending provisioning to ready with durable context", () => {
  const binding = bindingFixture();
  const provisioning = provisioningFixture(binding);
  const cleanupPending = transition(binding, provisioning, {
    state: "cleanup_pending",
    cleanupPendingAt: TIMES.cleanup
  });
  const ready = transition(binding, cleanupPending, {
    ...readyPatch(),
    readyAt: TIMES.cleanup
  });

  assert.equal(ready.state, "ready");
  assert.equal(ready.cleanupProvisioner, null);
  assert.equal(ready.cleanupPendingAt, null);
  assert.equal(ready.readyAt, TIMES.cleanup);
  assert.equal(ready.executionContextManifestId, readyPatch().executionContextManifestId);
  assert.equal(
    ready.executionContextManifestDigest,
    readyPatch().executionContextManifestDigest
  );
  assert.equal(ready.attemptId, cleanupPending.attemptId);
  assert.equal(ready.fence, cleanupPending.fence);
  assert.equal(ready.provisioningAt, cleanupPending.provisioningAt);
  assert.equal(ready.journalRevision, cleanupPending.journalRevision + 1);
  assert.equal(ready.previousJournalDigest, cleanupPending.journalDigest);
  assert.notEqual(ready.journalDigest, cleanupPending.journalDigest);
  assert.equal(assertProvisioningJournal(binding, ready), ready);
});

test("host adoption rejects stale, pre-cleanup, and malformed ready transitions", () => {
  const binding = bindingFixture();
  const provisioning = provisioningFixture(binding);
  const cleanupPending = transition(binding, provisioning, {
    state: "cleanup_pending",
    cleanupPendingAt: TIMES.cleanup
  });
  const valid = transitionRequest(cleanupPending, {
    ...readyPatch(),
    readyAt: TIMES.cleanup
  });

  assertStateError(() => transitionProvisioningJournal(binding, cleanupPending, {
    ...valid,
    expectedCurrentJournalDigest: sha256("stale-journal")
  }));
  assertStateError(() => transition(binding, cleanupPending, readyPatch()));

  for (const request of [
    { ...valid, actorAttemptId: cleanupPending.attemptId },
    { ...valid, cleanupPendingAt: cleanupPending.cleanupPendingAt },
    Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "readyAt")),
    Object.fromEntries(
      Object.entries(valid).filter(([key]) => key !== "executionContextManifestDigest")
    )
  ]) {
    assertStateError(() => transitionProvisioningJournal(binding, cleanupPending, request));
  }
});

test("active provisioning cannot fail without first retaining its cleanup process identity", () => {
  const binding = bindingFixture();
  const provisioning = provisioningFixture(binding);
  assertStateError(() => transition(binding, provisioning, {
    state: "failed",
    failedAt: TIMES.failed,
    error: { code: "E_WORKTREE", message: "Provisioning failed." }
  }));
  assert.equal(provisioning.state, "provisioning");
  assert.deepEqual(provisioning.provisioner, {
    pid: 42,
    startToken: "process-birth-token",
    holderId: HOLDER_ID
  });
  assert.equal(provisioning.cleanupProvisioner, null);

  const directFailure = clone(transition(binding, plannedFixture(binding), {
    state: "failed",
    failedAt: TIMES.failed,
    error: { code: "E_WORKTREE", message: "Pre-provisioning failure." }
  }));
  directFailure.attemptId = ATTEMPT_ID;
  directFailure.fence = 1;
  directFailure.provisioningAt = TIMES.provisioning;
  redigestJournal(directFailure);
  assertStateError(() => assertProvisioningJournal(binding, directFailure));
});

test("ready cancellation retains execution context through cleanup and cleanup failure", () => {
  const binding = bindingFixture();
  const ready = transition(
    binding,
    provisioningFixture(binding),
    readyPatch()
  );
  const cleanupPending = transition(binding, ready, {
    state: "cleanup_pending",
    cleanupPendingAt: TIMES.cleanup
  });
  assert.equal(cleanupPending.cleanupProvisioner, null);
  assert.equal(cleanupPending.readyAt, TIMES.ready);
  assert.equal(cleanupPending.executionContextManifestId, ready.executionContextManifestId);
  assert.equal(
    cleanupPending.executionContextManifestDigest,
    ready.executionContextManifestDigest
  );

  const cleaned = transition(binding, cleanupPending, {
    state: "cleaned",
    cleanedAt: TIMES.cleaned
  });
  assert.equal(cleaned.readyAt, TIMES.ready);
  assert.equal(cleaned.executionContextManifestId, ready.executionContextManifestId);

  const failed = transition(binding, cleanupPending, {
    state: "failed",
    failedAt: TIMES.failed,
    error: { code: "E_CLEANUP", message: "Ready worktree cleanup failed closed." }
  });
  assert.equal(failed.readyAt, TIMES.ready);
  assert.equal(failed.executionContextManifestDigest, ready.executionContextManifestDigest);
});

test("dead-owner provisioning can be reclaimed before lease expiry with a fresh monotonic fence", () => {
  const binding = bindingFixture();
  const current = provisioningFixture(binding);
  const valid = {
    expectedCurrentJournalDigest: current.journalDigest,
    priorAttemptId: current.attemptId,
    priorFence: current.fence,
    priorHolderId: current.provisioner.holderId,
    attemptId: "d".repeat(32),
    fence: 2,
    provisioner: {
      pid: 43,
      startToken: "replacement-process-birth-token",
      holderId: "e".repeat(32)
    },
    provisioningAt: "2026-07-24T12:00:03.000Z",
    leaseExpiresAt: "2026-07-24T12:01:03.000Z",
    reclaimEvidence: {
      kind: "process-dead",
      pid: current.provisioner.pid,
      startToken: current.provisioner.startToken,
      observedAt: "2026-07-24T12:00:02.500Z"
    }
  };
  const reclaimed = reclaimProvisioningJournal(binding, current, valid);
  assert.equal(reclaimed.state, "provisioning");
  assert.equal(reclaimed.attemptId, "d".repeat(32));
  assert.equal(reclaimed.fence, 2);
  assert.equal(reclaimed.journalRevision, current.journalRevision + 1);
  assert.equal(reclaimed.previousJournalDigest, current.journalDigest);
  assert.equal(reclaimed.executionContextManifestId, null);
  assert.equal(assertProvisioningJournal(binding, reclaimed), reclaimed);

  for (const patch of [
    { ...valid, expectedCurrentJournalDigest: sha256("stale") },
    { ...valid, priorAttemptId: "f".repeat(32) },
    { ...valid, priorFence: 0 },
    { ...valid, priorHolderId: "f".repeat(32) },
    { ...valid, attemptId: ATTEMPT_ID },
    { ...valid, fence: 1 },
    { ...valid, fence: 3 },
    { ...valid, provisioningAt: TIMES.planned },
    { ...valid, leaseExpiresAt: valid.provisioningAt },
    { ...valid, leaseExpiresAt: "2026-07-24T12:05:03.001Z" },
    { ...valid, provisioner: { ...valid.provisioner, holderId: HOLDER_ID } },
    {
      ...valid,
      reclaimEvidence: { ...valid.reclaimEvidence, pid: current.provisioner.pid + 1 }
    },
    {
      ...valid,
      reclaimEvidence: {
        ...valid.reclaimEvidence,
        startToken: "wrong-process-birth-token"
      }
    },
    {
      ...valid,
      reclaimEvidence: { ...valid.reclaimEvidence, observedAt: TIMES.planned }
    },
    { ...valid, extra: true }
  ]) {
    assertStateError(() => reclaimProvisioningJournal(binding, current, patch));
  }
  const ready = transition(binding, current, readyPatch());
  assertStateError(() => reclaimProvisioningJournal(binding, ready, valid));
});

test("lease-expiry reclaim requires observation at expiry and starts a new bounded lease", () => {
  const binding = bindingFixture();
  const current = provisioningFixture(binding);
  const base = {
    expectedCurrentJournalDigest: current.journalDigest,
    priorAttemptId: current.attemptId,
    priorFence: current.fence,
    priorHolderId: current.provisioner.holderId,
    attemptId: "d".repeat(32),
    fence: current.fence + 1,
    provisioner: {
      pid: 43,
      startToken: "replacement-process-birth-token",
      holderId: "e".repeat(32)
    },
    provisioningAt: "2026-07-24T12:00:32.001Z",
    leaseExpiresAt: "2026-07-24T12:01:32.001Z",
    reclaimEvidence: {
      kind: "lease-expired",
      observedAt: TIMES.lease
    }
  };
  const reclaimed = reclaimProvisioningJournal(binding, current, base);
  assert.equal(reclaimed.previousJournalDigest, current.journalDigest);
  assert.equal(reclaimed.journalRevision, current.journalRevision + 1);
  assert.equal("reclaimEvidence" in reclaimed, false);
  assertStateError(() => reclaimProvisioningJournal(binding, current, {
    ...base,
    reclaimEvidence: {
      kind: "lease-expired",
      observedAt: "2026-07-24T12:00:31.999Z"
    }
  }));
});

test("stale expected digests and stale provisioning actors cannot settle a reclaimed attempt", () => {
  const binding = bindingFixture();
  const first = provisioningFixture(binding);
  const latest = reclaimProvisioningJournal(binding, first, {
    expectedCurrentJournalDigest: first.journalDigest,
    priorAttemptId: first.attemptId,
    priorFence: first.fence,
    priorHolderId: first.provisioner.holderId,
    attemptId: "d".repeat(32),
    fence: 2,
    provisioner: {
      pid: 43,
      startToken: "replacement-process-birth-token",
      holderId: "e".repeat(32)
    },
    provisioningAt: "2026-07-24T12:00:03.000Z",
    leaseExpiresAt: "2026-07-24T12:01:03.000Z",
    reclaimEvidence: {
      kind: "process-dead",
      pid: first.provisioner.pid,
      startToken: first.provisioner.startToken,
      observedAt: "2026-07-24T12:00:02.500Z"
    }
  });
  const valid = transitionRequest(latest, readyPatch());
  for (const request of [
    { ...valid, expectedCurrentJournalDigest: first.journalDigest },
    { ...valid, actorAttemptId: first.attemptId },
    { ...valid, actorFence: first.fence },
    { ...valid, actorHolderId: first.provisioner.holderId }
  ]) {
    assertStateError(() => transitionProvisioningJournal(binding, latest, request));
  }

  const ready = transitionProvisioningJournal(binding, latest, valid);
  assert.equal(ready.state, "ready");
  assert.equal(ready.attemptId, latest.attemptId);
  assert.equal(ready.fence, latest.fence);
  assert.equal(ready.previousJournalDigest, latest.journalDigest);
  for (const field of [
    "expectedCurrentJournalDigest",
    "actorAttemptId",
    "actorFence",
    "actorHolderId"
  ]) {
    assert.equal(field in ready, false);
  }
});

test("edge-specific transition requests cannot rewrite prior journal evidence", () => {
  const binding = bindingFixture();
  const planned = plannedFixture(binding);
  const provisioning = provisioningFixture(binding, planned);
  const ready = transition(binding, provisioning, readyPatch());
  const cleanupPending = transition(binding, ready, {
    state: "cleanup_pending",
    cleanupPendingAt: TIMES.cleanup
  });

  for (const [current, patch] of [
    [planned, {
      state: "cleanup_pending",
      cleanupPendingAt: TIMES.cleanup,
      plannedAt: planned.plannedAt
    }],
    [provisioning, {
      ...readyPatch(),
      provisioningAt: provisioning.provisioningAt
    }],
    [ready, {
      state: "cleanup_pending",
      cleanupPendingAt: TIMES.cleanup,
      executionContextManifestDigest: ready.executionContextManifestDigest
    }],
    [cleanupPending, {
      state: "cleaned",
      cleanedAt: TIMES.cleaned,
      cleanupPendingAt: cleanupPending.cleanupPendingAt
    }]
  ]) {
    assertStateError(() => transition(binding, current, patch));
  }

  assertStateError(() => transitionProvisioningJournal(binding, planned, {
    state: "cleanup_pending",
    cleanupPendingAt: TIMES.cleanup
  }));
});

test("failure paths retain only bounded error evidence", () => {
  for (const fixture of [
    () => {
      const binding = bindingFixture();
      return {
        binding,
        journal: plannedFixture(binding),
        patch: {
          state: "failed",
          failedAt: TIMES.failed,
          error: { code: "E_WORKTREE", message: "Worktree provisioning failed." }
        }
      };
    },
    () => {
      const binding = bindingFixture();
      const cleanupPending = transition(binding, provisioningFixture(binding), {
        state: "cleanup_pending",
        cleanupPendingAt: TIMES.cleanup
      });
      return {
        binding,
        journal: cleanupPending,
        patch: {
          state: "failed",
          failedAt: TIMES.failed,
          error: { code: "E_CLEANUP", message: "Provisioner cleanup failed closed." }
        }
      };
    },
    () => {
      const binding = bindingFixture();
      const cleanupPending = transition(binding, plannedFixture(binding), {
        state: "cleanup_pending",
        cleanupPendingAt: TIMES.cleanup
      });
      return {
        binding,
        journal: cleanupPending,
        patch: {
          state: "failed",
          failedAt: TIMES.failed,
          error: { code: "E_CLEANUP", message: "Exact cleanup failed closed." }
        }
      };
    }
  ]) {
    const { binding, journal, patch } = fixture();
    const failed = transition(binding, journal, patch);
    assert.equal(failed.state, "failed");
    assert.equal(failed.error.code, patch.error.code);
    if (journal.cleanupProvisioner !== null) {
      assert.deepEqual(failed.cleanupProvisioner, journal.cleanupProvisioner);
    }
    assert.equal(assertProvisioningJournal(binding, failed), failed);
  }
});

test("binding input and durable shapes reject missing, extra, and raw owner fields", () => {
  for (const mutate of [
    (value) => { delete value.ownerDigest; },
    (value) => { value.owner = { sessionId: "raw-owner" }; },
    (value) => { value.cancellationNonceDigest = sha256(CANCELLATION_NONCE); }
  ]) {
    const input = bindingInput();
    mutate(input);
    assertStateError(() => createExecutionBinding(input));
  }

  const binding = clone(bindingFixture());
  binding.owner = { sessionId: "raw-owner" };
  assertStateError(() => assertExecutionBinding(binding));

  const nested = clone(bindingFixture());
  nested.scope.extra = [];
  assertStateError(() => assertExecutionBinding(nested));

  const parent = clone(bindingFixture());
  parent.parentFingerprint.extra = true;
  assertStateError(() => assertExecutionBinding(parent));
});

test("all binding digest fields and derived identities fail closed on tamper", () => {
  const digestFields = [
    "controlRootDigest",
    "gitCommonDirDigest",
    "parentFingerprintDigest",
    "expectedExecutionRootDigest",
    "scopeDigest",
    "envelopeDigest",
    "roleDigest",
    "profileDigest",
    "runtimeRolePolicyDigest",
    "admissionContextManifestDigest",
    "providerCapabilityDigest",
    "ownerDigest",
    "cancellationNonceDigest",
    "bindingDigest"
  ];
  for (const field of digestFields) {
    const binding = clone(bindingFixture());
    binding[field] = binding[field] === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
    assertStateError(() => assertExecutionBinding(binding));
  }

  for (const field of ["bindingId", "workerId", "controlWorkspaceId", "admissionContextManifestId"]) {
    const binding = clone(bindingFixture());
    binding[field] = `${binding[field]}x`;
    assertStateError(() => assertExecutionBinding(binding));
  }
});

test("canonical absolute roots reject relative, dot-segment, and control/execution alias paths", () => {
  for (const [field, value] of [
    ["controlRoot", "relative/control"],
    ["gitCommonDir", `${path.parse(process.cwd()).root}tmp${path.sep}..${path.sep}repo.git`],
    ["expectedExecutionRoot", `${path.resolve("execution-binding-fixture", "state")}${path.sep}..${path.sep}worktree`]
  ]) {
    const input = bindingInput({ [field]: value });
    assertStateError(() => createExecutionBinding(input));
  }

  const controlRoot = path.resolve("execution-binding-fixture", "control");
  assertStateError(() => createExecutionBinding(bindingInput({
    controlRoot,
    expectedExecutionRoot: controlRoot
  })));
  const gitCommonDir = path.resolve("execution-binding-fixture", "common.git");
  assertStateError(() => createExecutionBinding(bindingInput({
    gitCommonDir,
    expectedExecutionRoot: gitCommonDir
  })));
});

test("base and parent fingerprint validation rejects non-exact, mixed, dirty, or tampered identity", () => {
  for (const overrides of [
    { baseCommit: "A".repeat(40) },
    { baseCommit: "1".repeat(39) },
    { baseCommit: "1".repeat(64) },
    { parentFingerprint: parentFingerprint({ head: "9".repeat(40) }) },
    { parentFingerprint: parentFingerprint({ tree: "9".repeat(40) }) },
    { parentFingerprint: parentFingerprint({ clean: false, status: " M file" }) }
  ]) {
    assertStateError(() => createExecutionBinding(bindingInput(overrides)));
  }

  const badStatus = parentFingerprint();
  badStatus.statusDigest = sha256("forged");
  assertStateError(() => createExecutionBinding(bindingInput({ parentFingerprint: badStatus })));

  const badDigest = parentFingerprint();
  badDigest.fingerprintDigest = sha256("forged");
  assertStateError(() => createExecutionBinding(bindingInput({ parentFingerprint: badDigest })));
});

test("TaskEnvelope scope must remain exact, bounded, display-safe, and canonical", () => {
  for (const scope of [
    { include: [], exclude: [], extra: [] },
    { include: "plugins/**", exclude: [] },
    { include: Array.from({ length: 65 }, (_, index) => `path-${index}`), exclude: [] },
    { include: [` ${"a"}`], exclude: [] },
    { include: ["a".repeat(2_049)], exclude: [] },
    { include: ["\ud800"], exclude: [] },
    { include: ["password=top-secret-value"], exclude: [] }
  ]) {
    assertStateError(() => createExecutionBinding(bindingInput({ scope })));
  }
});

test("nullable provider capability is accepted but malformed digests are rejected", () => {
  assert.equal(bindingFixture({ providerCapabilityDigest: null }).providerCapabilityDigest, null);
  for (const field of [
    "envelopeDigest",
    "roleDigest",
    "profileDigest",
    "runtimeRolePolicyDigest",
    "admissionContextManifestDigest",
    "providerCapabilityDigest",
    "ownerDigest"
  ]) {
    assertStateError(() => createExecutionBinding(bindingInput({ [field]: "A".repeat(64) })));
  }
});

test("binding expected identity uses a bounded allowlist and exact values", () => {
  const binding = bindingFixture();
  assert.equal(assertExecutionBinding(binding, {
    workerId: binding.workerId,
    bindingDigest: binding.bindingDigest,
    scope: binding.scope
  }), binding);
  assertStateError(() => assertExecutionBinding(binding, { workerId: "task-ffffffffffffffff" }));
  assertStateError(() => assertExecutionBinding(binding, { owner: "raw-owner" }));
});

test("binding and journal timestamps must be canonical, safe, and monotonic", () => {
  for (const createdAt of [
    "2026-07-24T12:00:00Z",
    "not-a-timestamp",
    "275760-09-13T00:00:00.000Z"
  ]) {
    assertStateError(() => createExecutionBinding(bindingInput({ createdAt })));
  }

  const binding = bindingFixture();
  assertStateError(() => createProvisioningJournal({
    binding,
    cancellationNonce: CANCELLATION_NONCE,
    createdAt: "2026-07-24T11:59:59.999Z"
  }));
  assertStateError(() => createProvisioningJournal({
    binding,
    cancellationNonce: CANCELLATION_NONCE,
    createdAt: "2026-07-24T12:00:01Z"
  }));

  const planned = plannedFixture(binding);
  assertStateError(() => transition(binding, planned, {
    state: "provisioning",
    attemptId: ATTEMPT_ID,
    fence: 1,
    provisioner: { pid: 42, startToken: "token", holderId: HOLDER_ID },
    leaseExpiresAt: TIMES.lease,
    provisioningAt: TIMES.binding
  }));
});

test("journal binds the raw cancellation nonce without retaining it in the binding", () => {
  const binding = bindingFixture();
  assert.equal(binding.cancellationNonceDigest, sha256(CANCELLATION_NONCE));
  assert.equal(Object.values(binding).includes(CANCELLATION_NONCE), false);
  assertStateError(() => createProvisioningJournal({
    binding,
    cancellationNonce: "d".repeat(32),
    createdAt: TIMES.planned
  }));
  assertStateError(() => createExecutionBinding(bindingInput({
    cancellationNonce: "d".repeat(64)
  })));

  const journal = clone(plannedFixture(binding));
  journal.cancellationNonce = "d".repeat(32);
  assertStateError(() => assertProvisioningJournal(binding, journal));
});

test("public execution projection is immutable and exposes only digest-safe lifecycle state", () => {
  const binding = bindingFixture();
  const provisioning = provisioningFixture(binding);
  const journal = transition(binding, provisioning, {
    state: "cleanup_pending",
    cleanupPendingAt: TIMES.cleanup
  });
  const projection = createPublicExecutionProjection(binding, journal);
  assert.deepEqual(projection, {
    bindingDigest: binding.bindingDigest,
    cancellationNonceDigest: binding.cancellationNonceDigest,
    journalState: journal.state,
    journalRevision: journal.journalRevision,
    journalDigest: journal.journalDigest,
    previousJournalDigest: journal.previousJournalDigest,
    executionContextManifestDigest: null
  });
  assert.equal(Object.isFrozen(projection), true);

  const serialized = JSON.stringify(projection);
  for (const forbidden of [
    CANCELLATION_NONCE,
    binding.controlRoot,
    binding.gitCommonDir,
    binding.expectedExecutionRoot,
    binding.parentFingerprint.statusDigest,
    journal.cleanupProvisioner.startToken,
    journal.cleanupProvisioner.holderId,
    journal.plannedAt,
    journal.provisioningAt,
    "controlRoot",
    "gitCommonDir",
    "expectedExecutionRoot",
    "parentFingerprint",
    "provisioner",
    "cleanupProvisioner",
    "holderId",
    "plannedAt",
    "provisioningAt"
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("journal exact keys, binding, digest, and nested identities fail closed on tamper", () => {
  const binding = bindingFixture();
  for (const mutate of [
    (journal) => { delete journal.failedAt; },
    (journal) => { journal.owner = "raw-owner"; },
    (journal) => { journal.schemaVersion = 99; },
    (journal) => { journal.bindingDigest = sha256("foreign-binding"); },
    (journal) => { journal.journalDigest = sha256("forged-journal"); }
  ]) {
    const journal = clone(plannedFixture(binding));
    mutate(journal);
    assertStateError(() => assertProvisioningJournal(binding, journal));
  }

  const provisioning = clone(provisioningFixture(binding));
  provisioning.provisioner.extra = true;
  assertStateError(() => assertProvisioningJournal(binding, provisioning));
});

test("cleanup process identity exists only for cleanup entered from active provisioning", () => {
  const binding = bindingFixture();
  const provisioning = provisioningFixture(binding);
  const provisioningCleanup = transition(binding, provisioning, {
    state: "cleanup_pending",
    cleanupPendingAt: TIMES.cleanup
  });
  assert.deepEqual(provisioningCleanup.cleanupProvisioner, provisioning.provisioner);

  for (const mutate of [
    (journal) => { journal.cleanupProvisioner = null; },
    (journal) => { journal.cleanupProvisioner.extra = true; },
    (journal) => { journal.cleanupProvisioner.holderId = "f".repeat(31); }
  ]) {
    const journal = clone(provisioningCleanup);
    mutate(journal);
    redigestJournal(journal);
    assertStateError(() => assertProvisioningJournal(binding, journal));
  }

  const plannedCleanup = transition(binding, plannedFixture(binding), {
    state: "cleanup_pending",
    cleanupPendingAt: TIMES.cleanup
  });
  const ready = transition(binding, provisioningFixture(binding), readyPatch());
  const readyCleanup = transition(binding, ready, {
    state: "cleanup_pending",
    cleanupPendingAt: TIMES.cleanup
  });
  assert.equal(plannedCleanup.cleanupProvisioner, null);
  assert.equal(readyCleanup.cleanupProvisioner, null);

  for (const source of [plannedCleanup, readyCleanup, provisioning]) {
    const journal = clone(source);
    journal.cleanupProvisioner = {
      pid: 42,
      startToken: "invented-process-token",
      holderId: HOLDER_ID
    };
    redigestJournal(journal);
    assertStateError(() => assertProvisioningJournal(binding, journal));
  }
});

test("journal revisions and predecessor digests use exact bounded durable shapes", () => {
  const binding = bindingFixture();
  const planned = plannedFixture(binding);
  const provisioning = provisioningFixture(binding, planned);
  assert.equal(planned.journalRevision, 0);
  assert.equal(planned.previousJournalDigest, null);
  assert.equal(provisioning.journalRevision, 1);
  assert.equal(provisioning.previousJournalDigest, planned.journalDigest);

  for (const mutate of [
    (journal) => { journal.journalRevision = -1; },
    (journal) => { journal.journalRevision = 0.5; },
    (journal) => { journal.journalRevision = "1"; },
    (journal) => { journal.previousJournalDigest = "A".repeat(64); }
  ]) {
    const journal = clone(provisioning);
    mutate(journal);
    redigestJournal(journal);
    assertStateError(() => assertProvisioningJournal(binding, journal));
  }

  const fakeInitial = clone(planned);
  fakeInitial.journalRevision = 1;
  fakeInitial.previousJournalDigest = sha256("predecessor");
  redigestJournal(fakeInitial);
  assertStateError(() => assertProvisioningJournal(binding, fakeInitial));
});

test("provisioning requires one exact fenced attempt, process identity, and future lease", () => {
  const binding = bindingFixture();
  const planned = plannedFixture(binding);
  const valid = {
    state: "provisioning",
    attemptId: ATTEMPT_ID,
    fence: 1,
    provisioner: { pid: 42, startToken: "token", holderId: HOLDER_ID },
    leaseExpiresAt: TIMES.lease,
    provisioningAt: TIMES.provisioning
  };
  for (const patch of [
    { ...valid, attemptId: null },
    { ...valid, attemptId: "A".repeat(32) },
    { ...valid, fence: 0 },
    { ...valid, fence: 2 },
    { ...valid, provisioner: null },
    { ...valid, provisioner: { pid: 0, startToken: "token", holderId: HOLDER_ID } },
    { ...valid, provisioner: { pid: 42, startToken: "[REDACTED]", holderId: HOLDER_ID } },
    { ...valid, provisioner: { pid: 42, startToken: "token", holderId: "raw-owner" } },
    { ...valid, leaseExpiresAt: TIMES.provisioning },
    { ...valid, leaseExpiresAt: "2026-07-24T12:05:02.001Z" }
  ]) {
    assertStateError(() => transition(binding, planned, patch));
  }
});

test("ready requires exact context identity and cannot retain an active lease", () => {
  const binding = bindingFixture();
  const provisioning = provisioningFixture(binding);
  for (const patch of [
    { ...readyPatch(), executionContextManifestId: null },
    { ...readyPatch(), executionContextManifestDigest: "A".repeat(64) },
    { ...readyPatch(), provisioner: provisioning.provisioner },
    { ...readyPatch(), leaseExpiresAt: provisioning.leaseExpiresAt }
  ]) {
    assertStateError(() => transition(binding, provisioning, patch));
  }
});

test("only the specified monotonic state transitions are legal", () => {
  const binding = bindingFixture();
  const planned = plannedFixture(binding);
  const provisioning = provisioningFixture(binding, planned);
  const ready = transition(binding, provisioning, readyPatch());
  const cleanupPending = transition(binding, planned, {
    state: "cleanup_pending",
    cleanupPendingAt: TIMES.cleanup
  });
  const cleaned = transition(binding, cleanupPending, {
    state: "cleaned",
    cleanedAt: TIMES.cleaned
  });
  const failed = transition(binding, planned, {
    state: "failed",
    failedAt: TIMES.failed,
    error: { code: "E_WORKTREE", message: "Provisioning failed." }
  });

  for (const [journal, state] of [
    [planned, "ready"],
    [planned, "cleaned"],
    [provisioning, "planned"],
    [provisioning, "failed"],
    [ready, "failed"],
    [cleanupPending, "provisioning"],
    [cleaned, "failed"],
    [failed, "cleanup_pending"]
  ]) {
    assertStateError(() => transition(binding, journal, { state }));
  }
});

test("same-state transitions accept only the exact state-only idempotent request", () => {
  const binding = bindingFixture();
  const journal = plannedFixture(binding);
  assert.equal(transitionProvisioningJournal(binding, journal, { state: "planned" }), journal);
  assertStateError(() => transitionProvisioningJournal(binding, journal, {
    state: "planned",
    plannedAt: journal.plannedAt
  }));
  assertStateError(() => transitionProvisioningJournal(binding, journal, {
    state: "planned",
    failedAt: TIMES.failed
  }));
  assertStateError(() => transitionProvisioningJournal(binding, journal, {
    state: "planned",
    journalDigest: journal.journalDigest
  }));
});

test("state-specific nullability and timeline tampering are rejected even with a recomputed digest", () => {
  const binding = bindingFixture();
  const cases = [
    ["planned", (journal) => { journal.failedAt = TIMES.failed; }],
    ["provisioning", (journal) => { journal.leaseExpiresAt = TIMES.provisioning; }],
    ["ready", (journal) => { journal.readyAt = TIMES.binding; }],
    ["cleanup", (journal) => { journal.cleanupPendingAt = TIMES.binding; }]
  ];
  for (const [kind, mutate] of cases) {
    let journal;
    if (kind === "planned") journal = clone(plannedFixture(binding));
    if (kind === "provisioning") journal = clone(provisioningFixture(binding));
    if (kind === "ready") {
      journal = clone(transition(
        binding,
        provisioningFixture(binding),
        readyPatch()
      ));
    }
    if (kind === "cleanup") {
      journal = clone(transition(binding, plannedFixture(binding), {
        state: "cleanup_pending",
        cleanupPendingAt: TIMES.cleanup
      }));
    }
    mutate(journal);
    const unsigned = Object.fromEntries(
      Object.entries(journal).filter(([key]) => key !== "journalDigest")
    );
    journal.journalDigest = sha256(unsigned);
    assertStateError(() => assertProvisioningJournal(binding, journal));
  }
});

test("failed journal chronology cannot place failure before retained ready evidence", () => {
  const binding = bindingFixture();
  const ready = transition(binding, provisioningFixture(binding), readyPatch());
  const cleanupPending = transition(binding, ready, {
    state: "cleanup_pending",
    cleanupPendingAt: TIMES.cleanup
  });
  const failed = transition(binding, cleanupPending, {
    state: "failed",
    failedAt: TIMES.failed,
    error: { code: "E_CLEANUP", message: "Ready cleanup failed." }
  });
  const forged = clone(failed);
  forged.readyAt = "2026-07-24T12:00:07.000Z";
  redigestJournal(forged);
  assertStateError(() => assertProvisioningJournal(binding, forged));
});

test("failed state enforces exact bounded display-safe errors", () => {
  const binding = bindingFixture();
  const planned = plannedFixture(binding);
  const base = {
    state: "failed",
    failedAt: TIMES.failed
  };
  for (const error of [
    null,
    { code: "WORKTREE", message: "Failed." },
    { code: "E_", message: "Failed." },
    { code: `E_${"A".repeat(64)}`, message: "Failed." },
    { code: "E_WORKTREE", message: "" },
    { code: "E_WORKTREE", message: " Failed." },
    { code: "E_WORKTREE", message: "a".repeat(1_025) },
    { code: "E_WORKTREE", message: "\ud800" },
    { code: "E_WORKTREE", message: "password=top-secret-value" },
    { code: "E_WORKTREE", message: "Failed.", details: "not-allowed" }
  ]) {
    assertStateError(() => transition(binding, planned, {
      ...base,
      error
    }));
  }
});
