const SECRET_KEY = /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|credential|cookie)/i;
const PATTERNS = [
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /\b(xai-[A-Za-z0-9_-]{12,})\b/g,
  /\b(sbp_[A-Za-z0-9_-]{12,})\b/g,
  /\b(sk-[A-Za-z0-9_-]{12,})\b/g,
  /\b(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g
];

export function redactText(value, knownSecrets = []) {
  let text = String(value ?? "");
  for (const secret of knownSecrets) if (secret) text = text.split(String(secret)).join("[REDACTED]");
  for (const pattern of PATTERNS) text = text.replace(pattern, (match, prefix) => prefix?.startsWith?.("Bearer") ? `${prefix}[REDACTED]` : "[REDACTED]");
  return text;
}

/** Redact common secrets and remove terminal/control characters that can forge rendered output. */
export function sanitizeDisplayText(value, knownSecrets = []) {
  return redactText(value, knownSecrets)
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "");
}

export function redact(value, knownSecrets = [], ancestors = new WeakSet()) {
  if (typeof value === "string") return redactText(value, knownSecrets);
  if (!value || typeof value !== "object") return value;
  // Track only the current recursion path. A WeakSet retained for the complete
  // traversal misclassifies ordinary shared arrays/objects as cycles and can
  // corrupt stored result types (for example validationIssues -> "[CIRCULAR]").
  if (ancestors.has(value)) return "[CIRCULAR]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => redact(item, knownSecrets, ancestors));
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redact(item, knownSecrets, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}
