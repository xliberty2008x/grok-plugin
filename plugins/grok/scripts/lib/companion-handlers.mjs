import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "./args.mjs";
import { CompanionError, asErrorPayload } from "./errors.mjs";
import { assertWorkingTreeTargetBound, collectContext, resolveTarget } from "./git-review.mjs";
import { probe } from "./provider-sessions.mjs";
import { profileFor, sameSecurityProfile } from "./profiles.mjs";
import { clearProviderCapabilityReceipt, writeProviderCapabilityReceipt } from "./provider-capability.mjs";
import { publishProviderExecutablePin } from "./provider-executable-pin.mjs";
import { config, setConfig, generateId, writeJob, updateJob, listJobs, readJob, terminal, now, withWorkspaceAdmission } from "./state.mjs";
import { workspaceRoot } from "./workspace.mjs";
import { readBoundedStdin } from "./stdin.mjs";
import { hostCommand, sameHostSession } from "./host.mjs";
import { appendLifecycleEvent } from "./task-lifecycle.mjs";
import { assertContextCompatible, assertContextManifestIntegrity, assertTaskContextReady, captureContextManifest } from "./task-context-manifest.mjs";
import { bindContextMetadataCompleteness } from "./task-context-metadata.mjs";
import { contextCaptureOptions } from "./task-context-worktree.mjs";

const { assertContextMetadataComplete, captureCompleteContextManifest } = bindContextMetadataCompleteness({
  captureContextManifest,
  assertContextManifestIntegrity
});
import { boundPathEvidence } from "./task-contract-primitives.mjs";
import { bindTaskEnvelopeContext, buildTaskEnvelope, parseTaskEnvelopeInput } from "./task-envelope.mjs";
import { composeProviderPrompt } from "./task-provider-prompt.mjs";
import { evaluateScope } from "./task-scope.mjs";
import { observeChangedPaths, publishedVerificationChangedPaths } from "./task-runtime-evidence.mjs";
import { projectWorkerHandle } from "./worker-protocol.mjs";
import { argvFrom, assertHostJobAccess, baseRecord, currentHost, loadTemplate, out, parseVerificationRecord, publicJson, readPrivateEnvelopeFile, renderJob, renderReview, stateDir, stdinReadySignal, touchJob, validateModelEffort } from "./companion-shared.mjs";

import { recoverActiveJobs } from "./companion-recovery.mjs";
import { startJob } from "./companion-dispatch.mjs";

