import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CompanionError } from "./errors.mjs";
import { git } from "./workspace.mjs";
import { redact, redactText, sanitizeDisplayText } from "./redact.mjs";
import {
  MAX_CONTEXT_CONSTRAINTS,
  MAX_CONTEXT_CONSTRAINT_CHARS,
  MAX_CONTEXT_FACTS,
  MAX_CONTEXT_FACT_CHARS,
  composeEffectiveProviderPrompt,
  validateExplicitContextItems
} from "./worker-context.mjs";
import { validateProviderHostActionRequest } from "./worker-host-actions.mjs";

const timestamp = () => new Date().toISOString();

export const TASK_ENVELOPE_VERSION = 1;
// v2 authenticates capturedAt. v1 remains an explicitly legacy integrity
// format whose timestamp must never be used as chronology authority.
export const CONTEXT_MANIFEST_VERSION = 2;
const LEGACY_CONTEXT_MANIFEST_VERSION = 1;
export const WORKER_REPORT_VERSION = 1;
/**
 * Explicit ContextManifest metadata comparison policies.
 * Unknown policy names fail closed at assertContextCompatible.
 *
 * DEFAULT: strict primary worktrees; linked worktrees may tolerate only
 * positively classified unrelated shared-ref identity churn.
 * SUPERVISORY_LINKED_WRITE: managed write primary-control rechecks only —
 * tolerate unrelated-ref / full metadataIdentity representation drift when
 * task-relevant metadata and refs remain identical, complete, and attributable.
 */
export const CONTEXT_METADATA_POLICIES = Object.freeze({
  DEFAULT: "default",
  SUPERVISORY_LINKED_WRITE: "supervisory-linked-write"
});
const CONTEXT_METADATA_POLICY_VALUES = new Set(Object.values(CONTEXT_METADATA_POLICIES));
const WORKER_REPORT_REQUIRED_FIELDS = Object.freeze([
  "outcome",
  "summary",
  "changedFiles",
  "checksClaimed",
  "acceptanceResults",
  "risks",
  "questions"
]);
const WORKER_REPORT_ALLOWED_FIELDS = Object.freeze([
  ...WORKER_REPORT_REQUIRED_FIELDS,
  "hostActionRequest"
]);
export const LIFECYCLE_EVENT_TYPES = Object.freeze([
  "task.accepted",
  "plan.updated",
  "activity.started",
  "activity.completed",
  "checkpoint",
  "blocked",
  "final.report",
  "cancellation.requested"
]);
/** Bounded retention for durable lifecycle evidence (oldest entries are dropped first). */
export const MAX_LIFECYCLE_EVENTS = 128;
const MAX_TEXT = 16 * 1024;
const MAX_USER_REQUEST = 64 * 1024;
const MAX_LIST = 64;
const MAX_ITEM = 2 * 1024;
const MAX_IGNORED_PATHS = 500_000;
const MAX_IGNORED_ATTRIBUTABLE = 2_000;
const MAX_IGNORED_HASH_BYTES = 64 * 1024 * 1024;
/** Cap for semantic shared-ref inventory; beyond this, identity is incomplete (fail closed). */
const MAX_SHARED_REFS = 10_000;
/** Cap for attributable ref snapshots retained on the manifest for evidence. */
const MAX_SHARED_REF_ATTRIBUTABLE = 2_000;
/**
 * Parser / private-evidence bound for semantic shared-ref names and targets.
 * Must stay collision-safe: do not truncate below this when retaining snapshots.
 */
const MAX_SHARED_REF_FIELD_BYTES = 512;
/** Cap for worktree operational / effective-hooks metadata entries before fail-closed truncation. */
const MAX_GIT_METADATA_ENTRIES = 10_000;
/** Shared byte budget for hashing operational, non-ref, hooks, and config target contents. */
const MAX_METADATA_HASH_BYTES = 4 * 1024 * 1024;
const MAX_HOOKS_HASH_BYTES = MAX_METADATA_HASH_BYTES;
const MAX_HOOKS_DEPTH = 8;
/** Max symlink hops when resolving metadata targets (cycle/bound safety). */
const MAX_METADATA_SYMLINK_HOPS = 8;
const MAX_HOOKS_SYMLINK_HOPS = MAX_METADATA_SYMLINK_HOPS;
/**
 * Bound for lexical hooksPath path components (ordinary dirs + symlink hops).
 * Higher than symlink-only hop limits so deep absolute temp paths remain observable.
 */
const MAX_LEXICAL_PATH_COMPONENTS = 64;
/** Max depth when walking operational / non-ref metadata trees behind symlinks. */
const MAX_METADATA_DEPTH = 8;
/**
 * Accepted body size for loose ref files and reftable compatibility markers.
 * Reads use this limit + 1 byte so oversize bodies fail closed without unbounded I/O.
 */
const MAX_LOOSE_REF_BODY_BYTES = MAX_SHARED_REF_FIELD_BYTES;
/** Cap for effective local/worktree config key/value pairs before fail-closed truncation. */
const MAX_CONFIG_ENTRIES = 10_000;
/** Cap for total effective config value bytes before fail-closed truncation. */
const MAX_CONFIG_VALUE_BYTES = MAX_METADATA_HASH_BYTES;
const SHARED_REF_IDENTITY_SCHEMA_VERSION = 1;
const SHARED_REF_OBSERVATION_SCHEMA_VERSION = 1;
const SHARED_REF_CLASS_TASK_RELEVANT = "task_relevant";
const SHARED_REF_CLASS_UNRELATED = "unrelated";
const GIT_METADATA_CLASSIFICATIONS = Object.freeze({
  UNCHANGED: "unchanged",
  TOLERATED_UNRELATED_SHARED_REFS: "tolerated_unrelated_shared_refs",
  TASK_RELEVANT_METADATA_DRIFT: "task_relevant_metadata_drift",
  LEGACY_METADATA_DRIFT: "legacy_metadata_drift",
  FAIL_CLOSED: "fail_closed"
});
/**
 * Worktree-local operational pseudorefs and multi-step sequencer/rebase state.
 * Hashed from the effective worktree Git directory (not the shared common dir).
 *
 * Audited task-relevant controls (issue #34):
 * - Merge: MERGE_HEAD, MERGE_MODE, MERGE_MSG, MERGE_AUTOSTASH, MERGE_RR
 * - Cherry-pick / revert / rebase heads and directories
 * - AUTO_MERGE conflict materialization, bisect state, sequencer
 * - SQUASH_MSG (squash-merge in progress)
 *
 * Audited standard bisect controls (behavior-bearing only — not arbitrary
 * unbounded BISECT_* enumeration). Includes every control path Git writes for
 * interactive / scripted / first-parent bisect that affects resume semantics:
 *   BISECT_LOG, BISECT_EXPECTED_REV, BISECT_START, BISECT_TERMS, BISECT_RUN,
 *   BISECT_HEAD, BISECT_NAMES, BISECT_FIRST_PARENT, BISECT_ANCESTORS_OK
 *
 * OID-bearing root pseudorefs are also resolved via Git exactly (backend-aware
 * include-root-refs / non-DWIM rev-parse) so reftable repositories cannot hide
 * BISECT_HEAD / MERGE_HEAD drift that has no loose file, and refs/tags/BISECT_HEAD
 * cannot masquerade as the root. Volatile logs (FETCH_HEAD, ORIG_HEAD, logs/**,
 * COMMIT_EDITMSG) are intentionally omitted — they change on routine fetch/commit
 * without representing multi-step operation state.
 */
const WORKTREE_OPERATIONAL_PATHS = Object.freeze([
  "MERGE_HEAD",
  "MERGE_MODE",
  "MERGE_MSG",
  "MERGE_AUTOSTASH",
  "MERGE_RR",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "AUTO_MERGE",
  "BISECT_LOG",
  "BISECT_EXPECTED_REV",
  "BISECT_START",
  "BISECT_TERMS",
  "BISECT_RUN",
  "BISECT_HEAD",
  "BISECT_NAMES",
  "BISECT_FIRST_PARENT",
  "BISECT_ANCESTORS_OK",
  "SQUASH_MSG",
  "sequencer",
  "rebase-apply",
  "rebase-merge"
]);
/**
 * Fixed OID-bearing root pseudorefs resolved through Git so loose-file and
 * reftable backends both observe create/change/remove. Not an open-ended
 * BISECT_* enumeration — only the audited operational set.
 */
const WORKTREE_OPERATIONAL_PSEUDOREFS = Object.freeze([
  "MERGE_HEAD",
  "MERGE_AUTOSTASH",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "AUTO_MERGE",
  "BISECT_HEAD"
]);
/** Cap for special index-flag entries (assume-unchanged / skip-worktree) before fail-closed. */
const MAX_INDEX_FLAG_ENTRIES = MAX_GIT_METADATA_ENTRIES;
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
  "expectedReturnFormat",
  "contextManifestId",
  "envelopeId",
  "digest"
]);

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const CONTEXT_MANIFEST_ID = /^ctx-[a-f0-9]{24}$/;

function retainedTextDigest(literal, existingDigest) {
  if (typeof literal === "string") return sha(literal);
  return SHA256_HEX.test(existingDigest || "") ? existingDigest : null;
}

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

function clip(value, limit = MAX_TEXT) {
  const text = sanitizeDisplayText(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function boundedLiteral(value, name, limit = MAX_USER_REQUEST) {
  const text = String(value ?? "").trim();
  if (!text) throw new CompanionError("E_USAGE", `${name} must be a non-empty string.`);
  if (text.length > limit) {
    throw new CompanionError("E_USAGE", `${name} exceeds the ${limit}-character TaskEnvelope limit.`);
  }
  return sanitizeDisplayText(text);
}

function asStringList(value, { max = MAX_LIST } = {}) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => clip(String(item ?? "").trim(), MAX_ITEM))
    .filter(Boolean)
    .slice(0, max);
}

export function boundPathEvidence(value, { max = 200, marker = "[CHANGED_PATHS_OVERFLOW]" } = {}) {
  const items = asStringList(value, { max: max + 1 });
  if (items.length <= max && (!Array.isArray(value) || value.length <= max)) return items;
  return [marker, ...items.slice(0, Math.max(0, max - 1))];
}

function asRepositoryPathList(value, name, { max = MAX_LIST } = {}) {
  const paths = asStringList(value, { max });
  return [...new Set(paths.map((item) => {
    const normalized = item.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
    if (
      !normalized
      || Buffer.byteLength(normalized, "utf8") > 1024
      || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized)
      || path.posix.isAbsolute(normalized)
      || normalized.startsWith("~/")
      || normalized.split("/").includes("..")
    ) {
      throw new CompanionError("E_USAGE", `${name} must contain only repository-relative paths.`);
    }
    return normalized;
  }))];
}

function stableAcceptanceId(index, provided) {
  const raw = String(provided ?? "").trim();
  if (/^AC-[A-Za-z0-9._-]{1,64}$/.test(raw)) return raw;
  return `AC-${String(index + 1).padStart(2, "0")}`;
}

function normalizeAcceptance(items) {
  const list = Array.isArray(items) ? items : [];
  return list.slice(0, MAX_LIST).map((item, index) => {
    if (typeof item === "string") {
      return { id: stableAcceptanceId(index), text: clip(item.trim(), MAX_ITEM) };
    }
    if (item && typeof item === "object") {
      return {
        id: stableAcceptanceId(index, item.id),
        text: clip(String(item.text ?? item.description ?? "").trim() || `Criterion ${index + 1}`, MAX_ITEM)
      };
    }
    return { id: stableAcceptanceId(index), text: `Criterion ${index + 1}` };
  }).filter((item) => item.text);
}

function canonicalJson(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

/**
 * Code-owned JSON Schema passed through Grok Build's ACP `outputSchema`
 * extension. Grok performs the first structural validation; the broker still
 * owns semantic validation, exact acceptance-ID accounting, scope checks, and
 * host verification.
 */
export function buildWorkerReportOutputSchema(acceptanceCriteria = []) {
  const criteria = Array.isArray(acceptanceCriteria)
    ? acceptanceCriteria.slice(0, MAX_LIST)
    : [];
  const acceptanceIds = criteria
    .map((criterion) => criterion?.id)
    .filter((id) => typeof id === "string" && id.length > 0);
  const acceptanceItem = {
    type: "object",
    additionalProperties: false,
    required: ["id", "status"],
    properties: {
      id: acceptanceIds.length
        ? { type: "string", enum: acceptanceIds }
        : { type: "string", minLength: 1, maxLength: 80 },
      status: {
        type: "string",
        enum: ["met", "unmet", "unknown"]
      },
      note: { type: "string", maxLength: MAX_ITEM }
    }
  };
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: [...WORKER_REPORT_REQUIRED_FIELDS, "hostActionRequest"],
    properties: {
      outcome: {
        type: "string",
        enum: ["complete", "partial", "blocked"]
      },
      summary: {
        type: "string",
        minLength: 1,
        maxLength: 2000
      },
      changedFiles: {
        type: "array",
        maxItems: 200,
        items: { type: "string", minLength: 1, maxLength: 1024 }
      },
      checksClaimed: {
        type: "array",
        maxItems: MAX_LIST,
        items: { type: "string", maxLength: MAX_ITEM }
      },
      acceptanceResults: {
        type: "array",
        minItems: acceptanceIds.length,
        maxItems: acceptanceIds.length || MAX_LIST,
        items: acceptanceItem
      },
      risks: {
        type: "array",
        maxItems: MAX_LIST,
        items: { type: "string", maxLength: MAX_ITEM }
      },
      questions: {
        type: "array",
        maxItems: MAX_LIST,
        items: { type: "string", maxLength: MAX_ITEM }
      },
      hostActionRequest: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            required: ["schemaVersion", "kind", "requestedRoleId"],
            properties: {
              schemaVersion: { const: 1 },
              kind: { const: "role_admission" },
              requestedRoleId: {
                type: "string",
                enum: ["reviewer", "security", "test", "implementer"]
              }
            }
          }
        ]
      }
    }
  });
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
    if (keys.length !== TASK_ENVELOPE_KEYS.size
      || keys.some((key) => !TASK_ENVELOPE_KEYS.has(key))
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
  return value;
}

/**
 * Capture a ContextManifest for the workspace. Used for job identity and drift checks.
 * Never stores task text or credentials.
 */
export function captureContextManifest(root) {
  const workspaceRoot = fs.realpathSync(root);
  const headRun = git(workspaceRoot, ["rev-parse", "HEAD"], { allowFailure: true });
  const head = headRun.status === 0 ? String(headRun.stdout || "").trim() : null;
  const branchRun = git(workspaceRoot, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true });
  const branch = branchRun.status === 0 ? String(branchRun.stdout || "").trim() : null;
  const dirtyRaw = String(git(workspaceRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { allowFailure: true }).stdout || "");
  const dirtySnapshot = parseDirtyEntries(workspaceRoot, dirtyRaw);
  const dirtyEntries = dirtySnapshot.entries;
  const dirtyPaths = dirtyEntries.flatMap((entry) => [entry.path, entry.sourcePath]).filter(Boolean);
  const dirtyDigest = dirtySnapshot.digest;
  const trackedTree = sha(String(git(workspaceRoot, ["ls-files", "--stage", "-z"], { allowFailure: true }).stdout || ""));
  const ignoredSnapshot = ignoredWorktreeSnapshot(workspaceRoot);
  const worktreeRun = git(workspaceRoot, ["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
  const insideWorktree = worktreeRun.status === 0 && String(worktreeRun.stdout || "").trim() === "true";
  const gitDirRun = git(workspaceRoot, ["rev-parse", "--git-dir"], { allowFailure: true });
  const gitDir = gitDirRun.status === 0 ? String(gitDirRun.stdout || "").trim() : "";
  const commonDirRun = git(workspaceRoot, ["rev-parse", "--git-common-dir"], { allowFailure: true });
  const commonDir = commonDirRun.status === 0 ? String(commonDirRun.stdout || "").trim() : "";
  const absoluteGitDir = gitDir ? path.resolve(workspaceRoot, gitDir) : path.join(workspaceRoot, ".git");
  const absoluteCommonDir = commonDir ? path.resolve(workspaceRoot, commonDir) : absoluteGitDir;
  const metadataIdentity = gitMetadataIdentity(absoluteGitDir, absoluteCommonDir);
  const isLinkedWorktree = Boolean(gitDir && commonDir && path.resolve(workspaceRoot, gitDir) !== path.resolve(workspaceRoot, commonDir));
  const sparseRun = git(workspaceRoot, ["sparse-checkout", "list"], { allowFailure: true });
  const sparse = sparseRun.status === 0 && String(sparseRun.stdout || "").trim().length > 0;
  const shallowRun = git(workspaceRoot, ["rev-parse", "--is-shallow-repository"], { allowFailure: true });
  const shallow = shallowRun.status === 0
    ? String(shallowRun.stdout || "").trim() === "true"
    : fs.existsSync(path.join(path.resolve(workspaceRoot, commonDir || gitDir || ".git"), "shallow"));
  const upstreamRefRun = git(workspaceRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { allowFailure: true });
  const upstreamRef = upstreamRefRun.status === 0 ? String(upstreamRefRun.stdout || "").trim() || null : null;
  const upstreamFullRefRun = git(workspaceRoot, ["rev-parse", "--symbolic-full-name", "@{upstream}"], { allowFailure: true });
  const upstreamFullRef = upstreamFullRefRun.status === 0
    ? String(upstreamFullRefRun.stdout || "").trim() || null
    : null;
  const upstreamCommitRun = upstreamRef
    ? git(workspaceRoot, ["rev-parse", "@{upstream}"], { allowFailure: true })
    : { status: 1, stdout: "" };
  const upstreamCommit = upstreamCommitRun.status === 0 ? String(upstreamCommitRun.stdout || "").trim() : null;
  const currentBranchRef = branch && branch !== "HEAD" ? `refs/heads/${branch}` : null;
  // Branch config may declare an upstream even when @{upstream} cannot resolve
  // (missing remote-tracking ref). That still counts as configured upstream.
  let upstreamConfiguredFromConfig = false;
  if (branch && branch !== "HEAD") {
    const remoteRun = git(workspaceRoot, ["config", "--get", `branch.${branch}.remote`], { allowFailure: true });
    const mergeRun = git(workspaceRoot, ["config", "--get", `branch.${branch}.merge`], { allowFailure: true });
    const remoteName = remoteRun.status === 0 ? String(remoteRun.stdout || "").trim() : "";
    const mergeName = mergeRun.status === 0 ? String(mergeRun.stdout || "").trim() : "";
    upstreamConfiguredFromConfig = Boolean(remoteName && mergeName);
  }
  // Positively resolved full upstream only: abbreviated/config names are not
  // enough to classify remote-tracking refs as task-relevant vs unrelated.
  const resolvedUpstreamFullRef = upstreamFullRef && upstreamFullRef.startsWith("refs/")
    ? upstreamFullRef
    : null;
  const upstreamConfigured = Boolean(upstreamRef) || upstreamConfiguredFromConfig;
  const taskMetadata = captureTaskRelevantGitMetadata(
    absoluteGitDir,
    absoluteCommonDir,
    workspaceRoot,
    {
      currentBranchRef,
      upstreamFullRef: resolvedUpstreamFullRef,
      upstreamConfigured
    }
  );
  const projectMarkers = [
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json"
  ].filter((relative) => fs.existsSync(path.join(workspaceRoot, relative)));
  const submoduleRun = git(workspaceRoot, ["submodule", "status", "--recursive"], { allowFailure: true });
  const submoduleLines = submoduleRun.status === 0
    ? String(submoduleRun.stdout || "").split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean)
    : [];
  const incompleteSubmodules = submoduleLines.filter((line) => /^[-+U]/.test(line));
  const materializationReasons = [
    ...(sparse ? ["sparse-checkout"] : []),
    ...(shallow ? ["shallow-history"] : []),
    ...(incompleteSubmodules.length ? ["submodules-not-at-recorded-commit"] : [])
  ];
  const body = {
    schemaVersion: CONTEXT_MANIFEST_VERSION,
    workspaceRoot,
    git: {
      branch: branch || null,
      head: head || null,
      dirtyPaths,
      dirtyEntries,
      dirtyDigest,
      dirtyEntryCount: dirtySnapshot.count,
      dirtyEntriesTruncated: dirtySnapshot.truncated,
      ignoredDigest: ignoredSnapshot.digest,
      ignoredEntryCount: ignoredSnapshot.count,
      ignoredEntries: ignoredSnapshot.entries,
      ignoredEntriesAttributable: ignoredSnapshot.attributable,
      ignoredInventoryComplete: ignoredSnapshot.complete,
      // Verification-only identity excludes pytest/Python cache path components so
      // record-verification can tolerate host-check cache drift without weakening
      // ordinary resume or task-scope ignored-write protection.
      verificationIgnoredDigest: ignoredSnapshot.verificationDigest,
      verificationIgnoredEntryCount: ignoredSnapshot.verificationCount,
      verificationIgnoredEntries: ignoredSnapshot.verificationEntries,
      verificationIgnoredEntriesAttributable: ignoredSnapshot.verificationAttributable,
      verificationIgnoredInventoryComplete: ignoredSnapshot.verificationComplete,
      trackedTreeIdentity: trackedTree,
      metadataIdentity,
      // Explicit task-relevant / semantic shared-ref identity (issue #34).
      // Legacy metadataIdentity remains the full file-tree hash for mixed/legacy
      // comparisons; these fields enable tolerating only positively classified
      // unrelated shared refs when both sides are structurally valid.
      taskRelevantMetadataIdentity: taskMetadata.taskRelevantMetadataIdentity,
      sharedRefIdentity: taskMetadata.sharedRefIdentity,
      insideWorktree,
      linkedWorktree: isLinkedWorktree,
      sparse,
      shallow,
      upstreamRef,
      upstreamCommit,
      upstreamFreshness: "not_checked"
    },
    projectMarkers,
    materialization: {
      state: materializationReasons.length ? "partial" : "local_complete",
      reasons: materializationReasons,
      submodules: submoduleLines.slice(0, 100),
      upstreamFreshness: "not_checked"
    }
  };
  // capturedAt participates in the authenticated representation. Chronology is
  // security-relevant for ready promotion and replay, so a timestamp must never
  // be mutable while retaining the same manifest identity.
  const capturedAt = timestamp();
  const authenticatedBody = {
    ...body,
    capturedAt
  };
  const digest = sha(canonicalJson(authenticatedBody));
  return {
    ...authenticatedBody,
    manifestId: `ctx-${digest.slice(0, 24)}`,
    digest
  };
}

