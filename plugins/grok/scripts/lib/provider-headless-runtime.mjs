import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  isCancelledPromptStopReason,
  isSuccessfulPromptStopReason
} from "./acp-client.mjs";
import { CompanionError } from "./errors.mjs";
import {
  assertProviderLaunchBinding as assertExecutableProviderLaunchBinding,
  resolveProviderExecutablePin
} from "./provider-executable-pin.mjs";
import { redact, redactText } from "./redact.mjs";
import {
  assertCompleteDetachedOwnedIdentity,
  processGroupGone,
  signalOwnedProcess
} from "./process-control.mjs";
import {
  registerProviderGuard,
  unregisterProviderGuard
} from "./recursion-guard.mjs";
import { hostCommand, hostContext } from "./host.mjs";
import {
  openProvider,
  requestDuringProviderStartup
} from "./provider-acp-runtime.mjs";
import {
  assertProviderPlatform,
  discoverGrok,
  grokVersion,
  safeMarker
} from "./provider-core.mjs";
import {
  cleanupReviewEnvironment,
  gatedCleanupReviewEnvironment,
  reviewEnvironment
} from "./provider-credentials.mjs";
import { taskEnvironment } from "./provider-task-environment.mjs";
import {
  attachProviderCleanupIdentity,
  captureSpawnIdentity,
  ensureChildExit,
  providerCleanupIdentity
} from "./provider-process.mjs";
import { inspectIsolation } from "./provider-profile.mjs";
import {
  DEFAULT_REVIEW_REPAIR_PROMPT,
  extractJson,
  outputSchemaDigest,
  resolveTrustedOutputSchema,
  validateReview
} from "./provider-review-contract.mjs";

function headlessArgs({ root, promptFile, model, effort, leaderSocket, resumeSessionId, newSessionId, structured, sandboxProfile, outputSchema = null }) {
  const args = ["--cwd", root, "--agent", "explore", "--sandbox", sandboxProfile, "--permission-mode", "default", "--tools", "todo_write", "--disallowed-tools", "Agent,run_terminal_cmd,read_file,list_dir,grep,search_replace,write,web_search,web_fetch,search_tool,use_tool", "--deny", "MCPTool(*)", "--deny", "Bash(*)", "--deny", "Read(*)", "--deny", "Grep(*)", "--deny", "Edit(*)", "--deny", "Write(*)", "--deny", "WebFetch(*)", "--disable-web-search", "--no-subagents", "--no-memory", "--no-plan", "--leader-socket", leaderSocket];
  if (model) args.push("--model", model);
  if (effort) args.push("--reasoning-effort", effort);
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  else args.push("--session-id", newSessionId);
  if (structured) {
    // Trusted schema is passed as a single argv element (spawn shell:false) — never via shell interpolation.
    const schema = resolveTrustedOutputSchema(outputSchema);
    args.push("--json-schema", JSON.stringify(schema));
  } else {
    args.push("--output-format", "json");
  }
  args.push("--verbatim", "--prompt-file", promptFile);
  return args;
}

