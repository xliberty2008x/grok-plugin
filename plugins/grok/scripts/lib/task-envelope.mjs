import { CompanionError } from "./errors.mjs";
import {
  MAX_CONTEXT_CONSTRAINTS,
  MAX_CONTEXT_CONSTRAINT_CHARS,
  MAX_CONTEXT_FACTS,
  MAX_CONTEXT_FACT_CHARS,
  validateExplicitContextItems
} from "./worker-context.mjs";
import {
  CONTEXT_MANIFEST_ID,
  SHA256_HEX,
  asRepositoryPathList,
  asStringList,
  boundedLiteral,
  canonicalJson,
  clip,
  normalizeAcceptance,
  retainedTextDigest,
  sha
} from "./task-contract-primitives.mjs";

export const TASK_ENVELOPE_VERSION = 1;

const TASK_ENVELOPE_INPUT_KEYS = new Set([
  "schemaVersion",
  "userRequest",
  "objective",
  "mode",
  "scope",
  "context",
  "contextFacts",
  "constraints",
  "nonGoals",
  "acceptanceCriteria",
  "requiredVerification",
  "verificationGeneratedPaths",
  "expectedReturnFormat"
]);
const TASK_ENVELOPE_KEYS = new Set([
  "schemaVersion",
  "userRequest",
  "objective",
  "mode",
  "scope",
  "context",
  "nonGoals",
  "acceptanceCriteria",
  "requiredVerification",
  "verificationGeneratedPaths",
  "expectedReturnFormat",
  "contextManifestId",
  "envelopeId",
  "digest"
]);
const TASK_ENVELOPE_LEGACY_KEYS = new Set(
  [...TASK_ENVELOPE_KEYS].filter((key) => key !== "verificationGeneratedPaths")
);


/**
 * Remove raw provider/request text before a job record is durably retained.
 *
 * Literal text is authoritative when present: its digest replaces any stale or
 * forged pre-existing digest. Without a literal, only a well-formed SHA-256
 * witness is retained. A default objective is another copy of userRequest, so
 * replace it with the same digest; a distinct caller-supplied objective remains
 * available as the bounded public task description.
 */
export function scrubStoredRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;

  const prompt = typeof request.prompt === "string" ? request.prompt : null;
  const envelope = request.envelope && typeof request.envelope === "object" && !Array.isArray(request.envelope)
    ? request.envelope
    : null;
  const userRequest = typeof envelope?.userRequest === "string" ? envelope.userRequest : null;
  const userRequestDigest = retainedTextDigest(userRequest, envelope?.userRequestDigest);
  const defaultObjective = userRequest !== null && envelope?.objective === userRequest;
  const duplicatePublicObjective = userRequest !== null && request.publicObjective === userRequest;

  return {
    ...request,
    prompt: null,
    promptDigest: retainedTextDigest(prompt, request.promptDigest),
    ...(duplicatePublicObjective ? { publicObjective: null } : {}),
    envelope: envelope ? {
      ...envelope,
      userRequest: null,
      userRequestDigest,
      ...(defaultObjective ? { objective: userRequestDigest } : {})
    } : null
  };
}

/** Normalize the request and any title derived from its default objective. */
export function scrubStoredJob(job) {
  if (!job || typeof job !== "object" || Array.isArray(job)) return null;
  const userRequest = typeof job.request?.envelope?.userRequest === "string"
    ? job.request.envelope.userRequest
    : null;
  const defaultTitle = userRequest !== null
    && typeof job.title === "string"
    && job.title === userRequest.slice(0, 100);
  const request = scrubStoredRequest(job.request);
  const digest = request?.envelope?.userRequestDigest;
  return {
    ...job,
    request,
    ...(defaultTitle && SHA256_HEX.test(digest || "")
      ? { title: `task:${digest.slice(0, 24)}` }
      : {})
  };
}


/**
 * Build TaskEnvelope v1 from structured fields or plain-text CLI task input.
 * Plain-text paths remain compatible by constructing a default envelope.
 */