export function assertTaskContextReady(envelope, manifest, { structuredInput = false } = {}) {
  if (!structuredInput) return;
  const expectedMarkers = envelope?.context?.expectedProjectMarkers || [];
  const workspaceRoot = manifest?.workspaceRoot ? fs.realpathSync(manifest.workspaceRoot) : null;
  const missingMarkers = [];
  const unsafeMarkers = [];
  for (const relative of expectedMarkers) {
    if (!workspaceRoot) { missingMarkers.push(relative); continue; }
    const absolute = path.resolve(workspaceRoot, relative);
    if (absolute !== workspaceRoot && !absolute.startsWith(`${workspaceRoot}${path.sep}`)) {
      unsafeMarkers.push(relative);
      continue;
    }
    if (!fs.existsSync(absolute)) {
      missingMarkers.push(relative);
      continue;
    }
    try {
      const real = fs.realpathSync(absolute);
      if (real !== workspaceRoot && !real.startsWith(`${workspaceRoot}${path.sep}`)) {
        unsafeMarkers.push(relative);
      }
    } catch {
      missingMarkers.push(relative);
    }
  }
  const requiredPaths = envelope?.context?.requiredPaths || [];
  const missingPaths = [];
  const unsafePaths = [];
  for (const relative of requiredPaths) {
    if (!workspaceRoot) { missingPaths.push(relative); continue; }
    const absolute = path.resolve(workspaceRoot, relative);
    if (absolute === workspaceRoot || !absolute.startsWith(`${workspaceRoot}${path.sep}`) || !fs.existsSync(absolute)) {
      missingPaths.push(relative);
      continue;
    }
    try {
      const real = fs.realpathSync(absolute);
      if (real !== workspaceRoot && !real.startsWith(`${workspaceRoot}${path.sep}`)) unsafePaths.push(relative);
    } catch {
      missingPaths.push(relative);
    }
  }
  const workspaceState = envelope?.context?.workspaceState || "unknown";
  const reasons = [];
  if (workspaceState === "unknown") reasons.push("host-workspace-state-unknown");
  if (workspaceState === "task_scoped" && requiredPaths.length === 0) {
    reasons.push("task-scoped-inventory-missing");
  }
  if (workspaceState === "complete" && manifest?.materialization?.state !== "local_complete") {
    reasons.push(...(manifest?.materialization?.reasons || ["workspace-not-fully-materialized"]));
  }
  if (workspaceState === "complete" && envelope?.context?.upstreamFreshness !== "verified") {
    reasons.push("upstream-freshness-not-verified");
  }
  if (envelope?.mode === "write" && manifest?.git?.ignoredInventoryComplete === false) {
    reasons.push("ignored-worktree-inventory-incomplete");
  }
  if (missingMarkers.length) reasons.push(`missing-project-markers:${missingMarkers.join(",")}`);
  if (unsafeMarkers.length) reasons.push(`project-markers-escape-workspace:${unsafeMarkers.join(",")}`);
  if (missingPaths.length) reasons.push(`missing-required-paths:${missingPaths.join(",")}`);
  if (unsafePaths.length) reasons.push(`required-paths-escape-workspace:${unsafePaths.join(",")}`);
  if (reasons.length) {
    throw new CompanionError(
      "E_CONTEXT_INCOMPLETE",
      `Task context is not ready for delegation (${reasons.join("; ")}). Correct the declared markers, paths, workspace state, or freshness evidence before delegating.`,
      {
        reasons,
        missingMarkers,
        unsafeMarkers,
        missingPaths,
        unsafePaths,
        workspaceState,
        materialization: manifest?.materialization || null
      }
    );
  }
}

function parseDirtyEntries(root, raw) {
  const tokens = String(raw || "").split("\0");
  const allEntries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const status = token.slice(0, 2);
    const relativePath = token.length > 3 ? token.slice(3) : "";
    if (!relativePath) continue;
    const renamed = /[RC]/.test(status);
    const sourcePath = renamed ? String(tokens[++index] || "") : null;
    const identity = worktreePathIdentity(root, relativePath);
    allEntries.push({
      status,
      path: relativePath.slice(0, 4096),
      sourcePath: sourcePath ? sourcePath.slice(0, 4096) : null,
      ...identity
    });
  }
  allEntries.sort((left, right) => `${left.path}\0${left.sourcePath || ""}`.localeCompare(`${right.path}\0${right.sourcePath || ""}`));
  return {
    entries: allEntries.slice(0, 500),
    count: allEntries.length,
    truncated: allEntries.length > 500,
    digest: sha(canonicalJson(allEntries))
  };
}

function hashFile(file) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

/**
 * True when any path component is exactly `.pytest_cache` or `__pycache__`.
 * Used only for the verification-time ignored identity; ordinary task/resume
 * comparison keeps the full ignored inventory.
 */
export function isVerificationCacheIgnoredPath(relativePath) {
  return String(relativePath || "")
    .split("/")
    .some((part) => part === ".pytest_cache" || part === "__pycache__");
}

/**
 * Fingerprint ignored worktree paths that `git status --untracked-files=all` omits.
 * Small files receive content hashes up to a global budget; every path also carries
 * high-resolution metadata so ordinary search/replace writes remain observable.
 * Large inventories retain only a digest and fail closed to an unattributed marker.
 *
 * From the same inventory, also compute a verification-only identity that drops
 * only standard pytest/Python cache path components so host checks can leave
 * cache drift without triggering out-of-scope write detection.
 */
function ignoredWorktreeSnapshot(root) {
  const run = git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], {
    allowFailure: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (run.status !== 0 || run.error) {
    return {
      digest: sha("ignored-v1:unavailable"),
      count: 0,
      entries: [],
      attributable: false,
      complete: false,
      verificationDigest: sha("ignored-verification-v1:unavailable"),
      verificationCount: 0,
      verificationEntries: [],
      verificationAttributable: false,
      verificationComplete: false
    };
  }
  const allPaths = String(run.stdout || "").split("\0").filter(Boolean).sort();
  const complete = allPaths.length <= MAX_IGNORED_PATHS;
  const paths = allPaths.slice(0, MAX_IGNORED_PATHS);
  const attributable = complete && paths.length <= MAX_IGNORED_ATTRIBUTABLE;
  const allVerificationPaths = allPaths.filter((relativePath) => !isVerificationCacheIgnoredPath(relativePath));
  const verificationCount = allVerificationPaths.length;
  const verificationComplete = verificationCount <= MAX_IGNORED_PATHS;
  const verificationPaths = allVerificationPaths.slice(0, MAX_IGNORED_PATHS);
  const verificationAttributable = verificationComplete && verificationCount <= MAX_IGNORED_ATTRIBUTABLE;
  const fullPathSet = new Set(paths);
  const verificationPathSet = new Set(verificationPaths);
  const snapshotPaths = [...new Set([...paths, ...verificationPaths])].sort();
  const entries = [];
  const verificationEntries = [];
  const digest = crypto.createHash("sha256");
  const verificationDigest = crypto.createHash("sha256");
  digest.update("ignored-v1\0");
  verificationDigest.update("ignored-verification-v1\0");
  let hashedBytes = 0;
  let verificationHashedBytes = 0;
  for (const relativePath of snapshotPaths) {
    const inFullSnapshot = fullPathSet.has(relativePath);
    const inVerificationSnapshot = verificationPathSet.has(relativePath);
    const absolute = path.resolve(root, relativePath);
    let identity;
    let verificationIdentity;
    if (absolute === root || !absolute.startsWith(`${root}${path.sep}`)) {
      identity = { kind: "outside" };
      verificationIdentity = identity;
    } else {
      try {
        const stat = fs.lstatSync(absolute, { bigint: true });
        const mode = Number(stat.mode & 0o7777n);
        if (stat.isSymbolicLink()) {
          identity = { kind: "symlink", mode, targetDigest: sha(fs.readlinkSync(absolute)) };
          verificationIdentity = identity;
        } else if (stat.isFile()) {
          const size = Number(stat.size);
          const safeSize = Number.isSafeInteger(size) && size >= 0;
          const mayHash = inFullSnapshot && safeSize && hashedBytes + size <= MAX_IGNORED_HASH_BYTES;
          const verificationMayHash = inVerificationSnapshot
            && safeSize
            && verificationHashedBytes + size <= MAX_IGNORED_HASH_BYTES;
          const contentDigest = mayHash || verificationMayHash ? hashFile(absolute) : null;
          const baseIdentity = {
            kind: "file",
            mode,
            size: stat.size.toString(),
            mtimeNs: stat.mtimeNs.toString()
          };
          identity = { ...baseIdentity, contentDigest: mayHash ? contentDigest : null };
          verificationIdentity = { ...baseIdentity, contentDigest: verificationMayHash ? contentDigest : null };
          if (mayHash) hashedBytes += size;
          if (verificationMayHash) verificationHashedBytes += size;
        } else if (stat.isDirectory()) {
          identity = { kind: "directory", mode, mtimeNs: stat.mtimeNs.toString() };
          verificationIdentity = identity;
        } else {
          identity = { kind: "other", mode, mtimeNs: stat.mtimeNs.toString() };
          verificationIdentity = identity;
        }
      } catch (error) {
        identity = { kind: error?.code === "ENOENT" ? "missing" : "unreadable", code: String(error?.code || "ERR").slice(0, 32) };
        verificationIdentity = identity;
      }
    }
    if (inFullSnapshot) {
      const fingerprint = canonicalJson(identity);
      digest.update(`${relativePath.length}:`);
      digest.update(relativePath);
      digest.update("\0");
      digest.update(fingerprint);
      digest.update("\0");
      if (attributable) entries.push({ path: relativePath.slice(0, 4096), fingerprint });
    }
    if (inVerificationSnapshot) {
      const fingerprint = canonicalJson(verificationIdentity);
      verificationDigest.update(`${relativePath.length}:`);
      verificationDigest.update(relativePath);
      verificationDigest.update("\0");
      verificationDigest.update(fingerprint);
      verificationDigest.update("\0");
      if (verificationAttributable) {
        verificationEntries.push({ path: relativePath.slice(0, 4096), fingerprint });
      }
    }
  }
  digest.update(`count=${allPaths.length};complete=${complete}`);
  verificationDigest.update(`count=${verificationCount};complete=${verificationComplete}`);
  return {
    digest: digest.digest("hex"),
    count: allPaths.length,
    entries,
    attributable,
    complete,
    verificationDigest: verificationDigest.digest("hex"),
    verificationCount,
    verificationEntries,
    verificationAttributable,
    verificationComplete
  };
}

/**
 * Legacy full Git-metadata file-tree identity (includes packed-refs + refs/).
 * Retained for pure-legacy and mixed-manifest comparisons. Uses the same hard
 * entry/byte/depth bounds and descriptor-bound hashing as task-relevant capture
 * so default hooks/refs/config cannot unboundedly readdir/sort/hash.
 */
function gitMetadataIdentity(gitDir, commonDir) {
  const entries = [];
  const state = {
    hashedBytes: 0,
    truncated: false,
    unreadable: false,
    depthExceeded: false
  };
  const roots = [
    [gitDir, ["HEAD", "commondir", "gitdir"]],
    [commonDir, ["config", "packed-refs", "refs", "hooks", "info/exclude", "info/attributes"]]
  ];
  visitGitMetadataEntries(entries, gitDir, commonDir, roots, state);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const truncated = state.truncated
    || state.unreadable
    || state.depthExceeded
    || entries.length >= MAX_GIT_METADATA_ENTRIES;
  return sha(canonicalJson({ entries, truncated }));
}

/**
 * Bigint-capable identity for a symlink hop (device/inode/mode/size/times).
 * Used only in transient private structures — never serialized publicly.
 */
function metadataSymlinkStatSignature(stat) {
  return [
    String(stat.dev),
    String(stat.ino),
    String(stat.mode),
    String(stat.size),
    String(stat.mtimeNs),
    String(stat.ctimeNs)
  ].join(":");
}

/**
 * Bigint-capable identity for the final non-symlink node after hop resolution.
 * Matches the file-stability fields so retarget/replace races fail closed.
 */
function metadataResolvedNodeStatSignature(stat) {
  return [
    String(stat.dev),
    String(stat.ino),
    String(stat.mode),
    String(stat.size),
    String(stat.mtimeNs),
    String(stat.ctimeNs)
  ].join(":");
}

/**
 * Follow a symlink chain with explicit hop bounds and cycle detection.
 * Returns private digests of each link text plus the final non-symlink node.
 * Also retains transient per-hop absolute path, bigint lstat identity, and
 * link-text digest so callers can revalidate after target capture.
 * Absolute paths and raw link text never leave this helper except as
 * transient locals (never serialized into entry records).
 * Shared by effective-hooks, operational, and non-ref metadata capture.
 */
function resolveMetadataSymlinkChain(startAbsolute, inheritedChain, maxHops = MAX_METADATA_SYMLINK_HOPS) {
  const linkDigests = [];
  /** @type {{ absolute: string, linkDigest: string, signature: string }[]} */
  const hops = [];
  const chain = new Set(inheritedChain);
  let current = startAbsolute;

  for (let hopCount = 0; hopCount < maxHops; hopCount += 1) {
    const resolvedCurrent = path.resolve(current);
    if (chain.has(resolvedCurrent)) {
      return { ok: false, reason: "cycle", linkDigests, hops };
    }
    chain.add(resolvedCurrent);

    let stat;
    try {
      stat = fs.lstatSync(current, { bigint: true });
    } catch {
      return { ok: false, reason: "broken", linkDigests, hops };
    }

    if (!stat.isSymbolicLink()) {
      return {
        ok: true,
        linkDigests,
        hops,
        finalAbsolute: current,
        finalStat: stat,
        finalSignature: metadataResolvedNodeStatSignature(stat),
        chain
      };
    }

    let linkText;
    try {
      linkText = fs.readlinkSync(current);
    } catch {
      return { ok: false, reason: "unreadable", linkDigests, hops };
    }
    // Digest only — never retain raw link text (may be absolute).
    const linkDigest = sha(String(linkText));
    linkDigests.push(linkDigest);
    // Private hop identity for post-capture revalidation only.
    hops.push({
      absolute: current,
      linkDigest,
      signature: metadataSymlinkStatSignature(stat)
    });
    current = path.resolve(path.dirname(current), String(linkText));
  }

  return { ok: false, reason: "hop-limit", linkDigests, hops };
}

/**
 * Re-lstat/readlink every original hop after target hashing or directory
 * traversal. Requires identical symlink identity and link-text digest, then
 * revalidates final target path identity. Missing, replaced, retargeted,
 * unreadable, or non-symlink hops fail closed. Private absolute paths and raw
 * link text never leave this helper.
 */
function revalidateMetadataSymlinkHops(hops, finalAbsolute, finalSignature, maxHops = MAX_METADATA_SYMLINK_HOPS) {
  if (!Array.isArray(hops) || hops.length === 0) {
    return { ok: false, reason: "broken" };
  }
  if (hops.length > maxHops) {
    return { ok: false, reason: "hop-limit" };
  }

  for (const hop of hops) {
    if (!hop || typeof hop.absolute !== "string" || typeof hop.linkDigest !== "string") {
      return { ok: false, reason: "unreadable" };
    }
    let stat;
    try {
      stat = fs.lstatSync(hop.absolute, { bigint: true });
    } catch {
      return { ok: false, reason: "broken" };
    }
    if (!stat.isSymbolicLink()) {
      return { ok: false, reason: "replaced" };
    }
    if (metadataSymlinkStatSignature(stat) !== hop.signature) {
      return { ok: false, reason: "replaced" };
    }
    let linkText;
    try {
      linkText = fs.readlinkSync(hop.absolute);
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    if (sha(String(linkText)) !== hop.linkDigest) {
      return { ok: false, reason: "retargeted" };
    }
  }

  if (typeof finalAbsolute === "string" && typeof finalSignature === "string") {
    let finalStat;
    try {
      finalStat = fs.lstatSync(finalAbsolute, { bigint: true });
    } catch {
      return { ok: false, reason: "broken" };
    }
    // Resolved final must remain a non-symlink node with the same identity
    // observed at hop resolution (no silent target replace/swap).
    if (finalStat.isSymbolicLink()) {
      return { ok: false, reason: "retargeted" };
    }
    if (metadataResolvedNodeStatSignature(finalStat) !== finalSignature) {
      return { ok: false, reason: "replaced" };
    }
  }

  return { ok: true };
}

/**
 * Map hop revalidation / chain failure reasons onto visit state flags.
 */
function applyMetadataSymlinkFailure(state, reason) {
  if (reason === "cycle") state.cyclic = true;
  else if (reason === "hop-limit") state.depthExceeded = true;
  else state.unreadable = true;
}

/**
 * Bigint-capable identity for an ordinary (non-symlink) directory node.
 * Used to bind enumeration/traversal snapshots so post-EOF growth, child
 * removal, and replace races fail closed without serializing paths.
 * Within-capture only — includes nlink/size/mtime/ctime that move when
 * unrelated children appear or disappear under the directory.
 */
function metadataDirectoryStatSignature(stat) {
  return [
    String(stat.dev),
    String(stat.ino),
    String(stat.mode),
    String(stat.nlink),
    String(stat.size),
    String(stat.mtimeNs),
    String(stat.ctimeNs)
  ].join(":");
}

/**
 * Stable identity for a lexical path component (directory, file, or symlink
 * node). Binds replacement (dev/ino) and type/chmod (mode) without directory
 * enumeration volatility (nlink/size/mtime/ctime) that changes when unrelated
 * siblings are created, modified, or removed under an ancestor.
 * Used for both cross-capture hooks hop digests and same-capture lexical hop
 * revalidation. Full metadataDirectoryStatSignature / file / symlink signatures
 * remain for metadata tree enumeration and content hashing race checks only.
 * Digested into hooks identity only — never serialized raw.
 */
function metadataLexicalNodeStableSignature(stat) {
  return [
    String(stat.dev),
    String(stat.ino),
    String(stat.mode)
  ].join(":");
}

/**
 * True when both stats describe the same ordinary directory identity snapshot.
 */
function sameMetadataDirectoryStat(left, right) {
  return Boolean(
    left
    && right
    && left.isDirectory()
    && right.isDirectory()
    && !left.isSymbolicLink()
    && !right.isSymbolicLink()
    && metadataDirectoryStatSignature(left) === metadataDirectoryStatSignature(right)
  );
}

/**
 * Descriptor-bound directory listing capped at remaining entry capacity + 1.
 * Captures bigint directory identity before open and re-checks it after EOF so
 * mid-list mutation fails closed. Stops immediately on overflow without
 * materializing the full directory. Within-bound names are sorted for
 * deterministic walks. Absolute paths never enter returned records.
 */
function listDirectoryNamesBounded(dirAbsolute, maxNames) {
  const capacity = Number.isSafeInteger(maxNames) && maxNames > 0 ? maxNames : 0;
  const limit = capacity + 1;
  let beforeStat;
  try {
    beforeStat = fs.lstatSync(dirAbsolute, { bigint: true });
  } catch (error) {
    const err = new Error("directory-unreadable");
    err.cause = error;
    throw err;
  }
  if (!beforeStat.isDirectory() || beforeStat.isSymbolicLink()) {
    const err = new Error("directory-not-directory");
    throw err;
  }
  const directorySignature = metadataDirectoryStatSignature(beforeStat);
  const names = [];
  let handle = null;
  try {
    handle = fs.opendirSync(dirAbsolute);
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      const name = entry?.name;
      if (typeof name !== "string" || !name || name === "." || name === "..") continue;
      names.push(name);
      if (names.length >= limit) break;
    }
  } finally {
    if (handle != null) {
      try { handle.closeSync(); } catch { /* ignore close races */ }
    }
  }
  // Re-bind directory identity immediately after enumeration closes so
  // mid-list additions/removals that change directory metadata fail closed.
  let afterStat;
  try {
    afterStat = fs.lstatSync(dirAbsolute, { bigint: true });
  } catch {
    const err = new Error("directory-mutated");
    throw err;
  }
  if (!sameMetadataDirectoryStat(beforeStat, afterStat)) {
    const err = new Error("directory-mutated");
    throw err;
  }
  if (names.length > capacity) {
    return { names: [], truncated: true, directorySignature };
  }
  names.sort((left, right) => left.localeCompare(right));
  return {
    names,
    truncated: false,
    directorySignature,
    stableSignature: metadataLexicalNodeStableSignature(beforeStat)
  };
}

/**
 * After child traversal (or immediately after a stable empty listing), confirm
 * the ordinary directory still has the same bigint identity and the same
 * bounded name set. Detects post-EOF growth and listed-child disappearance
 * without unbounded re-listing (at most expectedNames.length + 1 reads).
 * Absolute paths never leave this helper.
 */
function revalidateBoundedDirectorySnapshot(dirAbsolute, directorySignature, expectedNames) {
  if (typeof directorySignature !== "string" || !Array.isArray(expectedNames)) {
    return { ok: false, reason: "unreadable" };
  }
  let stat;
  try {
    stat = fs.lstatSync(dirAbsolute, { bigint: true });
  } catch {
    return { ok: false, reason: "disappeared" };
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return { ok: false, reason: "replaced" };
  }
  if (metadataDirectoryStatSignature(stat) !== directorySignature) {
    return { ok: false, reason: "mutated" };
  }

  // Bounded re-list: capacity = prior name count; one extra name ⇒ growth.
  const capacity = expectedNames.length;
  const limit = capacity + 1;
  const names = [];
  let handle = null;
  try {
    handle = fs.opendirSync(dirAbsolute);
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      const name = entry?.name;
      if (typeof name !== "string" || !name || name === "." || name === "..") continue;
      names.push(name);
      if (names.length >= limit) break;
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    if (handle != null) {
      try { handle.closeSync(); } catch { /* ignore close races */ }
    }
  }
  if (names.length > capacity) {
    return { ok: false, reason: "grown" };
  }
  names.sort((left, right) => left.localeCompare(right));
  if (names.length !== expectedNames.length) {
    return { ok: false, reason: "mutated" };
  }
  for (let index = 0; index < names.length; index += 1) {
    if (names[index] !== expectedNames[index]) {
      return { ok: false, reason: "mutated" };
    }
  }

  // Final identity bind after the verification listing.
  let finalStat;
  try {
    finalStat = fs.lstatSync(dirAbsolute, { bigint: true });
  } catch {
    return { ok: false, reason: "disappeared" };
  }
  if (!sameMetadataDirectoryStat(stat, finalStat)
    || metadataDirectoryStatSignature(finalStat) !== directorySignature) {
    return { ok: false, reason: "mutated" };
  }
  return { ok: true };
}

/**
 * Bigint-capable identity for metadata file stability checks.
 * Compares device, inode, mode, size, and high-resolution mtime/ctime so
 * same-size in-place mutation and typical metadata churn fail closed.
 */
function metadataFileStatSignature(stat) {
  return [
    String(stat.dev),
    String(stat.ino),
    String(stat.mode),
    String(stat.size),
    String(stat.mtimeNs),
    String(stat.ctimeNs)
  ].join(":");
}

/**
 * True when both stats describe the same regular-file identity snapshot.
 * Uses lstat-friendly checks (symlink is never accepted as the captured file).
 */
function sameMetadataFileStat(left, right) {
  return Boolean(
    left
    && right
    && left.isFile()
    && right.isFile()
    && !left.isSymbolicLink()
    && !right.isSymbolicLink()
    && metadataFileStatSignature(left) === metadataFileStatSignature(right)
  );
}

/**
 * Descriptor-bound file content digest for private metadata identity.
 *
 * Reads at most the remaining byte budget + 1 from a stable open descriptor.
 * Before accepting a digest, re-validates full bigint metadata on the descriptor
 * and re-lstats the original path without following a newly introduced symlink
 * so path replacement, disappearance, symlink swap, or same-size mutation
 * (timestamp/mode/size identity drift) fails closed. Never retains path or raw
 * bytes beyond the local hash computation.
 */
function hashBoundedMetadataFile(absolute, state, maxBytes = MAX_METADATA_HASH_BYTES) {
  let descriptor;
  try {
    const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(absolute, openFlags);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      state.unreadable = true;
      return { kind: "unobservable", reason: "unreadable" };
    }
    // Path must name this same regular file at open time (no symlink/path swap).
    let pathBefore;
    try {
      pathBefore = fs.lstatSync(absolute, { bigint: true });
    } catch {
      state.unreadable = true;
      return { kind: "unobservable", reason: "unreadable" };
    }
    if (!sameMetadataFileStat(before, pathBefore)) {
      state.unreadable = true;
      return { kind: "unobservable", reason: "unreadable" };
    }

    const size = Number(before.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      state.unreadable = true;
      return { kind: "unobservable", reason: "unreadable" };
    }
    const modeBits = Number(before.mode & 0o7777n);

    const remaining = maxBytes - state.hashedBytes;
    if (!Number.isSafeInteger(remaining) || remaining < 0) {
      state.truncated = true;
      return { kind: "file", mode: modeBits, size, digest: null };
    }

    // Cap at remaining+1 so oversize content is detected without reading past budget+1.
    const readLimit = remaining + 1;
    const hash = crypto.createHash("sha256");
    const chunkSize = Math.min(64 * 1024, Math.max(readLimit, 1));
    const buffer = Buffer.allocUnsafe(chunkSize);
    let totalRead = 0;
    while (totalRead < readLimit) {
      const want = Math.min(buffer.length, readLimit - totalRead);
      const count = fs.readSync(descriptor, buffer, 0, want, totalRead);
      if (count === 0) break;
      if (totalRead < remaining) {
        const withinBudget = Math.min(count, remaining - totalRead);
        if (withinBudget > 0) hash.update(buffer.subarray(0, withinBudget));
      }
      totalRead += count;
    }

    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameMetadataFileStat(before, after)) {
      state.unreadable = true;
      return { kind: "unobservable", reason: "unreadable" };
    }

    // Re-lstat the original path without following a newly introduced symlink.
    // Path replacement leaves the descriptor on the detached old inode; this
    // check requires the path still names that same regular-file identity.
    let pathAfter;
    try {
      pathAfter = fs.lstatSync(absolute, { bigint: true });
    } catch {
      state.unreadable = true;
      return { kind: "unobservable", reason: "unreadable" };
    }
    if (!sameMetadataFileStat(before, pathAfter)) {
      state.unreadable = true;
      return { kind: "unobservable", reason: "unreadable" };
    }

    // Content exceeds remaining budget (observed via remaining+1 probe or size claim).
    if (totalRead > remaining || size > remaining) {
      state.truncated = true;
      return { kind: "file", mode: modeBits, size, digest: null };
    }

    // Short read against a stable size, or extra bytes beyond the size claim.
    if (totalRead !== size) {
      state.unreadable = true;
      return { kind: "unobservable", reason: "unreadable" };
    }

    state.hashedBytes += size;
    return {
      kind: "file",
      mode: modeBits,
      size,
      digest: hash.digest("hex")
    };
  } catch {
    state.unreadable = true;
    return { kind: "unobservable", reason: "unreadable" };
  } finally {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch { /* ignore close races */ }
    }
  }
}

