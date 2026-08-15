import path from "node:path";

import { validateProviderHostActionRequest } from "./worker-host-actions.mjs";
import {
  MAX_ITEM,
  MAX_LIST,
  asStringList,
  canonicalJson,
  clip,
  sha,
  stableAcceptanceId
} from "./task-contract-primitives.mjs";

export const WORKER_REPORT_VERSION = 1;

const WORKER_REPORT_REQUIRED_FIELDS = Object.freeze([
  "outcome",
  "summary",
  "changedFiles",
  "checksClaimed",
  "acceptanceResults",
  "risks",
  "questions"
]);
const WORKER_REPORT_ALLOWED_FIELDS = Object.freeze([
  ...WORKER_REPORT_REQUIRED_FIELDS,
  "hostActionRequest"
]);

/**
 * Code-owned JSON Schema passed through Grok Build's ACP `outputSchema`
 * extension. Grok performs the first structural validation; the broker still
 * owns semantic validation, exact acceptance-ID accounting, scope checks, and
 * host verification.
 */
export function buildWorkerReportOutputSchema(acceptanceCriteria = []) {
  const criteria = Array.isArray(acceptanceCriteria)
    ? acceptanceCriteria.slice(0, MAX_LIST)
    : [];
  const acceptanceIds = criteria
    .map((criterion) => criterion?.id)
    .filter((id) => typeof id === "string" && id.length > 0);
  const acceptanceItem = {
    type: "object",
    additionalProperties: false,
    required: ["id", "status"],
    properties: {
      id: acceptanceIds.length
        ? { type: "string", enum: acceptanceIds }
        : { type: "string", minLength: 1, maxLength: 80 },
      status: {
        type: "string",
        enum: ["met", "unmet", "unknown"]
      },
      note: { type: "string", maxLength: MAX_ITEM }
    }
  };
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: [...WORKER_REPORT_REQUIRED_FIELDS, "hostActionRequest"],
    properties: {
      outcome: {
        type: "string",
        enum: ["complete", "partial", "blocked"]
      },
      summary: {
        type: "string",
        minLength: 1,
        maxLength: 2000
      },
      changedFiles: {
        type: "array",
        maxItems: 200,
        items: { type: "string", minLength: 1, maxLength: 1024 }
      },
      checksClaimed: {
        type: "array",
        maxItems: MAX_LIST,
        items: { type: "string", maxLength: MAX_ITEM }
      },
      acceptanceResults: {
        type: "array",
        minItems: acceptanceIds.length,
        maxItems: acceptanceIds.length || MAX_LIST,
        items: acceptanceItem
      },
      risks: {
        type: "array",
        maxItems: MAX_LIST,
        items: { type: "string", maxLength: MAX_ITEM }
      },
      questions: {
        type: "array",
        maxItems: MAX_LIST,
        items: { type: "string", maxLength: MAX_ITEM }
      },
      hostActionRequest: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            required: ["schemaVersion", "kind", "requestedRoleId"],
            properties: {
              schemaVersion: { const: 1 },
              kind: { const: "role_admission" },
              requestedRoleId: {
                type: "string",
                enum: ["reviewer", "security", "test", "implementer"]
              }
            }
          }
        ]
      }
    }
  });
}

/**
 * Build a structured final worker report from provider output.
 * Interim message text must not be passed here.
 */
