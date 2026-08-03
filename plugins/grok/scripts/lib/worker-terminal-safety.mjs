import { now } from "./state.mjs";
import { assertContextManifestIntegrity } from "./task-context-manifest.mjs";
import { boundPathEvidence } from "./task-contract-primitives.mjs";
import { buildRuntimeEvidence } from "./task-runtime-evidence.mjs";

/** Project one already-classified final safety failure into durable terminal evidence. */
export function knownManagedWriteSafetyTerminalObservation(job, error) {
  if (!["E_CONTEXT_DRIFT", "E_CONTEXT_INCOMPLETE", "E_SCOPE_VIOLATION"].includes(error?.code)) {
    return null;
  }
  let preContext = null;
  try {
    preContext = assertContextManifestIntegrity(job.request?.contextManifest);
  } catch {
    // The independently classified final safety error remains authoritative.
  }
  const contextMarkers = () => {
    const reasons = Array.isArray(error.details?.reasons)
      ? error.details.reasons.map((item) => String(item))
      : [];
    const markers = [];
    if (reasons.some((reason) => ["head", "branch"].includes(reason))) {
      markers.push("[HEAD]");
    }
    if (reasons.some((reason) => [
      "taskRelevantMetadataIdentity",
      "metadataIdentity",
      "upstreamRef",
      "upstreamCommit"
    ].includes(reason))) {
      markers.push("[GIT_METADATA]");
    }
    if (reasons.some((reason) => [
      "trackedTreeIdentity",
      "dirtyDigest",
      "ignoredDigest"
    ].includes(reason))) {
      markers.push("[INDEX]");
    }
    if (reasons.includes("projectMarkers")) markers.push("[PROJECT_MARKERS]");
    if (markers.length === 0) {
      if (/\b(?:HEAD|branch)\b/i.test(error.message || "")) markers.push("[HEAD]");
      else if (/\bindex\b/i.test(error.message || "")) markers.push("[INDEX]");
      else markers.push("[CONTEXT_DRIFT]");
    }
    return [...new Set(markers)].slice(0, 8);
  };
  const scopePaths = () => {
    const provided = Array.isArray(error.details?.paths)
      ? boundPathEvidence(error.details.paths, {
          max: 64,
          marker: "[SCOPE_VIOLATIONS_OVERFLOW]"
        })
      : [];
    if (provided.length > 0) return provided;
    return [/\bindex\b/i.test(error.message || "") ? "[INDEX]" : "[SCOPE_VIOLATION]"];
  };
  const code = error.code;
  const observedChangedPaths = code === "E_CONTEXT_DRIFT"
    ? contextMarkers()
    : code === "E_CONTEXT_INCOMPLETE"
      ? ["[GIT_METADATA_INCOMPLETE]"]
      : scopePaths();
  const scopeViolations = code === "E_SCOPE_VIOLATION" ? observedChangedPaths : [];
  const details = code === "E_CONTEXT_DRIFT"
    ? { reasons: Object.freeze(observedChangedPaths) }
    : code === "E_CONTEXT_INCOMPLETE"
      ? {
          contextPhase: "terminal",
          metadataComponents: Object.freeze(
            Array.isArray(error.details?.metadataComponents)
              ? [...new Set(error.details.metadataComponents)]
              : ["gitMetadata"]
          )
        }
      : { paths: Object.freeze(scopeViolations) };
  const completedAt = now();
  const message = code === "E_CONTEXT_DRIFT"
    ? "Final managed-write context drift was observed after runtime cleanup."
    : code === "E_CONTEXT_INCOMPLETE"
      ? "Final managed-write context could not be observed completely after runtime cleanup."
      : "Final managed-write scope violation was observed after runtime cleanup.";
  const runtimeEvidence = buildRuntimeEvidence({
    preContext,
    postContext: null,
    changedPaths: observedChangedPaths,
    commandOutcomes: job.commandOutcomes || [],
    scopeViolations,
    executionStatus: "failed"
  });
  if (code === "E_CONTEXT_INCOMPLETE") {
    runtimeEvidence.metadataCompletenessObservation = {
      schemaVersion: 1,
      complete: false,
      metadataComponents: [...details.metadataComponents]
    };
  }
  return Object.freeze({
    pending: Object.freeze({
      status: "failed",
      phase: ["E_CONTEXT_DRIFT", "E_CONTEXT_INCOMPLETE"].includes(code)
        ? "context-rejected"
        : "scope-rejected",
      completedAt,
      error: Object.freeze({ code, message, details: Object.freeze(details) }),
      summary: message
    }),
    job: {
      ...job,
      completionContextManifest: null,
      result: {
        ...(job.result || {}),
        runtimeEvidence,
        hostVerification: "not_run"
      }
    }
  });
}