function anonymousPrompt(directory, prompt) {
  const temporary = path.join(directory, `prompt-${process.pid}-${crypto.randomBytes(8).toString("hex")}.md`);
  let fd = null;
  try {
    fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600);
    fs.unlinkSync(temporary);
    fs.writeSync(fd, String(prompt), 0, "utf8");
    return fd;
  } catch (error) {
    if (fd != null) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

export async function runHeadless({ root, profile, prompt, model, effort, stateDir, jobMarker = "review", resumeSessionId = null, structured = false, outputSchema = null, cancelRequested = () => false, onEvent = () => {}, timeoutMs = 15 * 60 * 1000, maxOutputBytes = 1024 * 1024, signalProcess = process.kill }) {
  assertProviderPlatform();
  // Validate trusted schema early (bounded + serializable) before spawning.
  const trustedSchema = structured ? resolveTrustedOutputSchema(outputSchema) : null;
  const binary = discoverGrok(), version = grokVersion(binary);
  const marker = safeMarker(jobMarker), isolation = reviewEnvironment(
    stateDir,
    marker,
    { providerExecutableBinary: binary }
  );
  const leaderSocket = path.join(stateDir, `leader-${marker}-${process.pid}-${Date.now()}.sock`);
  // Prefer anonymous fd 3 prompts locally. On CI (GitHub Actions sets CI=true), sandbox
  // re-exec cannot re-open /dev/fd/3 reliably ("Bad file descriptor"). Use a mode-0600
  // file under the isolated review home instead; it is removed with that home.
  const forceNamedPrompt = process.env.GROK_HEADLESS_PROMPT_ON_DISK === "1"
    || process.env.CI === "true"
    || process.env.GITHUB_ACTIONS === "true"
    || process.env.GROK_COMPANION_HOST === "ci";
  let promptFile;
  let promptFd = null;
  let namedPromptPath = null;
  if (forceNamedPrompt) {
    // Prefer /tmp so the strict sandbox can always open the prompt path.
    const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-ci-prompt-"));
    namedPromptPath = path.join(promptDir, "prompt.md");
    fs.writeFileSync(namedPromptPath, String(prompt), { mode: 0o600 });
    promptFile = namedPromptPath;
  } else {
    promptFile = process.platform === "linux" ? "/proc/self/fd/3" : "/dev/fd/3";
    promptFd = anonymousPrompt(isolation.home, prompt);
  }
  const newSessionId = resumeSessionId ? null : crypto.randomUUID();
  const closePromptFd = () => {
    if (promptFd != null) {
      try { fs.closeSync(promptFd); } catch { /* already closed */ }
      promptFd = null;
    }
    if (namedPromptPath) {
      try { fs.rmSync(path.dirname(namedPromptPath), { recursive: true, force: true }); } catch { /* best-effort */ }
      namedPromptPath = null;
    }
  };
  let child;
  try {
    const stdio = forceNamedPrompt
      ? ["ignore", "pipe", "pipe"]
      : ["ignore", "pipe", "pipe", promptFd];
    if (cancelRequested()) {
      throw new CompanionError("E_CANCELLED", "Grok job was cancelled before provider process creation.");
    }
    child = spawn(binary, headlessArgs({ root, promptFile, model, effort, leaderSocket, resumeSessionId, newSessionId, structured, sandboxProfile: isolation.sandboxProfile, outputSchema: trustedSchema }), { cwd: root, env: { ...isolation.env, GROK_COMPANION_JOB_MARKER: marker }, shell: false, detached: process.platform !== "win32", stdio });
  } catch (error) {
    closePromptFd();
    throw error;
  }
  let identity;
  try { identity = await captureSpawnIdentity(child); }
  catch (error) {
    closePromptFd();
    const failedIdentity = providerCleanupIdentity(error);
    if (failedIdentity) {
      try { onEvent({ type: "provider", process: failedIdentity, version }); } catch {}
    }
    const cleanup = gatedCleanupReviewEnvironment(stateDir, marker, failedIdentity);
    if (!cleanup.ok && error && typeof error === "object") {
      const details = error.details && typeof error.details === "object" && !Array.isArray(error.details) ? { ...error.details } : {};
      details.privacyWarning = [details.privacyWarning, cleanup.warning].filter(Boolean).join("; ");
      error.details = details;
    }
    throw error;
  }
  let guardRecord;
  try { guardRecord = registerProviderGuard(root, marker, identity, hostContext().sessionId); }
  catch (error) {
    closePromptFd();
    try { await ensureChildExit(child, identity); }
    catch (shutdownError) {
      try { onEvent({ type: "provider", process: identity, version }); } catch {}
      const cleanup = gatedCleanupReviewEnvironment(stateDir, marker, identity);
      const details = shutdownError?.details && typeof shutdownError.details === "object" && !Array.isArray(shutdownError.details)
        ? { ...shutdownError.details }
        : {};
      if (!cleanup.ok) details.privacyWarning = [details.privacyWarning, cleanup.warning].filter(Boolean).join("; ");
      if (shutdownError && typeof shutdownError === "object") shutdownError.details = details;
      throw attachProviderCleanupIdentity(shutdownError, identity);
    }
    cleanupReviewEnvironment(stateDir, marker);
    throw error;
  }
  let stdout = "", stdoutBytes = 0, stderr = "", terminationReason = null, forceTimer = null, eventError = null, terminationSignalError = null;
  const MAX_OUTPUT = maxOutputBytes;
  let rejectTerminationSignalFailure;
  const terminationSignalFailure = new Promise((_, reject) => {
    rejectTerminationSignalFailure = reject;
  });
  const terminate = (signal) => {
    try {
      assertCompleteDetachedOwnedIdentity(identity);
      return signalOwnedProcess(
        identity.processGroupId && process.platform !== "win32"
          ? -identity.processGroupId
          : identity.pid,
        signal,
        signalProcess
      );
    } catch (error) {
      if (!terminationSignalError) {
        terminationSignalError = error;
        rejectTerminationSignalFailure(error);
      }
      return false;
    }
  };
  const beginTermination = (reason) => {
    if (terminationReason) return;
    terminationReason = reason;
    if (!terminate("SIGTERM")) return;
    forceTimer = setTimeout(() => { terminate("SIGKILL"); }, 2000);
  };
  const emitEvent = (event) => {
    if (eventError) return;
    try { onEvent(event); }
    catch (error) { eventError = error; beginTermination("event"); }
  };
  const completion = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal])); });
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (terminationReason === "output") return;
    const bytes = Buffer.byteLength(chunk);
    if (stdoutBytes + bytes > MAX_OUTPUT) { beginTermination("output"); return; }
    stdout += chunk;
    stdoutBytes += bytes;
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-65536); emitEvent({ type: "diagnostic", text: redactText(chunk, isolation.knownSecrets) }); });
  emitEvent({ type: "provider", process: identity, version });
  emitEvent({ type: "session", sessionId: resumeSessionId || newSessionId });
  const cancelPoll = setInterval(() => { if (!terminationReason && cancelRequested()) beginTermination("cancel"); }, 100);
  const timeout = setTimeout(() => beginTermination("timeout"), timeoutMs);
  let code, signal;
  try {
    [code, signal] = await Promise.race([completion, terminationSignalFailure]);
  } catch (error) {
    if (error === terminationSignalError) throw error;
    throw new CompanionError("E_PROVIDER_EXIT", `Could not start Grok: ${error.message}`);
  } finally {
    clearInterval(cancelPoll); clearTimeout(timeout); if (forceTimer) clearTimeout(forceTimer);
    closePromptFd();
    await ensureChildExit(child, identity, { signalProcess });
    unregisterProviderGuard(root, marker, guardRecord);
  }
  if (eventError) { cleanupReviewEnvironment(stateDir, marker); throw eventError; }
  if (terminationReason === "cancel") throw new CompanionError("E_CANCELLED", "Grok job was cancelled.");
  if (terminationReason === "timeout") throw new CompanionError("E_TIMEOUT", "Grok headless review timed out.");
  if (terminationReason === "output") throw new CompanionError("E_OUTPUT_LIMIT", `Grok headless output exceeded ${MAX_OUTPUT} bytes.`);
  if (code !== 0) {
    const diagnostic = redactText(stderr || stdout, isolation.knownSecrets).slice(-8000);
    if (/login|auth|unauthori[sz]ed|401/i.test(diagnostic)) throw new CompanionError("E_AUTH_REQUIRED", `Grok authentication is required. Run \`grok login\`, then ${hostCommand("setup")}.`, { diagnostic });
    throw new CompanionError("E_PROVIDER_EXIT", `Grok headless review exited (${code ?? signal}).`, { code, signal, diagnostic });
  }
  let payload;
  try { payload = JSON.parse(stdout); } catch { throw new CompanionError("E_PROTOCOL", "Grok headless mode returned malformed JSON."); }
  const sessionId = payload.sessionId || resumeSessionId || newSessionId;
  if (!sessionId) throw new CompanionError("E_PROTOCOL", "Grok headless mode returned no session ID.");
  const expectedSessionId = resumeSessionId || newSessionId;
  if (sessionId !== expectedSessionId) throw new CompanionError("E_PROTOCOL", `Grok returned session ${sessionId} while ${expectedSessionId} was required.`);
  return { sessionId, text: redactText(String(payload.text ?? "").trim(), isolation.knownSecrets), structuredOutput: redact(payload.structuredOutput, isolation.knownSecrets), stopReason: payload.stopReason || "EndTurn", provider: { version, process: identity, isolatedHome: isolation.home }, capabilities: { transport: "headless", agent: "explore", sandbox: isolation.sandboxProfile } };
}