export function buildWorkerReport(options = {}) {
  const {
    providerText = "",
    outcome = null,
    summary = null,
    changedFiles = null,
    checksClaimed = null,
    acceptanceResults = null,
    risks = null,
    questions = null,
    hostActionRequest = undefined,
    acceptanceCriteria = [],
    nativeStructuredOutput = undefined,
    nativeStructuredOutputError = undefined
  } = options;
  const nativeOutputPresent = Object.hasOwn(options, "nativeStructuredOutput");
  const nativeErrorPresent = Object.hasOwn(options, "nativeStructuredOutputError");
  const nativeOutputValidShape = nativeStructuredOutput
    && typeof nativeStructuredOutput === "object"
    && !Array.isArray(nativeStructuredOutput);
  const nativeShapeIssues = [];
  if (nativeOutputPresent && nativeErrorPresent) {
    nativeShapeIssues.push("ACP returned both structured output and a structured-output error.");
  } else if (nativeErrorPresent) {
    nativeShapeIssues.push("Grok Build could not produce schema-valid structured output.");
  } else if (nativeOutputPresent && !nativeOutputValidShape) {
    nativeShapeIssues.push("ACP structured output must be a Worker Report object.");
  }
  const parsedReport = nativeOutputPresent && !nativeErrorPresent && nativeOutputValidShape
    ? {
        value: nativeStructuredOutput,
        markerPresent: true,
        source: "acp-structured"
      }
    : (!nativeOutputPresent && !nativeErrorPresent
        ? parseStructuredWorkerPayload(providerText)
        : null);
  const parsed = parsedReport?.value || null;
  const text = clip(String(providerText || "").trim());
  const allowedFields = new Set(WORKER_REPORT_ALLOWED_FIELDS);
  const shapeIssues = [];
  if (parsed) {
    for (const field of WORKER_REPORT_REQUIRED_FIELDS) if (!Object.hasOwn(parsed, field)) shapeIssues.push(`Structured worker report omitted ${field}.`);
    for (const field of Object.keys(parsed)) if (!allowedFields.has(field)) shapeIssues.push(`Structured worker report included unsupported field ${field}.`);
    if (typeof parsed.summary !== "string" || !parsed.summary.trim()) shapeIssues.push("Structured worker report summary must be a non-empty string.");
    for (const field of ["changedFiles", "checksClaimed", "acceptanceResults", "risks", "questions"]) {
      if (!Array.isArray(parsed[field])) shapeIssues.push(`Structured worker report ${field} must be an array.`);
    }
  }
  const resolvedSummary = clip(
    summary
      || (typeof parsed?.summary === "string" ? parsed.summary : null)
      || text.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
      || "Completed"
  , 2000);
  const normalizedPaths = normalizeClaimedPaths(changedFiles ?? parsed?.changedFiles);
  const files = normalizedPaths.paths;
  const checks = asStringList(checksClaimed ?? parsed?.checksClaimed);
  const risksList = asStringList(risks ?? parsed?.risks);
  const questionsList = asStringList(questions ?? parsed?.questions);
  const criteria = Array.isArray(acceptanceCriteria) ? acceptanceCriteria : [];
  const normalizedAcceptance = normalizeAcceptanceResults(acceptanceResults ?? parsed?.acceptanceResults, criteria);
  const hostActionPresent = hostActionRequest !== undefined
    || Boolean(parsed && Object.hasOwn(parsed, "hostActionRequest"));
  const normalizedHostAction = validateProviderHostActionRequest(
    hostActionRequest !== undefined ? hostActionRequest : parsed?.hostActionRequest,
    { present: hostActionPresent }
  );
  const requestedOutcome = ["complete", "partial", "blocked"].includes(outcome)
    ? outcome
    : ["complete", "partial", "blocked"].includes(parsed?.outcome)
      ? parsed.outcome
      : null;
  const validationIssues = [
    ...nativeShapeIssues,
    ...shapeIssues,
    ...normalizedPaths.issues,
    ...normalizedAcceptance.issues,
    ...normalizedHostAction.issues
  ];
  if (parsed && !requestedOutcome) validationIssues.push("Structured worker report omitted a valid outcome.");
  if (!parsed && !nativeOutputPresent && !nativeErrorPresent) {
    validationIssues.push("Provider did not return a GROK_WORKER_REPORT JSON object.");
  } else if (parsed && parsedReport.source !== "acp-structured" && !parsedReport.markerPresent) {
    validationIssues.push("Provider returned JSON without the required GROK_WORKER_REPORT marker.");
  }
  let resolvedOutcome = requestedOutcome || "partial";
  let classificationReason = null;
  const declaredRequired = Array.isArray(acceptanceCriteria) && acceptanceCriteria.length > 0;
  if (resolvedOutcome === "complete" && declaredRequired) {
    const unknownRequired = normalizedAcceptance.results.filter((entry) => entry.status === "unknown");
    if (unknownRequired.length) {
      resolvedOutcome = "partial";
      classificationReason = "Required acceptance criteria remain unknown.";
    }
  }
  const reportSource = parsedReport?.source === "acp-structured"
    ? "acp-structured"
    : nativeErrorPresent
      ? "acp-structured-error"
      : parsedReport?.markerPresent
        ? "text-marker"
        : "text-unmarked";
  const report = {
    schemaVersion: WORKER_REPORT_VERSION,
    structured: parsedReport?.source === "acp-structured"
      || Boolean(parsedReport?.markerPresent),
    valid: (
      parsedReport?.source === "acp-structured"
      || Boolean(parsedReport?.markerPresent)
    ) && validationIssues.length === 0,
    outcome: resolvedOutcome,
    summary: classificationReason ? `${classificationReason} ${resolvedSummary}` : resolvedSummary,
    changedFiles: files,
    checksClaimed: checks,
    acceptanceResults: normalizedAcceptance.results,
    risks: risksList,
    questions: questionsList,
    ...(hostActionPresent && normalizedHostAction.ok
      ? { hostActionRequest: normalizedHostAction.value }
      : {}),
    validationIssues,
    reportSource,
    reportDigest: null,
    ...(classificationReason ? { classificationReason } : {})
  };
  if (report.valid) {
    report.reportDigest = sha(canonicalJson({
      schemaVersion: report.schemaVersion,
      outcome: report.outcome,
      summary: report.summary,
      changedFiles: report.changedFiles,
      checksClaimed: report.checksClaimed,
      acceptanceResults: report.acceptanceResults,
      risks: report.risks,
      questions: report.questions,
      ...(Object.hasOwn(report, "hostActionRequest")
        ? { hostActionRequest: report.hostActionRequest }
        : {})
    }));
  }
  return report;
}

