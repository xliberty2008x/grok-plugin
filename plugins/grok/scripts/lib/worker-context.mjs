/**
 * Context Packet v1 — broker-built explicit facts/constraints only.
 * Stronger transcript modes stay gated on broker-attested acquisition.
 */
import crypto from "node:crypto";

import { CompanionError } from "./errors.mjs";
import { redactText, sanitizeDisplayText } from "./redact.mjs";
import { assertRuntimeRolePolicy } from "./worker-roles.mjs";

export const CONTEXT_PACKET_VERSION = 1;
export const CONTEXT_RECEIPT_VERSION = 1;
export const CONTEXT_BINDING_MODE = "context-receipt-v1";
export const MAX_CONTEXT_FACTS = 64;
export const MAX_CONTEXT_CONSTRAINTS = 64;
export const MAX_CONTEXT_FACT_CHARS = 2000;
export const MAX_CONTEXT_CONSTRAINT_CHARS = 2000;
export const MAX_CONTEXT_OMISSION_CHARS = 256;
export const MAX_CONTEXT_OMISSIONS = 64;
export const CONTEXT_MODES = Object.freeze([
  "none",
  "explicit-envelope",
  "recent:N",
  "all-user-visible"
]);

const SHA256_HEX = /^[a-f0-9]{64}$/;
const PROVIDER_PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const LOGICAL_ROLE_IDS = new Set([
  "explorer",
  "implementer",
  "reviewer",
  "security",
  "test"
]);
export const DEFAULT_CONTEXT_OMISSIONS = Object.freeze([
  "hidden-system-instructions",
  "developer-instructions",
  "raw-transcripts",
  "credentials",
  "provider-session-ids",
  "user-request-body",
  "default-objective-duplication",
  "secret-bearing-material",
  "tool-records"
]);
export const CONTEXT_OMISSION_CODES = Object.freeze([
  "all-context-omitted",
  ...DEFAULT_CONTEXT_OMISSIONS
]);
const CONTEXT_OMISSION_CODE_SET = new Set(CONTEXT_OMISSION_CODES);
const CONTEXT_PACKET_KEYS = new Set([
  "schemaVersion",
  "mode",
  "packetId",
  "provenance",
  "facts",
  "constraints",
  "omissions",
  "bounds",
  "truncated",
  "hiddenRecordsExported",
  "digest"
]);
const CONTEXT_PROVENANCE_NONE_KEYS = new Set(["source", "precedence"]);
const CONTEXT_PROVENANCE_EXPLICIT_KEYS = new Set([
  "source",
  "precedence",
  "envelopeId",
  "envelopeDigest"
]);
const CONTEXT_BOUNDS_KEYS = new Set([
  "maxFacts",
  "maxFactChars",
  "maxConstraints",
  "maxConstraintChars",
  "effectiveMaxFacts",
  "effectiveMaxConstraints"
]);
const CONTEXT_RECEIPT_KEYS = new Set([
  "schemaVersion",
  "packetId",
  "packetDigest",
  "mode",
  "provenance",
  "factCount",
  "factsDigest",
  "constraintCount",
  "constraintsDigest",
  "omissions",
  "bounds",
  "truncated",
  "hiddenRecordsExported",
  "rolePolicyDigest",
  "logicalRoleId",
  "roleDigest",
  "providerProfileId",
  "providerProfileVersion",
  "agentProfileDigest",
  "allowedProviderToolIdsDigest",
  "deniedProviderToolIdsDigest",
  "lineageWorkerId",
  "contextManifestId",
  "contextManifestDigest",
  "effectivePromptDigest",
  "receiptDigest"
]);
const ENVELOPE_ID = /^env-[a-f0-9]{24}$/;
const PACKET_ID = /^ctxpkt-[a-f0-9]{24}$/;

/**
 * Trusted privacy-filtered transcript acquisition is not broker-attested yet.
 * Do not accept caller-provided booleans as proof: any plugin caller could forge
 * them. A future implementation must replace this with a capability created and
 * verified by the broker boundary, not widen this public helper.
 */
export function transcriptAcquisitionCapability(_claim = {}) {
  return Object.freeze({
    proven: false,
    privacyFiltered: false,
    recentNEnabled: false,
    allUserVisibleEnabled: false,
    note: "Only none and explicit-envelope are safe; broker-bound transcript attestation is unavailable."
  });
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function digest(value) {
  return crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : stableStringify(value))
    .digest("hex");
}

function exactKeys(value, keys) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key))
  );
}

export function unicodeScalarCount(text) {
  if (typeof text !== "string") {
    throw new CompanionError("E_USAGE", "Unicode scalar input must be a string.");
  }
  return Array.from(text).length;
}

/**
 * Reject lone UTF-16 surrogates so bounds are measured in Unicode scalars.
 * Well-formed surrogate pairs are accepted and counted as one scalar.
 */
export function assertValidUnicodeScalars(text, name = "text") {
  if (typeof text !== "string") {
    throw new CompanionError("E_USAGE", `${name} must be a string.`);
  }
  const value = text;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) {
        throw new CompanionError("E_USAGE", `${name} contains a lone Unicode surrogate.`);
      }
      index += 1;
      continue;
    }
    if (code >= 0xDC00 && code <= 0xDFFF) {
      throw new CompanionError("E_USAGE", `${name} contains a lone Unicode surrogate.`);
    }
  }
  return value;
}