async function openAcpProviderRuntime({
  root,
  profile,
  prompt,
  model,
  effort,
  stateDir,
  jobMarker,
  providerHomeId,
  cancelRequested,
  onEvent,
  guardBinding,
  providerLaunch,
  providerExecutableBinding,
  providerExecutableEnv,
  outputSchema,
  testHooks,
  signalProcess
}) {
  const boundOutputSchemaDigest = outputSchemaDigest(outputSchema);
  const resolvedExecutablePin = providerExecutableBinding === null
    ? null
    : resolveProviderExecutablePin(
        assertExecutableProviderLaunchBinding(providerExecutableBinding),
        { env: providerExecutableEnv }
      );
  const environment = /^rescue-(read|write|report)-v3$/.test(profile.id || "")
    ? taskEnvironment(
        stateDir,
        root,
        profile,
        providerHomeId || jobMarker,
        {
          providerExecutableBinary:
            resolvedExecutablePin?.binary || null
        }
      )
    : null;
  const effectiveProfile = environment?.sandboxProfile ? { ...profile, sandbox: environment.sandboxProfile } : profile;
  const boundProviderLaunch = providerLaunch
    && typeof providerLaunch.prepare === "function"
    && typeof providerLaunch.noChild === "function" ? {
    prepare: (details = {}) => providerLaunch.prepare(Object.freeze({
      ...details,
      promptDigest: crypto.createHash("sha256").update(String(prompt || "")).digest("hex"),
      profileId: effectiveProfile.id,
      profileContractVersion: effectiveProfile.contractVersion,
      agentProfileDigest: effectiveProfile.agentProfileDigest,
      outputSchemaDigest: boundOutputSchemaDigest
    })),
    noChild: (details) => providerLaunch.noChild(details)
  } : providerLaunch;
  try {
    if (environment) {
      inspectIsolation(
        resolvedExecutablePin?.binary || discoverGrok(),
        root,
        environment
      );
    }
  } catch (error) {
    try { environment?.revokeCredential(); }
    catch (cleanupError) {
      const details = error?.details && typeof error.details === "object" && !Array.isArray(error.details) ? { ...error.details } : {};
      details.privacyWarning = [details.privacyWarning, `credential: ${redactText(cleanupError?.message || String(cleanupError), environment?.knownSecrets || []).slice(0, 500)}`].filter(Boolean).join("; ");
      if (error && typeof error === "object") error.details = details;
    }
    throw error;
  }
  let provider;
  try {
    provider = await openProvider({
      root,
      profile: effectiveProfile,
      model,
      effort,
      stateDir,
      jobMarker,
      environment,
      cancelRequested,
      onEvent,
      guardBinding,
      providerLaunch: boundProviderLaunch,
      providerExecutableBinding:
        resolvedExecutablePin?.binding || providerExecutableBinding,
      providerExecutableEnv,
      testHooks,
      signalProcess
    });
  } catch (error) {
    const failedIdentity = providerCleanupIdentity(error);
    if (failedIdentity) {
      try { onEvent({ type: "provider", process: failedIdentity, version: null }); }
      catch (eventError) {
        const details = error?.details && typeof error.details === "object" && !Array.isArray(error.details) ? { ...error.details } : {};
        details.cleanupWarning = [details.cleanupWarning, `provider identity persistence: ${redactText(eventError?.message || String(eventError)).slice(0, 500)}`].filter(Boolean).join("; ");
        if (error && typeof error === "object") error.details = details;
      }
    }
    // A startup failure with only a PID/PGID witness is deliberately
    // observation-only. The detached group may still be reading its staged
    // credential/profile, so retain both until recovery observes it gone.
    if (!failedIdentity || processGroupGone(failedIdentity)) {
      try { environment?.revokeCredential(); }
      catch (cleanupError) {
        const details = error?.details && typeof error.details === "object" && !Array.isArray(error.details) ? { ...error.details } : {};
        details.privacyWarning = [details.privacyWarning, `credential: ${redactText(cleanupError?.message || String(cleanupError), environment?.knownSecrets || []).slice(0, 500)}`].filter(Boolean).join("; ");
        if (error && typeof error === "object") error.details = details;
      }
    }
    throw error;
  }
  return { provider, environment };
}

