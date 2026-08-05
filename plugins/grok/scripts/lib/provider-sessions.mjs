import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { CompanionError } from "./errors.mjs";
import {
  assertProviderLaunchBinding as assertExecutableProviderLaunchBinding,
  resolveProviderExecutablePin
} from "./provider-executable-pin.mjs";
import { redactText } from "./redact.mjs";
import { processGroupGone } from "./process-control.mjs";
import { unregisterProviderGuard } from "./recursion-guard.mjs";
import { hostCommand } from "./host.mjs";
import { openProvider } from "./provider-acp-runtime.mjs";
import {
  assertProviderPlatform,
  childEnvironment,
  discoverGrok,
  grokVersion
} from "./provider-core.mjs";
import {
  gatedCleanupReviewEnvironment,
  reviewEnvironment
} from "./provider-credentials.mjs";
import {
  ensureChildExit,
  providerCleanupIdentity
} from "./provider-process.mjs";
import { inspectIsolation } from "./provider-profile.mjs";

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

export function deleteSession(sessionId, binary = null, env = null) {
  if (!sessionId) return { ok: true, removed: false, warning: null };
  const run = spawnSync(
    binary || discoverGrok(),
    ["sessions", "delete", sessionId],
    {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      shell: false,
      env: env || childEnvironment()
    }
  );
  const stdout = String(run.stdout || "");
  const stderr = String(run.stderr || "");
  const acknowledged = (
    run.status === 0
    && !run.error
    && !run.signal
    && stderr === ""
    && (stdout === `Deleted session ${sessionId}\n`
      || stdout === `Deleted session ${sessionId}\r\n`)
  );
  return {
    ok: acknowledged,
    removed: acknowledged,
    warning: acknowledged ? null : redactText(stderr || stdout)
  };
}

function shellWord(value) {
  const text = String(value);
  return /^[a-zA-Z0-9_./:+-]+$/.test(text) ? text : `'${text.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Executable resume argv for an imported Grok session.
 * Model is required: legacy placeholder models on import otherwise resume empty.
 */
export function formatResumeCommand(sessionId, model, effort = null) {
  if (!sessionId) throw new CompanionError("E_IMPORT_RESULT", "Cannot format a resume command without a Grok session ID.");
  if (!model) throw new CompanionError("E_CAPABILITY", "Cannot format a resume command without an advertised Grok model.");
  const parts = ["grok", "--model", model];
  if (effort) parts.push("--reasoning-effort", effort);
  parts.push("--resume", sessionId);
  return parts.map(shellWord).join(" ");
}

/**
 * Parse `grok models` text from the non-isolated CLI home used by import/resume.
 * Optional trailing `efforts=a,b` is recognized when a provider prints it (tests);
 * production Grok text may omit efforts, in which case advertised effort checks are skipped.
 */
export function parseAdvertisedModels(text) {
  const models = [];
  let defaultId = null;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const defaultMatch = line.match(/^Default model:\s+(\S+)\s*$/i);
    if (defaultMatch) {
      defaultId = defaultMatch[1];
      continue;
    }
    const modelMatch = line.match(/^[*-]\s+(\S+)(?:\s+\(default\))?(?:\s+efforts=([A-Za-z0-9_,-]+))?\s*$/i);
    if (!modelMatch) continue;
    const id = modelMatch[1];
    const efforts = modelMatch[2]
      ? modelMatch[2].split(",").map((item) => item.trim()).filter(Boolean)
      : [];
    if (!models.some((item) => item.id === id)) models.push({ id, efforts });
    if (/\(default\)/i.test(line)) defaultId = id;
  }
  if (defaultId) {
    const index = models.findIndex((item) => item.id === defaultId);
    if (index > 0) {
      const [preferred] = models.splice(index, 1);
      models.unshift(preferred);
    } else if (index < 0) {
      models.unshift({ id: defaultId, efforts: [] });
    }
  }
  return models;
}

/**
 * List models advertised by the same non-isolated Grok home used for import and resume.
 * Does not open an isolated setup-probe ACP home.
 */
export function listAdvertisedModels(binary = null, env = null) {
  assertProviderPlatform();
  const resolved = binary || discoverGrok();
  const run = spawnSync(resolved, ["models"], {
    encoding: "utf8",
    shell: false,
    timeout: 30000,
    env: env || childEnvironment()
  });
  if (run.status !== 0) {
    throw new CompanionError(
      "E_AUTH_REQUIRED",
      `Grok authentication is unavailable or expired. Run \`grok login\`, then retry ${hostCommand("setup")}.`,
      { diagnostic: redactText(run.stderr || run.stdout).slice(-2000) }
    );
  }
  const models = parseAdvertisedModels(`${run.stdout || ""}\n${run.stderr || ""}`);
  if (!models.length) {
    throw new CompanionError("E_CAPABILITY", "Grok did not advertise a model that can resume the imported session.");
  }
  return models;
}