async function handleSetup(raw) {
  const { options } = parseArgs(argvFrom(raw), { booleans: ["json", "enable-review-gate", "disable-review-gate"], values: ["cwd"] });
  if (options["enable-review-gate"] && options["disable-review-gate"]) throw new CompanionError("E_USAGE", "Choose only one review-gate option.");
  const root = workspaceRoot(options.cwd ? path.resolve(options.cwd) : process.cwd(), false);
  if (options["disable-review-gate"]) setConfig(root, { stopReviewGate: false });
  let runtime;
  try {
    // A setup attempt revokes any older readiness assertion before probing.
    // A crash or failed probe therefore cannot leave stale spawn capability.
    clearProviderCapabilityReceipt();
    const pinned = publishProviderExecutablePin();
    const probed = await probe(root, stateDir(root), {
      providerExecutableBinding: pinned.binding
    });
    writeProviderCapabilityReceipt({
      runtime: probed,
      providerLaunchBinding: pinned.binding
    });
    // The setup response is public; the private pin path stays internal.
    const { binary: _privatePinnedBinary, ...publicRuntime } = probed;
    runtime = {
      ...publicRuntime,
      releaseRecognition: pinned.releaseRecognition
    };
  } catch (error) {
    try { clearProviderCapabilityReceipt(); } catch {}
    runtime = { ready: false, error: asErrorPayload(error) };
  }
  if (options["enable-review-gate"] && !runtime.error) setConfig(root, { stopReviewGate: true });
  const storageReadonlyNextStep = currentHost().kind === "codex"
    ? `If this setup was started from managed Codex without the one-time command approval requested by ${hostCommand("setup")}, retry through that approval; it is command-scoped unsandboxed execution, not an exact-path grant. If the approved setup still fails, verify that the user-owned plugin data directory is on writable media and supports private mode 0700 directories and 0600 files.`
    : "Verify that the user-owned plugin data directory is on writable media and supports private mode 0700 directories and 0600 files.";
  const nextSteps = !runtime.error
    ? [`Run ${hostCommand("review", "--wait")} or ${hostCommand("rescue", "<task>")}.`]
    : runtime.error.code === "E_GROK_NOT_FOUND"
      ? ["Install with `npm install -g @xai-official/grok`, then retry."]
      : runtime.error.code === "E_AUTH_REQUIRED"
        ? ["Authenticate with `grok login`, then retry."]
        : runtime.error.code === "E_GROK_SOURCE"
          ? ["Use the active Grok-managed installation; arbitrary unfamiliar `GROK_BIN` or `PATH` executables are not accepted."]
          : runtime.error.code === "E_GROK_VERSION"
            ? ["Activate a stable Grok version 0.2.99 or newer; malformed and prerelease versions are not admitted."]
            : runtime.error.code === "E_PROCESS_IDENTITY"
              ? ["Restore the active managed link and executable bytes to a stable state, then retry setup."]
              : runtime.error.code === "E_CAPABILITY"
                ? ["The exact pinned Grok binary is present but did not satisfy a required runtime capability; review the reported probe failure."]
                : runtime.error.code === "E_STORAGE_READONLY"
                  ? [storageReadonlyNextStep]
                  : ["Review the reported prerequisite or platform limitation before retrying."];
  const result = { ready: !runtime.error, grok: runtime, config: config(root), disclosure: "Grok/xAI may process task prompts, selected repository content, provider-tool output, and imported Claude Code or privacy-filtered Codex transcript context. Each task lineage uses a private Grok home under this workspace's plugin state; its sanitized cached credential is removed before the task prompt is sent, while provider session data may remain for explicit resume. Imported sessions remain under ~/.grok/sessions. Each headless review uses a private per-job home and removes it on completion or verified crash recovery.", nextSteps };
  out(options.json ? result : [`Grok Companion: ${result.ready ? "ready" : "not ready"}`, result.disclosure, ...(result.grok.version ? [`Grok ${result.grok.version}; ACP v${result.grok.protocolVersion}`, `Models: ${result.grok.models.map((x) => x.id).join(", ")}`] : [result.grok.error?.message]), `Stop gate: ${result.config.stopReviewGate ? "enabled" : "disabled"}`, ...result.nextSteps].join("\n"), options.json);
}

async function handleReview(command, raw) {
  const { options, positionals } = parseArgs(argvFrom(raw), { values: ["base", "scope", "cwd"], booleans: ["wait", "background", "json"] });
  if (command === "review" && positionals.length) throw new CompanionError("E_USAGE", `Use ${hostCommand("adversarial-review")} for custom focus text.`);
  if (options.wait && options.background) throw new CompanionError("E_USAGE", "Choose --wait or --background.");
  const root = workspaceRoot(options.cwd ? path.resolve(options.cwd) : process.cwd());
  const target = resolveTarget(root, { scope: options.scope || "auto", base: options.base || null });
  const context = assertWorkingTreeTargetBound(collectContext(root, target));
  const kind = command;
  const prompt = loadTemplate(command === "review" ? "review" : "adversarial-review", { TARGET_LABEL: context.target.label, REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance, REVIEW_INPUT: context.content, USER_FOCUS: positionals.join(" ") || "No extra focus provided." });
  const id = generateId(kind), profile = profileFor(kind);
  const job = baseRecord({
    id,
    kind,
    root,
    profile,
    title: `${kind}: ${target.label}`,
    request: { prompt, target: { ...target, changedPaths: context.changedPaths || [] } },
    write: false
  });
  if (context.empty) {
    job.status = "completed"; job.phase = "done"; job.startedAt = job.createdAt; job.completedAt = now(); job.summary = "pass: no changes in the selected review target"; job.request = { target, prompt: null };
    // Empty targets never invoke Grok; do not claim a provider session was deleted.
    job.result = {
      review: { verdict: "pass", summary: "No changes in the selected review target.", findings: [] },
      providerSessionDeleted: false,
      skipped: true,
      skipReason: "empty-target"
    };
    writeJob(root, job);
    out(options.json ? publicJson(job) : renderReview(job), options.json);
    return;
  }
  const finished = await startJob(root, job, Boolean(options.background));
  out(options.json ? publicJson(finished) : options.background ? `Grok ${kind} started in the background.\nJob: ${id}\nCheck: ${hostCommand("status", id)}` : renderReview(finished), options.json);
}

function resumeCandidate(root, profile) {
  const host = currentHost();
  if (!host.sessionId) return null;
  // SPEC §11.5: any finished task (not queued/running) with a Grok session ID is eligible,
  // including failed/cancelled — not only completed.
  return listJobs(root).find((job) => job.kind === "task" && terminal(job) && job.grokSessionId && sameHostSession(job, host) && sameSecurityProfile(job.profile, profile));
}