export function buildTaskEnvelope({
  userRequest,
  objective = null,
  mode = "read",
  scope = null,
  context = null,
  contextFacts = [],
  constraints = [],
  nonGoals = [],
  acceptanceCriteria = null,
  requiredVerification = [],
  verificationGeneratedPaths,
  expectedReturnFormat = null,
  contextManifestId = null
} = {}) {
  const request = boundedLiteral(userRequest, "userRequest");
  const resolvedObjective = clip(String(objective ?? request).trim() || request);
  const defaultObjective = objective == null ? resolvedObjective : null;
  const resolvedMode = mode === "write" ? "write" : "read";
  const criteria = normalizeAcceptance(
    acceptanceCriteria?.length
      ? acceptanceCriteria
      : ["Complete the requested task within the stated constraints.", "Report changes, verification, risks, and remaining questions."]
  );
  const acceptanceIds = new Set();
  for (const criterion of criteria) {
    if (acceptanceIds.has(criterion.id)) throw new CompanionError("E_USAGE", `Duplicate acceptance criterion ID ${criterion.id}.`);
    acceptanceIds.add(criterion.id);
  }
  const explicitFacts = validateExplicitContextItems(
    context?.facts ?? contextFacts,
    {
      name: "context.facts",
      maxItems: MAX_CONTEXT_FACTS,
      maxChars: MAX_CONTEXT_FACT_CHARS
    }
  );
  const explicitConstraints = validateExplicitContextItems(
    context?.constraints ?? constraints,
    {
      name: "context.constraints",
      maxItems: MAX_CONTEXT_CONSTRAINTS,
      maxChars: MAX_CONTEXT_CONSTRAINT_CHARS
    }
  );
  for (const [name, items] of [
    ["context.facts", explicitFacts],
    ["context.constraints", explicitConstraints]
  ]) {
    const duplicate = items.findIndex((item) => (
      item === request || (defaultObjective !== null && item === defaultObjective)
    ));
    if (duplicate >= 0) {
      throw new CompanionError(
        "E_POLICY",
        `${name}[${duplicate}] duplicates the literal user request/default objective.`
      );
    }
  }
  const envelope = {
    schemaVersion: TASK_ENVELOPE_VERSION,
    userRequest: request,
    objective: resolvedObjective,
    mode: resolvedMode,
    scope: {
      include: asStringList(scope?.include),
      exclude: asStringList(scope?.exclude)
    },
    context: {
      facts: explicitFacts,
      constraints: explicitConstraints,
      expectedProjectMarkers: asRepositoryPathList(
        context?.expectedProjectMarkers,
        "context.expectedProjectMarkers",
        { max: 32 }
      ),
      requiredPaths: asRepositoryPathList(context?.requiredPaths, "context.requiredPaths"),
      workspaceState: ["complete", "task_scoped", "unknown"].includes(context?.workspaceState)
        ? context.workspaceState
        : "unknown",
      upstreamFreshness: context?.upstreamFreshness === "verified" ? "verified" : "not_checked"
    },
    nonGoals: asStringList(nonGoals),
    acceptanceCriteria: criteria,
    requiredVerification: asStringList(requiredVerification),
    ...(verificationGeneratedPaths !== undefined ? {
      verificationGeneratedPaths: asRepositoryPathList(
        verificationGeneratedPaths,
        "verificationGeneratedPaths",
        { max: 64 }
      )
    } : {}),
    expectedReturnFormat: clip(
      expectedReturnFormat
        || "Return one Worker Report JSON object containing outcome, summary, changedFiles, checksClaimed, acceptanceResults, risks, questions, and hostActionRequest. The runtime requests native structured output; only when that channel is unavailable, prefix the fallback object with GROK_WORKER_REPORT:."
    ),
    contextManifestId: contextManifestId || null
  };
  const digest = sha(canonicalJson(envelope));
  return {
    ...envelope,
    envelopeId: `env-${digest.slice(0, 24)}`,
    digest
  };
}

function taskEnvelopeSchemaError() {
  return new CompanionError(
    "E_SCHEMA",
    "TaskEnvelope does not match its canonical versioned contract."
  );
}

function taskEnvelopeBuilderInput(envelope, contextManifestId = envelope?.contextManifestId ?? null) {
  return {
    userRequest: envelope.userRequest,
    objective: envelope.objective,
    mode: envelope.mode,
    scope: envelope.scope,
    context: envelope.context,
    nonGoals: envelope.nonGoals,
    acceptanceCriteria: envelope.acceptanceCriteria,
    requiredVerification: envelope.requiredVerification,
    ...(Object.hasOwn(envelope, "verificationGeneratedPaths")
      ? { verificationGeneratedPaths: envelope.verificationGeneratedPaths }
      : {}),
    expectedReturnFormat: envelope.expectedReturnFormat,
    contextManifestId
  };
}

