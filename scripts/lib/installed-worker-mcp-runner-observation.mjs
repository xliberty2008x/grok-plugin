// Installed Worker MCP qualification domain. Keep import-time behavior inert.
import { validateInstalledTerminalEventHistory } from "./installed-worker-mcp-contract.mjs";
import { boundedString, CANONICAL_UUID, canonicalDigest, canonicalJson, checkInterrupted, enterQualificationStage, fail, hasExactKeys, isPlainRecord, MAX_TERMINAL_LIFECYCLE_EVENTS, sameJson, SCENARIO_TIMEOUT_MS, STATE_POLL_MS, validStringList } from "./installed-worker-mcp-runner-core.mjs";
import { callTool } from "./installed-worker-mcp-runner-runtime.mjs";
import crypto from "node:crypto";
import fs from "node:fs";

export function enterScenarioStage(tracker, suffix) {
  const prefix = tracker.scenarioId === "authenticated-completion"
    ? "completion"
    : tracker.scenarioId === "mcp-restart-reconnect-cancellation"
      ? "cancellation"
      : null;
  if (prefix === null) throw new Error("Unknown installed Worker MCP scenario.");
  enterQualificationStage(`${prefix}-${suffix}`);
}

export const PUBLIC_EVENT_TYPES = new Set([
  "task.accepted",
  "plan.updated",
  "activity.started",
  "activity.completed",
  "checkpoint",
  "blocked",
  "final.report",
  "cancellation.requested"
]);
export const EVENT_KEYS = new Set([
  "workerProtocolVersion",
  "eventSchemaVersion",
  "type",
  "at",
  "summary",
  "sequence"
]);
export const EVENT_DETAIL_KEYS = new Set([
  "envelopeId",
  "resumeJobId",
  "spawnSuccessDefinition",
  "requestAcceptedAt",
  "reconciler",
  "messageId",
  "contentDigest",
  "parentWorkerId",
  "version",
  "name",
  "status",
  "mode",
  "state",
  "eventType",
  "verdict",
  "outcome",
  "hostVerification",
  "authority",
  "write",
  "replayedPrompt",
  "structured",
  "exitCode",
  "findings",
  "commands",
  "plan",
  "questions",
  "validationIssues",
  "observedChangedPaths"
]);
export const CURSOR_KEYS = new Set(["schemaVersion", "workerId", "sequence"]);
export const STREAM_KEYS = new Set([
  "workerProtocolVersion",
  "eventCursorSchemaVersion",
  "events",
  "nextCursor",
  "firstAvailableCursor",
  "firstAvailableSequence",
  "latestAvailableSequence",
  "gap",
  "terminal",
  "workerId",
  "latestAvailableCursor"
]);

export function validateLifecycleDetail(detail) {
  if (
    !isPlainRecord(detail)
    || Object.keys(detail).length < 1
    || Object.keys(detail).length > EVENT_DETAIL_KEYS.size
    || Object.keys(detail).some((key) => !EVENT_DETAIL_KEYS.has(key))
    || Buffer.byteLength(JSON.stringify(detail), "utf8") > 64 * 1024
  ) {
    fail("E_PRIVATE_STATE");
  }
  const textLimits = {
    envelopeId: 256,
    resumeJobId: 256,
    spawnSuccessDefinition: 1000,
    requestAcceptedAt: 64,
    reconciler: 128,
    messageId: 256,
    contentDigest: 256,
    parentWorkerId: 256,
    version: 128,
    name: 300,
    status: 80
  };
  for (const [key, limit] of Object.entries(textLimits)) {
    if (Object.hasOwn(detail, key) && !boundedString(detail[key], limit)) {
      fail("E_PRIVATE_STATE");
    }
  }
  if (
    Object.hasOwn(detail, "requestAcceptedAt")
    && !canonicalTimestamp(detail.requestAcceptedAt)
  ) {
    fail("E_PRIVATE_STATE");
  }
  const enums = {
    mode: new Set(["read", "write"]),
    state: new Set(["accepted", "pending", "delivered", "delivery_unknown", "rejected"]),
    eventType: new Set(["tool", "plan", "message"]),
    verdict: new Set(["pass", "needs_changes"]),
    outcome: new Set(["complete", "partial", "blocked"]),
    hostVerification: new Set(["not_run", "passed", "failed", "skipped"]),
    authority: new Set(["host_asserted"])
  };
  for (const [key, allowed] of Object.entries(enums)) {
    if (Object.hasOwn(detail, key) && !allowed.has(detail[key])) {
      fail("E_PRIVATE_STATE");
    }
  }
  for (const key of ["write", "replayedPrompt", "structured"]) {
    if (Object.hasOwn(detail, key) && typeof detail[key] !== "boolean") {
      fail("E_PRIVATE_STATE");
    }
  }
  for (const key of ["exitCode", "findings", "commands"]) {
    if (
      Object.hasOwn(detail, key)
      && (
        !Number.isSafeInteger(detail[key])
        || (key !== "exitCode" && detail[key] < 0)
      )
    ) {
      fail("E_PRIVATE_STATE");
    }
  }
  for (const [key, maximumItems, maximumLength] of [
    ["plan", 20, 500],
    ["questions", 64, 2000],
    ["validationIssues", 200, 2000],
    ["observedChangedPaths", 200, 2000]
  ]) {
    if (
      Object.hasOwn(detail, key)
      && !validStringList(detail[key], { maximumItems, maximumLength })
    ) {
      fail("E_PRIVATE_STATE");
    }
  }
}

export function validateLifecycleEvent(event) {
  const expectedKeys = new Set(EVENT_KEYS);
  if (Object.hasOwn(event || {}, "detail")) expectedKeys.add("detail");
  if (
    !hasExactKeys(event, expectedKeys)
    || event.workerProtocolVersion !== 1
    || event.eventSchemaVersion !== 1
    || !PUBLIC_EVENT_TYPES.has(event.type)
    || !canonicalTimestamp(event.at)
    || !boundedString(event.summary, 2000, { nonempty: true })
    || !Number.isSafeInteger(event.sequence)
    || event.sequence < 1
  ) {
    fail("E_PRIVATE_STATE");
  }
  if (Object.hasOwn(event, "detail")) validateLifecycleDetail(event.detail);
}

export function validateCursor(cursor, expectedWorkerId) {
  if (
    !hasExactKeys(cursor, CURSOR_KEYS)
    || cursor.schemaVersion !== 1
    || cursor.workerId !== expectedWorkerId
    || !Number.isSafeInteger(cursor.sequence)
    || cursor.sequence < 0
  ) {
    fail("E_PRIVATE_STATE");
  }
  return cursor.sequence;
}

export function orderedEventObserver() {
  const events = new Map();
  let maximum = 0;
  return {
    observe(values) {
      if (!Array.isArray(values)) fail("E_PRIVATE_STATE");
      let previous = 0;
      for (const event of values) {
        validateLifecycleEvent(event);
        const sequence = event?.sequence;
        if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence <= previous) {
          fail("E_PRIVATE_STATE");
        }
        previous = sequence;
        const serialized = JSON.stringify(canonicalJson(event));
        if (events.has(sequence) && events.get(sequence) !== serialized) {
          fail("E_PRIVATE_STATE");
        }
        if (!events.has(sequence)) {
          if (sequence !== maximum + 1) fail("E_PRIVATE_STATE");
          events.set(sequence, serialized);
          maximum = sequence;
        }
      }
    },
    snapshot() {
      return [...events.entries()].map(([sequence, serialized]) => ({
        sequence,
        value: JSON.parse(serialized)
      }));
    },
    values() {
      return [...events.values()].map((serialized) => JSON.parse(serialized));
    },
    maximum() {
      return maximum;
    }
  };
}

