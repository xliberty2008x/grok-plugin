import { CompanionError, asErrorPayload } from "./errors.mjs";
import { redact, redactText } from "./redact.mjs";
import {
  assertContextManifestIntegrity,
  captureContextManifest
} from "./task-context-manifest.mjs";
import {
  buildRuntimeEvidence,
  observeChangedPaths
} from "./task-runtime-evidence.mjs";
import { contextIncompleteError } from "./task-context-metadata.mjs";
import { evaluateScope } from "./task-scope.mjs";

/**
 * Capture the authoritative task observation after runtime cleanup. Capture
 * failure is explicit safety evidence; it must never be interpreted as an
 * empty, drift-free workspace.
 */
export function captureTerminalEvidence(
  root,
  job,
  executionStatus,
  {
    captureContext = captureContextManifest,
    captureFailureKind = "contextCapture"
  } = {}
) {
  let preContext = null;
  try {
    preContext = assertContextManifestIntegrity(
      job.request?.contextManifest
    );
  } catch {
    return unavailableTerminalEvidence({
      preContext: null,
      executionStatus,
      failureKind: "manifestIntegrity"
    });
  }
  let captured;
  try {
    captured = captureContext(root);
  } catch {
    // A fresh host observation that cannot be taken is context incompleteness,
    // distinct from malformed stored authority or evidence assembly failure.
    return unavailableTerminalEvidence({
      preContext,
      executionStatus,
      failureKind: captureFailureKind === "evidenceAssembly"
        ? "evidenceAssembly"
        : "contextCapture"
    });
  }
  let postContext;
  try {
    postContext = assertContextManifestIntegrity(captured);
  } catch {
    return unavailableTerminalEvidence({
      preContext,
      executionStatus,
      failureKind: "manifestIntegrity"
    });
  }
  try {
    const changedPaths = observeChangedPaths(preContext, postContext);
    const scopeViolations = evaluateScope(
      changedPaths,
      job.request?.envelope?.scope
    ).filter((item) => item !== "[GIT_METADATA_INCOMPLETE]");
    return {
      postContext,
      changedPaths,
      scopeViolations,
      finalObservationUnavailable: false,
      finalObservationFailureKind: null,
      runtimeEvidence: buildRuntimeEvidence({
        preContext,
        postContext,
        changedPaths,
        commandOutcomes: job.commandOutcomes || [],
        scopeViolations,
        executionStatus
      })
    };
  } catch {
    return unavailableTerminalEvidence({
      preContext,
      executionStatus,
      failureKind: "evidenceAssembly"
    });
  }
}

function unavailableTerminalEvidence({
  preContext,
  failureKind
}) {
  const runtimeEvidence = buildRuntimeEvidence({
    preContext,
    postContext: null,
    changedPaths: [],
    commandOutcomes: [],
    scopeViolations: [],
    executionStatus: "failed"
  });
  if (failureKind === "contextCapture") {
    runtimeEvidence.metadataCompletenessObservation = {
      schemaVersion: 1,
      complete: false,
      metadataComponents: ["contextCapture"]
    };
  }
  return {
    postContext: null,
    changedPaths: [],
    scopeViolations: [],
    finalObservationUnavailable: true,
    finalObservationFailureKind: failureKind,
    runtimeEvidence
  };
}

function boundedPrivateSecondaryDiagnostic(error) {
  if (!error) return null;
  const payload = redact(asErrorPayload(error));
  return {
    code: String(payload.code || "E_PROVIDER_EXIT").slice(0, 64),
    message: redactText(
      payload.message || "Worker finalization failed."
    ).slice(0, 256)
  };
}

