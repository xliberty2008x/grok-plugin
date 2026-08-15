import { CompanionError } from "./errors.mjs";
import { redact, redactText, sanitizeDisplayText } from "./redact.mjs";

export const LIFECYCLE_EVENT_TYPES = Object.freeze([
  "task.accepted",
  "plan.updated",
  "activity.started",
  "activity.completed",
  "checkpoint",
  "blocked",
  "final.report",
  "cancellation.requested",
  "interruption.requested"
]);

/** Bounded retention for durable lifecycle evidence (oldest entries are dropped first). */
export const MAX_LIFECYCLE_EVENTS = 128;

const timestamp = () => new Date().toISOString();

function clip(value, limit) {
  const text = sanitizeDisplayText(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
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

function isNumericUsageCounter(key, value) {
  if (!Number.isFinite(value)) return false;
  const segmented = String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
  return segmented === "tokens"
    || segmented.endsWith("_tokens")
    || segmented === "token_count"
    || segmented.endsWith("_token_count");
}

function boundLifecycleDetail(detail, ancestors = new WeakSet()) {
  if (detail == null) return null;
  if (typeof detail === "string") return clip(detail, 1000);
  if (typeof detail !== "object") return detail;
  if (ancestors.has(detail)) return "[CIRCULAR]";
  ancestors.add(detail);
  try {
    if (Array.isArray(detail)) {
      return detail.slice(0, 20).map((item) => boundLifecycleDetail(item, ancestors));
    }
    const out = {};
    for (const [key, value] of Object.entries(detail).slice(0, 20)) {
      if (
        !isNumericUsageCounter(key, value)
        && /(secret|token|authorization|password|credential|cookie|api[-_]?key)/i.test(key)
      ) {
        out[key] = "[REDACTED]";
        continue;
      }
      if (typeof value === "string") out[key] = clip(value, 1000);
      else if (Array.isArray(value)) {
        if (ancestors.has(value)) {
          out[key] = "[CIRCULAR]";
          continue;
        }
        ancestors.add(value);
        try {
          out[key] = value.slice(0, 20).map((item) => (
            typeof item === "string" ? clip(item, 500) : boundLifecycleDetail(item, ancestors)
          ));
        } finally {
          ancestors.delete(value);
        }
      }
      else if (value && typeof value === "object") out[key] = boundLifecycleDetail(value, ancestors);
      else out[key] = value;
    }
    return out;
  } finally {
    ancestors.delete(detail);
  }
}
