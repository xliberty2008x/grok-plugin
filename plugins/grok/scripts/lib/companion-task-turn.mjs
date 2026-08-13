import crypto from "node:crypto";
import process from "node:process";
import { CompanionError } from "./errors.mjs";
import { readJob, isCancelRequested, terminal, now, withWorkspaceStateTransaction } from "./state.mjs";
import { composeProviderPrompt } from "./task-provider-prompt.mjs";
import { CONTEXT_BINDING_MODE, verifyJobEffectivePrompt } from "./worker-context.mjs";
import { prepareWorkerProviderSpawn, recordWorkerProviderSpawnNoChild } from "./worker-mutation-dispatch-admission.mjs";
import { assertDispatchContract } from "./worker-mutation-dispatch-contract.mjs";
import { createProviderGuardBindingForJob, isDispatchV2 } from "./worker-launch-contract.mjs";
import { assertNoRetainedBodies, composeMailboxTurnPrompt, contentDigestOf as mailboxContentDigest, drainWorkerMailbox, openAttemptMailbox, readAttemptMailbox, recordPrimaryTurn, selectFinalReportSequence, settleInterruptedAttempt, stableDigest as mailboxStableDigest } from "./worker-mailbox.mjs";
import { assertExecutableWorkerBinding, assertPromptProviderLaunchBinding, eventUpdater, primaryTurnAdmissionTestHooks, stateDir } from "./companion-shared.mjs";