function createProviderOperationRuntime(provider, signalProcess) {
  const runtime = {
    sessionId: null,
    poll: null,
    killTimer: null,
    cancelled: false,
    outputError: null,
    outputBytes: 0,
    primaryTurnAdmission: null,
    mailboxAttempt: null,
    mailboxClosed: false,
    terminationSignalError: null
  };
  let rejectTerminationSignalFailure;
  const terminationSignalFailure = new Promise((_, reject) => {
    rejectTerminationSignalFailure = reject;
  });
  runtime.signalProvider = (signal) => {
    try {
      assertCompleteDetachedOwnedIdentity(provider.process);
      return signalOwnedProcess(
        provider.process.processGroupId
          ? -provider.process.processGroupId
          : provider.child.pid,
        signal,
        signalProcess
      );
    } catch (error) {
      if (!runtime.terminationSignalError) {
        runtime.terminationSignalError = error;
        rejectTerminationSignalFailure(error);
      }
      return false;
    }
  };
  runtime.scheduleProviderTermination = () => {
    if (runtime.killTimer || runtime.terminationSignalError) return;
    runtime.killTimer = setTimeout(() => {
      runtime.killTimer = null;
      runtime.signalProvider("SIGTERM");
    }, 5000);
  };
  runtime.awaitProviderOperation = (operation) => (
    Promise.race([
      operation,
      terminationSignalFailure,
      provider.eventFailure.then((error) => {
        throw error;
      })
    ])
  );
  return runtime;
}