/**
 * Validate an executable TaskEnvelope before it enters durable launch state.
 *
 * Canonically rebuilding the envelope enforces the same key, type, bound,
 * normalization, digest, and envelope-id contract used by the sole builder.
 * Privacy-scrubbed durable envelopes are deliberately not accepted here: this
 * boundary is for a new executable request while its literal text is present.
 */
export function assertTaskEnvelope(envelope) {
  try {
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      throw taskEnvelopeSchemaError();
    }
    const keys = Object.keys(envelope);
    const hasGeneratedPaths = Object.hasOwn(envelope, "verificationGeneratedPaths");
    const allowedKeys = hasGeneratedPaths ? TASK_ENVELOPE_KEYS : TASK_ENVELOPE_LEGACY_KEYS;
    if (keys.length !== allowedKeys.size
      || keys.some((key) => !allowedKeys.has(key))
      || envelope.schemaVersion !== TASK_ENVELOPE_VERSION
      || typeof envelope.userRequest !== "string"
      || typeof envelope.objective !== "string"
      || !["read", "write"].includes(envelope.mode)
      || (envelope.contextManifestId !== null
        && !CONTEXT_MANIFEST_ID.test(envelope.contextManifestId || ""))
      || typeof envelope.expectedReturnFormat !== "string"
      || !/^env-[a-f0-9]{24}$/.test(envelope.envelopeId || "")
      || !SHA256_HEX.test(envelope.digest || "")) {
      throw taskEnvelopeSchemaError();
    }
    const rebuilt = buildTaskEnvelope(taskEnvelopeBuilderInput(envelope));
    if (canonicalJson(envelope) !== canonicalJson(rebuilt)) {
      throw taskEnvelopeSchemaError();
    }
    return envelope;
  } catch (error) {
    if (error instanceof CompanionError && error.code === "E_SCHEMA") throw error;
    throw taskEnvelopeSchemaError();
  }
}

/** Rebuild a validated envelope after binding the trusted context identity. */
export function bindTaskEnvelopeContext(envelope, contextManifestId) {
  const validated = assertTaskEnvelope(envelope);
  if (typeof contextManifestId !== "string" || !contextManifestId) {
    throw taskEnvelopeSchemaError();
  }
  return buildTaskEnvelope(taskEnvelopeBuilderInput(validated, contextManifestId));
}

/** Parse and validate the bounded JSON object accepted by --envelope-stdin. */
export function parseTaskEnvelopeInput(text) {
  const raw = String(text ?? "");
  if (!raw.trim()) throw new CompanionError("E_USAGE", "--envelope-stdin requires one TaskEnvelope JSON object on stdin.");
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) {
    throw new CompanionError("E_USAGE", "TaskEnvelope stdin exceeds the 256 KiB input limit.");
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new CompanionError("E_USAGE", `TaskEnvelope stdin is not valid JSON: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CompanionError("E_USAGE", "TaskEnvelope stdin must be one JSON object.");
  }
  const unknown = Object.keys(value).filter((key) => !TASK_ENVELOPE_INPUT_KEYS.has(key));
  if (unknown.length) {
    throw new CompanionError("E_USAGE", `TaskEnvelope stdin contains unsupported fields: ${unknown.slice(0, 8).join(", ")}.`);
  }
  if (value.schemaVersion != null && value.schemaVersion !== TASK_ENVELOPE_VERSION) {
    throw new CompanionError("E_USAGE", `Unsupported TaskEnvelope schemaVersion ${value.schemaVersion}.`);
  }
  if (value.mode != null && !["read", "write"].includes(value.mode)) {
    throw new CompanionError("E_USAGE", "TaskEnvelope mode must be read or write.");
  }
  if (typeof value.userRequest !== "string" || !value.userRequest.trim()) {
    throw new CompanionError("E_USAGE", "TaskEnvelope userRequest must be a non-empty string.");
  }
  return value;
}
