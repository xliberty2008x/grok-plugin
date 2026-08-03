import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CompanionError, asErrorPayload } from "./errors.mjs";
import { integritySnapshot, assertUnchanged } from "./git-review.mjs";
import { grokVersion } from "./provider-core.mjs";
import { providerCleanupIdentity } from "./provider-process.mjs";
import { runProvider, runStructuredReview } from "./provider-headless-runtime.mjs";
import { profileFor } from "./profiles.mjs";
import { updateJob, readJob, terminal } from "./state.mjs";
import { redact, redactText } from "./redact.mjs";
import { appendLifecycleEvent } from "./task-lifecycle.mjs";
import { boundPathEvidence } from "./task-contract-primitives.mjs";
import { buildRuntimeEvidence, observeChangedPaths } from "./task-runtime-evidence.mjs";
import { buildWorkerReport, buildWorkerReportOutputSchema, composeWorkerReportRepairPrompt } from "./worker-report-contract.mjs";
import { captureContextManifest } from "./task-context-manifest.mjs";
import { evaluateScope } from "./task-scope.mjs";
import { authorizeWorkerProviderRotation } from "./worker-mutation-dispatch-transition.mjs";
import { isDispatchV2 } from "./worker-launch-contract.mjs";
import { attachHostActionRequestToJob } from "./worker-host-actions.mjs";
import { assertNoRetainedBodies, readAttemptMailbox } from "./worker-mailbox.mjs";
const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "grok-companion.mjs"
);
const PLUGIN_ROOT = path.resolve(path.dirname(SCRIPT), "..");
const VALID_EFFORTS = new Set(["low", "medium", "high"]);
import { boundedProviderText, eventUpdater, providerLaunchBinding, recordLifecycle, sessionId, settlePendingProviderRotationNoChild, textEvidence, touchJob } from "./companion-shared.mjs";

import { createMailboxAuthorities, createMailboxController, createPrimaryTurnController, createProviderRunOptions } from "./companion-task-turn.mjs";

function createProviderState(execution) {
  const { job, prompt, receiptBacked, dispatchAttemptId, providerGeneration } = execution;
  let providerLaunchAuthorization = null;
  const envelope = job.request?.envelope || null;
  const workerReportOutputSchema = job.jobClass === "task"
    ? buildWorkerReportOutputSchema(envelope?.acceptanceCriteria || [])
    : null;
  let expectedProviderLaunchBinding = providerLaunchBinding(
    job.profile,
    prompt,
    workerReportOutputSchema
  );
  const mailboxCapabilityDigest = job.request?.spawn?.providerCapabilityDigest;
  const mailboxEligible = Boolean(
    job.jobClass === "task"
    && receiptBacked
    && dispatchAttemptId
    && providerGeneration === 1
    && /^[a-f0-9]{64}$/.test(mailboxCapabilityDigest || "")
  );
  const primaryTurnEligible = Boolean(
    job.jobClass === "task"
    && receiptBacked
    && dispatchAttemptId
    && isDispatchV2(job.request?.spawn?.dispatch)
    && [1, 2].includes(providerGeneration)
  );
  return {
    providerLaunchAuthorization, envelope, workerReportOutputSchema,
    expectedProviderLaunchBinding, mailboxCapabilityDigest, mailboxEligible,
    primaryTurnEligible, providerGeneration, mailboxController: null
  };
}

