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

export function redact(value, knownSecrets = [], seen = new WeakSet()) {
  if (typeof value === "string") return redactText(value, knownSecrets);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, knownSecrets, seen));
  const result = {};
  for (const [key, item] of Object.entries(value)) result[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redact(item, knownSecrets, seen);
  return result;
}