/**
 * Public-safe file identity fields from a bounded hash result (no paths).
 */
function publicMetadataFileTarget(fileIdentity) {
  if (!fileIdentity || fileIdentity.kind === "unobservable") {
    return fileIdentity || { kind: "unobservable", reason: "unreadable" };
  }
  return {
    kind: "file",
    mode: fileIdentity.mode,
    size: fileIdentity.size,
    digest: fileIdentity.digest
  };
}

/**
 * Descriptor-bound nofollow text read capped at maxBytes + 1.
 *
 * Used for loose refs and reftable markers so oversize bodies fail closed without
 * unbounded I/O. Revalidates path/stat identity around the read. Never follows
 * symlinks (O_NOFOLLOW when available). Absolute paths stay local.
 *
 * @returns {{ ok: true, body: string } | { ok: false, reason: string }}
 */
function readBoundedNofollowTextFile(absolute, maxBytes = MAX_LOOSE_REF_BODY_BYTES) {
  if (typeof absolute !== "string" || !absolute || !path.isAbsolute(absolute)) {
    return { ok: false, reason: "invalid" };
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    return { ok: false, reason: "bound" };
  }
  let descriptor = null;
  try {
    const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(absolute, openFlags);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) {
      return { ok: false, reason: "not-file" };
    }
    let pathBefore;
    try {
      pathBefore = fs.lstatSync(absolute, { bigint: true });
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    if (!sameMetadataFileStat(before, pathBefore)) {
      return { ok: false, reason: "replaced" };
    }
    const size = Number(before.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      return { ok: false, reason: "unreadable" };
    }
    // Always probe at most accepted body limit + 1 byte. Never trust size alone
    // to skip the capped read (size can race), and never read past the bound
    // even when size claims to be huge.
    const readLimit = maxBytes + 1;
    const chunks = [];
    let totalRead = 0;
    const chunkSize = Math.min(64 * 1024, Math.max(readLimit, 1));
    const buffer = Buffer.allocUnsafe(chunkSize);
    while (totalRead < readLimit) {
      const want = Math.min(buffer.length, readLimit - totalRead);
      const count = fs.readSync(descriptor, buffer, 0, want, totalRead);
      if (count === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, count)));
      totalRead += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameMetadataFileStat(before, after)) {
      return { ok: false, reason: "mutated" };
    }
    let pathAfter;
    try {
      pathAfter = fs.lstatSync(absolute, { bigint: true });
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    if (!sameMetadataFileStat(before, pathAfter)) {
      return { ok: false, reason: "replaced" };
    }
    if (totalRead > maxBytes || size > maxBytes) {
      return { ok: false, reason: "oversize" };
    }
    // Stable within-bound size must match bytes actually read.
    if (totalRead !== size) {
      return { ok: false, reason: "short-read" };
    }
    const contents = Buffer.concat(chunks, totalRead);
    return {
      ok: true,
      body: contents.toString("utf8"),
      bodyDigest: sha(contents),
      fileSignature: metadataFileStatSignature(before),
      mode: Number(before.mode & 0o7777n),
      size
    };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch { /* ignore close races */ }
    }
  }
}

/**
 * Re-hash a previously captured ordinary file and require identical
 * descriptor-validated mode/size/digest. Uses an isolated byte budget equal to
 * the captured size so parent hashedBytes is not double-counted and I/O stays
 * proportional to prior capture (not unbounded).
 */
function revalidateCapturedFileSnapshot(snapshot) {
  if (
    !snapshot
    || snapshot.kind !== "file"
    || typeof snapshot.absolute !== "string"
    || !Number.isSafeInteger(snapshot.mode)
    || !Number.isSafeInteger(snapshot.size)
    || snapshot.size < 0
  ) {
    return { ok: false, reason: "unreadable" };
  }
  const probe = { hashedBytes: 0, unreadable: false, truncated: false };
  const result = hashBoundedMetadataFile(snapshot.absolute, probe, snapshot.size);
  if (probe.unreadable || result.kind === "unobservable") {
    return { ok: false, reason: "unreadable" };
  }
  if (probe.truncated || result.digest == null) {
    // Grew past captured size, or captured was truncated — either is drift.
    if (snapshot.digest == null && probe.truncated && result.size === snapshot.size) {
      return { ok: true };
    }
    return { ok: false, reason: "mutated" };
  }
  if (
    result.mode !== snapshot.mode
    || result.size !== snapshot.size
    || result.digest !== snapshot.digest
  ) {
    return { ok: false, reason: "mutated" };
  }
  return { ok: true };
}

/**
 * Revalidate private snapshots for already-captured directory children so
 * sibling-after-hash content/mode/hop drift fails closed. Runs in O(children)
 * per directory (at most one re-hash per captured file along each ancestor
 * path, depth-capped). Absolute paths stay transient.
 */
function revalidateCapturedChildSnapshots(snapshots) {
  if (!Array.isArray(snapshots)) return { ok: true };
  for (const snapshot of snapshots) {
    if (!snapshot || typeof snapshot !== "object") continue;
    if (snapshot.kind === "file") {
      const fileCheck = revalidateCapturedFileSnapshot(snapshot);
      if (!fileCheck.ok) return fileCheck;
      continue;
    }
    if (snapshot.kind === "symlink") {
      const hopCheck = revalidateMetadataSymlinkHops(
        snapshot.hops,
        snapshot.finalAbsolute,
        snapshot.finalSignature,
        snapshot.maxHops
      );
      if (!hopCheck.ok) return { ok: false, reason: hopCheck.reason || "retargeted" };
      if (snapshot.targetKind === "file") {
        const fileCheck = revalidateCapturedFileSnapshot({
          kind: "file",
          absolute: snapshot.finalAbsolute,
          mode: snapshot.targetMode,
          size: snapshot.targetSize,
          digest: snapshot.targetDigest
        });
        if (!fileCheck.ok) return fileCheck;
      } else if (snapshot.targetKind === "directory") {
        const dirCheck = revalidateBoundedDirectorySnapshot(
          snapshot.finalAbsolute,
          snapshot.directorySignature,
          snapshot.names
        );
        if (!dirCheck.ok) return dirCheck;
        const childCheck = revalidateCapturedChildSnapshots(snapshot.children);
        if (!childCheck.ok) return childCheck;
      }
      continue;
    }
    if (snapshot.kind === "directory") {
      const dirCheck = revalidateBoundedDirectorySnapshot(
        snapshot.absolute,
        snapshot.directorySignature,
        snapshot.names
      );
      if (!dirCheck.ok) return dirCheck;
      const childCheck = revalidateCapturedChildSnapshots(snapshot.children);
      if (!childCheck.ok) return childCheck;
    }
  }
  return { ok: true };
}

/**
 * Revalidate top-level optional root witnesses after a fixed capture batch.
 *
 * Stable absence is valid and remains complete, but every absent root must be
 * re-lstat'd so a root that appears after its early ENOENT fails closed.
 * Present roots re-use the same bounded child/file/symlink revalidation so
 * disappearance, replace, or mutation while later siblings are hashed also
 * fails closed. Absolute paths stay transient and never enter public records.
 */
function revalidateOptionalRootWitnesses(witnesses, state) {
  if (!Array.isArray(witnesses)) {
    state.unreadable = true;
    return;
  }
  for (const witness of witnesses) {
    if (!witness || typeof witness !== "object" || typeof witness.kind !== "string") {
      state.unreadable = true;
      return;
    }
    if (witness.kind === "absent") {
      if (typeof witness.absolute !== "string" || !witness.absolute) {
        state.unreadable = true;
        return;
      }
      try {
        fs.lstatSync(witness.absolute);
        // Optional root appeared after its batch-start absence witness.
        state.unreadable = true;
        return;
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        state.unreadable = true;
        return;
      }
    }
    if (witness.kind === "file" || witness.kind === "directory" || witness.kind === "symlink") {
      const check = revalidateCapturedChildSnapshots([witness]);
      if (!check.ok) {
        state.unreadable = true;
        return;
      }
      continue;
    }
    if (witness.kind === "other-root") {
      if (typeof witness.absolute !== "string" || !witness.absolute) {
        state.unreadable = true;
        return;
      }
      let stat;
      try {
        stat = fs.lstatSync(witness.absolute);
      } catch {
        state.unreadable = true;
        return;
      }
      // Type replacement (became file/dir/symlink) is drift.
      if (stat.isFile() || stat.isDirectory() || stat.isSymbolicLink()) {
        state.unreadable = true;
        return;
      }
      continue;
    }
    if (witness.kind === "legacy-present") {
      if (typeof witness.absolute !== "string" || !witness.absolute) {
        state.unreadable = true;
        return;
      }
      let stat;
      try {
        stat = fs.lstatSync(witness.absolute, { bigint: true });
      } catch {
        state.unreadable = true;
        return;
      }
      if (witness.nodeKind === "file") {
        if (!stat.isFile() || stat.isSymbolicLink()) {
          state.unreadable = true;
          return;
        }
        const fileCheck = revalidateCapturedFileSnapshot({
          kind: "file",
          absolute: witness.absolute,
          mode: witness.mode,
          size: witness.size,
          digest: witness.digest
        });
        if (!fileCheck.ok) {
          state.unreadable = true;
          return;
        }
        continue;
      }
      if (witness.nodeKind === "symlink") {
        if (!stat.isSymbolicLink()) {
          state.unreadable = true;
          return;
        }
        if (metadataSymlinkStatSignature(stat) !== witness.signature) {
          state.unreadable = true;
          return;
        }
        let linkText;
        try {
          linkText = fs.readlinkSync(witness.absolute);
        } catch {
          state.unreadable = true;
          return;
        }
        if (sha(String(linkText)) !== witness.linkDigest) {
          state.unreadable = true;
          return;
        }
        continue;
      }
      if (witness.nodeKind === "directory") {
        const dirCheck = revalidateBoundedDirectorySnapshot(
          witness.absolute,
          witness.directorySignature,
          witness.names
        );
        if (!dirCheck.ok) {
          state.unreadable = true;
          return;
        }
        continue;
      }
      if (witness.nodeKind === "other") {
        if (stat.isFile() || stat.isDirectory() || stat.isSymbolicLink()) {
          state.unreadable = true;
          return;
        }
        continue;
      }
      state.unreadable = true;
      return;
    }
    state.unreadable = true;
    return;
  }
}

/**
 * Walk a metadata path tree binding symlink link-text digests and target
 * contents with entry/byte/depth/hop bounds and cycle detection. After file
 * target hashing and after directory traversal, every original symlink hop is
 * re-lstat/readlink-validated (identity + link digest) and the final target
 * path identity is rechecked so retarget/mutation races fail closed. Ordinary
 * (non-symlink) directories bind bigint identity around enumeration and
 * revalidate the bounded name set after traversal so post-EOF growth and
 * listed-child disappearance fail closed. After a directory subtree is
 * captured, already-captured child identities (ordinary files and symlink
 * hops/final targets) are revalidated so sibling-after-hash drift fails closed.
 * Ordinary file entries serialize only descriptor-validated mode/size/digest.
 * Optional top-level roots that were absent before capture still treat ENOENT
 * as normal absence (returning a private absent witness for post-batch
 * revalidation); children already present in a bounded listing are required.
 * Absolute paths and raw link text never enter the returned entry records.
 * Returns a transient private child/root snapshot for parent/batch revalidation
 * (or null when the visit failed without a reusable witness).
 */
function visitBoundedMetadataTree(absolute, relativeKey, depth, chain, state, {
  maxDepth = MAX_METADATA_DEPTH,
  maxBytes = MAX_METADATA_HASH_BYTES,
  maxEntries = MAX_GIT_METADATA_ENTRIES,
  maxHops = MAX_METADATA_SYMLINK_HOPS,
  // When true, ENOENT means a listed child disappeared mid-capture (fail closed)
  // rather than an optional metadata root that was absent before listing.
  required = false
} = {}) {
  if (state.entries.length >= maxEntries) {
    state.truncated = true;
    return null;
  }
  if (depth > maxDepth) {
    state.depthExceeded = true;
    return null;
  }
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (required) {
        state.unreadable = true;
        return null;
      }
      // Optional root absence is valid; caller rechecks after the full batch.
      return { kind: "absent", absolute };
    }
    state.unreadable = true;
    return null;
  }
  const key = relativeKey || ".";
  const childVisitOptions = {
    maxDepth,
    maxBytes,
    maxEntries,
    maxHops,
    required: true
  };
  try {
    if (stat.isSymbolicLink()) {
      const mode = stat.mode & 0o7777;
      const resolved = resolveMetadataSymlinkChain(absolute, chain, maxHops);
      if (!resolved.ok) {
        applyMetadataSymlinkFailure(state, resolved.reason);
        state.entries.push({
          path: key,
          kind: "symlink",
          mode,
          linkDigests: resolved.linkDigests,
          target: { kind: "unobservable", reason: resolved.reason }
        });
        return null;
      }
      const {
        linkDigests,
        hops,
        finalAbsolute,
        finalStat,
        finalSignature,
        chain: nextChain
      } = resolved;
      const finalMode = Number(finalStat.mode & 0o7777n);
      if (finalStat.isFile()) {
        // Hash the resolved target first, then revalidate every hop so an
        // atomic retarget at open/hash boundaries cannot bind old link digests
        // to a target that is no longer live.
        const target = hashBoundedMetadataFile(finalAbsolute, state, maxBytes);
        const recheck = revalidateMetadataSymlinkHops(
          hops,
          finalAbsolute,
          finalSignature,
          maxHops
        );
        if (!recheck.ok) {
          applyMetadataSymlinkFailure(state, recheck.reason);
          state.entries.push({
            path: key,
            kind: "symlink",
            mode,
            linkDigests,
            target: { kind: "unobservable", reason: recheck.reason }
          });
          return null;
        }
        if (target.kind === "unobservable") {
          state.entries.push({
            path: key,
            kind: "symlink",
            mode,
            linkDigests,
            target
          });
          return null;
        }
        const publicTarget = publicMetadataFileTarget(target);
        state.entries.push({
          path: key,
          kind: "symlink",
          mode,
          linkDigests,
          target: publicTarget
        });
        return {
          kind: "symlink",
          hops,
          finalAbsolute,
          finalSignature,
          maxHops,
          targetKind: "file",
          targetMode: target.mode,
          targetSize: target.size,
          targetDigest: target.digest
        };
      }
      if (finalStat.isDirectory()) {
        const directoryEntryIndex = state.entries.length;
        state.entries.push({
          path: key,
          kind: "symlink",
          mode,
          linkDigests,
          target: { kind: "directory", mode: finalMode }
        });
        const finalResolved = path.resolve(finalAbsolute);
        if (chain.has(finalResolved)) {
          state.cyclic = true;
          return null;
        }
        let listed;
        try {
          listed = listDirectoryNamesBounded(
            finalAbsolute,
            maxEntries - state.entries.length
          );
        } catch {
          state.unreadable = true;
          return null;
        }
        if (listed.truncated) {
          state.truncated = true;
          return null;
        }
        const childSnapshots = [];
        for (const name of listed.names) {
          if (state.entries.length >= maxEntries || state.truncated) {
            state.truncated = true;
            break;
          }
          const childKey = relativeKey ? `${relativeKey}/${name}` : name;
          const childSnap = visitBoundedMetadataTree(
            path.join(finalAbsolute, name),
            childKey,
            depth + 1,
            nextChain,
            state,
            childVisitOptions
          );
          if (childSnap) childSnapshots.push(childSnap);
        }
        // Revalidate membership, already-captured children, then symlink hops.
        if (!state.truncated) {
          const dirRecheck = revalidateBoundedDirectorySnapshot(
            finalAbsolute,
            listed.directorySignature,
            listed.names
          );
          if (!dirRecheck.ok) {
            state.unreadable = true;
            const entry = state.entries[directoryEntryIndex];
            if (entry && entry.kind === "symlink" && entry.path === key) {
              entry.target = { kind: "unobservable", reason: dirRecheck.reason };
            }
          } else {
            const childRecheck = revalidateCapturedChildSnapshots(childSnapshots);
            if (!childRecheck.ok) {
              state.unreadable = true;
              const entry = state.entries[directoryEntryIndex];
              if (entry && entry.kind === "symlink" && entry.path === key) {
                entry.target = { kind: "unobservable", reason: childRecheck.reason };
              }
            }
          }
        }
        const recheck = revalidateMetadataSymlinkHops(
          hops,
          finalAbsolute,
          finalSignature,
          maxHops
        );
        if (!recheck.ok) {
          applyMetadataSymlinkFailure(state, recheck.reason);
          // Mark the symlink entry itself unobservable; children may already
          // be recorded from the pre-retarget target — fail closed via flags.
          const entry = state.entries[directoryEntryIndex];
          if (entry && entry.kind === "symlink" && entry.path === key) {
            entry.target = { kind: "unobservable", reason: recheck.reason };
          }
          return null;
        }
        return {
          kind: "symlink",
          hops,
          finalAbsolute,
          finalSignature,
          maxHops,
          targetKind: "directory",
          directorySignature: listed.directorySignature,
          names: listed.names,
          children: childSnapshots
        };
      }
      // Non-file/dir final nodes: still revalidate hops so retarget races
      // cannot freeze a stale other-node snapshot as complete.
      const recheckOther = revalidateMetadataSymlinkHops(
        hops,
        finalAbsolute,
        finalSignature,
        maxHops
      );
      if (!recheckOther.ok) {
        applyMetadataSymlinkFailure(state, recheckOther.reason);
        state.entries.push({
          path: key,
          kind: "symlink",
          mode,
          linkDigests,
          target: { kind: "unobservable", reason: recheckOther.reason }
        });
        return null;
      }
      state.entries.push({
        path: key,
        kind: "symlink",
        mode,
        linkDigests,
        target: { kind: "other", mode: finalMode }
      });
      return {
        kind: "symlink",
        hops,
        finalAbsolute,
        finalSignature,
        maxHops,
        targetKind: "other"
      };
    }
    if (stat.isFile()) {
      // Serialize only descriptor-validated identity — never pre-open lstat mode.
      const fileIdentity = hashBoundedMetadataFile(absolute, state, maxBytes);
      if (fileIdentity.kind === "unobservable") {
        state.entries.push({
          path: key,
          kind: "file",
          target: fileIdentity
        });
        return null;
      }
      state.entries.push({
        path: key,
        kind: "file",
        mode: fileIdentity.mode,
        size: fileIdentity.size,
        digest: fileIdentity.digest
      });
      return {
        kind: "file",
        absolute,
        mode: fileIdentity.mode,
        size: fileIdentity.size,
        digest: fileIdentity.digest
      };
    }
    if (!stat.isDirectory()) {
      state.entries.push({ path: key, kind: "other", mode: stat.mode & 0o7777 });
      // Top-level optional "other" nodes still need a batch presence witness.
      return { kind: "other-root", absolute };
    }
    if (relativeKey !== "") {
      state.entries.push({ path: key, kind: "directory", mode: stat.mode & 0o7777 });
    }
    const dirResolved = path.resolve(absolute);
    if (chain.has(dirResolved)) {
      state.cyclic = true;
      return null;
    }
    const nextChain = new Set(chain);
    nextChain.add(dirResolved);
    let listed;
    try {
      listed = listDirectoryNamesBounded(absolute, maxEntries - state.entries.length);
    } catch {
      state.unreadable = true;
      return null;
    }
    if (listed.truncated) {
      state.truncated = true;
      return null;
    }
    const childSnapshots = [];
    for (const name of listed.names) {
      if (state.entries.length >= maxEntries || state.truncated) {
        state.truncated = true;
        break;
      }
      const childKey = relativeKey ? `${relativeKey}/${name}` : name;
      const childSnap = visitBoundedMetadataTree(
        path.join(absolute, name),
        childKey,
        depth + 1,
        nextChain,
        state,
        childVisitOptions
      );
      if (childSnap) childSnapshots.push(childSnap);
    }
    // Ordinary non-symlink directories: re-bind identity/membership, then
    // revalidate already-captured children so sibling-after-hash content/mode
    // drift fails closed even when parent dir stat/name set is unchanged.
    if (!state.truncated) {
      const dirRecheck = revalidateBoundedDirectorySnapshot(
        absolute,
        listed.directorySignature,
        listed.names
      );
      if (!dirRecheck.ok) {
        state.unreadable = true;
      } else {
        const childRecheck = revalidateCapturedChildSnapshots(childSnapshots);
        if (!childRecheck.ok) {
          state.unreadable = true;
        }
      }
    }
    return {
      kind: "directory",
      absolute,
      directorySignature: listed.directorySignature,
      names: listed.names,
      children: childSnapshots
    };
  } catch {
    state.unreadable = true;
    return null;
  }
}

function createMetadataVisitState() {
  return {
    entries: [],
    hashedBytes: 0,
    depthExceeded: false,
    unreadable: false,
    truncated: false,
    cyclic: false
  };
}

/**
 * Task-relevant non-ref metadata: worktree-local Git controls, shared config/
 * info, and semantic controls (shallow/grafts/alternates). Symlink entries bind
 * both link identity and target contents (cycle/bound safe). Refs are not
 * hashed as files; they are classified semantically via for-each-ref. Effective
 * hooks and effective included config are captured separately.
 *
 * Includes the effective worktree `info/sparse-checkout` control file so
 * linked/primary sparse pattern drift changes task-relevant identity. Cone and
 * index sparse settings bind through the separately captured effective config.
 * Top-level optional roots (present and absent) are revalidated after the full
 * batch so mid-capture appearance/disappearance fails closed.
 */
function captureTaskRelevantNonRefEntries(gitDir, commonDir) {
  const state = createMetadataVisitState();
  const roots = [
    [gitDir, [
      "HEAD",
      "commondir",
      "gitdir",
      "config.worktree",
      // Effective worktree sparse-checkout patterns (private digest only).
      "info/sparse-checkout"
    ]],
    [commonDir, [
      "config",
      "info/exclude",
      "info/attributes",
      "info/grafts",
      "shallow",
      "objects/info/alternates"
    ]]
  ];
  const rootWitnesses = [];
  for (const [base, relatives] of roots) {
    if (!base) {
      state.unreadable = true;
      continue;
    }
    for (const relative of relatives) {
      const key = `${base === gitDir ? "git" : "common"}/${relative.replace(/\\/g, "/")}`;
      const witness = visitBoundedMetadataTree(
        path.join(base, relative),
        key,
        0,
        new Set(),
        state
      );
      if (witness) rootWitnesses.push(witness);
    }
  }
  // Final present/absent revalidation of the complete non-ref root set.
  if (!state.truncated && !state.depthExceeded) {
    revalidateOptionalRootWitnesses(rootWitnesses, state);
  }
  state.entries.sort((left, right) => left.path.localeCompare(right.path));
  const failClosed = state.truncated
    || state.depthExceeded
    || state.unreadable
    || state.cyclic
    || state.entries.length >= MAX_GIT_METADATA_ENTRIES;
  return {
    entries: state.entries,
    truncated: failClosed,
    observable: !failClosed,
    identity: sha(canonicalJson({
      schema: "nonref-v2",
      entries: state.entries,
      truncated: failClosed,
      depthExceeded: state.depthExceeded,
      unreadable: state.unreadable,
      cyclic: state.cyclic
    }))
  };
}

