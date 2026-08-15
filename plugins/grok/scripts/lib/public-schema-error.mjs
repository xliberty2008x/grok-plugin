/**
 * Public E_SCHEMA details for status/result. Kept out of worker-protocol.mjs
 * so that file stays at its exact 2097-line cap.
 */

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function projectPublicSchemaErrorDetails(value, boundText) {
  const projected = {};
  if (typeof value.hint === "string") projected.hint = boundText(value.hint);
  if (typeof value.reason === "string") projected.reason = boundText(value.reason, { max: 128 });
  if (typeof value.repairAttempted === "boolean") projected.repairAttempted = value.repairAttempted;
  if (Number.isSafeInteger(value.attempts) && value.attempts >= 0) {
    projected.attempts = value.attempts;
  }
  if (typeof value.firstError === "string") projected.firstError = boundText(value.firstError, { max: 64 });
  if (isPlainObject(value.partial)) {
    const findings = Array.isArray(value.partial.findings)
      ? value.partial.findings.slice(0, 32).map((item) => {
        if (!isPlainObject(item)) return null;
        const finding = {};
        if (typeof item.severity === "string") {
          finding.severity = boundText(item.severity, { max: 32 });
        }
        if (typeof item.title === "string") {
          finding.title = boundText(item.title, { max: 300 });
        }
        if (typeof item.body === "string") {
          finding.body = boundText(item.body, { max: 4000 });
        }
        return Object.keys(finding).length ? finding : null;
      }).filter(Boolean)
      : [];
    projected.partial = {
      findings,
      ...(typeof value.partial.summaryPresent === "boolean"
        ? { summaryPresent: value.partial.summaryPresent }
        : {})
    };
  }
  if (Array.isArray(value.rootKeys)) {
    projected.rootKeys = value.rootKeys
      .filter((item) => typeof item === "string")
      .map((item) => boundText(item, { max: 128 }))
      .filter(Boolean)
      .slice(0, 24);
  }
  if (typeof value.hasUnknownRootKeys === "boolean") {
    projected.hasUnknownRootKeys = value.hasUnknownRootKeys;
  }
  if (typeof value.summaryType === "string") {
    projected.summaryType = boundText(value.summaryType, { max: 64 });
  }
  if (Number.isSafeInteger(value.findingsCount) && value.findingsCount >= 0) {
    projected.findingsCount = value.findingsCount;
  }
  if (typeof value.findingsShapeOk === "boolean") {
    projected.findingsShapeOk = value.findingsShapeOk;
  }
  if (typeof value.payloadDigest === "string") {
    projected.payloadDigest = boundText(value.payloadDigest, { max: 256 });
  }
  return projected;
}