export function observeStream(
  observer,
  stream,
  expectedWorkerId,
  { wait = false, cursor = null } = {}
) {
  const expectedKeys = new Set(STREAM_KEYS);
  if (wait) expectedKeys.add("timedOut");
  const requestedSequence = cursor == null
    ? 0
    : validateCursor(cursor, expectedWorkerId);
  if (
    !hasExactKeys(stream, expectedKeys)
    || stream.workerProtocolVersion !== 1
    || stream.eventCursorSchemaVersion !== 1
    || stream.workerId !== expectedWorkerId
    || stream.gap !== false
    || typeof stream.terminal !== "boolean"
    || (wait && typeof stream.timedOut !== "boolean")
    || (wait && stream.terminal && stream.timedOut)
    || (
      stream.firstAvailableSequence !== null
      && (
        !Number.isSafeInteger(stream.firstAvailableSequence)
        || stream.firstAvailableSequence < 1
      )
    )
    || !Number.isSafeInteger(stream.latestAvailableSequence)
    || stream.latestAvailableSequence < 0
    || (
      stream.firstAvailableSequence === null
        ? stream.latestAvailableSequence !== 0
        : stream.firstAvailableSequence > stream.latestAvailableSequence
    )
  ) {
    fail("E_PRIVATE_STATE");
  }
  const nextSequence = validateCursor(stream.nextCursor, expectedWorkerId);
  const firstCursorSequence = validateCursor(
    stream.firstAvailableCursor,
    expectedWorkerId
  );
  const latestCursorSequence = validateCursor(
    stream.latestAvailableCursor,
    expectedWorkerId
  );
  if (
    firstCursorSequence !== (
      stream.firstAvailableSequence === null
        ? 0
        : Math.max(0, stream.firstAvailableSequence - 1)
    )
    || latestCursorSequence !== stream.latestAvailableSequence
    || requestedSequence > stream.latestAvailableSequence
    || !Array.isArray(stream.events)
  ) {
    fail("E_PRIVATE_STATE");
  }
  if (
    wait
    && stream.timedOut !== (
      stream.terminal === false
      && stream.events.length === 0
    )
  ) {
    fail("E_PRIVATE_STATE");
  }
  let prior = requestedSequence;
  for (const event of stream.events) {
    validateLifecycleEvent(event);
    if (
      event.sequence !== prior + 1
      || event.sequence > stream.latestAvailableSequence
    ) {
      fail("E_PRIVATE_STATE");
    }
    prior = event.sequence;
  }
  if (
    nextSequence !== prior
    || (
      stream.events.length === 0
      && stream.latestAvailableSequence !== requestedSequence
    )
    || (
      stream.events.length > 0
      && prior !== stream.latestAvailableSequence
    )
  ) {
    fail("E_PRIVATE_STATE");
  }
  observer.observe(stream.events);
  return stream.nextCursor;
}

export function hostTaskBindingFor(job) {
  return `host-task-${crypto
    .createHash("sha256")
    .update([job?.host?.kind, job?.host?.sessionId].join("\0"))
    .digest("hex")
    .slice(0, 32)}`;
}

export function immutablePrivateBinding(job) {
  const request = job?.request;
  const packet = request?.contextPacket;
  const policy = request?.runtimeRolePolicy;
  const receipt = request?.contextReceipt;
  if (
    request?.contextBindingMode !== "context-receipt-v1"
    || request?.providerHomeId !== job?.id
    || !isPlainRecord(packet)
    || !isPlainRecord(policy)
    || !isPlainRecord(receipt)
    || packet.packetId !== receipt.packetId
    || packet.digest !== receipt.packetDigest
    || packet.truncated !== false
    || packet.hiddenRecordsExported !== false
    || !Array.isArray(packet.facts)
    || !Array.isArray(packet.constraints)
    || receipt.factCount !== packet.facts.length
    || receipt.factsDigest !== canonicalDigest(packet.facts)
    || receipt.constraintCount !== packet.constraints.length
    || receipt.constraintsDigest !== canonicalDigest(packet.constraints)
    || receipt.rolePolicyDigest !== policy.digest
    || receipt.logicalRoleId !== policy.logicalRoleId
    || receipt.roleDigest !== policy.roleDigest
    || receipt.providerProfileId !== policy.providerProfileId
    || receipt.providerProfileVersion !== policy.providerProfileVersion
    || receipt.agentProfileDigest !== policy.agentProfileDigest
    || receipt.allowedProviderToolIdsDigest
      !== canonicalDigest(policy.allowedProviderToolIds)
    || receipt.deniedProviderToolIdsDigest
      !== canonicalDigest(policy.deniedProviderToolIds)
    || receipt.lineageWorkerId !== job.id
    || receipt.contextManifestId !== request.contextManifest?.manifestId
    || receipt.contextManifestDigest !== request.contextManifest?.digest
    || receipt.effectivePromptDigest !== request.providerPromptDigest
    || receipt.provenance?.envelopeId !== request.envelope?.envelopeId
    || receipt.provenance?.envelopeDigest !== request.envelope?.digest
    || policy.logicalRoleId !== job.role?.id
    || policy.providerProfileId !== job.profile?.id
    || policy.providerProfileVersion !== job.profile?.contractVersion
    || policy.agentProfileDigest !== job.profile?.agentProfileDigest
  ) {
    fail("E_PRIVATE_STATE");
  }
  return {
    workerId: job?.id,
    createdAt: job?.createdAt,
    model: job?.model ?? null,
    effort: job?.effort ?? null,
    securityProfile: {
      id: job?.profile?.id,
      contractVersion: job?.profile?.contractVersion,
      agentProfileDigest: job?.profile?.agentProfileDigest
    },
    taskEnvelopeId: job?.request?.envelope?.envelopeId,
    taskEnvelopeDigest: job?.request?.envelope?.digest,
    contextManifestId: job?.request?.contextManifest?.manifestId,
    contextDigest: job?.request?.contextManifest?.digest,
    workspaceSnapshotDigest: job?.request?.contextManifest?.digest,
    lineageWorkerId: job?.request?.providerHomeId,
    controlWorkspaceId: job?.controlWorkspaceId,
    hostTaskBinding: hostTaskBindingFor(job),
    ownerThreadId: job?.request?.spawn?.ownerThreadId,
    requestDigest: job?.request?.spawn?.requestDigest,
    idempotencyKeyDigest: job?.request?.spawn?.idempotencyKeyDigest,
    providerCapabilityDigest: job?.request?.spawn?.providerCapabilityDigest,
    providerLaunchBindingDigest:
      job?.request?.spawn?.providerLaunchBindingDigest,
    providerExecutableIdentityDigest:
      job?.request?.spawn?.providerLaunchBinding?.executableIdentityDigest
  };
}

export function observeIdentity(tracker, kind, identity, processModule, workerId) {
  if (identity == null) return;
  try {
    processModule.assertCompleteDetachedOwnedIdentity(identity);
  } catch {
    fail("E_PRIVATE_STATE");
  }
  if (
    identity.commandMarker !== workerId
    || identity.processGroupId !== identity.pid
  ) {
    fail("E_PRIVATE_STATE");
  }
  if (kind === "provider") {
    if (identity.providerGeneration !== 1) fail("E_PRIVATE_STATE");
  }
  const existing = tracker.processIdentities.get(kind);
  if (existing && !sameJson(existing, identity)) fail("E_PRIVATE_STATE");
  if (!existing) tracker.processIdentities.set(kind, structuredClone(identity));
}

export function canonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function assertProviderPinPersistence(context, job, {
  guard = null,
  requireCurrentIntent = false,
  requirePrimaryTurnAdmissions = false,
  requireWorktreeIntent = false
} = {}) {
  const binding = context.providerLaunchBinding;
  const bindingDigest = context.providerLaunchBindingDigest;
  const executableIdentityDigest = context.providerExecutableIdentityDigest;
  const spawn = job?.request?.spawn;
  if (
    !binding
    || binding.executableIdentityDigest !== executableIdentityDigest
    || spawn?.providerLaunchBindingDigest !== bindingDigest
    || !sameJson(spawn?.providerLaunchBinding, binding)
  ) {
    fail("E_PRIVATE_STATE");
  }

  const currentIntent = spawn.providerSpawnIntent;
  if (requireCurrentIntent || currentIntent != null) {
    if (
      currentIntent?.providerLaunchBindingDigest !== bindingDigest
      || !sameJson(currentIntent?.providerLaunchBinding, binding)
    ) {
      fail("E_PRIVATE_STATE");
    }
  }

  const admissions = spawn.primaryTurnAdmissions;
  if (requirePrimaryTurnAdmissions || admissions != null) {
    if (
      !isPlainRecord(admissions)
      || Object.keys(admissions).length < 1
      || Object.values(admissions).some((admission) => (
        admission?.providerLaunchBindingDigest !== bindingDigest
        || admission?.providerExecutableIdentityDigest
          !== executableIdentityDigest
      ))
    ) {
      fail("E_PRIVATE_STATE");
    }
  }

  if (job.write === true) {
    if (
      job.executionBinding?.providerLaunchBindingDigest !== bindingDigest
    ) {
      fail("E_PRIVATE_STATE");
    }
    const worktreeIntent = job.provisioningRuntime?.intent;
    if (requireWorktreeIntent || worktreeIntent != null) {
      if (
        worktreeIntent?.providerLaunchBindingDigest !== bindingDigest
        || !sameJson(worktreeIntent?.providerLaunchBinding, binding)
        || worktreeIntent?.executableIdentity?.identityDigest
          !== executableIdentityDigest
        || worktreeIntent?.executableIdentity?.releaseIdentityDigest
          !== binding.releaseIdentityDigest
      ) {
        fail("E_PRIVATE_STATE");
      }
    }
  }

  if (
    guard != null
    && (
      guard.providerLaunchBindingDigest !== bindingDigest
      || guard.providerExecutableIdentityDigest !== executableIdentityDigest
    )
  ) {
    fail("E_PRIVATE_STATE");
  }
  return true;
}