function explicitLegacySignalDiagnostic(error) {
  const rawCode = String(error?.code || "");
  const rawMessage = String(error?.message || "");
  const signalOperation = /\b(?:kill|signal(?:led|ling|ed|ing)?)\b/i.test(
    rawMessage
  );
  if (!signalOperation) return null;
  const messageCodes = [
    ...rawMessage.matchAll(/\bE(?!_)[A-Z][A-Z0-9_]{1,62}\b/g)
  ].map((match) => match[0].toUpperCase());
  const directCode = /^E(?!_)[A-Z0-9_]{1,63}$/.test(rawCode)
    && !rawCode.startsWith("E_")
    ? rawCode.toUpperCase()
    : null;
  const signalCode = [...messageCodes, directCode]
    .filter(Boolean)
    .findLast((code) => code !== "ESRCH") || null;
  if (!signalCode) return null;
  return boundedPrivateSecondaryDiagnostic({
    code: signalCode,
    message: rawMessage
  });
}

export function normalizeTerminalProcessSignalError(error) {
  if (!error) return null;
  if (error.code === "E_PROCESS_IDENTITY") {
    const diagnostic = error.details?.secondaryDiagnostic;
    const legacyDiagnostic = diagnostic
      ? null
      : explicitLegacySignalDiagnostic(error);
    return new CompanionError(
      error.code,
      error.message,
      diagnostic || legacyDiagnostic
        ? {
            ...error.details,
            secondaryDiagnostic:
              diagnostic
                ? boundedPrivateSecondaryDiagnostic(diagnostic)
                : legacyDiagnostic
          }
        : error.details
    );
  }
  const rawCode = String(error.code || "");
  const rawMessage = String(error.message || "");
  const signalOperation = /\b(?:kill|signal(?:led|ling|ed|ing)?)\b/i.test(
    rawMessage
  );
  const directRawSignalFailure = rawCode !== "ESRCH"
    && /^E(?!_)[A-Z0-9_]{1,63}$/.test(rawCode)
    && !rawCode.startsWith("E_")
    && signalOperation;
  const wrappedSignalDiagnostic = explicitLegacySignalDiagnostic(error);
  const wrappedRawSignalFailure = [
    "E_BROKER",
    "E_PROVIDER_EXIT",
    "E_STATE"
  ].includes(rawCode)
    && wrappedSignalDiagnostic !== null;
  if (!directRawSignalFailure && !wrappedRawSignalFailure) return error;
  const secondaryDiagnostic = wrappedRawSignalFailure
    ? wrappedSignalDiagnostic
    : boundedPrivateSecondaryDiagnostic(error);
  return new CompanionError(
    "E_PROCESS_IDENTITY",
    "Verified owned process signalling could not be completed.",
    {
      secondaryDiagnostic
    }
  );
}

const PROVEN_TERMINAL_SAFETY_CODES = new Set([
  "E_CONTEXT_DRIFT",
  "E_SCOPE_VIOLATION"
]);

export function preferProvenTerminalSafetyError(observedError, priorError) {
  return observedError?.code === "E_CONTEXT_INCOMPLETE"
    && PROVEN_TERMINAL_SAFETY_CODES.has(priorError?.code)
    ? priorError
    : observedError;
}

export function preferProvenTerminalSafetyPending(observedPending, priorPending) {
  const preservePriorProof = observedPending?.error?.code === "E_CONTEXT_INCOMPLETE"
    && PROVEN_TERMINAL_SAFETY_CODES.has(priorPending?.error?.code);
  const selectedError = preservePriorProof
    ? priorPending.error
    : observedPending?.error;
  if (!PROVEN_TERMINAL_SAFETY_CODES.has(selectedError?.code)) {
    return observedPending;
  }
  const phase = selectedError.code === "E_SCOPE_VIOLATION"
    ? "scope-rejected"
    : "context-rejected";
  if (!preservePriorProof
    && observedPending?.status === "failed"
    && observedPending.phase === phase) {
    return observedPending;
  }
  // Preserve only the proof. A corrupt or legacy prior envelope must never
  // carry a proven terminal safety failure through as completed/cancelled.
  return Object.freeze({
    ...observedPending,
    status: "failed",
    phase,
    error: selectedError,
    summary: selectedError.message || observedPending?.summary || null
  });
}

/**
 * Terminal precedence after exact runtime cleanup:
 * final context/scope safety > process signalling uncertainty > prior outcome.
 */