async function runProviderAndRepairReport(execution, state, common) {
  const { root, id, job, before, dispatchAttemptId, dispatchFence } = execution;
  let result = job.jobClass === "review" && job.kind !== "stop-review"
    ? await runStructuredReview(common)
    : await runProvider(common);
  if (before) assertUnchanged(before, integritySnapshot(root));
  let workerReport = null;
  let reportRepair = null;
  let reportRepairError = null;
  if (job.jobClass !== "review") {
    workerReport = buildWorkerReport({
      providerText: result.text || "",
      ...(Object.hasOwn(result, "structuredOutput")
        ? { nativeStructuredOutput: result.structuredOutput }
        : {}),
      ...(Object.hasOwn(result, "structuredOutputError")
        ? { nativeStructuredOutputError: result.structuredOutputError }
        : {}),
      acceptanceCriteria: state.envelope?.acceptanceCriteria || []
    });
    if (result.mailboxEvidence) {
      const reportDigest = workerReport.valid
        ? (workerReport.reportSource === "acp-structured"
            ? workerReport.reportDigest
            : boundedProviderText(result.text || "").textDigest)
        : null;
      const selected = state.mailboxController.selectReport({
        sequence: result.mailboxEvidence.selectedSequence,
        valid: workerReport.valid,
        reportDigest
      });
      result = {
        ...result,
        mailboxEvidence: {
          ...result.mailboxEvidence,
          finalReportSequence: selected.finalReportSequence,
          finalReportDigest: selected.finalReportDigest,
          communicationChainDigest: selected.communicationChainDigest
        }
      };
    }
    if (!workerReport.valid && result.sessionId) {
      const initialResponse = textEvidence(result.text || "");
      recordLifecycle(root, id, "checkpoint", "Requesting one same-session report-format repair", {
        validationIssues: workerReport.validationIssues
      });
      let providerRotationIntentId = null;
      try {
        if (dispatchAttemptId) {
          const rotationAuthorization = authorizeWorkerProviderRotation({
            root,
            workerId: id,
            attemptId: dispatchAttemptId,
            workerProcess: job.workerProcess
          });
          state.providerGeneration = rotationAuthorization.providerGeneration;
          providerRotationIntentId = rotationAuthorization.intentId;
          state.providerLaunchAuthorization = Object.freeze({
            intentId: rotationAuthorization.intentId,
            providerGeneration: rotationAuthorization.providerGeneration
          });
        }
        const repairProfile = profileFor("report-repair");
        const repairPrompt = composeWorkerReportRepairPrompt(state.envelope, workerReport);
        state.expectedProviderLaunchBinding = providerLaunchBinding(
          repairProfile,
          repairPrompt,
          state.workerReportOutputSchema
        );
        const repaired = await runProvider({
          ...common,
          profile: repairProfile,
          prompt: repairPrompt,
          outputSchema: state.workerReportOutputSchema,
          resumeSessionId: result.sessionId,
          mailboxController: null,
          ...(dispatchAttemptId ? {
            guardBinding: {
              ...common.guardBinding,
              providerGeneration: state.providerGeneration
            },
            onEvent: eventUpdater(root, id, dispatchAttemptId, state.providerGeneration, dispatchFence)
          } : {})
        });
        const repairedReport = buildWorkerReport({
          providerText: repaired.text || "",
          ...(Object.hasOwn(repaired, "structuredOutput")
            ? { nativeStructuredOutput: repaired.structuredOutput }
            : {}),
          ...(Object.hasOwn(repaired, "structuredOutputError")
            ? { nativeStructuredOutputError: repaired.structuredOutputError }
            : {}),
          acceptanceCriteria: state.envelope?.acceptanceCriteria || []
        });
        reportRepair = {
          attempted: true,
          valid: repairedReport.valid,
          initialResponse,
          validationIssues: repairedReport.validationIssues
        };
        if (repairedReport.valid) {
          const priorMailboxEvidence = result.mailboxEvidence || null;
          const repairedMailboxSelection = priorMailboxEvidence
            ? state.mailboxController.selectRepairedReport({
                sequence: priorMailboxEvidence.selectedSequence,
                reportDigest: repairedReport.reportSource === "acp-structured"
                  ? repairedReport.reportDigest
                  : boundedProviderText(repaired.text || "").textDigest,
                sessionId: repaired.sessionId
              })
            : null;
          result = {
            ...repaired,
            ...(priorMailboxEvidence
              ? {
                  mailboxEvidence: {
                    ...priorMailboxEvidence,
                    finalReportSequence: repairedMailboxSelection.finalReportSequence,
                    finalReportDigest: repairedMailboxSelection.finalReportDigest,
                    communicationChainDigest:
                      repairedMailboxSelection.communicationChainDigest
                  }
                }
              : {})
          };
          workerReport = repairedReport;
        }
      } catch (repairError) {
        if (dispatchAttemptId
          && providerRotationIntentId
          && providerCleanupIdentity(repairError) == null) {
          settlePendingProviderRotationNoChild({
            root,
            workerId: id,
            attemptId: dispatchAttemptId,
            fence: dispatchFence,
            intentId: providerRotationIntentId
          });
        }
        if (repairError?.code === "E_CANCELLED") throw repairError;
        reportRepairError = repairError;
        reportRepair = {
          attempted: true,
          valid: false,
          initialResponse,
          error: redact(asErrorPayload(repairError))
        };
      }
    }
  }
  return { result, workerReport, reportRepair, reportRepairError };
}