/**
 * Resolve a fixed OID-bearing operational root pseudoref exactly.
 *
 * Never accepts DWIM tag/branch resolution and never ignores ambiguity stderr.
 * Prefer `for-each-ref --include-root-refs` (exact root inventory, backend-aware
 * for reftable and files). Fall back to rev-parse without --quiet plus
 * symbolic-full-name === name so refs/tags/BISECT_HEAD cannot masquerade as the
 * root. Status non-zero / empty include-root inventory is stable absence.
 *
 * @returns {{ kind: "absent" } | { kind: "oid", oidDigest: string } | { kind: "unobservable" }}
 */
function resolveExactRootPseudoref(workspaceRoot, name) {
  if (!workspaceRoot || typeof name !== "string" || !name) {
    return { kind: "unobservable" };
  }

  // Exact root-ref inventory when Git supports it (reftable + files).
  const includeRun = git(
    workspaceRoot,
    [
      "for-each-ref",
      "--include-root-refs",
      "--format=%(refname)%00%(objectname)%0a",
      "--",
      name
    ],
    { allowFailure: true }
  );
  const includeStderr = String(includeRun.stderr || "");
  const includeUnsupported = Boolean(includeRun.error)
    || includeRun.status === 129
    || /unknown option|include-root-refs/i.test(includeStderr);
  if (!includeUnsupported) {
    // Hard command failure or any diagnostic is unobservable. In particular,
    // never reinterpret a malformed root pseudoref warning as stable absence.
    if (includeRun.status !== 0 && includeRun.status !== 1) {
      return { kind: "unobservable" };
    }
    if (includeStderr.trim()) {
      return { kind: "unobservable" };
    }
    let matchedOid = null;
    for (const line of String(includeRun.stdout || "").split("\n")) {
      if (!line) continue;
      const parts = line.split("\0");
      const refname = parts[0] || "";
      const objectname = String(parts[1] || "").trim().toLowerCase();
      if (refname !== name) {
        // An exact root-name query must not surface a different ref.
        return { kind: "unobservable" };
      }
      if (!/^[a-f0-9]{40,64}$/.test(objectname)) {
        return { kind: "unobservable" };
      }
      if (matchedOid && matchedOid !== objectname) {
        return { kind: "unobservable" };
      }
      matchedOid = objectname;
    }
    if (matchedOid) {
      return { kind: "oid", oidDigest: sha(matchedOid) };
    }
    return { kind: "absent" };
  }

  // Fallback: rev-parse without --quiet so ambiguity diagnostics surface.
  const run = git(
    workspaceRoot,
    ["rev-parse", "--verify", "--end-of-options", name],
    { allowFailure: true }
  );
  if (run.error) return { kind: "unobservable" };
  if (run.status !== 0) {
    // Missing root pseudoref is normal. Do not interpret fatal stderr as a race.
    return { kind: "absent" };
  }
  // Present resolves must be quiet and unambiguous.
  if (String(run.stderr || "").trim()) {
    return { kind: "unobservable" };
  }
  const oid = String(run.stdout || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(oid)) {
    return { kind: "unobservable" };
  }
  // Confirm Git resolved the root name, not refs/tags/NAME (DWIM).
  const fullRun = git(
    workspaceRoot,
    ["rev-parse", "--verify", "--symbolic-full-name", "--end-of-options", name],
    { allowFailure: true }
  );
  if (fullRun.error) return { kind: "unobservable" };
  if (String(fullRun.stderr || "").trim()) {
    return { kind: "unobservable" };
  }
  if (fullRun.status !== 0) {
    // OID resolved but full name did not — untrustworthy for exact root capture.
    return { kind: "unobservable" };
  }
  const fullName = String(fullRun.stdout || "").trim();
  if (fullName !== name) {
    // DWIM to refs/tags/BISECT_HEAD (etc.) — root pseudoref is absent.
    return { kind: "absent" };
  }
  return { kind: "oid", oidDigest: sha(oid) };
}

/**
 * Backend-aware capture of fixed OID-bearing operational root pseudorefs.
 * Uses exact Git resolution so reftable backends (no loose BISECT_HEAD file)
 * still observe create/change/remove, and DWIM tag resolution / ambiguity
 * stderr cannot hide root create or remove. Stable absence is valid. Results
 * are private digests only — never raw paths. Revalidates after the batch so
 * mid-capture races fail closed.
 */
function captureOperationalPseudorefIdentity(workspaceRoot) {
  if (!workspaceRoot) {
    return { records: [], complete: false, observable: false };
  }
  const records = [];
  let unreadable = false;
  for (const name of WORKTREE_OPERATIONAL_PSEUDOREFS) {
    const resolved = resolveExactRootPseudoref(workspaceRoot, name);
    if (resolved.kind === "unobservable") {
      unreadable = true;
      records.push({ name, kind: "unobservable" });
      continue;
    }
    if (resolved.kind === "absent") {
      records.push({ name, kind: "absent" });
      continue;
    }
    // Digest only — identity structure stays private via outer hash.
    records.push({ name, kind: "oid", oidDigest: resolved.oidDigest });
  }
  // Revalidate the complete fixed set after capture (appear/disappear/mutate/DWIM).
  if (!unreadable) {
    for (const record of records) {
      const resolved = resolveExactRootPseudoref(workspaceRoot, record.name);
      if (resolved.kind === "unobservable") {
        unreadable = true;
        break;
      }
      if (record.kind === "absent") {
        if (resolved.kind !== "absent") {
          unreadable = true;
          break;
        }
        continue;
      }
      if (record.kind === "oid") {
        if (resolved.kind !== "oid" || resolved.oidDigest !== record.oidDigest) {
          unreadable = true;
          break;
        }
        continue;
      }
      unreadable = true;
      break;
    }
  }
  records.sort((left, right) => left.name.localeCompare(right.name));
  const failClosed = unreadable;
  return {
    records,
    complete: !failClosed,
    observable: !failClosed,
    identity: sha(canonicalJson({
      schema: "operational-pseudorefs-v2",
      records,
      unreadable: failClosed
    }))
  };
}

/**
 * Hash task-relevant worktree operational state (MERGE_HEAD, MERGE_AUTOSTASH,
 * sequencer/rebase, and related controls) from the effective worktree Git
 * directory plus backend-aware Git resolution of OID-bearing root pseudorefs.
 * Symlinks bind link text and target contents. Changes must surface as
 * task-relevant metadata drift even when unrelated shared refs also change.
 * Present and absent top-level operational roots are witnessed and revalidated
 * after the full fixed inventory so mid-batch create/remove/replace races fail
 * closed without treating stable absence as an error.
 */
function captureWorktreeOperationalIdentity(gitDir, workspaceRoot = null) {
  if (!gitDir) {
    return {
      identity: sha("operational-v2:unavailable"),
      truncated: true,
      observable: false
    };
  }
  const state = createMetadataVisitState();
  const rootWitnesses = [];
  for (const relative of WORKTREE_OPERATIONAL_PATHS) {
    const witness = visitBoundedMetadataTree(
      path.join(gitDir, relative),
      relative.replace(/\\/g, "/"),
      0,
      new Set(),
      state
    );
    if (witness) rootWitnesses.push(witness);
  }
  // Final present/absent revalidation of the complete operational root set.
  if (!state.truncated && !state.depthExceeded) {
    revalidateOptionalRootWitnesses(rootWitnesses, state);
  }
  state.entries.sort((left, right) => left.path.localeCompare(right.path));
  const pseudorefs = captureOperationalPseudorefIdentity(workspaceRoot || null);
  const failClosed = state.truncated
    || state.depthExceeded
    || state.unreadable
    || state.cyclic
    || state.entries.length >= MAX_GIT_METADATA_ENTRIES
    || !pseudorefs.observable
    || !pseudorefs.complete;
  return {
    identity: sha(canonicalJson({
      schema: "operational-v3",
      entries: state.entries,
      pseudorefIdentity: pseudorefs.identity,
      truncated: failClosed,
      depthExceeded: state.depthExceeded,
      unreadable: state.unreadable,
      cyclic: state.cyclic
    })),
    truncated: failClosed,
    observable: !failClosed
  };
}

/**
 * Private digest of effective repository/worktree Git config with includes
 * resolved by Git (`--includes`). Only key/value digests are retained — never
 * raw values, origins, absolute paths, credentials, or included file
 * contents/paths. Entry and byte budgets are enforced across the combined
 * local+worktree inventory. Fail closed on resolution, read, parse, size, or
 * observability errors.
 */
function captureEffectiveGitConfigIdentity(workspaceRoot) {
  const scopes = [];
  let totalEntries = 0;
  let totalValueBytes = 0;
  let truncated = false;
  let unreadable = false;

  const parseNullConfigList = (stdout) => {
    const pairs = [];
    if (truncated) return pairs;
    const raw = String(stdout || "");
    if (!raw) return pairs;
    // git config --list --null: each record is "key\nvalue\0"
    for (const record of raw.split("\0")) {
      if (!record) continue;
      const nl = record.indexOf("\n");
      if (nl < 0) {
        unreadable = true;
        continue;
      }
      const key = record.slice(0, nl);
      const value = record.slice(nl + 1);
      if (!key || key.length > 1024) {
        unreadable = true;
        continue;
      }
      const valueBytes = Buffer.byteLength(value, "utf8");
      // One total bounded inventory across local + worktree scopes.
      if (totalEntries >= MAX_CONFIG_ENTRIES || totalValueBytes + valueBytes > MAX_CONFIG_VALUE_BYTES) {
        truncated = true;
        break;
      }
      totalEntries += 1;
      totalValueBytes += valueBytes;
      // Digest only — keys may embed includeIf gitdir absolute paths; values may
      // hold credentials or absolute include targets.
      pairs.push({
        index: totalEntries - 1,
        keyDigest: sha(key),
        valueDigest: sha(value)
      });
    }
    return pairs;
  };

  // Local (repository) config with includes explicitly resolved. Required.
  const localRun = git(
    workspaceRoot,
    ["config", "--local", "--includes", "--list", "--null"],
    { allowFailure: true, maxBuffer: 16 * 1024 * 1024 }
  );
  if (localRun.error || localRun.status !== 0) {
    return {
      identity: sha("config-v1:local-resolution-failed"),
      observable: false,
      truncated: true
    };
  }
  scopes.push({
    scope: "local",
    pairs: parseNullConfigList(localRun.stdout)
  });

  // Worktree config only when extensions.worktreeConfig is enabled.
  let worktreeEnabled = false;
  const worktreeFlag = git(
    workspaceRoot,
    ["config", "--local", "--bool", "extensions.worktreeConfig"],
    { allowFailure: true }
  );
  if (!worktreeFlag.error && worktreeFlag.status === 0) {
    worktreeEnabled = String(worktreeFlag.stdout || "").trim() === "true";
  } else if (worktreeFlag.error) {
    return {
      identity: sha("config-v1:worktree-flag-unreadable"),
      observable: false,
      truncated: true
    };
  }

  if (worktreeEnabled) {
    const worktreeRun = git(
      workspaceRoot,
      ["config", "--worktree", "--includes", "--list", "--null"],
      { allowFailure: true, maxBuffer: 16 * 1024 * 1024 }
    );
    if (worktreeRun.error || worktreeRun.status !== 0) {
      return {
        identity: sha("config-v1:worktree-resolution-failed"),
        observable: false,
        truncated: true
      };
    }
    scopes.push({
      scope: "worktree",
      pairs: parseNullConfigList(worktreeRun.stdout)
    });
  } else {
    scopes.push({ scope: "worktree", pairs: [], enabled: false });
  }

  const failClosed = truncated || unreadable;
  return {
    identity: sha(canonicalJson({
      schema: "config-v1",
      scopes,
      totalEntries,
      truncated: failClosed,
      unreadable
    })),
    observable: !failClosed,
    truncated: failClosed
  };
}

/**
 * Bind every lexical component along a configured absolute path (ancestors and
 * final): ordinary directories, regular files, and symlinks. Used for
 * core.hooksPath so swapping an ordinary ancestor to a symlink (or retargeting
 * a symlink) changes identity even when final hook bytes are identical.
 * Each hop keeps a stable node signature (dev/ino/mode) for same-capture
 * revalidation and cross-capture identity so unrelated sibling activity under
 * an ancestor (nlink/size/mtime/ctime) cannot fail-close or drift hooks.
 * Symlink hops also bind linkDigest for retarget detection.
 * Bounded by maxComponents; absolute paths and raw link text stay private.
 */
function captureLexicalPathSymlinkHops(absolutePath, maxComponents = MAX_LEXICAL_PATH_COMPONENTS) {
  if (typeof absolutePath !== "string" || !absolutePath || !path.isAbsolute(absolutePath)) {
    return { ok: false, reason: "invalid", hops: [] };
  }
  const hops = [];
  // Walk progressive absolute prefixes: /a, /a/b, /a/b/c ...
  const normalized = path.resolve(absolutePath);
  const parts = normalized.split(path.sep).filter((part) => part.length > 0);
  let current = path.sep;
  // Windows drive roots keep their prefix; path.resolve already normalized.
  if (path.sep !== "/" && /^[A-Za-z]:/.test(normalized)) {
    current = `${parts.shift()}${path.sep}`;
  }
  for (let index = 0; index < parts.length; index += 1) {
    current = index === 0 && current === path.sep
      ? path.sep + parts[index]
      : path.join(current, parts[index]);
    if (hops.length >= maxComponents) {
      return { ok: false, reason: "hop-limit", hops };
    }
    let stat;
    try {
      stat = fs.lstatSync(current, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        // Missing intermediate is recorded as absence of further hops.
        break;
      }
      return { ok: false, reason: "unreadable", hops };
    }
    if (stat.isSymbolicLink()) {
      let linkText;
      try {
        linkText = fs.readlinkSync(current);
      } catch {
        return { ok: false, reason: "unreadable", hops };
      }
      hops.push({
        // Private absolute for revalidation only — never serialized publicly.
        kind: "symlink",
        absolute: current,
        linkDigest: sha(String(linkText)),
        // Stable node identity for same-capture revalidation and cross-capture digests.
        stableSignature: metadataLexicalNodeStableSignature(stat)
      });
      continue;
    }
    if (stat.isDirectory()) {
      hops.push({
        kind: "directory",
        absolute: current,
        // Stable node identity only: sibling nlink/mtime/ctime under this
        // ancestor must not fail-close same-capture revalidation.
        stableSignature: metadataLexicalNodeStableSignature(stat)
      });
      continue;
    }
    if (stat.isFile()) {
      hops.push({
        kind: "file",
        absolute: current,
        stableSignature: metadataLexicalNodeStableSignature(stat)
      });
      continue;
    }
    return { ok: false, reason: "other", hops };
  }
  return { ok: true, hops };
}

/**
 * Re-lstat/readlink every lexical component so ordinary→symlink swaps, ancestor
 * replacement, chmod/mode changes, and symlink retarget races fail closed.
 *
 * Lexical witnesses deliberately use stable dev/ino/mode (+ symlink linkDigest)
 * rather than full directory/file/symlink enumeration signatures. Unrelated
 * sibling create/change/remove under an ordinary ancestor changes nlink/size/
 * mtime/ctime without replacing the node and must not mark hooks unreadable.
 */
function revalidateLexicalPathSymlinkHops(hops, maxComponents = MAX_LEXICAL_PATH_COMPONENTS) {
  if (!Array.isArray(hops)) return { ok: false, reason: "unreadable" };
  if (hops.length > maxComponents) return { ok: false, reason: "hop-limit" };
  for (const hop of hops) {
    if (!hop || typeof hop.absolute !== "string" || typeof hop.kind !== "string") {
      return { ok: false, reason: "unreadable" };
    }
    if (typeof hop.stableSignature !== "string") {
      return { ok: false, reason: "unreadable" };
    }
    let stat;
    try {
      stat = fs.lstatSync(hop.absolute, { bigint: true });
    } catch {
      return { ok: false, reason: "broken" };
    }
    if (hop.kind === "symlink") {
      if (typeof hop.linkDigest !== "string") return { ok: false, reason: "unreadable" };
      if (!stat.isSymbolicLink()) return { ok: false, reason: "replaced" };
      if (metadataLexicalNodeStableSignature(stat) !== hop.stableSignature) {
        return { ok: false, reason: "replaced" };
      }
      let linkText;
      try {
        linkText = fs.readlinkSync(hop.absolute);
      } catch {
        return { ok: false, reason: "unreadable" };
      }
      if (sha(String(linkText)) !== hop.linkDigest) {
        return { ok: false, reason: "retargeted" };
      }
      continue;
    }
    if (hop.kind === "directory") {
      // Ordinary directory swapped to a symlink (even same content) fails closed.
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return { ok: false, reason: "replaced" };
      }
      if (metadataLexicalNodeStableSignature(stat) !== hop.stableSignature) {
        return { ok: false, reason: "replaced" };
      }
      continue;
    }
    if (hop.kind === "file") {
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { ok: false, reason: "replaced" };
      }
      if (metadataLexicalNodeStableSignature(stat) !== hop.stableSignature) {
        return { ok: false, reason: "replaced" };
      }
      continue;
    }
    return { ok: false, reason: "unreadable" };
  }
  return { ok: true };
}

/**
 * Choose the private hooks-tree walk root.
 *
 * `rev-parse --git-path hooks` is authoritative for Git's effective hooks
 * directory, but it may canonicalize a final directory symlink and drop the
 * configured hop. When `core.hooksPath` is set (absolute, relative, or
 * include-derived), build an unresolved candidate from the configured value:
 * absolute values are used as-is; relative values are resolved against the
 * worktree root (cwd for the git helper) without realpathing the final hop.
 * Walk that candidate when its realpath matches the effective directory so hop
 * digests observe final-component retarget races. Ancestor symlink components
 * of the configured path are always bound separately (see lexical hops).
 * Absolute paths never leave this helper publicly.
 */
function resolveHooksWalkRoot(workspaceRoot, effectiveHooksPath) {
  const configuredRun = git(
    workspaceRoot,
    // Explicit includes so include-derived core.hooksPath is observed the same
    // way Git resolves effective configuration for hooks.
    ["config", "--includes", "--path", "--get", "core.hooksPath"],
    { allowFailure: true }
  );
  // Unset / not found: Git uses the rev-parse effective path alone.
  if (configuredRun.error || configuredRun.status !== 0) {
    return { ok: true, hooksPath: effectiveHooksPath, configuredCandidate: null };
  }
  const configured = String(configuredRun.stdout || "").trim();
  if (!configured) {
    return { ok: true, hooksPath: effectiveHooksPath, configuredCandidate: null };
  }

  // Absolute: keep unresolved string (may be a symlink hop). Relative: join to
  // the worktree root without realpath — matches Git cwd/worktree semantics for
  // this helper's git() invocations — so a relative directory symlink remains
  // observable. Never use raw relative strings as the walk root.
  const configuredCandidate = path.isAbsolute(configured)
    ? configured
    : path.resolve(workspaceRoot, configured);
  if (!configuredCandidate || !path.isAbsolute(configuredCandidate)) {
    return { ok: true, hooksPath: effectiveHooksPath, configuredCandidate: null };
  }

  let configuredStat;
  try {
    configuredStat = fs.lstatSync(configuredCandidate);
  } catch {
    // Missing/unreadable configured path: keep effective (may also be missing).
    return { ok: true, hooksPath: effectiveHooksPath, configuredCandidate };
  }

  // Non-symlink final component: walk the effective path for content, but still
  // return configuredCandidate so ancestor lexical hops can be bound.
  if (!configuredStat.isSymbolicLink()) {
    return { ok: true, hooksPath: effectiveHooksPath, configuredCandidate };
  }

  // Configured directory (or multi-hop) symlink: retain the unresolved hop
  // only when it realpath-matches Git's effective hooks root.
  try {
    const configuredReal = fs.realpathSync(configuredCandidate);
    const effectiveReal = fs.realpathSync(effectiveHooksPath);
    if (path.resolve(configuredReal) !== path.resolve(effectiveReal)) {
      return { ok: true, hooksPath: effectiveHooksPath, configuredCandidate };
    }
    return { ok: true, hooksPath: configuredCandidate, configuredCandidate };
  } catch {
    // Dangling / partially unreadable symlink: if the single-hop logical
    // target agrees with the effective path string, still walk the unresolved
    // hop so broken/retargeted roots fail closed via the bounded walker.
    try {
      const linkText = fs.readlinkSync(configuredCandidate);
      const logicalTarget = path.resolve(
        path.dirname(configuredCandidate),
        String(linkText)
      );
      if (path.resolve(logicalTarget) === path.resolve(effectiveHooksPath)) {
        return { ok: true, hooksPath: configuredCandidate, configuredCandidate };
      }
    } catch {
      // ignore readlink races
    }
    return { ok: true, hooksPath: effectiveHooksPath, configuredCandidate };
  }
}

/**
 * Resolve the effective hooks directory with Git semantics (respects
 * core.hooksPath) and hash bounded contents under a private digest only.
 * Symlink link-text and resolved target contents are both bound into the
 * identity so unchanged symlink paths cannot hide target drift. Absolute hook
 * paths never enter public/runtime evidence.
 * Missing after resolution failure, unreadable, cyclic, excessive-depth, or
 * truncated inventories fail closed via observable=false.
 */