function normalizeBounds(bounds, mode) {
  if (mode === "none") {
    return Object.freeze({
      maxFacts: 0,
      maxFactChars: 0,
      maxConstraints: 0,
      maxConstraintChars: 0,
      effectiveMaxFacts: 0,
      effectiveMaxConstraints: 0
    });
  }
  const maxFacts = bounds?.maxFacts ?? MAX_CONTEXT_FACTS;
  const maxFactChars = bounds?.maxFactChars ?? MAX_CONTEXT_FACT_CHARS;
  const maxConstraints = bounds?.maxConstraints ?? MAX_CONTEXT_CONSTRAINTS;
  const maxConstraintChars = bounds?.maxConstraintChars ?? MAX_CONTEXT_CONSTRAINT_CHARS;
  if (!Number.isSafeInteger(maxFacts) || maxFacts < 1 || maxFacts > MAX_CONTEXT_FACTS) {
    throw new CompanionError("E_USAGE", `bounds.maxFacts must be an integer from 1 to ${MAX_CONTEXT_FACTS}.`);
  }
  if (!Number.isSafeInteger(maxFactChars) || maxFactChars < 1 || maxFactChars > MAX_CONTEXT_FACT_CHARS) {
    throw new CompanionError("E_USAGE", `bounds.maxFactChars must be an integer from 1 to ${MAX_CONTEXT_FACT_CHARS}.`);
  }
  if (!Number.isSafeInteger(maxConstraints) || maxConstraints < 1 || maxConstraints > MAX_CONTEXT_CONSTRAINTS) {
    throw new CompanionError(
      "E_USAGE",
      `bounds.maxConstraints must be an integer from 1 to ${MAX_CONTEXT_CONSTRAINTS}.`
    );
  }
  if (
    !Number.isSafeInteger(maxConstraintChars)
    || maxConstraintChars < 1
    || maxConstraintChars > MAX_CONTEXT_CONSTRAINT_CHARS
  ) {
    throw new CompanionError(
      "E_USAGE",
      `bounds.maxConstraintChars must be an integer from 1 to ${MAX_CONTEXT_CONSTRAINT_CHARS}.`
    );
  }
  return Object.freeze({ maxFacts, maxFactChars, maxConstraints, maxConstraintChars });
}

function assertContextMode(mode, _capability) {
  if (mode === "explicit-envelope") return null;
  if (mode === "all-user-visible") {
    throw new CompanionError(
      "E_CAPABILITY",
      "all-user-visible context requires broker-attested privacy-filtered transcript acquisition."
    );
  }
  const recent = /^recent:(\d+)$/.exec(mode);
  if (!recent) throw new CompanionError("E_USAGE", `Unsupported context mode ${mode}.`);
  const count = Number(recent[1]);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_CONTEXT_FACTS) {
    throw new CompanionError("E_USAGE", `recent:N requires N from 1 to ${MAX_CONTEXT_FACTS}.`);
  }
  throw new CompanionError(
    "E_CAPABILITY",
    "recent:N context requires broker-attested privacy-filtered transcript acquisition."
  );
}