function createPrimaryTurnController(execution, state, workerNonce) {
  const {
    root, id, dispatchAttemptId, dispatchFence, exactBrokerWorkerIdentity,
    providerExecutableBinding, job
  } = execution;
  const { primaryTurnEligible } = state;
  const primaryTurnProcessBinding = (identity, { provider = false } = {}) => ({
    pid: identity?.pid ?? null,
    startToken: identity?.startToken ?? null,
    processGroupId: identity?.processGroupId ?? null,
    commandMarker: identity?.commandMarker ?? null,
    dispatchAttemptId: identity?.dispatchAttemptId ?? null,
    dispatchFence: identity?.dispatchFence ?? null,
    ...(provider
      ? { providerGeneration: identity?.providerGeneration ?? null }
      : { nonce: identity?.nonce ?? null })
  });
  const assertPrimaryTurnAuthority = (current, {
    sessionId: expectedSessionId,
    providerProcess: expectedProviderProcess,
    prompt: effectivePrompt
  }) => {
    if (!current || terminal(current)) {
      throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    }
    assertDispatchContract(current);
    const dispatch = current.request?.spawn?.dispatch;
    const effectivePromptDigest = mailboxContentDigest(effectivePrompt);
    if (!isDispatchV2(dispatch)
      || dispatch.state !== "provider-started"
      || dispatch.attemptId !== dispatchAttemptId
      || dispatch.fence !== dispatchFence
      || dispatch.providerGeneration !== state.providerGeneration
      || !exactBrokerWorkerIdentity(current.workerProcess)
      || !state.expectedProviderLaunchBinding
      || effectivePromptDigest !== state.expectedProviderLaunchBinding.promptDigest
      || typeof expectedSessionId !== "string"
      || !expectedSessionId
      || current.grokSessionId !== expectedSessionId) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Primary turn authority changed before provider dispatch."
      );
    }
    if (providerExecutableBinding
      && (current.request?.spawn?.providerLaunchBindingDigest
          !== job.request?.spawn?.providerLaunchBindingDigest
        || current.request?.spawn?.providerLaunchBinding
          ?.executableIdentityDigest
          !== providerExecutableBinding.executableIdentityDigest)) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Primary turn provider executable binding changed before dispatch."
      );
    }
    const durableProvider = current.providerProcess;
    if (!durableProvider
      || durableProvider.commandMarker !== id
      || durableProvider.dispatchAttemptId !== dispatchAttemptId
      || durableProvider.dispatchFence !== dispatchFence
      || durableProvider.providerGeneration !== state.providerGeneration
      || !Number.isInteger(durableProvider.pid)
      || typeof durableProvider.startToken !== "string"
      || !durableProvider.startToken
      || durableProvider.pid !== expectedProviderProcess?.pid
      || durableProvider.startToken !== expectedProviderProcess?.startToken
      || durableProvider.processGroupId !== expectedProviderProcess?.processGroupId) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Primary turn provider identity changed before dispatch."
      );
    }
    return {
      current,
      effectivePromptDigest,
      workerProcess: primaryTurnProcessBinding(current.workerProcess),
      providerProcess: primaryTurnProcessBinding(durableProvider, { provider: true })
    };
  };
  const primaryTurnController = primaryTurnEligible
    ? Object.freeze({
        admit: ({
          sessionId: providerSessionId,
          providerProcess,
          prompt: effectivePrompt
        }) => withWorkspaceStateTransaction(root, (transaction) => {
          if (transaction.isCancelRequested(id, workerNonce)) {
            throw new CompanionError(
              "E_CANCELLED",
              "Grok job was cancelled before primary turn admission."
            );
          }
          const generationKey = String(state.providerGeneration);
          const updated = transaction.updateJob(id, (current) => {
            const authority = assertPrimaryTurnAuthority(current, {
              sessionId: providerSessionId,
              providerProcess,
              prompt: effectivePrompt
            });
            const existing = current.request?.spawn?.primaryTurnAdmissions;
            if (existing != null && (
              typeof existing !== "object"
              || Array.isArray(existing)
              || Object.keys(existing).some((key) => !["1", "2"].includes(key))
            )) {
              throw new CompanionError(
                "E_STATE",
                "Primary turn admission state is malformed."
              );
            }
            if (existing?.[generationKey]) {
              throw new CompanionError(
                "E_STATE",
                "Primary provider turn was already admitted and cannot be replayed."
              );
            }
            const admittedAt = now();
            const admission = {
              schemaVersion: 1,
              status: "admitted",
              admissionId: crypto.randomBytes(16).toString("hex"),
              dispatchAttemptId,
              dispatchFence,
              providerGeneration: state.providerGeneration,
              workerProcess: authority.workerProcess,
              providerProcess: authority.providerProcess,
              providerSessionId,
              promptDigest: authority.effectivePromptDigest,
              ...(providerExecutableBinding
                ? {
                    providerLaunchBindingDigest:
                      job.request.spawn.providerLaunchBindingDigest,
                    providerExecutableIdentityDigest:
                      providerExecutableBinding.executableIdentityDigest
                  }
                : {}),
              admittedAt,
              consumedAt: null
            };
            return {
              ...current,
              request: {
                ...current.request,
                spawn: {
                  ...current.request?.spawn,
                  primaryTurnAdmissions: {
                    ...(existing || {}),
                    [generationKey]: admission
                  }
                }
              },
              updatedAt: admittedAt
            };
          });
          return Object.freeze({
            ...updated.request.spawn.primaryTurnAdmissions[generationKey]
          });
        }),
        consume: ({
          admission,
          sessionId: providerSessionId,
          providerProcess,
          prompt: effectivePrompt
        }) => withWorkspaceStateTransaction(root, (transaction) => {
          if (transaction.isCancelRequested(id, workerNonce)) {
            throw new CompanionError(
              "E_CANCELLED",
              "Grok job was cancelled before primary turn consumption."
            );
          }
          const generationKey = String(state.providerGeneration);
          const updated = transaction.updateJob(id, (current) => {
            assertPrimaryTurnAuthority(current, {
              sessionId: providerSessionId,
              providerProcess,
              prompt: effectivePrompt
            });
            const stored = current.request?.spawn?.primaryTurnAdmissions?.[generationKey];
            if (!stored
              || stored.schemaVersion !== 1
              || stored.status !== "admitted"
              || stored.providerGeneration !== state.providerGeneration
              || stored.dispatchAttemptId !== dispatchAttemptId
              || stored.dispatchFence !== dispatchFence
              || mailboxStableDigest(stored) !== mailboxStableDigest(admission)) {
              throw new CompanionError(
                "E_PROCESS_IDENTITY",
                "Primary turn admission changed before exact consumption."
              );
            }
            const consumedAt = now();
            return {
              ...current,
              request: {
                ...current.request,
                spawn: {
                  ...current.request?.spawn,
                  primaryTurnAdmissions: {
                    ...current.request.spawn.primaryTurnAdmissions,
                    [generationKey]: {
                      ...stored,
                      status: "consumed",
                      consumedAt
                    }
                  }
                }
              },
              updatedAt: consumedAt
            };
          });
          return Object.freeze({
            ...updated.request.spawn.primaryTurnAdmissions[generationKey]
          });
        })
      })
    : null;
  return primaryTurnController;
}