export function observeProviderDispatchEvidence(tracker, job) {
  const spawn = job.request?.spawn;
  const dispatch = spawn?.dispatch;
  if (dispatch?.state !== "provider-started") return;
  const providerIntent = spawn?.providerSpawnIntent;
  if (
    dispatch.providerGeneration !== 1
    || dispatch.nextProviderGeneration !== null
    || !canonicalTimestamp(dispatch.providerStartedAt)
    || !canonicalTimestamp(dispatch.controllerStartedAt)
    || !canonicalTimestamp(dispatch.workerStartedAt)
    || Object.hasOwn(dispatch, "providerRotationCount")
    || Object.hasOwn(dispatch, "providerRotatedAt")
    || Object.hasOwn(dispatch, "providerRotationAuthorizedAt")
    || spawn.providerRotationIntent != null
    || providerIntent?.providerGeneration !== 1
    || providerIntent?.status !== "registered"
    || job.providerProcess?.providerGeneration !== 1
    || spawn.providerLaunchPending !== false
    || spawn.providerLaunchInFlight !== false
    || spawn.providerLaunchOutcome !== "launched"
  ) {
    fail("E_PRIVATE_STATE");
  }
  for (const identity of [
    job.controllerProcess,
    job.workerProcess,
    job.providerProcess
  ]) {
    if (
      identity?.dispatchAttemptId !== dispatch.attemptId
      || identity?.dispatchFence !== dispatch.fence
    ) {
      fail("E_PRIVATE_STATE");
    }
  }
  tracker.providerStartEvidence.add([
    dispatch.providerGeneration,
    dispatch.providerStartedAt,
    job.providerProcess.pid,
    job.providerProcess.startToken
  ].join(":"));
  if (tracker.providerStartEvidence.size !== 1) fail("E_PRIVATE_STATE");
}

export function observePrivateJob(context, tracker, job, {
  requireLiveProvider = false,
  recordProviderObservation = false
} = {}) {
  if (!job || job.id !== tracker.workerId) fail("E_PRIVATE_STATE");
  try {
    context.mutation.assertDispatchContract(job);
    context.mutation.assertDurableSpawnRequestBinding(job, context.env);
  } catch {
    fail("E_PRIVATE_STATE");
  }
  let executionRoot;
  try {
    executionRoot = fs.realpathSync(context.fixtureRoot);
  } catch {
    fail("E_PRIVATE_STATE");
  }
  const expectedSpawnKeyDigest = tracker.spawnIdempotencyKey
    ? crypto.createHash("sha256").update(tracker.spawnIdempotencyKey).digest("hex")
    : null;
  if (
    job.host?.kind !== "codex"
    || job.host?.sessionId !== context.threadId
    || job.request?.spawn?.ownerThreadId !== context.threadId
    || job.request?.spawn?.executionRoot !== executionRoot
    || job.request?.spawn?.providerCapabilityDigest
      !== context.providerCapability.capabilityDigest
    || job.request?.roleId !== "explorer"
    || job.role?.id !== "explorer"
    || job.write !== false
    || (
      expectedSpawnKeyDigest !== null
      && job.request?.spawn?.idempotencyKeyDigest !== expectedSpawnKeyDigest
    )
  ) {
    fail("E_PRIVATE_STATE");
  }
  assertProviderPinPersistence(context, job, {
    requireCurrentIntent:
      job.request?.spawn?.providerLaunchOutcome === "launched"
  });
  const binding = immutablePrivateBinding(job);
  if (
    !canonicalTimestamp(binding.createdAt)
    || !nullableBounded(binding.model, 256)
    || !nullableBounded(binding.effort, 128)
    || !hasExactKeys(
      binding.securityProfile,
      new Set(["id", "contractVersion", "agentProfileDigest"])
    )
    || binding.securityProfile.id !== "rescue-read-v3"
    || binding.securityProfile.contractVersion !== 3
    || !/^[0-9a-f]{64}$/.test(
      binding.securityProfile.agentProfileDigest || ""
    )
  ) {
    fail("E_PRIVATE_STATE");
  }
  if (tracker.privateBinding && !sameJson(tracker.privateBinding, binding)) {
    fail("E_PRIVATE_STATE");
  }
  tracker.privateBinding ||= structuredClone(binding);
  tracker.latestJob = job;
  observeIdentity(tracker, "controller", job.controllerProcess, context.processControl, job.id);
  observeIdentity(tracker, "worker", job.workerProcess, context.processControl, job.id);
  observeIdentity(tracker, "provider", job.providerProcess, context.processControl, job.id);
  observeProviderDispatchEvidence(tracker, job);
  if (job.grokSessionId != null) {
    if (!CANONICAL_UUID.test(job.grokSessionId)) fail("E_PRIVATE_STATE");
    if (tracker.sessionId && tracker.sessionId !== job.grokSessionId) {
      fail("E_PRIVATE_STATE");
    }
    tracker.sessionId = job.grokSessionId;
    if (!context.runner.sessions.has(job.grokSessionId)) {
      context.runner.sessions.set(job.grokSessionId, null);
    }
  }
  if (job.providerProcess) {
    const generation = job.providerProcess.providerGeneration;
    if (generation !== 1) fail("E_PRIVATE_STATE");
    tracker.providerGeneration = generation;
    if (recordProviderObservation) {
      tracker.observedProviderGenerations.push(generation);
      tracker.observedProviderWorkerIds.push(job.id);
    }
  }
  if (requireLiveProvider) {
    const requiredKinds = ["controller", "worker", "provider"];
    if (requiredKinds.some((kind) => !tracker.processIdentities.has(kind))) {
      fail("E_PRIVATE_STATE");
    }
    if (
      context.processControl.processGroupGone(tracker.processIdentities.get("worker"))
      || context.processControl.processGroupGone(tracker.processIdentities.get("provider"))
    ) {
      fail("E_PRIVATE_STATE");
    }
    let guard;
    try {
      guard = context.guard.loadProviderGuard(context.fixtureRoot, job.id);
      context.guard.assertProviderGuardForJob(
        context.fixtureRoot,
        job,
        guard,
        { expectedGeneration: 1 }
      );
    } catch {
      fail("E_PRIVATE_STATE");
    }
    if (
      !guard
      || !context.guard.sameGuardProcessIdentity(
        guard.providerProcess,
        job.providerProcess
      )
    ) {
      fail("E_PRIVATE_STATE");
    }
    assertProviderPinPersistence(context, job, {
      guard,
      requireCurrentIntent: true
    });
    tracker.authenticatedGuard = structuredClone(guard);
  }
  return job;
}

export function readPrivateJob(context, tracker, options = {}) {
  let job;
  try {
    job = context.state.tryReadJob(
      context.fixtureRoot,
      tracker.workerId,
      context.env
    );
  } catch {
    fail("E_PRIVATE_STATE");
  }
  return observePrivateJob(context, tracker, job, options);
}

export async function pollPrivateJob(context, tracker, predicate, {
  timeoutMs = 60_000,
  requireLiveProvider = false,
  recordProviderObservation = false
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    checkInterrupted(context.runner);
    let job = null;
    try {
      job = context.state.tryReadJob(
        context.fixtureRoot,
        tracker.workerId,
        context.env
      );
      if (job && predicate(job)) {
        return observePrivateJob(context, tracker, job, {
          requireLiveProvider,
          recordProviderObservation
        });
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, STATE_POLL_MS));
  }
  fail("E_PRIVATE_STATE");
}

export function observePublicWorker(tracker, worker, { observeEvents = true } = {}) {
  if (!worker || worker.id !== tracker.workerId) fail("E_SCENARIO");
  tracker.publicWorkers.push(structuredClone(worker));
  if (observeEvents && Array.isArray(worker.lifecycleEvents)) {
    tracker.events.observe(worker.lifecycleEvents);
  }
}