export function selectTransferModel(models, requestedModel = null) {
  const list = Array.isArray(models) ? models : [];
  if (!list.length) {
    throw new CompanionError("E_CAPABILITY", "Grok did not advertise a model that can resume the imported session.");
  }
  if (requestedModel) {
    const selected = list.find((item) => item.id === requestedModel);
    if (!selected) {
      throw new CompanionError("E_CAPABILITY", `Model ${requestedModel} is not advertised by Grok.`, {
        available: list.map((item) => item.id)
      });
    }
    return selected;
  }
  return list[0];
}

export function assertTransferEffort(selected, effort = null) {
  if (!effort) return;
  const efforts = Array.isArray(selected?.efforts) ? selected.efforts : [];
  if (efforts.length && !efforts.includes(effort)) {
    throw new CompanionError("E_CAPABILITY", `Reasoning effort ${effort} is not advertised for model ${selected.id}.`, {
      available: efforts
    });
  }
}

/**
 * Observe whether one exact session ID appears in a successful non-isolated
 * Grok session list. `ok:false` preserves list failure separately from a
 * successful absence proof. Only provider metadata is requested or retained.
 */
export function inspectImportedSessionPresence(sessionId, binary = null, env = null, cwd = null) {
  const canonicalSessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const canonicalDate = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
    const parsed = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed)
      && new Date(parsed).toISOString().slice(0, 10) === value;
  };
  if (typeof sessionId !== "string"
    || !canonicalSessionId.test(sessionId)) {
    return Object.freeze({ ok: false, present: false });
  }
  const resolved = binary || discoverGrok();
  const run = spawnSync(resolved, ["sessions", "list", "-n", "200"], {
    cwd: cwd || process.cwd(),
    encoding: "utf8",
    shell: false,
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    env: env || childEnvironment()
  });
  if (run.status !== 0 || run.error || String(run.stderr || "").trim() !== "") {
    return Object.freeze({ ok: false, present: false });
  }
  const lines = String(run.stdout || "").split(/\r?\n/);
  const nonemptyLines = lines.map((line) => line.trim()).filter(Boolean);
  if (
    nonemptyLines.length === 1
    && nonemptyLines[0] === "No sessions found."
  ) {
    return Object.freeze({ ok: true, present: false });
  }
  const observed = new Set();
  let present = false;
  let headers = 0;
  let inTable = false;
  let expectingHeader = false;
  let tableHasSummary = false;
  let currentGroupLabel = null;
  let currentTableRows = 0;
  const observedGroupLabels = new Set();
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") continue;
    const columns = line.split(/\s+/);
    const header = (
      (columns.length === 5 || columns.length === 6)
      && columns[0] === "SESSION"
      && columns[1] === "ID"
      && columns[2] === "CREATED"
      && columns[3] === "UPDATED"
      && columns[4] === "STATUS"
      && (columns.length === 5 || columns[5] === "SUMMARY")
    );
    if (header) {
      if (inTable && !expectingHeader) {
        return Object.freeze({ ok: false, present: false });
      }
      headers += 1;
      inTable = true;
      expectingHeader = false;
      tableHasSummary = columns.length === 6;
      currentTableRows = 0;
      continue;
    }
    if (
      /^\([^()\r\n]{1,256}\)$/.test(line)
      || /^Label: [^\r\n]{1,256}$/.test(line)
    ) {
      if (
        expectingHeader
        || (inTable && currentGroupLabel === null)
        || (currentGroupLabel !== null && currentTableRows === 0)
        || observedGroupLabels.has(line)
      ) {
        return Object.freeze({ ok: false, present: false });
      }
      observedGroupLabels.add(line);
      currentGroupLabel = line;
      inTable = false;
      expectingHeader = true;
      continue;
    }
    if (!inTable || expectingHeader) {
      return Object.freeze({ ok: false, present: false });
    }
    const id = columns[0];
    const normalizedId = typeof id === "string" ? id.toLowerCase() : "";
    const minimumColumns = tableHasSummary ? 5 : 4;
    if ((tableHasSummary ? columns.length < minimumColumns : columns.length !== minimumColumns)
      || !canonicalSessionId.test(id || "")
      || !canonicalDate(columns[1])
      || !canonicalDate(columns[2])
      || !/^[A-Za-z][A-Za-z0-9._:+-]{0,63}$/.test(columns[3] || "")
      || observed.has(normalizedId)) {
      return Object.freeze({ ok: false, present: false });
    }
    observed.add(normalizedId);
    currentTableRows += 1;
    if (normalizedId === sessionId.toLowerCase()) present = true;
  }
  if (
    headers === 0
    || expectingHeader
    || currentTableRows === 0
  ) {
    return Object.freeze({ ok: false, present: false });
  }
  if (!present && observed.size >= 200) {
    return Object.freeze({ ok: false, present: false });
  }
  return Object.freeze({ ok: true, present });
}