function resolveResumeSource(root, profile, { resume, jobId } = {}) {
  if (!resume && !jobId) return null;
  if (jobId) {
    const prior = readJob(root, jobId);
    if (prior.kind !== "task") throw new CompanionError("E_USAGE", `Job ${jobId} is not a task job.`);
    if (!terminal(prior)) throw new CompanionError("E_JOB_ACTIVE", `Job ${jobId} is still ${prior.status}; wait or cancel it before resuming.`);
    if (!prior.grokSessionId) throw new CompanionError("E_NO_RESUME_CANDIDATE", `Job ${jobId} has no Grok session to resume.`);
    assertHostJobAccess(prior, "resumable task");
    if (!sameSecurityProfile(prior.profile, profile)) {
      throw new CompanionError("E_NO_RESUME_CANDIDATE", `Job ${jobId} security profile does not match the requested task profile.`);
    }
    // Explicit resume path: refuse when the prior job's workspace identity drifted.
    if (prior.verificationContextManifest || prior.completionContextManifest) {
      // Host checks may legitimately create generated or tracked evidence. Once the same host
      // task records bounded outcomes, resume binds to that post-verification manifest exactly.
      assertContextCompatible(root, prior.verificationContextManifest || prior.completionContextManifest, { mode: "resume" });
    } else if (prior.request?.contextManifest) {
      if (Number(prior.schemaVersion || 0) >= 3) {
        throw new CompanionError("E_CONTEXT_DRIFT", `Job ${jobId} is missing its completion context; refusing an unverifiable resume.`);
      }
      // Compatibility only for schema-v2 records. New jobs always resume from exact final state.
      assertContextCompatible(root, prior.request.contextManifest, { mode: "legacy-resume" });
    } else if (prior.workspaceRoot && fs.realpathSync(root) !== fs.realpathSync(prior.workspaceRoot)) {
      throw new CompanionError("E_CONTEXT_DRIFT", "Workspace identity drifted; refusing to resume in a different checkout.", {
        code: "E_CONTEXT_DRIFT",
        reasons: ["workspaceRoot"],
        expected: { workspaceRoot: prior.workspaceRoot },
        current: { workspaceRoot: fs.realpathSync(root) }
      });
    }
    return prior;
  }
  // Legacy compatibility path: implicit same-session candidate without --job-id.
  // Still enforce the same resume context integrity checks as explicit --job-id.
  const candidate = resumeCandidate(root, profile);
  if (!candidate) throw new CompanionError("E_NO_RESUME_CANDIDATE", "No resumable Grok task with the same security profile exists in this host session.");
  return resolveResumeSource(root, profile, { resume: true, jobId: candidate.id });
}

