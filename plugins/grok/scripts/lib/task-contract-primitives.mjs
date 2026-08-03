import crypto from "node:crypto";
import path from "node:path";

import { CompanionError } from "./errors.mjs";
import { sanitizeDisplayText } from "./redact.mjs";

const MAX_TEXT = 16 * 1024;
const MAX_USER_REQUEST = 64 * 1024;
const MAX_LIST = 64;
const MAX_ITEM = 2 * 1024;

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const CONTEXT_MANIFEST_ID = /^ctx-[a-f0-9]{24}$/;

function retainedTextDigest(literal, existingDigest) {
  if (typeof literal === "string") return sha(literal);
  return SHA256_HEX.test(existingDigest || "") ? existingDigest : null;
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

export {
  MAX_ITEM,
  MAX_LIST,
  SHA256_HEX,
  CONTEXT_MANIFEST_ID,
  asRepositoryPathList,
  asStringList,
  boundedLiteral,
  canonicalJson,
  clip,
  normalizeAcceptance,
  retainedTextDigest,
  sha,
  stableAcceptanceId
};