function createMailboxAuthorities(execution, state) {
  const { root, id, dispatchAttemptId, dispatchFence, exactBrokerWorkerIdentity } = execution;
  const mailboxAuthority = (transaction, {
    sessionId: expectedSessionId = null,
    providerProcess: expectedProviderProcess = null
  } = {}) => {
    const current = transaction.tryReadJob(id);
    if (!current || terminal(current)) {
      throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    }
    assertDispatchContract(current);
    const dispatch = current.request?.spawn?.dispatch;
    if (!isDispatchV2(dispatch)
      || dispatch.state !== "provider-started"
      || dispatch.attemptId !== dispatchAttemptId
      || dispatch.fence !== dispatchFence
      || dispatch.providerGeneration !== 1
      || !exactBrokerWorkerIdentity(current.workerProcess)
      || current.request?.spawn?.providerCapabilityDigest !== state.mailboxCapabilityDigest) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Mailbox authority changed from the exact primary provider attempt."
      );
    }
    const durableProvider = current.providerProcess;
    if (!durableProvider
      || durableProvider.commandMarker !== id
      || durableProvider.dispatchAttemptId !== dispatchAttemptId
      || durableProvider.dispatchFence !== dispatchFence
      || durableProvider.providerGeneration !== 1
      || !Number.isInteger(durableProvider.pid)
      || typeof durableProvider.startToken !== "string"
      || !durableProvider.startToken) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Mailbox provider identity is incomplete."
      );
    }
    if (expectedProviderProcess && (
      durableProvider.pid !== expectedProviderProcess.pid
      || durableProvider.startToken !== expectedProviderProcess.startToken
      || durableProvider.processGroupId !== expectedProviderProcess.processGroupId
    )) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Mailbox provider identity changed before opening."
      );
    }
    if (expectedSessionId !== null && current.grokSessionId !== expectedSessionId) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Mailbox provider session changed before opening."
      );
    }
    if (!current.request?.contextReceipt
      || !/^[a-f0-9]{64}$/.test(current.request?.runtimeRolePolicy?.digest || "")) {
      throw new CompanionError(
        "E_CONTEXT_DRIFT",
        "Mailbox context receipt or role policy is unavailable."
      );
    }
    return current;
  };
  const reportRepairMailboxAuthority = (transaction, {
    sessionId: expectedSessionId
  }) => {
    const current = transaction.tryReadJob(id);
    if (!current || terminal(current)) {
      throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    }
    assertDispatchContract(current);
    const dispatch = current.request?.spawn?.dispatch;
    if (!isDispatchV2(dispatch)
      || dispatch.state !== "provider-started"
      || dispatch.attemptId !== dispatchAttemptId
      || dispatch.fence !== dispatchFence
      || state.providerGeneration !== 2
      || dispatch.providerGeneration !== 2
      || dispatch.nextProviderGeneration !== null
      || dispatch.providerRotationCount !== 1
      || !dispatch.providerRotatedAt
      || !exactBrokerWorkerIdentity(current.workerProcess)
      || current.request?.spawn?.providerCapabilityDigest !== state.mailboxCapabilityDigest) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Report-repair authority changed from the exact provider rotation."
      );
    }
    const durableProvider = current.providerProcess;
    if (!durableProvider
      || durableProvider.commandMarker !== id
      || durableProvider.dispatchAttemptId !== dispatchAttemptId
      || durableProvider.dispatchFence !== dispatchFence
      || durableProvider.providerGeneration !== 2
      || !Number.isInteger(durableProvider.pid)
      || typeof durableProvider.startToken !== "string"
      || !durableProvider.startToken
      || typeof expectedSessionId !== "string"
      || !expectedSessionId
      || current.grokSessionId !== expectedSessionId) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Report-repair provider identity or session is incomplete."
      );
    }
    const attempt = readAttemptMailbox(root, id, dispatchAttemptId);
    if (!attempt
      || attempt.state !== "closed"
      || attempt.dispatchFence !== dispatchFence
      || attempt.providerGeneration !== 1
      || attempt.workerProcessDigest !== mailboxStableDigest(current.workerProcess)
      || attempt.providerSessionDigest !== mailboxStableDigest({
        providerSessionId: expectedSessionId
      })
      || attempt.providerCapabilityDigest !== state.mailboxCapabilityDigest
      || attempt.contextReceiptDigest
        !== mailboxStableDigest(current.request?.contextReceipt)
      || attempt.rolePolicyDigest
        !== current.request?.runtimeRolePolicy?.digest) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Closed mailbox binding changed before report-repair selection."
      );
    }
    assertNoRetainedBodies(root, id, dispatchAttemptId);
    return current;
  };
  return { mailboxAuthority, reportRepairMailboxAuthority };
}