function captureEffectiveHooksIdentity(workspaceRoot) {
  const run = git(
    workspaceRoot,
    ["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
    { allowFailure: true }
  );
  if (run.status !== 0 || run.error) {
    return {
      identity: sha("hooks-v2:resolution-failed"),
      observable: false,
      truncated: true
    };
  }
  const effectiveHooksPath = String(run.stdout || "").trim();
  if (!effectiveHooksPath || !path.isAbsolute(effectiveHooksPath)) {
    return {
      identity: sha("hooks-v2:resolution-failed"),
      observable: false,
      truncated: true
    };
  }

  const walkRoot = resolveHooksWalkRoot(workspaceRoot, effectiveHooksPath);
  if (!walkRoot.ok) {
    return {
      identity: sha(`hooks-v2:${walkRoot.reason || "walk-root-failed"}`),
      observable: false,
      truncated: true
    };
  }
  const hooksPath = walkRoot.hooksPath;
  if (!hooksPath || !path.isAbsolute(hooksPath)) {
    return {
      identity: sha("hooks-v2:resolution-failed"),
      observable: false,
      truncated: true
    };
  }

  // Bind every lexical component along the configured path (ordinary dirs,
  // files, and symlink hops) so ordinary→symlink ancestor swaps and symlink
  // retargets change identity even when hook tree bytes are identical.
  let lexicalHops = [];
  let lexicalHopFailure = null;
  const hopSource = walkRoot.configuredCandidate || null;
  if (hopSource) {
    const hopCapture = captureLexicalPathSymlinkHops(hopSource, MAX_LEXICAL_PATH_COMPONENTS);
    if (!hopCapture.ok) {
      lexicalHopFailure = hopCapture.reason || "unreadable";
    } else {
      lexicalHops = hopCapture.hops;
    }
  }

  // Reuse the shared bounded walker so hooks, operational, and non-ref capture
  // enforce the same hard entry/byte/descriptor bounds without path leakage.
  const state = createMetadataVisitState();
  let missing = false;
  /** @type {object[]} */
  const rootWitnesses = [];
  try {
    fs.lstatSync(hooksPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      missing = true;
      // Witness absence so a hooks root that appears mid-capture fails closed.
      rootWitnesses.push({ kind: "absent", absolute: hooksPath });
    } else {
      return {
        identity: sha("hooks-v2:unreadable-root"),
        observable: false,
        truncated: true
      };
    }
  }
  if (!missing) {
    const witness = visitBoundedMetadataTree(hooksPath, "", 0, new Set(), state, {
      maxDepth: MAX_HOOKS_DEPTH,
      maxBytes: MAX_HOOKS_HASH_BYTES,
      maxEntries: MAX_GIT_METADATA_ENTRIES,
      maxHops: MAX_HOOKS_SYMLINK_HOPS
    });
    if (witness) rootWitnesses.push(witness);
  }
  // Final present/absent validation of the effective hooks root.
  if (!state.truncated && !state.depthExceeded) {
    revalidateOptionalRootWitnesses(rootWitnesses, state);
    // If the missing witness flipped to present, revalidation already set
    // unreadable. Keep the missing flag consistent with the final witness.
    if (missing && state.unreadable) {
      missing = false;
    }
  }
  // Revalidate configured lexical ancestor/final components after content capture.
  if (!lexicalHopFailure && lexicalHops.length > 0) {
    const hopRecheck = revalidateLexicalPathSymlinkHops(lexicalHops, MAX_LEXICAL_PATH_COMPONENTS);
    if (!hopRecheck.ok) {
      lexicalHopFailure = hopRecheck.reason || "retargeted";
      state.unreadable = true;
    }
  } else if (lexicalHopFailure) {
    state.unreadable = true;
  }
  state.entries.sort((left, right) => left.path.localeCompare(right.path));
  // Public-safe hop digests only (no absolute paths, raw stats, or link text).
  // kind is retained so ordinary→symlink type swaps change identity.
  // Cross-capture and same-capture lexical witnesses both use stable
  // dev/ino/mode (+ symlink linkDigest). Full enumeration signatures remain
  // for metadata tree hashing only — not lexical hop revalidation.
  const publicLexicalHops = lexicalHops.map((hop) => {
    const stable = hop.stableSignature;
    if (hop.kind === "symlink") {
      return {
        kind: "symlink",
        linkDigest: hop.linkDigest,
        signatureDigest: sha(stable)
      };
    }
    return {
      kind: hop.kind,
      signatureDigest: sha(stable)
    };
  });
  // A completely missing hooks directory is normal (empty effective hooks).
  // Unreadable, cyclic, depth-limited, or truncated inventories fail closed.
  const failClosed = state.unreadable
    || state.depthExceeded
    || state.truncated
    || state.cyclic
    || state.entries.length >= MAX_GIT_METADATA_ENTRIES
    || Boolean(lexicalHopFailure);
  return {
    identity: sha(canonicalJson({
      schema: "hooks-v4",
      entries: state.entries,
      lexicalHops: publicLexicalHops,
      lexicalHopFailure: lexicalHopFailure || null,
      missing,
      truncated: failClosed,
      depthExceeded: state.depthExceeded,
      unreadable: state.unreadable,
      cyclic: state.cyclic
    })),
    observable: !failClosed,
    truncated: failClosed
  };
}

/**
 * Bounded legacy metadata tree walk for gitMetadataIdentity.
 * Hard entry/byte/depth caps and descriptor-bound file hashing; directory
 * listings use listDirectoryNamesBounded (no unbounded readdirSync().sort()).
 * Optional missing roots stay silent (stable absence is valid) but are
 * witnessed and revalidated after the full root batch so mid-capture
 * appearance/disappearance/replace fails closed via state.
 */
function visitGitMetadataEntries(entries, gitDir, commonDir, roots, state) {
  const visit = (base, relative, depth = 0) => {
    if (!state || state.truncated || state.unreadable || state.depthExceeded) {
      return null;
    }
    if (entries.length >= MAX_GIT_METADATA_ENTRIES) {
      state.truncated = true;
      return null;
    }
    if (depth > MAX_METADATA_DEPTH) {
      state.depthExceeded = true;
      return null;
    }
    const absolute = path.join(base, relative);
    let stat;
    try {
      // Top-level roots use bigint so present witnesses can revalidate identity.
      stat = depth === 0
        ? fs.lstatSync(absolute, { bigint: true })
        : fs.lstatSync(absolute);
    } catch (error) {
      // Optional legacy roots may be absent (e.g. missing hooks).
      if (error?.code === "ENOENT") {
        if (depth === 0) return { kind: "absent", absolute };
        // Listed child disappeared mid-walk.
        state.unreadable = true;
        return null;
      }
      state.unreadable = true;
      return null;
    }
    const key = `${base === gitDir ? "git" : "common"}/${relative.replace(/\\/g, "/")}`;
    if (stat.isSymbolicLink()) {
      let linkText;
      try {
        linkText = fs.readlinkSync(absolute);
      } catch {
        state.unreadable = true;
        return null;
      }
      const linkDigest = sha(String(linkText));
      entries.push({
        path: key,
        kind: "symlink",
        mode: Number(stat.mode & (depth === 0 ? 0o7777n : 0o7777)),
        digest: linkDigest
      });
      if (depth === 0) {
        return {
          kind: "legacy-present",
          absolute,
          nodeKind: "symlink",
          signature: metadataSymlinkStatSignature(stat),
          linkDigest
        };
      }
      return null;
    }
    if (stat.isFile()) {
      // Descriptor-validated mode/size/digest only — same hard byte bound.
      const fileIdentity = hashBoundedMetadataFile(absolute, state, MAX_METADATA_HASH_BYTES);
      if (fileIdentity.kind === "unobservable") {
        state.unreadable = true;
        return null;
      }
      entries.push({
        path: key,
        kind: "file",
        mode: fileIdentity.mode,
        size: fileIdentity.size,
        digest: fileIdentity.digest
      });
      if (depth === 0) {
        return {
          kind: "legacy-present",
          absolute,
          nodeKind: "file",
          mode: fileIdentity.mode,
          size: fileIdentity.size,
          digest: fileIdentity.digest
        };
      }
      return null;
    }
    if (!stat.isDirectory()) {
      entries.push({
        path: key,
        kind: "other",
        mode: Number(stat.mode & (depth === 0 ? 0o7777n : 0o7777))
      });
      if (depth === 0) {
        return { kind: "legacy-present", absolute, nodeKind: "other" };
      }
      return null;
    }
    let listed;
    try {
      listed = listDirectoryNamesBounded(absolute, MAX_GIT_METADATA_ENTRIES - entries.length);
    } catch {
      state.unreadable = true;
      return null;
    }
    if (listed.truncated) {
      state.truncated = true;
      return null;
    }
    for (const name of listed.names) {
      if (entries.length >= MAX_GIT_METADATA_ENTRIES || state.truncated || state.unreadable) {
        state.truncated = true;
        break;
      }
      visit(base, path.join(relative, name), depth + 1);
    }
    // Membership revalidation after children (post-EOF growth / shrink).
    if (!state.truncated && !state.unreadable) {
      const dirRecheck = revalidateBoundedDirectorySnapshot(
        absolute,
        listed.directorySignature,
        listed.names
      );
      if (!dirRecheck.ok) state.unreadable = true;
    }
    if (depth === 0) {
      return {
        kind: "legacy-present",
        absolute,
        nodeKind: "directory",
        directorySignature: listed.directorySignature,
        names: listed.names
      };
    }
    return null;
  };
  const rootWitnesses = [];
  for (const [base, relatives] of roots) {
    if (!base) {
      state.unreadable = true;
      continue;
    }
    for (const relative of relatives) {
      const witness = visit(base, relative, 0);
      if (witness) rootWitnesses.push(witness);
    }
  }
  // Final present/absent validation of the complete legacy root set.
  if (!state.truncated && !state.depthExceeded) {
    revalidateOptionalRootWitnesses(rootWitnesses, state);
  }
}

/**
 * Positively classify a shared ref name.
 * Unrelated (tolerated only when both manifests are linked worktrees and only
 * these change): other local branches, unrelated remote-tracking refs, and
 * refs/codex/turn-diffs/**.
 * Task-relevant (fail closed): current branch, configured upstream,
 * refs/replace/**, and any unclassified/special ref.
 */
function classifySharedRef(refname, { currentBranchRef = null, upstreamFullRef = null } = {}) {
  const name = String(refname || "");
  if (!name.startsWith("refs/")) return SHARED_REF_CLASS_TASK_RELEVANT;
  if (currentBranchRef && name === currentBranchRef) return SHARED_REF_CLASS_TASK_RELEVANT;
  if (upstreamFullRef && name === upstreamFullRef) return SHARED_REF_CLASS_TASK_RELEVANT;
  if (name.startsWith("refs/replace/")) return SHARED_REF_CLASS_TASK_RELEVANT;
  if (name.startsWith("refs/codex/turn-diffs/")) return SHARED_REF_CLASS_UNRELATED;
  if (name.startsWith("refs/heads/")) return SHARED_REF_CLASS_UNRELATED;
  if (name.startsWith("refs/remotes/")) return SHARED_REF_CLASS_UNRELATED;
  return SHARED_REF_CLASS_TASK_RELEVANT;
}

/**
 * Exact Git reftable compatibility marker written as a regular file where a
 * loose-ref directory would otherwise live (e.g. refs/heads, refs/tags).
 * Content and relative locations are Git-defined; only ignore when the
 * repository backend is reftable (git rev-parse --show-ref-format).
 */
const REFTABLE_REFS_MARKER_BODY = "this repository uses the reftable format\n";
const REFTABLE_REFS_MARKER_RELATIVE = Object.freeze(new Set([
  "heads",
  "tags"
]));
const WORKTREE_PRIVATE_REF_NAMESPACES = Object.freeze([
  "bisect",
  "worktree",
  "rewritten"
]);

/**
 * Bounded loose-ref scan under refs/ to catch broken files and dangling
 * symbolic refs that for-each-ref/show-ref may silently omit with status 0.
 *
 * When the authoritative ref backend is reftable, Git may place exact
 * compatibility marker *files* at refs/heads and refs/tags (not directories)
 * with body "this repository uses the reftable format\\n". Those markers are
 * not refs and must not fail closed. Any other loose file, arbitrary symlink,
 * or marker-like content on a files backend remains fail-closed.
 * Hard entry/depth bounds; absolute paths stay private.
 */
function validateLooseRefsInventory(workspaceRoot, knownNames) {
  const commonDirRun = git(
    workspaceRoot,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { allowFailure: true }
  );
  if (commonDirRun.error || commonDirRun.status !== 0) {
    return { ok: false, reason: "common-dir" };
  }
  const gitDirRun = git(
    workspaceRoot,
    ["rev-parse", "--path-format=absolute", "--git-dir"],
    { allowFailure: true }
  );
  if (gitDirRun.error || gitDirRun.status !== 0) {
    return { ok: false, reason: "git-dir" };
  }
  let commonDir;
  let gitDir;
  try {
    const commonCandidate = String(commonDirRun.stdout || "").trim();
    const gitCandidate = String(gitDirRun.stdout || "").trim();
    if (!commonCandidate
      || !gitCandidate
      || !path.isAbsolute(commonCandidate)
      || !path.isAbsolute(gitCandidate)) {
      return { ok: false, reason: "git-dir" };
    }
    commonDir = fs.realpathSync(commonCandidate);
    gitDir = fs.realpathSync(gitCandidate);
  } catch {
    return { ok: false, reason: "common-dir" };
  }

  // Authoritative backend detection — only reftable may use the marker exception.
  const formatRun = git(
    workspaceRoot,
    ["rev-parse", "--show-ref-format"],
    { allowFailure: true }
  );
  const isReftable = !formatRun.error
    && formatRun.status === 0
    && String(formatRun.stdout || "").trim() === "reftable";

  const linkedWorktree = gitDir !== commonDir;
  const privateNamespaces = new Set(WORKTREE_PRIVATE_REF_NAMESPACES);
  const rootSpecs = [{
    absolute: path.join(commonDir, "refs"),
    refPrefix: "refs",
    source: "common",
    excludeTopLevel: linkedWorktree ? privateNamespaces : new Set(),
    allowReftableMarkers: true
  }];
  if (linkedWorktree) {
    for (const namespace of WORKTREE_PRIVATE_REF_NAMESPACES) {
      rootSpecs.push({
        absolute: path.join(gitDir, "refs", namespace),
        refPrefix: `refs/${namespace}`,
        source: `worktree:${namespace}`,
        excludeTopLevel: new Set(),
        allowReftableMarkers: false
      });
    }
  }

  let seenNodes = 0;
  let refCount = 0;
  const observedRefNames = new Set();
  const snapshotRecords = [];
  const directoryWitnesses = [];
  const fileWitnesses = [];
  const absentRootWitnesses = [];

  const snapshotFile = (spec, relativeKey, bodyRead, kind) => {
    snapshotRecords.push({
      kind,
      sourceDigest: sha(spec.source),
      pathDigest: sha(`${spec.refPrefix}/${relativeKey}`),
      fileSignature: bodyRead.fileSignature,
      mode: bodyRead.mode,
      size: bodyRead.size,
      bodyDigest: bodyRead.bodyDigest
    });
    fileWitnesses.push({
      absolute: path.join(spec.absolute, ...relativeKey.split("/")),
      fileSignature: bodyRead.fileSignature,
      mode: bodyRead.mode,
      size: bodyRead.size,
      bodyDigest: bodyRead.bodyDigest
    });
  };

  const visit = (spec, absolute, relative, depth, isRoot = false) => {
    if (seenNodes >= MAX_SHARED_REFS || depth > MAX_METADATA_DEPTH) {
      return { ok: false, reason: "bound" };
    }
    let stat;
    try {
      stat = fs.lstatSync(absolute, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT" && isRoot) {
        absentRootWitnesses.push(absolute);
        snapshotRecords.push({
          kind: "absent-root",
          sourceDigest: sha(spec.source)
        });
        return { ok: true };
      }
      return { ok: false, reason: "unreadable" };
    }
    seenNodes += 1;
    // Arbitrary symlink nodes under refs/ always fail closed (no silent skip).
    if (stat.isSymbolicLink()) {
      return { ok: false, reason: "symlink-ref" };
    }
    if (stat.isDirectory()) {
      let listed;
      try {
        listed = listDirectoryNamesBounded(
          absolute,
          Math.max(0, MAX_SHARED_REFS - seenNodes)
        );
      } catch {
        return { ok: false, reason: "unreadable" };
      }
      if (listed.truncated) {
        return { ok: false, reason: "bound" };
      }
      const effectiveNames = relative === ""
        ? listed.names.filter((name) => !spec.excludeTopLevel.has(name))
        : listed.names;
      snapshotRecords.push({
        kind: "directory",
        sourceDigest: sha(spec.source),
        pathDigest: sha(`${spec.refPrefix}/${relative}`),
        stableSignature: listed.stableSignature,
        memberDigests: effectiveNames.map((name) => sha(name))
      });
      directoryWitnesses.push({
        absolute,
        directorySignature: listed.directorySignature,
        names: listed.names
      });
      for (const name of effectiveNames) {
        const child = visit(
          spec,
          path.join(absolute, name),
          relative ? `${relative}/${name}` : name,
          depth + 1
        );
        if (!child.ok) return child;
      }
      const directoryCheck = revalidateBoundedDirectorySnapshot(
        absolute,
        listed.directorySignature,
        listed.names
      );
      if (!directoryCheck.ok) {
        return { ok: false, reason: "mutated" };
      }
      return { ok: true };
    }
    if (!stat.isFile()) {
      // Non-file/non-dir nodes under refs/ are not valid loose refs.
      return { ok: false, reason: "other" };
    }
    // relative must be a non-empty path under refs/ (never the refs root itself).
    if (!relative) return { ok: false, reason: "name" };
    const relativeKey = relative.replace(/\\/g, "/");

    // Exact reftable compatibility marker only (backend + path + body).
    // Descriptor-bound nofollow read of accepted body limit + 1 byte.
    if (
      spec.allowReftableMarkers
      &&
      isReftable
      && REFTABLE_REFS_MARKER_RELATIVE.has(relativeKey)
      && !relativeKey.includes("/")
    ) {
      const markerRead = readBoundedNofollowTextFile(absolute, MAX_LOOSE_REF_BODY_BYTES);
      if (!markerRead.ok) {
        return { ok: false, reason: markerRead.reason === "oversize" ? "oversize" : "unreadable" };
      }
      if (markerRead.body === REFTABLE_REFS_MARKER_BODY) {
        // Not a ref — skip without counting toward inventory incompleteness.
        snapshotFile(spec, relativeKey, markerRead, "reftable-marker");
        return { ok: true };
      }
      // Same path but wrong body: fall through as a broken/malformed plant.
    }

    refCount += 1;
    if (refCount > MAX_SHARED_REFS) return { ok: false, reason: "bound" };
    const refname = `${spec.refPrefix}/${relativeKey}`;
    if (refname.length > MAX_SHARED_REF_FIELD_BYTES || refname.includes("//")) {
      return { ok: false, reason: "name" };
    }
    // Descriptor-bound nofollow read; never unbounded readFileSync of ref bodies.
    const bodyRead = readBoundedNofollowTextFile(absolute, MAX_LOOSE_REF_BODY_BYTES);
    if (!bodyRead.ok) {
      return {
        ok: false,
        reason: bodyRead.reason === "oversize" ? "oversize" : "unreadable"
      };
    }
    snapshotFile(spec, relativeKey, bodyRead, "loose-ref");
    const trimmed = String(bodyRead.body || "").trim();
    if (!trimmed || trimmed.length > MAX_SHARED_REF_FIELD_BYTES) {
      return { ok: false, reason: "body" };
    }
    if (trimmed.startsWith("ref:")) {
      const target = trimmed.slice(4).trim();
      if (
        !target
        || !target.startsWith("refs/")
        || target.length > MAX_SHARED_REF_FIELD_BYTES
      ) {
        return { ok: false, reason: "symref" };
      }
      // Dangling or broken symbolic ref: must resolve to an object.
      const resolveRun = git(
        workspaceRoot,
        ["rev-parse", "--verify", "--quiet", "--end-of-options", `${refname}^{object}`],
        { allowFailure: true }
      );
      if (resolveRun.error || resolveRun.status !== 0 || String(resolveRun.stderr || "").trim()) {
        return { ok: false, reason: "dangling" };
      }
    } else if (!/^[a-f0-9]{40,64}$/i.test(trimmed.split(/\s+/)[0] || "")) {
      // Broken loose OID file (includes marker-like content on files backend).
      return { ok: false, reason: "broken-oid" };
    }
    if (observedRefNames.has(refname)) {
      return { ok: false, reason: "duplicate" };
    }
    observedRefNames.add(refname);
    // Loose ref present but omitted from semantic inventory → incomplete.
    if (knownNames && !knownNames.has(refname) && knownNames.size <= MAX_SHARED_REFS) {
      return { ok: false, reason: "omitted" };
    }
    return { ok: true };
  };

  for (const spec of rootSpecs) {
    const result = visit(spec, spec.absolute, "", 0, true);
    if (!result.ok) return result;
  }

  // Each scan is independently stable: after all roots have been traversed,
  // revalidate every captured directory membership, every descriptor-bound
  // file identity/body, and every optional absent root.
  for (const witness of directoryWitnesses) {
    const check = revalidateBoundedDirectorySnapshot(
      witness.absolute,
      witness.directorySignature,
      witness.names
    );
    if (!check.ok) return { ok: false, reason: "mutated" };
  }
  for (const witness of fileWitnesses) {
    const reread = readBoundedNofollowTextFile(
      witness.absolute,
      MAX_LOOSE_REF_BODY_BYTES
    );
    if (!reread.ok
      || reread.fileSignature !== witness.fileSignature
      || reread.mode !== witness.mode
      || reread.size !== witness.size
      || reread.bodyDigest !== witness.bodyDigest) {
      return { ok: false, reason: "mutated" };
    }
  }
  for (const absolute of absentRootWitnesses) {
    try {
      fs.lstatSync(absolute);
      return { ok: false, reason: "mutated" };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        return { ok: false, reason: "unreadable" };
      }
    }
  }

  snapshotRecords.sort((left, right) => (
    canonicalJson(left).localeCompare(canonicalJson(right))
  ));
  return {
    ok: true,
    refCount,
    identity: sha(canonicalJson({
      schema: "loose-refs-v2",
      records: snapshotRecords
    }))
  };
}

const SEMANTIC_REF_INVENTORY_ARGS = Object.freeze([
  "for-each-ref",
  "--sort=refname",
  "--format=%(refname)%00%(objectname)%00%(symref)%0a"
]);

/**
 * Parse a validated for-each-ref inventory run into sorted name/target records.
 * Caller must already enforce status 0, no error, and empty stderr.
 */
function parseSemanticRefInventoryStdout(stdout, workspaceRoot) {
  const refs = [];
  let unattributable = false;
  let malformed = false;
  const seenNames = new Set();
  let duplicates = false;
  for (const line of String(stdout || "").split("\n")) {
    if (!line) continue;
    const parts = line.split("\0");
    if (parts.length < 2) {
      malformed = true;
      unattributable = true;
      continue;
    }
    const name = parts[0] || "";
    const objectname = parts[1] || "";
    const symref = parts[2] || "";
    if (!name.startsWith("refs/") || name.length > MAX_SHARED_REF_FIELD_BYTES) {
      malformed = true;
      unattributable = true;
      continue;
    }
    if (seenNames.has(name)) {
      duplicates = true;
      unattributable = true;
      continue;
    }
    seenNames.add(name);
    const target = symref || objectname;
    if (!target
      || target.length > MAX_SHARED_REF_FIELD_BYTES
      || !/^[a-f0-9]{40,64}$/i.test(objectname)) {
      malformed = true;
      unattributable = true;
      continue;
    }
    // Reject absolute paths / private material in targets.
    if (/^(?:\/|[A-Za-z]:[\\/]|~\/)/.test(target)) {
      malformed = true;
      unattributable = true;
      continue;
    }
    // Dangling symbolic refs: symref target must resolve to an object.
    if (symref) {
      const resolveRun = git(
        workspaceRoot,
        ["rev-parse", "--verify", "--quiet", "--end-of-options", `${name}^{object}`],
        { allowFailure: true }
      );
      if (resolveRun.error || resolveRun.status !== 0 || String(resolveRun.stderr || "").trim()) {
        malformed = true;
        unattributable = true;
        continue;
      }
    }
    // Preserve both symbolic topology and the resolved object. A symbolic ref
    // can keep the same target name while that target advances.
    refs.push({
      name,
      target,
      resolvedOid: objectname.toLowerCase()
    });
    if (refs.length > MAX_SHARED_REFS) break;
  }
  refs.sort((left, right) => left.name.localeCompare(right.name));
  return { refs, unattributable, malformed, duplicates };
}

/**
 * True when two sorted semantic ref inventories have identical name+target pairs.
 */
function semanticRefInventoriesEqual(leftRefs, rightRefs) {
  if (!Array.isArray(leftRefs) || !Array.isArray(rightRefs)) return false;
  if (leftRefs.length !== rightRefs.length) return false;
  for (let index = 0; index < leftRefs.length; index += 1) {
    const left = leftRefs[index];
    const right = rightRefs[index];
    if (!left
      || !right
      || left.name !== right.name
      || left.target !== right.target
      || left.resolvedOid !== right.resolvedOid) {
      return false;
    }
  }
  return true;
}

/**
 * Capture semantic shared refs (name → OID or symref target) so loose↔packed
 * rewrites with identical semantics produce the same identity.
 *
 * Status-0 enumerations with stderr/warnings, malformed entries, duplicates,
 * dangling symbolic targets, or cross-check disagreement with `show-ref` /
 * bounded loose refs are incomplete/unavailable and never eligible for
 * linked-worktree tolerance.
 *
 * After all cross-checks, a second bounded exact name-and-target inventory pass
 * must match the first exactly (validated status and empty stderr) so mid-capture
 * same-name target mutations cannot publish a stale complete identity.
 */