async function openAcpProviderSession(context) {
  const {
    provider,
    runtime,
    cancelRequested,
    resumeSessionId,
    root,
    environment,
    mailboxController,
    primaryTurnController,
    prompt,
    testHooks
  } = context;
  if ((provider.initialized.authMethods || []).some((method) => method?.id === "cached_token")) {
    await runtime.awaitProviderOperation(
      requestDuringProviderStartup(
        provider.client,
        "authenticate",
        { methodId: "cached_token", _meta: { headless: true } },
        30000,
        cancelRequested
      )
    );
  }
  const session = resumeSessionId
    ? await runtime.awaitProviderOperation(
        requestDuringProviderStartup(
          provider.client,
          "session/load",
          { sessionId: resumeSessionId, cwd: root, mcpServers: [] },
          45000,
          cancelRequested
        )
      )
    : await runtime.awaitProviderOperation(
        requestDuringProviderStartup(
          provider.client,
          "session/new",
          { cwd: root, mcpServers: [] },
          45000,
          cancelRequested
        )
      );
  runtime.sessionId = session?.sessionId || resumeSessionId;
  if (!runtime.sessionId) throw new CompanionError("E_PROTOCOL", "Grok did not return a session ID.");
  if (resumeSessionId && runtime.sessionId !== resumeSessionId) throw new CompanionError("E_PROTOCOL", `Grok loaded session ${runtime.sessionId} while ${resumeSessionId} was required.`);
  provider.emitEvent({ type: "session", sessionId: runtime.sessionId, models: session?.models });
  if (provider.eventError()) throw provider.eventError();
  // Session creation is authenticated before any model tool can run. Remove the
  // reusable bearer credential before session/prompt exposes workspace tools.
  environment?.revokeCredential();
  if (mailboxController) {
    if (typeof mailboxController.open !== "function") {
      throw new CompanionError(
        "E_CAPABILITY",
        "Attempt-bound mailbox pumping is available only on the primary provider generation."
      );
    }
    runtime.mailboxAttempt = await runtime.awaitProviderOperation(
      mailboxController.open({
        sessionId: runtime.sessionId,
        providerProcess: provider.process,
        providerCapabilities: provider.initialized
      })
    );
    if (provider.eventError()) throw provider.eventError();
  }
  if (primaryTurnController) {
    if (typeof primaryTurnController.admit !== "function"
      || typeof primaryTurnController.consume !== "function") {
      throw new CompanionError(
        "E_CAPABILITY",
        "Primary provider turns require an exact durable admission controller."
      );
    }
    runtime.primaryTurnAdmission = primaryTurnController.admit({
      sessionId: runtime.sessionId,
      providerProcess: provider.process,
      prompt
    });
    if (!runtime.primaryTurnAdmission
      || typeof runtime.primaryTurnAdmission !== "object"
      || typeof runtime.primaryTurnAdmission.then === "function") {
      throw new CompanionError(
        "E_STATE",
        "Primary provider turn admission must be committed synchronously."
      );
    }
    await testHooks?.afterPrimaryTurnAdmitted?.({
      admission: runtime.primaryTurnAdmission,
      sessionId: runtime.sessionId,
      providerProcess: provider.process
    });
  }
}

function createProviderTurnCollector(provider, runtime) {
  let currentTurn = null;
  const beginTurn = () => {
    const turn = {
      allMessageText: "",
      finalText: "",
      interimText: ""
    };
    currentTurn = turn;
    return {
      text: () => {
        const marker = turn.allMessageText.lastIndexOf("GROK_WORKER_REPORT:");
        return (marker >= 0
          ? turn.allMessageText.slice(marker)
          : turn.finalText).trim();
      },
      interimText: () => {
        const marker = turn.allMessageText.lastIndexOf("GROK_WORKER_REPORT:");
        return (marker >= 0
          ? turn.allMessageText.slice(0, marker)
          : turn.interimText).trim();
      }
    };
  };
  const listener = (event) => {
    if (event.type === "message") {
      const chunk = event.text || "";
      runtime.outputBytes += Buffer.byteLength(chunk, "utf8");
      if (runtime.outputBytes > 512 * 1024) {
        if (!runtime.outputError) {
          runtime.outputError = new CompanionError("E_OUTPUT_LIMIT", "Grok provider message output exceeded the 512 KiB job limit.", { limitBytes: 512 * 1024 });
          provider.client.notify("session/cancel", { sessionId: runtime.sessionId });
          runtime.scheduleProviderTermination();
        }
        return;
      }
      if (currentTurn) {
        currentTurn.allMessageText += chunk;
        currentTurn.finalText += chunk;
      }
      return;
    }
    if (event.type === "tool" || event.type === "plan") {
      if (currentTurn?.finalText) {
        currentTurn.interimText += currentTurn.finalText;
        currentTurn.finalText = "";
      }
    }
  };
  return { beginTurn, listener };
}