function persistExecutionResult(execution, state, providerResult) {
  const {
    root, id, job, preContext, dispatchAttemptId, dispatchFence
  } = execution;
  const { result, workerReport, reportRepair, reportRepairError } = providerResult;
  const postContext = captureContextManifest(root);
  if (job.jobClass === "review" && result.review) {
    const safeResult = redact({
      review: result.review,
      stopReason: result.stopReason,
      hostVerification: "not_run",
      runtimeEvidence: buildRuntimeEvidence({
        preContext,
        postContext,
        changedPaths: observeChangedPaths(preContext, postContext),
        executionStatus: "completed"
      })
    });
    updateJob(root, id, (current) => terminal(current) ? current : touchJob(current, {
      phase: "finalizing",
      completionContextManifest: postContext,
      grokSessionId: result.sessionId,
      providerProcess: current.providerProcess || result.provider?.process || null,
      profile: { ...current.profile, grokVersion: result.provider?.version || null },
      result: safeResult,
      summary: `${safeResult.review.verdict}: ${safeResult.review.summary}`.slice(0, 160),
      progress: "Review finalized",
      lifecycleEvents: appendLifecycleEvent(current.lifecycleEvents, "final.report", "Review report ready", {
        verdict: safeResult.review.verdict,
        findings: safeResult.review.findings?.length ?? 0
      })
    }));
  } else {
    const observedChanged = observeChangedPaths(preContext, postContext);
    const scopeViolations = evaluateScope(observedChanged, state.envelope?.scope);
    const changedPathEvidence = boundPathEvidence(observedChanged);
    const scopeViolationEvidence = boundPathEvidence(scopeViolations, { marker: "[SCOPE_VIOLATIONS_OVERFLOW]" });
    const latestJob = readJob(root, id);
    const runtimeEvidence = buildRuntimeEvidence({
      preContext,
      postContext,
      changedPaths: observedChanged,
      diffSummary: changedPathEvidence.length ? changedPathEvidence.join("\n") : "No workspace changes observed.",
      commandOutcomes: latestJob.commandOutcomes || [],
      scopeViolations,
      executionStatus: "completed"
    });
    const claimedPaths = new Set(workerReport.changedFiles);
    const observedPaths = new Set(observedChanged.filter((item) => !String(item).startsWith("[")));
    const observedFileAgreement = claimedPaths.size === observedPaths.size
      && [...claimedPaths].every((item) => observedPaths.has(item));
    const storedText = boundedProviderText(result.text || "");
    const mailboxLifecycleValid = !result.mailboxEvidence || (
      result.mailboxEvidence.deliveryUnknown === false
      && result.mailboxEvidence.closed === true
      && result.mailboxEvidence.bodiesRetained === false
    );
    const selectedReportDigest = workerReport.reportSource === "acp-structured"
      ? workerReport.reportDigest
      : storedText.textDigest;
    const mailboxFinalReportBound = !result.mailboxEvidence || (
      Number.isSafeInteger(result.mailboxEvidence.selectedSequence)
      && result.mailboxEvidence.selectedSequence
        === result.mailboxEvidence.lastCompletedSequence
      && result.mailboxEvidence.finalReportSequence
        === result.mailboxEvidence.lastCompletedSequence
      && result.mailboxEvidence.finalReportDigest === selectedReportDigest
    );
    // Provider success is a claim only; hostVerification stays not_run.
    const safeResult = redact({
      ...storedText,
      interim: textEvidence(result.interimText || ""),
      ...(result.mailboxEvidence
        ? { mailboxEvidence: result.mailboxEvidence }
        : {}),
      ...(reportRepair ? { reportRepair } : {}),
      stopReason: result.stopReason,
      workerReport,
      providerClaims: {
        success: workerReport.valid
          && workerReport.outcome === "complete"
          && workerReport.acceptanceResults.every((entry) => entry.status === "met")
          && observedFileAgreement
          && mailboxLifecycleValid
          && mailboxFinalReportBound,
        outcome: workerReport.outcome,
        summary: workerReport.summary,
        changedFiles: workerReport.changedFiles,
        checksClaimed: workerReport.checksClaimed,
        observedFileAgreement
      },
      hostVerification: "not_run",
      runtimeEvidence
    });
    let finalTaskError = null;
    if (scopeViolations.length) {
      finalTaskError = new CompanionError(
        "E_SCOPE_VIOLATION",
        `Grok changed paths outside the delegated scope: ${scopeViolationEvidence.join(", ")}. Host review is required; changes were not rolled back.`,
        { paths: scopeViolationEvidence }
      );
    } else if (!mailboxLifecycleValid) {
      finalTaskError = new CompanionError(
        "E_DELIVERY",
        "Ordered mailbox delivery could not be proven complete without ambiguity."
      );
    } else if (reportRepairError) {
      finalTaskError = reportRepairError;
    } else if (!workerReport.valid) {
      finalTaskError = new CompanionError(
        "E_SCHEMA",
        "Grok did not return a valid final worker report after one same-session format-repair attempt.",
        {
          repairAttempted: Boolean(reportRepair?.attempted),
          attempts: reportRepair?.attempted ? 2 : 1,
          validationIssues: workerReport.validationIssues
        }
      );
    } else if (!mailboxFinalReportBound) {
      finalTaskError = new CompanionError(
        "E_STATE",
        "The final worker report is not bound to the last completed mailbox turn."
      );
    } else if (reportRepair?.valid
      && result.mailboxEvidence
      && workerReport.hostActionRequest) {
      finalTaskError = new CompanionError(
        "E_CAPABILITY",
        "Host actions cannot be requested by a report-format repair generation."
      );
    } else if (workerReport.hostActionRequest?.requestedRoleId === "implementer") {
      finalTaskError = new CompanionError(
        "E_CAPABILITY",
        "Implementer admission is disabled until Phase 3 isolated execution is available."
      );
    }
    const intendedTerminal = execution.terminalIntentFor(finalTaskError, finalTaskError?.message || workerReport.summary);
    try {
      updateJob(root, id, (current) => {
        if (terminal(current)) return current;
        const withHostAction = !finalTaskError && workerReport.hostActionRequest
          ? attachHostActionRequestToJob(current, {
            providerRequest: workerReport.hostActionRequest,
            dispatchAttemptId,
            dispatchFence,
            providerGeneration: state.providerGeneration,
            providerSessionId: result.sessionId,
            communicationChainDigest:
              safeResult.mailboxEvidence?.communicationChainDigest ?? null,
            finalReportDigest:
              safeResult.mailboxEvidence?.finalReportDigest ?? null
          })
          : current;
        return touchJob(withHostAction, {
          phase: "finalizing",
          completionContextManifest: postContext,
          grokSessionId: result.sessionId,
          providerProcess: withHostAction.providerProcess || result.provider?.process || null,
          profile: { ...withHostAction.profile, grokVersion: result.provider?.version || null },
          result: safeResult,
          summary: workerReport.summary.slice(0, 160),
          progress: "Final report ready",
          ...execution.terminalIntentPatch(withHostAction, intendedTerminal),
          lifecycleEvents: appendLifecycleEvent(
            workerReport.outcome === "blocked"
              ? appendLifecycleEvent(withHostAction.lifecycleEvents, "blocked", workerReport.summary, { questions: workerReport.questions })
              : withHostAction.lifecycleEvents,
            "final.report",
            "Worker report ready",
            { outcome: workerReport.outcome, structured: workerReport.structured, hostVerification: "not_run" }
          )
        });
      });
    } catch (finalizationError) {
      // A late binding failure must not inherit an already-cached successful
      // terminal intent.
      execution.resetTerminalIntent();
      throw finalizationError;
    }
    if (finalTaskError) throw finalTaskError;
  }
}