function captureSemanticSharedRefs(workspaceRoot) {
  // Once Git's authoritative semantic inventory is untrusted, fail immediately.
  // A second loose-tree walk cannot restore attribution and would add needless
  // filesystem work to an already fail-closed capture.
  const failUntrustedInventory = () => (
    { refs: [], complete: false, available: false }
  );

  // One record per line: refname\0objectname\0symref. Newline separates records
  // so empty symref fields cannot merge adjacent refs.
  const run = git(
    workspaceRoot,
    [...SEMANTIC_REF_INVENTORY_ARGS],
    { allowFailure: true, maxBuffer: 64 * 1024 * 1024 }
  );
  if (run.status !== 0 || run.error) {
    return failUntrustedInventory();
  }
  // Any warning/diagnostic on stderr means the inventory is not trustworthy
  // (broken loose refs, reftable issues, etc.) even when status is 0.
  if (String(run.stderr || "").trim()) {
    return failUntrustedInventory();
  }
  const parsed = parseSemanticRefInventoryStdout(run.stdout, workspaceRoot);
  let { refs, unattributable, malformed, duplicates } = parsed;

  // Cross-check against show-ref so silently omitted dangling/broken refs
  // cannot publish a complete inventory (for-each-ref may drop them with status 0).
  const showRun = git(
    workspaceRoot,
    ["show-ref", "--head"],
    { allowFailure: true, maxBuffer: 64 * 1024 * 1024 }
  );
  // show-ref exits 1 when the repository has no refs at all; treat other
  // failures, stderr, or parse errors as incomplete.
  if (showRun.error) {
    return failUntrustedInventory();
  }
  if (String(showRun.stderr || "").trim()) {
    return failUntrustedInventory();
  }
  const showNames = new Set();
  let showMalformed = false;
  for (const line of String(showRun.stdout || "").split("\n")) {
    if (!line) continue;
    // Format: <oid> SP <refname>
    const sp = line.indexOf(" ");
    if (sp <= 0) {
      showMalformed = true;
      continue;
    }
    const refname = line.slice(sp + 1).trim();
    if (!refname || refname.length > MAX_SHARED_REF_FIELD_BYTES) {
      showMalformed = true;
      continue;
    }
    // Compare only refs/** — HEAD is not in for-each-ref output.
    if (refname.startsWith("refs/")) showNames.add(refname);
  }
  // When show-ref exits non-zero with empty stdout and no refs expected, allow
  // empty agreement; any partial/non-empty disagreement fails closed.
  if (showRun.status !== 0 && showNames.size > 0) {
    return { refs: [], complete: false, available: false };
  }
  if (showMalformed) {
    return { refs: [], complete: false, available: false };
  }
  const forEachNames = new Set(refs.map((entry) => entry.name));
  // Names only in show-ref (omitted by for-each-ref) or only in for-each-ref
  // indicate incomplete inventory. Truncation over MAX_SHARED_REFS is handled
  // separately via overBudget; still treat show-ref exclusives as omissions.
  if (refs.length <= MAX_SHARED_REFS) {
    for (const name of showNames) {
      if (!forEachNames.has(name)) {
        unattributable = true;
        malformed = true;
        break;
      }
    }
    if (!malformed) {
      for (const name of forEachNames) {
        if (!showNames.has(name)) {
          unattributable = true;
          malformed = true;
          break;
        }
      }
    }
  }

  // Bounded loose refs/ walk catches broken OID files and dangling symrefs that
  // both for-each-ref and show-ref may omit without non-zero status.
  let firstLooseSnapshot = null;
  if (!malformed && !duplicates && refs.length <= MAX_SHARED_REFS) {
    firstLooseSnapshot = validateLooseRefsInventory(
      workspaceRoot,
      forEachNames
    );
    if (!firstLooseSnapshot.ok) {
      malformed = true;
      unattributable = true;
    }
  }

  // Second exact name-and-target inventory after all cross-checks. Same-name
  // target mutations between passes must fail closed rather than return the
  // first-pass complete identity (show-ref name-only cross-check is insufficient).
  if (!malformed && !duplicates && !unattributable && refs.length <= MAX_SHARED_REFS) {
    const secondRun = git(
      workspaceRoot,
      [...SEMANTIC_REF_INVENTORY_ARGS],
      { allowFailure: true, maxBuffer: 64 * 1024 * 1024 }
    );
    if (
      secondRun.error
      || secondRun.status !== 0
      || String(secondRun.stderr || "").trim()
    ) {
      malformed = true;
      unattributable = true;
    } else {
      const second = parseSemanticRefInventoryStdout(secondRun.stdout, workspaceRoot);
      if (
        second.malformed
        || second.duplicates
        || second.unattributable
        || !semanticRefInventoriesEqual(refs, second.refs)
      ) {
        malformed = true;
        unattributable = true;
      } else {
        // The second semantic pass is bracketed by two independently
        // race-stable bounded loose inventories. Membership or descriptor-bound
        // file identity/body changes after the first scan fail closed even when
        // both Git semantic passes happen to agree.
        const secondLooseSnapshot = validateLooseRefsInventory(
          workspaceRoot,
          new Set(second.refs.map((entry) => entry.name))
        );
        if (!firstLooseSnapshot?.ok
          || !secondLooseSnapshot.ok
          || secondLooseSnapshot.refCount !== firstLooseSnapshot.refCount
          || secondLooseSnapshot.identity !== firstLooseSnapshot.identity) {
          malformed = true;
          unattributable = true;
        }
      }
    }
  }

  const overBudget = refs.length > MAX_SHARED_REFS;
  const complete = !unattributable
    && !malformed
    && !duplicates
    && !overBudget
    && refs.length <= MAX_SHARED_REFS;
  // Malformed/dangling/warning inventories are unavailable so they can never
  // receive linked-worktree unrelated-ref tolerance.
  const available = !malformed && !duplicates && !String(run.stderr || "").trim();
  return {
    refs: refs.slice(0, MAX_SHARED_REFS),
    complete,
    available
  };
}

function buildSharedRefIdentity(semanticRefs, { currentBranchRef = null, upstreamFullRef = null } = {}) {
  const taskRelevant = [];
  const unrelated = [];
  for (const entry of semanticRefs.refs) {
    const classification = classifySharedRef(entry.name, { currentBranchRef, upstreamFullRef });
    const record = {
      name: entry.name,
      target: entry.target,
      resolvedOid: entry.resolvedOid,
      class: classification
    };
    if (classification === SHARED_REF_CLASS_UNRELATED) unrelated.push(record);
    else taskRelevant.push(record);
  }
  taskRelevant.sort((left, right) => left.name.localeCompare(right.name));
  unrelated.sort((left, right) => left.name.localeCompare(right.name));
  const refCount = taskRelevant.length + unrelated.length;
  const complete = Boolean(semanticRefs.complete) && refCount <= MAX_SHARED_REFS;
  const attributable = complete && refCount <= MAX_SHARED_REF_ATTRIBUTABLE;
  const taskRelevantRefIdentity = sha(canonicalJson(
    taskRelevant.map((entry) => ({
      name: entry.name,
      target: entry.target,
      resolvedOid: entry.resolvedOid
    }))
  ));
  const unrelatedRefIdentity = sha(canonicalJson(
    unrelated.map((entry) => ({
      name: entry.name,
      target: entry.target,
      resolvedOid: entry.resolvedOid
    }))
  ));
  // Private evidence only (public protocol projection omits these arrays).
  // Keep full parser-bounded names/targets (≤512) so long-ref prefixes cannot
  // collide and self-observation cannot spuriously fail closed.
  const privateRecord = (entry) => ({
    name: entry.name,
    target: entry.target,
    resolvedOid: entry.resolvedOid,
    class: entry.class
  });
  return {
    schemaVersion: SHARED_REF_IDENTITY_SCHEMA_VERSION,
    complete,
    attributable,
    refCount,
    taskRelevantRefCount: taskRelevant.length,
    unrelatedRefCount: unrelated.length,
    taskRelevantRefIdentity,
    unrelatedRefIdentity,
    taskRelevantRefs: attributable ? taskRelevant.map(privateRecord) : [],
    unrelatedRefs: attributable ? unrelated.map(privateRecord) : []
  };
}

/**
 * Observe assume-unchanged / skip-worktree index flags and the actual worktree
 * bytes they would otherwise hide from `status` / `ls-files --stage`.
 *
 * Does not mutate the index. Paths are digested only. Absence of a
 * skip-worktree path is valid (legitimate sparse-checkout); presence binds
 * content. Assume-unchanged always binds worktree content and an absent path
 * fails closed, so pre-flagged out-of-scope changes cannot hide. Hard
 * entry/byte bounds apply.
 */
function captureIndexFlagObservation(workspaceRoot) {
  const flagRun = git(
    workspaceRoot,
    ["ls-files", "-v", "-z"],
    { allowFailure: true, maxBuffer: 64 * 1024 * 1024 }
  );
  if (flagRun.error || flagRun.status !== 0) {
    return {
      identity: sha("index-flags-v2:unavailable"),
      observable: false,
      truncated: true
    };
  }
  if (String(flagRun.stderr || "").trim()) {
    return {
      identity: sha("index-flags-v2:stderr"),
      observable: false,
      truncated: true
    };
  }

  const flagged = [];
  let truncated = false;
  let unreadable = false;
  const flagRaw = String(flagRun.stdout || "");
  // Exact Git format for `ls-files -v -z`: <tag><SP><path>\0
  // (tag is one character, then a single ASCII space, then the path bytes).
  // Do not treat the separator as part of the path — that hashes a wrong
  // absent path and misses assume-unchanged / skip-worktree overwrites.
  for (const record of flagRaw.split("\0")) {
    if (!record) continue;
    if (record.length < 3 || record[1] !== " ") {
      unreadable = true;
      continue;
    }
    const tag = record[0];
    const relativePath = record.slice(2);
    if (!tag || !relativePath || relativePath.length > 4096) {
      unreadable = true;
      continue;
    }
    // Reject NUL/control separators already split; keep arbitrary valid path
    // bytes for private digest only (never published).
    if (relativePath.includes("\0")) {
      unreadable = true;
      continue;
    }
    // Normalize flag class without retaining raw path text in the identity
    // record beyond a private digest.
    const pathDigest = sha(relativePath.replace(/\\/g, "/"));
    // Git ls-files -v tags (common):
    //   H = cached normal, S = skip-worktree, h = assume-unchanged,
    //   lowercase variants mark assume-unchanged combinations.
    const isSkipWorktree = tag === "S" || tag === "s";
    const isAssumeUnchanged = tag === "h"
      || (tag !== "H" && tag !== "S" && tag === tag.toLowerCase());
    if (!isSkipWorktree && !isAssumeUnchanged) {
      // Ordinary cached entries are covered by trackedTreeIdentity; skip.
      continue;
    }
    if (flagged.length >= MAX_INDEX_FLAG_ENTRIES) {
      truncated = true;
      break;
    }
    const flagClass = isSkipWorktree
      ? (isAssumeUnchanged
          ? "skip-worktree+assume-unchanged"
          : "skip-worktree")
      : "assume-unchanged";
    flagged.push({
      tag,
      flagClass,
      isSkipWorktree,
      relativePath,
      pathDigest
    });
  }

  const stageRun = flagged.length === 0
    ? { status: 0, stdout: "", stderr: "", error: null }
    : git(
        workspaceRoot,
        ["ls-files", "--stage", "-z"],
        { allowFailure: true, maxBuffer: 64 * 1024 * 1024 }
      );
  if (stageRun.error
    || stageRun.status !== 0
    || String(stageRun.stderr || "").trim()) {
    unreadable = true;
  }

  // Bind flagged paths to their exact stage-0 index mode and object ID.
  // Multiple stages, malformed records, or a flag/index inventory race are
  // unobservable rather than being guessed from the worktree node type.
  const flaggedPaths = new Set(flagged.map((entry) => entry.relativePath));
  const stageEntries = new Map();
  const stageRaw = String(stageRun.stdout || "");
  if (!unreadable) {
    for (const record of stageRaw.split("\0")) {
      if (!record) continue;
      const separator = record.indexOf("\t");
      if (separator <= 0) {
        unreadable = true;
        continue;
      }
      const header = record.slice(0, separator);
      const relativePath = record.slice(separator + 1);
      const match = /^([0-7]{6}) ([a-fA-F0-9]{40,64}) ([0-3])$/.exec(header);
      if (!match || !relativePath) {
        unreadable = true;
        continue;
      }
      if (!flaggedPaths.has(relativePath)) continue;
      const records = stageEntries.get(relativePath) || [];
      records.push({
        indexMode: match[1],
        indexOid: match[2].toLowerCase(),
        stage: Number(match[3])
      });
      stageEntries.set(relativePath, records);
    }
  }

  const entries = [];
  let hashedBytes = 0;
  for (const flaggedEntry of flagged) {
    const {
      tag,
      flagClass,
      isSkipWorktree,
      relativePath,
      pathDigest
    } = flaggedEntry;
    const indexed = stageEntries.get(relativePath) || [];
    const indexEntry = indexed.length === 1 && indexed[0].stage === 0
      ? indexed[0]
      : null;
    if (!indexEntry) {
      unreadable = true;
      entries.push({
        pathDigest,
        flag: tag,
        flagClass,
        indexMode: null,
        indexOid: null,
        worktreeKind: "unreadable",
        worktreeDigest: null
      });
      continue;
    }
    const { indexMode, indexOid } = indexEntry;
    let worktreeDigest = null;
    let worktreeKind = "absent";
    const absolute = path.resolve(workspaceRoot, relativePath);
    // Refuse path escape.
    if (absolute !== workspaceRoot && !absolute.startsWith(`${workspaceRoot}${path.sep}`)) {
      unreadable = true;
      entries.push({
        pathDigest,
        flag: tag,
        flagClass,
        indexMode,
        indexOid,
        worktreeKind: "outside",
        worktreeDigest: null
      });
      continue;
    }

    // A 160000 entry is a gitlink, not an ordinary directory. The context
    // manifest does not attempt to authenticate a nested repository lifecycle;
    // detect it from the exact index mode and fail closed.
    if (indexMode === "160000") {
      unreadable = true;
      entries.push({
        pathDigest,
        flag: tag,
        flagClass,
        indexMode,
        indexOid,
        worktreeKind: "gitlink",
        worktreeDigest: sha(canonicalJson({
          schema: "flagged-gitlink-v1",
          indexMode,
          indexOid
        }))
      });
      continue;
    }

    let stat;
    try {
      stat = fs.lstatSync(absolute, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT" && isSkipWorktree) {
        // skip-worktree absence is normal for sparse-checkout cones.
        worktreeKind = "absent";
      } else {
        unreadable = true;
        worktreeKind = "unreadable";
      }
      entries.push({
        pathDigest,
        flag: tag,
        flagClass,
        indexMode,
        indexOid,
        worktreeKind,
        worktreeDigest: null
      });
      continue;
    }
    if (stat.isSymbolicLink()) {
      worktreeKind = "symlink";
      try {
        if (indexMode !== "120000") {
          throw new Error("Index/worktree type mismatch.");
        }
        const beforeSignature = metadataSymlinkStatSignature(stat);
        const targetDigest = sha(String(fs.readlinkSync(absolute)));
        const after = fs.lstatSync(absolute, { bigint: true });
        if (!after.isSymbolicLink()
          || metadataSymlinkStatSignature(after) !== beforeSignature) {
          throw new Error("Symlink changed during observation.");
        }
        worktreeDigest = sha(canonicalJson({
          schema: "flagged-symlink-v1",
          statSignature: beforeSignature,
          targetDigest
        }));
      } catch {
        unreadable = true;
        worktreeKind = "unreadable";
        worktreeDigest = null;
      }
    } else if (stat.isFile()) {
      worktreeKind = "file";
      if (!/^100[0-7]{3}$/.test(indexMode)) {
        unreadable = true;
        worktreeKind = "unreadable";
      }
      // Bound content hashing; oversize files truncate the inventory.
      const remaining = MAX_METADATA_HASH_BYTES - hashedBytes;
      if (worktreeKind === "unreadable") {
        worktreeDigest = null;
      } else if (remaining <= 0) {
        truncated = true;
        worktreeDigest = null;
      } else {
        const probe = { hashedBytes: 0, unreadable: false, truncated: false };
        const fileIdentity = hashBoundedMetadataFile(absolute, probe, remaining);
        hashedBytes += probe.hashedBytes;
        if (probe.unreadable || fileIdentity.kind === "unobservable") {
          unreadable = true;
          worktreeKind = "unreadable";
          worktreeDigest = null;
        } else if (probe.truncated || fileIdentity.digest == null) {
          truncated = true;
          worktreeDigest = null;
        } else {
          worktreeDigest = sha(canonicalJson({
            schema: "flagged-file-v1",
            mode: fileIdentity.mode,
            size: fileIdentity.size,
            contentDigest: fileIdentity.digest
          }));
        }
      }
    } else if (stat.isDirectory()) {
      // Non-gitlink index entries cannot legitimately be directories.
      unreadable = true;
      worktreeKind = "unreadable";
      worktreeDigest = null;
    } else {
      unreadable = true;
      worktreeKind = "unreadable";
      worktreeDigest = null;
    }
    entries.push({
      pathDigest,
      flag: tag,
      flagClass,
      indexMode,
      indexOid,
      worktreeKind,
      worktreeDigest
    });
  }

  if (flagged.length > 0) {
    const flagReread = git(
      workspaceRoot,
      ["ls-files", "-v", "-z"],
      { allowFailure: true, maxBuffer: 64 * 1024 * 1024 }
    );
    const stageReread = git(
      workspaceRoot,
      ["ls-files", "--stage", "-z"],
      { allowFailure: true, maxBuffer: 64 * 1024 * 1024 }
    );
    if (flagReread.error
      || flagReread.status !== 0
      || String(flagReread.stderr || "").trim()
      || String(flagReread.stdout || "") !== flagRaw
      || stageReread.error
      || stageReread.status !== 0
      || String(stageReread.stderr || "").trim()
      || String(stageReread.stdout || "") !== stageRaw) {
      unreadable = true;
    }
  }
  entries.sort((left, right) => {
    const byPath = left.pathDigest.localeCompare(right.pathDigest);
    if (byPath !== 0) return byPath;
    return left.flag.localeCompare(right.flag);
  });
  const failClosed = truncated || unreadable || entries.length >= MAX_INDEX_FLAG_ENTRIES;
  return {
    identity: sha(canonicalJson({
      schema: "index-flags-v2",
      entries,
      truncated: failClosed,
      unreadable
    })),
    observable: !failClosed,
    truncated: failClosed
  };
}

function captureTaskRelevantGitMetadata(gitDir, commonDir, workspaceRoot, {
  currentBranchRef = null,
  upstreamFullRef = null,
  upstreamConfigured = false
} = {}) {
  const nonRef = captureTaskRelevantNonRefEntries(gitDir, commonDir);
  const operational = captureWorktreeOperationalIdentity(gitDir, workspaceRoot);
  const hooks = captureEffectiveHooksIdentity(workspaceRoot);
  const config = captureEffectiveGitConfigIdentity(workspaceRoot);
  const indexFlags = captureIndexFlagObservation(workspaceRoot);
  const semanticRefs = captureSemanticSharedRefs(workspaceRoot);
  const sharedRefIdentity = buildSharedRefIdentity(semanticRefs, { currentBranchRef, upstreamFullRef });
  // Fail closed when non-ref / operational / effective-hooks / effective-config
  // inventory is truncated or unobservable, refs are unavailable, or a
  // configured upstream cannot be positively resolved to a full refs/ name.
  // Without a full upstream ref, remote-tracking refs must not be treated as
  // unrelated (which would incorrectly tolerate upstream target churn).
  const upstreamUnresolved = Boolean(upstreamConfigured) && !upstreamFullRef;
  if (
    nonRef.truncated
    || !nonRef.observable
    || operational.truncated
    || !operational.observable
    || !hooks.observable
    || hooks.truncated
    || !config.observable
    || config.truncated
    || !indexFlags.observable
    || indexFlags.truncated
    || !semanticRefs.available
    || upstreamUnresolved
  ) {
    sharedRefIdentity.complete = false;
    sharedRefIdentity.attributable = false;
    sharedRefIdentity.taskRelevantRefs = [];
    sharedRefIdentity.unrelatedRefs = [];
  }
  // Private digests only: operational/hooks/config absolute paths and raw
  // config values never appear here.
  const taskRelevantMetadataIdentity = sha(canonicalJson({
    nonRefIdentity: nonRef.identity,
    nonRefTruncated: nonRef.truncated,
    nonRefObservable: nonRef.observable,
    operationalIdentity: operational.identity,
    operationalObservable: operational.observable,
    hooksIdentity: hooks.identity,
    hooksObservable: hooks.observable,
    configIdentity: config.identity,
    configObservable: config.observable,
    indexFlagIdentity: indexFlags.identity,
    indexFlagObservable: indexFlags.observable,
    taskRelevantRefIdentity: sharedRefIdentity.taskRelevantRefIdentity,
    sharedRefComplete: sharedRefIdentity.complete,
    sharedRefAttributable: sharedRefIdentity.attributable,
    upstreamUnresolved
  }));
  return { taskRelevantMetadataIdentity, sharedRefIdentity };
}

function isSha256Hex(value) {
  return typeof value === "string" && SHA256_HEX.test(value);
}

function isPublicRefSnapshotEntry(entry) {
  return entry
    && typeof entry === "object"
    && !Array.isArray(entry)
    && typeof entry.name === "string"
    && entry.name.startsWith("refs/")
    && entry.name.length > 0
    && entry.name.length <= MAX_SHARED_REF_FIELD_BYTES
    && typeof entry.target === "string"
    && entry.target.length > 0
    && entry.target.length <= MAX_SHARED_REF_FIELD_BYTES
    && typeof entry.resolvedOid === "string"
    && /^[a-f0-9]{40,64}$/.test(entry.resolvedOid)
    && (entry.class === SHARED_REF_CLASS_TASK_RELEVANT || entry.class === SHARED_REF_CLASS_UNRELATED)
    && !entry.name.includes("\0")
    && !entry.target.includes("\0")
    && (entry.target.startsWith("refs/")
      || entry.target.toLowerCase() === entry.resolvedOid)
    && !/^(?:\/|[A-Za-z]:[\\/]|~\/)/.test(entry.target);
}

/**
 * Inspect explicit task-relevant metadata support on a stored git manifest.
 * Returns "absent" | "valid" | "malformed".
 */
function inspectTaskRelevantMetadataSupport(gitManifest) {
  if (!gitManifest || typeof gitManifest !== "object") return "absent";
  const hasTaskIdentity = Object.hasOwn(gitManifest, "taskRelevantMetadataIdentity");
  const hasShared = Object.hasOwn(gitManifest, "sharedRefIdentity");
  if (!hasTaskIdentity && !hasShared) return "absent";
  if (!hasTaskIdentity || !hasShared) return "malformed";
  if (!isSha256Hex(gitManifest.taskRelevantMetadataIdentity)) return "malformed";
  const identity = gitManifest.sharedRefIdentity;
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return "malformed";
  if (identity.schemaVersion !== SHARED_REF_IDENTITY_SCHEMA_VERSION) return "malformed";
  if (typeof identity.complete !== "boolean" || typeof identity.attributable !== "boolean") return "malformed";
  if (!Number.isInteger(identity.refCount) || identity.refCount < 0) return "malformed";
  if (!Number.isInteger(identity.taskRelevantRefCount) || identity.taskRelevantRefCount < 0) return "malformed";
  if (!Number.isInteger(identity.unrelatedRefCount) || identity.unrelatedRefCount < 0) return "malformed";
  if (identity.taskRelevantRefCount + identity.unrelatedRefCount !== identity.refCount) return "malformed";
  if (!isSha256Hex(identity.taskRelevantRefIdentity) || !isSha256Hex(identity.unrelatedRefIdentity)) {
    return "malformed";
  }
  if (!Array.isArray(identity.taskRelevantRefs) || !Array.isArray(identity.unrelatedRefs)) return "malformed";
  // complete ⇒ within inventory budget; attributable ⇒ complete and within
  // per-entry evidence budget. Reject impossible combinations.
  if (identity.complete && identity.refCount > MAX_SHARED_REFS) return "malformed";
  if (identity.attributable !== (identity.complete && identity.refCount <= MAX_SHARED_REF_ATTRIBUTABLE)) {
    return "malformed";
  }
  if (identity.taskRelevantRefs.length !== (identity.attributable ? identity.taskRelevantRefCount : 0)) {
    return "malformed";
  }
  if (identity.unrelatedRefs.length !== (identity.attributable ? identity.unrelatedRefCount : 0)) {
    return "malformed";
  }
  const names = new Set();
  for (const entry of [...identity.taskRelevantRefs, ...identity.unrelatedRefs]) {
    if (!isPublicRefSnapshotEntry(entry) || names.has(entry.name)) return "malformed";
    names.add(entry.name);
  }
  for (const entry of identity.taskRelevantRefs) {
    if (entry.class !== SHARED_REF_CLASS_TASK_RELEVANT) return "malformed";
  }
  for (const entry of identity.unrelatedRefs) {
    if (entry.class !== SHARED_REF_CLASS_UNRELATED) return "malformed";
  }
  return "valid";
}