async function handleRecordVerification(raw) {
  const { options, positionals } = parseArgs(argvFrom(raw), {
    values: ["cwd"],
    booleans: ["verification-stdin", "stdin-ready", "json"]
  });
  if (!options["verification-stdin"] || positionals.length !== 1) {
    throw new CompanionError("E_USAGE", "Use record-verification <job-id> --verification-stdin.");
  }
  const root = workspaceRoot(options.cwd ? path.resolve(options.cwd) : process.cwd());
  const input = await readBoundedStdin({
    limitBytes: 64 * 1024,
    label: "Host verification",
    onReady: stdinReadySignal(options["stdin-ready"])
  });
  const updated = withWorkspaceAdmission(root, () => {
    const job = assertHostJobAccess(readJob(root, positionals[0]), "verification");
    if (job.jobClass !== "task") throw new CompanionError("E_USAGE", `Job ${job.id} is not a task job.`);
    if (!terminal(job)) throw new CompanionError("E_JOB_ACTIVE", `Job ${job.id} is still ${job.status}; wait before recording host verification.`);
    if (!job.completionContextManifest) throw new CompanionError("E_CONTEXT_DRIFT", `Job ${job.id} has no completion context to reconcile.`);
    const completionContextManifest = assertContextManifestIntegrity(
      job.completionContextManifest
    );
    if (job.verificationContextManifest) {
      assertContextManifestIntegrity(job.verificationContextManifest);
      throw new CompanionError("E_STATE", `Job ${job.id} already has a host verification baseline; record verification once per job.`);
    }
    assertContextMetadataComplete(completionContextManifest, {
      contextPhase: "resume"
    });
    const activeWriter = listJobs(root).find((candidate) => candidate.id !== job.id && !terminal(candidate) && candidate.write);
    if (activeWriter) throw new CompanionError("E_JOB_ACTIVE", `Cannot record verification while writer ${activeWriter.id} is active.`);
    const record = parseVerificationRecord(input, job.request?.envelope?.requiredVerification || []);
    // Store the full exact current snapshot for continuation binding, but compare
    // completion→current with the verification-only ignored observer so standard
    // pytest/Python cache drift from host checks is not treated as out-of-scope.
    // Scope checks use that window; the published path list keeps the terminal
    // runtime's observed paths so an empty window cannot look like "no changes".
    const verificationContextManifest = captureCompleteContextManifest(root, contextCaptureOptions("resume", job));
    const observedChangedPaths = observeChangedPaths(
      completionContextManifest,
      verificationContextManifest,
      { observer: "verification" }
    );
    const scope = job.request?.envelope?.scope || { include: [], exclude: [] };
    const scopeViolations = scope.include?.length
      ? evaluateScope(observedChangedPaths, scope)
      : observedChangedPaths;
    if (scopeViolations.length) {
      const scopeViolationEvidence = boundPathEvidence(scopeViolations, { marker: "[SCOPE_VIOLATIONS_OVERFLOW]" });
      throw new CompanionError(
        "E_SCOPE_VIOLATION",
        `Host verification changed paths outside the delegated scope: ${scopeViolationEvidence.join(", ")}. Refusing to rebase the Grok lineage.`,
        { paths: scopeViolationEvidence }
      );
    }
    const observedChangedEvidence = publishedVerificationChangedPaths({
      runtimeObservedPaths: job.result?.runtimeEvidence?.observedChangedPaths,
      verificationWindowPaths: observedChangedPaths
    });
    return updateJob(root, job.id, (current) => {
      current.verificationContextManifest = verificationContextManifest;
      current.commandOutcomes = record.commandOutcomes;
      current.result = {
        ...(current.result || {}),
        hostVerification: record.outcome,
        verification: {
          outcome: record.outcome,
          authority: "host_asserted",
          recordedAt: now(),
          observedChangedPaths: observedChangedEvidence
        },
        runtimeEvidence: {
          ...(current.result?.runtimeEvidence || {}),
          commandOutcomes: record.commandOutcomes,
          hostVerification: record.outcome
        }
      };
      current.lifecycleEvents = appendLifecycleEvent(
        current.lifecycleEvents,
        record.outcome === "passed" ? "checkpoint" : "blocked",
        `Host verification ${record.outcome}`,
        { authority: "host_asserted", commands: record.commandOutcomes.length, observedChangedPaths: observedChangedEvidence }
      );
      return touchJob(current, { progress: `Host verification ${record.outcome}` });
    });
  });
  out(options.json ? publicJson(updated) : renderJob(updated), options.json);
}