async function promptPrimaryProviderTurn(context, collector) {
  const {
    provider,
    runtime,
    primaryTurnController,
    prompt,
    outputSchema,
    timeoutMs
  } = context;
  let result;
  let structuredOutput;
  let structuredOutputError;
  const primaryCollector = collector.beginTurn();
  try {
    if (primaryTurnController) {
      const consumed = primaryTurnController.consume({
        admission: runtime.primaryTurnAdmission,
        sessionId: runtime.sessionId,
        providerProcess: provider.process,
        prompt
      });
      if (!consumed
        || typeof consumed !== "object"
        || typeof consumed.then === "function") {
        throw new CompanionError(
          "E_STATE",
          "Primary provider turn admission must be consumed synchronously."
        );
      }
    }
    const promptResponse = await runtime.awaitProviderOperation(
      provider.client.promptTurn({
        sessionId: runtime.sessionId,
        prompt: [{ type: "text", text: prompt }],
        outputSchema,
        timeoutMs: timeoutMs ?? 30 * 60 * 1000
      })
    );
    result = promptResponse.result;
    if (Object.hasOwn(promptResponse, "structuredOutput")) {
      structuredOutput = promptResponse.structuredOutput;
    }
    if (Object.hasOwn(promptResponse, "structuredOutputError")) {
      structuredOutputError = promptResponse.structuredOutputError;
    }
  }
  catch (error) {
    if (provider.eventError()) throw provider.eventError();
    if (error === runtime.terminationSignalError) throw error;
    if (runtime.outputError) throw runtime.outputError;
    if (runtime.cancelled) throw new CompanionError("E_CANCELLED", "Grok job was cancelled.");
    throw error;
  }
  if (provider.eventError()) throw provider.eventError();
  if (runtime.outputError) throw runtime.outputError;
  if (runtime.cancelled
    || context.cancelRequested()
    || isCancelledPromptStopReason(result?.stopReason)) {
    throw new CompanionError("E_CANCELLED", "Grok job was cancelled.");
  }
  if (!isSuccessfulPromptStopReason(result?.stopReason)) {
    throw new CompanionError(
      "E_PROTOCOL",
      "Grok prompt did not end at a successful ACP turn boundary."
    );
  }
  return { result, structuredOutput, structuredOutputError, primaryCollector };
}

async function drainProviderMailbox(context, collector, primary) {
  const {
    provider,
    runtime,
    mailboxController,
    prompt,
    timeoutMs,
    cancelRequested
  } = context;
  let {
    structuredOutput,
    structuredOutputError
  } = primary;
  let resolvedFinal = primary.primaryCollector.text();
  let resolvedInterim = primary.primaryCollector.interimText();
  let selectedSequence = 0;
  let mailboxEvidence = null;
  if (mailboxController) {
    await runtime.awaitProviderOperation(mailboxController.recordPrimary({
      attempt: runtime.mailboxAttempt,
      prompt,
      stopReason: primary.result?.stopReason || "end_turn"
    }));
    if (provider.eventError()) throw provider.eventError();
    const drained = await runtime.awaitProviderOperation(mailboxController.drain({
      attempt: runtime.mailboxAttempt,
      client: provider.client,
      sessionId: runtime.sessionId,
      collectTurnText: collector.beginTurn,
      timeoutMs: timeoutMs ?? 30 * 60 * 1000,
      cancelRequested
    }));
    if (provider.eventError()) throw provider.eventError();
    if (runtime.cancelled || cancelRequested()) {
      throw new CompanionError(
        "E_CANCELLED",
        "Grok job was cancelled after mailbox drain."
      );
    }
    runtime.mailboxClosed = drained?.closed === true;
    const deliveredTurns = Array.isArray(drained?.turns)
      ? drained.turns.filter((turn) => turn?.outcome === "delivered")
      : [];
    if (drained?.deliveryUnknown === true) {
      // Never reuse an earlier report when the last attempted turn is
      // ambiguous. The controller will fail the provider-success claim.
      resolvedFinal = "";
      resolvedInterim = "";
      selectedSequence = drained?.attempt?.lastCompletedSequence ?? selectedSequence;
      structuredOutput = undefined;
      structuredOutputError = undefined;
    } else if (deliveredTurns.length) {
      const selected = deliveredTurns.at(-1);
      selectedSequence = selected.sequence;
      resolvedFinal = String(selected.text || "").trim();
      resolvedInterim = "";
      structuredOutput = Object.hasOwn(selected, "structuredOutput")
        ? selected.structuredOutput
        : undefined;
      structuredOutputError = Object.hasOwn(selected, "structuredOutputError")
        ? selected.structuredOutputError
        : undefined;
    }
    mailboxEvidence = {
      schemaVersion: 1,
      attemptId: runtime.mailboxAttempt.dispatchAttemptId,
      communicationChainDigest: drained?.attempt?.communicationChainDigest || null,
      lastCompletedSequence: drained?.attempt?.lastCompletedSequence ?? null,
      selectedSequence,
      acceptedCount: drained?.attempt?.acceptedCount ?? 0,
      acceptedBytes: drained?.attempt?.acceptedBytes ?? 0,
      deliveryUnknown: drained?.deliveryUnknown === true,
      closed: runtime.mailboxClosed,
      bodiesRetained: Boolean(drained?.bodiesRetained)
    };
  }
  return {
    resolvedFinal,
    resolvedInterim,
    structuredOutput,
    structuredOutputError,
    mailboxEvidence
  };
}