/**
 * Compare Git metadata between two manifests.
 *
 * DEFAULT policy:
 * Both sides valid + complete + attributable + linkedWorktree=true: tolerate only
 * unrelated shared-ref identity changes (issue #34 linked-worktree scope).
 * Both sides valid with linkedWorktree=false: strict full metadataIdentity
 * comparison (no unrelated-ref tolerance); task-relevant identity still fails
 * closed for operational/hooks/config drift the legacy tree may omit.
 * Attribution is required only for linked-worktree unrelated-ref tolerance.
 * Primary complete-but-unattributable inventories with identical strict digests
 * pass; any primary full/task/ref identity drift fails.
 * Mismatched or missing linkedWorktree when new support is claimed: fail closed.
 * Both sides absent (pure legacy): full metadataIdentity comparison; equal digests pass.
 * Mixed or malformed claims: fail closed unconditionally (even when legacy digests match).
 * Incomplete inventories always fail closed. Linked unattributable inventories
 * fail closed (no unrelated-ref tolerance without attribution).
 *
 * SUPERVISORY_LINKED_WRITE policy (managed write primary-control rechecks only):
 * both sides must be valid, complete, attributable primary worktrees with identical
 * taskRelevantMetadataIdentity and taskRelevantRefIdentity; only unrelatedRefIdentity
 * and full metadataIdentity representation drift is tolerated. Linked, mixed,
 * incomplete, unattributable, or malformed inventories fail closed.
 */
function classifyGitMetadataObservation(
  preGit,
  postGit,
  metadataPolicy = CONTEXT_METADATA_POLICIES.DEFAULT
) {
  const empty = {
    schemaVersion: SHARED_REF_OBSERVATION_SCHEMA_VERSION,
    classification: GIT_METADATA_CLASSIFICATIONS.UNCHANGED,
    toleratedUnrelatedSharedRefChurn: false,
    taskRelevantMetadataDrift: false
  };
  const failClosed = {
    schemaVersion: SHARED_REF_OBSERVATION_SCHEMA_VERSION,
    classification: GIT_METADATA_CLASSIFICATIONS.FAIL_CLOSED,
    toleratedUnrelatedSharedRefChurn: false,
    taskRelevantMetadataDrift: true
  };
  const taskRelevantDrift = {
    schemaVersion: SHARED_REF_OBSERVATION_SCHEMA_VERSION,
    classification: GIT_METADATA_CLASSIFICATIONS.TASK_RELEVANT_METADATA_DRIFT,
    toleratedUnrelatedSharedRefChurn: false,
    taskRelevantMetadataDrift: true
  };
  const toleratedUnrelated = {
    schemaVersion: SHARED_REF_OBSERVATION_SCHEMA_VERSION,
    classification: GIT_METADATA_CLASSIFICATIONS.TOLERATED_UNRELATED_SHARED_REFS,
    toleratedUnrelatedSharedRefChurn: true,
    taskRelevantMetadataDrift: false
  };
  if (!preGit || !postGit) return empty;
  const preSupport = inspectTaskRelevantMetadataSupport(preGit);
  const postSupport = inspectTaskRelevantMetadataSupport(postGit);

  if (metadataPolicy === CONTEXT_METADATA_POLICIES.SUPERVISORY_LINKED_WRITE) {
    // Supervisory policy never degrades to legacy/mixed acceptance.
    if (preSupport !== "valid" || postSupport !== "valid") return failClosed;
    if (!preGit.sharedRefIdentity.complete || !postGit.sharedRefIdentity.complete) {
      return failClosed;
    }
    if (!preGit.sharedRefIdentity.attributable || !postGit.sharedRefIdentity.attributable) {
      return failClosed;
    }
    const preLinked = preGit.linkedWorktree;
    const postLinked = postGit.linkedWorktree;
    // Primary-vs-primary only: managed control-root rechecks.
    if (preLinked !== false || postLinked !== false) return failClosed;
    if (preGit.taskRelevantMetadataIdentity !== postGit.taskRelevantMetadataIdentity) {
      return taskRelevantDrift;
    }
    if (preGit.sharedRefIdentity.taskRelevantRefIdentity
      !== postGit.sharedRefIdentity.taskRelevantRefIdentity) {
      return taskRelevantDrift;
    }
    // Allow only unrelated-ref / full metadataIdentity representation drift.
    if (preGit.sharedRefIdentity.unrelatedRefIdentity
        !== postGit.sharedRefIdentity.unrelatedRefIdentity
      || (preGit.metadataIdentity || null) !== (postGit.metadataIdentity || null)) {
      return toleratedUnrelated;
    }
    return empty;
  }

  if (preSupport === "valid" && postSupport === "valid") {
    // Incomplete inventories cannot safely classify refs.
    if (!preGit.sharedRefIdentity.complete || !postGit.sharedRefIdentity.complete) {
      return failClosed;
    }
    // Linked-worktree tolerance requires explicit boolean linkedWorktree on both
    // sides. Missing or mismatched identity fails closed when new support is claimed.
    const preLinked = preGit.linkedWorktree;
    const postLinked = postGit.linkedWorktree;
    if (typeof preLinked !== "boolean" || typeof postLinked !== "boolean") {
      return failClosed;
    }
    if (preLinked !== postLinked) {
      return failClosed;
    }

    // Primary worktree: strict digest comparison; attribution not required.
    // complete-but-unattributable (>attributable cap, <=inventory cap) identical
    // manifests pass. Any full/task/ref identity drift still fails.
    if (!preLinked) {
      if (preGit.taskRelevantMetadataIdentity !== postGit.taskRelevantMetadataIdentity) {
        return taskRelevantDrift;
      }
      if ((preGit.metadataIdentity || null) !== (postGit.metadataIdentity || null)) {
        return taskRelevantDrift;
      }
      if (preGit.sharedRefIdentity.taskRelevantRefIdentity
        !== postGit.sharedRefIdentity.taskRelevantRefIdentity) {
        return taskRelevantDrift;
      }
      if (preGit.sharedRefIdentity.unrelatedRefIdentity
        !== postGit.sharedRefIdentity.unrelatedRefIdentity) {
        return taskRelevantDrift;
      }
      return empty;
    }

    // Linked worktree: attribution is required before unrelated-ref tolerance.
    if (!preGit.sharedRefIdentity.attributable || !postGit.sharedRefIdentity.attributable) {
      return failClosed;
    }

    // Linked worktree: tolerate only unrelated shared-ref identity changes.
    if (preGit.taskRelevantMetadataIdentity !== postGit.taskRelevantMetadataIdentity) {
      return taskRelevantDrift;
    }
    if (preGit.sharedRefIdentity.unrelatedRefIdentity !== postGit.sharedRefIdentity.unrelatedRefIdentity) {
      return toleratedUnrelated;
    }
    return empty;
  }

  // Pure legacy: both sides claim neither new field. Equal full metadataIdentity passes.
  if (preSupport === "absent" && postSupport === "absent") {
    if ((preGit.metadataIdentity || null) !== (postGit.metadataIdentity || null)) {
      return {
        schemaVersion: SHARED_REF_OBSERVATION_SCHEMA_VERSION,
        classification: GIT_METADATA_CLASSIFICATIONS.LEGACY_METADATA_DRIFT,
        toleratedUnrelatedSharedRefChurn: false,
        taskRelevantMetadataDrift: true
      };
    }
    return empty;
  }

  // Mixed (only one side has valid new identity) or any malformed claim:
  // fail closed unconditionally — never treat equal legacy digests as unchanged.
  return failClosed;
}

function observeGitMetadataDrift(preGit, postGit, changed) {
  const observation = classifyGitMetadataObservation(preGit, postGit);
  if (observation.taskRelevantMetadataDrift) changed.add("[GIT_METADATA]");
  return observation;
}

/**
 * ContextManifest v1 predates the split task-relevant/shared-ref identities.
 * When either side is a genuine v1 record, compare the retained full metadata
 * identity strictly. This permits an unchanged historical record to cross the
 * v1 -> v2 reader boundary without granting v2's linked-worktree ref-churn
 * tolerance to legacy evidence that cannot attribute that churn safely.
 */
function classifyContextGitMetadataObservation(
  preContext,
  postContext,
  metadataPolicy = CONTEXT_METADATA_POLICIES.DEFAULT
) {
  const legacyBoundary = preContext?.schemaVersion === LEGACY_CONTEXT_MANIFEST_VERSION
    || postContext?.schemaVersion === LEGACY_CONTEXT_MANIFEST_VERSION;
  if (!legacyBoundary) {
    return classifyGitMetadataObservation(
      preContext?.git,
      postContext?.git,
      metadataPolicy
    );
  }
  const unchanged = {
    schemaVersion: SHARED_REF_OBSERVATION_SCHEMA_VERSION,
    classification: GIT_METADATA_CLASSIFICATIONS.UNCHANGED,
    toleratedUnrelatedSharedRefChurn: false,
    taskRelevantMetadataDrift: false
  };
  const failClosed = {
    schemaVersion: SHARED_REF_OBSERVATION_SCHEMA_VERSION,
    classification: GIT_METADATA_CLASSIFICATIONS.FAIL_CLOSED,
    toleratedUnrelatedSharedRefChurn: false,
    taskRelevantMetadataDrift: true
  };
  const legacyDrift = {
    schemaVersion: SHARED_REF_OBSERVATION_SCHEMA_VERSION,
    classification: GIT_METADATA_CLASSIFICATIONS.LEGACY_METADATA_DRIFT,
    toleratedUnrelatedSharedRefChurn: false,
    taskRelevantMetadataDrift: true
  };
  if (metadataPolicy !== CONTEXT_METADATA_POLICIES.DEFAULT) return failClosed;
  const preMetadataIdentity = preContext?.git?.metadataIdentity;
  const postMetadataIdentity = postContext?.git?.metadataIdentity;
  if (!isSha256Hex(preMetadataIdentity) || !isSha256Hex(postMetadataIdentity)) {
    return failClosed;
  }
  return preMetadataIdentity === postMetadataIdentity
    ? unchanged
    : legacyDrift;
}

function observeContextGitMetadataDrift(preContext, postContext, changed) {
  const observation = classifyContextGitMetadataObservation(
    preContext,
    postContext
  );
  if (observation.taskRelevantMetadataDrift) changed.add("[GIT_METADATA]");
  return observation;
}

function worktreePathIdentity(root, relativePath) {
  const absolute = path.resolve(root, relativePath);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return { fileKind: "outside", fileMode: null, worktreeHash: null };
  let stat;
  try { stat = fs.lstatSync(absolute); }
  catch (error) { return { fileKind: error.code === "ENOENT" ? "missing" : "unreadable", fileMode: null, worktreeHash: null }; }
  const fileMode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) {
    let target = "";
    try { target = fs.readlinkSync(absolute); } catch {}
    return { fileKind: "symlink", fileMode, worktreeHash: sha(target) };
  }
  if (stat.isFile()) {
    const hashRun = git(root, ["hash-object", "--no-filters", "--", relativePath], { allowFailure: true });
    return {
      fileKind: "file",
      fileMode,
      worktreeHash: hashRun.status === 0 ? String(hashRun.stdout || "").trim() || null : null
    };
  }
  if (stat.isDirectory()) {
    const submoduleRun = git(root, ["-C", absolute, "rev-parse", "HEAD"], { allowFailure: true });
    return {
      fileKind: "directory",
      fileMode,
      worktreeHash: submoduleRun.status === 0 ? String(submoduleRun.stdout || "").trim() || null : null
    };
  }
  return { fileKind: "other", fileMode, worktreeHash: null };
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== "string" || !value) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function contextManifestIntegrityError(message = "Stored context manifest integrity check failed; refusing to continue with a tampered or malformed identity.") {
  throw new CompanionError("E_CONTEXT_DRIFT", message, {
    code: "E_CONTEXT_DRIFT",
    reasons: ["manifestIntegrity"]
  });
}

/**
 * Validate a stored ContextManifest's immutable body/digest/id/capturedAt binding.
 * Recomputes sha(canonicalJson(body)) after excluding only manifestId and digest.
 * capturedAt is chronology-bearing authority and therefore remains authenticated.
 * Returns the unchanged stored object on success; never rebinds identity.
 * Failures are privacy-safe E_CONTEXT_DRIFT (no private path/config/hook leakage).
 */
export function assertContextManifestIntegrity(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    contextManifestIntegrityError();
  }
  if (manifest.schemaVersion !== CONTEXT_MANIFEST_VERSION
    && manifest.schemaVersion !== LEGACY_CONTEXT_MANIFEST_VERSION) {
    contextManifestIntegrityError();
  }
  if (typeof manifest.workspaceRoot !== "string" || !manifest.workspaceRoot) {
    contextManifestIntegrityError();
  }
  if (!manifest.git || typeof manifest.git !== "object" || Array.isArray(manifest.git)) {
    contextManifestIntegrityError();
  }
  if (!Array.isArray(manifest.projectMarkers)) {
    contextManifestIntegrityError();
  }
  if (!manifest.materialization || typeof manifest.materialization !== "object"
    || Array.isArray(manifest.materialization)) {
    contextManifestIntegrityError();
  }
  if (typeof manifest.digest !== "string" || !SHA256_HEX.test(manifest.digest)) {
    contextManifestIntegrityError();
  }
  if (typeof manifest.manifestId !== "string"
    || !CONTEXT_MANIFEST_ID.test(manifest.manifestId)
    || manifest.manifestId !== `ctx-${manifest.digest.slice(0, 24)}`) {
    contextManifestIntegrityError();
  }
  if (!isCanonicalIsoTimestamp(manifest.capturedAt)) {
    contextManifestIntegrityError();
  }
  const body = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (key === "manifestId" || key === "digest") continue;
    if (manifest.schemaVersion === LEGACY_CONTEXT_MANIFEST_VERSION
      && key === "capturedAt") continue;
    body[key] = value;
  }
  const recomputed = sha(canonicalJson(body));
  if (recomputed !== manifest.digest
    || `ctx-${recomputed.slice(0, 24)}` !== manifest.manifestId) {
    contextManifestIntegrityError();
  }
  return manifest;
}

/**
 * Validate current workspace still matches a stored ContextManifest.
 * Throws E_CONTEXT_DRIFT rather than executing in the wrong checkout.
 *
 * Integrity-checks the stored expected manifest first and returns that unchanged
 * object on success so callers retain immutable stored ID/digest bindings.
 *
 * mode:
 * Both execute and explicit resume require the exact recorded checkout state. Resume callers
 * must pass the previous job's completion manifest, not its acceptance-time manifest.
 * "legacy-resume" exists only for schema-v2 jobs that did not retain a completion manifest.
 *
 * metadataPolicy:
 * DEFAULT keeps strict-primary / tolerant-linked classification.
 * SUPERVISORY_LINKED_WRITE is only for managed write primary-control rechecks and is
 * rejected under legacy-resume. Unknown policies fail closed.
 */
export function assertContextCompatible(root, expected, {
  mode = "execute",
  metadataPolicy = CONTEXT_METADATA_POLICIES.DEFAULT
} = {}) {
  if (!CONTEXT_METADATA_POLICY_VALUES.has(metadataPolicy)) {
    throw new CompanionError(
      "E_CONTEXT_DRIFT",
      "Unknown context metadata policy; refusing to continue with an unverified workspace identity.",
      { code: "E_CONTEXT_DRIFT", reasons: ["metadataPolicy"] }
    );
  }
  if (mode === "legacy-resume"
    && metadataPolicy === CONTEXT_METADATA_POLICIES.SUPERVISORY_LINKED_WRITE) {
    throw new CompanionError(
      "E_CONTEXT_DRIFT",
      "Supervisory linked-write context policy is unavailable for legacy resume.",
      { code: "E_CONTEXT_DRIFT", reasons: ["metadataPolicy"] }
    );
  }
  const stored = assertContextManifestIntegrity(expected);
  const current = captureContextManifest(root);
  const reasons = [];
  if (current.workspaceRoot !== stored.workspaceRoot) reasons.push("workspaceRoot");
  if (Boolean(current.git?.linkedWorktree) !== Boolean(stored.git?.linkedWorktree)) reasons.push("linkedWorktree");
  if (Boolean(current.git?.sparse) !== Boolean(stored.git?.sparse)) reasons.push("sparse");
  if (Boolean(current.git?.shallow) !== Boolean(stored.git?.shallow)) reasons.push("shallow");
  if ((current.git?.branch || null) !== (stored.git?.branch || null)) reasons.push("branch");
  if (Boolean(current.git?.insideWorktree) !== Boolean(stored.git?.insideWorktree)) reasons.push("insideWorktree");
  if (Array.isArray(stored.projectMarkers)
    && canonicalJson(current.projectMarkers) !== canonicalJson(stored.projectMarkers)) reasons.push("projectMarkers");
  if (mode !== "legacy-resume") {
    if ((current.git?.head || null) !== (stored.git?.head || null)) reasons.push("head");
    if ((current.git?.trackedTreeIdentity || null) !== (stored.git?.trackedTreeIdentity || null)) reasons.push("trackedTreeIdentity");
    const metadataObservation = classifyContextGitMetadataObservation(
      stored,
      current,
      metadataPolicy
    );
    if (metadataObservation.taskRelevantMetadataDrift) {
      const currentSupport = inspectTaskRelevantMetadataSupport(current.git);
      const expectedSupport = inspectTaskRelevantMetadataSupport(stored.git);
      if (currentSupport === "valid" && expectedSupport === "valid") {
        reasons.push("taskRelevantMetadataIdentity");
      } else {
        reasons.push("metadataIdentity");
      }
    }
    if ((current.git?.dirtyDigest || null) !== (stored.git?.dirtyDigest || null)) reasons.push("dirtyDigest");
    if ((current.git?.ignoredDigest || null) !== (stored.git?.ignoredDigest || null)) reasons.push("ignoredDigest");
    if ((current.git?.upstreamRef || null) !== (stored.git?.upstreamRef || null)) reasons.push("upstreamRef");
    if ((current.git?.upstreamCommit || null) !== (stored.git?.upstreamCommit || null)) reasons.push("upstreamCommit");
  }
  if (reasons.length) {
    throw new CompanionError(
      "E_CONTEXT_DRIFT",
      `Workspace identity drifted (${reasons.join(", ")}); refusing to execute or resume in a different checkout.`,
      {
        code: "E_CONTEXT_DRIFT",
        reasons,
        expected: {
          manifestId: stored.manifestId || null,
          digest: stored.digest || null,
          workspaceRoot: stored.workspaceRoot || null,
          head: stored.git?.head || null,
          branch: stored.git?.branch || null
        },
        current: {
          manifestId: current.manifestId,
          digest: current.digest,
          workspaceRoot: current.workspaceRoot,
          head: current.git?.head || null,
          branch: current.git?.branch || null
        }
      }
    );
  }
  // Immutable stored authority: never rebind callers to a fresh capture.
  return stored;
}

/**
 * Assign strictly increasing integer sequences to lifecycle events.
 * Legacy entries without a sequence receive deterministic 1..n values in array order.
 * Existing valid sequences are preserved when they remain strictly increasing.
 */
export function normalizeLifecycleEventSequences(events) {
  if (!Array.isArray(events) || events.length === 0) return [];
  let lastSequence = 0;
  return events.map((event) => {
    const base = event && typeof event === "object" && !Array.isArray(event)
      ? { ...event }
      : { type: "checkpoint", at: null, summary: "" };
    const provided = base.sequence;
    let sequence;
    if (Number.isSafeInteger(provided) && provided > lastSequence) {
      sequence = provided;
    } else {
      if (lastSequence >= Number.MAX_SAFE_INTEGER) {
        throw new CompanionError("E_STATE", "Lifecycle event sequence space is exhausted.");
      }
      sequence = lastSequence + 1;
    }
    lastSequence = sequence;
    return { ...base, sequence };
  });
}

/**
 * Append a typed lifecycle event with a durable monotonic sequence number.
 * Retention keeps the newest MAX_LIFECYCLE_EVENTS entries; sequences of retained
 * events are unchanged so cursors survive normal append/restart behavior.
 */
export function appendLifecycleEvent(events, type, summary, detail = undefined) {
  if (!LIFECYCLE_EVENT_TYPES.includes(type)) {
    throw new CompanionError("E_STATE", `Unknown lifecycle event type ${type}.`);
  }
  const normalized = normalizeLifecycleEventSequences(Array.isArray(events) ? events : []);
  const list = normalized.length >= MAX_LIFECYCLE_EVENTS
    ? normalized.slice(-(MAX_LIFECYCLE_EVENTS - 1))
    : normalized.slice();
  const lastSequence = list.length
    ? list[list.length - 1].sequence
    : (normalized.length ? normalized[normalized.length - 1].sequence : 0);
  if (lastSequence >= Number.MAX_SAFE_INTEGER) {
    throw new CompanionError("E_STATE", "Lifecycle event sequence space is exhausted.");
  }
  const entry = {
    type,
    at: timestamp(),
    summary: clip(redactText(summary || type), 500),
    sequence: lastSequence + 1
  };
  if (detail !== undefined) entry.detail = redact(boundLifecycleDetail(detail));
  list.push(entry);
  return list;
}