export function selectTaskTerminalError(
  evidence,
  priorError = null,
  cleanupError = null
) {
  const normalizedPriorError =
    normalizeTerminalProcessSignalError(priorError);
  const normalizedCleanupError =
    normalizeTerminalProcessSignalError(cleanupError);
  const processFailures = [
    normalizedPriorError,
    normalizedCleanupError
  ].filter((candidate) => (
    candidate?.code === "E_PROCESS_IDENTITY"
    // E_PROCESS_IDENTITY also represents ownership and liveness blockers.
    // Only this bounded secondary field proves a real non-ESRCH signal
    // operation and may therefore outrank the provider's terminal outcome.
    && candidate?.details?.secondaryDiagnostic != null
    && String(
      candidate.details.secondaryDiagnostic.code || ""
    ).toUpperCase() !== "ESRCH"
  ));
  const processFailure = processFailures[0] || null;
  if (evidence.finalObservationUnavailable) {
    const secondaryDiagnostic =
      processFailure?.details?.secondaryDiagnostic || null;
    if (evidence.finalObservationFailureKind === "contextCapture") {
      return preferProvenTerminalSafetyError(
        contextIncompleteError("terminal", ["contextCapture"]),
        normalizedPriorError
      );
    }
    return new CompanionError(
      "E_CONTEXT_DRIFT",
      "Final workspace context authority could not be validated after runtime cleanup; host review is required.",
      {
        reasons: ["[final-context-unavailable]"],
        ...(secondaryDiagnostic ? { secondaryDiagnostic } : {})
      }
    );
  }
  const changedPaths = evidence.changedPaths
    || evidence.runtimeEvidence?.observedChangedPaths
    || [];
  const scopeViolations = (evidence.scopeViolations
    || evidence.runtimeEvidence?.scopeViolations
    || []).filter((item) => item !== "[GIT_METADATA_INCOMPLETE]");
  const contextDrift = changedPaths.includes("[HEAD]")
    || changedPaths.includes("[GIT_METADATA]")
    || evidence.runtimeEvidence?.sharedRefObservation
      ?.taskRelevantMetadataDrift === true;
  const completeness = evidence.runtimeEvidence?.metadataCompletenessObservation;
  const contextIncomplete = changedPaths.includes("[GIT_METADATA_INCOMPLETE]")
    || completeness?.complete === false;
  if (!contextDrift && scopeViolations.length === 0 && !contextIncomplete) {
    if (processFailure) return processFailure;
    return normalizedPriorError;
  }
  const secondaryDiagnostic =
    processFailure?.details?.secondaryDiagnostic || null;
  if (contextIncomplete && !contextDrift && scopeViolations.length === 0) {
    return preferProvenTerminalSafetyError(
      contextIncompleteError(
        "terminal",
        completeness?.metadataComponents || ["gitMetadata"]
      ),
      normalizedPriorError
    );
  }
  const code = contextDrift ? "E_CONTEXT_DRIFT" : "E_SCOPE_VIOLATION";
  const message = contextDrift
    ? "Workspace execution context changed during the task; host review is required."
    : "Workspace changes were observed outside the delegated scope; host review is required.";
  return new CompanionError(code, message, {
    ...(contextDrift
      ? {
          reasons: changedPaths
            .filter((item) => [
              "[HEAD]",
              "[GIT_METADATA]"
            ].includes(item))
            .slice(0, 8)
        }
      : { paths: scopeViolations.slice(0, 64) }),
    ...(secondaryDiagnostic ? { secondaryDiagnostic } : {})
  });
}

export function terminalTaskProgress(status, error = null) {
  if (status === "completed") return "Task runtime cleanup completed";
  if (status === "cancelled") return "Cancellation completed";
  if (["E_CONTEXT_DRIFT", "E_CONTEXT_INCOMPLETE", "E_SCOPE_VIOLATION"].includes(error?.code)) {
    return "Task runtime cleanup completed; workspace safety review is required";
  }
  return "Worker finalization completed";
}