async function executeAcpProviderTurn(context) {
  const { provider, runtime, cancelRequested, environment } = context;
  const collector = createProviderTurnCollector(provider, runtime);
  provider.client.on("update", collector.listener);
  runtime.poll = setInterval(() => {
    if (!runtime.cancelled && cancelRequested()) {
      runtime.cancelled = true;
      provider.client.notify("session/cancel", { sessionId: runtime.sessionId });
      runtime.scheduleProviderTermination();
    }
  }, 100);
  const primary = await promptPrimaryProviderTurn(context, collector);
  const secrets = environment?.knownSecrets || [];
  const resolved = await drainProviderMailbox(context, collector, primary);
  if (provider.eventError()) throw provider.eventError();
  clearInterval(runtime.poll);
  runtime.poll = null;
  provider.client.off("update", collector.listener);
  return {
    sessionId: runtime.sessionId,
    text: redactText(resolved.resolvedFinal, secrets),
    interimText: redactText(resolved.resolvedInterim, secrets),
    stopReason: primary.result?.stopReason || "end_turn",
    provider: { version: provider.version, process: provider.process },
    capabilities: provider.initialized,
    ...(resolved.structuredOutput !== undefined
      ? { structuredOutput: resolved.structuredOutput }
      : {}),
    ...(resolved.structuredOutputError !== undefined
      ? { structuredOutputError: resolved.structuredOutputError }
      : {}),
    ...(resolved.mailboxEvidence
      ? { mailboxEvidence: resolved.mailboxEvidence }
      : {})
  };
}

async function handleAcpProviderFailure(context, error) {
  const { provider, runtime, mailboxController } = context;
  if (mailboxController && runtime.mailboxAttempt && !runtime.mailboxClosed) {
    try {
      await mailboxController.interrupt({
        attempt: runtime.mailboxAttempt,
        reason: error?.code === "E_CANCELLED"
          ? "provider-cancelled"
          : "provider-interrupted"
      });
    } catch (mailboxError) {
      const details = error?.details && typeof error.details === "object"
        && !Array.isArray(error.details)
        ? { ...error.details }
        : {};
      details.mailboxWarning = redactText(mailboxError?.message || String(mailboxError)).slice(0, 500);
      if (error && typeof error === "object") error.details = details;
    }
  }
  if (provider.eventError()) throw provider.eventError();
  if (/auth|login|unauthori[sz]ed|no auth method/i.test(`${error?.message || ""} ${error?.details?.data || ""}`)) throw new CompanionError("E_AUTH_REQUIRED", `Grok authentication is unavailable or expired. Run \`grok login\`, then ${hostCommand("setup")}.`);
  throw error;
}

async function cleanupAcpProviderRuntime(context) {
  const { provider, runtime, environment, root, signalProcess } = context;
  if (runtime.poll) clearInterval(runtime.poll);
  if (runtime.killTimer) clearTimeout(runtime.killTimer);
  const cleanupWarnings = [];
  const noteCleanupFailure = (label, error) => {
    cleanupWarnings.push(`${label}: ${redactText(error?.message || String(error), environment?.knownSecrets || []).slice(0, 500)}`);
  };
  try { environment?.revokeCredential(); }
  catch (error) { noteCleanupFailure("credential", error); }
  try { provider.client.close(); }
  catch (error) { noteCleanupFailure("ACP client", error); }

  try {
    await ensureChildExit(provider.child, provider.process, { signalProcess });
  } catch (error) {
    if (cleanupWarnings.length && error && typeof error === "object") {
      const details = error.details && typeof error.details === "object" && !Array.isArray(error.details)
        ? { ...error.details }
        : {};
      details.privacyWarning = [details.privacyWarning, ...cleanupWarnings].filter(Boolean).join("; ");
      error.details = details;
    }
    // The provider may still be using the guard/profile. Retain both until a
    // later status/cancel recovery proves the complete process group is gone.
    throw error;
  }

  let guardRemoved = false;
  try {
    unregisterProviderGuard(root, provider.marker, provider.guardRecord);
    guardRemoved = true;
  } catch (error) {
    noteCleanupFailure("provider guard", error);
  }
  // An exact guard mismatch means another provider generation may own the
  // marker. Its process can still be reading the staged profile, so preserve
  // that profile for host recovery rather than unlinking it under ambiguity.
  if (guardRemoved) {
    try { provider.cleanupAgentProfile?.(); }
    catch (error) { noteCleanupFailure("agent profile", error); }
  }
  if (cleanupWarnings.length) {
    throw new CompanionError("E_STATE", "Grok provider exited, but transient task runtime cleanup was incomplete.", {
      privacyWarning: cleanupWarnings.join("; ")
    });
  }
}