async function handleTask(raw) {
  // Task argv elements are already separated by the host. Never split a lone literal task
  // argument again: embedded strings such as "--write" must not become capability flags.
  const { options, positionals } = parseArgs(raw, {
    values: ["model", "effort", "cwd", "job-id", "envelope-file"],
    booleans: ["wait", "background", "write", "resume", "fresh", "json", "envelope-stdin", "stdin-ready"]
  });
  if (options.resume && options.fresh) throw new CompanionError("E_USAGE", "Choose --resume or --fresh.");
  if (options.wait && options.background) throw new CompanionError("E_USAGE", "Choose --wait or --background.");
  if (options.fresh && options["job-id"]) throw new CompanionError("E_USAGE", "--job-id cannot be combined with --fresh.");
  if (options["job-id"] && !options.resume) {
    // Explicit job resume is the preferred native-like path; --job-id implies resume.
    options.resume = true;
  }
  validateModelEffort(options);
  const envelopeSources = Number(Boolean(options["envelope-stdin"])) + Number(Boolean(options["envelope-file"])) + Number(positionals.length > 0);
  if (envelopeSources > 1) {
    throw new CompanionError("E_USAGE", "Use exactly one of --envelope-stdin, --envelope-file, or positional task text.");
  }
  if (options["stdin-ready"] && !options["envelope-stdin"]) {
    throw new CompanionError("E_USAGE", "--stdin-ready requires --envelope-stdin.");
  }
  const envelopeInput = options["envelope-stdin"]
    ? parseTaskEnvelopeInput(await readBoundedStdin({
      label: "TaskEnvelope",
      onReady: stdinReadySignal(options["stdin-ready"])
    }))
    : options["envelope-file"]
      ? parseTaskEnvelopeInput(readPrivateEnvelopeFile(options["envelope-file"]))
      : null;
  const promptText = envelopeInput?.userRequest ?? positionals.join(" ").trim();
  if (!promptText) {
    throw new CompanionError(
      "E_USAGE",
      options["envelope-stdin"] || options["envelope-file"]
        ? "TaskEnvelope userRequest must be a non-empty string."
        : "Provide a task for Grok or pass --envelope-stdin."
    );
  }
  if (options.write && !envelopeInput) {
    throw new CompanionError("E_USAGE", "Write tasks require a structured TaskEnvelope via --envelope-stdin or --envelope-file.");
  }
  const root = workspaceRoot(options.cwd ? path.resolve(options.cwd) : process.cwd());
  const profile = profileFor("task", Boolean(options.write));
  if (envelopeInput?.mode && (envelopeInput.mode === "write") !== Boolean(options.write)) {
    throw new CompanionError("E_USAGE", "TaskEnvelope mode must match the --write security profile.");
  }
  let prior = options.resume || options["job-id"]
    ? resolveResumeSource(root, profile, { resume: Boolean(options.resume), jobId: options["job-id"] || null })
    : null;
  if (prior?.result?.taskRuntimeCleaned === false) {
    // Only terminal cleanup-pending sources are recovered here. Queued/running
    // jobs remain explicit E_JOB_ACTIVE conflicts rather than being converted
    // and unexpectedly resumed by a new task invocation.
    await recoverActiveJobs(root);
    prior = resolveResumeSource(root, profile, { resume: Boolean(options.resume), jobId: options["job-id"] || null });
  }
  if ((options.resume || options["job-id"]) && !prior) {
    throw new CompanionError("E_NO_RESUME_CANDIDATE", "No resumable Grok task with the same security profile exists in this host session.");
  }

  const envelopeDraft = buildTaskEnvelope({
    ...(envelopeInput || {}),
    userRequest: promptText,
    objective: envelopeInput?.objective || promptText,
    mode: options.write ? "write" : "read"
  });
  const contextManifest = captureCompleteContextManifest(
    root,
    contextCaptureOptions("admission", envelopeDraft)
  );
  const envelope = bindTaskEnvelopeContext(envelopeDraft, contextManifest.manifestId);
  if (options.write && envelope.scope.include.length === 0) {
    throw new CompanionError("E_USAGE", "Write TaskEnvelope scope.include must contain at least one bounded repository path or glob.");
  }
  assertTaskContextReady(envelope, contextManifest, { structuredInput: Boolean(envelopeInput) });
  const prompt = composeProviderPrompt(envelope, { root, contextManifest });
  const accepted = appendLifecycleEvent([], "task.accepted", "Task accepted", {
    envelopeId: envelope.envelopeId,
    mode: envelope.mode,
    resumeJobId: prior?.id || null
  });
  const id = generateId("task");
  const providerHomeId = prior?.request?.providerHomeId || prior?.id || id;
  const job = baseRecord({
    id,
    kind: "task",
    root,
    profile,
    title: envelope.objective.slice(0, 100),
    request: {
      prompt,
      promptDigest: null,
      resumeSessionId: prior?.grokSessionId || null,
      resumeJobId: prior?.id || null,
      providerHomeId,
      envelopeSource: options["envelope-stdin"] ? "structured-stdin" : options["envelope-file"] ? "structured-private-file" : "legacy-positional",
      publicObjective: envelopeInput?.objective ? envelope.objective : null,
      envelope,
      contextManifest
    },
    write: Boolean(options.write),
    model: options.model,
    effort: options.effort,
    lifecycleEvents: accepted
  });
  job.progress = "Task accepted";
  job.summary = "Task accepted";
  const finished = await startJob(root, job, Boolean(options.background), {
    announce: !options.background && !options.json
  });
  const finishedHandle = projectWorkerHandle(finished);
  out(
    options.json
      ? publicJson(finished)
      : options.background
        ? `Grok task started in the background.\nJob: ${finishedHandle.id}\nPhase: ${finishedHandle.phase || "unknown"}\nProgress: ${finishedHandle.progress || finishedHandle.summary || "Task accepted"}\nCheck: ${hostCommand("status", finishedHandle.id)}`
        : renderJob(finished),
    options.json
  );
}

export {
  handleRecordVerification,
  handleReview,
  handleSetup,
  handleTask,
  resolveResumeSource,
  resumeCandidate
};
