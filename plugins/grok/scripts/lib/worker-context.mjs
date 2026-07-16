/**
 * Context Packet v1 — explicit-envelope first; stronger modes gated on transcript proof.
 */
import crypto from "node:crypto";

import { CompanionError } from "./errors.mjs";

export const CONTEXT_PACKET_VERSION = 1;
export const CONTEXT_MODES = Object.freeze([
  "none",
  "explicit-envelope",
  "recent:N",
  "all-user-visible"
]);

/**
 * Trusted privacy-filtered transcript acquisition is not proven by default.
 * Stronger modes remain disabled until a spike record sets proven=true.
 */
export function transcriptAcquisitionCapability({ proven = false, privacyFiltered = false } = {}) {
  return Object.freeze({
    proven: Boolean(proven),
    privacyFiltered: Boolean(privacyFiltered),
    recentNEnabled: Boolean(proven && privacyFiltered),
    allUserVisibleEnabled: Boolean(proven && privacyFiltered),
    note: proven && privacyFiltered
      ? "recent:N and all-user-visible may be enabled."
      : "Only none and explicit-envelope are safe."
  });
}

function digest(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
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
    return Object.freeze({
      schemaVersion: CONTEXT_PACKET_VERSION,
      mode: "none",
      packetId: `ctx-${digest("none").slice(0, 16)}`,
      digest: digest({ mode: "none" }),
      provenance: { source: "none", precedence: [] },
      facts: [],
      omissions: ["all-context-omitted"],
      bounds: bounds || { maxFacts: 0 },
      hiddenRecordsExported: false
    });
  }

  if (resolvedMode.startsWith("recent:") || resolvedMode === "all-user-visible") {
    if (resolvedMode.startsWith("recent:") && !transcriptCapability.recentNEnabled) {
      throw new CompanionError(
        "E_CAPABILITY",
        "recent:N context requires proven privacy-filtered transcript acquisition."
      );
    }
    if (resolvedMode === "all-user-visible" && !transcriptCapability.allUserVisibleEnabled) {
      throw new CompanionError(
        "E_CAPABILITY",
        "all-user-visible context requires proven privacy-filtered transcript acquisition."
      );
    }
  } else if (resolvedMode !== "explicit-envelope") {
    throw new CompanionError("E_USAGE", `Unsupported context mode ${resolvedMode}.`);
  }

  const safeFacts = (Array.isArray(facts) ? facts : [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .filter((item) => !looksHidden(item))
    .slice(0, 64);

  if (envelope?.userRequest && !looksHidden(envelope.userRequest)) {
    // Include only non-secret envelope fields as facts when not already present.
    const objective = envelope.objective || envelope.userRequest;
    if (objective && !safeFacts.includes(objective)) {
      safeFacts.unshift(String(objective).slice(0, 2000));
    }
  }

  const packet = {
    schemaVersion: CONTEXT_PACKET_VERSION,
    mode: resolvedMode === "explicit-envelope" ? "explicit-envelope" : resolvedMode,
    packetId: `ctx-${digest(JSON.stringify({ mode: resolvedMode, safeFacts })).slice(0, 16)}`,
    provenance: {
      source: "explicit-envelope",
      precedence: ["host-envelope", "explicit-facts"],
      envelopeId: envelope?.envelopeId || null,
      envelopeDigest: envelope?.digest || null
    },
    facts: safeFacts,
    omissions: [
      ...(Array.isArray(omissions) ? omissions : []),
      "hidden-system-instructions",
      "developer-instructions",
      "raw-transcripts",
      "credentials",
      "provider-session-ids"
    ],
    bounds: bounds || { maxFacts: 64, maxFactChars: 2000 },
    hiddenRecordsExported: false
  };
  packet.digest = digest({
    mode: packet.mode,
    facts: packet.facts,
    provenance: packet.provenance,
    omissions: packet.omissions
  });
  return Object.freeze(packet);
}

function looksHidden(text) {
  const value = String(text || "");
  return /(?:^|\b)(system:|developer:|<\s*system\s*>|api[_-]?key|bearer\s+[a-z0-9._-]+|xai-[a-z0-9]{10,})/i.test(value);
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