export async function runProvider({ root, profile, prompt, model, effort, stateDir, jobMarker = "job", providerHomeId = null, resumeSessionId = null, cancelRequested = () => false, onEvent = () => {}, guardBinding = null, providerLaunch = null, providerExecutableBinding = null, providerExecutableEnv = process.env, primaryTurnController = null, mailboxController = null, outputSchema = null, testHooks = null, timeoutMs = undefined, signalProcess = process.kill }) {
  if (profile.transport === "headless") {
    if (providerExecutableBinding !== null) {
      throw new CompanionError(
        "E_CAPABILITY",
        "Durably bound worker launches require the attested ACP bootstrap transport."
      );
    }
    if (outputSchema != null) {
      throw new CompanionError(
        "E_CAPABILITY",
        "Task structured output requires the ACP provider transport."
      );
    }
    return runHeadless({ root, profile, prompt, model, effort, stateDir, jobMarker, resumeSessionId, cancelRequested, onEvent, signalProcess, ...(timeoutMs == null ? {} : { timeoutMs }) });
  }
  const { provider, environment } = await openAcpProviderRuntime({
    root,
    profile,
    prompt,
    model,
    effort,
    stateDir,
    jobMarker,
    providerHomeId,
    cancelRequested,
    onEvent,
    guardBinding,
    providerLaunch,
    providerExecutableBinding,
    providerExecutableEnv,
    outputSchema,
    testHooks,
    signalProcess
  });
  const runtime = createProviderOperationRuntime(provider, signalProcess);
  const context = {
    root,
    prompt,
    resumeSessionId,
    cancelRequested,
    primaryTurnController,
    mailboxController,
    outputSchema,
    testHooks,
    timeoutMs,
    signalProcess,
    provider,
    environment,
    runtime
  };
  try {
    await openAcpProviderSession(context);
    return await executeAcpProviderTurn(context);
  } catch (error) {
    return await handleAcpProviderFailure(context, error);
  } finally {
    await cleanupAcpProviderRuntime(context);
  }
}

/**
 * Run a structured review with an optional caller-specific trusted schema, validator,
 * and repair prompt. Defaults preserve the generic REVIEW_SCHEMA / validateReview
 * / DEFAULT_REVIEW_REPAIR_PROMPT contract for existing Worker Protocol consumers.
 *
 * @param {object} options
 * @param {object} [options.outputSchema] Explicit trusted JSON Schema (bounded, serializable).
 * @param {(value: unknown) => object} [options.validator] Post-parse validator (default validateReview).
 * @param {string} [options.repairPrompt] Same-session repair prompt (default generic).
 */
export async function runStructuredReview(options) {
  const {
    outputSchema = null,
    validator = null,
    repairPrompt = null,
    ...rest
  } = options && typeof options === "object" ? options : {};
  const trustedSchema = resolveTrustedOutputSchema(outputSchema);
  const validate = typeof validator === "function" ? validator : validateReview;
  const repairText = typeof repairPrompt === "string" && repairPrompt.trim()
    ? repairPrompt
    : DEFAULT_REVIEW_REPAIR_PROMPT;
  const execute = (values) => {
    const payload = { ...values, outputSchema: trustedSchema };
    return values.profile?.transport === "headless"
      ? runHeadless({ ...payload, structured: true })
      : runProvider(payload);
  };
  let run = await execute(rest), parsed = run.structuredOutput ?? extractJson(run.text);
  try { return { ...run, review: validate(parsed) }; }
  catch (firstError) {
    const repair = await execute({
      ...rest,
      resumeSessionId: run.sessionId,
      prompt: repairText
    });
    parsed = repair.structuredOutput ?? extractJson(repair.text);
    try {
      return { ...repair, review: validate(parsed) };
    } catch (repairError) {
      const details = {
        ...(repairError?.details && typeof repairError.details === "object" ? repairError.details : {}),
        firstError: firstError?.code || null,
        repairAttempted: true,
        attempts: 2,
        jobId: rest.jobMarker || null,
        partial: sanitizeStructuredReviewPartial(parsed)
      };
      throw new CompanionError(
        repairError?.code || "E_SCHEMA",
        repairError?.message || "Grok review repair still did not match the required schema.",
        details
      );
    }
  }
}

function sanitizeStructuredReviewPartial(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { findings: [], summaryPresent: false };
  }
  const findings = Array.isArray(value.findings)
    ? value.findings.slice(0, 32).map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const projected = {};
      if (typeof item.severity === "string") projected.severity = redactText(item.severity).slice(0, 32);
      if (typeof item.title === "string") projected.title = redactText(item.title).slice(0, 300);
      if (typeof item.body === "string") projected.body = redactText(item.body).slice(0, 4000);
      return Object.keys(projected).length ? projected : null;
    }).filter(Boolean)
    : [];
  return {
    findings,
    summaryPresent: typeof value.summary === "string" && value.summary.trim().length > 0
  };
}
