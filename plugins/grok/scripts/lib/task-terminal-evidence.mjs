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
  { captureContext = captureContextManifest } = {}
) {
  let preContext = null;
  try {
    // Both comparison sides are terminal authority. Missing authority is not
    // equivalent to an empty or drift-free observation.
    preContext = assertContextManifestIntegrity(
      job.request?.contextManifest
    );
    const postContext = assertContextManifestIntegrity(
      captureContext(root)
    );
    const changedPaths = observeChangedPaths(preContext, postContext);
    const scopeViolations = evaluateScope(
      changedPaths,
      job.request?.envelope?.scope
    );
    return {
      postContext,
      changedPaths,
      scopeViolations,
      finalObservationUnavailable: false,
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
    // Exact cleanup has already completed at every call site. Any failure in
    // stored-context validation, fresh capture, comparison, scope evaluation,
    // or evidence assembly must therefore publish one bounded fail-closed
    // terminal observation rather than leaving the task active.
    return {
      postContext: null,
      changedPaths: [],
      scopeViolations: [],
      finalObservationUnavailable: true,
      runtimeEvidence: buildRuntimeEvidence({
        preContext,
        postContext: null,
        changedPaths: [],
        commandOutcomes: [],
        scopeViolations: [],
        executionStatus: "failed"
      })
    };
  }
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
    return new CompanionError(
      "E_CONTEXT_DRIFT",
      "Final workspace context could not be observed after runtime cleanup; host review is required.",
      {
        reasons: ["[final-context-unavailable]"],
        ...(secondaryDiagnostic ? { secondaryDiagnostic } : {})
      }
    );
  }
  const changedPaths = evidence.changedPaths
    || evidence.runtimeEvidence?.observedChangedPaths
    || [];
  const scopeViolations = evidence.scopeViolations
    || evidence.runtimeEvidence?.scopeViolations
    || [];
  const contextDrift = changedPaths.includes("[HEAD]")
    || changedPaths.includes("[GIT_METADATA]")
    || evidence.runtimeEvidence?.sharedRefObservation
      ?.taskRelevantMetadataDrift === true;
  if (!contextDrift && scopeViolations.length === 0) {
    if (processFailure) return processFailure;
    return normalizedPriorError;
  }
  const code = contextDrift ? "E_CONTEXT_DRIFT" : "E_SCOPE_VIOLATION";
  const message = contextDrift
    ? "Workspace execution context changed during the task; host review is required."
    : "Workspace changes were observed outside the delegated scope; host review is required.";
  const secondaryDiagnostic =
    processFailure?.details?.secondaryDiagnostic || null;
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
  if (["E_CONTEXT_DRIFT", "E_SCOPE_VIOLATION"].includes(error?.code)) {
    return "Task runtime cleanup completed; workspace safety review is required";
  }
  return "Worker finalization completed";
}