/**
 * Backward-compatible readiness predicate. Qualification code must use
 * inspectImportedSessionPresence so list failure is not mistaken for absence.
 */
export function isImportedSessionReady(sessionId, binary = null, env = null, cwd = null) {
  const observation = inspectImportedSessionPresence(sessionId, binary, env, cwd);
  return observation.ok && observation.present;
}

/**
 * Fail closed until the exact imported session is observable for resume.
 * Bounded polling accounts for Grok import persistence races.
 */
export async function waitForImportedSession(sessionId, {
  binary = null,
  env = null,
  cwd = null,
  signal = null,
  timeoutMs = null,
  intervalMs = null
} = {}) {
  assertProviderPlatform();
  if (!sessionId) throw new CompanionError("E_IMPORT_RESULT", "Grok import returned no usable session ID.");
  const testTimeout = Number(process.env.GROK_COMPANION_TEST_IMPORT_READY_TIMEOUT_MS);
  const testInterval = Number(process.env.GROK_COMPANION_TEST_IMPORT_READY_INTERVAL_MS);
  const limitMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : (Number.isFinite(testTimeout) && testTimeout > 0 ? testTimeout : 10_000);
  const stepMs = Number.isFinite(intervalMs) && intervalMs > 0
    ? intervalMs
    : (Number.isFinite(testInterval) && testInterval > 0 ? testInterval : 100);
  const resolved = binary || discoverGrok();
  const deadline = Date.now() + limitMs;
  while (true) {
    if (signal?.aborted) throw new CompanionError("E_CANCELLED", "Grok transcript import was cancelled while waiting for session readiness.");
    if (isImportedSessionReady(sessionId, resolved, env, cwd)) return true;
    if (Date.now() >= deadline) {
      throw new CompanionError(
        "E_IMPORT_RESULT",
        `Grok import reported session ${sessionId}, but the session is not yet observable for resume.`,
        { sessionId }
      );
    }
    const remaining = deadline - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(stepMs, Math.max(0, remaining))));
  }
}

