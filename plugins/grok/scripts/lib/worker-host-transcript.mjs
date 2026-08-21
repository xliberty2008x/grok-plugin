/** Trusted-host transcript inheritance for worker spawn (#137). */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CompanionError } from "./errors.mjs";
import { pluginDataRoot, readCodexSessionMetadata } from "./host.mjs";
import { redactText, sanitizeDisplayText } from "./redact.mjs";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const MAX_TURNS = 32;
const MAX_TURN_CHARS = 2000;

function digestCanonical(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function looksHidden(text) {
  const value = String(text || "");
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || /<\s*\/?\s*(?:system|developer)\s*>/i.test(value)
    || redactText(value) !== value
    || sanitizeDisplayText(value) !== value;
}

function boundTurnText(text) {
  const cleaned = sanitizeDisplayText(String(text || "").trim());
  if (!cleaned || looksHidden(cleaned)) return null;
  return cleaned.length > MAX_TURN_CHARS ? cleaned.slice(0, MAX_TURN_CHARS) : cleaned;
}

export function parseHostTranscriptTurns(contents) {
  const turns = [];
  for (const raw of String(contents || "").split(/\r?\n/)) {
    if (!raw) continue;
    let record;
    try { record = JSON.parse(raw); } catch { continue; }
    if (record?.type !== "event_msg" || !record.payload) continue;
    const kind = record.payload.type;
    const message = record.payload.message;
    if (typeof message !== "string" || !message.trim()) continue;
    if (kind === "user_message") {
      const text = boundTurnText(message);
      if (text) turns.push({ role: "user", text });
      continue;
    }
    if (kind === "agent_message") {
      const phase = record.payload.phase;
      if (phase && phase !== "commentary" && phase !== "final_answer") continue;
      const text = boundTurnText(message);
      if (text) turns.push({ role: "assistant", text });
    }
  }
  return turns;
}

function resolveTranscriptPath({ principal, env = process.env } = {}) {
  const fromEnv = env.GROK_COMPANION_TRANSCRIPT_PATH;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return path.resolve(fromEnv);
  }
  const sessionId = principal?.threadId;
  const record = readCodexSessionMetadata(pluginDataRoot(env), sessionId);
  if (typeof record?.transcriptPath === "string" && record.transcriptPath) {
    return path.resolve(record.transcriptPath);
  }
  return null;
}

export function hostTranscriptDigest(turns) {
  return digestCanonical(turns.map((turn) => ({ role: turn.role, text: turn.text })));
}

/**
 * Broker-attested host transcript selection. Caller digest is verified against
 * materialized bytes; the transcript path is never taken from tool arguments.
 */
export function attestHostTranscriptSelection({
  principal,
  publicSpawn,
  env = process.env
} = {}) {
  const mode = publicSpawn?.contextMode || "none";
  if (mode === "none" || mode == null) {
    return Object.freeze({
      mode: "none",
      inheritTurns: null,
      digest: digestCanonical([]),
      turns: Object.freeze([]),
      facts: Object.freeze([])
    });
  }
  const transcriptPath = resolveTranscriptPath({ principal, env });
  if (!transcriptPath) {
    throw new CompanionError(
      "E_CONTEXT_INCOMPLETE",
      "Host transcript context is unavailable for the requested spawn mode."
    );
  }
  let contents;
  try {
    contents = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    throw new CompanionError(
      "E_CONTEXT_INCOMPLETE",
      "Host transcript context is unavailable for the requested spawn mode."
    );
  }
  const allTurns = parseHostTranscriptTurns(contents);
  const selected = mode === "recent"
    ? allTurns.filter((turn) => turn.role === "user").slice(-Number(publicSpawn.inheritTurns))
    : allTurns.slice(-MAX_TURNS);
  const digest = hostTranscriptDigest(selected);
  const expected = publicSpawn.contextDigest;
  if (!SHA256_HEX.test(expected || "") || expected !== digest) {
    throw new CompanionError(
      "E_CONTEXT_DRIFT",
      "Spawn contextDigest does not match the selected host transcript."
    );
  }
  const facts = selected.map((turn, index) => (
    `host-turn[${index}]:${turn.role}:${turn.text}`
  ));
  return Object.freeze({
    mode,
    inheritTurns: mode === "recent" ? publicSpawn.inheritTurns : null,
    digest,
    turns: Object.freeze(selected),
    facts: Object.freeze(facts)
  });
}
