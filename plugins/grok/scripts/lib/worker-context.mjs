/**
 * Context Packet v1 — explicit-envelope first; stronger modes gated on transcript proof.
 */
import crypto from "node:crypto";

import { CompanionError } from "./errors.mjs";
import { redactText } from "./redact.mjs";

export const CONTEXT_PACKET_VERSION = 1;
export const MAX_CONTEXT_FACTS = 64;
export const MAX_CONTEXT_FACT_CHARS = 2000;
export const CONTEXT_MODES = Object.freeze([
  "none",
  "explicit-envelope",
  "recent:N",
  "all-user-visible"
]);

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

function digest(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function normalizeBounds(bounds, mode) {
  if (mode === "none") return Object.freeze({ maxFacts: 0, maxFactChars: 0 });
  const maxFacts = bounds?.maxFacts ?? MAX_CONTEXT_FACTS;
  const maxFactChars = bounds?.maxFactChars ?? MAX_CONTEXT_FACT_CHARS;
  if (!Number.isSafeInteger(maxFacts) || maxFacts < 1 || maxFacts > MAX_CONTEXT_FACTS) {
    throw new CompanionError("E_USAGE", `bounds.maxFacts must be an integer from 1 to ${MAX_CONTEXT_FACTS}.`);
  }
  if (!Number.isSafeInteger(maxFactChars) || maxFactChars < 1 || maxFactChars > MAX_CONTEXT_FACT_CHARS) {
    throw new CompanionError("E_USAGE", `bounds.maxFactChars must be an integer from 1 to ${MAX_CONTEXT_FACT_CHARS}.`);
  }
  return Object.freeze({ maxFacts, maxFactChars });
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

/**
 * Build a Context Packet from explicit envelope material only.
 * Never exports hidden system/developer instructions, credentials, or raw transcripts.
 */
export function buildContextPacket({
  mode = "explicit-envelope",
  envelope = null,
  facts = [],
  omissions = [],
  bounds = null,
  transcriptCapability = transcriptAcquisitionCapability()
} = {}) {
  const resolvedMode = String(mode || "explicit-envelope");
  if (resolvedMode === "none") {
    const safeBounds = normalizeBounds(bounds, resolvedMode);
    return deepFreeze({
      schemaVersion: CONTEXT_PACKET_VERSION,
      mode: "none",
      packetId: `ctx-${digest("none").slice(0, 16)}`,
      digest: digest({ mode: "none" }),
      provenance: { source: "none", precedence: [] },
      facts: [],
      omissions: ["all-context-omitted"],
      bounds: safeBounds,
      hiddenRecordsExported: false
    });
  }

  const recentLimit = assertContextMode(resolvedMode, transcriptCapability);
  const safeBounds = normalizeBounds(bounds, resolvedMode);
  const effectiveMaxFacts = recentLimit == null
    ? safeBounds.maxFacts
    : Math.min(recentLimit, safeBounds.maxFacts);

  const candidates = [];
  if (envelope?.userRequest && !looksHidden(envelope.userRequest)) {
    const objective = envelope.objective || envelope.userRequest;
    if (objective) candidates.push(objective);
  }
  candidates.push(...(Array.isArray(facts) ? facts : []));
  const safeFacts = candidates
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .filter((item) => !looksHidden(item))
    .map((item) => item.slice(0, safeBounds.maxFactChars))
    .filter((item, index, all) => all.indexOf(item) === index)
    .slice(0, effectiveMaxFacts);
  const safeOmissions = (Array.isArray(omissions) ? omissions : [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .filter((item) => !looksHidden(item))
    .map((item) => item.slice(0, 256))
    .filter((item, index, all) => all.indexOf(item) === index)
    .slice(0, 64);

  const packet = {
    schemaVersion: CONTEXT_PACKET_VERSION,
    mode: resolvedMode === "explicit-envelope" ? "explicit-envelope" : resolvedMode,
    packetId: `ctx-${digest(JSON.stringify({ mode: resolvedMode, safeFacts })).slice(0, 16)}`,
    provenance: {
      source: resolvedMode === "explicit-envelope"
        ? "explicit-envelope"
        : "trusted-privacy-filtered-transcript",
      precedence: resolvedMode === "explicit-envelope"
        ? ["host-envelope", "explicit-facts"]
        : ["host-envelope", "privacy-filtered-transcript", "explicit-facts"],
      envelopeId: envelope?.envelopeId || null,
      envelopeDigest: envelope?.digest || null
    },
    facts: safeFacts,
    omissions: [
      ...safeOmissions,
      "hidden-system-instructions",
      "developer-instructions",
      "raw-transcripts",
      "credentials",
      "provider-session-ids"
    ],
    bounds: Object.freeze({
      ...safeBounds,
      effectiveMaxFacts
    }),
    hiddenRecordsExported: false
  };
  packet.digest = digest({
    mode: packet.mode,
    facts: packet.facts,
    provenance: packet.provenance,
    omissions: packet.omissions,
    bounds: packet.bounds
  });
  return deepFreeze(packet);
}

function looksHidden(text) {
  const value = String(text || "");
  return /(?:^|\b)(system:|developer:|<\s*system\s*>|api[_-]?key|bearer\s+[a-z0-9._-]+|xai-[a-z0-9]{10,})/i.test(value)
    || redactText(value) !== value;
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
  return true;
}