function beginsAuthorityLabel(value) {
  return String(value || "").split(/\r?\n/u).some((line) => {
    const withoutListMarker = line
      .trimStart()
      .replace(/^(?:(?:[-+*#>]+|\d+[.)])\s*)+/u, "");
    const withoutDecoration = withoutListMarker
      .replace(/^[\p{P}\p{S}]+/u, "")
      .trimStart();
    return /^(?:system|developer)(?:$|[^\p{L}\p{N}])/iu.test(withoutDecoration);
  });
}

function looksHidden(text) {
  const value = String(text || "");
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || beginsAuthorityLabel(value)
    || /<\s*\/?\s*(?:system|developer)\s*>/i.test(value)
    || /\bhidden\s+(?:system|developer|instruction|reasoning|record)\b/i.test(value)
    || /(?:^|[\r\n])\s*(?:raw\s+transcript|tool[-_ ]?record)\s*:/i.test(value)
    || /\b(?:aws[\s_-]+)?(?:api[\s_-]*keys?|(?:secret(?:[\s_-]+access)?|private)[\s_-]+keys?|access[\s_-]+tokens?|passwords?)\s*[:=]\s*\S{8,}/i.test(value)
    || redactText(value) !== value
    || sanitizeDisplayText(value) !== value;
}

export function validateExplicitContextItems(items, {
  name,
  maxItems,
  maxChars
}) {
  if (items == null) return [];
  if (!Array.isArray(items)) {
    throw new CompanionError("E_USAGE", `${name} must be an array of strings.`);
  }
  if (items.length > maxItems) {
    throw new CompanionError(
      "E_USAGE",
      `${name} exceeds the maxItems bound of ${maxItems}; refusing silent truncation.`
    );
  }
  const normalized = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (typeof item !== "string") {
      throw new CompanionError("E_USAGE", `${name}[${index}] must be a string.`);
    }
    const raw = assertValidUnicodeScalars(item, `${name}[${index}]`);
    if (unicodeScalarCount(raw) > maxChars) {
      throw new CompanionError(
        "E_USAGE",
        `${name}[${index}] exceeds the ${maxChars}-scalar bound; refusing silent truncation.`
      );
    }
    if (sanitizeDisplayText(raw) !== raw) {
      throw new CompanionError(
        "E_POLICY",
        `${name}[${index}] contains control, bidi, secret, or unsafe display material.`
      );
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new CompanionError("E_USAGE", `${name}[${index}] must be a non-empty string.`);
    }
    if (raw !== trimmed) {
      throw new CompanionError(
        "E_USAGE",
        `${name}[${index}] has leading or trailing whitespace; refusing silent normalization.`
      );
    }
    if (looksHidden(raw)) {
      throw new CompanionError(
        "E_POLICY",
        `${name}[${index}] looks like secret, system, developer, or hidden authority material.`
      );
    }
    normalized.push(raw);
  }
  return normalized;
}

function normalizeOmissions(omissions) {
  if (omissions == null) return [];
  if (!Array.isArray(omissions)) {
    throw new CompanionError("E_USAGE", "omissions must be an array of strings.");
  }
  if (omissions.length > MAX_CONTEXT_OMISSIONS) {
    throw new CompanionError(
      "E_USAGE",
      `omissions exceeds the maxItems bound of ${MAX_CONTEXT_OMISSIONS}; refusing silent truncation.`
    );
  }
  const normalized = [];
  for (let index = 0; index < omissions.length; index += 1) {
    const item = omissions[index];
    if (typeof item !== "string") {
      throw new CompanionError("E_USAGE", `omissions[${index}] must be a string.`);
    }
    const raw = assertValidUnicodeScalars(item, `omissions[${index}]`);
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new CompanionError("E_USAGE", `omissions[${index}] must be non-empty.`);
    }
    if (unicodeScalarCount(trimmed) > MAX_CONTEXT_OMISSION_CHARS) {
      throw new CompanionError(
        "E_USAGE",
        `omissions[${index}] exceeds the ${MAX_CONTEXT_OMISSION_CHARS}-scalar bound.`
      );
    }
    if (!CONTEXT_OMISSION_CODE_SET.has(trimmed) || trimmed === "all-context-omitted") {
      throw new CompanionError("E_USAGE", `omissions[${index}] is not a supported omission code.`);
    }
    if (normalized.includes(trimmed)) {
      throw new CompanionError("E_USAGE", `omissions[${index}] duplicates an omission code.`);
    }
    normalized.push(trimmed);
  }
  return normalized;
}

/**
 * Build one canonical Context Packet from explicitly supplied facts/constraints only.
 * Never duplicates userRequest or a default objective, never silently truncates,
 * and never marks truncated=true on an admitted packet.
 */
export function buildContextPacket({
  mode = "explicit-envelope",
  envelope = null,
  facts = undefined,
  constraints = undefined,
  omissions = [],
  bounds = null,
  transcriptCapability = transcriptAcquisitionCapability()
} = {}) {
  const resolvedMode = String(mode || "explicit-envelope");
  if (resolvedMode === "none") {
    const safeBounds = normalizeBounds(bounds, resolvedMode);
    const core = {
      schemaVersion: CONTEXT_PACKET_VERSION,
      mode: "none",
      provenance: { source: "none", precedence: [] },
      facts: [],
      constraints: [],
      omissions: ["all-context-omitted"],
      bounds: safeBounds,
      truncated: false,
      hiddenRecordsExported: false
    };
    const packetId = `ctxpkt-${digest(core).slice(0, 24)}`;
    const packet = { ...core, packetId };
    packet.digest = digest(packet);
    return deepFreeze(packet);
  }

  assertContextMode(resolvedMode, transcriptCapability);
  const safeBounds = normalizeBounds(bounds, resolvedMode);

  // Explicit facts/constraints only. Never pull userRequest/objective into the packet.
  const explicitFacts = facts !== undefined
    ? facts
    : (Array.isArray(envelope?.context?.facts) ? envelope.context.facts : []);
  const explicitConstraints = constraints !== undefined
    ? constraints
    : (Array.isArray(envelope?.context?.constraints) ? envelope.context.constraints : []);

  const safeFacts = validateExplicitContextItems(explicitFacts, {
    name: "facts",
    maxItems: safeBounds.maxFacts,
    maxChars: safeBounds.maxFactChars
  });
  const safeConstraints = validateExplicitContextItems(explicitConstraints, {
    name: "constraints",
    maxItems: safeBounds.maxConstraints,
    maxChars: safeBounds.maxConstraintChars
  });
  const callerOmissions = normalizeOmissions(omissions);
  const safeOmissions = [...callerOmissions];
  for (const item of DEFAULT_CONTEXT_OMISSIONS) {
    if (!safeOmissions.includes(item)) safeOmissions.push(item);
  }
  const prohibitedDuplicates = new Set([
    envelope?.userRequest,
    envelope?.objective === envelope?.userRequest ? envelope?.objective : null
  ].filter((value) => typeof value === "string" && value));
  for (const [name, items] of [
    ["facts", safeFacts],
    ["constraints", safeConstraints]
  ]) {
    const duplicateIndex = items.findIndex((item) => prohibitedDuplicates.has(item));
    if (duplicateIndex >= 0) {
      throw new CompanionError(
        "E_POLICY",
        `${name}[${duplicateIndex}] duplicates the user request or its default objective.`
      );
    }
  }

  const core = {
    schemaVersion: CONTEXT_PACKET_VERSION,
    mode: "explicit-envelope",
    provenance: {
      source: "explicit-envelope",
      precedence: ["explicit-facts", "explicit-constraints"],
      envelopeId: envelope?.envelopeId || null,
      envelopeDigest: envelope?.digest || null
    },
    facts: safeFacts,
    constraints: safeConstraints,
    omissions: safeOmissions,
    bounds: Object.freeze({
      ...safeBounds,
      effectiveMaxFacts: safeBounds.maxFacts,
      effectiveMaxConstraints: safeBounds.maxConstraints
    }),
    truncated: false,
    hiddenRecordsExported: false
  };
  const packetId = `ctxpkt-${digest(core).slice(0, 24)}`;
  const packet = { ...core, packetId };
  packet.digest = digest(packet);
  return deepFreeze(packet);
}

export function assertNoHiddenExport(packet) {
  if (!packet || packet.hiddenRecordsExported) {
    throw new CompanionError("E_POLICY", "Context packet must not export hidden records.");
  }
  for (const fact of packet.facts || []) {
    if (looksHidden(fact)) {
      throw new CompanionError("E_POLICY", "Context fact looks like hidden or secret material.");
    }
  }
  for (const constraint of packet.constraints || []) {
    if (looksHidden(constraint)) {
      throw new CompanionError("E_POLICY", "Context constraint looks like hidden or secret material.");
    }
  }
  return true;
}

export function assertContextPacket(packet, { envelope = null } = {}) {
  if (!exactKeys(packet, CONTEXT_PACKET_KEYS)) {
    throw new CompanionError("E_SCHEMA", "Context packet is missing or malformed.");
  }
  if (packet.schemaVersion !== CONTEXT_PACKET_VERSION
    || !["none", "explicit-envelope"].includes(packet.mode)
    || !PACKET_ID.test(packet.packetId || "")
    || packet.truncated !== false
    || packet.hiddenRecordsExported !== false
    || !SHA256_HEX.test(packet.digest || "")
    || !Array.isArray(packet.facts)
    || !Array.isArray(packet.constraints)
    || !Array.isArray(packet.omissions)
    || !exactKeys(packet.bounds, CONTEXT_BOUNDS_KEYS)) {
    throw new CompanionError("E_SCHEMA", "Unsupported context packet schema version.");
  }
  const boundPairs = [
    ["maxFacts", MAX_CONTEXT_FACTS],
    ["maxFactChars", MAX_CONTEXT_FACT_CHARS],
    ["maxConstraints", MAX_CONTEXT_CONSTRAINTS],
    ["maxConstraintChars", MAX_CONTEXT_CONSTRAINT_CHARS]
  ];
  for (const [name, maximum] of boundPairs) {
    if (!Number.isSafeInteger(packet.bounds[name])
      || packet.bounds[name] < (packet.mode === "none" ? 0 : 1)
      || packet.bounds[name] > maximum) {
      throw new CompanionError("E_SCHEMA", `Context packet ${name} bound is malformed.`);
    }
  }
  if (!Number.isSafeInteger(packet.bounds.effectiveMaxFacts)
    || !Number.isSafeInteger(packet.bounds.effectiveMaxConstraints)
    || packet.bounds.effectiveMaxFacts !== packet.bounds.maxFacts
    || packet.bounds.effectiveMaxConstraints !== packet.bounds.maxConstraints) {
    throw new CompanionError("E_SCHEMA", "Context packet effective bounds are malformed.");
  }
  let normalizedFacts;
  let normalizedConstraints;
  try {
    normalizedFacts = validateExplicitContextItems(packet.facts, {
      name: "facts",
      maxItems: packet.bounds.maxFacts,
      maxChars: packet.bounds.maxFactChars
    });
    normalizedConstraints = validateExplicitContextItems(packet.constraints, {
      name: "constraints",
      maxItems: packet.bounds.maxConstraints,
      maxChars: packet.bounds.maxConstraintChars
    });
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    throw new CompanionError("E_SCHEMA", "Context packet body is malformed.");
  }
  if (stableStringify(normalizedFacts) !== stableStringify(packet.facts)
    || stableStringify(normalizedConstraints) !== stableStringify(packet.constraints)) {
    throw new CompanionError("E_SCHEMA", "Context packet body is not canonical.");
  }
  if (packet.mode === "none") {
    if (!exactKeys(packet.provenance, CONTEXT_PROVENANCE_NONE_KEYS)
      || packet.provenance.source !== "none"
      || !Array.isArray(packet.provenance.precedence)
      || packet.provenance.precedence.length !== 0
      || packet.facts.length !== 0
      || packet.constraints.length !== 0
      || stableStringify(packet.omissions) !== stableStringify(["all-context-omitted"])
      || Object.values(packet.bounds).some((value) => value !== 0)) {
      throw new CompanionError("E_SCHEMA", "None-mode context packet is malformed.");
    }
  } else {
    if (!exactKeys(packet.provenance, CONTEXT_PROVENANCE_EXPLICIT_KEYS)
      || packet.provenance.source !== "explicit-envelope"
      || stableStringify(packet.provenance.precedence)
        !== stableStringify(["explicit-facts", "explicit-constraints"])
      || (packet.provenance.envelopeId !== null
        && !ENVELOPE_ID.test(packet.provenance.envelopeId || ""))
      || (packet.provenance.envelopeDigest !== null
        && !SHA256_HEX.test(packet.provenance.envelopeDigest || ""))
      || packet.omissions.length > MAX_CONTEXT_OMISSIONS
      || new Set(packet.omissions).size !== packet.omissions.length
      || packet.omissions.some((item) => (
        typeof item !== "string"
        || !CONTEXT_OMISSION_CODE_SET.has(item)
        || item === "all-context-omitted"
      ))
      || DEFAULT_CONTEXT_OMISSIONS.some((item) => !packet.omissions.includes(item))) {
      throw new CompanionError("E_SCHEMA", "Explicit context packet provenance or omissions are malformed.");
    }
  }
  assertNoHiddenExport(packet);
  const core = {
    schemaVersion: packet.schemaVersion,
    mode: packet.mode,
    provenance: packet.provenance,
    facts: packet.facts,
    constraints: packet.constraints,
    omissions: packet.omissions,
    bounds: packet.bounds,
    truncated: packet.truncated,
    hiddenRecordsExported: packet.hiddenRecordsExported
  };
  const expectedPacketId = `ctxpkt-${digest(core).slice(0, 24)}`;
  const expectedDigest = digest({ ...core, packetId: expectedPacketId });
  if (packet.packetId !== expectedPacketId || packet.digest !== expectedDigest) {
    throw new CompanionError("E_AUTH_REQUIRED", "Context packet digest mismatch.");
  }
  if (envelope) {
    const expectedFacts = envelope?.context?.facts;
    const expectedConstraints = envelope?.context?.constraints;
    if (packet.mode !== "explicit-envelope"
      || packet.provenance.envelopeId !== envelope.envelopeId
      || packet.provenance.envelopeDigest !== envelope.digest
      || stableStringify(packet.facts) !== stableStringify(expectedFacts)
      || stableStringify(packet.constraints) !== stableStringify(expectedConstraints)) {
      throw new CompanionError("E_AUTH_REQUIRED", "Context packet does not match its TaskEnvelope.");
    }
    const prohibited = new Set([
      envelope.userRequest,
      envelope.objective === envelope.userRequest ? envelope.objective : null
    ].filter((value) => typeof value === "string" && value));
    if ([...packet.facts, ...packet.constraints].some((item) => prohibited.has(item))) {
      throw new CompanionError("E_POLICY", "Context packet duplicates the task request body.");
    }
  }
  return packet;
}

/**
 * Reconstruct the exact effective provider prompt from a persisted packet and
 * immutable role policy. Receipt-backed jobs never fall back to envelope facts.
 */
export function composeEffectiveProviderPrompt({
  envelope,
  contextPacket,
  rolePolicy,
  contextManifest = null,
  root
} = {}) {
  if (!envelope || typeof envelope !== "object") {
    throw new CompanionError("E_STATE", "Effective provider prompt requires a TaskEnvelope.");
  }
  if (typeof envelope.userRequest !== "string" || !envelope.userRequest) {
    throw new CompanionError(
      "E_STATE",
      "Effective provider prompt requires literal TaskEnvelope userRequest text."
    );
  }
  const packet = assertContextPacket(contextPacket, { envelope });
  const policy = assertRuntimeRolePolicy(rolePolicy);
  const facts = packet.facts;
  const hostConstraints = packet.constraints;
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
      `upstreamFreshness=${envelope.context?.upstreamFreshness || "not_checked"}`
    ].join("; ")
    : "unavailable";
  const allowedTools = Array.isArray(policy.allowedProviderToolIds)
    ? policy.allowedProviderToolIds.join(", ")
    : "";
  const deniedTools = Array.isArray(policy.deniedProviderToolIds)
    ? policy.deniedProviderToolIds.join(", ")
    : "";
  const lines = [
    `User request (literal):\n${envelope.userRequest}`,
    ...(envelope.objective !== envelope.userRequest
      ? [`Objective:\n${envelope.objective}`]
      : []),
    `Mode: ${envelope.mode}`,
    `Scope include: ${envelope.scope?.include?.join(", ") || "(none)"}`,
    `Scope exclude: ${envelope.scope?.exclude?.join(", ") || "(none)"}`,
    `Relevant context facts:\n${facts.length ? facts.map((item) => `- ${item}`).join("\n") : "(none)"}`,
    `Required context paths verified by host/runtime:\n${
      envelope.context?.requiredPaths?.length
        ? envelope.context.requiredPaths.map((item) => `- ${item}`).join("\n")
        : "(none)"
    }`,
    `Host constraints:\n${
      hostConstraints.length
        ? hostConstraints.map((item) => `- ${item}`).join("\n")
        : "(none)"
    }`,
    `Non-goals:\n${
      envelope.nonGoals?.length
        ? envelope.nonGoals.map((item) => `- ${item}`).join("\n")
        : "(none)"
    }`,
    `Acceptance criteria:\n${
      Array.isArray(envelope.acceptanceCriteria)
        ? envelope.acceptanceCriteria.map((item) => `- ${item.id}: ${item.text}`).join("\n")
        : "(none)"
    }`,
    `Host-owned verification after your return:\n${
      envelope.requiredVerification?.length
        ? envelope.requiredVerification.map((item) => `- ${item}`).join("\n")
        : "(host will choose authoritative checks; claim only evidence your available tools actually produced)"
    }`,
    `Expected return format:\n${envelope.expectedReturnFormat}\nThe GROK_WORKER_REPORT object must be the final content in your response. Do not put progress prose after it.`,
    `Context-manifest identity: ${envelope.contextManifestId || "unbound"}`,
    `Context-manifest summary: ${manifestSummary}`,
    [
      "Runtime role policy:",
      `- logicalRoleId: ${policy.logicalRoleId}`,
      `- roleDigest: ${policy.roleDigest}`,
      `- providerProfileId: ${policy.providerProfileId}`,
      `- providerProfileVersion: ${policy.providerProfileVersion}`,
      `- agentProfileDigest: ${policy.agentProfileDigest}`,
      `- allowedProviderToolIds: ${allowedTools || "(none)"}`,
      `- deniedProviderToolIds: ${deniedTools || "(none)"}`,
      `- policyDigest: ${policy.digest}`
    ].join("\n")
  ];
  const base = lines.join("\n\n");
  const tail = `Grok Companion constraints: do not invoke Grok Companion recursively; do not spawn subagents or use web tools; stay within ${root}; report exactly what you changed and tested.`;
  return `${base}\n\n${tail}`;
}

export function effectivePromptDigest(prompt) {
  if (typeof prompt !== "string" || !prompt) {
    throw new CompanionError("E_STATE", "Effective provider prompt text is required.");
  }
  return digest(prompt);
}

/**
 * Body-free public Context Receipt bound to packet/manifest/lineage/role/prompt digests.
 * Never includes packet facts, constraints, or any hidden record bodies.
 */
export function buildContextReceipt({
  contextPacket,
  rolePolicy,
  contextManifest = null,
  lineageWorkerId,
  effectivePromptDigest: promptDigest
} = {}) {
  const packet = assertContextPacket(contextPacket);
  const policy = assertRuntimeRolePolicy(rolePolicy);
  if (typeof lineageWorkerId !== "string"
    || !/^(?:review|adversarial-review|task|stop-review)-[a-f0-9]{16,64}$/.test(lineageWorkerId)) {
    throw new CompanionError("E_STATE", "Context receipt requires a lineage worker id.");
  }
  if (!SHA256_HEX.test(promptDigest || "")) {
    throw new CompanionError("E_STATE", "Context receipt requires an effective provider prompt digest.");
  }
  if (!contextManifest
    || !/^ctx-[a-f0-9]{24}$/.test(contextManifest.manifestId || "")
    || !SHA256_HEX.test(contextManifest.digest || "")) {
    throw new CompanionError("E_STATE", "Context receipt requires an exact context manifest.");
  }
  const body = {
    schemaVersion: CONTEXT_RECEIPT_VERSION,
    packetId: packet.packetId,
    packetDigest: packet.digest,
    mode: packet.mode,
    provenance: {
      source: packet.provenance?.source || null,
      precedence: Array.isArray(packet.provenance?.precedence)
        ? [...packet.provenance.precedence]
        : [],
      envelopeId: packet.provenance?.envelopeId || null,
      envelopeDigest: packet.provenance?.envelopeDigest || null
    },
    factCount: packet.facts.length,
    factsDigest: digest(packet.facts),
    constraintCount: packet.constraints.length,
    constraintsDigest: digest(packet.constraints),
    omissions: Array.isArray(packet.omissions) ? [...packet.omissions] : [],
    bounds: {
      maxFacts: packet.bounds?.maxFacts ?? null,
      maxFactChars: packet.bounds?.maxFactChars ?? null,
      maxConstraints: packet.bounds?.maxConstraints ?? null,
      maxConstraintChars: packet.bounds?.maxConstraintChars ?? null,
      effectiveMaxFacts: packet.bounds?.effectiveMaxFacts ?? null,
      effectiveMaxConstraints: packet.bounds?.effectiveMaxConstraints ?? null
    },
    truncated: false,
    hiddenRecordsExported: false,
    rolePolicyDigest: policy.digest,
    logicalRoleId: policy.logicalRoleId,
    roleDigest: policy.roleDigest,
    providerProfileId: policy.providerProfileId,
    providerProfileVersion: policy.providerProfileVersion,
    agentProfileDigest: policy.agentProfileDigest,
    allowedProviderToolIdsDigest: digest(policy.allowedProviderToolIds),
    deniedProviderToolIdsDigest: digest(policy.deniedProviderToolIds),
    lineageWorkerId,
    contextManifestId: contextManifest.manifestId,
    contextManifestDigest: contextManifest.digest,
    effectivePromptDigest: promptDigest
  };
  body.receiptDigest = digest(body);
  return deepFreeze(body);
}

export function assertContextReceiptShape(receipt) {
  if (!exactKeys(receipt, CONTEXT_RECEIPT_KEYS)) {
    throw new CompanionError("E_SCHEMA", "Context receipt is missing or malformed.");
  }
  if (receipt.schemaVersion !== CONTEXT_RECEIPT_VERSION
    || !PACKET_ID.test(receipt.packetId || "")
    || !["none", "explicit-envelope"].includes(receipt.mode)
    || !Number.isSafeInteger(receipt.factCount)
    || receipt.factCount < 0
    || receipt.factCount > MAX_CONTEXT_FACTS
    || !Number.isSafeInteger(receipt.constraintCount)
    || receipt.constraintCount < 0
    || receipt.constraintCount > MAX_CONTEXT_CONSTRAINTS
    || !Array.isArray(receipt.omissions)
    || receipt.omissions.length > MAX_CONTEXT_OMISSIONS
    || new Set(receipt.omissions).size !== receipt.omissions.length
    || receipt.omissions.some((item) => (
      typeof item !== "string" || !CONTEXT_OMISSION_CODE_SET.has(item)
    ))
    || !exactKeys(receipt.bounds, CONTEXT_BOUNDS_KEYS)
    || Object.values(receipt.bounds).some((value) => (
      !Number.isSafeInteger(value) || value < 0
    ))
    || !exactKeys(receipt.provenance, CONTEXT_PROVENANCE_EXPLICIT_KEYS)
    || !["none", "explicit-envelope"].includes(receipt.provenance.source)
    || !Array.isArray(receipt.provenance.precedence)
    || receipt.provenance.precedence.some((value) => typeof value !== "string")
    || (receipt.provenance.envelopeId !== null
      && !ENVELOPE_ID.test(receipt.provenance.envelopeId || ""))
    || (receipt.provenance.envelopeDigest !== null
      && !SHA256_HEX.test(receipt.provenance.envelopeDigest || ""))
    || receipt.truncated !== false
    || receipt.hiddenRecordsExported !== false
    || !LOGICAL_ROLE_IDS.has(receipt.logicalRoleId)
    || !PROVIDER_PROFILE_ID.test(receipt.providerProfileId || "")
    || !Number.isSafeInteger(receipt.providerProfileVersion)
    || receipt.providerProfileVersion < 1
    || !/^(?:review|adversarial-review|task|stop-review)-[a-f0-9]{16,64}$/.test(
      receipt.lineageWorkerId || ""
    )
    || !/^ctx-[a-f0-9]{24}$/.test(receipt.contextManifestId || "")) {
    throw new CompanionError("E_SCHEMA", "Unsupported context receipt schema version.");
  }
  for (const name of [
    "receiptDigest",
    "packetDigest",
    "factsDigest",
    "constraintsDigest",
    "effectivePromptDigest",
    "rolePolicyDigest",
    "roleDigest",
    "agentProfileDigest",
    "allowedProviderToolIdsDigest",
    "deniedProviderToolIdsDigest",
    "contextManifestDigest"
  ]) {
    if (!SHA256_HEX.test(receipt[name] || "")) {
      throw new CompanionError("E_SCHEMA", `Context receipt ${name} is malformed.`);
    }
  }
  const explicitMode = receipt.mode === "explicit-envelope";
  const emptyDigest = digest([]);
  const invalidBounds = receipt.bounds.maxFacts > MAX_CONTEXT_FACTS
    || receipt.bounds.maxFactChars > MAX_CONTEXT_FACT_CHARS
    || receipt.bounds.maxConstraints > MAX_CONTEXT_CONSTRAINTS
    || receipt.bounds.maxConstraintChars > MAX_CONTEXT_CONSTRAINT_CHARS
    || receipt.bounds.effectiveMaxFacts !== receipt.bounds.maxFacts
    || receipt.bounds.effectiveMaxConstraints !== receipt.bounds.maxConstraints
    || receipt.factCount > receipt.bounds.effectiveMaxFacts
    || receipt.constraintCount > receipt.bounds.effectiveMaxConstraints;
  const invalidExplicit = explicitMode && (
    receipt.provenance.source !== "explicit-envelope"
    || stableStringify(receipt.provenance.precedence)
      !== stableStringify(["explicit-facts", "explicit-constraints"])
    || ((receipt.provenance.envelopeId === null)
      !== (receipt.provenance.envelopeDigest === null))
    || receipt.omissions.includes("all-context-omitted")
    || DEFAULT_CONTEXT_OMISSIONS.some((item) => !receipt.omissions.includes(item))
    || receipt.bounds.maxFacts < 1
    || receipt.bounds.maxFactChars < 1
    || receipt.bounds.maxConstraints < 1
    || receipt.bounds.maxConstraintChars < 1
  );
  const invalidNone = !explicitMode && (
    receipt.provenance.source !== "none"
    || receipt.provenance.precedence.length !== 0
    || receipt.provenance.envelopeId !== null
    || receipt.provenance.envelopeDigest !== null
    || receipt.factCount !== 0
    || receipt.constraintCount !== 0
    || receipt.factsDigest !== emptyDigest
    || receipt.constraintsDigest !== emptyDigest
    || stableStringify(receipt.omissions) !== stableStringify(["all-context-omitted"])
    || Object.values(receipt.bounds).some((value) => value !== 0)
  );
  if (invalidBounds
    || invalidExplicit
    || invalidNone
    || (receipt.factCount === 0 && receipt.factsDigest !== emptyDigest)
    || (receipt.constraintCount === 0 && receipt.constraintsDigest !== emptyDigest)) {
    throw new CompanionError(
      "E_SCHEMA",
      "Context receipt mode, provenance, omissions, counts, or bounds are contradictory."
    );
  }
  const { receiptDigest, ...body } = receipt;
  if (receiptDigest !== digest(body)) {
    throw new CompanionError("E_AUTH_REQUIRED", "Context receipt digest mismatch.");
  }
  const serialized = stableStringify(receipt);
  if (/\"(?:facts|constraints|userRequest|objective|prompt|providerSessionId)\"\s*:/.test(serialized)) {
    throw new CompanionError("E_SCHEMA", "Context receipt contains a private body field.");
  }
  return receipt;
}

export function assertContextReceipt(receipt, {
  contextPacket,
  rolePolicy,
  contextManifest,
  lineageWorkerId,
  effectivePromptDigest: promptDigest
} = {}) {
  assertContextReceiptShape(receipt);
  if (!contextPacket
    || !rolePolicy
    || !contextManifest
    || typeof lineageWorkerId !== "string"
    || !SHA256_HEX.test(promptDigest || "")) {
    throw new CompanionError(
      "E_AUTH_REQUIRED",
      "Context receipt validation requires its private packet, policy, manifest, lineage, and prompt bindings."
    );
  }
  const expected = buildContextReceipt({
    contextPacket,
    rolePolicy,
    contextManifest,
    lineageWorkerId,
    effectivePromptDigest: promptDigest
  });
  if (stableStringify(receipt) !== stableStringify(expected)) {
    throw new CompanionError("E_AUTH_REQUIRED", "Context receipt binding mismatch.");
  }
  return receipt;
}

/**
 * Resolve the exact provider prompt for a durable job.
 * Receipt-backed jobs reconstruct from packet/policy; legacy jobs use the
 * explicit versioned envelope composer and never silently migrate.
 */
export function resolveJobProviderPrompt(job, {
  root,
  contextManifest = null,
  composeLegacyProviderPrompt
} = {}) {
  const packet = job?.request?.contextPacket;
  const policy = job?.request?.runtimeRolePolicy;
  const receipt = job?.request?.contextReceipt;
  const bindingMode = job?.request?.contextBindingMode;
  const hasAnyBinding = bindingMode !== undefined
    || packet !== undefined
    || policy !== undefined
    || receipt !== undefined;
  if (hasAnyBinding) {
    if (bindingMode !== CONTEXT_BINDING_MODE || !packet || !policy || !receipt) {
      throw new CompanionError(
        "E_STATE",
        "Receipt-backed worker is missing its exact context discriminator, packet, policy, or receipt."
      );
    }
    if (job.request?.providerHomeId !== job.id) {
      throw new CompanionError("E_AUTH_REQUIRED", "Root worker lineage does not match its durable worker id.");
    }
    assertContextPacket(packet, { envelope: job.request?.envelope });
    assertRuntimeRolePolicy(policy, { role: job.role, profile: job.profile });
    const manifest = contextManifest || job.request?.contextManifest || null;
    assertContextReceipt(receipt, {
      contextPacket: packet,
      rolePolicy: policy,
      contextManifest: manifest,
      lineageWorkerId: job.request.providerHomeId,
      effectivePromptDigest: job.request?.providerPromptDigest
    });
    return composeEffectiveProviderPrompt({
      envelope: job.request?.envelope,
      contextPacket: packet,
      rolePolicy: policy,
      contextManifest: manifest,
      root
    });
  }
  if (typeof composeLegacyProviderPrompt !== "function") {
    throw new CompanionError(
      "E_STATE",
      "Legacy provider prompt reconstruction requires an explicit versioned composer."
    );
  }
  return composeLegacyProviderPrompt(job.request?.envelope, {
    root,
    contextManifest: contextManifest || job.request?.contextManifest || null
  });
}

export function verifyJobEffectivePrompt(job, {
  root,
  contextManifest = null,
  composeLegacyProviderPrompt
} = {}) {
  const expected = job?.request?.providerPromptDigest;
  if (!SHA256_HEX.test(expected || "")) {
    throw new CompanionError("E_AUTH_REQUIRED", "Worker is missing a durable effective provider prompt digest.");
  }
  const prompt = resolveJobProviderPrompt(job, {
    root,
    contextManifest,
    composeLegacyProviderPrompt
  });
  const observed = effectivePromptDigest(prompt);
  if (observed !== expected) {
    throw new CompanionError(
      "E_AUTH_REQUIRED",
      "Provider prompt no longer matches the authorized launch contract."
    );
  }
  return { prompt, digest: observed };
}