function recordExecutionFailure(execution, error) {
  const {
    root, id, preContext, dispatchAttemptId, exactBrokerWorkerIdentity
  } = execution;
  let brokerPreProviderFailure = false;
  const intendedTerminal = execution.terminalIntentFor(error, redactText(error.message));
  const failedProviderProcess = providerCleanupIdentity(error);
  const mailboxFailureEvidence = (() => {
    if (!dispatchAttemptId) return null;
    try {
      const attempt = readAttemptMailbox(root, id, dispatchAttemptId);
      if (!attempt) return null;
      return {
        schemaVersion: 1,
        attemptId: dispatchAttemptId,
        communicationChainDigest: attempt.communicationChainDigest,
        lastCompletedSequence: attempt.lastCompletedSequence,
        finalReportSequence: attempt.finalReportSequence,
        finalReportDigest: attempt.finalReportDigest,
        acceptedCount: attempt.acceptedCount,
        acceptedBytes: attempt.acceptedBytes,
        deliveryUnknown: attempt.deliveryUnknownSequence !== null,
        closed: attempt.state === "closed",
        bodiesRetained: (() => {
          try {
            assertNoRetainedBodies(root, id, dispatchAttemptId);
            return false;
          } catch {
            return true;
          }
        })()
      };
    } catch {
      return null;
    }
  })();
  const postContext = (() => {
    try { return captureContextManifest(root); } catch { return null; }
  })();
  updateJob(root, id, (current) => {
    if (terminal(current)) return current;
    const providerProcess = current.providerProcess || (
      !dispatchAttemptId || (typeof failedProviderProcess?.startToken === "string" && failedProviderProcess.startToken)
        ? failedProviderProcess || null
        : null
    );
    return touchJob(current, {
      phase: "finalizing",
      providerProcess,
      error: redact(asErrorPayload(error)),
      summary: redactText(error.message),
      progress: error.code === "E_CONTEXT_DRIFT" ? "Blocked: context drift" : "Finalizing failure",
      ...execution.terminalIntentPatch(current, intendedTerminal),
      result: {
        ...(current.result || {}),
        ...(mailboxFailureEvidence
          ? { mailboxEvidence: mailboxFailureEvidence }
          : {}),
        hostVerification: current.result?.hostVerification || "not_run",
        runtimeEvidence: buildRuntimeEvidence({
          preContext,
          postContext,
          changedPaths: postContext ? observeChangedPaths(preContext, postContext) : [],
          commandOutcomes: current.commandOutcomes || [],
          scopeViolations: error.code === "E_SCOPE_VIOLATION" ? error.details?.paths || [] : [],
          executionStatus: error.code === "E_CANCELLED" ? "cancelled" : "failed"
        })
      },
      completionContextManifest: postContext,
      lifecycleEvents: appendLifecycleEvent(
        current.lifecycleEvents,
        error.code === "E_CONTEXT_DRIFT" || error.code === "E_CANCELLED" ? "blocked" : "checkpoint",
        redactText(error.message)
      )
    });
  });
  if (dispatchAttemptId) {
    const current = readJob(root, id);
    brokerPreProviderFailure = !terminal(current)
      && current.request?.spawn?.dispatch?.attemptId === dispatchAttemptId
      && current.request?.spawn?.dispatch?.state === "worker-started"
      && exactBrokerWorkerIdentity(current.workerProcess);
  }
  return brokerPreProviderFailure;
}

async function runProviderExecution(execution, workerNonce) {
  const state = createProviderState(execution);
  const primaryTurnController = createPrimaryTurnController(execution, state, workerNonce);
  const authorities = createMailboxAuthorities(execution, state);
  const mailboxController = createMailboxController(execution, state, authorities);
  state.mailboxController = mailboxController;
  const common = createProviderRunOptions(execution, state, workerNonce, {
    primaryTurnController, mailboxController
  });
  const providerResult = await runProviderAndRepairReport(execution, state, common);
  persistExecutionResult(execution, state, providerResult);
}

export { recordExecutionFailure, runProviderExecution };