export async function probe(root, stateDir, {
  providerExecutableBinding = null,
  providerExecutableEnv = process.env
} = {}) {
  assertProviderPlatform();
  const pinned = providerExecutableBinding == null
    ? null
    : resolveProviderExecutablePin(
        assertExecutableProviderLaunchBinding(providerExecutableBinding),
        { env: providerExecutableEnv }
      );
  const binary = pinned?.binary || discoverGrok();
  grokVersion(binary);
  const help = spawnSync(binary, ["--help"], { encoding: "utf8", shell: false, timeout: 15000, env: childEnvironment() });
  const helpText = `${help.stdout || ""}\n${help.stderr || ""}`;
  const requiredFlags = ["--prompt-file", "--json-schema", "--tools", "--disallowed-tools", "--sandbox"];
  const missingFlags = requiredFlags.filter((flag) => !helpText.includes(flag));
  if (help.status !== 0 || missingFlags.length) throw new CompanionError("E_CAPABILITY", "Grok does not advertise the required headless review flags.", { missing: missingFlags });
  const agentHelp = spawnSync(binary, ["agent", "--help"], { encoding: "utf8", shell: false, timeout: 15000, env: childEnvironment() });
  const agentHelpText = `${agentHelp.stdout || ""}\n${agentHelp.stderr || ""}`;
  const requiredAgentFlags = ["--agent-profile", "--no-leader", "--leader-socket"];
  const missingAgentFlags = requiredAgentFlags.filter((flag) => !agentHelpText.includes(flag));
  if (agentHelp.status !== 0 || missingAgentFlags.length) throw new CompanionError("E_CAPABILITY", "Grok does not advertise the required isolated ACP agent flags.", { missing: missingAgentFlags });
  const auth = spawnSync(binary, ["models"], { encoding: "utf8", shell: false, timeout: 30000, env: childEnvironment() });
  if (auth.status !== 0) throw new CompanionError("E_AUTH_REQUIRED", `Grok authentication is unavailable or expired. Run \`grok login\`, then retry ${hostCommand("setup")}.`, { diagnostic: redactText(auth.stderr || auth.stdout).slice(-2000) });
  const marker = `setup-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const isolation = reviewEnvironment(
    stateDir,
    marker,
    { providerExecutableBinary: binary }
  );
  let provider = null;
  let failedProviderProcess = null;
  let primaryError = null;
  try {
    inspectIsolation(binary, root, isolation);
    const agentProfilePath = path.join(PLUGIN_ROOT, "provider-agents", "setup-probe.md");
    const agentProfile = fs.readFileSync(agentProfilePath, "utf8");
    if (!/^injectDefaultTools:\s*false\s*$/m.test(agentProfile)) throw new CompanionError("E_SECURITY_PROFILE", "The checked-in setup probe agent profile must set injectDefaultTools: false.");
    if (!/^permission_mode:\s*dontAsk\s*$/m.test(agentProfile)) throw new CompanionError("E_SECURITY_PROFILE", "The checked-in setup probe agent profile must use permission_mode dontAsk without unattended privilege expansion.");
    const agentProfileDigest = crypto.createHash("sha256").update(agentProfile).digest("hex");
    const profile = {
      id: "setup-probe-v2",
      contractVersion: 2,
      transport: "acp",
      sandbox: "read-only",
      permissionMode: "dontAsk",
      webSearch: false,
      subagents: false,
      isolatedLeader: true,
      agentProfileDigest,
      allowedTools: ["todo_write"],
      deniedTools: ["WebSearch", "WebFetch", "Agent", "mcp__*", "Bash", "Edit", "Write"]
    };
    provider = await openProvider({
      root,
      profile,
      stateDir,
      jobMarker: marker,
      environment: isolation,
      providerExecutableBinding,
      providerExecutableEnv
    });
    return {
      binary: provider.binary,
      version: provider.version,
      authenticated: true,
      headlessReview: { flags: requiredFlags, isolated: true, externalHooks: 0, externalSkills: 0, externalPlugins: 0, externalMcpServers: 0 },
      acpIsolation: {
        flags: requiredAgentFlags,
        isolated: true,
        sandbox: profile.sandbox,
        permissionMode: profile.permissionMode,
        injectDefaultTools: false,
        allowedTools: [...profile.allowedTools],
        agentProfileDigest,
        unattendedPrivilegeExpansion: false
      },
      protocolVersion: provider.initialized.protocolVersion,
      loadSession: Boolean(provider.initialized.agentCapabilities?.loadSession),
      authMethods: (provider.initialized.authMethods || []).map((x) => ({ id: x.id, name: x.name })),
      models: (provider.initialized?._meta?.modelState?.availableModels || []).map((x) => ({ id: x.modelId, efforts: (x._meta?.reasoningEfforts || []).map((e) => e.id) }))
    };
  } catch (error) {
    primaryError = error;
    failedProviderProcess = providerCleanupIdentity(error);
    throw error;
  } finally {
    let shutdownError = null;
    let retainProfileForGuard = false;
    if (provider) {
      provider.client.close();
      try {
        await ensureChildExit(provider.child, provider.process);
        try {
          unregisterProviderGuard(root, provider.marker, provider.guardRecord);
        } catch (error) {
          retainProfileForGuard = true;
          throw error;
        }
        provider.cleanupAgentProfile?.();
      } catch (error) {
        shutdownError = error;
      }
    }
    // Never delete the isolated credential home while the recorded process group remains live
    // or shutdown is unverifiable. Preserve the guard (unregister only after verified exit)
    // and keep the primary shutdown error when present.
    const cleanupIdentity = provider?.process || failedProviderProcess;
    const cleanup = retainProfileForGuard
      ? {
          ok: false,
          warning: "Isolated review home retained because exact provider guard cleanup failed."
        }
      : gatedCleanupReviewEnvironment(stateDir, marker, cleanupIdentity);
    if (!cleanup.ok) {
      const surfacedError = shutdownError || primaryError;
      if (surfacedError) {
        const details = surfacedError.details && typeof surfacedError.details === "object" && !Array.isArray(surfacedError.details)
          ? { ...surfacedError.details }
          : {};
        details.privacyWarning = [details.privacyWarning, cleanup.warning].filter(Boolean).join("; ");
        surfacedError.details = details;
        throw surfacedError;
      }
      if (cleanupIdentity && !processGroupGone(cleanupIdentity)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Could not verify complete process-group shutdown for the setup review-isolation probe.", {
          pid: cleanupIdentity.pid,
          processGroupId: cleanupIdentity.processGroupId ?? null,
          privacyWarning: cleanup.warning
        });
      }
      throw new CompanionError("E_STATE", "Could not remove the setup review-isolation probe.", { warning: cleanup.warning });
    }
    if (shutdownError) throw shutdownError;
  }
}