export function observeTerminalResultWorker(tracker, worker, terminalStreamCursor) {
  if (!worker || worker.id !== tracker.workerId) fail("E_SCENARIO");
  const trackedEvents = tracker.events.values();
  const cursorSequence = validateCursor(worker.eventCursor, tracker.workerId);
  const streamCursorSequence = validateCursor(
    terminalStreamCursor,
    tracker.workerId
  );
  const expectedLength = Math.min(
    MAX_TERMINAL_LIFECYCLE_EVENTS,
    cursorSequence
  );
  if (
    !Array.isArray(worker.lifecycleEvents)
    || expectedLength < 1
    || streamCursorSequence !== cursorSequence
    || trackedEvents.length !== cursorSequence
    || trackedEvents[0]?.sequence !== 1
    || trackedEvents.at(-1)?.sequence !== cursorSequence
    || worker.lifecycleEvents.length !== expectedLength
    || worker.lifecycleEvents[0]?.sequence
      !== cursorSequence - expectedLength + 1
    || !sameJson(
      trackedEvents.slice(-expectedLength),
      worker.lifecycleEvents
    )
  ) {
    fail("E_PRIVATE_STATE");
  }
  observePublicWorker(tracker, worker, { observeEvents: false });
}

export const SNAPSHOT_KEYS = new Set([
  "workerProtocolVersion",
  "snapshotSchemaVersion",
  "schemaVersion",
  "id",
  "kind",
  "jobClass",
  "write",
  "status",
  "phase",
  "summary",
  "progress",
  "createdAt",
  "startedAt",
  "updatedAt",
  "completedAt",
  "heartbeatAt",
  "profileId",
  "model",
  "effort",
  "parentWorkerId",
  "lineageWorkerId",
  "eventCursor",
  "taskEnvelopeId",
  "taskEnvelopeDigest",
  "contextManifestId",
  "contextDigest",
  "workspaceSnapshotDigest",
  "hostTaskBinding",
  "securityProfile",
  "latestPlan",
  "lifecycleEvents",
  "taskContract",
  "contextBindingMode",
  "contextReceipt",
  "context",
  "resumeJobId",
  "result",
  "error",
  "controlWorkspaceId",
  "roleId",
  "externalWorkerLabel",
  "awaitingHostAction",
  "terminal"
]);
export const HANDLE_KEYS = new Set([
  "workerProtocolVersion",
  "handleSchemaVersion",
  "id",
  "kind",
  "jobClass",
  "write",
  "status",
  "phase",
  "summary",
  "progress",
  "createdAt",
  "startedAt",
  "updatedAt",
  "completedAt",
  "heartbeatAt",
  "profileId",
  "model",
  "effort",
  "parentWorkerId",
  "lineageWorkerId",
  "eventCursor",
  "taskEnvelopeId",
  "taskEnvelopeDigest",
  "contextManifestId",
  "contextDigest",
  "workspaceSnapshotDigest",
  "hostTaskBinding",
  "securityProfile",
  "controlWorkspaceId",
  "roleId",
  "externalWorkerLabel",
  "terminal"
]);
export const ACTIVE_REPLAY_PHASES = new Set([
  "starting",
  "creating-session",
  "prompting",
  "planning",
  "executing",
  "responding",
  "finalizing"
]);
export const SPAWN_IDEMPOTENCY_RECORD_KEYS = new Set([
  "schemaVersion",
  "workerId",
  "owner",
  "controlWorkspaceId",
  "executionRoot",
  "requestDigest",
  "launchContractDigest",
  "idempotencyKeyDigest",
  "committedAt",
  "responseWitness"
]);
export const WRITE_SPAWN_IDEMPOTENCY_RECORD_KEYS = new Set([
  "schemaVersion",
  "workerId",
  "owner",
  "controlWorkspaceId",
  "expectedExecutionRoot",
  "admissionRequestDigest",
  "executionBindingDigest",
  "idempotencyKeyDigest",
  "committedAt",
  "responseWitness"
]);
export const SPAWN_RESPONSE_WITNESS_KEYS = new Set([
  "schemaVersion",
  "witnessId",
  "projection",
  "responseSequence",
  "workerId",
  "requestDigest",
  "idempotencyKeyDigest",
  "replayed",
  "handleDigest",
  "eventCursorSequence",
  "recordedAt"
]);
export const SPAWN_RESPONSE_WITNESS_PROJECTION =
  "worker-handle-v1-untrusted-host";
export const TASK_CONTRACT_KEYS = new Set([
  "schemaVersion",
  "envelopeId",
  "digest",
  "objective",
  "mode",
  "scope",
  "nonGoals",
  "acceptanceCriteria",
  "requiredVerification",
  "expectedReturnFormat",
  "context",
  "contextManifestId"
]);
export const TASK_CONTEXT_KEYS = new Set([
  "facts",
  "constraints",
  "expectedProjectMarkers",
  "requiredPaths",
  "workspaceState",
  "upstreamFreshness"
]);
export const CONTEXT_KEYS = new Set([
  "schemaVersion",
  "manifestId",
  "digest",
  "capturedAt",
  "branch",
  "head",
  "dirtyDigest",
  "dirtyEntryCount",
  "ignoredDigest",
  "ignoredEntryCount",
  "trackedTreeIdentity",
  "metadataIdentity",
  "insideWorktree",
  "linkedWorktree",
  "sparse",
  "shallow",
  "upstreamRef",
  "upstreamCommit",
  "upstreamFreshness",
  "projectMarkers",
  "materialization"
]);

export function nullableBounded(value, maximum) {
  return value === null || boundedString(value, maximum);
}

export function validatePublicLifecycleHistory(events, expectedWorkerId, eventCursor) {
  if (
    !Array.isArray(events)
    || events.length < 1
    || events.length > MAX_TERMINAL_LIFECYCLE_EVENTS
  ) {
    fail("E_PRIVATE_STATE");
  }
  let prior = 0;
  for (const event of events) {
    validateLifecycleEvent(event);
    if (event.sequence !== prior + 1) fail("E_PRIVATE_STATE");
    prior = event.sequence;
  }
  if (validateCursor(eventCursor, expectedWorkerId) !== prior) {
    fail("E_PRIVATE_STATE");
  }
}

export function validateTerminalPublicLifecycleHistory(
  events,
  expectedWorkerId,
  eventCursor,
  trackedEvents
) {
  const cursorSequence = validateCursor(eventCursor, expectedWorkerId);
  const expectedLength = Math.min(
    MAX_TERMINAL_LIFECYCLE_EVENTS,
    cursorSequence
  );
  if (
    !Array.isArray(events)
    || expectedLength < 1
    || events.length !== expectedLength
  ) {
    fail("E_PRIVATE_STATE");
  }
  let prior = cursorSequence - expectedLength;
  for (const event of events) {
    validateLifecycleEvent(event);
    if (event.sequence !== prior + 1) fail("E_PRIVATE_STATE");
    prior = event.sequence;
  }
  if (
    cursorSequence !== prior
    || !Array.isArray(trackedEvents)
    || trackedEvents.length !== cursorSequence
    || trackedEvents[0]?.sequence !== 1
    || trackedEvents.at(-1)?.sequence !== cursorSequence
    || !sameJson(trackedEvents.slice(-expectedLength), events)
  ) {
    fail("E_PRIVATE_STATE");
  }
}

export function validateTaskContractProjection(worker, job) {
  const contract = worker.taskContract;
  const envelope = job.request?.envelope;
  if (
    !hasExactKeys(contract, TASK_CONTRACT_KEYS)
    || !Number.isSafeInteger(contract.schemaVersion)
    || contract.schemaVersion < 1
    || contract.envelopeId !== envelope?.envelopeId
    || contract.digest !== envelope?.digest
    || contract.contextManifestId !== envelope?.contextManifestId
    || contract.objective !== job.request?.publicObjective
    || contract.mode !== "read"
    || !hasExactKeys(contract.scope, new Set(["include", "exclude"]))
    || !validStringList(contract.scope.include, { maximumItems: 64 })
    || !validStringList(contract.scope.exclude, { maximumItems: 64 })
    || !validStringList(contract.nonGoals, { maximumItems: 64 })
    || !validStringList(contract.requiredVerification, { maximumItems: 64 })
    || !nullableBounded(contract.expectedReturnFormat, 2000)
    || !Array.isArray(contract.acceptanceCriteria)
    || contract.acceptanceCriteria.length > 64
    || contract.acceptanceCriteria.some((criterion) => (
      !hasExactKeys(criterion, new Set(["id", "text"]))
      || !boundedString(criterion.id, 80, { nonempty: true })
      || !boundedString(criterion.text, 2000, { nonempty: true })
    ))
    || !hasExactKeys(contract.context, TASK_CONTEXT_KEYS)
    || !validStringList(contract.context.facts, { maximumItems: 64 })
    || !validStringList(contract.context.constraints, { maximumItems: 64 })
    || contract.context.facts.length !== 0
    || contract.context.constraints.length !== 0
    || !validStringList(contract.context.expectedProjectMarkers, { maximumItems: 32 })
    || !validStringList(contract.context.requiredPaths, { maximumItems: 64 })
    || !new Set(["complete", "task_scoped", "unknown"])
      .has(contract.context.workspaceState)
    || contract.context.upstreamFreshness !== "not_checked"
  ) {
    fail("E_PRIVATE_STATE");
  }
}