function createMailboxController(execution, state, authorities) {
  const { root, id, dispatchAttemptId, dispatchFence } = execution;
  const { mailboxEligible, mailboxCapabilityDigest, workerReportOutputSchema } = state;
  const { mailboxAuthority, reportRepairMailboxAuthority } = authorities;
  const mailboxController = mailboxEligible
    ? Object.freeze({
        open: ({ sessionId: providerSessionId, providerProcess, providerCapabilities }) => (
          withWorkspaceStateTransaction(root, (transaction) => {
            if (providerCapabilities?.protocolVersion !== 1
              || providerCapabilities?.agentCapabilities?.loadSession !== true) {
              throw new CompanionError(
                "E_CAPABILITY",
                "Provider did not retain the required ACP mailbox capability."
              );
            }
            const current = mailboxAuthority(transaction, {
              sessionId: providerSessionId,
              providerProcess
            });
            return openAttemptMailbox(root, {
              workerId: id,
              dispatchAttemptId,
              dispatchFence,
              workerProcessDigest: mailboxStableDigest(current.workerProcess),
              providerProcessDigest: mailboxStableDigest(current.providerProcess),
              providerGeneration: 1,
              providerSessionDigest: mailboxStableDigest({
                providerSessionId
              }),
              providerCapabilityDigest: mailboxCapabilityDigest,
              contextReceiptDigest: mailboxStableDigest(current.request.contextReceipt),
              rolePolicyDigest: current.request.runtimeRolePolicy.digest
            });
          })
        ),
        recordPrimary: ({ attempt, prompt: effectivePrompt }) => (
          withWorkspaceStateTransaction(root, (transaction) => {
            const current = mailboxAuthority(transaction);
            const promptDigest = mailboxContentDigest(effectivePrompt);
            if (current.request?.providerPromptDigest !== promptDigest
              || attempt?.dispatchAttemptId !== dispatchAttemptId) {
              throw new CompanionError(
                "E_AUTH_REQUIRED",
                "Primary mailbox turn no longer matches the authorized prompt."
              );
            }
            return recordPrimaryTurn(root, id, dispatchAttemptId, {
              contentDigest: promptDigest,
              composedPromptDigest: promptDigest,
              pumpOwnerDigest: attempt.pumpOwnerDigest
            });
          })
        ),
        drain: async ({
          attempt,
          client,
          sessionId: providerSessionId,
          collectTurnText,
          timeoutMs,
          cancelRequested
        }) => {
          const drained = await drainWorkerMailbox({
            root,
            workerId: id,
            attemptId: dispatchAttemptId,
            client,
            sessionId: providerSessionId,
            composePrompt: ({ message, sequence }) => composeMailboxTurnPrompt(message, {
              sequence,
              workerId: id
            }),
            collectTurnText,
            outputSchema: workerReportOutputSchema,
            timeoutMs,
            cancelRequested,
            validateAuthority: (transaction) => {
              const current = mailboxAuthority(transaction, {
                sessionId: providerSessionId
              });
              const currentAttempt = readAttemptMailbox(
                root,
                id,
                dispatchAttemptId
              );
              if (!currentAttempt
                || currentAttempt.pumpOwnerDigest !== attempt.pumpOwnerDigest
                || currentAttempt.workerProcessDigest
                  !== mailboxStableDigest(current.workerProcess)
                || currentAttempt.providerProcessDigest
                  !== mailboxStableDigest(current.providerProcess)) {
                throw new CompanionError(
                  "E_PROCESS_IDENTITY",
                  "Mailbox attempt binding changed while pumping."
                );
              }
            }
          });
          return {
            ...drained,
            bodiesRetained: !assertNoRetainedBodies(
              root,
              id,
              dispatchAttemptId
            )
          };
        },
        interrupt: ({ attempt, reason }) => withWorkspaceStateTransaction(
          root,
          (transaction) => {
            mailboxAuthority(transaction);
            const currentAttempt = readAttemptMailbox(root, id, dispatchAttemptId);
            if (!currentAttempt
              || currentAttempt.pumpOwnerDigest !== attempt.pumpOwnerDigest) {
              throw new CompanionError(
                "E_PROCESS_IDENTITY",
                "Mailbox attempt changed before interruption settlement."
              );
            }
            return settleInterruptedAttempt(
              root,
              id,
              dispatchAttemptId,
              { reason }
            );
          }
        ),
        selectReport: ({ sequence, valid, reportDigest }) => (
          withWorkspaceStateTransaction(root, (transaction) => {
            mailboxAuthority(transaction);
            return selectFinalReportSequence(root, id, dispatchAttemptId, {
              sequence,
              valid,
              reportDigest
            });
          })
        ),
        selectRepairedReport: ({
          sequence,
          reportDigest,
          sessionId: providerSessionId
        }) => (
          withWorkspaceStateTransaction(root, (transaction) => {
            reportRepairMailboxAuthority(transaction, {
              sessionId: providerSessionId
            });
            return selectFinalReportSequence(root, id, dispatchAttemptId, {
              sequence,
              valid: true,
              reportDigest
            });
          })
        )
      })
    : null;
  return mailboxController;
}