/** Build one same-session, no-tool-use repair turn for a malformed final worker report. */
export function composeWorkerReportRepairPrompt(envelope, report) {
  const criteria = Array.isArray(envelope?.acceptanceCriteria) ? envelope.acceptanceCriteria : [];
  const acceptanceTemplate = criteria.map((criterion) => ({
    id: criterion.id,
    status: "unknown",
    note: "short evidence"
  }));
  const template = {
    outcome: "partial",
    summary: "concise factual summary",
    changedFiles: ["repository/relative/path"],
    checksClaimed: ["only checks actually run with available tools"],
    acceptanceResults: acceptanceTemplate,
    risks: ["remaining risk"],
    questions: ["blocking question"],
    hostActionRequest: null
  };
  const issues = asStringList(report?.validationIssues, { max: 20 });
  return [
    "Report-format repair only. The task turn already ran.",
    "Do not call tools, inspect files, modify the workspace, or repeat implementation.",
    `The previous report was invalid: ${issues.join("; ") || "required report marker/schema missing"}.`,
    "Return exactly one line. It must begin with GROK_WORKER_REPORT: followed immediately by one JSON object.",
    "Use exactly the eight keys shown below, no Markdown fence, no prose before or after, and exactly one acceptance result for every supplied ID. Choose outcome from complete, partial, or blocked; choose each status from met, unmet, or unknown. hostActionRequest must be null unless the worker is requesting one future read-only role admission.",
    `GROK_WORKER_REPORT: ${JSON.stringify(template)}`
  ].join("\n");
}

function normalizeClaimedPaths(items) {
  if (!Array.isArray(items)) return { paths: [], issues: [] };
  const paths = [];
  const issues = [];
  for (const item of items.slice(0, 200)) {
    const value = clip(String(item ?? "").trim(), 1024).replace(/\\/g, "/");
    if (!value || path.posix.isAbsolute(value) || /^[A-Za-z]:\//.test(value) || value.split("/").includes("..")) {
      issues.push(`Worker reported an invalid repository path: ${value || "(empty)"}.`);
      continue;
    }
    paths.push(value.replace(/^\.\//, ""));
  }
  return { paths: [...new Set(paths)], issues };
}

function normalizeAcceptanceResults(items, criteria) {
  const declared = Array.isArray(criteria) ? criteria.slice(0, MAX_LIST) : [];
  const provided = Array.isArray(items) ? items.slice(0, MAX_LIST) : [];
  const issues = [];
  if (!declared.length) {
    const results = provided.map((item, index) => {
      const value = typeof item === "string" ? { note: item } : item || {};
      return {
        id: stableAcceptanceId(index, value.id),
        status: ["met", "unmet", "unknown"].includes(value.status) ? value.status : "unknown",
        ...(value.note != null ? { note: clip(String(value.note), MAX_ITEM) } : {})
      };
    });
    return { results, issues };
  }
  const allowed = new Set(declared.map((item) => item.id));
  const byId = new Map();
  provided.forEach((item, index) => {
    const value = typeof item === "string" ? { note: item } : item || {};
    const id = String(value.id || declared[index]?.id || "");
    if (!allowed.has(id)) {
      issues.push(`Unknown acceptance criterion ${id || `(index ${index})`}.`);
      return;
    }
    if (byId.has(id)) {
      issues.push(`Duplicate acceptance result ${id}.`);
      return;
    }
    const status = ["met", "unmet", "unknown"].includes(value.status) ? value.status : "unknown";
    if (status === "unknown" && value.status !== "unknown") issues.push(`Acceptance result ${id} has invalid status ${String(value.status ?? "(missing)")}.`);
    byId.set(id, {
      id,
      status,
      ...(value.note != null ? { note: clip(String(value.note), MAX_ITEM) } : {})
    });
  });
  const results = declared.map((criterion) => {
    if (byId.has(criterion.id)) return byId.get(criterion.id);
    issues.push(`Missing acceptance result ${criterion.id}.`);
    return { id: criterion.id, status: "unknown", note: "Provider did not report this criterion." };
  });
  return { results, issues };
}

function parseStructuredWorkerPayload(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  const tryParse = (raw) => {
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
      }
    } catch {}
    return null;
  };
  const marker = trimmed.lastIndexOf("GROK_WORKER_REPORT:");
  if (marker >= 0) {
    const marked = extractFirstJsonObject(trimmed.slice(marker + "GROK_WORKER_REPORT:".length));
    const parsed = marked ? tryParse(marked) : null;
    if (parsed) return { value: parsed, markerPresent: true };
  }
  const direct = tryParse(trimmed);
  if (direct) return { value: direct, markerPresent: false };
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const nested = tryParse(fenced[1].trim());
    if (nested) return { value: nested, markerPresent: false };
  }
  let candidate = null;
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] !== "{") continue;
    const extracted = extractFirstJsonObject(trimmed.slice(index));
    const parsed = extracted ? tryParse(extracted) : null;
    if (parsed) candidate = parsed;
  }
  if (candidate) return { value: candidate, markerPresent: false };
  return null;
}

function extractFirstJsonObject(text) {
  const source = String(text || "");
  const start = source.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  return null;
}