export function validateContextReceiptProjection(worker, job) {
  const receipt = worker.contextReceipt;
  const privateReceipt = job.request?.contextReceipt;
  const packet = job.request?.contextPacket;
  if (
    !isPlainRecord(receipt)
    || !sameJson(receipt, privateReceipt)
    || receipt.packetId !== packet?.packetId
    || receipt.packetDigest !== packet?.digest
    || receipt.lineageWorkerId !== job.id
    || receipt.contextManifestId !== job.request?.contextManifest?.manifestId
    || receipt.contextManifestDigest !== job.request?.contextManifest?.digest
    || receipt.effectivePromptDigest !== job.request?.providerPromptDigest
    || receipt.rolePolicyDigest !== job.request?.runtimeRolePolicy?.digest
    || receipt.truncated !== false
    || receipt.hiddenRecordsExported !== false
  ) {
    fail("E_PRIVATE_STATE");
  }
  const serialized = JSON.stringify(receipt);
  if (
    /"(?:facts|constraints|userRequest|objective|prompt|providerSessionId)"\s*:/.test(serialized)
  ) {
    fail("E_PRIVATE_STATE");
  }
}

export function validateContextProjection(worker, job) {
  const context = worker.context;
  const manifest = job.request?.contextManifest;
  if (
    !hasExactKeys(context, CONTEXT_KEYS)
    || !Number.isSafeInteger(context.schemaVersion)
    || context.schemaVersion < 1
    || context.manifestId !== manifest?.manifestId
    || context.digest !== manifest?.digest
    || !canonicalTimestamp(context.capturedAt)
    || !nullableBounded(context.branch, 256)
    || !nullableBounded(context.head, 256)
    || !nullableBounded(context.dirtyDigest, 256)
    || !Number.isSafeInteger(context.dirtyEntryCount)
    || context.dirtyEntryCount < 0
    || !nullableBounded(context.ignoredDigest, 256)
    || !Number.isSafeInteger(context.ignoredEntryCount)
    || context.ignoredEntryCount < 0
    || !nullableBounded(context.trackedTreeIdentity, 256)
    || !nullableBounded(context.metadataIdentity, 256)
    || !nullableBounded(context.upstreamRef, 256)
    || !nullableBounded(context.upstreamCommit, 256)
    || ["insideWorktree", "linkedWorktree", "sparse", "shallow"]
      .some((key) => typeof context[key] !== "boolean")
    || context.upstreamFreshness !== "not_checked"
    || !validStringList(context.projectMarkers, { maximumItems: 32 })
    || !hasExactKeys(
      context.materialization,
      new Set(["state", "reasons", "submodules", "upstreamFreshness"])
    )
    || !new Set(["local_complete", "partial", "unknown"])
      .has(context.materialization.state)
    || !validStringList(context.materialization.reasons, { maximumItems: 64 })
    || !validStringList(context.materialization.submodules, { maximumItems: 100 })
    || context.materialization.upstreamFreshness !== "not_checked"
  ) {
    fail("E_PRIVATE_STATE");
  }
}

export function validateIntermediateWorkerSnapshot(worker, tracker, job) {
  const binding = immutablePrivateBinding(job);
  if (
    !hasExactKeys(worker, SNAPSHOT_KEYS)
    || worker.workerProtocolVersion !== 1
    || worker.snapshotSchemaVersion !== 1
    || !Number.isSafeInteger(worker.schemaVersion)
    || worker.schemaVersion < 1
    || worker.id !== tracker.workerId
    || worker.id !== job.id
    || worker.kind !== "task"
    || worker.jobClass !== "task"
    || worker.write !== false
    || !new Set(["queued", "running"]).has(worker.status)
    || worker.terminal !== false
    || !boundedString(worker.phase, 128, { nonempty: true })
    || !nullableBounded(worker.summary, 2000)
    || !nullableBounded(worker.progress, 2000)
    || !canonicalTimestamp(worker.createdAt)
    || !canonicalTimestamp(worker.updatedAt)
    || !nullableBounded(worker.startedAt, 64)
    || (worker.startedAt !== null && !canonicalTimestamp(worker.startedAt))
    || worker.completedAt !== null
    || !nullableBounded(worker.heartbeatAt, 64)
    || (worker.heartbeatAt !== null && !canonicalTimestamp(worker.heartbeatAt))
    || worker.profileId !== "rescue-read-v3"
    || !nullableBounded(worker.model, 256)
    || !nullableBounded(worker.effort, 128)
    || worker.parentWorkerId !== null
    || worker.lineageWorkerId !== job.id
    || worker.taskEnvelopeId !== binding.taskEnvelopeId
    || worker.taskEnvelopeDigest !== binding.taskEnvelopeDigest
    || worker.contextManifestId !== binding.contextManifestId
    || worker.contextDigest !== binding.contextDigest
    || worker.workspaceSnapshotDigest !== binding.workspaceSnapshotDigest
    || worker.hostTaskBinding !== binding.hostTaskBinding
    || !hasExactKeys(
      worker.securityProfile,
      new Set(["id", "contractVersion", "agentProfileDigest"])
    )
    || worker.securityProfile.id !== job.profile?.id
    || worker.securityProfile.contractVersion !== job.profile?.contractVersion
    || worker.securityProfile.agentProfileDigest !== job.profile?.agentProfileDigest
    || !validStringList(worker.latestPlan, { maximumItems: 128 })
    || worker.resumeJobId !== null
    || worker.result !== null
    || worker.error !== null
    || worker.controlWorkspaceId !== binding.controlWorkspaceId
    || worker.roleId !== "explorer"
    || worker.externalWorkerLabel !== "external-grok-worker"
    || worker.awaitingHostAction !== null
  ) {
    fail("E_PRIVATE_STATE");
  }
  validatePublicLifecycleHistory(
    worker.lifecycleEvents,
    tracker.workerId,
    worker.eventCursor
  );
  validateTaskContractProjection(worker, job);
  if (worker.contextBindingMode !== "context-receipt-v1") fail("E_PRIVATE_STATE");
  validateContextReceiptProjection(worker, job);
  validateContextProjection(worker, job);
}

export const PUBLIC_RESULT_KEYS = new Set([
  "workerProtocolVersion",
  "resultSchemaVersion",
  "review",
  "workerReport",
  "reportRepair",
  "providerClaims",
  "runtimeEvidence",
  "verification",
  "textBytes",
  "textDigest",
  "textTruncated",
  "interim",
  "hostVerification",
  "stopReason",
  "cancellation",
  "skipped",
  "skipReason",
  "providerSessionDeleted",
  "taskRuntimeCleaned",
  "privacyWarning"
]);
export const WORKER_REPORT_KEYS = new Set([
  "schemaVersion",
  "structured",
  "valid",
  "outcome",
  "summary",
  "changedFiles",
  "checksClaimed",
  "acceptanceResults",
  "risks",
  "questions",
  "validationIssues"
]);
export const EXPECTED_REPORT_SUMMARY = "Installed Worker MCP fixture inspected.";
export const EXPECTED_ACCEPTANCE_RESULTS = Object.freeze([
  Object.freeze({ id: "AC-01", status: "met" }),
  Object.freeze({ id: "AC-02", status: "met" })
]);

export function validateExactCompletionReport(worker, job) {
  const report = worker.result?.workerReport;
  const providerClaims = worker.result?.providerClaims;
  const expectedReport = {
    schemaVersion: 1,
    structured: true,
    valid: true,
    outcome: "complete",
    summary: EXPECTED_REPORT_SUMMARY,
    changedFiles: [],
    checksClaimed: [],
    acceptanceResults: EXPECTED_ACCEPTANCE_RESULTS,
    risks: [],
    questions: [],
    validationIssues: []
  };
  const expectedClaims = {
    success: true,
    outcome: "complete",
    summary: EXPECTED_REPORT_SUMMARY,
    changedFiles: [],
    checksClaimed: [],
    observedFileAgreement: true
  };
  if (
    !hasExactKeys(report, WORKER_REPORT_KEYS)
    || !sameJson(report, expectedReport)
    || !sameJson(providerClaims, expectedClaims)
    || job.result?.workerReport?.schemaVersion !== 1
    || job.result?.workerReport?.structured !== true
    || job.result?.workerReport?.valid !== true
    || job.result?.workerReport?.outcome !== "complete"
    || job.result?.workerReport?.summary !== EXPECTED_REPORT_SUMMARY
    || !sameJson(job.result?.workerReport?.changedFiles, [])
    || !sameJson(job.result?.workerReport?.checksClaimed, [])
    || !sameJson(
      job.result?.workerReport?.acceptanceResults,
      EXPECTED_ACCEPTANCE_RESULTS
    )
    || !sameJson(job.result?.workerReport?.risks, [])
    || !sameJson(job.result?.workerReport?.questions, [])
    || !sameJson(job.result?.workerReport?.validationIssues, [])
    || job.result?.reportRepair != null
  ) {
    fail("E_PRIVATE_STATE");
  }
}

