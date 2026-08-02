import { CompanionError } from "./errors.mjs";
import {
  processGroupAlive,
  processGroupGone,
  processStartToken,
  signalOwnedProcess
} from "./process-control.mjs";
import { assertProviderPlatform } from "./provider-core.mjs";

// Startup can fail after the provider process and its isolated home exist but
// before openProvider can return a provider handle. Keep the verified process
// identity on cleanup failures without exposing it through serialized error
// details, so callers can retain credentials/state while that group may live.
const PROVIDER_CLEANUP_IDENTITY = Symbol("grok-provider-cleanup-identity");

export function attachProviderCleanupIdentity(error, identity) {
  if (error && typeof error === "object" && identity) {
    Object.defineProperty(error, PROVIDER_CLEANUP_IDENTITY, {
      configurable: true,
      enumerable: false,
      value: identity
    });
  }
  return error;
}
export function providerCleanupIdentity(error) {
  return error && typeof error === "object" ? error[PROVIDER_CLEANUP_IDENTITY] || null : null;
}

/** Acquire a birth token before exposing a freshly spawned detached group. */
export async function captureSpawnIdentity(child, {
  timeoutMs = 750,
  intervalMs = 25,
  shutdownTimeoutMs = 750,
  readStartToken = processStartToken,
  isGroupAlive = processGroupAlive,
  signalGroup = (pid, signal) => process.kill(-pid, signal)
} = {}) {
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new CompanionError("E_PROCESS_IDENTITY", "Grok did not expose a valid provider PID after spawn.");
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    const startToken = readStartToken(pid);
    if (startToken) return { pid, startToken, processGroupId: process.platform === "win32" ? null : pid };
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(1, deadline - Date.now()))));
  } while (true);

  const identity = { pid, startToken: null, processGroupId: process.platform === "win32" ? null : pid };
  const waitGone = async () => {
    const stop = Date.now() + Math.max(0, shutdownTimeoutMs);
    while (isGroupAlive(pid) && Date.now() < stop) await new Promise((resolve) => setTimeout(resolve, Math.max(1, intervalMs)));
    return !isGroupAlive(pid);
  };
  let signalFailure = null;
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try {
      signalOwnedProcess(
        process.platform === "win32" ? pid : -pid,
        signal,
        (_target, requestedSignal) => signalGroup(pid, requestedSignal)
      );
    } catch (error) {
      signalFailure = error;
      break;
    }
    if (await waitGone()) break;
  }
  if (signalFailure) {
    if (isGroupAlive(pid)) {
      throw attachProviderCleanupIdentity(signalFailure, identity);
    }
    throw signalFailure;
  }
  const error = new CompanionError("E_PROCESS_IDENTITY", "Could not record the Grok provider birth token before startup; the process was stopped before task execution.", { pid });
  if (isGroupAlive(pid)) throw attachProviderCleanupIdentity(error, identity);
  throw error;
}


export async function ensureChildExit(child, identity, {
  naturalExitMs = 750,
  signalProcess = process.kill
} = {}) {
  // Defense in depth: unsupported platforms must surface E_CAPABILITY before identity failures.
  assertProviderPlatform();
  if (identity?.pid && child.pid === identity.pid && processGroupGone(identity)) return;
  if (!identity?.pid || child.pid !== identity.pid || !identity.startToken) throw new CompanionError("E_PROCESS_IDENTITY", "Refusing to clean up an unverified Grok process tree.", { pid: identity?.pid || child.pid || null });
  if (process.platform !== "win32" && identity.processGroupId !== identity.pid) throw new CompanionError("E_PROCESS_IDENTITY", "Refusing to clean up a Grok process outside its owned process group.", { pid: identity.pid, processGroupId: identity.processGroupId });
  const initialToken = processStartToken(identity.pid);
  if (initialToken && initialToken !== identity.startToken) throw new CompanionError("E_PROCESS_IDENTITY", `Refusing to signal unverified Grok process ${identity.pid}.`, { pid: identity.pid });
  const alive = () => processStartToken(identity.pid) === identity.startToken || (identity.processGroupId && processGroupAlive(identity.processGroupId));
  const waitGone = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!alive()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !alive();
  };
  const signal = (name) => signalOwnedProcess(
    identity.processGroupId && process.platform !== "win32"
      ? -identity.processGroupId
      : identity.pid,
    name,
    signalProcess
  );
  if (await waitGone(naturalExitMs)) return;
  signal("SIGTERM");
  if (await waitGone(1500)) return;
  signal("SIGKILL");
  if (!await waitGone(1500)) throw new CompanionError("E_PROCESS_IDENTITY", `Verified Grok process group ${identity.processGroupId || identity.pid} did not exit after SIGKILL.`, { pid: identity.pid, processGroupId: identity.processGroupId || null });
}
