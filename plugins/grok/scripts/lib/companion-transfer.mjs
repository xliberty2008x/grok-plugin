import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { parseArgs } from "./args.mjs";
import { CompanionError, attachTransferCleanupEvidence } from "./errors.mjs";
import { assertProviderPlatform, childEnvironment, discoverGrok, grokVersion } from "./provider-core.mjs";
import { ensureChildExit } from "./provider-process.mjs";
import { assertTransferEffort, formatResumeCommand, listAdvertisedModels, selectTransferModel, waitForImportedSession } from "./provider-sessions.mjs";
import { workspaceRoot } from "./workspace.mjs";
import { redactText } from "./redact.mjs";
import { processStartToken, signalOwnedProcess } from "./process-control.mjs";
import { registerProviderGuard, unregisterProviderGuard } from "./recursion-guard.mjs";
import { pluginDataRoot, readCodexSessionMetadata } from "./host.mjs";
import { codexTranscriptToClaude, createAnonymousTranscript, disposeConvertedTranscript, openTranscriptSource, readTranscriptSnapshot } from "./transcript.mjs";
import { argvFrom, currentHost, out, sessionId, stateDir, validateModelEffort } from "./companion-shared.mjs";


function importedSessionId(output) {
  const ids = new Set();
  for (const line of String(output).split(/\r?\n/).filter(Boolean)) {
    let value;
    try { value = JSON.parse(line); } catch { throw new CompanionError("E_IMPORT_RESULT", "Grok import returned malformed NDJSON."); }
    for (const key of ["sessionId", "session_id", "grokSessionId", "grok_session_id"]) {
      if (typeof value?.[key] === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value[key])) ids.add(value[key]);
    }
  }
  if (ids.size > 1) {
    throw new CompanionError("E_IMPORT_RESULT", "Grok import returned multiple different session IDs.", {
      sessionIds: [...ids]
    });
  }
  return ids.values().next().value || null;
}

/**
 * Shared post-finally transfer cleanup evidence.
 * Source-FD close-only failures are warning-only; converted/alias residuals also set privacyWarning.
 */
function transferCleanupDetails(cleanupWarnings, { privacy = false } = {}) {
  const warnings = (Array.isArray(cleanupWarnings) ? cleanupWarnings : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (!warnings.length) return undefined;
  const text = warnings.join("; ");
  return {
    warning: text,
    ...(privacy ? { privacyWarning: text } : {})
  };
}

function shellWord(value) {
  const text = String(value);
  return /^[a-zA-Z0-9_./:+-]+$/.test(text) ? text : `'${text.replaceAll("'", `'"'"'`)}'`;
}

async function runImportProcess({ binary, root, transcriptFd, alias, leaderSocket, marker, signal, timeoutMs = 120000, maxOutputBytes = 8 * 1024 * 1024 }) {
  // Hard-gate before spawn / identity: Windows must report E_CAPABILITY, not E_PROCESS_IDENTITY.
  assertProviderPlatform();
  // Test-only timeout override for deterministic cancel/timeout throw-path fixtures.
  const testTimeout = Number(process.env.GROK_COMPANION_TEST_IMPORT_TIMEOUT_MS);
  if (Number.isFinite(testTimeout) && testTimeout > 0) timeoutMs = testTimeout;
  const child = spawn(binary, ["import", "--json", "--leader-socket", leaderSocket, alias], {
    cwd: root,
    env: childEnvironment({ GROK_COMPANION_JOB_MARKER: marker }),
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe", transcriptFd]
  });
  const identity = { pid: child.pid, startToken: processStartToken(child.pid), processGroupId: process.platform === "win32" ? null : child.pid };
  let guardRecord;
  try { guardRecord = registerProviderGuard(root, marker, identity, sessionId(), "import"); }
  catch (error) { await ensureChildExit(child, identity); throw error; }
  let stdout = "", stdoutBytes = 0, stderr = "", terminationReason = null, forceTimer = null, terminationSignalError = null;
  let rejectTerminationSignalFailure;
  const terminationSignalFailure = new Promise((_, reject) => {
    rejectTerminationSignalFailure = reject;
  });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, closedBy) => resolve([exitCode, closedBy]));
  });
  const terminate = (name) => {
    try {
      return signalOwnedProcess(
        identity.processGroupId && process.platform !== "win32"
          ? -identity.processGroupId
          : identity.pid,
        name
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
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (terminationReason === "output") return;
    const bytes = Buffer.byteLength(chunk);
    if (stdoutBytes + bytes > maxOutputBytes) { beginTermination("output"); return; }
    stdout += chunk;
    stdoutBytes += bytes;
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-65536); });
  const onAbort = () => beginTermination("cancel");
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timeout = setTimeout(() => beginTermination("timeout"), timeoutMs);
  let code, exitSignal;
  try {
    [code, exitSignal] = await Promise.race([completion, terminationSignalFailure]);
  } finally {
    clearTimeout(timeout);
    if (forceTimer) clearTimeout(forceTimer);
    if (signal) signal.removeEventListener("abort", onAbort);
    await ensureChildExit(child, identity);
    unregisterProviderGuard(root, marker, guardRecord);
  }
  if (terminationReason === "cancel") throw new CompanionError("E_CANCELLED", "Grok transcript import was cancelled.");
  if (terminationReason === "timeout") throw new CompanionError("E_TIMEOUT", "Grok transcript import timed out.");
  if (terminationReason === "output") throw new CompanionError("E_OUTPUT_LIMIT", `Grok transcript import output exceeded ${maxOutputBytes} bytes.`);
  return { status: code, signal: exitSignal, stdout, stderr };
}