export function validatePublicResultProjection(result, tracker, job, expectedStatus) {
  if (
    !isPlainRecord(result)
    || Object.keys(result).some((key) => !PUBLIC_RESULT_KEYS.has(key))
    || result.workerProtocolVersion !== 1
    || result.resultSchemaVersion !== 1
    || result.hostVerification !== "not_run"
    || result.taskRuntimeCleaned !== true
    || Object.hasOwn(result, "review")
    || Object.hasOwn(result, "runtimeEvidence")
    || Object.hasOwn(result, "verification")
    || Object.hasOwn(result, "providerSessionDeleted")
    || Object.hasOwn(result, "privacyWarning")
    || Object.hasOwn(result, "skipped")
    || Object.hasOwn(result, "skipReason")
  ) {
    fail("E_PRIVATE_STATE");
  }
  if (Object.hasOwn(result, "textDigest")) {
    if (
      !/^[0-9a-f]{64}$/.test(result.textDigest)
      || !Number.isSafeInteger(result.textBytes)
      || result.textBytes < 0
      || typeof result.textTruncated !== "boolean"
    ) {
      fail("E_PRIVATE_STATE");
    }
  } else if (
    Object.hasOwn(result, "textBytes")
    || Object.hasOwn(result, "textTruncated")
  ) {
    fail("E_PRIVATE_STATE");
  }
  if (Object.hasOwn(result, "interim")) {
    if (
      !hasExactKeys(result.interim, new Set(["bytes", "digest"]))
      || !Number.isSafeInteger(result.interim.bytes)
      || result.interim.bytes < 0
      || !/^[0-9a-f]{64}$/.test(result.interim.digest || "")
    ) {
      fail("E_PRIVATE_STATE");
    }
  }
  if (expectedStatus === "completed") {
    if (
      Object.hasOwn(result, "cancellation")
      || Object.hasOwn(result, "reportRepair")
      || result.stopReason === "cancelled"
    ) {
      fail("E_PRIVATE_STATE");
    }
    validateExactCompletionReport({ result }, job);
    return;
  }
  if (
    result.stopReason !== "cancelled"
    || Object.hasOwn(result, "workerReport")
    || Object.hasOwn(result, "providerClaims")
    || Object.hasOwn(result, "reportRepair")
    || !hasExactKeys(result.cancellation, new Set([
      "requestAcceptedAt",
      "processGroupGoneAt",
      "terminalRecordCommittedAt",
      "receiptId"
    ]))
    || !canonicalTimestamp(result.cancellation.requestAcceptedAt)
    || result.cancellation.processGroupGoneAt !== null
    || result.cancellation.terminalRecordCommittedAt !== null
    || result.cancellation.receiptId
      !== tracker.observedCancellationReceiptIds[0]
  ) {
    fail("E_PRIVATE_STATE");
  }
}

export function validateTerminalWorkerSnapshot(worker, tracker, job, expectedStatus) {
  const binding = immutablePrivateBinding(job);
  const expectedPhase = expectedStatus === "completed" ? "done" : "cancelled";
  if (
    !hasExactKeys(worker, SNAPSHOT_KEYS)
    || worker.workerProtocolVersion !== 1
    || worker.snapshotSchemaVersion !== 1
    || !Number.isSafeInteger(worker.schemaVersion)
    || worker.schemaVersion < 1
    || worker.id !== tracker.workerId
    || worker.id !== job.id
    || worker.kind !== "task"
    || worker.jobClass !== "task"
    || worker.write !== false
    || worker.status !== expectedStatus
    || worker.phase !== expectedPhase
    || worker.terminal !== true
    || !canonicalTimestamp(worker.createdAt)
    || !canonicalTimestamp(worker.startedAt)
    || !canonicalTimestamp(worker.updatedAt)
    || !canonicalTimestamp(worker.completedAt)
    || Date.parse(worker.completedAt) < Date.parse(worker.startedAt)
    || !nullableBounded(worker.heartbeatAt, 64)
    || (worker.heartbeatAt !== null && !canonicalTimestamp(worker.heartbeatAt))
    || !nullableBounded(worker.summary, 2000)
    || !nullableBounded(worker.progress, 2000)
    || worker.profileId !== "rescue-read-v3"
    || !nullableBounded(worker.model, 256)
    || !nullableBounded(worker.effort, 128)
    || worker.parentWorkerId !== null
    || worker.lineageWorkerId !== job.id
    || worker.taskEnvelopeId !== binding.taskEnvelopeId
    || worker.taskEnvelopeDigest !== binding.taskEnvelopeDigest
    || worker.contextManifestId !== binding.contextManifestId
    || worker.contextDigest !== binding.contextDigest
    || worker.workspaceSnapshotDigest !== binding.workspaceSnapshotDigest
    || worker.hostTaskBinding !== binding.hostTaskBinding
    || !hasExactKeys(
      worker.securityProfile,
      new Set(["id", "contractVersion", "agentProfileDigest"])
    )
    || worker.securityProfile.id !== job.profile?.id
    || worker.securityProfile.contractVersion !== job.profile?.contractVersion
    || worker.securityProfile.agentProfileDigest !== job.profile?.agentProfileDigest
    || !validStringList(worker.latestPlan, { maximumItems: 128 })
    || worker.resumeJobId !== null
    || worker.controlWorkspaceId !== binding.controlWorkspaceId
    || worker.roleId !== "explorer"
    || worker.externalWorkerLabel !== "external-grok-worker"
    || worker.awaitingHostAction !== null
  ) {
    fail("E_PRIVATE_STATE");
  }
  validateTerminalPublicLifecycleHistory(
    worker.lifecycleEvents,
    tracker.workerId,
    worker.eventCursor,
    tracker.events.values()
  );
  validateTaskContractProjection(worker, job);
  if (worker.contextBindingMode !== "context-receipt-v1") fail("E_PRIVATE_STATE");
  validateContextReceiptProjection(worker, job);
  validateContextProjection(worker, job);
  validatePublicResultProjection(worker.result, tracker, job, expectedStatus);
  if (expectedStatus === "completed") {
    if (worker.error !== null) fail("E_PRIVATE_STATE");
  } else if (
    !hasExactKeys(worker.error, new Set([
      "workerProtocolVersion",
      "errorSchemaVersion",
      "code",
      "message"
    ]))
    || worker.error.workerProtocolVersion !== 1
    || worker.error.errorSchemaVersion !== 1
    || worker.error.code !== "E_CANCELLED"
    || !boundedString(worker.error.message, 2000, { nonempty: true })
  ) {
    fail("E_PRIVATE_STATE");
  }
}

export function assertTerminalEventHistory(
  context,
  tracker,
  publicWorker,
  terminalJob,
  expectedStatus
) {
  let projected;
  try {
    projected = context.workerProtocol.projectWorkerSnapshot(terminalJob, {
      detail: true,
      trustHostAuthority: false
    });
    validateInstalledTerminalEventHistory({
      workerId: tracker.workerId,
      status: expectedStatus,
      trackedEvents: tracker.events.values(),
      publicEvents: publicWorker.lifecycleEvents,
      publicCursor: publicWorker.eventCursor,
      projectedEvents: projected.lifecycleEvents,
      projectedCursor: projected.eventCursor
    });
  } catch {
    fail("E_PRIVATE_STATE");
  }
}