function boundLifecycleDetail(detail) {
  if (detail == null) return null;
  if (typeof detail === "string") return clip(detail, 1000);
  if (Array.isArray(detail)) return detail.slice(0, 20).map((item) => boundLifecycleDetail(item));
  if (typeof detail !== "object") return detail;
  const out = {};
  for (const [key, value] of Object.entries(detail).slice(0, 20)) {
    if (/(secret|token|authorization|password|credential|cookie|api[-_]?key)/i.test(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    if (typeof value === "string") out[key] = clip(value, 1000);
    else if (Array.isArray(value)) out[key] = value.slice(0, 20).map((item) => (typeof item === "string" ? clip(item, 500) : item));
    else if (value && typeof value === "object") out[key] = boundLifecycleDetail(value);
    else out[key] = value;
  }
  return out;
}

/**
 * Build a structured final worker report from provider output.
 * Interim message text must not be passed here.
 */
export function buildWorkerReport(options = {}) {
  const {
    providerText = "",
    outcome = null,
    summary = null,
    changedFiles = null,
    checksClaimed = null,
    acceptanceResults = null,
    risks = null,
    questions = null,
    hostActionRequest = undefined,
    acceptanceCriteria = [],
    nativeStructuredOutput = undefined,
    nativeStructuredOutputError = undefined
  } = options;
  const nativeOutputPresent = Object.hasOwn(options, "nativeStructuredOutput");
  const nativeErrorPresent = Object.hasOwn(options, "nativeStructuredOutputError");
  const nativeOutputValidShape = nativeStructuredOutput
    && typeof nativeStructuredOutput === "object"
    && !Array.isArray(nativeStructuredOutput);
  const nativeShapeIssues = [];
  if (nativeOutputPresent && nativeErrorPresent) {
    nativeShapeIssues.push("ACP returned both structured output and a structured-output error.");
  } else if (nativeErrorPresent) {
    nativeShapeIssues.push("Grok Build could not produce schema-valid structured output.");
  } else if (nativeOutputPresent && !nativeOutputValidShape) {
    nativeShapeIssues.push("ACP structured output must be a Worker Report object.");
  }
  const parsedReport = nativeOutputPresent && !nativeErrorPresent && nativeOutputValidShape
    ? {
        value: nativeStructuredOutput,
        markerPresent: true,
        source: "acp-structured"
      }
    : (!nativeOutputPresent && !nativeErrorPresent
        ? parseStructuredWorkerPayload(providerText)
        : null);
  const parsed = parsedReport?.value || null;
  const text = clip(String(providerText || "").trim());
  const allowedFields = new Set(WORKER_REPORT_ALLOWED_FIELDS);
  const shapeIssues = [];
  if (parsed) {
    for (const field of WORKER_REPORT_REQUIRED_FIELDS) if (!Object.hasOwn(parsed, field)) shapeIssues.push(`Structured worker report omitted ${field}.`);
    for (const field of Object.keys(parsed)) if (!allowedFields.has(field)) shapeIssues.push(`Structured worker report included unsupported field ${field}.`);
    if (typeof parsed.summary !== "string" || !parsed.summary.trim()) shapeIssues.push("Structured worker report summary must be a non-empty string.");
    for (const field of ["changedFiles", "checksClaimed", "acceptanceResults", "risks", "questions"]) {
      if (!Array.isArray(parsed[field])) shapeIssues.push(`Structured worker report ${field} must be an array.`);
    }
  }
  const resolvedSummary = clip(
    summary
      || (typeof parsed?.summary === "string" ? parsed.summary : null)
      || text.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
      || "Completed"
  , 2000);
  const normalizedPaths = normalizeClaimedPaths(changedFiles ?? parsed?.changedFiles);
  const files = normalizedPaths.paths;
  const checks = asStringList(checksClaimed ?? parsed?.checksClaimed);
  const risksList = asStringList(risks ?? parsed?.risks);
  const questionsList = asStringList(questions ?? parsed?.questions);
  const criteria = Array.isArray(acceptanceCriteria) ? acceptanceCriteria : [];
  const normalizedAcceptance = normalizeAcceptanceResults(acceptanceResults ?? parsed?.acceptanceResults, criteria);
  const hostActionPresent = hostActionRequest !== undefined
    || Boolean(parsed && Object.hasOwn(parsed, "hostActionRequest"));
  const normalizedHostAction = validateProviderHostActionRequest(
    hostActionRequest !== undefined ? hostActionRequest : parsed?.hostActionRequest,
    { present: hostActionPresent }
  );
  const requestedOutcome = ["complete", "partial", "blocked"].includes(outcome)
    ? outcome
    : ["complete", "partial", "blocked"].includes(parsed?.outcome)
      ? parsed.outcome
      : null;
  const validationIssues = [
    ...nativeShapeIssues,
    ...shapeIssues,
    ...normalizedPaths.issues,
    ...normalizedAcceptance.issues,
    ...normalizedHostAction.issues
  ];
  if (parsed && !requestedOutcome) validationIssues.push("Structured worker report omitted a valid outcome.");
  if (!parsed && !nativeOutputPresent && !nativeErrorPresent) {
    validationIssues.push("Provider did not return a GROK_WORKER_REPORT JSON object.");
  } else if (parsed && parsedReport.source !== "acp-structured" && !parsedReport.markerPresent) {
    validationIssues.push("Provider returned JSON without the required GROK_WORKER_REPORT marker.");
  }
  const resolvedOutcome = requestedOutcome || "partial";
  const reportSource = parsedReport?.source === "acp-structured"
    ? "acp-structured"
    : nativeErrorPresent
      ? "acp-structured-error"
      : parsedReport?.markerPresent
        ? "text-marker"
        : "text-unmarked";
  const report = {
    schemaVersion: WORKER_REPORT_VERSION,
    structured: parsedReport?.source === "acp-structured"
      || Boolean(parsedReport?.markerPresent),
    valid: (
      parsedReport?.source === "acp-structured"
      || Boolean(parsedReport?.markerPresent)
    ) && validationIssues.length === 0,
    outcome: resolvedOutcome,
    summary: resolvedSummary,
    changedFiles: files,
    checksClaimed: checks,
    acceptanceResults: normalizedAcceptance.results,
    risks: risksList,
    questions: questionsList,
    ...(hostActionPresent && normalizedHostAction.ok
      ? { hostActionRequest: normalizedHostAction.value }
      : {}),
    validationIssues,
    reportSource,
    reportDigest: null
  };
  if (report.valid) {
    report.reportDigest = sha(canonicalJson({
      schemaVersion: report.schemaVersion,
      outcome: report.outcome,
      summary: report.summary,
      changedFiles: report.changedFiles,
      checksClaimed: report.checksClaimed,
      acceptanceResults: report.acceptanceResults,
      risks: report.risks,
      questions: report.questions,
      ...(Object.hasOwn(report, "hostActionRequest")
        ? { hostActionRequest: report.hostActionRequest }
        : {})
    }));
  }
  return report;
}

/** Build one same-session, no-tool-use repair turn for a malformed final worker report. */
export function composeWorkerReportRepairPrompt(envelope, report) {
  const criteria = Array.isArray(envelope?.acceptanceCriteria) ? envelope.acceptanceCriteria : [];
  const acceptanceTemplate = criteria.map((criterion) => ({
    id: criterion.id,
    status: "unknown",
    note: "short evidence"
  }));
  const template = {
    outcome: "partial",
    summary: "concise factual summary",
    changedFiles: ["repository/relative/path"],
    checksClaimed: ["only checks actually run with available tools"],
    acceptanceResults: acceptanceTemplate,
    risks: ["remaining risk"],
    questions: ["blocking question"],
    hostActionRequest: null
  };
  const issues = asStringList(report?.validationIssues, { max: 20 });
  return [
    "Report-format repair only. The task turn already ran.",
    "Do not call tools, inspect files, modify the workspace, or repeat implementation.",
    `The previous report was invalid: ${issues.join("; ") || "required report marker/schema missing"}.`,
    "Return exactly one line. It must begin with GROK_WORKER_REPORT: followed immediately by one JSON object.",
    "Use exactly the eight keys shown below, no Markdown fence, no prose before or after, and exactly one acceptance result for every supplied ID. Choose outcome from complete, partial, or blocked; choose each status from met, unmet, or unknown. hostActionRequest must be null unless the worker is requesting one future read-only role admission.",
    `GROK_WORKER_REPORT: ${JSON.stringify(template)}`
  ].join("\n");
}

function normalizeClaimedPaths(items) {
  if (!Array.isArray(items)) return { paths: [], issues: [] };
  const paths = [];
  const issues = [];
  for (const item of items.slice(0, 200)) {
    const value = clip(String(item ?? "").trim(), 1024).replace(/\\/g, "/");
    if (!value || path.posix.isAbsolute(value) || /^[A-Za-z]:\//.test(value) || value.split("/").includes("..")) {
      issues.push(`Worker reported an invalid repository path: ${value || "(empty)"}.`);
      continue;
    }
    paths.push(value.replace(/^\.\//, ""));
  }
  return { paths: [...new Set(paths)], issues };
}

function normalizeAcceptanceResults(items, criteria) {
  const declared = Array.isArray(criteria) ? criteria.slice(0, MAX_LIST) : [];
  const provided = Array.isArray(items) ? items.slice(0, MAX_LIST) : [];
  const issues = [];
  if (!declared.length) {
    const results = provided.map((item, index) => {
      const value = typeof item === "string" ? { note: item } : item || {};
      return {
        id: stableAcceptanceId(index, value.id),
        status: ["met", "unmet", "unknown"].includes(value.status) ? value.status : "unknown",
        ...(value.note != null ? { note: clip(String(value.note), MAX_ITEM) } : {})
      };
    });
    return { results, issues };
  }
  const allowed = new Set(declared.map((item) => item.id));
  const byId = new Map();
  provided.forEach((item, index) => {
    const value = typeof item === "string" ? { note: item } : item || {};
    const id = String(value.id || declared[index]?.id || "");
    if (!allowed.has(id)) {
      issues.push(`Unknown acceptance criterion ${id || `(index ${index})`}.`);
      return;
    }
    if (byId.has(id)) {
      issues.push(`Duplicate acceptance result ${id}.`);
      return;
    }
    const status = ["met", "unmet", "unknown"].includes(value.status) ? value.status : "unknown";
    if (status === "unknown" && value.status !== "unknown") issues.push(`Acceptance result ${id} has invalid status ${String(value.status ?? "(missing)")}.`);
    byId.set(id, {
      id,
      status,
      ...(value.note != null ? { note: clip(String(value.note), MAX_ITEM) } : {})
    });
  });
  const results = declared.map((criterion) => {
    if (byId.has(criterion.id)) return byId.get(criterion.id);
    issues.push(`Missing acceptance result ${criterion.id}.`);
    return { id: criterion.id, status: "unknown", note: "Provider did not report this criterion." };
  });
  return { results, issues };
}

function parseStructuredWorkerPayload(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  const tryParse = (raw) => {
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
      }
    } catch {}
    return null;
  };
  const marker = trimmed.lastIndexOf("GROK_WORKER_REPORT:");
  if (marker >= 0) {
    const marked = extractFirstJsonObject(trimmed.slice(marker + "GROK_WORKER_REPORT:".length));
    const parsed = marked ? tryParse(marked) : null;
    if (parsed) return { value: parsed, markerPresent: true };
  }
  const direct = tryParse(trimmed);
  if (direct) return { value: direct, markerPresent: false };
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const nested = tryParse(fenced[1].trim());
    if (nested) return { value: nested, markerPresent: false };
  }
  let candidate = null;
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] !== "{") continue;
    const extracted = extractFirstJsonObject(trimmed.slice(index));
    const parsed = extracted ? tryParse(extracted) : null;
    if (parsed) candidate = parsed;
  }
  if (candidate) return { value: candidate, markerPresent: false };
  return null;
}

function extractFirstJsonObject(text) {
  const source = String(text || "");
  const start = source.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  return null;
}

/**
 * Observe runtime evidence independent of provider claims.
 * hostVerification is always not_run from the Grok runtime.
 */
function projectRuntimeContextIdentity(context) {
  if (!context) return null;
  const identity = {
    manifestId: context.manifestId || null,
    digest: context.digest || null,
    head: context.git?.head || null,
    branch: context.git?.branch || null,
    dirtyDigest: context.git?.dirtyDigest || null,
    ignoredDigest: context.git?.ignoredDigest || null,
    trackedTreeIdentity: context.git?.trackedTreeIdentity || null,
    metadataIdentity: context.git?.metadataIdentity || null
  };
  if (isSha256Hex(context.git?.taskRelevantMetadataIdentity)) {
    identity.taskRelevantMetadataIdentity = context.git.taskRelevantMetadataIdentity;
  }
  if (inspectTaskRelevantMetadataSupport(context.git) === "valid") {
    identity.sharedRefIdentity = {
      schemaVersion: context.git.sharedRefIdentity.schemaVersion,
      complete: context.git.sharedRefIdentity.complete,
      refCount: context.git.sharedRefIdentity.refCount,
      taskRelevantRefCount: context.git.sharedRefIdentity.taskRelevantRefCount,
      unrelatedRefCount: context.git.sharedRefIdentity.unrelatedRefCount,
      taskRelevantRefIdentity: context.git.sharedRefIdentity.taskRelevantRefIdentity,
      unrelatedRefIdentity: context.git.sharedRefIdentity.unrelatedRefIdentity
    };
  }
  return identity;
}

export function buildRuntimeEvidence({
  preContext = null,
  postContext = null,
  changedPaths = null,
  diffSummary = null,
  commandOutcomes = null,
  scopeViolations = null,
  executionStatus = "completed"
} = {}) {
  const sharedRefObservation = preContext?.git && postContext?.git
    ? classifyContextGitMetadataObservation(preContext, postContext)
    : null;
  return {
    schemaVersion: 1,
    preContext: projectRuntimeContextIdentity(preContext),
    postContext: projectRuntimeContextIdentity(postContext),
    observedChangedPaths: boundPathEvidence(changedPaths),
    diffSummary: diffSummary ? clip(String(diffSummary), 4000) : null,
    commandOutcomes: Array.isArray(commandOutcomes)
      ? commandOutcomes.slice(0, 40).map((item) => ({
          command: clip(String(item?.command || "command"), 200),
          status: clip(String(item?.status || "unknown"), 64),
          exitCode: Number.isInteger(item?.exitCode) ? item.exitCode : null
        }))
      : [],
    scopeViolations: boundPathEvidence(scopeViolations, { marker: "[SCOPE_VIOLATIONS_OVERFLOW]" }),
    executionStatus: clip(String(executionStatus || "completed"), 64),
    hostVerification: "not_run",
    // Bounded public-safe classification distinguishing tolerated unrelated
    // shared-ref churn from task-relevant Git metadata/ref drift (issue #34).
    ...(sharedRefObservation ? { sharedRefObservation } : {})
  };
}

export function evaluateScope(paths, scope = null) {
  const include = asStringList(scope?.include, { max: 64 }).map((item) => item.replace(/\\/g, "/"));
  const exclude = asStringList(scope?.exclude, { max: 64 }).map((item) => item.replace(/\\/g, "/"));
  const matches = (relativePath, pattern) => globToRegExp(pattern).test(relativePath);
  return [...new Set(Array.isArray(paths) ? paths : [])].filter((rawPath) => {
    const relativePath = String(rawPath || "").replace(/\\/g, "/").replace(/^\.\//, "");
    if (!relativePath || relativePath.startsWith("[")) return true;
    const included = include.length === 0 || include.some((pattern) => matches(relativePath, pattern));
    const excluded = exclude.some((pattern) => matches(relativePath, pattern));
    return !included || excluded;
  });
}

function globToRegExp(pattern) {
  const source = String(pattern || "").replace(/^\.\//, "");
  let expression = "^";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "*" && source[index + 1] === "*") {
      if (source[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${expression}$`);
}

/**
 * Observe path-level drift between two ContextManifests.
 *
 * observer:
 * - "full" (default): compare the complete ignored-worktree identity. Used for
 *   task completion scope checks and ordinary resume compatibility.
 * - "verification": compare the verification-only ignored identity that excludes
 *   exact `.pytest_cache` / `__pycache__` path components. Used only by
 *   record-verification. Older manifests without verification fields fall back
 *   fail-closed to the full ignored comparison.
 */
export function observeChangedPaths(preContext, postContext, { observer = "full" } = {}) {
  if (!preContext?.git || !postContext?.git) return [];
  const fingerprint = (entry) => canonicalJson({
    status: entry?.status || null,
    path: entry?.path || null,
    sourcePath: entry?.sourcePath || null,
    fileKind: entry?.fileKind || null,
    fileMode: entry?.fileMode ?? null,
    worktreeHash: entry?.worktreeHash || null
  });
  const toMap = (manifest) => {
    if (Array.isArray(manifest.git?.dirtyEntries)) {
      return new Map(manifest.git.dirtyEntries.map((entry) => [entry.path, fingerprint(entry)]));
    }
    return new Map((manifest.git?.dirtyPaths || []).map((entry) => [entry, entry]));
  };
  const before = toMap(preContext);
  const after = toMap(postContext);
  const changed = new Set();
  for (const [relativePath, value] of after) if (before.get(relativePath) !== value) changed.add(relativePath);
  for (const [relativePath, value] of before) if (after.get(relativePath) !== value) changed.add(relativePath);
  for (const entry of [...(preContext.git.dirtyEntries || []), ...(postContext.git.dirtyEntries || [])]) {
    if (entry?.sourcePath && changed.has(entry.path)) changed.add(entry.sourcePath);
  }
  if ((preContext.git.dirtyDigest || null) !== (postContext.git.dirtyDigest || null)
    && (changed.size === 0 || preContext.git.dirtyEntriesTruncated || postContext.git.dirtyEntriesTruncated)) {
    changed.add("[DIRTY_OVERFLOW]");
  }
  observeIgnoredDrift(preContext.git, postContext.git, changed, { observer });
  if ((preContext.git.head || null) !== (postContext.git.head || null)) changed.add("[HEAD]");
  if ((preContext.git.trackedTreeIdentity || null) !== (postContext.git.trackedTreeIdentity || null)) changed.add("[INDEX]");
  observeContextGitMetadataDrift(preContext, postContext, changed);
  // Keep the complete internally attributable set for scope evaluation. Public/runtime
  // projections apply boundPathEvidence separately and expose an explicit overflow marker.
  return [...changed];
}

function observeFullIgnoredDrift(preGit, postGit, changed) {
  if ((preGit.ignoredDigest || null) !== (postGit.ignoredDigest || null)) {
    if (preGit.ignoredEntriesAttributable && postGit.ignoredEntriesAttributable) {
      const beforeIgnored = new Map((preGit.ignoredEntries || []).map((entry) => [entry.path, entry.fingerprint]));
      const afterIgnored = new Map((postGit.ignoredEntries || []).map((entry) => [entry.path, entry.fingerprint]));
      for (const [relativePath, value] of afterIgnored) if (beforeIgnored.get(relativePath) !== value) changed.add(relativePath);
      for (const [relativePath, value] of beforeIgnored) if (afterIgnored.get(relativePath) !== value) changed.add(relativePath);
    } else {
      changed.add("[IGNORED_WORKTREE]");
    }
  }
}

function hasVerificationIgnoredIdentity(gitManifest) {
  if (!gitManifest || typeof gitManifest !== "object") return false;
  const digest = gitManifest.verificationIgnoredDigest;
  const entries = gitManifest.verificationIgnoredEntries;
  const count = gitManifest.verificationIgnoredEntryCount;
  const attributable = gitManifest.verificationIgnoredEntriesAttributable;
  const complete = gitManifest.verificationIgnoredInventoryComplete;
  if (typeof digest !== "string"
    || !/^[a-f0-9]{64}$/.test(digest)
    || !Number.isInteger(count)
    || count < 0
    || !Array.isArray(entries)
    || typeof attributable !== "boolean"
    || typeof complete !== "boolean") return false;
  // A captured inventory is complete exactly while it remains within the path
  // budget, and it is attributable exactly while the complete inventory also
  // remains within the per-path evidence budget. Reject impossible combinations
  // rather than trusting an equal but malformed verification digest.
  if (complete !== (count <= MAX_IGNORED_PATHS)) return false;
  if (attributable !== (complete && count <= MAX_IGNORED_ATTRIBUTABLE)) return false;
  if (entries.length !== (attributable ? count : 0)) return false;
  const paths = new Set();
  for (const entry of entries) {
    if (typeof entry?.path !== "string"
      || !entry.path
      || typeof entry?.fingerprint !== "string"
      || !entry.fingerprint
      || isVerificationCacheIgnoredPath(entry.path)
      || paths.has(entry.path)) return false;
    paths.add(entry.path);
  }
  return true;
}

function observeIgnoredDrift(preGit, postGit, changed, { observer }) {
  if (observer === "verification") {
    // Fail closed: missing or malformed verification identity on either side
    // reverts to the complete ignored-worktree comparison.
    if (!hasVerificationIgnoredIdentity(preGit) || !hasVerificationIgnoredIdentity(postGit)) {
      observeFullIgnoredDrift(preGit, postGit, changed);
      return;
    }
    const preDigest = preGit.verificationIgnoredDigest;
    const postDigest = postGit.verificationIgnoredDigest;
    if (preDigest !== postDigest) {
      if (preGit.verificationIgnoredEntriesAttributable && postGit.verificationIgnoredEntriesAttributable) {
        const beforeIgnored = new Map((preGit.verificationIgnoredEntries || []).map((entry) => [entry.path, entry.fingerprint]));
        const afterIgnored = new Map((postGit.verificationIgnoredEntries || []).map((entry) => [entry.path, entry.fingerprint]));
        for (const [relativePath, value] of afterIgnored) if (beforeIgnored.get(relativePath) !== value) changed.add(relativePath);
        for (const [relativePath, value] of beforeIgnored) if (afterIgnored.get(relativePath) !== value) changed.add(relativePath);
      } else {
        changed.add("[IGNORED_WORKTREE]");
      }
    }
    return;
  }
  observeFullIgnoredDrift(preGit, postGit, changed);
}

/**
 * Compose the provider prompt from a TaskEnvelope without putting envelope JSON on argv.
 */
export function composeProviderPrompt(envelope, {
  root,
  constraints = null,
  contextManifest = null,
  contextPacket = null,
  runtimeRolePolicy = null
} = {}) {
  if (contextPacket !== null || runtimeRolePolicy !== null) {
    if (constraints !== null || contextPacket === null || runtimeRolePolicy === null) {
      throw new CompanionError(
        "E_STATE",
        "Receipt-backed provider prompt requires one packet/policy pair and no prompt override."
      );
    }
    return composeEffectiveProviderPrompt({
      envelope,
      contextPacket,
      rolePolicy: runtimeRolePolicy,
      contextManifest,
      root
    });
  }
  const context = envelope.context || { facts: [], constraints: [], expectedProjectMarkers: [], requiredPaths: [], workspaceState: "unknown", upstreamFreshness: "not_checked" };
  const facts = Array.isArray(context.facts) ? context.facts : [];
  const hostConstraints = Array.isArray(context.constraints) ? context.constraints : [];
  const manifestSummary = contextManifest
    ? [
        `workspace=${contextManifest.workspaceRoot}`,
        `branch=${contextManifest.git?.branch || "detached/unknown"}`,
        `head=${contextManifest.git?.head || "unknown"}`,
        `dirtyPaths=${contextManifest.git?.dirtyPaths?.length || 0}`,
        `sparse=${Boolean(contextManifest.git?.sparse)}`,
        `shallow=${Boolean(contextManifest.git?.shallow)}`,
        `materialization=${contextManifest.materialization?.state || "unknown"}`,
        `projectMarkers=${contextManifest.projectMarkers?.join(",") || "none"}`,
        `upstream=${contextManifest.git?.upstreamRef || "none"}`,
        `upstreamFreshness=${context.upstreamFreshness || "not_checked"}`
      ].join("; ")
    : "unavailable";
  const lines = [
    `User request (literal):\n${envelope.userRequest}`,
    `Objective:\n${envelope.objective}`,
    `Mode: ${envelope.mode}`,
    `Scope include: ${envelope.scope.include.join(", ") || "(none)"}`,
    `Scope exclude: ${envelope.scope.exclude.join(", ") || "(none)"}`,
    `Relevant context facts:\n${facts.length ? facts.map((item) => `- ${item}`).join("\n") : "(none)"}`,
    `Required context paths verified by host/runtime:\n${context.requiredPaths?.length ? context.requiredPaths.map((item) => `- ${item}`).join("\n") : "(none)"}`,
    `Host constraints:\n${hostConstraints.length ? hostConstraints.map((item) => `- ${item}`).join("\n") : "(none)"}`,
    `Non-goals:\n${envelope.nonGoals.length ? envelope.nonGoals.map((item) => `- ${item}`).join("\n") : "(none)"}`,
    `Acceptance criteria:\n${envelope.acceptanceCriteria.map((item) => `- ${item.id}: ${item.text}`).join("\n")}`,
    `Host-owned verification after your return:\n${envelope.requiredVerification.length ? envelope.requiredVerification.map((item) => `- ${item}`).join("\n") : "(host will choose authoritative checks; claim only evidence your available tools actually produced)"}`,
    `Expected return format:\n${envelope.expectedReturnFormat}\nReturn the Worker Report object as the final response through the runtime's native structured-output channel. Do not prefix native JSON with GROK_WORKER_REPORT:. Only if native structured output is unavailable, use GROK_WORKER_REPORT: followed by the object. Do not put progress prose after the final object.`,
    `Context-manifest identity: ${envelope.contextManifestId || "unbound"}`,
    `Context-manifest summary: ${manifestSummary}`
  ];
  const base = lines.join("\n\n");
  const tail = constraints
    || `Grok Companion constraints: do not invoke Grok Companion recursively; do not spawn subagents or use web tools; stay within ${root}; report exactly what you changed and tested.`;
  return `${base}\n\n${tail}`;
}