function createProviderRunOptions(execution, state, workerNonce, controllers) {
  const {
    root, id, job, prompt, dispatchAttemptId, dispatchFence,
    providerExecutableBinding, receiptBacked
  } = execution;
  const { primaryTurnEligible, workerReportOutputSchema } = state;
  const { primaryTurnController, mailboxController } = controllers;
  const primaryTurnTestHooks = primaryTurnEligible
    ? primaryTurnAdmissionTestHooks()
    : null;
  const common = {
    root,
    profile: job.profile,
    prompt,
    model: job.model,
    effort: job.effort,
    stateDir: stateDir(root),
    jobMarker: id,
    providerHomeId: job.request?.providerHomeId || id,
    resumeSessionId: job.request?.resumeSessionId || null,
    cancelRequested: () => isCancelRequested(root, id, workerNonce),
    ...(dispatchAttemptId ? {
      guardBinding: createProviderGuardBindingForJob(job, {
        dispatchAttemptId,
        dispatchFence,
        providerGeneration: state.providerGeneration
      }),
      providerLaunch: {
        prepare: (observedLaunchBinding) => {
          const latest = readJob(root, id);
          assertExecutableWorkerBinding(latest, {
            dispatchAttemptId,
            dispatchFence,
            providerGeneration: state.providerGeneration
          });
          assertPromptProviderLaunchBinding(
            observedLaunchBinding,
            state.expectedProviderLaunchBinding,
            providerExecutableBinding
          );
          if (state.providerGeneration === 1
            && latest.request?.contextBindingMode === CONTEXT_BINDING_MODE) {
            const verified = verifyJobEffectivePrompt(latest, {
              root,
              contextManifest: latest.request?.contextManifest || null,
              composeLegacyProviderPrompt: composeProviderPrompt
            });
            if (verified.digest !== observedLaunchBinding.promptDigest
              || verified.prompt !== prompt) {
              throw new CompanionError(
                "E_AUTH_REQUIRED",
                "Provider prompt changed before provider launch preparation."
              );
            }
          }
          const authorization = state.providerLaunchAuthorization;
          state.providerLaunchAuthorization = null;
          const candidate = prepareWorkerProviderSpawn({
            root,
            workerId: id,
            attemptId: dispatchAttemptId,
            fence: dispatchFence,
            providerGeneration: state.providerGeneration
          });
          if (candidate?.prepared === true) return candidate;
          if (authorization
            && candidate?.reason === "already-pending"
            && candidate?.intent?.status === "pending"
            && candidate.intent.intentId === authorization.intentId
            && candidate.intent.providerGeneration === authorization.providerGeneration) {
            return Object.freeze({
              ...candidate,
              prepared: true,
              reason: "preauthorized-rotation"
            });
          }
          return candidate;
        },
        noChild: ({ intentId, resolution }) => recordWorkerProviderSpawnNoChild({
          root,
          workerId: id,
          attemptId: dispatchAttemptId,
          fence: dispatchFence,
          providerGeneration: state.providerGeneration,
          intentId,
          resolution
        })
      }
    } : {}),
    ...(providerExecutableBinding
      ? {
          providerExecutableBinding,
          providerExecutableEnv: process.env
        }
      : {}),
    ...(primaryTurnController ? { primaryTurnController } : {}),
    ...(mailboxController ? { mailboxController } : {}),
    ...(workerReportOutputSchema
      ? { outputSchema: workerReportOutputSchema }
      : {}),
    ...(primaryTurnTestHooks ? { testHooks: primaryTurnTestHooks } : {}),
    onEvent: eventUpdater(root, id, dispatchAttemptId, state.providerGeneration, dispatchFence)
  };
  return common;
}

export {
  createMailboxAuthorities,
  createMailboxController,
  createPrimaryTurnController,
  createProviderRunOptions
};