export function assertPublicPrivateBinding(worker, job) {
  if (!worker || !job) fail("E_PRIVATE_STATE");
  const expected = {
    id: job.id,
    kind: job.kind,
    jobClass: job.jobClass,
    write: Boolean(job.write),
    createdAt: job.createdAt,
    model: job.model ?? null,
    effort: job.effort ?? null,
    profileId: job.profile?.id,
    securityProfile: {
      id: job.profile?.id,
      contractVersion: job.profile?.contractVersion,
      agentProfileDigest: job.profile?.agentProfileDigest
    },
    parentWorkerId: job.request?.resumeJobId || null,
    lineageWorkerId: job.request?.providerHomeId,
    taskEnvelopeId: job.request?.envelope?.envelopeId,
    taskEnvelopeDigest: job.request?.envelope?.digest,
    contextManifestId: job.request?.contextManifest?.manifestId,
    contextDigest: job.request?.contextManifest?.digest,
    workspaceSnapshotDigest: job.request?.contextManifest?.digest,
    hostTaskBinding: hostTaskBindingFor(job),
    controlWorkspaceId: job.controlWorkspaceId,
    roleId: job.role?.id,
    externalWorkerLabel: "external-grok-worker"
  };
  const observed = Object.fromEntries(
    Object.keys(expected).map((key) => [key, worker[key]])
  );
  if (
    !sameJson(observed, expected)
    || (
      Object.hasOwn(worker, "snapshotSchemaVersion")
      && !sameJson(worker.contextReceipt, job.request?.contextReceipt)
    )
  ) {
    fail("E_PRIVATE_STATE");
  }
}

export function publicWorkerDigest(worker) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalJson(worker)))
    .digest("hex");
}

export function validateActiveSpawnHandle(
  context,
  tracker,
  publicWorker,
  laterJob,
  { replayed }
) {
  let laterHandle;
  enterScenarioStage(tracker, "spawn-handle-project");
  try {
    laterHandle = context.workerProtocol.projectWorkerHandle(laterJob, {
      trustHostAuthority: false
    });
  } catch {
    fail("E_PRIVATE_STATE");
  }
  enterScenarioStage(tracker, "spawn-handle-binding");
  assertPublicPrivateBinding(publicWorker, laterJob);
  enterScenarioStage(tracker, "spawn-handle-shape");
  if (
    !hasExactKeys(publicWorker, HANDLE_KEYS)
    || publicWorker.workerProtocolVersion !== 1
    || publicWorker.handleSchemaVersion !== 1
    || publicWorker.terminal !== false
    || publicWorker.completedAt !== null
    || !canonicalTimestamp(publicWorker.createdAt)
    || !canonicalTimestamp(publicWorker.updatedAt)
    || !canonicalTimestamp(publicWorker.heartbeatAt)
    || Date.parse(publicWorker.updatedAt) < Date.parse(publicWorker.createdAt)
    || Date.parse(publicWorker.heartbeatAt) < Date.parse(publicWorker.createdAt)
  ) {
    fail("E_PRIVATE_STATE");
  }
  enterScenarioStage(tracker, "spawn-handle-order");
  if (
    publicWorker.createdAt !== laterHandle.createdAt
    || Date.parse(publicWorker.updatedAt) > Date.parse(laterHandle.updatedAt)
    || Date.parse(publicWorker.heartbeatAt) > Date.parse(laterHandle.heartbeatAt)
    || publicWorker.eventCursor.sequence > laterHandle.eventCursor.sequence
  ) {
    fail("E_PRIVATE_STATE");
  }
  enterScenarioStage(tracker, "spawn-handle-mode");
  if (!replayed) {
    enterScenarioStage(tracker, "spawn-handle-state");
    if (
      publicWorker.status !== "queued"
      || publicWorker.phase !== "accepted"
    ) {
      fail("E_PRIVATE_STATE");
    }
    enterScenarioStage(tracker, "spawn-handle-text");
    if (
      publicWorker.summary !== "Spawn committed"
      || publicWorker.progress
        !== "Durable job record committed; provider not started by broker spawn."
    ) {
      fail("E_PRIVATE_STATE");
    }
    enterScenarioStage(tracker, "spawn-handle-start");
    if (
      publicWorker.startedAt !== null
      || publicWorker.model !== null
      || publicWorker.effort !== null
    ) {
      fail("E_PRIVATE_STATE");
    }
    enterScenarioStage(tracker, "spawn-handle-cursor");
    if (
      publicWorker.eventCursor.sequence !== 1
    ) {
      fail("E_PRIVATE_STATE");
    }
    enterScenarioStage(tracker, "spawn-handle-time");
    if (
      publicWorker.createdAt !== publicWorker.heartbeatAt
    ) {
      fail("E_PRIVATE_STATE");
    }
    enterScenarioStage(tracker, "spawn-handle-tracker");
    if (tracker.initialSpawnHandle !== null) fail("E_PRIVATE_STATE");
    tracker.initialSpawnHandle = structuredClone(publicWorker);
    return;
  }
  enterScenarioStage(tracker, "spawn-handle-replay");
  if (
    !tracker.initialSpawnHandle
    || publicWorker.status !== "running"
    || !ACTIVE_REPLAY_PHASES.has(publicWorker.phase)
    || !canonicalTimestamp(publicWorker.startedAt)
    || publicWorker.startedAt !== laterHandle.startedAt
    || publicWorker.eventCursor.sequence
      <= tracker.initialSpawnHandle.eventCursor.sequence
  ) {
    fail("E_PRIVATE_STATE");
  }
}

export function validateSpawnResponseWitness(
  context,
  tracker,
  publicWorker,
  job,
  spawnKey,
  { replayed }
) {
  const keyDigest = crypto
    .createHash("sha256")
    .update(spawnKey)
    .digest("hex");
  let record;
  enterScenarioStage(tracker, "spawn-witness-read");
  try {
    record = context.mutation.getSpawnIdempotencyRecord(
      context.fixtureRoot,
      spawnKey,
      context.env
    );
  } catch {
    fail("E_PRIVATE_STATE");
  }
  let expectedLaunchContractDigest;
  enterScenarioStage(tracker, "spawn-witness-contract");
  try {
    expectedLaunchContractDigest =
      context.launchContract.launchContractDigest(job);
  } catch {
    fail("E_PRIVATE_STATE");
  }
  const witness = record?.responseWitness;
  const handleDigest = publicWorkerDigest(publicWorker);
  enterScenarioStage(tracker, "spawn-witness-record");
  if (
    !hasExactKeys(record, SPAWN_IDEMPOTENCY_RECORD_KEYS)
    || record.schemaVersion !== 4
    || !hasExactKeys(record.owner, new Set(["hostKind", "sessionId"]))
  ) {
    fail("E_PRIVATE_STATE");
  }
  enterScenarioStage(tracker, "spawn-witness-binding");
  if (
    record.workerId !== job.id
    || record.owner.hostKind !== job.host?.kind
    || record.owner.sessionId !== job.host?.sessionId
    || record.controlWorkspaceId !== job.controlWorkspaceId
    || record.executionRoot !== job.request?.spawn?.executionRoot
    || record.requestDigest !== job.request?.spawn?.requestDigest
    || record.launchContractDigest !== expectedLaunchContractDigest
    || record.idempotencyKeyDigest !== keyDigest
    || record.idempotencyKeyDigest
      !== job.request?.spawn?.idempotencyKeyDigest
    || record.committedAt !== job.createdAt
    || !hasExactKeys(witness, SPAWN_RESPONSE_WITNESS_KEYS)
    || witness.schemaVersion !== 1
    || !/^spawnw-[0-9a-f]{24}$/.test(witness.witnessId || "")
    || witness.projection !== SPAWN_RESPONSE_WITNESS_PROJECTION
    || witness.responseSequence !== (replayed ? 2 : 1)
    || witness.workerId !== job.id
    || witness.workerId !== publicWorker.id
    || witness.requestDigest !== record.requestDigest
    || witness.idempotencyKeyDigest !== keyDigest
    || witness.replayed !== replayed
  ) {
    fail("E_PRIVATE_STATE");
  }
  enterScenarioStage(tracker, "spawn-witness-handle");
  if (
    witness.handleDigest !== handleDigest
    || witness.eventCursorSequence !== publicWorker.eventCursor.sequence
  ) {
    fail("E_PRIVATE_STATE");
  }
  enterScenarioStage(tracker, "spawn-witness-time");
  if (
    !canonicalTimestamp(witness.recordedAt)
    || Date.parse(witness.recordedAt) < Date.parse(publicWorker.updatedAt)
  ) {
    fail("E_PRIVATE_STATE");
  }
  enterScenarioStage(tracker, "spawn-witness-id");
  const { witnessId: ignoredWitnessId, ...witnessBody } = witness;
  const expectedWitnessId = `spawnw-${crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalJson(witnessBody)))
    .digest("hex")
    .slice(0, 24)}`;
  if (witness.witnessId !== expectedWitnessId) fail("E_PRIVATE_STATE");
  const previous = tracker.observedSpawnResponseWitnesses.at(-1);
  if (
    previous
    && (
      witness.responseSequence !== previous.responseSequence + 1
      || witness.requestDigest !== previous.requestDigest
      || witness.idempotencyKeyDigest !== previous.idempotencyKeyDigest
      || witness.eventCursorSequence <= previous.eventCursorSequence
      || Date.parse(witness.recordedAt) < Date.parse(previous.recordedAt)
    )
  ) {
    fail("E_PRIVATE_STATE");
  }
  tracker.observedSpawnResponseWitnesses.push(structuredClone(witness));
  return handleDigest;
}

