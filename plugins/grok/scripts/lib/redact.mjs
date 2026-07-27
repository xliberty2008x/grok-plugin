function isSecretKey(key, value) {
  const segmented = String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
  // Usage counters are operational telemetry, not authentication material.
  if (
    Number.isFinite(value)
    && (
      segmented === "tokens"
      || segmented.endsWith("_tokens")
      || segmented === "token_count"
      || segmented.endsWith("_token_count")
    )
  ) {
    return false;
  }
  return /(?:^|_)(?:authorization|api_key|access_token|refresh_token|tokens?|password|passwd|pwd|secret|credential|cookie)(?:_|$)/.test(segmented);
}
const WHOLE_SECRET_PATTERNS = [
  /\bxai-[A-Za-z0-9_-]{12,}\b/g,
  /\bsbp_[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g
];

export function redactText(value, knownSecrets = []) {
  let text = String(value ?? "");
  for (const secret of knownSecrets) if (secret) text = text.split(String(secret)).join("[REDACTED]");
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");
  text = text.replace(
    /\b((?:[A-Za-z0-9]+[_-])*authorization["']?\s*[:=]\s*)(?!Bearer\b)(?:Basic\s+)?[^\s,"';]+/gi,
    "$1[REDACTED]"
  );
  for (const pattern of WHOLE_SECRET_PATTERNS) text = text.replace(pattern, "[REDACTED]");
  // Redact credentials embedded in URLs while retaining non-secret routing
  // context. This covers database DSNs and HTTP basic-auth URLs.
  text = text.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s/@]+(@)/gi,
    "$1[REDACTED]$2"
  );
  // Text facts and provider messages are often key/value snippets rather than
  // structured objects, so key-based object redaction alone is insufficient.
  text = text.replace(
    /\b((?:[A-Za-z0-9]+[_-])*(?:aws[_-]?secret[_-]?access[_-]?key|api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|pwd|secret|credential|cookie)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,"';]+)/gi,
    "$1[REDACTED]"
  );
  // Camel-case configuration snippets (for example clientSecret or
  // githubToken) have no separator before the sensitive suffix.
  text = text.replace(
    /\b([A-Za-z][A-Za-z0-9]*?(?:authorization|apiKey|accessToken|refreshToken|token|password|passwd|pwd|secret|credential|cookie)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,"';]+)/gi,
    "$1[REDACTED]"
  );
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
      result[key] = isSecretKey(key, item) ? "[REDACTED]" : redact(item, knownSecrets, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}