/**
 * Test-only faults: GROK_COMPANION_TEST_TRANSFER_CLEANUP_FAULTS=close,dispose,unlink
 * Injects cleanup evidence while still performing real close/dispose/unlink.
 */
function transferCleanupFaults() {
  const raw = process.env.GROK_COMPANION_TEST_TRANSFER_CLEANUP_FAULTS;
  if (!raw) return new Set();
  return new Set(String(raw).split(",").map((part) => part.trim()).filter(Boolean));
}

async function handleTransfer(raw) {
  const { options } = parseArgs(argvFrom(raw), { values: ["source", "cwd", "model", "effort"], booleans: ["json"] });
  validateModelEffort(options);
  const root = workspaceRoot(options.cwd ? path.resolve(options.cwd) : process.cwd(), false);
  const host = currentHost();
  const metadata = host.kind === "codex" ? readCodexSessionMetadata(pluginDataRoot(), host.sessionId) : null;
  const source = options.source || process.env.GROK_COMPANION_TRANSCRIPT_PATH || metadata?.transcriptPath;
  if (!source) {
    const guidance = host.kind === "codex" ? "Review and trust the plugin SessionStart hook with /hooks, start a new task, or pass --source <file.jsonl>." : "Pass --source <file.jsonl>.";
    throw new CompanionError("E_IMPORT_SOURCE", `No host transcript path is available. ${guidance}`);
  }
  const opened = openTranscriptSource(source);
  let importAlias = null, run, importFd = opened.fd, convertedFile = null, primaryError = null;
  const cleanupWarnings = [];
  let convertedCleanupFailed = false;
  let aliasCleanupFailed = false;
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const binary = discoverGrok(); grokVersion(binary);
    // Freeze both Claude and Codex sources at the validated descriptor size before any provider
    // work. An active host may append to its live transcript while model discovery/import runs;
    // Grok must receive the bounded point-in-time snapshot, never the growing source descriptor.
    const sourceSnapshot = readTranscriptSnapshot(opened);
    // After path-validated open, resolve model/effort from the same non-isolated Grok home used by
    // import/resume (not the isolated setup-probe ACP view) before Codex conversion or alias creation
    // so unavailable selections fail without private conversion work. finally still closes every
    // opened descriptor/artifact (source fd, converted fd/file, import alias).
    const models = listAdvertisedModels(binary);
    const selected = selectTransferModel(models, options.model || null);
    assertTransferEffort(selected, options.effort || null);
    const importDir = path.join(stateDir(root), "imports");
    fs.mkdirSync(importDir, { recursive: true, mode: 0o700 });
    const importContents = opened.format === "codex"
      ? codexTranscriptToClaude(sourceSnapshot, { cwd: root })
      : sourceSnapshot;
    const anonymous = createAnonymousTranscript(importContents, importDir);
    importFd = anonymous.fd;
    convertedFile = anonymous.file;
    importAlias = path.join(importDir, `import-${crypto.randomBytes(12).toString("hex")}.jsonl`);
    const inheritedFd = process.platform === "linux" ? "/proc/self/fd/3" : "/dev/fd/3";
    fs.symlinkSync(inheritedFd, importAlias);
    const marker = `transfer-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
    const leaderSocket = path.join(stateDir(root), `leader-${marker}.sock`);
    run = await runImportProcess({ binary, root, transcriptFd: importFd, alias: importAlias, leaderSocket, marker, signal: controller.signal });
    run.selectedModel = selected.id;
  } catch (error) {
    // Preserve the primary model-selection/conversion/import error; finally still runs cleanup and may
    // attach cleanupWarnings without replacing this code/message.
    primaryError = error;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    const faults = transferCleanupFaults();
    // Test-only faults inject cleanup evidence while still performing real close/dispose/unlink
    // so fixture processes do not leak descriptors. Production never sets the env var.
    if (importFd !== opened.fd) {
      if (faults.has("dispose")) {
        cleanupWarnings.push("injected dispose failure");
        convertedCleanupFailed = true;
      }
      const cleanup = disposeConvertedTranscript({ fd: importFd, file: convertedFile });
      if (!cleanup.ok) {
        cleanupWarnings.push(cleanup.warning);
        convertedCleanupFailed = true;
      }
    }
    if (faults.has("close")) cleanupWarnings.push("injected close failure");
    try { fs.closeSync(opened.fd); } catch (error) { cleanupWarnings.push(error.message); }
    if (importAlias) {
      if (faults.has("unlink")) {
        cleanupWarnings.push("injected unlink failure");
        aliasCleanupFailed = true;
      }
      try { fs.unlinkSync(importAlias); }
      catch (error) {
        if (error.code !== "ENOENT") {
          cleanupWarnings.push(error.message);
          aliasCleanupFailed = true;
        }
      }
    }
  }
  const privacy = convertedCleanupFailed || aliasCleanupFailed;
  if (primaryError) {
    throw attachTransferCleanupEvidence(primaryError, cleanupWarnings, { privacy });
  }
  if (!run) {
    if (cleanupWarnings.length) {
      throw new CompanionError(
        "E_STATE",
        "Could not completely remove the private transcript transfer artifacts.",
        transferCleanupDetails(cleanupWarnings, { privacy })
      );
    }
    throw new CompanionError("E_IMPORT_RESULT", "Grok transcript import did not complete.");
  }
  if (run.status !== 0) {
    throw new CompanionError(
      "E_IMPORT_RESULT",
      `Grok could not import the ${opened.format === "codex" ? "Codex" : "Claude Code"} transcript.`,
      {
        diagnostic: redactText(run.stderr || run.stdout),
        ...transferCleanupDetails(cleanupWarnings, { privacy })
      }
    );
  }
  let id;
  try {
    id = importedSessionId(run.stdout);
  } catch (error) {
    // Parser throws (malformed NDJSON / multiple IDs) after cleanup ran — attach residual evidence.
    throw attachTransferCleanupEvidence(error, cleanupWarnings, { privacy });
  }
  if (!id) {
    throw attachTransferCleanupEvidence(
      new CompanionError("E_IMPORT_RESULT", "Grok import succeeded but returned no usable session ID."),
      cleanupWarnings,
      { privacy }
    );
  }
  // Fail closed until the exact imported session is listed in the same non-isolated store
  // that resume uses. Bounded polling absorbs short Grok import persistence races.
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    await waitForImportedSession(id, { cwd: root, signal: controller.signal });
  } catch (error) {
    throw attachTransferCleanupEvidence(error, cleanupWarnings, { privacy });
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
  // Model-qualified resume is required: imported legacy placeholder models otherwise resume empty.
  const resume = formatResumeCommand(id, run.selectedModel, options.effort || null);
  const deleteParts = ["grok", "sessions", "delete", id];
  const label = opened.format === "codex" ? "Codex" : "Claude Code";
  const result = {
    sessionId: id,
    source: opened.real,
    sourceFormat: opened.format,
    model: run.selectedModel,
    effort: options.effort || null,
    resume,
    delete: deleteParts.map(shellWord).join(" ")
  };
  if (cleanupWarnings.length) {
    // Fail closed on any cleanup residual (including source-FD close-only). Session resume/delete
    // details keep the imported provider session from being orphaned. privacyWarning is set only
    // when converted/alias residuals may remain — close-only is warning-only.
    throw new CompanionError(
      "E_STATE",
      `Imported ${label} transcript into Grok session ${id}, but private alias or descriptor cleanup failed. Resume with \`${result.resume}\` or delete with \`${result.delete}\`, then remove leftover transfer artifacts.`,
      {
        ...transferCleanupDetails(cleanupWarnings, { privacy }),
        sessionId: result.sessionId,
        source: result.source,
        sourceFormat: result.sourceFormat,
        model: result.model,
        effort: result.effort,
        resume: result.resume,
        delete: result.delete
      }
    );
  }
  out(options.json ? result : `Imported ${label} transcript into Grok session ${id}.\nResume: ${result.resume}`, options.json);
}

export { handleTransfer };