export function validateWriteSpawnResponseWitness(
  context,
  publicWorker,
  job,
  spawnKey,
  { replayed, expectCurrentProjection = replayed }
) {
  const keyDigest = crypto
    .createHash("sha256")
    .update(spawnKey)
    .digest("hex");
  let record;
  try {
    record = context.mutation.getSpawnIdempotencyRecord(
      context.fixtureRoot,
      spawnKey,
      context.env
    );
  } catch {
    fail("E_PRIVATE_STATE");
  }
  const witness = record?.responseWitness;
  const handleDigest = publicWorkerDigest(publicWorker);
  if (
    !hasExactKeys(record, WRITE_SPAWN_IDEMPOTENCY_RECORD_KEYS)
    || record.schemaVersion !== 5
    || !hasExactKeys(record.owner, new Set(["hostKind", "sessionId"]))
    || record.workerId !== job.id
    || record.owner.hostKind !== job.host?.kind
    || record.owner.sessionId !== job.host?.sessionId
    || record.controlWorkspaceId !== job.controlWorkspaceId
    || record.expectedExecutionRoot
      !== job.executionBinding?.expectedExecutionRoot
    || record.admissionRequestDigest
      !== job.request?.spawn?.admissionRequestDigest
    || record.executionBindingDigest
      !== job.executionBinding?.bindingDigest
    || record.idempotencyKeyDigest !== keyDigest
    || record.idempotencyKeyDigest
      !== job.request?.spawn?.idempotencyKeyDigest
    || record.committedAt !== job.createdAt
    || !hasExactKeys(witness, SPAWN_RESPONSE_WITNESS_KEYS)
    || witness.schemaVersion !== 1
    || !/^spawnw-[0-9a-f]{24}$/.test(witness.witnessId || "")
    || witness.projection !== SPAWN_RESPONSE_WITNESS_PROJECTION
    || witness.responseSequence !== (replayed ? 2 : 1)
    || witness.workerId !== job.id
    || witness.requestDigest !== record.admissionRequestDigest
    || witness.idempotencyKeyDigest !== keyDigest
    || witness.replayed !== replayed
    || witness.handleDigest !== handleDigest
    || witness.eventCursorSequence !== publicWorker?.eventCursor?.sequence
    || !canonicalTimestamp(witness.recordedAt)
    || Date.parse(witness.recordedAt) < Date.parse(record.committedAt)
  ) {
    fail("E_PRIVATE_STATE");
  }
  if (expectCurrentProjection) {
    let currentHandle;
    try {
      currentHandle = context.workerProtocol.projectWorkerHandle(job, {
        trustHostAuthority: false
      });
    } catch {
      fail("E_PRIVATE_STATE");
    }
    if (!sameJson(publicWorker, currentHandle)) fail("E_PRIVATE_STATE");
  }
  const { witnessId: ignoredWitnessId, ...witnessBody } = witness;
  const expectedWitnessId = `spawnw-${canonicalDigest(witnessBody).slice(0, 24)}`;
  if (witness.witnessId !== expectedWitnessId) fail("E_PRIVATE_STATE");
  return Object.freeze({
    recordDigest: canonicalDigest(record),
    witness: structuredClone(witness)
  });
}

export function recordPrivateIdentityObservation(
  context,
  tracker,
  job,
  publicWorker,
  {
    terminal = false,
    spawnKey = null,
    replayed = null
  } = {}
) {
  const values = [
    job?.id,
    job?.request?.envelope?.envelopeId,
    job?.request?.contextManifest?.manifestId
  ];
  if (values.some((value) => typeof value !== "string" || value === "")) {
    fail("E_PRIVATE_STATE");
  }
  tracker.observedWorkerIds.push(values[0]);
  tracker.observedTaskEnvelopeIds.push(values[1]);
  tracker.observedContextManifestIds.push(values[2]);
  let digest;
  if (terminal) {
    let expected;
    try {
      expected = context.workerProtocol.projectWorkerSnapshot(job, {
        detail: true,
        trustHostAuthority: false
      });
    } catch {
      fail("E_PRIVATE_STATE");
    }
    if (!sameJson(publicWorker, expected)) fail("E_PRIVATE_STATE");
    digest = publicWorkerDigest(publicWorker);
  } else {
    if (
      typeof spawnKey !== "string"
      || typeof replayed !== "boolean"
    ) {
      fail("E_PRIVATE_STATE");
    }
    validateActiveSpawnHandle(
      context,
      tracker,
      publicWorker,
      job,
      { replayed }
    );
    digest = validateSpawnResponseWitness(
      context,
      tracker,
      publicWorker,
      job,
      spawnKey,
      { replayed }
    );
  }
  if (!/^[0-9a-f]{64}$/.test(digest)) fail("E_PRIVATE_STATE");
  tracker.observedPublicWorkerDigests.push(digest);
}

export function createTracker(scenarioId, fixtureStatus) {
  return {
    scenarioId,
    fixtureStatus,
    workerId: null,
    privateBinding: null,
    spawnIdempotencyKey: null,
    cancelIdempotencyKey: null,
    latestJob: null,
    sessionId: null,
    sessionBoundary: null,
    emergencySessionCleanupReady: false,
    providerGeneration: null,
    providerStartEvidence: new Set(),
    authenticatedGuard: null,
    processIdentities: new Map(),
    observedWorkerIds: [],
    observedPublicWorkerDigests: [],
    observedSpawnResponseWitnesses: [],
    initialSpawnHandle: null,
    observedTaskEnvelopeIds: [],
    observedContextManifestIds: [],
    observedProviderGenerations: [],
    observedProviderWorkerIds: [],
    observedCancellationReceiptIds: [],
    mailboxAttemptId: null,
    mailboxMessageCountAfterReplay: null,
    mailboxObservation: null,
    mailboxPublicReceipts: null,
    mailboxMessageBindings: null,
    publicWorkers: [],
    events: orderedEventObserver(),
    calls: {
      spawn: 0,
      spawnReplay: 0,
      result: 0,
      reconnect: 0,
      cancel: 0,
      cancelReplay: 0,
      send: 0,
      sendReplay: 0
    },
    sessionPresent: false,
    sessionDeleteAcknowledged: false,
    sessionDeleted: false,
    providerGuardAbsent: false
  };
}

export async function waitForTerminal(context, client, tracker, cursor) {
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS;
  let currentCursor = cursor;
  while (Date.now() < deadline) {
    checkInterrupted(context.runner);
    const page = await callTool(
      context,
      client,
      "worker_wait",
      {
        id: tracker.workerId,
        ...(currentCursor ? { cursor: currentCursor } : {}),
        timeoutMs: 30_000
      },
      ["stream"]
    );
    currentCursor = observeStream(
      tracker.events,
      page.stream,
      tracker.workerId,
      { wait: true, cursor: currentCursor }
    );
    readPrivateJob(context, tracker);
    if (page.stream.terminal === true) return currentCursor;
  }
  fail("E_SCENARIO");
}

export async function drainTerminalEventStream(
  context,
  client,
  tracker,
  cursor,
  terminalJob
) {
  const expectedSequence = terminalJob?.lifecycleEvents?.at(-1)?.sequence;
  let currentCursor = cursor;
  let currentSequence = validateCursor(currentCursor, tracker.workerId);
  if (
    !Number.isSafeInteger(expectedSequence)
    || expectedSequence < currentSequence
  ) {
    fail("E_PRIVATE_STATE");
  }
  const deadline = Date.now() + 30_000;
  while (currentSequence < expectedSequence && Date.now() < deadline) {
    const page = await callTool(
      context,
      client,
      "worker_wait",
      {
        id: tracker.workerId,
        cursor: currentCursor,
        timeoutMs: 30_000
      },
      ["stream"]
    );
    if (page.stream?.terminal !== true) fail("E_PRIVATE_STATE");
    currentCursor = observeStream(
      tracker.events,
      page.stream,
      tracker.workerId,
      { wait: true, cursor: currentCursor }
    );
    const nextSequence = validateCursor(currentCursor, tracker.workerId);
    if (nextSequence <= currentSequence) fail("E_PRIVATE_STATE");
    currentSequence = nextSequence;
  }
  if (currentSequence !== expectedSequence) fail("E_PRIVATE_STATE");
  return currentCursor;
}
